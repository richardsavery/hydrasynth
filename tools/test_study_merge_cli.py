#!/usr/bin/env python3
"""Exercise the USB collection CLI with real study exports from two devices."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from study_merge import collect_export_paths
from study_recording import StudyRecorder


class StudyMergeCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.collection = self.root / "collected-laptops"
        self.collection.mkdir()
        self.command = [sys.executable, "-B", str(Path(__file__).with_name("study_merge.py"))]

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, *inputs, output=None, **kwargs):
        return subprocess.run(self.command + [str(path) for path in inputs] +
                              ["--output", str(output or self.root / "analysis")],
                              text=True, capture_output=True, **kwargs)

    def export_device(self, name):
        recorder = StudyRecorder(self.root / (name + "-data"), app_version="merge-cli-test")
        try:
            recorder.record("ui.change", {"control": "voice", "value": name})
            destination = self.collection / name / "day-1" / "backup.zip"
            destination.parent.mkdir(parents=True)
            shutil.copyfile(recorder.export().path, destination)
            return destination, recorder.device_id
        finally:
            recorder.close()

    def test_nested_devices_and_overlapping_paths_merge_once(self):
        laptop_b, device_b = self.export_device("laptop-b")
        laptop_a, device_a = self.export_device("laptop-a")
        (laptop_a.parent / "unfinished.zip.tmp").write_text("not a complete ZIP")
        (laptop_b.parent / "unfinished.zip.partial").write_text("not a complete ZIP")
        (self.collection / "notes.txt").write_text("USB collection notes")
        # Both the containing folder and one of its nested files are supplied.
        result = self.run_cli(laptop_b, self.collection, laptop_a.parent)
        self.assertEqual(result.returncode, 0, result.stderr)
        stats = json.loads(result.stdout)
        self.assertEqual(stats["new_exports"], 2)
        self.assertEqual(stats["new_events"], 2)
        self.assertEqual(stats["duplicate_events"], 0)
        with sqlite3.connect(self.root / "analysis" / "combined.sqlite3") as database:
            devices = {row[0] for row in database.execute("SELECT device_id FROM events")}
        self.assertEqual(devices, {device_a, device_b})
        again = self.run_cli(self.collection)
        self.assertEqual(again.returncode, 0, again.stderr)
        repeat_stats = json.loads(again.stdout)
        self.assertEqual(repeat_stats["new_events"], 0)
        self.assertEqual(repeat_stats["total_events"], 2)
        self.assertEqual(repeat_stats["duplicate_events"], 2)

    def test_discovery_is_sorted_and_resolves_aliases(self):
        laptop_b, _ = self.export_device("laptop-b")
        laptop_a, _ = self.export_device("laptop-a")
        alias = self.root / "alias.zip"
        alias.symlink_to(laptop_b)
        result = collect_export_paths([laptop_b, self.collection, alias, laptop_a.parent])
        self.assertEqual(result, [laptop_a.resolve(), laptop_b.resolve()])

    def test_cli_expands_home_in_quoted_input(self):
        self.export_device("laptop-a")
        # Traverse from the real home directory without changing its environment.
        quoted_input = "~/" + os.path.relpath(self.collection, Path.home())
        result = self.run_cli(quoted_input)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["new_events"], 1)

    def test_missing_input_does_not_create_false_success_or_partial_output(self):
        self.export_device("laptop-a")
        result = self.run_cli(self.collection, self.root / "missing-folder")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Study input does not exist:", result.stderr)
        self.assertIn("missing-folder", result.stderr)
        self.assertFalse((self.root / "analysis").exists())
        self.assertEqual(result.stdout, "")

    def test_empty_folder_and_unfinished_explicit_file_are_rejected(self):
        partial = self.collection / "unfinished.zip.partial"
        partial.write_text("still being written")
        result = self.run_cli(self.collection)
        self.assertEqual(result.returncode, 1)
        self.assertIn("No completed study ZIP files", result.stderr)
        self.assertFalse((self.root / "analysis").exists())
        result = self.run_cli(partial)
        self.assertEqual(result.returncode, 1)
        self.assertIn("must be a ZIP file or folder", result.stderr)


if __name__ == "__main__":
    unittest.main()
