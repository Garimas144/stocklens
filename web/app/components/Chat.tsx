"use client";
import Link from "next/link";
import { Fragment, useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useOperator } from "../providers";

export type Ref = Doc<"chatMessages">["refs"][number];

export const SUGGEST: Record<string, string[]> = {
  general: ["What should I investigate first?", "Which shelves currently have mismatched inventory?", "Has anything been placed on the wrong shelf?", "Did any packages move without a matching inventory transaction?"],
  incident: ["Explain this incident.", "What did the cameras observe?", "Show me the evidence.", "What should I do next?"],
  shelf: ["How many units are on this shelf, and does it match the records?", "Show me the last movements involving this shelf.", "What product belongs here?", "Is anything misplaced here?"],
  camera: ["What did this camera observe?", "Were any movements uncertain?", "Which inventory locations does it cover?", "Show me the footage of each movement."],
  track: ["What happened to this item?", "Is this movement recorded in inventory?", "Where was it last seen?", "Show me the footage."],
  event: ["What happened in this movement?", "Is it recorded in the inventory system?", "Where was this package observed afterward?", "Show me the footage."],
};

export function Sparkle({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M8 1.8 9.3 6.7 14.2 8 9.3 9.3 8 14.2 6.7 9.3 1.8 8 6.7 6.7Z" /><path d="M13 1.8v2.4M11.8 3h2.4" strokeLinecap="round" /></svg>;
}

/** Minimal, safe rendering: paragraphs, "- " bullets, **bold**, and evidence markers turned into chips. */
export function Answer({ text, refs, onClip }: { text: string; refs: Ref[]; onClip: (r: Ref) => void }) {
  const byKey = new Map(refs.map((r) => [r.key, r]));
  const inline = (s: string, k: string) => s.split(/(\[\[[a-z]+:[^\]]+\]\]|\*\*[^*]+\*\*)/g).map((part, i) => {
    const m = /^\[\[([a-z]+):([^\]]+)\]\]$/.exec(part);
    if (m) {
      const r = byKey.get(`${m[1]}:${m[2]}`);
      if (!r) return null;
      return r.kind === "event"
        ? <button key={k + i} className="ref clip" onClick={() => onClip(r)} title="Play this moment"><span>▶</span>{r.label}</button>
        : <Link key={k + i} className="ref" href={r.href ?? "#"}>{r.label}</Link>;
    }
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={k + i}>{part.slice(2, -2)}</strong>;
    return <Fragment key={k + i}>{part}</Fragment>;
  });
  // group consecutive "- " lines into lists and everything else into paragraphs
  const out: React.ReactNode[] = [];
  let list: string[] = [], para: string[] = [];
  const flush = (k: number) => {
    if (list.length) { out.push(<ul key={`u${k}`}>{list.map((l, i) => <li key={i}>{inline(l, `u${k}-${i}-`)}</li>)}</ul>); list = []; }
    if (para.length) { out.push(<p key={`p${k}`}>{para.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{inline(l, `p${k}-${i}-`)}</Fragment>)}</p>); para = []; }
  };
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) { flush(i); return; }
    if (/^\s*[-*] /.test(line)) { if (para.length) flush(i); list.push(line.replace(/^\s*[-*] /, "")); }
    else { if (list.length) flush(i); para.push(line); }
  });
  flush(-1);
  return <div className="answer">{out}</div>;
}


export type ChatContext = { kind: string; ref: string; label: string };

/**
 * One conversation with StockLens: thread, live progress, suggestions and composer. Used by the full Ask page and by the
 * surveillance side panel, so both share the same Convex conversations and Claude integration.
 */
export function ChatThread({ convId, onConversation, pendingContext, onClip, compact }: {
  convId: Id<"conversations"> | null; onConversation: (id: Id<"conversations">) => void; pendingContext?: ChatContext | null;
  onClip: (r: Ref) => void; compact?: boolean;
}) {
  const { operator } = useOperator();
  const start = useMutation(api.assistantData.startConversation);
  const send = useAction(api.assistant.send);
  const thread = useQuery(api.assistantData.thread, convId ? { conversationId: convId } : "skip");
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [thread?.messages.length, thread?.messages.at(-1)?.status]);
  const messages = thread?.messages ?? [];
  const busy = messages.some((m) => m.status === "thinking");
  const ctx = thread?.conversation.context ?? pendingContext ?? null;
  const kind = ctx?.kind ?? "general";
  const submit = async (q: string) => {
    const text = q.trim();
    if (!text || busy) return;
    setErr(null);
    if (!operator) { setErr("Enter your operator name first; it is recorded with every question."); return; }
    let id = convId;
    if (!id) { id = await start({ operator, context: pendingContext ?? undefined }); onConversation(id); }
    setDraft("");
    try { await send({ conversationId: id, text, operator }); }
    catch (e) { setErr(e instanceof Error ? e.message.replace(/[\s\S]*Uncaught Error:\s*/, "").split("\n")[0] : String(e)); }
  };
  return (
    <section className={`ask-main ${compact ? "compact" : ""}`}>
      {ctx && <div className="ask-ctx"><Sparkle size={13} /> Asking about {ctx.kind === "track" ? "tracked object" : ctx.kind} <b>{ctx.label}</b></div>}
      <div className="ask-thread">
        {messages.length === 0 && (
          <div className="ask-empty">
            <div className="ask-mark"><Sparkle size={22} /></div>
            <h1>Ask StockLens</h1>
            <p className="muted">Answers come from what your cameras recorded and what your inventory records say, with the evidence linked.</p>
            <div className="ask-sugg">{(SUGGEST[kind] ?? SUGGEST.general).map((s) => <button key={s} className="ghost" onClick={() => submit(s)}>{s}</button>)}</div>
          </div>
        )}
        {messages.map((m) => m.role === "user" ? (
          <div key={m._id} className="msg-user"><div>{m.text}</div></div>
        ) : (
          <div key={m._id} className="msg-ai">
            <div className="who"><Sparkle size={13} /> StockLens</div>
            {m.status === "thinking" && <div className="thinking"><span className="pulse" />{m.progress ?? "Thinking"}…{m.steps.length > 0 && <span className="faint"> · {m.steps.length} lookup{m.steps.length > 1 ? "s" : ""}</span>}</div>}
            {m.status === "error" && <div className="err">{m.error}</div>}
            {m.status === "done" && <Answer text={m.text} refs={m.refs} onClip={onClip} />}
            {m.status === "done" && m.steps.length > 0 && (
              <details className="more steps"><summary>Checked {m.steps.length} record set{m.steps.length > 1 ? "s" : ""}{m.invalidRefs?.length ? ` · ${m.invalidRefs.length} unsupported citation${m.invalidRefs.length > 1 ? "s" : ""} removed` : ""}</summary>
                {m.steps.map((s, i) => <details key={i}><summary className="mono">{s.tool}({Object.entries(s.input ?? {}).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")})</summary><pre>{s.summary}</pre></details>)}
                <div className="tiny faint" style={{ marginTop: 6 }}>{m.model} · read-only tools · Convex</div>
              </details>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="ask-compose">
        {err && <div className="err" style={{ marginBottom: 8 }}>{err}</div>}
        {messages.length > 0 && !busy && <div className="ask-sugg small-sugg">{(SUGGEST[kind] ?? SUGGEST.general).slice(0, compact ? 2 : 3).map((s) => <button key={s} className="quiet" onClick={() => submit(s)}>{s}</button>)}</div>}
        <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(draft); }}>
          <textarea rows={1} value={draft} placeholder={busy ? "StockLens is answering…" : "Ask about shelves, items, movements or incidents"} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(draft); } }} />
          <button type="submit" disabled={busy || !draft.trim()} aria-label="Send">↑</button>
        </form>
        {!compact && <div className="tiny faint" style={{ textAlign: "center", marginTop: 8 }}>Answers cite stored records. StockLens is read-only and cannot change inventory.</div>}
        {compact && convId && <div className="tiny" style={{ marginTop: 8 }}><Link href={`/ask?c=${convId}`} className="muted">Open full conversation →</Link></div>}
      </div>
    </section>
  );
}
