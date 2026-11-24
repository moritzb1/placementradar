"""build_brand_data_v3.py – training photos for brand model v3: brands that are NOT packaging (tech, fashion, sport,
home, cars …), only from freely licensed photos on Wikimedia Commons.

What:  for every candidate in tools/brands_v3.py the Commons search API is asked for bitmap files whose TITLE contains
       the brand (intitle:"…", so a puma or the Patagonia region is not a brand photo), logos/headquarters excluded.
       Per file we keep licence, author and file page (→ data/brand_v3_sources.csv in the repo, the photos are not).
       Only a 330 px thumbnail is downloaded (enough for the 256 px encoder input). No YouTube frames, no shops,
       no "research only" datasets.
Rules: ≥ 20 usable photos → class (max. 60, best search hits first); 8–19 → FOREIGN brand (false-alarm test only).
       Split by AUTHOR, not by photo: a photographer's series never lands in train and test at the same time.
       Test share ≈ 20 % (≥ 4 photos). Generic photos of the same kind of objects (keyboard, sneaker, car …) without a
       brand query are the negatives: (other)-class training, validation and a separate false-alarm test.
Out:   <data>/img_v3/<key>/<pageid>.jpg  +  <data>/index_v3.json  +  placementradar/data/brand_v3_sources.csv
Run:   python tools/build_brand_data_v3.py <data dir> [--no-download]   (polite: 1 API call at a time, 4 downloads)
"""
import concurrent.futures as cf, csv, subprocess, html, json, random, re, sys, time, unicodedata, urllib.parse, urllib.request, zlib
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from brands_v3 import DISPLAY, entries  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(sys.argv[1])
IMG = DATA / "img_v3"
UA = "PlacementRadar-CourseProject/0.3 (university course project; brand classifier on free images)"
API = "https://commons.wikimedia.org/w/api.php"
MIN_CLASS, MIN_FOREIGN, MAX_PER_BRAND, PER_QUERY = 20, 8, 50, 100
EXCLUDE = "-intitle:logo -intitle:logos -intitle:wordmark -intitle:headquarters -intitle:hauptsitz -intitle:factory -intitle:werk -intitle:icon -intitle:map -intitle:signature"
GENERIC = ["computer keyboard", "computer mouse", "headphones", "earphones", "loudspeaker", "computer monitor", "laptop",
           "smartphone", "tablet computer", "digital camera", "microphone", "game controller", "sneakers", "running shoes",
           "boots", "jacket", "hoodie", "t-shirt", "jeans", "backpack", "handbag", "wallet", "wristwatch", "sunglasses",
           "bicycle", "bicycle helmet", "skis", "tennis racket", "football ball", "water bottle", "thermos", "tent",
           "coffee machine", "espresso machine", "kettle", "toaster", "blender", "frying pan", "kitchen", "desk",
           "office chair", "sofa", "table lamp", "bookshelf", "vacuum cleaner", "power drill", "car interior", "car",
           "motorcycle", "scooter", "pram", "toy", "fountain pen", "notebook paper", "mug", "houseplant", "living room",
           "person portrait", "hands", "street"]
if "--few-generic" in sys.argv: GENERIC = GENERIC[:3]


def key(s):
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", s.lower()).encode("ascii", "ignore").decode())


def get(url, tries=6):
    """GET via curl (the Python builds here lack CA certificates); backs off on 429 / 5xx / timeouts"""
    for i in range(tries):
        r = subprocess.run(["curl", "-sS", "-L", "--max-time", "40", "-A", UA, "-w", "\n%{http_code}", url], capture_output=True)
        body, _, code = r.stdout.rpartition(b"\n")
        if r.returncode == 0 and code.strip() == b"200":
            return body
        if i == tries - 1:
            raise RuntimeError(f"HTTP {code.decode(errors='ignore')} {r.stderr.decode(errors='ignore')[:80]}")
        time.sleep(min(60, 3 * 2 ** i) if code.strip() in (b"429", b"503") else 2 + i * 2)


def search(q, limit):
    """Commons file search with licence + author + 330 px thumbnail, best hits first"""
    out, cont = [], {}
    while len(out) < limit:
        p = {"action": "query", "format": "json", "generator": "search", "gsrnamespace": 6, "gsrsearch": q,
             "gsrlimit": 50, "prop": "imageinfo", "iiprop": "url|extmetadata|size|mime", "iiurlwidth": 330,
             "iiextmetadatafilter": "LicenseShortName|Artist|UsageTerms|Credit", "maxlag": 5, **cont}
        d = json.loads(get(API + "?" + urllib.parse.urlencode(p)))
        pages = sorted(d.get("query", {}).get("pages", {}).values(), key=lambda x: x.get("index", 0))
        for pg in pages:
            ii = (pg.get("imageinfo") or [{}])[0]
            md = ii.get("extmetadata", {})
            out.append({"pageid": pg["pageid"], "title": pg["title"], "mime": ii.get("mime", ""), "w": ii.get("width", 0),
                        "h": ii.get("height", 0), "thumb": ii.get("thumburl"), "page": ii.get("descriptionurl"),
                        "license": md.get("LicenseShortName", {}).get("value", ""),
                        "artist": re.sub(r"<[^>]+>", "", html.unescape(md.get("Artist", {}).get("value", ""))).strip()[:120]})
        if "continue" not in d:
            break
        cont = d["continue"]
        time.sleep(0.5)
    return out


def usable(f, words):
    t = key(f["title"])
    lic = f["license"].lower()
    return (f["thumb"] and f["mime"] in ("image/jpeg", "image/png", "image/webp") and min(f["w"], f["h"]) >= 200
            and lic and "fair use" not in lic and "non-free" not in lic and any(hit(w, f["title"], t) for w in words))


def hit(w, title, tkey):
    """brand word in the file title; short names (LG, H&M, KTM, Ecco …) only as a whole word"""
    k = key(w)
    if len(k) > 4:
        return k in tkey
    return re.search(r"(?<![a-z0-9])" + re.escape(w.lower()) + r"(?![a-z0-9])", title.lower()) is not None


def split_by_author(files, rnd):
    """≈ 20 % test, whole authors only; with a single author the photos themselves are split (flagged)"""
    by = defaultdict(list)
    for f in files:
        by[key(f["artist"]) or "unknown"].append(f)
    groups = list(by.values())
    rnd.shuffle(groups)
    need = max(4, round(len(files) * 0.2))
    test, train = [], []
    for g in sorted(groups, key=len):            # small groups first → test gets several authors
        (test if len(test) < need and len(test) + len(g) <= need * 1.6 else train).extend(g)
    if len(test) < 4 or len(train) < 12:          # one photographer took (almost) everything → split photos
        rnd.shuffle(files)
        return files[:need], files[need:], True
    return test, train, False


def main():
    t0 = time.time()
    IMG.mkdir(parents=True, exist_ok=True)
    cache = DATA / "commons_search_v3.json"            # search results are cached (re-runs cost no API calls)
    S = json.loads(cache.read_text()) if cache.exists() else {}
    brands = defaultdict(lambda: {"files": {}, "cat": None, "queries": []})
    E = entries()
    if len(sys.argv) > 2 and sys.argv[2].startswith('--only='):
        E = [e for e in E if e[0] in sys.argv[2][7:].split(',')]
    plan = []  # (display name, category, search term, query)
    for name, extra, alt, cat in E:
        disp = DISPLAY.get(name, name)
        rest = name[len(disp):].strip() if name.startswith(disp + " ") else ""
        helper = rest if rest and rest == rest.lower() else ""      # "Weber grill" → intitle:"Weber" grill
        for term in [disp if helper else name] + alt:
            plan.append((disp, cat, term, f'intitle:"{term}" filetype:bitmap {helper} {extra} {EXCLUDE}'.replace("  ", " ").replace("  ", " ")))
    gq = [f'"{g}" filetype:bitmap {EXCLUDE}' for g in GENERIC]
    todo = [q for q in dict.fromkeys([p[3] for p in plan] + gq) if q not in S]
    print(f"{len(plan)} brand queries + {len(gq)} generic, {len(todo)} not cached yet", flush=True)

    def run(q):  # 3 searches at a time (Wikimedia asks for moderate, not serial-only, API use with a clear User-Agent)
        try:
            return q, search(q, 60 if q in gq else PER_QUERY)
        except Exception as e:
            print("  search failed", q, e, flush=True); return q, None
    with cf.ThreadPoolExecutor(3) as ex:
        for i, (q, r) in enumerate(ex.map(run, todo)):
            if r is not None:
                S[q] = r
            if i % 50 == 49:
                cache.write_text(json.dumps(S)); print(f"  {i + 1}/{len(todo)} searches ({time.time() - t0:.0f}s)", flush=True)
    cache.write_text(json.dumps(S))
    for disp, cat, term, q in plan:
        b = brands[disp]
        b["cat"] = b["cat"] or cat
        b["queries"].append(q)
        for f in S.get(q, []):
            if usable(f, [term]) and f["pageid"] not in b["files"]:
                b["files"][f["pageid"]] = f
    # generic negatives
    G = {}
    for g, q in zip(GENERIC, gq):
        for f in S.get(q, []):
            if usable(f, [""]) and f["pageid"] not in G:
                G[f["pageid"]] = {**f, "generic": g}

    # a photo found for two brands belongs to neither (ambiguous label)
    owner = defaultdict(set)
    for disp, b in brands.items():
        for pid in b["files"]:
            owner[pid].add(disp)
    idx, src, stats = [], [], {"class": 0, "foreign": 0, "dropped": 0}
    used = set()
    for disp, b in sorted(brands.items()):
        # at most 12 photos per author (one photographer's mall series must not BE the brand), best hits first
        per, fs = defaultdict(int), []
        for pid, f in b["files"].items():
            a = key(f["artist"]) or "unknown"
            if len(owner[pid]) == 1 and per[a] < 12 and len(fs) < MAX_PER_BRAND:
                per[a] += 1; fs.append(f)
        k = key(disp)
        if len(fs) >= MIN_CLASS:
            test, train, by_photo = split_by_author(fs, random.Random(zlib.crc32(k.encode())))
            parts = [("train", train), ("test", test)]
            stats["class"] += 1
        elif len(fs) >= MIN_FOREIGN:
            parts = [("unknown_c", fs)]; by_photo = False
            stats["foreign"] += 1
        else:
            stats["dropped"] += 1
            continue
        for sp, lst in parts:
            for f in lst:
                used.add(f["pageid"])
                idx.append({"code": f"c{f['pageid']}", "brand": disp, "key": k if sp != "unknown_c" else None,
                            "domain": "commons_" + b["cat"], "split": sp, "files": [f"{k}/{f['pageid']}.jpg"],
                            "thumb": f["thumb"], "split_by_photo": by_photo})
                src.append([disp, sp, f["title"], f["page"], f["license"], f["artist"]])
    gl = [f for pid, f in G.items() if pid not in used]
    random.Random(5).shuffle(gl)
    for i, f in enumerate(gl):     # 50 % (other)-class training, 25 % validation negatives, 25 % false-alarm test
        sp = "other_c" if i % 4 < 2 else ("valneg_c" if i % 4 == 2 else "generic_test")
        idx.append({"code": f"g{f['pageid']}", "brand": "(generic: " + f["generic"] + ")", "key": None, "domain": "commons_generic",
                    "split": sp, "files": [f"_generic/{f['pageid']}.jpg"], "thumb": f["thumb"]})
        src.append(["(generic)", sp, f["title"], f["page"], f["license"], f["artist"]])
    print(stats, "generic:", len(gl), "photos:", len(idx))

    if "--no-download" not in sys.argv:
        def dl(d):
            p = IMG / d["files"][0]
            if p.exists() and p.stat().st_size > 1000:
                return True
            p.parent.mkdir(parents=True, exist_ok=True)
            try:
                p.write_bytes(get(d["thumb"])); time.sleep(0.1); return True
            except Exception as e:
                print("  download failed", d["thumb"], e); return False
        with cf.ThreadPoolExecutor(4) as ex:
            ok = list(ex.map(dl, idx))
        print(f"downloaded: {sum(ok)}/{len(idx)} ({time.time() - t0:.0f}s)")
        keep = {d["code"] for d, o in zip(idx, ok) if o}
        idx = [d for d in idx if d["code"] in keep]
    (DATA / "index_v3.json").write_text(json.dumps(idx, ensure_ascii=False))
    dst = ROOT / "data" / "brand_v3_sources.csv"
    dst.parent.mkdir(exist_ok=True)
    with dst.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["brand", "use", "file", "file_page", "licence", "author"])
        w.writerows(sorted(src, key=lambda r: (r[0].lower(), r[1], r[2])))
    print("→", DATA / "index_v3.json", "→", dst, f"({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
