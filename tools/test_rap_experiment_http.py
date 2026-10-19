#!/usr/bin/env python3
"""Exercise isolated experiment routing with local fixtures, never providers."""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from hydra_dashboard import DashboardHTTPServer, SnapshotStore, handler_for
from elevenlabs_service import FileResponse


class ExperimentHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.audio = Path(self.temp.name) / "fixture.wav"
        self.audio.write_bytes(b"0123456789")
        self.calls = []
        owner = self

        class Service:
            def dispatch(self, method, path, payload=None):
                owner.calls.append((method, path, payload))
                if "/audio/" in path:
                    return 200, FileResponse(owner.audio, "audio/wav")
                return 200, {"experiments": []}

        self.server = DashboardHTTPServer(("127.0.0.1", 0), handler_for(SnapshotStore("demo"), rap_experiment=Service()))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        client = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        client.request(method, path, body, headers or {})
        response = client.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        client.close()
        return result

    def test_separate_routes_and_static_assets(self):
        base = "/api/rap-experiment"
        payload = {"text": "Test these words", "bpm": 100, "request_id": "comparison-fixture"}
        self.assertEqual(self.request("POST", base + "/experiments", json.dumps(payload), {"Content-Type": "application/json"})[0], 200)
        self.assertEqual(self.calls[-1], ("POST", base + "/experiments", payload))
        for path in ("/status", "/voices", "/experiments", "/experiments/fixture", "/mixer-examples"):
            self.assertEqual(self.request("GET", base + path)[0], 200)
        before = len(self.calls)
        for path in ("/api/rap/renders", "/api/elevenlabs/generations"):
            self.assertEqual(self.request("POST", path, "{}", {"Content-Type": "application/json"})[0], 503)
        self.assertEqual(len(self.calls), before)
        for path in ("/rap-experiment.js", "/rap-experiment.css", "/music-mixer-voice.js", "/music-mixer-voice.css"):
            status, headers, body = self.request("GET", path)
            self.assertEqual(status, 200)
            self.assertTrue(body)
        for path in ("/.env", "/var/rap-experiment/experiments.sqlite3", "/rap_experiment_service.py"):
            self.assertEqual(self.request("GET", path)[0], 404)

    def test_audio_range_head_and_origin_boundary(self):
        path = "/api/rap-experiment/experiments/fixture/audio/baseline"
        self.assertEqual(self.request("GET", path, headers={"Range": "bytes=2-5"})[::2], (206, b"2345"))
        status, headers, body = self.request("HEAD", path)
        self.assertEqual((status, headers["Content-Length"], body), (200, "10", b""))
        before = len(self.calls)
        self.assertEqual(self.request("GET", path, headers={"Origin": "https://elsewhere.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/rap-experiment/experiments", "{}", {"Content-Type": "application/json", "Content-Length": str(128 * 1024 + 1)})[0], 413)
        self.assertEqual(len(self.calls), before)


if __name__ == "__main__":
    unittest.main()
