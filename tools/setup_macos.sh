#!/usr/bin/env bash
# Compatible with macOS's Bash 3.2. Preserve existing keys, models and user data.
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: bash tools/setup_macos.sh [options]

Install or update Hydrasynth on macOS, on Apple silicon or Intel. Run as your
normal user. Setup installs Homebrew if needed, FFmpeg, Python dependencies,
native CoreMIDI/CoreAudio tools, and the local Whisper small model.
Apple's Command Line Tools need one macOS installer prompt if not yet installed.
Internet access is needed for dependencies and the initial model download.
Existing .venv, downloaded model, .env, recordings and calibration are retained.

Options:
  --skip-system  Do not install Homebrew, formulae or Apple's Command Line Tools.
  --skip-model   Do not download or check the local transcription model.
  --no-key       Do not prompt for an ElevenLabs API key.
  -h, --help     Show this help.

New installations use Homebrew Python 3.12. PYTHON=/path/to/python3 selects
another Python 3.10 or newer. An existing .venv keeps its own Python.
Node.js is not needed to run the app.

To update: stop the dashboard, then run from this checkout:
  git pull --ff-only
  bash tools/setup.sh
Restart the dashboard when setup completes.
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

[[ "$(uname -s)" == Darwin ]] || fail 'This installer is for macOS. Use bash tools/setup.sh on Linux.'
(( EUID != 0 )) || fail 'Run this script as your normal user, without sudo. Homebrew requests administrator access when needed.'

project_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$project_directory"
[[ -f requirements-robot.txt && -f requirements-rap-response.txt && -f requirements-beat-tracking.txt && -f Makefile ]] ||
    fail 'The checkout is incomplete.'

if ! command -v xcrun >/dev/null || ! xcrun --find clang >/dev/null 2>&1; then
    if "$skip_system"; then
        fail "Apple's Command Line Tools are missing. Run xcode-select --install, finish the installer, then rerun setup."
    fi
    printf "Opening Apple's Command Line Tools installer.\n"
    xcode-select --install ||
        fail "Could not open Apple's installer. Run xcode-select --install, finish installation, then rerun setup."
    fail "Finish the Command Line Tools installation window, then rerun bash tools/setup.sh. Setup has not completed yet."
fi

brew_command=""
discover_brew() {
    if command -v brew >/dev/null; then
        brew_command="$(command -v brew)"
    elif [[ -x /opt/homebrew/bin/brew ]]; then
        brew_command=/opt/homebrew/bin/brew
    elif [[ -x /usr/local/bin/brew ]]; then
        brew_command=/usr/local/bin/brew
    else
        return 1
    fi
}

bootstrap_file=""
cleanup_bootstrap() {
    if [[ -n "$bootstrap_file" ]]; then
        rm -f -- "$bootstrap_file"
    fi
}
trap cleanup_bootstrap EXIT

if ! discover_brew && ! "$skip_system"; then
    command -v curl >/dev/null || fail 'curl is required to download Homebrew.'
    printf 'Installing Homebrew from its official installer. Follow any administrator password prompts.\n'
    bootstrap_file="$(mktemp "${TMPDIR:-/tmp}/hydrasynth-homebrew.XXXXXX")"
    curl --fail --location --retry 2 \
        https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh \
        --output "$bootstrap_file" ||
        fail 'Could not download Homebrew. Check your internet connection and rerun setup.'
    /bin/bash "$bootstrap_file" ||
        fail 'Homebrew installation did not finish. Resolve the installer error and rerun setup.'
    discover_brew ||
        fail 'Homebrew was not found after installation. Follow its PATH instructions, then rerun setup.'
fi

# Avoid eval/shell-profile edits, and expose FFmpeg even before a new terminal.
if [[ -n "$brew_command" ]]; then
    brew_prefix="$("$brew_command" --prefix)"
    [[ -d "$brew_prefix/bin" ]] || fail 'Homebrew returned an invalid installation prefix.'
    export PATH="$brew_prefix/bin:$brew_prefix/sbin:$PATH"
fi

venv_python="$project_directory/.venv/bin/python"
if ! "$skip_system"; then
    installed_formula=false
    if ! "$brew_command" list --versions ffmpeg >/dev/null 2>&1; then
        printf 'Installing missing Homebrew formula: ffmpeg\n'
        "$brew_command" install ffmpeg
        installed_formula=true
    fi
    if [[ ! -e .venv && ! -L .venv && -z "${PYTHON:-}" ]] &&
       ! "$brew_command" list --versions python@3.12 >/dev/null 2>&1; then
        printf 'Installing missing Homebrew formula: python@3.12\n'
        # Use the formula's own prefix below. Global Python links can belong to
        # another installation (e.g. python.org); leave those files untouched.
        "$brew_command" install --skip-link python@3.12
        installed_formula=true
    fi
    if ! "$installed_formula"; then
        printf 'System dependencies are already installed.\n'
    fi
fi

for required_tool in make cc ffmpeg ffprobe; do
    command -v "$required_tool" >/dev/null ||
        fail "Missing $required_tool. Rerun without --skip-system to install the build and audio tools."
done

# Services also look in var/bin, so a later launch works without Homebrew in
# the user's shell PATH. Keep any working tools that were configured locally.
mkdir -p var/bin
for audio_tool in ffmpeg ffprobe; do
    local_tool="$project_directory/var/bin/$audio_tool"
    if [[ -f "$local_tool" && -x "$local_tool" ]]; then
        continue
    fi
    if [[ -L "$local_tool" && ! -e "$local_tool" ]]; then
        rm -- "$local_tool"
    elif [[ -e "$local_tool" || -L "$local_tool" ]]; then
        fail "$local_tool exists but is not an executable file. Repair it or move it aside; setup has left it intact."
    fi
    ln -s "$(command -v "$audio_tool")" "$local_tool"
done

check_python() {
    "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' ||
        fail "$2"
}

if [[ -e .venv || -L .venv ]]; then
    [[ -x "$venv_python" ]] ||
        fail 'The existing .venv has no usable Python. Repair it or move it aside before trying again; setup has left it intact.'
    check_python "$venv_python" 'The existing .venv requires Python 3.10 or newer. Repair it or move it aside, then rerun setup with PYTHON pointing to a suitable interpreter. Setup has left it intact.'
    printf 'Using the existing .venv.\n'
else
    setup_python="${PYTHON:-}"
    if [[ -z "$setup_python" ]]; then
        [[ -n "$brew_command" ]] ||
            fail 'Homebrew Python 3.12 is needed for a new .venv. Rerun without --skip-system or set PYTHON=/path/to/python3.'
        python_prefix="$("$brew_command" --prefix python@3.12)"
        setup_python="$python_prefix/bin/python3.12"
    fi
    command -v "$setup_python" >/dev/null || fail "Python not found: $setup_python. Rerun without --skip-system or set PYTHON=/path/to/python3."
    check_python "$setup_python" 'Python 3.10 or newer is required. Set PYTHON to a suitable interpreter when creating a new .venv.'
    printf 'Creating .venv with %s.\n' "$setup_python"
    "$setup_python" -m venv .venv
fi

printf 'Installing or updating Python dependencies.\n'
"$venv_python" -m pip install --upgrade --upgrade-strategy only-if-needed \
    -r requirements-robot.txt -r requirements-rap-response.txt -r requirements-beat-tracking.txt

printf 'Building native macOS MIDI and audio tools.\n'
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
printf '\nWhen the synth is connected, start without --demo.\n'
printf 'Allow microphone access in the browser when you want to record.\n'
printf 'New music and rap generation require an ElevenLabs API key; configure it with:\n'
printf '  .venv/bin/python tools/configure_api_key.py\n'
