/* Test E (deterministic) – old tracker (live.js v1, 20 Nov) vs new tracker (public/js/tracker.js, 21 Nov).
 *
 * Why a simulation: the browser pane has no camera and its detector runs at only 2–3 frames/s, so the real-pipeline
 * test (test_e_tracking_browser.js) is noisy. Here the DETECTOR is simulated with known truth, the trackers are the
 * real code (v1 logic copied verbatim below, v2 imported), and everything is repeated with 20 random seeds.
 *
 * Scene (1280×720, 10 s, screen refresh 60 Hz):
 *   A  package 230×330 moving on a smooth path (up to ~300 px/s); covered by a hand 3.2–3.9 s (no detections);
 *      gets a name at 1.5 s (as if a barcode had been read)
 *   B  package standing still on the right
 *   C  package crossing A's path from 5.5 s to 8 s (different colours) – may the name jump from A to C?
 * Detector: box edges with Gaussian noise (σ 5 px), 8 % missed detections, results arrive LATENCY ms after the
 *           frame was captured; two speeds: webcam on a laptop (15 /s, 70 ms) and a slow phone (4 /s, 220 ms).
 * Measured on every screen frame for A: error to the true box centre, visible shake (frame-to-frame change of
 * that error), whether a box is shown, number of identities, whether the name is still on A after the hand,
 * and whether the name ever sits on C.
 * Run:  node tests/test_e_tracker_sim.mjs
 */
import { updateTracks, placeTracks } from "../public/js/tracker.js";

const iou = (a, b) => { const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)), iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1)); const i = ix * iy; return i / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - i + 1e-6); };

// ---- v1 tracker, verbatim logic from live.js of 20 Nov (archiv/stand-2026-11-21-vor-erkennung)
function trackV1(S, boxes, now) {
  for (const b of boxes) {
    const t = S.tracks.filter((t) => !t.textOnly).map((t) => [t, iou(t, b)]).sort((p, q) => q[1] - p[1])[0];
    if (t && t[1] > 0.3) { Object.assign(t[0], b, { seen: now }); continue; }
    const old = S.lost.filter((l) => now - l.seen < 4000 && iou(l, b) > 0.4).sort((p, q) => iou(q, b) - iou(p, b))[0];
    S.tracks.push({ ...b, id: S.nextId++, seen: now, ttl: 1200, label: old?.label || null });
  }
  for (const t of S.tracks) if (now - t.seen >= t.ttl && t.label && !t.textOnly) S.lost.push(t);
  S.lost = S.lost.filter((l) => now - l.seen < 4000).slice(-30);
  S.tracks = S.tracks.filter((t) => now - t.seen < t.ttl);
}

// ---- scene
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
function hist(r, peak) { const h = new Float32Array(64); for (let i = 0; i < 64; i++) h[i] = 0.2 * r(); for (const p of peak) h[p] += 3 + r(); const s = h.reduce((a, b) => a + b, 0); return h.map((v) => v / s); }
const truth = {
  A: (t) => ({ cx: 420 + 300 * Math.sin(0.9 * t), cy: 360 + 50 * Math.sin(1.7 * t), w: 230, h: 330 }),
  B: () => ({ cx: 1040, cy: 390, w: 220, h: 320 }),
  C: (t) => ({ cx: 1180 - (t - 5.5) * 420, cy: 400, w: 200, h: 300 }),
};
const present = { A: (t) => !(t >= 3.2 && t < 3.9), B: () => true, C: (t) => t >= 5.5 && t < 8 };

function run(version, rate, latency, seed) {
  const r = rng(seed), H = { A: hist(r, [5, 21, 40]), B: hist(r, [60, 12]), C: hist(r, [33, 47, 2]) };
  const S = { tracks: [], lost: [], nextId: 1, running: true };
  const pending = []; // detector results waiting for their latency
  let nextCapture = 0, named = false;
  const frames = [];
  for (let ms = 0; ms <= 10000; ms += 1000 / 60) {
    const t = ms / 1000;
    if (ms >= nextCapture) { // the detector grabs a frame …
      nextCapture += 1000 / rate;
      const boxes = [];
      for (const k of ["A", "B", "C"]) {
        if (!present[k](t) || r() < 0.08) continue;
        const g = truth[k](t), n = () => gauss(r) * 5;
        const hi = H[k].map((v) => Math.max(0, v + (r() - 0.5) * 0.004));
        boxes.push({ x1: g.cx - g.w / 2 + n(), y1: g.cy - g.h / 2 + n(), x2: g.cx + g.w / 2 + n(), y2: g.cy + g.h / 2 + n(), name: "package", score: 0.6, hist: hi, truth: k });
      }
      pending.push({ at: ms, ready: ms + latency, boxes });
    }
    while (pending.length && pending[0].ready <= ms) { // … and the result arrives `latency` ms later
      const p = pending.shift();
      if (version === "v1") trackV1(S, p.boxes, ms);  // v1: result time, raw boxes
      else updateTracks(S, p.boxes, p.at);            // v2: capture time, filtered
    }
    if (version === "v2") placeTracks(S, ms, true);   // v2 redraws the predicted boxes every screen frame
    // what the user sees for A: the displayed box closest to A's true centre (within half a box)
    const a = truth.A(t);
    const shown = S.tracks.filter((k) => !k.textOnly && (version === "v1" || ms - k.seen < k.ttl));
    const near = shown.map((k) => [k, Math.hypot((k.x1 + k.x2) / 2 - a.cx, (k.y1 + k.y2) / 2 - a.cy)]).filter(([, d]) => d < 140).sort((p, q) => p[1] - q[1])[0];
    if (!named && t >= 1.5 && near) { near[0].label = { brand: "A", engine: "barcode" }; named = true; }
    const c = truth.C(t);
    const onC = present.C(t) && shown.some((k) => k.label?.brand === "A" && Math.hypot((k.x1 + k.x2) / 2 - c.cx, (k.y1 + k.y2) / 2 - c.cy) < 80 && Math.hypot((k.x1 + k.x2) / 2 - a.cx, (k.y1 + k.y2) / 2 - a.cy) > 120);
    frames.push({ t, occ: !present.A(t), id: near?.[0].id ?? null, label: near?.[0].label?.brand ?? null,
      ex: near ? (near[0].x1 + near[0].x2) / 2 - a.cx : null, ey: near ? (near[0].y1 + near[0].y2) / 2 - a.cy : null, onC });
  }
  const vis = frames.filter((f) => f.ex != null && f.t > 0.5);
  let shake = 0, n = 0;
  for (let i = 1; i < frames.length; i++) {
    const p = frames[i - 1], q = frames[i];
    if (p.ex != null && q.ex != null && p.id === q.id) { shake += (q.ex - p.ex) ** 2 + (q.ey - p.ey) ** 2; n++; }
  }
  const out = frames.filter((f) => !f.occ && f.t > 0.5), occ = frames.filter((f) => f.occ), after = frames.filter((f) => f.t >= 4.2);
  return {
    error_px: vis.reduce((s, f) => s + Math.hypot(f.ex, f.ey), 0) / vis.length,
    shake_px: Math.sqrt(shake / Math.max(1, n)),
    shown: out.filter((f) => f.ex != null).length / out.length,
    shown_hand: occ.filter((f) => f.ex != null).length / occ.length,
    ids: new Set(frames.filter((f) => f.id != null && f.t > 0.5).map((f) => f.id)).size,
    name_after_hand: after.filter((f) => f.label === "A").length / after.length,
    name_on_C: frames.filter((f) => f.onC).length / Math.max(1, frames.filter((f) => f.t >= 5.5 && f.t < 8).length),
  };
}

const avg = (rs) => Object.fromEntries(Object.keys(rs[0]).map((k) => [k, +(rs.reduce((s, r) => s + r[k], 0) / rs.length).toFixed(k === "ids" ? 1 : 3)]));
const rows = [];
for (const [label, rate, lat] of [["webcam laptop (15/s, 70 ms)", 15, 70], ["slow phone (4/s, 220 ms)", 4, 220]]) {
  for (const v of ["v1", "v2"]) rows.push({ setting: label, version: v, ...avg(Array.from({ length: 20 }, (_, i) => run(v, rate, lat, 100 + i))) });
}
console.table(rows);
if (process.argv.includes("--json")) console.log(JSON.stringify(rows));
