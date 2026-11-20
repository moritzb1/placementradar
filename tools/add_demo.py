"""add_demo.py — turn a finished analysis into a permanent example video in the repository.

Why: examples in public/data/ are served as static files, cost no API quota and keep working weeks
after the presentation (the professor opens the link later). The Worker also treats them as cache hits.

Input: either the analysis JSON (as stored by the Worker) or the raw Server-Sent-Events stream of
POST /api/analyze (the last `event: result` is used).

    python3 tools/add_demo.py <file.json | file.sse> [--first] [--note "why this example"]

Writes public/data/<id>.json (without the transport-only field `cached`) and adds or updates the entry
in public/data/index.json. --first puts the video at the top of the example list.
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "public" / "data"


def load(path: pathlib.Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if path.suffix != ".sse":
        return json.loads(text)
    result = None
    for chunk in text.split("\n\n"):
        lines = chunk.strip().splitlines()
        if lines and lines[0] == "event: result":
            result = json.loads("".join(l[6:] for l in lines[1:] if l.startswith("data: ")))
        if lines and lines[0] == "event: error":
            print("stream contains an error:", lines[1:], file=sys.stderr)
    if result is None:
        sys.exit(f"no result event in {path}")
    return result


def main() -> None:
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    first = "--first" in args
    note = args[args.index("--note") + 1] if "--note" in args else None
    d = load(pathlib.Path(args[0]))
    d.pop("cached", None)
    if note:
        d.setdefault("source", {})["note"] = note
    v = d["video"]
    (DATA / f"{v['id']}.json").write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")

    index = json.loads((DATA / "index.json").read_text(encoding="utf-8"))
    index = [e for e in index if e["id"] != v["id"]]
    entry = {"id": v["id"], "title": v.get("title"), "channel": v.get("channel"), "views": v.get("views"),
             "duration_s": v.get("duration_s"), "brands": len(d.get("brands", []))}
    index.insert(0, entry) if first else index.append(entry)
    (DATA / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"added {v['id']}: {entry['brands']} brands, {len(index)} examples in total")


if __name__ == "__main__":
    main()
