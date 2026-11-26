"""Einzeltest E: (a) Bildposition je Auftritt (box_2d) für „Pause & Find",
(b) Authenticity Score je beworbenem Produkt inkl. Körpersprache.

Aufruf:  python test_e_positionen_authenticity.py <video-id> <lauf-nr>
Ergebnis: ergebnisse/E_<video-id>_<lauf>.json
"""
import json, sys
from gemini_common import frage, video_part, sek, ERG

PROMPT = """You are a brand-placement and influencer-marketing analyst. Watch the whole video (image AND audio).

TASK 1 - Brand appearances. List every brand or branded product that is visible, shown as on-screen text,
or mentioned in speech. Give start/end as MM:SS. For each VISUAL appearance also pick one representative
moment (frame_time, MM:SS) inside it and give the bounding box of the product in that frame as
box_2d = [ymin, xmin, ymax, xmax], normalized to 0-1000.

TASK 2 - Authenticity. For every product that is promoted, gifted, sponsored or recommended, rate how
genuine the recommendation feels to a viewer (0-100 each, higher = more genuine) and give one short
evidence quote or observation with MM:SS for each sub-score:
- use_shown: product is actually used, signs of real use, long-term experience
- balance: mentions downsides, compares with alternatives
- specificity: concrete personal experience instead of marketing claims
- delivery: speaks freely vs. reads a script, tone consistent with the rest of the video
- body_language: eye contact vs. looking off-camera, smile congruent with words, open gestures,
  how the product is held and shown
- sales_pressure: discount codes, calls to action, urgency (100 = no pressure at all)
Then an overall score 0-100 and a one-sentence verdict. This is a perceived-authenticity estimate,
not a judgement of the person.

TASK 3 - Advertising disclosures (on-screen label, spoken, or text) with MM:SS.

Answer with JSON only."""

SUB = {"type": "OBJECT", "properties": {"score": {"type": "INTEGER"}, "time": {"type": "STRING"}, "evidence": {"type": "STRING"}},
       "required": ["score", "evidence"]}
SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "brands": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "brand": {"type": "STRING"}, "product": {"type": "STRING"},
            "appearances": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
                "start": {"type": "STRING"}, "end": {"type": "STRING"},
                "channel": {"type": "STRING", "enum": ["visual", "audio", "text"]},
                "frame_time": {"type": "STRING"},
                "box_2d": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                "in_use": {"type": "BOOLEAN"},
            }, "required": ["start", "end", "channel"]}},
        }, "required": ["brand", "appearances"]}},
        "authenticity": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "brand": {"type": "STRING"}, "product": {"type": "STRING"},
            "use_shown": SUB, "balance": SUB, "specificity": SUB, "delivery": SUB,
            "body_language": SUB, "sales_pressure": SUB,
            "overall": {"type": "INTEGER"}, "verdict": {"type": "STRING"},
        }, "required": ["brand", "overall", "verdict", "use_shown", "balance", "specificity", "delivery", "body_language", "sales_pressure"]}},
        "disclosures": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "time": {"type": "STRING"}, "kind": {"type": "STRING"}, "text": {"type": "STRING"}}}},
    },
    "required": ["brands", "authenticity", "disclosures"],
}


def main():
    vid, lauf = sys.argv[1], sys.argv[2]
    try:
        res, info = frage([video_part(vid), {"text": PROMPT}], SCHEMA)
    except Exception as e:
        print(f"E {vid} Lauf {lauf}: FEHLER {e}")
        return
    for b in res["brands"]:
        for a in b["appearances"]:
            a["start_s"], a["end_s"] = sek(a["start"]), sek(a["end"])
            if a.get("frame_time"):
                a["frame_s"] = sek(a["frame_time"])
    out = ERG / f"E_{vid}_{lauf}_{info['model']}.json"
    out.write_text(json.dumps({"video": vid, "lauf": lauf, **info, "result": res}, ensure_ascii=False, indent=2))
    boxen = sum(1 for b in res["brands"] for a in b["appearances"] if a.get("box_2d"))
    print(f"E {vid} Lauf {lauf}: {info['model']} {info['seconds']}s, {len(res['brands'])} Marken, {boxen} Boxen, "
          f"{len(res['authenticity'])} Authenticity -> {out.name}")


if __name__ == "__main__":
    main()
