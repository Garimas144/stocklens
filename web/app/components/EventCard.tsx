"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
import { eventLabel, fmtClock, fmtTime } from "@/lib/format";
import { Err, Tag, useAct } from "./ui";
import { useOperator } from "../providers";

export default function EventCard({ e, onPlay, unmatched, review = true, place }: {
  e: Doc<"movementEvents">; onPlay?: (e: Doc<"movementEvents">) => void; unmatched?: boolean; review?: boolean; place?: string;
}) {
  const reviewEvent = useMutation(api.ops.reviewEvent);
  const { operator } = useOperator();
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const act = useAct();
  return (
    <div className="item">
      {e.evidence.imageUrl ? <a href={e.evidence.imageUrl} target="_blank" rel="noreferrer"><img className="thumb" src={e.evidence.imageUrl} alt="evidence frame" /></a> : <div className="thumb" />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="between">
          <div className="t">{eventLabel(e)} <span className="muted" style={{ fontWeight: 400 }}>· {place ?? e.locationId}</span></div>
          <span className="mono faint">{fmtTime(e.at)}</span>
        </div>
        <div className="row" style={{ marginTop: 6, gap: 6 }}>
          {e.verification === "uncertain" && <Tag tone="amber">Needs review</Tag>}
          {e.verification === "rejected" && <Tag>Rejected</Tag>}
          {unmatched && <Tag tone="red">Not in records</Tag>}
          {e.sku && <Tag tone="blue">{e.sku}{e.identitySource ? ` · ${e.identitySource === "operator" ? "verified" : "visual"}` : ""}</Tag>}
          {!e.countsTowardReconciliation && e.verification === "confirmed" && <Tag>Not counted</Tag>}
          <span className="tiny faint">{e.trackRef}{e.actor ? ` · ${e.actor} nearby` : ""}</span>
        </div>
        <details className="more" style={{ marginTop: 4 }}>
          <summary>Why the system believes this</summary>
          <ul className="small" style={{ margin: "4px 0 6px", paddingLeft: 18, color: "var(--ink-2)" }}>{e.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          {e.countingNote && <div className="tiny muted">{e.countingNote}</div>}
          <div className="tiny faint mono">{e.cameraId} · {e.sessionId} · video {fmtClock(e.t)}{e.confidence != null ? ` · conf ${e.confidence.toFixed(2)}` : ""}</div>
        </details>
        <div className="row" style={{ marginTop: 6 }}>
          {onPlay && e.evidence.videoUrl && <button className="ghost" onClick={() => onPlay(e)}>▶ Play at {fmtClock(e.t)}</button>}
          <Link className="quiet small" href={`/?cam=${e.cameraId}&t=${Math.max(0, e.t - 0.8).toFixed(1)}`} style={{ color: "var(--accent)" }}>Open in surveillance →</Link>
          {review && (e.verification === "uncertain" || e.verification === "confirmed") && !open &&
            <button className="quiet" onClick={() => setOpen(true)}>{e.verification === "uncertain" ? "Review" : "Overrule"}</button>}
        </div>
        {open && (
          <div className="stack" style={{ marginTop: 10 }}>
            <textarea placeholder="What does the footage show? Recorded in the audit trail." value={note} onChange={(x) => setNote(x.target.value)} />
            <div className="row">
              {e.verification === "uncertain" && <button className="ok" disabled={act.busy} onClick={() => act.run(() => reviewEvent({ operator, eventId: e._id, decision: "confirm", note })).then((ok) => ok && setOpen(false))}>Confirm movement</button>}
              <button className="bad" disabled={act.busy} onClick={() => act.run(() => reviewEvent({ operator, eventId: e._id, decision: "reject", note })).then((ok) => ok && setOpen(false))}>Not a real movement</button>
              <button className="quiet" onClick={() => setOpen(false)}>Cancel</button>
            </div>
            <Err e={act.err} />
          </div>
        )}
      </div>
    </div>
  );
}
