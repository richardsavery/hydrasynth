#!/usr/bin/env python3
"""USB identity discovery tests. Enumeration and serial hardware are fake."""

from __future__ import annotations

import copy
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from robot_devices import (
    DEFAULT_PROFILE_PATH, DEVICE_PATTERN, connection_key, device_identity,
    main, preferred_connection, resolve_identity, serial_ports, validate_identity,
)


HEAD = {"vid": 0x2F5D, "pid": 0x2202, "serial_number": "head-controller"}


def port(device="/dev/cu.usbmodem14201", identity=None, **metadata):
    return {"device": device, **(HEAD if identity is None else identity),
            "description": "OpenRB-150", "manufacturer": "ROBOTIS",
            "product": "OpenRB-150", "location": "0-1.4.2", **metadata}


class DeviceDiscoveryTests(unittest.TestCase):
    def test_patterns_support_mac_linux_and_windows(self):
        for device in ("/dev/cu.usbmodem14201", "/dev/tty.usbmodem14201",
                       "/dev/cu.usbserial-FT78LBUJ", "/dev/tty.usbserial-FT78LBUJ",
                       "/dev/ttyUSB0", "/dev/ttyACM12", "COM1", "COM32", "com12"):
            with self.subTest(device=device):
                self.assertIsNotNone(DEVICE_PATTERN.fullmatch(device))
        for device in ("COM0", "COM01", "COM-1", "COM3/../4", "/dev/ttyACM-1",
                       "/dev/cu.Bluetooth-Incoming-Port", "/dev/ttyUSB0/../mem", "/dev/null"):
            with self.subTest(device=device):
                self.assertIsNone(DEVICE_PATTERN.fullmatch(device))

    def test_connection_key_canonicalizes_only_aliases(self):
        self.assertEqual(connection_key("/dev/cu.usbmodem14201"), connection_key("/dev/tty.usbmodem14201"))
        self.assertEqual(connection_key("com17"), "COM17")
        self.assertEqual(connection_key("/dev/ttyUSB1"), "/dev/ttyUSB1")
        self.assertIsNone(connection_key(None))
        self.assertIsNone(connection_key(""))

    @unittest.skipUnless(os.name == "posix", "POSIX symlink canonicalization")
    def test_connection_key_detects_two_symlinks_to_the_same_device(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "adapter"
            target.touch()
            first, second = Path(directory) / "head-link", Path(directory) / "drums-link"
            first.symlink_to(target)
            second.symlink_to(target)
            self.assertEqual(connection_key(str(first)), connection_key(str(second)))
            self.assertEqual(connection_key(str(first)), str(target.resolve()))

    @unittest.skipUnless(os.name == "posix", "POSIX symlink canonicalization")
    def test_connection_key_resolves_symlink_before_mac_alias(self):
        with patch("robot_devices.os.path.realpath", return_value="/dev/tty.usbserial-physical") as realpath:
            self.assertEqual(connection_key("/dev/cu.usbserial-alias"), "/dev/cu.usbserial-physical")
        realpath.assert_called_once_with("/dev/cu.usbserial-alias")

    def test_connection_key_never_resolves_com_ports_as_filesystem_paths(self):
        with patch("robot_devices.os.path.realpath") as realpath:
            self.assertEqual(connection_key("com24"), "COM24")
        realpath.assert_not_called()

    def test_identity_validation_returns_new_exact_dictionary(self):
        identity = validate_identity(HEAD)
        self.assertEqual(identity, HEAD)
        self.assertIsNot(identity, HEAD)

    def test_identity_rejects_incomplete_invalid_or_extra_fields(self):
        invalid = [None, [], {}, {"vid": 1, "pid": 1},
                   {**HEAD, "serial_number": ""}, {**HEAD, "serial_number": "   "},
                   {**HEAD, "serial_number": "value\n"}, {**HEAD, "serial_number": 1234},
                   {**HEAD, "vid": True}, {**HEAD, "pid": 1.0}, {**HEAD, "pid": -1},
                   {**HEAD, "vid": 65536}, {**HEAD, "location": "0-1"}]
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    validate_identity(value)
                result = resolve_identity(value, [])
                self.assertEqual(result["state"], "unavailable")
                self.assertIsNone(result["device"])

    def test_identity_follows_renamed_port_and_changed_usb_location(self):
        for device in ("/dev/cu.usbmodem12201", "/dev/cu.usbmodem14201",
                       "/dev/ttyACM0", "/dev/ttyUSB2", "COM19", "com3"):
            with self.subTest(device=device):
                result = resolve_identity(HEAD, [port(device, location="another-computer")])
                self.assertEqual(result["state"], "matched")
                self.assertEqual(result["device"], device.upper() if device.lower().startswith("com") else device)
                self.assertEqual(result["identity"], HEAD)

    def test_mac_aliases_are_one_device_and_prefer_callout(self):
        callout, dialin = port(), port("/dev/tty.usbmodem14201")
        for rows in ([callout, dialin], [dialin, callout], [callout, callout, dialin]):
            with self.subTest(rows=rows):
                result = resolve_identity(HEAD, rows)
                self.assertEqual(result["state"], "matched")
                self.assertEqual(result["device"], callout["device"])
                self.assertEqual(device_identity(dialin["device"], rows), HEAD)

    def test_windows_casing_is_not_an_ambiguous_device(self):
        result = resolve_identity(HEAD, [port("COM12"), port("com12")])
        self.assertEqual(result["state"], "matched")
        self.assertEqual(result["device"], "COM12")
        self.assertEqual(device_identity("com12", [port("COM12")]), HEAD)

    def test_same_identity_on_two_real_ports_is_ambiguous(self):
        rows = [port("/dev/ttyACM0"), port("/dev/ttyACM1")]
        result = resolve_identity(HEAD, rows)
        self.assertEqual(result["state"], "ambiguous")
        self.assertIsNone(result["device"])
        self.assertIsNone(device_identity("/dev/ttyACM0", rows))

    def test_missing_adapter_does_not_fall_back_to_other_devices(self):
        rows = [port(identity={**HEAD, "serial_number": "different-controller"})]
        result = resolve_identity(HEAD, rows)
        self.assertEqual(result["state"], "missing")
        self.assertIsNone(result["device"])
        self.assertEqual(result["identity"], HEAD)
        self.assertIsNone(device_identity("/dev/cu.usbmodem99999", rows))

    def test_matching_needs_vendor_product_and_serial(self):
        for field, changed in (("vid", 1), ("pid", 1), ("serial_number", "HEAD-CONTROLLER")):
            with self.subTest(field=field):
                self.assertEqual(resolve_identity(HEAD, [port(identity={**HEAD, field: changed})])["state"], "missing")

    def test_port_without_complete_usb_identity_cannot_be_saved(self):
        for field in ("vid", "pid", "serial_number"):
            rows = [port(identity={**HEAD, field: None})]
            with self.subTest(field=field):
                self.assertIsNone(device_identity(rows[0]["device"], rows))
                self.assertEqual(resolve_identity(HEAD, rows)["state"], "missing")

    def test_discovery_reads_os_metadata_and_never_opens_serial(self):
        open_serial = Mock(side_effect=AssertionError("Serial ports must not be opened"))
        fake = SimpleNamespace(
            Serial=open_serial,
            comports=Mock(return_value=[SimpleNamespace(**port("/dev/tty.usbmodem14201")),
                                       SimpleNamespace(**port()),
                                       SimpleNamespace(**port("/dev/cu.Bluetooth-Incoming-Port"))]),
        )
        with patch.dict("sys.modules", {"serial": SimpleNamespace(Serial=open_serial),
                                        "serial.tools": SimpleNamespace(list_ports=fake)}):
            rows = serial_ports()
        fake.comports.assert_called_once_with()
        open_serial.assert_not_called()
        self.assertEqual(rows, [port()])

    def test_discovery_failure_does_not_crash_status(self):
        for error in (ImportError("No module named serial"), OSError("USB enumeration failed")):
            with self.subTest(error=error), patch("robot_devices._enumerate_port_metadata", side_effect=error):
                self.assertEqual(serial_ports(), [])
                self.assertIsNone(device_identity("/dev/cu.usbmodem14201"))
                result = resolve_identity(HEAD)
                self.assertEqual(result["state"], "unavailable")
                self.assertIsNone(result["device"])
                self.assertIn(str(error), result["message"])

    def test_empty_successful_enumeration_means_missing(self):
        with patch("robot_devices._enumerate_port_metadata", return_value=[]):
            self.assertEqual(resolve_identity(HEAD)["state"], "missing")


class DeviceProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "robot-devices.json"
        self.profile = {"version": 1, "devices": {
            "head": {"identity": copy.deepcopy(HEAD), "baudrate": 1_000_000, "label": "Head controller"}
        }}
        self.write_profile()

    def write_profile(self):
        self.path.write_text(json.dumps(self.profile), encoding="utf-8")

    def resolve(self, group="head", ports=None):
        return preferred_connection(group, [port()] if ports is None else ports, self.path)

    def test_profile_resolves_role_on_another_computer(self):
        result = self.resolve(ports=[port("COM15")])
        self.assertEqual(result["state"], "matched")
        self.assertEqual(result["device"], "COM15")
        self.assertEqual(result["baudrate"], 1_000_000)
        self.assertEqual(result["label"], "Head controller")
        self.assertEqual(result["identity"], HEAD)

    def test_missing_role_does_not_guess(self):
        result = self.resolve("ribs")
        self.assertEqual(result["state"], "unavailable")
        self.assertIsNone(result["device"])
        self.assertIsNone(result["baudrate"])
        self.assertIn("ribs", result["message"])

    def test_missing_hardware_retains_role_and_baudrate(self):
        result = self.resolve(ports=[])
        self.assertEqual(result["state"], "missing")
        self.assertEqual(result["baudrate"], 1_000_000)
        self.assertEqual(result["label"], "Head controller")
        self.assertIsNone(result["device"])

    def test_malformed_missing_or_unreadable_file_does_not_crash(self):
        for content in ("{broken", "null", "[]", "{}", '{"version":true,"devices":{}}',
                        '{"version":1,"devices":[]}'):
            with self.subTest(content=content):
                self.path.write_text(content, encoding="utf-8")
                result = self.resolve()
                self.assertEqual(result["state"], "unavailable")
                self.assertIsNone(result["device"])
        self.path.unlink()
        self.assertEqual(self.resolve()["state"], "unavailable")
        self.path.mkdir()
        self.assertEqual(self.resolve()["state"], "unavailable")

    def test_invalid_profile_entries_fail_closed(self):
        for field, value in (("baudrate", True), ("baudrate", 123), ("label", ""),
                             ("identity", {"vid": 1, "pid": 2}), ("location", "0-1")):
            with self.subTest(field=field, value=value):
                original = copy.deepcopy(self.profile)
                self.profile["devices"]["head"][field] = value
                self.write_profile()
                self.assertEqual(self.resolve()["state"], "unavailable")
                self.profile = original

    def test_same_adapter_cannot_be_assigned_to_two_roles(self):
        self.profile["devices"]["drums"] = copy.deepcopy(self.profile["devices"]["head"])
        self.write_profile()
        result = self.resolve()
        self.assertEqual(result["state"], "unavailable")
        self.assertIn("multiple robot roles", result["message"])

    def test_ribs_profile_cannot_override_the_fixed_hardware_baudrate(self):
        self.profile["devices"] = {"ribs": {"identity": HEAD, "label": "Ribs", "baudrate": 57_600}}
        self.write_profile()
        result = self.resolve("ribs")
        self.assertEqual(result["state"], "unavailable")
        self.assertIsNone(result["device"])
        self.assertIn("fixed baudrate", result["message"])

    def test_oversize_profile_fails_closed_before_parsing(self):
        self.path.write_text(json.dumps(self.profile) + " " * (64 * 1024), encoding="utf-8")
        result = self.resolve()
        self.assertEqual(result["state"], "unavailable")
        self.assertIsNone(result["device"])
        self.assertIn("64 KiB", result["message"])

    def test_portable_default_profile_has_three_distinct_configured_adapters(self):
        profile = json.loads(DEFAULT_PROFILE_PATH.read_text(encoding="utf-8"))
        expected = {"head": "6430A5355055344E312E3120FF0C0B25", "ribs": "FT78LBUJ", "drums": "FT7WBEBD"}
        rows = [port(f"COM{index}", entry["identity"]) for index, entry in enumerate(profile["devices"].values(), 1)]
        devices = set()
        for group, serial in expected.items():
            result = preferred_connection(group, rows)
            self.assertEqual(result["state"], "matched")
            self.assertEqual(result["identity"]["serial_number"], serial)
            self.assertEqual(result["baudrate"], 1_000_000)
            devices.add(result["device"])
        self.assertEqual(len(devices), 3)

    def test_cli_prints_inventory_and_role_results_using_one_enumeration(self):
        output = io.StringIO()
        with patch("sys.argv", ["robot_devices.py", "--profile", str(self.path)]), \
                patch("robot_devices._discover", return_value=([port("COM7")], None)) as discover, \
                patch("sys.stdout", output):
            main()
        discover.assert_called_once_with()
        document = json.loads(output.getvalue())
        self.assertEqual(document["ports"][0]["device"], "COM7")
        self.assertEqual(document["devices"]["head"]["state"], "matched")
        self.assertEqual(document["devices"]["ribs"]["state"], "unavailable")
        self.assertIsNone(document["discovery_error"])


if __name__ == "__main__":
    unittest.main()
