import { useEffect, useRef, useState, useCallback } from "react";
import "./App.css";

const WS_URL = "ws://localhost:8000/ws/detect";
const SEND_INTERVAL_MS = 90; // ~11 fps of frames sent to the model

// Stable color per class label so boxes don't flicker between colors.
function colorFor(label) {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = label.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${hash % 360}, 85%, 55%)`;
}

export default function App() {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const grabRef = useRef(null); // hidden canvas used to grab JPEG frames
  const wsRef = useRef(null);
  const sendTimer = useRef(null);

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [fps, setFps] = useState(0);
  const [counts, setCounts] = useState({});
  const [total, setTotal] = useState(0);

  const draw = useCallback((detections) => {
    const overlay = overlayRef.current;
    const video = videoRef.current;
    if (!overlay || !video) return;
    const w = (overlay.width = video.videoWidth);
    const h = (overlay.height = video.videoHeight);
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = Math.max(2, w / 320);
    ctx.font = `${Math.max(14, w / 45)}px system-ui, sans-serif`;
    for (const d of detections) {
      const x = d.x * w, y = d.y * h, bw = d.w * w, bh = d.h * h;
      const c = colorFor(d.label);
      ctx.strokeStyle = c;
      ctx.strokeRect(x, y, bw, bh);
      const tag = `${d.label} ${Math.round(d.conf * 100)}%`;
      const tw = ctx.measureText(tag).width + 10;
      ctx.fillStyle = c;
      ctx.fillRect(x, y - 22, tw, 22);
      ctx.fillStyle = "#000";
      ctx.fillText(tag, x + 5, y - 5);
    }
  }, []);

  const start = useCallback(async () => {
    setStatus("starting camera…");
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 960, height: 540 } });
    videoRef.current.srcObject = stream;
    await videoRef.current.play();

    setStatus("connecting…");
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("live");
      setRunning(true);
      const grab = grabRef.current;
      sendTimer.current = setInterval(() => {
        const video = videoRef.current;
        if (!video || ws.readyState !== WebSocket.OPEN) return;
        grab.width = video.videoWidth;
        grab.height = video.videoHeight;
        grab.getContext("2d").drawImage(video, 0, 0);
        ws.send(grab.toDataURL("image/jpeg", 0.6));
      }, SEND_INTERVAL_MS);
    };

    ws.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      draw(data.detections || []);
      setFps(data.fps || 0);
      setCounts(data.counts || {});
      setTotal((data.detections || []).length);
    };

    ws.onclose = () => { setStatus("disconnected"); setRunning(false); };
    ws.onerror = () => setStatus("error — is the backend running?");
  }, [draw]);

  const stop = useCallback(() => {
    clearInterval(sendTimer.current);
    wsRef.current?.close();
    const stream = videoRef.current?.srcObject;
    stream?.getTracks().forEach((t) => t.stop());
    overlayRef.current?.getContext("2d").clearRect(0, 0, 9999, 9999);
    setRunning(false);
    setStatus("stopped");
    setCounts({});
    setTotal(0);
    setFps(0);
  }, []);

  useEffect(() => () => stop(), [stop]);

  return (
    <div className="app">
      <header>
        <h1>🛰️ SafeSight</h1>
        <p>Real-time object detection · YOLOv8 · streamed over WebSocket</p>
      </header>

      <div className="layout">
        <div className="stage">
          <video ref={videoRef} playsInline muted />
          <canvas ref={overlayRef} className="overlay" />
          <canvas ref={grabRef} style={{ display: "none" }} />
          {!running && <div className="hint">Press <b>Start</b> and allow camera access</div>}
        </div>

        <aside className="panel">
          <div className="controls">
            {running ? (
              <button className="stop" onClick={stop}>Stop</button>
            ) : (
              <button className="start" onClick={start}>Start</button>
            )}
            <span className={`badge ${status === "live" ? "on" : ""}`}>{status}</span>
          </div>

          <div className="stats">
            <div className="stat"><span>{fps}</span><label>inference FPS</label></div>
            <div className="stat"><span>{total}</span><label>objects now</label></div>
          </div>

          <h3>Live counts</h3>
          <ul className="counts">
            {Object.keys(counts).length === 0 && <li className="empty">nothing detected yet</li>}
            {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([label, n]) => (
              <li key={label}>
                <span className="dot" style={{ background: colorFor(label) }} />
                {label}<b>{n}</b>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <footer>Built by Sunny Kumpati · FastAPI + YOLOv8 + React</footer>
    </div>
  );
}
