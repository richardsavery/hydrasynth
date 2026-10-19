#!/usr/bin/env python3
"""Offline comparison workflow checks: no provider requests or charges."""
import base64
import copy
from email.message import Message
import io
import json
import math
import os
from pathlib import Path
import struct
import sqlite3
import tempfile
import threading
import unittest
from unittest import mock
import wave
import zipfile

from elevenlabs_service import FileResponse, GenerationError, ServiceError
from rap_experiment_service import RapExperimentService, VARIANTS, DEFAULT_VARIANTS, EXPRESSIVE_MODEL, FAST_MODEL, PREFERRED_VOICE_ID, validate_experiment
from rap_service import RapTTSClient, DEFAULT_VOICE_ID


def wave_bytes(rate=24000):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(b"\x00\x01" * rate)
    return buffer.getvalue()


class SpeechClient:
    def __init__(self):
        self.calls = []
        self.fail_models = set()
        self.on_call = None

    def list_voices(self):
        return {"voices": [{"voice_id": "main_voice", "name": "Main"}, {"voice_id": "other_voice", "name": "Other"}]}

    def generate_with_timestamps(self, **settings):
        self.calls.append(settings)
        if self.on_call:
            self.on_call(settings)
        if settings["model_id"] in self.fail_models:
            raise GenerationError("fake-secret model unavailable", "unknown")
        text = settings["text"].split("\n", 1)[-1] if settings["text"].startswith("[") else settings["text"]
        rate = settings["sample_rate"]
        count = rate * 2
        pcm = b"".join(struct.pack("<h", round(10000 * math.sin(index * 2 * math.pi * 220 / rate))) for index in range(count))
        delta = 1.8 / len(text)
        return pcm, {"alignment": {"characters": list(text),
                    "character_start_times_seconds": [index * delta for index in range(len(text))],
                    "character_end_times_seconds": [(index + 1) * delta for index in range(len(text))]}}


class MusicClient:
    def __init__(self):
        self.calls = []
        self.separations = []
        self.fail_separation = False

    def generate(self, request, destination):
        self.calls.append(request)
        destination.write_bytes(wave_bytes(48000))

    def separate_stems(self, source, destination, variation):
        self.separations.append(variation)
        if self.fail_separation:
            raise GenerationError("Separation is unavailable.")
        with zipfile.ZipFile(destination, "w") as output:
            output.writestr("Vocals.wav", wave_bytes(48000))
            output.writestr("Instrumental.wav", wave_bytes(48000))


def music_metadata(path, duration):
    with wave.open(str(path), "rb") as audio:
        return {"extension": "wav", "content_type": "audio/wav", "sample_rate": audio.getframerate(),
                "channels": audio.getnchannels(), "duration_seconds": audio.getnframes() / audio.getframerate()}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = self.root / ".env"
        self.env.write_text("ELEVENLABS_API_KEY=fake-secret\n")
        self.environment = mock.patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.speech = SpeechClient()
        self.music = MusicClient()
        self.service = RapExperimentService(self.root / "experiments", self.env, client=self.speech, music_client=self.music, start_worker=False)
        self.service.ffmpeg = self.service.ffprobe = "test-fake-tool"
        self.service._validate_music = music_metadata

    def tearDown(self):
        self.service.close()
        self.environment.stop()
        self.temp.cleanup()

    def request(self, **overrides):
        return {"request_id": "test-request-0001", "text": "Move with the rhythm\nKeep it on the beat", "bpm": 100,
                "voice_id": "main_voice", "alternate_voice_id": "other_voice", **overrides}

    def submit(self, **values):
        code, result = self.service.dispatch("POST", "/api/rap-experiment/experiments", self.request(**values))
        self.assertEqual(code, 202, result)
        return result

    def complete(self, job):
        self.service._run_job(job["id"])
        return self.service._job(job["id"])

    def test_read_endpoints_are_passive_and_do_not_leak_credentials(self):
        for path in ("status", "experiments", "voices", "mixer-examples"):
            code, result = self.service.dispatch("GET", "/api/rap-experiment/" + path)
            self.assertEqual(code, 200)
            self.assertNotIn("fake-secret", json.dumps(result))
        self.assertEqual(self.speech.calls, [])
        self.assertEqual(self.music.calls, [])
        self.assertEqual(self.service.status()["default_alternate_voice_id"], "main_voice")

    def mixer_fixture(self):
        """Save a reusable pair directly; catalog tests never invoke a provider."""
        source_id, identifier = "a" * 32, "b" * 32
        source = {"experiment_id": source_id, "state": "complete", "voice_id": "main_voice",
                  "model_id": FAST_MODEL, "sample_rate": 24000}
        original = {"id": source_id, "state": "complete", "text": "Move with the rhythm", "voice_id": "main_voice",
                    "sources": {"flash": source}, "examples": []}
        job = {**copy.deepcopy(original), "id": identifier, "source_experiment_id": source_id}
        for key in ("flash", "robot"):
            job["examples"].append({"id": key, "state": "complete", "source_experiment_id": source_id,
                "source_example_id": "flash", "voice_id": "main_voice", "model_id": FAST_MODEL, "sample_rate": 24000,
                "audio_url": f"/api/rap-experiment/experiments/{identifier}/audio/{key}",
                "filename": key + ".wav", "content_type": "audio/wav"})
        for record in (original, job):
            self.service._db.execute("INSERT INTO experiments VALUES (?,?,?,?,?,?)",
                (record["id"], "catalog-" + record["id"], "catalog-fixture", "complete", "2026-10-15", json.dumps(record)))
            (self.service.root / record["id"]).mkdir()
        self.service._db.commit()
        for key in ("flash", "robot"):
            (self.service.root / identifier / (key + ".wav")).write_bytes(wave_bytes())
        (self.service.root / source_id / "flash.pcm").write_bytes(b"\0\1" * 24000)
        (self.service.root / source_id / "flash.alignment.json").write_text("{}")
        entry = {"id": "neutral-funk", "label": "Neutral · Funk", "track_id": "c" * 32, "experiment_id": identifier}
        catalog = self.service.root / "mixer-examples.json"
        catalog.write_text(json.dumps({"examples": [entry]}))
        return entry, job, catalog

    def test_mixer_catalog_reads_existing_pair_without_generating_or_mutating(self):
        entry, job, catalog = self.mixer_fixture()
        catalog.write_text(json.dumps({"examples": [{**entry, "label": " " + entry["label"] + " ", "ignored": "private"}]}))
        before_catalog, before_jobs = catalog.read_bytes(), self.service.jobs()
        self.service._api_key = ""  # Saved playback also works without generation credentials.
        for _ in range(2):
            self.assertEqual(self.service.dispatch("GET", "/api/rap-experiment/mixer-examples?cache=1"),
                             (200, {"examples": [entry]}))
        self.assertEqual(self.service.dispatch("POST", "/api/rap-experiment/mixer-examples", {})[0], 404)
        self.assertEqual(catalog.read_bytes(), before_catalog)
        self.assertEqual(self.service.jobs(), before_jobs)
        self.assertTrue(self.service._queue.empty())
        self.assertTrue(self.service._fast_queue.empty())
        self.assertEqual(self.speech.calls, [])
        self.assertEqual(self.music.calls, [])

    def test_mixer_catalog_missing_malformed_and_oversize_files_return_empty(self):
        path = "/api/rap-experiment/mixer-examples"
        self.assertEqual(self.service.dispatch("GET", path), (200, {"examples": []}))
        catalog = self.service.root / "mixer-examples.json"
        for data in (b"{", b"[]", b"null", b'{"examples":null}', b'{"examples":{}}', b"\xff", b" " * 65537,
                     b"[" * 1000 + b"]" * 1000):
            with self.subTest(data=data[:24]):
                catalog.write_bytes(data)
                self.assertEqual(self.service.dispatch("GET", path), (200, {"examples": []}))
        catalog.unlink()
        catalog.mkdir()
        self.assertEqual(self.service.dispatch("GET", path), (200, {"examples": []}))
        self.assertEqual(self.speech.calls, [])
        self.assertEqual(self.service.jobs(), [])

    def test_mixer_catalog_omits_invalid_records_deduplicates_and_bounds_entries(self):
        entry, _, catalog = self.mixer_fixture()
        invalid = [None, [], {}, {**entry, "id": "../bad"}, {**entry, "id": "x" * 65},
                   {**entry, "label": "\ninvalid"}, {**entry, "label": "bad\x7f"}, {**entry, "label": " "},
                   {**entry, "label": "x" * 121}, {**entry, "track_id": "../track"},
                   {**entry, "experiment_id": 1}, {**entry, "experiment_id": "d" * 32}]
        catalog.write_text(json.dumps({"examples": invalid + [entry, entry]}))
        self.assertEqual(self.service.mixer_examples(), [entry])
        catalog.write_text(json.dumps({"examples": [{**entry, "id": f"pair-{i}"} for i in range(101)]}))
        self.assertEqual(len(self.service.mixer_examples()), 100)
        self.assertEqual(self.speech.calls, [])

    def test_mixer_catalog_excludes_unready_or_mismatched_sources_and_audio(self):
        entry, job, _ = self.mixer_fixture()
        changes = [lambda record: record.update(state="partial"),
                   lambda record: record["sources"]["flash"].update(state="failed"),
                   lambda record: record["sources"]["flash"].update(experiment_id="f" * 32),
                   lambda record: record.update(text="Different lyrics"),
                   lambda record: record["examples"][0].update(state="queued"),
                   lambda record: record["examples"][1].update(source_experiment_id="f" * 32),
                   lambda record: record["examples"][1].update(voice_id="other_voice"),
                   lambda record: record["examples"][1].update(audio_url="https://example.invalid/audio"),
                   lambda record: record["examples"][1].update(filename="../../.env"),
                   lambda record: record.update(examples=[])]
        for change in changes:
            record = copy.deepcopy(job)
            change(record)
            self.service._write(record)
            self.assertEqual(self.service.dispatch("GET", "/api/rap-experiment/mixer-examples"),
                             (200, {"examples": []}), record)
        self.service._write(job)
        self.assertEqual(self.service.mixer_examples(), [entry])
        source_path = self.service.root / job["sources"]["flash"]["experiment_id"] / "flash.pcm"
        original_pcm = source_path.read_bytes()
        source_path.unlink()
        self.assertEqual(self.service.mixer_examples(), [])
        source_path.write_bytes(original_pcm)
        (self.service.root / job["id"] / "robot.wav").write_bytes(b"")
        self.assertEqual(self.service.mixer_examples(), [])
        self.assertEqual(self.speech.calls, [])

    def test_jade_default_respects_an_explicit_configured_voice(self):
        self.assertEqual(self.service.default_voice_id, PREFERRED_VOICE_ID)
        from rap_service import configured_voice
        self.assertEqual(configured_voice(self.env), DEFAULT_VOICE_ID, "normal rap retains its default")
        self.env.write_text("ELEVENLABS_API_KEY=fake-secret\nELEVENLABS_VOICE_ID=custom_voice\n")
        self.assertEqual(configured_voice(self.env, fallback=PREFERRED_VOICE_ID), "custom_voice")

    def test_all_variants_only_four_speech_sources_and_one_music_request(self):
        result = self.complete(self.submit())
        self.assertEqual(result["state"], "complete", result)
        self.assertEqual([item["id"] for item in result["examples"]], DEFAULT_VARIANTS)
        self.assertEqual(len(self.speech.calls), 4)
        self.assertEqual([call["sample_rate"] for call in self.speech.calls], [16000, 16000, 16000, 24000])
        self.assertEqual(self.speech.calls[2]["voice_id"], "other_voice")
        self.assertEqual(self.speech.calls[3]["model_id"], EXPRESSIVE_MODEL)
        self.assertTrue(self.speech.calls[3]["text"].startswith("[confident]"))
        self.assertEqual(len(self.music.calls), 1)
        request = self.music.calls[0]
        self.assertEqual(request["model_id"], "music_v2_5")
        self.assertIn(self.request()["text"], request["composition_plan"]["chunks"][0]["text"])
        self.assertNotIn("force_instrumental", request)
        self.assertEqual(self.music.separations, ["two_stems_v1"])
        for item in result["examples"]:
            code, audio = self.service.dispatch("GET", item["audio_url"])
            self.assertEqual(code, 200, audio)
            self.assertIsInstance(audio, FileResponse)
            with wave.open(str(audio.path), "rb") as saved:
                self.assertEqual(saved.getframerate(), item["sample_rate"])
        self.assertEqual(result["examples"][-1]["sample_rate"], 48000)

    def test_idempotence_and_conflicting_settings_before_or_after_completion(self):
        first = self.submit(variants=["fresh"])
        self.assertEqual(self.submit(variants=["fresh"])["id"], first["id"])
        alias = self.submit(variants=["fresh"], request_id="test-request-alias")
        self.assertEqual(alias["id"], first["id"])
        self.complete(first)
        self.assertEqual(self.submit(variants=["fresh"])["id"], first["id"])
        self.assertEqual(len(self.speech.calls), 1)
        code, _ = self.service.dispatch("POST", "/api/rap-experiment/experiments", self.request(text="Different words", variants=["fresh"]))
        self.assertEqual(code, 409)
        second = self.submit(variants=["fresh"], request_id="test-request-newtake")
        self.assertNotEqual(second["id"], first["id"])
        self.complete(second)
        self.assertEqual(len(self.speech.calls), 2)

    def test_persisted_generating_stage_precedes_provider_call(self):
        first = self.submit(variants=["fresh"])
        def check(_):
            saved = self.service._job(first["id"])
            self.assertEqual(saved["state"], "generating")
            self.assertEqual(saved["sources"]["fresh"]["state"], "generating")
            self.assertTrue((self.service.root / first["id"] / "fresh.request.json").is_file())
        self.speech.on_call = check
        self.complete(first)

    def test_one_failed_source_does_not_retry_for_dependent_examples(self):
        self.speech.fail_models.add(EXPRESSIVE_MODEL)
        result = self.complete(self.submit(variants=["baseline", "expressive", "bars", "produced"]))
        self.assertEqual(result["state"], "partial")
        self.assertEqual(len(self.speech.calls), 2)
        self.assertEqual([item["state"] for item in result["examples"]], ["complete", "unknown", "unknown", "unknown"])
        self.assertNotIn("fake-secret", json.dumps(result))

    def test_alternate_voice_must_differ_but_other_variants_continue(self):
        result = self.complete(self.submit(variants=["baseline", "alternate"], alternate_voice_id="main_voice"))
        self.assertEqual(result["state"], "partial")
        self.assertEqual(len(self.speech.calls), 1)
        self.assertIn("different", result["examples"][1]["error"])

    def test_saved_sources_reused_only_for_local_processing(self):
        first = self.complete(self.submit(variants=["baseline", "expressive"]))
        second = self.complete(self.submit(request_id="reuse-request-0001", variants=["phrases", "bars", "produced"], source_experiment_id=first["id"], bpm=120))
        self.assertEqual(second["state"], "complete", second)
        self.assertEqual(len(self.speech.calls), 2)
        third = self.complete(self.submit(request_id="new-take-request-01", variants=["expressive"], source_experiment_id=first["id"]))
        self.assertEqual(third["state"], "complete")
        self.assertEqual(len(self.speech.calls), 3)
        code, _ = self.service.dispatch("POST", "/api/rap-experiment/experiments", self.request(request_id="bad-source-request", source_experiment_id=first["id"], text="Different lyrics"))
        self.assertEqual(code, 400)

    def test_full_mix_survives_vocal_separation_failure(self):
        self.music.fail_separation = True
        result = self.complete(self.submit(variants=["music"]))
        example = result["examples"][0]
        self.assertEqual(example["state"], "failed")
        self.assertIsNone(example["audio_url"])
        self.assertTrue(example["full_mix_url"])
        code, audio = self.service.dispatch("GET", example["full_mix_url"])
        self.assertEqual(code, 200)
        self.assertTrue(audio.path.is_file())
        self.assertEqual(len(self.music.calls), 1)
        self.assertEqual(len(self.music.separations), 1)

    def test_restart_preserves_complete_examples_and_marks_pending_unknown(self):
        job = self.complete(self.submit(variants=["baseline"]))
        job["state"] = "generating"
        job["examples"].append({"id": "music", "state": "generating", "audio_url": None})
        self.service._write(job)
        self.service.close()
        self.service = RapExperimentService(self.root / "experiments", self.env, client=self.speech, music_client=self.music, start_worker=False)
        saved = self.service._job(job["id"])
        self.assertEqual(saved["state"], "unknown")
        self.assertEqual(saved["examples"][0]["state"], "complete")
        self.assertEqual(saved["examples"][1]["state"], "unknown")
        self.assertTrue(self.service._queue.empty())
        self.assertEqual(len(self.speech.calls), 1)
        self.assertEqual(self.music.calls, [])
        self.service._run_job(job["id"])
        self.assertEqual(self.music.calls, [])

    def test_invalid_requests_do_not_queue_provider_work(self):
        invalid = [{"variants": []}, {"variants": ["baseline", "baseline"]}, {"variants": ["unknown"]},
                   {"voice_id": "../voice"}, {"alternate_voice_id": []}, {"delivery": "loud"}, {"bpm": True},
                   {"text": "x" * 1001}, {"text": "word " * 161}, {"source_experiment_id": "../source"}]
        for values in invalid:
            code, _ = self.service.dispatch("POST", "/api/rap-experiment/experiments", self.request(**values))
            self.assertEqual(code, 400, values)
        self.assertEqual(self.speech.calls, [])
        self.assertEqual(self.service.jobs(), [])
        self.assertEqual(self.service.dispatch("GET", "/api/rap-experiment/experiments/../../.env")[0], 404)

    def test_generation_does_not_need_voice_catalog_permission(self):
        self.speech.list_voices = mock.Mock(side_effect=ServiceError("Voice-read permission missing.", 401))
        self.assertEqual(self.service.dispatch("GET", "/api/rap-experiment/voices")[0], 401)
        self.assertTrue(self.service.status()["ready"])
        self.assertEqual(self.complete(self.submit(variants=["baseline"]))["state"], "complete")

    def test_source_failure_is_recorded_and_not_replayed_on_read(self):
        self.speech.fail_models.add(EXPRESSIVE_MODEL)
        result = self.complete(self.submit(variants=["bars"]))
        self.assertEqual(result["state"], "unknown")
        for _ in range(3):
            self.service.dispatch("GET", "/api/rap-experiment/experiments/" + result["id"])
        self.assertEqual(len(self.speech.calls), 1)

    def test_reuse_chain_reads_the_original_source_without_more_generation(self):
        original = self.complete(self.submit(variants=["expressive"]))
        middle = self.complete(self.submit(request_id="chain-middle-001", variants=["bars"], source_experiment_id=original["id"]))
        last = self.complete(self.submit(request_id="chain-last-0001", variants=["produced"], source_experiment_id=middle["id"]))
        self.assertEqual(last["state"], "complete")
        self.assertEqual(last["sources"]["expressive"]["experiment_id"], original["id"])
        self.assertEqual(last["examples"][0]["source_experiment_id"], original["id"])
        self.assertEqual(len(self.speech.calls), 1)

    def test_artifact_path_guard_rejects_paths_outside_experiment(self):
        job = self.complete(self.submit(variants=["baseline"]))
        job["examples"][0]["filename"] = "../../.env"
        self.service._write(job)
        code, _ = self.service.dispatch("GET", job["examples"][0]["audio_url"])
        self.assertEqual(code, 404)

    def test_closing_finishes_accepted_source_without_submitting_more_variants(self):
        self.service.close()
        entered, release = threading.Event(), threading.Event()
        def wait_for_close(_):
            entered.set()
            self.assertTrue(release.wait(3))
        self.speech.on_call = wait_for_close
        self.service = RapExperimentService(self.root / "experiments", self.env, client=self.speech, music_client=self.music)
        job = self.submit(variants=["baseline", "fresh", "alternate"])
        self.assertTrue(entered.wait(3))
        self.service.close()
        release.set()
        self.service._worker.join(3)
        self.assertFalse(self.service._worker.is_alive())
        self.assertEqual(len(self.speech.calls), 1)
        with sqlite3.connect(self.service.root / "experiments.sqlite3") as database:
            saved = json.loads(database.execute("SELECT body FROM experiments WHERE id=?", (job["id"],)).fetchone()[0])
        self.assertEqual(saved["state"], "partial")
        self.assertEqual([example["state"] for example in saved["examples"]], ["complete", "failed", "failed"])

    def test_empty_alternate_uses_default_without_accepting_invalid_types(self):
        result = self.submit(variants=["alternate"], alternate_voice_id="")
        self.assertEqual(result["alternate_voice_id"], self.service.default_alternate_voice_id)

    def test_fast_pair_uses_one_flash_source_no_music_and_reports_full_ready_latency(self):
        result = self.complete(self.submit(variants=["flash", "robot"]))
        self.assertEqual(result["state"], "complete", result)
        self.assertTrue(result["fast_lane"])
        self.assertEqual(len(self.speech.calls), 1)
        call = self.speech.calls[0]
        self.assertEqual(call["model_id"], FAST_MODEL)
        self.assertEqual(call["sample_rate"], 24000)
        self.assertFalse(call["voice_settings"]["use_speaker_boost"])
        self.assertEqual(call["voice_settings"]["style"], 0)
        self.assertEqual(self.music.calls, [])
        self.assertEqual(self.music.separations, [])
        for example in result["examples"]:
            timing = example["timings"]
            self.assertGreaterEqual(timing["ready_seconds"], timing["source_seconds"])
            self.assertGreater(timing["processing_seconds"], 0)
            self.assertFalse(timing["source_reused"])
        self.assertGreaterEqual(result["timings"]["ready_seconds"], result["examples"][-1]["timings"]["ready_seconds"])

    def test_robot_effects_reuse_flash_across_tempo_delivery_and_effect_changes(self):
        first = self.complete(self.submit(variants=["flash", "robot"]))
        result = self.complete(self.submit(request_id="robot-retone-001", variants=["robot"], source_experiment_id=first["id"],
                                         robot_style="radio", robot_amount=.5, robot_tone_hz=1800, bpm=140, delivery="gritty"))
        self.assertEqual(result["state"], "complete", result)
        self.assertEqual(len(self.speech.calls), 1)
        self.assertTrue(result["examples"][0]["timings"]["source_reused"])
        self.assertEqual(result["examples"][0]["timings"]["source_seconds"], 0)
        last = self.complete(self.submit(request_id="robot-chain-0001", variants=["robot"], source_experiment_id=result["id"], robot_style="vocoder"))
        self.assertEqual(last["state"], "complete", last)
        self.assertEqual(last["sources"]["flash"]["experiment_id"], first["id"])
        self.assertEqual(len(self.speech.calls), 1)

    def test_robot_validation_preserves_legacy_request_hash_fields(self):
        legacy = validate_experiment(self.request(variants=["baseline"]), "main_voice")
        self.assertFalse(any(key.startswith("robot_") for key in legacy))
        for style in ("metallic", "radio", "vocoder"):
            old = validate_experiment(self.request(variants=["robot"], robot_style=style), "main_voice")
            self.assertNotIn("robot_key", old)
            self.assertNotIn("robot_scale", old)
        for values in ({"robot_style": "unknown"}, {"robot_amount": True}, {"robot_amount": float("nan")},
                       {"robot_amount": 1.1}, {"robot_tone_hz": 0}, {"robot_tone_hz": "4000"}):
            code, _ = self.service.dispatch("POST", "/api/rap-experiment/experiments", self.request(variants=["robot"], **values))
            self.assertEqual(code, 400, values)
        self.assertEqual(self.service.jobs(), [])

    def test_autotune_reuses_voice_and_passes_key_scale_to_renderer(self):
        first = self.complete(self.submit(variants=["flash"]))
        result = self.complete(self.submit(request_id="autotune-reuse-001", variants=["robot"],
            source_experiment_id=first["id"], robot_style="autotune", robot_key=6, robot_scale="major"))
        self.assertEqual(result["state"], "complete", result)
        self.assertEqual(len(self.speech.calls), 1)
        self.assertEqual(result["robot_key"], 6)
        self.assertEqual(result["robot_scale"], "major")
        self.assertTrue(result["examples"][0]["timings"]["source_reused"])
        settings = result["examples"][0]["robot"]
        self.assertEqual(settings["key"], 6)
        self.assertEqual(settings["scale"], "major")

    def test_autotune_validates_tuning_before_provider_request(self):
        settings = validate_experiment(self.request(variants=["robot"], robot_style="autotune"), "main_voice")
        self.assertEqual((settings["robot_key"], settings["robot_scale"]), (0, "minor"))
        for values in ({"robot_key": True}, {"robot_key": -1}, {"robot_key": 12}, {"robot_key": 2.5},
                       {"robot_key": "C"}, {"robot_scale": "unknown"}, {"robot_scale": []}):
            code, _ = self.service.dispatch("POST", "/api/rap-experiment/experiments",
                self.request(variants=["robot"], robot_style="autotune", **values))
            self.assertEqual(code, 400, values)
        self.assertEqual(self.speech.calls, [])
        self.assertEqual(self.service.jobs(), [])

    def test_audition_labels_are_optional_validated_and_persisted(self):
        legacy = validate_experiment(self.request(variants=["flash"]), "main_voice")
        self.assertNotIn("audition_group", legacy)
        self.assertNotIn("audition_label", legacy)
        for fields in ({"audition_group": "other", "audition_label": "A1"},
                       {"audition_group": "clear"}, {"audition_label": "A1"},
                       {"audition_group": "deep", "audition_label": "x" * 121},
                       {"audition_group": "bright", "audition_label": "bad\nlabel"}):
            code, _ = self.service.dispatch("POST", "/api/rap-experiment/experiments", self.request(variants=["flash"], **fields))
            self.assertEqual(code, 400, fields)
        self.assertEqual(self.speech.calls, [])
        job = self.complete(self.submit(variants=["flash"], audition_group="clear", audition_label=" A1 · Main "))
        self.assertEqual(job["audition_group"], "clear")
        self.assertEqual(job["audition_label"], "A1 · Main")
        self.assertEqual(self.service.jobs()[0]["audition_label"], "A1 · Main")
        self.assertNotIn("audition_label", self.speech.calls[0])

    def test_melody_and_clean_companion_reuse_one_source_at_changed_tempo(self):
        first = self.complete(self.submit(variants=["flash"]))
        result = self.complete(self.submit(request_id="melody-reuse-0001", variants=["robot"],
            source_experiment_id=first["id"], include_clean=True, robot_style="autotune", robot_key=2,
            robot_scale="major", robot_melody="arpeggio", robot_octave=4, robot_note_beats=.5,
            robot_amount=1, bpm=140, audition_group="jade", audition_label="J1 · Arpeggio"))
        self.assertEqual(result["state"], "complete", result)
        self.assertEqual([e["id"] for e in result["examples"]], ["flash", "robot"])
        self.assertEqual(len(self.speech.calls), 1)
        for example in result["examples"]:
            self.assertTrue(example["timings"]["source_reused"])
            self.assertEqual(example["source_experiment_id"], first["id"])
        dry, tuned = result["examples"]
        self.assertEqual(dry["duration_seconds"], tuned["duration_seconds"])
        self.assertEqual(tuned["robot"]["melody"], "arpeggio")
        self.assertEqual(tuned["robot"]["octave"], 4)
        self.assertEqual(tuned["robot"]["note_beats"], .5)
        self.assertEqual(tuned["robot"]["melody_bpm"], 140)
        followup = self.complete(self.submit(request_id="melody-chain-0001", variants=["robot"],
            source_experiment_id=result["id"], include_clean=True, robot_style="autotune", robot_melody="two_note"))
        self.assertEqual(followup["state"], "complete", followup)
        self.assertEqual(len(self.speech.calls), 1)

    def test_new_melody_fields_validate_without_changing_old_request_hashes(self):
        old = validate_experiment(self.request(variants=["robot"], robot_style="autotune"), "main_voice")
        for field in ("robot_melody", "robot_octave", "robot_note_beats", "include_clean"):
            self.assertNotIn(field, old)
        invalid = [{"robot_melody": "unknown"}, {"robot_octave": True}, {"robot_octave": 6},
                   {"robot_octave": 2.5}, {"robot_note_beats": True}, {"robot_note_beats": 0},
                   {"robot_note_beats": float("nan")}, {"robot_note_beats": "1"},
                   {"include_clean": "true"}, {"include_clean": True},
                   {"include_clean": True, "source_experiment_id": "a" * 32, "variants": ["flash", "robot"]}]
        for fields in invalid:
            payload = self.request(variants=["robot"], robot_style="autotune")
            payload.update(fields)
            code, _ = self.service.dispatch("POST", "/api/rap-experiment/experiments", payload)
            self.assertEqual(code, 400, fields)
        self.assertEqual(self.service.jobs(), [])
        self.assertEqual(self.speech.calls, [])

    def test_rhythm_reuses_source_and_matches_clean_companion(self):
        first = self.complete(self.submit(variants=["flash"]))
        for mode in ("natural", "phrases", "flow"):
            result = self.complete(self.submit(request_id=f"rhythm-{mode}-0001", variants=["robot"],
                source_experiment_id=first["id"], include_clean=True, robot_style="autotune",
                robot_rhythm=mode, robot_melody="two_note", robot_octave=3, bpm=120,
                audition_group="neutral", audition_label=f"N · {mode}"))
            self.assertEqual(result["state"], "complete", result)
            self.assertEqual(result["robot_rhythm"], mode)
            self.assertEqual(result["audition_group"], "neutral")
            dry, tuned = result["examples"]
            self.assertEqual(dry["rhythm_mode"], mode)
            self.assertEqual(tuned["rhythm_mode"], mode)
            self.assertEqual(dry["word_timings"], tuned["word_timings"])
            self.assertEqual(dry["duration_seconds"], tuned["duration_seconds"])
            self.assertTrue(all(e["timings"]["source_reused"] for e in result["examples"]))
            self.assertEqual(len(self.speech.calls), 1)
        self.assertNotIn("robot_rhythm", self.speech.calls[0])

    def test_rhythm_validates_without_changing_legacy_hash(self):
        legacy = validate_experiment(self.request(variants=["flash", "robot"]), "main_voice")
        self.assertNotIn("robot_rhythm", legacy)
        for mode in (None, True, 1, "unknown", [], {}):
            code, _ = self.service.dispatch("POST", "/api/rap-experiment/experiments",
                self.request(variants=["flash", "robot"], robot_rhythm=mode))
            self.assertEqual(code, 400, mode)
        self.assertEqual(self.speech.calls, [])
        self.assertEqual(self.service.jobs(), [])

    def test_fast_worker_bypasses_busy_normal_lane_and_shutdown_keeps_storage_open(self):
        self.service.close()
        entered, release = threading.Event(), threading.Event()
        def block_normal(settings):
            if settings["model_id"] != FAST_MODEL:
                entered.set()
                self.assertTrue(release.wait(5))
        self.speech.on_call = block_normal
        self.service = RapExperimentService(self.root / "experiments", self.env, client=self.speech, music_client=self.music)
        try:
            slow = self.submit(variants=["baseline"])
            self.assertTrue(entered.wait(2))
            queued = self.submit(variants=["fresh"], request_id="second-normal-001")
            fast = self.submit(variants=["flash", "robot"], request_id="fast-priority-001")
            self.service._fast_queue.join()
            self.assertEqual(self.service._job(fast["id"])["state"], "complete")
            self.assertEqual(self.service._job(slow["id"])["state"], "generating")
            self.assertEqual(self.service._job(queued["id"])["state"], "queued")
            self.service.close()
            self.assertFalse(self.service._storage_released, "busy normal worker still needs the database after fast worker exits")
        finally:
            release.set()
            self.service._worker.join(3)
            self.service._fast_worker.join(3)
        self.assertTrue(self.service._storage_released)

    def test_lane_admission_is_bounded_and_mixed_jobs_stay_normal(self):
        self.submit(variants=["baseline"])
        self.submit(variants=["fresh"], request_id="normal-limit-002")
        self.submit(variants=["flash"], request_id="fast-limit-0001")
        self.submit(variants=["robot"], request_id="fast-limit-0002")
        for variants in (["baseline"], ["flash", "robot"], ["flash", "music"]):
            code, _ = self.service.dispatch("POST", "/api/rap-experiment/experiments", self.request(request_id="over-limit-001", variants=variants, text="Different unique words"))
            self.assertEqual(code, 429)
        self.assertEqual(len(self.service.jobs()), 4)


class ClientTests(unittest.TestCase):
    def test_flash_model_is_sent_to_timestamp_endpoint(self):
        headers = Message()
        headers["Content-Type"] = "application/json"
        payload = json.dumps({"audio_base64": base64.b64encode(b"\0\0" * 24000).decode(), "alignment": {}}).encode()
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status, response.headers = 200, headers
        response.read.side_effect = [payload, b""]
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch("rap_service.request.build_opener", return_value=opener):
            RapTTSClient("fake-secret", 10).generate_with_timestamps(text="Fast voice", voice_id=DEFAULT_VOICE_ID, model_id=FAST_MODEL, sample_rate=24000)
        outgoing = opener.open.call_args.args[0]
        self.assertEqual(json.loads(outgoing.data)["model_id"], FAST_MODEL)
        self.assertIn("/with-timestamps?output_format=pcm_24000", outgoing.full_url)

    def test_custom_model_rate_and_settings_leave_legacy_defaults_intact(self):
        headers = Message()
        headers["Content-Type"] = "application/json"
        payload = json.dumps({"audio_base64": base64.b64encode(b"\0\0" * 24000).decode(), "alignment": {}}).encode()
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.headers = headers
        response.read.side_effect = [payload, b""]
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch("rap_service.request.build_opener", return_value=opener):
            pcm, _ = RapTTSClient("fake-secret", 10).generate_with_timestamps(text="[confident] hello", voice_id=DEFAULT_VOICE_ID,
                model_id=EXPRESSIVE_MODEL, sample_rate=24000, voice_settings={"stability": .35, "similarity_boost": .75})
        outgoing = opener.open.call_args.args[0]
        self.assertIn("output_format=pcm_24000", outgoing.full_url)
        self.assertEqual(json.loads(outgoing.data)["model_id"], EXPRESSIVE_MODEL)
        self.assertEqual(len(pcm), 48000)


if __name__ == "__main__":
    unittest.main()
