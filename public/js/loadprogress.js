/**
 * loadprogress.js — download the live scanner's models with visible progress (MB per model and stage).
 *
 * Why: on the first visit the scanner needs ~100 MB (ONNX runtime 21.7, YOLOE 19.7, OCR 13.4, own model 45).
 * On weak Wi-Fi a silent download looks like a hang. So every model file is fetched here as a stream, the side
 * panel shows "12.3 / 19.7 MB" per model, and the scanner starts as soon as stage 1 (runtime + packaging finder)
 * is in – text recognition (stage 2) and the own model (stage 3) follow in the background.
 * The browser cache keeps the files, so a second visit loads in seconds.
 *
 * Connected to: live.js (renders the panel, starts the stages), ocr.js and brandmodel.js (fetch through here).
 */

/** Groups shown in the panel. `mb` is the expected size, used until the server reports the real length. */
export const GROUPS = {
  runtime: { label: "AI runtime (ONNX, WebAssembly)", stage: 1, mb: 21.7 },
  finder: { label: "Packaging finder (YOLOE)", stage: 1, mb: 19.7 },
  ocr: { label: "Text recognition · 3,599 brands", stage: 2, mb: 13.4 },
  own: { label: "Own model · 1,137 brands", stage: 3, mb: 45.3 },
};
const MB = 1024 * 1024;
const state = Object.fromEntries(Object.keys(GROUPS).map((k) => [k, { loaded: 0, total: GROUPS[k].mb * MB, files: 0, done: 0, status: "waiting" }]));
const listeners = new Set();
let pending = false;

/** Subscribe to progress; called (at most once per frame) with a snapshot of all groups. Returns an unsubscribe. */
export function onProgress(fn) { listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn); }

export function snapshot() {
  return Object.entries(GROUPS).map(([id, g]) => ({ id, ...g, ...state[id], loadedMb: state[id].loaded / MB, totalMb: state[id].total / MB }));
}

function notify() {
  if (pending) return;
  pending = true;
  (self.requestAnimationFrame || ((f) => setTimeout(f, 50)))(() => { pending = false; const s = snapshot(); listeners.forEach((f) => f(s)); });
}

/** Mark a group as finished or failed (also used when a model is created from bytes that are already here). */
export function markGroup(group, status) {
  const g = state[group]; if (!g) return;
  g.status = status;
  if (status === "ready") g.total = Math.max(g.loaded, 1);
  notify();
}

/** Fetch one file as bytes and count it towards `group`. Falls back to a plain fetch if streams are missing. */
export async function fetchBytes(url, group) {
  const g = state[group];
  if (g) { g.files++; if (g.status === "waiting") g.status = "loading"; notify(); }
  const r = await fetch(url);
  if (!r.ok) { if (g) { g.status = "failed"; notify(); } throw new Error(`${url}: HTTP ${r.status}`); }
  if (!g || !r.body?.getReader) { const b = new Uint8Array(await r.arrayBuffer()); if (g) count(g, b.length, true); return b; }
  const reader = r.body.getReader(), chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); n += value.length; count(g, value.length, false);
  }
  const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  g.done++; notify();
  return out;
}

function count(g, bytes, wholeFile) {
  g.loaded += bytes;
  if (g.loaded > g.total) g.total = g.loaded; // compressed transfer or a bigger file than expected
  if (wholeFile) g.done++;
  notify();
}
