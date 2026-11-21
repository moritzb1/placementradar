/**
 * value.js — Equivalent ad cost (earned media value) of every brand in a video, as a RANGE (low / mid / high).
 *
 * What it is: what a brand would have to pay for comparable reach as regular video ads. It is NOT what the creator
 * earned (a creator is paid per deal, often far less or nothing at all for an organic mention).
 *
 * Why a range (21 Nov): the first version gave one number (MKBHD "My Everyday Tech": €176k), which looked like a
 * creator fee. It ignored two things that every media-value method discounts for:
 *   - fewer people see the later parts of a video (audience retention drops while the video runs),
 *   - a product in the picture is not a 30-second ad spot (the viewer watches the video, not the brand).
 *
 * 1) Weighted exposure seconds per appearance
 *      visual:  duration × size weight × position weight × use bonus
 *      text:    duration × 0.6           (on-screen text / caption)
 *      audio:   duration × 0.5           (brand is mentioned in speech)
 *
 * 2) Audience retention: share of the counted viewers still watching at time t (simple linear curve)
 *      retention(t) = start − (start − end) × t / duration
 *    Each appearance is weighted with the retention at its middle → "retained seconds".
 *    Scenario curves (YouTube creators typically report 40–60 % average view duration):
 *      low 60 % → 25 %, mid 70 % → 35 %, high 85 % → 50 %   (averages 43 / 53 / 68 %)
 *
 * 3) Attention factor: how much a product shown inside a video is worth compared with a dedicated ad spot.
 *      mid = slider (default 35 %), low = 0.75 × mid, high = 1.25 × mid
 *
 * 4) Equivalent ad cost in €
 *      value = views / 1000 × CPM × (retained seconds / 30) × attention
 *    CPM (price per 1000 impressions of a 30 s ad): mid = slider (default €15, YouTube DE), low 0.8 ×, high 1.2 ×.
 *
 * Worked example (README §4): MKBHD, 5.7 M views, ~125 weighted seconds → about €38k – €141k, mid €75k
 * (the old point value was €176k).
 *
 * Every weight is an assumption; all of them are shown in the UI so they can be discussed.
 */

export const WEIGHTS = {
  size: { small: 0.4, medium: 0.7, large: 1.0, null: 0.6 },
  position: { center: 1.0, edge: 0.6, null: 0.8 },
  inUse: 1.25,
  text: 0.6,
  audio: 0.5,
};

/** Sliders: CPM (€ per 1000 views of a 30 s ad) and attention compared with an ad spot – both are the MID scenario. */
export const DEFAULTS = { cpm: 15, attention: 0.35 };

export const SCENARIOS = {
  low: { cpm: 0.8, attention: 0.75, retStart: 0.6, retEnd: 0.25 },
  mid: { cpm: 1, attention: 1, retStart: 0.7, retEnd: 0.35 },
  high: { cpm: 1.2, attention: 1.25, retStart: 0.85, retEnd: 0.5 },
};

/** Share of viewers still watching at second t (0–1) in a scenario. */
export function retention(t, duration, sc = SCENARIOS.mid) {
  const p = Math.max(0, Math.min(1, t / Math.max(1, duration || 1)));
  return sc.retStart - (sc.retStart - sc.retEnd) * p;
}

/** Weighted seconds of one appearance (before retention and attention). */
export function appearanceWeight(a) {
  const d = Math.max(0, a.end_s - a.start_s);
  if (a.channel === "visual") return d * (WEIGHTS.size[a.size] ?? WEIGHTS.size.null) * (WEIGHTS.position[a.position] ?? WEIGHTS.position.null) * (a.in_use ? WEIGHTS.inUse : 1);
  return d * (a.channel === "text" ? WEIGHTS.text : WEIGHTS.audio);
}

export function weightedSeconds(brand) {
  const parts = { visual: 0, text: 0, audio: 0 };
  for (const a of brand.appearances) parts[a.channel === "visual" ? "visual" : a.channel === "text" ? "text" : "audio"] += appearanceWeight(a);
  return { ...parts, total: parts.visual + parts.text + parts.audio };
}

/** Weighted seconds × retention at the middle of each appearance, per scenario. */
export function retainedSeconds(brand, duration) {
  const out = {};
  for (const [k, sc] of Object.entries(SCENARIOS)) {
    out[k] = brand.appearances.reduce((n, a) => n + appearanceWeight(a) * retention((a.start_s + a.end_s) / 2, duration, sc), 0);
  }
  return out;
}

/** Scenario parameters with the slider values applied (what the UI prints). */
export function scenarioParams({ cpm = DEFAULTS.cpm, attention = DEFAULTS.attention } = {}) {
  return Object.fromEntries(Object.entries(SCENARIOS).map(([k, sc]) => [k, { ...sc, cpmEur: cpm * sc.cpm, att: Math.min(1, attention * sc.attention) }]));
}

export function brandValue(brand, video, opts = {}) {
  const w = weightedSeconds(brand);
  const dur = video.duration_s || Math.max(1, ...brand.appearances.map((a) => a.end_s));
  const score = Math.min(100, Math.round((100 * w.total) / (dur * 0.25)));
  const ret = retainedSeconds(brand, dur);
  const p = scenarioParams(opts);
  const views = video.views || 0;
  const range = Object.fromEntries(Object.keys(SCENARIOS).map((k) => [k, (views / 1000) * p[k].cpmEur * (ret[k] / 30) * p[k].att]));
  const raw = { visual: 0, audio: 0, text: 0 };
  for (const a of brand.appearances) raw[a.channel] = (raw[a.channel] || 0) + (a.end_s - a.start_s);
  // `euros` = mid value (sorting, shares); `range` = low / mid / high
  return { weighted: w, retained: ret, score, euros: range.mid, range, raw, inUse: brand.appearances.some((a) => a.in_use) };
}

export function videoValue(data, opts) {
  const rows = data.brands.map((b) => ({ brand: b, ...brandValue(b, data.video, opts) })).sort((a, b) => b.euros - a.euros);
  const sum = (k) => rows.reduce((n, r) => n + r.range[k], 0);
  const range = { low: sum("low"), mid: sum("mid"), high: sum("high") };
  return { rows, total: range.mid, range };
}

export const euro = (n) => n >= 1e6 ? `€${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `€${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `€${Math.round(n)}`;
/** "€21k – €111k" */
export const euroRange = (r) => (Math.round(r.low) === Math.round(r.high) ? euro(r.mid) : `${euro(r.low)} – ${euro(r.high)}`);

/** One-line label used in every (i) text. */
export const VALUE_WHAT = "Equivalent ad cost (earned media value) – not what the creator earned.";
