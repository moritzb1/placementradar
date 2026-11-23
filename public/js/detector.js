/**
 * detector.js — the object finders that run in the browser (ONNX Runtime Web), shared by the live scanner
 * (live.js) and "Verify on screen" (verify.js). Moved out of live.js on 23 Nov so both use the same code.
 *
 *   - YOLOE "packaging finder": open-vocabulary YOLO whose vocabulary was fixed before export to packages and a few
 *     product types (bags, jars, bottles, headphones, backpack …, tools/export_yoloe.py). Raw head
 *     [1, 4+C+32, anchors] → own non-maximum suppression (NMS).
 *   - YOLO26n (COCO, 80 everyday classes): end-to-end head [1,300,6] = x1 y1 x2 y2 score class, no NMS needed.
 *     The live scanner only falls back to it; Verify on screen runs it next to YOLOE because COCO knows the
 *     non-packaging things of tech and desk videos (tv/monitor, keyboard, mouse, laptop, chair, potted plant).
 *
 * Both run on WebGPU if the browser has it (smooth video), otherwise on WebAssembly – then through the shared WASM
 * queue (wasmqueue.js), because ORT's WASM backend runs only one model at a time.
 */
import { fetchBytes, markGroup } from "./loadprogress.js";
import { runWasm } from "./wasmqueue.js";
import { iou } from "./tracker.js";

export async function loadScript(src) {
  await new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error(`cannot load ${src}`)); document.head.append(s); });
}

/** ONNX Runtime Web, loaded once. The WebAssembly runtime (21.7 MB) is fetched with visible progress (group "runtime"). */
let ORT_P = null;
export function ensureOrt() {
  ORT_P ??= (async () => {
    if (!window.ort) await loadScript("vendor/ort.webgpu.min.js");
    const ort = window.ort;
    ort.env.wasm.wasmPaths = new URL("vendor/", location.href).href;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    // ORT takes the runtime as bytes (env.wasm.wasmBinary) instead of downloading it silently itself
    try { ort.env.wasm.wasmBinary = await fetchBytes("vendor/ort-wasm-simd-threaded.jsep.wasm", "runtime"); }
    catch (e) { console.warn("runtime prefetch failed, ORT loads it itself", e); }
    return ort;
  })().catch((e) => { ORT_P = null; throw e; });
  return ORT_P;
}

async function session(file) {
  const ort = window.ort;
  if (navigator.gpu) { try { return { s: await ort.InferenceSession.create(file, { executionProviders: ["webgpu"] }), backend: "WebGPU" }; } catch { /* fall back */ } }
  return { s: await ort.InferenceSession.create(file, { executionProviders: ["wasm"], graphOptimizationLevel: "all" }), backend: "WASM" };
}

// One shared loading promise per model: the page, the camera button, a photo upload and Verify on screen may all ask
// at once, and two parallel WebGPU session creations must not race.
let FINDER_P = null, COCO_P = null;

/** YOLOE packaging finder (falls back to YOLO26n if it cannot load). Progress groups "runtime" + "finder". */
export function loadFinder() {
  FINDER_P ??= (async () => {
    const finderBytes = fetchBytes("models/yoloe_pack.onnx", "finder").catch((e) => { markGroup("finder", "failed"); return e; });
    await ensureOrt();
    try {
      const meta = await (await fetch("models/yoloe_pack.json")).json();
      const bytes = await finderBytes; if (bytes instanceof Error) throw bytes;
      const { s, backend } = await session(bytes);
      markGroup("runtime", "ready"); markGroup("finder", "ready");
      return { session: s, names: meta.names, size: meta.input[2], backend, kind: "raw", title: "YOLOE packaging finder" };
    } catch (e) {
      console.warn("YOLOE not available, using YOLO26n", e);
      const m = await loadCoco();
      markGroup("runtime", "ready"); markGroup("finder", "ready");
      return m;
    }
  })().catch((e) => { FINDER_P = null; throw e; });
  return FINDER_P;
}

/** YOLO26n, 80 COCO classes (9.4 MB). */
export function loadCoco() {
  COCO_P ??= (async () => {
    await ensureOrt();
    const meta = await (await fetch("models/yolo26n.json")).json();
    const { s, backend } = await session(await fetchBytes("models/yolo26n.onnx"));
    return { session: s, names: meta.names, size: meta.input[2], backend, kind: "e2e", title: "YOLO26n" };
  })().catch((e) => { COCO_P = null; throw e; });
  return COCO_P;
}

export function nms(boxes, thr) {
  boxes.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const b of boxes) if (keep.every((k) => iou(k, b) < thr)) keep.push(b);
  return keep;
}

const pre = document.createElement("canvas"); const pctx = pre.getContext("2d", { willReadFrequently: true });

/**
 * Run one detector on an image source (video, canvas, image). Returns [{x1,y1,x2,y2, score, name}] in source pixels.
 * opts.keep(name) – optional class filter for the e2e (COCO) model; opts.min – score thresholds.
 */
export async function detect(model, src, w, h, { keep = null, minRaw = 0.3, minE2e = 0.35 } = {}) {
  const { session, size: N, names, kind } = model;
  // letterbox into an N×N square (grey 114, like the Ultralytics training)
  const s = Math.min(N / w, N / h), nw = Math.round(w * s), nh = Math.round(h * s), px = (N - nw) / 2, py = (N - nh) / 2;
  pre.width = pre.height = N; pctx.fillStyle = "rgb(114,114,114)"; pctx.fillRect(0, 0, N, N); pctx.drawImage(src, 0, 0, w, h, px, py, nw, nh);
  const d = pctx.getImageData(0, 0, N, N).data, n = N * N, x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { x[i] = d[i * 4] / 255; x[n + i] = d[i * 4 + 1] / 255; x[2 * n + i] = d[i * 4 + 2] / 255; }
  const feeds = { [session.inputNames[0]]: new window.ort.Tensor("float32", x, [1, 3, N, N]) };
  // without WebGPU the detector also runs on WASM → it must queue behind OCR and the own model
  const out = model.backend === "WASM" ? await runWasm(session, feeds) : await session.run(feeds);
  const t = out[session.outputNames[0]], o = t.data, boxes = [];
  const back = (x1, y1, x2, y2) => ({ x1: Math.max(0, (x1 - px) / s), y1: Math.max(0, (y1 - py) / s), x2: Math.min(w, (x2 - px) / s), y2: Math.min(h, (y2 - py) / s) });
  if (kind === "raw") {
    const A = t.dims[2], C = names.length;
    for (let a = 0; a < A; a++) {
      let best = 0, bc = 0;
      for (let c = 0; c < C; c++) { const v = o[(4 + c) * A + a]; if (v > best) { best = v; bc = c; } }
      if (best < minRaw) continue;
      const cx = o[a], cy = o[A + a], bw = o[2 * A + a], bh = o[3 * A + a];
      boxes.push({ ...back(cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2), score: best, name: names[bc] });
    }
    return nms(boxes, 0.5).slice(0, 20); // class-agnostic: one package should not get two boxes with different words
  }
  for (let i = 0; i < 300; i++) {
    const sc = o[i * 6 + 4]; if (sc < minE2e) continue;
    const name = names[o[i * 6 + 5] | 0]; if (keep && !keep(name)) continue;
    boxes.push({ ...back(o[i * 6], o[i * 6 + 1], o[i * 6 + 2], o[i * 6 + 3]), score: sc, name });
  }
  return boxes;
}
