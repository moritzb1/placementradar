"""train_brand_model.py – our own brand recogniser (stage 4 of the live scanner): train, measure, export.

Idea:  a small pretrained image encoder (Apple MobileCLIP, open weights) turns a package photo into a 512-number
       "fingerprint". We keep the encoder frozen and train only a linear brand head on top (one weight vector
       per brand) – fast to train on a laptop, small to ship, and easy to extend later (new brand = new row).
Data:  tools/train_brand_data.py (Open Food Facts photos, split by product).
Train: every training photo is used clean + in AUG webcam-like variants (crop, tilt, colour, blur, small, JPEG).
Text:  CLIP-type encoders also know brand NAMES. The text fingerprint of "a photo of a <brand> product" is a second
       linear head for free; trained head + alpha × text head is still one matrix (brand_head.json).
Test:  (1) held-back products: clean packshot, original upload, original upload in webcam quality
       (2) the 49 phone photos of the OCR test (never seen in training) – the fair comparison with stage 3
       (3) zero-shot baseline: same encoder, brand names as text, no training at all
Out:   tests/ergebnisse/s2_live/S2_eigenes_modell.json (+ .md written by hand from it)
       with --export <encoder>: public/models/brand_encoder.<i>.bin (float16 ONNX in 20 MB parts, Cloudflare
       allows 25 MiB per file) + brand_head.json
Run:   HF_HOME=<weights> PYTHONPATH=<site-packages> python tools/train_brand_model.py <data dir> [--export MobileCLIP2-S0]
"""
import io, json, random, sys, time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import open_clip, torch
from PIL import Image, ImageFilter, ImageEnhance

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(sys.argv[1])
EXPORT = sys.argv[sys.argv.index("--export") + 1] if "--export" in sys.argv else None
ENCODERS = [EXPORT] if EXPORT else ["MobileCLIP2-S0", "MobileCLIP-S1", "MobileCLIP2-S2"]
PRETRAINED = {"MobileCLIP2-S0": "dfndr2b", "MobileCLIP-S1": "datacompdr", "MobileCLIP2-S2": "dfndr2b"}
SIZE = 256
AUG = 3
THRESH, ZS_TOP = 0.9, 5   # final rule: head ≥ 0.9 sure AND the brand is in the zero-shot top 5 (two opinions agree)
OUT = ROOT.parent / "tests" / "ergebnisse" / "s2_live"
GAL = ROOT.parent / "tests" / "galerie_off"
torch.set_num_threads(8)
DEV = "mps" if torch.backends.mps.is_available() else "cpu"  # Apple GPU for the embedding step
rnd = random.Random(7)


def square(img, fill=(128, 128, 128)):
    """pad to a square instead of cropping, so tall bottles keep their logo – the browser does the same"""
    img = img.convert("RGB")
    s = max(img.size)
    out = Image.new("RGB", (s, s), fill)
    out.paste(img, ((s - img.width) // 2, (s - img.height) // 2))
    return out.resize((SIZE, SIZE), Image.BILINEAR)


def webcam(img, strong=False):
    """make a photo look like a webcam crop: smaller, softer, JPEG artefacts"""
    img = img.convert("RGB")
    img.thumbnail((140, 140) if strong else (220, 220))
    img = img.filter(ImageFilter.GaussianBlur(0.9 if strong else 0.5))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=40 if strong else 60)
    return Image.open(buf).convert("RGB")


def augment(img):
    img = img.convert("RGB")
    w, h = img.size
    f = rnd.uniform(0.75, 1.0)                                        # random crop (box not perfectly tight)
    cw, ch = int(w * f), int(h * rnd.uniform(0.75, 1.0))
    x, y = rnd.randint(0, w - cw), rnd.randint(0, h - ch)
    img = img.crop((x, y, x + cw, y + ch)).rotate(rnd.uniform(-15, 15), expand=True, fillcolor=(128, 128, 128))
    img = ImageEnhance.Brightness(img).enhance(rnd.uniform(0.6, 1.3))
    img = ImageEnhance.Color(img).enhance(rnd.uniform(0.7, 1.3))
    img = ImageEnhance.Contrast(img).enhance(rnd.uniform(0.7, 1.2))
    return webcam(img, strong=rnd.random() < 0.5) if rnd.random() < 0.7 else img


def load(name):
    m, _, _ = open_clip.create_model_and_transforms(name, pretrained=PRETRAINED[name])
    return m.eval().to(DEV), open_clip.get_tokenizer(name)


def to_tensor(imgs):
    a = np.stack([np.asarray(square(i), dtype=np.float32) / 255.0 for i in imgs])  # MobileCLIP: mean 0, std 1
    return torch.from_numpy(a).permute(0, 3, 1, 2)


@torch.no_grad()
def embed(model, imgs, bs=64):
    out = []
    for i in range(0, len(imgs), bs):
        f = model.encode_image(to_tensor(imgs[i:i + bs]).to(DEV))
        out.append(torch.nn.functional.normalize(f, dim=-1).float().cpu())
    return torch.cat(out)


def train_head(X, y, n_cls, epochs=300):
    """multinomial logistic regression on the frozen fingerprints (plain softmax layer, weight decay)"""
    torch.manual_seed(0)
    head = torch.nn.Linear(X.shape[1], n_cls)
    opt = torch.optim.AdamW(head.parameters(), lr=0.01, weight_decay=1e-4)
    scale = 30.0  # fingerprints are unit length → stretch logits so softmax can become confident
    for _ in range(epochs):
        perm = torch.randperm(len(X))
        for i in range(0, len(X), 512):
            idx = perm[i:i + 512]
            loss = torch.nn.functional.cross_entropy(head(X[idx] * scale), y[idx], label_smoothing=0.05)
            opt.zero_grad(); loss.backward(); opt.step()
    return head, scale


def scores(head, scale, X):
    with torch.no_grad():
        return torch.softmax(head(X * scale), -1)


def report(P, y, names, label, other=None):
    conf, pred = P.max(-1)
    if other is not None:   # "(other brand)" is not an answer → count as silent
        conf = torch.where(pred == other, torch.zeros_like(conf), conf)
    res = {"n": len(y), "top1": round((pred == y).float().mean().item(), 3),
           "top5": round((P.topk(5, -1).indices == y[:, None]).any(-1).float().mean().item(), 3)}
    for t in (0.5, 0.7, 0.8, 0.9, 0.95):   # only answer when sure: how many answered, how many of those wrong
        sel = conf >= t
        res[f"answered@{t}"] = round(sel.float().mean().item(), 3)
        res[f"wrong@{t}"] = int(((pred != y) & sel).sum())
    print(f"  {label:34s} top1 {res['top1']:.3f}  top5 {res['top5']:.3f}  "
          f"@0.7 answered {res['answered@0.7']:.2f} wrong {res['wrong@0.7']}", flush=True)
    return res


def main():
    idx = json.loads((DATA / "index.json").read_text())
    names = sorted({d["brand"] for d in idx}, key=str.lower)
    keys = {d["key"]: d["brand"] for d in idx}
    cid = {n: i for i, n in enumerate(names)}
    print(f"{len(names)} brands, {len(idx)} products")

    tr = [(DATA / "img" / f, cid[d["brand"]]) for d in idx if d["split"] == "train" for f in d["files"]]
    te = [(d, f) for d in idx if d["split"] == "test" for f in d["files"]]
    te_f = [(DATA / "img" / f, cid[d["brand"]]) for d, f in te if f.endswith("_f.jpg")]
    te_o = [(DATA / "img" / f, cid[d["brand"]]) for d, f in te if f.endswith("_o.jpg")]

    # the 49 OCR test photos → map their gallery brand to our class names (by normalised key)
    import re, unicodedata
    def k(s): return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", s.lower()).encode("ascii", "ignore").decode())
    gal = {e["code"]: e for e in json.loads((GAL / "index.json").read_text())}
    ocr_q = []
    for p in sorted((GAL / "anfragen").glob("*.jpg")):
        e = gal.get(p.stem)
        kk = k(e["marke"]) if e else None
        if kk in keys:
            ocr_q.append((p, cid[keys[kk]], e["marke"]))
    ocr_missing = 49 - len(ocr_q)
    ocr_fail = {"cocacola", "kinder", "babybel", "danone", "rewebestewahl", "milbona", "oreo"}  # brands of the 12 OCR misses

    results = {"brands": len(names), "products": len(idx), "train_photos": len(tr), "aug_per_photo": AUG,
               "test_products": len({d['code'] for d, _ in te}), "ocr_test_photos_with_known_brand": len(ocr_q),
               "ocr_test_photos_brand_not_in_model": ocr_missing, "encoders": {}}
    for enc in ENCODERS:
        print(f"\n== {enc}")
        model, tok = load(enc)
        cache = DATA / f"emb_{enc}.pt"   # fingerprints are expensive (minutes), the heads are cheap → cache
        if cache.exists():
            E = torch.load(cache)
        else:
            t0 = time.time()
            imgs = [Image.open(p).convert("RGB") for p, _ in tr]
            E = {"train": embed(model, imgs + [augment(i) for _ in range(AUG) for i in imgs])}
            E["packshot"] = embed(model, [Image.open(p) for p, _ in te_f])
            E["original"] = embed(model, [Image.open(p) for p, _ in te_o])
            E["original_webcam"] = embed(model, [webcam(Image.open(p), strong=True) for p, _ in te_o])
            q_ims = [Image.open(p) for p, _, _ in ocr_q]
            E["ocr49"] = embed(model, q_ims)
            E["ocr49_webcam"] = embed(model, [webcam(i) for i in q_ims])
            print(f"  embedded {len(E['train'])} training views + test sets in {time.time() - t0:.0f}s")
            torch.save(E, cache)
        uc = DATA / f"emb_unknown_{enc}.pt"  # packs of brands the model does not know (false-alarm test)
        if not uc.exists():
            unk = json.loads((DATA / "index_unknown.json").read_text())
            torch.save(embed(model, [Image.open(DATA / "img" / u["files"][0]) for u in unk]), uc)
        E["unknown"] = torch.load(uc)
        oc = DATA / f"emb_other_{enc}.pt"    # training packs of other brands → class "(other)"
        oth = [DATA / "img" / f for u in json.loads((DATA / "index_other.json").read_text()) for f in u["files"]]
        if not oc.exists():
            ims = [Image.open(p).convert("RGB") for p in oth]
            torch.save(embed(model, ims + [augment(i) for _ in range(AUG) for i in ims]), oc)
        E["other"] = torch.load(oc)
        with torch.no_grad():  # text fingerprints of the brand names (what CLIP already knows without training)
            T = torch.nn.functional.normalize(model.encode_text(tok([f"a photo of a {n} product" for n in names]).to(DEV)), dim=-1).float().cpu()
            ls = float(model.logit_scale.exp())
        y = torch.tensor([c for _, c in tr] * (AUG + 1))
        n, OTHER = len(names), len(names)
        head, scale = train_head(E["train"], y, n)
        Wh, bh = head.weight.detach() * scale, head.bias.detach()  # head(X*scale) = X·(W*scale) + b
        # same head, plus the class "(other brand)" learnt from 1,400 photos of non-class brands
        head2, _ = train_head(torch.cat([E["train"], E["other"]]), torch.cat([y, torch.full((len(E["other"]),), OTHER)]), n + 1)
        Wo, bo = head2.weight.detach() * scale, head2.bias.detach()
        To = torch.cat([T, torch.zeros(1, T.shape[1])])  # the text head has no opinion about "(other)"
        Y = {"packshot": torch.tensor([c for _, c in te_f]), "original": torch.tensor([c for _, c in te_o]),
             "original_webcam": torch.tensor([c for _, c in te_o]),
             "ocr49": torch.tensor([c for _, c, _ in ocr_q]), "ocr49_webcam": torch.tensor([c for _, c, _ in ocr_q])}
        fail_idx = [i for i, (_, _, m) in enumerate(ocr_q) if k(m) in ocr_fail]

        def variant(W, b):  # both heads are linear in the fingerprint → their sum is ONE linear head
            return lambda X: torch.softmax(X @ W.T + b, -1)
        # alpha = weight of the text knowledge; chosen on the held-back products (NOT on the 49 OCR photos)
        best = max((0.0, 0.25, 0.5, 1.0, 2.0), key=lambda a: (variant(Wh + a * ls * T, bh)(E["original"]).argmax(-1) == Y["original"]).float().mean())
        r = {"visual_params_M": round(sum(p.numel() for p in model.visual.parameters()) / 1e6, 1), "alpha_text": best}
        final = (Wo + best * ls * To, bo)  # tried: did not lower false alarms (see EVALUATION.md) → not exported
        for vname, (W, b), oth_i in [("zero-shot (no training)", (ls * T, torch.zeros(n)), None), ("trained head", (Wh, bh), None),
                                     (f"trained head + text (alpha {best})", (Wh + best * ls * T, bh), None),
                                     (f"trained head + text + other-brand class", final, OTHER)]:
            print(f" -- {vname}")
            f = variant(W, b); r[vname] = {}
            for part in ["packshot", "original", "original_webcam", "ocr49", "ocr49_webcam"]:
                P = f(E[part]); r[vname][part] = report(P, Y[part], names, part, oth_i)
                if part.startswith("ocr49") and fail_idx:  # photos of the brands OCR could not read
                    r[vname][part + "_logo_store_brands"] = report(P[fail_idx], Y[part][fail_idx], names, "  only logo/store brands", oth_i)
                if part == "ocr49":
                    cu, pu = f(E["unknown"]).max(-1)  # unknown brand: every brand answer is a false alarm
                    if oth_i is not None:
                        cu = torch.where(pu == oth_i, torch.zeros_like(cu), cu)
                    r[vname]["unknown_brands"] = {"n": len(cu), **{f"false_alarm@{t}": round(float((cu >= t).float().mean()), 3) for t in (0.5, 0.7, 0.8, 0.9, 0.95)}}
                    print(f"  unknown brands ({len(cu)}): false alarm " + "  ".join(f"@{t} {r[vname]['unknown_brands'][f'false_alarm@{t}']:.2f}" for t in (0.5, 0.7, 0.8, 0.9, 0.95)))
                    conf, pred = P.max(-1)
                    nm = names + ["(other)"]
                    r[vname]["per_photo"] = [{"photo": p.name, "brand": names[c], "pred": nm[int(pp)], "conf": round(float(cc), 3)}
                                             for (p, c, _), pp, cc in zip(ocr_q, pred, conf)]
        # Final rule used in the browser: confident head AND agreement with the text-only (zero-shot) opinion.
        W, b = Wh + best * ls * T, bh
        def rule(X):
            P = torch.softmax(X @ W.T + b, -1); c, p = P.max(-1)
            ok = (c >= THRESH) & ((X @ T.T).topk(ZS_TOP, -1).indices == p[:, None]).any(-1)
            return ok, p
        g = r[f"final: head + text, >= {THRESH} and zero-shot top {ZS_TOP} agrees"] = {}
        print(f" -- final rule (>= {THRESH}, zero-shot top {ZS_TOP})")
        for part in ["packshot", "original", "original_webcam", "ocr49", "ocr49_webcam"]:
            ok, p = rule(E[part]); Yp = Y[part]
            g[part] = {"n": len(Yp), "answered": round(ok.float().mean().item(), 3), "right": int((ok & (p == Yp)).sum()),
                       "wrong": int((ok & (p != Yp)).sum())}
            print(f"  {part:20s} answered {g[part]['answered']:.2f}  right {g[part]['right']}  wrong {g[part]['wrong']}  of {len(Yp)}")
            if part == "ocr49":
                g["per_photo"] = [{"photo": q.name, "brand": names[c], "pred": names[int(pp)] if o else None}
                                  for (q, c, _), pp, o in zip(ocr_q, p, ok)]
        ok, _ = rule(E["unknown"])
        g["unknown_brands_false_alarm"] = round(ok.float().mean().item(), 3)
        print(f"  unknown brands: false alarm {g['unknown_brands_false_alarm']:.2f}")
        results["encoders"][enc] = r
        if EXPORT:
            export(model, Wh + best * ls * T, bh, ls * T, names, enc)
    OUT.mkdir(parents=True, exist_ok=True)
    dst = OUT / ("S2_eigenes_modell_export.json" if EXPORT else "S2_eigenes_modell.json")
    dst.write_text(json.dumps(results, ensure_ascii=False, indent=1))
    print("→", dst)


def export(model, W, b, Z, names, enc):
    import onnx
    from onnxruntime.transformers.float16 import convert_float_to_float16

    class Visual(torch.nn.Module):
        def __init__(self, m):
            super().__init__(); self.m = m
        def forward(self, x):  # x: [1,3,256,256] RGB 0..1 → unit-length fingerprint [1,512]
            return torch.nn.functional.normalize(self.m.encode_image(x), dim=-1)

    from timm.utils.model import reparameterize_model  # MobileCLIP: fold training branches into single convs
    m = reparameterize_model(model.cpu())
    tmp = DATA / "encoder_fp32.onnx"
    torch.onnx.export(Visual(m).eval(), torch.zeros(1, 3, SIZE, SIZE), str(tmp), input_names=["image"],
                      output_names=["embedding"], opset_version=17, dynamo=False)
    fp16 = DATA / "encoder_fp16.onnx"
    onnx.save(convert_float_to_float16(onnx.load(str(tmp)), keep_io_types=True), str(fp16))
    # check: the browser file must give the same fingerprints as PyTorch
    import onnxruntime as ort
    sess = ort.InferenceSession(str(fp16))
    probe = to_tensor([Image.open(p) for p in sorted((GAL / "anfragen").glob("*.jpg"))[:16]])
    with torch.no_grad():
        ref = torch.nn.functional.normalize(m.encode_image(probe), dim=-1).numpy()
    got = np.concatenate([sess.run(None, {"image": probe[i:i + 1].numpy()})[0] for i in range(len(probe))])
    print(f"  ONNX float16 vs PyTorch: cosine min {float((ref * got).sum(1).min()):.4f}")
    # Cloudflare serves at most 25 MiB per static file → store the model in parts, the browser joins them
    raw, part, parts = fp16.read_bytes(), 20 * 1024 * 1024, []
    for old in (ROOT / "public" / "models").glob("brand_encoder*"):
        old.unlink()
    for i in range(0, len(raw), part):
        dst = ROOT / "public" / "models" / f"brand_encoder.{len(parts)}.bin"
        dst.write_bytes(raw[i:i + part]); parts.append(dst.name)
    print(f"→ {len(parts)} parts, {len(raw) // 1024} KB")
    W = W.numpy().round(4).tolist()
    b = b.numpy().round(4).tolist()
    Z = Z.numpy().round(3).tolist()
    (ROOT / "public" / "models" / "brand_head.json").write_text(json.dumps({
        "encoder": enc, "parts": parts, "input": [1, 3, SIZE, SIZE], "preprocess": "pad to square with grey 128, resize, RGB/255",
        "built": time.strftime("%Y-%m-%d"), "names": names, "W": W, "b": b, "Z": Z,
        "rule": {"min_conf": THRESH, "zero_shot_top": ZS_TOP},
        "note": "brand head: softmax(W·e + b). Z = brand-name text fingerprints × CLIP scale (zero-shot opinion). "
                "Answer only if the head is >= min_conf sure AND its brand is among the zero_shot_top best of Z·e."},
        separators=(",", ":")))


if __name__ == "__main__":
    main()
