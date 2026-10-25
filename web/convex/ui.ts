/** Reactive read models for the operations dashboard. Every page subscribes to these; nothing is polled. */
import { query } from "./_generated/server";
import { v } from "convex/values";
import { Doc } from "./_generated/dataModel";
import { getLocation } from "./lib";

const OPEN = ["open", "investigating", "escalated"];

export const overview = query({
  args: {},
  handler: async (ctx) => {
    const cameras = await ctx.db.query("cameras").collect();
    const locations = await ctx.db.query("locations").collect();
    const records = await ctx.db.query("inventoryRecords").collect();
    const discrepancies = (await ctx.db.query("discrepancies").collect()).filter((d) => OPEN.includes(d.status));
    const jobs = await ctx.db.query("jobs").withIndex("by_status").order("desc").take(20);
    const camsWithSessions = await Promise.all(cameras.map(async (c) => {
      const latest = await ctx.db.query("sessions").withIndex("by_camera", (q) => q.eq("cameraId", c.cameraId)).order("desc").first();
      return { ...c, latestSession: latest };
    }));
    // movements in each camera's current analysis: re-analysed (superseded) and rejected events are history, not movements
    const current = (await Promise.all(cameras.map(async (c) => {
      const s = (await ctx.db.query("sessions").withIndex("by_camera", (q) => q.eq("cameraId", c.cameraId)).order("desc").collect()).find((x) => x.status === "done");
      return s ? await ctx.db.query("movementEvents").withIndex("by_session", (q) => q.eq("sessionId", s.sessionId)).collect() : [];
    }))).flat().filter((e) => e.verification === "confirmed" || e.verification === "uncertain");
    const recent = [...current].sort((a, b) => b.at - a.at).slice(0, 12);
    const movementTotals = { confirmed: current.filter((e) => e.verification === "confirmed").length, uncertain: current.filter((e) => e.verification === "uncertain").length };
    return {
      cameras: camsWithSessions,
      locations: locations.map((l) => ({ ...l, records: records.filter((r) => r.locationId === l.locationId) })),
      openDiscrepancies: discrepancies.sort((a, b) => b.updatedAt - a.updatedAt),
      recentEvents: recent,
      movementTotals,
      activeJobs: jobs.filter((j) => j.status === "queued" || j.status === "running"),
      sampleData: records.some((r) => r.isSample),
    };
  },
});

export const cameras = query({
  args: {},
  handler: async (ctx) => {
    const cams = await ctx.db.query("cameras").collect();
    return await Promise.all(cams.map(async (c) => ({
      ...c,
      sessions: await ctx.db.query("sessions").withIndex("by_camera", (q) => q.eq("cameraId", c.cameraId)).order("desc").take(5),
      locations: await ctx.db.query("locations").withIndex("by_camera", (q) => q.eq("cameraId", c.cameraId)).collect(),
    })));
  },
});

export const cameraDetail = query({
  args: { cameraId: v.string(), sessionId: v.optional(v.string()) },
  handler: async (ctx, { cameraId, sessionId }) => {
    const camera = await ctx.db.query("cameras").withIndex("by_cameraId", (q) => q.eq("cameraId", cameraId)).unique();
    if (!camera) return null;
    const sessions = await ctx.db.query("sessions").withIndex("by_camera", (q) => q.eq("cameraId", cameraId)).order("desc").collect();
    const session = sessionId ? sessions.find((s) => s.sessionId === sessionId) : sessions.find((s) => s.status === "done") ?? sessions[0];
    const tracks = session ? await ctx.db.query("tracks").withIndex("by_session", (q) => q.eq("sessionId", session.sessionId)).collect() : [];
    const events = session ? await ctx.db.query("movementEvents").withIndex("by_session", (q) => q.eq("sessionId", session.sessionId)).collect() : [];
    const locations = await ctx.db.query("locations").withIndex("by_camera", (q) => q.eq("cameraId", cameraId)).collect();
    const jobs = (await ctx.db.query("jobs").collect()).filter((j) => j.cameraId === cameraId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
    return { camera, sessions, session, tracks, events, locations, jobs };
  },
});

export const locations = query({
  args: { type: v.optional(v.union(v.literal("shelf"), v.literal("checkpoint"))) },
  handler: async (ctx, { type }) => {
    const locs = (await ctx.db.query("locations").collect()).filter((l) => !type || l.type === type);
    return await Promise.all(locs.map(async (l) => ({
      ...l,
      records: await ctx.db.query("inventoryRecords").withIndex("by_location", (q) => q.eq("locationId", l.locationId)).collect(),
      openDiscrepancy: (await ctx.db.query("discrepancies").withIndex("by_location", (q) => q.eq("locationId", l.locationId)).collect()).filter((d) => OPEN.includes(d.status)),
    })));
  },
});

export const locationDetail = query({
  args: { locationId: v.string() },
  handler: async (ctx, { locationId }) => {
    const loc = await getLocation(ctx, locationId);
    if (!loc) return null;
    const records = await ctx.db.query("inventoryRecords").withIndex("by_location", (q) => q.eq("locationId", locationId)).collect();
    const events = await ctx.db.query("movementEvents").withIndex("by_location_at", (q) => q.eq("locationId", locationId)).order("desc").take(200);
    const transactions = await ctx.db.query("transactions").withIndex("by_location_at", (q) => q.eq("locationId", locationId)).order("desc").take(200);
    const discrepancies = await ctx.db.query("discrepancies").withIndex("by_location", (q) => q.eq("locationId", locationId)).order("desc").collect();
    const sessions = await ctx.db.query("sessions").withIndex("by_camera", (q) => q.eq("cameraId", loc.cameraId)).order("desc").take(5);
    return { location: loc, records, events, transactions, discrepancies, sessions };
  },
});

export const discrepancies = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, { status }) => {
    const all = await ctx.db.query("discrepancies").collect();
    return all.filter((d) => !status || (status === "active" ? OPEN.includes(d.status) : d.status === status)).sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const discrepancy = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const d = await ctx.db.query("discrepancies").withIndex("by_code", (q) => q.eq("code", code)).unique();
    if (!d) return null;
    const get = async (ids: Doc<"discrepancies">["supportingEventIds"]) => (await Promise.all(ids.map((id) => ctx.db.get(id)))).filter((x): x is Doc<"movementEvents"> => !!x);
    const location = await getLocation(ctx, d.locationId);
    const records = await ctx.db.query("inventoryRecords").withIndex("by_location", (q) => q.eq("locationId", d.locationId)).collect();
    const txns = await ctx.db.query("transactions").withIndex("by_location_at", (q) => q.eq("locationId", d.locationId).gte("at", d.window.from).lte("at", d.window.to)).collect();
    const corrTxns = (await ctx.db.query("transactions").withIndex("by_location_at", (q) => q.eq("locationId", d.locationId)).collect()).filter((t) => t.reference === d.code);
    const notes = await ctx.db.query("investigationNotes").withIndex("by_discrepancy", (q) => q.eq("discrepancyId", d._id)).collect();
    const corrections = await ctx.db.query("corrections").withIndex("by_discrepancy", (q) => q.eq("discrepancyId", d._id)).collect();
    const runs = await ctx.db.query("agentRuns").withIndex("by_discrepancy", (q) => q.eq("discrepancyId", d._id)).order("desc").take(5);
    const supporting = await get(d.supportingEventIds);
    const uncertain = await get(d.uncertainEventIds);
    const sessionIds = [...new Set([...supporting, ...uncertain].map((e) => e.sessionId).concat(d.sessionId ? [d.sessionId] : []))];
    const sessions = (await Promise.all(sessionIds.map((s) => ctx.db.query("sessions").withIndex("by_sessionId", (q) => q.eq("sessionId", s)).unique()))).filter(Boolean);
    return {
      discrepancy: d, location, records, supporting, uncertain, unmatchedEventIds: d.unmatchedEventIds, unmatchedTxnIds: d.unmatchedTxnIds,
      transactions: [...txns, ...corrTxns.filter((c) => !txns.some((t) => t._id === c._id))], notes, corrections, runs, sessions,
    };
  },
});

/** Searchable movement history: by camera, checkpoint/location, time range, package id, SKU, track or type. */
export const searchEvents = query({
  args: {
    cameraId: v.optional(v.string()), locationId: v.optional(v.string()), packageId: v.optional(v.string()), sku: v.optional(v.string()),
    trackRef: v.optional(v.string()), type: v.optional(v.string()), direction: v.optional(v.string()), verification: v.optional(v.string()),
    from: v.optional(v.number()), to: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const from = a.from ?? 0, to = a.to ?? Number.MAX_SAFE_INTEGER;
    let rows: Doc<"movementEvents">[];
    if (a.packageId) rows = await ctx.db.query("movementEvents").withIndex("by_package", (q) => q.eq("packageId", a.packageId)).collect();
    else if (a.locationId) rows = await ctx.db.query("movementEvents").withIndex("by_location_at", (q) => q.eq("locationId", a.locationId as string).gte("at", from).lte("at", to)).collect();
    else if (a.cameraId) rows = await ctx.db.query("movementEvents").withIndex("by_camera_at", (q) => q.eq("cameraId", a.cameraId as string).gte("at", from).lte("at", to)).collect();
    else rows = await ctx.db.query("movementEvents").withIndex("by_at", (q) => q.gte("at", from).lte("at", to)).order("desc").take(500);
    const t = (a.trackRef ?? "").toLowerCase();
    return rows
      .filter((e) => e.at >= from && e.at <= to && (!a.cameraId || e.cameraId === a.cameraId) && (!a.sku || (e.sku ?? "").toLowerCase() === a.sku.toLowerCase())
        && (!t || e.trackRef.toLowerCase() === t) && (!a.type || e.type === a.type) && (!a.direction || e.direction === a.direction) && (!a.verification || e.verification === a.verification))
      .sort((x, y) => y.at - x.at).slice(0, 300);
  },
});

export const track = query({
  args: { sessionId: v.string(), trackRef: v.string() },
  handler: async (ctx, { sessionId, trackRef }) => {
    const t = await ctx.db.query("tracks").withIndex("by_session", (q) => q.eq("sessionId", sessionId).eq("trackRef", trackRef)).unique();
    const events = (await ctx.db.query("movementEvents").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect()).filter((e) => e.trackRef === trackRef);
    const session = await ctx.db.query("sessions").withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId)).unique();
    return { track: t, events, session };
  },
});

export const audit = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => ctx.db.query("audit").withIndex("by_at").order("desc").take(Math.min(limit ?? 50, 200)),
});

/** The camera network: every camera with its latest footage, activity summary and open exceptions. */
export const network = query({
  args: {},
  handler: async (ctx) => {
    const cams = await ctx.db.query("cameras").collect();
    const discs = (await ctx.db.query("discrepancies").collect()).filter((d) => OPEN.includes(d.status));
    const out = await Promise.all(cams.map(async (c) => {
      const sessions = await ctx.db.query("sessions").withIndex("by_camera", (q) => q.eq("cameraId", c.cameraId)).order("desc").take(3);
      const session = sessions.find((s) => s.status === "done") ?? sessions[0] ?? null;
      const events = session ? (await ctx.db.query("movementEvents").withIndex("by_session", (q) => q.eq("sessionId", session.sessionId)).collect()).filter((e) => e.verification !== "superseded") : [];
      const locations = await ctx.db.query("locations").withIndex("by_camera", (q) => q.eq("cameraId", c.cameraId)).collect();
      const tracks = session ? await ctx.db.query("tracks").withIndex("by_session", (q) => q.eq("sessionId", session.sessionId)).collect() : [];
      const job = (await ctx.db.query("jobs").collect()).filter((j) => j.cameraId === c.cameraId && (j.status === "queued" || j.status === "running"))[0] ?? null;
      return {
        ...c, session, job, locations, events: events.sort((a, b) => a.t - b.t),
        trackSummary: { packages: tracks.filter((t) => t.kind === "package").length, people: tracks.filter((t) => t.kind === "person").length },
        exceptions: discs.filter((d) => d.cameraId === c.cameraId).map((d) => ({ code: d.code, kind: d.kind, difference: d.difference, locationId: d.locationId })),
      };
    }));
    return out.sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
  },
});

/** Inventory view: products, where they belong, recorded vs physical, misplaced items, flow points. */
export const inventory = query({
  args: {},
  handler: async (ctx) => {
    const products = await ctx.db.query("products").collect();
    const locations = await ctx.db.query("locations").collect();
    const records = await ctx.db.query("inventoryRecords").collect();
    const discs = (await ctx.db.query("discrepancies").collect()).filter((d) => OPEN.includes(d.status));
    const byLoc = (id: string) => discs.filter((d) => d.locationId === id);
    return {
      products,
      shelves: locations.filter((l) => l.type === "shelf").sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((l) => ({
        ...l, product: products.find((p) => p.sku === l.sku) ?? null, records: records.filter((r) => r.locationId === l.locationId),
        incidents: byLoc(l.locationId), misplaced: byLoc(l.locationId).filter((d) => d.kind === "misplaced_item"),
      })),
      flow: locations.filter((l) => l.type !== "shelf").map((l) => ({ ...l, incidents: byLoc(l.locationId) })),
      sample: records.some((r) => r.isSample) || products.some((p) => p.isSample),
    };
  },
});

/** Chronological history of one identified item (package id or SKU) across every camera. Anonymous tracks are never joined. */
export const itemHistory = query({
  args: { packageId: v.optional(v.string()), sku: v.optional(v.string()) },
  handler: async (ctx, { packageId, sku }) => {
    if (!packageId && !sku) return null;
    const events = packageId
      ? await ctx.db.query("movementEvents").withIndex("by_package", (q) => q.eq("packageId", packageId)).collect()
      : (await ctx.db.query("movementEvents").withIndex("by_at").collect()).filter((e) => e.sku === sku);
    const tracks = packageId ? await ctx.db.query("tracks").withIndex("by_package", (q) => q.eq("packageId", packageId)).collect() : [];
    const sorted = events.filter((e) => e.verification !== "superseded").sort((a, b) => a.at - b.at);
    const last = sorted[sorted.length - 1];
    return { events: sorted, tracks: tracks.map((t) => ({ sessionId: t.sessionId, cameraId: t.cameraId, trackRef: t.trackRef, firstSeenS: t.firstSeenS, lastSeenS: t.lastSeenS })),
      lastKnown: last ? { locationId: last.locationId, cameraId: last.cameraId, at: last.at, type: last.type } : null };
  },
});

/**
 * Everything the surveillance view needs to draw its own overlays from stored data (no burned-in boxes):
 * per camera the latest recording, track samples (image-space boxes), movement events, zones/lines and a state per track
 * derived only from evidence: matched movement = verified, uncertain movement = review, movement in an open incident = discrepancy.
 */
export const surveillance = query({
  args: {},
  handler: async (ctx) => {
    const cams = await ctx.db.query("cameras").collect();
    const discs = (await ctx.db.query("discrepancies").collect()).filter((d) => OPEN.includes(d.status));
    const unmatched = new Set(discs.flatMap((d) => d.unmatchedEventIds as string[]));
    const misplacedEv = new Set(discs.filter((d) => d.kind === "misplaced_item").flatMap((d) => d.supportingEventIds as string[]));
    const incidentOf = new Map<string, string>();
    for (const d of discs) for (const id of [...d.unmatchedEventIds, ...d.supportingEventIds, ...d.uncertainEventIds]) incidentOf.set(id as string, d.code);
    const products = await ctx.db.query("products").collect();
    const locations = await ctx.db.query("locations").collect();
    const out = await Promise.all(cams.map(async (c) => {
      const session = (await ctx.db.query("sessions").withIndex("by_camera", (q) => q.eq("cameraId", c.cameraId)).order("desc").collect()).find((s) => s.status === "done") ?? null;
      const job = (await ctx.db.query("jobs").collect()).find((j) => j.cameraId === c.cameraId && (j.status === "queued" || j.status === "running")) ?? null;
      const tracks = session ? await ctx.db.query("tracks").withIndex("by_session", (q) => q.eq("sessionId", session.sessionId)).collect() : [];
      const events = session ? (await ctx.db.query("movementEvents").withIndex("by_session", (q) => q.eq("sessionId", session.sessionId)).collect()).filter((e) => e.verification !== "superseded" && e.verification !== "rejected") : [];
      const evOut = events.map((e) => {
        const loc = locations.find((l) => l.locationId === e.locationId);
        // verified = a confirmed movement that reconciles with the records; observation-only zones never get an inventory verdict
        const state = misplacedEv.has(e._id) || unmatched.has(e._id) ? "discrepancy" : e.verification === "uncertain" ? "review"
          : e.countsTowardReconciliation && loc?.type !== "zone" ? "verified" : "neutral";
        const prod = e.sku ? products.find((p) => p.sku === e.sku) : null;
        return { id: e._id, t: e.t, type: e.type, direction: e.direction ?? null, trackRef: e.trackRef, locationId: e.locationId, locationName: loc?.name ?? e.locationId,
          verification: e.verification, state, incident: incidentOf.get(e._id) ?? null, sku: e.sku ?? null, product: prod?.name ?? null, identitySource: e.identitySource ?? null, imageUrl: e.evidence.imageUrl ?? null,
          detectionConf: e.detectionConf ?? null, trackingQuality: e.trackingQuality ?? null, eventConf: e.eventConf ?? null };
      });
      const shelves = ((c.config?.zones ?? []) as { id: string; label: string; role: string; polygon: number[][]; location_id?: string }[]).filter((z) => z.role === "shelf").map((z) => {
        const loc = locations.find((l) => l.locationId === z.location_id);
        const prod = loc?.sku ? products.find((p) => p.sku === loc.sku) : null;
        return { id: z.id, label: loc?.name ?? z.label, product: prod?.name ?? null, polygon: z.polygon, status: loc?.state?.status ?? null };
      });
      const lines = ((c.config?.count_lines ?? []) as { id: string; label: string; p1: number[]; p2: number[]; forward: number[]; forward_means?: string }[])
        .map((l) => ({ id: l.id, label: l.label, p1: l.p1, p2: l.p2, forward: l.forward, means: l.forward_means ?? null }));
      return {
        cameraId: c.cameraId, name: c.name, slot: c.slot ?? null, area: c.area ?? null, where: c.warehouseLocation, profile: c.profile, sourceKind: c.source.kind, status: c.status, job,
        session: session && { sessionId: session.sessionId, startedAt: session.startedAt, durationS: session.durationS ?? 0, width: session.width ?? 1920, height: session.height ?? 1080,
          originalUrl: session.originalUrl ?? null, processedUrl: session.processedUrl ?? null, cameraShiftPx: session.stats?.cameraShiftPx ?? null,
          cameraPath: session.cameraPath ?? null },
        tracks: tracks.map((t) => ({ ref: t.trackRef, kind: t.kind, packageId: t.packageId ?? null, sku: t.sku ?? null, product: t.sku ? products.find((p) => p.sku === t.sku)?.name ?? null : null,
          firstSeenS: t.firstSeenS, lastSeenS: t.lastSeenS, meanConf: t.meanConf, status: t.status, uncertainty: t.uncertainty,
          relevance: t.relevance ?? null, trackingQuality: t.trackingQuality ?? null, category: t.category ?? null, samples: t.samples.map((s) => ({ t: s.t, b: s.bbox, c: s.conf, z: s.zone })) })),
        events: evOut, shelves, lines, roi: ((c.config?.rules?.roi ?? null) as number[][] | null),
        incidents: discs.filter((d) => d.cameraId === c.cameraId).map((d) => ({ code: d.code, kind: d.kind, difference: d.difference, locationId: d.locationId })),
      };
    }));
    return out.sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
  },
});
