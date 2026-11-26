"""Prüfhilfe für Test E/B: zeichnet Geminis Boxen in die Standbilder und baut eine Kontaktbogen-Grafik.

Aufruf:  python pruefe_boxen.py <E-ergebnis.json> <video.mp4> <ausgabe.jpg> [anzahl]
Das Video liegt nur zur Prüfung im Scratchpad und wird danach gelöscht.
"""
import json, sys, random
import cv2
import numpy as np

erg, video, ziel = sys.argv[1], sys.argv[2], sys.argv[3]
n = int(sys.argv[4]) if len(sys.argv) > 4 else 12
d = json.load(open(erg))["result"]
faelle = [(b["brand"], a) for b in d["brands"] for a in b["appearances"] if a.get("box_2d") and a.get("frame_time")]
random.seed(1)
faelle = random.sample(faelle, min(n, len(faelle)))
cap = cv2.VideoCapture(video)
kacheln = []
for marke, a in faelle:
    cap.set(cv2.CAP_PROP_POS_MSEC, a["frame_s"] * 1000)
    ok, bild = cap.read()
    if not ok:
        continue
    h, w = bild.shape[:2]
    y0, x0, y1, x1 = a["box_2d"]
    cv2.rectangle(bild, (int(x0 / 1000 * w), int(y0 / 1000 * h)), (int(x1 / 1000 * w), int(y1 / 1000 * h)), (0, 255, 0), 2)
    cv2.rectangle(bild, (0, 0), (w, 22), (0, 0, 0), -1)
    cv2.putText(bild, f"{marke} @ {a['frame_time']}", (5, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    kacheln.append(cv2.resize(bild, (426, 240)))
while len(kacheln) % 3:
    kacheln.append(np.zeros_like(kacheln[0]))
zeilen = [np.hstack(kacheln[i:i + 3]) for i in range(0, len(kacheln), 3)]
cv2.imwrite(ziel, np.vstack(zeilen), [cv2.IMWRITE_JPEG_QUALITY, 85])
print(ziel, len(faelle), "Stichproben")
