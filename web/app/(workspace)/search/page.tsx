"use client";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { eventLabel, fmtTime, fmtClock } from "@/lib/format";
import { Status } from "../../components/ui";
import AskButton from "../../components/AskButton";

export default function Search() {
  const [f, setF] = useState({ cameraId: "", locationId: "", type: "", direction: "", verification: "", packageId: "", sku: "", trackRef: "", from: "", to: "" });
  const cams = useQuery(api.ui.cameras);
  const locs = useQuery(api.ui.locations, {});
  const args = Object.fromEntries(Object.entries({ ...f, from: f.from ? Date.parse(f.from) : undefined, to: f.to ? Date.parse(f.to) : undefined }).filter(([, v]) => v !== "" && v !== undefined));
  const rows = useQuery(api.ui.searchEvents, args);
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <div className="ph"><div><h1>Movement log</h1><p>Every physical movement the cameras recorded, searchable by camera, location, time, package id or SKU.</p></div></div>
      <div className="panel pad row" style={{ marginBottom: 16 }}>
        <select value={f.cameraId} onChange={set("cameraId")}><option value="">any camera</option>{cams?.map((c) => <option key={c._id} value={c.cameraId}>{c.name}</option>)}</select>
        <select value={f.locationId} onChange={set("locationId")}><option value="">any location</option>{locs?.map((l) => <option key={l._id} value={l.locationId}>{l.name}</option>)}</select>
        <select value={f.type} onChange={set("type")}><option value="">any type</option><option value="shelf_addition">shelf addition</option><option value="shelf_removal">shelf removal</option><option value="checkpoint_crossing">checkpoint crossing</option></select>
        <select value={f.direction} onChange={set("direction")}><option value="">any direction</option><option>inbound</option><option>outbound</option></select>
        <select value={f.verification} onChange={set("verification")}><option value="">any verification</option><option>confirmed</option><option>uncertain</option><option>rejected</option><option>superseded</option></select>
        <input placeholder="package id" value={f.packageId} onChange={set("packageId")} /><input placeholder="SKU" value={f.sku} onChange={set("sku")} /><input placeholder="track (e.g. Package 3)" value={f.trackRef} onChange={set("trackRef")} />
        <input type="datetime-local" value={f.from} onChange={set("from")} /><input type="datetime-local" value={f.to} onChange={set("to")} />
      </div>
      <div className="panel">
        {!rows ? <div className="empty">Searching...</div> : rows.length === 0 ? <div className="empty">No matching movements.</div> :
          <table className="tbl"><thead><tr><th>Evidence</th><th>Movement</th><th>Location</th><th>Camera / session</th><th>When</th><th>Verification</th></tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e._id}>
                <td>{e.evidence.imageUrl && <a href={e.evidence.imageUrl} target="_blank" rel="noreferrer"><img src={e.evidence.imageUrl} alt="" style={{ width: 90, borderRadius: 4 }} /></a>}</td>
                <td><b>{eventLabel(e)}</b> · {e.trackRef}{e.packageId && <> · <span className="tag blue">pkg {e.packageId}</span></>}{e.sku && <> · <span className="mono">{e.sku}</span></>}<div className="small muted">{e.reasons[0]}</div></td>
                <td>{e.locationId}</td><td className="small">{e.cameraId}<div className="muted mono">{e.sessionId}</div></td>
                <td className="small">{fmtTime(e.at)}<div className="muted">video {fmtClock(e.t)} {e.evidence.videoUrl && <a href={`${e.evidence.videoUrl}#t=${Math.max(0, e.t - 1)}`} target="_blank" rel="noreferrer">open clip</a>}</div></td>
                <td><Status s={e.verification} /><div style={{ marginTop: 6 }}><AskButton kind="event" id={e._id} label={`${eventLabel(e)} · ${e.locationId} · ${e.trackRef}`} text="Ask" /></div>{!e.countsTowardReconciliation && e.verification === "confirmed" && <div className="small muted">not counted</div>}</td>
              </tr>))}</tbody></table>}
      </div>
    </>
  );
}
