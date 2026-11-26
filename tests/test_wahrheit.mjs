/**
 * Test M (23 Nov): how good are the app's visual appearances, measured against hand-marked ground truth?
 * Only STORED results are used – no Gemini request.
 *
 *   node tests/test_wahrheit.mjs            → table in the terminal + ergebnisse/m_messen/wahrheit.json
 *
 * Ground truth: tests/wahrheit/<id>.json – one label set per sampled second (every 2 s): which products are visible.
 * Status "proposal" = Claude's marking from 200-px frames, "checked" = corrected by Moritz on tests/markieren/.
 * The script says loudly which one it used.
 *
 * Measured per product and per sampled second t (a "product-second"):
 *   predicted  = the analysis has a VISUAL appearance of this product with start − TOL ≤ t ≤ end + TOL
 *   recall     = predicted ∩ true / true            ("of the seconds the product is really in the picture, how many does the app show?")
 *   precision  = predicted ∩ true / predicted       ("of the seconds the app shows it, how many are right?")
 *   Products the app names that are not in the truth (e.g. a brand that never appears) count as wrong predictions.
 *   TOL = 1 s (half the sampling step: the truth only knows every second second).
 * Timestamp error: a true span = consecutive labelled samples of one product. For each span that the app hits, the
 * appearance with the largest overlap gives |start error| and |end error|; median over all hit spans. The truth
 * itself is only accurate to ±1 s.
 *
 * Variants (where the stored result allows them):
 *   stored          – as the app shows it
 *   call 1 only     – without the re-check spans (`recheck: true`); joined pieces stay (approximation, see W)
 *   + filter        – normalize.js filterRecheckSpans applied afterwards (runs made before the filter existed)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
const here = path.dirname(fileURLToPath(import.meta.url));
const app = pathToFileURL(path.join(here, "../public/js/")).href;
const N = await import(app + "shared/normalize.js");
const E = path.join(here, "ergebnisse");
const TOL = 1;

// ------------------------------------------------------------------ loading stored results
export function load(file) {
  const t = fs.readFileSync(file, "utf8");
  if (file.endsWith(".sse")) {
    let r = null;
    for (const c of t.split("\n\n")) { const l = c.trim().split("\n"); if (l[0] === "event: result") r = JSON.parse(l.slice(1).map((x) => x.slice(6)).join("")); }
    return r;
  }
  const d = JSON.parse(t);
  if (d.candidates) { // raw Gemini answer → app data model (same normalisation as the Worker)
    const timeline = JSON.parse(d.candidates[0].content.parts[0].text);
    return N.normalizeAnalysis({ video: { duration_s: 10000 }, timeline, authenticity: null, models: [d.modelVersion] });
  }
  return d;
}

/** the runs per video: [label, file, note] */
export const RUNS = {
  "-pTGc7cIBIA": [
    ["first run (19 Nov, call 1)", "ergebnisse/p_feinschliff/-pTGc7cIBIA_vorher.json"],
    ["re-run with description (21 Nov, call 1) = example in the app", "../public/data/-pTGc7cIBIA.json"],
    ["W run 1 (22 Nov, + re-check)", "ergebnisse/w_wiederfinden/-pTGc7cIBIA_lauf1.json"],
    ["W run 2 (22 Nov, + re-check, all ratings required)", "ergebnisse/w_wiederfinden/-pTGc7cIBIA_lauf2.json"],
  ],
  "eLAVGYQCkQI": [
    ["online (22 Nov, + re-check, before filter)", "ergebnisse/w_wiederfinden/eLAVGYQCkQI_online.json"],
    ["local run with filter (22 Nov, + re-check + filter)", "ergebnisse/w_wiederfinden/eLAVGYQCkQI_lokal_filter.json"],
  ],
  "2CqNFIn1AEo": [
    ["older example (20 Nov, one box per appearance)", "ergebnisse/T_2CqNFIn1AEo_vorher_20-11.sse"],
    ["example in the app (21 Nov, keyframes)", "../public/data/2CqNFIn1AEo.json"],
    ["inventory prompt, whole video (21 Nov, test I2)", "ergebnisse/I2_2CqNFIn1AEo_gemini-3.5-flash_inventar_ganzes_video_raw.json"],
  ],
};

// ------------------------------------------------------------------ variants
const hasRecheck = (d) => d.brands.some((b) => b.appearances.some((a) => a.recheck));
const withoutRecheck = (d) => ({ ...d, brands: d.brands.map((b) => ({ ...b, appearances: b.appearances.filter((a) => !a.recheck) })) });
/** the same post-hoc filter as tests/test_w_filter.mjs (EVALUATION W2) */
function withFilter(d) {
  const spans = [];
  for (const b of d.brands) for (const a of b.appearances) if (a.channel === "visual" && a.recheck)
    spans.push({ ...a, key: `${b.brand}|${a.product || ""}`.toLowerCase(), _b: b.brand, track: a.track || [] });
  const list = d.source?.recheck?.products || new Set(spans.map((s) => s.key)).size;
  const { kept } = N.filterRecheckSpans(spans, list);
  return { ...d, brands: d.brands.map((b) => {
    const own = kept.filter((s) => s._b === b.brand).map(({ key, _b, track, ...a }) => ({ ...a, ...(track.length ? { track } : {}) }));
    return { ...b, appearances: N.joinAppearances([...b.appearances.filter((a) => !(a.channel === "visual" && a.recheck)), ...own]) };
  }) };
}
export function variants(d, file) {
  const out = [["stored", d]];
  if (hasRecheck(d)) {
    out.push(["call 1 only", withoutRecheck(d)]);
    if (!/filter/.test(file) && !d.source?.recheck_filter) out.push(["+ filter", withFilter(d)]);
  }
  return out;
}

// ------------------------------------------------------------------ matching app products to truth products
const norm = (s) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
/** visual appearances of the analysis, each with the truth product keys it stands for (or [] = not in the truth) */
export function visualSpans(d, truth) {
  const out = [];
  for (const b of d.brands) for (const a of b.appearances) {
    if (a.channel !== "visual") continue;
    const prod = norm(a.product || b.product || (b.products || []).join(" / "));
    const keys = truth.products.filter((p) => norm(p.brand) === norm(b.brand) && (!p.words.length || p.words.some((w) => prod.includes(norm(w))))).map((p) => p.key);
    out.push({ brand: b.brand, product: a.product || b.product || "", start: a.start_s, end: a.end_s, keys });
  }
  return out;
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** truth spans per product: runs of consecutive labelled samples */
function trueSpans(truth, key) {
  const ts = Object.keys(truth.labels).map(Number).sort((a, b) => a - b), spans = [];
  for (const t of ts) {
    if (!truth.labels[t].includes(key)) continue;
    const last = spans[spans.length - 1];
    if (last && t - last.end <= truth.step_s) last.end = t; else spans.push({ start: t, end: t });
  }
  return spans;
}

export function score(d, truth, { tol = TOL, skipUnsure = false } = {}) {
  const spans = visualSpans(d, truth);
  const times = Object.keys(truth.labels).map(Number).filter((t) => !(skipUnsure && truth.unsure.includes(t)));
  const at = (t, pred) => spans.some((s) => pred(s) && t >= s.start - tol && t <= s.end + tol);
  const per = {};
  let TP = 0, FN = 0, FP = 0;
  for (const p of truth.products) {
    let tp = 0, fn = 0, fp = 0;
    for (const t of times) {
      const isTrue = truth.labels[t].includes(p.key), pred = at(t, (s) => s.keys.includes(p.key));
      if (isTrue && pred) tp++; else if (isTrue) fn++; else if (pred) fp++;
    }
    // timestamp error per true span
    const errS = [], errE = []; let hit = 0;
    const tspans = trueSpans(truth, p.key);
    for (const ts of tspans) {
      const ov = spans.filter((s) => s.keys.includes(p.key)).map((s) => ({ s, o: Math.min(s.end, ts.end + tol) - Math.max(s.start, ts.start - tol) })).filter((x) => x.o >= 0);
      if (!ov.length) continue;
      hit++;
      const best = ov.sort((x, y) => y.o - x.o)[0].s;
      errS.push(Math.abs(best.start - ts.start)); errE.push(Math.abs(best.end - ts.end));
    }
    per[p.key] = { product: `${p.brand} ${p.product}`, true_s: (tp + fn) * truth.step_s, tp, fn, fp,
      recall: tp + fn ? tp / (tp + fn) : null, precision: tp + fp ? tp / (tp + fp) : null,
      spans: tspans.length, spans_hit: hit, start_err: median(errS), end_err: median(errE), _errS: errS, _errE: errE };
    TP += tp; FN += fn; FP += fp;
  }
  // products the app names that are not in the truth at all
  let extra = 0;
  const extraNames = new Set();
  for (const t of times) for (const s of spans) if (!s.keys.length && t >= s.start - tol && t <= s.end + tol) { extra++; extraNames.add(`${s.brand} ${s.product}`.trim()); }
  const allS = Object.values(per).flatMap((x) => x._errS), allE = Object.values(per).flatMap((x) => x._errE);
  const spansAll = Object.values(per).reduce((n, x) => n + x.spans, 0), hitAll = Object.values(per).reduce((n, x) => n + x.spans_hit, 0);
  for (const x of Object.values(per)) { delete x._errS; delete x._errE; }
  return { per, TP, FN, FP, extra, extraNames: [...extraNames],
    recall: TP / (TP + FN), precision: TP / (TP + FP + extra), products_found: Object.values(per).filter((x) => x.tp > 0).length,
    products_total: truth.products.length, spans: spansAll, spans_hit: hitAll, start_err: median(allS), end_err: median(allE) };
}

// ------------------------------------------------------------------ main
const pct = (x) => (x == null ? "  – " : `${Math.round(100 * x)}%`.padStart(4));
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const out = { made: new Date().toISOString().slice(0, 10), tol_s: TOL, videos: {} };
  for (const [id, runs] of Object.entries(RUNS)) {
    const truth = JSON.parse(fs.readFileSync(path.join(here, "wahrheit", `${id}.json`), "utf8"));
    const status = truth.status === "checked" ? `CHECKED by ${truth.checked_by} ${truth.checked_at}` : "PROPOSAL (Claude, not checked by a human)";
    console.log(`\n=== ${truth.title} – truth: ${status}; ${Object.keys(truth.labels).length} frames, ${truth.unsure.length} unsure`);
    out.videos[id] = { title: truth.title, truth_status: truth.status, frames: Object.keys(truth.labels).length, unsure: truth.unsure.length, runs: [] };
    for (const [label, rel] of runs) {
      const file = path.join(here, rel), d = load(file);
      for (const [vname, dv] of variants(d, rel)) {
        const s = score(dv, truth), s3 = score(dv, truth, { tol: 3 }), su = score(dv, truth, { skipUnsure: true });
        console.log(`  ${(label + " · " + vname).padEnd(78)} recall ${pct(s.recall)} precision ${pct(s.precision)} · products ${s.products_found}/${s.products_total} · spans hit ${s.spans_hit}/${s.spans} · start err ${s.start_err ?? "–"} s, end err ${s.end_err ?? "–"} s · (±3 s: ${pct(s3.recall)}/${pct(s3.precision)}; w/o unsure ${pct(su.recall)}/${pct(su.precision)})`);
        if (vname === "stored") for (const [k, x] of Object.entries(s.per))
          console.log(`      ${k.padEnd(3)} ${x.product.slice(0, 40).padEnd(40)} true ${String(x.true_s).padStart(4)} s  recall ${pct(x.recall)}  precision ${pct(x.precision)}  start err ${x.start_err ?? "–"}`);
        if (vname === "stored" && s.extraNames.length) console.log(`      not in the truth: ${s.extraNames.join(", ")}`);
        out.videos[id].runs.push({ run: label, file: rel, variant: vname, ...s, tol3: { recall: s3.recall, precision: s3.precision }, without_unsure: { recall: su.recall, precision: su.precision } });
      }
    }
  }
  const dir = path.join(E, "m_messen"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "wahrheit.json"), JSON.stringify(out, null, 1));
  console.log(`\n→ ${path.relative(here, path.join(dir, "wahrheit.json"))}`);
}
