/**
 * fit.js — "Channel fit": how well would a brand suit a creator's channel? (PLAN_DEZEMBER E, shared by the Worker and
 * the browser; no DOM, no API call, so tests/test_e_channel.mjs can run it on stored data.)
 *
 * Everything here is RULE-BASED and every number can be traced back to the analysed videos of the channel. No model
 * decides the fit – a brand manager has to be able to explain the score to a colleague.
 *
 * 1. categoryGroup(text)   Gemini writes free-text categories ("Consumer Electronics", "Kopfhörer", "Skincare" …).
 *                          A keyword list maps them to 13 coarse groups; unknown text → "other".
 * 2. channelFit(data, brand, { group })   four parts, each 0–100, combined as a weighted mean of the parts that
 *                          have data (a part without data is shown as "no data" and left out, never guessed):
 *
 *    part              weight  rule
 *    category          40 %   share s of the channel's brand placements (brand × video) in the brand's group;
 *                             related groups (e.g. audio ↔ tech) count half. score = min(100, s / 25 % × 100):
 *                             a quarter of all placements in the same field = the audience is used to it.
 *    competition       20 %   other brands of the same group on the channel (per video). 0 → 100, 1 video → 75,
 *                             2–3 → 50, more → 25. Few rivals = more room to stand out (and no exclusivity clash).
 *    disclosure        25 %   of the videos with ad signals: labelled = 1, weak label = 0.5, not labelled = 0.
 *                             A brand is liable for unlabelled ads it pays for (§ 5a (4) UWG) → faithful labelling
 *                             protects the brand. No commercial video yet → no data.
 *    audience          15 %   comments already loaded in the Audience tab (Worker cache only, nothing is fetched):
 *                             (praise + purchase intent + 1) / (all of them + criticism + ad suspicion + 2) on the
 *                             brands of the same group, else on all brands. Laplace smoothing keeps 2 comments from
 *                             giving 100.
 *
 *    total             weighted mean × (0.5 + 0.5 × category score / 100): the field decides first – a channel that
 *                      never shows the brand's field reaches at most half, however well it labels its ads.
 *    confidence        "low" under 3 analysed videos, "medium" 3–5, "good" from 6. Zero analysed videos → no score.
 */
import { norm } from "./aggregate.js";

/** Coarse product fields. Order matters: the first pattern that matches wins ("Car Accessories" → mobility, not fashion). */
export const GROUPS = [
  { id: "mobility", label: "Cars & mobility", rx: /vehicle|\bcars?\b|\bauto\b|automotive|bicycle|\bbikes?\b|e-?bike|scooter|tire|tyre|motorcycle|fahrrad|fahrzeug/i },
  { id: "audio", label: "Audio", rx: /headphone|earbud|earphone|speaker|audio|microphone|\bmics?\b|kopfh[öo]rer|lautsprecher|\bsound\b|hifi|hi-fi/i },
  { id: "gaming", label: "Gaming", rx: /gaming|video ?games?|console|esport/i },
  { id: "toys", label: "Toys & hobby", rx: /\btoys?\b|spielzeug|hobby|\bgames?\b|lego|craft/i },
  { id: "tech", label: "Tech & electronics", rx: /electronic|smartphone|\bphones?\b|computer|laptop|notebook|tablet|camera|optic|\btech|gadget|monitor|keyboard|\bmouse\b|software|\bapps?\b|drone|wearable|smartwatch|charger|cable|storage|peripheral|elektronik/i },
  { id: "beauty", label: "Beauty & care", rx: /beauty|cosmetic|skin ?care|make-?up|personal care|\bhair|fragrance|perfume|oral care|\bnail|kosmetik|pflege|deodorant|shaving/i },
  { id: "health", label: "Health", rx: /health|pharma|medical|eye ?care|vitamin|supplement|medizin|gesundheit|orthop/i },
  { id: "food", label: "Food & drink", rx: /food|beverage|\bdrinks?\b|snack|coffee|espresso|\btea\b|nutrition|grocer|lebensmittel|getränk|candy|sweets|protein/i },
  { id: "sport", label: "Sport & outdoor", rx: /sport|fitness|outdoor|running|\bgym\b|training|camping|cycling gear/i },
  { id: "home", label: "Home & living", rx: /\bhome|furniture|appliance|lighting|automation|kitchen|cleaning|household|tableware|bedding|pillow|mattress|kissen|haushalt|möbel|decor|garden/i },
  { id: "fashion", label: "Fashion & accessories", rx: /cloth|apparel|fashion|\bshoes?\b|sneaker|\bbags?\b|luggage|backpack|wallet|card case|accessor|jewel|\bwatch(es)?\b|luxury|kleidung|mode\b/i },
  { id: "retail", label: "Retail & services", rx: /retail|\bstores?\b|\bshop|supermarket|discounter|service|subscription|bank|insurance|vpn|publication|media|certification/i },
];
export const OTHER = { id: "other", label: "Other" };
export const GROUP_LABEL = Object.fromEntries([...GROUPS, OTHER].map((g) => [g.id, g.label]));

/** Neighbouring fields: an audience that watches one is likely open to the other (counted half). */
// (kept narrow on purpose: one backpack on a tech channel must not make it a beauty channel – test E2, 25 Nov)
const RELATED = { audio: ["tech", "gaming"], tech: ["audio", "gaming"], gaming: ["tech", "audio", "toys"], beauty: ["health"],
  health: ["beauty", "food", "sport"], food: ["health"], sport: ["health"], fashion: [], home: [], toys: ["gaming"], mobility: [],
  retail: [], other: [] };

/** Free-text category (and optionally the product name as a second hint) → group id. */
export function categoryGroup(category, product = "") {
  const find = (t) => (String(t || "").trim() ? GROUPS.find((x) => x.rx.test(t))?.id || null : null);
  const byCat = find(category);
  // "Consumer Electronics" + product "Ace headphones" → audio: a generic category gives way to a more specific product
  if (!byCat || byCat === "tech" || byCat === "retail") {
    const byProduct = find(product);
    if (byProduct && byProduct !== "retail" && (!byCat || byProduct !== "tech")) return byProduct;
  }
  return byCat || OTHER.id;
}

export const FIT_WEIGHTS = { category: 40, competition: 20, disclosure: 25, audience: 15 };
const LEVEL_SCORE = { green: 1, orange: 0.5, red: 0 };

/**
 * @param data   { placements: [{id, brand, category, group, screen_s, level, paid}],  one row per brand and video
 *                 videos: number of analysed videos, audience: { [videoId]: { brands: { [brand]: {comments, cats} }, total } } }
 * @param brand  brand name typed by the visitor
 * @param o      { group } – the brand's product field (from the channel itself, the library, or chosen by the visitor)
 */
export function channelFit(data, brand, { group = null } = {}) {
  const P = data.placements || [];
  const n = data.videos || new Set(P.map((p) => p.id)).size;
  const b = norm(brand);
  const own = P.filter((p) => norm(p.brand) === b || (b.length >= 3 && norm(p.brand).startsWith(b)));
  // the brand's own field on this channel = its most frequent group here (Sonos: speakers and headphones → audio)
  const ownGroups = own.filter((p) => p.group !== "other").reduce((m, p) => ((m[p.group] = (m[p.group] || 0) + 1), m), {}); // "other" = unknown
  // (a tie goes to the more specific field: "tech" and "other" are the catch-alls)
  const vague = (k) => (k === "tech" || k === "other" ? 1 : 0);
  const g = group || Object.entries(ownGroups).sort((x, y) => y[1] - x[1] || vague(x[0]) - vague(y[0]))[0]?.[0] || null;
  const out = { brand, group: g, group_label: g ? GROUP_LABEL[g] : null, videos: n, confidence: n >= 6 ? "good" : n >= 3 ? "medium" : n ? "low" : "none",
    already: [...new Set(own.map((p) => p.id))], parts: [], score: null, competitors: [] };
  if (!n) { out.note = "No analysed video of this channel yet – analyse a few uploads first, then the fit can be measured."; return out; }
  if (!g) { out.note = "The brand's product field is unknown – pick it from the list."; return out; }

  // 1. category: share of placements in the same / related field
  // placements whose field is unknown ("other": Gemini left the category empty) cannot speak for or against a field
  const others = P.filter((p) => !own.includes(p) && p.group !== "other");
  const unknown = P.filter((p) => !own.includes(p) && p.group === "other").length;
  const total = others.length || 1;
  const same = others.filter((p) => p.group === g).length;
  const near = others.filter((p) => (RELATED[g] || []).includes(p.group)).length;
  const share = (same + 0.5 * near) / total;
  const catScore = Math.round(Math.min(100, (share / 0.25) * 100));
  out.parts.push({ id: "category", label: "Category match", weight: FIT_WEIGHTS.category, score: others.length ? catScore : null,
    text: others.length ? `${same} of ${others.length} brand placements on this channel are ${GROUP_LABEL[g]}${near ? `, ${near} in a related field (counted half)` : ""} → ${Math.round(100 * share)} %. A quarter or more counts as a full match.${unknown ? ` ${unknown} placement${unknown === 1 ? "" : "s"} without a known field left out.` : ""}` : `No other brand placement with a known field to compare with${unknown ? ` (${unknown} without a category)` : ""}.`,
    detail: { same, near, total: others.length, share } });

  // 2. competition: other brands of the same field, counted per video
  const rivals = new Map();
  for (const p of others.filter((x) => x.group === g)) {
    const k = norm(p.brand); const e = rivals.get(k) || { brand: p.brand, videos: new Set(), screen_s: 0 };
    e.videos.add(p.id); e.screen_s += p.screen_s || 0; rivals.set(k, e);
  }
  out.competitors = [...rivals.values()].map((e) => ({ brand: e.brand, videos: e.videos.size, screen_s: Math.round(e.screen_s) })).sort((x, y) => y.videos - x.videos || y.screen_s - x.screen_s);
  const rivalVideos = new Set(others.filter((x) => x.group === g).map((p) => p.id)).size;
  // no placement in this field or a related one → "no rivals" proves nothing (a beauty brand on a tech channel has
  // no competitors there either) → no data instead of 100 (night check 25 Nov, test E2)
  const compScore = same + near === 0 ? null : rivalVideos === 0 ? 100 : rivalVideos === 1 ? 75 : rivalVideos <= 3 ? 50 : 25;
  out.parts.push({ id: "competition", label: "Room next to competitors", weight: FIT_WEIGHTS.competition, score: compScore,
    text: out.competitors.length ? `${out.competitors.length} other ${GROUP_LABEL[g]} brand${out.competitors.length === 1 ? "" : "s"} in ${rivalVideos} video${rivalVideos === 1 ? "" : "s"}: ${out.competitors.slice(0, 4).map((c) => c.brand).join(", ")}. 0 videos → 100, 1 → 75, 2–3 → 50, more → 25.`
      : compScore == null ? `Nothing from ${GROUP_LABEL[g]} or a related field on this channel – no rivals, but that says nothing about the fit, so this part is left out.`
      : `No other ${GROUP_LABEL[g]} brand on this channel, only related fields – room to stand out.` });

  // 3. disclosure: per video, only videos with ad signals count
  const byVideo = new Map(); for (const p of P) byVideo.set(p.id, p.level);
  const commercial = [...byVideo.values()].filter((l) => l && l !== "none");
  const discScore = commercial.length ? Math.round(100 * commercial.reduce((s, l) => s + (LEVEL_SCORE[l] ?? 0), 0) / commercial.length) : null;
  const cnt = (l) => commercial.filter((x) => x === l).length;
  out.parts.push({ id: "disclosure", label: "Labels its ads", weight: FIT_WEIGHTS.disclosure, score: discScore,
    text: commercial.length ? `${commercial.length} of ${byVideo.size} analysed videos show ad signals: ${cnt("green")} labelled, ${cnt("orange")} weakly, ${cnt("red")} not labelled (labelled = 1, weak = ½, none = 0). A paying brand shares the risk of unlabelled ads (§ 5a (4) UWG).` : "No analysed video with ad signals yet – how the creator labels paid content is unknown." });

  // 4. audience: comments already in the cache (Audience tab), never fetched here
  let pos = 0, neg = 0, all = 0, inField = true;
  const add = (c) => { if (!c) return; pos += (c.cats?.praise || 0) + (c.cats?.buy || 0); neg += (c.cats?.critic || 0) + (c.cats?.ad_doubt || 0); all += c.comments || 0; };
  const aud = data.audience || {};
  for (const [vid, a] of Object.entries(aud)) {
    for (const p of P.filter((x) => x.id === vid && x.group === g)) add(a.brands?.[p.brand]);
  }
  if (!all) { inField = false; for (const a of Object.values(aud)) for (const c of Object.values(a.brands || {})) add(c); }
  const audVideos = Object.keys(aud).length;
  const audScore = all ? Math.round(100 * (pos + 1) / (pos + neg + 2)) : null;
  out.parts.push({ id: "audience", label: "Audience reaction", weight: FIT_WEIGHTS.audience, score: audScore,
    text: all ? `${all} product comments in ${audVideos} video${audVideos === 1 ? "" : "s"}${inField ? ` about ${GROUP_LABEL[g]} brands` : " (all brands – none about this field)"}: ${pos} praise or purchase intent, ${neg} criticism or ad suspicion → (${pos} + 1) ÷ (${pos} + ${neg} + 2).` : "No comments loaded yet. Open an analysed video's Audience tab once – the channel view only uses comments that are already cached." });

  // weighted mean of the parts with data
  const have = out.parts.filter((p) => p.score != null);
  const w = have.reduce((s, p) => s + p.weight, 0);
  // the category match also scales the total: a channel that never shows the brand's field reaches at most half
  // (otherwise good labelling alone would make a beauty brand a "possible fit" for a tech channel – test E2)
  // without the category part there is nothing to compare the brand with → no total (labelling alone is no fit)
  const mean = w && out.parts[0].score != null ? have.reduce((s, p) => s + p.score * p.weight, 0) / w : null;
  if (out.parts[0].score == null) out.note = "No other brand with a known product field on this channel yet – nothing to compare with. Analyse more uploads.";
  out.gate = others.length ? 0.5 + 0.5 * (catScore / 100) : 1;
  out.score = mean == null ? null : Math.round(mean * out.gate);
  out.verdict = out.score == null ? null : out.score >= 70 ? "Strong fit" : out.score >= 45 ? "Possible fit" : "Weak fit";
  if (out.already.length && out.score != null) out.note = `${brand} already appears in ${out.already.length} analysed video${out.already.length === 1 ? "" : "s"} of this channel – it is counted as the brand itself, not as a competitor.`;
  return out;
}
