#!/usr/bin/env python3
"""Bounded indexing and series extraction for RAPP JSONL recordings."""

from __future__ import annotations

from collections import OrderedDict
import gzip
import json
import math
import os
from pathlib import Path
import threading
from typing import Any


SUPPORTED_SUFFIXES = (
    ".jsonl",
    ".jsonl.txt",
    ".ndjson",
    ".ndjson.txt",
    ".jsonl.gz",
    ".jsonl.txt.gz",
    ".ndjson.gz",
    ".ndjson.txt.gz",
)
MAX_RECORDINGS = 100
MAX_FIELDS_PER_CHANNEL = 256
MAX_SERIES_POINTS = 4000
SERIES_CACHE_LIMIT = 48


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


def recording_identifier(path: Path) -> str:
    name = path.name
    for suffix in sorted(SUPPORTED_SUFFIXES, key=len, reverse=True):
        if name.lower().endswith(suffix):
            return name[: -len(suffix)]
    return path.stem


def default_recordings_directory(project_root: Path) -> Path | None:
    configured = os.environ.get("RAPP_RECORDINGS_DIR")
    candidates = []
    if configured:
        candidates.append(Path(configured).expanduser())
    candidates.extend(
        [
            project_root / "recordings",
            project_root.parent
            / "RAPP-Realtime-Viz"
            / "viz_student_pack"
            / "recordings",
            project_root.parent / "rapp-realtime" / "recordings",
            project_root.parent / "rapp-realtime" / "viz_student_pack" / "recordings",
        ]
    )
    return next((path.resolve() for path in candidates if path.is_dir()), None)


def open_recording(path: Path):
    """Open plain or gzip-compressed JSONL as a text stream."""
    if path.name.lower().endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return path.open("r", encoding="utf-8", errors="replace")


def _display_name(identifier: str) -> str:
    return identifier.replace("_", " ").replace("-", " ").strip()


def _shape(value: Any) -> list[int]:
    if not isinstance(value, list):
        return []
    result = []
    for item in value:
        number = finite_number(item)
        if number is None or not number.is_integer() or number < 0:
            return []
        result.append(int(number))
    return result


def _field_descriptor(
    identifier: str,
    name: str,
    kind: str,
    *,
    shape: list[int] | None = None,
    label: str | None = None,
) -> dict[str, Any]:
    reducers = ["value"] if kind in {"position", "velocity"} else [
        "mean",
        "rms",
        "minimum",
        "maximum",
        "index",
    ]
    return {
        "id": identifier,
        "name": name,
        "kind": kind,
        "label": label,
        "shape": shape or [],
        "reducers": reducers,
        "default_reducer": reducers[0],
    }


class RecordingLibrary:
    """Read-only view of one trusted recordings directory."""

    def __init__(self, directory: Path | None) -> None:
        self.directory = directory.resolve() if directory is not None else None
        self.lock = threading.RLock()
        self.recordings: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self.series_cache: OrderedDict[tuple[Any, ...], dict[str, Any]] = OrderedDict()
        self.scan_error: str | None = None
        self.refresh()

    @property
    def available(self) -> bool:
        return self.directory is not None and self.directory.is_dir()

    def refresh(self) -> None:
        with self.lock:
            self.recordings.clear()
            self.series_cache.clear()
            self.scan_error = None
            directory = self.directory
            if directory is None or not directory.is_dir():
                return
            try:
                paths = sorted(
                    (
                        path
                        for path in directory.iterdir()
                        if path.is_file()
                        and any(
                            path.name.lower().endswith(suffix)
                            for suffix in SUPPORTED_SUFFIXES
                        )
                    ),
                    key=lambda path: path.name.casefold(),
                )[:MAX_RECORDINGS]
                for path in paths:
                    metadata = self._scan(path)
                    identifier = metadata["id"]
                    if identifier in self.recordings:
                        identifier = f"{identifier}-{len(self.recordings) + 1}"
                        metadata["id"] = identifier
                    self.recordings[identifier] = metadata
            except OSError as error:
                self.scan_error = str(error)

    def _scan(self, path: Path) -> dict[str, Any]:
        channels: OrderedDict[str, dict[str, Any]] = OrderedDict()
        first_time: float | None = None
        last_time: float | None = None
        frames = 0
        invalid_lines = 0

        try:
            with open_recording(path) as stream:
                for raw_line in stream:
                    try:
                        message = json.loads(raw_line)
                    except json.JSONDecodeError:
                        invalid_lines += 1
                        continue
                    if not isinstance(message, dict):
                        invalid_lines += 1
                        continue
                    frames += 1
                    timestamp = finite_number(message.get("t_recv"))
                    if timestamp is None:
                        timestamp = finite_number(message.get("stamp"))
                    if timestamp is not None:
                        first_time = timestamp if first_time is None else min(first_time, timestamp)
                        last_time = timestamp if last_time is None else max(last_time, timestamp)
                    channel_name = message.get("channel")
                    if not isinstance(channel_name, str) or not channel_name.strip():
                        channel_name = "unlabelled"
                    channel = channels.setdefault(
                        channel_name,
                        {
                            "id": channel_name,
                            "name": _display_name(channel_name),
                            "frames": 0,
                            "fields": OrderedDict(),
                        },
                    )
                    channel["frames"] += 1
                    self._discover_fields(channel["fields"], message)
        except OSError as error:
            return {
                "id": recording_identifier(path),
                "name": _display_name(recording_identifier(path)),
                "filename": path.name,
                "path": path,
                "size_bytes": 0,
                "modified_ns": 0,
                "frames": 0,
                "invalid_lines": 0,
                "duration_seconds": 0.0,
                "channels": [],
                "error": str(error),
            }

        stat = path.stat()
        return {
            "id": recording_identifier(path),
            "name": _display_name(recording_identifier(path)),
            "filename": path.name,
            "path": path,
            "size_bytes": stat.st_size,
            "compressed": path.name.lower().endswith(".gz"),
            "modified_ns": stat.st_mtime_ns,
            "frames": frames,
            "invalid_lines": invalid_lines,
            "duration_seconds": max(0.0, (last_time or 0.0) - (first_time or 0.0)),
            "channels": [
                {**channel, "fields": list(channel["fields"].values())}
                for channel in channels.values()
            ],
            "error": None,
        }

    @staticmethod
    def _discover_fields(
        fields: OrderedDict[str, dict[str, Any]], message: dict[str, Any]
    ) -> None:
        if len(fields) >= MAX_FIELDS_PER_CHANNEL:
            return
        data = message.get("data")
        labels = message.get("labels")
        if isinstance(data, list):
            if isinstance(labels, list) and len(labels) == len(data):
                for index, raw_label in enumerate(labels):
                    if len(fields) >= MAX_FIELDS_PER_CHANNEL:
                        break
                    label = str(raw_label) if raw_label is not None else f"value {index + 1}"
                    identifier = f"data:{index}"
                    fields.setdefault(
                        identifier,
                        _field_descriptor(
                            identifier, f"{label} position", "position", label=label
                        ),
                    )
            else:
                fields.setdefault(
                    "data",
                    _field_descriptor(
                        "data", "data", "array", shape=_shape(message.get("shape"))
                    ),
                )

        velocity = message.get("velocity")
        if isinstance(velocity, list):
            if isinstance(labels, list) and len(labels) == len(velocity):
                for index, raw_label in enumerate(labels):
                    if len(fields) >= MAX_FIELDS_PER_CHANNEL:
                        break
                    label = str(raw_label) if raw_label is not None else f"value {index + 1}"
                    identifier = f"velocity:{index}"
                    fields.setdefault(
                        identifier,
                        _field_descriptor(
                            identifier, f"{label} velocity", "velocity", label=label
                        ),
                    )
            else:
                fields.setdefault(
                    "velocity",
                    _field_descriptor("velocity", "velocity", "array"),
                )

        tensors = message.get("tensors")
        if not isinstance(tensors, dict):
            return
        for tensor_name, tensor in tensors.items():
            if len(fields) >= MAX_FIELDS_PER_CHANNEL or not isinstance(tensor, dict):
                break
            identifier = f"tensor:{tensor_name}"
            fields.setdefault(
                identifier,
                _field_descriptor(
                    identifier,
                    _display_name(str(tensor_name)),
                    "tensor",
                    shape=_shape(tensor.get("shape")),
                ),
            )

    def summary(self) -> dict[str, Any]:
        with self.lock:
            return {
                "available": self.available,
                "directory": str(self.directory) if self.directory is not None else None,
                "error": self.scan_error,
                "recordings": [self._public_metadata(item) for item in self.recordings.values()],
            }

    @staticmethod
    def _public_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
        return {
            key: value
            for key, value in metadata.items()
            if key not in {"path", "modified_ns"}
        }

    def series(
        self,
        recording_id: str,
        channel_id: str,
        field_id: str,
        reducer: str = "mean",
        index: int = 0,
        limit: int = 720,
    ) -> dict[str, Any]:
        limit = max(32, min(MAX_SERIES_POINTS, int(limit)))
        index = max(0, min(1_000_000, int(index)))
        with self.lock:
            metadata = self.recordings.get(recording_id)
            if metadata is None:
                raise KeyError("recording_not_found")
            field = next(
                (
                    candidate
                    for channel in metadata["channels"]
                    if channel["id"] == channel_id
                    for candidate in channel["fields"]
                    if candidate["id"] == field_id
                ),
                None,
            )
            if field is None:
                raise KeyError("field_not_found")
            allowed_reducers = field.get("reducers", [])
            if reducer not in allowed_reducers:
                raise ValueError("unsupported_reducer")
            cache_key = (
                recording_id,
                metadata["modified_ns"],
                channel_id,
                field_id,
                reducer,
                index,
                limit,
            )
            cached = self.series_cache.get(cache_key)
            if cached is not None:
                self.series_cache.move_to_end(cache_key)
                return cached
            path = metadata["path"]

        values: list[tuple[float, float]] = []
        ordinal = 0.0
        with open_recording(path) as stream:
            for raw_line in stream:
                try:
                    message = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(message, dict) or message.get("channel") != channel_id:
                    continue
                value = self._extract_value(message, field_id, reducer, index)
                if value is None:
                    continue
                timestamp = finite_number(message.get("t_recv"))
                if timestamp is None:
                    timestamp = finite_number(message.get("stamp"))
                if timestamp is None:
                    timestamp = ordinal
                ordinal += 1.0
                values.append((timestamp, value))

        if not values:
            raise ValueError("series_empty")
        minimum = min(value for _timestamp, value in values)
        maximum = max(value for _timestamp, value in values)
        start_time = values[0][0]
        end_time = values[-1][0]
        sampled = self._downsample(values, limit)
        duration = max(0.0, end_time - start_time)
        denominator = duration if duration > 0 else max(1.0, float(len(values) - 1))
        points = [
            [
                max(0.0, min(1.0, (timestamp - start_time) / denominator)),
                value,
            ]
            for timestamp, value in sampled
        ]
        if duration <= 0 and len(points) > 1:
            for position, point in enumerate(points):
                point[0] = position / (len(points) - 1)
        result = {
            "recording_id": recording_id,
            "channel": channel_id,
            "field": field_id,
            "reducer": reducer,
            "index": index,
            "source_points": len(values),
            "minimum": minimum,
            "maximum": maximum,
            "duration_seconds": duration,
            "points": points,
        }
        with self.lock:
            self.series_cache[cache_key] = result
            self.series_cache.move_to_end(cache_key)
            while len(self.series_cache) > SERIES_CACHE_LIMIT:
                self.series_cache.popitem(last=False)
        return result

    @staticmethod
    def _extract_value(
        message: dict[str, Any], field_id: str, reducer: str, index: int
    ) -> float | None:
        raw_values: Any
        if field_id.startswith("data:") or field_id.startswith("velocity:"):
            key, raw_index = field_id.split(":", 1)
            values = message.get(key)
            try:
                item_index = int(raw_index)
            except ValueError:
                return None
            if not isinstance(values, list) or not 0 <= item_index < len(values):
                return None
            return finite_number(values[item_index])
        if field_id.startswith("tensor:"):
            tensor_name = field_id.split(":", 1)[1]
            tensors = message.get("tensors")
            tensor = tensors.get(tensor_name) if isinstance(tensors, dict) else None
            raw_values = tensor.get("data") if isinstance(tensor, dict) else None
        else:
            raw_values = message.get(field_id)
        if not isinstance(raw_values, list):
            return None
        values = [number for item in raw_values if (number := finite_number(item)) is not None]
        if not values:
            return None
        if reducer == "index":
            return values[index] if index < len(values) else None
        if reducer == "minimum":
            return min(values)
        if reducer == "maximum":
            return max(values)
        if reducer == "rms":
            return math.sqrt(sum(value * value for value in values) / len(values))
        if reducer in {"mean", "value"}:
            return sum(values) / len(values)
        return None

    @staticmethod
    def _downsample(
        values: list[tuple[float, float]], limit: int
    ) -> list[tuple[float, float]]:
        if len(values) <= limit:
            return values
        sampled = []
        for position in range(limit):
            source_index = round(position * (len(values) - 1) / (limit - 1))
            sampled.append(values[source_index])
        return sampled
