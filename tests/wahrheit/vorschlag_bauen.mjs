/**
 * Test M, step 1: turn Claude's notes (notizen_<id>.txt, written while looking at the contact sheets) into the
 * ground-truth format tests/wahrheit/<id>.json with status "proposal". Moritz then corrects it on the marking page
 * (tests/markieren/), which saves the same format with status "checked".
 *
 *   node tests/wahrheit/vorschlag_bauen.mjs            (never overwrites a file whose status is "checked")
 *
 * Format of <id>.json:
 *   { video, title, duration_s, step_s: 2, status: "proposal" | "checked", definition,
 *     products: [{ key, brand, product, words: [..] }],   // words: the app's product name must contain one (empty = any)
 *     labels: { "<second>": ["KEY", ...] },               // every sampled second, also empty ones
 *     unsure: [seconds] }                                  // frames Claude could not decide – check these first
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const here = path.dirname(fileURLToPath(import.meta.url));

const DEFINITION = "A product counts as visible at a second if it can be recognised in the frame – in the hand, worn, " +
  "on the desk, in the background or in a wide shot; size does not matter. Logos alone without the product, " +
  "product pages and other videos shown in the video do not count. Judged on 2-second frames (about 200 px wide).";

const VIDEOS = {
  "eLAVGYQCkQI": {
    title: "What's on My Desk 2025 (JB)", duration_s: 462,
    products: [
      ["L", "LG", '43" Smart Monitor', ["monitor"]], ["A", "Apple", "Mac mini M4", ["mac mini"]],
      ["S", "Sonos", "One speakers", []], ["K", "Keychron", "K3 keyboard", []], ["O", "LEGO", "Orchid", []],
      ["Q", "Quntis", "Monitor light bar", []], ["M", "Sennheiser", "Profile USB mic", []],
      ["D", "Samsung", "2TB SSD", []], ["H", "Seagate", "8TB hard drive", []],
    ],
    groups: { W: ["L", "S", "Q", "A", "O", "K"] },
  },
  "-pTGc7cIBIA": {
    title: "My Everyday Tech: 2022! (MKBHD)", duration_s: 858,
    products: [
      ["B", "Peak Design", "Everyday Backpack 20L", []], ["U", "Under Armour", "Sweatshirt", []],
      ["MB", "Apple", 'MacBook Pro 16"', ["macbook"]], ["I", "Apple", "iPhone 13 Pro", ["iphone"]],
      ["AP", "Apple", "AirPods Max", ["airpods"]], ["C", "Canon", "EOS R5", []], ["T", "Trove", "Slim Wallet", []],
      ["R", "Realme", "Mini SuperDart 50W charger", []], ["OP", "Opal", "C1 webcam", []], ["P", "Google", "Pixel 6 Pro", ["pixel"]],
    ],
    groups: {},
  },
  "2CqNFIn1AEo": {
    title: "Over-Ear Kopfhörer 2026 (iKnowReview)", duration_s: 588,
    products: [
      ["N", "Nothing", "Headphone (1) Pro", []], ["SO", "Sonos", "Ace (Ultra)", []], ["BE", "Beats", "360", []],
      ["BO", "Bose", "QuietComfort Headphones (2nd Gen)", []], ["BW", "Bowers & Wilkins", "Px7 S3", []],
    ],
    groups: { ALL: ["N", "SO", "BE", "BO", "BW"] },
  },
};

for (const [id, v] of Object.entries(VIDEOS)) {
  const out = path.join(here, `${id}.json`);
  if (fs.existsSync(out) && JSON.parse(fs.readFileSync(out, "utf8")).status === "checked") { console.log(id, "already checked – kept"); continue; }
  const keys = new Set(v.products.map((p) => p[0]));
  const labels = {}, unsure = new Set();
  for (let t = 0; t <= v.duration_s; t += 2) labels[t] = [];
  for (const line of fs.readFileSync(path.join(here, `notizen_${id}.txt`), "utf8").split("\n")) {
    const m = line.match(/^(\d+)(?:-(\d+))?:\s*(.*)$/);
    if (!m) continue;
    const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
    const tokens = m[3].trim().split(/\s+/).filter((x) => x && x !== "-");
    const set = new Set();
    let doubt = false;
    for (const tok of tokens) {
      if (tok === "?") doubt = true;
      else if (v.groups[tok]) v.groups[tok].forEach((k) => set.add(k));
      else if (keys.has(tok)) set.add(tok);
      else throw new Error(`${id}: unknown token ${tok} in "${line}"`);
    }
    for (let t = a; t <= b; t += 2) if (t in labels) { labels[t] = [...set]; if (doubt) unsure.add(t); }
  }
  const truth = { video: id, title: v.title, duration_s: v.duration_s, step_s: 2, status: "proposal",
    made_by: "Claude, contact sheets 23 Nov 2026 (not checked by a human yet)", definition: DEFINITION,
    products: v.products.map(([key, brand, product, words]) => ({ key, brand, product, words })),
    labels, unsure: [...unsure].sort((x, y) => x - y) };
  fs.writeFileSync(out, JSON.stringify(truth, null, 1));
  const n = Object.values(labels).reduce((s, l) => s + l.length, 0);
  console.log(id, Object.keys(labels).length, "frames,", n, "product-frames,", unsure.size, "unsure");
}
