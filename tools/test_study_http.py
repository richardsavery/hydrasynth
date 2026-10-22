#!/usr/bin/env python3
"""Study recording through the dashboard's real loopback HTTP boundary."""
import http.client
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid
import zipfile

from hydra_dashboard import DashboardHTTPServer, SnapshotStore, default_study_directory, handler_for
from study_recording import StudyRecorder


class StudyHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.study = StudyRecorder(Path(self.temp.name), app_version="study-test")
        self.session_id = str(uuid.uuid4())
        self.client_id = str(uuid.uuid4())
        self.calls = []
        calls = self.calls

        class Service:
            def dispatch(self, method, path, document):
                calls.append((method, path, document))
                if isinstance(document, bytes):
                    return 201, {"id": "b" * 32, "state": "complete", "origin": "uploaded", "name": "My recording"}
                return 200, {"id": "a" * 32, "state": "queued", "request_id": document.get("request_id")}

        self.server = DashboardHTTPServer(("127.0.0.1", 0),
            handler_for(SnapshotStore("demo"), study=self.study, rap_response=Service(), elevenlabs=Service()))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.study.close()
        self.temp.cleanup()

    def request(self, method, path, document=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            outgoing = {"Origin": f"http://127.0.0.1:{self.port}", "X-Study-Session": self.session_id}
            if document is not None:
                outgoing["Content-Type"] = "application/octet-stream" if isinstance(document, bytes) else "application/json"
            outgoing.update(headers or {})
            body = document if isinstance(document, bytes) else json.dumps(document) if document is not None else None
            connection.request(method, path, body, outgoing)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def event(self):
        return {"event_id": str(uuid.uuid4()), "session_id": self.session_id,
                "client_id": self.client_id, "sequence": 1,
                "occurred_at": "2026-10-19T05:00:00.000Z", "elapsed_ms": 123.5,
                "type": "ui.change", "payload": {"control": "tempo", "value": 105}}

    def test_events_and_generation_outcomes_export_together(self):
        status, _, body = self.request("POST", "/api/study/sessions",
                                      {"session_id": self.session_id, "participant_code": "P003"})
        self.assertLess(status, 300, body)
        event = self.event()
        for _ in range(2):
            status, _, body = self.request("POST", "/api/study/events", {"events": [event]})
            self.assertLess(status, 300, body)
        self.assertEqual(self.request("POST", "/api/rap-response/responses",
            {"request_id": "test-request", "text": "Play a brighter sound"})[0], 200)
        status, headers, body = self.request("GET", "/api/study/export")
        self.assertEqual(status, 200, body[:200])
        self.assertIn("zip", headers["Content-Type"])
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            events = [json.loads(line) for line in archive.read("events.jsonl").splitlines()]
            self.assertEqual(sum(e["event_id"] == event["event_id"] for e in events), 1)
            serialized = json.dumps(events)
            self.assertIn("Play a brighter sound", serialized)
            self.assertIn(self.session_id, serialized)
            self.assertIn("P003", archive.read("sessions.csv").decode())

    def test_bad_origins_cannot_read_or_modify_study_data(self):
        for path in ("/api/study/status", "/api/study/export"):
            self.assertEqual(self.request("GET", path, headers={"Origin": "https://external.example"})[0], 403)
        for headers in ({"Origin": "null"}, {"Host": f"untrusted.example:{self.port}"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request("POST", "/api/study/events", {"events": [self.event()]}, headers)[0], 403)
        self.assertEqual(self.request("GET", "/study-recorder.js")[0], 200)
        self.assertEqual(self.request("GET", "/study-recorder.css")[0], 200)
        self.assertEqual(self.request("GET", "/events.sqlite3")[0], 404)

    def test_custom_audio_upload_records_participant_origin_and_metadata_without_raw_bytes(self):
        audio = b"RIFF\x00\xffprivate-audio-bytes-that-must-not-be-logged"
        route = "/api/elevenlabs/uploads?filename=recording.wav&request_id=" + "b" * 32
        status, _, body = self.request("POST", route, audio)
        self.assertEqual(status, 201, body)
        self.assertEqual(self.calls[-1], ("POST", route, audio))
        status, _, body = self.request("GET", "/api/study/export")
        self.assertEqual(status, 200)
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            raw_events = archive.read("events.jsonl")
            self.assertNotIn(b"private-audio-bytes", raw_events)
            events = [json.loads(line) for line in raw_events.splitlines()]
            observed = next(event for event in events if event["type"] == "service.request_completed"
                            and event["payload"].get("path") == "/api/elevenlabs/uploads")
            self.assertEqual(observed["payload"]["request"], {"size_bytes": len(audio)})
            self.assertEqual(observed["session_id"], self.session_id)
            updates = [event for event in events if event["type"] == "generation.updated"]
            self.assertEqual({event["session_id"] for event in updates}, {self.session_id})
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["job_origins"], [{"namespace": "elevenlabs", "job_id": "b" * 32,
                                                      "origin_session_id": self.session_id}])

    def test_malformed_events_do_not_reach_generation_or_report_success(self):
        self.assertEqual(self.request("POST", "/api/study/events", {"events": [{"type": "ui.change"}]})[0], 400)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.request("POST", "/api/study/events", {"events": []}, {"Content-Type": "text/plain"})[0], 415)

    def test_default_path_is_independent_of_checkout_and_respects_override(self):
        with patch.dict(os.environ, {"KEIRZO_STUDY_DIR": "/private/tmp/study-fixture"}):
            self.assertEqual(default_study_directory(), Path("/private/tmp/study-fixture"))
        with patch.dict(os.environ, {}, clear=True):
            self.assertNotIn("OneDrive", str(default_study_directory()))


if __name__ == "__main__":
    unittest.main()
