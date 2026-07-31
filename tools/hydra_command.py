#!/usr/bin/env python3
"""Send one authenticated command to a running Hydrasynth dashboard."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import socket
import stat
import sys
from typing import Any


REQUEST_LIMIT = 16 * 1024
RESPONSE_LIMIT = 2 * 1024 * 1024
DEFAULT_SOCKET = Path(f"/tmp/hydrasynth-dashboard-{os.getuid()}.sock")
DEFAULT_TOKEN = Path(f"/tmp/hydrasynth-dashboard-{os.getuid()}.token")


def read_bounded(path: Path | None) -> bytes:
    if path is None:
        payload = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
    else:
        with path.open("rb") as source:
            payload = source.read(REQUEST_LIMIT + 1)
    if len(payload) > REQUEST_LIMIT:
        raise ValueError("request exceeds 16 KiB")
    return payload


def load_token(path: Path) -> str:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"token path is not a regular file: {path}")
    if metadata.st_uid != os.getuid():
        raise PermissionError(f"token file is not owned by this user: {path}")
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        raise PermissionError(f"token file permissions are not private: {path}")
    with path.open("rb") as source:
        raw_token = source.read(513)
    if len(raw_token) > 512:
        raise ValueError("token file is unexpectedly large")
    try:
        token = raw_token.decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise ValueError("token file is not ASCII") from error
    if not token:
        raise ValueError("token file is empty")
    return token


def validate_socket(path: Path) -> None:
    metadata = path.lstat()
    if not stat.S_ISSOCK(metadata.st_mode):
        raise ValueError(f"broker path is not a Unix socket: {path}")
    if metadata.st_uid != os.getuid():
        raise PermissionError(f"broker socket is not owned by this user: {path}")


def receive_response(connection: socket.socket) -> dict[str, Any]:
    payload = bytearray()
    while True:
        chunk = connection.recv(4096)
        if not chunk:
            break
        payload.extend(chunk)
        newline = payload.find(b"\n")
        if newline >= 0:
            if newline > RESPONSE_LIMIT:
                raise ValueError("broker response exceeds 2 MiB")
            payload = payload[:newline]
            break
        if len(payload) > RESPONSE_LIMIT:
            raise ValueError("broker response exceeds 2 MiB")
    if len(payload) > RESPONSE_LIMIT:
        raise ValueError("broker response exceeds 2 MiB")
    if not payload:
        raise ValueError("broker closed without a response")
    try:
        response = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("broker returned invalid JSON") from error
    if not isinstance(response, dict):
        raise ValueError("broker response is not an object")
    return response


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Send one protocol-v1 JSON command through the running dashboard's "
            "authenticated local Unix socket."
        )
    )
    source = parser.add_mutually_exclusive_group()
    source.add_argument(
        "request",
        nargs="?",
        help="one JSON request object; omit to read it from standard input",
    )
    source.add_argument("--file", type=Path, help="read the JSON request from a file")
    parser.add_argument("--socket", type=Path, default=DEFAULT_SOCKET)
    parser.add_argument("--token-file", type=Path, default=DEFAULT_TOKEN)
    parser.add_argument("--timeout", type=float, default=6.5)
    parser.add_argument("--pretty", action="store_true")
    arguments = parser.parse_args(argv)
    if not 0.1 <= arguments.timeout <= 30.0:
        parser.error("--timeout must be from 0.1 to 30 seconds")
    return arguments


def main(argv: list[str] | None = None) -> int:
    arguments = parse_arguments(sys.argv[1:] if argv is None else argv)
    try:
        raw_request = (
            arguments.request.encode("utf-8")
            if arguments.request is not None
            else read_bounded(arguments.file)
        )
        if len(raw_request) > REQUEST_LIMIT:
            raise ValueError("request exceeds 16 KiB")
        request = json.loads(raw_request.decode("utf-8"))
        if not isinstance(request, dict):
            raise ValueError("request must be a JSON object")
        token = load_token(arguments.token_file)
        validate_socket(arguments.socket)
        wire_payload = (
            json.dumps(
                {"v": 1, "token": token, "request": request},
                separators=(",", ":"),
                allow_nan=False,
            )
            + "\n"
        ).encode("utf-8")
        if len(wire_payload) - 1 > REQUEST_LIMIT:
            raise ValueError("authenticated broker envelope exceeds 16 KiB")

        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(arguments.timeout)
        try:
            connection.connect(str(arguments.socket))
            connection.sendall(wire_payload)
            response = receive_response(connection)
        finally:
            connection.close()
    except (
        FileNotFoundError,
        PermissionError,
        OSError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        TypeError,
        ValueError,
    ) as error:
        print(f"hydra-command: {error}", file=sys.stderr)
        return 2

    if arguments.pretty:
        print(json.dumps(response, indent=2, sort_keys=True, allow_nan=False))
    else:
        print(json.dumps(response, separators=(",", ":"), allow_nan=False))
    return 0 if response.get("ok") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
