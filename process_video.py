"""CV worker pipeline for one camera session.

  YOLOv8 + ByteTrack (detector.py) -> camera-motion compensation -> identity consolidation + zone engine (event_engine.py)
  -> profile module: shelf_monitor.py (additions/removals) or movement_monitor.py (checkpoint crossings)
  -> annotated video + evidence frames (served by the web app) -> structured events published to Convex (idempotent).

Only business events and per-track summaries leave this process; raw detections stay in the local cache.

  python process_video.py --camera shelf-cam-01            # uses the camera's configured source and recordedAt from Convex
  python process_video.py --camera dock-belt-01 --fresh    # ignore the cached YOLO pass
"""
import argparse
import hashlib
import json
import os
import shutil
import time
import traceback
import cv2
import numpy as np
import config as C
import video_loader
from cameras import Config, validate
from camera_motion import CameraMotion
from convex_bridge import Bridge
from event_engine import Engine
from movement_monitor import MovementMonitor
import relevance
import groups
from shelf_monitor import ShelfMonitor
from utils import fmt, fmt1, to_h264

KIND_COLOR = {"person": (80, 220, 80), "package": (255, 170, 90), "background": (150, 150, 150)}   # BGR: package = the UI's tracking blue
SLOT_COLOR = {"occupied": (80, 200, 80), "empty": (60, 60, 230), "unknown": (150, 150, 150)}


def session_id_for(camera_id, uri, recorded_at_ms):
    stem = os.path.splitext(os.path.basename(uri))[0]
    return f"{camera_id}-{stem}-{time.strftime('%Y%m%d%H%M', time.gmtime(recorded_at_ms / 1000))}"


def cache_path(video, rules):
    parts = [os.path.abspath(video), rules["box_prompts"], rules["track_people"]]
    if rules.get("world_weights") or rules.get("box_conf") is not None or rules.get("coco_items") or rules.get("tracker") or rules.get("crop_shelves"):   # older caches keep their key
        parts += [rules.get("world_weights"), rules.get("box_conf"), rules.get("coco_items")]
        if rules.get("crop_shelves"):
            parts += ["crops", rules.get("crop_shelves"), rules.get("crop_prompts"), rules.get("crop_weights"), rules.get("crop_tracker"), rules.get("crop_conf")]
        if rules.get("tracker"):   # the tracker file's content, so editing its thresholds re-runs the YOLO pass
            parts.append(open(os.path.join(C.BASE, "trackers", rules["tracker"])).read())
    key = hashlib.sha1(json.dumps(parts).encode()).hexdigest()[:10]
    return os.path.join(C.OUTPUTS, "raw_cache", f"{os.path.splitext(os.path.basename(video))[0]}-{key}.json")


def stage1_detect(video, cfg, raw_path, progress):
    from detector import YoloTracker
    rules = cfg.rules
    yt, cm = YoloTracker(rules["box_prompts"], rules["track_people"], rules.get("world_weights"), rules.get("box_conf"), rules.get("coco_items") or (), rules.get("tracker"),
                             [b for z, b in zip(cfg.zones, cfg.bounds()) if z["id"] in (rules.get("crop_shelves") or [])], rules.get("crop_prompts"),
                             rules.get("crop_weights"), rules.get("crop_tracker"), rules.get("crop_conf")), CameraMotion()
    meta, frames, t0 = video_loader.info(video), [], time.time()
    zone_boxes = cfg.bounds() if rules["camera_mask_zones"] else []
    for i, frame in video_loader.frames(video):
        dets = yt.track(frame)
        H = cm.update(frame, [d.bbox for d in dets] + zone_boxes)
        out = []
        for d in dets:
            x1, y1, x2, y2 = d.bbox
            px, py = ((x1 + x2) / 2, y2) if d.cls == "person" else ((x1 + x2) / 2, (y1 + y2) / 2)
            wx, wy = cm.to_ref(px, py)
            out.append(dict(cls=d.cls, id=d.track_id, conf=round(d.conf, 3), bbox=list(d.bbox), pos=[round(wx, 1), round(wy, 1)]))
        frames.append(dict(f=i, H=H.ravel().round(5).tolist(), cam_inliers=round(cm.inliers, 2), dets=out))
        if i % 25 == 0:
            progress(0.8 * i / max(1, meta["frames"]))
            print(f"  frame {i}/{meta['frames']}  {time.time() - t0:.0f}s", flush=True)
    raw = dict(meta=meta, prompts=rules["box_prompts"], track_people=rules["track_people"], frames=frames)
    os.makedirs(os.path.dirname(raw_path), exist_ok=True)
    json.dump(raw, open(raw_path, "w"))
    return raw


def corner(frame, box, col):
    """Thin box with emphasised corners: readable without hiding the product."""
    x1, y1, x2, y2 = (int(v) for v in box)
    cv2.rectangle(frame, (x1, y1), (x2, y2), col, 1, cv2.LINE_AA)
    n = max(8, min(x2 - x1, y2 - y1) // 5)
    for cx, cy, dx, dy in ((x1, y1, 1, 1), (x2, y1, -1, 1), (x1, y2, 1, -1), (x2, y2, -1, -1)):
        cv2.line(frame, (cx, cy), (cx + dx * n, cy), col, 3, cv2.LINE_AA)
        cv2.line(frame, (cx, cy), (cx, cy + dy * n), col, 3, cv2.LINE_AA)


def small(frame, text, org, color, scale=0.5):
    s = max(0.7, frame.shape[1] / 1920) * scale * 1.6
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, s, 1)
    x, y = int(org[0]), int(org[1])
    sub = frame[max(0, y - th - 6):y + 6, max(0, x - 5):x + tw + 5]
    if sub.size:
        sub[:] = (sub * 0.35).astype(sub.dtype)
    cv2.putText(frame, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, s, color, 1, cv2.LINE_AA)


def label(frame, text, org, color, scale=0.75):
    s = frame.shape[1] / 1920
    scale *= max(0.6, s)
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, 2)
    x, y = int(org[0]), int(org[1])
    cv2.rectangle(frame, (x - 4, y - th - 6), (x + tw + 4, y + 6), (25, 25, 25), -1)
    cv2.putText(frame, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2, cv2.LINE_AA)


def render(video, dst, evidence_dir, raw, cfg, engine, events, shelf_mon):
    """Annotated video for the dashboard plus one evidence still per movement event (and first/last sighting per track)."""
    meta = raw["meta"]
    W, Hh = meta["width"], meta["height"]
    os.makedirs(evidence_dir, exist_ok=True)
    tmp = dst + ".tmp.mp4"
    out = cv2.VideoWriter(tmp, cv2.VideoWriter_fourcc(*"mp4v"), meta["fps"], (W, Hh))
    by_frame = {}
    for st in engine.states:
        for o in st.e["obs"]:
            by_frame.setdefault(o.f, []).append((st, o))
    want = {}
    for ev in events:
        want.setdefault(ev["frame"], []).append(("event", ev))
    for st in engine.states:
        want.setdefault(st.e["obs"][0].f, []).append(("first", st))
        want.setdefault(st.e["obs"][-1].f, []).append(("last", st))
    snaps = {}
    counts = {}
    timeline = {s["id"]: s.get("timeline") for s in (shelf_mon.slots_full if shelf_mon else [])}
    for i, frame in video_loader.frames(video):
        H = np.array(raw["frames"][i]["H"]).reshape(3, 3)
        cfg.draw(frame, H)
        if cfg.roi:
            pts = cv2.perspectiveTransform(np.array([cfg.roi], np.float32), np.linalg.inv(H))[0].astype(np.int32)
            cv2.polylines(frame, [pts], True, (200, 200, 200), 1, cv2.LINE_AA)
        if shelf_mon:
            for s in shelf_mon.slots_full:
                state = (timeline.get(s["id"]) or ["unknown"] * meta["frames"])[i]
                x1, y1, x2, y2 = (int(v) for v in shelf_mon._in_frame(i, s["spot"]))
                cv2.rectangle(frame, (x1, y1), (x2, y2), SLOT_COLOR[state], 1, cv2.LINE_AA)
        here = {}
        for st, o in by_frame.get(i, []):
            here[st.name] = o
            if st.kind == "package" and getattr(st, "relevance", "monitored") != "monitored":
                continue
            col = KIND_COLOR["background" if getattr(st, "relevance", "monitored") != "monitored" else st.kind]
            corner(frame, o.bbox, col)
            small(frame, st.name.replace("Package ", "P").replace("Worker ", "W"), (o.bbox[0] + 4, max(18, o.bbox[1] - 6)), col)
        recent = [e for e in events if e["frame"] <= i and i - e["frame"] < meta["fps"] * 3]
        if recent:   # one quiet notice for three seconds after each movement
            e = recent[-1]
            what = {"shelf_addition": "Added to shelf", "shelf_removal": "Removed from shelf"}.get(e["type"], f"{(e.get('direction') or 'crossing').capitalize()} movement")
            small(frame, f"{what} - {e['track_ref']}" + ("" if e["verification"] == "confirmed" else " (needs review)"), (18, Hh - 20), (255, 255, 255), 0.6)
        for kind, obj in want.get(i, []):
            snap = frame.copy()
            if kind == "event":
                o = here.get(obj["track_ref"])
                box = o.bbox if o else None
                if box is None and shelf_mon and obj.get("slot_id"):
                    s = next(s for s in shelf_mon.slots_full if s["id"] == obj["slot_id"])
                    box = tuple(int(v) for v in shelf_mon._in_frame(i, s["spot"]))
                name = f"event_{obj['type']}_{obj['track_ref'].replace(' ', '_')}_{i}.jpg"
            else:
                o = here.get(obj.name)
                box = o.bbox if o else None
                name = f"{kind}_{obj.name.replace(' ', '_')}_{i}.jpg"
            if box is not None:
                cv2.rectangle(snap, (int(box[0]) - 8, int(box[1]) - 8), (int(box[2]) + 8, int(box[3]) + 8), (0, 0, 255), 6)
            cv2.imwrite(os.path.join(evidence_dir, name), cv2.resize(snap, (960, int(960 * Hh / W))), [cv2.IMWRITE_JPEG_QUALITY, 82])
            snaps[(kind, obj["event_key"] if kind == "event" else obj.name)] = name
        out.write(frame)
    out.release()
    to_h264(tmp, dst)
    return snaps


def track_payload(engine, summaries, sid_url, snaps, derived=None):
    rows = {r["track_ref"]: r for r in summaries}
    out = []
    for st in engine.states:
        if st.kind == "package" and getattr(st, "relevance", "monitored") != "monitored" and engine.cfg.rules["relevance"].get("enabled"):
            continue
        obs = st.e["obs"]
        step = max(1, len(obs) // 80)
        samples = [dict(t=round(o.f / engine.fps, 2), x=round(o.pos[0], 1), y=round(o.pos[1], 1), bbox=[int(v) for v in o.bbox], conf=round(o.conf, 3),
                        zone=engine.cfg.zone_of(*o.pos)) for o in obs[::step]]
        r = rows[getattr(st, "orig_name", st.name)]
        notes = [n for n in (r.get("uncertainty") or "").split("; ") if n]
        nd = sum((derived or {}).get(i, 0) for i in st.e["tracker_ids"])
        if nd:
            notes.append(f"box derived in {nd} frame(s): a stacked carton seen only as 'stack box minus the carton detected on top'")
        out.append(dict(trackRef=st.name, kind=st.kind, trackerIds=r["tracker_ids"], firstSeenS=round(r["first_seen"], 3), lastSeenS=round(r["last_seen"], 3),
                        meanConf=r["mean_conf"], status=r["status"], lossClass=r.get("loss_class") or None, route=[z for z in (r.get("route") or "").split(">") if z],
                        uncertainty=notes, samples=samples, relevance=getattr(st, "relevance", None) if engine.cfg.rules["relevance"].get("enabled") else None,
                        trackingQuality=getattr(st, "quality", None),
                        category=category(st),
                        evidence=dict(firstUrl=f"{sid_url}/evidence/{snaps[('first', st.name)]}" if ("first", st.name) in snaps else None,
                                      lastUrl=f"{sid_url}/evidence/{snaps[('last', st.name)]}" if ("last", st.name) in snaps else None)))
    for t in out:
        t["evidence"] = {k: v for k, v in t["evidence"].items() if v}
        for k in ("lossClass", "relevance", "trackingQuality", "category"):
            if t[k] is None:
                del t[k]
    return out


def camera_path(raw, every_s=0.25):
    """Reference -> image affine sampled over time; the UI maps ROI / lines / shelves through it so they stay on the belt."""
    fps, step = raw["meta"]["fps"], max(1, int(round(raw["meta"]["fps"] * every_s)))
    out = []
    for fr in raw["frames"][::step]:
        inv = np.linalg.inv(np.array(fr["H"], float).reshape(3, 3))
        out.append(dict(t=round(fr["f"] / fps, 2), m=[round(float(v), 4) for v in inv[:2].ravel()]))
    return out


def category(st):
    """COCO item classes (bottle, ...) are reliable categories; YOLO-World prompt labels are not, so those stay a generic package."""
    if st.kind != "package":
        return None
    names = [o.cls for o in st.e["obs"] if o.cls]
    top = max(set(names), key=names.count) if names else None
    return top if top in ("bottle", "backpack", "handbag", "suitcase", "cup") else "package"


def prepare(raw, cfg):
    """Fixed-camera override and the per-camera anchor point, applied to a (cached) raw YOLO pass."""
    rules = cfg.rules
    if rules.get("camera_motion") is False:
        # fixed camera: ignore the optical-flow estimate (it drifts in low light) and use image coordinates directly
        for fr in raw["frames"]:
            fr["H"] = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    keep = rules.get("crop_keep")
    if keep:   # the zoomed tiles are there to catch what the full frame misses (plastic bags); cartons cut by a tile edge are noise
        for fr in raw["frames"]:
            fr["dets"] = [d for d in fr["dets"] if d["id"] < 200000 or d["cls"] in keep]
    raw["groups"] = groups.decompose(raw, rules)
    bottom = rules.get("anchor") == "bottom_center"
    for fr in raw["frames"]:
        H = np.array(fr["H"], float).reshape(3, 3)
        for d in fr["dets"]:
            x1, y1, x2, y2 = d["bbox"]
            px, py = ((x1 + x2) / 2, y2) if d["cls"] == "person" or bottom else ((x1 + x2) / 2, (y1 + y2) / 2)
            if bottom and d.get("anchor_bbox"):   # carton on top of a stack: the stack's floor contact point
                px, py = (d["anchor_bbox"][0] + d["anchor_bbox"][2]) / 2, d["anchor_bbox"][3]
            v = H @ np.array([px, py, 1.0])
            d["pos"] = [round(v[0] / v[2], 1), round(v[1] / v[2], 1)]
    return raw


def analyse(video, cfg, fresh=False, progress=lambda p: None):
    """Detection (cached) -> identities -> relevance -> profile module. No Convex access: used by run_camera and the validation tests."""
    raw_path = cache_path(video, cfg.rules)
    raw = None
    if not fresh and os.path.exists(raw_path):
        raw = json.load(open(raw_path))
        print("stage 1: reusing cached YOLO pass", raw_path)
    if raw is None:
        print(f"stage 1: YOLOv8 + ByteTrack on {video}")
        raw = stage1_detect(video, cfg, raw_path, progress)
    raw = prepare(raw, cfg)
    meta = raw["meta"]
    print("stage 2: identities, zones, profile module:", cfg.profile)
    engine = Engine(cfg, meta, raw["frames"])
    result = engine.run()
    rel = relevance.classify(cfg, engine.states, meta["fps"])
    if cfg.rules["relevance"].get("enabled"):
        # only parcels that actually move through the monitored area are tracked objects; stock in the background is counted in
        # the stats but not published, drawn or numbered
        n = 0
        for st in engine.states:
            st.orig_name = st.name
            if st.kind == "package":
                if st.relevance == "monitored":
                    n += 1
                    st.name = f"Package {n}"
                else:
                    st.name = f"Background {st.name.split()[-1]}"
        rel = {st.name: rel[st.orig_name] for st in engine.states if st.orig_name in rel}
    shelf_mon = mov = None
    if cfg.profile == "shelf":
        shelf_mon = ShelfMonitor(cfg, engine.raw, meta, engine.states, engine.persons, video=video)
        events = shelf_mon.run()
    else:
        mov = MovementMonitor(cfg, meta, engine.states)
        events = mov.run()
    events.sort(key=lambda e: e["frame"])
    return dict(raw=raw, meta=meta, engine=engine, result=result, events=events, shelf_mon=shelf_mon, movement=mov, relevance=rel)


def event_key(camera_id, session_id, ev):
    raw = "|".join(str(x) for x in (camera_id, session_id, ev["type"], ev.get("location_id"), ev.get("slot_id") or ev.get("line_id"), ev["track_ref"], ev["frame"]))
    return hashlib.sha1(raw.encode()).hexdigest()[:24]


def run_camera(camera_id, fresh=False, bridge=None, job_id=None):
    br = bridge or Bridge()
    cam = br.camera(camera_id)
    if not cam:
        raise SystemExit(f"camera {camera_id} not found in Convex")
    cfg_dict = dict(cam["config"], profile=cam["profile"])
    errs = validate(cfg_dict)
    if errs:
        raise SystemExit("invalid camera config: " + "; ".join(errs))
    cfg = Config(cfg_dict)
    video = cam["source"]["uri"]
    video = video if os.path.isabs(video) else os.path.join(C.BASE, video)
    if not os.path.exists(video):
        raise SystemExit(f"video not found: {video}")
    recorded_at = cam["source"].get("recordedAt") or time.time() * 1000
    sid = session_id_for(camera_id, video, recorded_at)
    media = os.path.join(br.media_dir, sid)
    url = f"/media/{sid}"
    meta0 = video_loader.info(video)
    br.session(sessionId=sid, cameraId=camera_id, status="processing", progress=0.0, startedAt=recorded_at)

    def progress(p):
        br.session(sessionId=sid, cameraId=camera_id, status="processing", progress=round(p, 3), startedAt=recorded_at)
        if job_id:
            br.update_job(job_id, progress=round(p, 3), sessionId=sid)
    try:
        A = analyse(video, cfg, fresh, progress)
        raw, meta, engine, result, events, shelf_mon = A["raw"], A["meta"], A["engine"], A["result"], A["events"], A["shelf_mon"]
        shift = max(max(abs(fr["H"][2]), abs(fr["H"][5])) for fr in raw["frames"])
        for ev in events:
            ev["event_key"] = event_key(camera_id, sid, ev)
        progress(0.85)
        print(f"  {len(result['tracks'])} tracks, {len(events)} movement events")
        print("stage 3: render + evidence")
        os.makedirs(media, exist_ok=True)
        snaps = render(video, os.path.join(media, "processed.mp4"), os.path.join(media, "evidence"), raw, cfg, engine, events, shelf_mon)
        shutil.copyfile(video, os.path.join(media, "original" + os.path.splitext(video)[1]))
        progress(0.95)
        print("stage 4: publish to Convex")
        br.session(sessionId=sid, cameraId=camera_id, status="processing", progress=0.97, startedAt=recorded_at, durationS=meta["duration"], fps=meta["fps"],
                   width=meta["width"], height=meta["height"], originalUrl=f"{url}/original{os.path.splitext(video)[1]}", processedUrl=f"{url}/processed.mp4",
                   cameraPath=camera_path(raw), models=dict(packages=cfg.rules.get("world_weights") or os.path.basename(C.WORLD_WEIGHTS), prompts=cfg.rules["box_prompts"], people=os.path.basename(C.PERSON_WEIGHTS) if cfg.rules["track_people"] else None, tracker=cfg.rules.get("tracker") or C.TRACKER_CFG))
        br.tracks(sid, camera_id, track_payload(engine, result["tracks"], url, snaps, raw.get("groups", {}).get("derived_ids")))
        payload = []
        for ev in events:
            loc = ev.get("location_id")
            if not loc:
                print(f"  ! event {ev['type']} for {ev['track_ref']} has no location id on its shelf/line config; not published")
                continue
            p = dict(eventKey=ev["event_key"], locationId=loc, type=ev["type"], trackRef=ev["track_ref"], t=ev["t"], quantity=ev["quantity"],
                     verification=ev["verification"], reasons=ev["reasons"], confidence=ev.get("confidence"), actor=ev.get("actor"),
                     direction=ev.get("direction"), againstFlow=ev.get("against_flow"), detectionConf=ev.get("detection_conf"),
                     trackingQuality=ev.get("tracking_quality"), eventConf=ev.get("event_conf"), fromZone=ev.get("from_zone"), toZone=ev.get("to_zone"),
                     imageUrl=f"{url}/evidence/{snaps[('event', ev['event_key'])]}" if ("event", ev["event_key"]) in snaps else None)
            payload.append({k: v for k, v in p.items() if v is not None})
        res = br.events(sid, camera_id, payload, final=True)
        stats = dict(tracks=len(result["tracks"]), packages=sum(1 for t in result["tracks"] if t["kind"] == "package"), people=sum(1 for t in result["tracks"] if t["kind"] == "person"),
                     events=len(payload), confirmed=sum(1 for e in payload if e["verification"] == "confirmed"), uncertain=sum(1 for e in payload if e["verification"] == "uncertain"),
                     ignoredTracks=len(result["ignored"]), background=sum(1 for r in A["relevance"].values() if r["relevance"] != "monitored"), cameraShiftPx=round(shift), slots=len(shelf_mon.slots) if shelf_mon else None, notes=(shelf_mon.notes if shelf_mon else [])[:20])
        br.session(sessionId=sid, cameraId=camera_id, status="done", progress=1.0, startedAt=recorded_at, durationS=meta["duration"], stats=json.loads(json.dumps(stats, default=str)))
        print("published:", res)
        return sid, res
    except Exception as ex:
        traceback.print_exc()
        br.session(sessionId=sid, cameraId=camera_id, status="error", progress=0.0, startedAt=recorded_at, error=f"{type(ex).__name__}: {ex}")
        raise


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--camera", required=True)
    ap.add_argument("--fresh", action="store_true")
    a = ap.parse_args()
    run_camera(a.camera, fresh=a.fresh)
