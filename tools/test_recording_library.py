#!/usr/bin/env python3
"""Unit checks for bounded RAPP JSONL discovery and reduction."""

from __future__ import annotations

from collections import OrderedDict
import gzip
import json
import math
from pathlib import Path
import tempfile
from unittest.mock import patch

from recording_library import (
    MAX_FIELDS_PER_CHANNEL, RecordingLibrary, SKELETON_JOINTS, SKELETON_MOTION_IDS,
    SKELETON_REGIONS, _SkeletonMotion, _skeleton_values, open_recording,
)


def check_skeleton_recordings() -> None:
    flat = list(range(1, 55))
    nested = [[value + 100 for value in flat[index:index + 3]] for index in range(0, 54, 3)]
    missing = flat.copy()
    missing[12:15] = [0, 0, 0]
    invalid = flat.copy()
    invalid[13] = None
    valid_zero = flat.copy()
    valid_zero[12] = 0
    messages = [
        {"channel": "skeleton", "shape": [18, 3], "data": flat, "t_recv": 10},
        {"channel": "skeleton", "shape": [18, 3], "data": nested, "t_recv": 11},
        {"channel": "skeleton", "shape": [54], "data": missing, "t_recv": 12},
        {"channel": "skeleton", "data": invalid, "t_recv": 13},
        {"channel": "skeleton", "data": valid_zero, "t_recv": 14},
        {"channel": "skeleton", "shape": [9, 6], "data": flat, "t_recv": 15},
        {"channel": "skeleton", "shape": [18, 3], "data": flat + [55], "t_recv": 16},
        {"channel": "skeleton", "data": flat, "t_recv": 17},
        {"channel": "embedding", "shape": [18, 3], "data": flat, "t_recv": 18},
        {"channel": "SKELETON", "shape": [18, 3], "data": flat, "t_recv": 19},
    ]
    with tempfile.TemporaryDirectory(prefix="hydra-skeleton-recordings-") as directory:
        path = Path(directory) / "body.jsonl"
        path.write_text("\n".join(json.dumps(message) for message in messages) + "\n")
        library = RecordingLibrary(Path(directory))
        channels = {channel["id"]: channel for channel in library.summary()["recordings"][0]["channels"]}
        fields = {field["id"]: field for field in channels["skeleton"]["fields"]}
        assert len(fields) == 80
        expected = {f"skeleton:{joint}:{axis}" for joint in SKELETON_JOINTS for axis in ("x", "y", "z")}
        expected |= SKELETON_MOTION_IDS
        assert set(fields) == expected | {"data"}
        wrist = fields["skeleton:right_wrist:z"]
        assert wrist["name"] == wrist["label"] == "Right wrist Z (up)"
        assert wrist["kind"] == "position" and wrist["unit"] == "m"
        assert wrist["reducers"] == ["value"] and wrist["default_reducer"] == "value"
        assert wrist["skeletonLevel"] == "axis"
        assert fields["data"]["skeletonLevel"] == "raw"
        for identifier, label, level in (
            ("skeleton:region:whole_body:speed", "Whole body movement", "region"),
            ("skeleton:region:left_arm:speed", "Left arm movement", "region"),
            ("skeleton:right_wrist:speed", "Right wrist movement", "joint"),
        ):
            field = fields[identifier]
            assert field["name"] == field["label"] == label
            assert field["kind"] == "motion" and field["unit"] == "m/s"
            assert field["reducers"] == ["value"] and field["default_reducer"] == "value"
            assert field["skeletonLevel"] == level
        assert fields["skeleton:nose:x"]["name"] == "Nose X (forward)"
        assert fields["skeleton:left_ear:y"]["name"] == "Left ear Y (left)"
        for channel in ("embedding", "SKELETON"):
            assert [field["id"] for field in channels[channel]["fields"]] == ["data"]
        sources = [{"channel": "skeleton", "field": f"skeleton:right_wrist:{axis}", "reducer": "value"}
                   for axis in ("x", "y", "z")]
        x, y, z = library.series_batch("body", sources)
        assert [point[1] for point in x["points"]] == [13, 113, 0, 13]
        assert [point[1] for point in y["points"]] == [14, 114, 14, 14]
        assert [point[1] for point in z["points"]] == [15, 115, 15, 15]
        assert x["source_points"] == 4 and x["end_time_seconds"] == 17
        nose = library.series("body", "skeleton", "skeleton:nose:x", reducer="value")
        assert nose["source_points"] == 6, "missing wrist tracking must not hide other joints"
        raw = library.series("body", "skeleton", "data", reducer="index", index=12)
        assert raw["points"][1][1] == 113, "nested skeleton data must retain the original array mapping"
        assert raw["source_points"] == 8, "raw data remains available even when the body contract does not match"

    # Shapes are validated before flattening so accidental tensors cannot be
    # labelled as body coordinates, even when they contain exactly 54 values.
    for data in (flat[:-1], [flat], [[1] * 6] * 9, [[1, 2, [3]]] * 18):
        assert _skeleton_values({"channel": "skeleton", "data": data}) is None
    for shape in (None, [], [3, 18], [54, 1], "18,3"):
        assert _skeleton_values({"channel": "skeleton", "data": flat, "shape": shape}) is None
    assert _skeleton_values({"channel": "skeleton", "data": nested}) == [value + 100 for value in flat]
    for invalid_value in (None, True, "3", float("nan"), float("inf")):
        invalid_joint = flat.copy()
        invalid_joint[13] = invalid_value
        frame = {"channel": "skeleton", "data": invalid_joint}
        for axis in ("x", "y", "z"):
            assert RecordingLibrary._extract_value(frame, f"skeleton:right_wrist:{axis}", "value", 0) is None
        assert RecordingLibrary._extract_value(frame, "skeleton:left_wrist:x", "value", 0) == 22

    invalid_early = flat.copy()
    invalid_early[0] = None
    frame = {"channel": "skeleton", "data": invalid_early}
    assert RecordingLibrary._extract_value(frame, "data", "index", 14) == 15
    assert RecordingLibrary._extract_value(frame, "data", "index", 0) is None
    assert RecordingLibrary._extract_value(frame, "skeleton:left_ear:z", "value", 0) == 54

    fields = OrderedDict()
    frame = {"channel": "skeleton", "data": flat, "labels": [f"legacy_{index}" for index in range(54)]}
    RecordingLibrary._discover_fields(fields, frame)
    assert "data" in fields and "data:12" in fields and "skeleton:right_wrist:x" in fields
    assert fields["data:12"]["label"] == "legacy_12"
    assert fields["data:12"]["skeletonLevel"] == "raw"
    fields = OrderedDict((f"existing:{index}", {}) for index in range(MAX_FIELDS_PER_CHANNEL - 1))
    RecordingLibrary._discover_fields(fields, {**frame, "velocity": [1, 2]})
    assert len(fields) == MAX_FIELDS_PER_CHANNEL

    nested_flat = [flat[index:index + 3] for index in range(0, 54, 3)]
    nested_frame = {**frame, "data": nested_flat}
    fields = OrderedDict()
    RecordingLibrary._discover_fields(fields, nested_frame)
    assert len(fields) == 134 and fields["data:14"]["label"] == "legacy_14"
    assert RecordingLibrary._extract_value(nested_frame, "data:14", "value", 0) == 15
    assert RecordingLibrary._extract_value(nested_frame, "data:53", "value", 0) == 54
    fields = OrderedDict()
    joint_labels_frame = {**nested_frame, "labels": list(SKELETON_JOINTS)}
    RecordingLibrary._discover_fields(fields, joint_labels_frame)
    assert set(fields) == expected | {"data"}, "18 joint labels must not become 18 scalar coordinates"
    fields = OrderedDict()
    RecordingLibrary._discover_fields(fields, {**joint_labels_frame, "channel": "unrelated"})
    assert set(fields) == {f"data:{index}" for index in range(18)}, "unrelated recording discovery must stay unchanged"


def check_skeleton_movement() -> None:
    wrist_id = "skeleton:right_wrist:speed"
    arm_id = "skeleton:region:right_arm:speed"
    whole_id = "skeleton:region:whole_body:speed"

    def frame(timestamp, changes=None, **metadata):
        joints = [[2.0, float(index + 1), 1.0] for index in range(18)]
        for index, coordinates in (changes or {}).items():
            joints[index] = coordinates
        return {"channel": "skeleton", "shape": [18, 3], "data": joints,
                **({"t_recv": timestamp} if timestamp is not None else {}), **metadata}

    motion = _SkeletonMotion()
    assert motion.step(frame(10), 10) == {}, "the first frame establishes a baseline"
    values = motion.step(frame(10.25, {4: [2.75, 6, 1]}), 10.25)
    assert values[wrist_id] == 5, "XYZ distance of 1.25m over .25s is 5m/s"
    assert math.isclose(values[arm_id], 5 / 3)
    assert math.isclose(values[whole_id], 5 / 18)
    assert values["skeleton:left_wrist:speed"] == 0
    assert len(values) == len(SKELETON_MOTION_IDS)
    assert all(value == 0 for value in motion.step(frame(10.5, {4: [2.75, 6, 1]}), 10.5).values())

    motion = _SkeletonMotion()
    motion.step(frame(0), 0)
    opposite = motion.step(frame(.25, {2: [3, 3, 1], 4: [1, 5, 1]}), .25)
    assert math.isclose(opposite[arm_id], 8 / 3), "opposite joint directions must not cancel"
    assert opposite["skeleton:region:head:speed"] == 0
    assert len(SKELETON_REGIONS) == 7

    # Missing joints cannot produce a speed until two adjacent valid frames;
    # other tracked joints and the remaining region members continue working.
    for missing in ([0, 0, 0], [2, None, 1], [2, float("nan"), 1]):
        motion = _SkeletonMotion()
        motion.step(frame(0), 0)
        values = motion.step(frame(.1, {4: missing, 3: [2.1, 4, 1]}), .1)
        assert wrist_id not in values and math.isclose(values[arm_id], .5)
        values = motion.step(frame(.2, {4: [100, 5, 1], 3: [2.2, 4, 1]}), .2)
        assert wrist_id not in values and math.isclose(values[arm_id], .5)
        values = motion.step(frame(.3, {4: [100.1, 5, 1], 3: [2.3, 4, 1]}), .3)
        assert math.isclose(values[wrist_id], 1)
    motion = _SkeletonMotion()
    motion.step(frame(0), 0)
    missing_body = {index: [0, 0, 0] for index in range(18)}
    assert motion.step(frame(.1, missing_body), .1) == {}
    assert motion.step(frame(.2), .2) == {}

    for bad_timestamp in (0, -.1, 1):
        motion = _SkeletonMotion()
        motion.step(frame(0), 0)
        assert motion.step(frame(bad_timestamp, {4: [100, 5, 1]}), bad_timestamp) == {}
        values = motion.step(frame(bad_timestamp + .1, {4: [100.1, 5, 1]}), bad_timestamp + .1)
        assert math.isclose(values[wrist_id], 1), "timing discontinuities establish a new baseline"
    motion = _SkeletonMotion()
    motion.step(frame(0), 0)
    assert motion.step(frame(.0001, {4: [100, 5, 1]}), .0001) == {}
    values = motion.step(frame(.1, {4: [2.1, 5, 1]}), .1)
    assert math.isclose(values[wrist_id], 1), "near-identical timestamps retain the preceding useful baseline"
    motion = _SkeletonMotion()
    motion.step(frame(0), 0)
    motion.step(frame(.0001, {4: [0, 0, 0]}), .0001)
    assert wrist_id not in motion.step(frame(.1, {4: [100, 5, 1]}), .1)

    for invalid_frame, timestamp in ((frame(None), None), (frame(.1, shape=[3, 18]), .1)):
        motion = _SkeletonMotion()
        motion.step(frame(0), 0)
        assert motion.step(invalid_frame, timestamp) == {}
        assert motion.step(frame(.2), .2) == {}
        assert motion.step(frame(.3), .3)[wrist_id] == 0

    motion = _SkeletonMotion()
    motion.step(frame(0), 0)
    assert motion.step(frame(None, {4: [100, 5, 1]}, stamp=.1), .1) == {}, "different timestamp clocks must not be joined"
    assert math.isclose(motion.step(frame(None, {4: [100.1, 5, 1]}, stamp=.2), .2)[wrist_id], 1)
    assert motion.step(frame(.3), .3) == {}, "switching back to receipt timestamps also resets the baseline"
    assert motion.step(frame(.4), .4)[wrist_id] == 0
    motion = _SkeletonMotion()
    assert motion.step(frame(None), 0) == {}
    assert motion.step(frame(None), .1)[wrist_id] == 0, "a caller-supplied clock is consistent when message timestamps are absent"

    # A batched recording scan derives every original frame once, before
    # downsampling; movement in alternating directions remains visible.
    messages = [frame(index * .1, {4: [2.1 if index % 2 else 2, 5, 1]}) for index in range(80)]
    messages[1]["data"] = [value for joint in messages[1]["data"] for value in joint]
    with tempfile.TemporaryDirectory(prefix="hydra-skeleton-motion-") as directory:
        path = Path(directory) / "motion.jsonl"
        path.write_text("\n".join(json.dumps(message) for message in messages) + "\n")
        library = RecordingLibrary(Path(directory))
        requests = [{"channel": "skeleton", "field": identifier, "reducer": "value", "limit": 32}
                    for identifier in (wrist_id, arm_id, whole_id)]
        with patch.object(_SkeletonMotion, "step", autospec=True, side_effect=_SkeletonMotion.step) as step:
            wrist, arm, whole = library.series_batch("motion", requests)
            assert step.call_count == 80, "compute one motion vector per frame, not per requested field"
        assert wrist["source_points"] == 79 and len(wrist["points"]) == 32
        assert math.isclose(wrist["start_time_seconds"], .1)
        assert math.isclose(wrist["end_time_seconds"], 7.9)
        assert all(math.isclose(point[1], 1) for point in wrist["points"])
        assert all(math.isclose(point[1], 1 / 3) for point in arm["points"])
        assert all(math.isclose(point[1], 1 / 18) for point in whole["points"])

        for message in messages:
            message["stamp"] = message.pop("t_recv")
        path.write_text("\n".join(json.dumps(message) for message in messages) + "\n")
        library.refresh()
        stamped = library.series("motion", "skeleton", wrist_id, "value", limit=32)
        assert stamped["points"] == wrist["points"] and stamped["source_points"] == 79

        # Without source timestamps, position is still available but a speed
        # cannot be stated in m/s using an invented sample counter.
        path.write_text("\n".join(json.dumps(frame(None, {4: [value, 5, 1]})) for value in (2, 3, 4)) + "\n")
        library.refresh()
        assert library.series("motion", "skeleton", "skeleton:right_wrist:x", "value")["source_points"] == 3
        try:
            library.series("motion", "skeleton", wrist_id, "value")
        except ValueError as error:
            assert str(error) == "series_empty"
        else:
            raise AssertionError("untimed movement received invented speeds")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="hydra-recordings-") as directory:
        path = Path(directory) / "sample.jsonl.txt"
        messages = [
            {
                "channel": "robot_joint_states",
                "labels": ["joint_1", "joint_2"],
                "data": [1.0, 2.0],
                "velocity": [0.1, 0.2],
                "t_recv": 10.0,
            },
            {
                "channel": "activation_energy",
                "tensors": {
                    "encoder_out_norm": {"shape": [2], "data": [3.0, 4.0]}
                },
                "t_recv": 10.5,
            },
            {
                "channel": "activation_energy",
                "tensors": {
                    "encoder_out_norm": {"shape": [2], "data": [5.0, 7.0]}
                },
                "t_recv": 11.0,
            },
        ]
        path.write_text("\n".join(json.dumps(message) for message in messages) + "\n")
        library = RecordingLibrary(Path(directory))
        summary = library.summary()
        assert summary["available"] is True
        assert len(summary["recordings"]) == 1
        recording = summary["recordings"][0]
        assert recording["id"] == "sample"
        assert recording["frames"] == 3
        assert recording["duration_seconds"] == 1.0
        assert recording["start_time_seconds"] == 10.0
        assert recording["end_time_seconds"] == 11.0
        assert {channel["id"] for channel in recording["channels"]} == {
            "robot_joint_states",
            "activation_energy",
        }
        position = library.series(
            "sample", "robot_joint_states", "data:1", reducer="value", limit=32
        )
        assert position["points"][0][1] == 2.0
        assert position["start_time_seconds"] == position["end_time_seconds"] == 10.0
        assert position["duration_seconds"] == 0.0
        energy = library.series(
            "sample",
            "activation_energy",
            "tensor:encoder_out_norm",
            reducer="mean",
            limit=32,
        )
        assert [point[1] for point in energy["points"]] == [3.5, 6.0]
        assert energy["minimum"] == 3.5
        assert energy["maximum"] == 6.0

        compressed_path = Path(directory) / "compressed.jsonl.gz"
        with gzip.open(compressed_path, "wt", encoding="utf-8") as stream:
            for message in messages:
                stream.write(json.dumps(message) + "\n")
        library.refresh()
        compressed = next(
            item
            for item in library.summary()["recordings"]
            if item["id"] == "compressed"
        )
        assert compressed["compressed"] is True
        compressed_energy = library.series(
            "compressed",
            "activation_energy",
            "tensor:encoder_out_norm",
            reducer="mean",
            limit=32,
        )
        assert [point[1] for point in compressed_energy["points"]] == [3.5, 6.0]

        library.series_cache.clear()
        sources = [
            {"channel": "robot_joint_states", "field": "data:1", "reducer": "value"},
            {"channel": "activation_energy", "field": "tensor:encoder_out_norm", "reducer": "mean"},
        ]
        with patch("recording_library.open_recording", wraps=open_recording) as opener:
            batch = library.series_batch("compressed", sources + [sources[0]])
            assert opener.call_count == 1, "a complete mapping set should scan the recording once"
            assert batch[0]["points"][0][1] == 2.0
            assert [point[1] for point in batch[1]["points"]] == [3.5, 6.0]
            assert batch[0] is batch[2]
            assert library.series_batch("compressed", sources)[0] is batch[0]
            assert opener.call_count == 1, "cached batch requests should not reread the recording"
        for invalid in ([], [sources[0]] * 193, [None], [{**sources[0], "index": float("inf")}], [{**sources[0], "channel": []}]):
            try:
                library.series_batch("compressed", invalid)
            except ValueError:
                pass
            else:
                raise AssertionError("invalid series batch was accepted")

        # Sources with different start times and durations must retain their
        # relative timing, even though each source's points use local 0..1 progress.
        staggered_path = Path(directory) / "staggered.jsonl"
        staggered_messages = [
            {"channel": "arm", "labels": ["joint"], "data": [0], "t_recv": 100.0},
            {"channel": "leg", "labels": ["joint"], "data": [2], "stamp": 100.25},
            {"channel": "arm", "labels": ["joint"], "data": [1], "t_recv": 100.5},
            {"channel": "leg", "labels": ["joint"], "data": [3], "stamp": 100.75},
            {"channel": "arm", "labels": ["joint"], "data": [2], "t_recv": 101.0},
        ]
        staggered_path.write_text("\n".join(json.dumps(message) for message in staggered_messages) + "\n")
        library.refresh()
        aligned_sources = [{"channel": channel, "field": "data:0", "reducer": "value"}
                           for channel in ("arm", "leg")]
        arm, leg = library.series_batch("staggered", aligned_sources)
        assert (arm["start_time_seconds"], arm["end_time_seconds"], arm["duration_seconds"]) == (100.0, 101.0, 1.0)
        assert (leg["start_time_seconds"], leg["end_time_seconds"], leg["duration_seconds"]) == (100.25, 100.75, 0.5)
        assert [point[0] for point in arm["points"]] == [0, 0.5, 1]
        assert [point[0] for point in leg["points"]] == [0, 1]
        origin = min(arm["start_time_seconds"], leg["start_time_seconds"])
        assert [[series["start_time_seconds"] - origin + point[0] * series["duration_seconds"]
                 for point in series["points"]] for series in (arm, leg)] == [[0, 0.5, 1], [0.25, 0.75]]
        assert library.series_batch("staggered", aligned_sources)[1] is leg
    check_skeleton_recordings()
    check_skeleton_movement()
    print("recording library tests: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
