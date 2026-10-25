"""Offline analysis of a clip with a camera config (no Convex): prints track relevance and movement events.

  python tests/eval_footage.py dispatch data/candidates/5903898.mp4
"""
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bootstrap_demo
from cameras import Config, validate
import process_video

CONFIGS = {"dispatch": bootstrap_demo.dispatch_config, "receiving": bootstrap_demo.receiving_config}


def run(kind, video, fresh=False):
    cfg_d = CONFIGS[kind]()
    assert not validate(cfg_d), validate(cfg_d)
    return process_video.analyse(video, Config(cfg_d), fresh)


if __name__ == "__main__":
    A = run(sys.argv[1], sys.argv[2], "--fresh" in sys.argv)
    for name, r in A["relevance"].items():
        st = next(s for s in A["engine"].states if s.name == name)
        o = st.e["obs"]
        print(f"{name:12s} {r['relevance']:18s} disp={r['displacement_px']:6.0f} roi={r['roi_fraction']:.2f} q={r['tracking_quality']:.2f} "
              f"t={o[0].f / A['meta']['fps']:.1f}-{o[-1].f / A['meta']['fps']:.1f}s conf={st.mean_conf:.2f} ids={st.e['tracker_ids']}")
    print("\nEVENTS")
    for e in A["events"]:
        print(f"  t={e['t']:5.2f}s {e['track_ref']:12s} {e['direction']:8s} {e['verification']:9s} det={e['detection_conf']:.2f} trk={e['tracking_quality']:.2f} evt={e['event_conf']:.2f}")
    if A["movement"]:
        print("DROPPED", A["movement"].dropped)
