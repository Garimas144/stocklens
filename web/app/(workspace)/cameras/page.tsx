"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
import { AREA, eventLabel, fmtClock, fmtTime } from "@/lib/format";
import { templateFor } from "@/lib/cameraTemplates";
import { useNames } from "@/lib/names";
import { Err, Player, Progress, Status, Tag, useAct } from "../../components/ui";
import EventCard from "../../components/EventCard";
import { useOperator } from "../../providers";
import AskButton from "../../components/AskButton";

type Cam = NonNullable<ReturnType<typeof useQuery<typeof api.ui.network>>>[number];
const SLOTS = [{ slot: 1, area: "receiving" }, { slot: 2, area: "storage" }, { slot: 3, area: "aisle" }, { slot: 4, area: "dispatch" }];

function summary(c: Cam) {
  const ev = c.events.filter((e) => e.verification === "confirmed");
  if (c.profile === "shelf") {
    const a = ev.filter((e) => e.type === "shelf_addition").length, r = ev.filter((e) => e.type === "shelf_removal").length;
    return `${a} added · ${r} removed`;
  }
  const out = ev.filter((e) => e.direction === "outbound").length, inn = ev.filter((e) => e.direction === "inbound").length;
  return c.area === "aisle" ? `${ev.length} movement${ev.length === 1 ? "" : "s"} through aisle` : c.area === "receiving" ? `${inn} inbound · ${out} outbound` : `${out} outbound · ${inn} inbound`;
}

function Tile({ c, slot, area, onOpen, onSetup }: { c?: Cam; slot: number; area: string; onOpen: () => void; onSetup: () => void }) {
  if (!c) return (
    <div className="panel" style={{ overflow: "hidden" }}>
      <div className="slot-empty"><span className="mono tiny">CAM 0{slot}</span><span>{AREA[area]} camera not configured</span><button className="ghost" onClick={onSetup}>Connect a source</button></div>
      <div className="meta" style={{ padding: "14px 16px" }}><div className="n">{AREA[area]}</div><div className="tiny muted">No source</div></div>
    </div>
  );
  const processing = c.job || c.session?.status === "processing";
  return (
    <div className="panel cam" onClick={onOpen}>
      <div className="vid">
        <Player src={c.session?.processedUrl} tile />
        <span className="chip l">CAM 0{slot} · {AREA[c.area ?? area]}</span>
        <span className={`chip r ${c.source.kind === "rtsp" ? "live" : "rec"}`}>{c.source.kind === "rtsp" ? "LIVE" : "RECORDED"}</span>
        {c.exceptions.length > 0 && <span className="chip alert" style={{ bottom: 10, left: 10, top: "auto" }}>{c.exceptions.length} open issue{c.exceptions.length > 1 ? "s" : ""}</span>}
      </div>
      <div className="meta">
        <div className="between"><span className="n">{c.name}</span>{processing ? <Status s="processing" label="Analysing" /> : c.session ? <Status s="done" label="Analysed" /> : <Status s="awaiting_footage" />}</div>
        <div className="between" style={{ marginTop: 4 }}><span className="small muted">{c.warehouseLocation}</span><span className="small">{c.session ? summary(c) : "—"}</span></div>
        {processing && <div style={{ marginTop: 10 }}><Progress p={c.job?.progress ?? c.session?.progress ?? 0} /></div>}
      </div>
    </div>
  );
}

function Cameras() {
  const net = useQuery(api.ui.network);
  const params = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(params.get("cam"));
  const [setup, setSetup] = useState<{ slot?: number; area: string } | null>(null);
  useEffect(() => { setOpen(params.get("cam")); }, [params]);
  if (!net) return <div className="empty">Loading…</div>;
  const show = (id: string | null) => { setOpen(id); router.replace(id ? `/cameras?cam=${id}` : "/cameras", { scroll: false }); };
  const others = net.filter((c) => !c.slot || c.slot > 4);
  const cam = net.find((c) => c.cameraId === open);
  return (
    <>
      <div className="ph">
        <div><h1>Camera network</h1><p>Four viewpoints of one warehouse operation feeding the same inventory memory. All footage below is recorded and analysed, not live.</p></div>
        <button className="ghost" onClick={() => setSetup({ area: "other" })}>Add camera</button>
      </div>
      <div className="grid c2">
        {SLOTS.map(({ slot, area }) => <Tile key={slot} slot={slot} area={area} c={net.find((c) => c.slot === slot)} onOpen={() => show(net.find((c) => c.slot === slot)!.cameraId)} onSetup={() => setSetup({ slot, area })} />)}
      </div>
      {others.length > 0 && <>
        <div className="sec gap-l"><h2>Additional cameras</h2><span className="hint">Outside the four-stage view</span></div>
        <div className="grid c4">{others.map((c) => (
          <div key={c._id} className="panel cam" onClick={() => show(c.cameraId)}>
            <div className="vid"><Player src={c.session?.processedUrl} tile /><span className="chip r rec">RECORDED</span></div>
            <div className="meta"><div className="n small">{c.name}</div><div className="tiny muted">{c.warehouseLocation} · {summary(c)}</div></div>
          </div>))}</div>
      </>}
      <div className="callout gap-l small">Each camera is analysed separately. Tracking ids from different cameras are never assumed to be the same item; observations are joined across cameras only when an item has a verified identity (operator link, barcode or product classification).</div>
      {cam && <><div className="scrim" onClick={() => show(null)} /><div className="drawer"><CameraDetail c={cam} close={() => show(null)} /></div></>}
      {setup && <><div className="scrim" onClick={() => setSetup(null)} /><div className="drawer" style={{ width: "min(720px, 94vw)" }}><Setup init={setup} close={() => setSetup(null)} /></div></>}
    </>
  );
}

function CameraDetail({ c, close }: { c: Cam; close: () => void }) {
  const names = useNames();
  const request = useMutation(api.ops.requestProcessing);
  const { operator } = useOperator();
  const act = useAct();
  const [view, setView] = useState<"processed" | "original">("processed");
  const [seek, setSeek] = useState<{ t: number; n: number }>();
  const [tab, setTab] = useState<"activity" | "objects" | "config">("activity");
  const play = (e: Doc<"movementEvents">) => { setView("processed"); setSeek({ t: e.t, n: Date.now() }); };
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="between">
        <div><div className="eyebrow">CAM 0{c.slot ?? "–"} · {AREA[c.area ?? "other"]}</div><h1 style={{ margin: 0, fontSize: 22, letterSpacing: "-.03em" }}>{c.name}</h1><div className="small muted">{c.warehouseLocation} · {c.profile === "shelf" ? "Shelf monitoring" : "Movement monitoring"}</div></div>
        <div className="row">
          {c.session && <AskButton kind="camera" id={c.cameraId} label={`${c.slot && c.slot <= 4 ? `CAM 0${c.slot} · ` : ""}${c.name}`} text="Ask about this footage" />}
          <button className="ghost" disabled={act.busy || !!c.job} onClick={() => act.run(() => request({ operator, cameraId: c.cameraId, reuseCache: true }))}>{c.job ? "Analysing…" : "Re-analyse"}</button>
          <button className="quiet" onClick={close}>Close ✕</button>
        </div>
      </div>
      <Err e={act.err} />
      {c.job && <div><div className="tiny muted" style={{ marginBottom: 6 }}>{c.job.status === "queued" ? "Queued: waiting for a CV worker (python worker.py)" : "Running YOLOv8 + tracking"}</div><Progress p={c.job.progress} /></div>}
      <div className="panel" style={{ overflow: "hidden" }}>
        <div className="vid contain" style={{ borderRadius: 0 }}>
          <Player src={view === "processed" ? c.session?.processedUrl : c.session?.originalUrl} seek={seek} />
          <span className="chip l rec">RECORDED {c.session ? fmtTime(c.session.startedAt) : ""}</span>
        </div>
        <div className="between" style={{ padding: "10px 14px" }}>
          <div className="seg"><button className={view === "processed" ? "on" : ""} onClick={() => setView("processed")}>Detections & zones</button><button className={view === "original" ? "on" : ""} onClick={() => setView("original")}>Original</button></div>
          <span className="tiny muted">{c.trackSummary.packages} packages · {c.trackSummary.people} people tracked</span>
        </div>
      </div>
      {c.exceptions.length > 0 && <div className="panel"><div className="bd list">{c.exceptions.map((x) => (
        <Link key={x.code} href={`/investigations/${x.code}`} className="item"><span className="mono faint" style={{ width: 70 }}>{x.code}</span><span className="t" style={{ flex: 1 }}>{x.kind === "misplaced_item" ? "Misplaced item" : x.kind === "shelf_quantity" ? "Inventory mismatch" : "Unrecorded movement"} · {names.loc(x.locationId)}</span><span className="small">Open →</span></Link>))}</div></div>}
      <div className="seg" style={{ alignSelf: "flex-start" }}>
        {(["activity", "objects", "config"] as const).map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t === "activity" ? "Movements" : t === "objects" ? "Tracked objects" : "Zones & setup"}</button>)}
      </div>
      {tab === "activity" && <div className="panel"><div className="bd list">{c.events.length === 0 ? <div className="empty">No confirmed movements in this footage.</div> : c.events.map((e) => <EventCard key={e._id} e={e} onPlay={play} place={names.loc(e.locationId)} />)}</div></div>}
      {tab === "objects" && <Objects cameraId={c.cameraId} sessionId={c.session?.sessionId} play={(t) => { setView("processed"); setSeek({ t, n: Date.now() }); }} />}
      {tab === "config" && <Config c={c} />}
    </div>
  );
}

function Objects({ cameraId, sessionId, play }: { cameraId: string; sessionId?: string; play: (t: number) => void }) {
  const d = useQuery(api.ui.cameraDetail, sessionId ? { cameraId, sessionId } : "skip");
  const inv = useQuery(api.ui.inventory);
  const link = useMutation(api.ops.linkPackage);
  const { operator } = useOperator();
  const act = useAct();
  const [edit, setEdit] = useState<string | null>(null);
  const [v, setV] = useState({ packageId: "", sku: "" });
  if (!sessionId) return <div className="empty">No footage analysed yet.</div>;
  if (!d) return <div className="empty">Loading…</div>;
  return (
    <div className="panel">
      <div className="hd"><h2>Tracked objects</h2><span className="tiny muted">Ids are scoped to this recording. Link an id only with identity evidence.</span></div>
      <table className="tbl"><tbody>{d.tracks.map((t) => (
        <tr key={t._id}>
          <td><div style={{ fontWeight: 500 }}>{t.trackRef}</div><div className="tiny faint">{t.kind === "person" ? "person" : t.status}</div></td>
          <td className="small"><button className="quiet" onClick={() => play(t.firstSeenS)}>{fmtClock(t.firstSeenS)}–{fmtClock(t.lastSeenS)}</button></td>
          <td className="small">{t.sku ? <Tag tone="blue">{t.sku}</Tag> : null} {t.packageId ? <Tag>{t.packageId}</Tag> : null}{t.uncertainty.length > 0 && <span className="tiny faint" title={t.uncertainty.join("\n")}> {t.uncertainty.length} caveat{t.uncertainty.length > 1 ? "s" : ""}</span>}</td>
          <td style={{ width: 260 }}>{t.kind === "package" && (edit === t.trackRef ? (
            <div className="row">
              <select value={v.sku} onChange={(e) => setV({ ...v, sku: e.target.value })}><option value="">No SKU</option>{inv?.products.map((p) => <option key={p.sku} value={p.sku}>{p.name}</option>)}</select>
              <input style={{ width: 110 }} placeholder="package id" value={v.packageId} onChange={(e) => setV({ ...v, packageId: e.target.value })} />
              <button onClick={() => act.run(() => link({ operator, sessionId: t.sessionId, trackRef: t.trackRef, ...v })).then((ok) => ok && setEdit(null))}>Save</button>
            </div>) : <button className="quiet" onClick={() => { setEdit(t.trackRef); setV({ packageId: t.packageId ?? "", sku: t.sku ?? "" }); }}>Identify…</button>)}</td>
        </tr>))}</tbody></table>
      <div className="pad"><Err e={act.err} /></div>
    </div>
  );
}

function Config({ c }: { c: Cam }) {
  const update = useMutation(api.ops.updateCamera);
  const { operator } = useOperator();
  const act = useAct();
  const [text, setText] = useState(JSON.stringify(c.config, null, 1));
  return (
    <div className="panel pad stack">
      <div className="small muted">Monitored locations: {c.locations.map((l) => `${l.name} (${l.type})`).join(", ") || "none"}. Zones and count lines use first-frame pixel coordinates and appear on the “Detections & zones” view after re-analysis.</div>
      <details className="more"><summary>Edit zones, shelves, count lines and thresholds</summary>
        <textarea className="code" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={() => act.run(async () => { let cfg; try { cfg = JSON.parse(text); } catch { throw new Error("not valid JSON"); }
            await update({ operator, cameraId: c.cameraId, name: c.name, context: c.context, warehouseLocation: c.warehouseLocation, profile: c.profile, sourceUri: c.source.uri, recordedAt: c.source.recordedAt, config: cfg }); })}>Save</button>
          <span className="tiny muted">Source <span className="mono">{c.source.uri}</span> · changed {fmtTime(c.updatedAt)} by {c.updatedBy}</span>
        </div>
        <Err e={act.err} />
      </details>
    </div>
  );
}

function Setup({ init, close }: { init: { slot?: number; area: string }; close: () => void }) {
  const update = useMutation(api.ops.updateCamera);
  const request = useMutation(api.ops.requestProcessing);
  const { operator } = useOperator();
  const act = useAct();
  const profileFor = (a: string) => (a === "storage" ? "shelf" : "movement") as "shelf" | "movement";
  const [f, setF] = useState({ cameraId: `cam-0${init.slot ?? 5}-${init.area}`, name: `${AREA[init.area] ?? "New"} camera`, area: init.area, location: "", uri: "", rtsp: "", recordedAt: "" });
  const [cfg, setCfg] = useState(JSON.stringify(templateFor(profileFor(init.area)), null, 1));
  const [uploading, setUploading] = useState(false);
  const upload = async (file: File) => {
    setUploading(true);
    const body = new FormData(); body.append("file", file);
    const r = await fetch("/api/upload", { method: "POST", body }).then((x) => x.json());
    setUploading(false);
    if (r.uri) setF((s) => ({ ...s, uri: r.uri })); else throw new Error(r.error ?? "upload failed");
  };
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="between"><div><div className="eyebrow">{init.slot ? `CAM 0${init.slot}` : "New camera"}</div><h1 style={{ margin: 0, fontSize: 22 }}>Connect a camera</h1></div><button className="quiet" onClick={close}>Close ✕</button></div>
      <div className="grid c2">
        <label className="f">Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="f">Camera id<input value={f.cameraId} onChange={(e) => setF({ ...f, cameraId: e.target.value })} /></label>
        <label className="f">Watches<select value={f.area} onChange={(e) => { setF({ ...f, area: e.target.value }); setCfg(JSON.stringify(templateFor(profileFor(e.target.value)), null, 1)); }}>{Object.entries(AREA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="f">Location in the warehouse<input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="e.g. Dock door 2" /></label>
      </div>
      <div className="panel pad stack">
        <h2>Footage source</h2>
        <label className="f">Upload a recording (MP4)<input type="file" accept="video/mp4,video/quicktime" onChange={(e) => e.target.files?.[0] && act.run(() => upload(e.target.files![0]))} style={{ height: "auto", padding: 8 }} /></label>
        {uploading && <div className="tiny muted">Uploading…</div>}
        {f.uri && <div className="tiny">Stored as <span className="mono">{f.uri}</span></div>}
        <label className="f">When was it recorded?<input type="datetime-local" value={f.recordedAt} onChange={(e) => setF({ ...f, recordedAt: e.target.value })} /></label>
        <label className="f">Or an RTSP stream (saved for later; live ingestion is not implemented yet)<input value={f.rtsp} onChange={(e) => setF({ ...f, rtsp: e.target.value })} placeholder="rtsp://…" /></label>
      </div>
      <details className="more"><summary>Monitoring zones and rules ({profileFor(f.area) === "shelf" ? "shelf polygons" : "count lines"})</summary><textarea className="code" value={cfg} onChange={(e) => setCfg(e.target.value)} /></details>
      <div className="row">
        <button disabled={act.busy || uploading} onClick={() => act.run(async () => {
          let config; try { config = JSON.parse(cfg); } catch { throw new Error("zones/rules are not valid JSON"); }
          const uri = f.rtsp.trim() || f.uri;
          if (!uri) throw new Error("upload a recording or enter an RTSP address");
          await update({ operator, cameraId: f.cameraId, name: f.name, context: AREA[f.area], warehouseLocation: f.location, profile: profileFor(f.area), sourceUri: uri,
            recordedAt: f.recordedAt ? Date.parse(f.recordedAt) : undefined, config, slot: init.slot, area: f.area });
          if (!f.rtsp.trim()) await request({ operator, cameraId: f.cameraId, reuseCache: true });
          close();
        })}>Save and analyse</button>
        <span className="tiny muted">Shelf zones and count lines must reference existing locations (Inventory).</span>
      </div>
      <Err e={act.err} />
    </div>
  );
}

export default function Page() { return <Suspense><Cameras /></Suspense>; }
