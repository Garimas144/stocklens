"""Track relevance for movement cameras: separates "YOLO saw a package" from "this package can produce an inventory movement".

  monitored          spent most of its observed life inside the ROI and actually moved
  background_static  a valid detection that did not move (stock stacked behind a belt, parcels parked by a van)
  outside_roi        moved, but outside the monitored region (e.g. a worker carrying a box past the belt)
  fragment           too short (< min_seconds) or too weak (mean confidence < min_mean_conf) to be shown as a tracked parcel

A track that moved a little but mostly back and forth (path straightness < 0.3) and never went far from where it started (excursion
< 2 x stationary_px) is also stationary; a carton that is picked up, carried and loaded has a crooked path but a large excursion.
Displacement is measured between the median positions of the first and last fifth of the track (reference coordinates), so detector
jitter and camera-compensation residue do not look like movement. Shelf cameras never use this: stationary stock is what they count.

Tracking quality (0-1) is reported separately from detector confidence: fraction of frames inside the track span where the object
was actually observed, reduced when the identity had to be stitched from several tracker ids.
"""
import numpy as np


def displacement(obs):
    n = max(1, len(obs) // 5)
    a = np.median(np.array([o.pos for o in obs[:n]]), axis=0)
    b = np.median(np.array([o.pos for o in obs[-n:]]), axis=0)
    return float(np.linalg.norm(b - a))


def straightness(obs, step=5):
    """Net displacement / path length over positions sampled every `step` frames: ~1 for a parcel riding a belt, ~0 for a box that
    only jitters back and forth (camera shake, detector noise)."""
    pts = np.array([o.pos for o in obs[::step]] + [obs[-1].pos], float)
    path = float(np.linalg.norm(np.diff(pts, axis=0), axis=1).sum())
    return float(np.linalg.norm(pts[-1] - pts[0])) / path if path > 1e-6 else 0.0


def tracking_quality(st):
    obs = st.e["obs"]
    span = obs[-1].f - obs[0].f + 1
    coverage = len(obs) / max(1, span)
    frag = len(st.e["tracker_ids"])
    return round(coverage * (1.0 if frag <= 1 else 0.9 if frag == 2 else 0.75), 3)


def classify(cfg, states, fps=25.0):
    r = cfg.rules["relevance"]
    out = {}
    for st in states:
        if st.kind != "package":
            continue
        obs = st.e["obs"]
        disp = displacement(obs)
        straight = straightness(obs)
        start = np.median(np.array([o.pos for o in obs[:max(1, len(obs) // 5)]]), axis=0)
        excursion = float(max(np.linalg.norm(np.array(o.pos) - start) for o in obs[::3]))
        frac = sum(1 for o in obs if cfg.in_roi(*o.pos)) / len(obs)
        q = tracking_quality(st)
        if not r.get("enabled"):
            rel = "monitored"
        elif disp < r["stationary_px"] or (straight < 0.3 and excursion < 2 * r["stationary_px"]):
            rel = "background_static"
        elif cfg.roi and frac < r["min_roi_fraction"]:
            rel = "outside_roi"
        elif (obs[-1].f - obs[0].f) / fps < r.get("min_seconds", 0) or st.mean_conf < r.get("min_mean_conf", 0):
            rel = "fragment"
        else:
            rel = "monitored"
        st.relevance, st.quality = rel, q
        out[st.name] = dict(relevance=rel, displacement_px=round(disp, 1), straightness=round(straight, 2), excursion_px=round(excursion, 1), roi_fraction=round(frac, 2), tracking_quality=q)
    return out
