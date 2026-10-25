# StockLens: visual inventory intelligence (Cal Hacks prototype)

Existing CCTV footage in. YOLOv8 + ByteTrack find and follow packages, a shelf module and a movement module turn that into
**confirmed physical inventory movements**, Convex reconciles them against warehouse records and opens discrepancies, a Claude
agent investigates them, and operators review evidence and resolve or correct, all live in a Next.js dashboard.

## How we use Convex
- Convex is the system of record: cameras, records, movement events, incidents, corrections, chats and the audit log (`web/convex/schema.ts`).
- The CV worker publishes events idempotently and reconciliation runs in the same mutation, so nothing is double counted (`web/convex/worker.ts`, `lib.ts`).
- New incidents schedule a Claude investigation (`ctx.scheduler.runAfter`), and corrections need a second human approver (`agent.ts`, `ops.ts`).
- The camera wall, dashboard, investigations and Ask StockLens update live via `useQuery`, with no refresh.
- Details and evidence: [hackathon.md](hackathon.md).

```
data/*.mp4 ──> worker.py / process_video.py  (Python, local CPU)
                 detector.py        YOLOv8m (people) + YOLOv8s-World (cartons, text prompts) + ByteTrack
                 camera_motion.py   background optical flow -> first-frame coordinates (handheld / panning cameras)
                 event_engine.py    track consolidation, zone state machine, uncertainty notes
                 shelf_monitor.py   shelf profile: slot occupancy -> confirmed additions / removals
                 movement_monitor.py movement profile: directional count lines -> unique net crossings
                 -> annotated video + evidence stills (web/public/media) + structured events
                         │  convex_bridge.py (worker secret, idempotent event keys)
                         ▼
web/convex/  (Convex = system of record)
   schema.ts   cameras, locations, inventoryRecords, transactions, sessions, tracks, movementEvents,
               discrepancies, investigationNotes, corrections, agentRuns, jobs, audit
   worker.ts   ingestion: idempotent publishEvents -> reconciliation in the same transaction
   lib.ts      deterministic reconciliation + discrepancy upsert
   ops.ts      operator mutations (validation, audit, two-person correction approval)
   ui.ts       reactive queries for every page
   agent.ts    Claude investigation agent (Anthropic SDK, tool-use loop in a Convex action)
web/app/      Next.js 16 + convex/react
              /  Surveillance Mode (dark 2x2 camera wall, AI overlays, focus view, Ask panel)
              (workspace)/  Dashboard, Ask StockLens, Inventory, Investigations, Cameras, Records: Movement log
```

## Hosted demo
The hosted site (Vercel) reads a Convex cloud production deployment that holds the already-analysed demo data; the processed
clips and evidence stills are served from `web/public/media` (re-encoded to 720p, overlays use stored coordinates so they still
line up). The Python CV worker is not hosted: analysing new footage needs it running locally. Claude calls are rate-limited for the
public link (Convex env `AI_MAX_PER_HOUR` default 60, `AI_MAX_PER_CONVERSATION` default 20, `AGENT_MAX_PER_HOUR` default 20).

## Run locally
```bash
# 1. Python CV worker
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/pip install git+https://github.com/ultralytics/CLIP.git
mkdir -p models && for m in yolov8m yolov8s-worldv2 yolov8l-worldv2; do \
  curl -L -o models/$m.pt https://github.com/ultralytics/assets/releases/download/v8.3.0/$m.pt; done   # weights are not in git
# source clips (not in git): download the Pexels videos listed in data/SOURCE.md into data/
# 2. Convex (local deployment, no account needed) + web app
cd web && npm install
CONVEX_AGENT_MODE=anonymous npx convex dev          # keep running; writes .env.local
npx convex env set INGEST_SECRET <random>            # same value goes in ../.env.worker
npx convex env set ANTHROPIC_API_KEY <key>           # optional: enables the Claude agent
npm run dev                                          # http://localhost:3000
# 3. demo data + analysis (from the project root). .env.worker:
#    CONVEX_URL=http://127.0.0.1:3210  INGEST_SECRET=<same>  MEDIA_DIR=web/public/media
.venv/bin/python bootstrap_demo.py --reset          # --reset needs ALLOW_RESET=1 on the deployment
.venv/bin/python worker.py                           # runs jobs queued with "Analyse footage" in the UI
.venv/bin/python tests/test_logic.py                 # CV logic tests (no backend)
.venv/bin/python tests/test_backend.py               # Convex integration tests (needs the running deployment)
```

## The four-camera warehouse (real stock footage, see data/SOURCE.md)
The cameras are recordings of different real places, used as the four stages of one demo warehouse. They do not show the same
physical items, so no item is claimed to travel between them.

| Grid | Camera | Clip | What YOLOv8 + the modules found | Against the (sample) records |
|---|---|---|---|---|
| CAM 01 | Receiving dock | daylight van unload, cartons wheeled on a hand truck (Pexels 6170064) | 2 confirmed inbound cartons (a stack of two on one hand truck); the parked cartons in and beside the van are background, never counted | 1 receipt of 2 cartons → matches |
| CAM 02 | Storage shelving | shelf unit, a worker takes one box (Pexels 6170323) | 1 confirmed removal on Shelf 2 | Shelf 2 (kitchen utensils): 8 recorded, 7 supported → **mismatch −1** |
| CAM 03 | Warehouse aisle | pallet moved across the floor (Pexels 4281239) | 1 crossing of the Aisle 3 line | observation only (last-seen history, no records to compare) |
| CAM 04 | Dispatch | fixed view of a parcel belt with stock parked behind it (Pexels 5903898) | 9 confirmed outbound crossings; stationary parcels behind the belt and boxes outside the belt ROI are tracked but never counted | 8 dispatch scans → **+1 unscanned parcel** (14.4 s) |
| CAM 05 | Shelf 3 close-up (outside the grid) | a box placed into a slot (Pexels 6170331) | 1 confirmed addition | matches the recorded put-away |

### Validation against hand-counted ground truth
**Dispatch (Pexels 5903898, 20 s).** Counted by hand from 0.5 s crops around the dispatch line: 9 parcels cross right to left
(≈0.3, 3.2, 4.7, 6.2, 7.7, 10.9, 13.7, 16.0, 18.8 s); a 10th reaches the line as the clip ends and does not cross.

| | count |
|---|---|
| ground-truth crossings | 9 |
| detected crossings | 9 (all confirmed) |
| true positives | 9 (one per real parcel, each 0.1-0.7 s after the hand-counted time because the system times the bottom edge, direction outbound) |
| false positives | 0 (no background parcel, duplicate or reverse event) |
| false negatives | 0 |
| precision / recall | 1.00 / 1.00 on this clip (an earlier tracker configuration scored 1.00 / 0.67, see below) |

The first version missed the blue, black/white and flat white plastic-wrapped parcels. Frame by frame YOLO-World *does* detect them
(0.10-0.22); ByteTrack threw them away: with `fuse_score` on, the association cost is 1 - IoU x score, so a 0.15 detection can never
pass `match_thresh`, and `new_track_thresh` 0.25 stops it starting a track. `trackers/bytetrack_parcels.yaml` fixes both (no
training). On this clip the stationary stock never changes side of the line in compensated coordinates, so hysteresis + confirmation
alone already rejected it; the ROI and relevance rules are verified by unit tests for the cases where it would (stock jittering across
a line under camera shake, boxes carried past the belt, duplicate tracker ids).

**Receiving (Pexels 6170064, 12 s).** Ground truth: one hand-truck load (two stacked cartons) is wheeled from the van across the
receiving line at ≈9 s; nothing else crosses. Detected: 2 confirmed inbound crossings at 9.0 s. YOLO-World boxes the stack as one
box plus the top carton inside it; `groups.py` turns that into two cartons (stack minus top carton), training-free; see below.

**Storage (Pexels 6170323).** Ground truth: the worker reaches through from behind the shelf and lifts out one carton. Detected: one
confirmed removal at 15.4 s; slots covered by the worker are "unknown" (not empty) and two short lifts (0.3 s, 0.9 s) stay below the
2 s confirmation, so no false removal.

Candidates rejected: Pexels 4292301 (aisle; tracking shot, the camera itself travels ~1,800 px) and 5100052 (static camera, but a
chest-height close-up where the worker covers the shelf most of the clip; the current storage clip already shows a verified removal).

Shelf assignments (Shelf 1 water bottles, Shelf 2 kitchen utensils, Shelf 3 phone chargers), products, starting counts and all
records are **sample configuration**. The cartons in the footage are generic boxes; the camera verifies *changes*, it does not read
what is inside a box.

**Misplaced items** need a product identity. Identity comes from an operator link (Cameras → camera → Tracked objects → Identify),
a barcode integration, or a product-class detection (`sku`/`identitySource` on an event, e.g. YOLO-World prompts mapped to SKUs).
A movement identified as a product that belongs on another shelf raises a `misplaced_item` incident with the expected location and
does not change the shelf's own stock estimate. In the demo footage nothing is identifiable by vision, so no misplaced-item incident
exists until an operator identifies a tracked box; `tests/test_backend.py` exercises the full path. Observations from different
cameras are joined into one history only through a verified identity (Inventory → Find an item).

## Surveillance Mode (the landing page, `/`)
The root URL is a dark, near-fullscreen 2x2 wall of the four recorded camera feeds. It is labelled
"Recorded analysis / AI playback", never "live", and each tile shows its own session time because the clips were not recorded together.

- **Overlays are not burned in.** The tile plays the clean original video; an SVG layer draws boxes from the track samples stored in
  Convex (`ui.surveillance`, up to 80 samples per track, linearly interpolated, hidden when the gap between samples is over 1 s so a box is never invented).
- **Colour comes from evidence, not appearance:** blue tracking (no event yet), green verified (confirmed movement that matches records),
  amber needs review (uncertain detection), red discrepancy (unmatched against records or misplaced SKU). Product names appear only when
  the SKU is known from shelf configuration or an operator link. No identities and no cross-camera matching are shown.
- **Shelf zones and count lines** are drawn only on cameras whose measured drift is under 80 px; the handheld aisle camera gets boxes only.
- **Focus view** (`/?cam=<id>&t=<seconds>`): playback controls, event markers that seek, click a box for the object panel (id, product if
  known, seen times, zones, events, state, linked incident, "Ask about this item"). "All cameras" returns to the wall and the tile resumes where the focus left off.
- **Ask StockLens panel** slides in with the camera, track, event or incident as context and shares conversations with `/ask` (`&chat=<id>`).
  Clicking evidence in an answer seeks the matching camera.
- **Workspace links:** "Open Workspace" goes to `/dashboard`; every workspace page has "Back to Surveillance"; evidence cards on the investigation,
  inventory and cameras pages have "Open in surveillance" which opens the camera at the event time. All earlier URLs still work.

## How movements are decided (observation vs inference vs record)
* **Observation**: a box detection inside a shelf polygon or near a count line (`tracks.samples`).
* **Shelf addition/removal** (`shelf_monitor.py`): slots are discovered where a box rests >= 2 s. Each frame a slot is occupied
  (detection overlap, or the slot still looks like it did while the box rested: normalised cross-correlation >= 0.7), empty
  (fully in view, no detection, appearance changed) or unknown (partly out of frame, person standing in front, ambiguous).
  Removal = confirmed occupied -> empty for 2 s. Addition = confirmed empty for 1 s -> occupied for 1 s. Unknown frames never
  count, so occlusion and one-frame drop-outs cannot change stock. Back within 5 s = no movement. Too little footage to confirm
  but a worker was at the slot = **uncertain** removal, stored for review and never counted until an operator confirms it.
* **Checkpoint crossing** (`movement_monitor.py`): side of a directional line with 12 px hysteresis and 5-observation
  confirmation; counted once per track as the net result (forward, back, forward = one). Crossings across an observation gap
  are uncertain.
* **Reconciliation** (Convex `lib.ts`, deterministic): shelf estimate = verified start + confirmed additions - confirmed removals,
  compared with recorded quantity; partly visible shelves compare net changes instead of claiming a quantity. Checkpoints compare
  confirmed crossings with recorded transactions per footage window, matching one-to-one by package id first, then nearest time
  within the checkpoint tolerance. Only the checkpoint's counting camera counts (a second camera's view of the same transfer is
  stored but not counted), and a package id is counted once per checkpoint. Transactions outside analysed footage are
  "not covered", never "unmatched".
* **Records change only by approved correction**: one operator requests, a different operator approves; the approval writes an
  adjustment transaction and the discrepancy closes itself when numbers agree.

## Claude in the product (both make real Anthropic API calls from Convex actions; the key never reaches the browser)
**Ask StockLens** (`web/convex/assistant.ts`, `assistantData.ts`, page `/ask`). A conversational assistant over the visual memory.
* Read-only tools into Convex, each a narrow indexed query: `list_shelves`, `get_location`, `list_products`, `search_movements`
  (by location, camera, type, track, SKU, package, verification, or "no matching transaction"), `get_movements_by_id`,
  `list_incidents`, `get_incident`, `get_camera`, `get_track`, `get_item_history`. No database dump goes into the prompt.
* Answers cite records with markers (`[[ev:<eventId>]]`, `[[inc:INC-102]]`, `[[loc:SHELF-2]]`, `[[cam:...]]`, `[[sku:...]]`). The server keeps
  only citations of records the tools actually returned in this conversation and removes the rest (the UI shows how many were removed).
  Event citations become clickable clips that open the processed footage at the right second.
* Conversations and messages are stored in Convex (`conversations`, `chatMessages`), so history persists and follow-ups ("where was it
  seen afterward?", "show me the footage") keep their context. Progress ("Searching camera movements…") streams to the UI reactively.
* Opened from an incident, a shelf, a camera or a movement, the conversation starts with that context.
* The prompt forbids inventing identities, quantities or cross-camera matches; tracking labels are explained as per-recording.
* No key: the message fails with "Claude is not configured. Set ANTHROPIC_API_KEY on the Convex deployment" (tested).

**Investigation agent** (`web/convex/agent.ts`) runs automatically when a discrepancy opens and from the incident page; it saves facts,
hypotheses, missing evidence, a recommendation and checked citations, and may propose a correction that a human must approve.

Model `claude-opus-5-5` (override with `CLAUDE_MODEL`), with server-side refusal fallback enabled. Configure with
`npx convex env set ANTHROPIC_API_KEY <key>` in `web/`. Tests: `tests/test_assistant.py` (real calls, multi-turn, citations).

## Status (honest)
| Item | State |
|---|---|
| YOLOv8 + ByteTrack, both profiles, real footage | working, verified against the footage |
| Convex schema, idempotent ingestion, reconciliation, discrepancies, workflow, audit | working, covered by `tests/test_backend.py` |
| Reactive dashboard (no refresh) | working; subscription test in `tests/test_backend.py` |
| Job queue: "Analyse footage" in the UI -> `worker.py` | working |
| Claude (Ask StockLens + investigation agent) | working with real API calls; `tests/test_assistant.py` passes (6 questions, multi-turn, clickable evidence) |
| Elastic Agent Builder | **not implemented**: no Elastic Serverless credentials were available. Search runs on Convex indexes (`ui.searchEvents`). |
| RTSP / live cameras | not implemented; the source field accepts `rtsp://` and the worker refuses it with a clear message |
| Surveillance Mode | working, verified in the browser (grid, overlays, focus seek, object panel, Ask panel, workspace round trip). Playback of recorded clips only; feeds are not time-synchronised; receiving-dock crossings are low-light and stay "needs review" |
| Authentication | none: operators type a name that is audited. Production needs Convex Auth / SSO and role checks on `ops.*` |

## Detection and counting rules (why a detection is not a movement)
**Why the detector used to see "only square boxes".** Nothing geometric filtered shapes. The causes were configuration:
(1) the only package prompts were cardboard-box phrases on the small `yolov8s-worldv2` model; (2) the COCO model was restricted to
class 0 (person), so COCO classes such as `bottle` were never used; (3) every non-person detection became a generic "package";
(4) most decisive: ByteTrack's default `new_track_thresh` is 0.25, so a plastic-wrapped parcel that YOLO-World scores 0.08-0.24
could never start a track, whatever the detection threshold. Wrapped parcels simply never became tracks.

Now, per camera (`cameras.py` rules, stored in Convex): `world_weights` (the dispatch and receiving cameras use `yolov8l-worldv2`),
`box_prompts`, `box_conf`, `coco_items` (e.g. `["bottle"]`, tracked by YOLOv8m), `tracker` (`trackers/bytetrack_parcels.yaml`:
weak-but-consistent detections may start a track), class-agnostic NMS (one parcel matched by two prompts is one box). YOLO-World
prompt labels are not reliable categories (it calls most parcels "cardboard box"), so a track's `category` is "package" unless a
COCO class was detected; no SKU is ever inferred from appearance. Recognising specific products (a brand of bottled water, a SKU)
would need either a fine-tuned YOLOv8 on labelled images of those products or barcode / label reading.

**Movement cameras (receiving, aisle, dispatch)** separate three questions:
1. *Detection confidence*: how sure YOLO is that an object is there.
2. *Tracking quality*: share of frames in the track span where the object was observed, reduced when the identity was stitched from
   several tracker ids (`relevance.py`).
3. *Event confidence*: how clearly the trajectory satisfied the movement rule (observations on both sides, travel, gaps).

A track can only produce a movement if it is **monitored**: it moved (median-start to median-end displacement >= `stationary_px`)
and spent most of its life inside the camera's **ROI** polygon (`rules.roi`, reference coordinates, followed through camera motion).
Stationary stock is `background_static`; a box moving elsewhere is `outside_roi`. Both are still detected, tracked and drawn
(grey, dashed) but never counted. A crossing then needs: the box's anchor (`bottom_center` = contact point with belt/floor) inside the
ROI, `confirm_frames` observations beyond the hysteresis band on each side, at least `min_travel_px` of travel across the line within
`travel_window_s`, net direction, and no duplicate (crossings within `dedupe_s` / `dedupe_px` on the same line are one parcel whose
tracker id changed). Weak detections, observation gaps or poor tracking keep the event but mark it *uncertain* (operator review, not
counted). Shelf cameras do not use relevance: stationary stock is exactly what they monitor.

### Boxes that cover several objects (groups.py, training-free)
YOLO-World sometimes returns one box around two cartons. Per frame: a box that contains two or more detected cartons covering most of it
is a duplicate *group* box and is dropped (on the storage camera such a box hid the FRAGILE carton's label); a box that contains exactly
one detected carton spanning its width is a *stack*: it becomes the remainder (stack minus that carton), flagged as derived in the
track's notes, and the carton on top takes the stack's floor contact point as its anchor so both cross a floor line together. Shelf
cameras only drop group boxes (each carton in a shelf column is already detected on its own). Dedupe never merges two crossings whose
boxes do not overlap, so two cartons on one hand truck are two movements.

## Limits of the computer vision
* COCO YOLOv8 has no carton class; cartons come from YOLOv8-World text prompts (pretrained, no training). Mean confidence 0.2-0.8.
* Depth is unknown in 2D: "a person whose box ends above the shelf's lower edge is behind it" is a heuristic.
* A box hidden behind another box placed in front of it looks like a removal unless it reappears.
* Slots are only learned from boxes that rest >= 2 s; a box present for less is never counted.
* Zones, lines and verified counts are configured by hand per camera.
* A stacked carton that YOLO never boxes on its own is only recovered when the stack box AND one carton in it are detected in the same
  frames (held for 0.5 s through misses). A stack where YOLO sees only the whole stack still counts as one.
* Pretrained YOLO-World is weakest on plastic-wrapped parcels (scores 0.1-0.2); the tuned tracker keeps them, but a site with many such
  parcels would still benefit from a fine-tuned YOLOv8.
* Camera-motion compensation is an affine fit to the background; a zooming camera leaves up to ~110 px residual on parked objects
  (receiving uses `stationary_px` 140 for this reason).

## Security and privacy
Worker-to-Convex calls require `INGEST_SECRET`; operator mutations validate input server-side and are audited; inventory
corrections need two different people. Footage stays on the worker host; only evidence stills and processed clips are published
to `web/public/media`. Retention of those files is not managed yet. People are detected only as "Worker N" and are not identified.
