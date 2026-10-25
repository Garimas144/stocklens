"""Shelf-level inventory monitoring: confirmed additions and removals from slot occupancy over time.

Why slots and not tracks: on real CCTV a box being handled is occluded, re-detected under new tracker ids, fused with its neighbour
into one wide detection, or flickers for a frame. Counting track starts and ends would invent movements. Instead:

1. Slot discovery. Wherever a tracked box rests inside a shelf polygon for >= slot_min_rest_s, that resting box defines a slot
   (a spot in reference coordinates, so camera drift and zoom are compensated). Overlapping spots are merged.
2. Per-frame slot observation (an OBSERVATION, not an event):
     occupied  a package detection overlaps the slot (IoU >= spot_iou) or sits on its core
     empty     the slot is fully in view, the detector is seeing other boxes in that frame, and nothing covers the slot core
     unknown   anything else: slot partly outside the image, detector saw nothing at all, a person in front of the shelf covers it,
               or the evidence is ambiguous
3. Per-slot state machine (the INFERRED physical event):
     removal   confirmed-occupied (>= settle_s) -> empty for >= absence_confirm_s      (event time = last moment it was seen there)
     addition  confirmed-empty (>= prior_empty_s) -> occupied for >= settle_s            (event time = first moment it was seen there)
   Unknown frames never advance either confirmation, so occlusion and one-frame drop-outs cannot change the count.
   A removal followed by an addition in the same slot within return_window_s is a box put back: both are cancelled.
   An empty run that starts with a worker at the slot but is cut off by the end of the footage becomes an UNCERTAIN removal,
   which is stored for review and never changes the estimate until an operator confirms it.
4. Duplicate suppression: the same type of event from overlapping slots within 1 s is one physical movement.

Depth heuristic (documented limitation): a person counts as an occluder only if their box extends below the shelf's lower edge
(standing in front of the shelf). A person whose box is cut off by the shelf is behind it and is seen through the gap.
Nothing here edits inventory records; Convex reconciles and an operator approves corrections.
"""
import math
import numpy as np
from utils import fmt, iou


def _scale(H):
    return math.sqrt(abs(np.linalg.det(np.asarray(H)[:2, :2])))


def _ncc(a, b):
    a, b = a - a.mean(), b - b.mean()
    d = math.sqrt(float((a * a).sum()) * float((b * b).sum()))
    return float((a * b).sum()) / d if d > 1e-6 else 0.0


class ShelfMonitor:
    PATCH = 40

    def __init__(self, cfg, raw_frames, meta, states, persons, video=None):
        self.cfg, self.raw, self.states, self.persons, self.video = cfg, raw_frames, states, persons, video
        self.p = cfg.rules["shelf"]
        self.fps, self.n, self.W, self.H = meta["fps"], meta["frames"], meta["width"], meta["height"]
        self.Hs = [np.array(fr["H"]).reshape(3, 3) for fr in raw_frames]
        self.entity_of = {}
        for st in states:
            for o in st.e["obs"]:
                self.entity_of[(st.kind, o.tid, o.f)] = st.name
        self.events, self.notes, self.slots, self.slots_full = [], [], [], []

    def t(self, f):
        return f / self.fps

    # ---------------------------------------------------------------- geometry
    def _to_ref(self, f, bbox):
        H = self.Hs[f]
        v = H @ np.array([(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2, 1.0])
        s = _scale(H)
        return (v[0] / v[2], v[1] / v[2]), ((bbox[2] - bbox[0]) * s, (bbox[3] - bbox[1]) * s)

    def _in_frame(self, f, spot):
        (cx, cy), (w, h) = spot
        inv = np.linalg.inv(self.Hs[f])
        v = inv @ np.array([cx, cy, 1.0])
        s = 1.0 / _scale(self.Hs[f])
        x, y, ww, hh = v[0] / v[2], v[1] / v[2], w * s, h * s
        return (x - ww / 2, y - hh / 2, x + ww / 2, y + hh / 2)

    def _shelf_bottom(self, f, shelf):
        inv = np.linalg.inv(self.Hs[f])
        ys = [(inv @ np.array([x, y, 1.0])) for x, y in shelf["polygon"]]
        return max(v[1] / v[2] for v in ys)

    # ---------------------------------------------------------------- slots
    def _discover(self, shelf):
        """Rest runs: consecutive observations whose median-smoothed centre stays within a quarter box-width of where the run began.
        Smoothing absorbs the bbox jitter of real detections (a box briefly fused with its neighbour, partial boxes)."""
        min_rest = int(self.p["slot_min_rest_s"] * self.fps)
        spots = []
        for st in self.states:
            if st.kind != "package":
                continue
            obs = [o for o in st.e["obs"] if self.cfg.inside(shelf["id"], *o.pos)]
            if len(obs) < 3:
                continue
            refs = [self._to_ref(o.f, o.bbox) for o in obs]
            sm = []
            for i in range(len(obs)):
                win = refs[max(0, i - 12):i + 13]
                sm.append((float(np.median([r[0][0] for r in win])), float(np.median([r[0][1] for r in win])), float(np.median([r[1][0] for r in win]))))
            i = 0
            while i < len(obs):
                j = i
                while j + 1 < len(obs) and obs[j + 1].f - obs[j].f <= int(self.fps) and math.dist(sm[j + 1][:2], sm[i][:2]) <= 0.25 * sm[i][2]:
                    j += 1
                if obs[j].f - obs[i].f >= min_rest:
                    run = list(range(i, j + 1))
                    spot = ((float(np.median([refs[k][0][0] for k in run])), float(np.median([refs[k][0][1] for k in run]))),
                            (float(np.median([refs[k][1][0] for k in run])), float(np.median([refs[k][1][1] for k in run]))))
                    edge = sum(1 for k in run if obs[k].bbox[0] <= 4 or obs[k].bbox[1] <= 4 or obs[k].bbox[2] >= self.W - 4 or obs[k].bbox[3] >= self.H - 4) > 0.5 * len(run)
                    spots.append(dict(spot=spot, track_ref=st.name, rest=(obs[i].f, obs[j].f), edge=edge))
                i = j + 1
        slots = []
        for sp in sorted(spots, key=lambda s: -(s["rest"][1] - s["rest"][0])):
            box = self._ref_box(sp["spot"])
            if any(iou(box, self._ref_box(s["spot"])) >= 0.5 for s in slots):
                continue
            sp["id"] = f"{shelf['id']}#{len(slots) + 1}"
            slots.append(sp)
        return slots

    @staticmethod
    def _ref_box(spot):
        (cx, cy), (w, h) = spot
        return (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)

    def _observe(self, f, slot, shelf):
        """occupied / empty / unknown for one slot in one frame, plus the detection that occupies it."""
        box = self._in_frame(f, slot["spot"])
        w, h = box[2] - box[0], box[3] - box[1]
        inside = max(0, min(box[2], self.W) - max(box[0], 0)) * max(0, min(box[3], self.H) - max(box[1], 0)) / max(1.0, w * h)
        if inside < 0.95 or slot["edge"]:
            return "unknown", None
        core = (box[0] + 0.2 * w, box[1] + 0.2 * h, box[2] - 0.2 * w, box[3] - 0.2 * h)
        core_area = (core[2] - core[0]) * (core[3] - core[1])
        dets = [d for d in self.raw[f]["dets"] if d["cls"] != "person"]
        for d in sorted(dets, key=lambda d: -iou(box, d["bbox"])):
            b = d["bbox"]
            cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
            area = (b[2] - b[0]) * (b[3] - b[1])
            if iou(box, b) >= self.p["spot_iou"] or (core[0] <= cx <= core[2] and core[1] <= cy <= core[3] and area >= 0.3 * w * h):
                return "occupied", d
        ncc = slot.get("ncc", [None] * self.n)[f] if slot.get("ncc") else None
        if ncc is not None and ncc >= self.p["appearance_same"]:
            return "occupied", None                      # looks unchanged: the box is there, the detector missed it
        bottom = self._shelf_bottom(f, shelf)
        for d in self.raw[f]["dets"]:
            if d["cls"] == "person" and d["bbox"][3] > bottom + 0.05 * self.H:          # standing in front of the shelf
                b = d["bbox"]
                cov = max(0, min(b[2], core[2]) - max(b[0], core[0])) * max(0, min(b[3], core[3]) - max(b[1], core[1])) / max(1.0, core_area)
                if cov >= 0.4:
                    return "unknown", None
        for d in dets:
            b = d["bbox"]
            cov = max(0, min(b[2], core[2]) - max(b[0], core[0])) * max(0, min(b[3], core[3]) - max(b[1], core[1])) / max(1.0, core_area)
            if cov >= 0.5 or iou(box, b) >= 0.2:
                return "unknown", None
        if ncc is None:
            return ("empty", None) if dets else ("unknown", None)   # no appearance cue: fall back to detections, require a live detector
        return ("empty", None) if ncc <= self.p["appearance_changed"] else ("unknown", None)

    def _actor(self, f0, f1, slot):
        box = self._in_frame(min(max(f0, 0), self.n - 1), slot["spot"])
        pad = 40
        for p in self.persons:
            for o in p.e["obs"]:
                b = o.bbox
                if f0 <= o.f <= f1 and not (b[2] < box[0] - pad or b[0] > box[2] + pad or b[3] < box[1] - pad or b[1] > box[3] + pad):
                    return p.name
        return None

    def _who(self, f, det):
        if det is None:
            return None
        return self.entity_of.get(("package", det["id"], f))

    # ---------------------------------------------------------------- appearance
    def _appearance(self, slots):
        """Second, independent cue: does the slot still look like it did while the box rested there? Normalised cross-correlation of a
        blurred grey patch against the median patch from the rest period. Catches detector misses (box still there) and confirms
        that an empty-looking slot really changed."""
        import cv2
        import video_loader
        if not self.video or not slots:
            return
        P = self.PATCH
        patches = {s["id"]: [None] * self.n for s in slots}
        for f, frame in video_loader.frames(self.video):
            if f >= self.n:
                break
            g = None
            for s in slots:
                x1, y1, x2, y2 = (int(round(v)) for v in self._in_frame(f, s["spot"]))
                if x1 < 0 or y1 < 0 or x2 > self.W or y2 > self.H or x2 - x1 < 8 or y2 - y1 < 8:
                    continue
                if g is None:
                    g = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (5, 5), 0)
                patches[s["id"]][f] = cv2.resize(g[y1:y2, x1:x2], (P, P), interpolation=cv2.INTER_AREA).astype(np.float32)
        for s in slots:
            ps = patches[s["id"]]
            rest = [ps[f] for f in range(s["rest"][0], min(s["rest"][1] + 1, self.n)) if ps[f] is not None]
            if len(rest) < 3:
                continue
            ref = np.median(np.stack(rest), axis=0)
            s["ncc"] = [None if p is None else _ncc(p, ref) for p in ps]

    # ---------------------------------------------------------------- main
    def run(self):
        for shelf in self.cfg.shelves:
            slots = self._discover(shelf)
            self._appearance(slots)
            self.slots += [dict(id=s["id"], shelf_id=shelf["id"], track_ref=s["track_ref"], spot=s["spot"], partial=s["edge"]) for s in slots]
            for slot in slots:
                self._slot(shelf, slot)
            self.slots_full += slots
        self._dedupe()
        return self.events

    def _slot(self, shelf, slot):
        p, fps = self.p, self.fps
        settle, absence, prior = int(p["settle_s"] * fps), int(p["absence_confirm_s"] * fps), int(p["prior_empty_s"] * fps)
        state = None                                  # confirmed 'occupied' | 'empty' | None (not yet known)
        occ_run = emp_run = 0
        occ_first = emp_first = occ_det = None
        last_occ_f, last_occ_det = None, None
        pending = []                                  # events of this slot, for return-window cancellation
        timeline = []
        for f in range(self.n):
            obs, det = self._observe(f, slot, shelf)
            timeline.append(obs)
            if obs == "occupied":
                if occ_run == 0:
                    occ_first, occ_det = f, det
                occ_run += 1
                emp_run = 0
                last_occ_f, last_occ_det = f, det
            elif obs == "empty":
                if emp_run == 0:
                    emp_first = f
                emp_run += 1
                occ_run = 0
            # unknown: neither run advances nor resets
            if state != "occupied" and occ_run >= settle:
                if state == "empty":
                    who = self._who(occ_first, occ_det)
                    actor = self._actor(occ_first - int(1.5 * fps), occ_first + int(0.5 * fps), slot)
                    pending.append(dict(type="shelf_addition", frame=occ_first, verification="confirmed", track_ref=who or slot["track_ref"], actor=actor,
                                        reasons=[f"slot {slot['id']} was confirmed empty, then occupied from {fmt(self.t(occ_first))} for {p['settle_s']:.0f}s+"]
                                        + ([f"{actor} was at the slot just before"] if actor else [])))
                state = "occupied"
            elif state != "empty" and emp_run >= (absence if state == "occupied" else prior):
                if state == "occupied":
                    f_rm = last_occ_f if last_occ_f is not None else emp_first
                    actor = self._actor(f_rm - int(1.5 * fps), emp_first + int(1.5 * fps), slot)
                    who = self._who(last_occ_f, last_occ_det) if last_occ_det else slot["track_ref"]
                    pending.append(dict(type="shelf_removal", frame=f_rm, verification="confirmed", track_ref=who or slot["track_ref"], actor=actor,
                                        reasons=[f"slot {slot['id']} was confirmed occupied; box last seen there at {fmt(self.t(f_rm))}",
                                                 f"the slot then stayed fully in view for {p['absence_confirm_s']:.0f}s+ with no box detected on it and no longer looking like it did while the box rested there"]
                                        + ([f"{actor} was at the slot when it emptied"] if actor else [])))
                state = "empty"
        # end of footage: an empty run in progress that was too short to confirm
        if state == "occupied" and 0 < emp_run < absence:
            f_rm = last_occ_f if last_occ_f is not None else emp_first
            actor = self._actor(f_rm - int(1.5 * fps), self.n - 1, slot)
            if actor:
                pending.append(dict(type="shelf_removal", frame=f_rm, verification="uncertain", track_ref=self._who(last_occ_f, last_occ_det) or slot["track_ref"], actor=actor,
                                    reasons=[f"slot {slot['id']} emptied at {fmt(self.t(emp_first))} while {actor} was there",
                                             f"only {emp_run / fps:.1f}s of footage afterwards (need {p['absence_confirm_s']:.0f}s), so the removal is not confirmed"]))
        # put back within the return window: cancel both
        keep = []
        for ev in sorted(pending, key=lambda e: e["frame"]):
            if ev["type"] == "shelf_addition" and keep and keep[-1]["type"] == "shelf_removal" and keep[-1]["verification"] == "confirmed" \
                    and self.t(ev["frame"] - keep[-1]["frame"]) <= p["return_window_s"]:
                rm = keep.pop()
                self.notes.append(dict(slot=slot["id"], t=self.t(rm["frame"]), note=f"box left the slot at {fmt(self.t(rm['frame']))} and was back at {fmt(self.t(ev['frame']))}; no movement counted"))
                continue
            keep.append(ev)
        for ev in keep:
            self.events.append(dict(ev, shelf_id=shelf["id"], shelf_label=shelf["label"], location_id=shelf.get("location_id"), slot_id=slot["id"],
                                    t=round(self.t(ev["frame"]), 3), quantity=1, confidence=self._conf(ev["track_ref"]),
                                    spot=dict(ref_center=[round(v, 1) for v in slot["spot"][0]], ref_size=[round(v, 1) for v in slot["spot"][1]])))
        slot["timeline"] = timeline

    def _conf(self, track_ref):
        st = next((s for s in self.states if s.name == track_ref), None)
        return round(st.mean_conf, 3) if st else None

    def _dedupe(self):
        out = []
        for ev in sorted(self.events, key=lambda e: e["frame"]):
            box = self._ref_box((tuple(ev["spot"]["ref_center"]), tuple(ev["spot"]["ref_size"])))
            dup = next((o for o in out if o["type"] == ev["type"] and o["shelf_id"] == ev["shelf_id"] and abs(o["t"] - ev["t"]) <= 1.0
                        and iou(box, self._ref_box((tuple(o["spot"]["ref_center"]), tuple(o["spot"]["ref_size"])))) > 0.1), None)
            if dup:
                dup["reasons"] = dup["reasons"] + [f"also observed in overlapping slot {ev['slot_id']}; counted once"]
                continue
            out.append(ev)
        self.events = out
