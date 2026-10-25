import { MutationCtx, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";

export const now = () => Date.now();

/** Worker-to-Convex calls carry a shared secret configured with `npx convex env set INGEST_SECRET ...`. */
export function requireWorker(secret: string) {
  const expected = process.env.INGEST_SECRET;
  if (!expected) throw new Error("INGEST_SECRET is not configured on this deployment");
  if (secret !== expected) throw new Error("invalid worker secret");
}

/** Operator actions: this prototype has no login, so every action names its operator and is audited. */
export function requireOperator(operator: string) {
  const o = (operator || "").trim();
  if (o.length < 2 || o.length > 60) throw new Error("operator name required (2-60 characters)");
  return o;
}

export async function audit(ctx: MutationCtx, actor: string, action: string, entity: string, entityId: string, details?: unknown) {
  await ctx.db.insert("audit", { at: now(), actor, action, entity, entityId, details });
}

export async function nextCode(ctx: MutationCtx, name: string, start: number) {
  const row = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique();
  if (!row) {
    await ctx.db.insert("counters", { name, value: start });
    return start;
  }
  await ctx.db.patch(row._id, { value: row.value + 1 });
  return row.value + 1;
}

export async function getLocation(ctx: QueryCtx, locationId: string) {
  return await ctx.db.query("locations").withIndex("by_locationId", (q) => q.eq("locationId", locationId)).unique();
}

export async function addNote(ctx: MutationCtx, discrepancyId: Id<"discrepancies">, author: string, kind: string, body: string) {
  await ctx.db.insert("investigationNotes", { discrepancyId, author, kind, body, at: now() });
}

const fmtTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";

// ---------------------------------------------------------------------------------------------------------------------
// Deterministic reconciliation. Pure application code: Claude never computes or changes these numbers.
// ---------------------------------------------------------------------------------------------------------------------

type Unit = { txnId: Id<"transactions">; at: number; sku?: string; packageId?: string };

/** Greedy one-to-one matching of physical events to recorded transaction units: identity first, then nearest in time. */
function matchEvents(events: Doc<"movementEvents">[], txns: Doc<"transactions">[], toleranceMs: number) {
  const units: Unit[] = [];
  for (const t of txns) for (let i = 0; i < Math.max(1, Math.round(Math.abs(t.quantity))); i++) units.push({ txnId: t._id, at: t.at, sku: t.sku, packageId: t.packageId });
  // all candidate pairs within tolerance, best first: identity matches, then smallest time difference (globally greedy)
  const pairs: { e: number; u: number; id: boolean; d: number }[] = [];
  const sorted = [...events].sort((a, b) => a.at - b.at);
  sorted.forEach((e, ei) => units.forEach((u, ui) => {
    const d = Math.abs(u.at - e.at);
    if (d > toleranceMs) return;
    if (e.packageId && u.packageId && e.packageId !== u.packageId) return; // known different identities never match
    pairs.push({ e: ei, u: ui, id: !!(e.packageId && u.packageId), d });
  }));
  pairs.sort((x, y) => Number(y.id) - Number(x.id) || x.d - y.d);
  const used = new Set<number>(), usedE = new Set<number>();
  const matched = new Map<Id<"movementEvents">, Id<"transactions">>();
  for (const p of pairs) {
    if (used.has(p.u) || usedE.has(p.e)) continue;
    used.add(p.u); usedE.add(p.e);
    matched.set(sorted[p.e]._id, units[p.u].txnId);
  }
  const unmatchedEvents = sorted.filter((e) => !matched.has(e._id));
  const unmatchedTxnIds = [...new Set(units.filter((_, i) => !used.has(i)).map((u) => u.txnId))];
  return { matched, unmatchedEvents, unmatchedTxnIds };
}

async function upsertDiscrepancy(
  ctx: MutationCtx,
  fingerprint: string,
  needed: boolean,
  fields: Omit<Doc<"discrepancies">, "_id" | "_creationTime" | "code" | "fingerprint" | "active" | "status" | "createdAt" | "updatedAt" | "assignee" | "resolution" | "expectedLocationId"> & { expectedLocationId?: string },
) {
  const existing = await ctx.db.query("discrepancies").withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint).eq("active", true)).first();
  const t = now();
  if (!needed) {
    if (existing) {
      await ctx.db.patch(existing._id, { ...fields, active: false, status: "resolved", resolution: "Auto-closed: physical observations and records now agree.", updatedAt: t });
      await addNote(ctx, existing._id, "system", "system", "Reconciliation re-ran and the physical and recorded quantities now agree. Closed automatically.");
    }
    return null;
  }
  if (existing) {
    const changed = existing.observedQty !== fields.observedQty || existing.expectedQty !== fields.expectedQty ||
      existing.unmatchedEventIds.length !== fields.unmatchedEventIds.length || existing.unmatchedTxnIds.length !== fields.unmatchedTxnIds.length;
    if (!changed) {
      // same numbers, but a re-analysis may have replaced the events behind them: keep the evidence links current
      const key = (x: { supportingEventIds: string[]; unmatchedEventIds: string[]; uncertainEventIds: string[]; unmatchedTxnIds: string[] }) =>
        [x.supportingEventIds, x.unmatchedEventIds, x.uncertainEventIds, x.unmatchedTxnIds].map((l) => [...l].sort().join(",")).join("|");
      if (key(existing) !== key(fields)) {
        await ctx.db.patch(existing._id, { ...fields, updatedAt: t });
        await addNote(ctx, existing._id, "system", "system", "Evidence re-linked: the footage was re-analysed; the counts are unchanged.");
      }
      return existing._id;
    }
    const reopen = existing.status === "resolved" || existing.status === "dismissed";
    await ctx.db.patch(existing._id, { ...fields, updatedAt: t, ...(reopen ? { status: "open" as const } : {}) });
    await addNote(ctx, existing._id, "system", "system",
      `Reconciliation updated: records ${existing.expectedQty} -> ${fields.expectedQty}, observed ${existing.observedQty} -> ${fields.observedQty}.` + (reopen ? " Reopened because the numbers changed." : ""));
    return existing._id;
  }
  const code = `INC-${await nextCode(ctx, "incident", 101)}`;
  const id = await ctx.db.insert("discrepancies", { ...fields, code, fingerprint, active: true, status: "open", createdAt: t, updatedAt: t });
  await addNote(ctx, id, "system", "system", `Created by reconciliation: ${fields.summary}`);
  await audit(ctx, "system", "discrepancy.created", "discrepancy", code, { locationId: fields.locationId, difference: fields.difference });
  // hand the new discrepancy to the investigation agent (it records "not_configured" if no API key is set)
  await ctx.scheduler.runAfter(0, internal.agent.autoInvestigate, { discrepancyId: id });
  return id;
}

export async function reconcileLocation(ctx: MutationCtx, locationId: string) {
  const loc = await getLocation(ctx, locationId);
  if (!loc) return;
  if (loc.type === "shelf") await reconcileShelf(ctx, loc);
  else if (loc.type === "zone") await reconcileZone(ctx, loc);
  else await reconcileCheckpoint(ctx, loc);
}

/** Observation-only areas (aisles): no records to compare, just what passed through and when it was last seen. */
async function reconcileZone(ctx: MutationCtx, loc: Doc<"locations">) {
  const events = (await ctx.db.query("movementEvents").withIndex("by_location_at", (q) => q.eq("locationId", loc.locationId)).collect())
    .filter((e) => e.verification === "confirmed");
  const last = events.sort((a, b) => b.at - a.at)[0];
  await ctx.db.patch(loc._id, { state: { status: events.length ? "ok" : "no_footage", observed: events.length, lastSeenAt: last?.at ?? null, lastSeenTrack: last?.trackRef ?? null, reconciledAt: now() }, updatedAt: now() });
}

async function reconcileShelf(ctx: MutationCtx, loc: Doc<"locations">) {
  const since = loc.verifiedAt ?? 0;
  // Only footage that has actually been analysed can confirm or contradict a transaction.
  const covered = (await ctx.db.query("sessions").withIndex("by_camera", (q) => q.eq("cameraId", loc.cameraId)).collect())
    .filter((s) => s.status === "done" && s.durationS).map((s) => ({ from: s.startedAt, to: s.startedAt + (s.durationS as number) * 1000 }));
  const inCoverage = (at: number) => covered.some((w) => at >= w.from && at <= w.to);
  const events = await ctx.db.query("movementEvents").withIndex("by_location_at", (q) => q.eq("locationId", loc.locationId).gte("at", since)).collect();
  const confirmedAll = events.filter((e) => e.verification === "confirmed" && e.countsTowardReconciliation && e.type !== "checkpoint_crossing");
  // A movement whose product identity is known and is NOT the product assigned to this shelf is a placement problem, not stock.
  const foreign = (e: Doc<"movementEvents">) => !!(e.sku && loc.sku && e.sku !== loc.sku);
  const counted = confirmedAll.filter((e) => !foreign(e));
  await reconcileMisplaced(ctx, loc, confirmedAll.filter(foreign));
  const uncertain = events.filter((e) => e.verification === "uncertain");
  const additions = counted.filter((e) => e.type === "shelf_addition");
  const removals = counted.filter((e) => e.type === "shelf_removal");
  const add = additions.reduce((s, e) => s + e.quantity, 0);
  const rem = removals.reduce((s, e) => s + e.quantity, 0);
  const records = await ctx.db.query("inventoryRecords").withIndex("by_location", (q) => q.eq("locationId", loc.locationId)).collect();
  const recorded = records.reduce((s, r) => s + r.recordedQty, 0);
  const allTxns = await ctx.db.query("transactions").withIndex("by_location_at", (q) => q.eq("locationId", loc.locationId).gte("at", since)).collect();
  const tol = (loc.matchToleranceS ?? 900) * 1000;
  // movements recorded while no camera footage was analysed are reported as not covered, never as unmatched
  // approved corrections count from the moment their incident exists, whenever they were booked
  const sinceVerification = new Set((await ctx.db.query("discrepancies").withIndex("by_location", (q) => q.eq("locationId", loc.locationId).gte("createdAt", since)).collect()).map((d) => d.code));
  const corrTx = (await ctx.db.query("transactions").withIndex("by_location_at", (q) => q.eq("locationId", loc.locationId)).collect())
    .filter((t) => t.type === "adjustment" && sinceVerification.has(t.reference ?? ""));
  const txns = [...allTxns.filter((t) => !(t.type === "adjustment" && (t.reference ?? "").startsWith("INC-")) && inCoverage(t.at)), ...corrTx];
  const notCovered = allTxns.length - txns.length;
  // approved corrections (adjustments referencing an incident) explain unrecorded movements regardless of when they were booked
  const isCorrection = (t: Doc<"transactions">) => t.type === "adjustment" && (t.reference ?? "").startsWith("INC-");
  const outTx = txns.filter((t) => !isCorrection(t) && (t.type === "pick" || t.type === "outbound" || (t.type === "adjustment" && t.quantity < 0)));
  const inTx = txns.filter((t) => !isCorrection(t) && (t.type === "putaway" || t.type === "receipt" || t.type === "inbound" || (t.type === "adjustment" && t.quantity > 0)));
  const mOut = matchEvents(removals, outTx, tol);
  const mIn = matchEvents(additions, inTx, tol);
  const corrections = txns.filter(isCorrection);
  const explainedOut = corrections.filter((t) => t.quantity < 0).reduce((s, t) => s + Math.abs(t.quantity), 0);
  const explainedIn = corrections.filter((t) => t.quantity > 0).reduce((s, t) => s + t.quantity, 0);
  mOut.unmatchedEvents.splice(0, explainedOut);
  mIn.unmatchedEvents.splice(0, explainedIn);
  const unmatchedEvents = [...mOut.unmatchedEvents, ...mIn.unmatchedEvents];
  const unmatchedTxnIds = [...mOut.unmatchedTxnIds, ...mIn.unmatchedTxnIds];
  const verified = loc.verifiedQty !== undefined;
  const full = loc.fullyVisible !== false && verified;
  const estimate = full ? (loc.verifiedQty as number) + add - rem : null;
  // fully visible shelf: compare the estimate with the record. Partly visible: we cannot know the quantity, so compare the
  // observed net change with the recorded net change since verification instead (movements without matching transactions).
  const recordedNet = inTx.reduce((s, t) => s + Math.abs(t.quantity), 0) - outTx.reduce((s, t) => s + Math.abs(t.quantity), 0) + explainedIn - explainedOut;
  const expected = full ? recorded : recordedNet;
  const observed = full ? (estimate as number) : add - rem;
  const difference = observed - expected;
  const status: string = !verified ? "unverified" : difference !== 0 || unmatchedEvents.length ? "discrepancy" : full ? "ok" : "partial_ok";
  const state = {
    estimate, recorded, additions: add, removals: rem, uncertain: uncertain.length, difference, status, fullyVisible: full,
    recordedNet, observedNet: add - rem, unmatchedEvents: unmatchedEvents.length, unmatchedTxns: unmatchedTxnIds.length, reconciledAt: now(),
    footageSessions: covered.length, transactionsNotCovered: notCovered,
  };
  if (!covered.length) state.status = "awaiting_footage";
  await ctx.db.patch(loc._id, { state, updatedAt: now() });
  if (!verified || !covered.length) return;
  const needed = difference !== 0 || unmatchedEvents.length > 0;
  const sku = records[0]?.sku ?? loc.sku;
  const fmtEv = (e: Doc<"movementEvents">) => `${e.type === "shelf_removal" ? "removal" : "addition"} at ${fmtTime(e.at)}`;
  const summary = full
    ? `${loc.name}: records show ${recorded}, cameras support ${estimate} (verified ${loc.verifiedQty} + ${add} added - ${rem} removed). Difference ${difference > 0 ? "+" : ""}${difference}.` +
      (unmatchedEvents.length ? ` Movements without a matching transaction: ${unmatchedEvents.map(fmtEv).join(", ")}.` : "") +
      (uncertain.length ? ` ${uncertain.length} uncertain movement(s) await review and are not counted.` : "")
    : `${loc.name} is only partly visible, so its quantity cannot be estimated. Observed net change ${add - rem}, recorded net change ${recordedNet}.` +
      (unmatchedEvents.length ? ` Unmatched: ${unmatchedEvents.map(fmtEv).join(", ")}.` : "");
  await upsertDiscrepancy(ctx, `${loc.locationId}|shelf`, needed, {
    kind: "shelf_quantity", locationId: loc.locationId, cameraId: loc.cameraId, sku, expectedQty: expected, observedQty: observed, difference,
    window: { from: since, to: now() }, supportingEventIds: counted.map((e) => e._id), unmatchedEventIds: unmatchedEvents.map((e) => e._id),
    unmatchedTxnIds, uncertainEventIds: uncertain.map((e) => e._id),
    confidence: uncertain.length ? "medium" : counted.some((e) => (e.confidence ?? 1) < 0.3) ? "medium" : "high", summary, sessionId: undefined,
  });
}

async function reconcileMisplaced(ctx: MutationCtx, loc: Doc<"locations">, events: Doc<"movementEvents">[]) {
  const skus = new Set(events.map((e) => e.sku as string));
  // also revisit skus that had an open misplacement here before (they may have been removed / re-identified since)
  const open = (await ctx.db.query("discrepancies").withIndex("by_location", (q) => q.eq("locationId", loc.locationId)).collect())
    .filter((d) => d.kind === "misplaced_item" && d.active && d.sku);
  for (const d of open) skus.add(d.sku as string);
  const assigned = loc.sku ? await ctx.db.query("products").withIndex("by_sku", (q) => q.eq("sku", loc.sku as string)).unique() : null;
  for (const sku of skus) {
    const evs = events.filter((e) => e.sku === sku);
    const added = evs.filter((e) => e.type === "shelf_addition").reduce((n, e) => n + e.quantity, 0);
    const removed = evs.filter((e) => e.type === "shelf_removal").reduce((n, e) => n + e.quantity, 0);
    const present = Math.max(0, added - removed);
    const product = await ctx.db.query("products").withIndex("by_sku", (q) => q.eq("sku", sku)).unique();
    const expectedLoc = product?.expectedLocationId ? await getLocation(ctx, product.expectedLocationId) : null;
    const strong = evs.every((e) => e.identitySource === "operator" || e.identitySource === "barcode");
    const name = product?.name ?? sku;
    const summary = `${name} observed on ${loc.name}${assigned ? ` (assigned: ${assigned.name})` : ""}. Expected: ${expectedLoc?.name ?? "unknown location"}.` +
      (strong ? "" : " Product identity comes from visual classification only and needs confirmation.");
    const times = evs.map((e) => e.at);
    await upsertDiscrepancy(ctx, `${loc.locationId}|misplaced|${sku}`, present > 0, {
      kind: "misplaced_item", locationId: loc.locationId, cameraId: loc.cameraId, sku, expectedLocationId: product?.expectedLocationId,
      expectedQty: 0, observedQty: present, difference: present, window: { from: Math.min(...times, now()), to: Math.max(...times, 0) || now() },
      supportingEventIds: evs.map((e) => e._id), unmatchedEventIds: [], unmatchedTxnIds: [], uncertainEventIds: [],
      confidence: strong ? "high" : "medium", summary, sessionId: undefined,
    });
  }
}

async function reconcileCheckpoint(ctx: MutationCtx, loc: Doc<"locations">) {
  const sessions = await ctx.db.query("sessions").withIndex("by_camera", (q) => q.eq("cameraId", loc.cameraId)).collect();
  const tol = (loc.matchToleranceS ?? 60) * 1000;
  const perSession = [];
  for (const s of sessions.filter((s) => s.status === "done" && s.durationS)) {
    const from = s.startedAt - tol, to = s.startedAt + (s.durationS as number) * 1000 + tol;
    const events = (await ctx.db.query("movementEvents").withIndex("by_location_at", (q) => q.eq("locationId", loc.locationId).gte("at", from).lte("at", to)).collect())
      .filter((e) => e.type === "checkpoint_crossing");
    const counted = events.filter((e) => e.verification === "confirmed" && e.countsTowardReconciliation && e.direction === loc.direction);
    const reverse = events.filter((e) => e.verification === "confirmed" && e.countsTowardReconciliation && e.direction !== loc.direction);
    const uncertain = events.filter((e) => e.verification === "uncertain");
    const want = loc.direction === "outbound" ? ["outbound", "pick"] : ["inbound", "receipt"];
    const txns = (await ctx.db.query("transactions").withIndex("by_location_at", (q) => q.eq("locationId", loc.locationId).gte("at", from).lte("at", to)).collect())
      .filter((t) => want.includes(t.type));
    const recorded = txns.reduce((s, t) => s + Math.abs(t.quantity), 0);
    const observed = counted.reduce((s, e) => s + e.quantity, 0);
    const m = matchEvents(counted, txns, tol);
    const difference = observed - recorded;
    perSession.push({ sessionId: s.sessionId, observed, recorded, difference, reverse: reverse.length, uncertain: uncertain.length, unmatchedEvents: m.unmatchedEvents.length, unmatchedTxns: m.unmatchedTxnIds.length, from, to });
    const needed = difference !== 0 || m.unmatchedEvents.length > 0 || m.unmatchedTxnIds.length > 0;
    const dir = loc.direction ?? "outbound";
    const summary = `${loc.name}, session ${s.sessionId}: cameras counted ${observed} confirmed ${dir} package(s), records show ${recorded}. ` +
      (m.unmatchedEvents.length ? `${m.unmatchedEvents.length} observed movement(s) have no matching ${dir} transaction (${m.unmatchedEvents.map((e) => `${e.trackRef} at ${fmtTime(e.at)}`).join(", ")}). ` : "") +
      (m.unmatchedTxnIds.length ? `${m.unmatchedTxnIds.length} recorded transaction(s) have no observed movement. ` : "") +
      (reverse.length ? `${reverse.length} movement(s) went against the counting direction and are reported separately. ` : "") +
      (uncertain.length ? `${uncertain.length} uncertain crossing(s) await review and are not counted.` : "");
    await upsertDiscrepancy(ctx, `${loc.locationId}|${s.sessionId}`, needed, {
      kind: "checkpoint_count", locationId: loc.locationId, cameraId: loc.cameraId, sessionId: s.sessionId, sku: loc.sku, expectedQty: recorded, observedQty: observed,
      difference, window: { from, to }, supportingEventIds: counted.map((e) => e._id), unmatchedEventIds: m.unmatchedEvents.map((e) => e._id),
      unmatchedTxnIds: m.unmatchedTxnIds, uncertainEventIds: uncertain.map((e) => e._id),
      confidence: uncertain.length ? "medium" : "high", summary: summary.trim(),
    });
  }
  const totals = perSession.reduce((a, p) => ({ observed: a.observed + p.observed, recorded: a.recorded + p.recorded, unmatchedEvents: a.unmatchedEvents + p.unmatchedEvents, unmatchedTxns: a.unmatchedTxns + p.unmatchedTxns, reverse: a.reverse + p.reverse, uncertain: a.uncertain + p.uncertain }),
    { observed: 0, recorded: 0, unmatchedEvents: 0, unmatchedTxns: 0, reverse: 0, uncertain: 0 });
  const status = perSession.length === 0 ? "no_footage" : totals.unmatchedEvents || totals.unmatchedTxns || totals.observed !== totals.recorded ? "discrepancy" : "ok";
  await ctx.db.patch(loc._id, { state: { ...totals, difference: totals.observed - totals.recorded, status, sessions: perSession, reconciledAt: now() }, updatedAt: now() });
}
