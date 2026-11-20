# Evaluation – feasibility tests before building

Every mechanism was tested on its own before it went into the app ("small tests first, then the whole").
Scripts and raw results: `../tests/` (`test_*.py`, `ergebnisse/*.json`). Dates: 19 Nov 2026.

Test videos (public YouTube): *What's in my Bag? These are the essentials* (8:11, EN), *Glückstoff orthopädisches Kopfkissen im Test* (3:50, DE), *2019 BMW X5 vs 2019 Volvo XC90 – Crash Test* (1:54).

## A – Can Gemini analyse a YouTube URL directly?
| Finding | Detail |
|---|---|
| Works on the free tier, no download | `gemini-3.8-flash`; `gemini-2.5-*` no longer available to new users (404) |
| Quality | bag video: 22 brands with image/audio lanes, spoken PR note at 0:54 found ("kindly sent to me … review"), judged "paid/gifted: yes". Crash test: 2 brands, "no advertising", correctly reasoned |
| **Pitfall: timestamps** | requested as numbers, Gemini wrote 8:10 as `810`. Fix: request `"MM:SS"` text and convert ourselves → all timestamps within the video length |
| Speed | 100–300 s per video, ≈ 100 tokens per video second |
| Reliability | frequent HTTP 503 ("high demand") → automatic retry + fallback model needed |

## B – Are the timestamps right?
9 spot checks against video frames (bag video): every time, the named product is in the frame at the given second (Tarte 3:26, Anastasia 3:28, Glow Recipe 3:31, Josie Maran 4:05, Tarte lip tint 4:27, Wet Ones 4:52, LV wallet 1:38, LV backpack 0:23). **Accuracy ±2 s.** (Video kept only locally for the check, then deleted.)

Variance: the same video gave 22 vs. 27 brands in two runs, with spelling variants ("Tarte" / "Tarte Cosmetics") → brand-name normalisation (`normalize.js`), demos merge two runs.

## B2 – Can it be faster?
| Variant | Time | Brands | Requests |
|---|---|---|---|
| whole video, 3.8 Flash | 280–307 s | 22–27 | 1 |
| whole video, 3.6 Flash, `thinkingLevel: LOW` | 141 s | 23 | 1 |
| 4 segments in parallel, 3.6 Flash | **99 s** | **26** | 4 |
| whole video, 3.5 Flash, plain text | 85 s | ~20 | 1 |

`mediaResolution: LOW` had no effect on YouTube URLs (same token count). Segments return correct full-video timestamps.
→ App: one request with low thinking; demos prepared with segments.

## C – Video metadata
Title, channel, views, duration, description via the YouTube page (server-side). Gemini's own URL tools (`url_context`, `google_search`) were not available with our key (404) → the Worker reads the page (verified locally: views, duration, upload date and full description incl. the Amazon link).

## D – One camera frame → brand (live mode)
6 frames in webcam quality (640×360, JPEG 70):
| Model | OK | Median time | Notes |
|---|---|---|---|
| **gemini-3.5-flash-lite** | 6/6 | **1.7 s** | Lidl, REWE, HEAD, e.l.f., Guess, LV, BMW, Volvo, Babybel; tight boxes |
| gemini-3.1-flash-lite | 6/6 | 3.3 s | finds more small items (Dyson, ja!) |
| gemini-3-flash-preview | 4/6 | 5.2 s | one 120 s timeout, one 503 |
Boxes on single images are far more precise than positions from video analysis (test E).

## E – Positions, authenticity, body language
- Positions from video analysis are **rough**: about half sit well on the product, the rest are shifted → UI uses soft markers, not frames.
- Authenticity: plausible, with evidence. Same product in 3 runs: overall 84 / 72 / 80 (spread 12; "balance" varies most) → UI rounds to steps of 5 and shows a band.
- One combined call (brands + positions + authenticity) overloaded smaller models (5–7 instead of ~20 brands) → two separate calls.

## F/G – Hosting
- Browser may call Gemini directly (CORS allowed) → "own key" mode possible.
- A Worker keeps a 1.5–5 min Gemini request alive when it streams a heartbeat every 5 s (tested locally in the Workers runtime: result after 85 s, connection stable). Production check pending.

## Quota
Free tier: **20 requests/day per model family**. `gemini-3.7-flash` and `gemini-flash-latest` share the 3.8 quota; 3.6-flash, 3.5-flash, 3.5-flash-lite, 3.1-flash-lite and 3-flash-preview have their own → ~100/day with a model chain. Error text confirms free tier (no billing possible).

## S1 – Worker end-to-end (20 Nov, local Workers runtime via `wrangler dev`, real Gemini key)
| Check | Result |
|---|---|
| Example video via `/api/analyze` | served from `public/data`, 0 API calls, < 10 ms |
| Camera crop via `/api/identify` (provider router) | Gemini 3.5 Flash-Lite, **1.85 s**, brand correct (Lidl logo); same crop again: **from cache in 0.01 s**, no API call |
| Simulated empty quota (all video models flagged) | `/api/config` → `video_quota_left: false`; new video → HTTP 429 with the friendly message; examples keep working |
| Real analysis, 17.5-min video `WK5s-gDideg` | 3.8-Flash and 3.6-Flash failed (overloaded/rate-limited, not daily quota), 3.5-Flash delivered the timeline; **~10 min in total**. Stream stayed open with heartbeats; our test client gave up after 590 s, **but the Worker finished in the background and stored the result in KV** – the next request got it instantly and the app showed it (10 brands, "Disclosure found") |
| Workers AI (Llama 3.2 Vision), **online** | works with the input shape *messages + image bytes* (the `image_url` shape fails with error 3030). On the thumbnail collage it found REWE, Lidl and "XC90" (Volvo) but also read slogans as brands ("Perfektes Kissen") and gave useless boxes (0–1 scale, degenerate) → good enough as a fallback after Gemini, not as a first choice |
| YouTube metadata, **online** | YouTube answers the Worker's data-centre IP with `LOGIN_REQUIRED` (bot check) on the watch page and the player endpoint in almost every request – locally everything worked. Views, upload date and description are still in the rendered page data and are read from there; **the video length is missing** → estimated from the brand timeline (`duration_estimated`), exact with an optional YouTube Data API key. **With the key set (20 Nov): 5/5 test videos complete** (views, exact length, date, full description) via `dataapi` |

Consequences: failures are now logged per model (`wrangler tail`) and sent to the UI as `retry` events; long analyses are safe because the result is cached even if the visitor closes the page.

## S2 – Live scanner on the device: packaging finder + text recognition (20 Nov, in the browser)
Problem from 19 Nov: on a photo of six German grocery packages (Kaba, Prinzen Rolle, ültje, Lorenz, Zentis, Meggle) YOLO26 (COCO classes) found **nothing** – bags, jars, tubs and boxes are not COCO classes.

| Check | Setup | Result |
|---|---|---|
| **YOLOE packaging finder** vs. YOLO26 | same 6-package photo, 512 px, WebGPU | YOLO26: 0 objects. **YOLOE-26s with a packaging vocabulary: 6/6 packages boxed.** YOLOE-26n (smaller): 5/6 → we use 26s |
| Model size for the web | YOLOE-26s ONNX | 40 MB → 19 MB by cutting the unused mask branch and storing float16 weights; outputs identical to float32 (checked on the test photo). Below Cloudflare's 25 MiB per-file limit |
| **OCR → brand dictionary** on the 6-package photo | PaddleOCR v3 (ONNX, WASM) + 868 brands from Open Food Facts | **6/6 brands** in 0.6 s (first 5/6: "Lorenz" was read as "Lolen2" → digit/letter look-alikes are now mapped before the fuzzy comparison) |
| **OCR → brand**, 49 real product photos | same photos as H4, ground truth = brands in Open Food Facts; second run in webcam quality (640 px, blur, JPEG 0.6) | original: **37/49 (76 %)** correct brand incl. brand family (Sprite ↔ Coca-Cola, Actimel ↔ Danone), 34/49 exact; webcam: **36/49 (73 %)**. **Wrong brands: 0** (one "Oreo" on the Philadelphia-Oreo mousse is printed on the pack). Median **125 ms** (webcam 169 ms) per photo |
| First run, before tuning | same 49 photos | 11 wrong brands: package words one typo away from a brand ("HAFER" → Hofer, "VEGAN" → Veganz, "PROTEIN" → Myprotein). Fix: common package words may only match a brand exactly; 2 typos only from 10 letters |
| Camera mode | simulated camera (moving test photo, 20 fps) | 6 objects tracked, all 6 named; text recognition every 1.8 s, ~0.55 s each, runs beside the detector |

Not recognised by text (12/49): script or picture logos (Coca-Cola ×3, Kinder, Babybel wax, Fruchtzwerge), store brands without a brand name on the front (REWE Beste Wahl, Milbona). These are the cases for the next stages: own image model, then Gemini.
Test script: `tests/test_s2_ocr_browser.js`, results: `tests/ergebnisse/s2_live/`.

## H – Recognising brands without the API
| Test | Setup | Result |
|---|---|---|
| Gemma 4 via API | 2 frames | overloaded (503); no audio input → cannot analyse YouTube videos |
| Gemma 4 12B local (Ollama) | 2 frames | 12–30 s per frame and invents brands (Samsung, L'Oréal, Kate Spade not in the image) → unusable for live |
| **H2 CLIP ViT-B/32 + OCR**, zero-shot against 60 brand names | 21 crops | 7/21 correct overall, but **confidence ≥ 0.75 → 6/6 correct**, all errors ≤ 0.58. 20 ms per crop. OCR hits (LiDL, SKYR) correct → usable as a *gated* first stage |
| **H3 product search, CLIP** | 5 tiny crops from thumbnails vs. 377 Open Food Facts packshots | **0/5** – general CLIP fails on small, occluded crops |
| **H4 product search, Marqo-Ecommerce-B vs. CLIP** | 49 original phone photos (uncropped, with background) vs. 377 packshots of 17 brands, plus degraded "webcam" version | **Marqo: brand 100 %, exact product 89.8 % (top-5: 95.9 %), unchanged in webcam quality.** CLIP: brand 91.8–95.9 %, product 71.4–83.7 %. 27 ms vs. 8 ms per image (CPU) |

Caveat H4: query photo and gallery image come from the same original shot (gallery = cropped version), so this is easier than real life. Next: real webcam frames.

## What we learned
1. Gemini is excellent at *understanding* a video (audio, context, disclosure) – keep it for that.
2. For live recognition the free quota is the bottleneck – use on-device models and ask Gemini only when unsure.
3. A domain-specific embedding model (Marqo-Ecommerce) beats a general one (CLIP) clearly for products.
4. Report uncertainty honestly in the UI: rounded scores, approximate markers, neutral wording.
5. On packages, *reading* beats *recognising*: brand names are printed large, and a 13 MB OCR model plus an open brand list names three out of four products on the device in ~0.15 s – with no wrong brands once ordinary package words are excluded from fuzzy matching.
