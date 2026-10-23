"""Release browser-owned Hydrasynth notes if the browser stops heartbeating.

This runs independently of the browser renderer and is idle until playback arms
it. Native device names are resolved on each panic; ALSA addresses are never
saved or reused after a device disconnects.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
import re
import secrets
import subprocess
import threading
import time
from typing import Callable
from urllib.parse import urlsplit


HEARTBEAT_MS = 500
TIMEOUT_MS = 2500
# The frontend rejects notes longer than this native scheduling horizon.
SETTLING_MS = 5000
COMMAND_TIMEOUT_SECONDS = 1.0


class SafetyError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Lease:
    identifier: str
    owner_id: str
    device_name: str
    channel: int
    deadline: float


def output_names(listing: str) -> list[str]:
    """Read only output entries from hydractl's shared ALSA/CoreMIDI format."""
    outputs = []
    in_outputs = False
    for line in listing.splitlines():
        if line.startswith("Outputs ("):
            in_outputs = True
        elif line.startswith("Inputs ("):
            in_outputs = False
        elif in_outputs:
            match = re.fullmatch(r"\s+\[\d+\] (.+?)(?: \(\d+:\d+\))?", line)
            if match:
                outputs.append(match.group(1))
    return outputs


def normalized(name: str) -> str:
    return " ".join(name.casefold().split())


class MidiSafetyService:
    def __init__(self, hydractl: Path, *, runner: Callable = subprocess.run,
                 clock: Callable = time.monotonic, start_thread: bool = True):
        self.hydractl = str(hydractl)
        self._runner = runner
        self._clock = clock
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._lease: Lease | None = None
        self._settling_owner: str | None = None
        self._settling_until = 0.0
        self._settling_lease: Lease | None = None
        self._closed = False
        self._last_reason: str | None = None
        self._last_panic_ok: bool | None = None
        self._thread = None
        if start_thread:
            self._thread = threading.Thread(target=self._watch, name="hydra-midi-safety", daemon=True)
            self._thread.start()

    def _command(self, *arguments: str):
        try:
            result = self._runner([self.hydractl, *arguments], capture_output=True,
                                  text=True, timeout=COMMAND_TIMEOUT_SECONDS, check=False)
        except (OSError, subprocess.SubprocessError):
            raise SafetyError("Native MIDI safety is unavailable; check the Hydrasynth connection.", 503) from None
        if result.returncode != 0:
            raise SafetyError("Native MIDI safety is unavailable; check the Hydrasynth connection.", 503)
        return result

    def _resolve(self, port_name: str, *, exact: bool = False) -> str:
        wanted = normalized(port_name)
        candidates = []
        for name in output_names(self._command("list").stdout):
            if "hydrasynth" not in normalized(name):
                continue
            # ALSA's client prefix is absent from the Web MIDI output name.
            aliases = [name] if exact else [name, name.partition(": ")[2]]
            if any(normalized(alias) == wanted for alias in aliases):
                candidates.append(name)
        if len(candidates) > 1:
            raise SafetyError("More than one Hydrasynth matches this MIDI output.", 409)
        if not candidates:
            raise SafetyError("The selected Hydrasynth MIDI output is unavailable.", 503)
        return candidates[0]

    def _panic(self, lease: Lease, reason: str, *, settle: bool = True) -> bool:
        self._last_reason = reason
        # A live previous tab may keep sending until it learns its lease was
        # replaced. Cover its entire remaining readiness deadline as well as
        # every note-off it could already have handed to the native scheduler.
        if settle:
            stopped_at = max(self._clock(), lease.deadline) if reason == "lease_replaced" else self._clock()
            self._settling_owner = lease.owner_id
            self._settling_until = stopped_at + SETTLING_MS / 1000
            self._settling_lease = lease
        self._last_panic_ok = False
        for _attempt in range(2):
            try:
                # Retry one transient native failure, re-enumerating each time.
                # An old ALSA address may now identify a different instrument.
                device = self._resolve(lease.device_name, exact=True)
                self._command("panic", "--device", device, "--channel", str(lease.channel))
            except SafetyError:
                continue
            self._last_panic_ok = True
            break
        return self._last_panic_ok

    def _expire_locked(self) -> None:
        if self._lease is not None and self._clock() >= self._lease.deadline:
            expired, self._lease = self._lease, None
            self._panic(expired, "heartbeat_timeout")

    def check_timeout(self) -> None:
        with self._lock:
            self._expire_locked()

    def _watch(self) -> None:
        while not self._stop.wait(0.1):
            self.check_timeout()

    def arm(self, document: dict) -> dict:
        port_name, channel, owner_id = document.get("port_name"), document.get("channel"), document.get("owner_id")
        if (not isinstance(port_name, str) or not 1 <= len(port_name) <= 512
                or any(ord(character) < 32 for character in port_name)
                or "hydrasynth" not in normalized(port_name)):
            raise SafetyError("Choose a Hydrasynth MIDI output before starting playback.")
        if type(channel) is not int or not 1 <= channel <= 16:
            raise SafetyError("MIDI channel must be from 1 to 16.")
        if not isinstance(owner_id, str) or re.fullmatch(r"[0-9a-f]{32}", owner_id) is None:
            raise SafetyError("Reload the dashboard to initialize MIDI safety.")
        with self._lock:
            if self._closed:
                raise SafetyError("MIDI safety is shutting down.", 503)
            self._expire_locked()
            device = self._resolve(port_name)
            previous = self._lease
            if previous:
                # A reloaded tab may replace a crashed tab's lease before its
                # timeout. Release those notes before allowing fresh note-ons,
                # even when the new lease uses the same output and channel.
                self._lease = None
                if not self._panic(previous, "lease_replaced"):
                    raise SafetyError("Unable to stop the previous MIDI output.", 503)
            if owner_id != self._settling_owner and self._clock() < self._settling_until:
                seconds = math.ceil(self._settling_until - self._clock())
                unit = "second" if seconds == 1 else "seconds"
                raise SafetyError(f"Previous MIDI notes are clearing. Wait {seconds} {unit}, then press Play again.", 409)
            if owner_id != self._settling_owner and self._settling_lease is not None:
                # A revoked live page could send sustain before noticing its
                # stale lease. After its deadline and queued releases pass,
                # silence it once more before the new owner can send notes.
                if not self._panic(self._settling_lease, "handover_cleared", settle=False):
                    raise SafetyError("Unable to clear the previous MIDI output. Check its connection and retry.", 503)
                self._settling_lease = None
            self._lease = Lease(secrets.token_urlsafe(24), owner_id, device, channel,
                                self._clock() + TIMEOUT_MS / 1000)
            return {"ok": True, "lease_id": self._lease.identifier,
                    "heartbeat_ms": HEARTBEAT_MS, "timeout_ms": TIMEOUT_MS,
                    "device_name": device, "channel": channel}

    def _current_lease(self, document: dict) -> Lease:
        identifier = document.get("lease_id")
        if (not isinstance(identifier, str) or self._lease is None
                or not secrets.compare_digest(identifier.encode("utf-8"), self._lease.identifier.encode("ascii"))):
            raise SafetyError("MIDI safety lease expired or was replaced; restart playback.", 409)
        self._expire_locked()
        if self._lease is None:
            raise SafetyError("MIDI safety lease expired or was replaced; restart playback.", 409)
        return self._lease

    def heartbeat(self, document: dict) -> dict:
        with self._lock:
            lease = self._current_lease(document)
            self._lease = Lease(lease.identifier, lease.owner_id, lease.device_name, lease.channel,
                                self._clock() + TIMEOUT_MS / 1000)
            return {"ok": True}

    def disarm(self, document: dict) -> dict:
        with self._lock:
            lease = self._current_lease(document)
            self._lease = None
            if not self._panic(lease, "disarmed"):
                raise SafetyError("Native MIDI stop failed; check the Hydrasynth connection.", 503)
            return {"ok": True}

    def status(self) -> dict:
        with self._lock:
            lease = self._lease
            return {"ok": True, "armed": lease is not None,
                    "device_name": lease.device_name if lease else None,
                    "channel": lease.channel if lease else None,
                    "heartbeat_ms": HEARTBEAT_MS, "timeout_ms": TIMEOUT_MS,
                    "last_reason": self._last_reason, "last_panic_ok": self._last_panic_ok}

    def dispatch(self, method: str, path: str, document=None) -> tuple[int, dict]:
        path = urlsplit(path).path
        if method == "GET" and path == "/api/midi-safety/status":
            return 200, self.status()
        operations = {"arm": self.arm, "heartbeat": self.heartbeat, "disarm": self.disarm}
        operation = operations.get(path.removeprefix("/api/midi-safety/"))
        if operation is None:
            return 404, {"ok": False, "error": "Unknown MIDI safety route."}
        if method != "POST":
            return 405, {"ok": False, "error": "Use POST for MIDI safety commands."}
        if not isinstance(document, dict):
            return 400, {"ok": False, "error": "Expected a JSON object."}
        try:
            return 200, operation(document)
        except SafetyError as error:
            return error.status, {"ok": False, "error": str(error)}

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            if self._closed:
                return
            self._closed = True
            if self._lease is not None:
                lease, self._lease = self._lease, None
                self._panic(lease, "shutdown")
        if self._thread is not None:
            self._thread.join(timeout=4 * COMMAND_TIMEOUT_SECONDS + 0.5)
