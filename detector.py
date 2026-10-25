"""YOLOv8 detection and tracking (Ultralytics), shared by every camera profile.

  * YOLOv8m (COCO)               -> people, plus optional COCO item classes per camera (e.g. "bottle"). Reliable on those classes.
  * YOLOv8-World v2 (s or l)     -> packages via text prompts. COCO has no carton / parcel class, so base YOLOv8 cannot see
    cartons; YOLO-World is the pretrained open-vocabulary YOLOv8 variant. No training. Both use ByteTrack.

Why the system used to "only see square boxes": the only package prompts were "cardboard box"-style phrases, every non-person
detection was then treated as a generic package, and the COCO model was restricted to class 0 (person). Nothing geometric filtered
shapes; the vocabulary did. Prompts and COCO item classes are now per-camera rules. YOLO-World prompt labels are NOT reliable
categories (it labels most parcels "cardboard box" whatever the wrapping), so the class name is kept for audit only and never used
as product identity.

Track ids come from one tracker instance for one video, so they are only meaningful inside that session.
"""
import os
from dataclasses import dataclass
from ultralytics import YOLO, YOLOWorld
import config as C
from utils import iou

COCO = {"person": 0, "backpack": 24, "handbag": 26, "suitcase": 28, "bottle": 39, "cup": 41}


def tiles(b, tw=620, th=360):
    """Overlapping ~620x360 tiles covering box b (fewer when b is smaller)."""
    x1, y1, x2, y2 = b
    nx = 1 if x2 - x1 <= tw else -(-(x2 - x1 - tw) // (tw * 3 // 4)) + 1
    ny = 1 if y2 - y1 <= th else -(-(y2 - y1 - th) // (th * 3 // 4)) + 1
    out = []
    for i in range(nx):
        for j in range(ny):
            ox = x1 + (0 if nx == 1 else round(i * (x2 - x1 - tw) / (nx - 1)))
            oy = y1 + (0 if ny == 1 else round(j * (y2 - y1 - th) / (ny - 1)))
            out.append((ox, oy, min(x2, ox + tw), min(y2, oy + th)))
    return out


@dataclass
class Det:
    track_id: int
    cls: str
    conf: float
    bbox: tuple


class YoloTracker:
    def __init__(self, prompts, track_people=True, world_weights=None, box_conf=None, coco_items=(), tracker=None, crops=(), crop_prompts=None,
                 crop_weights=None, crop_tracker=None, crop_conf=None):
        self.coco_ids = ([0] if track_people else []) + [COCO[c] for c in coco_items if c in COCO]
        self.person_model = YOLO(C.PERSON_WEIGHTS) if self.coco_ids else None
        self.box_model = YOLOWorld(os.path.join(C.BASE, "models", world_weights) if world_weights else C.WORLD_WEIGHTS)
        self.box_model.set_classes(list(prompts))
        self.box_conf = C.BOX_CONF if box_conf is None else box_conf
        self.box_tracker = os.path.join(C.BASE, "trackers", tracker) if tracker else C.TRACKER_CFG
        # Zoomed second passes over fixed regions (tiles over chosen shelves): small or low-contrast items such as plastic mailer bags
        # score ~0.02 in the full 1080p frame but ~0.2-0.3 when a ~620x360 tile fills the network input. One model + tracker per tile.
        self.crops = [t for c in crops for t in tiles([int(v) for v in c])]
        self.crop_models = []
        self.crop_tracker = os.path.join(C.BASE, "trackers", crop_tracker) if crop_tracker else self.box_tracker
        self.crop_conf = self.box_conf if crop_conf is None else crop_conf
        for _ in self.crops:
            w = crop_weights or world_weights
            cm = YOLOWorld(os.path.join(C.BASE, "models", w) if w else C.WORLD_WEIGHTS)
            cm.set_classes(list(crop_prompts or prompts))
            self.crop_models.append(cm)

    def track(self, frame):
        out = []
        if self.person_model is not None:
            r = self.person_model.track(frame, persist=True, classes=self.coco_ids, conf=C.PERSON_CONF, tracker=C.TRACKER_CFG, verbose=False)[0]
            out += self._collect(r, True)
        # class-agnostic NMS: one parcel matched by two prompts is one box, not two competing tracks
        r = self.box_model.track(frame, persist=True, conf=self.box_conf, agnostic_nms=True, tracker=self.box_tracker, verbose=False)[0]
        full = self._collect(r, False)
        out += full
        added = []
        for k, ((x1, y1, x2, y2), cm) in enumerate(zip(self.crops, self.crop_models)):
            rc = cm.track(frame[y1:y2, x1:x2], persist=True, conf=self.crop_conf, agnostic_nms=True, tracker=self.crop_tracker, verbose=False)[0]
            for d in self._collect(rc, False):
                b = (d.bbox[0] + x1, d.bbox[1] + y1, d.bbox[2] + x1, d.bbox[3] + y1)
                # an object the full-frame pass (or an overlapping tile) already has is not added twice; tiles only add what was missed
                if any(iou(b, f.bbox) > 0.5 for f in full) or any(iou(b, a.bbox) > 0.5 for a in added):
                    continue
                det = Det(d.track_id + 200000 + 10000 * k, d.cls, d.conf, b)
                added.append(det)
                out.append(det)
        return out

    @staticmethod
    def _collect(r, coco):
        if r.boxes is None or r.boxes.id is None:
            return []
        xyxy, ids, conf = r.boxes.xyxy.cpu().numpy(), r.boxes.id.int().cpu().tolist(), r.boxes.conf.cpu().tolist()
        names = [r.names[int(k)] for k in r.boxes.cls]
        # COCO item ids are offset so they never collide with YOLO-World track ids in the shared raw cache
        return [Det(i + (100000 if coco and n != "person" else 0), n, c, tuple(int(v) for v in b)) for b, i, c, n in zip(xyxy, ids, conf, names)]
