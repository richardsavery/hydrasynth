#!/usr/bin/env bash
# Set up this checkout without changing existing recordings, study data or keys.
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: ./tools/setup_linux.sh [options]

Install or update Hydrasynth on an Ubuntu/Debian laptop. Run as your normal
user from any directory. The default installs system and Python dependencies,
builds native MIDI/audio tools, and downloads and checks Whisper small.
Internet access is needed to install or update dependencies and for the initial
model download. Existing .venv, model files, .env and data are retained.

Options:
  --skip-system  Do not run apt or sudo; use already installed build/audio tools.
  --skip-model   Do not download or check the local transcription model.
  --no-key       Do not prompt for an ElevenLabs API key.
  -h, --help     Show this help.

PYTHON=/path/to/python3 chooses the Python used to create a new .venv.
The default is /usr/bin/python3 (Python 3.10 or newer), bypassing asdf shims.
An existing .venv keeps its own Python. Node.js is not needed to run the app.

To update an existing installation, stop the dashboard, then run from its checkout:
  git pull --ff-only
  ./tools/setup_linux.sh
Restart the dashboard when setup completes.

With system dependencies already installed:
  ./tools/setup_linux.sh --skip-system
For a quick install without local transcription or generation credentials:
  ./tools/setup_linux.sh --skip-model --no-key
EOF
}

fail() {
    printf 'Setup failed: %s\n' "$*" >&2
    exit 1
}

skip_system=false
skip_model=false
configure_key=true
for argument in "$@"; do
    case "$argument" in
        --skip-system) skip_system=true ;;
        --skip-model) skip_model=true ;;
        --no-key) configure_key=false ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; fail "Unknown option: $argument" ;;
    esac
done

[[ "$(uname -s)" == Linux ]] || fail 'This installer is for Linux.'
(( EUID != 0 )) || fail 'Run this script as your normal user, without sudo. It requests sudo only for missing system packages.'

project_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$project_directory"
[[ -f requirements-robot.txt && -f requirements-rap-response.txt && -f requirements-beat-tracking.txt && -f Makefile ]] || fail 'The checkout is incomplete.'

if ! "$skip_system"; then
    command -v apt-get >/dev/null && command -v dpkg-query >/dev/null ||
        fail 'Automatic system setup requires Ubuntu/Debian. Install equivalent dependencies, then use --skip-system.'
    missing_packages=()
    for package in build-essential pkg-config libasound2-dev alsa-utils python3-venv ffmpeg ca-certificates; do
        if [[ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" != 'install ok installed' ]]; then
            missing_packages+=("$package")
        fi
    done
    if (( ${#missing_packages[@]} )); then
        command -v sudo >/dev/null || fail 'sudo is needed to install missing system packages; ask an administrator to install them or use --skip-system.'
        printf 'Installing missing system packages: %s\n' "${missing_packages[*]}"
        sudo apt-get update
        sudo apt-get install -y -- "${missing_packages[@]}"
    else
        printf 'System packages are already installed.\n'
    fi
fi

for required_tool in make cc ffmpeg ffprobe; do
    command -v "$required_tool" >/dev/null || fail "Missing $required_tool. Install the system dependencies listed in docs/linux.md."
done

check_python() {
    "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' ||
        fail "$2"
}

venv_python="$project_directory/.venv/bin/python"
if [[ -e .venv || -L .venv ]]; then
    [[ -x "$venv_python" ]] || fail 'The existing .venv has no usable Python. Repair it or move it aside before trying again; setup has left it intact.'
    check_python "$venv_python" 'The existing .venv requires Python 3.10 or newer. Repair it or move it aside, then rerun setup with PYTHON pointing to a suitable interpreter. Setup has left it intact.'
    printf 'Using the existing .venv.\n'
else
    setup_python="${PYTHON:-/usr/bin/python3}"
    command -v "$setup_python" >/dev/null || fail "Python not found: $setup_python"
    check_python "$setup_python" 'Python 3.10 or newer is required. Set PYTHON to a suitable interpreter when creating a new .venv.'
    printf 'Creating .venv with %s.\n' "$setup_python"
    "$setup_python" -m venv .venv
fi

printf 'Installing or updating Python dependencies.\n'
"$venv_python" -m pip install --upgrade --upgrade-strategy only-if-needed \
    -r requirements-robot.txt -r requirements-rap-response.txt -r requirements-beat-tracking.txt

printf 'Building native Linux MIDI and audio tools.\n'
make all PYTHON="$venv_python"
./build/hydractl self-test
./build/hydra-audio self-test

if ! "$skip_model"; then
    if "$venv_python" -c 'import sys; sys.path.insert(0, "tools"); from rap_transcription import model_files_available; sys.exit(0 if model_files_available("var/whisper/small") else 1)'; then
        printf 'Whisper small is already downloaded.\n'
    else
        "$venv_python" tools/prepare_rap_transcription.py
    fi
    printf 'Checking that Whisper small loads locally on this CPU.\n'
    "$venv_python" - <<'PY'
import sys
sys.path.insert(0, "tools")
from rap_transcription import TranscriptionError, WhisperSmallTranscriber
try:
    WhisperSmallTranscriber("var/whisper/small")._load()
except TranscriptionError as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
print("Local transcription model is ready.")
PY
else
    printf 'Transcription model setup skipped. To prepare it later:\n  .venv/bin/python tools/prepare_rap_transcription.py\n'
fi

if "$configure_key"; then
    "$venv_python" tools/configure_api_key.py
fi

printf '\nSetup complete. From this checkout, start or restart without connected hardware:\n'
printf '  .venv/bin/python tools/hydra_dashboard.py --demo\n'
printf 'Open http://127.0.0.1:8790/#synth-mixer\n'
printf '\nWhen the synth is connected, start without --demo. Robot serial access,\n'
printf 'head calibration and physical MIDI/audio checks are described in docs/linux.md.\n'
printf 'New music and rap generation require an ElevenLabs API key; configure it with:\n'
printf '  .venv/bin/python tools/configure_api_key.py\n'
