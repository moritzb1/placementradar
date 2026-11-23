/**
 * brandmodel.js — stage 4 of the live scanner: OUR OWN brand model, running on the device.
 *
 * How it works (trained by tools/train_brand_model.py, results in EVALUATION.md):
 *   1. crop one package box out of the frame, pad it to a square (grey), scale to 256×256
 *   2. MobileCLIP image encoder (Apple, open weights, float16 ONNX) → a 512-number fingerprint of the look
 *   3. our trained brand head (one weight row per brand, brand_head.json) → probability per brand
 *   4. answer only if two opinions agree: the head is sure enough AND the brand is among the best matches of
 *      the brand NAMES as text (zero-shot, what MobileCLIP knew before our training). Both thresholds come from
 *      brand_head.json (calibrated by tools/train_brand_model_v2.py on a validation split, EVALUATION.md "S4").
 *   v2 (21 Nov): ~1,000 brands (food, cosmetics, household), trained with webcam-like views, plus a class
 *      "(other)" learnt from packs of foreign brands that look like ours (hard negatives) – never shown.
 * It recognises the LOOK of a brand (colours, logo shape, layout) – exactly what OCR cannot do with script or
 * picture logos (Coca-Cola, Kinder) or store brands that hardly print their name.
 */
import { runWasm } from "./wasmqueue.js";
import { fetchBytes, markGroup } from "./loadprogress.js";
let M = null, M_P = null;
/** True once the model is in memory (the camera loop skips stage 4 until then instead of waiting). */
export const brandModelReady = () => !!M;

export async function loadBrandModel() {
  M_P ??= (async () => {
    const ort = window.ort; // loaded by live.js together with the detector
    const head = JSON.parse(new TextDecoder().decode(await fetchBytes("models/brand_head.json", "own")));
    // the model is stored in parts (Cloudflare: max 25 MiB per file) → download all (with progress), join into one buffer
    const bufs = await Promise.all(head.parts.map((p) => fetchBytes(`models/${p}`, "own")));
    const bytes = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0)); let o = 0; for (const b of bufs) { bytes.set(b, o); o += b.length; }
    // WASM on purpose: the detector already uses WebGPU every frame; this model runs a few times per second at most
    const s = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    let W, b, Z;
    if (head.head?.file) {
      // v2: one binary float16 file [W (classes×dim) | b (classes) | Z (text classes×dim)] – ~2 MB for 1,000 brands
      const { classes: C, dim: D, text_classes: CZ } = head.head;
      const hb = await fetchBytes(`models/${head.head.file}`, "own");
      const f = halfToFloat(new Uint16Array(hb.buffer, hb.byteOffset, hb.byteLength / 2));
      W = Array.from({ length: C }, (_, i) => f.subarray(i * D, (i + 1) * D));
      b = f.subarray(C * D, C * D + C);
      Z = Array.from({ length: CZ }, (_, i) => f.subarray(C * D + C + i * D, C * D + C + (i + 1) * D));
    } else { // v1: everything as JSON numbers
      W = head.W.map((r) => Float32Array.from(r)); b = Float32Array.from(head.b); Z = head.Z.map((r) => Float32Array.from(r));
    }
    const brands = head.names.filter((n) => n !== head.other).length;
    M = { s, head, N: head.input[2], W, b, Z, rule: head.rule, other: head.other ? head.names.indexOf(head.other) : -1, brands };
    markGroup("own", "ready");
    return M;
  })().catch((e) => { M_P = null; markGroup("own", "failed"); throw e; });
  return M_P;
}

/** IEEE 754 half precision → Float32Array (Float16Array is not available in every browser yet). */
function halfToFloat(h) {
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const x = h[i], s = x & 0x8000 ? -1 : 1, e = (x >> 10) & 0x1f, m = x & 0x3ff;
    out[i] = e === 0 ? s * m * 5.960464477539063e-8 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return out;
}

const cv = document.createElement("canvas"); const cx = cv.getContext("2d", { willReadFrequently: true });

/**
 * MobileCLIP fingerprint (512 numbers, unit length) of one box: a little context around it, padded to a square with
 * grey 128 like the training. Used by classifyBox and by Verify on screen (verify.js: type check). null if too small.
 */
export async function embedBox(src, box, fw, fh) {
  if (!M) return null;
  const N = M.N;
  // a little context around the box (detector boxes are tight), clamped to the frame
  const pw = (box.x2 - box.x1) * 0.04, ph = (box.y2 - box.y1) * 0.04;
  const x1 = Math.max(0, box.x1 - pw), y1 = Math.max(0, box.y1 - ph), x2 = Math.min(fw, box.x2 + pw), y2 = Math.min(fh, box.y2 + ph);
  const w = x2 - x1, h = y2 - y1; if (w < 24 || h < 24) return null;
  // pad to square with grey 128, like the training (tall bottles keep their logo instead of being cut)
  const s = N / Math.max(w, h), dw = w * s, dh = h * s;
  cv.width = cv.height = N; cx.fillStyle = "rgb(128,128,128)"; cx.fillRect(0, 0, N, N);
  cx.imageSmoothingQuality = "high";
  cx.drawImage(src, x1, y1, w, h, (N - dw) / 2, (N - dh) / 2, dw, dh);
  const d = cx.getImageData(0, 0, N, N).data, n = N * N, x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { x[i] = d[i * 4] / 255; x[n + i] = d[i * 4 + 1] / 255; x[2 * n + i] = d[i * 4 + 2] / 255; }
  const out = await runWasm(M.s, { [M.s.inputNames[0]]: new window.ort.Tensor("float32", x, [1, 3, N, N]) });
  return Float32Array.from(out[M.s.outputNames[0]].data);
}

/** Does the own model know this brand? (Verify on screen: only then can "not recognised by its look" mean anything.) */
export function knowsBrand(name) {
  if (!M) return false;
  M.keys ??= new Set(M.head.names.filter((n) => n !== M.head.other).map(key));
  return M.keys.has(key(name));
}
const key = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");

/** Recognise the brand of one box. Returns { brand, conf, sure, top: [[brand, p]…], ms } or null if not loaded.
 *  sure = both opinions agree (see top of file); only then the scanner shows the brand. */
export async function classifyBox(src, box, fw, fh) {
  if (!M) return null;
  const t0 = performance.now();
  const e = await embedBox(src, box, fw, fh); if (!e) return null;
  // brand head: logits = W·e + b → softmax
  const logits = M.W.map((row, i) => M.b[i] + dot(row, e));
  const mx = Math.max(...logits), ex = logits.map((v) => Math.exp(v - mx)), sum = ex.reduce((a, b) => a + b, 0);
  const order = ex.map((v, i) => [i, v / sum]).sort((a, b) => b[1] - a[1]);
  const best = order[0][0], conf = order[0][1];
  // "(other)" (v2): the head learnt that this looks like a package of a brand it does NOT know → never an answer
  const isOther = best === M.other;
  // second opinion: rank of the same brand when only the brand NAMES (text) are compared with the picture
  const zs = M.Z.map((row) => dot(row, e)), better = isOther ? Infinity : zs.filter((v) => v > zs[best]).length;
  const sure = !isOther && conf >= M.rule.min_conf && better < M.rule.zero_shot_top;
  const top = order.filter(([i]) => i !== M.other).slice(0, 3).map(([i, p]) => [M.head.names[i], p]);
  // emb: the fingerprint itself – live.js uses it to recognise the same product again after it was hidden
  return { brand: isOther ? "(other brand)" : top[0][0], conf, sure, textRank: better + 1, top, emb: e, ms: Math.round(performance.now() - t0) };
}

function dot(a, b) { let v = 0; for (let j = 0; j < a.length; j++) v += a[j] * b[j]; return v; }

// ------------------------------------------------------------------------------------------------
// Product TYPES for Verify on screen (23 Nov): the text fingerprints of ~90 types ("computer monitor", "backpack" …
// plus distractors like "person", "wall") were computed once with MobileCLIP-S1's text encoder on the Mac
// (tools/build_category_bank.py, 93 KB). The text encoder itself is not shipped (~127 MB) – see MODELS.md.
// ------------------------------------------------------------------------------------------------
let TYPES_P = null;
export function loadTypeBank() {
  TYPES_P ??= (async () => {
    const meta = await (await fetch("models/category_text.json")).json();
    const b = new Uint8Array(await (await fetch(`models/${meta.file}`)).arrayBuffer());
    const f = halfToFloat(new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2)), D = meta.dim;
    return { names: meta.names, rows: meta.names.map((_, i) => f.subarray(i * D, (i + 1) * D)) };
  })().catch((e) => { TYPES_P = null; throw e; });
  return TYPES_P;
}

/** Rank product types for one fingerprint: [[type, cosine]…] best first (cosine of unit vectors). */
export async function rankTypes(emb) {
  const bank = await loadTypeBank();
  return bank.names.map((n, i) => [n, dot(bank.rows[i], emb)]).sort((a, b) => b[1] - a[1]);
}
