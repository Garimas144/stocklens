/**
 * Ask StockLens: storage for conversations and the narrow, read-only tools the assistant may call.
 * Every tool returns stable ids (eventId, incident code, location id, camera id, session/track) so the answer can cite them,
 * and the server can verify each citation against what was actually retrieved.
 */
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Doc } from "./_generated/dataModel";
import { getLocation, now, requireOperator } from "./lib";
import { eventView } from "./agentData";

const OPEN = ["open", "investigating", "escalated"];
const iso = (ms: number) => new Date(ms).toISOString();

// ------------------------------------------------------------------ public: conversations
export const conversations = query({
  args: {},
  handler: async (ctx) => ctx.db.query("conversations").withIndex("by_updated").order("desc").take(30),
});

export const thread = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const conversation = await ctx.db.get(conversationId);
    if (!conversation) return null;
    const messages = await ctx.db.query("chatMessages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect();
    return { conversation, messages };
  },
});

export const startConversation = mutation({
  args: { operator: v.string(), context: v.optional(v.object({ kind: v.string(), ref: v.string(), label: v.string() })) },
  handler: async (ctx, { operator, context }) => {
    const op = requireOperator(operator);
    return ctx.db.insert("conversations", { title: context ? context.label : "New conversation", createdBy: op, context, createdAt: now(), updatedAt: now() });
  },
});

export const renameConversation = mutation({
  args: { conversationId: v.id("conversations"), title: v.string() },
  handler: async (ctx, { conversationId, title }) => ctx.db.patch(conversationId, { title: title.slice(0, 80) }),
});

// ------------------------------------------------------------------ internal: message lifecycle
export const addUserAndPlaceholder = internalMutation({
  args: { conversationId: v.id("conversations"), author: v.string(), text: v.string() },
  handler: async (ctx, { conversationId, author, text }) => {
    const conv = await ctx.db.get(conversationId);
    if (!conv) throw new Error("conversation not found");
    const prior = await ctx.db.query("chatMessages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect();
    if (prior.some((m) => m.status === "thinking")) throw new Error("StockLens is still answering the previous question");
    // public demo: cap Claude spend per conversation and across the whole site (checked inside this transaction)
    const perConv = Number(process.env.AI_MAX_PER_CONVERSATION ?? 20), perHour = Number(process.env.AI_MAX_PER_HOUR ?? 60);
    if (prior.filter((m) => m.role === "user").length >= perConv) throw new Error(`This conversation reached its ${perConv}-question limit. Start a new one with "New".`);
    const recent = await ctx.db.query("chatMessages").withIndex("by_creation_time", (q) => q.gt("_creationTime", now() - 3600_000)).collect();
    if (recent.filter((m) => m.role === "user").length >= perHour) throw new Error("StockLens has answered a lot of questions in the last hour on this demo. Please try again in a few minutes.");
    await ctx.db.insert("chatMessages", { conversationId, role: "user", author, text, status: "done", steps: [], refs: [], createdAt: now() });
    const id = await ctx.db.insert("chatMessages", { conversationId, role: "assistant", author: "StockLens", text: "", status: "thinking", progress: "Reading the question", steps: [], refs: [], createdAt: now() + 1 });
    await ctx.db.patch(conversationId, { updatedAt: now(), ...(prior.length === 0 && !conv.context ? { title: text.slice(0, 70) } : {}) });
    // citations already verified earlier in this conversation stay citable in follow-ups ("show me the footage")
    const knownRefs = [...new Set(prior.flatMap((m) => m.refs.map((r) => r.key)))];
    return { assistantId: id, history: prior.filter((m) => m.status === "done").slice(-16).map((m) => ({ role: m.role, text: m.text })), context: conv.context ?? null, knownRefs };
  },
});

export const progress = internalMutation({
  args: { id: v.id("chatMessages"), progress: v.string(), step: v.optional(v.object({ tool: v.string(), input: v.any(), summary: v.string() })) },
  handler: async (ctx, { id, progress, step }) => {
    const m = await ctx.db.get(id);
    if (!m) return;
    await ctx.db.patch(id, { progress, ...(step ? { steps: [...m.steps, step] } : {}) });
  },
});

export const finish = internalMutation({
  args: {
    id: v.id("chatMessages"), status: v.union(v.literal("done"), v.literal("error")), text: v.string(), model: v.optional(v.string()), error: v.optional(v.string()),
    refs: v.array(v.object({ key: v.string(), kind: v.string(), label: v.string(), href: v.optional(v.string()), videoUrl: v.optional(v.string()), t: v.optional(v.number()), imageUrl: v.optional(v.string()), cameraId: v.optional(v.string()) })),
    invalidRefs: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { id, ...rest }) => {
    await ctx.db.patch(id, { ...rest, progress: undefined });
    const m = await ctx.db.get(id);
    if (m) await ctx.db.patch(m.conversationId, { updatedAt: now() });
  },
});

// ------------------------------------------------------------------ internal: read-only tools
async function shelfView(ctx: any, l: Doc<"locations">) {
  const product = l.sku ? await ctx.db.query("products").withIndex("by_sku", (q: any) => q.eq("sku", l.sku)).unique() : null;
  const incidents = (await ctx.db.query("discrepancies").withIndex("by_location", (q: any) => q.eq("locationId", l.locationId)).collect()).filter((d: Doc<"discrepancies">) => OPEN.includes(d.status));
  return {
    locationId: l.locationId, name: l.name, camera: l.cameraId, assignedProduct: product ? { sku: product.sku, name: product.name } : null,
    recordedQuantity: l.state?.recorded ?? null, estimatedPhysicalQuantity: l.state?.estimate ?? null,
    estimateNote: l.state?.fullyVisible === false ? "shelf only partly visible: the camera verifies changes, not totals" : null,
    verifiedStart: l.verifiedQty ?? null, verifiedAt: l.verifiedAt ? iso(l.verifiedAt) : null, verifiedBy: l.verifiedBy ?? null,
    confirmedAdditions: l.state?.additions ?? 0, confirmedRemovals: l.state?.removals ?? 0, uncertainMovementsAwaitingReview: l.state?.uncertain ?? 0,
    difference: l.state?.difference ?? null, status: l.state?.status ?? "awaiting_footage",
    openIncidents: incidents.map((d: Doc<"discrepancies">) => ({ code: d.code, kind: d.kind, sku: d.sku ?? null })),
  };
}

async function resolveLocation(ctx: any, ref: string) {
  const byId = await getLocation(ctx, ref.toUpperCase());
  if (byId) return byId;
  const all = await ctx.db.query("locations").collect();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return all.find((l: Doc<"locations">) => norm(l.name) === norm(ref)) ?? null;
}

export const tShelves = internalQuery({
  args: {},
  handler: async (ctx) => {
    const locs = (await ctx.db.query("locations").collect()).filter((l) => l.type === "shelf");
    return Promise.all(locs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((l) => shelfView(ctx, l)));
  },
});

export const tLocation = internalQuery({
  args: { location: v.string() },
  handler: async (ctx, { location }) => {
    const l = await resolveLocation(ctx, location);
    if (!l) return { error: `no location called "${location}"` };
    const base = l.type === "shelf" ? await shelfView(ctx, l) : { locationId: l.locationId, name: l.name, type: l.type, camera: l.cameraId, direction: l.direction ?? null, state: l.state ?? null };
    const events = await ctx.db.query("movementEvents").withIndex("by_location_at", (q) => q.eq("locationId", l.locationId)).order("desc").take(25);
    const txns = await ctx.db.query("transactions").withIndex("by_location_at", (q) => q.eq("locationId", l.locationId)).order("desc").take(25);
    return { ...base, recentMovements: events.filter((e) => e.verification !== "superseded").map(eventView),
      recordedTransactions: txns.map((t) => ({ txnId: t._id, reference: t.txnId, type: t.type, sku: t.sku ?? null, quantity: t.quantity, at: iso(t.at), isSample: t.isSample })) };
  },
});

export const tProducts = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("products").collect()).map((p) => ({ sku: p.sku, name: p.name, category: p.category, belongsOn: p.expectedLocationId ?? null })),
});

export const tMovements = internalQuery({
  args: { locationId: v.optional(v.string()), cameraId: v.optional(v.string()), type: v.optional(v.string()), trackRef: v.optional(v.string()), sku: v.optional(v.string()),
          packageId: v.optional(v.string()), verification: v.optional(v.string()), unmatchedOnly: v.optional(v.boolean()), limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    let rows: Doc<"movementEvents">[];
    if (a.packageId) rows = await ctx.db.query("movementEvents").withIndex("by_package", (q) => q.eq("packageId", a.packageId)).collect();
    else if (a.locationId) {
      const l = await resolveLocation(ctx, a.locationId);
      rows = l ? await ctx.db.query("movementEvents").withIndex("by_location_at", (q) => q.eq("locationId", l.locationId)).collect() : [];
    } else if (a.cameraId) rows = await ctx.db.query("movementEvents").withIndex("by_camera_at", (q) => q.eq("cameraId", a.cameraId as string)).collect();
    else rows = await ctx.db.query("movementEvents").withIndex("by_at").order("desc").take(200);
    if (a.unmatchedOnly) {
      const ids = new Set((await ctx.db.query("discrepancies").collect()).filter((d) => OPEN.includes(d.status)).flatMap((d) => d.unmatchedEventIds as string[]));
      rows = rows.filter((e) => ids.has(e._id));
    }
    const out = rows.filter((e) => e.verification !== "superseded" && (!a.type || e.type === a.type) && (!a.sku || e.sku === a.sku)
      && (!a.trackRef || e.trackRef.toLowerCase() === a.trackRef.toLowerCase()) && (!a.verification || e.verification === a.verification))
      .sort((x, y) => y.at - x.at).slice(0, Math.min(a.limit ?? 20, 40));
    return { count: out.length, movements: out.map(eventView) };
  },
});

export const tIncidents = internalQuery({
  args: { status: v.optional(v.string()), kind: v.optional(v.string()) },
  handler: async (ctx, { status, kind }) => {
    const all = await ctx.db.query("discrepancies").collect();
    return all.filter((d) => (status === "all" ? true : status ? d.status === status : OPEN.includes(d.status)) && (!kind || d.kind === kind))
      .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || b.updatedAt - a.updatedAt)
      .map((d) => ({ code: d.code, kind: d.kind, location: d.locationId, camera: d.cameraId, sku: d.sku ?? null, expectedLocation: d.expectedLocationId ?? null,
        recorded: d.expectedQty, observed: d.observedQty, difference: d.difference, confidence: d.confidence, status: d.status, assignee: d.assignee ?? null,
        movementsWithoutTransaction: d.unmatchedEventIds.length, transactionsWithoutMovement: d.unmatchedTxnIds.length, awaitingReview: d.uncertainEventIds.length, opened: iso(d.createdAt) }));
  },
});

export const tCamera = internalQuery({
  args: { camera: v.string() },
  handler: async (ctx, { camera }) => {
    const all = await ctx.db.query("cameras").collect();
    const q = camera.toLowerCase().replace(/[^a-z0-9]/g, "");
    const slot = /^(cam|camera)?0?(\d)$/.exec(q)?.[2];
    const c = all.find((x) => x.cameraId === camera) ?? all.find((x) => slot && x.slot === Number(slot)) ?? all.find((x) => x.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(q) || (x.area ?? "").includes(q));
    if (!c) return { error: `no camera matching "${camera}"`, cameras: all.map((x) => ({ cameraId: x.cameraId, slot: x.slot ?? null, name: x.name, area: x.area ?? null })) };
    const session = await ctx.db.query("sessions").withIndex("by_camera", (q2) => q2.eq("cameraId", c.cameraId)).order("desc").first();
    const events = session ? (await ctx.db.query("movementEvents").withIndex("by_session", (q2) => q2.eq("sessionId", session.sessionId)).collect()).filter((e) => e.verification !== "superseded") : [];
    const tracks = session ? await ctx.db.query("tracks").withIndex("by_session", (q2) => q2.eq("sessionId", session.sessionId)).collect() : [];
    const locs = await ctx.db.query("locations").withIndex("by_camera", (q2) => q2.eq("cameraId", c.cameraId)).collect();
    return {
      cameraId: c.cameraId, slot: c.slot ?? null, name: c.name, area: c.area ?? null, where: c.warehouseLocation, profile: c.profile, source: c.source.kind === "rtsp" ? "live stream (not ingested)" : "recorded footage",
      recording: session ? { sessionId: session.sessionId, startedAt: iso(session.startedAt), durationSeconds: session.durationS ?? null, status: session.status } : null,
      monitors: locs.map((l) => ({ locationId: l.locationId, name: l.name, type: l.type })),
      trackedObjects: { packages: tracks.filter((t) => t.kind === "package").length, people: tracks.filter((t) => t.kind === "person").length,
        note: "tracking ids like 'Package 14' are scoped to this recording and are not product identities" },
      movements: events.map(eventView),
    };
  },
});

export const tTrack = internalQuery({
  args: { trackRef: v.string(), cameraId: v.optional(v.string()) },
  handler: async (ctx, { trackRef, cameraId }) => {
    const all = (await ctx.db.query("tracks").collect()).filter((t) => t.trackRef.toLowerCase() === trackRef.toLowerCase() && (!cameraId || t.cameraId === cameraId));
    if (!all.length) return { error: `no tracked object "${trackRef}"` };
    return {
      note: all.length > 1 ? `"${trackRef}" exists in ${all.length} different recordings; these are unrelated objects unless a verified package id links them` : "tracking ids are scoped to one recording",
      matches: await Promise.all(all.map(async (t) => {
        const evs = (await ctx.db.query("movementEvents").withIndex("by_session", (q) => q.eq("sessionId", t.sessionId)).collect()).filter((e) => e.trackRef === t.trackRef && e.verification !== "superseded");
        const step = Math.max(1, Math.floor(t.samples.length / 8));
        return { camera: t.cameraId, sessionId: t.sessionId, trackRef: t.trackRef, kind: t.kind, packageId: t.packageId ?? null, sku: t.sku ?? null,
          firstSeenSecond: t.firstSeenS, lastSeenSecond: t.lastSeenS, status: t.status, lossClass: t.lossClass ?? null, caveats: t.uncertainty,
          route: t.samples.filter((_, i) => i % step === 0).map((s) => ({ second: s.t, zone: s.zone })), movements: evs.map(eventView) };
      })),
    };
  },
});

export const tItemHistory = internalQuery({
  args: { sku: v.optional(v.string()), packageId: v.optional(v.string()) },
  handler: async (ctx, { sku, packageId }) => {
    if (!sku && !packageId) return { error: "give a sku or a packageId" };
    const evs = packageId ? await ctx.db.query("movementEvents").withIndex("by_package", (q) => q.eq("packageId", packageId)).collect()
      : (await ctx.db.query("movementEvents").withIndex("by_at").collect()).filter((e) => e.sku === sku);
    const sorted = evs.filter((e) => e.verification !== "superseded").sort((a, b) => a.at - b.at);
    return { identity: packageId ? { packageId } : { sku }, note: "only movements whose identity was verified (operator link, barcode, or product classification) appear here",
      movements: sorted.map(eventView), lastKnown: sorted.length ? { location: sorted[sorted.length - 1].locationId, at: iso(sorted[sorted.length - 1].at) } : null };
  },
});

/** Resolve citation keys to display data; returns only keys that exist. */
export const resolveRefs = internalQuery({
  args: { keys: v.array(v.string()) },
  handler: async (ctx, { keys }) => {
    const out = [];
    for (const key of keys) {
      const [kind, ...rest] = key.split(":");
      const ref = rest.join(":");
      if (kind === "ev") {
        const id = ctx.db.normalizeId("movementEvents", ref);
        const e = id ? await ctx.db.get(id) : null;
        if (e) {
          const loc = await getLocation(ctx, e.locationId);
          const what = e.type === "shelf_addition" ? "Added" : e.type === "shelf_removal" ? "Removed" : `${e.direction === "inbound" ? "Inbound" : "Outbound"}`;
          out.push({ key, kind: "event", label: `${what} · ${loc?.name ?? e.locationId} · ${new Date(e.at).toISOString().slice(11, 16)}`, videoUrl: e.evidence.videoUrl, t: e.t, imageUrl: e.evidence.imageUrl, cameraId: e.cameraId });
        }
      } else if (kind === "inc") {
        const d = await ctx.db.query("discrepancies").withIndex("by_code", (q) => q.eq("code", ref)).unique();
        if (d) out.push({ key, kind: "incident", label: d.code, href: `/investigations/${d.code}` });
      } else if (kind === "loc") {
        const l = await getLocation(ctx, ref);
        if (l) out.push({ key, kind: "location", label: l.name, href: l.type === "shelf" ? `/inventory?shelf=${l.locationId}` : "/inventory" });
      } else if (kind === "cam") {
        const c = await ctx.db.query("cameras").withIndex("by_cameraId", (q) => q.eq("cameraId", ref)).unique();
        if (c) out.push({ key, kind: "camera", label: c.slot && c.slot <= 4 ? `CAM 0${c.slot} · ${c.name}` : c.name, href: `/?cam=${c.cameraId}`, cameraId: c.cameraId });
      } else if (kind === "sku") {
        const p = await ctx.db.query("products").withIndex("by_sku", (q) => q.eq("sku", ref)).unique();
        if (p) out.push({ key, kind: "product", label: p.name, href: `/inventory` });
      }
    }
    return out;
  },
});
