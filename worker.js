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
import { VIDEO_MODELS, FRAME_MODELS, TIMELINE_PROMPT, TIMELINE_SCHEMA, AUTHENTICITY_SCHEMA, FRAME_PROMPT, FRAME_SCHEMA,
  authenticityPrompt, geminiBody } from "./public/js/shared/prompts.js";
import { normalizeAnalysis, promotedCandidates } from "./public/js/shared/normalize.js";

const API = "https://generativelanguage.googleapis.com/v1beta";
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Visitor-facing texts for every error code (English, like the UI). The app shows `message` as is. */
const MESSAGES = {
  quota_exhausted: "Today's free analyses are used up – try an example, the live scanner, or come back tomorrow.",
  frame_quota_exhausted: "Today's free cloud recognitions are used up – barcode and on-device recognition still work.",
  daily_limit: "You reached today's limit for new analyses – the examples and the live scanner still work.",
  invite_required: "New analyses need an invite link. The examples work without one.",
  own_key_required: "This version needs your own Gemini key. The examples and the live scanner still work.",
  server_key_missing: "The server has no Gemini key configured. The examples still work.",
  video_too_long: "This video is too long – PlacementRadar analyses videos up to 20 minutes.",
  busy: "Google's AI is overloaded right now – please try again in a few minutes.",
  invalid_video: "That does not look like a YouTube video link.",
};

class ApiError extends Error {
  constructor(code, status = 400, detail = "") { super(code); this.code = code; this.status = status; this.detail = detail; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/config") return json(await config(env));
      if (url.pathname === "/api/meta") return json(await videoMeta(url.searchParams.get("v")));
      if (url.pathname === "/api/recent") return json(await recent(env));
      if (url.pathname === "/api/analyze" && request.method === "POST") return await analyze(request, env, ctx);
      if (url.pathname === "/api/identify" && request.method === "POST") return await identify(request, env, ctx);
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
// YouTube metadata: oEmbed (title, channel) + player data (views, length, description, upload date).
// Player data comes from the watch page; when YouTube serves a consent/bot page to the Worker's data-centre
// IP (seen online on 20 Nov: views and description were missing), we ask YouTube's own player endpoint instead.
// ------------------------------------------------------------------------------------------------
const BROWSER_HEADERS = {
  "accept-language": "en",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  cookie: "CONSENT=YES+cb; SOCS=CAI", // skips the EU cookie-consent interstitial
};

async function playerFromWatchPage(id, trace) {
  const page = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers: BROWSER_HEADERS });
  const html = page.ok ? await page.text() : "";
  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|<\/script>)/s);
  let p = null; try { p = m ? JSON.parse(m[1]) : null; } catch { /* format changed */ }
  trace.push(`watch:${page.status}${/consent\./.test(page.url + html.slice(0, 5000)) ? ":consent" : ""}:${p?.playabilityStatus?.status || (m ? "unparsed" : "no-player")}`);
  return p;
}

async function playerFromApi(id, trace) {
  const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST", headers: { ...BROWSER_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20241120.01.00", hl: "en" } }, videoId: id }) });
  const j = r.ok ? await r.json().catch(() => null) : null;
  trace.push(`api:${r.status}:${j?.playabilityStatus?.status || "-"}:${j?.videoDetails?.viewCount ? "details" : "no-details"}`);
  return j;
}

export async function videoMeta(id) {
  if (!ID_RE.test(id || "")) throw new ApiError("invalid_video", 400);
  const meta = { id, title: "", channel: "", views: null, duration_s: null, upload_date: null, description: "" };
  const o = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
  if (o.ok) { const j = await o.json(); meta.title = j.title; meta.channel = j.author_name; }
  const trace = []; // which YouTube source answered how – returned as meta.source for diagnosis
  let p = await playerFromWatchPage(id, trace);
  if (!p?.videoDetails?.viewCount) p = (await playerFromApi(id, trace)) || p;
  meta.source = trace.join(" ");
  const d = p?.videoDetails;
  if (d) {
    meta.title ||= d.title; meta.channel ||= d.author;
    meta.views = d.viewCount ? Number(d.viewCount) : null;
    meta.duration_s = d.lengthSeconds ? Number(d.lengthSeconds) : null;
    meta.description = d.shortDescription || "";
    meta.upload_date = p.microformat?.playerMicroformatRenderer?.uploadDate?.slice(0, 10) || null;
  } else {
    console.log(`videoMeta ${id}: no player data from YouTube (consent/bot page?) – only oEmbed`);
  }
  return meta;
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
        return { model, data: JSON.parse(text), usage: j.usageMetadata };
      }
      const err = await r.text();
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
      } else if ([429, 500, 503].includes(r.status)) {
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
// POST /api/analyze  → SSE stream: stage | meta | model | result | error  (+ ping every 5 s)
// Order: repo demo → KV cache → access check → quota check → Gemini.
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
  if (!(await withinLimit(env, request, "analyze", Number(env.DAILY_ANALYSES || 10)))) throw new ApiError("daily_limit", 429);

  return sseResponse(ctx, async (send) => {
    await send("stage", { id: "meta" });
    const meta = await videoMeta(v);
    await send("meta", meta);
    if (meta.duration_s && meta.duration_s > Number(env.MAX_VIDEO_S || 1200)) throw new ApiError("video_too_long");

    await send("stage", { id: "timeline" });
    const tl = await gemini(env, models, geminiBody({ video: v, prompt: TIMELINE_PROMPT, schema: TIMELINE_SCHEMA }),
      (ev, data) => send(ev, data));

    await send("stage", { id: "authenticity" });
    let au = null;
    const products = promotedCandidates(tl.data);
    if (products.length && tl.data.looks_like_paid_promotion !== false) {
      au = await gemini(env, models, geminiBody({ video: v, prompt: authenticityPrompt(products), schema: AUTHENTICITY_SCHEMA }),
        (ev, data) => send(ev, data)).catch(() => null); // authenticity is optional – never fail the whole analysis
    }

    await send("stage", { id: "done" });
    const result = normalizeAnalysis({ video: meta, timeline: tl.data, authenticity: au?.data, models: [tl.model, au?.model].filter(Boolean) });
    if (env.STORE) {
      // kept forever: whatever the professor analyses once loads instantly the next time
      const metadata = { title: meta.title, channel: meta.channel, views: meta.views, duration_s: meta.duration_s,
        brands: result.brands?.length || 0, analyzed_at: new Date().toISOString() };
      ctx.waitUntil(env.STORE.put(`analysis:${v}`, JSON.stringify(result), { metadata }));
    }
    await send("result", result);
  });
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
  const { image, provider } = await request.json().catch(() => ({}));
  if (!image || typeof image !== "string" || image.length > 400_000) throw new ApiError("image_invalid", 400);

  const key = `frame:${provider ? `${provider}:` : ""}${await sha256(image)}`;
  const hit = env.STORE && (await env.STORE.get(key, "json"));
  if (hit) return json({ ...hit, cached: true });

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
      const out = { items: cleanItems(r.items), model: r.model, provider: p.name, tried };
      if (env.STORE) ctx.waitUntil(env.STORE.put(key, JSON.stringify(out), { expirationTtl: 60 * 60 * 24 * 30 }));
      return json(out);
    } catch (e) {
      tried.push({ provider: p.name, error: e instanceof ApiError ? e.code : String(e?.message || e).slice(0, 120) });
    }
  }
  throw new ApiError("frame_quota_exhausted", 429, JSON.stringify(tried));
}

/** Same shape for every provider: brand, product, box_2d (0–1000 or null), confidence 0–1. */
function cleanItems(items) {
  return (Array.isArray(items) ? items : []).filter((it) => it && typeof it.brand === "string" && it.brand.trim())
    .map((it) => {
      const b = Array.isArray(it.box_2d) && it.box_2d.length === 4 && it.box_2d.every((n) => Number.isFinite(Number(n)))
        ? it.box_2d.map((n) => Math.max(0, Math.min(1000, Math.round(Number(n))))) : null;
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
  let lastErr;
  for (const model of list(env.WORKERS_AI_MODELS, ["@cf/meta/llama-3.2-11b-vision-instruct"])) {
    const input = { messages: [{ role: "user", content: OPEN_PROMPT }], image: `data:image/jpeg;base64,${image}`, max_tokens: 512, temperature: 0.1 };
    try {
      let r;
      try { r = await env.AI.run(model, input); }
      catch (e) {
        if (!/agree/i.test(String(e?.message))) throw e;
        await env.AI.run(model, { prompt: "agree" }); // Meta's licence must be accepted once per account (Cloudflare docs)
        r = await env.AI.run(model, input);
      }
      const text = typeof r?.response === "string" ? r.response : JSON.stringify(r?.response ?? r);
      return { items: parseLooseJson(text).items, model };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("no Workers AI model");
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
