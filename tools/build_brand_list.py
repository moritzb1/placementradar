"""build_brand_list.py – brand dictionary for the on-device OCR stage of the live scanner.

What:  pulls the 10,000 most-scanned products sold in Germany from Open Food Facts (search-a-licious API,
       ODbL data), counts their brands and writes public/models/brands_de.json. A curated list of non-food
       brands that often appear in creator videos (tech, beauty, fashion, cars) is added on top.
Why:   OCR reads words like "KABA" or "Lorenz" on a package; the scanner only accepts a word as a brand if it
       matches this dictionary (exact or very close), which keeps random text ("Erdbeere", "700g") out.
Used:  public/js/ocr.js (matchBrands). Re-run when the list should be refreshed:
       python tools/build_brand_list.py            (≈ 1 min, 20 polite API calls)
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
        "storck", "coop", "migros", "chefselect", "snackday", "vemondo", "kania", "combino", "italiamo"}
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


def main():
    products, scans, forms = collections.Counter(), collections.Counter(), collections.defaultdict(collections.Counter)
    for h in fetch():
        b = h.get("brands") or []
        if isinstance(b, str):
            b = b.split(",")
        for name in b[:3]:
            name = SUFFIX.sub("", name.strip())
            k = key(name)
            if len(k) < 2 or k in STOP:
                continue
            products[k] += 1
            scans[k] += h.get("unique_scans_n") or 0
            forms[k][name] += 1
    brands = {}
    for k, n in products.most_common():
        if n < 3:
            break
        brands[k] = {"name": forms[k].most_common(1)[0][0], "key": k, "products": n, "source": "off"}
    for name in EXTRA:
        k = key(name)
        brands.setdefault(k, {"name": name, "key": k, "products": 0, "source": "curated"})
    out = {"source": "Open Food Facts (ODbL), 10,000 most-scanned products in Germany + curated non-food brands",
           "built": time.strftime("%Y-%m-%d"), "brands": list(brands.values())}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(brands)} brands → {OUT}")


if __name__ == "__main__":
    main()
