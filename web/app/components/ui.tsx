"use client";
import { useEffect, useRef, useState } from "react";

const TONE: Record<string, string> = {
  open: "bad", investigating: "warn", escalated: "bad", resolved: "ok", dismissed: "", discrepancy: "bad", ok: "ok", partial_ok: "ok",
  confirmed: "info", uncertain: "warn", rejected: "", superseded: "", done: "ok", processing: "info", queued: "", running: "info", error: "bad",
  idle: "ok", awaiting_footage: "", unverified: "warn", no_footage: "",
};
const LABEL: Record<string, string> = { partial_ok: "Matches records", ok: "Matches records", discrepancy: "Mismatch", awaiting_footage: "Awaiting footage", no_footage: "No footage", idle: "Ready" };

export function Status({ s, label }: { s: string; label?: string }) {
  return <span className={`st ${TONE[s] ?? ""}`}>{label ?? LABEL[s] ?? s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())}</span>;
}
export function Tag({ tone = "", children }: { tone?: string; children: React.ReactNode }) { return <span className={`tag ${tone}`}>{children}</span>; }
export function Sample() { return <span className="tag sample" title="Inventory records, product assignments and starting counts are sample configuration, not data from a real WMS">Sample records</span>; }
export function Diff({ n }: { n: number | null | undefined }) {
  if (n == null) return <span className="faint">—</span>;
  return <span className={`tnum ${n < 0 ? "neg" : n > 0 ? "pos" : "zero"}`}>{n > 0 ? `+${n}` : n}</span>;
}
export function Metric({ v, l, d }: { v: React.ReactNode; l: string; d?: React.ReactNode }) {
  return <div className="panel metric"><div className="v">{v}</div><div className="l">{l}</div>{d && <div className="d">{d}</div>}</div>;
}

/** Video that seeks whenever `seek` changes. Autoplay variants are muted loops for camera tiles. */
export function Player({ src, seek, tile, poster }: { src?: string; seek?: { t: number; n: number }; tile?: boolean; poster?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v || !seek) return;
    const go = () => { v.currentTime = Math.max(0, seek.t - 0.5); v.play().catch(() => {}); };
    if (v.readyState >= 1) go(); else v.addEventListener("loadedmetadata", go, { once: true });
  }, [seek?.t, seek?.n]);
  if (!src) return <div className="slot-empty"><span className="small">No footage analysed yet</span></div>;
  return tile
    ? <video ref={ref} src={src} poster={poster} muted autoPlay loop playsInline preload="metadata" />
    : <video ref={ref} src={src} poster={poster} controls muted playsInline preload="metadata" />;
}

export function useAct() {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null); setBusy(true);
    try { await fn(); return true; }
    catch (e) { setErr(e instanceof Error ? e.message.replace(/^\[CONVEX [^\]]+\]\s*/, "").replace(/[\s\S]*Uncaught Error:\s*/, "").split("\n")[0] : String(e)); return false; }
    finally { setBusy(false); }
  };
  return { err, busy, run };
}
export function Err({ e }: { e: string | null }) { return e ? <div className="err">{e}</div> : null; }
export function Progress({ p }: { p: number }) { return <div className="progress"><div style={{ width: `${Math.round(p * 100)}%` }} /></div>; }
