#!/usr/bin/env python3
"""Exercise local music routes, request isolation, and seekable audio over HTTP."""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from hydra_dashboard import DashboardHTTPServer, SnapshotStore, handler_for
from elevenlabs_service import FileResponse


class MusicHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.audio = Path(self.temp.name) / "test.mp3"
        self.audio.write_bytes(b"0123456789")
        self.calls = []
        owner = self

        class Service:
            def dispatch(self, method, path, payload=None):
                owner.calls.append((method, path, payload))
                if path.endswith("/audio"):
                    return 200, FileResponse(owner.audio, "audio/mpeg", None)
                return 200, {"ok": True}

        self.server = DashboardHTTPServer(("127.0.0.1", 0), handler_for(SnapshotStore("demo"), elevenlabs=Service()))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_same_origin_json_dispatch_and_static_assets(self):
        headers = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}"}
        status, _, _ = self.request("POST", "/api/elevenlabs/datasets", '{"synthetic":true}', headers)
        self.assertEqual(status, 200)
        self.assertEqual(self.calls[-1][2], {"synthetic": True})
        for path in ("/", "/elevenlabs.js", "/elevenlabs.css", "/api/snapshot"):
            self.assertEqual(self.request("GET", path)[0], 200, path)
        self.assertEqual(self.request("GET", "/.env")[0], 404)
        self.assertEqual(self.request("GET", "/var/elevenlabs/jobs.sqlite")[0], 404)

    def test_cross_origin_rebinding_and_non_json_rejected(self):
        cases = [
            ({"Origin": "https://example.com", "Content-Type": "application/json"}, 403),
            ({"Host": f"attacker.example:{self.port}", "Content-Type": "application/json"}, 403),
            ({"Host": "127.0.0.1:1", "Content-Type": "application/json"}, 403),
            ({"Sec-Fetch-Site": "cross-site", "Content-Type": "application/json"}, 403),
            ({"Content-Type": "text/plain"}, 415),
            ({"Content-Type": "application/json", "Transfer-Encoding": "chunked"}, 415),
        ]
        for headers, expected in cases:
            self.assertEqual(self.request("POST", "/api/elevenlabs/generations", "{}", headers)[0], expected)
        self.assertEqual(self.calls, [])

    def test_bad_json_and_size_limits(self):
        for body in ("[]", "null", "broken"):
            self.assertEqual(self.request("POST", "/api/elevenlabs/plans", body, {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/api/elevenlabs/datasets", "", {
            "Content-Type": "application/json", "Content-Length": str(13 * 1024 * 1024)})[0], 413)
        self.assertEqual(self.calls, [])

    def test_audio_ranges_and_head(self):
        path = "/api/elevenlabs/generations/test/audio"
        for range_header, expected in (("bytes=2-5", b"2345"), ("bytes=7-", b"789"), ("bytes=-3", b"789")):
            status, headers, body = self.request("GET", path, headers={"Range": range_header})
            self.assertEqual(status, 206)
            self.assertEqual(body, expected)
            self.assertEqual(headers["Accept-Ranges"], "bytes")
        for invalid in ("bytes=90-", "bytes=5-2", "bytes=0-1,4-5", "bytes=-0", "bad"):
            status, headers, body = self.request("GET", path, headers={"Range": invalid})
            self.assertEqual(status, 416)
            self.assertEqual(headers["Content-Range"], "bytes */10")
        status, headers, body = self.request("HEAD", path)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Length"], "10")
        self.assertEqual(body, b"")


if __name__ == "__main__":
    unittest.main()
