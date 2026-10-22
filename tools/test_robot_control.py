#!/usr/bin/env python3
"""Robot service checks with every hardware controller replaced by a fake."""
from __future__ import annotations

import copy
import threading
import unittest
from unittest.mock import patch

from robot_control import MOTORS, RobotControlService, encode_osc
from robot_drum_performance import DrumPerformance


class FakeSerial:
    """No serial imports or hardware access, even with dependencies installed."""
    group = "ribs"
    ids = (20, 21, 22, 25, 26, 27)
    baudrate = 1_000_000

    def __init__(self):
        self.calls = []
        self.failure = None
        self.emergency_failure = None
        self.stop_requested = threading.Event()
        self.state = {
            "state": "unchecked", "message": "Check connection first.",
            "device": f"/dev/cu.usbserial-FAKE-{self.group}",
            "baudrate": self.baudrate, "port_open": False, "ports": [],
            "motors": [{"id": motor_id, "connected": False, "position": None,
                        "torque_enabled": None} for motor_id in self.ids],
        }

    def snapshot(self):
        return copy.deepcopy(self.state)

    def checked(self, device=None, baudrate=None):
        if device is not None:
            self.state["device"] = device
        if baudrate is not None:
            self.state["baudrate"] = baudrate
        self.state.update(state="ready", message="Motors replied.", port_open=True)
        for row in self.state["motors"]:
            row.update(connected=True, position=2000 + row["id"], torque_enabled=False)
        return self.snapshot()

    def disconnect(self):
        self.calls.append(("disconnect",))
        self.state.update(state="disconnected", message="Serial port closed.", port_open=False)
        return self.snapshot()

    def result(self):
        if self.failure:
            self.state.update(state="partial", message=self.failure)
            return {"ok": False, "error": self.failure, "message": self.failure,
                    self.group: self.snapshot()}
        return {"ok": True, "message": "Command accepted.", self.group: self.snapshot()}

    def move(self, targets):
        self.calls.append(("move", targets))
        return self.result()

    def torque(self, enabled):
        self.calls.append(("torque", enabled))
        return self.result()

    def close(self):
        self.calls.append(("close",))
        self.state["port_open"] = False

    def request_stop(self):
        self.calls.append(("request_stop",))
        self.stop_requested.set()

    def reset_stop(self):
        self.calls.append(("reset_stop",))
        self.stop_requested.clear()

    def emergency_stop(self):
        self.calls.append(("emergency_stop",))
        if self.emergency_failure:
            return {"ok": False, "error": self.emergency_failure, self.group: self.snapshot()}
        if self.state["port_open"]:
            for motor in self.state["motors"]:
                motor["torque_enabled"] = False
        return {"ok": True, "message": "Emergency stop applied.", self.group: self.snapshot()}


class FakeRibs(FakeSerial):
    def check(self, device=None):
        self.calls.append(("check", device))
        return self.checked(device)


class FakeDrums(FakeSerial):
    group = "drums"
    ids = (0, 1, 2, 3)

    def check(self, device=None, baudrate=None):
        self.calls.append(("check", device, baudrate))
        return self.checked(device, baudrate)

    def strike(self, motor_id, strike_position, duration_ms, return_duration_ms=150,
               *, rest_position, prepare_duration_ms=500):
        self.calls.append(("strike", motor_id, strike_position, duration_ms, return_duration_ms,
                           rest_position, prepare_duration_ms))
        self.state.update(busy=not self.failure, strike={"state": "preparing", "motor_id": motor_id,
                                                       "rest_position": rest_position})
        return self.result()


class FakeHead(FakeSerial):
    group = "head"
    ids = (8, 9)  # Actual discovered IDs need not be the factory defaults.
    baudrate = 57_600

    def motion_sample(self):
        self.calls.append(("motion_sample",))
        if not self.state["port_open"]:
            return {"ok": False, "error": "Identify the head before reading motion diagnostics."}
        return {"ok": True, "sample": {"sampled_at": "2026-10-19T01:00:00+00:00", "motors": [
            {"id": motor_id, "position": 2000, "position_trajectory": 2002, "present_pwm": 100}
            for motor_id in self.ids]}}

    def __init__(self):
        super().__init__()
        self.state["upright_reference"] = None
        self.state["calibration"] = {"recording": False, "samples": 0, "axes": [],
                                     "saved": None, "saved_matches_connection": False}
        self.validation_error = None
        self.batch_durations = {}
        for row in self.state["motors"]:
            row.update(model_number=1090, firmware=45)

    def check(self, device=None, baudrate=None):
        self.calls.append(("check", device, baudrate))
        return self.checked(device, baudrate)

    def calibrated(self, ids=None):
        ids = self.ids if ids is None else ids
        self.state["motors"] = [
            {"id": motor_id, "connected": True, "model_number": 1090, "firmware": 45,
             "position": 2000, "torque_enabled": False, "profile_mode": "time",
             "operating_mode": 3, "error": None} for motor_id in ids]
        self.state.update(state="ready", port_open=True)
        self.state["calibration"].update(saved_matches_connection=True, saved={
            "version": 1, "device": self.state["device"], "baudrate": self.state["baudrate"],
            "model_number": 1090, "sample_count": 20, "saved_at": "2026-10-16T00:00:00+00:00",
            "axes": [{"id": motor_id, "label": f"Axis {index}", "min": 1800 + index * 100,
                      "centre": 2000, "max": 2200 - index * 100}
                     for index, motor_id in enumerate(ids)],
        })
        return self.snapshot()

    def capture_upright(self):
        self.calls.append(("capture_upright",))
        if not self.failure:
            self.checked()
            self.state["upright_reference"] = {
                "device": self.state["device"], "baudrate": self.state["baudrate"],
                "positions": [{"id": row["id"], "position": row["position"]}
                              for row in self.state["motors"]],
            }
        return self.result()

    def emergency_stop(self):
        self.state["calibration"]["recording"] = False
        return super().emergency_stop()

    def move(self, motor_id, position, duration_ms):
        self.calls.append(("move", motor_id, position, duration_ms))
        return self.result()

    def moves(self, targets):
        self.calls.append(("moves", copy.deepcopy(targets)))
        if not self.failure:
            actual = [{**target, "requested_duration_ms": target["duration_ms"],
                       "duration_ms": self.batch_durations.get(target["motor_id"], target["duration_ms"])}
                      for target in targets]
            self.state["last_move"] = {"targets": actual,
                                       "duration_ms": max(target["duration_ms"] for target in actual),
                                       "started_at": "2026-10-19T01:00:00+00:00"}
        return self.result()

    def calibration_start(self):
        self.calls.append(("calibration_start",))
        if not self.failure:
            self.state["calibration"]["recording"] = True
        return self.result()

    def calibration_stop(self):
        self.calls.append(("calibration_stop",))
        self.state["calibration"]["recording"] = False
        return self.result()

    def calibration_centre(self):
        self.calls.append(("calibration_centre",))
        return self.result()

    def calibration_save(self, labels=None):
        self.calls.append(("calibration_save", labels))
        if self.validation_error:
            raise ValueError(self.validation_error)
        return self.result()


class RobotControlTests(unittest.TestCase):
    def setUp(self):
        self.ribs, self.drums, self.head = FakeRibs(), FakeDrums(), FakeHead()
        self.controllers = {"ribs": self.ribs, "drums": self.drums, "head": self.head}
        for name in ("RibController", "DrumController", "HeadController"):
            guard = patch("robot_control." + name, side_effect=AssertionError("Real controller created"))
            guard.start()
            self.addCleanup(guard.stop)
        self.service = RobotControlService(ribs=self.ribs, drums=self.drums, head=self.head)
        self.addCleanup(self.service.close)

    def post(self, action, **payload):
        return self.service.dispatch("POST", "/api/robot/" + action, payload)

    def status(self):
        code, body = self.service.dispatch("GET", "/api/robot/status")
        self.assertEqual(code, 200)
        return body

    def move(self, **overrides):
        return self.post("command", **{
            "kind": "move", "motor_id": 0, "position": 2200,
            "duration_ms": 500, **overrides,
        })

    def head_move(self, **overrides):
        return self.post("command", **{
            "kind": "head_move", "motor_id": 8, "position": 2000,
            "duration_ms": 2000, **overrides,
        })

    def head_moves(self, **overrides):
        return self.post("command", **{
            "kind": "head_moves", "targets": [
                {"motor_id": 8, "position": 1900, "duration_ms": 2000},
                {"motor_id": 9, "position": 2100, "duration_ms": 3000},
            ], **overrides,
        })

    def assert_no_io(self):
        for group, controller in self.controllers.items():
            self.assertEqual(controller.calls, [], group)

    def test_head_diagnostics_are_explicit_read_only_samples(self):
        route = "/api/robot/head/diagnostics"
        code, result = self.service.dispatch("GET", route)
        self.assertEqual(code, 409)
        self.assertFalse(result["ok"])
        self.head.checked()
        self.head.state["busy"] = True
        self.head.calls.clear()
        code, result = self.service.dispatch("GET", route)
        self.assertEqual(code, 200)
        self.assertEqual([row["id"] for row in result["sample"]["motors"]], [8, 9])
        self.assertEqual(self.head.calls, [("motion_sample",)])
        self.assertEqual(self.ribs.calls + self.drums.calls, [])
        self.assertEqual(self.service.dispatch("POST", route, {})[0], 405)
        self.assertEqual(self.head.calls, [("motion_sample",)])

    def test_status_preview_arm_and_legacy_config_never_access_hardware(self):
        with patch("socket.socket") as socket_factory:
            state = self.status()
            self.assertTrue(state["armed"])
            self.assertFalse(state["emergency_stopped"])
            self.assertEqual(state["config"], {"host": "127.0.0.1", "port": 5009})
            self.assertEqual(len(state["motors"]), 13)
            self.assertEqual(state["head"]["baudrate"], 57_600)
            code, result = self.move()
            self.assertEqual(code, 200)
            self.assertTrue(result["dry_run"])
            self.assertEqual(result["commands"], [
                {"address": "Dynamixel", "args": [0, "profile_ms", 500, "goal", 2200]}])
            self.move(motor_id=20, position=2450)
            for kind in ("ribs_torque", "drums_torque"):
                self.post("command", kind=kind, enabled=True, dry_run=True)
            self.assertEqual(self.post("arm", enabled=True)[0], 410)
            self.assertEqual(self.post("arm", enabled=False)[0], 410)
            self.post("config", host="192.168.1.30", port=5009)
            socket_factory.assert_not_called()
        self.assert_no_io()

    def test_packet_encoding_matches_fixed_osc_bytes(self):
        self.assertEqual(encode_osc("/motor", ["drum", "torque", 0]),
                         b"/motor\0\0,ssi\0\0\0\0drum\0\0\0\0torque\0\0\0\0\0\0")

    def test_drum_torque_preview_includes_preload_and_powered_rest_move(self):
        code, result = self.post("command", kind="drums_torque", enabled=True, dry_run=True)
        self.assertEqual(code, 200)
        self.assertEqual([command["args"] for command in result["commands"]],
                         [[motor, "profile_ms", 2000, "goal", rest]
                          for motor, rest in enumerate((2200, 1850, 2300, 2600))]
                         + [[motor, "torque", 1] for motor in range(4)]
                         + [[motor, "profile_ms", 2000, "goal", rest]
                            for motor, rest in enumerate((2200, 1850, 2300, 2600))])
        self.assertIn("confirms arrival", result["message"])
        self.assert_no_io()

    def test_live_drums_and_ribs_route_to_their_own_serial_controller(self):
        with patch("socket.socket") as socket_factory:
            for motor_id, position in ((0, 2200), (1, 1850)):
                code, result = self.move(motor_id=motor_id, position=position, dry_run=False)
                self.assertEqual(code, 200)
                self.assertEqual(result["group"], "drums")
                self.assertEqual(result["transport"], "serial")
                self.assertFalse(result["dry_run"])
            code, result = self.move(motor_id=20, position=2450, dry_run=False)
            self.assertEqual(code, 200)
            self.assertEqual(result["group"], "ribs")
            socket_factory.assert_not_called()
        self.assertEqual(self.drums.calls, [("move", [(0, 2200, 500)]), ("move", [(1, 1850, 500)])])
        self.assertEqual(self.ribs.calls, [("move", [(20, 2450, 500)])])
        self.assertEqual(self.head.calls, [])

    def test_emergency_gate_allows_group_specific_torque_release(self):
        self.post("emergency-stop")
        for controller in self.controllers.values():
            controller.calls.clear()
        self.assertEqual(self.move(dry_run=False)[0], 409)
        for group, controller in (("ribs", self.ribs), ("drums", self.drums)):
            with self.subTest(group=group):
                code, rejected = self.post("command", kind=group + "_torque", enabled=True, dry_run=False)
                self.assertEqual(code, 409)
                self.assertFalse(rejected["armed"])
                self.assertEqual(controller.calls, [])
                code, result = self.post("command", kind=group + "_torque", enabled=False, dry_run=False)
                self.assertEqual(code, 200)
                self.assertFalse(result["armed"])
                self.assertEqual(controller.calls, [("torque", False)])
                self.assertTrue(result["emergency_stopped"])
        self.assertEqual(self.head.calls, [])

    def test_invalid_moves_emit_no_hardware_commands(self):
        invalid = [
            {"motor_id": True}, {"motor_id": 7}, {"motor_id": "0"},
            {"motor_id": 20, "position": 2449}, {"motor_id": 3, "position": 2601},
            {"position": 2099}, {"position": 2451}, {"position": 2200.1},
            {"position": True}, {"position": "2200"}, {"position": None},
            {"position": float("nan")}, {"position": float("inf")},
            {"position": 10 ** 1000}, {"duration_ms": 0}, {"duration_ms": 99},
            {"duration_ms": 5001}, {"duration_ms": False}, {"duration_ms": 100.5},
            {"dry_run": "false"}, {"dry_run": 0}, {"kind": "strike"},
        ]
        for values in invalid:
            with self.subTest(values=values):
                self.assertEqual(self.move(**{"dry_run": False, **values})[0], 400)
        for kind in ("ribs_torque", "drums_torque"):
            self.assertEqual(self.post("command", kind=kind, enabled=1, dry_run=False)[0], 400)
        self.assert_no_io()
        self.assertEqual(self.status()["history"], [])

    def test_all_motor_bounds_and_exact_integral_numbers(self):
        for motor in MOTORS:
            if motor.get("enabled") is False:
                self.assertEqual(self.move(motor_id=motor["id"], position=motor["default"])[0], 400)
                continue
            for position in (motor["min"], motor["max"]):
                with self.subTest(motor=motor["id"], position=position):
                    self.assertEqual(self.move(motor_id=motor["id"], position=position)[0], 200)
            self.assertEqual(self.move(motor_id=motor["id"], position=motor["min"] - 1)[0], 400)
            self.assertEqual(self.move(motor_id=motor["id"], position=motor["max"] + 1)[0], 400)
        self.assertEqual(self.move(motor_id=0.0, position=2200.0, duration_ms=500.0)[0], 200)
        self.assert_no_io()

    def test_grouped_ribs_mirror_and_stay_within_ranges(self):
        for opening in (0, 1, 64, 127):
            code, result = self.post("command", kind="ribs", position=opening, duration_ms=2500, dry_run=False)
            self.assertEqual(code, 200)
            self.assertEqual(result["transport"], "serial")
            triples = self.ribs.calls[-1][1]
            self.assertEqual([row[0] for row in triples], [20, 21, 22, 25, 26, 27])
            expected_left, expected_right = {0: (2450, 1700), 1: (2462, 1686),
                                             64: (3276, 843), 127: (4090, 0)}[opening]
            self.assertEqual([row[1] for row in triples], [expected_left] * 3 + [expected_right] * 3)
            self.assertEqual([row[2] for row in triples], [2500] * 6)
        for opening in (-1, 128, True, "64", 63.5):
            self.assertEqual(self.post("command", kind="ribs", position=opening, duration_ms=2500)[0], 400)
        self.assertEqual(self.drums.calls, [])
        self.assertEqual(self.head.calls, [])

    def test_rib_checks_keep_output_enabled_and_failures_are_visible(self):
        code, result = self.post("ribs/check", device="/dev/cu.usbserial-RIBS")
        self.assertEqual(code, 200)
        self.assertTrue(result["armed"])
        self.assertEqual(result["ribs"]["state"], "ready")
        self.assertEqual(self.ribs.calls, [("check", "/dev/cu.usbserial-RIBS")])
        self.ribs.failure = "Motor 22 did not reply. Check power and cabling."
        code, result = self.move(motor_id=20, position=2450, dry_run=False)
        self.assertEqual(code, 502)
        self.assertTrue(result["armed"])
        self.assertEqual(result["ribs"]["state"], "partial")
        self.assertIn("22", result["error"])
        self.assertEqual(self.post("ribs/disconnect")[1]["ribs"]["state"], "disconnected")

    def test_new_group_checks_and_disconnects_preserve_other_running_output(self):
        for group, baud in (("drums", 1_000_000), ("head", 115_200)):
            with self.subTest(group=group):
                device = "/dev/cu.usbserial-" + group
                code, result = self.post(group + "/check", device=device, baudrate=baud)
                self.assertEqual(code, 200)
                self.assertTrue(result["armed"])
                self.assertEqual(result[group]["device"], device)
                self.assertEqual(result[group]["baudrate"], baud)
                self.assertEqual(self.controllers[group].calls, [("check", device, baud)])
                code, result = self.post(group + "/disconnect")
                self.assertEqual(code, 200)
                self.assertTrue(result["armed"])
                self.assertFalse(result[group]["port_open"])
        self.assertEqual(self.ribs.calls, [])

    def test_head_upright_reads_discovered_ids_and_never_routes_a_write(self):
        code, result = self.post("head/check", device="/dev/cu.usbserial-HEAD", baudrate=57_600)
        self.assertEqual(code, 200)
        self.assertEqual([row["id"] for row in result["head"]["motors"]], [8, 9])
        code, result = self.post("head/upright")
        self.assertEqual(code, 200)
        self.assertTrue(result["armed"])
        self.assertEqual(result["head"]["upright_reference"]["positions"],
                         [{"id": 8, "position": 2008}, {"id": 9, "position": 2009}])
        self.assertEqual(self.head.calls, [("check", "/dev/cu.usbserial-HEAD", 57_600), ("capture_upright",)])
        self.assertEqual(self.ribs.calls, [])
        self.assertEqual(self.drums.calls, [])
        self.assertEqual(self.status()["history"], [])

    def test_head_read_failure_does_not_disarm_unrelated_output(self):
        self.head.failure = "Only one head axis replied."
        code, result = self.post("head/upright")
        self.assertEqual(code, 502)
        self.assertFalse(result["ok"])
        self.assertTrue(result["armed"])
        self.assertIn("one head axis", result["error"])
        self.assertIsNone(result["head"]["upright_reference"])

    def test_head_calibration_get_is_cached_detached_and_never_reads_hardware(self):
        self.head.state["calibration"].update(samples=27, axes=[{"id": 8, "min": 1800, "max": 2200}])
        code, result = self.service.dispatch("GET", "/api/robot/head/calibration")
        self.assertEqual(code, 200)
        self.assertTrue(result["armed"])
        self.assertEqual(result["head"]["calibration"]["samples"], 27)
        result["head"]["calibration"]["axes"][0]["min"] = -999
        current = self.service.dispatch("GET", "/api/robot/head/calibration")[1]
        self.assertEqual(current["head"]["calibration"]["axes"][0]["min"], 1800)
        self.assertEqual(self.post("head/calibration")[0], 405)
        self.assert_no_io()

    def test_head_calibration_actions_route_only_to_head_and_preserve_armed(self):
        labels = {"8": "Turn", "9": "Tilt"}
        for armed in (False, True):
            self.post("emergency-reset" if armed else "emergency-stop")
            for controller in self.controllers.values():
                controller.calls.clear()
            torque_before = [row["torque_enabled"] for row in self.head.state["motors"]]
            for action in ("start", "centre", "stop", "save"):
                with self.subTest(armed=armed, action=action):
                    payload = {"labels": labels} if action == "save" else {}
                    code, result = self.post("head/calibration/" + action, **payload)
                    if not armed and action == "start":
                        self.assertEqual(code, 409)
                        self.assertEqual(self.head.calls, [])
                        continue
                    self.assertEqual(code, 200)
                    self.assertEqual(result["armed"], armed)
                    self.assertIn("calibration", result["head"])
                    expected = ("calibration_save", labels) if action == "save" else ("calibration_" + action,)
                    self.assertEqual(self.head.calls[-1], expected)
            self.assertEqual([row["torque_enabled"] for row in self.head.state["motors"]], torque_before)
        self.assertEqual(self.post("head/calibration/save")[0], 200)
        self.assertEqual(self.head.calls[-1], ("calibration_save", None))
        self.assertEqual(self.ribs.calls, [])
        self.assertEqual(self.drums.calls, [])
        self.assertEqual([entry["kind"] for entry in self.status()["history"]], ["emergency_stop"])

    def test_head_calibration_failures_preserve_armed_and_surface_driver_errors(self):
        self.head.failure = "Select the head adapter and check its connection first."
        for action in ("start", "stop", "centre", "save"):
            with self.subTest(action=action):
                code, result = self.post("head/calibration/" + action)
                self.assertEqual(code, 502)
                self.assertTrue(result["armed"])
                self.assertEqual(result["error"], self.head.failure)
                self.assertIn("calibration", result["head"])
        self.head.validation_error = "Axis labels must refer to discovered motor IDs."
        code, result = self.post("head/calibration/save", labels={"999": "Wrong axis"})
        self.assertEqual(code, 400)
        self.assertEqual(result["error"], self.head.validation_error)
        self.assertTrue(result["armed"])
        self.assertEqual(self.head.calls[-1], ("calibration_save", {"999": "Wrong axis"}))
        self.assertEqual(self.ribs.calls, [])
        self.assertEqual(self.drums.calls, [])

    def test_head_calibration_ownership_guards_read_actions_but_stop_is_always_available(self):
        self.ribs.state.update(device="/dev/cu.usbserial-SHARED", port_open=True)
        self.head.state["device"] = "/dev/tty.usbserial-SHARED"
        self.head.state["calibration"]["recording"] = True
        for action in ("start", "centre", "save"):
            with self.subTest(action=action):
                code, result = self.post("head/calibration/" + action)
                self.assertEqual(code, 400)
                self.assertIn("already connected to ribs", result["error"])
                self.assertTrue(result["armed"])
        self.assert_no_io()
        torque_before = [row["torque_enabled"] for row in self.head.state["motors"]]
        code, result = self.post("head/calibration/stop")
        self.assertEqual(code, 200)
        self.assertTrue(result["armed"])
        self.assertFalse(result["head"]["calibration"]["recording"])
        self.assertEqual(self.head.calls, [("calibration_stop",)])
        self.assertEqual([row["torque_enabled"] for row in self.head.state["motors"]], torque_before)
        self.assertEqual(self.ribs.calls, [])
        self.assertEqual(self.drums.calls, [])

    def test_legacy_head_and_all_motor_writes_are_rejected(self):
        for dry_run in (True, False):
            for motor in (4, 5, 6, 8, 9):
                self.assertEqual(self.move(motor_id=motor, position=2000, dry_run=dry_run)[0], 400)
            self.assertEqual(self.move(group="head", dry_run=dry_run)[0], 400)
            for kind in ("torque", "head", "head_move"):
                for enabled in (True, False):
                    self.assertEqual(self.post("command", kind=kind, enabled=enabled, dry_run=dry_run)[0], 400)
        for route in ("head/move", "head/torque", "head/config"):
            self.assertEqual(self.post(route, enabled=True, position=2000)[0], 404)
        self.assert_no_io()

    def test_head_preview_uses_saved_limits_without_connecting_or_enabling_torque(self):
        self.assertEqual(self.head_move()[0], 400, "head movement needs saved ranges")
        self.head.calibrated()
        self.head.state.update(state="disconnected", port_open=False)
        self.head.state["calibration"]["saved_matches_connection"] = False
        code, result = self.head_move(position=1800, duration_ms=1000)
        self.assertEqual(code, 200)
        self.assertTrue(result["dry_run"])
        self.assertEqual(result["group"], "head")
        self.assertEqual(result["transport"], "serial")
        self.assertEqual(result["commands"], [
            {"address": "Dynamixel", "args": [8, "requested_profile_ms", 1000, "goal", 1800]}])
        self.assertEqual(self.head_move(position=2200, duration_ms=10000)[0], 200)
        for enabled in (True, False):
            code, result = self.post("command", kind="head_torque", enabled=enabled)
            self.assertEqual(code, 200)
            self.assertTrue(result["dry_run"])
            self.assertEqual(result["group"], "head")
        self.assert_no_io()

    def test_removed_automatic_head_commands_are_rejected_without_io(self):
        self.head.calibrated()
        for kind in ("head_startup", "head_startup_cancel"):
            for dry_run in (True, False):
                with self.subTest(kind=kind, dry_run=dry_run):
                    code, result = self.post("command", kind=kind, startup_id="old-client",
                                             dry_run=dry_run)
                    self.assertEqual(code, 400)
                    self.assertFalse(result["ok"])
        self.assert_no_io()

    def test_head_batch_preview_uses_saved_ranges_and_requested_independent_profiles(self):
        self.assertEqual(self.head_moves()[0], 400)
        self.assertEqual(self.head_moves(dry_run=False)[0], 400)
        self.head.calibrated()
        self.head.state.update(state="disconnected", port_open=False)
        self.head.state["calibration"]["saved_matches_connection"] = False
        targets = [{"motor_id": 8, "position": 1800, "duration_ms": 1000},
                   {"motor_id": 9, "position": 2100, "duration_ms": 10000}]
        for count in (1, 2):
            with self.subTest(count=count):
                code, result = self.head_moves(targets=targets[:count])
                self.assertEqual(code, 200)
                self.assertTrue(result["dry_run"])
                self.assertEqual((result["group"], result["transport"]), ("head", "serial"))
                self.assertEqual(result["commands"], [
                    {"address": "Dynamixel", "args": [target["motor_id"], "requested_profile_ms",
                                                       target["duration_ms"], "goal", target["position"]]}
                    for target in targets[:count]])
        self.assert_no_io()

    def test_head_batch_validates_every_target_before_any_controller_call(self):
        self.head.calibrated()
        valid = {"motor_id": 8, "position": 2000, "duration_ms": 2000}
        second = {"motor_id": 9, "position": 2000, "duration_ms": 2000}
        invalid = [None, {}, "targets", [], [valid] * 3, [valid, valid], [None],
                   [dict(valid, extra=True)], [{key: value for key, value in valid.items() if key != "position"}],
                   [valid, None], [valid, dict(second, extra=True)]]
        invalid += [[valid, {**second, **override}] for override in (
            {"motor_id": 0}, {"motor_id": 4}, {"motor_id": 252}, {"motor_id": 253},
            {"motor_id": -1}, {"motor_id": True}, {"motor_id": "9"}, {"motor_id": 9.5},
            {"position": 1899}, {"position": 2101}, {"position": True},
            {"position": None}, {"position": "2000"}, {"position": 2000.5},
            {"duration_ms": 999}, {"duration_ms": 10001}, {"duration_ms": True},
            {"duration_ms": None}, {"duration_ms": "2000"}, {"duration_ms": 2000.5},
        )]
        for dry_run in (True, False):
            for targets in invalid:
                with self.subTest(dry_run=dry_run, targets=targets):
                    code, result = self.head_moves(targets=targets, dry_run=dry_run)
                    self.assertEqual(code, 400)
                    self.assertFalse(result["ok"])
                    self.assert_no_io()
            for group in ("ribs", "drums"):
                self.assertEqual(self.head_moves(group=group, dry_run=dry_run)[0], 400)
        self.assert_no_io()

    def test_head_batch_live_dispatches_once_and_reports_each_actual_profile(self):
        self.head.calibrated()
        self.head.batch_durations = {8: 3400, 9: 4800}
        targets = [{"motor_id": 9, "position": 2100, "duration_ms": 3000},
                   {"motor_id": 8, "position": 1900, "duration_ms": 2000}]
        with patch("socket.socket") as socket_factory:
            code, result = self.head_moves(targets=targets, dry_run=False)
            socket_factory.assert_not_called()
        self.assertEqual(code, 200)
        self.assertFalse(result["dry_run"])
        self.assertEqual((result["group"], result["transport"]), ("head", "serial"))
        self.assertEqual(self.head.calls, [("moves", targets)])
        self.assertEqual(result["commands"], [
            {"address": "Dynamixel", "args": [9, "profile_ms", 4800, "goal", 2100]},
            {"address": "Dynamixel", "args": [8, "profile_ms", 3400, "goal", 1900]},
        ])
        self.assertEqual(result["head"]["last_move"]["duration_ms"], 4800)
        self.assertEqual(self.ribs.calls + self.drums.calls, [])
        self.assertEqual(targets[0]["duration_ms"], 3000, "Reporting actual profiles must not mutate the request")
        self.assertEqual(self.status()["history"][0]["kind"], "head_moves")

    def test_head_batch_with_one_target_uses_batch_driver_and_dynamic_overlapping_ids(self):
        for ids in ((0, 1), (20, 25)):
            self.head.calibrated(ids)
            for count in (1, 2):
                with self.subTest(ids=ids, count=count):
                    targets = [{"motor_id": motor_id, "position": 2000, "duration_ms": 2000 + index * 1000}
                               for index, motor_id in enumerate(ids[:count])]
                    code, result = self.head_moves(targets=targets, dry_run=False)
                    self.assertEqual(code, 200)
                    self.assertEqual(result["group"], "head")
                    self.assertEqual(self.head.calls[-1], ("moves", targets))
                    self.assertEqual([command["args"][0] for command in result["commands"]], list(ids[:count]))
                    self.assertEqual(self.ribs.calls + self.drums.calls, [])

    def test_head_batch_failure_preserves_partial_movement_metadata_without_retry(self):
        self.head.calibrated()
        partial = {"targets": [
            {"motor_id": 8, "position": 1900, "duration_ms": 3400, "requested_duration_ms": 2000},
            {"motor_id": 9, "position": 2100, "duration_ms": 4800, "requested_duration_ms": 3000},
        ], "duration_ms": 4800, "started_at": "2026-10-19T01:00:00+00:00", "partial": True}
        self.head.state.update(busy=True, last_move=copy.deepcopy(partial))
        self.head.failure = "Head 9 goal acknowledgement failed; position is uncertain."
        code, result = self.head_moves(dry_run=False)
        self.assertEqual(code, 502)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], self.head.failure)
        self.assertTrue(result["head"]["busy"])
        self.assertEqual(result["head"]["last_move"], partial)
        self.assertEqual(len(self.head.calls), 1)
        self.assertEqual(self.head.calls[0][0], "moves")
        self.assertEqual(self.ribs.calls + self.drums.calls, [])
        result["head"]["last_move"]["targets"][0]["duration_ms"] = 1
        self.assertEqual(self.head.state["last_move"], partial)
        self.assertEqual(self.status()["history"][0]["head"]["last_move"], partial)

    def test_head_move_rejects_unknown_ids_out_of_range_positions_and_fast_requests(self):
        self.head.calibrated()
        invalid = ({"motor_id": 0}, {"motor_id": 4}, {"motor_id": 252}, {"motor_id": True},
                   {"motor_id": "8"}, {"motor_id": 8.5}, {"position": 1799}, {"position": 2201},
                   {"position": True}, {"position": "2000"}, {"position": 2000.5},
                   {"duration_ms": 999}, {"duration_ms": 10001}, {"duration_ms": True},
                   {"duration_ms": "2000"}, {"duration_ms": 2000.5},
                   {"motor_id": 9, "position": 1800}, {"motor_id": 9, "position": 2200},
                   {"group": "drums"}, {"group": "ribs"})
        for dry_run in (True, False):
            for overrides in invalid:
                with self.subTest(dry_run=dry_run, overrides=overrides):
                    self.assertEqual(self.head_move(**overrides, dry_run=dry_run)[0], 400)
            for enabled in (0, 1, None, "true"):
                self.assertEqual(self.post("command", kind="head_torque", enabled=enabled,
                                           dry_run=dry_run)[0], 400)
        self.assert_no_io()

    def test_explicit_head_commands_do_not_confuse_overlapping_drum_or_rib_ids(self):
        for ids in ((0, 1), (20, 25)):
            self.head.calibrated(ids)
            motor_id = ids[0]
            code, result = self.head_move(motor_id=motor_id, position=2000, dry_run=False)
            self.assertEqual(code, 200)
            self.assertEqual(result["group"], "head")
            self.assertEqual(self.head.calls[-1], ("move", motor_id, 2000, 2000))
            self.assertEqual(self.ribs.calls, [])
            self.assertEqual(self.drums.calls, [])
        for enabled in (True, False):
            self.assertEqual(self.post("command", kind="head_torque", enabled=enabled,
                                       dry_run=False)[0], 200)
            self.assertEqual(self.head.calls[-1], ("torque", enabled))
        self.move(motor_id=0, position=2200, dry_run=False)
        self.move(motor_id=20, position=2450, dry_run=False)
        self.assertEqual(self.drums.calls, [("move", [(0, 2200, 500)])])
        self.assertEqual(self.ribs.calls, [("move", [(20, 2450, 500)])])

    def test_head_cached_status_and_driver_failure_are_reported_without_other_io(self):
        self.head.calibrated()
        self.head.state.update(busy=True, last_move={"motor_id": 8, "position": 2100,
                                                   "duration_ms": 3000})
        code, result = self.service.dispatch("GET", "/api/robot/head/status")
        self.assertEqual(code, 200)
        self.assertTrue(result["head"]["busy"])
        result["head"]["last_move"]["position"] = -999
        self.assertEqual(self.head.state["last_move"]["position"], 2100)
        self.assertEqual(self.post("head/status")[0], 405)
        self.assert_no_io()
        self.head.failure = "Saved ranges no longer match this head. No registers were written."
        code, result = self.head_move(dry_run=False)
        self.assertEqual(code, 502)
        self.assertEqual(result["error"], self.head.failure)
        self.assertTrue(result["armed"])
        self.assertFalse(result["emergency_stopped"])
        self.assertEqual(self.ribs.calls, [])
        self.assertEqual(self.drums.calls, [])

    def test_head_live_commands_respect_port_ownership_before_controller_io(self):
        self.head.calibrated()
        self.head.state["device"] = "/dev/tty.usbserial-SHARED"
        self.ribs.state.update(device="/dev/cu.usbserial-SHARED", port_open=True)
        for request in (lambda: self.head_move(dry_run=False),
                        lambda: self.head_moves(dry_run=False),
                        lambda: self.post("command", kind="head_torque", enabled=True, dry_run=False),
                        lambda: self.post("command", kind="head_torque", enabled=False, dry_run=False)):
            code, result = request()
            self.assertEqual(code, 400)
            self.assertIn("already connected to ribs", result["error"])
        self.assert_no_io()

    def test_stopped_head_blocks_motion_and_enable_but_allows_release_and_preview(self):
        self.head.calibrated()
        self.assertEqual(self.post("emergency-stop")[0], 200)
        for controller in self.controllers.values():
            controller.calls.clear()
        self.assertEqual(self.head_move(dry_run=False)[0], 409)
        self.assertEqual(self.head_moves(dry_run=False)[0], 409)
        self.assertEqual(self.post("command", kind="head_torque", enabled=True, dry_run=False)[0], 409)
        self.assertEqual(self.head_move()[0], 200)
        self.assertEqual(self.head_moves()[0], 200)
        self.assert_no_io()
        self.head.state["calibration"]["saved"] = None
        code, result = self.post("command", kind="head_torque", enabled=False, dry_run=False)
        self.assertEqual(code, 200, "release remains available without calibration")
        self.assertTrue(result["emergency_stopped"])
        self.assertEqual(self.head.calls, [("torque", False)])

    def test_occupied_ports_and_tty_aliases_rejected_before_check(self):
        for owner in self.controllers:
            for target in self.controllers:
                if owner == target:
                    continue
                for device in ("/dev/cu.usbserial-SHARED", "/dev/tty.usbserial-SHARED"):
                    with self.subTest(owner=owner, target=target, device=device):
                        self.controllers[owner].state.update(device="/dev/cu.usbserial-SHARED", port_open=True)
                        code, result = self.post(target + "/check", device=device, baudrate=57_600)
                        self.assertEqual(code, 400)
                        self.assertIn("already connected to " + owner, result["error"])
                        self.assert_no_io()
                        self.controllers[owner].state["port_open"] = False

    def test_port_collision_blocks_live_writes_and_upright_capture(self):
        self.ribs.state.update(device="/dev/cu.usbserial-SHARED", port_open=True)
        self.drums.state["device"] = "/dev/tty.usbserial-SHARED"
        self.head.state["device"] = "/dev/tty.usbserial-SHARED"
        for request in (
            lambda: self.move(dry_run=False),
            lambda: self.post("command", kind="drums_torque", enabled=True, dry_run=False),
            lambda: self.post("command", kind="drums_torque", enabled=False, dry_run=False),
            lambda: self.post("head/upright"),
            lambda: self.post("head/check"),
        ):
            code, result = request()
            self.assertEqual(code, 400)
            self.assertIn("already connected to ribs", result["error"])
        self.assert_no_io()

    def test_disconnecting_owner_frees_adapter_for_another_group(self):
        self.post("ribs/check", device="/dev/cu.usbserial-SHARED")
        self.assertEqual(self.post("drums/check", device="/dev/tty.usbserial-SHARED")[0], 400)
        self.post("ribs/disconnect")
        code, result = self.post("drums/check", device="/dev/tty.usbserial-SHARED")
        self.assertEqual(code, 200)
        self.assertTrue(result["drums"]["port_open"])
        self.assertEqual(self.drums.calls, [("check", "/dev/tty.usbserial-SHARED", None)])
        self.assertEqual(self.head.calls, [])

    def test_configuration_preserves_output_without_emitting(self):
        code, _ = self.post("config", host="127.0.0.1", port=5009)
        self.assertEqual(code, 200)
        self.assertTrue(self.status()["armed"])
        self.assert_no_io()

    def test_configuration_requires_private_unicast_literal(self):
        invalid = ("example.com", "localhost", "8.8.8.8", "0.0.0.0", "255.255.255.255",
                   "192.168.1.255", "224.0.0.1", "::", "ff02::1", "2001:4860:4860::8888",
                   "fe80::1%en0", "169.254.1.2", "192.0.2.1", "127.0.0.1 ", None, 1234)
        for host in invalid:
            with self.subTest(host=host):
                self.assertEqual(self.post("config", host=host, port=5009)[0], 400)
        for host in ("127.0.0.1", "10.2.3.4", "172.16.3.4", "192.168.1.3", "::1", "fd12::3"):
            with self.subTest(host=host):
                self.assertEqual(self.post("config", host=host, port=5009)[0], 200)
        before = self.status()["config"]
        for port in (True, 0, 65536, "5009", 5.5, float("inf")):
            self.assertEqual(self.post("config", host="127.0.0.1", port=port)[0], 400)
            self.assertEqual(self.status()["config"], before)
        self.assert_no_io()

    def test_legacy_arm_route_never_changes_emergency_state_or_torque(self):
        for enabled in (None, False, True, 0, 1, "true", "false", [], {}):
            self.assertEqual(self.post("arm", enabled=enabled)[0], 410)
            self.assertTrue(self.status()["armed"])
        self.assert_no_io()
        self.post("emergency-stop")
        for controller in self.controllers.values():
            controller.calls.clear()
        for enabled in (False, True):
            self.assertEqual(self.post("arm", enabled=enabled)[0], 410)
            self.assertFalse(self.status()["armed"])
        self.assert_no_io()

    def test_failed_drum_command_keeps_output_enabled_and_records_failure(self):
        self.drums.failure = "Motor 3 write was not acknowledged."
        code, body = self.move(dry_run=False)
        self.assertEqual(code, 502)
        self.assertFalse(body["ok"])
        self.assertEqual(body["drums"]["state"], "partial")
        state = self.status()
        self.assertTrue(state["armed"])
        self.assertEqual(state["last_error"], self.drums.failure)
        self.assertFalse(state["history"][0]["ok"])
        self.drums.failure = None
        self.assertEqual(self.move(dry_run=False)[0], 200)
        self.assertEqual(self.drums.calls, [("move", [(0, 2200, 500)])] * 2)
        self.assertEqual(self.head.calls, [])

    def test_history_and_connection_snapshots_are_detached(self):
        for _ in range(35):
            self.move()
        state = self.status()
        self.assertEqual(len(state["history"]), 30)
        state["motors"][0]["min"] = 0
        state["config"]["host"] = "8.8.8.8"
        state["history"][0]["commands"][0]["args"].append("bad")
        state["head"]["motors"][0]["position"] = -1234
        current = self.status()
        self.assertEqual(current["motors"][0]["min"], 2100)
        self.assertEqual(current["config"]["host"], "127.0.0.1")
        self.assertEqual(len(current["history"][0]["commands"][0]["args"]), 5)
        self.assertIsNone(current["head"]["motors"][0]["position"])
        self.assert_no_io()

    def test_emergency_stop_latches_and_reset_never_reenables_torque(self):
        for controller in self.controllers.values():
            controller.checked()
            for row in controller.state["motors"]:
                row["torque_enabled"] = True
        self.head.state["calibration"]["recording"] = True
        code, result = self.post("emergency-stop")
        self.assertEqual(code, 200)
        self.assertFalse(result["armed"])
        self.assertTrue(result["emergency_stopped"])
        self.assertEqual(set(result["results"]), {"ribs", "drums", "head"})
        for controller in self.controllers.values():
            self.assertTrue(controller.stop_requested.is_set())
            self.assertEqual(controller.calls, [("request_stop",), ("emergency_stop",)])
            self.assertTrue(all(row["torque_enabled"] is False for row in controller.state["motors"]))
        self.assertFalse(self.head.state["calibration"]["recording"])
        self.assertEqual(self.move(dry_run=False)[0], 409)
        self.assertEqual(self.post("command", kind="drums_strike", motor_id=0, dry_run=False)[0], 409)
        self.assertEqual(self.move(dry_run=True)[0], 200)
        self.assertEqual(self.post("head/calibration/start")[0], 409)
        for controller in self.controllers.values():
            controller.calls.clear()
        code, result = self.post("emergency-reset")
        self.assertEqual(code, 200)
        self.assertTrue(result["armed"])
        self.assertFalse(result["emergency_stopped"])
        for controller in self.controllers.values():
            self.assertEqual(controller.calls, [("reset_stop",)])
            self.assertFalse(controller.stop_requested.is_set())
            self.assertTrue(all(row["torque_enabled"] is False for row in controller.state["motors"]))

    def test_emergency_failure_attempts_other_groups_and_stays_latched(self):
        self.ribs.emergency_failure = "Rib 22 torque-off acknowledgement failed."
        self.drums.emergency_stop = lambda: (_ for _ in ()).throw(OSError("Drum USB disconnected"))
        code, result = self.post("emergency-stop")
        self.assertEqual(code, 502)
        self.assertTrue(result["emergency_stopped"])
        self.assertIn("22", result["error"])
        self.assertIn("USB disconnected", result["error"])
        self.assertFalse(result["results"]["ribs"]["ok"])
        self.assertFalse(result["results"]["drums"]["ok"])
        self.assertTrue(result["results"]["head"]["ok"])
        self.assertEqual(self.head.calls, [("request_stop",), ("emergency_stop",)])
        self.assertEqual(self.move(dry_run=False)[0], 409)

    def test_checks_config_release_and_failures_do_not_change_the_latch(self):
        for stopped in (False, True):
            if stopped:
                self.post("emergency-stop")
            for group in self.controllers:
                self.post(group + "/check")
                self.post(group + "/disconnect")
            self.post("config", host="127.0.0.1", port=5009)
            for group in ("ribs", "drums", "head"):
                self.post("command", kind=group + "_torque", enabled=False, dry_run=False)
            self.drums.failure = "Motor torque is off."
            self.move(dry_run=False)
            self.assertEqual(self.status()["emergency_stopped"], stopped)
            self.assertEqual(self.status()["armed"], not stopped)
            self.drums.failure = None

    def test_stop_signals_inflight_command_before_waiting_for_service_lock(self):
        entered, finish = threading.Event(), threading.Event()
        outputs = {}

        def blocked_move(targets):
            entered.set()
            if not finish.wait(3):
                raise AssertionError("Test command was never released")
            return {"ok": False, "error": "Cancelled by stop", "drums": self.drums.snapshot()}

        self.drums.move = blocked_move
        command = threading.Thread(target=lambda: outputs.update(command=self.move(dry_run=False)), daemon=True)
        stop = threading.Thread(target=lambda: outputs.update(stop=self.post("emergency-stop")), daemon=True)
        command.start()
        self.assertTrue(entered.wait(2))
        try:
            stop.start()
            self.assertTrue(self.drums.stop_requested.wait(2), "stop must signal before acquiring the occupied service lock")
            self.assertTrue(self.ribs.stop_requested.is_set())
            self.assertTrue(self.head.stop_requested.is_set())
            self.assertNotIn("stop", outputs)
        finally:
            finish.set()
            command.join(3)
            stop.join(3)
        self.assertFalse(command.is_alive())
        self.assertFalse(stop.is_alive())
        self.assertEqual(outputs["stop"][0], 200)
        self.assertTrue(self.status()["emergency_stopped"])

    def test_stop_signals_inflight_head_move_and_never_replays_it_after_reset(self):
        self.head.calibrated()
        entered, finish = threading.Event(), threading.Event()
        outputs = {}

        def blocked_move(motor_id, position, duration_ms):
            entered.set()
            if not finish.wait(3):
                raise AssertionError("Test head command was never released")
            return {"ok": False, "error": "Head cancelled by stop", "head": self.head.snapshot()}

        self.head.move = blocked_move
        command = threading.Thread(target=lambda: outputs.update(command=self.head_move(dry_run=False)), daemon=True)
        stop = threading.Thread(target=lambda: outputs.update(stop=self.post("emergency-stop")), daemon=True)
        command.start()
        self.assertTrue(entered.wait(2))
        try:
            stop.start()
            self.assertTrue(self.head.stop_requested.wait(2), "head cancellation must not wait behind its active move")
            self.assertNotIn("stop", outputs)
        finally:
            finish.set()
            command.join(3)
            stop.join(3)
        self.assertFalse(command.is_alive())
        self.assertFalse(stop.is_alive())
        self.assertEqual(outputs["command"][0], 502)
        self.assertEqual(outputs["stop"][0], 200)
        self.assertTrue(self.status()["emergency_stopped"])
        self.head.calls.clear()
        self.assertEqual(self.post("emergency-reset")[0], 200)
        self.assertEqual(self.head.calls, [("reset_stop",)])

    def test_reset_cannot_overtake_a_stop_waiting_for_service_lock(self):
        output = {}
        stop = threading.Thread(target=lambda: output.update(stop=self.post("emergency-stop")), daemon=True)
        with self.service._lock:
            stop.start()
            self.assertTrue(self.drums.stop_requested.wait(2))
            code, result = self.post("emergency-reset")
            self.assertEqual(code, 409)
            self.assertTrue(result["emergency_stopped"])
            self.assertNotIn(("reset_stop",), self.drums.calls)
        stop.join(3)
        self.assertFalse(stop.is_alive())
        self.assertEqual(output["stop"][0], 200)
        self.assertEqual(self.post("emergency-reset")[0], 200)

    def test_queued_command_cannot_revive_after_stop_and_reset(self):
        attempted = threading.Event()
        underlying = threading.RLock()

        class ObservedLock:
            def __enter__(self):
                if threading.current_thread().name == "queued-command":
                    attempted.set()
                underlying.acquire()

            def __exit__(self, *args):
                underlying.release()

        self.service._lock = ObservedLock()
        output = {}
        queued = threading.Thread(target=lambda: output.update(command=self.move(dry_run=False)),
                                  name="queued-command", daemon=True)
        with self.service._lock:
            queued.start()
            self.assertTrue(attempted.wait(2))
            self.assertEqual(self.post("emergency-stop")[0], 200)
            self.assertEqual(self.post("emergency-reset")[0], 200)
        queued.join(3)
        self.assertFalse(queued.is_alive())
        self.assertEqual(output["command"][0], 409)
        self.assertIn("queued command", output["command"][1]["error"])
        self.assertFalse(any(call[0] == "move" for call in self.drums.calls))
        self.assertEqual(self.move(dry_run=False)[0], 200)

    def test_older_queued_reset_cannot_clear_a_newer_completed_stop(self):
        attempted = threading.Event()
        underlying = threading.RLock()

        class ObservedLock:
            def __enter__(self):
                if threading.current_thread().name == "queued-reset":
                    attempted.set()
                underlying.acquire()

            def __exit__(self, *args):
                underlying.release()

        self.service._lock = ObservedLock()
        output = {}
        queued = threading.Thread(target=lambda: output.update(reset=self.post("emergency-reset")),
                                  name="queued-reset", daemon=True)
        with self.service._lock:
            queued.start()
            self.assertTrue(attempted.wait(2))
            self.assertEqual(self.post("emergency-stop")[0], 200)
        queued.join(3)
        self.assertFalse(queued.is_alive())
        self.assertEqual(output["reset"][0], 409)
        self.assertTrue(self.status()["emergency_stopped"])
        self.assertNotIn(("reset_stop",), self.drums.calls)
        self.assertTrue(self.drums.stop_requested.is_set())

    def test_reset_failure_restores_driver_stop_flags_and_latch(self):
        self.post("emergency-stop")
        self.drums.reset_stop = lambda: (_ for _ in ()).throw(OSError("reset failed"))
        code, result = self.post("emergency-reset")
        self.assertEqual(code, 502)
        self.assertTrue(result["emergency_stopped"])
        self.assertTrue(self.ribs.stop_requested.is_set())
        self.assertTrue(self.drums.stop_requested.is_set())

    def test_swapped_instruments_keep_their_motor_calibrations(self):
        drums = {motor["id"]: motor for motor in MOTORS if motor["group"] == "drums"}
        for motor_id, name, minimum, maximum, rest, hit in (
            (0, "Kick", 2100, 2450, 2200, 2370),
            (1, "Ride", 1850, 2125, 1850, 2000),
            (2, "Snare", 2070, 2350, 2300, 2150),
            (3, "Hi-hat", 2410, 2600, 2600, 2430),
        ):
            motor = drums[motor_id]
            self.assertEqual(tuple(motor[key] for key in ("name", "min", "max", "rest", "strike")),
                             (name, minimum, maximum, rest, hit))
            self.assertEqual(motor["default"], rest)

    def test_strike_uses_fixed_catalog_rest_hit_rest_cycle(self):
        for motor_id, rest, target, duration in ((0, 2200, 2370, 150), (1, 1850, 2000, 150),
                                                (2, 2300, 2150, 150), (3, 2600, 2430, 200)):
            with self.subTest(motor_id=motor_id):
                code, result = self.post("command", kind="drums_strike", motor_id=motor_id,
                                         strike_position=999999, rest_position=-999,
                                         prepare_duration_ms=1, return_duration_ms=1, dry_run=False)
                self.assertEqual(code, 200)
                self.assertEqual(self.drums.calls[-1], ("strike", motor_id, target, duration, 150, rest, 500))
                self.assertEqual(result["commands"], [
                    {"address": "Dynamixel", "args": [motor_id, "profile_ms", 500, "goal", rest]},
                    {"address": "Dynamixel", "args": [motor_id, "profile_ms", duration, "goal", target]},
                    {"address": "Dynamixel", "args": [motor_id, "profile_ms", 150, "goal", rest]},
                ])
                self.assertTrue(result["drums"]["busy"])
                self.assertEqual(result["group"], "drums")
        self.assertEqual(self.ribs.calls, [])
        self.assertEqual(self.head.calls, [])
        self.assertEqual(self.post("command", kind="drums_strike", motor_id=0, duration_ms=500, dry_run=False)[0], 200)
        self.assertEqual(self.drums.calls[-1], ("strike", 0, 2370, 500, 150, 2200, 500))

    def test_strike_preview_validation_and_cached_status_never_access_hardware(self):
        code, result = self.post("command", kind="drums_strike", motor_id=3)
        self.assertEqual(code, 200)
        self.assertEqual(result["commands"], [
            {"address": "Dynamixel", "args": [3, "profile_ms", 500, "goal", 2600]},
            {"address": "Dynamixel", "args": [3, "profile_ms", 200, "goal", 2430]},
            {"address": "Dynamixel", "args": [3, "profile_ms", 150, "goal", 2600]}])
        for payload in ({"motor_id": 4}, {"motor_id": True}, {"motor_id": "0"}, {"motor_id": -1},
                        {"duration_ms": 99}, {"duration_ms": 5001}, {"duration_ms": True}, {"group": "head"}):
            self.assertEqual(self.post("command", **{"kind": "drums_strike", "motor_id": 0,
                                                      "dry_run": False, **payload})[0], 400)
        self.drums.state.update(busy=True, strike={"state": "returning", "motor_id": 2})
        code, result = self.service.dispatch("GET", "/api/robot/drums/status")
        self.assertEqual(code, 200)
        self.assertEqual(result["drums"]["strike"]["state"], "returning")
        result["drums"]["strike"]["state"] = "tampered"
        self.assertEqual(self.drums.state["strike"]["state"], "returning")
        self.assertEqual(self.post("drums/status")[0], 405)
        self.assert_no_io()

    def test_close_disarms_and_only_closes_controllers(self):
        self.service.close()
        self.assertFalse(self.status()["armed"])
        for group, controller in self.controllers.items():
            self.assertEqual(controller.calls, [("request_stop",), ("close",)])
        for route in ("command", "ribs/check", "drums/check", "head/check", "head/upright",
                      "head/calibration/start", "head/calibration/stop",
                      "head/calibration/centre", "head/calibration/save", "emergency-stop", "emergency-reset"):
            self.assertEqual(self.post(route)[0], 503)

    def test_unknown_routes_methods_and_bad_body(self):
        self.assertEqual(self.service.dispatch("GET", "/api/robot/missing")[0], 404)
        for route in ("arm", "ribs/check", "drums/check", "head/check", "head/upright",
                      "head/calibration/start", "head/calibration/stop",
                      "head/calibration/centre", "head/calibration/save", "emergency-stop", "emergency-reset"):
            self.assertEqual(self.service.dispatch("GET", "/api/robot/" + route)[0], 405)
            self.assertEqual(self.service.dispatch("POST", "/api/robot/" + route, [])[0], 400)
        self.assert_no_io()


class DrumBusConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.ribs, self.drums, self.head = FakeRibs(), FakeDrums(), FakeHead()
        self.drums._lock = threading.RLock()
        self.time = 10000
        self.drums.performance_prepare = lambda instruments, cancelled: None
        self.drums.performance_verify = lambda motor, rest, cancelled: None
        self.performance = DrumPerformance(self.drums, now=lambda: self.time, threaded=False)
        self.drums.performance = self.performance
        original_stop = self.drums.request_stop

        def request_stop():
            original_stop()
            self.performance.invalidate()

        self.drums.request_stop = request_stop
        self.service = RobotControlService(self.ribs, self.drums, self.head)
        self.addCleanup(self.service.close)
        self.performance.start("run", [0])
        self.time += 500
        self.performance.pump()

    def call(self, action, payload=None):
        return self.service.dispatch("GET" if action == "status" else "POST",
                                     "/api/robot/drums/performance/" + action, payload)

    def test_heartbeat_status_and_stop_do_not_wait_for_blocked_rib_io(self):
        entered, finish, completed = threading.Event(), threading.Event(), threading.Event()
        results = {}

        def blocked_ribs(targets):
            entered.set()
            if not finish.wait(3):
                raise AssertionError("Fake rib movement was not released")
            return self.ribs.result()

        def drum_requests():
            results["schedule"] = self.call("schedule", {"token": "run", "events": []})
            results["status"] = self.call("status")
            results["stop"] = self.call("stop", {"token": "run"})
            completed.set()

        self.ribs.move = blocked_ribs
        ribs = threading.Thread(target=lambda: results.update(ribs=self.service.dispatch(
            "POST", "/api/robot/command", {"kind": "ribs", "position": 64,
                                           "duration_ms": 500, "dry_run": False})), daemon=True)
        drums = threading.Thread(target=drum_requests, daemon=True)
        ribs.start()
        try:
            self.assertTrue(entered.wait(2))
            self.time += 400
            drums.start()
            self.assertTrue(completed.wait(1), "independent drum traffic must finish while rib I/O is still blocked")
            self.assertNotIn("ribs", results)
            self.assertEqual(self.performance.heartbeat, self.time)
            self.assertEqual([results[action][0] for action in ("schedule", "status", "stop")], [200, 200, 200])
            self.assertEqual(results["status"][1]["performance"]["state"], "ready")
            self.assertEqual(results["stop"][1]["performance"]["state"], "stopped")
        finally:
            finish.set()
            ribs.join(3)
            if drums.ident is not None:
                drums.join(3)
        self.assertFalse(ribs.is_alive())
        self.assertFalse(drums.is_alive())

    def test_waiting_drum_request_rechecks_generation_and_shutdown(self):
        for change in ("stop-reset", "close"):
            with self.subTest(change=change):
                attempted = threading.Event()
                underlying = self.drums._lock

                class ObservedLock:
                    def __enter__(self):
                        if threading.current_thread().name == "queued-drum-heartbeat":
                            attempted.set()
                        underlying.acquire()

                    def __exit__(self, *args):
                        underlying.release()

                self.performance.lock = ObservedLock()
                result = {}
                heartbeat = self.performance.heartbeat
                queued = threading.Thread(target=lambda: result.update(response=self.call(
                    "schedule", {"token": "run", "events": []})),
                    name="queued-drum-heartbeat", daemon=True)
                with underlying:
                    queued.start()
                    self.assertTrue(attempted.wait(2))
                    if change == "stop-reset":
                        self.assertEqual(self.service.dispatch("POST", "/api/robot/emergency-stop", {})[0], 200)
                        self.assertEqual(self.service.dispatch("POST", "/api/robot/emergency-reset", {})[0], 200)
                    else:
                        self.service.close()
                queued.join(3)
                self.assertFalse(queued.is_alive())
                self.assertEqual(result["response"][0], 409 if change == "stop-reset" else 503)
                self.assertIn("emergency stop or reset" if change == "stop-reset" else "unavailable",
                              result["response"][1]["error"])
                self.assertEqual(self.performance.heartbeat, heartbeat)
                self.performance.lock = underlying

    def test_new_session_retains_cross_port_collision_guard(self):
        self.performance.stop("run")
        shared = "/dev/cu.usbserial-FAKE-shared"
        self.ribs.checked(shared)
        self.drums.state["device"] = shared
        code, result = self.call("start", {"token": "new", "instruments": [0]})
        self.assertEqual(code, 400)
        self.assertIn("already connected to ribs", result["error"])
        self.assertEqual(self.performance.snapshot()["state"], "stopped")

    def test_failed_arm_keeps_session_active_and_retains_its_reason_after_stop(self):
        failure = "Drum 0 stopped responding during its return."

        def failed_read(motor, rest, cancelled):
            raise RuntimeError(failure)

        self.drums.performance_verify = failed_read
        self.performance.arms[0].update(state="returning", due_ms=self.time)
        self.performance.pump()
        code, result = self.call("schedule", {"token": "run", "events": []})
        self.assertEqual(code, 200)
        self.assertIsNone(result["performance"]["error"])
        self.assertEqual(result["performance"]["state"], "ready")
        self.assertEqual(result["performance"]["arms"][0]["error"], failure)
        code, result = self.call("stop", {"token": "run"})
        self.assertEqual(code, 200)
        self.assertEqual(result["performance"]["state"], "stopped")
        self.assertEqual(result["performance"]["arms"][0]["error"], failure)
        code, result = self.call("schedule", {"token": "run", "events": []})
        self.assertEqual(code, 409)
        self.assertIn("no longer active", result["error"])
        code, result = self.call("schedule", {"token": "obsolete", "events": []})
        self.assertEqual(code, 409)
        self.assertIn("no longer active", result["error"])

    def test_shared_connection_failure_retains_global_reason(self):
        from robot_drum_performance import DrumPerformanceSessionError
        def disconnected(*args):
            raise DrumPerformanceSessionError("Verified drum connection changed")
        self.drums.performance_verify = disconnected
        self.performance.arms[0].update(state="returning", due_ms=self.time)
        self.performance.pump()
        self.call("stop", {"token": "run"})
        code, result = self.call("schedule", {"token": "run", "events": []})
        self.assertEqual(code, 409)
        self.assertEqual(result["error"], "Verified drum connection changed")
        self.assertEqual(result["performance"]["state"], "error")


if __name__ == "__main__":
    unittest.main()
