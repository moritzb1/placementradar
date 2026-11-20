# Models – what runs where, and why

| # | Model | Role in PlacementRadar | Runs on | Licence / terms | Measured (EVALUATION.md) |
|---|---|---|---|---|---|
| 1 | **Gemini 3.8 Flash** (fallbacks 3.6 Flash, 3.5 Flash, 3 Flash Preview) | watches the whole YouTube video (image + audio): brand timeline, disclosures, paid/gifted judgement, rough positions; second call: authenticity | Google, via Cloudflare Worker | Gemini API terms, free tier | 100–300 s per video; timestamps ±2 s; 22–27 brands in an 8-min video |
| 2 | **Gemini 3.5 Flash-Lite** (fallback 3.1 Flash-Lite) | live scanner fallback: one camera crop → brand | Google, via Worker | Gemini API terms | 1.7 s per frame, 6/6 correct |
| 2b | **Llama 3.2 11B Vision** (Meta) on **Cloudflare Workers AI** | second provider for a camera crop when Gemini's free quota is used up; runs inside the same Worker, no API key | Cloudflare, via Worker | Llama 3.2 Community Licence; free daily allowance of 10,000 neurons (≈ 40 neurons per crop by token price → ~250 crops/day, capped by `DAILY_WORKERS_AI`) | online: main brands found (REWE, Lidl, Volvo XC90), but slogans read as brands and no usable boxes → fallback only |
| 2c | **Qwen2.5-VL 72B** (`:free` on OpenRouter) | optional third provider, only active when the secret `OPENROUTER_API_KEY` is set | OpenRouter | provider terms; 50 free requests/day without credits | *not enabled* |
| 3 | **YOLOE-26s "packaging finder"** (Ultralytics, open vocabulary) | live scanner: finds and tracks packages (snack bag, jar, tub, box, bottle, can …, 31 words fixed before export by `tools/export_yoloe.py`) so each product is identified only once | browser (ONNX Runtime Web, WebGPU/WASM), 19 MB float16 | AGPL-3.0 | 6/6 packages on the grocery test photo (YOLO26: 0/6) |
| 3b | **YOLO26n** (Ultralytics, COCO) | fallback detector if YOLOE cannot load | browser | AGPL-3.0 | runs on WebGPU; finds bottles/cups, but no bags, jars or boxes |
| 4 | **Open Food Facts universal-logo-detector** | live scanner: finds logos that COCO object classes miss (e.g. a logo on clothing) | browser (ONNX) | AGPL-3.0 → this repository is published openly | *to be measured* |
| 5 | **Marqo-Ecommerce-B** | visual product search: camera crop → most similar product photo in our Open Food Facts index | browser (ONNX, quantised) | Apache-2.0 | brand 100 %, exact product 89.8 % on 49 test photos |
| 6 | **CLIP ViT-B/32** (OpenAI) | baseline / zero-shot text matching against a brand list, only accepted at confidence ≥ 0.75 | browser | MIT | 6/6 correct above the threshold |
| 7 | **OCR** (PaddleOCR v3 det + rec, ONNX, as in RapidOCR) + **brand dictionary** (868 brands: 10,000 most-scanned products in Germany on Open Food Facts + curated non-food brands, `tools/build_brand_list.py`) | reads brand names printed on the package, matches them exactly or with 1–2 typos | browser (WASM), 13 MB | Apache-2.0 (models), ODbL (brand list) | **37/49 real product photos (76 %), 0 wrong brands, 125 ms**; 6/6 on the grocery test photo |
| 8 | **Barcode reader** (browser BarcodeDetector / ZXing) + **Open Food Facts API** | exact product (name, brand, image) from the EAN code | browser + open API | ODbL data | test EAN 3073781150780 read with ZXing (Firefox path) → "Babybel MINI Unser Würziger · 20 g", Nutri-Score D, in < 2 s |
| 9 | **Own model: brand classifier** | small classifier on top of Marqo embeddings, trained by us on Open Food Facts images of the most common German brands; retrained with Gemini's answers | trained on Mac (MPS), runs in browser | ours | *to be trained and measured* |

## Decision cascade in the live scanner
```
object found (YOLOE packaging finder; YOLO26 as fallback) → tracked box
  1. barcode visible?          → Open Food Facts → exact product           (certain)
  2. OCR reads a known brand?  → done (whole frame every 1.8 s, text is assigned to the box that holds it)
  3. own model / Marqo search  → accept if similarity above threshold       (on device)
  4. CLIP zero-shot ≥ 0.75     → accept                                     (on device)
  5. otherwise                 → Gemini Flash-Lite, 1 request → result is stored as a new training example
```

## Not used, and why
| Candidate | Reason |
|---|---|
| Gemma 4 (API) | overloaded during tests, no audio → cannot watch YouTube videos |
| Gemma 4 12B local (Ollama) | 12–30 s per frame, invents brands |
| Google Scanned Objects / 3D scans | only ~1,000 objects, mostly US household items – not enough coverage |
| General CLIP for product search | 0/5 on small crops (test H3), clearly behind Marqo (test H4) |
