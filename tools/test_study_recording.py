#!/usr/bin/env python3
"""Offline durability, study export and multi-laptop merge checks."""
import base64
import copy
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest import mock
import uuid
import wave
import zipfile

from study_recording import FileResponse, StudyRecorder, canonical
from study_merge import merge_exports


def wav():
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\x00\x01" * 3200)
    return output.getvalue()


class StudyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.assets = self.root / "rap-response"
        self.assets.mkdir()
        self.service = StudyRecorder(self.root / "study", app_version="test-v1", asset_roots={"rap-response": self.assets})
        self.session = str(uuid.uuid4())
        self.client = str(uuid.uuid4())

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    def event(self, **changes):
        return {"event_id": str(uuid.uuid4()), "session_id": self.session, "client_id": self.client,
                "sequence": 1, "occurred_at": "2026-10-19T01:00:00Z", "elapsed_ms": 123.5,
                "type": "ui.change", "payload": {"workspace": "synth", "control": "tempo", "value": 120}, **changes}

    def post(self, path, body):
        return self.service.dispatch("POST", "/api/study/" + path, body)

    def export_events(self, path=None):
        with zipfile.ZipFile(path or self.service.export().path) as archive:
            return [json.loads(line) for line in archive.read("events.jsonl").splitlines()]

    def media(self, data=None, **changes):
        return {"media_id": str(uuid.uuid4()), "session_id": self.session,
                "audio_base64": base64.b64encode(data if data is not None else wav()).decode(),
                "metadata": {"mime_type": "audio/wav", "kind": "microphone"}, **changes}

    def test_durable_event_ack_deduplicates_and_survives_reopen(self):
        event = self.event()
        code, result = self.post("events", {"events": [event]})
        self.assertEqual(code, 200)
        self.assertEqual(result["acknowledged_event_ids"], [event["event_id"]])
        self.assertEqual(self.post("events", {"events": [event]})[0], 200)
        device = self.service.device_id
        self.service.close()
        self.service = StudyRecorder(self.root / "study", app_version="test-v2")
        self.assertEqual(self.service.device_id, device)
        events = self.export_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["app_version"], "test-v1")
        self.assertEqual(events[0]["payload"]["value"], 120)

    def test_conflicting_batch_rolls_back_every_event(self):
        event = self.event()
        self.post("events", {"events": [event]})
        changed = {**event, "payload": {"value": 99}}
        status, _ = self.post("events", {"events": [self.event(sequence=2), changed]})
        self.assertEqual(status, 409)
        self.assertEqual(len(self.export_events()), 1)

    def test_session_idempotence_and_participant_conflict(self):
        request = {"session_id": self.session, "participant_code": "P-17"}
        self.assertEqual(self.post("sessions", request)[0], 200)
        self.assertEqual(self.post("sessions", request)[0], 200)
        self.assertEqual(self.post("sessions", {**request, "participant_code": "P-18"})[0], 409)

    def test_input_validation_and_secret_redaction(self):
        for change in ({"event_id": "../escape"}, {"session_id": "../escape"}, {"sequence": True},
                       {"occurred_at": "2026-10-19T01:00:00"}, {"elapsed_ms": float("nan")},
                       {"payload": {"value": float("inf")}}, {"extra": "unsupported"}):
            self.assertEqual(self.post("events", {"events": [self.event(**change)]})[0], 400)
        payload = {"text": "participant words", "ELEVENLABS_API_KEY": "hidden", "nested": {"password": "hidden", "token": "musical-token"}, "audio_base64": "hidden"}
        self.post("events", {"events": [self.event(payload=payload)]})
        stored = self.export_events()[0]["payload"]
        self.assertEqual(stored, {"text": "participant words", "nested": {"token": "musical-token"}})

    def test_media_round_trip_and_conflicting_retry(self):
        request = self.media()
        status, body = self.post("media", request)
        self.assertEqual(status, 200)
        self.assertEqual(body["acknowledged_media_id"], request["media_id"])
        self.assertEqual(self.post("media", request)[0], 200)
        changed = copy.deepcopy(request)
        changed["metadata"]["kind"] = "different"
        self.assertEqual(self.post("media", changed)[0], 409)
        with zipfile.ZipFile(self.service.export().path) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            item = manifest["media"][0]
            self.assertEqual(archive.read(item["path"]), wav())
            self.assertAlmostEqual(item["duration_seconds"], .2)
            self.assertEqual(item["sha256"], hashlib.sha256(wav()).hexdigest())

    def test_invalid_recordings_and_paths_are_rejected(self):
        for request in (self.media(b"not audio"), self.media(wav()[:-100]), self.media(media_id="../escape"),
                        self.media(metadata={"mime_type": "application/octet-stream"}),
                        self.media(audio_base64="not!base64")):
            self.assertEqual(self.post("media", request)[0], 400)

    def test_original_microphone_containers_and_mime_parameters(self):
        values = [(b"\x1aE\xdf\xa3\x00webm\x00payload", "audio/webm;codecs=opus", ".webm"),
                  (b"OggS\x00OpusHead\x00payload", "audio/ogg;codecs=opus", ".ogg"),
                  (b"\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00isom\x00\x00\x00\x08moov", "audio/mp4", ".m4a")]
        for data, mime, suffix in values:
            request = self.media(data, metadata={"mime_type": mime, "cancelled": True})
            self.assertEqual(self.post("media", request)[0], 200)
            self.assertEqual((self.service.root / "media" / (request["media_id"] + suffix)).read_bytes(), data)

    def test_incomplete_original_is_preserved_but_submitted_wav_is_rejected(self):
        data = wav()[:-100]
        request = self.media(data, metadata={"role": "microphone_original", "mime_type": "audio/wav", "outcome": "cancelled"})
        self.assertEqual(self.post("media", request)[0], 200)
        with zipfile.ZipFile(self.service.export().path) as archive:
            item = json.loads(archive.read("manifest.json"))["media"][0]
            self.assertEqual(item["content_type"], "application/octet-stream")
            self.assertFalse(item["playable"])
            self.assertIn("invalid", item["validation_error"])
            self.assertEqual(archive.read(item["path"]), data)
        self.assertEqual(self.post("media", self.media(data, metadata={"role": "microphone_submitted", "mime_type": "audio/wav"}))[0], 400)
        self.assertEqual(self.post("media", self.media(data, metadata={"role": "microphone_original", "mime_type": "application/octet-stream"}))[0], 400)

    def test_backend_hook_is_nonblocking_and_export_flushes_it(self):
        entered, release = threading.Event(), threading.Event()
        original = self.service._insert_events
        def delayed(events):
            entered.set()
            release.wait(5)
            return original(events)
        with mock.patch.object(self.service, "_insert_events", side_effect=delayed):
            started = time.monotonic()
            self.service.record("robot.command_completed", {"motor": 1})
            self.assertLess(time.monotonic() - started, .2)
            self.assertTrue(entered.wait(2))
            release.set()
            self.service.flush()
        events = self.export_events()
        self.assertEqual(len(events), 1)
        self.assertIsNone(events[0]["session_id"])
        self.assertIsNotNone(events[0]["elapsed_ms"])

    def test_failed_write_is_visible_and_retried_before_export(self):
        with mock.patch.object(self.service, "_insert_events", side_effect=sqlite3.OperationalError("disk full")):
            self.service.record("test.outcome", {"ok": True})
            self.service._queue.join()
            self.assertTrue(self.service.last_error)
            self.assertEqual(len(self.service._pending_failures), 1)
        events = self.export_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "test.outcome")
        self.assertIsNone(self.service.last_error)

    def test_incomplete_health_survives_reopen_and_unclean_shutdown_is_flagged(self):
        self.service.record("bad event type", {})
        self.assertEqual(self.service.failed_event_count, 1)
        self.service.close()
        self.service = StudyRecorder(self.root / "study")
        self.assertEqual(self.service.failed_event_count, 1)
        self.assertTrue(self.service.status()["incomplete"])
        self.assertTrue(self.service.last_error)
        self.service.close()
        with sqlite3.connect(self.root / "study" / "events.sqlite3") as db:
            db.execute("UPDATE metadata SET value='0' WHERE key='clean_shutdown'")
        self.service = StudyRecorder(self.root / "study")
        self.assertIn("did not close cleanly", self.service.last_error)

    def test_generation_assets_context_and_completed_job_snapshot(self):
        job_id = uuid.uuid4().hex
        job = {"id": job_id, "state": "queued", "transcript": "Tell me something", "api_key": "hidden"}
        self.service.observe_http("POST", "/api/rap-response/responses", {"text": "Tell me something"}, 202, job, self.session)
        directory = self.assets / job_id
        directory.mkdir()
        (directory / "input.wav").write_bytes(wav())
        (directory / "response.wav").write_bytes(wav())
        (directory / "vocal.wav").write_bytes(wav())
        (directory / "private.txt").write_text("excluded")
        outside = self.root / "outside.wav"
        outside.write_bytes(wav())
        (directory / "escape.wav").symlink_to(outside)
        completed = {**job, "state": "complete", "lyrics": "A rhyming reply"}
        with sqlite3.connect(self.assets / "responses.sqlite3") as db:
            db.execute("CREATE TABLE responses(id TEXT PRIMARY KEY,body TEXT)")
            db.execute("INSERT INTO responses VALUES (?,?)", (job_id, canonical(completed)))
        self.service.record_job("rap-response", completed)
        export = self.service.export().path
        events = self.export_events(export)
        self.assertTrue(all(event["session_id"] == self.session for event in events))
        with zipfile.ZipFile(export) as archive:
            prefix = "assets/rap-response/" + job_id + "/"
            for filename in ("input.wav", "response.wav", "vocal.wav"):
                self.assertEqual(archive.read(prefix + filename), wav())
            self.assertNotIn(prefix + "escape.wav", archive.namelist())
            self.assertNotIn(prefix + "private.txt", archive.namelist())
            snapshot = json.loads(archive.read(prefix + "job.json"))
            self.assertEqual(snapshot["lyrics"], "A rhyming reply")
            self.assertNotIn("api_key", snapshot)

    def test_job_origin_survives_another_participant_view_download_and_reopen(self):
        other_session = str(uuid.uuid4())
        job_id = uuid.uuid4().hex
        job = {"id": job_id, "state": "queued", "transcript": "Participant A"}
        self.service.observe_http("POST", "/api/rap-response/responses", {"text": "Participant A"}, 202, job, self.session)
        self.service.flush()
        self.service.observe_http("GET", "/api/rap-response/responses/" + job_id, None, 200, job, other_session)
        self.service.observe_http("GET", "/api/rap-response/responses/" + job_id + "/audio", None, 200,
                                  FileResponse(self.assets / "not-opened.wav", "audio/wav"), other_session)
        completed = {**job, "state": "complete", "lyrics": "Reply to A"}
        self.service.record_job("rap-response", completed)
        self.service.flush()
        self.service.close()
        self.service = StudyRecorder(self.root / "study", asset_roots={"rap-response": self.assets})
        self.service.record_job("rap-response", {**completed, "state": "isolating"})
        events = self.export_events()
        updates = [event for event in events if event["type"] == "generation.updated"]
        self.assertEqual({event["session_id"] for event in updates}, {self.session})
        download = next(event for event in events if event["type"] == "service.file_requested")
        self.assertEqual(download["session_id"], other_session)
        with zipfile.ZipFile(self.service.export().path) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["job_origins"], [{"namespace": "rap-response", "job_id": job_id, "origin_session_id": self.session}])
            self.assertIn(other_session, {ref["session_id"] for ref in manifest["asset_refs"]})

    def test_legacy_job_view_and_mutation_do_not_invent_an_origin(self):
        job_id = uuid.uuid4().hex
        job = {"id": job_id, "state": "complete"}
        self.service.observe_http("GET", "/api/rap-response/responses/" + job_id, None, 200, job, self.session)
        self.service.observe_http("POST", "/api/rap-response/responses/" + job_id + "/vocals", {}, 202,
                                  {**job, "state": "isolating"}, self.session)
        self.service.flush()
        self.service.close()
        self.service = StudyRecorder(self.root / "study")
        self.service.record_job("rap-response", {**job, "vocal_state": "complete"})
        events = self.export_events()
        self.assertTrue(all(event["session_id"] is None for event in events if event["type"] == "generation.updated"))
        self.assertEqual(self.service._job_sessions, {})

    def test_custom_audio_upload_origin_survives_retry_and_later_separation_after_reopen(self):
        job_id = uuid.uuid4().hex
        other_session = str(uuid.uuid4())
        job = {"id": job_id, "origin": "uploaded", "name": "Participant recording", "state": "complete"}
        route = "/api/elevenlabs/uploads?filename=recording.wav&request_id=" + job_id
        self.service.observe_http("POST", route, {"size_bytes": len(wav())}, 201, job, self.session)
        self.service.observe_http("POST", route, {"size_bytes": len(wav())}, 201, {**job, "reused": True}, other_session)
        self.service.flush()
        self.service.close()
        self.service = StudyRecorder(self.root / "study")
        self.service.record_job("elevenlabs", {**job, "stem_separation": {"state": "complete"}})
        events = self.export_events()
        updates = [event for event in events if event["type"] == "generation.updated"]
        self.assertTrue(updates)
        self.assertEqual({event["session_id"] for event in updates}, {self.session})
        self.assertEqual(updates[-1]["payload"]["job"]["stem_separation"]["state"], "complete")
        requests = [event for event in events if event["type"] == "service.request_completed"]
        self.assertEqual({event["session_id"] for event in requests}, {self.session, other_session})
        with zipfile.ZipFile(self.service.export().path) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["job_origins"], [{"namespace": "elevenlabs", "job_id": job_id, "origin_session_id": self.session}])

    def test_effects_version_retains_its_own_participant_and_source(self):
        parent_id, child_id = uuid.uuid4().hex, uuid.uuid4().hex
        other_session = str(uuid.uuid4())
        parent = {"id": parent_id, "state": "complete", "voice": "eva"}
        self.service.observe_http("POST", "/api/rap-response/responses", {}, 202, parent, self.session)
        child = {**parent, "id": child_id, "state": "rendering", "source_response_id": parent_id,
                 "effects": {"pitch_semitones": 3, "autotune_amount": 0.8}}
        route = f"/api/rap-response/responses/{parent_id}/effects"
        self.service.observe_http("POST", route, {"effects": child["effects"]}, 202, child, other_session)
        # A later replay by the source participant cannot take ownership.
        self.service.observe_http("POST", route, {"effects": child["effects"]}, 200, child, self.session)
        self.service.record_job("rap-response", {**child, "state": "complete"})
        events = self.export_events()
        child_updates = [event for event in events if event["type"] == "generation.updated"
                         and event["payload"]["job_id"] == child_id]
        self.assertTrue(child_updates)
        self.assertEqual({event["session_id"] for event in child_updates}, {other_session})
        self.assertEqual(child_updates[-1]["payload"]["job"]["source_response_id"], parent_id)
        self.assertEqual(child_updates[-1]["payload"]["job"]["effects"]["pitch_semitones"], 3)

    def test_merge_two_laptops_repeated_exports_and_media(self):
        self.post("events", {"events": [self.event()]})
        self.post("media", self.media())
        first = self.service.export().path
        other = StudyRecorder(self.root / "laptop-two")
        try:
            other.add_events({"events": [self.event(sequence=2)]})
            second = other.export().path
            output = self.root / "analysis"
            result = merge_exports([first, second, first], output)
            self.assertEqual(result["new_events"], 2)
            self.assertEqual(result["duplicate_events"], 1)
            self.assertEqual(result["total_sessions"], 2)
            self.assertTrue((output / "combined.sqlite3").is_file())
            self.assertIn("payload.control", (output / "events.csv").read_text())
            self.assertTrue(list((output / "media").glob("*.wav")))
            self.assertEqual(merge_exports([first], output)["new_events"], 0)
        finally:
            other.close()

    def test_merge_conflicting_event_rolls_back(self):
        event = self.event()
        self.post("events", {"events": [event]})
        first = self.service.export().path
        other = StudyRecorder(self.root / "laptop-two")
        try:
            other.add_events({"events": [self.event(event_id=event["event_id"], payload={"value": 13})]})
            second = other.export().path
            output = self.root / "analysis"
            merge_exports([first], output)
            with self.assertRaisesRegex(ValueError, "conflicting content"):
                merge_exports([second], output)
            with sqlite3.connect(output / "combined.sqlite3") as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 1)
        finally:
            other.close()

    def test_merge_rejects_path_traversal_and_tampering(self):
        self.post("events", {"events": [self.event()]})
        original = self.service.export().path
        for kind in ("unsafe", "tampered"):
            changed = self.root / (kind + ".zip")
            with zipfile.ZipFile(original) as source, zipfile.ZipFile(changed, "w") as target:
                for item in source.infolist():
                    content = source.read(item.filename)
                    if kind == "tampered" and item.filename == "events.jsonl":
                        content = content.replace(b'"value":120', b'"value":121')
                    target.writestr(item.filename, content)
                if kind == "unsafe":
                    target.writestr("../escape.wav", wav())
            with self.assertRaises(ValueError):
                merge_exports([changed], self.root / (kind + "-analysis"))
        self.assertFalse((self.root / "escape.wav").exists())


if __name__ == "__main__":
    unittest.main()
