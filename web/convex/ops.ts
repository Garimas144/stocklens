/**
 * Operator actions. All validation happens here on the server, every change is audited, and authoritative inventory records can
 * only change through an approved correction (two different people: requester and approver).
 */
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { addNote, audit, getLocation, now, reconcileLocation, requireOperator } from "./lib";

const STATUSES = ["open", "investigating", "escalated", "resolved", "dismissed"] as const;

function validateConfig(profile: string, config: any, locationIds: Set<string>) {
  const errs: string[] = [];
  const zones = Array.isArray(config?.zones) ? config.zones : [];
  const lines = Array.isArray(config?.count_lines) ? config.count_lines : [];
  const ids = new Set<string>();
  for (const z of zones) {
    if (!z.id || ids.has(z.id)) errs.push(`zone id '${z.id}' missing or duplicated`);
    ids.add(z.id);
    if (!Array.isArray(z.polygon) || z.polygon.length < 3 || z.polygon.some((p: unknown) => !Array.isArray(p) || p.length !== 2 || p.some((n) => typeof n !== "number")))
      errs.push(`zone ${z.id}: polygon needs at least 3 [x, y] number pairs`);
    if (z.role === "shelf" && z.location_id && !locationIds.has(z.location_id)) errs.push(`zone ${z.id}: unknown location ${z.location_id}`);
  }
  for (const l of lines) {
    for (const k of ["p1", "p2", "forward"]) if (!Array.isArray(l[k]) || l[k].length !== 2) errs.push(`count line ${l.id}: ${k} must be [x, y]`);
    if (!["inbound", "outbound"].includes(l.forward_means)) errs.push(`count line ${l.id}: forward_means must be inbound or outbound`);
    if (l.location_id && !locationIds.has(l.location_id)) errs.push(`count line ${l.id}: unknown checkpoint ${l.location_id}`);
  }
  if (profile === "shelf" && !zones.some((z: any) => z.role === "shelf")) errs.push("a shelf camera needs at least one zone with role 'shelf'");
  if (profile === "movement" && !lines.length) errs.push("a movement camera needs at least one count line");
  return errs;
}

export const updateCamera = mutation({
  args: {
    operator: v.string(), cameraId: v.string(), name: v.string(), context: v.string(), warehouseLocation: v.string(),
    profile: v.union(v.literal("shelf"), v.literal("movement")), sourceUri: v.string(), recordedAt: v.optional(v.number()), config: v.any(),
    slot: v.optional(v.number()), area: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const op = requireOperator(a.operator);
    const locs = await ctx.db.query("locations").collect();
    const errs = validateConfig(a.profile, a.config, new Set(locs.map((l) => l.locationId)));
    if (errs.length) throw new Error("Invalid camera configuration: " + errs.join("; "));
    const kind = a.sourceUri.startsWith("rtsp://") ? "rtsp" as const : "file" as const;
    const existing = await ctx.db.query("cameras").withIndex("by_cameraId", (q) => q.eq("cameraId", a.cameraId)).unique();
    const doc = {
      cameraId: a.cameraId, name: a.name, context: a.context, warehouseLocation: a.warehouseLocation, profile: a.profile,
      source: { kind, uri: a.sourceUri, recordedAt: a.recordedAt }, config: { ...a.config, profile: a.profile }, updatedAt: now(), updatedBy: op,
      ...(a.slot !== undefined ? { slot: a.slot } : {}), ...(a.area !== undefined ? { area: a.area } : {}),
    };
    if (a.slot !== undefined && a.slot >= 1 && a.slot <= 4) {
      const taken = (await ctx.db.query("cameras").collect()).find((c) => c.slot === a.slot && c.cameraId !== a.cameraId);
      if (taken) throw new Error(`grid position ${a.slot} is already used by ${taken.name}`);
    }
    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert("cameras", { ...doc, status: "idle" });
    await audit(ctx, op, existing ? "camera.updated" : "camera.created", "camera", a.cameraId, { profile: a.profile });
  },
});

export const requestProcessing = mutation({
  args: { operator: v.string(), cameraId: v.string(), reuseCache: v.boolean() },
  handler: async (ctx, { operator, cameraId, reuseCache }) => {
    const op = requireOperator(operator);
    const cam = await ctx.db.query("cameras").withIndex("by_cameraId", (q) => q.eq("cameraId", cameraId)).unique();
    if (!cam) throw new Error("unknown camera");
    if (cam.source.kind === "rtsp") throw new Error("Live RTSP ingestion is not implemented yet; point the camera at a recorded MP4 file.");
    const busy = (await ctx.db.query("jobs").collect()).some((j) => j.cameraId === cameraId && (j.status === "queued" || j.status === "running"));
    if (busy) throw new Error("This camera already has a queued or running analysis job.");
    const id = await ctx.db.insert("jobs", { cameraId, status: "queued", progress: 0, requestedBy: op, reuseCache, createdAt: now(), updatedAt: now() });
    await audit(ctx, op, "job.queued", "camera", cameraId, { reuseCache });
    return id;
  },
});

export const setVerifiedCount = mutation({
  args: { operator: v.string(), locationId: v.string(), quantity: v.number(), fullyVisible: v.boolean(), verifiedAt: v.number() },
  handler: async (ctx, a) => {
    const op = requireOperator(a.operator);
    if (!Number.isInteger(a.quantity) || a.quantity < 0) throw new Error("quantity must be a whole number >= 0");
    const loc = await getLocation(ctx, a.locationId);
    if (!loc || loc.type !== "shelf") throw new Error("verified counts apply to shelf locations");
    await ctx.db.patch(loc._id, { verifiedQty: a.quantity, verifiedAt: a.verifiedAt, verifiedBy: op, fullyVisible: a.fullyVisible, updatedAt: now() });
    await audit(ctx, op, "shelf.verified_count", "location", a.locationId, { quantity: a.quantity, verifiedAt: a.verifiedAt, fullyVisible: a.fullyVisible });
    await reconcileLocation(ctx, a.locationId);
  },
});

/** Associate a session-scoped track with a real package id / SKU (e.g. from a barcode scan). Propagates to its events. */
export const linkPackage = mutation({
  args: { operator: v.string(), sessionId: v.string(), trackRef: v.string(), packageId: v.string(), sku: v.string() },
  handler: async (ctx, a) => {
    const op = requireOperator(a.operator);
    const t = await ctx.db.query("tracks").withIndex("by_session", (q) => q.eq("sessionId", a.sessionId).eq("trackRef", a.trackRef)).unique();
    if (!t) throw new Error("track not found");
    const packageId = a.packageId.trim() || undefined, sku = a.sku.trim() || undefined;
    if (sku && !(await ctx.db.query("products").withIndex("by_sku", (q) => q.eq("sku", sku)).unique())) throw new Error(`unknown SKU ${sku}`);
    await ctx.db.patch(t._id, { packageId, sku });
    const evs = (await ctx.db.query("movementEvents").withIndex("by_session", (q) => q.eq("sessionId", a.sessionId)).collect()).filter((e) => e.trackRef === a.trackRef);
    const locs = new Set<string>();
    for (const e of evs) { await ctx.db.patch(e._id, { packageId, sku, identitySource: packageId || sku ? "operator" : undefined }); locs.add(e.locationId); }
    for (const l of locs) await reconcileLocation(ctx, l);
    await audit(ctx, op, "track.linked", "track", `${a.sessionId}/${a.trackRef}`, { packageId, sku });
  },
});

/** Human review of an uncertain (or wrongly confirmed) camera event. Changes what counts; reconciliation re-runs. */
export const reviewEvent = mutation({
  args: { operator: v.string(), eventId: v.id("movementEvents"), decision: v.union(v.literal("confirm"), v.literal("reject")), note: v.string() },
  handler: async (ctx, { operator, eventId, decision, note }) => {
    const op = requireOperator(operator);
    if (note.trim().length < 3) throw new Error("explain the review decision (what the footage shows)");
    const e = await ctx.db.get(eventId);
    if (!e) throw new Error("event not found");
    const loc = await getLocation(ctx, e.locationId);
    const secondary = loc?.type === "checkpoint" && loc.cameraId !== e.cameraId;
    await ctx.db.patch(eventId, {
      verification: decision === "confirm" ? "confirmed" : "rejected", verifiedBy: op,
      countsTowardReconciliation: decision === "confirm" && !secondary,
      countingNote: decision === "confirm" ? (secondary ? e.countingNote : `confirmed by ${op} from footage`) : `rejected by ${op}: ${note}`,
    });
    await audit(ctx, op, `event.${decision}ed`, "movementEvent", e.eventKey, { note });
    const discs = (await ctx.db.query("discrepancies").withIndex("by_location", (q) => q.eq("locationId", e.locationId)).collect()).filter((d) => d.active);
    for (const d of discs) await addNote(ctx, d._id, op, "evidence_review", `${decision === "confirm" ? "Confirmed" : "Rejected"} ${e.type.replace("_", " ")} of ${e.trackRef} at ${new Date(e.at).toISOString()}: ${note}`);
    await reconcileLocation(ctx, e.locationId);
  },
});

export const assign = mutation({
  args: { operator: v.string(), code: v.string(), assignee: v.string() },
  handler: async (ctx, { operator, code, assignee }) => {
    const op = requireOperator(operator);
    const d = await ctx.db.query("discrepancies").withIndex("by_code", (q) => q.eq("code", code)).unique();
    if (!d) throw new Error("not found");
    const who = assignee.trim() || undefined;
    await ctx.db.patch(d._id, { assignee: who, status: d.status === "open" && who ? "investigating" : d.status, updatedAt: now() });
    await addNote(ctx, d._id, op, "assignment", who ? `Assigned to ${who}` : "Unassigned");
    await audit(ctx, op, "discrepancy.assigned", "discrepancy", code, { assignee: who });
  },
});

export const setStatus = mutation({
  args: { operator: v.string(), code: v.string(), status: v.union(...STATUSES.map((s) => v.literal(s))), note: v.string() },
  handler: async (ctx, { operator, code, status, note }) => {
    const op = requireOperator(operator);
    const d = await ctx.db.query("discrepancies").withIndex("by_code", (q) => q.eq("code", code)).unique();
    if (!d) throw new Error("not found");
    if ((status === "resolved" || status === "dismissed" || status === "escalated") && note.trim().length < 5)
      throw new Error(`a ${status} decision needs an explanation`);
    const pending = (await ctx.db.query("corrections").withIndex("by_discrepancy", (q) => q.eq("discrepancyId", d._id)).collect()).some((c) => c.status === "pending");
    if (status === "resolved" && pending) throw new Error("approve or reject the pending correction first");
    await ctx.db.patch(d._id, { status, updatedAt: now(), ...(status === "resolved" || status === "dismissed" ? { resolution: note.trim(), active: false } : { active: true }) });
    await addNote(ctx, d._id, op, "status", `Status -> ${status}${note.trim() ? `: ${note.trim()}` : ""}`);
    await audit(ctx, op, "discrepancy.status", "discrepancy", code, { status, note });
  },
});

export const addInvestigationNote = mutation({
  args: { operator: v.string(), code: v.string(), body: v.string() },
  handler: async (ctx, { operator, code, body }) => {
    const op = requireOperator(operator);
    if (!body.trim()) throw new Error("empty note");
    const d = await ctx.db.query("discrepancies").withIndex("by_code", (q) => q.eq("code", code)).unique();
    if (!d) throw new Error("not found");
    await addNote(ctx, d._id, op, "note", body.trim().slice(0, 4000));
    await ctx.db.patch(d._id, { updatedAt: now() });
  },
});

export const requestCorrection = mutation({
  args: { operator: v.string(), code: v.string(), toQty: v.number(), reason: v.string() },
  handler: async (ctx, { operator, code, toQty, reason }) => {
    const op = requireOperator(operator);
    const d = await ctx.db.query("discrepancies").withIndex("by_code", (q) => q.eq("code", code)).unique();
    if (!d) throw new Error("not found");
    if (d.kind !== "shelf_quantity" || !d.sku) throw new Error("record corrections apply to shelf discrepancies with a known SKU; checkpoint mismatches are fixed by adding the missing transactions in the WMS");
    if (!Number.isInteger(toQty) || toQty < 0) throw new Error("quantity must be a whole number >= 0");
    if (reason.trim().length < 5) throw new Error("give a reason");
    const existing = (await ctx.db.query("corrections").withIndex("by_discrepancy", (q) => q.eq("discrepancyId", d._id)).collect()).find((c) => c.status === "pending");
    if (existing) throw new Error("a correction is already pending");
    const rec = (await ctx.db.query("inventoryRecords").withIndex("by_location", (q) => q.eq("locationId", d.locationId)).collect()).find((r) => r.sku === d.sku);
    if (!rec) throw new Error("no inventory record for this SKU/location");
    await ctx.db.insert("corrections", { discrepancyId: d._id, locationId: d.locationId, sku: d.sku, fromQty: rec.recordedQty, toQty, reason: reason.trim(), status: "pending", requestedBy: op, createdAt: now() });
    await addNote(ctx, d._id, op, "correction", `Requested record correction ${rec.recordedQty} -> ${toQty}: ${reason.trim()}`);
    await audit(ctx, op, "correction.requested", "discrepancy", code, { toQty });
  },
});

export const decideCorrection = mutation({
  args: { operator: v.string(), correctionId: v.id("corrections"), approve: v.boolean(), note: v.string() },
  handler: async (ctx, { operator, correctionId, approve, note }) => {
    const op = requireOperator(operator);
    const c = await ctx.db.get(correctionId);
    if (!c || c.status !== "pending") throw new Error("no pending correction");
    if (c.requestedBy === op) throw new Error("the person who requested a correction cannot approve it");
    const d = await ctx.db.get(c.discrepancyId);
    if (!d) throw new Error("discrepancy missing");
    await ctx.db.patch(correctionId, { status: approve ? "approved" : "rejected", decidedBy: op, decidedAt: now(), decisionNote: note.trim() });
    if (approve) {
      const rec = (await ctx.db.query("inventoryRecords").withIndex("by_location", (q) => q.eq("locationId", c.locationId)).collect()).find((r) => r.sku === c.sku);
      if (!rec) throw new Error("inventory record missing");
      if (rec.recordedQty !== c.fromQty) throw new Error(`the record changed since this correction was requested (${c.fromQty} -> now ${rec.recordedQty}); request a new correction`);
      await ctx.db.patch(rec._id, { recordedQty: c.toQty, updatedAt: now() });
      await ctx.db.insert("transactions", { txnId: `ADJ-${d.code}-${Date.now()}`, type: "adjustment", locationId: c.locationId, sku: c.sku, quantity: c.toQty - c.fromQty,
        at: now(), reference: d.code, source: "operator_correction", isSample: false });
    }
    await addNote(ctx, d._id, op, "correction", `${approve ? "Approved" : "Rejected"} correction ${c.fromQty} -> ${c.toQty}${note.trim() ? `: ${note.trim()}` : ""}`);
    await audit(ctx, op, approve ? "correction.approved" : "correction.rejected", "discrepancy", d.code, { fromQty: c.fromQty, toQty: c.toQty, requestedBy: c.requestedBy });
    await reconcileLocation(ctx, c.locationId);
  },
});

export const upsertLocation = mutation({
  args: {
    operator: v.string(), locationId: v.string(), name: v.string(), type: v.union(v.literal("shelf"), v.literal("checkpoint")), cameraId: v.string(),
    sku: v.optional(v.string()), direction: v.optional(v.union(v.literal("inbound"), v.literal("outbound"))), matchToleranceS: v.optional(v.number()), fullyVisible: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    const op = requireOperator(a.operator);
    if (!/^[A-Z0-9-]{3,40}$/.test(a.locationId)) throw new Error("location id: 3-40 characters, A-Z, 0-9 and dashes");
    if (a.type === "checkpoint" && !a.direction) throw new Error("a checkpoint needs a counting direction (inbound or outbound)");
    const cam = await ctx.db.query("cameras").withIndex("by_cameraId", (q) => q.eq("cameraId", a.cameraId)).unique();
    if (!cam) throw new Error("unknown camera");
    const { operator: _o, ...fields } = a;
    const ex = await getLocation(ctx, a.locationId);
    if (ex) await ctx.db.patch(ex._id, { ...fields, updatedAt: now() });
    else await ctx.db.insert("locations", { ...fields, updatedAt: now() });
    await audit(ctx, op, ex ? "location.updated" : "location.created", "location", a.locationId, fields);
    await reconcileLocation(ctx, a.locationId);
  },
});

/** Import records and transactions exported from a WMS (JSON). Idempotent on txnId; records are upserted per (location, SKU). */
export const importWms = mutation({
  args: {
    operator: v.string(),
    records: v.array(v.object({ sku: v.string(), locationId: v.string(), recordedQty: v.number(), description: v.optional(v.string()) })),
    transactions: v.array(v.object({
      txnId: v.string(), type: v.union(v.literal("receipt"), v.literal("putaway"), v.literal("pick"), v.literal("outbound"), v.literal("inbound"), v.literal("adjustment")),
      locationId: v.string(), sku: v.optional(v.string()), packageId: v.optional(v.string()), quantity: v.number(), at: v.number(), reference: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { operator, records, transactions }) => {
    const op = requireOperator(operator);
    const touched = new Set<string>();
    for (const r of records) {
      if (!(await getLocation(ctx, r.locationId))) throw new Error(`unknown location ${r.locationId}`);
      const ex = (await ctx.db.query("inventoryRecords").withIndex("by_location", (q) => q.eq("locationId", r.locationId)).collect()).find((x) => x.sku === r.sku);
      if (ex) await ctx.db.patch(ex._id, { ...r, isSample: false, updatedAt: now() }); else await ctx.db.insert("inventoryRecords", { ...r, isSample: false, updatedAt: now() });
      touched.add(r.locationId);
    }
    let added = 0;
    for (const t of transactions) {
      if (!(await getLocation(ctx, t.locationId))) throw new Error(`unknown location ${t.locationId}`);
      const ex = await ctx.db.query("transactions").withIndex("by_txnId", (q) => q.eq("txnId", t.txnId)).unique();
      if (ex) continue;
      await ctx.db.insert("transactions", { ...t, source: "wms_import", isSample: false });
      added++;
      touched.add(t.locationId);
    }
    for (const l of touched) await reconcileLocation(ctx, l);
    await audit(ctx, op, "wms.imported", "wms", "import", { records: records.length, transactionsAdded: added });
    return { records: records.length, transactionsAdded: added };
  },
});
