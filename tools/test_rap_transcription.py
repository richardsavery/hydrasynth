#!/usr/bin/env python3
"""Offline checks for local Whisper inference and explicit model preparation."""
import contextlib
import io
from pathlib import Path
import sys
import struct
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest import mock
import wave
import numpy as np

from prepare_rap_transcription import main, prepare_model
from rap_transcription import (
    REQUIRED_MODEL_FILES, TranscriptionError, WhisperSmallTranscriber,
    dependency_available, model_files_available,
)


def create_model_files(directory, vocabulary="vocabulary.txt"):
    directory.mkdir(parents=True, exist_ok=True)
    for name in (*REQUIRED_MODEL_FILES, vocabulary):
        (directory / name).write_bytes(b"fixture")


class LocalTranscriptionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.directory = self.root / "whisper" / "small"
        create_model_files(self.directory)
        self.source = self.root / "recording.wav"
        self.samples = [-32768, -16384, 0, 16384, 32767] * 640
        with wave.open(str(self.source), "wb") as recording:
            recording.setnchannels(1)
            recording.setsampwidth(2)
            recording.setframerate(16000)
            recording.writeframes(struct.pack("<" + "h" * len(self.samples), *self.samples))
        self.model = mock.Mock()
        self.model.transcribe.side_effect = lambda *args, **kwargs: (
            iter([SimpleNamespace(text="  Hello\n there  "), SimpleNamespace(text="what's happening?")]),
            SimpleNamespace(duration_after_vad=2.0),
        )
        self.module = ModuleType("faster_whisper")
        self.module.WhisperModel = mock.Mock(return_value=self.model)
        self.runtime = ModuleType("onnxruntime")
        self.runtime.disable_telemetry_events = mock.Mock()
        self.modules = mock.patch.dict(sys.modules, {"faster_whisper": self.module, "onnxruntime": self.runtime})
        self.dependencies = mock.patch("rap_transcription.dependency_available", return_value=True)
        self.modules.start()
        self.dependencies.start()
        self.transcriber = WhisperSmallTranscriber(self.directory)

    def tearDown(self):
        self.dependencies.stop()
        self.modules.stop()
        self.temp.cleanup()

    def test_status_and_constructor_do_not_load_models_or_download(self):
        self.assertEqual(self.transcriber.status(), {
            "ready": True, "issues": [], "model_id": "whisper-small", "device": "cpu",
            "compute_type": "int8", "model_loaded": False,
        })
        self.assertEqual(self.module.WhisperModel.call_count, 0)
        self.assertEqual(self.model.transcribe.call_count, 0)

    def test_local_cpu_model_loads_once_and_transcribes_with_vad_and_automatic_language(self):
        for _ in range(2):
            self.assertEqual(self.transcriber.transcribe(self.source), "Hello there what's happening?")
        self.module.WhisperModel.assert_called_once_with(str(self.directory.resolve()), device="cpu", compute_type="int8",
                                                       local_files_only=True, num_workers=1)
        self.runtime.disable_telemetry_events.assert_called_once()
        self.assertEqual(self.model.transcribe.call_count, 2)
        call = self.model.transcribe.call_args
        self.assertEqual(call.kwargs, {"language": None, "task": "transcribe", "beam_size": 5,
                                      "vad_filter": True, "no_speech_threshold": 0.6, "condition_on_previous_text": False})
        audio = call.args[0]
        self.assertEqual(audio.dtype, np.dtype("float32"))
        self.assertEqual(audio.tolist(), [sample / 32768 for sample in self.samples])
        self.assertEqual(audio.ndim, 1)
        self.assertTrue(self.transcriber.status()["model_loaded"])

    def test_inference_rejects_truncated_or_non_wav_recordings_before_decoding(self):
        original = self.source.read_bytes()
        for recording in (original[:-8], b"invalid-wave", b"x" * (1024 * 1024 + 1)):
            with self.subTest(size=len(recording)):
                self.source.write_bytes(recording)
                with self.assertRaises(TranscriptionError):
                    self.transcriber.transcribe(self.source)
        self.model.transcribe.assert_not_called()

    def test_missing_tokenizer_blocks_loading_to_prevent_remote_fallback(self):
        (self.directory / "tokenizer.json").unlink()
        self.assertFalse(self.transcriber.status()["ready"])
        self.assertIn(".venv/bin/python tools/prepare_rap_transcription.py", self.transcriber.status()["issues"][0])
        with self.assertRaises(TranscriptionError):
            self.transcriber.transcribe(self.source)
        self.module.WhisperModel.assert_not_called()

    def test_missing_dependencies_are_actionable_and_never_load_model(self):
        with mock.patch("rap_transcription.dependency_available", return_value=False):
            status = self.transcriber.status()
            self.assertFalse(status["ready"])
            self.assertIn(".venv/bin/python -m pip install -r requirements-rap-response.txt", status["issues"][0])
            with self.assertRaises(TranscriptionError):
                self.transcriber.transcribe(self.source)
        self.module.WhisperModel.assert_not_called()

    def test_failed_model_loading_is_reported_without_raw_exception_or_repeated_loads(self):
        self.module.WhisperModel.side_effect = RuntimeError("private-path secret-token")
        for _ in range(2):
            with self.assertRaises(TranscriptionError) as caught:
                self.transcriber.transcribe(self.source)
            self.assertNotIn("secret-token", str(caught.exception))
            self.assertNotIn("private-path", str(caught.exception))
        self.module.WhisperModel.assert_called_once()
        self.assertFalse(self.transcriber.status()["ready"])

    def test_lazy_segments_are_consumed_and_long_text_is_rejected_without_truncation(self):
        consumed = []
        def segments():
            for index in range(100):
                consumed.append(index)
                yield SimpleNamespace(text="x" * 200)
        self.model.transcribe.side_effect = lambda *args, **kwargs: (segments(), SimpleNamespace(duration_after_vad=10))
        with self.assertRaisesRegex(TranscriptionError, "exceeded 1000"):
            self.transcriber.transcribe(self.source)
        self.assertEqual(len(consumed), 5)

    def test_no_speech_or_unusable_transcription_returns_clear_error(self):
        for texts, duration in ((["hallucinated"], 0), ([], 1), (["[Music]"], 1), (["(silence)"], 1), (["..."], 1), ([None], 1), (["bad\x00text"], 1)):
            with self.subTest(texts=texts, duration=duration):
                self.model.transcribe.side_effect = lambda *args, **kwargs: (
                    iter([SimpleNamespace(text=text) for text in texts]), SimpleNamespace(duration_after_vad=duration))
                with self.assertRaises(TranscriptionError):
                    self.transcriber.transcribe(self.source)

    def test_inference_failure_never_exposes_library_exception(self):
        self.model.transcribe.side_effect = RuntimeError("private user path")
        with self.assertRaisesRegex(TranscriptionError, "Local Whisper small transcription failed") as caught:
            self.transcriber.transcribe(self.source)
        self.assertNotIn("private user path", str(caught.exception))

    def test_model_readiness_accepts_either_vocabulary_format_but_requires_nonempty_files(self):
        self.assertTrue(model_files_available(self.directory))
        (self.directory / "vocabulary.txt").rename(self.directory / "vocabulary.json")
        self.assertTrue(model_files_available(self.directory))
        (self.directory / "vocabulary.json").write_bytes(b"")
        self.assertFalse(model_files_available(self.directory))
        (self.directory / "vocabulary.json").write_bytes(b"vocabulary")
        (self.directory / "model.bin").write_bytes(b"")
        self.assertFalse(model_files_available(self.directory))

    def test_dependency_check_does_not_import_optional_module(self):
        with mock.patch("rap_transcription.importlib.util.find_spec", return_value=None) as find:
            self.assertFalse(dependency_available())
            find.assert_called_once_with("faster_whisper")
        with mock.patch("rap_transcription.importlib.util.find_spec", side_effect=ImportError):
            self.assertFalse(dependency_available())


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name).resolve() / "whisper" / "small"
        self.utils = ModuleType("faster_whisper.utils")
        self.utils.download_model = mock.Mock(side_effect=lambda *args, **kwargs: create_model_files(Path(kwargs["output_dir"])))
        self.modules = mock.patch.dict(sys.modules, {"faster_whisper": ModuleType("faster_whisper"), "faster_whisper.utils": self.utils})
        self.modules.start()

    def tearDown(self):
        self.modules.stop()
        self.temp.cleanup()

    def test_explicit_preparation_downloads_multilingual_small_to_local_directory_and_cache(self):
        self.assertEqual(prepare_model(self.directory), self.directory)
        self.utils.download_model.assert_called_once_with("small", output_dir=str(self.directory),
                                                         cache_dir=str(self.directory.parent / "cache"), use_auth_token=False)
        self.assertTrue(model_files_available(self.directory))

    def test_preparation_rejects_partial_download(self):
        self.utils.download_model.side_effect = lambda *args, **kwargs: None
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            prepare_model(self.directory)

    def test_cli_reports_failure_without_leaking_network_exception(self):
        self.utils.download_model.side_effect = RuntimeError("secret auth token")
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            code = main(["--model-dir", str(self.directory)])
        self.assertEqual(code, 1)
        self.assertNotIn("secret auth token", errors.getvalue())
        self.assertIn("preparation failed", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
