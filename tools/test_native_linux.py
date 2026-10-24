#!/usr/bin/env python3
"""Exercise native Linux MIDI/audio against disposable ALSA peers.

No physical MIDI destination or microphone is opened. MIDI tests require an
accessible /dev/snd/seq; only its absence causes a skip. Audio tests use a
private ALSA file/null configuration and known synthetic samples.
"""

import json
import math
import os
from pathlib import Path
import queue
import shlex
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest


ROOT = Path(__file__).resolve().parent.parent
MIDI = ROOT / "build/hydractl"
AUDIO = ROOT / "build/hydra-audio"
PEER = ROOT / "build/test-alsa-peer"
AUDIO_FAULT = ROOT / "build/test-alsa-audio-fault.so"


class JsonProcess:
    """Read both pipes continuously, preserving event order and diagnostics."""

    def __init__(self, args, env=None):
        self.process = subprocess.Popen(
            [str(arg) for arg in args], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, env=env,
        )
        self.lines = queue.Queue()
        self.pending = []
        self.history = []
        self.errors = []
        self.request_id = 0
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.error_reader = threading.Thread(target=self._read_errors, daemon=True)
        self.reader.start()
        self.error_reader.start()

    def _read(self):
        for line in self.process.stdout:
            try:
                item = json.loads(line)
            except ValueError:
                item = {"invalid_json": line}
            self.history.append(item)
            self.lines.put(item)
        self.lines.put(None)

    def _read_errors(self):
        self.errors.extend(self.process.stderr)

    def send_line(self, line):
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

    def wait_for(self, predicate, timeout=3):
        deadline = time.monotonic() + timeout
        while True:
            for index, item in enumerate(self.pending):
                if predicate(item):
                    return self.pending.pop(index)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"Timed out; events={self.history!r}; stderr={''.join(self.errors)}")
            try:
                item = self.lines.get(timeout=remaining)
            except queue.Empty:
                continue
            if item is None:
                self.error_reader.join(timeout=0.2)
                raise AssertionError(f"Unexpected process exit; events={self.history!r}; stderr={''.join(self.errors)}")
            if "invalid_json" in item:
                raise AssertionError(f"Non-JSON process output: {item['invalid_json']}")
            self.pending.append(item)

    def request(self, op, expect_ok=True, **fields):
        self.request_id += 1
        request_id = self.request_id
        self.send_line(json.dumps({"id": request_id, "v": 1, "op": op, **fields}))
        reply = self.wait_for(lambda item: item.get("id") == request_id)
        if reply.get("ok") is not expect_ok:
            raise AssertionError(f"Unexpected response to {op}: {reply}")
        return reply

    def midi(self, message, timeout=3):
        return self.wait_for(lambda item: item.get("bytes") == message, timeout)

    def send_midi(self, message):
        self.send_line("send " + " ".join(f"{byte:02x}" for byte in message))
        reply = self.wait_for(lambda item: item.get("type") == "sent")
        if not reply["ok"]:
            raise AssertionError(f"Virtual MIDI peer could not send {message}")

    def finish(self, timeout=3):
        result = self.process.wait(timeout=timeout)
        self.reader.join(timeout=1)
        self.error_reader.join(timeout=1)
        return result

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.finish()
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.finish()
        else:
            self.finish()
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()


def ensure_peer():
    source = ROOT / "tools/alsa_test_peer.c"
    if PEER.exists() and PEER.stat().st_mtime >= source.stat().st_mtime:
        return
    PEER.parent.mkdir(exist_ok=True)
    args = shlex.split(os.environ.get("CC", "cc"))
    args += ["-std=c17", "-Wall", "-Wextra", "-Wpedantic", "-O2"]
    args += shlex.split(os.environ.get("CPPFLAGS", ""))
    headers = ROOT / "var/native-deps/usr/include"
    if headers.exists():
        args += ["-isystem", str(headers)]
    args += [str(source), "-l:libasound.so.2", "-o", str(PEER)]
    subprocess.run(args, check=True, capture_output=True, text=True)


def ensure_audio_faults():
    source = ROOT / "tools/alsa_audio_fault.c"
    if AUDIO_FAULT.exists() and AUDIO_FAULT.stat().st_mtime >= source.stat().st_mtime:
        return
    args = shlex.split(os.environ.get("CC", "cc"))
    args += ["-std=c17", "-Wall", "-Wextra", "-Wpedantic", "-shared", "-fPIC"]
    args += shlex.split(os.environ.get("CPPFLAGS", ""))
    headers = ROOT / "var/native-deps/usr/include"
    if headers.exists():
        args += ["-isystem", str(headers)]
    args += [str(source), "-ldl", "-o", str(AUDIO_FAULT)]
    subprocess.run(args, check=True, capture_output=True, text=True)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux ALSA integration only")
@unittest.skipUnless(Path("/dev/snd/seq").exists(), "ALSA sequencer /dev/snd/seq is unavailable")
class MidiIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not MIDI.exists():
            raise RuntimeError("Build native tools with make before running this test")
        ensure_peer()

    def setUp(self):
        self.peer = JsonProcess([PEER])
        self.addCleanup(self.peer.close)
        self.device = self.peer.wait_for(lambda item: item.get("type") == "ready")
        self.server = JsonProcess([MIDI, "serve", "--device", self.device["name"]])
        self.addCleanup(self.server.close)
        ready = self.server.wait_for(lambda item: item.get("type") == "ready")
        self.assertTrue(ready["connected"])
        self.assertTrue(ready["input_connected"])
        self.assertTrue(ready["scheduler"])
        self.assertTrue(ready["event_writer"])

    def test_discovery_numeric_selection_and_protocol(self):
        listing = subprocess.run([MIDI, "list"], capture_output=True, text=True, check=True)
        self.assertIn(self.device["name"], listing.stdout)
        self.assertTrue(self.server.request("ping")["pong"])
        state = self.server.request("status")
        self.assertTrue(state["connected"])
        self.assertTrue(state["input_connected"])
        self.server.request("capabilities")
        self.server.request("state")
        second = JsonProcess([MIDI, "serve", "--device", self.device["address"], "--no-input"])
        try:
            ready = second.wait_for(lambda item: item.get("type") == "ready")
            self.assertFalse(ready["input_connected"])
            second.request("shutdown")
            self.assertEqual(second.finish(), 0)
        finally:
            second.close()

    def test_notes_control_and_nrpn_bytes(self):
        self.server.request("note_on", note=60, velocity=87, channel=3)
        self.peer.midi([0x92, 60, 87])
        self.server.request("note_off", note=60, channel=3)
        self.peer.midi([0x82, 60, 0])
        self.server.request("cc", number=74, value=91, channel=3)
        self.peer.midi([0xB2, 74, 91])
        self.server.request("nrpn", parameter=345, value=12345, channel=3)
        for controller, value in ((99, 2), (98, 89), (6, 96), (38, 57)):
            self.peer.midi([0xB2, controller, value])

    def test_cli_panic_releases_every_pitch_without_changing_arp_octave(self):
        # The watchdog starts a fresh CLI, so it cannot know which notes the
        # browser left sounding. Capture the actual bytes on a disposable peer.
        result = subprocess.run([MIDI, "panic", "--device", self.device["name"],
                                 "--channel", "3"], capture_output=True, text=True, timeout=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.peer.midi([0xB2, 123, 0])  # Last message is a receipt barrier.
        messages = [event["bytes"] for event in self.peer.history if "bytes" in event]
        expected = [[0xB2, 64, 0], *[[0x82, note, 0] for note in range(128)], [0xB2, 123, 0]]
        self.assertEqual(messages, expected)

    def test_feedback_user_takeover_and_nrpn(self):
        self.peer.send_midi([0x91, 67, 77])
        note = self.server.wait_for(lambda item: item.get("event") == "note_on")
        self.assertEqual((note["source"], note["channel"], note["note"]), ("user", 2, 67))
        self.peer.send_midi([0x81, 67, 0])
        self.server.wait_for(lambda item: item.get("event") == "note_off")
        self.peer.send_midi([0xB1, 74, 55])
        self.server.wait_for(lambda item: item.get("event") == "cc" and item.get("number") == 74)
        blocked = self.server.request("cc", expect_ok=False, channel=2, number=74, value=100)
        self.assertEqual(blocked["error"]["code"], "user_takeover")
        self.server.request("cc", channel=2, number=74, value=100, force=True)
        self.peer.midi([0xB1, 74, 100])
        for controller, value in ((99, 2), (98, 89), (6, 96), (38, 57)):
            self.peer.send_midi([0xB1, controller, value])
        nrpn = self.server.wait_for(lambda item: item.get("event") == "nrpn" and item.get("resolution_bits") == 14)
        self.assertEqual((nrpn["parameter"], nrpn["value"], nrpn["source"]), (345, 12345, "user"))

    def test_scheduled_play_and_active_note_cancel(self):
        start = time.monotonic()
        queued = self.server.request("play", notes=[62], velocity=81, delay_ms=100, duration_ms=200)
        note_on = self.peer.midi([0x90, 62, 81])
        self.assertGreaterEqual(note_on["time"] - start, 0.07)
        rejected = self.server.request("cancel", expect_ok=False, job=queued["job"])
        self.assertEqual(rejected["error"]["code"], "cannot_cancel_active_notes")
        note_off = self.peer.midi([0x80, 62, 0])
        self.assertGreaterEqual(note_off["time"] - note_on["time"], 0.15)
        self.assertLess(note_off["time"] - note_on["time"], 1.0)
        self.server.wait_for(lambda item: item.get("event") == "job" and item.get("job") == queued["job"] and item.get("state") == "complete")

    def test_cancel_before_start_has_no_midi(self):
        queued = self.server.request("play", notes=[63], delay_ms=150, duration_ms=100)
        canceled = self.server.request("cancel", job=queued["job"])
        self.assertEqual(canceled["state"], "canceled")
        self.assertEqual(canceled["removed_events"], 2)
        time.sleep(0.3)
        self.assertFalse(any(item.get("bytes", [])[:2] == [0x90, 63] for item in self.peer.history))
        self.assertEqual(self.server.request("status")["queued_events"], 0)

    def test_ramp_cancel_is_a_barrier(self):
        ramp = self.server.request("ramp", number=74, **{"from": 0.0, "to": 1.0}, duration_ms=800, rate_hz=20)
        self.peer.midi([0xB0, 74, 0])
        canceled = self.server.request("cancel", job=ramp["job"])
        self.assertEqual(canceled["state"], "canceled")
        time.sleep(0.07)  # Drain MIDI already sent before the cancellation response.
        count = sum(item.get("bytes", [])[:2] == [0xB0, 74] for item in self.peer.history)
        time.sleep(0.15)
        self.assertEqual(sum(item.get("bytes", [])[:2] == [0xB0, 74] for item in self.peer.history), count)
        self.assertEqual(self.server.request("status")["queued_events"], 0)

    def test_shutdown_releases_notes_and_sustain(self):
        self.server.request("note_on", note=65, velocity=90, channel=4)
        self.peer.midi([0x93, 65, 90])
        self.server.request("cc", number=64, value=127, channel=4)
        self.peer.midi([0xB3, 64, 127])
        self.server.request("shutdown")
        stopped = self.server.wait_for(lambda item: item.get("event") == "stopping")
        self.assertTrue(stopped["panic_ok"])
        self.assertEqual(self.server.finish(), 0)
        self.peer.midi([0x83, 65, 0])
        for channel in range(16):
            for controller in (64, 123):
                self.peer.midi([0xB0 + channel, controller, 0])
        self.assertFalse(any(event.get("bytes", [])[:2] == [0xB0 + channel, 120]
                             for channel in range(16) for event in self.peer.history),
                         "CC120 is ARP Octave on Hydrasynth, not a panic message")

    def test_device_disconnect_stops_without_hanging(self):
        self.peer.send_line("disconnect")
        self.assertTrue(self.peer.wait_for(lambda item: item.get("type") == "disconnected")["ok"])
        stopped = self.server.wait_for(lambda item: item.get("event") == "stopping")
        self.assertEqual(stopped["reason"], "midi_disconnected")
        self.assertFalse(stopped["panic_ok"])
        self.assertNotEqual(self.server.finish(), 0)

    def test_no_input_disconnect_with_partial_stdin(self):
        no_input = JsonProcess([MIDI, "serve", "--device", self.device["address"], "--no-input"])
        self.addCleanup(no_input.close)
        ready = no_input.wait_for(lambda item: item.get("type") == "ready")
        self.assertFalse(ready["input_connected"])
        # A partial command must not hide a device-removal notification behind
        # a blocking line read, including when MIDI feedback is disabled.
        no_input.process.stdin.write('{"v":1,"id":"unfinished"')
        no_input.process.stdin.flush()
        self.peer.send_line("disconnect")
        self.peer.wait_for(lambda item: item.get("type") == "disconnected")
        stopped = no_input.wait_for(lambda item: item.get("event") == "stopping")
        self.assertEqual(stopped["reason"], "midi_disconnected")
        self.assertFalse(stopped["panic_ok"])
        self.assertNotEqual(no_input.finish(), 0)

    def test_ambiguous_device_name_is_rejected(self):
        extra = JsonProcess([PEER])
        self.addCleanup(extra.close)
        extra.wait_for(lambda item: item.get("type") == "ready")
        result = subprocess.run([MIDI, "serve", "--device", "Hydra Linux Test"],
                                input="", capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ambiguous", result.stderr.lower())

    def test_input_only_disconnect_still_releases_output_notes(self):
        split_peer = JsonProcess([PEER, "--split"])
        self.addCleanup(split_peer.close)
        device = split_peer.wait_for(lambda item: item.get("type") == "ready")
        split_server = JsonProcess([MIDI, "serve", "--device", device["name"]])
        self.addCleanup(split_server.close)
        ready = split_server.wait_for(lambda item: item.get("type") == "ready")
        self.assertTrue(ready["input_connected"])
        split_server.request("note_on", note=66, velocity=79, channel=6)
        split_peer.midi([0x95, 66, 79])
        split_peer.send_line("disconnect-input")
        self.assertTrue(split_peer.wait_for(lambda item: item.get("type") == "input_disconnected")["ok"])
        stopped = split_server.wait_for(lambda item: item.get("event") == "stopping")
        self.assertEqual(stopped["reason"], "midi_disconnected")
        self.assertTrue(stopped["panic_ok"])
        split_peer.midi([0x85, 66, 0])
        split_peer.midi([0xB5, 64, 0])
        self.assertNotEqual(split_server.finish(), 0)

    def test_stdin_framing_and_malformed_lines(self):
        self.server.process.stdin.write('{"v":1,"id":"fragment",')
        self.server.process.stdin.flush()
        time.sleep(0.03)
        self.server.send_line('"op":"ping"}')
        self.assertTrue(self.server.wait_for(lambda item: item.get("id") == "fragment")["pong"])
        self.server.send_line(
            '{"v":1,"id":"batch1","op":"ping"}\n'
            '{"v":1,"id":"batch2","op":"ping"}'
        )
        for request_id in ("batch1", "batch2"):
            self.assertTrue(self.server.wait_for(lambda item: item.get("id") == request_id)["pong"])
        # A NUL cannot truncate a line into an acceptable command, and the next
        # well-formed line must still be processed after rejecting it.
        self.server.send_line(
            '\x00{"v":1,"id":"invalid","op":"cc","number":74,"value":12}\n'
            '{"v":1,"id":"after-invalid","op":"ping"}'
        )
        self.server.wait_for(lambda item: item.get("error", {}).get("code") == "invalid_json")
        self.assertTrue(self.server.wait_for(lambda item: item.get("id") == "after-invalid")["pong"])
        self.assertFalse(any(item.get("bytes") == [0xB0, 74, 12] for item in self.peer.history))
        self.server.process.stdin.write(" " * 16385)
        self.server.process.stdin.close()
        self.server.wait_for(lambda item: item.get("error", {}).get("code") == "line_too_long")
        stopped = self.server.wait_for(lambda item: item.get("event") == "stopping")
        self.assertEqual(stopped["reason"], "eof")
        self.assertTrue(stopped["panic_ok"])
        self.assertEqual(self.server.finish(), 0)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux ALSA integration only")
@unittest.skipUnless(Path("/dev/snd/seq").exists(), "ALSA sequencer /dev/snd/seq is unavailable")
class DashboardIntegration(unittest.TestCase):
    """Use the real dashboard bridge and command client with a private broker."""

    @classmethod
    def setUpClass(cls):
        if not MIDI.exists():
            raise RuntimeError("Build native tools with make before running this test")
        ensure_peer()

    def setUp(self):
        # Import only for these integration cases; audio tests need no dashboard
        # dependencies and all paths are isolated from the running user session.
        from hydra_dashboard import CommandBroker, LiveService, ParameterCatalog, SnapshotStore

        temporary = tempfile.TemporaryDirectory(prefix="hydra-broker-native-test-")
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        self.socket_path = directory / "broker.sock"
        self.token_path = directory / "broker.token"
        self.peer = JsonProcess([PEER])
        self.addCleanup(self.peer.close)
        self.device = self.peer.wait_for(lambda item: item.get("type") == "ready")
        self.store = SnapshotStore("live", ParameterCatalog.load())
        self.service = LiveService(self.store, MIDI, self.device["name"], 1, 3.0, False)
        self.addCleanup(self.service.stop)
        self.service.start()
        self.broker = CommandBroker(self.service, self.socket_path, self.token_path)
        self.addCleanup(self.broker.stop)
        self.broker.start()

    def command(self, operation, expect_ok=True, **fields):
        request = {"v": 1, "id": f"integration-{operation}", "op": operation, **fields}
        process = subprocess.run(
            [sys.executable, "-B", str(ROOT / "tools/hydra_command.py"),
             "--socket", str(self.socket_path), "--token-file", str(self.token_path),
             json.dumps(request)], capture_output=True, text=True, timeout=8,
        )
        self.assertEqual(process.returncode, 0 if expect_ok else 1, process.stderr)
        response = json.loads(process.stdout)
        self.assertIs(response["ok"], expect_ok)
        self.assertEqual(response["id"], request["id"])
        return response

    def snapshot(self, predicate, timeout=3):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            state = self.store.snapshot()
            if predicate(state):
                return state
            time.sleep(0.01)
        self.fail(f"Dashboard snapshot did not converge: {self.store.snapshot()!r}")

    def test_command_client_feedback_takeover_and_shutdown(self):
        self.assertTrue(self.command("ping")["pong"])
        self.command("note_on", note=69, velocity=85, channel=5)
        self.peer.midi([0x94, 69, 85])
        self.command("note_off", note=69, channel=5)
        self.peer.midi([0x84, 69, 0])
        self.peer.send_midi([0xB4, 74, 61])
        snapshot = self.snapshot(lambda state: any(
            cc.get("channel") == 5 and cc.get("number") == 74 and cc.get("value") == 61
            for cc in state["state"]["cc"]
        ))
        self.assertTrue(snapshot["bridge"]["connected"])
        self.assertTrue(snapshot["bridge"]["input_connected"])
        self.assertEqual(snapshot["bridge"]["parse_errors"], 0)
        self.assertEqual(snapshot["bridge"]["request_timeouts"], 0)
        denied = self.command("cc", expect_ok=False, channel=5, number=74, value=99)
        self.assertEqual(denied["error"]["code"], "user_takeover")
        self.command("cc", channel=5, number=74, value=99, force=True)
        self.peer.midi([0xB4, 74, 99])
        self.assertEqual(self.command("shutdown", expect_ok=False)["error"]["code"], "broker_forbidden")
        self.broker.stop()
        self.service.stop()
        self.assertEqual(self.service.process.returncode, 0)
        self.assertFalse(self.socket_path.exists())
        self.assertFalse(self.token_path.exists())

    def test_disconnect_reaches_dashboard(self):
        self.peer.send_line("disconnect")
        self.peer.wait_for(lambda item: item.get("type") == "disconnected")
        snapshot = self.snapshot(lambda state: not state["bridge"]["service_running"])
        self.assertIsNotNone(snapshot["bridge"]["error"])
        denied = self.command("ping", expect_ok=False)
        self.assertEqual(denied["error"]["code"], "service_unavailable")


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux ALSA integration only")
class AudioIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not AUDIO.exists():
            raise RuntimeError("Build native tools with make before running this test")
        ensure_audio_faults()

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="hydra-alsa-test-")
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        samples = directory / "samples.raw"
        self.samples = samples
        samples.write_bytes(struct.pack("<ff", 0.25, -0.5) * (48000 * 2))
        config = directory / "asound.conf"
        config.write_text(
            'pcm.hydra_test {\n'
            ' type file\n slave.pcm { type null }\n'
            f' infile "{samples}"\n file "/dev/null"\n format "raw"\n'
            ' hint { show on description "Hydra synthetic input" ioid "Input" }\n}\n'
            'pcm.hydra_null {\n type null\n'
            ' hint { show on description "Hydra silent input" ioid "Input" }\n}\n'
        )
        self.env = dict(os.environ, ALSA_CONFIG_PATH=str(config))

    def meter(self, *args):
        result = subprocess.run([AUDIO, "meter", "--uid", "hydra_test", "--duration", "0.1", "--json", *args],
                                env=self.env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_device_listing_uses_configured_inputs(self):
        # Enumeration must not open/capture each input; this one is unusable
        # until the sample file is restored, but its configured hint remains.
        self.samples.unlink()
        env = dict(self.env, LD_PRELOAD=str(AUDIO_FAULT), HYDRA_TEST_FAULT="list")
        result = subprocess.run([AUDIO, "list", "--json"], env=env,
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        devices = json.loads(result.stdout)["devices"]
        self.assertIn("hydra_test", [device["uid"] for device in devices])

    def test_synthetic_audio_levels_and_channel_selection(self):
        for channel, expected in ((1, 0.25), (2, -0.5)):
            with self.subTest(channel=channel):
                report = self.meter("--channel", str(channel))
                self.assertEqual(report["type"], "meter")
                self.assertEqual(report["channel"], channel)
                self.assertEqual(report["sample_rate"], 48000)
                self.assertEqual(report["frames"], 4800)
                self.assertEqual(report["samples"], report["frames"])
                self.assertAlmostEqual(report["dc"], expected, places=6)
                self.assertAlmostEqual(report["rms"], abs(expected), places=6)
                self.assertAlmostEqual(report["peak"], abs(expected), places=6)
                self.assertAlmostEqual(report["rms_dbfs"], 20 * math.log10(abs(expected)), places=5)
                self.assertFalse(report["clipping"])
                self.assertFalse(report["interrupted"])

    def test_null_capture_is_silent(self):
        result = subprocess.run([AUDIO, "meter", "--uid", "hydra_null", "--duration", "0.1", "--json"],
                                env=self.env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["frames"], 4800)
        for key in ("dc", "rms", "peak"):
            self.assertEqual(report[key], 0)
        self.assertFalse(report["clipping"])

    def test_overrun_and_stalled_capture_do_not_report_valid_levels(self):
        for fault, message in (("overrun", "overran"), ("timeout", "requested audio frames")):
            with self.subTest(fault=fault):
                started = time.monotonic()
                result = subprocess.run(
                    [AUDIO, "meter", "--uid", "hydra_null", "--duration", "0.1", "--json"],
                    env=dict(self.env, LD_PRELOAD=str(AUDIO_FAULT), HYDRA_TEST_FAULT=fault),
                    capture_output=True, text=True, timeout=3,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertIn(message, result.stderr)
                self.assertLess(time.monotonic() - started, 2)

    def test_delayed_capture_still_returns_all_requested_frames(self):
        result = subprocess.run(
            [AUDIO, "meter", "--uid", "hydra_test", "--duration", "0.1", "--json"],
            env=dict(self.env, LD_PRELOAD=str(AUDIO_FAULT), HYDRA_TEST_FAULT="delayed"),
            capture_output=True, text=True, timeout=3,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["frames"], 4800)
        self.assertAlmostEqual(report["rms"], 0.25, places=6)

    def test_capture_signal_finishes_with_report(self):
        process = subprocess.Popen([AUDIO, "meter", "--uid", "hydra_null", "--duration", "10", "--json"],
                                   env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            time.sleep(0.15)
            process.send_signal(signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=3)
            self.assertEqual(process.returncode, 143, stderr)
            self.assertTrue(json.loads(stdout)["interrupted"])
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_missing_device_is_actionable(self):
        result = subprocess.run([AUDIO, "meter", "--uid", "hydra_missing_device", "--duration", "0.1", "--json"],
                                env=self.env, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("hydra_missing_device", result.stderr)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
