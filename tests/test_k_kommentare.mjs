/* Test K – audience comments per product (public/js/shared/comments.js), no Gemini, no API key.
 *
 *   node tests/test_k_kommentare.mjs fetch   → top ~100 comments of 3 example videos (YouTube web endpoint), stored as
 *                                              text + likes only (no names) in tests/ergebnisse/k_kommentare/raw_<id>.json
 *   node tests/test_k_kommentare.mjs sample  → 50 comments for the hand check: every comment the rules mark + a random
 *                                              rest (fixed seed), written to tests/kommentare/k_stichprobe.json
 *   node tests/test_k_kommentare.mjs score   → compares the rules with the hand labels in tests/kommentare/k_wahrheit.json
 *                                              (per category: precision, recall; per comment: brand assignment)
 */
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
import { fetchTopComments, classifyComments, categorize, CATS } from "../public/js/shared/comments.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(HERE, "ergebnisse", "k_kommentare"); fs.mkdirSync(RAW, { recursive: true });
const HAND = path.join(HERE, "kommentare"); fs.mkdirSync(HAND, { recursive: true });
const VIDEOS = ["dhFY1yo83d4", "-pTGc7cIBIA", "y1LUkfpTtu0", "2CqNFIn1AEo", "WK5s-gDideg"]; // bag, MKBHD desk tech, espresso (EN) · headphones test, PR unboxing (DE)
const analysis = (id) => JSON.parse(fs.readFileSync(path.join(HERE, "../public/data", `${id}.json`), "utf8"));
const brandsOf = (id) => analysis(id).brands.map((b) => ({ brand: b.brand, product: b.product, products: b.products }));

const mode = process.argv[2] || "fetch";
if (mode === "fetch") {
  for (const id of VIDEOS) {
    const r = await fetchTopComments(id);
    fs.writeFileSync(path.join(RAW, `raw_${id}.json`), JSON.stringify(r, null, 1));
    const c = classifyComments(r.comments, brandsOf(id));
    console.log(id, r.source, r.comments.length, "comments", r.error || "", "· per brand:",
      Object.entries(c.brands).filter(([, v]) => v.comments).map(([k, v]) => `${k} ${v.comments}`).join(", "), "· total", JSON.stringify(c.total.cats));
  }
}

const SET = process.argv[3] === "2" ? "2" : ""; // "2" = held-out sample, drawn after the rules were tuned on sample 1
if (mode === "sample") {
  let seed = SET ? 11 : 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; // fixed seed → same sample every run
  const used = SET ? new Set(JSON.parse(fs.readFileSync(path.join(HAND, "k_stichprobe.json"), "utf8")).map((c) => `${c.video}:${c.i}`)) : new Set();
  const all = VIDEOS.flatMap((id) => JSON.parse(fs.readFileSync(path.join(RAW, `raw_${id}.json`), "utf8")).comments.map((c, i) => ({ id, i, text: c.text }))).filter((c) => !used.has(`${c.id}:${c.i}`));
  const marked = all.filter((c) => categorize(c.text).length).sort(() => rnd() - 0.5).slice(0, 30);
  const rest = all.filter((c) => !marked.includes(c)).sort(() => rnd() - 0.5).slice(0, 50 - marked.length);
  const sample = [...marked, ...rest].sort(() => rnd() - 0.5).map((c, n) => ({ n: n + 1, video: c.id, i: c.i, text: c.text.slice(0, 400) }));
  fs.writeFileSync(path.join(HAND, `k_stichprobe${SET}.json`), JSON.stringify(sample, null, 1));
  console.log(sample.length, "comments →", path.join(HAND, `k_stichprobe${SET}.json`));
}

if (mode === "score") {
  const truth = JSON.parse(fs.readFileSync(path.join(HAND, `k_wahrheit${SET}.json`), "utf8")).items;
  const raw = Object.fromEntries(VIDEOS.map((id) => [id, JSON.parse(fs.readFileSync(path.join(RAW, `raw_${id}.json`), "utf8")).comments]));
  const res = {}; for (const c of CATS) res[c] = { tp: 0, fp: 0, fn: 0 };
  const brand = { tp: 0, fp: 0, fn: 0 }; const errors = [];
  for (const t of truth) {
    const text = raw[t.video][t.i].text; const got = categorize(text);
    for (const c of CATS) {
      const a = got.includes(c), b = t.cats.includes(c);
      if (a && b) res[c].tp++; else if (a) { res[c].fp++; errors.push(`#${t.n} ${c} too much`); } else if (b) { res[c].fn++; errors.push(`#${t.n} ${c} missed`); }
    }
    const per = classifyComments([{ text, likes: 0 }], brandsOf(t.video)).brands;
    const gotB = Object.keys(per).filter((k) => per[k].comments); const want = t.brands || [];
    for (const b of gotB) if (want.includes(b)) brand.tp++; else { brand.fp++; errors.push(`#${t.n} brand ${b} too much`); }
    for (const b of want) if (!gotB.includes(b)) { brand.fn++; errors.push(`#${t.n} brand ${b} missed`); }
  }
  const pr = (x) => ({ ...x, precision: x.tp + x.fp ? +(x.tp / (x.tp + x.fp)).toFixed(2) : null, recall: x.tp + x.fn ? +(x.tp / (x.tp + x.fn)).toFixed(2) : null });
  const out = { n: truth.length, categories: Object.fromEntries(CATS.map((c) => [c, pr(res[c])])), brand_assignment: pr(brand), errors };
  fs.writeFileSync(path.join(RAW, `k_ergebnis${SET}.json`), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}
