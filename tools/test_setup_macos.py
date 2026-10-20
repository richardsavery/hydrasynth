#!/usr/bin/env python3
"""Exercise Mac setup with process shims; never install packages or use hardware."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


TOOLS = Path(__file__).resolve().parent

# Run the actual Bash control flow, replacing only external commands and absolute
# Homebrew installation locations. This also works on Linux development machines.
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
    if not path.exists():
        path.symlink_to(root / "bin" / "dispatch")

failure = os.environ.get("SETUP_FIXTURE_FAILURE", "")
prefix = root / "brew prefix"
if name == "uname":
    print(os.environ.get("SETUP_FIXTURE_OS", "Darwin"))
elif name == "xcrun":
    assert args == ["--find", "clang"]
    finish(1 if os.environ.get("SETUP_FIXTURE_CLT") == "missing" else 0)
elif name == "xcode-select":
    assert args == ["--install"]
    finish(19 if failure == "clt" else 0)
elif name == "curl":
    assert "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh" in args
    if failure == "bootstrap-download":
        finish(20)
    destination = Path(args[args.index("--output") + 1])
    if failure == "bootstrap-install":
        destination.write_text("exit 21\n", encoding="utf-8")
    elif failure == "bootstrap-no-brew":
        destination.write_text("exit 0\n", encoding="utf-8")
    else:
        # The download fixture is a real shell script executed by /bin/bash.
        destination.write_text(
            '#!/bin/bash\nmkdir -p "$SETUP_FIXTURE_ROOT/apple brew/bin"\n'
            'ln -s "$SETUP_FIXTURE_ROOT/bin/dispatch" "$SETUP_FIXTURE_ROOT/apple brew/bin/brew"\n',
            encoding="utf-8")
elif name == "brew":
    if args == ["--prefix"]:
        print(prefix)
    elif args == ["--prefix", "python@3.12"]:
        print(prefix / "opt/python@3.12")
    elif args[:2] == ["list", "--versions"]:
        missing = os.environ.get("SETUP_FIXTURE_MISSING", "").split(",")
        finish(1 if args[2] in missing else 0)
    elif args[0] == "install":
        assert args in (["install", "ffmpeg"],
                        ["install", "--skip-link", "python@3.12"],
                        ["install", "python@3.12"])
        if failure == "brew":
            finish(23)
        if "python@3.12" in args:
            if (os.environ.get("SETUP_FIXTURE_PYTHON_LINK_CONFLICT") == "1" and
                    "--skip-link" not in args):
                finish(22)
            link_command(prefix / "opt/python@3.12/bin/python3.12")
        if "ffmpeg" in args:
            for tool in ("ffmpeg", "ffprobe"):
                link_command(prefix / "bin" / tool)
    else:
        raise AssertionError("Unexpected Homebrew operation: " + repr(args))
elif name in ("python-bootstrap", "python3.12", "python"):
    if args[0] == "-c":
        if "model_files_available" in args[1]:
            finish(0 if (root / "var/whisper/small/model.bin").is_file() else 1)
        finish(1 if failure == "python-version" else 0)
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
        check = sys.stdin.read()
        assert 'WhisperSmallTranscriber("var/whisper/small")._load()' in check
        if failure == "model-load":
            finish(26)
        assert (root / "var/whisper/small/model.bin").is_file()
        print("Local transcription model is ready.")
    elif args[0] == "tools/configure_api_key.py":
        finish(subprocess.run([sys.executable, *args], check=False).returncode)
    else:
        raise AssertionError("Unexpected Python invocation: " + repr(args))
elif name == "make":
    if failure == "build":
        finish(27)
    for command in ("hydractl", "hydra-audio"):
        link_command(root / "build" / command)
elif name in ("hydractl", "hydra-audio"):
    assert args == ["self-test"]
    if failure == name:
        finish(28)
elif name not in ("cc", "ffmpeg", "ffprobe"):
    raise AssertionError("Unexpected command: " + name)
'''


@unittest.skipIf(os.name == "nt" or (hasattr(os, "geteuid") and os.geteuid() == 0),
                 "The installer requires Bash and intentionally rejects root.")
class SetupMacOSTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="hydra-mac-setup-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "laptop checkout"
        self.root.mkdir()
        (self.root / "tools").mkdir()
        source = (TOOLS / "setup_macos.sh").read_text(encoding="utf-8")
        # Model macOS's fixed Homebrew locations inside a disposable directory.
        # Only filesystem paths change; every command and branch stays original.
        for original, fixture in (("/opt/homebrew/bin/brew", "apple brew/bin/brew"),
                                  ("/usr/local/bin/brew", "intel brew/bin/brew")):
            self.assertEqual(source.count(original), 2)
            source = source.replace(original, '"' + str(self.root / fixture) + '"')
        (self.root / "tools/setup_macos.sh").write_text(source, encoding="utf-8")
        shutil.copy2(TOOLS / "configure_api_key.py", self.root / "tools/configure_api_key.py")
        for name in ("requirements-robot.txt", "requirements-rap-response.txt", "Makefile"):
            (self.root / name).write_text("# fixture\n", encoding="utf-8")
        binary = self.root / "bin"
        binary.mkdir()
        dispatch = binary / "dispatch"
        dispatch.write_text("#!" + sys.executable + "\n" + DISPATCH, encoding="utf-8")
        dispatch.chmod(0o755)
        for name in ("uname", "xcrun", "xcode-select", "curl", "make", "cc",
                     "ffmpeg", "ffprobe", "python-bootstrap", "brew"):
            (binary / name).symlink_to(dispatch)
        self.prefix = self.root / "brew prefix"
        (self.prefix / "bin").mkdir(parents=True)
        python = self.prefix / "opt/python@3.12/bin/python3.12"
        python.parent.mkdir(parents=True)
        python.symlink_to(dispatch)
        self.log = self.root / "calls.jsonl"
        self.log.touch()
        self.env = {
            "PATH": str(binary) + os.pathsep + "/usr/bin:/bin",
            "SETUP_FIXTURE_ROOT": str(self.root),
            "SETUP_FIXTURE_LOG": str(self.log),
            "LANG": "C",
            "TMPDIR": str(self.root),
        }

    def run_setup(self, *arguments, **environment):
        return subprocess.run(
            ["/bin/bash", str(self.root / "tools/setup_macos.sh"), *arguments],
            cwd=self.directory.name, env={**self.env, **environment},
            input="", text=True, capture_output=True, timeout=30,
        )

    def calls(self, command=None):
        entries = [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]
        return [entry for entry in entries if command is None or entry["command"] == command]

    def python_calls(self):
        return [entry["args"] for entry in self.calls()
                if entry["command"] in ("python", "python-bootstrap", "python3.12")]

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

    def test_fresh_install_builds_native_tools_and_loads_whisper(self):
        result = self.run_setup(SETUP_FIXTURE_MISSING="ffmpeg,python@3.12")
        self.assert_success(result)
        installs = [call["args"] for call in self.calls("brew") if call["args"][0] == "install"]
        self.assertEqual(installs, [["install", "ffmpeg"],
                                   ["install", "--skip-link", "python@3.12"]])
        self.assertIn(["-m", "venv", ".venv"], self.python_calls())
        self.assertEqual(len(self.calls("python3.12")), 2)
        self.assert_upgrade()
        self.assertEqual(len(self.calls("make")), 1)
        self.assertEqual(len(self.calls("hydractl")), 1)
        self.assertEqual(len(self.calls("hydra-audio")), 1)
        self.assertIn(["tools/prepare_rap_transcription.py"], self.python_calls())
        self.assertIn(["-"], self.python_calls())
        self.assertIn(["tools/configure_api_key.py"], self.python_calls())
        self.assertFalse((self.root / ".env").exists())
        self.assertTrue((self.root / "var/whisper/small/model.bin").is_file())

    def test_update_preserves_venv_model_key_and_recordings(self):
        self.assert_success(self.run_setup())
        marker = self.root / ".venv/preserve-existing-venv"
        marker.write_text("keep", encoding="utf-8")
        key = self.root / ".env"
        key.write_text("ELEVENLABS_API_KEY=fixture-existing-key\nOTHER=value\n", encoding="utf-8")
        data = self.root / "var/study-data/recording.wav"
        data.parent.mkdir(parents=True)
        data.write_bytes(b"fixture recording")
        model = self.root / "var/whisper/small/model.bin"
        preserved = {path: path.read_bytes() for path in (key, data, model, marker)}
        self.log.write_text("", encoding="utf-8")

        result = self.run_setup(PYTHON="/missing/not-needed-for-update",
                                SETUP_FIXTURE_MISSING="python@3.12")
        self.assert_success(result)
        self.assert_upgrade()
        self.assertNotIn(["-m", "venv", ".venv"], self.python_calls())
        self.assertNotIn(["tools/prepare_rap_transcription.py"], self.python_calls())
        self.assertIn(["-"], self.python_calls())
        self.assertFalse(any(call["args"][0] == "install" for call in self.calls("brew")))
        self.assertIn("Existing API key kept", result.stdout)
        self.assertNotIn("fixture-existing-key", result.stdout + result.stderr)
        for path, content in preserved.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(key.stat().st_mode & 0o777, 0o600)

    def test_python_install_does_not_replace_another_installations_global_tools(self):
        existing = self.prefix / "bin/python3.12"
        existing.write_text("#!/bin/sh\n# Existing python.org installation\nexit 89\n",
                            encoding="utf-8")
        existing.chmod(0o755)
        original = existing.read_bytes()
        result = self.run_setup("--skip-model", "--no-key",
                                SETUP_FIXTURE_MISSING="python@3.12",
                                SETUP_FIXTURE_PYTHON_LINK_CONFLICT="1")
        self.assert_success(result)
        self.assertEqual(existing.read_bytes(), original)
        self.assertIn({"command": "brew", "args": ["install", "--skip-link", "python@3.12"]},
                      self.calls("brew"))
        self.assertIn(str(self.prefix / "opt/python@3.12/bin/python3.12"), result.stdout)

    def test_default_brew_discovery_for_apple_silicon_and_intel(self):
        (self.root / "bin/brew").unlink()
        for location in ("apple brew/bin/brew", "intel brew/bin/brew"):
            with self.subTest(location=location):
                brew = self.root / location
                brew.parent.mkdir(parents=True, exist_ok=True)
                brew.symlink_to(self.root / "bin/dispatch")
                self.assert_success(self.run_setup("--skip-model", "--no-key"))
                self.assertEqual(self.calls("curl"), [])
                brew.unlink()

    def test_brew_prefix_exposes_new_ffmpeg_without_shell_profile_changes(self):
        # ffmpeg must be provided from the discovered prefix, even though it was
        # absent from the original PATH. Hide host binaries behind a minimal PATH.
        for tool in ("ffmpeg", "ffprobe"):
            (self.root / "bin" / tool).unlink()
        for tool in ("dirname", "mkdir", "rm", "ln"):
            (self.root / "bin" / tool).symlink_to(shutil.which(tool))
        result = self.run_setup("--skip-model", "--no-key",
                                PATH=str(self.root / "bin"),
                                SETUP_FIXTURE_MISSING="ffmpeg")
        self.assert_success(result)
        self.assertTrue((self.prefix / "bin/ffmpeg").exists())
        for tool in ("ffmpeg", "ffprobe"):
            local = self.root / "var/bin" / tool
            self.assertEqual(local.resolve(), (self.prefix / "bin" / tool).resolve())
            # Future app launches do not inherit setup's PATH.
            result = subprocess.run([str(local)], env=self.env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_existing_local_audio_tools_are_kept_and_broken_links_repaired(self):
        local = self.root / "var/bin"
        local.mkdir(parents=True)
        custom = local / "ffmpeg"
        custom.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        custom.chmod(0o755)
        (local / "ffprobe").symlink_to(self.root / "missing-old-install/ffprobe")
        self.assert_success(self.run_setup("--skip-model", "--no-key"))
        self.assertFalse(custom.is_symlink())
        self.assertEqual(custom.read_text(encoding="utf-8"), "#!/bin/sh\nexit 0\n")
        self.assertEqual((local / "ffprobe").resolve(), (self.root / "bin/ffprobe").resolve())

    def test_missing_brew_bootstraps_and_cleans_download(self):
        (self.root / "bin/brew").unlink()
        result = self.run_setup("--skip-model", "--no-key")
        self.assert_success(result)
        self.assertEqual(len(self.calls("curl")), 1)
        self.assertTrue((self.root / "apple brew/bin/brew").exists())
        self.assertEqual(list(self.root.glob("hydrasynth-homebrew.*")), [])

    def test_failed_brew_bootstrap_stops_and_cleans_download(self):
        (self.root / "bin/brew").unlink()
        for failure in ("bootstrap-download", "bootstrap-install", "bootstrap-no-brew"):
            with self.subTest(stage=failure):
                self.log.write_text("", encoding="utf-8")
                result = self.run_setup(SETUP_FIXTURE_FAILURE=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Setup complete.", result.stdout)
                self.assertEqual(self.python_calls(), [])
                self.assertEqual(list(self.root.glob("hydrasynth-homebrew.*")), [])

    def test_missing_command_line_tools_launches_prompt_then_requires_rerun(self):
        result = self.run_setup(SETUP_FIXTURE_CLT="missing")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.calls("xcode-select")), 1)
        self.assertIn("Finish the Command Line Tools installation window", result.stderr)
        self.assertNotIn("Setup complete.", result.stdout)
        self.assertEqual(self.calls("brew"), [])
        self.assertEqual(self.calls("curl"), [])
        self.assertEqual(self.python_calls(), [])

    def test_failed_command_line_tools_prompt_is_reported(self):
        result = self.run_setup(SETUP_FIXTURE_CLT="missing", SETUP_FIXTURE_FAILURE="clt")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not open Apple's installer", result.stderr)
        self.assertEqual(self.python_calls(), [])

    def test_skip_system_never_launches_command_line_tools_install(self):
        result = self.run_setup("--skip-system", SETUP_FIXTURE_CLT="missing")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls("xcode-select"), [])
        self.assertEqual(self.calls("brew"), [])

    def test_explicit_python_avoids_installing_homebrew_python(self):
        result = self.run_setup(PYTHON=str(self.root / "bin/python-bootstrap"),
                                SETUP_FIXTURE_MISSING="python@3.12")
        self.assert_success(result)
        self.assertEqual(len(self.calls("python-bootstrap")), 2)
        self.assertFalse(any("python@3.12" in call["args"] for call in self.calls("brew")))

    def test_skip_options_with_explicit_python_need_no_homebrew(self):
        (self.root / "bin/brew").unlink()
        result = self.run_setup("--skip-system", "--skip-model", "--no-key",
                                PYTHON=str(self.root / "bin/python-bootstrap"))
        self.assert_success(result)
        self.assertEqual(self.calls("brew"), [])
        self.assertEqual(self.calls("curl"), [])
        self.assert_upgrade()
        self.assertNotIn(["tools/prepare_rap_transcription.py"], self.python_calls())
        self.assertNotIn(["-"], self.python_calls())
        self.assertNotIn(["tools/configure_api_key.py"], self.python_calls())

    def test_skip_system_without_python_or_brew_gives_actionable_error(self):
        (self.root / "bin/brew").unlink()
        result = self.run_setup("--skip-system")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("set PYTHON=/path/to/python3", result.stderr)
        self.assertEqual(self.calls("curl"), [])

    def test_existing_model_is_still_loaded_on_update(self):
        self.assert_success(self.run_setup())
        self.log.write_text("", encoding="utf-8")
        result = self.run_setup(SETUP_FIXTURE_FAILURE="model-load")
        self.assertEqual(result.returncode, 26)
        self.assertNotIn("Setup complete.", result.stdout)
        self.assertNotIn(["tools/prepare_rap_transcription.py"], self.python_calls())
        self.assertNotIn(["tools/configure_api_key.py"], self.python_calls())

    def test_external_failures_stop_without_reporting_success(self):
        for failure in ("brew", "pip", "build", "hydractl", "hydra-audio", "download"):
            with self.subTest(stage=failure):
                self.log.write_text("", encoding="utf-8")
                result = self.run_setup(SETUP_FIXTURE_FAILURE=failure,
                                        SETUP_FIXTURE_MISSING="ffmpeg")
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Setup complete.", result.stdout)
                self.assertNotIn(["tools/configure_api_key.py"], self.python_calls())
                if failure in ("brew", "pip"):
                    self.assertEqual(self.calls("make"), [])
                self.assertNotIn(["-"], self.python_calls())

    def test_broken_existing_environment_is_left_intact(self):
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

    def test_unsuitable_python_stops_before_install_or_build(self):
        result = self.run_setup("--skip-system", SETUP_FIXTURE_FAILURE="python-version")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Python 3.10 or newer is required", result.stderr)
        self.assertEqual(self.calls("make"), [])
        self.assertNotIn(["-m", "venv", ".venv"], self.python_calls())

    def test_unknown_options_and_help_do_not_install_anything(self):
        for arguments in (("--help",), ("--unknown-option",)):
            with self.subTest(arguments=arguments):
                result = self.run_setup(*arguments)
                self.assertEqual(result.returncode, 0 if arguments == ("--help",) else 1)
                self.assertIn("Usage:", result.stdout + result.stderr)
                self.assertEqual(self.calls(), [])


@unittest.skipIf(os.name == "nt", "The dispatcher requires Bash.")
class SetupDispatcherTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="hydra-dispatch-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "checkout with spaces"
        self.tools = self.root / "tools"
        self.tools.mkdir(parents=True)
        shutil.copy2(TOOLS / "setup.sh", self.tools / "setup.sh")
        for platform in ("macos", "linux"):
            (self.tools / ("setup_" + platform + ".sh")).write_text(
                '#!/usr/bin/env bash\nprintf "%s\\n" "' + platform +
                '" "$@"\nexit "${DISPATCH_EXIT:-0}"\n', encoding="utf-8")
        binary = self.root / "bin"
        binary.mkdir()
        uname = binary / "uname"
        uname.write_text('#!/bin/sh\nprintf "%s\\n" "$DISPATCH_OS"\n', encoding="utf-8")
        uname.chmod(0o755)
        self.env = {"PATH": str(binary) + ":/usr/bin:/bin", "LANG": "C"}

    def run_setup(self, platform, *arguments, **environment):
        return subprocess.run(
            ["/bin/bash", str(self.tools / "setup.sh"), *arguments],
            cwd=self.directory.name, env={**self.env, "DISPATCH_OS": platform, **environment},
            text=True, capture_output=True, timeout=10,
        )

    def test_mac_and_linux_forward_arguments_and_exit_status(self):
        for platform, script in (("Darwin", "macos"), ("Linux", "linux")):
            with self.subTest(platform=platform):
                result = self.run_setup(platform, "--skip-model", "argument with spaces",
                                        DISPATCH_EXIT="17")
                self.assertEqual(result.returncode, 17)
                self.assertEqual(result.stdout.splitlines(),
                                 [script, "--skip-model", "argument with spaces"])

    def test_unsupported_platform_is_actionable(self):
        result = self.run_setup("MINGW64_NT-10.0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Native Windows is not supported", result.stderr)
        self.assertIn("Mac or Linux laptop", result.stderr)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
