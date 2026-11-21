"""train_brand_model_v2.py – brand model v2 (stage 4 of the live scanner): ~1,000 brands, webcam-trained,
recalibrated, measured against v1 on the SAME test data, exported for the browser.

What changed against v1 (tools/train_brand_model.py, 131 brands):
  B  more brands: ~1,000 classes from the full Open Food / Beauty / Products Facts dumps (tools/build_brand_data.py)
  C  webcam robustness: every training photo is also seen in AUG random webcam views (tools/camaug.py: crop jitter,
     perspective, tilt, hand over the pack, glare, light/colour cast, motion/defocus blur, low resolution, JPEG);
     hard negatives: packs of OTHER brands that the head confuses with one of ours become the extra class "(other)";
     thresholds are recalibrated on a validation split (never on the test sets) for a target false-alarm rate.
  D  optional: crops that Gemini / Workers AI named in the live scanner (tools/teach_pull.py → --teach <dir>).
The image encoder stays the same frozen MobileCLIP-S1 as in v1 → the browser keeps the same 42 MB model files;
only the head changes (now a binary float16 file, ~2 MB for 1,000 brands instead of JSON).

Measured (all on fingerprints of the same encoder, so v1 and v2 differ ONLY in the head):
  v1 test  : v1's 741 held-back products (packshot / original / original in v1's webcam quality)
  v2 test  : ~5,700 held-back products of the ~1,000 brands (packshot / original / original as a fixed webcam view)
  unknown  : packs of brands neither model knows (v1's 146 + 400 new)  → false-alarm rate
  lookalike: the 300 foreign packs whose fingerprint is closest to one of our brands → hard false-alarm rate
  ocr49    : the 49 phone photos of the OCR test (brand known to the model)
Out:  tests/ergebnisse/s4_erkennung/S4_markenmodell_v2.json
      with --export: public/models/brand_head.bin + brand_head.json (encoder parts unchanged)
Run:  daten_s3/py tools/train_brand_model_v2.py <daten_s3> [--export] [--teach <dir>] [--aug 3]
"""
import json, multiprocessing as mp, random, re, sys, time, unicodedata, zlib
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from camaug import cam_test, cam_view  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(sys.argv[1])
V1DATA = ROOT.parent / "daten_s2"
OUT = ROOT.parent / "tests" / "ergebnisse" / "s4_erkennung"
GAL = ROOT.parent / "tests" / "galerie_off"
ENC, PRE = "MobileCLIP-S1", "datacompdr"
SIZE = 256
AUG = int(sys.argv[sys.argv.index("--aug") + 1]) if "--aug" in sys.argv else 3
TEACH = Path(sys.argv[sys.argv.index("--teach") + 1]) if "--teach" in sys.argv else None
TARGET_FA = float(sys.argv[sys.argv.index("--fa") + 1]) if "--fa" in sys.argv else 0.025  # calibration goal: share of foreign packs that may get a brand (validation)
DEV = "mps" if torch.backends.mps.is_available() else "cpu"
torch.set_num_threads(8)


def seed(*a):
    """stable seed (Python's hash() of strings changes between runs)"""
    return zlib.crc32(repr(a).encode()) & 0x7FFFFFFF


def key(s):
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", s.lower()).encode("ascii", "ignore").decode())


# ---------------------------------------------------------------- images → fingerprints
def square(img):
    img = img.convert("RGB")
    s = max(img.size)
    out = Image.new("RGB", (s, s), (128, 128, 128))
    out.paste(img, ((s - img.width) // 2, (s - img.height) // 2))
    return out.resize((SIZE, SIZE), Image.BILINEAR)


def _prep(job):
    """worker process: (path, mode, seed) → 256×256 uint8 array. mode: clean | aug | camtest | v1webcam"""
    path, mode, seed = job
    try:
        img = Image.open(path).convert("RGB")
    except Exception:
        img = Image.new("RGB", (64, 64), (128, 128, 128))
    if mode == "aug":
        img = cam_view(img, random.Random(seed))
    elif mode == "camtest":
        img = cam_test(img, seed)
    elif mode == "v1webcam":  # v1's webcam degradation (tools/train_brand_model.py webcam(strong=True))
        import io
        from PIL import ImageFilter
        img.thumbnail((140, 140)); img = img.filter(ImageFilter.GaussianBlur(0.9))
        b = io.BytesIO(); img.save(b, "JPEG", quality=40); img = Image.open(b).convert("RGB")
    return np.asarray(square(img), dtype=np.uint8)


_MODEL = None


def model():
    global _MODEL
    if _MODEL is None:
        import open_clip
        m, _, _ = open_clip.create_model_and_transforms(ENC, pretrained=PRE)
        _MODEL = (m.eval().to(DEV), open_clip.get_tokenizer(ENC))
    return _MODEL


@torch.no_grad()
def embed(jobs, label, bs=128):
    """jobs: [(path, mode, seed)] → [N,512] unit-length fingerprints (images prepared by 8 processes)"""
    m, _ = model()
    out, t0 = [], time.time()
    with mp.get_context("spawn").Pool(8) as pool:
        for i in range(0, len(jobs), bs * 8):
            arrs = pool.map(_prep, jobs[i:i + bs * 8], chunksize=16)
            for j in range(0, len(arrs), bs):
                x = torch.from_numpy(np.stack(arrs[j:j + bs])).permute(0, 3, 1, 2).float().div(255).to(DEV)
                out.append(torch.nn.functional.normalize(m.encode_image(x), dim=-1).float().cpu())
            print(f"  {label}: {min(i + bs * 8, len(jobs))}/{len(jobs)} ({time.time() - t0:.0f}s)", flush=True)
    return torch.cat(out) if out else torch.zeros(0, 512)


def cached(name, jobs):
    p = DATA / "emb" / f"{name}.pt"
    p.parent.mkdir(exist_ok=True)
    if p.exists():
        return torch.load(p)
    E = embed(jobs, name)
    torch.save(E, p)
    return E


@torch.no_grad()
def text_fp(names):
    m, tok = model()
    T = torch.cat([torch.nn.functional.normalize(m.encode_text(tok([f"a photo of a {n} product" for n in names[i:i + 256]]).to(DEV)), dim=-1).float().cpu()
                   for i in range(0, len(names), 256)])
    return T, float(m.logit_scale.exp())


# ---------------------------------------------------------------- head
def train_head(X, y, n_cls, epochs=40, weight=None):
    """multinomial logistic regression on frozen fingerprints (one linear layer, AdamW, label smoothing)"""
    torch.manual_seed(0)
    X, y = X.to(DEV), y.to(DEV)
    head = torch.nn.Linear(X.shape[1], n_cls).to(DEV)
    opt = torch.optim.AdamW(head.parameters(), lr=0.01, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
    w = None if weight is None else weight.to(DEV)
    for _ in range(epochs):
        perm = torch.randperm(len(X), device=DEV)
        for i in range(0, len(X), 1024):
            idx = perm[i:i + 1024]
            loss = torch.nn.functional.cross_entropy(head(X[idx] * 30.0), y[idx], label_smoothing=0.05, reduction="none")
            loss = (loss * w[idx]).mean() if w is not None else loss.mean()
            opt.zero_grad(); loss.backward(); opt.step()
        sched.step()
    return (head.weight.detach().cpu() * 30.0, head.bias.detach().cpu())


class Rule:
    """answer only if the head is ≥ min_conf sure, its brand is among the zs_top best text matches, and not '(other)'"""
    def __init__(self, W, b, Z, other=None, min_conf=0.9, zs_top=5):
        self.W, self.b, self.Z, self.other, self.min_conf, self.zs_top = W, b, Z, other, min_conf, zs_top

    def __call__(self, X):
        P = torch.softmax(X @ self.W.T + self.b, -1)
        c, p = P.max(-1)
        ok = c >= self.min_conf
        if self.other is not None:
            ok &= p != self.other
        n = self.Z.shape[0]
        zs = X @ self.Z.T
        pz = p.clamp(max=n - 1)
        rank = (zs > zs.gather(1, pz[:, None])).sum(-1)
        ok &= (rank < self.zs_top) & (p < n)
        return ok, p, c


def measure(rule, X, y, names_rule, names_truth=None):
    """y: index into names_truth (or the rule's own names). Right = same brand KEY."""
    ok, p, _ = rule(X)
    tk = [key(n) for n in (names_truth or names_rule)]
    rk = [key(n) for n in names_rule]
    right = sum(1 for o, pp, yy in zip(ok.tolist(), p.tolist(), y.tolist()) if o and rk[pp] == tk[yy])
    ans = int(ok.sum())
    return {"n": len(y), "answered": round(ans / max(1, len(y)), 3), "right": right, "wrong": ans - right,
            "precision": round(right / max(1, ans), 3), "recall": round(right / max(1, len(y)), 3)}


def false_alarm(rule, X, truth_keys=None, names=None):
    """share of foreign packs that get a brand; a pack whose own brand happens to be a class and is named right is not counted"""
    ok, p, _ = rule(X)
    if truth_keys is None:
        return round(float(ok.float().mean()), 3)
    bad = [o and key(names[pp]) != tk for o, pp, tk in zip(ok.tolist(), p.tolist(), truth_keys)]
    return round(sum(bad) / max(1, len(bad)), 3)


def main():
    t0 = time.time()
    idx = json.loads((DATA / "index_v2.json").read_text())
    img = lambda f: str(DATA / "img" / f)
    cls = [d for d in idx if d["key"]]
    names = sorted({d["brand"] for d in cls}, key=str.lower)
    names = list({key(n): n for n in names}.values())        # one display name per key
    cid = {key(n): i for i, n in enumerate(names)}
    C = len(names)
    print(f"{C} brands, {len(cls)} products, encoder {ENC} (frozen), {AUG} webcam views per training photo")

    # ---- validation split (for calibration only): 10 % of the TRAINING products per brand
    rnd = random.Random(3)
    train = [d for d in cls if d["split"] == "train"]
    by = defaultdict(list)
    for d in train:
        by[d["key"]].append(d)
    val_codes = set()
    for k, ds in by.items():
        rnd.shuffle(ds)
        val_codes |= {d["code"] for d in ds[:max(1, len(ds) // 10)]} if len(ds) >= 6 else set()
    fit = [d for d in train if d["code"] not in val_codes]
    val = [d for d in train if d["code"] in val_codes]

    def views(ds, modes):
        jobs, ys = [], []
        for d in ds:
            for f in d["files"]:
                for m, s in modes:
                    jobs.append((img(f), m, seed(f, s))); ys.append(cid[d["key"]])
        return jobs, torch.tensor(ys)

    clean_aug = [("clean", 0)] + [("aug", s) for s in range(1, AUG + 1)]
    j_fit, y_fit = views(fit, clean_aug)
    j_val, y_val = views(val, [("camtest", 0)])
    test = [d for d in cls if d["split"] == "test"]
    tf = [(d, f) for d in test for f in d["files"] if f.endswith("_f.jpg")]
    to = [(d, f) for d in test for f in d["files"] if f.endswith("_o.jpg")]
    E = {
        "fit": cached(f"fit_aug{AUG}", j_fit),
        "val": cached("val_cam", j_val),
        "t_pack": cached("test_packshot", [(img(f), "clean", 0) for d, f in tf]),
        "t_orig": cached("test_original", [(img(f), "clean", 0) for d, f in to]),
        "t_cam": cached("test_original_cam", [(img(f), "camtest", seed(f)) for d, f in to]),
    }
    Y = {"t_pack": torch.tensor([cid[d["key"]] for d, _ in tf]), "t_orig": torch.tensor([cid[d["key"]] for d, _ in to])}
    Y["t_cam"] = Y["t_orig"]

    # ---- foreign packs
    side = {s: [d for d in idx if d["split"] == s] for s in ("unknown", "hardpool", "other")}
    E["unknown2"] = cached("unknown_v2", [(img(d["files"][0]), "clean", 0) for d in side["unknown"]])
    E["unknown2_cam"] = cached("unknown_v2_cam", [(img(d["files"][0]), "camtest", 7) for d in side["unknown"]])
    E["hardpool"] = cached("hardpool", [(img(d["files"][0]), "clean", 0) for d in side["hardpool"]])
    oth_jobs = [(img(f), m, s) for d in side["other"] for f in d["files"] for m, s in [("clean", 0), ("aug", 1)]]
    E["other"] = cached("other_aug1", oth_jobs)
    unk1 = json.loads((V1DATA / "index_unknown.json").read_text())
    E["unknown1"] = cached("unknown_v1", [(str(V1DATA / "img" / u["files"][0]), "clean", 0) for u in unk1])

    # lookalike test = the 300 hardpool packs closest to a brand centroid (frozen encoder, NOT the head);
    # the other 1,700 hardpool packs are validation negatives for the calibration
    cent = torch.nn.functional.normalize(torch.zeros(C, 512).index_add_(0, y_fit, E["fit"]), dim=-1)
    sim = (E["hardpool"] @ cent.T).max(-1).values
    order = sim.argsort(descending=True)
    look_i, valneg_i = order[:300], order[300:]
    E["lookalike"], E["valneg"] = E["hardpool"][look_i], E["hardpool"][valneg_i]
    look_list = [side["hardpool"][i] for i in look_i.tolist()]

    # ---- v1's own test data (identical fingerprints as in v1: same encoder, same images)
    v1idx = json.loads((V1DATA / "index.json").read_text())
    v1names = sorted({d["brand"] for d in v1idx}, key=str.lower)
    v1cid = {n: i for i, n in enumerate(v1names)}
    v1te = [(d, f) for d in v1idx if d["split"] == "test" for f in d["files"]]
    v1f = [(d, f) for d, f in v1te if f.endswith("_f.jpg")]
    v1o = [(d, f) for d, f in v1te if f.endswith("_o.jpg")]
    E1 = torch.load(V1DATA / "emb_MobileCLIP-S1.pt")
    Y1 = {"packshot": torch.tensor([v1cid[d["brand"]] for d, _ in v1f]), "original": torch.tensor([v1cid[d["brand"]] for d, _ in v1o])}
    Y1["original_webcam"] = Y1["original"]
    # the 49 OCR photos whose brand v1 knew (same order as in v1)
    gal = {e["code"]: e for e in json.loads((GAL / "index.json").read_text())}
    v1keys = {key(n): n for n in v1names}
    q49 = [(p, v1keys[key(gal[p.stem]["marke"])]) for p in sorted((GAL / "anfragen").glob("*.jpg")) if p.stem in gal and key(gal[p.stem]["marke"]) in v1keys]
    Y1["ocr49"] = torch.tensor([v1cid[n] for _, n in q49]); Y1["ocr49_webcam"] = Y1["ocr49"]
    assert len(q49) == len(E1["ocr49"]) and len(v1o) == len(E1["original"]) and len(v1f) == len(E1["packshot"]), "v1 test data changed"
    print(f"fingerprints ready ({time.time() - t0:.0f}s)")

    # ---- heads
    T, ls = text_fp(names)
    head_v1 = json.loads((DATA / "v1" / "brand_head_v1.json").read_text())
    W1, b1, Z1 = torch.tensor(head_v1["W"]), torch.tensor(head_v1["b"]), torch.tensor(head_v1["Z"])
    v1rule = Rule(W1, b1, Z1, None, head_v1["rule"]["min_conf"], head_v1["rule"]["zero_shot_top"])

    teach_X, teach_y = None, None
    if TEACH:  # D: crops named by Gemini / Workers AI in the live scanner (validated by tools/teach_pull.py)
        ex = [e for e in json.loads((TEACH / "index.json").read_text()) if e.get("ok") and key(e["brand"]) in cid]
        jobs = [(str(TEACH / e["file"]), m, s) for e in ex for m, s in [("clean", 0)] + [("aug", i) for i in range(1, 4)]]
        if jobs:
            teach_X = embed(jobs, "teach")
            teach_y = torch.tensor([cid[key(e["brand"])] for e in ex for _ in range(4)])
            print(f"teach examples: {len(ex)} crops of {len({e['brand'] for e in ex})} brands (×4 views, weight 3)")

    def fit_head(X, y, extra_other=None):
        n = C + (1 if extra_other is not None else 0)
        if extra_other is not None:
            X, y = torch.cat([X, extra_other]), torch.cat([y, torch.full((len(extra_other),), C)])
        w = torch.ones(len(X))
        if teach_X is not None:
            X, y, w = torch.cat([X, teach_X]), torch.cat([y, teach_y]), torch.cat([w, torch.full((len(teach_X),), 3.0)])
        return train_head(X, y, n, weight=w)

    print("training head A (brands only) …", flush=True)
    Wa, ba = fit_head(E["fit"], y_fit)
    # text knowledge on top (as in v1), alpha chosen on the validation split
    alpha = max((0.0, 0.25, 0.5, 1.0), key=lambda a: float((torch.softmax(E["val"] @ (Wa + a * ls * T).T + ba, -1).argmax(-1) == y_val).float().mean()))
    print(f"  alpha (text) = {alpha}")
    # hard negatives: foreign packs that head A takes for one of our brands with ≥ 0.5 → class "(other)"
    Pa = torch.softmax(E["other"] @ (Wa + alpha * ls * T).T + ba, -1).max(-1).values
    hard = E["other"][Pa >= 0.5]
    print(f"  hard negatives mined: {len(hard)} of {len(E['other'])} foreign views")
    print("training head B (brands + '(other)' from hard negatives) …", flush=True)
    Wb, bb = fit_head(E["fit"], y_fit, extra_other=hard)
    Zx = torch.cat([ls * T, torch.zeros(1, T.shape[1])])

    variants = {
        "A: brands": (Wa + alpha * ls * T, ba, None),
        "B: brands + (other) hard negatives": (Wb + alpha * Zx, bb, C),
    }
    # ---- calibration on validation (positives: val products in webcam quality; negatives: 1,700 hardpool packs)
    calib = {}
    for vn, (W, b, oth) in variants.items():
        grid = []
        for mc in (0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95):
            for zt in (5, 10, 20, 50, 100000):
                r = Rule(W, b, ls * T, oth, mc, zt)
                fa = false_alarm(r, E["valneg"])
                m = measure(r, E["val"], y_val, names)
                grid.append({"min_conf": mc, "zs_top": zt, "val_false_alarm": fa, **{f"val_{k}": v for k, v in m.items()}})
        ok = [g for g in grid if g["val_false_alarm"] <= TARGET_FA and g["val_precision"] >= 0.95]
        best = max(ok or grid, key=lambda g: (g["val_right"], -g["val_false_alarm"]))
        calib[vn] = {"chosen": best, "grid": grid}
        print(f"  {vn}: min_conf {best['min_conf']}, zero-shot top {best['zs_top']} → val right {best['val_right']}/{best['val_n']}, "
              f"precision {best['val_precision']}, false alarm {best['val_false_alarm']}")

    # ---- measure everything, v1 vs v2
    res = {"brands": C, "products": len(cls), "fit_views": len(E["fit"]), "aug": AUG, "alpha": alpha,
           "hard_negatives": len(hard), "teach_examples": 0 if teach_X is None else len(teach_X) // 4,
           "domains": dict(Counter(d["domain"] for d in cls if d["split"] == "train")), "calibration": calib, "results": {}}
    rules = {"v1 (131 brands, as shipped)": (v1rule, v1names)}
    for vn, (W, b, oth) in variants.items():
        c = calib[vn]["chosen"]
        rules[f"v2 {vn}"] = (Rule(W, b, ls * T, oth, c["min_conf"], c["zs_top"]), names)
    unk_keys1 = [key(u["brand"]) for u in unk1]
    unk_keys2 = [key(d["brand"].strip("()")) for d in side["unknown"]]
    look_keys = [key(d["brand"].strip("()")) for d in look_list]
    for rn, (rule, nm) in rules.items():
        r = res["results"][rn] = {}
        for part in ("packshot", "original", "original_webcam", "ocr49", "ocr49_webcam"):
            r[f"v1test_{part}"] = measure(rule, E1[part], Y1[part], nm, v1names)
        for part, lab in (("t_pack", "packshot"), ("t_orig", "original"), ("t_cam", "original_webcam")):
            r[f"v2test_{lab}"] = measure(rule, E[part], Y[part], nm, names)
        r["false_alarm_unknown_v1"] = false_alarm(rule, E["unknown1"], unk_keys1, nm)
        r["false_alarm_unknown_v2"] = false_alarm(rule, E["unknown2"], unk_keys2, nm)
        r["false_alarm_unknown_v2_webcam"] = false_alarm(rule, E["unknown2_cam"], unk_keys2, nm)
        r["false_alarm_lookalike"] = false_alarm(rule, E["lookalike"], look_keys, nm)
        print(f"\n== {rn}")
        for k, v in r.items():
            print(f"  {k:32s} {v}")
    OUT.mkdir(parents=True, exist_ok=True)
    dst = OUT / ("S4_markenmodell_v2_teach.json" if TEACH else "S4_markenmodell_v2.json")
    dst.write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print("→", dst, f"({time.time() - t0:.0f}s)")

    if "--export" in sys.argv:
        pick = sys.argv[sys.argv.index("--export") + 1] if len(sys.argv) > sys.argv.index("--export") + 1 and sys.argv[sys.argv.index("--export") + 1] in "AB" else "B"
        vn = next(v for v in variants if v.startswith(pick))
        W, b, oth = variants[vn]
        c = calib[vn]["chosen"]
        export(W, b, ls * T, names + (["(other)"] if oth is not None else []), c, vn, head_v1["parts"])


def export(W, b, Z, names, c, variant, parts):
    """brand_head.bin = float16 [W (C×512) | b (C) | Z (Cz×512)], little endian; brand_head.json = metadata"""
    dst = ROOT / "public" / "models"
    W16, b16, Z16 = W.numpy().astype("<f2"), b.numpy().astype("<f2"), Z.numpy().astype("<f2")
    (dst / "brand_head.bin").write_bytes(W16.tobytes() + b16.tobytes() + Z16.tobytes())
    (dst / "brand_head.json").write_text(json.dumps({
        "version": 2, "encoder": ENC, "parts": parts, "input": [1, 3, SIZE, SIZE],
        "preprocess": "pad to square with grey 128, resize, RGB/255", "built": time.strftime("%Y-%m-%d"),
        "variant": variant, "names": names, "other": "(other)" if names[-1] == "(other)" else None,
        "head": {"file": "brand_head.bin", "dtype": "float16", "classes": len(names), "dim": int(W.shape[1]), "text_classes": int(Z.shape[0])},
        "rule": {"min_conf": c["min_conf"], "zero_shot_top": c["zs_top"]},
        "data": "Open Food Facts, Open Beauty Facts, Open Products Facts (ODbL); photos CC BY-SA",
        "note": "logits = W·e + b (classes incl. '(other)'), Z·e = brand-name text match (zero-shot). Answer only if the "
                "head is >= min_conf sure, its brand is not '(other)' and is among the zero_shot_top best of Z·e."},
        ensure_ascii=False, separators=(",", ":")))
    print(f"→ exported {variant}: {len(names)} classes, brand_head.bin {(dst / 'brand_head.bin').stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
