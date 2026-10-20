#!/usr/bin/env python3
"""Run Linux setup in disposable checkouts with no network or hardware access."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


TOOLS = Path(__file__).resolve().parent

# External work is replaced at the process boundary. The real Bash installer,
# argument handling, ordering, directory checks, and key setup still execute.
DISPATCH = r'''
import json
import os
from pathlib import Path
import subprocess
import sys

name = Path(sys.argv[0]).name
args = sys.argv[1:]
root = Path(os.environ["SETUP_FIXTURE_ROOT"])
with Path(os.environ["SETUP_FIXTURE_LOG"]).open("a", encoding="utf-8") as log:
    log.write(json.dumps({"command": name, "args": args}) + "\n")

def finish(code=0):
    raise SystemExit(code)

def link_command(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.symlink_to(root / "bin" / "dispatch")

failure = os.environ.get("SETUP_FIXTURE_FAILURE", "")
if name == "uname":
    print("Linux")
elif name == "dpkg-query":
    missing = os.environ.get("SETUP_FIXTURE_MISSING", "").split(",")
    if args[-1] in missing:
        finish(1)
    print("install ok installed")
elif name == "sudo":
    finish(subprocess.run(args, check=False).returncode)
elif name == "apt-get":
    if failure == "apt" and args[0] == "install":
        finish(23)
elif name in ("python-bootstrap", "python"):
    if args[0] == "-c":
        if "model_files_available" in args[1]:
            finish(0 if (root / "var/whisper/small/model.bin").is_file() else 1)
        # Version check; don't pretend an unusable interpreter was accepted.
        finish(0 if sys.version_info >= (3, 10) else 1)
    if args[:2] == ["-m", "venv"]:
        link_command(root / args[2] / "bin/python")
    elif args[:3] == ["-m", "pip", "install"]:
        if failure == "pip":
            finish(24)
    elif args[0] == "tools/prepare_rap_transcription.py":
        if failure == "download":
            finish(25)
        model = root / "var/whisper/small/model.bin"
        model.parent.mkdir(parents=True, exist_ok=True)
        model.write_bytes(b"fixture model")
    elif args[0] == "-":
        # Confirm that the setup smoke check is still an actual model load.
        check = sys.stdin.read()
        assert 'WhisperSmallTranscriber("var/whisper/small")._load()' in check
        if failure == "model-load":
            finish(26)
        assert (root / "var/whisper/small/model.bin").is_file()
        print("Local transcription model is ready.")
    elif args[0] == "tools/configure_api_key.py":
        # Use the actual key tool against this disposable checkout.
        finish(subprocess.run([sys.executable, *args], check=False).returncode)
    else:
        raise AssertionError("Unexpected Python invocation: " + repr(args))
elif name == "make":
    if failure == "build":
        finish(27)
    for command in ("hydractl", "hydra-audio"):
        destination = root / "build" / command
        if not destination.exists():
            link_command(destination)
elif name in ("hydractl", "hydra-audio"):
    assert args == ["self-test"]
    if failure == name:
        finish(28)
elif name not in ("cc", "ffmpeg", "ffprobe"):
    raise AssertionError("Unexpected command: " + name)
'''


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() != 0,
                     "The Linux installer intentionally requires a non-root user.")
class SetupLinuxTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="hydra-setup-test-")
        self.addCleanup(self.directory.cleanup)
        # A space in the checkout path verifies shell path quoting.
        self.root = Path(self.directory.name) / "laptop checkout"
        self.root.mkdir()
        (self.root / "tools").mkdir()
        for name in ("setup_linux.sh", "configure_api_key.py"):
            shutil.copy2(TOOLS / name, self.root / "tools" / name)
        for name in ("requirements-robot.txt", "requirements-rap-response.txt", "Makefile"):
            (self.root / name).write_text("# fixture\n", encoding="utf-8")
        binary = self.root / "bin"
        binary.mkdir()
        dispatch = binary / "dispatch"
        dispatch.write_text("#!" + sys.executable + "\n" + DISPATCH, encoding="utf-8")
        dispatch.chmod(0o755)
        for name in ("uname", "dpkg-query", "apt-get", "sudo", "make", "cc",
                     "ffmpeg", "ffprobe", "python-bootstrap"):
            (binary / name).symlink_to(dispatch)
        self.log = self.root / "calls.jsonl"
        self.env = {
            "PATH": str(binary) + os.pathsep + "/usr/bin:/bin",
            "PYTHON": str(binary / "python-bootstrap"),
            "SETUP_FIXTURE_ROOT": str(self.root),
            "SETUP_FIXTURE_LOG": str(self.log),
            "LANG": "C.UTF-8",
        }

    def run_setup(self, *arguments, **environment):
        return subprocess.run(
            ["/bin/bash", str(self.root / "tools/setup_linux.sh"), *arguments],
            cwd=self.directory.name, env={**self.env, **environment},
            input="", text=True, capture_output=True, timeout=30,
        )

    def calls(self, command=None):
        entries = [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]
        return [entry for entry in entries if command is None or entry["command"] == command]

    def python_calls(self):
        return [entry["args"] for entry in self.calls() if entry["command"] in ("python", "python-bootstrap")]

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Setup complete.", result.stdout)

    def assert_upgrade(self):
        pip = [args for args in self.python_calls() if args[:3] == ["-m", "pip", "install"]]
        self.assertEqual(len(pip), 1)
        self.assertIn("--upgrade", pip[0])
        strategy = pip[0].index("--upgrade-strategy")
        self.assertEqual(pip[0][strategy + 1], "only-if-needed")
        self.assertIn("requirements-robot.txt", pip[0])
        self.assertIn("requirements-rap-response.txt", pip[0])

    def test_default_fresh_install_includes_system_native_and_whisper(self):
        result = self.run_setup(SETUP_FIXTURE_MISSING="ffmpeg,python3-venv")
        self.assert_success(result)
        self.assertEqual([call["args"] for call in self.calls("apt-get")],
                         [["update"], ["install", "-y", "--", "python3-venv", "ffmpeg"]])
        self.assertIn(["-m", "venv", ".venv"], self.python_calls())
        self.assert_upgrade()
        self.assertEqual(len(self.calls("make")), 1)
        self.assertEqual(len(self.calls("hydractl")), 1)
        self.assertEqual(len(self.calls("hydra-audio")), 1)
        self.assertIn(["tools/prepare_rap_transcription.py"], self.python_calls())
        self.assertIn(["-"], self.python_calls())
        self.assertIn(["tools/configure_api_key.py"], self.python_calls())
        self.assertFalse((self.root / ".env").exists())
        self.assertTrue((self.root / "var/whisper/small/model.bin").is_file())

    def test_rerun_updates_dependencies_reuses_model_venv_and_keeps_private_data(self):
        self.assert_success(self.run_setup())
        venv = self.root / ".venv"
        marker = venv / "preserve-existing-venv"
        marker.write_text("keep", encoding="utf-8")
        key = self.root / ".env"
        key.write_text("ELEVENLABS_API_KEY=fixture-existing-key\nOTHER=value\n", encoding="utf-8")
        data = self.root / "var/study-data/recording.wav"
        data.parent.mkdir(parents=True)
        data.write_bytes(b"fixture recording")
        model = self.root / "var/whisper/small/model.bin"
        preserved = {path: path.read_bytes() for path in (key, data, model, marker)}
        self.log.write_text("", encoding="utf-8")

        # The requested bootstrap interpreter is irrelevant for an existing venv.
        result = self.run_setup(PYTHON="/missing/not-needed-for-update")
        self.assert_success(result)
        self.assert_upgrade()
        self.assertNotIn(["-m", "venv", ".venv"], self.python_calls())
        self.assertNotIn(["tools/prepare_rap_transcription.py"], self.python_calls())
        self.assertIn(["-"], self.python_calls())
        self.assertEqual(self.calls("apt-get"), [])
        self.assertIn("Existing API key kept", result.stdout)
        self.assertNotIn("fixture-existing-key", result.stdout + result.stderr)
        for path, content in preserved.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(key.stat().st_mode & 0o777, 0o600)

    def test_existing_model_must_still_load(self):
        self.assert_success(self.run_setup())
        self.log.write_text("", encoding="utf-8")
        result = self.run_setup(SETUP_FIXTURE_FAILURE="model-load")
        self.assertEqual(result.returncode, 26)
        self.assertNotIn("Setup complete.", result.stdout)
        self.assertNotIn(["tools/prepare_rap_transcription.py"], self.python_calls())
        self.assertNotIn(["tools/configure_api_key.py"], self.python_calls())

    def test_failures_stop_setup_and_never_report_success(self):
        for failure in ("apt", "pip", "build", "hydractl", "hydra-audio", "download"):
            with self.subTest(stage=failure):
                self.log.write_text("", encoding="utf-8")
                result = self.run_setup(SETUP_FIXTURE_FAILURE=failure, SETUP_FIXTURE_MISSING="ffmpeg")
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Setup complete.", result.stdout)
                self.assertNotIn(["tools/configure_api_key.py"], self.python_calls())
                if failure in ("apt", "pip"):
                    self.assertEqual(self.calls("make"), [])
                self.assertNotIn(["-"], self.python_calls())

    def test_explicit_skip_options_do_only_requested_work(self):
        result = self.run_setup("--skip-system", "--skip-model", "--no-key")
        self.assert_success(result)
        self.assertEqual(self.calls("dpkg-query"), [])
        self.assertEqual(self.calls("sudo"), [])
        self.assert_upgrade()
        self.assertNotIn(["tools/prepare_rap_transcription.py"], self.python_calls())
        self.assertNotIn(["-"], self.python_calls())
        self.assertNotIn(["tools/configure_api_key.py"], self.python_calls())

    def test_broken_existing_venv_is_left_intact(self):
        venv = self.root / ".venv"
        venv.mkdir()
        marker = venv / "do-not-delete"
        marker.write_text("keep", encoding="utf-8")
        result = self.run_setup("--skip-system")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("existing .venv has no usable Python", result.stderr)
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep")
        self.assertEqual(self.calls("make"), [])
        self.assertEqual(self.python_calls(), [])


if __name__ == "__main__":
    unittest.main()
