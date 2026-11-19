/**
 * value.js — Media value ("Werbewert") of every brand in a video.
 *
 * Idea (industry practice, cf. sponsorship measurement in sports TV): not every second of exposure is worth
 * the same. A large, central logo that the creator actually uses is worth more than a small one at the edge.
 *
 * 1) Weighted exposure seconds per brand
 *      visual:  duration × size weight × position weight × use bonus
 *      text:    duration × 0.6           (on-screen text / caption)
 *      audio:   duration × 0.5           (brand is mentioned in speech)
 *    Weights are assumptions and shown in the UI, so they can be discussed.
 *
 * 2) Visibility score 0–100
 *      100 = the brand is fully weighted on screen for ≥ 25 % of the video
 *
 * 3) Media value in €
 *      value = views / 1000 × CPM × (weighted seconds / 30) × view-through rate
 *    i.e. the price of the equivalent amount of 30-second video ads, only counting viewers who saw that part.
 *    CPM (price per 1000 impressions of a 30 s ad) and view-through rate are adjustable sliders.
 */

export const WEIGHTS = {
  size: { small: 0.4, medium: 0.7, large: 1.0, null: 0.6 },
  position: { center: 1.0, edge: 0.6, null: 0.8 },
  inUse: 1.25,
  text: 0.6,
  audio: 0.5,
};

export const DEFAULTS = { cpm: 15, viewThrough: 0.5 }; // € per 1000 views of a 30 s ad (assumption, YouTube DE); 50 % watch the part

export function weightedSeconds(brand) {
  const parts = { visual: 0, text: 0, audio: 0 };
  for (const a of brand.appearances) {
    const d = Math.max(0, a.end_s - a.start_s);
    if (a.channel === "visual") {
      parts.visual += d * (WEIGHTS.size[a.size] ?? WEIGHTS.size.null) * (WEIGHTS.position[a.position] ?? WEIGHTS.position.null) * (a.in_use ? WEIGHTS.inUse : 1);
    } else if (a.channel === "text") parts.text += d * WEIGHTS.text;
    else parts.audio += d * WEIGHTS.audio;
  }
  return { ...parts, total: parts.visual + parts.text + parts.audio };
}

export function brandValue(brand, video, { cpm = DEFAULTS.cpm, viewThrough = DEFAULTS.viewThrough } = {}) {
  const w = weightedSeconds(brand);
  const dur = video.duration_s || 1;
  const score = Math.min(100, Math.round((100 * w.total) / (dur * 0.25)));
  const euros = ((video.views || 0) / 1000) * cpm * (w.total / 30) * viewThrough;
  const raw = { visual: 0, audio: 0, text: 0 };
  for (const a of brand.appearances) raw[a.channel] = (raw[a.channel] || 0) + (a.end_s - a.start_s);
  return { weighted: w, score, euros, raw, inUse: brand.appearances.some((a) => a.in_use) };
}

export function videoValue(data, opts) {
  const rows = data.brands.map((b) => ({ brand: b, ...brandValue(b, data.video, opts) })).sort((a, b) => b.euros - a.euros);
  return { rows, total: rows.reduce((n, r) => n + r.euros, 0) };
}

export const euro = (n) => n >= 1000 ? `€${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `€${Math.round(n)}`;
