"""Separate serial robot connections with calibration-bounded head commands.

Importing this module and previewing commands never open hardware connections.
"""

from __future__ import annotations

from collections import deque
from contextlib import nullcontext
import copy
from datetime import datetime, timezone
import ipaddress
import math
import struct
import threading
import time
from typing import Any

from robot_ribs import RibController
from robot_devices import connection_key
from robot_serial import (DrumController, HeadController, DRUM_TORQUE_REST_MS,
                          HEAD_MIN_DURATION_MS, HEAD_MAX_DURATION_MS)


API_PREFIX = "/api/robot"
MIN_DURATION_MS = 100
MAX_DURATION_MS = 5000
HISTORY_LIMIT = 30
DRUM_PREPARE_MS = 500
DRUM_RETURN_MS = 150
RANGE_NOTE = (
    "Drum limits follow max-control.maxpat and stay within the Python controller "
    "limits. The hi-hat uses the narrower Max range 2410–2600 (Python allows "
    "2410–4000). Ribs follow the Max opening mapping. These are repository "
    "calibrations, not measurements of the connected hardware."
)
DURATION_NOTE = (
    "100–5000 ms is a conservative testing policy. Movement requires the servos' "
    "existing time-profile setup; configuration registers are not changed automatically."
)


def _motor(motor_id: int, name: str, group: str, minimum: int, maximum: int,
           default: int, duration_ms: int, source: str, **extra: Any) -> dict[str, Any]:
    return {"id": motor_id, "name": name, "group": group, "min": minimum,
            "max": maximum, "default": default, "duration_ms": duration_ms,
            "range_source": source, **extra}


MOTORS = (
    _motor(0, "Kick", "drums", 2100, 2450, 2200, 150,
           "max-control.maxpat; dynamixel_control/drum.py", rest=2200, strike=2370),
    # The snare and ride were physically exchanged; calibration stays with each motor.
    _motor(1, "Ride", "drums", 1850, 2125, 1850, 150,
           "max-control.maxpat; dynamixel_control/drum.py", rest=1850, strike=2000),
    _motor(2, "Snare", "drums", 2070, 2350, 2300, 150,
           "max-control.maxpat; dynamixel_control/drum.py", rest=2300, strike=2150),
    _motor(3, "Hi-hat", "drums", 2410, 2600, 2600, 200,
           "max-control.maxpat (narrower than Python)", rest=2600, strike=2430),
    _motor(4, "Head turn", "head", 1620, 2380, 2000, 3000,
           "Legacy mapping; updated head configuration pending", enabled=False),
    _motor(5, "Head left", "head", 1242, 2436, 1840, 1200,
           "Legacy mapping; updated head configuration pending", enabled=False),
    _motor(6, "Head right", "head", 2363, 3524, 2940, 1200,
           "Legacy mapping; updated head configuration pending", enabled=False),
    *(_motor(motor_id, f"Rib {motor_id}", "ribs", 2450, 4090, 2450, 2500,
             "max-control.maxpat / p ribs") for motor_id in (20, 21, 22)),
    *(_motor(motor_id, f"Rib {motor_id}", "ribs", 0, 1700, 1700, 2500,
             "max-control.maxpat / p ribs") for motor_id in (25, 26, 27)),
)
MOTORS_BY_ID = {motor["id"]: motor for motor in MOTORS}
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"))


def _integer(value: Any, name: str, minimum: int, maximum: int) -> int:
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not minimum <= value <= maximum or not math.isfinite(value)
            or int(value) != value):
        raise ValueError(f"{name} must be an integer from {minimum} to {maximum}.")
    return int(value)


def _boolean(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be true or false.")
    return value


def _host(value: Any) -> str:
    if not isinstance(value, str) or "%" in value:
        raise ValueError("Host must be a literal loopback or private unicast IP address.")
    try:
        address = ipaddress.ip_address(value)
    except ValueError as error:
        raise ValueError("Host must be a literal loopback or private unicast IP address.") from error
    private = any(address.version == network.version and address in network
                  for network in PRIVATE_NETWORKS)
    # A subnet mask is not part of this API. Reject .255 targets conservatively
    # to exclude common directed broadcasts as well as the limited broadcast.
    broadcast_candidate = address.version == 4 and address.packed[-1] == 255
    if (address.is_unspecified or address.is_multicast or broadcast_candidate
            or not (address.is_loopback or private)):
        raise ValueError("Host must be a loopback or private unicast address, not a broadcast target.")
    return str(address)


def _osc_string(value: str) -> bytes:
    encoded = value.encode("utf-8") + b"\0"
    return encoded + b"\0" * (-len(encoded) % 4)


def encode_osc(address: str, args: list[str | int]) -> bytes:
    """Encode the bridge's OSC string/int32 subset without extra dependencies."""
    types = ","
    values = []
    if not address.startswith("/") or "\0" in address:
        raise ValueError("Invalid OSC address.")
    for arg in args:
        if isinstance(arg, str) and "\0" not in arg:
            types += "s"
            values.append(_osc_string(arg))
        elif type(arg) is int and -(2 ** 31) <= arg < 2 ** 31:
            types += "i"
            values.append(struct.pack(">i", arg))
        else:
            raise ValueError("OSC arguments must be strings or signed 32-bit integers.")
    return _osc_string(address) + _osc_string(types) + b"".join(values)


class RobotControlService:
    def __init__(self, ribs: RibController | None = None,
                 drums: DrumController | None = None, head: HeadController | None = None) -> None:
        self._lock = threading.RLock()
        self._emergency_lock = threading.Lock()
        self._emergency_stopped = threading.Event()
        self._generation = 0
        self._pending_stops = 0
        self._config = {"host": "127.0.0.1", "port": 5009}
        self._history: deque[dict[str, Any]] = deque(maxlen=HISTORY_LIMIT)
        self._last_error: str | None = None
        self._closed = False
        self._ribs = ribs if ribs is not None else RibController()
        self._drums = drums if drums is not None else DrumController()
        self._head = head if head is not None else HeadController()
        self._controllers = {"ribs": self._ribs, "drums": self._drums, "head": self._head}

    def _output_state(self) -> dict[str, bool]:
        with self._emergency_lock:
            stopped = self._emergency_stopped.is_set()
            return {"armed": not stopped, "emergency_stopped": stopped}

    def _signal_stop(self) -> dict[str, str]:
        """Called under the short emergency lock, never the serial/service lock."""
        failures = {}
        for group, controller in self._controllers.items():
            try:
                controller.request_stop()
            except Exception as error:
                failures[group] = f"Could not cancel pending {group} commands: {error}"
        return failures

    def _connections(self) -> dict[str, Any]:
        return {group: controller.snapshot() for group, controller in self._controllers.items()}

    @staticmethod
    def _port_key(device: Any) -> str | None:
        if not isinstance(device, str) or not device:
            return None
        return connection_key(device)

    def _assert_port_available(self, group: str, device: Any = None) -> None:
        selected = device if device is not None else self._controllers[group].snapshot().get("device")
        key = self._port_key(selected)
        if key is None:
            return  # The controller reports a missing or invalid selection.
        for other, controller in self._controllers.items():
            if other == group:
                continue
            state = controller.snapshot()
            if state.get("port_open") and self._port_key(state.get("device")) == key:
                raise ValueError(f"That serial adapter is already connected to {other}. "
                                 f"Choose the separate {group} adapter, or disconnect {other} first.")

    def _status(self) -> dict[str, Any]:
        return copy.deepcopy({
            "config": self._config,
            "motors": list(MOTORS), "history": list(self._history),
            "range_note": RANGE_NOTE, "duration_note": DURATION_NOTE,
            "duration_min_ms": MIN_DURATION_MS, "duration_max_ms": MAX_DURATION_MS,
            "last_error": self._last_error,
            **self._connections(),
            **self._output_state(),
            "transport_note": "Ribs, drums, and calibrated head axes use separate serial connections with read-back.",
        })

    def dispatch(self, method: str, path: str,
                 payload: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
        if path == f"{API_PREFIX}/emergency-stop":
            return self._stop_dispatch(method, payload)
        # Capture before queuing: a stop/reset invalidates older waiting motion.
        with self._emergency_lock:
            generation = self._generation
        if path in {f"{API_PREFIX}/drums/performance/{action}" for action in ("schedule", "status", "stop")}:
            # Existing sessions own only the drum bus. Head/rib USB operations
            # must not delay its heartbeat or cancellation behind the service
            # lock. New starts still serialize cross-port selection below.
            return self._drum_performance(method, path, payload, generation)
        with self._lock:
            if path.startswith(f"{API_PREFIX}/drums/performance/"):
                return self._drum_performance(method, path, payload, generation)
            if method == "GET" and path == f"{API_PREFIX}/status":
                return 200, self._status()
            if path == f"{API_PREFIX}/head/calibration":
                if method != "GET":
                    return 405, {"ok": False, "error": "Use GET for head calibration status."}
                return 200, {"ok": True, "head": self._head.snapshot(), **self._output_state()}
            if path == f"{API_PREFIX}/head/diagnostics":
                if method != "GET":
                    return 405, {"ok": False, "error": "Use GET for read-only head diagnostics."}
                self._assert_port_available("head")
                result = self._head.motion_sample()
                return (200 if result["ok"] else 409), {**result, **self._output_state()}
            if path in (f"{API_PREFIX}/drums/status", f"{API_PREFIX}/head/status"):
                if method != "GET":
                    return 405, {"ok": False, "error": "Use GET for motor status."}
                group = path.split("/")[-2]
                return 200, {"ok": True, group: self._controllers[group].snapshot(), **self._output_state()}
            if path not in {f"{API_PREFIX}/{suffix}" for suffix in
                            ("config", "arm", "emergency-reset", "command", "ribs/check", "ribs/disconnect",
                             "drums/check", "drums/disconnect", "head/check", "head/disconnect", "head/upright",
                             "head/calibration/start", "head/calibration/stop",
                             "head/calibration/centre", "head/calibration/save")}:
                return 404, {"ok": False, "error": "Unknown robot endpoint."}
            if method != "POST":
                return 405, {"ok": False, "error": "Use POST for robot actions."}
            if self._closed:
                return 503, {"ok": False, "error": "Robot control service is closed."}
            if not isinstance(payload, dict):
                return 400, {"ok": False, "error": "A JSON object is required."}
            try:
                if path.endswith("/emergency-reset"):
                    return self._reset_emergency(generation)
                if path.endswith("/arm"):
                    return 410, {"ok": False, **self._output_state(),
                                 "error": "The output-enable control was removed. Use emergency-stop and emergency-reset."}
                for group, controller in self._controllers.items():
                    if path.endswith(f"/{group}/check"):
                        self._assert_port_available(group, payload.get("device"))
                        if group == "ribs":
                            status = controller.check(payload.get("device"))
                        else:
                            status = controller.check(payload.get("device"), payload.get("baudrate"))
                        return 200, {"ok": True, group: status, **self._output_state()}
                    if path.endswith(f"/{group}/disconnect"):
                        return 200, {"ok": True, group: controller.disconnect(), **self._output_state()}
                if path.endswith("/head/upright"):
                    self._assert_port_available("head")
                    result = self._head.capture_upright()
                    return (200 if result["ok"] else 502), {**result, **self._output_state()}
                if path.startswith(f"{API_PREFIX}/head/calibration/"):
                    action = path.rsplit("/", 1)[1]
                    if action == "start":
                        with self._emergency_lock:
                            blocked = self._emergency_stopped.is_set() or generation != self._generation
                        if blocked:
                            return 409, {"ok": False, **self._output_state(),
                                         "error": "Head range recording was cancelled by emergency stop. Reset it and start a new recording."}
                    if action != "stop":
                        self._assert_port_available("head")
                    if action == "save":
                        result = self._head.calibration_save(payload.get("labels"))
                    else:
                        handler = {"start": self._head.calibration_start,
                                   "stop": self._head.calibration_stop,
                                   "centre": self._head.calibration_centre}[action]
                        result = handler()
                    return (200 if result["ok"] else 502), {**result, **self._output_state()}
                if path.endswith("/config"):
                    host = _host(payload.get("host"))
                    port = _integer(payload.get("port"), "Port", 1, 65535)
                    self._config = {"host": host, "port": port}
                    self._last_error = None
                    return 200, {"ok": True, **self._status(), "message": "Legacy OSC settings saved; motor tests use serial."}
                return self._command(payload, generation)
            except ValueError as error:
                return 400, {"ok": False, "error": str(error), **self._connections(), **self._output_state()}

    def _drum_performance(self, method: str, path: str, payload: Any,
                          generation: int) -> tuple[int, dict[str, Any]]:
        performance = getattr(self._drums, "performance", None)
        # Recheck emergency generation after waiting for the drum bus, and keep
        # the operation and its two snapshots in the same session/lock scope.
        with performance.lock if performance is not None else nullcontext():
            return self._drum_performance_locked(method, path, payload, generation, performance)

    def _drum_performance_locked(self, method: str, path: str, payload: Any,
                                 generation: int, performance: Any) -> tuple[int, dict[str, Any]]:

        def response(code, **values):
            snapshot = performance.snapshot() if performance else None
            drums = self._drums.snapshot()
            return code, {"ok": code == 200, **values,
                          "server_time_ms": time.monotonic() * 1000,
                          "performance": snapshot, "drums": drums,
                          **self._output_state()}

        action = path.rsplit("/", 1)[-1]
        if action not in ("start", "schedule", "stop", "status"):
            return response(404, error="Unknown drum performance endpoint.")
        if method != ("GET" if action == "status" else "POST"):
            return response(405, error="Use GET for status and POST for drum performance actions.")
        with self._emergency_lock:
            closed = self._closed
            blocked = self._emergency_stopped.is_set() or generation != self._generation
        if closed or performance is None:
            return response(503, error="Drum performance service is unavailable.")
        if action == "status":
            return response(200)
        if not isinstance(payload, dict):
            return response(400, error="A JSON object is required.")
        fields = {"token", "instruments"} if action == "start" else {"token", "events"} if action == "schedule" else {"token"}
        if set(payload) != fields:
            return response(400, error=f"Provide only {', '.join(sorted(fields))} for {action}.")
        if action != "stop":
            if blocked:
                return response(409, error="Drum performance was cancelled by emergency stop or reset.")
        try:
            if action == "start":
                self._assert_port_available("drums")
                performance.start(payload["token"], payload["instruments"])
                return response(200)
            if action == "schedule":
                return response(200, **performance.schedule(payload["token"], payload["events"]))
            performance.stop(payload["token"])
            return response(200)
        except ValueError as error:
            return response(400, error=str(error))
        except RuntimeError as error:
            return response(409, error=str(error))
        except Exception as error:
            performance.stop(payload["token"])
            return response(502, error=f"Drum performance failed: {error}")

    def _stop_dispatch(self, method: str, payload: Any) -> tuple[int, dict[str, Any]]:
        if method != "POST":
            return 405, {"ok": False, "error": "Use POST for robot actions."}
        if not isinstance(payload, dict):
            return 400, {"ok": False, "error": "A JSON object is required."}
        with self._emergency_lock:
            if self._closed:
                return 503, {"ok": False, "error": "Robot control service is closed."}
            self._emergency_stopped.set()
            self._generation += 1
            self._pending_stops += 1
            signal_failures = self._signal_stop()
        # request_stop above cancels in-flight jobs even while a command owns this lock.
        with self._lock:
            results = {}
            try:
                if self._closed:
                    return 503, {"ok": False, "error": "Robot control service is closed.", **self._output_state()}
                for group, controller in (("ribs", self._ribs), ("drums", self._drums), ("head", self._head)):
                    try:
                        response = controller.emergency_stop()
                    except Exception as error:
                        response = {"ok": False, "error": str(error), "message": str(error)}
                    if group in signal_failures:
                        response = {**response, "ok": False, "error": signal_failures[group]}
                    results[group] = response
                failures = [f"{group}: {result.get('error') or result.get('message')}"
                            for group, result in results.items() if not result["ok"]]
                message = ("Emergency stop is latched. Pending motor commands were cancelled; "
                           "connected, verified rib, drum, and head buses received torque-off requests.")
                result = {"ok": not failures, "message": message, "results": results,
                          **self._connections(), **self._output_state()}
                if failures:
                    result["error"] = "Emergency stop remains latched. " + " ".join(failures)
                    result["message"] = result["error"]
                self._last_error = result.get("error")
                self._record("emergency_stop", result)
                return (200 if result["ok"] else 502), result
            finally:
                with self._emergency_lock:
                    self._pending_stops -= 1

    def _reset_emergency(self, generation: int) -> tuple[int, dict[str, Any]]:
        # The service lock serializes releases; the emergency lock prevents a
        # newly arriving stop from being cleared before its release is handled.
        with self._emergency_lock:
            if self._pending_stops:
                return 409, {"ok": False, "armed": False, "emergency_stopped": True,
                             "error": "Emergency stop is still being applied. Wait before resetting it."}
            if generation != self._generation:
                stopped = self._emergency_stopped.is_set()
                return 409, {"ok": False, "armed": not stopped, "emergency_stopped": stopped,
                             "error": "Emergency state changed while reset was waiting. Review it and request a new reset."}
            try:
                self._ribs.reset_stop()
                self._drums.reset_stop()
                self._head.reset_stop()
            except Exception as error:
                self._emergency_stopped.set()
                self._generation += 1
                self._signal_stop()
                return 502, {"ok": False, "armed": False, "emergency_stopped": True,
                             "error": f"Emergency stop could not be reset: {error}"}
            self._generation += 1
            self._emergency_stopped.clear()
        return 200, {"ok": True, **self._status(),
                     "message": "Emergency stop reset. Motor torque is unchanged; cancelled actions will not resume."}

    def _command(self, payload: dict[str, Any], generation: int) -> tuple[int, dict[str, Any]]:
        # Kept for older API clients; the setup UI always requests live actions.
        dry_run = _boolean(payload.get("dry_run", True), "Dry run")
        kind = payload.get("kind")
        if kind in ("head_move", "head_moves", "head_torque"):
            return self._head_command(payload, generation, dry_run)
        if payload.get("group") == "head":
            raise ValueError("Use head_move, head_moves or head_torque for the separately connected calibrated head.")
        targets = None
        torque = None
        strike = None
        if kind == "move":
            motor_id = _integer(payload.get("motor_id"), "Motor ID", 0, 27)
            motor = MOTORS_BY_ID.get(motor_id)
            if motor is None:
                raise ValueError("Choose one of the listed robot motors.")
            if motor.get("enabled") is False:
                raise ValueError("Legacy head IDs are disabled. Use head_move with an ID from the saved head calibration.")
            position = _integer(payload.get("position"), "Position", motor["min"], motor["max"])
            duration = _integer(payload.get("duration_ms"), "Duration", MIN_DURATION_MS, MAX_DURATION_MS)
            group = motor["group"]
            targets = [(motor_id, position, duration)]
        elif kind == "drums_strike":
            group = "drums"
            motor_id = _integer(payload.get("motor_id"), "Drum motor ID", 0, 3)
            motor = MOTORS_BY_ID[motor_id]
            duration = _integer(payload.get("duration_ms", motor["duration_ms"]),
                                "Duration", MIN_DURATION_MS, MAX_DURATION_MS)
            strike = (motor_id, motor["strike"], duration, DRUM_RETURN_MS)
        elif kind == "ribs":
            group = "ribs"
            position = _integer(payload.get("position"), "Rib opening", 0, 127)
            duration = _integer(payload.get("duration_ms"), "Duration", MIN_DURATION_MS, MAX_DURATION_MS)
            targets = []
            for motor_id in (20, 21, 22, 25, 26, 27):
                # Match the integer scale outputs in Max's p ribs subpatch.
                target = (int(2450 + 1640 * position / 127) if motor_id < 25
                          else int(1700 - 1700 * position / 127))
                targets.append((motor_id, target, duration))
        elif kind in ("ribs_torque", "drums_torque"):
            group = "ribs" if kind == "ribs_torque" else "drums"
            torque = _boolean(payload.get("enabled"), "Enabled")
        elif kind == "torque":
            raise ValueError("All-motor torque is unavailable. Use the rib-cage, drum, or calibrated head torque controls.")
        else:
            raise ValueError("Command kind must be move, ribs, ribs_torque, drums_torque, drums_strike, head_move, head_moves or head_torque.")
        if strike is not None:
            commands = [{"address": "Dynamixel", "args": [motor_id, "profile_ms", DRUM_PREPARE_MS, "goal", motor["rest"]]},
                        {"address": "Dynamixel", "args": [motor_id, "profile_ms", duration, "goal", motor["strike"]]},
                        {"address": "Dynamixel", "args": [motor_id, "profile_ms", DRUM_RETURN_MS, "goal", motor["rest"]]}]
        elif targets is not None:
            commands = [{"address": "Dynamixel", "args": [motor_id, "profile_ms", duration, "goal", position]}
                        for motor_id, position, duration in targets]
        else:
            ids = (20, 21, 22, 25, 26, 27) if group == "ribs" else (0, 1, 2, 3)
            commands = [{"address": "Dynamixel", "args": [motor_id, "torque", int(torque)]} for motor_id in ids]
            if group == "drums" and torque:
                commands = [{"address": "Dynamixel", "args": [motor_id, "profile_ms", DRUM_TORQUE_REST_MS,
                                                              "goal", MOTORS_BY_ID[motor_id]["rest"]]}
                            for motor_id in ids] + commands
        torque_off = torque is False
        if not dry_run and not torque_off:
            with self._emergency_lock:
                stopped = self._emergency_stopped.is_set()
                stale = generation != self._generation
            if stopped or stale:
                return 409, {"ok": False, **self._output_state(),
                             "error": ("Emergency stop is latched. Reset it before moving motors or enabling torque."
                                       if stopped else "This queued command was cancelled by an emergency stop or reset. Send a new command.")}
        result = {"ok": True, "dry_run": dry_run, "commands": commands,
                  "transport": "serial", "group": group, "message": "Preview only. No packet sent."}
        if group == "drums" and torque:
            result["message"] = "Preview only. Arm torque-on moves all four drums to raised rest and confirms arrival before hits."
        controller = self._controllers[group]
        if not dry_run:
            self._assert_port_available(group)
            response = (controller.strike(*strike, rest_position=motor["rest"],
                                          prepare_duration_ms=DRUM_PREPARE_MS) if strike is not None else
                        controller.move(targets) if targets is not None else controller.torque(torque))
            result.update(response)
            self._last_error = result.get("error")
        else:
            result[group] = controller.snapshot()
        result.update(self._output_state())
        self._record(kind, result)
        return (200 if result["ok"] else 502), result

    def _head_command(self, payload: dict[str, Any], generation: int, dry_run: bool) -> tuple[int, dict[str, Any]]:
        """Explicit head namespace keeps overlapping drum IDs off the head bus."""
        if payload.get("group", "head") != "head":
            raise ValueError("Head commands must use the head group.")
        kind = payload["kind"]
        state = self._head.snapshot()
        saved = state.get("calibration", {}).get("saved")
        axes = {axis["id"]: axis for axis in saved["axes"]} if saved else {}
        torque = _boolean(payload.get("enabled"), "Enabled") if kind == "head_torque" else None
        if torque is not False and len(axes) != 2:
            raise ValueError("Save the two head axes' mechanical ranges before powered control.")
        moving = kind in ("head_move", "head_moves")
        if moving:
            requested = ([{key: payload.get(key) for key in ("motor_id", "position", "duration_ms")}]
                         if kind == "head_move" else payload.get("targets"))
            if not isinstance(requested, list) or not 1 <= len(requested) <= 2:
                raise ValueError("Head targets must contain one or two distinct saved axes.")
            targets = []
            for target in requested:
                if not isinstance(target, dict) or set(target) != {"motor_id", "position", "duration_ms"}:
                    raise ValueError("Each head target must contain motor_id, position and duration_ms.")
                motor_id = _integer(target["motor_id"], "Head motor ID", 0, 252)
                if motor_id not in axes:
                    raise ValueError("Choose a motor ID from the saved head calibration.")
                position = _integer(target["position"], "Head position", axes[motor_id]["min"], axes[motor_id]["max"])
                duration = _integer(target["duration_ms"], "Head duration", HEAD_MIN_DURATION_MS, HEAD_MAX_DURATION_MS)
                targets.append({"motor_id": motor_id, "position": position, "duration_ms": duration})
            if len({target["motor_id"] for target in targets}) != len(targets):
                raise ValueError("Head targets must use distinct motor IDs.")
            commands = [{"address": "Dynamixel", "args": [target["motor_id"], "requested_profile_ms",
                         target["duration_ms"], "goal", target["position"]]} for target in targets]
        else:
            ids = sorted(axes) if axes else [row["id"] for row in state.get("motors", [])]
            commands = [{"address": "Dynamixel", "args": [motor_id, "torque", int(torque)],
                         "preload_current_pose": torque} for motor_id in ids]
        if not dry_run and torque is not False:
            with self._emergency_lock:
                stopped = self._emergency_stopped.is_set()
                stale = generation != self._generation
            if stopped or stale:
                return 409, {"ok": False, "head": state, **self._output_state(),
                             "error": ("Emergency stop is latched. Reset it before powered head control."
                                       if stopped else "This queued head command was cancelled by emergency stop or reset. Send a new command.")}
        result = {"ok": True, "dry_run": dry_run, "commands": commands, "transport": "serial",
                  "group": "head", "head": state, "message": "Preview only. Actual head duration is calculated from fresh read-back."}
        if not dry_run:
            self._assert_port_available("head")
            if kind == "head_move":
                response = self._head.move(**targets[0])
            elif kind == "head_moves":
                response = self._head.moves(targets)
            else:
                response = self._head.torque(torque)
            result.update(response)
            move = result.get("head", {}).get("last_move")
            if result["ok"] and moving and move:
                actual = move.get("targets") or ([move] if kind == "head_move" else [])
                result["commands"] = [{"address": "Dynamixel", "args":
                                       [target["motor_id"], "profile_ms", target["duration_ms"], "goal", target["position"]]}
                                      for target in actual]
            self._last_error = result.get("error")
        result.update(self._output_state())
        self._record(kind, result)
        return (200 if result["ok"] else 502), result

    def _record(self, kind: str, result: dict[str, Any]) -> None:
        self._history.appendleft(copy.deepcopy({
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "kind": kind, "config": self._config, **result,
        }))
        study = getattr(self, "study_recorder", None)
        if study is not None:
            study.record("robot.command_completed", {"kind": kind, "config": self._config, **result})

    def close(self) -> None:
        with self._emergency_lock:
            self._closed = True
            self._emergency_stopped.set()
            self._generation += 1
            self._signal_stop()
        with self._lock:
            for controller in (self._ribs, self._drums, self._head):
                controller.close()
