"use client";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ago, eventLabel } from "@/lib/format";
import { useNames } from "@/lib/names";
import { Diff, Metric, Sample, Status } from "../../components/ui";
import IncidentRow from "../../components/Incident";

export default function Dashboard() {
  const inv = useQuery(api.ui.inventory);
  const net = useQuery(api.ui.network);
  const issues = useQuery(api.ui.discrepancies, { status: "active" });
  const recent = useQuery(api.ui.overview);
  const names = useNames();
  if (!inv || !net || !issues || !recent) return <div className="empty">Loading…</div>;
  const matching = inv.shelves.filter((s) => s.state?.status === "ok" || s.state?.status === "partial_ok").length;
  const grid = net.filter((c) => (c.slot ?? 99) <= 4);
  const online = grid.filter((c) => c.session?.status === "done").length;
  const misplaced = issues.filter((d) => d.kind === "misplaced_item").length;
  return (
    <>
      <div className="ph">
        <div>
          <div className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div>
          <h1>Inventory health</h1>
          <p>What your cameras observed, compared with what your inventory records say.</p>
        </div>
        {inv.sample && <Sample />}
      </div>

      <div className="grid c4">
        <Metric v={<>{matching}<span className="faint" style={{ fontSize: 18 }}> / {inv.shelves.length}</span></>} l="Shelves matching records" d={<Link href="/inventory">View inventory →</Link>} />
        <Metric v={issues.length} l="Open issues" d={misplaced ? `${misplaced} misplaced item${misplaced > 1 ? "s" : ""}` : "No misplaced items"} />
        <Metric v={recent.movementTotals.confirmed} l="Confirmed movements" d={`${recent.movementTotals.uncertain} awaiting review · current footage`} />
        <Metric v={<>{online}<span className="faint" style={{ fontSize: 18 }}> / 4</span></>} l="Cameras with analysed footage" d={<Link href="/">Open surveillance →</Link>} />
      </div>

      <div className="panel gap-l">
        <div className="hd"><h2>Priority issues</h2><Link className="small muted" href="/investigations">All investigations →</Link></div>
        <div className="bd list">
          {issues.length === 0 ? <div className="empty">Everything the cameras saw matches your records.</div> : issues.slice(0, 6).map((d) => <IncidentRow key={d._id} d={d} names={names} />)}
        </div>
      </div>

      <div className="sec gap-l"><h2>Shelves</h2><Link className="small muted" href="/inventory">Inventory →</Link></div>
      <div className="grid c3">
        {inv.shelves.map((s) => (
          <Link key={s._id} href={`/inventory?shelf=${s.locationId}`} className="panel shelf">
            <div className="between"><span className="name">{s.name}</span><Status s={s.state?.status ?? "awaiting_footage"} /></div>
            <div className="prod">{s.product?.name ?? "Unassigned"}</div>
            <div className="qty">
              <div><div className="v">{s.state?.recorded ?? "—"}</div><div className="l">Recorded</div></div>
              {s.state && s.state.estimate == null && s.state.observedNet != null
                ? <div><div className="v">{s.state.observedNet > 0 ? "+" : ""}{s.state.observedNet}</div><div className="l">Change seen (partial view)</div></div>
                : <div><div className="v">{s.state?.estimate ?? "—"}</div><div className="l">Physical est.</div></div>}
              <div><div className="v"><Diff n={s.state?.difference} /></div><div className="l">Difference</div></div>
            </div>
            {s.misplaced.length > 0 && <div className="small neg">{s.misplaced.length} misplaced item{s.misplaced.length > 1 ? "s" : ""} on this shelf</div>}
          </Link>
        ))}
      </div>

      <div className="panel gap-l">
        <div className="hd"><h2>Latest observed movements</h2><Link className="small muted" href="/search">Movement log →</Link></div>
        <div className="bd list">
          {recent.recentEvents.length === 0 ? <div className="empty">No movements observed yet.</div> : recent.recentEvents.slice(0, 6).map((e) => (
            <div key={e._id} className="item">
              {e.evidence.imageUrl ? <img className="thumb" src={e.evidence.imageUrl} alt="" /> : <div className="thumb" />}
              <div style={{ flex: 1 }}>
                <div className="t">{eventLabel(e)} <span className="muted" style={{ fontWeight: 400 }}>· {names.loc(e.locationId)}</span></div>
                <div className="s">{e.trackRef}{e.sku ? ` · ${names.prod(e.sku)}` : " · unidentified item"}</div>
              </div>
              <div style={{ textAlign: "right" }}><Status s={e.verification} /><div className="tiny faint">{ago(e.ingestedAt)}</div></div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
