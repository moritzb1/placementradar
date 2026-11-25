/**
 * channel.js — the channel view: POST /api/channel (Server-Sent Events, view #/channel/<id or @handle> in the app)
 *            and GET /api/brandcat?b=<brand> (which product field a brand belongs to, from our own analyses)
 *
 * Input: a channel as @handle, channel URL, channel id (UC…) or the link of one of its videos.
 * Steps, each shown live in the UI (same step format as the brand agent, agent.js):
 *
 *   resolve   handle / URL / id → channel id, title, avatar, subscribers
 *   uploads   the latest ~25 uploads (title, date, views, length)
 *             with YOUTUBE_API_KEY: channels.list (1 unit) + playlistItems.list (1 unit) + videos.list (1 unit)
 *             without:              the channel's /videos page (titles, views, length) + its RSS feed (exact dates,
 *                                   descriptions of the latest 15) – no key, no quota
 *             both are cached in KV for 6 h per channel (KV `channel:<id>`), so reloading costs nothing
 *   library   every analysis we already have of this channel – repo examples + KV cache, matched by video id or
 *             by channel name (older videos outside the latest 25 count too)                     → 0 requests
 *   audience  comments already loaded for those videos (KV `comments:*`, Audience tab) – read only, never fetched
 *   confirm   up to 3 NEW analyses of uploads, only after the visitor ticks them (second request with `approve`),
 *             with today's Gemini budget; ranked by ad hints in the description (sponsor words, shop links), then views
 *   analyze   the same pipeline and limits as /api/analyze (agent.js analyzeOne)
 *   report    shared/aggregate.js summarize(match = null) → recurring brands, sponsors per month, labelled share,
 *             media value per month; plus one row per brand and video for the fit check (shared/fit.js, in the browser)
 *
 * Like the agent, the request is idempotent and keeps no state on the server between "ask" and "approve".
 */
import { summarize, norm } from "./public/js/shared/aggregate.js";
import { categoryGroup, GROUP_LABEL } from "./public/js/shared/fit.js";
import { screenTime, isUnknownBrand } from "./public/js/shared/normalize.js";
import { checkDisclosure } from "./public/js/disclosure.js";
import { RULES_VERSION } from "./public/js/shared/comments.js";
import { analyzeOne, messageFor, AGENT_MAX_NEW } from "./agent.js";

const CHANNEL_TTL_S = 6 * 60 * 60;      // uploads list cached 6 h (a creator uploads a few times a week)
const MAX_UPLOADS = 25;
const MAX_LIBRARY = 40;                 // analyses of one channel read per run (KV reads)
const UC_RE = /^UC[\w-]{22}$/;
const HANDLE_RE = /^@[\w.\-·]{3,40}$/;

export const CHANNEL_MESSAGES = {
  invalid_channel: "Please enter a channel: @handle, channel link or the link of one of its videos.",
  channel_not_found: "YouTube does not know this channel – check the spelling of the @handle.",
  channel_limit: "You reached today's limit for new channel look-ups – channels opened before still work.",
};

/** "youtube.com/@mkbhd/videos", "@MKBHD", "UCBJyc…", "https://youtu.be/<video>" → { kind, value } or null */
export function parseChannelInput(raw) {
  const s = String(raw || "").trim().replace(/[\u0000-\u001f<>"]/g, "").slice(0, 200);
  if (!s) return null;
  const id = s.match(/(?:channel\/)?(UC[\w-]{22})(?:[/?#]|$)/); if (id) return { kind: "id", value: id[1] };
  const h = s.match(/(?:youtube\.com\/)?(@[\w.\-·]{3,40})/); if (h) return { kind: "handle", value: h[1] };
  const v = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/); if (v) return { kind: "video", value: v[1] };
  const c = s.match(/youtube\.com\/(?:c|user)\/([\w.-]{2,60})/); if (c) return { kind: "legacy", value: c[1] };
  if (/^[\w.\-·]{3,40}$/.test(s)) return { kind: "handle", value: `@${s}` }; // bare "mkbhd"
  return null;
}

// ------------------------------------------------------------------------------------------------
// POST /api/channel {c, approve?}
// ------------------------------------------------------------------------------------------------
export async function channel(request, env, ctx, kit) {
  const body = await request.json().catch(() => ({}));
  const input = parseChannelInput(body.c);
  if (!input) throw new kit.ApiError("invalid_channel", 400);
  const approve = Array.isArray(body.approve) ? [...new Set(body.approve.filter((x) => kit.ID_RE.test(x)))] : null;
  if (approve && approve.length > AGENT_MAX_NEW) throw new kit.ApiError("too_many", 400);

  return kit.sseResponse(ctx, async (send) => {
    const t0 = Date.now();
    const step = (id, status, title, detail = "", extra = {}) => send("step", { id, status, title, detail, at_s: Math.round((Date.now() - t0) / 1000), ...extra });
    const cost = { units: 0, cached: false, gemini_requests: 0, new_analyses: 0, kv_reads: 0 };

    // ---- 1 + 2. resolve the channel and list its uploads (one cached bundle) -------------------------------------
    await step("resolve", "run", "Finding the channel");
    let ch;
    try { ch = await loadChannel(request, env, kit, input, cost); }
    catch (e) { await step("resolve", "fail", "Channel not found", messageFor(e)); throw e; }
    await step("resolve", "done", ch.title, `${ch.handle || ch.id}${ch.subscribers ? ` · ${ch.subscribers}` : ""} · ${ch.source === "data-api" ? "YouTube Data API" : "YouTube channel page + RSS feed"}${cost.cached ? " · from the 6-hour cache, 0 units" : ` · ${cost.units} quota units`}`,
      { channel: publicChannel(ch) });
    await step("uploads", "done", "Latest uploads", `${ch.uploads.length} videos${ch.uploads.length ? `, ${ch.uploads.at(-1).published || "?"} – ${ch.uploads[0].published || "?"}` : ""} · Shorts and live streams left out`);

    // ---- 3. library: analyses we already have of this channel -----------------------------------------------------
    await step("library", "run", "Checking analyses we already have");
    const lib = await channelLibrary(request, env, kit, ch, cost);
    const inLatest = lib.filter((x) => ch.uploads.some((u) => u.id === x.id)).length;
    await step("library", "done", "Analyses we already have", lib.length
      ? `${lib.length} analysed video${lib.length === 1 ? "" : "s"} of ${ch.title} (${inLatest} among the latest ${ch.uploads.length}) – 0 requests`
      : `none of ${ch.title}'s videos is analysed yet`);

    // ---- 4. audience: comments already cached (never fetched here) -------------------------------------------------
    const audience = await cachedAudience(env, lib.map((x) => x.id), cost);
    await step("audience", "done", "Audience reactions", Object.keys(audience).length
      ? `cached comments for ${Object.keys(audience).length} of ${lib.length} analysed video${lib.length === 1 ? "" : "s"} – used for the fit check`
      : "no comments cached yet – open a video's Audience tab to load them (not done here, to save quota)");

    // ---- 5. confirm (first call) or analyse what the visitor approved (second call) -------------------------------
    const libIds = new Set(lib.map((x) => x.id));
    const candidates = ch.uploads.filter((u) => !libIds.has(u.id) && u.duration_s && u.duration_s >= 60 && u.duration_s <= Number(env.MAX_VIDEO_S || 1200))
      .map((u) => ({ ...u, ...hint(u) })).sort((a, b) => b.hint_score - a.hint_score || (b.views || 0) - (a.views || 0));
    const shortlist = candidates.slice(0, 8);
    const preselected = shortlist.filter((u) => u.hint_score > 0).slice(0, AGENT_MAX_NEW).map((u) => u.id);
    const quota = await kit.quotaInfo(request, env);
    const fresh = [];
    if (!approve) {
      if (shortlist.length) {
        await send("confirm", { candidates: shortlist.map(({ description, ...u }) => u), preselected, quota, max_new: AGENT_MAX_NEW, per_video_requests: 3 });
        await step("confirm", "skip", "Waiting for your OK", `up to ${AGENT_MAX_NEW} new analyses (≈ 3 Gemini requests each) – the report below uses analysed videos only until you confirm`);
      }
    } else {
      const allowed = new Set(candidates.map((u) => u.id));
      const todo = approve.filter((id) => allowed.has(id));
      if (approve.length && !todo.length) await step("confirm", "fail", "Nothing to analyse", "the selected videos are not among this channel's latest uploads");
      else if (todo.length) await step("confirm", "done", "Confirmed", `${todo.length} new analys${todo.length === 1 ? "is" : "es"} approved · ${quota.left_requests} Gemini requests left today`);
      for (const [i, id] of todo.entries()) {
        const meta = ch.uploads.find((u) => u.id === id) || { id, title: id };
        const sid = `analyze:${id}`;
        await step(sid, "run", `Analysing ${i + 1} of ${todo.length}`, meta.title, { video: { id, title: meta.title } });
        try {
          const r = await analyzeOne(request, env, kit, id, (ev, data) => send("progress", { id, ev, data }));
          if (r.fresh) { cost.new_analyses += 1; cost.gemini_requests += (r.analysis.source?.usage || []).length; }
          fresh.push({ id, analysis: r.analysis, source: r.fresh ? "new" : r.analysis.cached || "store" });
          await step(sid, "done", `Analysed ${i + 1} of ${todo.length}`, `${meta.title} – ${(r.analysis.brands || []).filter((b) => !isUnknownBrand(b.brand)).length} brands`);
        } catch (e) {
          await step(sid, "fail", `Analysis ${i + 1} of ${todo.length} not possible`, `${meta.title} – ${messageFor(e)}`);
          if (["quota_exhausted", "daily_limit"].includes(e?.code) || e?.status === 401 || e?.status === 403) break;
        }
      }
    }

    // ---- 6. aggregate + report -----------------------------------------------------------------------------------------
    await step("aggregate", "run", "Combining the results");
    const all = [...lib, ...fresh];
    const source = Object.fromEntries(all.map((x) => [x.id, x.source]));
    const summary = summarize(all.map((x) => x.analysis), { match: null, source });
    const placements = placementRows(all.map((x) => x.analysis));
    await fillUnknownGroups(request, env, placements, cost);
    const groups = groupShares(placements);
    const analysed = new Set(all.map((x) => x.id));
    await step("aggregate", "done", "Combined the results", `${summary.totals.videos} analysed video${summary.totals.videos === 1 ? "" : "s"} · ${summary.brands?.length || 0} brands · ${groups.length} product field${groups.length === 1 ? "" : "s"}`);
    await send("report", {
      channel: publicChannel(ch),
      uploads: ch.uploads.map(({ description, ...u }) => ({ ...u, analysed: analysed.has(u.id) ? source[u.id] : null })), // descriptions stay on the server
      summary, placements, groups, audience, cost,
      pending: !approve && shortlist.length ? shortlist.length : 0, seconds: Math.round((Date.now() - t0) / 1000),
    });
  });
}

export const publicChannel = (ch) => ({ id: ch.id, title: ch.title, handle: ch.handle, avatar: ch.avatar, subscribers: ch.subscribers, video_count: ch.video_count, source: ch.source, fetched_at: ch.fetched_at });

const SPONSOR_HINT = /sponsor|werbung|anzeige|#ad\b|paid partnership|\d+\s?% (?:off|rabatt)|use code|mit dem code|rabattcode|gutschein|sichert euch|sale at|thanks to .{2,40} for|danke an .{2,40} für/i;

/** Ad hints in title + description (same rules as the disclosure check, text only) → ranking of the candidates. */
function hint(u) {
  const c = checkDisclosure({ video: { title: u.title, description: u.description || "" } });
  // sponsor reads usually come with a deal: "49% off at ridge.com/MKBHD", "use code …", "bis zu 20% Rabatt", "sichert euch …"
  const label = c.signals.some((s) => !/affiliate/i.test(s)) || SPONSOR_HINT.test(`${u.title} ${u.description || ""}`);
  const shop = c.signals.some((s) => /affiliate/i.test(s));
  return { hint_score: (label ? 2 : 0) + (shop ? 1 : 0), why: [label ? "ad hint in the description" : null, shop ? "shop links" : null].filter(Boolean).join(" · ") || "latest upload" };
}

// ------------------------------------------------------------------------------------------------
// resolve + uploads
// ------------------------------------------------------------------------------------------------
/** @param o.limit false = the caller (Find creators) has its own daily limit for the whole run */
export async function loadChannel(request, env, kit, input, cost, { limit = true } = {}) {
  // the cache key is the canonical channel id when we know it, else the input (a handle maps to one id)
  const alias = env.STORE && input.kind !== "id" ? await env.STORE.get(`channelalias:${input.kind}:${input.value.toLowerCase()}`) : null;
  const id0 = input.kind === "id" ? input.value : alias;
  if (id0 && env.STORE) {
    const hit = await env.STORE.get(`channel:${id0}`, "json");
    if (hit) { cost.cached = true; return hit; }
  }
  if (limit && !(await kit.withinLimit(env, request, "channel", Number(env.DAILY_CHANNELS || 20)))) throw new kit.ApiError("channel_limit", 429);
  let ch;
  if (env.YOUTUBE_API_KEY) ch = await viaDataApi(env.YOUTUBE_API_KEY, input, kit, cost);
  else ch = await viaPages(input, kit, cost);
  if (!ch?.id) throw new kit.ApiError("channel_not_found", 404);
  ch.fetched_at = new Date().toISOString();
  if (env.STORE) {
    await env.STORE.put(`channel:${ch.id}`, JSON.stringify(ch), { expirationTtl: CHANNEL_TTL_S });
    if (input.kind !== "id") await env.STORE.put(`channelalias:${input.kind}:${input.value.toLowerCase()}`, ch.id, { expirationTtl: 60 * 60 * 24 * 30 });
  }
  return ch;
}

const isoDuration = (s) => { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || ""); return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : null; };
const compact = (n) => (n == null ? null : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M subscribers` : n >= 1e3 ? `${Math.round(n / 1e3)}k subscribers` : `${n} subscribers`);

/** Official route: 3 units in total (channels.list, playlistItems.list, videos.list). */
async function viaDataApi(key, input, kit, cost) {
  const api = async (path, params) => {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key })}`);
    cost.units += 1;
    if (!r.ok) throw Object.assign(new kit.ApiError("channel_not_found", r.status === 404 ? 404 : 502), { detail: `YouTube Data API ${path}: HTTP ${r.status}` });
    return r.json();
  };
  let q;
  if (input.kind === "id") q = { id: input.value };
  else if (input.kind === "handle") q = { forHandle: input.value };
  else if (input.kind === "legacy") q = { forUsername: input.value };
  else { // a video link → its channel
    const v = await api("videos", { part: "snippet", id: input.value });
    const cid = v.items?.[0]?.snippet?.channelId; if (!cid) return null;
    q = { id: cid };
  }
  const c = (await api("channels", { part: "snippet,statistics,contentDetails", ...q })).items?.[0];
  if (!c) return null;
  const uploadsId = c.contentDetails?.relatedPlaylists?.uploads;
  const pl = uploadsId ? await api("playlistItems", { part: "contentDetails", playlistId: uploadsId, maxResults: String(MAX_UPLOADS + 10) }) : { items: [] };
  const ids = (pl.items || []).map((it) => it.contentDetails?.videoId).filter(Boolean);
  const vids = ids.length ? (await api("videos", { part: "snippet,statistics,contentDetails", id: ids.join(",") })).items || [] : [];
  const uploads = vids.map((it) => ({
    id: it.id, title: it.snippet?.title || "", published: it.snippet?.publishedAt?.slice(0, 10) || null,
    views: it.statistics?.viewCount ? Number(it.statistics.viewCount) : null, duration_s: isoDuration(it.contentDetails?.duration),
    description: String(it.snippet?.description || "").slice(0, 800), live: it.snippet?.liveBroadcastContent && it.snippet.liveBroadcastContent !== "none",
  })).filter((u) => !u.live && (u.duration_s == null || u.duration_s > 60)).slice(0, MAX_UPLOADS);
  return { id: c.id, title: c.snippet?.title || "", handle: c.snippet?.customUrl || (input.kind === "handle" ? input.value : null),
    description: String(c.snippet?.description || "").slice(0, 1000), // channel "About" text – only the AI estimate reads it (assess.js)
    avatar: c.snippet?.thumbnails?.medium?.url || c.snippet?.thumbnails?.default?.url || null,
    subscribers: c.statistics?.hiddenSubscriberCount ? null : compact(Number(c.statistics?.subscriberCount)), video_count: Number(c.statistics?.videoCount) || null,
    uploads, source: "data-api" };
}

/**
 * Keyless route: the channel's own /videos page (ytInitialData: titles, view counts, lengths, relative ages) plus the
 * RSS feed (exact upload dates and descriptions of the latest 15). Works locally; online YouTube may answer the
 * Worker's data-centre IP with a bot check, as on the watch page (20 Nov) – then the step fails honestly and the
 * README explains how to set YOUTUBE_API_KEY.
 */
async function viaPages(input, kit, cost) {
  let path;
  if (input.kind === "id") path = `channel/${input.value}`;
  else if (input.kind === "handle") path = encodeURIComponent(input.value).replace(/^%40/, "@");
  else if (input.kind === "legacy") path = `c/${encodeURIComponent(input.value)}`;
  else { // a video link → oEmbed names the channel's URL
    const o = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${input.value}&format=json`);
    const url = o.ok ? (await o.json()).author_url : null;
    const m = /youtube\.com\/((?:@|channel\/|c\/|user\/)[^/?#]+)/.exec(url || ""); if (!m) return null;
    path = m[1];
  }
  const r = await fetch(`https://www.youtube.com/${path}/videos?hl=en&gl=US`, { headers: kit.BROWSER_HEADERS });
  if (r.status === 404) return null;
  const html = r.ok ? await r.text() : "";
  const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});<\/script>/s);
  let data = null; try { data = m ? JSON.parse(m[1]) : null; } catch { /* format changed */ }
  const meta = data?.metadata?.channelMetadataRenderer;
  if (!meta) throw Object.assign(new kit.ApiError("channel_not_found", 502), { detail: `YouTube's channel page gave no data to the server (HTTP ${r.status}${r.ok ? ", probably a bot check" : ""}) – set YOUTUBE_API_KEY for the official API` });
  const id = meta.externalId || /"externalId":"(UC[\w-]{22})"/.exec(html)?.[1];
  const hdr = data?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel;
  const parts = (hdr?.metadata?.contentMetadataViewModel?.metadataRows || []).flatMap((row) => (row.metadataParts || []).map((p) => p.text?.content || ""));
  const avatar = hdr?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources?.at(-1)?.url || meta.avatar?.thumbnails?.[0]?.url || null;

  // video tiles: new layout (lockupViewModel) and old layout (videoRenderer)
  const items = [];
  (function walk(o) {
    if (!o || typeof o !== "object" || items.length >= MAX_UPLOADS + 10) return;
    if (o.lockupViewModel?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
      const l = o.lockupViewModel; const md = l.metadata?.lockupMetadataViewModel;
      const row = (md?.metadata?.contentMetadataViewModel?.metadataRows || []).flatMap((x) => x.metadataParts || []);
      const badge = JSON.stringify(l.contentImage || {}).match(/"text":"(\d+(?::\d{2}){1,2})"/)?.[1];
      items.push({ id: l.contentId, title: md?.title?.content || "", views: views(row.find((p) => /view/i.test(p.accessibilityLabel || ""))?.accessibilityLabel || row[0]?.text?.content),
        duration_s: clock(badge), published: relativeDate(row.find((p) => /ago/i.test(p.accessibilityLabel || p.text?.content || ""))?.accessibilityLabel), approx: true, live: !badge });
      return;
    }
    if (o.videoRenderer) {
      const v = o.videoRenderer; const text = (t) => t?.simpleText || (t?.runs || []).map((x) => x.text).join("") || "";
      items.push({ id: v.videoId, title: text(v.title), views: views(text(v.viewCountText)), duration_s: clock(text(v.lengthText)), published: relativeDate(text(v.publishedTimeText)), approx: true, live: !v.lengthText });
      return;
    }
    for (const x of Array.isArray(o) ? o : Object.values(o)) walk(x);
  })(data);

  // RSS: exact dates + descriptions for the latest 15 (no key, cheap XML)
  if (id) {
    try {
      const x = await (await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`)).text();
      for (const e of x.split("<entry>").slice(1)) {
        const vid = /<yt:videoId>([^<]+)</.exec(e)?.[1]; const it = items.find((i) => i.id === vid);
        const pub = /<published>(\d{4}-\d{2}-\d{2})/.exec(e)?.[1];
        const desc = /<media:description>([\s\S]*?)<\/media:description>/.exec(e)?.[1];
        if (it) { if (pub) { it.published = pub; it.approx = false; } if (desc) it.description = unxml(desc).slice(0, 800); }
      }
    } catch { /* RSS is a bonus */ }
  }
  cost.units += 0;
  return { id, title: meta.title || "", handle: parts.find((p) => p.startsWith("@")) || (input.kind === "handle" ? input.value : null), avatar,
    description: String(meta.description || "").slice(0, 1000), // channel "About" text – only the AI estimate reads it (assess.js)
    subscribers: parts.find((p) => /subscriber/i.test(p)) || null, video_count: Number(String(parts.find((p) => /videos?$/i.test(p)) || "").replace(/[^\d.KM]/gi, "").replace(/K$/i, "e3").replace(/M$/i, "e6")) || null,
    uploads: items.filter((u) => kit.ID_RE.test(u.id || "") && !u.live).slice(0, MAX_UPLOADS), source: "youtube-page" };
}

const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const clock = (t) => (/^\d+(:\d{2}){1,2}$/.test(t || "") ? t.split(":").reduce((n, p) => n * 60 + Number(p), 0) : null);
/** "4.4 million views" / "4.4M" / "12,345 views" → number */
function views(t) {
  const m = /([\d.,]+)\s*(million|thousand|billion|[KMB])?/i.exec(t || ""); if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, "")); const u = (m[2] || "").toLowerCase();
  return Math.round(n * ({ k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 }[u] || 1));
}
/** "3 weeks ago" → approximate ISO date (replaced by the exact RSS date for the latest 15) */
function relativeDate(t) {
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)/i.exec(t || ""); if (!m) return null;
  const days = { second: 0, minute: 0, hour: 0, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()] ?? 0;
  return new Date(Date.now() - Number(m[1]) * days * 864e5).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------------------------------------
// library: analyses of this channel (examples + KV), matched by video id or channel name
// ------------------------------------------------------------------------------------------------
export async function channelLibrary(request, env, kit, ch, cost) {
  const ids = new Set(ch.uploads.map((u) => u.id)); const name = norm(ch.title);
  const out = []; const seen = new Set();
  const asset = async (p) => { const r = await env.ASSETS.fetch(new Request(new URL(p, request.url))); return r.ok ? r.json() : null; };
  for (const d of (await asset("/data/index.json").catch(() => null)) || []) {
    seen.add(d.id);
    if (!(ids.has(d.id) || norm(d.channel) === name)) continue;
    const a = await asset(`/data/${d.id}.json`).catch(() => null);
    if (a) out.push({ id: d.id, analysis: { ...a, cached: "demo" }, source: "demo" });
  }
  if (!env.STORE) return out;
  let cursor;
  do {
    const page = await env.STORE.list({ prefix: "analysis:", cursor, limit: 1000 });
    for (const k of page.keys) {
      const id = k.name.slice(9);
      if (seen.has(id) || out.length >= MAX_LIBRARY) continue;
      seen.add(id);
      if (!(ids.has(id) || norm(k.metadata?.channel) === name)) continue; // the channel name lives in the key metadata
      const a = await env.STORE.get(k.name, "json"); cost.kv_reads += 1;
      if (a) out.push({ id, analysis: { ...a, cached: "store" }, source: "store" });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

/** Comments the Audience tab already loaded (KV `comments:r<rules>:<video>:<brand-hash>`, 24 h) – read only. */
async function cachedAudience(env, ids, cost) {
  const out = {};
  if (!env.STORE) return out;
  for (const id of ids.slice(0, 20)) {
    const { keys } = await env.STORE.list({ prefix: `comments:r${RULES_VERSION}:${id}:`, limit: 5 });
    if (!keys.length) continue;
    const c = await env.STORE.get(keys[0].name, "json"); cost.kv_reads += 1;
    if (c?.n) out[id] = { n: c.n, total: c.total, brands: Object.fromEntries(Object.entries(c.brands || {}).map(([b, x]) => [b, { comments: x.comments, cats: x.cats }])) };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// rows for the fit check + product fields of the channel
// ------------------------------------------------------------------------------------------------
/** One row per (video, brand): what shared/fit.js needs, nothing more. */
export function placementRows(analyses) {
  const rows = [];
  for (const a of analyses) {
    const level = checkDisclosure(a).level;
    for (const b of a.brands || []) {
      if (isUnknownBrand(b.brand)) continue;
      rows.push({ id: a.video?.id, upload_date: a.video?.upload_date || null, brand: b.brand, category: b.category || "", group: categoryGroup(b.category, b.product),
        screen_s: Math.round(screenTime(b)), level, paid: !!a.paid?.looks_like_paid_promotion });
    }
  }
  return rows;
}

/**
 * Gemini sometimes leaves the category empty for every brand of a video (seen in a beauty PR haul, test E2). Then the
 * whole channel would look like "other". The same brand often has a category in another analysis we already have
 * ("Benefit" → Beauty & Personal Care in a what's-in-my-bag video) – that one is used and marked `group_from: library`.
 * Reads: the repo examples (static files) + at most 8 KV analyses whose brand list contains one of the brands.
 */
export async function fillUnknownGroups(request, env, rows, cost) {
  const todo = new Set(rows.filter((r) => r.group === "other").map((r) => norm(r.brand)));
  if (!todo.size) return;
  const votes = new Map(); // brand → { group → count }
  const take = (a) => {
    for (const b of a?.brands || []) {
      const k = norm(b.brand); if (!todo.has(k)) continue;
      const g = categoryGroup(b.category, b.product); if (g === "other") continue;
      const m = votes.get(k) || {}; m[g] = (m[g] || 0) + 1; votes.set(k, m);
    }
  };
  const asset = async (p) => { const r = await env.ASSETS.fetch(new Request(new URL(p, request.url))); return r.ok ? r.json() : null; };
  for (const d of (await asset("/data/index.json").catch(() => null)) || []) take(await asset(`/data/${d.id}.json`).catch(() => null));
  if (env.STORE) {
    let reads = 0;
    const { keys } = await env.STORE.list({ prefix: "analysis:", limit: 1000 });
    for (const k of keys) {
      if (reads >= 8) break;
      const names = String(k.metadata?.names || "").split("|").map(norm);
      if (!names.some((n) => todo.has(n))) continue;
      take(await env.STORE.get(k.name, "json")); reads += 1; cost.kv_reads += 1;
    }
  }
  for (const r of rows) {
    if (r.group !== "other") continue;
    const best = Object.entries(votes.get(norm(r.brand)) || {}).sort((x, y) => y[1] - x[1])[0];
    if (best) { r.group = best[0]; r.group_from = "library"; }
  }
}

/** Product fields of the channel: share of brand placements per group. */
export function groupShares(placements) {
  const m = new Map();
  for (const p of placements) { const e = m.get(p.group) || { group: p.group, label: GROUP_LABEL[p.group], placements: 0, brands: new Set(), videos: new Set() }; e.placements += 1; e.brands.add(p.brand); e.videos.add(p.id); m.set(p.group, e); }
  const total = placements.length || 1;
  return [...m.values()].map((e) => ({ group: e.group, label: e.label, placements: e.placements, share: e.placements / total, brands: [...e.brands].slice(0, 8), videos: e.videos.size }))
    .sort((a, b) => b.placements - a.placements);
}

// ------------------------------------------------------------------------------------------------
// GET /api/brandcat?b=<brand> → which product field is the brand in? From our own analyses only (0 requests).
// ------------------------------------------------------------------------------------------------
export async function brandCategory(request, env, kit) {
  const brand = String(new URL(request.url).searchParams.get("b") || "").trim().slice(0, 60);
  if (norm(brand).length < 2) throw new kit.ApiError("invalid_brand", 400);
  return brandField(request, env, brand);
}

/** The same look-up for a brand string (also used by Find creators, creators.js). */
export async function brandField(request, env, brand) {
  const b = norm(brand); const counts = {}; let seen = 0, reads = 0;
  const take = (a) => {
    for (const x of a?.brands || []) if (norm(x.brand) === b || (b.length >= 3 && norm(x.brand).startsWith(b))) {
      const g = categoryGroup(x.category, x.product); counts[g] = (counts[g] || 0) + 1; seen += 1;
    }
  };
  const asset = async (p) => { const r = await env.ASSETS.fetch(new Request(new URL(p, request.url))); return r.ok ? r.json() : null; };
  for (const d of (await asset("/data/index.json").catch(() => null)) || []) take(await asset(`/data/${d.id}.json`).catch(() => null));
  if (env.STORE) {
    const { keys } = await env.STORE.list({ prefix: "analysis:", limit: 1000 });
    for (const k of keys) {
      if (reads >= 6) break;
      const names = k.metadata?.names; if (!names || !String(names).split("|").some((n) => norm(n) === b || norm(n).startsWith(b))) continue;
      take(await env.STORE.get(k.name, "json")); reads += 1;
    }
  }
  // "other" (Gemini left the category empty or wrote something we cannot place) is no answer – the visitor picks the field
  const best = Object.entries(counts).filter(([g]) => g !== "other").sort((x, y) => y[1] - x[1])[0];
  return { brand, group: best?.[0] || null, label: best ? GROUP_LABEL[best[0]] : null, seen, counts };
}
