"""Einzeltest A: YouTube-URL direkt an Gemini -> JSON mit Marken, Zeitstempeln, Kennzeichnung.

Aufruf:  python test_a_youtube_url.py <video-id> [modell]
Ergebnis: ergebnisse/A_<video-id>_<modell>.json (Antwort + Laufzeit + Token)
"""
import json, sys, time, pathlib, subprocess
import requests

HIER = pathlib.Path(__file__).resolve().parent
ENV = HIER.parent.parent / "3.4_Gemini_Chat_App" / ".env"
API = "https://generativelanguage.googleapis.com/v1beta"
KEY = next(l.split("=", 1)[1].strip() for l in ENV.read_text().splitlines() if l.startswith("GEMINI_API_KEY="))

PROMPT = """You are a brand-placement analyst. Watch the whole video (image AND audio).
List every brand or branded product that is visible, shown as on-screen text, or mentioned in speech.
For each appearance give start/end as MM:SS timestamps. Rate prominence honestly.
Also report every advertising disclosure you notice (on-screen label like "Werbung", "Anzeige",
"paid promotion", "sponsored", or spoken disclosure) with its timestamp.
Answer with JSON only."""

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "brands": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "brand": {"type": "STRING"},
            "product": {"type": "STRING"},
            "category": {"type": "STRING"},
            "appearances": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
                "start": {"type": "STRING", "description": "MM:SS"}, "end": {"type": "STRING", "description": "MM:SS"},
                "channel": {"type": "STRING", "enum": ["visual", "audio", "text"]},
                "size": {"type": "STRING", "enum": ["small", "medium", "large"]},
                "position": {"type": "STRING", "enum": ["center", "edge"]},
                "in_use": {"type": "BOOLEAN"},
                "evidence": {"type": "STRING"},
            }, "required": ["start", "end", "channel"]}},
        }, "required": ["brand", "appearances"]}},
        "disclosures": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "time": {"type": "STRING", "description": "MM:SS"}, "kind": {"type": "STRING"}, "text": {"type": "STRING"},
        }}},
        "looks_like_paid_promotion": {"type": "BOOLEAN"},
        "reasoning": {"type": "STRING"},
    },
    "required": ["brands", "disclosures", "looks_like_paid_promotion"],
}


def sek(t):
    """'1:05' oder '01:02:03' -> Sekunden"""
    n = 0
    for teil in str(t).split(":"):
        n = n * 60 + float(teil or 0)
    return n


def meta(vid):
    ytdlp = HIER.parents[2] / "NewFrontierAI" / ".venv" / "bin" / "yt-dlp"
    out = subprocess.run([str(ytdlp), "--skip-download", "-J", f"https://www.youtube.com/watch?v={vid}"],
                         capture_output=True, text=True, timeout=90)
    try:
        j = json.loads(out.stdout)
        return {k: j.get(k) for k in ("title", "channel", "view_count", "duration", "upload_date", "description")}
    except Exception:
        return {"error": out.stderr[-300:]}


def main():
    vid = sys.argv[1]
    model = sys.argv[2] if len(sys.argv) > 2 else "gemini-3.8-flash"
    aufl = sys.argv[3] if len(sys.argv) > 3 else ""   # z. B. LOW -> MEDIA_RESOLUTION_LOW
    body = {
        "contents": [{"parts": [
            {"file_data": {"file_uri": f"https://www.youtube.com/watch?v={vid}"}},
            {"text": PROMPT},
        ]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": SCHEMA, "temperature": 0.2},
    }
    if aufl:
        body["generationConfig"]["mediaResolution"] = f"MEDIA_RESOLUTION_{aufl}"
    t0 = time.time()
    r = requests.post(f"{API}/models/{model}:generateContent", headers={"x-goog-api-key": KEY}, json=body, timeout=600)
    dt = round(time.time() - t0, 1)
    res = {"video": vid, "model": model, "seconds": dt, "http": r.status_code, "meta": meta(vid)}
    j = r.json()
    if r.ok:
        res["usage"] = j.get("usageMetadata")
        try:
            res["result"] = json.loads(j["candidates"][0]["content"]["parts"][0]["text"])
            for b in res["result"]["brands"]:
                for a in b["appearances"]:
                    a["start_s"], a["end_s"] = sek(a["start"]), sek(a["end"])
        except Exception as e:
            res["raw"] = j
    else:
        res["error"] = j.get("error", j)
    out = HIER / "ergebnisse" / f"A_{vid}_{model}_mmss{'_' + aufl if aufl else ''}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(res, ensure_ascii=False, indent=2))
    n = len(res.get("result", {}).get("brands", []))
    print(f"{vid} {model}: HTTP {r.status_code}, {dt}s, {n} Marken -> {out.name}")


if __name__ == "__main__":
    main()
