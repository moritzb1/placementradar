/**
 * live.js — Live scanner: recognise products in the webcam (or an uploaded photo), mostly ON THE DEVICE.
 *
 * Decision cascade (see MODELS.md) – cheapest and most certain first:
 *   1. YOLO26n (ONNX in the browser) finds and tracks objects → each product is identified once, not every frame
 *   2. Barcode in view → Open Food Facts → the EXACT product (name, brand, photo, Nutri-Score)   [no API quota]
 *   3. (next version) own brand model / visual product search on the device
 *   4. Tap a box or press "Identify" → one Gemini Flash-Lite request for that crop               [uses quota]
 * Every result shows which engine produced it.
 *
 * Privacy: frames stay in the browser. Only a crop the user explicitly sends to "Identify" leaves the device.
 */
import { icon } from "./icons.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// COCO classes that can carry a brand (people, cars etc. are ignored in the scanner)
const PRODUCT_CLASSES = new Set(["bottle", "cup", "wine glass", "bowl", "cell phone", "laptop", "keyboard", "mouse", "remote", "book", "handbag",
  "backpack", "suitcase", "umbrella", "tie", "sports ball", "toothbrush", "scissors", "hair drier", "banana", "apple", "orange", "clock", "vase", "teddy bear", "tv"]);
const ENGINE = {
  yolo: { label: "YOLO26 · on device", icon: "chip", cls: "e-device" },
  barcode: { label: "Barcode · Open Food Facts", icon: "chip", cls: "e-device" },
  gemini: { label: "Gemini · cloud", icon: "cloud", cls: "e-cloud" },
};

let S = null; // scanner state (one instance)

export async function renderLive(main) {
  stopLive();
  S = { tracks: [], nextId: 1, seen: new Map(), barcodes: new Map(), running: false, source: null, lastBarcode: 0, busy: false };
  main.innerHTML = `
    <div class="toolbar"><h1>Live scanner <span class="sub">· products in front of the camera</span></h1>
      <span class="badge" id="lvBackend">${icon("chip")} loading model…</span></div>
    <div class="content live">
      <div class="stage" id="stage">
        <video id="cam" playsinline muted></video><canvas id="ov"></canvas>
        <div class="stage-empty" id="stageEmpty">
          <div class="cam-ico">${icon("camera")}</div>
          <h2>Hold a product into the camera</h2>
          <p>Objects are found on your device. A barcode gives the exact product. Tap a box to ask Gemini about anything else.</p>
          <div class="row-btns"><button class="btn primary" id="startCam">${icon("camera")} Start camera</button>
            <label class="btn" for="photo">${icon("doc")} Analyse a photo</label><input type="file" id="photo" accept="image/*" hidden></div>
          <p class="small muted" id="camMsg"></p>
        </div>
      </div>
      <aside class="live-side">
        <div class="card"><h3>${icon("sparkle")} How it decides</h3>
          <div class="cascade">
            <div><span class="eng e-device">1</span><b>Find objects</b><span>YOLO26 in your browser</span></div>
            <div><span class="eng e-device">2</span><b>Barcode</b><span>exact product via Open Food Facts</span></div>
            <div><span class="eng e-device">3</span><b>Own model</b><span>brand recognition on device · next version</span></div>
            <div><span class="eng e-cloud">4</span><b>Ask Gemini</b><span>only when you tap a box</span></div>
          </div>
          <div class="row-btns" style="margin-top:12px"><button class="btn" id="identify" disabled>${icon("cloud")} Identify largest object</button>
            <button class="btn" id="stopCam" hidden>Stop</button></div>
          <p class="small muted" id="liveMsg"></p>
        </div>
        <div class="nav-label" style="padding-left:4px">Seen in this session</div>
        <div id="seen" class="seen"><div class="card small muted">Nothing yet.</div></div>
      </aside>
    </div>`;
  $("#startCam").onclick = startCamera;
  $("#stopCam").onclick = () => { stopLive(); renderLive(main); };
  $("#photo").onchange = (e) => e.target.files[0] && analysePhoto(e.target.files[0]);
  $("#identify").onclick = () => identifyLargest();
  $("#ov").onclick = (e) => identifyAt(e);
  try { await loadModel(); } catch (e) { $("#lvBackend").innerHTML = `${icon("chip")} model failed: ${esc(e.message)}`; }
}

export function stopLive() {
  if (!S) return;
  S.running = false;
  S.stream?.getTracks().forEach((t) => t.stop());
}

// ------------------------------------------------------------------------------------------------
// Model (YOLO26n, end-to-end: output [1,300,6] = x1 y1 x2 y2 score class, no NMS needed)
// ------------------------------------------------------------------------------------------------
let MODEL = null;
async function loadScript(src) {
  await new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error(`cannot load ${src}`)); document.head.append(s); });
}
async function loadModel() {
  if (MODEL) { $("#lvBackend").innerHTML = `${icon("chip")} YOLO26n · ${MODEL.backend}`; return MODEL; }
  if (!window.ort) await loadScript("vendor/ort.webgpu.min.js");
  const ort = window.ort;
  ort.env.wasm.wasmPaths = new URL("vendor/", location.href).href;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  const meta = await (await fetch("models/yolo26n.json")).json();
  let session = null, backend = "WASM";
  if (navigator.gpu) { try { session = await ort.InferenceSession.create("models/yolo26n.onnx", { executionProviders: ["webgpu"] }); backend = "WebGPU"; } catch { /* fall back */ } }
  if (!session) session = await ort.InferenceSession.create("models/yolo26n.onnx", { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  MODEL = { session, names: meta.names, size: meta.input[2], backend };
  $("#lvBackend").innerHTML = `${icon("chip")} YOLO26n · ${backend}`;
  return MODEL;
}

const pre = document.createElement("canvas"); const pctx = pre.getContext("2d", { willReadFrequently: true });
async function detect(src, w, h) {
  const { session, size: N, names } = MODEL;
  const s = Math.min(N / w, N / h), nw = Math.round(w * s), nh = Math.round(h * s), px = (N - nw) / 2, py = (N - nh) / 2;
  pre.width = pre.height = N; pctx.fillStyle = "rgb(114,114,114)"; pctx.fillRect(0, 0, N, N); pctx.drawImage(src, 0, 0, w, h, px, py, nw, nh);
  const d = pctx.getImageData(0, 0, N, N).data, n = N * N, x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { x[i] = d[i * 4] / 255; x[n + i] = d[i * 4 + 1] / 255; x[2 * n + i] = d[i * 4 + 2] / 255; }
  const out = await session.run({ [session.inputNames[0]]: new window.ort.Tensor("float32", x, [1, 3, N, N]) });
  const o = out[session.outputNames[0]].data, boxes = [];
  for (let i = 0; i < 300; i++) {
    const sc = o[i * 6 + 4]; if (sc < 0.35) continue;
    const name = names[o[i * 6 + 5] | 0]; if (!PRODUCT_CLASSES.has(name)) continue;
    boxes.push({ x1: (o[i * 6] - px) / s, y1: (o[i * 6 + 1] - py) / s, x2: (o[i * 6 + 2] - px) / s, y2: (o[i * 6 + 3] - py) / s, score: sc, name });
  }
  return boxes;
}

// Simple tracker: same class + overlap → same object, so a label sticks to it while it moves
function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)), iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const i = ix * iy; return i / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - i + 1e-6);
}
function track(boxes) {
  const now = performance.now();
  for (const b of boxes) {
    const t = S.tracks.find((t) => t.name === b.name && iou(t, b) > 0.3);
    if (t) Object.assign(t, b, { seen: now }); else S.tracks.push({ ...b, id: S.nextId++, seen: now, label: null });
  }
  S.tracks = S.tracks.filter((t) => now - t.seen < 1200);
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
    } finally { S.busy = false; }
  }
  setTimeout(() => requestAnimationFrame(loop), 60);
}

async function analysePhoto(file) {
  const img = new Image(); img.src = URL.createObjectURL(file); await img.decode();
  stopLive(); S.running = false;
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext("2d").drawImage(img, 0, 0);
  const stage = $("#stage"); $("#stageEmpty").hidden = true;
  $("#cam").replaceWith(Object.assign(c, { id: "cam" }));
  S.source = c; $("#identify").disabled = false;
  await loadModel();
  S.tracks = []; track(await detect(c, c.width, c.height)); draw(c.width, c.height);
  await scanBarcode(c, c.width, c.height);
  $("#liveMsg").textContent = S.tracks.length ? `${S.tracks.length} object(s) found on your device. Tap a box to identify the brand.` : "No product-like object found. You can still identify the whole photo.";
  stage.classList.add("photo");
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
    roundRect(ctx, t.x1, t.y1, t.x2 - t.x1, t.y2 - t.y1, 12 * k); ctx.stroke();
    ctx.font = `600 ${15 * k}px -apple-system, system-ui, sans-serif`;
    const tw = ctx.measureText(label).width + 20 * k, th = 26 * k, y = Math.max(0, t.y1 - th - 6 * k);
    ctx.fillStyle = t.label ? "rgba(48,209,88,.92)" : "rgba(0,0,0,.6)"; roundRect(ctx, t.x1, y, tw, th, th / 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.fillText(label, t.x1 + 10 * k, y + th * 0.68);
  }
}
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h); }

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
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,image_front_small_url,nutriscore_grade,quantity`);
    const j = await r.json();
    if (j.status !== 1) { addSeen({ brand: `Barcode ${code}`, product: "not in Open Food Facts yet", engine: "barcode" }); return; }
    const p = j.product; const brand = (p.brands || "").split(",")[0].trim() || "Unknown brand";
    const item = { brand, product: [p.product_name, p.quantity].filter(Boolean).join(" · "), image: p.image_front_small_url, nutri: p.nutriscore_grade, code, engine: "barcode" };
    S.barcodes.set(code, item); addSeen(item);
    const biggest = [...S.tracks].sort((a, b) => area(b) - area(a))[0]; if (biggest) biggest.label = item;
  } catch { /* offline */ }
}
const area = (t) => (t.x2 - t.x1) * (t.y2 - t.y1);

// ------------------------------------------------------------------------------------------------
// Engine 4: Gemini for a crop the user chose (1 request)
// ------------------------------------------------------------------------------------------------
function identifyAt(e) {
  const ov = $("#ov"); const r = ov.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * ov.width, y = ((e.clientY - r.top) / r.height) * ov.height;
  const t = S.tracks.filter((t) => x >= t.x1 && x <= t.x2 && y >= t.y1 && y <= t.y2).sort((a, b) => area(a) - area(b))[0];
  if (t) identify(t);
}
function identifyLargest() {
  const t = [...S.tracks].sort((a, b) => area(b) - area(a))[0];
  identify(t || null);
}
async function identify(t) {
  const src = S.source; const w = src.videoWidth || src.width, h = src.videoHeight || src.height;
  const box = t ? { x: Math.max(0, t.x1 - 20), y: Math.max(0, t.y1 - 20), w: Math.min(w, t.x2 + 20) - Math.max(0, t.x1 - 20), h: Math.min(h, t.y2 + 20) - Math.max(0, t.y1 - 20) } : { x: 0, y: 0, w, h };
  const c = document.createElement("canvas"); const sc = Math.min(1, 512 / Math.max(box.w, box.h)); c.width = box.w * sc; c.height = box.h * sc;
  c.getContext("2d").drawImage(src, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  const image = c.toDataURL("image/jpeg", 0.8).split(",")[1];
  $("#liveMsg").innerHTML = `<span class="spinner" style="display:inline-block;vertical-align:middle"></span> Asking Gemini…`;
  try {
    const invite = localStorage.getItem("invite") || "";
    const r = await fetch("api/identify", { method: "POST", headers: { "content-type": "application/json", "x-invite": invite }, body: JSON.stringify({ image }) });
    const j = await r.json();
    if (!r.ok) throw new Error({ invite_required: "Identify needs an invite link.", daily_limit: "Daily limit reached.", own_key_required: "This version needs your own Gemini key." }[j.error] || j.error || `HTTP ${r.status}`);
    const best = (j.items || []).sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    if (!best) { $("#liveMsg").textContent = "Gemini found no brand in this crop."; return; }
    const item = { brand: best.brand, product: best.product || "", engine: "gemini", model: j.model };
    if (t) t.label = item; addSeen(item); draw(w, h);
    $("#liveMsg").textContent = `Identified by ${j.model}. Next time the on-device model can learn this product.`;
  } catch (e) {
    $("#liveMsg").textContent = e instanceof TypeError ? "Gemini is only available in the online version." : e.message;
  }
}

// ------------------------------------------------------------------------------------------------
// "Seen in this session" list
// ------------------------------------------------------------------------------------------------
function addSeen(item) {
  const key = `${item.brand}|${item.product}`; const prev = S.seen.get(key);
  S.seen.set(key, { ...item, n: (prev?.n || 0) + 1 });
  $("#seen").innerHTML = [...S.seen.values()].reverse().map((it) => {
    const e = ENGINE[it.engine];
    return `<div class="card seen-card">${it.image ? `<img alt="" src="${esc(it.image)}">` : `<span class="mono" style="background:#5e5ce6">${esc(it.brand.charAt(0).toUpperCase())}</span>`}
      <div style="min-width:0"><b>${esc(it.brand)}</b><div class="small muted ell">${esc(it.product)}</div>
      <span class="eng-badge ${e.cls}">${icon(e.icon)} ${e.label}${it.nutri ? ` · Nutri-Score ${esc(it.nutri.toUpperCase())}` : ""}</span></div></div>`;
  }).join("");
}
