// Test E4 (25 Nov): "AI estimate" – POST /api/assess against a local `wrangler dev` (real Gemini key in .dev.vars).
// At most 6 Gemini requests: 3 creators for "running shoes", 2 for "headphones" + Sonos, 1 repeat of the first (stability).
// Each case first saves the exact prompt (dry, 0 requests), then asks once. Results: tests/ergebnisse/e4_assess/.
// Usage: node tests/test_e4_assess.mjs [http://127.0.0.1:8852] [case-number …]
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://127.0.0.1:8852";
const only = process.argv.slice(2).filter((x) => /^\d+$/.test(x)).map(Number);
const OUT = fileURLToPath(new URL("./ergebnisse/e4_assess/", import.meta.url)); // fileURLToPath: decodes %20 in the folder names
mkdirSync(OUT, { recursive: true });

const CASES = [
  { n: 1, name: "benparkes_running", c: "UCZPqG0yh_xPm2AyLjffbDvw", product: "running shoes" },        // E3 rank 1 (score 92)
  { n: 2, name: "believeintherun_running", c: "UC2-2J_y_jpOYz8Rld5C6C5w", product: "running shoes" }, // E3 rank 4 (80)
  { n: 3, name: "averagejames_running", c: "UCaP3rW-Qa5VYWJX11VLuHVA", product: "running shoes" },    // E3 last (42)
  { n: 4, name: "headphoneshow_sonos", c: "UCt44wdefZzrhNDYYAyEy3Xg", product: "headphones", brand: "Sonos" }, // 81, metadata only
  { n: 5, name: "mkbhd_sonos", c: "UCBJycsmduvYEL83R_U4JriQ", product: "headphones", brand: "Sonos" },         // 33, 1 analysed video
  { n: 6, name: "benparkes_running_repeat", c: "UCZPqG0yh_xPm2AyLjffbDvw", product: "running shoes", nocache: true },
];

const post = async (body) => { const r = await fetch(`${BASE}/api/assess`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return r.json(); };

for (const k of CASES) {
  if (only.length && !only.includes(k.n)) continue;
  const file = `${OUT}${k.n}_${k.name}.json`;
  if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).estimate) { console.log(`${k.n} ${k.name}: already done`); continue; }
  const { n, name, ...q } = k;
  const dry = await post({ ...q, dry: true, nocache: undefined });
  writeFileSync(`${OUT}${n}_${name}.prompt.txt`, dry.prompt || JSON.stringify(dry));
  const t0 = Date.now();
  const r = await post(q);
  writeFileSync(file, JSON.stringify(r, null, 2));
  const f = r.estimate?.fit;
  console.log(`${n} ${name}: ${r.error ? `ERROR ${r.error} – ${String(r.detail || "").slice(0, 90)}` : `${f?.level} · ${r.model} · ${Math.round((Date.now() - t0) / 1000)} s · partners ${r.estimate.partners.length} (dropped ${r.checks.dropped_partners}) · safety ${r.estimate.brand_safety.level}${r.cached ? " · CACHED" : ""}`}`);
  if (r.error === "busy" || r.error === "quota_exhausted") break; // do not burn the budget on an overloaded API
}
