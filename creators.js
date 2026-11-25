/**
 * creators.js — "Find creators": POST /api/creators (Server-Sent Events, view #/creators in the app)
 *
 * The other direction of Channel fit: a brand and/or a product in ("headphones", "Sonos"), a ranked shortlist of
 * YouTube channels out – creators a brand could approach – each with a short profile. Steps, each streamed live:
 *
 *   field     product field of the input: product words (shared/fit.js categoryGroup), else the brand's field from our
 *             own analyses (channel.js brandField)                                                      → 0 requests
 *   search    1–2 YouTube searches about the product field ("<product> review", "best <product>")
 *             = agent.js searchVideos: Data API (101 units each) or the search page; cached 24 h per query
 *   group     search hits grouped by channel; the brand's own channel and channels with one tiny video are dropped;
 *             the top 8 by hits × log10(views) are looked at more closely
 *   channels  each candidate's latest 25 uploads (channel.js loadChannel: Data API 3 units, or channel page + RSS;
 *             cached 6 h) → how often it covers the topic, typical views, how active it is
 *   library   analyses we already have of these channels → competitors in the field, how ads are labelled
 *   score     rule-based creator score 0–100 (below), one sentence "why it fits", value of one placement (value.js)
 *   confirm   optional: one on-topic video of each of the top 3 analysed – only after the visitor's OK (≤ 3)
 *
 * Creator score (every part shown with its rule behind an (i) in the app):
 *   topic        35 %  share of the latest uploads whose title is about the product field; half or more = 100;
 *                      found by the search but no title on topic → 20
 *   reach        25 %  median views of the latest uploads on a log scale: 1,000 → 0, 1 million → 100
 *   activity     15 %  uploads in the last 90 days: ≥ 6 → 100, 3–5 → 70, 1–2 → 40, none → 0
 *   labels ads   15 %  only from videos we analysed (shared/fit.js disclosure part)  – else left out
 *   competition  10 %  only from videos we analysed (shared/fit.js competition part) – else left out
 *   total = weighted mean of the parts with data × (0.5 + 0.5 × topic / 100), like the channel fit.
 * `basis` says honestly what a score rests on: "metadata only" (titles, views, dates) or "+ n analysed videos".
 */
import { norm } from "./public/js/shared/aggregate.js";
import { categoryGroup, channelFit, GROUPS, GROUP_LABEL } from "./public/js/shared/fit.js";
import { brandValue } from "./public/js/value.js";
import { searchVideos, isOwnChannel, analyzeOne, messageFor, AGENT_MAX_NEW } from "./agent.js";
import { loadChannel, channelLibrary, placementRows, fillUnknownGroups, publicChannel, brandField } from "./channel.js";

const MAX_CANDIDATES = 8;          // channels looked at closely (each: 3 Data API units or one page fetch, cached 6 h)
const SHORTLIST = 8;               // channels in the report
export const CREATOR_WEIGHTS = { topic: 35, reach: 25, activity: 15, disclosure: 15, competition: 10 };

/** Search words per product field, used when only a brand is given (its field comes from our analyses). */
const FIELD_QUERY = { audio: "headphones", tech: "tech gadgets", gaming: "gaming setup", toys: "lego", beauty: "makeup", health: "supplements",
  food: "food", sport: "running", home: "home gadgets", fashion: "fashion haul", mobility: "car", retail: "haul" };
const STOP = new Set(["the", "and", "for", "von", "und", "der", "die", "das", "mit", "brand", "marke", "product", "produkt", "best", "beste", "review", "test"]);

export const CREATOR_MESSAGES = {
  invalid_creators: "Please enter a product (e.g. headphones) or a brand.",
  creators_limit: "You reached today's limit for new creator searches – searches from today still work.",
};

export async function creators(request, env, ctx, kit) {
  const body = await request.json().catch(() => ({}));
  const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f<>"]/g, "").trim().slice(0, n);
  const product = clean(body.product, 60), brand = clean(body.brand, 60);
  if (norm(product).length < 2 && norm(brand).length < 2) throw new kit.ApiError("invalid_creators", 400);
  const lang = ["en", "de"].includes(body.lang) ? body.lang : "any";
  const approve = Array.isArray(body.approve) ? [...new Set(body.approve.filter((x) => kit.ID_RE.test(x)))] : null;
  if (approve && approve.length > AGENT_MAX_NEW) throw new kit.ApiError("too_many", 400);

  return kit.sseResponse(ctx, async (send) => {
    const t0 = Date.now();
    const step = (id, status, title, detail = "", extra = {}) => send("step", { id, status, title, detail, at_s: Math.round((Date.now() - t0) / 1000), ...extra });
    const cost = { search_units: 0, channel_units: 0, searches_cached: 0, channels_cached: 0, gemini_requests: 0, new_analyses: 0, kv_reads: 0 };

    // ---- 1. product field ---------------------------------------------------------------------------------------------
    await step("field", "run", "Working out the product field");
    let group = product ? categoryGroup(product) : "other", fieldFrom = "product words";
    if (group === "other" && brand) { const f = await brandField(request, env, brand); if (f.group) { group = f.group; fieldFrom = `${brand} in ${f.seen} of our analyses`; } }
    const words = product.toLowerCase().split(/[\s,;/+]+/).map((w) => w.replace(/[^\p{L}\p{N}-]/gu, "")).filter((w) => w.length >= 3 && !STOP.has(w));
    const topicRx = topicRegex(words, group);
    const queries = product ? [`${product} review`, `best ${product}`] : group !== "other" ? [`${FIELD_QUERY[group]} review`, `best ${FIELD_QUERY[group]}`] : [`${brand} review`];
    await step("field", "done", "Product field", `${group !== "other" ? GROUP_LABEL[group] : "not one of our fields – topic words only"} (from ${group === "other" ? "the input" : fieldFrom}) · topic words: ${[...words, ...(group !== "other" ? [GROUP_LABEL[group].toLowerCase()] : [])].join(", ") || "–"} · searches: ${queries.map((q) => `“${q}”`).join(", ")}`,
      { group, queries });

    // ---- 2. search ---------------------------------------------------------------------------------------------------
    const scost = { search_units: 0, search_cached: false };
    let found = [];
    for (const q of queries) {
      await step(`search:${q}`, "run", `Searching YouTube for “${q}”`);
      try {
        scost.search_cached = false;
        const r = await searchVideos(request, env, kit, { q, lang, period: "any" }, scost);
        if (r.cached) cost.searches_cached += 1;
        found.push(...r.items.filter((it) => !found.some((f) => f.id === it.id)));
        await step(`search:${q}`, "done", `Searched YouTube for “${q}”`, `${r.items.length} videos${r.cached ? " · from today's search cache, 0 units" : ` · ${r.units} quota units`} · ${r.source === "data-api" ? "YouTube Data API" : "YouTube search page"}`);
      } catch (e) {
        await step(`search:${q}`, "fail", "YouTube search not possible", e?.detail || messageFor(e));
        if (!found.length) throw e;
      }
    }
    cost.search_units = scost.search_units;

    // ---- 3. group by channel -----------------------------------------------------------------------------------------
    const byCh = new Map();
    for (const v of found) {
      if (!v.channel || (brand && isOwnChannel(v.channel, brand))) continue;
      const k = v.channel_id || norm(v.channel);
      const e = byCh.get(k) || { channel_id: v.channel_id, channel: v.channel, hits: [], views: 0 };
      e.hits.push({ id: v.id, title: v.title, views: v.views, published: v.published, duration_s: v.duration_s }); e.views += v.views || 0;
      byCh.set(k, e);
    }
    const ranked = [...byCh.values()].filter((e) => e.channel_id && (e.hits.length > 1 || e.views >= 5000))
      .sort((a, b) => rankHint(b) - rankHint(a)).slice(0, MAX_CANDIDATES);
    await step("group", "done", "Grouping by channel", `${found.length} videos from ${byCh.size} channels · ${ranked.length} looked at closely (most search hits × views)${brand ? ` · ${brand}'s own channel left out` : ""}`);

    // ---- 4. channels: latest uploads of each candidate ------------------------------------------------------------------
    // one daily limit for the whole run (DAILY_CREATOR_RUNS); a repeat of the same search comes from the caches
    const uncached = await countUncached(env, ranked);
    if (uncached && !(await kit.withinLimit(env, request, "creators", Number(env.DAILY_CREATOR_RUNS || 6)))) throw new kit.ApiError("creators_limit", 429);
    const rows = [];
    for (const [i, c] of ranked.entries()) {
      await step("channels", "run", "Reading the candidates' channels", `${i + 1} of ${ranked.length}: ${c.channel}`);
      const ccost = { units: 0, cached: false };
      try {
        const ch = await loadChannel(request, env, kit, { kind: "id", value: c.channel_id }, ccost, { limit: false });
        cost.channel_units += ccost.units; if (ccost.cached) cost.channels_cached += 1;
        rows.push({ ch, hits: c.hits });
      } catch (e) { console.log(`creators: channel ${c.channel_id} skipped: ${e?.code || e?.message}`); }
    }
    await step("channels", "done", "Read the candidates' channels", `${rows.length} channels, latest ${rows[0]?.ch.uploads.length || 25} uploads each · ${cost.channels_cached} from the 6-hour cache · ${cost.channel_units} quota units`);

    // ---- 5. library + 6. score ---------------------------------------------------------------------------------------
    await step("library", "run", "Checking analyses we already have of these channels");
    const libs = [];
    for (const r of rows) {
      const lib = await channelLibrary(request, env, kit, r.ch, cost);
      const placements = placementRows(lib.map((x) => x.analysis));
      await fillUnknownGroups(request, env, placements, cost);
      libs.push({ lib, placements });
    }
    const analysedTotal = libs.reduce((n, l) => n + l.lib.length, 0);
    await step("library", "done", "Analyses we already have", analysedTotal ? `${analysedTotal} analysed video${analysedTotal === 1 ? "" : "s"} of ${libs.filter((l) => l.lib.length).length} of these channels – used for competitors and ad labels` : "none of these channels is analysed yet – the scores rest on titles, views and dates only");

    const shortlist = rows.map((r, i) => scoreCreator(r, libs[i], { group, topicRx, brand, product })).sort((a, b) => b.score - a.score).slice(0, SHORTLIST);
    await step("score", "done", "Ranking", `${shortlist.length} creators · ${shortlist.filter((s) => s.analysed).length} with analysed videos, the rest on metadata only`);

    // ---- 7. confirm (first call) or analyse what the visitor approved (second call) --------------------------------------
    const proposals = shortlist.slice(0, 3).map((s) => s.best_video ? { ...s.best_video, channel: s.channel.title } : null).filter(Boolean);
    const quota = await kit.quotaInfo(request, env);
    if (!approve) {
      if (proposals.length) {
        await send("confirm", { candidates: proposals.map((p) => ({ ...p, why: `most-viewed on-topic upload of ${p.channel}` })), preselected: [], quota, max_new: AGENT_MAX_NEW, per_video_requests: 3 });
        await step("confirm", "skip", "Optional: analyse one video each", "one on-topic video of each of the top 3 – adds competitors and ad labels to their scores; nothing is analysed without your OK");
      }
    } else {
      const allowed = new Set(proposals.map((p) => p.id));
      const todo = approve.filter((id) => allowed.has(id));
      if (approve.length && !todo.length) await step("confirm", "fail", "Nothing to analyse", "the selected videos are not among this shortlist's proposals");
      for (const [i, id] of todo.entries()) {
        const p = proposals.find((x) => x.id === id); const sid = `analyze:${id}`;
        await step(sid, "run", `Analysing ${i + 1} of ${todo.length}`, `${p.channel} – ${p.title}`, { video: { id, title: p.title } });
        try {
          const r = await analyzeOne(request, env, kit, id, (ev, data) => send("progress", { id, ev, data }));
          if (r.fresh) { cost.new_analyses += 1; cost.gemini_requests += (r.analysis.source?.usage || []).length; }
          await step(sid, "done", `Analysed ${i + 1} of ${todo.length}`, `${p.channel} – ${(r.analysis.brands || []).length} brands`);
        } catch (e) {
          await step(sid, "fail", `Analysis ${i + 1} of ${todo.length} not possible`, `${p.channel} – ${messageFor(e)}`);
          if (["quota_exhausted", "daily_limit"].includes(e?.code) || e?.status === 401 || e?.status === 403) break;
        }
      }
      if (todo.length) { // re-score with the new analyses
        for (const [i, r] of rows.entries()) { const lib = await channelLibrary(request, env, kit, r.ch, cost); const placements = placementRows(lib.map((x) => x.analysis)); await fillUnknownGroups(request, env, placements, cost); libs[i] = { lib, placements }; }
        shortlist.splice(0, shortlist.length, ...rows.map((r, i) => scoreCreator(r, libs[i], { group, topicRx, brand, product })).sort((a, b) => b.score - a.score).slice(0, SHORTLIST));
      }
    }

    await send("report", { query: { product, brand, lang, group, group_label: GROUP_LABEL[group] || null, field_from: fieldFrom, queries, words },
      shortlist, cost, pending: !approve && proposals.length ? proposals.length : 0, seconds: Math.round((Date.now() - t0) / 1000), generated_at: new Date().toISOString() });
  });
}

const rankHint = (e) => e.hits.length * 2 + Math.log10(e.views + 10);

async function countUncached(env, ranked) {
  if (!env.STORE) return ranked.length;
  let n = 0; for (const c of ranked) if (!(await env.STORE.get(`channel:${c.channel_id}`))) n += 1;
  return n;
}

/** Product words + the field's own keyword list → one regex for titles ("headphones" also finds "Kopfhörer", "earbuds"). */
function topicRegex(words, group) {
  const parts = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/e?s$/, "")); // "headphones" → "headphon"
  const field = GROUPS.find((g) => g.id === group)?.rx.source;
  const src = [...parts, ...(field ? [field] : [])].join("|");
  return src ? new RegExp(src, "i") : null;
}

const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x) && x > 0).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };
const clamp = (x) => Math.max(0, Math.min(100, Math.round(x)));
const fmtN = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** One candidate → score, parts, profile, value of one placement, the sentence "why it fits". */
export function scoreCreator({ ch, hits }, { lib, placements }, { group, topicRx, brand, product }) {
  const ups = ch.uploads || [];
  const onTopic = ups.filter((u) => topicRx && topicRx.test(u.title || ""));
  const share = ups.length ? onTopic.length / ups.length : 0;
  const topic = onTopic.length ? clamp((share / 0.5) * 100) : hits.length ? 20 : 0;
  const med = median(ups.map((u) => u.views));
  const reach = med ? clamp(((Math.log10(med) - 3) / 3) * 100) : null;
  const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const recent = ups.filter((u) => u.published && u.published >= since).length;
  const activity = ups.length ? (recent >= 6 ? 100 : recent >= 3 ? 70 : recent >= 1 ? 40 : 0) : null;
  const name = brand || product;
  const fit = lib.length ? channelFit({ placements, videos: lib.length }, name, { group: group !== "other" ? group : null }) : null;
  const fp = (id) => fit?.parts.find((p) => p.id === id);
  const label = product || GROUP_LABEL[group] || "this topic";
  const parts = [
    { id: "topic", label: "Topic match", weight: CREATOR_WEIGHTS.topic, score: topic,
      text: `${onTopic.length} of the latest ${ups.length} uploads are about ${label} (${Math.round(100 * share)} %); half or more = 100. Found ${hits.length}× by the search.` },
    { id: "reach", label: "Reach", weight: CREATOR_WEIGHTS.reach, score: reach,
      text: med ? `Median ${fmtN(med)} views over the latest uploads; log scale, 1,000 views → 0, 1 million → 100.` : "No view counts available." },
    { id: "activity", label: "Activity", weight: CREATOR_WEIGHTS.activity, score: activity,
      text: `${recent} upload${recent === 1 ? "" : "s"} in the last 90 days (dates of older uploads are approximate); ≥ 6 → 100, 3–5 → 70, 1–2 → 40.` },
    { id: "disclosure", label: "Labels its ads", weight: CREATOR_WEIGHTS.disclosure, score: fp("disclosure")?.score ?? null,
      text: fit ? fp("disclosure").text : "Unknown – none of this channel's videos is analysed yet." },
    { id: "competition", label: "Room next to competitors", weight: CREATOR_WEIGHTS.competition, score: fp("competition")?.score ?? null,
      text: fit ? fp("competition").text : "Unknown – none of this channel's videos is analysed yet." },
  ];
  const have = parts.filter((p) => p.score != null); const w = have.reduce((s, p) => s + p.weight, 0);
  const mean = w ? have.reduce((s, p) => s + p.score * p.weight, 0) / w : 0;
  const score = Math.round(mean * (0.5 + 0.5 * topic / 100));
  // value of ONE placement: the product clearly on screen for 60 s in the first minutes of a 10-minute video with the
  // channel's median views – same formula and scenarios as each video's Media value view (value.js)
  const value = med ? brandValue({ appearances: [{ channel: "visual", start_s: 60, end_s: 120, size: "medium" }, { channel: "audio", start_s: 60, end_s: 70 }] }, { views: med, duration_s: 600 }).range : null;
  const best = onTopic.filter((u) => u.duration_s && u.duration_s >= 60 && u.duration_s <= 1200 && !lib.some((x) => x.id === u.id)).sort((a, b) => (b.views || 0) - (a.views || 0))[0] || null;
  const why = [
    onTopic.length ? `${onTopic.length} of ${ups.length} latest uploads about ${label}` : `found by the search for ${label}, but few uploads on it`,
    med ? `~${fmtN(med)} views per video` : null,
    recent ? `${recent} upload${recent === 1 ? "" : "s"} in 3 months` : "no upload in 3 months",
    fit?.competitors?.length ? `already shows ${fit.competitors.slice(0, 2).map((c) => c.brand).join(" and ")}` : null,
    fit?.already?.length ? `${name} already appears in ${fit.already.length} analysed video${fit.already.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return {
    channel: publicChannel(ch), score, verdict: score >= 70 ? "Strong candidate" : score >= 45 ? "Worth a look" : "Weak match",
    basis: lib.length ? `metadata + ${lib.length} analysed video${lib.length === 1 ? "" : "s"}` : "metadata only", analysed: lib.length,
    parts, why: why.join(" · "), value, median_views: med, recent, on_topic: onTopic.length, uploads: ups.length,
    topics: topicsOf(ups), competitors: fit?.competitors?.slice(0, 6) || [], already: fit?.already?.length || 0,
    hits: hits.slice(0, 3), best_video: best ? { id: best.id, title: best.title, views: best.views, duration_s: best.duration_s, published: best.published } : null,
    examples: [...onTopic].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 3).map((u) => ({ id: u.id, title: u.title, views: u.views, published: u.published })),
  };
}

/** Rough topics of a channel: product fields of its latest upload titles (keyword list), most frequent first. */
function topicsOf(ups) {
  const m = {};
  for (const u of ups) { const g = categoryGroup(u.title); if (g !== "other") m[g] = (m[g] || 0) + 1; }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([g, n]) => ({ group: g, label: GROUP_LABEL[g], uploads: n }));
}
