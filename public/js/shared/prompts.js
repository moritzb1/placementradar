/**
 * prompts.js — the single source of truth for everything we ask Gemini.
 *
 * Used by BOTH sides:
 *   - worker.js (server, "shared key" mode: the Worker calls Gemini with the project key)
 *   - js/gemini-client.js (browser, "own key" mode: the browser calls Gemini with the viewer's key)
 * Keeping prompts + JSON schemas in one file guarantees both paths produce identical data.
 *
 * Lessons from our feasibility tests (see EVALUATION.md) that are baked in here:
 *   - Timestamps are requested as "MM:SS" TEXT. As numbers, Gemini wrote 8:10 as 810 (test A).
 *   - Brand timeline and authenticity are TWO separate calls. One combined call made smaller
 *     models drop most brands (test E: 5-7 instead of ~20 brands).
 *   - Model chains: the free tier allows ~20 requests/day PER model family, and models are
 *     often overloaded (HTTP 503). We fall through the chain on 429/500/503.
 */

/** Video understanding (needs image + audio). Models with separate free quotas, best first. */
export const VIDEO_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview"];

/** Single camera frame → brand. Fast "lite" models (test D: ~1.7 s per frame). */
export const FRAME_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

// ---------------------------------------------------------------------------------------------
// Call 1: brand timeline + disclosures (+ keyframe positions for the tracking overlay)
// Since 21 Nov: one box per appearance was too little for a box that follows the product (EVALUATION.md test T),
// so Gemini gives keyframes every ~2-3 s; the browser interpolates between them (js/tracking.js).
// ---------------------------------------------------------------------------------------------
export const TIMELINE_PROMPT = `You are a brand-placement analyst. Watch the whole video (image AND audio).
List every brand or branded product that is visible, shown as on-screen text, or mentioned in speech.
Name the MOST SPECIFIC product you can: brand + product line + model (e.g. "Bose QuietComfort Ultra", not "headphones").
Use speech and on-screen text to identify the model, and link what is said to what is shown.
Also include products that are clearly visible and recognisable by their design even without a readable logo
(e.g. a reviewer wearing the headphones being discussed) – for those set basis to "design".
Make it a complete INVENTORY: list every manufactured product that is visible, not only the main topic – also things
worn or used in passing (watches and smartwatches, jewellery, glasses, clothing, phones, cases, cups, furniture).
Never guess a brand: if you cannot identify it, set brand to "unknown", still list the item with its category and
a short visual description (e.g. "round smartwatch with metal mesh band"). If you have only a vague idea, put it in
product as "possible: <brand model>" and give a confidence of 0.4 or lower.
For each appearance give start and end as MM:SS timestamps of the full video.
Rate size (small/medium/large) and position (center/edge) honestly, and say whether the product is held or used.
For each VISUAL appearance also track where the product is in the picture: give keyframes (track) with the time
(MM:SS) and the product's bounding box box_2d = [ymin, xmin, ymax, xmax], normalized to 0-1000 of the full video frame.
Put the first keyframe at the start of the appearance, then one about every 2-3 seconds while it stays visible
(more often when it moves fast, at most 12 per appearance), and the last one near the end. The box must tightly
enclose the product itself, not the person holding it. If the product leaves the picture, end the appearance there.
Report every advertising disclosure you notice (on-screen label such as "Werbung", "Anzeige", "paid promotion",
"sponsored", "PR sample", or a spoken disclosure) with its MM:SS timestamp and the exact wording.
Decide whether the video looks like paid or gifted promotion and explain why in one or two sentences.
Answer with JSON only.`;

export const TIMELINE_SCHEMA = {
  type: "OBJECT",
  properties: {
    brands: { type: "ARRAY", items: { type: "OBJECT", properties: {
      brand: { type: "STRING", description: "\"unknown\" if it cannot be identified" }, product: { type: "STRING" }, category: { type: "STRING" },
      description: { type: "STRING", description: "short visual description, needed for unknown brands" },
      appearances: { type: "ARRAY", items: { type: "OBJECT", properties: {
        start: { type: "STRING", description: "MM:SS" }, end: { type: "STRING", description: "MM:SS" },
        channel: { type: "STRING", enum: ["visual", "audio", "text"] },
        size: { type: "STRING", enum: ["small", "medium", "large"] },
        position: { type: "STRING", enum: ["center", "edge"] },
        in_use: { type: "BOOLEAN" },
        evidence: { type: "STRING" },
        basis: { type: "STRING", enum: ["logo", "text", "speech", "design"], description: "how the brand was recognised in this appearance" },
        confidence: { type: "NUMBER", description: "0-1" },
        track: { type: "ARRAY", description: "visual only: keyframes about every 2-3 s, max 12", items: { type: "OBJECT", properties: {
          time: { type: "STRING", description: "MM:SS" },
          box_2d: { type: "ARRAY", items: { type: "INTEGER" }, description: "[ymin, xmin, ymax, xmax] 0-1000" },
        }, required: ["time", "box_2d"] } },
      }, required: ["start", "end", "channel"] } },
    }, required: ["brand", "appearances"] } },
    disclosures: { type: "ARRAY", items: { type: "OBJECT", properties: {
      time: { type: "STRING", description: "MM:SS" }, kind: { type: "STRING" }, text: { type: "STRING" } } } },
    looks_like_paid_promotion: { type: "BOOLEAN" },
    reasoning: { type: "STRING" },
  },
  required: ["brands", "disclosures", "looks_like_paid_promotion"],
};

// ---------------------------------------------------------------------------------------------
// Call 1b, "Look closer" (button at the player): a 20-second clip at 2 frames per second, inventory only.
// Test I (EVALUATION.md, 21 Nov): the whole-video call missed a smartwatch on the presenter's wrist; this clip
// prompt found it (brand unknown), plus the headphone case and clothing. ~1-1.5 min, 1 request.
// ---------------------------------------------------------------------------------------------
export const CLOSER_PROMPT = `Make a complete INVENTORY of every manufactured product that appears in this clip – not only the main topic.
Include things that are worn or used in passing: watches and smartwatches, jewellery, glasses, clothing, phones, cases, cups, furniture.
For each item give start and end as MM:SS timestamps of the FULL video (separate fields, no ranges), its category,
brand and model if you can identify them (from a logo, on-screen text, speech or a distinctive design), basis, confidence 0-1,
a short visual description, and its bounding box box_2d = [ymin, xmin, ymax, xmax] (0-1000) at one moment (frame_time, MM:SS).
Never guess a brand: if it cannot be identified, set brand to "unknown" and still list the item with its category.
If you have only a vague idea, write model as "possible: <brand model>" with a confidence of 0.4 or lower. JSON only.`;

export const CLOSER_SCHEMA = {
  type: "OBJECT",
  properties: { items: { type: "ARRAY", items: { type: "OBJECT", properties: {
    start: { type: "STRING", description: "MM:SS" }, end: { type: "STRING", description: "MM:SS" },
    category: { type: "STRING" }, brand: { type: "STRING" }, model: { type: "STRING" },
    basis: { type: "STRING", enum: ["logo", "text", "speech", "design", "unknown"] }, confidence: { type: "NUMBER" },
    description: { type: "STRING" }, frame_time: { type: "STRING", description: "MM:SS" },
    box_2d: { type: "ARRAY", items: { type: "INTEGER" } },
  }, required: ["start", "end", "category", "brand", "basis"] } } },
  required: ["items"],
};

// ---------------------------------------------------------------------------------------------
// Call 2: perceived authenticity of each promoted product (incl. body language)
// ---------------------------------------------------------------------------------------------
export const authenticityPrompt = (products) => `You are an influencer-marketing analyst. Watch the whole video (image AND audio).
For each of these promoted or recommended products: ${products.join("; ")}
rate how genuine the recommendation feels to a viewer (0-100 each, higher = more genuine) and give one short
evidence quote or observation with an MM:SS timestamp for every sub-score:
- use_shown: product actually used, signs of real use, long-term experience
- balance: mentions downsides, compares with alternatives
- specificity: concrete personal experience instead of marketing claims
- delivery: speaks freely vs. reads a script; tone consistent with the rest of the video
- body_language: eye contact vs. looking off-camera, smile congruent with words, open gestures, how the product is shown
- sales_pressure: discount codes, calls to action, urgency (100 = no pressure at all)
Then an overall score 0-100 and a one-sentence verdict. This is a perceived-authenticity estimate, not a judgement of the person.
Answer with JSON only.`;

const SUB = { type: "OBJECT", properties: { score: { type: "INTEGER" }, time: { type: "STRING" }, evidence: { type: "STRING" } }, required: ["score", "evidence"] };
export const AUTHENTICITY_SCHEMA = {
  type: "OBJECT",
  properties: { items: { type: "ARRAY", items: { type: "OBJECT", properties: {
    brand: { type: "STRING" }, product: { type: "STRING" },
    use_shown: SUB, balance: SUB, specificity: SUB, delivery: SUB, body_language: SUB, sales_pressure: SUB,
    overall: { type: "INTEGER" }, verdict: { type: "STRING" },
  }, required: ["brand", "overall", "verdict", "use_shown", "balance", "specificity", "delivery", "body_language", "sales_pressure"] } } },
  required: ["items"],
};

// ---------------------------------------------------------------------------------------------
// Call 3 (live mode, only when on-device recognition is unsure): one camera frame
// ---------------------------------------------------------------------------------------------
export const FRAME_PROMPT = `Live camera frame. Find every visible brand logo or branded product.
For each: brand, product, box_2d [ymin,xmin,ymax,xmax] normalized 0-1000, confidence 0-1.
Only brands you can actually identify from logo or packaging. JSON only.`;

export const FRAME_SCHEMA = {
  type: "OBJECT",
  properties: { items: { type: "ARRAY", items: { type: "OBJECT", properties: {
    brand: { type: "STRING" }, product: { type: "STRING" },
    box_2d: { type: "ARRAY", items: { type: "INTEGER" } }, confidence: { type: "NUMBER" },
  }, required: ["brand", "box_2d"] } } },
  required: ["items"],
};

/**
 * Request body for generateContent. `video` = YouTube id, `image` = base64 JPEG.
 * `clip` = {start, end, fps} in seconds → only that part of the video, sampled at `fps` frames per second
 * (default sampling is 1 frame/s; small items such as a watch need 2, test I).
 */
export function geminiBody({ video, image, prompt, schema, lowThinking = true, clip = null }) {
  const parts = [];
  if (video) parts.push({ file_data: { file_uri: `https://www.youtube.com/watch?v=${video}` },
    ...(clip ? { video_metadata: { start_offset: `${Math.round(clip.start)}s`, end_offset: `${Math.round(clip.end)}s`, ...(clip.fps ? { fps: clip.fps } : {}) } } : {}) });
  if (image) parts.push({ inline_data: { mime_type: "image/jpeg", data: image } });
  parts.push({ text: prompt });
  const generationConfig = { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 };
  // Test B2: "low thinking" halved the time (141 s instead of ~300 s) without losing brands.
  if (lowThinking) generationConfig.thinkingConfig = { thinkingLevel: "LOW" };
  return { contents: [{ parts }], generationConfig };
}
