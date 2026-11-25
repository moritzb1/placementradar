/**
 * assess.js — "AI estimate": POST /api/assess (plain JSON, view: a section in Find creators and in Channel fit)
 *
 * A general opinion of Gemini whether a creator suits a brand / product – also for channels of which we have not
 * analysed a single video. It is an ESTIMATE FROM TEXT: Gemini reads, it does not watch.
 *
 * Input sent to Gemini (shared/prompts.js assessPrompt), nothing else:
 *   - channel title, handle, subscribers, channel description ("About" text, if YouTube gave it to us)
 *   - the latest ≤ 25 uploads: title, views, upload date, first ~220 characters of the description
 *     (channel.js loadChannel – the same 6-hour cache as Channel fit / Find creators, usually 0 new units)
 *   - a summary of videos we already analysed (brands on screen, paid or gifted, ad-label verdict)   → 0 requests
 *   - comment excerpts (≤ 100 characters, no names) already cached by the Audience tab – read only, never fetched
 *
 * Body: { c: channel id "UC…" (or @handle / link), brand?, product?, peek? }
 *   peek: true → only look in the cache and report today's quota; never calls Gemini, never counts against a limit.
 *               The UI uses it to show an estimate made earlier (by anyone) without a click.
 *
 * Costs and limits (all free):
 *   - 1 Gemini request per new estimate, on its own model chain ASSESS_MODELS (3.7 Flash → 3.1 Flash-Lite preview) – models
 *     neither the video analysis nor the live scanner use, so both keep their quotas (MODELS.md row 7)
 *   - KV cache per channel + brand + product for 7 days (`assess:v<prompt version>:<channel id>:<hash>`)
 *   - DAILY_ASSESS new estimates per visitor and day (default 10); cached ones are free and unlimited
 *   - only on a click ("Ask Gemini") – never for a whole shortlist automatically
 *
 * After the answer: every partner and brand-safety topic must quote its evidence from the input; we check that the
 * quote really occurs there (`verified`) and drop unverified partners (counted in `checks.dropped_partners`).
 * The estimate is NEVER added to the rule-based creator score / channel fit (README → AI estimate, "why apart").
 */
import { norm } from "./public/js/shared/aggregate.js";
import { ASSESS_MODELS, ASSESS_PROMPT_VERSION, ASSESS_SCHEMA, assessPrompt } from "./public/js/shared/prompts.js";
import { checkDisclosure } from "./public/js/disclosure.js";
import { RULES_VERSION } from "./public/js/shared/comments.js";
import { isUnknownBrand, screenTime } from "./public/js/shared/normalize.js";
import { loadChannel, parseChannelInput, channelLibrary, publicChannel } from "./channel.js";

const TTL_S = 7 * 24 * 60 * 60;        // an estimate from titles changes slowly; a week keeps repeat clicks free
const MAX_ANALYSED = 8;                 // analysed videos summarised in the prompt (newest first)
const MAX_COMMENTS = 12;                // comment excerpts in the prompt

export const ASSESS_MESSAGES = {
  assess_limit: "You reached today's limit for AI estimates – estimates made before still open.",
  invalid_assess: "Please give a channel and a brand or product.",
};

export const assessModels = (env) => (env.ASSESS_MODELS ? String(env.ASSESS_MODELS).split(",").map((s) => s.trim()).filter(Boolean) : ASSESS_MODELS);

export async function assess(request, env, kit) {
  const body = await request.json().catch(() => ({}));
  const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f<>"]/g, "").trim().slice(0, n);
  const brand = clean(body.brand, 60), product = clean(body.product, 60);
  const input = parseChannelInput(body.c);
  if (!input || (norm(brand).length < 2 && norm(product).length < 2)) throw new kit.ApiError("invalid_assess", 400);

  // cache key: canonical channel id (an @handle is resolved through channel.js' alias first) + what we compare with
  const alias = env.STORE && input.kind !== "id" ? await env.STORE.get(`channelalias:${input.kind}:${input.value.toLowerCase()}`) : null;
  const chId = input.kind === "id" ? input.value : alias;
  const target = `${norm(brand)}|${norm(product)}`;
  const keyFor = async (id) => `assess:v${ASSESS_PROMPT_VERSION}:${id}:${(await kit.sha256(target)).slice(0, 16)}`;
  const cached = chId && env.STORE ? await env.STORE.get(await keyFor(chId), "json") : null;
  const quota = await assessQuota(request, env, kit);
  // `nocache` (ask again although cached) and `dry` (return the prompt, no Gemini) exist only for the tests in
  // EVALUATION.md E4 and work only on a local dev server – online the host is never localhost
  const local = /^(localhost|127\.0\.0\.1)$/.test(new URL(request.url).hostname);
  const nocache = local && !!body.nocache, dry = local && !!body.dry;
  if (cached && !nocache) return { ...cached, cached: true, quota };
  if (body.peek && !dry) return { estimate: null, cached: false, quota };

  if (dry) { // test only: the exact text Gemini would read
    const cost = { units: 0, cached: false, kv_reads: 0 }; const ch = await loadChannel(request, env, kit, input, cost);
    return { prompt: assessPrompt(await promptData(env, ch, await channelLibrary(request, env, kit, ch, cost), { brand, product }, cost)) };
  }

  // ---- a new estimate: access, limits, data ----------------------------------------------------------------------
  const denied = kit.geminiDenied(request, env); if (denied) throw new kit.ApiError(denied, 403);
  const models = assessModels(env);
  if ((await kit.exhaustedModels(env, models)).length >= models.length) throw new kit.ApiError("quota_exhausted", 429);
  const cost = { units: 0, cached: false, kv_reads: 0 };
  const ch = await loadChannel(request, env, kit, input, cost); // 6-hour cache; counts against DAILY_CHANNELS only if new
  if (!(await kit.withinLimit(env, request, "assess", Number(env.DAILY_ASSESS || 10)))) throw new kit.ApiError("assess_limit", 429);

  const lib = await channelLibrary(request, env, kit, ch, cost);
  const data = await promptData(env, ch, lib, { brand, product }, cost);
  const t0 = Date.now();
  const r = await kit.gemini(env, models, { contents: [{ parts: [{ text: assessPrompt(data) }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: ASSESS_SCHEMA, temperature: 0.2, maxOutputTokens: 8192,
      thinkingConfig: { thinkingLevel: "LOW" } } }) // low thinking: a text judgement, not a puzzle (worker.js drops it if a model refuses it)
    .catch(async (e) => { await refund(env, request); throw e; }); // Google busy / quota gone → the visitor's try does not count
  const { estimate, checks } = verify(r.data, data);

  const out = {
    estimate, checks,
    channel: publicChannel(ch), brand, product,
    input: { uploads: data.uploads.length, with_description: data.uploads.filter((u) => u.description).length, channel_description: !!ch.description,
      analysed: data.analysed.length, comments: data.comments.length, chars: assessPrompt(data).length },
    model: r.model, usage: r.usage, seconds: Math.round((Date.now() - t0) / 1000),
    created_at: new Date().toISOString(), prompt_version: ASSESS_PROMPT_VERSION,
  };
  if (env.STORE) await env.STORE.put(await keyFor(ch.id), JSON.stringify(out), { expirationTtl: TTL_S });
  return { ...out, cached: false, quota: await assessQuota(request, env, kit) };
}

/** What goes into the prompt – titles, numbers, our analyses, cached comment excerpts. */
async function promptData(env, ch, lib, { brand, product }, cost) {
  const ups = ch.uploads || [];
  const views = ups.map((u) => u.views).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  const analysed = [...lib].sort((a, b) => String(b.analysis.video?.upload_date || "").localeCompare(String(a.analysis.video?.upload_date || "")))
    .slice(0, MAX_ANALYSED).map(({ analysis: a }) => {
      const brands = (a.brands || []).filter((b) => !isUnknownBrand(b.brand)).sort((x, y) => screenTime(y) - screenTime(x)).slice(0, 8).map((b) => b.brand);
      const level = checkDisclosure(a).level;
      return `"${a.video?.title || a.video?.id}"${a.video?.upload_date ? ` (${a.video.upload_date})` : ""}: brands ${brands.join(", ") || "none"}; ${a.paid?.looks_like_paid_promotion ? "looks paid or gifted" : "no sign of payment"}; ad label: ${{ green: "labelled", orange: "weak label", red: "not labelled", none: "no ad signals" }[level] || level}`;
    });
  const comments = [];
  if (env.STORE) {
    for (const { id } of lib.slice(0, 10)) {
      if (comments.length >= MAX_COMMENTS) break;
      const { keys } = await env.STORE.list({ prefix: `comments:r${RULES_VERSION}:${id}:`, limit: 1 });
      if (!keys.length) continue;
      const c = await env.STORE.get(keys[0].name, "json"); cost.kv_reads += 1;
      for (const slot of [c?.general, ...Object.values(c?.brands || {})]) for (const e of slot?.examples || []) if (comments.length < MAX_COMMENTS) comments.push(e.text);
    }
  }
  return { channel: { title: ch.title, handle: ch.handle, subscribers: ch.subscribers, description: ch.description || "" },
    uploads: ups.slice(0, 25).map((u) => ({ title: u.title, views: u.views, published: u.published, description: (u.description || "").slice(0, 220) })),
    analysed, comments, brand, product, median_views: views.length ? views[Math.floor(views.length / 2)] : null };
}

/**
 * Hallucination check: a partner or a brand-safety topic counts only if its quoted evidence occurs in the input text
 * (case, spaces and punctuation ignored; a quote of ≥ 12 characters may match as a part). Unverified partners are
 * dropped, unverified topics are kept but marked – a risk the model saw without exact words is still worth a look.
 */
export function verify(raw, data) {
  const hay = squash([data.channel.title, data.channel.description, ...data.uploads.flatMap((u) => [u.title, u.description]), ...data.analysed, ...data.comments].join(" \n "));
  const found = (q) => { const s = squash(q); return s.length >= 4 && hay.includes(s.length > 80 ? s.slice(0, 80) : s); };
  const e = raw && typeof raw === "object" ? raw : {};
  const partners = (Array.isArray(e.partners) ? e.partners : []).map((p) => ({ brand: String(p.brand || "").slice(0, 60), kind: p.kind, evidence: String(p.evidence || "").slice(0, 120), verified: found(p.evidence) }));
  const topics = (Array.isArray(e.brand_safety?.topics) ? e.brand_safety.topics : []).map((t) => ({ topic: String(t.topic || "").slice(0, 60), evidence: String(t.evidence || "").slice(0, 120), verified: found(t.evidence) }));
  const kept = partners.filter((p) => p.verified && p.brand);
  return {
    estimate: { ...e, partners: kept, brand_safety: { ...(e.brand_safety || {}), topics },
      fit: { ...(e.fit || {}), reasons: (e.fit?.reasons || []).slice(0, 3) } },
    checks: { partners_given: partners.length, dropped_partners: partners.length - kept.length, dropped: partners.filter((p) => !p.verified).map((p) => p.brand),
      topics_unverified: topics.filter((t) => !t.verified).length },
  };
}
/** Gives back one count of today's DAILY_ASSESS when the Gemini call failed (KV counter of worker.js withinLimit). */
async function refund(env, request) {
  if (!env.STORE) return;
  const key = `count:assess:${new Date().toISOString().slice(0, 10)}:${request.headers.get("cf-connecting-ip") || "local"}`;
  const n = Number(await env.STORE.get(key)) || 0;
  if (n > 0) await env.STORE.put(key, String(n - 1), { expirationTtl: 60 * 60 * 26 });
}
const squash = (s) => String(s || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");

/** Today's budget for the UI: what this visitor may still ask, and the estimated free requests left on the chain. */
async function assessQuota(request, env, kit) {
  const models = assessModels(env);
  const exhausted = new Set(await kit.exhaustedModels(env, models));
  const day = new Date().toISOString().slice(0, 10);
  const rows = env.STORE ? await Promise.all(models.map((m) => env.STORE.get(`usage:${day}:${m}`, "json"))) : [];
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const mine = env.STORE ? Number(await env.STORE.get(`count:assess:${day}:${ip}`)) || 0 : 0;
  const cap = Number(env.DAILY_ASSESS || 10);
  return { visitor_left: Math.max(0, cap - mine), visitor_cap: cap, models,
    left_requests: models.reduce((n, m, i) => n + (exhausted.has(m) ? 0 : Math.max(0, kit.FREE_REQUESTS_PER_MODEL - (rows[i]?.requests || 0))), 0),
    free_per_model: kit.FREE_REQUESTS_PER_MODEL, blocked: kit.geminiDenied(request, env) };
}
