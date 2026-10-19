#!/usr/bin/env python3
"""Exercise robot HTTP boundaries without touching any hardware."""
import http.client
import json
import threading
import unittest
from unittest.mock import patch

from hydra_dashboard import DashboardHTTPServer, SnapshotStore, handler_for
from robot_control import RobotControlService
from test_robot_control import FakeRibs, FakeDrums, FakeHead


class RobotHTTPTests(unittest.TestCase):
    def setUp(self):
        self.ribs, self.drums, self.head = FakeRibs(), FakeDrums(), FakeHead()
        for name in ("RibController", "DrumController", "HeadController"):
            guard = patch("robot_control." + name, side_effect=AssertionError("Real controller created"))
            guard.start()
            self.addCleanup(guard.stop)
        self.robot = RobotControlService(ribs=self.ribs, drums=self.drums, head=self.head)
        self.server = DashboardHTTPServer(
            ("127.0.0.1", 0), handler_for(SnapshotStore("demo"), robot=self.robot)
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.robot.close()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result

    def test_catalog_dry_run_and_assets(self):
        code, raw = self.request("GET", "/api/robot/status")
        self.assertEqual(code, 200)
        status = json.loads(raw)
        self.assertTrue(status["armed"])
        self.assertFalse(status["emergency_stopped"])
        self.assertEqual(len(status["motors"]), 13)
        payload = {"kind": "move", "motor_id": 3, "position": 2430,
                   "duration_ms": 200, "dry_run": True}
        headers = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}"}
        code, raw = self.request("POST", "/api/robot/command", json.dumps(payload), headers)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)["commands"], [
            {"address": "Dynamixel", "args": [3, "profile_ms", 200, "goal", 2430]}])
        for group in ("ribs", "drums", "head"):
            self.assertFalse(status[group]["port_open"])
            self.assertEqual(getattr(self, group).calls, [])
        for path in ("/robot-control.js", "/robot-control.css", "/robot-live.js", "/robot-live.css"):
            code, body = self.request("GET", path)
            self.assertEqual(code, 200)
            self.assertTrue(body)
        for path in ("/robot_control.py", "/api/robot/missing"):
            self.assertEqual(self.request("GET", path)[0], 404)

    def test_head_diagnostics_get_never_opens_or_powers_a_bus(self):
        route = "/api/robot/head/diagnostics"
        code, raw = self.request("GET", route)
        self.assertEqual(code, 409)
        self.assertFalse(json.loads(raw)["ok"])
        self.assertEqual(self.head.calls, [("motion_sample",)])
        self.assertFalse(self.head.state["port_open"])
        self.head.checked()
        self.head.calls.clear()
        code, raw = self.request("GET", route)
        self.assertEqual(code, 200)
        self.assertIn("position_trajectory", json.loads(raw)["sample"]["motors"][0])
        self.assertEqual(self.head.calls, [("motion_sample",)])
        code, _ = self.request("POST", route, "{}", {"Content-Type": "application/json"})
        self.assertEqual(code, 405)
        self.assertEqual(self.head.calls, [("motion_sample",)])

    def test_origin_and_json_validation_cannot_trigger_or_reset_emergency_stop(self):
        for headers, code in (
            ({"Origin": "https://example.com", "Content-Type": "application/json"}, 403),
            ({"Host": f"attacker.example:{self.port}", "Content-Type": "application/json"}, 403),
            ({"Host": "127.0.0.1:1", "Content-Type": "application/json"}, 403),
            ({"Sec-Fetch-Site": "cross-site", "Content-Type": "application/json"}, 403),
            ({"Content-Type": "text/plain"}, 415),
            ({"Transfer-Encoding": "chunked", "Content-Type": "application/json"}, 415),
        ):
            for route in ("emergency-stop", "emergency-reset"):
                self.assertEqual(self.request("POST", "/api/robot/" + route, "{}", headers)[0], code)
        for body in ("[]", "null", "broken"):
            for route in ("emergency-stop", "emergency-reset"):
                self.assertEqual(self.request("POST", "/api/robot/" + route, body,
                                              {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/api/robot/emergency-stop", "", {
            "Content-Type": "application/json", "Content-Length": str(16 * 1024 + 1)})[0], 413)
        self.assertTrue(json.loads(self.request("GET", "/api/robot/status")[1])["armed"])
        for controller in (self.ribs, self.drums, self.head):
            self.assertEqual(controller.calls, [])

    def test_invalid_positions_fail_through_http(self):
        headers = {"Content-Type": "application/json"}
        for position in (2660, 4000, -1, True, "2430"):
            payload = {"kind": "move", "motor_id": 3, "position": position,
                       "duration_ms": 200, "dry_run": True}
            self.assertEqual(self.request("POST", "/api/robot/command", json.dumps(payload), headers)[0], 400)

    def test_drum_performance_routes_validate_origin_packets_and_session_ownership(self):
        from test_robot_drum_performance import Hardware
        self.drums = Hardware()
        self.robot._drums = self.drums
        self.robot._controllers["drums"] = self.drums
        headers = {"Content-Type": "application/json"}
        base = "/api/robot/drums/performance/"
        for action in ("start", "schedule", "stop"):
            self.assertEqual(self.request("GET", base + action)[0], 405)
            self.assertEqual(self.request("POST", base + action, "{}", {
                **headers, "Origin": "https://example.com"})[0], 403)
            self.assertEqual(self.request("POST", base + action, "[]", headers)[0], 400)
        self.assertFalse(self.drums.moves)
        code, raw = self.request("POST", base + "start", json.dumps({"token": "http-run", "instruments": [0, 2]}), headers)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)["performance"]["state"], "preparing")
        self.drums.advance(500)
        code, raw = self.request("GET", base + "status")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)["performance"]["state"], "ready")
        self.assertIn("server_time_ms", json.loads(raw))
        self.assertEqual(self.request("POST", base + "schedule", json.dumps({
            "token": "wrong", "events": []}), headers)[0], 409)
        self.assertEqual(self.request("POST", base + "stop", '{"token":"http-run"}', headers)[0], 200)
        self.assertEqual(self.request("POST", base + "start", json.dumps({
            "token": "http-run", "instruments": [0]}), headers)[0], 409)

    def test_rib_connection_checks_and_failures_are_visible(self):
        headers = {"Content-Type": "application/json"}
        code, raw = self.request("POST", "/api/robot/ribs/check", '{"device":"/dev/cu.usbserial-FAKE"}', headers)
        self.assertEqual(code, 200)
        body = json.loads(raw)
        self.assertEqual(body["ribs"]["state"], "ready")
        self.assertTrue(body["armed"])
        self.assertEqual(self.ribs.calls, [("check", "/dev/cu.usbserial-FAKE")])
        self.ribs.failure = "Motor 25 did not reply."
        payload = {"kind": "ribs", "position": 64, "duration_ms": 2500, "dry_run": False}
        code, raw = self.request("POST", "/api/robot/command", json.dumps(payload), headers)
        self.assertEqual(code, 502)
        body = json.loads(raw)
        self.assertIn("25", body["error"])
        self.assertTrue(body["armed"])
        self.assertEqual(body["ribs"]["state"], "partial")
        code, raw = self.request("POST", "/api/robot/ribs/disconnect", "{}", headers)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)["ribs"]["state"], "disconnected")

    def test_foreign_origin_cannot_probe_or_open_a_serial_port(self):
        headers = {"Content-Type": "application/json", "Origin": "https://example.com"}
        for route in ("ribs/check", "drums/check", "head/check", "head/upright",
                      "ribs/disconnect", "drums/disconnect", "head/disconnect",
                      "head/calibration/start", "head/calibration/stop",
                      "head/calibration/centre", "head/calibration/save"):
            self.assertEqual(self.request("POST", "/api/robot/" + route, "{}", headers)[0], 403)
        for controller in (self.ribs, self.drums, self.head):
            self.assertEqual(controller.calls, [])

    def test_calibration_get_and_actions_keep_other_groups_running(self):
        headers = {"Content-Type": "application/json"}
        self.head.state["calibration"]["samples"] = 14
        code, raw = self.request("GET", "/api/robot/head/calibration")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)["head"]["calibration"]["samples"], 14)
        self.assertTrue(json.loads(raw)["armed"])
        self.assertEqual(self.head.calls, [])
        for action in ("start", "centre", "stop", "save"):
            code, raw = self.request("POST", "/api/robot/head/calibration/" + action,
                                     '{"labels":{"8":"Turn","9":"Tilt"}}' if action == "save" else "{}", headers)
            self.assertEqual(code, 200)
            self.assertTrue(json.loads(raw)["armed"])
        self.assertEqual(self.head.calls, [("calibration_start",), ("calibration_centre",),
                                          ("calibration_stop",), ("calibration_save", {"8": "Turn", "9": "Tilt"})])
        self.assertEqual(self.ribs.calls, [])
        self.assertEqual(self.drums.calls, [])

    def test_calibration_bad_bodies_and_methods_never_start_reads(self):
        for action in ("start", "stop", "centre", "save"):
            path = "/api/robot/head/calibration/" + action
            for body in ("[]", "null", "broken"):
                self.assertEqual(self.request("POST", path, body,
                                              {"Content-Type": "application/json"})[0], 400)
            self.assertEqual(self.request("GET", path)[0], 405)
        self.assertEqual(self.request("POST", "/api/robot/head/calibration", "{}",
                                      {"Content-Type": "application/json"})[0], 405)
        for controller in (self.ribs, self.drums, self.head):
            self.assertEqual(controller.calls, [])

    def test_calibration_driver_failure_is_visible_without_disarming(self):
        headers = {"Content-Type": "application/json"}
        self.head.failure = "Head torque is on; the range cannot be recorded manually."
        code, raw = self.request("POST", "/api/robot/head/calibration/start", "{}", headers)
        self.assertEqual(code, 502)
        body = json.loads(raw)
        self.assertTrue(body["armed"])
        self.assertEqual(body["error"], self.head.failure)
        self.head.validation_error = "Axis labels must refer to discovered motor IDs."
        code, raw = self.request("POST", "/api/robot/head/calibration/save", '{"labels":[]}', headers)
        self.assertEqual(code, 400)
        self.assertTrue(json.loads(raw)["armed"])
        self.assertEqual(json.loads(raw)["error"], self.head.validation_error)
        self.assertEqual(self.head.calls[-1], ("calibration_save", []))

    def test_separate_drum_and_head_connections_and_upright_reference(self):
        headers = {"Content-Type": "application/json"}
        for group, baudrate in (("drums", 1_000_000), ("head", 57_600)):
            device = "/dev/cu.usbserial-" + group
            payload = json.dumps({"device": device, "baudrate": baudrate})
            code, raw = self.request("POST", "/api/robot/" + group + "/check", payload, headers)
            self.assertEqual(code, 200)
            body = json.loads(raw)
            self.assertTrue(body["armed"])
            self.assertEqual(body[group]["device"], device)
            self.assertEqual(getattr(self, group).calls, [("check", device, baudrate)])
        code, raw = self.request("POST", "/api/robot/head/upright", "{}", headers)
        self.assertEqual(code, 200)
        body = json.loads(raw)
        self.assertTrue(body["armed"])
        self.assertEqual(body["head"]["upright_reference"]["positions"],
                         [{"id": 8, "position": 2008}, {"id": 9, "position": 2009}])
        self.assertEqual(self.head.calls[-1], ("capture_upright",))
        for group in ("drums", "head"):
            code, raw = self.request("POST", "/api/robot/" + group + "/disconnect", "{}", headers)
            self.assertEqual(code, 200)
            self.assertFalse(json.loads(raw)[group]["port_open"])
            self.assertTrue(json.loads(raw)["armed"])
        self.assertEqual(self.ribs.calls, [])

    def test_drum_commands_use_serial_and_return_controller_errors(self):
        headers = {"Content-Type": "application/json"}
        payload = {"kind": "move", "motor_id": 3, "position": 2430,
                   "duration_ms": 200, "dry_run": False}
        code, raw = self.request("POST", "/api/robot/command", json.dumps(payload), headers)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)["transport"], "serial")
        self.assertEqual(self.drums.calls, [("move", [(3, 2430, 200)])])
        self.drums.failure = "Drum 3 did not acknowledge the write."
        code, raw = self.request("POST", "/api/robot/command", json.dumps(payload), headers)
        self.assertEqual(code, 502)
        body = json.loads(raw)
        self.assertTrue(body["armed"])
        self.assertEqual(body["drums"]["state"], "partial")
        self.assertIn("Drum 3", body["error"])
        self.assertEqual(self.head.calls, [])
        self.assertEqual(self.ribs.calls, [])

    def test_legacy_head_writes_and_port_alias_conflicts_never_reach_hardware(self):
        headers = {"Content-Type": "application/json"}
        for payload in (
            {"kind": "move", "motor_id": 4, "position": 2000, "duration_ms": 500, "dry_run": False},
            {"kind": "move", "group": "head", "motor_id": 1, "position": 2000,
             "duration_ms": 500, "dry_run": False},
            {"kind": "torque", "enabled": True, "dry_run": False},
        ):
            self.assertEqual(self.request("POST", "/api/robot/command", json.dumps(payload), headers)[0], 400)
        self.ribs.state.update(port_open=True, device="/dev/cu.usbserial-SHARED")
        for group in ("drums", "head"):
            code, raw = self.request("POST", "/api/robot/" + group + "/check",
                                     '{"device":"/dev/tty.usbserial-SHARED"}', headers)
            self.assertEqual(code, 400)
            self.assertIn("already connected to ribs", json.loads(raw)["error"])
        for controller in (self.ribs, self.drums, self.head):
            self.assertEqual(controller.calls, [])

    def test_explicit_head_commands_use_saved_limits_and_the_head_port(self):
        headers = {"Content-Type": "application/json"}
        self.head.calibrated((0, 1))
        payload = {"kind": "head_move", "motor_id": 0, "position": 2000, "duration_ms": 1000}
        code, raw = self.request("POST", "/api/robot/command", json.dumps(payload), headers)
        self.assertEqual(code, 200)
        self.assertTrue(json.loads(raw)["dry_run"])
        self.assertEqual(json.loads(raw)["group"], "head")
        self.assertEqual(self.head.calls, [])
        for overrides in ({"position": 1799}, {"position": 2201}, {"motor_id": 4},
                          {"duration_ms": 999}, {"duration_ms": 10001}, {"motor_id": True}):
            code, _ = self.request("POST", "/api/robot/command",
                                   json.dumps({**payload, **overrides, "dry_run": False}), headers)
            self.assertEqual(code, 400)
        self.assertEqual(self.head.calls, [])
        code, raw = self.request("POST", "/api/robot/command",
                                 json.dumps({**payload, "duration_ms": 10000, "dry_run": False}), headers)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)["transport"], "serial")
        self.assertEqual(self.head.calls, [("move", 0, 2000, 10000)])
        for enabled in (True, False):
            code, raw = self.request("POST", "/api/robot/command",
                                     json.dumps({"kind": "head_torque", "enabled": enabled, "dry_run": False}), headers)
            self.assertEqual(code, 200)
            self.assertEqual(self.head.calls[-1], ("torque", enabled))
        self.assertEqual(self.ribs.calls, [])
        self.assertEqual(self.drums.calls, [])

    def test_head_command_origin_protection_and_cached_status(self):
        headers = {"Content-Type": "application/json"}
        self.head.calibrated()
        for payload in ({"kind": "head_move", "motor_id": 8, "position": 2000,
                         "duration_ms": 2000, "dry_run": False},
                        {"kind": "head_moves", "targets": [
                            {"motor_id": 8, "position": 1900, "duration_ms": 2000},
                            {"motor_id": 9, "position": 2100, "duration_ms": 3000}], "dry_run": False},
                        {"kind": "head_torque", "enabled": True, "dry_run": False},
                        {"kind": "head_torque", "enabled": False, "dry_run": False}):
            code, _ = self.request("POST", "/api/robot/command", json.dumps(payload),
                                   {**headers, "Origin": "https://example.com"})
            self.assertEqual(code, 403)
        self.head.state.update(busy=True, last_move={"motor_id": 8, "position": 2100, "duration_ms": 3000})
        code, raw = self.request("GET", "/api/robot/head/status")
        self.assertEqual(code, 200)
        self.assertTrue(json.loads(raw)["head"]["busy"])
        self.assertEqual(json.loads(raw)["head"]["last_move"]["duration_ms"], 3000)
        self.assertEqual(self.request("POST", "/api/robot/head/status", "{}", headers)[0], 405)
        for controller in (self.ribs, self.drums, self.head):
            self.assertEqual(controller.calls, [])

    def test_head_batch_http_preview_validation_and_live_actual_durations(self):
        headers = {"Content-Type": "application/json"}
        self.head.calibrated((0, 1))
        targets = [{"motor_id": 0, "position": 1900, "duration_ms": 2000},
                   {"motor_id": 1, "position": 2100, "duration_ms": 3000}]
        payload = {"kind": "head_moves", "targets": targets}
        code, raw = self.request("POST", "/api/robot/command", json.dumps(payload), headers)
        self.assertEqual(code, 200)
        body = json.loads(raw)
        self.assertTrue(body["dry_run"])
        self.assertEqual(body["group"], "head")
        self.assertEqual(body["commands"], [
            {"address": "Dynamixel", "args": [0, "requested_profile_ms", 2000, "goal", 1900]},
            {"address": "Dynamixel", "args": [1, "requested_profile_ms", 3000, "goal", 2100]},
        ])
        self.assertEqual(self.head.calls, [])
        for invalid in ({"position": 2101}, {"motor_id": True}, {"duration_ms": "3000"}):
            rejected = {**payload, "targets": [targets[0], {**targets[1], **invalid}], "dry_run": False}
            code, raw = self.request("POST", "/api/robot/command", json.dumps(rejected), headers)
            self.assertEqual(code, 400)
            self.assertFalse(json.loads(raw)["ok"])
            self.assertEqual(self.head.calls, [], "Invalid second targets cannot dispatch the first axis")
        self.head.batch_durations = {0: 3400, 1: 4800}
        code, raw = self.request("POST", "/api/robot/command", json.dumps({**payload, "dry_run": False}), headers)
        self.assertEqual(code, 200)
        body = json.loads(raw)
        self.assertEqual((body["group"], body["transport"]), ("head", "serial"))
        self.assertEqual(body["commands"], [
            {"address": "Dynamixel", "args": [0, "profile_ms", 3400, "goal", 1900]},
            {"address": "Dynamixel", "args": [1, "profile_ms", 4800, "goal", 2100]},
        ])
        self.assertEqual([target["requested_duration_ms"] for target in body["head"]["last_move"]["targets"]],
                         [2000, 3000])
        self.assertEqual(self.head.calls, [("moves", targets)])
        self.assertEqual(self.ribs.calls + self.drums.calls, [])

    def test_head_batch_http_failure_retains_partial_motion_and_cached_status(self):
        headers = {"Content-Type": "application/json"}
        self.head.calibrated((20, 25))
        targets = [{"motor_id": 20, "position": 1900, "duration_ms": 2000},
                   {"motor_id": 25, "position": 2100, "duration_ms": 3000}]
        partial = {"targets": [{**target, "requested_duration_ms": target["duration_ms"]} for target in targets],
                   "duration_ms": 3000, "started_at": "2026-10-19T01:00:00+00:00", "partial": True}
        motion = [{**target, "remaining_ms": target["duration_ms"] - 50} for target in targets]
        self.head.state.update(last_move=partial, motion=motion, busy=True)
        self.head.failure = "Head 25 goal acknowledgement failed; position is uncertain."
        payload = {"kind": "head_moves", "targets": targets, "dry_run": False}
        code, raw = self.request("POST", "/api/robot/command", json.dumps(payload), headers)
        self.assertEqual(code, 502)
        body = json.loads(raw)
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"], self.head.failure)
        self.assertEqual(body["head"]["last_move"], partial)
        self.assertEqual(body["head"]["motion"], motion)
        self.assertTrue(body["head"]["busy"])
        code, raw = self.request("GET", "/api/robot/head/status")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)["head"]["last_move"], partial)
        self.assertEqual(json.loads(raw)["head"]["motion"], motion)
        self.assertEqual(self.head.calls, [("moves", targets)])
        self.assertEqual(self.ribs.calls + self.drums.calls, [])

    def test_removed_automatic_head_commands_cannot_move_hardware(self):
        headers = {"Content-Type": "application/json"}
        self.head.calibrated((0, 1))
        for kind in ("head_startup", "head_startup_cancel"):
            for dry_run in (True, False):
                payload = {"kind": kind, "startup_id": "old-client", "dry_run": dry_run}
                code, raw = self.request("POST", "/api/robot/command", json.dumps(payload), headers)
                self.assertEqual(code, 400)
                self.assertFalse(json.loads(raw)["ok"])
        for controller in (self.head, self.ribs, self.drums):
            self.assertEqual(controller.calls, [])

    def test_emergency_stop_reset_and_legacy_arm_http_contract(self):
        headers = {"Content-Type": "application/json"}
        for enabled in (True, False):
            code, raw = self.request("POST", "/api/robot/arm", json.dumps({"enabled": enabled}), headers)
            self.assertEqual(code, 410)
            self.assertTrue(json.loads(raw)["armed"])
        self.assertEqual(self.drums.calls, [])
        code, raw = self.request("POST", "/api/robot/emergency-stop", "{}", headers)
        self.assertEqual(code, 200)
        self.assertTrue(json.loads(raw)["emergency_stopped"])
        self.assertTrue(self.drums.stop_requested.is_set())
        self.assertEqual(self.head.calls, [("request_stop",), ("emergency_stop",)])
        payload = {"kind": "drums_strike", "motor_id": 0, "dry_run": False}
        self.assertEqual(self.request("POST", "/api/robot/command", json.dumps(payload), headers)[0], 409)
        self.assertEqual(self.request("POST", "/api/robot/head/calibration/start", "{}", headers)[0], 409)
        code, raw = self.request("POST", "/api/robot/arm", '{"enabled":true}', headers)
        self.assertEqual(code, 410)
        self.assertTrue(json.loads(raw)["emergency_stopped"])
        for controller in (self.ribs, self.drums, self.head):
            controller.calls.clear()
        code, raw = self.request("POST", "/api/robot/emergency-reset", "{}", headers)
        self.assertEqual(code, 200)
        self.assertFalse(json.loads(raw)["emergency_stopped"])
        self.assertEqual(self.ribs.calls, [("reset_stop",)])
        self.assertEqual(self.drums.calls, [("reset_stop",)])
        self.assertEqual(self.head.calls, [("reset_stop",)])

    def test_drum_strike_and_cached_status_http_contract(self):
        headers = {"Content-Type": "application/json"}
        payload = {"kind": "drums_strike", "motor_id": 1, "dry_run": False}
        foreign = {**headers, "Origin": "https://example.com"}
        self.assertEqual(self.request("POST", "/api/robot/command", json.dumps(payload), foreign)[0], 403)
        self.assertEqual(self.drums.calls, [])
        code, raw = self.request("POST", "/api/robot/command", json.dumps(payload), headers)
        self.assertEqual(code, 200)
        self.assertTrue(json.loads(raw)["drums"]["busy"])
        self.assertEqual(self.drums.calls, [("strike", 1, 2000, 150, 150, 1850, 500)])
        self.drums.state["strike"]["state"] = "returned"
        code, raw = self.request("GET", "/api/robot/drums/status")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)["drums"]["strike"]["state"], "returned")
        self.assertEqual(self.drums.calls, [("strike", 1, 2000, 150, 150, 1850, 500)])
        self.assertEqual(self.request("POST", "/api/robot/drums/status", "{}", headers)[0], 405)
        self.assertEqual(self.ribs.calls, [])
        self.assertEqual(self.head.calls, [])

    def test_failed_emergency_release_is_reported_and_remains_latched(self):
        headers = {"Content-Type": "application/json"}
        self.ribs.emergency_failure = "Motor 20 did not acknowledge torque off."
        self.head.emergency_failure = "Head 8 did not acknowledge torque off."
        code, raw = self.request("POST", "/api/robot/emergency-stop", "{}", headers)
        self.assertEqual(code, 502)
        body = json.loads(raw)
        self.assertTrue(body["emergency_stopped"])
        self.assertFalse(body["armed"])
        self.assertIn("Motor 20", body["error"])
        self.assertIn("Head 8", body["error"])
        self.assertFalse(body["results"]["ribs"]["ok"])
        self.assertTrue(body["results"]["drums"]["ok"])
        self.assertFalse(body["results"]["head"]["ok"])


if __name__ == "__main__":
    unittest.main()
