# Models – what runs where, and why

| # | Model | Role in PlacementRadar | Runs on | Licence / terms | Measured (EVALUATION.md) |
|---|---|---|---|---|---|
| 1 | **Gemini 3.8 Flash** (fallbacks 3.6 Flash, 3.5 Flash, 3 Flash Preview) | watches the whole YouTube video (image + audio): brand timeline, disclosures, paid/gifted judgement, rough positions; second call: authenticity | Google, via Cloudflare Worker | Gemini API terms, free tier | 100–300 s per video; timestamps ±2 s; 22–27 brands in an 8-min video |
| 2 | **Gemini 3.5 Flash-Lite** (fallback 3.1 Flash-Lite) | live scanner fallback: one camera crop → brand | Google, via Worker | Gemini API terms | 1.7 s per frame, 6/6 correct |
| 2b | **Llama 3.2 11B Vision** (Meta) on **Cloudflare Workers AI** | second provider for a camera crop when Gemini's free quota is used up; runs inside the same Worker, no API key | Cloudflare, via Worker | Llama 3.2 Community Licence; free daily allowance of 10,000 neurons (≈ 40 neurons per crop by token price → ~250 crops/day, capped by `DAILY_WORKERS_AI`) | *to be measured online* |
| 2c | **Qwen2.5-VL 72B** (`:free` on OpenRouter) | optional third provider, only active when the secret `OPENROUTER_API_KEY` is set | OpenRouter | provider terms; 50 free requests/day without credits | *not enabled* |
| 3 | **YOLO26n** (Ultralytics) | live scanner: finds and tracks objects (bottle, cup, phone, bag …) so each product is identified only once | browser (ONNX Runtime Web, WebGPU/WASM) | AGPL-3.0 | runs on WebGPU in the browser; found the glass on the café test photo |
| 4 | **Open Food Facts universal-logo-detector** | live scanner: finds logos that COCO object classes miss (e.g. a logo on clothing) | browser (ONNX) | AGPL-3.0 → this repository is published openly | *to be measured* |
| 5 | **Marqo-Ecommerce-B** | visual product search: camera crop → most similar product photo in our Open Food Facts index | browser (ONNX, quantised) | Apache-2.0 | brand 100 %, exact product 89.8 % on 49 test photos |
| 6 | **CLIP ViT-B/32** (OpenAI) | baseline / zero-shot text matching against a brand list, only accepted at confidence ≥ 0.75 | browser | MIT | 6/6 correct above the threshold |
| 7 | **OCR** (RapidOCR / PaddleOCR, ONNX) | reads brand names printed on the product | browser | Apache-2.0 | correct on 2/2 readable logos |
| 8 | **Barcode reader** (browser BarcodeDetector / ZXing) + **Open Food Facts API** | exact product (name, brand, image) from the EAN code | browser + open API | ODbL data | test EAN 3073781150780 read with ZXing (Firefox path) → "Babybel MINI Unser Würziger · 20 g", Nutri-Score D, in < 2 s |
| 9 | **Own model: brand classifier** | small classifier on top of Marqo embeddings, trained by us on Open Food Facts images of the most common German brands; retrained with Gemini's answers | trained on Mac (MPS), runs in browser | ours | *to be trained and measured* |

## Decision cascade in the live scanner
```
object found (YOLO26 / logo detector) → crop
  1. barcode visible?          → Open Food Facts → exact product           (certain)
  2. OCR reads a known brand?  → done                                       (certain)
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
