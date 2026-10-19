"""Local ElevenLabs storage, job queue, and bounded provider client.

The dashboard owns HTTP origin checks and file streaming. This module never sends
source recordings to the provider and never retries an ambiguous generation.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import queue
import re
import shutil
import sqlite3
import ssl
import subprocess
import threading
import time
from typing import Any
from urllib import error, request
from urllib.parse import parse_qs, urlsplit
import uuid
import zipfile

from elevenlabs_analysis import (
    SCHEMA_VERSION, analyze_dataset, compile_plan, parse_dataset, synthetic_dataset, validate_request,
)
from elevenlabs_realtime import (
    STEM_ID, STEM_VARIATIONS, compile_live_plan, compile_prompt_plan, extract_stems,
    original_music_plan, validated_continuation_request,
)


API_PREFIX = "/api/elevenlabs"
PROVIDER_URL = "https://api.elevenlabs.io/v1/music?output_format=auto"
STEM_PROVIDER_URL = "https://api.elevenlabs.io/v1/music/stem-separation"
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_AUDIO_BYTES = 128 * 1024 * 1024
IDENTIFIER = re.compile(r"^[0-9a-f]{32}$")
ACTIVE_STATES = {"queued", "generating"}
CACHE_KEY_VERSION = 2


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def semantic_hash_value(value: Any) -> Any:
    """Match JSON number semantics across Python and browser round trips."""
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {key: semantic_hash_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [semantic_hash_value(item) for item in value]
    return value


def plan_cache_key(plan: dict[str, Any]) -> str:
    """Hash effective settings, treating omitted optional flags as their defaults.

    Artifacts retain their exact original values. This separate representation
    lets saved plans and browser-rebuilt equivalents share a result safely.
    """
    analysis_settings = copy.deepcopy(plan["analysis_settings"])
    baseline = copy.deepcopy(plan["baseline"])
    channels = []
    for original in analysis_settings.get("channels", []):
        meaning = original["meaning"]
        channel = {
            "name": original["name"], "meaning": meaning,
            "change_based": meaning == "scalar" and bool(original.get("change_based", False)),
        }
        saved = baseline.get(channel["name"], {})
        for bound in ("lower_bound", "upper_bound"):
            effective = saved.get(bound, original.get(bound))
            if effective not in (None, ""):
                channel[bound] = effective
        if saved:
            saved["change_based"] = channel["change_based"]
        channels.append(channel)
    analysis_settings["channels"] = channels
    if "baseline" in analysis_settings:
        analysis_settings["baseline"] = baseline
    return digest(semantic_hash_value({
        "cache_key_version": CACHE_KEY_VERSION,
        "dataset_hash": plan["dataset_hash"], "analysis_settings": analysis_settings,
        "baseline": baseline, "mapping_version": plan["mapping_version"],
        "mapping_settings": plan["settings"], "request": plan["request"], "output_format": "auto",
    }))


def atomic_json(path: Path, value: Any) -> None:
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            handle.write(canonical_json(value))
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


@dataclass(frozen=True)
class FileResponse:
    path: Path
    content_type: str
    download_name: str | None = None


class ServiceError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class GenerationError(Exception):
    def __init__(self, message: str, state: str = "failed"):
        super().__init__(message)
        self.state = state


def load_configuration(env_path: Path) -> tuple[str, float, list[str]]:
    """Read only these settings; dotenv is data, never executable shell code."""
    settings: dict[str, str] = {}
    issues: list[str] = []
    names = {"ELEVENLABS_API_KEY", "ELEVENLABS_TIMEOUT_SECONDS"}
    try:
        if env_path.is_file():
            if env_path.stat().st_size > 1024 * 1024:
                issues.append("The .env file is too large to read (maximum 1 MiB).")
            else:
                for line in env_path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if line.startswith("export "):
                        line = line[7:].lstrip()
                    key, separator, value = line.partition("=")
                    if separator and key.strip() in names:
                        value = value.strip()
                        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                            value = value[1:-1]
                        else:
                            value = value.split(" #", 1)[0].rstrip()
                        settings[key.strip()] = value
    except (OSError, UnicodeError):
        issues.append("Unable to read the local .env file.")
    for name in names:
        if name in os.environ:
            settings[name] = os.environ[name]
    timeout = 300.0
    try:
        timeout = float(settings.get("ELEVENLABS_TIMEOUT_SECONDS", "300"))
        if not math.isfinite(timeout) or not 15 <= timeout <= 1800:
            raise ValueError
    except ValueError:
        issues.append("ELEVENLABS_TIMEOUT_SECONDS must be between 15 and 1800 seconds.")
        timeout = 300.0
    key = settings.get("ELEVENLABS_API_KEY", "").strip()
    if "\r" in key or "\n" in key:
        issues.append("ELEVENLABS_API_KEY must be a single line.")
        key = ""
    return key, timeout, issues


class NoRedirect(request.HTTPRedirectHandler):
    """Do not forward the credential header to a redirect destination."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def create_tls_context() -> ssl.SSLContext:
    """Use verified TLS, including the OS CA bundle on unconfigured Python builds.

    Some macOS Python installations have no default certificate file despite a
    system trust bundle being available. Add that bundle only when the default
    context has no loaded CA certificates; never weaken hostname verification.
    """
    context = ssl.create_default_context()
    system_bundle = Path("/etc/ssl/cert.pem")
    if context.cert_store_stats().get("x509_ca", 0) == 0 and system_bundle.is_file():
        try:
            context.load_verify_locations(cafile=str(system_bundle))
        except (OSError, ssl.SSLError):
            # Keep certificate verification enabled; the connection will report
            # an actionable setup failure if no usable trust store is available.
            pass
    return context


class ElevenLabsClient:
    def __init__(self, api_key: str, timeout: float):
        self.api_key = api_key
        self.timeout = timeout
        self.tls_context = create_tls_context()

    def generate(self, provider_request: dict[str, Any], destination: Path) -> dict[str, Any]:
        body = canonical_json(provider_request).encode("utf-8")
        outgoing = request.Request(
            PROVIDER_URL,
            data=body,
            headers={"xi-api-key": self.api_key, "Content-Type": "application/json", "Accept": "audio/*"},
            method="POST",
        )
        return self._download(outgoing, destination)

    def separate_stems(self, source: Path, destination: Path, variation: str) -> dict[str, Any]:
        if variation not in STEM_VARIATIONS or not 0 < source.stat().st_size <= MAX_AUDIO_BYTES:
            raise GenerationError("The saved track or stem variation is not supported.")
        boundary = "codex-elevenlabs-" + uuid.uuid4().hex
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"stem_variation_id\"\r\n\r\n{variation}\r\n"
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio{source.suffix}\"\r\n"
                "Content-Type: application/octet-stream\r\n\r\n").encode()
        body += source.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        outgoing = request.Request(STEM_PROVIDER_URL, data=body, method="POST", headers={
            "xi-api-key": self.api_key, "Content-Type": "multipart/form-data; boundary=" + boundary,
            "Accept": "application/zip",
        })
        return self._download(outgoing, destination, archive=True)

    def _download(self, outgoing: request.Request, destination: Path, *, archive: bool = False) -> dict[str, Any]:
        try:
            deadline = time.monotonic() + self.timeout
            with request.build_opener(NoRedirect, request.HTTPSHandler(context=self.tls_context)).open(outgoing, timeout=self.timeout) as response:
                if getattr(response, "status", 200) != 200:
                    raise GenerationError("ElevenLabs returned an unexpected HTTP status. The result was not saved.", "unknown")
                media_type = response.headers.get_content_type().lower()
                accepted = media_type in {"application/zip", "application/x-zip-compressed", "application/octet-stream"} if archive else media_type.startswith("audio/") or media_type == "application/octet-stream"
                if not accepted:
                    raise GenerationError("ElevenLabs returned a non-audio response. No playable result was saved.")
                content_length = response.headers.get("Content-Length")
                expected_length = None
                if content_length is not None:
                    try:
                        expected_length = int(content_length)
                    except ValueError:
                        raise GenerationError("ElevenLabs returned an invalid audio response length.", "unknown") from None
                    if expected_length < 0 or expected_length > MAX_AUDIO_BYTES:
                        raise GenerationError("The generated audio exceeded the local response size limits.")
                total = 0
                with destination.open("xb") as audio:
                    while True:
                        if time.monotonic() > deadline:
                            raise TimeoutError
                        chunk = response.read(64 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > MAX_AUDIO_BYTES:
                            raise GenerationError("The generated audio exceeded the local 128 MiB limit.")
                        audio.write(chunk)
                    audio.flush()
                    os.fsync(audio.fileno())
                if total == 0:
                    raise GenerationError("ElevenLabs returned empty audio. No playable result was saved.")
                if expected_length is not None and total != expected_length:
                    raise GenerationError("The audio download was incomplete. The provider outcome is unknown; no automatic retry was made.", "unknown")
                song_id = response.headers.get("song-id") or response.headers.get("x-song-id")
                if song_id and not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", song_id):
                    song_id = None
                return {"provider_content_type": media_type, "provider_song_id": song_id, "size_bytes": total}
        except error.HTTPError as exc:
            # A provider error body can echo credentials or request content. Never
            # surface it in the UI, persisted jobs, or exceptions.
            status = exc.code
            exc.close()
            messages = {
                401: "ElevenLabs rejected the API key. Check the backend .env configuration.",
                402: "ElevenLabs requires sufficient credits or a supported account plan.",
                403: "This ElevenLabs account does not have access to the requested music generation.",
                422: "ElevenLabs rejected the composition plan. Inspect the saved request.",
                429: "ElevenLabs rate-limited this request. Nothing will be retried automatically.",
            }
            uncertain = status >= 500 or status == 408
            message = messages.get(status, "ElevenLabs returned HTTP %s." % status)
            if uncertain:
                message += " The provider outcome is unknown; another attempt may incur another charge."
            raise GenerationError(message, "unknown" if uncertain else "failed") from None
        except GenerationError:
            raise
        except (error.URLError, ssl.SSLCertVerificationError) as exc:
            reason = exc.reason if isinstance(exc, error.URLError) else exc
            if isinstance(reason, ssl.SSLCertVerificationError):
                raise GenerationError(
                    "The HTTPS connection could not verify ElevenLabs' certificate. Install or repair Python's trusted CA certificates "
                    "(or the system /etc/ssl/cert.pem bundle) and restart the dashboard. The generation request was not sent."
                ) from None
            raise GenerationError(
                "The generation connection was interrupted or timed out. The provider outcome is unknown; "
                "another attempt may incur another charge. No automatic retry was made.", "unknown"
            ) from None
        except (TimeoutError, ConnectionError, OSError, http.client.IncompleteRead):
            raise GenerationError(
                "The generation connection was interrupted or timed out. The provider outcome is unknown; "
                "another attempt may incur another charge. No automatic retry was made.", "unknown"
            ) from None


def validate_audio(path: Path, requested_duration: float, ffmpeg: str, ffprobe: str) -> dict[str, Any]:
    """Decode all frames before exposing audio and inspect the actual container."""
    try:
        probe = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=format_name,duration:stream=codec_type", "-of", "json", str(path)],
            capture_output=True, timeout=60, check=False,
        )
        metadata = json.loads(probe.stdout) if probe.returncode == 0 else {}
        audio_format = metadata.get("format", {})
        duration = float(audio_format.get("duration", "nan"))
        if not any(item.get("codec_type") == "audio" for item in metadata.get("streams", [])):
            raise ValueError
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError
        names = set(audio_format.get("format_name", "").split(","))
        formats = [
            ("mp3", "mp3", "audio/mpeg"), ("wav", "wav", "audio/wav"),
            ("flac", "flac", "audio/flac"), ("ogg", "ogg", "audio/ogg"),
            ("mov", "m4a", "audio/mp4"), ("aac", "aac", "audio/aac"),
        ]
        identified = next((item for item in formats if item[0] in names), None)
        if identified is None:
            raise ValueError
        decoded = subprocess.run(
            [ffmpeg, "-v", "error", "-xerror", "-err_detect", "explode", "-i", str(path), "-map", "0:a:0", "-f", "null", "-"],
            capture_output=True, timeout=min(1200, max(60, requested_duration * 2)), check=False,
        )
        if decoded.returncode != 0:
            raise ValueError
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        raise GenerationError("The returned audio failed full decode or format validation. No playable result was saved.") from None
    tolerance = max(0.5, requested_duration * 0.02)
    warning = None
    if abs(duration - requested_duration) > tolerance:
        warning = "Measured duration %.2fs differs from the requested %.2fs. Section boundaries remain planned timings." % (duration, requested_duration)
    return {
        "duration_seconds": duration, "format": identified[0], "extension": identified[1],
        "content_type": identified[2], "timing_warning": warning,
        "requested_duration_seconds": requested_duration,
    }


class ElevenLabsService:
    def __init__(self, storage_root: Path, env_path: Path, *, client=None, start_worker: bool = True):
        self.root = Path(storage_root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._storage_lock = (self.root / ".service.lock").open("a")
        try:
            fcntl.flock(self._storage_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._storage_lock.close()
            raise RuntimeError("Another dashboard is already using the ElevenLabs storage directory. Stop that dashboard before starting another instance.") from None
        self._storage_released = False
        for folder in ("datasets", "analyses", "plans", "jobs", "exports"):
            (self.root / folder).mkdir(exist_ok=True)
        self._api_key, self.timeout, self._config_issues = load_configuration(Path(env_path))
        self.ffmpeg = self._find_audio_tool("ffmpeg")
        self.ffprobe = self._find_audio_tool("ffprobe")
        self.client = client or ElevenLabsClient(self._api_key, self.timeout)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(str(self.root / "jobs.sqlite3"), check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, cache_key TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL)")
        self._db.execute("CREATE INDEX IF NOT EXISTS jobs_cache_key ON jobs(cache_key)")
        self._db.commit()
        self._db.execute("CREATE TABLE IF NOT EXISTS live_requests (session_id TEXT NOT NULL, sequence INTEGER NOT NULL, request_hash TEXT NOT NULL, job_id TEXT, plan_id TEXT NOT NULL, PRIMARY KEY(session_id, sequence))")
        self._db.commit()
        self._queue: queue.Queue[str | tuple[str, str] | None] = queue.Queue()
        self._closed = False
        self._worker: threading.Thread | None = None
        self._recover()
        if start_worker:
            self._worker = threading.Thread(target=self._work, name="elevenlabs-generation", daemon=True)
            self._worker.start()

    def _find_audio_tool(self, name: str) -> str | None:
        found = shutil.which(name)
        local = self.root.parent / "bin" / name
        return found or (str(local) if local.is_file() and os.access(local, os.X_OK) else None)

    def _redact(self, message: str) -> str:
        return message.replace(self._api_key, "[redacted]") if self._api_key else message

    def status(self) -> dict[str, Any]:
        issues = list(self._config_issues)
        if not self._api_key:
            issues.append("Set ELEVENLABS_API_KEY in the local .env file to enable generation.")
        if not self.ffmpeg or not self.ffprobe:
            issues.append("Install FFmpeg (including ffprobe) and restart the dashboard to validate generated audio.")
        return {
            "ready": not issues, "api_key_configured": bool(self._api_key),
            "ffmpeg_available": bool(self.ffmpeg), "ffprobe_available": bool(self.ffprobe),
            "setup_errors": issues, "generation_timeout_seconds": self.timeout,
            "model_id": "music_v2_5", "output_format": "auto", "max_upload_bytes": MAX_UPLOAD_BYTES,
            "realtime_available": True, "stem_variations": sorted(STEM_VARIATIONS),
            "separate_stems_by_default": True,
        }

    def _record_path(self, kind: str, identifier: str) -> Path:
        if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
            raise ServiceError("Record not found.", 404)
        return self.root / kind / (identifier + ".json")

    def _read(self, kind: str, identifier: str) -> dict[str, Any]:
        path = self._record_path(kind, identifier)
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            if kind == "plans":
                derived_key = plan_cache_key(record)
                if record.get("cache_key") != derived_key:
                    record["legacy_cache_key"] = record.get("cache_key")
                record["cache_key"] = derived_key
                record["cache_key_version"] = CACHE_KEY_VERSION
            return record
        except FileNotFoundError:
            raise ServiceError("Record not found.", 404) from None
        except (OSError, ValueError):
            raise ServiceError("A saved local record could not be read.", 500) from None

    def _save(self, kind: str, body: dict[str, Any]) -> dict[str, Any]:
        body = copy.deepcopy(body)
        body["id"] = uuid.uuid4().hex
        body["created_at"] = utc_now()
        atomic_json(self._record_path(kind, body["id"]), body)
        return body

    @staticmethod
    def _dataset_view(dataset: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in dataset.items() if key != "rows"}

    def create_dataset(self, payload: dict[str, Any]) -> dict[str, Any]:
        if payload.get("synthetic") is True:
            dataset = synthetic_dataset()
        else:
            content, filename = payload.get("content"), payload.get("filename", "recording.csv")
            if not isinstance(content, str) or not isinstance(filename, str):
                raise ServiceError("Upload a CSV or JSONL file with filename and text content.")
            if len(content.encode("utf-8")) > MAX_UPLOAD_BYTES:
                raise ServiceError("Recording exceeds the 8 MiB upload limit.", 413)
            if len(filename) > 255:
                raise ServiceError("Filename must be at most 255 characters.")
            dataset = parse_dataset(content, Path(filename).name)
        return self._dataset_view(self._save("datasets", dataset))

    def create_analysis(self, payload: dict[str, Any]) -> dict[str, Any]:
        dataset = self._read("datasets", payload.get("dataset_id"))
        settings = payload.get("settings", {key: value for key, value in payload.items() if key != "dataset_id"})
        if not isinstance(settings, dict):
            raise ServiceError("Analysis settings must be an object.")
        analysis = analyze_dataset(dataset, settings)
        analysis["dataset_id"] = dataset["id"]
        return self._save("analyses", analysis)

    def create_plan(self, payload: dict[str, Any]) -> dict[str, Any]:
        if payload.get("kind") == "original":
            plan = original_music_plan(payload)
            plan["cache_key"] = plan_cache_key(plan)
            plan["cache_key_version"] = CACHE_KEY_VERSION
            return self._save("plans", plan)
        analysis = self._read("analyses", payload.get("analysis_id"))
        dataset = self._read("datasets", analysis["dataset_id"])
        settings = payload.get("settings", {key: value for key, value in payload.items() if key not in {"analysis_id", "request"}})
        if not isinstance(settings, dict):
            raise ServiceError("Mapping settings must be an object.")
        plan = compile_plan(analysis, settings)
        plan["analysis_id"] = analysis["id"]
        plan["dataset_id"] = analysis["dataset_id"]
        plan["dataset_name"] = dataset["filename"]
        plan["analysis_settings"] = analysis["settings"]
        plan["manual_edits"] = False
        if "request" in payload:
            edited = copy.deepcopy(payload["request"])
            validate_request(edited)
            original_chunks = plan["request"]["composition_plan"]["chunks"]
            edited_chunks = edited["composition_plan"]["chunks"]
            if [chunk["duration_ms"] for chunk in original_chunks] != [chunk["duration_ms"] for chunk in edited_chunks]:
                raise ServiceError("Manual edits must preserve section count and durations so source alignment remains accurate.")
            plan["request"] = edited
            plan["manual_edits"] = True
            # The replacement request has passed validation. Preserve analysis
            # blockers, but discard errors belonging only to the replaced request.
            plan["blocking_reasons"] = list(analysis.get("blocking_reasons", []))
            plan["can_generate"] = not plan["blocking_reasons"]
            for section, chunk in zip(plan["sections"], edited_chunks):
                section["positive_styles"] = chunk["positive_styles"]
                section["negative_styles"] = chunk["negative_styles"]
                section["text"] = chunk["text"]
                section["context_adherence"] = chunk["context_adherence"]
                section["manual_edits"] = True
                section["suggested_mapping_descriptors"] = section.pop("descriptors", {})
                section["descriptors"] = {"manual": chunk["positive_styles"]}
                section["emitted_descriptors"] = {
                    "positive_styles": chunk["positive_styles"], "negative_styles": chunk["negative_styles"],
                }
        plan["cache_key"] = plan_cache_key(plan)
        plan["cache_key_version"] = CACHE_KEY_VERSION
        return self._save("plans", plan)

    def plans(self) -> list[dict[str, Any]]:
        records = []
        for path in sorted((self.root / "plans").glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
            try:
                record = self._read("plans", path.stem)
                if not record.get("realtime"):
                    records.append(record)
                    if len(records) >= 200:
                        break
            except ServiceError:
                continue
        return records

    def _write_job(self, job: dict[str, Any]) -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO jobs (id,cache_key,state,created_at,body) VALUES (?,?,?,?,?)",
            (job["id"], job["cache_key"], job["state"], job["created_at"], canonical_json(job)),
        )
        self._db.commit()
        study = getattr(self, "study_recorder", None)
        if study is not None:
            study.record_job("elevenlabs", job)

    def _job(self, identifier: str) -> dict[str, Any]:
        self._record_path("jobs", identifier)
        with self._lock:
            row = self._db.execute("SELECT body FROM jobs WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise ServiceError("Generation not found.", 404)
        return json.loads(row[0])

    def jobs(self, plan_id: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT body FROM jobs ORDER BY created_at DESC LIMIT 500").fetchall()
        jobs = [json.loads(row[0]) for row in rows]
        return [job for job in jobs if plan_id is None or job["plan_id"] == plan_id]

    def _provider_busy(self) -> bool:
        rows = self._db.execute("SELECT body FROM jobs").fetchall()
        return any(job["state"] in ACTIVE_STATES or job.get("stem_separation", {}).get("state") in ACTIVE_STATES
                   for job in (json.loads(row[0]) for row in rows))

    def create_continuation_job(self, payload: dict[str, Any]) -> dict[str, Any]:
        validated = validated_continuation_request(payload)
        fingerprint = digest(semantic_hash_value(validated))
        with self._lock:
            saved = self._db.execute("SELECT request_hash,job_id,plan_id FROM live_requests WHERE session_id=? AND sequence=?",
                                     (validated["session_id"], validated["sequence"])).fetchone()
            if saved:
                if saved[0] != fingerprint:
                    raise ServiceError("This session sequence already has a different saved request.", 409)
                if saved[1]:
                    result = self._job(saved[1])
                    result["reused"] = True
                    return result
                # A restart between the durable job and idempotency record must
                # reuse that job, including an unknown provider outcome.
                existing = self._db.execute("SELECT body FROM jobs").fetchall()
                existing = next((json.loads(row[0]) for row in existing if json.loads(row[0])["plan_id"] == saved[2]), None)
                if existing:
                    self._db.execute("UPDATE live_requests SET job_id=? WHERE session_id=? AND sequence=?",
                                     (existing["id"], validated["session_id"], validated["sequence"]))
                    self._db.commit()
                    existing["reused"] = True
                    return existing
            if self._closed:
                raise ServiceError("The generation service is shutting down.", 503)
            if self._provider_busy():
                raise ServiceError("Another music or stem request is pending. Keep playing the current track and wait for it to finish.", 409)
            if saved:
                plan = self._read("plans", saved[2])
            else:
                anchor = self._read("plans", validated["plan_id"])
                if anchor.get("realtime"):
                    anchor = self._read("plans", anchor["realtime"]["root_plan_id"])
                source = None
                if validated["source_job_id"] is not None:
                    source = self._job(validated["source_job_id"])
                    self.audio_response(source)
                    source_plan = self._read("plans", source["plan_id"])
                    source_root = self._read("plans", source_plan["realtime"]["root_plan_id"]) if source_plan.get("realtime") else source_plan
                    if source_root["id"] != anchor["id"] and source_root["cache_key"] != anchor["cache_key"]:
                        raise ServiceError("The current track must use this session's original plan.")
                plan = (compile_prompt_plan(anchor, validated) if validated.get("kind") == "prompt"
                        else compile_live_plan(anchor, validated, fingerprint))
                # Conditioning is optional and only references provider IDs
                # saved by this backend from explicitly retained generations.
                plan["request"]["store_for_inpainting"] = True
                plan["realtime"]["conditioning_applied"] = False
                continuity = validated.get("continuity_mode")
                if source and continuity != "fresh":
                    source_request = json.loads((self.root / "jobs" / source["id"] / "request.json").read_text())
                    song_id = source["audio"].get("provider_song_id")
                    if source_request.get("store_for_inpainting") is True and song_id:
                        # Encoders can add padding beyond the provider's song
                        # timeline (e.g. 20.04s MP3 for a 20s request).
                        requested_ms = sum(chunk["duration_ms"] for chunk in source_request["composition_plan"]["chunks"])
                        end_ms = min(600000, requested_ms, int(source["audio"]["duration_seconds"] * 1000))
                        if end_ms > 0:
                            chunk = plan["request"]["composition_plan"]["chunks"][0]
                            chunk["conditioning_ref"] = {"song_id": song_id, "range": {"start_ms": max(0, end_ms - 30000), "end_ms": end_ms}}
                            # Old saved requests keep their original high
                            # conditioning; the explicit Evolve option leaves
                            # more room for the next-track prompt to change it.
                            strength = "low" if continuity == "evolve" else "high"
                            chunk["condition_strength"] = strength
                            plan["sections"][0]["conditioning_ref"] = copy.deepcopy(chunk["conditioning_ref"])
                            plan["sections"][0]["condition_strength"] = strength
                            plan["realtime"]["conditioning_applied"] = True
                validate_request(plan["request"])
                plan["cache_key"] = plan_cache_key(plan)
                plan["cache_key_version"] = CACHE_KEY_VERSION
                plan = self._save("plans", plan)
                self._db.execute("INSERT INTO live_requests VALUES (?,?,?,?,?)", (
                    validated["session_id"], validated["sequence"], fingerprint, None, plan["id"],
                ))
                self._db.commit()
            job = self.create_generation({"plan_id": plan["id"]})
            self._db.execute("UPDATE live_requests SET job_id=? WHERE session_id=? AND sequence=?",
                             (job["id"], validated["session_id"], validated["sequence"]))
            self._db.commit()
            return job

    def create_stem_job(self, identifier: str, variation: str = "six_stems_v1") -> dict[str, Any]:
        if not isinstance(variation, str) or variation not in STEM_VARIATIONS:
            raise ServiceError("stem_variation_id must be six_stems_v1 or two_stems_v1.")
        with self._lock:
            job = self._job(identifier)
            self.audio_response(job)
            if job.get("stem_separation"):
                if job["stem_separation"]["stem_variation_id"] != variation:
                    raise ServiceError("This track already has a stem request with a different variation.", 409)
                result = self.get_stem_job(identifier)
                result["reused"] = True
                return result
            if self._closed:
                raise ServiceError("The generation service is shutting down.", 503)
            if self._provider_busy():
                raise ServiceError("Another music or stem request is pending. Wait until it finishes.", 409)
            setup = self.status()
            if not setup["ready"]:
                raise ServiceError(" ".join(setup["setup_errors"]), 503)
            result = self._new_stem_separation(identifier, variation)
            job["stem_separation"] = result
            self._write_job(job)
            self._queue.put(("stems", identifier))
            return copy.deepcopy(result)

    @staticmethod
    def _new_stem_separation(identifier: str, variation: str = "six_stems_v1") -> dict[str, Any]:
        timestamp = utc_now()
        return {"generation_id": identifier, "state": "queued", "stem_variation_id": variation,
                "created_at": timestamp, "updated_at": timestamp, "error": None, "stems": []}

    def get_stem_job(self, identifier: str) -> dict[str, Any]:
        with self._lock:
            job = self._job(identifier)
            result = job.get("stem_separation")
            if not result:
                return {"generation_id": identifier, "state": "not_requested", "error": None, "stems": []}
            if result["state"] == "complete":
                for stem in result["stems"]:
                    path = self.root / "jobs" / identifier / "stems" / stem["filename"]
                    if not path.is_file() or path.stat().st_size != stem["size_bytes"]:
                        result.update(state="failed", error="A saved stem is missing or incomplete. The original track is still available.", updated_at=utc_now())
                        self._write_job(job)
                        break
            return copy.deepcopy(result)

    def resolve_stem_audio(self, identifier: str, stem_id: str) -> FileResponse:
        if not STEM_ID.fullmatch(stem_id):
            raise ServiceError("Stem not found.", 404)
        result = self.get_stem_job(identifier)
        if result["state"] != "complete":
            raise ServiceError("Stems are available after successful validation.", 409)
        stem = next((item for item in result["stems"] if item["id"] == stem_id), None)
        if stem is None:
            raise ServiceError("Stem not found.", 404)
        return FileResponse(self.root / "jobs" / identifier / "stems" / stem["filename"], stem["content_type"])

    def create_generation(self, payload: dict[str, Any]) -> dict[str, Any]:
        plan = self._read("plans", payload.get("plan_id"))
        if not plan.get("can_generate", False):
            raise ServiceError("This plan cannot be generated: " + "; ".join(plan.get("blocking_reasons", ["analysis validation failed"])))
        validate_request(plan["request"])
        variation = payload.get("variation", False)
        if not isinstance(variation, bool):
            raise ServiceError("variation must be true or false.")
        with self._lock:
            if self._closed:
                raise ServiceError("The generation service is shutting down.", 503)
            matches = [json.loads(row[0]) for row in self._db.execute(
                "SELECT body FROM jobs WHERE cache_key=? ORDER BY created_at DESC", (plan["cache_key"],)
            ).fetchall()]
            for job in matches:
                self._check_saved_audio(job)
            # Even a variation double-click cannot create duplicate in-flight work.
            existing = next((job for job in matches if job["state"] in ACTIVE_STATES), None)
            if existing is None and not variation:
                existing = next((job for job in matches if job["state"] == "complete"), None)
                if existing is None and matches:
                    existing = matches[0]
            if existing is not None:
                result = copy.deepcopy(existing)
                result["reused"] = True
                return result
            if self._provider_busy():
                raise ServiceError("Another music or stem request is pending. Wait until it finishes.", 409)
            setup = self.status()
            if not setup["ready"]:
                raise ServiceError(" ".join(setup["setup_errors"]), 503)
            identifier = uuid.uuid4().hex
            job_dir = self.root / "jobs" / identifier
            job_dir.mkdir()
            # The exact credential-free request is durable before submission.
            atomic_json(job_dir / "request.json", plan["request"])
            timestamp = utc_now()
            job = {
                "id": identifier, "plan_id": plan["id"], "cache_key": plan["cache_key"],
                "cache_key_version": CACHE_KEY_VERSION,
                "state": "queued", "attempt_count": len(matches) + 1, "variation": variation,
                "requested_duration_seconds": sum(chunk["duration_ms"] for chunk in plan["request"]["composition_plan"]["chunks"]) / 1000,
                "created_at": timestamp, "updated_at": timestamp, "error": None, "audio": None,
                "model_id": plan["request"]["model_id"], "output_format": "auto",
                "generation_settings": copy.deepcopy(plan["settings"]),
                # Persist intent before generation so a restart retains the
                # pipeline, without retroactively charging for older tracks.
                "separate_stems": True,
            }
            if plan.get("realtime"):
                job["realtime"] = copy.deepcopy(plan["realtime"])
            self._write_job(job)
            self._queue.put(identifier)
            return copy.deepcopy(job)

    def _recover(self) -> None:
        for temporary in self.root.rglob("*.tmp*"):
            if temporary.is_file():
                temporary.unlink(missing_ok=True)
        with self._lock:
            # Recovery must cover every persisted job, including records older
            # than the UI's bounded history listing.
            rows = self._db.execute("SELECT body FROM jobs ORDER BY created_at ASC").fetchall()
            attempt_counts: dict[str, int] = {}
            for row in rows:
                job = json.loads(row[0])
                changed = False
                try:
                    plan = self._read("plans", job["plan_id"])
                except ServiceError:
                    plan = None
                if plan is not None and (job["cache_key"] != plan["cache_key"] or job.get("cache_key_version") != CACHE_KEY_VERSION):
                    job.setdefault("legacy_cache_key", job["cache_key"])
                    job.update(cache_key=plan["cache_key"], cache_key_version=CACHE_KEY_VERSION, cache_migrated_at=utc_now())
                    changed = True
                attempt_counts[job["cache_key"]] = attempt_counts.get(job["cache_key"], 0) + 1
                if job["attempt_count"] != attempt_counts[job["cache_key"]]:
                    job["attempt_count"] = attempt_counts[job["cache_key"]]
                    changed = True
                if changed:
                    self._write_job(job)
                if job["state"] == "complete":
                    self._check_saved_audio(job)
                    if job["state"] == "complete" and job.get("separate_stems") is True and not job.get("stem_separation"):
                        job["stem_separation"] = self._new_stem_separation(job["id"])
                        self._write_job(job)
                elif job["state"] == "generating":
                    job.update(state="unknown", updated_at=utc_now(), error="The dashboard stopped during generation. The provider outcome is unknown; another attempt may incur another charge.")
                    self._write_job(job)
                elif job["state"] == "queued":
                    self._queue.put(job["id"])
                separation = job.get("stem_separation")
                if separation and separation["state"] == "generating":
                    separation.update(state="unknown", updated_at=utc_now(), error="The dashboard stopped during stem separation. The provider outcome is unknown; no automatic retry was made.")
                    self._write_job(job)
                elif separation and separation["state"] == "queued":
                    self._queue.put(("stems", job["id"]))
        for directory in (self.root / "jobs").glob("*/stems.tmp*"):
            if directory.is_dir():
                shutil.rmtree(directory, ignore_errors=True)

    def _check_saved_audio(self, job: dict[str, Any]) -> None:
        if job["state"] != "complete":
            return
        path = self.root / "jobs" / job["id"] / job.get("audio_filename", "missing")
        expected_size = (job.get("audio") or {}).get("size_bytes")
        try:
            actual_size = path.stat().st_size if path.is_file() else 0
        except OSError:
            actual_size = 0
        if actual_size > 0 and (expected_size is None or actual_size == expected_size):
            return
        job.update(state="failed", updated_at=utc_now(), error="The saved audio is missing or incomplete. No new request was sent; generate another variation only if you want a new paid attempt.")
        job.pop("audio_url", None)
        job.pop("export_url", None)
        with self._lock:
            self._write_job(job)

    def _work(self) -> None:
        try:
            while True:
                identifier = self._queue.get()
                try:
                    if identifier is None or self._closed:
                        return
                    if isinstance(identifier, tuple):
                        self._run_stem_job(identifier[1])
                    else:
                        self._run_job(identifier)
                finally:
                    self._queue.task_done()
        finally:
            if self._closed:
                self._close_storage()

    def _run_job(self, identifier: str) -> None:
        started = time.monotonic()
        temporary = self.root / "jobs" / identifier / "audio.tmp"
        with self._lock:
            job = self._job(identifier)
            if job["state"] != "queued":
                return
            job.update(state="generating", updated_at=utc_now(), started_at=utc_now())
            self._write_job(job)
        try:
            setup = self.status()
            if not setup["ready"]:
                raise GenerationError(" ".join(setup["setup_errors"]))
            provider_request = json.loads((temporary.parent / "request.json").read_text(encoding="utf-8"))
            validate_request(provider_request)
            provider_info = self.client.generate(provider_request, temporary)
            audio = validate_audio(temporary, job["requested_duration_seconds"], self.ffmpeg, self.ffprobe)
            audio.update(provider_info)
            final = temporary.with_name("audio." + audio["extension"])
            temporary.replace(final)
            job.update(
                state="complete", updated_at=utc_now(), completed_at=utc_now(), audio=audio,
                audio_filename=final.name, audio_url=f"{API_PREFIX}/generations/{identifier}/audio",
                export_url=f"{API_PREFIX}/generations/{identifier}/export", error=None,
                generation_latency_seconds=round(time.monotonic() - started, 3),
            )
        except GenerationError as exc:
            job.update(state=exc.state, updated_at=utc_now(), error=self._redact(str(exc)))
        except Exception:
            # An unexpected local failure may happen after POST; never retry it.
            job.update(state="unknown", updated_at=utc_now(), error="Generation stopped after an unexpected local error. The provider outcome may be unknown; no automatic retry was made.")
        finally:
            temporary.unlink(missing_ok=True)
        with self._lock:
            # Publish the validated mix and its next pipeline stage together.
            # Another request must not enter between music and stem generation.
            automatic_stems = job["state"] == "complete" and job.get("separate_stems") is True and not job.get("stem_separation")
            if automatic_stems:
                job["stem_separation"] = self._new_stem_separation(identifier)
            self._write_job(job)
            if automatic_stems:
                self._queue.put(("stems", identifier))

    def _run_stem_job(self, identifier: str) -> None:
        with self._lock:
            job = self._job(identifier)
            separation = job.get("stem_separation")
            if not separation or separation["state"] != "queued":
                return
            separation.update(state="generating", started_at=utc_now(), updated_at=utc_now())
            self._write_job(job)
        directory = self.root / "jobs" / identifier
        archive_path = directory / "stems.zip.tmp"
        temporary = directory / ("stems.tmp-" + uuid.uuid4().hex)
        started = time.monotonic()
        try:
            setup = self.status()
            if not setup["ready"]:
                raise GenerationError(" ".join(setup["setup_errors"]))
            original = self.audio_response(job)
            # The durable job reserves this stage; save the exact source and
            # variation before the single provider submission, also on recovery.
            atomic_json(directory / "stems-request.json", {
                "generation_id": identifier, "stem_variation_id": separation["stem_variation_id"],
                "source_audio_sha256": hashlib.sha256(original.path.read_bytes()).hexdigest(),
            })
            self.client.separate_stems(original.path, archive_path, separation["stem_variation_id"])
            stems = extract_stems(archive_path, temporary, job["audio"]["duration_seconds"],
                                  lambda path, duration: validate_audio(path, duration, self.ffmpeg, self.ffprobe))
            final = directory / "stems"
            # An interrupted separation is never retried automatically; remove
            # no old validated result when installing this unique attempt.
            if final.exists():
                raise GenerationError("A saved stem directory already exists; no files were replaced.")
            temporary.rename(final)
            for stem in stems:
                stem["audio_url"] = f"{API_PREFIX}/generations/{identifier}/stems/{stem['id']}/audio"
            separation.update(state="complete", stems=stems, error=None, updated_at=utc_now(), completed_at=utc_now(),
                              separation_latency_seconds=round(time.monotonic() - started, 3))
        except GenerationError as exc:
            separation.update(state=exc.state, updated_at=utc_now(), error=self._redact(str(exc)))
        except (ValueError, zipfile.BadZipFile, RuntimeError):
            separation.update(state="failed", updated_at=utc_now(), error="The stem archive failed validation. The original track is still available; no automatic retry was made.")
        except Exception:
            separation.update(state="unknown", updated_at=utc_now(), error="Stem separation stopped after an unexpected error. The provider outcome may be unknown; no automatic retry was made.")
        finally:
            archive_path.unlink(missing_ok=True)
            shutil.rmtree(temporary, ignore_errors=True)
        with self._lock:
            # Preserve any concurrent read-side repair of the original audio.
            job = self._job(identifier)
            job["stem_separation"] = separation
            self._write_job(job)

    def _manifest(self, plan: dict[str, Any], job: dict[str, Any] | None) -> dict[str, Any]:
        return {
            "schema_version": 1, "mapping_version": plan["mapping_version"],
            "origin": plan.get("origin", "live_extrapolation" if plan.get("realtime") else "recording"),
            "plan_id": plan["id"], "analysis_id": plan["analysis_id"], "dataset_id": plan["dataset_id"],
            "dataset_name": plan.get("dataset_name"),
            "dataset_hash": plan["dataset_hash"], "cache_key": plan["cache_key"],
            "cache_key_version": plan.get("cache_key_version", CACHE_KEY_VERSION),
            "request_hash": digest(plan["request"]), "model_id": plan["request"]["model_id"],
            "seed": plan["request"].get("seed"), "output_format": "auto", "baseline": plan["baseline"],
            "analysis_settings": plan["analysis_settings"], "mapping_settings": plan["settings"],
            "thresholds": plan["thresholds"], "manual_edits": plan["manual_edits"],
            "requested_duration_seconds": plan["duration_seconds"],
            "measured_duration_seconds": job["audio"]["duration_seconds"] if job else None,
            "plan_created_at": plan["created_at"], "exported_at": utc_now(),
            "generation": job,
            "realtime": plan.get("realtime"),
            "timing_note": plan.get("realtime", {}).get("provenance_note", "Section boundaries and musical properties are requested, not measured; transitions may be gradual."),
        }

    def export(self, plan: dict[str, Any], job: dict[str, Any] | None = None) -> FileResponse:
        identifier = job["id"] if job else plan["id"]
        destination = self.root / "exports" / (identifier + ".zip")
        temporary = destination.with_name(destination.name + ".tmp-" + uuid.uuid4().hex)
        try:
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("request.json", canonical_json(plan["request"]))
                archive.writestr("features.json", canonical_json({
                    "sections": plan["sections"], "baseline": plan["baseline"],
                    "warnings": plan["warnings"], "blocking_reasons": plan["blocking_reasons"],
                    "can_generate": plan["can_generate"], "mapping_version": plan["mapping_version"],
                }))
                archive.writestr("manifest.json", canonical_json(self._manifest(plan, job)))
                if job:
                    audio = self.audio_response(job)
                    archive.write(audio.path, arcname=job["audio_filename"])
                    separation = self.get_stem_job(job["id"])
                    if separation["state"] != "not_requested":
                        archive.writestr("stems/manifest.json", canonical_json(separation))
                    if separation["state"] == "complete":
                        for stem in separation["stems"]:
                            stem_audio = self.resolve_stem_audio(job["id"], stem["id"])
                            archive.write(stem_audio.path, arcname="stems/" + stem["filename"])
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
        return FileResponse(destination, "application/zip", "elevenlabs-" + identifier + ".zip")

    def audio_response(self, job: dict[str, Any]) -> FileResponse:
        self._check_saved_audio(job)
        if job["state"] != "complete":
            raise ServiceError("Audio is available only after successful validation.", 409)
        path = self.root / "jobs" / job["id"] / job["audio_filename"]
        if not path.is_file():
            raise ServiceError("The saved audio file is missing.", 404)
        return FileResponse(path, job["audio"]["content_type"])

    def dispatch(self, method: str, path: str, payload: dict[str, Any] | None = None) -> tuple[int, dict[str, Any] | FileResponse]:
        try:
            parsed = urlsplit(path)
            if not parsed.path.startswith(API_PREFIX + "/"):
                raise ServiceError("Endpoint not found.", 404)
            parts = parsed.path[len(API_PREFIX) + 1:].strip("/").split("/")
            payload = {} if payload is None else payload
            if not isinstance(payload, dict):
                raise ServiceError("The request body must be a JSON object.")
            if method == "GET" and parts == ["status"]:
                return 200, self.status()
            if method == "POST" and len(parts) == 1:
                handlers = {"datasets": self.create_dataset, "analyses": self.create_analysis, "plans": self.create_plan, "generations": self.create_generation, "continuations": self.create_continuation_job}
                if parts[0] in handlers:
                    return (202 if parts[0] in {"generations", "continuations"} else 201), handlers[parts[0]](payload)
            if method == "POST" and len(parts) == 3 and parts[0] == "generations" and parts[2] == "stems":
                return 202, self.create_stem_job(parts[1], payload.get("stem_variation_id", "six_stems_v1"))
            if method == "GET":
                if len(parts) == 3 and parts[0] == "generations" and parts[2] == "stems":
                    return 200, self.get_stem_job(parts[1])
                if len(parts) == 5 and parts[0] == "generations" and parts[2] == "stems" and parts[4] == "audio":
                    return 200, self.resolve_stem_audio(parts[1], parts[3])
                if parts == ["plans"]:
                    return 200, {"plans": self.plans()}
                if parts == ["generations"]:
                    plan_id = parse_qs(parsed.query).get("plan_id", [None])[0]
                    return 200, {"jobs": self.jobs(plan_id)}
                if len(parts) == 2 and parts[0] in {"datasets", "analyses", "plans"}:
                    record = self._read(parts[0], parts[1])
                    return 200, self._dataset_view(record) if parts[0] == "datasets" else record
                if len(parts) == 3 and parts[0] == "plans" and parts[2] == "export":
                    return 200, self.export(self._read("plans", parts[1]))
                if parts[0] == "generations" and len(parts) in {2, 3}:
                    job = self._job(parts[1])
                    if len(parts) == 2:
                        return 200, job
                    if parts[2] == "audio":
                        return 200, self.audio_response(job)
                    if parts[2] == "export":
                        if job["state"] != "complete":
                            raise ServiceError("Audio export requires a successfully completed generation.", 409)
                        return 200, self.export(self._read("plans", job["plan_id"]), job)
            raise ServiceError("Endpoint not found.", 404)
        except ServiceError as exc:
            return exc.status, {"error": self._redact(str(exc))}
        except (ValueError, TypeError, KeyError) as exc:
            return 400, {"error": self._redact(str(exc))}
        except (OSError, sqlite3.Error):
            return 500, {"error": "The local ElevenLabs storage operation failed. Check available disk space and permissions."}

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._queue.put(None)
        if self._worker and self._worker.is_alive():
            self._worker.join(timeout=0.2)
        # A provider request can still be returning on the daemon worker. Leave
        # its connection open until process exit rather than corrupting recovery.
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
