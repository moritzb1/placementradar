# Test S2 – OCR-Markenerkennung im Browser (20.11.2026)

Lauf: `tests/test_s2_ocr_browser.js` in der lokalen Vorschau (Chrome-basierte Browser-Pane, Mac M5, OCR auf WASM).
Modelle: PaddleOCR v3 det + rec (ONNX, wie RapidOCR), Markenliste `public/models/brands_de.json` (868 Marken).

| Variante | Fotos | Marke richtig (exakt) | Marke richtig (inkl. Marken-Familie) | nichts erkannt | falsche Marke | Zeit Median |
|---|---|---|---|---|---|---|
| Original-Handyfoto | 49 | 34 (69 %) | **37 (76 %)** | 12 | 1* | 125 ms |
| Webcam-Qualität (640 px, Unschärfe, JPEG 0,6) | 49 | 33 (67 %) | **36 (73 %)** | 13 | 1* | 169 ms |

\* „Oreo" auf der Philadelphia-Oreo-Mousse – steht tatsächlich drauf (Co-Branding), also kein echter Fehler.

Vor dem Feinschliff (erster Lauf): 34/49 exakt, aber **11 falsche Marken** – „HAFER" → Hofer, „VEGAN" → Veganz,
„PROTEIN" → Myprotein, „Goldbären" → Goldähren, „SKYR" (Produktart, nicht Marke). Behoben durch eine Sperrliste
gängiger Packungswörter für den unscharfen Vergleich (genaue Treffer bleiben erlaubt) und 2 Tippfehler erst ab 10 Buchstaben.

Nicht erkannt (12): Schreibschrift-/Bildlogos (Coca-Cola ×3, Kinder, Babybel-Wachs, Fruchtzwerge), Eigenmarken ohne
Markennamen auf der Vorderseite (REWE Beste Wahl ×2, Milbona Skyr ×2), 1× Oreo-Packung ohne lesbaren Text.
→ genau die Fälle für Stufe 4 (eigenes Modell, Bild statt Text) und Stufe 5 (Gemini).

Regal-Testbild vom 19.11. (`bilder_s2/regal_6_marken.jpg`, Kaba, Prinzen Rolle, ültje, Lorenz, Zentis, Meggle):
- YOLO26 (COCO): 0 Objekte → „No product-like object found"
- **YOLOE-Verpackungsfinder: 6/6 Packungen gerahmt** (WebGPU)
- **OCR: 5/6 Marken** in 631 ms (Lorenz als „Lolen2" gelesen) → nach Ziffer-Buchstaben-Abgleich (2→z, 0→o …) **6/6**.
