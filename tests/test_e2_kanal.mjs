// Test E2 – channel view + fit (PLAN_DEZEMBER.md E). Calls POST /api/channel on the local Worker WITHOUT `approve`
// (→ 0 Gemini requests: only YouTube's channel page / RSS or 3 Data API units, analyses from the cache), then rates
// several brands with shared/fit.js exactly as the browser does (brand field: channel → GET /api/brandcat → none).
//   node tests/test_e2_kanal.mjs [--base http://localhost:8797] [@handle …]
// Results: tests/ergebnisse/e2_kanal/<channel>.json (all SSE events) + summary.json (fit table)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { channelFit } from "../public/js/shared/fit.js";

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const base = opt("base", "http://localhost:8797");
const channels = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const CHANNELS = channels.length ? channels : ["@iKnowReview", "@mkbhd", "https://www.youtube.com/watch?v=6DMUMgQyVtc"];
// one brand from the channel's own field, one neighbour, one far away, one never analysed anywhere
const BRANDS = ["Sonos", "Bose", "Apple", "Logitech", "Benefit", "Prozis", "Anker"];
// when neither the channel nor our library knows the brand's field, the UI asks the visitor – the test answers like one
const PICKED = { Benefit: "beauty", Prozis: "food", Anker: "tech" };
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "ergebnisse", "e2_kanal");
fs.mkdirSync(out, { recursive: true });

async function sse(body) {
  const t0 = Date.now();
  const r = await fetch(`${base}/api/channel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) return { error: `HTTP ${r.status} ${await r.text()}`, events: [] };
  const events = []; let buf = "";
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString("utf8");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /event: (.+)/.exec(raw)?.[1]; const data = JSON.parse(/data: (.+)/s.exec(raw)?.[1] || "{}");
      if (ev !== "ping") events.push({ t: Math.round((Date.now() - t0) / 1000), ev, data });
    }
  }
  return { events, seconds: Math.round((Date.now() - t0) / 1000) };
}

const brandcat = new Map();
async function groupOf(brand, report) {
  const own = channelFit({ placements: report.placements, videos: report.summary.totals.videos }, brand).group;
  if (own) return { group: own, from: "channel" };
  if (!brandcat.has(brand)) brandcat.set(brand, await (await fetch(`${base}/api/brandcat?b=${encodeURIComponent(brand)}`)).json());
  const j = brandcat.get(brand);
  if (j.group) return { group: j.group, from: `library (${j.seen})` };
  return PICKED[brand] ? { group: PICKED[brand], from: "picked by the visitor" } : { group: null, from: "unknown" };
}

const table = [];
for (const c of CHANNELS) {
  const res = await sse({ c });
  const name = c.replace(/[^\w@-]+/g, "_").slice(0, 40);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(res, null, 1));
  const steps = res.events.filter((e) => e.ev === "step");
  for (const s of steps) console.log(`${String(s.t).padStart(3)}s ${s.data.status.padEnd(4)} ${s.data.title} – ${s.data.detail}`);
  const rep = res.events.find((e) => e.ev === "report")?.data;
  const conf = res.events.find((e) => e.ev === "confirm")?.data;
  if (!rep) { console.log("no report", res.error || ""); continue; }
  const s = rep.summary;
  const row = { channel: rep.channel.title, input: c, source: rep.channel.source, units: rep.cost.units, gemini: rep.cost.gemini_requests, seconds: res.seconds,
    uploads: rep.uploads.length, analysed: s.totals.videos, in_latest: rep.uploads.filter((u) => u.analysed).length,
    brands: (s.brands || []).length, recurring: (s.brands || []).filter((b) => b.videos >= 2).map((b) => b.brand),
    groups: rep.groups.map((g) => `${g.label} ${Math.round(100 * g.share)}%`),
    disclosure: { commercial: s.totals.commercial, labelled: s.totals.labelled, weak: s.totals.weak, unlabelled: s.totals.unlabelled },
    months: s.months.map((m) => ({ month: m.month, videos: m.videos, value: [Math.round(m.value_low), Math.round(m.value_high)], sponsors: m.sponsors.map((x) => `${x.brand} (${x.kind})`) })),
    candidates: conf?.candidates?.length || 0, preselected: (conf?.preselected || []).map((id) => conf.candidates.find((x) => x.id === id)?.why), fits: [] };
  for (const b of BRANDS) {
    const g = await groupOf(b, rep);
    const f = channelFit({ placements: rep.placements, videos: s.totals.videos, audience: rep.audience }, b, { group: g.group });
    row.fits.push({ brand: b, field: f.group_label, field_from: g.from, score: f.score, verdict: f.verdict, confidence: f.confidence,
      gate: f.gate, parts: Object.fromEntries(f.parts.map((p) => [p.id, p.score])), competitors: f.competitors.slice(0, 5).map((x) => x.brand), already: f.already.length });
  }
  table.push(row);
  console.log(`\n${row.channel}: ${row.analysed} analysed (${row.in_latest} of ${row.uploads} latest), ${row.brands} brands, ${row.units} units, ${row.gemini} Gemini`);
  for (const f of row.fits) console.log(`  ${f.brand.padEnd(9)} ${String(f.score ?? "–").padStart(3)}  ${(f.verdict || "").padEnd(13)} ${f.field || "?"} (${f.field_from}) ${JSON.stringify(f.parts)} conf ${f.confidence}`);
  console.log("");
}
fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(table, null, 1));
