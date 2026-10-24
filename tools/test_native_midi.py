#!/usr/bin/env python3
"""Persistent native transport tests; hardware tests use disposable ALSA peers."""

from pathlib import Path
import subprocess
import sys
import time
import unittest

from native_midi import NativeMidiError, NativeMidiTransport
from midi_safety import MidiSafetyService


FAKE = r'''
import json, sys, time
mode = sys.argv[1]
if mode == "bad_ready":
    print(json.dumps({"type": "ready", "connected": True, "scheduler": False}), flush=True)
    time.sleep(3)
else:
    print(json.dumps({"type": "ready", "connected": True, "scheduler": True}), flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        if mode == "exit":
            break
        if mode == "stall":
            time.sleep(3)
        if mode == "oversize":
            print("x" * 20000, flush=True)
            time.sleep(3)
        if mode == "events":
            for i in range(3000):
                print(json.dumps({"type": "event", "event": "note_off", "note": i % 128}))
        print(json.dumps({"type": "response", "id": request["id"], "ok": True,
                          "op": request["op"]}), flush=True)
        if request["op"] == "shutdown":
            break
'''


class TransportTests(unittest.TestCase):
    def transport(self, mode):
        def popen(_args, **kwargs):
            return subprocess.Popen([sys.executable, "-u", "-c", FAKE, mode], **kwargs)
        transport = NativeMidiTransport("unused", "unused", 3, timeout=0.3, popen=popen)
        self.addCleanup(transport.close)
        return transport

    def test_drains_unsolicited_events_and_retains_one_response(self):
        transport = self.transport("events")
        for _ in range(3):
            self.assertEqual(transport.request({"op": "ping"})["op"], "ping")
        self.assertIsNone(transport._response)
        transport.close()
        transport.close()
        self.assertIsNotNone(transport.process.poll())

    def test_exit_stall_and_oversized_response_fail_with_bounded_wait(self):
        for mode in ("exit", "stall", "oversize"):
            with self.subTest(mode=mode):
                transport = self.transport(mode)
                start = time.monotonic()
                with self.assertRaises(NativeMidiError):
                    transport.request({"op": "ping"})
                transport.close()
                self.assertLess(time.monotonic() - start, 1.5)
                self.assertIsNotNone(transport.process.poll())

    def test_missing_scheduler_cannot_start(self):
        with self.assertRaises(NativeMidiError):
            self.transport("bad_ready")


@unittest.skipUnless(sys.platform.startswith("linux") and Path("/dev/snd/seq").exists(),
                     "Disposable ALSA peer requires the Linux sequencer")
class NativeTransportIntegration(unittest.TestCase):
    def setUp(self):
        from test_native_linux import JsonProcess, MIDI, PEER, ensure_peer
        ensure_peer()
        self.peer = JsonProcess([PEER])
        self.addCleanup(self.peer.close)
        device = self.peer.wait_for(lambda item: item.get("type") == "ready")
        self.transport = NativeMidiTransport(MIDI, device["name"], 3)
        self.addCleanup(self.transport.close)

    def test_native_note_releases_without_another_browser_command(self):
        self.transport.request({"op": "play", "notes": [60, 64, 67], "velocity": 32,
                                "duration_ms": 150, "channel": 3})
        started = self.peer.midi([0x92, 60, 32])["time"]
        for note in (60, 64, 67):
            released = self.peer.midi([0x82, note, 0])
            self.assertGreaterEqual(released["time"] - started, 0.1)
            self.assertLess(released["time"] - started, 0.8)

    def test_panic_releases_sustain_and_cancels_queued_note_releases(self):
        self.transport.request({"op": "cc", "number": 64, "value": 127, "channel": 3})
        self.transport.request({"op": "play", "notes": [60], "velocity": 32,
                                "duration_ms": 1000, "channel": 3})
        self.peer.midi([0x92, 60, 32])
        result = self.transport.request({"op": "panic"})
        self.assertGreater(result["canceled_jobs"], 0)
        self.peer.midi([0xB2, 64, 0])
        self.peer.midi([0x82, 60, 0])
        self.assertEqual(self.transport.request({"op": "status"})["queued_events"], 0)


@unittest.skipUnless(sys.platform.startswith("linux") and Path("/dev/snd/seq").exists(),
                     "Disposable ALSA peer requires the Linux sequencer")
class NativeSafetyIntegration(unittest.TestCase):
    def setUp(self):
        from test_native_linux import JsonProcess, MIDI, PEER, ensure_peer
        ensure_peer()
        self.peer = JsonProcess([PEER])
        self.addCleanup(self.peer.close)
        device = self.peer.wait_for(lambda item: item.get("type") == "ready")
        self.service = MidiSafetyService(MIDI, native_enabled=True)
        self.addCleanup(self.service.close)
        # Restrict every resolution (including the emergency CLI fallback) to
        # this disposable peer. No physical destination can be selected.
        self.service._resolve = lambda _name, **_options: device["name"]
        self.lease = self.service.arm({"port_name": "Hydrasynth virtual test",
            "channel": 3, "owner_id": "a" * 32, "transport": "native"})

    def start_sustained_note(self):
        self.service.send({"lease_id": self.lease["lease_id"], "commands": [
            {"op": "cc", "number": 64, "value": 127},
            {"op": "play", "notes": [60], "velocity": 32, "duration_ms": 5000},
        ]})
        return self.peer.midi([0x92, 60, 32])["time"]

    def test_missing_browser_heartbeats_release_real_native_notes(self):
        started = self.start_sustained_note()
        self.peer.midi([0xB2, 64, 0], timeout=4)
        stopped = self.peer.midi([0x82, 60, 0])["time"]
        self.assertGreater(stopped - started, 1.5)
        self.assertLess(stopped - started, 4)
        status = self.service.status()
        self.assertFalse(status["armed"])
        self.assertEqual(status["last_reason"], "heartbeat_timeout")
        self.assertTrue(status["last_panic_ok"])

    def test_killed_native_child_uses_cli_fallback_and_revokes_lease(self):
        self.start_sustained_note()
        native = self.service._native
        native.process.kill()
        native.process.wait(timeout=1)
        # A still-responsive browser must not extend the dead child's lease.
        code, _ = self.service.dispatch("POST", "/api/midi-safety/heartbeat",
                                         {"lease_id": self.lease["lease_id"]})
        self.assertEqual(code, 409)
        self.peer.midi([0xB2, 64, 0])
        for note in range(128):
            self.peer.midi([0x82, note, 0])
        self.peer.midi([0xB2, 123, 0])
        self.assertEqual(self.service.status()["last_reason"], "transport_failed")
        self.assertTrue(self.service.status()["last_panic_ok"])
        self.assertNotIn([0xB2, 120, 0], [item.get("bytes") for item in self.peer.history])


if __name__ == "__main__":
    unittest.main(verbosity=2)
