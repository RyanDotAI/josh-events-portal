#!/usr/bin/env python3
"""
Local mock server for testing events.html and event-detail.html.
Serves the HTML files and provides fake API responses.

Run: python3 test-server.py
Then open: http://localhost:8765/events.html?audience=Dealer

Registration test emails:
  anything@...          → SUCCESS (the normal path)
  full@test.com         → FULL (event at capacity)
  already@test.com      → ALREADY_REGISTERED
  closed@test.com       → CLOSED (deadline passed)
  error@test.com        → ERROR (system error)
"""

import json
import os
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

PORT = 8765
THIS_DIR = os.path.dirname(os.path.abspath(__file__))

# ── Mock data ──────────────────────────────────────────────────────────────

MOCK_EVENTS = [
    {
        "id": "1001",
        "name": "Dealer Certification Training — Denver",
        "type": "Training",
        "delivery": "In-Person",
        "start_display": "2026-08-12 at 09:00",
        "end_display": "2026-08-12 at 17:00",
        "location": "Josh.ai HQ",
        "city": "Denver",
        "state": "CO",
        "close_date": "2026-08-05",
        "description": (
            "Full-day hands-on certification course covering Josh.ai system design, "
            "commissioning, and advanced troubleshooting. Earn your dealer certification "
            "and unlock access to priority support. Lunch provided."
        ),
        "capacity": 20,
        "audience": "Dealer",
        "virtual_link": None,
        "is_closed": False,
    },
    {
        "id": "1002",
        "name": "Q3 Product Update Webinar",
        "type": "Webinar",
        "delivery": "Virtual",
        "start_display": "2026-07-22 at 11:00",
        "end_display": "2026-07-22 at 12:00",
        "location": None,
        "city": None,
        "state": None,
        "close_date": "2026-07-21",
        "description": (
            "Join the Josh.ai product team for a live walkthrough of Q3 feature releases, "
            "including the new voice model improvements and updated dealer dashboard. "
            "Q&A session follows the presentation."
        ),
        "capacity": None,
        "audience": "Dealer",
        "virtual_link": "https://zoom.us/j/mock-link-123",
        "is_closed": False,
    },
    {
        "id": "1003",
        "name": "CEU: Integrating Voice Control in Luxury Residential",
        "type": "CEU",
        "delivery": "Hybrid",
        "start_display": "2026-09-04 at 13:00",
        "end_display": "2026-09-04 at 15:00",
        "location": "Park City Convention Center",
        "city": "Park City",
        "state": "UT",
        "close_date": "2026-08-28",
        "description": (
            "2 CEU credit hours. Explore best practices for designing voice-first smart home "
            "systems in high-end residential projects. Available in-person and via live stream."
        ),
        "capacity": 50,
        "audience": "Dealer",
        "virtual_link": "https://zoom.us/j/mock-ceu-456",
        "is_closed": False,
    },
    {
        "id": "1004",
        "name": "Advanced Troubleshooting Workshop",
        "type": "Training",
        "delivery": "In-Person",
        "start_display": "2026-10-01 at 09:00",
        "end_display": "2026-10-01 at 17:00",
        "location": "Josh.ai HQ",
        "city": "Denver",
        "state": "CO",
        "close_date": "2026-09-24",
        "description": (
            "Hands-on deep dive for experienced installers. Topics include network edge cases, "
            "multi-zone audio debugging, and escalation paths. Limit 12 attendees."
        ),
        "capacity": 12,
        "audience": "Dealer",
        "virtual_link": None,
        "is_closed": False,
    },
]

MOCK_EVENT_MAP = {ev["id"]: ev for ev in MOCK_EVENTS}


# ── Server ─────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} — {fmt % args}")

    def do_OPTIONS(self):
        self._cors_headers(200)

    def do_GET(self):
        parsed = urlparse(self.path)
        path   = parsed.path.rstrip("/")
        qs     = parse_qs(parsed.query)

        # Serve HTML files — patch API_BASE to point at this server
        if path in ("/events.html", "/event-detail.html", "/", ""):
            filename = "events.html" if path in ("/", "") else path.lstrip("/")
            self._serve_html(filename)
            return

        # GET /api/events
        if path == "/api/events":
            audience = qs.get("audience", [None])[0]
            events = MOCK_EVENTS if not audience else [
                e for e in MOCK_EVENTS if e.get("audience") == audience
            ]
            # Return only fields needed for the list view
            self._json({"events": events})
            return

        # GET /api/events/<id>
        m = re.match(r"^/api/events/(\w+)$", path)
        if m:
            ev = MOCK_EVENT_MAP.get(m.group(1))
            if ev:
                self._json(ev)
            else:
                self._json({"error": "Not found"}, 404)
            return

        self._json({"error": "Not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path   = parsed.path.rstrip("/")

        if path == "/api/register":
            length = int(self.headers.get("Content-Length", 0))
            body   = json.loads(self.rfile.read(length)) if length else {}
            email  = (body.get("email") or "").lower().strip()

            # Drive different responses via test email addresses
            if email == "full@test.com":
                status = "FULL"
            elif email == "already@test.com":
                status = "ALREADY_REGISTERED"
            elif email == "closed@test.com":
                status = "CLOSED"
            elif email == "error@test.com":
                status = "ERROR"
            else:
                status = "SUCCESS"

            print(f"  REGISTER → event={body.get('event_id')} email={email} → {status}")
            self._json({"status": status})
            return

        self._json({"error": "Not found"}, 404)

    # ── Helpers ────────────────────────────────────────────────────────────

    def _serve_html(self, filename):
        filepath = os.path.join(THIS_DIR, filename)
        if not os.path.exists(filepath):
            self.send_error(404, f"File not found: {filename}")
            return
        with open(filepath, "r", encoding="utf-8") as f:
            html = f.read()
        # Patch the API_BASE so the page calls this local server
        html = html.replace(
            "const API_BASE = '/api';  // Netlify: '/api'. Front-end team: set to your full backend URL.",
            f"const API_BASE = 'http://localhost:{PORT}/api';  // patched by test-server"
        )
        # Also patch the back-link base URL for event-detail
        html = html.replace(
            "'/events'",
            f"'/events.html'"
        )
        html = html.replace(
            "window.location.origin + '/events/detail'",
            f"'http://localhost:{PORT}/event-detail.html'"
        )
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", len(data))
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj, code=200):
        data = json.dumps(obj).encode("utf-8")
        self._cors_headers(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(data))
        self.end_headers()
        self.wfile.write(data)

    def _cors_headers(self, code):
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")


if __name__ == "__main__":
    server = HTTPServer(("localhost", PORT), Handler)
    print(f"""
╔══════════════════════════════════════════════════════╗
║          Josh.ai Events — Local Test Server          ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  Event listing:                                      ║
║  http://localhost:{PORT}/events.html?audience=Dealer   ║
║                                                      ║
║  Event detail (pick any ID from the list):           ║
║  http://localhost:{PORT}/event-detail.html?event_id=1001 ║
║                                                      ║
║  Registration test emails:                           ║
║    any real email  →  SUCCESS (confirmation)         ║
║    full@test.com   →  FULL                           ║
║    already@test.com→  ALREADY REGISTERED             ║
║    closed@test.com →  CLOSED                         ║
║    error@test.com  →  ERROR                          ║
║                                                      ║
║  Press Ctrl+C to stop.                               ║
╚══════════════════════════════════════════════════════╝
""")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
