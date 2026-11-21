# Evaluation – feasibility tests before building

Every mechanism was tested on its own before it went into the app ("small tests first, then the whole").
Scripts and raw results: `../tests/` (`test_*.py`, `test_*.js`, `ergebnisse/`). Dates: 19–20 Nov 2026.

## At a glance
| Question | Answer (measured) | Test |
|---|---|---|
| Can Gemini watch a YouTube video from the link alone? | yes, free tier, image + audio, 100–300 s per video | A |
| Are its timestamps right? | ±2 s at 9 of 9 spot checks | B |
| How stable is it? | 22 vs. 27 brands in two runs; authenticity ±6 | B, E |
| How many requests are free? | 20 per day per model family (~100 with a model chain) | Quota |
| Can a camera frame go to Gemini? | yes, 6/6 in 1.7 s – but a live camera would use the day's quota in 40 s | D |
| Does a standard detector (YOLO26, COCO) find groceries? | no – 0 of 6 packages | S2 |
| Does an open-vocabulary detector (YOLOE)? | 6 of 6 | S2 |
| Can the browser read the brand (OCR)? | 37/49 real product photos, 0 wrong brands, 125 ms | S2 |
| Does our own trained model add anything? | OCR + own model 41/49 (84 %), 0 wrong labels from the model; 96 % of its answers right on 741 held-back products | S2b |
| Does general CLIP work for product search? | no – 0/5 on small crops | H3 |
| Are small worn items (a smartwatch) found? | whole-video pass: no · 20 s clip at 2 frames/s with an inventory prompt ("Look closer"): yes, brand honestly "unknown" | I |
| Can boxes follow a product while the video plays? | roughly: 101 Gemini keyframes for 33 appearances (~1 per 4 s), interpolated; estimates, not measurements | T |
| Does a free fallback provider help? | Workers AI (Llama 3.2 Vision) finds main brands, reads slogans as brands → last resort only | S1 |

Failures are part of the result: H3, the combined Gemini call (E), the first OCR run with 11 wrong brands (S2), the "other brand" class (S2b) and the dropped supermarket video (S3) each changed the design.

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

## I – Small products worn in passing (21 Nov, 4 Gemini requests)
Example: headphone review `2CqNFIn1AEo` at 1:37 – the Bose headphones were found, the smartwatch on the presenter's wrist was not.
- **I1, clip 1:30–1:45** (`tests/test_i_kleine_produkte.py`): the usual brand prompt finds only Bose QuietComfort + Sonos Ace (9 s). An **inventory prompt** ("every manufactured product, also worn or in passing; brand "unknown" allowed") at **2 frames/s** also finds the **smartwatch (brand unknown, round, mesh band)**, the Bose case, a jacket and a sweatshirt (91 s). `mediaResolution: HIGH` made no measurable difference – the gain comes from the prompt and the frame rate. One answer wrote a time range into a single field ("01:30.000 - 01:40.000") → the normaliser now reads ranges.
- **I2, whole video with the inventory rule in the main prompt** (1 request): Gemini 3.8 and 3.6 Flash were overloaded, 3.5 Flash answered – only 8 visual appearances (keyframe run with 3.6: 33), no unidentified items, but the Carhartt jacket and the 3DIO microphone came back. Not comparable model-for-model, but it shows: in a 10-minute pass small items stay unreliable. The example keeps the 3.6 run.
- **I3, "Look closer" in the app** (`POST /api/closer`, clip 1:25–1:45, 2 frames/s, 1 request, Gemini 3.6 Flash, 3,600 tokens, ~1 min): Bose, Sonos and the **smartwatch (brand unknown, "gold mesh band")** with a box; the second click came from the KV cache (no request). The watch's box sits above the real position – boxes stay estimates.
- **I4, second Look closer clip (1:30–1:50)**: Gemini 3.8 overloaded, 3.6 Flash answered after ~3 min with a looping answer (315,000 characters, cut-off JSON) → the app showed a raw parser error. Fix: answers are capped (`maxOutputTokens` 8192 for clips) and an unreadable answer now moves on to the next model like an overload; visitors see a plain message.
- Decision: inventory rule in the main prompt (cheap, sometimes helps), plus the **Look closer** button as the reliable way for a scene the viewer cares about; unknown brands are never guessed and never counted in value or disclosure. Raw answers: `../tests/ergebnisse/I_kleine_produkte.json`, `I2_…raw.json`, `I3_look_closer_85-105.json`.

## T – Tracking boxes with keyframes (21 Nov, 1 Gemini request)
Question: can Gemini give enough positions for a box that follows the product while the video plays?
Prompt change: instead of one box per visual appearance, `track` = keyframes (time + box) about every 2–3 s, at most 12 per appearance. Test video: *Over-Ear Kopfhörer 2026* (`2CqNFIn1AEo`, 9:50), Gemini 3.6 Flash (3.8 Flash was overloaded, HTTP 503), 36 s, 58,500 tokens.
- **101 keyframes for 33 visual appearances** (before: 1 per appearance) – on average one every ~4 s, not every 2–3 s.
- Played back with interpolation, the boxes follow the headphones visibly (e.g. Beats at 2:33–2:38, Bose at 1:31–1:37); some sit next to the product or lag after a fast cut. Gemini often re-uses identical boxes for different products → positions are approximate.
- Side effect: this run named **5 brands instead of 9** in the earlier run without keyframes (missing: 3DIO, Apple, Carhartt, Reddit – small mentions). Runs vary anyway (B), but a longer answer may cost coverage; keep watching on the next analyses.
- Decision: keyframes + interpolation in the browser, honest label "Estimated, not measured", dashed boxes when > 3 s from a reported position. Raw answer: `../tests/ergebnisse/T_2CqNFIn1AEo_gemini-3.6-flash_keyframes_raw.json`.

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

## S2b – Our own brand model (stage 4), trained and measured (20 Nov)
Goal: name the packages OCR cannot read – script and picture logos, store brands. Idea: a small pretrained image encoder
(Apple **MobileCLIP**, open weights) turns a package into a 512-number fingerprint; we keep it frozen and train only a
**linear brand head** on top. Data (`tools/train_brand_data.py`): the 20,000 most-scanned products in Germany on Open Food
Facts → **131 brands, 3,707 products, 7,400 photos** (clean packshot + original upload with hand/shelf/background).
Split **by product**: 2,966 products for training (+3 webcam-like variants per photo), **741 held back**. The 49 photos of
the OCR test are excluded completely. Extra false-alarm set: **146 packs of brands the model does not know**.

| Encoder (image part) | Variant | held-back products, original photo | … webcam quality | 49 OCR test photos | false alarm on unknown brands (≥ 0.9) |
|---|---|---|---|---|---|
| MobileCLIP2-S0 (11 M) | text only, no training (zero-shot) | 39 % | 28 % | 57 % | 0 % |
| | trained head | 67 % | 59 % | 61 % | 6 % |
| | trained head + text | 70 % | 61 % | 71 % | 10 % |
| MobileCLIP-S1 (21 M) | text only | 55 % | 35 % | 61 % | 1 % |
| | trained head | 72 % | 62 % | 61 % | 4 % |
| | **trained head + text** | **76 %** | 62 % | 71 % | 12 % |
| MobileCLIP2-S2 (36 M) | text only | 46 % | 31 % | 61 % | 1 % |
| | trained head | 72 % | 64 % | 65 % | 6 % |
| | trained head + text | 76 % | 65 % | 76 % | 9 % |

(top-1, no threshold.) "Head + text" is still **one** matrix: both heads are linear in the fingerprint, so
`W = W_trained + 0.5 · W_text`. Tried and dropped: an extra class "other brand" (1,390 photos of other brands) – it did
**not** lower false alarms (13–19 %) and cost accuracy.

**Final rule – two opinions must agree:** answer only if the head is ≥ 90 % sure **and** the same brand is among the top 5
of the text-only comparison. False alarms on unknown brands drop to 3–7 %.

| Encoder | held back: answered · right · wrong | webcam: right · wrong | 49 photos: right · wrong | false alarm |
|---|---|---|---|---|
| MobileCLIP2-S0 | 37 % · 269 · 6 | 179 · 5 | 19 · 2 | 5 % |
| **MobileCLIP-S1 (shipped)** | **55 % · 388 · 16 → 96 % of answers right** | 229 · 7 | 27 · 3 | 7 % |
| MobileCLIP2-S2 | 46 % · 328 · 10 | 212 · 5 | 24 · 1 | 3 % |

S1 answers far more often than S0 at the same precision; S2 is barely better but 72 MB. S1 as float16 ONNX = 42 MB →
shipped in three ≤ 20 MB parts (Cloudflare limit 25 MiB per file), joined in the browser; fingerprints match PyTorch
(cosine ≥ 0.9997).

**Whole cascade in the browser** (`tests/test_s2_eigenes_modell_browser.js`; rule as in the app: brand read exactly >
own model > brand read with a typo):

| 49 real product photos | OCR only | own model "sure": right · wrong | **OCR + own model** |
|---|---|---|---|
| original | 36 | 32 · **0** | **41/49 (84 %)** |
| webcam quality | 36 | 31 · **0** | **39/49 (80 %)** |

Added by the own model: Babybel, Coca-Cola (script logo), Oreo, Müller, Grafschafter, Milka. Still missed: Kinder,
Fruchtzwerge, Milbona ×2, REWE Beste Wahl ×2 – there the model is unsure or the text opinion disagrees, so it stays silent.
~0.24 s per package (WASM, one thread). UI: photo of a Coca-Cola bottle – OCR reads "CcaG · ZERO SUGAR", stage 4 says
**Coca-Cola 100 %**; grocery photo still 6/6, "Lorenz" (read as "Lolen2") confirmed by the own model at 98 %.

Bugs found on the way: (1) camera mode – ONNX Runtime's WASM backend runs one model at a time ("Session already started")
→ shared queue `public/js/wasmqueue.js`; (2) OCR read the Coca-Cola logo as "icaoc" → fuzzy match "iChoc" overwrote the
correct label → a brand read *with a typo* now ranks below the own model. Results: `tests/ergebnisse/s2_live/S2_eigenes_modell.*`.

## S3 – New example videos, waiting screen, brand report (20 Nov, online Worker)
| Video | Result | Models | Kept as example? |
|---|---|---|---|
| `WK5s-gDideg` PR unboxing, 17 min, "Werbung" in the title | 10 brands, disclosure **green** | 3.5 Flash + 3.6 Flash | yes – the clearly labelled example |
| `VnBZfauMR5M` "What's in my Bag – 45 Must Haves", 12.5 min | 23 brands, on-screen "Werbung" label from 0:00 → **green**; authenticity call failed (HTTP 524 after 125 s) | 3.6 Flash | yes – fullest timeline |
| `xRZSftRtB-s` supermarket haul, 20 min, 1.7 M views | only **1 brand** (ESN) and one disclosure with an impossible time (1,832,429 s) | 3.5 Flash | **no** – clearly incomplete |

- Both runs hit Google overload first (HTTP 503 on 3.8 and 3.6 Flash) – the model chain carried them through. The second call (authenticity) twice ended with **HTTP 524** (edge timeout); the Worker treated 524 as fatal and dropped authenticity. Fixed: 504/524 now count as "busy" → next model.
- Fixed in `normalize.js`: empty or impossible disclosure entries are dropped.
- New: a second request for a video that is still being analysed waits for the first run's result in KV instead of starting a second Gemini run (`pending:<id>` flag, 15 min).
- Brand report printed with Chrome (A4): one page each for the two tested examples (WK5s-gDideg, dhFY1yo83d4); PDFs in `tests/ergebnisse/s3_demos/`.

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
6. Training a small head on a frozen encoder takes seconds on a laptop and adds the brands OCR cannot read (+5 of 49
   photos, no wrong brand) – but only with a guard: "two opinions agree" (trained head + the encoder's own knowledge of
   brand names) cut false alarms on unknown brands from 12 % to 7 %; an extra "other brand" class did not help.
