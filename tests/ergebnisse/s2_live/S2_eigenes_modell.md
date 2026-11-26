# Test S2 Teil 2 – eigenes Markenmodell (Stufe 4) (20.11.2026)

**Idee:** Ein fertiger, kleiner Bild-Encoder (Apple MobileCLIP, offene Gewichte) macht aus einem Packungsfoto einen
512-Zahlen-„Fingerabdruck". Der Encoder bleibt eingefroren; wir trainieren nur einen linearen Markenkopf darauf
(eine Gewichtszeile je Marke). Dazu kommt das Wissen, das MobileCLIP schon über Markennamen hat (Text-Kopf, „zero-shot").

**Daten** (`tools/train_brand_data.py`): 20.000 meistgescannte Produkte in Deutschland (Open Food Facts) →
**131 Marken, 3.707 Produkte, 7.400 Fotos** (je Produkt Freisteller + Original-Upload mit Hand/Regal/Hintergrund).
Training 2.966 Produkte (5.922 Fotos, je 3 zusätzliche „Webcam"-Varianten), Test **741 zurückgehaltene Produkte**
(Aufteilung nach Produkt, nicht nach Foto). Die 49 Handyfotos des OCR-Tests sind komplett ausgeschlossen.
Zusätzlich **146 Packungen fremder Marken** (nicht im Modell) als Fehlalarm-Test.

## Vergleich der Encoder (Python, `tools/train_brand_model.py`, Ergebnisse `S2_eigenes_modell.json`)
Top-1 = beste Marke richtig, ohne Schwelle. Fehlalarm = Anteil fremder Packungen, denen trotzdem eine Marke ≥ 0,9 zugeordnet wird.

| Encoder (Bildteil) | Variante | zurückgehalten, Original | … Webcam-Qualität | 49 OCR-Testfotos | Fehlalarm @0,9 |
|---|---|---|---|---|---|
| MobileCLIP2-S0 (11 M) | nur Text (ohne Training) | 39 % | 28 % | 57 % | 0 % |
| | trainierter Kopf | 67 % | 59 % | 61 % | 6 % |
| | Kopf + Text | 70 % | 61 % | 71 % | 10 % |
| MobileCLIP-S1 (21 M) | nur Text | 55 % | 35 % | 61 % | 1 % |
| | trainierter Kopf | 72 % | 62 % | 61 % | 4 % |
| | **Kopf + Text** | **76 %** | 62 % | 71 % | 12 % |
| MobileCLIP2-S2 (36 M) | nur Text | 46 % | 31 % | 61 % | 1 % |
| | trainierter Kopf | 72 % | 64 % | 65 % | 6 % |
| | Kopf + Text | 76 % | 65 % | 76 % | 9 % |

Versucht, verworfen: eigene Klasse „andere Marke" (1.390 Fotos fremder Marken) → Fehlalarme **nicht** kleiner (13–19 %),
Trefferquote etwas schlechter.

## Endregel: zwei Meinungen müssen übereinstimmen
Antwort nur, wenn der Kopf ≥ 0,9 sicher ist **und** dieselbe Marke unter den Top-5 des reinen Text-Vergleichs liegt.

| Encoder | zurückgehalten: beantwortet / richtig / falsch | Webcam: richtig / falsch | 49 Fotos: richtig / falsch | Fehlalarm fremde Marken |
|---|---|---|---|---|
| MobileCLIP2-S0 | 37 % / 269 / 6 | 179 / 5 | 19 / 2 | 5 % |
| **MobileCLIP-S1** | **55 % / 388 / 16 (96 % der Antworten richtig)** | 229 / 7 | 27 / 3 | 7 % |
| MobileCLIP2-S2 | 46 % / 328 / 10 | 212 / 5 | 24 / 1 | 3 % |

**Gewählt: MobileCLIP-S1** – deutlich mehr Antworten als S0 bei gleicher Treffsicherheit; S2 kaum besser, aber 72 MB.
Export: float16-ONNX 42 MB, in 3 Stücken à ≤ 20 MB (Cloudflare: max. 25 MiB je Datei), im Browser zusammengesetzt.
Gleichheit geprüft: Browser-Datei vs. PyTorch Kosinus ≥ 0,9997.

## Im Browser, ganze Kette (Test `tests/test_s2_eigenes_modell_browser.js`, 49 Fotos)
Regel wie in der App: exakt gelesener Markenname > eigenes Modell > Markenname mit Tippfehler.

| Variante | nur OCR | eigenes Modell „sicher": richtig / falsch | **OCR + eigenes Modell** |
|---|---|---|---|
| Original-Handyfoto | 36/49 | 32 / **0** | **41/49 (84 %)** |
| Webcam-Qualität | 36/49 | 31 / **0** | **39/49 (80 %)** |

Vom eigenen Modell dazugewonnen: Babybel, Coca-Cola (Schreibschrift), Oreo, Müller, Grafschafter, Milka (Webcam).
Einziger „Fehler" der Kette: „Oreo" auf der Philadelphia-Oreo-Mousse (steht drauf; das Modell sagt richtig Philadelphia).
Weiter nicht erkannt: Kinder, Fruchtzwerge (Danone), Milbona ×2, REWE Beste Wahl ×2, Coca-Cola/Römerquelle – hier ist das Modell
unsicher (z. B. „Migros 91 %", aber Text-Meinung widerspricht → keine Antwort, richtig so).
Zeit: ~0,24 s je Packung (WASM, ein Thread, Vordergrund); im ausgeblendeten Tab ~1 s.

## Oberfläche
- Foto Coca-Cola: OCR liest „CcaG · ZERO SUGAR – no known brand", Stufe 4: **Coca-Cola 100 % · 247 ms** (`S2_eigenes_modell_cocacola.jpg`).
- Kamera (simuliert): grünes Etikett „Coca-Cola" am Rahmen (`S2_kamera_eigenes_modell.jpg`).
- Regalfoto: weiter 6/6, „Lorenz" (OCR las „Lolen2") vom eigenen Modell mit 98 % bestätigt.

## Gefundene und behobene Fehler
- Rechenfehler beim Zusammenführen der Köpfe (Bias mit Faktor 30 multipliziert) → Top-1 fiel scheinbar auf 9 %; behoben.
- Kameramodus: „Session already started" – ONNX Runtime (WASM) kann nur ein Modell gleichzeitig rechnen; OCR und eigenes
  Modell liefen parallel → gemeinsame Warteschlange `public/js/wasmqueue.js`.
- Kamera: OCR las das Coca-Cola-Logo als „icaoc" → unscharf „iChoc" und überschrieb das richtige „Coca-Cola" → Rangfolge geändert
  (unscharfer Texttreffer steht jetzt unter dem eigenen Modell).
