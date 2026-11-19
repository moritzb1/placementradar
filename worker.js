/**
 * worker.js — PlacementRadar backend on Cloudflare Workers.
 *
 * The Worker serves the static app (public/) and offers a tiny, locked-down API:
 *
 *   GET  /api/config            → which key mode is active, whether an invite is needed
 *   GET  /api/meta?v=<id>       → title, channel, views, duration, description of a YouTube video
 *                                 (fetched server-side; browsers cannot read YouTube pages because of CORS)
 *   POST /api/analyze {v}       → full Gemini video analysis, streamed as Server-Sent Events
 *   POST /api/identify {image}  → brands in one camera frame (live mode fallback)
 *
 * Key handling ("KEY_MODE", see README → Hosting):
 *   shared → the project's Gemini key (Cloudflare secret GEMINI_API_KEY) is used. Never sent to the browser.
 *   own    → the Worker refuses Gemini calls; the browser asks the viewer for their own key and calls Gemini directly.
 *
 * Abuse protection while the shared key is active:
 *   - only two fixed tasks with fixed prompts (no open Gemini proxy)
 *   - optional invite token (secret INVITE_TOKEN) for new analyses; demos always work
 *   - per-visitor daily limits and a result cache (KV namespace STORE, optional)
 *   - max. video length
 *
 * Long requests: a video analysis takes 1.5–5 min. The response is opened immediately as an SSE stream and a
 * heartbeat is sent every 5 s, so no proxy closes the idle connection (test G, EVALUATION.md).
 */
import { VIDEO_MODELS, FRAME_MODELS, TIMELINE_PROMPT, TIMELINE_SCHEMA, AUTHENTICITY_SCHEMA, FRAME_PROMPT, FRAME_SCHEMA,
  authenticityPrompt, geminiBody } from "./public/js/shared/prompts.js";
import { normalizeAnalysis, promotedCandidates } from "./public/js/shared/normalize.js";

const API = "https://generativelanguage.googleapis.com/v1beta";
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/config") return json(config(env));
      if (url.pathname === "/api/meta") return json(await videoMeta(url.searchParams.get("v")));
      if (url.pathname === "/api/analyze" && request.method === "POST") return analyze(request, env, ctx);
      if (url.pathname === "/api/identify" && request.method === "POST") return identify(request, env);
      if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
    return env.ASSETS.fetch(request); // static app
  },
};

// ------------------------------------------------------------------------------------------------
function config(env) {
  return { key_mode: env.KEY_MODE === "own" ? "own" : "shared", invite_required: !!env.INVITE_TOKEN,
    max_video_s: Number(env.MAX_VIDEO_S || 1200), video_models: VIDEO_MODELS, frame_models: FRAME_MODELS };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function guard(request, env, url) {
  if (env.KEY_MODE === "own") return { status: 403, error: "own_key_required" };
  if (!env.GEMINI_API_KEY) return { status: 503, error: "server_key_missing" };
  if (env.INVITE_TOKEN) {
    const token = request.headers.get("x-invite") || url.searchParams.get("invite");
    if (token !== env.INVITE_TOKEN) return { status: 401, error: "invite_required" };
  }
  return null;
}

/** Daily counter per visitor (IP) and task, stored in KV if bound. Returns false when over the limit. */
async function withinLimit(env, request, task, limit) {
  if (!env.STORE) return true;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = `count:${task}:${new Date().toISOString().slice(0, 10)}:${ip}`;
  const n = Number(await env.STORE.get(key)) || 0;
  if (n >= limit) return false;
  await env.STORE.put(key, String(n + 1), { expirationTtl: 60 * 60 * 26 });
  return true;
}

// ------------------------------------------------------------------------------------------------
// YouTube metadata: oEmbed (title, channel) + watch page (views, length, description, upload date)
// ------------------------------------------------------------------------------------------------
export async function videoMeta(id) {
  if (!ID_RE.test(id || "")) throw new Error("invalid video id");
  const meta = { id, title: "", channel: "", views: null, duration_s: null, upload_date: null, description: "" };
  const o = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
  if (o.ok) { const j = await o.json(); meta.title = j.title; meta.channel = j.author_name; }
  const page = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers: { "accept-language": "en" } });
  if (page.ok) {
    const html = await page.text();
    const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|<\/script>)/s);
    if (m) {
      try {
        const p = JSON.parse(m[1]);
        const d = p.videoDetails || {};
        meta.title ||= d.title; meta.channel ||= d.author;
        meta.views = d.viewCount ? Number(d.viewCount) : null;
        meta.duration_s = d.lengthSeconds ? Number(d.lengthSeconds) : null;
        meta.description = d.shortDescription || "";
        meta.upload_date = p.microformat?.playerMicroformatRenderer?.uploadDate?.slice(0, 10) || null;
      } catch { /* page format changed – keep oEmbed data */ }
    }
  }
  return meta;
}

// ------------------------------------------------------------------------------------------------
// Gemini with model chain: on 429 (quota) / 500 / 503 (overloaded) try the next model.
// ------------------------------------------------------------------------------------------------
export async function gemini(key, models, body, onTry = () => {}) {
  let last = "";
  for (let round = 0; round < 2; round++) {
    for (const model of models) {
      onTry(model);
      const r = await fetch(`${API}/models/${model}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
      if (r.ok) {
        const j = await r.json();
        const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
        return { model, data: JSON.parse(text), usage: j.usageMetadata };
      }
      last = `${model}: HTTP ${r.status}`;
      if (r.status === 400 && body.generationConfig?.thinkingConfig) { // model without thinking control → retry once without
        const { thinkingConfig, ...rest } = body.generationConfig;
        body = { ...body, generationConfig: rest };
      } else if (![429, 500, 503].includes(r.status)) {
        throw new Error(`${last} ${(await r.text()).slice(0, 200)}`);
      }
    }
    await new Promise((res) => setTimeout(res, 8000));
  }
  throw new Error(`all models busy or out of quota (${last})`);
}

// ------------------------------------------------------------------------------------------------
// POST /api/analyze  → SSE stream: stage | meta | result | error  (+ ping every 5 s)
// ------------------------------------------------------------------------------------------------
async function analyze(request, env, ctx) {
  const url = new URL(request.url);
  const { v } = await request.json().catch(() => ({}));
  if (!ID_RE.test(v || "")) return json({ error: "invalid video id" }, 400);
  const denied = guard(request, env, url);
  if (denied) return json({ error: denied.error }, denied.status);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (event, data) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => {});

  const work = (async () => {
    const t0 = Date.now();
    const ping = setInterval(() => send("ping", { s: Math.round((Date.now() - t0) / 1000) }), 5000);
    try {
      const cached = env.STORE && (await env.STORE.get(`analysis:${v}`, "json"));
      if (cached) { await send("result", { ...cached, cached: true }); return; }
      if (!(await withinLimit(env, request, "analyze", Number(env.DAILY_ANALYSES || 10)))) throw new Error("daily_limit");

      await send("stage", { id: "meta" });
      const meta = await videoMeta(v);
      await send("meta", meta);
      if (meta.duration_s && meta.duration_s > Number(env.MAX_VIDEO_S || 1200)) throw new Error("video_too_long");

      await send("stage", { id: "timeline" });
      const tl = await gemini(env.GEMINI_API_KEY, VIDEO_MODELS, geminiBody({ video: v, prompt: TIMELINE_PROMPT, schema: TIMELINE_SCHEMA }),
        (model) => send("model", { model }));

      await send("stage", { id: "authenticity" });
      let au = null;
      const products = promotedCandidates(tl.data);
      if (products.length && tl.data.looks_like_paid_promotion !== false) {
        au = await gemini(env.GEMINI_API_KEY, VIDEO_MODELS, geminiBody({ video: v, prompt: authenticityPrompt(products), schema: AUTHENTICITY_SCHEMA }),
          (model) => send("model", { model })).catch(() => null); // authenticity is optional – never fail the whole analysis
      }

      await send("stage", { id: "done" });
      const result = normalizeAnalysis({ video: meta, timeline: tl.data, authenticity: au?.data, models: [tl.model, au?.model].filter(Boolean) });
      if (env.STORE) ctx.waitUntil(env.STORE.put(`analysis:${v}`, JSON.stringify(result)));
      await send("result", result);
    } catch (e) {
      await send("error", { error: String(e?.message || e) });
    } finally {
      clearInterval(ping);
      writer.close().catch(() => {});
    }
  })();
  ctx.waitUntil(work);
  return new Response(readable, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
}

// ------------------------------------------------------------------------------------------------
// POST /api/identify {image: base64 JPEG}  → {items:[{brand, product, box_2d, confidence}], model}
// ------------------------------------------------------------------------------------------------
async function identify(request, env) {
  const url = new URL(request.url);
  const denied = guard(request, env, url);
  if (denied) return json({ error: denied.error }, denied.status);
  const { image } = await request.json().catch(() => ({}));
  if (!image || image.length > 400_000) return json({ error: "image missing or too large (max ~300 KB)" }, 400);
  if (!(await withinLimit(env, request, "identify", Number(env.DAILY_IDENTIFY || 60)))) return json({ error: "daily_limit" }, 429);
  const r = await gemini(env.GEMINI_API_KEY, FRAME_MODELS, geminiBody({ image, prompt: FRAME_PROMPT, schema: FRAME_SCHEMA, lowThinking: false }));
  return json({ items: r.data.items || [], model: r.model });
}
