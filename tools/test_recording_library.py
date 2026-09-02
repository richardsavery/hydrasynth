#!/usr/bin/env python3
"""Unit checks for bounded RAPP JSONL discovery and reduction."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
import tempfile

from recording_library import RecordingLibrary


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
    print("recording library tests: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
