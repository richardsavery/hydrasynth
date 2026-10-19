#!/usr/bin/env python3
"""Test local rap HTTP routing with a fake service and temporary audio only."""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from hydra_dashboard import DashboardHTTPServer, SnapshotStore, handler_for
from elevenlabs_service import FileResponse


class RapHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.audio = Path(self.temp.name) / "rap.wav"
        self.audio.write_bytes(b"0123456789")
        self.calls = []
        owner = self

        class Service:
            def dispatch(self, method, path, payload=None):
                owner.calls.append((method, path, payload))
                if path.endswith("/audio"):
                    return 200, FileResponse(owner.audio, "audio/wav", None)
                if path.endswith("/broken"):
                    raise RuntimeError("provider-private-error-fixture")
                return 200, {"ok": True}

        self.server = DashboardHTTPServer(("127.0.0.1", 0), handler_for(SnapshotStore("demo"), rap=Service()))
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

    def test_local_dispatch_and_assets(self):
        payload = {"request_id": "rap-fixture", "text": "Words on the beat", "bpm": 120}
        headers = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}"}
        self.assertEqual(self.request("POST", "/api/rap/renders", json.dumps(payload), headers)[0], 200)
        self.assertEqual(self.calls[-1], ("POST", "/api/rap/renders", payload))
        for path in ("/api/rap/status", "/api/rap/renders/fixture"):
            self.assertEqual(self.request("GET", path)[0], 200)
        for path in ("/rap.js", "/rap.css"):
            status, asset_headers, body = self.request("GET", path)
            self.assertEqual(status, 200)
            self.assertTrue(body)
            self.assertNotIn("application/json", asset_headers["Content-Type"])
        for path in ("/.env", "/var/rap/jobs.sqlite", "/rap_service.py"):
            self.assertEqual(self.request("GET", path)[0], 404)
        before = len(self.calls)
        self.assertEqual(self.request("POST", "/api/elevenlabs/generations", "{}", headers)[0], 503)
        self.assertEqual(len(self.calls), before, "music endpoints cannot reach the rap service")

    def test_origin_host_and_request_validation(self):
        cases = [
            ({"Origin": "https://example.com", "Content-Type": "application/json"}, 403),
            ({"Host": f"attacker.example:{self.port}", "Content-Type": "application/json"}, 403),
            ({"Host": "127.0.0.1:1", "Content-Type": "application/json"}, 403),
            ({"Sec-Fetch-Site": "cross-site", "Content-Type": "application/json"}, 403),
            ({"Content-Type": "text/plain"}, 415),
            ({"Content-Type": "application/json", "Transfer-Encoding": "chunked"}, 415),
        ]
        for headers, expected in cases:
            self.assertEqual(self.request("POST", "/api/rap/renders", "{}", headers)[0], expected)
        for body in ("[]", "null", "broken"):
            self.assertEqual(self.request("POST", "/api/rap/renders", body, {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/api/rap/renders", "", {
            "Content-Type": "application/json", "Content-Length": str(128 * 1024 + 1)})[0], 413)
        self.assertEqual(self.request("GET", "/api/rap/renders/fixture/audio", headers={"Origin": "https://example.com"})[0], 403)
        self.assertEqual(self.calls, [], "invalid requests never reach a potentially billable service")

    def test_wav_head_ranges_and_unavailable_ranges(self):
        path = "/api/rap/renders/fixture/audio"
        status, headers, body = self.request("GET", path)
        self.assertEqual((status, body), (200, b"0123456789"))
        self.assertEqual(headers["Content-Type"], "audio/wav")
        self.assertEqual(headers["Cache-Control"], "no-store")
        for requested, expected, content_range in (
            ("bytes=2-5", b"2345", "bytes 2-5/10"),
            ("bytes=7-", b"789", "bytes 7-9/10"),
            ("bytes=-3", b"789", "bytes 7-9/10"),
        ):
            status, headers, body = self.request("GET", path, headers={"Range": requested})
            self.assertEqual((status, body), (206, expected))
            self.assertEqual(headers["Content-Range"], content_range)
            self.assertEqual(headers["Accept-Ranges"], "bytes")
        for invalid in ("bytes=90-", "bytes=5-2", "bytes=0-1,4-5", "bytes=-0", "bad"):
            status, headers, body = self.request("GET", path, headers={"Range": invalid})
            self.assertEqual(status, 416)
            self.assertEqual(headers["Content-Range"], "bytes */10")
        status, headers, body = self.request("HEAD", path)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Length"], "10")
        self.assertEqual(body, b"")
        self.assertEqual(self.calls[-1][0], "GET", "HEAD only reads the stored audio route")

    def test_service_exception_is_not_exposed(self):
        status, _, body = self.request("GET", "/api/rap/broken")
        self.assertEqual(status, 500)
        self.assertNotIn(b"provider-private-error", body)


if __name__ == "__main__":
    unittest.main()
