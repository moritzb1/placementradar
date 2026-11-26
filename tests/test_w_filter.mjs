/**
 * Test W2 (22 Nov): the plausibility filter for re-check spans (normalize.js filterRecheckSpans) applied to STORED
 * results – no Gemini request. Stored results are already normalized and joined, so only appearances that came purely
 * from the re-check (`recheck: true`) can be filtered; pieces joined with call 1 stay (approximation, see EVALUATION W).
 *
 *   node tests/test_w_filter.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
const here = path.dirname(fileURLToPath(import.meta.url));
const app = pathToFileURL(path.join(here, "../public/js/")).href;
const N = await import(app + "shared/normalize.js");
const V = await import(app + "value.js");
const T = await import(app + "tracking.js");
const dir = path.join(here, "ergebnisse/w_wiederfinden");

function load(f) {
  const t = fs.readFileSync(path.join(dir, f), "utf8");
  if (!f.endsWith(".sse")) return JSON.parse(t);
  let r = null; for (const c of t.split("\n\n")) { const l = c.trim().split("\n"); if (l[0] === "event: result") r = JSON.parse(l.slice(1).map((x) => x.slice(6)).join("")); } return r;
}

function filtered(d) {
  const spans = [];
  for (const b of d.brands) for (const a of b.appearances) if (a.channel === "visual" && a.recheck)
    spans.push({ ...a, key: `${b.brand}|${a.product || ""}`.toLowerCase(), _b: b.brand, track: a.track || [] });
  const list = d.source?.recheck?.products || new Set(spans.map((s) => s.key)).size;
  const { kept, stats } = N.filterRecheckSpans(spans, list);
  const brands = d.brands.map((b) => {
    const own = kept.filter((s) => s._b === b.brand).map(({ key, _b, track, ...a }) => ({ ...a, ...(track.length ? { track } : {}) }));
    const appearances = N.joinAppearances([...b.appearances.filter((a) => !(a.channel === "visual" && a.recheck)), ...own]);
    return { ...b, appearances, frames: appearances.flatMap((a) => a.track ?? []) };
  }).filter((b) => b.appearances.length);
  return { d2: { ...d, brands }, stats };
}

const vis = (d) => d.brands.reduce((n, b) => n + b.appearances.filter((a) => a.channel === "visual").length, 0);
const secs = (d) => Math.round(d.brands.reduce((n, b) => n + N.screenTime(b), 0));
function at(d, t) {
  const cov = (b) => b.appearances.filter((a) => a.channel === "visual" && t >= a.start_s - 1 && t <= a.end_s + 1);
  const hits = d.brands.filter((b) => cov(b).length);
  const back = hits.filter((b) => cov(b).every((a) => a.no_box)).map((b) => b.brand);
  const seen = hits.map((b) => b.brand).filter((x) => !back.includes(x));
  const boxes = T.boxesAt(d, t).filter((x) => x.level !== "point").map((x) => `${x.brand}:${x.level}`);
  return `picture [${seen.join(", ")}] · background [${back.join(", ")}] · boxes [${boxes.join(", ")}]`;
}

for (const [name, f, checks] of [
  ["JB desk (online, 3 Flash Preview re-check)", "eLAVGYQCkQI_online.json", [55, 205]],
  ["MKBHD run 1 (no confidence)", "-pTGc7cIBIA_lauf1.json", [150, 370]],
  ["MKBHD run 2", "-pTGc7cIBIA_lauf2.json", [105, 240]],
]) {
  const d = load(f); const { d2, stats } = filtered(d);
  const v0 = V.videoValue(d).range, v1 = V.videoValue(d2).range;
  console.log(`\n== ${name}`);
  console.log(`  visual appearances ${vis(d)} -> ${vis(d2)} · product seconds ${secs(d)} -> ${secs(d2)} · value ${V.euroRange(v0)} -> ${V.euroRange(v1)}`);
  console.log(`  filter ${JSON.stringify(stats)}`);
  for (const t of checks) { console.log(`  ${N.mmss(t)} before: ${at(d, t)}`); console.log(`  ${N.mmss(t)} after:  ${at(d2, t)}`); }
}
