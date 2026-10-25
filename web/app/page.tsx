"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { AREA, fmtClock } from "@/lib/format";
import { ChatContext, ChatThread, Sparkle } from "./components/Chat";
import { Cam, OverlayVideo, STATE_LABEL, State, VideoHandle, eventText, stateAt } from "./components/surveillance/OverlayVideo";
import { useOperator } from "./providers";

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function Tile({ cam, slot, onOpen, startAt }: { cam?: Cam; slot: number; onOpen: () => void; startAt?: number }) {
  if (!cam || !cam.session) return (
    <div className="sv-tile empty">
      <div className="sv-empty"><span className="mono">CAM 0{slot}</span><span>{cam ? (cam.job ? "Analysing footage…" : "No analysed footage yet") : "Not configured"}</span>
        <Link href="/cameras" className="sv-link">Set up in Workspace →</Link></div>
    </div>
  );
  const confirmed = cam.events.filter((e) => e.verification === "confirmed").length;
  return (
    <div className="sv-tile" onClick={onOpen} data-cam={cam.cameraId}>
      <OverlayVideo cam={cam} mode="tile" startAt={startAt} />
      <div className="sv-chip tl"><b>CAM 0{slot}</b> · {cam.name}</div>
      <div className="sv-chip tr"><span className="rec" />AI playback · {hhmm(cam.session.startedAt)}</div>
      <div className="sv-foot">
        <span>{cam.where}</span>
        <span>{confirmed} movement{confirmed === 1 ? "" : "s"}{cam.events.some((e) => e.verification === "uncertain") ? ` · ${cam.events.filter((e) => e.verification === "uncertain").length} to review` : ""}</span>
      </div>
      {cam.incidents.length > 0 && <Link className="sv-alert" href={`/investigations/${cam.incidents[0].code}`} onClick={(e) => e.stopPropagation()}>
        {cam.incidents.length} open issue{cam.incidents.length > 1 ? "s" : ""} · {cam.incidents[0].code}</Link>}
    </div>
  );
}

function Focus({ cam, slot, startAt, onBack, onAsk }: { cam: Cam; slot: number; startAt: number; onBack: (t: number) => void; onAsk: (c: ChatContext) => void }) {
  const vid = useRef<VideoHandle>(null);
  const [t, setT] = useState(startAt);
  const [playing, setPlaying] = useState(true);
  const [sel, setSel] = useState<string | null>(null);
  const dur = cam.session?.durationS || 1;
  const onTime = useCallback((x: number, p: boolean) => { setT(x); setPlaying(p); }, []);
  useEffect(() => { vid.current?.seek(startAt, true); }, [startAt]);
  const tRef = useRef(t); tRef.current = t;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !(e.target as HTMLElement)?.closest?.("input,textarea")) onBack(tRef.current); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onBack]);
  const tr = cam.tracks.find((x) => x.ref === sel) ?? null;
  const trEvents = tr ? cam.events.filter((e) => e.trackRef === tr.ref) : [];
  const zones = tr ? [...new Set(tr.samples.map((s) => s.z).filter((z) => z && z !== "transit"))] : [];
  const st: State | null = tr && tr.kind === "package" ? stateAt(cam, tr, dur) : null;
  return (
    <div className="sv-focus">
      <div className="sv-stage">
        <div className="sv-video">
          <OverlayVideo ref={vid} cam={cam} mode="focus" startAt={startAt} selected={sel} onSelect={setSel} onTime={onTime} />
          <div className="sv-chip tl"><b>CAM 0{slot}</b> · {cam.name} · {cam.where}</div>
          <div className="sv-chip tr"><span className="rec" />Recorded {cam.session && new Date(cam.session.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
        </div>
        <div className="sv-controls">
          <button className="sv-btn" onClick={() => vid.current?.toggle()} aria-label={playing ? "Pause" : "Play"}>{playing ? "❚❚" : "▶"}</button>
          <span className="mono sv-time">{fmtClock(t)} / {fmtClock(dur)}</span>
          <div className="sv-scrub" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); vid.current?.seek(((e.clientX - r.left) / r.width) * dur); }}>
            <div className="sv-bar"><div style={{ width: `${(t / dur) * 100}%` }} /></div>
            {cam.events.map((e) => <button key={e.id} className={`sv-mark ${e.state}`} style={{ left: `${(e.t / dur) * 100}%` }} title={`${fmtClock(e.t)} · ${eventText(e)}`}
              onClick={(x) => { x.stopPropagation(); vid.current?.seek(e.t - 0.8); if (e.trackRef) setSel(e.trackRef); }} />)}
          </div>
        </div>
      </div>
      <aside className="sv-rail">
        <div className="sv-sec">Movements in this recording</div>
        {cam.events.length === 0 && <div className="sv-dim">No confirmed movements. {cam.profile === "shelf" ? "The shelves were not changed in this footage." : "Nothing crossed the counting line."}</div>}
        {cam.events.map((e) => (
          <button key={e.id} className={`sv-ev ${Math.abs(t - e.t) < 2 ? "now" : ""}`} onClick={() => { vid.current?.seek(e.t - 0.8); setSel(e.trackRef); }}>
            <span className={`dot ${e.state}`} /><span className="tx">{eventText(e)}<small>{fmtClock(e.t)} · {e.trackRef}{e.verification === "uncertain" ? " · needs review" : ""}</small></span>
          </button>
        ))}
        {tr ? (
          <div className="sv-obj">
            <div className="between"><b>{tr.ref}</b><button className="sv-x" onClick={() => setSel(null)}>✕</button></div>
            <div className="sv-dim">{tr.kind === "person" ? "Person (not inventory)" : tr.product ? `${tr.product}${tr.packageId ? ` · ${tr.packageId}` : ""} · identity verified` : "Unidentified package · id scoped to this recording"}</div>
            {tr.relevance && tr.relevance !== "monitored" ? <div className="sv-state background">{tr.relevance === "background_static" ? "Did not travel through the area · not counted" : "Outside monitored region · not counted"}</div>
              : st && <div className={`sv-state ${st}`}>{STATE_LABEL[st]}</div>}
            <div className="sv-kv"><span>Seen</span><span><button onClick={() => vid.current?.seek(tr.firstSeenS)}>{fmtClock(tr.firstSeenS)}</button> – <button onClick={() => vid.current?.seek(Math.max(0, tr.lastSeenS - 1))}>{fmtClock(tr.lastSeenS)}</button></span></div>
            {zones.length > 0 && <div className="sv-kv"><span>Zones</span><span>{zones.join(" → ")}</span></div>}
            <div className="sv-kv"><span>Detector</span><span>{Math.round(tr.meanConf * 100)}% mean confidence{tr.category && tr.category !== "package" ? ` · ${tr.category}` : ""}</span></div>
            {tr.trackingQuality != null && <div className="sv-kv"><span>Tracking</span><span>{Math.round(tr.trackingQuality * 100)}% of frames observed as one identity</span></div>}
            {tr.kind === "package" && <div className="sv-kv"><span>Last state</span><span>{tr.status}</span></div>}
            {trEvents.map((e) => <div key={e.id} className="sv-kv"><span>{fmtClock(e.t)}</span><span>{eventText(e)}{e.eventConf != null && ` · rule fit ${Math.round(e.eventConf * 100)}%`}{e.incident && <> · <Link href={`/investigations/${e.incident}`}>{e.incident}</Link></>}</span></div>)}
            {tr.uncertainty.length > 0 && <details className="sv-more"><summary>{tr.uncertainty.length} tracking caveat{tr.uncertainty.length > 1 ? "s" : ""}</summary><ul>{tr.uncertainty.map((u, i) => <li key={i}>{u}</li>)}</ul></details>}
            <button className="sv-ask" onClick={() => onAsk({ kind: "track", ref: `${cam.cameraId}|${tr.ref}`, label: `${tr.ref} · CAM 0${slot} ${cam.name}` })}><Sparkle size={13} /> Ask about this item</button>
          </div>
        ) : <div className="sv-dim" style={{ marginTop: 14 }}>Select a box in the video to see what the system knows about it.</div>}
        <button className="sv-ask ghostish" onClick={() => onAsk({ kind: "camera", ref: cam.cameraId, label: `CAM 0${slot} · ${cam.name}` })}><Sparkle size={13} /> Ask about this camera</button>
        <div className="sv-legend">
          {(["neutral", "verified", "review", "discrepancy"] as State[]).map((k) => <span key={k}><i className={k} />{STATE_LABEL[k]}</span>)}
          {cam.tracks.some((x) => x.relevance && x.relevance !== "monitored") && <span><i className="background" />Background · not counted</span>}
        </div>
      </aside>
    </div>
  );
}

function Surveillance() {
  const cams = useQuery(api.ui.surveillance);
  const params = useSearchParams();
  const router = useRouter();
  const { operator, setOperator } = useOperator();
  const [focus, setFocus] = useState<string | null>(params.get("cam"));
  const [startAt, setStartAt] = useState<number>(Number(params.get("t") ?? 0));
  const [chat, setChat] = useState<boolean>(!!params.get("chat"));
  const [convId, setConvId] = useState<Id<"conversations"> | null>((params.get("chat") as Id<"conversations">) || null);
  const [pending, setPending] = useState<ChatContext | null>(null);
  const [full, setFull] = useState(false);
  const [guides, setGuides] = useState(true);   // ROI / counting lines / shelf outlines
  useEffect(() => { try { if (localStorage.getItem("sv-guides") === "0") setGuides(false); } catch {} }, []);
  const toggleGuides = () => { setGuides((g) => { try { localStorage.setItem("sv-guides", g ? "0" : "1"); } catch {} return !g; }); };
  const [resume, setResume] = useState<Record<string, number>>({});     // keep each camera's playback position across views
  const grid = useMemo(() => [1, 2, 3, 4].map((slot) => ({ slot, cam: cams?.find((c) => c.slot === slot) })), [cams]);
  useEffect(() => { setFocus(params.get("cam")); if (params.get("t")) setStartAt(Number(params.get("t"))); }, [params]);
  useEffect(() => { const h = () => setFull(!!document.fullscreenElement); document.addEventListener("fullscreenchange", h); return () => document.removeEventListener("fullscreenchange", h); }, []);
  const url = (cam: string | null, t?: number) => router.replace(cam ? `/?cam=${cam}${t ? `&t=${t.toFixed(1)}` : ""}${convId && chat ? `&chat=${convId}` : ""}` : `/${convId && chat ? `?chat=${convId}` : ""}`, { scroll: false });
  const ask = (c: ChatContext | null) => { setPending(c); setConvId(null); setChat(true); };
  if (!cams) return <div className="sv"><div className="sv-loading">Loading camera network…</div></div>;
  const ready = grid.filter((g) => g.cam?.session).length;
  const fc = cams.find((c) => c.cameraId === focus);
  const fslot = fc?.slot ?? 0;
  return (
    <div className={`sv ${chat ? "with-chat" : ""} ${guides ? "" : "no-guides"}`}>
      <header className="sv-top">
        <div className="sv-brand"><i />StockLens<span className="sv-sep" />Demo warehouse</div>
        <div className="sv-status"><span className="ok" />{ready} of 4 cameras analysed<span className="sv-pill">Recorded analysis · AI playback</span></div>
        <div className="sv-actions">
          <button className="sv-btn wide accent" onClick={() => (chat ? setChat(false) : ask(fc ? { kind: "camera", ref: fc.cameraId, label: `CAM 0${fslot} · ${fc.name}` } : null))}><Sparkle size={14} /> Ask StockLens</button>
          <button className={`sv-btn wide ${guides ? "on" : ""}`} aria-pressed={guides} title="Show monitoring regions and counting lines" onClick={toggleGuides}>Zones</button>
          <Link className="sv-btn wide" href="/dashboard">Open Workspace</Link>
          <button className="sv-btn" aria-label="Full screen" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})}>{full ? "⤡" : "⤢"}</button>
        </div>
      </header>
      <main className="sv-body">
        {fc && fc.session ? (
          <Focus key={fc.cameraId} cam={fc} slot={fslot} startAt={startAt} onBack={(t) => { setResume((r) => ({ ...r, [fc.cameraId]: t })); setFocus(null); url(null); }}
            onAsk={(c) => ask(c)} />
        ) : (
          <div className="sv-grid">{grid.map(({ slot, cam }) => <Tile key={slot} slot={slot} cam={cam} startAt={cam ? resume[cam.cameraId] : undefined}
            onOpen={(e?: unknown) => { if (cam) { const v = document.querySelector<HTMLVideoElement>(`[data-cam="${cam.cameraId}"] video`); setStartAt(v?.currentTime ?? 0); setFocus(cam.cameraId); url(cam.cameraId); } }} />)}</div>
        )}
      </main>
      <aside className={`sv-chat ${chat ? "open" : ""}`}>
        {chat && <>
          <div className="sv-chat-hd"><span><Sparkle size={14} /> Ask StockLens</span><span className="row" style={{ gap: 4 }}>
            <button className="quiet" onClick={() => { setConvId(null); setPending(fc ? { kind: "camera", ref: fc.cameraId, label: `CAM 0${fslot} · ${fc.name}` } : null); }}>New</button>
            <button className="quiet" onClick={() => setChat(false)}>✕</button></span></div>
          {!operator && <div className="sv-op"><input placeholder="Your name (audit trail)" onBlur={(e) => e.target.value.trim() && setOperator(e.target.value.trim())} /></div>}
          <ChatThread compact convId={convId} pendingContext={pending} onConversation={(id) => { setConvId(id); }}
            onClip={(r) => { if (r.cameraId) { setStartAt(Math.max(0, (r.t ?? 0) - 0.8) + Math.random() * 1e-3); setFocus(r.cameraId); url(r.cameraId, r.t); } }} />
        </>}
      </aside>
    </div>
  );
}

export default function Page() { return <Suspense><Surveillance /></Suspense>; }
