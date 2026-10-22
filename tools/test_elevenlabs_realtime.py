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
from elevenlabs_realtime import compile_prompt_plan, extract_stems, validated_continuation_request, validated_live_request
from elevenlabs_service import ElevenLabsService, GenerationError, ServiceError, STEM_PROVIDER_URL, digest, plan_cache_key, semantic_hash_value
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

    def prompt_payload(self, **overrides):
        return {"kind": "prompt", "plan_id": self.plan["id"], "source_job_id": None,
                "session_id": "test_prompt_session", "sequence": 0, "duration_seconds": 40,
                "settings": {"style": "spacious jazz", "bpm": 84, "key": "F minor",
                             "instrument_palette": ["piano", "upright bass"]}, **overrides}

    def test_prompt_next_track_uses_direction_and_saved_audio_without_data(self):
        self.plan = self.service.create_plan({"kind": "original", "duration_seconds": 20})
        original = self.complete_stems(self.complete(self.generate()))
        anchor_before = copy.deepcopy(self.service._read("plans", self.plan["id"]))
        payload = self.prompt_payload(source_job_id=original["id"], duration_seconds=60)
        status, job = self.service.dispatch("POST", "/api/elevenlabs/continuations", payload)
        self.assertEqual(status, 202, job)
        self.assertTrue(job["separate_stems"])
        plan = self.service._read("plans", job["plan_id"])
        self.assertEqual(plan["origin"], "prompt_continuation")
        self.assertEqual(plan["analysis_settings"]["kind"], "prompt")
        for key in ("dataset_id", "analysis_id", "dataset_hash"):
            self.assertIsNone(plan[key])
        self.assertEqual(plan["baseline"], {})
        self.assertEqual(plan["thresholds"], {})
        self.assertEqual(job["realtime"]["kind"], "prompt_continuation")
        self.assertEqual(job["realtime"]["root_plan_id"], self.plan["id"])
        self.assertEqual(job["realtime"]["generation_settings"], plan["settings"])
        self.assertTrue(job["realtime"]["conditioning_applied"])
        self.assertNotIn("observed_features", job["realtime"])
        self.assertNotIn("observed_window_seconds", job["realtime"])
        chunk = plan["request"]["composition_plan"]["chunks"][0]
        self.assertEqual(chunk["duration_ms"], 60000)
        self.assertEqual(chunk["text"], "")
        self.assertEqual(chunk["positive_styles"], ["spacious jazz", "instrumental music", "84 BPM", "F minor", "piano", "upright bass"])
        self.assertEqual(chunk["negative_styles"], ["vocals", "lyrics"])
        self.assertEqual(chunk["conditioning_ref"], {"song_id": "song123", "range": {"start_ms": 0, "end_ms": 10000}})
        self.assertEqual(chunk["condition_strength"], "high")
        for key in ("activity", "variability", "coverage", "bands"):
            self.assertNotIn(key, plan["sections"][0])
        self.assertEqual(self.service._read("plans", self.plan["id"]), anchor_before)
        self.assertEqual(list((self.service.root / "datasets").iterdir()), [])
        self.assertEqual(list((self.service.root / "analyses").iterdir()), [])
        completed = self.complete_stems(self.complete(job))
        self.assertEqual(len(completed["stem_separation"]["stems"]), 6)
        self.assertEqual(self.client.calls[-1], plan["request"])

    def test_unchanged_prompt_creates_fresh_next_sequence_without_provider_reference(self):
        first = self.complete_stems(self.complete(self.service.create_continuation_job(self.prompt_payload())))
        first["audio"].pop("provider_song_id", None)
        self.service._write_job(first)
        first_plan = self.service._read("plans", first["plan_id"])
        payload = self.prompt_payload(sequence=1, source_job_id=first["id"], plan_id=first["plan_id"])
        second = self.service.create_continuation_job(payload)
        second_plan = self.service._read("plans", second["plan_id"])
        self.assertNotEqual(first["id"], second["id"])
        self.assertNotEqual(first["cache_key"], second["cache_key"])
        self.assertEqual(first_plan["request"], second_plan["request"])
        self.assertEqual(second["realtime"]["root_plan_id"], self.plan["id"])
        self.assertFalse(second["realtime"]["conditioning_applied"])
        self.assertEqual(self.service.create_continuation_job(payload)["id"], second["id"])
        # Prompt continuations do not claim that their recorded-data ancestor
        # contributed observations, even when it has saved dataset identifiers.
        self.assertIsNotNone(self.plan["dataset_id"])
        self.assertIsNone(second_plan["dataset_id"])
        self.assertIsNone(second_plan["analysis_id"])

    def test_explicit_fresh_skips_retained_audio_and_evolve_conditions_lightly(self):
        self.plan = self.service.create_plan({"kind": "original", "duration_seconds": 20,
                                              "settings": {"seed": 123}})
        original = self.complete_stems(self.complete(self.generate()))
        self.assertEqual(original["audio"]["provider_song_id"], "song123")
        expected = {"model_id": "music_v2_5", "store_for_inpainting": True, "seed": 123,
                    "composition_plan": {"chunks": [{"text": "", "duration_ms": 40000,
                        "positive_styles": ["spacious jazz", "instrumental music", "84 BPM", "F minor", "piano", "upright bass"],
                        "negative_styles": ["vocals", "lyrics"], "context_adherence": "high"}]}}
        for sequence, mode in enumerate(("fresh", "evolve")):
            with self.subTest(mode=mode):
                job = self.service.create_continuation_job(self.prompt_payload(
                    source_job_id=original["id"], sequence=sequence, continuity_mode=mode))
                plan = self.service._read("plans", job["plan_id"])
                provider_request = copy.deepcopy(expected)
                if mode == "evolve":
                    provider_request["composition_plan"]["chunks"][0].update(
                        conditioning_ref={"song_id": "song123", "range": {"start_ms": 0, "end_ms": 10000}},
                        condition_strength="low")
                self.assertEqual(plan["request"], provider_request)
                self.assertEqual(job["realtime"]["continuity_mode"], mode)
                self.assertEqual(job["realtime"]["conditioning_applied"], mode == "evolve")
                self.assertEqual(plan["sections"][0]["provenance"]["continuity_mode"], mode)
                self.assertEqual(plan["analysis_settings"]["continuity_mode"], mode)
                self.complete_stems(self.complete(job))
                self.assertEqual(self.client.calls[-1], provider_request)

    def test_explicit_modes_have_distinct_cache_identity_without_audio_reference(self):
        plans = {mode: compile_prompt_plan(self.plan, validated_continuation_request(self.prompt_payload(continuity_mode=mode)))
                 for mode in ("fresh", "evolve")}
        self.assertEqual(plans["fresh"]["request"], plans["evolve"]["request"])
        self.assertNotEqual(plan_cache_key(plans["fresh"]), plan_cache_key(plans["evolve"]))
        first = self.complete_stems(self.complete(self.service.create_continuation_job(self.prompt_payload(continuity_mode="fresh"))))
        second = self.service.create_continuation_job(self.prompt_payload(sequence=1, continuity_mode="fresh"))
        self.assertNotEqual(first["id"], second["id"])
        self.assertNotEqual(first["cache_key"], second["cache_key"], "same prompt at a new sequence still creates a track")

    def test_mode_is_bound_to_request_id_and_restricted_to_prompt(self):
        plans_before = set((self.service.root / "plans").iterdir())
        for value in (None, "", "legacy", "high", True, {}, []):
            status, result = self.service.dispatch("POST", "/api/elevenlabs/continuations", self.prompt_payload(continuity_mode=value))
            self.assertEqual(status, 400, result)
        for payload in (self.payload(continuity_mode="fresh"), self.payload(kind="live", continuity_mode="evolve")):
            status, result = self.service.dispatch("POST", "/api/elevenlabs/continuations", payload)
            self.assertEqual(status, 400, result)
        self.assertEqual(set((self.service.root / "plans").iterdir()), plans_before)
        fresh = self.prompt_payload(continuity_mode="fresh")
        job = self.service.create_continuation_job(fresh)
        self.assertEqual(self.service.create_continuation_job(fresh)["id"], job["id"])
        for changed in (self.prompt_payload(continuity_mode="evolve"), self.prompt_payload()):
            status, result = self.service.dispatch("POST", "/api/elevenlabs/continuations", changed)
            self.assertEqual(status, 409, result)
        self.assertEqual(self.client.calls, [])

    def test_legacy_prompt_fingerprint_and_pending_recovery_remain_unchanged(self):
        payload = self.prompt_payload()
        self.assertEqual(validated_continuation_request(payload), payload)
        expected_hash = digest(semantic_hash_value(payload))
        first = self.service.create_continuation_job(payload)
        plan = self.service._read("plans", first["plan_id"])
        self.assertNotIn("continuity_mode", plan["analysis_settings"])
        self.assertEqual(plan["realtime"]["continuity_mode"], "legacy")
        stored_hash = self.service._db.execute("SELECT request_hash FROM live_requests WHERE session_id=? AND sequence=?",
                                             (payload["session_id"], payload["sequence"])).fetchone()[0]
        self.assertEqual(stored_hash, expected_hash)
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        recovered = self.service.create_continuation_job(payload)
        self.assertEqual(recovered["id"], first["id"])
        self.assertEqual(recovered["cache_key"], first["cache_key"])
        self.assertEqual(self.client.calls, [])

    def test_prompt_request_idempotency_binds_direction_and_kind(self):
        payload = self.prompt_payload()
        first = self.service.create_continuation_job(payload)
        equivalent = copy.deepcopy(payload)
        equivalent["settings"]["bpm"] = 84.0
        self.assertEqual(self.service.create_continuation_job(equivalent)["id"], first["id"])
        changed = copy.deepcopy(payload)
        changed["settings"]["style"] = "acoustic folk"
        for request in (changed, self.payload(session_id=payload["session_id"])):
            status, result = self.service.dispatch("POST", "/api/elevenlabs/continuations", request)
            self.assertEqual(status, 409, result)
            self.assertIn("different saved", result["error"])
        self.assertEqual(len(self.service.jobs()), 1)
        self.assertEqual(self.client.calls, [])

    def test_prompt_unknown_outcome_survives_restart_and_another_sequence_can_follow(self):
        payload = self.prompt_payload()
        first = self.service.create_continuation_job(payload)
        self.client.failure = GenerationError("uncertain", "unknown")
        self.service._run_job(first["id"])
        self.service.close()
        self.service = ElevenLabsService(self.root / "var" / "elevenlabs", self.env, client=self.client, start_worker=False)
        reused = self.service.create_continuation_job(payload)
        self.assertEqual(reused["id"], first["id"])
        self.assertEqual(reused["state"], "unknown")
        self.assertEqual(len(self.client.calls), 1)
        next_job = self.service.create_continuation_job(self.prompt_payload(sequence=1))
        self.assertNotEqual(next_job["id"], first["id"])
        self.assertEqual(next_job["state"], "queued")

    def test_prompt_inherits_direction_and_rejects_invalid_requests_before_saving(self):
        self.plan = self.service.create_plan({"kind": "original", "settings": {
            "style": "gentle jazz", "key": "G minor", "instrument_palette": ["piano", "bass"], "seed": 123,
        }})
        plans_before = set((self.service.root / "plans").iterdir())
        invalid = [
            {"features": self.payload()["features"]}, {"request": {}}, {"kind": "other"},
            {"duration_seconds": 25}, {"duration_seconds": True}, {"sequence": -1},
            {"session_id": ""}, {"settings": None}, {"settings": {"bpm": float("nan")}},
            {"settings": {"style": ""}}, {"settings": {"instrument_palette": "piano"}},
            {"settings": {"condition_strength": "high"}},
        ]
        for change in invalid:
            status, result = self.service.dispatch("POST", "/api/elevenlabs/continuations", self.prompt_payload(**change))
            self.assertEqual(status, 400, result)
        self.assertEqual(set((self.service.root / "plans").iterdir()), plans_before)
        self.assertEqual(self.service.jobs(), [])
        self.assertEqual(self.client.calls, [])
        job = self.service.create_continuation_job(self.prompt_payload(settings={"bpm": 123, "seed": None}))
        plan = self.service._read("plans", job["plan_id"])
        self.assertEqual(plan["settings"]["bpm"], 123)
        for key in ("style", "key", "instrument_palette"):
            self.assertEqual(plan["settings"][key], self.plan["settings"][key])
        self.assertNotIn("seed", plan["request"])

    def test_legacy_live_request_fingerprint_shape_is_preserved(self):
        payload = self.payload()
        expected = {**payload, "source_job_id": None,
                    "features": {**payload["features"], "trend": 0}}
        self.assertEqual(validated_live_request(payload), expected)
        self.assertEqual(validated_continuation_request(payload), expected)
        self.assertEqual(validated_continuation_request({**payload, "kind": "live"}), expected)

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

    def test_original_starting_track_anchors_a_conditioned_data_driven_continuation(self):
        self.plan = self.service.create_plan({"kind": "original", "duration_seconds": 20,
                                             "settings": {"style": "gentle jazz", "bpm": 84,
                                                          "key": "F minor", "instrument_palette": ["piano", "bass"]}})
        original = self.complete(self.generate())
        self.complete_stems(original)
        job = self.service.create_continuation_job(self.payload(source_job_id=original["id"]))
        plan = self.service._read("plans", job["plan_id"])
        chunk = plan["request"]["composition_plan"]["chunks"][0]
        self.assertIsNone(plan["dataset_id"])
        self.assertIsNone(plan["analysis_id"])
        self.assertEqual(plan["baseline"], {})
        self.assertEqual(plan["realtime"]["root_plan_id"], self.plan["id"])
        self.assertTrue(plan["realtime"]["conditioning_applied"])
        self.assertEqual(chunk["conditioning_ref"]["song_id"], "song123")
        for direction in ("gentle jazz", "84 BPM", "F minor", "piano", "bass", "busy percussion"):
            self.assertIn(direction, chunk["positive_styles"])
        self.assertEqual(plan["sections"][0]["activity"], 0.8)
        self.assertEqual(plan["realtime"]["observed_window_seconds"], 5.4)
        self.assertNotIn("activity", self.service._read("plans", self.plan["id"])["sections"][0])
        self.assertEqual(self.service.create_continuation_job(self.payload(source_job_id=original["id"]))["id"], job["id"])
        self.assertEqual(len(self.client.calls), 1, "only the original mock generation has executed")

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

    def test_next_direction_overrides_only_the_new_plan_and_is_idempotent(self):
        anchor_before = copy.deepcopy(self.service._read("plans", self.plan["id"]))
        settings = {"style": "quiet acoustic textures", "bpm": 72, "key": "A minor",
                    "instrument_palette": ["piano", "muted bass"], "enable_variability": True,
                    "context_adherence": "medium", "seed": None}
        payload = self.payload(settings=settings)
        job = self.service.create_continuation_job(payload)
        applied = self.service._read("plans", job["plan_id"])
        chunk = applied["request"]["composition_plan"]["chunks"][0]
        for value in ("quiet acoustic textures", "72 BPM", "A minor", "piano", "muted bass"):
            self.assertIn(value, chunk["positive_styles"])
        self.assertEqual(chunk["context_adherence"], "medium")
        self.assertNotIn("seed", applied["request"])
        self.assertTrue(applied["settings"]["enable_variability"])
        self.assertEqual(applied["realtime"]["generation_settings"], applied["settings"])
        self.assertEqual(self.service._read("plans", self.plan["id"]), anchor_before)
        self.assertEqual(self.service.create_continuation_job(payload)["id"], job["id"])
        changed = copy.deepcopy(payload)
        changed["settings"]["bpm"] = 100
        with self.assertRaisesRegex(ServiceError, "different saved"):
            self.service.create_continuation_job(changed)
        self.assertEqual(len(self.service.jobs()), 1)
        self.assertEqual(self.client.calls, [], "preparing editable direction does not itself call the provider")

    def test_partial_next_direction_keeps_unspecified_anchor_settings(self):
        self.plan["settings"] = {"style": "gentle jazz", "key": "G minor", "instrument_palette": ["piano", "bass"]}
        self.plan = self.service._save("plans", self.plan)
        job = self.service.create_continuation_job(self.payload(settings={"bpm": 123}))
        settings = self.service._read("plans", job["plan_id"])["settings"]
        self.assertEqual(settings["bpm"], 123)
        for name in ("style", "key", "instrument_palette"):
            self.assertEqual(settings[name], self.plan["settings"][name])

    def test_invalid_next_direction_never_creates_a_job(self):
        for settings in (None, [], {"style": ""}, {"style": "x" * 301}, {"key": "x\nsecret"},
                         {"bpm": True}, {"bpm": float("nan")}, {"bpm": 301},
                         {"instrument_palette": "bass"}, {"instrument_palette": [""]},
                         {"negative_styles": ["x"] * 21}, {"seed": False}, {"seed": -1},
                         {"context_adherence": "arbitrary"}, {"enable_variability": 1},
                         {"request": {"model_id": "other"}}):
            status, _ = self.service.dispatch("POST", "/api/elevenlabs/continuations", self.payload(settings=settings))
            self.assertEqual(status, 400, settings)
        self.assertEqual(self.service.jobs(), [])
        self.assertEqual(self.client.calls, [])

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
    def test_long_upload_size_allowance_is_explicit_and_still_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stems.zip"
            source.write_bytes(stem_archive())
            with mock.patch("elevenlabs_realtime.MAX_STEM_BYTES", 5):
                with self.assertRaises(ValueError):
                    extract_stems(source, root / "result", 7200, lambda *_: fixtures.audio_metadata())
                stems = extract_stems(source, root / "larger", 7200, lambda *_: fixtures.audio_metadata(),
                                      max_stem_bytes=10, max_unpacked_bytes=20)
                self.assertEqual(len(stems), 2)
            with self.assertRaises(ValueError):
                extract_stems(source, root / "too-much", 7200, lambda *_: fixtures.audio_metadata(),
                              max_stem_bytes=10, max_unpacked_bytes=10)
            self.assertFalse((root / "too-much").exists())

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

    def test_long_upload_archive_allowance_does_not_remove_download_bound(self):
        source = Path(self.directory.name) / "source.mp3"
        source.write_bytes(b"the-existing-track")
        opener = mock.Mock()
        opener.open.return_value = self.response(stem_archive(), "application/zip")
        with mock.patch("elevenlabs_service.request.build_opener", return_value=opener):
            with self.assertRaisesRegex(GenerationError, "size limit"):
                self.client.separate_stems(source, self.output, "six_stems_v1", max_archive_bytes=5)
        self.assertEqual(opener.open.call_count, 1)
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
