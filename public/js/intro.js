/**
 * intro.js — short introduction on the very first visit (5 steps): what PlacementRadar is (four tools), how it was
 * built (three engines), why it matters, what it brings, where to start (one card per tool).
 *
 * Written for a visitor who did not see the presentation (e.g. the professor opening the link later).
 * Skippable; "Don't show again" is stored in localStorage (guarded: storage may be blocked). It can be opened
 * again any time from the About sheet (the (i) button in the top bar). `?nointro` in the URL suppresses it
 * (screenshots, tests).
 *
 * Layout follows the app's layers (UI_KONZEPT.md): a black stage with an illustration on top, a calm sheet
 * with the text below. Keyboard: ← → to move, Esc to close.
 */
import { icon, LOGO } from "./icons.js";

const KEY = "pr:intro-seen";
const seen = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };
const remember = (v) => { try { v ? localStorage.setItem(KEY, "1") : localStorage.removeItem(KEY); } catch { /* private mode */ } };

const STEPS = [
  {
    eyebrow: "Welcome",
    title: "Every brand in a video.",
    text: `<p>Every brand in picture, speech and on-screen text – when it appears, what it is worth, whether it is labelled. Four tools:</p>
      <span class="intro-tools"><span class="ie"><span class="ic" style="background:#0a84ff">${icon("play")}</span><span><b>YouTube video</b> – every brand in one video.</span></span>
      <span class="ie"><span class="ic" style="background:#30d158">${icon("camera")}</span><span><b>Live camera</b> – a product named on your device.</span></span>
      <span class="ie"><span class="ic" style="background:#5e5ce6">${icon("radar")}</span><span><b>Brand search</b> – a brand in, its videos and one report out.</span></span>
      <span class="ie"><span class="ic" style="background:#ff9f0a">${icon("chat")}</span><span><b>Channel fit</b> – does a creator suit your brand, or which would?</span></span></span>`,
    art: () => `<div class="ia-player"><div class="ia-scene"><span class="ia-head"></span><span class="ia-body"></span><span class="ia-prod"></span></div>
      <div class="tbox ia-box" style="--c:#0a84ff"><span class="tb-label"><i></i><b>Bose QuietComfort Ultra</b><em>logo</em></span></div>
      <div class="ia-tl"><i style="left:6%;width:30%;background:#0a84ff"></i><i style="left:44%;width:12%;background:#ff9f0a"></i><i style="left:62%;width:26%;background:#30d158"></i><b></b></div></div>`,
  },
  {
    eyebrow: "How it was built",
    title: "Three engines that work together.",
    text: `<span class="ie"><span class="ic" style="background:#0a84ff">${icon("cloud")}</span><span><b>Gemini in the cloud</b> watches the whole video with sound and reports every brand with time, model, position and how it was recognised (logo, text, speech, design).</span></span>
      <span class="ie"><span class="ic" style="background:#30d158">${icon("chip")}</span><span><b>Recognition on your device</b>: a packaging finder (YOLOE), text recognition and barcodes → Open Food Facts. Runs in the browser, costs no quota.</span></span>
      <span class="ie"><span class="ic" style="background:#5e5ce6">${icon("sparkle")}</span><span><b>Our own brand model</b>: Apple's MobileCLIP image encoder plus brand heads we trained on 76,000 freely licensed photos – 1,020 brands of food, cosmetics and household goods (97 % of its answers correct in our test) plus 117 tech, fashion, sport, home and car brands (94 %).</span></span>`,
    art: () => `<div class="ia-engines">${[["cloud", "#0a84ff", "Cloud"], ["chip", "#30d158", "On device"], ["sparkle", "#5e5ce6", "Own model"]]
      .map(([i, c, l], k) => `<div style="--d:${k * 0.25}s"><span style="background:${c}">${icon(i)}</span><small>${l}</small></div>`).join('<em></em>')}</div>`,
  },
  {
    eyebrow: "Why",
    title: "Product placement is money – and often not labelled.",
    text: `<p><b>Brands</b> want to know what a creator's video is worth to them, even when they did not pay for it.</p>
      <p><b>Viewers</b> have a right to know when something is advertising: § 5a (4) UWG and § 22 MStV require a clear label, yet many videos have none.</p>
      <p>And a recommendation only works if it feels <b>genuine</b> – so PlacementRadar also rates how authentic it comes across.</p>`,
    art: () => `<div class="ia-tiles">
      <div><small>Media value</small><b class="num">€0.9k – €3.4k</b><span>equivalent ad cost, not the creator's fee</span></div>
      <div><small>Ad disclosure</small><b class="ia-lvl"><i></i>No label</b><span>§ 5a UWG · § 22 MStV</span></div>
      <div><small>Authenticity</small><b class="num">75</b><span>feels genuine</span></div></div>`,
  },
  {
    eyebrow: "What it brings",
    title: "Answers in minutes instead of hours of watching.",
    text: `      <span class="ie"><span class="ic" style="background:#ff9f0a">${icon("value")}</span><span><b>Brand managers</b> search their brand across YouTube, check whether a creator's channel fits before they pay, and send a ready report (PDF).</span></span>
      <span class="ie"><span class="ic" style="background:#ff375f">${icon("shield")}</span><span><b>Creators and agencies</b> check before publishing whether the ad label is clear enough.</span></span>
      <span class="ie"><span class="ic" style="background:#64d2ff">${icon("eye")}</span><span><b>Viewers and watchdogs</b> get a quick screening of hidden advertising. All estimates, not legal advice – and free: results are cached, the camera runs on your device.</span></span>`,
    art: () => `<div class="ia-report"><div class="ia-doc">${icon("doc")}<span></span><span></span><span class="s"></span></div><div class="ia-doc b">${icon("shield")}<span></span><span class="s"></span></div><div class="ia-doc c">${icon("heart")}<span></span><span></span></div></div>`,
  },
  {
    eyebrow: "Where to start",
    title: "Try it.",
    text: `<span class="intro-go">
        <button class="go-card" data-go="example"><span class="ic" style="background:#0a84ff">${icon("play")}</span><b>Open an example video</b><small>analysed already, opens instantly</small></button>
        <button class="go-card" data-go="live"><span class="ic" style="background:#30d158">${icon("camera")}</span><b>Live camera</b><small>hold up a product or a barcode</small></button>
        <button class="go-card" data-go="brand"><span class="ic" style="background:#5e5ce6">${icon("radar")}</span><b>Brand search</b><small>type a brand, e.g. Sonos</small></button>
        <button class="go-card" data-go="channel"><span class="ic" style="background:#ff9f0a">${icon("chat")}</span><b>Channel fit</b><small>try @iKnowReview with Sonos</small></button>
      </span>
      <span class="small muted intro-tip">Tip: under every video, <b>Show tracking</b> draws boxes and names over the products. This introduction is always available behind the round i button in the top right.</span>`,
    art: () => `<div class="ia-radar"><span></span><span></span><span></span><i></i><div class="ia-logo">${LOGO.replace(/id="lg"/, 'id="lg-in"').replace("url(#lg)", "url(#lg-in)")}</div></div>`,
  },
];

export function maybeShowIntro() {
  if (seen() || /[?&]nointro\b/.test(location.search + location.hash)) return;
  showIntro();
}

export function showIntro() {
  document.querySelector(".intro-scrim")?.remove();
  let i = 0;
  const scrim = document.createElement("div");
  scrim.className = "scrim intro-scrim";
  scrim.innerHTML = `<div class="sheet intro" role="dialog" aria-modal="true" aria-labelledby="introTitle">
      <div class="intro-stage" aria-hidden="true"><div class="intro-art"></div></div>
      <button class="intro-skip" data-skip>Skip</button>
      <div class="intro-body"><div class="intro-eyebrow"></div><h2 id="introTitle"></h2><div class="intro-text"></div></div>
      <div class="intro-foot">
        <label class="intro-keep"><input type="checkbox" id="introNo" checked> Don't show again</label>
        <div class="intro-dots">${STEPS.map((_, k) => `<button aria-label="Step ${k + 1}" data-dot="${k}"></button>`).join("")}</div>
        <div class="intro-nav"><button class="btn" data-prev>Back</button><button class="btn primary" data-next>Next</button></div>
      </div></div>`;
  document.body.append(scrim);
  const $ = (s) => scrim.querySelector(s);

  const close = () => { remember($("#introNo").checked); scrim.remove(); document.removeEventListener("keydown", onKey); };
  const show = (k) => {
    i = Math.max(0, Math.min(STEPS.length - 1, k)); const s = STEPS[i];
    $(".intro-art").innerHTML = s.art(); $(".intro-art").className = `intro-art step-${i}`;
    $(".intro-eyebrow").textContent = `${i + 1} of ${STEPS.length} · ${s.eyebrow}`;
    $("#introTitle").textContent = s.title; $(".intro-text").innerHTML = s.text;
    $(".intro-body").classList.remove("in"); void $(".intro-body").offsetWidth; $(".intro-body").classList.add("in");
    scrim.querySelectorAll("[data-dot]").forEach((d) => d.classList.toggle("on", Number(d.dataset.dot) === i));
    $("[data-prev]").style.visibility = i ? "visible" : "hidden";
    $("[data-next]").textContent = i === STEPS.length - 1 ? "Done" : "Next";
    $("[data-skip]").style.visibility = i === STEPS.length - 1 ? "hidden" : "visible";
    scrim.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => start(b.dataset.go)));
  };
  const start = async (where) => {
    close();
    if (where === "live") { location.hash = "#/live"; return; }
    if (where === "channel") { location.hash = "#/channel/%40iKnowReview?brand=Sonos"; return; } // a channel with analysed videos
    if (where === "brand") { // start page, "Brand search" tool selected, cursor in its field
      if (location.hash.replace(/^#\/?/, "")) location.hash = "#/";
      setTimeout(() => document.querySelector('.mode-pick [data-mode="brand"]')?.click(), 150); return;
    }
    try { const list = await (await fetch("data/index.json")).json(); if (list[0]) location.hash = `#/v/${list[0].id}/overview`; } catch { location.hash = "#/"; }
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "ArrowRight") show(i + 1);
    if (e.key === "ArrowLeft") show(i - 1);
  };
  document.addEventListener("keydown", onKey);
  $("[data-skip]").onclick = close;
  $("[data-prev]").onclick = () => show(i - 1);
  $("[data-next]").onclick = () => (i === STEPS.length - 1 ? close() : show(i + 1));
  scrim.querySelectorAll("[data-dot]").forEach((d) => (d.onclick = () => show(Number(d.dataset.dot))));
  scrim.onclick = (e) => { if (e.target === scrim) close(); };
  show(0);
  $("[data-next]").focus({ preventScroll: true });
}
