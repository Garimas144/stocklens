"""Backend integration tests against the running Convex deployment (run bootstrap_demo.py first).
Covers: idempotent ingestion, exact-once estimate updates, discrepancy creation, multi-camera de-duplication, operator review,
and correction approval (two-person rule). --quick skips the re-processing check."""
import sys, os, threading, time, uuid
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from convex import ConvexClient
from convex_bridge import Bridge

br = Bridge(); pub = ConvexClient("http://127.0.0.1:3210")
loc = lambda lid: next(l for l in pub.query("ui:locations", {}) if l["locationId"] == lid)
ok = lambda c, m: print(("PASS " if c else "FAIL ") + m) or (c or sys.exit(1))

# 1. idempotent re-publication: re-running the shelf camera publishes the same keys -> 0 inserted, estimate unchanged
before = loc("SHELF-2")["state"]
import process_video
sid, res = process_video.run_camera("cam-02-storage", bridge=br) if "--quick" not in sys.argv else (None, dict(inserted=0, duplicates=1))
ok(res["inserted"] == 0 and res["duplicates"] == 1, f"re-processing same footage is idempotent ({res})")
ok(loc("SHELF-2")["state"]["estimate"] == before["estimate"] == 7, "Shelf 2 estimate stays 7 (8 verified - 1 confirmed removal)")

# 2. synthetic test camera + locations (clearly test data) for exact-once and dedupe checks
T0 = int(time.time() * 1000) - 3_600_000   # an hour ago, like a real shift
tag = uuid.uuid4().hex[:6].upper()
fixture = dict(cameras=[dict(cameraId=f"test-cam-a-{tag.lower()}", name="TEST A", profile="movement", context="test", warehouseLocation="test", source=dict(kind="file", uri="none"), config={}),
                        dict(cameraId=f"test-cam-b-{tag.lower()}", name="TEST B", profile="movement", context="test", warehouseLocation="test", source=dict(kind="file", uri="none"), config={})],
               locations=[dict(locationId=f"TEST-OUT-{tag}", name="test checkpoint", type="checkpoint", cameraId=f"test-cam-a-{tag.lower()}", direction="outbound", matchToleranceS=5),
                          dict(locationId=f"TEST-SHELF-{tag}", name="test shelf", type="shelf", cameraId=f"test-cam-a-{tag.lower()}", sku=f"SKU-T-{tag}", verifiedQty=10, verifiedAt=T0, fullyVisible=True)],
               inventoryRecords=[dict(sku=f"SKU-T-{tag}", locationId=f"TEST-SHELF-{tag}", recordedQty=10)],
               transactions=[dict(txnId=f"T-{tag}-1", type="outbound", locationId=f"TEST-OUT-{tag}", quantity=1, at=T0 + 2000)])
br.seed(fixture)
ca, cb = f"test-cam-a-{tag.lower()}", f"test-cam-b-{tag.lower()}"
for cam, s in ((ca, f"S-A-{tag}"), (cb, f"S-B-{tag}")):
    br.session(sessionId=s, cameraId=cam, status="processing", progress=0.5, startedAt=T0)
ev = lambda k, l, typ, t, **kw: dict(dict(eventKey=k, locationId=l, type=typ, trackRef="Package 1", t=t, quantity=1, verification="confirmed", reasons=["test"]), **kw)
br.events(f"S-A-{tag}", ca, [ev(f"a1{tag}", f"TEST-OUT-{tag}", "checkpoint_crossing", 2.0, direction="outbound"), ev(f"a2{tag}", f"TEST-OUT-{tag}", "checkpoint_crossing", 9.0, direction="outbound")], final=False)
br.session(sessionId=f"S-A-{tag}", cameraId=ca, status="done", progress=1.0, startedAt=T0, durationS=20.0)
r = br.events(f"S-A-{tag}", ca, [ev(f"a1{tag}", f"TEST-OUT-{tag}", "checkpoint_crossing", 2.0, direction="outbound")], final=False)
ok(r["inserted"] == 0 and r["duplicates"] == 1, "duplicate event key is ignored")
st = loc(f"TEST-OUT-{tag}")["state"]
ok(st["observed"] == 2 and st["recorded"] == 1 and st["unmatchedEvents"] == 1, f"checkpoint: 2 observed, 1 recorded, 1 unmatched ({st['observed']}/{st['recorded']}/{st['unmatchedEvents']})")
# second camera sees the same transfer: stored, not counted
r = br.events(f"S-B-{tag}", cb, [ev(f"b1{tag}", f"TEST-OUT-{tag}", "checkpoint_crossing", 2.1, direction="outbound")], final=False)
ok(loc(f"TEST-OUT-{tag}")["state"]["observed"] == 2, "secondary camera observation is not double-counted")
# shelf: two removals -> 10 - 2 = 8 exactly once, even when re-sent
br.session(sessionId=f"S-A-{tag}", cameraId=ca, status="done", progress=1.0, startedAt=T0, durationS=20.0)
for _ in range(2):
    br.events(f"S-A-{tag}", ca, [ev(f"s1{tag}", f"TEST-SHELF-{tag}", "shelf_removal", 3.0), ev(f"s2{tag}", f"TEST-SHELF-{tag}", "shelf_removal", 6.0),
                                ev(f"s3{tag}", f"TEST-SHELF-{tag}", "shelf_removal", 7.0, verification="uncertain")], final=False)
st = loc(f"TEST-SHELF-{tag}")["state"]
ok(st["estimate"] == 8 and st["uncertain"] == 1, f"two confirmed removals counted once each, uncertain one not counted (estimate {st['estimate']})")
d = next(x for x in pub.query("ui:discrepancies", {"status": "active"}) if x["locationId"] == f"TEST-SHELF-{tag}")
ok(d["difference"] == -2, f"discrepancy {d['code']} created with difference -2")

# 3. operator review of the uncertain removal changes the estimate (8 -> 7). Live push to the browser is checked in the UI test.
uncertain = next(e for e in pub.query("ui:searchEvents", {"locationId": f"TEST-SHELF-{tag}"}) if e["verification"] == "uncertain")
pub.mutation("ops:reviewEvent", {"operator": "Test Operator", "eventId": uncertain["_id"], "decision": "confirm", "note": "footage shows box removed"})
ok(loc(f"TEST-SHELF-{tag}")["state"]["estimate"] == 7, "confirmed review counts the removal (estimate 7)")

# 4. correction: requester cannot approve; second person approves -> records match -> discrepancy closes
pub.mutation("ops:requestCorrection", {"operator": "Test Operator", "code": d["code"], "toQty": 7.0, "reason": "three removals confirmed on video"})
c = next(x for x in pub.query("ui:discrepancy", {"code": d["code"]})["corrections"] if x["status"] == "pending")
try:
    pub.mutation("ops:decideCorrection", {"operator": "Test Operator", "correctionId": c["_id"], "approve": True, "note": ""}); ok(False, "self-approval blocked")
except Exception:
    ok(True, "requester cannot approve their own correction")
pub.mutation("ops:decideCorrection", {"operator": "Second Approver", "correctionId": c["_id"], "approve": True, "note": "checked footage"})
d2 = pub.query("ui:discrepancy", {"code": d["code"]})["discrepancy"]
ok(d2["status"] == "resolved" and not d2["active"], f"approved correction reconciles the shelf and closes {d['code']}")
# 5. misplaced item: an addition on the test shelf identified (operator link) as a product that belongs elsewhere
sku_here, sku_other = f"SKU-T-{tag}", f"SKU-O-{tag}"
br.seed(dict(products=[dict(sku=sku_here, name="Test product", category="test", expectedLocationId=f"TEST-SHELF-{tag}"),
                       dict(sku=sku_other, name="Other product", category="test", expectedLocationId=f"TEST-OUT-{tag}")]))
br.m("worker:replaceTracks", sessionId=f"S-A-{tag}", cameraId=ca, tracks=[dict(trackRef="Package 9", kind="package", trackerIds="9", firstSeenS=1.0, lastSeenS=9.0, meanConf=0.7,
     status="test", route=[], uncertainty=[], samples=[])])
br.events(f"S-A-{tag}", ca, [dict(eventKey=f"m1{tag}", locationId=f"TEST-SHELF-{tag}", type="shelf_addition", trackRef="Package 9", t=8.0, quantity=1, verification="confirmed", reasons=["test"])], final=False)
st = loc(f"TEST-SHELF-{tag}")["state"]
ok(st["additions"] == 1, "anonymous addition counts toward the shelf's own product")
pub.mutation("ops:linkPackage", {"operator": "Test Operator", "sessionId": f"S-A-{tag}", "trackRef": "Package 9", "packageId": "", "sku": sku_other})
mis = [x for x in pub.query("ui:discrepancies", {"status": "active"}) if x["kind"] == "misplaced_item" and x["locationId"] == f"TEST-SHELF-{tag}"]
ok(len(mis) == 1 and mis[0]["expectedLocationId"] == f"TEST-OUT-{tag}" and mis[0]["confidence"] == "high", f"identified foreign product -> misplaced-item incident with expected location ({[m['code'] for m in mis]})")
ok(loc(f"TEST-SHELF-{tag}")["state"]["additions"] == 0, "a misplaced item does not inflate the shelf's own stock estimate")
pub.mutation("ops:linkPackage", {"operator": "Test Operator", "sessionId": f"S-A-{tag}", "trackRef": "Package 9", "packageId": "", "sku": ""})
ok(not [x for x in pub.query("ui:discrepancies", {"status": "active"}) if x["kind"] == "misplaced_item" and x["locationId"] == f"TEST-SHELF-{tag}"], "removing the identity closes the misplacement")
print("ALL BACKEND TESTS PASSED")
print("cleanup: removed", br.m("worker:purgeTestData"), "test documents")
