/**
 * Test M3 (23 Nov): the app's ad-disclosure check compared with SponsorBlock, a community database in which viewers
 * mark sponsor segments in YouTube videos (sponsor.ajay.app, data licence CC BY-NC-SA 4.0 – used here for a
 * non-commercial university evaluation, source named in EVALUATION.md).
 *
 *   node tests/test_sponsorblock.mjs          uses the stored answers in ergebnisse/m_messen/sponsorblock/
 *   node tests/test_sponsorblock.mjs --neu    asks SponsorBlock again (only video IDs are sent, nothing else)
 *
 * Videos: all examples in public/data + the gallery of the online app (/api/recent, results fetched once from the
 * KV cache into ergebnisse/m_messen/galerie/ – a cached result costs no Gemini request).
 * Categories asked for: sponsor (paid segment), selfpromo (own merch / channel), exclusive_access (whole video shows a
 * product the creator got for free or early – a "full video label").
 *
 * Compared per video:
 *   - SponsorBlock says paid (sponsor segment or exclusive_access)  vs.  the app's verdict (disclosure.js: none / green /
 *     orange / red) and Gemini's "paid promotion" flag
 *   - timing: does the app report a spoken / on-screen disclosure inside a sponsor segment (±10 s)?
 * Caveats: SponsorBlock only covers what viewers bothered to mark (no entry ≠ no sponsor); it does not mark gifted
 * products or affiliate links, which the app also counts as commercial.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "../public");
const { checkDisclosure } = await import(pathToFileURL(path.join(appDir, "js/disclosure.js")).href);
const { load } = await import(pathToFileURL(path.join(here, "test_wahrheit.mjs")).href);
const out = path.join(here, "ergebnisse/m_messen");
const sbDir = path.join(out, "sponsorblock");
fs.mkdirSync(sbDir, { recursive: true });
const NEW = process.argv.includes("--neu");
const CATS = ["sponsor", "selfpromo", "exclusive_access"];
const NEAR = 10;

async function segments(id) {
  const f = path.join(sbDir, `${id}.json`);
  if (!NEW && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")).segments;
  const url = `https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(id)}` +
    `&categories=${encodeURIComponent(JSON.stringify(CATS))}&actionTypes=${encodeURIComponent(JSON.stringify(["skip", "mute", "full"]))}`;
  const r = await fetch(url, { headers: { "user-agent": "PlacementRadar-evaluation (university project)" } });
  const segs = r.status === 404 ? [] : r.ok ? (await r.json()).map(({ category, actionType, segment, votes, locked }) => ({ category, actionType, segment, votes, locked })) : null;
  if (segs === null) throw new Error(`SponsorBlock ${id}: HTTP ${r.status}`);
  fs.writeFileSync(f, JSON.stringify({ video: id, fetched: new Date().toISOString(), segments: segs }, null, 1));
  return segs;
}

// the videos: examples in the repo + gallery results fetched from the online cache
const videos = new Map();
for (const f of fs.readdirSync(path.join(appDir, "data"))) if (f.endsWith(".json") && f !== "index.json") videos.set(f.slice(0, -5), { src: "example", file: path.join(appDir, "data", f) });
for (const f of fs.readdirSync(path.join(out, "galerie"))) { const id = f.replace(/\.sse$/, ""); if (!videos.has(id)) videos.set(id, { src: "gallery", file: path.join(out, "galerie", f) }); }

const mm = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const rows = [];
for (const [id, v] of videos) {
  const d = load(v.file);
  const verdict = checkDisclosure(d);
  const segs = await segments(id);
  const sponsor = segs.filter((s) => s.category === "sponsor");
  const full = segs.filter((s) => s.category === "exclusive_access");
  const self = segs.filter((s) => s.category === "selfpromo");
  const sbPaid = sponsor.length > 0 || full.length > 0;
  const appCommercial = verdict.level !== "none";
  // timing: an app disclosure (spoken / on screen) inside or near a sponsor segment?
  const disc = (d.disclosures || []).filter((x) => Number.isFinite(x.time_s));
  const timed = sponsor.map((s) => ({ seg: s.segment, hit: disc.find((x) => x.time_s >= s.segment[0] - NEAR && x.time_s <= s.segment[1] + NEAR) || null }));
  rows.push({ id, src: v.src, title: (d.video?.title || "").slice(0, 50), sb: segs.map((s) => `${s.category}${s.actionType === "full" ? " (whole video)" : ` ${mm(s.segment[0])}–${mm(s.segment[1])}`} (votes ${s.votes})`),
    sbPaid, selfpromo: self.length > 0, app: verdict.level, gemini_paid: !!d.paid?.looks_like_paid_promotion,
    agree: sbPaid ? appCommercial : null, timed: timed.map((t) => ({ seg: t.seg.map(Math.round), app_disclosure: t.hit ? `${mm(t.hit.time_s)} ${t.hit.kind}: ${String(t.hit.text || "").slice(0, 60)}` : null })) });
}

console.log("video        source   SponsorBlock                                   app verdict  Gemini paid  timing");
for (const r of rows) {
  console.log(`${r.id.padEnd(12)} ${r.src.padEnd(8)} ${(r.sb.join("; ") || "no entry").slice(0, 46).padEnd(46)} ${r.app.padEnd(12)} ${String(r.gemini_paid).padEnd(12)} ` +
    r.timed.map((t) => `${t.seg.join("–")} s → ${t.app_disclosure ?? "no app disclosure in segment"}`).join(" | "));
}
const withSB = rows.filter((r) => r.sb.length), paid = rows.filter((r) => r.sbPaid);
const summary = { videos: rows.length, with_sponsorblock_entry: withSB.length, sb_paid: paid.length,
  app_commercial_when_sb_paid: paid.filter((r) => r.agree).length,
  sponsor_segments: rows.reduce((n, r) => n + r.timed.length, 0), segments_with_app_disclosure: rows.reduce((n, r) => n + r.timed.filter((t) => t.app_disclosure).length, 0),
  app_commercial_without_sb: rows.filter((r) => !r.sbPaid && r.app !== "none").length };
console.log("\n", summary);
fs.writeFileSync(path.join(out, "sponsorblock.json"), JSON.stringify({ made: new Date().toISOString().slice(0, 10), source: "sponsor.ajay.app (CC BY-NC-SA 4.0)", summary, rows }, null, 1));
