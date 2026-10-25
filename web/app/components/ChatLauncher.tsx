"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Id } from "@/convex/_generated/dataModel";
import { ChatContext, ChatThread, Sparkle } from "./Chat";
import { useOperator } from "../providers";

/**
 * Ask StockLens as a chat bubble in the bottom-right corner of every workspace page. Same Convex conversations as the full
 * /ask page; "Ask StockLens" buttons on a page open it with that page's context. Evidence clips open the surveillance view.
 */
export default function ChatLauncher() {
  const path = usePathname();
  const router = useRouter();
  const { operator, setOperator } = useOperator();
  const [open, setOpen] = useState(false);
  const [convId, setConvId] = useState<Id<"conversations"> | null>(null);
  const [pending, setPending] = useState<ChatContext | null>(null);
  useEffect(() => {
    const h = (e: Event) => { setPending((e as CustomEvent<ChatContext>).detail); setConvId(null); setOpen(true); };
    window.addEventListener("stocklens:ask", h);
    return () => window.removeEventListener("stocklens:ask", h);
  }, []);
  if (path.startsWith("/ask")) return null;
  return (
    <>
      {open && (
        <div className="chatpop" role="dialog" aria-label="Ask StockLens">
          <div className="chatpop-hd">
            <span><Sparkle size={14} /> Ask StockLens</span>
            <span className="row" style={{ gap: 2 }}>
              <button className="quiet" onClick={() => { setConvId(null); setPending(null); }}>New</button>
              <Link className="quiet" href={convId ? `/ask?c=${convId}` : "/ask"} title="Open full page">⤢</Link>
              <button className="quiet" aria-label="Close" onClick={() => setOpen(false)}>✕</button>
            </span>
          </div>
          {!operator && <div className="chatpop-op"><input placeholder="Your name (audit trail)" onBlur={(e) => e.target.value.trim() && setOperator(e.target.value.trim())} /></div>}
          <ChatThread compact convId={convId} pendingContext={pending} onConversation={setConvId}
            onClip={(r) => { if (r.cameraId) router.push(`/?cam=${r.cameraId}&t=${(r.t ?? 0).toFixed(1)}${convId ? `&chat=${convId}` : ""}`); else if (r.videoUrl) window.open(r.videoUrl, "_blank"); }} />
        </div>
      )}
      <button className={`chatfab ${open ? "on" : ""}`} aria-label={open ? "Close Ask StockLens" : "Ask StockLens"} onClick={() => setOpen((o) => !o)}>
        {open ? <span style={{ fontSize: 18 }}>✕</span> : <Sparkle size={22} />}
      </button>
    </>
  );
}
