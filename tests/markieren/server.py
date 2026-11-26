"""
Marking page for the ground truth (test M). Local only.

    python3 tests/markieren/server.py      → http://localhost:8612/markieren/

Serves the folder tests/ read-only and accepts exactly one kind of write: POST /speichern/<video id> with the
ground-truth JSON, which is written to tests/wahrheit/<id>.json (the previous version is kept as <id>.vorher.json).
Listens on 127.0.0.1 only.
"""
import http.server, json, os, re, shutil, functools

TESTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WAHRHEIT = os.path.join(TESTS, "wahrheit")


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        m = re.fullmatch(r"/speichern/([A-Za-z0-9_-]{11})", self.path)
        if not m:
            return self.send_error(404)
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if body.get("video") != m.group(1) or not isinstance(body.get("labels"), dict):
            return self.send_error(400, "not a ground-truth file for this video")
        path = os.path.join(WAHRHEIT, m.group(1) + ".json")
        if os.path.exists(path):
            shutil.copy(path, os.path.join(WAHRHEIT, m.group(1) + ".vorher.json"))
        with open(path, "w") as f:
            json.dump(body, f, ensure_ascii=False, indent=1)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always the latest JSON
        super().end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print("Markier-Seite: http://localhost:8612/markieren/   (Strg+C beendet)")
    http.server.ThreadingHTTPServer(("127.0.0.1", 8612), functools.partial(Handler, directory=TESTS)).serve_forever()
