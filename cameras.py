"""Camera profiles. A camera owns its zones, shelves, count lines and thresholds; the backend (YOLO, tracker, engine) is shared.

Profiles
  shelf     Shelf-level inventory monitoring: shelf polygons tied to inventory locations; confirmed additions / removals.
  movement  Movement-based reconciliation: directional count lines tied to checkpoints (conveyor, dock, dispatch).

Zone roles: shelf (a monitored storage location), intake, checkpoint, destination, neutral.
Configs are stored in Convex (the system of record); this module only validates them and does geometry.
"""
import copy
import json
import cv2
import numpy as np

PROFILES = ["shelf", "movement"]
PROFILE_LABELS = {"shelf": "Shelf monitoring", "movement": "Movement monitoring"}
LEGACY_PROFILES = {"conveyor": "movement", "storage": "shelf"}
ROLES = ["shelf", "intake", "checkpoint", "destination", "neutral"]
ZONE_COLORS = {"shelf": (255, 120, 200), "intake": (255, 170, 60), "checkpoint": (60, 220, 255), "destination": (120, 255, 120), "neutral": (200, 200, 200)}  # BGR

COMMON_RULES = dict(
    flow=None,                       # unit vector of belt travel in reference pixels, or null
    required_checkpoint=False,       # items must dwell in the checkpoint zone before the destination
    min_dwell_s=3.0,
    expected_routes=[],              # zone-id sequences an observed route must fit
    forbidden_transitions=[],        # [[from_zone, to_zone], ...]
    stall=dict(enabled=False, max_speed_px_per_frame=0.4, min_seconds=3.0, exempt_zone_roles=["destination"]),
    reverse_flow=dict(enabled=False, min_px_per_frame=1.0, min_frames=15),
    track_people=True,
    handling_distance_px=250,
    box_prompts=["cardboard box"],
    world_weights=None,              # YOLO-World weights file in models/ (None = yolov8s-worldv2.pt)
    box_conf=None,                   # YOLO-World detection threshold (None = config.BOX_CONF); kept low, relevance is decided later
    coco_items=[],
    tracker=None,                    # ByteTrack config in trackers/ for the package model (None = Ultralytics bytetrack.yaml)
    crop_shelves=[],                 # shelf zone ids to scan again in zoomed tiles (finds small / plastic items the full frame misses); slower
    crop_prompts=None,               # prompts for those zoomed passes (None = box_prompts)
    crop_keep=None,                  # classes kept from the zoomed passes (None = all), e.g. ["plastic mailer bag"]
    crop_weights=None, crop_tracker=None, crop_conf=None,   # model / tracker / threshold for the zoomed passes (None = same as full frame)                   # extra COCO classes tracked as inventory items by YOLOv8m, e.g. ["bottle"]
    # Region of interest (reference-frame polygon). Detections outside it are still tracked and drawn, but never produce
    # movement events. None = whole frame (shelf cameras: stationary stock is exactly what they monitor).
    roi=None,
    anchor="center",                 # point of a package box used for zones/lines: "center" or "bottom_center" (contact point on a belt/floor)
    # Track relevance for movement cameras: a valid detection can still be irrelevant to counting.
    relevance=dict(enabled=False, stationary_px=60.0, min_roi_fraction=0.5, min_seconds=1.0, min_mean_conf=0.1),
    # Boxes covering several objects (groups.py): drop a box made of 2+ detected cartons; split a stack box minus its one detected carton.
    groups=dict(enabled=True, part_inside=0.85, max_part=0.75, min_part=0.2, group_cover=0.7, span=0.6, min_rest=0.25),
    camera_mask_zones=False,         # ignore zone areas when estimating camera motion (belts)
    min_load_speed_px_per_frame=0,   # >0: slower tracks are discarded as static stock (moving-camera floor footage)
    static_stock_filter=False,
    link_metric="iou",               # how co-existing package boxes are judged duplicates: "iou" or "containment"
    link_max_gap_frames=dict(package=3),   # shelves: never bridge long gaps by position (a new box placed where an old one vanished); spot logic handles occlusion
    destination_loss_is_incident=False,
    missing=dict(confirm_empty_seconds=3.0, stationary_px_per_frame=1.0, min_view_fraction=0.6),
    # shelf monitoring thresholds
    shelf=dict(slot_min_rest_s=2.0,   # a box resting this long inside a shelf defines a slot
               settle_s=1.0,          # a slot must stay occupied this long to confirm a box arrived (or was there)
               prior_empty_s=1.0,     # a slot must be seen empty this long before an arrival counts as an addition
               absence_confirm_s=2.0, # an occupied slot must be seen empty this long to confirm a removal
               return_window_s=5.0,   # removed and back within this window = no movement
               spot_iou=0.3,          # detection overlapping a slot this much = occupied
               appearance_same=0.7,   # slot patch correlates this well with its rest appearance = box still there
               appearance_changed=0.4,  # ...this poorly (and no detection) = slot visibly changed
               stationary_px_per_frame=1.5),
    # movement monitoring thresholds
    crossing=dict(hysteresis_px=12, confirm_frames=5, max_gap_frames=12,
                  min_travel_px=0,         # the box must move at least this far across the line within travel_window_s
                  travel_window_s=1.0,
                  dedupe_s=0.0, dedupe_px=0, # crossings this close in time and position along the line are one parcel (id switch)
                  min_track_quality=0.0,
                  min_detection_conf=0.2,
                  entry_band_px=0),         # >0: a track first seen within this distance of the line that then clearly crosses = uncertain crossing # mean YOLO confidence around the crossing below this = uncertain  # below this, a crossing is kept but marked uncertain
)


def _rect(x1, y1, x2, y2):
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]


def default_config(profile):
    profile = LEGACY_PROFILES.get(profile, profile)
    rules = copy.deepcopy(COMMON_RULES)
    if profile == "movement":
        rules.update(flow=[-1.0, 0.0], camera_mask_zones=True, track_people=False, min_load_speed_px_per_frame=6.5, static_stock_filter=True,
                     link_metric="containment", link_max_gap_frames=dict(package=90), box_prompts=["cardboard box", "parcel", "plastic bag package"], required_checkpoint=True,
                     expected_routes=[["receiving", "inspection", "outbound"]])
        rules["stall"] = dict(enabled=True, max_speed_px_per_frame=0.4, min_seconds=3.0, exempt_zone_roles=["destination"])
        rules["reverse_flow"] = dict(enabled=True, min_px_per_frame=1.0, min_frames=15)
        zones = [dict(id="receiving", label="Receiving", role="intake", polygon=_rect(1250, 420, 1920, 900)),
                 dict(id="inspection", label="Inspection", role="checkpoint", polygon=_rect(650, 420, 1250, 900)),
                 dict(id="outbound", label="Outbound", role="destination", polygon=_rect(0, 420, 650, 900))]
        lines = [dict(id="gate_out", label="Outbound gate", p1=[650, 420], p2=[650, 900], forward=[-1.0, 0.0], forward_means="outbound", location_id=None)]
    else:
        # shelf columns are stacks of cartons that YOLO already detects one by one; splitting a box around part of a column would
        # change slot occupancy evidence, so shelf cameras only drop duplicate group boxes
        rules["groups"]["split"] = False
        zones = [dict(id="shelf_a", label="Shelf A", role="shelf", polygon=_rect(440, 300, 1520, 820), location_id=None, fully_visible=True)]
        lines = []
    return dict(profile=profile, zones=zones, count_lines=lines, rules=rules)


def merged_rules(cfg):
    """Fill missing rule keys from the profile defaults so older saved configs keep working."""
    out = copy.deepcopy(default_config(cfg.get("profile", "shelf"))["rules"])
    for k, v in (cfg.get("rules") or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k].update(v)
        else:
            out[k] = v
    return out


class Config:
    """Geometry helpers over a camera config dict."""

    def __init__(self, cfg):
        self.profile = LEGACY_PROFILES.get(cfg.get("profile", "shelf"), cfg.get("profile", "shelf"))
        self.zones = cfg.get("zones", [])
        self.lines = cfg.get("count_lines", [])
        self.rules = merged_rules(dict(cfg, profile=self.profile))
        self._poly = {z["id"]: np.array(z["polygon"], np.float32) for z in self.zones}
        self.zone_by_id = {z["id"]: z for z in self.zones}

    @property
    def roi(self):
        return self.rules.get("roi")

    def in_roi(self, x, y):
        r = self.roi
        return True if not r else cv2.pointPolygonTest(np.array(r, np.float32), (float(x), float(y)), False) >= 0

    @property
    def order(self):
        return [z["id"] for z in self.zones]

    @property
    def shelves(self):
        return [z for z in self.zones if z.get("role") == "shelf"]

    def role(self, zone_id):
        return self.zone_by_id.get(zone_id, {}).get("role", "neutral")

    def label(self, zone_id):
        return self.zone_by_id.get(zone_id, {}).get("label", zone_id)

    def inside(self, zone_id, x, y):
        return cv2.pointPolygonTest(self._poly[zone_id], (float(x), float(y)), False) >= 0

    def distance(self, zone_id, x, y):
        """Signed distance in px: positive inside the polygon, negative outside."""
        return cv2.pointPolygonTest(self._poly[zone_id], (float(x), float(y)), True)

    def zone_of(self, x, y):
        for zid, poly in self._poly.items():
            if cv2.pointPolygonTest(poly, (float(x), float(y)), False) >= 0:
                return zid
        return "transit"

    def zone_with_role(self, role):
        return next((z["id"] for z in self.zones if z["role"] == role), None)

    def bounds(self):
        return [(min(p[0] for p in z["polygon"]), min(p[1] for p in z["polygon"]), max(p[0] for p in z["polygon"]), max(p[1] for p in z["polygon"])) for z in self.zones]

    def draw(self, frame, H_cur_to_ref, alpha=0.07):
        """Overlay zones and count lines mapped back into the current frame."""
        inv = np.linalg.inv(H_cur_to_ref)
        overlay = frame.copy()
        h, w = frame.shape[:2]
        s = w / 1920
        for z in self.zones:
            col = ZONE_COLORS.get(z["role"], (200, 200, 200))
            pts = cv2.perspectiveTransform(np.array([z["polygon"]], np.float32), inv)[0].astype(np.int32)
            cv2.fillPoly(overlay, [pts], col)
            cv2.polylines(frame, [pts], True, col, max(1, int(2 * s)), cv2.LINE_AA)
            top = pts[np.argsort(pts[:, 1])][:2]
            a = top[np.argmin(top[:, 0])] + [int(14 * s), int(34 * s)]
            cv2.putText(frame, z["label"].upper(), (int(max(10, min(a[0], w - 280 * s))), int(max(40 * s, min(a[1], h - 20)))), cv2.FONT_HERSHEY_SIMPLEX, 0.7 * max(s, 0.7), col, 1, cv2.LINE_AA)
        cv2.addWeighted(overlay, alpha, frame, 1 - alpha, 0, frame)
        for ln in self.lines:
            pts = cv2.perspectiveTransform(np.array([[ln["p1"], ln["p2"]]], np.float32), inv)[0].astype(np.int32)
            cv2.line(frame, tuple(int(v) for v in pts[0]), tuple(int(v) for v in pts[1]), (255, 160, 60), 2, cv2.LINE_AA)
            mid = (pts[0] + pts[1]) // 2
            d = np.array(ln["forward"], float)
            cv2.arrowedLine(frame, (int(mid[0]), int(mid[1])), (int(mid[0] + d[0] * 50), int(mid[1] + d[1] * 50)), (255, 160, 60), 2, cv2.LINE_AA, tipLength=0.35)
            txt = f"{ln['label']} ({ln.get('forward_means', 'forward')} ->)"
            cv2.putText(frame, txt, (int(pts[0][0]) + 8, int(pts[0][1]) - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 160, 60), 1, cv2.LINE_AA)


def validate(cfg):
    """Return a list of human-readable problems; empty means the config can be used."""
    errs, ids = [], set()
    profile = LEGACY_PROFILES.get(cfg.get("profile"), cfg.get("profile"))
    if profile not in PROFILES:
        errs.append("profile must be shelf or movement")
    for z in cfg.get("zones", []):
        if not z.get("id") or z["id"] in ids or z["id"] == "transit":
            errs.append(f"zone id '{z.get('id')}' is missing, duplicated or reserved")
        ids.add(z.get("id"))
        if z.get("role") not in ROLES:
            errs.append(f"zone {z.get('id')}: role must be one of {ROLES}")
        poly = z.get("polygon", [])
        if len(poly) < 3 or any(len(p) != 2 for p in poly):
            errs.append(f"zone {z.get('id')}: polygon needs at least 3 [x, y] points")
    if profile == "shelf" and not any(z.get("role") == "shelf" for z in cfg.get("zones", [])):
        errs.append("a shelf camera needs at least one zone with role 'shelf'")
    for ln in cfg.get("count_lines", []):
        if len(ln.get("p1", [])) != 2 or len(ln.get("p2", [])) != 2 or len(ln.get("forward", [])) != 2:
            errs.append(f"count line {ln.get('id')}: p1, p2 and forward need [x, y]")
        if ln.get("forward_means") not in ("inbound", "outbound"):
            errs.append(f"count line {ln.get('id')}: forward_means must be inbound or outbound")
    roi = (cfg.get("rules") or {}).get("roi")
    if roi is not None and (len(roi) < 3 or any(len(p) != 2 for p in roi)):
        errs.append("rules.roi needs at least 3 [x, y] points")
    if profile == "movement" and not cfg.get("count_lines"):
        errs.append("a movement camera needs at least one count line")
    r = cfg.get("rules", {})
    for route in r.get("expected_routes", []):
        for zid in route:
            if zid not in ids:
                errs.append(f"expected route mentions unknown zone '{zid}'")
    for pair in r.get("forbidden_transitions", []):
        if len(pair) != 2 or any(zid not in ids for zid in pair):
            errs.append(f"forbidden transition {pair} must be two known zone ids")
    return errs


def dumps(cfg):
    return json.dumps(cfg, indent=1)
