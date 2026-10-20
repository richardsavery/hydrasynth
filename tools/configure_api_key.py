#!/usr/bin/env python3
"""Store an ElevenLabs key locally, without putting it in shell history."""

import argparse
import getpass
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import warnings


ROOT = Path(__file__).resolve().parents[1]
SETTING = "ELEVENLABS_API_KEY"
ASSIGNMENT = re.compile(r"^\s*(?:export [ \t]*)?ELEVENLABS_API_KEY\s*=")


def read_document(path):
    if path.is_symlink():
        raise ValueError("The .env path is a symlink; manage that file separately.")
    if not path.exists():
        return ""
    if not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise ValueError("The .env file must be a regular text file smaller than 1 MiB.")
    with path.open(encoding="utf-8", newline="") as handle:
        return handle.read()


def has_saved_key(document):
    value = ""
    for line in document.splitlines():
        if ASSIGNMENT.match(line):
            value = line.partition("=")[2].strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            else:
                value = value.split(" #", 1)[0].rstrip()
    return bool(value.strip())


def save_key(path, document, key):
    # A literal, single-line dotenv value. Do not guess a provider-specific
    # prefix or length, and never include a rejected value in an error.
    if not key or any(ord(c) < 33 or ord(c) > 126 or c in "\"'" for c in key):
        raise ValueError("Use the API key alone, without quotes, spaces or line breaks.")
    lines = document.splitlines(keepends=True)
    retained = "".join(line for line in lines if not ASSIGNMENT.match(line))
    if retained and not retained.endswith(("\n", "\r")):
        retained += "\n"
    updated = retained + SETTING + "=" + key + "\n"
    descriptor, filename = tempfile.mkstemp(prefix=".env-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), stat.S_IRUSR | stat.S_IWUSR)
            handle.write(updated)
            handle.flush()
            os.fsync(handle.fileno())
        # Do not overwrite an edit that happened while the prompt was open.
        if read_document(path) != document:
            raise ValueError("The .env file changed during setup; rerun the key command.")
        os.replace(filename, path)
    finally:
        if os.path.exists(filename):
            os.unlink(filename)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replace", action="store_true", help="Prompt to replace an existing saved key")
    args = parser.parse_args(argv)
    path = ROOT / ".env"
    try:
        document = read_document(path)
        if not args.replace:
            if os.environ.get(SETTING, "").strip():
                print("An API key is supplied by the environment; .env was left unchanged.")
                return 0
            if has_saved_key(document):
                path.chmod(0o600)
                print("Existing API key kept in .env (owner read/write only). Use --replace to change it.")
                return 0
        if not sys.stdin.isatty():
            print("Key setup skipped: run .venv/bin/python tools/configure_api_key.py in a terminal to paste a key.")
            return 0
        print("Optional: paste the ElevenLabs key for this laptop. Input is hidden; Enter skips.")
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            key = getpass.getpass("API key: ")
        if not key:
            print("Key setup skipped; existing .env was left unchanged.")
            return 0
        save_key(path, document, key)
        print("API key saved in ignored .env (owner read/write only). Restart a running dashboard to use it.")
        if os.environ.get(SETTING):
            print("The environment still takes precedence over .env; update or unset that variable too.")
        return 0
    except getpass.GetPassWarning:
        print("Cannot hide terminal input. Key not saved; use a normal terminal or copy a private .env file.", file=sys.stderr)
    except (OSError, UnicodeError):
        print("Could not read or write the local .env file. Check its permissions and encoding.", file=sys.stderr)
    except ValueError as error:
        print(str(error), file=sys.stderr)
    except (KeyboardInterrupt, EOFError):
        print("\nKey setup cancelled; existing .env was left unchanged.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
