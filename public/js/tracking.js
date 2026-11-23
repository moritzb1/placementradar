/**
 * tracking.js — "Show tracking": labelled boxes over the YouTube player that follow the products.
 *
 * Where the boxes come from: the browser cannot look into the YouTube player (cross-origin iframe), so every box
 * is a position Gemini reported while watching the video. Since 21 Nov the prompt asks for keyframes about every
 * 2–3 s per visual appearance (`appearance.track`, see shared/prompts.js); older analyses only have one box per
 * appearance (`brand.frames`). Between two keyframes the box is interpolated, before the first / after the last
 * it is held. Since 21 Nov each box has an honesty level (see boxesAt): solid only near a reported position, dashed
 * "approx. position" up to 3 s away, otherwise just a point; no gliding across the picture between distant keyframes.
 *
 * Timing: the player reports its time only every 250 ms, so while it plays the overlay extrapolates the clock
 * per animation frame (requestAnimationFrame) and re-syncs on every report.
 *
 * Measured boxes (23 Nov, verify.js "Verify on screen"): where our own detectors found the product on the real frames,
 * drawn solid with the tag MEASURED; Gemini's box for the same product is then shown thin and dashed as "Gemini estimate".
 *
 * Used by app.js (Products view). Visual style shared with the live scanner (live.js `draw`): rounded box,
 * dark glass label with a coloured dot, name in bold, model and recognition basis after it.
 */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const BASIS = { logo: "logo", text: "text", speech: "speech", design: "design" };
// Honesty levels (21 Nov, after boxes were seen next to the product): Gemini's positions in a video are approximate
// (it samples 1 frame/s and reports ~every 4 s), so a box is only drawn as "located" where a reported position is close.
const LOCATED_S = 1.5;     // within this distance of a keyframe → solid box
const NEAR_S = 3;          // within this distance → dashed box, label "approx. position"
const GLIDE_MAX_S = 5;     // interpolate (glide) only between keyframes at most this far apart …
const GLIDE_MIN_IOU = 0.3; // … whose boxes overlap this much (the product barely moved) – otherwise hold the nearest one
const MIN_CONF = 0.6;      // below this confidence Gemini's position is never drawn as a box, only as a point
const EDGE_S = 0.4;        // fade in/out around the appearance edges
const RANK = { box: 2, approx: 1, point: 0 };

const iou = (a, b) => {
  const h = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), w = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - h * w;
  return u > 0 ? (h * w) / u : 0;
};

/**
 * Collect what to draw at time t: [{key, brand, product, basis, box, level, fade}], level = box | approx | point.
 *   box    – a reported position within 1.5 s, or a glide between two close, overlapping keyframes
 *   approx – within 3 s of a reported position (dashed, "approx. position")
 *   point  – further away or low confidence: only a dot at the last known centre, no box
 * One entry per product: if a "Look closer" appearance and the main analysis both cover t, the better level wins.
 */
export function boxesAt(data, t) {
  const best = new Map();
  for (const b of trackables(data)) {
    b.appearances.forEach((ap, i) => {
      if (ap.channel !== "visual" || t < ap.start_s - EDGE_S || t > ap.end_s + EDGE_S) return;
      // re-check span whose position did not pass the plausibility filter (normalize.js filterRecheckSpans): no box at all
      if (ap.no_box) return;
      // new data: own keyframes; old data: the brand's frames that fall inside this appearance
      const keys = ap.track?.length ? ap.track : (b.frames || []).filter((f) => f.t >= ap.start_s - 1 && f.t <= ap.end_s + 1).sort((x, y) => x.t - y.t);
      if (!keys.length) return;
      let box, dist, glide = false;
      const n = keys.findIndex((k) => k.t > t);
      if (n === 0) { box = keys[0].box; dist = keys[0].t - t; }
      else if (n === -1) { const k = keys[keys.length - 1]; box = k.box; dist = t - k.t; }
      else {
        const a = keys[n - 1], c = keys[n];
        dist = Math.min(t - a.t, c.t - t);
        if (c.t - a.t <= GLIDE_MAX_S && iou(a.box, c.box) >= GLIDE_MIN_IOU) {
          const f = (t - a.t) / Math.max(0.01, c.t - a.t), e = f * f * (3 - 2 * f); // smoothstep: no jerk at the keyframes
          box = a.box.map((v, j) => v + (c.box[j] - v) * e); glide = true;
        } else box = (t - a.t <= c.t - t ? a : c).box; // a jump (cut, product moved): no slide across the picture
      }
      const conf = Number.isFinite(ap.confidence) ? ap.confidence : 1;
      const level = conf < MIN_CONF ? "point" : dist <= LOCATED_S || glide ? "box" : dist <= NEAR_S ? "approx" : "point";
      const fade = Math.max(0, Math.min(1, (t - (ap.start_s - EDGE_S)) / EDGE_S, ((ap.end_s + EDGE_S) - t) / EDGE_S));
      const item = { key: `${b.brand}#${i}`, brand: b.brand, product: modelFor(b, ap), basis: b.unid ? "no brand" : ap.basis || "", box, level, approx: level !== "box", fade, closer: !!ap.closer };
      const id = `${b.unid ? "u:" : ""}${b.brand}`, prev = best.get(id);
      if (!prev || RANK[level] > RANK[prev.level] || (RANK[level] === RANK[prev.level] && item.closer && !prev.closer)) best.set(id, item);
    });
  }
  return [...best.values()];
}

/** Brands plus unidentified products (label = category, e.g. "Smartwatch · NO BRAND", grey). */
function trackables(data) {
  const cap = (x) => String(x || "").charAt(0).toUpperCase() + String(x || "").slice(1);
  return [...data.brands, ...(data.unidentified || []).map((u) => ({ brand: cap(u.category), unid: true,
    products: u.guess ? [`(possible: ${u.guess})`] : [], appearances: u.appearances, frames: [] }))];
}

/** The model shown in the label: the appearance's own product (analyses since 22 Nov), else the one named in its
 *  evidence, else the brand's first model. */
function modelFor(b, ap) {
  if (ap.product) return ap.product;
  const list = b.products?.length ? b.products : b.product ? [b.product] : [];
  const ev = (ap.evidence || "").toLowerCase();
  const hit = list.find((p) => ev.includes(p.toLowerCase()) || ev.includes(p.toLowerCase().replace(b.brand.toLowerCase(), "").trim()));
  return hit || list[0] || "";
}

/** Full label text, e.g. "Bose QuietComfort Ultra" (the model often repeats the brand). */
export const labelText = (brand, product) => !product ? brand : product.toLowerCase().startsWith(brand.toLowerCase()) ? product : `${brand} ${product}`;

/**
 * @param {HTMLElement} host  the .player element (position: relative)
 * @param {object} data       the analysis
 * @param {(brand:string)=>string} color brand colour
 */
export function createTracking(host, data, color) {
  const layer = document.createElement("div");
  layer.className = "track-layer"; layer.setAttribute("aria-hidden", "true");
  host.append(layer);
  const els = new Map();
  let on = false, baseT = 0, baseWall = performance.now(), playing = false, raf = 0, measured = null, verdict = null, hidden = false;

  const now = () => playing ? baseT + Math.min(0.6, (performance.now() - baseWall) / 1000) : baseT;

  function render() {
    const t = now(); const seen = new Set();
    // measured boxes first (verify.js); their brands' Gemini boxes become "estimate"
    const meas = on && !hidden && measured ? measured(t) : [];
    const measBrands = new Set(meas.filter((m) => !m.only).map((m) => m.brand));
    for (const m of meas) {
      const key = `m:${m.key}`; seen.add(key);
      let el = els.get(key);
      if (!el) {
        // "on screen only": our detector sees a product type of this video where Gemini lists nothing (grey, dashed)
        el = document.createElement("div"); el.className = `tbox measured${m.only ? " only" : ""}`;
        el.style.setProperty("--c", m.only ? "#8e8e93" : color(m.brand));
        el.innerHTML = m.only ? `<span class="tb-label"><i></i><b>${esc(m.label)}</b><em class="tb-meas">on screen only</em></span>`
          : `<span class="tb-label"><i></i><b>${esc(labelText(m.brand, m.product))}</b><em class="tb-meas">measured</em></span>`;
        layer.append(el); els.set(key, el);
      }
      const [y0, x0, y1, x1] = m.box;
      el.style.left = `${x0 / 10}%`; el.style.top = `${y0 / 10}%`; el.style.width = `${(x1 - x0) / 10}%`; el.style.height = `${(y1 - y0) / 10}%`;
      el.classList.toggle("low", y0 < 90);
      el.classList.toggle("replay", !m.live);
      const lw = el.firstChild.offsetWidth, W = layer.clientWidth; // label grows to the left at the right edge
      el.classList.toggle("right", W > 0 && (x0 / 1000) * W + lw > W - 6 && (x1 / 1000) * W - lw >= 6);
    }
    if (on && !hidden) for (const x of boxesAt(data, t)) {
      seen.add(x.key);
      let el = els.get(x.key);
      if (!el) {
        el = document.createElement("div"); el.className = "tbox";
        el.style.setProperty("--c", color(x.brand));
        el.innerHTML = `<span class="tb-label"><i></i><b>${esc(labelText(x.brand, x.product))}</b><em class="tb-basis">${esc(BASIS[x.basis] || x.basis || "")}</em><em class="tb-approx">approx. position</em><em class="tb-est">Gemini estimate</em><em class="tb-unseen">not seen on screen</em></span>`;
        layer.append(el); els.set(x.key, el);
      }
      let [y0, x0, y1, x1] = x.box;
      if (x.level === "point") { const cy = (y0 + y1) / 2, cx = (x0 + x1) / 2; y0 = y1 = cy; x0 = x1 = cx; } // only where it roughly is
      el.style.left = `${x0 / 10}%`; el.style.top = `${y0 / 10}%`;
      el.style.width = `${(x1 - x0) / 10}%`; el.style.height = `${(y1 - y0) / 10}%`;
      el.style.opacity = String(x.fade * (x.level === "box" ? 1 : x.level === "approx" ? 0.75 : 0.85));
      el.classList.toggle("approx", x.level === "approx");
      el.classList.toggle("point", x.level === "point");
      el.classList.toggle("est", measBrands.has(x.brand)); // a measured box exists → this one is only Gemini's estimate
      el.classList.toggle("unseen", !measBrands.has(x.brand) && verdict?.(x.brand, t) === "not_seen"); // our models did not find it
      el.classList.toggle("low", y0 < 90); // no room above the box → label goes inside
      // label grows to the left when it would run out of the picture on the right
      const lw = el.firstChild.offsetWidth + (x.level === "point" ? 16 : 0), W = layer.clientWidth; // a point's label starts 12 px right of the dot
      el.classList.toggle("right", W > 0 && (x0 / 1000) * W + lw > W - 6 && (x1 / 1000) * W - lw >= 6);
    }
    for (const [k, el] of els) if (!seen.has(k)) { el.remove(); els.delete(k); }
    raf = on && (playing || (measured && meas.some((m) => m.live))) ? requestAnimationFrame(render) : 0;
  }

  return {
    /** Called on every time report / state change of the player. */
    sync(t, isPlaying) {
      baseT = t; baseWall = performance.now(); playing = !!isPlaying;
      if (!raf) render();
    },
    setEnabled(v) { on = !!v; host.classList.toggle("tracking", on); cancelAnimationFrame(raf); raf = 0; render(); },
    /** How well the boxes at the current second are located (for the "Look closer" hint): box | approx | point | none. */
    levelAt(t = now()) {
      const xs = boxesAt(data, t); if (!xs.length) return "none";
      return xs.some((x) => x.level === "box") ? "box" : xs.some((x) => x.level === "approx") ? "approx" : "point";
    },
    /** Number of visual appearances with at least one position (for the hint next to the switch). */
    coverage() {
      let withBox = 0, all = 0, keys = 0;
      for (const b of trackables(data)) for (const ap of b.appearances) if (ap.channel === "visual") {
        all++; const k = ap.no_box ? 0 : ap.track?.length || (b.frames || []).filter((f) => f.t >= ap.start_s - 1 && f.t <= ap.end_s + 1).length;
        if (k) withBox++; keys += k;
      }
      return { withBox, all, keys };
    },
    /** verify.js: fn(t) → measured boxes [{key, brand, product, box, live}] (null = none). */
    setMeasured(fn, verdictFn = null) { measured = fn; verdict = verdictFn; cancelAnimationFrame(raf); raf = 0; render(); },
    /** Hide all boxes while a capture would see them (Region Capture / whole tab – the models must not read our labels). */
    setHidden(v) { hidden = !!v; cancelAnimationFrame(raf); raf = 0; render(); },
    refresh() { if (!raf) render(); },
    destroy() { cancelAnimationFrame(raf); layer.remove(); },
  };
}
