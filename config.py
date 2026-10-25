"""Shared configuration."""
import os

BASE = os.path.dirname(os.path.abspath(__file__))
SOURCE_VIDEO = os.path.join(BASE, "data", "conveyor_line.mp4")
OUTPUTS = os.path.join(BASE, "outputs")
PLATFORM_DB = os.path.join(OUTPUTS, "platform.db")
UPLOADS = os.path.join(BASE, "data", "uploads")


def session_paths(session_id):
    d = os.path.join(OUTPUTS, "sessions", session_id)
    return dict(dir=d, raw=os.path.join(d, "raw_detections.json"), processed=os.path.join(d, "processed.mp4"), evidence=os.path.join(d, "evidence"))


# ---- YOLO ----
PERSON_WEIGHTS = os.path.join(BASE, "models", "yolov8m.pt")           # COCO YOLOv8: people
WORLD_WEIGHTS = os.path.join(BASE, "models", "yolov8s-worldv2.pt")    # YOLOv8-World: open-vocabulary boxes / pallets
BOX_PROMPTS = ["cardboard box", "parcel", "plastic bag package"]
PERSON_CONF, BOX_CONF = 0.25, 0.05   # box confidence is low because carton detection on this footage is weak
TRACKER_CFG = "bytetrack.yaml"

# ---- Entity consolidation (turns fragmented YOLO track ids into persistent identities) ----
MIN_TRACK_DETS = {"person": 12, "package": 3}   # drop tracks shorter than this (noise)
LINK_MAX_GAP_FRAMES = {"person": 40, "package": 90}
LINK_BASE_DIST = {"person": 220, "package": 120}   # px in reference coordinates
MIN_LINK_SPAN_FRAMES = 10   # shorter fragments are noise unless they duplicate a longer track
LINK_DIST_PER_FRAME = 5
LINK_MAX_DIST = 400
LINK_IOU = {"person": 0.7, "package": 0.6}   # co-existing boxes overlapped this much are duplicate detections of one object
MIN_LOAD_SPEED_PX_PER_FRAME = 6.5  # slower load tracks are static stock (tall racks drift in reference space)
STATIONARY_PX = 250         # ...unless they travelled at least this far
HANDLING_DIST_PX = 250      # px gap between a moving worker's box and the load's box (image space) that counts as handling

# ---- Event state machine ----
CONFIRM_FRAMES = 5           # consecutive observed frames needed to confirm appearance / a zone change
GAP_SECONDS = 0.5            # a break in observation longer than this is an observation gap
EDGE_MARGIN = 6              # px; last bbox this close to the image border = left the camera view
END_MARGIN_FRAMES = 12       # last seen this close to the final frame = still visible at end
MIN_INSPECTION_DWELL_S = 3.0 # checkpoint visit = remain in inspection this long
REQUIRED_CHECKPOINT = "inspection"
LOW_CONF = 0.30              # mean detector confidence below this marks an item as low-confidence

# Camera compensation: moving conveyor items and belt texture would be mistaken for camera motion, so by default we only
# estimate camera motion from pixels outside every detection box and (optionally) outside the zone polygons.
CAMERA_MASK_ZONES = True

# ---- Conveyor mode (legacy globals, now per-camera rules) ----
BELT_MODE = True              # loads move on a belt: motion without a worker is normal; check direction and stalls instead
REVERSE_PX_PER_FRAME, REVERSE_FRAMES = 1.0, 15
STALL_PX_PER_FRAME, STALL_SECONDS = 0.4, 3.0

