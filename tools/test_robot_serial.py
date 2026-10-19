#!/usr/bin/env python3
"""Head discovery and drum connection tests; all ports and SDK calls are fake."""

from __future__ import annotations

from types import SimpleNamespace
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
import robot_serial

from robot_serial import (BAUDRATES, DRUM_BOUNDS, DRUM_DEFAULT_DEVICE, DRUM_IDS,
                          DRUM_PREFERRED_DEVICE, HEAD_MODEL, DrumController, HeadController)


HEAD_DEVICE = "/dev/cu.usbserial-HEAD"
HEAD_IDENTITY = {"vid": 0x2F5D, "pid": 0x2202, "serial_number": "TEST-HEAD-SERIAL"}


class FakeSerialTest(unittest.TestCase):
    def setUp(self):
        self.reads, self.writes = [], []
        self.failures, self.write_failures = {}, {}
        self.positions, self.torques, self.modes, self.profiles = {}, {}, {}, {}
        self.models = {}
        self.registers = {}
        self.discovered = {7: [HEAD_MODEL, 45], 18: [HEAD_MODEL, 45]}
        self.port = Mock()
        self.port.ser = SimpleNamespace(exclusive=None)
        self.port.openPort.return_value = True
        self.port.setBaudRate.return_value = True
        self.packet = Mock()
        self.packet.broadcastPing.side_effect = lambda _port: (self.discovered, 0)
        self.packet.getTxRxResult.side_effect = lambda code: f"Communication error {code}"
        self.packet.getRxPacketError.side_effect = lambda code: f"Packet error {code}"
        self.packet.read1ByteTxRx.side_effect = self.read
        self.packet.read2ByteTxRx.side_effect = self.read
        self.packet.read4ByteTxRx.side_effect = self.read
        self.packet.write1ByteTxRx.side_effect = self.write
        self.packet.write4ByteTxRx.side_effect = self.write
        self.sdk = SimpleNamespace(COMM_SUCCESS=0, PortHandler=Mock(return_value=self.port),
                                   PacketHandler=Mock(return_value=self.packet))
        preferred_patch = patch("robot_serial.robot_devices.preferred_connection", side_effect=lambda group: {
            "state": "matched" if group == "drums" else "unavailable",
            "device": DRUM_PREFERRED_DEVICE if group == "drums" else None,
            "baudrate": 1_000_000 if group == "drums" else None,
            "identity": None, "message": "Test USB discovery", "label": group,
        })
        self.preferred_connection = preferred_patch.start()
        self.addCleanup(preferred_patch.stop)
        identity_patch = patch("robot_serial.robot_devices.device_identity", return_value=None)
        self.device_identity = identity_patch.start()
        self.addCleanup(identity_patch.stop)
        self.mocks = {}
        for name, value in (("_ports", [DRUM_PREFERRED_DEVICE, HEAD_DEVICE]),
                            ("_dependency_available", True), ("os.path.exists", True),
                            ("importlib.import_module", self.sdk)):
            context = patch("robot_serial." + name, return_value=value)
            self.mocks[name] = context.start()
            self.addCleanup(context.stop)
        self.drums = DrumController()
        self.head = HeadController(calibration_path=None)
        self.addCleanup(self.drums.close)
        self.addCleanup(self.head.close)

    def read(self, port, motor_id, address):
        self.reads.append((motor_id, address))
        failure = self.failures.get((motor_id, address))
        if isinstance(failure, Exception):
            raise failure
        if failure is not None:
            return failure
        values = {0: self.models.get(motor_id, HEAD_MODEL), 6: self.discovered.get(motor_id, [HEAD_MODEL, 45])[1],
                  132: self.positions.get(motor_id, 2048), 64: self.torques.get(motor_id, 1),
                  70: 0, 10: self.profiles.get(motor_id, 4), 11: self.modes.get(motor_id, 3),
                  52: 0, 48: 4095, 12: 255, 20: 0, 108: 0, 112: 0, 116: 2048, 122: 0,
                  80: 2000, 82: 0, 84: 640, 36: 885, 100: 885, 124: 0, 126: 0, 144: 111, 146: 25,
                  128: 0, 136: 0, 140: self.registers.get((motor_id, 116), self.positions.get(motor_id, 2048)), 123: 1}
        return self.registers.get((motor_id, address), values[address]), 0, 0

    def write(self, port, motor_id, address, value):
        self.writes.append((motor_id, address, value))
        failure = self.write_failures.get((motor_id, address))
        if isinstance(failure, Exception):
            raise failure
        if failure is not None:
            return failure
        if address == 64:
            self.torques[motor_id] = value
        else:
            self.registers[(motor_id, address)] = value
        return 0, 0


class DrumRecoveryTests(FakeSerialTest):
    def setUp(self):
        super().setUp()
        self.positions = {0: 2200, 1: 1850, 2: 2300, 3: 2602}
        self.drums.check()
        self.reads.clear()
        self.cancelled = threading.Event()

    def test_recovery_moves_only_selected_arm_to_inset_fixed_rest(self):
        result = self.drums.performance_recover(3, self.cancelled)
        self.assertEqual(result, {"target": 2590, "duration_ms": 2000})
        self.assertEqual(self.writes, [(3, 112, 2000), (3, 116, 2590)])
        self.assertEqual(self.reads, [(3, address) for address in (132, 64, 70, 10, 11, 52, 48)])
        self.writes.clear()
        self.positions[1] = 1848
        self.assertEqual(self.drums.performance_recover(1, self.cancelled)["target"], 1860)
        self.assertEqual(self.writes, [(1, 112, 2000), (1, 116, 1860)])

    def test_recovery_exception_does_not_relax_normal_strike_or_return_bounds(self):
        from robot_drum_performance import DrumPerformanceBounds
        for action in (
            lambda: self.drums.performance_verify(3, 2600, self.cancelled),
            lambda: self.drums.performance_move(3, 2600, 150, self.cancelled),
            lambda: self.drums.performance_stage(3, 2600, 2430, 200, self.cancelled,
                                                 deadline_ms=1000, clock=lambda: 0),
        ):
            with self.assertRaises(DrumPerformanceBounds):
                action()
        self.assertEqual(self.writes, [])

    def test_unhealthy_or_incompatible_arm_never_enters_recovery(self):
        from robot_drum_performance import DrumPerformanceBounds
        for field, address, value in (("torques", 3, 0), ("profiles", 3, 0), ("profiles", 3, 12),
                                      ("modes", 3, 1), ("positions", 3, None),
                                      ("failures", (3, 70), (4, 0, 0)),
                                      ("failures", (3, 132), (0, -1, 0)),
                                      ("failures", (3, 52), (0, -1, 0)),
                                      ("registers", (3, 48), 2500)):
            with self.subTest(field=field, value=value):
                values = getattr(self, field)
                previous, present = values.get(address), address in values
                values[address] = value
                try:
                    with self.assertRaises(RuntimeError) as error:
                        self.drums.performance_recover(3, self.cancelled)
                    self.assertNotIsInstance(error.exception, DrumPerformanceBounds)
                    self.assertEqual(self.writes, [])
                finally:
                    if present:
                        values[address] = previous
                    else:
                        values.pop(address)

    def test_cancellation_and_bus_changes_interrupt_between_every_read(self):
        from robot_drum_performance import DrumPerformanceSessionError
        for address in (132, 64, 70, 10, 11, 52, 48):
            for action in ("cancel", "connection"):
                with self.subTest(address=address, action=action):
                    self.reads.clear()
                    self.cancelled.clear()
                    saved_device = self.drums._device
                    def interrupted(port, motor, register):
                        result = self.read(port, motor, register)
                        if register == address:
                            if action == "cancel":
                                self.cancelled.set()
                            else:
                                self.drums._device = "/dev/cu.changed"
                        return result
                    self.packet.read1ByteTxRx.side_effect = interrupted
                    self.packet.read4ByteTxRx.side_effect = interrupted
                    try:
                        with self.assertRaises(DrumPerformanceSessionError):
                            self.drums.performance_recover(3, self.cancelled)
                        self.assertEqual(self.reads[-1], (3, address))
                        self.assertEqual(self.writes, [])
                    finally:
                        self.drums._device = saved_device

    def test_emergency_during_each_recovery_write_prevents_following_commands(self):
        from robot_drum_performance import DrumPerformanceSessionError
        for address in (112, 116):
            with self.subTest(address=address):
                self.writes.clear()
                self.drums.reset_stop()
                def interrupted(port, motor, register, value):
                    result = self.write(port, motor, register, value)
                    if register == address:
                        self.drums.request_stop()
                    return result
                self.packet.write4ByteTxRx.side_effect = interrupted
                with self.assertRaises(DrumPerformanceSessionError):
                    self.drums.performance_recover(3, self.cancelled)
                self.assertEqual(self.writes[-1][1], address)
                self.assertEqual(len(self.writes), 1 if address == 112 else 2)

    def test_unacknowledged_recovery_goal_is_never_retried(self):
        self.write_failures[(3, 116)] = (-1, 0)
        with self.assertRaisesRegex(RuntimeError, "Position is uncertain"):
            self.drums.performance_recover(3, self.cancelled)
        self.assertEqual(self.writes, [(3, 112, 2000), (3, 116, 2590)])


class HeadControllerTests(FakeSerialTest):
    def test_recognized_default_is_preselected_without_opening_hardware(self):
        self.preferred_connection.side_effect = None
        self.preferred_connection.return_value = {
            "state": "matched", "device": "/dev/ttyACM7", "baudrate": 1_000_000,
            "identity": HEAD_IDENTITY, "label": "Head", "message": "Recognized",
        }
        other = HeadController(calibration_path=None)
        self.addCleanup(other.close)
        state = other.snapshot()
        self.assertEqual((state["device"], state["baudrate"]), ("/dev/ttyACM7", 1_000_000))
        self.assertEqual(state["state"], "unchecked")
        self.assertIsNone(state["checked_at"])
        self.assertFalse(state["port_open"])
        self.sdk.PortHandler.assert_not_called()
        self.assertEqual((self.reads, self.writes), ([], []))

    def test_windows_com_device_uses_enumeration_instead_of_filesystem(self):
        self.mocks["_ports"].return_value = ["COM12"]
        self.mocks["os.path.exists"].return_value = False
        self.assertEqual(self.head.check("COM12", 1_000_000)["state"], "ready")
        self.sdk.PortHandler.assert_called_once_with("COM12")
        self.assertEqual(self.writes, [])

    def test_startup_snapshot_disconnect_close_never_open_or_write(self):
        state = self.head.snapshot()
        self.assertIsNone(state["device"])
        self.assertEqual(state["baudrate"], 57600)
        self.assertFalse(state["port_open"])
        self.assertEqual(state["motors"], [])
        self.assertIsNone(state["upright_reference"])
        self.head.disconnect()
        self.head.close()
        self.sdk.PortHandler.assert_not_called()
        self.mocks["importlib.import_module"].assert_not_called()
        self.assertFalse(self.reads)
        self.assertFalse(self.writes)

    def test_no_default_device_and_no_guess_of_ids(self):
        self.assertEqual(self.head.check()["code"], "device_required")
        self.assertFalse(self.head.capture_upright()["ok"])
        self.sdk.PortHandler.assert_not_called()
        state = self.head.check(HEAD_DEVICE)
        self.assertEqual(state["state"], "ready")
        self.assertEqual([row["id"] for row in state["motors"]], [7, 18])
        self.assertEqual({motor_id for motor_id, _ in self.reads}, {7, 18})
        self.assertEqual(self.writes, [])

    def test_successful_read_reports_identity_torque_modes_and_device_limits(self):
        self.torques[7] = 0
        self.profiles[7] = 0
        state = self.head.check(HEAD_DEVICE, 115200)
        self.assertEqual(state["state"], "ready")
        self.assertTrue(state["port_open"])
        self.assertIsNotNone(state["checked_at"])
        self.sdk.PacketHandler.assert_called_once_with(2.0)
        self.port.setBaudRate.assert_called_once_with(115200)
        first = state["motors"][0]
        self.assertFalse(first["torque_enabled"])
        self.assertEqual(first["profile_mode"], "velocity")
        self.assertEqual(first["operating_mode"], 3)
        self.assertEqual(first["model_number"], HEAD_MODEL)
        self.assertEqual(first["firmware"], 45)
        self.assertEqual(first["device_min_position"], 0)
        self.assertEqual(first["device_max_position"], 4095)
        self.assertIn("not calibrated", state["message"])
        self.assertEqual(self.writes, [])

    def test_signed_present_positions_are_not_clamped_to_device_limits(self):
        self.positions = {7: 0xFFFFFF9C, 18: 2**31 - 1}
        rows = self.head.check(HEAD_DEVICE)["motors"]
        self.assertEqual([row["position"] for row in rows], [-100, 2**31 - 1])
        self.assertEqual(self.writes, [])

    def test_upright_capture_reads_again_and_preserves_pose_without_writing(self):
        self.head.check(HEAD_DEVICE)
        self.positions = {7: 1915, 18: 2125}
        result = self.head.capture_upright()
        self.assertTrue(result["ok"])
        reference = result["head"]["upright_reference"]
        self.assertEqual(reference["device"], HEAD_DEVICE)
        self.assertEqual(reference["baudrate"], 57600)
        self.assertEqual(reference["positions"], [{"id": 7, "position": 1915}, {"id": 18, "position": 2125}])
        self.assertEqual(reference["recorded_at"], result["head"]["checked_at"])
        self.assertEqual(self.packet.broadcastPing.call_count, 2)
        self.positions[7] = 1950
        self.assertEqual(self.head.check()["upright_reference"], reference)
        self.head.disconnect()
        self.head.close()
        self.assertEqual(self.writes, [])
        self.assertFalse(self.head.torque(True)["ok"])
        self.assertFalse(self.head.move(7, 1950, 1000)["ok"])
        self.assertEqual(self.writes, [])

    def test_snapshot_reference_is_a_copy(self):
        self.head.check(HEAD_DEVICE)
        reference = self.head.capture_upright()["head"]["upright_reference"]
        reference["positions"][0]["position"] = -123
        self.assertEqual(self.head.snapshot()["upright_reference"]["positions"][0]["position"], 2048)

    def test_port_baud_and_discovered_id_changes_clear_reference(self):
        self.head.check(HEAD_DEVICE)
        self.head.capture_upright()
        self.assertIsNone(self.head.check("/dev/cu.usbserial-OTHER")["upright_reference"])
        self.head.capture_upright()
        self.assertIsNone(self.head.check(baudrate=1_000_000)["upright_reference"])
        self.head.capture_upright()
        self.discovered = {8: [HEAD_MODEL, 45], 19: [HEAD_MODEL, 45]}
        self.assertIsNone(self.head.check()["upright_reference"])
        self.assertEqual(self.writes, [])

    def test_unexpected_models_are_reported_without_reading_their_registers(self):
        self.discovered = {7: [1060, 12], 18: [HEAD_MODEL, 45]}
        state = self.head.check(HEAD_DEVICE)
        self.assertEqual(state["code"], "unexpected_model")
        self.assertEqual(state["motors"][0]["model_number"], 1060)
        self.assertIn("1060", state["message"])
        self.assertIn("1090", state["message"])
        self.assertEqual({motor_id for motor_id, _ in self.reads}, {18})
        self.assertFalse(self.head.capture_upright()["ok"])
        self.assertIsNone(self.head.snapshot()["upright_reference"])
        self.assertEqual(self.writes, [])

    def test_extra_and_missing_axes_cannot_capture_reference(self):
        for discovered in ({}, {7: [HEAD_MODEL, 45]},
                           {7: [HEAD_MODEL, 45], 18: [HEAD_MODEL, 45], 19: [HEAD_MODEL, 45]}):
            with self.subTest(discovered=discovered):
                self.discovered = discovered
                state = self.head.check(HEAD_DEVICE)
                self.assertNotEqual(state["state"], "ready")
                self.assertFalse(self.head.capture_upright()["ok"])
                self.assertIsNone(self.head.snapshot()["upright_reference"])
        self.assertEqual(self.writes, [])

    def test_broadcast_failure_closes_port_and_clears_reference(self):
        self.head.check(HEAD_DEVICE)
        self.head.capture_upright()
        self.packet.broadcastPing.side_effect = lambda _port: ({}, -3001)
        state = self.head.check()
        self.assertEqual(state["code"], "discovery_failed")
        self.assertIn("Communication error -3001", state["message"])
        self.assertIsNone(state["upright_reference"])
        self.assertFalse(state["port_open"])
        self.assertEqual(self.writes, [])

    def test_malformed_discovery_never_reads_or_writes_registers(self):
        for discovered in ([], {253: [HEAD_MODEL, 45]}, {True: [HEAD_MODEL, 45]},
                           {7: [HEAD_MODEL]}, {7: [HEAD_MODEL, -1]}, {"7": [HEAD_MODEL, 45]}):
            with self.subTest(discovered=discovered):
                self.discovered = discovered
                self.assertEqual(self.head.check(HEAD_DEVICE)["code"], "discovery_failed")
        self.assertEqual(self.reads, [])
        self.assertEqual(self.writes, [])

    def test_failed_register_reads_and_hardware_faults_block_capture(self):
        for failure in ((0, -3001, 0), (0, 0, 4), OSError("unplugged")):
            with self.subTest(failure=failure):
                self.failures[(7, 132)] = failure
                state = self.head.check(HEAD_DEVICE)
                self.assertEqual(state["code"], "motor_error")
                self.assertFalse(self.head.capture_upright()["ok"])
        self.failures = {(7, 70): (32, 0, 0)}
        state = self.head.check()
        self.assertIn("0x20", state["motors"][0]["error"])
        self.assertFalse(self.head.capture_upright()["ok"])
        self.assertEqual(self.writes, [])

    def test_device_limit_failure_is_not_a_ready_connection(self):
        self.failures[(18, 48)] = (0, -3001, 0)
        state = self.head.check(HEAD_DEVICE)
        self.assertEqual(state["state"], "partial")
        self.assertIsNone(state["motors"][1]["device_max_position"])
        self.assertFalse(self.head.capture_upright()["ok"])
        self.assertEqual(self.writes, [])

    def test_invalid_devices_and_baudrates_do_not_open_port(self):
        for device in ("", "/tmp/port", "/dev/null", "/dev/ttyUSB0/../x", 5, True):
            with self.subTest(device=device), self.assertRaises(ValueError):
                self.head.check(device)
        for baudrate in (0, 9600, 57600.5, True, "57600", float("nan"), 4_000_001):
            with self.subTest(baudrate=baudrate), self.assertRaises(ValueError):
                self.head.check(HEAD_DEVICE, baudrate)
        self.sdk.PortHandler.assert_not_called()

    def test_all_supported_baudrates_change_only_host_port(self):
        for baudrate in BAUDRATES:
            self.assertEqual(self.head.check(HEAD_DEVICE, baudrate)["baudrate"], baudrate)
        self.assertEqual([call.args[0] for call in self.port.setBaudRate.call_args_list], list(BAUDRATES))
        self.assertEqual(self.writes, [])

    def test_missing_dependency_missing_adapter_and_open_failure(self):
        self.mocks["importlib.import_module"].side_effect = ImportError("missing")
        self.mocks["_dependency_available"].return_value = False
        state = self.head.check(HEAD_DEVICE)
        self.assertEqual(state["code"], "dependency_missing")
        self.assertFalse(state["dependency_available"])
        self.mocks["importlib.import_module"].side_effect = None
        self.mocks["os.path.exists"].return_value = False
        self.assertEqual(self.head.check()["code"], "device_missing")
        self.mocks["os.path.exists"].return_value = True
        self.port.openPort.side_effect = OSError("resource busy")
        self.assertEqual(self.head.check()["code"], "serial_open_failed")
        self.assertFalse(self.head.snapshot()["port_open"])
        self.assertEqual(self.writes, [])

    def test_baudrate_failure_and_close_cannot_write_or_reopen(self):
        for failure in (False, OSError("unsupported")):
            with self.subTest(failure=failure):
                self.port.setBaudRate.side_effect = failure if isinstance(failure, Exception) else None
                self.port.setBaudRate.return_value = failure
                state = self.head.check(HEAD_DEVICE)
                self.assertEqual(state["code"], "baudrate_failed")
                self.assertFalse(state["port_open"])
        self.head.close()
        self.assertEqual(self.head.check()["code"], "closed")
        self.assertFalse(self.head.capture_upright()["ok"])
        self.assertEqual(self.writes, [])

    def test_exclusivity_is_applied_after_baudrate_reopens_serial(self):
        original = self.port.ser
        replacement = SimpleNamespace(exclusive=None)

        def set_baud(_baud):
            self.port.ser = replacement
            return True

        self.port.setBaudRate.side_effect = set_baud
        self.head.check(HEAD_DEVICE)
        self.assertIsNone(original.exclusive)
        self.assertTrue(replacement.exclusive)
        self.assertEqual(self.writes, [])


class HeadCalibrationTests(FakeSerialTest):
    def setUp(self):
        super().setUp()
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "robot" / "head-calibration.json"
        self.head = HeadController(calibration_path=self.path)
        self.addCleanup(self.head.close)
        self.torques = {7: 0, 18: 0}
        interval = patch.object(robot_serial, "CALIBRATION_SAMPLE_INTERVAL", 10)
        interval.start()
        self.addCleanup(interval.stop)

    def tearDown(self):
        self.assertEqual(self.writes, [], "Head calibration must never write any motor register")

    def start(self):
        self.assertEqual(self.head.check(HEAD_DEVICE)["state"], "ready")
        result = self.head.calibration_start()
        self.assertTrue(result["ok"], result)
        return result["head"]["calibration"]

    def sample(self, first, second):
        with self.head._lock:
            self.positions = {7: first, 18: second}
            self.head._sample_calibration()
        return self.head.snapshot()["calibration"]

    def stopped_range(self):
        self.start()
        self.sample(1900, 1900)
        self.sample(2200, 2200)
        self.positions = {7: 2048, 18: 2048}
        self.assertTrue(self.head.calibration_stop()["ok"])

    def wait_until(self, predicate):
        deadline = time.monotonic() + 2
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail("Timed out waiting for the mocked sampler")
            threading.Event().wait(.005)

    def test_start_requires_identified_open_axes_and_fresh_torque_off(self):
        self.assertFalse(self.head.calibration_start()["ok"])
        self.sdk.PortHandler.assert_not_called()
        self.head.check(HEAD_DEVICE)
        self.torques[18] = 1
        result = self.head.calibration_start()
        self.assertFalse(result["ok"])
        self.assertIn("torque must be off", result["error"])
        self.assertEqual(result["head"]["calibration"]["axes"], [])
        self.torques[18] = 0
        self.discovered = {7: [HEAD_MODEL, 45], 19: [HEAD_MODEL, 45]}
        self.assertFalse(self.head.calibration_start()["ok"])
        self.assertFalse(self.path.exists())

    def test_start_seeds_current_pose_and_matching_upright_centres(self):
        self.positions = {7: 2050, 18: 2075}
        self.head.check(HEAD_DEVICE)
        self.head.capture_upright()
        self.positions = {7: 2010, 18: 2090}
        calibration = self.head.calibration_start()["head"]["calibration"]
        self.assertEqual(calibration["state"], "recording")
        self.assertEqual(calibration["sample_count"], 1)
        self.assertEqual([row["centre"] for row in calibration["axes"]], [2050, 2075])
        self.assertEqual([row["min"] for row in calibration["axes"]], [2010, 2090])
        self.assertEqual([row["max"] for row in calibration["axes"]], [2010, 2090])
        self.assertEqual(calibration["started_at"], calibration["sampled_at"])

    def test_duplicate_start_does_not_reset_recorded_range(self):
        self.start()
        before = self.sample(1900, 2200)
        result = self.head.calibration_start()
        self.assertFalse(result["ok"])
        self.assertEqual(result["head"]["calibration"], before)
        self.head.calibration_stop()
        fresh = self.head.calibration_start()["head"]["calibration"]
        self.assertEqual(fresh["sample_count"], 1)
        self.assertEqual([row["min"] for row in fresh["axes"]], [1900, 2200])

    def test_known_axis_samples_capture_signed_extrema_without_broadcast(self):
        self.positions = {7: 0xFFFFFFF0, 18: 5000}
        self.start()
        broadcasts = self.packet.broadcastPing.call_count
        self.sample(0xFFFFFF9C, 5100)
        calibration = self.sample(10, 4800)
        self.assertEqual([(axis["min"], axis["centre"], axis["max"]) for axis in calibration["axes"]],
                         [(-100, -16, 10), (4800, 5000, 5100)])
        self.assertEqual(calibration["sample_count"], 3)
        self.assertEqual(self.packet.broadcastPing.call_count, broadcasts)
        self.assertEqual(sum(call.args[2] == 0 for call in self.packet.read2ByteTxRx.call_args_list), 4)
        self.head.calibration_stop()
        saved = self.head.calibration_save()
        self.assertTrue(saved["ok"], saved)
        self.assertEqual(saved["head"]["calibration"]["saved"]["axes"][0]["min"], -100)

    def test_background_worker_records_and_stops_when_torque_turns_on(self):
        with patch.object(robot_serial, "CALIBRATION_SAMPLE_INTERVAL", .01):
            self.start()
            with self.head._lock:
                self.positions = {7: 1950, 18: 2150}
            self.wait_until(lambda: self.head.snapshot()["calibration"]["sample_count"] >= 2)
            with self.head._lock:
                self.torques[7] = 1
            self.wait_until(lambda: not self.head.snapshot()["calibration"]["recording"])
        calibration = self.head.snapshot()["calibration"]
        self.assertEqual(calibration["state"], "error")
        self.assertIn("torque must be off", calibration["message"])
        self.assertEqual(calibration["axes"][0]["min"], 1950)
        self.assertEqual(self.torques[7], 1)

    def test_unknown_torque_read_error_and_model_change_stop_recording(self):
        for failure in ("unknown_torque", "read_error", "model_change"):
            with self.subTest(failure=failure):
                self.failures.clear()
                self.models.clear()
                self.torques = {7: 0, 18: 0}
                self.start()
                if failure == "unknown_torque":
                    self.torques[7] = 2
                elif failure == "read_error":
                    self.failures[(7, 132)] = (0, -3001, 0)
                else:
                    self.models[7] = 1060
                calibration = self.sample(2000, 2100)
                self.assertFalse(calibration["recording"])
                self.assertEqual(calibration["state"], "error")
                self.assertEqual(calibration["sample_count"], 1)
                self.head.calibration_stop()

    def test_background_exception_stops_without_unhandled_worker_error(self):
        with patch.object(robot_serial, "CALIBRATION_SAMPLE_INTERVAL", .01):
            self.start()
            self.packet.read2ByteTxRx.side_effect = OSError("USB removed")
            self.wait_until(lambda: not self.head.snapshot()["calibration"]["recording"])
        state = self.head.snapshot()
        self.assertEqual(state["calibration"]["state"], "error")
        self.assertEqual(state["code"], "calibration_read_failed")
        self.assertIn("USB removed", state["calibration"]["message"])

    def test_explicit_check_stops_recording_on_changed_ids_or_same_id_wrong_model(self):
        for discovered in ({7: [HEAD_MODEL, 45], 19: [HEAD_MODEL, 45]},
                           {7: [1060, 45], 18: [HEAD_MODEL, 45]}):
            with self.subTest(discovered=discovered):
                self.discovered = {7: [HEAD_MODEL, 45], 18: [HEAD_MODEL, 45]}
                self.start()
                self.discovered = discovered
                state = self.head.check()
                self.assertFalse(state["calibration"]["recording"])
                self.assertEqual(state["calibration"]["state"], "error")
                self.head.calibration_stop()

    def test_centre_is_fresh_and_does_not_expand_stopped_bounds(self):
        self.stopped_range()
        self.positions = {7: 2050, 18: 2070}
        result = self.head.calibration_centre()
        self.assertTrue(result["ok"], result)
        self.assertEqual([axis["centre"] for axis in result["head"]["calibration"]["axes"]], [2050, 2070])
        self.positions = {7: 2300, 18: 2300}
        result = self.head.calibration_centre()
        self.assertEqual([axis["max"] for axis in result["head"]["calibration"]["axes"]], [2200, 2200])
        self.assertFalse(self.head.calibration_save()["ok"])
        self.assertFalse(self.path.exists())

    def test_centre_during_recording_is_included_in_recorded_extrema(self):
        self.start()
        self.positions = {7: 2300, 18: 1900}
        calibration = self.head.calibration_centre()["head"]["calibration"]
        self.assertTrue(calibration["recording"])
        self.assertEqual([(axis["min"], axis["centre"], axis["max"]) for axis in calibration["axes"]],
                         [(2048, 2300, 2300), (1900, 1900, 2048)])
        self.assertEqual(calibration["sample_count"], 2)

    def test_save_requires_stopped_nonempty_ranges_fresh_matching_ids_and_torque_off(self):
        self.assertFalse(self.head.calibration_save()["ok"])
        self.start()
        self.assertFalse(self.head.calibration_save()["ok"])
        self.head.calibration_stop()
        self.assertFalse(self.head.calibration_save()["ok"])
        self.stopped_range()
        self.torques[18] = 1
        self.assertFalse(self.head.calibration_save()["ok"])
        self.torques[18] = 0
        self.failures[(7, 132)] = (0, -3001, 0)
        self.assertFalse(self.head.calibration_save()["ok"])
        self.failures.clear()
        self.discovered = {7: [HEAD_MODEL, 45], 19: [HEAD_MODEL, 45]}
        self.torques[19] = 0
        self.assertFalse(self.head.calibration_save()["ok"])
        self.assertFalse(self.path.exists())

    def test_save_labels_atomic_file_and_reload_without_hardware_or_autostart(self):
        self.stopped_range()
        result = self.head.calibration_save({"7": " Pan ", "18": "Tilt"})
        self.assertTrue(result["ok"], result)
        document = json.loads(self.path.read_text())
        self.assertEqual(document["version"], 1)
        self.assertEqual(document["model_number"], HEAD_MODEL)
        self.assertEqual(document["sample_count"], 3)
        self.assertEqual([axis["label"] for axis in document["axes"]], ["Pan", "Tilt"])
        self.assertEqual(result["head"]["calibration"]["saved"], document)
        self.positions = {7: 2050, 18: 2050}
        edited = self.head.calibration_centre()["head"]["calibration"]
        self.assertEqual(edited["state"], "stopped")
        self.assertEqual(edited["saved"], document)
        self.assertEqual(json.loads(self.path.read_text()), document)
        reads, opens = len(self.reads), self.sdk.PortHandler.call_count
        other = HeadController(calibration_path=self.path)
        self.addCleanup(other.close)
        state = other.snapshot()
        self.assertEqual(state["calibration"]["saved"], document)
        self.assertEqual(state["calibration"]["state"], "idle")
        self.assertEqual(state["calibration"]["axes"], [])
        self.assertFalse(state["calibration"]["saved_matches_connection"])
        self.assertFalse(state["calibration"]["recording"])
        self.assertIsNone(state["device"])
        self.assertEqual(len(self.reads), reads)
        self.assertEqual(self.sdk.PortHandler.call_count, opens)
        self.assertTrue(other.check(HEAD_DEVICE)["calibration"]["saved_matches_connection"])
        other.disconnect()
        alias = HEAD_DEVICE.replace("/dev/cu.", "/dev/tty.")
        self.assertTrue(other.check(alias)["calibration"]["saved_matches_connection"])

    def test_identity_calibration_follows_new_computer_only_after_motor_check(self):
        self.stopped_range()
        self.device_identity.return_value = HEAD_IDENTITY
        with patch.object(robot_serial.robot_devices, "_discover", return_value=([
            {"device": HEAD_DEVICE, **HEAD_IDENTITY},
        ], None)):
            result = self.head.calibration_save()
        self.assertTrue(result["ok"], result)
        document = json.loads(self.path.read_text())
        self.assertEqual(document["device_identity"], HEAD_IDENTITY)
        self.assertEqual(document["device"], HEAD_DEVICE)
        self.head.disconnect()
        reads, opens = len(self.reads), self.sdk.PortHandler.call_count
        with patch.object(robot_serial.robot_devices, "_discover", return_value=([
            {"device": "/dev/ttyACM3", **HEAD_IDENTITY},
        ], None)):
            other = HeadController(calibration_path=self.path)
            self.addCleanup(other.close)
            state = other.snapshot()["calibration"]
            self.assertEqual(state["saved_connection"]["device"], "/dev/ttyACM3")
            self.assertFalse(state["saved_matches_connection"])
            self.assertEqual((len(self.reads), self.sdk.PortHandler.call_count), (reads, opens))
            self.assertTrue(other.check("/dev/ttyACM3")["calibration"]["saved_matches_connection"])
            other.disconnect()
            self.assertFalse(other.snapshot()["calibration"]["saved_matches_connection"])
        self.assertEqual(json.loads(self.path.read_text()), document)

    def test_identity_calibration_does_not_trust_reused_path_missing_or_duplicate_usb(self):
        self.stopped_range()
        self.device_identity.return_value = HEAD_IDENTITY
        self.head.calibration_save()
        for rows in ([], [{"device": HEAD_DEVICE, **HEAD_IDENTITY, "serial_number": "OTHER"}],
                     [{"device": HEAD_DEVICE, **HEAD_IDENTITY}, {"device": "/dev/ttyACM4", **HEAD_IDENTITY}]):
            with self.subTest(rows=rows), patch.object(robot_serial.robot_devices, "_discover", return_value=(rows, None)):
                self.head.check(HEAD_DEVICE)
                self.assertFalse(self.head.snapshot()["calibration"]["saved_matches_connection"])
                self.assertFalse(self.head.torque(True)["ok"])
                self.assertFalse(self.writes)

    def test_identity_match_still_requires_saved_baud_motor_ids_and_models(self):
        self.stopped_range()
        self.device_identity.return_value = HEAD_IDENTITY
        self.head.calibration_save()
        with patch.object(robot_serial.robot_devices, "_discover", return_value=([
            {"device": "/dev/ttyACM3", **HEAD_IDENTITY},
        ], None)):
            self.assertFalse(self.head.check("/dev/ttyACM3", 1_000_000)["calibration"]["saved_matches_connection"])
            self.discovered = {7: [HEAD_MODEL, 45], 19: [HEAD_MODEL, 45]}
            self.assertFalse(self.head.check("/dev/ttyACM3", 57_600)["calibration"]["saved_matches_connection"])
            self.discovered = {7: [HEAD_MODEL, 45], 18: [1060, 45]}
            self.assertFalse(self.head.check("/dev/ttyACM3", 57_600)["calibration"]["saved_matches_connection"])

    def test_legacy_calibration_never_inherits_default_usb_identity(self):
        self.stopped_range()
        self.head.calibration_save()
        self.assertNotIn("device_identity", json.loads(self.path.read_text()))
        state = self.head.check("/dev/ttyACM9")["calibration"]
        self.assertEqual(state["saved_connection"]["device"], HEAD_DEVICE)
        self.assertFalse(state["saved_matches_connection"])

    def test_save_failure_preserves_previous_file_and_saved_snapshot(self):
        self.stopped_range()
        self.assertTrue(self.head.calibration_save()["ok"])
        previous = self.path.read_text()
        saved = self.head.snapshot()["calibration"]["saved"]
        with patch.object(robot_serial.os, "replace", side_effect=OSError("disk full")):
            result = self.head.calibration_save({"7": "New pan"})
        self.assertFalse(result["ok"])
        self.assertIn("disk full", result["head"]["calibration"]["storage_error"])
        self.assertEqual(result["head"]["calibration"]["saved"], saved)
        self.assertEqual(self.path.read_text(), previous)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])
        self.assertTrue(self.head.calibration_save({"7": "New pan"})["ok"])
        self.assertIsNone(self.head.snapshot()["calibration"]["storage_error"])

    def test_label_validation_never_overwrites_saved_data(self):
        self.stopped_range()
        for labels in ([], {"999": "Unknown"}, {7: "Number key"}, {"7": "x" * 49},
                       {"7": "Line\nbreak"}, {"7": "\nPan"}, {"7": 12}):
            with self.subTest(labels=labels):
                self.assertFalse(self.head.calibration_save(labels)["ok"])
                self.assertFalse(self.path.exists())
        self.assertTrue(self.head.calibration_save({"7": ""})["ok"])
        self.assertEqual(json.loads(self.path.read_text())["axes"][0]["label"], "Motor 7")

    def test_corrupt_or_invalid_saved_document_reports_storage_error_without_io(self):
        self.stopped_range()
        self.head.calibration_save()
        good = json.loads(self.path.read_text())
        invalid_documents = ["not json", "[]"]
        modifications = [lambda doc: doc.update(version=2), lambda doc: doc.update(model_number=1060),
                         lambda doc: doc.update(sample_count=0), lambda doc: doc.update(saved_at="2026-10-16"),
                         lambda doc: doc.update(baudrate=True), lambda doc: doc.update(device="/tmp/notserial"),
                         lambda doc: doc.update(device_identity=None),
                         lambda doc: doc.update(device_identity={**HEAD_IDENTITY, "serial_number": ""}),
                         lambda doc: doc["axes"][0].update(min=3.0), lambda doc: doc["axes"][0].update(centre=5000),
                         lambda doc: doc["axes"][0].update(min=2**31),
                         lambda doc: doc["axes"][1].update(id=7), lambda doc: doc["axes"][0].update(label="")]
        for modify in modifications:
            document = json.loads(json.dumps(good))
            modify(document)
            invalid_documents.append(json.dumps(document))
        before = len(self.reads)
        for contents in invalid_documents:
            with self.subTest(contents=contents):
                self.path.write_text(contents)
                other = HeadController(calibration_path=self.path)
                self.addCleanup(other.close)
                calibration = other.snapshot()["calibration"]
                self.assertIsNone(calibration["saved"])
                self.assertTrue(calibration["storage_error"])
                self.assertFalse(calibration["recording"])
        self.assertEqual(len(self.reads), before)

    def test_selection_change_stops_worker_clears_draft_and_keeps_saved_data(self):
        self.stopped_range()
        self.head.calibration_save()
        saved = self.head.snapshot()["calibration"]["saved"]
        self.head.calibration_start()
        thread = self.head._sample_thread
        state = self.head.check("/dev/cu.usbserial-OTHER")
        thread.join(timeout=1)
        self.assertFalse(thread.is_alive())
        calibration = state["calibration"]
        self.assertFalse(calibration["recording"])
        self.assertEqual(calibration["axes"], [])
        self.assertEqual(calibration["sample_count"], 0)
        self.assertEqual(calibration["saved"], saved)
        self.assertFalse(calibration["saved_matches_connection"])

    def test_stop_disconnect_and_close_join_worker_and_prevent_further_reads(self):
        for action in ("calibration_stop", "disconnect", "close"):
            with self.subTest(action=action):
                self.start()
                thread = self.head._sample_thread
                getattr(self.head, action)()
                self.assertFalse(thread.is_alive())
                before = len(self.reads)
                self.head.snapshot()
                self.assertEqual(len(self.reads), before)
                self.assertFalse(self.head.snapshot()["calibration"]["recording"])

    def test_close_waits_for_in_flight_read_then_closes_without_deadlock(self):
        reading, proceed, closed = threading.Event(), threading.Event(), threading.Event()
        original_read = self.packet.read2ByteTxRx.side_effect

        def blocked_read(*args):
            if args[2] == 0:  # Block the background identity read, not setup diagnostics.
                reading.set()
                if not proceed.wait(2):
                    raise OSError("test read release timed out")
            return original_read(*args)

        self.packet.read2ByteTxRx.side_effect = blocked_read
        with patch.object(robot_serial, "CALIBRATION_SAMPLE_INTERVAL", .01):
            self.start()
            self.assertTrue(reading.wait(1))
            closer = threading.Thread(target=lambda: (self.head.close(), closed.set()))
            closer.start()
            self.assertFalse(closed.wait(.02))
            proceed.set()
            self.assertTrue(closed.wait(2))
            closer.join(timeout=1)
        self.assertFalse(self.head._sample_thread.is_alive())
        self.assertFalse(self.head.snapshot()["port_open"])


class HeadMotionSampleTests(FakeSerialTest):
    def setUp(self):
        super().setUp()
        self.head.check(HEAD_DEVICE, 1000000)
        self.reads.clear()

    def tearDown(self):
        self.assertFalse(self.writes, "Motion telemetry never writes motor registers")

    def test_sample_during_motion_decodes_signed_registers_without_changing_state(self):
        self.positions[7] = 0xFFFFFFF6
        self.registers.update({(7, 128): 0xFFFFFFFB, (7, 140): 0xFFFFFFFC, (7, 136): 0xFFFFFFF9,
                               (7, 116): 0xFFFFFF9C, (7, 124): 0xFF9C, (7, 126): 0xFFCE,
                               (7, 144): 119, (7, 123): 0x32})
        self.head._axis_motion[7] = {"until": time.monotonic() + 10, "position": 2048, "duration_ms": 10000}
        state = self.head.snapshot()
        broadcasts, opens = self.packet.broadcastPing.call_count, self.sdk.PortHandler.call_count
        result = self.head.motion_sample()
        self.assertTrue(result["ok"], result)
        sample = result["sample"]
        self.assertTrue(sample["sampled_at"])
        self.assertGreaterEqual(sample["read_duration_ms"], 0)
        self.assertEqual([row["id"] for row in sample["motors"]], [7, 18])
        row = sample["motors"][0]
        self.assertEqual({key: value for key, value in row.items() if key != "sampled_at"},
                         {"id": 7, "model_number": HEAD_MODEL, "present_position": -10, "present_velocity": -5,
                          "position_trajectory": -4, "velocity_trajectory": -7, "goal_position": -100,
                          "present_pwm": -100, "present_load": -50, "input_voltage_v": 11.9, "moving_status": 0x32})
        self.assertEqual(len(self.reads), 20, "One bounded sample reads ten registers on each known axis")
        self.assertEqual(self.packet.broadcastPing.call_count, broadcasts)
        self.assertEqual(self.sdk.PortHandler.call_count, opens)
        self.assertEqual(self.head.snapshot(), state, "Telemetry cannot rewrite cached control/safety state")
        self.positions[7] = 2010
        self.assertEqual(self.head.motion_sample()["sample"]["motors"][0]["present_position"], 2010)
        self.assertEqual(row["present_position"], -10, "Returned samples are independent")

    def test_unverified_closed_or_recording_context_rejects_without_reads_or_open(self):
        opened = self.sdk.PortHandler.call_count
        verified = self.head._verified_connection
        self.head._verified_connection = None
        self.assertFalse(self.head.motion_sample()["ok"])
        self.head._verified_connection = verified
        self.head._calibration["recording"] = True
        self.assertFalse(self.head.motion_sample()["ok"])
        self.head._calibration["recording"] = False
        missing = self.head._motors.pop(18)
        self.assertFalse(self.head.motion_sample()["ok"])
        self.head._motors[18] = missing
        self.head.close()
        self.assertFalse(self.head.motion_sample()["ok"])
        self.assertEqual(self.sdk.PortHandler.call_count, opened)
        self.assertFalse(self.reads)

    def test_read_errors_never_return_a_partial_successful_sample(self):
        for motor_id in (7, 18):
            for address in (0, 132, 128, 140, 136, 116, 124, 126, 144, 123):
                with self.subTest(motor_id=motor_id, address=address):
                    self.failures[(motor_id, address)] = (0, -1, 0)
                    result = self.head.motion_sample()
                    self.assertFalse(result["ok"])
                    self.assertIn(f"register {address}", result["error"])
                    self.assertNotIn("sample", result)
                    self.failures.clear()

    def test_wrong_model_invalidates_verification_without_sampling_that_motor(self):
        self.models[18] = 1060
        result = self.head.motion_sample()
        self.assertFalse(result["ok"])
        self.assertIn("1060", result["error"])
        self.assertNotIn("sample", result)
        self.assertEqual([address for motor_id, address in self.reads if motor_id == 18], [0])
        self.assertIsNone(self.head._verified_connection)

    def test_latched_stop_permits_reads_but_new_stop_interrupts_current_sample(self):
        self.head.request_stop()
        self.assertTrue(self.head.motion_sample()["ok"])
        self.reads.clear()
        def stopped(port, motor_id, address):
            result = self.read(port, motor_id, address)
            self.head.request_stop()
            self.head.reset_stop()
            return result
        self.packet.read2ByteTxRx.side_effect = stopped
        result = self.head.motion_sample()
        self.assertFalse(result["ok"])
        self.assertIn("interrupted", result["error"])
        self.assertNotIn("sample", result)
        self.assertEqual(self.reads, [(7, 0)])

    def test_changed_connection_during_sample_discards_partial_readings(self):
        def changed(port, motor_id, address):
            result = self.read(port, motor_id, address)
            self.head._device = "/dev/cu.usbserial-OTHER"
            return result
        self.packet.read2ByteTxRx.side_effect = changed
        result = self.head.motion_sample()
        self.assertFalse(result["ok"])
        self.assertNotIn("sample", result)
        self.assertEqual(self.reads, [(7, 0)])

    def test_close_interrupts_pending_sample_before_closing_serial_port(self):
        reading, resume, closed = threading.Event(), threading.Event(), threading.Event()
        def delayed(port, motor_id, address):
            result = self.read(port, motor_id, address)
            reading.set()
            self.assertTrue(resume.wait(2))
            return result
        self.packet.read2ByteTxRx.side_effect = delayed
        results = []
        sampling = threading.Thread(target=lambda: results.append(self.head.motion_sample()))
        sampling.start()
        self.assertTrue(reading.wait(2))
        closing = threading.Thread(target=lambda: (self.head.close(), closed.set()))
        closing.start()
        self.assertFalse(closed.wait(.02))
        self.port.closePort.assert_not_called()
        resume.set()
        sampling.join(2)
        closing.join(2)
        self.assertFalse(sampling.is_alive())
        self.assertFalse(closing.is_alive())
        self.assertFalse(results[0]["ok"])
        self.assertNotIn("sample", results[0])
        self.assertIsNone(self.head._port)
        self.assertEqual(self.reads, [(7, 0)])


class HeadPowerTests(FakeSerialTest):
    def setUp(self):
        super().setUp()
        self.torques = {7: 0, 18: 0}
        self.positions = {7: 2000, 18: 2100}
        self.head.check(HEAD_DEVICE, 1000000)
        self.head._saved_calibration = robot_serial._validate_calibration({
            "version": 1, "device": HEAD_DEVICE, "baudrate": 1000000, "model_number": HEAD_MODEL,
            "saved_at": robot_serial._now(), "sample_count": 10,
            "axes": [{"id": i, "label": f"Axis {i}", "min": 1700, "centre": 2048, "max": 2400}
                     for i in (7, 18)],
        })

    def power_on(self):
        result = self.head.torque(True)
        self.assertTrue(result["ok"], result)
        self.writes.clear()
        return result

    def test_resting_head_requires_manual_placement_before_powered_control(self):
        self.positions[7] = 823
        self.head.check()
        for result in (self.head.torque(True), self.head.move(7, 2048, 1000)):
            self.assertFalse(result["ok"])
            self.assertIn("outside", result["error"])
        self.assertEqual(self.writes, [])
        self.assertEqual(self.torques, {7: 0, 18: 0})
        self.positions[7] = 2000  # Simulate the user lifting it by hand.
        self.head.check()
        self.assertTrue(self.head.torque(True)["ok"])
        goals = [(motor_id, value) for motor_id, address, value in self.writes if address == 116]
        self.assertEqual(goals, [(7, 2000), (18, 2100)])
        self.assertNotIn((7, 2048), goals, "Torque-on must hold the manually placed pose")

    def test_preloads_all_current_goals_before_any_torque_enable(self):
        self.registers.update({(7, 116): 0, (18, 116): 4095})
        result = self.power_on()
        # Inspect SDK calls because power_on clears our write log.
        goals = [(call.args[1], call.args[3]) for call in self.packet.write4ByteTxRx.call_args_list if call.args[2] == 116]
        self.assertEqual(goals, [(7, 2000), (18, 2100)])
        self.assertTrue(all(row["torque_enabled"] for row in result["head"]["motors"]))
        self.assertIsNone(result["head"]["last_move"])
        self.packet.write4ByteTxRx.reset_mock()
        self.assertTrue(self.head.torque(True)["ok"])
        self.assertFalse(self.writes)  # Already-on axes are not given new goals.

    def test_preload_order_and_mixed_torque_leave_existing_axis_alone(self):
        self.torques[7] = 1
        self.registers[(7, 116)] = 2050
        self.assertTrue(self.head.torque(True)["ok"])
        self.assertEqual(self.writes, [(18, 112, 1000), (18, 108, 500), (18, 116, 2100), (18, 64, 1)])
        self.assertEqual(self.registers[(7, 116)], 2050)

    def test_both_preloads_complete_before_enable(self):
        self.assertTrue(self.head.torque(True)["ok"])
        self.assertEqual(self.writes, [(7, 112, 1000), (7, 108, 500), (7, 116, 2000),
                                       (18, 112, 1000), (18, 108, 500), (18, 116, 2100),
                                       (7, 64, 1), (18, 64, 1)])

    def test_preload_write_or_readback_failure_never_enables_torque(self):
        for failure in ("write", "read"):
            with self.subTest(failure=failure):
                self.writes.clear()
                self.write_failures.clear()
                self.failures.clear()
                if failure == "write":
                    self.write_failures[(18, 116)] = (0, 4)
                else:
                    original = self.packet.read4ByteTxRx.side_effect
                    def wrong_preload(port, motor_id, address):
                        value = self.read(port, motor_id, address)
                        return (1, 0, 0) if address == 116 and self.writes else value
                    self.packet.read4ByteTxRx.side_effect = wrong_preload
                self.assertFalse(self.head.torque(True)["ok"])
                self.assertFalse(any(address == 64 for _, address, _ in self.writes))
                if failure == "read":
                    self.packet.read4ByteTxRx.side_effect = original

    def test_unmatched_connection_ids_or_model_never_write(self):
        for mutate in (
            lambda: self.head._saved_calibration.update(device="/dev/cu.usbserial-OTHER"),
            lambda: self.head._saved_calibration.update(baudrate=57600),
            lambda: self.head._saved_calibration["axes"][0].update(id=0),
        ):
            saved = json.loads(json.dumps(self.head._saved_calibration))
            mutate()
            self.assertFalse(self.head.torque(True)["ok"])
            self.head._saved_calibration = saved
        self.discovered[18] = [1060, 45]
        self.assertFalse(self.head.torque(True)["ok"])
        self.assertTrue(self.head.emergency_stop()["skipped"])
        self.assertFalse(self.writes)

    def test_partial_torque_enable_failure_reports_on_and_unknown_axes(self):
        self.write_failures[(18, 64)] = (0, 4)
        result = self.head.torque(True)
        self.assertFalse(result["ok"])
        self.assertEqual([row["torque_enabled"] for row in result["head"]["motors"]], [True, None])
        self.assertEqual(self.torques[7], 1)
        self.assertFalse(self.head.calibration_start()["ok"])

    def test_pose_change_during_preload_never_enables_torque(self):
        def shifting(port, motor_id, address, value):
            result = self.write(port, motor_id, address, value)
            if motor_id == 18 and address == 116:
                self.positions[7] += 1
            return result
        self.packet.write4ByteTxRx.side_effect = shifting
        result = self.head.torque(True)
        self.assertFalse(result["ok"])
        self.assertIn("moved during", result["error"])
        self.assertFalse(any(address == 64 for _, address, _ in self.writes))

    def test_lost_goal_ack_keeps_conservative_busy_gate(self):
        self.power_on()
        self.write_failures[(7, 116)] = OSError("Lost acknowledgement")
        result = self.head.move(7, 2050, 1000)
        self.assertFalse(result["ok"])
        self.assertTrue(result["head"]["busy"])
        self.assertTrue(result["head"]["last_move"]["partial"])
        self.assertEqual([target["motor_id"] for target in result["head"]["last_move"]["targets"]], [7])
        self.assertFalse(self.head.move(18, 2150, 1000)["ok"])

    def test_second_axis_pose_is_rechecked_after_first_axis_enables(self):
        def coupled_pose(port, motor_id, address, value):
            result = self.write(port, motor_id, address, value)
            if motor_id == 7 and address == 64 and value == 1:
                self.positions[18] += 1
            return result
        self.packet.write1ByteTxRx.side_effect = coupled_pose
        result = self.head.torque(True)
        self.assertFalse(result["ok"])
        self.assertEqual([row["torque_enabled"] for row in result["head"]["motors"]], [True, False])
        self.assertNotIn((18, 64, 1), self.writes)

    def test_missing_calibration_or_closed_bus_never_open_for_power(self):
        self.head.disconnect()
        opened = self.sdk.PortHandler.call_count
        self.assertFalse(self.head.torque(True)["ok"])
        self.assertTrue(self.head.torque(False)["skipped"])
        self.assertEqual(self.sdk.PortHandler.call_count, opened)
        self.assertFalse(self.writes)

    def test_modes_auto_torque_secondary_ids_homing_and_motion_are_checked(self):
        cases = ((7, 10, 12), (7, 11, 4), (7, 12, 18), (7, 20, 2000),
                 (7, 122, 1), (18, 70, 4))
        for motor_id, address, value in cases:
            with self.subTest(address=address):
                self.registers[(motor_id, address)] = value
                result = self.head.torque(True)
                self.assertFalse(result["ok"], result)
                self.assertFalse(self.writes)
                self.registers.clear()
                self.head.check()

    def test_multiturn_positions_or_calibration_are_not_wrapped_or_clamped(self):
        self.positions[7] = 4096 + 2000
        self.assertFalse(self.head.torque(True)["ok"])
        self.positions[7] = 2000
        self.head.check()
        self.head._saved_calibration["axes"][0].update(min=-50)
        self.assertFalse(self.head.torque(True)["ok"])
        self.assertFalse(self.writes)

    def test_actual_duration_limits_peak_speed_and_replaces_excessive_acceleration(self):
        self.power_on()
        self.registers[(7, 108)] = 9000
        result = self.head.move(7, 2300, 1000)
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.writes, [(7, 112, 4000), (7, 108, 2000), (7, 116, 2300)])
        self.assertEqual(result["head"]["last_move"]["duration_ms"], 4000)
        self.assertEqual(result["head"]["last_move"]["requested_duration_ms"], 1000)
        self.assertTrue(result["head"]["busy"])
        self.assertEqual(result["head"]["motors"][0]["position"], 2000)  # No invented arrival.
        self.writes.clear()
        self.assertFalse(self.head.move(7, 2150, 1000)["ok"])
        self.assertFalse(self.writes)
        with patch.object(robot_serial.time, "monotonic", return_value=self.head._motion_until + .1):
            self.assertFalse(self.head.snapshot()["busy"])
            self.assertTrue(self.head.move(18, 2150, 1000)["ok"])

    def test_batch_stages_both_profiles_before_goals_with_independent_durations(self):
        self.power_on()
        now = [100.0]
        def delayed_ack(port, motor_id, address, value):
            result = self.write(port, motor_id, address, value)
            if address == 116:
                now[0] += .02
            return result
        self.packet.write4ByteTxRx.side_effect = delayed_ack
        with patch.object(robot_serial.time, "monotonic", side_effect=lambda: now[0]):
            result = self.head.moves([{"motor_id": 7, "position": 2300, "duration_ms": 1000},
                                      {"motor_id": 18, "position": 2150, "duration_ms": 1000}])
            self.assertTrue(result["ok"], result)
            self.assertEqual(self.writes, [(7, 112, 4000), (7, 108, 2000), (18, 112, 1000),
                                           (18, 108, 500), (7, 116, 2300), (18, 116, 2150)])
            move = result["head"]["last_move"]
            self.assertEqual(move["duration_ms"], 4000)
            self.assertEqual([target["duration_ms"] for target in move["targets"]], [4000, 1000])
            self.assertEqual([target["requested_duration_ms"] for target in move["targets"]], [1000, 1000])
            self.assertEqual({row["motor_id"] for row in result["head"]["motion"]}, {7, 18})
            now[0] = 101.1
            motion = self.head.snapshot()["motion"]
            self.assertEqual(len(motion), 1)
            self.assertEqual((motion[0]["motor_id"], motion[0]["position"], motion[0]["duration_ms"]), (7, 2300, 4000))
            self.assertGreater(motion[0]["remaining_ms"], 2900)
            now[0] = 104.1
            self.assertEqual(self.head.snapshot()["motion"], [])
            self.assertFalse(self.head.snapshot()["busy"])

    def test_idle_axis_can_start_while_known_peer_moves_but_active_axis_cannot_retarget(self):
        self.power_on()
        with patch.object(robot_serial.time, "monotonic", return_value=100):
            self.assertTrue(self.head.move(7, 2300, 4000)["ok"])
            self.registers[(7, 122)] = 1
            self.writes.clear()
            self.assertFalse(self.head.move(7, 2200, 1000)["ok"])
            self.assertFalse(self.head.torque(True)["ok"])
            with self.assertRaisesRegex(ValueError, "still in progress"):
                self.head.check("/dev/cu.usbserial-OTHER")
            self.assertEqual(self.head.snapshot()["device"], HEAD_DEVICE)
            self.assertFalse(self.writes)
            self.registers[(7, 116)] = 2200
            self.assertFalse(self.head.move(18, 2150, 1000)["ok"], "An externally changed moving goal is not the accepted peer profile")
            self.assertFalse(self.writes)
            self.registers[(7, 116)] = 2300
            result = self.head.move(18, 2150, 1000)
            self.assertTrue(result["ok"], result)
            self.assertEqual(self.writes, [(18, 112, 1000), (18, 108, 500), (18, 116, 2150)])
            self.assertEqual({row["motor_id"] for row in result["head"]["motion"]}, {7, 18})

    def test_unknown_or_expired_peer_motion_and_fresh_peer_fault_block_new_goal(self):
        self.power_on()
        self.registers[(7, 122)] = 1
        self.assertFalse(self.head.move(18, 2150, 1000)["ok"])
        self.assertFalse(self.writes)
        self.registers[(7, 122)] = 0
        with patch.object(robot_serial.time, "monotonic", return_value=100):
            self.assertTrue(self.head.move(7, 2300, 4000)["ok"])
            self.writes.clear()
            self.registers[(7, 70)] = 4
            self.assertFalse(self.head.move(18, 2150, 1000)["ok"])
            self.assertFalse(self.writes)
        self.registers[(7, 70)] = 0
        with patch.object(robot_serial.time, "monotonic", return_value=105):
            self.head.check()
            self.registers[(7, 122)] = 1
            self.assertFalse(self.head.move(18, 2150, 1000)["ok"])
            self.assertFalse(self.writes)

    def test_batch_validates_all_targets_health_and_reference_speed_before_any_write(self):
        self.power_on()
        valid = {"motor_id": 7, "position": 2100, "duration_ms": 1000}
        for targets in ([], [valid, valid], [valid] * 3, [valid, {"motor_id": 18, "position": 2500, "duration_ms": 1000}],
                        [valid, {"motor_id": 18, "position": 2100, "duration_ms": 999}], [valid, None]):
            with self.subTest(targets=targets), self.assertRaises(ValueError):
                self.head.moves(targets)
            self.assertFalse(self.writes)
        self.assertFalse(self.head.moves([valid, {"motor_id": 0, "position": 2100, "duration_ms": 1000}])["ok"])
        self.registers[(18, 140)] = 3000
        result = self.head.moves([valid, {"motor_id": 18, "position": 2100, "duration_ms": 1000}])
        self.assertFalse(result["ok"])
        self.assertIn("more than 10 seconds", result["error"])
        self.assertFalse(self.writes)
        self.registers[(18, 140)] = 2100
        self.registers[(18, 10)] = 12
        self.assertFalse(self.head.moves([valid, {"motor_id": 18, "position": 2100, "duration_ms": 1000}])["ok"])
        self.assertFalse(self.writes)

    def test_profile_staging_failure_never_starts_either_axis(self):
        self.power_on()
        self.write_failures[(18, 108)] = OSError("Lost profile acknowledgement")
        result = self.head.moves([{"motor_id": 7, "position": 2100, "duration_ms": 2000},
                                  {"motor_id": 18, "position": 2200, "duration_ms": 2000}])
        self.assertFalse(result["ok"])
        self.assertFalse(any(address == 116 for _, address, _ in self.writes))
        self.assertFalse(result["head"]["busy"])
        self.assertIsNone(result["head"]["last_move"])

    def test_partial_batch_tracks_attempted_goals_and_blocks_power_until_rechecked(self):
        self.power_on()
        self.write_failures[(18, 116)] = OSError("Lost second goal acknowledgement")
        with patch.object(robot_serial.time, "monotonic", return_value=100):
            result = self.head.moves([{"motor_id": 7, "position": 2100, "duration_ms": 2000},
                                      {"motor_id": 18, "position": 2200, "duration_ms": 3000}])
            self.assertFalse(result["ok"])
            self.assertTrue(result["head"]["last_move"]["partial"])
            self.assertEqual({row["motor_id"] for row in result["head"]["motion"]}, {7, 18})
            self.assertEqual([row["motor_id"] for row in result["head"]["last_move"]["targets"]], [7, 18])
        self.writes.clear()
        with patch.object(robot_serial.time, "monotonic", return_value=102.5):
            self.assertFalse(self.head.move(7, 2050, 1000)["ok"], "Unknown peer ACK blocks an otherwise idle axis")
            self.assertFalse(self.writes)
        self.write_failures.clear()
        with patch.object(robot_serial.time, "monotonic", return_value=104):
            self.registers[(18, 122)] = 1
            self.assertFalse(self.head.move(7, 2050, 1000)["ok"])
            self.assertFalse(self.writes)
            self.registers[(18, 122)] = 0
            self.assertTrue(self.head.move(7, 2050, 1000)["ok"])

    def test_stop_between_batch_goals_records_only_attempted_axis_and_release_clears_all(self):
        self.power_on()
        def stop_after_goal(port, motor_id, address, value):
            result = self.write(port, motor_id, address, value)
            if address == 116:
                self.head.request_stop()
            return result
        self.packet.write4ByteTxRx.side_effect = stop_after_goal
        result = self.head.moves([{"motor_id": 7, "position": 2100, "duration_ms": 2000},
                                  {"motor_id": 18, "position": 2200, "duration_ms": 2000}])
        self.assertFalse(result["ok"])
        self.assertEqual([(motor_id, value) for motor_id, address, value in self.writes if address == 116], [(7, 2100)])
        self.assertEqual([row["motor_id"] for row in result["head"]["motion"]], [7])
        self.assertTrue(result["head"]["last_move"]["partial"])
        self.writes.clear()
        released = self.head.torque(False)
        self.assertTrue(released["ok"])
        self.assertEqual(self.writes, [(7, 64, 0), (18, 64, 0)])
        self.assertEqual(released["head"]["motion"], [])

    def test_stop_during_final_goal_ack_never_reports_a_successful_batch(self):
        self.power_on()
        def stop_after_final_goal(port, motor_id, address, value):
            result = self.write(port, motor_id, address, value)
            if motor_id == 18 and address == 116:
                self.head.request_stop()
            return result
        self.packet.write4ByteTxRx.side_effect = stop_after_final_goal
        result = self.head.moves([{"motor_id": 7, "position": 2100, "duration_ms": 2000},
                                  {"motor_id": 18, "position": 2200, "duration_ms": 2000}])
        self.assertFalse(result["ok"])
        self.assertIn("cancelled", result["error"])
        self.assertTrue(result["head"]["last_move"]["partial"])
        self.assertEqual({row["motor_id"] for row in result["head"]["motion"]}, {7, 18})

    def test_reversal_speed_bound_covers_goal_and_trajectory_when_shaft_lags(self):
        self.power_on()
        self.positions[7] = 2000
        for goal, trajectory in ((2300, 2000), (2000, 2300)):
            with self.subTest(goal=goal, trajectory=trajectory):
                self.registers[(7, 116)] = goal
                self.registers[(7, 140)] = trajectory
                self.writes.clear()
                with patch.object(robot_serial.time, "monotonic", return_value=self.head._motion_until + .1):
                    result = self.head.move(7, 2000, 1000)
                self.assertTrue(result["ok"], result)
                self.assertEqual(self.writes, [(7, 112, 4000), (7, 108, 2000), (7, 116, 2000)])
                self.assertEqual(result["head"]["last_move"]["duration_ms"], 4000)

    def test_reference_travel_beyond_speed_bound_rejects_before_any_write(self):
        self.power_on()
        # Actual pose is near the target, but the internal reference is far away.
        self.positions[7] = 1700
        self.registers[(7, 116)] = 2400
        self.registers[(7, 140)] = 2500
        result = self.head.move(7, 1700, 1000)
        self.assertFalse(result["ok"], result)
        self.assertIn("more than 10 seconds", result["error"])
        self.assertFalse(self.writes)

    def test_successive_moves_refresh_known_axes_without_broadcast_or_reopening(self):
        self.power_on()
        broadcasts, opened = self.packet.broadcastPing.call_count, self.sdk.PortHandler.call_count
        required = {0, 6, 132, 64, 70, 10, 11, 52, 48, 12, 20, 108, 116, 140, 122}
        for motor_id, position in ((7, 2150), (18, 2250)):
            self.reads.clear()
            with patch.object(robot_serial.time, "monotonic", return_value=self.head._motion_until + .1):
                result = self.head.move(motor_id, position, 1000)
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["head"]["last_move"]["duration_ms"], 2000)
            for axis_id in (7, 18):
                self.assertTrue(required.issubset({address for read_id, address in self.reads if read_id == axis_id}))
            self.positions[motor_id] = position
        self.assertEqual(self.packet.broadcastPing.call_count, broadcasts)
        self.assertEqual(self.sdk.PortHandler.call_count, opened)
        self.assertEqual({motor_id for motor_id, _ in self.reads}, {7, 18})
        self.head.check()
        self.assertEqual(self.packet.broadcastPing.call_count, broadcasts + 1, "Explicit identification still discovers the complete bus")

    def test_move_identity_firmware_or_missing_response_prevents_all_writes(self):
        self.power_on()
        self.models[18] = 1060
        result = self.head.move(7, 2100, 1000)
        self.assertFalse(result["ok"])
        self.assertIn("1060", result["error"])
        self.assertIsNone(self.head._verified_connection)
        self.assertFalse(self.writes)
        self.models.clear()
        self.head.check()
        self.registers[(18, 6)] = 41
        self.assertFalse(self.head.move(7, 2100, 1000)["ok"])
        self.assertFalse(self.writes)
        del self.registers[(18, 6)]
        self.head.check()
        self.failures[(18, 0)] = (0, -1, 0)
        result = self.head.move(7, 2100, 1000)
        self.assertFalse(result["ok"])
        self.assertIn("identity read failed", result["error"])
        self.assertFalse(self.writes)

    def test_move_read_failures_fail_closed_without_any_writes(self):
        self.power_on()
        for address in (0, 6, 132, 64, 70, 10, 11, 52, 48, 12, 20, 108, 116, 140, 122, 80, 124, 144):
            with self.subTest(address=address):
                self.failures[(18, address)] = (0, -1, 0)
                self.assertFalse(self.head.move(7, 2100, 1000)["ok"])
                self.assertFalse(self.writes)
                self.failures.clear()
                self.head.check()

    def test_move_retains_all_power_setting_gates(self):
        self.power_on()
        for address, value in ((10, 12), (11, 4), (12, 18), (20, 2000), (122, 1),
                               (70, 4), (52, 1800), (48, 2300), (64, 0), (116, 4095)):
            with self.subTest(address=address):
                previous = self.registers.get((18, address))
                self.registers[(18, address)] = value
                self.assertFalse(self.head.move(7, 2100, 1000)["ok"])
                self.assertFalse(self.writes)
                if previous is None:
                    del self.registers[(18, address)]
                else:
                    self.registers[(18, address)] = previous
                self.head.check()

    def test_move_requires_unchanged_verified_bus_and_complete_axis_set(self):
        self.power_on()
        verified = self.head._verified_connection
        self.head._verified_connection = (HEAD_DEVICE, 57600, (7, 18))
        self.assertFalse(self.head.move(7, 2100, 1000)["ok"])
        self.head._verified_connection = verified
        missing = self.head._motors.pop(18)
        self.assertFalse(self.head.move(7, 2100, 1000)["ok"])
        self.head._motors[18] = missing
        self.head.disconnect()
        opened = self.sdk.PortHandler.call_count
        self.assertFalse(self.head.move(7, 2100, 1000)["ok"])
        self.assertEqual(self.sdk.PortHandler.call_count, opened)
        self.assertFalse(self.writes)

    def test_changed_connection_during_targeted_reads_prevents_writes(self):
        self.power_on()
        def changed(port, motor_id, address):
            result = self.read(port, motor_id, address)
            if address == 0:
                self.head._device = "/dev/cu.usbserial-OTHER"
            return result
        self.packet.read2ByteTxRx.side_effect = changed
        result = self.head.move(7, 2100, 1000)
        self.assertFalse(result["ok"])
        self.assertIn("connection changed", result["error"])
        self.assertFalse(self.writes)

    def test_stop_reset_during_targeted_read_cannot_revive_move(self):
        self.power_on()
        entered, resume = threading.Event(), threading.Event()
        def delayed(port, motor_id, address):
            result = self.read(port, motor_id, address)
            if address == 0:
                entered.set()
                self.assertTrue(resume.wait(2))
            return result
        self.packet.read2ByteTxRx.side_effect = delayed
        results = []
        thread = threading.Thread(target=lambda: results.append(self.head.move(7, 2100, 1000)))
        thread.start()
        self.assertTrue(entered.wait(2))
        self.head.request_stop()
        self.head.reset_stop()
        resume.set()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertFalse(results[0]["ok"])
        self.assertIn("cancelled", results[0]["error"])
        self.assertFalse(self.writes)
        self.assertIsNone(self.head.snapshot()["last_move"])

    def test_head_diagnostics_read_actual_gains_signed_load_and_voltage_without_writes(self):
        self.registers.update({(7, 80): 1800, (7, 82): 12, (7, 84): 700, (7, 36): 800,
                               (7, 100): 790, (7, 124): 0xFF9C, (7, 126): 0xFFCE,
                               (7, 144): 119, (7, 146): 35})
        state = self.head.check()
        diagnostic = state["motors"][0]["diagnostics"]
        self.assertEqual({key: value for key, value in diagnostic.items() if key != "sampled_at"},
                         {"position_d_gain": 1800, "position_i_gain": 12, "position_p_gain": 700,
                          "pwm_limit": 800, "goal_pwm": 790, "present_pwm": -100, "present_load": -50,
                          "input_voltage_v": 11.9, "temperature_c": 35})
        self.assertTrue(diagnostic["sampled_at"])
        self.assertFalse(self.writes)
        self.power_on()
        self.registers[(7, 124)] = 24
        result = self.head.move(7, 2100, 1000)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["head"]["motors"][0]["diagnostics"]["present_pwm"], 24)
        self.assertEqual({address for _, address, _ in self.writes}, {108, 112, 116}, "Diagnostics never tune PID gains or PWM")

    def test_outside_target_and_invalid_duration_reject_before_writes(self):
        self.power_on()
        for position, duration in ((1699, 1000), (2401, 1000), (2000, 999), (2000, 10001),
                                   (True, 1000), (2000, "1000")):
            with self.assertRaises(ValueError):
                self.head.move(7, position, duration)
        self.assertFalse(self.head.move(0, 2000, 1000)["ok"])
        self.assertFalse(self.writes)

    def test_move_requires_torque_and_entire_current_head_inside_ranges(self):
        self.assertFalse(self.head.move(7, 2100, 1000)["ok"])
        self.power_on()
        self.positions[18] = 2401
        self.assertFalse(self.head.move(7, 2100, 1000)["ok"])
        self.assertFalse(self.writes)

    def test_distance_requiring_over_ten_seconds_rejects_without_motion(self):
        self.power_on()
        self.head._saved_calibration["axes"][0].update(min=1000, max=3500)
        self.assertFalse(self.head.move(7, 3000, 1000)["ok"])
        self.assertFalse(self.writes)

    def test_manual_recorder_blocks_every_powered_operation_without_writes(self):
        self.assertTrue(self.head.calibration_start()["ok"])
        self.assertFalse(self.head.torque(True)["ok"])
        self.assertFalse(self.head.torque(False)["ok"])
        self.assertFalse(self.head.move(7, 2100, 1000)["ok"])
        self.assertFalse(self.writes)
        self.head.calibration_stop()

    def test_emergency_uses_only_verified_ids_without_reads_and_attempts_all(self):
        self.power_on()
        self.write_failures[(7, 64)] = OSError("Lost motor")
        reads = list(self.reads)
        result = self.head.emergency_stop()
        self.assertFalse(result["ok"])
        self.assertEqual(self.writes, [(7, 64, 0), (18, 64, 0)])
        self.assertEqual(self.reads, reads)
        self.assertIsNone(result["head"]["motors"][0]["torque_enabled"])
        self.writes.clear()
        self.assertFalse(self.head.torque(True)["ok"])
        self.head.reset_stop()
        self.assertFalse(self.writes)

    def test_release_remains_available_after_partial_read_fault(self):
        self.power_on()
        self.failures[(7, 132)] = (0, -1, 0)
        self.head.check()
        reads = list(self.reads)
        self.assertTrue(self.head.torque(False)["ok"])
        self.assertEqual(self.writes, [(7, 64, 0), (18, 64, 0)])
        self.assertEqual(self.reads, reads)

    def test_emergency_stops_recorder_before_release_writes(self):
        self.assertTrue(self.head.calibration_start()["ok"])
        original = self.packet.write1ByteTxRx.side_effect
        def stopped_recorder(port, motor_id, address, value):
            self.assertFalse(self.head._calibration["recording"])
            return original(port, motor_id, address, value)
        self.packet.write1ByteTxRx.side_effect = stopped_recorder
        self.assertTrue(self.head.emergency_stop()["ok"])
        self.assertEqual(self.writes, [(7, 64, 0), (18, 64, 0)])

    def test_stop_and_reset_between_writes_do_not_revive_old_move(self):
        self.power_on()
        entered, resume = threading.Event(), threading.Event()
        def delayed(port, motor_id, address, value):
            result = self.write(port, motor_id, address, value)
            entered.set()
            self.assertTrue(resume.wait(2))
            return result
        self.packet.write4ByteTxRx.side_effect = delayed
        results = []
        thread = threading.Thread(target=lambda: results.append(self.head.move(7, 2050, 1000)))
        thread.start()
        self.assertTrue(entered.wait(2))
        self.head.request_stop()  # Must not wait for the writer's lock.
        self.head.reset_stop()
        resume.set()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertFalse(results[0]["ok"])
        self.assertEqual(self.writes, [(7, 112, 1000)])
        self.assertIsNone(self.head.snapshot()["last_move"])

    def test_stop_during_preload_prevents_every_torque_enable(self):
        def stop_after_goal(port, motor_id, address, value):
            result = self.write(port, motor_id, address, value)
            if address == 116:
                self.head.request_stop()
            return result
        self.packet.write4ByteTxRx.side_effect = stop_after_goal
        self.assertFalse(self.head.torque(True)["ok"])
        self.assertFalse(any(address == 64 for _, address, _ in self.writes))


class DrumControllerTests(FakeSerialTest):
    REST_POSITIONS = {0: 2200, 1: 1850, 2: 2300, 3: 2600}

    def setUp(self):
        super().setUp()
        self.io = []
        self.simulate_arrival = False

    def read(self, port, motor_id, address):
        self.io.append(("read", motor_id, address))
        return super().read(port, motor_id, address)

    def write(self, port, motor_id, address, value):
        self.io.append(("write", motor_id, address, value))
        result = super().write(port, motor_id, address, value)
        if result == (0, 0) and self.simulate_arrival:
            if address == 116 and self.torques.get(motor_id, 1) == 1:
                self.positions[motor_id] = value
            elif address == 64 and value == 1:
                self.positions[motor_id] = self.registers.get((motor_id, 116), 2048)
        return result

    def enable_torque(self, *, arrive=True, during_wait=None):
        """Advance only the torque preparation clock; no real motors or sleeps."""
        self.simulate_arrival = arrive
        elapsed = [100.0]

        def wait(timeout=None):
            elapsed[0] += timeout or 0.1
            if during_wait:
                during_wait()
            return self.drums._stop_requested.is_set()

        with patch.object(robot_serial.time, "monotonic", side_effect=lambda: elapsed[0]), \
                patch.object(self.drums._stop_requested, "wait", side_effect=wait):
            return self.drums.torque(True)

    def assert_rest_preloaded_before_torque(self):
        first_enable = next(index for index, event in enumerate(self.io)
                            if event[:1] == ("write",) and event[2:] == (64, 1))
        before = self.io[:first_enable]
        for motor_id, rest in self.REST_POSITIONS.items():
            for address, value in ((112, 2000), (116, rest)):
                self.assertIn(("write", motor_id, address, value), before)
                write_index = before.index(("write", motor_id, address, value))
                self.assertIn(("read", motor_id, address), before[write_index + 1:])
        self.assertEqual([event for event in self.writes if event[1] == 116],
                         [(motor_id, 116, rest) for motor_id, rest in self.REST_POSITIONS.items()])
        self.assertFalse(any(address == 108 for _, address, _ in self.writes),
                         "Preparing rest must preserve the acceleration used by existing hit profiles")

    def test_initial_snapshot_prefers_existing_adapter_without_io(self):
        state = self.drums.snapshot()
        self.assertEqual(state["device"], DRUM_PREFERRED_DEVICE)
        self.assertEqual(state["baudrate"], 1_000_000)
        self.assertFalse(state["port_open"])
        self.assertEqual([row["id"] for row in state["motors"]], list(DRUM_IDS))
        self.mocks["_ports"].return_value = []
        self.preferred_connection.side_effect = None
        self.preferred_connection.return_value = {"state": "missing", "device": None, "baudrate": 1_000_000}
        other = DrumController()
        self.addCleanup(other.close)
        self.assertIsNone(other.snapshot()["device"])
        self.sdk.PortHandler.assert_not_called()
        self.assertEqual(self.writes, [])

    def test_check_reads_only_four_drums_without_writes(self):
        state = self.drums.check()
        self.assertEqual(state["state"], "ready")
        self.assertTrue(state["port_open"])
        self.assertEqual({motor_id for motor_id, _ in self.reads}, set(DRUM_IDS))
        self.packet.broadcastPing.assert_not_called()
        self.assertEqual(self.writes, [])

    def test_movement_requires_successful_check(self):
        result = self.drums.move([(0, 2200, 150)])
        self.assertFalse(result["ok"])
        self.sdk.PortHandler.assert_not_called()
        self.assertEqual(self.writes, [])

    def test_invalid_targets_never_access_hardware(self):
        cases = [None, [], [(4, 2200, 150)], [(True, 2200, 150)], [(0, 2100.5, 150)],
                 [(0, 2200, 99)], [(0, 2200, 5001)], [(0, 2200, 150), (0, 2200, 150)], [(0, 2200)]]
        for motor_id, (minimum, maximum) in DRUM_BOUNDS.items():
            cases.extend([[(motor_id, minimum - 1, 150)], [(motor_id, maximum + 1, 150)]])
        for targets in cases:
            with self.subTest(targets=targets), self.assertRaises(ValueError):
                self.drums.move(targets)
        self.sdk.PortHandler.assert_not_called()
        self.assertEqual(self.writes, [])

    def test_bounded_moves_acknowledge_profile_then_goal_for_selected_drums(self):
        self.drums.check()
        targets = [(motor_id, bounds[0], 100) for motor_id, bounds in DRUM_BOUNDS.items()]
        result = self.drums.move(targets)
        self.assertTrue(result["ok"])
        self.assertIn("Target arrival has not been measured", result["message"])
        self.assertEqual(self.writes, [item for motor_id, position, duration in targets
                                       for item in ((motor_id, 112, duration), (motor_id, 116, position))])
        self.writes.clear()
        targets = [(motor_id, bounds[1], 5000) for motor_id, bounds in DRUM_BOUNDS.items()]
        self.assertTrue(self.drums.move(targets)["ok"])
        self.assertEqual({motor_id for motor_id, _, _ in self.writes}, set(DRUM_IDS))

    def test_fresh_connection_failure_cancels_entire_movement(self):
        self.drums.check()
        self.failures[(3, 132)] = (0, -3001, 0)
        result = self.drums.move([(0, 2200, 150)])
        self.assertFalse(result["ok"])
        self.assertEqual(result["drums"]["state"], "partial")
        self.assertEqual(self.writes, [])

    def test_velocity_profile_wrong_mode_or_torque_off_prevent_movement(self):
        for values, override in ((self.profiles, 0), (self.modes, 1), (self.torques, 0)):
            with self.subTest(override=override):
                values[0] = override
                self.drums.check()
                self.assertFalse(self.drums.move([(0, 2200, 150)])["ok"])
                values.clear()
        self.assertEqual(self.writes, [])

    def test_write_failure_stops_remaining_targets_and_reports_uncertainty(self):
        self.drums.check()
        self.write_failures[(0, 116)] = (0, 4)
        result = self.drums.move([(0, 2200, 150), (1, 2000, 150)])
        self.assertFalse(result["ok"])
        self.assertEqual(result["drums"]["code"], "write_failed")
        self.assertIn("may have taken effect", result["message"])
        self.assertEqual(self.writes, [(0, 112, 150), (0, 116, 2200)])

    def test_torque_moves_only_four_drums_to_verified_rest_before_success(self):
        result = self.enable_torque()
        self.assertTrue(result["ok"], result)
        self.assert_rest_preloaded_before_torque()
        self.assertEqual({motor_id for motor_id, _, _ in self.writes}, set(DRUM_IDS))
        self.assertEqual([(row["id"], row["position"]) for row in result["drums"]["motors"]],
                         list(self.REST_POSITIONS.items()))
        self.assertTrue(all(row["torque_enabled"] is True for row in result["drums"]["motors"]))
        self.writes.clear()
        result = self.drums.torque(False)
        self.assertTrue(result["ok"])
        self.assertTrue(all(row["torque_enabled"] is False for row in result["drums"]["motors"]))
        self.assertEqual(self.writes, [(motor_id, 64, 0) for motor_id in DRUM_IDS])

    def test_torque_enable_rejects_non_position_mode_before_writes(self):
        self.modes[2] = 1
        result = self.drums.torque(True)
        self.assertFalse(result["ok"])
        self.assertEqual(result["drums"]["code"], "operating_mode_incompatible")
        self.assertEqual(self.writes, [])

    def test_torque_enable_stops_on_failure_but_release_attempts_every_motor(self):
        self.write_failures[(1, 64)] = (-3001, 0)
        enabled = self.enable_torque()
        self.assertFalse(enabled["ok"])
        self.assert_rest_preloaded_before_torque()
        self.assertEqual([event for event in self.writes if event[1] == 64], [(0, 64, 1), (1, 64, 1)])
        self.assertIsNone(enabled["drums"]["motors"][1]["torque_enabled"])
        self.writes.clear()
        released = self.drums.torque(False)
        self.assertFalse(released["ok"])
        self.assertEqual(self.writes, [(motor_id, 64, 0) for motor_id in DRUM_IDS])

    def test_torque_from_outside_drumming_ranges_replaces_old_goals_before_enable(self):
        self.positions.update({0: 2099, 1: 2126, 2: 2069, 3: 2613})
        self.torques.update(dict.fromkeys(DRUM_IDS, 0))
        self.registers.update({(motor_id, 116): 4000 for motor_id in DRUM_IDS})
        self.registers.update({(motor_id, 108): 30 for motor_id in DRUM_IDS})
        result = self.enable_torque()
        self.assertTrue(result["ok"], result)
        self.assert_rest_preloaded_before_torque()
        self.assertEqual(self.positions, self.REST_POSITIONS)
        self.assertFalse(any(address == 116 and value == 4000 for _, address, value in self.writes))
        self.assertEqual([self.registers[(motor_id, 108)] for motor_id in DRUM_IDS], [30] * 4)

    def test_torque_can_prepare_extended_position_mode_from_far_outside_playing_ranges(self):
        self.positions.update({0: -1000, 1: 9000, 2: -4000, 3: 12000})
        self.modes.update(dict.fromkeys(DRUM_IDS, 4))
        self.torques.update(dict.fromkeys(DRUM_IDS, 0))
        result = self.enable_torque()
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.positions, self.REST_POSITIONS)

    def test_torque_preparation_rejects_velocity_profile_auto_enable_or_fault_before_writes(self):
        cases = ((self.profiles, 2, 0), (self.profiles, 2, 12), (self.registers, (2, 70), 4))
        for mapping, key, value in cases:
            with self.subTest(value=value):
                mapping[key] = value
                result = self.enable_torque()
                self.assertFalse(result["ok"], result)
                self.assertEqual(self.writes, [])
                mapping.pop(key)

    def test_torque_preparation_rejects_rest_outside_device_limits_before_writes(self):
        self.registers[(3, 48)] = 2500
        result = self.enable_torque()
        self.assertFalse(result["ok"], result)
        self.assertEqual(self.writes, [])

    def test_torque_preparation_profile_or_goal_mismatch_prevents_every_enable(self):
        for register in (112, 116):
            with self.subTest(register=register):
                self.writes.clear()
                self.io.clear()
                self.torques.update(dict.fromkeys(DRUM_IDS, 0))

                def mismatched_read(port, motor_id, address):
                    value, communication, packet_error = self.read(port, motor_id, address)
                    if motor_id == 3 and address == register and (motor_id, address) in self.registers:
                        return value + 1, communication, packet_error
                    return value, communication, packet_error

                self.packet.read4ByteTxRx.side_effect = mismatched_read
                result = self.enable_torque()
                self.assertFalse(result["ok"], result)
                self.assertFalse(any(address == 64 for _, address, _ in self.writes))
        self.packet.read4ByteTxRx.side_effect = self.read

    def test_torque_preparation_read_failure_prevents_every_enable(self):
        self.torques.update(dict.fromkeys(DRUM_IDS, 0))
        self.failures[(2, 116)] = (0, -3001, 0)
        result = self.enable_torque()
        self.assertFalse(result["ok"], result)
        self.assertFalse(any(address == 64 for _, address, _ in self.writes))

    def test_torque_preparation_timeout_never_claims_rest_arrival(self):
        self.positions.update({0: 2099, 1: 2126, 2: 2069, 3: 2613})
        result = self.enable_torque(arrive=False)
        self.assertFalse(result["ok"], result)
        self.assert_rest_preloaded_before_torque()
        self.assertNotEqual({row["id"]: row["position"] for row in result["drums"]["motors"]},
                            self.REST_POSITIONS)

    def test_torque_preparation_accepts_20_tick_arrival_error_but_rejects_21(self):
        for offset, accepted in ((20, True), (21, False)):
            with self.subTest(offset=offset):
                self.positions.update(self.REST_POSITIONS)
                self.positions[0] += offset
                result = self.enable_torque(arrive=False)
                self.assertEqual(result["ok"], accepted, result)

    def test_rest_tolerance_never_accepts_position_outside_playing_limits(self):
        self.positions.update(self.REST_POSITIONS)
        self.positions[3] += 1
        result = self.enable_torque(arrive=False)
        self.assertFalse(result["ok"], result)

    def test_torque_preparation_requires_stationary_motors_even_when_at_rest(self):
        self.registers[(3, 122)] = 1
        result = self.enable_torque()
        self.assertFalse(result["ok"], result)

    def test_torque_preparation_detects_torque_loss_after_enable(self):
        def lose_torque(*args):
            result = self.write(*args)
            if args[1:] == (3, 64, 1):
                self.torques[0] = 0
            return result

        self.packet.write1ByteTxRx.side_effect = lose_torque
        result = self.enable_torque()
        self.assertFalse(result["ok"], result)
        self.assertFalse(result["drums"]["motors"][0]["torque_enabled"])

    def test_torque_preparation_read_failure_after_enable_never_reports_success(self):
        def lose_readback(*args):
            result = self.write(*args)
            if args[1:] == (3, 64, 1):
                self.failures[(2, 132)] = (0, -3001, 0)
            return result

        self.packet.write1ByteTxRx.side_effect = lose_readback
        result = self.enable_torque()
        self.assertFalse(result["ok"], result)
        self.assertIn("Communication error", result["error"])

    def test_stop_during_preload_prevents_torque_enable(self):
        def stop_after_profile(*args):
            result = self.write(*args)
            self.drums.request_stop()
            return result

        self.packet.write4ByteTxRx.side_effect = stop_after_profile
        result = self.enable_torque()
        self.assertFalse(result["ok"], result)
        self.assertEqual(len(self.writes), 1)
        self.assertFalse(any(address == 64 for _, address, _ in self.writes))

    def test_stop_during_enable_prevents_remaining_torque_writes(self):
        def stop_after_torque(*args):
            result = self.write(*args)
            self.drums.request_stop()
            return result

        self.packet.write1ByteTxRx.side_effect = stop_after_torque
        result = self.enable_torque()
        self.assertFalse(result["ok"], result)
        self.assertEqual([event for event in self.writes if event[1] == 64], [(0, 64, 1)])

    def test_stop_during_rest_wait_never_reports_success_or_sends_more_goals(self):
        result = self.enable_torque(arrive=False, during_wait=self.drums.request_stop)
        self.assertFalse(result["ok"], result)
        self.assertEqual([event for event in self.writes if event[1] == 116],
                         [(motor_id, 116, rest) for motor_id, rest in self.REST_POSITIONS.items()])
        self.assertTrue(self.drums._stop_requested.is_set())

    def test_stop_then_reset_during_rest_wait_does_not_revive_old_preparation(self):
        def stop_and_reset():
            self.drums.request_stop()
            self.drums.reset_stop()

        result = self.enable_torque(arrive=False, during_wait=stop_and_reset)
        self.assertFalse(result["ok"], result)
        self.assertFalse(self.drums._stop_requested.is_set())
        self.assertEqual([event for event in self.writes if event[1] == 116],
                         [(motor_id, 116, rest) for motor_id, rest in self.REST_POSITIONS.items()])

    def test_torque_release_does_not_write_to_unverified_or_changed_bus(self):
        # A head might share IDs 0 and 1; requiring all four drum replies avoids
        # sending a release to those two axes on an incorrectly selected port.
        self.failures = {(motor_id, 132): (0, -3001, 0) for motor_id in (2, 3)}
        self.assertFalse(self.drums.torque(False)["ok"])
        self.assertEqual(self.writes, [])
        self.failures.clear()
        self.drums.check()
        self.failures[(2, 132)] = (0, -3001, 0)
        self.assertEqual(self.drums.check(HEAD_DEVICE)["state"], "partial")
        self.assertFalse(self.drums.torque(False)["ok"])
        self.assertEqual(self.writes, [])

    def test_no_responses_close_port_and_release_open_failure_is_reported(self):
        self.failures = {(motor_id, 132): (0, -3001, 0) for motor_id in DRUM_IDS}
        state = self.drums.check()
        self.assertEqual(state["code"], "motors_unreachable")
        self.assertFalse(state["port_open"])
        self.port.openPort.return_value = False
        self.assertFalse(self.drums.torque(False)["ok"])
        self.assertEqual(self.writes, [])

    def test_disconnect_close_and_invalid_torque_do_not_write(self):
        self.drums.check()
        for enabled in (0, 1, "on", None):
            with self.subTest(enabled=enabled), self.assertRaises(ValueError):
                self.drums.torque(enabled)
        state = self.drums.disconnect()
        self.assertFalse(state["port_open"])
        self.drums.close()
        self.assertEqual(self.drums.check()["code"], "closed")
        self.assertEqual(self.writes, [])


class DrumStrikeTests(FakeSerialTest):
    def setUp(self):
        super().setUp()
        self.positions = {0: 2207, 1: 2003, 2: 2222, 3: 2501}

    def write(self, port, motor_id, address, value):
        result = super().write(port, motor_id, address, value)
        if result == (0, 0) and address == 116:
            self.positions[motor_id] = value
        return result

    def wait_until(self, predicate):
        deadline = time.monotonic() + 2
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail("Timed out waiting for the mocked strike worker")
            threading.Event().wait(.005)

    def start(self, motor_id=0, position=2370, duration=100, return_duration=100,
              rest_position=2200, prepare_duration=100):
        self.assertEqual(self.drums.check()["state"], "ready")
        result = self.drums.strike(motor_id, position, duration, return_duration,
                                   rest_position=rest_position, prepare_duration_ms=prepare_duration)
        self.assertTrue(result["ok"], result)
        return result

    def test_cycle_prepares_fixed_rest_then_hits_and_returns_to_same_rest(self):
        self.drums.check()
        self.positions[0] = 2241  # Changed after the connection check.

        initial_reads = len(self.reads)
        result = self.drums.strike(0, 2370, 100, 150, rest_position=2200)
        self.assertTrue(result["ok"])
        self.assertTrue(result["drums"]["busy"])
        self.assertEqual(result["drums"]["strike"]["origin"], 2241)
        self.assertEqual(result["drums"]["strike"]["rest_position"], 2200)
        self.assertEqual(result["drums"]["strike"]["state"], "preparing")
        outbound_reads = len(self.reads)
        self.wait_until(lambda: not self.drums.snapshot()["busy"])
        state = self.drums.snapshot()
        self.assertEqual(state["strike"]["state"], "complete")
        self.assertIsNotNone(state["strike"]["finished_at"])
        self.assertEqual(self.writes, [(0, 112, 500), (0, 116, 2200),
                                       (0, 112, 100), (0, 116, 2370), (0, 112, 150), (0, 116, 2200)])
        self.assertEqual(state["motors"][0]["position"], 2200)
        self.assertGreater(len(self.reads), initial_reads + 20)
        self.assertEqual({motor_id for motor_id, _ in self.reads[outbound_reads:]}, {0})
        self.assertEqual(len(self.reads[outbound_reads:]), 15)
        self.assertFalse(any(address == 64 for _, address, _ in self.writes))

    def test_invalid_strike_parameters_never_open_or_write(self):
        for args in ((4, 2370, 100), (0, 2451, 100), (0, 2370, 99), (0, 2370, 100, 99),
                     (True, 2370, 100), (0, 2370.5, 100)):
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.drums.strike(*args, rest_position=2200)
        for kwargs in ({"rest_position": 2099}, {"rest_position": 2451},
                       {"rest_position": 2200, "prepare_duration_ms": 99},
                       {"rest_position": 2200, "prepare_duration_ms": 5001}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.drums.strike(0, 2370, 100, **kwargs)
        with self.assertRaises(TypeError):
            self.drums.strike(0, 2370, 100)
        self.assertFalse(self.drums.strike(0, 2370, 100, rest_position=2200)["ok"])
        self.sdk.PortHandler.assert_not_called()
        self.assertEqual(self.writes, [])

    def test_initial_raised_rest_must_be_verified_within_20_ticks_before_hit(self):
        for offset in (20, 21):
            with self.subTest(offset=offset):
                self.writes.clear()
                self.positions[0] = 2241
                goals = 0

                def imperfect_preparation(*args):
                    nonlocal goals
                    result = self.write(*args)
                    if args[2] == 116:
                        goals += 1
                        if goals == 1:
                            self.positions[args[1]] = args[3] + offset
                    return result

                self.packet.write4ByteTxRx.side_effect = imperfect_preparation
                self.start()
                self.wait_until(lambda: not self.drums.snapshot()["busy"])
                strike = self.drums.snapshot()["strike"]
                targets = [value for _, address, value in self.writes if address == 116]
                if offset == 20:
                    self.assertEqual(strike["state"], "complete")
                    self.assertEqual(targets, [2200, 2370, 2200])
                else:
                    self.assertEqual(strike["state"], "error")
                    self.assertIn("No hit was sent", strike["error"])
                    self.assertIn("2221", strike["error"])
                    self.assertEqual(targets, [2200], "failed preparation must not hit or retry")

    def test_fixed_rest_is_reused_across_cycles_despite_measured_endpoint_error(self):
        goals = 0

        def imperfect_return(*args):
            nonlocal goals
            result = self.write(*args)
            if args[2] == 116:
                goals += 1
                if goals % 3 == 0:
                    self.positions[args[1]] = args[3] + 7
            return result

        self.packet.write4ByteTxRx.side_effect = imperfect_return
        self.positions[0] = 2241
        origins = []
        for _ in range(2):
            origins.append(self.start()["drums"]["strike"]["origin"])
            self.wait_until(lambda: not self.drums.snapshot()["busy"])
            self.assertEqual(self.drums.snapshot()["strike"]["state"], "complete")
            self.assertEqual(self.drums.snapshot()["motors"][0]["position"], 2207)
        self.assertEqual(origins, [2241, 2207], "measured origins are diagnostics only")
        self.assertEqual([value for _, address, value in self.writes if address == 116],
                         [2200, 2370, 2200, 2200, 2370, 2200], "return goals must not drift with read-back error")

    def test_stop_during_preparation_profile_sends_neither_preparation_goal_nor_hit(self):
        self.drums.check()

        def stop_after_profile(*args):
            result = self.write(*args)
            self.drums.request_stop()
            return result

        self.packet.write4ByteTxRx.side_effect = stop_after_profile
        result = self.drums.strike(0, 2370, 100, rest_position=2200)
        self.assertFalse(result["ok"])
        self.assertEqual(result["drums"]["strike"]["state"], "cancelled")
        self.assertEqual(self.writes, [(0, 112, 500)])

    def test_torque_change_after_preparation_is_checked_before_hit(self):
        with self.drums._lock:
            self.start()
            self.torques[0] = 0
        self.wait_until(lambda: not self.drums.snapshot()["busy"])
        state = self.drums.snapshot()["strike"]
        self.assertEqual(state["state"], "error")
        self.assertIn("torque is off", state["error"])
        self.assertEqual(self.writes, [(0, 112, 100), (0, 116, 2200)])

    def test_out_of_bounds_measured_origins_are_never_clamped_or_commanded(self):
        for motor_id, origin in ((0, 2099), (1, 2126), (2, 2069), (3, 2613)):
            with self.subTest(motor_id=motor_id):
                self.positions[motor_id] = origin
                self.drums.check()
                result = self.drums.strike(motor_id, DRUM_BOUNDS[motor_id][0], 100,
                                           rest_position=DRUM_BOUNDS[motor_id][1])
                self.assertFalse(result["ok"])
                self.assertIn(str(origin), result["error"])
                self.assertEqual(result["drums"]["strike"]["state"], "error")
                self.assertFalse(result["drums"]["busy"])
        self.assertEqual(self.writes, [])

    def test_strike_requires_fresh_torque_on_and_compatible_mode(self):
        for values, override in ((self.torques, 0), (self.profiles, 0), (self.modes, 1)):
            with self.subTest(override=override):
                self.drums.check()
                values[0] = override
                self.assertFalse(self.drums.strike(0, 2370, 100, rest_position=2200)["ok"])
                values.clear()
        self.assertEqual(self.writes, [])

    def test_busy_strikes_reject_manual_moves_torque_on_and_second_strike_without_queue(self):
        self.start(duration=5000)
        before = list(self.writes)
        self.assertFalse(self.drums.strike(1, 2000, 100, rest_position=1850)["ok"])
        self.assertFalse(self.drums.move([(1, 2000, 100)])["ok"])
        self.assertFalse(self.drums.torque(True)["ok"])
        self.assertEqual(self.writes, before)
        self.drums.request_stop()
        self.drums._strike_thread.join(timeout=1)
        self.assertFalse(self.drums.snapshot()["busy"])
        self.assertEqual(self.writes, before)

    def test_emergency_cancels_wait_and_releases_verified_drums_without_reads(self):
        self.start(duration=5000)
        before_reads = len(self.reads)
        self.write_failures[(1, 64)] = (-3001, 0)
        result = self.drums.emergency_stop()
        self.assertFalse(result["ok"])
        self.drums._strike_thread.join(timeout=1)
        self.assertEqual(len(self.reads), before_reads)
        self.assertEqual(self.writes, [(0, 112, 100), (0, 116, 2200)] + [(motor_id, 64, 0) for motor_id in DRUM_IDS])
        self.assertEqual(self.drums.snapshot()["strike"]["state"], "cancelled")
        self.assertFalse(self.drums.strike(0, 2370, 100, rest_position=2200)["ok"])

    def test_unverified_emergency_does_not_open_probe_or_change_head_overlap_ids(self):
        result = self.drums.emergency_stop()
        self.assertTrue(result["skipped"])
        self.sdk.PortHandler.assert_not_called()
        self.assertEqual(self.reads, [])
        self.assertEqual(self.writes, [])
        self.drums.reset_stop()
        self.drums.check()
        self.failures = {(motor_id, 132): (0, -3001, 0) for motor_id in (2, 3)}
        self.drums.check(HEAD_DEVICE)
        before = list(self.reads)
        self.assertTrue(self.drums.emergency_stop()["skipped"])
        self.assertEqual(self.reads, before)
        self.assertEqual(self.writes, [])

    def test_emergency_after_partial_fault_attempts_all_previously_verified_drums(self):
        self.drums.check()
        self.failures[(3, 132)] = (0, -3001, 0)
        self.drums.check()
        before = list(self.reads)
        self.write_failures[(3, 64)] = (-3001, 0)
        self.assertFalse(self.drums.emergency_stop()["ok"])
        self.assertEqual(self.reads, before)
        self.assertEqual(self.writes, [(motor_id, 64, 0) for motor_id in DRUM_IDS])

    def test_ordinary_release_on_verified_bus_attempts_all_arms_after_partial_fault(self):
        self.drums.check()
        self.failures[(3, 132)] = (0, -3001, 0)
        self.drums.check()
        before = list(self.reads)
        self.write_failures[(3, 64)] = (-3001, 0)
        self.assertFalse(self.drums.torque(False)["ok"])
        self.assertEqual(self.reads, before)
        self.assertEqual(self.writes, [(motor_id, 64, 0) for motor_id in DRUM_IDS])

    def test_release_disconnect_close_and_selection_change_cancel_pending_return(self):
        for action in ("release", "disconnect", "selection", "close"):
            with self.subTest(action=action):
                self.torques.clear()
                self.start(duration=5000)
                worker = self.drums._strike_thread
                if action == "release":
                    self.assertTrue(self.drums.torque(False)["ok"])
                elif action == "selection":
                    self.drums.check("/dev/cu.usbserial-OTHER")
                else:
                    getattr(self.drums, action)()
                worker.join(timeout=1)
                self.assertFalse(worker.is_alive())
                self.assertEqual(self.drums.snapshot()["strike"]["state"], "cancelled")
                goals = [(motor_id, value) for motor_id, address, value in self.writes if address == 116]
                self.assertEqual(goals, [(0, 2200)], "cancelling preparation never sends the hit")
                self.writes.clear()

    def test_stop_during_return_profile_prevents_return_goal_write(self):
        goals = 0

        def stop_on_return_profile(*args):
            nonlocal goals
            result = self.write(*args)
            if args[2] == 116:
                goals += 1
            if args[2] == 112 and goals == 2:
                self.drums.request_stop()
            return result

        self.packet.write4ByteTxRx.side_effect = stop_on_return_profile
        self.start()
        self.wait_until(lambda: not self.drums.snapshot()["busy"])
        self.assertEqual(self.drums.snapshot()["strike"]["state"], "cancelled")
        self.assertEqual(self.writes, [(0, 112, 100), (0, 116, 2200),
                                       (0, 112, 100), (0, 116, 2370), (0, 112, 100)])

    def test_return_write_failure_is_reported_and_does_not_retry(self):
        writes = 0

        def fail_return_goal(*args):
            nonlocal writes
            result = self.write(*args)
            writes += 1
            return (-3001, 0) if writes == 6 else result

        self.packet.write4ByteTxRx.side_effect = fail_return_goal
        self.start()
        self.wait_until(lambda: not self.drums.snapshot()["busy"])
        strike = self.drums.snapshot()["strike"]
        self.assertEqual(strike["state"], "error")
        self.assertIn("116", strike["error"])
        self.assertIn("uncertain", strike["error"])
        self.assertEqual(len(self.writes), 6)

    def test_return_readback_failure_is_not_reported_complete(self):
        writes = 0

        def fail_final_read(*args):
            nonlocal writes
            result = self.write(*args)
            writes += 1
            if writes == 6:
                self.failures[(0, 132)] = (0, -3001, 0)
            return result

        self.packet.write4ByteTxRx.side_effect = fail_final_read
        self.start()
        self.wait_until(lambda: not self.drums.snapshot()["busy"])
        self.assertEqual(self.drums.snapshot()["strike"]["state"], "error")
        self.assertEqual(len(self.writes), 6)

    def test_reset_cannot_revive_old_job_or_clobber_new_job(self):
        self.start(duration=5000)
        old_worker = self.drums._strike_thread
        self.drums.request_stop()
        self.drums.reset_stop()
        self.writes.clear()
        result = self.drums.strike(1, 2120, 100, 100, rest_position=1850, prepare_duration_ms=100)
        self.assertTrue(result["ok"], result)
        old_worker.join(timeout=1)
        self.wait_until(lambda: not self.drums.snapshot()["busy"])
        self.assertEqual(self.drums.snapshot()["strike"]["state"], "complete")
        self.assertEqual(self.drums.snapshot()["strike"]["motor_id"], 1)
        self.assertEqual(self.writes, [(1, 112, 100), (1, 116, 1850),
                                       (1, 112, 100), (1, 116, 2120), (1, 112, 100), (1, 116, 1850)])

    def test_lock_free_stop_and_reset_interrupt_manual_move_without_reviving_writes(self):
        self.drums.check()
        writing, proceed, stopped = threading.Event(), threading.Event(), threading.Event()
        results = []

        def blocked_write(*args):
            result = self.write(*args)
            writing.set()
            if not proceed.wait(2):
                raise OSError("test write release timed out")
            return result

        self.packet.write4ByteTxRx.side_effect = blocked_write
        writer = threading.Thread(target=lambda: results.append(self.drums.move([(0, 2300, 100)])))
        writer.start()
        self.assertTrue(writing.wait(1))
        stopper = threading.Thread(target=lambda: (self.drums.request_stop(), self.drums.reset_stop(), stopped.set()))
        stopper.start()
        self.assertTrue(stopped.wait(1), "Stop/reset must not wait on the serial lock")
        proceed.set()
        writer.join(timeout=1)
        stopper.join(timeout=1)
        self.assertFalse(writer.is_alive())
        self.assertFalse(results[0]["ok"])
        self.assertEqual(self.writes, [(0, 112, 100)])

    def test_stop_is_checked_before_each_torque_enable_write(self):
        def stop_after_write(*args):
            result = self.write(*args)
            self.drums.request_stop()
            return result

        self.packet.write1ByteTxRx.side_effect = stop_after_write
        self.assertFalse(self.drums.torque(True)["ok"])
        self.assertEqual([event for event in self.writes if event[1] == 64], [(0, 64, 1)])
        self.assertEqual([event for event in self.writes if event[1] == 116],
                         [(0, 116, 2200), (1, 116, 1850), (2, 116, 2300), (3, 116, 2600)])


if __name__ == "__main__":
    unittest.main()
