#!/usr/bin/env python3
"""Offline rap audio/timing checks; no external voice service is called."""

from array import array
import io
import math
import sys
import unittest
import wave

from rap_render import render_rap, validate_plan

RATE = 16000


def tone(duration, frequency=220, amplitude=12000):
    return array("h", (round(amplitude * math.sin(2 * math.pi * frequency * index / RATE))
                       for index in range(round(duration * RATE))))


def pcm(samples):
    values = array("h", samples)
    if sys.byteorder != "little":
        values.byteswap()
    return values.tobytes()


def fixture(text, word_seconds=.20, gap=.04):
    chars, starts, ends, samples = [], [], [], array("h")
    at, word_index = 0., 0
    for piece in text.split(" "):
        # Newlines intentionally preserve their own timestamp in the response.
        for index, part in enumerate(piece.split("\n")):
            if index:
                chars.append("\n"); starts.append(at); ends.append(at)
            if not part:
                continue
            segment = tone(word_seconds, 220 + word_index * 30)
            samples.extend(segment)
            for position, char in enumerate(part):
                chars.append(char)
                starts.append(at + position * word_seconds / len(part))
                ends.append(at + (position + 1) * word_seconds / len(part))
            at += word_seconds
            silence = array("h", [0]) * round(gap * RATE)
            samples.extend(silence)
            chars.append(" "); starts.append(at); ends.append(at + gap)
            at += gap
            word_index += 1
    return pcm(samples), {"alignment": {"characters": chars,
             "character_start_times_seconds": starts, "character_end_times_seconds": ends}}


def unpack_wav(data):
    with wave.open(io.BytesIO(data), "rb") as source:
        assert source.getnchannels() == 1
        assert source.getsampwidth() == 2
        assert source.getframerate() == RATE
        samples = array("h")
        samples.frombytes(source.readframes(source.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


class RapRenderTests(unittest.TestCase):
    def test_every_source_sample_and_pause_is_preserved(self):
        text = "Move with the beat\nKeep the rhythm alive"
        source, alignment = fixture(text)
        # Include breaths/tails that are outside all reported word timestamps.
        # The renderer must retain these as well as the detected words.
        source += pcm(tone(.12, 70, 1500))
        wav, result = render_rap(source, alignment, text=text, bpm=100)
        audio = pcm(unpack_wav(wav))
        self.assertEqual(audio[:len(source)], source)
        self.assertEqual(audio[len(source):], b"\x00" * (len(audio) - len(source)))
        words = result["word_timings"]
        self.assertEqual([word["word"] for word in words], text.split())
        self.assertTrue(all(word["start"] == word["source_start"] for word in words))
        self.assertTrue(all(word["end"] == word["source_end"] for word in words))
        self.assertAlmostEqual(words[1]["start"] - words[0]["end"], .04)
        self.assertEqual(result["timing_mode"], "natural")
        self.assertEqual(result["phrase_offset_seconds"], 0)
        self.assertEqual(result["speech_duration_seconds"], len(source) / 2 / RATE)

    def test_line_breaks_do_not_force_bar_gaps(self):
        text = "one\ntwo\nthree\nfour"
        source, alignment = fixture(text, word_seconds=.15, gap=.03)
        wav, result = render_rap(source, alignment, text=text, bpm=120)
        words = result["word_timings"]
        self.assertEqual(result["bars"], 1)
        self.assertEqual(len(unpack_wav(wav)), 2 * RATE)
        for previous, current in zip(words, words[1:]):
            self.assertAlmostEqual(current["start"] - previous["end"], .03)
        self.assertEqual(pcm(unpack_wav(wav))[:len(source)], source)

    def test_bpm_changes_only_loop_padding_not_the_performance(self):
        text = "one two three four"
        source, alignment = fixture(text)
        slow_wav, slow = render_rap(source, alignment, text=text, bpm=60)
        fast_wav, fast = render_rap(source, alignment, text=text, bpm=120)
        self.assertEqual(len(unpack_wav(slow_wav)), 2 * len(unpack_wav(fast_wav)))
        self.assertEqual(pcm(unpack_wav(slow_wav))[:len(source)], source)
        self.assertEqual(pcm(unpack_wav(fast_wav))[:len(source)], source)
        self.assertEqual([w["start"] for w in slow["word_timings"]],
                         [w["start"] for w in fast["word_timings"]])
        self.assertEqual(slow["word_timings"][1]["beat"] * 2,
                         fast["word_timings"][1]["beat"])

    def test_long_word_adds_whole_bars_without_compression(self):
        source, alignment = fixture("extraordinary", word_seconds=3, gap=0)
        wav, result = render_rap(source, alignment, text="extraordinary", bpm=240)
        self.assertEqual(result["bars"], 3)
        self.assertEqual(pcm(unpack_wav(wav)), source)
        with self.assertRaisesRegex(ValueError, "natural voice is longer"):
            render_rap(source, alignment, text="extraordinary", bpm=240, bars=2)

    def test_leading_silence_and_voiced_onset_are_not_cut(self):
        source, alignment = fixture("hello")
        lead = b"\x00\x00" * round(.127 * RATE)
        for key in ("character_start_times_seconds", "character_end_times_seconds"):
            alignment["alignment"][key] = [value + .127 for value in alignment["alignment"][key]]
        source = lead + source
        wav, result = render_rap(source, alignment, text="hello", bpm=120)
        self.assertEqual(result["word_timings"][0]["start"], .127)
        self.assertEqual(pcm(unpack_wav(wav))[:len(source)], source)

    def test_explicit_bars_add_tail_only_and_sample_rounding_is_exact(self):
        source, alignment = fixture("hello")
        wav, result = render_rap(source, alignment, text="hello", bpm=113, bars=3)
        output = pcm(unpack_wav(wav))
        self.assertEqual(len(output) // 2, round(3 * 4 * 60 / 113 * RATE))
        self.assertEqual(output[:len(source)], source)
        self.assertEqual(set(output[len(source):]), {0})
        self.assertEqual(result["bars"], 3)

    def test_normalized_alignment_and_nonenglish_words_keep_natural_timing(self):
        text = "don't sci-fi café 東京"
        source, data = fixture(text)
        data = {"normalized_alignment": data["alignment"]}
        wav, result = render_rap(source, data, text=text, bpm=120)
        self.assertEqual([word["word"] for word in result["word_timings"]], text.split())
        self.assertEqual(pcm(unpack_wav(wav))[:len(source)], source)

    def test_invalid_alignment_and_pcm_are_rejected(self):
        source, data = fixture("word")
        invalid_cases = [{}, {"alignment": {}}, {"alignment": {"characters": ["w"]}},
                         {"alignment": {"characters": ["w"], "character_start_times_seconds": [math.nan],
                                        "character_end_times_seconds": [.1]}},
                         {"alignment": {"characters": ["a", "b"], "character_start_times_seconds": [.1, 0],
                                        "character_end_times_seconds": [.2, .2]}},
                         {"alignment": {"characters": ["w"], "character_start_times_seconds": [0],
                                        "character_end_times_seconds": [2]}}]
        for invalid in invalid_cases:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                render_rap(source, invalid, text="word", bpm=120)
        for invalid_pcm in (b"", b"odd", "string"):
            with self.subTest(pcm=invalid_pcm), self.assertRaises(ValueError):
                render_rap(invalid_pcm, data, text="word", bpm=120)

    def test_plan_bounds_before_paid_request(self):
        for text, bpm, bars in [("!", 120, None), ("word", math.inf, None),
                                ("word", True, None), ("word", 20, None),
                                ("word", 120, True), ("word " * 301, 120, None),
                                ("word", 40, 64)]:
            with self.subTest(text=text, bpm=bpm, bars=bars), self.assertRaises(ValueError):
                validate_plan(text, bpm, bars)
        # Line count and guessed syllables cannot determine voice duration.
        self.assertEqual(validate_plan("hello\nworld", 120, 1)["bars"], 1)
        self.assertIsNone(validate_plan("hello\n" * 65, 40)["bars"])
        self.assertIsNone(validate_plan("hello world", 120)["duration_seconds"])

    def test_padding_still_obeys_maximum_duration(self):
        source = b"\x00\x00" * (120 * RATE)
        data = {"alignment": {"characters": ["a"], "character_start_times_seconds": [0.0],
                              "character_end_times_seconds": [119.0]}}
        with self.assertRaisesRegex(ValueError, "120 seconds"):
            render_rap(source, data, text="a", bpm=119)
        wav, result = render_rap(source, data, text="a", bpm=120)
        self.assertEqual(result["duration_seconds"], 120)
        self.assertEqual(pcm(unpack_wav(wav)), source)

    def test_phrases_land_on_beats_with_every_internal_sample_unchanged(self):
        text = "We move together, keep the rhythm steady.\nHere comes another line!"
        source, alignment = fixture(text, word_seconds=.21, gap=.057)
        wav, result = render_rap(source, alignment, text=text, bpm=113, timing_mode="phrase_beats")
        output = pcm(unpack_wav(wav))
        phrases = result["phrase_timings"]
        self.assertEqual(result["timing_mode"], "phrase_beats")
        self.assertEqual([phrase["word_count"] for phrase in phrases], [3, 4, 4])
        self.assertEqual(sum(phrase["word_count"] for phrase in phrases), len(result["word_timings"]))
        for index, phrase in enumerate(phrases):
            self.assertEqual(round(phrase["start"] * RATE), round(phrase["beat"] * 60 / 113 * RATE))
            source_start = round(phrase["source_audio_start"] * RATE)
            source_end = round(phrase["source_audio_end"] * RATE)
            out_start = round(phrase["audio_start"] * RATE)
            left, right = phrase["fade_in_frames"], phrase["fade_out_frames"]
            self.assertEqual(output[(out_start + left) * 2:(out_start + source_end - source_start - right) * 2],
                             source[(source_start + left) * 2:(source_end - right) * 2])
            words = [word for word in result["word_timings"] if word["phrase"] == index]
            shifts = [word["start"] - word["source_start"] for word in words]
            self.assertLess(max(shifts) - min(shifts), 1e-12)
            for previous, current in zip(words, words[1:]):
                self.assertAlmostEqual(current["start"] - previous["end"],
                                       current["source_start"] - previous["source_end"])
        for previous, current in zip(phrases, phrases[1:]):
            self.assertEqual(previous["source_audio_end"], current["source_audio_start"])
            self.assertLessEqual(previous["audio_end"], current["audio_start"])
        self.assertEqual(phrases[0]["source_audio_start"], 0)
        self.assertEqual(phrases[-1]["source_audio_end"], len(source) / 2 / RATE)
        self.assertEqual(len(output) // 2, round(result["bars"] * 4 * 60 / 113 * RATE))

    def test_normalized_alignment_recovers_punctuation_using_word_anchors(self):
        typed = "At 12:30, we start. Dr. Jones keeps 3.14 steady."
        spoken = "At twelve thirty we start doctor Jones keeps three point fourteen steady"
        source, alignment = fixture(spoken)
        alignment = {"normalized_alignment": alignment["alignment"]}
        _, result = render_rap(source, alignment, text=typed, bpm=100, timing_mode="phrase_beats")
        self.assertEqual([phrase["word_count"] for phrase in result["phrase_timings"]], [3, 2, 7])
        self.assertEqual([word["word"] for word in result["word_timings"]], spoken.split())

    def test_numbers_titles_and_initials_are_not_phrase_boundaries(self):
        text = "Dr. Lee meets J. R. Jones at 12:30 with 1,000 and 3.14 points"
        source, alignment = fixture(text)
        _, result = render_rap(source, alignment, text=text, bpm=120, timing_mode="phrase_beats")
        self.assertEqual(len(result["phrase_timings"]), 1)

    def test_long_unpunctuated_run_is_not_split_by_word_count(self):
        text = "we keep all these words together without breaking up the natural sound"
        source, alignment = fixture(text)
        _, result = render_rap(source, alignment, text=text, bpm=120, timing_mode="phrase_beats")
        self.assertEqual(len(result["phrase_timings"]), 1)
        self.assertEqual(result["phrase_timings"][0]["word_count"], len(text.split()))

    def test_substantial_pause_can_start_a_new_phrase_without_punctuation(self):
        text = "we move we flow"
        source, alignment = fixture(text)
        boundary = round(.48 * RATE)
        source = source[:boundary * 2] + b"\x00\x00" * round(.4 * RATE) + source[boundary * 2:]
        data = alignment["alignment"]
        for index, start in enumerate(data["character_start_times_seconds"]):
            if start >= .48 - 1e-8:
                data["character_start_times_seconds"][index] += .4
                data["character_end_times_seconds"][index] += .4
        _, result = render_rap(source, alignment, text=text, bpm=120, timing_mode="phrase_beats")
        self.assertEqual([phrase["word_count"] for phrase in result["phrase_timings"]], [2, 2])

    def test_no_cut_when_word_timestamps_overlap_at_punctuation(self):
        text = "one, two"
        source, alignment = fixture(text)
        data = alignment["alignment"]
        # A synthetic provider overlap: two starts before one finishes.
        separator = data["characters"].index(" ")
        data["character_start_times_seconds"][separator] = .14
        data["character_end_times_seconds"][separator] = .20
        for index in range(separator + 1, len(data["characters"])):
            data["character_start_times_seconds"][index] -= .09
            data["character_end_times_seconds"][index] -= .09
        # Keep character timestamps ordered while overlapping adjacent words.
        data["character_start_times_seconds"][separator - 1] = .14
        _, result = render_rap(source, alignment, text=text, bpm=120, timing_mode="phrase_beats")
        self.assertEqual(len(result["phrase_timings"]), 1)

    def test_phrase_padding_and_explicit_bars_do_not_crop_voice(self):
        text = "one phrase, another phrase, final phrase"
        source, alignment = fixture(text, word_seconds=.29, gap=.07)
        _, result = render_rap(source, alignment, text=text, bpm=120, timing_mode="phrase_beats")
        self.assertGreater(result["bars"], 1)
        with self.assertRaisesRegex(ValueError, "longer than the requested bars"):
            render_rap(source, alignment, text=text, bpm=120, bars=1, timing_mode="phrase_beats")

    def test_timing_mode_is_strict_and_default_natural_stays_available(self):
        source, alignment = fixture("hello world")
        for mode in (None, "word_grid", "natural_phrase", [], True):
            with self.subTest(mode=mode), self.assertRaisesRegex(ValueError, "Timing mode"):
                render_rap(source, alignment, text="hello world", bpm=120, timing_mode=mode)
        implicit, _ = render_rap(source, alignment, text="hello world", bpm=120)
        explicit, _ = render_rap(source, alignment, text="hello world", bpm=120, timing_mode="natural")
        self.assertEqual(implicit, explicit)


if __name__ == "__main__":
    unittest.main()
