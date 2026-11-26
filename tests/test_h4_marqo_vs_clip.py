"""Test H4: Produktsuche – Allzweck-CLIP gegen Marqo-Ecommerce-B (auf Produkte spezialisiert).

Galerie  = freigestellte Packungsfotos aus Open Food Facts (galerie_off/, 377 Produkte, 17 Marken).
Anfragen = die ORIGINAL-Handyfotos derselben Produkte (unbeschnitten, mit Hintergrund, Hand, Regal …),
           zusätzlich künstlich verschlechtert (klein, unscharf, JPEG) wie ein Webcam-Bild.
Achtung: Das Anfragefoto ist dieselbe Aufnahme wie das Galeriebild, nur unbeschnitten → leichter als die Wirklichkeit.
Gemessen: Marke richtig (Top-1), exaktes Produkt richtig (Top-1 / Top-5), Zeit pro Bild.

Aufruf:  CLIP_GEWICHTE=... MARQO_DIR=... PYTHONPATH=<testlib> python test_h4_marqo_vs_clip.py
"""
import io, json, os, random, subprocess, time
import numpy as np
from PIL import Image, ImageFilter
import torch, open_clip
from gemini_common import ERG, HIER

GAL = HIER / "galerie_off"
ANF = HIER / "galerie_off" / "anfragen"
ANF.mkdir(exist_ok=True)
UA = "PlacementRadar-CourseProject/0.1"
idx = json.load(open(GAL / "index.json"))

# --- 1. Anfragebilder holen: unbeschnittenes Originalfoto der Vorderseite --------------------------------
def anfrage_holen(e):
    ziel = ANF / f"{e['code']}.jpg"
    if ziel.exists():
        return True
    out = subprocess.run(["curl", "-s", "-m", "30", "-A", UA,
                          f"https://world.openfoodfacts.org/api/v2/product/{e['code']}.json?fields=images"],
                         capture_output=True, text=True).stdout
    try:
        bilder = json.loads(out)["product"]["images"]
    except Exception:
        return False
    front = next((v for k, v in bilder.items() if k.startswith("front") and isinstance(v, dict) and v.get("imgid")), None)
    if not front:
        return False
    pfad = e["url"].split("/images/products/")[1].rsplit("/", 1)[0]
    subprocess.run(["curl", "-s", "-m", "30", "-A", UA, "-o", str(ziel),
                    f"https://images.openfoodfacts.org/images/products/{pfad}/{front['imgid']}.400.jpg"])
    time.sleep(2.0)  # Open Food Facts: max. ~100 Produktabfragen pro Minute
    return ziel.exists() and ziel.stat().st_size > 2000

random.seed(7)
stichprobe = random.sample(idx, min(150, len(idx)))
faelle = [e for e in stichprobe if anfrage_holen(e)]
print(f"Anfragebilder: {len(faelle)}")


def webcam(b):
    """macht ein Foto schlechter: klein, leicht unscharf, starke JPEG-Kompression"""
    b = b.convert("RGB")
    b.thumbnail((180, 180))
    b = b.filter(ImageFilter.GaussianBlur(0.8))
    buf = io.BytesIO()
    b.save(buf, "JPEG", quality=45)
    return Image.open(buf)


# --- 2. Modelle ----------------------------------------------------------------------------------------
def lade_clip():
    m, _, p = open_clip.create_model_and_transforms("ViT-B-32-quickgelu", pretrained=os.environ["CLIP_GEWICHTE"])
    return m.eval(), p


def lade_marqo():
    cfg = json.load(open(os.path.join(os.environ["MARQO_DIR"], "open_clip_config.json")))
    pfad = os.path.join(os.environ["MARQO_DIR"], "Marqo-Ecommerce-B.json")
    json.dump(cfg["model_cfg"], open(pfad, "w"))
    open_clip.add_model_config(pfad)
    m, _, p = open_clip.create_model_and_transforms(
        "Marqo-Ecommerce-B", pretrained=os.path.join(os.environ["MARQO_DIR"], "open_clip_model.safetensors"),
        image_mean=cfg["preprocess_cfg"]["mean"], image_std=cfg["preprocess_cfg"]["std"],
        image_interpolation=cfg["preprocess_cfg"]["interpolation"], image_resize_mode=cfg["preprocess_cfg"]["resize_mode"])
    return m.eval(), p


def vek(m, p, bilder):
    with torch.no_grad():
        f = m.encode_image(torch.stack([p(b.convert("RGB")) for b in bilder]))
    return (f / f.norm(dim=-1, keepdim=True)).numpy()


ergebnis = {}
for name, lader in [("CLIP ViT-B/32 (Allzweck)", lade_clip), ("Marqo-Ecommerce-B", lade_marqo)]:
    m, p = lader()
    G = np.vstack([vek(m, p, [Image.open(GAL / e["datei"]) for e in idx[i:i + 32]]) for i in range(0, len(idx), 32)])
    codes = [e["code"] for e in idx]
    for variante in ["Handyfoto", "Webcam-Qualität"]:
        t0 = time.time()
        Q = vek(m, p, [webcam(Image.open(ANF / f"{e['code']}.jpg")) if variante != "Handyfoto" else Image.open(ANF / f"{e['code']}.jpg") for e in faelle])
        ms = (time.time() - t0) / len(faelle) * 1000
        S = Q @ G.T
        top = np.argsort(-S, axis=1)[:, :5]
        marke1 = np.mean([idx[top[i, 0]]["marke"] == faelle[i]["marke"] for i in range(len(faelle))])
        prod1 = np.mean([codes[top[i, 0]] == faelle[i]["code"] for i in range(len(faelle))])
        prod5 = np.mean([faelle[i]["code"] in [codes[j] for j in top[i]] for i in range(len(faelle))])
        ergebnis[f"{name} | {variante}"] = {"marke_top1": round(marke1, 3), "produkt_top1": round(prod1, 3), "produkt_top5": round(prod5, 3), "ms_pro_bild": round(ms)}
        print(f"{name:26s} {variante:16s} Marke Top-1 {marke1:5.1%} | Produkt Top-1 {prod1:5.1%} | Produkt Top-5 {prod5:5.1%} | {ms:.0f} ms/Bild (CPU)")
(ERG / "H4_marqo_vs_clip.json").write_text(json.dumps({"n": len(faelle), "galerie": len(idx), "ergebnis": ergebnis}, ensure_ascii=False, indent=2))
