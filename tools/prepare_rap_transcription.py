#!/usr/bin/env python3
"""Explicitly download Whisper small for later offline microphone transcription."""
from __future__ import annotations

import argparse
from pathlib import Path
import sys

from rap_transcription import INSTALL_COMMAND, MODEL_SIZE, model_files_available

DEFAULT_MODEL_DIRECTORY = Path(__file__).resolve().parents[1] / "var" / "whisper" / MODEL_SIZE


def prepare_model(model_directory):
    directory = Path(model_directory).resolve()
    try:
        from faster_whisper.utils import download_model
    except ImportError:
        raise RuntimeError("Install transcription dependencies first: " + INSTALL_COMMAND) from None
    directory.mkdir(parents=True, exist_ok=True)
    # Downloading is confined to this explicit setup command, never dashboard
    # startup, microphone capture, or transcribe(). The model is public.
    download_model(MODEL_SIZE, output_dir=str(directory), cache_dir=str(directory.parent / "cache"), use_auth_token=False)
    if not model_files_available(directory):
        raise RuntimeError("The Whisper small download is incomplete. Run this preparation command again.")
    return directory


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIRECTORY,
                        help="Destination; default: project var/whisper/small")
    args = parser.parse_args(argv)
    print("Downloading multilingual Whisper small for local CPU transcription…", flush=True)
    try:
        directory = prepare_model(args.model_dir)
    except Exception:
        # Dependency errors, paths and network credentials must not be copied
        # from third-party exception bodies into setup output.
        print("Whisper small preparation failed. Check the network connection and writable model directory. "
              "Install dependencies with: " + INSTALL_COMMAND, file=sys.stderr)
        return 1
    print(f"Whisper small is ready at {directory}. Microphone transcription will run locally.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
