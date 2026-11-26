# Markier-Seite (Test M)

1. Im Terminal: `python3 tests/markieren/server.py` (aus dem Ordner 7_Finales_Projekt)
2. Im Browser: http://localhost:8612/markieren/
3. Oben Video wählen (MKBHD, JB Desk, Kopfhörer). Zuerst „nur unsichere Bilder“ anhaken und die orange umrandeten Bilder entscheiden,
   dann Haken weg und das ganze Raster einmal von oben nach unten durchsehen. Nur Fehler korrigieren.
4. „Speichern als geprüft“ (oder ⌘S) → schreibt `tests/wahrheit/<id>.json` mit `status: "checked"` (alte Fassung als `<id>.vorher.json`).
5. Danach: `node tests/test_wahrheit.mjs` → neue Zahlen; in EVALUATION.md Test M und README „How good is it?“ einsetzen.

Bedienung: Klick = Bild wählen, Shift+Klick = Bereich, Tasten 1–0 = Produkt an/aus (im ganzen Bereich), ←→↑↓ bewegen
(mit Shift Bereich erweitern), C = vom Bild davor übernehmen, X = leeren, Enter = „passt so“.
„Im YouTube-Player prüfen“ zeigt das echte Video an dieser Stelle – immer stumm (mute=1 + IFrame-API-Befehl „mute“), Ton nur, wenn du ihn selbst im Player einschaltest – für kleine Dinge im Hintergrund.

Regel „sichtbar“: Produkt im Bild erkennbar – in der Hand, getragen, auf dem Tisch, im Hintergrund, in der Totalen; Größe egal.
Nicht: nur das Logo ohne Produkt, Produktseiten im Browser, eingeblendete fremde Videos.

Bilder: `raster/` (Bildschirmfotos der 4×4-Raster) und `frames/` (Einzelbilder) bleiben lokal, nicht ins Repo (Urheberrecht).
Neu schneiden: `../../daten_s3/py bilder_schneiden.py`. Vorschlag neu bauen: `node tests/wahrheit/vorschlag_bauen.mjs`
(überschreibt nie eine Datei mit `status: "checked"`).
