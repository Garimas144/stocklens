/**
 * Read-only investigation tools for the Claude agent, plus the controlled writes it is allowed to make.
 * Tools return records from Convex verbatim (ids included) so every claim can be checked against a stored row.
 */
import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { addNote, audit, getLocation, now } from "./lib";

const iso = (ms: number) => new Date(ms).toISOString();

export const eventView = (e: Doc<"movementEvents">) => ({
  eventId: e._id, type: e.type, direction: e.direction, location: e.locationId, camera: e.cameraId, session: e.sessionId, track: e.trackRef,
  packageId: e.packageId ?? null, sku: e.sku ?? null, at: iso(e.at), videoSecond: e.t, quantity: e.quantity, verification: e.verification,
  countsTowardReconciliation: e.countsTowardReconciliation, countingNote: e.countingNote ?? null, reasons: e.reasons, actor: e.actor ?? null,
  detectorConfidence: e.confidence ?? null, evidence: { image: e.evidence.imageUrl ?? null, video: e.evidence.videoUrl ?? null, second: e.evidence.t },
});
const txnView = (t: Doc<"transactions">) => ({ txnId: t._id, reference: t.txnId, type: t.type, location: t.locationId, sku: t.sku ?? null, packageId: t.packageId ?? null, quantity: t.quantity, at: iso(t.at), source: t.source, isSample: t.isSample });

export const toolGetDiscrepancy = internalQuery({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const d = await ctx.db.query("discrepancies").withIndex("by_code", (q) => q.eq("code", code)).unique();
    if (!d) return { error: `no discrepancy ${code}` };
    const notes = await ctx.db.query("investigationNotes").withIndex("by_discrepancy", (q) => q.eq("discrepancyId", d._id)).collect();
    return {
      code: d.code, kind: d.kind, location: d.locationId, camera: d.cameraId, session: d.sessionId ?? null, sku: d.sku ?? null,
      expectedLocationForThisSku: d.expectedLocationId ?? null,
      recordedQuantity: d.expectedQty, observedQuantity: d.observedQty, difference: d.difference, window: { from: iso(d.window.from), to: iso(d.window.to) },
      supportingEventIds: d.supportingEventIds, unmatchedEventIds: d.unmatchedEventIds, unmatchedTransactionIds: d.unmatchedTxnIds,
      uncertainEventIds: d.uncertainEventIds, status: d.status, assignee: d.assignee ?? null, systemSummary: d.summary, confidence: d.confidence,
      notes: notes.slice(-10).map((n) => ({ author: n.author, kind: n.kind, body: n.body, at: iso(n.at) })),
    };
  },
});

export const toolGetLocation = internalQuery({
  args: { locationId: v.string() },
  handler: async (ctx, { locationId }) => {
    const loc = await getLocation(ctx, locationId);
    if (!loc) return { error: `no location ${locationId}` };
    const records = await ctx.db.query("inventoryRecords").withIndex("by_location", (q) => q.eq("locationId", locationId)).collect();
    const product = loc.sku ? await ctx.db.query("products").withIndex("by_sku", (q) => q.eq("sku", loc.sku as string)).unique() : null;
    return {
      assignedProduct: product ? { sku: product.sku, name: product.name, category: product.category } : null,
      location: loc.locationId, name: loc.name, type: loc.type, camera: loc.cameraId, sku: loc.sku ?? null,
      verifiedStartingQuantity: loc.verifiedQty ?? null, verifiedAt: loc.verifiedAt ? iso(loc.verifiedAt) : null, verifiedBy: loc.verifiedBy ?? null,
      fullyVisibleToCamera: loc.fullyVisible ?? null, checkpointDirection: loc.direction ?? null, reconciliationState: loc.state ?? null,
      inventoryRecords: records.map((r) => ({ sku: r.sku, recordedQuantity: r.recordedQty, isSample: r.isSample })),
    };
  },
});

export const toolListEvents = internalQuery({
  args: { locationId: v.optional(v.string()), cameraId: v.optional(v.string()), sessionId: v.optional(v.string()), from: v.optional(v.string()), to: v.optional(v.string()), type: v.optional(v.string()), eventIds: v.optional(v.array(v.string())) },
  handler: async (ctx, a) => {
    let rows: Doc<"movementEvents">[];
    if (a.eventIds?.length) {
      rows = [];
      for (const id of a.eventIds) {
        const nid = ctx.db.normalizeId("movementEvents", id);
        const e = nid ? await ctx.db.get(nid) : null;
        if (e) rows.push(e);
      }
    } else if (a.locationId) rows = await ctx.db.query("movementEvents").withIndex("by_location_at", (q) => q.eq("locationId", a.locationId as string)).collect();
    else if (a.sessionId) rows = await ctx.db.query("movementEvents").withIndex("by_session", (q) => q.eq("sessionId", a.sessionId as string)).collect();
    else if (a.cameraId) rows = await ctx.db.query("movementEvents").withIndex("by_camera_at", (q) => q.eq("cameraId", a.cameraId as string)).collect();
    else rows = await ctx.db.query("movementEvents").order("desc").take(100);
    const from = a.from ? Date.parse(a.from) : -Infinity, to = a.to ? Date.parse(a.to) : Infinity;
    return rows.filter((e) => e.at >= from && e.at <= to && (!a.type || e.type === a.type)).slice(0, 100).map(eventView);
  },
});

export const toolListTransactions = internalQuery({
  args: { locationId: v.string(), from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const from = a.from ? Date.parse(a.from) : 0, to = a.to ? Date.parse(a.to) : Number.MAX_SAFE_INTEGER;
    const rows = await ctx.db.query("transactions").withIndex("by_location_at", (q) => q.eq("locationId", a.locationId).gte("at", from).lte("at", to)).collect();
    return rows.slice(0, 100).map(txnView);
  },
});

export const toolGetTrack = internalQuery({
  args: { sessionId: v.string(), trackRef: v.string() },
  handler: async (ctx, { sessionId, trackRef }) => {
    const t = await ctx.db.query("tracks").withIndex("by_session", (q) => q.eq("sessionId", sessionId).eq("trackRef", trackRef)).unique();
    if (!t) return { error: `no track ${trackRef} in session ${sessionId}` };
    const step = Math.max(1, Math.floor(t.samples.length / 12));
    return {
      track: t.trackRef, session: t.sessionId, camera: t.cameraId, kind: t.kind, note: "track ids are scoped to this video session and are not package identities",
      packageId: t.packageId ?? null, sku: t.sku ?? null, firstSeenSecond: t.firstSeenS, lastSeenSecond: t.lastSeenS, meanDetectorConfidence: t.meanConf,
      status: t.status, lossClass: t.lossClass ?? null, route: t.route, uncertainty: t.uncertainty,
      trajectorySample: t.samples.filter((_, i) => i % step === 0).map((s) => ({ second: s.t, zone: s.zone, conf: s.conf })),
    };
  },
});

// ------------------------------------------------------------------ runs (controlled writes)
export const startRun = internalMutation({
  args: { discrepancyId: v.optional(v.id("discrepancies")), question: v.string(), requestedBy: v.string(), model: v.string() },
  handler: async (ctx, a) => {
    // public demo: cap Claude spend. Counted in this transaction, so parallel requests cannot slip past it.
    const limit = Number(process.env.AGENT_MAX_PER_HOUR ?? 20);
    const lastHour = await ctx.db.query("agentRuns").withIndex("by_creation_time", (q) => q.gt("_creationTime", now() - 3600_000)).collect();
    if (lastHour.length >= limit) throw new Error(`Investigation limit reached (${limit} per hour on this demo). Try again later.`);
    return await ctx.db.insert("agentRuns", { ...a, status: "running", steps: [], startedAt: now() });
  },
});

export const addStep = internalMutation({
  args: { runId: v.id("agentRuns"), tool: v.string(), input: v.any(), output: v.string() },
  handler: async (ctx, { runId, tool, input, output }) => {
    const run = await ctx.db.get(runId);
    if (!run) return;
    await ctx.db.patch(runId, { steps: [...run.steps, { tool, input, output: output.slice(0, 4000), at: now() }] });
  },
});

export const finishRun = internalMutation({
  args: {
    runId: v.id("agentRuns"), status: v.union(v.literal("done"), v.literal("error"), v.literal("not_configured")),
    answer: v.optional(v.string()), facts: v.optional(v.array(v.string())), hypotheses: v.optional(v.array(v.string())),
    missingEvidence: v.optional(v.array(v.string())), recommendation: v.optional(v.string()), citations: v.optional(v.array(v.string())),
    retrievedIds: v.optional(v.array(v.string())), error: v.optional(v.string()),
  },
  handler: async (ctx, { runId, retrievedIds, ...a }) => {
    const run = await ctx.db.get(runId);
    if (!run) return;
    // a citation is valid only if it names a record the agent actually retrieved in this run
    const seen = new Set(retrievedIds ?? []);
    const invalid = (a.citations ?? []).filter((c) => !seen.has(c));
    await ctx.db.patch(runId, { ...a, invalidCitations: invalid, finishedAt: now() });
    if (run.discrepancyId && a.status === "done") {
      await addNote(ctx, run.discrepancyId, "Claude investigation agent", "agent",
        (a.answer ?? "") + (a.recommendation ? `\nRecommended next step: ${a.recommendation}` : "") + (invalid.length ? `\n(${invalid.length} citation(s) did not match retrieved records and were flagged.)` : ""));
    }
  },
});

export const agentRequestReview = internalMutation({
  args: { runId: v.id("agentRuns"), discrepancyId: v.id("discrepancies"), reason: v.string() },
  handler: async (ctx, { runId, discrepancyId, reason }) => {
    const d = await ctx.db.get(discrepancyId);
    if (!d) return "not found";
    if (d.status === "open") await ctx.db.patch(discrepancyId, { status: "investigating", updatedAt: now() });
    await addNote(ctx, discrepancyId, "Claude investigation agent", "agent", `Requested human review: ${reason}`);
    await audit(ctx, "agent", "discrepancy.review_requested", "discrepancy", d.code, { runId, reason });
    return "review requested; status is now investigating";
  },
});

export const agentProposeCorrection = internalMutation({
  args: { runId: v.id("agentRuns"), discrepancyId: v.id("discrepancies"), toQty: v.number(), reason: v.string() },
  handler: async (ctx, { runId, discrepancyId, toQty, reason }) => {
    const d = await ctx.db.get(discrepancyId);
    if (!d || d.kind !== "shelf_quantity" || !d.sku) return "corrections are only possible for shelf discrepancies with a SKU";
    const pending = await ctx.db.query("corrections").withIndex("by_discrepancy", (q) => q.eq("discrepancyId", discrepancyId)).collect();
    if (pending.some((c) => c.status === "pending")) return "a correction is already pending for this discrepancy";
    const rec = (await ctx.db.query("inventoryRecords").withIndex("by_location", (q) => q.eq("locationId", d.locationId)).collect()).find((r) => r.sku === d.sku);
    if (!rec) return "no inventory record for this SKU at this location";
    await ctx.db.insert("corrections", { discrepancyId, locationId: d.locationId, sku: d.sku, fromQty: rec.recordedQty, toQty, reason, status: "pending", requestedBy: "Claude investigation agent", createdAt: now() });
    await addNote(ctx, discrepancyId, "Claude investigation agent", "correction", `Proposed record correction ${rec.recordedQty} -> ${toQty} (pending human approval): ${reason}`);
    await audit(ctx, "agent", "correction.proposed", "discrepancy", d.code, { runId, toQty });
    return `correction proposed (${rec.recordedQty} -> ${toQty}); it changes nothing until an operator approves it`;
  },
});

export const discrepancyCode = internalQuery({
  args: { id: v.id("discrepancies") },
  handler: async (ctx, { id }) => (await ctx.db.get(id))?.code ?? null,
});

export const runs = query({
  args: { discrepancyId: v.id("discrepancies") },
  handler: async (ctx, { discrepancyId }) =>
    (await ctx.db.query("agentRuns").withIndex("by_discrepancy", (q) => q.eq("discrepancyId", discrepancyId)).order("desc").take(10)),
});

export type _Ids = Id<"agentRuns">;
