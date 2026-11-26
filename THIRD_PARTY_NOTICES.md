# Licences

**PlacementRadar's own code** (everything in this repository not listed below) is licensed under the
**GNU Affero General Public License v3.0** – see [LICENSE](LICENSE). AGPL was chosen because the app ships
Ultralytics YOLOE / YOLO26 models, which are AGPL-3.0: anyone who uses the website must be able to get its source code,
and this public repository is that source.

PlacementRadar is a **non-commercial university course project** (MMI5190E, Hochschule Pforzheim, winter term 2026/27).

## Models and files shipped in `public/`

| What | Files | Source | Licence |
|---|---|---|---|
| YOLOE-26s packaging finder (exported with a fixed vocabulary of 31 words) | `public/models/yoloe_pack.onnx`, `.json` | Ultralytics | AGPL-3.0 |
| YOLO26n (COCO) | `public/models/yolo26n.onnx`, `.json` | Ultralytics | AGPL-3.0 |
| MobileCLIP-S1 image encoder (converted to ONNX, float16, split into 3 parts) | `public/models/brand_encoder.0–2.bin` | Apple (`apple/ml-mobileclip`) | Apple Machine Learning Research Model License – see below |
| 93 product-type text fingerprints, computed once with the MobileCLIP-S1 text encoder | `public/models/category_text.bin`, `.json` | derived from Apple MobileCLIP-S1 | Apple Machine Learning Research Model License – see below |
| Own brand heads (v2 + v3), trained by us on MobileCLIP fingerprints | `public/models/brand_head.bin`, `.json` | this project | AGPL-3.0 (weights: ours); training data see below |
| PaddleOCR v3 detection + recognition (ONNX as packaged by RapidOCR) | `public/models/ocr/*` | PaddlePaddle / RapidOCR | Apache-2.0 |
| Brand dictionary (3,599 brands) | `public/models/brands_de.json` | built from Open Food Facts, Open Beauty Facts, Open Products Facts + curated list | ODbL 1.0 (database) |
| ONNX Runtime Web | `public/vendor/*` | Microsoft | MIT |
| ZXing barcode reader (loaded from a CDN as a fallback) | – | ZXing authors | Apache-2.0 |

### Apple MobileCLIP

Apple Machine Learning Research Model is licensed under the Apple Machine Learning Research Model License Agreement.

The full agreement is in [licenses/APPLE_ML_RESEARCH_MODEL_LICENSE.txt](licenses/APPLE_ML_RESEARCH_MODEL_LICENSE.txt).
It allows use **for research purposes only** (non-commercial scientific research and academic development).
Anyone who reuses the MobileCLIP-derived files of this repository is bound by the same agreement – **no commercial use.**

What we changed (derivative, as the agreement asks us to state):
- the image encoder of MobileCLIP-S1 was exported to ONNX, converted to float16 and split into three files (Cloudflare's 25 MiB limit); its weights were **not** retrained;
- the text encoder was run once offline to embed 93 product-type phrases; only these 93 vectors are shipped, not the encoder;
- our own brand heads are trained on top of the frozen encoder's fingerprints.

The name "Apple" appears in this project only to credit the source and as a brand the app recognises in videos; it implies no
endorsement by Apple.

## Data

- **Open Food Facts, Open Beauty Facts, Open Products Facts:** database under ODbL 1.0, product photos under CC BY-SA by their
  contributors. Used to train the brand heads and to build the brand dictionary; product lookups by barcode happen live.
- **Wikimedia Commons** (brand head v3, stage 2): 20,549 photos under free licences (CC BY-SA, CC BY, CC0, public domain). Author and
  licence of every photo are listed in [`data/brand_v3_sources.csv`](data/brand_v3_sources.csv). The photos themselves are not in this
  repository.
- **SponsorBlock** segments (evaluation only, `tests/`): CC BY-NC-SA 4.0, sponsor.ajay.app.

## Online services (not shipped, called at run time)

Google Gemini API · YouTube Data API v3 and IFrame Player API · Cloudflare Workers, KV and Workers AI (Llama 3.2 Vision, Llama 3.2
Community License). Each is used under its own terms of service. Videos are never downloaded or re-hosted; the original YouTube
player is embedded.
