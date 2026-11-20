/**
 * logos.js — official brand logos for the product cards, from Wikidata (free, no key, no quota).
 *
 *   brand name → Wikidata search (companies/brands) → property P154 "logo image" → Wikimedia Commons file
 *
 * Only entities that HAVE a logo are accepted – this filters out wrong matches like "Head" (body part).
 * Results (also "no logo") are cached in localStorage, so every brand is looked up once per browser.
 * If nothing is found the card shows the coloured initial instead. Only the brand name leaves the browser.
 */
const KEY = "pr:logos:v1";
let cache = {};
try { cache = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { /* storage blocked */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* ignore */ } };
const pending = new Map();

const API = "https://www.wikidata.org/w/api.php";
const commons = (file) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=160`;

export function logoUrl(brand) {
  const k = String(brand || "").trim().toLowerCase();
  if (!k) return Promise.resolve(null);
  if (k in cache) return Promise.resolve(cache[k]);
  if (pending.has(k)) return pending.get(k);
  const job = (async () => {
    try {
      const s = await (await fetch(`${API}?action=wbsearchentities&search=${encodeURIComponent(brand)}&language=en&type=item&limit=5&format=json&origin=*`)).json();
      const ids = (s.search || []).map((x) => x.id);
      if (!ids.length) return (cache[k] = null);
      const e = await (await fetch(`${API}?action=wbgetentities&ids=${ids.join("|")}&props=claims&format=json&origin=*`)).json();
      for (const id of ids) { // search order = relevance; first entity with a logo wins
        const file = e.entities?.[id]?.claims?.P154?.[0]?.mainsnak?.datavalue?.value;
        if (file) return (cache[k] = commons(file));
      }
      return (cache[k] = null);
    } catch { return null; } // offline → try again next time (not cached)
    finally { save(); pending.delete(k); }
  })();
  pending.set(k, job);
  return job;
}

/** Fill every <img data-logo="Brand"> in root; on failure keep the initial that sits next to it. */
export function hydrateLogos(root) {
  root.querySelectorAll("[data-logo]").forEach(async (box) => {
    const url = await logoUrl(box.dataset.logo);
    if (!url || !box.isConnected) return;
    const img = new Image(); img.alt = ""; img.referrerPolicy = "no-referrer";
    img.onload = () => { box.classList.add("has-logo"); box.replaceChildren(img); };
    img.src = url;
  });
}
