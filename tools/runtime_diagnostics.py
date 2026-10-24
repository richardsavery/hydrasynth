"""Bounded health diagnostics, deliberately separate from study recording."""

from collections import OrderedDict, deque
from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
import math
from pathlib import Path
import re
import threading
import time
from urllib.parse import urlsplit


MAX_LOG_BYTES = 512 * 1024
MAX_CLIENTS = 24
NUMERIC_FIELDS = {
    "sequence", "uptime_ms", "tick_late_ms", "dom_nodes", "canvas_count", "canvas_pixels",
    "error_count", "rejection_count", "send_failures", "heap_used_bytes", "heap_total_bytes", "heap_limit_bytes",
}


def _number(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and 0 <= value <= 2**53 and math.isfinite(value))


def health_sample(document):
    """Allowlist only health counters, never arbitrary payloads or error text."""
    client = document.get("client_id")
    if not isinstance(client, str) or not re.fullmatch(r"[a-fA-F0-9-]{36}", client):
        raise ValueError("Invalid diagnostics client")
    result = {"client_id": client}
    for name in NUMERIC_FIELDS:
        if _number(document.get(name)):
            result[name] = int(document[name])
    result["reason"] = "pagehide" if document.get("reason") == "pagehide" else "heartbeat"
    result["visibility"] = "hidden" if document.get("visibility") == "hidden" else "visible"
    result["errors"] = []
    errors = document.get("errors")
    for error in (errors[-8:] if isinstance(errors, list) else []):
        if not isinstance(error, dict):
            continue
        filename = error.get("file")
        if not isinstance(filename, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}\.js", filename):
            continue
        result["errors"].append({"file": filename, **{
            name: int(error[name]) for name in ("line", "column") if _number(error.get(name))
        }})
    return result


class RuntimeDiagnostics:
    def __init__(self, directory: Path, *, clock=time.monotonic, midi_status=None):
        self.clock = clock
        self.lock = threading.Lock()
        self.clients = OrderedDict()
        self.midi_events = deque(maxlen=24)
        self.midi_status = midi_status
        self.path = directory / "browser-health.jsonl"
        self.handler = None
        self.last_write_ok = False
        try:
            directory.mkdir(parents=True, exist_ok=True)
            self.handler = RotatingFileHandler(self.path, maxBytes=MAX_LOG_BYTES, backupCount=1, encoding="utf-8")
            self.handler.setFormatter(logging.Formatter("%(message)s"))
            self.last_write_ok = True
        except OSError:
            pass  # A full disk must not stop the dashboard or MIDI watchdog.

    def dispatch(self, method, path, document=None):
        path = urlsplit(path).path
        if method == "GET" and path == "/api/runtime-diagnostics/status":
            # The watchdog emits events while holding its own lock. Read its
            # status before acquiring ours to avoid reversing that lock order.
            midi = self.midi_status() if self.midi_status is not None else {}
            midi = {key: value for key, value in midi.items() if key in {
                "armed", "channel", "generation", "transport", "heartbeat_ms", "timeout_ms", "last_reason", "last_panic_ok",
            }}
            with self.lock:
                now = self.clock()
                return 200, {"ok": True, "log_file": str(self.path), "log_write_ok": self.last_write_ok,
                             "midi_safety": midi, "midi_events": list(self.midi_events),
                             "clients": [{**sample, "last_seen_age_ms": round(max(0, now - seen) * 1000)}
                                         for seen, sample in self.clients.values()]}
        if method != "POST" or path != "/api/runtime-diagnostics/sample":
            return 404, {"error": "Unknown diagnostics route"}
        try:
            sample = health_sample(document or {})
        except ValueError:
            return 400, {"error": "Invalid diagnostics sample"}
        with self.lock:
            now = self.clock()
            previous = self.clients.get(sample["client_id"])
            # Avoid exception storms or a buggy client turning diagnostics into
            # another high-volume recorder. Normal samples arrive every 5 sec.
            if previous and now - previous[0] < 1 and sample["reason"] != "pagehide":
                return 200, {"ok": True, "stored": False}
            sample["received_at"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
            if previous:
                sample["receive_gap_ms"] = round(max(0, now - previous[0]) * 1000)
            self.clients[sample["client_id"]] = (now, sample)
            self.clients.move_to_end(sample["client_id"])
            while len(self.clients) > MAX_CLIENTS:
                self.clients.popitem(last=False)
            self._write_locked(sample)
        return 200, {"ok": True, "stored": True}

    def _write_locked(self, sample):
        if self.handler is None:
            return
        record = logging.LogRecord("browser-health", logging.INFO, "", 0,
                                   json.dumps(sample, separators=(",", ":")), (), None)
        try:
            # Invoke rotation and write directly so failures can be reported
            # without dumping exceptions into the terminal.
            if self.handler.shouldRollover(record):
                self.handler.doRollover()
            self.handler.stream.write(self.handler.format(record) + "\n")
            self.handler.flush()
            self.last_write_ok = True
        except (OSError, ValueError):
            self.last_write_ok = False

    def record_midi_event(self, event):
        sample = {"kind": "midi_safety", "received_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds")}
        for key in ("event", "reason"):
            value = event.get(key)
            if isinstance(value, str) and re.fullmatch(r"[a-z_]{1,40}", value):
                sample[key] = value
        for key in ("channel", "generation", "elapsed_ms"):
            if _number(event.get(key)):
                sample[key] = int(event[key])
        if isinstance(event.get("panic_ok"), bool):
            sample["panic_ok"] = event["panic_ok"]
        with self.lock:
            self.midi_events.append(sample)
            self._write_locked(sample)

    def close(self):
        with self.lock:
            if self.handler is not None:
                self.handler.close()
                self.handler = None
