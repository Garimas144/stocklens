"""Camera-motion compensation. The stock clip drifts, so fixed image-space zones would slide over the floor.
We estimate a frame-to-reference affine transform from background feature flow (RANSAC rejects moving workers/pallets)
and express every detection in the coordinates of the first frame."""
import cv2
import numpy as np


class CameraMotion:
    def __init__(self, scale=0.5):
        self.scale = scale
        self.prev = None
        self.H = np.eye(3)       # current frame -> reference frame (full-res pixels)
        self.inliers = 1.0

    def update(self, frame, ignore_boxes=()):
        g = cv2.cvtColor(cv2.resize(frame, None, fx=self.scale, fy=self.scale), cv2.COLOR_BGR2GRAY)
        if self.prev is not None:
            mask = np.full(g.shape, 255, np.uint8)
            for x1, y1, x2, y2 in ignore_boxes:
                s = self.scale
                cv2.rectangle(mask, (int(x1 * s), int(y1 * s)), (int(x2 * s), int(y2 * s)), 0, -1)
            p0 = cv2.goodFeaturesToTrack(self.prev, 600, 0.01, 8, mask=mask)
            if p0 is not None and len(p0) >= 12:
                p1, st, _ = cv2.calcOpticalFlowPyrLK(self.prev, g, p0, None, winSize=(21, 21), maxLevel=3)
                ok = st.ravel() == 1
                if ok.sum() >= 12:
                    M, inl = cv2.estimateAffine2D(p1[ok], p0[ok], method=cv2.RANSAC, ransacReprojThreshold=2.0)  # cur -> prev
                    if M is not None:
                        self.inliers = float(inl.mean())
                        s = self.scale
                        S, Si = np.diag([s, s, 1]), np.diag([1 / s, 1 / s, 1])
                        step = Si @ np.vstack([M, [0, 0, 1]]) @ S
                        self.H = self.H @ step
        self.prev = g
        return self.H

    def to_ref(self, x, y):
        v = self.H @ np.array([x, y, 1.0])
        return float(v[0]), float(v[1])
