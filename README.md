# 🛰️ SafeSight — Real-Time Object Detection

A real-time computer-vision web app: your webcam streams to a Python backend that runs
**YOLOv8** inference on every frame and streams detections back over a **WebSocket**, drawing
live bounding boxes and a class-count dashboard in the browser — all with sub-100ms latency on CPU.

> Built to demonstrate end-to-end ML engineering: model serving, real-time streaming, and a production-style frontend.

<!-- Record a 20–30s screen capture and drop it here -->
![demo](docs/demo.gif)

**Live demo video:** _add your YouTube/Loom link here_

---

## ✨ Features
- 🧠 **Three CV tasks in one engine** — switch live between:
  - **Object detection** — 80 COCO classes with HUD-style corner-bracket boxes
  - **Instance segmentation** — pixel-accurate colored masks tracing each object
  - **Pose estimation** — real-time 17-keypoint skeleton tracking on people
- 🎚️ **Live confidence threshold** — tune precision/recall from the UI in real time
- 📡 **WebSocket streaming** — frames up, results down, no page reloads
- 📊 **Analytics dashboard** — inference FPS, live counts, peak, unique classes, session uptime + rolling detection feed
- ⚙️ **Clean service split** — FastAPI inference API + React (Vite) client

## 🧱 Architecture
```
Browser (React)                    Backend (FastAPI)
  webcam ──▶ capture JPEG frame
         ──▶ WebSocket send  ─────▶  decode ─▶ YOLOv8 inference
  draw boxes ◀── detections ◀─────  boxes + counts + FPS (JSON)
```

## 🛠️ Tech Stack
**ML/CV:** Python, PyTorch, Ultralytics YOLOv8 (detect / seg / pose), OpenCV
**Backend:** FastAPI, WebSockets, Uvicorn
**Frontend:** React, Vite, Canvas API

## 🚀 Run it locally

**Backend**
```bash
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py            # serves on http://localhost:8000
```

**Frontend** (new terminal)
```bash
cd frontend
npm install
npm run dev               # opens http://localhost:5173
```

Open the app, click **Start**, and allow camera access.

## 🔮 Roadmap
- Custom-trained model for a domain problem (PPE / safety compliance)
- Object tracking + dwell-time analytics
- Dockerized deploy with a hosted demo URL

---
Built by **Sunny Kumpati** · [LinkedIn](https://www.linkedin.com/in/sunnykumpati/) · [GitHub](https://github.com/Sunnykumpati976)
