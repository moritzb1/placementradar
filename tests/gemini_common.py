"""Gemeinsame Helfer für die Einzeltests (Schlüssel, Aufruf mit Wiederholung + Ausweichmodell)."""
import json, time, pathlib
import requests

HIER = pathlib.Path(__file__).resolve().parent
ENV = HIER.parent / ".dev.vars"  # same file as for `wrangler dev` (never committed); or set GEMINI_API_KEY in the shell
import os
KEY = os.environ.get("GEMINI_API_KEY") or next(l.split("=", 1)[1].strip().strip('"') for l in ENV.read_text().splitlines() if l.startswith("GEMINI_API_KEY="))
import os
MODELLE = os.environ.get("MODELLE", "gemini-3.8-flash,gemini-3.7-flash").split(",")
ERG = HIER / "ergebnisse"
ERG.mkdir(exist_ok=True)


def sek(t):
    """'1:05' oder '01:02:03' -> Sekunden"""
    n = 0
    for teil in str(t).split(":"):
        n = n * 60 + float(teil or 0)
    return n


def mmss(s):
    s = int(round(s))
    return f"{s // 60:02d}:{s % 60:02d}"


def video_part(vid, start=None, end=None):
    part = {"file_data": {"file_uri": f"https://www.youtube.com/watch?v={vid}"}}
    if start is not None:
        part["video_metadata"] = {"start_offset": f"{int(start)}s", "end_offset": f"{int(end)}s"}
    return part


def frage(parts, schema, gen_extra=None, versuche=4):
    """Schickt eine Anfrage; bei 503/429 Ausweichmodell bzw. kurze Pause. Gibt (json, info) zurück."""
    cfg = {"responseMimeType": "application/json", "responseSchema": schema, "temperature": 0.2}
    cfg.update(gen_extra or {})
    body = {"contents": [{"parts": parts}], "generationConfig": cfg}
    t0 = time.time()
    letzte = None
    for v in range(versuche):
        for m in MODELLE:
            r = requests.post(f"{API}/models/{m}:generateContent", headers={"x-goog-api-key": KEY}, json=body, timeout=900)
            if r.ok:
                j = r.json()
                text = "".join(p.get("text", "") for p in j["candidates"][0]["content"]["parts"])
                return json.loads(text), {"model": m, "seconds": round(time.time() - t0, 1), "usage": j.get("usageMetadata"), "versuch": v + 1}
            letzte = (r.status_code, r.text[:300])
            if r.status_code not in (429, 500, 503):
                raise RuntimeError(f"{m}: HTTP {r.status_code} {r.text[:400]}")
        time.sleep(15)
    raise RuntimeError(f"aufgegeben nach {versuche} Runden: {letzte}")
