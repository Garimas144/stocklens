"""Set up the demo warehouse in Convex and analyse the real clips in data/ (see data/SOURCE.md).

What is real and what is sample:
  * The footage is real stock video (data/SOURCE.md). Every movement event comes from YOLOv8 tracking of that footage.
  * Camera zones/lines, the verified starting count of each shelf (counted by eye from the first frame) and all inventory records
    and WMS transactions below are SAMPLE DATA written for the demo. They are stored with isSample=true and labelled in the UI.

  python bootstrap_demo.py            # seed + analyse (reuses cached YOLO passes when present)
  python bootstrap_demo.py --fresh    # re-run YOLO on every clip
  python bootstrap_demo.py --seed     # only (re)write the sample configuration and records
  python bootstrap_demo.py --reset    # wipe the dev deployment first (needs ALLOW_RESET=1 on the deployment)
"""
import calendar
import sys
import time
import cameras
from convex_bridge import Bridge
import process_video


def ts(s):
    return calendar.timegm(time.strptime(s, "%Y-%m-%dT%H:%M:%S")) * 1000


RECV_AT, STORE_AT, AISLE_AT, DISPATCH_AT, CLOSEUP_AT = (ts("2026-10-24T08:30:00"), ts("2026-10-24T09:00:00"), ts("2026-10-24T09:20:00"),
                                                       ts("2026-10-24T10:00:00"), ts("2026-10-24T09:30:00"))
CAMERAS = ["cam-01-receiving", "cam-02-storage", "cam-03-aisle", "cam-04-dispatch", "cam-05-shelf3"]


def rect(x1, y1, x2, y2):
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]


def dispatch_config():
    """CAM 04, Pexels 5903898: parcels ride the belt right -> left; stock and bags are parked behind the belt and must never count."""
    c = cameras.default_config("movement")
    roi = [[0, 270], [1920, 420], [1920, 860], [0, 480]]            # belt top surface only (reference = first frame)
    c["zones"] = [dict(id="belt", label="Dispatch belt", role="neutral", polygon=roi)]
    c["count_lines"] = [dict(id="gate_out", label="Dispatch line", p1=[900, 335], p2=[945, 680], forward=[-0.99, -0.14], forward_means="outbound", location_id="DOCK-OUT-1")]
    c["rules"].update(world_weights="yolov8l-worldv2.pt", box_prompts=["cardboard box", "parcel", "plastic wrapped package"], box_conf=0.04, tracker="bytetrack_parcels.yaml",
                      track_people=False, roi=roi, anchor="bottom_center", flow=[-0.99, -0.14], static_stock_filter=False, min_load_speed_px_per_frame=0,
                      relevance=dict(enabled=True, stationary_px=60.0, min_roi_fraction=0.5, min_seconds=1.0, min_mean_conf=0.1), link_metric="iou", link_max_gap_frames=dict(package=20),
                      required_checkpoint=False, expected_routes=[], stall=dict(enabled=False), reverse_flow=dict(enabled=True, min_px_per_frame=1.0, min_frames=15))
    c["rules"]["crossing"] = dict(hysteresis_px=15, confirm_frames=5, max_gap_frames=12, min_travel_px=60, travel_window_s=1.0, dedupe_s=0.7, dedupe_px=120, min_track_quality=0.5, min_detection_conf=0.12, entry_band_px=40)
    return c


def receiving_config():
    """CAM 01, Pexels 6170064: cartons wheeled from the van towards the receiving door; cartons inside the van and the stack beside it are stock."""
    c = cameras.default_config("movement")
    roi = [[0, 640], [1250, 600], [1500, 1080], [0, 1080]]          # yard in front of the van (excludes the van load space)
    c["zones"] = [dict(id="yard", label="Receiving yard", role="neutral", polygon=roi)]
    c["count_lines"] = [dict(id="recv_in", label="Receiving line", p1=[300, 870], p2=[1350, 870], forward=[0.0, 1.0], forward_means="inbound", location_id="RECV-IN-1")]
    c["rules"].update(world_weights="yolov8l-worldv2.pt", box_prompts=["cardboard box", "parcel"], box_conf=0.06, tracker="bytetrack_handling.yaml", track_people=True, roi=roi, anchor="bottom_center",
                      flow=None, static_stock_filter=False, min_load_speed_px_per_frame=0,
                      # the camera zooms slowly; compensating a zoom over a 3D scene leaves up to ~110 px of drift on parked cartons
                      relevance=dict(enabled=True, stationary_px=140.0, min_roi_fraction=0.5, min_seconds=1.0, min_mean_conf=0.1),
                      link_metric="iou", link_max_gap_frames=dict(package=20), required_checkpoint=False, expected_routes=[], stall=dict(enabled=False), reverse_flow=dict(enabled=False))
    # max_gap_frames 20 (0.8 s at 25 fps): the hand truck moves at walking pace and is briefly hidden by the worker pushing it
    c["rules"]["crossing"] = dict(hysteresis_px=15, confirm_frames=5, max_gap_frames=20, min_travel_px=60, travel_window_s=1.0, dedupe_s=0.7, dedupe_px=80, min_track_quality=0.5, min_detection_conf=0.12, entry_band_px=40)
    return c


def fixture():
    recv = receiving_config()

    store = cameras.default_config("shelf")
    # Shelf 2 is scanned again in zoomed tiles: the plastic mailer bag on top of the right-hand carton scores ~0.02 in the full frame
    store["rules"].update(crop_shelves=["shelf_2"], crop_prompts=["cardboard box", "plastic mailer bag"], crop_weights="yolov8l-worldv2.pt",
                          crop_tracker="bytetrack_parcels.yaml", crop_conf=0.05, crop_keep=["plastic mailer bag"])
    store["zones"] = [dict(id="shelf_1", label="Shelf 1", role="shelf", polygon=rect(440, 0, 1560, 285), location_id="SHELF-1", fully_visible=True),
                      dict(id="shelf_2", label="Shelf 2", role="shelf", polygon=rect(440, 300, 1520, 820), location_id="SHELF-2", fully_visible=True)]

    aisle = cameras.default_config("movement")
    aisle["zones"] = [dict(id="aisle_west", label="Aisle west", role="neutral", polygon=rect(300, 300, 950, 1300)),
                      dict(id="aisle_mid", label="Aisle centre", role="neutral", polygon=rect(950, 300, 1350, 1300)),
                      dict(id="aisle_east", label="Aisle east (to racks)", role="neutral", polygon=rect(1350, 300, 2400, 1300))]
    aisle["count_lines"] = [dict(id="aisle_gate", label="Aisle 3 crossing", p1=[1150, 300], p2=[1150, 1300], forward=[1.0, 0.0], forward_means="outbound", location_id="AISLE-3")]
    # cartons on the pallet are tracked one by one (IoU linking); the box around the whole pallet is a group box and is dropped
    aisle["rules"].update(flow=None, box_prompts=["cardboard boxes on a pallet", "cardboard box"], track_people=True, camera_mask_zones=False, link_metric="iou",
                          relevance=dict(enabled=True, stationary_px=120.0, min_roi_fraction=0.5, min_seconds=1.0, min_mean_conf=0.1), groups=dict(cameras.COMMON_RULES["groups"], group_cover=0.45),
                          required_checkpoint=False, expected_routes=[], stall=dict(enabled=False), reverse_flow=dict(enabled=False))

    dispatch = dispatch_config()

    closeup = cameras.default_config("shelf")
    closeup["zones"] = [dict(id="shelf_3", label="Shelf 3", role="shelf", polygon=rect(0, 0, 1280, 720), location_id="SHELF-3", fully_visible=False)]

    cam = lambda cid, name, profile, ctx, where, uri, at, cfg, slot, area: dict(cameraId=cid, name=name, profile=profile, context=ctx, warehouseLocation=where,
                                                                            source=dict(kind="file", uri=uri, recordedAt=at), config=cfg, slot=slot, area=area)
    return dict(
        cameras=[
            cam("cam-01-receiving", "Receiving dock", "movement", "van unloading yard", "Dock door 1", "data/receiving_van.mp4", RECV_AT, recv, 1, "receiving"),
            cam("cam-02-storage", "Storage shelving", "shelf", "storage shelving unit", "Aisle 4, bay 2", "data/shelf_removal.mp4", STORE_AT, store, 2, "storage"),
            cam("cam-03-aisle", "Warehouse aisle", "movement", "aisle between receiving and racks", "Aisle 3", "data/storage_aisle.mp4", AISLE_AT, aisle, 3, "aisle"),
            cam("cam-04-dispatch", "Dispatch conveyor", "movement", "conveyor to the dispatch dock", "Dock door 3", "data/dispatch_belt.mp4", DISPATCH_AT, dispatch, 4, "dispatch"),
            cam("cam-05-shelf3", "Shelf 3 close-up", "shelf", "close-up of one shelf bay", "Aisle 4, bay 3", "data/shelf_addition.mp4", CLOSEUP_AT, closeup, 5, "storage"),
        ],
        products=[
            dict(sku="SKU-WTR-12", name="Water bottles", category="Beverages", expectedLocationId="SHELF-1", unit="case"),
            dict(sku="SKU-UTN-08", name="Kitchen utensils", category="Kitchenware", expectedLocationId="SHELF-2", unit="pack"),
            dict(sku="SKU-CHG-10", name="Phone chargers", category="Electronics", expectedLocationId="SHELF-3", unit="box"),
        ],
        locations=[
            dict(locationId="RECV-IN-1", name="Receiving dock", type="checkpoint", cameraId="cam-01-receiving", direction="inbound", matchToleranceS=10),
            dict(locationId="SHELF-1", name="Shelf 1", type="shelf", cameraId="cam-02-storage", sku="SKU-WTR-12", verifiedQty=12, verifiedAt=STORE_AT,
                 verifiedBy="sample starting count", fullyVisible=True, matchToleranceS=900),
            dict(locationId="SHELF-2", name="Shelf 2", type="shelf", cameraId="cam-02-storage", sku="SKU-UTN-08", verifiedQty=8, verifiedAt=STORE_AT,
                 verifiedBy="sample starting count", fullyVisible=True, matchToleranceS=900),
            dict(locationId="SHELF-3", name="Shelf 3", type="shelf", cameraId="cam-05-shelf3", sku="SKU-CHG-10", verifiedQty=10, verifiedAt=CLOSEUP_AT,
                 verifiedBy="sample starting count (close-up: changes only)", fullyVisible=False, matchToleranceS=900),
            dict(locationId="AISLE-3", name="Aisle 3", type="zone", cameraId="cam-03-aisle"),
            dict(locationId="DOCK-OUT-1", name="Dispatch dock", type="checkpoint", cameraId="cam-04-dispatch", direction="outbound", matchToleranceS=2),
        ],
        inventoryRecords=[
            dict(sku="SKU-WTR-12", description="Water bottles, case of 12", locationId="SHELF-1", recordedQty=12),
            dict(sku="SKU-UTN-08", description="Kitchen utensil set", locationId="SHELF-2", recordedQty=8),
            # 10 counted at CLOSEUP_AT, then the put-away WMS-PUT-77120 (+1, also seen by CAM 05): the WMS balance is 11
            dict(sku="SKU-CHG-10", description="USB-C phone charger", locationId="SHELF-3", recordedQty=11),
        ],
        transactions=[
            dict(txnId="WMS-PUT-77120", type="putaway", locationId="SHELF-3", sku="SKU-CHG-10", quantity=1, at=CLOSEUP_AT + 6000, reference="sample: put-away scan"),
        ] + DISPATCH_SCANS + RECEIPTS,
    )


# Sample WMS records for the two movement clips. Written for the demo, not from a real WMS (isSample=true).
# Receiving: the hand-truck load in the clip holds two stacked cartons; the receipt records both.
RECEIPTS = [dict(txnId="WMS-RCV-33001", type="receipt", locationId="RECV-IN-1", quantity=2, at=RECV_AT + 9800, reference="sample: receiving scan, 2 cartons on one hand truck")]
# Dispatch: nine parcels leave on the belt; the sample WMS has eight dispatch scans (the parcel at ~14 s was never scanned).
DISPATCH_SCANS = [dict(txnId=f"WMS-OUT-5502{i}", type="outbound", locationId="DOCK-OUT-1", quantity=1, at=DISPATCH_AT + ms, reference="sample: dispatch scan")
                  for i, ms in enumerate((900, 4000, 5600, 6900, 8700, 12000, 17200, 19800), 1)]


if __name__ == "__main__":
    br = Bridge()
    if "--reset" in sys.argv:
        print("reset: deleted", br.m("worker:resetAll"), "documents")
    print("seed:", br.seed(fixture()))
    if "--seed" in sys.argv:
        sys.exit(0)
    for cam in CAMERAS:
        print(f"\n=== {cam}")
        process_video.run_camera(cam, fresh="--fresh" in sys.argv, bridge=br)
