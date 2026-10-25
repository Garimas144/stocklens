"""Thin client for the Convex backend (the system of record). The worker authenticates with INGEST_SECRET from .env.worker."""
import os
from convex import ConvexClient

BASE = os.path.dirname(os.path.abspath(__file__))


def load_env(path=os.path.join(BASE, ".env.worker")):
    env = {}
    if os.path.exists(path):
        for line in open(path):
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.strip().split("=", 1)
                env[k] = v
    for k in ("CONVEX_URL", "INGEST_SECRET", "MEDIA_DIR"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def floatify(x):
    """Convex v.number() is float64; the Python client sends int as Int64, so every int becomes a float (bools stay bools)."""
    if isinstance(x, bool) or x is None:
        return x
    if isinstance(x, int):
        return float(x)
    if isinstance(x, dict):
        return {k: floatify(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [floatify(v) for v in x]
    return x


class Bridge:
    def __init__(self):
        env = load_env()
        if not env.get("CONVEX_URL") or not env.get("INGEST_SECRET"):
            raise RuntimeError("CONVEX_URL and INGEST_SECRET must be set (see .env.worker / README)")
        self.client = ConvexClient(env["CONVEX_URL"])
        self.secret = env["INGEST_SECRET"]
        self.media_dir = os.path.join(BASE, env.get("MEDIA_DIR", "web/public/media"))

    def q(self, name, **args):
        return self.client.query(name, floatify(dict(args, secret=self.secret)))

    def m(self, name, **args):
        return self.client.mutation(name, floatify(dict(args, secret=self.secret)))

    # convenience wrappers
    def camera(self, camera_id):
        return self.q("worker:getCamera", cameraId=camera_id)

    def claim_job(self):
        return self.m("worker:claimJob")

    def update_job(self, job_id, **patch):
        return self.m("worker:updateJob", jobId=job_id, **{k: v for k, v in patch.items() if v is not None})

    def session(self, **s):
        return self.m("worker:upsertSession", **{k: v for k, v in s.items() if v is not None})

    def tracks(self, session_id, camera_id, tracks):
        return self.m("worker:replaceTracks", sessionId=session_id, cameraId=camera_id, tracks=tracks)

    def events(self, session_id, camera_id, events, final=True):
        return self.m("worker:publishEvents", sessionId=session_id, cameraId=camera_id, events=events, final=final)

    def seed(self, fixture):
        return self.m("worker:seed", fixture=fixture)
