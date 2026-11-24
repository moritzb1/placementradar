/**
 * comments.js — how does the audience react to each product? (PLAN_DEZEMBER D, lean version, 24 Nov)
 *
 * Shared by the Worker (POST /api/comments) and the tests (tests/test_k_kommentare.mjs). Two parts:
 *
 * 1. fetchTopComments(videoId, { apiKey }) – the top ~100 comments of a video, text and likes only:
 *      - with a YouTube Data API key: commentThreads.list (order=relevance, 1 quota unit per 100 comments),
 *      - without one: YouTube's own web endpoint (youtubei/v1/next), the same request the watch page makes when you
 *        scroll to the comments – 5 pages of 20 "Top comments". Unofficial, so it fails soft (empty list + reason).
 *    Author names, avatars and channel ids are never read.
 *
 * 2. classifyComments(comments, brands) – rule-based, no model and no API call:
 *      which product a comment is about  →  brand name, or a distinctive word of the product name that belongs to
 *                                          only one brand in this video ("backpack" when there is one backpack);
 *      what kind of reaction it is        →  five categories (several can apply):
 *          buy       purchase intent  "where can I buy", "link?", "just ordered", "need this", "wo gibt es …"
 *          question  a question       "?" or a question word at the start ("does it …", "welche …")
 *          praise    praise           "love", "best", "so good", "mega", "empfehle"
 *          critic    criticism        "overpriced", "broke after", "returned it", "zu teuer", "kaputt"
 *          ad_doubt  ad suspicion     "is this sponsored", "#ad", "paid by", "Werbung", "gekauft?" (bought opinion)
 *    English and German, because the example videos are both. Praise words after a negation ("not great",
 *    "nicht gut") count as criticism instead.
 *    Why rules and not a model: the categories are about wording that repeats ("link?", "where to buy"), every
 *    decision can be shown and checked by hand (test K), and it costs nothing per comment.
 *
 * Privacy: the result keeps counts and at most 3 excerpts per brand, each ≤ 100 characters, never a name.
 */

/** Bumped whenever the rules change – part of the Worker's cache key, so old results are not served. */
export const RULES_VERSION = 3;

export const CATS = ["buy", "question", "praise", "critic", "ad_doubt"];
export const CAT_LABEL = { buy: "Purchase intent", question: "Question", praise: "Praise", critic: "Criticism", ad_doubt: "Ad suspicion" };

// ---------------------------------------------------------------------------------------------------------------
// 1. Fetching
// ---------------------------------------------------------------------------------------------------------------
const UA = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  cookie: "CONSENT=YES+1", // skips the EU consent page for this one request (no tracking cookie is set)
};

/** @returns {Promise<{ source: string, comments: {text: string, likes: number}[], error?: string }>} */
export async function fetchTopComments(videoId, { apiKey = null, max = 100 } = {}) {
  if (!/^[\w-]{11}$/.test(videoId || "")) return { source: "none", comments: [], error: "bad video id" };
  try {
    return apiKey ? await viaDataApi(videoId, apiKey, max) : await viaWebEndpoint(videoId, max);
  } catch (e) {
    return { source: apiKey ? "data-api" : "youtube-page", comments: [], error: String(e?.message || e).slice(0, 200) };
  }
}

async function viaDataApi(videoId, key, max) {
  const u = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=${Math.min(100, max)}&order=relevance&textFormat=plainText&key=${encodeURIComponent(key)}`;
  const r = await fetch(u); const j = await r.json();
  if (!r.ok) return { source: "data-api", comments: [], error: j?.error?.errors?.[0]?.reason || `HTTP ${r.status}` }; // e.g. commentsDisabled
  const comments = (j.items || []).map((it) => it.snippet?.topLevelComment?.snippet).filter(Boolean)
    .map((s) => ({ text: String(s.textDisplay || ""), likes: Number(s.likeCount) || 0 }));
  return { source: "data-api", comments };
}

/** Parses "1.2K" / "15" (likes as YouTube shows them) into a number. */
const likeNum = (s) => { const m = String(s || "").match(/([\d.,]+)\s*([KM])?/i); if (!m) return 0; const n = parseFloat(m[1].replace(",", ".")); return Math.round(n * ({ k: 1e3, m: 1e6 }[(m[2] || "").toLowerCase()] || 1)); };

async function viaWebEndpoint(videoId, max) {
  const html = await (await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, { headers: UA })).text();
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const ver = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
  const init = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)?.[1];
  if (!key || !ver || !init) return { source: "youtube-page", comments: [], error: "watch page without data (bot check?)" };
  // the comment section is an itemSectionRenderer "comment-item-section" whose only item is a continuation token
  let token = null;
  (function walk(o, inSection) {
    if (!o || typeof o !== "object" || token) return;
    if (o.itemSectionRenderer?.sectionIdentifier?.includes("comment")) inSection = true;
    if (inSection && o.continuationCommand?.token) { token = o.continuationCommand.token; return; }
    for (const k in o) walk(o[k], inSection);
  })(JSON.parse(init).contents?.twoColumnWatchNextResults?.results, false);
  if (!token) return { source: "youtube-page", comments: [], error: "comments turned off or not found" };

  const out = [];
  for (let page = 0; page < 6 && token && out.length < max; page++) {
    const r = await fetch(`https://www.youtube.com/youtubei/v1/next?key=${key}`, {
      method: "POST", headers: { ...UA, "content-type": "application/json" },
      body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: ver, hl: "en" } }, continuation: token }),
    });
    if (!r.ok) break;
    const j = await r.json(); token = null;
    // comment texts sit in "entity" payloads (newer layout); only text + likes are read
    for (const m of j.frameworkUpdates?.entityBatchUpdate?.mutations || []) {
      const p = m.payload?.commentEntityPayload; const text = p?.properties?.content?.content;
      if (text) out.push({ text: String(text), likes: likeNum(p.toolbar?.likeCountNotliked) });
    }
    // next page: the last item of the top-level list (not a reply thread's "show more")
    for (const e of j.onResponseReceivedEndpoints || []) {
      const last = ((e.reloadContinuationItemsCommand || e.appendContinuationItemsAction)?.continuationItems || []).at(-1)?.continuationItemRenderer;
      const t = last?.continuationEndpoint?.continuationCommand?.token || last?.button?.buttonRenderer?.command?.continuationCommand?.token;
      if (t) token = t;
    }
  }
  return { source: "youtube-page", comments: out.slice(0, max) };
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Classification
// ---------------------------------------------------------------------------------------------------------------
const RX = {
  buy: [
    /\bwhere (can|do|did|could|would|should) (i|you|we|one) (get|buy|find|order|purchase)\b/i, /\bwhere('?s| is) (it|this|that) from\b/i,
    /\b(any|the|a) link\b/i, /\blink\s*(\?|pls|please|for)/i, /\b(need|want|wish i had|gotta get|have to get|i'?d love to have) (this|that|these|those|it|one|them|such an?|an?)\b/i,
    /\bwhere (did|do) you (find|get|buy|order)\b/i, /\btell me where\b/i, /\b(what|which) (brand|model|one) (is|are|was|were)\b/i, /\bevery \w+( \w+)? (wants|needs)\b/i,
    /\b(just|finally) (bought|ordered|got|purchased)\b/i, /\b(i('m| am)|gonna|going to|will) (buy|order|get) (it|this|that|one|them|the)\b/i,
    /\b(added|adding) (it |this |them )?to (my )?(cart|wishlist|wish list)\b/i, /\btake my money\b/i, /\bwhat('?s| is) the (price|name)\b/i,
    /\bwo (kann man|kann ich|gibt('?s| es)|hast du|bekommt man|kauft man|bestell)/i, /\b(link|preis)\s*\?/i,
    /\b(will|brauch|muss) (ich )?(das|den|die|es|so ?(was|etwas|einen?)) (auch )?(haben|kaufen|bestellen)\b/i,
    /\b(gerade|direkt|sofort|auch) (gekauft|bestellt)\b/i, /\b(hab|habe) (es|ihn|sie|das|den|die) (mir )?(gekauft|bestellt)\b/i,
  ],
  question: [
    /\?\s*$/m, /\?\s+\S/,
    /(^|[.!]\s+)(what|which|where|does|do|is|are|can|could|would|should|did|has|have|why|who|anyone know)\b(?!['’]|n'?t)(?! a | the )/i,
    /(^|[.!]\s+)how (to|do|does|did|is|are|can|much|many|long|often|about|come)\b/i,
    /^\s*(wie|was|welche[rsmn]?|wo|wieso|warum|gibt es|ist|sind|kann|könnte|hat|hast|habt)\b/i,
  ],
  praise: [
    /\b(love|loving|loved|adore)\b/i, /\b(great|amazing|awesome|perfect|beautiful|gorgeous|fantastic|excellent|brilliant|stunning|incredible)\b/i,
    /\b(best(?! part)|favou?rite|so good|really good|very good|nice(?! (day|weekend|week))|cool|recommend(ed)?|worth it|game ?changer|underrated|obsessed|(i|really) like (it|this|that|the|using)|glad|so easy|easy to)\b/i,
    /\b(liebe|toll|super(?! (curious|excited|interested|late|early))|geil|mega|schön|hammer|genial|klasse|empfehle|empfehlenswert|lohnt sich|top|gut|gutes|guter)\b/i,
  ],
  critic: [
    /\b(overpriced|over ?priced|(too|so|really|very) (expensive|pricey)|rip ?off|not worth|waste of money|scam|keeping me from|can'?t afford)\b/i,
    /\b(it|they|mine|that|this|which|has|have|already) broke\b|\bbroke (after|down|within|in|on)\b/i,
    /\b(broken|breaks|cracked|stopped working|doesn'?t work|died|faulty|defective|returned (it|mine|them)|refund)\b/i,
    /\b(bad|terrible|awful|worst|worse|disappoint(ed|ing)?|hate|cheap(ly)? (made|quality)|flimsy|uncomfortable|problem|issue|annoying|buggy|laggy|glitch(y|es)?)\b/i,
    /\b(zu teuer|überteuert|nicht wert|kaputt|defekt|schlecht|enttäusch\w*|zurückgeschickt|reklamier\w*|mist|schrott|unbequem|nervig)\b/i,
  ],
  ad_doubt: [
    /\b(sponsored|sponsor(ship)?|paid (promo|promotion|ad|partnership|review)|paid (by|for)|advertisement|advertising|infomercial)\b/i, /#ad\b/i,
    // "ad" alone only as a statement or question about this video ("is this an ad", "just an ad", "ad?") – not "ad-free", "add"
    /\b(is (this|it) an?|this is an?|just an?|one big|basically an?) (ad|advert|commercial)\b/i, /\bad\s*\?/i,
    /\b(shill(ing)?|sell ?out|promo code|affiliate|kickback|they paid you|got paid|free (stuff|items|products?|samples?)|giving you free|gifted|pr (package|box))\b/i,
    /\b(werbung|gesponsert|bezahlt|gekauft\?|kooperation|werbevideo|dauerwerbesendung|unbezahlte werbung|rabattcode)\b/i,
  ],
};
const NEGATION = /\b(not|never|isn'?t|wasn'?t|aren'?t|no|nicht|kein(e|en)?|nie)\s+(\w+\s+)?$/i;
const PRAISE_WORD = /\b(great|good|worth it|perfect|nice|recommend\w*|toll|gut|super|empfehlenswert)\b/gi;

/** Categories of one comment text (multi-label). */
export function categorize(text) {
  const t = String(text || "");
  const cats = new Set(CATS.filter((c) => RX[c].some((rx) => rx.test(t))));
  // "not worth it", "nicht gut": a praise word right after a negation is criticism
  for (const m of t.matchAll(PRAISE_WORD)) if (NEGATION.test(t.slice(Math.max(0, m.index - 20), m.index))) { cats.add("critic"); if (!RX.praise.some((rx) => rx.test(t.replace(m[0], "")))) cats.delete("praise"); }
  // a wish ("that would be awesome", "wäre toll") is not praise of what is shown
  if (cats.has("praise") && /\b(would|could|will) be (so |really )?(awesome|great|nice|cool|amazing)\b|\bwäre (toll|super|schön|cool)\b/i.test(t) && !RX.praise.some((rx) => rx.test(t.replace(/\b(would|could|will) be (so |really )?(awesome|great|nice|cool|amazing)\b|\bwäre (toll|super|schön|cool)\b/gi, "")))) cats.delete("praise");
  // "where can I buy it?" is purchase intent, not a separate open question
  if (cats.has("buy") && cats.has("question") && !/\?.*\?/s.test(t)) cats.delete("question");
  return [...cats];
}

const lower = (s) => String(s ?? "").normalize("NFC").toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// words in product names that say nothing about which product it is
const GENERIC = new Set(("the and with for pro max mini plus ultra air new edition version gen series black white grey gray silver gold blue red green pink " +
  "small large medium inch mm cm ml set kit pack case cover der die das und mit für neu schwarz weiß").split(" "));

// product-type words ("backpack", "grinder", "headphones") name a kind of thing, not this product: a comment about
// "my backpack" is often about another backpack (test K, sample 2: 8 of 26 brand matches wrong, mostly by such words).
// The list is the 93 product types of "Verify on screen" (models/category_text.json), so it is not tuned to test K.
const TYPE_WORDS = new Set(["background", "backpack", "bicycle", "blender", "bottle", "cable", "camera", "cardboard", "cereal", "chair", "charger", "chocolate", "coffee", "computer", "console", "controller", "cosmetics", "cream", "desktop", "drawing", "drinking", "drive", "earbuds", "electric", "empty", "espresso", "external", "flower", "frying", "glass", "glasses", "grinder", "handbag", "headphones", "helmet", "hoodie", "jacket", "kettle", "keyboard", "laptop", "light", "lipstick", "machine", "makeup", "microphone", "monitor", "mouse", "notebook", "office", "palette", "perfume", "person", "phone", "plant", "potted", "power", "printer", "router", "screen", "shelf", "shirt", "small", "smart", "smartphone", "smartwatch", "snack", "sneaker", "soundbar", "speaker", "suitcase", "sunglasses", "tablet", "television", "tower", "trackpad", "tripod", "wallet", "water", "webcam", "window", "wristwatch"]);
const isTypeWord = (w) => TYPE_WORDS.has(w) || TYPE_WORDS.has(w.replace(/(es|s)$/, ""));

/** Name patterns per brand: the brand itself and distinctive product words that only this brand has in this video. */
function brandPatterns(brands) {
  const words = new Map(); // product word → set of brands
  for (const b of brands) for (const p of [b.product, ...(b.products || [])].filter(Boolean))
    for (const w of lower(p).split(/[^\p{L}\p{N}]+/u)) if (w.length >= 5 && !GENERIC.has(w) && !isTypeWord(w) && !/^\d+$/.test(w) && lower(b.brand) !== w) {
      if (!words.has(w)) words.set(w, new Set()); words.get(w).add(b.brand);
    }
  return brands.map((b) => {
    const own = [...words].filter(([, s]) => s.size === 1 && s.has(b.brand)).map(([w]) => w);
    const name = lower(b.brand).replace(/^the /, "");
    return { brand: b.brand, rx: new RegExp(`(^|[^\\p{L}\\p{N}])(${[esc(name), ...own.map(esc)].join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu") };
  });
}

/** Shortens a comment to ≤ 100 characters around the first brand mention (privacy rule: no full comments kept). */
export function excerpt(text, rx = null) {
  const t = String(text).replace(/\s+/g, " ").trim();
  if (t.length <= 100) return t;
  let at = rx ? Math.max(0, t.search(rx) - 30) : 0;
  if (at > 0) { const sp = t.indexOf(" ", at); at = sp >= 0 && sp < at + 15 ? sp + 1 : at; } // start at a word
  let s = t.slice(at, at + 98);
  if (at + 98 < t.length && s.lastIndexOf(" ") > 60) s = s.slice(0, s.lastIndexOf(" ")); // end at a word
  if (at > 0) s = s.replace(/^[\s,.;:!?)–-]+/, ""); // no "…, word"
  return `${at > 0 ? "…" : ""}${s.trim()}${at + s.length < t.length ? "…" : ""}`.slice(0, 100);
}

/**
 * @param {{text:string, likes:number}[]} comments
 * @param {{brand:string, product?:string, products?:string[]}[]} brands  from the video's analysis (unknown brands removed)
 * @returns per-brand counts + up to 3 excerpts, the same for comments about the video in general, and totals
 */
export function classifyComments(comments, brands) {
  const pats = brandPatterns((brands || []).filter((b) => b?.brand && !/^unknown/i.test(b.brand)));
  const empty = () => ({ comments: 0, likes: 0, cats: Object.fromEntries(CATS.map((c) => [c, 0])), examples: [] });
  const per = Object.fromEntries(pats.map((p) => [p.brand, empty()])); const general = empty(); const total = empty();
  const add = (slot, c, cats, rx) => {
    slot.comments += 1; slot.likes += c.likes || 0; for (const k of cats) slot.cats[k] += 1;
    if (cats.length) slot.examples.push({ cats, likes: c.likes || 0, text: excerpt(c.text, rx) });
  };
  for (const c of comments || []) {
    const cats = categorize(c.text);
    const hits = pats.filter((p) => p.rx.test(c.text));
    add(total, c, cats, null);
    if (!hits.length) add(general, c, cats, null);
    for (const p of hits) add(per[p.brand], c, cats, p.rx);
  }
  // keep the 3 most-liked examples with a category, preferring different categories
  const pick = (slot) => {
    const seen = new Set(); const sorted = slot.examples.sort((a, b) => b.likes - a.likes);
    const first = sorted.filter((e) => { const k = e.cats[0]; if (seen.has(k)) return false; seen.add(k); return true; });
    slot.examples = [...first, ...sorted.filter((e) => !first.includes(e))].slice(0, 3).map(({ cats, text }) => ({ cats, text }));
    delete slot.likes; return slot;
  };
  for (const k in per) pick(per[k]); pick(general); pick(total);
  return { total, general, brands: per };
}
