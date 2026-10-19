"""Local text-to-rap jobs: timestamped speech and natural phrase playback.

The timestamp request follows ``rapping_2026/anchor_rap_voice/elevenlabs_client``.
Its alignment and rhythm ideas are adapted in rap_render; neither the sibling
checkout nor Max, an LLM, FFmpeg, or an extra Python package is required here.
Only an explicit render submission contacts ElevenLabs. Requests are never retried.
"""

from __future__ import annotations

import base64
import binascii
import copy
import fcntl
import http.client
import json
import math
import os
from pathlib import Path
import queue
import re
import socket
import sqlite3
import threading
import time
from typing import Any
from urllib import error, request
from urllib.parse import urlencode, urlsplit
import uuid

from elevenlabs_service import (
    FileResponse, GenerationError, NoRedirect, ServiceError,
    canonical_json, create_tls_context, digest, load_configuration, utc_now,
)
from rap_render import render_rap, validate_plan


API_PREFIX = "/api/rap"
MODEL_ID = "eleven_multilingual_v2"
RENDERER = "python-natural-phrase-v2"
RENDERERS = {"natural": RENDERER, "phrase_beats": "python-phrase-beats-v3"}
DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"
SAMPLE_RATE = 16000
OUTPUT_FORMAT = "pcm_16000"
MAX_TEXT_LENGTH = 2000
MAX_WORDS = 300
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_PCM_BYTES = SAMPLE_RATE * 2 * 180
MAX_ACTIVE_JOBS = 4
MAX_VOICES = 500
MAX_VOICE_PAGE_BYTES = 2 * 1024 * 1024
VOICES_CACHE_SECONDS = 300
IDENTIFIER = re.compile(r"^[0-9a-f]{32}$")
VOICE_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{8,100}$")
ACTIVE_STATES = {"queued", "generating", "rendering"}


def configured_voice(env_path: Path, *, fallback: str = DEFAULT_VOICE_ID) -> str:
    """Read the optional voice ID without importing or evaluating dotenv code."""
    value = ""
    try:
        if env_path.is_file() and env_path.stat().st_size <= 1024 * 1024:
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("export "):
                    line = line[7:].lstrip()
                name, separator, candidate = line.partition("=")
                if separator and name.strip() == "ELEVENLABS_VOICE_ID":
                    candidate = candidate.strip()
                    if len(candidate) >= 2 and candidate[0] == candidate[-1] and candidate[0] in "\"'":
                        candidate = candidate[1:-1]
                    else:
                        candidate = candidate.split(" #", 1)[0].rstrip()
                    value = candidate
    except (OSError, UnicodeError):
        pass  # The shared configuration loader reports file errors.
    value = os.environ.get("ELEVENLABS_VOICE_ID", value).strip()
    return value if VOICE_ID.fullmatch(value) else fallback


def validate_render(payload: dict[str, Any], default_voice_id: str) -> dict[str, Any]:
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip() or not any(c.isalnum() for c in text):
        raise ServiceError("Type the words you want to rap.")
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(text) > MAX_TEXT_LENGTH or len(text.split()) > MAX_WORDS:
        raise ServiceError(f"Use at most {MAX_TEXT_LENGTH} characters and {MAX_WORDS} words per rap.")
    if any(ord(c) < 32 and c not in "\n\t" for c in text):
        raise ServiceError("The lyrics contain an unsupported control character.")
    bpm = payload.get("bpm")
    if isinstance(bpm, bool) or not isinstance(bpm, (int, float)) or not math.isfinite(bpm) or not 40 <= bpm <= 240:
        raise ServiceError("BPM must be a number from 40 to 240.")
    requested_voice_id = payload.get("voice_id", "")
    if requested_voice_id is None:
        requested_voice_id = ""
    if not isinstance(requested_voice_id, str):
        raise ServiceError("Choose a valid ElevenLabs voice ID.")
    voice_id = requested_voice_id or default_voice_id
    if not isinstance(voice_id, str) or not VOICE_ID.fullmatch(voice_id):
        raise ServiceError("Choose a valid ElevenLabs voice ID.")
    bars = payload.get("bars")
    if bars is not None and (isinstance(bars, bool) or not isinstance(bars, int) or not 1 <= bars <= 64):
        raise ServiceError("Bars must be a whole number from 1 to 64, or omitted for automatic length.")
    if bars is not None and bars * 4 * 60 / bpm > 120:
        raise ServiceError("Use fewer bars: a rap can be at most 120 seconds long.")
    settings = {"text": text, "bpm": float(bpm), "voice_id": voice_id,
                "requested_voice_id": requested_voice_id, "bars": bars}
    # Keep omitted fields absent so legacy pending submissions retain exactly
    # the same durable request hash and can be recovered without another charge.
    if "timing_mode" in payload:
        mode = payload["timing_mode"]
        if not isinstance(mode, str) or mode not in RENDERERS:
            raise ServiceError("Timing mode must be natural or phrase_beats.")
        settings["timing_mode"] = mode
    if "source_render_id" in payload:
        source = payload["source_render_id"]
        if not isinstance(source, str) or not IDENTIFIER.fullmatch(source):
            raise ServiceError("The source rap render ID is invalid.")
        settings["source_render_id"] = source
    try:
        validate_plan(text, bpm, bars, settings.get("timing_mode", "natural"))
    except ValueError as exc:
        raise ServiceError(str(exc)) from None
    return settings


class RapTTSClient:
    def __init__(self, api_key: str, timeout: float):
        self.api_key = api_key
        self.timeout = timeout
        self.tls_context = create_tls_context()

    def list_voices(self) -> dict[str, Any]:
        """Read the account's available voices with bounded v2 pagination.

        https://elevenlabs.io/docs/api-reference/voices/search documents
        page_size <= 100 and continuation via has_more/next_page_token.
        """
        voices, seen_ids, seen_tokens = [], set(), set()
        token = None
        deadline = time.monotonic() + min(self.timeout, 20)
        opener = request.build_opener(NoRedirect, request.HTTPSHandler(context=self.tls_context))
        try:
            for page in range(5):
                params = {"page_size": 100, "include_total_count": "false"}
                if token is not None:
                    params["next_page_token"] = token
                outgoing = request.Request("https://api.elevenlabs.io/v2/voices?" + urlencode(params),
                    headers={"xi-api-key": self.api_key, "Accept": "application/json"}, method="GET")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ServiceError("Loading voices timed out. You can enter a voice ID manually.", 504)
                with opener.open(outgoing, timeout=remaining) as response:
                    if getattr(response, "status", 200) != 200 or response.headers.get_content_type().lower() != "application/json":
                        raise ServiceError("ElevenLabs returned an invalid voice list. You can enter a voice ID manually.", 502)
                    length = response.headers.get("Content-Length")
                    try:
                        expected = int(length) if length is not None else None
                    except ValueError:
                        raise ServiceError("ElevenLabs returned an invalid voice list length.", 502) from None
                    if expected is not None and not 0 < expected <= MAX_VOICE_PAGE_BYTES:
                        raise ServiceError("The voice list exceeded the local size limit.", 502)
                    chunks, size = [], 0
                    while True:
                        if time.monotonic() > deadline:
                            raise ServiceError("Loading voices timed out. You can enter a voice ID manually.", 504)
                        chunk = response.read(min(65536, MAX_VOICE_PAGE_BYTES + 1 - size))
                        if not chunk:
                            break
                        chunks.append(chunk)
                        size += len(chunk)
                        if size > MAX_VOICE_PAGE_BYTES:
                            raise ServiceError("The voice list exceeded the local size limit.", 502)
                    if expected is not None and expected != size:
                        raise ServiceError("The voice list response was interrupted.", 502)
                try:
                    payload = json.loads(b"".join(chunks))
                except (ValueError, UnicodeError):
                    raise ServiceError("ElevenLabs returned invalid voice list JSON.", 502) from None
                if not isinstance(payload, dict) or not isinstance(payload.get("voices"), list) or len(payload["voices"]) > 1000:
                    raise ServiceError("ElevenLabs returned an invalid voice list.", 502)
                for index, item in enumerate(payload["voices"]):
                    if not isinstance(item, dict):
                        continue
                    voice_id, name = item.get("voice_id"), item.get("name")
                    if not isinstance(voice_id, str) or not VOICE_ID.fullmatch(voice_id) or voice_id in seen_ids:
                        continue
                    if not isinstance(name, str) or not name.strip():
                        name = voice_id
                    name = "".join(char for char in name if ord(char) >= 32)[:200].strip() or voice_id
                    voices.append({"voice_id": voice_id, "name": name})
                    seen_ids.add(voice_id)
                    if len(voices) >= MAX_VOICES:
                        return {"voices": voices, "truncated": bool(payload.get("has_more")) or index < len(payload["voices"]) - 1}
                if payload.get("has_more") is not True:
                    return {"voices": voices, "truncated": False}
                token = payload.get("next_page_token")
                if not isinstance(token, str) or not 0 < len(token) <= 2048 or token in seen_tokens:
                    raise ServiceError("ElevenLabs returned an invalid voice pagination token.", 502)
                seen_tokens.add(token)
            return {"voices": voices, "truncated": True}
        except error.HTTPError as exc:
            if exc.code in (401, 403):
                raise ServiceError("The API key cannot list voices. Enable voice-read permission or enter a voice ID manually.", exc.code) from None
            raise ServiceError("The voice list could not be loaded. You can enter a voice ID manually.", 502) from None
        except (error.URLError, TimeoutError, socket.timeout, http.client.HTTPException, OSError):
            raise ServiceError("The voice list could not be loaded. Check the connection or enter a voice ID manually.", 502) from None

    def generate_with_timestamps(self, *, text: str, voice_id: str,
                                 model_id: str = MODEL_ID, sample_rate: int = SAMPLE_RATE,
                                 voice_settings: dict[str, Any] | None = None) -> tuple[bytes, dict[str, Any]]:
        if not VOICE_ID.fullmatch(voice_id):
            raise GenerationError("The ElevenLabs voice ID is invalid.")
        if model_id not in {MODEL_ID, "eleven_v3", "eleven_v4", "eleven_flash_v2_5"} or sample_rate not in {16000, 24000, 44100}:
            raise GenerationError("The speech model or PCM sample rate is unsupported.")
        body = {"text": text, "model_id": model_id}
        if voice_settings is not None:
            body["voice_settings"] = voice_settings
        max_pcm_bytes = sample_rate * 2 * 180
        max_response_bytes = max(MAX_RESPONSE_BYTES, max_pcm_bytes * 4 // 3 + 2 * 1024 * 1024)
        outgoing = request.Request(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps?output_format=pcm_{sample_rate}",
            data=canonical_json(body).encode("utf-8"),
            headers={"xi-api-key": self.api_key, "Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            deadline = time.monotonic() + self.timeout
            opener = request.build_opener(NoRedirect, request.HTTPSHandler(context=self.tls_context))
            with opener.open(outgoing, timeout=self.timeout) as response:
                if getattr(response, "status", 200) != 200:
                    raise GenerationError("ElevenLabs returned an unexpected status. No automatic retry was made.", "unknown")
                if response.headers.get_content_type().lower() != "application/json":
                    raise GenerationError("ElevenLabs did not return timestamped speech JSON.")
                length = response.headers.get("Content-Length")
                try:
                    expected = int(length) if length is not None else None
                except ValueError:
                    raise GenerationError("ElevenLabs returned an invalid response length.") from None
                if expected is not None and not 0 < expected <= max_response_bytes:
                    raise GenerationError("The speech response exceeded the local size limit.")
                chunks = []
                total = 0
                while True:
                    if time.monotonic() > deadline:
                        raise GenerationError("The speech request timed out. It was not retried automatically.", "unknown")
                    chunk = response.read(min(65536, max_response_bytes + 1 - total))
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_response_bytes:
                        raise GenerationError("The speech response exceeded the local size limit.")
                    chunks.append(chunk)
                if expected is not None and total != expected:
                    raise GenerationError("The speech response was interrupted. It was not retried automatically.", "unknown")
                try:
                    payload = json.loads(b"".join(chunks))
                    encoded = payload.pop("audio_base64")
                    if not isinstance(encoded, str):
                        raise ValueError
                    pcm = base64.b64decode(encoded, validate=True)
                except (ValueError, TypeError, KeyError, AttributeError, binascii.Error):
                    raise GenerationError("ElevenLabs returned invalid speech audio or JSON.") from None
                if not pcm or len(pcm) % 2 or len(pcm) > max_pcm_bytes:
                    raise GenerationError("The speech audio was empty, malformed, or longer than 180 seconds.")
                return pcm, payload
        except error.HTTPError as exc:
            messages = {
                401: "The ElevenLabs API key was rejected. Check the local .env file.",
                403: "ElevenLabs denied access to this voice or speech model.",
                402: "ElevenLabs has insufficient speech credits for this request.",
                404: "The ElevenLabs voice was not found. Choose another voice ID.",
                422: "ElevenLabs rejected the speech settings or text.",
                429: "ElevenLabs is rate limited. Try again later.",
            }
            message = messages.get(exc.code, "ElevenLabs could not complete the speech request. No automatic retry was made.")
            raise GenerationError(message, "unknown" if exc.code >= 500 else "failed") from None
        except (error.URLError, TimeoutError, socket.timeout, http.client.HTTPException, OSError):
            raise GenerationError("The speech request could not finish. Check the connection; no automatic retry was made.", "unknown") from None


class RapService:
    def __init__(self, storage_root: Path, env_path: Path, *, client=None, start_worker: bool = True):
        self.root = Path(storage_root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._storage_lock = (self.root / ".service.lock").open("a")
        try:
            fcntl.flock(self._storage_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._storage_lock.close()
            raise RuntimeError("Another dashboard is already using the rap storage directory.") from None
        self._api_key, self.timeout, self._config_issues = load_configuration(Path(env_path))
        self.default_voice_id = configured_voice(Path(env_path))
        self.client = client or RapTTSClient(self._api_key, self.timeout)
        self._lock = threading.RLock()
        self._voices_lock = threading.Lock()
        self._voices_cache = None
        self._voices_cached_at = 0.0
        self._queue: queue.Queue[str | None] = queue.Queue(MAX_ACTIVE_JOBS + 1)
        self._closed = False
        self._storage_released = False
        self._db = sqlite3.connect(str(self.root / "renders.sqlite3"), check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("CREATE TABLE IF NOT EXISTS renders (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL)")
        self._db.execute("CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, job_id TEXT NOT NULL)")
        self._db.execute("INSERT OR IGNORE INTO requests SELECT request_id, request_hash, id FROM renders")
        self._db.commit()
        # A stopped process may have already incurred a provider charge. Never
        # resume a queued/ambiguous request behind the user's back.
        for (body,) in self._db.execute("SELECT body FROM renders WHERE state IN ('queued','generating','rendering')").fetchall():
            job = json.loads(body)
            job.update(state="unknown", error="The dashboard stopped before the rap finished. Submit a new render to try again.", updated_at=utc_now())
            self._write(job)
        self._worker = None
        if start_worker:
            self._worker = threading.Thread(target=self._work, name="rap-render", daemon=True)
            self._worker.start()

    def status(self) -> dict[str, Any]:
        issues = list(self._config_issues)
        if not self._api_key:
            issues.append("Set ELEVENLABS_API_KEY in the local .env file to render a rap.")
        return {"ready": not issues and not self._closed, "api_key_configured": bool(self._api_key),
                "setup_errors": issues, "issues": issues, "default_voice_id": self.default_voice_id,
                "model_id": MODEL_ID, "sample_rate": SAMPLE_RATE, "beats_per_bar": 4,
                "bpm_min": 40, "bpm_max": 240, "max_text_length": MAX_TEXT_LENGTH,
                "max_words": MAX_WORDS, "max_duration_seconds": 120,
                "generation_timeout_seconds": self.timeout, "renderer": RENDERER,
                "timing_modes": list(RENDERERS), "renderers": dict(RENDERERS)}

    def voices(self) -> dict[str, Any]:
        # A separate lock prevents duplicate reads without blocking render jobs
        # while the provider returns the account's voice catalog.
        with self._voices_lock:
            if self._voices_cache is not None and time.monotonic() - self._voices_cached_at < VOICES_CACHE_SECONDS:
                return copy.deepcopy(self._voices_cache)
            if not self._api_key:
                raise ServiceError("Set ELEVENLABS_API_KEY to list voices, or enter a voice ID manually.", 503)
            catalog = self.client.list_voices()
            result = {"voices": catalog["voices"], "default_voice_id": self.default_voice_id,
                      "truncated": catalog.get("truncated", False)}
            self._voices_cache, self._voices_cached_at = result, time.monotonic()
            return copy.deepcopy(result)

    def _source_available(self, job: dict[str, Any]) -> bool:
        if job.get("state") != "complete" or job.get("sample_rate") != SAMPLE_RATE:
            return False
        try:
            pcm = self.root / (job["id"] + ".source.pcm")
            alignment = self.root / (job["id"] + ".alignment.json")
            return (0 < pcm.stat().st_size <= MAX_PCM_BYTES and pcm.stat().st_size % 2 == 0
                    and 0 < alignment.stat().st_size <= MAX_RESPONSE_BYTES)
        except OSError:
            return False

    def _source_for(self, settings: dict[str, Any]) -> dict[str, Any]:
        source = self._job(settings["source_render_id"])
        if source.get("text") != settings["text"] or source.get("voice_id") != settings["voice_id"]:
            raise ServiceError("The saved voice must match these lyrics and the selected voice.")
        if not self._source_available(source):
            raise ServiceError("This rap has no reusable source audio. Prepare a new voice render.", 409)
        return source

    def _redact(self, text: str) -> str:
        return text.replace(self._api_key, "[redacted]") if self._api_key else text

    def _write(self, job: dict[str, Any]) -> None:
        self._db.execute("UPDATE renders SET state=?, body=? WHERE id=?", (job["state"], canonical_json(job), job["id"]))
        self._db.commit()

    def _job(self, identifier: str) -> dict[str, Any]:
        if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
            raise ServiceError("Rap render not found.", 404)
        with self._lock:
            row = self._db.execute("SELECT body FROM renders WHERE id=?", (identifier,)).fetchone()
            if row is None:
                raise ServiceError("Rap render not found.", 404)
            job = json.loads(row[0])
            job["source_available"] = self._source_available(job)
            return job

    def jobs(self) -> list[dict[str, Any]]:
        with self._lock:
            jobs = [json.loads(row[0]) for row in self._db.execute("SELECT body FROM renders ORDER BY created_at DESC LIMIT 50")]
            for job in jobs:
                job["source_available"] = self._source_available(job)
            return jobs

    def create_render(self, payload: dict[str, Any]) -> dict[str, Any]:
        settings = validate_render(payload, self.default_voice_id)
        request_id = payload.get("request_id") or uuid.uuid4().hex
        if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
            raise ServiceError("The render request ID is invalid.")
        request_hash = digest(settings)
        with self._lock:
            existing = self._db.execute("SELECT requests.request_hash, renders.body FROM requests JOIN renders ON requests.job_id = renders.id WHERE requests.request_id=?", (request_id,)).fetchone()
            if existing:
                if existing[0] != request_hash:
                    raise ServiceError("This request ID already belongs to different lyrics or settings.", 409)
                job = json.loads(existing[1])
                job["source_available"] = self._source_available(job)
                return job
            if "source_render_id" in settings:
                self._source_for(settings)
            if self._closed or ("source_render_id" not in settings and not self.status()["ready"]):
                raise ServiceError(" ".join(self.status()["setup_errors"]) or "The rap service is closing.", 503)
            # Double clicks from separate clients still reuse identical pending
            # work. Completed jobs may deliberately be regenerated with a new ID.
            active = self._db.execute("SELECT body FROM renders WHERE request_hash=? AND state IN ('queued','generating','rendering')", (request_hash,)).fetchone()
            if active:
                job = json.loads(active[0])
                self._db.execute("INSERT INTO requests VALUES (?,?,?)", (request_id, request_hash, job["id"]))
                self._db.commit()
                return job
            count = self._db.execute("SELECT COUNT(*) FROM renders WHERE state IN ('queued','generating','rendering')").fetchone()[0]
            if count >= MAX_ACTIVE_JOBS:
                raise ServiceError("The rap render queue is full. Wait for a render to finish.", 429)
            identifier = uuid.uuid4().hex
            mode = settings.get("timing_mode", "natural")
            job = {"id": identifier, "request_id": request_id, "state": "queued",
                   "created_at": utc_now(), "updated_at": utc_now(), **settings,
                   "beats_per_bar": 4, "sample_rate": SAMPLE_RATE, "model_id": MODEL_ID,
                   "renderer": RENDERERS[mode], "timing_mode": mode, "source_available": False,
                   "reused_source": "source_render_id" in settings,
                   "audio_url": None, "word_timings": [], "warnings": [], "error": None}
            self._db.execute("INSERT INTO renders VALUES (?,?,?,?,?,?)", (identifier, request_id, request_hash, "queued", job["created_at"], canonical_json(job)))
            self._db.execute("INSERT INTO requests VALUES (?,?,?)", (request_id, request_hash, identifier))
            self._db.commit()
            self._queue.put_nowait(identifier)
            return copy.deepcopy(job)

    def _run_job(self, identifier: str) -> None:
        with self._lock:
            job = self._job(identifier)
            if job["state"] != "queued":
                return
            job.update(state="rendering" if job.get("source_render_id") else "generating", updated_at=utc_now())
            self._write(job)
        destination = self.root / (identifier + ".wav")
        temporary = self.root / (identifier + ".wav.tmp")
        try:
            if job.get("source_render_id"):
                source = self._source_for(job)
                pcm = (self.root / (source["id"] + ".source.pcm")).read_bytes()
                alignment_payload = json.loads((self.root / (source["id"] + ".alignment.json")).read_text(encoding="utf-8"))
            else:
                pcm, alignment_payload = self.client.generate_with_timestamps(text=job["text"], voice_id=job["voice_id"])
            # Retain the original delivery for comparison and future local
            # processing. These source files are not exposed as static assets.
            (self.root / (identifier + ".source.pcm")).write_bytes(pcm)
            (self.root / (identifier + ".alignment.json")).write_text(canonical_json(alignment_payload), encoding="utf-8")
            with self._lock:
                job.update(state="rendering", updated_at=utc_now())
                self._write(job)
            wav, metadata = render_rap(pcm, alignment_payload, text=job["text"], bpm=job["bpm"], sample_rate=SAMPLE_RATE,
                                       bars=job["bars"], timing_mode=job.get("timing_mode", "natural"))
            with temporary.open("xb") as audio:
                audio.write(wav)
                audio.flush()
                os.fsync(audio.fileno())
            temporary.replace(destination)
            job.update(metadata)
            job.update(state="complete", updated_at=utc_now(), audio_url=f"{API_PREFIX}/renders/{identifier}/audio", error=None,
                       timing_mode=job.get("timing_mode") if job.get("timing_mode") in RENDERERS else "natural")
            job["source_available"] = self._source_available(job)
        except GenerationError as exc:
            job.update(state=exc.state, updated_at=utc_now(), error=self._redact(str(exc)))
        except ServiceError as exc:
            job.update(state="failed", updated_at=utc_now(), error=self._redact(str(exc)))
        except ValueError as exc:
            job.update(state="failed", updated_at=utc_now(), error=self._redact(str(exc)))
        except OSError:
            job.update(state="failed", updated_at=utc_now(), error="The rap audio could not be saved. Check local disk space and permissions.")
        except Exception:
            job.update(state="failed", updated_at=utc_now(), error="The rap could not be rendered. No automatic retry was made.")
        finally:
            temporary.unlink(missing_ok=True)
        with self._lock:
            self._write(job)

    def _work(self) -> None:
        try:
            while True:
                identifier = self._queue.get()
                try:
                    if identifier is None or self._closed:
                        return
                    self._run_job(identifier)
                finally:
                    self._queue.task_done()
        finally:
            if self._closed:
                self._close_storage()

    def audio_response(self, identifier: str) -> FileResponse:
        job = self._job(identifier)
        if job["state"] != "complete":
            raise ServiceError("Rap audio is available when rendering has finished.", 409)
        path = self.root / (identifier + ".wav")
        if not path.is_file():
            raise ServiceError("The saved rap audio is missing. Render the lyrics again.", 404)
        return FileResponse(path, "audio/wav")

    def dispatch(self, method: str, path: str, payload: dict[str, Any] | None = None) -> tuple[int, dict[str, Any] | FileResponse]:
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
            if parts == ["renders"]:
                if method == "POST":
                    return 202, self.create_render(payload or {})
                if method == "GET":
                    return 200, {"jobs": self.jobs()}
            if method == "GET" and len(parts) in {2, 3} and parts[0] == "renders":
                if len(parts) == 2:
                    return 200, self._job(parts[1])
                if parts[2] == "audio":
                    return 200, self.audio_response(parts[1])
            raise ServiceError("Endpoint not found.", 404)
        except ServiceError as exc:
            return exc.status, {"error": self._redact(str(exc))}
        except (ValueError, TypeError, KeyError):
            return 400, {"error": "The rap request has invalid settings."}
        except (OSError, sqlite3.Error):
            return 500, {"error": "The local rap storage operation failed. Check disk space and permissions."}

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._queue.put_nowait(None)
        if self._worker and self._worker.is_alive():
            self._worker.join(timeout=0.2)
        if not self._worker or not self._worker.is_alive():
            self._close_storage()

    def _close_storage(self) -> None:
        with self._lock:
            if self._storage_released:
                return
            self._storage_released = True
            self._db.close()
            fcntl.flock(self._storage_lock.fileno(), fcntl.LOCK_UN)
            self._storage_lock.close()
