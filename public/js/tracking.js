/**
 * tracking.js — "Show tracking": labelled boxes over the YouTube player that follow the products.
 *
 * Where the boxes come from: the browser cannot look into the YouTube player (cross-origin iframe), so every box
 * is a position Gemini reported while watching the video. Since 21 Nov the prompt asks for keyframes about every
 * 2–3 s per visual appearance (`appearance.track`, see shared/prompts.js); older analyses only have one box per
 * appearance (`brand.frames`). Between two keyframes the box is interpolated, before the first / after the last
 * it is held. Boxes far from any keyframe (> 3 s) are drawn dashed and faded: the position is an estimate.
 *
 * Timing: the player reports its time only every 250 ms, so while it plays the overlay extrapolates the clock
 * per animation frame (requestAnimationFrame) and re-syncs on every report.
 *
 * Used by app.js (Products view). Visual style shared with the live scanner (live.js `draw`): rounded box,
 * dark glass label with a coloured dot, name in bold, model and recognition basis after it.
 */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const BASIS = { logo: "logo", text: "text", speech: "speech", design: "design" };
const NEAR_S = 3;    // within this distance of a keyframe the box counts as "located"
const EDGE_S = 0.4;  // fade in/out around the appearance edges

/** Collect the boxes to draw at time t: [{key, brand, product, basis, box, approx, fade}]. */
export function boxesAt(data, t) {
  const out = [];
  for (const b of data.brands) {
    b.appearances.forEach((ap, i) => {
      if (ap.channel !== "visual" || t < ap.start_s - EDGE_S || t > ap.end_s + EDGE_S) return;
      // new data: own keyframes; old data: the brand's frames that fall inside this appearance
      const keys = ap.track?.length ? ap.track : (b.frames || []).filter((f) => f.t >= ap.start_s - 1 && f.t <= ap.end_s + 1).sort((x, y) => x.t - y.t);
      if (!keys.length) return;
      let box, dist;
      const n = keys.findIndex((k) => k.t > t);
      if (n === 0) { box = keys[0].box; dist = keys[0].t - t; }
      else if (n === -1) { const k = keys[keys.length - 1]; box = k.box; dist = t - k.t; }
      else {
        const a = keys[n - 1], c = keys[n], f = (t - a.t) / Math.max(0.01, c.t - a.t);
        const e = f * f * (3 - 2 * f); // smoothstep: no jerk at the keyframes
        box = a.box.map((v, j) => v + (c.box[j] - v) * e); dist = Math.min(t - a.t, c.t - t);
      }
      const fade = Math.max(0, Math.min(1, (t - (ap.start_s - EDGE_S)) / EDGE_S, ((ap.end_s + EDGE_S) - t) / EDGE_S));
      out.push({ key: `${b.brand}#${i}`, brand: b.brand, product: modelFor(b, ap), basis: ap.basis || "", box, approx: dist > NEAR_S, fade });
    });
  }
  return out;
}

/** The model shown in the label: the one named in this appearance's evidence, else the brand's first model. */
function modelFor(b, ap) {
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
  let on = false, baseT = 0, baseWall = performance.now(), playing = false, raf = 0;

  const now = () => playing ? baseT + Math.min(0.6, (performance.now() - baseWall) / 1000) : baseT;

  function render() {
    const t = now(); const seen = new Set();
    if (on) for (const x of boxesAt(data, t)) {
      seen.add(x.key);
      let el = els.get(x.key);
      if (!el) {
        el = document.createElement("div"); el.className = "tbox";
        el.style.setProperty("--c", color(x.brand));
        el.innerHTML = `<span class="tb-label"><i></i><b>${esc(labelText(x.brand, x.product))}</b>${x.basis ? `<em>${esc(BASIS[x.basis] || x.basis)}</em>` : ""}</span>`;
        layer.append(el); els.set(x.key, el);
      }
      const [y0, x0, y1, x1] = x.box;
      el.style.left = `${x0 / 10}%`; el.style.top = `${y0 / 10}%`;
      el.style.width = `${(x1 - x0) / 10}%`; el.style.height = `${(y1 - y0) / 10}%`;
      el.style.opacity = String(x.fade * (x.approx ? 0.6 : 1));
      el.classList.toggle("approx", x.approx);
      el.classList.toggle("low", y0 < 90); // no room above the box → label goes inside
      // label grows to the left when it would run out of the picture on the right
      const lw = el.firstChild.offsetWidth, W = layer.clientWidth;
      el.classList.toggle("right", W > 0 && (x0 / 1000) * W + lw > W - 6 && (x1 / 1000) * W - lw >= 6);
    }
    for (const [k, el] of els) if (!seen.has(k)) { el.remove(); els.delete(k); }
    raf = on && playing ? requestAnimationFrame(render) : 0;
  }

  return {
    /** Called on every time report / state change of the player. */
    sync(t, isPlaying) {
      baseT = t; baseWall = performance.now(); playing = !!isPlaying;
      if (!raf) render();
    },
    setEnabled(v) { on = !!v; host.classList.toggle("tracking", on); cancelAnimationFrame(raf); raf = 0; render(); },
    /** Number of visual appearances with at least one position (for the hint next to the switch). */
    coverage() {
      let withBox = 0, all = 0, keys = 0;
      for (const b of data.brands) for (const ap of b.appearances) if (ap.channel === "visual") {
        all++; const k = ap.track?.length || (b.frames || []).filter((f) => f.t >= ap.start_s - 1 && f.t <= ap.end_s + 1).length;
        if (k) withBox++; keys += k;
      }
      return { withBox, all, keys };
    },
    destroy() { cancelAnimationFrame(raf); layer.remove(); },
  };
}
