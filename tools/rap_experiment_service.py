"""Independent, durable comparisons of voice delivery and rap processing.

Only POST /experiments queues provider work. Accepted requests and each stage
are persisted before submission; restarts never replay potentially charged work.
The original rap mixer service and its cached sources are left untouched.
"""
from __future__ import annotations

import copy
from datetime import datetime
import fcntl
import importlib.util
import json
import math
import os
from pathlib import Path
import queue
import re
import shutil
import sqlite3
import subprocess
import threading
import time
from typing import Any
from urllib.parse import urlsplit
import uuid

from elevenlabs_service import (ElevenLabsClient, FileResponse, GenerationError,
    ServiceError, canonical_json, digest, load_configuration, utc_now, validate_audio)
from elevenlabs_realtime import extract_stems
from rap_service import (RapTTSClient, configured_voice, validate_render, IDENTIFIER,
    REQUEST_ID, VOICE_ID, MODEL_ID, VOICES_CACHE_SECONDS)
from rap_render import render_rap

API_PREFIX = "/api/rap-experiment"
EXPRESSIVE_MODEL = "eleven_v4"
EXPRESSIVE_RATE = 24000
FAST_MODEL = "eleven_flash_v2_5"
FAST_RATE = 24000
FAST_VARIANTS = {"flash", "robot"}
PREFERRED_VOICE_ID = "g7LVvkPWALzPxOQbF6OE"
MELODIES = {"follow", "drone", "two_note", "rising", "falling", "arpeggio", "hook"}
# Public voices from ElevenLabs' migration guide and voice-library pages.
# A small shortlist remains usable when the key cannot read the full catalog.
# https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-are-default-voices
# https://elevenlabs.io/voice-library/radio-dj-voices
# https://elevenlabs.io/voice-library/angry-voices
# https://elevenlabs.io/voice-library/robotic
SUGGESTED_VOICES = [
    {"voice_id": "g7LVvkPWALzPxOQbF6OE", "name": "Jade · Upbeat and Natural"},
    {"voice_id": "dvbL7qkNGZY1IqPGZAjM", "name": "Elowen · Upbeat Modern Narrator"},
    {"voice_id": "QtY3JBOUKEB5xzrRfOKc", "name": "Maisie · Friendly Casual Neighbor"},
    {"voice_id": "7QN34D2r3hCNwbOYIeK0", "name": "Warren · Effortless and Cool"},
    {"voice_id": "WQP7cQUF5aAS6Axh5yaa", "name": "Elara · Crisp Pro Narrator"},
    {"voice_id": "fnYMz3F5gMEDGMWcH1ex", "name": "Finley · Articulate Anchor"},
    {"voice_id": "Tw2LVqLUUWkxqrCfFOpw", "name": "Cole · Gritty, Rough and Strong"},
    {"voice_id": "V33LkP9pVLdcjeB2y5Na", "name": "Maverick · Commanding and Powerful"},
    {"voice_id": "oHB9Xhox1bqMl1Tvkmel", "name": "Jerry B. · Deep and Gritty"},
    {"voice_id": "weA4Q36twV5kwSaTEL0Q", "name": "Eva · Futuristic Robot Helper"},
    {"voice_id": "nPijfmaNgvm5OSN4xM8H", "name": "Elon · Robotic and Cold Android"},
]
MAX_ACTIVE_JOBS = 2
MAX_FAST_JOBS = 2
MAX_TEXT_LENGTH = 1000
MAX_WORDS = 160
MAX_MIXER_CATALOG_BYTES = 65536
MAX_MIXER_EXAMPLES = 100
MIXER_EXAMPLE_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
ACTIVE = {"queued", "generating", "rendering"}
DELIVERIES = {
    "punchy": "[confident] [energetic]",
    "relaxed": "[relaxed] [calm]",
    "gritty": "[gritty] [intense]",
}
VARIANTS = {
    "baseline": ("Natural voice", "Continuous speech, with no added phrase gaps."),
    "phrases": ("Phrases on the beat", "The same natural recording, with phrase starts placed on beats."),
    "fresh": ("New take", "A genuinely new performance of the same words and voice."),
    "alternate": ("Different voice", "The same lyrics with the selected comparison voice."),
    "expressive": ("Expressive delivery", "Eleven v4 delivery directions and a higher-fidelity 24 kHz source."),
    "bars": ("Smooth bar timing", "The expressive take gently fitted to bars while preserving pitch."),
    "produced": ("Produced vocal", "The bar-timed take with EQ, compression and subtle stereo doubling."),
    "music": ("Generated rap", "An actual music performance, with an extracted vocal and the original full mix."),
}
DEFAULT_VARIANTS = list(VARIANTS)
VARIANTS.update({
    "flash": ("Fast clean voice", "A quick speech take before robot effects."),
    "robot": ("Fast robot voice", "The same quick take through local robot effects and filters."),
})


def validate_experiment(payload: dict[str, Any], default_voice: str, default_alternate: str = "") -> dict[str, Any]:
    settings = validate_render(payload, default_voice)
    if len(settings["text"]) > MAX_TEXT_LENGTH or len(settings["text"].split()) > MAX_WORDS:
        raise ServiceError(f"Use at most {MAX_TEXT_LENGTH} characters and {MAX_WORDS} words in a comparison.")
    delivery = payload.get("delivery", "punchy")
    if not isinstance(delivery, str) or delivery not in DELIVERIES:
        raise ServiceError("Choose punchy, relaxed or gritty delivery.")
    variants = payload.get("variants", DEFAULT_VARIANTS)
    if not isinstance(variants, list) or not variants or len(variants) > len(VARIANTS) or any(not isinstance(v, str) or v not in VARIANTS for v in variants):
        raise ServiceError("Choose one or more valid comparison examples.")
    if len(set(variants)) != len(variants):
        raise ServiceError("Each comparison example may be requested once.")
    alternate = payload.get("alternate_voice_id", default_alternate)
    if alternate is None:
        alternate = ""
    if not isinstance(alternate, str) or (alternate and not VOICE_ID.fullmatch(alternate)):
        raise ServiceError("Choose a valid comparison voice ID.")
    alternate = alternate or default_alternate
    source = payload.get("source_experiment_id")
    if source is not None and (not isinstance(source, str) or not IDENTIFIER.fullmatch(source)):
        raise ServiceError("The source experiment ID is invalid.")
    companion = {}
    if "include_clean" in payload:
        if not isinstance(payload["include_clean"], bool):
            raise ServiceError("Include clean must be true or false.")
        if payload["include_clean"]:
            if variants != ["robot"] or not source:
                raise ServiceError("A clean comparison requires saved voice audio and an effects-only request.")
            companion["include_clean"] = True
    robot = {}
    if "robot" in variants:
        style = payload.get("robot_style", "metallic")
        amount = payload.get("robot_amount", .8)
        tone = payload.get("robot_tone_hz", 4000)
        if not isinstance(style, str) or style not in {"metallic", "radio", "autotune", "vocoder"}:
            raise ServiceError("Choose autotune, metallic or radio effects.")
        for value, name, low, high in ((amount, "Robot amount", 0, 1), (tone, "Robot tone", 800, 8000)):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
                raise ServiceError(f"{name} must be a number from {low} to {high}.")
        robot = {"robot_style": style, "robot_amount": float(amount), "robot_tone_hz": float(tone)}
        # Add tuning fields only for this new preset so recovering an older
        # submitted request retains its original canonical request hash.
        if style == "autotune":
            key = payload.get("robot_key", 0)
            scale = payload.get("robot_scale", "minor")
            if isinstance(key, bool) or not isinstance(key, int) or not 0 <= key <= 11:
                raise ServiceError("Choose a musical key from C to B.")
            if not isinstance(scale, str) or scale not in {"minor", "major", "chromatic"}:
                raise ServiceError("Choose minor, major or chromatic tuning.")
            robot.update(robot_key=key, robot_scale=scale)
            # Only add new fields when explicitly supplied, preserving hashes
            # for previously accepted scale-correction requests.
            if any(field in payload for field in ("robot_melody", "robot_octave", "robot_note_beats")):
                melody = payload.get("robot_melody", "follow")
                octave = payload.get("robot_octave", 3)
                note_beats = payload.get("robot_note_beats", 1)
                if not isinstance(melody, str) or melody not in MELODIES:
                    raise ServiceError("Choose a supported melody pattern.")
                if isinstance(octave, bool) or not isinstance(octave, int) or not 2 <= octave <= 5:
                    raise ServiceError("Choose octave 2, 3, 4 or 5.")
                if isinstance(note_beats, bool) or not isinstance(note_beats, (int, float)) or note_beats not in (.5, 1, 2):
                    raise ServiceError("Choose half a beat, one beat or two beats per note.")
                robot.update(robot_melody=melody, robot_octave=octave, robot_note_beats=float(note_beats))
    rhythm = {}
    # Keep legacy request hashes stable; rhythm is opt-in for fast voices.
    if "robot_rhythm" in payload:
        mode = payload["robot_rhythm"]
        if not isinstance(mode, str) or mode not in {"natural", "phrases", "flow"}:
            raise ServiceError("Choose natural speech, phrases on beats or beat flow.")
        rhythm["robot_rhythm"] = mode
    audition = {}
    if "audition_group" in payload or "audition_label" in payload:
        group, label = payload.get("audition_group"), payload.get("audition_label")
        if not isinstance(group, str) or group not in {"neutral", "jade", "clear", "deep", "bright"}:
            raise ServiceError("Choose a neutral, Jade, clear, deep or bright audition group.")
        if not isinstance(label, str) or not 1 <= len(label.strip()) <= 120 or any(ord(char) < 32 for char in label):
            raise ServiceError("Use an audition label of 1 to 120 characters.")
        audition = {"audition_group": group, "audition_label": label.strip()}
    return {"text": settings["text"], "bpm": settings["bpm"], "voice_id": settings["voice_id"],
            "alternate_voice_id": alternate, "delivery": delivery,
            "variants": [key for key in VARIANTS if key in variants], "source_experiment_id": source, **robot, **rhythm, **audition, **companion}


class RapExperimentService:
    def __init__(self, storage_root: Path, env_path: Path, *, client=None, music_client=None, start_worker=True):
        self.root = Path(storage_root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._storage_lock = (self.root / ".service.lock").open("a")
        try:
            fcntl.flock(self._storage_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._storage_lock.close()
            raise RuntimeError("Another dashboard is using the rap experiment storage directory.") from None
        self._api_key, self.timeout, self._config_issues = load_configuration(Path(env_path))
        self.default_voice_id = configured_voice(Path(env_path), fallback=PREFERRED_VOICE_ID)
        # Public voice ID used by the provider's timestamp endpoint example.
        # Listing an account's voices is optional and may require another key scope.
        self.default_alternate_voice_id = "21m00Tcm4TlvDq8ikWAM" if self.default_voice_id != "21m00Tcm4TlvDq8ikWAM" else "JBFqnCBsd6RMkjVDRZzb"
        self.client = client or RapTTSClient(self._api_key, self.timeout)
        self.music_client = music_client or ElevenLabsClient(self._api_key, self.timeout)
        self.ffmpeg = self._find_audio_tool("ffmpeg")
        self.ffprobe = self._find_audio_tool("ffprobe")
        self._lock = threading.RLock()
        self._voices_lock = threading.Lock()
        self._voices_cache, self._voices_cached_at = None, 0
        # The durable active-job count bounds submissions; this queue also
        # accepts the shutdown sentinel when a worker has already stopped.
        self._queue = queue.Queue()
        self._fast_queue = queue.Queue()
        self._closed, self._storage_released = False, False
        self._db = sqlite3.connect(str(self.root / "experiments.sqlite3"), check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("CREATE TABLE IF NOT EXISTS experiments (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL)")
        self._db.execute("CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, job_id TEXT NOT NULL)")
        self._db.commit()
        for (body,) in self._db.execute("SELECT body FROM experiments WHERE state IN ('queued','generating','rendering')").fetchall():
            job = json.loads(body)
            for example in job["examples"]:
                if example["state"] in ACTIVE:
                    example.update(state="unknown", error="The dashboard stopped before this example finished. No automatic retry was made.")
            job.update(state="unknown", updated_at=utc_now())
            self._write(job)
        self._worker = self._fast_worker = None
        self._workers_remaining = 0
        if start_worker:
            self._workers_remaining = 2
            self._worker = threading.Thread(target=self._work, args=(self._queue,), name="rap-experiment", daemon=True)
            self._fast_worker = threading.Thread(target=self._work, args=(self._fast_queue,), name="rap-fast-voice", daemon=True)
            self._worker.start()
            self._fast_worker.start()

    def _find_audio_tool(self, name):
        local = self.root.parent / "bin" / name
        return shutil.which(name) or (str(local) if local.is_file() and os.access(local, os.X_OK) else None)

    def status(self):
        issues = list(self._config_issues)
        if not self._api_key:
            issues.append("Set ELEVENLABS_API_KEY in the local .env file to create comparisons.")
        suggestions = copy.deepcopy(SUGGESTED_VOICES)
        if self.default_voice_id == "JBFqnCBsd6RMkjVDRZzb":
            suggestions.insert(0, {"voice_id": self.default_voice_id, "name": "George · Current default"})
        return {"ready": bool(not issues and not self._closed), "api_key_configured": bool(self._api_key),
                "setup_errors": issues, "issues": issues, "default_voice_id": self.default_voice_id,
                "default_alternate_voice_id": self.default_alternate_voice_id,
                "suggested_voices": suggestions,
                "model_id": EXPRESSIVE_MODEL, "baseline_model_id": MODEL_ID, "sample_rate": EXPRESSIVE_RATE,
                "fast_model_id": FAST_MODEL, "fast_sample_rate": FAST_RATE,
                "max_text_length": MAX_TEXT_LENGTH, "max_words": MAX_WORDS, "bpm_min": 40, "bpm_max": 240,
                "music_available": bool(self.ffmpeg and self.ffprobe),
                "processing_available": importlib.util.find_spec("numpy") is not None,
                "variants": [{"id": key, "title": value[0], "description": value[1]} for key, value in VARIANTS.items()]}

    def voices(self):
        with self._voices_lock:
            if self._voices_cache is not None and time.monotonic() - self._voices_cached_at < VOICES_CACHE_SECONDS:
                return copy.deepcopy(self._voices_cache)
            if not self._api_key:
                raise ServiceError("Set ELEVENLABS_API_KEY to list voices, or enter a voice ID manually.", 503)
            catalog = self.client.list_voices()
            voices = catalog["voices"]
            self.default_alternate_voice_id = next((v["voice_id"] for v in voices if v["voice_id"] != self.default_voice_id), self.default_alternate_voice_id)
            result = {**catalog, "default_voice_id": self.default_voice_id, "default_alternate_voice_id": self.default_alternate_voice_id}
            self._voices_cache, self._voices_cached_at = result, time.monotonic()
            return copy.deepcopy(result)

    def _redact(self, message):
        return message.replace(self._api_key, "[redacted]") if self._api_key else message

    def _write(self, job):
        with self._lock:
            job["updated_at"] = utc_now()
            self._db.execute("UPDATE experiments SET state=?,body=? WHERE id=?", (job["state"], canonical_json(job), job["id"]))
            self._db.commit()

    def _job(self, identifier):
        if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
            raise ServiceError("Rap experiment not found.", 404)
        with self._lock:
            row = self._db.execute("SELECT body FROM experiments WHERE id=?", (identifier,)).fetchone()
            if row is None:
                raise ServiceError("Rap experiment not found.", 404)
            return json.loads(row[0])

    def jobs(self):
        with self._lock:
            return [json.loads(row[0]) for row in self._db.execute("SELECT body FROM experiments ORDER BY created_at DESC LIMIT 50")]

    def _mixer_example_ready(self, identifier):
        """A mixer comparison needs playable audio and a reusable matched take."""
        try:
            job = self._job(identifier)
            if not isinstance(job, dict) or job.get("state") != "complete":
                return False
            sources = job.get("sources")
            source = sources.get("flash") if isinstance(sources, dict) else None
            if not isinstance(source, dict) or source.get("state") != "complete" or source.get("voice_id") != job.get("voice_id"):
                return False
            source_id = source.get("experiment_id")
            original = self._job(source_id)
            if not isinstance(original, dict) or any(original.get(field) != job.get(field) for field in ("text", "voice_id")):
                return False
            original_sources = original.get("sources")
            original_source = original_sources.get("flash") if isinstance(original_sources, dict) else None
            if not isinstance(original_source, dict) or any(original_source.get(field) != source.get(field)
                    for field in ("state", "experiment_id", "voice_id", "model_id", "sample_rate")):
                return False
            directory = self.root / source_id
            for name in ("flash.pcm", "flash.alignment.json"):
                path = directory / name
                if not path.is_file() or not path.resolve().is_relative_to(directory.resolve()) or not path.stat().st_size:
                    return False
            examples = job.get("examples")
            if not isinstance(examples, list):
                return False
            for key in ("flash", "robot"):
                matches = [item for item in examples if isinstance(item, dict) and item.get("id") == key]
                if len(matches) != 1:
                    return False
                example = matches[0]
                if example.get("state") != "complete" or example.get("source_experiment_id") != source_id or example.get("source_example_id") != "flash":
                    return False
                if any(example.get(field) != source.get(field) for field in ("voice_id", "model_id", "sample_rate")):
                    return False
                if example.get("audio_url") != f"{API_PREFIX}/experiments/{identifier}/audio/{key}":
                    return False
                audio = self.audio_response(identifier, key)
                if not audio.path.stat().st_size:
                    return False
            return True
        except (ServiceError, OSError, ValueError, TypeError, KeyError):
            return False

    def mixer_examples(self):
        """Read curated local pairings without submitting or repairing any jobs."""
        try:
            with (self.root / "mixer-examples.json").open("rb") as catalog:
                data = catalog.read(MAX_MIXER_CATALOG_BYTES + 1)
            if len(data) > MAX_MIXER_CATALOG_BYTES:
                return []
            envelope = json.loads(data)
        except (OSError, ValueError, RecursionError):
            return []
        records = envelope.get("examples") if isinstance(envelope, dict) else None
        if not isinstance(records, list):
            return []
        result, seen = [], set()
        for item in records[:MAX_MIXER_EXAMPLES]:
            if not isinstance(item, dict):
                continue
            identifier, label = item.get("id"), item.get("label")
            if not isinstance(identifier, str) or not MIXER_EXAMPLE_ID.fullmatch(identifier) or identifier in seen:
                continue
            if not isinstance(label, str) or not 1 <= len(label.strip()) <= 120 or not label.isprintable():
                continue
            if any(not isinstance(item.get(field), str) or not IDENTIFIER.fullmatch(item[field]) for field in ("track_id", "experiment_id")):
                continue
            if not self._mixer_example_ready(item["experiment_id"]):
                continue
            result.append({"id": identifier, "label": label.strip(), "track_id": item["track_id"], "experiment_id": item["experiment_id"]})
            seen.add(identifier)
        return result

    def create_experiment(self, payload):
        settings = validate_experiment(payload, self.default_voice_id, self.default_alternate_voice_id)
        request_id = payload.get("request_id") or uuid.uuid4().hex
        if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
            raise ServiceError("The comparison request ID is invalid.")
        request_hash = digest(settings)
        with self._lock:
            existing = self._db.execute("SELECT requests.request_hash,experiments.body FROM requests JOIN experiments ON requests.job_id=experiments.id WHERE requests.request_id=?", (request_id,)).fetchone()
            if existing:
                if existing[0] != request_hash:
                    raise ServiceError("This request ID already belongs to different comparison settings.", 409)
                return json.loads(existing[1])
            if self._closed or not self.status()["ready"]:
                raise ServiceError(" ".join(self.status()["setup_errors"]) or "The comparison service is closing.", 503)
            if settings["source_experiment_id"]:
                source = self._job(settings["source_experiment_id"])
                match_fields = ("text", "voice_id") if set(settings["variants"]) <= FAST_VARIANTS else ("text", "voice_id", "delivery")
                if any(source[field] != settings[field] for field in match_fields):
                    raise ServiceError("Saved comparison audio must match the lyrics, main voice and delivery.")
            active = self._db.execute("SELECT body FROM experiments WHERE request_hash=? AND state IN ('queued','generating','rendering')", (request_hash,)).fetchone()
            if active:
                job = json.loads(active[0])
                self._db.execute("INSERT INTO requests VALUES (?,?,?)", (request_id, request_hash, job["id"]))
                self._db.commit()
                return job
            fast_lane = set(settings["variants"]) <= FAST_VARIANTS
            active_jobs = [json.loads(row[0]) for row in self._db.execute("SELECT body FROM experiments WHERE state IN ('queued','generating','rendering')")]
            count = sum(bool(job.get("fast_lane")) == fast_lane for job in active_jobs)
            if count >= (MAX_FAST_JOBS if fast_lane else MAX_ACTIVE_JOBS):
                raise ServiceError("Wait for a comparison to finish before starting another.", 429)
            identifier = uuid.uuid4().hex
            example_ids = ["flash", "robot"] if settings.get("include_clean") else settings["variants"]
            examples = [{"id": key, "title": VARIANTS[key][0], "description": VARIANTS[key][1], "state": "queued",
                         "audio_url": None, "full_mix_url": None, "error": None, "model_id": None,
                         "sample_rate": None, "notes": []} for key in example_ids]
            job = {"id": identifier, "request_id": request_id, **settings, "state": "queued", "created_at": utc_now(),
                   "updated_at": utc_now(), "examples": examples, "sources": {}, "fast_lane": fast_lane}
            self._db.execute("INSERT INTO experiments VALUES (?,?,?,?,?,?)", (identifier, request_id, request_hash, "queued", job["created_at"], canonical_json(job)))
            self._db.execute("INSERT INTO requests VALUES (?,?,?)", (request_id, request_hash, identifier))
            self._db.commit()
            (self._fast_queue if fast_lane else self._queue).put_nowait(identifier)
            return copy.deepcopy(job)

    def _save_bytes(self, path, data):
        temporary = path.with_name(path.name + ".tmp")
        try:
            with temporary.open("xb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    def _source(self, job, key):
        """At most one request per source per experiment, even after a failure."""
        source = job["sources"].get(key)
        if source is not None:
            if source["state"] != "complete":
                raise GenerationError(source.get("error") or "This source could not be prepared.", source.get("state", "failed"))
            directory = self.root / source["experiment_id"]
            return (directory / (key + ".pcm")).read_bytes(), json.loads((directory / (key + ".alignment.json")).read_text()), source
        # Explicit source reuse applies only to local processing cards. A fresh
        # expressive or baseline card in this batch always creates its own take.
        reused = job.get("source_experiment_id")
        if reused and key not in job["variants"] and key in {"baseline", "expressive", "flash"}:
            parent = self._job(reused)
            previous = parent.get("sources", {}).get(key)
            if not previous or previous.get("state") != "complete":
                raise GenerationError("The selected comparison has no reusable source for this example.")
            job["sources"][key] = copy.deepcopy(previous)
            self._write(job)
            return self._source(job, key)
        voice = job["alternate_voice_id"] if key == "alternate" else job["voice_id"]
        if key == "alternate" and (not voice or voice == job["voice_id"]):
            raise GenerationError("Choose a different comparison voice to hear this example.")
        expressive = key == "expressive"
        fast = key == "flash"
        source = {"state": "generating", "experiment_id": job["id"], "voice_id": voice,
                  "model_id": FAST_MODEL if fast else EXPRESSIVE_MODEL if expressive else MODEL_ID,
                  "sample_rate": FAST_RATE if fast else EXPRESSIVE_RATE if expressive else 16000}
        job["sources"][key] = source
        self._write(job)
        try:
            if self._closed:
                raise GenerationError("The dashboard is closing; this source was not submitted.")
            text = (DELIVERIES[job["delivery"]] + "\n" if expressive else "") + job["text"]
            settings = {"text": text, "voice_id": voice, "model_id": source["model_id"], "sample_rate": source["sample_rate"]}
            if expressive:
                settings["voice_settings"] = {"stability": .35, "similarity_boost": .75}
            elif fast:
                settings["voice_settings"] = {"stability": .65, "similarity_boost": .75,
                                               "style": 0, "use_speaker_boost": False, "speed": 1.0}
            directory = self.root / job["id"]
            self._save_bytes(directory / (key + ".request.json"), canonical_json(settings).encode())
            started = time.perf_counter()
            pcm, alignment = self.client.generate_with_timestamps(**settings)
            source["generation_seconds"] = round(time.perf_counter() - started, 4)
            if not isinstance(pcm, bytes) or not pcm or len(pcm) % 2 or len(pcm) > source["sample_rate"] * 2 * 120:
                raise GenerationError("The speech source was malformed or exceeded 120 seconds.")
            self._save_bytes(directory / (key + ".pcm"), pcm)
            self._save_bytes(directory / (key + ".alignment.json"), canonical_json(alignment).encode())
            source.update(state="complete")
        except Exception as exc:
            source.update(state=exc.state if isinstance(exc, GenerationError) else "failed",
                          error=self._redact(str(exc)) if isinstance(exc, (GenerationError, ValueError, ServiceError)) else "The voice source could not be prepared. No automatic retry was made.")
            self._write(job)
            raise GenerationError(source["error"], source["state"]) from None
        self._write(job)
        return pcm, alignment, source

    def _render_voice(self, job, example):
        from rap_experiment_render import match_loudness, render_experiment, render_fast_voice
        key = example["id"]
        source_key = "baseline" if key == "phrases" else "expressive" if key in {"bars", "produced"} else "flash" if key == "robot" else key
        pcm, alignment, source = self._source(job, source_key)
        example.update(state="rendering", model_id=source["model_id"], sample_rate=source["sample_rate"], voice_id=source["voice_id"],
                       source_example_id=source_key, source_experiment_id=source["experiment_id"])
        self._write(job)
        processing_started = time.perf_counter()
        if key in FAST_VARIANTS:
            wav, metadata = render_fast_voice(pcm, alignment, text=job["text"], bpm=job["bpm"], sample_rate=source["sample_rate"],
                                             robot=key == "robot", robot_style=job.get("robot_style", "metallic"),
                                             robot_amount=job.get("robot_amount", .8), robot_tone_hz=job.get("robot_tone_hz", 4000),
                                             robot_key=job.get("robot_key", 0), robot_scale=job.get("robot_scale", "minor"),
                                             robot_melody=job.get("robot_melody", "follow"), robot_octave=job.get("robot_octave", 3),
                                             robot_note_beats=job.get("robot_note_beats", 1),
                                             robot_rhythm=job.get("robot_rhythm", "natural"))
        elif key in {"expressive", "bars", "produced"}:
            wav, metadata = render_experiment(pcm, alignment, text=job["text"], bpm=job["bpm"], sample_rate=source["sample_rate"],
                                              timing_mode="natural" if key == "expressive" else "bars", produced=key == "produced")
        else:
            wav, metadata = render_rap(pcm, alignment, text=job["text"], bpm=job["bpm"], sample_rate=source["sample_rate"],
                                       timing_mode="phrase_beats" if key == "phrases" else "natural")
            wav, loudness = match_loudness(wav)
            metadata.update(loudness)
        self._save_bytes(self.root / job["id"] / (key + ".wav"), wav)
        example.update(metadata)
        reused = source["experiment_id"] != job["id"]
        example["timings"] = {"source_seconds": 0.0 if reused else source.get("generation_seconds"),
                              "processing_seconds": round(time.perf_counter() - processing_started, 4),
                              "source_reused": reused}
        example.update(state="complete", audio_url=f"{API_PREFIX}/experiments/{job['id']}/audio/{key}",
                       filename=key + ".wav", content_type="audio/wav", error=None)
        example["notes"].append("Playback levels are matched for comparison, with clipping protection.")
        if key == "expressive":
            example["notes"].append(f"{job['delivery'].capitalize()} delivery; requested audio tags are suggestions to the voice model.")

    def _validate_music(self, path, duration):
        audio = validate_audio(path, duration, self.ffmpeg, self.ffprobe)
        result = subprocess.run([self.ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels", "-of", "json", str(path)], capture_output=True, timeout=60, check=False)
        try:
            stream = json.loads(result.stdout)["streams"][0]
            audio.update(sample_rate=int(stream["sample_rate"]), channels=int(stream["channels"]))
        except (ValueError, KeyError, IndexError, TypeError):
            raise GenerationError("The generated music has invalid audio metadata.") from None
        return audio

    def _render_music(self, job, example):
        if not self.ffmpeg or not self.ffprobe:
            raise GenerationError("Install FFmpeg and ffprobe to compare generated rap and extract its vocal.")
        directory = self.root / job["id"]
        bar_seconds = 240 / job["bpm"]
        bars = max(4, math.ceil((len(job["text"].split()) / 2.2 + bar_seconds) / bar_seconds))
        duration = min(90, bars * bar_seconds)
        provider_request = {"model_id": "music_v2_5", "composition_plan": {"chunks": [{
            "text": "[Rap verse]\n" + job["text"], "duration_ms": round(duration * 1000),
            "positive_styles": ["hip hop", "rhythmic rap vocals", f"{job['bpm']:g} BPM", "4/4 time",
                                f"{job['delivery']} vocal delivery", "clear intelligible words", "dry upfront solo rap vocal",
                                "minimal drums and bass", "rap begins immediately", "precise supplied lyrics"],
            "negative_styles": ["singing", "long instrumental intro", "backing choir"], "context_adherence": "high"}]}}
        example.update(model_id="music_v2_5", notes=["This model chooses its own vocal identity; the speech voice selections do not apply.",
                        "BPM is requested from the music model; its actual groove may vary."])
        self._save_bytes(directory / "music.request.json", canonical_json(provider_request).encode())
        self._write(job)
        temporary, archive = directory / "music.download", directory / "music.stems.zip"
        try:
            self.music_client.generate(provider_request, temporary)
            full = self._validate_music(temporary, duration)
            full_path = directory / ("music_full." + full["extension"])
            temporary.replace(full_path)
            example.update(full_mix_url=f"{API_PREFIX}/experiments/{job['id']}/audio/music_full", full_mix_filename=full_path.name,
                           full_mix_content_type=full["content_type"], full_mix_sample_rate=full["sample_rate"],
                           full_mix_duration_seconds=full["duration_seconds"], state="rendering", stage="separating-vocal")
            # Retain the full mix even if separation is unavailable or fails.
            self._write(job)
            if self._closed:
                raise GenerationError("The dashboard is closing; the full mix was saved, but vocal separation was not submitted.")
            self.music_client.separate_stems(full_path, archive, "two_stems_v1")
            stems = extract_stems(archive, directory / "stems", full["duration_seconds"], self._validate_music)
            vocal = next((s for s in stems if any(term in s["id"].split("_") for term in ("vocal", "vocals", "voice")) and not any(term in s["id"].split("_") for term in ("no", "non", "without", "instrumental"))), None)
            if vocal is None:
                raise GenerationError("No identifiable vocal stem was returned. The full mix is still available.")
            example.update(state="complete", stage="complete", audio_url=f"{API_PREFIX}/experiments/{job['id']}/audio/music",
                           filename="stems/" + vocal["filename"], content_type=vocal["content_type"],
                           sample_rate=vocal["sample_rate"], duration_seconds=vocal["duration_seconds"], error=None)
            example["notes"].append("Vocal separation can leave traces of instruments; compare the full mix too.")
        finally:
            temporary.unlink(missing_ok=True)
            archive.unlink(missing_ok=True)

    def _run_job(self, identifier):
        job = self._job(identifier)
        if job["state"] != "queued":
            return
        started = time.perf_counter()
        queue_seconds = max(0.0, time.time() - datetime.fromisoformat(job["created_at"].replace("Z", "+00:00")).timestamp())
        job["timings"] = {"queue_seconds": round(queue_seconds, 4)}
        job["state"] = "generating"
        self._write(job)
        try:
            (self.root / identifier).mkdir(exist_ok=True)
            for example in job["examples"]:
                if self._closed:
                    example.update(state="failed", error="The dashboard closed before this example was submitted.")
                    continue
                example["state"] = "generating"
                self._write(job)
                try:
                    if example["id"] == "music":
                        self._render_music(job, example)
                    else:
                        self._render_voice(job, example)
                except GenerationError as exc:
                    example.update(state=exc.state, error=self._redact(str(exc)))
                except (ValueError, ServiceError) as exc:
                    example.update(state="failed", error=self._redact(str(exc)))
                except ImportError:
                    example.update(state="failed", error="Install NumPy to prepare this audio-processing example.")
                except Exception:
                    example.update(state="failed", error="This example could not finish. No automatic retry was made.")
                example.setdefault("timings", {})["ready_seconds"] = round(queue_seconds + time.perf_counter() - started, 4)
                self._write(job)
            states = [example["state"] for example in job["examples"]]
            job["state"] = "complete" if all(state == "complete" for state in states) else "partial" if "complete" in states else "unknown" if "unknown" in states else "failed"
        except Exception:
            job["state"] = "failed"
            for example in job["examples"]:
                if example["state"] in ACTIVE:
                    example.update(state="failed", error="The comparison could not be saved. Check local disk space and permissions.")
        job["timings"]["ready_seconds"] = round(queue_seconds + time.perf_counter() - started, 4)
        self._write(job)

    def _work(self, work_queue):
        try:
            while True:
                identifier = work_queue.get()
                try:
                    if identifier is None or self._closed:
                        return
                    self._run_job(identifier)
                finally:
                    work_queue.task_done()
        finally:
            with self._lock:
                self._workers_remaining -= 1
                if self._closed and self._workers_remaining == 0:
                    self._close_storage()

    def audio_response(self, identifier, example_id):
        job = self._job(identifier)
        full_mix = example_id == "music_full"
        key = "music" if full_mix else example_id
        example = next((item for item in job["examples"] if item["id"] == key), None)
        if not example:
            raise ServiceError("Comparison audio not found.", 404)
        filename = example.get("full_mix_filename" if full_mix else "filename")
        if not filename:
            raise ServiceError("This example has no saved audio yet.", 409)
        path = self.root / identifier / filename
        if not path.is_file() or not path.resolve().is_relative_to((self.root / identifier).resolve()):
            raise ServiceError("The comparison audio is missing.", 404)
        return FileResponse(path, example["full_mix_content_type" if full_mix else "content_type"])

    def dispatch(self, method, path, payload=None):
        try:
            path = urlsplit(path).path
            if not path.startswith(API_PREFIX + "/"):
                raise ServiceError("Endpoint not found.", 404)
            parts = path[len(API_PREFIX) + 1:].strip("/").split("/")
            if payload is not None and not isinstance(payload, dict):
                raise ServiceError("The request body must be a JSON object.")
            if method == "GET" and parts == ["status"]:
                return 200, self.status()
            if method == "GET" and parts == ["voices"]:
                return 200, self.voices()
            if method == "GET" and parts == ["mixer-examples"]:
                return 200, {"examples": self.mixer_examples()}
            if parts == ["experiments"]:
                if method == "GET":
                    return 200, {"experiments": self.jobs()}
                if method == "POST":
                    return 202, self.create_experiment(payload or {})
            if method == "GET" and parts[0] == "experiments":
                if len(parts) == 2:
                    return 200, self._job(parts[1])
                if len(parts) == 4 and parts[2] == "audio":
                    return 200, self.audio_response(parts[1], parts[3])
            raise ServiceError("Endpoint not found.", 404)
        except ServiceError as exc:
            return exc.status, {"error": self._redact(str(exc))}
        except (ValueError, TypeError, KeyError):
            return 400, {"error": "The comparison request has invalid settings."}
        except (OSError, sqlite3.Error):
            return 500, {"error": "The comparison storage operation failed. Check disk space and permissions."}

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._queue.put_nowait(None)
            self._fast_queue.put_nowait(None)
        for worker in (self._worker, self._fast_worker):
            if worker and worker.is_alive() and worker is not threading.current_thread():
                worker.join(timeout=.2)
        with self._lock:
            if self._workers_remaining == 0:
                self._close_storage()

    def _close_storage(self):
        with self._lock:
            if self._storage_released:
                return
            self._storage_released = True
            self._db.close()
            fcntl.flock(self._storage_lock.fileno(), fcntl.LOCK_UN)
            self._storage_lock.close()
