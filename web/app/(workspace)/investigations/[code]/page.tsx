"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
import { ago, eventLabel, fmtTime, kindLabel } from "@/lib/format";
import { useNames } from "@/lib/names";
import { Diff, Err, Player, Sample, Status, Tag, useAct } from "../../../components/ui";
import EventCard from "../../../components/EventCard";
import { headline } from "../../../components/Incident";
import { useOperator } from "../../../providers";
import AskButton from "../../../components/AskButton";

export default function Incident() {
  const { code } = useParams<{ code: string }>();
  const d = useQuery(api.ui.discrepancy, { code });
  const names = useNames();
  const { operator } = useOperator();
  const assign = useMutation(api.ops.assign), setStatus = useMutation(api.ops.setStatus), addNote = useMutation(api.ops.addInvestigationNote);
  const requestCorrection = useMutation(api.ops.requestCorrection), decide = useMutation(api.ops.decideCorrection);
  const investigate = useAction(api.agent.investigate);
  const wf = useAct(), corr = useAct(), ai = useAct();
  const [assignee, setAssignee] = useState(""), [note, setNote] = useState(""), [toQty, setToQty] = useState(""), [reason, setReason] = useState(""), [question, setQuestion] = useState("");
  const [seek, setSeek] = useState<{ t: number; n: number }>(), [src, setSrc] = useState<string>();
  if (d === undefined) return <div className="empty">Loading…</div>;
  if (d === null) return <div className="empty">No such incident.</div>;
  const x = d.discrepancy;
  const h = headline(x, names);
  const play = (e: Doc<"movementEvents">) => { setSrc(e.evidence.videoUrl); setSeek({ t: e.t, n: Date.now() }); };
  const unmatched = new Set(x.unmatchedEventIds);
  const pending = d.corrections.find((c) => c.status === "pending");
  const run = d.runs[0];
  const defaultQ = x.kind === "misplaced_item" ? `Why is ${names.prod(x.sku)} on ${names.loc(x.locationId)}, and what should we do?`
    : x.kind === "shelf_quantity" ? `Why does ${names.loc(x.locationId)} show ${x.expectedQty} in the records but ${x.observedQty} physically?`
    : `Why are ${Math.abs(x.difference)} movement(s) at ${names.loc(x.locationId)} missing from our records?`;
  const sample = d.records.some((r) => r.isSample) || d.transactions.some((t) => t.isSample);
  return (
    <>
      <div className="ph">
        <div>
          <div className="eyebrow"><Link href="/investigations">Investigations</Link> / <span className="mono">{x.code}</span></div>
          <h1>{h.title}</h1>
          <p style={{ color: "var(--ink-2)", fontSize: 15 }}>{h.line} {h.sub && <span className="muted">{h.sub}.</span>}</p>
        </div>
        <div className="row"><AskButton kind="incident" id={x.code} label={`${x.code} · ${h.title}`} text="Ask StockLens about this" /><Status s={x.status} />{x.assignee && <Tag>{x.assignee}</Tag>}{sample && <Sample />}</div>
      </div>

      <div className="grid w-main">
        <div className="stack" style={{ gap: 16 }}>
          <div className="panel" style={{ overflow: "hidden" }}>
            <div className="vid contain" style={{ borderRadius: 0 }}><Player src={src ?? d.sessions[0]?.processedUrl ?? d.supporting[0]?.evidence.videoUrl} seek={seek} /><span className="chip l rec">RECORDED</span></div>
            <div className="qty" style={{ borderRadius: 0, border: 0, borderTop: "1px solid var(--line)", gridTemplateColumns: "repeat(3, 1fr)" }}>
              <div><div className="v">{x.expectedQty}</div><div className="l">{x.kind === "misplaced_item" ? "Expected here" : "Recorded"}</div></div>
              <div><div className="v">{x.observedQty}</div><div className="l">{x.kind === "misplaced_item" ? "Observed here" : "Supported by cameras"}</div></div>
              <div><div className="v"><Diff n={x.difference} /></div><div className="l">{x.confidence === "high" ? "High confidence" : "Needs confirmation"}</div></div>
            </div>
          </div>

          <div className="panel">
            <div className="hd"><h2>What the cameras observed</h2><span className="small muted">{d.supporting.length} confirmed{d.uncertain.length ? ` · ${d.uncertain.length} awaiting review` : ""}</span></div>
            <div className="bd list">
              {d.supporting.length + d.uncertain.length === 0 && <div className="empty">No camera events in this window.</div>}
              {[...d.supporting, ...d.uncertain].map((e) => <EventCard key={e._id} e={e} onPlay={play} unmatched={unmatched.has(e._id)} place={names.loc(e.locationId)} />)}
            </div>
          </div>

          <div className="panel">
            <div className="hd"><h2>What the records say</h2><span className="small muted">{x.kind === "misplaced_item" ? `${names.prod(x.sku)} belongs on ${names.loc(x.expectedLocationId)}` : `${d.transactions.length} transaction${d.transactions.length === 1 ? "" : "s"} in the window`}</span></div>
            <div className="bd">
              {d.transactions.length === 0 ? <div className="empty">{x.kind === "misplaced_item" ? "Placement is checked against the product's assigned shelf." : "No matching transactions were recorded."}</div> :
                <table className="tbl"><tbody>{d.transactions.map((t) => <tr key={t._id}><td className="mono small">{t.txnId}</td><td>{t.type}</td><td className="r">{t.quantity}</td><td className="small muted">{fmtTime(t.at)}</td>
                  <td>{x.unmatchedTxnIds.includes(t._id) ? <Tag tone="red">No observed movement</Tag> : <Tag tone="green">Matched</Tag>}</td></tr>)}</tbody></table>}
            </div>
          </div>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <div className="panel">
            <div className="hd"><h2>AI investigation</h2><span className="tiny faint mono">{run?.model ?? "claude-opus-5-5"}</span></div>
            <div className="pad stack">
              {run?.status === "not_configured" && <div className="callout warn small">The Claude agent is not connected: set ANTHROPIC_API_KEY on the Convex deployment. Everything else here works without it.</div>}
              {run?.status === "error" && <div className="err">{run.error}</div>}
              {run?.status === "running" && <div className="small muted">Investigating… reading records through read-only tools.</div>}
              {run?.answer && <div className="ai">
                <div>{run.answer}</div>
                {!!run.facts?.length && <><div className="tiny muted" style={{ marginTop: 10 }}>Supported by records</div><ul>{run.facts.map((f, i) => <li key={i}>{f}</li>)}</ul></>}
                {!!run.hypotheses?.length && <><div className="tiny muted">Hypotheses, not proven</div><ul>{run.hypotheses.map((f, i) => <li key={i}>{f}</li>)}</ul></>}
                {!!run.missingEvidence?.length && <><div className="tiny muted">Missing or uncertain</div><ul>{run.missingEvidence.map((f, i) => <li key={i}>{f}</li>)}</ul></>}
                {run.recommendation && <div className="small" style={{ marginTop: 6 }}><b>Next step:</b> {run.recommendation}</div>}
                {!!run.citations?.length && <div className="tiny muted" style={{ marginTop: 8 }}>{run.citations.length} citations · {run.invalidCitations?.length ? <span className="neg">{run.invalidCitations.length} not found in retrieved records</span> : "all verified against retrieved records"}</div>}
              </div>}
              {run && run.steps.length > 0 && <details className="more steps"><summary>Agent tool calls ({run.steps.length})</summary>{run.steps.map((s, i) => <details key={i}><summary className="mono">{s.tool}</summary><pre>{s.output}</pre></details>)}</details>}
              <textarea value={question || defaultQ} onChange={(e) => setQuestion(e.target.value)} />
              <div className="row"><button disabled={ai.busy} onClick={() => ai.run(() => investigate({ discrepancyId: x._id, question: question || defaultQ, operator }))}>{ai.busy ? "Investigating…" : "Ask Claude"}</button><span className="tiny muted">Read-only. Cannot change inventory.</span></div>
              <Err e={ai.err} />
            </div>
          </div>

          <div className="panel">
            <div className="hd"><h2>Resolution</h2></div>
            <div className="pad stack">
              <div className="row"><input style={{ flex: 1 }} placeholder={x.assignee ? `Assigned to ${x.assignee}` : "Assign to…"} value={assignee} onChange={(e) => setAssignee(e.target.value)} /><button className="ghost" disabled={wf.busy} onClick={() => wf.run(() => assign({ operator, code: x.code, assignee })).then(() => setAssignee(""))}>Assign</button></div>
              <textarea placeholder="Note or reason for your decision" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="row">
                <button className="ok" disabled={wf.busy} onClick={() => wf.run(() => setStatus({ operator, code: x.code, status: "resolved", note })).then((ok) => ok && setNote(""))}>Resolve</button>
                <button className="ghost" disabled={wf.busy} onClick={() => wf.run(() => setStatus({ operator, code: x.code, status: "escalated", note }))}>Escalate</button>
                <button className="ghost" disabled={wf.busy} onClick={() => wf.run(() => setStatus({ operator, code: x.code, status: "investigating", note }))}>Mark investigating</button>
                <button className="quiet" disabled={wf.busy} onClick={() => wf.run(() => setStatus({ operator, code: x.code, status: "dismissed", note }))}>Dismiss</button>
                <button className="quiet" disabled={wf.busy || !note.trim()} onClick={() => wf.run(() => addNote({ operator, code: x.code, body: note })).then((ok) => ok && setNote(""))}>Add note</button>
              </div>
              <Err e={wf.err} />
              {x.kind === "shelf_quantity" && <details className="more" open={!!pending}>
                <summary>Correct the inventory record (needs a second approver)</summary>
                {pending ? <div className="callout">
                  <div><b>{pending.fromQty} → {pending.toQty}</b> requested by {pending.requestedBy}</div><div className="small muted">{pending.reason}</div>
                  <div className="row" style={{ marginTop: 10 }}><button className="ok" disabled={corr.busy} onClick={() => corr.run(() => decide({ operator, correctionId: pending._id, approve: true, note }))}>Approve</button><button className="ghost" disabled={corr.busy} onClick={() => corr.run(() => decide({ operator, correctionId: pending._id, approve: false, note }))}>Reject</button></div>
                </div> : <div className="row"><input style={{ width: 90 }} type="number" placeholder="New qty" value={toQty} onChange={(e) => setToQty(e.target.value)} /><input style={{ flex: 1 }} placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} /><button className="ghost" disabled={corr.busy} onClick={() => corr.run(() => requestCorrection({ operator, code: x.code, toQty: Number(toQty), reason }))}>Request</button></div>}
                <Err e={corr.err} />
              </details>}
            </div>
          </div>

          <div className="panel">
            <div className="hd"><h2>History</h2><span className="tiny muted">{kindLabel(x.kind)} · opened {ago(x.createdAt)}</span></div>
            <div className="pad tl">{[...d.notes].reverse().slice(0, 12).map((n) => (
              <div key={n._id} className={`e ${n.kind === "agent" ? "info" : n.kind === "status" ? "ok" : ""}`}><div className="small" style={{ whiteSpace: "pre-wrap" }}>{n.body.length > 280 ? n.body.slice(0, 280) + "…" : n.body}</div><div className="tiny faint">{n.author} · {ago(n.at)}</div></div>
            ))}</div>
          </div>
        </div>
      </div>
    </>
  );
}
