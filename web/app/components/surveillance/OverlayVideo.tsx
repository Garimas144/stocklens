"use client";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";

export type Cam = FunctionReturnType<typeof api.ui.surveillance>[number];
export type Track = Cam["tracks"][number];
export type Ev = Cam["events"][number];
export type State = "neutral" | "verified" | "review" | "discrepancy";
export type VideoHandle = { seek: (t: number, play?: boolean) => void; toggle: () => void; video: () => HTMLVideoElement | null };

const RANK: Record<State, number> = { neutral: 0, verified: 1, review: 2, discrepancy: 3 };
export const STATE_LABEL: Record<State, string> = { neutral: "Tracking", verified: "Verified", review: "Needs review", discrepancy: "Discrepancy" };

/** Box of a track at time t, interpolated between stored samples; null when the track was not observed around t. */
export function boxAt(tr: Track, t: number): number[] | null {
  const s = tr.samples;
  if (!s.length || t < s[0].t - 0.05 || t > s[s.length - 1].t + 0.15) return null;
  let i = s.findIndex((x) => x.t >= t);
  if (i === -1) return s[s.length - 1].b;
  if (i === 0) return s[0].b;
  const a = s[i - 1], b = s[i];
  if (b.t - a.t > 1.0) return t - a.t < 0.2 ? a.b : null;          // not detected in between: do not invent a box
  const u = (t - a.t) / Math.max(1e-3, b.t - a.t);
  return a.b.map((v, k) => v + (b.b[k] - v) * u);
}

/** Evidence-derived state of a track at time t: the most serious state of its movements that already happened. */
export function stateAt(cam: Cam, tr: Track, t: number): State {
  let st: State = "neutral";
  for (const e of cam.events) if (e.trackRef === tr.ref && e.t <= t && RANK[e.state as State] > RANK[st]) st = e.state as State;
  return st;
}

/** Reference-frame point -> image point at time t, using the session's camera path (identity when the camera is fixed). */
function mapper(cam: Cam, t: number) {
  const path = cam.session?.cameraPath;
  if (!path?.length) return (p: number[]) => p;
  let i = path.findIndex((x) => x.t >= t);
  if (i === -1) i = path.length - 1;
  const m = path[i].m;
  return (p: number[]) => [m[0] * p[0] + m[1] * p[1] + m[2], m[3] * p[0] + m[4] * p[1] + m[5]];
}

export function eventText(e: Ev) {
  if (e.state === "discrepancy" && e.sku && e.type === "shelf_addition") return `Unexpected placement on ${e.locationName}`;
  if (e.type === "shelf_removal") return `Item removed from ${e.locationName}`;
  if (e.type === "shelf_addition") return `Item added to ${e.locationName}`;
  return `${e.direction === "inbound" ? "Inbound" : e.direction === "outbound" ? "Outbound" : ""} movement · ${e.locationName}`;
}

export const OverlayVideo = forwardRef<VideoHandle, {
  cam: Cam; mode: "tile" | "focus"; startAt?: number; selected?: string | null; onSelect?: (ref: string | null) => void;
  onTime?: (t: number, playing: boolean) => void; autoPlay?: boolean;
}>(function OverlayVideo({ cam, mode, startAt, selected, onSelect, onTime, autoPlay = true }, ref) {
  const v = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(startAt ?? 0);
  const s = cam.session!;
  const W = s.width, H = s.height;
  // reference-frame geometry is drawn when we know where the camera points: a fixed camera, or a stored camera path
  const staticCam = !!s.cameraPath?.length || (s.cameraShiftPx ?? 999) < 80;
  const mp = mapper(cam, t);
  useImperativeHandle(ref, () => ({
    seek: (time: number, play = true) => { const el = v.current; if (!el) return; el.currentTime = Math.max(0, time); setT(el.currentTime); if (play) el.play().catch(() => {}); },
    toggle: () => { const el = v.current; if (!el) return; if (el.paused) el.play().catch(() => {}); else el.pause(); },
    video: () => v.current,
  }));
  useEffect(() => {
    const el = v.current;
    if (!el) return;
    let raf = 0;
    const tick = () => { setT(el.currentTime); onTime?.(el.currentTime, !el.paused); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [onTime]);
  const onMeta = useCallback(() => { const el = v.current; if (el && startAt) el.currentTime = Math.min(startAt, (el.duration || startAt) - 0.05); }, [startAt]);

  const visible = useMemo(() => cam.tracks.map((tr) => ({ tr, b: boxAt(tr, t) })).filter((x) => x.b) as { tr: Track; b: number[] }[], [cam.tracks, t]);
  const recent = cam.events.filter((e) => t >= e.t && t - e.t < 3.2);
  const flash = new Map(cam.events.filter((e) => e.trackRef && t >= e.t && t - e.t < 1.2).map((e) => [e.trackRef, e]));
  const focus = mode === "focus";
  const sw = W / (focus ? 520 : 380);                        // stroke width in video pixels
  const font = W / (focus ? 62 : 44);
  return (
    <div className={`ov ${mode}`}>
      <video ref={v} src={s.originalUrl ?? undefined} muted playsInline loop={!focus} autoPlay={autoPlay} preload="auto" onLoadedMetadata={onMeta} />
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" onClick={(e) => { if (e.target === e.currentTarget) onSelect?.(null); }}>
        {staticCam && cam.roi && <polygon className="guide roi" points={cam.roi.map((p) => mp(p).join(",")).join(" ")} strokeWidth={sw * 0.7} strokeDasharray={`${sw * 3} ${sw * 3}`} />}
        {staticCam && cam.shelves.map((z0) => {
          const z = { ...z0, polygon: z0.polygon.map(mp) };
          const xs = z.polygon.map((p) => p[0]), ys = z.polygon.map((p) => p[1]);
          const x = Math.max(4, Math.min(...xs)), y = Math.max(font * 1.4, Math.min(...ys) + font * 1.25);
          return <g key={z.id} className="shelf">
            <polygon points={z.polygon.map((p) => p.join(",")).join(" ")} strokeWidth={sw * 0.8} />
            <text x={x + font * 0.4} y={y} fontSize={font * 0.82}>{z.label}{z.product ? ` · ${z.product}` : ""}</text>
          </g>;
        })}
        {staticCam && cam.lines.map((l0) => { const l = { ...l0, p1: mp(l0.p1), p2: mp(l0.p2) }; return (
          <g key={l.id} className="line guide">
            <line x1={l.p1[0]} y1={l.p1[1]} x2={l.p2[0]} y2={l.p2[1]} strokeWidth={sw} strokeDasharray={`${sw * 4} ${sw * 3}`} />
            {focus && <text x={l.p1[0] + font * 0.4} y={l.p1[1] - font * 0.4} fontSize={font * 0.8}>{l.label}{l.means ? ` · ${l.means} →` : ""}</text>}
          </g>
        ); })}
        {visible.map(({ tr, b }) => {
          // background stock is a valid detection that can never be an inventory movement: drawn grey, never coloured by events
          const bg = tr.kind !== "person" && tr.relevance && tr.relevance !== "monitored";
          const st = tr.kind === "person" ? "person" : bg ? "background" : stateAt(cam, tr, t);
          const fe = flash.get(tr.ref);
          const [x1, y1, x2, y2] = b;
          const w = x2 - x1, h = y2 - y1, c = Math.max(8, Math.min(w, h) * 0.18);
          const sel = selected === tr.ref;
          const trail = focus && tr.kind === "package" ? tr.samples.filter((p) => p.t <= t && p.t > t - 2).map((p) => `${(p.b[0] + p.b[2]) / 2},${(p.b[1] + p.b[3]) / 2}`).join(" ") : "";
          const name = tr.kind === "person" ? tr.ref.replace("Worker ", "W") : tr.ref.replace("Package ", "P");
          return (
            <g key={tr.ref} className={`trk ${st} ${sel ? "sel" : ""} ${fe ? "flash" : ""}`} onClick={(e) => { e.stopPropagation(); onSelect?.(tr.ref); }}>
              {trail && <polyline points={trail} className="trail" strokeWidth={sw * 0.8} />}
              <rect x={x1} y={y1} width={w} height={h} className="fill" />
              <rect x={x1} y={y1} width={w} height={h} className="edge" strokeWidth={sw * (sel ? 1.2 : 0.6)} />
              <path className="corner" strokeWidth={sw * 2} d={`M${x1},${y1 + c}V${y1}H${x1 + c} M${x2 - c},${y1}H${x2}V${y1 + c} M${x2},${y2 - c}V${y2}H${x2 - c} M${x1 + c},${y2}H${x1}V${y2 - c}`} />
              {fe && <text className="fltx" x={x1} y={y2 + font * 1.1} fontSize={font * 0.9}>{fe.direction ? `${fe.direction[0].toUpperCase()}${fe.direction.slice(1)} crossing` : eventText(fe)}{fe.state === "discrepancy" ? " · not in records" : fe.verification === "uncertain" ? " · needs review" : " ✓"}</text>}
              {(focus || (tr.kind === "package" && !bg)) && <g transform={`translate(${x1},${Math.max(font * 1.2, y1 - font * 0.35)})`}>
                <rect className="tagbg" x={0} y={-font * 1.05} rx={font * 0.25} width={font * 0.62 * (name.length + (focus && tr.product ? tr.product.length + 3 : 0)) + font * 0.7} height={font * 1.35} />
                <text className="tagtx" x={font * 0.35} y={0} fontSize={font * 0.9}>{name}{focus && tr.product ? ` · ${tr.product}` : ""}</text>
              </g>}
            </g>
          );
        })}
      </svg>
      <div className="ev-stack">
        {recent.slice(-2).map((e) => <div key={e.id} className={`evt-note ${e.state}`}><i />{eventText(e)}{e.verification === "uncertain" ? " · needs review" : ""}</div>)}
      </div>
    </div>
  );
});
