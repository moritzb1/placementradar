"""train_brand_data.py – training photos for our own brand model (stage 4 of the live scanner).

What:  takes the 20,000 most-scanned products sold in Germany from Open Food Facts (search-a-licious API, ODbL)
       and downloads up to two photos per product for the brands we want the model to know:
         - the cropped front picture chosen by the community ("front_de" – clean packshot)
         - the original upload behind it (hand, shelf, table, background – closer to a webcam frame)
Why:   OCR (stage 3) fails on script and picture logos (Coca-Cola, Kinder, Babybel) and on store brands that
       hardly print their name (Milbona, REWE Beste Wahl). A model that has SEEN many packs of a brand can
       recognise its look (colours, logo shape, layout) without reading.
Split: by product, never by photo – all photos of one product land in the same set. The 49 phone photos of
       the OCR test (tests/galerie_off/anfragen) are excluded completely, so both stages are compared fairly.
Out:   <data dir>/img/<code>_<f|o>.jpg  +  <data dir>/index.json  [{code, brand, split, files}]
Run:   python tools/train_brand_data.py <data dir>       (≈ 40 API calls, then ~6,000 image downloads, 4 at a time)
"""
import concurrent.futures as cf, json, random, subprocess, sys, time
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT.parent / "daten_s2")
IMG = DATA / "img"
UA = "PlacementRadar-CourseProject/0.1"
API = ("https://search.openfoodfacts.org/search?q=countries_tags:%22en:germany%22&page_size=500&page={p}"
       "&fields=code,brands,images,unique_scans_n&sort_by=-unique_scans_n")
PAGES = 40
MIN_PRODUCTS = 14      # a brand needs at least this many products in the 20k list to become a class
MAX_PRODUCTS = 45      # cap per brand so Lidl-style giants do not dominate
MIN_TARGET = 6         # …except brands OCR cannot read (picture/script logos): these are why the model exists
TARGET = {"oreo", "nutella", "babybel", "fruchtzwerge", "kinder", "cocacola", "milbona", "rewebestewahl"}
ALIAS = {"danoneas": "danone", "lindtsprungli": "lindt"}  # same brand, different spelling in Open Food Facts
DISPLAY = {"danone": "Danone", "lindt": "Lindt", "rewebestewahl": "REWE Beste Wahl"}
TEST_SHARE = 0.2       # 20 % of the products of each brand are held back for measuring

# Brands that are companies or umbrella names rather than one recognisable look (Nestlé makes KitKat AND Maggi).
# Products of these get the next, more specific brand in their list – or are skipped.
UMBRELLA = {"lidl", "aldi", "rewe", "nestle", "mondelez", "unilever", "pepsico", "savencia", "ferrero", "mars",
            "kaufland", "penny", "nettomd", "carrefour", "tesco", "lindtsprungli", "marquerepere", "migrosbio",
            "naturaplan", "mclassic", "hacendado", "deluxe", "biobio", "bioorganic", "dm", "farmer"}


def key(name):
    import re, unicodedata
    s = unicodedata.normalize("NFKD", name.lower()).encode("ascii", "ignore").decode()
    k = re.sub(r"[^a-z0-9]", "", s)
    return ALIAS.get(k, k)


def curl(url, out=None):
    args = ["curl", "-s", "-f", "-m", "60", "-A", UA, url] + (["-o", str(out)] if out else [])
    return subprocess.run(args, capture_output=True, text=out is None).stdout


def product_path(code):
    return f"{code[0:3]}/{code[3:6]}/{code[6:9]}/{code[9:]}" if len(code) > 8 else code


def fetch_products():
    cache = DATA / "products.json"
    if cache.exists():
        return json.loads(cache.read_text())
    hits = []
    for p in range(1, PAGES + 1):
        for attempt in range(3):
            try:
                hits += json.loads(curl(API.format(p=p)))["hits"]
                break
            except Exception:
                time.sleep(10)
        print(f"page {p}: {len(hits)} products", flush=True)
        time.sleep(2)  # be polite to Open Food Facts
    cache.write_text(json.dumps(hits))
    return hits


def main():
    IMG.mkdir(parents=True, exist_ok=True)
    excluded = {p.stem for p in (ROOT.parent / "tests" / "galerie_off" / "anfragen").glob("*.jpg")}
    hits = [h for h in fetch_products() if h.get("code") not in excluded and isinstance(h.get("images"), dict)]

    # 1. count brands (specific names only), 2. pick classes, 3. give every product ONE class
    names, count = {}, Counter()
    for h in hits:
        b = h.get("brands") or []
        for n in (b.split(",") if isinstance(b, str) else b)[:3]:
            k = key(n)
            if len(k) >= 2 and k not in UMBRELLA:
                count[k] += 1
                names.setdefault(k, DISPLAY.get(k, n.strip()))
    classes = {k for k, n in count.items() if n >= (MIN_TARGET if k in TARGET else MIN_PRODUCTS)}
    per_brand = defaultdict(list)
    for h in hits:
        b = h.get("brands") or []
        ks = [key(n) for n in (b.split(",") if isinstance(b, str) else b)[:3]]
        k = next((k for k in ks if k in classes), None)
        imgs = h["images"]
        front = imgs.get("front_de") or imgs.get("front_en") or next((v for kk, v in imgs.items() if kk.startswith("front_")), None)
        if k and isinstance(front, dict) and front.get("rev") and front.get("imgid"):
            lang = next(kk for kk, v in imgs.items() if v is front)
            per_brand[k].append({"code": h["code"], "brand": names[k], "key": k,
                                 "urls": {"f": f"https://images.openfoodfacts.org/images/products/{product_path(h['code'])}/{lang}.{front['rev']}.400.jpg",
                                          "o": f"https://images.openfoodfacts.org/images/products/{product_path(h['code'])}/{front['imgid']}.400.jpg"}})
    rnd = random.Random(7)
    items = []
    for k, ps in per_brand.items():
        if len(ps) < (MIN_TARGET if k in TARGET else MIN_PRODUCTS):
            continue
        ps = ps[:MAX_PRODUCTS]          # list is sorted by popularity → keep the best-known products
        rnd.shuffle(ps)
        n_test = max(2, round(len(ps) * TEST_SHARE))
        for i, p in enumerate(ps):
            p["split"] = "test" if i < n_test else "train"
            items.append(p)
    print(f"{len(per_brand)} brands with products, {len({i['key'] for i in items})} classes, {len(items)} products")

    def download(p):
        files = []
        for tag, url in p["urls"].items():
            dst = IMG / f"{p['code']}_{tag}.jpg"
            if not dst.exists():
                curl(url, dst)
                time.sleep(0.25)
            if dst.exists() and dst.stat().st_size > 3000:
                files.append(dst.name)
            elif dst.exists():
                dst.unlink()
        return {k: v for k, v in p.items() if k != "urls"} | {"files": files}

    with cf.ThreadPoolExecutor(4) as ex:
        done = []
        for i, r in enumerate(ex.map(download, items)):
            done.append(r)
            if i % 200 == 0:
                print(f"{i}/{len(items)} products downloaded", flush=True)
    done = [d for d in done if d["files"]]

    # "Unknown" set: original photos of products whose brands are NOT classes (other brands, no brand at all).
    # A live camera sees such packs all the time → measures how often the model claims a brand it cannot know.
    others = [h for h in hits if h["code"] not in {i["code"] for i in items}
              and not any(key(n) in classes for n in ((h.get("brands") or []) if isinstance(h.get("brands"), list) else (h.get("brands") or "").split(",")))]
    old = DATA / "index_unknown.json"   # keep the false-alarm test set stable across re-runs
    keep = {u["code"] for u in json.loads(old.read_text())} if old.exists() else None
    unknown = []
    for h in ([h for h in others if h["code"] in keep] if keep else rnd.sample(others, min(200, len(others)))):
        f = next((v for kk, v in h["images"].items() if kk.startswith("front_") and isinstance(v, dict) and v.get("imgid")), None)
        if f:
            unknown.append({"code": h["code"], "brand": "(unknown)", "key": "", "split": "unknown",
                            "urls": {"o": f"https://images.openfoodfacts.org/images/products/{product_path(h['code'])}/{f['imgid']}.400.jpg"}})
    with cf.ThreadPoolExecutor(4) as ex:
        unknown = [u for u in ex.map(download, unknown[:150]) if u["files"]]
    (DATA / "index_unknown.json").write_text(json.dumps(unknown, ensure_ascii=False, indent=0))
    print(f"unknown-brand photos: {len(unknown)}")

    # "Other brand" TRAINING class: 700 further products of non-class brands (never the test ones above).
    # Teaches the head that "looks like a package, but none of my brands" is a valid answer.
    taken = {u["code"] for u in unknown}
    pool = [h for h in others if h["code"] not in taken]
    other = []
    for h in random.Random(11).sample(pool, min(700, len(pool))):
        imgs = h["images"]
        f = next((v for kk, v in imgs.items() if kk.startswith("front_") and isinstance(v, dict) and v.get("imgid") and v.get("rev")), None)
        if f:
            lang = next(kk for kk, v in imgs.items() if v is f)
            base = f"https://images.openfoodfacts.org/images/products/{product_path(h['code'])}"
            other.append({"code": h["code"], "brand": "(other)", "key": "", "split": "other",
                          "urls": {"f": f"{base}/{lang}.{f['rev']}.400.jpg", "o": f"{base}/{f['imgid']}.400.jpg"}})
    with cf.ThreadPoolExecutor(4) as ex:
        other = [u for u in ex.map(download, other) if u["files"]]
    (DATA / "index_other.json").write_text(json.dumps(other, ensure_ascii=False, indent=0))
    print(f"other-brand training photos: {sum(len(u['files']) for u in other)} ({len(other)} products)")
    (DATA / "index.json").write_text(json.dumps(done, ensure_ascii=False, indent=0))
    c = Counter(d["split"] for d in done)
    print(f"done: {len(done)} products ({c['train']} train / {c['test']} test), "
          f"{sum(len(d['files']) for d in done)} photos, {len({d['key'] for d in done})} brands → {DATA}")


if __name__ == "__main__":
    main()
