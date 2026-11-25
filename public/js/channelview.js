/**
 * channelview.js — "Channel fit" in the browser (route #/channel/<@handle | UC… id>[?brand=Sonos]; server: channel.js).
 *
 * The visitor enters a creator's channel (and optionally their own brand). The page streams the steps live
 * (resolve → uploads → library → audience → confirm), shows the channel report from the analyses we already have
 * and asks before spending quota: up to 3 new analyses of the latest uploads, ticked by hand, with today's Gemini
 * budget. Confirming sends the same request again with `approve: [ids]`.
 *
 * The report shows what the channel is about in placements: recurring brands, product fields, sponsors per month,
 * labelled vs. not labelled, media value per month. The FIT card (shared/fit.js) rates a brand against it – computed
 * here in the browser from the report, so changing the brand costs no request (except one cheap look-up of the
 * brand's product field in our own analyses, GET /api/brandcat).
 *
 * Under the fit card: the "AI estimate" (aiestimate.js) – Gemini's general opinion from titles and descriptions, also
 * when no video is analysed yet; only on a click, never added to the fit score.
 *
 * The last report stays in sessionStorage so "back" from a video returns to it.
 */
import { icon, LOGO } from "./icons.js";
import { euro, euroRange } from "./value.js";
import { mmss } from "./shared/normalize.js";
import { SPREAD } from "./shared/aggregate.js";
import { channelFit, GROUPS, GROUP_LABEL, FIT_WEIGHTS } from "./shared/fit.js";
import { channelModes } from "./creatorsview.js";
import { estimateSlot, mountEstimates } from "./aiestimate.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const info = (text) => `<span class="info" tabindex="0" role="note" aria-label="${esc(text)}" data-info="${esc(text)}">i</span>`;
const fmtViews = (n) => n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
const modelName = (m) => String(m || "").replace(/^gemini-/, "Gemini ").replace(/-flash-lite/, " Flash-Lite").replace(/-flash/, " Flash").replace(/-preview/, " (preview)");
const month = (d) => String(d || "").replace(/^(\d{4})(\d{2}).*/, "$1-$2").slice(0, 7);
const STORE_KEY = "channel:last";
const STAGE_TEXT = { meta: "reading video details", timeline: "Gemini is watching the video", recheck: "re-checking where each product appears", authenticity: "rating authenticity", done: "calculating" };
const LEVEL_TEXT = { green: "Labelled", orange: "Weak label", red: "Not labelled", none: "No ad signals" };
const SOURCE_LABEL = { demo: "Example", store: "Cached", new: "New" };
const GROUP_COLOR = { audio: "#0a84ff", tech: "#5e5ce6", gaming: "#bf5af2", beauty: "#ff375f", health: "#66d4cf", food: "#ff9f0a", sport: "#30d158",
  toys: "#ff6482", home: "#ac8e68", fashion: "#ffd60a", mobility: "#64d2ff", retail: "#8e8e93", other: "#c7c7cc" };

let run = null; // { input, brand, steps, order, report, abort, t0 }
let current = null; // { report, brand, group } – what the fit card shows

export function stopChannel() { run?.abort?.abort(); }

/** Route #/channel[/<channel>][?brand=…]. With a channel in the link the look-up starts at once (it spends no Gemini quota). */
export function renderChannel(main, { channel = "", brand = "" } = {}) {
  let last = null; try { last = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null"); } catch { /* ignore */ }
  const c = channel || last?.input || "";
  const b = brand || (last && (!channel || last.input === channel) ? last.brand : "") || "";
  main.innerHTML = `
    <section class="stage-band ag-hero ch-hero">
      <div class="rings" aria-hidden="true"></div>
      <div class="hero">
        <div class="app-icon">${LOGO.replace(/id="lg"/, 'id="lg-ch"').replace("url(#lg)", "url(#lg-ch)")}</div>
        <h1>Channel fit.</h1>
        <p class="lead">Enter a creator's channel. See which brands keep coming back, who sponsors when and whether ads are labelled – and how well your brand would fit.</p>
        ${channelModes("check")}
        <form class="spotlight ag-form ch-form" id="chForm">${icon("search")}
          <input id="chInput" placeholder="@handle, channel or video link" autocomplete="off" spellcheck="false" aria-label="Channel" value="${esc(c)}" maxlength="200">
          <input id="chBrand" class="ch-brand" placeholder="Your brand (optional)" autocomplete="off" spellcheck="false" aria-label="Your brand" value="${esc(b)}" maxlength="60">
          <button>Check channel</button></form>
        <ol class="steps"><li><b>1</b>Latest uploads</li><li><b>2</b>Analysed videos first</li><li><b>3</b>Fit for your brand</li></ol>
      </div>
    </section>
    <div class="content ag-content">
      <div class="ag-grid">
        <div class="card ag-steps-card" id="chStepsCard" hidden><h3>What happens <span class="right num" id="chClock"></span>
          ${info("Every step is shown as it happens. The channel and its uploads come from YouTube (cached 6 h), analyses and comments only from our cache. New analyses need your OK.")}</h3>
          <ol class="ag-steps" id="chSteps"></ol></div>
        <div id="chConfirm"></div>
      </div>
      <div id="chReport"></div>
    </div>`;
  if (last?.report && (!channel || last.input === channel)) drawReport(last.report, { restored: true, brand: b });
  $("#chForm").onsubmit = (e) => {
    e.preventDefault();
    const input = $("#chInput").value.trim(); const br = $("#chBrand").value.trim();
    if (input.length < 2) { $("#chInput").focus(); return; }
    // same channel already on screen and only the brand changed → recompute the fit, no request
    if (current?.report && last?.input === input && $("#chReport").innerHTML && !run) { updateFit(br); return; }
    const want = `#/channel/${encodeURIComponent(input)}${br ? `?brand=${encodeURIComponent(br)}` : ""}`;
    if (location.hash !== want) history.replaceState(null, "", want);
    start({ input, brand: br });
  };
  if (channel && !(last?.report && last.input === channel)) start({ input: channel, brand: b });
  else if (!c) $("#chInput").focus({ preventScroll: true });
}

// ------------------------------------------------------------------------------------------------
// one run = one SSE request (first without approval, then optionally again with approve: [ids])
// ------------------------------------------------------------------------------------------------
async function start({ input, brand, approve = null }) {
  stopChannel();
  run = { input, brand, steps: new Map(), order: [], abort: new AbortController(), t0: Date.now(), approve };
  const card = $("#chStepsCard"); if (!card) return;
  card.hidden = false; $("#chSteps").innerHTML = ""; $("#chConfirm").innerHTML = "";
  if (!approve) $("#chReport").innerHTML = ""; else $("#chReport").classList.add("ag-stale");
  const btn = $("#chForm button"); btn.disabled = true; btn.textContent = "Checking …";
  const mine = run;
  const tick = setInterval(() => { const el = $("#chClock"); if (!el || run !== mine) return clearInterval(tick); el.textContent = mmss((Date.now() - mine.t0) / 1000); }, 1000);
  try {
    let invite = ""; try { invite = new URLSearchParams(location.search).get("invite") || localStorage.getItem("invite") || ""; } catch { /* ignore */ }
    const r = await fetch("api/channel", { method: "POST", signal: run.abort.signal, headers: { "content-type": "application/json", "x-invite": invite },
      body: JSON.stringify({ c: input, ...(approve ? { approve } : {}) }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || j.error || `HTTP ${r.status}`); }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (.+)/.exec(chunk)?.[1]; let data = {}; try { data = JSON.parse(/data: (.+)/s.exec(chunk)?.[1] || "{}"); } catch { /* ignore */ }
        if (run !== mine) return;
        if (ev === "step") onStep(data);
        if (ev === "progress") onProgress(data);
        if (ev === "confirm") drawConfirm(data);
        if (ev === "report") { mine.report = data; drawReport(data, { brand: mine.brand }); save(mine); }
        if (ev === "error") throw new Error(data.message || data.error);
      }
    }
    if (!mine.report) throw new Error("The connection ended before the report arrived – try again.");
  } catch (e) {
    if (e.name === "AbortError") return;
    onStep({ id: "error", status: "fail", title: "Stopped", detail: e.message });
  } finally {
    clearInterval(tick);
    if (run === mine) { btn.disabled = false; btn.textContent = "Check channel"; run = null; }
  }
}

function save(r) {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ input: r.input, brand: $("#chBrand")?.value.trim() || r.brand, report: r.report })); } catch { /* quota / private mode */ }
}

function onStep(s) {
  if (!run) return;
  if (!run.steps.has(s.id)) run.order.push(s.id);
  run.steps.set(s.id, { ...run.steps.get(s.id), ...s, sub: s.status === "run" ? run.steps.get(s.id)?.sub : null });
  drawSteps();
}

function onProgress({ id, ev, data }) {
  const st = run?.steps.get(`analyze:${id}`); if (!st) return;
  if (ev === "stage" && STAGE_TEXT[data.id]) st.sub = STAGE_TEXT[data.id];
  if (ev === "model") st.sub = `${modelName(data.model)} is watching the video`;
  if (ev === "retry") st.sub = "Google is busy – trying the next model";
  drawSteps();
}

function drawSteps() {
  const el = $("#chSteps"); if (!el || !run) return;
  el.innerHTML = run.order.map((id) => {
    const s = run.steps.get(id);
    const mark = s.status === "run" ? `<span class="spinner"></span>` : s.status === "done" ? icon("check") : s.status === "fail" ? icon("minus") : `<span class="ag-wait"></span>`;
    return `<li class="ag-step ${s.status}"><span class="ag-mark">${mark}</span><div><b>${esc(s.title)}</b>${s.detail ? `<span>${esc(s.detail)}</span>` : ""}${s.sub ? `<em>${esc(s.sub)} …</em>` : ""}</div><span class="num small muted">${s.at_s != null ? mmss(s.at_s) : ""}</span></li>`;
  }).join("");
}

// ------------------------------------------------------------------------------------------------
// confirm card: pick up to 3 uploads to analyse, see what they cost (same layout as the brand agent)
// ------------------------------------------------------------------------------------------------
function drawConfirm(c) {
  const host = $("#chConfirm"); if (!host) return;
  const q = c.quota || {}; const picked = new Set(c.preselected || []);
  const blocked = q.blocked ? { invite_required: "New analyses need an invite code (Settings).", own_key_required: "New analyses are switched off right now.", server_key_missing: "The server has no Gemini key." }[q.blocked] || q.blocked : null;
  const hrs = q.reset_in_s ? Math.max(1, Math.round(q.reset_in_s / 3600)) : null;
  host.innerHTML = `<div class="card ag-confirm">
    <h3>Analyse more uploads? ${info(`Each new analysis asks Gemini up to ${c.per_video_requests || 3} times (brands, re-check, authenticity) and takes 2–5 minutes. The free tier allows about ${q.free_per_model || 20} requests per day and model; results are saved for everyone.`)}</h3>
    <p class="small muted" style="margin:-6px 0 12px">Latest uploads we have not analysed. Ad hints in the description first – tick up to ${c.max_new}. More analysed videos make the fit more reliable.</p>
    <div class="ag-cands">${c.candidates.map((v) => `
      <label class="ag-cand"><input type="checkbox" value="${esc(v.id)}" ${picked.has(v.id) ? "checked" : ""}>
        <img alt="" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg">
        <span><b>${esc(v.title)}</b><small>${fmtViews(v.views)} views · ${mmss(v.duration_s || 0)}${v.published ? ` · ${v.approx ? "≈ " : ""}${esc(v.published)}` : ""}</small><i>${esc(v.why)}</i></span></label>`).join("")}</div>
    <div class="ag-quota">
      <div><span>Gemini today</span><b class="num">${q.left_requests ?? "?"}</b><i>requests left of ${(q.models || 0) * (q.free_per_model || 20)}${q.exhausted ? ` · ${q.exhausted} model${q.exhausted === 1 ? "" : "s"} used up` : ""}${hrs ? ` · resets in ~${hrs} h` : ""}</i></div>
      <div><span>Your new analyses</span><b class="num">${q.visitor_left ?? "?"}</b><i>of ${q.visitor_cap ?? "?"} left today</i></div>
      <div><span>This step</span><b class="num" id="chCost">–</b><i>Gemini requests at most</i></div>
    </div>
    ${blocked ? `<p class="small ag-blocked">${esc(blocked)}</p>` : ""}
    <div class="row-btns" style="justify-content:flex-start;margin-top:14px">
      <button class="btn primary" id="chGo" ${blocked ? "disabled" : ""}>${icon("play")} <span>Analyse</span></button>
      <button class="btn" id="chSkip">Analysed only</button></div></div>`;
  const boxes = [...host.querySelectorAll(".ag-cand input")];
  const sync = () => {
    const n = boxes.filter((b) => b.checked).length;
    boxes.forEach((b) => { b.disabled = !b.checked && n >= c.max_new; b.closest(".ag-cand").classList.toggle("on", b.checked); });
    $("#chCost").textContent = String(n * (c.per_video_requests || 3));
    $("#chGo span").textContent = n ? `Analyse ${n} video${n === 1 ? "" : "s"}` : "Select videos";
    $("#chGo").disabled = !!blocked || !n || n > (q.visitor_left ?? 99);
  };
  boxes.forEach((b) => (b.onchange = sync)); sync();
  $("#chSkip").onclick = () => { host.innerHTML = ""; };
  $("#chGo").onclick = () => {
    const ids = boxes.filter((b) => b.checked).map((b) => b.value);
    if (ids.length && run === null) start({ input: $("#chInput").value.trim(), brand: $("#chBrand").value.trim(), approve: ids });
  };
}

// ------------------------------------------------------------------------------------------------
// report
// ------------------------------------------------------------------------------------------------
function drawReport(data, { restored = false, brand = "" } = {}) {
  const host = $("#chReport"); if (!host) return;
  host.classList.remove("ag-stale");
  current = { report: data, brand: "", group: null };
  host.innerHTML = renderChannelReport(data, { restored });
  $("#chPrint")?.addEventListener("click", () => window.print());
  host.querySelector("[data-rerun]")?.addEventListener("click", () => $("#chForm")?.requestSubmit());
  updateFit(brand);
}

const pill = (lvl) => `<span class="pill lvl-${lvl}"><span class="dot"></span>${esc(LEVEL_TEXT[lvl] || lvl)}</span>`;
const fmtTime = (s) => (s >= 120 ? `${Math.round(s / 60)} min` : `${s} s`);
const secsRange = (r) => (r.high <= 0 ? "0 s" : r.high >= 120 ? `${fmtTime(r.low)} – ${fmtTime(r.high)}` : `${r.low}–${r.high} s`);

export function renderChannelReport(d, o = {}) {
  const s = d.summary; const t = s.totals; const ch = d.channel || {};
  const today = new Date().toISOString().slice(0, 10);
  const spreadPct = Math.round(100 * (s.spread ?? SPREAD));
  const latest = (d.uploads || []).length; const inLatest = (d.uploads || []).filter((u) => u.analysed).length;
  const recurring = (s.brands || []).filter((b) => b.videos >= 2);
  const kpi = (label, value, foot, tip) => `<div><span>${label} ${tip ? info(tip) : ""}</span><b class="num">${value}</b><i>${foot}</i></div>`;
  const disc = [["green", t.labelled], ["orange", t.weak], ["red", t.unlabelled], ["none", t.no_signals]].filter(([, n]) => n);
  const head = `<header class="rp-head"><div class="rp-logo">${LOGO.replace(/id="lg"/, 'id="lg-chr"').replace("url(#lg)", "url(#lg-chr)")}<span>PlacementRadar · Channel report</span></div><span class="small muted">${today}</span></header>
    <div class="rp-brand ch-head">${ch.avatar ? `<img class="ch-avatar" alt="" src="${esc(ch.avatar)}" referrerpolicy="no-referrer">` : `<span class="logo" style="--c:#0a84ff">${esc((ch.title || "?").charAt(0))}</span>`}
      <div><h2>${esc(ch.title || "Channel")}</h2><div class="muted">${esc([ch.handle, ch.subscribers].filter(Boolean).join(" · "))}${ch.handle || ch.subscribers ? " · " : ""}<a href="https://www.youtube.com/${ch.handle ? esc(ch.handle) : `channel/${esc(ch.id)}`}" target="_blank" rel="noopener">YouTube</a></div></div>
      <div class="rp-rank"><b>${t.videos}</b> analysed<br><span class="muted small">${inLatest} of the latest ${latest}</span></div></div>`;
  const notes = `${d.pending ? `<div class="ag-note">${icon("clock")}<span>${t.videos ? `Based on ${t.videos} analysed video${t.videos === 1 ? "" : "s"}.` : "No analysed video yet."} ${d.pending} upload${d.pending === 1 ? "" : "s"} above can be analysed with your OK.</span></div>` : ""}
    ${o.restored ? `<div class="ag-note">${icon("clock")}<span>Last report of this session (${esc(String(s.generated_at || "").slice(0, 16).replace("T", " "))} UTC). <button class="linkbtn" data-rerun>Check again</button></span></div>` : ""}`;

  if (!t.videos) {
    return `${notes}<div class="report-wrap"><article class="report ch-report" id="report">${head}
      <div class="empty-state ag-empty"><b>None of ${esc(ch.title || "this channel")}'s videos is analysed yet.</b><br>Tick a few uploads above – recurring brands, sponsors and the fit appear once at least one video is analysed. Three or more make the fit reliable.</div>
      <div id="chFit"></div><div id="chEst"></div>${uploadsStrip(d)}</article></div>`;
  }

  return `${notes}
    <div class="report-wrap">
      <article class="report ag-report ch-report" id="report">
        ${head}
        ${t.videos < 3 ? `<div class="ch-thin">${icon("flag")}<span><b>Only ${t.videos} analysed video${t.videos === 1 ? "" : "s"}.</b> Everything below describes ${t.videos === 1 ? "this one video" : "these videos"}, not the channel as a whole. Analyse more uploads for a reliable picture.</span></div>` : ""}
        <div id="chFit"></div>
        <div id="chEst"></div>
        <div class="rp-kpis">
          ${kpi("Recurring brands", `${recurring.length}<small>/${(s.brands || []).length}</small>`, recurring.length ? `in 2 or more videos: ${recurring.slice(0, 3).map((b) => b.brand).join(", ")}` : "no brand in more than one video", "Brands Gemini found in at least two analysed videos of this channel. Counted per video, not per appearance.")}
          ${kpi("Ad disclosure", `${t.commercial}<small>/${t.videos}</small>`, `with ad signals · ${t.labelled} labelled${t.weak ? ` · ${t.weak} weak` : ""} · ${t.unlabelled} not`, "Per video: paid or gifted (Gemini), shop/affiliate links in the description, and whether an ad label appears in title, description, image or speech (§ 5a (4) UWG, § 22 MStV – screening aid, not legal advice).")}
          ${kpi("Equivalent ad cost", euroRange(t.value), `all brands · mid ${euro(t.value.mid)}`, `What the brand exposure in the analysed videos would cost as advertising – sum of each video's Media value view (cautious to generous scenario). Not what the creator earned. The range is about as wide as the detection noise (±${spreadPct} %, test M4).`)}
          ${kpi("Brands on screen", secsRange(t.screen_range), `${fmtTime(t.screen_s)} in one run each`, `Seconds any brand is visible, summed over the analysed videos, ±${spreadPct} % (test M4).`)}
        </div>
        <div class="ag-disc">${disc.map(([lvl, n]) => `<div class="lvl-${lvl}" style="flex:${n}"><span class="dot"></span>${n} ${esc(LEVEL_TEXT[lvl])}</div>`).join("")}</div>
        <div class="rp-two">
          <div><h4>Product fields ${info("Each brand placement (brand × video) is sorted into a coarse field by Gemini's category text (shared/fit.js, keyword list). Shows what the channel's audience is used to seeing.")}</h4>${groupBars(d.groups || [])}</div>
          <div><h4>Recurring brands ${info("All brands of the analysed videos, most frequent first. The number = in how many videos.")}</h4>${(s.brands || []).length ? `<div class="ag-chips">${s.brands.slice(0, 18).map((b) => `<span class="${b.videos >= 2 ? "ch-rec" : ""}">${esc(b.brand)} <i>${b.videos}</i></span>`).join("")}</div>` : `<p class="small muted">No brands.</p>`}</div>
        </div>
        <h4>Over time ${info("Per month of upload: media value range of all brands (cautious to generous), who the commercial partners were (paid or gifted per Gemini, or linked with a shop/affiliate link) and the disclosure verdicts. Only analysed videos count.")}</h4>
        ${monthTable(s.months || [])}
        <h4>Analysed videos</h4>
        <table class="rp-table ag-table"><thead><tr><th>Video</th><th>Brands</th><th>Value</th><th>Disclosure</th></tr></thead><tbody>
          ${s.videos.map((v) => `<tr>
            <td><a class="ag-vid" href="#/v/${esc(v.id)}/overview"><img alt="" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg"><span><b>${esc(v.title)}</b><small>${fmtViews(v.views)} views${v.upload_date ? ` · ${esc(month(v.upload_date))}` : ""}${v.source ? ` · <span class="ag-src ${esc(v.source)}">${esc(SOURCE_LABEL[v.source] || v.source)}</span>` : ""}</small></span></a></td>
            <td class="num">${v.brands.length}<small>${esc(v.brands.slice(0, 3).join(", "))}${v.brands.length > 3 ? " …" : ""}</small></td>
            <td class="num">${euroRange(v.value_range)}</td>
            <td>${pill(v.disclosure.level)}${v.paid ? `<small>paid or gifted</small>` : ""}</td></tr>`).join("")}
        </tbody></table>
        ${uploadsStrip(d)}
        <h4>Findings</h4>
        <ul class="ag-findings">${s.findings.filter((f) => !["next_to", "not_found", "organic"].includes(f.id)).map((f) => `<li class="f-${f.kind}"><b>${esc(f.title)}</b><span>${esc(f.text.replace("the brands appears", "Brands appear"))}</span>${f.videos?.length && f.id !== "spread" ? `<small>${f.videos.slice(0, 4).map((v) => `<a href="#/v/${esc(v.id)}/overview">${esc(v.title)}</a>`).join(" · ")}${f.videos.length > 4 ? ` · +${f.videos.length - 4}` : ""}</small>` : ""}</li>`).join("")}</ul>
        <h4>Method</h4>
        <p class="legal">Channel and latest ${latest} uploads from ${ch.source === "data-api" ? "the YouTube Data API" : "the channel's YouTube page and RSS feed"} (${esc(String(ch.fetched_at || "").slice(0, 10))}, cached 6 h). Analysed videos: every analysis PlacementRadar already has of this channel (also older than the latest uploads) plus the ones you approved – each watched once by Gemini from image and audio.
          Equivalent ad cost = views ÷ 1000 × CPM × weighted seconds ÷ 30 with audience drop-off and an attention factor (Media value view of each video) – not the creator's fee. Screen time and value are ranges (±${spreadPct} %, EVALUATION.md test M4).
          Fit: rule-based (shared/fit.js) – category match ${FIT_WEIGHTS.category} %, room next to competitors ${FIT_WEIGHTS.competition} %, labels its ads ${FIT_WEIGHTS.disclosure} %, audience reaction ${FIT_WEIGHTS.audience} % (only comments already cached); parts without data are left out; the total is scaled by 0.5 + 0.5 × category match. Disclosure: § 5a (4) UWG, § 22 MStV – a screening aid, not legal advice.
          ${d.cost ? `This check: ${d.cost.units || 0} YouTube quota units${d.cost.cached ? " (channel from cache)" : ""}, ${d.cost.new_analyses || 0} new analys${d.cost.new_analyses === 1 ? "is" : "es"} (${d.cost.gemini_requests || 0} Gemini requests).` : ""}</p>
      </article>
      <aside class="report-side">
        <div class="card"><h3>Report</h3>
          <button class="btn primary" id="chPrint" style="width:100%;justify-content:center">${icon("doc")} Save as PDF</button>
          <p class="small muted" style="margin:8px 0 0">Opens the print dialog – choose "Save as PDF". Click a video to open its full analysis.</p></div>
      </aside>
    </div>`;
}

function groupBars(groups) {
  if (!groups.length) return `<p class="small muted">No brand placements.</p>`;
  return `<div class="ch-groups">${groups.slice(0, 7).map((g) => `<div class="ch-group"><span>${esc(g.label)}</span><i><b style="width:${Math.max(3, Math.round(100 * g.share))}%;background:${GROUP_COLOR[g.group] || "#8e8e93"}"></b></i><em class="num">${Math.round(100 * g.share)} %</em><small>${esc(g.brands.slice(0, 4).join(", "))}</small></div>`).join("")}</div>`;
}

/** One row per month: value range as a band (low … high, tick = mid), partners as chips, disclosure counts. */
function monthTable(months) {
  if (!months.length) return `<p class="small muted">No dates.</p>`;
  const max = Math.max(...months.map((m) => m.value_high || m.value_mid || 0), 1);
  return `<div class="ch-months">${months.map((m) => {
    const lo = 100 * (m.value_low || 0) / max, hi = 100 * (m.value_high || m.value_mid || 0) / max, mid = 100 * (m.value_mid || 0) / max;
    const sp = m.sponsors || [];
    return `<div class="ch-month"><b class="num">${esc(m.month)}</b><span class="small muted">${m.videos} video${m.videos === 1 ? "" : "s"}</span>
      <div class="ch-band" title="${esc(euroRange({ low: m.value_low || 0, high: m.value_high || 0 }))}"><i style="left:${lo}%;width:${Math.max(1, hi - lo)}%"></i><u style="left:${mid}%"></u></div>
      <span class="num small">${euroRange({ low: m.value_low || 0, high: m.value_high || 0 })}</span>
      <div class="ch-sp">${sp.length ? sp.slice(0, 6).map((x) => `<span class="${x.kind}">${esc(x.brand)}</span>`).join("") + (sp.length > 6 ? `<span class="more">+${sp.length - 6}</span>` : "") : `<span class="none">no paid or linked brand</span>`}</div>
      <span class="small">${m.unlabelled ? `<span class="ag-red">${m.unlabelled} not labelled</span>` : m.labelled ? `${m.labelled} labelled` : ""}</span></div>`;
  }).join("")}<div class="ch-legend small muted"><span class="paid">paid or gifted</span><span class="affiliate">shop / affiliate link</span></div></div>`;
}

function uploadsStrip(d) {
  const ups = d.uploads || []; if (!ups.length) return "";
  return `<h4>Latest uploads ${info("The newest videos of the channel (Shorts and live streams left out). Analysed ones open the full analysis; the others can be analysed with your OK in the card above.")}</h4>
    <div class="ch-uploads">${ups.map((u) => `<a class="ch-up ${u.analysed ? "on" : ""}" ${u.analysed ? `href="#/v/${esc(u.id)}/overview"` : `href="https://www.youtube.com/watch?v=${esc(u.id)}" target="_blank" rel="noopener"`} title="${esc(u.title)}">
      <img alt="" loading="lazy" src="https://i.ytimg.com/vi/${esc(u.id)}/mqdefault.jpg"><span>${esc(u.title)}</span><small>${u.approx ? "≈ " : ""}${esc(u.published || "")}${u.analysed ? ` · ${esc(SOURCE_LABEL[u.analysed] || "Analysed")}` : ""}</small></a>`).join("")}</div>`;
}

// ------------------------------------------------------------------------------------------------
// fit card (computed in the browser from the report)
// ------------------------------------------------------------------------------------------------
async function updateFit(brand, group = null) {
  const host = $("#chFit"); if (!host || !current?.report) return;
  const d = current.report;
  brand = String(brand || "").trim();
  drawEstimate(brand);
  if ($("#chBrand") && brand && $("#chBrand").value.trim() !== brand) $("#chBrand").value = brand;
  if (!brand) {
    host.innerHTML = `<div class="ch-fit ch-fit-empty">${icon("sparkle")}<span><b>How well would your brand fit?</b> Type it in the second field above and press Check channel – the fit is calculated from this report, no new request.</span></div>`;
    return;
  }
  current.brand = brand;
  // the brand's product field: from this channel → from our own analyses (/api/brandcat) → visitor's choice
  let source = "picked";
  if (!group) {
    const fromChannel = channelFit({ placements: d.placements, videos: d.summary.totals.videos, audience: d.audience }, brand).group;
    if (fromChannel) { group = fromChannel; source = "channel"; }
    else {
      host.innerHTML = `<div class="ch-fit ch-fit-empty"><span class="spinner"></span><span>Looking up ${esc(brand)} in our analyses …</span></div>`;
      try { const j = await (await fetch(`api/brandcat?b=${encodeURIComponent(brand)}`)).json(); if (j.group) { group = j.group; source = `library:${j.seen}`; } } catch { /* offline */ }
      if (current?.brand !== brand) return; // the visitor typed another brand meanwhile
    }
  }
  current.group = group;
  const f = channelFit({ placements: d.placements, videos: d.summary.totals.videos, audience: d.audience }, brand, { group });
  host.innerHTML = renderFit(f, source);
  host.querySelector("#chGroup")?.addEventListener("change", (e) => updateFit(brand, e.target.value || null));
  try { const last = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null"); if (last) { last.brand = brand; sessionStorage.setItem(STORE_KEY, JSON.stringify(last)); } } catch { /* ignore */ }
}

/** AI estimate for the current channel + brand (placeholder; the cache is asked, Gemini only on a click). */
function drawEstimate(brand) {
  const host = $("#chEst"); const ch = current?.report?.channel; if (!host || !ch?.id) return;
  if (host.dataset.key === `${ch.id}|${brand}`) return; // same channel and brand → keep what is shown
  host.dataset.key = `${ch.id}|${brand}`;
  host.innerHTML = estimateSlot({ channel: ch.id, brand });
  mountEstimates(host);
}

function renderFit(f, source) {
  const sel = `<select id="chGroup" class="ch-sel" aria-label="Product field of the brand"><option value="">Choose the field …</option>${GROUPS.map((g) => `<option value="${g.id}" ${f.group === g.id ? "selected" : ""}>${esc(g.label)}</option>`).join("")}</select>`;
  const from = source === "channel" ? "found on this channel" : source.startsWith("library") ? `from ${source.split(":")[1]} placement${source.split(":")[1] === "1" ? "" : "s"} in our other analyses` : "chosen by you";
  const how = `How the score is made: four parts, each 0–100 – category match (${FIT_WEIGHTS.category} %), room next to competitors (${FIT_WEIGHTS.competition} %), labels its ads (${FIT_WEIGHTS.disclosure} %), audience reaction (${FIT_WEIGHTS.audience} %). Parts without data are left out and the weights of the rest are scaled up. The total is then multiplied by 0.5 + 0.5 × category match, so a channel that never shows your field reaches at most 50. Rule-based, no AI model decides – every part shows its own calculation.`;
  if (f.score == null) {
    return `<div class="ch-fit"><div class="ch-fit-top"><div><span class="ch-eyebrow">Fit for ${esc(f.brand)} ${info(how)}</span><h3>${f.videos ? "Product field unknown" : "Not enough data"}</h3>
      <p class="small muted">${esc(f.note || "")}</p></div><div class="ch-fit-field"><span class="small muted">Product field of ${esc(f.brand)}</span>${sel}</div></div></div>`;
  }
  const conf = { good: "good – 6 or more analysed videos", medium: "medium – 3 to 5 analysed videos", low: `low – only ${f.videos} analysed video${f.videos === 1 ? "" : "s"}` }[f.confidence];
  const ring = (v) => `<svg viewBox="0 0 120 120" class="ch-ring"><circle cx="60" cy="60" r="52" class="bg"/><circle cx="60" cy="60" r="52" class="fg" style="stroke-dasharray:${(326.7 * v / 100).toFixed(1)} 326.7"/><text x="60" y="60" dy=".35em" text-anchor="middle">${v}</text></svg>`;
  return `<div class="ch-fit lvl-${f.score >= 70 ? "green" : f.score >= 45 ? "orange" : "red"}">
    <div class="ch-fit-top">${ring(f.score)}
      <div><span class="ch-eyebrow">Fit for ${esc(f.brand)} ${info(how)}</span><h3>${esc(f.verdict)}</h3>
        <p class="small muted">${esc(f.group_label)} (${esc(from)}) · confidence ${esc(conf)}</p>${f.note ? `<p class="small">${esc(f.note)}</p>` : ""}</div>
      <div class="ch-fit-field"><span class="small muted">Product field</span>${sel}</div></div>
    ${f.confidence === "low" ? `<div class="ch-thin">${icon("flag")}<span>Too few analysed videos for a firm judgement – read the score as a first hint.</span></div>` : ""}
    <div class="ch-parts">${f.parts.map((p) => `<div class="ch-part ${p.score == null ? "na" : ""}"><div class="ch-part-h"><b>${esc(p.label)}</b><span class="small muted">${p.weight} %</span>${info(p.text)}<em class="num">${p.score == null ? "no data" : p.score}</em></div>
      <i><b style="width:${p.score ?? 0}%"></b></i><small>${esc(p.text)}</small></div>`).join("")}</div>
    ${f.competitors.length ? `<div class="ch-comp"><span class="small muted">Competitors on this channel</span><div class="ag-chips">${f.competitors.slice(0, 8).map((c) => `<span>${esc(c.brand)} <i>${c.videos}</i></span>`).join("")}</div></div>` : ""}
  </div>`;
}
