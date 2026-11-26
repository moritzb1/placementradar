"""Test I (21.11.): Findet Gemini auch kleine Nebenprodukte (z. B. Smartwatch am Arm)?

Ausschnitt 1:30–1:45 des Kopfhörer-Videos 2CqNFIn1AEo (Bose-Kopfhörer im Etui, Hand mit Smartwatch).
Variante A: bisheriger Stil (Marken, Standardauflösung)
Variante B: Inventar-Prompt (auch getragene/nebensächliche Dinge, ohne lesbares Logo → Kategorie + Vermutung)
            + mediaResolution HIGH + 2 Bilder/s im Ausschnitt
Ergebnis: ergebnisse/I_kleine_produkte.json
"""
import json, time
from gemini_common import frage, ERG

VID, START, END = "2CqNFIn1AEo", 90, 105

SCHEMA = {"type": "OBJECT", "properties": {"items": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
    "time": {"type": "STRING"}, "category": {"type": "STRING"}, "brand": {"type": "STRING"}, "model": {"type": "STRING"},
    "basis": {"type": "STRING", "enum": ["logo", "text", "speech", "design", "unknown"]}, "confidence": {"type": "NUMBER"},
    "evidence": {"type": "STRING"}}, "required": ["category", "brand", "basis"]}}}, "required": ["items"]}

PROMPT_A = """List every brand or branded product visible or mentioned in this clip, with MM:SS time (time of the full video),
brand, model if known, basis (logo/text/speech/design) and confidence 0-1. JSON only."""

PROMPT_B = """Make a complete INVENTORY of every manufactured product that appears in this clip – not only the main topic.
Include things that are worn or used in passing: watches and smartwatches, jewellery, glasses, clothing, phones, cases, cups, furniture.
For each: MM:SS time (time of the full video), category, brand and model if you can identify them (from a logo, on-screen text,
speech or a distinctive design), basis, confidence 0-1 and a short visual description as evidence.
If the brand cannot be identified, set brand to "unknown" and still list the item with its category. JSON only."""


def part(fps=None):
    meta = {"start_offset": f"{START}s", "end_offset": f"{END}s"}
    if fps:
        meta["fps"] = fps
    return {"file_data": {"file_uri": f"https://www.youtube.com/watch?v={VID}"}, "video_metadata": meta}


out = {}
for name, parts, extra in [
    ("A_standard", [part(), {"text": PROMPT_A}], {}),
    ("B_inventar_hoch", [part(fps=2), {"text": PROMPT_B}], {"mediaResolution": "MEDIA_RESOLUTION_HIGH"}),
]:
    t0 = time.time()
    try:
        res, info = frage(parts, SCHEMA, extra)
        out[name] = {"info": info, "items": res["items"]}
        print(f"\n== {name}: {info['model']} {info['seconds']} s, Video-Token {[x['tokenCount'] for x in (info['usage'] or {}).get('promptTokensDetails', []) if x['modality']=='VIDEO']}")
        for it in res["items"]:
            print(f"  {it.get('time','?'):6s} {it['category'][:22]:22s} {it['brand'][:18]:18s} {it.get('model','')[:26]:26s} {it['basis']:7s} {it.get('confidence','')}  | {it.get('evidence','')[:70]}")
    except Exception as e:
        out[name] = {"error": str(e)[:300]}; print(name, "FEHLER", str(e)[:300])
(ERG / "I_kleine_produkte.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
