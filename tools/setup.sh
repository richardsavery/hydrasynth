#!/usr/bin/env bash
# One install/update command for supported desktop systems.
set -euo pipefail

tools_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
case "$(uname -s)" in
    Darwin) exec bash "$tools_directory/setup_macos.sh" "$@" ;;
    Linux) exec bash "$tools_directory/setup_linux.sh" "$@" ;;
    *)
        printf 'Automatic setup supports macOS and Ubuntu/Debian Linux.\n' >&2
        printf 'Native Windows is not supported. Use a Mac or Linux laptop for MIDI/audio and the robot.\n' >&2
        exit 1
        ;;
esac
