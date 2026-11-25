/**
 * aiestimate.js — the "AI estimate" section (server: assess.js → POST /api/assess), used in two places:
 *   - Find creators: one section per creator card (creatorsview.js)
 *   - Channel fit:   one section under the rule-based fit card (channelview.js)
 *
 * Design rules:
 *   - visibly APART from the measured, rule-based values: own colour (indigo), own label "AI estimate", the tag
 *     "estimate from titles and description, not watched" and an (i) that says what Gemini read and what it did not;
 *   - never automatic: a placeholder asks the cache first (peek – free, no Gemini) and otherwise shows "Ask Gemini" with
 *     today's budget; one click = one Gemini request (or 0 when someone asked the same before, 7-day cache);
 *   - the estimate is NOT part of the creator score or the channel fit (README → AI estimate, "why apart");
 *   - printed with the report when it was asked for; an empty placeholder is hidden in print.
 *
 * Usage: put `estimateSlot({ channel, brand, product })` into the HTML, then call `mountEstimates(root)`.
 */
import { icon } from "./icons.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const info = (text) => `<span class="info" tabindex="0" role="note" aria-label="${esc(text)}" data-info="${esc(text)}">i</span>`;

const WHAT = "Gemini reads – it does not watch: the channel description, subscribers, titles, views, dates and the first lines of the descriptions of the latest 25 uploads, plus a summary of videos we analysed and comment excerpts we already have. It may not use outside knowledge about the creator. Every sponsor it names must quote its evidence; we check the quote against the data and drop it if it is not there. One Gemini request on a free model the video analysis does not use (3.7 Flash), cached for 7 days. Not part of the creator score or the fit – read it as a second opinion.";
const FIT_TEXT = { high: "Good fit", medium: "Possible fit", low: "Poor fit" };
const FIT_LVL = { high: "green", medium: "orange", low: "red" };
const SAFE_TEXT = { low_risk: "No sensitive topics seen", some_risk: "Some sensitive topics", high_risk: "Sensitive topics", unknown: "Not enough data" };
const SAFE_LVL = { low_risk: "green", some_risk: "orange", high_risk: "red", unknown: "none" };
const KIND_TEXT = { sponsor: "sponsor", affiliate: "affiliate", gifted: "gifted", mentioned: "mentioned" };

/** Placeholder HTML. `channel` = channel id (UC…) or handle; brand/product = what the creator is compared with. */
export function estimateSlot({ channel, brand = "", product = "" }) {
  if (!channel || (!brand && !product)) return "";
  return `<section class="ai-est" data-ch="${esc(channel)}" data-brand="${esc(brand)}" data-product="${esc(product)}">${head()}<div class="ai-body"><span class="spinner"></span></div></section>`;
}

const head = (extra = "") => `<div class="ai-head">${icon("sparkle")}<b>AI estimate</b><span class="ai-tag">estimate from titles and description, not watched</span>${info(WHAT)}${extra}</div>`;

/** Finds every placeholder under `root` and asks the cache (peek) for each – never Gemini. */
export function mountEstimates(root) {
  for (const el of root.querySelectorAll(".ai-est:not([data-mounted])")) { el.dataset.mounted = "1"; load(el, true); }
}

function invite() { try { return new URLSearchParams(location.search).get("invite") || localStorage.getItem("invite") || ""; } catch { return ""; } }

async function load(el, peek) {
  const body = el.querySelector(".ai-body");
  if (!peek) { el.classList.add("busy"); body.innerHTML = `<div class="ai-wait"><span class="spinner"></span><span>Gemini is reading the titles and descriptions … usually 3–10 s</span></div>`; }
  try {
    const r = await fetch("api/assess", { method: "POST", headers: { "content-type": "application/json", "x-invite": invite() },
      body: JSON.stringify({ c: el.dataset.ch, brand: el.dataset.brand, product: el.dataset.product, ...(peek ? { peek: true } : {}) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || j.error || `HTTP ${r.status}`);
    if (j.estimate) draw(el, j); else ask(el, j.quota);
  } catch (e) {
    if (peek) ask(el, null);
    else { ask(el, null); el.querySelector(".ai-body").insertAdjacentHTML("afterbegin", `<p class="ai-err small">${icon("minus")} ${esc(e.message)}</p>`); }
  } finally { el.classList.remove("busy"); }
}

/** Not asked yet: the button with today's budget. */
function ask(el, q) {
  el.classList.add("empty"); el.classList.remove("done");
  const blocked = q?.blocked ? { invite_required: "needs an invite code (Settings)", own_key_required: "switched off right now", server_key_missing: "no Gemini key on the server" }[q.blocked] || q.blocked : null;
  const none = q && (q.visitor_left <= 0 || q.left_requests <= 0);
  const what = [el.dataset.product, el.dataset.brand].filter(Boolean).join(" · ");
  el.querySelector(".ai-body").innerHTML = `<div class="ai-ask">
    <p class="small muted">A general opinion on whether this creator suits <b>${esc(what)}</b> – audience, tone, brand safety, earlier partners – from text only.</p>
    <button class="btn ai-btn" ${blocked || none ? "disabled" : ""}>${icon("sparkle")} <span>Ask Gemini</span></button>
    <span class="ai-quota small muted">${q ? `1 request · you have <b class="num">${q.visitor_left}</b> of ${q.visitor_cap} left today · ~${q.left_requests} free requests left on this model today` : "1 request"}${blocked ? ` · ${esc(blocked)}` : ""}</span></div>`;
  el.querySelector(".ai-btn").onclick = () => load(el, false);
}

function draw(el, d) {
  el.classList.remove("empty"); el.classList.add("done");
  const e = d.estimate || {}; const a = e.audience || {}; const t = e.tone || {}; const s = e.brand_safety || {}; const f = e.fit || {};
  const when = String(d.created_at || "").slice(0, 10);
  const inp = d.input || {};
  const basis = `Read: ${inp.uploads ?? "?"} upload titles (${inp.with_description ?? 0} with description start)${inp.channel_description ? ", channel description" : ""}${inp.analysed ? `, ${inp.analysed} analysed video${inp.analysed === 1 ? "" : "s"}` : ""}${inp.comments ? `, ${inp.comments} comment excerpts` : ""}.`;
  const dropped = d.checks?.dropped_partners ? ` · ${d.checks.dropped_partners} partner${d.checks.dropped_partners === 1 ? "" : "s"} removed (quote not in the data: ${esc((d.checks.dropped || []).join(", "))})` : "";
  el.querySelector(".ai-head").outerHTML = head(`<span class="pill ai-pill lvl-${FIT_LVL[f.level] || "none"}"><span class="dot"></span>${esc(FIT_TEXT[f.level] || "Unknown")}</span>`);
  el.querySelector(".ai-body").innerHTML = `
    <div class="ai-grid">
      <div class="ai-fit"><span class="ai-k">Why ${info("Gemini's reasons, meant to point to the data it read (e.g. how many titles are about the topic). Check them against the titles – this is an opinion, not a measurement.")}</span>
        <ul>${(f.reasons || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        <span class="ai-k">Main risk</span><p>${esc(f.risk || "–")}</p>
        <span class="ai-k">Suggested format</span><p>${esc(f.format || "–")}</p></div>
      <div class="ai-side">
        <div><span class="ai-k">Audience ${info(a.basis || "Inferred from topics, language and wording – no viewer data.")}</span>
          <p><b>${esc(a.age === "unknown" ? "Age unknown" : a.age || "–")}</b> · ${esc([a.language, a.country].filter((x) => x && x !== "unknown").join(", ") || "language/country unknown")}</p>
          ${(a.interests || []).length ? `<div class="ag-chips">${a.interests.slice(0, 5).map((x) => `<span>${esc(x)}</span>`).join("")}</div>` : ""}</div>
        <div><span class="ai-k">Tone ${info(t.basis || "From titles and descriptions.")}</span><p>${esc(t.style || "–")} · credibility <b>${esc(t.credibility || "unknown")}</b></p></div>
        <div><span class="ai-k">Brand safety ${info("Only topics visible in the given titles and descriptions, each with a quote. 'Not enough data' is allowed and honest. No outside knowledge about controversies.")}</span>
          <p><span class="ai-dot lvl-${SAFE_LVL[s.level] || "none"}"></span>${esc(SAFE_TEXT[s.level] || "Unknown")}${s.note ? ` – ${esc(s.note)}` : ""}</p>
          ${(s.topics || []).map((x) => `<p class="small ai-q">${esc(x.topic)}: “${esc(x.evidence)}”${x.verified ? "" : ` <em>(quote not found in the data)</em>`}</p>`).join("")}</div>
        <div><span class="ai-k">Earlier partners ${info("Sponsors, affiliate partners, gifted or merely mentioned brands that a title or description shows – each with its quote. Partners whose quote is not in the data were removed.")}</span>
          ${(e.partners || []).length ? `<div class="ag-chips">${e.partners.slice(0, 8).map((p) => `<span title="${esc(p.evidence)}">${esc(p.brand)} <i>${esc(KIND_TEXT[p.kind] || p.kind)}</i></span>`).join("")}</div>` : `<p class="small muted">none visible in the titles</p>`}</div>
      </div>
    </div>
    <p class="ai-foot small muted">${esc(basis)} ${e.data_note ? `${esc(e.data_note)} ` : ""}${esc(d.model || "")} · ${esc(when)}${d.cached ? " · from the 7-day cache, 0 requests" : ""}${dropped}. Not part of the score.</p>`;
}
