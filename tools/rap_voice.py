"""The six auditioned rap voices and offline effects that keep their timing.

Voice conversion uses the same recipe as the accepted auditions. Provider work
is never retried here. Pitch and note effects operate only on the isolated
vocal; a full mix is rebuilt from that vocal and the original instrumental.
"""
from __future__ import annotations

import hashlib
import http.client
import io
import json
import math
import os
from pathlib import Path
import re
import ssl
import subprocess
import time
from urllib import error, request
import uuid
import wave

from elevenlabs_service import GenerationError, NoRedirect, ServiceError, create_tls_context
from rap_experiment_render import MELODY_PATTERNS, _autotune, _numpy

RATE = 24000
MAX_SECONDS = 120
MAX_PCM_BYTES = RATE * MAX_SECONDS * 2
TIMING_TOLERANCE_SECONDS = .120
MODEL_ID = "eleven_multilingual_sts_v2"
VOICE_SETTINGS = {"stability": .5, "similarity_boost": .85, "style": 0.0, "use_speaker_boost": True}
VOICES = {
    "eva": {"label": "Eva", "voice_id": "weA4Q36twV5kwSaTEL0Q"},
    "cold_android": {"label": "Cold Android", "voice_id": "nPijfmaNgvm5OSN4xM8H"},
    "peter": {"label": "Peter", "voice_id": "TumdjBNWanlT3ysvclWh"},
    "elowen": {"label": "Elowen", "voice_id": "dvbL7qkNGZY1IqPGZAjM"},
    "maisie": {"label": "Maisie", "voice_id": "QtY3JBOUKEB5xzrRfOKc"},
    "warren": {"label": "Warren", "voice_id": "7QN34D2r3hCNwbOYIeK0"},
}
DEFAULT_EFFECTS = {"autotune_amount": 0, "pitch_semitones": 0, "key": 0,
                   "scale": "minor", "melody": "follow", "octave": 3, "note_beats": 1}


def validate_effects(payload):
    if payload is None:
        payload = {}
    if not isinstance(payload, dict) or set(payload) - set(DEFAULT_EFFECTS):
        raise ServiceError("Use the supported voice effect settings.")
    result = {**DEFAULT_EFFECTS, **payload}
    for name, low, high in (("autotune_amount", 0, 1), ("pitch_semitones", -12, 12)):
        value = result[name]
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not low <= value <= high:
            raise ServiceError(f"{name} must be a number from {low} to {high}.")
        result[name] = float(value)
    for name, low, high in (("key", 0, 11), ("octave", 2, 5)):
        value = result[name]
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise ServiceError(f"{name} must be a whole number from {low} to {high}.")
    if not isinstance(result["scale"], str) or result["scale"] not in {"minor", "major", "chromatic"}:
        raise ServiceError("Choose a minor, major or chromatic voice scale.")
    if not isinstance(result["melody"], str) or result["melody"] not in {"follow", *MELODY_PATTERNS}:
        raise ServiceError("Choose a supported voice melody.")
    beats = result["note_beats"]
    if isinstance(beats, bool) or not isinstance(beats, (int, float)) or beats not in (.5, 1, 2):
        raise ServiceError("Voice notes must last half, one or two beats.")
    result["note_beats"] = float(beats)
    return result


def _read_wav(path, *, normalized=False):
    try:
        if not 44 < Path(path).stat().st_size <= 128 * 1024 * 1024:
            raise ValueError
        with wave.open(str(path), "rb") as source:
            rate, channels = source.getframerate(), source.getnchannels()
            frames = source.getnframes()
            if source.getsampwidth() != 2 or source.getcomptype() != "NONE" or channels not in (1, 2):
                raise ValueError
            if not 8000 <= rate <= 96000 or not 0 < frames <= MAX_SECONDS * rate:
                raise ValueError
            if normalized and (rate != RATE or channels != 1):
                raise ValueError
            pcm = source.readframes(frames)
            if len(pcm) != frames * channels * 2:
                raise ValueError
        return pcm, rate, channels
    except (OSError, ValueError, EOFError, wave.Error):
        raise GenerationError("The saved voice must be a complete, supported PCM16 WAV file.") from None


def _write_wav(destination, pcm, rate, channels=1):
    destination = Path(destination)
    created = False
    try:
        with destination.open("xb") as output:
            created = True
            with wave.open(output, "wb") as audio:
                audio.setnchannels(channels)
                audio.setsampwidth(2)
                audio.setframerate(rate)
                audio.writeframes(pcm)
            output.flush()
            os.fsync(output.fileno())
    except Exception:
        if created:
            destination.unlink(missing_ok=True)
        raise
    return {"sample_rate": rate, "channels": channels, "frames": len(pcm) // (2 * channels),
            "duration_seconds": len(pcm) / (2 * channels * rate), "size_bytes": destination.stat().st_size}


def _header_identifier(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,200}", value) else None


class VoiceChangerClient:
    def __init__(self, api_key, timeout):
        self.api_key = api_key
        self.timeout = min(float(timeout), 180.0)
        self.tls_context = create_tls_context()

    def convert(self, source_path, destination_path, voice_id):
        if voice_id not in {voice["voice_id"] for voice in VOICES.values()}:
            raise GenerationError("The selected rap voice is unavailable; no different voice was substituted.")
        if Path(destination_path).exists():
            raise GenerationError("The converted vocal already exists; no new conversion was submitted.")
        source_pcm, _, _ = _read_wav(source_path, normalized=True)
        fields = {"model_id": MODEL_ID, "voice_settings": json.dumps(VOICE_SETTINGS),
                  "seed": "1729", "remove_background_noise": "false"}
        boundary = "keirzo-rap-voice-" + uuid.uuid4().hex
        parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
                 for name, value in fields.items()]
        parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="rap.wav"\r\n'
                      'Content-Type: audio/wav\r\n\r\n').encode() + Path(source_path).read_bytes()
                     + f"\r\n--{boundary}--\r\n".encode())
        outgoing = request.Request(
            f"https://api.elevenlabs.io/v1/speech-to-speech/{voice_id}?output_format=pcm_24000",
            data=b"".join(parts), method="POST", headers={"xi-api-key": self.api_key,
                "Accept": "audio/*", "Content-Type": "multipart/form-data; boundary=" + boundary})
        pcm, receipt = self._download(outgoing)
        if len(pcm) % 2 or pcm.startswith((b"RIFF", b"ID3", b"OggS", b"fLaC")):
            raise GenerationError("Voice conversion returned an unsupported audio format. No automatic retry was made.")
        difference = (len(pcm) - len(source_pcm)) / (2 * RATE)
        if abs(difference) > TIMING_TOLERANCE_SECONDS:
            raise GenerationError("The converted voice changed the performance length by more than 120 ms. It was not played out of time; no automatic retry was made.")
        # Tiny codec/provider endpoint drift must not move the beat grid or
        # change playback length. Larger differences above are never stretched.
        pcm = pcm[:len(source_pcm)].ljust(len(source_pcm), b"\0")
        metadata = _write_wav(destination_path, pcm, RATE)
        metadata.update(receipt, model_id=MODEL_ID, voice_id=voice_id, output_format="pcm_24000",
                        voice_settings=dict(VOICE_SETTINGS), seed=1729, remove_background_noise=False,
                        provider_duration_difference_seconds=difference,
                        source_sha256=hashlib.sha256(source_pcm).hexdigest())
        return metadata

    def _download(self, outgoing):
        try:
            deadline = time.monotonic() + self.timeout
            with request.build_opener(NoRedirect, request.HTTPSHandler(context=self.tls_context)).open(outgoing, timeout=self.timeout) as response:
                if getattr(response, "status", 200) != 200:
                    raise GenerationError("Voice conversion returned an unexpected HTTP status. No automatic retry was made.", "unknown")
                content_type = response.headers.get_content_type().lower()
                if content_type not in {"audio/pcm", "audio/x-pcm", "application/octet-stream"}:
                    raise GenerationError("Voice conversion did not return the requested PCM audio. No automatic retry was made.")
                declared = response.headers.get("Content-Length")
                expected = None
                if declared is not None:
                    try:
                        expected = int(declared)
                    except ValueError:
                        raise GenerationError("Voice conversion returned an invalid response length.", "unknown") from None
                    if not 0 < expected <= MAX_PCM_BYTES:
                        raise GenerationError("Voice conversion returned empty or oversized audio.")
                chunks, size = [], 0
                while True:
                    if time.monotonic() > deadline:
                        raise TimeoutError
                    chunk = response.read(65536)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                    if size > MAX_PCM_BYTES:
                        raise GenerationError("Voice conversion exceeded the local audio size limit.")
                if not size:
                    raise GenerationError("Voice conversion returned empty audio.")
                if expected is not None and expected != size:
                    raise GenerationError("The voice conversion download was incomplete; no automatic retry was made.", "unknown")
                return b"".join(chunks), {"provider_content_type": content_type,
                    "provider_request_id": _header_identifier(response.headers.get("request-id")),
                    "provider_history_item_id": _header_identifier(response.headers.get("history-item-id")),
                    "provider_character_cost": _header_identifier(response.headers.get("character-cost")),
                    "provider_size_bytes": size}
        except error.HTTPError as exc:
            status = exc.code
            exc.close()  # Error bodies may echo credentials or participant text.
            messages = {401: "ElevenLabs rejected the API key.",
                        402: "Voice conversion requires sufficient ElevenLabs credits.",
                        403: "This account cannot access the selected voice or Voice Changer.",
                        404: "The selected voice is no longer available.",
                        422: "ElevenLabs rejected this voice conversion request.",
                        429: "ElevenLabs rate-limited this voice conversion."}
            uncertain = status >= 500 or status == 408
            message = messages.get(status, f"Voice conversion returned HTTP {status}.")
            if uncertain:
                message += " The provider outcome is unknown; another request may incur another charge."
            raise GenerationError(message + " No automatic retry was made.", "unknown" if uncertain else "failed") from None
        except GenerationError:
            raise
        except (error.URLError, ssl.SSLCertVerificationError) as exc:
            reason = exc.reason if isinstance(exc, error.URLError) else exc
            if isinstance(reason, ssl.SSLCertVerificationError):
                raise GenerationError("The HTTPS connection could not verify ElevenLabs' certificate. Repair Python's trusted CA certificates and restart the dashboard.") from None
            raise GenerationError("The voice conversion connection was interrupted. The provider outcome is unknown; no automatic retry was made.", "unknown") from None
        except (TimeoutError, ConnectionError, OSError, http.client.IncompleteRead):
            raise GenerationError("The voice conversion connection was interrupted. The provider outcome is unknown; no automatic retry was made.", "unknown") from None


def _run_ffmpeg(command, *, input_bytes=None):
    try:
        result = subprocess.run(command, input=input_bytes, capture_output=True, timeout=90, check=False)
        if result.returncode:
            raise GenerationError("The local voice audio could not be processed.")
        return result.stdout
    except (OSError, subprocess.TimeoutExpired):
        raise GenerationError("Local voice processing could not finish. Check the ffmpeg installation.") from None


def _decode(path, *, ffmpeg, channels, rate=None):
    """Decode bounded audio; omit rate to preserve the instrumental's rate."""
    args = [str(ffmpeg), "-v", "error", "-nostdin", "-xerror", "-i", str(path),
            "-map", "0:a:0", "-t", str(MAX_SECONDS + 1), "-ac", str(channels)]
    if rate is not None:
        args += ["-ar", str(rate)]
    data = _run_ffmpeg(args + ["-c:a", "pcm_s16le", "-f", "wav", "pipe:1"])
    try:
        with wave.open(io.BytesIO(data), "rb") as source:
            actual_rate = source.getframerate()
            if source.getsampwidth() != 2 or source.getnchannels() != channels or not 8000 <= actual_rate <= 96000:
                raise ValueError
            pcm = source.readframes((MAX_SECONDS + 1) * actual_rate)
            if not 0 < len(pcm) <= MAX_SECONDS * actual_rate * channels * 2:
                raise ValueError
        return pcm, actual_rate
    except (ValueError, EOFError, wave.Error):
        raise GenerationError("The saved audio could not be decoded within the supported duration.") from None


def _pcm(samples):
    np = _numpy()
    return np.rint(np.clip(samples * 32768, -32768, 32767)).astype("<i2").tobytes()


def render_vocal(source, destination, effects, *, bpm, ffmpeg):
    effects = validate_effects(effects)
    if isinstance(bpm, bool) or not isinstance(bpm, (int, float)) or not math.isfinite(bpm) or not 70 <= bpm <= 140:
        raise GenerationError("Voice effects need a tempo from 70 to 140 BPM.")
    pcm, rate, _ = _read_wav(source, normalized=True)
    metadata = {"effects": effects, "gain_db": 0.0, "timing_preserved": True}
    if effects["pitch_semitones"] or effects["autotune_amount"]:
        np = _numpy()
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float64) / 32768
        frames = len(samples)
        if effects["autotune_amount"]:
            tuned, tuning = _autotune(samples, rate, effects["key"], effects["scale"], bpm=bpm,
                melody=effects["melody"], octave=effects["octave"], note_beats=effects["note_beats"])
            amount = effects["autotune_amount"]
            samples = samples * (1 - amount) + tuned * amount
            metadata["autotune"] = tuning
        if effects["pitch_semitones"]:
            # Transpose the finished tuning result. Applying this first would
            # make fixed-note melodies cancel the user's pitch selection.
            factor = 2 ** (effects["pitch_semitones"] / 12)
            # A short silent tail lets atempo finish the final voiced window;
            # exact frame trimming keeps the original performance timeline.
            padded = np.pad(samples, (0, round(rate * .25))).astype("<f8").tobytes()
            filters = (f"asetrate={rate * factor:.9f},aresample={rate},atempo={1 / factor:.12f},"
                       f"apad=whole_len={frames},atrim=end_sample={frames}")
            raw = _run_ffmpeg([str(ffmpeg), "-v", "error", "-nostdin", "-f", "f64le", "-ar", str(rate),
                "-ac", "1", "-i", "pipe:0", "-af", filters, "-f", "f64le", "pipe:1"], input_bytes=padded)
            if len(raw) != frames * 8:
                raise GenerationError("Pitch processing changed the voice length; no mistimed audio was saved.")
            samples = np.frombuffer(raw, dtype="<f8").copy()
        if len(samples) != frames or not np.isfinite(samples).all():
            raise GenerationError("Voice processing returned invalid audio.")
        peak = float(np.max(np.abs(samples)))
        gain = min(1.0, (10 ** (-1 / 20)) / peak) if peak else 1.0
        metadata["gain_db"] = 20 * math.log10(gain)
        pcm = _pcm(samples * gain)
    metadata.update(_write_wav(destination, pcm, rate))
    return metadata


def remix_vocal(vocal, instrumental, destination, *, ffmpeg):
    np = _numpy()
    backing_pcm, rate = _decode(instrumental, ffmpeg=ffmpeg, channels=2)
    vocal_pcm, _ = _decode(vocal, ffmpeg=ffmpeg, channels=1, rate=rate)
    backing = np.frombuffer(backing_pcm, dtype="<i2").astype(np.float64).reshape(-1, 2) / 32768
    voice = np.frombuffer(vocal_pcm, dtype="<i2").astype(np.float64) / 32768
    drift = (len(voice) - len(backing)) / rate
    if abs(drift) > TIMING_TOLERANCE_SECONDS:
        raise GenerationError("The vocal and instrumental lengths differ by more than 120 ms; no mistimed full mix was saved.")
    if len(voice) < len(backing):
        voice = np.pad(voice, (0, len(backing) - len(voice)))
    mix = backing + voice[:len(backing), None]
    peak = float(np.max(np.abs(mix)))
    gain = min(1.0, 10 ** (-1 / 20) / peak) if peak else 1.0
    metadata = _write_wav(destination, _pcm(mix * gain), rate, 2)
    metadata.update(gain_db=20 * math.log10(gain), timing_preserved=True,
                    instrumental_sample_rate=rate, vocal_duration_difference_seconds=drift)
    return metadata
