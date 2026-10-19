"""Local, durable study events and portable, self-contained study exports.

Frontend acknowledgements follow SQLite commits. Performance callbacks only
enqueue work; they never wait for disk writes. No network service is used here.
"""
from __future__ import annotations

import base64
import binascii
import copy
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import math
import os
from pathlib import Path
import queue
import re
import shutil
import sqlite3
import threading
import time
from urllib.parse import urlsplit
import uuid
import wave
import zipfile

from elevenlabs_service import FileResponse, ServiceError


API_PREFIX = "/api/study"
SCHEMA_VERSION = 1
MAX_MEDIA_BYTES = 32 * 1024 * 1024
MAX_EVENT_BYTES = 1024 * 1024
MAX_BATCH_BYTES = 4 * 1024 * 1024
MAX_BATCH_EVENTS = 100
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
JOB_ID = re.compile(r"^[0-9a-f]{32}$")
EVENT_TYPE = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,119}$")
NAMESPACES = {"rap-response": ("responses.sqlite3", "responses"),
              "rap": ("renders.sqlite3", "renders"),
              "rap-experiment": ("experiments.sqlite3", "experiments"),
              "elevenlabs": ("jobs.sqlite3", "jobs")}
MEDIA_SUFFIXES = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".pcm", ".webm", ".mp4"}
EVENT_COLUMNS = ["event_id", "device_id", "session_id", "client_id", "sequence", "occurred_at",
                 "received_at", "elapsed_ms", "type", "app_version", "payload_json"]
SESSION_COLUMNS = ["device_id", "session_id", "participant_code", "created_at", "app_version"]
MEDIA_COLUMNS = ["media_id", "device_id", "session_id", "event_id", "created_at", "path", "sha256", "bytes",
                 "content_type", "duration_seconds", "role", "capture_id", "request_id", "outcome", "validation_error", "metadata_json"]
ANALYSIS_COLUMNS = EVENT_COLUMNS + ["payload.workspace", "payload.control", "payload.action", "payload.value",
    "payload.previous", "payload.namespace", "payload.job_id", "payload.path", "payload.status", "payload.reason",
    "payload.request.text", "payload.response.transcript", "payload.response.lyrics", "payload.job.transcript", "payload.job.lyrics"]


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def clean(value, depth=0):
    """Remove secrets and inline binary fields, preserving participant content."""
    if depth > 40:
        raise ServiceError("Study payload nesting exceeds 40 levels.")
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ServiceError("Study payload keys must be strings.")
            normalized = re.sub(r"[^a-z0-9]", "", key.lower())
            if (normalized in {"audiobase64", "authorization", "cookie", "setcookie", "password",
                               "passwd", "secret", "credentials", "accesstoken", "refreshtoken",
                               "sessiontoken", "apikey", "xiapikey"}
                    or normalized.endswith(("apikey", "password", "secret"))):
                continue
            result[key] = clean(item, depth + 1)
        return result
    if isinstance(value, (list, tuple)):
        return [clean(item, depth + 1) for item in value]
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    raise ServiceError("Study payload contains an unsupported value.")


def identifier(value, name="Identifier", optional=False):
    if optional and value is None:
        return None
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise ServiceError(f"{name} must contain 1–100 letters, digits, underscores or hyphens.")
    return value


def uuid_id(value, name):
    try:
        if not isinstance(value, str):
            raise ValueError()
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        raise ServiceError(f"{name} must be a UUID.") from None


def utc_timestamp(value):
    try:
        if not isinstance(value, str) or len(value) > 50:
            raise ValueError()
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (ValueError, OverflowError):
        raise ServiceError("occurred_at must be an ISO timestamp with a timezone.") from None


def csv_text(rows, columns):
    """Explicit JSON payload column retains nested data without lossy flattening."""
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        values = {key: row.get(key, "") for key in columns}
        # Do not execute participant strings when a CSV is opened in Excel.
        for key, value in values.items():
            if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
                values[key] = "'" + value
        writer.writerow(values)
    return output.getvalue()


def event_csv_rows(events):
    for event in events:
        row = {**event, "payload_json": canonical(event.get("payload", {}))}
        for column in ANALYSIS_COLUMNS[len(EVENT_COLUMNS):]:
            value = event
            for key in column.split("."):
                value = value.get(key) if isinstance(value, dict) else None
            row[column] = canonical(value) if isinstance(value, (dict, list)) else value
        yield row


def events_csv(events):
    return csv_text(event_csv_rows(events), ANALYSIS_COLUMNS)


def csv_chunks(rows, columns):
    """Yield one CSV row at a time so multi-day exports have bounded memory."""
    yield csv_text([], columns).encode("utf-8")
    for row in rows:
        # csv_text has exactly one header line with these controlled column names.
        yield csv_text([row], columns).partition("\n")[2].encode("utf-8")


def media_csv_rows(records):
    for item in records:
        metadata = item.get("metadata", {})
        yield {**item, "metadata_json": canonical(metadata),
               **{key: metadata.get(key) for key in ("role", "capture_id", "request_id", "outcome")}}


class StudyRecorder:
    def __init__(self, storage_root, *, app_version="", asset_roots=None):
        self.root = Path(storage_root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        for folder in ("media", "exports"):
            (self.root / folder).mkdir(exist_ok=True, mode=0o700)
        self.app_version = str(app_version)
        self.asset_roots = {name: Path(path).resolve() for name, path in (asset_roots or {}).items()
                            if name in NAMESPACES}
        self._lock = threading.RLock()
        self._context_lock = threading.RLock()
        self._failure_lock = threading.RLock()
        self._closed = False
        self.last_error = None
        self.failed_event_count = 0
        self.incomplete = False
        self._health_saved = None
        self._sequence = 0
        self._started = time.monotonic()
        self._client_id = str(uuid.uuid4())
        self._job_sessions = {}
        self._job_seen = {}
        self._queue = queue.Queue(maxsize=10000)
        self._pending_failures = []
        self._db = sqlite3.connect(str(self.root / "events.sqlite3"), check_same_thread=False, timeout=5)
        self._db.row_factory = sqlite3.Row
        os.chmod(self.root / "events.sqlite3", 0o600)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
                participant_code TEXT, created_at TEXT NOT NULL, app_version TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, session_id TEXT,
                received_at TEXT NOT NULL, type TEXT NOT NULL, event_hash TEXT NOT NULL, body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS events_session ON events(session_id,received_at);
            CREATE TABLE IF NOT EXISTS media (media_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                media_hash TEXT NOT NULL, request_hash TEXT NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS asset_refs (namespace TEXT NOT NULL, job_id TEXT NOT NULL,
                session_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(namespace,job_id,session_id));
            CREATE TABLE IF NOT EXISTS job_origins (namespace TEXT NOT NULL, job_id TEXT NOT NULL,
                origin_session_id TEXT NOT NULL, PRIMARY KEY(namespace,job_id));
        """)
        self._db.execute("INSERT OR IGNORE INTO metadata VALUES ('device_id',?)", (str(uuid.uuid4()),))
        self._db.execute("INSERT OR IGNORE INTO metadata VALUES ('schema_version',?)", (str(SCHEMA_VERSION),))
        self._db.commit()
        self.device_id = self._db.execute("SELECT value FROM metadata WHERE key='device_id'").fetchone()[0]
        previous_health = self._db.execute("SELECT value FROM metadata WHERE key='health'").fetchone()
        if previous_health:
            health = json.loads(previous_health[0])
            self.failed_event_count = health.get("failed_event_count", 0)
            self.incomplete = health.get("incomplete", False)
            self.last_error = health.get("last_error")
        previous_shutdown = self._db.execute("SELECT value FROM metadata WHERE key='clean_shutdown'").fetchone()
        if previous_shutdown and previous_shutdown[0] != "1":
            self.incomplete = True
            self.last_error = "The previous recorder did not close cleanly. Some queued backend events may be missing; browser events can still retry."
        self._db.execute("INSERT OR REPLACE INTO metadata VALUES ('clean_shutdown','0')")
        self._db.commit()
        self._persist_health()
        for row in self._db.execute("SELECT namespace,job_id,origin_session_id FROM job_origins"):
            self._job_sessions[(row["namespace"], row["job_id"])] = row["origin_session_id"]
        self._worker = threading.Thread(target=self._work, name="study-journal", daemon=True)
        self._worker.start()

    def _error(self, message, *, incomplete=False):
        # Fixed messages only: exceptions may include sensitive request contents.
        self.last_error = message
        self.incomplete = self.incomplete or incomplete

    def _health(self):
        return {"last_error": self.last_error, "failed_event_count": self.failed_event_count, "incomplete": self.incomplete}

    def _persist_health(self):
        encoded = canonical(self._health())
        if encoded == self._health_saved:
            return
        with self._lock, self._db:
            self._db.execute("INSERT OR REPLACE INTO metadata VALUES ('health',?)", (encoded,))
        self._health_saved = encoded

    def _recovered(self):
        if not self.incomplete and not self.failed_event_count and not self._pending_failures:
            self.last_error = None

    def status(self):
        self._persist_health()
        with self._lock:
            counts = {name + "_count": self._db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0]
                      for name, table in (("event", "events"), ("session", "sessions"), ("media", "media"))}
        backup = getattr(self, "backup_service", None)
        return {"ready": not self._closed and not self.last_error, "device_id": self.device_id,
                "storage_root": str(self.root), "app_version": self.app_version, "schema_version": SCHEMA_VERSION,
                "last_error": self.last_error, "pending_events": self._queue.qsize() + len(self._pending_failures),
                "failed_event_count": self.failed_event_count, "max_media_bytes": MAX_MEDIA_BYTES,
                "incomplete": self.incomplete, "free_disk_bytes": shutil.disk_usage(self.root).free,
                "backup": backup.status() if backup is not None else {"enabled": False}, **counts}

    def _session(self, session_id, participant_code=None, explicit=False):
        existing = self._db.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()
        if existing:
            if explicit and existing["participant_code"] not in (None, participant_code):
                raise ServiceError("This session already has a different participant code. Start a new session.", 409)
            if explicit and participant_code is not None and existing["participant_code"] is None:
                self._db.execute("UPDATE sessions SET participant_code=? WHERE session_id=?", (participant_code, session_id))
            return
        self._db.execute("INSERT INTO sessions VALUES (?,?,?,?,?)",
                         (session_id, self.device_id, participant_code, now(), self.app_version))

    def create_session(self, document):
        if set(document) - {"session_id", "participant_code"}:
            raise ServiceError("Unsupported session fields.")
        session_id = identifier(document.get("session_id"), "Session ID")
        code = document.get("participant_code")
        if code == "":
            code = None
        if code is not None and (not isinstance(code, str) or len(code) > 100 or any(ord(c) < 32 for c in code)):
            raise ServiceError("Participant code must be at most 100 printable characters.")
        with self._lock, self._db:
            self._session(session_id, code, explicit=True)
            result = dict(self._db.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone())
        return {**result, "session": result}

    def _normalize_event(self, value, *, backend=False):
        if not isinstance(value, dict) or set(value) - {"event_id", "session_id", "client_id", "sequence", "occurred_at", "elapsed_ms", "type", "payload"}:
            raise ServiceError("A study event has unsupported fields.")
        event_id = uuid_id(value.get("event_id"), "Event ID")
        session_id = identifier(value.get("session_id"), "Session ID", optional=backend)
        client_id = identifier(value.get("client_id"), "Client ID")
        sequence = value.get("sequence")
        if isinstance(sequence, bool) or not isinstance(sequence, int) or not 0 <= sequence <= 9007199254740991:
            raise ServiceError("Event sequence must be a non-negative safe integer.")
        elapsed = value.get("elapsed_ms")
        if elapsed is not None and (isinstance(elapsed, bool) or not isinstance(elapsed, (int, float)) or not math.isfinite(elapsed) or elapsed < 0):
            raise ServiceError("elapsed_ms must be a non-negative finite number.")
        kind = value.get("type")
        if not isinstance(kind, str) or not EVENT_TYPE.fullmatch(kind):
            raise ServiceError("Invalid study event type.")
        payload = value.get("payload", {})
        if not isinstance(payload, dict):
            raise ServiceError("Event payload must be an object.")
        payload = clean(payload)
        if len(canonical(payload).encode("utf-8")) > MAX_EVENT_BYTES:
            raise ServiceError("A study event exceeds the 1 MiB payload limit; split the snapshot.", 413)
        return {"event_id": event_id, "session_id": session_id, "client_id": client_id,
                "sequence": sequence, "occurred_at": utc_timestamp(value.get("occurred_at")),
                "elapsed_ms": elapsed, "type": kind, "payload": payload}

    def _insert_events(self, events):
        with self._lock, self._db:
            for event in events:
                event_hash = sha256(canonical(event).encode("utf-8"))
                existing = self._db.execute("SELECT event_hash FROM events WHERE event_id=?", (event["event_id"],)).fetchone()
                if existing:
                    if existing[0] != event_hash:
                        raise ServiceError("An event ID was reused with different content.", 409)
                    continue
                if event["session_id"]:
                    self._session(event["session_id"])
                stored = {**event, "device_id": self.device_id, "received_at": now(), "app_version": self.app_version}
                self._db.execute("INSERT INTO events VALUES (?,?,?,?,?,?)", (event["event_id"], event["session_id"],
                                 stored["received_at"], event["type"], event_hash, canonical(stored)))
                payload = event["payload"]
                namespace, job_id = payload.get("namespace"), payload.get("job_id")
                if namespace in NAMESPACES and isinstance(job_id, str) and JOB_ID.fullmatch(job_id):
                    self._db.execute("INSERT OR IGNORE INTO asset_refs VALUES (?,?,?)", (namespace, job_id, event["session_id"] or ""))

    def add_events(self, document):
        if set(document) != {"events"} or not isinstance(document.get("events"), list) or not 1 <= len(document["events"]) <= MAX_BATCH_EVENTS:
            raise ServiceError("Send a batch containing 1–100 study events.")
        if len(canonical(document).encode("utf-8")) > MAX_BATCH_BYTES:
            raise ServiceError("Study event batch exceeds 4 MiB.", 413)
        events = [self._normalize_event(value) for value in document["events"]]
        self._insert_events(events)
        return {"acknowledged_event_ids": [event["event_id"] for event in events], "device_id": self.device_id}

    def record(self, type, payload, *, session_id=None):
        """Best-effort non-blocking hook; health reports any unsuccessful enqueue."""
        try:
            if self._closed:
                raise RuntimeError("closed")
            with self._context_lock:
                self._sequence += 1
                sequence = self._sequence
            event = self._normalize_event({"event_id": str(uuid.uuid4()), "session_id": session_id,
                "client_id": self._client_id, "sequence": sequence, "occurred_at": now(),
                "elapsed_ms": round((time.monotonic() - self._started) * 1000, 3),
                "type": type, "payload": payload}, backend=True)
            self._queue.put_nowait(event)
            return event["event_id"]
        except Exception:
            self.failed_event_count += 1
            self._error("A backend study event could not be queued. Recording is incomplete; check storage and export before closing.", incomplete=True)
            return None

    def _work(self):
        while True:
            batch = [self._queue.get()]
            if batch[0] is not None:
                for _ in range(99):
                    try:
                        item = self._queue.get_nowait()
                        batch.append(item)
                        if item is None:
                            break
                    except queue.Empty:
                        break
            events = [event for event in batch if event is not None]
            try:
                if not events:
                    return
                try:
                    # Resolve only explicitly known job context, never a guessed active participant.
                    for event in events:
                        payload = event["payload"]
                        if event["session_id"] is None and payload.get("namespace") in NAMESPACES and payload.get("job_id"):
                            with self._context_lock:
                                event["session_id"] = self._job_sessions.get((payload["namespace"], payload["job_id"]))
                    with self._failure_lock:
                        self._insert_events(self._pending_failures + events)
                        self._pending_failures.clear()
                        self._recovered()
                    self._persist_health()
                except Exception:
                    with self._failure_lock:
                        self._pending_failures.extend(events)
                    self._error("Study events could not be written to disk. Pending events are held in memory; check disk space and permissions.")
            finally:
                for _ in batch:
                    self._queue.task_done()
            if batch[-1] is None:
                return

    def flush(self, timeout=10):
        deadline = time.monotonic() + timeout
        while self._queue.unfinished_tasks:
            if time.monotonic() >= deadline:
                self._error("Study recording is still writing. Retry the export when the queue has drained.")
                raise ServiceError(self.last_error, 503)
            time.sleep(.01)
        with self._failure_lock:
            if self._pending_failures:
                try:
                    self._insert_events(self._pending_failures)
                    self._pending_failures.clear()
                    self._recovered()
                except Exception:
                    self._error("Pending study events could not be saved. Check disk space and permissions before closing.")
                    raise ServiceError(self.last_error, 503) from None
        self._persist_health()

    def record_job(self, namespace, job):
        try:
            if namespace not in NAMESPACES or not isinstance(job, dict) or not JOB_ID.fullmatch(str(job.get("id", ""))):
                return
            payload = {"namespace": namespace, "job_id": job["id"], "job": clean(job)}
            fingerprint = sha256(canonical(payload).encode("utf-8"))
            key = (namespace, job["id"])
            with self._context_lock:
                if self._job_seen.get(key) == fingerprint:
                    return
                session_id = self._job_sessions.get(key)
            if self.record("generation.updated", payload, session_id=session_id):
                with self._context_lock:
                    self._job_seen[key] = fingerprint
        except Exception:
            self.failed_event_count += 1
            self._error("A generation update could not be recorded.", incomplete=True)

    def observe_http(self, method, path, document, status, body, session_id=None):
        try:
            path = urlsplit(path).path
            parts = path.strip("/").split("/")
            if len(parts) < 3 or parts[:2] == ["api", "study"]:
                return
            namespace = parts[1]
            job_id = body.get("id") if isinstance(body, dict) else None
            if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
                job_id = next((part for part in parts[3:] if JOB_ID.fullmatch(part)), None)
            if namespace in NAMESPACES and job_id:
                creation_routes = {"rap-response": {"responses"}, "rap": {"renders"},
                                   "rap-experiment": {"experiments"}, "elevenlabs": {"generations", "continuations"}}
                creates_job = len(parts) == 3 and parts[2] in creation_routes[namespace]
                # Applying local effects creates a new recording with its own
                # participant origin, while retaining the source response ID.
                creates_job |= (namespace == "rap-response" and len(parts) == 5
                                and parts[2] == "responses" and parts[4] == "effects"
                                and job_id != parts[3] and isinstance(body, dict)
                                and body.get("source_response_id") == parts[3])
                if session_id and method == "POST" and 200 <= status < 300 and creates_job:
                    origin = identifier(session_id, "Session ID")
                    # A replay/viewer is not the creator. This separate binding
                    # remains immutable even when several sessions use one asset.
                    with self._lock, self._db:
                        self._db.execute("INSERT OR IGNORE INTO job_origins VALUES (?,?,?)", (namespace, job_id, origin))
                        origin = self._db.execute("SELECT origin_session_id FROM job_origins WHERE namespace=? AND job_id=?", (namespace, job_id)).fetchone()[0]
                    with self._context_lock:
                        self._job_sessions[(namespace, job_id)] = origin
                if isinstance(body, dict) and "state" in body:
                    self.record_job(namespace, body)
            is_file = isinstance(body, FileResponse)
            if method != "POST" and not is_file:
                return
            payload = {"method": method, "path": path, "status": status}
            if namespace in NAMESPACES and job_id:
                payload.update(namespace=namespace, job_id=job_id)
            if document is not None:
                payload["request"] = clean(document)
            if isinstance(body, dict):
                payload["response"] = clean(body)
            elif is_file:
                payload["content_type"] = body.content_type
            self.record("service.file_requested" if is_file else "service.request_completed", payload, session_id=session_id)
            # Raw submitted WAVs are already retained by the rap service and copied
            # via asset_refs on export. Capture failures before a job exists too.
            if method == "POST" and namespace == "rap-response" and isinstance(document, dict) and document.get("audio_base64") and not job_id and session_id:
                self.save_media({"media_id": str(uuid.uuid4()), "session_id": session_id,
                    "audio_base64": document["audio_base64"], "metadata": {"mime_type": "audio/wav", "kind": "failed_submission"}})
        except Exception:
            self.failed_event_count += 1
            self._error("A service interaction could not be recorded completely. Check study recording status.", incomplete=True)

    def _validate_media(self, data, metadata):
        mime = metadata.get("mime_type") or metadata.get("content_type") or "audio/wav"
        if not isinstance(mime, str):
            raise ServiceError("Invalid recording content type.")
        mime = mime.split(";", 1)[0].strip().lower()
        if mime in {"audio/wav", "audio/wave", "audio/x-wav"}:
            try:
                if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
                    raise ValueError()
                with wave.open(io.BytesIO(data), "rb") as audio:
                    frames, rate, channels, width = audio.getnframes(), audio.getframerate(), audio.getnchannels(), audio.getsampwidth()
                    if channels not in {1, 2} or width not in {1, 2, 3, 4} or not 8000 <= rate <= 192000 or frames < 1 or audio.getcomptype() != "NONE":
                        raise ValueError()
                    if len(audio.readframes(frames)) != frames * channels * width:
                        raise ValueError()
                return ".wav", "audio/wav", {"duration_seconds": frames / rate, "sample_rate": rate, "channels": channels}
            except (wave.Error, EOFError, ValueError):
                raise ServiceError("The microphone WAV is invalid or incomplete.") from None
        if mime in {"audio/webm", "video/webm"} and data.startswith(b"\x1aE\xdf\xa3") and b"webm" in data[:4096]:
            return ".webm", "audio/webm", {}
        if mime in {"audio/ogg", "application/ogg"} and data.startswith(b"OggS") and (b"OpusHead" in data[:4096] or b"vorbis" in data[:4096]):
            return ".ogg", "audio/ogg", {}
        if mime in {"audio/mp4", "audio/m4a", "audio/x-m4a", "video/mp4"} and len(data) >= 24 and data[4:8] == b"ftyp" and any(marker in data for marker in (b"moov", b"moof")):
            return ".m4a", "audio/mp4", {}
        raise ServiceError("Unsupported or invalid microphone recording. Use WAV, WebM, Ogg or MP4 audio.")

    def save_media(self, document):
        if set(document) - {"media_id", "session_id", "event_id", "audio_base64", "metadata"}:
            raise ServiceError("Unsupported recording fields.")
        media_id = uuid_id(document.get("media_id"), "Media ID")
        session_id = identifier(document.get("session_id"), "Session ID")
        event_id = uuid_id(document["event_id"], "Event ID") if document.get("event_id") else None
        metadata = document.get("metadata", {})
        if not isinstance(metadata, dict):
            raise ServiceError("Media metadata must be an object.")
        metadata = clean(metadata)
        if len(canonical(metadata).encode("utf-8")) > 65536:
            raise ServiceError("Media metadata exceeds 64 KiB.", 413)
        encoded = document.get("audio_base64")
        if not isinstance(encoded, str) or not encoded or len(encoded) > ((MAX_MEDIA_BYTES + 2) // 3) * 4:
            raise ServiceError("Microphone recording exceeds the 32 MiB limit or is empty.", 413)
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise ServiceError("Microphone recording must be valid base64.") from None
        if not 1 <= len(data) <= MAX_MEDIA_BYTES:
            raise ServiceError("Microphone recording exceeds the 32 MiB limit or is empty.", 413)
        try:
            suffix, mime, measured = self._validate_media(data, metadata)
        except ServiceError as exc:
            declared = metadata.get("mime_type") or metadata.get("content_type") or ""
            declared = declared.split(";", 1)[0].strip().lower() if isinstance(declared, str) else ""
            if metadata.get("role") != "microphone_original" or declared not in {
                "audio/wav", "audio/wave", "audio/x-wav", "audio/webm", "video/webm", "audio/ogg",
                "application/ogg", "audio/mp4", "audio/m4a", "audio/x-m4a", "video/mp4"
            }:
                raise
            # Interrupted browser captures are evidence too. Preserve their exact
            # bytes without presenting an invalid container as playable audio.
            suffix, mime = ".bin", "application/octet-stream"
            measured = {"validation_error": str(exc), "declared_content_type": declared, "playable": False}
        media_hash = sha256(data)
        request_hash = sha256(canonical({"session_id": session_id, "event_id": event_id, "metadata": metadata, "sha256": media_hash}).encode("utf-8"))
        relative = "media/" + media_id + suffix
        with self._lock:
            existing = self._db.execute("SELECT request_hash FROM media WHERE media_id=?", (media_id,)).fetchone()
            if existing:
                if existing[0] != request_hash:
                    raise ServiceError("A media ID was reused with different content.", 409)
                return {"acknowledged_media_id": media_id, "sha256": media_hash}
            destination = self.root / relative
            temporary = destination.with_name(destination.name + ".tmp-" + uuid.uuid4().hex)
            try:
                with temporary.open("xb") as output:
                    os.chmod(temporary, 0o600)
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                temporary.replace(destination)
                directory_fd = os.open(destination.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
                body = {"media_id": media_id, "device_id": self.device_id, "session_id": session_id,
                    "event_id": event_id, "path": relative, "sha256": media_hash, "bytes": len(data),
                    "content_type": mime, "created_at": now(), "metadata": metadata, **measured}
                with self._db:
                    self._session(session_id)
                    self._db.execute("INSERT INTO media VALUES (?,?,?,?,?)", (media_id, session_id, media_hash, request_hash, canonical(body)))
            finally:
                temporary.unlink(missing_ok=True)
        return {"acknowledged_media_id": media_id, "sha256": media_hash}

    def _asset_files(self, namespace, job_id):
        root = self.asset_roots.get(namespace)
        if root is None or not JOB_ID.fullmatch(job_id):
            return []
        if namespace == "rap":
            candidates = [root / (job_id + suffix) for suffix in (".wav", ".source.pcm")]
        else:
            directory = root / "jobs" / job_id if namespace == "elevenlabs" else root / job_id
            if not directory.is_dir() or directory.is_symlink() or not directory.resolve().is_relative_to(root):
                return []
            candidates = list(directory.rglob("*"))
        return [path for path in candidates if path.is_file() and not path.is_symlink()
                and path.suffix.lower() in MEDIA_SUFFIXES and path.resolve().is_relative_to(root)
                and not any((root / parent).is_symlink() for parent in path.relative_to(root).parents if parent != Path("."))]

    def _job_snapshot(self, namespace, job_id):
        root = self.asset_roots.get(namespace)
        if root is None:
            return None
        filename, table = NAMESPACES[namespace]
        database = root / filename
        if not database.is_file() or database.is_symlink():
            return None
        try:
            with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2) as connection:
                row = connection.execute("SELECT body FROM " + table + " WHERE id=?", (job_id,)).fetchone()
                return clean(json.loads(row[0])) if row else None
        except (sqlite3.Error, ValueError, ServiceError):
            return None

    def export(self):
        self.flush()
        identifier = uuid.uuid4().hex
        destination = self.root / "exports" / ("study-" + self.device_id + "-" + identifier + ".zip")
        temporary = destination.with_suffix(".tmp")
        snapshot_path = destination.with_suffix(".snapshot.sqlite3")
        snapshot = sqlite3.connect(snapshot_path)
        snapshot.row_factory = sqlite3.Row
        os.chmod(snapshot_path, 0o600)
        try:
            with self._lock:
                self._db.backup(snapshot)
        except Exception:
            snapshot.close()
            snapshot_path.unlink(missing_ok=True)
            raise
        events = lambda: (json.loads(row[0]) for row in snapshot.execute("SELECT body FROM events ORDER BY received_at,rowid"))
        sessions = lambda: (dict(row) for row in snapshot.execute("SELECT * FROM sessions ORDER BY created_at,session_id"))
        media = lambda: (json.loads(row[0]) for row in snapshot.execute("SELECT body FROM media ORDER BY rowid"))
        references = [dict(row) for row in snapshot.execute("SELECT * FROM asset_refs ORDER BY namespace,job_id,session_id")]
        origins = [dict(row) for row in snapshot.execute("SELECT * FROM job_origins ORDER BY namespace,job_id")]
        manifest = {"format": "hydra-study", "schema_version": SCHEMA_VERSION, "export_id": identifier,
            "device_id": self.device_id, "app_version": self.app_version, "exported_at": now(),
            "event_count": snapshot.execute("SELECT COUNT(*) FROM events").fetchone()[0],
            "session_count": snapshot.execute("SELECT COUNT(*) FROM sessions").fetchone()[0],
            "media": [], "asset_refs": references, "job_origins": origins,
            "files": [], "missing_assets": [], "recording_error": self.last_error,
            "failed_event_count": self.failed_event_count, "incomplete": self.incomplete,
            "csv_note": "Nested payload is preserved in payload_json. Spreadsheet formula prefixes are escaped in CSV; JSONL is exact."}
        try:
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                os.chmod(temporary, 0o600)
                def add_bytes(name, content):
                    data = content.encode("utf-8") if isinstance(content, str) else content
                    archive.writestr(name, data)
                    manifest["files"].append({"path": name, "bytes": len(data), "sha256": sha256(data)})

                def add_chunks(name, chunks):
                    hasher, size = hashlib.sha256(), 0
                    with archive.open(name, "w", force_zip64=True) as target:
                        for chunk in chunks:
                            target.write(chunk)
                            hasher.update(chunk)
                            size += len(chunk)
                    manifest["files"].append({"path": name, "bytes": size, "sha256": hasher.hexdigest()})

                def add_file(name, path):
                    hasher, size = hashlib.sha256(), 0
                    with path.open("rb") as source, archive.open(name, "w", force_zip64=True) as target:
                        while block := source.read(1024 * 1024):
                            target.write(block)
                            hasher.update(block)
                            size += len(block)
                    manifest["files"].append({"path": name, "bytes": size, "sha256": hasher.hexdigest()})
                    return hasher.hexdigest()

                add_chunks("events.jsonl", ((canonical(event) + "\n").encode("utf-8") for event in events()))
                add_chunks("events.csv", csv_chunks(event_csv_rows(events()), ANALYSIS_COLUMNS))
                add_chunks("sessions.jsonl", ((canonical(session) + "\n").encode("utf-8") for session in sessions()))
                add_chunks("sessions.csv", csv_chunks(sessions(), SESSION_COLUMNS))
                add_chunks("media.jsonl", ((canonical(item) + "\n").encode("utf-8") for item in media()))
                add_chunks("media.csv", csv_chunks(media_csv_rows(media()), MEDIA_COLUMNS))
                for item in media():
                    path = self.root / item["path"]
                    if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(self.root / "media"):
                        manifest["missing_assets"].append({"media_id": item["media_id"], "reason": "Recording is missing or unsafe."})
                        continue
                    if add_file(item["path"], path) != item["sha256"]:
                        raise ServiceError("A saved recording changed unexpectedly; export cancelled.", 409)
                    manifest["media"].append(item)
                seen = set()
                for ref in references:
                    namespace, job_id = ref["namespace"], ref["job_id"]
                    if (namespace, job_id) in seen:
                        continue
                    seen.add((namespace, job_id))
                    prefix = f"assets/{namespace}/{job_id}/"
                    job_snapshot = self._job_snapshot(namespace, job_id)
                    if job_snapshot is not None:
                        add_bytes(prefix + "job.json", canonical(job_snapshot))
                    files = self._asset_files(namespace, job_id)
                    if not files:
                        manifest["missing_assets"].append({**ref, "reason": "No completed audio is available at export time."})
                    for path in files:
                        root = self.asset_roots[namespace]
                        directory = root / "jobs" / job_id if namespace == "elevenlabs" else root / job_id
                        relative = path.name if namespace == "rap" else path.relative_to(directory).as_posix()
                        add_file(prefix + relative, path)
                archive.writestr("manifest.json", canonical(manifest))
            temporary.replace(destination)
        finally:
            snapshot.close()
            snapshot_path.unlink(missing_ok=True)
            temporary.unlink(missing_ok=True)
        return FileResponse(destination, "application/zip", destination.name)

    def export_incremental(self, destination_directory, checkpoint):
        """Publish one immutable incremental bundle without changing recording health.

        The caller persists the returned checkpoint only after this method succeeds.
        Retrying with an older checkpoint merely repeats UUID-deduplicated records.
        """
        # A busy stream must not indefinitely delay backup or change recorder health.
        deadline = time.monotonic() + 1
        while self._queue.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(.01)
        destination_directory = Path(destination_directory)
        destination_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        export_id = uuid.uuid4().hex
        destination = destination_directory / ("study-" + self.device_id + "-" + export_id + ".zip")
        temporary = destination.with_suffix(".tmp")
        snapshot_path = self.root / "exports" / (".backup-" + export_id + ".sqlite3")
        snapshot = sqlite3.connect(snapshot_path)
        snapshot.row_factory = sqlite3.Row
        os.chmod(snapshot_path, 0o600)
        try:
            with self._lock:
                self._db.backup(snapshot)
            event_cursor = int(checkpoint.get("event_rowid", 0))
            media_cursor = int(checkpoint.get("media_rowid", 0))
            event_max = snapshot.execute("SELECT COALESCE(MAX(rowid),0) FROM events").fetchone()[0]
            media_max = snapshot.execute("SELECT COALESCE(MAX(rowid),0) FROM media").fetchone()[0]
            if event_cursor > event_max or media_cursor > media_max:
                # A journal restored from an older copy must rebuild its backup.
                checkpoint, event_cursor, media_cursor = {}, 0, 0
            next_checkpoint = copy.deepcopy(checkpoint)
            fingerprints = next_checkpoint.setdefault("files", {})
            events = lambda: (json.loads(row[0]) for row in snapshot.execute(
                "SELECT body FROM events WHERE rowid>? ORDER BY received_at,rowid", (event_cursor,)))
            event_count = snapshot.execute("SELECT COUNT(*) FROM events WHERE rowid>?", (event_cursor,)).fetchone()[0]
            sessions = [dict(row) for row in snapshot.execute("SELECT * FROM sessions ORDER BY created_at,session_id")]
            references = [dict(row) for row in snapshot.execute("SELECT * FROM asset_refs ORDER BY namespace,job_id,session_id")]
            origins = [dict(row) for row in snapshot.execute("SELECT * FROM job_origins ORDER BY namespace,job_id")]
            metadata_hash = sha256(canonical({"sessions": sessions, "references": references, "origins": origins}).encode())
            files, documents, media_records, missing = [], [], [], []

            def fingerprint(path):
                info = path.stat()
                return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]

            def include_file(name, path, expected_hash=None):
                signature = fingerprint(path)
                if fingerprints.get(name, {}).get("stat") == signature:
                    return False
                files.append((name, path, signature, expected_hash))
                return True

            for row in snapshot.execute("SELECT rowid,body FROM media ORDER BY rowid"):
                item = json.loads(row["body"])
                path = self.root / item["path"]
                available = (path.is_file() and not path.is_symlink()
                             and path.resolve().is_relative_to(self.root / "media"))
                copied = include_file(item["path"], path, item["sha256"]) if available else False
                # Repeat metadata when previously missing bytes finally arrive. This
                # also makes collection safe when ZIPs are merged out of order.
                if row["rowid"] > media_cursor or copied:
                    media_records.append(item)
                    if not available:
                        missing.append({"media_id": item["media_id"], "reason": "Recording is missing or unsafe."})

            seen = set()
            for ref in references:
                namespace, job_id = ref["namespace"], ref["job_id"]
                if (namespace, job_id) in seen:
                    continue
                seen.add((namespace, job_id))
                prefix = f"assets/{namespace}/{job_id}/"
                job = self._job_snapshot(namespace, job_id)
                if job is not None:
                    data = canonical(job).encode("utf-8")
                    digest = sha256(data)
                    if fingerprints.get(prefix + "job.json", {}).get("sha256") != digest:
                        documents.append((prefix + "job.json", data))
                assets = self._asset_files(namespace, job_id)
                if not assets:
                    missing.append({**ref, "reason": "No completed audio is available at backup time."})
                for path in assets:
                    root = self.asset_roots[namespace]
                    directory = root / "jobs" / job_id if namespace == "elevenlabs" else root / job_id
                    relative = path.name if namespace == "rap" else path.relative_to(directory).as_posix()
                    include_file(prefix + relative, path)

            next_checkpoint.update(event_rowid=event_max, media_rowid=media_max, metadata_hash=metadata_hash)
            if not (event_count or media_records or files or documents
                    or metadata_hash != checkpoint.get("metadata_hash")):
                return None, next_checkpoint
            manifest = {"format": "hydra-study", "schema_version": SCHEMA_VERSION, "export_id": export_id,
                "device_id": self.device_id, "app_version": self.app_version, "exported_at": now(),
                "incremental": True, "event_count": event_count, "session_count": len(sessions),
                "media": media_records, "asset_refs": references, "job_origins": origins,
                "files": [], "missing_assets": missing, "recording_error": self.last_error,
                "failed_event_count": self.failed_event_count, "incomplete": self.incomplete,
                "csv_note": "Merge every backup ZIP. Nested payload is exact in JSONL; CSV formula prefixes are escaped."}
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                os.chmod(temporary, 0o600)

                def add_chunks(name, chunks):
                    hasher, size = hashlib.sha256(), 0
                    with archive.open(name, "w", force_zip64=True) as target:
                        for chunk in chunks:
                            target.write(chunk)
                            hasher.update(chunk)
                            size += len(chunk)
                    digest = hasher.hexdigest()
                    manifest["files"].append({"path": name, "bytes": size, "sha256": digest})
                    return digest

                add_chunks("events.jsonl", ((canonical(event) + "\n").encode("utf-8") for event in events()))
                add_chunks("events.csv", csv_chunks(event_csv_rows(events()), ANALYSIS_COLUMNS))
                add_chunks("sessions.jsonl", ((canonical(item) + "\n").encode("utf-8") for item in sessions))
                add_chunks("sessions.csv", csv_chunks(sessions, SESSION_COLUMNS))
                add_chunks("media.jsonl", ((canonical(item) + "\n").encode("utf-8") for item in media_records))
                add_chunks("media.csv", csv_chunks(media_csv_rows(media_records), MEDIA_COLUMNS))
                for name, data in documents:
                    fingerprints[name] = {"sha256": add_chunks(name, [data])}
                for name, path, signature, expected_hash in files:
                    with path.open("rb") as source:
                        digest = add_chunks(name, iter(lambda: source.read(1024 * 1024), b""))
                    if signature != fingerprint(path):
                        raise ServiceError("An audio file is still changing; the backup will retry.", 409)
                    if expected_hash and digest != expected_hash:
                        raise ServiceError("A saved recording changed unexpectedly; backup cancelled.", 409)
                    fingerprints[name] = {"stat": signature, "sha256": digest}
                archive.writestr("manifest.json", canonical(manifest))
            with temporary.open("rb") as completed:
                os.fsync(completed.fileno())
            temporary.replace(destination)
            directory_fd = os.open(destination_directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            return FileResponse(destination, "application/zip", destination.name), next_checkpoint
        finally:
            snapshot.close()
            snapshot_path.unlink(missing_ok=True)
            temporary.unlink(missing_ok=True)

    def dispatch(self, method, raw_path, document=None):
        try:
            path = urlsplit(raw_path).path
            if self._closed:
                raise ServiceError("Study recorder is closed.", 503)
            if method == "GET" and path == API_PREFIX + "/status":
                return 200, self.status()
            if method == "GET" and path == API_PREFIX + "/export":
                return 200, self.export()
            if method != "POST" or not isinstance(document, dict):
                raise ServiceError("Study endpoint not found.", 404)
            routes = {"/events": self.add_events, "/sessions": self.create_session, "/media": self.save_media}
            handler = routes.get(path[len(API_PREFIX):]) if path.startswith(API_PREFIX + "/") else None
            if handler is None:
                raise ServiceError("Study endpoint not found.", 404)
            result = handler(document)
            self._recovered()
            self._persist_health()
            return 200, result
        except ServiceError as exc:
            return exc.status, {"error": str(exc)}
        except (OSError, sqlite3.Error):
            self._error("Study storage could not be written. Check disk space and permissions; unsent browser data will retry.")
            return 503, {"error": self.last_error}
        except (ValueError, TypeError, RecursionError):
            return 400, {"error": "Invalid study recording data."}

    def close(self):
        if self._closed:
            return
        try:
            self.flush()
        except ServiceError:
            # Preserve the explicit incomplete-recording status on shutdown.
            pass
        self._closed = True
        self._queue.put(None)
        self._worker.join(timeout=10)
        if not self._worker.is_alive():
            with self._lock:
                try:
                    if self._pending_failures:
                        self.failed_event_count += len(self._pending_failures)
                        self._error("The recorder closed with unsaved backend events. Recording is incomplete.", incomplete=True)
                    self._persist_health()
                    self._db.execute("INSERT OR REPLACE INTO metadata VALUES ('clean_shutdown','1')")
                    self._db.commit()
                except sqlite3.Error:
                    pass
                self._db.close()
