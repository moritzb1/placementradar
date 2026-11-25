/**
 * creatorsview.js — "Find creators", the second mode of Channel fit (route #/creators?product=headphones&brand=Sonos;
 * server: creators.js → POST /api/creators).
 *
 * A brand and/or product in, a ranked shortlist of YouTube channels out, each with a short profile: score with its
 * parts (each with an (i) rule), topics, competitors and ad labels (only from analysed videos), the value of one
 * placement, one rule-based sentence "why it fits", example videos and a link to the full Channel fit view with the
 * brand filled in. Like the agent, new analyses (one video of each of the top 3) only after the visitor's OK.
 * Each card also has an "AI estimate" section (aiestimate.js): Gemini's opinion from titles and descriptions, only on a
 * click, shown apart from the score and never added to it. "Save as PDF" prints the shortlist (with estimates asked for). The last shortlist stays in sessionStorage.
 */
import { icon, LOGO } from "./icons.js";
import { euroRange } from "./value.js";
import { mmss } from "./shared/normalize.js";
import { estimateSlot, mountEstimates } from "./aiestimate.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const info = (text) => `<span class="info" tabindex="0" role="note" aria-label="${esc(text)}" data-info="${esc(text)}">i</span>`;
const fmtViews = (n) => n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
const STORE_KEY = "creators:last";
const STAGE_TEXT = { meta: "reading video details", timeline: "Gemini is watching the video", recheck: "re-checking where each product appears", authenticity: "rating authenticity", done: "calculating" };
const WEIGHT_INFO = "Creator score 0–100: topic match 35 %, reach 25 %, activity 15 % (from titles, views and dates of the latest 25 uploads) and – only where we have analysed videos of the channel – labels its ads 15 %, room next to competitors 10 %. Parts without data are left out, the rest scaled up; the total is multiplied by 0.5 + 0.5 × topic match, so a channel that rarely covers the topic stays low however big it is. Rule-based, no AI model decides. The AI estimate below each card is a separate opinion and is not added to the score.";

let run = null;

export function stopCreators() { run?.abort?.abort(); }

/** Segmented switch shared by both Channel fit modes (also used by channelview.js). */
export const channelModes = (on) => `<div class="mode-pick ch-modes" role="tablist" aria-label="Channel fit mode">
  <a role="tab" href="#/channel" class="${on === "check" ? "on" : ""}" aria-selected="${on === "check"}">${icon("chat")}<span>Check a channel</span></a>
  <a role="tab" href="#/creators" class="${on === "find" ? "on" : ""}" aria-selected="${on === "find"}">${icon("search")}<span>Find creators</span></a></div>`;

/** Route #/creators[?product=…&brand=…&lang=…]. With a product or brand in the link the search starts at once. */
export function renderCreators(main, { product = "", brand = "", lang = "any", autorun = false } = {}) {
  let last = null; try { last = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null"); } catch { /* ignore */ }
  const same = last && last.product === product && last.brand === brand;
  const p = product || (!brand ? last?.product || "" : ""), b = brand || (!product ? last?.brand || "" : "");
  main.innerHTML = `
    <section class="stage-band ag-hero ch-hero">
      <div class="rings" aria-hidden="true"></div>
      <div class="hero">
        <div class="app-icon">${LOGO.replace(/id="lg"/, 'id="lg-cr"').replace("url(#lg)", "url(#lg-cr)")}</div>
        <h1>Find creators.</h1>
        <p class="lead">Type your product and brand. PlacementRadar searches YouTube, looks at the channels behind the videos and ranks the creators who fit – each with a short profile.</p>
        ${channelModes("find")}
        <form class="spotlight ag-form ch-form" id="crForm">${icon("search")}
          <input id="crProduct" placeholder="Product, e.g. headphones" autocomplete="off" spellcheck="false" aria-label="Product" value="${esc(p)}" maxlength="60">
          <input id="crBrand" class="ch-brand" placeholder="Brand (optional)" autocomplete="off" spellcheck="false" aria-label="Brand" value="${esc(b)}" maxlength="60">
          <select id="crLang" class="ag-sel" aria-label="Language"><option value="any">Any language</option><option value="en">English</option><option value="de">German</option></select>
          <button>Find</button></form>
        <ol class="steps"><li><b>1</b>Search the topic</li><li><b>2</b>Look at each channel</li><li><b>3</b>Ranked shortlist</li></ol>
      </div>
    </section>
    <div class="content ag-content">
      <div class="ag-grid">
        <div class="card ag-steps-card" id="crStepsCard" hidden><h3>What happens <span class="right num" id="crClock"></span>
          ${info("1–2 YouTube searches about your product (cached for a day), then the latest uploads of up to 8 channels behind the results (cached 6 h). Analyses and comments only from our cache. New analyses need your OK.")}</h3>
          <ol class="ag-steps" id="crSteps"></ol></div>
        <div id="crConfirm"></div>
      </div>
      <div id="crReport"></div>
    </div>`;
  $("#crLang").value = lang !== "any" ? lang : last?.lang || "any";
  if (last?.report && (same || (!product && !brand))) drawReport(last.report, { restored: true });
  $("#crForm").onsubmit = (e) => {
    e.preventDefault();
    const q = { product: $("#crProduct").value.trim(), brand: $("#crBrand").value.trim(), lang: $("#crLang").value };
    if (q.product.length < 2 && q.brand.length < 2) { $("#crProduct").focus(); return; }
    history.replaceState(null, "", `#/creators?${new URLSearchParams(Object.entries(q).filter(([, v]) => v && v !== "any"))}`);
    start(q);
  };
  if (autorun && (product || brand) && !(same && last?.report)) start({ product, brand, lang });
  else if (!p && !b) $("#crProduct").focus({ preventScroll: true });
}

async function start({ product, brand, lang, approve = null }) {
  stopCreators();
  run = { product, brand, lang, steps: new Map(), order: [], abort: new AbortController(), t0: Date.now() };
  const card = $("#crStepsCard"); if (!card) return;
  card.hidden = false; $("#crSteps").innerHTML = ""; $("#crConfirm").innerHTML = "";
  if (!approve) $("#crReport").innerHTML = ""; else $("#crReport").classList.add("ag-stale");
  const btn = $("#crForm button"); btn.disabled = true; btn.textContent = "Searching …";
  const mine = run;
  const tick = setInterval(() => { const el = $("#crClock"); if (!el || run !== mine) return clearInterval(tick); el.textContent = mmss((Date.now() - mine.t0) / 1000); }, 1000);
  try {
    let invite = ""; try { invite = new URLSearchParams(location.search).get("invite") || localStorage.getItem("invite") || ""; } catch { /* ignore */ }
    const r = await fetch("api/creators", { method: "POST", signal: run.abort.signal, headers: { "content-type": "application/json", "x-invite": invite },
      body: JSON.stringify({ product, brand, lang, ...(approve ? { approve } : {}) }) });
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
        if (ev === "report") { mine.report = data; drawReport(data); try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ product, brand, lang, report: data })); } catch { /* full */ } }
        if (ev === "error") throw new Error(data.message || data.error);
      }
    }
    if (!mine.report) throw new Error("The connection ended before the shortlist arrived – try again.");
  } catch (e) {
    if (e.name === "AbortError") return;
    onStep({ id: "error", status: "fail", title: "Stopped", detail: e.message });
  } finally {
    clearInterval(tick);
    if (run === mine) { btn.disabled = false; btn.textContent = "Find"; run = null; }
  }
}

function onStep(s) {
  if (!run) return;
  if (!run.steps.has(s.id)) run.order.push(s.id);
  run.steps.set(s.id, { ...run.steps.get(s.id), ...s, sub: s.status === "run" ? run.steps.get(s.id)?.sub : null });
  const el = $("#crSteps"); if (!el) return;
  el.innerHTML = run.order.map((id) => {
    const x = run.steps.get(id);
    const mark = x.status === "run" ? `<span class="spinner"></span>` : x.status === "done" ? icon("check") : x.status === "fail" ? icon("minus") : `<span class="ag-wait"></span>`;
    return `<li class="ag-step ${x.status}"><span class="ag-mark">${mark}</span><div><b>${esc(x.title)}</b>${x.detail ? `<span>${esc(x.detail)}</span>` : ""}${x.sub ? `<em>${esc(x.sub)} …</em>` : ""}</div><span class="num small muted">${x.at_s != null ? mmss(x.at_s) : ""}</span></li>`;
  }).join("");
}
function onProgress({ id, ev, data }) {
  const st = run?.steps.get(`analyze:${id}`); if (!st) return;
  if (ev === "stage" && STAGE_TEXT[data.id]) st.sub = STAGE_TEXT[data.id];
  if (ev === "retry") st.sub = "Google is busy – trying the next model";
  onStep(st);
}

function drawConfirm(c) {
  const host = $("#crConfirm"); if (!host) return;
  const q = c.quota || {};
  const blocked = q.blocked ? { invite_required: "New analyses need an invite code (Settings).", own_key_required: "New analyses are switched off right now.", server_key_missing: "The server has no Gemini key." }[q.blocked] || q.blocked : null;
  host.innerHTML = `<div class="card ag-confirm">
    <h3>Look deeper at the top 3? ${info(`Analysing one on-topic video of a creator adds two parts to its score: how it labels ads and which competitors it already shows. Each analysis asks Gemini up to ${c.per_video_requests || 3} times and takes 2–5 minutes.`)}</h3>
    <p class="small muted" style="margin:-6px 0 12px">Optional. Without it the scores rest on titles, views and dates only.</p>
    <div class="ag-cands">${c.candidates.map((v) => `
      <label class="ag-cand"><input type="checkbox" value="${esc(v.id)}">
        <img alt="" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg">
        <span><b>${esc(v.title)}</b><small>${esc(v.channel)} · ${fmtViews(v.views)} views · ${mmss(v.duration_s || 0)}</small><i>${esc(v.why)}</i></span></label>`).join("")}</div>
    <div class="ag-quota">
      <div><span>Gemini today</span><b class="num">${q.left_requests ?? "?"}</b><i>requests left of ${(q.models || 0) * (q.free_per_model || 20)}</i></div>
      <div><span>Your new analyses</span><b class="num">${q.visitor_left ?? "?"}</b><i>of ${q.visitor_cap ?? "?"} left today</i></div>
      <div><span>This step</span><b class="num" id="crCost">0</b><i>Gemini requests at most</i></div>
    </div>
    ${blocked ? `<p class="small ag-blocked">${esc(blocked)}</p>` : ""}
    <div class="row-btns" style="justify-content:flex-start;margin-top:14px">
      <button class="btn primary" id="crGo" disabled>${icon("play")} <span>Select videos</span></button>
      <button class="btn" id="crSkip">Not now</button></div></div>`;
  const boxes = [...host.querySelectorAll(".ag-cand input")];
  const sync = () => {
    const n = boxes.filter((b) => b.checked).length;
    boxes.forEach((b) => b.closest(".ag-cand").classList.toggle("on", b.checked));
    $("#crCost").textContent = String(n * (c.per_video_requests || 3));
    $("#crGo span").textContent = n ? `Analyse ${n} video${n === 1 ? "" : "s"}` : "Select videos";
    $("#crGo").disabled = !!blocked || !n || n > (q.visitor_left ?? 99);
  };
  boxes.forEach((b) => (b.onchange = sync));
  $("#crSkip").onclick = () => { host.innerHTML = ""; };
  $("#crGo").onclick = () => {
    const ids = boxes.filter((b) => b.checked).map((b) => b.value);
    if (ids.length && run === null) start({ product: $("#crProduct").value.trim(), brand: $("#crBrand").value.trim(), lang: $("#crLang").value, approve: ids });
  };
}

function drawReport(d, { restored = false } = {}) {
  const host = $("#crReport"); if (!host) return;
  host.classList.remove("ag-stale");
  host.innerHTML = renderShortlist(d, { restored });
  mountEstimates(host); // asks the 7-day cache for each card – never Gemini; "Ask Gemini" is a click per card
  $("#crPrint")?.addEventListener("click", () => window.print());
  host.querySelector("[data-rerun]")?.addEventListener("click", () => $("#crForm")?.requestSubmit());
}

const ring = (v, lvl) => `<svg viewBox="0 0 120 120" class="ch-ring cr-ring"><circle cx="60" cy="60" r="52" class="bg"/><circle cx="60" cy="60" r="52" class="fg" style="stroke-dasharray:${(326.7 * v / 100).toFixed(1)} 326.7"/><text x="60" y="60" dy=".35em" text-anchor="middle">${v}</text></svg>`;
const level = (s) => (s >= 70 ? "green" : s >= 45 ? "orange" : "red");

export function renderShortlist(d, o = {}) {
  const q = d.query || {}; const list = d.shortlist || [];
  const what = [q.product, q.brand ? `for ${q.brand}` : null].filter(Boolean).join(" ") || "–";
  const today = new Date().toISOString().slice(0, 10);
  const target = q.brand || q.product || "";
  if (!list.length) return `<div class="empty-state ag-empty"><b>No creators found for ${esc(what)}.</b><br>Try another word for the product, or English / German.</div>`;
  const analysed = list.filter((c) => c.analysed).length;
  return `${o.restored ? `<div class="ag-note">${icon("clock")}<span>Last shortlist of this session (${esc(String(d.generated_at || "").slice(0, 16).replace("T", " "))} UTC). <button class="linkbtn" data-rerun>Search again</button></span></div>` : ""}
    <div class="report-wrap">
      <article class="report ag-report ch-report cr-report" id="report">
        <header class="rp-head"><div class="rp-logo">${LOGO.replace(/id="lg"/, 'id="lg-crr"').replace("url(#lg)", "url(#lg-crr)")}<span>PlacementRadar · Creator shortlist</span></div><span class="small muted">${today}</span></header>
        <div class="rp-brand"><span class="logo" style="--c:#ff9f0a">${esc(what.charAt(0).toUpperCase())}</span><div><h2>${esc(what)}</h2>
          <div class="muted">${list.length} creators · field ${esc(q.group_label || "topic words only")} (${esc(q.field_from || "")}) · searched ${(q.queries || []).map((x) => `“${esc(x)}”`).join(", ")}</div></div>
          <div class="rp-rank"><b>${analysed}</b> of ${list.length}<br><span class="muted small">with analysed videos</span></div></div>
        ${analysed < list.length ? `<div class="ch-thin">${icon("flag")}<span><b>${analysed ? `${list.length - analysed} of ${list.length}` : "All"} scores rest on metadata only</b> – titles, views and upload dates of the latest 25 videos. How a creator labels ads and which competitors it shows are known only for analysed channels (marked).</span></div>` : ""}
        <h4>Shortlist ${info(WEIGHT_INFO)}</h4>
        <ol class="cr-list">${list.map((c, i) => creatorCard(c, i, target, q)).join("")}</ol>
        <h4>Method</h4>
        <p class="legal">YouTube search for ${(q.queries || []).map((x) => `“${esc(x)}”`).join(" and ")} (${d.cost?.search_units ? `YouTube Data API, ${d.cost.search_units} units` : "YouTube search page or cache, 0 units"}); search hits grouped by channel; the brand's own channel left out; for up to 8 channels the latest 25 uploads (${d.cost?.channel_units ? `${d.cost.channel_units} Data API units` : "channel page + RSS feed or cache, 0 units"}).
          ${esc(WEIGHT_INFO)} Topic = upload titles matching the product words or the field's keyword list. Value of one placement = equivalent ad cost of the product shown 60 s and named once early in a 10-minute video at the channel's median views (cautious to generous scenario, as in each video's Media value view) – not the creator's fee. Disclosure: § 5a (4) UWG, § 22 MStV – a screening aid, not legal advice.
          ${d.cost ? `This search: ${d.cost.new_analyses || 0} new analyses (${d.cost.gemini_requests || 0} Gemini requests).` : ""}</p>
      </article>
      <aside class="report-side">
        <div class="card"><h3>Shortlist</h3>
          <button class="btn primary" id="crPrint" style="width:100%;justify-content:center">${icon("doc")} Save as PDF</button>
          <p class="small muted" style="margin:8px 0 0">Opens the print dialog – choose "Save as PDF". "Channel fit" on a creator opens its full channel report with your brand filled in.</p></div>
      </aside>
    </div>`;
}

function creatorCard(c, i, target, q = {}) {
  const ch = c.channel || {};
  const href = `#/channel/${encodeURIComponent(ch.handle || ch.id)}${target ? `?brand=${encodeURIComponent(target)}` : ""}`;
  return `<li class="cr-card lvl-${level(c.score)}">
    <div class="cr-top"><span class="cr-rank num">${i + 1}</span>
      ${ch.avatar ? `<img class="ch-avatar" alt="" src="${esc(ch.avatar)}" referrerpolicy="no-referrer">` : `<span class="logo" style="--c:#ff9f0a">${esc((ch.title || "?").charAt(0))}</span>`}
      <div class="cr-name"><b>${esc(ch.title)}</b><small>${esc([ch.handle, ch.subscribers].filter(Boolean).join(" · "))}</small>
        <span class="cr-basis ${c.analysed ? "on" : ""}">${esc(c.basis)}</span></div>
      <div class="cr-score">${ring(c.score)}<span>${esc(c.verdict)}</span></div></div>
    <p class="cr-why">${esc(c.why)}.</p>
    <div class="cr-parts">${c.parts.map((p) => `<div class="${p.score == null ? "na" : ""}"><span>${esc(p.label)} ${info(`${p.weight} % · ${p.text}`)}</span><i><b style="width:${p.score ?? 0}%"></b></i><em class="num">${p.score ?? "–"}</em></div>`).join("")}</div>
    <div class="cr-facts">
      <div><span>Topics ${info("Product fields of the latest upload titles (keyword list) – a rough picture of what the channel is about.")}</span>${c.topics.length ? `<div class="ag-chips">${c.topics.map((t) => `<span>${esc(t.label)} <i>${t.uploads}</i></span>`).join("")}</div>` : `<small class="muted">no clear field in the titles</small>`}</div>
      <div><span>Competitors ${info("Brands of the same field in the videos we analysed of this channel.")}</span>${c.analysed ? (c.competitors.length ? `<div class="ag-chips">${c.competitors.map((x) => `<span>${esc(x.brand)} <i>${x.videos}</i></span>`).join("")}</div>` : `<small class="muted">none in the analysed videos</small>`) : `<small class="muted">unknown – not analysed yet</small>`}</div>
      <div><span>One placement ${info("Equivalent ad cost of the product shown 60 s and named once early in a 10-minute video, at this channel's median views. Cautious to generous scenario as in each video's Media value view – not the creator's fee.")}</span><b class="num">${c.value ? euroRange(c.value) : "–"}</b><small class="muted">at ~${fmtViews(c.median_views)} views</small></div>
    </div>
    <div class="cr-foot">${c.examples.length ? `<div class="cr-ex">${c.examples.slice(0, 2).map((v) => `<a href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener"><img alt="" loading="lazy" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg"><span>${esc(v.title)}</span><small>${fmtViews(v.views)} views</small></a>`).join("")}</div>` : ""}
      <a class="btn cr-go" href="${href}">${icon("chat")} Channel fit</a></div>
    ${estimateSlot({ channel: ch.id, brand: q.brand || "", product: q.product || "" })}
  </li>`;
}
