"""Local, lazily loaded Whisper small transcription for microphone recordings.

Runtime never downloads models. The separate preparation command installs the
model and tokenizer before microphone input is enabled.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
import re
import threading
import wave

MODEL_ID = "whisper-small"
MODEL_SIZE = "small"
MAX_TEXT_LENGTH = 1000
# tokenizer.json is essential: faster-whisper otherwise attempts to download a
# tokenizer even when the model itself was loaded with local_files_only=True.
REQUIRED_MODEL_FILES = ("model.bin", "config.json", "tokenizer.json")
VOCABULARY_FILES = ("vocabulary.json", "vocabulary.txt")
INSTALL_COMMAND = ".venv/bin/python -m pip install -r requirements-rap-response.txt"
PREPARE_COMMAND = ".venv/bin/python tools/prepare_rap_transcription.py"


class TranscriptionError(Exception):
    pass


def model_files_available(directory):
    directory = Path(directory)
    try:
        def available(name):
            return (directory / name).is_file() and (directory / name).stat().st_size > 0
        return all(available(name) for name in REQUIRED_MODEL_FILES) and any(available(name) for name in VOCABULARY_FILES)
    except OSError:
        return False


def dependency_available():
    try:
        return importlib.util.find_spec("faster_whisper") is not None
    except (ImportError, ValueError, AttributeError):
        return False


class WhisperSmallTranscriber:
    def __init__(self, model_directory):
        self.model_directory = Path(model_directory).resolve()
        self._model = None
        self._load_error = None
        self._lock = threading.Lock()

    def status(self):
        issues = []
        if not dependency_available():
            issues.append("Install local transcription dependencies with: " + INSTALL_COMMAND)
        if not model_files_available(self.model_directory):
            issues.append("Download Whisper small once with: " + PREPARE_COMMAND)
        if self._load_error:
            issues.append(self._load_error)
        return {"ready": not issues, "issues": issues, "model_id": MODEL_ID,
                "device": "cpu", "compute_type": "int8", "model_loaded": self._model is not None}

    def _load(self):
        status = self.status()
        if not status["ready"]:
            raise TranscriptionError(" ".join(status["issues"]))
        if self._model is None:
            try:
                # Optional dependency: importing the dashboard or reading its
                # status never imports CTranslate2 or allocates model memory.
                import onnxruntime
                onnxruntime.disable_telemetry_events()
                from faster_whisper import WhisperModel
                self._model = WhisperModel(str(self.model_directory), device="cpu", compute_type="int8",
                                           local_files_only=True, num_workers=1)
            except Exception:
                self._load_error = ("Whisper small could not load locally. Check the transcription dependencies and model files, "
                                    "then restart the dashboard. No recording was sent to a remote service.")
                raise TranscriptionError(self._load_error) from None
        return self._model

    def transcribe(self, source):
        # Keep the model in memory across requests and serialize inference even
        # if a caller outside the normal single worker invokes this object.
        with self._lock:
            model = self._load()
            try:
                # Capture is already PCM16 mono at 16 kHz. Decode that bounded
                # local format directly, avoiding a redundant PyAV decoder and
                # accepting neither remote URLs nor arbitrary media formats.
                import numpy as np
                path = Path(source)
                if not path.is_file() or not 44 <= path.stat().st_size <= 1024 * 1024:
                    raise TranscriptionError("The saved microphone recording is invalid.")
                try:
                    with wave.open(str(path), "rb") as recording:
                        frames = recording.getnframes()
                        if (recording.getnchannels(), recording.getsampwidth(), recording.getframerate(), recording.getcomptype()) != (1, 2, 16000, "NONE"):
                            raise ValueError
                        if not 1600 <= frames <= 480000:
                            raise ValueError
                        pcm = recording.readframes(frames)
                        if len(pcm) != frames * 2:
                            raise ValueError
                except (ValueError, EOFError, wave.Error):
                    raise TranscriptionError("Use a complete PCM16 mono WAV recording at 16 kHz, lasting 0.1 to 30 seconds.") from None
                samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
                segments, info = model.transcribe(samples, language=None, task="transcribe",
                                                  beam_size=5, vad_filter=True, no_speech_threshold=0.6,
                                                  condition_on_previous_text=False)
                if getattr(info, "duration_after_vad", None) == 0:
                    raise TranscriptionError("No speech was detected. Record a short spoken message and try a new response.")
                text = ""
                for segment in segments:
                    part = getattr(segment, "text", None)
                    if not isinstance(part, str):
                        raise TranscriptionError("Whisper small returned an invalid local transcription.")
                    text = (text + " " + " ".join(part.split())).strip()
                    if len(text) > MAX_TEXT_LENGTH:
                        raise TranscriptionError("The transcription exceeded 1000 characters. Record a shorter message.")
                if not any(char.isalnum() for char in re.sub(r"\[[^\]]*\]|\([^)]*\)", "", text)):
                    raise TranscriptionError("No speech was detected. Record a short spoken message and try a new response.")
                if any(ord(char) < 32 or ord(char) == 127 for char in text):
                    raise TranscriptionError("Whisper small returned an invalid local transcription.")
                return text
            except TranscriptionError:
                raise
            except Exception:
                raise TranscriptionError("Local Whisper small transcription failed. No recording was sent to a remote service.") from None
