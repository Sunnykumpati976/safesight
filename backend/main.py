"""
SafeSight — real-time computer-vision backend.

A FastAPI service that accepts webcam frames over a WebSocket and runs one of three
YOLOv8 tasks per frame — object **detection**, instance **segmentation**, or **pose**
estimation — streaming the results back for the browser to render as a live overlay.
"""
from __future__ import annotations

import base64
import json
import time
from contextlib import asynccontextmanager

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

# One model per task. "s" (small) balances accuracy and real-time speed on CPU.
MODEL_FILES = {
    "detect": "yolov8s.pt",
    "segment": "yolov8s-seg.pt",
    "pose": "yolov8s-pose.pt",
}
MODELS: dict[str, YOLO] = {}
IMG_SIZE = 640


@asynccontextmanager
async def lifespan(app: FastAPI):
    for task, fname in MODEL_FILES.items():
        print(f"[SafeSight] loading {task} model ({fname}) ...")
        m = YOLO(fname)
        m.predict(np.zeros((640, 640, 3), dtype=np.uint8), verbose=False)  # warm up
        MODELS[task] = m
    print("[SafeSight] all models ready.")
    yield
    MODELS.clear()


app = FastAPI(title="SafeSight API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "tasks": list(MODELS.keys()), "loaded": len(MODELS) == 3}


def _decode_frame(data_url: str) -> np.ndarray | None:
    try:
        _, _, encoded = data_url.partition(",")
        arr = np.frombuffer(base64.b64decode(encoded), dtype=np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)
    except Exception:
        return None


def _run(task: str, frame: np.ndarray, conf: float) -> dict:
    model = MODELS[task]
    res = model.predict(frame, conf=conf, imgsz=IMG_SIZE, verbose=False)[0]
    h, w = frame.shape[:2]
    counts: dict[str, int] = {}

    if task == "pose":
        people = []
        kpts = res.keypoints
        if kpts is not None and kpts.xyn is not None:
            for person in kpts.xyn.cpu().numpy():  # (17, 2) normalized
                # attach visibility/conf if present
                pts = [[float(x), float(y)] for x, y in person]
                people.append(pts)
        counts["person"] = len(people)
        return {"mode": "pose", "people": people, "counts": counts}

    if task == "segment":
        polygons = []
        masks = res.masks
        names = res.names
        if masks is not None and masks.xyn is not None:
            for poly, box in zip(masks.xyn, res.boxes):
                label = names[int(box.cls[0])]
                polygons.append(
                    {
                        "points": [[float(x), float(y)] for x, y in poly],
                        "label": label,
                        "conf": round(float(box.conf[0]), 2),
                    }
                )
                counts[label] = counts.get(label, 0) + 1
        return {"mode": "segment", "polygons": polygons, "counts": counts}

    # detect
    detections = []
    for box in res.boxes:
        label = res.names[int(box.cls[0])]
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        detections.append(
            {
                "x": x1 / w, "y": y1 / h,
                "w": (x2 - x1) / w, "h": (y2 - y1) / h,
                "label": label, "conf": round(float(box.conf[0]), 2),
            }
        )
        counts[label] = counts.get(label, 0) + 1
    return {"mode": "detect", "detections": detections, "counts": counts}


@app.websocket("/ws/detect")
async def detect(ws: WebSocket) -> None:
    await ws.accept()
    print("[SafeSight] client connected")
    try:
        while True:
            raw = await ws.receive_text()
            t0 = time.perf_counter()
            try:
                msg = json.loads(raw)
                frame = _decode_frame(msg.get("frame", ""))
                task = msg.get("mode", "detect")
                conf = float(msg.get("conf", 0.4))
            except Exception:
                frame, task, conf = None, "detect", 0.4

            if frame is None or task not in MODELS:
                await ws.send_json({"mode": task, "counts": {}, "fps": 0})
                continue

            payload = _run(task, frame, conf)
            payload["fps"] = round(1.0 / max(time.perf_counter() - t0, 1e-6), 1)
            await ws.send_json(payload)
    except WebSocketDisconnect:
        print("[SafeSight] client disconnected")
    except Exception as exc:
        print(f"[SafeSight] error: {exc}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
