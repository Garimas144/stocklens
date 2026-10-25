"""CV logic tests with hand-made detections (labelled test data, no video, no backend).
Shelf: addition, multiple removals, no movement, temporary occlusion, tracking loss with too little footage, box returned.
Movement: forward crossing, several packages, reverse movement, pausing on the line, back-and-forth (no double count).
Conveyor (ROI + relevance): stationary stock on the line, a box moving outside the ROI, a duplicate detection of one parcel,
creeping jitter across the line, and a real crossing next to background stock."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cameras
from cameras import Config
from event_engine import Engine
from shelf_monitor import ShelfMonitor
from movement_monitor import MovementMonitor

FPS, N = 25, 300
I = [1, 0, 0, 0, 1, 0, 0, 0, 1]
fails = 0
def check(cond, msg):
    global fails
    print(("PASS " if cond else "FAIL ") + msg); fails += 0 if cond else 1

def raw(boxes, n=N, people=()):
    """boxes: {track_id: [(frame_from, frame_to, (x1,y1,x2,y2))]}; always adds a static 'other' box so the detector looks alive."""
    frames = []
    for f in range(n):
        dets = [dict(cls="cardboard box", id=999, conf=0.8, bbox=[1500, 400, 1600, 500], pos=[1550, 450])]
        for tid, spans in boxes.items():
            for a, b, bb in spans:
                if a <= f <= b:
                    bb = bb(f) if callable(bb) else bb
                    dets.append(dict(cls="cardboard box", id=tid, conf=0.8, bbox=list(bb), pos=[(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2]))
        for pid, a, b, bb in people:
            if a <= f <= b:
                dets.append(dict(cls="person", id=pid, conf=0.9, bbox=list(bb), pos=[(bb[0] + bb[2]) / 2, bb[3]]))
        frames.append(dict(f=f, H=I, cam_inliers=1.0, dets=dets))
    return dict(meta=dict(fps=FPS, frames=n, width=1920, height=1080, duration=n / FPS), frames=frames)

def shelf(r):
    cfg = cameras.default_config("shelf")
    cfg["zones"] = [dict(id="s", label="S", role="shelf", polygon=[[100, 100], [1700, 100], [1700, 900], [100, 900]], location_id="L", fully_visible=True)]
    C = Config(cfg); e = Engine(C, r["meta"], r["frames"]); e.run()
    return ShelfMonitor(C, e.raw, r["meta"], e.states, e.persons).run()

A, B, Cb = (300, 300, 500, 500), (600, 300, 800, 500), (900, 300, 1100, 500)
worker = [(50, 90, 129, (250, 250, 650, 760))]
ev = shelf(raw({1: [(0, N - 1, A)], 2: [(0, N - 1, B)]}))
check(ev == [], "no movement -> no events")
ev = shelf(raw({1: [(0, 120, A)], 2: [(0, 160, B)], 3: [(0, N - 1, Cb)]}, people=[(50, 100, 160, (300, 250, 900, 760))]))
check(sorted(e["type"] for e in ev) == ["shelf_removal", "shelf_removal"] and all(e["verification"] == "confirmed" for e in ev), f"multiple removals -> 2 confirmed ({[e['type'] for e in ev]})")
ev = shelf(raw({1: [(0, 100, A), (125, N - 1, A)], 2: [(0, N - 1, B)]}))
check(ev == [], "temporary occlusion (1 s missing) -> no event")
ev = shelf(raw({1: [(0, 100, A), (190, N - 1, A)], 2: [(0, N - 1, B)]}))
check(ev == [], f"box removed and put back within 5 s -> no net movement ({[e['type'] for e in ev]})")
ev = shelf(raw({1: [(0, 100, A)], 2: [(0, N - 1, B)]}, n=130, people=worker))
check(len(ev) == 1 and ev[0]["verification"] == "uncertain", f"track lost near the end with a worker present -> uncertain, not counted ({[(e['type'], e['verification']) for e in ev]})")
ev = shelf(raw({1: [(0, N - 1, A)], 4: [(150, N - 1, Cb)]}, people=[(5, 120, 160, (850, 250, 1150, 760))]))
check([e["type"] for e in ev] == ["shelf_addition"] and ev[0]["verification"] == "confirmed", f"one addition ({[e['type'] for e in ev]})")

def belt(path_by_track, n=N):
    boxes = {tid: [(a, b, (lambda f, p=p: (p(f) - 40, 460, p(f) + 40, 540)))] for tid, (a, b, p) in path_by_track.items()}
    r = raw(boxes, n)
    cfg = cameras.default_config("movement")
    cfg["rules"] = dict(cfg["rules"], static_stock_filter=False, min_load_speed_px_per_frame=0)
    cfg["count_lines"] = [dict(id="g", label="Gate", p1=[960, 300], p2=[960, 700], forward=[1, 0], forward_means="outbound", location_id="X")]
    C = Config(cfg); e = Engine(C, r["meta"], r["frames"]); e.run()
    return MovementMonitor(C, r["meta"], e.states).run()

ev = belt({1: (0, 200, lambda f: 600 + 4 * f)})
check([(x["direction"], x["verification"]) for x in ev] == [("outbound", "confirmed")], "forward crossing -> 1 outbound")
ev = belt({1: (0, 200, lambda f: 600 + 4 * f), 2: (60, 260, lambda f: 600 + 4 * (f - 60)), 3: (120, 299, lambda f: 600 + 4 * (f - 120))})
check(len(ev) == 3, f"three packages -> 3 crossings ({len(ev)})")
ev = belt({1: (0, 200, lambda f: 1300 - 4 * f)})
check([x["direction"] for x in ev] == ["inbound"] and ev[0]["against_flow"], "reverse movement -> counted as inbound, flagged against flow")
ev = belt({1: (0, 299, lambda f: 600 + 4 * f if f < 90 else (960 + (3 if f % 2 else -3) if f < 200 else 960 + 4 * (f - 200)))})
check(len(ev) == 1, f"package pausing on the line -> counted once ({len(ev)})")
ev = belt({1: (0, 299, lambda f: 800 + 3 * f if f < 100 else (1100 - 3 * (f - 100) if f < 200 else 800 + 3 * (f - 200)))})
check(len(ev) == 1 and ev[0]["direction"] == "outbound", f"forward, back, forward -> one net outbound ({len(ev)})")
ev = belt({1: (0, 299, lambda f: 800 + 3 * f if f < 100 else 1100 - 3 * (f - 100))})
check(ev == [], "forward then back -> no net movement")

import relevance
def conveyor(boxes, n=N):
    """boxes: {tid: (from, to, x(f), y_center)}; ROI is the belt band y 400-600, line at x=960 spanning y 100-900."""
    r = raw({tid: [(a, b, (lambda f, p=p, y=y: (p(f) - 40, y - 40, p(f) + 40, y + 40)))] for tid, (a, b, p, y) in boxes.items()}, n)
    cfg = cameras.default_config("movement")
    roi = [[0, 400], [1920, 400], [1920, 600], [0, 600]]
    cfg["rules"] = dict(cfg["rules"], static_stock_filter=False, min_load_speed_px_per_frame=0, roi=roi, link_metric="iou",
                        relevance=dict(enabled=True, stationary_px=60.0, min_roi_fraction=0.5))
    cfg["rules"]["crossing"] = dict(hysteresis_px=15, confirm_frames=5, max_gap_frames=12, min_travel_px=60, travel_window_s=1.0, dedupe_s=0.7, dedupe_px=120, min_track_quality=0.5)
    cfg["count_lines"] = [dict(id="g", label="Gate", p1=[960, 100], p2=[960, 900], forward=[1, 0], forward_means="outbound", location_id="X")]
    C = Config(cfg); e = Engine(C, r["meta"], r["frames"]); e.run()
    rel = relevance.classify(C, e.states)
    return MovementMonitor(C, r["meta"], e.states).run(), rel

ev, rel = conveyor({1: (0, 200, lambda f: 600 + 4 * f, 500)})
check(len(ev) == 1 and ev[0]["verification"] == "confirmed" and ev[0]["event_conf"] > 0.5, f"conveyor: parcel crossing inside the ROI -> 1 confirmed event ({len(ev)})")
check(all(k in ev[0] for k in ("detection_conf", "tracking_quality", "event_conf")), "conveyor: detection, tracking and event confidence reported separately")
ev, rel = conveyor({1: (0, 299, lambda f: 965 + (3 if f % 2 else -3), 500)})
check(ev == [] and all(r["relevance"] == "background_static" for r in rel.values()), "conveyor: stationary box sitting on the line -> background, no event")
ev, rel = conveyor({1: (0, 200, lambda f: 600 + 4 * f, 250)})
check(ev == [] and "outside_roi" in [r["relevance"] for r in rel.values()], "conveyor: box carried across the line outside the ROI -> not counted")
ev, rel = conveyor({1: (0, 200, lambda f: 600 + 4 * f, 500), 2: (0, 200, lambda f: 625 + 4 * f, 505)})
check(len(ev) == 1, f"conveyor: one parcel detected twice under two tracker ids -> counted once ({len(ev)})")
ev, rel = conveyor({1: (0, 299, lambda f: 900 + 0.4 * f, 500)})
check(ev == [], f"conveyor: box creeping across the line (detector drift, 0.4 px/frame) -> no event ({[e['t'] for e in ev]})")
ev, rel = conveyor({1: (0, 200, lambda f: 600 + 4 * f, 500), 2: (0, 299, lambda f: 975, 450), 3: (0, 299, lambda f: 950, 250)})
check(len(ev) == 1 and ev[0]["tracker_ids"] == [1], f"conveyor: moving parcel among stationary stock -> only the parcel counts ({[e['tracker_ids'] for e in ev]})")
jit = lambda f: 960 + (-30 if (f // 20) % 2 == 0 else 30) if f < 280 else 990   # stock on the line, shaky camera, ends beyond it
ev, rel = conveyor({1: (0, 299, jit, 500)})
check(ev == [], f"conveyor: stationary stock jittering across the line (camera shake) -> no event ({len(ev)})")

import groups
G = cameras.COMMON_RULES["groups"]
fr = dict(f=0, dets=[dict(cls="cardboard box", id=1, conf=0.4, bbox=[100, 100, 300, 300]), dict(cls="cardboard box", id=2, conf=0.4, bbox=[300, 100, 500, 300]),
                     dict(cls="cardboard box", id=3, conf=0.2, bbox=[95, 98, 505, 302])])
st = groups.decompose(dict(frames=[fr]), dict(groups=G))
check([d["id"] for d in fr["dets"]] == [1, 2] and st["dropped"] == 1, "groups: a box around two detected cartons is dropped (both cartons stay)")
fr = dict(f=0, dets=[dict(cls="cardboard box", id=7, conf=0.5, bbox=[100, 100, 300, 500]), dict(cls="cardboard box", id=8, conf=0.5, bbox=[105, 100, 295, 290])])
groups.decompose(dict(frames=[fr]), dict(groups=G))
check(fr["dets"][0]["bbox"] == [100, 290, 300, 500] and fr["dets"][0].get("derived"), f"groups: stack box minus the detected top carton = bottom carton ({fr['dets'][0]['bbox']})")
fr = dict(f=0, dets=[dict(cls="cardboard box", id=9, conf=0.5, bbox=[100, 100, 300, 300]), dict(cls="cardboard box", id=10, conf=0.5, bbox=[180, 180, 240, 240])])
groups.decompose(dict(frames=[fr]), dict(groups=G))
check(fr["dets"][0]["bbox"] == [100, 100, 300, 300], "groups: a small label-sized box inside a carton does not split it")
# two stacked cartons wheeled across the line together -> two events (not merged as a duplicate)
r = raw({1: [(0, 200, lambda f: (560 + 4 * f, 420, 640 + 4 * f, 500))], 2: [(0, 200, lambda f: (560 + 4 * f, 500, 640 + 4 * f, 580))]})
cfg = cameras.default_config("movement")
cfg["rules"] = dict(cfg["rules"], static_stock_filter=False, min_load_speed_px_per_frame=0, roi=[[0, 400], [1920, 400], [1920, 600], [0, 600]], link_metric="iou",
                    relevance=dict(enabled=True, stationary_px=60.0, min_roi_fraction=0.5))
cfg["rules"]["crossing"] = dict(hysteresis_px=15, confirm_frames=5, max_gap_frames=12, min_travel_px=60, travel_window_s=1.0, dedupe_s=0.7, dedupe_px=120, min_track_quality=0.5)
cfg["count_lines"] = [dict(id="g", label="Gate", p1=[960, 100], p2=[960, 900], forward=[1, 0], forward_means="outbound", location_id="X")]
Cc = Config(cfg); e = Engine(Cc, r["meta"], r["frames"]); e.run(); relevance.classify(Cc, e.states)
ev = MovementMonitor(Cc, r["meta"], e.states).run()
check(len(ev) == 2, f"two stacked cartons crossing together -> 2 movements ({len(ev)})")
print("ALL LOGIC TESTS PASSED" if not fails else f"{fails} FAILED"); sys.exit(1 if fails else 0)
