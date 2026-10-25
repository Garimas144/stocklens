"""Training-free handling of detections that cover several objects (applied per frame to the cached YOLO pass).

YOLO-World sometimes returns one box around several cartons as well as (or instead of) the individual cartons:

  group box   a box that contains two or more concurrent package detections which together cover most of it (two cartons side
              by side on a shelf). It duplicates objects that are already detected, so it is dropped.
  stack box   a box that contains exactly ONE concurrent detection spanning its width (or height), covering 20-75% of it: a
              stack of two cartons where only one is detected on its own (cartons on a hand truck). The box is replaced by the
              remainder (the box minus the detected carton's band), i.e. the other carton. The remainder is derived from two
              real detections, never invented, and is flagged `derived` so the UI and the event notes say so. The detected carton on top
              keeps its own box but takes the stack's contact point as its anchor (`anchor_bbox`), so both cartons cross a floor line together.

Nothing here can create an object YOLO did not see evidence of: a split needs the outer box AND an inner carton detected in the same frame.
"""


def _area(b):
    return max(0, b[2] - b[0]) * max(0, b[3] - b[1])


def _inside(a, b):
    """Fraction of box a inside box b."""
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    return max(0, x2 - x1) * max(0, y2 - y1) / max(1, _area(a))


def _coverage(parts, b, step=8):
    """Share of box b covered by the union of parts (coarse grid, enough for a yes/no decision)."""
    xs, ys = range(int(b[0]), int(b[2]), step), range(int(b[1]), int(b[3]), step)
    tot = hit = 0
    for x in xs:
        for y in ys:
            tot += 1
            hit += any(p[0] <= x <= p[2] and p[1] <= y <= p[3] for p in parts)
    return hit / max(1, tot)


def remainder(outer, inner, r):
    """Outer box minus the band occupied by inner, if inner spans the outer box across one axis; else None."""
    ow, oh = outer[2] - outer[0], outer[3] - outer[1]
    iw, ih = inner[2] - inner[0], inner[3] - inner[1]
    if iw >= r["span"] * ow:                                   # stacked vertically
        top = (inner[1] + inner[3]) / 2 < (outer[1] + outer[3]) / 2
        rem = [outer[0], inner[3], outer[2], outer[3]] if top else [outer[0], outer[1], outer[2], inner[1]]
        return rem if rem[3] - rem[1] >= r["min_rest"] * oh else None
    if ih >= r["span"] * oh:                                   # side by side
        left = (inner[0] + inner[2]) / 2 < (outer[0] + outer[2]) / 2
        rem = [inner[2], outer[1], outer[2], outer[3]] if left else [outer[0], outer[1], inner[0], outer[3]]
        return rem if rem[2] - rem[0] >= r["min_rest"] * ow else None
    return None


def _group_ids(raw, r):
    """Tracker ids that were a group box (2+ detected cartons inside, covering it) in at least `group_frames` of their frames:
    a pallet or a box around several cartons stays a group even in frames where only one carton inside it is detected."""
    seen, hits = {}, {}
    for fr in raw["frames"]:
        pk = [d for d in fr["dets"] if d["cls"] != "person"]
        for B in pk:
            seen[B["id"]] = seen.get(B["id"], 0) + 1
            b = B["bbox"]
            parts = [A["bbox"] for A in pk if A is not B and _inside(A["bbox"], b) >= r["part_inside"] and _area(A["bbox"]) <= r["max_part"] * _area(b)]
            if len(parts) >= 2 and _coverage(parts, b) >= r["group_cover"]:
                hits[B["id"]] = hits.get(B["id"], 0) + 1
    return {i for i, n in hits.items() if n >= r.get("group_frames", 0.2) * seen[i]}


def decompose(raw, rules):
    """Edit raw["frames"][*]["dets"] in place. Returns {"dropped": n, "split": n, "derived_ids": {track_id: frames}}."""
    r = rules.get("groups") or {}
    stats = dict(dropped=0, split=0, derived_ids={})
    if not r.get("enabled"):
        return stats
    group_ids = _group_ids(raw, r)
    stats["group_ids"] = sorted(group_ids)
    last = {}   # outer track id -> (frame, remainder as fractions of the outer box): a split persists through brief misses of the top carton
    hold = int(r.get("hold_s", 0.5) * raw.get("meta", {}).get("fps", 25))
    for fr in raw["frames"]:
        drop = {id(d) for d in fr["dets"] if d["cls"] != "person" and d["id"] in group_ids}
        stats["dropped"] += len(drop)
        pk = [d for d in fr["dets"] if d["cls"] != "person" and id(d) not in drop]
        for B in sorted(pk, key=lambda d: -_area(d["bbox"])):
            b = B["bbox"]
            parts = [A for A in pk if A is not B and id(A) not in drop and _inside(A["bbox"], b) >= r["part_inside"]
                     and _area(A["bbox"]) <= r["max_part"] * _area(b)]
            if len(parts) >= 2 and _coverage([A["bbox"] for A in parts], b) >= r["group_cover"]:
                drop.add(id(B))
                stats["dropped"] += 1
            elif r.get("split", True) and len(parts) == 1 and _area(parts[0]["bbox"]) >= r["min_part"] * _area(b):
                rem = remainder(b, parts[0]["bbox"], r)
                if rem:
                    w, h = max(1, b[2] - b[0]), max(1, b[3] - b[1])
                    last[B["id"]] = (fr["f"], [(rem[0] - b[0]) / w, (rem[1] - b[1]) / h, (rem[2] - b[0]) / w, (rem[3] - b[1]) / h])
                    # the carton on top touches the floor (belt, hand truck) through the stack: it moves with the stack's contact point
                    parts[0]["anchor_bbox"] = list(b)
                    B["bbox"] = [int(v) for v in rem]
                    B["derived"] = f"stack split: outer box minus carton {parts[0]['id']}"
                    stats["split"] += 1
                    stats["derived_ids"][B["id"]] = stats["derived_ids"].get(B["id"], 0) + 1
            if not B.get("derived") and id(B) not in drop and B["id"] in last and fr["f"] - last[B["id"]][0] <= hold and r.get("split", True):
                q = last[B["id"]][1]; w, h = b[2] - b[0], b[3] - b[1]
                B["bbox"] = [int(b[0] + q[0] * w), int(b[1] + q[1] * h), int(b[0] + q[2] * w), int(b[1] + q[3] * h)]
                B["derived"] = "stack split held from a split up to 0.5 s earlier (top carton briefly undetected)"
                stats["split"] += 1
                stats["derived_ids"][B["id"]] = stats["derived_ids"].get(B["id"], 0) + 1
        fr["dets"] = [d for d in fr["dets"] if id(d) not in drop]
    return stats
