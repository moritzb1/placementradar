/**
 * agentview.js — the brand agent in the browser (route #/agent, server side: agent.js → POST /api/agent).
 *
 * The visitor types a brand. The page streams the agent's steps live (plan → library → search → filter → pick),
 * shows a preliminary report from cached analyses at once, and asks before spending quota: up to 3 new analyses,
 * ticked by hand, with today's Gemini budget next to the button. Confirming sends the same request again with
 * `approve: [ids]` – the search comes from the server's cache, only the approved analyses cost requests.
 *
 * renderBrandReport(summary, …) draws the combined report (printable as PDF like the single-video Brand report).
 * It only needs the output of shared/aggregate.js summarize(), so the planned channel view can reuse it.
 *
 * Nothing about a run is stored on the server besides the analyses themselves; the last report stays in this
 * browser's sessionStorage so "back" from a video returns to it.
 */
import { icon, LOGO } from "./icons.js";
import { euro, euroRange } from "./value.js";
import { mmss } from "./shared/normalize.js";
import { SPREAD } from "./shared/aggregate.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const info = (text) => `<span class="info" tabindex="0" role="note" aria-label="${esc(text)}" data-info="${esc(text)}">i</span>`;
const fmtViews = (n) => n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
const modelName = (m) => String(m || "").replace(/^gemini-/, "Gemini ").replace(/-flash-lite/, " Flash-Lite").replace(/-flash/, " Flash").replace(/-preview/, " (preview)");
const STORE_KEY = "agent:last";
const STAGE_TEXT = { meta: "reading video details", timeline: "Gemini is watching the video", recheck: "re-checking where each product appears", authenticity: "rating authenticity", done: "calculating" };
const SOURCE_LABEL = { demo: "Example", store: "Cached", new: "New" };

let run = null; // { brand, lang, period, steps: Map, order: [], confirm, report, abort }

export function stopAgent() { run?.abort?.abort(); }

/**
 * Route #/agent[?brand=Sonos] – prefill only; a run starts on click (a search costs YouTube quota).
 * `&run=1` (set by the start page's "Brand search" field, i.e. after the visitor's own click) starts it at once.
 */
export function renderAgent(main, { brand = "", run: autorun = false } = {}) {
  let last = null; try { last = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null"); } catch { /* ignore */ }
  const q = brand || last?.brand || "";
  main.innerHTML = `
    <section class="stage-band ag-hero">
      <div class="rings" aria-hidden="true"></div>
      <div class="hero">
        <div class="app-icon">${LOGO.replace(/id="lg"/, 'id="lg-ag"').replace("url(#lg)", "url(#lg-ag)")}</div>
        <h1>Brand agent.</h1>
        <p class="lead">Type a brand. The agent searches YouTube, uses the videos we have already analysed, asks before it spends quota on new ones and puts everything into one report.</p>
        <form class="spotlight ag-form" id="agForm">${icon("search")}
          <input id="agBrand" placeholder="Brand, e.g. Sonos" autocomplete="off" spellcheck="false" aria-label="Brand" value="${esc(q)}" maxlength="60">
          <select id="agLang" class="ag-sel" aria-label="Language"><option value="any">Any language</option><option value="en">English</option><option value="de">German</option></select>
          <select id="agPeriod" class="ag-sel" aria-label="Period"><option value="any">Any time</option><option value="1y">Past year</option><option value="2y">Past 2 years</option><option value="5y">Past 5 years</option></select>
          <button>Run agent</button></form>
        <ol class="steps"><li><b>1</b>Plan and search</li><li><b>2</b>Cached analyses first</li><li><b>3</b>New ones only with your OK</li></ol>
      </div>
    </section>
    <div class="content ag-content">
      <div class="ag-grid">
        <div class="card ag-steps-card" id="agStepsCard" hidden><h3>What the agent does <span class="right num" id="agClock"></span>
          ${info("Every step is shown as it happens. Planning is rule-based (fixed tool chain, budgets and filters derived from your input) – no language model decides what to spend. Searches are cached for a day, analyses forever.")}</h3>
          <ol class="ag-steps" id="agSteps"></ol></div>
        <div id="agConfirm"></div>
      </div>
      <div id="agReport"></div>
    </div>`;
  if (last && (!brand || last.brand.toLowerCase() === brand.toLowerCase())) {
    $("#agLang").value = last.lang || "any"; $("#agPeriod").value = last.period || "any";
    if (last.report) drawReport(last.report, { restored: true });
  }
  $("#agForm").onsubmit = (e) => {
    e.preventDefault();
    const b = $("#agBrand").value.trim();
    if (b.length < 2) { $("#agBrand").focus(); return; }
    start({ brand: b, lang: $("#agLang").value, period: $("#agPeriod").value });
  };
  if (!q) $("#agBrand").focus({ preventScroll: true });
  if (autorun && brand.length >= 2) {
    history.replaceState(null, "", `#/agent?brand=${encodeURIComponent(brand)}`); // a reload must not search again
    start({ brand, lang: $("#agLang").value, period: $("#agPeriod").value });
  }
}

// ------------------------------------------------------------------------------------------------
// one run = one SSE request (first without approval, then optionally again with approve: [ids])
// ------------------------------------------------------------------------------------------------
async function start({ brand, lang, period, approve = null }) {
  stopAgent();
  run = { brand, lang, period, steps: new Map(), order: [], abort: new AbortController(), t0: Date.now(), approve };
  const card = $("#agStepsCard"); if (!card) return;
  card.hidden = false; $("#agSteps").innerHTML = ""; $("#agConfirm").innerHTML = "";
  if (!approve) $("#agReport").innerHTML = "";
  else $("#agReport").classList.add("ag-stale"); // the preliminary report stays visible, dimmed, until the new one arrives
  const btn = $("#agForm button"); btn.disabled = true; btn.textContent = "Running …";
  const mine = run;
  const tick = setInterval(() => { const el = $("#agClock"); if (!el || run !== mine) return clearInterval(tick); el.textContent = mmss((Date.now() - mine.t0) / 1000); }, 1000);
  try {
    let invite = ""; try { invite = new URLSearchParams(location.search).get("invite") || localStorage.getItem("invite") || ""; } catch { /* ignore */ }
    const r = await fetch("api/agent", { method: "POST", signal: run.abort.signal, headers: { "content-type": "application/json", "x-invite": invite },
      body: JSON.stringify({ brand, lang, period, ...(approve ? { approve } : {}) }) });
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
        if (ev === "report") { mine.report = data; drawReport(data); save(mine); }
        if (ev === "error") throw new Error(data.message || data.error);
      }
    }
    if (!mine.report) throw new Error("The connection ended before the report arrived – cached results are kept, try again.");
  } catch (e) {
    if (e.name === "AbortError") return;
    onStep({ id: "error", status: "fail", title: "Stopped", detail: e.message });
  } finally {
    clearInterval(tick);
    if (run === mine) { btn.disabled = false; btn.textContent = "Run agent"; }
  }
}

function save(r) {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ brand: r.brand, lang: r.lang, period: r.period, report: r.report })); } catch { /* quota / private mode */ }
}

function onStep(s) {
  if (!run.steps.has(s.id)) run.order.push(s.id);
  run.steps.set(s.id, { ...run.steps.get(s.id), ...s, sub: s.status === "run" ? run.steps.get(s.id)?.sub : null });
  drawSteps();
}

/** Inner events of an analysis (stage / model / retry) → a sub-line under the "Analysing" step. */
function onProgress({ id, ev, data }) {
  const st = run.steps.get(`analyze:${id}`); if (!st) return;
  if (ev === "stage" && STAGE_TEXT[data.id]) st.sub = STAGE_TEXT[data.id];
  if (ev === "model") st.sub = `${modelName(data.model)} is watching the video`;
  if (ev === "retry") st.sub = `Google is busy – trying the next model`;
  if (ev === "meta" && data.title) st.detail = data.title;
  drawSteps();
}

function drawSteps() {
  const el = $("#agSteps"); if (!el) return;
  el.innerHTML = run.order.map((id) => {
    const s = run.steps.get(id);
    const mark = s.status === "run" ? `<span class="spinner"></span>` : s.status === "done" ? icon("check") : s.status === "fail" ? icon("minus") : `<span class="ag-wait"></span>`;
    return `<li class="ag-step ${s.status}"><span class="ag-mark">${mark}</span><div><b>${esc(s.title)}</b>${s.detail ? `<span>${esc(s.detail)}</span>` : ""}${s.sub ? `<em>${esc(s.sub)} …</em>` : ""}</div><span class="num small muted">${s.at_s != null ? mmss(s.at_s) : ""}</span></li>`;
  }).join("");
}

// ------------------------------------------------------------------------------------------------
// confirm card: pick up to 3 new analyses, see what they cost
// ------------------------------------------------------------------------------------------------
function drawConfirm(c) {
  const host = $("#agConfirm"); if (!host) return;
  const q = c.quota || {};
  const picked = new Set(c.preselected || []);
  const blocked = q.blocked ? { invite_required: "New analyses need an invite code (Settings).", own_key_required: "New analyses are switched off right now.", server_key_missing: "The server has no Gemini key." }[q.blocked] || q.blocked : null;
  const hrs = q.reset_in_s ? Math.max(1, Math.round(q.reset_in_s / 3600)) : null;
  host.innerHTML = `<div class="card ag-confirm">
    <h3>Analyse new videos? ${info(`Each new analysis asks Gemini up to ${c.per_video_requests || 3} times (brands, re-check, authenticity) and takes 2–5 minutes. The free tier allows about ${q.free_per_model || 20} requests per day and model; results are saved for everyone, so a video is never paid for twice.`)}</h3>
    <p class="small muted" style="margin:-6px 0 12px">Not in our cache yet. Ranked by brand in the title, views and recency – tick up to ${c.max_new}.</p>
    <div class="ag-cands">${c.candidates.map((v) => `
      <label class="ag-cand"><input type="checkbox" value="${esc(v.id)}" ${picked.has(v.id) ? "checked" : ""}>
        <img alt="" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg">
        <span><b>${esc(v.title)}</b><small>${esc(v.channel)} · ${fmtViews(v.views)} views · ${mmss(v.duration_s || 0)}${v.published ? ` · ${esc(v.published.slice(0, 7))}` : ""}</small><i>${esc(v.why)}</i></span></label>`).join("")}</div>
    <div class="ag-quota">
      <div><span>Gemini today</span><b class="num">${q.left_requests ?? "?"}</b><i>requests left of ${(q.models || 0) * (q.free_per_model || 20)}${q.exhausted ? ` · ${q.exhausted} model${q.exhausted === 1 ? "" : "s"} used up` : ""}${hrs ? ` · resets in ~${hrs} h` : ""}</i></div>
      <div><span>Your new analyses</span><b class="num">${q.visitor_left ?? "?"}</b><i>of ${q.visitor_cap ?? "?"} left today</i></div>
      <div><span>This step</span><b class="num" id="agCost">–</b><i>Gemini requests at most</i></div>
    </div>
    ${blocked ? `<p class="small ag-blocked">${esc(blocked)}</p>` : ""}
    <div class="row-btns" style="justify-content:flex-start;margin-top:14px">
      <button class="btn primary" id="agGo" ${blocked ? "disabled" : ""}>${icon("play")} <span>Analyse</span></button>
      <button class="btn" id="agSkip">Cached only</button></div></div>`;
  const boxes = [...host.querySelectorAll(".ag-cand input")];
  const sync = () => {
    const n = boxes.filter((b) => b.checked).length;
    boxes.forEach((b) => { b.disabled = !b.checked && n >= c.max_new; b.closest(".ag-cand").classList.toggle("on", b.checked); });
    $("#agCost").textContent = String(n * (c.per_video_requests || 3));
    $("#agGo span").textContent = n ? `Analyse ${n} video${n === 1 ? "" : "s"}` : "Select videos";
    $("#agGo").disabled = !!blocked || !n || n > (q.visitor_left ?? 99);
  };
  boxes.forEach((b) => (b.onchange = sync)); sync();
  $("#agSkip").onclick = () => { host.innerHTML = ""; };
  $("#agGo").onclick = () => {
    const ids = boxes.filter((b) => b.checked).map((b) => b.value);
    if (ids.length) start({ brand: run.brand, lang: run.lang, period: run.period, approve: ids });
  };
}

// ------------------------------------------------------------------------------------------------
// combined report (also usable by other views: only needs summarize() output)
// ------------------------------------------------------------------------------------------------
function drawReport(data, { restored = false } = {}) {
  const host = $("#agReport"); if (!host) return;
  host.classList.remove("ag-stale");
  host.innerHTML = renderBrandReport(data.summary, { plan: data.plan, cost: data.cost, pending: data.pending, restored });
  $("#agPrint")?.addEventListener("click", () => window.print());
  host.querySelector("[data-rerun]")?.addEventListener("click", () => document.getElementById("agForm")?.requestSubmit());
}

const LEVEL_TEXT = { green: "Labelled", orange: "Weak label", red: "Not labelled", none: "No ad signals" };
const pill = (lvl) => `<span class="pill lvl-${lvl}"><span class="dot"></span>${esc(LEVEL_TEXT[lvl] || lvl)}</span>`;
const secs = (r) => (r.high <= 0 ? "0 s" : `${r.low}–${r.high} s`);
const fmtTime = (s) => (s >= 120 ? `${Math.round(s / 60)} min` : `${s} s`);
const secsRange = (r) => (r.high <= 0 ? "0 s" : r.high >= 120 ? `${fmtTime(r.low)} – ${fmtTime(r.high)}` : `${r.low}–${r.high} s`);

/**
 * @param s  summarize() output (shared/aggregate.js)
 * @param o  { plan, cost, pending, restored, title } – all optional; title overrides "<query>"
 */
export function renderBrandReport(s, o = {}) {
  const t = s.totals; const name = o.title || s.query || "All brands";
  const today = new Date().toISOString().slice(0, 10);
  const spreadPct = Math.round(100 * (s.spread ?? SPREAD));
  if (!t.videos) {
    return `<div class="empty-state ag-empty"><b>No analysed video with ${esc(name)} yet.</b><br>${o.pending ? "Tick videos above to analyse them – the report fills in afterwards." : "Try another spelling, a wider period or another language."}</div>`;
  }
  const kpi = (label, value, foot, tip) => `<div><span>${label} ${tip ? info(tip) : ""}</span><b class="num">${value}</b><i>${foot}</i></div>`;
  const disc = [["green", t.labelled], ["orange", t.weak], ["red", t.unlabelled], ["none", t.no_signals]].filter(([, n]) => n);
  const plan = o.plan || {}; const cost = o.cost || {};
  return `
    ${o.pending ? `<div class="ag-note">${icon("clock")}<span>Preliminary: ${t.videos} cached video${t.videos === 1 ? "" : "s"} only. ${o.pending} more candidate${o.pending === 1 ? "" : "s"} above wait${o.pending === 1 ? "s" : ""} for your OK.</span></div>` : ""}
    ${o.restored ? `<div class="ag-note">${icon("clock")}<span>Last report of this session (${esc(String(s.generated_at || "").slice(0, 16).replace("T", " "))} UTC). <button class="linkbtn" data-rerun>Run again</button></span></div>` : ""}
    <div class="report-wrap">
      <article class="report ag-report" id="report">
        <header class="rp-head"><div class="rp-logo">${LOGO.replace(/id="lg"/, 'id="lg-agr"').replace("url(#lg)", "url(#lg-agr)")}<span>PlacementRadar · Brand agent report</span></div><span class="small muted">${today}</span></header>
        <div class="rp-brand"><span class="logo" style="--c:#0a84ff">${esc(name.charAt(0).toUpperCase())}</span><div><h2>${esc(name)}</h2>
          <div class="muted">${t.videos} video${t.videos === 1 ? "" : "s"} by ${s.creators.length} creator${s.creators.length === 1 ? "" : "s"} · ${fmtViews(t.views)} views together</div></div>
          <div class="rp-rank"><b>${t.in_use}</b> of ${t.videos}<br><span class="muted small">shown in use</span></div></div>
        <div class="rp-kpis">
          ${kpi("Equivalent ad cost", euroRange(t.value), `mid ${euro(t.value.mid)} · not the creators' fees`, `Sum over all videos – the same cautious and generous scenarios as in each video's Media value view (CPM, attention, audience drop-off). The range is about as wide as the run-to-run noise of the detection (±${spreadPct} %, test M4).`)}
          ${kpi("On screen", secsRange(t.screen_range), `${fmtTime(t.screen_s)} in one run each`, `Seconds the brand is visible, summed over all videos. Two analyses of the same video agree on only about half of these seconds, so ±${spreadPct} %.`)}
          ${kpi("Mentioned", `${t.mentions}×`, `${t.spoken_s} s in speech`, "How often the brand is named in speech (Gemini listens to the audio).")}
          ${kpi("Ad disclosure", `${t.commercial}<small>/${t.videos}</small>`, `with ad signals · ${t.labelled} labelled${t.weak ? ` · ${t.weak} weak` : ""} · ${t.unlabelled} not`, "Per video: paid or gifted (Gemini), shop/affiliate links in the description, and whether an ad label appears in title, description, image or speech (§ 5a (4) UWG, § 22 MStV – screening aid, not legal advice).")}
        </div>
        <div class="ag-disc">${disc.map(([lvl, n]) => `<div class="lvl-${lvl}" style="flex:${n}"><span class="dot"></span>${n} ${esc(LEVEL_TEXT[lvl])}</div>`).join("")}</div>
        <h4>Videos</h4>
        <table class="rp-table ag-table"><thead><tr><th>Video</th><th>On screen ${info(`One analysis each, shown ±${spreadPct} %.`)}</th><th>Value</th><th>Disclosure</th></tr></thead><tbody>
          ${s.videos.map((v) => `<tr>
            <td><a class="ag-vid" href="#/v/${esc(v.id)}/overview"><img alt="" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg"><span><b>${esc(v.title)}</b><small>${esc(v.channel)} · ${fmtViews(v.views)} views${v.upload_date ? ` · ${esc(String(v.upload_date).replace(/^(\d{4})(\d{2}).*/, "$1-$2").slice(0, 7))}` : ""}${v.source ? ` · <span class="ag-src ${esc(v.source)}">${esc(SOURCE_LABEL[v.source] || v.source)}</span>` : ""}</small>
              <small>${esc([v.brands.join(", "), v.products.slice(0, 3).join(", ")].filter(Boolean).join(" – "))}${v.in_use ? " · in use" : ""}${!v.shown ? " · only mentioned" : v.background_only ? " · background only" : ""}</small></span></a></td>
            <td class="num">${secs(v.screen_range)}${v.mentions ? `<small>${v.mentions}× spoken</small>` : ""}</td>
            <td class="num">${euroRange(v.value_range)}</td>
            <td>${pill(v.disclosure.level)}${v.paid ? `<small>paid or gifted</small>` : ""}</td></tr>`).join("")}
        </tbody></table>
        <div class="rp-two">
          <div><h4>Top creators</h4><table class="rp-table ag-mini"><tbody>${s.creators.slice(0, 6).map((c) => `<tr><td><b>${esc(c.channel)}</b><small>${c.videos} video${c.videos === 1 ? "" : "s"} · ${fmtViews(c.views)} views</small></td><td class="num">${euro(c.value_mid)}<small>mid</small></td><td class="num">${c.unlabelled ? `<span class="ag-red">${c.unlabelled} not labelled</span>` : c.labelled ? `${c.labelled} labelled` : "–"}</td></tr>`).join("")}</tbody></table></div>
          <div><h4>Seen next to ${info("Other brands in the same videos – competitors and set pieces. Counted per video.")}</h4>${s.next_to?.length ? `<div class="ag-chips">${s.next_to.slice(0, 12).map((b) => `<span>${esc(b.brand)} <i>${b.videos}</i></span>`).join("")}</div>` : `<p class="small muted">No other brands.</p>`}</div>
        </div>
        <h4>Findings</h4>
        <ul class="ag-findings">${s.findings.map((f) => `<li class="f-${f.kind}"><b>${esc(f.title)}</b><span>${esc(f.text)}</span>${f.videos?.length && f.id !== "spread" ? `<small>${f.videos.slice(0, 4).map((v) => `<a href="#/v/${esc(v.id)}/overview">${esc(v.channel || v.title)}</a>`).join(" · ")}${f.videos.length > 4 ? ` · +${f.videos.length - 4}` : ""}</small>` : ""}</li>`).join("")}</ul>
        <h4>Method</h4>
        <p class="legal">Found by the PlacementRadar brand agent: ${plan.queries ? `YouTube search for ${plan.queries.map((x) => `“${esc(x)}”`).join(" and ")} (${plan.search_source === "data-api" ? "YouTube Data API" : plan.search_source === "youtube-page" ? "YouTube search page" : "search not available – cached analyses only"}), ` : ""}kept: ${esc((plan.rules || []).join(", ") || "videos up to 20 min")}. Each video was analysed once by Gemini from image and audio (cached analyses are reused, new ones only after confirmation).
          A brand counts if its name matches or starts with “${esc(s.query || "")}”, or a product line of it does. Equivalent ad cost = views ÷ 1000 × CPM × weighted seconds ÷ 30 with audience drop-off and an attention factor (Media value view of each video) – not what the creators earned.
          Screen time and value are ranges: two analyses of the same video agree on only about half of the on-screen seconds (EVALUATION.md test M4), so screen time is shown ±${spreadPct} %; the value range is the cautious and generous scenario of each video's Media value view. Disclosure: § 5a (4) UWG, § 22 MStV – a screening aid, not legal advice.
          ${cost.gemini_requests != null ? `This run: ${cost.new_analyses || 0} new analys${cost.new_analyses === 1 ? "is" : "es"} (${cost.gemini_requests || 0} Gemini requests), ${cost.search_units || 0} YouTube quota units${cost.search_cached ? " (search from cache)" : ""}.` : ""}</p>
      </article>
      <aside class="report-side">
        <div class="card"><h3>Report</h3>
          <button class="btn primary" id="agPrint" style="width:100%;justify-content:center">${icon("doc")} Save as PDF</button>
          <p class="small muted" style="margin:8px 0 0">Opens the print dialog – choose "Save as PDF". Click a video to open its full analysis.</p></div>
        ${s.not_found?.length ? `<div class="card"><h3>Without ${esc(name)}</h3><p class="small muted" style="margin:0 0 8px">Analysed, but Gemini found no such brand – left out of the totals.</p>${s.not_found.map((v) => `<a class="small ag-nf" href="#/v/${esc(v.id)}/overview">${esc(v.title)}</a>`).join("")}</div>` : ""}
      </aside>
    </div>`;
}
