"""build_brand_data.py – training photos for brand model v2 (stage 4 of the live scanner): ~1,000 brands.

What:  reads the full open data dumps instead of the throttled search API and picks the brands of German retail:
         - Open Food Facts   food.parquet   (Hugging Face: openfoodfacts/product-database, products sold in Germany)
         - Open Beauty Facts beauty.parquet (same dataset; brands that are also sold in Germany)
         - Open Products Facts openproductsfacts-products.jsonl.gz (household, tech, toys …)
       All three are ODbL (Open Database Licence); the photos are CC BY-SA (contributors of the three projects).
       Per product up to two photos: the community's cropped front picture (clean packshot) and the original upload
       behind it (hand, shelf, table – closer to a webcam frame). Originals of food come from the AWS bucket
       `openfoodfacts-images` (no rate limit), crops and the other two projects from their image servers (polite).
Why:   v1 knew 131 brands (20,000 most-scanned products via the search API). Most packs in a real kitchen were
       "unknown brand" → wider coverage is the biggest lever. Brands are ranked by how often their products are
       scanned (unique_scans_n), i.e. by how likely they are to be in front of a camera in Germany.
Split: by product, never by photo. Kept stable against v1 so before/after can be compared on the SAME data:
         - v1's 741 held-back test products stay test products (if their brand is still a class)
         - v1's 146 unknown-brand packs, the 49 phone photos of the OCR test: never used for training
Sets:  train / test (classes) · unknown (brands that are not classes – false-alarm test) ·
       hardpool (non-class packs; the training script keeps the 300 that LOOK most like a known brand – hard false-alarm test) ·
       other (non-class packs for mining hard negatives during training, never tested)
Out:   <data>/img/<code>_<f|o>.jpg  +  <data>/index_v2.json  [{code, brand, key, domain, split, files}]
Run:   python tools/build_brand_data.py <data dir with dumps/> [--no-download]
"""
import concurrent.futures as cf, gzip, json, random, re, subprocess, sys, time, unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import polars as pl

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else ROOT.parent / "daten_s3"
V1 = ROOT.parent / "daten_s2"
IMG = DATA / "img"
UA = "PlacementRadar-CourseProject/0.2"
N_FOOD, N_BEAUTY, N_PRODUCTS = 820, 150, 50   # class budget per domain (≈ 1,000 brands together)
MIN_PRODUCTS = 10                             # a brand needs this many products with a front photo
MIN_PRODUCTS_SMALL = 7                        # … beauty / products: fewer products per brand in those databases
MAX_PRODUCTS = 30                             # most-scanned products per brand (keeps giants from dominating)
TEST_SHARE = 0.2

UMBRELLA = {"lidl", "aldi", "rewe", "nestle", "mondelez", "unilever", "pepsico", "savencia", "ferrero", "mars",
            "kaufland", "penny", "nettomd", "carrefour", "tesco", "lindtsprungli", "marquerepere", "migrosbio",
            "naturaplan", "mclassic", "hacendado", "deluxe", "biobio", "bioorganic", "dm", "farmer", "edeka", "coop",
            "migros", "spar", "auchan", "henkel", "procterandgamble", "procter", "pg", "reckitt", "colgatepalmolive",
            "bio", "beiersdorf", "proctergamble", "gsk", "haleon", "colgatepalmolivenorge", "kruidvat", "leaderprice",
            "lorealnorgeas", "unileverdeutschland", "henkelag", "reckittbenckiser", "johnsonjohnson", "kenvue", "edekazentrale",
            "reckittbenckiserhealthcare", "scjohnson", "philipmorris", "unknown", "sansmarque", "nichtbekannt", "nomarca", "generic", "nobrand", "none", "na", "u",
            "mercadona", "monoprix", "intermarche", "leclerc", "casino", "delhaize", "albertheijn", "jumbo", "hema",
            "tedi", "action", "famila", "globus", "netto", "real", "norma", "markant", "selgros", "metro", "aro"}
ALIAS = {"danoneas": "danone", "danonebeluxnv": "danone", "lindtsprungli": "lindt", "cocacolaservicessanv": "cocacola",
         "cocacolacompany": "cocacola", "thecocacolacompany": "cocacola", "loralparis": "loreal", "lorealparis": "loreal",
         "kinderferrero": "kinder", "drozker": "droetker", "droetkergmbh": "droetker", "mullermilch": "muller",
         "muellermilch": "muller", "headandshoulders": "headshoulders", "johnsonsbaby": "johnsons",
         # sub-lines of one brand: same name on the pack → one class (OCR reads the parent name anyway)
         "garnierfructis": "garnier", "fructis": "garnier", "garnierskinactive": "garnier", "laveranaturkosmetik": "lavera",
         "alterranaturkosmetik": "alterra", "alverdenaturkosmetik": "alverde", "loccitaneenprovence": "loccitane",
         "panteneprov": "pantene", "baleadm": "balea", "baleamen": "balea", "baleamed": "balea", "niveamen": "nivea",
         "niveasun": "nivea", "isanamen": "isana", "isanamed": "isana", "lorealmenexpert": "loreal", "cienmen": "cien",
         "ciensun": "cien", "schwarzkopfhenkel": "schwarzkopf", "stabiloboss": "stabilo", "kbioorganic": "kbio",
         "edekaherzstucke": "edeka", "pringlesllc": "pringles", "odolmed3": "odol", "lorealelseve": "loreal",
         "elseve": "loreal", "colgatepalmolive": "colgate", "gutundgunstig": "gutgunstig", "maybellinenewyork": "maybelline",
         "niveababy": "nivea", "baleaprofessional": "balea"}
DISPLAY = {"danone": "Danone", "lindt": "Lindt", "rewebestewahl": "REWE Beste Wahl", "cocacola": "Coca-Cola",
           "loreal": "L'Oréal", "droetker": "Dr. Oetker", "muller": "Müller", "oralb": "Oral-B", "dmbio": "dmBio", "nivea": "Nivea", "garnier": "Garnier", "balea": "Balea", "edeka": "EDEKA",
           "headshoulders": "Head & Shoulders", "kclassic": "K-Classic", "ja": "ja!", "gutgunstig": "Gut & Günstig"}
TOBACCO = {"marlboro", "camel", "winston", "lm", "chesterfield", "luckystrike", "pallmall", "gauloises", "davidoff", "westzigaretten"}
SUFFIX = re.compile(r"\s+(gmbh|ag|kg|se|co\.?\s*kg|gmbh\s*&\s*co\.?\s*kg|ltd|inc|s\.?a\.?|b\.?v\.?|as|nv|sas|srl|spa)\.?$", re.I)


def key(name):
    s = unicodedata.normalize("NFKD", SUFFIX.sub("", name.strip()).lower()).encode("ascii", "ignore").decode()
    k = re.sub(r"[^a-z0-9]", "", s)
    return ALIAS.get(k, k)


def product_path(code):
    return f"{code[0:3]}/{code[3:6]}/{code[6:9]}/{code[9:]}" if len(code) > 8 else code


def load_parquet(name, domain, host, germany_only):
    """one row per product with its selected front picture (German first); the heavy images column stays in polars"""
    base = pl.scan_parquet(DATA / "dumps" / name).select(["code", "brands", "countries_tags", "unique_scans_n", "images"])
    if germany_only:
        base = base.filter(pl.col("countries_tags").list.contains("en:germany"))
    base = base.filter(pl.col("brands").is_not_null() & pl.col("code").is_not_null())
    fr = (base.select("code", "images").explode("images").unnest("images")
          .filter(pl.col("key").str.starts_with("front_") & pl.col("imgid").is_not_null() & pl.col("rev").is_not_null())
          .with_columns(pl.when(pl.col("key") == "front_de").then(0).when(pl.col("key") == "front_en").then(1).otherwise(2).alias("prio"))
          .sort(["code", "prio"]).group_by("code").first().select("code", "key", "imgid", "rev"))
    df = base.select("code", "brands", "countries_tags", "unique_scans_n").join(fr, on="code").collect()
    out = []
    for code, brands, ctry, scans, k, imgid, rev in zip(*(df[c].to_list() for c in df.columns)):
        out.append({"code": code, "brands": brands, "de": bool(ctry) and "en:germany" in ctry, "scans": scans or 0,
                    "front": (k, imgid, rev), "domain": domain, "host": host})
    return out


def load_opf():
    out = []
    with gzip.open(DATA / "dumps" / "opf.jsonl.gz", "rt") as fh:
        for line in fh:
            d = json.loads(line)
            sel = ((d.get("images") or {}).get("selected") or {}).get("front") or {}
            lang = "de" if "de" in sel else "en" if "en" in sel else next(iter(sel), None)
            if not lang or not d.get("brands") or not d.get("code"):
                continue
            f = sel[lang]
            if f.get("imgid") and f.get("rev"):
                out.append({"code": d["code"], "brands": d["brands"], "de": "en:germany" in (d.get("countries_tags") or []),
                            "scans": d.get("unique_scans_n") or 0, "front": (f"front_{lang}", f["imgid"], f["rev"]),
                            "domain": "products", "host": "openproductsfacts"})
    return out


def brand_of(p, classes=None):
    ks = [key(n) for n in p["brands"].split(",")[:3]]
    ks = [k for k in ks if len(k) >= 2 and k not in UMBRELLA and k not in TOBACCO and not k.isdigit()]
    if classes is None:
        return ks[0] if ks else None
    return next((k for k in ks if k in classes), None)


def urls(p):
    path, (lang, imgid, rev) = product_path(p["code"]), p["front"]
    base = f"https://images.{p['host']}.org/images/products/{path}"
    orig = (f"https://openfoodfacts-images.s3.eu-west-3.amazonaws.com/data/{path}/{imgid}.400.jpg"
            if p["host"] == "openfoodfacts" else f"{base}/{imgid}.400.jpg")
    return {"f": f"{base}/{lang}.{rev}.400.jpg", "o": orig}


def edit1(a, b):
    """True if a and b differ by at most one edit (lookalike brand names)"""
    if abs(len(a) - len(b)) > 1 or a == b:
        return False
    i = 0
    while i < min(len(a), len(b)) and a[i] == b[i]:
        i += 1
    return a[i + 1:] == b[i + 1:] or a[i:] == b[i + 1:] or a[i + 1:] == b[i:]


def main():
    t0 = time.time()
    food = load_parquet("food.parquet", "food", "openfoodfacts", True)
    beauty = load_parquet("beauty.parquet", "beauty", "openbeautyfacts", False)
    prods = load_opf()
    print(f"products with a front photo: food DE {len(food)}, beauty {len(beauty)}, products {len(prods)} ({time.time() - t0:.0f}s)")

    # --- fixed sets of v1 (never train on them / keep them as test) ---
    v1 = json.loads((V1 / "index.json").read_text())
    v1_test = {d["code"] for d in v1 if d["split"] == "test"}
    v1_unknown = {d["code"] for d in json.loads((V1 / "index_unknown.json").read_text())}
    ocr49 = {p.stem for p in (ROOT.parent / "tests" / "galerie_off" / "anfragen").glob("*.jpg")}
    echt = {p.stem.split("__")[0] for p in (ROOT.parent / "tests" / "echt").rglob("*.jpg")}  # never in training
    banned = v1_unknown | ocr49 | echt

    # --- pick classes per domain: rank brands by total scans, require enough products ---
    names = defaultdict(Counter)
    classes, domain_of = [], {}
    for pool, budget, need, de_need in [(food, N_FOOD, MIN_PRODUCTS, 0), (beauty, N_BEAUTY, MIN_PRODUCTS_SMALL, 2), (prods, N_PRODUCTS, MIN_PRODUCTS_SMALL, 1)]:
        n, scans, de = Counter(), Counter(), Counter()
        for p in pool:
            k = brand_of(p)
            if k:
                n[k] += 1; scans[k] += p["scans"]; de[k] += p["de"]
                for n_ in p["brands"].split(",")[:3]:
                    if key(n_) == k:
                        names[k][SUFFIX.sub("", n_.strip())] += 1
        ok = [k for k in n if n[k] >= need and de[k] >= de_need and k not in domain_of]
        ok.sort(key=lambda k: (-scans[k], -n[k]))
        for k in ok[:budget]:
            classes.append(k); domain_of[k] = pool[0]["domain"]
        print(f"  {pool[0]['domain']}: {len(ok)} eligible brands → {min(budget, len(ok))} classes")
    cls = set(classes)

    # --- products per class: most-scanned first, German first, cap ---
    per = defaultdict(list)
    for p in food + beauty + prods:
        if p["code"] in banned:
            continue
        k = brand_of(p, cls)
        if k:
            per[k].append(p)
    rnd = random.Random(7)
    items = []
    for k in classes:
        # v1 test products first (same test data before/after), then the most-scanned German products
        ps = sorted({p["code"]: p for p in per[k]}.values(), key=lambda p: (p["code"] not in v1_test, -p["de"], -p["scans"]))[:MAX_PRODUCTS]
        if len(ps) < 4:
            continue
        forced = [p for p in ps if p["code"] in v1_test]
        rest = [p for p in ps if p["code"] not in v1_test]
        rnd.shuffle(rest)
        n_test = max(2, round(len(ps) * TEST_SHARE)) - len(forced)
        disp = DISPLAY.get(k) or names[k].most_common(1)[0][0]
        for i, p in enumerate(forced + rest):
            items.append({"code": p["code"], "brand": disp, "key": k, "domain": domain_of[k], "split": "test" if p in forced or i - len(forced) < n_test else "train", "urls": urls(p)})
    print(f"{len({i['key'] for i in items})} classes, {len(items)} products "
          f"({sum(i['split'] == 'test' for i in items)} test, of them {sum(i['code'] in v1_test for i in items)} from v1)")

    # --- non-class packs: unknown (test), lookalike (test), other (hard-negative pool for training) ---
    taken = {i["code"] for i in items}
    nonclass = [p for p in food + beauty + prods if p["code"] not in taken and p["code"] not in banned
                and brand_of(p) and brand_of(p, cls) is None and not any(key(n) in cls for n in p["brands"].split(","))]
    by_len = defaultdict(list)
    for c in cls:
        by_len[len(c)].append(c)
    pre = {c[:4] for c in cls if len(c) >= 4}
    def lookalike(b):
        if any(edit1(b, c) for n in (len(b) - 1, len(b), len(b) + 1) for c in by_len[n]):
            return True
        return b[:4] in pre and any(b.startswith(c) and b != c for c in cls if len(c) >= 4 and c[:4] == b[:4])
    # names that are a near-spelling of a class ("Dennre", "Pringles LLC") are probably the SAME brand → never use
    # them as "foreign brand" (a correct answer would be counted as a false alarm)
    rest = [p for p in nonclass if not lookalike(brand_of(p))]
    rnd.shuffle(rest)
    # hardpool: candidates for the "lookalike" test – the training script keeps the 300 packs whose fingerprint is
    # closest to a known brand (looks like one of ours, but is not), chosen with the frozen encoder, not the head
    unknown, look, other = rest[:400], rest[400:2400], rest[2400:6400]
    def side(ps, split):
        return [{"code": p["code"], "brand": f"({p['brands'].split(',')[0].strip()})", "key": "", "domain": p["domain"], "split": split,
                 "urls": {"o": urls(p)["o"]} if split != "other" else urls(p)} for p in ps]
    items += side(unknown, "unknown") + side(look, "hardpool") + side(other, "other")
    print(f"non-class packs: unknown {len(unknown)}, hardpool {len(look)}, other {len(other)} (near-spellings dropped: {len(nonclass) - len(rest)})")

    if "--no-download" not in sys.argv:
        IMG.mkdir(parents=True, exist_ok=True)
        old_img = V1 / "img"

        def download(p):
            files = []
            for tag, url in p["urls"].items():
                dst = IMG / f"{p['code']}_{tag}.jpg"
                if not dst.exists() and (old_img / dst.name).exists():
                    dst.write_bytes((old_img / dst.name).read_bytes())   # same photo already fetched for v1
                for attempt in range(4):  # the image servers throttle bursts (HTTP 429/503) → back off and retry
                    if dst.exists():
                        break
                    r = subprocess.run(["curl", "-s", "-f", "-m", "40", "-A", UA, url, "-o", str(dst), "-w", "%{http_code}"], capture_output=True, text=True)
                    if r.stdout.strip() == "404":
                        break
                    if "amazonaws" not in url:
                        time.sleep(0.2)  # be polite to the project servers (the S3 bucket is meant for bulk)
                    if not dst.exists():
                        time.sleep(3 * (attempt + 1))
                if dst.exists() and dst.stat().st_size > 3000:
                    files.append(dst.name)
                elif dst.exists():
                    dst.unlink()
            return {k: v for k, v in p.items() if k != "urls"} | {"files": files}

        done = []
        with cf.ThreadPoolExecutor(6) as ex:
            for i, r in enumerate(ex.map(download, items)):
                done.append(r)
                if i % 1000 == 0:
                    print(f"  {i}/{len(items)} products downloaded ({time.time() - t0:.0f}s)", flush=True)
        items = [d for d in done if d["files"]]
    (DATA / "index_v2.json").write_text(json.dumps(items, ensure_ascii=False, indent=0))
    c = Counter(d["split"] for d in items)
    print(f"done: {dict(c)}, {sum(len(d.get('files', [])) for d in items)} photos, "
          f"{len({d['key'] for d in items if d['key']})} brands → {DATA / 'index_v2.json'} ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
