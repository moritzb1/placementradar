/**
 * Test M4 (23 Nov): how much do Gemini runs on the same video differ? Only stored results, no request.
 *
 *   node tests/test_stabilitaet.mjs      → table + ergebnisse/m_messen/stabilitaet.json
 *
 * For every pair of runs of one video:
 *   brands   – Jaccard of the brand sets (|A∩B| / |A∪B|, names through normalize.js canon + lower case)
 *   seconds  – Jaccard of the visual (brand, whole second) pairs: "is brand X in the picture at second t" in both runs
 *   shared   – the same, but only over brands both runs found (does the timing agree where the brand agrees?)
 *   time     – visual product seconds of each run (overlaps of one brand counted once)
 * Only call 1 (the timeline) is compared: re-check spans are left out, because only two runs have them.
 * Demo files that MERGE two runs are not used (not independent). "clean" marks pairs with the same model and the same
 * prompt – there only chance differs; in the other pairs model, thinking level or prompt version changed too.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
const here = path.dirname(fileURLToPath(import.meta.url));
const N = await import(pathToFileURL(path.join(here, "../public/js/shared/normalize.js")).href);
const { load } = await import(pathToFileURL(path.join(here, "test_wahrheit.mjs")).href);
const E = (f) => path.join(here, "ergebnisse", f);

/** any stored form → [{brand, visual: [[start, end], ...]}] */
function brandsOf(file) {
  let res;
  if (file.includes("B2_") && file.includes("segmente")) { // 4 parallel segments, full-video timestamps
    res = { brands: JSON.parse(fs.readFileSync(file, "utf8")).segmente.flatMap((s) => s.result?.brands ?? []) };
  } else if (/\/(A|E|B2)_/.test(file)) res = JSON.parse(fs.readFileSync(file, "utf8")).result;
  else res = load(file);
  const map = new Map();
  for (const b of res.brands ?? []) {
    if (N.isUnknownBrand(b.brand)) continue;
    const key = N.canon(b.brand).toLowerCase();
    const e = map.get(key) ?? { brand: key, visual: [] };
    for (const a of b.appearances ?? []) {
      if (a.channel !== "visual" || a.recheck) continue;
      const s = a.start_s ?? N.sec(a.start), en = a.end_s ?? N.sec(a.end ?? a.start);
      e.visual.push([s, Math.max(s + 1, en)]);
    }
    map.set(key, e);
  }
  return [...map.values()];
}
const secondsOf = (b) => { const s = new Set(); for (const [a, e] of b.visual) for (let t = Math.floor(a); t < Math.ceil(e); t++) s.add(t); return s; };
const jac = (A, B) => { const u = new Set([...A, ...B]); if (!u.size) return null; let i = 0; for (const x of A) if (B.has(x)) i++; return i / u.size; };

// [label, file, model, prompt version]
const RUNS = {
  "-pTGc7cIBIA (MKBHD, 14:19)": [
    ["first run 19 Nov", "p_feinschliff/-pTGc7cIBIA_vorher.json", "3.x", "p1"],
    ["re-run 21 Nov (example)", "../../public/data/-pTGc7cIBIA.json", "3.6", "p2"],
    ["W run 1 22 Nov", "w_wiederfinden/-pTGc7cIBIA_lauf1.json", "3.6", "p3"],
    ["W run 2 22 Nov", "w_wiederfinden/-pTGc7cIBIA_lauf2.json", "3.6", "p3"],
  ],
  "eLAVGYQCkQI (JB desk, 7:42)": [
    ["online 22 Nov", "w_wiederfinden/eLAVGYQCkQI_online.json", "3.6", "p3"],
    ["local 22 Nov", "w_wiederfinden/eLAVGYQCkQI_lokal_filter.json", "3.5", "p4"],
  ],
  "2CqNFIn1AEo (headphones, 9:50)": [
    ["older example 20 Nov", "T_2CqNFIn1AEo_vorher_20-11.sse", "3.6", "p1"],
    ["keyframes 21 Nov (example)", "../../public/data/2CqNFIn1AEo.json", "3.6", "p1k"],
  ],
  "dhFY1yo83d4 (bag, 8:11)": [
    ["A 3.7 low thinking", "A_dhFY1yo83d4_gemini-3.7-flash_mmss_LOW.json", "3.7L", "a"],
    ["A 3.8", "A_dhFY1yo83d4_gemini-3.8-flash_mmss.json", "3.8", "a"],
    ["B2 3.6 low thinking", "B2_dhFY1yo83d4_wenigdenken_gemini-3.6-flash.json", "3.6L", "b"],
    ["B2 3.6 in 4 segments", "B2_dhFY1yo83d4_segmente_gemini-3.6-flash.json", "3.6seg", "b"],
    ["E run 1 (3.8)", "E_dhFY1yo83d4_1.json", "3.8", "e"],
    ["E run 2 (3.6)", "E_dhFY1yo83d4_2_gemini-3.6-flash.json", "3.6", "e"],
    ["E run 3 (3.6)", "E_dhFY1yo83d4_3_gemini-3.6-flash.json", "3.6", "e"],
  ],
  "2fAruP6qKd4 (pillow, 3:50)": [
    ["A 3.7", "A_2fAruP6qKd4_gemini-3.7-flash_mmss.json", "3.7", "a"],
    ["A 3.7 low thinking", "A_2fAruP6qKd4_gemini-3.7-flash_mmss_LOW.json", "3.7L", "a"],
    ["E run 1 (3.8)", "E_2fAruP6qKd4_1.json", "3.8", "e"],
  ],
  "wtDyhM_18Yo (crash test, 1:54)": [
    ["A 3.7", "A_wtDyhM_18Yo_gemini-3.7-flash.json", "3.7", "a"],
    ["A 3.8", "A_wtDyhM_18Yo_gemini-3.8-flash.json", "3.8", "a"],
  ],
};

const out = { made: new Date().toISOString().slice(0, 10), videos: {} };
const all = [], clean = [];
const r2 = (x) => (x == null ? "  – " : x.toFixed(2));
for (const [video, runs] of Object.entries(RUNS)) {
  const data = runs.map(([label, f, model, prompt]) => ({ label, model, prompt, brands: brandsOf(E(f)) }));
  console.log(`\n== ${video}`);
  for (const d of data) console.log(`   ${d.label.padEnd(26)} ${String(d.brands.length).padStart(3)} brands, ${String([...d.brands].reduce((n, b) => n + secondsOf(b).size, 0)).padStart(4)} visual brand-seconds`);
  const pairs = [];
  for (let i = 0; i < data.length; i++) for (let j = i + 1; j < data.length; j++) {
    const A = data[i], B = data[j];
    const bj = jac(new Set(A.brands.map((b) => b.brand)), new Set(B.brands.map((b) => b.brand)));
    const pairsOf = (d, only) => new Set(d.brands.filter((b) => !only || only.has(b.brand)).flatMap((b) => [...secondsOf(b)].map((t) => `${b.brand}|${t}`)));
    const sj = jac(pairsOf(A), pairsOf(B));
    const shared = new Set(A.brands.map((b) => b.brand).filter((x) => B.brands.some((b) => b.brand === x)));
    const shj = jac(pairsOf(A, shared), pairsOf(B, shared));
    const isClean = A.model === B.model && A.prompt === B.prompt;
    const p = { a: A.label, b: B.label, clean: isClean, brands: bj, seconds: sj, shared_brand_seconds: shj, shared_brands: shared.size };
    pairs.push(p); all.push(p); if (isClean) clean.push(p);
    console.log(`   ${(A.label + " vs " + B.label).padEnd(50)} brands ${r2(bj)}  seconds ${r2(sj)}  seconds of shared brands ${r2(shj)}${isClean ? "   (clean: same model + prompt)" : ""}`);
  }
  out.videos[video] = { runs: data.map((d) => ({ label: d.label, model: d.model, brands: d.brands.length, brand_seconds: d.brands.reduce((n, b) => n + secondsOf(b).size, 0) })), pairs };
}
const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
out.summary = {
  pairs: all.length, mean_brand_jaccard: mean(all.map((p) => p.brands)), mean_second_jaccard: mean(all.map((p) => p.seconds)), mean_shared_second_jaccard: mean(all.map((p) => p.shared_brand_seconds)),
  clean_pairs: clean.length, clean_brand_jaccard: mean(clean.map((p) => p.brands)), clean_second_jaccard: mean(clean.map((p) => p.seconds)), clean_shared_second_jaccard: mean(clean.map((p) => p.shared_brand_seconds)),
};
console.log("\n", out.summary);
fs.mkdirSync(E("m_messen"), { recursive: true });
fs.writeFileSync(E("m_messen/stabilitaet.json"), JSON.stringify(out, null, 1));
