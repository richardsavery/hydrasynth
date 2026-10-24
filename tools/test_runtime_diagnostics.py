#!/usr/bin/env python3
"""Verify diagnostics remain bounded and cannot retain arbitrary user data."""

import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from hydra_dashboard import DashboardHTTPServer, SnapshotStore, handler_for
from runtime_diagnostics import RuntimeDiagnostics, MAX_CLIENTS, health_sample


CLIENT = "11111111-1111-4111-8111-111111111111"


class RuntimeDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.now = 0
        self.service = RuntimeDiagnostics(Path(self.directory.name), clock=lambda: self.now)
        self.addCleanup(self.service.close)

    def send(self, **fields):
        return self.service.dispatch("POST", "/api/runtime-diagnostics/sample", {"client_id": CLIENT, **fields})

    def test_payload_is_allowlisted_and_error_details_are_locations_only(self):
        sample = health_sample({"client_id": CLIENT, "raw_frames": [1, 2], "api_key": "never-save",
                                "dom_nodes": 150, "heap_used_bytes": float("nan"), "error_count": True,
                                "errors": [{"file": "app.js", "line": 100, "message": "never-save", "stack": "never-save"},
                                           {"file": "https://secret.example/key.js", "line": 1}]})
        self.assertNotIn("never-save", json.dumps(sample))
        self.assertNotIn("raw_frames", sample)
        self.assertNotIn("heap_used_bytes", sample)
        self.assertNotIn("error_count", sample)
        self.assertEqual(sample["errors"], [{"file": "app.js", "line": 100}])
        self.assertEqual(sample["dom_nodes"], 150)

    def test_missing_heartbeat_and_clean_pagehide_can_be_distinguished(self):
        self.send(sequence=1, visibility="visible")
        self.now = 25
        _, status = self.service.dispatch("GET", "/api/runtime-diagnostics/status")
        self.assertEqual(status["clients"][0]["last_seen_age_ms"], 25000)
        self.send(sequence=2, reason="pagehide")
        _, status = self.service.dispatch("GET", "/api/runtime-diagnostics/status")
        self.assertEqual(status["clients"][0]["reason"], "pagehide")
        self.assertEqual(status["clients"][0]["receive_gap_ms"], 25000)

    def test_repeated_samples_and_client_count_are_bounded(self):
        self.send(sequence=1)
        for _ in range(100):
            self.assertFalse(self.send(sequence=2)[1]["stored"])
        self.assertEqual(len(self.service.path.read_text().splitlines()), 1)
        for number in range(MAX_CLIENTS + 10):
            self.service.dispatch("POST", "/api/runtime-diagnostics/sample", {"client_id": f"{number:08x}-1111-4111-8111-111111111111"})
        self.assertEqual(len(self.service.clients), MAX_CLIENTS)

    def test_rotated_logs_cannot_grow_without_limit(self):
        self.service.close()
        with patch("runtime_diagnostics.MAX_LOG_BYTES", 1024):
            self.service = RuntimeDiagnostics(Path(self.directory.name), clock=lambda: self.now)
        self.addCleanup(self.service.close)
        for number in range(100):
            self.now += 5
            self.send(sequence=number, dom_nodes=123, heap_used_bytes=10000)
        files = list(Path(self.directory.name).iterdir())
        self.assertEqual(len(files), 2)
        self.assertTrue(all(file.stat().st_size <= 1024 for file in files))
        self.assertIn('"sequence":99', self.service.path.read_text())

    def test_unwritable_logging_does_not_prevent_health_status(self):
        file = Path(self.directory.name) / "ordinary-file"
        file.write_text("not a directory")
        service = RuntimeDiagnostics(file)
        self.addCleanup(service.close)
        self.assertEqual(service.dispatch("POST", "/api/runtime-diagnostics/sample", {"client_id": CLIENT})[0], 200)
        self.assertFalse(service.dispatch("GET", "/api/runtime-diagnostics/status")[1]["log_write_ok"])

    def test_midi_events_survive_renderer_loss_without_retaining_tokens(self):
        self.service.midi_status = lambda: {"armed": False, "last_reason": "heartbeat_timeout",
                                           "last_panic_ok": True, "generation": 3, "lease_id": "never-save"}
        for number in range(100):
            self.service.record_midi_event({"event": "panic", "reason": "heartbeat_timeout", "generation": number,
                                            "channel": 1, "panic_ok": True, "lease_id": "never-save", "device_name": "never-save"})
        _, status = self.service.dispatch("GET", "/api/runtime-diagnostics/status")
        self.assertEqual(len(status["midi_events"]), 24)
        self.assertEqual(status["midi_events"][-1]["generation"], 99)
        self.assertEqual(status["midi_safety"]["last_reason"], "heartbeat_timeout")
        self.assertNotIn("never-save", json.dumps(status))
        self.assertNotIn("never-save", self.service.path.read_text())

    def test_routes_inherit_local_origin_and_size_restrictions(self):
        server = DashboardHTTPServer(("127.0.0.1", 0), handler_for(SnapshotStore("demo"), runtime_diagnostics=self.service))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        connection = http.client.HTTPConnection(*server.server_address)
        self.addCleanup(connection.close)
        def request(payload, origin=None):
            headers = {"Content-Type": "application/json"}
            if origin:
                headers["Origin"] = origin
            connection.request("POST", "/api/runtime-diagnostics/sample", json.dumps(payload), headers)
            response = connection.getresponse()
            response.read()
            return response.status
        self.assertEqual(request({"client_id": CLIENT}, "https://example.com"), 403)
        self.assertEqual(request({"client_id": CLIENT, "extra": "x" * 2100}), 413)
        self.assertEqual(request({"client_id": CLIENT}), 200)


if __name__ == "__main__":
    unittest.main()
