#!/usr/bin/env python3
"""Unit checks for bounded RAPP JSONL discovery and reduction."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
import tempfile
from unittest.mock import patch

from recording_library import RecordingLibrary, open_recording


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
    print("recording library tests: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
