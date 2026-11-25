"""train_brand_model_v3.py – brand model v3: v2's 1,020 packaging brands + brands that are NOT packaging (tech, fashion,
sport, home, cars …) from freely licensed Wikimedia Commons photos (tools/build_brand_data_v3.py).

Same recipe as v2 (tools/train_brand_model_v2.py, whose functions are reused):
  - the image encoder stays the frozen MobileCLIP-S1 → the browser keeps the same 42 MB model files, only the head changes
  - every training photo + 3 random webcam/video views (tools/camaug.py)
  - hard negatives → class "(other)": foreign packs (v2) + generic Commons photos of the same kinds of objects
    (keyboard, sneaker, car … without a brand query) that the head takes for one of our brands
  - thresholds calibrated on a VALIDATION split (10 % of the training photos of every brand in webcam quality +
    foreign packs + generic photos), never on a test set
Measured, v2 (as shipped) vs v3, on the SAME fingerprints:
  - v2's test sets (held-back products, packshot/original/webcam view, unknown packs, lookalikes, 49 phone photos)
  - new: held-back Commons photos (other authors than in training), clean and as webcam view
  - new false-alarm tests: foreign brands with 8–19 Commons photos (never a class) and generic photos (no brand)
Out:  tests/ergebnisse/s5_marken_v3/S5_markenmodell_v3.json (+ per-brand table)
      with --export: public/models/brand_head.bin + brand_head.json (encoder parts unchanged)
Run:  daten_s3/py tools/train_brand_model_v3.py <daten_s3> [--export]
"""
import json, os, random, sys, time, zlib
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import train_brand_model_v2 as v2  # noqa: E402  (reads <data> from sys.argv[1] like this script)
from train_brand_model_v2 import Rule, cached, false_alarm, key, measure, seed, text_fp, train_head  # noqa: E402

DATA, ROOT = v2.DATA, v2.ROOT
OUT = ROOT.parent / "tests" / "ergebnisse" / "s5_marken_v3"
AUG, TARGET_FA = v2.AUG, v2.TARGET_FA


def load_v2_head():
    """the shipped v2 head (before --export overwrites it)"""
    meta = json.loads((ROOT / "public" / "models" / "brand_head.json").read_text())
    if meta.get("version") != 2:
        meta = json.loads((OUT / "brand_head_v2.json").read_text())
        raw = (OUT / "brand_head_v2.bin").read_bytes()
    else:
        raw = (ROOT / "public" / "models" / "brand_head.bin").read_bytes()
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "brand_head_v2.json").write_text(json.dumps(meta)); (OUT / "brand_head_v2.bin").write_bytes(raw)
    h = meta["head"]; C, D, CZ = h["classes"], h["dim"], h["text_classes"]
    f = torch.from_numpy(np.frombuffer(raw, dtype="<f2").astype(np.float32))
    W, b, Z = f[:C * D].view(C, D), f[C * D:C * D + C], f[C * D + C:].view(CZ, D)
    other = meta["names"].index(meta["other"]) if meta.get("other") else None
    return Rule(W, b, Z, other, meta["rule"]["min_conf"], meta["rule"]["zero_shot_top"]), meta["names"]


def main():
    t0 = time.time()
    idx2 = json.loads((DATA / "index_v2.json").read_text())
    idx3 = json.loads((DATA / "index_v3.json").read_text())
    img2 = lambda f: str(DATA / "img" / f)
    img3 = lambda f: str(DATA / "img_v3" / f)

    # ---- classes: v2's brands + the Commons brands (same key → same class, e.g. Apple, Samsung, Philips, Nintendo)
    cls2 = [d for d in idx2 if d["key"]]
    cls3 = [d for d in idx3 if d["key"]]
    names2 = list({key(n): n for n in sorted({d["brand"] for d in cls2}, key=str.lower)}.values())
    new3 = {}
    for d in cls3:
        new3.setdefault(d["key"], d["brand"])
    names = names2 + sorted([n for k, n in new3.items() if k not in {key(x) for x in names2}], key=str.lower)
    cid = {key(n): i for i, n in enumerate(names)}
    C = len(names)
    merged = sorted({d["brand"] for d in cls3 if key(d["brand"]) in {key(x) for x in names2}})
    print(f"{C} brands = {len(names2)} (v2) + {C - len(names2)} new; Commons photos added to v2 classes: {merged}")

    # ---- v2 part: identical jobs as in v2 → the cached fingerprints are reused, only the labels are re-mapped
    rnd = random.Random(3)
    train2 = [d for d in cls2 if d["split"] == "train"]
    by = defaultdict(list)
    for d in train2:
        by[d["key"]].append(d)
    val_codes = set()
    for k, ds in by.items():
        rnd.shuffle(ds)
        val_codes |= {d["code"] for d in ds[:max(1, len(ds) // 10)]} if len(ds) >= 6 else set()
    fit2 = [d for d in train2 if d["code"] not in val_codes]
    val2 = [d for d in train2 if d["code"] in val_codes]

    def views(ds, modes, img):
        jobs, ys = [], []
        for d in ds:
            for f in d["files"]:
                for m, s in modes:
                    jobs.append((img(f), m, seed(f, s))); ys.append(cid[d["key"]])
        return jobs, torch.tensor(ys)

    clean_aug = [("clean", 0)] + [("aug", s) for s in range(1, AUG + 1)]
    j_fit2, y_fit2 = views(fit2, clean_aug, img2)
    j_val2, y_val2 = views(val2, [("camtest", 0)], img2)
    test2 = [d for d in cls2 if d["split"] == "test"]
    tf = [(d, f) for d in test2 for f in d["files"] if f.endswith("_f.jpg")]
    to = [(d, f) for d in test2 for f in d["files"] if f.endswith("_o.jpg")]
    E = {"fit2": cached(f"fit_aug{AUG}", j_fit2), "val2": cached("val_cam", j_val2),
         "t_pack": cached("test_packshot", [(img2(f), "clean", 0) for d, f in tf]),
         "t_orig": cached("test_original", [(img2(f), "clean", 0) for d, f in to]),
         "t_cam": cached("test_original_cam", [(img2(f), "camtest", seed(f)) for d, f in to])}
    Y = {"t_pack": torch.tensor([cid[d["key"]] for d, _ in tf]), "t_orig": torch.tensor([cid[d["key"]] for d, _ in to])}
    Y["t_cam"] = Y["t_orig"]
    side = {s: [d for d in idx2 if d["split"] == s] for s in ("unknown", "hardpool", "other")}
    E["unknown2"] = cached("unknown_v2", [(img2(d["files"][0]), "clean", 0) for d in side["unknown"]])
    E["unknown2_cam"] = cached("unknown_v2_cam", [(img2(d["files"][0]), "camtest", 7) for d in side["unknown"]])
    E["hardpool"] = cached("hardpool", [(img2(d["files"][0]), "clean", 0) for d in side["hardpool"]])
    E["other2"] = cached("other_aug1", [(img2(f), m, s) for d in side["other"] for f in d["files"] for m, s in [("clean", 0), ("aug", 1)]])

    # ---- Commons part: validation = 10 % of each brand's TRAINING photos (≥ 2), in webcam quality
    tr3 = [d for d in cls3 if d["split"] == "train"]
    by3 = defaultdict(list)
    for d in tr3:
        by3[d["key"]].append(d)
    val3 = []
    for k, ds in sorted(by3.items()):
        random.Random(zlib.crc32(k.encode())).shuffle(ds)
        val3 += ds[:max(2, len(ds) // 10)]
    vc3 = {d["code"] for d in val3}
    fit3 = [d for d in tr3 if d["code"] not in vc3]
    te3 = [d for d in cls3 if d["split"] == "test"]
    j_fit3, y_fit3 = views(fit3, clean_aug, img3)
    j_val3, y_val3 = views(val3, [("camtest", 0)], img3)
    E["fit3"] = cached(f"c3_fit_aug{AUG}", j_fit3)
    E["val3"] = cached("c3_val_cam", j_val3)
    E["c_test"] = cached("c3_test", [(img3(d["files"][0]), "clean", 0) for d in te3])
    E["c_test_cam"] = cached("c3_test_cam", [(img3(d["files"][0]), "camtest", seed(d["files"][0])) for d in te3])
    Y["c_test"] = Y["c_test_cam"] = torch.tensor([cid[d["key"]] for d in te3])
    s3 = {s: [d for d in idx3 if d["split"] == s] for s in ("unknown_c", "other_c", "valneg_c", "generic_test")}
    E["c_unknown"] = cached("c3_unknown", [(img3(d["files"][0]), "clean", 0) for d in s3["unknown_c"]])
    E["c_unknown_cam"] = cached("c3_unknown_cam", [(img3(d["files"][0]), "camtest", 7) for d in s3["unknown_c"]])
    E["c_generic"] = cached("c3_generic_test", [(img3(d["files"][0]), "clean", 0) for d in s3["generic_test"]])
    E["c_generic_cam"] = cached("c3_generic_test_cam", [(img3(d["files"][0]), "camtest", 7) for d in s3["generic_test"]])
    E["c_valneg"] = cached("c3_valneg", [(img3(d["files"][0]), "camtest", 3) for d in s3["valneg_c"]])
    E["c_other"] = cached("c3_other_aug1", [(img3(d["files"][0]), m, s) for d in s3["other_c"] for m, s in [("clean", 0), ("aug", 1)]])

    # lookalikes (v2's hard test) – chosen exactly as in v2: the 300 hardpool packs closest to a v2 brand centroid
    C2 = len(names2)
    cent = torch.nn.functional.normalize(torch.zeros(C, 512).index_add_(0, y_fit2, E["fit2"]), dim=-1)[:C2]
    order = (E["hardpool"] @ cent.T).max(-1).values.argsort(descending=True)
    E["lookalike"], E["valneg2"] = E["hardpool"][order[:300]], E["hardpool"][order[300:]]
    look_list = [side["hardpool"][i] for i in order[:300].tolist()]

    # the 49 phone photos of the OCR test (v1's fingerprints, same encoder)
    E1 = torch.load(v2.V1DATA / "emb_MobileCLIP-S1.pt")
    gal = {e["code"]: e for e in json.loads((v2.GAL / "index.json").read_text())}
    v1idx = json.loads((v2.V1DATA / "index.json").read_text())
    v1names = sorted({d["brand"] for d in v1idx}, key=str.lower)
    v1keys = {key(n): n for n in v1names}
    q49 = [v1keys[key(gal[p.stem]["marke"])] for p in sorted((v2.GAL / "anfragen").glob("*.jpg")) if p.stem in gal and key(gal[p.stem]["marke"]) in v1keys]
    assert len(q49) == len(E1["ocr49"])
    v1cid = {n: i for i, n in enumerate(v1names)}
    Y1 = torch.tensor([v1cid[n] for n in q49])
    print(f"fingerprints ready ({time.time() - t0:.0f}s): Commons fit {len(E['fit3'])} views of {len(fit3)} photos, "
          f"val {len(val3)}, test {len(te3)}, foreign brands {len(s3['unknown_c'])}, generic test {len(s3['generic_test'])}")

    # ---- heads. Attempt 1 (one head for all 1,370 brands, see EVALUATION S5) lost too much: Commons photos are far more
    # varied than packshots, the softmax over 1,370 classes got unsure everywhere → old brands worse, Commons precision < 50 %.
    # So v3 = TWO STAGES: (1) v2's head exactly as shipped; (2) only if (1) is not sure: a separate Commons head
    # (non-packaging brands + "(other)"), calibrated so that it adds as few false alarms as possible.
    v2rule, v2names = load_v2_head()
    ckeys = sorted({d["key"] for d in cls3})
    cnames = [names[cid[k]] for k in ckeys]
    ccid = {k: i for i, k in enumerate(ckeys)}
    Cc = len(cnames)
    to_c = lambda y: torch.tensor([ccid[key(names[i])] for i in y.tolist()])
    T, ls = text_fp(cnames)
    X_fit, y_fit = E["fit3"], to_c(y_fit3)
    X_val, y_val = E["val3"], to_c(y_val3)
    print(f"training Commons head A ({Cc} brands) …", flush=True)
    Wa, ba = train_head(X_fit, y_fit, Cc)
    alpha = max((0.0, 0.25, 0.5, 1.0), key=lambda a: float((torch.softmax(X_val @ (Wa + a * ls * T).T + ba, -1).argmax(-1) == y_val).float().mean()))
    print(f"  alpha (text) = {alpha}")
    # "(other)" for the Commons head: generic Commons photos, foreign packs, and packs of v2 brands that are not Commons classes
    # (stage 1 handles those; stage 2 must not claim them)
    not_c = torch.tensor([key(names[i]) not in ccid for i in y_fit2.tolist()])
    packs = E["fit2"][not_c][::4]
    neg = torch.cat([E["c_other"], E["other2"], packs])
    hard = neg
    print(f"  '(other)': {len(E['c_other'])} generic views + {len(E['other2'])} foreign packs + {len(packs)} v2 packs", flush=True)
    print("training Commons head B (brands + '(other)') …", flush=True)
    Wb, bb = train_head(torch.cat([X_fit, neg]), torch.cat([y_fit, torch.full((len(neg),), Cc)]), Cc + 1)
    Zx = torch.cat([ls * T, torch.zeros(1, T.shape[1])])
    W, b, oth = Wb + alpha * Zx, bb, Cc

    # ---- which Commons brands can the head tell apart at all? 3-fold cross-validation on the TRAINING photos only
    # (folds by photo, all 4 views of a photo in the same fold). Many brands look alike without a readable logo
    # (monitors, bike parts, cars of one segment) → a brand answers only if it was ≥ 90 % right in cross-validation.
    fold = torch.tensor([zlib.crc32(f.encode()) % 3 for d in fit3 for f in d["files"] for _ in clean_aug])
    nfold = torch.arange(len(neg)) % 3
    cv = torch.zeros(Cc, 2)  # [right, wrong] per predicted class
    for k in range(3):
        Wk, bk = train_head(torch.cat([X_fit[fold != k], neg[nfold != k]]),
                            torch.cat([y_fit[fold != k], torch.full((int((nfold != k).sum()),), Cc)]), Cc + 1)
        rk = Rule(Wk + alpha * Zx, bk, ls * T, Cc, 0.9, 100000)
        for Xq, yq in ((X_fit[fold == k], y_fit[fold == k]), (neg[nfold == k], torch.full((int((nfold == k).sum()),), -1))):
            o, pq, _ = rk(Xq)
            for pp, yy in zip(pq[o].tolist(), yq[o].tolist()):
                cv[pp, 0 if pp == yy else 1] += 1
    cv_prec = cv[:, 0] / cv.sum(1).clamp(min=1)
    keep = (cv_prec >= 0.9) & (cv[:, 0] >= 8)
    print(f"  cross-validation: {int(keep.sum())} of {Cc} Commons brands ≥ 90 % right → they may answer", flush=True)

    class KeepRule(Rule):
        def __call__(self, X):
            o, p, c = super().__call__(X)
            return o & keep[p.clamp(max=Cc - 1)] & (p < Cc), p, c

    class Combo:
        """stage 1 = v2 head; stage 2 = Commons head, asked only when stage 1 is not sure. p indexes v2names + cnames + (other)"""
        def __init__(self, r2, rc, override=False, veto=None):
            self.r2, self.rc, self.override, self.veto = r2, rc, override, veto
        def __call__(self, X):
            o2, p2, c2 = self.r2(X)
            oc, pc, cc = self.rc(X)
            if self.override:  # a sure stage-2 answer wins: v2 also fires on photos of cars, shoes … (it only knows packs)
                o2 = o2 & ~oc
            if self.veto is not None:  # stage 2 says "this is NOT a pack" ((other) unlikely) → stage 1 (packs only) must not answer
                po = torch.softmax(X @ self.rc.W.T + self.rc.b, -1)[:, self.rc.other]
                o2 = o2 & (po >= self.veto)
            return o2 | oc, torch.where(o2, p2, pc + len(v2names)), torch.where(o2, c2, cc)
    cmb_names = v2names + cnames + ["(other)"]

    # ---- calibration on validation only: Commons val photos (webcam view), v2 val packs, foreign packs + generic photos
    valneg = torch.cat([E["valneg2"], E["c_valneg"]])
    fa_v2 = false_alarm(v2rule, valneg)
    Xv_all, yv_all = torch.cat([E["val2"], E["val3"]]), torch.cat([y_val2, y_val3])
    grid = []
    for mc in (0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.97, 0.99):
        for zt, ov, vt in [(z, o, v) for z in (3, 100000) for o in (False, True) for v in (None, 0.0002, 0.0005, 0.002)]:
            r = Combo(v2rule, KeepRule(W, b, ls * T, oth, mc, zt), ov, vt)
            m = measure(r, Xv_all, yv_all, cmb_names, names)
            grid.append({"min_conf": mc, "zs_top": zt, "override": ov, "veto": vt, "val_false_alarm": false_alarm(r, valneg),
                         "val_false_alarm_generic": false_alarm(r, E["c_valneg"]),
                         "val_old": measure(r, E["val2"], y_val2, cmb_names, names),
                         "val_commons": measure(r, E["val3"], y_val3, cmb_names, names),
                         "val_precision_commons": measure(r, E["val3"], y_val3, cmb_names, names)["precision"],
                         **{f"val_{k}": v for k, v in m.items()}})
    old_v2 = measure(v2rule, E["val2"], y_val2, v2names, names)
    # goals: old brands as good as v2 (≥ 98 % of its right answers, precision not lower), false alarms ≤ v2 + 0.5 points,
    # Commons precision ≥ 95 %
    ok = [g for g in grid if g["val_false_alarm"] <= fa_v2 + 0.005 and g["val_old"]["right"] >= 0.98 * old_v2["right"]
          and g["val_old"]["precision"] >= old_v2["precision"] - 0.005 and g["val_precision_commons"] >= 0.95]
    old_ok = [g for g in grid if g["val_old"]["right"] >= 0.98 * old_v2["right"] and g["val_old"]["precision"] >= old_v2["precision"] - 0.005
              and g["val_false_alarm"] <= fa_v2 + 0.005]
    # if no setting meets every goal: old brands + false alarms stay the hard limits, then the most right Commons answers
    best = max(ok or old_ok or grid, key=lambda g: (g["val_commons"]["right"], -g["val_false_alarm"]))
    print(f"  v2 alone: val old brands {old_v2}")
    print(f"  v2 alone: val false alarm {fa_v2}; {len(ok)} settings meet the goals")
    print(f"  chosen: min_conf {best['min_conf']}, zero-shot top {best['zs_top']}, override {best['override']}, veto {best['veto']} → Commons val {best['val_commons']}, "
          f"all val precision {best['val_precision']}, false alarm {best['val_false_alarm']}")
    crule = KeepRule(W, b, ls * T, oth, best["min_conf"], best["zs_top"])
    v3rule = Combo(v2rule, crule, best["override"], best["veto"])

    # ---- measure v2 (shipped) vs v3
    unk_keys2 = [key(d["brand"].strip("()")) for d in side["unknown"]]
    look_keys = [key(d["brand"].strip("()")) for d in look_list]
    cu_keys = [key(d["brand"]) for d in s3["unknown_c"]]
    res = {"brands": C, "brands_v2": len(names2), "brands_new": C - len(names2), "commons_head_classes": Cc, "commons_answering": [cnames[i] for i in range(Cc) if keep[i]],
           "commons_silent": {cnames[i]: [int(cv[i, 0]), int(cv[i, 1])] for i in range(Cc) if not keep[i]}, "val_false_alarm_v2": fa_v2, "val_old_v2": old_v2, "merged_into_v2_classes": merged,
           "commons": {"fit_photos": len(fit3), "val_photos": len(val3), "test_photos": len(te3), "foreign_brand_photos": len(s3["unknown_c"]),
                       "foreign_brands": len({d["brand"] for d in s3["unknown_c"]}), "generic_test": len(s3["generic_test"]),
                       "domains": dict(Counter(d["domain"] for d in cls3 if d["split"] == "train"))},
           "alpha": alpha, "hard_negatives": len(hard), "calibration": {"chosen": best, "grid": grid}, "results": {}}
    for rn, (rule, nm) in {"v2 (1,020 brands, as shipped)": (v2rule, v2names), "v3": (v3rule, cmb_names)}.items():
        r = res["results"][rn] = {}
        for part, lab in (("t_pack", "v2test_packshot"), ("t_orig", "v2test_original"), ("t_cam", "v2test_original_webcam"),
                          ("c_test", "commons_test"), ("c_test_cam", "commons_test_webcam")):
            r[lab] = measure(rule, E[part], Y[part], nm, names)
        r["ocr49"] = measure(rule, E1["ocr49"], Y1, nm, v1names)
        r["ocr49_webcam"] = measure(rule, E1["ocr49_webcam"], Y1, nm, v1names)
        r["false_alarm_unknown_v2"] = false_alarm(rule, E["unknown2"], unk_keys2, nm)
        r["false_alarm_unknown_v2_webcam"] = false_alarm(rule, E["unknown2_cam"], unk_keys2, nm)
        r["false_alarm_lookalike"] = false_alarm(rule, E["lookalike"], look_keys, nm)
        r["false_alarm_foreign_commons_brands"] = false_alarm(rule, E["c_unknown"], cu_keys, nm)
        r["false_alarm_foreign_commons_brands_webcam"] = false_alarm(rule, E["c_unknown_cam"], cu_keys, nm)
        r["false_alarm_generic_photos"] = false_alarm(rule, E["c_generic"])
        r["false_alarm_generic_photos_webcam"] = false_alarm(rule, E["c_generic_cam"])
        print(f"\n== {rn}")
        for k, v in r.items():
            print(f"  {k:42s} {v}")
    # per category and per brand (Commons test): who is recognised, who is not
    ok3, p3, _ = v3rule(E["c_test"])
    per = defaultdict(lambda: {"n": 0, "right": 0, "wrong": 0})
    cat = defaultdict(lambda: {"n": 0, "right": 0, "wrong": 0})
    for d, o, p in zip(te3, ok3.tolist(), p3.tolist()):
        for t in (per[d["brand"]], cat[d["domain"]]):
            t["n"] += 1
            if o:
                t["right" if key(cmb_names[p]) == d["key"] else "wrong"] += 1
    res["commons_test_by_category"] = dict(cat)
    for part in ("c_test", "c_test_cam"):  # who is wrong on Commons photos: stage 1 (v2, packs only) or the new stage 2?
        o, p, _ = v3rule(E[part]); s2 = o & (p >= len(v2names))
        r2 = sum(1 for pp, yy in zip(p[s2].tolist(), Y[part][s2].tolist()) if key(cmb_names[pp]) == key(names[yy]))
        o1 = o & (p < len(v2names))
        r1 = sum(1 for pp, yy in zip(p[o1].tolist(), Y[part][o1].tolist()) if key(cmb_names[pp]) == key(names[yy]))
        res[f"{part}_by_stage"] = {"stage1_v2": {"answered": int(o1.sum()), "right": r1}, "stage2_commons": {"answered": int(s2.sum()), "right": r2,
                                   "precision": round(r2 / max(1, int(s2.sum())), 3)}}
        print(part, "by stage:", res[f"{part}_by_stage"])
    o2t = (p3 < len(v2names)) & ok3
    conf = Counter((d["brand"], cmb_names[p], "stage1" if s1 else "stage2") for d, o, p, s1 in zip(te3, ok3.tolist(), p3.tolist(), o2t.tolist())
                   if o and key(cmb_names[p]) != d["key"])
    res["commons_test_confusions"] = [list(k) + [n] for k, n in conf.most_common(60)]
    res["commons_test_by_brand"] = dict(sorted(per.items()))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "S5_markenmodell_v3.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print("by category:", json.dumps(dict(cat)), f"\n→ {OUT / 'S5_markenmodell_v3.json'} ({time.time() - t0:.0f}s)")

    if "--export" in sys.argv:
        dst = ROOT / "public" / "models"
        old = json.loads((OUT / "brand_head_v2.json").read_text())
        raw2 = (OUT / "brand_head_v2.bin").read_bytes()
        W16, b16, Z16 = W.numpy().astype("<f2"), b.numpy().astype("<f2"), (ls * T).numpy().astype("<f2")
        (dst / "brand_head.bin").write_bytes(raw2 + W16.tobytes() + b16.tobytes() + Z16.tobytes())
        meta = dict(old)
        meta.update({"version": 3, "built": time.strftime("%Y-%m-%d"),
                     "variant": "v3: stage 1 = v2 head (packaging brands, unchanged); stage 2 = Commons head (non-packaging brands), only when stage 1 is not sure",
                     "stage2": {"names": cnames + ["(other)"], "other": "(other)",
                                "answers": [cnames[i] for i in range(Cc) if keep[i]],
                                "head": {"offset": len(raw2), "dtype": "float16", "classes": Cc + 1, "dim": int(W.shape[1]), "text_classes": int(T.shape[0])},
                                "rule": {"min_conf": best["min_conf"], "zero_shot_top": best["zs_top"], "overrides_stage1": best["override"], "veto_stage1_below_other": best["veto"]}},
                     "data": old.get("data", "") + "; stage 2: Wikimedia Commons photos (free licences, authors and licences per file in data/brand_v3_sources.csv)"})
        (dst / "brand_head.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
        print(f"→ exported v3: {len(v2names)} + {Cc + 1} classes, brand_head.bin {(dst / 'brand_head.bin').stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
    os._exit(0)  # PyTorch on this Mac sometimes crashes (SIGSEGV) while shutting down – harmless, skip the teardown
