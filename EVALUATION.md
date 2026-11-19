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
