"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
import { eventLabel, fmtTime } from "@/lib/format";
import { useNames } from "@/lib/names";
import { Diff, Err, Player, Sample, Status, Tag, useAct } from "../../components/ui";
import EventCard from "../../components/EventCard";
import { useOperator } from "../../providers";
import AskButton from "../../components/AskButton";

function Inventory() {
  const params = useSearchParams();
  const inv = useQuery(api.ui.inventory);
  const names = useNames();
  const [sel, setSel] = useState<string | null>(params.get("shelf"));
  const [lookup, setLookup] = useState("");
  if (!inv) return <div className="empty">Loading…</div>;
  return (
    <>
      <div className="ph">
        <div><h1>Inventory</h1><p>Which product belongs on which shelf, what the records say, and what the cameras support.</p></div>
        {inv.sample && <Sample />}
      </div>

      <div className="panel">
        <table className="tbl">
          <thead><tr><th>Shelf</th><th>Assigned product</th><th>SKU</th><th className="r">Recorded</th><th className="r">Physical estimate</th><th className="r">Difference</th><th>Status</th></tr></thead>
          <tbody>{inv.shelves.map((s) => (
            <tr key={s._id} className="link" onClick={() => setSel(s.locationId === sel ? null : s.locationId)} style={s.locationId === sel ? { background: "var(--surface-2)" } : undefined}>
              <td><div style={{ fontWeight: 600 }}>{s.name}</div><div className="tiny faint">{s.cameraId}</div></td>
              <td>{s.product?.name ?? <span className="faint">Unassigned</span>}{s.misplaced.length > 0 && <div className="tiny neg">+ {s.misplaced.length} misplaced item{s.misplaced.length > 1 ? "s" : ""}</div>}</td>
              <td className="mono muted">{s.sku ?? "—"}</td>
              <td className="r">{s.state?.recorded ?? "—"}</td>
              <td className="r">{s.state?.estimate ?? <span className="faint" title="This shelf is only partly visible; the camera verifies changes, not totals">changes only</span>}</td>
              <td className="r"><Diff n={s.state?.difference} /></td>
              <td><Status s={s.state?.status ?? "awaiting_footage"} /></td>
            </tr>))}</tbody>
        </table>
      </div>

      {sel && <ShelfDetail locationId={sel} names={names} />}

      <div className="grid c2 gap-l">
        <div className="panel">
          <div className="hd"><h2>Flow points</h2><span className="small muted">Receiving, aisle and dispatch</span></div>
          <div className="bd list">
            {inv.flow.map((l) => (
              <div key={l._id} className="item">
                <div style={{ flex: 1 }}>
                  <div className="t">{l.name}</div>
                  <div className="s">{l.type === "zone" ? "Observation only (no records to compare)" : `${l.direction} · compared with ${l.direction === "inbound" ? "receipts" : "dispatch records"}`}</div>
                </div>
                <div className="r tnum small" style={{ width: 150, textAlign: "right" }}>
                  {l.type === "zone" ? <>{l.state?.observed ?? 0} observed{l.state?.lastSeenAt ? <div className="tiny faint">last {fmtTime(l.state.lastSeenAt)}</div> : null}</>
                    : <>{l.state?.observed ?? 0} observed · {l.state?.recorded ?? 0} recorded</>}
                </div>
                <div style={{ width: 120, textAlign: "right" }}>{l.incidents[0] ? <Link href={`/investigations/${l.incidents[0].code}`}><Status s="discrepancy" /></Link> : l.type === "zone" ? <Status s="info" label="Observed" /> : <Status s={l.state?.status ?? "no_footage"} />}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="hd"><h2>Find an item</h2><span className="small muted">By verified package id or SKU</span></div>
          <div className="pad stack">
            <div className="row"><input style={{ flex: 1 }} placeholder="e.g. SKU-UTN-08 or a package id" value={lookup} onChange={(e) => setLookup(e.target.value.trim())} /></div>
            <ItemHistory q={lookup} names={names} products={inv.products} />
          </div>
        </div>
      </div>

      <div className="panel gap-l">
        <div className="hd"><h2>Product catalogue</h2><span className="small muted">Where each product belongs</span></div>
        <div className="bd">
          <table className="tbl"><tbody>{inv.products.map((p) => (
            <tr key={p._id}><td style={{ fontWeight: 500 }}>{p.name}</td><td className="muted">{p.category}</td><td className="mono muted">{p.sku}</td><td>Belongs on <b>{names.loc(p.expectedLocationId)}</b></td></tr>
          ))}</tbody></table>
        </div>
      </div>
    </>
  );
}

function ItemHistory({ q, names, products }: { q: string; names: ReturnType<typeof useNames>; products: Doc<"products">[] }) {
  const isSku = products.some((p) => p.sku.toLowerCase() === q.toLowerCase());
  const sku = isSku ? products.find((p) => p.sku.toLowerCase() === q.toLowerCase())?.sku : undefined;
  const h = useQuery(api.ui.itemHistory, q.length >= 3 ? (isSku ? { sku } : { packageId: q }) : "skip");
  if (q.length < 3) return <div className="small muted">Only movements with a verified identity (operator link, barcode, or product classification) are joined across cameras. Anonymous tracks stay separate.</div>;
  if (!h) return <div className="small muted">Searching…</div>;
  if (!h.events.length) return <div className="small muted">No identified movements for “{q}”. If the item was only tracked anonymously, link its track to an id from the camera view first.</div>;
  return (
    <div className="stack">
      {h.lastKnown && <div className="callout">Last known: <b>{names.loc(h.lastKnown.locationId)}</b> · {fmtTime(h.lastKnown.at)} · {h.lastKnown.cameraId}</div>}
      <div className="tl">{h.events.map((e) => (
        <div key={e._id} className="e info"><div className="small" style={{ fontWeight: 500 }}>{eventLabel(e)} · {names.loc(e.locationId)}</div><div className="tiny faint">{fmtTime(e.at)} · {e.cameraId} · identity {e.identitySource ?? "anonymous"}</div></div>
      ))}</div>
    </div>
  );
}

function ShelfDetail({ locationId, names }: { locationId: string; names: ReturnType<typeof useNames> }) {
  const d = useQuery(api.ui.locationDetail, { locationId });
  const setVerified = useMutation(api.ops.setVerifiedCount);
  const { operator } = useOperator();
  const act = useAct();
  const [seek, setSeek] = useState<{ t: number; n: number }>();
  const [src, setSrc] = useState<string>();
  const [q, setQ] = useState("");
  if (!d) return <div className="empty">Loading shelf…</div>;
  const l = d.location, st = l.state;
  const play = (e: Doc<"movementEvents">) => { setSrc(e.evidence.videoUrl); setSeek({ t: e.t, n: Date.now() }); };
  const evs = d.events.filter((e) => e.verification !== "superseded");
  return (
    <div className="grid w-main gap-l">
      <div className="panel">
        <div className="hd"><h2>{l.name} · {names.prod(l.sku)}</h2><div className="row"><AskButton kind="shelf" id={l.locationId} label={`${l.name} · ${names.prod(l.sku)}`} text="Ask about this shelf" /><Status s={st?.status ?? "awaiting_footage"} /></div></div>
        <div className="pad stack">
          {st?.fullyVisible ? (
            <div className="qty" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
              <div><div className="v">{l.verifiedQty}</div><div className="l">Verified start</div></div>
              <div><div className="v">+{st.additions}</div><div className="l">Added</div></div>
              <div><div className="v">−{st.removals}</div><div className="l">Removed</div></div>
              <div><div className="v">{st.estimate}</div><div className="l">Physical est. (records {st.recorded})</div></div>
            </div>
          ) : <div className="callout">This shelf is only partly visible to its camera, so StockLens compares changes instead of totals: observed {st?.observedNet ?? 0}, recorded {st?.recordedNet ?? 0}.</div>}
          {st?.uncertain > 0 && <div className="callout warn">{st.uncertain} possible movement{st.uncertain > 1 ? "s" : ""} need review before they count.</div>}
          <div className="tiny muted">Verified start {l.verifiedAt ? `${fmtTime(l.verifiedAt)} · ${l.verifiedBy}` : "not set"}</div>
          <div className="list">{evs.length === 0 ? <div className="empty">No additions or removals observed.</div> : evs.map((e) => <EventCard key={e._id} e={e} onPlay={play} place={names.loc(e.locationId)} />)}</div>
          <details className="more">
            <summary>Recorded transactions and recount</summary>
            <table className="tbl"><tbody>{d.transactions.map((t) => <tr key={t._id}><td className="mono">{t.txnId}</td><td>{t.type}</td><td className="r">{t.quantity}</td><td className="muted small">{fmtTime(t.at)}</td><td>{t.isSample && <Tag>sample</Tag>}</td></tr>)}</tbody></table>
            {d.transactions.length === 0 && <div className="small muted" style={{ padding: "8px 0" }}>No transactions recorded at this shelf.</div>}
            <div className="row" style={{ marginTop: 10 }}>
              <input style={{ width: 90 }} type="number" min={0} placeholder="count" value={q} onChange={(e) => setQ(e.target.value)} />
              <button className="ghost" disabled={act.busy || q === ""} onClick={() => act.run(() => setVerified({ operator, locationId: l.locationId, quantity: Number(q), fullyVisible: !!l.fullyVisible, verifiedAt: d.sessions[0]?.startedAt ?? Date.now() }))}>Record verified count</button>
              <span className="tiny muted">as of the start of the latest footage</span>
            </div>
            <Err e={act.err} />
          </details>
        </div>
      </div>
      <div className="panel"><div className="hd"><h2>Footage</h2><span className="tag">Recorded</span></div><div className="pad"><div className="vid contain"><Player src={src ?? d.sessions[0]?.processedUrl} seek={seek} /></div></div></div>
    </div>
  );
}

export default function Page() { return <Suspense><Inventory /></Suspense>; }
