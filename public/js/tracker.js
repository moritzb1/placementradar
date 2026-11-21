/**
 * tracker.js — the live scanner's object tracker (v2, 21 Nov): keeps one identity per product so its name stays on
 * it while it moves. Pure logic without DOM, so it can be tested in Node (tests/test_e_tracker_sim.mjs).
 *
 *   - Smoothing: every box runs through an alpha-beta filter (a light, fixed-structure Kalman filter) on centre and
 *     size with velocity. The gains adapt to the size of the surprise (idea of the "One Euro" filter): a residual
 *     of a few pixels is detector jitter → strong smoothing; a residual above JITTER × box size is real movement →
 *     follow at once. Between two detections the box is PREDICTED (place), so the overlay can be redrawn at screen
 *     rate instead of jumping once per detection, and the detector's own delay (capture → result) is predicted away.
 *   - Matching: predicted overlap (IoU) AND appearance. Appearance = a colour histogram of every detected box
 *     (computed by live.js, cheap, every frame) plus, once the own model has looked at a box, its MobileCLIP
 *     fingerprint (reidentify). Class words may flicker between synonyms ("snack bag" / "packet") → never used.
 *   - Short occlusion (hand in front, detector flicker): an unmatched track coasts on its prediction for HOLD_MS
 *     (live.js draws it dashed, like an estimated position in the video tracking mode), then waits KEEP_MS in a
 *     "lost" list. A new box that looks like a lost one (histogram or fingerprint) gets its identity and name back.
 *
 * State object S: { tracks: [], lost: [], nextId } – tracks may also contain live.js' dashed text-only boxes
 * (textOnly: true), which the tracker leaves alone.
 */
export const HOLD_MS = 1500;   // keep drawing an unseen track this long (predicted, dashed after COAST_MS)
export const COAST_MS = 300;
const KEEP_MS = 6000;   // remember a vanished labelled track this long for re-identification
// Filter gains adapt to the size of the surprise (idea of the "One Euro" filter): a residual of a few pixels is
// detector jitter → strong smoothing; a residual of >15 % of the box is real movement → follow at once, no lag.
const GAIN = { pos: [0.25, 1.0], vel: [0.1, 0.6], size: [0.2, 0.6] }; // [gain for jitter, gain for real movement]
const JITTER = 0.15;   // residual (share of the box size) from which a change counts as real movement
const VMAX = 3;        // px per ms – a box never flies off faster than this while it is predicted

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)), iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const i = ix * iy; return i / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - i + 1e-6);
}
const toState = (b) => ({ cx: (b.x1 + b.x2) / 2, cy: (b.y1 + b.y2) / 2, w: b.x2 - b.x1, h: b.y2 - b.y1, vx: 0, vy: 0, vw: 0, vh: 0 });
/** Box of a track predicted to time `now` (velocity is damped so a coasting box slows down instead of flying off). */
function predict(t, now) {
  const f = t.f, dt = Math.max(0, Math.min(now - t.fAt, 600));
  return { cx: f.cx + f.vx * dt, cy: f.cy + f.vy * dt, w: Math.max(8, f.w + f.vw * dt), h: Math.max(8, f.h + f.vh * dt) };
}
const boxOf = (p) => ({ x1: p.cx - p.w / 2, y1: p.cy - p.h / 2, x2: p.cx + p.w / 2, y2: p.cy + p.h / 2 });
function correct(t, b, now) {
  const p = predict(t, now), z = toState(b), dt = Math.max(16, Math.min(now - t.fAt, 600)), f = t.f;
  const size = Math.max(p.w, p.h, 1), mix = ([lo, hi], m) => lo + (hi - lo) * m;
  for (const [k, v, pos] of [["cx", "vx", true], ["cy", "vy", true], ["w", "vw", false], ["h", "vh", false]]) {
    const r = z[k] - p[k], m = Math.min(1, Math.abs(r) / (JITTER * size)); // 0 = jitter … 1 = real movement
    f[k] = p[k] + mix(pos ? GAIN.pos : GAIN.size, m) * r;
    f[v] = Math.max(-VMAX, Math.min(VMAX, f[v] + (mix(GAIN.vel, m) / dt) * r * (pos ? 1 : 0.3)));
  }
  t.fAt = now;
}

/** Bhattacharyya coefficient: 1 = same colour distribution, 0 = nothing in common. */
export function histSim(a, b) { if (!a || !b) return 0.5; let s = 0; for (let i = 0; i < 64; i++) s += Math.sqrt(a[i] * b[i]); return s; }
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }; // fingerprints are unit length

/** One detector result → tracks. boxes: [{x1,y1,x2,y2, name, score, hist}], `now` = when the frame was CAPTURED. */
export function updateTracks(S, boxes, now) {
  const live = S.tracks.filter((t) => !t.textOnly);
  // score every (track, box) pair: predicted overlap + appearance; gate out implausible pairs
  const pairs = [];
  for (const t of live) {
    const p = boxOf(predict(t, now));
    for (const b of boxes) {
      const o = iou(p, b), sim = histSim(t.hist, b.hist);
      const dist = Math.hypot((p.x1 + p.x2 - b.x1 - b.x2) / 2, (p.y1 + p.y2 - b.y1 - b.y2) / 2) / Math.max(p.x2 - p.x1, p.y2 - p.y1, 1);
      if (o < 0.05 && dist > 0.6) continue;
      if (sim < 0.35 && o < 0.5) continue;  // overlapping, but clearly a different-looking object
      pairs.push([0.6 * o + 0.4 * sim - 0.15 * Math.min(dist, 1), t, b]);
    }
  }
  pairs.sort((a, b) => b[0] - a[0]);
  const usedT = new Set(), usedB = new Set();
  for (const [score, t, b] of pairs) {
    if (score < 0.25 || usedT.has(t) || usedB.has(b)) continue;
    usedT.add(t); usedB.add(b);
    correct(t, b, now);
    Object.assign(t, { name: b.name, score: b.score, seen: now, hits: (t.hits || 0) + 1 });
    if (b.hist && t.hist) for (let i = 0; i < 64; i++) t.hist[i] = 0.8 * t.hist[i] + 0.2 * b.hist[i]; // slowly adapt to light changes
    else t.hist = b.hist;
  }
  for (const b of boxes) {
    if (usedB.has(b)) continue;
    // a new box: is it a labelled product that vanished a moment ago (hand in front, out of the frame)?
    const back = S.lost.map((l) => [l, histSim(l.hist, b.hist) - 0.3 * Math.min(1, Math.abs(Math.log((area(b) + 1) / (area(l) + 1))))])
      .filter(([, s]) => s > 0.82).sort((p, q) => q[1] - p[1])[0];
    const t = back ? back[0] : { id: S.nextId++, label: null, hist: b.hist, hits: 0 };
    if (back) S.lost = S.lost.filter((l) => l !== t);
    Object.assign(t, { ...b, hist: t.hist || b.hist, f: toState(b), fAt: now, seen: now, born: back ? t.born : now, ttl: HOLD_MS, reid: back ? now : t.reid });
    S.tracks.push(t);
  }
  for (const t of S.tracks) if (!t.textOnly && now - t.seen >= t.ttl && t.label) S.lost.push(t);
  S.lost = S.lost.filter((l) => now - l.seen < KEEP_MS).slice(-30);
  S.tracks = S.tracks.filter((t) => now - t.seen < t.ttl);
  return S.tracks;
}

/** Move every track's drawn box (x1…y2) to its filtered position at `now` (moving = camera, not a still photo). */
export function placeTracks(S, now, moving = true) {
  for (const t of S.tracks) if (t.f) {
    const b = boxOf(t.seen === Infinity || !moving ? t.f : predict(t, now));
    t.x1 = b.x1; t.y1 = b.y1; t.x2 = b.x2; t.y2 = b.y2;
  }
}

/** The own model computed a fingerprint for a track: if it matches a vanished labelled product, take its name back.
 *  rank(label) = how certain a label is (live.js RANK); a stronger existing label is never replaced. */
export function reidentify(S, t, emb, rank, now) {
  t.emb = emb;
  const best = S.lost.filter((l) => l.emb && l.label).map((l) => [l, cos(l.emb, emb)]).sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] > 0.9 && (!t.label || rank(best[0].label) > rank(t.label))) {
    t.label = best[0].label; t.reid = now; S.lost = S.lost.filter((l) => l !== best[0]);
  }
}

const area = (t) => (t.x2 - t.x1) * (t.y2 - t.y1);
