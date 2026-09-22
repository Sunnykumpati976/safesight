import { useEffect, useRef, useState, useCallback } from "react";
import "./App.css";

const WS_URL = "ws://localhost:8000/ws/detect";
const SEND_INTERVAL_MS = 80;

// Stable color per class label so boxes don't flicker between colors.
function colorFor(label) {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = label.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${hash % 360}, 90%, 60%)`;
}

export default function App() {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const grabRef = useRef(null);
  const wsRef = useRef(null);
  const sendTimer = useRef(null);
  const rafRef = useRef(null);
  const latest = useRef([]);          // most recent detections (drawn every frame)
  const startTs = useRef(null);

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [fps, setFps] = useState(0);
  const [counts, setCounts] = useState({});
  const [total, setTotal] = useState(0);
  const [peak, setPeak] = useState(0);
  const [uniqueSeen, setUniqueSeen] = useState(0);
  const [uptime, setUptime] = useState("00:00");
  const [feed, setFeed] = useState([]);
  const seenClasses = useRef(new Set());

  // Draw a HUD-style detection box: corner brackets + glow + label chip + conf bar.
  const drawBox = useCallback((ctx, d, W, H) => {
    const x = d.x * W, y = d.y * H, w = d.w * W, h = d.h * H;
    const c = colorFor(d.label);
    const len = Math.min(w, h) * 0.22 + 6; // corner arm length

    ctx.save();
    ctx.strokeStyle = c;
    ctx.shadowColor = c;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    // four corner brackets
    const corners = [
      [[x, y + len], [x, y], [x + len, y]],
      [[x + w - len, y], [x + w, y], [x + w, y + len]],
      [[x + w, y + h - len], [x + w, y + h], [x + w - len, y + h]],
      [[x + len, y + h], [x, y + h], [x, y + h - len]],
    ];
    for (const pts of corners) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[1][0], pts[1][1]);
      ctx.lineTo(pts[2][0], pts[2][1]);
      ctx.stroke();
    }
    // faint fill
    ctx.shadowBlur = 0;
    ctx.fillStyle = c.replace(")", ", 0.08)").replace("hsl", "hsla");
    ctx.fillRect(x, y, w, h);

    // label chip
    const label = `${d.label}  ${Math.round(d.conf * 100)}%`;
    ctx.font = "600 15px system-ui, sans-serif";
    const tw = ctx.measureText(label).width + 16;
    ctx.fillStyle = c;
    ctx.fillRect(x, y - 26, tw, 22);
    ctx.fillStyle = "#04070d";
    ctx.fillText(label, x + 8, y - 10);
    // confidence bar under the chip
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(x, y - 4, tw, 3);
    ctx.fillStyle = c;
    ctx.fillRect(x, y - 4, tw * d.conf, 3);
    ctx.restore();
  }, []);

  // Continuous render loop → boxes stay painted between model responses (smooth).
  const renderLoop = useCallback(() => {
    const overlay = overlayRef.current, video = videoRef.current;
    if (overlay && video && video.videoWidth) {
      const W = (overlay.width = video.videoWidth);
      const H = (overlay.height = video.videoHeight);
      const ctx = overlay.getContext("2d");
      ctx.clearRect(0, 0, W, H);
      for (const d of latest.current) drawBox(ctx, d, W, H);
    }
    rafRef.current = requestAnimationFrame(renderLoop);
  }, [drawBox]);

  const start = useCallback(async () => {
    setStatus("starting camera…");
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
    videoRef.current.srcObject = stream;
    await videoRef.current.play();

    setStatus("connecting…");
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("live");
      setRunning(true);
      startTs.current = Date.now();
      seenClasses.current = new Set();
      const grab = grabRef.current;
      sendTimer.current = setInterval(() => {
        const video = videoRef.current;
        if (!video || ws.readyState !== WebSocket.OPEN) return;
        grab.width = video.videoWidth;
        grab.height = video.videoHeight;
        grab.getContext("2d").drawImage(video, 0, 0);
        ws.send(grab.toDataURL("image/jpeg", 0.65));
      }, SEND_INTERVAL_MS);
      rafRef.current = requestAnimationFrame(renderLoop);
    };

    ws.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      const dets = data.detections || [];
      latest.current = dets;
      setFps(data.fps || 0);
      setCounts(data.counts || {});
      setTotal(dets.length);
      setPeak((p) => Math.max(p, dets.length));
      for (const d of dets) seenClasses.current.add(d.label);
      setUniqueSeen(seenClasses.current.size);
      if (dets.length) {
        const top = dets.reduce((a, b) => (b.conf > a.conf ? b : a));
        setFeed((f) => [
          { t: new Date().toLocaleTimeString(), label: top.label, conf: top.conf, n: dets.length },
          ...f,
        ].slice(0, 8));
      }
    };

    ws.onclose = () => { setStatus("disconnected"); setRunning(false); };
    ws.onerror = () => setStatus("error — is the backend running?");
  }, [renderLoop]);

  const stop = useCallback(() => {
    clearInterval(sendTimer.current);
    cancelAnimationFrame(rafRef.current);
    wsRef.current?.close();
    videoRef.current?.srcObject?.getTracks().forEach((t) => t.stop());
    latest.current = [];
    overlayRef.current?.getContext("2d").clearRect(0, 0, 9999, 9999);
    setRunning(false); setStatus("stopped");
    setCounts({}); setTotal(0); setFps(0);
  }, []);

  // uptime ticker
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const s = Math.floor((Date.now() - startTs.current) / 1000);
      setUptime(`${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => () => stop(), [stop]);

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo">◎</span>
          <div>
            <h1>SafeSight</h1>
            <p>Real-time object detection · YOLOv8-s · streamed over WebSocket</p>
          </div>
        </div>
        <span className={`live-pill ${status === "live" ? "on" : ""}`}>
          <i /> {status === "live" ? "LIVE" : status.toUpperCase()}
        </span>
      </header>

      <div className="layout">
        <div className="stage">
          <video ref={videoRef} playsInline muted />
          <canvas ref={overlayRef} className="overlay" />
          <canvas ref={grabRef} style={{ display: "none" }} />
          <div className="scanline" />
          {running && (
            <div className="hud">
              <span>◉ REC</span><span>{fps} FPS</span><span>{total} OBJ</span>
            </div>
          )}
          {!running && <div className="hint">Press <b>Start</b> and allow camera access</div>}
        </div>

        <aside className="panel">
          <button className={running ? "act stop" : "act start"} onClick={running ? stop : start}>
            {running ? "■ Stop" : "▶ Start Detection"}
          </button>

          <div className="stats">
            <div className="stat"><span>{fps}</span><label>FPS</label></div>
            <div className="stat"><span>{total}</span><label>objects</label></div>
            <div className="stat"><span>{peak}</span><label>peak</label></div>
            <div className="stat"><span>{uniqueSeen}</span><label>classes</label></div>
            <div className="stat wide"><span>{uptime}</span><label>session uptime</label></div>
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

          <h3>Detection feed</h3>
          <ul className="feed">
            {feed.length === 0 && <li className="empty">—</li>}
            {feed.map((f, i) => (
              <li key={i}>
                <code>{f.t}</code>
                <span className="dot" style={{ background: colorFor(f.label) }} />
                {f.label} <em>{Math.round(f.conf * 100)}%</em>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <footer>Built by Sunny Kumpati · FastAPI + YOLOv8 + React · WebSocket streaming</footer>
    </div>
  );
}
