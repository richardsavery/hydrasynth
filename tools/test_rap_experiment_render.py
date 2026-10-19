#!/usr/bin/env python3
"""Offline audible-property checks for the independent rap comparisons."""

from array import array
import builtins
import io
import math
import sys
import time
import unittest
from unittest.mock import patch
import wave

import numpy as np

from rap_experiment_render import (MELODY_PATTERNS, _autotune, _flow_audio, _voice_pitch, match_loudness,
                                   render_experiment, render_fast_voice, stretch_phrase)

RATE = 24000


def decode(data):
    with wave.open(io.BytesIO(data), "rb") as source:
        channels, rate = source.getnchannels(), source.getframerate()
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(float) / 32768
    return samples.reshape(-1, channels), rate


def voice(seconds, frequency=173, amplitude=.28):
    t = np.arange(round(seconds * RATE)) / RATE
    # Harmonics, varied syllabic envelope and breath make this more revealing
    # than a constant sinusoid: WSOLA must retain pitch and moving structure.
    envelope = .55 + .45 * np.sin(2 * np.pi * 2.7 * t) ** 2
    harmonic = np.sin(2 * np.pi * frequency * t) + .32 * np.sin(2 * np.pi * frequency * 2 * t) + .15 * np.sin(2 * np.pi * frequency * 3 * t)
    return amplitude * envelope * harmonic


def fixture(lines=("Move with the rhythm", "Keep it on the beat"), durations=(1.8, 2.3)):
    chars, starts, ends, segments = [], [], [], []
    elapsed = 0.0
    for number, (line, duration) in enumerate(zip(lines, durations)):
        if number:
            chars.append("\n"); starts.append(elapsed); ends.append(elapsed)
        step = duration / len(line)
        for index, char in enumerate(line):
            chars.append(char)
            starts.append(elapsed + index * step)
            ends.append(elapsed + (index + 1) * step)
        segments.append(voice(duration, 173 if number == 0 else 227))
        elapsed += duration
        segments.append(np.zeros(round(.060 * RATE)))
        chars.append(" "); starts.append(elapsed); ends.append(elapsed + .060)
        elapsed += .060
    pcm = np.round(np.concatenate(segments) * 32767).astype("<i2").tobytes()
    alignment = {"characters": chars, "character_start_times_seconds": starts,
                 "character_end_times_seconds": ends}
    return pcm, alignment, "\n".join(lines)


def dominant_frequency(samples, low=100, high=600):
    samples = np.asarray(samples)
    spectrum = abs(np.fft.rfft(samples * np.hanning(len(samples))))
    frequencies = np.fft.rfftfreq(len(samples), 1 / RATE)
    indices = np.flatnonzero((frequencies >= low) & (frequencies <= high))
    return frequencies[indices[np.argmax(spectrum[indices])]]


class RapExperimentRenderTests(unittest.TestCase):
    def test_wsola_preserves_pitch_for_compression_and_expansion(self):
        for factor in (.8, .9, 1.12, 1.25):
            with self.subTest(factor=factor):
                source = voice(2.2)
                rendered = stretch_phrase(source, round(len(source) * factor), RATE)
                self.assertEqual(len(rendered), round(len(source) * factor))
                self.assertAlmostEqual(dominant_frequency(rendered), 173, delta=1.5)
                # Detect dropouts/failed overlap-add, ignoring finite ends.
                rms = np.sqrt(np.mean(rendered[:len(rendered) // 480 * 480].reshape(-1, 480) ** 2, axis=1))
                self.assertGreater(float(np.min(rms[2:-2])), .065)
                self.assertLess(float(np.max(abs(rendered))), .5)
                # Explicit final grain retains the entire finite source tail.
                np.testing.assert_array_equal(rendered[-200:], source[-200:])

    def test_bar_fitting_keeps_phrases_whole_on_successive_bars(self):
        pcm, alignment, text = fixture()
        wav, result = render_experiment(pcm, alignment, text=text, bpm=120)
        output, rate = decode(wav)
        self.assertEqual(rate, RATE)
        self.assertEqual(output.shape, (RATE * 4, 1))
        self.assertEqual(result["bars"], 2)
        self.assertEqual([item["bar"] for item in result["phrase_timings"]], [0, 1])
        self.assertEqual([item["audio_start"] for item in result["phrase_timings"]], [0, 2])
        self.assertEqual([item["word"] for item in result["word_timings"]], text.split())
        self.assertTrue(result["word_timings_estimated"])
        self.assertTrue(all(.8 <= phrase["stretch_ratio"] <= 1.25 for phrase in result["phrase_timings"]))
        self.assertAlmostEqual(dominant_frequency(output[RATE // 4:RATE * 7 // 4, 0]), 173, delta=1.5)
        self.assertAlmostEqual(dominant_frequency(output[RATE * 9 // 4:RATE * 15 // 4, 0]), 227, delta=1.5)
        # The second phrase has no added quarter-beat pause before its bar.
        self.assertLess(result["phrase_timings"][1]["start"] - 2, .04)

    def test_normalized_alignment_recovers_typed_line_boundary(self):
        pcm, alignment, text = fixture()
        alignment["characters"] = [" " if char == "\n" else char for char in alignment["characters"]]
        _, result = render_experiment(pcm, {"normalized_alignment": alignment}, text=text, bpm=120)
        self.assertEqual(len(result["phrase_timings"]), 2)

    def test_explicit_lines_override_commas_and_long_internal_breaths(self):
        lines = ("Signals rise, we find the flow", "Turn the dial and let it go",
                 "Bass and motion, light and sound", "Keep the rhythm moving round")
        pcm, alignment, text = fixture(lines, (1.8, 2.1, 1.9, 2.0))
        # A long breath inside the first line must not become its own bar.
        comma = alignment["characters"].index(",")
        breath_at = round(alignment["character_end_times_seconds"][comma] * RATE)
        pcm = pcm[:breath_at * 2] + b"\x00\x00" * round(.4 * RATE) + pcm[breath_at * 2:]
        for key in ("character_start_times_seconds", "character_end_times_seconds"):
            alignment[key] = [value + (.4 if index > comma else 0) for index, value in enumerate(alignment[key])]
        # Also verify line recovery when provider-normalized text is one line.
        alignment["characters"] = [" " if char == "\n" else char for char in alignment["characters"]]
        wav, result = render_experiment(pcm, alignment, text=text, bpm=120)
        phrases = result["phrase_timings"]
        self.assertEqual(len(phrases), 4)
        self.assertEqual([phrase["word_count"] for phrase in phrases], [len(line.split()) for line in lines])
        self.assertEqual([phrase["bar"] for phrase in phrases], [0, 1, 2, 3])
        self.assertEqual(len(decode(wav)[0]), RATE * 8)
        self.assertEqual(phrases[0]["source_audio_start"], 0)
        self.assertEqual(phrases[-1]["source_audio_end"], len(pcm) / 2 / RATE)
        for left, right in zip(phrases, phrases[1:]):
            self.assertEqual(left["source_audio_end"], right["source_audio_start"])
        self.assertEqual(len(result["word_timings"]), sum(len(line.split()) for line in lines))

    def test_single_line_keeps_punctuation_grouping(self):
        pcm, alignment, text = fixture(("Signals rise, we find the flow",), (3.0,))
        _, result = render_experiment(pcm, alignment, text=text, bpm=120)
        self.assertEqual(len(result["phrase_timings"]), 2)

    def test_overlapping_line_timestamps_are_never_cut(self):
        pcm, alignment, text = fixture(("One line", "Next line"), (1.8, 1.8))
        boundary = alignment["characters"].index("\n")
        # Remove the provider's silent gap from its estimates only, creating
        # overlap at the line edge. Keeping one chunk protects both word tails.
        for key in ("character_start_times_seconds", "character_end_times_seconds"):
            alignment[key] = [value - (.07 if index >= boundary else 0) for index, value in enumerate(alignment[key])]
        # Space/newline alignment still must be monotonic to be valid input.
        for key in ("character_start_times_seconds", "character_end_times_seconds"):
            for index in range(1, len(alignment[key])):
                alignment[key][index] = max(alignment[key][index], alignment[key][index - 1])
        _, result = render_experiment(pcm, alignment, text=text, bpm=120)
        self.assertEqual(len(result["phrase_timings"]), 1)

    def test_short_phrases_pad_instead_of_extreme_stretch(self):
        pcm, alignment, text = fixture(("Short line",), (.6,))
        wav, result = render_experiment(pcm, alignment, text=text, bpm=120)
        self.assertEqual(len(decode(wav)[0]), RATE * 2)
        self.assertEqual(result["phrase_timings"][0]["stretch_ratio"], 1)
        self.assertGreater(result["phrase_timings"][0]["padding_seconds"], 1)
        self.assertTrue(result["warnings"])
        output, _ = decode(wav)
        source = np.frombuffer(pcm, dtype="<i2").astype(float)
        # Gain matching is allowed; timing and complete internal PCM remain.
        active = abs(source) > 100
        ratios = output[:len(source), 0][active] / source[active]
        self.assertLess(float(np.std(ratios) / np.mean(ratios)), .005)

    def test_natural_and_phrase_baselines_are_gain_matched(self):
        pcm, alignment, text = fixture()
        for timing in ("natural", "phrase_beats", "bars"):
            wav, result = render_experiment(pcm, alignment, text=text, bpm=120, timing_mode=timing)
            self.assertAlmostEqual(result["loudness"]["achieved_dbfs"], -20, places=5)
            self.assertLessEqual(float(np.max(abs(decode(wav)[0]))), 10 ** (-1 / 20))

    def test_production_changes_tone_and_dynamics_without_clipping(self):
        pcm, alignment, text = fixture(("A performed voice with a quiet and loud passage",), (4.,))
        source = np.frombuffer(pcm, dtype="<i2").copy()
        source[:RATE * 2] = (source[:RATE * 2] * .18).astype("<i2")
        dry, dry_result = render_experiment(source.tobytes(), alignment, text=text, bpm=120, timing_mode="natural")
        produced, result = render_experiment(source.tobytes(), alignment, text=text, bpm=120, timing_mode="natural", produced=True)
        before, _ = decode(dry); after, _ = decode(produced)
        self.assertEqual(after.shape[1], 2)
        self.assertEqual(len(before), len(after))
        def contrast(samples):
            low = np.sqrt(np.mean(samples[RATE // 2:RATE * 3 // 2] ** 2))
            high = np.sqrt(np.mean(samples[RATE * 5 // 2:RATE * 7 // 2] ** 2))
            return 20 * np.log10(high / low)
        self.assertLess(contrast(after), contrast(before) - 3)
        self.assertLess(float(np.corrcoef(after[:4 * RATE].T)[0, 1]), .9999)
        self.assertTrue(result["production"]["doubling"])
        self.assertLessEqual(float(np.max(abs(after))), 10 ** (-1 / 20))
        self.assertAlmostEqual(result["loudness"]["achieved_dbfs"], dry_result["loudness"]["achieved_dbfs"], delta=.1)
        mono, mono_result = render_experiment(source.tobytes(), alignment, text=text, bpm=120, produced=True, doubling=False)
        self.assertEqual(decode(mono)[0].shape[1], 1)
        self.assertFalse(mono_result["production"]["doubling"])

    def test_loudness_matching_ignores_added_silent_bars_and_reports_peak_limit(self):
        pcm, alignment, text = fixture(("one two",), (.8,))
        fast, fast_result = render_experiment(pcm, alignment, text=text, bpm=240, timing_mode="natural")
        slow, slow_result = render_experiment(pcm, alignment, text=text, bpm=40, timing_mode="natural")
        np.testing.assert_array_equal(decode(fast)[0], decode(slow)[0][:len(decode(fast)[0])])
        self.assertEqual(fast_result["loudness"], slow_result["loudness"])
        with io.BytesIO() as buffer:
            with wave.open(buffer, "wb") as target:
                target.setnchannels(1); target.setsampwidth(2); target.setframerate(RATE)
                pulse = np.zeros(RATE, dtype="<i2"); pulse[0] = 32767
                target.writeframes(pulse.tobytes())
            audio, metadata = match_loudness(buffer.getvalue())
        self.assertTrue(metadata["peak_limited"])
        self.assertLess(metadata["achieved_dbfs"], -20)
        self.assertLessEqual(float(np.max(abs(decode(audio)[0]))), 10 ** (-1 / 20))

    def test_expressive_direction_alignment_does_not_create_spoken_tag_words(self):
        pcm, alignment, text = fixture(("Feel the rhythm",), (1.8,))
        tag = list("[energetic] ")
        alignment["characters"] = tag + alignment["characters"]
        for key in ("character_start_times_seconds", "character_end_times_seconds"):
            alignment[key] = [0.] * len(tag) + alignment[key]
        _, result = render_experiment(pcm, alignment, text=text, bpm=120)
        self.assertEqual([word["word"] for word in result["word_timings"]], text.split())

    def test_small_final_word_alignment_overrun_is_bounded_and_reported(self):
        # Real v4 response: 8.8 seconds of PCM, final 'd' at 8.6..8.88.
        # A short synthetic fixture reproduces that same 80 ms endpoint drift.
        pcm, alignment, text = fixture(("moving round",), (1.8,))
        duration = len(pcm) / 2 / RATE
        final_letter = len(alignment["characters"]) - 2
        alignment["character_end_times_seconds"][final_letter] = duration + .08
        alignment["character_start_times_seconds"][-1] = duration + .08
        alignment["character_end_times_seconds"][-1] = duration + .08
        for mode, produced in (("natural", False), ("phrase_beats", False), ("bars", False), ("bars", True)):
            with self.subTest(mode=mode, produced=produced):
                wav, result = render_experiment(pcm, alignment, text=text, bpm=120, timing_mode=mode, produced=produced)
                self.assertAlmostEqual(result["alignment_end_clamped_seconds"], .08)
                self.assertTrue(any("80 ms" in item for item in result["warnings"]))
                self.assertEqual(result["word_timings"][-1]["source_end"], duration)
                self.assertGreaterEqual(result["duration_seconds"], duration)
        # Correction must not mutate the original provider response.
        self.assertAlmostEqual(alignment["character_end_times_seconds"][final_letter], duration + .08)
        for index in (final_letter, final_letter + 1):
            alignment["character_end_times_seconds"][index] = duration + .5
        with self.assertRaises(ValueError):
            render_experiment(pcm, alignment, text=text, bpm=120)

    def test_terminal_adjustment_does_not_accept_nonterminal_or_corrupt_times(self):
        pcm, alignment, text = fixture(("first last",), (1.8,))
        duration = len(pcm) / 2 / RATE
        # A final word completely outside the recording is not timestamp drift.
        word_start = len("first ")
        for index in range(word_start, len(alignment["characters"])):
            alignment["character_start_times_seconds"][index] = duration + .01
            alignment["character_end_times_seconds"][index] = duration + .08
        with self.assertRaisesRegex(ValueError, "starting inside"):
            render_experiment(pcm, alignment, text=text, bpm=120)
        pcm, alignment, text = fixture(("first last",), (1.8,))
        alignment["character_end_times_seconds"][4] = duration + .02
        alignment["character_end_times_seconds"][5] = duration + .03
        for index in range(6, len(alignment["characters"])):
            alignment["character_start_times_seconds"][index] = duration - .04
            alignment["character_end_times_seconds"][index] = duration + .08
        with self.assertRaisesRegex(ValueError, "Only a final word"):
            render_experiment(pcm, alignment, text=text, bpm=120)
        pcm, alignment, text = fixture(("first last",), (1.8,))
        alignment["character_start_times_seconds"][2] = -1
        with self.assertRaises(ValueError):
            render_experiment(pcm, alignment, text=text, bpm=120)
        pcm, alignment, text = fixture(("first last",), (1.8,))
        alignment["character_end_times_seconds"][2] = alignment["character_start_times_seconds"][2] - .01
        with self.assertRaises(ValueError):
            render_experiment(pcm, alignment, text=text, bpm=120)

    def test_original_modes_remain_available_without_numpy(self):
        pcm, alignment, text = fixture(("No dependency",), (1.,))
        original_import = builtins.__import__
        def importing(name, *args, **kwargs):
            if name == "numpy":
                raise ImportError("test missing optional dependency")
            return original_import(name, *args, **kwargs)
        with patch("builtins.__import__", importing):
            render_experiment(pcm, alignment, text=text, bpm=120, timing_mode="natural")
            with self.assertRaisesRegex(RuntimeError, "need NumPy"):
                render_experiment(pcm, alignment, text=text, bpm=120)

    def test_limits_are_enforced_before_allocating_output(self):
        pcm, alignment, text = fixture()
        for kwargs in ({"bpm": 0}, {"bpm": 120, "sample_rate": True}, {"bpm": 120, "timing_mode": "word_slices"}):
            with self.assertRaises(ValueError):
                render_experiment(pcm, alignment, text=text, **kwargs)
        with self.assertRaises(ValueError):
            stretch_phrase(voice(1), RATE * 2, RATE)
        with self.assertRaisesRegex(ValueError, "120-second"):
            render_experiment(b"\x00\x00" * (RATE * 121), alignment, text=text, bpm=120)


class FastRobotRenderTests(unittest.TestCase):
    def test_rhythm_modes_preserve_natural_audio_and_phrase_baseline(self):
        pcm, alignment, text = fixture()
        for rhythm, timing in (("natural", "natural"), ("phrases", "phrase_beats")):
            with self.subTest(rhythm=rhythm):
                expected, original = render_experiment(pcm, alignment, text=text, bpm=113, timing_mode=timing)
                dry, metadata = render_fast_voice(pcm, alignment, text=text, bpm=113, robot_rhythm=rhythm)
                self.assertEqual(dry, expected)
                self.assertEqual(metadata["word_timings"], original["word_timings"])
                self.assertEqual(metadata["rhythm_mode"], rhythm)
        for rhythm in ("natural", "phrases", "flow"):
            dry, _ = render_fast_voice(pcm, alignment, text=text, bpm=113, robot_rhythm=rhythm)
            bypass, _ = render_fast_voice(pcm, alignment, text=text, bpm=113, robot_rhythm=rhythm,
                                          robot=True, robot_style="autotune", robot_amount=0)
            self.assertEqual(dry, bypass)

    def test_flow_aligns_complete_lines_without_overlaps_and_keeps_source_tails(self):
        lines = ("Signals rise, we find the flow", "Turn the dial and let it go", "Bass and motion, light and sound")
        pcm, alignment, text = fixture(lines, (1.83, 2.32, 1.91))
        alignment["characters"] = [" " if char == "\n" else char for char in alignment["characters"]]
        samples = np.frombuffer(pcm, dtype="<i2").astype(float) / 32768
        # Distinct low-level sound across each final grain catches accidental
        # truncation of non-silent phrase tails instead of merely testing zeros.
        samples[-400:] = .01 * np.arange(400) / 400
        output, result = _flow_audio(samples, alignment, text, 113, RATE)
        phrases = result["phrase_timings"]
        self.assertEqual(len(phrases), len(lines))
        self.assertEqual([item["word_count"] for item in phrases], [len(line.split()) for line in lines])
        self.assertTrue(result["word_timings_estimated"])
        self.assertEqual(phrases[0]["source_audio_start"], 0)
        self.assertEqual(phrases[-1]["source_audio_end"], len(samples) / RATE)
        for phrase in phrases:
            self.assertAlmostEqual(phrase["start"] * 113 / 60, round(phrase["start"] * 113 / 60), delta=113 / 60 / RATE)
            self.assertTrue(.8 <= phrase["stretch_ratio"] <= 1.25)
            self.assertEqual(phrase["fit_beats"], round(phrase["fit_beats"]))
            target = round(phrase["audio_end"] * RATE)
            source = round(phrase["source_audio_end"] * RATE)
            fade = phrase["fade_out_frames"]
            np.testing.assert_array_equal(output[target - 200:target - fade], samples[source - 200:source - fade])
            if fade:
                np.testing.assert_array_equal(output[target - fade:target], samples[source - fade:source] * np.linspace(1, 0, fade))
        for left, right in zip(phrases, phrases[1:]):
            self.assertEqual(left["source_audio_end"], right["source_audio_start"])
            self.assertLessEqual(left["audio_end"], right["audio_start"])
        self.assertEqual([item["word"] for item in result["word_timings"]], text.replace(",", "").split())
        for word in result["word_timings"]:
            phrase = phrases[word["phrase"]]
            self.assertGreaterEqual(word["start"], phrase["audio_start"] - 1 / RATE)
            self.assertLessEqual(word["end"], phrase["audio_end"] + 1 / RATE)

    def test_flow_half_beat_fallback_and_tiny_unstretched_phrase(self):
        for duration, expected_fit in ((.24, .5), (.06, None)):
            with self.subTest(duration=duration):
                pcm, alignment, text = fixture(("Hi",), (duration,))
                _, result = render_fast_voice(pcm, alignment, text=text, bpm=120, robot_rhythm="flow")
                phrase = result["phrase_timings"][0]
                self.assertEqual(phrase["fit_beats"], expected_fit)
                self.assertEqual(result["word_timings_estimated"], expected_fit is not None)
                if expected_fit is None:
                    self.assertEqual(phrase["stretch_ratio"], 1)

    def test_flow_keeps_overlapping_line_estimates_together(self):
        pcm, alignment, text = fixture(("One line", "Next line"), (1.8, 1.8))
        boundary = alignment["characters"].index("\n")
        for key in ("character_start_times_seconds", "character_end_times_seconds"):
            alignment[key] = [value - (.07 if index >= boundary else 0) for index, value in enumerate(alignment[key])]
            for index in range(1, len(alignment[key])):
                alignment[key][index] = max(alignment[key][index], alignment[key][index - 1])
        _, result = render_fast_voice(pcm, alignment, text=text, bpm=120, robot_rhythm="flow")
        self.assertEqual(len(result["phrase_timings"]), 1)

    def test_retimed_effects_reach_final_phrase_and_added_silence_stays_silent(self):
        pcm, alignment, text = fixture(("One quick phrase", "Another line", "And a last phrase"), (.75, .85, .79))
        for rhythm in ("phrases", "flow"):
            with self.subTest(rhythm=rhythm):
                dry, original = render_fast_voice(pcm, alignment, text=text, bpm=83, robot_rhythm=rhythm)
                tuned, result = render_fast_voice(pcm, alignment, text=text, bpm=83, robot_rhythm=rhythm,
                                                 robot=True, robot_style="autotune", robot_amount=1,
                                                 robot_melody="drone", robot_octave=3)
                output, _ = decode(tuned)
                self.assertEqual(result["word_timings"], original["word_timings"])
                self.assertEqual(len(output), len(decode(dry)[0]))
                cursor = 0
                for phrase in result["phrase_timings"]:
                    first, last = round(phrase["audio_start"] * RATE), round(phrase["audio_end"] * RATE)
                    np.testing.assert_array_equal(output[cursor:first], 0)
                    cursor = last
                np.testing.assert_array_equal(output[cursor:], 0)
                last = result["phrase_timings"][-1]
                first_frame = round(max(last["start"] + .12, len(pcm) / 2 / RATE + .03) * RATE)
                last_frame = round((last["end"] - .12) * RATE)
                self.assertGreater(first_frame, len(pcm) // 2)
                self.assertGreater(last_frame - first_frame, .08 * RATE)
                centers, pitches, _ = _voice_pitch(output[first_frame:last_frame, 0], RATE)
                self.assertAlmostEqual(float(np.median(pitches[pitches > 0])), 130.813, delta=1.5)
                self.assertLessEqual(float(np.max(np.abs(output))), 10 ** (-1 / 20))

    def test_flow_processing_is_local_and_quick_for_a_short_verse(self):
        pcm, alignment, text = fixture(("First line", "Second line", "Third line", "Final line"), (1.8, 1.7, 1.9, 1.6))
        started = time.perf_counter()
        render_fast_voice(pcm, alignment, text=text, bpm=100, robot_rhythm="flow", robot=True,
                          robot_style="autotune", robot_melody="two_note", robot_octave=3)
        self.assertLess(time.perf_counter() - started, 2.5)

    def test_fast_is_continuous_dry_and_zero_robot_is_exact_bypass(self):
        pcm, alignment, text = fixture()
        expected, original = render_experiment(pcm, alignment, text=text, bpm=120, timing_mode="natural")
        dry, metadata = render_fast_voice(pcm, alignment, text=text, bpm=120)
        self.assertEqual(dry, expected)
        self.assertEqual(metadata["word_timings"], original["word_timings"])
        for style in ("metallic", "radio", "vocoder", "autotune"):
            bypass, result = render_fast_voice(pcm, alignment, text=text, bpm=120, robot=True,
                                               robot_style=style, robot_amount=0, robot_tone_hz=800)
            self.assertEqual(bypass, dry)
            self.assertFalse(result["robot"]["applied"])

    def test_robot_presets_change_spectrum_preserve_envelope_and_timing(self):
        pcm, alignment, text = fixture()
        dry, original = render_fast_voice(pcm, alignment, text=text, bpm=120)
        before, _ = decode(dry)
        block = 480
        def powers(samples):
            return np.mean(samples[:len(samples) // block * block].reshape(-1, block) ** 2, axis=1)
        source_frames = len(pcm) // 2
        source_power = powers(before[:source_frames, 0])
        methods = set()
        for style in ("metallic", "radio", "vocoder"):
            with self.subTest(style=style):
                rendered, result = render_fast_voice(pcm, alignment, text=text, bpm=120, robot=True,
                                                     robot_style=style, robot_amount=1)
                after, rate = decode(rendered)
                self.assertEqual(after.shape, before.shape)
                self.assertEqual(rate, RATE)
                self.assertEqual(result["word_timings"], original["word_timings"])
                self.assertEqual(result["speech_duration_seconds"], original["speech_duration_seconds"])
                self.assertTrue(np.isfinite(after).all())
                self.assertLessEqual(float(np.max(abs(after))), 10 ** (-1 / 20))
                self.assertAlmostEqual(result["loudness"]["achieved_dbfs"], -20, delta=.5)
                self.assertLess(abs(float(np.corrcoef(before[:source_frames, 0], after[:source_frames, 0])[0, 1])), .95)
                after_power = powers(after[:source_frames, 0])
                self.assertGreater(float(np.corrcoef(source_power, after_power)[0, 1]), .65)
                # Every active source block remains audible; no hard gate chops
                # low syllables. This is an envelope proxy, not an ASR claim.
                self.assertGreater(float(np.min(after_power[source_power > .005])), .00001)
                np.testing.assert_array_equal(after[source_frames:], np.zeros_like(after[source_frames:]))
                self.assertGreaterEqual(result["processing_seconds"], 0)
                methods.add(result["robot"]["method"])
        self.assertEqual(len(methods), 3)

    def test_vocoder_uses_fixed_harmonic_carrier_instead_of_source_pitch(self):
        pcm, alignment, text = fixture(("A continuous robotic voice",), (2.,))
        rendered, result = render_fast_voice(pcm, alignment, text=text, bpm=120,
                                             robot=True, robot_style="vocoder", robot_amount=1)
        samples = decode(rendered)[0][RATE // 4:RATE * 7 // 4, 0]
        peak = dominant_frequency(samples, low=100, high=900)
        carrier = result["robot"]["carrier_hz"]
        self.assertAlmostEqual(peak / carrier, round(peak / carrier), delta=.025)
        self.assertEqual(result["robot"]["analysis_bands"], 12)
        self.assertEqual(result["robot"]["method"], "multiband_envelope_vocoder")

    def test_tone_control_reduces_high_frequency_energy(self):
        pcm, alignment, text = fixture(("Clear and bright robot",), (2.,))
        count = len(pcm) // 2
        seconds = np.arange(count) / RATE
        signal = .15 * (np.sin(2 * np.pi * 173 * seconds) + np.sin(2 * np.pi * 2700 * seconds)
                        + np.sin(2 * np.pi * 5800 * seconds))
        pcm = np.round(signal * 32767).astype("<i2").tobytes()
        power = []
        for tone in (800, 8000):
            rendered, _ = render_fast_voice(pcm, alignment, text=text, bpm=120, robot=True,
                                            robot_tone_hz=tone, robot_amount=1)
            samples = decode(rendered)[0][:count, 0]
            spectrum = np.abs(np.fft.rfft(samples)) ** 2
            frequency = np.fft.rfftfreq(len(samples), 1 / RATE)
            power.append(np.sum(spectrum[frequency > 2000]) / np.sum(spectrum))
        self.assertLess(power[0], power[1] * .05)

    def test_radio_quantizer_keeps_quiet_syllables_audible(self):
        pcm, alignment, text = fixture(("quiet syllables then a louder word",), (2.,))
        source = np.frombuffer(pcm, dtype="<i2").copy()
        source[:RATE] = np.round(source[:RATE] * .02).astype("<i2")
        rendered, _ = render_fast_voice(source.tobytes(), alignment, text=text, bpm=120,
                                        robot=True, robot_style="radio", robot_amount=1)
        quiet = decode(rendered)[0][RATE // 4:RATE * 3 // 4, 0]
        # Six-bit quantization alone would round this entire quiet vowel to
        # zero. The parallel continuous path preserves it at full robot amount.
        powers = np.mean(quiet.reshape(-1, 480) ** 2, axis=1)
        self.assertGreater(float(np.min(powers)), 1e-8)

    def test_silence_stays_silent_and_other_sample_rates_are_supported(self):
        pcm, alignment, text = fixture(("quiet",), (.5,))
        for style in ("metallic", "radio", "vocoder"):
            for rate in (8000, 16000, 48000):
                silent_pcm = b"\x00\x00" * round(len(pcm) / 2 / RATE * rate)
                rendered, result = render_fast_voice(silent_pcm, alignment, text=text, bpm=120,
                                                     sample_rate=rate, robot=True, robot_style=style)
                samples, actual_rate = decode(rendered)
                self.assertEqual(actual_rate, rate)
                self.assertFalse(samples.any())
                self.assertIsNone(result["loudness"]["achieved_dbfs"])

    def test_robot_controls_reject_invalid_values_before_processing(self):
        pcm, alignment, text = fixture()
        for invalid in ({"robot_amount": float("nan")}, {"robot_amount": True},
                        {"robot_amount": -1}, {"robot_amount": 1.1},
                        {"robot_tone_hz": float("inf")}, {"robot_tone_hz": 799},
                        {"robot_tone_hz": 8001}, {"robot_style": "pitch"}, {"robot": "false"},
                        {"robot_key": True}, {"robot_key": 12}, {"robot_key": -1},
                        {"robot_key": 2.5}, {"robot_scale": "dorian"},
                        {"robot_melody": "random"}, {"robot_melody": {}},
                        {"robot_octave": 1}, {"robot_octave": 6}, {"robot_octave": True},
                        {"robot_octave": 3.5}, {"robot_note_beats": True},
                        {"robot_note_beats": .75}, {"robot_note_beats": float("nan")},
                        {"robot_rhythm": "words"}, {"robot_rhythm": {}}, {"robot_rhythm": True}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                render_fast_voice(pcm, alignment, text=text, bpm=120, **invalid)

    def test_fast_dry_and_bypass_work_without_optional_numpy(self):
        pcm, alignment, text = fixture()
        original_import = builtins.__import__
        def importing(name, *args, **kwargs):
            if name == "numpy":
                raise ImportError("test missing optional dependency")
            return original_import(name, *args, **kwargs)
        with patch("builtins.__import__", importing):
            dry, _ = render_fast_voice(pcm, alignment, text=text, bpm=120)
            bypass, _ = render_fast_voice(pcm, alignment, text=text, bpm=120, robot=True, robot_amount=0)
            self.assertEqual(dry, bypass)
            with self.assertRaisesRegex(RuntimeError, "need NumPy"):
                render_fast_voice(pcm, alignment, text=text, bpm=120, robot=True)


class AutotuneRenderTests(unittest.TestCase):
    def test_voiced_pitches_snap_to_scale_notes_across_voice_registers(self):
        for frequency, expected in ((91, 87.307), (126, 130.813), (173, 174.614),
                                    (203, 207.652), (227, 233.082), (317, 311.127), (477, 466.164)):
            with self.subTest(frequency=frequency):
                source = voice(2.5, frequency=frequency)
                corrected, result = _autotune(source, RATE, 0, "minor")
                measured = dominant_frequency(corrected[RATE // 2:-RATE // 2], low=65, high=600)
                self.assertAlmostEqual(measured, expected, delta=.8)
                self.assertEqual(len(corrected), len(source))
                self.assertGreater(result["voiced_fraction"], .90)
                self.assertEqual(result["method"], "pitch_synchronous_note_correction")
                self.assertLess(float(np.max(np.abs(corrected))), .6)

    def test_key_and_scale_choose_different_allowed_targets(self):
        source = voice(2, frequency=203)
        minor, minor_metadata = _autotune(source, RATE, 0, "minor")
        major, major_metadata = _autotune(source, RATE, 0, "major")
        for output, expected in ((minor, 207.652), (major, 195.998)):
            self.assertAlmostEqual(dominant_frequency(output[RATE // 4:-RATE // 4]), expected, delta=.8)
        self.assertEqual(minor_metadata["target_midi_notes"], [56])
        self.assertEqual(major_metadata["target_midi_notes"], [55])
        source = voice(2, frequency=269)
        for key, expected in ((0, 261.626), (1, 277.183)):
            output, metadata = _autotune(source, RATE, key, "major")
            self.assertAlmostEqual(dominant_frequency(output[RATE // 4:-RATE // 4]), expected, delta=.8)
            self.assertEqual(metadata["key"], key)
            self.assertEqual(metadata["scale"], "major")
        chromatic, metadata = _autotune(voice(2, frequency=227), RATE, 0, "chromatic")
        self.assertAlmostEqual(dominant_frequency(chromatic[RATE // 4:-RATE // 4]), 233.082, delta=.8)
        self.assertEqual(metadata["scale"], "chromatic")

    def test_pitch_sweep_follows_notes_instead_of_a_fixed_carrier(self):
        time_axis = np.arange(RATE * 3) / RATE
        frequency = 190 + 55 * time_axis / 3
        phase = np.cumsum(frequency) * 2 * np.pi / RATE
        source = .25 * (np.sin(phase) + .25 * np.sin(2 * phase))
        output, metadata = _autotune(source, RATE, 0, "minor")
        _, detected, _ = _voice_pitch(output, RATE)
        for seconds, target in ((.40, 195.998), (1.15, 207.652), (2.30, 233.082)):
            neighborhood = detected[round((seconds - .08) * 100):round((seconds + .08) * 100)]
            self.assertAlmostEqual(float(np.median(neighborhood)), target, delta=1.2)
        self.assertEqual(metadata["target_midi_notes"], [55, 56, 58])

    def test_unvoiced_consonants_and_silence_are_preserved_without_a_carrier(self):
        random = np.random.default_rng(105)
        consonants = .07 * random.standard_normal(RATE)
        source = np.concatenate((voice(1, frequency=203), consonants, np.zeros(RATE // 2), voice(1, frequency=227)))
        output, metadata = _autotune(source, RATE, 0, "minor")
        # Exclude the 50 ms analysis boundary; unvoiced interiors remain exact.
        np.testing.assert_array_equal(output[RATE + 2400:RATE * 2 - 2400], source[RATE + 2400:RATE * 2 - 2400])
        np.testing.assert_array_equal(output[RATE * 2 + 2400:RATE * 5 // 2 - 2400], 0)
        self.assertGreater(metadata["voiced_fraction"], .4)
        self.assertLess(metadata["voiced_fraction"], .7)
        self.assertTrue(np.isfinite(output).all())
        silent, result = _autotune(np.zeros(RATE), RATE, 0, "minor")
        self.assertFalse(silent.any())
        self.assertEqual(result["voiced_fraction"], 0)
        self.assertEqual(result["target_midi_notes"], [])

    def test_autotune_render_preserves_full_source_timeline_and_peak_ceiling(self):
        pcm, alignment, text = fixture()
        dry, original = render_fast_voice(pcm, alignment, text=text, bpm=120)
        output, result = render_fast_voice(pcm, alignment, text=text, bpm=120,
                                           robot=True, robot_style="autotune", robot_amount=1,
                                           robot_key=6, robot_scale="major")
        rendered, rate = decode(output)
        self.assertEqual(rendered.shape, decode(dry)[0].shape)
        self.assertEqual(rate, RATE)
        self.assertEqual(result["word_timings"], original["word_timings"])
        self.assertEqual(result["speech_duration_seconds"], original["speech_duration_seconds"])
        self.assertLessEqual(float(np.max(abs(rendered))), 10 ** (-1 / 20))
        self.assertEqual(result["robot"]["key"], 6)
        self.assertEqual(result["robot"]["scale"], "major")
        np.testing.assert_array_equal(rendered[len(pcm) // 2:], 0)

    def test_fixed_melodies_follow_absolute_beat_grid_despite_a_source_pitch_sweep(self):
        cases = (("rising", 150, .5), ("falling", 180, 2), ("hook", 120, 1),
                 ("two_note", 120, 1), ("arpeggio", 120, 1), ("drone", 120, 1))
        for melody, bpm, note_beats in cases:
            with self.subTest(melody=melody, bpm=bpm, note_beats=note_beats):
                step = 60 / bpm * note_beats
                count = max(4, len(MELODY_PATTERNS[melody]))
                seconds = count * step + .1
                time_axis = np.arange(round(seconds * RATE)) / RATE
                frequency = 175 + 60 * time_axis / seconds
                phase = np.cumsum(frequency) * 2 * np.pi / RATE
                source = .22 * (np.sin(phase) + .3 * np.sin(2 * phase))
                output, metadata = _autotune(source, RATE, 0, "minor", bpm=bpm,
                                              melody=melody, octave=4, note_beats=note_beats)
                centers, detected, _ = _voice_pitch(output, RATE)
                expected_notes = [60 + (0, 2, 3, 5, 7, 8, 10)[degree] for degree in MELODY_PATTERNS[melody]]
                self.assertEqual(metadata["melody_midi_notes"], expected_notes)
                self.assertEqual(metadata["melody_step_seconds"], step)
                self.assertEqual(len(output), len(source))
                for index in range(count):
                    target = 440 * 2 ** ((expected_notes[index % len(expected_notes)] - 69) / 12)
                    center = (index + .5) * step
                    stable = detected[np.abs(centers / RATE - center) < min(.06, step / 5)]
                    self.assertAlmostEqual(float(np.median(stable)), target, delta=1.3)

    def test_forced_octaves_keep_correct_fundamental_for_large_down_and_up_shifts(self):
        source = voice(2.2, frequency=203)
        for octave in (2, 3, 4, 5):
            with self.subTest(octave=octave):
                output, metadata = _autotune(source, RATE, 0, "minor", bpm=120,
                                              melody="rising", octave=octave, note_beats=1)
                centers, detected, _ = _voice_pitch(output, RATE)
                for index, note in enumerate(metadata["melody_midi_notes"]):
                    target = 440 * 2 ** ((note - 69) / 12)
                    if target < 600:
                        stable = detected[(centers / RATE > index * .5 + .1) & (centers / RATE < index * .5 + .4)]
                        measured = float(np.median(stable))
                        self.assertAlmostEqual(measured, target, delta=1.3)
                    else:
                        # The analysis detector intentionally tops out at
                        # 600 Hz; verify higher synthetic targets with FFT.
                        segment = output[round((index * .5 + .1) * RATE):round((index * .5 + .4) * RATE)]
                        measured = dominant_frequency(segment, low=400, high=1100)
                        self.assertAlmostEqual(measured, target, delta=2)
                self.assertTrue(np.isfinite(output).all())
                self.assertLess(float(np.max(np.abs(output))), .6)
                self.assertEqual(len(output), len(source))

    def test_melody_preserves_consonants_and_grid_continues_through_unvoiced_gaps(self):
        random = np.random.default_rng(906)
        source = np.concatenate((voice(.8, frequency=180), .06 * random.standard_normal(round(.6 * RATE)),
                                 np.zeros(round(.4 * RATE)), voice(1.4, frequency=225)))
        output, metadata = _autotune(source, RATE, 2, "major", bpm=120,
                                     melody="hook", octave=4, note_beats=1)
        np.testing.assert_array_equal(output[round(.9 * RATE):round(1.3 * RATE)], source[round(.9 * RATE):round(1.3 * RATE)])
        np.testing.assert_array_equal(output[round(1.5 * RATE):round(1.7 * RATE)], 0)
        self.assertEqual(metadata["melody_midi_notes"], [62, 62, 66, 69, 66, 64, 62, 69])
        centers, detected, _ = _voice_pitch(output, RATE)
        for seconds, note in ((2.2, 66), (2.7, 64)):
            stable = detected[np.abs(centers / RATE - seconds) < .08]
            self.assertAlmostEqual(float(np.median(stable)), 440 * 2 ** ((note - 69) / 12), delta=1.3)

    def test_melody_parameters_keep_legacy_follow_and_zero_amount_audio_exact(self):
        pcm, alignment, text = fixture()
        default, _ = render_fast_voice(pcm, alignment, text=text, bpm=120, robot=True, robot_style="autotune")
        follow, result = render_fast_voice(pcm, alignment, text=text, bpm=120, robot=True, robot_style="autotune",
                                            robot_melody="follow", robot_octave=5, robot_note_beats=.5)
        self.assertEqual(default, follow)
        dry, original = render_fast_voice(pcm, alignment, text=text, bpm=120)
        bypass, _ = render_fast_voice(pcm, alignment, text=text, bpm=120, robot=True, robot_style="autotune",
                                      robot_melody="hook", robot_octave=4, robot_note_beats=.5, robot_amount=0)
        self.assertEqual(dry, bypass)
        melody, metadata = render_fast_voice(pcm, alignment, text=text, bpm=120, robot=True, robot_style="autotune",
                                             robot_melody="arpeggio", robot_octave=4, robot_note_beats=.5,
                                             robot_scale="chromatic", robot_amount=1)
        self.assertEqual(metadata["robot"]["melody_scale"], "major")
        self.assertEqual(metadata["robot"]["melody_midi_notes"], [60, 64, 67, 64])
        self.assertEqual(metadata["word_timings"], original["word_timings"])
        self.assertEqual(len(decode(melody)[0]), len(decode(dry)[0]))
        self.assertLessEqual(float(np.max(abs(decode(melody)[0]))), 10 ** (-1 / 20))


if __name__ == "__main__":
    unittest.main()
