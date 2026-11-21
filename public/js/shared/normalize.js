/**
 * normalize.js — turns raw Gemini JSON into the app's data model (same code on server and in browser).
 *
 * - "MM:SS" → seconds
 * - one canonical spelling per brand ("Tarte" / "Tarte Cosmetics" → "Tarte Cosmetics")
 * - appearances sorted, clamped to the video length
 * - keyframe positions per visual appearance as `track` (tracking overlay, js/tracking.js); all of a brand's
 *   positions also as `frames` (older analyses only have this, one box per appearance)
 *
 * The resulting shape is documented in README.md → "Data model".
 */

export function sec(t) {
  if (typeof t === "number") return t;
  return String(t ?? "0").split(":").reduce((n, part) => n * 60 + (parseFloat(part) || 0), 0);
}

export function mmss(s) {
  s = Math.max(0, Math.round(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Known spelling variants (grown from our test runs; see EVALUATION.md test B, part 1)
const ALIASES = {
  "tarte": "Tarte Cosmetics", "tarte cosmetics": "Tarte Cosmetics",
  "hate stains co.": "The Hate Stains Co.", "the hate stains co.": "The Hate Stains Co.",
  "glücksstoff": "Glückstoff", "head": "HEAD", "lv": "Louis Vuitton",
};
export const canon = (name) => ALIASES[String(name).trim().toLowerCase()] ?? String(name).trim();

/** Merge timeline call + (optional) authenticity call into one analysis object. */
export function normalizeAnalysis({ video, timeline, authenticity, models }) {
  const dur = video?.duration_s || Infinity;
  const brands = new Map();
  for (const b of timeline?.brands ?? []) {
    const key = canon(b.brand);
    const entry = brands.get(key) ?? { brand: key, product: "", products: [], category: b.category || "", appearances: [], frames: [] };
    // several models of one brand (e.g. two Sony headphones) stay one card; the models are listed
    if (b.product && !entry.products.includes(b.product)) entry.products.push(b.product);
    entry.product = entry.products.slice(0, 2).join(" · ") + (entry.products.length > 2 ? ` +${entry.products.length - 2}` : "");
    for (const ap of b.appearances ?? []) {
      const start = Math.min(sec(ap.start), dur);
      const end = Math.min(Math.max(sec(ap.end), start + 1), dur);
      const track = cleanTrack(ap, start, end);
      entry.appearances.push({ start_s: start, end_s: end, channel: ap.channel || "visual", size: ap.size ?? null,
        position: ap.position ?? null, in_use: ap.in_use ?? null, evidence: ap.evidence || "",
        ...(ap.basis ? { basis: ap.basis } : {}), ...(Number.isFinite(ap.confidence) ? { confidence: ap.confidence } : {}),
        ...(track.length ? { track } : {}) });
      // `frames` = all positions of the brand (older analyses had only this, one per appearance)
      for (const k of track) entry.frames.push(k);
    }
    brands.set(key, entry);
  }
  const list = [...brands.values()].map((b) => ({ ...b, appearances: b.appearances.sort((x, y) => x.start_s - y.start_s) }));
  list.sort((a, b) => screenTime(b) - screenTime(a));
  return {
    video,
    brands: list,
    // drop empty or impossible entries (20 Nov: one run returned {time: 1832429, kind: "", text: ""})
    disclosures: (timeline?.disclosures ?? []).map((d) => ({ time_s: sec(d.time), kind: d.kind || "", text: d.text || "" }))
      .filter((d) => (d.kind || d.text) && d.time_s >= 0 && d.time_s <= dur),
    paid: { looks_like_paid_promotion: !!timeline?.looks_like_paid_promotion, reasoning: timeline?.reasoning || "" },
    authenticity: (authenticity?.items ?? []).map((a) => ({
      brand: canon(a.brand), product: a.product || "", overall: a.overall, verdict: a.verdict || "",
      sub: Object.fromEntries(["use_shown", "balance", "specificity", "delivery", "body_language", "sales_pressure"]
        .map((k) => [k, { score: a[k]?.score ?? null, time_s: a[k]?.time ? sec(a[k].time) : null, evidence: a[k]?.evidence || "" }])),
    })),
    source: { engine: "gemini", models: models || [], analyzed_at: new Date().toISOString().slice(0, 10) },
  };
}

/**
 * Keyframes of one visual appearance → [{t, box:[ymin,xmin,ymax,xmax]}], sorted, inside the appearance (±1 s),
 * boxes clamped to 0-1000 with min < max. Accepts the new `track` list and the old single `frame_time` + `box_2d`.
 */
export function cleanTrack(ap, start, end) {
  const raw = [...(Array.isArray(ap.track) ? ap.track.map((k) => ({ t: k.time, box: k.box_2d })) : []),
    ...(ap.frame_time && ap.box_2d ? [{ t: ap.frame_time, box: ap.box_2d }] : [])];
  const out = [];
  for (const k of raw) {
    if (!Array.isArray(k.box) || k.box.length !== 4 || !k.box.every(Number.isFinite)) continue;
    const t = sec(k.t);
    if (!(t >= start - 1 && t <= end + 1)) continue;
    const c = k.box.map((v) => Math.max(0, Math.min(1000, Math.round(v))));
    const box = [Math.min(c[0], c[2]), Math.min(c[1], c[3]), Math.max(c[0], c[2]), Math.max(c[1], c[3])];
    if (box[2] - box[0] < 8 || box[3] - box[1] < 8) continue; // degenerate (a line or a point)
    if (!out.some((o) => Math.abs(o.t - t) < 0.25)) out.push({ t, box });
  }
  return out.sort((a, b) => a.t - b.t).slice(0, 24);
}

/** Seconds a brand is on screen (visual appearances, overlaps merged). */
export function screenTime(brand) {
  const iv = brand.appearances.filter((a) => a.channel === "visual").map((a) => [a.start_s, a.end_s]).sort((a, b) => a[0] - b[0]);
  let total = 0, cur = null;
  for (const [s, e] of iv) {
    if (!cur || s > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [s, e]; } else cur[1] = Math.max(cur[1], e);
  }
  return total + (cur ? cur[1] - cur[0] : 0);
}

/** Brands that look promoted → candidates for the authenticity call. */
export function promotedCandidates(timeline, max = 4) {
  return (timeline?.brands ?? [])
    .map((b) => ({ b, w: (b.appearances ?? []).reduce((n, a) => n + (sec(a.end) - sec(a.start)) * (a.in_use ? 2 : 1), 0) }))
    .sort((x, y) => y.w - x.w).slice(0, max).map(({ b }) => `${canon(b.brand)}${b.product ? " " + b.product : ""}`);
}
