/**
 * agent.js — the brand agent: POST /api/agent  (Server-Sent Events, view #/agent in the app)
 *
 * Input: a brand ("Sonos"), optionally language and period. The agent plans its own steps, shows each one live and
 * spends quota only where the visitor allowed it:
 *
 *   plan      fixed tool chain + budgets derived from the input (rule-based, see MODELS.md "Brand agent")
 *   library   analyses we already have (repo examples + KV cache) that contain the brand      → 0 requests
 *   search    YouTube search for the brand                                                    → 100 units (Data API),
 *             re-planned once with "<brand> review" when too few usable videos come back        cached 24 h per query
 *   filter    1–20 min, ≥ 1,000 views, period, not the brand's own channel
 *   pick      score = brand in title / description, views, recency; cached videos always first
 *   confirm   up to 3 NEW analyses, only after the visitor ticks them in the UI (second request with `approve`);
 *             the event carries today's quota so the visitor sees what a click costs (≈ 3 Gemini requests per video)
 *   analyze   the same pipeline and limits as /api/analyze (analyzeVideo in worker.js)
 *   aggregate shared/aggregate.js summarize() → videos, screen time, paid/labelled, media value range, creators, findings
 *
 * The request is idempotent: the first call (no `approve`) plans, searches, reports from the cache and asks; the
 * second call (with `approve: [ids]`) repeats the cheap steps from the cache (search costs nothing the second time)
 * and runs only the approved analyses. No state lives on the server between the two calls.
 *
 * SSE events: step {id, status: run|done|skip|fail, title, detail} · progress {id, ev, data} (inner analysis events) ·
 *             confirm {candidates, preselected, quota, max_new} · report {summary, plan, cost} · error · ping
 */
import { summarize, brandMatches, norm } from "./public/js/shared/aggregate.js";

export const AGENT_MAX_NEW = 3;                 // new Gemini analyses per run (each ≈ 3 requests: timeline, re-check, authenticity)
const LIBRARY_MAX_READS = 80;                   // KV reads per run for analyses without the brand list in their metadata
const SEARCH_TTL_S = 60 * 60 * 24;              // a search result is reused for one day (YouTube changes slowly)
const MIN_VIEWS = 1000;
const OWN_CHANNEL_SUFFIX = /^(official|global|de|deutschland|germany|us|usa|uk|support|tv|channel|music)?$/;
const PERIODS = { any: null, "1y": 365, "2y": 730, "5y": 1825 };
const LANGS = { any: null, en: { hl: "en", region: "US" }, de: { hl: "de", region: "DE" } };

/**
 * @param kit helpers from worker.js (passed in to avoid a circular import):
 *   ApiError, sseResponse, analyzeVideo, cachedAnalysis, geminiDenied, withinLimit, bumpGlobal, exhaustedModels,
 *   videoModels, quotaInfo, sha256, BROWSER_HEADERS, ID_RE
 */
export async function agent(request, env, ctx, kit) {
  const body = await request.json().catch(() => ({}));
  const brand = String(body.brand || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60);
  if (norm(brand).length < 2) throw new kit.ApiError("invalid_brand", 400);
  const lang = LANGS[body.lang] !== undefined ? body.lang : "any";
  const period = PERIODS[body.period] !== undefined ? body.period : "any";
  const max = Math.max(4, Math.min(12, Number(body.max) || 8));          // videos in the report (cached + new)
  const approve = Array.isArray(body.approve) ? [...new Set(body.approve.filter((x) => kit.ID_RE.test(x)))] : null;
  if (approve && approve.length > AGENT_MAX_NEW) throw new kit.ApiError("too_many", 400);

  return kit.sseResponse(ctx, async (send) => {
    const t0 = Date.now();
    const step = (id, status, title, detail = "", extra = {}) => send("step", { id, status, title, detail, at_s: Math.round((Date.now() - t0) / 1000), ...extra });
    const cost = { search_units: 0, search_cached: false, gemini_requests: 0, new_analyses: 0, kv_reads: 0 };

    // ---- 1. plan ------------------------------------------------------------------------------------------------
    const plan = {
      brand, lang, period, max, max_new: AGENT_MAX_NEW,
      queries: [brand], // a second query ("<brand> review") is added only if the first one is too thin (re-plan)
      rules: [`length 1–20 min`, `≥ ${MIN_VIEWS.toLocaleString("en")} views`, ...(period !== "any" ? [`uploaded in the last ${period.replace("y", " year")}${period === "1y" ? "" : "s"}`] : []),
        `not ${brand}'s own channel (owned media, no placement)`],
    };
    await step("plan", "done", "Plan", `1 · look in the analyses we already have · 2 · search YouTube for “${brand}”${lang !== "any" ? ` (${lang === "de" ? "German" : "English"})` : ""} · 3 · keep videos: ${plan.rules.join(", ")} · 4 · use cached analyses first, at most ${AGENT_MAX_NEW} new ones and only with your OK · 5 · combine everything into one brand report`, { plan });

    // ---- 2. library: what do we already know? -------------------------------------------------------------------
    await step("library", "run", "Checking analyses we already have");
    const lib = await scanLibrary(request, env, kit, brand, cost);
    await step("library", "done", "Analyses we already have",
      lib.matches.length ? `${lib.matches.length} of ${lib.total} analysed videos contain ${brand} (${countBy(lib.matches, "source")}) – 0 requests` : `none of ${lib.total} analysed videos contains ${brand} yet`,
      { videos: lib.matches.map((m) => brief(m.analysis)) });

    // ---- 3. search (+ re-plan once) -----------------------------------------------------------------------------
    let found = [], searchOk = true, searchSource = null;
    for (const q of plan.queries) {
      await step(`search:${q}`, "run", `Searching YouTube for “${q}”`);
      try {
        const r = await searchVideos(request, env, kit, { q, lang, period }, cost);
        searchSource = r.source;
        const fresh = r.items.filter((it) => !found.some((f) => f.id === it.id));
        found.push(...fresh);
        await step(`search:${q}`, "done", `Searched YouTube for “${q}”`, `${r.items.length} videos${r.cached ? " · from today's search cache, 0 units" : ` · ${r.units} quota units`} · ${r.source === "data-api" ? "YouTube Data API" : "YouTube search page"}`);
      } catch (e) {
        searchOk = false;
        await step(`search:${q}`, "fail", `YouTube search not possible`, e?.detail || messageFor(e), {});
        break;
      }
      // re-plan: too few usable videos → one more, more specific query (reviews are where placements happen)
      const usable = filterVideos(found, brand, period).kept.length;
      if (plan.queries.length === 1 && usable < Math.ceil(max / 2) && usable < 12) {
        plan.queries.push(`${brand} review`);
        await step("replan", "done", "Adjusting the plan", `only ${usable} usable videos – adding a second search “${brand} review”`);
      }
    }

    // ---- 4. filter ----------------------------------------------------------------------------------------------
    const { kept, dropped } = filterVideos(found, brand, period);
    if (searchOk || found.length) {
      await step("filter", "done", "Filtering", `${kept.length} of ${found.length} kept${Object.keys(dropped).length ? ` – left out: ${Object.entries(dropped).map(([k, n]) => `${n} ${k}`).join(", ")}` : ""}`);
    }

    // ---- 5. pick: cached first, then the best uncached ones as proposals ---------------------------------------
    const libIds = new Set(lib.matches.map((m) => m.id));
    const cachedNoMatch = [];   // in the search results, analysed before, but Gemini found no such brand
    const proposals = [];
    for (const v of kept.sort((a, b) => score(b, brand) - score(a, brand))) {
      if (libIds.has(v.id)) continue;
      if (lib.allIds.has(v.id)) { cachedNoMatch.push(v.id); continue; }
      proposals.push({ ...v, score: Math.round(10 * score(v, brand)) / 10, why: why(v, brand) });
    }
    const room = Math.max(AGENT_MAX_NEW, max - lib.matches.length);
    const shortlist = proposals.slice(0, Math.min(6, room + 3));
    const preselected = shortlist.slice(0, Math.min(AGENT_MAX_NEW, room)).map((v) => v.id);
    await step("pick", "done", "Choosing videos",
      `${lib.matches.length} from the cache${searchOk ? ` · ${shortlist.length} new candidates, ranked by brand in title, views and recency` : ""}${cachedNoMatch.length ? ` · ${cachedNoMatch.length} search result${cachedNoMatch.length === 1 ? " was" : "s were"} analysed before without ${brand}` : ""}`);

    // ---- 6. confirm (first call) or analyse what the visitor approved (second call) -----------------------------
    const quota = await kit.quotaInfo(request, env);
    const newAnalyses = [];
    if (!approve) {
      if (shortlist.length) {
        await send("confirm", { candidates: shortlist, preselected, quota, max_new: AGENT_MAX_NEW, per_video_requests: 3 });
        await step("confirm", "skip", "Waiting for your OK", `up to ${AGENT_MAX_NEW} new analyses (≈ 3 Gemini requests each) – the report below uses cached analyses only until you confirm`);
      }
    } else {
      const allowed = new Set(shortlist.map((v) => v.id).concat(proposals.map((v) => v.id)));
      const todo = approve.filter((id) => allowed.has(id));
      if (approve.length && !todo.length) await step("confirm", "fail", "Nothing to analyse", "the selected videos are not among this search's candidates");
      else if (todo.length) await step("confirm", "done", "Confirmed", `${todo.length} new analys${todo.length === 1 ? "is" : "es"} approved · ${quota.left_requests} Gemini requests left today`);
      for (const [i, id] of todo.entries()) {
        const meta = proposals.find((p) => p.id === id) || { id, title: id };
        const sid = `analyze:${id}`;
        await step(sid, "run", `Analysing ${i + 1} of ${todo.length}`, meta.title, { video: { id, title: meta.title, channel: meta.channel } });
        try {
          const r = await analyzeOne(request, env, kit, id, (ev, data) => send("progress", { id, ev, data }));
          if (r.fresh) { cost.new_analyses += 1; cost.gemini_requests += (r.analysis.source?.usage || []).length; }
          newAnalyses.push({ id, analysis: r.analysis, source: r.fresh ? "new" : r.analysis.cached || "store" });
          const hit = (r.analysis.brands || []).filter((b) => brandMatches(brand, b));
          await step(sid, "done", `Analysed ${i + 1} of ${todo.length}`, hit.length ? `${meta.title} – ${brand} found (${hit.map((b) => b.brand).join(", ")})` : `${meta.title} – Gemini found no ${brand} in it, left out of the totals`,
            { video: { id, title: meta.title, channel: meta.channel } });
        } catch (e) {
          await step(sid, "fail", `Analysis ${i + 1} of ${todo.length} not possible`, `${meta.title} – ${messageFor(e)}`);
          if (e?.code === "quota_exhausted" || e?.code === "daily_limit" || e?.status === 401 || e?.status === 403) break; // the next one would fail the same way
        }
      }
    }

    // ---- 7. aggregate + report ----------------------------------------------------------------------------------
    await step("aggregate", "run", "Combining the results");
    const extra = [];
    for (const id of cachedNoMatch.slice(0, 6)) { const a = await kit.cachedAnalysis(request, env, id); cost.kv_reads += 1; if (a) extra.push({ id, analysis: a, source: a.cached }); }
    const all = [...lib.matches, ...newAnalyses, ...extra];
    const source = Object.fromEntries(all.map((x) => [x.id, x.source]));
    const summary = summarize(all.map((x) => x.analysis), { match: brand, source });
    await step("aggregate", "done", "Combined the results",
      `${summary.totals.videos} video${summary.totals.videos === 1 ? "" : "s"} with ${brand} · ${summary.findings.filter((f) => f.kind === "warn").length} finding${summary.findings.filter((f) => f.kind === "warn").length === 1 ? "" : "s"} to check`);
    await send("report", { summary, plan: { ...plan, search_ok: searchOk, search_source: searchSource }, cost, pending: !approve && shortlist.length ? shortlist.length : 0, seconds: Math.round((Date.now() - t0) / 1000) });
  });
}

// --------------------------------------------------------------------------------------------------------------
// library: repo examples + KV cache
// --------------------------------------------------------------------------------------------------------------
/**
 * Every analysis we already have that contains the brand. Examples come from public/data (static files, free);
 * KV entries carry the brand names in their key metadata since 23 Nov (`names`), so only matching entries are read.
 * Older entries without names are read once each (at most LIBRARY_MAX_READS per run).
 */
async function scanLibrary(request, env, kit, brand, cost) {
  const out = [], allIds = new Set(); let total = 0;
  const asset = async (p) => { const r = await env.ASSETS.fetch(new Request(new URL(p, request.url))); return r.ok ? r.json() : null; };
  const demos = (await asset("/data/index.json").catch(() => null)) || [];
  for (const d of demos) {
    allIds.add(d.id); total += 1;
    const a = await asset(`/data/${d.id}.json`).catch(() => null);
    if (a && (a.brands || []).some((b) => brandMatches(brand, b))) out.push({ id: d.id, analysis: { ...a, cached: "demo" }, source: "demo" });
  }
  if (!env.STORE) return { matches: out, allIds, total };
  let cursor, reads = 0;
  do {
    const page = await env.STORE.list({ prefix: "analysis:", cursor, limit: 1000 });
    for (const k of page.keys) {
      const id = k.name.slice(9);
      if (allIds.has(id)) continue; // an example with the same id wins (as in /api/analyze)
      allIds.add(id); total += 1;
      const names = k.metadata?.names;
      if (names != null && !String(names).split("|").some((n) => brandMatches(brand, { brand: n }) || norm(n).includes(norm(brand)))) continue;
      if (names == null && reads >= LIBRARY_MAX_READS) continue;
      reads += 1;
      const a = await env.STORE.get(k.name, "json");
      if (a && (a.brands || []).some((b) => brandMatches(brand, b))) out.push({ id, analysis: { ...a, cached: "store" }, source: "store" });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  cost.kv_reads += reads;
  return { matches: out, allIds, total };
}

// --------------------------------------------------------------------------------------------------------------
// search: YouTube Data API v3 (official) – or, without a key, the public search page
// --------------------------------------------------------------------------------------------------------------
/**
 * Two sources, best first:
 *   1. Data API v3 (secret YOUTUBE_API_KEY): search.list = 100 units, videos.list for length/views/description = 1 unit.
 *      Free quota 10,000 units/day → a global cap (DAILY_SEARCHES, default 60 = 6,000 units) leaves room for /api/meta.
 *   2. youtube.com/results (no key): the page data (ytInitialData) holds the same list. Works locally; online YouTube
 *      may answer the Worker's data-centre IP with a bot check (as on the watch page, 20 Nov) – then the step fails
 *      honestly and the agent reports from the cache only.
 * Results are cached for a day per query (KV `agentsearch:<hash>`), so the confirm round trip costs nothing.
 */
async function searchVideos(request, env, kit, { q, lang, period }, cost) {
  const key = `agentsearch:${await kit.sha256(JSON.stringify([q.toLowerCase(), lang, period, env.YOUTUBE_API_KEY ? "api" : "page"]))}`;
  const hit = env.STORE && (await env.STORE.get(key, "json"));
  if (hit) { cost.search_cached = true; return { ...hit, cached: true, units: 0 }; }
  if (!(await kit.withinLimit(env, request, "agent-search", Number(env.DAILY_AGENT_SEARCHES || 10)))) throw new kit.ApiError("agent_limit", 429);
  if (!(await kit.bumpGlobal(env, "yt-search", Number(env.DAILY_SEARCHES || 60)))) throw new kit.ApiError("search_quota", 429);
  const r = env.YOUTUBE_API_KEY ? await searchDataApi(env.YOUTUBE_API_KEY, q, lang, period) : await searchPage(kit, q, lang);
  cost.search_units += r.units;
  if (env.STORE && r.items.length) await env.STORE.put(key, JSON.stringify(r), { expirationTtl: SEARCH_TTL_S });
  return { ...r, cached: false };
}

async function searchDataApi(apiKey, q, lang, period) {
  const p = new URLSearchParams({ part: "snippet", type: "video", maxResults: "25", q, videoDuration: "medium", // medium = 4–20 min
    order: "relevance", safeSearch: "moderate", key: apiKey });
  if (LANGS[lang]) { p.set("relevanceLanguage", LANGS[lang].hl); p.set("regionCode", LANGS[lang].region); }
  if (PERIODS[period]) p.set("publishedAfter", new Date(Date.now() - PERIODS[period] * 864e5).toISOString());
  const s = await fetch(`https://www.googleapis.com/youtube/v3/search?${p}`);
  if (!s.ok) throw Object.assign(new Error(`search.list HTTP ${s.status}`), { detail: `YouTube Data API answered HTTP ${s.status}` });
  const ids = ((await s.json()).items || []).map((it) => it.id?.videoId).filter(Boolean);
  if (!ids.length) return { source: "data-api", units: 100, items: [] };
  const d = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${ids.join(",")}&key=${apiKey}`);
  const items = d.ok ? ((await d.json()).items || []).map((it) => ({
    id: it.id, title: it.snippet?.title || "", channel: it.snippet?.channelTitle || "", channel_id: it.snippet?.channelId || null,
    views: it.statistics?.viewCount ? Number(it.statistics.viewCount) : null, duration_s: isoDuration(it.contentDetails?.duration),
    published: it.snippet?.publishedAt?.slice(0, 10) || null, description: String(it.snippet?.description || "").slice(0, 600),
    live: it.snippet?.liveBroadcastContent && it.snippet.liveBroadcastContent !== "none",
  })) : [];
  return { source: "data-api", units: 101, items };
}

async function searchPage(kit, q, lang) {
  const hl = LANGS[lang]?.hl || "en", gl = LANGS[lang]?.region || "US";
  const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D&hl=${hl}&gl=${gl}`, { headers: { ...kit.BROWSER_HEADERS, "accept-language": hl } });
  const html = r.ok ? await r.text() : "";
  const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});<\/script>/s);
  let data = null; try { data = m ? JSON.parse(m[1]) : null; } catch { /* format changed */ }
  if (!data) throw Object.assign(new Error("no search data"), { detail: `YouTube's search page gave no results to the server (HTTP ${r.status}${r.ok ? ", probably a bot check" : ""}) – set YOUTUBE_API_KEY for the official API` });
  const items = [];
  (function walk(o) {
    if (!o || typeof o !== "object" || items.length >= 30) return;
    if (o.videoRenderer) {
      const v = o.videoRenderer;
      const text = (t) => t?.simpleText || (t?.runs || []).map((x) => x.text).join("") || "";
      items.push({ id: v.videoId, title: text(v.title), channel: text(v.ownerText), channel_id: v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,
        views: Number(text(v.viewCountText).replace(/[^\d]/g, "")) || null, duration_s: clock(text(v.lengthText)),
        published: relativeDate(text(v.publishedTimeText)), description: (v.detailedMetadataSnippets || []).map((s) => text(s.snippetText)).join(" ").slice(0, 600),
        live: !v.lengthText });
      return;
    }
    for (const x of Array.isArray(o) ? o : Object.values(o)) walk(x);
  })(data);
  return { source: "youtube-page", units: 0, items: items.filter((it) => kit.ID_RE.test(it.id || "")) };
}

const isoDuration = (s) => { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || ""); return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : null; };
/** "14:09" / "1:02:03" → seconds */
const clock = (t) => (/^\d+(:\d{2}){1,2}$/.test(t) ? t.split(":").reduce((n, p) => n * 60 + Number(p), 0) : null);
/** "8 days ago" / "vor 2 Jahren" → approximate ISO date (the page only gives relative ages) */
function relativeDate(t) {
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year|sekunde|minute|stunde|tag|woche|monat|jahr)/i.exec(t || "");
  if (!m) return null;
  const unit = m[2].toLowerCase(); const days = { second: 0, sekunde: 0, minute: 0, hour: 0, stunde: 0, day: 1, tag: 1, week: 7, woche: 7, month: 30, monat: 30, year: 365, jahr: 365 }[unit] ?? 0;
  return new Date(Date.now() - Number(m[1]) * days * 864e5).toISOString().slice(0, 10);
}

// --------------------------------------------------------------------------------------------------------------
// filter + score (the "rules" of the plan)
// --------------------------------------------------------------------------------------------------------------
/** Is this the brand's own channel? "Sonos", "Apple Support", "DJI Official" yes – "DJI Mavic Fan" no. */
export const isOwnChannel = (channel, brand) => { const c = norm(channel), b = norm(brand); return !!b && c.startsWith(b) && OWN_CHANNEL_SUFFIX.test(c.slice(b.length)); };

export function filterVideos(items, brand, period) {
  const kept = [], dropped = {};
  const drop = (why) => { dropped[why] = (dropped[why] || 0) + 1; };
  const since = PERIODS[period] ? new Date(Date.now() - PERIODS[period] * 864e5).toISOString().slice(0, 10) : null;
  for (const v of items) {
    if (v.live || v.duration_s == null) drop("live or without length");
    else if (v.duration_s < 60) drop("shorter than 1 min");
    else if (v.duration_s > 1200) drop("longer than 20 min");
    else if ((v.views ?? 0) < MIN_VIEWS) drop(`under ${MIN_VIEWS.toLocaleString("en")} views`);
    else if (since && v.published && v.published < since) drop("too old");
    else if (isOwnChannel(v.channel, brand)) drop(`${brand}'s own channel`);
    else kept.push(v);
  }
  return { kept, dropped };
}

/** Higher = more likely a real placement with reach. Brand in the title is the strongest hint. */
export function score(v, brand) {
  const b = norm(brand);
  const inTitle = norm(v.title).includes(b), inDesc = norm(v.description).includes(b);
  const ageDays = v.published ? (Date.now() - Date.parse(v.published)) / 864e5 : 9999;
  return (inTitle ? 3 : 0) + (inDesc ? 1 : 0) + Math.log10((v.views || 0) + 1) + (ageDays < 365 ? 1 : ageDays < 730 ? 0.5 : 0);
}
const why = (v, brand) => [norm(v.title).includes(norm(brand)) ? "brand in title" : norm(v.description).includes(norm(brand)) ? "brand in description" : "search hit",
  v.views ? `${v.views >= 1e6 ? `${(v.views / 1e6).toFixed(1)}M` : v.views >= 1e3 ? `${Math.round(v.views / 1e3)}k` : v.views} views` : null].filter(Boolean).join(" · ");

// --------------------------------------------------------------------------------------------------------------
// one approved analysis – same order and limits as /api/analyze
// --------------------------------------------------------------------------------------------------------------
async function analyzeOne(request, env, kit, v, send) {
  const cached = await kit.cachedAnalysis(request, env, v);
  if (cached) return { analysis: cached, fresh: false };                       // someone analysed it in the meantime
  const denied = kit.geminiDenied(request, env);
  if (denied) throw new kit.ApiError(denied, denied === "invite_required" ? 401 : 403);
  const models = kit.videoModels(env);
  if ((await kit.exhaustedModels(env, models)).length >= models.length) throw new kit.ApiError("quota_exhausted", 429);
  if (env.STORE && (await env.STORE.get(`pending:${v}`))) throw new kit.ApiError("running", 409);
  if (!(await kit.withinLimit(env, request, "analyze", Number(env.DAILY_ANALYSES || 10)))) throw new kit.ApiError("daily_limit", 429);
  if (env.STORE) await env.STORE.put(`pending:${v}`, String(Date.now()), { expirationTtl: 900 });
  try {
    return { analysis: await kit.analyzeVideo(env, v, models, send), fresh: true };
  } finally {
    if (env.STORE) await env.STORE.delete(`pending:${v}`);
  }
}

// --------------------------------------------------------------------------------------------------------------
const AGENT_MESSAGES = {
  agent_limit: "You reached today's limit for agent searches – cached analyses still work.",
  search_quota: "Today's YouTube search budget is used up – cached analyses still work.",
  running: "this video is being analysed right now by someone else – it will be in the cache in a few minutes",
};
function messageFor(e) {
  return AGENT_MESSAGES[e?.code] || e?.visitorMessage || ({
    quota_exhausted: "today's free Gemini quota is used up", daily_limit: "your daily limit for new analyses is reached",
    invite_required: "new analyses need an invite code", own_key_required: "new analyses are switched off", server_key_missing: "the server has no Gemini key",
    video_too_long: "longer than 20 minutes", busy: "Google's AI is overloaded – try again later", bad_answer: "Gemini's answer was unreadable",
  }[e?.code]) || String(e?.message || e).slice(0, 160);
}
const brief = (a) => ({ id: a.video?.id, title: a.video?.title, channel: a.video?.channel });
const countBy = (rows, k) => Object.entries(rows.reduce((m, r) => ((m[r[k]] = (m[r[k]] || 0) + 1), m), {})).map(([s, n]) => (s === "demo" ? `${n} example${n === 1 ? "" : "s"}` : `${n} saved by visitors`)).join(", ");
export { AGENT_MESSAGES };
