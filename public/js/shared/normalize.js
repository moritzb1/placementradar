/**
 * normalize.js — turns raw Gemini JSON into the app's data model (same code on server and in browser).
 *
 * - "MM:SS" → seconds
 * - one canonical spelling per brand ("Tarte" / "Tarte Cosmetics" → "Tarte Cosmetics")
 * - appearances sorted, clamped to the video length
 * - keyframe positions per visual appearance as `track` (tracking overlay, js/tracking.js); all of a brand's
 *   positions also as `frames` (older analyses only have this, one box per appearance)
 * - since 22 Nov: each appearance remembers its `product`; the "re-check" answer (prompts.js call 1a) is mixed in
 *   (mergeRecheck), and visual appearances of the same product that overlap or are at most JOIN_GAP_S apart are
 *   joined into one (joinAppearances) – see the comment there for the rule
 *
 * The resulting shape is documented in README.md → "Data model".
 */

export function sec(t) {
  if (typeof t === "number") return t;
  // a range in one field ("01:30.000 - 01:40.000", seen in test I) → its start; "MM:SS.mmm" keeps the fraction
  const first = String(t ?? "0").split(/\s*[-–—]\s*|\s+to\s+/)[0];
  return first.split(":").reduce((n, part) => n * 60 + (parseFloat(part) || 0), 0);
}
/** End of a range written into one field ("01:30 - 01:40" → 100), else null. */
export function rangeEnd(t) {
  const parts = String(t ?? "").split(/\s*[-–—]\s*|\s+to\s+/);
  return parts.length === 2 && parts[1].includes(":") ? sec(parts[1]) : null;
}

/** Brand names that mean "not identified" → the item goes to `unidentified`, not to `brands`. */
const UNKNOWN = /^(unknown|unbranded|generic|none|n\/?a|no brand|unidentified|not visible|-|)$/i;
export const isUnknownBrand = (b) => UNKNOWN.test(String(b ?? "").trim());

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
  const unidentified = [];
  for (const b of timeline?.brands ?? []) {
    if (isUnknownBrand(b.brand)) { // worn / incidental products without an identifiable brand (inventory rule)
      const u = unidentifiedItem(b, dur);
      if (u) unidentified.push(u);
      continue;
    }
    const key = canon(b.brand);
    const entry = brands.get(key) ?? { brand: key, product: "", products: [], category: b.category || "", appearances: [], frames: [] };
    // several models of one brand (e.g. two Sony headphones) stay one card; the models are listed
    if (b.product && !entry.products.includes(b.product)) entry.products.push(b.product);
    // product link from the video description – kept only if that exact URL is really in the description
    const link = cleanLink(b.link, video?.description);
    if (link) {
      entry.links = entry.links ?? [];
      if (!entry.links.some((l) => l.url === link)) entry.links.push({ product: b.product || "", url: link });
      entry.link = entry.links[0].url;
    }
    if (b.model_from_description) entry.model_from_description = true;
    entry.product = entry.products.slice(0, 2).join(" · ") + (entry.products.length > 2 ? ` +${entry.products.length - 2}` : "");
    for (const ap of b.appearances ?? []) {
      const start = Math.min(sec(ap.start), dur);
      const end = Math.min(Math.max(ap.end ? sec(ap.end) : rangeEnd(ap.start) ?? start, start + 1), dur);
      const track = cleanTrack(ap, start, end);
      entry.appearances.push({ start_s: start, end_s: end, channel: ap.channel || "visual", size: ap.size ?? null,
        position: ap.position ?? null, in_use: ap.in_use ?? null, evidence: ap.evidence || "",
        ...(b.product ? { product: b.product } : {}), ...(ap.background ? { background: true } : {}),
        ...(ap.basis ? { basis: ap.basis } : {}), ...(Number.isFinite(ap.confidence) ? { confidence: ap.confidence } : {}),
        ...(ap.recheck ? { recheck: true } : {}), ...(track.length ? { track } : {}) });
    }
    brands.set(key, entry);
  }
  const list = [...brands.values()].map((b) => {
    const appearances = joinAppearances(b.appearances);
    // `frames` = all positions of the brand (older analyses had only this, one per appearance) – rebuilt after joining
    return { ...b, appearances, frames: appearances.flatMap((a) => a.track ?? []) };
  });
  list.sort((a, b) => screenTime(b) - screenTime(a));
  return {
    video,
    brands: list,
    // products Gemini saw but could not assign to a brand – shown separately, never counted in value or disclosure
    unidentified: unidentified.sort((a, b) => (a.appearances[0]?.start_s ?? 0) - (b.appearances[0]?.start_s ?? 0)),
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
 * Joining appearances (since 22 Nov). Gemini often splits one continuous sighting into pieces – e.g. a phone on the desk
 * is reported at 1:02–1:10 and again at 1:13–1:40, because it was out of focus for a moment or the keyframes had a gap –
 * and the re-check (call 1a) reports spans that overlap call 1. Without joining, "Right now" and the tracking boxes
 * flicker off in the gaps and the same seconds would be counted twice.
 *
 * Rule: two VISUAL appearances of the same product (same brand and the same product name) are joined into one when they
 * overlap or the gap between them is at most JOIN_GAP_S = 5 s. 5 s because Gemini samples 1 frame per second and
 * reports a position only every ~4 s (test T), so a gap shorter than that cannot be told apart from a missing report;
 * a longer gap is usually a real cut. The joined appearance
 *   - runs from the earliest start to the latest end (the gap counts as visible),
 *   - keeps size, position, use, background, basis and confidence of its LONGEST part, so a short close-up does not
 *     upgrade a long background shot in the media value,
 *   - keeps all keyframes of its parts (sorted, duplicates < 0.25 s removed, thinned to at most 36),
 *   - records how many pieces it was made of (`parts`), and `recheck: true` only if every piece came from the re-check.
 * Spoken mentions and on-screen text are never joined (each one is a separate event). Different products of one brand
 * (two Sony headphones) stay separate.
 */
export const JOIN_GAP_S = 5;
const MAX_JOINED_KEYS = 36;

export function joinAppearances(appearances) {
  const visual = appearances.filter((a) => a.channel === "visual").sort((x, y) => x.start_s - y.start_s);
  const other = appearances.filter((a) => a.channel !== "visual");
  const groups = new Map(); // product name → joined appearances so far
  for (const a of visual) {
    const key = String(a.product || "").trim().toLowerCase();
    const list = groups.get(key) ?? [];
    const last = list[list.length - 1];
    if (last && a.start_s <= last.end_s + JOIN_GAP_S) last.pieces.push(a), (last.end_s = Math.max(last.end_s, a.end_s));
    else list.push({ start_s: a.start_s, end_s: a.end_s, pieces: [a] });
    groups.set(key, list);
  }
  const joined = [...groups.values()].flat().map(({ start_s, end_s, pieces }) => {
    if (pieces.length === 1) return pieces[0];
    const longest = pieces.reduce((m, p) => (p.end_s - p.start_s > m.end_s - m.start_s ? p : m));
    const keys = [];
    for (const k of pieces.flatMap((p) => p.track ?? []).sort((x, y) => x.t - y.t)) if (!keys.some((o) => Math.abs(o.t - k.t) < 0.25)) keys.push(k);
    // thin out evenly (first and last kept) so a long desk shot does not carry hundreds of boxes
    const track = keys.length <= MAX_JOINED_KEYS ? keys : Array.from({ length: MAX_JOINED_KEYS }, (_, i) => keys[Math.round((i * (keys.length - 1)) / (MAX_JOINED_KEYS - 1))]);
    const evidence = [...new Set(pieces.map((p) => p.evidence).filter(Boolean))].join(" · ").slice(0, 300);
    const { track: _t, recheck: _r, ...attrs } = longest;
    return { ...attrs, start_s, end_s, evidence, parts: pieces.length,
      ...(pieces.every((p) => p.recheck) ? { recheck: true } : {}), ...(track.length ? { track } : {}) };
  });
  return [...joined, ...other].sort((x, y) => x.start_s - y.start_s);
}

/**
 * Re-check (call 1a): the list of products sent to Gemini – identified brands from call 1, one entry per brand + product,
 * at most MAX items, in the order of call 1. Names are cleaned (one line, 80 characters), because a product name may
 * come from the video description, i.e. from a stranger.
 */
export function recheckItems(timeline, max = 30) {
  const clean = (x, n = 80) => String(x ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
  const seen = new Set(), out = [];
  for (const b of timeline?.brands ?? []) {
    if (isUnknownBrand(b.brand) || !(b.appearances ?? []).length) continue;
    const key = `${canon(b.brand).toLowerCase()}|${String(b.product || "").trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ brand: clean(canon(b.brand)), product: clean(b.product), category: clean(b.category, 40), raw: b });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Mix the re-check answer into the raw timeline of call 1: each answered list number becomes an extra raw brand entry
 * with the ORIGINAL brand, product and category (Gemini cannot rename or add brands this way) and visual appearances
 * marked `recheck: true`. Only exception: a span may name another model of the same brand (`model`) – it is kept as
 * a separate product of that brand (e.g. the iPhone lying next to the listed MacBook). normalizeAnalysis then joins them with the appearances of call 1 (joinAppearances).
 * Unknown list numbers and appearances without a start are ignored. Returns a new timeline object.
 */
export function mergeRecheck(timeline, items, answer) {
  const extra = [];
  for (const it of answer?.items ?? []) {
    const src = items[Math.round(Number(it.index)) - 1];
    if (!src) continue;
    // a span may name another model of the same brand (`model`) → it becomes its own product of that brand
    const byModel = new Map();
    for (const ap of it.appearances ?? []) {
      if (!ap.start) continue;
      const model = String(ap.model ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      const product = model && !isUnknownBrand(model) && model.toLowerCase() !== String(src.raw.product || "").toLowerCase() ? model : src.raw.product;
      const { model: _m, ...rest } = ap;
      byModel.set(product, [...(byModel.get(product) ?? []), { ...rest, channel: "visual", recheck: true }]);
    }
    for (const [product, appearances] of byModel) extra.push({ brand: src.raw.brand, product, category: src.raw.category, appearances });
  }
  return { ...timeline, brands: [...(timeline?.brands ?? []), ...extra] };
}

/**
 * A link Gemini copied from the description. Accepted only when the same URL occurs in the description text, so a
 * hallucinated or injected URL can never reach a product card. Trailing punctuation from the sentence is removed.
 */
export function cleanLink(link, description) {
  const url = String(link ?? "").trim().replace(/[).,;:!?'"\]>]+$/, "");
  if (!/^https?:\/\/[^\s<>"']{4,}$/i.test(url) || url.length > 400) return "";
  return String(description ?? "").includes(url) ? url : "";
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

/** One unidentified product: category, description, optional vague guess ("possible: …"), appearances. */
function unidentifiedItem(b, dur) {
  const appearances = (b.appearances ?? []).map((ap) => {
    const start = Math.min(sec(ap.start), dur);
    const end = Math.min(Math.max(ap.end ? sec(ap.end) : rangeEnd(ap.start) ?? start, start + 1), dur);
    const track = cleanTrack(ap, start, end);
    return { start_s: start, end_s: end, channel: ap.channel || "visual", evidence: ap.evidence || "",
      ...(Number.isFinite(ap.confidence) ? { confidence: ap.confidence } : {}), ...(track.length ? { track } : {}) };
  }).sort((x, y) => x.start_s - y.start_s);
  if (!appearances.length) return null;
  const guess = /^possible:/i.test(b.product || "") ? b.product.replace(/^possible:\s*/i, "") : "";
  return { category: (b.category || "product").trim(), description: b.description || appearances[0].evidence || "",
    ...(guess ? { guess } : {}), appearances };
}

/**
 * "Look closer" result (CLOSER_SCHEMA items) → { brands, unidentified } in the same shape as an analysis,
 * so the app can merge it. Items get `closer: true` on each appearance.
 */
export function normalizeCloser(items, dur = Infinity) {
  const timeline = { brands: (items ?? []).map((it) => ({
    brand: it.brand, category: it.category, description: it.description || "",
    product: isUnknownBrand(it.model) ? "" : it.model || "",
    appearances: [{ start: it.start, end: it.end, channel: "visual", basis: it.basis === "unknown" ? undefined : it.basis,
      confidence: it.confidence, evidence: it.description || "", frame_time: it.frame_time, box_2d: it.box_2d }],
  })) };
  const n = normalizeAnalysis({ video: { duration_s: Number.isFinite(dur) ? dur : 0 }, timeline });
  for (const b of [...n.brands, ...n.unidentified]) for (const a of b.appearances) a.closer = true;
  return { brands: n.brands, unidentified: n.unidentified };
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
  return (timeline?.brands ?? []).filter((b) => !isUnknownBrand(b.brand))
    .map((b) => ({ b, w: (b.appearances ?? []).reduce((n, a) => n + (sec(a.end) - sec(a.start)) * (a.in_use ? 2 : 1), 0) }))
    .sort((x, y) => y.w - x.w).slice(0, max).map(({ b }) => `${canon(b.brand)}${b.product ? " " + b.product : ""}`);
}
