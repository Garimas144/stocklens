/**
 * Endpoints used by the Python YOLOv8 worker. Every call carries the worker secret. The worker sends structured business events
 * and per-track summaries, never raw frames. Event ingestion is idempotent (eventKey) and runs reconciliation in the same
 * transaction, so an inventory estimate can never move twice for one physical event.
 */
import { mutation, query, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { audit, getLocation, now, reconcileLocation, requireWorker } from "./lib";

const sampleV = v.object({ t: v.number(), x: v.number(), y: v.number(), bbox: v.array(v.number()), conf: v.number(), zone: v.string() });
const eventV = v.object({
  eventKey: v.string(),
  locationId: v.string(),
  type: v.union(v.literal("shelf_addition"), v.literal("shelf_removal"), v.literal("checkpoint_crossing")),
  direction: v.optional(v.union(v.literal("inbound"), v.literal("outbound"))),
  againstFlow: v.optional(v.boolean()),
  fromZone: v.optional(v.string()),
  toZone: v.optional(v.string()),
  trackRef: v.string(),
  t: v.number(),
  quantity: v.number(),
  confidence: v.optional(v.number()),
  detectionConf: v.optional(v.number()),
  trackingQuality: v.optional(v.number()),
  eventConf: v.optional(v.number()),
  verification: v.union(v.literal("confirmed"), v.literal("uncertain")),
  reasons: v.array(v.string()),
  actor: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  sku: v.optional(v.string()),            // only when the worker has identity evidence (e.g. a product-class detection)
  identitySource: v.optional(v.string()),
});

export const getCamera = query({
  args: { secret: v.string(), cameraId: v.string() },
  handler: async (ctx, { secret, cameraId }) => {
    requireWorker(secret);
    const cam = await ctx.db.query("cameras").withIndex("by_cameraId", (q) => q.eq("cameraId", cameraId)).unique();
    if (!cam) return null;
    const locations = await ctx.db.query("locations").withIndex("by_camera", (q) => q.eq("cameraId", cameraId)).collect();
    return { ...cam, locations };
  },
});

export const claimJob = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireWorker(secret);
    const job = await ctx.db.query("jobs").withIndex("by_status", (q) => q.eq("status", "queued")).first();
    if (!job) return null;
    await ctx.db.patch(job._id, { status: "running", updatedAt: now() });
    const cam = await ctx.db.query("cameras").withIndex("by_cameraId", (q) => q.eq("cameraId", job.cameraId)).unique();
    if (cam) await ctx.db.patch(cam._id, { status: "processing" });
    return job;
  },
});

export const updateJob = mutation({
  args: { secret: v.string(), jobId: v.id("jobs"), status: v.optional(v.union(v.literal("running"), v.literal("done"), v.literal("error"))), progress: v.optional(v.number()), sessionId: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, { secret, jobId, ...patch }) => {
    requireWorker(secret);
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("job not found");
    const clean = Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined));
    await ctx.db.patch(jobId, { ...clean, updatedAt: now() });
    if (patch.status === "done" || patch.status === "error") {
      const cam = await ctx.db.query("cameras").withIndex("by_cameraId", (q) => q.eq("cameraId", job.cameraId)).unique();
      if (cam) await ctx.db.patch(cam._id, { status: patch.status === "error" ? "error" : "idle" });
    }
  },
});

export const upsertSession = mutation({
  args: {
    secret: v.string(), sessionId: v.string(), cameraId: v.string(), status: v.string(), progress: v.number(), startedAt: v.number(),
    durationS: v.optional(v.number()), fps: v.optional(v.number()), width: v.optional(v.number()), height: v.optional(v.number()),
    originalUrl: v.optional(v.string()), processedUrl: v.optional(v.string()), models: v.optional(v.any()), stats: v.optional(v.any()), error: v.optional(v.string()),
    cameraPath: v.optional(v.array(v.object({ t: v.number(), m: v.array(v.number()) }))),
  },
  handler: async (ctx, { secret, ...s }) => {
    requireWorker(secret);
    const existing = await ctx.db.query("sessions").withIndex("by_sessionId", (q) => q.eq("sessionId", s.sessionId)).unique();
    const doc = { ...s, updatedAt: now() };
    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert("sessions", doc);
    if (s.status === "done") {
      // checkpoint reconciliation windows depend on the session's span
      const locs = await ctx.db.query("locations").withIndex("by_camera", (q) => q.eq("cameraId", s.cameraId)).collect();
      for (const l of locs) await reconcileLocation(ctx, l.locationId);
    }
  },
});

export const replaceTracks = mutation({
  args: {
    secret: v.string(), sessionId: v.string(), cameraId: v.string(),
    tracks: v.array(v.object({
      trackRef: v.string(), kind: v.string(), trackerIds: v.string(), firstSeenS: v.number(), lastSeenS: v.number(), meanConf: v.number(),
      status: v.string(), lossClass: v.optional(v.string()), route: v.array(v.string()), uncertainty: v.array(v.string()), samples: v.array(sampleV),
      evidence: v.optional(v.object({ firstUrl: v.optional(v.string()), lastUrl: v.optional(v.string()) })),
      relevance: v.optional(v.string()), trackingQuality: v.optional(v.number()), category: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { secret, sessionId, cameraId, tracks }) => {
    requireWorker(secret);
    const old = await ctx.db.query("tracks").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect();
    const keep = new Map(old.filter((t) => t.packageId || t.sku).map((t) => [t.trackRef, { packageId: t.packageId, sku: t.sku }]));
    for (const t of old) await ctx.db.delete(t._id);
    for (const t of tracks) await ctx.db.insert("tracks", { ...t, sessionId, cameraId, ...(keep.get(t.trackRef) ?? {}) });
    return tracks.length;
  },
});

async function countingDecision(ctx: MutationCtx, cameraId: string, e: { locationId: string; type: string; direction?: string; verification: string; at: number; packageId?: string }) {
  const loc = await getLocation(ctx, e.locationId);
  if (!loc) return { counts: false, note: `unknown location ${e.locationId}; stored for audit only` };
  if (e.verification !== "confirmed") return { counts: false, note: "uncertain: needs operator review before it can count" };
  if (loc.type === "checkpoint" && loc.cameraId !== cameraId)
    return { counts: false, note: `seen by secondary camera ${cameraId}; ${loc.name} is counted by ${loc.cameraId} so the transfer is not counted twice` };
  if (e.packageId) {
    const same = await ctx.db.query("movementEvents").withIndex("by_package", (q) => q.eq("packageId", e.packageId)).collect();
    const dup = same.find((x) => x.locationId === e.locationId && x.type === e.type && x.direction === e.direction && x.countsTowardReconciliation && Math.abs(x.at - e.at) < 10 * 60 * 1000);
    if (dup) return { counts: false, note: `package ${e.packageId} already counted at this location by event ${dup.eventKey}` };
  }
  return { counts: true, note: undefined };
}

/**
 * Idempotent publication of one session's movement events. Re-sending the same events changes nothing. With `final: true`,
 * events previously published for this session but absent now (the session was re-analysed with new rules) are marked
 * superseded rather than deleted, so the audit trail survives.
 */
export const publishEvents = mutation({
  args: { secret: v.string(), sessionId: v.string(), cameraId: v.string(), events: v.array(eventV), final: v.boolean() },
  handler: async (ctx, { secret, sessionId, cameraId, events, final }) => {
    requireWorker(secret);
    const session = await ctx.db.query("sessions").withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId)).unique();
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const touched = new Set<string>();
    let inserted = 0, duplicates = 0, superseded = 0;
    const keys = new Set(events.map((e) => e.eventKey));
    for (const e of events) {
      const existing = await ctx.db.query("movementEvents").withIndex("by_key", (q) => q.eq("eventKey", e.eventKey)).unique();
      if (existing) {
        duplicates++;
        if (existing.verification === "superseded") {
          await ctx.db.patch(existing._id, { verification: e.verification, verifiedBy: "cv" });
          touched.add(existing.locationId);
        }
        continue;
      }
      const at = session.startedAt + Math.round(e.t * 1000);
      const track = await ctx.db.query("tracks").withIndex("by_session", (q) => q.eq("sessionId", sessionId).eq("trackRef", e.trackRef)).unique();
      const decision = await countingDecision(ctx, cameraId, { ...e, at, packageId: track?.packageId });
      const { imageUrl, sku: cvSku, identitySource: cvSource, ...rest } = e;
      const sku = track?.sku ?? cvSku;
      const identitySource = track?.sku ? "operator" : cvSku ? (cvSource ?? "cv_category") : undefined;
      await ctx.db.insert("movementEvents", {
        ...rest, sessionId, cameraId, at, packageId: track?.packageId, sku, identitySource, verifiedBy: "cv",
        countsTowardReconciliation: decision.counts, countingNote: decision.note,
        evidence: { imageUrl, videoUrl: session.processedUrl, t: e.t }, ingestedAt: now(),
      });
      inserted++;
      touched.add(e.locationId);
    }
    if (final) {
      const prior = await ctx.db.query("movementEvents").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect();
      for (const p of prior) {
        if (!keys.has(p.eventKey) && p.verification !== "superseded" && p.verifiedBy === "cv") {
          await ctx.db.patch(p._id, { verification: "superseded", countsTowardReconciliation: false, countingNote: "superseded by a re-analysis of this session" });
          superseded++;
          touched.add(p.locationId);
        }
      }
    }
    for (const l of touched) await reconcileLocation(ctx, l);
    if (inserted || superseded) await audit(ctx, "worker", "events.published", "session", sessionId, { inserted, duplicates, superseded });
    return { inserted, duplicates, superseded, locations: [...touched] };
  },
});

/** Clearly-labelled sample WMS data and demo camera setup. Idempotent: existing rows are updated, not duplicated. */
export const seed = mutation({
  args: { secret: v.string(), fixture: v.any() },
  handler: async (ctx, { secret, fixture }) => {
    requireWorker(secret);
    const t = now();
    for (const c of fixture.cameras ?? []) {
      const ex = await ctx.db.query("cameras").withIndex("by_cameraId", (q) => q.eq("cameraId", c.cameraId)).unique();
      const doc = { ...c, status: ex?.status ?? "idle", updatedAt: t, updatedBy: "seed" };
      if (ex) await ctx.db.patch(ex._id, doc); else await ctx.db.insert("cameras", doc);
    }
    for (const l of fixture.locations ?? []) {
      const ex = await getLocation(ctx, l.locationId);
      if (ex) await ctx.db.patch(ex._id, { ...l, updatedAt: t }); else await ctx.db.insert("locations", { ...l, updatedAt: t });
    }
    for (const p of fixture.products ?? []) {
      const ex = await ctx.db.query("products").withIndex("by_sku", (q) => q.eq("sku", p.sku)).unique();
      if (ex) await ctx.db.patch(ex._id, { ...p, isSample: true }); else await ctx.db.insert("products", { ...p, isSample: true });
    }
    for (const r of fixture.inventoryRecords ?? []) {
      const ex = (await ctx.db.query("inventoryRecords").withIndex("by_location", (q) => q.eq("locationId", r.locationId)).collect()).find((x) => x.sku === r.sku);
      if (ex) await ctx.db.patch(ex._id, { ...r, isSample: true, updatedAt: t }); else await ctx.db.insert("inventoryRecords", { ...r, isSample: true, updatedAt: t });
    }
    for (const x of fixture.transactions ?? []) {
      const ex = await ctx.db.query("transactions").withIndex("by_txnId", (q) => q.eq("txnId", x.txnId)).unique();
      if (ex) await ctx.db.patch(ex._id, { ...x, source: "wms_sample", isSample: true }); else await ctx.db.insert("transactions", { ...x, source: "wms_sample", isSample: true });
    }
    for (const l of fixture.locations ?? []) await reconcileLocation(ctx, l.locationId);
    await audit(ctx, "seed", "seed", "fixture", "demo", { cameras: (fixture.cameras ?? []).length });
    return "ok";
  },
});

/** Development/test helper: wipe every table. Requires the worker secret and ALLOW_RESET=1 on the deployment. */
export const resetAll = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireWorker(secret);
    if (process.env.ALLOW_RESET !== "1") throw new Error("reset disabled (set ALLOW_RESET=1 on a dev deployment)");
    const tables = ["cameras", "locations", "inventoryRecords", "transactions", "sessions", "tracks", "movementEvents", "discrepancies",
      "investigationNotes", "corrections", "agentRuns", "jobs", "audit", "counters", "products"] as const;
    let n = 0;
    for (const t of tables) for (const d of await ctx.db.query(t).collect()) { await ctx.db.delete(d._id); n++; }
    return n;
  },
});

/** Test helper: remove everything the integration tests created (ids prefixed TEST-/test-cam/S-A-/S-B-/SKU-T-/SKU-O-/T-). */
export const purgeTestData = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireWorker(secret);
    const isTestLoc = (s?: string) => !!s && s.startsWith("TEST-");
    let n = 0;
    const del = async (id: Parameters<typeof ctx.db.delete>[0]) => { await ctx.db.delete(id); n++; };
    for (const d of await ctx.db.query("cameras").collect()) if (d.cameraId.startsWith("test-cam")) await del(d._id);
    for (const d of await ctx.db.query("locations").collect()) if (isTestLoc(d.locationId)) await del(d._id);
    for (const d of await ctx.db.query("sessions").collect()) if (/^S-[AB]-/.test(d.sessionId)) await del(d._id);
    for (const d of await ctx.db.query("tracks").collect()) if (/^S-[AB]-/.test(d.sessionId)) await del(d._id);
    for (const d of await ctx.db.query("movementEvents").collect()) if (isTestLoc(d.locationId)) await del(d._id);
    for (const d of await ctx.db.query("inventoryRecords").collect()) if (isTestLoc(d.locationId)) await del(d._id);
    for (const d of await ctx.db.query("transactions").collect()) if (isTestLoc(d.locationId)) await del(d._id);
    for (const d of await ctx.db.query("products").collect()) if (/^SKU-[TO]-/.test(d.sku)) await del(d._id);
    for (const d of await ctx.db.query("discrepancies").collect()) if (isTestLoc(d.locationId)) {
      for (const x of await ctx.db.query("investigationNotes").withIndex("by_discrepancy", (q) => q.eq("discrepancyId", d._id)).collect()) await del(x._id);
      for (const x of await ctx.db.query("corrections").withIndex("by_discrepancy", (q) => q.eq("discrepancyId", d._id)).collect()) await del(x._id);
      for (const x of await ctx.db.query("agentRuns").withIndex("by_discrepancy", (q) => q.eq("discrepancyId", d._id)).collect()) await del(x._id);
      await del(d._id);
    }
    return n;
  },
});
