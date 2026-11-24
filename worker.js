/**
 * worker.js — PlacementRadar backend on Cloudflare Workers.
 *
 * The Worker serves the static app (public/) and offers a tiny, locked-down API:
 *
 *   GET  /api/config            → key mode, invite, active providers, whether today's free video quota is left
 *   GET  /api/meta?v=<id>       → title, channel, views, duration, description of a YouTube video
 *                                 (fetched server-side; browsers cannot read YouTube pages because of CORS)
 *   GET  /api/recent            → videos analysed by visitors so far (from the KV cache, newest first)
 *   POST /api/analyze {v}       → full Gemini video analysis, streamed as Server-Sent Events
 *   POST /api/identify {image}  → brands in one camera crop (live mode fallback), via the provider router
 *   POST /api/closer {v,start,end} → "Look closer": inventory of a ≤ 20 s clip at 2 frames/s (SSE, cached per clip)
 *   POST /api/agent {brand, lang?, period?, approve?} → brand agent: search, cached analyses first, up to 3 new ones
 *                                 after the visitor's OK, one combined brand report (SSE; agent.js)
 *   GET  /api/teach[?cursor=]   → training examples kept from /api/identify ("Gemini teaches the on-device model"),
 *   GET  /api/teach/item?k=<key>  only with the secret TEACH_TOKEN as bearer token (tools/teach_pull.py)
 *
 * Quota strategy (PROBLEME.md, point 1) – everything here is free, there is no paid fallback:
 *   1. Never pay twice: repo demos (public/data) and every finished analysis (KV, kept forever) are served
 *      without any API call; identical camera crops are cached by their SHA-256 hash.
 *   2. Gemini model chain: each model family has its own free daily quota. A model that answers 429 with a
 *      per-day quota is marked "exhausted until midnight UTC" in KV, so later requests skip it instantly.
 *   3. Provider router for single frames: Gemini Flash-Lite → Cloudflare Workers AI (free 10,000 neurons/day,
 *      no key, same Worker) → OpenRouter free models (only if the secret OPENROUTER_API_KEY is set).
 *      Videos have no alternative: only Gemini watches a YouTube link with audio.
 *   4. Empty quota is not an error for the visitor: the API answers with code "quota_exhausted" and a
 *      friendly message; examples and the on-device scanner keep working.
 *
 * Model lists are Worker variables (VIDEO_MODELS, FRAME_MODELS, WORKERS_AI_MODELS, OPENROUTER_MODELS,
 * comma-separated). When Google retires a model, change the variable in the dashboard – no rebuild needed.
 *
 * Key handling ("KEY_MODE", see README → Hosting):
 *   shared → the project's Gemini key (Cloudflare secret GEMINI_API_KEY) is used. Never sent to the browser.
 *   own    → the Worker makes no Gemini calls; the browser uses the viewer's own key. Cached analyses and
 *            the keyless providers (Workers AI) still work.
 *
 * Long requests: a video analysis takes 1.5–5 min. The response is opened immediately as an SSE stream and a
 * heartbeat is sent every 5 s, so no proxy closes the idle connection (test G, EVALUATION.md).
 */
import { VIDEO_MODELS, FRAME_MODELS, TIMELINE_SCHEMA, AUTHENTICITY_SCHEMA, FRAME_PROMPT, FRAME_SCHEMA,
  CLOSER_PROMPT, CLOSER_SCHEMA, RECHECK_SCHEMA, MAX_RECHECK_ITEMS, authenticityPrompt, timelinePrompt, recheckPrompt,
  geminiBody } from "./public/js/shared/prompts.js";
import { normalizeAnalysis, normalizeCloser, promotedCandidates, recheckItems, mergeRecheck, screenTime } from "./public/js/shared/normalize.js";
import { agent, AGENT_MESSAGES } from "./agent.js";

const API = "https://generativelanguage.googleapis.com/v1beta";
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Visitor-facing texts for every error code (English, like the UI). The app shows `message` as is. */
const MESSAGES = {
  quota_exhausted: "Today's free analyses are used up – try an example, the live scanner, or come back tomorrow.",
  frame_quota_exhausted: "Today's free cloud recognitions are used up – barcode and on-device recognition still work.",
  daily_limit: "You reached today's limit for new analyses – the examples and the live scanner still work.",
  closer_limit: "You reached today's limit for \"Look closer\" – the analysis itself and the examples still work.",
  invalid_clip: "That part of the video cannot be analysed.",
  invite_required: "New analyses need an invite link. The examples work without one.",
  own_key_required: "New analyses are switched off right now. The examples and the live scanner still work.",
  server_key_missing: "The server has no Gemini key configured. The examples still work.",
  video_too_long: "This video is too long – PlacementRadar analyses videos up to 20 minutes.",
  busy: "Google's AI is overloaded right now – please try again in a few minutes.",
  bad_answer: "Gemini's answer was unreadable – please try again in a moment.",
  invalid_video: "That does not look like a YouTube video link.",
  invalid_brand: "Please enter a brand name (at least 2 letters).",
  too_many: "At most 3 new analyses per agent run.",
  ...AGENT_MESSAGES,
};

class ApiError extends Error {
  constructor(code, status = 400, detail = "") { super(code); this.code = code; this.status = status; this.detail = detail; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/config") return json(await config(env));
      if (url.pathname === "/api/meta") return json(await videoMeta(url.searchParams.get("v"), env));
      if (url.pathname === "/api/recent") return json(await recent(env));
      if (url.pathname === "/api/usage") return json(await usage(env));
      if (url.pathname === "/api/analyze" && request.method === "POST") return await analyze(request, env, ctx);
      if (url.pathname === "/api/identify" && request.method === "POST") return await identify(request, env, ctx);
      if (url.pathname === "/api/closer" && request.method === "POST") return await closer(request, env, ctx);
      if (url.pathname === "/api/agent" && request.method === "POST") return await agent(request, env, ctx, KIT);
      if (url.pathname === "/api/teach" || url.pathname === "/api/teach/item") return await teachExport(request, env, url);
      if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    } catch (e) {
      return errorJson(e);
    }
    return env.ASSETS.fetch(request); // static app
  },
};

// ------------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------------
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const errorJson = (e) => e instanceof ApiError
  ? json({ error: e.code, message: MESSAGES[e.code] || e.code, detail: e.detail || undefined }, e.status)
  : json({ error: "internal", message: String(e?.message || e) }, 500);

/** Comma-separated Worker variable → array, with a code default. */
const list = (value, fallback) => (value ? String(value).split(",").map((s) => s.trim()).filter(Boolean) : fallback);
const videoModels = (env) => list(env.VIDEO_MODELS, VIDEO_MODELS);
const frameModels = (env) => list(env.FRAME_MODELS, FRAME_MODELS);

const today = () => new Date().toISOString().slice(0, 10); // free quotas reset at midnight Pacific; UTC day is close enough
/** Seconds until the next quota reset (Google resets at midnight US Pacific ≈ 08:00 UTC; we wait at least 1 h). */
function secondsToReset() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return Math.max(3600, Math.round((next - now) / 1000));
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Gemini-specific access check (key mode, key present, invite). Cached results never need it. */
function geminiDenied(request, env) {
  if (env.KEY_MODE === "own") return "own_key_required";
  if (!env.GEMINI_API_KEY) return "server_key_missing";
  if (env.INVITE_TOKEN) {
    const token = request.headers.get("x-invite") || new URL(request.url).searchParams.get("invite");
    if (token !== env.INVITE_TOKEN) return "invite_required";
  }
  return null;
}

/** Daily counter per visitor (IP) and task, stored in KV if bound. Returns false when over the limit. */
async function withinLimit(env, request, task, limit) {
  if (!env.STORE) return true;
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const key = `count:${task}:${today()}:${ip}`;
  const n = Number(await env.STORE.get(key)) || 0;
  if (n >= limit) return false;
  await env.STORE.put(key, String(n + 1), { expirationTtl: 60 * 60 * 26 });
  return true;
}

/** Global daily counter (all visitors) – used as a safety cap for providers we do not want to overrun. */
async function bumpGlobal(env, name, limit) {
  if (!env.STORE) return true;
  const key = `global:${name}:${today()}`;
  const n = Number(await env.STORE.get(key)) || 0;
  if (n >= limit) return false;
  await env.STORE.put(key, String(n + 1), { expirationTtl: 60 * 60 * 26 });
  return true;
}

// ------------------------------------------------------------------------------------------------
// /api/config and /api/recent
// ------------------------------------------------------------------------------------------------
async function config(env) {
  const models = videoModels(env);
  const exhausted = await exhaustedModels(env, models);
  return {
    key_mode: env.KEY_MODE === "own" ? "own" : "shared",
    invite_required: !!env.INVITE_TOKEN,
    max_video_s: Number(env.MAX_VIDEO_S || 1200),
    video_models: models,
    frame_models: frameModels(env),
    frame_providers: frameProviders(env).map((p) => p.name),
    cache: !!env.STORE,
    teach: teachEnabled(env), // the live scanner shows "Recognised crops may be kept …" only when this is on
    // false = every video model reported its free daily quota as used up → the UI can say so before the visitor waits
    video_quota_left: env.KEY_MODE !== "own" && !!env.GEMINI_API_KEY && exhausted.length < models.length,
  };
}

/** Videos analysed by visitors, newest first. Titles etc. live in the KV key metadata → one list call, no reads. */
async function recent(env) {
  if (!env.STORE) return { items: [] };
  const { keys } = await env.STORE.list({ prefix: "analysis:", limit: 200 });
  const items = keys.filter((k) => k.metadata).map((k) => ({ id: k.name.slice(9), ...k.metadata }));
  items.sort((a, b) => String(b.analyzed_at || "").localeCompare(String(a.analyzed_at || "")));
  return { items: items.slice(0, 50) };
}

// ------------------------------------------------------------------------------------------------
// YouTube metadata: title, channel, views, length, description, upload date.
// Online (20 Nov) YouTube answers the Worker's data-centre IP with "LOGIN_REQUIRED" (bot check) on the watch
// page and the player endpoint, so views/description were missing. Sources, best first – each one only fills
// the fields still empty:
//   1. YouTube Data API v3 (official, free 10,000 units/day, 1 unit per video) – if secret YOUTUBE_API_KEY is set
//   2. watch page: player data, else the page data (ytInitialData) that may still be present behind the bot check
//   3. player endpoint with other clients (embedded / TV / iOS)
//   4. oEmbed (title + channel only, never blocked)
// meta.source records what each source answered, for diagnosis.
// ------------------------------------------------------------------------------------------------
const BROWSER_HEADERS = {
  "accept-language": "en",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  cookie: "CONSENT=YES+cb; SOCS=CAI", // skips the EU cookie-consent interstitial
};
const complete = (m) => m.views != null && m.duration_s != null && !!m.description;

function fill(meta, f) {
  for (const [k, v] of Object.entries(f)) if (v != null && v !== "" && (meta[k] == null || meta[k] === "")) meta[k] = v;
}

function fromPlayer(p) {
  const d = p?.videoDetails || {};
  return { title: d.title, channel: d.author, views: d.viewCount ? Number(d.viewCount) : null,
    duration_s: d.lengthSeconds ? Number(d.lengthSeconds) : null, description: d.shortDescription,
    upload_date: p?.microformat?.playerMicroformatRenderer?.uploadDate?.slice(0, 10) };
}

const isoDuration = (s) => { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || ""); return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : null; };

async function fromDataApi(id, key, trace) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${id}&key=${key}`);
  const it = r.ok ? (await r.json()).items?.[0] : null;
  trace.push(`dataapi:${r.status}:${it ? "ok" : "-"}`);
  if (!it) return {};
  return { title: it.snippet?.title, channel: it.snippet?.channelTitle, views: it.statistics?.viewCount ? Number(it.statistics.viewCount) : null,
    duration_s: isoDuration(it.contentDetails?.duration), description: it.snippet?.description, upload_date: it.snippet?.publishedAt?.slice(0, 10) };
}

async function fromWatchPage(id, trace) {
  const page = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers: BROWSER_HEADERS });
  const html = page.ok ? await page.text() : "";
  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|<\/script>)/s);
  let p = null; try { p = m ? JSON.parse(m[1]) : null; } catch { /* format changed */ }
  const f = fromPlayer(p);
  // page data (rendered info below the player) – often still there when the player itself is blocked
  const views = /"originalViewCount":"(\d+)"/.exec(html)?.[1];
  const desc = /"attributedDescription":\{"content":"((?:[^"\\]|\\.)*)"/.exec(html)?.[1];
  const len = /"approxDurationMs":"(\d+)"/.exec(html)?.[1];
  let date = /"(?:uploadDate|datePublished)"\s*:\s*"(\d{4}-\d{2}-\d{2})/.exec(html)?.[1];
  if (!date) { // rendered date, e.g. "Dec 8, 2017"
    const t = /"dateText":\{"simpleText":"([^"]+)"/.exec(html)?.[1]; const d = t && new Date(`${t} 12:00 UTC`);
    if (d && !isNaN(d)) date = d.toISOString().slice(0, 10);
  }
  let description = null; try { description = desc ? JSON.parse(`"${desc}"`) : null; } catch { /* ignore */ }
  fill(f, { views: views ? Number(views) : null, description, duration_s: len ? Math.round(Number(len) / 1000) : null, upload_date: date });
  trace.push(`watch:${page.status}:${p?.playabilityStatus?.status || "no-player"}:${["views", "duration_s", "description"].filter((k) => f[k]).join("+") || "nothing"}`);
  return f;
}

const CLIENTS = [
  { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "1.20241120.01.00", extra: { thirdParty: { embedUrl: "https://www.google.com" } } },
  { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0", extra: { thirdParty: { embedUrl: "https://www.google.com" } } },
  { clientName: "IOS", clientVersion: "19.45.4", deviceModel: "iPhone16,2" },
];
async function fromPlayerApi(id, c, trace) {
  const { extra = {}, ...client } = c;
  const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST", headers: { ...BROWSER_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ context: { client: { ...client, hl: "en" }, ...extra }, videoId: id }) });
  const j = r.ok ? await r.json().catch(() => null) : null;
  trace.push(`${c.clientName}:${r.status}:${j?.playabilityStatus?.status || "-"}:${j?.videoDetails?.viewCount ? "details" : "no-details"}`);
  return fromPlayer(j);
}

export async function videoMeta(id, env = {}) {
  if (!ID_RE.test(id || "")) throw new ApiError("invalid_video", 400);
  const meta = { id, title: "", channel: "", views: null, duration_s: null, upload_date: null, description: "" };
  const trace = [];
  const step = async (fn) => { if (complete(meta)) return; try { fill(meta, await fn()); } catch (e) { trace.push(`err:${String(e?.message || e).slice(0, 60)}`); } };
  if (env.YOUTUBE_API_KEY) await step(() => fromDataApi(id, env.YOUTUBE_API_KEY, trace));
  for (let i = 0; i < 3 && meta.duration_s == null; i++) await step(() => fromWatchPage(id, trace)); // the bot check is intermittent
  for (const c of CLIENTS) await step(() => fromPlayerApi(id, c, trace));
  await step(async () => {
    const o = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
    const j = o.ok ? await o.json() : {};
    return { title: j.title, channel: j.author_name };
  });
  meta.source = trace.join(" ");
  if (!complete(meta)) console.log(`videoMeta ${id} incomplete: ${meta.source}`);
  return meta;
}

// ------------------------------------------------------------------------------------------------
// Usage meter (shown in the app under Settings → "Show AI usage")
//   usage:<UTC day>:<model> = { requests, ok, failed, prompt, output, thoughts }   (expires after 3 days)
//   Free tier = ~20 requests per day and model family; the app shows requests against that limit.
// ------------------------------------------------------------------------------------------------
const FREE_REQUESTS_PER_MODEL = 20;
const tokens = (u = {}) => ({ prompt: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0, thoughts: u.thoughtsTokenCount || 0, total: u.totalTokenCount || 0 });

async function recordUsage(env, model, ok, usageMetadata) {
  if (!env.STORE) return;
  const key = `usage:${today()}:${model}`;
  try {
    const u = (await env.STORE.get(key, "json")) || { requests: 0, ok: 0, failed: 0, prompt: 0, output: 0, thoughts: 0 };
    const t = tokens(usageMetadata);
    u.requests += 1; ok ? (u.ok += 1) : (u.failed += 1);
    u.prompt += t.prompt; u.output += t.output; u.thoughts += t.thoughts;
    await env.STORE.put(key, JSON.stringify(u), { expirationTtl: 60 * 60 * 24 * 3 }); // KV is not atomic – good enough for a meter
  } catch { /* the meter must never break an analysis */ }
}

/** GET /api/usage → today's requests and tokens per model, exhausted flags, Workers AI counter. */
async function usage(env) {
  const models = [...new Set([...videoModels(env), ...frameModels(env)])];
  const out = { day: today(), reset_in_s: secondsToReset(), free_requests_per_model: FREE_REQUESTS_PER_MODEL, models: [], workers_ai: null };
  if (!env.STORE) return { ...out, available: false };
  const exhausted = new Set(await exhaustedModels(env, models));
  const rows = await Promise.all(models.map((m) => env.STORE.get(`usage:${today()}:${m}`, "json")));
  out.models = models.map((m, i) => ({ model: m, kind: videoModels(env).includes(m) ? "video" : "frame", exhausted: exhausted.has(m),
    ...(rows[i] || { requests: 0, ok: 0, failed: 0, prompt: 0, output: 0, thoughts: 0 }) }));
  out.workers_ai = { used: Number(await env.STORE.get(`global:workers-ai:${today()}`)) || 0, cap: Number(env.DAILY_WORKERS_AI || 250) };
  return { ...out, available: true };
}

// ------------------------------------------------------------------------------------------------
// Gemini with model chain.
//   429 per-day quota → model marked exhausted until the next reset, skipped instantly afterwards
//   429 per-minute / 500 / 503 → next model, then one more round after a short pause
// ------------------------------------------------------------------------------------------------
async function exhaustedModels(env, models) {
  if (!env.STORE) return [];
  const flags = await Promise.all(models.map((m) => env.STORE.get(`exhausted:${m}`)));
  return models.filter((_, i) => flags[i]);
}

export async function gemini(env, models, body, onEvent = () => {}) {
  const skip = new Set(await exhaustedModels(env, models));
  let last = "", busy = false;
  for (let round = 0; round < 2; round++) {
    for (const model of models) {
      if (skip.has(model)) continue;
      onEvent("model", { model });
      const t0 = Date.now();
      const r = await fetch(`${API}/models/${model}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body: JSON.stringify(body) });
      if (r.ok) {
        const j = await r.json();
        const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
        await recordUsage(env, model, true, j.usageMetadata);
        try { return { model, data: JSON.parse(text), usage: tokens(j.usageMetadata) }; } catch {
          // 21 Nov: a "Look closer" answer looped until the token limit (315,000 characters, cut-off JSON)
          // → not the visitor's problem: try the next model
          last = `${model}: unreadable answer (${text.length} chars, finish ${j.candidates?.[0]?.finishReason || "?"})`;
          console.log(`gemini bad json ${last}`);
          onEvent("retry", { model, status: "bad_answer", after_s: Math.round((Date.now() - t0) / 1000) });
          skip.add(model); busy = true; continue;
        }
      }
      const err = await r.text();
      await recordUsage(env, model, false);
      last = `${model}: HTTP ${r.status} ${err.slice(0, 160)}`;
      const after_s = Math.round((Date.now() - t0) / 1000);
      console.log(`gemini fail ${model} HTTP ${r.status} after ${after_s}s: ${err.slice(0, 300)}`); // visible in `wrangler tail` / dashboard logs
      onEvent("retry", { model, status: r.status, after_s }); // UI can show "Google is busy, trying the next model…"
      if (r.status === 429 && /per ?day|PerDay|daily/i.test(err)) {
        skip.add(model); // free daily quota used up → do not ask this model again until the reset
        if (env.STORE) await env.STORE.put(`exhausted:${model}`, today(), { expirationTtl: secondsToReset() });
      } else if (r.status === 400 && body.generationConfig?.thinkingConfig) { // model without thinking control → retry once without
        const { thinkingConfig, ...rest } = body.generationConfig;
        body = { ...body, generationConfig: rest };
      } else if (r.status === 404) {
        skip.add(model); // model retired or renamed → continue with the rest of the chain
      } else if ([429, 500, 503, 504, 524].includes(r.status)) { // 524: request timed out at the edge (seen 20 Nov on the authenticity call)
        busy = true;
      } else {
        throw new ApiError("gemini_error", 502, last);
      }
    }
    if (skip.size >= models.length) break;
    await new Promise((res) => setTimeout(res, 8000));
  }
  if (skip.size >= models.length && !busy) throw new ApiError("quota_exhausted", 429, last);
  throw new ApiError("busy", 503, last);
}

// ------------------------------------------------------------------------------------------------
// POST /api/analyze  → SSE stream: stage | meta | model | retry | note | joined | result | error  (+ ping every 5 s)
// Gemini calls per new video: 1 timeline + 1 re-check (since 22 Nov, optional) + 1 authenticity (optional) = up to 3.
// Order: repo demo → KV cache → access check → quota check → already running? (wait for it) → Gemini.
// ------------------------------------------------------------------------------------------------
async function cachedAnalysis(request, env, v) {
  const demo = await env.ASSETS.fetch(new Request(new URL(`/data/${v}.json`, request.url)));
  if (demo.ok) return { ...(await demo.json()), cached: "demo" };
  const stored = env.STORE && (await env.STORE.get(`analysis:${v}`, "json"));
  return stored ? { ...stored, cached: "store" } : null;
}

function sseResponse(ctx, run) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (event, data) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => {});
  const work = (async () => {
    const t0 = Date.now();
    const ping = setInterval(() => send("ping", { s: Math.round((Date.now() - t0) / 1000) }), 5000);
    try {
      await run(send);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "internal";
      await send("error", { error: code, message: MESSAGES[code] || String(e?.message || e), detail: e?.detail || undefined });
    } finally {
      clearInterval(ping);
      writer.close().catch(() => {});
    }
  })();
  ctx.waitUntil(work);
  return new Response(readable, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
}

async function analyze(request, env, ctx) {
  const { v } = await request.json().catch(() => ({}));
  if (!ID_RE.test(v || "")) throw new ApiError("invalid_video", 400);

  const cached = await cachedAnalysis(request, env, v);
  if (cached) return sseResponse(ctx, (send) => send("result", cached)); // costs nothing, works for everyone

  const denied = geminiDenied(request, env);
  if (denied) throw new ApiError(denied, denied === "invite_required" ? 401 : denied === "own_key_required" ? 403 : 503);
  const models = videoModels(env);
  if ((await exhaustedModels(env, models)).length >= models.length) throw new ApiError("quota_exhausted", 429);
  // Same video already running (visitor closed the tab and came back, or two visitors at once)?
  // → do not pay twice: wait for the first run's result in KV instead of asking Gemini again.
  const running = env.STORE && (await env.STORE.get(`pending:${v}`));
  if (running) return sseResponse(ctx, (send) => waitForRunning(env, v, Number(running), send));

  if (!(await withinLimit(env, request, "analyze", Number(env.DAILY_ANALYSES || 10)))) throw new ApiError("daily_limit", 429);
  if (env.STORE) await env.STORE.put(`pending:${v}`, String(Date.now()), { expirationTtl: 900 }); // 15 min max, then a new run may start

  return sseResponse(ctx, async (send) => {
    try { await send("result", await analyzeVideo(env, v, models, send)); } finally { if (env.STORE) ctx.waitUntil(env.STORE.delete(`pending:${v}`)); }
  });
}

/**
 * The analysis pipeline itself (meta → timeline → re-check → authenticity → normalise → KV), without access checks.
 * Used by /api/analyze and by the brand agent (agent.js); both do the checks (key, quota, limits, pending flag) first.
 * `send` receives the progress events (stage, meta, model, retry, note); the caller sends the result.
 */
export async function analyzeVideo(env, v, models, send) {
  await send("stage", { id: "meta" });
  const meta = await videoMeta(v, env);
  await send("meta", meta);
  if (meta.duration_s && meta.duration_s > Number(env.MAX_VIDEO_S || 1200)) throw new ApiError("video_too_long");

  await send("stage", { id: "timeline" });
  // title + description go into the same request as marked data (exact models, product links; prompts.js timelinePrompt)
  const tl = await gemini(env, models, geminiBody({ video: v, prompt: timelinePrompt(meta), schema: TIMELINE_SCHEMA }),
    (ev, data) => send(ev, data));

  // Call 1a, re-check (since 22 Nov, prompts.js): where is each found product visible – also lying on the desk?
  // Same model chain, exhausted flags and usage meter as every call (gemini()). Optional: if it fails (quota used up,
  // Google overloaded, unreadable answer) the analysis simply keeps the timeline of call 1 – no error for the visitor.
  await send("stage", { id: "recheck" });
  let timeline = tl.data, rc = null, recheckInfo = null;
  const items = recheckItems(tl.data, MAX_RECHECK_ITEMS);
  if (items.length) {
    const t0 = Date.now();
    rc = await gemini(env, models, geminiBody({ video: v, prompt: recheckPrompt(items), schema: RECHECK_SCHEMA, maxTokens: 24000 }),
      (ev, data) => send(ev, data)).catch((e) => { console.log(`recheck skipped: ${e?.code || e?.message || e}`); return null; });
    if (rc) {
      timeline = mergeRecheck(tl.data, items, rc.data);
      recheckInfo = { model: rc.model, products: items.length, spans: (rc.data?.items || []).reduce((n, it) => n + (it.appearances?.length || 0), 0), seconds: Math.round((Date.now() - t0) / 1000),
        filter: timeline.recheck_filter }; // what the plausibility filter removed (normalize.js filterRecheckSpans)
    } else {
      recheckInfo = { skipped: true };
      await send("note", { text: "Re-check skipped (Google busy or quota used up) – keeping the first result" });
    }
  }

  await send("stage", { id: "authenticity" });
  let au = null;
  const products = promotedCandidates(tl.data);
  if (products.length && tl.data.looks_like_paid_promotion !== false) {
    au = await gemini(env, models, geminiBody({ video: v, prompt: authenticityPrompt(products), schema: AUTHENTICITY_SCHEMA }),
      (ev, data) => send(ev, data)).catch(() => null); // authenticity is optional – never fail the whole analysis
  }

  await send("stage", { id: "done" });
  const result = normalizeAnalysis({ video: meta, timeline, authenticity: au?.data, models: [tl.model, rc?.model, au?.model].filter(Boolean) });
  // tokens per call, shown in the app's usage meter ("this analysis cost …")
  result.source.usage = [{ call: "timeline", model: tl.model, ...tl.usage }, ...(rc ? [{ call: "recheck", model: rc.model, ...rc.usage }] : []),
    ...(au ? [{ call: "authenticity", model: au.model, ...au.usage }] : [])];
  if (recheckInfo) {
    // before/after numbers for transparency (EVALUATION.md test W): what call 1 alone would have shown
    const before = normalizeAnalysis({ video: meta, timeline: tl.data });
    const count = (r) => r.brands.reduce((n, b) => n + b.appearances.filter((a) => a.channel === "visual").length, 0);
    const secs = (r) => Math.round(r.brands.reduce((n, b) => n + screenTime(b), 0));
    const raw = (tl.data?.brands || []).reduce((n, b) => n + (b.appearances || []).filter((a) => (a.channel || "visual") === "visual").length, 0);
    result.source.recheck = { ...recheckInfo, visual_raw: raw, visual_before: count(before), visual_after: count(result), seconds_before: secs(before), seconds_after: secs(result) };
  }
  if (!result.video.duration_s) { // YouTube withheld the length (bot check) → last brand appearance as lower bound
    const ends = (result.brands || []).flatMap((b) => (b.appearances || []).map((x) => x.end_s || 0));
    if (ends.length) { result.video.duration_s = Math.max(...ends); result.video.duration_estimated = true; }
  }
  if (env.STORE) {
    // kept forever: whatever the professor analyses once loads instantly the next time
    // names (since 23 Nov): brand + product names, so the brand agent finds matching analyses without reading them
    const names = [...new Set((result.brands || []).flatMap((b) => [b.brand, ...(b.products || [])]))].join("|").slice(0, 600);
    const metadata = { title: meta.title, channel: meta.channel, views: meta.views, duration_s: meta.duration_s,
      brands: result.brands?.length || 0, analyzed_at: new Date().toISOString(), names };
    await env.STORE.put(`analysis:${v}`, JSON.stringify(result), { metadata }); // before the pending flag is removed
  }
  return result;
}

// ------------------------------------------------------------------------------------------------
// POST /api/closer {v, start, end} → SSE: model | retry | result | error (+ ping)
// "Look closer" at the player: one Gemini request for a short clip (≤ 20 s) at 2 frames per second with the
// inventory prompt – finds small, worn or incidental products the whole-video call misses (test I).
// Cached forever per clip (KV `closer:<v>:<start>-<end>`); the app snaps the clip to 5-second steps so
// neighbouring clicks hit the same cache entry. Own daily limit per visitor (DAILY_CLOSER, default 8).
// ------------------------------------------------------------------------------------------------
async function closer(request, env, ctx) {
  const body = await request.json().catch(() => ({}));
  const v = body.v; const start = Math.max(0, Math.round(Number(body.start))); const end = Math.round(Number(body.end));
  if (!ID_RE.test(v || "")) throw new ApiError("invalid_video", 400);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 5 || end - start > 20 || start > 7200) throw new ApiError("invalid_clip", 400);
  const key = `closer:${v}:${start}-${end}`;
  const cached = env.STORE && (await env.STORE.get(key, "json"));
  if (cached) return sseResponse(ctx, (send) => send("result", { ...cached, cached: true }));

  const denied = geminiDenied(request, env);
  if (denied) throw new ApiError(denied, denied === "invite_required" ? 401 : denied === "own_key_required" ? 403 : 503);
  const models = videoModels(env);
  if ((await exhaustedModels(env, models)).length >= models.length) throw new ApiError("quota_exhausted", 429);
  if (!(await withinLimit(env, request, "closer", Number(env.DAILY_CLOSER || 8)))) throw new ApiError("closer_limit", 429);

  return sseResponse(ctx, async (send) => {
    const r = await gemini(env, models, geminiBody({ video: v, prompt: CLOSER_PROMPT, schema: CLOSER_SCHEMA, clip: { start, end, fps: 2 }, maxTokens: 8192 }),
      (ev, data) => send(ev, data));
    // timestamps outside the clip (Gemini sometimes counts from the clip start) are shifted into it
    const items = (r.data?.items || []).map((it) => fixClipTimes(it, start, end));
    const result = { v, start, end, model: r.model, usage: r.usage, analyzed_at: new Date().toISOString().slice(0, 10), ...normalizeCloser(items) };
    if (env.STORE) await env.STORE.put(key, JSON.stringify(result));
    await send("result", result);
  });
}

/** If all times of an item lie before the clip, Gemini counted from the clip start → add the offset. */
function fixClipTimes(it, start, end) {
  const toS = (t) => String(t ?? "").split(/\s*[-–—]\s*/)[0].split(":").reduce((n, p) => n * 60 + (parseFloat(p) || 0), 0);
  const s = toS(it.start);
  if (start > 0 && s < start - 2 && s <= end - start + 2) {
    const mm = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, "0")}`;
    return { ...it, start: mm(s + start), end: mm(toS(it.end || it.start) + start), ...(it.frame_time ? { frame_time: mm(toS(it.frame_time) + start) } : {}) };
  }
  return it;
}

/** Second request for a video that is being analysed right now: poll KV for the first run's result (no Gemini call). */
async function waitForRunning(env, v, startedAt, send) {
  await send("stage", { id: "timeline" });
  await send("joined", { started_at: startedAt }); // UI: "this video is already being analysed – joining"
  const until = Date.now() + 14 * 60 * 1000;
  while (Date.now() < until) {
    await new Promise((res) => setTimeout(res, 10000));
    const stored = await env.STORE.get(`analysis:${v}`, "json");
    if (stored) return send("result", { ...stored, cached: "store" });
    if (!(await env.STORE.get(`pending:${v}`))) break; // first run ended without a result (error) → stop waiting
  }
  throw new ApiError("busy", 503);
}

// ------------------------------------------------------------------------------------------------
// POST /api/identify {image: base64 JPEG}  → {items:[{brand, product, box_2d, confidence}], model, provider}
// Provider router: the first provider that answers wins; quota/overload → next provider.
// ------------------------------------------------------------------------------------------------
function frameProviders(env) {
  const all = {
    gemini: { name: "gemini", ok: () => env.KEY_MODE !== "own" && !!env.GEMINI_API_KEY, run: identifyGemini },
    "workers-ai": { name: "workers-ai", ok: () => !!env.AI, run: identifyWorkersAI },
    openrouter: { name: "openrouter", ok: () => !!env.OPENROUTER_API_KEY, run: identifyOpenRouter },
  };
  return list(env.FRAME_PROVIDERS, ["gemini", "workers-ai", "openrouter"]).map((n) => all[n]).filter((p) => p && p.ok());
}

async function identify(request, env, ctx) {
  // `provider` (optional) forces one enabled provider – for tests and the README comparison; same limits apply
  // `teach` = the visitor has not switched off "Recognised crops may be kept to improve the on-device model"
  const { image, provider, teach } = await request.json().catch(() => ({}));
  if (!image || typeof image !== "string" || image.length > 400_000) throw new ApiError("image_invalid", 400);

  const key = `frame:${provider ? `${provider}:` : ""}${await sha256(image)}`;
  const hit = env.STORE && (await env.STORE.get(key, "json"));
  if (hit) return json({ ...hit, cached: true, kept: teach === true && !!(await env.STORE.get(`teach:${key.split(":").pop()}`, "text")) });

  if (env.INVITE_TOKEN) { // invite protects all cloud providers, not only Gemini
    const token = request.headers.get("x-invite") || new URL(request.url).searchParams.get("invite");
    if (token !== env.INVITE_TOKEN) throw new ApiError("invite_required", 401);
  }
  const providers = frameProviders(env).filter((p) => !provider || p.name === provider);
  if (!providers.length) throw new ApiError(env.KEY_MODE === "own" ? "own_key_required" : "server_key_missing", 503);
  if (!(await withinLimit(env, request, "identify", Number(env.DAILY_IDENTIFY || 60)))) throw new ApiError("daily_limit", 429);

  const tried = [];
  for (const p of providers) {
    try {
      const r = await p.run(env, image);
      const out = { items: cleanItems(r.items), model: r.model, provider: p.name, tried, ...(r.shape != null ? { input_shape: r.shape } : {}) };
      if (env.STORE) ctx.waitUntil(env.STORE.put(key, JSON.stringify(out), { expirationTtl: 60 * 60 * 24 * 30 }));
      const kept = teach === true ? await keepForTraining(env, image, out, key.split(":").pop()) : false;
      return json({ ...out, kept });
    } catch (e) {
      tried.push({ provider: p.name, error: e instanceof ApiError ? e.code : String(e?.message || e).slice(0, 400) });
    }
  }
  throw new ApiError("frame_quota_exhausted", 429, JSON.stringify(tried));
}

/** Same shape for every provider: brand, product, box_2d (0–1000 or null), confidence 0–1. */
function cleanItems(items) {
  return (Array.isArray(items) ? items : []).filter((it) => it && typeof it.brand === "string" && it.brand.trim())
    .map((it) => {
      const raw = Array.isArray(it.box_2d) && it.box_2d.length === 4 && it.box_2d.every((n) => Number.isFinite(Number(n))) ? it.box_2d.map(Number) : null;
      const scale = raw && raw.every((n) => n <= 1) ? 1000 : 1; // some models answer 0–1 instead of 0–1000
      let b = raw && raw.map((n) => Math.max(0, Math.min(1000, Math.round(n * scale))));
      if (b && (b[2] - b[0] < 5 || b[3] - b[1] < 5)) b = null; // degenerate box = no position
      const c = Number(it.confidence);
      return { brand: it.brand.trim(), product: String(it.product || "").trim(), box_2d: b, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : null };
    }).slice(0, 12);
}

/** Pull the first JSON object out of a free-text answer (models without a JSON mode). */
function parseLooseJson(text) {
  const s = String(text || "").replace(/```(?:json)?/g, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON in answer");
  return JSON.parse(s.slice(a, b + 1));
}

async function identifyGemini(env, image) {
  const r = await gemini(env, frameModels(env), geminiBody({ image, prompt: FRAME_PROMPT, schema: FRAME_SCHEMA, lowThinking: false }));
  return { items: r.data.items, model: r.model };
}

const OPEN_PROMPT = `${FRAME_PROMPT}
Answer with exactly one JSON object of the form {"items":[{"brand":"...","product":"...","box_2d":[ymin,xmin,ymax,xmax],"confidence":0.0}]}.
If no brand is identifiable, answer {"items":[]}.`;

/** Cloudflare Workers AI – free 10,000 neurons/day on the account, no key; capped by DAILY_WORKERS_AI as a safety net. */
async function identifyWorkersAI(env, image) {
  if (!(await bumpGlobal(env, "workers-ai", Number(env.DAILY_WORKERS_AI || 250)))) throw new ApiError("quota_exhausted", 429);
  const dataUri = `data:image/jpeg;base64,${image}`;
  const bytes = () => [...Uint8Array.from(atob(image), (c) => c.charCodeAt(0))];
  // Cloudflare documents several input shapes for vision models; we try them in this order (first that works wins)
  // (online test 20 Nov: Llama 3.2 Vision accepts the "messages + image bytes" shape; the image_url shape fails with 3030)
  const shapes = [
    () => ({ messages: [{ role: "system", content: "You identify brands in images." }, { role: "user", content: OPEN_PROMPT }], image: bytes() }),
    () => ({ messages: [{ role: "user", content: [{ type: "text", text: OPEN_PROMPT }, { type: "image_url", image_url: { url: dataUri } }] }] }),
    () => ({ prompt: OPEN_PROMPT, image: bytes() }),
  ];
  const errors = [];
  for (const model of list(env.WORKERS_AI_MODELS, ["@cf/meta/llama-3.2-11b-vision-instruct"])) {
    for (const [i, shape] of shapes.entries()) {
      const input = { ...shape(), max_tokens: 512, temperature: 0.1 };
      try {
        let r;
        try { r = await env.AI.run(model, input); }
        catch (e) {
          if (!/agree/i.test(String(e?.message))) throw e;
          await env.AI.run(model, { prompt: "agree" }); // Meta's licence must be accepted once per account (Cloudflare docs)
          r = await env.AI.run(model, input);
        }
        const text = typeof r?.response === "string" ? r.response : JSON.stringify(r?.response ?? r);
        return { items: parseLooseJson(text).items, model, raw: text.slice(0, 300), shape: i };
      } catch (e) { errors.push(`${model.split("/").pop()}#${i}: ${String(e?.message || e).slice(0, 90)}`); }
    }
  }
  throw new Error(errors.join(" | ") || "no Workers AI model");
}

/** OpenRouter free models (":free" suffix): 50 requests/day without credits. Only active if the secret is set. */
async function identifyOpenRouter(env, image) {
  let last = "";
  for (const model of list(env.OPENROUTER_MODELS, ["qwen/qwen2.5-vl-72b-instruct:free"])) {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "x-title": "PlacementRadar" },
      body: JSON.stringify({ model, temperature: 0.1, max_tokens: 512, messages: [{ role: "user", content: [
        { type: "text", text: OPEN_PROMPT }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }] }] }),
    });
    if (r.ok) {
      const j = await r.json();
      return { items: parseLooseJson(j.choices?.[0]?.message?.content).items, model };
    }
    last = `${model}: HTTP ${r.status}`;
  }
  throw new Error(last || "no OpenRouter model");
}

// ------------------------------------------------------------------------------------------------
// "Gemini teaches the on-device model" (distillation, see MODELS.md): a crop that a cloud model named with a
// confident, single answer is kept as a training example (crop + brand) in KV. tools/teach_pull.py downloads
// them, checks them and retrains the brand head. Privacy limits (README → Privacy):
//   - only crops the visitor sent to "Identify" on purpose, only if they did not switch keeping off,
//   - only the crop (no full frame, no IP, no visitor id), at most TEACH_MAX_KB per crop,
//   - at most TEACH_MAX examples in total, each deleted after TEACH_DAYS days; TEACH=off switches it off.
// ------------------------------------------------------------------------------------------------
const teachEnabled = (env) => !!env.STORE && env.TEACH !== "off";

async function keepForTraining(env, image, out, hash) {
  if (!teachEnabled(env)) return false;
  const items = out.items || [];
  const best = [...items].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  // one clear answer only: a crop with two brands or a hesitant answer would teach the wrong thing
  if (!best || items.length > 2 || (best.confidence ?? 0) < Number(env.TEACH_MIN_CONF || 0.7)) return false;
  if (image.length > Number(env.TEACH_MAX_KB || 160) * 1024 * 1.37) return false; // base64 is 4/3 of the bytes
  const max = Number(env.TEACH_MAX || 1500);
  const n = Number(await env.STORE.get("teach-count")) || 0;
  if (n >= max) return false;
  const key = `teach:${hash}`;
  if (await env.STORE.get(key, "text")) return true; // same crop already kept
  const t = new Date().toISOString();
  const meta = { brand: best.brand.slice(0, 80), conf: best.confidence ?? null, model: out.model, provider: out.provider, t };
  await env.STORE.put(key, JSON.stringify({ ...meta, product: best.product || "", box_2d: best.box_2d, image }),
    { metadata: meta, expirationTtl: 60 * 60 * 24 * Number(env.TEACH_DAYS || 90) });
  await env.STORE.put("teach-count", String(n + 1)); // KV is not atomic – a soft cap is enough here
  return true;
}

/** Download side for tools/teach_pull.py. Disabled (404) unless the secret TEACH_TOKEN is set. */
async function teachExport(request, env, url) {
  if (!env.TEACH_TOKEN || !env.STORE) throw new ApiError("not_found", 404);
  if (request.headers.get("authorization") !== `Bearer ${env.TEACH_TOKEN}`) throw new ApiError("unauthorized", 401);
  if (url.pathname === "/api/teach/item") {
    const k = url.searchParams.get("k") || "";
    if (!/^teach:[0-9a-f]{16,64}$/.test(k)) throw new ApiError("bad_key", 400);
    const v = await env.STORE.get(k, "json");
    if (!v) throw new ApiError("not_found", 404);
    if (request.method === "DELETE") { await env.STORE.delete(k); return json({ deleted: k }); }
    return json(v);
  }
  const r = await env.STORE.list({ prefix: "teach:", limit: 1000, cursor: url.searchParams.get("cursor") || undefined });
  return json({ keys: r.keys.map((k) => ({ key: k.name, ...k.metadata })), cursor: r.list_complete ? null : r.cursor,
    count: Number(await env.STORE.get("teach-count")) || 0, max: Number(env.TEACH_MAX || 1500) });
}

// ------------------------------------------------------------------------------------------------
// Brand agent (agent.js) – what it gets from this file, and the quota it shows before asking for an OK
// ------------------------------------------------------------------------------------------------
/**
 * Today's Gemini budget as the visitor sees it in the agent's confirm card:
 *   left_requests  = Σ over video models not marked exhausted of (free per model − requests counted today)
 *   visitor_left   = new analyses this visitor may still start today (DAILY_ANALYSES − counter, not bumped here)
 *   blocked        = why new analyses are impossible right now (invite, key mode, no key) – null if possible
 * The free tier counts per model family, so the number is an estimate (Google does not report the remainder).
 */
async function quotaInfo(request, env) {
  const models = videoModels(env);
  const exhausted = new Set(await exhaustedModels(env, models));
  const rows = env.STORE ? await Promise.all(models.map((m) => env.STORE.get(`usage:${today()}:${m}`, "json"))) : [];
  const used = rows.reduce((n, r) => n + (r?.requests || 0), 0);
  const left = models.reduce((n, m, i) => n + (exhausted.has(m) ? 0 : Math.max(0, FREE_REQUESTS_PER_MODEL - (rows[i]?.requests || 0))), 0);
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const mine = env.STORE ? Number(await env.STORE.get(`count:analyze:${today()}:${ip}`)) || 0 : 0;
  const cap = Number(env.DAILY_ANALYSES || 10);
  return { models: models.length, exhausted: exhausted.size, used_requests: used, left_requests: left, free_per_model: FREE_REQUESTS_PER_MODEL,
    visitor_left: Math.max(0, cap - mine), visitor_cap: cap, reset_in_s: secondsToReset(), blocked: geminiDenied(request, env) };
}

const KIT = { ApiError, sseResponse, analyzeVideo, cachedAnalysis, geminiDenied, withinLimit, bumpGlobal, exhaustedModels, videoModels,
  quotaInfo, sha256, BROWSER_HEADERS, ID_RE };
