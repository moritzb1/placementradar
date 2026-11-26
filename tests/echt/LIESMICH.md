# Echter Testsatz – deine eigenen Handyfotos (Schritt A)

Hier misst das Skript `tests/test_echt.py`, wie gut der Live-Scanner **deine** Produkte erkennt –
vorher (Stand 20.11.: 868 Marken im Text, 131 Marken im eigenen Modell) und nachher (aktueller Stand).

## 1. Fotos machen (ca. 20 Minuten)
- **30–60 Produkte** aus Küche, Bad, Schreibtisch. Gemischt: Lebensmittel, Kosmetik, Putzmittel, Technik.
- Pro Produkt **1 Foto**, so wie man es in die Kamera halten würde: in der Hand, auf dem Tisch, schräg, ruhig auch
  mit Spiegelung oder Finger auf der Packung. Nicht extra schön machen – das soll echt sein.
- Zusätzlich **5–10 Produkte, deren Marke der Scanner nicht kennen kann** (Hofladen, Eigenmarke vom Bäcker,
  No-Name). Damit messen wir Fehlalarme.
- Am iPhone: Kamera auf „Maximale Kompatibilität“ (JPG) stellen, oder die Fotos beim Exportieren als JPG sichern.

## 2. Fotos ablegen und benennen
Ordner: `tests/echt/fotos/` (Unterordner sind erlaubt).

Dateiname = **Marke, zwei Unterstriche, beliebiger Rest**:
```
Milka__alpenmilch.jpg
Nivea__creme_dose.jpg
Coca-Cola__zero_flasche.jpg
Balea__shampoo.jpg
unbekannt__hofladen_marmelade.jpg      ← Marke, die der Scanner nicht kennen kann
```
Groß-/Kleinschreibung, Bindestriche und Umlaute sind egal (`Muller` = `Müller`).
Wer lieber die Originalnamen behält: Datei `tests/echt/etiketten.csv` anlegen:
```
datei;marke
IMG_4711.jpg;Milka
IMG_4712.jpg;unbekannt
```

Optional `tests/echt/boxen.json`, wenn auf einem Foto mehrere Produkte sind – dann zählt nur der Rahmen
(in Pixeln des Originalfotos): `{"IMG_4713.jpg": [120, 340, 980, 1500]}`.

## 3. Messen
Im Terminal, im Ordner `7_Finales_Projekt`:
```
daten_s3/py tests/test_echt.py
```
Dauer: ca. 1–2 s pro Foto. Ergebnis: `tests/ergebnisse/echt/echt_<datum>.md` (Tabelle vorher/nachher,
je Foto: was gelesen wurde, was das Modell sagt) und dieselben Daten als `.json`.

## Was gemessen wird
| Stufe | vorher | nachher |
|---|---|---|
| 3 Text (RapidOCR = dieselben PaddleOCR-Modelle wie im Browser) | Markenliste v1 (`daten_s3/v1/brands_de_v1.json`) | `public/models/brands_de.json` |
| 4 Eigenes Modell (MobileCLIP-S1 + Markenkopf) | Kopf v1 (`daten_s3/v1/brand_head_v1.json`) | `public/models/brand_head.json` + `.bin` |
| Kaskade wie in der App | exakt gelesen > eigenes Modell > Tippfehler-Treffer | gleich |

Jedes Foto läuft zweimal: als Foto und als „Webcam-Fassung“ (verkleinert, leicht unscharf, JPEG).
Gezählt wird **richtig / falsch / keine Antwort**; bei `unbekannt` ist jede Antwort ein Fehlalarm.
Nicht dabei: Barcode (Stufe 2) und Gemini (Stufe 5) – die sind entweder exakt oder kosten Kontingent.

## Datenschutz
Die Fotos bleiben auf dem Mac. `tests/echt/fotos/` wird nicht ins Repo hochgeladen und nie zum Training
benutzt (`tools/build_brand_data.py` schließt alle Codes in diesem Ordner aus).
