"""build_brand_list.py – brand dictionary for the on-device OCR stage of the live scanner.

What:  counts the brands of the most-scanned products sold in Germany and writes public/models/brands_de.json.
       A curated list of non-food brands that often appear in creator videos (tech, beauty, fashion, cars) is
       added on top.
       v1 (20 Nov): 10,000 products via the search-a-licious API (food only) → 868 brands.
       v2 (21 Nov, --dumps <dir>): the full ODbL dumps (tools/build_brand_data.py) – 60,000 most-scanned German
       food products + Open Beauty Facts + Open Products Facts + every brand of the own model (brand_head.json),
       so text recognition (stage 3) and the own model (stage 4) know the same brands.
Why:   OCR reads words like "KABA" or "Lorenz" on a package; the scanner only accepts a word as a brand if it
       matches this dictionary (exact or very close), which keeps random text ("Erdbeere", "700g") out.
Used:  public/js/ocr.js (matchBrands). Re-run when the list should be refreshed:
       python tools/build_brand_list.py            (≈ 1 min, 20 polite API calls)
       daten_s3/py tools/build_brand_list.py --dumps daten_s3   (v2, offline from the dumps, seconds)
"""
import collections, json, re, subprocess, time, unicodedata
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "models" / "brands_de.json"
UA = "PlacementRadar-CourseProject/0.1"
API = ("https://search.openfoodfacts.org/search?q=countries_tags:%22en:germany%22&page_size=500&page={p}"
       "&fields=code,brands,unique_scans_n&sort_by=-unique_scans_n")

# Words that are brands in Open Food Facts but also ordinary package text → never accept them from OCR
STOP = {"bio", "u", "you", "166", "unknown", "sansmarque", "nichtbekannt", "original", "classic", "premium", "gourmet",
        "natur", "vegan", "choco", "family", "kids", "gold", "fresh", "best", "select", "light", "zero", "plus", "the",
        "pur", "fit", "sun", "bel", "noa", "vly", "hak", "ibu", "esn", "dmk", "sb", "hp", "harry", "eco", "ecoplus", "lu",
        "storck", "coop", "migros", "chefselect", "snackday", "vemondo", "kania", "combino", "italiamo",
        # v2: brand names that are also everyday package words (exact hits would fire on ordinary text)
        "american", "share", "more", "tip", "today", "iam", "cd", "bbq", "bravo", "karma", "real", "natural", "nature",
        "sport", "energy", "power", "protein", "pure", "basic", "smart", "happy", "good", "free", "life", "home",
        "kitchen", "chef", "garden", "farm", "gold", "silver", "star", "king", "queen", "royal", "premium", "deluxe",
        "favorit", "favourites", "lieblings", "genuss", "feine", "beste", "gut", "ja", "k", "m", "s", "x", "w5", "ace",
        "sun", "mir", "nana", "carat", "brunch", "felix", "classico", "cucina", "trattoria", "asia", "bio", "veggie",
        "snack", "choco", "crispy", "crunchy", "kids", "baby", "men", "women", "care", "skin", "hair", "body", "face",
        "soft", "sensitive", "fresh", "clean", "white", "black", "red", "green", "blue", "pink", "aqua", "vital", "balance",
        "skyr", "frisch", "grafschaft", "joghurt", "quark", "milch", "butter", "sahne", "kase", "honig", "kaffee", "tee",
        "wasser", "saft", "brot", "nudeln", "pasta", "reis", "mehl", "zucker", "salz", "ol", "essig", "senf", "ketchup",
        "mayo", "pesto", "wurst", "schinken", "salami", "lachs", "thunfisch", "gemuse", "obst", "muesli", "musli", "granola",
        "nuss", "mandel", "kakao", "schoko", "vanille", "erdbeer", "kirsch", "apfel", "zitrone", "orange", "mango", "kokos",
        "hafer", "dinkel", "vollkorn", "protein", "eiweiss", "fit", "lecker", "gut", "lieblich", "herzhaft", "wurzig",
        "landmilch", "alpen", "berg", "heimat", "region", "regional", "hof", "bauer", "markt", "frische", "genuss",
        "original", "traditional", "tradition", "since", "seit", "family", "edition", "limited", "neu", "new"}
# Common legal suffixes ("Alnatura GmbH" → "Alnatura")
SUFFIX = re.compile(r"\s+(gmbh|ag|kg|se|co\.?\s*kg|gmbh\s*&\s*co\.?\s*kg|ltd|inc|s\.?a\.?|b\.?v\.?|as)\.?$", re.I)

# Non-food brands seen in creator videos (test videos, LogoDet-style household names) – OFF only knows food
EXTRA = ["Nike", "Adidas", "Puma", "Apple", "Samsung", "Sony", "Dyson", "BMW", "Volvo", "Mercedes-Benz", "Audi", "Volkswagen",
         "Tesla", "Porsche", "Louis Vuitton", "Gucci", "Guess", "Michael Kors", "Chanel", "Dior", "Prada", "e.l.f.", "L'Oréal",
         "Nivea", "Maybelline", "Tarte", "Rare Beauty", "Glow Recipe", "Fenty Beauty", "Anastasia Beverly Hills", "Beautyblender",
         "Josie Maran", "Wet Ones", "Oral-B", "Colgate", "Labello", "Balea", "Rossmann", "Garnier", "Dove", "Head & Shoulders",
         "Pantene", "Gillette", "Philips", "Bosch", "Siemens", "Miele", "Lego", "Canon", "Nikon", "Nintendo", "PlayStation",
         "Xbox", "Microsoft", "Google", "Xiaomi", "Huawei", "JBL", "Bose", "Beats", "GoPro", "DJI", "Logitech", "Ray-Ban",
         "Rolex", "Casio", "Tchibo", "Nespresso", "Starbucks", "McDonald's", "Amazon", "Zara", "H&M", "HEAD", "Red Bull",
         "Monster Energy", "IKEA", "dm", "Hello Kitty", "Kate Spade", "Lacoste", "Tommy Hilfiger", "Calvin Klein", "Levi's",
         "The North Face", "Patagonia", "New Balance", "Converse", "Vans", "Reebok", "Under Armour", "Asics", "Fila",
         "Kaba", "Prinzen Rolle", "De Beukelaer", "ültje", "Lorenz", "Zentis", "Meggle", "Babybel", "Manner",
         "Bahlsen", "Leibniz", "Pick Up!", "Hanuta", "Duplo", "Raffaello", "Toffifee", "Merci", "Werther's", "Katjes",
         "Trolli", "Chio", "Pombär", "Bifi", "Capri-Sun", "Fanta", "Sprite", "Pepsi", "Mezzo Mix", "Club-Mate", "Fritz-Kola",
         "Volvic", "Gerolsteiner", "Vittel", "Evian", "Becks", "Krombacher", "Warsteiner", "Bitburger", "Jägermeister"]


def key(name: str) -> str:
    s = unicodedata.normalize("NFKD", name.lower()).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s)


def fetch():
    hits = []
    for p in range(1, 21):
        # curl instead of urllib: the python.org build on macOS ships without root certificates
        out = subprocess.run(["curl", "-s", "-m", "90", "-A", UA, API.format(p=p)], capture_output=True, text=True).stdout
        hits += json.loads(out)["hits"]
        time.sleep(1.5)  # be polite to Open Food Facts
    return hits


def fetch_dumps(d):
    """v2: same record shape as the API ({brands, unique_scans_n}) from the parquet/jsonl dumps"""
    import gzip
    import polars as pl
    food = (pl.scan_parquet(d / "dumps" / "food.parquet").select(["brands", "countries_tags", "unique_scans_n"])
            .filter(pl.col("countries_tags").list.contains("en:germany") & pl.col("brands").is_not_null())
            .sort("unique_scans_n", descending=True, nulls_last=True).head(60000).collect())
    beauty = (pl.scan_parquet(d / "dumps" / "beauty.parquet").select(["brands", "countries_tags", "unique_scans_n"])
              .filter(pl.col("brands").is_not_null() & pl.col("countries_tags").list.contains("en:germany")).collect())
    hits = [{"brands": b, "unique_scans_n": n} for df in (food, beauty) for b, n in zip(df["brands"].to_list(), df["unique_scans_n"].to_list())]
    with gzip.open(d / "dumps" / "opf.jsonl.gz", "rt") as fh:
        for line in fh:
            j = json.loads(line)
            if j.get("brands") and "en:germany" in (j.get("countries_tags") or []):
                hits.append({"brands": j["brands"], "unique_scans_n": j.get("unique_scans_n") or 0})
    return hits


def main():
    import sys
    dumps = Path(sys.argv[sys.argv.index("--dumps") + 1]) if "--dumps" in sys.argv else None
    products, scans, forms = collections.Counter(), collections.Counter(), collections.defaultdict(collections.Counter)
    for h in (fetch_dumps(dumps) if dumps else fetch()):
        b = h.get("brands") or []
        if isinstance(b, str):
            b = b.split(",")
        for name in b[:3]:
            name = SUFFIX.sub("", name.strip())
            k = key(name)
            if len(k) < (3 if dumps else 2) or k in STOP:
                continue
            products[k] += 1
            scans[k] += h.get("unique_scans_n") or 0
            forms[k][name] += 1
    brands = {}
    for k, n in products.most_common():
        if n < 3:
            break
        brands[k] = {"name": forms[k].most_common(1)[0][0], "key": k, "products": n, "source": "off"}
    if dumps:  # misspelled duplicates in the open data ("Grafschafer" next to "Grafschafter"): keep the more frequent spelling
        def near(a, b):
            if abs(len(a) - len(b)) > 1:
                return False
            i = 0
            while i < min(len(a), len(b)) and a[i] == b[i]:
                i += 1
            return a[i + 1:] == b[i + 1:] or a[i:] == b[i + 1:] or a[i + 1:] == b[i:]
        order = list(brands)  # most products first
        drop = set()
        for i, k in enumerate(order):
            if len(k) >= 6 and any(near(k, o) for o in order[:i] if o not in drop and len(o) >= 6):
                drop.add(k)
        for k in drop:
            del brands[k]
        print(f"merged {len(drop)} misspelled duplicates")
    for name in EXTRA:
        k = key(name)
        brands.setdefault(k, {"name": name, "key": k, "products": 0, "source": "curated"})
    if dumps:  # every brand the own model knows (stage 4) is also readable as text (stage 3)
        head = json.loads((OUT.parent / "brand_head.json").read_text())
        for name in head["names"]:
            k = key(name)
            if name != head.get("other") and len(k) >= 3 and k not in STOP:
                brands.setdefault(k, {"name": name, "key": k, "products": 0, "source": "model"})
    out = {"source": ("Open Food Facts + Open Beauty Facts + Open Products Facts dumps (ODbL): 60,000 most-scanned food products "
                      "in Germany, cosmetics and household products sold in Germany, the brands of the own model + curated non-food brands")
           if dumps else "Open Food Facts (ODbL), 10,000 most-scanned products in Germany + curated non-food brands",
           "built": time.strftime("%Y-%m-%d"), "brands": list(brands.values())}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(brands)} brands → {OUT}")


if __name__ == "__main__":
    main()
