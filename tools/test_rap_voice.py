#!/usr/bin/env python3
"""Offline checks for the auditioned voice transport and musical timing."""
import io
import json
import math
from email.message import Message
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from urllib import error
import wave

import numpy as np

from elevenlabs_service import GenerationError, NoRedirect, ServiceError
from rap_voice import (DEFAULT_EFFECTS, MODEL_ID, RATE, VOICES, VoiceChangerClient,
                       remix_vocal, render_vocal, validate_effects)

FFMPEG = shutil.which("ffmpeg") or str(Path(__file__).resolve().parents[1] / "var/bin/ffmpeg")


def write_wav(path, samples, rate=RATE):
    samples = np.asarray(samples)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(samples.shape[1] if samples.ndim == 2 else 1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(np.rint(samples * 32767).astype("<i2").tobytes())


def read_wav(path):
    with wave.open(str(path), "rb") as source:
        channels, rate = source.getnchannels(), source.getframerate()
        pcm = source.readframes(source.getnframes())
        return np.frombuffer(pcm, dtype="<i2").reshape(-1, channels) / 32768, rate, pcm


def voice(seconds=2, frequency=170, rate=RATE, amplitude=.2):
    t = np.arange(round(seconds * rate)) / rate
    return amplitude * (np.sin(2 * np.pi * frequency * t) + .25 * np.sin(2 * np.pi * 2 * frequency * t))


def frequency(samples, rate=RATE):
    samples = np.asarray(samples).reshape(-1)
    spectrum = abs(np.fft.rfft(samples * np.hanning(len(samples))))
    bins = np.fft.rfftfreq(len(samples), 1 / rate)
    valid = np.flatnonzero((bins > 40) & (bins < 800))
    return bins[valid[np.argmax(spectrum[valid])]]


class Response(io.BytesIO):
    def __init__(self, data, *, media_type="audio/pcm", content_length=None, status=200):
        super().__init__(data)
        self.status = status
        self.headers = Message()
        self.headers["Content-Type"] = media_type
        if content_length is not None:
            self.headers["Content-Length"] = str(content_length)
        self.headers["request-id"] = "receipt-123"
        self.headers["history-item-id"] = "history-123"
        self.headers["character-cost"] = "123"


class RapVoiceValidationTests(unittest.TestCase):
    def test_six_auditioned_identities_are_distinct_and_stable(self):
        self.assertEqual(list(VOICES), ["eva", "cold_android", "peter", "elowen", "maisie", "warren"])
        self.assertEqual([v["voice_id"] for v in VOICES.values()], [
            "weA4Q36twV5kwSaTEL0Q", "nPijfmaNgvm5OSN4xM8H", "TumdjBNWanlT3ysvclWh",
            "dvbL7qkNGZY1IqPGZAjM", "QtY3JBOUKEB5xzrRfOKc", "7QN34D2r3hCNwbOYIeK0"])

    def test_effect_defaults_are_clean_and_independent(self):
        effects = validate_effects({})
        self.assertEqual(effects, DEFAULT_EFFECTS)
        effects["autotune_amount"] = 1
        self.assertEqual(DEFAULT_EFFECTS["autotune_amount"], 0)

    def test_invalid_effects_rejected_before_paid_work(self):
        invalid = [[], "autotune", {"pitch_semitones": float("nan")},
                   {"pitch_semitones": 12.1}, {"pitch_semitones": -12.1},
                   {"pitch_semitones": True}, {"autotune_amount": 1.01},
                   {"autotune_amount": -.1}, {"key": 12}, {"key": 1.5},
                   {"key": False}, {"scale": []}, {"scale": "dorian"},
                   {"melody": "unknown"}, {"melody": []}, {"octave": 6},
                   {"note_beats": True}, {"note_beats": .25}, {"other": 1}]
        for effects in invalid:
            with self.subTest(effects=effects), self.assertRaises(ServiceError):
                validate_effects(effects)


class RapVoiceTransportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source, self.destination = self.root / "source.wav", self.root / "voice.wav"
        write_wav(self.source, voice(1))
        self.pcm = read_wav(self.source)[2]
        self.client = VoiceChangerClient("private-test-key", 300)
        self.voice_id = VOICES["eva"]["voice_id"]

    def convert(self, response):
        with patch("rap_voice.request.build_opener") as opener:
            opener.return_value.open.return_value = response
            result = self.client.convert(self.source, self.destination, self.voice_id)
            return result, opener

    def test_uses_exact_audition_recipe_and_verified_nonredirecting_transport(self):
        result, opener = self.convert(Response(self.pcm, content_length=len(self.pcm)))
        self.assertEqual(read_wav(self.destination)[2], self.pcm)
        self.assertEqual(result["provider_request_id"], "receipt-123")
        self.assertEqual(result["duration_seconds"], 1)
        outgoing = opener.return_value.open.call_args.args[0]
        self.assertEqual(outgoing.full_url, f"https://api.elevenlabs.io/v1/speech-to-speech/{self.voice_id}?output_format=pcm_24000")
        self.assertEqual(outgoing.get_method(), "POST")
        body = outgoing.data
        for value in (MODEL_ID.encode(), b'"stability": 0.5', b'"similarity_boost": 0.85',
                      b'"style": 0.0', b'"use_speaker_boost": true', b'\r\n1729\r\n', b'\r\nfalse\r\n'):
            self.assertIn(value, body)
        self.assertIn(self.source.read_bytes(), body)
        self.assertIn(NoRedirect, opener.call_args.args)
        self.assertTrue(self.client.tls_context.check_hostname)
        self.assertEqual(opener.return_value.open.call_args.kwargs["timeout"], 180)
        self.assertEqual(opener.return_value.open.call_count, 1)

    def test_small_duration_drift_keeps_original_timeline(self):
        for delta in (-240, 240):
            with self.subTest(delta=delta):
                data = self.pcm[:delta * 2] if delta < 0 else self.pcm + b"\0\0" * delta
                result, _ = self.convert(Response(data))
                self.assertEqual(len(read_wav(self.destination)[2]), len(self.pcm))
                self.assertAlmostEqual(result["provider_duration_difference_seconds"], delta / RATE)
                self.destination.unlink()

    def test_incomplete_short_long_and_encoded_results_are_never_exposed(self):
        for response in (Response(self.pcm[:-10], content_length=len(self.pcm)),
                         Response(self.pcm[:len(self.pcm) // 2]),
                         Response(self.pcm + b"\0\0" * RATE),
                         Response(self.pcm[:-1]), Response(b"RIFF" + self.pcm[4:]),
                         Response(self.pcm, media_type="audio/mpeg"), Response(b"{}", media_type="application/json"),
                         Response(b""), Response(self.pcm, content_length="not-a-length"),
                         Response(self.pcm, content_length=999999999)):
            with self.subTest(response=response), self.assertRaises(GenerationError):
                self.convert(response)
            self.assertFalse(self.destination.exists())

    def test_provider_errors_are_sanitized_and_never_retried(self):
        for status in (401, 403, 429, 500):
            exception = error.HTTPError("https://api.elevenlabs.io/", status,
                "secret private-test-key", {}, io.BytesIO(b"private-test-key participant words"))
            with self.subTest(status=status), patch("rap_voice.request.build_opener") as opener:
                opener.return_value.open.side_effect = exception
                with self.assertRaises(GenerationError) as caught:
                    self.client.convert(self.source, self.destination, self.voice_id)
                self.assertNotIn("private-test-key", str(caught.exception))
                self.assertNotIn("participant words", str(caught.exception))
                self.assertEqual(caught.exception.state, "unknown" if status == 500 else "failed")
                self.assertEqual(opener.return_value.open.call_count, 1)

    def test_existing_output_and_unrecognized_voice_block_provider_submission(self):
        self.destination.write_bytes(b"keep saved result")
        with patch("rap_voice.request.build_opener") as opener:
            with self.assertRaises(GenerationError):
                self.client.convert(self.source, self.destination, self.voice_id)
            self.destination.unlink()
            with self.assertRaises(GenerationError):
                self.client.convert(self.source, self.destination, "unrecognized")
            opener.assert_not_called()


class RapVoiceRenderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source, self.destination = self.root / "source.wav", self.root / "voice.wav"
        write_wav(self.source, voice())

    def render(self, **effects):
        return render_vocal(self.source, self.destination, effects, bpm=100, ffmpeg=FFMPEG)

    def test_clean_mode_preserves_every_pcm_sample_without_ffmpeg(self):
        with patch("rap_voice.subprocess.run") as run:
            result = self.render()
            run.assert_not_called()
        self.assertEqual(read_wav(self.source)[2], read_wav(self.destination)[2])
        self.assertEqual(result["gain_db"], 0)
        self.assertEqual(result["frames"], RATE * 2)

    @unittest.skipUnless(Path(FFMPEG).is_file(), "ffmpeg not installed")
    def test_pitch_changes_frequency_without_speed_or_duration_changes(self):
        for semitones in (-12, -5, 5, 12):
            with self.subTest(semitones=semitones):
                self.render(pitch_semitones=semitones)
                output, rate, _ = read_wav(self.destination)
                self.assertEqual(output.shape, (RATE * 2, 1))
                self.assertEqual(rate, RATE)
                self.assertAlmostEqual(frequency(output[RATE // 4:-RATE // 4]), 170 * 2 ** (semitones / 12), delta=2)
                self.assertGreater(np.sqrt(np.mean(output[-RATE // 10:] ** 2)), .08)
                self.destination.unlink()

    @unittest.skipUnless(Path(FFMPEG).is_file(), "ffmpeg not installed")
    def test_pitch_preserves_separated_syllable_positions(self):
        samples = np.zeros(RATE * 3)
        for center in (.7, 2.1):
            start = round((center - .1) * RATE)
            samples[start:start + round(.2 * RATE)] = voice(.2) * np.hanning(round(.2 * RATE))
        write_wav(self.source, samples)
        for semitones in (-12, 12):
            self.render(pitch_semitones=semitones)
            output = read_wav(self.destination)[0][:, 0]
            for center in (.7, 2.1):
                low, high = round((center - .2) * RATE), round((center + .2) * RATE)
                energy = output[low:high] ** 2
                position = np.dot(np.arange(low, high) / RATE, energy) / np.sum(energy)
                self.assertAlmostEqual(position, center, delta=.06)
            self.destination.unlink()

    def test_autotune_corrects_to_scale_keeps_frames_and_blends_amount(self):
        original = read_wav(self.source)[0][:, 0]
        self.render(autotune_amount=1, key=0, scale="minor")
        wet = read_wav(self.destination)[0][:, 0]
        self.assertEqual(len(wet), len(original))
        self.assertAlmostEqual(frequency(wet[RATE // 4:-RATE // 4]), 174.614, delta=1.5)
        self.destination.unlink()
        self.render(autotune_amount=.4)
        partial = read_wav(self.destination)[0][:, 0]
        np.testing.assert_allclose(partial, original * .6 + wet * .4, atol=2 / 32768)

    def test_autotune_fixed_melody_changes_notes_without_moving_silence(self):
        samples = voice(3)
        samples[:RATE // 4] = 0
        samples[-RATE // 4:] = 0
        write_wav(self.source, samples)
        result = self.render(autotune_amount=1, melody="two_note", octave=3, key=0, scale="minor")
        output = read_wav(self.destination)[0][:, 0]
        self.assertEqual(result["autotune"]["melody_midi_notes"], [48, 55])
        self.assertEqual(len(output), len(samples))
        self.assertLess(float(np.max(abs(output[:RATE // 5]))), 1 / 32768)
        self.assertLess(float(np.max(abs(output[-RATE // 5:]))), 1 / 32768)
        self.assertLessEqual(float(np.max(abs(output))), 10 ** (-1 / 20) + 1 / 32768)

    @unittest.skipUnless(Path(FFMPEG).is_file(), "ffmpeg not installed")
    def test_pitch_transposes_fixed_autotune_melody_instead_of_being_cancelled(self):
        self.render(autotune_amount=1, melody="drone", key=0, octave=3, pitch_semitones=12)
        output = read_wav(self.destination)[0][:, 0]
        self.assertEqual(len(output), RATE * 2)
        # C3 drone transposed one octave must be C4, rather than autotune
        # undoing the transposition and leaving it at C3.
        self.assertAlmostEqual(frequency(output[RATE // 4:-RATE // 4]), 261.626, delta=2)

    @unittest.skipUnless(Path(FFMPEG).is_file(), "ffmpeg not installed")
    def test_remix_keeps_stereo_backing_and_native_rate_without_original_voice(self):
        rate = 44100
        mono = voice(2, frequency=75, rate=rate, amplitude=.2)
        backing = np.column_stack((mono, -mono))
        instrumental = self.root / "instrumental.wav"
        write_wav(instrumental, backing, rate)
        result = remix_vocal(self.source, instrumental, self.destination, ffmpeg=FFMPEG)
        output, output_rate, _ = read_wav(self.destination)
        original = read_wav(instrumental)[0]
        self.assertEqual(output_rate, rate)
        self.assertEqual(output.shape, original.shape)
        self.assertEqual(result["gain_db"], 0)
        np.testing.assert_allclose(output[:, 0] - output[:, 1], original[:, 0] - original[:, 1], atol=1 / 32768)
        self.assertAlmostEqual(frequency(np.mean(output[rate // 4:-rate // 4], axis=1), rate), 170, delta=1)

    @unittest.skipUnless(Path(FFMPEG).is_file(), "ffmpeg not installed")
    def test_remix_prevents_clipping_and_rejects_mistimed_tracks(self):
        instrumental = self.root / "instrumental.wav"
        write_wav(instrumental, np.full((RATE * 2, 2), .9))
        result = remix_vocal(self.source, instrumental, self.destination, ffmpeg=FFMPEG)
        output = read_wav(self.destination)[0]
        self.assertLess(result["gain_db"], 0)
        self.assertLessEqual(float(np.max(abs(output))), 10 ** (-1 / 20) + 1 / 32768)
        self.destination.unlink()
        write_wav(instrumental, np.zeros((RATE, 2)))
        with self.assertRaisesRegex(GenerationError, "120 ms"):
            remix_vocal(self.source, instrumental, self.destination, ffmpeg=FFMPEG)
        self.assertFalse(self.destination.exists())


if __name__ == "__main__":
    unittest.main()
