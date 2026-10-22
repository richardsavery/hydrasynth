#!/usr/bin/env python3
"""Offline beat maps measured against known clicks, drift, gaps and seams."""

import math
from pathlib import Path
import shutil
import tempfile
import unittest
import wave

import beat_tracking


class ValidationTests(unittest.TestCase):
    def valid(self):
        return {"schema_version": 1, "state": "complete", "duration_seconds": 12,
                "beats_seconds": [1.3, 1.8, 2.3, 8.1, 8.7, 9.3],
                "active_regions": [{"start_seconds": 1.3, "end_seconds": 2.4},
                                   {"start_seconds": 8.1, "end_seconds": 9.5}],
                "bpm_median": 110, "bpm_min": 100, "bpm_max": 120,
                "source": "mix", "source_sha256": "a" * 64, "audio_sha256": "a" * 64}

    def test_saved_maps_reject_invalid_timestamps_regions_hashes_and_hints(self):
        good = self.valid()
        beat_tracking.validate_beat_analysis(good, 12)
        for change in ({"beats_seconds": [1, float("nan"), 3]}, {"beats_seconds": [1, 2, 2]},
                       {"beats_seconds": [1, 2, 15]}, {"active_regions": []}, {"audio_sha256": "no"},
                       {"bpm_hint": True}, {"bpm_min": float("inf")}, {"duration_seconds": 30},
                       {"first_beat_in_bar": True}, {"first_beat_in_bar": 0}, {"first_beat_in_bar": 5},
                       {"first_beat_in_bar": 2.0}, {"bar_phase_confidence": True},
                       {"bar_phase_confidence": -.01}, {"bar_phase_confidence": 1.01},
                       {"bar_phase_confidence": float("nan")},
                       {"active_regions": [{"start_seconds": 1.3, "end_seconds": 1.5}]}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                beat_tracking.validate_beat_analysis({**good, **change}, 12)
        for state in ("queued", "analyzing", "failed"):
            beat_tracking.validate_beat_analysis({"schema_version": 1, "state": state})
        beat_tracking.validate_beat_analysis({**good, "first_beat_in_bar": 3, "bar_phase_confidence": .75})

    def test_optional_display_metadata_has_bounded_expected_types(self):
        good = self.valid()
        beat_tracking.validate_beat_analysis({**good, "warnings": ["Review the first detected beat."], "error": None})
        beat_tracking.validate_beat_analysis({"schema_version": 1, "state": "failed", "error": "No reliable beat sequence."})
        for change in ({"warnings": "a warning"}, {"warnings": {"message": "a warning"}},
                       {"warnings": [42]}, {"warnings": [None]}, {"warnings": ["x" * 1001]},
                       {"warnings": ["warning"] * 17}, {"warnings": None}, {"error": ["failure"]},
                       {"error": {"message": "failure"}}, {"error": "x" * 2001},
                       {"state": []}, {"source": []}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                beat_tracking.validate_beat_analysis({**good, **change}, 12)


@unittest.skipUnless(beat_tracking.available() and shutil.which("ffmpeg"), "Local beat-analysis dependencies are optional")
class AudioTests(unittest.TestCase):
    def setUp(self):
        import numpy as np
        self.np = np
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "known.wav"

    def analyze_clicks(self, beats, duration, amplitudes=None, **options):
        np = self.np
        sr = beat_tracking.SAMPLE_RATE
        samples = np.zeros(int(duration * sr), dtype=np.float32)
        times = np.arange(int(.08 * sr)) / sr
        pulse = .8 * np.sin(2 * np.pi * 130 * times) * np.exp(-60 * times)
        for index, beat in enumerate(beats):
            start = int(beat * sr)
            amplitude = amplitudes[index] if amplitudes is not None else 1
            samples[start:start + len(pulse)] += amplitude * pulse[:len(samples) - start]
        with wave.open(str(self.path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(sr)
            audio.writeframes((samples * 32767).astype("<i2").tobytes())
        return beat_tracking.analyze(self.path, duration, shutil.which("ffmpeg"), **options)

    def assert_aligned(self, result, expected, tolerance=.065, minimum_recall=.85):
        measured = result["beats_seconds"]
        self.assertGreaterEqual(len(measured), len(expected) * minimum_recall)
        self.assertLessEqual(len(measured), len(expected) * 1.15)
        errors = [min(abs(beat - reference) for reference in expected) for beat in measured]
        self.assertLessEqual(max(errors), tolerance, errors)
        recall = sum(min(abs(beat - measured_beat) for measured_beat in measured) < tolerance for beat in expected) / len(expected)
        self.assertGreaterEqual(recall, minimum_recall)

    def test_leading_silence_pause_and_changed_tempo(self):
        first = [1.37 + index * .5 for index in range(24)]
        second = [17.17 + index * .66 for index in range(24)]
        result = self.analyze_clicks(first + second, 34)
        self.assert_aligned(result, first + second)
        self.assertAlmostEqual(result["beats_seconds"][0], first[0], delta=.065)
        self.assertEqual(len(result["active_regions"]), 2)
        self.assertFalse(any(13.1 < beat < 17 for beat in result["beats_seconds"]))
        self.assertLess(result["bpm_min"], 95)
        self.assertGreater(result["bpm_max"], 115)
        # Equal clicks provide no musical bar accent; automatic timing still
        # chooses a deterministic groove start without inventing confidence.
        self.assertEqual(result["first_beat_in_bar"], 1)
        self.assertEqual(result["bar_phase_confidence"], 0)

    def test_recurring_accent_aligns_pickup_to_four_beat_groove_without_hint(self):
        beats = [1.37 + index * .5 for index in range(48)]
        # The file begins on beat 3: two quieter beats precede the first clear
        # downbeat. This must not need a BPM hint or manual first-beat setting.
        amplitudes = [1 if index % 4 == 2 else .55 for index in range(len(beats))]
        result = self.analyze_clicks(beats, 26, amplitudes=amplitudes)
        self.assert_aligned(result, beats)
        self.assertAlmostEqual(result["beats_seconds"][0], beats[0], delta=.065)
        self.assertEqual(result["first_beat_in_bar"], 3)
        self.assertGreater(result["bar_phase_confidence"], .25)

    def test_ambiguous_or_inconsistent_accents_have_automatic_fallback(self):
        for accents in ([1, .5, 1, .5] * 8, [1, 1, 1, 1] * 8, [1, .2, .2, .2] * 2,
                        [1, .4, .4, .4, .4, 1, .4, .4, .4, .4, 1, .4, .4, .4, .4, 1] * 2):
            with self.subTest(accents=accents):
                self.assertEqual(beat_tracking._estimate_bar_phase(accents), (1, 0))

    def test_continuous_tempo_drift_and_non_grid_timing(self):
        beats, position = [], 1.13
        for index in range(72):
            beats.append(position)
            position += .45 + index * .003 + .012 * math.sin(index * .7)
        result = self.analyze_clicks(beats, position + 1)
        self.assert_aligned(result, beats)
        intervals = self.np.diff(result["beats_seconds"])
        self.assertGreater(self.np.median(intervals[-12:]), self.np.median(intervals[:12]) + .12)

    def test_window_seam_has_no_duplicate_or_missing_beat(self):
        beats = [1.29 + index * .53 for index in range(140)]
        progress = []
        result = self.analyze_clicks(beats, 77, progress=progress.append)
        self.assert_aligned(result, beats)
        self.assertEqual(len(progress), 2)
        self.assertEqual(progress[-1], 1)
        # Keep the comparison boundary between clicks, away from the 58.000s
        # click whose sub-millisecond measured offset can cross a strict bound.
        seam = [beat for beat in result["beats_seconds"] if 58.1 < beat < 62.1]
        self.assertEqual(len(seam), len([beat for beat in beats if 58.1 < beat < 62.1]))
        self.assertTrue(all(.45 < b - a < .62 for a, b in zip(seam, seam[1:])))

    def test_silence_rejected_without_a_fabricated_grid(self):
        with self.assertRaisesRegex(ValueError, "No reliable beat sequence"):
            self.analyze_clicks([], 4)


if __name__ == "__main__":
    unittest.main()
