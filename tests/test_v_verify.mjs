/* Test V – "Verify on screen" (public/js/verify.js) with a REAL tab capture, no Gemini request.
 *
 * Why Puppeteer: the browser pane cannot answer Chrome's "share this tab" dialog. System Chrome with
 * --auto-accept-this-tab-capture accepts getDisplayMedia({preferCurrentTab}) for the current tab by itself, so the
 * real code path runs: getDisplayMedia → Element Capture (restrictTo on the YouTube iframe) → models on the frames.
 * The videos are only PLAYED in the embedded YouTube player (muted), never downloaded.
 *
 * Data: JB "What's on my desk" eLAVGYQCkQI = the stored ONLINE analysis (tests/ergebnisse/w_wiederfinden/
 * eLAVGYQCkQI_online.json, unfiltered – what the online app shows), injected into sessionStorage like an analysis
 * done in this tab. MKBHD -pTGc7cIBIA = the demo in public/data/.
 *
 * Scenes (from PLAN_DEZEMBER.md A):
 *   JB 0:55  wide shot, the desk products are really visible   → expect mostly "confirmed"
 *   JB 3:25  close-up, only the LG monitor is visible           → expect LG confirmed, the other 4 "not seen"
 *   MKBHD 6:10  backpack lying on the table, Gemini lists nothing → expect an "on screen only" backpack hint
 *
 * Run (local static server on :8540 = launch config "placementradar"):
 *   PUPPETEER=<path>/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js node tests/test_v_verify.mjs
 * Output: tests/ergebnisse/v_verify/ (results JSON + screenshots)
 */
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
const puppeteer = (await import(process.env.PUPPETEER || "puppeteer-core")).default;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "ergebnisse", process.env.OUTDIR || "v_verify"); /* V2 (24 Nov): OUTDIR=v2_verify */ fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE || "http://localhost:8540/";
const HEADLESS = process.env.HEADFUL ? false : "new";

const CASES = [
  { id: "eLAVGYQCkQI", data: path.join(HERE, "ergebnisse/w_wiederfinden/eLAVGYQCkQI_online.json"),
    scenes: [{ name: "jb_0055_totale", from: 50, to: 61, shot: 55 }, { name: "jb_0325_nah", from: 200, to: 211, shot: 205 }] },
  { id: "-pTGc7cIBIA", data: null, scenes: [{ name: "mkbhd_0610_rucksack", from: 366, to: 375, shot: 370 }] },
];
// V2c (24 Nov): "found on screen" – the headphones video with Bose REMOVED from the analysis (as if Gemini had missed it):
// do our own models add Bose where its logo is visible (80–100 s)? And nothing wrong next to Sonos (101–114 s, listed)?
if (process.env.CTEST === "3") CASES.splice(0, CASES.length, { id: "2CqNFIn1AEo", data: path.join(HERE, "ergebnisse/v2_verify/2CqNFIn1AEo_ohne_sonos.json"),
  scenes: [{ name: "kh_0101_sonos_entfernt", from: 101, to: 114, shot: 108 }] }); // Sonos removed: its name is printed on the headphones
else if (process.env.CTEST === "2") CASES.splice(0, CASES.length, { id: "-pTGc7cIBIA", data: path.join(HERE, "ergebnisse/v2_verify/-pTGc7cIBIA_ohne_canon.json"),
  scenes: [{ name: "mkbhd_0228_canon_entfernt", from: 228, to: 253, shot: 240 }] }); // Canon removed: printed on the camera
else if (process.env.CTEST) CASES.splice(0, CASES.length, { id: "2CqNFIn1AEo", data: path.join(HERE, "ergebnisse/v2_verify/2CqNFIn1AEo_ohne_bose.json"),
  scenes: [{ name: "kh_0080_bose_entfernt", from: 80, to: 100, shot: 90 }, { name: "kh_0101_sonos", from: 101, to: 114, shot: 108 }] });

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: HEADLESS,
  args: ["--mute-audio", "--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required", "--auto-accept-this-tab-capture",
    "--window-size=1440,1000", "--enable-features=ElementCapture", `--force-device-scale-factor=${process.env.DPR || 1}`],
  // DPR=2 → Retina like a MacBook: the captured player has twice the pixels (default 1 = what headless gives).
  // Done with Chrome's own --force-device-scale-factor: Puppeteer's emulated deviceScaleFactor breaks the tab capture
  // (the captured frame showed only the top-left quarter of the player).
  defaultViewport: null,
});
const report = { at: new Date().toISOString(), chrome: await browser.version(), cases: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const c of CASES.filter((x) => !process.env.ONLY || x.id === process.env.ONLY)) {
  const page = await browser.newPage();
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) console.log(`  [${m.type()}]`, m.text().slice(0, 200)); });
  if (c.data) {
    const json = fs.readFileSync(c.data, "utf8");
    await page.evaluateOnNewDocument((id, j) => { sessionStorage.setItem(`analysis:${id}`, j); }, c.id, json);
  }
  await page.evaluateOnNewDocument(() => { localStorage.setItem("pr:prefs", JSON.stringify({ theme: "light", usage: false, tech: false, tracking: true })); });
  await page.goto(`${BASE}?nointro&vtest#/v/${c.id}/overview`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#verifyBtn");
  await page.waitForFunction(() => window.__pr?.player?.yt?.getCurrentTime, { timeout: 30000 });
  await sleep(1500);
  // the real UI path: button → sheet → "Share this tab" (a real click = user gesture for getDisplayMedia)
  await page.click("#verifyBtn"); await page.waitForSelector("#vGo"); await page.click("#vGo");
  const t0 = Date.now();
  await page.waitForFunction(() => window.__pr?.verifier?.phase === "running" || window.__pr?.verifier?.phase === "done", { timeout: 180000 });
  const phase = await page.evaluate(() => [window.__pr.verifier.phase, window.__pr.verifier.mode, window.__pr.verifier.message]);
  console.log(c.id, "capture:", phase, `models ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const caseOut = { id: c.id, mode: phase[1], loadS: (Date.now() - t0) / 1000, scenes: [] };
  for (const s of c.scenes) {
    const f0 = await page.evaluate(() => window.__pr.verifier.frames);
    await page.evaluate((t) => window.__pr.player.seek(t, true), s.from);
    const w0 = Date.now();
    for (let i = 0; ; i++) { // play until s.to, with a progress line every 4 s (and a nudge if the player stops)
      const st = await page.evaluate(() => ({ t: window.__pr.player.yt.getCurrentTime(), ps: window.__pr.player.yt.getPlayerState(), f: window.__pr.verifier.frames, m: window.__pr.verifier.message, ms: window.__pr.verifier.msPerFrame }));
      if (st.t >= s.to) break;
      if (i % 8 === 0) console.log(`    t=${st.t.toFixed(1)} state=${st.ps} frames=${st.f} ${st.ms} ms ${st.m}`);
      if (st.ps !== 1 && st.ps !== 3 && i % 8 === 4) await page.evaluate(() => { window.__pr.player.yt.mute(); window.__pr.player.yt.playVideo(); });
      if (i % 40 === 39 && st.t < s.from - 1) await page.evaluate((t) => window.__pr.player.seek(t, true), s.from); // stuck before the scene: seek again
      if (i > 360) throw new Error("player did not reach the end of the scene");
      await sleep(500);
    }
    const playS = (Date.now() - w0) / 1000;
    await page.evaluate((t) => window.__pr.player.seek(t, false), s.shot);
    await sleep(3500); // paused: one more check of exactly this frame
    // the unclaimed hint lives only while the frame is current → read it now
    const raw = await page.evaluate(() => window.__pr.verifier.frameImage());
    if (raw) fs.writeFileSync(path.join(OUT, `${s.name}_frame.jpg`), Buffer.from(raw.split(",")[1], "base64"));
    const live = await page.evaluate((t) => ({ unclaimed: window.__pr.verifier.unclaimedAt(), measured: window.__pr.verifier.measuredAt(t) }), s.shot);
    await page.$eval(".watch", (el) => el.scrollIntoView({ block: "start" }));
    await sleep(400);
    const shot = path.join(OUT, `${s.name}.png`);
    await (await page.$(".watch")).screenshot({ path: shot });
    const res = await page.evaluate((from, to) => {
      const { R, apps } = window.__pr.verifier.results();
      return apps.filter((a) => { const [, st, en] = a.key.split("|").map(Number); return st <= to && en >= from; })
        .map((a) => ({ ...a, how: R.apps[a.key]?.how || {}, dev: R.apps[a.key]?.dev || [], meas: R.apps[a.key]?.meas || [] }));
    }, s.from, s.to);
    const frames = (await page.evaluate(() => window.__pr.verifier.frames)) - f0;
    const ms = await page.evaluate(() => window.__pr.verifier.msPerFrame);
    console.log(`  ${s.name}: ${frames} frames checked while playing ${s.from}→${s.to} s (${playS.toFixed(0)} s), last frame ${ms} ms`);
    const med = (xs) => { if (!xs.length) return null; const v = [...xs].sort((p, q) => p - q), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
    for (const a of res) {
      a.devMedian = a.dev.length ? { iou: med(a.dev.map((d) => d[1])), dist: med(a.dev.map((d) => d[2])) } : null;
      console.log(`    ${a.status.padEnd(13)} ${a.brand} – ${a.product} [${a.type || "no type"}] ${a.hits}/${a.checks} ${JSON.stringify(a.how)}`
        + (a.devMedian ? ` · measured vs. estimate: IoU ${a.devMedian.iou}, centre ${a.devMedian.dist} % (${a.dev.length})` : "") + (a.zs ? ` · type rank ${a.zs.pos} on ${a.zs.on}: ${a.zs.top.join(", ")}` : ""));
    }
    if (live.unclaimed.length) console.log("    on screen only:", live.unclaimed.map((u) => `${u.label} → ${u.brands.map((b) => b.brand).join("/")}`).join("; "));
    const extra = await page.evaluate((t) => ({ found: window.__pr.verifier.found(), foundAt: window.__pr.verifier.foundAt(t).map((f) => f.brand), tiles: window.__pr.verifier.tileStats() }), s.shot);
    console.log(`    tiles: ${JSON.stringify(extra.tiles)} · found on screen (whole run so far): ${extra.found.map((f) => `${f.brand} ${f.frames}× ${JSON.stringify(f.how)}${f.listed ? " (listed)" : ""}`).join("; ") || "–"}`);
    caseOut.scenes.push({ ...s, ...extra, frames, msLastFrame: ms, apps: res, unclaimed: live.unclaimed, measuredAtShot: live.measured, screenshot: path.relative(HERE, shot) });
  }
  // optional: raw frames (what the models saw) at more seconds, for comparing with the hand-marked truth (SNAP=50,52,…)
  for (const t of (process.env.SNAP || "").split(",").filter(Boolean).map(Number)) {
    await page.evaluate((x) => window.__pr.player.seek(x, false), t); await sleep(3000);
    const raw = await page.evaluate(() => window.__pr.verifier.frameImage());
    if (raw) fs.writeFileSync(path.join(OUT, `${c.id}_${t}s_frame.jpg`), Buffer.from(raw.split(",")[1], "base64"));
  }
  // frame by frame against the hand-marked truth of test M (tests/wahrheit/<id>.json, labels every 2 s, a proposal):
  // did our models find evidence for a product in a frame where it is really visible?
  const truthFile = path.join(HERE, "wahrheit", `${c.id}.json`);
  if (fs.existsSync(truthFile)) {
    const T = JSON.parse(fs.readFileSync(truthFile, "utf8")), keyOf = new Map(T.products.map((p) => [p.brand.toLowerCase(), p.key]));
    const unsure = new Set((T.unsure || []).map(Number));
    const { log } = await page.evaluate(() => window.__pr.verifier.results());
    const m = { all: { tp: 0, fp: 0, fn: 0, tn: 0 }, sure: { tp: 0, fp: 0, fn: 0, tn: 0 }, perBrand: {} };
    for (const [t, brand, ev] of log) {
      const sec = Math.round(t / 2) * 2, lab = T.labels[String(sec)]; if (!lab || Math.abs(sec - t) > 1) continue;
      const k = keyOf.get(brand.toLowerCase()); if (!k) continue;
      const vis = lab.includes(k), hit = !!ev, cell = hit && vis ? "tp" : hit ? "fp" : vis ? "fn" : "tn";
      m.all[cell]++; if (!unsure.has(sec)) m.sure[cell]++;
      (m.perBrand[brand] ||= { tp: 0, fp: 0, fn: 0, tn: 0 })[cell]++;
    }
    caseOut.vsTruth = m;
    console.log("  vs. hand-marked truth (frames × products):", JSON.stringify(m.all), "· without 'unsure' seconds:", JSON.stringify(m.sure));
    console.log("   ", Object.entries(m.perBrand).map(([b, x]) => `${b} ${JSON.stringify(x)}`).join(" | "));
  }
  caseOut.summary = await page.evaluate(() => window.__pr.verifier.summary());
  // c) the same result in Products (section "Found on screen"), Media value and the Brand report
  caseOut.foundSection = await page.evaluate(() => { const el = document.querySelector("#foundSect"); return el && !el.hidden ? el.innerText.replace(/\s+/g, " ").slice(0, 300) : null; });
  if (caseOut.foundSection) console.log("  Products → Found on screen:", caseOut.foundSection);
  await page.evaluate(() => window.__pr.verifier.stop("test end"));
  // after the capture ended: stored measured keyframes are replayed (sessionStorage), the status survives a reload
  const last = c.scenes[c.scenes.length - 1].shot;
  caseOut.replayAfterStop = await page.evaluate((t) => window.__pr.verifier.measuredAt(t).map((m) => `${m.brand} ${m.box.join(",")}`), last);
  await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForFunction(() => window.__pr?.verifier);
  caseOut.afterReload = await page.evaluate(() => window.__pr.verifier.summary());
  console.log("  replay after stop:", caseOut.replayAfterStop, "· after reload:", JSON.stringify({ c: caseOut.afterReload.confirmed, n: caseOut.afterReload.not_seen, f: caseOut.afterReload.frames }));
  if (process.env.CTEST) {
    for (const view of ["value", "report"]) {
      await page.goto(`${BASE}?nointro&vtest#/v/${c.id}/${view}`, { waitUntil: "domcontentloaded" }); await sleep(2500);
      caseOut[`view_${view}`] = await page.evaluate(() => [...document.querySelectorAll(".tag.found")].map((e) => e.closest(".row,.rp-brand,option")?.innerText?.replace(/\s+/g, " ").slice(0, 120) || e.innerText));
      if (view === "report") caseOut.reportOptions = await page.evaluate(() => [...document.querySelectorAll("#rbrand option")].map((o) => o.textContent).filter((t) => t.includes("found")));
      console.log(`  ${view}:`, JSON.stringify(caseOut[`view_${view}`]), view === "report" ? JSON.stringify(caseOut.reportOptions) : "");
      await page.screenshot({ path: path.join(OUT, `${c.id}_${view}.png`) });
    }
  }
  report.cases.push(caseOut);
  await page.close();
}
// ONLY=<id> runs one video and replaces just its entry (the YouTube player sometimes stalls in headless Chrome)
const file = path.join(OUT, "v_verify.json");
if (process.env.ONLY && fs.existsSync(file)) {
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  report.cases = [...old.cases.filter((x) => !report.cases.some((n) => n.id === x.id)), ...report.cases];
}
fs.writeFileSync(file, JSON.stringify(report, null, 1));
console.log("→", path.join(OUT, "v_verify.json"));
await browser.close();
