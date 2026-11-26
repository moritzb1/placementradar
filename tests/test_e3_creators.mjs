// Test E3 – Find creators (PLAN_DEZEMBER E, extension 25 Nov). Calls POST /api/creators on the local Worker WITHOUT `approve`
// (→ 0 Gemini requests; YouTube: 1–2 searches + the candidates' channels, Data API or keyless pages, all cached afterwards).
//   node tests/test_e3_creators.mjs "headphones" --brand Sonos [--lang en] [--base http://localhost:8798]
// Results: tests/ergebnisse/e3_creators/<product>_<brand>.json (all SSE events) – the table is printed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const product = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) || "";
const brand = opt("brand", ""); const base = opt("base", "http://localhost:8798");
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "ergebnisse", "e3_creators");
fs.mkdirSync(out, { recursive: true });

const t0 = Date.now();
const r = await fetch(`${base}/api/creators`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product, brand, lang: opt("lang", "any") }) });
if (!r.ok) { console.log("HTTP", r.status, await r.text()); process.exit(1); }
const events = []; let buf = "";
for await (const chunk of r.body) {
  buf += Buffer.from(chunk).toString("utf8");
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const raw = buf.slice(0, i); buf = buf.slice(i + 2);
    const ev = /event: (.+)/.exec(raw)?.[1]; const data = JSON.parse(/data: (.+)/s.exec(raw)?.[1] || "{}");
    if (ev === "ping") continue;
    events.push({ t: Math.round((Date.now() - t0) / 1000), ev, data });
    if (ev === "step" && data.status !== "run") console.log(`${String(events.at(-1).t).padStart(4)}s  ${data.status.padEnd(4)}  ${data.title} – ${data.detail}`);
    if (ev === "error") console.log("ERROR", data);
  }
}
const name = `${product || "-"}_${brand || "-"}`.replace(/[^\w-]+/g, "_");
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(events, null, 1));
const rep = events.find((e) => e.ev === "report")?.data;
if (rep) {
  console.log(`\n${product} / ${brand}: field ${rep.query.group_label} (${rep.query.field_from}), cost ${JSON.stringify(rep.cost)}, ${rep.seconds} s`);
  for (const s of rep.shortlist) {
    const p = Object.fromEntries(s.parts.map((x) => [x.id, x.score]));
    console.log(`  ${String(s.score).padStart(3)} ${s.channel.title.slice(0, 26).padEnd(26)} ${String(s.channel.subscribers || "").padEnd(18)} topic ${s.on_topic}/${s.uploads} med ${s.median_views} recent ${s.recent} ${JSON.stringify(p)} | ${s.basis} | ${s.topics.map((t) => t.label).join(", ")}`);
  }
}
