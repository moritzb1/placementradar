"""Test H2: Marken OHNE Gemini erkennen – CLIP (Bild↔Markenname) + OCR (Schriftzug lesen).
Die Ausschnitte stammen aus den Rahmen von Test D (stellvertretend für YOLO-Rahmen im Live-Modus).

Aufruf:  PYTHONPATH=<testlib> python test_h2_clip_ocr.py
Ergebnis: ergebnisse/H2_clip_ocr.json
"""
import json, os, time, re
from difflib import SequenceMatcher
import numpy as np
from PIL import Image
import torch, open_clip
from rapidocr_onnxruntime import RapidOCR
from gemini_common import ERG, HIER

MARKEN = ["Lidl", "REWE", "Aldi", "Edeka", "Kaufland", "Penny", "Netto", "dm", "Rossmann", "HEAD", "Nike", "Adidas", "Puma",
          "Louis Vuitton", "Gucci", "Guess", "Michael Kors", "Chanel", "e.l.f.", "Dyson", "Apple", "Samsung", "BMW", "Volvo",
          "Mercedes-Benz", "Audi", "Volkswagen", "Tesla", "Coca-Cola", "Pepsi", "Red Bull", "Monster Energy", "Nutella",
          "Babybel", "Milka", "Haribo", "Oreo", "L'Oréal", "Nivea", "Maybelline", "Tarte", "Rare Beauty", "Glow Recipe",
          "Tide", "Oral-B", "Colgate", "Labello", "Sony", "Starbucks", "McDonald's", "IKEA", "Amazon", "Ja!", "Milbona",
          "Grafschafter", "Skyr", "Zara", "H&M", "Hello Kitty", "Kate Spade"]
SCHWELLE = 0.30  # darunter: „unbekannt" → in der App würde dann Gemini gefragt

model, _, prep = open_clip.create_model_and_transforms("ViT-B-32-quickgelu", pretrained=os.environ["CLIP_GEWICHTE"])  # gleiche Gewichte wie im Browser (transformers.js)
tok = open_clip.get_tokenizer("ViT-B-32")
model.eval()
with torch.no_grad():
    texte = tok([f"a photo of the {m} logo or a {m} product" for m in MARKEN])
    tf = model.encode_text(texte)
    tf /= tf.norm(dim=-1, keepdim=True)
ocr = RapidOCR()


def ocr_marke(bild):
    res, _ = ocr(np.array(bild))
    woerter = [r[1] for r in (res or [])]
    best, wert = None, 0
    for w in woerter:
        for m in MARKEN:
            a, b = re.sub(r"\W", "", w.lower()), re.sub(r"\W", "", m.lower())
            if len(a) < 2 or len(b) < 2:
                continue
            s = 1.0 if b in a or a == b else SequenceMatcher(None, a, b).ratio()
            if s > wert:
                best, wert = m, s
    return (best if wert >= 0.8 else None), woerter


d = json.load(open(ERG / "D_live.json"))["gemini-3.1-flash-lite"]
erg = []
for bildname, e in d.items():
    voll = Image.open(HIER / "bilder_d" / bildname).convert("RGB")
    W, H = voll.size
    for it in e.get("items", []):
        y0, x0, y1, x1 = it["box_2d"]
        box = (x0 * W // 1000, y0 * H // 1000, x1 * W // 1000, y1 * H // 1000)
        if box[2] - box[0] < 12 or box[3] - box[1] < 12:
            continue
        crop = voll.crop(box)
        t0 = time.time()
        with torch.no_grad():
            f = model.encode_image(prep(crop).unsqueeze(0))
            f /= f.norm(dim=-1, keepdim=True)
            p = (100 * f @ tf.T).softmax(-1)[0]
        tclip = time.time() - t0
        i = int(p.argmax())
        t1 = time.time()
        om, woerter = ocr_marke(crop)
        tocr = time.time() - t1
        clip_m = MARKEN[i] if float(p[i]) >= SCHWELLE else None
        final = om or clip_m
        soll = it["brand"]
        ok = final is not None and re.sub(r"\W", "", final.lower()) == re.sub(r"\W", "", soll.lower())
        erg.append({"bild": bildname, "soll": soll, "clip": MARKEN[i], "clip_p": round(float(p[i]), 2), "ocr": om,
                    "ocr_text": woerter[:4], "final": final, "richtig": ok, "ms_clip": int(tclip * 1000), "ms_ocr": int(tocr * 1000)})
        print(f"{soll:14s} | CLIP {MARKEN[i]:14s} {float(p[i]):.2f} | OCR {str(om):12s} {woerter[:3]} | -> {str(final):14s} {'OK' if ok else '--'} "
              f"({int(tclip*1000)}+{int(tocr*1000)} ms)")
n = len(erg)
print(f"\nrichtig: {sum(e['richtig'] for e in erg)}/{n} | nur CLIP richtig: {sum(re.sub(chr(92)+'W','',e['clip'].lower())==re.sub(chr(92)+'W','',e['soll'].lower()) for e in erg)}/{n}"
      f" | nur OCR richtig: {sum(bool(e['ocr']) and e['ocr'].lower()==e['soll'].lower() for e in erg)}/{n} | unbekannt (→ Gemini): {sum(e['final'] is None for e in erg)}")
(ERG / "H2_clip_ocr.json").write_text(json.dumps(erg, ensure_ascii=False, indent=2))
