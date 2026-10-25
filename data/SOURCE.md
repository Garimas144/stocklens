# Input video

`conveyor_line.mp4` is Pexels video 5370836 (1920x1080, 30 fps, 17 s): real parcels riding a conveyor belt into a truck dock, filmed handheld.
Page: https://www.pexels.com/video/unloading-packages-on-a-conveyor-belt-5370836/
Downloaded from videos.pexels.com/video-files/5370836/5370836-hd_1920_1080_30fps.mp4 under the Pexels license (free to use, attribution not required).

`conveyor_line.zones.json` holds the three belt stages (polygons in first-frame pixels) and the belt direction `_flow`.
To analyse your own clip: copy `my.mp4` into `data/`, create `data/my.zones.json` in the same format, run `python process_video.py data/my.mp4`.
Each clip gets its own `outputs/<name>/` folder, and the dashboard lists them.

## Four-camera demo (bootstrap_demo.py)
| Camera | File | Pexels id |
|---|---|---|
| CAM 01 Receiving | receiving_van.mp4 | 6170064 (worker unloads a delivery van and wheels cartons in on a hand truck, daylight) |
| CAM 02 Storage | shelf_removal.mp4 | 6170323 (worker takes a box from a shelf unit) |
| CAM 03 Aisle | storage_aisle.mp4 | 4281239 (pallet pulled through a warehouse aisle) |
| CAM 04 Dispatch | dispatch_belt.mp4 | 5903898 (parcels moving on a conveyor belt, stock parked behind it) |
| CAM 05 Shelf 3 close-up | shelf_addition.mp4 | 6170331 (box placed into a shelf slot) |
All under the Pexels license. They are different real locations used as stages of one demo warehouse.

Downloaded 2026-10-24 from videos.pexels.com (1920x1080) under the Pexels license (free to use, attribution not required).
Earlier clips `receiving_dock.mp4` (4473271, night, low light) and `conveyor_line.mp4` (5370836, handheld) are kept in data/ but no
longer used by the demo. `data/candidates/` holds every clip that was evaluated, including the rejected 4292301 and 5100052.
