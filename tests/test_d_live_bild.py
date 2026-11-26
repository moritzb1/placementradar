"""Einzeltest D: Live-Modus – ein Webcam-Bild (640x360, JPEG 70) an Gemini → Marken mit Rahmen.
Misst Antwortzeit je Modell. Statt echter Webcam: Vorschaubilder der Testvideos in Webcam-Qualität.

Aufruf:  python test_d_live_bild.py
Ergebnis: ergebnisse/D_live.json + bilder_d/boxen_<modell>.jpg
"""
import base64, json, time, pathlib
import cv2
import numpy as np
import requests
from gemini_common import API, KEY, ERG, HIER

MODELLE = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-3.5-flash"]
PROMPT = ("Live camera frame. Find every visible brand logo or branded product. "
          "For each: brand, product, box_2d [ymin,xmin,ymax,xmax] normalized 0-1000, confidence 0-1. "
          "Only brands you can actually identify from logo/packaging. JSON only.")
SCHEMA = {"type": "OBJECT", "properties": {"items": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
    "brand": {"type": "STRING"}, "product": {"type": "STRING"},
    "box_2d": {"type": "ARRAY", "items": {"type": "INTEGER"}}, "confidence": {"type": "NUMBER"}},
    "required": ["brand", "box_2d"]}}}, "required": ["items"]}

bilder = sorted((HIER / "bilder_d").glob("cam_*.jpg"))
alle = {}
for m in MODELLE:
    kacheln = []
    for b in bilder:
        body = {"contents": [{"parts": [
            {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(b.read_bytes()).decode()}},
            {"text": PROMPT}]}],
            "generationConfig": {"responseMimeType": "application/json", "responseSchema": SCHEMA, "temperature": 0.1}}
        if "lite" not in m:
            body["generationConfig"]["thinkingConfig"] = {"thinkingLevel": "LOW"}
        t0 = time.time()
        try:
            r = requests.post(f"{API}/models/{m}:generateContent", headers={"x-goog-api-key": KEY}, json=body, timeout=120)
            dt = round(time.time() - t0, 2)
            if r.ok:
                j = r.json()
                items = json.loads("".join(p.get("text", "") for p in j["candidates"][0]["content"]["parts"]))["items"]
                eintrag = {"sekunden": dt, "items": items, "token": j.get("usageMetadata", {}).get("totalTokenCount")}
            else:
                eintrag = {"sekunden": dt, "fehler": r.status_code, "text": r.text[:200]}
        except Exception as e:
            eintrag = {"sekunden": round(time.time() - t0, 2), "fehler": str(e)[:200]}
        alle.setdefault(m, {})[b.name] = eintrag
        bild = cv2.imread(str(b))
        for it in eintrag.get("items", []):
            y0, x0, y1, x1 = (it["box_2d"] + [0, 0, 0, 0])[:4]
            cv2.rectangle(bild, (x0 * 640 // 1000, y0 * 360 // 1000), (x1 * 640 // 1000, y1 * 360 // 1000), (0, 255, 0), 2)
            cv2.putText(bild, it["brand"][:18], (x0 * 640 // 1000 + 3, max(14, y0 * 360 // 1000 - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
        cv2.rectangle(bild, (0, 340), (640, 360), (0, 0, 0), -1)
        cv2.putText(bild, f"{m}  {eintrag['sekunden']}s  {eintrag.get('fehler', '')}", (5, 355), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
        kacheln.append(bild)
        print(f"{m:24s} {b.name:22s} {eintrag['sekunden']:6}s  {[i['brand'] for i in eintrag.get('items', [])] or eintrag.get('fehler')}")
    while len(kacheln) % 3:
        kacheln.append(np.zeros_like(kacheln[0]))
    cv2.imwrite(str(HIER / "bilder_d" / f"boxen_{m}.jpg"), np.vstack([np.hstack(kacheln[i:i + 3]) for i in range(0, len(kacheln), 3)]))
(ERG / "D_live.json").write_text(json.dumps(alle, ensure_ascii=False, indent=2))
