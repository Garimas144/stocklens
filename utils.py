import os, shutil, subprocess


def fmt(t):
    s = int(round(max(0, t)))
    return f"{s // 60:02d}:{s % 60:02d}"


def fmt1(t):
    return f"{int(t // 60):02d}:{t % 60:04.1f}"


def iou(a, b):
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def to_h264(tmp, dst):
    """Re-encode to H.264 so browsers can play it (falls back to the raw mp4v file if ffmpeg is missing)."""
    if shutil.which("ffmpeg"):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmp, "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-movflags", "+faststart", dst], check=True)
        os.remove(tmp)
    else:
        os.replace(tmp, dst)
