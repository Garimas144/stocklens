"use client";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useNames } from "@/lib/names";
import IncidentRow from "../../components/Incident";

const VIEWS = [["active", "Open"], ["misplaced", "Misplaced"], ["resolved", "Resolved"], ["", "All"]] as const;

export default function Investigations() {
  const [view, setView] = useState<string>("active");
  const all = useQuery(api.ui.discrepancies, { status: view === "misplaced" ? "active" : view || undefined });
  const names = useNames();
  const list = view === "misplaced" ? all?.filter((d) => d.kind === "misplaced_item") : all;
  return (
    <>
      <div className="ph">
        <div><h1>Investigations</h1><p>Inventory mismatches, unrecorded movements and misplaced items, each with its evidence and resolution workflow.</p></div>
        <div className="seg">{VIEWS.map(([k, l]) => <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{l}</button>)}</div>
      </div>
      <div className="panel"><div className="bd list">
        {!list ? <div className="empty">Loading…</div> : list.length === 0 ? <div className="empty">Nothing here.</div> : list.map((d) => <IncidentRow key={d._id} d={d} names={names} />)}
      </div></div>
    </>
  );
}
