/**
 * verify.js — "Verify on screen": our own on-device models check Gemini's findings on the REAL video frames.
 *
 * The problem it solves: the YouTube player is a cross-origin iframe, so the page cannot read its pixels – every
 * product, time and box so far came from Gemini and had to be believed (EVALUATION.md W, W2: identical spans for
 * five products, template boxes on the presenter's face). With one click the user shares THIS tab
 * (getDisplayMedia with preferCurrentTab). In Chrome the capture is limited to the player itself:
 *   - Element Capture (RestrictionTarget.fromElement(iframe) + track.restrictTo): only the iframe's own pixels,
 *     even our boxes drawn on top of it are left out → the models never read our own labels; boxes stay visible.
 *   - Region Capture (CropTarget.fromElement + track.cropTo): the iframe's rectangle, but with everything drawn on
 *     top → our overlay is hidden while verifying.
 *   - otherwise (other browsers): the whole tab, cut down to the player with getBoundingClientRect × scale;
 *     overlay hidden as well.
 *
 * Then the existing browser models run on the frames (same files as the live scanner, nothing new to download
 * except the 9 MB COCO detector and a 93 KB type list):
 *   1. detectors: YOLOE packaging finder + YOLO26n (COCO: monitor/tv, keyboard, mouse, laptop, backpack …) → boxes,
 *      smoothed and kept apart by tracker.js
 *   2. OCR (ocr.js) → is the brand or the model name written anywhere in the frame?
 *   3. own brand model (brandmodel.js, 1,020 brands) → does a box LOOK like that brand?
 *   4. product TYPE (brandmodel.js rankTypes): MobileCLIP image fingerprint of the box / of Gemini's position against
 *      text fingerprints of ~90 product types computed offline (tools/build_category_bank.py) – the type, not the brand
 *
 * Result per Gemini appearance (key brand|start|end):
 *   confirmed      – evidence on ≥ 2 checked frames (and ≥ 15 % of them): brand read / brand by look / object type
 *   not seen       – a detector, the own model (packages) or OCR could have found it, ≥ 4 frames checked, evidence on < 15 %
 *   not checkable  – no model could have found it reliably: no detector class (only the type check at Gemini's position,
 *                    e.g. Mac mini, speaker), brand unknown to the own model, no written brand
 *   checking       – too few frames yet
 * plus MEASURED boxes: the detector box that carries the evidence, followed by tracker.js, stored as keyframes so they
 * can be replayed after the capture ends, and the deviation from Gemini's estimate (IoU, centre distance).
 *
 * Privacy: frames never leave the browser. Nothing is sent to the server; results are kept in sessionStorage
 * (`verify:<videoId>`) and vanish with the tab.
 *
 * Used by app.js (button, dialog, Right now, Products) and tracking.js (draws measured boxes).
 */
import { ensureOrt, loadFinder, loadCoco, detect } from "./detector.js";
import { loadOcr, loadBrands, readText, matchBrands, brandKey, lev } from "./ocr.js";
import { loadBrandModel, classifyBox, embedBox, knowsBrand, rankTypes, loadTypeBank } from "./brandmodel.js";
import { updateTracks, placeTracks, iou } from "./tracker.js";

// ------------------------------------------------------------------------------------------------
// Product types: words in Gemini's product name / category → detector classes (YOLOE + COCO) and type names of the
// zero-shot type list. First match wins, so "monitor light bar" comes before "monitor".
// ------------------------------------------------------------------------------------------------
const PACK = ["snack bag", "chips bag", "food package", "cardboard box", "cereal box", "glass jar", "jar", "plastic tub", "yogurt cup", "can", "bottle", "carton", "tube", "chocolate bar", "packet"];
export const TYPES = [
  { re: /light ?bar|lamp|ring light/, det: [], zs: ["monitor light bar", "desk lamp", "ring light"], label: "lamp" },
  { re: /mac ?mini|mac studio|desktop|pc tower/, det: [], zs: ["small desktop computer", "desktop computer tower"], label: "desktop computer" },
  { re: /macbook|laptop|notebook computer|chromebook|thinkpad/, det: ["laptop"], zs: ["laptop"], label: "laptop" },
  { re: /monitor|display|screen|\btv\b|television|oled/, det: ["tv"], zs: ["computer monitor", "television"], label: "monitor" },
  { re: /keyboard/, det: ["keyboard"], zs: ["computer keyboard"], label: "keyboard" },
  { re: /\bmouse\b|trackpad/, det: ["mouse"], zs: ["computer mouse", "trackpad"], label: "mouse" },
  { re: /webcam/, det: [], zs: ["webcam"], label: "webcam" },
  { re: /\beos\b|lumix|\balpha\b|gopro|camera|\blens\b/, det: ["camera"], zs: ["camera", "camera lens"], label: "camera" },
  { re: /ipad|tablet/, det: ["laptop", "cell phone", "smartphone"], zs: ["tablet computer"], label: "tablet" },
  { re: /iphone|pixel|galaxy s|smartphone|\bphone\b/, det: ["cell phone", "smartphone"], zs: ["smartphone"], label: "phone" },
  { re: /backpack|rucksack|everyday pack|daypack/, det: ["backpack", "bag", "handbag"], zs: ["backpack"], label: "backpack" },
  { re: /suitcase|luggage|carry-on/, det: ["suitcase"], zs: ["suitcase"], label: "suitcase" },
  { re: /\bbag\b|tote|duffel|sling|handbag|purse/, det: ["handbag", "backpack", "bag", "suitcase"], zs: ["handbag", "tote bag", "backpack"], label: "bag" },
  { re: /headphone|earbud|airpods|headset|earphone|buds/, det: ["headphones"], zs: ["headphones", "earbuds"], label: "headphones" },
  { re: /\bmic\b|microphone/, det: [], zs: ["microphone"], label: "microphone" },
  { re: /speaker|soundbar|\bsonos\b/, det: [], zs: ["speaker", "smart speaker", "soundbar"], label: "speaker" },
  { re: /\bssd\b|hard drive|hard disk|\bdrive\b/, det: [], zs: ["external hard drive"], label: "drive" },
  { re: /charger|power bank|adapter|superdart/, det: [], zs: ["phone charger", "power bank"], label: "charger" },
  { re: /wallet|card case/, det: [], zs: ["wallet"], label: "wallet" },
  { re: /smartwatch|watch/, det: ["watch", "clock"], zs: ["smartwatch", "wristwatch"], label: "watch" },
  { re: /controller|gamepad/, det: ["game controller", "remote"], zs: ["game controller"], label: "controller" },
  { re: /sneaker|shoe|\bboot|trainer/, det: ["shoe"], zs: ["sneaker", "shoe"], label: "shoe" },
  { re: /sunglasses|glasses/, det: ["sunglasses"], zs: ["sunglasses", "glasses"], label: "glasses" },
  { re: /orchid|plant|flower|bouquet/, det: ["potted plant", "vase"], zs: ["potted plant", "flower", "lego set"], label: "plant" },
  { re: /lego|toy|figure/, det: ["toy", "teddy bear"], zs: ["lego set", "toy"], label: "toy" },
  { re: /espresso|coffee machine|grinder/, det: [], zs: ["espresso machine", "coffee grinder"], label: "coffee machine" },
  { re: /e-?bike|bicycle|\bbike\b/, det: ["bicycle"], zs: ["electric bike", "bicycle"], label: "bike" },
  { re: /mug|tumbler|\bcup\b/, det: ["cup", "yogurt cup"], zs: ["coffee mug"], label: "cup" },
  { re: /bottle|shampoo|serum|lotion|perfume|spray|cream/, det: ["bottle", "cosmetics bottle", "perfume bottle", "tube"], zs: ["bottle", "cosmetics bottle", "tube of cream"], label: "bottle" },
  { re: /chair/, det: ["chair"], zs: ["office chair"], label: "chair" },
  { re: /\bbook\b/, det: ["book"], zs: ["book"], label: "book" },
  { re: /food|snack|chips|cereal|chocolate|drink|beverage|soda|yog(h)?urt|candy|grocery/, det: PACK, zs: ["snack bag", "cereal box", "chocolate bar", "can", "bottle"], label: "package" },
];
const typeOf = (...texts) => { for (const s of texts) { const x = String(s || "").toLowerCase(); if (!x) continue; const t = TYPES.find((T) => T.re.test(x)); if (t) return t; } return null; };

// Words of a product name that say nothing about the brand (never used as OCR evidence)
const GENERIC = new Set(("monitor smart speaker speakers keyboard mouse drive external working light lamp bar foot rest under desk usb mic " +
  "profile one pro max mini plus ultra the and with for wireless edition everyday backpack bag slim wallet webcam camera").split(" "));

const MIN_HITS = 2, HIT_SHARE = 0.15, MIN_CHECKS = 4;  // status rule (see top of file)
const ZS_TOP = 3;           // type check: an expected type must be among the best 3 of 93 types
const OCR_EVERY_MS = 1200;  // OCR while the video plays (≈ 0.3–1 s each); once per frame while paused
const OWN_PER_FRAME = 2, ZS_PER_FRAME = 4, ZOOM_PER_FRAME = 2; // MobileCLIP runs per frame (≈ 0.1–0.25 s each): own brand model / type check
const PAUSED_FACTOR = 3;    // a paused frame is checked only once → it may use more runs
const STORE_MAX = 600;      // measured keyframes kept per appearance
// b) small things (24 Nov): the detectors see the whole frame at only 320 (COCO) / 512 px (YOLOE) – a keyboard in a wide
// shot is a few pixels tall. TILES: the frame cut into 2×2 overlapping tiles, each tile through both detectors, i.e.
// ~2× the resolution. Time budget: while paused all 4 tiles once per frame; while playing ONE tile per checked frame
// (round robin), and only while a frame takes less than TILE_MAX_MS – so a MacBook stays smooth (EVALUATION V2).
const TILE_GRID = 2, TILE_OVERLAP = 0.18, TILE_MAX_MS = 1600;
// c) found on screen: a brand our own models are SURE about (brand read by OCR, or the own brand model sure about a box)
// at a second where Gemini lists no such brand. Shown once it was found on ≥ FOUND_MIN frames.
const FOUND_MIN = 2, OWN_SCAN = 1;  // own-model runs per frame on boxes no Gemini product claimed (×3 while paused)

/** Gemini box [y0,x0,y1,x1] (0–1000) ↔ pixel box {x1,y1,x2,y2} of a W×H frame. */
const toPx = (b, W, H) => ({ x1: (b[1] / 1000) * W, y1: (b[0] / 1000) * H, x2: (b[3] / 1000) * W, y2: (b[2] / 1000) * H });
const toK = (p, W, H) => [Math.round((1000 * p.y1) / H), Math.round((1000 * p.x1) / W), Math.round((1000 * p.y2) / H), Math.round((1000 * p.x2) / W)];
const kIou = (a, b) => iou({ x1: a[1], y1: a[0], x2: a[3], y2: a[2] }, { x1: b[1], y1: b[0], x2: b[3], y2: b[2] });
/** centre distance of two 0–1000 boxes in % of the picture (diagonal-free: hypot of the x and y offsets in %) */
const kDist = (a, b) => Math.hypot((a[1] + a[3] - b[1] - b[3]) / 20, (a[0] + a[2] - b[0] - b[2]) / 20);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** 4×4×4 RGB histogram (64 numbers) – the cheap appearance fingerprint tracker.js uses to keep boxes apart. */
const hc = document.createElement("canvas"); hc.width = hc.height = 16; const hctx = hc.getContext("2d", { willReadFrequently: true });
function histogram(src, b) {
  const w = b.x2 - b.x1, h = b.y2 - b.y1; if (w < 4 || h < 4) return null;
  hctx.drawImage(src, b.x1 + w * 0.1, b.y1 + h * 0.1, w * 0.8, h * 0.8, 0, 0, 16, 16);
  const d = hctx.getImageData(0, 0, 16, 16).data, H = new Float32Array(64);
  for (let i = 0; i < d.length; i += 4) H[((d[i] >> 6) << 4) | ((d[i + 1] >> 6) << 2) | (d[i + 2] >> 6)] += 1 / 256;
  return H;
}

/**
 * @param {object} o
 * @param {string} o.id               video id (sessionStorage key)
 * @param {object} o.data             the analysis
 * @param {() => HTMLIFrameElement} o.iframe  the YouTube iframe
 * @param {() => number} o.time       current video time in seconds
 * @param {() => boolean} o.playing
 * @param {(v) => void} o.onChange    called after every checked frame and on state changes
 */
export function createVerifier({ id, data, iframe, time, playing, onChange = () => {} }) {
  const STORE = `verify:${id}`;
  // every visual appearance Gemini reported (incl. "in the background" spans) = one thing to check
  const apps = [];
  for (const b of data.brands || []) (b.appearances || []).forEach((a) => {
    if (a.channel !== "visual") return;
    const type = typeOf(a.product, (b.products || []).join(" "), b.product, b.category);
    const name = `${a.product || ""} ${(b.products || []).join(" ")}`;
    // OCR evidence: the brand itself, and distinctive words of the model name ("Keychron", "UltraFine", "QuietComfort")
    const keys = new Set([brandKey(b.brand)]);
    for (const w of name.split(/[^A-Za-zÀ-ÿ0-9]+/)) { const k = brandKey(w); if (k.length >= 4 && /[a-z]/.test(k) && !GENERIC.has(k)) keys.add(k); }
    apps.push({ key: `${b.brand}|${a.start_s}|${a.end_s}`, brand: b.brand, product: a.product || b.product || (b.products || [])[0] || "", a, b, type, keys: [...keys].filter(Boolean), basis: a.basis || "" });
  });
  const R = load() || { v: 1, frames: 0, apps: {}, mode: null, at: null };
  R.found ||= {}; // c) brands found by our own models that Gemini does not list at that second
  const rec = (k) => (R.apps[k] ||= { checks: 0, hits: 0, how: {}, read: [], meas: [], dev: [] });

  const st = { tile: 0, log: [], running: false, phase: "idle", msg: "", mode: R.mode, stream: null, video: null, links: new Map(), lastOcr: 0, lastFrameKey: null, ms: 0, live: new Map(), unclaimed: new Map(), found: new Map() };
  const TS = { tracks: [], lost: [], nextId: 1 }; // tracker.js state (frame pixels)
  let W = 0, H = 0, saveTimer = 0;
  const frame = document.createElement("canvas"), fctx = frame.getContext("2d", { willReadFrequently: true });
  const zc = document.createElement("canvas"), zctx = zc.getContext("2d", { willReadFrequently: true }); // magnified region

  function load() { try { return JSON.parse(sessionStorage.getItem(STORE) || "null"); } catch { return null; } }
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { sessionStorage.setItem(STORE, JSON.stringify(R)); } catch { /* full or private mode */ } }, 800); }
  const covering = (t) => apps.filter((p) => t >= p.a.start_s - 0.5 && t <= p.a.end_s + 0.5);

  /** Gemini's estimated box for an appearance at t: nearest keyframe (or the brand's frame inside the span). */
  function estimate(p, t) {
    if (p.a.no_box) return null;
    const keys = p.a.track?.length ? p.a.track : (p.b.frames || []).filter((f) => f.t >= p.a.start_s - 1 && f.t <= p.a.end_s + 1);
    if (!keys.length) return null;
    const k = keys.reduce((m, x) => (Math.abs(x.t - t) < Math.abs(m.t - t) ? x : m));
    return { box: k.box, dt: Math.abs(k.t - t) };
  }

  // ----------------------------------------------------------------------------------------------
  // Start / stop
  // ----------------------------------------------------------------------------------------------
  async function start() {
    if (st.running) return;
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("This browser cannot share a tab. Chrome or Edge on a computer can.");
    setPhase("asking", "Choose “This tab” and press Share.");
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // ask for full resolution: without it Chrome delivers the tab at about CSS size (800 px on a Retina screen in test V)
      video: { frameRate: { ideal: 10, max: 15 }, width: { ideal: 3840 }, height: { ideal: 2160 }, displaySurface: "browser" }, audio: false,
      preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "exclude", monitorTypeSurfaces: "exclude",
    });
    const [track] = stream.getVideoTracks();
    st.stream = stream; st.mode = "tab";
    const el = iframe();
    // Element Capture first (only the iframe's pixels), then Region Capture, else the whole tab + own crop
    try { if (window.RestrictionTarget && track.restrictTo && el) { await track.restrictTo(await window.RestrictionTarget.fromElement(el)); st.mode = "element"; } } catch (e) { console.warn("Element Capture not possible", e); }
    try { if (st.mode === "tab" && window.CropTarget && track.cropTo && el) { await track.cropTo(await window.CropTarget.fromElement(el)); st.mode = "region"; } } catch (e) { console.warn("Region Capture not possible", e); }
    const surface = track.getSettings?.().displaySurface;
    if (st.mode === "tab" && surface && surface !== "browser") { stopStream(); throw new Error("Please share this browser tab (not a window or the whole screen)."); }
    track.addEventListener("ended", () => stop("Sharing ended."));
    st.video = Object.assign(document.createElement("video"), { muted: true, playsInline: true, srcObject: stream });
    await st.video.play();
    R.mode = st.mode; R.at = new Date().toISOString();
    st.running = true;
    setPhase("loading", "Loading the models on your device…");
    try {
      // the same files as the live scanner (browser cache after the first visit) + the COCO detector (9 MB)
      // one after the other: ONNX Runtime initialises its WebAssembly backend once, and two sessions created at the same
      // moment fail with "multiple calls to initWasm()" (seen in test V on a fresh page)
      await ensureOrt();
      const finder = await loadFinder(), coco = await loadCoco();
      await loadOcr(); await loadBrands(); await loadBrandModel(); await loadTypeBank();
      st.models = { finder, coco };
    } catch (e) { stop(`Models could not be loaded (${e.message}).`); return; }
    if (!st.running) return;
    setPhase("running", "");
    loop();
  }

  function stopStream() { st.stream?.getTracks().forEach((t) => t.stop()); st.stream = null; }
  function stop(msg = "") {
    const was = st.running; st.running = false; stopStream();
    if (st.video) { st.video.srcObject = null; st.video = null; }
    st.live.clear(); st.unclaimed.clear(); st.found.clear(); TS.tracks = []; TS.lost = []; st.links.clear();
    setPhase(was || msg ? "done" : "idle", msg); save();
  }
  function setPhase(phase, msg) { st.phase = phase; st.msg = msg; onChange(api); }

  // ----------------------------------------------------------------------------------------------
  // Frame loop
  // ----------------------------------------------------------------------------------------------
  async function loop() {
    while (st.running) {
      const t = time(), isPlaying = playing();
      const fk = Math.round(t * 4) / 4; // one check per quarter second of video
      if (st.video?.videoWidth && (isPlaying || fk !== st.lastFrameKey)) {
        // paused: wait until the captured picture shows the new position (the player needs a moment after a seek)
        if (!isPlaying && st.pausedAt !== fk) { st.pausedAt = fk; await sleep(450); continue; }
        const t0 = performance.now();
        try { await checkFrame(time()); } catch (e) { console.warn("verify frame failed", e); }
        st.ms = Math.round(performance.now() - t0); st.lastFrameKey = fk;
        onChange(api);
      }
      await sleep(isPlaying ? 40 : 200);
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Copy the current captured picture of the player into `frame` (W×H). False if nothing usable. */
  function grab() {
    const v = st.video, vw = v.videoWidth, vh = v.videoHeight;
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (st.mode === "tab") {
      // whole tab: cut out the iframe; captured pixels per CSS pixel = capture width / viewport width
      const r = iframe()?.getBoundingClientRect(); if (!r) return false;
      const k = vw / window.innerWidth;
      if (Math.abs(vh / k - window.innerHeight) > window.innerHeight * 0.06) return false; // not this tab (or zoomed)
      sx = Math.max(0, r.left * k); sy = Math.max(0, r.top * k); sw = Math.min(vw - sx, r.width * k); sh = Math.min(vh - sy, r.height * k);
      if (sw < 64 || sh < 36) return false; // player scrolled out of view
    }
    const s = Math.min(1, 1600 / sw); // OCR detects at 960 px, the detectors at 320/512 px – the zoomed second pass profits from more
    W = frame.width = Math.round(sw * s); H = frame.height = Math.round(sh * s);
    fctx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
    return true;
  }

  async function checkFrame(t) {
    if (!grab()) { st.msg = "The player is not in view – scroll it back into the window."; return; }
    st.msg = "";
    const now = performance.now();
    const { finder, coco } = st.models;
    // 1. both detectors; boxes of the same object from the two vocabularies are merged (names joined with "|")
    const a = await detect(finder, frame, W, H), c = await detect(coco, frame, W, H, { keep: (n) => n !== "person", minE2e: 0.3 });
    const boxes = [];
    for (const b of [...a, ...c].sort((x, y) => y.score - x.score)) {
      const same = boxes.find((k) => iou(k, b) > 0.6);
      if (same) { if (!same.name.split("|").includes(b.name)) same.name += `|${b.name}`; } else boxes.push({ ...b });
    }
    // b) tiled pass for small things (see TILE_* above); a box cut by an inner tile edge is dropped (the neighbour tile
    //    sees that object whole), a tile box that the full-frame pass already has is merged into it
    const tiles = tileRects(W, H), paused = !playing();
    const todo = paused ? tiles.map((_, i) => i) : st.ms < TILE_MAX_MS ? [st.tile++ % tiles.length] : [];
    const tt0 = performance.now();
    for (const i of todo) {
      const r = tiles[i];
      zc.width = r.w; zc.height = r.h; zctx.drawImage(frame, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      const got = [...await detect(finder, zc, r.w, r.h), ...await detect(coco, zc, r.w, r.h, { keep: (n) => n !== "person", minE2e: 0.3 })];
      for (const q of got) {
        const e = 3; // px from an inner tile edge = cut
        if ((q.x1 < e && r.x > 0) || (q.y1 < e && r.y > 0) || (q.x2 > r.w - e && r.x + r.w < W) || (q.y2 > r.h - e && r.y + r.h < H)) continue;
        const b = { ...q, x1: q.x1 + r.x, x2: q.x2 + r.x, y1: q.y1 + r.y, y2: q.y2 + r.y, tile: true };
        const same = boxes.find((k) => iou(k, b) > 0.5);
        if (same) { if (!same.name.split("|").includes(b.name)) same.name += `|${b.name}`; } else boxes.push(b);
      }
    }
    if (todo.length) { st.tileMs = Math.round(performance.now() - tt0); st.tilesRun = (st.tilesRun || 0) + todo.length; st.tileBoxes = boxes.filter((b) => b.tile).length; }
    for (const b of boxes) b.hist = histogram(frame, b);
    updateTracks(TS, boxes, now); placeTracks(TS, now, true);
    const fresh = TS.tracks.filter((x) => x.seen === now);
    const classes = (x) => String(x.name || "").split("|");

    // 2. OCR on the whole frame (every frame while paused, every 1.2 s while playing)
    let words = null;
    if (!playing() || now - st.lastOcr > OCR_EVERY_MS) { st.lastOcr = now; words = await readText(frame, W, H); }
    const cands = words ? textCandidates(words) : null;

    const here = covering(t), fk = Math.round(t * 4) / 4, newFrame = fk !== st.lastFrameKey;
    if (newFrame) R.frames++;
    const k3 = playing() ? 1 : PAUSED_FACTOR; let owns = 0, zss = 0, zooms = 0;
    /** Both detectors on a magnified region around a box (≥ 3× its size, ≥ 35 % of the frame) → boxes in frame pixels. */
    const zoomCache = new Map();
    const zoomDetect = async (b) => {
      const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
      const rw = Math.min(W, Math.max(3 * (b.x2 - b.x1), 0.35 * W)), rh = Math.min(H, Math.max(3 * (b.y2 - b.y1), 0.35 * H));
      const x0 = Math.round(Math.max(0, Math.min(W - rw, cx - rw / 2))), y0 = Math.round(Math.max(0, Math.min(H - rh, cy - rh / 2)));
      const key = `${x0},${y0},${Math.round(rw)},${Math.round(rh)}`; if (zoomCache.has(key)) return zoomCache.get(key);
      zc.width = Math.round(rw); zc.height = Math.round(rh); zctx.drawImage(frame, x0, y0, rw, rh, 0, 0, zc.width, zc.height);
      const out = [...await detect(finder, zc, zc.width, zc.height), ...await detect(coco, zc, zc.width, zc.height, { keep: (n) => n !== "person", minE2e: 0.3 })]
        .map((q) => ({ ...q, x1: q.x1 + x0, x2: q.x2 + x0, y1: q.y1 + y0, y2: q.y2 + y0 }));
      zoomCache.set(key, out); return out;
    };
    const linked = new Set();
    /** Is `type` among the best 5 types of this box? (MobileCLIP fingerprint, cached per box and type) null = no budget. */
    const typeOk = async (x, type) => {
      x.typeOk ||= {}; if (type.label in x.typeOk) return x.typeOk[type.label];
      if (!x.emb) { if (zss >= ZS_PER_FRAME * k3) return null; zss++; x.emb = await embedBox(frame, x, W, H); }
      if (!x.emb) return (x.typeOk[type.label] = false);
      const ranked = await rankTypes(x.emb);
      return (x.typeOk[type.label] = ranked.findIndex(([n]) => type.zs.includes(n)) < 5);
    };
    for (const p of here) {
      const r = rec(p.key), est = estimate(p, t), ev = [];
      const near = (x) => (est ? iou(x, toPx(est.box, W, H)) - kDist(toK(x, W, H), est.box) / 100 : area(x) / (W * H));
      let foundBox = null, track = null;
      // text: brand or model name written in the frame
      if (cands) {
        const hit = cands.find((w) => p.keys.some((k) => w.key === k || (k.length >= 4 && w.key.includes(k)) || (k.length >= 5 && lev(w.key, k, 1) <= 1)));
        if (hit) { ev.push("text"); if (!r.read.includes(hit.text) && r.read.length < 5) r.read.push(hit.text); track = fresh.find((x) => inside(hit, x) > 0.6) || null; if (!track) foundBox = hit; }
      }
      // look: the own model recognises the brand on one of the boxes (only brands it was trained on)
      if (knowsBrand(p.brand)) {
        for (const x of fresh.filter((x) => !x.ownAt || now - x.ownAt > 1500).sort((m, n) => area(n) - area(m)).slice(0, 2)) {
          if (owns >= OWN_PER_FRAME * k3) break;
          x.ownAt = now; owns++;
          const res = await classifyBox(frame, x, W, H);
          if (res) { x.emb = res.emb; x.own = res.sure ? res.brand : null; }
        }
        const x = fresh.find((x) => x.own && brandKey(x.own) === brandKey(p.brand));
        if (x) { ev.push("look"); track ||= x; }
      }
      // object: a detector box of the expected type (closest to Gemini's estimate if there are several)
      // A box far away from Gemini's estimate (picture frames on the wall look like "tv" to COCO) only counts if the type
      // check on that box agrees as well (expected type among the best 5) – near the estimate the class alone is enough.
      if (p.type?.det.length) {
        const pool = fresh.filter((x) => classes(x).some((n) => p.type.det.includes(n)));
        for (const x of [...pool].sort((m, n) => near(n) - near(m))) {
          if (est && iou(x, toPx(est.box, W, H)) >= 0.1) { ev.push("object"); track ||= x; break; }
          const ok = await typeOk(x, p.type); if (ok == null) break; // budget for this frame used up
          if (ok) { ev.push("object"); track ||= x; break; }
        }
        // nothing in the whole frame: look again, magnified, around Gemini's position – a keyboard or phone in a wide
        // shot is only ~10 px tall for a 320 px detector (test V: missed at JB 3:22–3:30 without this)
        if (!ev.includes("object") && est && zooms < ZOOM_PER_FRAME * k3) {
          zooms++;
          const hit = closest((await zoomDetect(toPx(est.box, W, H))).filter((b) => b.name.split("|").some((n) => p.type.det.includes(n))), est, W, H);
          if (hit) { ev.push("object"); foundBox ||= hit; }
        }
      }
      // type (zero-shot): MobileCLIP fingerprint of a nearby box, else of Gemini's position, against ~90 types
      let zsTop = null;
      if (!ev.length && p.type?.zs.length && zss < ZS_PER_FRAME * k3) {
        const near = est ? fresh.filter((x) => !linked.has(x.id) && (iou(x, toPx(est.box, W, H)) > 0.1 || centreIn(x, toPx(est.box, W, H)))).sort((m, n) => iou(n, toPx(est.box, W, H)) - iou(m, toPx(est.box, W, H))).slice(0, 2) : [];
        const tries = [...near.map((x) => ({ x, b: x })), ...(est ? [{ x: null, b: atLeast(pad(toPx(est.box, W, H), 0.1, W, H), 64, W, H) }] : [])];
        for (const { x, b } of tries) {
          if (zss >= ZS_PER_FRAME * k3) break;
          const e = x?.emb || await embedBox(frame, b, W, H); if (!x?.emb) zss++;
          if (!e) continue;
          if (x) x.emb = e;
          const ranked = await rankTypes(e), pos = ranked.findIndex(([n]) => p.type.zs.includes(n));
          if (!zsTop || pos < zsTop.pos) zsTop = { pos: pos + 1, top: ranked.slice(0, 3).map(([n, c]) => `${n} ${c.toFixed(3)}`), on: x ? "box" : "estimate" };
          if (pos >= 0 && pos < ZS_TOP) { ev.push("type"); if (x) track ||= x; break; } // at Gemini's position: evidence, but no measured box
        }
      }
      // evidence found earlier on a box that the tracker still follows → it still shows where the product is
      const prev = st.links.get(p.key), prevTrack = prev != null ? TS.tracks.find((x) => x.id === prev) : null;
      if (!track && !foundBox && prevTrack && prevTrack.seen === now) track = prevTrack;
      if (track) { st.links.set(p.key, track.id); linked.add(track.id); }

      if (newFrame) { r.checks++; if (ev.length) r.hits++; for (const e of ev) r.how[e] = (r.how[e] || 0) + 1; st.log.push([Math.round(t * 100) / 100, p.brand, ev.join("+")]); }
      r.checkable = canMiss(p, knowsBrand(p.brand)); // remembered: the own model may not be loaded on a later visit
      // measured box of this frame (a detector box carrying evidence, or the text itself) – not Gemini's position
      const mbox = track ? { x1: track.x1, y1: track.y1, x2: track.x2, y2: track.y2 } : foundBox;
      const k = mbox ? toK(mbox, W, H) : null;
      if (k && newFrame) {
        r.meas.push([Math.round(t * 100) / 100, ...k]); if (r.meas.length > STORE_MAX) r.meas.splice(0, r.meas.length - STORE_MAX);
        if (est && est.dt <= 3) r.dev.push([Math.round(t * 100) / 100, Math.round(kIou(k, est.box) * 100) / 100, Math.round(kDist(k, est.box) * 10) / 10]);
      }
      st.live.set(p.key, { t, ev, trackId: track?.id ?? null, box: k, zs: zsTop });
    }
    for (const key of st.live.keys()) if (!here.some((p) => p.key === key)) st.live.delete(key);

    // 3. on screen, but the analysis has no appearance at this second: a detector box whose type matches a product of
    //    this video (e.g. the backpack lying on the table at MKBHD 6:10). Shown as a hint, never counted as a finding.
    st.unclaimed.clear();
    for (const x of fresh) {
      if (linked.has(x.id) || (x.hits || 0) < 2) continue;
      const cands2 = apps.filter((p) => p.type?.det.some((n) => classes(x).includes(n)) && !here.includes(p));
      const brands = [...new Map(cands2.map((p) => [p.brand, p])).values()];
      if (brands.length && !here.some((p) => p.type && brands.some((q) => q.type === p.type))) {
        const label = brands[0].type.label;
        st.unclaimed.set(`${label}`, { label, box: toK(x, W, H), brands: brands.map((p) => ({ brand: p.brand, product: p.product, at: apps.filter((q) => q.brand === p.brand).map((q) => q.a.start_s) })) });
      }
    }

    // 4. c) found on screen: brands our models are sure about where Gemini lists no such brand at this second
    //    (any channel). Evidence: OCR reads a brand of the brand list (exact spelling, ≥ 4 letters), or the own brand
    //    model is sure about a box no Gemini product claimed. Counted per frame; shown from FOUND_MIN frames on.
    const listedNow = new Set((data.brands || []).filter((b) => (b.appearances || []).some((a) => t >= a.start_s - 1.5 && t <= a.end_s + 1.5)).map((b) => brandKey(b.brand)));
    const listedAll = new Set((data.brands || []).map((b) => brandKey(b.brand)));
    const finds = new Map();
    if (cands && words) for (const m of matchBrands(words)) {
      if (!m.exact || m.key.length < 4 || m.score < 0.8 || listedNow.has(m.key)) continue;
      finds.set(m.key, { brand: m.brand, how: "text", read: m.read, box: { x1: m.x1, y1: m.y1, x2: m.x2, y2: m.y2 } });
    }
    let scans = 0;
    for (const x of fresh.filter((x) => !linked.has(x.id) && (!x.ownAt || now - x.ownAt > 1500)).sort((m, n) => area(n) - area(m))) {
      if (scans >= OWN_SCAN * k3) break;
      scans++; x.ownAt = now;
      const res = await classifyBox(frame, x, W, H);
      if (res) { x.emb = res.emb; x.own = res.sure ? res.brand : null; }
    }
    for (const x of fresh) {
      if (!x.own || linked.has(x.id)) continue;
      const k = brandKey(x.own); if (listedNow.has(k)) continue;
      if (!finds.has(k)) finds.set(k, { brand: x.own, how: "look", box: x, trackId: x.id });
    }
    st.found.clear();
    for (const [k, f] of finds) {
      const g = (R.found[k] ||= { brand: f.brand, ts: [], how: {}, read: [], listed: listedAll.has(k) });
      if (newFrame && !g.ts.includes(fk)) { g.ts.push(fk); g.how[f.how] = (g.how[f.how] || 0) + 1; if (g.ts.length > STORE_MAX) g.ts.shift(); }
      if (f.read && !g.read.includes(f.read) && g.read.length < 5) g.read.push(f.read);
      g.box = toK(f.box, W, H); g.boxT = fk;
      st.found.set(k, { ...f, box: toK(f.box, W, H) });
    }
    save();
  }

  // ----------------------------------------------------------------------------------------------
  // Read-outs for the UI
  // ----------------------------------------------------------------------------------------------
  function statusOfRec(p) {
    const r = R.apps[p.key];
    const checkable = r?.checkable ?? canMiss(p, knowsBrandSafe(p.brand));
    if (!r || !r.checks) return { status: "unchecked", checks: 0, hits: 0, checkable };
    const share = r.hits / r.checks, how = r.how || {};
    // strongest kind of evidence first: brand read > brand by look > object found by a detector > type (zero-shot)
    const kind = how.text ? "text" : how.look ? "look" : how.object ? "object" : how.type ? "type" : null;
    const status = r.hits >= MIN_HITS && share >= HIT_SHARE ? "confirmed"
      : r.checks >= MIN_CHECKS && share < HIT_SHARE ? (checkable ? "not_seen" : "not_checkable")
      : !checkable && r.checks >= 2 && !r.hits ? "not_checkable" : "checking";
    return { status, checks: r.checks, hits: r.hits, kind, read: r.read, checkable };
  }
  const knowsBrandSafe = (b) => { try { return knowsBrand(b); } catch { return false; } };

  const api = {
    get running() { return st.running; },
    get phase() { return st.phase; },
    get message() { return st.msg; },
    get mode() { return st.mode; },
    get frames() { return R.frames; },
    get msPerFrame() { return st.ms; },
    get hasResults() { return Object.keys(R.apps).length > 0; },
    start, stop,
    /** Status of the appearance(s) of a brand that cover t (Right now). `now`: evidence in the latest checked frame. */
    statusAt(brand, t) {
      const ps = covering(t).filter((p) => p.brand === brand); if (!ps.length) return null;
      const best = ps.map((p) => ({ ...statusOfRec(p), now: st.running ? st.live.get(p.key)?.ev.length > 0 : null })).sort((x, y) => RANK[y.status] - RANK[x.status])[0];
      return best;
    },
    /** All appearances of a brand together (Products cards). */
    brandSummary(brand) {
      const ps = apps.filter((p) => p.brand === brand); const out = { confirmed: 0, not_seen: 0, not_checkable: 0, checking: 0, unchecked: 0, frames: 0, hits: 0, kinds: new Set(), read: new Set(), total: ps.length };
      for (const p of ps) { const s = statusOfRec(p); out[s.status]++; out.frames += s.checks; out.hits += s.hits; if (s.kind) out.kinds.add(s.kind); (s.read || []).forEach((x) => out.read.add(x)); }
      return out;
    },
    /** Measured boxes at t: live (tracker, follows the product) while verifying, else the stored keyframes. */
    measuredAt(t) {
      const out = st.running ? [...st.unclaimed.values()].map((u) => ({ key: `only:${u.label}`, brand: u.brands[0].brand, label: u.label.charAt(0).toUpperCase() + u.label.slice(1), box: u.box, live: true, only: true })) : [];
      // c) brands found on screen by our models where Gemini lists none (grey dashed like "on screen only", labelled with the brand)
      if (st.running) for (const [k, f] of st.found) out.push({ key: `found:${k}`, brand: f.brand, label: f.brand, box: f.box, live: true, only: true, found: true });
      for (const p of covering(t)) {
        const live = st.running ? st.live.get(p.key) : null;
        if (live?.trackId != null) {
          placeTracks(TS, performance.now(), playing());
          const x = TS.tracks.find((q) => q.id === live.trackId);
          if (x && W) { out.push({ key: p.key, brand: p.brand, product: p.product, box: toK(x, W, H), live: true }); continue; }
        }
        if (live?.box) { out.push({ key: p.key, brand: p.brand, product: p.product, box: live.box, live: true }); continue; }
        // the current frame was checked and the product was not located in it → no box (a stored one could be from
        // before a cut: test V, JB 3:25 close-up showed the orchid box of the wide shot at 3:22)
        if (live && Math.abs(live.t - t) < 1.5) continue;
        const m = R.apps[p.key]?.meas; if (!m?.length) continue;
        // replay: interpolate between stored keyframes up to 1 s apart, hold ±0.5 s around a single one
        const i = m.findIndex((k) => k[0] > t), a = m[i - 1], b = m[i];
        let box = null;
        // (a frame is checked about every 0.5–2.5 s): glide between keyframes ≤ 3 s apart whose boxes overlap (the product
        // stayed put), otherwise hold the nearest one for up to 1.5 s – the same idea as Gemini's keyframes in tracking.js
        if (a && b && b[0] - a[0] <= 3 && kIou(a.slice(1), b.slice(1)) >= 0.3) { const f = (t - a[0]) / Math.max(0.01, b[0] - a[0]); box = a.slice(1).map((v, j) => v + (b[j + 1] - v) * f); }
        else { const n = [a, b].filter(Boolean).sort((x, y) => Math.abs(x[0] - t) - Math.abs(y[0] - t))[0]; if (n && Math.abs(n[0] - t) <= 1.5) box = n.slice(1); }
        if (box) out.push({ key: p.key, brand: p.brand, product: p.product, box, live: false });
      }
      return out;
    },
    /** Products on screen that the analysis does not list at this second (only while verifying). */
    unclaimedAt() { return st.running ? [...st.unclaimed.values()] : []; },
    /** c) Brands found on screen by our models at t that Gemini does not list then (≥ FOUND_MIN frames in total). */
    foundAt(t) {
      return foundList(R).filter((f) => f.spans.some(([a, b]) => t >= a - 0.75 && t <= b + 0.75))
        .map((f) => ({ ...f, now: st.running ? st.found.has(brandKey(f.brand)) : null, box: st.found.get(brandKey(f.brand))?.box || (Math.abs((R.found[brandKey(f.brand)]?.boxT ?? -99) - t) < 1 ? R.found[brandKey(f.brand)].box : null) }));
    },
    /** c) All brands found on screen (Products, Media value, Brand report). */
    found: () => foundList(R),
    /** b) tile pass numbers (status line, tests) */
    tileStats: () => ({ tilesRun: st.tilesRun || 0, lastMs: st.tileMs || 0, boxes: st.tileBoxes || 0 }),
    /** Totals for the status line and EVALUATION.md: statuses, deviation measured vs. estimated. */
    summary() {
      const s = { confirmed: 0, not_seen: 0, not_checkable: 0, checking: 0, unchecked: 0, frames: R.frames };
      const dev = [];
      for (const p of apps) { s[statusOfRec(p).status]++; dev.push(...(R.apps[p.key]?.dev || [])); }
      s.checked = apps.length - s.unchecked;
      s.dev = { n: dev.length, iou: median(dev.map((d) => d[1])), dist: median(dev.map((d) => d[2])) };
      return s;
    },
    /** Raw results (tests). */
    results: () => ({ R, found: foundList(R), tiles: { tilesRun: st.tilesRun || 0, lastMs: st.tileMs || 0 }, log: st.log, apps: apps.map((p) => ({ key: p.key, brand: p.brand, product: p.product, type: p.type?.label || null, ...statusOfRec(p), zs: st.live.get(p.key)?.zs || null })) }),
    /** Status of the appearance of a brand at t only (tracking.js dims Gemini's box when it is "not seen"). */
    statusOf(brand, t) { return api.statusAt(brand, t)?.status || null; },
    /** The last captured frame as JPEG (tests: what the models saw, without any overlay). */
    frameImage: () => (W ? frame.toDataURL("image/jpeg", 0.88) : null),
    destroy() { stop(); },
  };
  return api;
}
const RANK = { confirmed: 4, not_seen: 3, not_checkable: 2, checking: 1, unchecked: 0 };
/**
 * Can our models say "not seen" about this product, i.e. would they normally have found it if it were there?
 * Yes for a detector class (monitor, keyboard, backpack …), for a PACKAGE of a brand the own model knows, and when
 * Gemini says the brand is written in the picture (OCR). No for products only the type check covers (Mac mini,
 * speaker, light bar …): that check runs at Gemini's position, which is often wrong – finding nothing there proves
 * nothing, so those stay "not checkable" unless the type check confirms them (test V: 3 wrong "not seen" → 1).
 */
const canMiss = (p, ownKnows) => !!(p.type?.det.length || (ownKnows && (!p.type || p.type.label === "package")) || p.basis === "text");

// ------------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------------
const area = (b) => (b.x2 - b.x1) * (b.y2 - b.y1);
const inside = (w, x) => (Math.max(0, Math.min(x.x2, w.x2) - Math.max(x.x1, w.x1)) * Math.max(0, Math.min(x.y2, w.y2) - Math.max(x.y1, w.y1))) / (area(w) + 1e-6);
const centreIn = (x, b) => { const cx = (x.x1 + x.x2) / 2, cy = (x.y1 + x.y2) / 2; return cx >= b.x1 && cx <= b.x2 && cy >= b.y1 && cy <= b.y2; };
/** Grow a box around its centre to at least `min` px per side (tiny Gemini boxes: MobileCLIP needs some context). */
const atLeast = (b, min, W, H) => { const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2, w = Math.max(min, b.x2 - b.x1), h = Math.max(min, b.y2 - b.y1); return { x1: Math.max(0, cx - w / 2), y1: Math.max(0, cy - h / 2), x2: Math.min(W, cx + w / 2), y2: Math.min(H, cy + h / 2) }; };
const pad = (b, k, W, H) => { const pw = (b.x2 - b.x1) * k, ph = (b.y2 - b.y1) * k; return { x1: Math.max(0, b.x1 - pw), y1: Math.max(0, b.y1 - ph), x2: Math.min(W, b.x2 + pw), y2: Math.min(H, b.y2 + ph) }; };
/** Detector box closest to Gemini's estimate (overlap, minus centre distance); without an estimate the biggest one. */
function closest(pool, est, W, H) {
  if (!pool.length) return null;
  if (!est) return [...pool].sort((a, b) => area(b) - area(a))[0];
  const score = (x) => { const k = toK(x, W, H); return kIou(k, est.box) - kDist(k, est.box) / 100; };
  return pool.reduce((best, x) => (score(x) > score(best) ? x : best));
}

/** OCR words → candidate strings: single words and two neighbouring words on the same line ("Key"+"chron"). */
function textCandidates(words) {
  const out = words.map((w) => ({ ...w, key: brandKey(w.text) }));
  for (const a of words) for (const b of words) {
    if (a === b) continue;
    const ah = a.y2 - a.y1, bh = b.y2 - b.y1, vo = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
    if (vo > 0.5 * Math.min(ah, bh) && b.x1 >= a.x1 && b.x1 - a.x2 < 1.2 * Math.max(ah, bh)) {
      out.push({ text: `${a.text} ${b.text}`, key: brandKey(a.text + b.text), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) });
    }
  }
  return out.filter((w) => w.key.length >= 2);
}

// ------------------------------------------------------------------------------------------------
// b) tiles · c) found on screen
// ------------------------------------------------------------------------------------------------
/** TILE_GRID × TILE_GRID overlapping tiles covering the frame. */
function tileRects(W, H) {
  const n = TILE_GRID, tw = Math.round(W / (n - (n - 1) * TILE_OVERLAP)), th = Math.round(H / (n - (n - 1) * TILE_OVERLAP)), out = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) out.push({ x: Math.min(W - tw, Math.round(c * tw * (1 - TILE_OVERLAP))), y: Math.min(H - th, Math.round(r * th * (1 - TILE_OVERLAP))), w: tw, h: th });
  return out;
}

/**
 * Stored finds → [{brand, frames, spans: [[start, end]…] (s), seconds, how: {text, look}, read, listed}], only brands found
 * on ≥ FOUND_MIN frames. Frames ≤ 3 s apart form one span (a frame is checked every ~0.5–2.5 s); a lone frame counts ±0.5 s.
 * `listed`: Gemini names this brand elsewhere in the video (then it is NOT added to the media value – no double count).
 */
function foundList(R) {
  return Object.values(R.found || {}).filter((g) => g.ts.length >= FOUND_MIN).map((g) => {
    const ts = [...g.ts].sort((a, b) => a - b), spans = [];
    for (const t of ts) { const l = spans[spans.length - 1]; if (l && t - l[1] <= 3) l[1] = t; else spans.push([t, t]); }
    const sp = spans.map(([a, b]) => [Math.max(0, a - 0.5), b + 0.5]);
    return { brand: g.brand, frames: ts.length, spans: sp, seconds: sp.reduce((n, [a, b]) => n + b - a, 0), how: g.how, read: g.read, listed: g.listed };
  }).sort((a, b) => b.frames - a.frames);
}

/** Read-only results of an earlier Verify on screen in this tab (Media value, Brand report: no player there). */
export function storedVerify(id) {
  try { const R = JSON.parse(sessionStorage.getItem(`verify:${id}`) || "null"); return R ? { R, found: foundList(R) } : null; } catch { return null; }
}
