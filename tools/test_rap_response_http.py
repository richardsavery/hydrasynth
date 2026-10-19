#!/usr/bin/env python3
"""Exercise local rap-response HTTP boundaries without any provider requests."""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from elevenlabs_service import FileResponse
from hydra_dashboard import DashboardHTTPServer, SnapshotStore, handler_for


class RapResponseHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.audio = Path(self.temp.name) / "response.mp3"
        self.audio.write_bytes(b"0123456789")
        self.calls = []
        owner = self

        class Service:
            def dispatch(self, method, path, payload=None):
                owner.calls.append((method, path, payload))
                if path.endswith("/audio"):
                    return 200, FileResponse(owner.audio, "audio/mpeg")
                if path.endswith("/broken"):
                    raise RuntimeError("private-provider-key-fixture")
                return 200, {"responses": []}

        self.server = DashboardHTTPServer(
            ("127.0.0.1", 0),
            handler_for(SnapshotStore("demo"), rap_response=Service()),
        )
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
        try:
            connection.request(method, path, body, headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_response_routes_are_separate_and_assets_are_public(self):
        base = "/api/rap-response"
        headers = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}"}
        payload = {"request_id": "response-fixture", "text": "I missed the bus", "bpm": 96}
        for path, document in (("/responses", payload), ("/responses/fixture/cancel", {}), ("/responses/fixture/vocals", {})):
            with self.subTest(path=path):
                self.assertEqual(self.request("POST", base + path, json.dumps(document), headers)[0], 200)
                self.assertEqual(self.calls[-1], ("POST", base + path, document))
        for path in ("/status", "/responses", "/responses/fixture", "/requests/response-fixture"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", base + path)[0], 200)
                self.assertEqual(self.calls[-1], ("GET", base + path, None))

        before = len(self.calls)
        for path in ("/api/rap/renders", "/api/rap-experiment/experiments", "/api/elevenlabs/generations"):
            self.assertEqual(self.request("POST", path, "{}", headers)[0], 503)
        self.assertEqual(len(self.calls), before, "other generation routes never dispatch to rap response")
        for path in ("/rap-response.js", "/rap-response.css"):
            status, asset_headers, body = self.request("GET", path)
            self.assertEqual(status, 200)
            self.assertTrue(body)
            self.assertNotIn("application/json", asset_headers["Content-Type"])
        for path in ("/.env", "/var/rap-response/responses.sqlite3", "/rap_response_service.py", "/tools/rap_response_service.py"):
            self.assertEqual(self.request("GET", path)[0], 404)

    def test_invalid_origin_host_and_payloads_never_reach_the_service(self):
        cases = [
            ({"Origin": "https://elsewhere.example", "Content-Type": "application/json"}, 403),
            ({"Origin": "null", "Content-Type": "application/json"}, 403),
            ({"Host": f"attacker.example:{self.port}", "Content-Type": "application/json"}, 403),
            ({"Host": "127.0.0.1:1", "Content-Type": "application/json"}, 403),
            ({"Host": f"user@127.0.0.1:{self.port}", "Content-Type": "application/json"}, 403),
            ({"Sec-Fetch-Site": "cross-site", "Content-Type": "application/json"}, 403),
            ({"Content-Type": "text/plain"}, 415),
            ({"Content-Type": "application/json", "Transfer-Encoding": "chunked"}, 415),
        ]
        for headers, expected in cases:
            with self.subTest(headers=headers):
                self.assertEqual(self.request("POST", "/api/rap-response/responses", "{}", headers)[0], expected)
        for body in ("[]", "null", "broken", b"\xff"):
            self.assertEqual(self.request("POST", "/api/rap-response/responses", body, {"Content-Type": "application/json"})[0], 400)
        for length in ("0", "-1", "invalid", str(2 * 1024 * 1024 + 1)):
            self.assertEqual(self.request("POST", "/api/rap-response/responses", "", {
                "Content-Type": "application/json", "Content-Length": length,
            })[0], 413)
        for method in ("GET", "HEAD"):
            self.assertEqual(self.request(method, "/api/rap-response/responses/fixture/audio", headers={"Origin": "https://elsewhere.example"})[0], 403)
        self.assertEqual(self.calls, [], "rejected requests never reach a potentially billable service")

    def test_microphone_payload_accepts_the_response_limit(self):
        # A base64 recording must not inherit the legacy rap route's 128 KiB cap.
        body = json.dumps({"audio_base64": ""})
        body = json.dumps({"audio_base64": "A" * (2 * 1024 * 1024 - len(body))})
        self.assertEqual(len(body), 2 * 1024 * 1024)
        self.assertEqual(self.request("POST", "/api/rap-response/responses", body, {"Content-Type": "application/json"})[0], 200)
        self.assertEqual(self.calls[-1][2]["audio_base64"], json.loads(body)["audio_base64"])

    def test_missing_service_has_an_explicit_unavailable_response(self):
        self.server.RequestHandlerClass = handler_for(SnapshotStore("demo"))
        status, _, body = self.request("GET", "/api/rap-response/status")
        self.assertEqual(status, 503)
        self.assertIn("Rap response workspace unavailable", json.loads(body)["error"])
        self.assertEqual(self.calls, [])

    def test_non_loopback_clients_cannot_use_generation_routes(self):
        handler = self.server.RequestHandlerClass

        class NonLoopbackClient(handler):
            def setup(self):
                super().setup()
                self.client_address = ("192.0.2.1", self.client_address[1])

        # Model a remote peer while keeping all test traffic on the loopback socket.
        self.server.RequestHandlerClass = NonLoopbackClient
        self.assertEqual(self.request("POST", "/api/rap-response/responses", "{}", {"Content-Type": "application/json"})[0], 403)
        self.assertEqual(self.calls, [])

    def test_response_routes_are_disabled_on_a_non_loopback_server(self):
        original = self.server.server_address
        try:
            # The test socket stays loopback; only the reported server binding changes.
            self.server.server_address = ("0.0.0.0", self.port)
            for method, path, body, headers in (
                ("GET", "/api/rap-response/status", None, None),
                ("POST", "/api/rap-response/responses", "{}", {"Content-Type": "application/json"}),
            ):
                self.assertEqual(self.request(method, path, body, headers)[0], 403)
            self.assertEqual(self.calls, [])
        finally:
            self.server.server_address = original

    def test_audio_head_and_byte_ranges(self):
        path = "/api/rap-response/responses/fixture/audio"
        status, headers, body = self.request("GET", path)
        self.assertEqual((status, body), (200, b"0123456789"))
        self.assertEqual(headers["Content-Type"], "audio/mpeg")
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
            self.assertEqual((status, body), (416, b""))
            self.assertEqual(headers["Content-Range"], "bytes */10")
        status, headers, body = self.request("HEAD", path)
        self.assertEqual((status, headers["Content-Length"], body), (200, "10", b""))
        self.assertEqual(self.calls[-1][0], "GET", "HEAD only reads the stored response")
        status, headers, body = self.request("HEAD", path, headers={"Range": "bytes=2-5"})
        self.assertEqual((status, headers["Content-Length"], body), (206, "4", b""))

    def test_provider_exception_does_not_leak_secrets(self):
        status, _, body = self.request("GET", "/api/rap-response/broken")
        self.assertEqual(status, 500)
        self.assertNotIn(b"private-provider-key", body)
        self.assertIn(b"local service", body)

    def test_vocal_audio_supports_range_and_head_without_provider_work(self):
        path = "/api/rap-response/responses/fixture/vocals/audio"
        status, headers, body = self.request("GET", path, headers={"Range": "bytes=2-5"})
        self.assertEqual((status, body, headers["Content-Range"]), (206, b"2345", "bytes 2-5/10"))
        status, headers, body = self.request("HEAD", path)
        self.assertEqual((status, body, headers["Content-Length"]), (200, b"", "10"))
        self.assertEqual(self.calls[-1], ("GET", path, None))
        self.assertEqual(self.request("GET", path, headers={"Origin": "https://elsewhere.example"})[0], 403)


if __name__ == "__main__":
    unittest.main()
