#!/usr/bin/env python3
"""Offline service/client tests. No account or paid API calls are used."""

import copy
from email.message import Message
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock
from urllib import error
import zipfile
import wave

import beat_tracking

from elevenlabs_service import (
    ElevenLabsClient, ElevenLabsService, FileResponse, GenerationError, ServiceError,
    CACHE_KEY_VERSION, MAX_UPLOAD_BYTES, PROVIDER_URL, atomic_json, canonical_json, create_tls_context, digest, load_configuration,
    validate_audio, validate_uploaded_plan,
)


def example_plan():
    section = {
        "index": 0, "source_start": 0, "source_end": 10,
        "audio_start": 0, "audio_end": 10, "duration_ms": 10000,
        "coverage": 1, "activity": 0.5, "variability": 0.2,
        "positive_styles": ["instrumental electronic music", "sparse arrangement"],
        "negative_styles": ["vocals", "lyrics"],
    }
    request = {"model_id": "music_v2_5", "composition_plan": {"chunks": [{
        "duration_ms": 10000, "text": "[Low activity]", "context_adherence": "high",
        "positive_styles": section["positive_styles"], "negative_styles": section["negative_styles"],
    }]}}
    return {
        "analysis_id": "a" * 32, "dataset_id": "b" * 32, "dataset_hash": "source_hash",
        "schema_version": 1, "request": request, "sections": [section],
        "mapping_version": "1", "thresholds": [0.33, 0.67], "baseline": {},
        "settings": {}, "analysis_settings": {}, "duration_seconds": 10,
        "can_generate": True, "blocking_reasons": [], "warnings": [],
        "cache_key": digest(request), "manual_edits": False,
    }


def audio_metadata():
    return {
        "duration_seconds": 10, "format": "mp3", "extension": "mp3",
        "content_type": "audio/mpeg", "timing_warning": None,
        "requested_duration_seconds": 10,
    }


class FakeClient:
    def __init__(self, failure=None):
        self.calls = []
        self.stem_calls = []
        self.failure = failure

    def generate(self, body, destination):
        self.calls.append(body)
        if self.failure:
            destination.write_bytes(b"partial")
            raise self.failure
        destination.write_bytes(b"mock valid audio")
        return {"provider_content_type": "audio/mpeg", "provider_song_id": "song123", "size_bytes": 16}

    def separate_stems(self, source, destination, variation, **options):
        self.stem_calls.append((source, variation))
        with zipfile.ZipFile(destination, "w") as archive:
            for name in ("drums", "bass", "other", "vocals", "guitar", "piano"):
                archive.writestr(name + ".mp3", b"mock stem audio")


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.env = self.root / ".env"
        self.env.write_text("ELEVENLABS_API_KEY=test-secret-123\n", encoding="utf-8")
        self.environment = mock.patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.tool_lookup = mock.patch("elevenlabs_service.shutil.which", side_effect=lambda name: "/fake/" + name)
        self.tool_lookup.start()
        self.client = FakeClient()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        self.plan = self.service._save("plans", example_plan())

    def tearDown(self):
        self.service.close()
        self.tool_lookup.stop()
        self.environment.stop()
        self.directory.cleanup()

    def generate(self, variation=False):
        return self.service.create_generation({"plan_id": self.plan["id"], "variation": variation})

    def complete(self, job):
        with mock.patch("elevenlabs_service.validate_audio", return_value=audio_metadata()):
            self.service._run_job(job["id"])
        return self.service._job(job["id"])

    def complete_stems(self, job):
        with mock.patch("elevenlabs_service.validate_audio", return_value=audio_metadata()):
            self.service._run_stem_job(job["id"])
        return self.service._job(job["id"])

    def upload(self, content=b"mock uploaded audio", filename="My own song.mp3", request_id="c" * 32):
        metadata = {**audio_metadata(), "requested_duration_seconds": None}
        with mock.patch("elevenlabs_service.validate_audio", return_value=metadata):
            return self.service.create_upload(content, filename, request_id)

    def beat_result(self, job, **changes):
        checksum = __import__("hashlib").sha256((self.service.root / "jobs" / job["id"] / job["audio_filename"]).read_bytes()).hexdigest()
        return {"schema_version": 1, "algorithm": beat_tracking.ALGORITHM, "state": "complete",
                "source": "mix", "source_stem_id": None, "source_sha256": checksum, "audio_sha256": checksum,
                "duration_seconds": 10, "beats_seconds": [1.2, 1.7, 2.2, 2.7],
                "first_beat_in_bar": 3, "bar_phase_confidence": .6,
                "active_regions": [{"start_seconds": 1.2, "end_seconds": 2.8}],
                "bpm_median": 120, "bpm_min": 120, "bpm_max": 120, "warnings": [], "error": None, **changes}

    def test_beat_analysis_is_explicit_local_idempotent_and_persisted(self):
        self.service._api_key = ""
        job = self.upload()
        self.assertEqual(self.service.dispatch("GET", f"/api/elevenlabs/generations/{job['id']}/beats")[1]["state"], "not_requested")
        self.assertTrue(self.service._queue.empty())
        with mock.patch("beat_tracking.available", return_value=True):
            status, queued = self.service.dispatch("POST", f"/api/elevenlabs/generations/{job['id']}/beats", {"bpm_hint": 120})
            self.assertEqual(status, 202)
            self.assertEqual(queued["state"], "queued")
            duplicate = self.service.create_beat_job(job["id"], {"bpm_hint": 120})
            self.assertTrue(duplicate["reused"])
            self.assertEqual(self.service._queue.qsize(), 1)
            with mock.patch("beat_tracking.analyze", return_value=self.beat_result(job)) as analysis:
                self.service._run_beat_job(job["id"])
            self.assertEqual(analysis.call_count, 1)
            result = self.service.get_beat_job(job["id"])
            self.assertEqual(result["state"], "complete")
            self.assertEqual(result["bpm_hint"], 120)
            self.assertEqual(result["beats_seconds"][0], 1.2)
            self.assertEqual(result["first_beat_in_bar"], 3)
            self.assertEqual(result["bar_phase_confidence"], .6)
            self.assertTrue(self.service.create_beat_job(job["id"], {"bpm_hint": 120})["reused"])
            self.assertEqual(self.service.create_beat_job(job["id"], {"bpm_hint": 60})["state"], "queued")
        self.assertFalse(self.client.calls)
        self.assertFalse(self.client.stem_calls)

    def test_beat_analysis_refreshes_previous_algorithm_and_then_reuses_result(self):
        job = self.upload()
        job["beat_analysis"] = self.beat_result(job, algorithm="librosa-dynamic-v1", bpm_hint=None)
        self.service._write_job(job)
        with mock.patch("beat_tracking.available", return_value=True):
            queued = self.service.create_beat_job(job["id"], {})
            self.assertEqual(queued["state"], "queued")
            self.assertEqual(queued["algorithm"], beat_tracking.ALGORITHM)
            with mock.patch("beat_tracking.analyze", return_value=self.beat_result(job)):
                self.service._run_beat_job(job["id"])
            self.assertTrue(self.service.create_beat_job(job["id"], {})["reused"])
        self.assertFalse(self.client.calls)
        self.assertFalse(self.client.stem_calls)

    def test_beat_analysis_prefers_finished_drums_and_reanalyzes_new_source(self):
        job = self.upload()
        with mock.patch("beat_tracking.available", return_value=True):
            self.service.create_beat_job(job["id"], {})
            with mock.patch("beat_tracking.analyze", return_value=self.beat_result(job)):
                self.service._run_beat_job(job["id"])
            self.service.create_stem_job(job["id"])
            self.complete_stems(job)
            queued = self.service.create_beat_job(job["id"], {})
            self.assertEqual(queued["state"], "queued")
            self.assertEqual(queued["source"], "drums")
            self.assertEqual(queued["source_stem_id"], "drums")
            self.assertNotEqual(queued["source_sha256"], queued["audio_sha256"])

    def test_beat_analysis_failure_retry_setup_and_restart_are_passive(self):
        job = self.upload()
        with mock.patch("beat_tracking.available", return_value=False):
            self.assertEqual(self.service.dispatch("POST", f"/api/elevenlabs/generations/{job['id']}/beats", {})[0], 503)
        with mock.patch("beat_tracking.available", return_value=True):
            for hint in (True, 0, 301, float("nan"), "120"):
                with self.assertRaises(ServiceError):
                    self.service.create_beat_job(job["id"], {"bpm_hint": hint})
            self.service.create_beat_job(job["id"], {})
            with mock.patch("beat_tracking.analyze", side_effect=ValueError("No reliable beat sequence was found.")):
                self.service._run_beat_job(job["id"])
            self.assertEqual(self.service.get_beat_job(job["id"])["state"], "failed")
            self.assertEqual(self.service.create_beat_job(job["id"], {})["state"], "queued")
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        self.assertEqual(self.service.get_beat_job(job["id"])["state"], "failed")
        self.assertTrue(self.service._queue.empty())
        self.assertFalse(self.client.calls)
        self.assertFalse(self.client.stem_calls)

    def test_restored_beat_map_wins_over_inflight_analysis(self):
        job = self.upload()
        restored = self.beat_result(job, beats_seconds=[1.3, 1.8, 2.3, 2.8])

        def replace_with_restored(*args, **kwargs):
            current = self.service._job(job["id"])
            current["beat_analysis"] = restored
            self.service._write_job(current)
            return self.beat_result(job)

        with mock.patch("beat_tracking.available", return_value=True):
            self.service.create_beat_job(job["id"], {})
            with mock.patch("beat_tracking.analyze", side_effect=replace_with_restored):
                self.service._run_beat_job(job["id"])
        self.assertEqual(self.service._job(job["id"])["beat_analysis"], restored)

    def test_invalid_saved_beat_warnings_are_repaired_to_a_readable_failure(self):
        job = self.upload()
        job["beat_analysis"] = self.beat_result(job, warnings={"message": "invalid"})
        self.service._write_job(job)
        result = self.service.get_beat_job(job["id"])
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["warnings"], [])
        self.assertEqual(result["beats_seconds"], [])
        self.assertIn("Analyze the track again", result["error"])
        self.assertEqual(self.service.get_beat_job(job["id"]), result)

    def test_upload_without_key_is_local_and_has_truthful_plan_and_export(self):
        self.service._api_key = ""
        job = self.upload(filename="C:\\outside\\My own song.mp3")
        self.assertEqual(job["name"], "My own song")
        self.assertEqual(job["origin"], "uploaded")
        self.assertEqual(job["state"], "complete")
        self.assertFalse(job["separate_stems"])
        self.assertIsNone(job["model_id"])
        self.assertIsNone(job["requested_duration_seconds"])
        self.assertNotIn("stem_separation", job)
        self.assertTrue(self.service._queue.empty())
        self.assertEqual(self.service.audio_response(job).path.read_bytes(), b"mock uploaded audio")
        self.assertEqual(self.service.jobs(job["plan_id"])[0]["id"], job["id"])
        plan = self.service._read("plans", job["plan_id"])
        validate_uploaded_plan(plan)
        self.assertNotIn("request", plan)
        self.assertFalse(plan["can_generate"])
        self.assertEqual(plan["source"]["filename"], "My own song.mp3")
        self.assertFalse((self.service.root / "jobs" / job["id"] / "request.json").exists())
        with zipfile.ZipFile(self.service.export(plan, job).path) as archive:
            self.assertNotIn("request.json", archive.namelist())
            self.assertEqual(archive.read("audio.mp3"), b"mock uploaded audio")
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["origin"], "uploaded")
            self.assertEqual(manifest["source"], plan["source"])
        status, result = self.service.dispatch("POST", f"/api/elevenlabs/generations/{job['id']}/stems", {})
        self.assertEqual(status, 503)
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.client.stem_calls, [])

    def test_upload_duplicate_and_restart_reuse_without_decode_or_provider(self):
        first = self.upload()
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        with mock.patch("elevenlabs_service.validate_audio", side_effect=AssertionError("Must reuse validated upload")):
            second = self.service.create_upload(b"mock uploaded audio", "renamed.mp3", first["id"])
        self.assertEqual(first["id"], second["id"])
        self.assertTrue(second["reused"])
        self.assertEqual(second["name"], "My own song")
        self.assertEqual(len(self.service.jobs()), 1)
        self.assertTrue(self.service._queue.empty())
        with self.assertRaises(ServiceError) as conflict:
            self.upload(content=b"different audio")
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual(self.client.calls + self.client.stem_calls, [])

    def test_concurrent_upload_retries_create_one_job_and_do_not_replace_generated_jobs(self):
        jobs = []
        with mock.patch("elevenlabs_service.validate_audio", return_value=audio_metadata()):
            workers = [threading.Thread(target=lambda: jobs.append(self.service.create_upload(b"same audio", "song.wav", "c" * 32)))
                       for _ in range(8)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join()
        self.assertEqual(len(jobs), 8)
        self.assertEqual(len({job["id"] for job in jobs}), 1)
        self.assertEqual(len(self.service.jobs()), 1)
        generated = self.generate()
        with self.assertRaises(ServiceError) as conflict:
            self.upload(request_id=generated["id"])
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual(self.service._job(generated["id"])["state"], "queued")
        self.assertTrue((self.service.root / "jobs" / generated["id"] / "request.json").is_file())

    def test_upload_generations_and_continuations_rejected_before_provider(self):
        job = self.upload()
        for route, payload in (
            ("generations", {"plan_id": job["plan_id"]}),
            ("continuations", {"kind": "prompt", "plan_id": job["plan_id"], "source_job_id": job["id"],
                               "session_id": "upload_test", "sequence": 0, "duration_seconds": 20, "settings": {}}),
        ):
            status, result = self.service.dispatch("POST", "/api/elevenlabs/" + route, payload)
            self.assertEqual(status, 400, result)
            self.assertIn("Uploaded audio", result["error"])
        self.assertEqual(self.client.calls + self.client.stem_calls, [])

    def test_upload_requires_explicit_separation_and_submits_once(self):
        job = self.upload()
        self.assertEqual(self.service.get_stem_job(job["id"])["state"], "not_requested")
        self.assertEqual(self.service.create_stem_job(job["id"])["state"], "queued")
        self.assertTrue(self.service.create_stem_job(job["id"])["reused"])
        with mock.patch.object(self.client, "separate_stems", wraps=self.client.separate_stems) as separate:
            complete = self.complete_stems(job)
        self.assertEqual(separate.call_args.kwargs["max_archive_bytes"], 512 * 1024 * 1024)
        self.assertEqual(complete["stem_separation"]["state"], "complete")
        self.assertTrue(self.service.create_stem_job(job["id"])["reused"])
        self.complete_stems(job)
        self.assertEqual(len(self.client.stem_calls), 1)
        self.assertEqual(self.client.calls, [])
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        self.assertTrue(self.service.create_stem_job(job["id"])["reused"])
        self.assertTrue(self.service._queue.empty())

    def test_upload_ambiguous_separation_is_never_replayed(self):
        job = self.upload()
        self.service.create_stem_job(job["id"])
        details = {"operation": "stem_separation", "phase": "downloading", "reason": "timeout", "bytes_received": 10}
        self.client.separate_stems = mock.Mock(side_effect=GenerationError("Unknown outcome", "unknown", diagnostics=details))
        self.service._run_stem_job(job["id"])
        self.assertEqual(self.service.create_stem_job(job["id"])["state"], "unknown")
        self.assertEqual(self.service._job(job["id"])["stem_separation"]["failure_details"], details)
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        self.assertEqual(self.service.create_stem_job(job["id"])["state"], "unknown")
        self.assertTrue(self.service._queue.empty())
        self.client.separate_stems.assert_called_once()

    def test_upload_failed_validation_invalid_names_limits_and_identifiers_do_not_persist(self):
        initial_plans = len(self.service.plans())
        with mock.patch("elevenlabs_service.validate_audio", side_effect=GenerationError("Bad audio")):
            with self.assertRaisesRegex(ServiceError, "Bad audio"):
                self.service.create_upload(b"invalid", "../../a.mp3", "c" * 32)
        for filename, request_id in (("../", "c" * 32), ("audio.wav", "../outside"), ("a" * 256, "c" * 32)):
            with self.assertRaises((ServiceError, ValueError)):
                self.upload(filename=filename, request_id=request_id)
        with mock.patch("elevenlabs_service.MAX_CUSTOM_AUDIO_BYTES", 5):
            with self.assertRaises(ServiceError) as oversized:
                self.upload()
            self.assertEqual(oversized.exception.status, 413)
        self.assertEqual(len(self.service.plans()), initial_plans)
        self.assertEqual(self.service.jobs(), [])
        self.assertEqual(list((self.service.root / "jobs").iterdir()), [])
        self.assertEqual(list(self.service.root.glob("upload.tmp-*")), [])

    def test_upload_dispatch_requires_raw_bytes_and_single_filename_and_request_id(self):
        endpoint = "/api/elevenlabs/uploads?filename=..%2Fmy%20song.mp3&request_id=" + "c" * 32
        with mock.patch("elevenlabs_service.validate_audio", return_value=audio_metadata()):
            status, job = self.service.dispatch("POST", endpoint, b"audio")
        self.assertEqual(status, 201, job)
        self.assertEqual(job["name"], "my song")
        self.assertEqual(self.service.dispatch("POST", endpoint, {"audio": "base64"})[0], 413)
        self.assertEqual(self.service.dispatch("POST", endpoint + "&filename=other.mp3", b"audio")[0], 400)

    def test_setup_status_never_contains_key(self):
        status, body = self.service.dispatch("GET", "/api/elevenlabs/status")
        self.assertEqual(status, 200)
        self.assertTrue(body["ready"])
        self.assertNotIn("test-secret", canonical_json(body))
        self.service.ffmpeg = None
        self.assertFalse(self.service.status()["ready"])
        status, body = self.service.dispatch("POST", "/api/elevenlabs/generations", {"plan_id": self.plan["id"]})
        self.assertEqual(status, 503)
        self.assertIn("FFmpeg", body["error"])
        self.assertEqual(body["code"], "generation_not_submitted")
        self.assertEqual(self.service.jobs(), [])
        self.assertTrue(self.service._queue.empty())
        self.assertEqual(len(self.client.calls), 0)

    def test_missing_key_generation_can_be_retried_without_an_unknown_job(self):
        self.service._api_key = ""
        payload = {"plan_id": self.plan["id"], "variation": True}
        status, body = self.service.dispatch("POST", "/api/elevenlabs/generations", payload)
        self.assertEqual(status, 503)
        self.assertEqual(body["code"], "generation_not_submitted")
        self.assertIn("ELEVENLABS_API_KEY", body["error"])
        self.assertEqual(self.service.jobs(), [])
        self.assertTrue(self.service._queue.empty())
        self.assertEqual(list((self.service.root / "jobs").iterdir()), [])
        self.assertEqual(self.client.calls + self.client.stem_calls, [])
        self.service._api_key = "test-secret-123"
        status, job = self.service.dispatch("POST", "/api/elevenlabs/generations", payload)
        self.assertEqual(status, 202)
        self.assertEqual(job["state"], "queued")
        self.assertEqual(len(self.service.jobs()), 1)
        self.assertEqual(self.service._queue.qsize(), 1)

    def test_missing_key_continuation_retains_an_idempotent_retry(self):
        self.service._api_key = ""
        payload = {"kind": "prompt", "plan_id": self.plan["id"], "source_job_id": None,
                   "session_id": "missing_key_test", "sequence": 0, "duration_seconds": 20,
                   "settings": {"style": "spacious jazz"}}
        status, body = self.service.dispatch("POST", "/api/elevenlabs/continuations", payload)
        self.assertEqual(status, 503)
        self.assertEqual(body["code"], "generation_not_submitted")
        self.assertEqual(self.service.jobs(), [])
        self.assertTrue(self.service._queue.empty())
        self.assertEqual(list((self.service.root / "jobs").iterdir()), [])
        self.assertEqual(self.client.calls + self.client.stem_calls, [])
        self.service._api_key = "test-secret-123"
        status, job = self.service.dispatch("POST", "/api/elevenlabs/continuations", payload)
        repeated_status, repeated = self.service.dispatch("POST", "/api/elevenlabs/continuations", payload)
        self.assertEqual((status, repeated_status), (202, 202))
        self.assertEqual(repeated["id"], job["id"])
        self.assertTrue(repeated["reused"])
        self.assertEqual(len(self.service.jobs()), 1)
        self.assertEqual(self.service._queue.qsize(), 1)

    def test_shutdown_rejections_confirm_no_generation_was_submitted(self):
        self.service._closed = True
        try:
            for route, payload in (
                ("generations", {"plan_id": self.plan["id"]}),
                ("continuations", {"kind": "prompt", "plan_id": self.plan["id"], "source_job_id": None,
                                   "session_id": "shutdown_test", "sequence": 0, "duration_seconds": 20,
                                   "settings": {"style": "spacious jazz"}}),
            ):
                with self.subTest(route=route):
                    status, body = self.service.dispatch("POST", "/api/elevenlabs/" + route, payload)
                    self.assertEqual(status, 503)
                    self.assertEqual(body["code"], "generation_not_submitted")
            self.assertEqual(self.service.jobs(), [])
            self.assertTrue(self.service._queue.empty())
            self.assertEqual(self.client.calls + self.client.stem_calls, [])
        finally:
            self.service._closed = False

    def test_unclassified_server_errors_do_not_claim_generation_was_rejected(self):
        payload = {"plan_id": self.plan["id"]}
        with mock.patch.object(self.service, "create_generation", side_effect=ServiceError("Unavailable", 503)):
            status, body = self.service.dispatch("POST", "/api/elevenlabs/generations", payload)
        self.assertEqual(status, 503)
        self.assertNotIn("code", body)
        # A storage/server failure may occur after saving a job; callers must
        # recover it instead of treating every server error as a safe retry.
        with mock.patch.object(self.service._queue, "put", side_effect=OSError("Queue unavailable")):
            status, body = self.service.dispatch("POST", "/api/elevenlabs/generations", payload)
        self.assertEqual(status, 500)
        self.assertNotIn("code", body)
        self.assertEqual(len(self.service.jobs()), 1)

    def test_duplicate_submissions_and_variation_double_click_reuse_inflight(self):
        jobs = []
        threads = [threading.Thread(target=lambda: jobs.append(self.generate())) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len({job["id"] for job in jobs}), 1)
        self.assertEqual(self.generate(variation=True)["id"], jobs[0]["id"])
        self.assertEqual(len(self.service.jobs()), 1)
        self.assertEqual(len(self.client.calls), 0)

    def test_completed_cache_and_explicit_variation(self):
        first = self.complete(self.generate())
        self.assertEqual(first["state"], "complete")
        self.assertEqual(self.generate()["id"], first["id"])
        self.complete_stems(first)
        second = self.generate(variation=True)
        self.assertNotEqual(second["id"], first["id"])
        self.assertEqual(second["attempt_count"], 2)
        self.assertEqual(len(self.client.calls), 1)

    def test_new_generation_automatically_reserves_one_six_stem_request(self):
        queued = self.generate()
        self.assertTrue(queued["separate_stems"])
        complete = self.complete(queued)
        self.assertEqual(complete["stem_separation"]["state"], "queued")
        self.assertEqual(complete["stem_separation"]["stem_variation_id"], "six_stems_v1")
        self.assertEqual(self.service.audio_response(complete).path.read_bytes(), b"mock valid audio")
        self.assertEqual(self.generate()["id"], complete["id"])
        self.assertTrue(self.service.create_stem_job(complete["id"])["reused"])
        status, _ = self.service.dispatch("POST", "/api/elevenlabs/generations", {"plan_id": self.plan["id"], "variation": True})
        self.assertEqual(status, 409)
        self.service._run_job(complete["id"])
        self.assertEqual(list(self.service._queue.queue).count(("stems", complete["id"])), 1)
        complete = self.complete_stems(complete)
        self.complete_stems(complete)
        self.assertEqual(complete["stem_separation"]["state"], "complete")
        self.assertEqual(len(complete["stem_separation"]["stems"]), 6)
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(len(self.client.stem_calls), 1)
        self.assertFalse(self.service._provider_busy())

    def test_restart_resumes_queued_automatic_stems_once(self):
        job = self.complete(self.generate())
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        self.assertEqual(list(self.service._queue.queue), [("stems", job["id"])])
        complete = self.complete_stems(job)
        self.assertEqual(complete["stem_separation"]["state"], "complete")
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        self.assertTrue(self.service._queue.empty())
        self.assertTrue(self.service.create_stem_job(job["id"])["reused"])
        self.assertEqual(len(self.client.stem_calls), 1)

    def test_recovery_only_adds_missing_automatic_stage_to_flagged_jobs(self):
        legacy = self.complete(self.generate())
        legacy.pop("separate_stems")
        legacy.pop("stem_separation")
        self.service._write_job(legacy)
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        self.assertTrue(self.service._queue.empty())
        self.assertEqual(self.generate()["id"], legacy["id"])
        self.assertEqual(self.service.get_stem_job(legacy["id"])["state"], "not_requested")
        self.assertFalse(self.client.stem_calls)
        current = self.complete(self.generate(variation=True))
        current.pop("stem_separation")
        self.service._write_job(current)
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        self.assertEqual(list(self.service._queue.queue), [("stems", current["id"])])
        self.assertEqual(self.service.get_stem_job(legacy["id"])["state"], "not_requested")
        self.assertEqual(self.service.get_stem_job(current["id"])["state"], "queued")

    def test_terminal_automatic_stem_failure_never_retries_and_preserves_mix(self):
        job = self.complete(self.generate())
        for state in ("failed", "unknown"):
            with self.subTest(state=state):
                job["stem_separation"].update(state=state, error="original failure")
                self.service._write_job(job)
                self.service.close()
                self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
                self.assertTrue(self.service._queue.empty())
                self.assertEqual(self.service.create_stem_job(job["id"])["state"], state)
                self.service._run_stem_job(job["id"])
                self.assertFalse(self.client.stem_calls)
                self.assertEqual(self.service.audio_response(self.service._job(job["id"])).path.read_bytes(), b"mock valid audio")

    def test_unknown_never_retries_and_partial_file_is_removed(self):
        details = {"operation": "music_generation", "phase": "awaiting_response", "reason": "timeout", "bytes_received": 0}
        self.client.failure = GenerationError("timeout test-secret-123", "unknown", diagnostics=details)
        first = self.generate()
        self.service._run_job(first["id"])
        result = self.service._job(first["id"])
        self.assertEqual(result["state"], "unknown")
        self.assertEqual(result["failure_details"], details)
        self.assertNotIn("stem_separation", result)
        self.assertNotIn("test-secret", result["error"])
        self.assertFalse((self.service.root / "jobs" / first["id"] / "audio.tmp").exists())
        self.assertEqual(self.generate()["id"], first["id"])
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(self.generate(variation=True)["attempt_count"], 2)

    def test_invalid_audio_is_not_complete_or_available(self):
        job = self.generate()
        with mock.patch("elevenlabs_service.validate_audio", side_effect=GenerationError("decode failed")):
            self.service._run_job(job["id"])
        result = self.service._job(job["id"])
        self.assertEqual(result["state"], "failed")
        self.assertIsNone(result["audio"])
        self.assertNotIn("stem_separation", result)
        status, _ = self.service.dispatch("GET", f"/api/elevenlabs/generations/{job['id']}/audio")
        self.assertEqual(status, 409)

    def test_restart_marks_transmitting_unknown_and_restores_complete(self):
        completed = self.complete(self.generate())
        self.complete_stems(completed)
        uncertain = self.generate(variation=True)
        uncertain["state"] = "generating"
        self.service._write_job(uncertain)
        abandoned = self.service.root / "jobs" / uncertain["id"] / "audio.tmp"
        abandoned.write_bytes(b"partial")
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        self.assertEqual(self.service._job(uncertain["id"])["state"], "unknown")
        self.assertEqual(self.service._job(completed["id"])["state"], "complete")
        self.assertFalse(abandoned.exists())
        self.assertEqual(self.service.audio_response(self.service._job(completed["id"])).path.read_bytes(), b"mock valid audio")
        self.assertEqual(len(self.client.calls), 1)

    def test_storage_lock_prevents_second_service_recovery(self):
        job = self.generate()
        job["state"] = "generating"
        self.service._write_job(job)
        temporary = self.service.root / "jobs" / job["id"] / "audio.tmp"
        temporary.write_bytes(b"inflight")
        with self.assertRaisesRegex(RuntimeError, "Another dashboard"):
            ElevenLabsService(self.service.root, self.env, start_worker=False)
        self.assertEqual(self.service._job(job["id"])["state"], "generating")
        self.assertTrue(temporary.exists())

    def test_missing_cached_audio_requires_explicit_variation(self):
        job = self.complete(self.generate())
        self.complete_stems(job)
        self.service.audio_response(job).path.unlink()
        result = self.generate()
        self.assertEqual(result["id"], job["id"])
        self.assertEqual(result["state"], "failed")
        self.assertIn("missing", result["error"])
        self.assertNotIn("audio_url", result)
        self.assertEqual(len(self.client.calls), 1)
        self.assertNotEqual(self.generate(variation=True)["id"], job["id"])

    def test_exports_exact_request_features_manifest_and_audio(self):
        job = self.complete(self.generate())
        status, result = self.service.dispatch("GET", f"/api/elevenlabs/generations/{job['id']}/export")
        self.assertEqual(status, 200)
        self.assertIsInstance(result, FileResponse)
        with zipfile.ZipFile(result.path) as archive:
            self.assertEqual(set(archive.namelist()), {"request.json", "features.json", "manifest.json", "audio.mp3", "stems/manifest.json"})
            self.assertEqual(json.loads(archive.read("stems/manifest.json"))["state"], "queued")
            self.assertEqual(json.loads(archive.read("request.json")), self.plan["request"])
            self.assertEqual(json.loads(archive.read("features.json"))["sections"], self.plan["sections"])
            self.assertEqual(json.loads(archive.read("manifest.json"))["measured_duration_seconds"], 10)
            for name in archive.namelist():
                self.assertNotIn(b"test-secret-123", archive.read(name))
        status, result = self.service.dispatch("GET", f"/api/elevenlabs/plans/{self.plan['id']}/export")
        with zipfile.ZipFile(result.path) as archive:
            self.assertEqual(len(archive.namelist()), 3)

    def test_blocked_plan_cannot_submit(self):
        plan = example_plan()
        plan.update(can_generate=False, blocking_reasons=["Section coverage below 90%"])
        stored = self.service._save("plans", plan)
        status, body = self.service.dispatch("POST", "/api/elevenlabs/generations", {"plan_id": stored["id"]})
        self.assertEqual(status, 400)
        self.assertIn("coverage", body["error"])
        self.assertEqual(self.service.jobs(), [])

    def test_invalid_paths_and_body_are_rejected(self):
        for path in ("/api/elevenlabs/plans/../secret", "/api/elevenlabs/plans/not-an-id", "/bad"):
            status, _ = self.service.dispatch("GET", path)
            self.assertEqual(status, 404)
        status, _ = self.service.dispatch("POST", "/api/elevenlabs/datasets", [])
        self.assertEqual(status, 400)
        status, _ = self.service.dispatch("POST", "/api/elevenlabs/datasets", {"filename": "data.csv", "content": "a" * (MAX_UPLOAD_BYTES + 1)})
        self.assertEqual(status, 413)

    def test_jobs_filter_by_plan(self):
        first = self.generate()
        status, body = self.service.dispatch("GET", "/api/elevenlabs/generations?plan_id=" + first["plan_id"])
        self.assertEqual(status, 200)
        self.assertEqual(len(body["jobs"]), 1)
        _, body = self.service.dispatch("GET", "/api/elevenlabs/generations?plan_id=unrelated")
        self.assertEqual(body["jobs"], [])

    def test_original_track_uses_direction_without_dataset_or_analysis(self):
        settings = {"style": "spacious acoustic jazz", "bpm": 84, "key": "F minor",
                    "instrument_palette": ["piano", "upright bass"], "negative_styles": ["distortion"],
                    "enable_variability": True, "context_adherence": "medium", "seed": 123}
        for duration in (20, 40, 60):
            status, plan = self.service.dispatch("POST", "/api/elevenlabs/plans", {
                "kind": "original", "duration_seconds": duration, "settings": settings,
            })
            self.assertEqual(status, 201, plan)
            self.assertEqual(plan["origin"], "original")
            self.assertIsNone(plan["dataset_id"])
            self.assertIsNone(plan["analysis_id"])
            self.assertIsNone(plan["dataset_hash"])
            self.assertEqual(plan["baseline"], {})
            self.assertEqual(plan["settings"], settings)
            self.assertEqual(plan["duration_seconds"], duration)
            self.assertEqual(len(plan["request"]["composition_plan"]["chunks"]), 1)
            chunk = plan["request"]["composition_plan"]["chunks"][0]
            self.assertEqual(chunk["duration_ms"], duration * 1000)
            self.assertEqual(chunk["text"], "")
            self.assertEqual(chunk["context_adherence"], "medium")
            for direction in ("spacious acoustic jazz", "instrumental music", "84 BPM", "F minor", "piano", "upright bass"):
                self.assertIn(direction, chunk["positive_styles"])
            self.assertEqual(chunk["negative_styles"], ["vocals", "lyrics", "distortion"])
            self.assertEqual(plan["request"]["seed"], 123)
            self.assertTrue(plan["request"]["store_for_inpainting"])
            self.assertIsNone(plan["sections"][0]["source_start"])
            for observation in ("activity", "variability", "coverage", "bands"):
                self.assertNotIn(observation, plan["sections"][0])
        self.assertEqual(list((self.service.root / "datasets").iterdir()), [])
        self.assertEqual(list((self.service.root / "analyses").iterdir()), [])
        self.assertEqual(self.service.jobs(), [])
        self.assertEqual(self.client.calls, [])

    def test_original_track_rejects_invalid_settings_and_durations_before_saving(self):
        initial_plans = len(self.service.plans())
        for duration in (True, 0, 10, 20.0, "20", 80, None):
            status, _ = self.service.dispatch("POST", "/api/elevenlabs/plans", {
                "kind": "original", "duration_seconds": duration,
            })
            self.assertEqual(status, 400, duration)
        for settings in (None, [], {"style": ""}, {"style": "x" * 301}, {"key": "x\ny"},
                         {"bpm": True}, {"bpm": float("nan")}, {"bpm": 301},
                         {"instrument_palette": "piano"}, {"instrument_palette": [""]},
                         {"negative_styles": ["x"] * 21}, {"seed": False}, {"seed": -1},
                         {"context_adherence": "arbitrary"}, {"enable_variability": 1},
                         {"request": {"model_id": "other"}}):
            status, _ = self.service.dispatch("POST", "/api/elevenlabs/plans", {
                "kind": "original", "settings": settings,
            })
            self.assertEqual(status, 400, settings)
        status, _ = self.service.dispatch("POST", "/api/elevenlabs/plans", {
            "kind": "original", "request": self.plan["request"],
        })
        self.assertEqual(status, 400)
        self.assertEqual(len(self.service.plans()), initial_plans)
        self.assertEqual(self.service.jobs(), [])
        self.assertEqual(self.client.calls, [])

    def test_original_track_restores_lists_and_exports_without_source_records(self):
        plan = self.service.create_plan({"kind": "original", "duration_seconds": 40})
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        status, restored = self.service.dispatch("GET", "/api/elevenlabs/plans/" + plan["id"])
        self.assertEqual(status, 200)
        self.assertEqual(restored, plan)
        status, listed = self.service.dispatch("GET", "/api/elevenlabs/plans")
        self.assertEqual(status, 200)
        self.assertIn(plan, listed["plans"])
        status, exported = self.service.dispatch("GET", "/api/elevenlabs/plans/" + plan["id"] + "/export")
        self.assertEqual(status, 200)
        with zipfile.ZipFile(exported.path) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            features = json.loads(archive.read("features.json"))
            self.assertEqual(manifest["origin"], "original")
            self.assertIsNone(manifest["dataset_id"])
            self.assertIsNone(manifest["analysis_id"])
            self.assertEqual(manifest["analysis_settings"], {"kind": "original", "channels": []})
            self.assertEqual(features["baseline"], {})
            self.assertNotIn("activity", features["sections"][0])
            self.assertEqual(json.loads(archive.read("request.json")), plan["request"])
        self.assertEqual(self.client.calls, [])

    def test_equivalent_original_tracks_reuse_audio_and_automatic_stems(self):
        plan = self.service.create_plan({"kind": "original"})
        same = self.service.create_plan({"kind": "original", "duration_seconds": 20,
                                         "settings": {**plan["settings"], "bpm": 100.0, "seed": None}})
        self.assertEqual(plan["cache_key"], same["cache_key"])
        first = self.service.create_generation({"plan_id": plan["id"]})
        repeated = self.service.create_generation({"plan_id": same["id"]})
        self.assertEqual(first["id"], repeated["id"])
        self.assertTrue(first["separate_stems"])
        self.assertEqual(self.client.calls, [])
        completed = self.complete(first)
        self.assertEqual(completed["stem_separation"]["state"], "queued")
        completed = self.complete_stems(completed)
        reused = self.service.create_generation({"plan_id": same["id"]})
        self.assertEqual(completed["id"], reused["id"])
        self.assertEqual(len(reused["stem_separation"]["stems"]), 6)
        self.assertEqual(self.client.calls, [plan["request"]])
        self.assertEqual(len(self.client.stem_calls), 1)
        exported = self.service.export(plan, completed)
        with zipfile.ZipFile(exported.path) as archive:
            self.assertEqual(json.loads(archive.read("manifest.json"))["origin"], "original")
            self.assertEqual(archive.read("audio.mp3"), b"mock valid audio")
            self.assertIn("stems/drums.mp3", archive.namelist())
        changed = self.service.create_plan({"kind": "original", "settings": {"bpm": 90}})
        self.assertNotEqual(plan["cache_key"], changed["cache_key"])

    def test_prompt_track_history_and_export_retain_truthful_provenance(self):
        plan = self.service.create_plan({"kind": "original"})
        job = self.service.create_continuation_job({
            "kind": "prompt", "plan_id": plan["id"], "source_job_id": None,
            "session_id": "prompt_export", "sequence": 0, "duration_seconds": 20,
            "settings": {"style": "slow piano and strings", "bpm": 72},
        })
        completed = self.complete_stems(self.complete(job))
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        status, history = self.service.dispatch("GET", "/api/elevenlabs/generations")
        self.assertEqual(status, 200)
        saved = next(item for item in history["jobs"] if item["id"] == job["id"])
        self.assertEqual(saved["realtime"]["kind"], "prompt_continuation")
        self.assertEqual(saved["stem_separation"]["state"], "complete")
        prompt_plan = self.service._read("plans", job["plan_id"])
        exported = self.service.export(prompt_plan, saved)
        with zipfile.ZipFile(exported.path) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            features = json.loads(archive.read("features.json"))
            self.assertEqual(manifest["origin"], "prompt_continuation")
            self.assertEqual(manifest["realtime"]["generation_settings"]["style"], "slow piano and strings")
            self.assertIsNone(manifest["dataset_id"])
            self.assertIsNone(manifest["analysis_id"])
            self.assertIsNone(manifest["dataset_hash"])
            self.assertNotIn("observed_features", manifest["realtime"])
            self.assertNotIn("activity", features["sections"][0])
            self.assertEqual(features["baseline"], {})
            self.assertEqual(json.loads(archive.read("request.json")), prompt_plan["request"])
            self.assertIn("stems/drums.mp3", archive.namelist())
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(len(self.client.stem_calls), 1)

    def test_browser_numeric_roundtrip_and_old_cache_migration_reuse_audio(self):
        dataset = self.service.create_dataset({"synthetic": True})
        analysis = self.service.create_analysis({"dataset_id": dataset["id"], "settings": dataset["defaults"]})
        plan = self.service.create_plan({"analysis_id": analysis["id"], "settings": {}})
        job = self.service.create_generation({"plan_id": plan["id"]})
        self.complete(job)
        # Reproduce a pre-v2 saved plan/job: default flag omitted and old hash.
        legacy = copy.deepcopy(plan)
        for channel in legacy["analysis_settings"]["channels"]:
            channel.pop("change_based", None)
        legacy.pop("cache_key_version", None)
        legacy["cache_key"] = digest({"old_settings": legacy["analysis_settings"]})
        stored_plan = self.service.root / "plans" / (plan["id"] + ".json")
        atomic_json(stored_plan, legacy)
        legacy_job = self.service._job(job["id"])
        legacy_job["cache_key"] = legacy["cache_key"]
        legacy_job.pop("cache_key_version", None)
        self.service._write_job(legacy_job)
        original_plan_bytes = stored_plan.read_bytes()
        saved_request = self.service.root / "jobs" / job["id"] / "request.json"
        original_request_bytes = saved_request.read_bytes()
        # JSON.stringify serializes integral JS numbers without Python's '.0'.
        browser_json = re.sub(r"(-?\d+)\.0([,}\]])", r"\1\2", canonical_json(legacy["analysis_settings"]))
        browser_settings = json.loads(browser_json)
        for channel in browser_settings["channels"]:
            channel["change_based"] = False
            channel["selected"] = True
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        rebuilt_analysis = self.service.create_analysis({"dataset_id": dataset["id"], "settings": browser_settings})
        rebuilt_plan = self.service.create_plan({"analysis_id": rebuilt_analysis["id"], "settings": plan["settings"]})
        restored_plan = self.service._read("plans", plan["id"])
        self.assertEqual(restored_plan["cache_key"], rebuilt_plan["cache_key"])
        reused = self.service.create_generation({"plan_id": rebuilt_plan["id"]})
        self.assertEqual(reused["id"], job["id"])
        self.assertEqual(reused["state"], "complete")
        self.assertEqual(reused["cache_key_version"], CACHE_KEY_VERSION)
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(stored_plan.read_bytes(), original_plan_bytes)
        self.assertEqual(saved_request.read_bytes(), original_request_bytes)

    def test_real_pipeline_without_provider_call(self):
        status, dataset = self.service.dispatch("POST", "/api/elevenlabs/datasets", {"synthetic": True})
        self.assertEqual(status, 201, dataset)
        self.assertNotIn("rows", dataset)
        status, analysis = self.service.dispatch("POST", "/api/elevenlabs/analyses", {"dataset_id": dataset["id"], "settings": dataset["defaults"]})
        self.assertEqual(status, 201, analysis)
        self.assertTrue(analysis["can_generate"], analysis)
        status, plan = self.service.dispatch("POST", "/api/elevenlabs/plans", {"analysis_id": analysis["id"], "settings": {}})
        self.assertEqual(status, 201, plan)
        self.assertEqual(len(plan["request"]["composition_plan"]["chunks"]), 6)
        self.assertEqual(len(self.client.calls), 0)
        status, same = self.service.dispatch("POST", "/api/elevenlabs/plans", {"analysis_id": analysis["id"], "settings": {}})
        self.assertNotEqual(plan["id"], same["id"])
        self.assertEqual(plan["cache_key"], same["cache_key"])
        edited = copy.deepcopy(plan["request"])
        edited["composition_plan"]["chunks"][0]["positive_styles"] = ["instrumental piano music"]
        status, revision = self.service.dispatch("POST", "/api/elevenlabs/plans", {"analysis_id": analysis["id"], "settings": {}, "request": edited})
        self.assertEqual(status, 201, revision)
        self.assertNotEqual(plan["cache_key"], revision["cache_key"])
        self.assertTrue(revision["manual_edits"])
        self.assertEqual(self.service._read("plans", plan["id"])["request"], plan["request"])
        edited["composition_plan"]["chunks"][0]["duration_ms"] = 9000
        status, _ = self.service.dispatch("POST", "/api/elevenlabs/plans", {"analysis_id": analysis["id"], "request": edited})
        self.assertEqual(status, 400)


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.output = Path(self.directory.name) / "audio.tmp"
        self.client = ElevenLabsClient("do-not-leak", 30)

    def tearDown(self):
        self.directory.cleanup()

    @staticmethod
    def response(data, content_type="audio/mpeg"):
        response = io.BytesIO(data)
        response.headers = Message()
        response.headers["Content-Type"] = content_type
        response.headers["song-id"] = "safe-song-id"
        return response

    def test_http_success_sends_only_plan_and_preserves_bytes(self):
        opener = mock.Mock()
        opener.open.return_value = self.response(b"sample-audio")
        with mock.patch("elevenlabs_service.request.build_opener", return_value=opener):
            result = self.client.generate(example_plan()["request"], self.output)
        outgoing = opener.open.call_args.args[0]
        self.assertEqual(outgoing.full_url, PROVIDER_URL)
        self.assertEqual(outgoing.get_header("Xi-api-key"), "do-not-leak")
        self.assertEqual(json.loads(outgoing.data), example_plan()["request"])
        self.assertEqual(self.output.read_bytes(), b"sample-audio")
        self.assertEqual(result["provider_song_id"], "safe-song-id")
        self.assertNotIn("do-not-leak", canonical_json(result))

    def test_non_audio_and_empty_response_fail(self):
        for body, content_type in [(b'{"error":"do-not-leak"}', "application/json"), (b"", "audio/mpeg")]:
            self.output.unlink(missing_ok=True)
            opener = mock.Mock()
            opener.open.return_value = self.response(body, content_type)
            with mock.patch("elevenlabs_service.request.build_opener", return_value=opener):
                with self.assertRaises(GenerationError) as caught:
                    self.client.generate(example_plan()["request"], self.output)
            self.assertEqual(caught.exception.state, "failed")
            self.assertNotIn("do-not-leak", str(caught.exception))

    def test_truncated_http_response_is_unknown_even_if_bytes_look_like_audio(self):
        response = self.response(b"partial-audio")
        response.headers["Content-Length"] = "200"
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch("elevenlabs_service.request.build_opener", return_value=opener):
            with self.assertRaises(GenerationError) as caught:
                self.client.generate(example_plan()["request"], self.output)
        self.assertEqual(caught.exception.state, "unknown")
        self.assertEqual(opener.open.call_count, 1)
        self.assertEqual(caught.exception.diagnostics["reason"], "incomplete_response")
        self.assertEqual(caught.exception.diagnostics["bytes_received"], len(b"partial-audio"))

    def test_slow_response_has_total_deadline_and_no_second_submission(self):
        # A continuously trickling response never hits a socket idle timeout.
        # A real urllib response must still stop at the total request deadline.
        calls = []
        class SlowResponse(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                calls.append(self.path)
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", "40")
                self.send_header("request-id", "safe-request-123")
                self.end_headers()
                try:
                    for _ in range(40):
                        self.wfile.write(b"x")
                        self.wfile.flush()
                        time.sleep(.03)
                except (BrokenPipeError, ConnectionResetError):
                    pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), SlowResponse)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.client.timeout = .18
        started = time.monotonic()
        try:
            with mock.patch("elevenlabs_service.PROVIDER_URL", f"http://127.0.0.1:{server.server_port}/music"):
                with self.assertRaises(GenerationError) as caught:
                    self.client.generate(example_plan()["request"], self.output)
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, .7, "read(64 KiB) must not wait for the entire trickle")
            self.assertEqual(calls, ["/music"])
            self.assertEqual(caught.exception.state, "unknown")
            self.assertEqual(caught.exception.diagnostics["phase"], "downloading")
            self.assertEqual(caught.exception.diagnostics["reason"], "timeout")
            self.assertEqual(caught.exception.diagnostics["provider_request_id"], "safe-request-123")
            self.assertGreater(caught.exception.diagnostics["bytes_received"], 0)
            self.assertLess(caught.exception.diagnostics["bytes_received"], 40)
            self.assertNotIn("do-not-leak", canonical_json(caught.exception.diagnostics))
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_stem_timeout_identifies_stage_and_retains_safe_diagnostics(self):
        source = self.output.with_name("saved.mp3")
        source.write_bytes(b"saved music")
        opener = mock.Mock()
        opener.open.side_effect = TimeoutError("private details do-not-leak")
        with mock.patch("elevenlabs_service.request.build_opener", return_value=opener):
            with self.assertRaises(GenerationError) as caught:
                self.client.separate_stems(source, self.output, "six_stems_v1")
        self.assertEqual(opener.open.call_count, 1)
        self.assertEqual(caught.exception.state, "unknown")
        self.assertIn("Stem separation timed out", str(caught.exception))
        self.assertIn("full mix is saved", str(caught.exception))
        self.assertEqual(caught.exception.diagnostics["operation"], "stem_separation")
        self.assertEqual(caught.exception.diagnostics["phase"], "awaiting_response")
        self.assertEqual(caught.exception.diagnostics["bytes_received"], 0)
        self.assertNotIn("do-not-leak", str(caught.exception))

    def test_known_connect_failures_are_unsent_without_retry(self):
        for reason in (socket.gaierror("private do-not-leak"), ConnectionRefusedError("private do-not-leak")):
            opener = mock.Mock()
            opener.open.side_effect = error.URLError(reason)
            with mock.patch("elevenlabs_service.request.build_opener", return_value=opener):
                with self.assertRaises(GenerationError) as caught:
                    self.client.generate(example_plan()["request"], self.output)
            self.assertEqual(opener.open.call_count, 1)
            self.assertEqual(caught.exception.state, "failed")
            self.assertIn("request was not sent", str(caught.exception))
            self.assertNotIn("do-not-leak", str(caught.exception))

    def test_provider_rejections_and_ambiguous_errors_do_not_retry(self):
        for failure, state in [
            (error.HTTPError(PROVIDER_URL, 401, "do-not-leak", {}, io.BytesIO(b"do-not-leak")), "failed"),
            (error.HTTPError(PROVIDER_URL, 503, "do-not-leak", {}, io.BytesIO(b"do-not-leak")), "unknown"),
            (error.URLError("do-not-leak"), "unknown"),
            (TimeoutError("do-not-leak"), "unknown"),
        ]:
            opener = mock.Mock()
            opener.open.side_effect = failure
            with mock.patch("elevenlabs_service.request.build_opener", return_value=opener):
                with self.assertRaises(GenerationError) as caught:
                    self.client.generate(example_plan()["request"], self.output)
            self.assertEqual(caught.exception.state, state)
            self.assertNotIn("do-not-leak", str(caught.exception))
            self.assertEqual(opener.open.call_count, 1)

    def test_api_key_id_rejection_explains_secret_without_exposing_provider_details(self):
        for status in (400, 401):
            body = json.dumps({"detail": {"status": "api_key_id_used_as_api_key",
                                          "message": "Echoed key do-not-leak and private prompt"}}).encode()
            failure = error.HTTPError(PROVIDER_URL, status, "do-not-leak", {}, io.BytesIO(body))
            opener = mock.Mock()
            opener.open.side_effect = failure
            with mock.patch("elevenlabs_service.request.build_opener", return_value=opener):
                with self.assertRaises(GenerationError) as caught:
                    self.client.generate(example_plan()["request"], self.output)
            self.assertEqual(caught.exception.state, "failed")
            self.assertIn("API key ID instead of the secret API key", str(caught.exception))
            self.assertIn("restart the dashboard", str(caught.exception))
            self.assertNotIn("do-not-leak", str(caught.exception))
            self.assertNotIn("private prompt", str(caught.exception))
            self.assertEqual(opener.open.call_count, 1)
            self.assertFalse(self.output.exists())
            self.assertTrue(failure.fp.closed)

    def test_unrecognized_or_malformed_error_details_keep_safe_http_message(self):
        bodies = [b"do-not-leak", b"[]", b'{"detail": "do-not-leak"}',
                  b'{"detail": {"status": ["do-not-leak"], "message": "private prompt"}}',
                  b'{"detail": {"status": "do-not-leak", "message": "private prompt"}}',
                  b" " * (64 * 1024) + b'{"detail": {"status": "api_key_id_used_as_api_key"}}']
        for body in bodies:
            failure = error.HTTPError(PROVIDER_URL, 400, "do-not-leak", {}, io.BytesIO(body))
            opener = mock.Mock()
            opener.open.side_effect = failure
            with mock.patch("elevenlabs_service.request.build_opener", return_value=opener):
                with self.assertRaises(GenerationError) as caught:
                    self.client.generate(example_plan()["request"], self.output)
            self.assertEqual(str(caught.exception), "ElevenLabs returned HTTP 400.")
            self.assertEqual(caught.exception.state, "failed")
            self.assertTrue(failure.fp.closed)
            self.assertEqual(opener.open.call_count, 1)

    def test_certificate_verification_failure_is_known_unsent_setup_failure(self):
        for failure in [ssl.SSLCertVerificationError("untrusted certificate"), error.URLError(ssl.SSLCertVerificationError("untrusted certificate"))]:
            opener = mock.Mock()
            opener.open.side_effect = failure
            with mock.patch("elevenlabs_service.request.build_opener", return_value=opener):
                with self.assertRaises(GenerationError) as caught:
                    self.client.generate(example_plan()["request"], self.output)
            self.assertEqual(caught.exception.state, "failed")
            self.assertIn("request was not sent", str(caught.exception))
            self.assertEqual(opener.open.call_count, 1)

    def test_system_ca_fallback_is_only_used_for_empty_default_store(self):
        context = mock.Mock()
        context.cert_store_stats.return_value = {"x509_ca": 0}
        with mock.patch("elevenlabs_service.ssl.create_default_context", return_value=context), mock.patch("elevenlabs_service.Path.is_file", return_value=True):
            self.assertIs(create_tls_context(), context)
        context.load_verify_locations.assert_called_once_with(cafile="/etc/ssl/cert.pem")
        context.reset_mock()
        context.cert_store_stats.return_value = {"x509_ca": 100}
        with mock.patch("elevenlabs_service.ssl.create_default_context", return_value=context):
            create_tls_context()
        context.load_verify_locations.assert_not_called()

    def test_tls_context_keeps_certificate_and_hostname_verification_enabled(self):
        context = create_tls_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)

    def test_decode_checks_duration_warning_and_rejects_truncated_audio(self):
        probe = subprocess.CompletedProcess([], 0, json.dumps({"format": {"duration": "11", "format_name": "mp3"}, "streams": [{"codec_type": "audio"}]}).encode(), b"")
        decode = subprocess.CompletedProcess([], 0, b"", b"")
        with mock.patch("elevenlabs_service.subprocess.run", side_effect=[probe, decode]) as run:
            metadata = validate_audio(self.output, 10, "/ffmpeg", "/ffprobe")
        self.assertEqual(metadata["extension"], "mp3")
        self.assertIn("11.00s", metadata["timing_warning"])
        self.assertIn("-xerror", run.call_args.args[0])
        decode.returncode = 1
        with mock.patch("elevenlabs_service.subprocess.run", side_effect=[probe, decode]):
            with self.assertRaises(GenerationError):
                validate_audio(self.output, 10, "/ffmpeg", "/ffprobe")

    def test_uploaded_decode_rejects_video_and_checks_reported_and_decoded_duration(self):
        probe_body = {"format": {"duration": "11", "format_name": "wav"}, "streams": [{"codec_type": "audio", "channels": 2}]}
        def probe():
            return subprocess.CompletedProcess([], 0, json.dumps(probe_body).encode(), b"")
        decode = subprocess.CompletedProcess([], 0, b"out_time_us=11000000\nprogress=end\n", b"")
        with mock.patch("elevenlabs_service.subprocess.run", side_effect=[probe(), decode]) as run:
            metadata = validate_audio(self.output, 60, "/ffmpeg", "/ffprobe", uploaded=True)
        self.assertIsNone(metadata["requested_duration_seconds"])
        self.assertIsNone(metadata["timing_warning"])
        for call in run.call_args_list:
            command = call.args[0]
            self.assertEqual(command[command.index("-protocol_whitelist") + 1], "file,pipe")
            self.assertNotIn("hls", command[command.index("-format_whitelist") + 1])
        probe_body["streams"].append({"codec_type": "video"})
        with mock.patch("elevenlabs_service.subprocess.run", return_value=probe()) as run:
            with self.assertRaises(GenerationError):
                validate_audio(self.output, 60, "/ffmpeg", "/ffprobe", uploaded=True)
            run.assert_called_once()
        probe_body["streams"][-1]["disposition"] = {"attached_pic": 1}
        with mock.patch("elevenlabs_service.subprocess.run", side_effect=[probe(), decode]):
            self.assertEqual(validate_audio(self.output, 60, "/ffmpeg", "/ffprobe", uploaded=True)["extension"], "wav")
        probe_body["streams"].pop()
        probe_body["streams"][0]["channels"] = 6
        with mock.patch("elevenlabs_service.subprocess.run", return_value=probe()) as run:
            with self.assertRaisesRegex(ServiceError, "mono or stereo"):
                validate_audio(self.output, 60, "/ffmpeg", "/ffprobe", uploaded=True)
            run.assert_called_once()
        probe_body["streams"][0]["channels"] = 2
        probe_body["format"]["duration"] = "7200"
        decode.stdout = b"out_time_us=7200000000\nprogress=end\n"
        with mock.patch("elevenlabs_service.subprocess.run", side_effect=[probe(), decode]) as run:
            metadata = validate_audio(self.output, 0, "/ffmpeg", "/ffprobe", uploaded=True)
        self.assertEqual(metadata["duration_seconds"], 7200)
        self.assertNotIn("-t", run.call_args.args[0], "Long uploads must not be silently trimmed")
        self.assertEqual(run.call_args.kwargs["timeout"], 1200)
        probe_body["format"]["duration"] = "11"
        decode.stdout = b"out_time_us=60010000\nprogress=end\n"
        with mock.patch("elevenlabs_service.subprocess.run", side_effect=[probe(), decode]):
            metadata = validate_audio(self.output, 0, "/ffmpeg", "/ffprobe", uploaded=True)
        self.assertEqual(metadata["duration_seconds"], 60.01, "Decoded length takes precedence over stale container metadata")

    def test_environment_is_narrow_non_executable_and_values_are_not_exposed(self):
        env = Path(self.directory.name) / ".env"
        env.write_text("UNRELATED_SECRET=ignored\nexport ELEVENLABS_API_KEY='literal-$(pwd)'\nELEVENLABS_TIMEOUT_SECONDS=45 # value\n", encoding="utf-8")
        with mock.patch.dict(os.environ, {}, clear=True):
            key, timeout, issues = load_configuration(env)
        self.assertEqual(key, "literal-$(pwd)")
        self.assertEqual(timeout, 45)
        self.assertEqual(issues, [])
        with mock.patch.dict(os.environ, {"ELEVENLABS_TIMEOUT_SECONDS": "nan"}, clear=True):
            _, timeout, issues = load_configuration(env)
        self.assertEqual(timeout, 300)
        self.assertTrue(issues)


class ActualMediaTests(unittest.TestCase):
    @staticmethod
    def tools():
        local_bin = Path(__file__).resolve().parent.parent / "var" / "bin"
        return tuple(shutil.which(name) or str(local_bin / name) for name in ("ffmpeg", "ffprobe"))

    def test_custom_upload_real_decode_formats_provenance_and_invalid_media_cleanup(self):
        ffmpeg, ffprobe = self.tools()
        if not all(Path(tool).is_file() for tool in (ffmpeg, ffprobe)):
            self.skipTest("FFmpeg tools are not installed")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / "source.wav"
            with wave.open(str(original), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(16000)
                output.writeframes(b"\x00\x00" * 16000)
            client = FakeClient()
            service = ElevenLabsService(root / "storage", root / ".env", client=client, start_worker=False)
            service.ffmpeg, service.ffprobe = ffmpeg, ffprobe
            try:
                for index, extension in enumerate(("wav", "mp3", "flac", "ogg", "m4a", "aac")):
                    source = original
                    if extension != "wav":
                        source = root / ("source." + extension)
                        converted = subprocess.run([ffmpeg, "-v", "error", "-i", str(original), str(source)], capture_output=True)
                        self.assertEqual(converted.returncode, 0, converted.stderr.decode())
                    content = source.read_bytes()
                    # The true container wins over untrusted filename extensions.
                    job = service.create_upload(content, f"../../My track {index}.wrong", f"{index + 1:032x}")
                    self.assertEqual(job["audio"]["extension"], extension)
                    self.assertAlmostEqual(job["audio"]["duration_seconds"], 1, delta=0.1)
                    self.assertEqual(service.audio_response(job).path.read_bytes(), content)
                    self.assertEqual(job["source"]["size_bytes"], len(content))
                    self.assertEqual(job["name"], f"My track {index}")
                    self.assertIsNone(job["requested_duration_seconds"])
                video = root / "video.mp4"
                encoded = subprocess.run([ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=1",
                                          "-i", str(original), "-c:v", "mpeg4", "-shortest", str(video)], capture_output=True)
                self.assertEqual(encoded.returncode, 0, encoded.stderr.decode())
                for content in (b"not audio", original.read_bytes()[:-1001], video.read_bytes(),
                                b"#EXTM3U\nhttp://127.0.0.1:9/secret.wav\n"):
                    with self.assertRaises(ServiceError):
                        service.create_upload(content, "invalid.wav", "d" * 32)
                self.assertEqual(len(service.jobs()), 6)
                self.assertEqual(list(service.root.glob("upload.tmp-*")), [])
                self.assertEqual(client.calls + client.stem_calls, [])
                self.assertTrue(service._queue.empty())
            finally:
                service.close()

    def test_long_upload_and_stream_windows_preserve_full_audio_and_stem_timeline(self):
        ffmpeg, ffprobe = self.tools()
        if not all(Path(tool).is_file() for tool in (ffmpeg, ffprobe)):
            self.skipTest("FFmpeg tools are not installed")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / "Long song.wav"
            with wave.open(str(original), "wb") as output:
                output.setnchannels(2)
                output.setsampwidth(2)
                output.setframerate(16000)
                for second in range(75):
                    output.writeframes(struct.pack("<hh", second * 53, -second * 53) * 16000)
                output.writeframes(struct.pack("<hh", 75 * 53, -75 * 53) * 4000)
            client = FakeClient()
            service = ElevenLabsService(root / "storage", root / ".env", client=client, start_worker=False)
            service.ffmpeg, service.ffprobe = ffmpeg, ffprobe
            try:
                job = service.create_upload(original.read_bytes(), original.name, "e" * 32)
                self.assertAlmostEqual(job["audio"]["duration_seconds"], 75.25, places=3)
                self.assertEqual(service.audio_response(job).path.read_bytes(), original.read_bytes())
                self.assertIsNone(service.status()["max_custom_audio_seconds"])
                plan = service._read("plans", job["plan_id"])
                validate_uploaded_plan(plan)
                # A saved separated layer shares the exact original timeline.
                stem_dir = service.root / "jobs" / job["id"] / "stems"
                stem_dir.mkdir()
                shutil.copyfile(original, stem_dir / "drums.wav")
                job["stem_separation"] = {"state": "complete", "stems": [{
                    "id": "drums", "filename": "drums.wav", "content_type": "audio/wav",
                    "size_bytes": original.stat().st_size, "duration_seconds": 75.25,
                }]}
                service._write_job(job)
                for route in (job["audio_url"], job["audio_url"].rsplit("/audio", 1)[0] + "/stems/drums/audio"):
                    for start, expected_frames in ((10, 160000), (70, 84000)):
                        status, result = service.dispatch("GET", f"{route}?start={start}&duration=10&sample_rate=16000")
                        self.assertEqual(status, 200, result)
                        self.assertTrue(result.temporary)
                        with wave.open(str(result.path), "rb") as window:
                            self.assertEqual(window.getnframes(), expected_frames)
                            self.assertEqual(window.getframerate(), 16000)
                            self.assertEqual(window.getnchannels(), 2)
                            self.assertEqual(struct.unpack("<hh", window.readframes(1)), (start * 53, -start * 53))
                        result.path.unlink()
                        result.on_close()
                # Independent whole-file resampling is the reference at a
                # window seam, including a waveform change exactly at10s.
                reference = root / "resampled.wav"
                converted = subprocess.run([ffmpeg, "-v", "error", "-i", str(original), "-ar", "48000",
                                            "-ac", "2", "-c:a", "pcm_s16le", str(reference)], capture_output=True)
                self.assertEqual(converted.returncode, 0, converted.stderr.decode())
                for start in (0, 10, 70):
                    status, result = service.dispatch("GET", f"{job['audio_url']}?start={start}&duration=10")
                    self.assertEqual(status, 200, result)
                    with wave.open(str(result.path), "rb") as window, wave.open(str(reference), "rb") as whole:
                        frames = window.getnframes()
                        whole.setpos(start * 48000)
                        self.assertEqual(window.readframes(frames), whole.readframes(frames))
                    result.path.unlink()
                    result.on_close()
                for query, expected in (("start=75.25&duration=10", 416), ("start=-1&duration=10", 400),
                                        ("start=0&duration=31", 400), ("start=nan&duration=10", 400),
                                        ("start=0&duration=10&sample_rate=999999", 400),
                                        ("start=0&start=1&duration=10", 400), ("duration=10", 400)):
                    self.assertEqual(service.dispatch("GET", job["audio_url"] + "?" + query)[0], expected)
                self.assertEqual(list(service.root.glob("audio-window.tmp-*.wav")), [])
                self.assertEqual(client.calls + client.stem_calls, [])
                self.assertTrue(service._queue.empty())
            finally:
                service.close()

    def test_full_decode_and_truncation_with_installed_ffmpeg(self):
        local_bin = Path(__file__).resolve().parent.parent / "var" / "bin"
        ffmpeg = shutil.which("ffmpeg") or str(local_bin / "ffmpeg")
        ffprobe = shutil.which("ffprobe") or str(local_bin / "ffprobe")
        if not Path(ffmpeg).is_file() or not Path(ffprobe).is_file():
            self.skipTest("FFmpeg tools are not installed")
        with tempfile.TemporaryDirectory() as temporary:
            audio = Path(temporary) / "fixture.wav"
            with wave.open(str(audio), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(16000)
                output.writeframes(b"".join(struct.pack("<h", int(10000 * math.sin(index * 2 * math.pi * 440 / 16000))) for index in range(48000)))
            result = validate_audio(audio, 3, ffmpeg, ffprobe)
            self.assertAlmostEqual(result["duration_seconds"], 3, places=2)
            self.assertEqual(result["extension"], "wav")
            self.assertIsNone(result["timing_warning"])
            audio.write_bytes(audio.read_bytes()[:-1001])
            with self.assertRaises(GenerationError):
                validate_audio(audio, 3, ffmpeg, ffprobe)


if __name__ == "__main__":
    unittest.main()
