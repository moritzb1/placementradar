"""add_v3_brands_to_ocr.py – adds the non-packaging brand candidates of model v3 (tools/brands_v3.py) to the OCR brand
list (public/models/brands_de.json), so "Verify on screen" and the live scanner can READ them too (Keychron, Sonos, Ford …).

The list came from Open Food/Beauty/Products Facts and lacked most tech, fashion and car brands. Added entries are marked
`exact: true` (ocr.js: no typo matching for them) and names that are ordinary words are left out (Mini, Lime, Polar,
Champion, Coach …) – on a video frame such words appear as normal text far more often than as the brand.
Run: python3 tools/add_v3_brands_to_ocr.py   (idempotent: entries with source "v3" are rebuilt)
"""
import json, re, sys, unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from brands_v3 import DISPLAY, entries  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WORDS = set("""mini lime away moment nothing polar champion citizen brother fellow keen cube giant omega coach columbia continental
fischer diesel lee elan fein arena montana napoleon jaguar lucid marshall pandora parker primus molten ninja monopoly lodge bree haba
kobo lush tile seat smart ring scott element benefit supreme tier atomic blizzard canyon creed fossil gazelle glorious hummel kappa
olymp opal osprey pioneer puma rab ridge rose sage sigma specialized stanley thermos total trek vans wilson zoom string giro elan
brooks bell weber steiff hay cherry dunlop ford tempo uhu kosmos brio""".split())


def key(s):
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", s.lower()).encode("ascii", "ignore").decode())


def main():
    p = ROOT / "public" / "models" / "brands_de.json"
    j = json.loads(p.read_text())
    j["brands"] = [b for b in j["brands"] if b.get("source") != "v3"]
    have = {b["key"] for b in j["brands"]}
    add = []
    for name, *_ in entries():
        disp = DISPLAY.get(name, name)
        k = key(disp)
        if len(k) < 4 or k in have or k in WORDS or any(key(w) in WORDS for w in disp.split()) and len(disp.split()) == 1:
            continue
        have.add(k)
        add.append({"name": disp, "key": k, "products": 0, "source": "v3", "exact": True})
    j["brands"] += add
    j["source"] += " + non-packaging brands of brand model v3 (tools/brands_v3.py, exact spelling only)"
    p.write_text(json.dumps(j, ensure_ascii=False, separators=(",", ":")))
    print(f"added {len(add)} brands → {len(j['brands'])} in {p.name}")


if __name__ == "__main__":
    main()
