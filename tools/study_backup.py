"""Automatic local study bundles; failures never disable the primary journal."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import threading
import uuid

from study_recording import canonical, now


class StudyBackup:
    def __init__(self, recorder, destination=None, interval_seconds=120):
        self.recorder = recorder
        self.destination = Path(destination) if destination is not None else recorder.root / "backups" / recorder.device_id
        self.destination = self.destination.expanduser().absolute()
        self.interval_seconds = max(.05, float(interval_seconds))
        key = hashlib.sha256(str(self.destination).encode()).hexdigest()[:24]
        self._checkpoint_path = recorder.root / (".backup-checkpoint-" + key + ".json")
        self._checkpoint = None
        self._lock = threading.RLock()
        self._run_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._closed = False
        self._state = "idle"
        self._last_completed_at = None
        self._last_bundle = None
        self._last_error = None

    def status(self):
        with self._lock:
            return {"enabled": True, "destination": str(self.destination), "state": self._state,
                    "last_completed_at": self._last_completed_at, "last_error": self._last_error}

    def start(self):
        with self._lock:
            if self._thread is not None or self._closed:
                return
            self._thread = threading.Thread(target=self._work, name="study-backup", daemon=True)
            self._thread.start()

    def _load_checkpoint(self):
        try:
            saved = json.loads(self._checkpoint_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (ValueError, UnicodeError):
            # Re-exporting is safe; guessing past corrupt progress could lose data.
            return {}
        if not isinstance(saved, dict) or saved.get("device_id") != self.recorder.device_id or saved.get("version") != 1:
            return {}
        checkpoint = saved.get("checkpoint")
        if (not isinstance(checkpoint, dict) or not isinstance(checkpoint.get("files", {}), dict)
                or any(type(checkpoint.get(key, 0)) is not int or checkpoint.get(key, 0) < 0
                       for key in ("event_rowid", "media_rowid"))
                or any(not isinstance(value, dict) for value in checkpoint.get("files", {}).values())):
            return {}
        last_bundle = saved.get("last_bundle")
        if (not isinstance(last_bundle, str) or Path(last_bundle).name != last_bundle
                or not (self.destination / last_bundle).is_file()):
            # A copied-away/deleted backup folder is rebuilt from the journal;
            # the cursor must never imply that missing bundles are still safe.
            return {}
        self._last_completed_at = saved.get("last_completed_at")
        self._last_bundle = last_bundle
        return checkpoint

    def _save_checkpoint(self, checkpoint, completed_at, last_bundle):
        temporary = self._checkpoint_path.with_name(self._checkpoint_path.name + ".tmp-" + uuid.uuid4().hex)
        document = {"version": 1, "device_id": self.recorder.device_id,
                    "last_completed_at": completed_at, "last_bundle": last_bundle, "checkpoint": checkpoint}
        try:
            with temporary.open("x", encoding="utf-8") as output:
                os.chmod(temporary, 0o600)
                output.write(canonical(document))
                output.flush()
                os.fsync(output.fileno())
            temporary.replace(self._checkpoint_path)
            directory_fd = os.open(self._checkpoint_path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            temporary.unlink(missing_ok=True)

    def _run_once(self):
        """One serialized attempt, also used for the final shutdown collection."""
        with self._run_lock:
            with self._lock:
                self._state = "writing"
            try:
                if self._checkpoint is None:
                    self._checkpoint = self._load_checkpoint()
                elif self._last_bundle and not (self.destination / self._last_bundle).is_file():
                    self._checkpoint, self._last_bundle, self._last_completed_at = {}, None, None
                result, checkpoint = self.recorder.export_incremental(self.destination, self._checkpoint)
                completed_at = now() if result is not None else self._last_completed_at
                last_bundle = result.path.name if result is not None else self._last_bundle
                # A failed checkpoint write leaves the old cursor in force. The
                # published bundle is retained, and its eventual duplicate is safe.
                if checkpoint != self._checkpoint or result is not None:
                    self._save_checkpoint(checkpoint, completed_at, last_bundle)
                self._checkpoint = checkpoint
                with self._lock:
                    self._last_completed_at = completed_at
                    self._last_bundle = last_bundle
                    self._last_error = None
                    self._state = "idle"
                return result
            except Exception:
                with self._lock:
                    self._last_error = "Automatic backup could not finish. Local recording continues; backup will retry. Check disk space and folder access."
                    self._state = "error"
                return None

    def _work(self):
        while not self._stop.is_set():
            self._run_once()
            if self._stop.wait(self.interval_seconds):
                break
        self._finish()

    def _finish(self):
        flush_failed = False
        try:
            self.recorder.flush()
        except Exception:
            flush_failed = True
        # Preserve all committed data even when a final journal flush fails.
        self._run_once()
        if flush_failed:
            with self._lock:
                self._state = "error"
                self._last_error = "The final backup contains saved data, but queued recording events could not all be flushed. Check recording status."

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._stop.set()
            thread = self._thread
        if thread is not None:
            thread.join()
        else:
            self._finish()
