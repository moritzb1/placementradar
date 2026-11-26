// Test G – brand agent (PLAN_DEZEMBER.md C). Calls POST /api/agent on the local Worker and stores every SSE event.
//   node tests/test_g_agent.mjs Sonos                       → plan, cache, search, proposals (0 Gemini requests)
//   node tests/test_g_agent.mjs DJI --approve <id>[,<id>]   → the same + the approved new analyses (≈ 3 requests each)
//   options: --lang de|en  --period 1y|2y|5y  --base http://localhost:8791
// Results: tests/ergebnisse/g_agent/<brand>_<step>.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const brand = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!brand) { console.log("usage: node tests/test_g_agent.mjs <brand> [--approve id,id] [--lang de] [--period 1y]"); process.exit(1); }
const base = opt("base", "http://localhost:8791");
const approve = opt("approve") ? opt("approve").split(",") : null;
const body = { brand, lang: opt("lang", "any"), period: opt("period", "any"), ...(approve ? { approve } : {}) };

const t0 = Date.now();
const r = await fetch(`${base}/api/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
    if (ev === "step") console.log(`${String(events.at(-1).t).padStart(4)}s  ${data.status.padEnd(4)}  ${data.title} – ${data.detail}`);
    if (ev === "progress" && ["model", "retry", "note"].includes(data.ev)) console.log(`        · ${data.id} ${data.ev} ${JSON.stringify(data.data)}`);
    if (ev === "confirm") console.log(`        confirm: ${data.candidates.map((c) => `${c.id} "${c.title.slice(0, 40)}" (${c.why})`).join("\n                 ")}\n        quota: ${JSON.stringify(data.quota)}`);
    if (ev === "error") console.log("ERROR", data);
  }
}
const rep = events.find((e) => e.ev === "report")?.data;
if (rep) {
  const s = rep.summary;
  console.log(`\nreport: ${s.totals.videos} videos with ${brand}, ${s.not_found.length} without · screen ${s.totals.screen_range.low}–${s.totals.screen_range.high} s · value €${Math.round(s.totals.value.low)}–€${Math.round(s.totals.value.high)} · labelled ${s.totals.labelled} / weak ${s.totals.weak} / not ${s.totals.unlabelled} / none ${s.totals.no_signals}`);
  for (const v of s.videos) console.log(`  ${v.source?.padEnd(5)} ${v.id} ${v.channel.slice(0, 18).padEnd(18)} ${String(v.screen_s).padStart(4)} s  €${Math.round(v.value.mid)}  ${v.disclosure.level}  ${v.title.slice(0, 50)}`);
  console.log("  findings:", s.findings.map((f) => f.title).join(" | "));
  console.log("  cost:", JSON.stringify(rep.cost), `${rep.seconds} s`);
}
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "ergebnisse", "g_agent");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${brand.replace(/\W+/g, "_")}_${approve ? "approve" : "plan"}${body.lang !== "any" ? `_${body.lang}` : ""}.json`);
fs.writeFileSync(file, JSON.stringify({ request: body, events }, null, 1));
console.log("saved", path.relative(process.cwd(), file));
