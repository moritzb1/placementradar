/**
 * live.js — Live scanner: recognise products in the webcam (or an uploaded photo), mostly ON THE DEVICE.
 *
 * Decision cascade (see MODELS.md) – cheapest and most certain first:
 *   1. Find objects: YOLOE "packaging finder" (open-vocabulary YOLO, vocabulary fixed to bags, jars, boxes, tubs …
 *      before export → tools/export_yoloe.py). Falls back to YOLO26n (COCO) if it cannot load.
 *      Objects are tracked, so each product is identified once, not every frame.
 *   2. Barcode in view → Open Food Facts → the EXACT product (name, brand, photo, Nutri-Score)   [no API quota]
 *   3. Read brand text: OCR on the device (ocr.js) → brand dictionary from Open Food Facts       [no API quota]
 *   4. Own brand model on the device (brandmodel.js): recognises the LOOK of a brand (logo, colours) for boxes
 *      that OCR could not name – trained by us on Open Food Facts photos (tools/train_brand_model.py)  [no API quota]
 *   5. Tap a box or press "Identify" → one Gemini Flash-Lite request for that crop               [uses quota]
 * Every result shows which engine produced it, and the side panel shows live what each stage currently sees.
 *
 * Privacy: frames stay in the browser. Only a crop the user explicitly sends to "Identify" leaves the device.
 */
import { icon } from "./icons.js";
import { loadOcr, loadBrands, readText, matchBrands } from "./ocr.js";
import { loadBrandModel, classifyBox } from "./brandmodel.js";
import { runWasm } from "./wasmqueue.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// COCO classes that can carry a brand (only used by the YOLO26 fallback; people, cars etc. are ignored)
const PRODUCT_CLASSES = new Set(["bottle", "cup", "wine glass", "bowl", "cell phone", "laptop", "keyboard", "mouse", "remote", "book", "handbag",
  "backpack", "suitcase", "umbrella", "tie", "sports ball", "toothbrush", "scissors", "hair drier", "banana", "apple", "orange", "clock", "vase", "teddy bear", "tv"]);
const ENGINE = {
  barcode: { label: "Barcode · Open Food Facts", icon: "chip", cls: "e-device" },
  ocr: { label: "Text recognition · on device", icon: "text", cls: "e-device" },
  own: { label: "Own model · on device", icon: "sparkle", cls: "e-device" },
  gemini: { label: "Gemini · cloud", icon: "cloud", cls: "e-cloud" },
};
// A label from a stronger engine is never replaced by a weaker one. Order of certainty:
// barcode > Gemini > brand name read EXACTLY > own model (look) > brand name read with a typo.
// Why fuzzy text is last: a script logo read as garbage can be one letter away from another brand
// ("icaoc" → iChoc on a Coca-Cola bottle, camera test 20 Nov) – the own model recognised Coca-Cola correctly.
const RANK = { ocrFuzzy: 0.5, own: 1, ocr: 2, gemini: 3, barcode: 4 };
const rank = (item) => RANK[item.engine === "ocr" && item.fuzzy ? "ocrFuzzy" : item.engine] || 0;
const OWN_EVERY_MS = 800;    // camera mode: classify one unnamed box this often (≈ 0.25 s each on WASM, keeps video smooth)
const OWN_RETRY_MS = 1500;   // …and the same box again at most this often
const OCR_EVERY_MS = 1800;   // whole-frame text recognition in camera mode (≈ 0.3–1 s each, runs beside the detector)

let S = null; // scanner state (one instance)

export async function renderLive(main) {
  stopLive();
  S = { tracks: [], lost: [], nextId: 1, seen: new Map(), barcodes: new Map(), running: false, source: null, lastBarcode: 0, lastOcr: 0, lastOwn: 0, busy: false, ocrBusy: false, ownBusy: false };
  main.innerHTML = `
    <section class="stage-band live-stage">
      <div class="rings" aria-hidden="true"></div><div class="sweep" aria-hidden="true"></div>
      <div class="live-head"><div><h1>Live scanner</h1><p>Products in front of your camera, recognised on your device.</p></div>
        <span class="badge" id="lvBackend">${icon("chip")} loading model…</span><a class="btn glass" href="#/">${icon("play")} Analyse a video instead</a></div>
    <div class="live-grid">
      <div class="stage" id="stage">
        <video id="cam" playsinline muted></video><canvas id="ov"></canvas>
        <div class="stage-empty" id="stageEmpty">
          <div class="cam-ico">${icon("camera")}</div>
          <h2>Hold a product into the camera</h2>
          <p>Packages are found and their brand text is read on your device. A barcode gives the exact product. Tap a box to ask Gemini about anything else.</p>
          <div class="row-btns"><button class="btn primary" id="startCam">${icon("camera")} Start camera</button>
            <label class="btn" for="photo">${icon("doc")} Analyse a photo</label><input type="file" id="photo" accept="image/*" hidden></div>
          <p class="small muted" id="camMsg"></p>
        </div>
      </div>
      <aside class="live-side">
        <div class="card"><h3>How it decides</h3>
          <div class="cascade">
            <div><span class="eng e-device">1</span><b>Find objects</b><span id="st-find">packaging finder in your browser</span></div>
            <div><span class="eng e-device">2</span><b>Barcode</b><span id="st-code">exact product via Open Food Facts</span></div>
            <div><span class="eng e-device">3</span><b>Read brand text</b><span id="st-ocr">text recognition on your device</span></div>
            <div><span class="eng e-device">4</span><b>Own model</b><span id="st-own">recognises the look of a brand on your device</span></div>
            <div><span class="eng e-cloud">5</span><b>Ask Gemini</b><span id="st-gem">only when you tap a box</span></div>
          </div>
          <div class="row-btns" style="margin-top:12px"><button class="btn" id="identify" disabled>${icon("cloud")} Identify largest object</button>
            <button class="btn" id="stopCam" hidden>Stop</button></div>
          <p class="small muted" id="liveMsg"></p>
        </div>
      </aside>
    </div>
    </section>
    <div class="content"><div class="seen-wrap"><div class="sect-head"><h3>Seen in this session</h3></div>
      <div id="seen" class="seen-list"><div class="card">Nothing yet. Start the camera or analyse a photo.</div></div></div></div>`;
  $("#startCam").onclick = startCamera;
  $("#stopCam").onclick = () => { stopLive(); renderLive(main); };
  $("#photo").onchange = (e) => e.target.files[0] && analysePhoto(e.target.files[0]);
  $("#identify").onclick = () => identifyLargest();
  $("#ov").onclick = (e) => identifyAt(e);
  if (/[?&]start=1/.test(location.hash)) { history.replaceState(null, "", "#/live"); startCamera(); } // "Start camera" on the start page
  try { await loadModel(); } catch (e) { $("#lvBackend").innerHTML = `${icon("chip")} model failed: ${esc(e.message)}`; }
  // OCR models + brand list load in the background (≈ 13 MB, cached by the browser afterwards)
  Promise.all([loadOcr(), loadBrands()]).then(() => stage("ocr", "ready · Open Food Facts brand list")).catch((e) => stage("ocr", `not available (${e.message})`));
  loadModel().then(loadBrandModel).then((m) => stage("own", `ready · ${m.head.names.length} brands · trained by us`)).catch((e) => stage("own", `not available (${esc(e.message)})`));
}

export function stopLive() {
  if (!S) return;
  S.running = false;
  S.stream?.getTracks().forEach((t) => t.stop());
}

const stage = (id, html) => { const el = $(`#st-${id}`); if (el) el.innerHTML = html; };

// ------------------------------------------------------------------------------------------------
// Detector. Preferred: YOLOE packaging finder (raw head [1, 4+C+32, anchors] → own NMS).
// Fallback: YOLO26n COCO (end-to-end head [1,300,6] = x1 y1 x2 y2 score class, no NMS needed).
// ------------------------------------------------------------------------------------------------
let MODEL = null;
async function loadScript(src) {
  await new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error(`cannot load ${src}`)); document.head.append(s); });
}
async function session(file) {
  const ort = window.ort;
  if (navigator.gpu) { try { return { s: await ort.InferenceSession.create(file, { executionProviders: ["webgpu"] }), backend: "WebGPU" }; } catch { /* fall back */ } }
  return { s: await ort.InferenceSession.create(file, { executionProviders: ["wasm"], graphOptimizationLevel: "all" }), backend: "WASM" };
}
// One shared loading promise: the page, the camera button and a photo upload may all ask for the model at once,
// and two parallel WebGPU session creations must not race.
let MODEL_P = null;
async function loadModel() {
  MODEL_P ??= createModel().catch((e) => { MODEL_P = null; throw e; });
  await MODEL_P;
  $("#lvBackend").innerHTML = `${icon("chip")} ${MODEL.title} · ${MODEL.backend}`;
  return MODEL;
}
async function createModel() {
  if (!window.ort) await loadScript("vendor/ort.webgpu.min.js");
  const ort = window.ort;
  ort.env.wasm.wasmPaths = new URL("vendor/", location.href).href;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  try {
    const meta = await (await fetch("models/yoloe_pack.json")).json();
    const { s, backend } = await session("models/yoloe_pack.onnx");
    MODEL = { session: s, names: meta.names, size: meta.input[2], backend, kind: "raw", title: "YOLOE packaging finder" };
  } catch (e) {
    console.warn("YOLOE not available, using YOLO26n", e);
    const meta = await (await fetch("models/yolo26n.json")).json();
    const { s, backend } = await session("models/yolo26n.onnx");
    MODEL = { session: s, names: meta.names, size: meta.input[2], backend, kind: "e2e", title: "YOLO26n" };
  }
  return MODEL;
}

function nms(boxes, thr) {
  boxes.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const b of boxes) if (keep.every((k) => iou(k, b) < thr)) keep.push(b);
  return keep;
}

const pre = document.createElement("canvas"); const pctx = pre.getContext("2d", { willReadFrequently: true });
async function detect(src, w, h) {
  const { session, size: N, names, kind } = MODEL;
  const s = Math.min(N / w, N / h), nw = Math.round(w * s), nh = Math.round(h * s), px = (N - nw) / 2, py = (N - nh) / 2;
  pre.width = pre.height = N; pctx.fillStyle = "rgb(114,114,114)"; pctx.fillRect(0, 0, N, N); pctx.drawImage(src, 0, 0, w, h, px, py, nw, nh);
  const d = pctx.getImageData(0, 0, N, N).data, n = N * N, x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { x[i] = d[i * 4] / 255; x[n + i] = d[i * 4 + 1] / 255; x[2 * n + i] = d[i * 4 + 2] / 255; }
  const feeds = { [session.inputNames[0]]: new window.ort.Tensor("float32", x, [1, 3, N, N]) };
  // without WebGPU the detector also runs on WASM → it must queue behind OCR and the own model
  const out = MODEL.backend === "WASM" ? await runWasm(session, feeds) : await session.run(feeds);
  const t = out[session.outputNames[0]], o = t.data, boxes = [];
  const back = (x1, y1, x2, y2) => ({ x1: Math.max(0, (x1 - px) / s), y1: Math.max(0, (y1 - py) / s), x2: Math.min(w, (x2 - px) / s), y2: Math.min(h, (y2 - py) / s) });
  if (kind === "raw") {
    const A = t.dims[2], C = names.length;
    for (let a = 0; a < A; a++) {
      let best = 0, bc = 0;
      for (let c = 0; c < C; c++) { const v = o[(4 + c) * A + a]; if (v > best) { best = v; bc = c; } }
      if (best < 0.3) continue;
      const cx = o[a], cy = o[A + a], bw = o[2 * A + a], bh = o[3 * A + a];
      boxes.push({ ...back(cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2), score: best, name: names[bc] });
    }
    return nms(boxes, 0.5).slice(0, 20); // class-agnostic: one package should not get two boxes with different words
  }
  for (let i = 0; i < 300; i++) {
    const sc = o[i * 6 + 4]; if (sc < 0.35) continue;
    const name = names[o[i * 6 + 5] | 0]; if (!PRODUCT_CLASSES.has(name)) continue;
    boxes.push({ ...back(o[i * 6], o[i * 6 + 1], o[i * 6 + 2], o[i * 6 + 3]), score: sc, name });
  }
  return boxes;
}

// Simple tracker: overlap → same object, so a label sticks to it while it moves. Class words may flicker between
// synonyms ("snack bag" / "packet"), so only the position counts.
function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)), iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const i = ix * iy; return i / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - i + 1e-6);
}
function track(boxes) {
  const now = performance.now();
  for (const b of boxes) {
    const t = S.tracks.filter((t) => !t.textOnly).map((t) => [t, iou(t, b)]).sort((p, q) => q[1] - p[1])[0];
    if (t && t[1] > 0.3) { Object.assign(t[0], b, { seen: now }); continue; }
    // New box: if a labelled object vanished here a moment ago (detector flicker, hand in front), keep its name
    const old = S.lost.filter((l) => now - l.seen < 4000 && iou(l, b) > 0.4).sort((p, q) => iou(q, b) - iou(p, b))[0];
    S.tracks.push({ ...b, id: S.nextId++, seen: now, ttl: 1200, label: old?.label || null });
  }
  for (const t of S.tracks) if (now - t.seen >= t.ttl && t.label && !t.textOnly) S.lost.push(t);
  S.lost = S.lost.filter((l) => now - l.seen < 4000).slice(-30);
  S.tracks = S.tracks.filter((t) => now - t.seen < t.ttl);
  const n = S.tracks.filter((t) => !t.textOnly).length;
  stage("find", n ? `<b>${n}</b> object${n > 1 ? "s" : ""} in view` : "looking for packages…");
}

// ------------------------------------------------------------------------------------------------
// Sources: camera loop or a single photo
// ------------------------------------------------------------------------------------------------
async function startCamera() {
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "environment" }, audio: false });
  } catch (e) { $("#camMsg").textContent = `Camera not available (${e.name}). You can analyse a photo instead.`; return; }
  const v = $("#cam"); v.srcObject = S.stream; await v.play();
  $("#stageEmpty").hidden = true; $("#stopCam").hidden = false; $("#identify").disabled = false;
  S.source = v; S.running = true; await loadModel(); loop();
}

async function loop() {
  if (!S?.running) return;
  const v = S.source;
  if (v.videoWidth && !S.busy) {
    S.busy = true;
    try {
      track(await detect(v, v.videoWidth, v.videoHeight));
      draw(v.videoWidth, v.videoHeight);
      if (performance.now() - S.lastBarcode > 700) { S.lastBarcode = performance.now(); scanBarcode(v, v.videoWidth, v.videoHeight); }
      if (!S.ocrBusy && performance.now() - S.lastOcr > OCR_EVERY_MS) runOcr(v, v.videoWidth, v.videoHeight);
      if (!S.ownBusy && performance.now() - S.lastOwn > OWN_EVERY_MS) runOwn(v, v.videoWidth, v.videoHeight);
    } finally { S.busy = false; }
  }
  setTimeout(() => requestAnimationFrame(loop), 60);
}

async function analysePhoto(file) {
  const img = new Image(); img.src = URL.createObjectURL(file); await img.decode();
  stopLive(); S.running = false;
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext("2d").drawImage(img, 0, 0);
  const stageEl = $("#stage"); $("#stageEmpty").hidden = true;
  $("#cam").replaceWith(Object.assign(c, { id: "cam" }));
  S.source = c; $("#identify").disabled = false;
  $("#liveMsg").innerHTML = `<span class="spinner" style="display:inline-block;vertical-align:middle"></span> Looking at the photo on your device…`;
  await loadModel();
  S.tracks = []; track(await detect(c, c.width, c.height)); draw(c.width, c.height);
  await Promise.all([scanBarcode(c, c.width, c.height), runOcr(c, c.width, c.height)]);
  await runOwn(c, c.width, c.height, true); // every box the text could not name
  for (const t of S.tracks) t.ttl = Infinity; // a photo does not move – keep every box
  draw(c.width, c.height);
  const objs = S.tracks.filter((t) => !t.textOnly).length, named = S.tracks.filter((t) => t.label);
  $("#liveMsg").textContent = !objs && !named.length ? "No product found on the device. You can still identify the whole photo with Gemini."
    : `${objs} object(s) found, ${named.length} named on your device${named.length ? ` (${[...new Set(named.map((t) => t.label.brand))].join(", ")})` : ""}. Tap a grey box to ask Gemini about the rest.`;
  stageEl.classList.add("photo");
}

// ------------------------------------------------------------------------------------------------
// Drawing
// ------------------------------------------------------------------------------------------------
function draw(w, h) {
  const ov = $("#ov"); if (!ov) return;
  ov.width = w; ov.height = h; const ctx = ov.getContext("2d"); ctx.clearRect(0, 0, w, h);
  const k = Math.max(1, w / 900);
  for (const t of S.tracks) {
    const label = t.label ? `${t.label.brand}` : t.name;
    ctx.lineWidth = 3 * k; ctx.strokeStyle = t.label ? "#30d158" : "rgba(255,255,255,.9)";
    ctx.setLineDash(t.textOnly ? [8 * k, 6 * k] : []); // brand text found outside any object box
    roundRect(ctx, t.x1, t.y1, t.x2 - t.x1, t.y2 - t.y1, 12 * k); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = `600 ${15 * k}px -apple-system, system-ui, sans-serif`;
    // label sits inside the top edge of its box: packages often overlap, labels above the box would pile up
    const tw = ctx.measureText(label).width + 20 * k, th = 26 * k, y = t.y1 + 6 * k;
    ctx.fillStyle = t.label ? "rgba(48,209,88,.92)" : "rgba(0,0,0,.6)"; roundRect(ctx, t.x1 + 6 * k, y, tw, th, th / 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.fillText(label, t.x1 + 16 * k, y + th * 0.68);
  }
}
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h); }

/** Put a recognised product on the object that contains it (or a dashed text box if none does). */
function setLabel(box, item, ttl) {
  // The object that holds most of the text box; among equals the smallest (a tub in front of a bag)
  const inside = (t) => (Math.max(0, Math.min(t.x2, box.x2) - Math.max(t.x1, box.x1)) * Math.max(0, Math.min(t.y2, box.y2) - Math.max(t.y1, box.y1))) / (area(box) + 1e-6);
  let t = S.tracks.filter((t) => !t.textOnly && inside(t) > 0.6).sort((a, b) => inside(b) - inside(a) || area(a) - area(b))[0];
  if (!t) {
    // no object box around the text: keep one dashed box per brand, refreshed by every OCR pass
    t = S.tracks.find((x) => x.textOnly && x.label?.brand === item.brand);
    const pad = (box.y2 - box.y1) * 0.6, now = performance.now();
    const geo = { x1: box.x1 - pad, y1: box.y1 - pad, x2: box.x2 + pad, y2: box.y2 + pad, seen: now };
    if (t) Object.assign(t, geo); else S.tracks.push(t = { ...geo, id: S.nextId++, ttl, name: "brand text", textOnly: true, label: null });
  }
  if (!t.label || rank(item) >= rank(t.label)) t.label = item;
}

// ------------------------------------------------------------------------------------------------
// Engine 2: barcode → Open Food Facts (exact product, no quota)
// ------------------------------------------------------------------------------------------------
let zxing = null;
async function readBarcode(src, w, h) {
  // 1st choice: the browser's own detector (Chrome/Edge). If missing or it finds nothing → ZXing (pure JS, works in Firefox/Safari).
  if (typeof window.BarcodeDetector === "function") {
    try {
      const det = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
      const r = await det.detect(src); if (r[0]?.rawValue) return r[0].rawValue;
    } catch { /* unsupported formats on this platform → ZXing */ }
  }
  if (!zxing) {
    await loadScript("https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js");
    const Z = window.ZXing; const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    zxing = { Z, reader: new Z.MultiFormatReader() }; zxing.reader.setHints(hints);
  }
  const c = document.createElement("canvas"); const sc = Math.min(1, 960 / w); c.width = w * sc; c.height = h * sc;
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  try {
    const { Z, reader } = zxing;
    return reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(c)))).getText();
  } catch { return null; }
}

async function scanBarcode(src, w, h) {
  const code = await readBarcode(src, w, h).catch(() => null); if (!code || S.barcodes.has(code)) return;
  S.barcodes.set(code, null);
  stage("code", `read <b>${esc(code)}</b> · asking Open Food Facts…`);
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,image_front_small_url,nutriscore_grade,quantity`);
    const j = await r.json();
    if (j.status !== 1) { stage("code", `${esc(code)} · not in Open Food Facts yet`); addSeen({ brand: `Barcode ${code}`, product: "not in Open Food Facts yet", engine: "barcode" }); return; }
    const p = j.product; const brand = (p.brands || "").split(",")[0].trim() || "Unknown brand";
    const item = { brand, product: [p.product_name, p.quantity].filter(Boolean).join(" · "), image: p.image_front_small_url, nutri: p.nutriscore_grade, code, engine: "barcode" };
    S.barcodes.set(code, item); addSeen(item);
    stage("code", `<b>${esc(brand)}</b> · ${esc(p.product_name || code)}`);
    const biggest = [...S.tracks].filter((t) => !t.textOnly).sort((a, b) => area(b) - area(a))[0]; if (biggest) biggest.label = item;
  } catch { stage("code", "Open Food Facts not reachable"); }
}
const area = (t) => (t.x2 - t.x1) * (t.y2 - t.y1);

// ------------------------------------------------------------------------------------------------
// Engine 3: read brand text (OCR on the device → Open Food Facts brand dictionary)
// ------------------------------------------------------------------------------------------------
async function runOcr(src, w, h) {
  S.ocrBusy = true; S.lastOcr = performance.now();
  try {
    await Promise.all([loadOcr(), loadBrands()]);
    const words = await readText(src, w, h);
    const brands = matchBrands(words);
    for (const b of brands) {
      const item = { brand: b.brand, product: `read on the package: “${b.read}”${b.exact ? "" : " (close match)"}`, engine: "ocr", fuzzy: !b.exact };
      setLabel(b, item, OCR_EVERY_MS * 1.6);
      addSeen(item);
    }
    const shown = words.slice().sort((a, b) => (b.y2 - b.y1) - (a.y2 - a.y1)).slice(0, 6).map((w) => esc(w.text)); // biggest letters first
    stage("ocr", brands.length ? `<b>${brands.map((b) => esc(b.brand)).join(", ")}</b> · ${words.ms} ms`
      : words.length ? `read “${shown.join(" · ")}” – no known brand · ${words.ms} ms` : `no text in view · ${words.ms} ms`);
    if (S.source && !S.running) draw(w, h);
  } catch (e) {
    console.warn("OCR failed", e); stage("ocr", "text recognition failed on this device");
  } finally { S.ocrBusy = false; }
}

// ------------------------------------------------------------------------------------------------
// Engine 4: own brand model (look of the package → brand), only for boxes without a stronger label
// ------------------------------------------------------------------------------------------------
async function runOwn(src, w, h, all = false) {
  S.ownBusy = true; S.lastOwn = performance.now();
  try {
    await loadBrandModel();
    const now = performance.now();
    const todo = S.tracks.filter((t) => !t.textOnly && (!t.label || rank(t.label) <= RANK.own) && !(now - (t.ownAt || -1e9) < OWN_RETRY_MS))
      .sort((a, b) => (a.ownAt || 0) - (b.ownAt || 0) || area(b) - area(a));
    for (const t of all ? todo : todo.slice(0, 1)) {
      t.ownAt = performance.now();
      const r = await classifyBox(src, t, w, h); if (!r) continue;
      const alt = r.top.slice(1).map(([b, p]) => `${esc(b)} ${Math.round(p * 100)} %`).join(", ");
      if (r.sure) {
        const item = { brand: r.brand, product: `recognised by its look · ${Math.round(r.conf * 100)} % sure`, engine: "own" };
        if (!t.label || rank(t.label) <= RANK.own) t.label = item;
        addSeen(item);
        stage("own", `<b>${esc(r.brand)}</b> ${Math.round(r.conf * 100)} % · ${r.ms} ms`);
      } else {
        stage("own", `not sure – maybe ${esc(r.brand)} ${Math.round(r.conf * 100)} %${alt ? `, ${alt}` : ""} · ${r.ms} ms`);
      }
    }
    if (S.source && !S.running) draw(w, h);
  } catch (e) {
    console.warn("own model failed", e); stage("own", "not available on this device");
  } finally { S.ownBusy = false; }
}

// ------------------------------------------------------------------------------------------------
// Engine 5: Gemini for a crop the user chose (1 request)
// ------------------------------------------------------------------------------------------------
function identifyAt(e) {
  const ov = $("#ov"); const r = ov.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * ov.width, y = ((e.clientY - r.top) / r.height) * ov.height;
  const t = S.tracks.filter((t) => x >= t.x1 && x <= t.x2 && y >= t.y1 && y <= t.y2).sort((a, b) => area(a) - area(b))[0];
  if (t) identify(t);
}
function identifyLargest() {
  const t = [...S.tracks].filter((t) => !t.textOnly).sort((a, b) => area(b) - area(a))[0];
  identify(t || null);
}
async function identify(t) {
  const src = S.source; const w = src.videoWidth || src.width, h = src.videoHeight || src.height;
  const box = t ? { x: Math.max(0, t.x1 - 20), y: Math.max(0, t.y1 - 20), w: Math.min(w, t.x2 + 20) - Math.max(0, t.x1 - 20), h: Math.min(h, t.y2 + 20) - Math.max(0, t.y1 - 20) } : { x: 0, y: 0, w, h };
  const c = document.createElement("canvas"); const sc = Math.min(1, 512 / Math.max(box.w, box.h)); c.width = box.w * sc; c.height = box.h * sc;
  c.getContext("2d").drawImage(src, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  const image = c.toDataURL("image/jpeg", 0.8).split(",")[1];
  $("#liveMsg").innerHTML = `<span class="spinner" style="display:inline-block;vertical-align:middle"></span> Asking Gemini…`;
  stage("gem", "asking…");
  try {
    const invite = localStorage.getItem("invite") || "";
    const r = await fetch("api/identify", { method: "POST", headers: { "content-type": "application/json", "x-invite": invite }, body: JSON.stringify({ image }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || { invite_required: "Identify needs an invite link.", daily_limit: "Daily limit reached.", own_key_required: "This version needs your own Gemini key." }[j.error] || j.error || `HTTP ${r.status}`);
    const best = (j.items || []).sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    if (!best) { $("#liveMsg").textContent = "Gemini found no brand in this crop."; stage("gem", "no brand in this crop"); return; }
    const item = { brand: best.brand, product: best.product || "", engine: "gemini", model: j.model };
    if (t) t.label = item; addSeen(item); draw(w, h);
    stage("gem", `<b>${esc(best.brand)}</b> · ${esc(j.model || "")}${j.cached ? " · from cache" : ""}`);
    $("#liveMsg").textContent = j.cached ? `Already known (${j.model}) – answered from the cache, no API call.`
      : `Identified by ${j.model}. Next time the on-device model can learn this product.`;
  } catch (e) {
    $("#liveMsg").textContent = e instanceof TypeError ? "Gemini is only available in the online version." : e.message;
    stage("gem", "only when you tap a box");
  }
}

// ------------------------------------------------------------------------------------------------
// "Seen in this session" list
// ------------------------------------------------------------------------------------------------
function addSeen(item) {
  // usage meter (Settings → Show AI usage): on-device results cost 0 tokens, Gemini/Workers AI results cost one request
  window.dispatchEvent(new CustomEvent("pr:recognition", { detail: { engine: item.engine, model: item.model || null } }));
  const key = item.code || `${item.brand}|${item.engine}`; const prev = S.seen.get(key);
  S.seen.delete(key); // re-insert → most recent on top
  S.seen.set(key, { ...prev, ...item, image: item.image || prev?.image, n: (prev?.n || 0) + 1 });
  $("#seen").innerHTML = [...S.seen.values()].reverse().map((it) => {
    const e = ENGINE[it.engine];
    return `<div class="card seen-card">${it.image ? `<img alt="" src="${esc(it.image)}">` : `<span class="mono" style="background:#5e5ce6">${esc(it.brand.charAt(0).toUpperCase())}</span>`}
      <div style="min-width:0"><b>${esc(it.brand)}</b><div class="small muted ell">${esc(it.product)}</div>
      <span class="eng-badge ${e.cls}">${icon(e.icon)} ${e.label}${it.nutri ? ` · Nutri-Score ${esc(it.nutri.toUpperCase())}` : ""}</span></div></div>`;
  }).join("");
}
