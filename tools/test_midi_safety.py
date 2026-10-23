#!/usr/bin/env python3
"""Exercise browser-crash note cleanup without accessing MIDI hardware."""

import http.client
import json
from pathlib import Path
import subprocess
import threading
import unittest

from hydra_dashboard import DashboardHTTPServer, SnapshotStore, handler_for
from midi_safety import MidiSafetyService, SETTLING_MS, TIMEOUT_MS, output_names


LINUX_NAME = "HYDRASYNTH EXPLORER: HYDRASYNTH EXPLORER MIDI 1"
BROWSER_NAME = "HYDRASYNTH EXPLORER MIDI 1"
OWNER = "a" * 32
OTHER_OWNER = "b" * 32
LINUX_LIST = ("Outputs (commands sent to the synth):\n"
              "  [0] Other Keyboard: MIDI 1 (20:0)\n"
              f"  [1] {LINUX_NAME} (24:0)\n"
              "Inputs (keyboard and panel changes from the synth):\n"
              f"  [0] {LINUX_NAME} (24:0)\n")


class Native:
    def __init__(self):
        self.listing = LINUX_LIST
        self.calls = []
        self.fail = None
        self.panicked = threading.Event()

    def __call__(self, argv, **options):
        self.calls.append((argv, options))
        if self.fail == "timeout":
            raise subprocess.TimeoutExpired(argv, options["timeout"])
        if self.fail == "missing":
            raise FileNotFoundError("fake binary missing")
        if argv[1] == "panic":
            self.panicked.set()
        return subprocess.CompletedProcess(argv, 1 if self.fail else 0,
                                           self.listing if argv[1] == "list" else "", "")

    @property
    def panics(self):
        return [argv for argv, _ in self.calls if argv[1] == "panic"]


class MidiSafetyTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.native = Native()
        self.service = MidiSafetyService(Path("/fake/hydractl"), runner=self.native,
                                         clock=lambda: self.now, start_thread=False)
        self.addCleanup(self.service.close)

    def request(self, operation, payload):
        return self.service.dispatch("POST", "/api/midi-safety/" + operation, payload)

    def arm(self, port_name=BROWSER_NAME, channel=1, owner_id=OWNER):
        code, body = self.request("arm", {"port_name": port_name, "channel": channel, "owner_id": owner_id})
        self.assertEqual(code, 200, body)
        return body

    def test_idle_watchdog_and_status_do_not_touch_hardware(self):
        self.service.check_timeout()
        self.assertFalse(self.service.status()["armed"])
        self.service.close()
        self.assertEqual(self.native.calls, [])

    def test_linux_names_match_browser_and_panic_uses_full_name_not_address(self):
        self.assertEqual(output_names(LINUX_LIST), ["Other Keyboard: MIDI 1", LINUX_NAME])
        lease = self.arm(channel=3)
        self.assertEqual(lease["device_name"], LINUX_NAME)
        self.assertEqual(lease["heartbeat_ms"], 500)
        self.assertEqual(lease["timeout_ms"], TIMEOUT_MS)
        self.assertEqual(self.request("disarm", {"lease_id": lease["lease_id"]})[0], 200)
        self.assertEqual(self.native.panics, [["/fake/hydractl", "panic", "--device", LINUX_NAME, "--channel", "3"]])
        for _, options in self.native.calls:
            self.assertLessEqual(options["timeout"], 1)
            self.assertNotIn("shell", options)

    def test_existing_macos_endpoint_name_still_works(self):
        self.native.listing = ("Outputs (commands sent to the synth):\n  [0] Hydrasynth Explorer\n"
                               "Inputs (keyboard and panel changes from the synth):\n  [0] Hydrasynth Explorer\n")
        lease = self.arm("Hydrasynth Explorer", 16)
        self.assertEqual(lease["device_name"], "Hydrasynth Explorer")
        self.request("disarm", {"lease_id": lease["lease_id"]})
        self.assertEqual(self.native.panics[0][-3:], ["Hydrasynth Explorer", "--channel", "16"])

    def test_timeout_panics_once_and_late_heartbeat_cannot_revive(self):
        lease = self.arm()
        self.now += TIMEOUT_MS / 1000
        self.service.check_timeout()
        self.service.check_timeout()
        self.assertEqual(len(self.native.panics), 1)
        self.assertFalse(self.service.status()["armed"])
        self.assertEqual(self.service.status()["last_reason"], "heartbeat_timeout")
        self.assertTrue(self.service.status()["last_panic_ok"])
        self.assertEqual(self.request("heartbeat", {"lease_id": lease["lease_id"]})[0], 409)
        self.assertEqual(self.request("disarm", {"lease_id": lease["lease_id"]})[0], 409)
        self.assertEqual(len(self.native.panics), 1)

    def test_heartbeat_extends_deadline_but_not_after_expiry(self):
        lease = self.arm()
        self.now += 2
        self.assertEqual(self.request("heartbeat", {"lease_id": lease["lease_id"]})[0], 200)
        self.now += 2
        self.service.check_timeout()
        self.assertEqual(self.native.panics, [])
        self.now += 0.6
        self.assertEqual(self.request("heartbeat", {"lease_id": lease["lease_id"]})[0], 409)
        self.assertEqual(len(self.native.panics), 1)

    def test_stale_tokens_cannot_stop_or_extend_replacement_lease(self):
        old = self.arm()
        self.now += 1
        replacement = self.arm()
        self.assertNotEqual(old["lease_id"], replacement["lease_id"])
        self.assertEqual(len(self.native.panics), 1)
        self.assertEqual(self.service.status()["last_reason"], "lease_replaced")
        for action in ("heartbeat", "disarm"):
            self.assertEqual(self.request(action, {"lease_id": old["lease_id"]})[0], 409)
        self.assertEqual(len(self.native.panics), 1)
        self.now += 2.6
        # Even stale requests arriving after the current deadline cannot alter
        # it; only its own request or the independent watchdog expires it.
        self.assertEqual(self.request("disarm", {"lease_id": old["lease_id"]})[0], 409)
        self.assertEqual(len(self.native.panics), 1)
        self.service.check_timeout()
        self.assertEqual(len(self.native.panics), 2)

    def test_same_owner_releases_previous_notes_before_renewing_same_output(self):
        old = self.arm()
        self.now += 1
        replacement = self.arm()
        self.assertEqual(len(self.native.panics), 1)
        self.assertEqual(self.native.panics[0],
                         ["/fake/hydractl", "panic", "--device", LINUX_NAME, "--channel", "1"])
        for _ in range(5):
            self.now += 1
            self.assertEqual(self.request("heartbeat", {"lease_id": replacement["lease_id"]})[0], 200)
        self.assertEqual(len(self.native.panics), 1)
        self.assertEqual(self.request("disarm", {"lease_id": old["lease_id"]})[0], 409)
        self.assertTrue(self.service.status()["armed"])

    def test_channel_change_releases_previous_channel_before_new_arm(self):
        self.arm(channel=1)
        replacement = self.arm(channel=2)
        self.assertEqual(self.native.panics[0][-1], "1")
        self.assertEqual(replacement["channel"], 2)

    def test_same_owner_fast_restart_preserves_local_release_deadlines(self):
        old = self.arm()
        self.assertEqual(self.request("disarm", {"lease_id": old["lease_id"]})[0], 200)
        replacement = self.arm()
        self.assertNotEqual(old["lease_id"], replacement["lease_id"])
        self.assertTrue(self.service.status()["armed"])
        self.assertEqual(len(self.native.panics), 1)

    def test_new_owner_waits_after_stop_or_expiry_and_stale_tokens_stay_harmless(self):
        for ending in ("stop", "expiry"):
            with self.subTest(ending=ending):
                self.service.close()
                self.native = Native()
                self.service = MidiSafetyService(Path("/fake/hydractl"), runner=self.native,
                                                 clock=lambda: self.now, start_thread=False)
                self.addCleanup(self.service.close)
                old = self.arm()
                if ending == "stop":
                    self.request("disarm", {"lease_id": old["lease_id"]})
                else:
                    self.now += TIMEOUT_MS / 1000
                    self.service.check_timeout()
                settling_started = self.now
                payload = {"port_name": BROWSER_NAME, "channel": 1, "owner_id": OTHER_OWNER}
                code, body = self.request("arm", payload)
                self.assertEqual(code, 409)
                self.assertIn("Wait 5 seconds", body["error"])
                self.assertFalse(self.service.status()["armed"])
                self.now = settling_started + SETTLING_MS / 1000 - 0.001
                code, body = self.request("arm", payload)
                self.assertEqual(code, 409)
                self.assertIn("Wait 1 second", body["error"])
                self.now = settling_started + SETTLING_MS / 1000
                replacement = self.arm(owner_id=OTHER_OWNER)
                self.assertEqual(len(self.native.panics), 2, "handover finishes with a native panic before new notes")
                for action in ("heartbeat", "disarm"):
                    self.assertEqual(self.request(action, {"lease_id": old["lease_id"]})[0], 409)
                self.assertEqual(len(self.native.panics), 2)
                self.assertEqual(self.request("heartbeat", {"lease_id": replacement["lease_id"]})[0], 200)

    def test_live_owner_replacement_covers_old_readiness_deadline_and_release_horizon(self):
        old = self.arm()
        started = self.now
        payload = {"port_name": BROWSER_NAME, "channel": 1, "owner_id": OTHER_OWNER}
        code, body = self.request("arm", payload)
        self.assertEqual(code, 409)
        self.assertIn("Wait 8 seconds", body["error"])
        self.assertFalse(self.service.status()["armed"])
        self.assertEqual(len(self.native.panics), 1)
        self.assertEqual(self.service.status()["last_reason"], "lease_replaced")
        self.now = started + SETTLING_MS / 1000
        self.assertEqual(self.request("arm", payload)[0], 409,
                         "a revoked live tab can still send until its old readiness deadline")
        self.now = started + (TIMEOUT_MS + SETTLING_MS) / 1000
        replacement = self.arm(owner_id=OTHER_OWNER)
        self.assertEqual(self.service.status()["last_reason"], "handover_cleared")
        for action in ("heartbeat", "disarm"):
            self.assertEqual(self.request(action, {"lease_id": old["lease_id"]})[0], 409)
        self.assertEqual(len(self.native.panics), 2)
        self.assertEqual(self.request("heartbeat", {"lease_id": replacement["lease_id"]})[0], 200)

    def test_transient_native_panic_timeout_retries_before_acknowledging_stop(self):
        old = self.arm()
        failed = False

        def transient(argv, **options):
            nonlocal failed
            if argv[1] == "panic" and not failed:
                failed = True
                self.native.calls.append((argv, options))
                raise subprocess.TimeoutExpired(argv, options["timeout"])
            return self.native(argv, **options)

        self.service._runner = transient
        code, body = self.request("disarm", {"lease_id": old["lease_id"]})
        self.assertEqual(code, 200, body)
        self.assertEqual(len(self.native.panics), 2)
        self.assertTrue(self.service.status()["last_panic_ok"])
        self.assertEqual([argv[1] for argv, _ in self.native.calls][-4:], ["list", "panic", "list", "panic"])

    def test_failed_final_handover_panic_cannot_grant_new_owner(self):
        old = self.arm()
        self.request("disarm", {"lease_id": old["lease_id"]})
        self.now += SETTLING_MS / 1000
        def fail_panic(argv, **options):
            if argv[1] == "panic":
                self.native.calls.append((argv, options))
                raise subprocess.TimeoutExpired(argv, options["timeout"])
            return self.native(argv, **options)

        self.service._runner = fail_panic
        payload = {"port_name": BROWSER_NAME, "channel": 1, "owner_id": OTHER_OWNER}
        self.assertEqual(self.request("arm", payload)[0], 503)
        self.assertFalse(self.service.status()["armed"])
        self.assertEqual(self.service.status()["last_reason"], "handover_cleared")
        self.service._runner = self.native
        self.arm(owner_id=OTHER_OWNER)
        self.assertEqual(len(self.native.panics), 4)

    def test_hotplug_reused_address_never_sends_to_another_instrument(self):
        lease = self.arm()
        self.native.listing = LINUX_LIST.replace(LINUX_NAME, "Other Instrument: MIDI 1")
        self.assertEqual(self.request("disarm", {"lease_id": lease["lease_id"]})[0], 503)
        self.assertEqual(self.native.panics, [])
        self.assertFalse(self.service.status()["last_panic_ok"])
        self.assertFalse(self.service.status()["armed"])

    def test_hotplug_new_address_keeps_matching_unique_hydrasynth_name(self):
        lease = self.arm()
        self.native.listing = LINUX_LIST.replace("24:0", "28:0")
        self.assertEqual(self.request("disarm", {"lease_id": lease["lease_id"]})[0], 200)
        self.assertEqual(self.native.panics[0][3], LINUX_NAME)

    def test_ambiguous_names_and_input_only_ports_do_not_arm(self):
        self.native.listing = LINUX_LIST.replace("  [1]", f"  [2] {LINUX_NAME} (28:0)\n  [1]")
        self.assertEqual(self.request("arm", {"port_name": BROWSER_NAME, "channel": 1, "owner_id": OWNER})[0], 409)
        self.native.listing = LINUX_LIST.replace(f"  [1] {LINUX_NAME} (24:0)\n", "")
        self.assertEqual(self.request("arm", {"port_name": BROWSER_NAME, "channel": 1, "owner_id": OWNER})[0], 503)
        self.assertFalse(self.service.status()["armed"])
        self.assertEqual(self.native.panics, [])

    def test_invalid_payloads_never_enumerate_or_send(self):
        for name in ("24:0", "Other Keyboard", "HYDRASYNTH\nmalformed", "HYDRASYNTH" * 100, None):
            self.assertEqual(self.request("arm", {"port_name": name, "channel": 1, "owner_id": OWNER})[0], 400)
        for channel in (True, "1", 0, 17, 1.0):
            self.assertEqual(self.request("arm", {"port_name": BROWSER_NAME, "channel": channel, "owner_id": OWNER})[0], 400)
        for owner in (None, "", "a" * 31, "a" * 33, "g" * 32, 1, "A" * 32):
            self.assertEqual(self.request("arm", {"port_name": BROWSER_NAME, "channel": 1, "owner_id": owner})[0], 400)
        self.assertEqual(self.request("heartbeat", {"lease_id": "not-ascii 🎹"})[0], 409)
        self.assertEqual(self.native.calls, [])

    def test_native_timeouts_missing_binary_and_failure_are_bounded_errors(self):
        for failure in ("timeout", "missing", "exit"):
            self.native.fail = failure
            code, body = self.request("arm", {"port_name": BROWSER_NAME, "channel": 1, "owner_id": OWNER})
            self.assertEqual(code, 503)
            self.assertFalse(body["ok"])
            self.assertFalse(self.service.status()["armed"])

    def test_shutdown_releases_once_and_rejects_rearming(self):
        self.arm()
        self.service.close()
        self.service.close()
        self.assertEqual(len(self.native.panics), 1)
        self.assertEqual(self.service.status()["last_reason"], "shutdown")
        self.assertEqual(self.request("arm", {"port_name": BROWSER_NAME, "channel": 1, "owner_id": OWNER})[0], 503)

    def test_independent_thread_releases_without_any_more_http_requests(self):
        self.service.close()
        self.service = MidiSafetyService(Path("/fake/hydractl"), runner=self.native, clock=lambda: self.now)
        self.addCleanup(self.service.close)
        self.arm()
        self.now += TIMEOUT_MS / 1000
        self.assertTrue(self.native.panicked.wait(1), "watchdog did not independently send panic")
        self.assertFalse(self.service.status()["armed"])


class MidiSafetyHTTPTests(unittest.TestCase):
    def setUp(self):
        self.native = Native()
        self.service = MidiSafetyService(Path("/fake/hydractl"), runner=self.native, start_thread=False)
        self.server = DashboardHTTPServer(("127.0.0.1", 0), handler_for(SnapshotStore("demo"), midi_safety=self.service))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.service.close()

    def request(self, path, body=None, headers=None, method="POST"):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, "/api/midi-safety/" + path, body,
                           headers or {"Content-Type": "application/json"})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_same_origin_end_to_end_and_status(self):
        self.assertFalse(self.request("status", method="GET")[1]["armed"])
        code, lease = self.request("arm", json.dumps({"port_name": BROWSER_NAME, "channel": 1, "owner_id": OWNER}),
                                   {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}"})
        self.assertEqual(code, 200)
        token = json.dumps({"lease_id": lease["lease_id"]})
        self.assertEqual(self.request("heartbeat", token)[0], 200)
        self.assertEqual(self.request("disarm", token)[0], 200)
        self.assertEqual(len(self.native.panics), 1)
        self.assertEqual(self.request("heartbeat", token)[0], 409)

    def test_frontend_safety_module_is_served(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request("GET", "/midi-safety.js")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertIn("javascript", response.getheader("Content-Type", ""))
            self.assertIn(b"globalThis.HydraMidiSafety", response.read())
        finally:
            connection.close()

    def test_origin_json_and_size_guards_prevent_hardware_access(self):
        for headers, expected in (
            ({"Origin": "https://example.com", "Content-Type": "application/json"}, 403),
            ({"Host": f"attacker.example:{self.port}", "Content-Type": "application/json"}, 403),
            ({"Sec-Fetch-Site": "cross-site", "Content-Type": "application/json"}, 403),
            ({"Content-Type": "text/plain"}, 415),
            ({"Content-Type": "application/json", "Transfer-Encoding": "chunked"}, 415),
            ({"Content-Type": "application/json", "Content-Length": "2049"}, 413),
        ):
            self.assertEqual(self.request("arm", "{}", headers)[0], expected)
        for body in ("[]", "null", "broken"):
            self.assertEqual(self.request("arm", body)[0], 400)
        self.assertEqual(self.request("arm", method="GET")[0], 405)
        self.assertEqual(self.native.calls, [])


if __name__ == "__main__":
    unittest.main()
