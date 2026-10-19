#!/usr/bin/env python3
"""Offline checks for durable, music-only conversational rap responses."""
import base64
import copy
from email.message import Message
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
from urllib import error
import wave
import zipfile

from elevenlabs_service import FileResponse, GenerationError, digest
from rap_transcription import TranscriptionError
from rap_response_service import (
    API_PREFIX, MAX_JSON_BYTES, NoRedirect, RapResponseClient, RapResponseService,
    lyric_prompt, lyrics_from_plan, transcription_text, validate_input,
)


LYRICS = "Missed that bus but you're still in the race\nOne late start cannot set your pace\nTell them the truth as you make your way\nThen bring that spark to the rest of your day"


def wave_bytes(rate=16000, channels=1, width=2, seconds=.2):
    output = io.BytesIO()
    with wave.open(output, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(width)
        handle.setframerate(rate)
        handle.writeframes(b"\x01" * round(rate * seconds) * channels * width)
    return output.getvalue()


class FakeClient:
    def __init__(self):
        self.calls = []
        self.on_call = None
        self.plan_result = {"chunks": [{"text": "[Rap verse]\n" + LYRICS}]}
        self.fail_stage = None

    def _call(self, stage, value):
        self.calls.append((stage, value))
        if self.on_call:
            self.on_call(stage)
        if self.fail_stage == stage:
            raise GenerationError("fake-secret provider connection interrupted", "unknown")

    def plan(self, prompt, duration_ms):
        self._call("writing", {"prompt": prompt, "duration_ms": duration_ms})
        return copy.deepcopy(self.plan_result)


class FakeTranscriber:
    def __init__(self):
        self.calls = []
        self.on_call = None
        self.text = "I missed the bus and now I'm late"
        self.ready = True
        self.failure = None

    def status(self):
        return {"ready": self.ready, "issues": [] if self.ready else ["Local Whisper small is not installed."]}

    def transcribe(self, source):
        self.calls.append(source.read_bytes())
        if self.on_call:
            self.on_call()
        if self.failure:
            raise self.failure
        return self.text


class FakeMusic:
    def __init__(self):
        self.calls = []
        self.on_call = None
        self.fail = False
        self.stem_calls = []
        self.on_separate = None
        self.fail_separate = False
        self.stem_entries = {"vocals.wav": wave_bytes(), "instrumental.wav": wave_bytes()}

    def generate(self, payload, destination):
        self.calls.append(copy.deepcopy(payload))
        if self.on_call:
            self.on_call()
        if self.fail:
            raise GenerationError("fake-secret music request lost", "unknown")
        destination.write_bytes(wave_bytes())

    def separate_stems(self, source, destination, variation):
        self.stem_calls.append((source.read_bytes(), variation))
        if self.on_separate:
            self.on_separate()
        if self.fail_separate:
            raise GenerationError("fake-secret separation connection lost", "unknown")
        with zipfile.ZipFile(destination, "w") as archive:
            for name, data in self.stem_entries.items():
                archive.writestr(name, data)


def audio_metadata(path, duration):
    with wave.open(str(path), "rb") as handle:
        return {"extension": "wav", "content_type": "audio/wav", "duration_seconds": handle.getnframes() / handle.getframerate()}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = self.root / "test.env"
        self.env.write_text("ELEVENLABS_API_KEY=fake-secret\n")
        self.environment = mock.patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.client, self.music, self.transcriber = FakeClient(), FakeMusic(), FakeTranscriber()
        self.service = self.new_service()

    def new_service(self, **options):
        service = RapResponseService(self.root / "responses", self.env, client=self.client, music_client=self.music,
                                     transcriber=self.transcriber, start_worker=options.get("start_worker", False))
        service.ffmpeg = service.ffprobe = "test-tool"
        service._validate_music = audio_metadata
        return service

    def tearDown(self):
        self.service.close()
        self.environment.stop()
        self.temp.cleanup()

    def payload(self, **changes):
        return {"request_id": "test-response-0001", "text": "I missed the bus and now I'm late", **changes}

    def submit(self, payload=None):
        code, job = self.service.dispatch("POST", API_PREFIX + "/responses", payload or self.payload())
        self.assertEqual(code, 202, job)
        return job

    def run_job(self, job):
        self.service._run_job(job["id"])
        return self.service.dispatch("GET", API_PREFIX + "/responses/" + job["id"])[1]

    def audio_payload(self, **changes):
        return {"request_id": "test-audio-0001", "audio_base64": base64.b64encode(wave_bytes()).decode(), **changes}

    def test_reads_are_passive_and_status_describes_limits(self):
        code, status = self.service.dispatch("GET", API_PREFIX + "/status")
        self.assertEqual(code, 200)
        self.assertTrue(status["ready"])
        self.assertTrue(status["transcription_ready"])
        self.assertEqual(status["transcription_model_id"], "whisper-small")
        self.assertEqual(status["defaults"], {"bpm": 95, "style": "boom_bap", "bars": 4})
        self.assertEqual(status["default_vocal_preset"], "deep_hiphop")
        self.assertEqual(status["vocal_presets"], [
            {"id": "deep_hiphop", "label": "Deep Hip-Hop Voice (Male)", "finetune_id": "cmogtn8kgmqiog8dhexe", "model_id": "music_v2"},
            {"id": "emo_trap", "label": "Emo Trap Autotune (Male)", "finetune_id": "iurf2sy9ee0sdcpenlxj", "model_id": "music_v2"},
        ])
        self.assertEqual(self.service.dispatch("GET", API_PREFIX + "/responses"), (200, {"responses": []}))
        self.assertNotIn("fake-secret", json.dumps(status))
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.transcriber.calls, [])
        self.assertEqual(self.music.calls, [])

    def test_typed_reply_writes_contextual_lyrics_then_full_music_with_durable_stages(self):
        job = self.submit(self.payload(bpm=100, bars=8, style="trap"))
        self.client.on_call = lambda stage: self.assertEqual(self.service._job(job["id"])["state"], stage)
        def check_music_stage():
            saved = self.service._job(job["id"])
            self.assertEqual(saved["state"], "generating")
            self.assertEqual(saved["lyrics"], LYRICS)
        self.music.on_call = check_music_stage
        completed = self.run_job(job)
        self.assertEqual(completed["state"], "complete", completed)
        self.assertEqual([stage for stage, _ in self.client.calls], ["writing"])
        prompt = self.client.calls[0][1]["prompt"]
        for fragment in (job["transcript"], "paired end rhymes", "internal rhyme", "RAP RESPONSE", "exactly 8",
                         "'you' and 'your'", "Answer their question", "Do not retell", "invent events", "6 to 10 words"):
            self.assertIn(fragment, prompt)
        self.assertLessEqual(len(prompt), 4100)
        request = self.music.calls[0]
        self.assertEqual(set(request), {"model_id", "composition_plan"})
        self.assertEqual(request["model_id"], "music_v2_5")
        chunks = request["composition_plan"]["chunks"]
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]["duration_ms"], 19200)
        self.assertIn("continuous drums and bass backing music", chunks[0]["positive_styles"])
        self.assertIn("rhythmic rap vocals", chunks[0]["positive_styles"])
        self.assertEqual(chunks[0]["text"], "[Rap verse]\n" + LYRICS)
        self.assertNotIn("_filename", completed)
        self.assertEqual(self.service.dispatch("GET", completed["audio_url"])[0], 200)
        self.assertIsInstance(self.service.dispatch("GET", completed["audio_url"])[1], FileResponse)
        self.assertIn("writing_seconds", completed["timings"])
        self.assertIn("generating_seconds", completed["timings"])

    def test_vocal_presets_pin_each_generated_voice_and_its_base_model(self):
        for key, label, identifier in (("deep_hiphop", "Deep Hip-Hop Voice (Male)", "cmogtn8kgmqiog8dhexe"),
                                        ("emo_trap", "Emo Trap Autotune (Male)", "iurf2sy9ee0sdcpenlxj")):
            with self.subTest(preset=key):
                job = self.submit(self.payload(request_id="preset-" + key, vocal_preset=key))
                self.assertEqual((job["vocal_preset"], job["vocal_preset_label"], job["finetune_id"], job["model_id"]),
                                 (key, label, identifier, "music_v2"))
                saved = self.service._job(job["id"])
                self.assertEqual(saved["finetune_id"], identifier)
                result = self.run_job(job)
                self.assertEqual(result["state"], "complete")
                outgoing = self.music.calls[-1]
                self.assertEqual(set(outgoing), {"model_id", "finetune_id", "composition_plan"})
                self.assertEqual((outgoing["model_id"], outgoing["finetune_id"]), ("music_v2", identifier))
                self.assertEqual(outgoing["composition_plan"]["chunks"][0]["text"], "[Rap verse]\n" + LYRICS)

    def test_vocal_preset_is_validated_and_part_of_request_identity(self):
        job = self.submit(self.payload(vocal_preset="deep_hiphop"))
        self.assertEqual(self.submit(self.payload(vocal_preset="deep_hiphop"))["id"], job["id"])
        for preset in ("emo_trap", ""):
            self.assertEqual(self.service.dispatch("POST", API_PREFIX + "/responses", self.payload(vocal_preset=preset))[0], 409)
        for preset in ("random", None, [], {}, True, 7):
            with self.subTest(preset=preset):
                self.assertEqual(self.service.dispatch("POST", API_PREFIX + "/responses", self.payload(vocal_preset=preset))[0], 400)
        self.assertEqual(self.music.calls, [])

    def test_legacy_request_hash_and_saved_original_voice_survive_voice_selection(self):
        job = self.submit()
        expected_hash = digest({"bpm": 95.0, "style": "boom_bap", "bars": 4,
                                "input_kind": "text", "transcript": self.payload()["text"]})
        self.assertEqual(self.service._db.execute("SELECT request_hash FROM responses WHERE id=?", (job["id"],)).fetchone()[0], expected_hash)
        saved = self.service._job(job["id"])
        for field in ("vocal_preset", "vocal_preset_label", "finetune_id", "output_mode"):
            saved.pop(field)
        self.service._write(saved)
        recovered = self.submit(self.payload(vocal_preset="", output_mode="mix"))
        self.assertEqual(recovered["id"], job["id"])
        self.assertEqual((recovered["vocal_preset"], recovered["vocal_preset_label"], recovered["finetune_id"]), ("", "Original", None))
        self.assertEqual(self.submit()["id"], job["id"])
        result = self.run_job(recovered)
        self.assertEqual(result["state"], "complete")
        self.assertEqual(self.music.calls[0]["model_id"], "music_v2_5")
        self.assertNotIn("finetune_id", self.music.calls[0])

    def test_saved_preset_survives_restart_and_isolation_without_voice_regeneration(self):
        original = self.run_job(self.submit(self.payload(vocal_preset="emo_trap")))
        self.service.close()
        self.service = self.new_service()
        self.service.isolate_vocals(original["id"])
        self.service._run_vocal_job(original["id"])
        recovered = self.service.request_response(original["request_id"])
        self.assertEqual(recovered["vocal_state"], "complete")
        for key in ("vocal_preset", "vocal_preset_label", "finetune_id", "model_id"):
            self.assertEqual(recovered[key], original[key])
        self.assertEqual(self.submit(self.payload(vocal_preset="emo_trap"))["id"], original["id"])
        self.assertEqual((len(self.music.calls), len(self.music.stem_calls)), (1, 1))

    def test_missing_or_wrong_preset_metadata_never_falls_back_to_a_different_voice(self):
        for index, changes in enumerate(({"finetune_id": None}, {"model_id": "music_v2_5"}, {"vocal_preset": "missing"})):
            with self.subTest(changes=changes):
                job = self.submit(self.payload(request_id=f"unavailable-preset-{index}", vocal_preset="deep_hiphop"))
                saved = self.service._job(job["id"])
                saved.update(changes)
                self.service._write(saved)
                result = self.run_job(job)
                self.assertEqual(result["state"], "failed")
                self.assertIn("no different voice was substituted", result["error"])
        self.assertEqual(self.music.calls, [])

    def test_preset_provider_failure_never_retries_with_another_voice(self):
        self.music.fail = True
        payload = self.payload(vocal_preset="deep_hiphop")
        job = self.submit(payload)
        result = self.run_job(job)
        self.assertEqual(result["state"], "unknown")
        self.run_job(job)
        self.assertEqual(self.submit(payload)["id"], job["id"])
        self.assertEqual(len(self.music.calls), 1)
        self.assertEqual(self.music.calls[0]["finetune_id"], "cmogtn8kgmqiog8dhexe")

    def test_vocal_mode_generates_once_then_validates_separate_vocal(self):
        job = self.submit(self.payload(output_mode="vocals"))
        def check_stage():
            saved = self.service._job(job["id"])
            self.assertEqual((saved["state"], saved["vocal_state"]), ("isolating", "isolating"))
            self.assertIsNotNone(saved["audio_url"])
            self.assertIsNone(saved["vocal_audio_url"])
            self.assertEqual(self.service.dispatch("GET", API_PREFIX + "/responses/" + job["id"] + "/vocals/audio")[0], 409)
        self.music.on_separate = check_stage
        result = self.run_job(job)
        self.assertEqual((result["state"], result["vocal_state"], result["output_mode"]), ("complete", "complete", "vocals"))
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(len(self.music.calls), 1)
        self.assertEqual(self.music.stem_calls, [(wave_bytes(), "two_stems_v1")])
        for url in (result["audio_url"], result["vocal_audio_url"]):
            code, audio = self.service.dispatch("GET", url)
            self.assertEqual(code, 200)
            self.assertEqual(audio.path.read_bytes(), wave_bytes())
        self.assertNotEqual(result["audio_url"], result["vocal_audio_url"])
        self.assertIn("isolating_seconds", result["timings"])
        self.assertNotIn("_vocal_filename", result)
        directory = self.service.root / job["id"]
        self.assertFalse((directory / "vocals.download.zip").exists())
        self.assertEqual(list(directory.glob("vocals.tmp-*")), [])

    def test_existing_mix_isolation_is_explicit_and_never_regenerates_or_retries(self):
        original = self.run_job(self.submit())
        self.assertEqual(original["output_mode"], "mix")
        self.assertEqual(original["vocal_state"], "not_requested")
        self.assertEqual(self.music.stem_calls, [])
        route = API_PREFIX + "/responses/" + original["id"] + "/vocals"
        code, queued = self.service.dispatch("POST", route, {})
        self.assertEqual((code, queued["state"], queued["vocal_state"]), (202, "isolating", "queued"))
        self.assertEqual(self.service.dispatch("POST", route, {})[1], queued)
        self.service._run_vocal_job(original["id"])
        completed = self.service.dispatch("GET", API_PREFIX + "/responses/" + original["id"])[1]
        self.assertEqual(completed["vocal_state"], "complete")
        self.assertEqual(self.service.dispatch("POST", route, {})[1], completed)
        self.service._run_vocal_job(original["id"])
        self.assertEqual((len(self.client.calls), len(self.music.calls), len(self.music.stem_calls)), (1, 1, 1))
        self.assertEqual(self.submit()["id"], original["id"], "the original request remains idempotent after isolation")

    def test_separation_failure_keeps_mix_download_and_never_publishes_a_vocal(self):
        self.music.fail_separate = True
        result = self.run_job(self.submit(self.payload(output_mode="vocals")))
        self.assertEqual((result["state"], result["vocal_state"]), ("unknown", "unknown"))
        self.assertIsNone(result["vocal_audio_url"])
        self.assertNotIn("fake-secret", result["error"])
        self.assertEqual(self.service.dispatch("GET", result["audio_url"])[0], 200)
        self.assertEqual(self.service.dispatch("GET", API_PREFIX + "/responses/" + result["id"] + "/vocals/audio")[0], 409)
        self.service.dispatch("POST", API_PREFIX + "/responses/" + result["id"] + "/vocals", {})
        self.service._run_job(result["id"])
        self.service._run_vocal_job(result["id"])
        self.assertEqual(len(self.music.stem_calls), 1)

    def test_invalid_or_ambiguous_stem_archives_are_never_published(self):
        for index, names in enumerate((
                ["../vocals.wav", "instrumental.wav"], ["vocals.wav", "notes.txt"],
                ["drums.wav", "instrumental.wav"], ["vocals.wav", "voice.wav"],
                ["vocals.wav"], ["no_vocals.wav", "instrumental.wav"])):
            with self.subTest(names=names):
                self.music.stem_entries = {name: wave_bytes() for name in names}
                result = self.run_job(self.submit(self.payload(request_id=f"bad-stems-{index:04}", output_mode="vocals")))
                self.assertEqual((result["state"], result["vocal_state"]), ("failed", "failed"))
                self.assertIsNone(result["vocal_audio_url"])
                self.assertEqual(self.service.dispatch("GET", result["audio_url"])[0], 200)
                directory = self.service.root / result["id"]
                self.assertEqual(list(directory.glob("vocal.*")), [])
                self.assertEqual(list(directory.glob("vocals.tmp-*")), [])

    def test_cancel_during_separation_suppresses_vocal_and_preserves_validated_mix(self):
        job = self.submit(self.payload(output_mode="vocals"))
        self.music.on_separate = lambda: self.service.cancel(job["id"])
        result = self.run_job(job)
        self.assertEqual((result["state"], result["vocal_state"]), ("cancelled", "cancelled"))
        self.assertIsNone(result["vocal_audio_url"])
        self.assertEqual(self.service.dispatch("GET", result["audio_url"])[0], 200)
        self.assertEqual(list((self.service.root / job["id"]).glob("vocal.*")), [])

    def test_cancel_queued_existing_mix_isolation_submits_nothing(self):
        original = self.run_job(self.submit())
        self.service.isolate_vocals(original["id"])
        self.service.cancel(original["id"])
        self.service._run_vocal_job(original["id"])
        self.assertEqual(self.music.stem_calls, [])
        self.assertEqual(self.service.audio_response(original["id"]).path.read_bytes(), wave_bytes())

    def test_restart_never_replays_queued_isolation(self):
        original = self.run_job(self.submit())
        self.service.isolate_vocals(original["id"])
        self.service.close()
        self.service = self.new_service()
        recovered = self.service.isolate_vocals(original["id"])
        self.assertEqual((recovered["state"], recovered["vocal_state"]), ("unknown", "unknown"))
        self.service._run_vocal_job(original["id"])
        self.assertEqual(self.music.stem_calls, [])
        self.assertEqual(self.service.dispatch("GET", recovered["audio_url"])[0], 200)

    def test_output_modes_are_validated_and_part_of_idempotency_identity(self):
        self.submit()
        self.assertEqual(self.service.dispatch("POST", API_PREFIX + "/responses", self.payload(output_mode="mix"))[0], 202)
        self.assertEqual(self.service.dispatch("POST", API_PREFIX + "/responses", self.payload(output_mode="vocals"))[0], 409)
        for mode in ("speech", None, [], True):
            self.assertEqual(self.service.dispatch("POST", API_PREFIX + "/responses", self.payload(output_mode=mode))[0], 400)

    def test_isolation_consumes_active_capacity_and_pending_mix_cannot_isolate(self):
        original = self.run_job(self.submit())
        pending = self.submit(self.payload(request_id="second-response"))
        route = API_PREFIX + "/responses/" + pending["id"] + "/vocals"
        self.assertEqual(self.service.dispatch("POST", route, {})[0], 409)
        self.service.isolate_vocals(original["id"])
        self.assertEqual(self.service.dispatch("POST", API_PREFIX + "/responses", self.payload(request_id="third-response"))[0], 429)

    def test_worker_processes_explicit_isolation_once(self):
        original = self.run_job(self.submit())
        self.service.close()
        self.service = self.new_service(start_worker=True)
        self.service.isolate_vocals(original["id"])
        self.service._queue.join()
        completed = self.service._job(original["id"])
        self.assertEqual(completed["vocal_state"], "complete")
        self.assertEqual((len(self.client.calls), len(self.music.calls), len(self.music.stem_calls)), (1, 1, 1))

    def test_audio_is_private_and_transcribed_before_lyrics(self):
        payload = self.audio_payload()
        job = self.submit(payload)
        private_audio = self.service.root / job["id"] / "input.wav"
        self.assertEqual(private_audio.stat().st_mode & 0o777, 0o600)
        self.assertEqual(private_audio.read_bytes(), wave_bytes())
        self.transcriber.on_call = lambda: self.assertEqual(self.service._job(job["id"])["state"], "transcribing")
        completed = self.run_job(job)
        self.assertEqual(completed["state"], "complete")
        self.assertEqual([stage for stage, _ in self.client.calls], ["writing"])
        self.assertEqual(self.transcriber.calls, [wave_bytes()])
        self.assertEqual(completed["transcript"], self.transcriber.text)
        self.assertIn(self.transcriber.text, self.client.calls[0][1]["prompt"])
        self.assertNotIn(payload["audio_base64"], json.dumps(self.client.calls))
        self.assertNotIn(payload["audio_base64"], json.dumps(self.music.calls))
        public = json.dumps(self.service.jobs())
        stored = self.service._db.execute("SELECT body FROM responses").fetchone()[0]
        for value in (public, stored):
            self.assertNotIn("audio_base64", value)
            self.assertNotIn(payload["audio_base64"], value)
            self.assertNotIn("input.wav", value)
        self.assertEqual(self.service.dispatch("GET", API_PREFIX + "/responses/" + job["id"] + "/input.wav")[0], 404)

    def test_same_request_id_never_recharges_in_any_terminal_state(self):
        job = self.submit()
        self.assertEqual(self.submit()["id"], job["id"])
        self.run_job(job)
        for state in ("complete", "failed", "unknown", "cancelled"):
            saved = self.service._job(job["id"])
            saved["state"] = state
            self.service._write(saved)
            self.assertEqual(self.submit()["id"], job["id"])
            self.service._run_job(job["id"])
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(len(self.music.calls), 1)
        self.service._api_key = ""
        self.assertEqual(self.submit()["id"], job["id"])
        self.assertEqual(self.service.dispatch("POST", API_PREFIX + "/responses", self.payload(text="Different message"))[0], 409)

    def test_request_id_lookup_recovers_without_mic_bytes(self):
        job = self.submit(self.audio_payload())
        self.assertEqual(self.service.dispatch("GET", API_PREFIX + "/requests/" + job["request_id"]), (200, job))
        self.assertEqual(self.service.dispatch("GET", API_PREFIX + "/requests/not-found-request")[0], 404)
        self.assertEqual(self.service.dispatch("GET", API_PREFIX + "/requests/..")[0], 404)
        self.assertEqual(self.client.calls, [])

    def test_restart_marks_pending_work_unknown_and_preserves_idempotency(self):
        job = self.submit(self.audio_payload())
        saved = self.service._job(job["id"])
        saved["state"] = "generating"
        self.service._write(saved)
        self.service.close()
        self.service = self.new_service()
        recovered = self.service.dispatch("GET", API_PREFIX + "/responses/" + job["id"])[1]
        self.assertEqual(recovered["state"], "unknown")
        self.assertEqual(self.submit(self.audio_payload())["id"], job["id"])
        self.service._run_job(job["id"])
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.music.calls, [])

    def test_active_queue_bound_does_not_block_recovering_existing_requests(self):
        first = self.submit()
        second = self.submit(self.payload(request_id="test-response-0002"))
        self.assertEqual(self.service.dispatch("POST", API_PREFIX + "/responses", self.payload(request_id="test-response-0003"))[0], 429)
        self.assertEqual(self.submit()["id"], first["id"])
        self.service.cancel(second["id"])
        self.submit(self.payload(request_id="test-response-0003"))

    def test_cancel_before_work_submits_nothing(self):
        job = self.submit()
        code, cancelled = self.service.dispatch("POST", API_PREFIX + "/responses/" + job["id"] + "/cancel", {})
        self.assertEqual((code, cancelled["state"]), (200, "cancelled"))
        self.assertEqual(self.run_job(job)["state"], "cancelled")
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.music.calls, [])

    def test_cancel_during_each_provider_stage_prevents_remaining_calls(self):
        for stage in ("transcribing", "writing", "generating"):
            with self.subTest(stage=stage):
                self.client.calls.clear()
                self.transcriber.calls.clear()
                self.music.calls.clear()
                job = self.submit(self.audio_payload(request_id="cancel-during-" + stage, vocal_preset="deep_hiphop"))
                self.client.on_call = lambda active, stage=stage: self.service.cancel(job["id"]) if active == stage else None
                self.transcriber.on_call = lambda: self.service.cancel(job["id"]) if stage == "transcribing" else None
                self.music.on_call = lambda: self.service.cancel(job["id"]) if stage == "generating" else None
                completed = self.run_job(job)
                self.assertEqual(completed["state"], "cancelled")
                self.assertEqual(completed["vocal_preset"], "deep_hiphop")
                self.assertIsNone(completed["audio_url"])
                self.assertEqual(len(self.client.calls), 0 if stage == "transcribing" else 1)
                self.assertEqual(len(self.transcriber.calls), 1)
                self.assertEqual(len(self.music.calls), int(stage == "generating"))
                self.assertFalse((self.service.root / job["id"] / "music.download").exists())
                self.assertEqual(self.service.dispatch("GET", API_PREFIX + "/responses/" + job["id"] + "/audio")[0], 409)

    def test_cancelled_state_survives_provider_error(self):
        job = self.submit()
        self.client.fail_stage = "writing"
        self.client.on_call = lambda stage: self.service.cancel(job["id"])
        completed = self.run_job(job)
        self.assertEqual(completed["state"], "cancelled")
        self.assertNotIn("fake-secret", completed["error"])
        self.assertEqual(self.music.calls, [])

    def test_provider_failure_is_not_retried_and_error_secret_is_redacted(self):
        self.music.fail = True
        job = self.submit()
        result = self.run_job(job)
        self.assertEqual(result["state"], "unknown")
        self.assertNotIn("fake-secret", json.dumps(result))
        self.assertIn("[redacted]", result["error"])
        self.run_job(job)
        self.submit()
        self.assertEqual(len(self.music.calls), 1)

    def test_empty_transcription_and_invalid_lyrics_do_not_generate_music(self):
        self.transcriber.text = "[silence]"
        job = self.submit(self.audio_payload())
        self.assertEqual(self.run_job(job)["state"], "failed")
        self.assertEqual(len(self.client.calls), 0)
        self.assertEqual(len(self.transcriber.calls), 1)
        self.assertEqual(self.music.calls, [])
        self.client.plan_result = {"chunks": [{"text": "[Instrumental]"}]}
        job = self.submit()
        self.assertEqual(self.run_job(job)["state"], "failed")
        self.assertEqual(self.music.calls, [])

    def test_local_transcription_failure_never_submits_provider_requests(self):
        self.transcriber.failure = TranscriptionError("Local transcription failed.")
        job = self.submit(self.audio_payload())
        result = self.run_job(job)
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["error"], "Local transcription failed.")
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.music.calls, [])

    def test_missing_local_transcription_only_disables_microphone_input(self):
        self.transcriber.ready = False
        status = self.service.status()
        self.assertTrue(status["ready"])
        self.assertFalse(status["transcription_ready"])
        self.assertTrue(status["transcription_issues"])
        self.assertEqual(self.service.dispatch("POST", API_PREFIX + "/responses", self.audio_payload())[0], 503)
        job = self.submit()
        self.assertEqual(self.run_job(job)["state"], "complete")
        self.assertEqual(self.transcriber.calls, [])

    def test_invalid_audio_output_is_never_exposed(self):
        self.service._validate_music = mock.Mock(side_effect=GenerationError("Invalid audio"))
        job = self.submit()
        result = self.run_job(job)
        self.assertEqual(result["state"], "failed")
        self.assertIsNone(result["audio_url"])
        self.assertFalse((self.service.root / job["id"] / "music.download").exists())

    def test_validation_rejects_invalid_inputs_without_provider_work(self):
        invalid = [None, [], {}, self.payload(text=""), self.payload(text="!"), self.payload(text="x" * 1001),
                   self.payload(text="contains\x00null"), self.payload(request_id="short"), self.payload(request_id="../../invalid"),
                   self.payload(bpm=True), self.payload(bpm=float("nan")), self.payload(bpm=69), self.payload(bpm=141),
                   self.payload(style="speech"), self.payload(style=[]), self.payload(bars=True), self.payload(bars=4.0), self.payload(bars=6),
                   self.payload(audio_base64=self.audio_payload()["audio_base64"]), self.audio_payload(audio_base64="not-base64"),
                   self.audio_payload(audio_base64="x" * 1500000)]
        for audio in (wave_bytes(rate=24000), wave_bytes(channels=2), wave_bytes(width=1), wave_bytes(seconds=.01),
                      wave_bytes(seconds=30.01), wave_bytes()[:-10], b"not a wave"):
            invalid.append(self.audio_payload(audio_base64=base64.b64encode(audio).decode()))
        for payload in invalid:
            with self.subTest(payload=repr(payload)[:160]):
                self.assertEqual(self.service.dispatch("POST", API_PREFIX + "/responses", payload)[0], 400)
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.music.calls, [])
        self.assertEqual(self.service.jobs(), [])

    def test_valid_audio_boundary_and_semantically_equal_bpm_are_idempotent(self):
        _, settings, audio = validate_input(self.audio_payload(audio_base64=base64.b64encode(wave_bytes(seconds=30)).decode()))
        self.assertEqual(settings["input_kind"], "audio")
        self.assertGreater(len(audio), 960000)
        job = self.submit(self.payload(bpm=95))
        self.assertEqual(self.submit(self.payload(bpm=95.0))["id"], job["id"])

    def test_missing_key_and_audio_tools_prevent_new_submissions(self):
        self.service._api_key = ""
        self.assertEqual(self.service.dispatch("POST", API_PREFIX + "/responses", self.payload())[0], 503)
        self.service._api_key = "fake-secret"
        self.service.ffmpeg = None
        self.assertEqual(self.service.dispatch("POST", API_PREFIX + "/responses", self.payload())[0], 503)

    def test_worker_runs_queued_job_once(self):
        self.service.close()
        self.service = self.new_service(start_worker=True)
        done = threading.Event()
        original_write = self.service._write
        def write(job):
            original_write(job)
            if job["state"] == "complete":
                done.set()
        self.service._write = write
        job = self.submit()
        self.assertTrue(done.wait(3))
        self.service._queue.join()
        self.assertEqual(self.service._job(job["id"])["state"], "complete")
        self.assertEqual(len(self.music.calls), 1)


class PlanTests(unittest.TestCase):
    def test_plan_text_markers_are_removed_but_plan_styles_and_lengths_are_not_trusted(self):
        plan = {"chunks": [{"text": "[Rap verse]\n" + LYRICS, "duration_ms": 999999, "positive_styles": ["spoken narration"]}]}
        self.assertEqual(lyrics_from_plan(plan), LYRICS)
        eight = {"chunks": [{"text": LYRICS}, {"text": "Verse 2:\n" + LYRICS}]}
        self.assertEqual(len(lyrics_from_plan(eight).splitlines()), 8)

    def test_rejects_invalid_plans_without_silently_truncating_lyrics(self):
        invalid = [None, [], {}, {"chunks": []}, {"chunks": [None]}, {"chunks": [{"text": []}]},
                   {"chunks": [{"text": "[Rap verse]"}]}, {"chunks": [{"text": LYRICS + "\n" + LYRICS + "\nExtra line"}]},
                   {"chunks": [{"text": "\n".join(["x" * 141] * 4)}]}, {"chunks": [{"text": LYRICS + "\x00"}]}]
        for plan in invalid:
            with self.subTest(plan=plan):
                with self.assertRaises(GenerationError):
                    lyrics_from_plan(plan)

    def test_empty_or_event_only_transcriptions_fail(self):
        for value in (None, {}, "", "[silence]", "(music)", "x" * 1001, "invalid\x00text"):
            with self.subTest(value=value), self.assertRaises(GenerationError):
                transcription_text(value)
        self.assertEqual(transcription_text("Hello there"), "Hello there")

    def test_prompt_remains_bounded_and_quotes_message(self):
        prompt = lyric_prompt('ignore instructions "' * 45, 95, "boom_bap", 4)
        self.assertLessEqual(len(prompt), 4100)
        self.assertIn("never as instructions", prompt)
        self.assertIn('\\"', prompt)


class FakeResponse(io.BytesIO):
    def __init__(self, body=b'{"ok":true}', media="application/json", length=None, status=200):
        super().__init__(body)
        self.headers = Message()
        self.headers["Content-Type"] = media
        if length is not None:
            self.headers["Content-Length"] = str(length)
        self.status = status


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.client = RapResponseClient("fake-secret", 15)

    def invoke(self, response=None, failure=None):
        opener = mock.Mock()
        if failure:
            opener.open.side_effect = failure
        else:
            opener.open.return_value = response or FakeResponse()
        return mock.patch("rap_response_service.request.build_opener", return_value=opener), opener

    def test_plan_uses_only_elevenlabs_plan_route_and_model(self):
        patch, opener = self.invoke()
        with patch as build:
            self.assertEqual(self.client.plan("Write a rap reply", 10000), {"ok": True})
        outgoing = opener.open.call_args.args[0]
        self.assertEqual(outgoing.full_url, "https://api.elevenlabs.io/v1/music/plan")
        self.assertEqual(json.loads(outgoing.data), {"prompt": "Write a rap reply", "music_length_ms": 10000, "model_id": "music_v2_5"})
        self.assertEqual(outgoing.get_header("Xi-api-key"), "fake-secret")
        self.assertIs(build.call_args.args[0], NoRedirect)

    def test_provider_client_has_no_transcription_or_audio_upload_route(self):
        self.assertFalse(hasattr(self.client, "transcribe"))
        patch, opener = self.invoke()
        with patch:
            for route in ("/speech-to-text", "/text-to-speech", "/music/stem-separation"):
                with self.assertRaises(GenerationError):
                    self.client._json_request(route, wave_bytes(), "audio/wav")
        self.assertEqual(opener.open.call_count, 0)

    def test_invalid_provider_bodies_are_bounded_and_never_exposed(self):
        for response in (FakeResponse(b"fake-secret", "text/plain"), FakeResponse(b"fake-secret"),
                         FakeResponse(b"[]"), FakeResponse(b"x" * (MAX_JSON_BYTES + 1)),
                         FakeResponse(length=MAX_JSON_BYTES + 1), FakeResponse(length="bad"),
                         FakeResponse(length=999), FakeResponse(status=201)):
            patch, _ = self.invoke(response)
            with self.subTest(response=response), patch, self.assertRaises(GenerationError) as caught:
                self.client.plan("reply", 10000)
            self.assertNotIn("fake-secret", str(caught.exception))

    def test_http_failure_outcomes_and_transport_errors_never_retry_or_leak(self):
        failures = [(error.HTTPError("https://api.elevenlabs.io", code, "fake-secret", {}, io.BytesIO(b"fake-secret")), state)
                    for code, state in ((302, "failed"), (401, "failed"), (422, "failed"), (429, "failed"), (408, "unknown"), (500, "unknown"))]
        failures += [(TimeoutError("fake-secret"), "unknown"), (error.URLError("fake-secret"), "unknown")]
        for failure, state in failures:
            patch, opener = self.invoke(failure=failure)
            with self.subTest(failure=failure), patch, self.assertRaises(GenerationError) as caught:
                self.client.plan("reply", 10000)
            self.assertEqual(caught.exception.state, state)
            self.assertNotIn("fake-secret", str(caught.exception))
            self.assertEqual(opener.open.call_count, 1)

    def test_deadline_is_enforced_and_oversized_prompt_never_calls_provider(self):
        patch, opener = self.invoke()
        with patch, mock.patch("rap_response_service.time.monotonic", side_effect=[0, 20]), self.assertRaises(GenerationError) as caught:
            self.client.plan("reply", 10000)
        self.assertEqual(caught.exception.state, "unknown")
        with patch, self.assertRaises(GenerationError):
            self.client.plan("x" * 4101, 10000)
        self.assertEqual(opener.open.call_count, 1)


if __name__ == "__main__":
    unittest.main()
