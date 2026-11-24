/**
 * aggregate.js — roll-up over MANY analysed videos (shared by the Worker and the browser).
 *
 * Built for the brand agent (POST /api/agent, view #/agent): "Sonos" → in which videos, how long on screen, paid or
 * labelled, media value in total, top creators, anything odd. Written so that the planned comment view (audience
 * reactions per product) and the channel view (#/channel/<id>, all brands of one creator over time) can reuse it:
 *
 *   summarize(analyses, { match })   match = a brand query ("Sonos")  → only that brand counts
 *                                    match = null                    → every brand counts (channel view)
 *
 * Input: full analyses as stored by the Worker (normalizeAnalysis: video, brands[].appearances, disclosures, paid …).
 * Output: plain JSON (no DOM), so the Worker can send it over SSE and the browser can print it.
 *
 * Honesty rule (EVALUATION.md test M4): two Gemini runs of the same video agree on only about half of the seconds a
 * brand is on screen. One run's screen time and media value therefore carry roughly ±50 %. Every total here comes
 * as a range:
 *   screen time   = seconds × (1 ± SPREAD)
 *   media value   = value.js low … high scenario, exactly as in each video's Media value view (CPM, attention and
 *                   audience drop-off already span about −50 % … +80 % around mid, which covers the detection noise)
 * Counts of videos and the disclosure verdicts are not spread – they depend on whether a brand is found at all,
 * which is far more stable between runs (brand Jaccard 0.61–0.79, test M4).
 */
import { brandValue, DEFAULTS } from "../value.js";
import { checkDisclosure } from "../disclosure.js";
import { screenTime, isUnknownBrand } from "./normalize.js";

/** Run-to-run spread of screen time (test M4) – same value as SCREEN_SPREAD in app.js. */
export const SPREAD = 0.5;

/** "Bowers & Wilkins", "bowers&wilkins" → "bowerswilkins"; accents dropped ("Glückstoff" → "gluckstoff"). */
export const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Does a brand entry of an analysis belong to the query?
 *   - same name, or the brand name starts with the query ("Benefit" → "Benefit Cosmetics", "Sonos" → "Sonos Inc."),
 *   - or the query is a product line of that brand ("AirPods" → Apple, product "AirPods Max").
 * startsWith instead of "contains", so "Apple" does not match "Pineapple"; queries under 2 characters never match.
 */
export function brandMatches(query, b) {
  const q = norm(query);
  if (q.length < 2 || !b || isUnknownBrand(b.brand)) return false;
  const name = norm(b.brand);
  if (name === q || (q.length >= 3 && name.startsWith(q))) return true;
  const words = [b.product, ...(b.products || [])].filter(Boolean).flatMap((p) => String(p).split(/[\s/,+-]+/)).map(norm);
  return q.length >= 3 && words.some((w) => w === q || (w.length > q.length && w.startsWith(q) && q.length >= 4));
}

/** Seconds a brand is spoken about / shown as text (raw durations, no weights). */
const channelSeconds = (b, ch) => b.appearances.filter((a) => a.channel === ch).reduce((n, a) => n + Math.max(0, a.end_s - a.start_s), 0);

/** Disclosure level → short label (same words as disclosure.js). */
export const DISCLOSURE_LABEL = { green: "Labelled", orange: "Weak label", red: "Not labelled", none: "No ad signals" };

/**
 * One video → one row. `brands` = the brand entries that count (all of them, or the matched ones).
 * Each row keeps the numbers of a single run plus their ranges, so the UI never has to re-derive them.
 */
export function videoRow(analysis, brands, opts = DEFAULTS) {
  const v = analysis.video || {};
  const disc = checkDisclosure(analysis);
  let screen = 0, spoken = 0, text = 0, mentions = 0, inUse = false, background = true;
  const value = { low: 0, mid: 0, high: 0 };
  for (const b of brands) {
    screen += screenTime(b);
    spoken += channelSeconds(b, "audio"); text += channelSeconds(b, "text");
    mentions += b.appearances.filter((a) => a.channel === "audio").length;
    const bv = brandValue(b, v, opts);
    for (const k of Object.keys(value)) value[k] += bv.range[k];
    if (bv.inUse) inUse = true;
    if (b.appearances.some((a) => a.channel === "visual" && !a.background)) background = false;
  }
  const shown = brands.some((b) => b.appearances.some((a) => a.channel === "visual"));
  const others = (analysis.brands || []).filter((b) => !brands.includes(b) && !isUnknownBrand(b.brand)).map((b) => b.brand);
  return {
    id: v.id, title: v.title || "", channel: v.channel || "", views: v.views ?? null, duration_s: v.duration_s ?? null,
    upload_date: v.upload_date || null, analyzed_at: analysis.source?.analyzed_at || null,
    found: brands.length > 0,
    brands: brands.map((b) => b.brand), products: [...new Set(brands.flatMap((b) => b.products?.length ? b.products : b.product ? [b.product] : []))].slice(0, 6),
    category: brands[0]?.category || null,
    screen_s: Math.round(screen), screen_range: spreadRange(screen),
    spoken_s: Math.round(spoken), text_s: Math.round(text), mentions,
    shown, in_use: inUse, background_only: shown && background,
    value: { low: value.low, mid: value.mid, high: value.high },          // value.js scenarios (one run)
    // same range as the video's Media value view, so one video never shows two different values (night check 24 Nov);
    // value.js's cautious/generous scenarios already span about −50 % … +80 % around mid, the size of the detection noise
    value_range: { low: value.low, mid: value.mid, high: value.high },
    paid: !!analysis.paid?.looks_like_paid_promotion,
    disclosure: { level: disc.level, label: DISCLOSURE_LABEL[disc.level], title: disc.title, signals: disc.signals },
    others: others.slice(0, 30),
  };
}

const spreadRange = (s) => ({ low: Math.round(s * (1 - SPREAD)), high: Math.round(s * (1 + SPREAD)) });
const sum = (rows, f) => rows.reduce((n, r) => n + (f(r) || 0), 0);

/**
 * Many analyses → one summary.
 * @param {object[]} analyses  full analyses (each with .video.id); duplicates by id are ignored
 * @param {object}   o         { match: brand query or null, opts: value.js sliders, source: { [id]: "demo"|"store"|"new" } }
 */
export function summarize(analyses, { match = null, opts = DEFAULTS, source = {} } = {}) {
  const seen = new Set(); const rows = []; const notFound = [];
  for (const a of analyses) {
    const id = a?.video?.id; if (!id || seen.has(id)) continue; seen.add(id);
    const brands = (a.brands || []).filter((b) => (match ? brandMatches(match, b) : !isUnknownBrand(b.brand)));
    const row = { ...videoRow(a, brands, opts), source: source[id] || a.cached || null };
    (row.found ? rows : notFound).push(row);
  }
  rows.sort((x, y) => y.value.mid - x.value.mid);

  const screen = sum(rows, (r) => r.screen_s);
  const value = { low: sum(rows, (r) => r.value_range.low), mid: sum(rows, (r) => r.value.mid), high: sum(rows, (r) => r.value_range.high) };
  const commercial = rows.filter((r) => r.disclosure.level !== "none");
  const count = (lvl) => rows.filter((r) => r.disclosure.level === lvl).length;

  // Top creators: value (mid) decides the order, number of videos breaks ties
  const byCh = new Map();
  for (const r of rows) {
    const k = r.channel || "(unknown channel)";
    const c = byCh.get(k) || { channel: k, videos: 0, views: 0, screen_s: 0, value_mid: 0, labelled: 0, unlabelled: 0 };
    c.videos += 1; c.views += r.views || 0; c.screen_s += r.screen_s; c.value_mid += r.value.mid;
    if (r.disclosure.level === "green") c.labelled += 1; if (r.disclosure.level === "red") c.unlabelled += 1;
    byCh.set(k, c);
  }
  const creators = [...byCh.values()].sort((a, b) => b.value_mid - a.value_mid || b.videos - a.videos);

  // Per month of upload (for the channel view: sponsors and value over time)
  const byMonth = new Map();
  for (const r of rows) {
    const m = String(r.upload_date || "").replace(/^(\d{4})(\d{2}).*/, "$1-$2").slice(0, 7) || "unknown";
    const e = byMonth.get(m) || { month: m, videos: 0, value_mid: 0, labelled: 0, unlabelled: 0 };
    e.videos += 1; e.value_mid += r.value.mid; if (r.disclosure.level === "green") e.labelled += 1; if (r.disclosure.level === "red") e.unlabelled += 1;
    byMonth.set(m, e);
  }
  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

  // Per brand (channel view: recurring brands) – or, with a query, the brands seen NEXT TO it (competitors, set pieces)
  const byBrand = new Map();
  for (const a of analyses) {
    const id = a?.video?.id; if (!rows.some((r) => r.id === id)) continue;
    for (const b of a.brands || []) {
      if (isUnknownBrand(b.brand)) continue;
      const own = match ? brandMatches(match, b) : true;
      if (match && own) continue;
      const k = norm(b.brand);
      const e = byBrand.get(k) || { brand: b.brand, category: b.category || null, videos: new Set(), screen_s: 0 };
      e.videos.add(id); e.screen_s += screenTime(b); byBrand.set(k, e);
    }
  }
  const brandList = [...byBrand.values()].map((e) => ({ brand: e.brand, category: e.category, videos: e.videos.size, screen_s: Math.round(e.screen_s) }))
    .sort((a, b) => b.videos - a.videos || b.screen_s - a.screen_s);

  const out = {
    query: match, generated_at: new Date().toISOString(), spread: SPREAD,
    totals: {
      videos: rows.length, checked: rows.length + notFound.length, not_found: notFound.length,
      views: sum(rows, (r) => r.views),
      screen_s: Math.round(screen), screen_range: spreadRange(screen),
      spoken_s: Math.round(sum(rows, (r) => r.spoken_s)), mentions: sum(rows, (r) => r.mentions),
      value, in_use: rows.filter((r) => r.in_use).length,
      commercial: commercial.length, paid: rows.filter((r) => r.paid).length,
      labelled: count("green"), weak: count("orange"), unlabelled: count("red"), no_signals: count("none"),
    },
    videos: rows, not_found: notFound, creators, months,
    [match ? "next_to" : "brands"]: brandList.slice(0, 40),
  };
  out.findings = findings(out, match);
  return out;
}

/**
 * Things a brand manager should look at first. Rule-based, each with the videos it refers to.
 * kind: warn (legal / reputational risk) · info (worth knowing) · note (limits of the data)
 */
export function findings(s, match) {
  const f = [];
  const t = s.totals; const name = match || "the brands";
  const list = (rows) => rows.map((r) => ({ id: r.id, title: r.title, channel: r.channel }));
  const red = s.videos.filter((r) => r.disclosure.level === "red");
  if (red.length) f.push({ kind: "warn", id: "unlabelled", title: `${red.length} of ${t.videos} video${t.videos === 1 ? "" : "s"} with ad signals but no label`,
    text: "Gemini or the description point to paid, gifted or affiliate content, but no ad label was found in title, description, image or speech (§ 5a (4) UWG, § 22 MStV – screening aid, not legal advice).", videos: list(red) });
  const weak = s.videos.filter((r) => r.disclosure.level === "orange");
  if (weak.length) f.push({ kind: "warn", id: "weak_label", title: `${weak.length} video${weak.length === 1 ? "" : "s"} with only a weak label`,
    text: "A label exists, but only spoken late or further down the description.", videos: list(weak) });
  const paidNoSignal = s.videos.filter((r) => r.paid && r.disclosure.level === "green");
  if (paidNoSignal.length) f.push({ kind: "info", id: "paid_labelled", title: `${paidNoSignal.length} paid or gifted video${paidNoSignal.length === 1 ? "" : "s"}, labelled correctly`, text: "Commercial content with a clear label.", videos: list(paidNoSignal) });
  const organic = s.videos.filter((r) => r.disclosure.level === "none");
  if (organic.length) f.push({ kind: "info", id: "organic", title: `${organic.length} video${organic.length === 1 ? "" : "s"} without any ad signal`, text: `${name} appears without signs of payment – organic reach (or an undisclosed deal the data cannot see).`, videos: list(organic) });
  const used = s.videos.filter((r) => r.in_use);
  if (used.length) f.push({ kind: "info", id: "in_use", title: `Shown in use in ${used.length} of ${t.videos}`, text: "Hands-on use is the strongest form of placement (×1.25 in the media value).", videos: list(used) });
  const spokenOnly = s.videos.filter((r) => !r.shown && r.mentions);
  if (spokenOnly.length) f.push({ kind: "info", id: "spoken_only", title: `Only mentioned, never shown: ${spokenOnly.length}`, text: "The brand is named in speech or text, but Gemini did not see it in the picture.", videos: list(spokenOnly) });
  const bgOnly = s.videos.filter((r) => r.background_only);
  if (bgOnly.length) f.push({ kind: "info", id: "background", title: `Only in the background: ${bgOnly.length}`, text: "The product lies or stands in the picture but is never the focus (counted 0.5× in the media value).", videos: list(bgOnly) });
  if (s.videos.length >= 3 && t.value.mid > 0) {
    const top = s.videos[0]; const share = top.value.mid / t.value.mid;
    if (share >= 0.6) f.push({ kind: "info", id: "concentration", title: `One video holds ${Math.round(100 * share)} % of the value`, text: `"${top.title}" (${top.channel}) – the total depends mostly on its view count.`, videos: list([top]) });
  }
  if (s.next_to?.length) {
    const top = s.next_to.slice(0, 5);
    f.push({ kind: "info", id: "next_to", title: "Seen next to", text: top.map((b) => `${b.brand} (${b.videos} video${b.videos === 1 ? "" : "s"})`).join(", ") + ".", videos: [] });
  }
  if (s.not_found?.length) f.push({ kind: "note", id: "not_found", title: `${s.not_found.length} analysed video${s.not_found.length === 1 ? "" : "s"} without ${name}`,
    text: "The search suggested them, but Gemini found no such brand in image, speech or text – left out of every total.", videos: list(s.not_found) });
  f.push({ kind: "note", id: "spread", title: "Screen time and value are ranges",
    text: `Two analyses of the same video agree on only about half of the on-screen seconds (test M4), so screen time is shown ±${Math.round(100 * SPREAD)} %. The value range (cautious to generous scenario, as in each video's Media value view) is about as wide. Video counts and disclosure verdicts are more stable.`, videos: [] });
  return f;
}
