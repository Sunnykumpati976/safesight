"""
SafeSight — real-time object detection backend.

A FastAPI service that accepts webcam frames over a WebSocket, runs YOLOv8
inference on each frame, and streams back detections (boxes, labels, scores)
plus lightweight per-class counts for the live dashboard.
"""
from __future__ import annotations

import base64
import time
from contextlib import asynccontextmanager

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

# Loaded once at startup and reused for every connection/frame.
MODEL: YOLO | None = None
MODEL_NAME = "yolov8n.pt"  # nano = fast enough for real-time on CPU
CONF_THRESHOLD = 0.35


@asynccontextmanager
async def lifespan(app: FastAPI):
    global MODEL
    print(f"[SafeSight] loading model {MODEL_NAME} ...")
    MODEL = YOLO(MODEL_NAME)  # downloads weights on first run, then cached
    # Warm up so the first real frame isn't slow.
    MODEL.predict(np.zeros((640, 640, 3), dtype=np.uint8), verbose=False)
    print("[SafeSight] model ready.")
    yield
    MODEL = None


app = FastAPI(title="SafeSight API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # demo only; lock this down for production
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME, "loaded": MODEL is not None}


def _decode_frame(data_url: str) -> np.ndarray | None:
    """Turn a base64 data URL from the browser into a BGR image array."""
    try:
        header, _, encoded = data_url.partition(",")
        raw = base64.b64decode(encoded or header)
        arr = np.frombuffer(raw, dtype=np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)
    except Exception:
        return None


@app.websocket("/ws/detect")
async def detect(ws: WebSocket) -> None:
    await ws.accept()
    print("[SafeSight] client connected")
    try:
        while True:
            data_url = await ws.receive_text()
            t0 = time.perf_counter()
            frame = _decode_frame(data_url)
            if frame is None or MODEL is None:
                await ws.send_json({"detections": [], "counts": {}, "fps": 0})
                continue

            results = MODEL.predict(frame, conf=CONF_THRESHOLD, verbose=False)[0]
            h, w = frame.shape[:2]

            detections = []
            counts: dict[str, int] = {}
            for box in results.boxes:
                cls_id = int(box.cls[0])
                label = MODEL.names[cls_id]
                conf = float(box.conf[0])
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                detections.append(
                    {
                        # normalized 0..1 so the frontend scales to any video size
                        "x": x1 / w,
                        "y": y1 / h,
                        "w": (x2 - x1) / w,
                        "h": (y2 - y1) / h,
                        "label": label,
                        "conf": round(conf, 2),
                    }
                )
                counts[label] = counts.get(label, 0) + 1

            fps = round(1.0 / max(time.perf_counter() - t0, 1e-6), 1)
            await ws.send_json({"detections": detections, "counts": counts, "fps": fps})
    except WebSocketDisconnect:
        print("[SafeSight] client disconnected")
    except Exception as exc:  # keep the socket error from crashing the server
        print(f"[SafeSight] error: {exc}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
