/**
 * app.js — PlacementRadar front end (no framework, plain ES modules).
 *
 * Routes (hash based, so the app also works as plain static files):
 *   #/                       start screen: paste a YouTube link or pick a demo
 *   #/v/<id>/<view>[?t=12]   result for one video; view = overview | timeline | value | disclosure | authenticity | report
 *   #/live                   live scanner (camera or photo, mostly on-device; see live.js)
 *   #/agent[?brand=Sonos]    brand agent: search + cached analyses + up to 3 new ones after an OK → one report (agentview.js)
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
import { videoValue, brandValue, euro, euroRange, scenarioParams, retention, WEIGHTS, DEFAULTS, SCENARIOS, VALUE_WHAT } from "./value.js";
import { checkDisclosure } from "./disclosure.js";
import { mmss } from "./shared/normalize.js";
import { CATS, CAT_LABEL } from "./shared/comments.js";
import { renderLive, stopLive } from "./live.js";
import { hydrateLogos } from "./logos.js";
import { createTracking } from "./tracking.js";
import { createVerifier } from "./verify.js";
import { maybeShowIntro, showIntro } from "./intro.js";
import { renderAgent, stopAgent } from "./agentview.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtViews = (n) => n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
/** Video length; "≈" when YouTube withheld it and the Worker estimated it from the last brand appearance. */
const fmtDur = (v) => (v?.duration_estimated ? "≈ " : "") + mmss(v?.duration_s || 0);
/**
 * Screen time as a range (since 23 Nov, EVALUATION.md test M4): two Gemini runs of the same video agree on only about
 * half of the brand-seconds (Jaccard 0.55 over 33 pairs) and the visual product time of one video differed by up to a
 * factor of 2 between runs (MKBHD 141–285 s). One run's seconds are therefore shown as ±50 %, like the media value.
 */
const SCREEN_SPREAD = 0.5;
const SCREEN_INFO = "Shown as a range of ±50 %: two analyses of the same video agree on only about half of the seconds a brand is on screen (test M4 in EVALUATION.md).";
const secRange = (s) => `${Math.round(s * (1 - SCREEN_SPREAD))}–${Math.round(s * (1 + SCREEN_SPREAD))} s`;
const pctRange = (p) => `${Math.round(p * (1 - SCREEN_SPREAD))}–${Math.min(100, Math.round(p * (1 + SCREEN_SPREAD)))}%`;
/** "20261117" (yt-dlp style) or "2026-11-17" → "2026-11-17". */
const fmtDate = (d) => String(d || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
/** Small (i) with an explanation on hover/focus – used next to every number. */
const info = (text) => `<span class="info" tabindex="0" role="note" aria-label="${esc(text)}" data-info="${esc(text)}">i</span>`;
const PALETTE = ["#0a84ff", "#ff9f0a", "#30d158", "#bf5af2", "#ff375f", "#64d2ff", "#ffd60a", "#ac8e68", "#5e5ce6", "#66d4cf"];

const state = { demos: [], recent: [], data: null, id: null, view: "overview", player: null, colors: new Map(), opts: { ...DEFAULTS }, pendingSeek: null };
if (/[?&]vtest\b/.test(location.search)) window.__pr = state; // test hook for tests/test_v_verify.mjs (reads the verifier and player)

// ------------------------------------------------------------------------------------------------
// Preferences (Settings sheet) – stored per browser; storage may be blocked, so every access is guarded
// ------------------------------------------------------------------------------------------------
const PREFS_KEY = "pr:prefs";
const prefs = { theme: "auto", usage: false, tech: false, tracking: true };
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
  { id: "value", label: "Media value", icon: "value" },
  { id: "disclosure", label: "Ad disclosure", icon: "shield" },
  { id: "authenticity", label: "Authenticity", icon: "heart" },
  { id: "audience", label: "Audience", icon: "chat" },
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
  maybeShowIntro();
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
  stopLive(); stopAgent();
  // an open sheet (Verify on screen, Settings, …) belongs to the page it was opened on – close it on navigation
  // (night check 24 Nov: the Verify sheet stayed on top of the brand agent after the browser's back button)
  document.querySelectorAll(".scrim").forEach((s) => s.remove());
  if (parts[0] === "agent") {
    state.id = null; state.data = null; state.page = "agent"; state.renderedId = null;
    renderSidebar(); destroyPlayer();
    renderAgent($("#main"), { brand: new URLSearchParams(location.hash.split("?")[1] || "").get("brand") || "" }); return;
  }
  if (parts[0] === "live") {
    state.id = null; state.data = null; state.page = "live";
    state.renderedId = null; renderSidebar(); destroyPlayer(); await renderLive($("#main")); addInfoButton(); return;
  }
  state.page = parts[0] === "v" ? "video" : "start";
  if (parts[0] === "v" && parts[1]) {
    const id = parts[1];
    state.view = VIEWS.some((v) => v.id === parts[2]) ? parts[2] : "overview";
    if (parts[2] === "timeline") state.scrollTo = "tlSect"; // old links: the timeline now lives on the Products page
    if (state.id !== id || !state.data) {
      const data = await loadAnalysis(id);
      if (!data) return renderAnalyze(id);
      state.id = id; state.data = data; assignColors(data);
      try { for (const r of JSON.parse(sessionStorage.getItem(`closer:${id}`) || "[]")) mergeCloser(r); } catch { /* ignore */ }
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
    state.recentAll = ((await r.json()).items || []).filter((x) => x.id && !demoIds.has(x.id));
    state.recent = state.recentAll.slice(0, 12);
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
  $("#topbar").innerHTML = `
    <button class="tb-brand" data-home aria-label="PlacementRadar – start">${LOGO}<span>PlacementRadar</span></button>
    <span id="tbActions" class="tb-actions"></span>`;
  $("#topbar [data-home]").onclick = () => { location.hash = "#/"; };
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
  state.renderedId = null;
  $("#main").innerHTML = `
    <section class="stage-band start-stage">
      ${thumbWall()}<div class="rings" aria-hidden="true"></div><div class="sweep" aria-hidden="true"></div>
      <div class="hero">
        <div class="app-icon">${LOGO}</div>
        <h1>Every brand in a video.</h1>
        <p class="lead">Paste a YouTube link, or hold a product up to your camera. PlacementRadar shows which brands appear, what that exposure is worth and whether it is labelled as advertising.</p>
        <div class="mode-pick" role="tablist" aria-label="What to analyse">
          <button role="tab" data-mode="video" class="${startMode === "video" ? "on" : ""}">${icon("play")}<span>YouTube video</span></button>
          <button role="tab" data-mode="camera" class="${startMode === "camera" ? "on" : ""}">${icon("camera")}<span>Live camera</span></button>
        </div>
        <div class="mode-panes" data-mode="${startMode}">
          <div class="mode-pane pane-video">
            <form class="spotlight" id="go">${icon("search")}<input id="url" placeholder="Paste a YouTube link" autocomplete="off" spellcheck="false" aria-label="YouTube link"><button>Analyse</button></form>
            <div class="hint" id="hint"></div>
            <ol class="steps"><li><b>1</b>Paste a link</li><li><b>2</b>Gemini watches image and sound</li><li><b>3</b>Brands, value, disclosure</li></ol>
          </div>
          <div class="mode-pane pane-camera">
            <div class="spotlight cam-pill">${icon("camera")}<span class="cp-text">Recognised on your device, no cloud needed</span><a class="cp-btn" href="#/live?start=1">Start camera</a></div>
            <div class="hint"><a href="#/live">or analyse a photo</a></div>
            <ol class="steps"><li><b>1</b>Allow the camera</li><li><b>2</b>Hold up a product</li><li><b>3</b>Brand, barcode, product</li></ol>
          </div>
        </div>
      </div>
    </section>
    <section class="start-body">
      <div class="shelf"><div class="shelf-head"><h2>Examples</h2><span>Open instantly, no waiting.</span></div>
        <div class="shelf-row">${state.demos.map((d) => card(d, true)).join("")}</div></div>
      ${state.recent.length ? `<div class="shelf"><div class="shelf-head"><h2>Analysed by visitors</h2><span>Saved for everyone.</span></div>
        <div class="shelf-row small">${state.recent.map((d) => card(d, false)).join("")}</div></div>` : ""}
      <a class="tool-card agent-card" href="#/agent">
        <div><h3>Brand agent</h3><p>Type a brand. The agent searches YouTube, reuses what is already analysed, asks before it spends quota and writes one report across all videos.</p><span class="btn primary">${icon("search")} Open the agent</span></div>
        <div class="tc-art" aria-hidden="true"><span class="tc-ic">${icon("radar")}</span><span class="tc-label">5 videos · 2 not labelled</span></div>
      </a>
      <a class="tool-card" href="#/live">
        <div><h3>Live scanner</h3><p>Hold a product up to your camera. It is recognised right on your device, no cloud needed.</p><span class="btn primary">${icon("camera")} Open the scanner</span></div>
        <div class="tc-art" aria-hidden="true"><span class="tc-ic">${icon("bag")}</span><span class="tc-label">Brand found</span></div>
      </a>
    </section>`;
  $("#main").querySelectorAll(".mode-pick [data-mode]").forEach((b) => (b.onclick = () => {
    startMode = b.dataset.mode;
    $("#main").querySelectorAll(".mode-pick [data-mode]").forEach((x) => x.classList.toggle("on", x === b));
    $(".mode-panes").dataset.mode = startMode;
    if (startMode === "video") $("#url").focus({ preventScroll: true });
  }));
  $("#main").querySelectorAll("[data-open]").forEach((el) => (el.onclick = () => go(el.dataset.open)));
  $("#go").onsubmit = (e) => {
    e.preventDefault();
    const id = parseYouTubeId($("#url").value);
    if (!id) { $("#hint").textContent = "That does not look like a YouTube link."; return; }
    go(id);
  };
  if (startMode === "video" && matchMedia("(min-width: 761px)").matches) $("#url").focus({ preventScroll: true });
}
let startMode = "video";

/**
 * Background of the start page: a slowly drifting wall of video stills. A fixed, deliberately mixed set of
 * public product videos (cars, tech, sport, gaming, food – plus our own non-beauty analyses), so the first
 * impression is not dominated by one genre. Every video contributes its thumbnail plus three frames YouTube
 * extracts from it (mq1–mq3 ≈ 25/50/75 % of the video), shuffled so the same video never sits next to itself.
 * Purely decorative – only the images are loaded, the videos are not analysed.
 */
const WALL_VIDEOS = [
  "zkp3umO8ej0", "pgvEnDkNUfg", "q31RfZOIrXk", "pPFK72soYDs", "wtDyhM_18Yo",   // cars: Tesla Model Y ×2, Suzuki Vitara, LEGO BMW M4, BMW X5 vs XC90
  "M2Twmj-AvOg", "cn5DsF9FXls", "FoIn0f9rdVc", "mMeGu-DZAJc", "-pTGc7cIBIA", "2CqNFIn1AEo", // tech: iPhone, smartwatch, drone, camera gear, everyday tech, headphones
  "kmZCzZBXAHA", "47uH3NU-c84", "YAEVnzbyq40", "xRZSftRtB-s",                  // sport: running shoes, e-bike, fitness grocery hauls ×2
  "jlnAtwHXRCI", "8PsiVBYF1BM",                                                 // gaming setups
  "mAYbmcqPphc", "sdEfiPvUL2U", "2fAruP6qKd4",                                  // coffee, own-brand vs brand food test, pillow test
];
function thumbWall() {
  const ids = WALL_VIDEOS;
  if (!ids.length) return "";
  const pics = ids.flatMap((id) => ["mqdefault", "mq1", "mq2", "mq3"].map((f) => ({ id, src: `https://i.ytimg.com/vi/${encodeURIComponent(id)}/${f}.jpg` })));
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const COLS = 6, ROWS = 7; const grid = Array.from({ length: COLS }, () => []);
  let bag = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (!bag.length) bag = shuffle([...pics]);
    // avoid the same video directly above or to the left (if the bag still offers something else)
    const clash = (p) => p.id === grid[c][r - 1]?.id || p.id === grid[c - 1]?.[r]?.id;
    const k = bag.findIndex((p) => !clash(p));
    grid[c].push(bag.splice(k < 0 ? 0 : k, 1)[0]);
  }
  return `<div class="wall" aria-hidden="true">${grid.map((col) => `<div class="wall-col">${col.map((p) => `<img alt="" decoding="async" src="${p.src}">`).join("")}</div>`).join("")}</div>`;
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
  { id: "recheck", label: "Re-checking where each product appears" }, // call 1a (since 22 Nov): products lying on the desk
  { id: "authenticity", label: "Rating how genuine the recommendations feel" },
  { id: "done", label: "Calculating media value and disclosure check" },
];
const modelName = (m) => String(m || "").replace(/^gemini-/, "Gemini ").replace(/-flash-lite/, " Flash-Lite").replace(/-flash/, " Flash").replace(/-preview/, " (preview)").replace(/-pro/, " Pro");
const HTTP_WHY = { bad_answer: "gave an unreadable answer", 429: "busy", 500: "had an internal error", 503: "overloaded", 504: "timed out", 524: "timed out" };

/**
 * Waiting screen for a new analysis. Gemini needs 1.5–5 minutes (longer if Google is busy), so the screen shows
 * everything that is already known instead of a bare spinner:
 *   - video details as soon as the Worker sends them (event "meta"),
 *   - a first disclosure check on title + description (pure text, no AI needed),
 *   - which model is watching and when Google is busy and the next model takes over (events "model", "retry"),
 *   - that the page may be closed: the Worker finishes and stores the result; reopening the link loads it.
 */
async function renderAnalyze(id) {
  destroyPlayer(); renderSidebar(); state.renderedId = null;
  const t0 = Date.now();
  const link = `${location.origin}${location.pathname}#/v/${id}/overview`;
  $("#main").innerHTML = `
    <section class="stage-band v-hero wait-stage">
      <div class="v-hero-bg" style="background-image:url('https://i.ytimg.com/vi/${id}/hqdefault.jpg')"></div>
      <div class="wait-head"><h1>New analysis</h1><span class="badge"><span class="dot live-dot"></span>Gemini is watching</span></div>
      <div class="grid-top">
        <div class="player waiting"><img class="poster" alt="" src="https://i.ytimg.com/vi/${id}/hqdefault.jpg"><div class="scanline"></div>
          <div class="wait-cap"><div class="t" id="wtitle">Loading video details …</div><div class="m" id="wmeta"></div></div></div>
        <div class="card wait-card"><h3><span id="wstate">Analysing</span><span class="right num" id="elapsed">0:00</span></h3>
          <div class="progress">${STAGES.map((s) => `<div class="step" data-stage="${s.id}"><span class="icon"></span>${s.label}</div>`).join("")}</div>
          <div class="wait-status" id="wstatus">Connecting to the server …</div>
          <div class="wait-log" id="wlog"></div>
        </div>
      </div>
    </section>
    <div class="content">
      <div class="cols-2" style="align-items:start">
        <div class="card"><h3>Checked while you wait <span class="right">text only, no AI</span></h3><div id="wpre"><div class="skeleton" style="height:84px"></div></div></div>
        <div class="card"><h3>What happens now</h3>
          <p class="muted" style="margin-top:0">Gemini watches the whole video including the audio. That usually takes <b>2–5 minutes</b>, longer when Google's free tier is busy.</p>
          <p class="muted"><b>You can close this page.</b> The analysis keeps running on the server and is saved permanently. Open the same link later and it loads instantly, for everyone.</p>
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
    const msg = { meta: "Reading title, views and description …", timeline: "Gemini is watching the video …", recheck: "Gemini is looking for every product again, also where it only lies in the picture …", authenticity: "Gemini is rating the recommendations …", done: "Putting the dashboard together …" }[sid];
    if (msg) status(msg);
  };
  const fail = (msg) => {
    clearInterval(tick);
    const card = $(".wait-card"); if (!card) return;
    card.innerHTML = `<h3>Analysis not possible right now</h3><p style="margin:0 0 14px;color:rgba(255,255,255,.72)">${esc(msg)}</p>
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
      const why = j.message || { own_key_required: "New analyses are switched off right now. The examples and the live scanner still work.", invite_required: "New analyses need an invite link. The examples work without one.",
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
        if (ev === "note") log(esc(data.text)); // e.g. "re-check skipped" – information, not an error
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
  if (state.renderedId === state.id && $("#view") && $("#main .v-hero")) { // same video, other tab
    $("#main").querySelectorAll(".tabs [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
    destroyPlayer();
    return ({ overview: viewOverview, value: viewValue, disclosure: viewDisclosure, authenticity: viewAuthenticity, audience: viewAudience, report: viewReport })[state.view]();
  }
  state.renderedId = state.id;
  const engine = [...new Set(d.source?.models || [])].map(modelName).join(" + ") || "Gemini";
  const meta = [v.channel, v.views != null ? `${fmtViews(v.views)} views` : null, v.duration_s ? fmtDur(v) : null, v.upload_date ? fmtDate(v.upload_date) : null].filter(Boolean);
  const thumb = `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/hqdefault.jpg`;
  $("#main").innerHTML = `
    <header class="v-hero">
      <div class="v-hero-bg" style="background-image:url('${thumb}')"></div>
      <div class="v-hero-in">
        <img class="v-thumb" alt="" src="${thumb}">
        <div class="v-text">
          <h1>${esc(v.title)}</h1>
          <div class="meta">${esc(meta.join(" · "))}${prefs.tech ? `<span class="tech"> · ${esc(engine)} · analysed ${esc(d.source?.analyzed_at || "")}</span>` : ""}</div>
        </div>
        <a class="btn glass" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener">${icon("play")} Open on YouTube</a>
      </div>
      <nav class="tabs" aria-label="Views">${VIEWS.map((x) => `<button class="${state.view === x.id ? "on" : ""}" data-view="${x.id}">${x.label}</button>`).join("")}</nav>
    </header>
    <div class="content" id="view"></div>`;
  $("#main").querySelectorAll(".tabs [data-view]").forEach((b) => (b.onclick = () => go(state.id, b.dataset.view)));
  ({ overview: viewOverview, value: viewValue, disclosure: viewDisclosure, authenticity: viewAuthenticity, audience: viewAudience, report: viewReport })[state.view]();
}

function destroyPlayer() { state.player?.destroy(); state.player = null; state.tracker?.destroy(); state.tracker = null; state.verifier?.destroy(); state.verifier = null; }

/**
 * Mounts the YouTube player into #playerHost. Products at the current second are listed OUTSIDE the video
 * (#now panel, if the view has one) – nothing covers the picture. Soft markers show roughly where they are
 * while the video is paused (positions from Gemini are approximate, see EVALUATION.md test E).
 */
function mountPlayer(onTime) {
  destroyPlayer();
  const host = $("#playerHost");
  const tracker = createTracking(host, state.data, color);
  const p = new Player(host.querySelector(".yt-host"), state.id, {
    onState: (paused) => { host.classList.toggle("paused", paused && (p.hasPlayed || p.t > 0.5)); tracker.sync(p.t, !paused); updateNow(p.t); },
    onTime: (t) => { onTime?.(t); tracker.sync(t, !p.paused); updateNow(t); suggestCloser(tracker, t); },
  });
  state.player = p; state.tracker = tracker;
  // "Verify on screen" (verify.js): own models check Gemini on the real frames once the user shares this tab
  const verifier = createVerifier({
    id: state.id, data: state.data, iframe: () => host.querySelector("iframe"),
    time: () => { const x = p.yt?.getCurrentTime?.(); return typeof x === "number" ? x : p.t; },
    playing: () => !p.paused, onChange: onVerify,
  });
  state.verifier = verifier;
  tracker.setMeasured((t) => verifier.measuredAt(t), (brand, t) => verifier.statusOf(brand, t));
  bindTrackSwitch(tracker);
  tracker.sync(state.pendingSeek ?? 0, false);
  updateNow(state.pendingSeek ?? 0);
  if (state.pendingSeek != null) { const t = state.pendingSeek; setTimeout(() => p.seek(t), 900); state.pendingSeek = null; }
  return p;

  /** After every checked frame: Right now, product cards, boxes, status line (at most ~5× per second). */
  function onVerify(v) {
    tracker.setHidden(v.running && v.mode !== "element"); // Region Capture / whole tab would see our own boxes
    host.classList.toggle("verify-raw", v.running && v.mode !== "element");
    if (state.vTimer) return;
    state.vTimer = setTimeout(() => {
      state.vTimer = 0; if (state.verifier !== v) return;
      updateNow(p.t); tracker.refresh(); renderVerifyStatus(v); state.refreshVerifyCards?.();
    }, 200);
  }

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
    // "In the background": brands seen at this second only in re-check spans without a checked position (`no_box`) –
    // Gemini says they are in the picture, but we draw no box and list them apart (normalize.js filterRecheckSpans)
    const covering = (b) => b.appearances.filter((a) => a.channel === "visual" && t >= a.start_s - 1 && t <= a.end_s + 1);
    const back = hits.filter((b) => covering(b).every((a) => a.no_box));
    const seen = hits.filter((b) => !back.includes(b));
    // after Verify on screen: confirmed first, "not seen" last
    const vOrder = { confirmed: 0, checking: 1, not_checkable: 1, unchecked: 1, not_seen: 2 };
    if (state.verifier?.hasResults) seen.sort((x, y) => (vOrder[state.verifier.statusOf(x.brand, t)] ?? 1) - (vOrder[state.verifier.statusOf(y.brand, t)] ?? 1));
    const said = mentionedAt(t).filter((b) => !hits.includes(b));
    const unid = (state.data.unidentified || []).filter((u) => u.appearances.some((a) => t >= a.start_s - 1 && t <= a.end_s + 1));
    const onlyScreen = state.verifier?.unclaimedAt() || [];
    const item = (b, how) => {
      // since 22 Nov each appearance knows its product → name the model(s) that are in the picture at this second
      const seenNow = how === "seen" ? [...new Set(b.appearances.filter((a) => a.channel === "visual" && a.product && t >= a.start_s - 1 && t <= a.end_s + 1).map((a) => a.product))] : [];
      const link = productLink(b, seenNow[0] || "");
      const vs = how === "seen" ? verifyPill(state.verifier?.statusAt(b.brand, t)) : "";
      return `<div class="now-item ${how}" data-b="${esc(b.brand)}">${logoBox(b.brand, "sm")}<div class="ni-text"><b>${esc(b.brand)}</b><span>${esc(seenNow.join(" · ") || b.product || b.category || "")}</span>${vs}</div>
        <a href="${esc(link.url)}" target="_blank" rel="noopener" title="${esc(link.title)}">${link.label}</a></div>`;
    };
    now.querySelector(".now-time").textContent = mmss(t);
    now.querySelector(".now-list").innerHTML =
      (seen.length ? `<div class="now-sub">${icon("eye")} In the picture</div>${seen.map((b) => item(b, "seen")).join("")}` : "") +
      (back.length ? `<div class="now-sub">${icon("overview")} In the background <span class="muted">· position not checked</span></div>${back.map((b) => item(b, "seen")).join("")}` : "") +
      (said.length ? `<div class="now-sub">${icon("ear")} Mentioned or written</div>${said.map((b) => item(b, "said")).join("")}` : "") +
      (onlyScreen.length ? `<div class="now-sub">${icon("search")} On screen only <span class="muted">· not in the analysis here</span></div>${onlyScreen.map((u) => `<div class="now-item said vonly"><span class="logo sm" style="--c:#8e8e93">${icon("eye")}</span><div class="ni-text"><b>${esc(cap(u.label))}</b><span>could be ${esc(u.brands.map((x) => labelOf(x.brand, x.product)).join(" or "))} · listed at ${u.brands[0].at.slice(0, 3).map(mmss).join(", ")}</span></div></div>`).join("")}` : "") +
      (unid.length ? `<div class="now-sub">${icon("bag")} Unidentified</div>${unid.map((u) => `<div class="now-item said unid"><span class="logo sm" style="--c:#8e8e93">${icon("bag")}</span><div class="ni-text"><b>${esc(cap(u.category))}</b><span>${esc(u.guess ? `possible: ${u.guess}` : u.description || "brand unknown")}</span></div></div>`).join("")}` : "") +
      (!hits.length && !said.length && !unid.length && !onlyScreen.length ? `<div class="now-empty">No product at this second.<br><span>Press play, or pick a product below to jump to it.</span></div>` : "");
    hydrateLogos(now);
    $("#view").querySelectorAll(".pcard").forEach((c) => {
      c.classList.toggle("live", hits.some((b) => b.brand === c.dataset.brand));
      c.classList.toggle("said", said.some((b) => b.brand === c.dataset.brand));
    });
  }
}

/** "Show tracking" switch under the player: boxes on/off, remembered per browser; hint says how much is located. */
function bindTrackSwitch(tracker) {
  const sw = $("#trackSw"); if (!sw) return;
  const cov = tracker.coverage();
  sw.checked = prefs.tracking; tracker.setEnabled(prefs.tracking);
  sw.onchange = () => { prefs.tracking = sw.checked; savePrefs(); tracker.setEnabled(sw.checked); };
  const hint = $("#trackHint");
  if (hint) hint.dataset.base = hint.textContent = !cov.withBox ? "No positions in this analysis – boxes appear for videos analysed from 21 Nov on."
    : cov.keys > cov.withBox * 1.5 ? `${cov.keys} positions from Gemini · approximate`  // solid / dashed / dot is explained in the (i) next to it
    // one position per appearance: either an analysis from before the keyframe prompt, or Gemini gave only one keyframe
    // (seen 21 Nov on a 13-min desk tour: 23 keyframes for 21 appearances) – so no "(older analysis)" claim here
    : `${cov.withBox} of ${cov.all} appearances located, about one position each – mostly shown as dots. Look closer adds more.`;
}

/**
 * While tracking is on and the products at this second are only roughly located (dashed box or dot), the hint
 * suggests "Look closer" (2 frames per second → tighter boxes). Not shown where a Look closer result exists already.
 */
function suggestCloser(tracker, t) {
  const hint = $("#trackHint"), btn = $("#closerBtn"); if (!hint || !btn) return;
  const level = prefs.tracking ? tracker.levelAt(t) : "none";
  const done = (state.closerDone || []).some((c) => c.id === state.id && t >= c.start && t <= c.end);
  const rough = (level === "approx" || level === "point") && !done;
  if (rough === btn.classList.contains("suggest")) return;
  btn.classList.toggle("suggest", rough);
  hint.textContent = rough ? "Positions are rough here – Look closer checks 2 frames per second for tighter boxes." : hint.dataset.base || "";
}

/** Brands spoken about or shown as text around second t (±1.5 s – speech timestamps are less exact than image ones). */
const mentionedAt = (t) => state.data.brands.filter((b) => b.appearances.some((a) => a.channel !== "visual" && t >= a.start_s - 1.5 && t <= a.end_s + 1.5));
const productsAt = (t) => state.data.brands.filter((b) => b.appearances.some((a) => a.channel === "visual" && t >= a.start_s - 1 && t <= a.end_s + 1));
/** Logo tile: coloured initial first, replaced by the official logo once Wikidata answers (logos.js). */
const logoBox = (brand, size = "") => `<span class="logo ${size}" data-logo="${esc(brand)}" style="--c:${color(brand)}">${esc(brand.replace(/^the /i, "").charAt(0).toUpperCase())}</span>`;

/**
 * Link for a product card / Right now:
 *   1. the link Gemini matched to this product in the description (since 21 Nov; only kept if the exact URL is in
 *      the description, normalize.js cleanLink) – for a brand with several models the one for `model`,
 *   2. else a line of the description that names the brand next to a URL,
 *   3. else a neutral shopping search.
 * Affiliate links (amzn.to, tag=, geni.us …) are always marked as such.
 */
const AFFILIATE_URL = /amzn\.to|amazon\.[a-z.]+\/[^\s]*(tag=|\/shop\/)|link\.amazon|geni\.us|howl\.me|shopmy\.us|go\.magik\.ly|rstyle\.me|ltk\.app|liketk\.it|awin1\.com|tidd\.ly|ebay\.us|[?&](ref|tag|aff|affiliate)=|coupon/i;
// "*Affiliate links …" / "¹) … Affiliate Links" in the description: lines marked with * or ¹ are affiliate links too
const AFFILIATE_NOTE = /affiliate|commission|provision|amazon associate|partnerlink|werbelink/i;
const linkInfo = (url) => {
  const desc = state.data?.video?.description || "";
  const line = desc.split("\n").find((l) => l.includes(url)) || "";
  const aff = AFFILIATE_URL.test(url) || (AFFILIATE_NOTE.test(desc) && /[*¹]/.test(line));
  return { url, label: aff ? "Affiliate" : "Creator link", title: aff ? "Affiliate link from the video description – the creator may earn a commission" : "Link from the video description" };
};
function productLink(b, model = "") {
  if (b.links?.length) {
    const m = model.toLowerCase();
    const hit = (m && b.links.find((l) => l.product && (l.product.toLowerCase() === m || m.includes(l.product.toLowerCase())))) || b.links[0];
    return linkInfo(hit.url);
  }
  const lines = (state.data.video.description || "").split("\n");
  // match the brand's first word or its initials ("Louis Vuitton" → "lv") next to a URL
  const words = b.brand.toLowerCase().split(/\s+/);
  const keys = [words[0], words.length > 1 ? words.map((w) => w[0]).join("") : null].filter((k) => k && k.length >= 2);
  for (const line of lines) {
    const url = line.match(/https?:\/\/\S+/)?.[0];
    const low = line.toLowerCase();
    if (url && keys.some((k) => new RegExp(`(^|[^a-z])${k}([^a-z]|$)`).test(low))) return linkInfo(url.replace(/[).,;:!?'"\]>]+$/, ""));
  }
  return { url: `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(`${b.brand} ${b.product || ""}`.trim())}`, label: "Search", title: "Neutral shopping search" };
}

/** Link row of a product card: one link per model from the description (max. 3), else the fallback link. */
function cardLinks(b) {
  const links = b.links?.length ? b.links.slice(0, 3).map((l) => ({ ...linkInfo(l.url), model: l.product })) : [{ ...productLink(b), model: "" }];
  const short = (m) => (m.toLowerCase().startsWith(b.brand.toLowerCase()) ? m.slice(b.brand.length).trim() : m) || m;
  const text = (l) => (l.model ? short(l.model) : l.label === "Search" ? "Shopping search" : b.products?.[0] ? short(b.products[0]) : hostOf(l.url));
  return `<div class="pc-links">${links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener${l.label === "Affiliate" ? " sponsored" : ""}" title="${esc(l.title)}"><span class="pl-kind ${l.label === "Affiliate" ? "aff" : l.label === "Search" ? "search" : ""}">${esc(l.label)}</span>${esc(text(l))}</a>`).join("")}${b.links?.length ? `<span class="more" title="Gemini matched this product to a link in the video description">from description</span>` : ""}</div>`;
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

// ---------- Overview ----------
/**
 * Products page: player + "Right now" (mounted once per visit of this tab), then stats, brand timeline, all
 * products and unidentified products. The part below the player is drawn by drawBody(), so a "Look closer"
 * result can be merged in without reloading the player.
 */
function viewOverview() {
  $("#view").innerHTML = `
    <div class="watch">
      <div class="watch-main">
        <div class="player" id="playerHost"><div class="yt-host"></div></div>
        <div class="player-bar">
          <label class="track-toggle"><input type="checkbox" class="switch sm" id="trackSw"><span>Show tracking</span></label>
          <span class="small muted" id="trackHint"></span>
          ${info("Boxes and names over the video show where Gemini saw each product: model and how it was recognised (logo, text, speech or design). The browser cannot look into the YouTube player, so every box is a position Gemini reported while watching – roughly every 2–4 seconds, and only approximate. Solid box: within 1.5 s of a reported position (or the product stays put in between). Dashed box, 'approx. position': up to 3 s away. Dot: further away or Gemini was unsure – only where it roughly is. Look closer re-checks 20 seconds at 2 frames per second and gives tighter boxes. Verify on screen: after you share this tab, models on your device look at the real frames. A box marked MEASURED is where our detector found the product – it follows the product; Gemini's own box then becomes a thin dashed 'Gemini estimate'. Boxes of products our models could not find are dimmed ('not seen on screen'). Grey dashed 'on screen only': a product type of this video that the device sees where Gemini lists nothing.")}
          <button class="btn verify-btn" id="verifyBtn" title="Check Gemini's findings on the real video frames, on your device">${icon("eye")} <span>Verify on screen</span></button>
          <button class="btn closer-btn" id="closerBtn" title="Let Gemini look closer at the next 20 seconds">${icon("search")} Look closer</button>
        </div>
        <div class="verify-status" id="verifyStatus" hidden></div>
        <div class="closer-status" id="closerStatus" hidden></div>
      </div>
      <aside class="now card" id="now">
        <div class="now-head"><span class="pulse"></span><b>Right now</b><span class="now-time num">0:00</span>${info("In the picture: products Gemini saw at this second. In the background: products Gemini reports in the picture whose position could not be checked – listed, but no box is drawn. Mentioned or written: brands that are spoken about or shown as on-screen text right now. Unidentified: products without a recognisable brand. Follows the video while it plays. Links: the creator's own link from the description if there is one (affiliate links are marked), otherwise a neutral shopping search. After Verify on screen each product shows what the models on your device found on the real frames: confirmed (brand read, brand recognised by its look, object found by a detector, or only the object type matches), not seen (checked on several frames, nothing found) or not checkable (none of our models knows this kind of product). Hover a label for the numbers.")}</div>
        <div class="now-list"></div>
      </aside>
    </div>
    <div id="ovBody"></div>`;

  const jump = (t) => { $("#playerHost").classList.add("paused"); state.player?.seek(t); $("#playerHost").scrollIntoView({ behavior: "smooth", block: "center" }); };
  let tl = null;

  function drawBody() {
    const d = state.data; const v = d.video;
    const val = videoValue(d, state.opts); const disc = checkDisclosure(d);
    const union = brandTimeShare(d);
    const au = d.authenticity || [];
    const auAvg = au.length ? round5(au.reduce((n, a) => n + a.overall, 0) / au.length) : null;
    const dur = v.duration_s || Math.max(1, ...d.brands.flatMap((b) => b.appearances.map((a) => a.end_s)));
    const valueOf = new Map(val.rows.map((r) => [r.brand.brand, r]));
    const promoted = new Set(au.map((a) => a.brand.toLowerCase()));
    const firstAt = (b) => b.appearances[0]?.start_s ?? Infinity;
    const rows = () => { const sortBy = state.sortBy || "screen"; return d.brands.filter((b) => b.appearances?.length).sort((a, b) => sortBy === "first" ? firstAt(a) - firstAt(b)
      : sortBy === "value" ? (valueOf.get(b.brand)?.euros || 0) - (valueOf.get(a.brand)?.euros || 0)
      : (valueOf.get(b.brand)?.raw.visual || 0) - (valueOf.get(a.brand)?.raw.visual || 0)); };
    const unid = d.unidentified || [];

    $("#ovBody").innerHTML = `
    <div class="stats">
      <button class="stat" data-scroll="tlSect"><span class="s-label">Products ${info("Distinct brands Gemini found in the picture, in on-screen text or in speech. Spelling variants are merged. Products without a recognisable brand are listed separately under Unidentified products.")}</span><b class="num">${d.brands.length}</b><span class="s-sub">${d.brands.filter((b) => b.appearances.some((a) => a.channel === "audio")).length} also mentioned in speech${unid.length ? ` · ${unid.length} unidentified` : ""}</span></button>
      <button class="stat" data-scroll="tlSect"><span class="s-label">Brand on screen ${info("Share of the video in which at least one brand is visible. Overlapping appearances are counted once. " + SCREEN_INFO)}</span><b class="num range">${pctRange(union)}</b><span class="s-sub">of ${fmtDur(v)}</span></button>
      <button class="stat" data-goto="disclosure"><span class="s-label">Ad disclosure ${info("Looks for an advertising label in title, description, on screen and in speech (§ 5a UWG, § 22 MStV). Green = clear label, orange = weak label, red = commercial signals but no label. A screening aid, not legal advice.")}</span><b class="status lvl-${disc.level}"><i class="dot"></i>${esc(disc.title)}</b><span class="s-sub">${esc(disc.sub)}</span></button>
      <button class="stat" data-goto="authenticity"><span class="s-label">Authenticity ${info("How genuine the recommendation feels: six factors rated by Gemini from image and sound (use shown, balance, specificity, delivery, body language, sales pressure). Rounded to 5 because runs vary by about ±6 points.")}</span><b class="num">${auAvg ?? "–"}</b><span class="s-sub">${auAvg != null ? band(auAvg) : "not rated"}</span></button>
      <button class="stat" data-goto="value"><span class="s-label">Media value ${info(`${VALUE_WHAT} What comparable reach would cost as 30-second video ads: views ÷ 1000 × CPM × weighted seconds ÷ 30, counting only viewers still watching at that point (audience drop-off) and discounted because a product in the picture gets less attention than an ad spot (${Math.round(state.opts.attention * 100)}%). Low / high = cautious / generous assumptions. Details under Media value.`)}</span><b class="num range">${euroRange(val.range)}</b><span class="s-sub">mid ${euro(val.range.mid)} · ${fmtViews(v.views)} views</span></button>
    </div>

    <section class="sect" id="tlSect">
      <div class="sect-head"><h3>Brand timeline <span class="count">${d.brands.length}</span></h3>${legend()}</div>
      <div class="card tl-card"><div id="tl"></div><p class="small muted tl-help">Click a bar to jump there in the video. Flags mark advertising labels.</p></div>
    </section>

    <section class="sect">
      <div class="sect-head"><h3>All products <span class="count">${rows().length}</span></h3>
        <span class="seg-ctl" id="psort">${[["screen", "Screen time"], ["first", "In order"], ["value", "Value"]].map(([k, l]) => `<button data-s="${k}" class="${(state.sortBy || "screen") === k ? "on" : ""}">${l}</button>`).join("")}</span></div>
      <div class="pgrid" id="pgrid"></div>
    </section>

    ${unid.length ? `<section class="sect" id="unidSect">
      <div class="sect-head"><h3>Unidentified products <span class="count">${unid.length}</span></h3>${info("Products Gemini saw but could not assign to a brand, e.g. a smartwatch on the presenter's wrist. Gemini is told never to guess; a vague idea is shown as 'possible'. They do not count towards media value or the disclosure check.")}</div>
      <div class="ugrid">${unid.map((u) => `<article class="ucard" data-t="${u.appearances[0]?.start_s ?? 0}" tabindex="0">
        <div class="uc-top"><span class="uc-ic">${icon("bag")}</span><div><b>${esc(cap(u.category))}</b><span>${esc(u.description || "")}</span></div></div>
        ${u.guess ? `<span class="tag soft">possible: ${esc(u.guess)}</span>` : ""}
        <div class="pc-jumps">${u.appearances.slice(0, 5).map((a) => `<button class="time" data-jump="${a.start_s}">${mmss(a.start_s)}</button>`).join("")}${u.appearances.some((a) => a.closer) ? `<span class="more">found by Look closer</span>` : ""}</div>
      </article>`).join("")}</div>
      <p class="small muted">Not counted in media value or the disclosure check.</p>
    </section>` : ""}`;

    const drawTimeline = (maxRows) => {
      tl = timeline($("#tl"), { maxRows, onJump: jump });
      tl.setTime(state.player?.t || 0);
      $("#tl .tl-more")?.addEventListener("click", () => drawTimeline(Infinity));
    };
    const drawGrid = () => {
      $("#pgrid").innerHTML = rows().map((b) => {
        const r = valueOf.get(b.brand) || { raw: {}, euros: 0 };
        const vis = b.appearances.filter((a) => a.channel === "visual");
        const spoken = b.appearances.filter((a) => a.channel === "audio").length;
        const first = (vis[0] || b.appearances[0])?.start_s ?? 0;
        const jumps = (vis.length ? vis : b.appearances).slice(0, 5);
        return `<article class="pcard" data-brand="${esc(b.brand)}" data-t="${first}" tabindex="0">
          <div class="pc-top">${logoBox(b.brand)}<div class="pc-name"><b>${esc(b.brand)}</b><span>${esc(b.product || b.category || "")}</span></div>
            ${promoted.has(b.brand.toLowerCase()) ? `<span class="tag">promoted</span>` : b.appearances.every((a) => a.closer) ? `<span class="tag soft">look closer</span>` : b.appearances.some((a) => a.in_use) ? `<span class="tag soft">in use</span>` : ""}</div>
          <div class="pc-lane">${b.appearances.map((a) => `<i class="${a.channel}" style="left:${Math.min(100, (100 * a.start_s) / dur)}%;width:${Math.max(0.8, (100 * (a.end_s - a.start_s)) / dur)}%;background:${color(b.brand)};color:${color(b.brand)}"></i>`).join("")}</div>
          <div class="pc-facts"><span title="${esc(SCREEN_INFO)}"><b class="num">${secRange(r.raw.visual || 0)}</b> on screen</span><span><b class="num">${spoken}×</b> spoken</span><span title="${esc(VALUE_WHAT)}"><b class="num">${euroRange(r.range)}</b> ad cost eq.</span>${audFact(b.brand)}</div>
          <div class="pc-jumps">${jumps.map((a) => `<button class="time" data-jump="${a.start_s}">${mmss(a.start_s)}</button>`).join("")}${b.appearances.length > jumps.length ? `<span class="more">+${b.appearances.length - jumps.length}</span>` : ""}</div>
          <div class="pc-verify" data-vb="${esc(b.brand)}"></div>
          ${cardLinks(b)}
        </article>`;
      }).join("");
      $("#pgrid").querySelectorAll(".pcard").forEach((c) => {
        c.onclick = (e) => { if (e.target.closest("a")) return; const j = e.target.closest("[data-jump]"); jump(Number(j ? j.dataset.jump : c.dataset.t)); };
        c.onkeydown = (e) => { if (e.key === "Enter") jump(Number(c.dataset.t)); };
      });
      hydrateLogos($("#pgrid"));
      refreshVerifyCards();
    };

    drawGrid();
    drawTimeline(8);
    $("#ovBody").querySelectorAll(".ucard").forEach((c) => {
      c.onclick = (e) => { const j = e.target.closest("[data-jump]"); jump(Number(j ? j.dataset.jump : c.dataset.t)); };
      c.onkeydown = (e) => { if (e.key === "Enter") jump(Number(c.dataset.t)); };
    });
    $("#ovBody").querySelectorAll("[data-goto]").forEach((el) => (el.onclick = (e) => { if (!e.target.closest(".info")) go(state.id, el.dataset.goto); }));
    $("#ovBody").querySelectorAll("[data-scroll]").forEach((el) => (el.onclick = (e) => { if (!e.target.closest(".info")) $(`#${el.dataset.scroll}`).scrollIntoView({ behavior: "smooth", block: "start" }); }));
    $("#psort").querySelectorAll("button").forEach((b) => (b.onclick = () => {
      state.sortBy = b.dataset.s; $("#psort").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); drawGrid();
    }));
  }

  drawBody();
  state.refreshOverview = drawBody;
  state.refreshVerifyCards = refreshVerifyCards;
  mountPlayer((t) => tl?.setTime(t));
  $("#closerBtn").onclick = () => lookCloser();
  $("#verifyBtn").onclick = () => (state.verifier?.running ? state.verifier.stop("Stopped.") : verifyDialog());
  renderVerifyStatus(state.verifier);
  refreshVerifyCards();
  hydrateLogos($("#view"));
  if (state.scrollTo) { const id = state.scrollTo; state.scrollTo = null; setTimeout(() => $(`#${id}`)?.scrollIntoView({ block: "start" }), 50); }
}

const cap = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);
const labelOf = (brand, product) => !product ? brand : product.toLowerCase().startsWith(brand.toLowerCase()) ? product : `${brand} ${product}`;

// ---------- "Verify on screen" (verify.js) ----------
const V_KIND = { text: "brand read on screen", look: "brand recognised by its look", object: "object found by the detector", type: "object type matches (not the brand)" };
const V_LABEL = { confirmed: "confirmed", not_seen: "not seen", not_checkable: "not checkable", checking: "checking…" };
/** Small status pill for Right now. s = verifier.statusAt(); nothing before the first check. */
function verifyPill(s) {
  if (!s || s.status === "unchecked") return "";
  const why = s.status === "confirmed" ? `Seen on ${s.hits} of ${s.checks} checked frames · ${V_KIND[s.kind] || ""}${s.read?.length ? ` (“${s.read.join("”, “")}”)` : ""}`
    : s.status === "not_seen" ? `Checked on ${s.checks} frames – none of our models found it${s.hits ? ` (only ${s.hits}×)` : ""}`
    : s.status === "not_checkable" ? "None of the models on your device knows this kind of product – Gemini's finding stays unchecked"
    : `${s.checks} frame${s.checks === 1 ? "" : "s"} checked so far`;
  // while verifying: was it found in the frame just checked? (a confirmed appearance can span a cut to a close-up)
  const now = s.now == null ? "" : s.now ? `<em>in this frame</em>` : s.status === "confirmed" ? `<em>not in this frame</em>` : "";
  return `<span class="vpill v-${s.status}" title="${esc(why)}">${s.status === "confirmed" ? icon("check") : s.status === "not_seen" ? icon("minus") : ""}${V_LABEL[s.status]}${s.status === "confirmed" && s.kind === "type" ? " · type" : ""}${now}</span>`;
}

/** One line per product card: what the device saw for all appearances of the brand. */
function refreshVerifyCards() {
  const v = state.verifier;
  document.querySelectorAll(".pc-verify[data-vb]").forEach((el) => {
    const s = v?.brandSummary(el.dataset.vb);
    const done = s ? s.total - s.unchecked : 0;
    if (!s || !done) { el.hidden = true; return; }
    el.hidden = false;
    const kinds = [...s.kinds].map((k) => ({ text: "brand read", look: "brand by look", object: "object found", type: "type only" }[k])).join(", ");
    const head = s.confirmed ? `<b class="v-confirmed">${icon("check")} Confirmed on screen</b>` : s.not_seen ? `<b class="v-not_seen">${icon("minus")} Not seen on screen</b>`
      : s.not_checkable ? `<b class="v-not_checkable">Not checkable on this device</b>` : `<b class="v-checking">Checking…</b>`;
    const parts = [s.confirmed && `${s.confirmed} confirmed`, s.not_seen && `${s.not_seen} not seen`, s.not_checkable && `${s.not_checkable} not checkable`, s.checking && `${s.checking} checking`].filter(Boolean);
    el.innerHTML = `${head}<span>${parts.join(" · ")} of ${s.total} appearance${s.total === 1 ? "" : "s"} · ${s.hits}/${s.frames} frames${kinds ? ` · ${kinds}` : ""}${s.read.size ? ` · read “${esc([...s.read].slice(0, 2).join("”, “"))}”` : ""}</span>`;
  });
}

/** Status line under the player while / after verifying. */
function renderVerifyStatus(v) {
  const box = $("#verifyStatus"), btn = $("#verifyBtn"); if (!box || !btn) return;
  btn.classList.toggle("on", !!v?.running);
  btn.querySelector("span").textContent = v?.running ? "Stop verifying" : "Verify on screen";
  if (!v || (v.phase === "idle" && !v.hasResults)) { box.hidden = true; return; }
  // layout like the other status cards: title, the three verdicts as the same pills as on the cards, one quiet detail line
  const s = v.summary();
  const chip = (k, n, ic) => n ? `<span class="vpill v-${k}">${ic ? icon(ic) : ""}${n} ${V_LABEL[k]}</span>` : ""; // zeros left out
  const chips = `<div class="vs-chips">${chip("confirmed", s.confirmed, "check")}${chip("not_seen", s.not_seen, "minus")}${chip("not_checkable", s.not_checkable)}${chip("checking", s.checking)}</div>`;
  const how = { element: "only the player is shared", region: "player area of this tab", tab: "this tab, cut to the player" }[v.mode] || "";
  const dev = s.dev.n ? `Gemini's boxes vs. measured: ${Math.round(s.dev.iou * 100)} % overlap, centres ${s.dev.dist.toFixed(0)} % of the picture apart (median of ${s.dev.n} frames)` : "";
  const detail = (parts) => { const t = parts.filter(Boolean).join(" · "); return t ? `<small>${t}</small>` : ""; };
  box.hidden = false;
  box.className = `verify-status ${v.running ? "run" : ""}`;
  box.innerHTML = v.phase === "asking" ? `<span class="spinner"></span><div><b>Waiting for your choice</b><span>${esc(v.message)}</span></div>`
    : v.phase === "loading" ? `<span class="spinner"></span><div><b>Loading the models on your device</b><span>First time about 110 MB, then from the browser cache.</span></div>`
    : v.running ? `<span class="rec"></span><div><b>Verifying on your device · <span class="num">${s.frames}</span> frames checked</b><span>${v.message ? esc(v.message) : "Play the video or jump to a scene."}</span>${chips}${detail([how, v.msPerFrame && `${(v.msPerFrame / 1000).toFixed(1)} s per frame`, dev])}</div>`
    : `${icon("eye")}<div><b>Verified on screen · ${s.frames} frames</b><span>${v.message ? `${esc(v.message)} · ` : ""}Nothing was uploaded.</span>${chips}${detail([dev])}</div>`;
}

/** Permission sheet before the browser's own "share this tab" dialog – what happens, and that nothing leaves the device. */
function verifyDialog() {
  const supported = !!navigator.mediaDevices?.getDisplayMedia;
  const el = sheet(`<h2>${icon("eye")} Verify on screen</h2>
    <p>PlacementRadar cannot look into the YouTube player by itself, so everything so far comes from Gemini. If you share this tab, models <b>on your device</b> look at the real video frames and check each finding:</p>
    <ul class="v-list"><li><b>Brand text</b> – text recognition reads brand and model names</li><li><b>Brand look</b> – our own model, 1,020 brands</li>
      <li><b>Objects</b> – two object finders (YOLOE, YOLO26) give measured boxes that follow the product</li><li><b>Product type</b> – MobileCLIP compares the picture with about 90 product types</li></ul>
    <div class="v-privacy">${icon("shield")}<div><b>Stays on your device</b><span>Frames are analysed only in this browser. Nothing is uploaded, recorded or sent to our server or to Gemini; the results are kept in this tab until you close it. In Chrome only the video player is shared, not the rest of the tab.</span></div></div>
    <p class="small muted">Next, your browser asks what to share: choose <b>This tab</b>. First use loads about 110 MB of models (then cached). Works best in Chrome or Edge on a computer.</p>
    ${supported ? "" : `<p class="small" style="color:var(--orange)">This browser cannot share a tab.</p>`}
    <div class="row-btns" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-close>Cancel</button><button class="btn primary" id="vGo" ${supported ? "" : "disabled"}>${icon("eye")} Share this tab</button></div>`);
  el.querySelector("#vGo").onclick = async () => {
    el.remove();
    const v = state.verifier; if (!v) return;
    try { await v.start(); } catch (e) { v.stop(e.name === "NotAllowedError" ? "Sharing was not allowed." : e.message); }
  };
}

// ---------- "Look closer" ----------
/**
 * Asks the Worker (POST /api/closer) to inventory ~20 s around the current second at 2 frames per second
 * (1 Gemini request, ~1–1.5 min; cached per clip on the server). The clip is snapped to 5-second steps so
 * neighbouring clicks share a cache entry. The result is merged into the analysis in memory (and kept for this
 * browser session), so the product list, Right now and the tracking boxes include it.
 */
async function lookCloser() {
  const btn = $("#closerBtn"), box = $("#closerStatus"); if (!btn || !box) return;
  const id = state.id, t = state.player?.t ?? 0, dur = state.data.video.duration_s || Infinity;
  let start = Math.max(0, Math.floor((t - 5) / 5) * 5); let end = Math.min(start + 20, Math.ceil(dur));
  if (end - start < 5) start = Math.max(0, end - 20);
  btn.disabled = true; box.hidden = false;
  const t0 = Date.now();
  const show = (html, cls = "") => { box.className = `closer-status ${cls}`; box.innerHTML = html; };
  const elapsed = () => mmss((Date.now() - t0) / 1000);
  let msg = "Connecting …";
  const render = () => show(`<span class="spinner"></span><div><b>Looking closer at ${mmss(start)}–${mmss(end)}</b><span>${msg} · <span class="num">${elapsed()}</span> · usually 1–1.5 min, 2 frames per second, small and worn items included</span></div>`);
  render(); const tick = setInterval(render, 1000);
  const done = (html, cls) => { clearInterval(tick); btn.disabled = false; show(html, cls); };
  try {
    const invite = (() => { try { return new URLSearchParams(location.search).get("invite") || localStorage.getItem("invite") || ""; } catch { return ""; } })();
    const r = await fetch("api/closer", { method: "POST", headers: { "content-type": "application/json", "x-invite": invite }, body: JSON.stringify({ v: id, start, end }) });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      return done(`${icon("minus")}<div><b>Look closer is not available right now</b><span>${esc(j.message || (r.status === 404 ? "It runs in the online version (Cloudflare Worker); locally only the examples work." : `HTTP ${r.status}`))}</span></div>`, "err");
    }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done: end_ } = await reader.read(); if (end_) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (.+)/.exec(chunk)?.[1]; const data = JSON.parse(/data: (.+)/s.exec(chunk)?.[1] || "{}");
        if (ev === "model") msg = `${esc(modelName(data.model))} is watching`;
        if (ev === "retry") msg = data.status === "bad_answer" ? "Unreadable answer – asking the next model" : "Google is busy – trying the next model";
        if (ev === "error") return done(`${icon("minus")}<div><b>Look closer did not finish</b><span>${esc(data.message || data.error)}</span></div>`, "err");
        if (ev === "result") {
          if (state.id !== id) return done("", "");
          const added = mergeCloser(data);
          try { const k = `closer:${id}`; const list = JSON.parse(sessionStorage.getItem(k) || "[]").filter((x) => x.start !== data.start); list.push(data); sessionStorage.setItem(k, JSON.stringify(list)); } catch { /* ignore */ }
          state.refreshOverview?.();
          state.player && state.player.onTime(state.player.t);
          const names = added.map((x) => x.label);
          return done(`${icon("check")}<div><b>${names.length ? `${names.length} more ${names.length === 1 ? "product" : "products"} at ${mmss(start)}–${mmss(end)}` : `Nothing new at ${mmss(start)}–${mmss(end)}`}</b><span>${names.length ? esc(names.join(" · ")) : "Everything Gemini saw there was already in the list."}${data.cached ? " · saved result, no new request" : ""}</span></div>`, "ok");
        }
      }
    }
    done(`${icon("minus")}<div><b>The connection ended early</b><span>Try again in a moment – a finished result is saved on the server.</span></div>`, "err");
  } catch {
    done(`${icon("minus")}<div><b>Look closer runs in the online version</b><span>Locally (without the Cloudflare Worker) only the prepared examples are available.</span></div>`, "err");
  }
}

/** Merge a /api/closer result into state.data. Returns what is new: [{label}]. Idempotent per clip. */
function mergeCloser(res) {
  const d = state.data; d.unidentified ||= []; const added = [];
  (state.closerDone ||= []).push({ id: state.id, start: res.start, end: res.end }); // no more "Look closer" hint for this clip
  const overlaps = (list, a) => list.some((x) => x.channel === "visual" && a.start_s < x.end_s + 1 && a.end_s > x.start_s - 1);
  for (const nb of res.brands || []) {
    let b = d.brands.find((x) => x.brand.toLowerCase() === nb.brand.toLowerCase());
    if (!b) {
      b = { ...nb, appearances: [], frames: [], products: [...(nb.products || [])] }; d.brands.push(b);
      state.colors.set(b.brand, PALETTE[(d.brands.length - 1) % PALETTE.length]);
      added.push({ label: [nb.brand, nb.product].filter(Boolean).join(" ") });
    } else for (const p of nb.products || []) if (!b.products?.includes(p)) { (b.products ||= []).push(p); if (!b.product) b.product = p; }
    for (const a of nb.appearances) {
      if (!overlaps(b.appearances, a)) { b.appearances.push(a); (a.track || []).forEach((k) => b.frames.push(k)); continue; }
      // already known here: do not count it twice, but its tighter 2-frames/s position refines the tracking boxes
      for (const k of a.track || []) for (const x of b.appearances) {
        if (x.channel !== "visual" || k.t < x.start_s - 1 || k.t > x.end_s + 1 || !x.track) continue;
        x.track = [...x.track.filter((o) => Math.abs(o.t - k.t) >= 0.5), { ...k, closer: true }].sort((p, q) => p.t - q.t);
      }
    }
    b.appearances.sort((x, y) => x.start_s - y.start_s);
  }
  for (const nu of res.unidentified || []) {
    const same = d.unidentified.find((u) => u.category.toLowerCase() === nu.category.toLowerCase() && nu.appearances.some((a) => overlaps(u.appearances, a)));
    if (same) continue;
    d.unidentified.push(nu); added.push({ label: `${cap(nu.category)} (brand unknown)` });
  }
  d.unidentified.sort((a, b) => (a.appearances[0]?.start_s ?? 0) - (b.appearances[0]?.start_s ?? 0));
  return added;
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
function timeline(root, { maxRows = Infinity, onJump = null } = {}) {
  const d = state.data; const dur = d.video.duration_s || Math.max(...d.brands.flatMap((b) => b.appearances.map((a) => a.end_s)), 1);
  const rows = d.brands.slice(0, maxRows);
  const pct = (s) => `${Math.min(100, (100 * s) / dur)}%`;
  root.innerHTML = `
    <div class="tl">
      <div class="tl-flags">${d.disclosures.map((x) => `<span class="flag" style="left:${pct(x.time_s)}" data-t="${x.time_s}" data-tip="${esc(`Disclosure (${x.kind}) · ${mmss(x.time_s)}|${x.text}`)}">${icon("flag", "icon")}ad label</span>`).join("")}</div>
      ${rows.map((b) => `<div class="tl-row"><div class="name"><i style="background:${color(b.brand)}"></i>${esc(b.brand)}</div>
        <div class="lane">${b.appearances.map((a) => `<div class="seg ${a.channel}" style="left:${pct(a.start_s)};width:calc(${pct(a.end_s - a.start_s)});color:${color(b.brand)};background:${color(b.brand)}"
          data-t="${a.start_s}" data-tip="${esc(`${b.brand} · ${mmss(a.start_s)}–${mmss(a.end_s)} · ${a.channel}${a.size ? " · " + a.size : ""}${a.in_use ? " · in use" : ""}|${a.evidence}`)}"></div>`).join("")}</div></div>`).join("")}
      ${d.brands.length > rows.length ? `<button class="link tl-more">Show all ${d.brands.length} brands</button>` : ""}
      <div class="axis"><span>0:00</span><span>${mmss(dur / 4)}</span><span>${mmss(dur / 2)}</span><span>${mmss((3 * dur) / 4)}</span><span>${mmss(dur)}</span></div>
      <div class="playhead" style="left:calc(162px + 0%)"></div>
    </div>`;
  const ph = root.querySelector(".playhead"); const lane = root.querySelector(".lane");
  const setTime = (t) => { const w = lane ? lane.getBoundingClientRect().width : 0; ph.style.left = `${162 + (w * Math.min(1, t / dur))}px`; };
  root.querySelectorAll("[data-t]").forEach((el) => {
    el.onclick = () => {
      if (onJump) return onJump(Number(el.dataset.t));
      go(state.id, "overview", Number(el.dataset.t));
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

// ---------- Media value view ----------
function valueRows(rows) {
  const max = Math.max(...rows.map((r) => r.euros), 1);
  return rows.map((r) => `<div class="row" data-brand="${esc(r.brand.brand)}">${logoBox(r.brand.brand, "sm")}
    <div style="min-width:0"><div class="t">${esc(r.brand.brand)}</div><div class="p">${esc(r.brand.product || "")} · score ${r.score}</div></div>
    <div class="barcell"><div class="bar"><i style="width:${(100 * r.euros) / max}%;background:${color(r.brand.brand)}"></i></div></div>
    <div class="eur num">${euroRange(r.range)}</div><span class="chev">${icon("chevron")}</span></div>`).join("") || `<div class="empty-state">No brands found.</div>`;
}
/** Mid-scenario formula with this brand's numbers, plus the low and high results. */
function valueFormula(r, v) {
  const p = scenarioParams(state.opts).mid;
  return `<div class="formula">${Math.round(v.views || 0).toLocaleString("en")} views / 1000 × €${p.cpmEur} CPM × (${r.retained.mid.toFixed(1)} retained s / 30) × ${Math.round(100 * p.att)}% attention = ${euro(r.range.mid)} (mid)<br>
    low ${euro(r.range.low)} · high ${euro(r.range.high)} · ${r.weighted.total.toFixed(1)} weighted s before audience drop-off</div>`;
}
function bindRows() { document.querySelectorAll(".row[data-brand]").forEach((r) => (r.onclick = () => brandSheet(r.dataset.brand))); }

function viewValue() {
  const d = state.data;
  const dur = d.video.duration_s || Math.max(1, ...d.brands.flatMap((b) => b.appearances.map((a) => a.end_s)));
  const draw = () => {
    const val = videoValue(d, state.opts); const p = scenarioParams(state.opts);
    $("#vtotal").textContent = euroRange(val.range);
    $("#vmid").textContent = euro(val.range.mid);
    $("#vlist").innerHTML = valueRows(val.rows); bindRows(); hydrateLogos($("#vlist"));
    $("#cpmv").textContent = `€${state.opts.cpm}`; $("#attv").textContent = `${Math.round(state.opts.attention * 100)}%`;
    $("#vscen").innerHTML = ["low", "mid", "high"].map((k) => `<tr><th>${k}</th><td class="num">€${p[k].cpmEur.toFixed(0)}</td><td class="num">${Math.round(100 * SCENARIOS[k].retStart)} → ${Math.round(100 * SCENARIOS[k].retEnd)}%</td><td class="num">${Math.round(100 * p[k].att)}%</td><td class="num"><b>${euro(val.range[k])}</b></td></tr>`).join("");
  };
  $("#view").innerHTML = `
    <div class="cols-2" style="grid-template-columns:1fr 1.3fr;align-items:start">
      <div class="stack">
        <div class="kpi"><div class="label">Equivalent ad cost of all brands ${info(`${VALUE_WHAT} A brand would pay roughly this for the same reach as regular 30-second video ads. A creator is paid per deal – often much less, or nothing for an organic mention.`)}</div><div class="value num" id="vtotal"></div>
          <div class="foot">Earned media value, mid estimate <b class="num" id="vmid"></b>. Not what the creator earned.</div></div>
        <div class="card"><h3>Assumptions</h3>
          <div class="slider"><span>CPM (€ / 1000 views, mid)</span><input type="range" id="cpm" min="5" max="40" step="1" value="${state.opts.cpm}"><b class="num" id="cpmv"></b></div>
          <div class="slider" style="margin-top:16px"><span>Attention vs. an ad spot (mid)</span><input type="range" id="att" min="10" max="80" step="5" value="${Math.round(state.opts.attention * 100)}"><b class="num" id="attv"></b></div>
          <div class="ret-chart">${retentionChart(dur)}</div>
          <table class="scen"><thead><tr><th></th><th>CPM</th><th>Audience start → end</th><th>Attention</th><th>Value</th></tr></thead><tbody id="vscen"></tbody></table>
          <div class="formula">value = views / 1000 × CPM × (retained seconds / 30) × attention<br>
            retained seconds = Σ weighted seconds × audience share at that moment<br>
            weighted seconds = visible × size × position × (in use ? ${WEIGHTS.inUse} : 1) × (only lying in the picture ? ${WEIGHTS.background} : 1) + spoken × ${WEIGHTS.audio} + text × ${WEIGHTS.text}</div>
          <p class="small muted" style="margin-bottom:0">Audience share falls linearly while the video runs (later moments are seen by fewer people). Attention: a product in the picture is not a 30-second ad spot. Weights: size small ${WEIGHTS.size.small} · medium ${WEIGHTS.size.medium} · large ${WEIGHTS.size.large}; position center ${WEIGHTS.position.center} · edge ${WEIGHTS.position.edge}. All assumptions, adjustable – the method follows sponsorship measurement in sports media.</p>
        </div>
      </div>
      <div><div class="nav-label">Brands, by mid value. Click one for the breakdown.</div><div class="list" id="vlist"></div></div>
    </div>`;
  $("#cpm").oninput = (e) => { state.opts.cpm = Number(e.target.value); draw(); };
  $("#att").oninput = (e) => { state.opts.attention = Number(e.target.value) / 100; draw(); };
  draw();
}

/** Small SVG: audience share over the video for low / mid / high, with this video's appearances as ticks. */
function retentionChart(dur) {
  const W = 300, H = 92, x = (t) => 28 + (W - 36) * (t / dur), y = (r) => 8 + (H - 30) * (1 - r);
  const line = (k) => `<path d="M${x(0)} ${y(retention(0, dur, SCENARIOS[k]))} L${x(dur)} ${y(retention(dur, dur, SCENARIOS[k]))}" class="rl ${k}"/>`;
  const ticks = state.data.brands.flatMap((b) => b.appearances.filter((a) => a.channel === "visual").map((a) => `<rect x="${x(a.start_s)}" y="${H - 18}" width="${Math.max(1.5, x(a.end_s) - x(a.start_s))}" height="5" rx="1" fill="${color(b.brand)}"/>`)).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Audience share over the video">
    ${[1, 0.5, 0].map((r) => `<line x1="28" x2="${W - 8}" y1="${y(r)}" y2="${y(r)}" class="rg"/><text x="22" y="${y(r) + 3.5}" text-anchor="end">${r * 100}%</text>`).join("")}
    ${line("high")}${line("mid")}${line("low")}${ticks}
    <text x="28" y="${H - 2}">0:00</text><text x="${W - 8}" y="${H - 2}" text-anchor="end">${mmss(dur)}</text>
    <text x="${x(dur * 0.5)}" y="${H - 2}" text-anchor="middle">audience still watching · products on screen</text></svg>`;
}

function brandSheet(name) {
  const b = state.data.brands.find((x) => x.brand === name); if (!b) return;
  const r = brandValue(b, state.data.video, state.opts); const w = r.weighted; const maxW = Math.max(w.visual, w.audio, w.text, 1);
  const factor = (label, val, raw) => `<div class="factor"><span>${label}</span><div class="bar"><i style="width:${(100 * val) / maxW}%;background:${color(b.brand)}"></i></div><span class="num">${Math.round(raw)} s</span></div>`;
  const scrim = document.createElement("div"); scrim.className = "scrim";
  scrim.innerHTML = `<div class="sheet">
    <div class="sheet-head">${logoBox(b.brand)}<div style="min-width:0"><h2>${esc(b.brand)}</h2><div class="muted small">${esc(b.product || b.category || "")}</div></div>
      <div class="amount"><b class="num">${euroRange(r.range)}</b><span class="small muted">equivalent ad cost · visibility score ${r.score}/100</span></div></div>
    <div class="nav-label">Exposure</div>
    ${factor(`${icon("eye")} Visible`, w.visual, r.raw.visual || 0)}${factor(`${icon("ear")} Spoken`, w.audio, r.raw.audio || 0)}${factor(`${icon("text")} On-screen text`, w.text, r.raw.text || 0)}
    <div class="nav-label">Appearances</div>
    ${b.appearances.slice(0, 12).map((a) => `<div class="finding"><button class="time" data-t="${a.start_s}">${mmss(a.start_s)}</button><span class="small">${esc(a.channel)}${a.size ? " · " + a.size : ""}${a.position ? " · " + a.position : ""}${a.in_use ? " · in use" : ""} — ${esc(a.evidence)}</span></div>`).join("")}
    ${valueFormula(r, state.data.video)}
    <p class="small muted">${esc(VALUE_WHAT)}</p>
    <div class="sheet-foot"><button class="btn primary" data-close>Done</button></div></div>`;
  document.body.append(scrim); hydrateLogos(scrim);
  const close = () => scrim.remove();
  scrim.onclick = (e) => { if (e.target === scrim || e.target.closest("[data-close]")) close(); };
  scrim.querySelectorAll("[data-t]").forEach((el) => (el.onclick = () => { close(); go(state.id, "overview", Number(el.dataset.t)); }));
}

// ---------- Disclosure view ----------
function viewDisclosure() {
  const c = checkDisclosure(state.data);
  $("#view").innerHTML = `
    <div class="card verdict-card lvl-${c.level}"><div class="verdict"><div class="light"><i></i></div>
      <div><h2>${esc(c.title)}</h2><p>${esc(c.sub)}</p></div></div></div>
    <div class="cols-2" style="margin-top:20px;align-items:start">
      <div class="card"><h3>Where a label was looked for</h3>
        ${c.checklist.map((x) => `<div class="check"><span class="${x.ok ? "ok" : "no"}">${icon(x.ok ? "check" : "minus")}</span><b>${x.label}</b><span class="small muted">${esc(x.detail || (x.ok ? "found" : "not found"))}</span></div>`).join("")}
        ${c.findings.filter((f) => f.time_s != null).map((f) => `<div class="finding"><button class="time" data-t="${f.time_s}">${mmss(f.time_s)}</button><span><b>${esc(f.source)}</b> <span class="muted">${f.strength === "strong" ? "clear label" : "weak label"}</span><br><span class="small muted">"${esc(f.text)}"</span></span></div>`).join("")}
      </div>
      <div class="card"><h3>Commercial signals</h3>
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
  $("#view").innerHTML = (items.length ? `<div class="auth-list">` + items.map((a, i) => `
    <div class="card"><div class="auth-card">
      <div>${gauge(a.overall)}<div class="brandline"><b>${esc(a.brand)}</b><div class="small muted">${esc(a.product)}</div></div></div>
      <div><p class="verdict-text">${esc(a.verdict)}</p><div class="subs">
        ${SUBS.map(([k, label]) => { const s = a.sub?.[k] || {}; return `<div class="factor" data-i="${i}"><span>${label}</span><div class="bar"><i style="width:${s.score ?? 0}%"></i></div><span class="num">${s.score ?? "–"}</span></div>
          <div class="evidence">${s.time_s != null ? `<button class="time" data-t="${s.time_s}">${mmss(s.time_s)}</button> ` : ""}${esc(s.evidence)}</div>`; }).join("")}
      </div></div></div></div>`).join("") + `</div>` : `<div class="empty-state">${esc(noAuthText())}</div>`) +
    `<p class="legal">Perceived authenticity – an AI estimate from image and audio, not a judgement of the creator. Body language is a weak signal for honesty
      (people detect deception barely above chance, Bond &amp; DePaulo 2006), so it is one of six factors and the score is rounded to steps of 5. Theory: source credibility (Hovland) and the Persuasion Knowledge Model (Friestad &amp; Wright 1994).</p>`;
  $("#view").querySelectorAll(".factor").forEach((f) => (f.onclick = () => f.classList.toggle("open")));
  $("#view").querySelectorAll("[data-t]").forEach((el) => (el.onclick = (e) => { e.stopPropagation(); go(state.id, "overview", Number(el.dataset.t)); }));
}

// ---------- Audience: reactions to each product in the top comments (POST /api/comments, shared/comments.js) ----------
/**
 * The Worker reads the top ~100 YouTube comments and sorts them by rules (no AI call, no quota): which product a
 * comment is about, and whether it shows purchase intent, a question, praise, criticism or ad suspicion. Only
 * counts and short excerpts arrive here; the result stays in this tab (sessionStorage). Accuracy: test K.
 */
const CAT_COLOR = { buy: "var(--accent)", question: "var(--purple, #af52de)", praise: "var(--green)", critic: "var(--red)", ad_doubt: "var(--orange)" };
const CAT_INFO = {
  buy: "Purchase intent: asks where to buy, for a link or the exact model, or says they want, ordered or bought it.",
  question: "Any other question – about the product, the video or something missing.",
  praise: "Praise for the product or the video.",
  critic: "Criticism: too expensive, broke, disappointed, something missing.",
  ad_doubt: "Ad suspicion: asks or says that the video is sponsored, paid or an ad, or that the products were free.",
};
/** Product card line once the Audience view has read the comments (nothing is fetched for the cards themselves). */
const audFact = (brand) => {
  const s = audienceOf(state.id)?.brands?.[brand]; if (!s?.comments) return "";
  const extra = [s.cats.buy && `${s.cats.buy} want it`, s.cats.ad_doubt && `${s.cats.ad_doubt} suspect an ad`].filter(Boolean).join(" · ");
  return `<span title="Top comments that name this product (Audience view)"><b class="num">${s.comments}</b> comment${s.comments === 1 ? "" : "s"}${extra ? ` · ${extra}` : ""}</span>`;
};
const audienceKey = (id) => `comments:${id}`;
const audienceOf = (id) => { try { return JSON.parse(sessionStorage.getItem(audienceKey(id)) || "null"); } catch { return null; } };

async function viewAudience() {
  const d = state.data; const id = state.id;
  const brands = d.brands.filter((b) => !/^unknown/i.test(b.brand)).map((b) => ({ brand: b.brand, product: b.product || undefined }));
  let res = audienceOf(id);
  if (!res) {
    $("#view").innerHTML = `<div class="card aud-wait"><span class="spinner"></span><div><b>Reading the top comments</b><span>About 100 comments from YouTube, sorted by rules on the server – no AI request, nothing about the commenters is kept.</span></div></div>`;
    try {
      const r = await fetch("api/comments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: id, brands }) });
      res = await r.json(); if (!r.ok) throw new Error(res.message || res.error || `HTTP ${r.status}`);
      if (res.n) try { sessionStorage.setItem(audienceKey(id), JSON.stringify(res)); } catch { /* full */ }
    } catch (e) { res = { n: 0, error: String(e.message || e) }; }
    if (state.id !== id || state.view !== "audience") return; // the visitor moved on meanwhile
  }
  if (!res.n) {
    $("#view").innerHTML = `<div class="empty-state">${icon("chat")}<b>No comments to read</b><span>${esc(res.error === "comments turned off or not found" ? "Comments are turned off for this video." : `YouTube did not hand out the comments right now${res.error ? ` (${res.error})` : ""}. The other views are not affected.`)}</span></div>`;
    return;
  }
  const t = res.total.cats; const sum = CATS.reduce((n, k) => n + t[k], 0) || 1;
  const pills = (cats) => CATS.filter((k) => cats[k]).map((k) => `<span class="aud-pill" style="--c:${CAT_COLOR[k]}" title="${esc(CAT_INFO[k])}"><i></i>${cats[k]} ${esc(CAT_LABEL[k].toLowerCase())}</span>`).join("");
  const quotes = (ex) => ex.map((e) => `<li><span class="aud-dot" style="--c:${CAT_COLOR[e.cats[0]]}" title="${esc(e.cats.map((k) => CAT_LABEL[k]).join(", "))}"></span><q>${esc(e.text)}</q></li>`).join("");
  const rows = Object.entries(res.brands).filter(([, s]) => s.comments).sort((a, b) => b[1].comments - a[1].comments);
  const silent = Object.entries(res.brands).filter(([, s]) => !s.comments).map(([k]) => k);
  const product = (name) => d.brands.find((b) => b.brand === name)?.product || "";
  $("#view").innerHTML = `
    <div class="card aud-head">
      <div class="aud-title"><h3>What the audience says ${info(`The top ${res.n} comments of this video as YouTube sorts them ("Top comments"), read ${res.cached ? "earlier today" : "just now"} via ${res.source === "data-api" ? "the YouTube Data API" : "YouTube's own comment endpoint"}. A comment counts for a product if it names the brand or a word of the product name that no other product here has. Categories by fixed word rules in English and German – several can apply, many comments fit none. Checked by hand on 50 held-back comments (test K in EVALUATION.md): questions and praise are mostly right, criticism and purchase intent are rare and less reliable.`)}</h3>
        <span class="small muted">${res.n} top comments · ${rows.length} of ${rows.length + silent.length} brands mentioned · no AI request</span></div>
      <div class="aud-bar">${CATS.filter((k) => t[k]).map((k) => `<i style="flex:${t[k]};--c:${CAT_COLOR[k]}" title="${t[k]} × ${esc(CAT_LABEL[k])}"></i>`).join("")}</div>
      <div class="aud-legend">${CATS.map((k) => `<span title="${esc(CAT_INFO[k])}"><i style="--c:${CAT_COLOR[k]}"></i>${esc(CAT_LABEL[k])} <b class="num">${t[k]}</b></span>`).join("")}</div>
      ${t.ad_doubt ? `<p class="aud-note">${icon("shield")}<span>${t.ad_doubt} comment${t.ad_doubt === 1 ? "" : "s"} ${t.ad_doubt === 1 ? "suspects" : "suspect"} advertising – compare with the <a href="#/v/${esc(id)}/disclosure">Ad disclosure</a> view.</span></p>` : ""}
    </div>
    <div class="aud-list">${rows.map(([name, s]) => `
      <div class="card aud-row">
        <div class="aud-brand">${logoBox(name)}<div><b>${esc(name)}</b><span class="small muted">${esc(product(name))}</span></div><span class="aud-n num">${s.comments}<small>comment${s.comments === 1 ? "" : "s"}</small></span></div>
        <div class="aud-pills">${pills(s.cats) || `<span class="small muted">named, but none of the five reactions</span>`}</div>
        ${s.examples.length ? `<ul class="aud-quotes">${quotes(s.examples)}</ul>` : ""}
      </div>`).join("")}
      <div class="card aud-row aud-general">
        <div class="aud-brand"><span class="logo">${icon("chat")}</span><div><b>About the video in general</b><span class="small muted">comments that name none of the products</span></div><span class="aud-n num">${res.general.comments}<small>comments</small></span></div>
        <div class="aud-pills">${pills(res.general.cats)}</div>
        ${res.general.examples.length ? `<ul class="aud-quotes">${quotes(res.general.examples)}</ul>` : ""}
      </div>
    </div>
    ${silent.length ? `<p class="small muted aud-silent">Not named in the top comments: ${esc(silent.join(", "))}.</p>` : ""}
    <p class="legal">Excerpts are cut to at most 100 characters; names and profile pictures of commenters are never read or stored. Top comments favour early and popular reactions, so they are not a survey of all viewers. Rules miss irony and context (a "backpack" can be someone else's backpack) – read the numbers as a first impression.</p>`;
  hydrateLogos($("#view"));
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
        <div class="rp-brand">${logoBox(b.brand)}<div><h2>${esc(b.brand)}</h2><div class="muted">${esc(b.product || b.category || "")}</div></div>
          <div class="rp-rank"><b>#${rank + 1}</b> of ${val.rows.length} brands<br><span class="muted small">${share}% of the video's brand value</span></div></div>
        <div class="rp-video"><img alt="" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg">
          <div><b>${esc(v.title)}</b><div class="small muted">${esc(v.channel || "")} · ${fmtViews(v.views)} views · ${fmtDur(v)}${v.upload_date ? ` · uploaded ${esc(fmtDate(v.upload_date))}` : ""}</div>
          <a class="small" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener">youtube.com/watch?v=${esc(v.id)}</a></div></div>
        <div class="rp-kpis">
          <div><span>Equivalent ad cost</span><b class="num">${euroRange(r.range)}</b><i>mid ${euro(r.range.mid)} · not the creator's fee</i></div>
          <div><span>Visibility score</span><b class="num">${r.score}<small>/100</small></b><i>${r.inUse ? "shown in use" : "not shown in use"}</i></div>
          <div title="${esc(SCREEN_INFO)}"><span>On screen</span><b class="num">${secRange(r.raw.visual || 0)}</b><i>${Math.round(r.raw.text || 0)} s as on-screen text</i></div>
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
        ${valueFormula(r, v)}
        <p class="legal">Equivalent ad cost (earned media value): what comparable reach would cost as 30-second video ads – not what the creator earned. Weighted seconds: on screen × size × position (× ${WEIGHTS.inUse} when in use, × ${WEIGHTS.background} when it only lies or stands in the picture) + spoken × ${WEIGHTS.audio} + on-screen text × ${WEIGHTS.text}; each moment counts only the audience still watching (linear drop-off, low ${Math.round(100 * SCENARIOS.low.retStart)} → ${Math.round(100 * SCENARIOS.low.retEnd)}%, high ${Math.round(100 * SCENARIOS.high.retStart)} → ${Math.round(100 * SCENARIOS.high.retEnd)}%) and an attention factor for "product in the picture" instead of an ad spot. Appearances detected by ${esc([...new Set(d.source?.models || [])].map(modelName).join(" + ") || "Gemini")} from image and audio (analysed ${esc(d.source?.analyzed_at || "")}); times are approximate (±3 s).
          The disclosure check refers to § 5a (4) UWG and § 22 MStV and is a screening aid, not legal advice. All values are estimates.</p>
      </article>
      <aside class="report-side">
        <div class="card"><h3>Brand</h3>
          <select id="rbrand" class="select">${val.rows.map((x) => `<option ${x.brand.brand === b.brand ? "selected" : ""}>${esc(x.brand.brand)}</option>`).join("")}</select>
          <button class="btn primary" id="rprint" style="margin-top:12px;width:100%;justify-content:center">${icon("doc")} Save as PDF</button>
          <p class="small muted" style="margin:8px 0 0">Opens the print dialog – choose "Save as PDF". CPM and attention come from the Media value view.</p></div>
        <div class="card"><h3>Pitch mail to the creator</h3>
          <textarea id="rmail" class="mail" rows="14" spellcheck="false">${esc(pitchMail(b, r, mentions, disc))}</textarea>
          <button class="btn" id="rcopy" style="margin-top:10px">${icon("check")} <span>Copy text</span></button></div>
      </aside>
    </div>`;
  hydrateLogos($("#report"));
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
    `${b.brand}${b.product ? ` (${b.product})` : ""} is on screen for roughly ${secRange(seen).replace(" s", " seconds")}${mentions ? ` and you mention it ${mentions === 1 ? "once" : `${mentions} times`}` : ""}${r.inUse ? " – and you actually use it, which is exactly what we like to see" : ""}.`,
    `By our estimate, comparable reach would cost roughly ${euroRange(r.range)} as regular video ads.`,
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
    <div class="sheet-foot"><button class="btn primary" data-close>Done</button></div>`);
  s.querySelectorAll("#theme button").forEach((b) => (b.onclick = () => { prefs.theme = b.dataset.t; savePrefs(); applyTheme(); s.querySelectorAll("#theme button").forEach((x) => x.classList.toggle("on", x === b)); }));
  s.querySelector("#pUsage").onchange = (e) => { prefs.usage = e.target.checked; savePrefs(); toolbarActions(); };
  s.querySelector("#pTech").onchange = (e) => { prefs.tech = e.target.checked; savePrefs(); state.renderedId = null; if (state.data) renderResult(); };
  s.querySelector("#pInvite").onchange = (e) => { try { localStorage.setItem("invite", e.target.value.trim()); } catch { /* ignore */ } };
}

async function showUsage() {
  const s = sheet(`<h2>AI usage</h2><div id="uBody"><div class="skeleton" style="height:160px"></div></div><div class="sheet-foot"><button class="btn primary" data-close>Done</button></div>`);
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
  scrim.innerHTML = `<div class="sheet about">
    <div class="sheet-head"><div style="width:48px;height:48px;flex:none">${LOGO.replace(/id="lg"/, 'id="lg-ab"').replace("url(#lg)", "url(#lg-ab)")}</div><h2>What PlacementRadar does</h2></div>
    <p>Influencers place products in their videos. Brands want to know what that exposure is worth, and viewers have a right to know when it is advertising.
      PlacementRadar answers both from a single YouTube link – and asks a third question: does the recommendation feel genuine?</p>
    <div class="engines">
      <div><span class="ic" style="background:#0a84ff">${icon("cloud")}</span><div><b>Engine 1 · Gemini in the cloud</b><span>watches the whole video with sound: every brand, when and how it appears, spoken and on-screen ad labels, authenticity cues.</span></div></div>
      <div><span class="ic" style="background:#30d158">${icon("chip")}</span><div><b>Engine 2 · AI on your device</b><span>live scanner: a packaging finder (YOLOE), text recognition and barcodes (exact product via Open Food Facts) run in the browser – no cloud needed.</span></div></div>
      <div><span class="ic" style="background:#5e5ce6">${icon("sparkle")}</span><div><b>Engine 3 · our own model</b><span>Apple's MobileCLIP image encoder plus a brand head we trained on 64,000 open product photos (1,020 brands, webcam-ready) – names packages whose text cannot be read, and learns from Gemini's confident answers.</span></div></div>
    </div>
    <p class="small">Media value = equivalent ad cost (earned media value), not what the creator earned: views ÷ 1000 × CPM × weighted seconds ÷ 30, counting only the audience still watching at each moment and an attention factor; shown as a low – high range. The disclosure check refers to § 5a (4) UWG and § 22 MStV; it is a screening aid, not legal advice.
      Details, formulas and all test results: README, MODELS and EVALUATION in the project repository.</p>
    <p class="small muted">Final project · MMI5190E The New Frontiers of AI · Prof. Pin Luarn · Pforzheim University · Moritz Binder</p>
    <div class="sheet-foot"><button class="btn" data-intro>${icon("play")} Show the introduction</button><button class="btn primary" data-close>Got it</button></div></div>`;
  document.body.append(scrim);
  scrim.querySelector("[data-intro]").onclick = () => { scrim.remove(); showIntro(); };
  scrim.onclick = (e) => { if (e.target === scrim || e.target.closest("[data-close]")) scrim.remove(); };
}

boot();
