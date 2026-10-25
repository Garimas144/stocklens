"""Profile-driven event engine shared by every camera.

Stage A  consolidate(): YOLO/ByteTrack ids fragment under occlusion. Tracks are linked into one identity when they overlap as
         duplicate detections or continue each other in reference space after a short gap. Slow package tracks are discarded as static
         stock on moving-camera footage. Identities are scoped to this one session.
Stage B  Engine: zone state machine (N-frame confirmation), checkpoint dwell, stalls, reverse flow, route and
         transition rules, worker contact, and loss classification that separates tracking loss from a confirmed missing package.
"""
import math
from collections import defaultdict
import numpy as np
import config as C
from utils import fmt, iou


class Obs:
    __slots__ = ("f", "bbox", "pos", "conf", "tid", "cls", "derived")

    def __init__(self, f, bbox, pos, conf, tid, cls=None, derived=None):
        self.f, self.bbox, self.pos, self.conf, self.tid, self.cls, self.derived = f, bbox, pos, conf, tid, cls, derived


def group_of(cls):
    return "person" if cls == "person" else "package"


def overlap(a, b, g, metric="containment"):
    """People: IoU. Packages: intersection over the smaller box (one carton inside a pallet detection is the same object), or IoU on
    shelf cameras, where a wide detection spanning two neighbouring boxes must not fuse them into one identity."""
    if g == "person" or metric == "iou":
        return iou(a, b)
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    return inter / max(1, min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])))


def _rect_gap(a, b):
    return math.hypot(max(0, max(a[0], b[0]) - min(a[2], b[2])), max(0, max(a[1], b[1]) - min(a[3], b[3])))


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


# ------------------------------------------------------------------ Stage A
def consolidate(raw_frames, rules):
    tracks = defaultdict(list)
    for fr in raw_frames:
        for d in fr["dets"]:
            g = group_of(d["cls"])
            tracks[(g, d["id"])].append(Obs(fr["f"], tuple(d["bbox"]), tuple(d["pos"]), d["conf"], d["id"], d["cls"], d.get("derived")))
    tracks = {k: sorted(v, key=lambda o: o.f) for k, v in tracks.items() if len(v) >= C.MIN_TRACK_DETS[k[0]]}

    ignored = []
    min_speed = rules.get("min_load_speed_px_per_frame", 0) if rules.get("static_stock_filter", True) else 0
    for k in [k for k in tracks if k[0] == "package"]:
        tr = tracks[k]
        net = _dist(tr[0].pos, tr[-1].pos)
        speed = net / max(1, tr[-1].f - tr[0].f)
        if min_speed and speed < min_speed and net < C.STATIONARY_PX:
            ignored.append(dict(track_ids=[k[1]], reason=f"static stock (net move {net:.0f}px, {speed:.1f}px/frame)", frames=[tr[0].f, tr[-1].f]))
            del tracks[k]

    parent = {k: k for k in tracks}
    find = lambda k: k if parent[k] == k else find(parent[k])
    for g in ("person", "package"):
        keys = sorted([k for k in tracks if k[0] == g], key=lambda k: tracks[k][0].f)
        for i, ka in enumerate(keys):
            for kb in keys[i + 1:]:
                a, b = tracks[ka], tracks[kb]
                fa = {o.f: o for o in a}
                ov = [(fa[o.f], o) for o in b if o.f in fa]
                if len(ov) >= 3:
                    if sum(overlap(x.bbox, y.bbox, g, rules.get("link_metric", "containment")) for x, y in ov) / len(ov) >= C.LINK_IOU[g]:
                        parent[find(kb)] = find(ka)
                    continue
                if min(a[-1].f - a[0].f, b[-1].f - b[0].f) < C.MIN_LINK_SPAN_FRAMES:
                    continue
                a_end, b_start = a[-1], b[0]
                gap = max(1, b_start.f - a_end.f)
                limit = min(C.LINK_MAX_DIST, C.LINK_BASE_DIST[g] + C.LINK_DIST_PER_FRAME * gap)
                max_gap = rules.get("link_max_gap_frames", {}).get(g, C.LINK_MAX_GAP_FRAMES[g])
                if b_start.f >= a_end.f - 2 and gap <= max_gap and _dist(a_end.pos, b_start.pos) <= limit:
                    parent[find(kb)] = find(ka)

    groups = defaultdict(list)
    for k in tracks:
        groups[find(k)].append(k)
    entities = []
    for keys in groups.values():
        g = keys[0][0]
        best = {}
        for k in keys:
            for o in tracks[k]:
                if o.f not in best or o.conf > best[o.f].conf:
                    best[o.f] = o
        obs = [best[f] for f in sorted(best)]
        if g == "package" and obs[-1].f - obs[0].f < C.MIN_LINK_SPAN_FRAMES:
            ignored.append(dict(track_ids=sorted(k[1] for k in keys), reason="short noise fragment", frames=[obs[0].f, obs[-1].f]))
            continue
        entities.append(dict(kind=g, obs=obs, tracker_ids=sorted(k[1] for k in keys)))
    entities.sort(key=lambda e: e["obs"][0].f)
    n = {"person": 0, "package": 0}
    for e in entities:
        n[e["kind"]] += 1
        e["name"] = f"{'Worker' if e['kind'] == 'person' else 'Package'} {n[e['kind']]}"
    return entities, ignored


# ------------------------------------------------------------------ Stage B
class State:
    def __init__(self, e):
        self.e, self.name, self.kind = e, e["name"], e["kind"]
        self.zone = None
        self.cand, self.cand_n, self.cand_start, self.cand_gap = None, 0, None, None
        self.zone_entry_f = None
        self.checkpoint_logged = False
        self.last_zone = None
        self.gaps, self.notes = [], []
        self.route = []
        self.exit = None             # 'left_view' | 'lost_inside'
        self.loss_class, self.loss_detail = "", ""
        self.visible_at_end = False
        self.mean_conf = 0.0
        self.visit = None            # open zone visit: dict(zone, enter_f, uncertain)


class Engine:
    def __init__(self, cfg, meta, raw_frames):
        self.cfg, self.rules = cfg, cfg.rules
        self.fps, self.n, self.W, self.Hh = meta["fps"], meta["frames"], meta["width"], meta["height"]
        self.raw = raw_frames if self.rules.get("track_people", True) else [dict(fr, dets=[d for d in fr["dets"] if d["cls"] != "person"]) for fr in raw_frames]
        self.states, self.events, self.positions, self.incidents, self.ignored = [], [], [], [], []
        self.visits, self.stalls = [], []
        self.checkpoint = cfg.zone_with_role("checkpoint") if self.rules.get("required_checkpoint") else None
        self.intake = cfg.zone_with_role("intake")
        self.dest = cfg.zone_with_role("destination")

    def t(self, f):
        return f / self.fps

    def log(self, st, f, typ, zone=None, detail=""):
        self.events.append(dict(track_ref=st.name, t=round(self.t(f), 3), frame=int(f), type=typ, zone=zone, detail=detail))

    def label(self, z):
        return self.cfg.label(z) if z else "unknown"

    def run(self):
        entities, self.ignored = consolidate(self.raw, self.rules)
        self.states = [State(e) for e in entities]
        self.persons = [s for s in self.states if s.kind == "person"]
        for st in self.states:
            self._process(st)
        for st in self.states:
            if st.kind == "package":
                self._motion_rules(st)
                self._contacts(st)
        tracks = [self._summarize(st) for st in self.states]
        if self.cfg.profile == "shelf":
            self.incidents = []      # shelf cameras raise inventory movements (shelf_monitor), not route/loss workflow alerts
        evidence = self._evidence()
        return dict(tracks=tracks, events=self.events, positions=self.positions, incidents=self.incidents, evidence=evidence, ignored=self.ignored,
                    visits=self.visits, stalls=self.stalls)

    # ---- zone state machine ----
    def _process(self, st):
        obs = st.e["obs"]
        if len(st.e["tracker_ids"]) > 1:
            st.notes.append(f"Identity built from {len(st.e['tracker_ids'])} detector tracks (#{', #'.join(map(str, st.e['tracker_ids']))}) linked by position continuity")
            self.log(st, obs[0].f, "IDENTITY_LINKED", detail=f"{len(st.e['tracker_ids'])} detector tracks merged into one identity")
        gap_f, prev = C.GAP_SECONDS * self.fps, None
        for o in obs:
            after_gap = None
            if prev is not None and o.f - prev.f > gap_f:
                st.gaps.append((prev.f, o.f))
                after_gap = prev.f
                self.log(st, prev.f, "OBSERVATION_GAP", detail=f"not detected from {fmt(self.t(prev.f))} to {fmt(self.t(o.f))}")
                st.notes.append(f"Not detected between {fmt(self.t(prev.f))} and {fmt(self.t(o.f))}")
            z = self.cfg.zone_of(*o.pos)
            self.positions.append(dict(track_ref=st.name, frame=o.f, t=round(self.t(o.f), 3), bbox=o.bbox, zone=z, conf=round(o.conf, 3), pos=o.pos))
            self._step_zone(st, z, o.f, after_gap)
            prev = o
        st.mean_conf = sum(o.conf for o in obs) / len(obs)
        st.visible_at_end = obs[-1].f >= self.n - 1 - C.END_MARGIN_FRAMES
        self._close_visit(st, obs[-1].f, exited=False)
        first = next(e for e in self.events if e["track_ref"] == st.name and e["type"] == "APPEARED")
        st.first_zone = first["zone"]
        fb = obs[0].bbox
        st.first_at_edge = fb[0] <= C.EDGE_MARGIN or fb[2] >= self.W - C.EDGE_MARGIN or fb[1] <= C.EDGE_MARGIN or fb[3] >= self.Hh - C.EDGE_MARGIN
        if st.kind == "package" and self.intake and first["zone"] in self.cfg.order and first["zone"] != self.intake:
            when = "when the clip started" if obs[0].f <= 2 else f"at {fmt(self.t(obs[0].f))}"
            self.log(st, obs[0].f, "FIRST_SEEN_MIDLINE", first["zone"], f"first detected in {self.label(first['zone'])} {when}; earlier stages were not observed")
            st.notes.append(f"First detected in {self.label(first['zone'])} {when}, so earlier stages were not observed")
        if st.kind == "package" and st.mean_conf < C.LOW_CONF:
            st.notes.append(f"Low detector confidence (mean {st.mean_conf:.2f})")
        if not st.visible_at_end:
            self._classify_loss(st)

    def _step_zone(self, st, z, f, after_gap):
        if z == st.cand:
            st.cand_n += 1
        else:
            st.cand, st.cand_n, st.cand_start, st.cand_gap = z, 1, f, after_gap
        if after_gap is not None and st.cand_n == 1:
            st.cand_gap = after_gap
        if st.cand_n >= C.CONFIRM_FRAMES and z != st.zone:
            f0, prev = st.cand_start, st.zone
            gap_note = f"first re-observed here after a gap that began at {fmt(self.t(st.cand_gap))}; exact entry time uncertain" if st.cand_gap is not None else ""
            if prev not in (None, "transit"):
                self._close_visit(st, f0, exited=True)
                dwell = self.t(f0 - st.zone_entry_f)
                if prev == self.checkpoint and not st.checkpoint_logged:
                    self.log(st, f0, "CHECKPOINT_SHORT", prev, f"left {self.label(prev)} after {dwell:.1f}s, below the {self.rules['min_dwell_s']:.0f}s minimum dwell")
                self.log(st, f0, "LEFT_ZONE", prev, f"after {dwell:.1f}s in zone")
            if z != "transit":
                self.log(st, f0, "APPEARED" if prev is None else "ENTERED_ZONE", z, gap_note)
                st.last_zone, st.zone_entry_f, st.checkpoint_logged = z, f0, False
                st.visit = dict(zone=z, enter_f=f0, uncertain=int(st.cand_gap is not None or prev is None))
                if not st.route or st.route[-1] != z:
                    st.route.append(z)
            elif prev is None:
                self.log(st, f0, "APPEARED", "transit")
            st.zone = z
        if self.checkpoint and st.zone == self.checkpoint and not st.checkpoint_logged and self.t(f - st.zone_entry_f) >= self.rules["min_dwell_s"]:
            st.checkpoint_logged = True
            self.log(st, f, "CHECKPOINT_VISIT", st.zone, f"remained in {self.label(st.zone)} >= {self.rules['min_dwell_s']:.0f}s (a verified visit, not proof an inspection was performed)")

    def _close_visit(self, st, exit_f, exited):
        v = st.visit
        if not v:
            return
        self.visits.append(dict(track_ref=st.name, zone=v["zone"], enter_t=round(self.t(v["enter_f"]), 3), exit_t=round(self.t(exit_f), 3),
                                enter_frame=int(v["enter_f"]), exit_frame=int(exit_f), dwell_s=round(self.t(exit_f - v["enter_f"]), 3),
                                entry_observed=int(not v["uncertain"]), exit_observed=int(exited)))
        st.visit = None

    # ---- loss classification ----
    def _speed_before_end(self, st, seconds=1.0):
        obs = st.e["obs"]
        tail = [o for o in obs if o.f >= obs[-1].f - int(seconds * self.fps)]
        if len(tail) < 2:
            return 0.0
        return _dist(tail[0].pos, tail[-1].pos) / max(1, tail[-1].f - tail[0].f)

    def _classify_loss(self, st):
        last, rules = st.e["obs"][-1], self.rules["missing"]
        x1, y1, x2, y2 = last.bbox
        m = C.EDGE_MARGIN
        where = st.last_zone or "unknown"
        if x1 <= m or y1 <= m or x2 >= self.W - m or y2 >= self.Hh - m:
            st.exit, st.loss_class = "left_view", "left_view"
            st.loss_detail = f"last detection touched the frame edge at {fmt(self.t(last.f))}"
            self.log(st, last.f, "LEFT_VIEW", where, st.loss_detail)
            return
        st.exit = "lost_inside"
        stationary = self._speed_before_end(st) < rules["stationary_px_per_frame"]
        lo, hi = last.f - 10, last.f + 5
        others = []
        for fr in self.raw[max(0, lo):hi + 1]:
            for d in fr["dets"]:
                if d["id"] in st.e["tracker_ids"] and group_of(d["cls"]) == st.kind:
                    continue
                others.append((d, fr["f"]))
        occluded = any(overlap(last.bbox, d["bbox"], "package") >= 0.25 for d, _ in others)
        worker = next((p.name for p in self.persons for o in p.e["obs"] if lo <= o.f <= hi and _rect_gap(o.bbox, last.bbox) <= self.rules["handling_distance_px"]), None)
        empty_s, in_view = self._empty_spot(st, last)
        window = (self.n - 1 - last.f) / self.fps
        if worker:
            st.loss_class = "with_worker"
            st.loss_detail = f"detections stopped at {fmt(self.t(last.f))} while {worker} was within reach; probably picked up (custody inferred from proximity)"
        elif occluded:
            st.loss_class = "tracking_loss"
            st.loss_detail = f"detections stopped at {fmt(self.t(last.f))} while another object overlapped it; likely occlusion"
        elif stationary and window >= rules["confirm_empty_seconds"] and in_view >= rules["min_view_fraction"] and empty_s >= rules["confirm_empty_seconds"]:
            st.loss_class = "missing_from_last_location"
            st.loss_detail = (f"was stationary in {self.label(where)} until {fmt(self.t(last.f))}; the spot stayed in view and showed no object for "
                              f"{empty_s:.1f}s until the video ended. Not at its last-known location; destination unknown")
        elif not stationary:
            st.loss_class = "tracking_loss"
            st.loss_detail = f"detections stopped at {fmt(self.t(last.f))} while it was still moving; likely detector miss or occlusion"
        else:
            st.loss_class = "tracking_loss"
            why = "too little footage after the loss to check the spot" if window < rules["confirm_empty_seconds"] else "the spot was out of view or not clearly empty"
            st.loss_detail = f"detections stopped at {fmt(self.t(last.f))}; {why}"
        self.log(st, last.f, "LOST_INSIDE" if st.loss_class != "missing_from_last_location" else "MISSING_FROM_LOCATION", where, st.loss_detail)
        if st.loss_class == "tracking_loss":
            st.notes.append(st.loss_detail)

    def _empty_spot(self, st, last):
        """Seconds the last-known spot was in view AND free of any detection after the track ended, and the in-view fraction."""
        cx, cy = last.pos
        w, h = last.bbox[2] - last.bbox[0], last.bbox[3] - last.bbox[1]
        empty = seen = total = 0
        for fr in self.raw[last.f + 1:]:
            total += 1
            H = np.array(fr["H"]).reshape(3, 3)
            v = np.linalg.inv(H) @ np.array([cx, cy, 1.0])
            x, y = v[0] / v[2], v[1] / v[2]
            if not (0.5 * w < x < self.W - 0.5 * w and 0.5 * h < y < self.Hh - 0.5 * h):
                continue
            seen += 1
            if not any(d["bbox"][0] <= x <= d["bbox"][2] and d["bbox"][1] <= y <= d["bbox"][3] for d in fr["dets"]):
                empty += 1
        if not total:
            return 0.0, 0.0
        return (empty / self.fps if seen and empty / seen >= 0.9 else 0.0), seen / total

    # ---- stalls and reverse flow ----
    def _motion_rules(self, st):
        obs = st.e["obs"]
        stall, rev, flow = self.rules["stall"], self.rules["reverse_flow"], self.rules.get("flow")
        back = still = 0
        for i, o in enumerate(obs):
            j0, j1 = max(0, i - 4), min(len(obs) - 1, i + 4)
            span = max(1, obs[j1].f - obs[j0].f)
            vx, vy = (obs[j1].pos[0] - obs[j0].pos[0]) / span, (obs[j1].pos[1] - obs[j0].pos[1]) / span
            zone = self.cfg.zone_of(*o.pos)
            if rev.get("enabled") and flow:
                along = vx * flow[0] + vy * flow[1]
                back = back + 1 if along < -rev["min_px_per_frame"] else 0
                if back == rev["min_frames"]:
                    self.log(st, o.f - back, "REVERSE_FLOW", zone, "moved against the belt direction for 0.5s+")
            if stall.get("enabled"):
                exempt = self.cfg.role(zone) in stall["exempt_zone_roles"] or zone == "transit"
                still = still + 1 if (math.hypot(vx, vy) < stall["max_speed_px_per_frame"] and not exempt) else 0
                if still == int(stall["min_seconds"] * self.fps):
                    self.log(st, o.f - still, "STALLED", zone, f"stood still in {self.label(zone)} for {stall['min_seconds']:.0f}s+ (below {stall['max_speed_px_per_frame']} px/frame)")

    # ---- worker contact ----
    def _contacts(self, st):
        if not self.persons:
            return
        obs = st.e["obs"]
        wobs = {}
        for p in self.persons:
            po, d = p.e["obs"], {}
            for i, o in enumerate(po):
                j0, j1 = max(0, i - 4), min(len(po) - 1, i + 4)
                d[o.f] = (o.bbox, _dist(po[j1].pos, po[j0].pos) / max(1, po[j1].f - po[j0].f))
            wobs[p.name] = d
        run_name, run_len, logged = None, 0, set()
        for i, o in enumerate(obs):
            j0, j1 = max(0, i - 4), min(len(obs) - 1, i + 4)
            moving = _dist(obs[j1].pos, obs[j0].pos) / max(1, obs[j1].f - obs[j0].f) > 2.5
            near = next((w for w, d in wobs.items() if o.f in d and d[o.f][1] > 2.5 and _rect_gap(d[o.f][0], o.bbox) <= self.rules["handling_distance_px"]), None)
            if moving and near:
                run_len = run_len + 1 if near == run_name else 1
                run_name = near
                if run_len == 10 and near not in logged:
                    logged.add(near)
                    self.log(st, o.f - 9, "WORKER_CONTACT", detail=f"{near} was moving next to this package from {fmt(self.t(o.f - 9))} (handling inferred from proximity)")
            else:
                run_name, run_len = None, 0

    # ---- derived status, incidents ----
    def _gaps_in(self, st, f0, f1):
        return [g for g in st.gaps if g[0] <= f1 and g[1] >= f0]

    def _inc(self, st, kind, severity, certainty, message, frame):
        self.incidents.append(dict(track_ref=st.name, kind=kind, severity=severity, certainty=certainty, message=message,
                                   t=round(self.t(frame), 3), frame=int(frame), fingerprint=f"{kind}|{st.name}"))

    def _summarize(self, st):
        obs = st.e["obs"]
        ev = [e for e in self.events if e["track_ref"] == st.name]
        row = dict(track_ref=st.name, kind=st.kind, tracker_ids=",".join(map(str, st.e["tracker_ids"])), first_seen=self.t(obs[0].f), last_seen=self.t(obs[-1].f),
                   first_frame=obs[0].f, last_frame=obs[-1].f, first_zone=st.first_zone, last_zone=st.last_zone, route=">".join(st.route),
                   loss_class=st.loss_class, loss_detail=st.loss_detail, mean_conf=round(st.mean_conf, 3), visible_at_end=int(st.visible_at_end),
                   visited_checkpoint=int(any(e["type"] == "CHECKPOINT_VISIT" for e in ev)))
        row["location"] = self._location(st)
        if st.kind == "person":
            row.update(status="Worker (package workflow rules do not apply)", state="info", uncertain=int(bool(st.notes)), uncertainty="; ".join(st.notes))
            return row
        in_zone = lambda zone: next((e["frame"] for e in ev if e["type"] in ("ENTERED_ZONE", "APPEARED") and e["zone"] == zone), None)
        first_of = lambda typ: next((e["frame"] for e in ev if e["type"] == typ), None)
        dest_f = in_zone(self.dest) if self.dest else None
        cp_f = in_zone(self.checkpoint) if self.checkpoint else None
        visited, short = row["visited_checkpoint"], first_of("CHECKPOINT_SHORT") is not None
        clip_start = obs[0].f <= 2
        if dest_f is not None and self.checkpoint:
            if visited:
                row.update(status="Reached destination after a verified checkpoint visit", state="ok")
            elif cp_f is not None or short:
                row.update(status="Reached destination; passed the checkpoint without the minimum dwell", state="alert")
                gaps = self._gaps_in(st, cp_f or dest_f, dest_f)
                self._inc(st, "CHECKPOINT_NOT_COMPLETED", "medium", "unverified" if gaps else "confirmed",
                          f"Entered {self.label(self.checkpoint)} but did not stay the {self.rules['min_dwell_s']:.0f}s minimum before reaching {self.label(self.dest)}."
                          + (" Observation gaps overlap this stretch, so the dwell may be under-measured." if gaps else " Tracked without gaps through the checkpoint."), first_of("CHECKPOINT_SHORT") or dest_f)
            else:
                row.update(status="Required checkpoint not observed", state="alert")
                last_before = max([o.f for o in obs if o.f < dest_f] or [obs[0].f])
                gaps = self._gaps_in(st, last_before, dest_f)
                first_in_dest = st.first_zone == self.dest
                shaky = gaps or (first_in_dest and clip_start) or st.mean_conf < C.LOW_CONF or (first_in_dest and st.first_at_edge)
                if first_in_dest:
                    why = ("First detected in the destination when the clip started, so its earlier path is unknown." if clip_start else
                           f"First detected inside {self.label(self.dest)}, never in earlier stages that were in view."
                           + (" It entered at the frame edge, so it may have come from outside the view." if st.first_at_edge else ""))
                else:
                    why = f"Reached {self.label(self.dest)} with no {self.label(self.checkpoint)} visit." + (" There were observation gaps on the way." if gaps else " Tracked without gaps.")
                self._inc(st, "SKIPPED_CHECKPOINT", "high", "unverified" if shaky else "confirmed", why, dest_f)
        elif dest_f is not None:
            row.update(status=f"Reached {self.label(self.dest)}", state="ok")
        else:
            row.update(status="In progress (still visible at end of video)" if st.visible_at_end else "Did not reach destination", state="pending" if st.visible_at_end else "alert")

        # loss classification -> incidents
        lc = st.loss_class
        dest_loss = st.last_zone == self.dest and not self.rules.get("destination_loss_is_incident", False)
        if lc == "left_view" and not dest_loss:
            row.update(status="Left camera view before completing its route; destination unknown", state="alert")
            self._inc(st, "LEFT_VIEW_EARLY", "medium", "confirmed", f"Observed leaving the frame edge in {self.label(st.last_zone)}; where it went is unknown.", obs[-1].f)
        elif lc == "missing_from_last_location":
            row.update(status="Missing from last-known location (confirmed); destination unknown", state="alert")
            self._inc(st, "MISSING_PACKAGE", "high", "confirmed", st.loss_detail[0].upper() + st.loss_detail[1:] + ".", obs[-1].f)
        elif lc == "with_worker":
            row.update(status="Probably removed by a worker (custody inferred)", state="alert")
            self._inc(st, "WORKER_CUSTODY", "low", "unverified", st.loss_detail[0].upper() + st.loss_detail[1:] + ". Confirm with the worker or the next scan.", obs[-1].f)
        elif lc == "tracking_loss" and not dest_loss:
            row.update(status="Visual tracking lost (not a confirmed disappearance)", state="alert")
            self._inc(st, "TRACKING_LOSS", "low", "unverified", st.loss_detail[0].upper() + st.loss_detail[1:] + ". Treat as lost sight, not as a missing package.", obs[-1].f)
        elif lc and dest_loss:
            st.notes.append("Detections ended at the destination (end of line or occluded); not treated as an incident")

        # route and transition rules
        rt = st.route
        for a, b in zip(rt, rt[1:]):
            if (a, b) in {tuple(p) for p in self.rules["forbidden_transitions"]}:
                self._inc(st, "UNEXPECTED_TRANSITION", "high", "unverified" if st.gaps else "confirmed",
                          f"Moved {self.label(a)} to {self.label(b)}, a configured forbidden transition.", next((e["frame"] for e in ev if e["type"] == "ENTERED_ZONE" and e["zone"] == b), obs[-1].f))
        routes = self.rules["expected_routes"]
        if routes and len(rt) >= 1 and not any(self._subseq(rt, r) for r in routes):
            self._inc(st, "UNEXPECTED_ROUTE", "high", "unverified" if (st.gaps or st.mean_conf < C.LOW_CONF) else "confirmed",
                      f"Observed route {' > '.join(self.label(z) for z in rt)} does not fit any expected route ({'; '.join(' > '.join(self.label(z) for z in r) for r in routes)}).", obs[-1].f)
        # motion incidents
        for typ, kind, msg in (("REVERSE_FLOW", "REVERSE_FLOW", "Moved against the belt direction."), ("STALLED", "STALLED", "Stood still on the line while the belt was expected to move (possible jam or manual removal).")):
            f = first_of(typ)
            if f is not None:
                gaps = self._gaps_in(st, f - int(3 * self.fps), f + int(3 * self.fps))
                self._inc(st, kind, "medium", "unverified" if (gaps or st.mean_conf < C.LOW_CONF) else "confirmed", msg + " Based on detected box motion.", f)
        row["uncertain"] = int(bool(st.notes))
        row["uncertainty"] = "; ".join(st.notes)
        if st.notes and not any(i["track_ref"] == st.name and i["kind"] == "UNCERTAIN_PATH" for i in self.incidents) and len(st.notes) >= 2:
            self._inc(st, "UNCERTAIN_PATH", "low", "unverified", "Path is partly inferred: " + "; ".join(st.notes[:3]) + (" ..." if len(st.notes) > 3 else ""), obs[0].f)
        return row

    @staticmethod
    def _subseq(observed, route):
        n = len(observed)
        return any(route[i:i + n] == observed for i in range(len(route) - n + 1))

    def _location(self, st):
        z, t = self.label(st.last_zone), fmt(self.t(st.e["obs"][-1].f))
        if st.visible_at_end:
            return f"{z} (still visible at end of video)"
        if st.loss_class == "left_view":
            return f"unknown (last seen in {z} at {t}, then left the camera view)"
        if st.loss_class == "missing_from_last_location":
            return f"unknown (confirmed absent from {z} where it was last seen at {t})"
        if st.loss_class == "with_worker":
            return f"probably with a worker (last seen in {z} at {t})"
        return f"uncertain (last seen in {z} at {t}, visual tracking then lost)"

    def _evidence(self):
        want = []
        for st in self.states:
            obs = st.e["obs"]
            want += [dict(track_ref=st.name, frame=obs[0].f, kind="first_seen"), dict(track_ref=st.name, frame=obs[-1].f, kind="last_seen")]
        for i in self.incidents:
            want.append(dict(track_ref=i["track_ref"], frame=i["frame"], kind=f"incident:{i['kind']}", fingerprint=i["fingerprint"]))
        for e in self.events:
            if e["type"] in ("LINE_CROSSING", "CHECKPOINT_VISIT"):
                want.append(dict(track_ref=e["track_ref"], frame=e["frame"], kind=e["type"].lower()))
        for w in want:
            w["t"] = round(self.t(w["frame"]), 3)
        return want
