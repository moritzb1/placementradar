"""test_echt.py – Schritt A: Moritz' eigene Handyfotos, vorher/nachher gemessen.

Misst auf den Fotos in tests/echt/fotos/ (Anleitung: tests/echt/LIESMICH.md):
  - Stufe 3 Texterkennung (RapidOCR = dieselben PaddleOCR-Modelle wie im Browser) gegen die Markenliste
      vorher: daten_s3/v1/brands_de_v1.json (868 Marken)  ·  nachher: public/models/brands_de.json
  - Stufe 4 eigenes Modell (MobileCLIP-S1 + Markenkopf) auf dem ganzen Foto bzw. dem Rahmen aus boxen.json
      vorher: daten_s3/v1/brand_head_v1.json (131 Marken)  ·  nachher: public/models/brand_head.{json,bin}
  - Kaskade wie in der App (live.js RANK): Marke exakt gelesen > eigenes Modell (sicher) > Marke mit Tippfehler
Zählt je Foto: richtig / falsch / keine Antwort. Fotos mit Marke „unbekannt" prüfen Fehlalarme (jede Antwort = falsch).
Zusätzlich je Foto eine „Webcam-Fassung" (verkleinert, weichgezeichnet, JPEG), wie im S2-Test.

Lauf:  daten_s3/py tests/test_echt.py            (aus dem Ordner 7_Finales_Projekt)
Aus:   tests/ergebnisse/echt/echt_<datum>.md + .json
"""
import io, json, re, sys, time, unicodedata
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageOps

HERE = Path(__file__).resolve().parent
PROJ = HERE.parent.parent  # project folder outside the repository (daten_s3/ with the v1 model is not published)
APP = HERE.parent          # tests/ lives inside the app repository
FOTOS = HERE / "echt" / "fotos"
OUT = HERE / "ergebnisse" / "echt"


def key(s):
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", str(s).lower()).encode("ascii", "ignore").decode())


# ------------------------------------------------------------------ Fotos + Etiketten
def fotos():
    """Marke aus dem Dateinamen (<Marke>__<frei>.jpg) oder aus etiketten.csv (datei;marke)."""
    labels = {}
    csv = HERE / "echt" / "etiketten.csv"
    if csv.exists():
        for line in csv.read_text(encoding="utf-8").splitlines()[1:]:
            if ";" in line:
                d, m = line.split(";", 1); labels[d.strip()] = m.strip()
    boxes = json.loads((HERE / "echt" / "boxen.json").read_text()) if (HERE / "echt" / "boxen.json").exists() else {}
    out = []
    for p in sorted(FOTOS.rglob("*")):
        if p.suffix.lower() not in (".jpg", ".jpeg", ".png", ".heic", ".webp"):
            continue
        marke = labels.get(p.name) or (p.stem.split("__")[0] if "__" in p.stem else None)
        if not marke:
            print(f"  übersprungen (keine Marke im Namen): {p.name}"); continue
        out.append({"datei": p.name, "pfad": p, "marke": marke, "box": boxes.get(p.name)})
    return out


def lade(p, box=None):
    if p.suffix.lower() == ".heic":
        try:
            from pillow_heif import register_heif_opener; register_heif_opener()
        except ImportError:
            sys.exit("HEIC-Fotos: bitte als JPG exportieren (iPhone: Einstellungen → Kamera → Formate → Maximale Kompatibilität)")
    img = ImageOps.exif_transpose(Image.open(p)).convert("RGB")
    if box:  # [x1, y1, x2, y2] in Pixeln des Originalfotos
        img = img.crop(tuple(box))
    return img


def webcam(img):
    """wie test_s2_*_browser.js degrade(): 640 px, 1 px weich, JPEG 60"""
    img = img.copy(); img.thumbnail((640, 640)); img = img.filter(ImageFilter.GaussianBlur(1))
    b = io.BytesIO(); img.save(b, "JPEG", quality=60); return Image.open(b).convert("RGB")


# ------------------------------------------------------------------ Stufe 3: Text
COMMON = set(("vegan hafer protein proteine bio natur natural milch butter kase cheese joghurt jogurt yogurt quark sahne "
              "schoko choco chocolate kakao cacao vanille vanilla erdbeere strawberry himbeere kirsche apfel banane mango zitrone lemon "
              "orange tomate tomaten honig mandel mandeln nuss nusse nougat haselnuss erdnuss erdnusse kekse keks waffeln waffel chips "
              "linse linsen bohne bohnen erbse erbsen mais reis weizen dinkel roggen vollkorn brot toast salz salzig gesalzen paprika pfeffer zucker sugar original "
              "classic klassik light zero leicht frisch fresh extra mini maxi family familie kinder skyr tofu wasser water saft juice "
              "goldbaren baren minis riegel creme cream mousse dessert pudding griess ohne mit und").split())
LOOK = str.maketrans({"0": "o", "1": "l", "2": "z", "5": "s", "6": "g", "8": "b"})


def lev(a, b, mx):
    if abs(len(a) - len(b)) > mx:
        return mx + 1
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i]
        for j in range(1, len(b) + 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1])))
        if min(cur) > mx:
            return mx + 1
        prev = cur
    return prev[-1]


class Text:
    """wie ocr.js matchBrands (vereinfacht: Einzelwörter + Nachbarpaare in Lesereihenfolge)"""
    def __init__(self):
        from rapidocr_onnxruntime import RapidOCR
        self.ocr = RapidOCR()

    def words(self, img):
        res, _ = self.ocr(np.asarray(img)[:, :, ::-1])
        return [(t, float(s)) for _, t, s in (res or []) if float(s) >= 0.5]

    @staticmethod
    def match(words, brands):
        exact = {b["key"]: b for b in brands}
        cands = [key(t) for t, _ in words] + [key(a[0] + b[0]) for a, b in zip(words, words[1:])]
        found = {}
        for c in cands:
            if len(c) < 2:
                continue
            if c in exact:
                found[exact[c]["key"]] = (exact[c]["name"], True); continue
            if len(c) < 4 or c in COMMON:
                continue
            look = c.translate(LOOK) if re.search("[a-z]", c) else c
            best = None
            for b in brands:
                mx = 2 if len(b["key"]) >= 10 else 1 if len(b["key"]) >= 5 else 0
                if mx and lev(look, b["key"], mx) <= mx and (not best or b["products"] > best["products"]):
                    best = b
            if best and best["key"] not in found:
                found[best["key"]] = (best["name"], False)
        return found  # key → (name, exact)


# ------------------------------------------------------------------ Stufe 4: eigenes Modell
class Own:
    def __init__(self):
        import open_clip, torch
        self.torch = torch
        m, _, _ = open_clip.create_model_and_transforms("MobileCLIP-S1", pretrained="datacompdr")
        self.m = m.eval()

    def fp(self, img):
        torch = self.torch
        s = max(img.size); sq = Image.new("RGB", (s, s), (128, 128, 128)); sq.paste(img, ((s - img.width) // 2, (s - img.height) // 2))
        x = torch.from_numpy(np.asarray(sq.resize((256, 256), Image.BILINEAR), dtype=np.float32) / 255).permute(2, 0, 1)[None]
        with torch.no_grad():
            return torch.nn.functional.normalize(self.m.encode_image(x), dim=-1)[0]


def lade_kopf(path):
    import torch
    h = json.loads(path.read_text())
    if h.get("head"):
        C, D, CZ = h["head"]["classes"], h["head"]["dim"], h["head"]["text_classes"]
        f = np.frombuffer((path.parent / h["head"]["file"]).read_bytes(), dtype="<f2").astype("float32")
        W, b, Z = f[:C * D].reshape(C, D), f[C * D:C * D + C], f[C * D + C:].reshape(CZ, D)
    else:
        W, b, Z = np.array(h["W"], "float32"), np.array(h["b"], "float32"), np.array(h["Z"], "float32")
    other = h["names"].index(h["other"]) if h.get("other") else -1
    return {"names": h["names"], "W": torch.from_numpy(W.copy()), "b": torch.from_numpy(b.copy()), "Z": torch.from_numpy(Z.copy()),
            "rule": h["rule"], "other": other}


def urteil(k, e):
    import torch
    P = torch.softmax(k["W"] @ e + k["b"], -1); c, p = float(P.max()), int(P.argmax())
    if p == k["other"]:
        return None, c
    zs = k["Z"] @ e; rank = int((zs > zs[p]).sum())
    return (k["names"][p] if c >= k["rule"]["min_conf"] and rank < k["rule"]["zero_shot_top"] else None), c


# ------------------------------------------------------------------ Lauf
def main():
    fs = fotos()
    if not fs:
        sys.exit(f"Keine Fotos in {FOTOS} – Anleitung: tests/echt/LIESMICH.md")
    print(f"{len(fs)} Fotos, {len({f['marke'] for f in fs})} Marken")
    text, own = Text(), Own()
    listen = {"vorher": json.loads((PROJ / "daten_s3" / "v1" / "brands_de_v1.json").read_text())["brands"],
              "nachher": json.loads((APP / "public" / "models" / "brands_de.json").read_text())["brands"]}
    koepfe = {"vorher": lade_kopf(PROJ / "daten_s3" / "v1" / "brand_head_v1.json"),
              "nachher": lade_kopf(APP / "public" / "models" / "brand_head.json")}
    rows = []
    for f in fs:
        for fassung in ("foto", "webcam"):
            img = lade(f["pfad"], f["box"])
            if fassung == "webcam":
                img = webcam(img)
            t0 = time.time(); words = text.words(img); e = own.fp(img)
            soll = key(f["marke"]); unbekannt = soll in ("unbekannt", "unknown", "keine", "none")
            r = {"datei": f["datei"], "marke": f["marke"], "fassung": fassung, "gelesen": [w for w, _ in words][:12]}
            for stand in ("vorher", "nachher"):
                hits = Text.match(words, listen[stand])
                modell, conf = urteil(koepfe[stand], e)
                exact = [n for n, ex in hits.values() if ex]; fuzzy = [n for n, ex in hits.values() if not ex]
                gezeigt = exact or ([modell] if modell else fuzzy)
                ok = lambda n: key(n) == soll or (len(soll) >= 4 and (key(n).startswith(soll) or soll.startswith(key(n))))
                r[stand] = {"text": list(n for n, _ in hits.values()), "modell": modell, "modell_conf": round(conf, 3), "gezeigt": gezeigt,
                            "richtig": (not unbekannt) and any(ok(n) for n in gezeigt),
                            "falsch": any(not ok(n) for n in gezeigt) if not unbekannt else bool(gezeigt)}
            r["ms"] = int((time.time() - t0) * 1000)
            rows.append(r)
            print(f"  {fassung:6s} {f['datei'][:40]:40s} soll {f['marke']:18s} vorher {r['vorher']['gezeigt']} → nachher {r['nachher']['gezeigt']}")
    OUT.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d_%H%M")
    (OUT / f"echt_{stamp}.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    md = [f"# Echter Test mit Handyfotos ({time.strftime('%d.%m.%Y %H:%M')})", "",
          f"{len(fs)} Fotos, {len({f['marke'] for f in fs})} Marken. Kaskade wie in der App: Marke exakt gelesen > eigenes Modell > Marke mit Tippfehler.", "",
          "| Fassung | Stand | richtig | falsch | keine Antwort |", "|---|---|---|---|---|"]
    for fassung in ("foto", "webcam"):
        for stand in ("vorher", "nachher"):
            rs = [r for r in rows if r["fassung"] == fassung]
            ri = sum(r[stand]["richtig"] for r in rs); fa = sum(r[stand]["falsch"] for r in rs)
            md.append(f"| {fassung} | {stand} | {ri}/{len(rs)} | {fa} | {sum(not r[stand]['gezeigt'] for r in rs)} |")
    md += ["", "## Je Foto (Fassung foto)", "", "| Foto | Marke | vorher | nachher | Text gelesen |", "|---|---|---|---|---|"]
    for r in rows:
        if r["fassung"] == "foto":
            md.append(f"| {r['datei']} | {r['marke']} | {', '.join(r['vorher']['gezeigt']) or '–'} | {', '.join(r['nachher']['gezeigt']) or '–'} | {' · '.join(r['gelesen'][:6])} |")
    (OUT / f"echt_{stamp}.md").write_text("\n".join(md) + "\n")
    print("\n".join(md[:12]))
    print("→", OUT / f"echt_{stamp}.md")


if __name__ == "__main__":
    main()
