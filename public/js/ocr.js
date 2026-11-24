/**
 * ocr.js — on-device text recognition (PaddleOCR v3 via ONNX Runtime Web) + brand matching.
 *
 * Why: brand names are printed large on almost every package ("Kaba", "Lorenz", "Prinzen Rolle"). Reading them
 * is cheaper and more reliable than any image model, works for packaging that COCO-YOLO does not know, and costs
 * no API quota. Matching against a fixed brand dictionary (Open Food Facts, tools/build_brand_list.py) keeps
 * ordinary package text ("Erdbeere", "700 g") out.
 *
 * Pipeline (same models and settings as RapidOCR, which we measured in Python first – EVALUATION.md "S2"):
 *   1. det.onnx (DBNet, 2.4 MB): probability map "text here" → threshold → connected regions → boxes
 *   2. rec.onnx (SVTR-CRNN, 10.7 MB): each box → characters (CTC greedy decoding, dictionary keys.txt)
 *   3. matchBrands(): single words and neighbouring words ("MEG"+"GLE", "Prinzen"/"Rolle") → brand dictionary,
 *      exact or with a small edit distance
 *
 * Connected to: live.js (calls readText + matchBrands), models/brands_de.json, vendor/ort (loaded by live.js).
 */
import { runWasm } from "./wasmqueue.js";
import { fetchBytes, markGroup } from "./loadprogress.js";

const DET_LIMIT = 960;        // longer image side for detection (multiple of 32); bigger = finds smaller text, slower
const DET_THRESH = 0.3;       // pixel probability that counts as text (RapidOCR default)
const BOX_THRESH = 0.5;       // mean probability a region needs to be kept (RapidOCR default)
const UNCLIP = 1.6;           // DBNet shrinks text regions during training → grow them back by this ratio
const REC_H = 48, REC_MAX_W = 640;
const MIN_TEXT_SCORE = 0.5;   // recognised strings below this confidence are dropped

let OCR = null;      // { det, rec, keys }
let BRANDS = null;   // { exact: Map(key → brand), list: [brand] }

/** Load both models once (wasm backend: dynamic input sizes run reliably there, WebGPU is busy with YOLO). */
// One shared promise each: the background loader (live.js) and a photo analysis may ask at the same time.
let OCR_P = null, BRANDS_P = null;
export function loadOcr() {
  OCR_P ??= (async () => {
    const ort = window.ort;
    const opt = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
    // bytes via loadprogress.js → the scanner shows "x / 13 MB" instead of a silent download
    const [detB, recB, keysB] = await Promise.all(["models/ocr/det.onnx", "models/ocr/rec.onnx", "models/ocr/keys.txt"].map((u) => fetchBytes(u, "ocr")));
    const det = await ort.InferenceSession.create(detB, opt), rec = await ort.InferenceSession.create(recB, opt);
    // CTC alphabet: index 0 = blank, then the dictionary, then a space (PaddleOCR "use_space_char")
    OCR = { det, rec, keys: ["", ...new TextDecoder().decode(keysB).split("\n"), " "] };
    return OCR;
  })().catch((e) => { OCR_P = null; markGroup("ocr", "failed"); throw e; });
  return OCR_P;
}

export function loadBrands() {
  BRANDS_P ??= (async () => {
    const j = JSON.parse(new TextDecoder().decode(await fetchBytes("models/brands_de.json", "ocr")));
    const exact = new Map(j.brands.map((b) => [b.key, b]));
    BRANDS = { exact, list: j.brands, source: j.source };
    return BRANDS;
  })().catch((e) => { BRANDS_P = null; throw e; });
  return BRANDS_P;
}

/** True once models and brand list are in memory (the camera loop skips OCR until then instead of waiting). */
export const ocrReady = () => !!(OCR && BRANDS);

// ------------------------------------------------------------------------------------------------
// 1. Text detection
// ------------------------------------------------------------------------------------------------
const cv = document.createElement("canvas");
const cx = cv.getContext("2d", { willReadFrequently: true });

/** Image → Float32 CHW tensor data in BGR order (PaddleOCR models were trained on OpenCV/BGR images). */
function toTensor(data, n, mean, std) {
  const x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    x[i] = (b - mean[0]) / std[0]; x[n + i] = (g - mean[1]) / std[1]; x[2 * n + i] = (r - mean[2]) / std[2];
  }
  return x;
}

async function detectText(src, w, h) {
  const s = Math.min(1, DET_LIMIT / Math.max(w, h));
  const W = Math.max(32, Math.round((w * s) / 32) * 32), H = Math.max(32, Math.round((h * s) / 32) * 32);
  cv.width = W; cv.height = H; cx.drawImage(src, 0, 0, w, h, 0, 0, W, H);
  const x = toTensor(cx.getImageData(0, 0, W, H).data, W * H, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]);
  const out = await runWasm(OCR.det, { [OCR.det.inputNames[0]]: new window.ort.Tensor("float32", x, [1, 3, H, W]) });
  const prob = out[OCR.det.outputNames[0]].data;

  // Connected regions above DET_THRESH (4-neighbourhood flood fill) → axis-aligned boxes
  const seen = new Uint8Array(W * H), boxes = [], stack = [];
  for (let p = 0; p < W * H; p++) {
    if (seen[p] || prob[p] < DET_THRESH) continue;
    let x1 = W, y1 = H, x2 = 0, y2 = 0, sum = 0, cnt = 0;
    stack.push(p); seen[p] = 1;
    while (stack.length) {
      const q = stack.pop(), qx = q % W, qy = (q / W) | 0;
      sum += prob[q]; cnt++;
      if (qx < x1) x1 = qx; if (qx > x2) x2 = qx; if (qy < y1) y1 = qy; if (qy > y2) y2 = qy;
      for (const nq of [q - 1, q + 1, q - W, q + W]) {
        if (nq < 0 || nq >= W * H || seen[nq] || prob[nq] < DET_THRESH) continue;
        if ((nq === q - 1 && qx === 0) || (nq === q + 1 && qx === W - 1)) continue;
        seen[nq] = 1; stack.push(nq);
      }
    }
    const bw = x2 - x1 + 1, bh = y2 - y1 + 1;
    if (Math.min(bw, bh) < 3 || sum / cnt < BOX_THRESH) continue;
    // "unclip": grow the box by area·ratio / perimeter on every side (DBNet's offset formula, for a rectangle)
    const d = (bw * bh * UNCLIP) / (2 * (bw + bh));
    boxes.push({
      x1: Math.max(0, (x1 - d) / (W / w)), y1: Math.max(0, (y1 - d) / (H / h)),
      x2: Math.min(w, (x2 + 1 + d) / (W / w)), y2: Math.min(h, (y2 + 1 + d) / (H / h)), det: sum / cnt,
    });
  }
  return boxes;
}

// ------------------------------------------------------------------------------------------------
// 2. Text recognition (one box at a time; typically 5–40 boxes per frame)
// ------------------------------------------------------------------------------------------------
const rc = document.createElement("canvas");
const rx = rc.getContext("2d", { willReadFrequently: true });

async function recognise(src, b) {
  const bw = b.x2 - b.x1, bh = b.y2 - b.y1;
  if (bh > bw * 1.5) return null; // vertical text: skipped (no angle classifier on the device)
  const W = Math.min(REC_MAX_W, Math.max(16, Math.ceil((REC_H * bw) / bh)));
  rc.width = W; rc.height = REC_H; rx.drawImage(src, b.x1, b.y1, bw, bh, 0, 0, W, REC_H);
  const x = toTensor(rx.getImageData(0, 0, W, REC_H).data, W * REC_H, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
  const out = await runWasm(OCR.rec, { [OCR.rec.inputNames[0]]: new window.ort.Tensor("float32", x, [1, 3, REC_H, W]) });
  const t = out[OCR.rec.outputNames[0]], [, T, C] = t.dims, p = t.data;
  // CTC greedy decoding: best class per time step, merge repeats, drop blanks
  let text = "", conf = 0, n = 0, prev = 0;
  for (let i = 0; i < T; i++) {
    let best = 0, bp = -1;
    for (let c = 0; c < C; c++) { const v = p[i * C + c]; if (v > bp) { bp = v; best = c; } }
    if (best !== 0 && best !== prev) { text += OCR.keys[best] ?? ""; conf += bp; n++; }
    prev = best;
  }
  text = text.trim();
  return text ? { text, score: conf / n } : null;
}

/**
 * Read all text in an image region. Returns [{text, score, x1,y1,x2,y2}] in source pixel coordinates.
 * `src` may be a <video>, <canvas> or <img>; w/h are its pixel size.
 */
export async function readText(src, w, h) {
  await loadOcr();
  const t0 = performance.now();
  const boxes = await detectText(src, w, h);
  const words = [];
  for (const b of boxes.slice(0, 60)) {
    const r = await recognise(src, b);
    if (r && r.score >= MIN_TEXT_SCORE) words.push({ ...b, ...r });
  }
  words.ms = Math.round(performance.now() - t0);
  return words;
}

// ------------------------------------------------------------------------------------------------
// 3. Brand matching
// ------------------------------------------------------------------------------------------------
export const brandKey = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

export function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
// How many typos a brand of this length may have: none for short names (too many false hits), 1 from 5 letters, 2 from 9
const allowed = (len) => (len >= 10 ? 2 : len >= 5 ? 1 : 0);
// Ordinary package words that are one typo away from a brand ("HAFER" → Hofer, "VEGAN" → Veganz, "PROTEIN" →
// Myprotein, found in test S2). Such words may still match a brand EXACTLY, but never by fuzzy matching.
const COMMON = new Set(("vegan hafer protein proteine bio natur natural milch butter kase cheese joghurt jogurt yogurt quark sahne " +
  "schoko choco chocolate kakao cacao vanille vanilla erdbeere strawberry himbeere kirsche apfel banane mango zitrone lemon " +
  "orange tomate tomaten honig mandel mandeln nuss nusse nougat haselnuss erdnuss erdnusse kekse keks waffeln waffel chips " +
  "linse linsen bohne bohnen erbse erbsen mais reis weizen dinkel roggen vollkorn brot toast salz salzig gesalzen paprika pfeffer zucker sugar original " +
  "classic klassik light zero leicht frisch fresh extra mini maxi family familie kinder skyr tofu wasser water saft juice " +
  "goldbaren baren minis riegel creme cream mousse dessert pudding griess ohne mit und").split(" "));
// Digits that OCR typically reads instead of letters in logo fonts ("Lolen2" for "Lorenz") – only used for the
// fuzzy comparison, never for exact hits
const LOOK = { 0: "o", 1: "l", 2: "z", 5: "s", 6: "g", 8: "b" };
const lookalike = (k) => (/[a-z]/.test(k) ? k.replace(/[012568]/g, (d) => LOOK[d]) : k);

const union = (ws) => ({ x1: Math.min(...ws.map((w) => w.x1)), y1: Math.min(...ws.map((w) => w.y1)), x2: Math.max(...ws.map((w) => w.x2)), y2: Math.max(...ws.map((w) => w.y2)) });

/** Neighbouring words that may belong together: same line (left→right) or directly stacked (top→bottom). */
function candidates(words) {
  const c = words.map((w) => ({ key: brandKey(w.text), parts: [w] }));
  for (const a of words) {
    const ah = a.y2 - a.y1;
    for (const b of words) {
      if (a === b) continue;
      const bh = b.y2 - b.y1, hRatio = Math.min(ah, bh) / Math.max(ah, bh);
      const vOverlap = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
      const hOverlap = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
      const sameLine = vOverlap > 0.5 * Math.min(ah, bh) && b.x1 >= a.x1 && b.x1 - a.x2 < 1.2 * Math.max(ah, bh) && hRatio > 0.5;
      const stacked = hOverlap > 0.3 * Math.min(a.x2 - a.x1, b.x2 - b.x1) && b.y1 >= a.y1 && b.y1 - a.y2 < 0.8 * Math.max(ah, bh);
      if (sameLine || stacked) c.push({ key: brandKey(a.text + b.text), parts: [a, b] });
    }
  }
  return c.filter((x) => x.key.length >= 2);
}

/**
 * Words → brands. Returns [{brand, key, read, score, x1,y1,x2,y2, exact}], best first, one entry per brand.
 * `read` is what the OCR actually saw – shown in the UI so the user can follow the decision.
 */
export function matchBrands(words) {
  if (!BRANDS) return [];
  const found = new Map();
  for (const cand of candidates(words)) {
    let hit = BRANDS.exact.get(cand.key), dist = 0;
    if (!hit && cand.key.length >= 4 && !COMMON.has(cand.key)) {
      const look = lookalike(cand.key);
      for (const b of BRANDS.list) {
        const max = b.exact ? 0 : allowed(b.key.length); if (!max) continue; // v3 additions (tech, fashion …): exact spelling only
        const d = lev(look, b.key, max);
        if (d <= max && (!hit || d < dist || (d === dist && b.products > hit.products))) { hit = b; dist = d; }
      }
    }
    if (!hit) continue;
    const textScore = cand.parts.reduce((s, p) => s + p.score, 0) / cand.parts.length;
    const score = textScore * (dist ? 0.85 : 1);
    const prev = found.get(hit.key);
    if (!prev || score > prev.score) {
      found.set(hit.key, { brand: hit.name, key: hit.key, read: cand.parts.map((p) => p.text).join(" "), score, exact: !dist, ...union(cand.parts) });
    }
  }
  // a typo match on a word that already belongs to an exactly read brand is noise ("Rolle" of "Prinzen Rolle" → Holle)
  const exactWords = new Set([...found.values()].filter((f) => f.exact).flatMap((f) => f.read.split(" ")));
  return [...found.values()].filter((f) => f.exact || !f.read.split(" ").every((w) => exactWords.has(w))).sort((a, b) => b.score - a.score);
}
