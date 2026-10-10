"""Offline contracts for rolling generation, stem archives and crash recovery."""

import copy
import io
import json
from pathlib import Path
import stat
import tempfile
import threading
import unittest
from unittest import mock
import zipfile

from elevenlabs_analysis import validate_request
from elevenlabs_realtime import extract_stems, validated_live_request
from elevenlabs_service import ElevenLabsService, GenerationError, ServiceError, STEM_PROVIDER_URL
import test_elevenlabs_service as fixtures


def stem_archive(entries=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, data in (entries or [("stems/drums.mp3", b"drum-audio"), ("stems/bass.mp3", b"bass-audio")]):
            archive.writestr(name, data)
    return output.getvalue()


class RealtimeServiceTests(unittest.TestCase):
    setUp = fixtures.ServiceTests.setUp
    tearDown = fixtures.ServiceTests.tearDown
    generate = fixtures.ServiceTests.generate
    complete = fixtures.ServiceTests.complete
    complete_stems = fixtures.ServiceTests.complete_stems

    def payload(self, **overrides):
        return {"plan_id": self.plan["id"], "session_id": "test_live_session", "sequence": 0,
                "duration_seconds": 40, "features": {"activity": 0.8, "variability": 0.2, "coverage": 1,
                "window_seconds": 5.4, "sample_count": 54, "source": "Signal Lab"}, **overrides}

    def run_stems(self, original):
        self.client.separate_stems = mock.Mock(side_effect=lambda source, destination, variation: destination.write_bytes(stem_archive()))
        self.service.create_stem_job(original["id"])
        with mock.patch("elevenlabs_service.validate_audio", return_value=fixtures.audio_metadata()):
            self.service._run_stem_job(original["id"])
        return self.service.get_stem_job(original["id"])

    def test_rolling_plan_preserves_anchors_and_truthful_observation_window(self):
        self.plan["settings"] = {"style": "ambient marimba music", "bpm": 84, "key": "F minor", "instrument_palette": ["marimba", "deep bass"]}
        self.plan = self.service._save("plans", self.plan)
        status, job = self.service.dispatch("POST", "/api/elevenlabs/continuations", self.payload())
        self.assertEqual(status, 202, job)
        self.assertTrue(job["separate_stems"])
        plan = self.service._read("plans", job["plan_id"])
        chunk = plan["request"]["composition_plan"]["chunks"][0]
        self.assertEqual(chunk["duration_ms"], 40000)
        for anchor in ("84 BPM", "F minor", "marimba", "deep bass"):
            self.assertIn(anchor, chunk["positive_styles"])
        self.assertIn("busy percussion", chunk["positive_styles"])
        self.assertIsNone(plan["sections"][0]["source_start"])
        self.assertIsNone(plan["sections"][0]["source_end"])
        self.assertEqual(plan["realtime"]["observed_window_seconds"], 5.4)
        self.assertFalse(job["realtime"]["conditioning_applied"])
        self.assertTrue(plan["request"]["store_for_inpainting"])
        self.assertNotIn(job["plan_id"], [item["id"] for item in self.service.plans()])
        self.assertEqual(len(self.client.calls), 0)

    def test_idempotent_double_click_and_reject_changed_sequence(self):
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.service.create_continuation_job(self.payload()))) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len({job["id"] for job in results}), 1)
        self.assertEqual(len(self.service.jobs()), 1)
        status, result = self.service.dispatch("POST", "/api/elevenlabs/continuations", self.payload(duration_seconds=60))
        self.assertEqual(status, 409)
        self.assertIn("different saved", result["error"])
        status, _ = self.service.dispatch("POST", "/api/elevenlabs/continuations", self.payload(sequence=1))
        self.assertEqual(status, 409)

    def test_unknown_survives_restart_without_resubmission(self):
        first = self.service.create_continuation_job(self.payload())
        self.client.failure = GenerationError("uncertain", "unknown")
        self.service._run_job(first["id"])
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        retried = self.service.create_continuation_job(self.payload())
        self.assertEqual(retried["id"], first["id"])
        self.assertEqual(retried["state"], "unknown")
        self.assertEqual(len(self.client.calls), 1)

    def test_idempotency_recovers_crash_before_job_binding(self):
        first = self.service.create_continuation_job(self.payload())
        self.service._db.execute("UPDATE live_requests SET job_id=NULL")
        self.service._db.commit()
        first["state"] = "generating"
        self.service._write_job(first)
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        reused = self.service.create_continuation_job(self.payload())
        self.assertEqual(reused["id"], first["id"])
        self.assertEqual(reused["state"], "unknown")
        self.assertEqual(len(self.service.jobs()), 1)

    def test_conditioning_uses_only_retained_saved_source_song(self):
        original = self.complete(self.generate())
        self.complete_stems(original)
        first = self.service.create_continuation_job(self.payload(source_job_id=original["id"]))
        self.assertFalse(first["realtime"]["conditioning_applied"])
        first = self.complete(first)
        self.assertEqual(first["stem_separation"]["state"], "queued")
        self.complete_stems(first)
        second = self.service.create_continuation_job(self.payload(sequence=1, source_job_id=first["id"]))
        plan = self.service._read("plans", second["plan_id"])
        chunk = plan["request"]["composition_plan"]["chunks"][0]
        self.assertEqual(chunk["conditioning_ref"], {"song_id": "song123", "range": {"start_ms": 0, "end_ms": 10000}})
        self.assertEqual(chunk["condition_strength"], "high")
        self.assertTrue(second["realtime"]["conditioning_applied"])
        self.assertGreaterEqual(first["generation_latency_seconds"], 0)

    def test_conditioning_clips_encoder_padding_and_keeps_last_thirty_seconds(self):
        first = self.service.create_continuation_job(self.payload(duration_seconds=20))
        padded = {**fixtures.audio_metadata(), "duration_seconds": 20.04, "requested_duration_seconds": 20}
        with mock.patch("elevenlabs_service.validate_audio", return_value=padded):
            self.service._run_job(first["id"])
            self.service._run_stem_job(first["id"])
        second = self.service.create_continuation_job(self.payload(sequence=1, duration_seconds=60, source_job_id=first["id"]))
        plan = self.service._read("plans", second["plan_id"])
        self.assertEqual(plan["request"]["composition_plan"]["chunks"][0]["conditioning_ref"]["range"],
                         {"start_ms": 0, "end_ms": 20000})
        padded = {**fixtures.audio_metadata(), "duration_seconds": 60.04, "requested_duration_seconds": 60}
        with mock.patch("elevenlabs_service.validate_audio", return_value=padded):
            self.service._run_job(second["id"])
            self.service._run_stem_job(second["id"])
        third = self.service.create_continuation_job(self.payload(sequence=2, duration_seconds=20, source_job_id=second["id"]))
        plan = self.service._read("plans", third["plan_id"])
        self.assertEqual(plan["request"]["composition_plan"]["chunks"][0]["conditioning_ref"]["range"],
                         {"start_ms": 30000, "end_ms": 60000})

    def test_invalid_feature_summary_is_rejected_before_plan_or_provider(self):
        original_count = len(self.service.plans())
        for changes in ({"activity": float("nan")}, {"variability": True}, {"coverage": 0.89},
                        {"window_seconds": 0}, {"sample_count": 1}, {"trend": 20}):
            payload = self.payload()
            payload["features"].update(changes)
            status, _ = self.service.dispatch("POST", "/api/elevenlabs/continuations", payload)
            self.assertEqual(status, 400, changes)
        self.assertEqual(len(self.service.plans()), original_count)
        self.assertEqual(self.service.jobs(), [])

    def test_stems_complete_serve_and_export_without_changing_original(self):
        original = self.complete(self.generate())
        result = self.run_stems(original)
        self.assertEqual(result["state"], "complete", result)
        self.assertEqual({stem["id"] for stem in result["stems"]}, {"drums", "bass"})
        status, audio = self.service.dispatch("GET", result["stems"][0]["audio_url"])
        self.assertEqual(status, 200)
        self.assertEqual(audio.path.read_bytes(), b"drum-audio")
        self.assertEqual(self.service.create_stem_job(original["id"])["state"], "complete")
        self.assertEqual(self.client.separate_stems.call_count, 1)
        self.assertEqual(self.service._job(original["id"])["state"], "complete")
        exported = self.service.export(self.plan, self.service._job(original["id"]))
        with zipfile.ZipFile(exported.path) as archive:
            self.assertIn("stems/drums.mp3", archive.namelist())
            self.assertIn("stems/manifest.json", archive.namelist())
            self.assertEqual(archive.read("audio.mp3"), b"mock valid audio")

    def test_stem_failure_and_restart_unknown_preserve_original_and_do_not_retry(self):
        original = self.complete(self.generate())
        self.client.separate_stems = mock.Mock(side_effect=GenerationError("timeout test-secret-123", "unknown"))
        self.service.create_stem_job(original["id"])
        self.service._run_stem_job(original["id"])
        result = self.service.create_stem_job(original["id"])
        self.assertEqual(result["state"], "unknown")
        self.assertNotIn("test-secret", result["error"])
        self.assertEqual(self.client.separate_stems.call_count, 1)
        job = self.service._job(original["id"])
        self.assertEqual(self.service.audio_response(job).path.read_bytes(), b"mock valid audio")
        job["stem_separation"]["state"] = "generating"
        self.service._write_job(job)
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        self.assertEqual(self.service.get_stem_job(original["id"])["state"], "unknown")
        self.assertEqual(self.service._job(original["id"])["state"], "complete")
        self.assertEqual(self.client.separate_stems.call_count, 1)

    def test_stems_and_continuations_share_one_pending_slot(self):
        original = self.complete(self.generate())
        self.service.create_stem_job(original["id"])
        status, _ = self.service.dispatch("POST", "/api/elevenlabs/continuations", self.payload())
        self.assertEqual(status, 409)
        self.assertEqual(len(self.client.calls), 1)

    def test_missing_stem_disables_stems_but_retains_original(self):
        original = self.complete(self.generate())
        result = self.run_stems(original)
        self.service.resolve_stem_audio(original["id"], result["stems"][0]["id"]).path.unlink()
        self.assertEqual(self.service.get_stem_job(original["id"])["state"], "failed")
        self.assertEqual(self.service.audio_response(self.service._job(original["id"])).path.read_bytes(), b"mock valid audio")


class StemArchiveTests(unittest.TestCase):
    def test_reject_unsafe_paths_symlinks_unknown_files_and_oversize_without_extracting(self):
        link = zipfile.ZipInfo("link.wav")
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        cases = [[("../outside.wav", b"data")], [("/absolute.wav", b"data")],
                 [("folder\\outside.wav", b"data")], [("C:/outside.wav", b"data")],
                 [(link, b"target")], [("readme.txt", b"text")]]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stems.zip"
            for entries in cases:
                source.write_bytes(stem_archive(entries))
                with self.assertRaises(ValueError):
                    extract_stems(source, root / "result", 10, lambda *_: fixtures.audio_metadata())
                self.assertFalse((root / "result").exists())
            source.write_bytes(stem_archive())
            with mock.patch("elevenlabs_realtime.MAX_UNPACKED_BYTES", 2):
                with self.assertRaises(ValueError):
                    extract_stems(source, root / "result", 10, lambda *_: fixtures.audio_metadata())

    def test_each_audio_file_is_decoded_and_partial_validation_cleans_all(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stems.zip"
            source.write_bytes(stem_archive())
            validator = mock.Mock(side_effect=[fixtures.audio_metadata(), GenerationError("bad audio")])
            with self.assertRaises(GenerationError):
                extract_stems(source, root / "result", 10, validator)
            self.assertEqual(validator.call_count, 2)
            self.assertFalse((root / "result").exists())


class StemClientTests(unittest.TestCase):
    setUp = fixtures.ClientTests.setUp
    tearDown = fixtures.ClientTests.tearDown
    response = staticmethod(fixtures.ClientTests.response)
    def test_stem_upload_is_multipart_and_zip_response_is_bounded(self):
        source = Path(self.directory.name) / "source.mp3"
        source.write_bytes(b"the-existing-track")
        opener = mock.Mock()
        opener.open.return_value = self.response(stem_archive(), "application/zip")
        with mock.patch("elevenlabs_service.request.build_opener", return_value=opener):
            self.client.separate_stems(source, self.output, "six_stems_v1")
        outgoing = opener.open.call_args.args[0]
        self.assertEqual(outgoing.full_url, STEM_PROVIDER_URL)
        self.assertIn('name="stem_variation_id"', outgoing.data.decode("latin1"))
        self.assertIn(b"six_stems_v1", outgoing.data)
        self.assertIn(b"the-existing-track", outgoing.data)
        self.assertNotIn(b"do-not-leak", outgoing.data)
        self.assertIn("multipart/form-data", outgoing.get_header("Content-type"))


class ConditioningValidationTests(unittest.TestCase):
    def test_conditioning_reference_is_strictly_bounded(self):
        request = fixtures.example_plan()["request"]
        request["store_for_inpainting"] = True
        chunk = request["composition_plan"]["chunks"][0]
        chunk["conditioning_ref"] = {"song_id": "song123", "range": {"start_ms": 20000, "end_ms": 40000}}
        chunk["condition_strength"] = "high"
        validate_request(request)
        for bad_span in ({"start_ms": 0, "end_ms": 31000}, {"start_ms": -1, "end_ms": 1000}, {"start_ms": True, "end_ms": 1000}):
            altered = copy.deepcopy(request)
            altered["composition_plan"]["chunks"][0]["conditioning_ref"]["range"] = bad_span
            with self.assertRaises(ValueError):
                validate_request(altered)
        request["store_for_inpainting"] = "true"
        with self.assertRaises(ValueError):
            validate_request(request)


if __name__ == "__main__":
    unittest.main()
