"""Bounded command transport for hydractl's independent MIDI scheduler.

Chrome never opens a MIDI session on this path. Notes and their releases are
submitted together to hydractl, which continues running if the page disappears.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import select
import subprocess
import threading
import time


class NativeMidiError(RuntimeError):
    pass


class NativeMidiTransport:
    def __init__(self, hydractl: str | Path, device: str, channel: int, *,
                 timeout: float = 1.0, popen=subprocess.Popen):
        self.timeout = timeout
        self._condition = threading.Condition()
        self._commands = threading.Lock()
        self._ready = False
        self._failure = None
        self._closed = False
        self._serial = 0
        self._expected = None
        self._response = None
        self.process = popen([str(hydractl), "serve", "--device", device,
                              "--channel", str(channel), "--no-input"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, bufsize=65536)
        os.set_blocking(self.process.stdin.fileno(), False)
        self._reader = threading.Thread(target=self._read, name="hydra-native-midi", daemon=True)
        self._reader.start()
        try:
            with self._condition:
                deadline = time.monotonic() + timeout
                while not self._ready and self._failure is None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise NativeMidiError("Native MIDI did not become ready.")
                    self._condition.wait(remaining)
                if self._failure:
                    raise NativeMidiError(self._failure)
        except Exception:
            self.close()
            raise

    @property
    def healthy(self):
        with self._condition:
            return self._ready and not self._closed and self._failure is None and self.process.poll() is None

    def _read(self):
        try:
            while True:
                raw = self.process.stdout.readline(16385)
                if not raw:
                    break
                if len(raw) > 16384 or not raw.endswith(b"\n"):
                    raise NativeMidiError("Native MIDI returned an oversized response.")
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise NativeMidiError("Native MIDI returned an invalid response.")
                with self._condition:
                    if message.get("type") == "ready":
                        if not message.get("connected") or not message.get("scheduler"):
                            raise NativeMidiError("Native MIDI scheduler is unavailable.")
                        self._ready = True
                    elif message.get("type") == "response" and message.get("id") == self._expected:
                        # At most one command is outstanding; never retain the
                        # unsolicited note/job events emitted during playback.
                        self._response = message
                    self._condition.notify_all()
        except (OSError, ValueError, NativeMidiError):
            pass
        finally:
            with self._condition:
                self._failure = "Native MIDI stopped responding. Check the synth connection."
                self._condition.notify_all()

    def request(self, command: dict) -> dict:
        with self._commands:
            deadline = time.monotonic() + self.timeout
            with self._condition:
                if self._closed or self._failure or self.process.poll() is not None:
                    raise NativeMidiError("Native MIDI is disconnected.")
                self._serial += 1
                self._expected = self._serial
                self._response = None
                payload = (json.dumps({**command, "id": self._serial, "v": 1},
                                      separators=(",", ":"), allow_nan=False) + "\n").encode()
            if len(payload) > 16384:
                raise NativeMidiError("Native MIDI command is too large.")
            try:
                offset = 0
                while offset < len(payload):
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not select.select([], [self.process.stdin], [], remaining)[1]:
                        raise NativeMidiError("Native MIDI command timed out.")
                    try:
                        offset += os.write(self.process.stdin.fileno(), payload[offset:])
                    except BlockingIOError:
                        continue
                with self._condition:
                    while self._response is None and self._failure is None:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise NativeMidiError("Native MIDI command timed out.")
                        self._condition.wait(remaining)
                    response = self._response
                    self._expected = self._response = None
                if response is None:
                    raise NativeMidiError("Native MIDI stopped before acknowledging the command.")
                if response.get("ok") is not True:
                    raise NativeMidiError("Native MIDI could not send the command.")
                return response
            except (OSError, ValueError) as error:
                raise NativeMidiError("Native MIDI connection failed.") from error

    def close(self):
        if self._closed:
            return
        try:
            if self._ready and not self._failure and self.process.poll() is None:
                self.request({"op": "shutdown"})
        except NativeMidiError:
            pass
        self._closed = True
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=0.5)
        self._reader.join(timeout=0.5)
        self.process.stdin.close()
        self.process.stdout.close()
