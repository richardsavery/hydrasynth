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
MAX_BATCH_SERIES = 192
SKELETON_JOINTS = (
    "nose", "neck", "right_shoulder", "right_elbow", "right_wrist",
    "left_shoulder", "left_elbow", "left_wrist", "right_hip", "right_knee",
    "right_ankle", "left_hip", "left_knee", "left_ankle", "right_eye",
    "left_eye", "right_ear", "left_ear",
)
SKELETON_AXES = (("x", "X (forward)"), ("y", "Y (left)"), ("z", "Z (up)"))
SKELETON_JOINT_INDEX = {joint: index for index, joint in enumerate(SKELETON_JOINTS)}
SKELETON_REGIONS = {
    "whole_body": tuple(range(18)),
    "head": (0, 14, 15, 16, 17),
    "torso": (1, 2, 5, 8, 11),
    "left_arm": (5, 6, 7),
    "right_arm": (2, 3, 4),
    "left_leg": (11, 12, 13),
    "right_leg": (8, 9, 10),
}
SKELETON_MOTION_IDS = {
    *(f"skeleton:{joint}:speed" for joint in SKELETON_JOINTS),
    *(f"skeleton:region:{region}:speed" for region in SKELETON_REGIONS),
}


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


def _skeleton_values(message: dict[str, Any]) -> list[Any] | None:
    """Recognize the ENACT camera-relative 18-joint skeleton contract."""
    if message.get("channel") != "skeleton":
        return None
    if "shape" in message and _shape(message["shape"]) not in ([18, 3], [54]):
        return None
    data = message.get("data")
    if not isinstance(data, list):
        return None
    if len(data) == 54 and all(not isinstance(value, list) for value in data):
        return data
    if len(data) == 18 and all(
        isinstance(row, list) and len(row) == 3
        and all(not isinstance(value, list) for value in row)
        for row in data
    ):
        return [value for row in data for value in row]
    return None


def _skeleton_coordinate(message: dict[str, Any], field_id: str) -> float | None:
    parts = field_id.split(":")
    if len(parts) != 3 or parts[1] not in SKELETON_JOINT_INDEX or parts[2] not in ("x", "y", "z"):
        return None
    values = _skeleton_values(message)
    if values is None:
        return None
    offset = SKELETON_JOINT_INDEX[parts[1]] * 3
    joint = [finite_number(value) for value in values[offset:offset + 3]]
    # Untracked joints are sent as zero triplets. Never turn missing tracking
    # into a physical movement, or shift later coordinates past an invalid one.
    if any(value is None for value in joint) or all(value == 0 for value in joint):
        return None
    return joint[("x", "y", "z").index(parts[2])]


class _SkeletonMotion:
    """Measure movement before downsampling, without bridging tracking gaps."""

    def __init__(self) -> None:
        self.at: float | None = None
        self.clock: str | None = None
        self.joints: list[list[float] | None] | None = None

    def step(self, message: dict[str, Any], timestamp: float | None) -> dict[str, float]:
        values = _skeleton_values(message)
        if values is None or timestamp is None:
            self.at = None
            self.clock = None
            self.joints = None
            return {}
        clock = "t_recv" if finite_number(message.get("t_recv")) is not None else (
            "stamp" if finite_number(message.get("stamp")) is not None else "external")
        joints = []
        for offset in range(0, 54, 3):
            joint = [finite_number(value) for value in values[offset:offset + 3]]
            joints.append(joint if all(value is not None for value in joint)
                          and any(value != 0 for value in joint) else None)
        previous, previous_at = self.joints, self.at
        dt = timestamp - previous_at if previous_at is not None and self.clock == clock else None
        if previous is not None and dt is not None and 0 < dt < 0.001:
            # Network batches can deliver two different positions almost at
            # once. Keep a useful time baseline but invalidate lost joints.
            self.joints = [old if current is not None else None
                           for old, current in zip(previous, joints)]
            return {}
        self.joints, self.at, self.clock = joints, timestamp, clock
        if previous is None or dt is None or not 0 < dt <= 0.5:
            return {}
        speeds = []
        for old, current in zip(previous, joints):
            speed = math.dist(old, current) / dt if old is not None and current is not None else None
            speeds.append(speed if speed is not None and math.isfinite(speed) else None)
        result = {f"skeleton:{joint}:speed": speed
                  for joint, speed in zip(SKELETON_JOINTS, speeds) if speed is not None}
        for region, members in SKELETON_REGIONS.items():
            tracked = [speeds[index] for index in members if speeds[index] is not None]
            if tracked:
                # Average magnitudes, so opposite limb movements do not cancel.
                result[f"skeleton:region:{region}:speed"] = sum(speed / len(tracked) for speed in tracked)
        return result


def _field_descriptor(
    identifier: str,
    name: str,
    kind: str,
    *,
    shape: list[int] | None = None,
    label: str | None = None,
) -> dict[str, Any]:
    reducers = ["value"] if kind in {"position", "velocity", "motion"} else [
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
                "start_time_seconds": None,
                "end_time_seconds": None,
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
            "start_time_seconds": first_time,
            "end_time_seconds": last_time,
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
        skeleton_values = _skeleton_values(message)
        data = skeleton_values if skeleton_values is not None else message.get("data")
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

        if skeleton_values is not None:
            # Keep the original array available for saved aggregate/index
            # mappings, including skeleton frames that also carry labels.
            if "data" in fields or len(fields) < MAX_FIELDS_PER_CHANNEL:
                fields.setdefault(
                    "data", _field_descriptor("data", "data", "array", shape=_shape(message.get("shape")))
                )
            for level, names in (("region", SKELETON_REGIONS), ("joint", SKELETON_JOINTS)):
                for name in names:
                    if len(fields) >= MAX_FIELDS_PER_CHANNEL:
                        break
                    identifier = f"skeleton:region:{name}:speed" if level == "region" else f"skeleton:{name}:speed"
                    label = f"{name.replace('_', ' ').capitalize()} movement"
                    description = "Combined XYZ movement speed in metres per second."
                    if level == "region":
                        description = "Average XYZ movement speed of tracked joints in metres per second."
                    fields.setdefault(identifier, {
                        **_field_descriptor(identifier, label, "motion", label=label),
                        "unit": "m/s", "skeletonLevel": level, "description": description,
                    })
            for joint in SKELETON_JOINTS:
                for axis, axis_label in SKELETON_AXES:
                    if len(fields) >= MAX_FIELDS_PER_CHANNEL:
                        break
                    identifier = f"skeleton:{joint}:{axis}"
                    label = f"{joint.replace('_', ' ').capitalize()} {axis_label}"
                    fields.setdefault(identifier, {
                        **_field_descriptor(identifier, label, "position", label=label),
                        "unit": "m", "skeletonLevel": "axis",
                    })

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
            elif "velocity" in fields or len(fields) < MAX_FIELDS_PER_CHANNEL:
                fields.setdefault(
                    "velocity",
                    _field_descriptor("velocity", "velocity", "array"),
                )

        if skeleton_values is not None:
            for identifier, field in fields.items():
                if identifier in {"data", "velocity"} or identifier.startswith(("data:", "velocity:")):
                    field["skeletonLevel"] = "raw"

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
        return self.series_batch(recording_id, [{
            "channel": channel_id, "field": field_id, "reducer": reducer,
            "index": index, "limit": limit,
        }])[0]

    def series_batch(
        self, recording_id: str, requests: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Extract a mapping set in one scan, retaining the single-series cache."""
        if not isinstance(requests, list) or not 1 <= len(requests) <= MAX_BATCH_SERIES:
            raise ValueError("batch_requires_1_to_192_sources")
        keys: list[tuple[Any, ...]] = []
        results: dict[tuple[Any, ...], dict[str, Any]] = {}
        pending: dict[tuple[Any, ...], list[tuple[float, float]]] = {}
        by_channel: dict[str, list[tuple[Any, ...]]] = {}
        with self.lock:
            metadata = self.recordings.get(recording_id)
            if metadata is None:
                raise KeyError("recording_not_found")
            fields = {(channel["id"], field["id"]): field
                      for channel in metadata["channels"] for field in channel["fields"]}
            path = metadata["path"]
            for request in requests:
                if not isinstance(request, dict):
                    raise ValueError("invalid_series_source")
                channel = request.get("channel")
                field_id = request.get("field")
                if not isinstance(channel, str) or not isinstance(field_id, str):
                    raise ValueError("invalid_series_source")
                field = fields.get((channel, field_id))
                if field is None:
                    raise KeyError("field_not_found")
                reducer = request.get("reducer", "mean")
                if reducer not in field.get("reducers", []):
                    raise ValueError("unsupported_reducer")
                try:
                    index = max(0, min(1_000_000, int(request.get("index", 0))))
                    limit = max(32, min(MAX_SERIES_POINTS, int(request.get("limit", 720))))
                except (TypeError, ValueError, OverflowError) as error:
                    raise ValueError("invalid_series_bounds") from error
                key = (recording_id, metadata["modified_ns"], channel, field_id, reducer, index, limit)
                keys.append(key)
                cached = self.series_cache.get(key)
                if cached is not None:
                    self.series_cache.move_to_end(key)
                    results[key] = cached
                elif key not in pending:
                    pending[key] = []
                    by_channel.setdefault(channel, []).append(key)

        if pending:
            motion = _SkeletonMotion()
            needs_motion = any(key[3] in SKELETON_MOTION_IDS for key in by_channel.get("skeleton", []))
            with open_recording(path) as stream:
                for raw_line in stream:
                    try:
                        message = json.loads(raw_line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(message, dict):
                        continue
                    channel = message.get("channel")
                    if not isinstance(channel, str):
                        continue
                    timestamp = finite_number(message.get("t_recv"))
                    if timestamp is None:
                        timestamp = finite_number(message.get("stamp"))
                    speeds = motion.step(message, timestamp) if channel == "skeleton" and needs_motion else {}
                    for key in by_channel.get(channel, []):
                        _recording, _modified, _channel, field_id, reducer, index, _limit = key
                        value = speeds.get(field_id) if field_id in SKELETON_MOTION_IDS else self._extract_value(message, field_id, reducer, index)
                        if value is None:
                            continue
                        sample_time = timestamp if timestamp is not None else float(len(pending[key]))
                        pending[key].append((sample_time, value))
            for key, values in pending.items():
                _recording, _modified, channel, field_id, reducer, index, limit = key
                results[key] = self._series_result(recording_id, channel, field_id, reducer, index, limit, values)
            with self.lock:
                for key in pending:
                    self.series_cache[key] = results[key]
                    self.series_cache.move_to_end(key)
                while len(self.series_cache) > SERIES_CACHE_LIMIT:
                    self.series_cache.popitem(last=False)
        return [results[key] for key in keys]

    def _series_result(
        self, recording_id: str, channel_id: str, field_id: str,
        reducer: str, index: int, limit: int, values: list[tuple[float, float]],
    ) -> dict[str, Any]:
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
            "start_time_seconds": start_time,
            "end_time_seconds": end_time,
            "duration_seconds": duration,
            "points": points,
        }
        return result

    @staticmethod
    def _extract_value(
        message: dict[str, Any], field_id: str, reducer: str, index: int
    ) -> float | None:
        raw_values: Any
        if field_id.startswith("skeleton:"):
            return _skeleton_coordinate(message, field_id)
        if field_id.startswith("data:") or field_id.startswith("velocity:"):
            key, raw_index = field_id.split(":", 1)
            values = message.get(key)
            if key == "data":
                skeleton_values = _skeleton_values(message)
                if skeleton_values is not None:
                    values = skeleton_values
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
            if field_id == "data":
                skeleton_values = _skeleton_values(message)
                if skeleton_values is not None:
                    raw_values = skeleton_values
                    if reducer == "index":
                        return finite_number(raw_values[index]) if 0 <= index < len(raw_values) else None
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
