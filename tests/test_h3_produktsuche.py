"""Test H3: Visuelle Produktsuche („Lens") – Bildausschnitt gegen Galerie echter Produktfotos (Open Food Facts).
CLIP-Bildvektor des Ausschnitts → ähnlichstes Galeriebild → konkretes Produkt + Marke. Kein API-Kontingent.

Aufruf:  CLIP_GEWICHTE=... PYTHONPATH=<testlib> python test_h3_produktsuche.py
"""
import json, os, time
import numpy as np
from PIL import Image
import torch, open_clip
from gemini_common import ERG, HIER

GAL = HIER / "galerie_off"
model, _, prep = open_clip.create_model_and_transforms("ViT-B-32-quickgelu", pretrained=os.environ["CLIP_GEWICHTE"])
model.eval()


def vek(bilder):
    with torch.no_grad():
        f = model.encode_image(torch.stack([prep(b) for b in bilder]))
    return (f / f.norm(dim=-1, keepdim=True)).numpy()


idx = json.load(open(GAL / "index.json"))
t0 = time.time()
G = np.vstack([vek([Image.open(GAL / e["datei"]).convert("RGB") for e in idx[i:i + 64]]) for i in range(0, len(idx), 64)])
print(f"Galerie: {len(idx)} Produktfotos in {time.time() - t0:.1f}s eingebettet")

# Testausschnitte: Rahmen aus Test D (3.1-flash-lite und 3-flash-preview), nur Marken, die es in der Galerie gibt
galerie_marken = {e["marke"] for e in idx}
norm = lambda s: s.lower().replace("!", "").replace("ü", "u").replace(" ", "-")
faelle = []
D = json.load(open(ERG / "D_live.json"))
for modell in ["gemini-3.1-flash-lite", "gemini-3-flash-preview"]:
    for bild, e in D[modell].items():
        for it in e.get("items", []):
            if norm(it["brand"]) in galerie_marken:
                faelle.append((bild, it["brand"], it.get("product", ""), it["box_2d"]))
erg = []
for bild, marke, produkt, (y0, x0, y1, x1) in faelle:
    voll = Image.open(HIER / "bilder_d" / bild).convert("RGB")
    W, H = voll.size
    crop = voll.crop((x0 * W // 1000, y0 * H // 1000, x1 * W // 1000, y1 * H // 1000))
    t = time.time()
    q = vek([crop])[0]
    sim = G @ q
    top = np.argsort(-sim)[:5]
    ms = (time.time() - t) * 1000
    stimmen = {}
    for i in top:
        stimmen[idx[i]["marke"]] = stimmen.get(idx[i]["marke"], 0) + float(sim[i])
    gewinner = max(stimmen, key=stimmen.get)
    ok1 = idx[top[0]]["marke"] == norm(marke)
    erg.append({"bild": bild, "soll": marke, "soll_produkt": produkt, "top1": idx[top[0]]["marke"], "top1_produkt": idx[top[0]]["name"],
                "top1_sim": round(float(sim[top[0]]), 3), "top5_mehrheit": gewinner, "richtig_top1": ok1})
    print(f"{marke:12s} {produkt[:22]:22s} → {idx[top[0]]['marke']:14s} „{idx[top[0]]['name'][:30]}\" sim {sim[top[0]]:.2f} "
          f"| Top-5-Mehrheit {gewinner:12s} {'OK' if ok1 else '--'} ({ms:.0f} ms)")
n = len(erg)
print(f"\nTop-1 Marke richtig: {sum(e['richtig_top1'] for e in erg)}/{n} | Top-5-Mehrheit richtig: {sum(e['top5_mehrheit'] == norm(e['soll']) for e in erg)}/{n}")
(ERG / "H3_produktsuche.json").write_text(json.dumps(erg, ensure_ascii=False, indent=2))
