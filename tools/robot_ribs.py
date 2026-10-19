"""Direct, acknowledged control of the six rib motors.

Importing this module and taking a snapshot never open a serial port. Only an
explicit connection check or live command communicates with the rib adapter.
This controller must be the only process using that adapter.
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone
import glob
import importlib
import importlib.util
import math
import os
import threading
from typing import Any

import robot_devices

IDS = (20, 21, 22, 25, 26, 27)
BOUNDS = {motor_id: (2450, 4090) if motor_id < 25 else (0, 1700) for motor_id in IDS}
BAUDRATE = 1_000_000
DEFAULT_DEVICE = "/dev/tty.usbserial-FT78LBUJ"
PREFERRED_DEVICE = "/dev/cu.usbserial-FT78LBUJ"
ADDR_TORQUE = 64
ADDR_DRIVE_MODE = 10
ADDR_OPERATING_MODE = 11
ADDR_HARDWARE_ERROR = 70
ADDR_PROFILE = 112
ADDR_POSITION = 116
ADDR_PRESENT_POSITION = 132
_DEVICE_PATTERN = robot_devices.DEVICE_PATTERN


def _ports() -> list[str]:
    paths = {port["device"] for port in robot_devices.serial_ports()}
    for pattern in ("/dev/cu.usbserial*", "/dev/cu.usbmodem*", "/dev/tty.usbserial*",
                    "/dev/tty.usbmodem*", "/dev/ttyUSB*", "/dev/ttyACM*"):
        paths.update(path for path in glob.glob(pattern) if _DEVICE_PATTERN.fullmatch(path))
    return sorted(paths)


def _dependency_available() -> bool:
    try:
        return importlib.util.find_spec("dynamixel_sdk") is not None
    except (ImportError, ValueError, AttributeError):
        return False


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not minimum <= value <= maximum or not math.isfinite(value)
            or int(value) != value):
        raise ValueError(f"{label} must be an integer from {minimum} to {maximum}.")
    return int(value)


def _unknown_motor(motor_id: int) -> dict[str, Any]:
    return {"id": motor_id, "connected": False, "position": None,
            "torque_enabled": None, "profile_mode": None, "operating_mode": None,
            "error": None}


class RibController:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sdk = None
        self._port = None
        self._packet = None
        self._closed = False
        self._verified_device: str | None = None
        self._stop_requested = threading.Event()
        self._stop_version = object()
        preferred = robot_devices.preferred_connection("ribs")
        self._device = preferred.get("device") if preferred["state"] == "matched" else None
        self._state = "unchecked"
        self._code = "not_checked"
        self._message = "Check the rib connection to read the six motors. No motors have been commanded."
        self._checked_at: str | None = None
        self._motors = {motor_id: _unknown_motor(motor_id) for motor_id in IDS}

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy({
                "state": self._state, "code": self._code, "message": self._message,
                "device": self._device, "baudrate": BAUDRATE, "checked_at": self._checked_at,
                "ports": _ports(), "motors": list(self._motors.values()),
                "preferred_connection": robot_devices.preferred_connection("ribs"),
                "port_open": self._port is not None,
                "dependency_available": self._sdk is not None or _dependency_available(),
            })

    def _set_error(self, state: str, code: str, message: str, *, reset: bool = False) -> None:
        self._state, self._code, self._message = state, code, message
        if reset:
            self._motors = {motor_id: _unknown_motor(motor_id) for motor_id in IDS}

    def _close_port(self) -> None:
        port, self._port, self._packet = self._port, None, None
        self._verified_device = None
        if port is not None:
            try:
                port.closePort()
            except Exception:
                pass

    def _open(self) -> bool:
        if self._closed:
            self._set_error("disconnected", "closed", "Rib control is closed.", reset=True)
            return False
        if self._port is not None:
            return True
        if not self._device:
            self._set_error("unchecked", "device_required", "Select the rib USB serial adapter first.", reset=True)
            return False
        if self._sdk is None:
            try:
                self._sdk = importlib.import_module("dynamixel_sdk")
            except Exception as error:
                self._set_error("error", "dependency_missing",
                                "The Dynamixel driver could not load. Install it in the dashboard's Python "
                                f"environment with python -m pip install -r requirements-robot.txt. ({error})",
                                reset=True)
                return False
        present = (any(robot_devices.connection_key(port) == robot_devices.connection_key(self._device)
                       for port in _ports()) if self._device.upper().startswith("COM")
                   else os.path.exists(self._device))
        if not present:
            self._set_error("disconnected", "device_missing",
                            f"Rib USB adapter not found: {self._device}. Connect the adapter or select its serial port.",
                            reset=True)
            return False
        try:
            self._port = self._sdk.PortHandler(self._device)
            self._packet = self._sdk.PacketHandler(2.0)
            if not self._port.openPort():
                raise OSError("The driver could not open the serial port")
            try:
                if not self._port.setBaudRate(BAUDRATE):
                    raise OSError("The driver rejected the baud rate")
            except Exception as error:
                self._close_port()
                self._set_error("error", "baudrate_failed",
                                f"Could not set {self._device} to {BAUDRATE} baud: {error}.", reset=True)
                return False
            # POSIX pyserial offers advisory exclusivity. Older controllers may
            # not participate, so this is not a guarantee against another owner.
            # Set this after setBaudRate, which recreates the serial object.
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
                            f"Cannot open rib adapter {self._device}: {error}. "
                            "Stop interaction.py or other software using this adapter and check USB permissions.",
                            reset=True)
            return False

    def _errors(self, communication: int, packet_error: int) -> list[str]:
        errors = []
        if communication != self._sdk.COMM_SUCCESS:
            errors.append(str(self._packet.getTxRxResult(communication)))
        if packet_error:
            errors.append(str(self._packet.getRxPacketError(packet_error)))
        return errors

    def _read(self, motor_id: int) -> dict[str, Any]:
        row = _unknown_motor(motor_id)
        errors = []
        try:
            position, communication, packet_error = self._packet.read4ByteTxRx(
                self._port, motor_id, ADDR_PRESENT_POSITION)
            row["connected"] = communication == self._sdk.COMM_SUCCESS
            errors.extend(self._errors(communication, packet_error))
            if not errors:
                row["position"] = position
                torque, communication, packet_error = self._packet.read1ByteTxRx(
                    self._port, motor_id, ADDR_TORQUE)
                errors.extend(self._errors(communication, packet_error))
                if not errors:
                    if torque in (0, 1):
                        row["torque_enabled"] = bool(torque)
                    else:
                        errors.append(f"Unexpected torque register value {torque}")
                hardware_error, communication, packet_error = self._packet.read1ByteTxRx(
                    self._port, motor_id, ADDR_HARDWARE_ERROR)
                errors.extend(self._errors(communication, packet_error))
                if communication == self._sdk.COMM_SUCCESS and hardware_error:
                    errors.append(f"Motor hardware fault (register 70: 0x{hardware_error:02x})")
                drive_mode, communication, packet_error = self._packet.read1ByteTxRx(
                    self._port, motor_id, ADDR_DRIVE_MODE)
                drive_errors = self._errors(communication, packet_error)
                errors.extend(drive_errors)
                if not drive_errors:
                    row["profile_mode"] = "time" if drive_mode & 4 else "velocity"
                operating_mode, communication, packet_error = self._packet.read1ByteTxRx(
                    self._port, motor_id, ADDR_OPERATING_MODE)
                mode_errors = self._errors(communication, packet_error)
                errors.extend(mode_errors)
                if not mode_errors:
                    row["operating_mode"] = operating_mode
        except Exception as error:
            errors.append(f"Serial communication failed: {error}")
        row["error"] = "; ".join(errors) or None
        return row

    def _summarize(self) -> None:
        healthy = [row for row in self._motors.values() if row["connected"] and not row["error"]]
        if len(healthy) == len(IDS):
            self._state, self._code = "ready", "connected"
            self._verified_device = self._device
            self._message = "All six rib motors responded. The connection check does not move them or change torque."
        else:
            failures = [f"Rib {row['id']}: {row['error'] or 'no response'}"
                        for row in self._motors.values() if row not in healthy]
            responding = any(row["connected"] for row in self._motors.values())
            message = (f"{len(healthy)}/6 rib motors responded without errors. " + " ".join(failures)
                       if responding else
                       f"The USB adapter opened, but none of the six rib motors returned a valid reply at {BAUDRATE:,} baud. "
                       "Check motor power, the bus cable, and motor IDs 20, 21, 22, 25, 26 and 27. "
                       + failures[0])
            self._set_error("partial" if responding else "disconnected",
                            "motor_error" if responding else "motors_unreachable",
                            message)

    def check(self, device: str | None = None) -> dict[str, Any]:
        """Open the selected adapter and read all six motors; never write registers."""
        with self._lock:
            if device is not None:
                if not isinstance(device, str) or not _DEVICE_PATTERN.fullmatch(device):
                    raise ValueError("Choose a USB serial device (cu.usbserial, cu.usbmodem, ttyUSB, ttyACM or COM).")
                if device != self._device:
                    self._close_port()
                    self._device = device
            self._checked_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
            if not self._open():
                return self.snapshot()
            for motor_id in IDS:
                self._motors[motor_id] = self._read(motor_id)
            self._summarize()
            if self._state == "disconnected":
                self._close_port()
            return self.snapshot()

    def _result(self, ok: bool, message: str) -> dict[str, Any]:
        result = {"ok": ok, "message": message, "ribs": self.snapshot()}
        if not ok:
            result["error"] = message
        return result

    def request_stop(self) -> None:
        """Latch immediately, even when another thread holds the serial lock."""
        self._stop_requested.set()
        self._stop_version = object()

    def reset_stop(self) -> None:
        self._stop_requested.clear()

    def _stopped(self, version: object) -> bool:
        return self._stop_requested.is_set() or version is not self._stop_version

    def _stopped_result(self) -> dict[str, Any]:
        return self._result(False, "Rib command cancelled by emergency stop. Enable rib torque before continuing.")

    def emergency_stop(self) -> dict[str, Any]:
        self.request_stop()
        with self._lock:
            if self._port is None or self._verified_device != self._device:
                return {**self._result(True, "Rib release skipped: no verified open rib connection."), "skipped": True}
            return self._write_torque(False, self._stop_version)

    def move(self, targets: list[tuple[int, int, int]]) -> dict[str, Any]:
        with self._lock:
            stop_version = self._stop_version
            if not isinstance(targets, list) or not 1 <= len(targets) <= len(IDS):
                raise ValueError("Provide between one and six rib targets.")
            checked = []
            seen = set()
            for target in targets:
                if not isinstance(target, (list, tuple)) or len(target) != 3:
                    raise ValueError("Each rib target must contain motor ID, position and duration.")
                motor_id = _integer(target[0], "Motor ID", 20, 27)
                if motor_id not in BOUNDS or motor_id in seen:
                    raise ValueError("Select each of the six rib motor IDs at most once.")
                seen.add(motor_id)
                position = _integer(target[1], f"Rib {motor_id} position", *BOUNDS[motor_id])
                duration = _integer(target[2], "Duration", 100, 5000)
                checked.append((motor_id, position, duration))
            if self._stopped(stop_version):
                return self._stopped_result()
            if self._port is None or self._state != "ready":
                return self._result(False, "Check the rib connection successfully before moving motors. " + self._message)
            # Read the entire cage before any write, so a newly missing motor
            # cannot leave a group only partly validated.
            self.check()
            if self._state != "ready":
                return self._result(False, "Rib movement cancelled before any writes. " + self._message)
            incompatible = [motor_id for motor_id, _, _ in checked
                            if self._motors[motor_id]["profile_mode"] != "time"
                            or self._motors[motor_id]["operating_mode"] not in (3, 4)]
            if incompatible:
                message = ("Movement requires time-based profiles and position mode for rib motors "
                           + ", ".join(map(str, incompatible))
                           + ". Their current configuration would not interpret the duration as milliseconds. "
                           "No registers were written; configure and calibrate the motors before testing.")
                self._set_error("error", "profile_incompatible", message)
                return self._result(False, message)
            torque_off = [motor_id for motor_id, _, _ in checked
                          if not self._motors[motor_id]["torque_enabled"]]
            if torque_off:
                return self._result(False, "Rib torque is off for motors " + ", ".join(map(str, torque_off))
                                    + ". Enable rib torque before moving them.")
            for motor_id, position, duration in checked:
                for address, value, label in ((ADDR_PROFILE, duration, "movement profile"),
                                              (ADDR_POSITION, position, "goal position")):
                    if self._stopped(stop_version):
                        return self._stopped_result()
                    try:
                        communication, packet_error = self._packet.write4ByteTxRx(
                            self._port, motor_id, address, value)
                        errors = self._errors(communication, packet_error)
                    except Exception as error:
                        errors = [str(error)]
                    if errors:
                        message = (f"Rib {motor_id} {label} write failed: {'; '.join(errors)}. "
                                   "Some commands may have taken effect; motor positions are uncertain. "
                                   "Check the connection again before continuing.")
                        self._motors[motor_id]["error"] = "; ".join(errors)
                        self._set_error("error", "write_failed", message)
                        return self._result(False, message)
            return self._result(True, f"Movement registers acknowledged by {len(checked)} rib motor(s). "
                                "Target arrival has not been measured.")

    def torque(self, enabled: bool) -> dict[str, Any]:
        with self._lock:
            stop_version = self._stop_version
            if not isinstance(enabled, bool):
                raise ValueError("Enabled must be true or false.")
            if enabled:
                if self._stopped(stop_version):
                    return self._stopped_result()
                self.check()
                if self._state != "ready":
                    return self._result(False, "Rib torque was not enabled. " + self._message)
                incompatible = [motor_id for motor_id in IDS
                                if self._motors[motor_id]["operating_mode"] not in (3, 4)]
                if incompatible:
                    message = ("Rib torque was not enabled because motors " + ", ".join(map(str, incompatible))
                               + " are not in position mode. No registers were written; configure and calibrate "
                               "the motors before testing.")
                    self._set_error("error", "operating_mode_incompatible", message)
                    return self._result(False, message)
            elif self._port is None or self._verified_device != self._device:
                # An unverified adapter could be the head bus with overlapping
                # IDs. Only release after all six ribs identify this connection.
                # Once verified, allow best-effort release after a partial fault
                # for as long as that same serial connection stays open.
                self.check()
                if self._state != "ready":
                    return self._result(False, "Rib torque release was not sent because this connection "
                                        "has not been verified for all six ribs. " + self._message)
            return self._write_torque(enabled, stop_version)

    def _write_torque(self, enabled: bool, stop_version: object) -> dict[str, Any]:
        errors = []
        for motor_id in IDS:
            if enabled and self._stopped(stop_version):
                return self._stopped_result()
            try:
                communication, packet_error = self._packet.write1ByteTxRx(
                    self._port, motor_id, ADDR_TORQUE, int(enabled))
                motor_errors = self._errors(communication, packet_error)
            except Exception as error:
                motor_errors = [str(error)]
            if motor_errors:
                self._motors[motor_id]["torque_enabled"] = None
                self._motors[motor_id]["error"] = "; ".join(motor_errors)
                errors.append(f"Rib {motor_id}: {'; '.join(motor_errors)}")
                if enabled:
                    break
            else:
                self._motors[motor_id]["torque_enabled"] = enabled
        if errors:
            message = ("Rib torque could not be confirmed for every motor. " + " ".join(errors)
                       + " Some motors may have changed torque; check the connection again.")
            self._set_error("error", "torque_failed", message)
            return self._result(False, message)
        return self._result(True, "All six rib motors acknowledged torque " + ("on." if enabled else "off."))

    def disconnect(self) -> dict[str, Any]:
        with self._lock:
            self._close_port()
            self._set_error("disconnected", "disconnected",
                            "Rib serial connection closed. Motor torque is unchanged.", reset=True)
            return self.snapshot()

    def close(self) -> None:
        with self._lock:
            self.disconnect()
            self._closed = True
