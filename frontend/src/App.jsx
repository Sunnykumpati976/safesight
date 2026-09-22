import { useEffect, useRef, useState, useCallback } from "react";
import "./App.css";

const WS_URL = "ws://localhost:8000/ws/detect";
const SEND_INTERVAL_MS = 80;

// COCO 17-keypoint skeleton edges for pose mode.
const SKELETON = [
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [5, 11], [6, 12], [11, 12],
  [11, 13], [13, 15], [12, 14], [14, 16], [0, 1], [0, 2], [1, 3], [2, 4],
  [0, 5], [0, 6],
];

const MODES = [
  { id: "detect", label: "Objects", icon: "▢" },
  { id: "segment", label: "Segments", icon: "◈" },
  { id: "pose", label: "Pose", icon: "⛷" },
];

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
  const payload = useRef({ mode: "detect" }); // latest result, drawn every frame
  const startTs = useRef(null);
  const modeRef = useRef("detect");
  const confRef = useRef(0.4);

  const [mode, setMode] = useState("detect");
  const [conf, setConf] = useState(0.4);
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

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { confRef.current = conf; }, [conf]);

  const drawDetect = (ctx, dets, W, H) => {
    for (const d of dets) {
      const x = d.x * W, y = d.y * H, w = d.w * W, h = d.h * H;
      const c = colorFor(d.label);
      const len = Math.min(w, h) * 0.22 + 6;
      ctx.save();
      ctx.strokeStyle = c; ctx.shadowColor = c; ctx.shadowBlur = 14;
      ctx.lineWidth = 3; ctx.lineCap = "round";
      const corners = [
        [[x, y + len], [x, y], [x + len, y]],
        [[x + w - len, y], [x + w, y], [x + w, y + len]],
        [[x + w, y + h - len], [x + w, y + h], [x + w - len, y + h]],
        [[x + len, y + h], [x, y + h], [x, y + h - len]],
      ];
      for (const p of corners) { ctx.beginPath(); ctx.moveTo(...p[0]); ctx.lineTo(...p[1]); ctx.lineTo(...p[2]); ctx.stroke(); }
      ctx.shadowBlur = 0;
      ctx.fillStyle = c.replace("hsl", "hsla").replace(")", ", 0.08)");
      ctx.fillRect(x, y, w, h);
      const tag = `${d.label}  ${Math.round(d.conf * 100)}%`;
      ctx.font = "600 15px system-ui, sans-serif";
      const tw = ctx.measureText(tag).width + 16;
      ctx.fillStyle = c; ctx.fillRect(x, y - 26, tw, 22);
      ctx.fillStyle = "#04070d"; ctx.fillText(tag, x + 8, y - 10);
      ctx.fillStyle = "rgba(255,255,255,.25)"; ctx.fillRect(x, y - 4, tw, 3);
      ctx.fillStyle = c; ctx.fillRect(x, y - 4, tw * d.conf, 3);
      ctx.restore();
    }
  };

  const drawSegment = (ctx, polys, W, H) => {
    for (const p of polys) {
      if (!p.points.length) continue;
      const c = colorFor(p.label);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(p.points[0][0] * W, p.points[0][1] * H);
      for (const [px, py] of p.points) ctx.lineTo(px * W, py * H);
      ctx.closePath();
      ctx.fillStyle = c.replace("hsl", "hsla").replace(")", ", 0.28)");
      ctx.fill();
      ctx.strokeStyle = c; ctx.lineWidth = 2.5; ctx.shadowColor = c; ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.restore();
      // label at first point
      const lx = p.points[0][0] * W, ly = p.points[0][1] * H;
      ctx.font = "600 14px system-ui, sans-serif";
      const tag = `${p.label} ${Math.round(p.conf * 100)}%`;
      const tw = ctx.measureText(tag).width + 12;
      ctx.fillStyle = c; ctx.fillRect(lx, ly - 22, tw, 20);
      ctx.fillStyle = "#04070d"; ctx.fillText(tag, lx + 6, ly - 7);
    }
  };

  const drawPose = (ctx, people, W, H) => {
    people.forEach((kpts, idx) => {
      const c = `hsl(${(idx * 70) % 360}, 90%, 62%)`;
      ctx.save();
      ctx.strokeStyle = c; ctx.lineWidth = 3; ctx.lineCap = "round";
      ctx.shadowColor = c; ctx.shadowBlur = 8;
      for (const [a, b] of SKELETON) {
        const pa = kpts[a], pb = kpts[b];
        if (!pa || !pb || (pa[0] === 0 && pa[1] === 0) || (pb[0] === 0 && pb[1] === 0)) continue;
        ctx.beginPath();
        ctx.moveTo(pa[0] * W, pa[1] * H);
        ctx.lineTo(pb[0] * W, pb[1] * H);
        ctx.stroke();
      }
      ctx.fillStyle = "#fff";
      for (const [x, y] of kpts) {
        if (x === 0 && y === 0) continue;
        ctx.beginPath(); ctx.arc(x * W, y * H, 4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    });
  };

  const renderLoop = useCallback(() => {
    const overlay = overlayRef.current, video = videoRef.current;
    if (overlay && video && video.videoWidth) {
      const W = (overlay.width = video.videoWidth);
      const H = (overlay.height = video.videoHeight);
      const ctx = overlay.getContext("2d");
      ctx.clearRect(0, 0, W, H);
      const p = payload.current;
      if (p.mode === "segment") drawSegment(ctx, p.polygons || [], W, H);
      else if (p.mode === "pose") drawPose(ctx, p.people || [], W, H);
      else drawDetect(ctx, p.detections || [], W, H);
    }
    rafRef.current = requestAnimationFrame(renderLoop);
  }, []);

  const start = useCallback(async () => {
    setStatus("starting camera…");
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
    videoRef.current.srcObject = stream;
    await videoRef.current.play();

    setStatus("connecting…");
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("live"); setRunning(true);
      startTs.current = Date.now(); seenClasses.current = new Set();
      const grab = grabRef.current;
      sendTimer.current = setInterval(() => {
        const video = videoRef.current;
        if (!video || ws.readyState !== WebSocket.OPEN) return;
        grab.width = video.videoWidth; grab.height = video.videoHeight;
        grab.getContext("2d").drawImage(video, 0, 0);
        ws.send(JSON.stringify({
          frame: grab.toDataURL("image/jpeg", 0.65),
          mode: modeRef.current,
          conf: confRef.current,
        }));
      }, SEND_INTERVAL_MS);
      rafRef.current = requestAnimationFrame(renderLoop);
    };

    ws.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      payload.current = data;
      setFps(data.fps || 0);
      setCounts(data.counts || {});
      const n = Object.values(data.counts || {}).reduce((a, b) => a + b, 0);
      setTotal(n); setPeak((p) => Math.max(p, n));
      for (const k of Object.keys(data.counts || {})) seenClasses.current.add(k);
      setUniqueSeen(seenClasses.current.size);
      const keys = Object.keys(data.counts || {});
      if (keys.length) {
        setFeed((f) => [{ t: new Date().toLocaleTimeString(), label: keys[0], n }, ...f].slice(0, 8));
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
    payload.current = { mode: modeRef.current };
    overlayRef.current?.getContext("2d").clearRect(0, 0, 9999, 9999);
    setRunning(false); setStatus("stopped");
    setCounts({}); setTotal(0); setFps(0);
  }, []);

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
      <div className="bg-grid" />
      <header>
        <div className="brand">
          <span className="logo">◎</span>
          <div>
            <h1>SafeSight</h1>
            <p>Real-time vision engine · detection · segmentation · pose</p>
          </div>
        </div>
        <span className={`live-pill ${status === "live" ? "on" : ""}`}>
          <i /> {status === "live" ? "LIVE" : status.toUpperCase()}
        </span>
      </header>

      <div className="modebar">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={`mode ${mode === m.id ? "active" : ""}`}
            onClick={() => setMode(m.id)}
          >
            <span className="mi">{m.icon}</span> {m.label}
          </button>
        ))}
      </div>

      <div className="layout">
        <div className="stage">
          <video ref={videoRef} playsInline muted />
          <canvas ref={overlayRef} className="overlay" />
          <canvas ref={grabRef} style={{ display: "none" }} />
          <div className="scanline" />
          <div className="corner tl" /><div className="corner tr" />
          <div className="corner bl" /><div className="corner br" />
          {running && (
            <div className="hud">
              <span>◉ REC</span><span>{fps} FPS</span><span>{total} OBJ</span>
              <span>{mode.toUpperCase()}</span>
            </div>
          )}
          {!running && <div className="hint">Press <b>Start</b> and allow camera access</div>}
        </div>

        <aside className="panel">
          <button className={running ? "act stop" : "act start"} onClick={running ? stop : start}>
            {running ? "■ Stop" : "▶ Start Detection"}
          </button>

          <div className="slider">
            <div className="slabel"><span>Confidence</span><b>{Math.round(conf * 100)}%</b></div>
            <input type="range" min="0.1" max="0.9" step="0.05" value={conf}
              onChange={(e) => setConf(parseFloat(e.target.value))} />
          </div>

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
              <li key={label}><span className="dot" style={{ background: colorFor(label) }} />{label}<b>{n}</b></li>
            ))}
          </ul>

          <h3>Detection feed</h3>
          <ul className="feed">
            {feed.length === 0 && <li className="empty">—</li>}
            {feed.map((f, i) => (
              <li key={i}><code>{f.t}</code><span className="dot" style={{ background: colorFor(f.label) }} />{f.label}<em>{f.n}</em></li>
            ))}
          </ul>
        </aside>
      </div>

      <footer>Built by Sunny Kumpati · FastAPI · YOLOv8 · React · WebSocket streaming</footer>
    </div>
  );
}
