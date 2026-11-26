"""Einzeltest B2: schneller durch (a) Abschnitte parallel, (b) wenig Denkaufwand?

Aufruf:  python test_b2_abschnitte.py <video-id> <dauer_s> <variante>
  variante = segmente   -> 4 Abschnitte gleichzeitig, normales Denken
  variante = wenigdenken -> ganzes Video, thinkingLevel LOW
Ergebnis: ergebnisse/B2_<video-id>_<variante>.json
"""
import json, os, sys, time
from concurrent.futures import ThreadPoolExecutor
from gemini_common import frage, video_part, sek, ERG
from test_a_youtube_url import SCHEMA, PROMPT


def lauf(vid, start=None, end=None, extra=None):
    text = PROMPT
    if start is not None:
        text += f"\nOnly this clip of the video is provided ({start:.0f}s to {end:.0f}s). Give all timestamps as MM:SS of the FULL video."
    res, info = frage([video_part(vid, start, end), {"text": text}], SCHEMA, extra)
    for b in res["brands"]:
        for a in b["appearances"]:
            a["start_s"], a["end_s"] = sek(a["start"]), sek(a["end"])
    return res, info


def main():
    vid, dauer, variante = sys.argv[1], float(sys.argv[2]), sys.argv[3]
    t0 = time.time()
    if variante == "segmente":
        n = 4
        grenzen = [(dauer * i / n, dauer * (i + 1) / n) for i in range(n)]
        with ThreadPoolExecutor(n) as ex:
            teile = list(ex.map(lambda g: lauf(vid, *g), grenzen))
        out = {"segmente": [{"von": g[0], "bis": g[1], "info": t[1], "result": t[0]} for g, t in zip(grenzen, teile)]}
        # Liegen die Zeitstempel im jeweiligen Abschnitt (= absolut) oder ab 0 (= relativ)?
        for s in out["segmente"]:
            zeiten = [a["start_s"] for b in s["result"]["brands"] for a in b["appearances"]]
            s["zeiten_min_max"] = [min(zeiten), max(zeiten)] if zeiten else None
        marken = {b["brand"].lower() for s in out["segmente"] for b in s["result"]["brands"]}
    else:
        try:
            res, info = lauf(vid, extra={"thinkingConfig": {"thinkingLevel": "LOW"}})
        except RuntimeError as e:
            if "400" not in str(e):
                raise
            res, info = lauf(vid, extra={"thinkingConfig": {"thinkingBudget": 0}})
            info["hinweis"] = "thinkingLevel abgelehnt, thinkingBudget 0 genutzt"
        out = {"info": info, "result": res}
        marken = {b["brand"].lower() for b in res["brands"]}
    out["gesamt_s"] = round(time.time() - t0, 1)
    out["marken"] = sorted(marken)
    (ERG / f"B2_{vid}_{variante}_{os.environ.get('MODELLE','std')}.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"B2 {vid} {variante}: {out['gesamt_s']}s gesamt, {len(marken)} Marken")


if __name__ == "__main__":
    main()
