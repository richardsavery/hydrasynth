#!/usr/bin/env python3
"""Rib connection and command tests. All SDK calls and devices are fake."""

from __future__ import annotations

from types import SimpleNamespace
import threading
import unittest
from unittest.mock import Mock, patch

from robot_ribs import BAUDRATE, BOUNDS, DEFAULT_DEVICE, IDS, PREFERRED_DEVICE, RibController


class RibControllerTests(unittest.TestCase):
    def setUp(self):
        self.failures = {}
        self.write_failures = {}
        self.torques = {motor_id: 1 for motor_id in IDS}
        self.profiles = {motor_id: 4 for motor_id in IDS}
        self.modes = {motor_id: 3 for motor_id in IDS}
        self.writes = []
        self.reads = []
        self.port = Mock()
        self.port.ser = SimpleNamespace()
        self.port.openPort.return_value = True
        self.port.setBaudRate.return_value = True
        self.packet = Mock()
        self.packet.getTxRxResult.side_effect = lambda code: f"Communication error {code}"
        self.packet.getRxPacketError.side_effect = lambda code: f"Packet error {code}"
        self.packet.read4ByteTxRx.side_effect = self.read
        self.packet.read1ByteTxRx.side_effect = self.read
        self.packet.write4ByteTxRx.side_effect = self.write
        self.packet.write1ByteTxRx.side_effect = self.write
        self.sdk = SimpleNamespace(COMM_SUCCESS=0, PortHandler=Mock(return_value=self.port),
                                   PacketHandler=Mock(return_value=self.packet))
        preferred_patch = patch("robot_ribs.robot_devices.preferred_connection", return_value={
            "state": "matched", "device": PREFERRED_DEVICE, "baudrate": BAUDRATE,
            "identity": None, "message": "Test USB discovery", "label": "Ribs",
        })
        self.preferred_connection = preferred_patch.start()
        self.addCleanup(preferred_patch.stop)
        for name, value in (("_ports", [PREFERRED_DEVICE]), ("_dependency_available", True),
                            ("os.path.exists", True), ("importlib.import_module", self.sdk)):
            context = patch("robot_ribs." + name, return_value=value)
            mock = context.start()
            self.addCleanup(context.stop)
            if name == "importlib.import_module":
                self.import_sdk = mock
            elif name == "os.path.exists":
                self.exists = mock
            elif name == "_ports":
                self.ports = mock
            elif name == "_dependency_available":
                self.dependency_available = mock
        self.controller = RibController()
        self.addCleanup(self.controller.close)

    def read(self, port, motor_id, address):
        self.reads.append((motor_id, address))
        failure = self.failures.get((motor_id, address))
        if isinstance(failure, Exception):
            raise failure
        if failure is not None:
            return failure
        values = {132: 2800 if motor_id < 25 else 1000, 64: self.torques[motor_id],
                  70: 0, 10: self.profiles[motor_id], 11: self.modes[motor_id]}
        return values[address], 0, 0

    def write(self, port, motor_id, address, value):
        self.writes.append((motor_id, address, value))
        failure = self.write_failures.get((motor_id, address))
        if isinstance(failure, Exception):
            raise failure
        if failure is not None:
            return failure
        if address == 64:
            self.torques[motor_id] = value
        return 0, 0

    def test_initial_snapshot_never_imports_or_opens_sdk(self):
        state = self.controller.snapshot()
        self.assertEqual(state["state"], "unchecked")
        self.assertIsNone(state["checked_at"])
        self.assertTrue(state["dependency_available"])
        self.assertEqual(state["device"], PREFERRED_DEVICE)
        self.assertEqual(len(state["motors"]), 6)
        self.import_sdk.assert_not_called()
        self.sdk.PortHandler.assert_not_called()
        self.assertEqual(self.reads, [])
        self.assertEqual(self.writes, [])

    def test_missing_default_never_falls_back_to_a_historical_path(self):
        self.ports.return_value = []
        self.preferred_connection.return_value = {"state": "missing", "device": None, "baudrate": BAUDRATE}
        other = RibController()
        self.addCleanup(other.close)
        self.assertIsNone(other.snapshot()["device"])
        self.assertEqual(other.check()["code"], "device_required")
        self.sdk.PortHandler.assert_not_called()

    def test_successful_check_reads_six_ribs_without_writes(self):
        state = self.controller.check()
        self.assertEqual(state["state"], "ready")
        self.assertIsNotNone(state["checked_at"])
        self.assertEqual(state["baudrate"], BAUDRATE)
        self.port.setBaudRate.assert_called_once_with(BAUDRATE)
        self.sdk.PacketHandler.assert_called_once_with(2.0)
        self.assertEqual({row["id"] for row in state["motors"]}, set(IDS))
        for row in state["motors"]:
            self.assertTrue(row["connected"])
            self.assertTrue(row["torque_enabled"])
            self.assertIsNotNone(row["position"])
            self.assertEqual(row["profile_mode"], "time")
            self.assertEqual(row["operating_mode"], 3)
            self.assertIsNone(row["error"])
        self.assertEqual(self.writes, [])
        self.assertEqual({motor_id for motor_id, _ in self.reads}, set(IDS))

    def test_missing_sdk_has_install_instructions(self):
        self.import_sdk.side_effect = ImportError("not installed")
        self.dependency_available.return_value = False
        state = self.controller.check()
        self.assertEqual(state["code"], "dependency_missing")
        self.assertFalse(state["dependency_available"])
        self.assertIn("requirements-robot.txt", state["message"])
        self.sdk.PortHandler.assert_not_called()

    def test_missing_adapter_is_disconnected(self):
        self.exists.return_value = False
        state = self.controller.check()
        self.assertEqual(state["state"], "disconnected")
        self.assertEqual(state["code"], "device_missing")
        self.assertIn(PREFERRED_DEVICE, state["message"])
        self.sdk.PortHandler.assert_not_called()

    def test_open_failures_are_actionable_and_close_port(self):
        for failure in (False, OSError("resource busy"), PermissionError("access denied")):
            with self.subTest(failure=failure):
                self.port.openPort.side_effect = failure if isinstance(failure, Exception) else None
                self.port.openPort.return_value = failure
                state = self.controller.check()
                self.assertEqual(state["code"], "serial_open_failed")
                self.assertIn("interaction.py", state["message"])
                self.assertEqual(self.writes, [])
        self.assertEqual(self.port.closePort.call_count, 3)

    def test_baudrate_failures_close_port(self):
        for failure in (False, OSError("baud unsupported")):
            with self.subTest(failure=failure):
                self.port.setBaudRate.side_effect = failure if isinstance(failure, Exception) else None
                self.port.setBaudRate.return_value = failure
                state = self.controller.check()
                self.assertEqual(state["code"], "baudrate_failed")
                self.assertIn(str(BAUDRATE), state["message"])
        self.assertEqual(self.port.closePort.call_count, 2)

    def test_exclusivity_applied_after_final_baudrate_setup(self):
        original_serial = SimpleNamespace(exclusive=None)
        final_serial = SimpleNamespace(exclusive=None)
        self.port.ser = original_serial

        def set_baud(_baud):
            self.port.ser = final_serial
            return True

        self.port.setBaudRate.side_effect = set_baud
        self.assertEqual(self.controller.check()["state"], "ready")
        self.assertIsNone(original_serial.exclusive)
        self.assertTrue(final_serial.exclusive)

    def test_invalid_devices_never_open_a_file(self):
        for device in ("/tmp/test", "/dev/null", "/dev/../tmp/ttyUSB0", "/dev/ttyUSB0/../x",
                       "/dev/ttyUSB0\n", "ttyUSB0", "", 5, True):
            with self.subTest(device=device), self.assertRaises(ValueError):
                self.controller.check(device)
        self.import_sdk.assert_not_called()

    def test_supported_device_names_and_changes_close_old_connection(self):
        for device in (PREFERRED_DEVICE, DEFAULT_DEVICE, "/dev/cu.usbmodem123", "/dev/ttyUSB0", "/dev/ttyACM2"):
            self.assertEqual(self.controller.check(device)["device"], device)
        self.assertEqual(self.port.closePort.call_count, 4)

    def test_partial_timeout_identifies_missing_motor(self):
        self.failures[(22, 132)] = (0, -3001, 0)
        state = self.controller.check()
        self.assertEqual(state["state"], "partial")
        missing = next(row for row in state["motors"] if row["id"] == 22)
        self.assertFalse(missing["connected"])
        self.assertIsNone(missing["position"])
        self.assertIn("-3001", missing["error"])
        self.assertIn("Rib 22", state["message"])
        self.assertEqual(self.writes, [])

    def test_all_missing_motors_close_adapter_and_can_retry(self):
        self.failures.update({(motor_id, 132): (0, -3001, 0) for motor_id in IDS})
        state = self.controller.check()
        self.assertEqual(state["state"], "disconnected")
        self.assertEqual(state["code"], "motors_unreachable")
        self.assertIn("USB adapter opened", state["message"])
        self.assertIn("1,000,000 baud", state["message"])
        self.assertIn("motor power", state["message"])
        self.port.closePort.assert_called_once()
        self.failures.clear()
        self.assertEqual(self.controller.check()["state"], "ready")
        self.assertEqual(self.port.openPort.call_count, 2)

    def test_packet_errors_and_hardware_faults_are_not_connected_success(self):
        for address, result in ((132, (0, 0, 4)), (64, (0, 0, 4)), (70, (4, 0, 0)),
                                (10, (0, -3001, 0)), (11, (0, 0, 4))):
            with self.subTest(address=address):
                self.failures = {(20, address): result}
                state = self.controller.check()
                self.assertEqual(state["state"], "partial")
                self.assertTrue(state["motors"][0]["error"])
                self.assertEqual(self.writes, [])

    def test_both_communication_and_packet_errors_are_preserved(self):
        self.failures[(20, 132)] = (0, -3001, 4)
        state = self.controller.check()
        error = state["motors"][0]["error"]
        self.assertIn("Communication error -3001", error)
        self.assertIn("Packet error 4", error)

    def test_movement_requires_a_successful_initial_check(self):
        result = self.controller.move([(20, 2450, 2500)])
        self.assertFalse(result["ok"])
        self.assertEqual(self.writes, [])
        self.import_sdk.assert_not_called()

    def test_disconnect_after_successful_check_cancels_movement_before_writes(self):
        self.controller.check()
        self.failures.update({(motor_id, 132): OSError("device removed") for motor_id in IDS})
        result = self.controller.move([(20, 2450, 2500)])
        self.assertFalse(result["ok"])
        self.assertEqual(result["ribs"]["state"], "disconnected")
        self.assertIn("device removed", result["error"])
        self.assertEqual(self.writes, [])

    def test_group_preflight_validates_every_motor_before_any_write(self):
        self.controller.check()
        self.failures[(27, 132)] = (0, -3001, 0)
        result = self.controller.move([(20, 2450, 2500), (27, 1700, 2500)])
        self.assertFalse(result["ok"])
        self.assertEqual(self.writes, [])

    def test_torque_off_prevents_movement(self):
        self.torques[20] = 0
        self.controller.check()
        result = self.controller.move([(20, 2450, 2500)])
        self.assertFalse(result["ok"])
        self.assertIn("torque is off", result["error"])
        self.assertEqual(self.writes, [])

    def test_incompatible_profiles_and_modes_never_move_or_reconfigure(self):
        for profile, operating in ((0, 3), (0, 4), (4, 1), (4, 16)):
            with self.subTest(profile=profile, operating=operating):
                self.profiles[20], self.modes[20] = profile, operating
                self.assertEqual(self.controller.check()["state"], "ready")
                result = self.controller.move([(20, 2450, 2500)])
                self.assertFalse(result["ok"])
                self.assertIn("time-based profiles", result["error"])
                self.assertEqual(self.writes, [])

    def test_exact_bounds_and_durations_are_acknowledged(self):
        self.controller.check()
        for motor_id in IDS:
            for position in BOUNDS[motor_id]:
                for duration in (100, 5000):
                    result = self.controller.move([(motor_id, position, duration)])
                    self.assertTrue(result["ok"])
                    self.assertEqual(self.writes[-2:], [(motor_id, 112, duration), (motor_id, 116, position)])
        self.assertTrue(all(motor_id in IDS for motor_id, _, _ in self.writes))

    def test_invalid_bounds_and_targets_never_read_or_write(self):
        invalid = [[], [(4, 2000, 1000)], [(23, 2450, 1000)], [(20, 2450, 1000)] * 2,
                   [(True, 2450, 1000)], [(20, True, 1000)], [(20, 2450, False)],
                   [(20, 2450, 99)], [(20, 2450, 5001)], [(20, 2450, 100.5)],
                   [(20, float("nan"), 1000)], [(20, float("inf"), 1000)],
                   [(20, 10 ** 1000, 1000)], [(20, "2450", 1000)], [(20, 2450)], "x"]
        for motor_id, (minimum, maximum) in BOUNDS.items():
            invalid.extend([[(motor_id, minimum - 1, 1000)], [(motor_id, maximum + 1, 1000)]])
        for targets in invalid:
            with self.subTest(targets=targets), self.assertRaises(ValueError):
                self.controller.move(targets)
        self.assertEqual(self.reads, [])
        self.assertEqual(self.writes, [])

    def test_failed_write_marks_partial_movement_uncertain_and_stops(self):
        for address, failure in ((112, (-3001, 0)), (116, (0, 4)),
                                 (116, OSError("USB disconnected"))):
            with self.subTest(address=address, failure=failure):
                self.controller.check()
                self.writes.clear()
                self.write_failures = {(21, address): failure}
                result = self.controller.move([(20, 2450, 1000), (21, 2450, 1000), (22, 2450, 1000)])
                self.assertFalse(result["ok"])
                self.assertIn("Rib 21", result["error"])
                self.assertIn("positions are uncertain", result["error"])
                self.assertEqual(result["ribs"]["code"], "write_failed")
                self.assertFalse(any(motor_id == 22 for motor_id, _, _ in self.writes))

    def test_enable_torque_requires_all_six_fresh_and_healthy(self):
        self.controller.check()
        self.failures[(27, 132)] = (0, -3001, 0)
        self.assertFalse(self.controller.torque(True)["ok"])
        self.assertEqual(self.writes, [])

    def test_torque_changes_only_six_rib_ids_and_no_other_registers(self):
        for enabled in (True, False):
            self.writes.clear()
            result = self.controller.torque(enabled)
            self.assertTrue(result["ok"])
            self.assertEqual(self.writes, [(motor_id, 64, int(enabled)) for motor_id in IDS])

    def test_torque_enable_rejects_nonposition_mode_but_release_is_allowed(self):
        self.modes[22] = 1
        result = self.controller.torque(True)
        self.assertFalse(result["ok"])
        self.assertEqual(result["ribs"]["code"], "operating_mode_incompatible")
        self.assertIn("22", result["error"])
        self.assertEqual(self.writes, [])
        self.assertTrue(self.controller.torque(False)["ok"])
        self.assertEqual(self.writes, [(motor_id, 64, 0) for motor_id in IDS])

    def test_torque_release_attempts_all_motors_despite_failures(self):
        self.write_failures = {(20, 64): (-3001, 0), (22, 64): OSError("removed"), (26, 64): (0, 4)}
        result = self.controller.torque(False)
        self.assertFalse(result["ok"])
        self.assertEqual(self.writes, [(motor_id, 64, 0) for motor_id in IDS])
        for motor_id in (20, 22, 26):
            self.assertIn(f"Rib {motor_id}", result["error"])

    def test_release_never_writes_to_unverified_bus_with_only_two_responding_ids(self):
        self.failures = {(motor_id, 132): (0, -3001, 0) for motor_id in (22, 25, 26, 27)}
        result = self.controller.torque(False)
        self.assertFalse(result["ok"])
        self.assertIn("has not been verified", result["error"])
        self.assertEqual(self.writes, [])

    def test_release_keeps_working_after_partial_fault_on_verified_open_bus(self):
        self.controller.check()
        self.failures[(27, 132)] = (0, -3001, 0)
        self.assertEqual(self.controller.check()["state"], "partial")
        self.write_failures[(27, 64)] = (-3001, 0)
        result = self.controller.torque(False)
        self.assertFalse(result["ok"])
        self.assertEqual(self.writes, [(motor_id, 64, 0) for motor_id in IDS])

    def test_changing_device_clears_verification_before_release(self):
        self.controller.check()
        self.failures = {(motor_id, 132): (0, -3001, 0) for motor_id in (22, 25, 26, 27)}
        self.assertEqual(self.controller.check("/dev/cu.usbserial-HEAD")["state"], "partial")
        self.assertFalse(self.controller.torque(False)["ok"])
        self.assertEqual(self.writes, [])

    def test_reconnecting_requires_new_verification_before_release(self):
        self.controller.check()
        self.controller.disconnect()
        self.failures[(27, 132)] = (0, -3001, 0)
        self.assertFalse(self.controller.torque(False)["ok"])
        self.assertEqual(self.writes, [])
        self.failures.clear()
        self.assertTrue(self.controller.torque(False)["ok"])
        self.assertEqual(self.writes, [(motor_id, 64, 0) for motor_id in IDS])

    def test_enable_failure_reports_possible_partial_torque_change(self):
        self.write_failures[(21, 64)] = (-3001, 0)
        result = self.controller.torque(True)
        self.assertFalse(result["ok"])
        self.assertIn("Some motors may have changed torque", result["error"])
        self.assertEqual(self.writes, [(20, 64, 1), (21, 64, 1)])

    def test_invalid_torque_setting_is_rejected_without_io(self):
        for value in (0, 1, "true", None):
            with self.assertRaises(ValueError):
                self.controller.torque(value)
        self.assertEqual(self.reads, [])
        self.assertEqual(self.writes, [])

    def test_snapshot_is_a_copy_and_never_rechecks_hardware(self):
        self.controller.check()
        before = list(self.reads)
        state = self.controller.snapshot()
        state["motors"][0]["position"] = -999
        self.assertNotEqual(self.controller.snapshot()["motors"][0]["position"], -999)
        self.assertEqual(self.reads, before)

    def test_emergency_release_never_opens_or_probes_unverified_connection(self):
        result = self.controller.emergency_stop()
        self.assertTrue(result["ok"])
        self.assertTrue(result["skipped"])
        self.import_sdk.assert_not_called()
        self.assertEqual(self.reads, [])
        self.assertEqual(self.writes, [])
        self.assertFalse(self.controller.torque(True)["ok"])
        self.controller.reset_stop()
        self.assertTrue(self.controller.torque(True)["ok"])

    def test_emergency_releases_all_verified_ribs_without_reads_even_after_faults(self):
        self.controller.check()
        self.failures[(27, 132)] = (0, -3001, 0)
        self.controller.check()
        self.write_failures[(20, 64)] = (-3001, 0)
        before = list(self.reads)
        result = self.controller.emergency_stop()
        self.assertFalse(result["ok"])
        self.assertEqual(self.reads, before)
        self.assertEqual(self.writes, [(motor_id, 64, 0) for motor_id in IDS])
        self.assertFalse(self.controller.move([(20, 2450, 100)])["ok"])

    def test_emergency_after_new_wrong_port_does_not_reuse_verified_identity(self):
        self.controller.check()
        self.failures[(27, 132)] = (0, -3001, 0)
        self.controller.check("/dev/cu.usbserial-OTHER")
        before = list(self.reads)
        self.assertTrue(self.controller.emergency_stop()["skipped"])
        self.assertEqual(self.reads, before)
        self.assertEqual(self.writes, [])

    def test_stop_is_checked_before_every_position_and_torque_write(self):
        self.controller.check()

        def stop_after_write(*args):
            result = self.write(*args)
            self.controller.request_stop()
            return result

        self.packet.write4ByteTxRx.side_effect = stop_after_write
        result = self.controller.move([(20, 2450, 100), (21, 2450, 100)])
        self.assertFalse(result["ok"])
        self.assertEqual(self.writes, [(20, 112, 100)])
        self.controller.reset_stop()
        self.writes.clear()
        self.packet.write1ByteTxRx.side_effect = stop_after_write
        self.assertFalse(self.controller.torque(True)["ok"])
        self.assertEqual(self.writes, [(20, 64, 1)])

    def test_lock_free_stop_and_reset_do_not_revive_in_flight_command(self):
        self.controller.check()
        writing, proceed, result = threading.Event(), threading.Event(), []

        def blocked_write(*args):
            value = self.write(*args)
            writing.set()
            if not proceed.wait(2):
                raise OSError("test write release timed out")
            return value

        self.packet.write4ByteTxRx.side_effect = blocked_write
        worker = threading.Thread(target=lambda: result.append(self.controller.move([(20, 2450, 100)])))
        worker.start()
        self.assertTrue(writing.wait(1))
        stopped = threading.Event()
        stopper = threading.Thread(target=lambda: (self.controller.request_stop(), self.controller.reset_stop(), stopped.set()))
        stopper.start()
        self.assertTrue(stopped.wait(1), "Stop/reset must not wait on the serial lock")
        proceed.set()
        worker.join(timeout=2)
        stopper.join(timeout=1)
        self.assertFalse(worker.is_alive())
        self.assertFalse(result[0]["ok"])
        self.assertEqual(self.writes, [(20, 112, 100)])

    def test_disconnect_and_close_leave_motor_torque_unchanged(self):
        self.controller.check()
        state = self.controller.disconnect()
        self.assertEqual(state["state"], "disconnected")
        self.assertTrue(all(row["position"] is None for row in state["motors"]))
        self.assertEqual(self.writes, [])
        self.assertEqual(self.controller.check()["state"], "ready")
        self.controller.close()
        self.assertEqual(self.controller.check()["code"], "closed")
        self.assertFalse(self.controller.torque(False)["ok"])
        self.assertEqual(self.writes, [])


if __name__ == "__main__":
    unittest.main()
