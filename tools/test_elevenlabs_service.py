#!/usr/bin/env python3
"""Offline service/client tests. No account or paid API calls are used."""

import copy
from email.message import Message
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import ssl
import struct
import subprocess
import tempfile
import threading
import unittest
from unittest import mock
from urllib import error
import zipfile
import wave

from elevenlabs_service import (
    ElevenLabsClient, ElevenLabsService, FileResponse, GenerationError,
    CACHE_KEY_VERSION, MAX_UPLOAD_BYTES, PROVIDER_URL, atomic_json, canonical_json, create_tls_context, digest, load_configuration,
    validate_audio,
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

    def separate_stems(self, source, destination, variation):
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
        self.assertEqual(len(self.client.calls), 0)

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
        self.client.failure = GenerationError("timeout test-secret-123", "unknown")
        first = self.generate()
        self.service._run_job(first["id"])
        result = self.service._job(first["id"])
        self.assertEqual(result["state"], "unknown")
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
