"""
build_demo_from_tests.py
------------------------
Turns the raw results of our feasibility tests (../tests/ergebnisse/*.json) into the
data format the PlacementRadar app reads (public/data/<video-id>.json + public/data/index.json).

Why: the demo videos must work instantly and without spending Gemini quota.
Later, tools/prepare_demo.py will produce the same format directly from fresh Gemini runs.

Data format (one file per video) - see README.md, section "Data model":
{
  "video":   {id, title, channel, views, duration_s, upload_date, description},
  "brands":  [{brand, product, category, appearances:[{start_s, end_s, channel, size, position, in_use, evidence, frame_s?, box?}]}],
  "disclosures": [{time_s, kind, text}],
  "paid":    {looks_like_paid_promotion, reasoning},
  "authenticity": [{brand, product, overall, verdict, sub:{use_shown|balance|specificity|delivery|body_language|sales_pressure:{score,time_s,evidence}}}],
  "source":  {engine:"gemini", models:[...], analyzed_at, note}
}
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]          # placementradar/
TESTS = ROOT.parent / "tests" / "ergebnisse"                 # raw test results
OUT = ROOT / "public" / "data"
OUT.mkdir(parents=True, exist_ok=True)

# Same brand written differently by different runs -> one canonical name
ALIASES = {
    "tarte": "Tarte Cosmetics", "tarte cosmetics": "Tarte Cosmetics",
    "hate stains co.": "The Hate Stains Co.", "the hate stains co.": "The Hate Stains Co.",
    "glücksstoff": "Glückstoff", "glückstoff": "Glückstoff", "head": "HEAD",
}


def canon(name: str) -> str:
    return ALIASES.get(name.strip().lower(), name.strip())


def sec(t) -> float:
    """'01:05' -> 65.0 ; plain numbers are returned unchanged"""
    if isinstance(t, (int, float)):
        return float(t)
    n = 0.0
    for part in str(t).split(":"):
        n = n * 60 + float(part or 0)
    return n


def mmss_number_fix(n: float) -> float:
    """Early test runs returned 1:25 as the NUMBER 125. Convert 125 -> 85 s."""
    n = int(n)
    return float((n // 100) * 60 + n % 100)


def load(name):
    p = TESTS / name
    return json.loads(p.read_text()) if p.exists() else None


def build(video_id, timeline_file, extra_file=None, number_bug=False, note=""):
    a = load(timeline_file)
    if not a or "result" not in a:
        print("skip", video_id, "- no result in", timeline_file)
        return None
    meta = a.get("meta", {})
    res = a["result"]
    brands = {}
    for b in res["brands"]:
        key = canon(b["brand"])
        entry = brands.setdefault(key, {"brand": key, "product": b.get("product", ""), "category": b.get("category", ""), "appearances": []})
        for ap in b["appearances"]:
            s = ap.get("start_s", ap.get("start"))
            e = ap.get("end_s", ap.get("end"))
            s, e = sec(s), sec(e)
            if number_bug:
                s, e = mmss_number_fix(s), mmss_number_fix(e)
            entry["appearances"].append({
                "start_s": s, "end_s": max(e, s + 1), "channel": ap.get("channel", "visual"),
                "size": ap.get("size"), "position": ap.get("position"), "in_use": ap.get("in_use"),
                "evidence": ap.get("evidence", ""),
            })
    authenticity = []
    disclosures = [{"time_s": sec(d.get("time", d.get("time_s", 0))), "kind": d.get("kind", ""), "text": d.get("text", "")}
                   for d in res.get("disclosures", [])]
    models = [a.get("model")]
    # Second run (test E) adds frame positions ("Pause & Find") and the authenticity score
    if extra_file:
        x = load(extra_file)
        if x and "result" in x:
            models.append(x.get("model"))
            for b in x["result"]["brands"]:
                key = canon(b["brand"])
                entry = brands.setdefault(key, {"brand": key, "product": b.get("product", ""), "category": "", "appearances": []})
                for ap in b["appearances"]:
                    if ap.get("box_2d") and ap.get("frame_s") is not None:
                        entry.setdefault("frames", []).append({"t": ap["frame_s"], "box": ap["box_2d"]})
            for au in x["result"].get("authenticity", []):
                sub = {}
                for k in ["use_shown", "balance", "specificity", "delivery", "body_language", "sales_pressure"]:
                    v = au.get(k) or {}
                    sub[k] = {"score": v.get("score"), "time_s": sec(v["time"]) if v.get("time") else None, "evidence": v.get("evidence", "")}
                authenticity.append({"brand": canon(au["brand"]), "product": au.get("product", ""), "overall": au["overall"],
                                     "verdict": au.get("verdict", ""), "sub": sub})
    for b in brands.values():
        b["appearances"].sort(key=lambda ap: ap["start_s"])
    data = {
        "video": {"id": video_id, "title": meta.get("title", ""), "channel": meta.get("channel", ""),
                  "views": meta.get("view_count"), "duration_s": meta.get("duration"),
                  "upload_date": meta.get("upload_date"), "description": meta.get("description", "")},
        "brands": sorted(brands.values(), key=lambda b: -sum(ap["end_s"] - ap["start_s"] for ap in b["appearances"])),
        "disclosures": disclosures,
        "paid": {"looks_like_paid_promotion": res.get("looks_like_paid_promotion"), "reasoning": res.get("reasoning", "")},
        "authenticity": authenticity,
        "source": {"engine": "gemini", "models": [m for m in models if m], "analyzed_at": "2026-11-19", "note": note},
    }
    (OUT / f"{video_id}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1))
    print(f"{video_id}: {len(data['brands'])} brands, {len(disclosures)} disclosures, {len(authenticity)} authenticity")
    return data


demos = [
    build("dhFY1yo83d4", "A_dhFY1yo83d4_gemini-3.8-flash_mmss.json", "E_dhFY1yo83d4_1.json",
          note="Feasibility test run; gifted product with spoken disclosure"),
    build("2fAruP6qKd4", "A_2fAruP6qKd4_gemini-3.7-flash_mmss.json", "E_2fAruP6qKd4_1.json",
          note="Feasibility test run; affiliate link without ad label"),
    build("wtDyhM_18Yo", "A_wtDyhM_18Yo_gemini-3.8-flash.json", number_bug=True,
          note="Feasibility test run; editorial content, no sponsorship"),
]
index = [{"id": d["video"]["id"], "title": d["video"]["title"], "channel": d["video"]["channel"],
          "views": d["video"]["views"], "duration_s": d["video"]["duration_s"], "brands": len(d["brands"])}
         for d in demos if d]
(OUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1))
print("index.json:", len(index), "demos")
