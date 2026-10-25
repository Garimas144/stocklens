"""Movement-based monitoring: directional count lines -> unique, confirmed checkpoint crossings.

Per track and per line we follow which side of the line the box is on (signed distance along the line normal, oriented to the
line's `forward` vector). Samples within `hysteresis_px` of the line are ignored, and a side only counts once the box has been on
it for `confirm_frames` consecutive observations, so a box pausing on the line or jittering across it produces no crossings.
Every confirmed side change is an observation (forward or reverse). The counted movement per track and line is the NET result:
forward then back = nothing counted; forward, back, forward = one forward movement.

What may count (a detection is not a movement):
  * only tracks classified "monitored" by relevance.py (stationary background stock and boxes outside the ROI never count)
  * only observations whose anchor point lies inside the camera ROI
  * the box must travel at least `min_travel_px` across the line inside `travel_window_s` (real motion, not a jittering box)
  * crossings of one line within `dedupe_s` and `dedupe_px` of each other are one parcel whose tracker id changed; kept once

Three separate numbers go with every event: detection confidence (YOLO), tracking quality (relevance.tracking_quality) and event
confidence (how clearly the trajectory satisfies the rule). A crossing inferred across an observation gap, by weak detections or by a
poorly tracked identity is marked uncertain and is not counted toward reconciliation until an operator confirms it.
"""
import numpy as np
from utils import fmt, iou


class MovementMonitor:
    def __init__(self, cfg, meta, states):
        self.cfg, self.states = cfg, states
        self.p = cfg.rules["crossing"]
        self.fps = meta["fps"]
        self.events, self.observations, self.dropped = [], [], []

    def t(self, f):
        return f / self.fps

    def run(self):
        for ln in self.cfg.lines:
            evs = []
            for st in self.states:
                if st.kind == "package" and getattr(st, "relevance", "monitored") == "monitored":
                    ev = self._track(ln, st)
                    if ev:
                        evs.append(ev)
            self.events += self._dedupe(evs)
        return self.events

    def _geom(self, ln):
        p1, p2 = np.array(ln["p1"], float), np.array(ln["p2"], float)
        d = p2 - p1
        nrm = np.array([d[1], -d[0]]) / np.linalg.norm(d)
        if np.dot(nrm, np.array(ln["forward"], float)) < 0:
            nrm = -nrm
        return p1, d, nrm

    def _track(self, ln, st):
        p1, d, nrm = self._geom(ln)
        L2 = float(np.dot(d, d))
        obs = [o for o in st.e["obs"] if self.cfg.in_roi(*o.pos)]
        side, run_side, run_n, run_first, last_on_side_f = 0, 0, 0, None, None
        first_sd = None
        band = self.p.get("entry_band_px", 0)
        transitions = []
        sd_of = {}
        for o in obs:
            pt = np.array(o.pos)
            sd = float(np.dot(pt - p1, nrm))
            sd_of[o.f] = sd
            if first_sd is None:
                first_sd = sd
            along = float(np.dot(pt - p1, d) / L2)
            if abs(sd) < self.p["hysteresis_px"] or not (-0.15 <= along <= 1.15):
                continue
            s = 1 if sd > 0 else -1
            if s == run_side:
                run_n += 1
            else:
                run_side, run_n, run_first = s, 1, o
            if run_n == self.p["confirm_frames"]:
                if side and s != side:
                    gap = run_first.f - (last_on_side_f if last_on_side_f is not None else run_first.f)
                    transitions.append(dict(direction="forward" if s > 0 else "reverse", frame=run_first.f, gap_frames=gap, along=along))
                elif not side and band and first_sd is not None and -band <= -s * first_sd <= band:
                    # first detected ON the line, then confirmed beyond it: the approach side was never observed -> review only
                    transitions.append(dict(direction="forward" if s > 0 else "reverse", frame=run_first.f, gap_frames=0, along=along, entered_on_line=True))
                side = s
            if s == side:
                last_on_side_f = o.f
        if len(transitions) > 1 and transitions[0].get("entered_on_line"):
            transitions = transitions[1:]     # its approach was never observed; a later confirmed crossing tells the real story
        for tr in transitions:
            self.observations.append(dict(track_ref=st.name, line_id=ln["id"], line_label=ln["label"], t=round(self.t(tr["frame"]), 3),
                                          frame=tr["frame"], direction=tr["direction"]))
        net = sum(1 if tr["direction"] == "forward" else -1 for tr in transitions)
        if net == 0:
            return None
        sign = "forward" if net > 0 else "reverse"
        tr = [x for x in transitions if x["direction"] == sign][-1]
        f0 = tr["frame"]

        # physical travel across the line around the crossing
        w = int(self.p.get("travel_window_s", 1.0) * self.fps)
        before = [sd_of[f] for f in sd_of if f0 - w <= f < f0]
        after = [sd_of[f] for f in sd_of if f0 <= f <= f0 + w]
        travel = (max(after) - min(before)) if sign == "forward" and before and after else (max(before) - min(after)) if before and after else 0.0
        if travel < self.p.get("min_travel_px", 0):
            self.dropped.append(dict(track_ref=st.name, line_id=ln["id"], t=round(self.t(f0), 3), reason=f"moved only {travel:.0f}px across the line"))
            return None

        fwd_means = ln.get("forward_means", "outbound")
        direction = fwd_means if sign == "forward" else ("inbound" if fwd_means == "outbound" else "outbound")
        local = [o.conf for o in st.e["obs"] if abs(o.f - f0) <= 10]
        det_conf = sum(local) / len(local) if local else st.mean_conf
        quality = getattr(st, "quality", 1.0)
        n_side = sum(1 for f in sd_of if abs(f - f0) <= w)
        gap_ok = tr["gap_frames"] <= self.p["max_gap_frames"]
        event_conf = min(1.0, n_side / max(1, 2 * w)) * (1.0 if gap_ok else 0.5) * min(1.0, travel / max(1.0, 3 * self.p["hysteresis_px"]))

        uncertain = []
        reasons = [f"crossed {ln['label']} at {fmt(self.t(f0))}: on the {'far' if sign == 'forward' else 'near'} side for {self.p['confirm_frames']}+ observations, "
                   f"travelled {travel:.0f}px across the line inside the monitored region"]
        if len(transitions) > 1:
            reasons.append(f"{len(transitions)} side changes observed; counted once as the net movement")
        if len(transitions) > 3:
            uncertain.append(f"{len(transitions)} side changes: the box oscillated around the line instead of passing it")
        if tr.get("entered_on_line"):
            uncertain.append("first detected on the line; its approach was not observed, so the crossing cannot be confirmed")
        if not gap_ok:
            uncertain.append(f"crossing happened during a {tr['gap_frames'] / self.fps:.1f}s observation gap")
        if det_conf < self.p.get("min_detection_conf", 0.2):
            uncertain.append(f"weak detections around the crossing (mean confidence {det_conf:.2f})")
        if quality < self.p.get("min_track_quality", 0):
            uncertain.append(f"identity tracked unreliably (tracking quality {quality:.2f})")
        if sign == "reverse":
            reasons.append("moved against the configured counting direction")
        near = [o for o in st.e["obs"] if abs(o.f - f0) <= w]
        if any(o.derived for o in near):
            reasons.append("stacked carton: its box is the stack detection minus the carton detected on top of it (both seen in the same frames)")
        box = min(st.e["obs"], key=lambda o: abs(o.f - f0)).bbox
        return dict(type="checkpoint_crossing", line_id=ln["id"], line_label=ln["label"], location_id=ln.get("location_id"),
                    track_ref=st.name, tracker_ids=st.e["tracker_ids"], frame=int(f0), t=round(self.t(f0), 3),
                    quantity=1, direction=direction, against_flow=sign == "reverse",
                    verification="uncertain" if uncertain else "confirmed", confidence=round(det_conf, 3),
                    detection_conf=round(det_conf, 3), tracking_quality=round(quality, 3), event_conf=round(event_conf, 3),
                    along=tr["along"] * float(np.sqrt(L2)), box=box, reasons=reasons + uncertain, actor=None)

    def _dedupe(self, evs):
        """One parcel whose identity broke into two tracks can cross twice within a moment at the same point: keep one."""
        ds, dp = self.p.get("dedupe_s", 0), self.p.get("dedupe_px", 0)
        evs.sort(key=lambda e: e["t"])
        kept = []
        for e in evs:
            # same moment, same point on the line AND overlapping boxes: one parcel under two tracker ids. Two cartons crossing together
            # (stacked on one hand truck) have separate boxes and both count.
            twin = next((k for k in kept if ds and abs(k["t"] - e["t"]) <= ds and abs(k["along"] - e["along"]) <= dp and k["direction"] == e["direction"]
                         and iou(k["box"], e["box"]) >= 0.3), None)
            if twin:
                twin["reasons"].append(f"also crossed as {e['track_ref']} at {fmt(e['t'])} (same parcel, tracker id changed); counted once")
                self.dropped.append(dict(track_ref=e["track_ref"], line_id=e["line_id"], t=e["t"], reason=f"duplicate of {twin['track_ref']}"))
                continue
            kept.append(e)
        for e in kept:
            e.pop("along", None)
            e.pop("box", None)
        return kept
