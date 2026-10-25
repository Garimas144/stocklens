"""CV worker: claims analysis jobs queued from the dashboard (Convex `jobs` table) and runs the YOLOv8 pipeline on them.

  python worker.py            # run forever
  python worker.py --once     # process at most one job, then exit

The worker is the only component that touches video. It needs CONVEX_URL and INGEST_SECRET (.env.worker). Several workers can run
side by side: claiming a job is a Convex transaction, so each job runs once.
"""
import sys
import time
import traceback
from convex_bridge import Bridge
import process_video


def main(once=False):
    br = Bridge()
    print("worker ready; polling Convex for jobs")
    while True:
        job = br.claim_job()
        if job:
            print(f"job {job['_id']}: camera {job['cameraId']} (requested by {job['requestedBy']})")
            try:
                sid, res = process_video.run_camera(job["cameraId"], fresh=not job["reuseCache"], bridge=br, job_id=job["_id"])
                br.update_job(job["_id"], status="done", progress=1.0, sessionId=sid)
            except BaseException as ex:  # SystemExit from config problems included: report it on the job
                traceback.print_exc()
                br.update_job(job["_id"], status="error", error=f"{type(ex).__name__}: {ex}"[:500])
            if once:
                return
        elif once:
            print("no queued job")
            return
        else:
            time.sleep(2)


if __name__ == "__main__":
    main(once="--once" in sys.argv)
