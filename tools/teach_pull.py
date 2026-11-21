"""teach_pull.py – "Gemini teaches the on-device model" (distillation, part D): fetch, check, retrain.

Where the examples come from: when a visitor taps a box in the live scanner, the crop goes to /api/identify
(Gemini Flash-Lite, else Workers AI). If the answer is ONE confident brand and the visitor did not switch keeping off
("Recognised crops may be kept to improve the on-device model"), worker.js keeps the crop + brand in KV
(`teach:<sha256>`, max TEACH_MAX examples, deleted after TEACH_DAYS days).

What this script does:
  1. pull   – lists and downloads the kept examples via GET /api/teach (needs the Worker secret TEACH_TOKEN)
              into <out>/img/<hash>.jpg + <out>/index.json
  2. check  – keeps an example only if
                a) the image decodes and is at least 48×48 px,
                b) the cloud model was sure (confidence ≥ 0.7, already enforced by the Worker),
                c) the brand maps to a brand of the own model (normalised name, aliases of build_brand_data.py),
                d) it is not a duplicate (same picture → same SHA-256 → one key in KV anyway),
                e) the own model's fingerprint does not flatly contradict it: the cloud brand must be among the
                   own model's 20 best guesses OR the head has no confident other opinion (< 0.5) – a crop that our
                   model calls "Milka 0.95" but the cloud calls "Oreo" goes to <out>/review/ for a human look.
              Unknown brands with ≥ 5 good examples are listed as candidates for a new class (not added automatically).
  3. retrain – runs tools/train_brand_model_v2.py with --teach <out> (examples weighted ×3, 3 webcam views each)
               and exports a new head; the encoder files stay unchanged.

Run:  TEACH_TOKEN=… daten_s3/py tools/teach_pull.py [--url https://placementradar.itsmoribind.workers.dev]
                                                    [--out ../daten_s3/teach] [--retrain] [--delete-used]
      Without TEACH_TOKEN it reads an existing <out>/raw/*.json (e.g. copied with `wrangler kv key get`).
Privacy: README → Privacy. Only crops, no frames, no visitor ids; examples are deleted from KV with --delete-used.
"""
import base64, hashlib, io, json, os, subprocess, sys
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from build_brand_data import key  # same normalisation + aliases as the training data  # noqa: E402

arg = lambda n, d=None: sys.argv[sys.argv.index(n) + 1] if n in sys.argv else d
URL = arg("--url", "https://placementradar.itsmoribind.workers.dev").rstrip("/")
OUT = Path(arg("--out", str(ROOT.parent / "daten_s3" / "teach")))
TOKEN = os.environ.get("TEACH_TOKEN")
H = {"authorization": f"Bearer {TOKEN}", "user-agent": "PlacementRadar-teach/1.0"}


def pull():
    raw = OUT / "raw"; raw.mkdir(parents=True, exist_ok=True)
    if not TOKEN:
        print("no TEACH_TOKEN → using the examples already in", raw)
        return
    keys, cursor = [], None
    while True:
        r = requests.get(f"{URL}/api/teach", headers=H, params={"cursor": cursor} if cursor else None, timeout=30)
        r.raise_for_status(); j = r.json()
        keys += j["keys"]; cursor = j.get("cursor")
        if not cursor:
            break
    print(f"{len(keys)} examples kept on the server (count {j.get('count')}/{j.get('max')})")
    for k in keys:
        dst = raw / f"{k['key'].split(':')[1]}.json"
        if dst.exists():
            continue
        r = requests.get(f"{URL}/api/teach/item", headers=H, params={"k": k["key"]}, timeout=30)
        if r.ok:
            dst.write_text(r.text)


def check():
    head = json.loads((ROOT / "public" / "models" / "brand_head.json").read_text())
    names = [n for n in head["names"] if n != head.get("other")]
    cid = {key(n): i for i, n in enumerate(names)}
    (OUT / "img").mkdir(exist_ok=True); (OUT / "review").mkdir(exist_ok=True)
    model = Opinion(head)
    out, new_brands = [], {}
    for f in sorted((OUT / "raw").glob("*.json")):
        e = json.loads(f.read_text())
        rec = {"file": f"img/{f.stem}.jpg", "brand": e.get("brand", ""), "conf": e.get("conf"), "model": e.get("model"),
               "provider": e.get("provider"), "t": e.get("t"), "ok": False}
        try:
            img = Image.open(io.BytesIO(base64.b64decode(e["image"]))).convert("RGB")
        except Exception:
            rec["why"] = "image does not decode"; out.append(rec); continue
        if min(img.size) < 48:
            rec["why"] = "too small"; out.append(rec); continue
        img.save(OUT / rec["file"], quality=92)
        if (rec["conf"] or 0) < 0.7:
            rec["why"] = "cloud model not sure"
        elif key(rec["brand"]) not in cid:
            new_brands.setdefault(rec["brand"], []).append(rec["file"]); rec["why"] = "brand not in the model (candidate)"
        else:
            top, conf = model(img)
            mine = cid[key(rec["brand"])]
            if mine in top[:20] or conf < 0.5:
                rec["ok"] = True
            else:
                rec["why"] = f"own model disagrees ({names[top[0]]} {conf:.2f})"
                img.save(OUT / "review" / f"{f.stem}.jpg")
        out.append(rec)
    (OUT / "index.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    ok = [r for r in out if r["ok"]]
    print(f"checked {len(out)} examples: {len(ok)} usable for {len({r['brand'] for r in ok})} brands")
    for why in sorted({r.get('why') for r in out if not r['ok']} - {None}):
        print(f"  dropped – {why}: {sum(r.get('why') == why for r in out)}")
    cand = {b: len(v) for b, v in new_brands.items() if len(v) >= 5}
    if cand:
        print("  candidates for NEW classes (≥ 5 examples, add by hand to build_brand_data.py):", cand)
    return ok


class Opinion:
    """the own model's opinion on a crop (same encoder + head as in the browser, run with PyTorch)"""
    def __init__(self, head):
        import numpy as np, open_clip, torch
        self.np, self.torch = np, torch
        m, _, _ = open_clip.create_model_and_transforms("MobileCLIP-S1", pretrained="datacompdr")
        self.m = m.eval()
        C, D = head["head"]["classes"], head["head"]["dim"]
        f = np.frombuffer((ROOT / "public" / "models" / "brand_head.bin").read_bytes(), dtype="<f2").astype("float32")
        self.W, self.b = torch.from_numpy(f[:C * D].reshape(C, D).copy()), torch.from_numpy(f[C * D:C * D + C].copy())
        self.n = len([n for n in head["names"] if n != head.get("other")])

    def __call__(self, img):
        np, torch = self.np, self.torch
        s = max(img.size); sq = Image.new("RGB", (s, s), (128, 128, 128)); sq.paste(img, ((s - img.width) // 2, (s - img.height) // 2))
        x = torch.from_numpy(np.asarray(sq.resize((256, 256), Image.BILINEAR), dtype=np.float32) / 255).permute(2, 0, 1)[None]
        with torch.no_grad():
            e = torch.nn.functional.normalize(self.m.encode_image(x), dim=-1)[0]
        P = torch.softmax(self.W @ e + self.b, -1)[: self.n]
        return P.argsort(descending=True).tolist(), float(P.max())


def main():
    pull()
    ok = check()
    if "--retrain" in sys.argv and ok:
        data = ROOT.parent / "daten_s3"
        subprocess.run([sys.executable, str(ROOT / "tools" / "train_brand_model_v2.py"), str(data), "--teach", str(OUT), "--export"], check=True)
    if "--delete-used" in sys.argv and TOKEN:
        for r in ok:
            requests.delete(f"{URL}/api/teach/item", headers=H, params={"k": f"teach:{Path(r['file']).stem}"}, timeout=30)
        print(f"deleted {len(ok)} used examples from KV")


if __name__ == "__main__":
    main()
