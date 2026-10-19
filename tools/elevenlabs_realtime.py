"""Pure musical-direction/live-summary planning and validated stem archives."""

from __future__ import annotations

import copy
import math
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
from typing import Any, Callable
import zipfile

from elevenlabs_analysis import SCHEMA_VERSION, compile_plan, validate_request

SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
STEM_ID = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
STEM_VARIATIONS = {"two_stems_v1", "six_stems_v1"}
MAX_STEM_BYTES = 128 * 1024 * 1024
MAX_UNPACKED_BYTES = 384 * 1024 * 1024
AUDIO_SUFFIXES = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}


def validated_generation_settings(settings: Any) -> dict[str, Any]:
    """Validate editable musical direction before allocating any paid job."""
    allowed = {"style", "bpm", "key", "instrument_palette", "negative_styles",
               "enable_variability", "context_adherence", "seed"}
    if not isinstance(settings, dict) or set(settings) - allowed:
        raise ValueError("settings must contain only supported musical direction fields.")
    result = copy.deepcopy(settings)
    for name, maximum in (("style", 300), ("key", 80)):
        if name in result:
            value = result[name]
            if not isinstance(value, str) or not value.strip() or len(value) > maximum or any(ord(char) < 32 for char in value):
                raise ValueError(f"settings.{name} must be a nonempty printable string of at most {maximum} characters.")
            result[name] = value.strip()
    if "bpm" in result:
        value = result["bpm"]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 20 <= value <= 300:
            raise ValueError("settings.bpm must be a finite number from 20 to 300.")
    for name in ("instrument_palette", "negative_styles"):
        if name in result:
            values = result[name]
            if not isinstance(values, list) or len(values) > 20 or any(
                not isinstance(value, str) or not value.strip() or len(value) > 300
                or any(ord(char) < 32 for char in value) for value in values
            ):
                raise ValueError(f"settings.{name} must contain at most 20 nonempty style strings of at most 300 characters.")
            result[name] = [value.strip() for value in values]
    if "enable_variability" in result and type(result["enable_variability"]) is not bool:
        raise ValueError("settings.enable_variability must be true or false.")
    if "context_adherence" in result and result["context_adherence"] not in ("low", "medium", "high"):
        raise ValueError("settings.context_adherence must be low, medium, or high.")
    if "seed" in result and result["seed"] is not None and (type(result["seed"]) is not int or not 0 <= result["seed"] <= 2147483647):
        raise ValueError("settings.seed must be null or an integer from 0 to 2147483647.")
    return result


def _validated_continuation_envelope(payload: dict[str, Any]) -> dict[str, Any]:
    session = payload.get("session_id")
    sequence = payload.get("sequence")
    duration = payload.get("duration_seconds", 40)
    if not isinstance(session, str) or not SESSION_ID.fullmatch(session):
        raise ValueError("session_id must contain 1–80 letters, digits, underscores or hyphens.")
    if type(sequence) is not int or not 0 <= sequence <= 1000000:
        raise ValueError("sequence must be an integer from 0 to 1000000.")
    if type(duration) is not int or duration not in {20, 40, 60}:
        raise ValueError("duration_seconds must be 20, 40 or 60.")
    result = {"session_id": session, "sequence": sequence, "duration_seconds": duration,
              "plan_id": payload.get("plan_id"), "source_job_id": payload.get("source_job_id")}
    # Omit absent settings to retain fingerprints for saved live requests.
    if "settings" in payload:
        result["settings"] = validated_generation_settings(payload["settings"])
    return result


def validated_continuation_request(payload: dict[str, Any]) -> dict[str, Any]:
    """Keep prompt-driven requests distinct from measured live-input summaries."""
    if payload.get("kind") == "prompt":
        allowed = {"kind", "plan_id", "source_job_id", "session_id", "sequence", "duration_seconds", "settings", "continuity_mode"}
        if set(payload) - allowed:
            raise ValueError("Prompt continuations accept musical settings and track references, without live features or provider requests.")
        result = {"kind": "prompt", **_validated_continuation_envelope(payload)}
        if "continuity_mode" in payload:
            if payload["continuity_mode"] not in ("fresh", "evolve"):
                raise ValueError("continuity_mode must be fresh or evolve.")
            result["continuity_mode"] = payload["continuity_mode"]
        # Omission is deliberately different from the new UI's explicit fresh
        # default: saved pending requests must keep their exact fingerprint.
        return result
    if payload.get("kind") not in (None, "live"):
        raise ValueError("Continuation kind must be prompt or live.")
    return validated_live_request(payload)


def validated_live_request(payload: dict[str, Any]) -> dict[str, Any]:
    """Accept bounded summaries and editable direction, never raw provider requests."""
    if "continuity_mode" in payload:
        raise ValueError("continuity_mode is supported only for prompt continuations.")
    result = _validated_continuation_envelope(payload)
    incoming = payload.get("features")
    if not isinstance(incoming, dict):
        raise ValueError("Provide the recent live feature summary.")
    features = {}
    for name, lower, upper, default in (
        ("activity", 0, 1, None), ("variability", 0, 1, None),
        ("coverage", 0, 1, None), ("window_seconds", 0.05, 120, None),
        ("trend", -1, 1, 0),
    ):
        value = incoming.get(name, default)
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not lower <= value <= upper:
            raise ValueError(f"features.{name} must be a finite number from {lower} to {upper}.")
        features[name] = value
    if features["coverage"] < 0.9:
        raise ValueError("At least 90% valid recent input is required for background generation.")
    if "sample_count" in incoming:
        count = incoming["sample_count"]
        if type(count) is not int or not 2 <= count <= 100000:
            raise ValueError("features.sample_count must be an integer from 2 to 100000.")
        features["sample_count"] = count
    if "source" in incoming:
        source = incoming["source"]
        if not isinstance(source, str) or not 1 <= len(source) <= 80 or any(ord(char) < 32 for char in source):
            raise ValueError("features.source must be a short, printable input label.")
        features["source"] = source
    result["features"] = features
    return result


def original_music_plan(payload: dict[str, Any]) -> dict[str, Any]:
    """Build an instrumental starting track without inventing source observations."""
    if set(payload) - {"kind", "duration_seconds", "settings"}:
        raise ValueError("Original music accepts only kind, duration_seconds and musical settings.")
    duration = payload.get("duration_seconds", 20)
    if type(duration) is not int or duration not in {20, 40, 60}:
        raise ValueError("duration_seconds must be 20, 40 or 60.")
    settings = {
        "style": "instrumental electronic music", "key": "D minor", "bpm": 100,
        "instrument_palette": ["warm synthesizer tones", "soft electronic percussion"],
        "negative_styles": [], "enable_variability": False, "context_adherence": "high",
        **validated_generation_settings(payload.get("settings", {})),
    }
    if settings.get("seed") is None:
        settings.pop("seed", None)
    anchors = [settings["style"], "instrumental music", f"{settings['bpm']:g} BPM", settings["key"],
               *settings["instrument_palette"]]
    chunk = {
        "text": "", "duration_ms": duration * 1000,
        "positive_styles": list(dict.fromkeys(anchors)),
        "negative_styles": list(dict.fromkeys(["vocals", "lyrics", *settings["negative_styles"]])),
        "context_adherence": settings["context_adherence"],
    }
    request = {"model_id": "music_v2_5", "composition_plan": {"chunks": [chunk]},
               "store_for_inpainting": True}
    if "seed" in settings:
        request["seed"] = settings["seed"]
    validate_request(request)
    return {
        "schema_version": SCHEMA_VERSION, "origin": "original", "mapping_version": "original-music-v1",
        "analysis_id": None, "dataset_id": None, "dataset_name": "Original music", "dataset_hash": None,
        "settings": settings, "request": request, "duration_seconds": duration,
        "analysis_settings": {"kind": "original", "channels": []}, "baseline": {}, "thresholds": {},
        "sections": [{"index": 0, "source_start": None, "source_end": None,
                      "audio_start": 0, "audio_end": duration, **copy.deepcopy(chunk),
                      "descriptors": {"direction": list(dict.fromkeys(anchors))}}],
        "manual_edits": False, "warnings": [], "blocking_reasons": [], "can_generate": True,
    }


def compile_prompt_plan(anchor: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Create a fresh musical direction plan without fabricating data observations."""
    plan = original_music_plan({
        "kind": "original", "duration_seconds": payload["duration_seconds"],
        "settings": {**copy.deepcopy(anchor["settings"]), **payload.get("settings", {})},
    })
    provenance = {
        "kind": "prompt_continuation", "root_plan_id": anchor["id"],
        "source_job_id": payload["source_job_id"], "session_id": payload["session_id"],
        "sequence": payload["sequence"], "generation_settings": copy.deepcopy(plan["settings"]),
        "continuity_mode": payload.get("continuity_mode", "legacy"),
        "provenance_note": "This track follows musical direction without a live-input summary. Saved provider audio is used for conditioning when available; matching beats and melody is not guaranteed.",
    }
    if payload.get("continuity_mode") == "fresh":
        provenance["provenance_note"] = "This track follows musical direction without a live-input summary or conditioning on previous audio. Matching beats and melody is not guaranteed."
    elif payload.get("continuity_mode") == "evolve":
        provenance["provenance_note"] = "This track follows musical direction with low-strength conditioning on saved provider audio when available. Matching beats and melody is not guaranteed."
    # Each explicit sequence is a fresh track, even if direction is unchanged
    # or the source has no retained provider song ID. Keep the sequence in the
    # plan's actual prompt metadata, never in a fabricated source-data hash.
    plan.update(origin="prompt_continuation", mapping_version="prompt-music-v1",
                dataset_name="Next track", realtime=provenance,
                analysis_settings={"kind": "prompt", "root_plan_id": anchor["id"],
                                   "session_id": payload["session_id"], "sequence": payload["sequence"],
                                   "channels": []})
    if "continuity_mode" in payload:
        # Explicit mode remains part of cache identity even when neither plan
        # has a usable provider song reference. Legacy cache keys stay intact.
        plan["analysis_settings"]["continuity_mode"] = payload["continuity_mode"]
    plan["sections"][0]["provenance"] = provenance
    return plan


def compile_live_plan(anchor: dict[str, Any], payload: dict[str, Any], feature_hash: str) -> dict[str, Any]:
    features = payload["features"]
    duration = payload["duration_seconds"]
    band = lambda value: "low" if value < 0.33 else "medium" if value < 0.67 else "high"
    provenance = {
        "kind": "live_extrapolation", "root_plan_id": anchor["id"],
        "source_job_id": payload["source_job_id"], "session_id": payload["session_id"],
        "sequence": payload["sequence"], "observed_features": copy.deepcopy(features),
        "observed_window_seconds": features["window_seconds"],
        "provenance_note": "The next segment extrapolates a recent live input summary. It is independently generated, not aligned to a recording or guaranteed to continue the previous melody or beat.",
    }
    section = {
        "index": 0, "source_start": None, "source_end": None,
        "audio_start": 0, "audio_end": duration, "duration_ms": duration * 1000,
        **features, "bands": {name: band(features[name]) for name in ("activity", "variability")},
        "provenance": provenance,
    }
    analysis = {
        "sections": [section], "settings": {"kind": "live_summary", "root_plan_id": anchor["id"],
            "window_seconds": features["window_seconds"], "channels": []},
        "baseline": copy.deepcopy(anchor["baseline"]), "dataset_hash": feature_hash,
        "duration_seconds": duration, "warnings": [provenance["provenance_note"]], "blocking_reasons": [],
    }
    settings = {**copy.deepcopy(anchor["settings"]), **payload.get("settings", {})}
    plan = compile_plan(analysis, settings)
    if payload.get("settings"):
        provenance["generation_settings"] = copy.deepcopy(plan["settings"])
    plan.update(analysis_id=anchor.get("analysis_id"), dataset_id=anchor.get("dataset_id"),
                dataset_name="Live input · next segment", manual_edits=False, realtime=provenance)
    return plan


def extract_stems(archive_path: Path, destination: Path, duration: float,
                  validator: Callable[[Path, float], dict[str, Any]]) -> list[dict[str, Any]]:
    """Do not extract provider paths. Validate every entry before exposing files."""
    destination.mkdir(exist_ok=False)
    try:
        with zipfile.ZipFile(archive_path) as archive:
            entries = archive.infolist()
            if not 1 <= len(entries) <= 20:
                raise ValueError("Stem archive contains too many or no entries.")
            audio_entries, total = [], 0
            for entry in entries:
                name = entry.filename
                path = PurePosixPath(name)
                mode = (entry.external_attr >> 16) & 0xFFFF
                if ("\\" in name or "\x00" in name or path.is_absolute() or ".." in path.parts
                        or not path.parts or ":" in path.parts[0] or stat.S_ISLNK(mode)
                        or (mode and stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))):
                    raise ValueError("Stem archive contains an unsafe path or entry.")
                if entry.is_dir():
                    continue
                if path.suffix.lower() not in AUDIO_SUFFIXES:
                    raise ValueError("Stem archive contains an unexpected non-audio file.")
                if entry.flag_bits & 1 or not 0 < entry.file_size <= MAX_STEM_BYTES:
                    raise ValueError("Stem archive contains an encrypted, empty or oversized file.")
                total += entry.file_size
                if total > MAX_UNPACKED_BYTES or entry.file_size > max(1024 * 1024, entry.compress_size * 200):
                    raise ValueError("Stem archive exceeds local unpacked size limits.")
                audio_entries.append(entry)
            if not 2 <= len(audio_entries) <= 8:
                raise ValueError("Stem archive must contain between two and eight audio layers.")
            stems, used_ids = [], set()
            for index, entry in enumerate(audio_entries):
                # Provider names describe layers, not guaranteed instruments.
                raw_name = PurePosixPath(entry.filename).stem
                stem_id = re.sub(r"[^a-z0-9]+", "_", raw_name.lower()).strip("_")[:48]
                if not STEM_ID.fullmatch(stem_id or "") or stem_id in used_ids:
                    stem_id = f"layer_{index + 1}"
                while stem_id in used_ids:
                    stem_id += "_x"
                used_ids.add(stem_id)
                temporary = destination / (stem_id + ".tmp")
                written = 0
                with archive.open(entry) as source, temporary.open("xb") as output:
                    while True:
                        chunk = source.read(64 * 1024)
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > entry.file_size or written > MAX_STEM_BYTES:
                            raise ValueError("Stem audio exceeds its declared size.")
                        output.write(chunk)
                if written != entry.file_size:
                    raise ValueError("Stem audio download is incomplete.")
                metadata = validator(temporary, duration)
                final = destination / (stem_id + "." + metadata["extension"])
                temporary.replace(final)
                stems.append({**metadata, "id": stem_id, "name": stem_id.replace("_", " ").title(),
                              "filename": final.name, "size_bytes": written})
            return stems
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise
