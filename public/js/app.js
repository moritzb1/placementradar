/**
 * app.js — PlacementRadar front end (no framework, plain ES modules).
 *
 * Routes (hash based, so the app also works as plain static files):
 *   #/                       start screen: paste a YouTube link or pick a demo
 *   #/v/<id>/<view>[?t=12]   result for one video; view = overview | timeline | value | disclosure | authenticity | report
 *   #/live                   live scanner (camera or photo, mostly on-device; see live.js)
 *
 * Where the data comes from:
 *   1. data/<id>.json  – pre-analysed demo videos (instant, no API quota)
 *   2. sessionStorage  – analyses done in this browser session
 *   3. POST /api/analyze (Cloudflare Worker, streamed) – new videos, Gemini does the work
 *
 * Modules: player.js (YouTube embed) · value.js (media value) · disclosure.js (ad label check) ·
 *          shared/normalize.js (data model) · icons.js (own SVG icons, no emoji)
 */
import { icon, LOGO } from "./icons.js";
import { Player } from "./player.js";
import { videoValue, brandValue, euro, WEIGHTS, DEFAULTS } from "./value.js";
import { checkDisclosure } from "./disclosure.js";
import { mmss } from "./shared/normalize.js";
import { renderLive, stopLive } from "./live.js";
import { hydrateLogos } from "./logos.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtViews = (n) => n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
/** Video length; "≈" when YouTube withheld it and the Worker estimated it from the last brand appearance. */
const fmtDur = (v) => (v?.duration_estimated ? "≈ " : "") + mmss(v?.duration_s || 0);
/** "20261117" (yt-dlp style) or "2026-11-17" → "2026-11-17". */
const fmtDate = (d) => String(d || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
/** Small (i) with an explanation on hover/focus – used next to every number. */
const info = (text) => `<span class="info" tabindex="0" role="note" aria-label="${esc(text)}" data-info="${esc(text)}">i</span>`;
const PALETTE = ["#0a84ff", "#ff9f0a", "#30d158", "#bf5af2", "#ff375f", "#64d2ff", "#ffd60a", "#ac8e68", "#5e5ce6", "#66d4cf"];

const state = { demos: [], recent: [], data: null, id: null, view: "overview", player: null, colors: new Map(), opts: { ...DEFAULTS }, pendingSeek: null };

// ------------------------------------------------------------------------------------------------
// Preferences (Settings sheet) – stored per browser; storage may be blocked, so every access is guarded
// ------------------------------------------------------------------------------------------------
const PREFS_KEY = "pr:prefs";
const prefs = { theme: "auto", usage: false, tech: false };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || "{}")); } catch { /* private mode */ }
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };
function applyTheme() {
  if (prefs.theme === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = prefs.theme;
}
applyTheme();

// Recognitions in the live scanner (on device = 0 tokens) – counted for the usage meter
const session = { recognitions: {} };
window.addEventListener("pr:recognition", (e) => { const k = e.detail.engine || "other"; session.recognitions[k] = (session.recognitions[k] || 0) + 1; refreshUsagePill(); });

const VIEWS = [
  { id: "overview", label: "Products", icon: "bag" },
  { id: "timeline", label: "Brand timeline", icon: "timeline" },
  { id: "value", label: "Media value", icon: "value" },
  { id: "disclosure", label: "Ad disclosure", icon: "shield" },
  { id: "authenticity", label: "Authenticity", icon: "heart" },
  { id: "report", label: "Brand report", icon: "doc" },
];

// ------------------------------------------------------------------------------------------------
// Boot + routing
// ------------------------------------------------------------------------------------------------
async function boot() {
  try { state.demos = await (await fetch("data/index.json")).json(); } catch { state.demos = []; }
  loadRecent(); // videos other visitors analysed (online only) – not awaited, the start screen updates when it arrives
  window.addEventListener("hashchange", route);
  route();
}

function parseHash() {
  const [path, query] = location.hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(query || "");
  return { parts, t: params.has("t") ? Number(params.get("t")) : null };
}

let lastPage = "";
async function route() {
  const { parts, t } = parseHash();
  // new page (not just another tab of the same video) → start at the top
  const pageKey = parts[0] === "v" ? `v/${parts[1]}` : parts[0] || "start";
  if (pageKey !== lastPage) { window.scrollTo(0, 0); lastPage = pageKey; }
  stopLive();
  if (parts[0] === "live") {
    state.id = null; state.data = null; state.page = "live";
    renderSidebar(); destroyPlayer(); await renderLive($("#main")); addInfoButton(); return;
  }
  state.page = parts[0] === "v" ? "video" : "start";
  if (parts[0] === "v" && parts[1]) {
    const id = parts[1];
    state.view = VIEWS.some((v) => v.id === parts[2]) ? parts[2] : "overview";
    if (state.id !== id || !state.data) {
      const data = await loadAnalysis(id);
      if (!data) return renderAnalyze(id);
      state.id = id; state.data = data; assignColors(data);
    }
    state.pendingSeek = t;
    renderSidebar(); renderResult();
  } else {
    state.id = null; state.data = null;
    renderSidebar(); renderStart();
  }
}

/** GET /api/recent → analyses stored in the Worker's KV, minus the repo examples. Silent when offline/local. */
async function loadRecent() {
  try {
    const r = await fetch("api/recent"); if (!r.ok) return;
    const demoIds = new Set(state.demos.map((d) => d.id));
    state.recent = ((await r.json()).items || []).filter((x) => x.id && !demoIds.has(x.id)).slice(0, 12);
  } catch { return; }
  if (!state.recent.length) return;
  if (state.page === "start" && !$("#url")?.value) renderStart(); else renderSidebar(); // never wipe a link being typed
}

const go = (id, view = "overview", t = null) => { location.hash = `#/v/${id}/${view}${t != null ? `?t=${Math.round(t)}` : ""}`; };

async function loadAnalysis(id) {
  const cached = sessionStorage.getItem(`analysis:${id}`);
  if (cached) return JSON.parse(cached);
  try { const r = await fetch(`data/${id}.json`); if (r.ok) return await r.json(); } catch { /* not a demo */ }
  return null;
}

function assignColors(data) {
  state.colors = new Map(data.brands.map((b, i) => [b.brand, PALETTE[i % PALETTE.length]]));
}
const color = (brand) => state.colors.get(brand) || "#8e8e93";
const mono = (brand) => `<span class="mono" style="background:${color(brand)}">${esc(brand.replace(/^the /i, "").charAt(0).toUpperCase())}</span>`;

// ------------------------------------------------------------------------------------------------
// Sidebar
// ------------------------------------------------------------------------------------------------
/** Glass top bar: logo · the two modes (analyse a video / camera) · usage + settings + about. One place for everything. */
function renderSidebar() { renderTopbar(); } // old name, still called from routing
function renderTopbar() {
  const mode = state.page === "live" ? "live" : "video";
  $("#topbar").innerHTML = `
    <button class="tb-brand" data-home>${LOGO}<span>PlacementRadar</span></button>
    <nav class="mode-switch" aria-label="Mode">
      <button class="${mode === "video" ? "on" : ""}" data-home>${icon("play")}<span>Video analysis</span></button>
      <button class="${mode === "live" ? "on" : ""}" data-live>${icon("camera")}<span>Live scanner</span></button>
    </nav>
    <span id="tbActions" class="tb-actions"></span>`;
  $("#topbar").querySelectorAll("[data-home]").forEach((b) => (b.onclick = () => { location.hash = "#/"; }));
  $("#topbar [data-live]").onclick = () => { location.hash = "#/live"; };
  toolbarActions();
}

// ------------------------------------------------------------------------------------------------
// Start screen
// ------------------------------------------------------------------------------------------------
function renderStart() {
  destroyPlayer();
  const card = (d, big) => `
    <article class="demo" data-open="${esc(d.id)}">
      <div class="thumb"><img alt="" src="https://i.ytimg.com/vi/${esc(d.id)}/${big ? "hqdefault" : "mqdefault"}.jpg"></div>
      <div class="t">${esc(d.title || d.id)}</div>
      <div class="m">${esc(d.channel || "")}${d.views != null ? ` · ${fmtViews(d.views)} views` : ""} · ${d.brands ?? "?"} brands</div>
    </article>`;
  $("#main").innerHTML = `
    <section class="start">
      <div class="hero">
        <div class="app-icon">${LOGO}</div>
        <h1>Every brand in a video.</h1>
        <p class="lead">Paste a YouTube link – PlacementRadar shows which brands appear, what that exposure is worth and whether it is labelled as advertising.</p>
        <form class="spotlight" id="go">${icon("search")}<input id="url" placeholder="Paste a YouTube link" autocomplete="off" spellcheck="false"><button>Analyse</button></form>
        <div class="hint" id="hint"></div>
        <ol class="steps"><li><b>1</b>Paste a link</li><li><b>2</b>Gemini watches image and sound</li><li><b>3</b>Brands, value, disclosure</li></ol>
      </div>
      <div class="shelf"><div class="shelf-head"><h2>Examples</h2><span>open instantly</span></div>
        <div class="shelf-row">${state.demos.map((d) => card(d, true)).join("")}</div></div>
      ${state.recent.length ? `<div class="shelf"><div class="shelf-head"><h2>Analysed by visitors</h2><span>saved for everyone</span></div>
        <div class="shelf-row small">${state.recent.map((d) => card(d, false)).join("")}</div></div>` : ""}
      <a class="tool-card" href="#/live"><span class="tc-ic">${icon("camera")}</span><span><b>Live scanner</b><br><span class="muted">Hold a product into your camera – recognised on your device, no cloud needed.</span></span><span class="chev">${icon("chevron")}</span></a>
    </section>`;
  $("#main").querySelectorAll("[data-open]").forEach((el) => (el.onclick = () => go(el.dataset.open)));
  $("#go").onsubmit = (e) => {
    e.preventDefault();
    const id = parseYouTubeId($("#url").value);
    if (!id) { $("#hint").textContent = "That does not look like a YouTube link."; return; }
    go(id);
  };
  $("#url").focus();
}

export function parseYouTubeId(s) {
  s = String(s || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ------------------------------------------------------------------------------------------------
// New analysis (streamed from the Worker)
// ------------------------------------------------------------------------------------------------
const STAGES = [
  { id: "meta", label: "Reading video details" },
  { id: "timeline", label: "Watching the video – brands, speech, on-screen text" },
  { id: "authenticity", label: "Rating how genuine the recommendations feel" },
  { id: "done", label: "Calculating media value and disclosure check" },
];
const modelName = (m) => String(m || "").replace(/^gemini-/, "Gemini ").replace(/-flash-lite/, " Flash-Lite").replace(/-flash/, " Flash").replace(/-preview/, " (preview)").replace(/-pro/, " Pro");
const HTTP_WHY = { 429: "busy", 500: "had an internal error", 503: "overloaded", 504: "timed out", 524: "timed out" };

/**
 * Waiting screen for a new analysis. Gemini needs 1.5–5 minutes (longer if Google is busy), so the screen shows
 * everything that is already known instead of a bare spinner:
 *   - video details as soon as the Worker sends them (event "meta"),
 *   - a first disclosure check on title + description (pure text, no AI needed),
 *   - which model is watching and when Google is busy and the next model takes over (events "model", "retry"),
 *   - that the page may be closed: the Worker finishes and stores the result; reopening the link loads it.
 */
async function renderAnalyze(id) {
  destroyPlayer(); renderSidebar();
  const t0 = Date.now();
  const link = `${location.origin}${location.pathname}#/v/${id}/overview`;
  $("#main").innerHTML = `
    <div class="toolbar"><h1>New analysis</h1><span class="badge"><span class="dot live-dot"></span>Gemini · video understanding</span></div>
    <div class="content">
      <div class="grid-top">
        <div class="player waiting"><img class="poster" alt="" src="https://i.ytimg.com/vi/${id}/hqdefault.jpg"><div class="scanline"></div>
          <div class="wait-cap"><div class="t" id="wtitle">Loading video details …</div><div class="m" id="wmeta"></div></div></div>
        <div class="card wait-card"><h3>${icon("clock")} <span id="wstate">Analysing</span><span class="right num" id="elapsed">0:00</span></h3>
          <div class="progress" style="margin:0">${STAGES.map((s) => `<div class="step" data-stage="${s.id}"><span class="icon"></span>${s.label}</div>`).join("")}</div>
          <div class="wait-status" id="wstatus">Connecting to the server …</div>
          <div class="wait-log" id="wlog"></div>
        </div>
      </div>
      <div class="cols-2" style="margin-top:20px;align-items:start">
        <div class="card"><h3>${icon("shield")} Checked while you wait <span class="right">text only, no AI</span></h3><div id="wpre"><div class="skeleton" style="height:84px"></div></div></div>
        <div class="card"><h3>${icon("sparkle")} What happens now</h3>
          <p class="small muted" style="margin-top:0">Gemini watches the whole video including the audio – usually <b>2–5 minutes</b>, longer when Google's free tier is busy.</p>
          <p class="small muted"><b>You can close this page.</b> The analysis keeps running on the server and is saved permanently. Open the same link later and it loads instantly – for everyone.</p>
          <button class="btn" id="wcopy">${icon("link")} Copy link</button></div>
      </div>
    </div>`;
  $("#wcopy").onclick = async () => { try { await navigator.clipboard.writeText(link); $("#wcopy").lastChild.textContent = " Copied"; } catch { prompt("Link:", link); } };
  const tick = setInterval(() => { const e = $("#elapsed"); if (e) e.textContent = mmss((Date.now() - t0) / 1000); else clearInterval(tick); }, 1000);
  const status = (html) => { const el = $("#wstatus"); if (el) el.innerHTML = html; };
  const log = (html) => { const el = $("#wlog"); if (el) el.insertAdjacentHTML("afterbegin", `<div><span class="num">${mmss((Date.now() - t0) / 1000)}</span><span>${html}</span></div>`); };
  const setStage = (sid) => {
    let reached = false;
    for (const s of STAGES) {
      const el = $(`[data-stage="${s.id}"]`); if (!el) continue;
      const done = !reached && s.id !== sid; if (s.id === sid) reached = true;
      el.className = `step ${s.id === sid ? "on" : done ? "done" : ""}`;
      el.firstElementChild.outerHTML = s.id === sid ? `<span class="spinner"></span>` : done ? icon("check") : `<span class="icon"></span>`;
    }
    const msg = { meta: "Reading title, views and description …", timeline: "Gemini is watching the video …", authenticity: "Gemini is rating the recommendations …", done: "Putting the dashboard together …" }[sid];
    if (msg) status(msg);
  };
  const fail = (msg) => {
    clearInterval(tick);
    const card = $(".wait-card"); if (!card) return;
    card.innerHTML = `<h3>${icon("clock")} Analysis not possible right now</h3><p style="margin:0 0 14px">${esc(msg)}</p>
      <div class="row-btns" style="justify-content:flex-start">${state.demos[0] ? `<button class="btn primary" data-demo>${icon("play")} Open an example</button>` : ""}
      <button class="btn" data-livego>${icon("camera")} Live scanner</button></div>`;
    card.querySelector("[data-demo]")?.addEventListener("click", () => go(state.demos[0].id));
    card.querySelector("[data-livego]").onclick = () => { location.hash = "#/live"; };
    $(".player.waiting")?.classList.add("stopped");
  };
  const onMeta = (m) => {
    $("#wtitle").textContent = m.title || "Untitled video";
    $("#wmeta").textContent = [m.channel, m.views != null ? `${fmtViews(m.views)} views` : null, m.duration_s ? mmss(m.duration_s) : null, fmtDate(m.upload_date)].filter(Boolean).join(" · ");
    const c = checkDisclosure({ video: m });
    const aff = c.signals.find((s) => /affiliate/i.test(s));
    $("#wpre").innerHTML = c.checklist.slice(0, 2).map((x) => `<div class="check"><span class="${x.ok ? "ok" : "no"}">${icon(x.ok ? "check" : "minus")}</span><b>${x.label}</b><span class="small muted">${esc(x.ok ? `ad label ${x.detail}` : "no ad label")}</span></div>`).join("") +
      `<div class="check"><span class="${aff ? "ok" : "no"}">${icon(aff ? "check" : "minus")}</span><b>Shop links</b><span class="small muted">${esc(aff ? aff.replace(/^Shop \/ affiliate link in description /, "affiliate / shop link ") : "none in the description")}</span></div>` +
      `<p class="small muted" style="margin:10px 0 0">On-screen and spoken labels follow once Gemini has watched the video.</p>`;
  };
  try {
    const invite = new URLSearchParams(location.search).get("invite") || localStorage.getItem("invite") || "";
    const r = await fetch("api/analyze", { method: "POST", headers: { "content-type": "application/json", "x-invite": invite }, body: JSON.stringify({ v: id }) });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const why = j.message || { own_key_required: "This version needs your own Gemini key (coming soon).", invite_required: "New analyses need an invite link. The examples work without one.",
        server_key_missing: "The server has no Gemini key configured." }[j.error] || j.error || `HTTP ${r.status}`;
      return fail(why);
    }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (.+)/.exec(chunk)?.[1]; const data = JSON.parse(/data: (.+)/s.exec(chunk)?.[1] || "{}");
        if (ev === "stage") setStage(data.id);
        if (ev === "meta") onMeta(data);
        if (ev === "model") { status(`<b>${esc(modelName(data.model))}</b> is watching the video …`); log(`${esc(modelName(data.model))} started`); }
        if (ev === "retry") {
          status(`Google is busy – switching to the next model …`);
          log(`${esc(modelName(data.model))} ${HTTP_WHY[data.status] || `answered HTTP ${data.status}`} after ${data.after_s} s`);
        }
        if (ev === "joined") { status("This video is already being analysed – waiting for that result …"); log("joined a running analysis (no extra API request)"); }
        if (ev === "error") return fail(data.message || data.error); // worker sends a visitor-friendly message
        if (ev === "result") {
          clearInterval(tick);
          sessionStorage.setItem(`analysis:${id}`, JSON.stringify(data));
          // same hash as now (#/v/<id>/overview) → no hashchange event, so re-route directly
          state.id = null; return route();
        }
      }
    }
    fail("The connection ended before the result arrived. The analysis may still finish – open the link again in a few minutes.");
  } catch {
    fail("Live analysis runs in the online version (Cloudflare Worker). Locally, only the examples are available.");
  }
}

// ------------------------------------------------------------------------------------------------
// Result views
// ------------------------------------------------------------------------------------------------
function renderResult() {
  const d = state.data; const v = d.video;
  const engine = [...new Set(d.source?.models || [])].map(modelName).join(" + ") || "Gemini";
  const meta = [v.channel, v.views != null ? `${fmtViews(v.views)} views` : null, v.duration_s ? fmtDur(v) : null, v.upload_date ? fmtDate(v.upload_date) : null].filter(Boolean);
  const thumb = `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/hqdefault.jpg`;
  $("#main").innerHTML = `
    <header class="v-hero">
      <div class="v-hero-bg" style="background-image:url('${thumb}')"></div>
      <div class="v-hero-in">
        <img class="v-thumb" alt="" src="${thumb}">
        <div class="v-text">
          <div class="eyebrow">Analysed video</div>
          <h1>${esc(v.title)}</h1>
          <div class="meta">${esc(meta.join(" · "))}${prefs.tech ? `<span class="tech"> · ${esc(engine)} · analysed ${esc(d.source?.analyzed_at || "")}</span>` : ""}</div>
        </div>
        <a class="btn glass" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener">${icon("play")} Open on YouTube</a>
      </div>
      <nav class="tabs" aria-label="Views">${VIEWS.map((x) => `<button class="${state.view === x.id ? "on" : ""}" data-view="${x.id}">${x.label}</button>`).join("")}</nav>
    </header>
    <div class="content" id="view"></div>`;
  $("#main").querySelectorAll(".tabs [data-view]").forEach((b) => (b.onclick = () => go(state.id, b.dataset.view)));
  ({ overview: viewOverview, timeline: viewTimeline, value: viewValue, disclosure: viewDisclosure, authenticity: viewAuthenticity, report: viewReport })[state.view]();
}

function destroyPlayer() { state.player?.destroy(); state.player = null; }

/**
 * Mounts the YouTube player into #playerHost. Products at the current second are listed OUTSIDE the video
 * (#now panel, if the view has one) – nothing covers the picture. Soft markers show roughly where they are
 * while the video is paused (positions from Gemini are approximate, see EVALUATION.md test E).
 */
function mountPlayer(onTime) {
  destroyPlayer();
  const host = $("#playerHost");
  const p = new Player(host.querySelector(".yt-host"), state.id, {
    onState: (paused) => { host.classList.toggle("paused", paused && (p.hasPlayed || p.t > 0.5)); updateNow(p.t); },
    onTime: (t) => { onTime?.(t); updateNow(t); },
  });
  state.player = p;
  updateNow(state.pendingSeek ?? 0);
  if (state.pendingSeek != null) { const t = state.pendingSeek; setTimeout(() => p.seek(t), 900); state.pendingSeek = null; }
  return p;

  function updateNow(t) {
    const hits = productsAt(t);
    host.querySelectorAll(".glow").forEach((g) => g.remove());
    for (const b of hits) {
      const f = (b.frames || []).filter((fr) => Math.abs(fr.t - t) <= 4).sort((x, y) => Math.abs(x.t - t) - Math.abs(y.t - t))[0];
      if (!f) continue;
      const [y0, x0, y1, x1] = f.box; const g = document.createElement("div");
      g.className = "glow"; g.dataset.b = b.brand; g.style.left = `${(x0 + x1) / 20}%`; g.style.top = `${(y0 + y1) / 20}%`;
      host.append(g);
    }
    const now = $("#now"); if (!now) return;
    now.querySelector(".now-time").textContent = mmss(t);
    now.querySelector(".now-list").innerHTML = hits.length ? hits.map((b) => {
      const link = productLink(b);
      return `<div class="now-item" data-b="${esc(b.brand)}">${logoBox(b.brand, "sm")}<div class="ni-text"><b>${esc(b.brand)}</b><span>${esc(b.product || b.category || "")}</span></div>
        <a href="${esc(link.url)}" target="_blank" rel="noopener" title="${esc(link.title)}">${link.label}</a></div>`;
    }).join("") : `<div class="now-empty">No product in view at this second.<br><span>Press play, or pick a product below to jump to it.</span></div>`;
    hydrateLogos(now);
    $("#view").querySelectorAll(".pcard").forEach((c) => c.classList.toggle("live", hits.some((b) => b.brand === c.dataset.brand)));
  }
}

const productsAt = (t) => state.data.brands.filter((b) => b.appearances.some((a) => a.channel === "visual" && t >= a.start_s - 1 && t <= a.end_s + 1));
/** Logo tile: coloured initial first, replaced by the official logo once Wikidata answers (logos.js). */
const logoBox = (brand, size = "") => `<span class="logo ${size}" data-logo="${esc(brand)}" style="--c:${color(brand)}">${esc(brand.replace(/^the /i, "").charAt(0).toUpperCase())}</span>`;

/** Creator's own link from the description if the brand is mentioned next to a URL, else a neutral shopping search. */
function productLink(b) {
  const lines = (state.data.video.description || "").split("\n");
  // match the brand's first word or its initials ("Louis Vuitton" → "lv") next to a URL
  const words = b.brand.toLowerCase().split(/\s+/);
  const keys = [words[0], words.length > 1 ? words.map((w) => w[0]).join("") : null].filter((k) => k && k.length >= 2);
  for (const line of lines) {
    const url = line.match(/https?:\/\/\S+/)?.[0];
    const low = line.toLowerCase();
    if (url && keys.some((k) => new RegExp(`(^|[^a-z])${k}([^a-z]|$)`).test(low))) {
      const aff = /amzn|amazon|bit\.ly|ref=|tag=|coupon|link\./i.test(url);
      return { url, label: aff ? "Affiliate" : "Creator link", title: "Link from the video description" };
    }
  }
  return { url: `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(`${b.brand} ${b.product || ""}`.trim())}`, label: "Search", title: "Neutral shopping search" };
}

// ---------- Overview ----------
function viewOverview() {
  const d = state.data; const v = d.video;
  const val = videoValue(d, state.opts); const disc = checkDisclosure(d);
  const union = brandTimeShare(d);
  const au = d.authenticity || [];
  const auAvg = au.length ? round5(au.reduce((n, a) => n + a.overall, 0) / au.length) : null;
  const dur = v.duration_s || Math.max(1, ...d.brands.flatMap((b) => b.appearances.map((a) => a.end_s)));
  const valueOf = new Map(val.rows.map((r) => [r.brand.brand, r]));
  const sortBy = state.sortBy || "screen";
  const promoted = new Set(au.map((a) => a.brand.toLowerCase()));
  const firstAt = (b) => b.appearances[0]?.start_s ?? Infinity;
  const rows = d.brands.filter((b) => b.appearances?.length).sort((a, b) => sortBy === "first" ? firstAt(a) - firstAt(b)
    : sortBy === "value" ? (valueOf.get(b.brand)?.euros || 0) - (valueOf.get(a.brand)?.euros || 0)
    : (valueOf.get(b.brand)?.raw.visual || 0) - (valueOf.get(a.brand)?.raw.visual || 0));

  $("#view").innerHTML = `
    <div class="watch">
      <div class="player" id="playerHost"><div class="yt-host"></div></div>
      <aside class="now card" id="now">
        <div class="now-head"><span class="pulse"></span><b>Right now</b><span class="now-time num">0:00</span>${info("Products Gemini saw in the picture at this second. Follows the video while it plays. Links: the creator's own link from the description if there is one (affiliate links are marked), otherwise a neutral shopping search.")}</div>
        <div class="now-list"></div>
      </aside>
    </div>

    <div class="stats">
      <button class="stat" data-goto="timeline"><span class="s-label">Products ${info("Distinct brands Gemini found in the picture, in on-screen text or in speech. Spelling variants are merged.")}</span><b class="num">${d.brands.length}</b><span class="s-sub">${d.brands.filter((b) => b.appearances.some((a) => a.channel === "audio")).length} also mentioned in speech</span></button>
      <button class="stat" data-goto="timeline"><span class="s-label">Brand on screen ${info("Share of the video in which at least one brand is visible. Overlapping appearances are counted once.")}</span><b class="num">${union}%</b><span class="s-sub">of ${fmtDur(v)}</span></button>
      <button class="stat" data-goto="disclosure"><span class="s-label">Ad disclosure ${info("Looks for an advertising label in title, description, on screen and in speech (§ 5a UWG, § 22 MStV). Green = clear label, orange = weak label, red = commercial signals but no label. A screening aid, not legal advice.")}</span><b class="status lvl-${disc.level}"><i class="dot"></i>${esc(disc.title)}</b><span class="s-sub">${esc(disc.sub)}</span></button>
      <button class="stat" data-goto="authenticity"><span class="s-label">Authenticity ${info("How genuine the recommendation feels: six factors rated by Gemini from image and sound (use shown, balance, specificity, delivery, body language, sales pressure). Rounded to 5 because runs vary by about ±6 points.")}</span><b class="num">${auAvg ?? "–"}</b><span class="s-sub">${auAvg != null ? band(auAvg) : "not rated"}</span></button>
      <button class="stat" data-goto="value"><span class="s-label">Media value ${info(`What the same exposure would cost as 30-second video ads: views ÷ 1000 × CPM (€${state.opts.cpm}) × weighted seconds ÷ 30 × share watched (${Math.round(state.opts.viewThrough * 100)}%). Weighted seconds count large, central, in-use appearances more. Adjustable under Media value.`)}</span><b class="num">${euro(val.total)}</b><span class="s-sub">${fmtViews(v.views)} views</span></button>
    </div>

    <section class="sect">
      <div class="sect-head"><h3>All products <span class="count">${rows.length}</span></h3>
        <span class="seg-ctl" id="psort">${[["screen", "Screen time"], ["first", "In order"], ["value", "Value"]].map(([k, l]) => `<button data-s="${k}" class="${sortBy === k ? "on" : ""}">${l}</button>`).join("")}</span></div>
      <div class="pgrid">${rows.map((b) => {
        const r = valueOf.get(b.brand) || { raw: {}, euros: 0 };
        const vis = b.appearances.filter((a) => a.channel === "visual");
        const spoken = b.appearances.filter((a) => a.channel === "audio").length;
        const first = (vis[0] || b.appearances[0])?.start_s ?? 0;
        const jumps = (vis.length ? vis : b.appearances).slice(0, 5);
        return `<article class="pcard" data-brand="${esc(b.brand)}" data-t="${first}" tabindex="0">
          <div class="pc-top">${logoBox(b.brand)}<div class="pc-name"><b>${esc(b.brand)}</b><span>${esc(b.product || b.category || "")}</span></div>
            ${promoted.has(b.brand.toLowerCase()) ? `<span class="tag">promoted</span>` : b.appearances.some((a) => a.in_use) ? `<span class="tag soft">in use</span>` : ""}</div>
          <div class="pc-lane">${b.appearances.map((a) => `<i class="${a.channel}" style="left:${Math.min(100, (100 * a.start_s) / dur)}%;width:${Math.max(0.8, (100 * (a.end_s - a.start_s)) / dur)}%;background:${color(b.brand)};color:${color(b.brand)}"></i>`).join("")}</div>
          <div class="pc-facts"><span><b class="num">${Math.round(r.raw.visual || 0)} s</b> on screen</span><span><b class="num">${spoken}×</b> spoken</span><span><b class="num">${euro(r.euros)}</b> value</span></div>
          <div class="pc-jumps">${jumps.map((a) => `<button class="time" data-jump="${a.start_s}">${mmss(a.start_s)}</button>`).join("")}${b.appearances.length > jumps.length ? `<span class="more">+${b.appearances.length - jumps.length}</span>` : ""}</div>
        </article>`;
      }).join("")}</div>
    </section>`;

  mountPlayer();
  hydrateLogos($("#view"));
  const jump = (t) => { $("#playerHost").classList.add("paused"); state.player?.seek(t); $("#playerHost").scrollIntoView({ behavior: "smooth", block: "center" }); };
  $("#view").querySelectorAll(".pcard").forEach((c) => {
    c.onclick = (e) => { const j = e.target.closest("[data-jump]"); jump(Number(j ? j.dataset.jump : c.dataset.t)); };
    c.onkeydown = (e) => { if (e.key === "Enter") jump(Number(c.dataset.t)); };
  });
  $("#view").querySelectorAll("[data-goto]").forEach((el) => (el.onclick = (e) => { if (!e.target.closest(".info")) go(state.id, el.dataset.goto); }));
  $("#psort").querySelectorAll("button").forEach((b) => (b.onclick = () => { state.sortBy = b.dataset.s; viewOverview(); }));
}

function brandTimeShare(d) {
  const iv = d.brands.flatMap((b) => b.appearances.filter((a) => a.channel === "visual").map((a) => [a.start_s, a.end_s])).sort((a, b) => a[0] - b[0]);
  let total = 0, cur = null;
  for (const [s, e] of iv) { if (!cur || s > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [s, e]; } else cur[1] = Math.max(cur[1], e); }
  if (cur) total += cur[1] - cur[0];
  return Math.min(100, Math.round((100 * total) / (d.video.duration_s || 1)));
}

function countUp() {
  document.querySelectorAll("[data-count]").forEach((el) => {
    const target = Number(el.dataset.count); const fmt = el.dataset.fmt; const t0 = performance.now();
    const show = (x) => (el.textContent = fmt === "euro" ? euro(x) : fmt === "pct" ? `${Math.round(x)}%` : String(Math.round(x)));
    const step = (now) => { const k = Math.min(1, (now - t0) / 900); show(target * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}

const legend = () => `<span class="legend"><span><b></b>visible</span><span><b class="audio"></b>spoken</span><span><b class="text"></b>on-screen text</span></span>`;

// ---------- Timeline component ----------
function timeline(root, { maxRows = Infinity } = {}) {
  const d = state.data; const dur = d.video.duration_s || Math.max(...d.brands.flatMap((b) => b.appearances.map((a) => a.end_s)), 1);
  const rows = d.brands.slice(0, maxRows);
  const pct = (s) => `${Math.min(100, (100 * s) / dur)}%`;
  root.innerHTML = `
    <div class="tl">
      <div class="tl-flags">${d.disclosures.map((x) => `<span class="flag" style="left:${pct(x.time_s)}" data-t="${x.time_s}" data-tip="${esc(`Disclosure (${x.kind}) · ${mmss(x.time_s)}|${x.text}`)}">${icon("flag", "icon")}ad label</span>`).join("")}</div>
      ${rows.map((b) => `<div class="tl-row"><div class="name"><i style="background:${color(b.brand)}"></i>${esc(b.brand)}</div>
        <div class="lane">${b.appearances.map((a) => `<div class="seg ${a.channel}" style="left:${pct(a.start_s)};width:calc(${pct(a.end_s - a.start_s)});color:${color(b.brand)};background:${color(b.brand)}"
          data-t="${a.start_s}" data-tip="${esc(`${b.brand} · ${mmss(a.start_s)}–${mmss(a.end_s)} · ${a.channel}${a.size ? " · " + a.size : ""}${a.in_use ? " · in use" : ""}|${a.evidence}`)}"></div>`).join("")}</div></div>`).join("")}
      ${d.brands.length > rows.length ? `<div class="small muted" style="margin:8px 0 0 162px">+ ${d.brands.length - rows.length} more brands in the full timeline</div>` : ""}
      <div class="axis"><span>0:00</span><span>${mmss(dur / 4)}</span><span>${mmss(dur / 2)}</span><span>${mmss((3 * dur) / 4)}</span><span>${mmss(dur)}</span></div>
      <div class="playhead" style="left:calc(162px + 0%)"></div>
    </div>`;
  const ph = root.querySelector(".playhead"); const lane = root.querySelector(".lane");
  const setTime = (t) => { const w = lane ? lane.getBoundingClientRect().width : 0; ph.style.left = `${162 + (w * Math.min(1, t / dur))}px`; };
  root.querySelectorAll("[data-t]").forEach((el) => {
    el.onclick = () => {
      if (!state.player) return go(state.id, "overview", Number(el.dataset.t));
      $("#playerHost")?.classList.add("paused"); state.player.seek(Number(el.dataset.t));
    };
  });
  tooltips(root);
  setTime(0);
  return { setTime };
}

function tooltips(root) {
  let tip = null;
  root.querySelectorAll("[data-tip]").forEach((el) => {
    el.onmouseenter = (e) => {
      const [head, body] = el.dataset.tip.split("|");
      tip = document.createElement("div"); tip.className = "tip"; tip.innerHTML = `<b>${esc(head)}</b>${esc(body || "")}`;
      document.body.append(tip); move(e);
    };
    el.onmousemove = move;
    el.onmouseleave = () => { tip?.remove(); tip = null; };
  });
  function move(e) { if (tip) { tip.style.left = `${Math.min(e.clientX + 14, innerWidth - 320)}px`; tip.style.top = `${e.clientY + 14}px`; } }
}

// ---------- Timeline view ----------
function viewTimeline() {
  $("#view").innerHTML = `
    <div class="grid-top" style="grid-template-columns:minmax(0,1fr) 300px">
      <div class="player" id="playerHost"><div class="yt-host"></div></div>
      <div class="card"><h3>How to read it</h3>
        <p class="small muted">Every row is one brand. Filled bars: visible in the image. Outlined: mentioned in speech. Dotted: on-screen text. Flags mark advertising labels.</p>
        <p class="small muted">Click a bar to jump there. Pause the video to see <b>which products are in the frame</b> (Pause &amp; Find).</p>
        <p class="small muted">Positions in the frame are approximate – Gemini's boxes are rough for video (see EVALUATION.md, test E).</p></div>
    </div>
    <div class="card" style="margin-top:20px"><h3>${icon("timeline")} ${state.data.brands.length} brands <span class="right">${legend()}</span></h3><div id="tl"></div></div>`;
  const tl = timeline($("#tl"));
  mountPlayer((t) => tl.setTime(t));
}

// ---------- Media value view ----------
function valueRows(rows) {
  const max = Math.max(...rows.map((r) => r.euros), 1);
  return rows.map((r) => `<div class="row" data-brand="${esc(r.brand.brand)}">${mono(r.brand.brand)}
    <div style="min-width:0"><div class="t">${esc(r.brand.brand)}</div><div class="p">${esc(r.brand.product || "")} · score ${r.score}</div></div>
    <div class="barcell"><div class="bar"><i style="width:${(100 * r.euros) / max}%;background:${color(r.brand.brand)}"></i></div></div>
    <div class="eur num">${euro(r.euros)}</div><span class="chev">${icon("chevron")}</span></div>`).join("") || `<div class="empty-state">No brands found.</div>`;
}
function bindRows() { document.querySelectorAll(".row[data-brand]").forEach((r) => (r.onclick = () => brandSheet(r.dataset.brand))); }

function viewValue() {
  const d = state.data;
  const draw = () => {
    const val = videoValue(d, state.opts);
    $("#vtotal").textContent = euro(val.total);
    $("#vlist").innerHTML = valueRows(val.rows); bindRows();
    $("#cpmv").textContent = `€${state.opts.cpm}`; $("#vtv").textContent = `${Math.round(state.opts.viewThrough * 100)}%`;
  };
  $("#view").innerHTML = `
    <div class="cols-2" style="grid-template-columns:1fr 1.3fr;align-items:start">
      <div class="stack">
        <div class="kpi"><div class="label">${icon("value")} Estimated media value · all brands</div><div class="value num" id="vtotal"></div>
          <div class="foot">Equivalent cost of the same exposure as 30-second video ads</div></div>
        <div class="card"><h3>${icon("sliders")} Assumptions</h3>
          <div class="slider"><span>CPM (€ / 1000 views)</span><input type="range" id="cpm" min="5" max="40" step="1" value="${state.opts.cpm}"><b class="num" id="cpmv"></b></div>
          <div class="slider" style="margin-top:12px"><span>View-through</span><input type="range" id="vt" min="10" max="100" step="5" value="${state.opts.viewThrough * 100}"><b class="num" id="vtv"></b></div>
          <div class="formula">value = views / 1000 × CPM × (weighted seconds / 30) × view-through<br>
            weighted seconds = Σ visible × size × position × (in use ? ${WEIGHTS.inUse} : 1) + spoken × ${WEIGHTS.audio} + text × ${WEIGHTS.text}</div>
          <p class="small muted">Weights: size small ${WEIGHTS.size.small} · medium ${WEIGHTS.size.medium} · large ${WEIGHTS.size.large}; position center ${WEIGHTS.position.center} · edge ${WEIGHTS.position.edge}. Assumptions, adjustable – the method follows sponsorship measurement in sports media.</p>
        </div>
      </div>
      <div><div class="nav-label" style="padding-left:4px">Brands · click for the breakdown</div><div class="list" id="vlist"></div></div>
    </div>`;
  $("#cpm").oninput = (e) => { state.opts.cpm = Number(e.target.value); draw(); };
  $("#vt").oninput = (e) => { state.opts.viewThrough = Number(e.target.value) / 100; draw(); };
  draw();
}

function brandSheet(name) {
  const b = state.data.brands.find((x) => x.brand === name); if (!b) return;
  const r = brandValue(b, state.data.video, state.opts); const w = r.weighted; const maxW = Math.max(w.visual, w.audio, w.text, 1);
  const factor = (label, val, raw) => `<div class="factor"><span>${label}</span><div class="bar"><i style="width:${(100 * val) / maxW}%;background:${color(b.brand)}"></i></div><span class="num">${Math.round(raw)} s</span></div>`;
  const scrim = document.createElement("div"); scrim.className = "scrim";
  scrim.innerHTML = `<div class="sheet">
    <div style="display:flex;gap:12px;align-items:center">${mono(b.brand)}<div><h2>${esc(b.brand)}</h2><div class="muted small">${esc(b.product || b.category || "")}</div></div>
      <div style="margin-left:auto;text-align:right"><div class="kpi value num" style="border:0;box-shadow:none;padding:0;min-height:0;font-size:28px">${euro(r.euros)}</div><div class="small muted">visibility score ${r.score}/100</div></div></div>
    <div class="nav-label" style="padding-left:0;margin-top:14px">Exposure</div>
    ${factor(`${icon("eye")} Visible`, w.visual, r.raw.visual || 0)}${factor(`${icon("ear")} Spoken`, w.audio, r.raw.audio || 0)}${factor(`${icon("text")} On-screen text`, w.text, r.raw.text || 0)}
    <div class="nav-label" style="padding-left:0;margin-top:10px">Appearances</div>
    ${b.appearances.slice(0, 12).map((a) => `<div class="finding"><button class="time" data-t="${a.start_s}">${mmss(a.start_s)}</button><span class="small">${esc(a.channel)}${a.size ? " · " + a.size : ""}${a.position ? " · " + a.position : ""}${a.in_use ? " · in use" : ""} — ${esc(a.evidence)}</span></div>`).join("")}
    <div class="formula">${Math.round(state.data.video.views || 0).toLocaleString("en")} / 1000 × €${state.opts.cpm} × (${w.total.toFixed(1)} s / 30) × ${state.opts.viewThrough} = ${euro(r.euros)}</div>
    <div style="text-align:right;margin-top:14px"><button class="btn primary" data-close>Done</button></div></div>`;
  document.body.append(scrim);
  const close = () => scrim.remove();
  scrim.onclick = (e) => { if (e.target === scrim || e.target.closest("[data-close]")) close(); };
  scrim.querySelectorAll("[data-t]").forEach((el) => (el.onclick = () => { close(); go(state.id, "overview", Number(el.dataset.t)); }));
}

// ---------- Disclosure view ----------
function viewDisclosure() {
  const c = checkDisclosure(state.data);
  $("#view").innerHTML = `
    <div class="card lvl-${c.level}" style="padding:26px 28px"><div class="verdict"><div class="light"><i></i></div>
      <div><h2>${esc(c.title)}</h2><p>${esc(c.sub)}</p></div></div></div>
    <div class="cols-2" style="margin-top:20px;align-items:start">
      <div class="card"><h3>${icon("shield")} Where a label was looked for</h3>
        ${c.checklist.map((x) => `<div class="check"><span class="${x.ok ? "ok" : "no"}">${icon(x.ok ? "check" : "minus")}</span><b>${x.label}</b><span class="small muted">${esc(x.detail || (x.ok ? "found" : "not found"))}</span></div>`).join("")}
        ${c.findings.filter((f) => f.time_s != null).map((f) => `<div class="finding"><button class="time" data-t="${f.time_s}">${mmss(f.time_s)}</button><span><b>${esc(f.source)}</b> · ${f.strength === "strong" ? "clear" : "weak"}<br><span class="small muted">"${esc(f.text)}"</span></span></div>`).join("")}
      </div>
      <div class="card"><h3>${icon("sparkle")} Commercial signals</h3>
        ${c.signals.length ? c.signals.map((s) => `<div class="finding">${icon("chevron")}<span>${esc(s)}</span></div>`).join("") : `<p class="muted">None found.</p>`}
        ${c.reasoning ? `<div class="formula" style="font-family:var(--font)">${esc(c.reasoning)}</div>` : ""}
      </div>
    </div>
    <p class="legal">Legal background (Germany): commercial content must be clearly recognisable as advertising – § 5a (4) UWG (Unfair Competition Act), § 22 MStV (Interstate Media Treaty).
      PlacementRadar is a screening aid that points to places worth checking. It is not legal advice and does not judge the creator.</p>`;
  $("#view").querySelectorAll("[data-t]").forEach((el) => (el.onclick = () => go(state.id, "overview", Number(el.dataset.t))));
}

// ---------- Authenticity ----------
const SUBS = [["use_shown", "Use shown"], ["balance", "Balance"], ["specificity", "Specificity"], ["delivery", "Delivery"], ["body_language", "Body language"], ["sales_pressure", "Low sales pressure"]];
const band = (s) => (s >= 75 ? "Feels genuine" : s >= 55 ? "Mixed" : "Reads like an ad");
const round5 = (s) => Math.round(s / 5) * 5; // runs vary by ~12 points (test E) → no false precision

function gauge(score) {
  const s = round5(score); const a = Math.PI * (1 - s / 100); const x = 100 + 80 * Math.cos(a); const y = 100 - 80 * Math.sin(a);
  const col = s >= 75 ? "var(--green)" : s >= 55 ? "var(--orange)" : "var(--red)";
  return `<svg class="gauge" viewBox="0 0 200 120" width="200"><path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="var(--bg-sunken)" stroke-width="14" stroke-linecap="round"/>
    <path d="M20 100 A80 80 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}" fill="none" stroke="${col}" stroke-width="14" stroke-linecap="round"/>
    <text x="100" y="92" text-anchor="middle" font-size="38" font-weight="700" fill="var(--text)">${s}</text>
    <text x="100" y="114" text-anchor="middle" font-size="12" fill="var(--text-2)">${band(s)}</text></svg>`;
}

/** Empty authenticity: either nothing was promoted, or the optional second Gemini call did not succeed. */
const noAuthText = () => state.data.paid?.looks_like_paid_promotion
  ? "Authenticity was not rated in this analysis – Google's model did not answer the second request in time."
  : "No promoted products found in this video, so there is nothing to rate.";

function authSummary() {
  const items = state.data.authenticity || [];
  if (!items.length) return `<div class="card"><p class="muted small" style="margin:0">${esc(noAuthText())}</p></div>`;
  return items.map((a) => `<div class="card" data-auth style="cursor:pointer;display:flex;gap:16px;align-items:center;margin-bottom:12px">
    <div style="width:140px">${gauge(a.overall)}</div><div><b>${esc(a.brand)}</b> <span class="muted small">${esc(a.product)}</span><p class="small muted" style="margin:6px 0 0">${esc(a.verdict)}</p></div></div>`).join("");
}

function viewAuthenticity() {
  const items = state.data.authenticity || [];
  $("#view").innerHTML = (items.length ? items.map((a, i) => `
    <div class="card" style="margin-bottom:20px"><div class="auth-card">
      <div>${gauge(a.overall)}<div style="text-align:center;margin-top:4px"><b>${esc(a.brand)}</b><div class="small muted">${esc(a.product)}</div></div></div>
      <div><p style="margin:0 0 12px">${esc(a.verdict)}</p><div class="subs">
        ${SUBS.map(([k, label]) => { const s = a.sub?.[k] || {}; return `<div class="factor" data-i="${i}"><span>${label}</span><div class="bar"><i style="width:${s.score ?? 0}%"></i></div><span class="num">${s.score ?? "–"}</span></div>
          <div class="evidence">${s.time_s != null ? `<button class="time" data-t="${s.time_s}">${mmss(s.time_s)}</button> ` : ""}${esc(s.evidence)}</div>`; }).join("")}
      </div></div></div></div>`).join("") : `<div class="empty-state">${esc(noAuthText())}</div>`) +
    `<p class="legal">Perceived authenticity – an AI estimate from image and audio, not a judgement of the creator. Body language is a weak signal for honesty
      (people detect deception barely above chance, Bond &amp; DePaulo 2006), so it is one of six factors and the score is rounded to steps of 5. Theory: source credibility (Hovland) and the Persuasion Knowledge Model (Friestad &amp; Wright 1994).</p>`;
  $("#view").querySelectorAll(".factor").forEach((f) => (f.onclick = () => f.classList.toggle("open")));
  $("#view").querySelectorAll("[data-t]").forEach((el) => (el.onclick = (e) => { e.stopPropagation(); go(state.id, "overview", Number(el.dataset.t)); }));
}

// ---------- Brand report (one page for the brand, printable as PDF) + pitch mail ----------
/**
 * Everything a brand manager needs on one A4 page: exposure, value, key moments with YouTube links, the
 * disclosure verdict and – if rated – authenticity. "Save as PDF" uses the browser's print dialog with a
 * print stylesheet (no PDF library, nothing leaves the browser). The pitch mail is a plain template filled
 * with the measured numbers – no AI call, so it costs no quota.
 */
function viewReport() {
  const d = state.data; const v = d.video;
  const val = videoValue(d, state.opts);
  if (!val.rows.length) { $("#view").innerHTML = `<div class="empty-state">No brands found in this video – nothing to report.</div>`; return; }
  if (!val.rows.some((r) => r.brand.brand === state.reportBrand)) state.reportBrand = val.rows[0].brand.brand;
  const rank = val.rows.findIndex((r) => r.brand.brand === state.reportBrand);
  const r = val.rows[rank]; const b = r.brand;
  const disc = checkDisclosure(d);
  const auth = (d.authenticity || []).find((a) => a.brand.toLowerCase() === b.brand.toLowerCase());
  const share = val.total ? Math.round((100 * r.euros) / val.total) : 0;
  const mentions = b.appearances.filter((a) => a.channel === "audio").length;
  const dur = v.duration_s || Math.max(...b.appearances.map((a) => a.end_s), 1);
  const pct = (x) => `${Math.min(100, (100 * x) / dur)}%`;
  const ytAt = (t) => `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}&t=${Math.round(t)}s`;
  const today = new Date().toISOString().slice(0, 10);
  const moments = [...b.appearances].sort((x, y) => (y.channel === "visual") - (x.channel === "visual") || (y.end_s - y.start_s) - (x.end_s - x.start_s)).slice(0, 8).sort((x, y) => x.start_s - y.start_s);

  $("#view").innerHTML = `
    <div class="report-wrap">
      <article class="report" id="report">
        <header class="rp-head"><div class="rp-logo">${LOGO.replace(/id="lg"/, 'id="lg-rp"').replace("url(#lg)", "url(#lg-rp)")}<span>PlacementRadar · Brand report</span></div><span class="small muted">${today}</span></header>
        <div class="rp-brand">${mono(b.brand)}<div><h2>${esc(b.brand)}</h2><div class="muted">${esc(b.product || b.category || "")}</div></div>
          <div class="rp-rank"><b>#${rank + 1}</b> of ${val.rows.length} brands<br><span class="muted small">${share}% of the video's brand value</span></div></div>
        <div class="rp-video"><img alt="" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg">
          <div><b>${esc(v.title)}</b><div class="small muted">${esc(v.channel || "")} · ${fmtViews(v.views)} views · ${fmtDur(v)}${v.upload_date ? ` · uploaded ${esc(fmtDate(v.upload_date))}` : ""}</div>
          <a class="small" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener">youtube.com/watch?v=${esc(v.id)}</a></div></div>
        <div class="rp-kpis">
          <div><span>Media value</span><b class="num">${euro(r.euros)}</b><i>CPM €${state.opts.cpm} · ${Math.round(state.opts.viewThrough * 100)}% view-through</i></div>
          <div><span>Visibility score</span><b class="num">${r.score}<small>/100</small></b><i>${r.inUse ? "shown in use" : "not shown in use"}</i></div>
          <div><span>On screen</span><b class="num">${Math.round(r.raw.visual || 0)} s</b><i>${Math.round(r.raw.text || 0)} s as on-screen text</i></div>
          <div><span>Mentioned</span><b class="num">${mentions}×</b><i>${Math.round(r.raw.audio || 0)} s in speech</i></div>
        </div>
        <h4>Exposure over the video</h4>
        <div class="rp-lane"><div class="lane">${b.appearances.map((a) => `<div class="seg ${a.channel}" style="left:${pct(a.start_s)};width:${pct(a.end_s - a.start_s)};color:${color(b.brand)};background:${color(b.brand)}"></div>`).join("")}</div>
          <div class="axis" style="margin-left:0"><span>0:00</span><span>${mmss(dur / 2)}</span><span>${fmtDur({ ...v, duration_s: dur })}</span></div>
          <div class="small muted" style="margin-top:4px">${legend()}</div></div>
        <h4>Key moments</h4>
        <table class="rp-table"><tbody>${moments.map((a) => `<tr><td><a class="time" href="${ytAt(a.start_s)}" target="_blank" rel="noopener">${mmss(a.start_s)}</a></td>
          <td>${esc({ visual: "on screen", audio: "spoken", text: "on-screen text" }[a.channel] || a.channel)}${a.size ? ` · ${esc(a.size)}` : ""}${a.position ? ` · ${esc(a.position)}` : ""}${a.in_use ? " · in use" : ""}</td>
          <td>${esc(a.evidence)}</td></tr>`).join("")}</tbody></table>
        <div class="rp-two">
          <div class="lvl-${disc.level}"><h4>Ad disclosure (whole video)</h4><span class="pill lvl-${disc.level}"><span class="dot"></span>${esc(disc.title)}</span><p class="small muted">${esc(disc.sub)}</p></div>
          <div><h4>Authenticity</h4>${auth ? `<div class="rp-auth"><b class="num">${round5(auth.overall)}</b><div><b>${esc(band(round5(auth.overall)))}</b><p class="small muted" style="margin:2px 0 0">${esc(auth.verdict)}</p></div></div>`
            : `<p class="small muted">Not rated – ${esc(b.brand)} was not identified as a promoted product in this video.</p>`}</div>
        </div>
        <h4>Method</h4>
        <div class="formula">${Math.round(v.views || 0).toLocaleString("en")} views / 1000 × €${state.opts.cpm} CPM × (${r.weighted.total.toFixed(1)} weighted s / 30) × ${state.opts.viewThrough} = ${euro(r.euros)}</div>
        <p class="legal">Weighted seconds: on screen × size × position (× ${WEIGHTS.inUse} when in use) + spoken × ${WEIGHTS.audio} + on-screen text × ${WEIGHTS.text}. Appearances detected by ${esc([...new Set(d.source?.models || [])].map(modelName).join(" + ") || "Gemini")} from image and audio (analysed ${esc(d.source?.analyzed_at || "")}); times are approximate (±3 s).
          The disclosure check refers to § 5a (4) UWG and § 22 MStV and is a screening aid, not legal advice. All values are estimates.</p>
      </article>
      <aside class="report-side">
        <div class="card"><h3>${icon("bag")} Brand</h3>
          <select id="rbrand" class="select">${val.rows.map((x) => `<option ${x.brand.brand === b.brand ? "selected" : ""}>${esc(x.brand.brand)}</option>`).join("")}</select>
          <button class="btn primary" id="rprint" style="margin-top:12px;width:100%;justify-content:center">${icon("doc")} Save as PDF</button>
          <p class="small muted" style="margin:8px 0 0">Opens the print dialog – choose "Save as PDF". CPM and view-through come from the Media value view.</p></div>
        <div class="card"><h3>${icon("link")} Pitch mail to the creator</h3>
          <textarea id="rmail" class="mail" rows="14" spellcheck="false">${esc(pitchMail(b, r, mentions, disc))}</textarea>
          <button class="btn" id="rcopy" style="margin-top:10px">${icon("check")} <span>Copy text</span></button></div>
      </aside>
    </div>`;
  $("#rbrand").onchange = (e) => { state.reportBrand = e.target.value; viewReport(); };
  $("#rprint").onclick = () => window.print();
  $("#rcopy").onclick = async () => { try { await navigator.clipboard.writeText($("#rmail").value); $("#rcopy span").textContent = "Copied"; } catch { $("#rmail").select(); } };
}

/** Plain template, filled with the measured numbers (no AI call). Wording: the brand writes to the creator. */
function pitchMail(b, r, mentions, disc) {
  const v = state.data.video;
  const seen = Math.round(r.raw.visual || 0);
  const lines = [
    `Subject: Collaboration – ${b.brand} × ${v.channel || "your channel"}`,
    "",
    `Hi ${v.channel || "there"},`,
    "",
    `we came across your video "${v.title}"${v.views ? ` (${fmtViews(v.views)} views)` : ""}.`,
    `${b.brand}${b.product ? ` (${b.product})` : ""} is on screen for about ${seen} seconds${mentions ? ` and you mention it ${mentions === 1 ? "once" : `${mentions} times`}` : ""}${r.inUse ? " – and you actually use it, which is exactly what we like to see" : ""}.`,
    `By our estimate that exposure equals roughly ${euro(r.euros)} in video advertising.`,
    "",
    "We would love to talk about a paid collaboration for an upcoming video. Of course any partnership would be clearly labelled as advertising from the start (§ 5a UWG, § 22 MStV)" +
      (disc.level === "red" || disc.level === "orange" ? " – we provide the wording and are happy to help with the disclosure." : "."),
    "",
    "Would you be open to a short call next week?",
    "",
    "Best regards",
    `${b.brand} – Influencer partnerships`,
  ];
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------------
// "i" button: what PlacementRadar does, in one screen
// ------------------------------------------------------------------------------------------------
function addInfoButton() { /* actions live in the top bar now */ }

/** Right side of every toolbar: usage pill (if enabled in Settings) + settings + about. */
function toolbarActions() {
  const host = $("#tbActions");
  if (!host) return;
  host.innerHTML = `${prefs.usage ? `<button class="usage-pill" id="usagePill" title="AI usage today">${icon("chip")}<span>AI usage</span></button>` : ""}
    <button class="icon-btn" id="tbSettings" title="Settings" aria-label="Settings">${icon("sliders")}</button>
    <button class="icon-btn" id="tbAbout" title="What is PlacementRadar?" aria-label="About PlacementRadar"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".6" fill="currentColor"/></svg></button>`;
  $("#tbSettings").onclick = showSettings; $("#tbAbout").onclick = showInfo;
  if (prefs.usage) { $("#usagePill").onclick = showUsage; refreshUsagePill(); }
}

let usageCache = null;
async function fetchUsage(force = false) {
  if (usageCache && !force && Date.now() - usageCache.at < 30000) return usageCache.data;
  try { const r = await fetch("api/usage"); if (!r.ok) throw 0; usageCache = { at: Date.now(), data: await r.json() }; }
  catch { usageCache = { at: Date.now(), data: { available: false, offline: true } }; }
  return usageCache.data;
}
async function refreshUsagePill() {
  const pill = $("#usagePill"); if (!pill) return;
  const u = await fetchUsage();
  const video = (u.models || []).filter((m) => m.kind === "video");
  const used = video.reduce((n, m) => n + m.requests, 0), cap = video.length * (u.free_requests_per_model || 20);
  const dev = ["barcode", "ocr", "own", "yolo"].reduce((n, k) => n + (session.recognitions[k] || 0), 0);
  pill.querySelector("span").textContent = u.available ? `Gemini ${used}/${cap} today` + (dev ? ` · ${dev} on device` : "") : dev ? `${dev} on device · 0 tokens` : "AI usage";
}

const sheet = (html) => {
  const scrim = document.createElement("div"); scrim.className = "scrim";
  scrim.innerHTML = `<div class="sheet">${html}</div>`;
  document.body.append(scrim);
  scrim.onclick = (e) => { if (e.target === scrim || e.target.closest("[data-close]")) scrim.remove(); };
  return scrim;
};
const fmtTok = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0);

function showSettings() {
  let invite = ""; try { invite = localStorage.getItem("invite") || ""; } catch { /* ignore */ }
  const s = sheet(`
    <h2>Settings</h2>
    <div class="set-group"><div class="set-row"><span>Appearance</span>
      <span class="seg-ctl" id="theme">${["auto", "light", "dark"].map((t) => `<button data-t="${t}" class="${prefs.theme === t ? "on" : ""}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</span></div></div>
    <div class="set-group">
      <label class="set-row"><span>Show AI usage<small>Requests and tokens per model today, what this analysis cost, recognitions on your device.</small></span><input type="checkbox" class="switch" id="pUsage" ${prefs.usage ? "checked" : ""}></label>
      <label class="set-row"><span>Show technical details<small>Model names, analysis date and cache status under the video title.</small></span><input type="checkbox" class="switch" id="pTech" ${prefs.tech ? "checked" : ""}></label>
    </div>
    <div class="set-group"><label class="set-row col"><span>Invite code<small>Only needed if the owner asks for one to start new analyses. Examples and the live scanner always work.</small></span>
      <input class="field" id="pInvite" value="${esc(invite)}" placeholder="optional" autocomplete="off"></label></div>
    <div style="text-align:right;margin-top:16px"><button class="btn primary" data-close>Done</button></div>`);
  s.querySelectorAll("#theme button").forEach((b) => (b.onclick = () => { prefs.theme = b.dataset.t; savePrefs(); applyTheme(); s.querySelectorAll("#theme button").forEach((x) => x.classList.toggle("on", x === b)); }));
  s.querySelector("#pUsage").onchange = (e) => { prefs.usage = e.target.checked; savePrefs(); toolbarActions(); };
  s.querySelector("#pTech").onchange = (e) => { prefs.tech = e.target.checked; savePrefs(); if (state.data) renderResult(); };
  s.querySelector("#pInvite").onchange = (e) => { try { localStorage.setItem("invite", e.target.value.trim()); } catch { /* ignore */ } };
}

async function showUsage() {
  const s = sheet(`<h2>AI usage</h2><div id="uBody"><div class="skeleton" style="height:160px"></div></div><div style="text-align:right;margin-top:16px"><button class="btn primary" data-close>Done</button></div>`);
  const u = await fetchUsage(true);
  const d = state.data;
  const calls = d?.source?.usage || [];
  const rec = session.recognitions; const dev = ["barcode", "ocr", "own", "yolo"].reduce((n, k) => n + (rec[k] || 0), 0); const cloud = (rec.gemini || 0) + (rec["workers-ai"] || 0);
  const hrs = u.reset_in_s ? Math.max(1, Math.round(u.reset_in_s / 3600)) : null;
  const modelRows = (u.models || []).map((m) => {
    const cap = u.free_requests_per_model || 20; const pct = Math.min(100, (100 * m.requests) / cap);
    return `<div class="u-row"><span><b>${esc(modelName(m.model))}</b><small>${m.kind === "video" ? "video analysis" : "camera fallback"}${m.exhausted ? " · used up today" : ""}</small></span>
      <div class="bar"><i style="width:${pct}%;background:${m.exhausted ? "var(--red)" : "var(--accent)"}"></i></div>
      <span class="num">${m.requests}/${cap}<small>${fmtTok(m.prompt + m.output + m.thoughts)} tokens</small></span></div>`;
  }).join("");
  s.querySelector("#uBody").innerHTML = `
    <p class="muted small">Gemini's free tier allows about ${u.free_requests_per_model || 20} requests per day and model family. Cached analyses and everything recognised on your device cost nothing.</p>
    <div class="sect-head"><h3>Today on the server</h3><span class="muted small">${u.available ? `resets in about ${hrs} h` : ""}</span></div>
    ${u.available ? `<div class="card">${modelRows}${u.workers_ai ? `<div class="u-row"><span><b>Cloudflare Workers AI</b><small>free camera fallback</small></span><div class="bar"><i style="width:${Math.min(100, (100 * u.workers_ai.used) / u.workers_ai.cap)}%"></i></div><span class="num">${u.workers_ai.used}/${u.workers_ai.cap}</span></div>` : ""}</div>`
      : `<div class="card muted small">Usage numbers come from the online version (Cloudflare Worker). Locally, only this browser's numbers are shown.</div>`}
    <div class="sect-head"><h3>This video</h3></div>
    <div class="card">${d ? (calls.length ? calls.map((c) => `<div class="u-row"><span><b>${c.call === "timeline" ? "Brands, timeline, disclosure" : "Authenticity"}</b><small>${esc(modelName(c.model))}</small></span><span class="muted small">${fmtTok(c.prompt)} in · ${fmtTok(c.output)} out${c.thoughts ? ` · ${fmtTok(c.thoughts)} thinking` : ""}</span><span class="num">${fmtTok(c.total || c.prompt + c.output + c.thoughts)}</span></div>`).join("")
      : `<p class="muted small" style="margin:0">${state.demos.some((x) => x.id === d.video.id) ? "Prepared example – loaded from the repository, no request now." : "Loaded from the saved analysis – no request now. Token numbers are recorded for analyses made from today on."}</p>`)
      : `<p class="muted small" style="margin:0">Open a video to see what its analysis cost.</p>`}</div>
    <div class="sect-head"><h3>This session on your device</h3></div>
    <div class="card"><div class="u-row"><span><b>Live scanner</b><small>barcode, text, own model</small></span><span class="muted small">${dev} recognised on device · 0 tokens</span><span class="num">${cloud ? `${cloud} cloud` : "0 cloud"}</span></div></div>`;
}

function showInfo() {
  const scrim = document.createElement("div"); scrim.className = "scrim";
  scrim.innerHTML = `<div class="sheet info">
    <div style="display:flex;gap:12px;align-items:center"><div style="width:44px;height:44px">${LOGO}</div><h2 style="margin:0">What PlacementRadar does</h2></div>
    <p>Influencers place products in their videos. Brands want to know what that exposure is worth, and viewers have a right to know when it is advertising.
      PlacementRadar answers both from a single YouTube link – and asks a third question: does the recommendation feel genuine?</p>
    <div class="engines">
      <div><span class="ic" style="background:#0a84ff">${icon("cloud")}</span><div><b>Engine 1 · Gemini in the cloud</b><span>watches the whole video with sound: every brand, when and how it appears, spoken and on-screen ad labels, authenticity cues.</span></div></div>
      <div><span class="ic" style="background:#30d158">${icon("chip")}</span><div><b>Engine 2 · AI on your device</b><span>live scanner: YOLO26 finds objects in the camera image, barcodes give the exact product via Open Food Facts – no cloud needed.</span></div></div>
      <div><span class="ic" style="background:#5e5ce6">${icon("sparkle")}</span><div><b>Engine 3 · our own model</b><span>a brand classifier trained on open product photos that learns from Gemini's answers – the app needs the cloud less the more it is used.</span></div></div>
    </div>
    <p class="small">Media value = views ÷ 1000 × CPM × weighted seconds ÷ 30 × view-through. The disclosure check refers to § 5a (4) UWG and § 22 MStV; it is a screening aid, not legal advice.
      Details, formulas and all test results: README, MODELS and EVALUATION in the project repository.</p>
    <p class="small muted">Final project · MMI5190E The New Frontiers of AI · Prof. Pin Luarn · Pforzheim University · Moritz Binder</p>
    <div style="text-align:right;margin-top:8px"><button class="btn primary" data-close>Got it</button></div></div>`;
  document.body.append(scrim);
  scrim.onclick = (e) => { if (e.target === scrim || e.target.closest("[data-close]")) scrim.remove(); };
}

boot();
