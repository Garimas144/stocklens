import cv2


def info(path):
    cap = cv2.VideoCapture(path)
    meta = dict(fps=cap.get(cv2.CAP_PROP_FPS) or 25.0, frames=int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
                width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    cap.release()
    meta["duration"] = meta["frames"] / meta["fps"]
    return meta


def frames(path):
    cap = cv2.VideoCapture(path)
    i = 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        yield i, f
        i += 1
    cap.release()
