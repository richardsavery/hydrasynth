"""Portable, immutable copies of generated session audio. Never submits generation."""
from __future__ import annotations

import copy
from contextlib import ExitStack
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import tempfile
import threading
import uuid
import zipfile

from elevenlabs_service import FileResponse, ServiceError, canonical_json, plan_cache_key, validate_uploaded_plan
from beat_tracking import validate_beat_analysis
from elevenlabs_analysis import validate_request

MAX_ZIP = 1024 * 1024 * 1024
MAX_EXPANDED = 1024 * 1024 * 1024
MAX_JSON = 4 * 1024 * 1024
MAX_FILES = 4000
IDENTIFIER = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
BUNDLE_ID = re.compile(r"^[a-f0-9]{32}$")
MEDIA = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}
MIME_TYPES = {"audio/wav", "audio/mpeg", "audio/flac", "audio/ogg", "audio/mp4", "audio/aac", "audio/x-wav"}
KINDS = {"elevenlabs", "rap-response", "rap-experiment", "rap"}
TABLES = {"rap-response": "responses", "rap-experiment": "experiments", "rap": "renders"}


def clean_path(value):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise ServiceError("The session archive contains an unsafe filename.")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in value.split("/")) or ":" in value:
        raise ServiceError("The session archive contains an unsafe filename.")
    return value


def safe_file(root, relative):
    clean_path(relative)
    root = Path(root).resolve()
    path = root / relative
    if any(item.is_symlink() for item in [path, *path.parents] if item != root and item.is_relative_to(root)):
        raise ServiceError("Session audio cannot use symbolic links.")
    if not path.resolve().is_relative_to(root):
        raise ServiceError("Session audio is outside its storage directory.")
    return path


def hash_file(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def read_json(path):
    if path.stat().st_size > MAX_JSON:
        raise ServiceError("Session metadata is too large.")
    return json.loads(path.read_text("utf-8"))


def label(job, kind):
    settings = job.get("generation_settings") or job.get("realtime", {}).get("generation_settings") or {}
    text = job.get("name") or settings.get("style") or job.get("lyrics") or job.get("text")
    text = " ".join(str(text or {"elevenlabs": "Generated music", "rap-response": "Rap response", "rap-experiment": "Rap comparison", "rap": "Rendered rap"}[kind]).split())
    details = []
    bpm = settings.get("bpm") or job.get("bpm")
    if isinstance(bpm, (int, float)) and 0 < bpm < 1000:
        details.append(f"{bpm:g} BPM")
    key = settings.get("key")
    if isinstance(key, str) and key.strip():
        details.append(" ".join(key.split())[:18])
    details.append(str(job["id"])[-6:])
    suffix = " · " + " · ".join(details)
    return text[:80 - len(suffix)].rstrip() + suffix


def references(storage):
    if not isinstance(storage, dict):
        raise ServiceError("Session settings must be an object.")
    found = set()
    def add(kind, value):
        if value in (None, ""):
            return
        if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
            raise ServiceError("The session contains an invalid generated audio identifier.")
        found.add((kind, value))
    def settings(key):
        raw = storage.get(key, "{}")
        if not isinstance(raw, str):
            raise ServiceError("Session settings must contain JSON text.")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ServiceError("Session settings must contain objects.")
        return value
    mixer = settings("hydra.music-mixer.demo.v1")
    add("elevenlabs", mixer.get("trackId"))
    add("elevenlabs", (mixer.get("prompt") or {}).get("next_track_id"))
    add("elevenlabs", settings("hydra.elevenlabs.workspace.v1").get("jobId"))
    add("elevenlabs", settings("hydra.elevenlabs.realtime.v1").get("starterId"))
    response = settings("hydra.rap-response.v1")
    add("rap-response", response.get("response_id") or response.get("responseId"))
    add("rap-experiment", settings("hydra-rap-experiment-v1").get("experiment_id"))
    def rap_refs(rap, depth=0):
        if not isinstance(rap, dict) or depth > 4:
            return
        add("rap-experiment", rap.get("experiment_id") or rap.get("experimentId"))
        add("rap-response", rap.get("response_id") or rap.get("responseId"))
        add("rap", rap.get("render_id"))
        rap_refs(rap.get("legacy_rap"), depth + 1)
    rap_refs(mixer.get("rap"))
    rap_refs(settings("hydra.synth-mixer.v1").get("rap"))
    return sorted(found)


class SessionAssets:
    def __init__(self, root, *, elevenlabs=None, rap_response=None, rap_experiment=None, rap=None):
        self.root = Path(root)
        self.services = {"elevenlabs": elevenlabs, "rap-response": rap_response, "rap-experiment": rap_experiment, "rap": rap}
        self._lock = threading.RLock()

    def _root(self):
        self.root.mkdir(parents=True, exist_ok=True)

    def _media_paths(self, kind, job):
        """Allow only named generated outputs, never microphone or arbitrary job files."""
        identifier = job["id"]
        if kind == "rap":
            return [identifier + ".wav"]
        if kind == "elevenlabs":
            names = [job.get("audio_filename")]
            separation = job.get("stem_separation") or {}
            if separation.get("state") in {"queued", "generating"}:
                raise ServiceError("Wait for generated music and its stems to finish before saving this session.", 409)
            if separation.get("state") == "complete":
                names += ["stems/" + item["filename"] for item in separation.get("stems", [])]
            prefix = "jobs/" + identifier + "/"
        elif kind == "rap-response":
            names = [job.get(key) for key in ("_filename", "_vocal_filename", "_clean_vocal_filename", "_instrumental_filename", "_raw_filename", "_raw_vocal_filename")]
            prefix = identifier + "/"
        else:
            names = [item.get(key) for item in job.get("examples", []) for key in ("filename", "full_mix_filename")]
            prefix = identifier + "/"
        paths = []
        for name in names:
            if name is None:
                continue
            clean_path(name)
            if Path(name).suffix.lower() not in MEDIA or Path(name).name.lower() == "input.wav":
                raise ServiceError("The saved session includes unsupported audio.")
            paths.append(prefix + name)
        if not paths:
            raise ServiceError("The selected generated track has no completed audio. Choose a completed track before saving.", 409)
        return sorted(set(paths))

    def _snapshot(self, kind, identifier):
        service = self.services[kind]
        if service is None:
            raise ServiceError("The selected audio service is unavailable. Start the dashboard with generated audio enabled.", 503)
        try:
            with service._lock:
                job = copy.deepcopy(service._job(identifier))
                if job.get("state") != "complete":
                    raise ServiceError("The selected generated audio is not complete. Wait for it to finish or choose a completed track.", 409)
                record = {"kind": kind, "id": identifier, "name": label(job, kind), "job": job}
                if kind == "elevenlabs":
                    record["plan"] = copy.deepcopy(service._read("plans", job["plan_id"]))
                    if not job.get("generation_settings"):
                        job["generation_settings"] = copy.deepcopy(record["plan"].get("settings", {}))
                    record["name"] = label(job, kind)
                    # Never restore a job that would resume billable stem work on restart.
                    if job.get("separate_stems") and not job.get("stem_separation"):
                        job["separate_stems"] = False
                    # A snapshot includes finished timing only. Loading settings
                    # must never restart an analysis that was still in progress.
                    if (job.get("beat_analysis") or {}).get("state") in {"queued", "analyzing"}:
                        job.pop("beat_analysis", None)
                else:
                    table = TABLES[kind]
                    row = service._db.execute(f"SELECT request_hash FROM {table} WHERE id=?", (identifier,)).fetchone()
                    record["request_hash"] = row[0]
                record["paths"] = self._media_paths(kind, job)
                return record
        except ServiceError as error:
            if error.status == 404:
                raise ServiceError(f"Selected {kind} audio {identifier[:12]} is missing. Restore its session archive or choose an available track.", 404) from None
            raise

    def capture(self, payload):
        refs = references(payload.get("storage"))
        if not refs:
            return None
        self._root()
        temporary = Path(tempfile.mkdtemp(prefix=".capture-", dir=self.root))
        manifest = {"version": 1, "tracks": []}
        try:
            total = 0
            for kind, job_id in refs:
                record = self._snapshot(kind, job_id)
                service = self.services[kind]
                record["files"] = []
                slug = re.sub(r"[^A-Za-z0-9_-]+", "-", record["name"]).strip("-")[:60] or "generated-audio"
                for relative in record.pop("paths"):
                    source = safe_file(service.root, relative)
                    if not source.is_file():
                        raise ServiceError(f"Generated audio is missing: {record['name']}. Restore its original archive before saving.", 404)
                    size = source.stat().st_size
                    total += size
                    if not size or total > MAX_EXPANDED:
                        raise ServiceError("Generated audio is empty or exceeds the 1 GB session limit.", 413)
                    filename = f"audio/{kind}-{job_id[:8]}-{slug}/{relative.split('/', 2)[-1] if kind == 'elevenlabs' else relative.split('/', 1)[-1]}"
                    target = safe_file(temporary, filename)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, target)
                    record["files"].append({"path": relative, "file": filename, "bytes": size, "sha256": hash_file(target)})
                manifest["tracks"].append(record)
            # Identical snapshots share a single immutable asset directory.
            identifier = hashlib.sha256(canonical_json(manifest).encode()).hexdigest()[:32]
            manifest["id"] = identifier
            (temporary / "manifest.json").write_text(canonical_json(manifest), encoding="utf-8")
            self._validate_manifest(manifest, temporary)
            if (self.root / identifier).exists():
                previous, _ = self._bundle(self._metadata(manifest))
                if previous != manifest:
                    raise ServiceError("The saved audio archive identifier conflicts with existing audio.", 409)
            else:
                temporary.rename(self.root / identifier)
            return self._metadata(manifest)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)

    def _metadata(self, manifest):
        tracks = [{"id": item["id"], "kind": item["kind"], "name": item["name"], "files": len(item["files"]),
                   "bytes": sum(file["bytes"] for file in item["files"])} for item in manifest["tracks"]]
        return {"id": manifest["id"], "files": sum(item["files"] for item in tracks),
                "bytes": sum(item["bytes"] for item in tracks), "tracks": tracks}

    def _validate_manifest(self, value, directory):
        if not isinstance(value, dict) or value.get("version") != 1 or not BUNDLE_ID.fullmatch(str(value.get("id", ""))):
            raise ServiceError("The session audio manifest is invalid.")
        tracks = value.get("tracks")
        if not isinstance(tracks, list) or not 1 <= len(tracks) <= 100:
            raise ServiceError("The session contains too many generated tracks.")
        seen, all_files, plans, total = set(), set(), {}, 0
        for record in tracks:
            kind, identifier, job = record["kind"], record["id"], record["job"]
            if kind not in KINDS or not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier) or (kind, identifier) in seen:
                raise ServiceError("The session contains an invalid generated track.")
            seen.add((kind, identifier))
            if not isinstance(job, dict) or job.get("id") != identifier or job.get("state") != "complete":
                raise ServiceError("Only completed generated audio can be imported.")
            def local_url(key, expected, source=job):
                if source.get(key) not in (None, expected):
                    raise ServiceError("The session contains an invalid generated audio address.")
            if not isinstance(record.get("name"), str) or not 1 <= len(record["name"]) <= 80:
                raise ServiceError("The session contains an invalid track name.")
            if kind == "elevenlabs":
                plan = record.get("plan")
                if not isinstance(plan, dict) or plan.get("id") != job.get("plan_id") or not IDENTIFIER.fullmatch(str(plan.get("id", ""))):
                    raise ServiceError("The session is missing a generated music plan.")
                if job.get("separate_stems") and not job.get("stem_separation"):
                    raise ServiceError("The session cannot contain pending stem work.")
                separation = job.get("stem_separation")
                if separation is not None and (not isinstance(separation, dict)
                        or separation.get("state") not in {"complete", "failed", "unknown", "not_requested"}
                        or not isinstance(separation.get("stems", []), list)):
                    raise ServiceError("The generated stem recovery metadata is invalid.")
                if separation and separation["state"] == "complete" and not separation.get("stems"):
                    raise ServiceError("The completed stem audio inventory is empty.")
                plan_cache_key(plan)
                if plan.get("origin") == "uploaded" or job.get("origin") == "uploaded":
                    validate_uploaded_plan(plan)
                    if job.get("origin") != "uploaded" or job.get("source") != plan["source"]:
                        raise ServiceError("The uploaded audio does not match its saved source.")
                else:
                    validate_request(plan["request"])
                if plan["id"] in plans and plans[plan["id"]] != plan:
                    raise ServiceError("The session contains conflicting versions of a music plan.")
                plans[plan["id"]] = plan
                if type(job.get("attempt_count")) is not int or job["attempt_count"] < 1:
                    raise ServiceError("The generated music recovery metadata is invalid.")
                for key in ("cache_key", "created_at"):
                    if not isinstance(job.get(key), str):
                        raise ServiceError("The generated music metadata is invalid.")
                local_url("audio_url", f"/api/elevenlabs/generations/{identifier}/audio")
                local_url("export_url", f"/api/elevenlabs/generations/{identifier}/export")
                for stem in (job.get("stem_separation") or {}).get("stems", []):
                    if not IDENTIFIER.fullmatch(str(stem.get("id", ""))):
                        raise ServiceError("The session contains an invalid stem identifier.")
                    local_url("audio_url", f"/api/elevenlabs/generations/{identifier}/stems/{stem['id']}/audio", stem)
                    if stem.get("content_type") not in MIME_TYPES or type(stem.get("size_bytes")) is not int or stem["size_bytes"] <= 0:
                        raise ServiceError("The generated stem media metadata is invalid.")
                if not isinstance(job.get("audio"), dict) or job["audio"].get("content_type") not in MIME_TYPES:
                    raise ServiceError("The generated audio media type is invalid.")
                if job.get("beat_analysis") is not None:
                    try:
                        validate_beat_analysis(job["beat_analysis"], job["audio"].get("duration_seconds"))
                    except (ValueError, TypeError) as error:
                        raise ServiceError("The saved beat analysis is invalid: " + str(error)) from None
                    if job["beat_analysis"]["state"] in {"queued", "analyzing"}:
                        raise ServiceError("The session contains unfinished beat analysis.")
            else:
                if not IDENTIFIER.fullmatch(str(job.get("request_id", ""))) or not isinstance(record.get("request_hash"), str) or not isinstance(job.get("created_at"), str):
                    raise ServiceError("The generated rap metadata is invalid.")
                if kind == "rap":
                    local_url("audio_url", f"/api/rap/renders/{identifier}/audio")
                elif kind == "rap-response":
                    local_url("audio_url", f"/api/rap-response/responses/{identifier}/audio")
                    local_url("vocal_audio_url", f"/api/rap-response/responses/{identifier}/vocals/audio")
                    if job.get("vocal_state") in {"queued", "isolating", "generating", "rendering", "converting"}:
                        raise ServiceError("Wait for the generated rap voice to finish before saving.", 409)
                    for name in ("_content_type", "_vocal_content_type", "_raw_content_type"):
                        if job.get(name) is not None and job[name] not in MIME_TYPES:
                            raise ServiceError("The generated rap media type is invalid.")
                    if job.get("_filename") and job.get("_content_type") not in MIME_TYPES or job.get("_vocal_filename") and job.get("_vocal_content_type") not in MIME_TYPES:
                        raise ServiceError("The generated rap media metadata is incomplete.")
                else:
                    for example in job.get("examples", []):
                        if not IDENTIFIER.fullmatch(str(example.get("id", ""))):
                            raise ServiceError("The session contains an invalid comparison identifier.")
                        local_url("audio_url", f"/api/rap-experiment/experiments/{identifier}/audio/{example['id']}", example)
                        local_url("full_mix_url", f"/api/rap-experiment/experiments/{identifier}/audio/music_full", example)
                        if example.get("state") in {"queued", "generating", "rendering"}:
                            raise ServiceError("Wait for the rap comparison to finish before saving.", 409)
                        for field, media in (("filename", "content_type"), ("full_mix_filename", "full_mix_content_type")):
                            if example.get(field) and example.get(media) not in MIME_TYPES:
                                raise ServiceError("The generated comparison media type is invalid.")
            expected = set(self._media_paths(kind, job))
            sizes = {}
            if kind == "elevenlabs":
                if job["audio"].get("size_bytes") is not None:
                    sizes[f"jobs/{identifier}/{job['audio_filename']}"] = job["audio"]["size_bytes"]
                for stem in (job.get("stem_separation") or {}).get("stems", []):
                    sizes[f"jobs/{identifier}/stems/{stem['filename']}"] = stem["size_bytes"]
            files = record.get("files")
            if not isinstance(files, list) or {item["path"] for item in files} != expected or len(files) != len(expected):
                raise ServiceError("The session audio inventory is incomplete.")
            for item in files:
                filename = clean_path(item["file"])
                if not filename.startswith("audio/") or filename in all_files:
                    raise ServiceError("The session contains duplicate or invalid audio filenames.")
                all_files.add(filename)
                path = safe_file(directory, filename)
                declared_size = sizes.get(item["path"])
                if declared_size is not None and (type(declared_size) is not int or declared_size != item["bytes"]):
                    raise ServiceError("Generated audio is incomplete or damaged. Restore its original archive before saving.")
                if not isinstance(item["bytes"], int) or item["bytes"] <= 0 or not path.is_file() or path.stat().st_size != item["bytes"] or hash_file(path) != item["sha256"]:
                    raise ServiceError("Session audio is missing or damaged; import the complete archive again.")
                if kind == "elevenlabs" and job.get("origin") == "uploaded" and item["path"] == f"jobs/{identifier}/{job.get('audio_filename')}":
                    if item["sha256"] != job["source"]["sha256"] or item["bytes"] != job["source"]["size_bytes"]:
                        raise ServiceError("The uploaded audio does not match its original file.")
                total += item["bytes"]
            if kind == "elevenlabs" and (job.get("beat_analysis") or {}).get("state") == "complete":
                analysis = job["beat_analysis"]
                checksums = {item["path"]: item["sha256"] for item in files}
                original = f"jobs/{identifier}/{job['audio_filename']}"
                source = original
                if analysis["source"] == "drums":
                    stem = next((item for item in (job.get("stem_separation") or {}).get("stems", [])
                                 if item["id"] == analysis.get("source_stem_id")), None)
                    if stem is None:
                        raise ServiceError("The saved beat analysis is missing its drum source.")
                    source = f"jobs/{identifier}/stems/{stem['filename']}"
                if analysis["audio_sha256"] != checksums.get(original) or analysis["source_sha256"] != checksums.get(source):
                    raise ServiceError("The saved beat analysis does not match its audio.")
        if total > MAX_EXPANDED or len(all_files) > MAX_FILES:
            raise ServiceError("The session audio archive is too large.", 413)
        return value

    def _bundle(self, metadata):
        if not isinstance(metadata, dict) or not BUNDLE_ID.fullmatch(str(metadata.get("id", ""))):
            raise ServiceError("The session audio reference is invalid.")
        directory = safe_file(self.root, metadata["id"])
        if not (directory / "manifest.json").is_file():
            raise ServiceError("This session's generated audio is missing. Import its ZIP archive before loading.", 404)
        manifest = self._validate_manifest(read_json(safe_file(directory, "manifest.json")), directory)
        if self._metadata(manifest) != metadata:
            raise ServiceError("The session audio metadata does not match its archive.")
        return manifest, directory

    def restore(self, payload):
        # Hold the service locks throughout collision checks and installation so
        # a generation worker cannot change a checked destination between them.
        with ExitStack() as locks:
            for kind in sorted(self.services):
                service = self.services[kind]
                if service is not None:
                    locks.enter_context(service._lock)
            return self._restore_locked(payload)

    def _restore_locked(self, payload):
        manifest, directory = self._bundle(payload.get("assets"))
        # Validate all collisions before installing any files or database rows.
        work = []
        for record in manifest["tracks"]:
            kind, job = record["kind"], record["job"]
            service = self.services[kind]
            if service is None:
                raise ServiceError(f"The {kind} audio service is unavailable.", 503)
            with service._lock:
                try:
                    existing = service._job(job["id"])
                except ServiceError as error:
                    if error.status != 404:
                        raise
                    existing = None
                if existing:
                    identity = "plan_id" if kind == "elevenlabs" else "request_id"
                    active_states = {"queued", "generating", "rendering", "isolating", "converting", "transcribing", "writing"}
                    if (existing.get(identity) != job.get(identity) or existing.get("state") in active_states
                            or (existing.get("stem_separation") or {}).get("state") in active_states
                            or existing.get("vocal_state") in active_states):
                        raise ServiceError("A different or running track already uses this audio identifier. Existing audio was preserved.", 409)
                elif kind != "elevenlabs":
                    table = TABLES[kind]
                    if service._db.execute(f"SELECT id FROM {table} WHERE request_id=?", (job["request_id"],)).fetchone():
                        raise ServiceError("A different saved rap uses this request identifier. Existing audio was preserved.", 409)
                files = []
                for item in record["files"]:
                    target = safe_file(service.root, item["path"])
                    if target.exists() and (not target.is_file() or hash_file(target) != item["sha256"]):
                        raise ServiceError("Different audio already exists at this location. Existing audio was preserved.", 409)
                    files.append((safe_file(directory, item["file"]), target))
                if kind == "elevenlabs":
                    plan_path = safe_file(service.root, "plans/" + record["plan"]["id"] + ".json")
                    if plan_path.exists():
                        old = read_json(plan_path)
                        if (old.get("request") != record["plan"].get("request")
                                or (old.get("origin") == "uploaded" or record["plan"].get("origin") == "uploaded")
                                and plan_cache_key(old) != plan_cache_key(record["plan"])):
                            raise ServiceError("A different music plan already uses this identifier.", 409)
                work.append((record, service, existing, files))
        for record, service, existing, files in work:
            job, kind = record["job"], record["kind"]
            with service._lock:
                for source, target in files:
                    if target.exists():
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    descriptor, temporary_name = tempfile.mkstemp(prefix=".session-", dir=target.parent)
                    temporary = Path(temporary_name)
                    try:
                        with source.open("rb") as input_file, os.fdopen(descriptor, "wb") as output:
                            shutil.copyfileobj(input_file, output)
                        os.link(temporary, target)
                    finally:
                        temporary.unlink(missing_ok=True)
                if kind == "elevenlabs":
                    plan_path = safe_file(service.root, "plans/" + record["plan"]["id"] + ".json")
                    if not plan_path.exists():
                        plan_path.parent.mkdir(parents=True, exist_ok=True)
                        with plan_path.open("x", encoding="utf-8") as output:
                            output.write(canonical_json(record["plan"]))
                    restored_stems = existing and (existing.get("stem_separation") or {}).get("state") != "complete" and (job.get("stem_separation") or {}).get("state") == "complete"
                    if not existing or existing.get("state") != "complete":
                        service._write_job(copy.deepcopy(job))
                    else:
                        restored = copy.deepcopy(existing)
                        if restored_stems:
                            restored["stem_separation"] = copy.deepcopy(job["stem_separation"])
                        if (job.get("beat_analysis") or {}).get("state") == "complete":
                            restored["beat_analysis"] = copy.deepcopy(job["beat_analysis"])
                        if restored != existing:
                            service._write_job(restored)
                elif not existing:
                    table = TABLES[kind]
                    service._db.execute(f"INSERT INTO {table} VALUES (?,?,?,?,?,?)", (job["id"], job["request_id"], record["request_hash"], "complete", job["created_at"], canonical_json(job)))
                    service._db.commit()
        return {"restored": True}

    def _library(self, value):
        if not isinstance(value, dict) or value.get("format") != "hydra-sessions" or value.get("version") != 1 or not isinstance(value.get("sessions"), list) or not 1 <= len(value["sessions"]) <= 50:
            raise ServiceError("Choose a Hydra sessions archive.")
        if len(canonical_json(value).encode()) > MAX_JSON:
            raise ServiceError("Session settings exceed the 4 MB limit.", 413)
        for session in value["sessions"]:
            if not isinstance(session, dict) or session.get("schema") != 1:
                raise ServiceError("The session version is unsupported.")
            references(session.get("storage"))
        return copy.deepcopy(value)

    def export(self, payload):
        library = self._library(payload)
        self._root()
        bundles = {}
        for session in library["sessions"]:
            if not session.get("assets"):
                assets = self.capture(session)
                if assets:
                    session["assets"] = assets
            if session.get("assets"):
                manifest, directory = self._bundle(session["assets"])
                bundles[manifest["id"]] = (manifest, directory)
        name = library["sessions"][0].get("name", "session") if len(library["sessions"]) == 1 else "all-sessions"
        slug = re.sub(r"[^A-Za-z0-9_-]+", "-", str(name)).strip("-")[:70] or "session"
        destination = self.root / ("export-" + uuid.uuid4().hex + ".zip")
        try:
            with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
                archive.writestr("sessions.json", canonical_json(library))
                total = 0
                for identifier, (manifest, directory) in bundles.items():
                    archive.writestr(f"assets/{identifier}/manifest.json", canonical_json(manifest))
                    for record in manifest["tracks"]:
                        for item in record["files"]:
                            total += item["bytes"]
                            if total > MAX_EXPANDED:
                                raise ServiceError("The combined session archive exceeds 1 GB. Export sessions separately.", 413)
                            archive.write(safe_file(directory, item["file"]), f"assets/{identifier}/{item['file']}")
            if destination.stat().st_size > MAX_ZIP:
                destination.unlink()
                raise ServiceError("The compressed archive exceeds 1 GB. Export sessions separately.", 413)
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        return FileResponse(destination, "application/zip", f"hydra-{slug}.zip")

    def import_archive(self, data):
        if not isinstance(data, bytes) or not data or len(data) > MAX_ZIP:
            raise ServiceError("Choose a session ZIP archive smaller than 1 GB.", 413)
        self._root()
        with tempfile.TemporaryDirectory(prefix=".import-", dir=self.root) as temporary:
            staging = Path(temporary)
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
                if len(entries) > MAX_FILES + 51 or sum(item.file_size for item in entries) > MAX_EXPANDED + MAX_JSON * 51:
                    raise ServiceError("The expanded session archive is too large.", 413)
                seen = set()
                for item in entries:
                    name = clean_path(item.filename)
                    if name in seen or item.is_dir() or stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1:
                        raise ServiceError("The session archive contains duplicate, linked or encrypted files.")
                    seen.add(name)
                    if name != "sessions.json" and not re.fullmatch(r"assets/[a-f0-9]{32}/(?:manifest\.json|audio/.+)", name):
                        raise ServiceError("The session archive contains unsupported files.")
                    if name.endswith(".json") and item.file_size > MAX_JSON:
                        raise ServiceError("Session metadata exceeds the size limit.", 413)
                    target = safe_file(staging, name)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(item) as source, target.open("xb") as output:
                        shutil.copyfileobj(source, output)
            if "sessions.json" not in seen:
                raise ServiceError("The archive is missing sessions.json.")
            library = self._library(read_json(staging / "sessions.json"))
            wanted = {"sessions.json"}
            bundles = {}
            for session in library["sessions"]:
                assets = session.get("assets")
                if not assets:
                    if references(session["storage"]):
                        raise ServiceError("This archive references audio without including it. Export it again from the original dashboard.")
                    continue
                identifier = assets.get("id", "") if isinstance(assets, dict) else ""
                if not BUNDLE_ID.fullmatch(identifier):
                    raise ServiceError("The session audio identifier is invalid.")
                directory = safe_file(staging, "assets/" + identifier)
                manifest = self._validate_manifest(read_json(safe_file(directory, "manifest.json")), directory)
                if manifest["id"] != identifier or self._metadata(manifest) != assets:
                    raise ServiceError("The session audio manifest does not match its settings.")
                covered = {(item["kind"], item["id"]) for item in manifest["tracks"]}
                if not set(references(session["storage"])).issubset(covered):
                    raise ServiceError("The archive does not contain all the session's selected audio.")
                wanted.add(f"assets/{identifier}/manifest.json")
                wanted.update(f"assets/{identifier}/{item['file']}" for track in manifest["tracks"] for item in track["files"])
                bundles[identifier] = (manifest, directory)
            if wanted != seen:
                raise ServiceError("The archive contains unlisted or missing files.")
            for identifier, (manifest, directory) in bundles.items():
                target = safe_file(self.root, identifier)
                if target.exists():
                    old, _ = self._bundle(self._metadata(manifest))
                    if old != manifest:
                        raise ServiceError("Different session audio already uses this archive identifier.", 409)
            for identifier, (_, directory) in bundles.items():
                target = safe_file(self.root, identifier)
                if not target.exists():
                    directory.rename(target)
            return library

    def dispatch(self, method, path, payload=None):
        try:
            with self._lock:
                if method != "POST":
                    raise ServiceError("Endpoint not found.", 404)
                if path == "/api/sessions/import":
                    return 200, self.import_archive(payload)
                if not isinstance(payload, dict):
                    raise ServiceError("Send session settings as a JSON object.")
                if path == "/api/sessions/capture":
                    return 200, self.capture(payload)
                if path == "/api/sessions/restore":
                    return 200, self.restore(payload)
                if path == "/api/sessions/export":
                    return 200, self.export(payload)
                raise ServiceError("Endpoint not found.", 404)
        except ServiceError as error:
            return error.status, {"error": str(error)}
        except (ValueError, TypeError, KeyError, AttributeError, zipfile.BadZipFile, RuntimeError):
            return 400, {"error": "The session archive or its generated audio metadata is invalid."}
        except (OSError, sqlite3.Error):
            return 500, {"error": "Session audio could not be stored. Check free disk space and file permissions."}
