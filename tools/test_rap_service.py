#!/usr/bin/env python3
"""Offline rap queue, persistence and bounded provider tests; no paid calls."""

import base64
from email.message import Message
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock
from urllib import error
import wave

from elevenlabs_service import FileResponse, GenerationError, ServiceError, canonical_json, digest
from rap_service import (
    DEFAULT_VOICE_ID, MAX_ACTIVE_JOBS, MAX_RESPONSE_BYTES, VOICES_CACHE_SECONDS, RapService, RapTTSClient,
    configured_voice, validate_render,
)


class FakeClient:
    def __init__(self, failure=None):
        self.calls = []
        self.failure = failure
        self.voice_calls = 0

    def list_voices(self):
        self.voice_calls += 1
        return {"voices": [{"voice_id": "voice_one", "name": "Voice One"}], "truncated": False}

    def generate_with_timestamps(self, **settings):
        self.calls.append(settings)
        if self.failure:
            raise self.failure
        return b"\x00\x00" * 8000, {"alignment": {"characters": list("hello"),
                "character_start_times_seconds": [0, .1, .2, .3, .4],
                "character_end_times_seconds": [.1, .2, .3, .4, .5]}}


def rendered(*args, **kwargs):
    return b"RIFFtest-wave", {"bars": 1, "duration_seconds": 2,
                              "beats_per_bar": 4, "word_timings": [{"word": "hello", "start": 0, "end": .5}], "warnings": []}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.env = self.root / ".env"
        self.env.write_text("ELEVENLABS_API_KEY=fake-test-secret\n", encoding="utf-8")
        self.environment = mock.patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.client = FakeClient()
        self.service = RapService(self.root / "rap", self.env, client=self.client, start_worker=False)

    def tearDown(self):
        self.service.close()
        self.environment.stop()
        self.directory.cleanup()

    def request(self, **values):
        return {"text": "hello", "bpm": 120, "request_id": "request-test-0001", **values}

    def submit(self, **values):
        status, job = self.service.dispatch("POST", "/api/rap/renders", self.request(**values))
        self.assertEqual(status, 202, job)
        return job

    def complete(self, job):
        with mock.patch("rap_service.render_rap", side_effect=rendered):
            self.service._run_job(job["id"])
        return self.service._job(job["id"])

    def test_status_no_keys_or_optional_dependencies(self):
        status, body = self.service.dispatch("GET", "/api/rap/status")
        self.assertEqual(status, 200)
        self.assertTrue(body["ready"])
        self.assertEqual(body["default_voice_id"], DEFAULT_VOICE_ID)
        self.assertEqual(body["sample_rate"], 16000)
        self.assertNotIn("fake-test-secret", canonical_json(body))
        self.assertNotIn("ffmpeg", canonical_json(body))
        self.assertEqual(self.client.calls, [])

    def test_missing_key_blocks_provider(self):
        self.service._api_key = ""
        status, body = self.service.dispatch("POST", "/api/rap/renders", self.request())
        self.assertEqual(status, 503)
        self.assertIn("ELEVENLABS_API_KEY", body["error"])
        self.assertFalse(self.service.status()["ready"])
        self.assertEqual(self.client.calls, [])

    def test_invalid_inputs_are_rejected_before_charge(self):
        cases = [{"text": None}, {"text": ""}, {"text": "---!"}, {"text": "a" * 2001},
                 {"text": "hi " * 301}, {"text": "hello\x00"}, {"bpm": 39}, {"bpm": 241},
                 {"bpm": True}, {"bpm": "120"}, {"bpm": float("nan")}, {"bpm": float("inf")},
                 {"voice_id": "../voice"}, {"voice_id": 3}, {"voice_id": "secret\nheader"},
                 {"request_id": "short"}, {"request_id": "bad/request"}, {"bars": 0},
                 {"bars": 1.1}, {"bars": True}, {"bars": 65}, {"bars": 64, "bpm": 40}]
        cases += [{"timing_mode": value} for value in (None, "word_grid", "", True, [])]
        cases += [{"source_render_id": value} for value in (None, "../source", "", 123)]
        for case in cases:
            with self.subTest(case=case):
                status, _ = self.service.dispatch("POST", "/api/rap/renders", self.request(**case))
                self.assertEqual(status, 400)
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.service.jobs(), [])

    def test_explicit_render_exact_text_and_ready_audio(self):
        job = self.submit(text="  hello\r\nworld  ", voice_id="voice_custom_123")
        self.assertEqual(job["state"], "queued")
        self.assertEqual(job["text"], "hello\nworld")
        self.assertEqual(job["requested_voice_id"], "voice_custom_123")
        self.assertEqual(self.client.calls, [])
        status, _ = self.service.dispatch("GET", f"/api/rap/renders/{job['id']}/audio")
        self.assertEqual(status, 409)
        complete = self.complete(job)
        self.assertEqual(complete["state"], "complete")
        self.assertEqual(complete["renderer"], "python-natural-phrase-v2")
        self.assertEqual((self.root / "rap" / (job["id"] + ".source.pcm")).read_bytes(), b"\x00\x00" * 8000)
        self.assertEqual(json.loads((self.root / "rap" / (job["id"] + ".alignment.json")).read_text())["alignment"]["characters"], list("hello"))
        self.assertEqual(self.client.calls, [{"text": "hello\nworld", "voice_id": "voice_custom_123"}])
        status, audio = self.service.dispatch("GET", complete["audio_url"])
        self.assertEqual(status, 200)
        self.assertIsInstance(audio, FileResponse)
        self.assertEqual(audio.content_type, "audio/wav")
        self.assertEqual(audio.path.read_bytes(), b"RIFFtest-wave")
        self.assertEqual(self.service.dispatch("GET", f"/api/rap/renders/{job['id']}")[1], complete)
        self.assertEqual(self.service.dispatch("GET", "/api/rap/renders")[1]["jobs"], [complete])
        self.service._run_job(job["id"])
        self.assertEqual(len(self.client.calls), 1)

    def test_idempotency_survives_completion_and_restart(self):
        job = self.submit()
        duplicate = self.submit()
        self.assertEqual(duplicate["id"], job["id"])
        self.complete(job)
        self.assertEqual(self.submit()["state"], "complete")
        self.service.close()
        self.service = RapService(self.root / "rap", self.env, client=self.client, start_worker=False)
        self.assertEqual(self.submit()["id"], job["id"])
        self.assertEqual(len(self.client.calls), 1)
        status, _ = self.service.dispatch("POST", "/api/rap/renders", self.request(text="different words"))
        self.assertEqual(status, 409)

    def test_inflight_alias_remains_idempotent_after_complete(self):
        job = self.submit()
        alias = self.submit(request_id="request-other-0002")
        self.assertEqual(alias["id"], job["id"])
        self.complete(job)
        self.assertEqual(self.submit(request_id="request-other-0002")["id"], job["id"])
        status, _ = self.service.dispatch("POST", "/api/rap/renders", self.request(request_id="request-other-0002", text="different"))
        self.assertEqual(status, 409)
        self.assertEqual(len(self.client.calls), 1)

    def test_concurrent_duplicate_posts_queue_one_charge(self):
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.service.create_render(self.request()))) for _ in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(results), 12)
        self.assertEqual(len({job["id"] for job in results}), 1)
        self.assertEqual(self.service._queue.qsize(), 1)

    def test_bounded_queue(self):
        for index in range(MAX_ACTIVE_JOBS):
            self.submit(request_id=f"request-{index:08d}", text=f"hello number {index}")
        status, _ = self.service.dispatch("POST", "/api/rap/renders", self.request(text="queue overflow"))
        self.assertEqual(status, 429)
        self.assertEqual(len(self.service.jobs()), MAX_ACTIVE_JOBS)
        self.assertEqual(self.client.calls, [])

    def test_failed_or_unknown_requests_never_auto_retry(self):
        self.client.failure = GenerationError("provider fake-test-secret failed", "unknown")
        job = self.submit()
        complete = self.complete(job)
        self.assertEqual(complete["state"], "unknown")
        self.assertEqual(complete["error"], "provider [redacted] failed")
        self.assertEqual(self.submit()["state"], "unknown")
        self.service._run_job(job["id"])
        self.assertEqual(len(self.client.calls), 1)
        self.assertFalse((self.root / "rap" / (job["id"] + ".wav")).exists())

    def test_renderer_failure_exposes_reason_and_no_unplayable_audio(self):
        job = self.submit()
        with mock.patch("rap_service.render_rap", side_effect=ValueError("Too many words for these bars.")):
            self.service._run_job(job["id"])
        result = self.service._job(job["id"])
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["error"], "Too many words for these bars.")
        self.assertEqual(self.service.dispatch("GET", f"/api/rap/renders/{job['id']}/audio")[0], 409)

    def test_interrupted_jobs_remain_unknown_on_restart(self):
        job = self.submit()
        self.service.close()
        self.service = RapService(self.root / "rap", self.env, client=self.client, start_worker=False)
        self.assertEqual(self.service._job(job["id"])["state"], "unknown")
        self.assertEqual(self.service._queue.qsize(), 0)
        self.assertEqual(self.submit()["state"], "unknown")
        self.assertEqual(self.client.calls, [])

    def test_server_storage_lock_and_safe_paths(self):
        with self.assertRaises(RuntimeError):
            RapService(self.root / "rap", self.env, start_worker=False)
        for path in ["/api/rap/renders/../../.env/audio", "/api/rap/renders/abc/audio", "/other/status", "/api/rap/status/extra"]:
            self.assertEqual(self.service.dispatch("GET", path)[0], 404)
        self.assertEqual(self.service.dispatch("POST", "/api/rap/renders", [])[0], 400)

    def test_voice_setting_only_uses_hydra_configuration(self):
        self.env.write_text("ELEVENLABS_API_KEY=unused\nexport ELEVENLABS_VOICE_ID='custom_voice'\nIGNORED=$(do-not-execute)\n")
        self.assertEqual(configured_voice(self.env), "custom_voice")
        with mock.patch.dict(os.environ, {"ELEVENLABS_VOICE_ID": "voice_override"}):
            self.assertEqual(configured_voice(self.env), "voice_override")
        self.env.write_text("ELEVENLABS_VOICE_ID=../invalid\n")
        self.assertEqual(configured_voice(self.env), DEFAULT_VOICE_ID)

    def test_timing_modes_preserve_legacy_fingerprint_and_bind_new_requests(self):
        expected = {"text": "hello", "bpm": 120.0, "voice_id": DEFAULT_VOICE_ID, "requested_voice_id": "", "bars": None}
        self.assertEqual(validate_render(self.request(), DEFAULT_VOICE_ID), expected)
        legacy = self.submit()
        row = self.service._db.execute("SELECT request_hash FROM requests WHERE request_id=?", (legacy["request_id"],)).fetchone()
        self.assertEqual(row[0], digest(expected))
        self.assertEqual(legacy["timing_mode"], "natural")
        self.assertEqual(legacy["renderer"], "python-natural-phrase-v2")
        self.assertEqual(self.submit()["id"], legacy["id"])
        status, _ = self.service.dispatch("POST", "/api/rap/renders", self.request(timing_mode="natural"))
        self.assertEqual(status, 409, "an explicit new option cannot silently change a durable request")
        phrase = self.submit(request_id="phrase-test-request", timing_mode="phrase_beats")
        self.assertEqual(phrase["renderer"], "python-phrase-beats-v3")
        self.assertEqual(phrase["timing_mode"], "phrase_beats")
        with mock.patch("rap_service.render_rap", side_effect=rendered) as renderer:
            self.service._run_job(phrase["id"])
            self.assertEqual(renderer.call_args.kwargs["timing_mode"], "phrase_beats")

    def test_mode_and_bpm_changes_reuse_saved_voice_without_provider_call(self):
        first = self.complete(self.submit())
        self.assertTrue(first["source_available"])
        self.assertEqual(len(self.client.calls), 1)
        second = self.submit(request_id="local-phrase-rerender", source_render_id=first["id"], timing_mode="phrase_beats", bpm=90)
        self.assertTrue(second["reused_source"])
        self.assertEqual(second["source_render_id"], first["id"])
        self.service._run_job(second["id"])
        second = self.service._job(second["id"])
        self.assertEqual(second["state"], "complete", second)
        self.assertEqual(second["timing_mode"], "phrase_beats")
        self.assertEqual(second["renderer"], "python-phrase-beats-v3")
        self.assertEqual(len(self.client.calls), 1)
        self.assertTrue(second["source_available"])
        self.assertEqual((self.root / "rap" / (first["id"] + ".source.pcm")).read_bytes(),
                         (self.root / "rap" / (second["id"] + ".source.pcm")).read_bytes())
        self.service._api_key = ""  # Local retiming does not need provider access.
        third = self.submit(request_id="local-natural-rerender", source_render_id=second["id"], timing_mode="natural", bpm=100)
        self.service._run_job(third["id"])
        third = self.service._job(third["id"])
        self.assertEqual(third["state"], "complete", third)
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(self.submit(request_id="local-natural-rerender", source_render_id=second["id"], timing_mode="natural", bpm=100)["id"], third["id"])

    def test_invalid_or_missing_source_never_falls_back_to_a_paid_call(self):
        first = self.complete(self.submit())
        for change in ({"text": "changed lyrics"}, {"voice_id": "other_voice"}):
            status, _ = self.service.dispatch("POST", "/api/rap/renders", self.request(request_id="source-mismatch", source_render_id=first["id"], **change))
            self.assertEqual(status, 400)
        status, _ = self.service.dispatch("POST", "/api/rap/renders", self.request(request_id="source-not-found", source_render_id="f" * 32))
        self.assertEqual(status, 404)
        (self.root / "rap" / (first["id"] + ".source.pcm")).unlink()
        self.assertFalse(self.service._job(first["id"])["source_available"])
        status, _ = self.service.dispatch("POST", "/api/rap/renders", self.request(request_id="source-file-missing", source_render_id=first["id"]))
        self.assertEqual(status, 409)
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(len(self.service.jobs()), 1)

    def test_voice_list_is_read_only_cached_and_returns_only_catalog(self):
        status, first = self.service.dispatch("GET", "/api/rap/voices")
        self.assertEqual(status, 200)
        self.assertEqual(first, {"voices": [{"voice_id": "voice_one", "name": "Voice One"}], "default_voice_id": DEFAULT_VOICE_ID, "truncated": False})
        first["voices"][0]["name"] = "mutated"
        self.assertEqual(self.service.dispatch("GET", "/api/rap/voices")[1]["voices"][0]["name"], "Voice One")
        self.assertEqual(self.client.voice_calls, 1)
        self.service._voices_cached_at -= VOICES_CACHE_SECONDS + 1
        self.assertEqual(self.service.dispatch("GET", "/api/rap/voices")[0], 200)
        self.assertEqual(self.client.voice_calls, 2)
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.service.jobs(), [])
        self.assertNotIn("fake-test-secret", canonical_json(first))

    def test_voice_permission_errors_preserve_manual_voice_option(self):
        self.client.list_voices = mock.Mock(side_effect=ServiceError("Enable voice-read permission, fake-test-secret", 403))
        status, body = self.service.dispatch("GET", "/api/rap/voices")
        self.assertEqual(status, 403)
        self.assertNotIn("fake-test-secret", body["error"])
        job = self.submit(voice_id="manual_voice")
        self.assertEqual(job["voice_id"], "manual_voice")
        self.service._api_key = ""
        self.assertEqual(self.service.dispatch("GET", "/api/rap/voices")[0], 503)

    def test_real_worker_and_renderer_create_bar_sized_wav(self):
        self.service.close()
        self.service = RapService(self.root / "rap", self.env, client=self.client)
        job = self.submit()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            complete = self.service._job(job["id"])
            if complete["state"] not in {"queued", "generating", "rendering"}:
                break
            time.sleep(.01)
        self.assertEqual(complete["state"], "complete", complete)
        self.assertEqual(complete["duration_seconds"], 2)
        self.assertEqual(complete["bars"], 1)
        self.assertEqual(complete["word_timings"][0]["word"], "hello")
        self.assertEqual(complete["word_timings"][0]["beat"], 0)
        with wave.open(str(self.service.audio_response(job["id"]).path), "rb") as audio:
            self.assertEqual(audio.getnchannels(), 1)
            self.assertEqual(audio.getsampwidth(), 2)
            self.assertEqual(audio.getframerate(), 16000)
            self.assertEqual(audio.getnframes(), 32000)
        self.assertEqual(len(self.client.calls), 1)
        self.service.close()
        self.assertTrue(self.service._storage_released)

    def test_close_during_request_releases_storage_when_worker_finishes(self):
        entered, release = threading.Event(), threading.Event()
        original = self.client.generate_with_timestamps

        def pending(**kwargs):
            entered.set()
            release.wait(timeout=3)
            return original(**kwargs)

        self.client.generate_with_timestamps = pending
        self.service.close()
        self.service = RapService(self.root / "rap", self.env, client=self.client)
        self.submit()
        self.assertTrue(entered.wait(timeout=3))
        self.service.close()
        self.assertFalse(self.service._storage_released)
        release.set()
        self.service._worker.join(timeout=3)
        self.assertFalse(self.service._worker.is_alive())
        self.assertTrue(self.service._storage_released)


class FakeResponse(io.BytesIO):
    def __init__(self, data: bytes, content_type="application/json", length=None):
        super().__init__(data)
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        if length is not None:
            self.headers["Content-Length"] = str(length)
        self.status = 200


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.client = RapTTSClient("not-a-real-key", 30)

    def request(self, response):
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch("rap_service.request.build_opener", return_value=opener):
            result = self.client.generate_with_timestamps(text="These exact words", voice_id=DEFAULT_VOICE_ID)
        return result, opener.open.call_args

    def test_single_timestamp_request_is_pcm_and_preserves_text(self):
        body = {"audio_base64": base64.b64encode(b"\x00\x00" * 100).decode(), "alignment": {"characters": ["x"]}}
        result, call = self.request(FakeResponse(json.dumps(body).encode()))
        outgoing = call.args[0]
        self.assertEqual(outgoing.get_method(), "POST")
        self.assertIn("/with-timestamps?output_format=pcm_16000", outgoing.full_url)
        self.assertEqual(json.loads(outgoing.data)["text"], "These exact words")
        self.assertEqual(json.loads(outgoing.data)["model_id"], "eleven_multilingual_v2")
        self.assertNotIn("voice_settings", json.loads(outgoing.data), "match the source repo's provider-default delivery")
        self.assertEqual(outgoing.get_header("Xi-api-key"), "not-a-real-key")
        self.assertEqual(result, (b"\x00\x00" * 100, {"alignment": {"characters": ["x"]}}))

    def test_malformed_and_bounded_responses(self):
        cases = [FakeResponse(b"not-json"), FakeResponse(b"[]"),
                 FakeResponse(b'{"audio_base64":"!!!"}'), FakeResponse(b'{"audio_base64":"AA=="}'),
                 FakeResponse(b'{"audio_base64":""}'), FakeResponse(b'{"audio_base64":5}'),
                 FakeResponse(b"{}", content_type="audio/mpeg"), FakeResponse(b"{}", length="invalid"),
                 FakeResponse(b"{}", length=MAX_RESPONSE_BYTES + 1), FakeResponse(b"{}", length=99)]
        for response in cases:
            with self.subTest(response=response):
                with self.assertRaises(GenerationError):
                    self.request(response)
        with mock.patch("rap_service.MAX_RESPONSE_BYTES", 10):
            with self.assertRaises(GenerationError):
                self.request(FakeResponse(b"x" * 11))

    def test_provider_failures_are_redacted_and_not_retried(self):
        failures = [error.HTTPError("https://api.elevenlabs.io", 401, "not-a-real-key", {}, None),
                    error.HTTPError("https://api.elevenlabs.io", 500, "not-a-real-key", {}, None),
                    error.URLError("not-a-real-key"), TimeoutError("not-a-real-key")]
        for failure in failures:
            opener = mock.Mock()
            opener.open.side_effect = failure
            with self.subTest(failure=failure), mock.patch("rap_service.request.build_opener", return_value=opener):
                with self.assertRaises(GenerationError) as caught:
                    self.client.generate_with_timestamps(text="hello", voice_id=DEFAULT_VOICE_ID)
                self.assertNotIn("not-a-real-key", str(caught.exception))
                self.assertEqual(opener.open.call_count, 1)

    def test_voice_catalog_paginates_sanitizes_and_sends_read_only_requests(self):
        pages = [
            {"voices": [{"voice_id": "voice_a", "name": " A\nVoice ", "samples": ["private"], "sharing": {"emails": ["private"]}},
                        {"voice_id": "../bad", "name": "invalid"}], "has_more": True, "next_page_token": "token&two"},
            {"voices": [{"voice_id": "voice_a", "name": "duplicate"}, {"voice_id": "voice_b", "name": "Bee"}], "has_more": False},
        ]
        opener = mock.Mock()
        opener.open.side_effect = [FakeResponse(json.dumps(page).encode()) for page in pages]
        with mock.patch("rap_service.request.build_opener", return_value=opener):
            result = self.client.list_voices()
        self.assertEqual(result, {"voices": [{"voice_id": "voice_a", "name": "AVoice"}, {"voice_id": "voice_b", "name": "Bee"}], "truncated": False})
        self.assertEqual(opener.open.call_count, 2)
        for call in opener.open.call_args_list:
            outgoing = call.args[0]
            self.assertEqual(outgoing.get_method(), "GET")
            self.assertEqual(outgoing.data, None)
            self.assertTrue(outgoing.full_url.startswith("https://api.elevenlabs.io/v2/voices?"))
            self.assertIn("page_size=100", outgoing.full_url)
            self.assertEqual(outgoing.get_header("Xi-api-key"), "not-a-real-key")
        self.assertIn("next_page_token=token%26two", opener.open.call_args_list[1].args[0].full_url)

    def test_voice_catalog_enforces_maximum_pages_and_entries(self):
        opener = mock.Mock()
        opener.open.side_effect = [FakeResponse(json.dumps({
            "voices": [{"voice_id": f"voice_{page}_{index}", "name": "Voice"} for index in range(100)],
            "has_more": True, "next_page_token": f"next-{page}",
        }).encode()) for page in range(5)]
        with mock.patch("rap_service.request.build_opener", return_value=opener):
            result = self.client.list_voices()
        self.assertEqual(len(result["voices"]), 500)
        self.assertTrue(result["truncated"])
        self.assertEqual(opener.open.call_count, 5)

    def test_voice_catalog_rejects_malformed_or_unbounded_provider_responses(self):
        cases = [FakeResponse(b"not-json"), FakeResponse(b"[]"), FakeResponse(b'{"voices":{}}'),
                 FakeResponse(b'{"voices":[],"has_more":true,"next_page_token":null}'),
                 FakeResponse(b"{}", content_type="text/html"), FakeResponse(b"{}", length="bad"),
                 FakeResponse(b"{}", length=3000000), FakeResponse(b"{}", length=9)]
        for response in cases:
            opener = mock.Mock(); opener.open.return_value = response
            with self.subTest(response=response), mock.patch("rap_service.request.build_opener", return_value=opener):
                with self.assertRaises(ServiceError):
                    self.client.list_voices()
        opener = mock.Mock(); opener.open.return_value = FakeResponse(b"x" * 11)
        with mock.patch("rap_service.request.build_opener", return_value=opener), mock.patch("rap_service.MAX_VOICE_PAGE_BYTES", 10):
            with self.assertRaises(ServiceError):
                self.client.list_voices()
        repeated = {"voices": [], "has_more": True, "next_page_token": "same-token"}
        opener.open.side_effect = [FakeResponse(json.dumps(repeated).encode()) for _ in range(2)]
        with mock.patch("rap_service.request.build_opener", return_value=opener):
            with self.assertRaisesRegex(ServiceError, "pagination token"):
                self.client.list_voices()

    def test_voice_catalog_permission_errors_do_not_expose_provider_detail(self):
        for code in (401, 403, 500):
            opener = mock.Mock()
            opener.open.side_effect = error.HTTPError("https://api.elevenlabs.io", code, "not-a-real-key", {}, None)
            with self.subTest(code=code), mock.patch("rap_service.request.build_opener", return_value=opener):
                with self.assertRaises(ServiceError) as caught:
                    self.client.list_voices()
                self.assertNotIn("not-a-real-key", str(caught.exception))
                self.assertIn("voice ID manually", str(caught.exception))
                self.assertEqual(caught.exception.status, code if code in (401, 403) else 502)
                self.assertEqual(opener.open.call_count, 1)

    def test_voice_catalog_has_a_total_deadline(self):
        opener = mock.Mock()
        with mock.patch("rap_service.request.build_opener", return_value=opener), mock.patch("rap_service.time.monotonic", side_effect=[0, 21]):
            with self.assertRaises(ServiceError) as caught:
                self.client.list_voices()
        self.assertEqual(caught.exception.status, 504)
        self.assertEqual(opener.open.call_count, 0)


if __name__ == "__main__":
    unittest.main()
