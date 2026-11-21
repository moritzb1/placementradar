"""eval_brand_v2_extra.py – two extra measurements for brand model v2, from the cached fingerprints of
train_brand_model_v2.py (no new embedding run, ~1 min):

 1. Ablation C (webcam training): the same head trained on the CLEAN training photos only vs. clean + 3 webcam views,
    measured on the fixed webcam test views (and the clean originals). Same thresholds as the exported rule.
 2. False alarms on v1's 146 "unknown brand" packs, fairly: v1 stored them only as "(unknown)". Their real brand is
    looked up in the Open Food Facts dump. Packs whose brand is now one of the 1,020 classes are no longer foreign
    for v2 → reported separately (named right / named wrong); only the rest counts for the false-alarm rate.
Out: tests/ergebnisse/s4_erkennung/S4_extra.json
Run: daten_s3/py tools/eval_brand_v2_extra.py <daten_s3>
"""
import json, sys
from pathlib import Path

import polars as pl
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import train_brand_model_v2 as T  # noqa: E402  (same helpers, same data paths)
from build_brand_data import key as bkey  # noqa: E402

DATA = Path(sys.argv[1])
ROOT = Path(__file__).resolve().parent.parent


def main():
    idx = json.loads((DATA / "index_v2.json").read_text())
    cls = [d for d in idx if d["key"]]
    names = list({T.key(n): n for n in sorted({d["brand"] for d in cls}, key=str.lower)}.values())
    cid = {T.key(n): i for i, n in enumerate(names)}
    C = len(names)
    E = {k: torch.load(DATA / "emb" / f"{f}.pt") for k, f in [("fit", "fit_aug3"), ("t_orig", "test_original"), ("t_cam", "test_original_cam"),
                                                                ("other", "other_aug1"), ("unknown1", "unknown_v1"), ("unknown2", "unknown_v2")]}
    # labels exactly as in train_brand_model_v2.py (same order of products and files)
    import random
    from collections import defaultdict
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
    y_fit = torch.tensor([cid[d["key"]] for d in fit for f in d["files"] for _ in range(4)])
    to = [(d, f) for d in cls if d["split"] == "test" for f in d["files"] if f.endswith("_o.jpg")]
    y_o = torch.tensor([cid[d["key"]] for d, _ in to])
    assert len(y_fit) == len(E["fit"]) and len(y_o) == len(E["t_orig"])
    Tx, ls = T.text_fp(names)
    head = json.loads((ROOT / "public" / "models" / "brand_head.json").read_text())
    rule = head["rule"]
    res = {}

    # ---- 1. ablation: clean only vs clean + webcam views (head A: brands only, alpha 0.5 as chosen)
    clean = torch.arange(0, len(E["fit"]), 4)
    for label, sel in [("clean photos only", clean), ("clean + 3 webcam views", torch.arange(len(E["fit"])))]:
        W, b = T.train_head(E["fit"][sel], y_fit[sel], C)
        r = T.Rule(W + 0.5 * ls * Tx, b, ls * Tx, None, rule["min_conf"], rule["zero_shot_top"])
        res[f"ablation: {label}"] = {"original": T.measure(r, E["t_orig"], y_o, names), "webcam": T.measure(r, E["t_cam"], y_o, names),
                                     "false_alarm_unknown_v2": T.false_alarm(r, E["unknown2"])}
        print(label, res[f"ablation: {label}"])

    # ---- 2. v1's unknown packs with their real brands
    unk1 = json.loads((T.V1DATA / "index_unknown.json").read_text())
    codes = [u["code"] for u in unk1]
    df = pl.scan_parquet(DATA / "dumps" / "food.parquet").select("code", "brands").filter(pl.col("code").is_in(codes)).collect()
    brand = dict(zip(df["code"].to_list(), df["brands"].to_list()))
    W, b, Z = [None] * 3
    import numpy as np
    f = np.frombuffer((ROOT / "public" / "models" / "brand_head.bin").read_bytes(), dtype="<f2").astype("float32")
    n, D, CZ = head["head"]["classes"], head["head"]["dim"], head["head"]["text_classes"]
    W, b, Z = torch.from_numpy(f[:n * D].reshape(n, D).copy()), torch.from_numpy(f[n * D:n * D + n].copy()), torch.from_numpy(f[n * D + n:].reshape(CZ, D).copy())
    other = head["names"].index(head["other"]) if head.get("other") else None
    v2 = T.Rule(W, b, Z, other, rule["min_conf"], rule["zero_shot_top"])
    h1 = json.loads((DATA / "v1" / "brand_head_v1.json").read_text())
    v1 = T.Rule(torch.tensor(h1["W"]), torch.tensor(h1["b"]), torch.tensor(h1["Z"]), None, h1["rule"]["min_conf"], h1["rule"]["zero_shot_top"])
    out = {}
    for vn, rr, nm in (("v1", v1, h1["names"]), ("v2", v2, head["names"])):
        ok, p, _ = rr(E["unknown1"])
        known = {k for k in map(T.key, nm)}
        cnt = {"no_brand_recorded": 0, "no_brand_recorded_answered": 0, "now_a_class_named_right": 0, "now_a_class_named_wrong": 0,
               "now_a_class_silent": 0, "foreign_packs": 0, "foreign_false_alarms": 0, "false_alarm_list": []}
        for code, o, pp in zip(codes, ok.tolist(), p.tolist()):
            ks = [bkey(x) for x in (brand.get(code) or "").split(",") if x.strip()]
            mine = next((k for k in ks if k in known), None)
            if not ks:  # Open Food Facts has no brand for this pack → cannot be judged (v2 often names it plausibly)
                cnt["no_brand_recorded"] += 1; cnt["no_brand_recorded_answered"] += int(o)
            elif mine:
                cnt["now_a_class_" + ("silent" if not o else "named_right" if T.key(nm[pp]) == mine else "named_wrong")] += 1
            else:
                cnt["foreign_packs"] += 1; cnt["foreign_false_alarms"] += int(o)
                if o:
                    cnt["false_alarm_list"].append(f"{brand.get(code)} → {nm[pp]}")
        cnt["false_alarm_rate"] = round(cnt["foreign_false_alarms"] / max(1, cnt["foreign_packs"]), 3)
        out[vn] = cnt
        print("v1 unknown packs –", vn, cnt)
    res["unknown_v1_with_real_brands"] = out
    dst = T.OUT / "S4_extra.json"
    dst.write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print("→", dst)


if __name__ == "__main__":
    main()
