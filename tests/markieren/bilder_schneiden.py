"""
Test M, step 1: cut the contact-sheet screenshots into one JPEG per sampled second (for the marking page).

How the sheets were made (23 Nov, built-in browser of the Claude app, sound off): youtube.com/watch?v=<id>, the page's own
<video> element was paused and seeked every 2 s; 16 frames (360x203 px each + a yellow time label) were drawn onto a 4x4
overlay and the pane was screenshotted. The pane does not allow the page to send pixels to localhost, so the screenshots
(800 px wide) are the only way out – frames are therefore about 200x113 px. They are only for marking by eye.
`raster/zuordnung.txt` lists: video id, first second of the sheet, screenshot file.

    ../../daten_s3/py bilder_schneiden.py [folder with the screenshots]

Video frames are not committed anywhere (copyright) – they stay in this local folder.
"""
import os, sys, shutil
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "raster")
DURATION = {"-pTGc7cIBIA": 858.98, "eLAVGYQCkQI": 462.16, "2CqNFIn1AEo": 588.98}  # seconds, from the <video> element
COLS, CELL_W, CELL_H, IMG_H, STEP, PER_SHEET = 4, 360, 225, 203, 2, 16

for line in open(os.path.join(HERE, "raster", "zuordnung.txt")):
    if not line.strip():
        continue
    vid, t0, name = line.split()
    t0 = int(t0)
    sheet_path = os.path.join(HERE, "raster", f"{vid}_{t0:04d}.jpg")
    if not os.path.exists(sheet_path):  # first run: copy the screenshot next to the mapping under a readable name
        shutil.copy(os.path.join(SRC, name), sheet_path)
    sheet = Image.open(sheet_path).convert("RGB")
    s = sheet.height / 900  # the overlay filled a 1440x900 viewport; the screenshot is scaled down
    out = os.path.join(HERE, "frames", vid)
    os.makedirs(out, exist_ok=True)
    for i in range(PER_SHEET):
        x, y = (i % COLS) * CELL_W * s, (i // COLS) * CELL_H * s
        box = (round(x), round(y), round(x + CELL_W * s), round(y + IMG_H * s))
        if t0 + i * STEP > DURATION[vid]:  # the sheet's last cells are empty
            continue
        crop = sheet.crop(box)
        crop.save(os.path.join(out, f"{t0 + i * STEP:04d}.jpg"), quality=88)
for vid in sorted(os.listdir(os.path.join(HERE, "frames"))):
    print(vid, len(os.listdir(os.path.join(HERE, "frames", vid))), "frames")
