"""Separate Dynamixel connections with calibrated, bounded head movement."""

from __future__ import annotations

import copy
from datetime import datetime, timezone
import importlib
import json
import math
import os
from pathlib import Path
import tempfile
import threading
import time
from typing import Any

import robot_devices
from robot_drum_performance import DrumPerformanceBounds, DrumPerformanceSessionError
from robot_ribs import _DEVICE_PATTERN, _dependency_available, _integer, _ports, _unknown_motor


DRUM_IDS = (0, 1, 2, 3)
DRUM_BOUNDS = {0: (2100, 2450), 1: (1850, 2125), 2: (2070, 2350), 3: (2410, 2600)}
DRUM_PREFERRED_DEVICE = "/dev/cu.usbserial-FT7WBEBD"
DRUM_DEFAULT_DEVICE = "/dev/tty.usbserial-FT7WBEBD"
BAUDRATES = (57_600, 115_200, 1_000_000, 2_000_000, 3_000_000, 4_000_000)
HEAD_MODEL = 1090  # 2XL430-W250-T: each axis appears as a separate motor ID.
HEAD_MIN_DURATION_MS, HEAD_MAX_DURATION_MS = 1000, 10000
HEAD_MAX_SPEED_TICKS_PER_SECOND = 150
DRUM_REST_THRESHOLD = 20  # Legacy controller arrival threshold, in raw ticks.
DRUM_TORQUE_REST_MS = 2000
DEFAULT_HEAD_CALIBRATION_PATH = Path(__file__).resolve().parents[1] / "var" / "robot" / "head-calibration.json"
CALIBRATION_SAMPLE_INTERVAL = 0.2
POSITION_MIN, POSITION_MAX = -(2 ** 31), 2 ** 31 - 1


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _signed_position(value: int) -> int:
    return value - 0x100000000 if value >= 0x80000000 else value


def _connection_key(device: str | None) -> str | None:
    return robot_devices.connection_key(device)


def _label(value: Any, motor_id: int, *, allow_empty: bool = True) -> str:
    if not isinstance(value, str):
        raise ValueError("Axis labels must be text.")
    if any(not character.isprintable() for character in value):
        raise ValueError("Axis labels must contain 1–48 printable characters.")
    value = value.strip()
    if not value and allow_empty:
        return f"Motor {motor_id}"
    if not value or len(value) > 48:
        raise ValueError("Axis labels must contain 1–48 printable characters.")
    return value


def _validate_calibration(document: Any) -> dict[str, Any]:
    """Validate disk data independently of the current connection or SDK."""
    keys = {"version", "device", "baudrate", "model_number", "saved_at", "sample_count", "axes"}
    if (not isinstance(document, dict) or not keys <= set(document)
            or set(document) - keys - {"device_identity"}):
        raise ValueError("Saved calibration fields are invalid.")
    if "device_identity" in document:
        robot_devices.validate_identity(document["device_identity"])
    if type(document["version"]) is not int or document["version"] != 1:
        raise ValueError("Unsupported head calibration version.")
    if type(document["model_number"]) is not int or document["model_number"] != HEAD_MODEL:
        raise ValueError("Saved calibration is not for a 2XL430-W250-T.")
    if not isinstance(document["device"], str) or not _DEVICE_PATTERN.fullmatch(document["device"]):
        raise ValueError("Saved serial device is invalid.")
    if type(document["baudrate"]) is not int or document["baudrate"] not in BAUDRATES:
        raise ValueError("Saved baud rate is invalid.")
    if type(document["sample_count"]) is not int or not 1 <= document["sample_count"] <= 2 ** 53 - 1:
        raise ValueError("Saved sample count is invalid.")
    saved_at = document["saved_at"]
    if not isinstance(saved_at, str) or len(saved_at) > 80:
        raise ValueError("Saved timestamp is invalid.")
    try:
        timestamp = datetime.fromisoformat(saved_at)
    except ValueError as error:
        raise ValueError("Saved timestamp is invalid.") from error
    if timestamp.utcoffset() is None:
        raise ValueError("Saved timestamp must include a timezone.")
    axes = document["axes"]
    if not isinstance(axes, list) or len(axes) != 2:
        raise ValueError("Saved calibration must contain exactly two axes.")
    ids = set()
    for axis in axes:
        if not isinstance(axis, dict) or set(axis) != {"id", "label", "min", "centre", "max"}:
            raise ValueError("Saved axis fields are invalid.")
        if type(axis["id"]) is not int or not 0 <= axis["id"] <= 252 or axis["id"] in ids:
            raise ValueError("Saved axis IDs must be distinct integers from 0 to 252.")
        ids.add(axis["id"])
        _label(axis["label"], axis["id"], allow_empty=False)
        for name in ("min", "centre", "max"):
            if type(axis[name]) is not int or not POSITION_MIN <= axis[name] <= POSITION_MAX:
                raise ValueError("Saved positions must be signed 32-bit integer ticks.")
        if not axis["min"] < axis["max"] or not axis["min"] <= axis["centre"] <= axis["max"]:
            raise ValueError("Saved axis ranges must contain the centre and have different endpoints.")
    return copy.deepcopy(document)


class _SerialController:
    """Read transport shared by independent adapters; never writes registers."""

    component: str
    ids: tuple[int, ...] = ()

    def __init__(self, device: str | None, baudrate: int) -> None:
        self._lock = threading.RLock()
        self._sdk = None
        self._port = None
        self._packet = None
        self._closed = False
        self._device = device
        self._baudrate = baudrate
        self._state = "unchecked"
        self._code = "not_checked"
        self._message = f"Select the {self.component} adapter and check its connection."
        self._checked_at: str | None = None
        self._motors = {motor_id: _unknown_motor(motor_id) for motor_id in self.ids}

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy({
                "state": self._state, "code": self._code, "message": self._message,
                "device": self._device, "baudrate": self._baudrate,
                "checked_at": self._checked_at, "ports": _ports(),
                "preferred_connection": robot_devices.preferred_connection(self.component),
                "motors": list(self._motors.values()), "port_open": self._port is not None,
                "dependency_available": self._sdk is not None or _dependency_available(),
            })

    def _set_error(self, state: str, code: str, message: str, *, reset: bool = False) -> None:
        self._state, self._code, self._message = state, code, message
        if reset:
            self._motors = {motor_id: _unknown_motor(motor_id) for motor_id in self.ids}

    def _close_port(self) -> None:
        port, self._port, self._packet = self._port, None, None
        if port is not None:
            try:
                port.closePort()
            except Exception:
                pass

    def _selection_changed(self) -> None:
        pass

    def _select(self, device: str | None, baudrate: int | None) -> None:
        if device is not None and (not isinstance(device, str) or not _DEVICE_PATTERN.fullmatch(device)):
            raise ValueError("Choose a USB serial device (cu.usbserial, cu.usbmodem, ttyUSB, ttyACM or COM).")
        if baudrate is not None:
            baudrate = _integer(baudrate, "Baud rate", min(BAUDRATES), max(BAUDRATES))
            if baudrate not in BAUDRATES:
                raise ValueError("Choose a supported baud rate: " + ", ".join(map(str, BAUDRATES)) + ".")
        next_device = self._device if device is None else device
        next_baudrate = self._baudrate if baudrate is None else baudrate
        if (next_device, next_baudrate) != (self._device, self._baudrate):
            self._close_port()
            self._device, self._baudrate = next_device, next_baudrate
            self._selection_changed()

    def _open(self) -> bool:
        if self._closed:
            self._set_error("disconnected", "closed", f"{self.component.title()} control is closed.", reset=True)
            return False
        if self._port is not None:
            return True
        if not self._device:
            self._set_error("unchecked", "device_required", f"Select the {self.component} USB serial adapter first.", reset=True)
            return False
        if self._sdk is None:
            try:
                self._sdk = importlib.import_module("dynamixel_sdk")
            except Exception as error:
                self._set_error("error", "dependency_missing",
                                "The Dynamixel driver could not load. Install requirements-robot.txt in the "
                                f"dashboard's Python environment. ({error})", reset=True)
                return False
        present = (any(_connection_key(port) == _connection_key(self._device) for port in _ports())
                   if self._device.upper().startswith("COM") else os.path.exists(self._device))
        if not present:
            self._set_error("disconnected", "device_missing",
                            f"{self.component.title()} USB adapter not found: {self._device}. "
                            "Connect the adapter or select its serial port.", reset=True)
            return False
        try:
            self._port = self._sdk.PortHandler(self._device)
            self._packet = self._sdk.PacketHandler(2.0)
            if not self._port.openPort():
                raise OSError("The driver could not open the serial port")
            try:
                if not self._port.setBaudRate(self._baudrate):
                    raise OSError("The driver rejected the baud rate")
            except Exception as error:
                self._close_port()
                self._set_error("error", "baudrate_failed",
                                f"Could not set {self._device} to {self._baudrate} baud: {error}.", reset=True)
                return False
            # setBaudRate recreates the pyserial object; request exclusive access
            # only after that operation. This is advisory, not cross-process proof.
            serial = getattr(self._port, "ser", None)
            if serial is not None and hasattr(serial, "exclusive"):
                try:
                    serial.exclusive = True
                except (AttributeError, NotImplementedError):
                    pass
            return True
        except Exception as error:
            self._close_port()
            self._set_error("error", "serial_open_failed",
                            f"Cannot open {self.component} adapter {self._device}: {error}. "
                            "Stop interaction.py or other software using this adapter and check USB permissions.", reset=True)
            return False

    def _errors(self, communication: int, packet_error: int) -> list[str]:
        errors = []
        if communication != self._sdk.COMM_SUCCESS:
            errors.append(str(self._packet.getTxRxResult(communication)))
        if packet_error:
            errors.append(str(self._packet.getRxPacketError(packet_error)))
        return errors

    def _read(self, motor_id: int, *, limits: bool = False, guard=None) -> dict[str, Any]:
        row = _unknown_motor(motor_id)
        errors = []
        try:
            if guard:
                guard()
            position, communication, packet_error = self._packet.read4ByteTxRx(self._port, motor_id, 132)
            if guard:
                guard()
            row["connected"] = communication == self._sdk.COMM_SUCCESS
            errors.extend(self._errors(communication, packet_error))
            if not errors:
                row["position"] = _signed_position(position)
                for address, key in ((64, "torque_enabled"), (70, "hardware_error"),
                                     (10, "profile_mode"), (11, "operating_mode")):
                    if guard:
                        guard()
                    value, communication, packet_error = self._packet.read1ByteTxRx(self._port, motor_id, address)
                    if guard:
                        guard()
                    read_errors = self._errors(communication, packet_error)
                    errors.extend(read_errors)
                    if read_errors:
                        continue
                    if key == "torque_enabled":
                        if value in (0, 1):
                            row[key] = bool(value)
                        else:
                            errors.append(f"Unexpected torque register value {value}")
                    elif key == "hardware_error":
                        if value:
                            errors.append(f"Motor hardware fault (register 70: 0x{value:02x})")
                    elif key == "profile_mode":
                        row["drive_mode"] = value
                        row[key] = "time" if value & 4 else "velocity"
                    else:
                        row[key] = value
                if limits:
                    for address, key in ((52, "device_min_position"), (48, "device_max_position")):
                        if guard:
                            guard()
                        value, communication, packet_error = self._packet.read4ByteTxRx(self._port, motor_id, address)
                        if guard:
                            guard()
                        read_errors = self._errors(communication, packet_error)
                        errors.extend(read_errors)
                        row[key] = value if not read_errors else None
        except DrumPerformanceSessionError:
            raise
        except Exception as error:
            errors.append(f"Serial communication failed: {error}")
        row["error"] = "; ".join(errors) or None
        return row

    def _result(self, ok: bool, message: str) -> dict[str, Any]:
        result = {"ok": ok, "message": message, self.component: self.snapshot()}
        if not ok:
            result["error"] = message
        return result

    def disconnect(self) -> dict[str, Any]:
        with self._lock:
            self._close_port()
            self._set_error("disconnected", "disconnected",
                            f"{self.component.title()} serial connection closed. Motor torque is unchanged.", reset=True)
            return self.snapshot()

    def close(self) -> None:
        with self._lock:
            self.disconnect()
            self._closed = True


class DrumController(_SerialController):
    component = "drums"
    ids = DRUM_IDS

    def __init__(self) -> None:
        preferred = robot_devices.preferred_connection(self.component)
        super().__init__(preferred.get("device") if preferred["state"] == "matched" else None,
                         preferred.get("baudrate") or 1_000_000)
        self._verified_device: str | None = None
        self._stop_requested = threading.Event()
        self._stop_version = object()
        self._strike_cancel = threading.Event()
        self._strike_thread: threading.Thread | None = None
        self._strike = {"state": "idle", "motor_id": None, "origin": None, "rest_position": None, "strike_position": None,
                        "started_at": None, "finished_at": None, "error": None}
        from robot_drum_performance import DrumPerformance
        self.performance = DrumPerformance(self)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            self._refresh_strike_cancellation()
            performance = self.performance.snapshot()
            return {**super().snapshot(), "strike": copy.deepcopy(self._strike),
                    "performance": performance, "busy": self._busy() or performance["busy"]}

    def _refresh_strike_cancellation(self) -> None:
        if self._busy() and (self._strike_cancel.is_set() or self._stop_requested.is_set()):
            self._finish_strike("cancelled", "Drum strike cancelled.")

    def _busy(self) -> bool:
        return self._strike["state"] in ("preparing", "striking", "returning")

    def _finish_strike(self, state: str, error: str | None = None) -> None:
        self._strike.update(state=state, finished_at=_now(), error=error)

    def _cancel_strike(self, message: str = "Drum strike cancelled.") -> None:
        self._strike_cancel.set()
        self.performance.invalidate()
        if self._busy():
            self._finish_strike("cancelled", message)

    def request_stop(self) -> None:
        """Interrupt waits and latch cancellation without acquiring the serial lock."""
        self._stop_requested.set()
        self._stop_version = object()
        self._strike_cancel.set()
        self.performance.invalidate()

    def reset_stop(self) -> None:
        # Keep reset independent of an in-flight serial read. The old job's
        # event stays set, even though new commands may use the cleared latch.
        self._strike_cancel.set()
        self._stop_requested.clear()

    def _stopped(self, version: object) -> bool:
        return self._stop_requested.is_set() or version is not self._stop_version

    def _stopped_result(self) -> dict[str, Any]:
        return self._result(False, "Drum command cancelled by emergency stop. Enable drum torque before continuing.")

    def _close_port(self) -> None:
        self._cancel_strike("Drum connection closed; strike cancelled.")
        self.performance.invalidate()
        self._verified_device = None
        super()._close_port()

    def emergency_stop(self) -> dict[str, Any]:
        self.request_stop()
        with self._lock:
            self._cancel_strike("Emergency stop cancelled the drum strike.")
            if self._port is None or self._verified_device != self._device:
                return {**self._result(True, "Drum release skipped: no verified open drum connection."), "skipped": True}
            return self._write_torque(False, self._stop_version)

    def check(self, device: str | None = None, baudrate: int | None = None) -> dict[str, Any]:
        with self._lock:
            if self.performance.snapshot()["busy"]:
                raise ValueError("Stop the drum performance before checking its connection.")
            self._select(device, baudrate)
            self._checked_at = _now()
            if not self._open():
                return self.snapshot()
            self._motors = {motor_id: self._read(motor_id) for motor_id in self.ids}
            healthy = [row for row in self._motors.values() if row["connected"] and not row["error"]]
            if len(healthy) == len(self.ids):
                self._state, self._code = "ready", "connected"
                self._verified_device = self._device
                self._message = "All four drum motors responded. The connection check does not move them or change torque."
            else:
                responding = any(row["connected"] for row in self._motors.values())
                failures = [f"Drum {row['id']}: {row['error'] or 'no response'}"
                            for row in self._motors.values() if row not in healthy]
                self._set_error("partial" if responding else "disconnected",
                                "motor_error" if responding else "motors_unreachable",
                                f"{len(healthy)}/4 drum motors responded without errors at {self._baudrate:,} baud. "
                                + " ".join(failures) + " Check motor power, the bus cable, baud rate, and IDs 0, 1, 2, 3.")
                if not responding:
                    self._close_port()
            return self.snapshot()

    def move(self, targets: list[tuple[int, int, int]]) -> dict[str, Any]:
        with self._lock:
            stop_version = self._stop_version
            if not isinstance(targets, list) or not 1 <= len(targets) <= len(self.ids):
                raise ValueError("Provide between one and four drum targets.")
            checked, seen = [], set()
            for target in targets:
                if not isinstance(target, (list, tuple)) or len(target) != 3:
                    raise ValueError("Each drum target must contain motor ID, position and duration.")
                motor_id = _integer(target[0], "Drum motor ID", 0, 3)
                if motor_id in seen:
                    raise ValueError("Select each drum motor ID at most once.")
                seen.add(motor_id)
                checked.append((motor_id, _integer(target[1], f"Drum {motor_id} position", *DRUM_BOUNDS[motor_id]),
                                _integer(target[2], "Duration", 100, 5000)))
            if self._stopped(stop_version):
                return self._stopped_result()
            self._refresh_strike_cancellation()
            if self.performance.snapshot()["busy"]:
                return self._result(False, "Stop the drum performance before moving arms manually.")
            if self._busy():
                return self._result(False, "A drum strike is running. Wait for its return or release drum torque to cancel it.")
            if self._port is None or self._state != "ready":
                return self._result(False, "Check the drum connection successfully before moving motors. " + self._message)
            self.check()
            if self._state != "ready":
                return self._result(False, "Drum movement cancelled before any writes. " + self._message)
            incompatible = [motor_id for motor_id, _, _ in checked
                            if self._motors[motor_id]["profile_mode"] != "time"
                            or self._motors[motor_id]["operating_mode"] not in (3, 4)]
            if incompatible:
                message = ("Movement requires time-based profiles and position mode for drum motors "
                           + ", ".join(map(str, incompatible)) + ". No registers were written.")
                self._set_error("error", "profile_incompatible", message)
                return self._result(False, message)
            torque_off = [motor_id for motor_id, _, _ in checked if not self._motors[motor_id]["torque_enabled"]]
            if torque_off:
                return self._result(False, "Drum torque is off for motors " + ", ".join(map(str, torque_off))
                                    + ". Enable drum torque before moving them.")
            for motor_id, position, duration in checked:
                for address, value, label in ((112, duration, "movement profile"), (116, position, "goal position")):
                    if self._stopped(stop_version):
                        return self._stopped_result()
                    try:
                        communication, packet_error = self._packet.write4ByteTxRx(self._port, motor_id, address, value)
                        errors = self._errors(communication, packet_error)
                    except Exception as error:
                        errors = [str(error)]
                    if errors:
                        message = (f"Drum {motor_id} {label} write failed: {'; '.join(errors)}. "
                                   "Some commands may have taken effect; check the connection again before continuing.")
                        self._motors[motor_id]["error"] = "; ".join(errors)
                        self._set_error("error", "write_failed", message)
                        return self._result(False, message)
            return self._result(True, f"Movement registers acknowledged by {len(checked)} drum motor(s). "
                                "Target arrival has not been measured.")

    def torque(self, enabled: bool) -> dict[str, Any]:
        with self._lock:
            stop_version = self._stop_version
            if not isinstance(enabled, bool):
                raise ValueError("Enabled must be true or false.")
            if enabled and self._stopped(stop_version):
                return self._stopped_result()
            self._refresh_strike_cancellation()
            if enabled and self.performance.snapshot()["busy"]:
                return self._result(False, "Stop the drum performance before changing arm torque.")
            if enabled and self._busy():
                return self._result(False, "A drum strike is running. Wait for its return before enabling torque.")
            if not enabled:
                self.performance.invalidate()
                self._cancel_strike("Drum torque release cancelled the strike.")
            # Identify a new bus before any writes. A previously verified open
            # bus still permits best-effort release when one arm develops a fault.
            if enabled or self._port is None or self._verified_device != self._device:
                self.check()
                if self._state != "ready":
                    return self._result(False, "Drum torque was not changed. " + self._message)
            if enabled:
                incompatible = [motor_id for motor_id in self.ids if self._motors[motor_id]["operating_mode"] not in (3, 4)]
                if incompatible:
                    message = ("Drum torque was not enabled because motors " + ", ".join(map(str, incompatible))
                               + " are not in position mode. No registers were written.")
                    self._set_error("error", "operating_mode_incompatible", message)
                    return self._result(False, message)
                return self._torque_to_rest(stop_version)
            return self._write_torque(enabled, stop_version)

    def _rest_read(self, motor_id: int, address: int, stop_version: object, size: int = 4) -> int:
        if self._stopped(stop_version):
            raise RuntimeError("Drum rest movement cancelled by emergency stop.")
        method = self._packet.read1ByteTxRx if size == 1 else self._packet.read4ByteTxRx
        value, communication, packet_error = method(self._port, motor_id, address)
        errors = self._errors(communication, packet_error)
        if errors:
            raise RuntimeError(f"Drum {motor_id} register {address} read failed: {'; '.join(errors)}.")
        return value

    def _torque_to_rest(self, stop_version: object) -> dict[str, Any]:
        """Preload fixed rest goals, enable, and confirm arrival before any hits.

        Current positions need not be inside the playing range. This exception
        only applies to returning to the fixed rest targets; strikes retain
        their normal bounds and fresh read-back checks.
        """
        from robot_drum_performance import DRUM_PROFILES
        rests = {motor_id: DRUM_PROFILES[motor_id]["rest"] for motor_id in self.ids}
        try:
            # Check the entire bus before writing any profiles or goals. A goal
            # update must not silently power an OFF arm during preloading.
            for motor_id, row in self._motors.items():
                if type(row["position"]) is not int:
                    raise RuntimeError(f"Drum {motor_id} position could not be read.")
                if row["profile_mode"] != "time":
                    raise RuntimeError(f"Drum {motor_id} requires time-based profiles to move to rest.")
                if row["drive_mode"] & 8:
                    raise RuntimeError(f"Drum {motor_id} has automatic torque-on by goal update enabled.")
                if row["operating_mode"] == 3:
                    minimum = self._rest_read(motor_id, 52, stop_version)
                    maximum = self._rest_read(motor_id, 48, stop_version)
                    if not 0 <= minimum <= rests[motor_id] <= maximum <= 4095:
                        raise RuntimeError(f"Drum {motor_id} rest target is outside its device position limits.")
            for address in (112, 116):
                for motor_id in self.ids:
                    if self._stopped(stop_version):
                        return self._stopped_result()
                    value = DRUM_TORQUE_REST_MS if address == 112 else rests[motor_id]
                    communication, packet_error = self._packet.write4ByteTxRx(self._port, motor_id, address, value)
                    errors = self._errors(communication, packet_error)
                    if errors:
                        raise RuntimeError(f"Drum {motor_id} rest register {address} write failed: {'; '.join(errors)}.")
            # Preserve acceleration(108): later hits use their existing profiles.
            # All four rest goals replace old goals before the first torque-on.
            for motor_id in self.ids:
                for address, expected in ((112, DRUM_TORQUE_REST_MS), (116, rests[motor_id])):
                    if self._rest_read(motor_id, address, stop_version) != expected:
                        raise RuntimeError(f"Drum {motor_id} rest profile or goal read-back did not match.")
            result = self._write_torque(True, stop_version)
            if not result["ok"]:
                return result
            deadline = time.monotonic() + DRUM_TORQUE_REST_MS / 1000 + 2
            while True:
                if self._stopped(stop_version):
                    return self._stopped_result()
                arrived = True
                for motor_id in self.ids:
                    row = self._read(motor_id)
                    self._motors[motor_id] = row
                    if not row["connected"] or row["error"]:
                        raise RuntimeError(f"Drum {motor_id} rest read-back failed: {row['error'] or 'no response'}.")
                    if row["torque_enabled"] is not True:
                        raise RuntimeError(f"Drum {motor_id} torque was not confirmed on during its move to rest.")
                    moving = self._rest_read(motor_id, 122, stop_version, 1)
                    minimum, maximum = DRUM_BOUNDS[motor_id]
                    arrived = (arrived and minimum <= row["position"] <= maximum
                               and abs(row["position"] - rests[motor_id]) <= DRUM_REST_THRESHOLD and moving == 0)
                self._checked_at = _now()
                if self._stopped(stop_version):
                    return self._stopped_result()
                if arrived:
                    self._message = "All four drum motors have torque on and their raised rest positions are confirmed."
                    return self._result(True, self._message)
                if time.monotonic() >= deadline:
                    raise RuntimeError("The drum arms did not confirm their raised rest positions before the timeout.")
                self._stop_requested.wait(0.05)
        except Exception as error:
            message = f"Drum rest movement could not be confirmed: {error} No strike was sent."
            self._set_error("error", "rest_failed", message)
            return self._result(False, message)

    def _write_torque(self, enabled: bool, stop_version: object) -> dict[str, Any]:
        failures = []
        for motor_id in self.ids:
            if enabled and self._stopped(stop_version):
                return self._stopped_result()
            try:
                communication, packet_error = self._packet.write1ByteTxRx(self._port, motor_id, 64, int(enabled))
                errors = self._errors(communication, packet_error)
            except Exception as error:
                errors = [str(error)]
            if errors:
                self._motors[motor_id]["torque_enabled"] = None
                self._motors[motor_id]["error"] = "; ".join(errors)
                failures.append(f"Drum {motor_id}: {'; '.join(errors)}")
                if enabled:
                    break
            else:
                self._motors[motor_id]["torque_enabled"] = enabled
        if failures:
            message = ("Drum torque could not be confirmed for every motor. " + " ".join(failures)
                       + " Some motors may have changed torque; check the connection again.")
            self._set_error("error", "torque_failed", message)
            return self._result(False, message)
        return self._result(True, "All four drum motors acknowledged torque " + ("on." if enabled else "off."))

    def _strike_preflight(self, motor_id: int, *, require_ready: bool = True) -> str | None:
        if self._port is None or (require_ready and self._state != "ready"):
            return "Check all four drum connections successfully before a strike. " + self._message
        row = self._motors[motor_id]
        if row["profile_mode"] != "time" or row["operating_mode"] not in (3, 4):
            return f"Drum {motor_id} requires time-based profiles and position mode."
        if row["torque_enabled"] is not True:
            return f"Drum {motor_id} torque is off. Enable drum torque before testing a strike."
        return None

    def _strike_write(self, motor_id: int, position: int, duration: int,
                      cancelled: threading.Event, stop_version: object, *,
                      deadline_ms: float | None = None, clock=None) -> str | None:
        for address, value in ((112, duration), (116, position)):
            error = self._strike_register(motor_id, address, value, cancelled, stop_version,
                                          deadline_ms=deadline_ms, clock=clock)
            if error:
                return error
        return None

    def _strike_register(self, motor_id: int, address: int, value: int,
                         cancelled: threading.Event, stop_version: object, *,
                         deadline_ms: float | None = None, clock=None) -> str | None:
        if cancelled.is_set() or self._stopped(stop_version):
            return "Drum strike cancelled before the next register write."
        if deadline_ms is not None and clock() > deadline_ms:
            from robot_drum_performance import DrumPerformanceLate
            raise DrumPerformanceLate("Drum strike deadline passed during serial read-back.")
        try:
            communication, packet_error = self._packet.write4ByteTxRx(self._port, motor_id, address, value)
            errors = self._errors(communication, packet_error)
        except Exception as error:
            errors = [str(error)]
        if errors:
            self._motors[motor_id]["error"] = "; ".join(errors)
            return f"Drum {motor_id} register {address} write failed: {'; '.join(errors)}. Position is uncertain."
        return None

    def _performance_context(self):
        return self._port, self._packet, self._device, self._baudrate, self._stop_version

    def _performance_guard(self, cancelled, context):
        if cancelled.is_set() or self._stop_requested.is_set() or self._closed:
            raise DrumPerformanceSessionError("Drum performance cancelled before serial access.")
        if (self._port is None or self._packet is None or self._verified_device != self._device
                or context != self._performance_context()):
            raise DrumPerformanceSessionError("The verified drum connection changed or is no longer open.")

    def _performance_register(self, motor_id, address, value, cancelled, context, **kwargs):
        self._performance_guard(cancelled, context)
        error = self._strike_register(motor_id, address, value, cancelled, context[4], **kwargs)
        self._performance_guard(cancelled, context)
        if error:
            raise RuntimeError(error)

    def _performance_read(self, motor_id: int, cancelled: threading.Event,
                          *, allow_outside_bounds: bool = False) -> dict[str, Any]:
        context = self._performance_context()
        self._performance_guard(cancelled, context)
        row = self._read(motor_id, guard=lambda: self._performance_guard(cancelled, context))
        self._motors[motor_id] = row
        self._checked_at = _now()
        self._performance_guard(cancelled, context)
        if not row["connected"] or row["error"]:
            message = f"Drum {motor_id} read-back failed: {row['error'] or 'no response'}."
            self._set_error("partial", "motor_error", message)
            raise RuntimeError(message)
        error = self._strike_preflight(motor_id, require_ready=False)
        if error:
            raise RuntimeError(error)
        minimum, maximum = DRUM_BOUNDS[motor_id]
        if type(row["position"]) is not int:
            raise RuntimeError(f"Drum {motor_id} position could not be read.")
        if not allow_outside_bounds and not minimum <= row["position"] <= maximum:
            raise DrumPerformanceBounds(f"Drum {motor_id} position is outside its {minimum}–{maximum} bounds.")
        return row

    def performance_recover(self, motor_id: int, cancelled: threading.Event) -> dict[str, int]:
        """Return one healthy powered arm to its fixed rest, allowing an outside start."""
        from robot_drum_performance import DRUM_PROFILES
        with self._lock:
            motor_id = _integer(motor_id, "Drum motor ID", 0, 3)
            context = self._performance_context()
            row = self._performance_read(motor_id, cancelled, allow_outside_bounds=True)
            self._performance_guard(cancelled, context)
            if row["drive_mode"] & 8:
                raise RuntimeError(f"Drum {motor_id} has automatic torque-on by goal update enabled.")
            minimum, maximum = DRUM_BOUNDS[motor_id]
            target = max(minimum + 10, min(maximum - 10, DRUM_PROFILES[motor_id]["rest"]))
            if row["operating_mode"] == 3:
                limits = []
                for address in (52, 48):
                    self._performance_guard(cancelled, context)
                    value, communication, packet_error = self._packet.read4ByteTxRx(self._port, motor_id, address)
                    self._performance_guard(cancelled, context)
                    errors = self._errors(communication, packet_error)
                    if errors:
                        raise RuntimeError(f"Drum {motor_id} register {address} read failed: {'; '.join(errors)}.")
                    limits.append(value)
                if not all(type(value) is int for value in limits) or not 0 <= limits[0] <= target <= limits[1] <= 4095:
                    raise RuntimeError(f"Drum {motor_id} rest target is outside its device position limits.")
            # Native time profile; no torque/configuration writes and no retry.
            for address, value in ((112, DRUM_TORQUE_REST_MS), (116, target)):
                self._performance_register(motor_id, address, value, cancelled, context)
            return {"target": target, "duration_ms": DRUM_TORQUE_REST_MS}

    def performance_prepare(self, instruments: list[int], cancelled: threading.Event) -> None:
        from robot_drum_performance import DRUM_PROFILES, PREPARE_MS
        with self._lock:
            context = self._performance_context()
            self._refresh_strike_cancellation()
            if self._busy():
                raise RuntimeError("Wait for the manual drum strike to finish before starting a performance.")
            if self._state != "ready":
                raise RuntimeError("Check the drum connection successfully before starting a performance.")
            # Validate every selected arm before any arm is moved.
            for motor_id in instruments:
                self._performance_read(motor_id, cancelled)
            for motor_id in instruments:
                for address, value in ((112, PREPARE_MS), (116, DRUM_PROFILES[motor_id]["rest"])):
                    self._performance_register(motor_id, address, value, cancelled, context)

    def performance_verify(self, motor_id: int, rest: int, cancelled: threading.Event) -> None:
        with self._lock:
            from robot_drum_performance import DrumPerformanceSettling
            row = self._performance_read(motor_id, cancelled)
            if abs(row["position"] - rest) > DRUM_REST_THRESHOLD:
                raise DrumPerformanceSettling(f"Drum {motor_id} raised rest was not confirmed: read {row['position']}, "
                                             f"expected {rest} ± {DRUM_REST_THRESHOLD}. No hit was sent.")

    def performance_move(self, motor_id: int, target: int, duration: int, cancelled: threading.Event,
                         *, deadline_ms: float | None = None, clock=None) -> None:
        with self._lock:
            context = self._performance_context()
            self._performance_read(motor_id, cancelled)
            for address, value in ((112, duration), (116, target)):
                self._performance_register(motor_id, address, value, cancelled, context,
                                           deadline_ms=deadline_ms, clock=clock)

    def performance_stage(self, motor_id: int, rest: int, target: int, duration: int,
                          cancelled: threading.Event, *, deadline_ms: float, clock) -> dict[str, Any]:
        """Check a stationary arm and set its profile ahead of the timed goal.

        The ticket is private to the scheduler, bound to this verified bus and
        cancellation generation, and can authorize only one matching goal.
        Manual movement and connection checks remain excluded during a session.
        """
        with self._lock:
            from robot_drum_performance import DrumPerformanceLate, DrumPerformanceSettling
            context = self._performance_context()
            sampled_ms = clock()
            if sampled_ms > deadline_ms:
                raise DrumPerformanceLate("Drum preflight started after its dispatch time.")
            target = _integer(target, "Strike position", *DRUM_BOUNDS[motor_id])
            duration = _integer(duration, "Strike duration", 100, 5000)
            row = self._performance_read(motor_id, cancelled)
            if abs(row["position"] - rest) > DRUM_REST_THRESHOLD:
                raise DrumPerformanceSettling(f"Drum {motor_id} raised rest was not confirmed: read {row['position']}, "
                                             f"expected {rest} ± {DRUM_REST_THRESHOLD}. No hit was sent.")
            self._performance_register(motor_id, 112, duration, cancelled, context,
                                       deadline_ms=deadline_ms, clock=clock)
            if clock() > deadline_ms:
                raise DrumPerformanceLate("Drum profile preparation finished after its dispatch time.")
            return {"motor_id": motor_id, "target": target, "context": context,
                    "cancelled": cancelled, "sampled_ms": sampled_ms, "used": False}

    def performance_commit(self, motor_id: int, target: int, ticket: dict[str, Any],
                           cancelled: threading.Event, *, deadline_ms: float, clock,
                           max_age_ms: float) -> None:
        """Send only the timely goal after an unchanged, bounded fresh preflight."""
        with self._lock:
            from robot_drum_performance import DrumPerformanceLate
            if (ticket.get("used") or ticket.get("motor_id") != motor_id
                    or ticket.get("target") != target or ticket.get("cancelled") is not cancelled):
                raise DrumPerformanceSessionError("The prepared drum goal is no longer valid.")
            # Consume before any potentially failing operation: an uncertain
            # goal acknowledgement must never cause this strike to be retried.
            ticket["used"] = True
            context = ticket.get("context")
            self._performance_guard(cancelled, context)
            age = clock() - ticket["sampled_ms"]
            if not 0 <= age <= max_age_ms:
                raise DrumPerformanceLate("Drum preflight expired before its timed goal.")
            self._performance_register(motor_id, 116, target, cancelled, context,
                                       deadline_ms=deadline_ms, clock=clock)

    def strike(self, motor_id: int, strike_position: int, duration_ms: int,
               return_duration_ms: int = 150, *, rest_position: int,
               prepare_duration_ms: int = 500) -> dict[str, Any]:
        with self._lock:
            stop_version = self._stop_version
            motor_id = _integer(motor_id, "Drum motor ID", 0, 3)
            strike_position = _integer(strike_position, "Strike position", *DRUM_BOUNDS[motor_id])
            rest_position = _integer(rest_position, "Raised rest position", *DRUM_BOUNDS[motor_id])
            duration_ms = _integer(duration_ms, "Strike duration", 100, 5000)
            return_duration_ms = _integer(return_duration_ms, "Return duration", 100, 5000)
            prepare_duration_ms = _integer(prepare_duration_ms, "Preparation duration", 100, 5000)
            if self._stopped(stop_version):
                return self._stopped_result()
            self._refresh_strike_cancellation()
            if self.performance.snapshot()["busy"]:
                return self._result(False, "Stop the drum performance before testing an arm strike.")
            if self._busy():
                return self._result(False, "A drum strike is already running. Strike tests are not queued.")
            if self._port is None or self._state != "ready":
                return self._result(False, "Check the drum connection successfully before testing a strike.")
            self.check()
            error = self._strike_preflight(motor_id)
            if error:
                return self._result(False, error)
            origin = self._motors[motor_id]["position"]
            self._strike = {"state": "preparing", "motor_id": motor_id, "origin": origin, "rest_position": rest_position,
                            "strike_position": strike_position, "started_at": _now(), "finished_at": None, "error": None}
            self._strike_cancel = threading.Event()
            cancelled = self._strike_cancel
            if type(origin) is not int or not DRUM_BOUNDS[motor_id][0] <= origin <= DRUM_BOUNDS[motor_id][1]:
                error = (f"Drum {motor_id} currently reads {origin}, outside its configured range "
                         f"{DRUM_BOUNDS[motor_id][0]}–{DRUM_BOUNDS[motor_id][1]}. "
                         "No preparation or strike was sent; the starting position must be inside that range.")
                self._finish_strike("error", error)
                return self._result(False, error)
            error = self._strike_write(motor_id, rest_position, prepare_duration_ms, cancelled, stop_version)
            if error:
                self._finish_strike("cancelled" if cancelled.is_set() or self._stopped(stop_version) else "error", error)
                return self._result(False, error)
            self._strike_thread = threading.Thread(target=self._strike_cycle,
                args=(motor_id, rest_position, strike_position, duration_ms, return_duration_ms,
                      prepare_duration_ms, cancelled, stop_version),
                name="drum-strike-cycle", daemon=True)
            self._strike_thread.start()
            return self._result(True, f"Drum {motor_id} is preparing at its raised rest position, {rest_position} ticks, "
                                "before the strike and return to that same rest position.")

    def _strike_cycle(self, motor_id: int, rest_position: int, strike_position: int,
                      duration_ms: int, return_duration_ms: int, prepare_duration_ms: int,
                      cancelled: threading.Event, stop_version: object) -> None:
        try:
            for phase, wait_ms in (("striking", prepare_duration_ms), ("returning", duration_ms),
                                   ("complete", return_duration_ms)):
                interrupted = cancelled.wait(wait_ms / 1000)
                with self._lock:
                    if cancelled is not self._strike_cancel:
                        return
                    if interrupted or cancelled.is_set() or self._stopped(stop_version) or self._closed:
                        self._finish_strike("cancelled", "Drum strike cancelled; no further motion was commanded.")
                        return
                    if self._port is None or self._verified_device != self._device:
                        self._finish_strike("error", "The verified drum connection is no longer open.")
                        return
                    # Reading unrelated arms would add dwell at the strike.
                    # The whole bus was verified before preparation; only this
                    # arm needs fresh checks between cycle phases.
                    row = self._read(motor_id)
                    self._motors[motor_id] = row
                    self._checked_at = _now()
                    if cancelled.is_set() or self._stopped(stop_version):
                        self._finish_strike("cancelled", "Drum strike cancelled; no further motion was commanded.")
                        return
                    if not row["connected"] or row["error"]:
                        error = f"Drum {motor_id} read-back failed: {row['error'] or 'no response'}."
                        self._set_error("partial", "motor_error", error)
                        self._finish_strike("error", error)
                        return
                    error = self._strike_preflight(motor_id, require_ready=False)
                    if error:
                        self._finish_strike("error", error)
                        return
                    if phase == "striking" and abs(row["position"] - rest_position) > DRUM_REST_THRESHOLD:
                        self._finish_strike("error", f"Drum {motor_id} raised rest was not confirmed: "
                            f"read {row['position']} ticks, expected {rest_position} ± {DRUM_REST_THRESHOLD}. "
                            "No hit was sent.")
                        return
                    if phase in ("striking", "returning"):
                        self._strike["state"] = phase
                        target = strike_position if phase == "striking" else rest_position
                        duration = duration_ms if phase == "striking" else return_duration_ms
                        error = self._strike_write(motor_id, target, duration, cancelled, stop_version)
                        if error:
                            self._finish_strike("cancelled" if cancelled.is_set() or self._stopped(stop_version) else "error", error)
                            return
                    else:
                        self._finish_strike("complete")
                        self._message = (f"Strike and return sequence finished for drum {motor_id}; "
                                         f"read-back is {self._motors[motor_id]['position']} ticks "
                                         f"(raised rest {rest_position}).")
        except Exception as error:
            with self._lock:
                if cancelled is self._strike_cancel:
                    self._finish_strike("error", f"Drum cycle failed: {error}. Position is uncertain.")


class HeadController(_SerialController):
    component = "head"

    def __init__(self, calibration_path: str | Path | None = DEFAULT_HEAD_CALIBRATION_PATH) -> None:
        preferred = robot_devices.preferred_connection(self.component)
        super().__init__(preferred.get("device") if preferred["state"] == "matched" else None,
                         preferred.get("baudrate") or 57_600)
        self._upright_reference: dict[str, Any] | None = None
        self._identified_ids: tuple[int, ...] = ()
        self._verified_connection = None
        self._stop_requested = threading.Event()
        self._stop_version = object()
        self._last_move = None
        self._axis_motion: dict[int, dict[str, Any]] = {}
        self._motion_uncertain_until = 0.0
        self._calibration_path = Path(calibration_path).expanduser().resolve() if calibration_path is not None else None
        self._saved_calibration: dict[str, Any] | None = None
        self._storage_error: str | None = None
        self._sample_stop = threading.Event()
        self._sample_thread: threading.Thread | None = None
        self._reset_calibration()
        self._load_calibration()
        self._message = "Select the head adapter to identify both axes without moving them or changing torque."

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            state = super().snapshot()
            state["upright_reference"] = copy.deepcopy(self._upright_reference)
            state["last_move"] = copy.deepcopy(self._last_move)
            now = time.monotonic()
            state["motion"] = [{"motor_id": motor_id, "position": motion["position"],
                                "duration_ms": motion["duration_ms"],
                                "remaining_ms": math.ceil((motion["until"] - now) * 1000)}
                               for motor_id, motion in self._axis_motion.items() if motion["until"] > now]
            state["busy"] = bool(state["motion"])
            state["motion_limits"] = {"min_duration_ms": HEAD_MIN_DURATION_MS,
                                      "max_duration_ms": HEAD_MAX_DURATION_MS,
                                      "max_speed_ticks_per_second": HEAD_MAX_SPEED_TICKS_PER_SECOND}
            state["calibration"] = {
                **copy.deepcopy(self._calibration), "saved": copy.deepcopy(self._saved_calibration),
                "saved_connection": self._saved_connection(),
                "saved_matches_connection": self._saved_matches_connection(), "storage_error": self._storage_error,
            }
            return state

    @property
    def _motion_until(self) -> float:
        return max((motion["until"] for motion in self._axis_motion.values()), default=0.0)

    def motion_sample(self) -> dict[str, Any]:
        """Read one bounded telemetry sample; never discover, open or move a bus."""
        with self._lock:
            context = (self._port, self._packet, self._device, self._baudrate, self._identified_ids)
            version = self._stop_version

            def guard() -> None:
                if self._calibration["recording"]:
                    raise OSError("Stop manual head range recording before sampling motion diagnostics.")
                if (self._closed or self._port is None or self._packet is None
                        or len(self._identified_ids) != 2
                        or tuple(sorted(self._motors)) != self._identified_ids
                        or self._verified_connection != (self._device, self._baudrate, self._identified_ids)
                        or context != (self._port, self._packet, self._device, self._baudrate, self._identified_ids)):
                    raise OSError("Identify the open head connection before sampling motion diagnostics.")
                # A latched stop is compatible with reading diagnostics. A new
                # stop/close/disconnect interrupts this sample between packets.
                if version is not self._stop_version:
                    raise OSError("Head diagnostics interrupted by stop or connection change.")

            def read(motor_id: int, address: int, size: int, *, signed: bool = False) -> int:
                guard()
                method = {1: self._packet.read1ByteTxRx, 2: self._packet.read2ByteTxRx,
                          4: self._packet.read4ByteTxRx}[size]
                value, communication, packet_error = method(self._port, motor_id, address)
                guard()
                errors = self._errors(communication, packet_error)
                if errors:
                    raise OSError(f"Head {motor_id} diagnostic register {address} read failed: {'; '.join(errors)}.")
                if signed and value >= 1 << (size * 8 - 1):
                    value -= 1 << (size * 8)
                return value

            try:
                guard()
                started = time.monotonic()
                sample: dict[str, Any] = {"sampled_at": _now(), "motors": []}
                for motor_id in self._identified_ids:
                    model = read(motor_id, 0, 2)
                    if model != HEAD_MODEL:
                        message = f"Head {motor_id} reported model {model}; expected 2XL430-W250-T (1090). Identify the head again."
                        self._verified_connection = None
                        self._upright_reference = None
                        self._motors[motor_id].update(model_number=model, error=message)
                        self._set_error("error", "unexpected_model", message)
                        raise OSError(message)
                    row: dict[str, Any] = {"id": motor_id, "model_number": model, "sampled_at": _now()}
                    for address, key, size, signed in (
                            (132, "present_position", 4, True), (128, "present_velocity", 4, True),
                            (140, "position_trajectory", 4, True), (136, "velocity_trajectory", 4, True),
                            (116, "goal_position", 4, True), (124, "present_pwm", 2, True),
                            (126, "present_load", 2, True), (144, "input_voltage_v", 2, False),
                            (123, "moving_status", 1, False)):
                        value = read(motor_id, address, size, signed=signed)
                        row[key] = value / 10 if key == "input_voltage_v" else value
                    sample["motors"].append(row)
                guard()
                sample["read_duration_ms"] = round((time.monotonic() - started) * 1000, 3)
                return {"ok": True, "sample": sample}
            except Exception as error:
                return {"ok": False, "error": str(error)}

    def _selection_changed(self) -> None:
        self._upright_reference = None
        self._identified_ids = ()
        self._sample_stop.set()
        self._reset_calibration("Connection changed. Start a new range recording after identifying both axes.")

    def _reset_calibration(self, message: str = "Move the head by hand with torque off to record its comfortable range.") -> None:
        self._calibration = {
            "recording": False, "state": "idle", "message": message,
            "started_at": None, "sampled_at": None, "sample_count": 0,
            "device": None, "baudrate": None, "axes": [],
        }

    def _load_calibration(self) -> None:
        if self._calibration_path is None:
            return
        try:
            with self._calibration_path.open(encoding="utf-8") as stream:
                contents = stream.read(65_537)
            if len(contents) > 65_536:
                raise ValueError("Saved calibration is too large.")
            self._saved_calibration = _validate_calibration(json.loads(contents))
        except FileNotFoundError:
            return
        except Exception as error:
            self._storage_error = f"Saved head calibration could not be loaded: {error}"

    def _saved_connection(self) -> dict[str, Any]:
        """Resolve calibration by USB identity without opening or selecting a port."""
        saved = self._saved_calibration
        if not saved:
            return {"state": "unavailable", "device": None, "identity": None,
                    "message": "No head calibration has been saved."}
        if "device_identity" in saved:
            return robot_devices.resolve_identity(saved["device_identity"])
        # Legacy files remain bound to their original path until explicitly
        # associated with a known adapter or replaced by a new range recording.
        return {"state": "matched", "device": saved["device"], "identity": None,
                "message": "Legacy calibration uses its original serial port."}

    def _saved_matches_connection(self) -> bool:
        saved = self._saved_calibration
        connection = self._saved_connection()
        return bool(saved and self._port is not None and self._state == "ready"
                    and connection["state"] == "matched"
                    and _connection_key(connection["device"]) == _connection_key(self._device)
                    and saved["baudrate"] == self._baudrate
                    and tuple(sorted(axis["id"] for axis in saved["axes"])) == self._identified_ids
                    and all(row.get("model_number") == HEAD_MODEL for row in self._motors.values()))

    def _finish_recording(self, state: str, message: str) -> None:
        self._sample_stop.set()
        self._calibration.update(recording=False, state=state, message=message)

    def _close_port(self) -> None:
        self._verified_connection = None
        self._stop_version = object()
        self._axis_motion.clear()
        self._motion_uncertain_until = 0.0
        self._last_move = None
        if self._calibration["recording"]:
            self._finish_recording("error", "Head serial connection closed; range recording stopped.")
        super()._close_port()

    @staticmethod
    def _join_sampler(thread: threading.Thread | None) -> None:
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2)

    def disconnect(self) -> dict[str, Any]:
        self._stop_version = object()
        with self._lock:
            thread = self._sample_thread
            if self._calibration["recording"]:
                self._finish_recording("stopped", "Range recording stopped; head disconnected.")
            state = super().disconnect()
        self._join_sampler(thread)
        return state

    def close(self) -> None:
        self.request_stop()
        with self._lock:
            thread = self._sample_thread
            if self._calibration["recording"]:
                self._finish_recording("stopped", "Range recording stopped; head control closed.")
            self._close_port()
            self._set_error("disconnected", "closed", "Head control is closed. Motor torque is unchanged.", reset=True)
            self._closed = True
        self._join_sampler(thread)

    def _recording_connection_error(self) -> str | None:
        draft = self._calibration
        error = self._manual_axis_error()
        if error:
            return error
        if (_connection_key(draft["device"]) != _connection_key(self._device)
                or draft["baudrate"] != self._baudrate
                or tuple(axis["id"] for axis in draft["axes"]) != self._identified_ids):
            return "Head connection or axis IDs changed. Start a new recording."
        return None

    def _manual_axis_error(self) -> str | None:
        if self._port is None or self._state != "ready":
            return "Head connection is not ready. " + self._message
        if len(self._identified_ids) != 2 or tuple(self._motors) != self._identified_ids:
            return "Identify exactly two head axes before recording their range."
        for row in self._motors.values():
            if row.get("model_number") != HEAD_MODEL or row.get("error") or not row.get("connected"):
                return f"Head {row['id']} could not be verified as a healthy 2XL430-W250-T axis."
            if row.get("torque_enabled") is not False:
                return f"Head {row['id']} torque must be off before moving it by hand. Torque was not changed."
            try:
                _integer(row.get("position"), "Head position", POSITION_MIN, POSITION_MAX)
            except ValueError as error:
                return str(error)
        return None

    def _validate_active_recording(self) -> None:
        if self._calibration["recording"]:
            error = self._recording_connection_error()
            if error:
                self._finish_recording("error", "Range recording stopped. " + error)

    def check(self, device: str | None = None, baudrate: int | None = None) -> dict[str, Any]:
        """Broadcast ping and read discovered 2XL430 axes; never write registers."""
        with self._lock:
            if time.monotonic() < self._motion_until:
                raise ValueError("A head movement is still in progress. Wait before identifying or reconfiguring the head.")
            self._select(device, baudrate)
            self._checked_at = _now()
            if not self._open():
                return self.snapshot()
            try:
                discovered, communication = self._packet.broadcastPing(self._port)
                errors = self._errors(communication, 0)
                if errors:
                    raise OSError("; ".join(errors))
                if not isinstance(discovered, dict):
                    raise ValueError("The discovery response was not a motor list")
                for motor_id, identity in discovered.items():
                    _integer(motor_id, "Discovered motor ID", 0, 252)
                    if not isinstance(identity, (tuple, list)) or len(identity) < 2:
                        raise ValueError(f"Incomplete model and firmware response for motor {motor_id}")
                    _integer(identity[0], "Model number", 0, 65535)
                    _integer(identity[1], "Firmware version", 0, 255)
            except Exception as error:
                self._upright_reference = None
                self._identified_ids = ()
                self._set_error("disconnected", "discovery_failed",
                                f"No reliable head discovery response at {self._baudrate:,} baud: {error}. "
                                "Check motor power, the selected adapter, and baud rate. No motor settings were changed.", reset=True)
                self._close_port()
                return self.snapshot()
            identities = tuple(sorted(discovered))
            if identities != self._identified_ids:
                self._upright_reference = None
                self._verified_connection = None
            self._identified_ids = identities
            self._motors = {}
            for motor_id in identities:
                model, firmware = discovered[motor_id][:2]
                if model == HEAD_MODEL:
                    row = self._read(motor_id, limits=True)
                    if not row["error"]:
                        try:
                            row["diagnostics"] = self._read_head_diagnostics(motor_id)
                        except Exception as error:
                            row["error"] = str(error)
                else:
                    row = _unknown_motor(motor_id)
                    row["connected"] = True
                    row["error"] = f"Unexpected model {model}; expected 2XL430-W250-T (1090)."
                row.update(model_number=model, firmware=firmware)
                self._motors[motor_id] = row
            unexpected = [row for row in self._motors.values() if row["model_number"] != HEAD_MODEL]
            healthy = [row for row in self._motors.values() if row["connected"] and not row["error"]]
            if len(identities) == 2 and len(healthy) == 2:
                self._verified_connection = (self._device, self._baudrate, identities)
                self._state, self._code = "ready", "connected"
                self._message = ("Both 2XL430-W250-T axes responded. Position and torque were read only. "
                                 "Device position limits are not calibrated mechanical travel limits.")
            elif not identities:
                self._set_error("disconnected", "motors_unreachable",
                                f"No head motors replied at {self._baudrate:,} baud. Check power, the adapter, and baud rate.")
                self._close_port()
            elif unexpected:
                self._verified_connection = None
                self._upright_reference = None
                self._set_error("error", "unexpected_model", " ".join(row["error"] for row in unexpected)
                                + " Select the adapter containing only the two head axes. No registers were written.")
            elif len(identities) != 2:
                self._verified_connection = None
                self._set_error("partial", "axis_count_mismatch",
                                f"Found {len(identities)} 2XL430-W250-T axis IDs; exactly two are required. "
                                "Check wiring and motor IDs. No registers were written.")
            else:
                failures = [f"Head {row['id']}: {row['error'] or 'no response'}" for row in self._motors.values()
                            if row not in healthy]
                self._set_error("partial", "motor_error", " ".join(failures) + " No registers were written.")
            self._validate_active_recording()
            return self.snapshot()

    def request_stop(self) -> None:
        """Invalidate in-flight writes without waiting for the serial lock."""
        self._stop_requested.set()
        self._stop_version = object()
        self._sample_stop.set()

    def reset_stop(self) -> None:
        self._stop_requested.clear()

    def _stopped(self, version: object) -> bool:
        return self._stop_requested.is_set() or version is not self._stop_version

    def _power_error(self) -> str | None:
        if self._calibration["recording"]:
            return "Stop manual range recording before using powered head controls."
        if not self._saved_matches_connection():
            return "Identify the head adapter associated with its saved calibration before powered movement."
        axes = {axis["id"]: axis for axis in self._saved_calibration["axes"]}
        for motor_id, row in self._motors.items():
            axis = axes[motor_id]
            if row.get("error") or not row.get("connected"):
                return f"Head {motor_id} is not responding without errors."
            if row.get("operating_mode") != 3 or row.get("profile_mode") != "time" or row.get("firmware", 0) < 42:
                return f"Head {motor_id} requires position mode 3 and firmware supporting time profiles. No configuration was changed."
            if row.get("drive_mode", 8) & 8:
                return f"Head {motor_id} has automatic torque-on by goal update enabled. Powered control is blocked."
            low, high = axis["min"], axis["max"]
            if not low <= row["position"] <= high:
                return f"Head {motor_id} is outside its saved mechanical range. With torque off, support the head near its saved centre, then retry."
            if not 0 <= row.get("device_min_position", -1) <= axis["min"] < axis["max"] <= row.get("device_max_position", -1) <= 4095:
                return f"Head {motor_id} calibration must fit its single-turn device position limits."
        return None

    def _read_head_diagnostics(self, motor_id: int, version: object | None = None) -> dict[str, Any]:
        """Read the model-1090 control settings and load; never tune the servo."""
        diagnostics: dict[str, Any] = {"sampled_at": _now()}
        for address, key, size, signed in (
                (80, "position_d_gain", 2, False), (82, "position_i_gain", 2, False),
                (84, "position_p_gain", 2, False), (36, "pwm_limit", 2, False),
                (100, "goal_pwm", 2, True), (124, "present_pwm", 2, True),
                (126, "present_load", 2, True), (144, "input_voltage_v", 2, False),
                (146, "temperature_c", 1, False)):
            if version is not None and self._stopped(version):
                raise OSError("Head command cancelled by emergency stop, reset, or connection change.")
            method = self._packet.read1ByteTxRx if size == 1 else self._packet.read2ByteTxRx
            value, communication, packet_error = method(self._port, motor_id, address)
            errors = self._errors(communication, packet_error)
            if errors:
                raise OSError(f"Head {motor_id} {key} read failed: {'; '.join(errors)}.")
            if signed and value >= 0x8000:
                value -= 0x10000
            diagnostics[key] = value / 10 if key == "input_voltage_v" else value
        return diagnostics

    def _refresh_for_move(self, version: object) -> str | None:
        """Refresh the verified axes without rediscovering every possible bus ID."""
        context = (self._port, self._packet, self._device, self._baudrate, self._identified_ids)

        def connection_error() -> str | None:
            if self._stopped(version):
                return "Head command cancelled by emergency stop, reset, or connection change."
            if (self._closed or self._port is None or self._packet is None
                    or len(self._identified_ids) != 2
                    or tuple(sorted(self._motors)) != self._identified_ids
                    or self._verified_connection != (self._device, self._baudrate, self._identified_ids)
                    or context != (self._port, self._packet, self._device, self._baudrate, self._identified_ids)):
                return "The verified head connection changed. Identify both axes again before movement."
            return None

        error = connection_error()
        if error:
            return error
        self._checked_at = _now()
        try:
            for motor_id in self._identified_ids:
                error = connection_error()
                if error:
                    return error
                model, communication, packet_error = self._packet.read2ByteTxRx(self._port, motor_id, 0)
                error = connection_error()
                if error:
                    return error
                errors = self._errors(communication, packet_error)
                if errors:
                    raise OSError(f"Head {motor_id} identity read failed: {'; '.join(errors)}.")
                if model != HEAD_MODEL:
                    message = f"Head {motor_id} reported model {model}; expected 2XL430-W250-T (1090). Identify the head again."
                    self._motors[motor_id].update(model_number=model, error=message)
                    self._verified_connection = None
                    self._upright_reference = None
                    self._set_error("error", "unexpected_model", message)
                    return message
                firmware, communication, packet_error = self._packet.read1ByteTxRx(self._port, motor_id, 6)
                error = connection_error()
                if error:
                    return error
                errors = self._errors(communication, packet_error)
                if errors:
                    raise OSError(f"Head {motor_id} firmware read failed: {'; '.join(errors)}.")
                _integer(firmware, "Head firmware", 0, 255)
                row = self._read(motor_id, limits=True)
                error = connection_error()
                if error:
                    return error
                self._motors[motor_id] = {**self._motors[motor_id], **row,
                                          "model_number": model, "firmware": firmware}
                self._motors[motor_id].pop("diagnostics", None)
                if row["error"]:
                    message = f"Head {motor_id} read failed: {row['error']}."
                    self._set_error("partial", "motor_error", message)
                    return message
                diagnostics = self._read_head_diagnostics(motor_id, version)
                error = connection_error()
                if error:
                    return error
                self._motors[motor_id]["diagnostics"] = diagnostics
        except Exception as error:
            if self._stopped(version):
                return "Head command cancelled by emergency stop, reset, or connection change."
            message = f"Head movement checks failed: {error}"
            self._set_error("partial", "movement_read_failed", message)
            return message
        return None

    def _read_power_settings(self, version: object, target_ids: set[int] | None = None) -> str | None:
        """Read settings relevant to safe goal writes; never change EEPROM."""
        try:
            for motor_id, row in self._motors.items():
                for address, key, size in ((12, "secondary_id", 1), (20, "homing_offset", 4),
                                           (108, "profile_acceleration", 4), (116, "goal_position", 4),
                                           (140, "position_trajectory", 4),
                                           (122, "moving", 1)):
                    if self._stopped(version):
                        return "Head command cancelled by emergency stop, reset, or connection change."
                    method = self._packet.read1ByteTxRx if size == 1 else self._packet.read4ByteTxRx
                    value, communication, packet_error = method(self._port, motor_id, address)
                    errors = self._errors(communication, packet_error)
                    if errors:
                        return f"Head {motor_id} {key} read failed: {'; '.join(errors)}."
                    row[key] = _signed_position(value) if key in ("homing_offset", "goal_position", "position_trajectory") else value
                axis = next(axis for axis in self._saved_calibration["axes"] if axis["id"] == motor_id)
                # Mode 3 torque-on resets continuous position to single-turn + offset.
                # Reject coordinates that would change on that reset; do not wrap them.
                offset = row["homing_offset"]
                if not -1024 <= offset <= 1024 or not 0 <= axis["min"] - offset < axis["max"] - offset <= 4095:
                    return f"Head {motor_id} calibration crosses the single-turn coordinate range after homing offset."
                if row["secondary_id"] < 253:
                    return f"Head {motor_id} has a secondary ID enabled; independent axis control cannot be guaranteed."
                peer_motion = self._axis_motion.get(motor_id, {})
                accepted_peer_motion = (target_ids is not None and motor_id not in target_ids
                                        and peer_motion.get("until", 0) > time.monotonic()
                                        and row["goal_position"] == peer_motion.get("position")
                                        and time.monotonic() >= self._motion_uncertain_until)
                if row["moving"] != 0 and not (row["moving"] == 1 and accepted_peer_motion):
                    return f"Head {motor_id} is still moving. Wait before sending another movement."
                low, high = axis["min"], axis["max"]
                if row["torque_enabled"] and not low <= row["goal_position"] <= high:
                    return f"Head {motor_id} has an existing goal outside its saved range. Release torque first."
        except Exception as error:
            return f"Head safety settings could not be read: {error}."
        return None

    def _prepare_power(self, version: object, *, discover: bool = True,
                       target_ids: set[int] | None = None) -> str | None:
        if self._stopped(version):
            return "Head command cancelled by emergency stop, reset, or connection change."
        if self._calibration["recording"]:
            return "Stop manual range recording before using powered head controls."
        now = time.monotonic()
        if now < self._motion_uncertain_until:
            return "A head goal acknowledgement is uncertain. Wait for the attempted movement to finish before rechecking powered control."
        if any(motion["until"] > now for motor_id, motion in self._axis_motion.items()
               if target_ids is None or motor_id in target_ids):
            return "A head movement is still in progress. Wait before sending another movement."
        # Commands must not select/open a bus from saved disk data implicitly.
        error = self._power_error()
        if error:
            return error
        if discover:
            self.check()
        else:
            # Broadcast discovery waits for every possible ID even when the two
            # head axes already replied. Keep it at explicit identification and
            # torque-on; normal gestures still refresh all identity/safety reads.
            error = self._refresh_for_move(version)
            if error:
                return error
        error = self._power_error()
        if not error:
            error = self._read_power_settings(version, target_ids)
        if self._stopped(version):
            return "Head command cancelled by emergency stop, reset, or connection change."
        return error

    def _write_head(self, motor_id: int, address: int, value: int, version: object) -> None:
        if self._stopped(version):
            raise OSError("Head command cancelled by emergency stop, reset, or connection change")
        if self._calibration["recording"]:
            raise OSError("Head range recording is running; register writes are blocked")
        method = self._packet.write1ByteTxRx if address == 64 else self._packet.write4ByteTxRx
        if address == 64:
            # A missing acknowledgement does not prove the write was rejected.
            self._motors[motor_id]["torque_enabled"] = None
        communication, packet_error = method(self._port, motor_id, address, value)
        errors = self._errors(communication, packet_error)
        if errors:
            raise OSError(f"Head {motor_id} write to {address} failed: {'; '.join(errors)}")
        if address == 64:
            self._motors[motor_id]["torque_enabled"] = bool(value)

    def _release_verified(self) -> dict[str, Any]:
        if self._calibration["recording"]:
            return self._result(False, "Stop manual range recording before changing head torque.")
        verified = self._verified_connection
        self._axis_motion.clear()
        self._motion_uncertain_until = 0.0
        if not self._port or verified != (self._device, self._baudrate, self._identified_ids):
            return {**self._result(True, "Head release skipped: no open, verified head bus."), "skipped": True}
        failures = []
        for motor_id in verified[2]:
            try:
                communication, packet_error = self._packet.write1ByteTxRx(self._port, motor_id, 64, 0)
                errors = self._errors(communication, packet_error)
                if errors:
                    raise OSError("; ".join(errors))
                self._motors[motor_id]["torque_enabled"] = False
            except Exception as error:
                failures.append(f"Head {motor_id}: {error}")
                self._motors[motor_id]["torque_enabled"] = None
        return self._result(not failures, " ".join(failures) if failures else "Both head axes received torque-off requests.")

    def emergency_stop(self) -> dict[str, Any]:
        self.request_stop()
        with self._lock:
            if self._calibration["recording"]:
                self._finish_recording("stopped", "Manual range recording stopped by emergency stop.")
            return self._release_verified()

    def torque(self, enabled: bool) -> dict[str, Any]:
        if type(enabled) is not bool:
            raise ValueError("Enabled must be true or false.")
        if not enabled:
            self._stop_version = object()
        version = self._stop_version
        with self._lock:
            if not enabled:
                return self._release_verified()
            error = self._prepare_power(version)
            if error:
                return self._result(False, error)
            off = [row for row in self._motors.values() if row["torque_enabled"] is False]
            try:
                # Preload every OFF axis before enabling any of them. Existing ON
                # axes keep their goals; enabling never moves to the saved centre.
                for row in off:
                    self._write_head(row["id"], 112, HEAD_MIN_DURATION_MS, version)
                    self._write_head(row["id"], 108, HEAD_MIN_DURATION_MS // 2, version)
                    self._write_head(row["id"], 116, row["position"], version)
                for row in off:
                    goal, communication, packet_error = self._packet.read4ByteTxRx(self._port, row["id"], 116)
                    errors = self._errors(communication, packet_error)
                    if errors or _signed_position(goal) != row["position"]:
                        raise OSError(f"Head {row['id']} current-position goal preload could not be verified")
                for row in off:
                    position, communication, packet_error = self._packet.read4ByteTxRx(self._port, row["id"], 132)
                    errors = self._errors(communication, packet_error)
                    if errors or _signed_position(position) != row["position"]:
                        raise OSError(f"Head {row['id']} moved during goal preload. Hold it still and retry torque-on")
                    torque, communication, packet_error = self._packet.read1ByteTxRx(self._port, row["id"], 64)
                    errors = self._errors(communication, packet_error)
                    row["torque_enabled"] = bool(torque) if not errors and torque in (0, 1) else None
                    if errors or torque != 0:
                        raise OSError(f"Head {row['id']} torque changed during preload. Recheck the head connection")
                    self._write_head(row["id"], 64, 1, version)
                self.check()
                error = self._power_error()
                if error or any(row["torque_enabled"] is not True for row in self._motors.values()):
                    raise OSError(error or "Head torque-on could not be confirmed")
            except Exception as error:
                return self._result(False, str(error))
            return self._result(True, "Head torque is on, holding the measured pose. No centre movement was requested.")

    def move(self, motor_id: int, position: int, duration_ms: int) -> dict[str, Any]:
        return self._move_targets([{"motor_id": motor_id, "position": position, "duration_ms": duration_ms}],
                                  single=True)

    def moves(self, targets: list[dict[str, int]]) -> dict[str, Any]:
        """Start independent native profiles without retargeting an active axis."""
        return self._move_targets(targets)

    def _move_targets(self, targets: list[dict[str, int]], *, single: bool = False) -> dict[str, Any]:
        if not isinstance(targets, list) or not 1 <= len(targets) <= 2:
            raise ValueError("Head targets must contain one or two distinct saved axes.")
        requested_targets = []
        for target in targets:
            if not isinstance(target, dict) or set(target) != {"motor_id", "position", "duration_ms"}:
                raise ValueError("Each head target must contain motor_id, position and duration_ms.")
            requested_targets.append({
                "motor_id": _integer(target["motor_id"], "Head motor ID", 0, 252),
                "position": _integer(target["position"], "Head position", POSITION_MIN, POSITION_MAX),
                "requested_duration_ms": _integer(target["duration_ms"], "Head duration",
                                                   HEAD_MIN_DURATION_MS, HEAD_MAX_DURATION_MS),
            })
        target_ids = {target["motor_id"] for target in requested_targets}
        if len(target_ids) != len(requested_targets):
            raise ValueError("Head targets must use distinct motor IDs.")
        version = self._stop_version
        with self._lock:
            axes = {axis["id"]: axis for axis in (self._saved_calibration or {}).get("axes", [])}
            for target in requested_targets:
                motor_id, position = target["motor_id"], target["position"]
                axis = axes.get(motor_id)
                if axis is None:
                    return self._result(False, "Choose an axis from the saved head calibration.")
                if not axis["min"] <= position <= axis["max"]:
                    raise ValueError(f"Head {motor_id} position must be within its saved range {axis['min']}–{axis['max']}.")
            error = self._prepare_power(version, discover=False, target_ids=target_ids)
            if error:
                return self._result(False, error)
            if any(row["torque_enabled"] is not True for row in self._motors.values()):
                return self._result(False, "Enable head torque before moving either axis.")
            # A loaded shaft can lag behind its internal trajectory. On reversal
            # the new profile may start at that reference, not the measured pose.
            # Validate both physical/reference travel for every axis before writes.
            for target in requested_targets:
                row = self._motors[target["motor_id"]]
                distance = max(abs(target["position"] - row[key])
                               for key in ("position", "goal_position", "position_trajectory"))
                target["duration_ms"] = max(target["requested_duration_ms"],
                                            math.ceil(2000 * distance / HEAD_MAX_SPEED_TICKS_PER_SECOND))
                if target["duration_ms"] > HEAD_MAX_DURATION_MS:
                    return self._result(False, "This head move requires more than 10 seconds at the configured speed limit. Choose a closer target.")
            attempted = []
            started_at = None

            def record_move(partial: bool) -> None:
                if not attempted:
                    return
                self._last_move = {"targets": copy.deepcopy(attempted),
                                   "duration_ms": max(target["duration_ms"] for target in attempted),
                                   "started_at": started_at}
                if partial:
                    self._last_move["partial"] = True
                if single:
                    self._last_move.update(attempted[0])

            try:
                # Stage every native time profile before starting either axis.
                for target in requested_targets:
                    self._write_head(target["motor_id"], 112, target["duration_ms"], version)
                    self._write_head(target["motor_id"], 108, target["duration_ms"] // 2, version)
                for target in requested_targets:
                    if self._stopped(version):
                        raise OSError("Head command cancelled by emergency stop, reset, or connection change")
                    motor_id, duration, position = target["motor_id"], target["duration_ms"], target["position"]
                    started_at = started_at or _now()
                    attempted.append(target)
                    # A lost goal acknowledgement may still start a profile.
                    motion = {"position": position, "duration_ms": duration,
                              "until": time.monotonic() + duration / 1000}
                    self._axis_motion[motor_id] = motion
                    try:
                        self._write_head(motor_id, 116, position, version)
                    finally:
                        motion["until"] = time.monotonic() + duration / 1000
                    self._motors[motor_id].update(goal_position=position, profile_acceleration=duration // 2)
                    if self._stopped(version):
                        raise OSError("Head command cancelled by emergency stop, reset, or connection change")
            except Exception as error:
                if attempted:
                    self._motion_uncertain_until = self._motion_until
                    record_move(partial=True)
                return self._result(False, str(error))
            record_move(partial=False)
            return self._result(True, "Head targets accepted with independent native time profiles.")

    def capture_upright(self) -> dict[str, Any]:
        """Record a new read of the existing pose; this does not home or calibrate."""
        with self._lock:
            self.check()
            if self._state != "ready":
                return self._result(False, "Upright reference was not recorded. " + self._message)
            self._upright_reference = {
                "device": self._device, "baudrate": self._baudrate, "recorded_at": self._checked_at,
                "positions": [{"id": row["id"], "position": row["position"]} for row in self._motors.values()],
            }
            return self._result(True, "Current head positions recorded as the upright reference. "
                                "No movement, torque change, or travel calibration was performed.")

    def _record_sample(self) -> None:
        for axis in self._calibration["axes"]:
            position = self._motors[axis["id"]]["position"]
            axis.update(position=position, min=min(axis["min"], position), max=max(axis["max"], position))
        self._calibration["sampled_at"] = self._checked_at
        self._calibration["sample_count"] += 1

    def _sample_calibration(self) -> None:
        """Read only the known axes while holding the serial lock; no broadcast."""
        error = self._recording_connection_error()
        if error:
            self._finish_recording("error", "Range recording stopped. " + error)
            return
        for motor_id in self._identified_ids:
            model, communication, packet_error = self._packet.read2ByteTxRx(self._port, motor_id, 0)
            errors = self._errors(communication, packet_error)
            if errors or model != HEAD_MODEL:
                message = (f"Head {motor_id} identity could not be verified: "
                           + ("; ".join(errors) if errors else f"unexpected model {model}."))
                self._set_error("error", "calibration_identity_changed", message)
                self._finish_recording("error", "Range recording stopped. " + message)
                return
            row = self._read(motor_id)
            self._motors[motor_id] = {**self._motors[motor_id], **row}
        self._checked_at = _now()
        error = self._recording_connection_error()
        if error:
            self._finish_recording("error", "Range recording stopped. " + error)
            if any(row["error"] for row in self._motors.values()):
                self._set_error("partial", "motor_error", error)
            return
        self._record_sample()

    def _sample_loop(self, stopped: threading.Event) -> None:
        while not stopped.wait(CALIBRATION_SAMPLE_INTERVAL):
            with self._lock:
                if stopped.is_set() or not self._calibration["recording"]:
                    return
                try:
                    self._sample_calibration()
                except Exception as error:
                    self._set_error("error", "calibration_read_failed", f"Head position read failed: {error}")
                    self._finish_recording("error", f"Range recording stopped after a serial read error: {error}")

    def calibration_start(self) -> dict[str, Any]:
        with self._lock:
            if self._stop_requested.is_set():
                return self._result(False, "Reset emergency stop before starting a new range recording.")
            if self._calibration["recording"]:
                return self._result(False, "A head range recording is already running. Stop it before starting again.")
            if self._port is None or self._state != "ready" or len(self._identified_ids) != 2:
                return self._result(False, "Identify both head axes successfully before starting a range recording.")
            expected = self._identified_ids
            self.check()
            error = self._manual_axis_error()
            if error or self._identified_ids != expected:
                return self._result(False, "Range recording was not started. "
                                    + (error or "Head axis IDs changed. Check the connection again."))
            centres = {}
            upright = self._upright_reference
            if (upright and _connection_key(upright["device"]) == _connection_key(self._device)
                    and upright["baudrate"] == self._baudrate
                    and tuple(sorted(row["id"] for row in upright["positions"])) == self._identified_ids):
                centres = {row["id"]: row["position"] for row in upright["positions"]}
            self._reset_calibration()
            self._calibration.update(
                recording=True, state="recording", message="Recording positions while you move the head by hand. Torque remains off.",
                device=self._device, baudrate=self._baudrate, started_at=self._checked_at,
                axes=[{"id": row["id"], "label": f"Motor {row['id']}", "position": row["position"],
                       "min": row["position"], "max": row["position"], "centre": centres.get(row["id"], row["position"])}
                      for row in self._motors.values()],
            )
            self._record_sample()
            self._sample_stop = threading.Event()
            self._sample_thread = threading.Thread(target=self._sample_loop, args=(self._sample_stop,),
                                                   name="head-range-recorder", daemon=True)
            self._sample_thread.start()
            return self._result(True, self._calibration["message"])

    def calibration_stop(self) -> dict[str, Any]:
        with self._lock:
            thread = self._sample_thread
            if self._calibration["axes"]:
                self._finish_recording("stopped", "Range recording stopped. Review the limits and centre before saving.")
            else:
                self._sample_stop.set()
            result = self._result(True, self._calibration["message"])
        self._join_sampler(thread)
        return result

    def calibration_centre(self) -> dict[str, Any]:
        with self._lock:
            if not self._calibration["axes"]:
                return self._result(False, "Start a range recording before recording its centre.")
            self.check()
            error = self._recording_connection_error()
            if error:
                return self._result(False, "Head centre was not recorded. " + error)
            if self._calibration["recording"]:
                self._record_sample()
            for axis in self._calibration["axes"]:
                axis["position"] = axis["centre"] = self._motors[axis["id"]]["position"]
            if self._calibration["state"] == "saved":
                self._calibration["state"] = "stopped"
            self._calibration["sampled_at"] = self._checked_at
            self._calibration["message"] = "Current head positions recorded as the centre. Recorded limits are unchanged while stopped."
            return self._result(True, self._calibration["message"])

    def _persist_calibration(self, document: dict[str, Any]) -> None:
        if self._calibration_path is None:
            return
        self._calibration_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self._calibration_path.parent,
                                             prefix=".head-calibration-", suffix=".tmp", delete=False) as stream:
                temporary = stream.name
                json.dump(document, stream, indent=2, ensure_ascii=False, allow_nan=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self._calibration_path)
            temporary = None
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass

    def calibration_save(self, labels: dict[str, str] | None = None) -> dict[str, Any]:
        with self._lock:
            draft = self._calibration
            if draft["recording"] or draft["state"] not in ("stopped", "saved") or not draft["axes"]:
                return self._result(False, "Stop the range recording before saving it.")
            if labels is not None and (not isinstance(labels, dict)
                                       or any(key not in {str(axis["id"]) for axis in draft["axes"]} for key in labels)):
                return self._result(False, "Labels must map the two recorded motor IDs to text.")
            try:
                chosen_labels = {axis["id"]: _label((labels or {}).get(str(axis["id"]), axis["label"]), axis["id"])
                                 for axis in draft["axes"]}
                document = _validate_calibration({
                    "version": 1, "device": draft["device"], "baudrate": draft["baudrate"], "model_number": HEAD_MODEL,
                    "saved_at": _now(), "sample_count": draft["sample_count"],
                    "axes": [{"id": axis["id"], "label": chosen_labels[axis["id"]], "min": axis["min"],
                              "centre": axis["centre"], "max": axis["max"]} for axis in draft["axes"]],
                })
            except ValueError as error:
                return self._result(False, f"Head ranges were not saved: {error}")
            self.check()
            error = self._recording_connection_error()
            if error:
                return self._result(False, "Head ranges were not saved. " + error)
            identity = robot_devices.device_identity(self._device)
            if identity is not None:
                document["device_identity"] = robot_devices.validate_identity(identity)
            try:
                self._persist_calibration(document)
            except Exception as error:
                self._storage_error = f"Head calibration could not be saved: {error}"
                return self._result(False, self._storage_error)
            self._saved_calibration = document
            self._storage_error = None
            for axis in draft["axes"]:
                axis["label"] = chosen_labels[axis["id"]]
                axis["position"] = self._motors[axis["id"]]["position"]
            draft.update(state="saved", message="Head ranges saved. Powered movement is limited to these calibrated ranges.")
            return self._result(True, draft["message"])
