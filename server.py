#!/usr/bin/env python3
"""Mini HTTP server for Grab Menu Checker.

Serves the extension/ folder as static files, plus two JSON endpoints:
  POST /api/sync   - Extension pushes its chrome.storage state (merchants, events).
  GET  /api/data   - Local dashboard polls for the latest snapshot.

Run: python3 server.py
"""

import http.server
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXT_DIR = ROOT / "extension"
DATA_FILE = ROOT / "server-data.json"
PORT = 8765


def read_data():
    if not DATA_FILE.exists():
        return {"merchants": {}, "events": [], "syncedAt": None}
    try:
        return json.loads(DATA_FILE.read_text())
    except Exception:
        return {"merchants": {}, "events": [], "syncedAt": None}


def write_data(data: dict):
    DATA_FILE.write_text(json.dumps(data))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(EXT_DIR), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/data":
            data = read_data()
            body = json.dumps(data).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # Default to root → dashboard.html for convenience
        if self.path == "/" or self.path == "":
            self.send_response(302)
            self.send_header("Location", "/dashboard.html")
            self.end_headers()
            return
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/sync":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("payload must be object")
            if "merchants" not in payload:
                raise ValueError("missing 'merchants'")

            # MERGE with existing data — don't replace.
            # Multiple Chrome instances each push their own subset; server keeps the union.
            existing = read_data()
            merchants = dict(existing.get("merchants") or {})
            for mid, mdata in (payload.get("merchants") or {}).items():
                merchants[mid] = mdata

            events = list(existing.get("events") or [])
            new_events = payload.get("events") or []
            # Dedupe by (ts + menuId + type)
            seen = {(e.get("ts"), e.get("menuId"), e.get("type")) for e in events}
            for e in new_events:
                key = (e.get("ts"), e.get("menuId"), e.get("type"))
                if key not in seen:
                    events.append(e)
                    seen.add(key)
            # Cap log size
            if len(events) > 2000:
                events = events[-2000:]

            merged = {
                "merchants": merchants,
                "events": events,
                "syncedAt": self.log_date_time_string(),
            }
            write_data(merged)

            body = json.dumps({
                "ok": True,
                "merchants": len(merchants),
                "events": len(events),
                "added_branches": list((payload.get("merchants") or {}).keys()),
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            body = json.dumps({"ok": False, "error": str(e)}).encode("utf-8")
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


def main():
    print(f"Serving extension/ at http://localhost:{PORT}")
    print(f"Dashboard: http://localhost:{PORT}/dashboard.html")
    print(f"Data file: {DATA_FILE}")
    http.server.HTTPServer(("localhost", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
