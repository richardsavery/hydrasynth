#!/usr/bin/env python3
"""Incremental local backup, retry, restart and complete collection checks."""
import base64
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest import mock
import uuid
import zipfile

from study_backup import StudyBackup
from study_merge import merge_exports
from study_recording import StudyRecorder, canonical
from test_study_recording import wav


class StudyBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.assets = self.root / "rap-response"
        self.assets.mkdir()
        self.recorder = StudyRecorder(self.root / "study", app_version="test", asset_roots={"rap-response": self.assets})
        self.backup = StudyBackup(self.recorder, interval_seconds=120)
        self.recorder.backup_service = self.backup
        self.session = str(uuid.uuid4())
        self.client = str(uuid.uuid4())

    def tearDown(self):
        self.backup.close()
        self.recorder.close()
        self.temp.cleanup()

    def event(self, sequence=1):
        event = {"event_id": str(uuid.uuid4()), "session_id": self.session, "client_id": self.client,
                 "sequence": sequence, "occurred_at": "2026-10-19T01:00:00Z", "elapsed_ms": 100,
                 "type": "ui.change", "payload": {"control": "tempo", "value": 120 + sequence}}
        self.recorder.add_events({"events": [event]})
        return event

    def media(self):
        request = {"media_id": str(uuid.uuid4()), "session_id": self.session,
                   "audio_base64": base64.b64encode(wav()).decode(), "metadata": {"mime_type": "audio/wav"}}
        self.recorder.save_media(request)
        return request["media_id"]

    def bundles(self):
        return sorted(self.backup.destination.glob("*.zip"))

    def manifest(self, path):
        with zipfile.ZipFile(path) as archive:
            return json.loads(archive.read("manifest.json"))

    def test_incremental_events_and_media_merge_without_recopying_old_audio(self):
        first = self.event()
        media_id = self.media()
        one = self.backup._run_once().path
        second = self.event(2)
        with mock.patch.object(Path, "open", autospec=True, side_effect=Path.open) as opened:
            two = self.backup._run_once().path
        self.assertFalse(any(str(call.args[0]).endswith(media_id + ".wav") for call in opened.call_args_list))
        self.assertEqual(self.manifest(two)["event_count"], 1)
        self.assertFalse(any(item["path"].startswith("media/") for item in self.manifest(two)["files"]))
        self.assertIsNone(self.backup._run_once())
        self.assertEqual(len(self.bundles()), 2)
        result = merge_exports([two, one, two], self.root / "analysis")
        self.assertEqual(result["total_events"], 2)
        with sqlite3.connect(self.root / "analysis" / "combined.sqlite3") as db:
            self.assertEqual({row[0] for row in db.execute("SELECT event_id FROM events")}, {first["event_id"], second["event_id"]})
            local = db.execute("SELECT local_path FROM media WHERE media_id=?", (media_id,)).fetchone()[0]
        self.assertEqual((self.root / "analysis" / local).read_bytes(), wav())

    def test_late_and_changed_generation_assets_arrive_without_new_events(self):
        job_id = uuid.uuid4().hex
        self.recorder.observe_http("POST", "/api/rap-response/responses", {}, 202,
                                   {"id": job_id, "state": "queued"}, self.session)
        first = self.backup._run_once().path
        directory = self.assets / job_id
        directory.mkdir()
        audio = directory / "vocals.wav"
        audio.write_bytes(wav())
        with sqlite3.connect(self.assets / "responses.sqlite3") as db:
            db.execute("CREATE TABLE responses (id TEXT PRIMARY KEY,body TEXT)")
            db.execute("INSERT INTO responses VALUES (?,?)", (job_id, canonical({"id": job_id, "state": "complete"})))
        second = self.backup._run_once().path
        prefix = "assets/rap-response/" + job_id + "/"
        self.assertEqual(self.manifest(second)["event_count"], 0)
        with zipfile.ZipFile(second) as archive:
            self.assertEqual(archive.read(prefix + "vocals.wav"), wav())
            self.assertEqual(json.loads(archive.read(prefix + "job.json"))["state"], "complete")
        self.assertIsNone(self.backup._run_once())
        audio.write_bytes(wav() + b"changed")
        third = self.backup._run_once().path
        with zipfile.ZipFile(third) as archive:
            self.assertEqual(archive.read(prefix + "vocals.wav"), wav() + b"changed")
        self.assertEqual(merge_exports([third, first, second], self.root / "analysis")["total_sessions"], 1)

    def test_missing_microphone_bytes_retry_and_merge_in_either_order(self):
        media_id = self.media()
        path = self.recorder.root / "media" / (media_id + ".wav")
        original = path.read_bytes()
        path.unlink()
        first = self.backup._run_once().path
        self.assertEqual(self.manifest(first)["missing_assets"][0]["media_id"], media_id)
        path.write_bytes(original)
        second = self.backup._run_once().path
        self.assertEqual(self.manifest(second)["media"][0]["media_id"], media_id)
        merge_exports([second, first], self.root / "analysis")
        with sqlite3.connect(self.root / "analysis" / "combined.sqlite3") as db:
            local = db.execute("SELECT local_path FROM media WHERE media_id=?", (media_id,)).fetchone()[0]
        self.assertEqual((self.root / "analysis" / local).read_bytes(), original)

    def test_publication_failure_retries_without_advancing_or_damaging_capture(self):
        self.event()
        original_replace = Path.replace

        def failed_replace(path, target):
            if str(target).endswith(".zip"):
                raise OSError("disk full")
            return original_replace(path, target)

        with mock.patch.object(Path, "replace", failed_replace):
            self.assertIsNone(self.backup._run_once())
        self.assertEqual(self.backup.status()["state"], "error")
        self.assertTrue(self.recorder.status()["ready"])
        self.assertIsNone(self.recorder.last_error)
        self.assertFalse(self.bundles())
        self.assertFalse(list(self.backup.destination.glob("*.tmp")))
        self.event(2)
        bundle = self.backup._run_once().path
        self.assertEqual(self.manifest(bundle)["event_count"], 2)
        self.assertIsNone(self.backup.status()["last_error"])

    def test_checkpoint_failure_keeps_published_bundle_and_duplicate_retry_is_safe(self):
        self.event()
        with mock.patch.object(self.backup, "_save_checkpoint", side_effect=OSError("disk full")):
            self.assertIsNone(self.backup._run_once())
        self.assertEqual(len(self.bundles()), 1)
        self.backup._run_once()
        self.assertEqual(len(self.bundles()), 2)
        result = merge_exports(self.bundles(), self.root / "analysis")
        self.assertEqual(result["new_events"], 1)
        self.assertEqual(result["duplicate_events"], 1)

    def test_restart_loads_cursor_and_does_not_duplicate_existing_bundles(self):
        self.event()
        self.media()
        self.backup._run_once()
        completed = self.backup.status()["last_completed_at"]
        self.backup.close()
        self.backup = StudyBackup(self.recorder)
        self.assertIsNone(self.backup._run_once())
        self.assertEqual(self.backup.status()["last_completed_at"], completed)
        self.assertEqual(len(self.bundles()), 1)
        self.event(2)
        self.assertEqual(self.manifest(self.backup._run_once().path)["event_count"], 1)

    def test_corrupt_checkpoint_reexports_safely(self):
        self.event()
        self.backup._run_once()
        self.backup.close()
        self.backup._checkpoint_path.write_text("not valid json")
        self.backup = StudyBackup(self.recorder)
        self.backup._run_once()
        self.assertEqual(merge_exports(self.bundles(), self.root / "analysis")["total_events"], 1)

    def test_removed_backup_folder_is_rebuilt_after_restart(self):
        self.event()
        media_id = self.media()
        self.backup._run_once()
        self.backup.close()
        for path in self.bundles():
            path.unlink()
        self.backup.destination.rmdir()
        self.backup = StudyBackup(self.recorder)
        rebuilt = self.backup._run_once().path
        self.assertEqual(self.manifest(rebuilt)["event_count"], 1)
        with zipfile.ZipFile(rebuilt) as archive:
            self.assertEqual(archive.read("media/" + media_id + ".wav"), wav())

    def test_checkpoint_ahead_of_restored_journal_rebuilds(self):
        self.event()
        self.backup._run_once()
        self.backup.close()
        saved = json.loads(self.backup._checkpoint_path.read_text())
        saved["checkpoint"]["event_rowid"] = 1000
        self.backup._checkpoint_path.write_text(canonical(saved))
        self.backup = StudyBackup(self.recorder)
        self.assertEqual(self.manifest(self.backup._run_once().path)["event_count"], 1)

    def test_file_changing_during_copy_is_retried_without_publishing_partial_bundle(self):
        job_id = uuid.uuid4().hex
        self.recorder.observe_http("POST", "/api/rap-response/responses", {}, 202,
                                   {"id": job_id, "state": "queued"}, self.session)
        directory = self.assets / job_id
        directory.mkdir()
        audio = directory / "vocals.wav"
        audio.write_bytes(wav())
        original_open = zipfile.ZipFile.open
        changed = False

        def change_during_copy(archive, name, *args, **kwargs):
            nonlocal changed
            if str(name).endswith("/vocals.wav") and not changed:
                changed = True
                audio.write_bytes(wav() + b"finishing")
            return original_open(archive, name, *args, **kwargs)

        with mock.patch.object(zipfile.ZipFile, "open", change_during_copy):
            self.assertIsNone(self.backup._run_once())
        self.assertFalse(self.bundles())
        self.assertTrue(self.recorder.status()["ready"])
        complete = self.backup._run_once().path
        with zipfile.ZipFile(complete) as archive:
            self.assertEqual(archive.read("assets/rap-response/" + job_id + "/vocals.wav"), wav() + b"finishing")

    def test_unavailable_destination_does_not_fail_constructor_or_recording(self):
        obstruction = self.root / "not-a-folder"
        obstruction.write_text("file")
        other = StudyBackup(self.recorder, obstruction / "backups")
        other._run_once()
        self.assertEqual(other.status()["state"], "error")
        self.event()
        self.assertTrue(self.recorder.status()["ready"])
        obstruction.unlink()
        self.assertIsNotNone(other._run_once())
        other.close()

    def test_worker_starts_automatically_and_close_captures_final_event(self):
        self.event()
        self.backup.start()
        deadline = time.monotonic() + 3
        while not self.backup.status()["last_completed_at"] and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertIsNotNone(self.backup.status()["last_completed_at"])
        self.recorder.record("application.stopped", {})
        self.backup.close()
        merge_exports(self.bundles(), self.root / "analysis")
        with sqlite3.connect(self.root / "analysis" / "combined.sqlite3") as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE type='application.stopped'").fetchone()[0], 1)
        self.assertFalse(self.backup._thread.is_alive())

    def test_close_waits_for_final_queued_tail_beyond_periodic_drain(self):
        entered, release = threading.Event(), threading.Event()
        original_insert = self.recorder._insert_events

        def delayed_insert(events):
            entered.set()
            release.wait(4)
            return original_insert(events)

        with mock.patch.object(self.recorder, "_insert_events", delayed_insert):
            self.recorder.record("application.stopped", {})
            self.assertTrue(entered.wait(1))
            closer = threading.Thread(target=self.backup.close)
            closer.start()
            time.sleep(1.1)
            self.assertTrue(closer.is_alive())
            release.set()
            closer.join(3)
            self.assertFalse(closer.is_alive())
        result = merge_exports(self.bundles(), self.root / "analysis")
        self.assertEqual(result["total_events"], 1)

    def test_session_code_edit_is_backed_up_without_new_events(self):
        self.event()
        first = self.backup._run_once().path
        self.recorder.create_session({"session_id": self.session, "participant_code": "P-7"})
        second = self.backup._run_once().path
        self.assertEqual(self.manifest(second)["event_count"], 0)
        merge_exports([second, first], self.root / "analysis")
        with sqlite3.connect(self.root / "analysis" / "combined.sqlite3") as db:
            self.assertEqual(db.execute("SELECT participant_code FROM sessions").fetchone()[0], "P-7")

    def test_manual_export_still_contains_all_audio_and_events(self):
        self.event()
        media_id = self.media()
        self.backup._run_once()
        self.event(2)
        self.backup._run_once()
        full = self.recorder.export()
        self.assertEqual(self.manifest(full.path)["event_count"], 2)
        with zipfile.ZipFile(full.path) as archive:
            self.assertEqual(archive.read("media/" + media_id + ".wav"), wav())


if __name__ == "__main__":
    unittest.main()
