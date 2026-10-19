#!/usr/bin/env python3
"""Deterministic performance scheduling and API checks; no physical ports."""
import copy
import threading
import unittest
from unittest import mock

import robot_drum_performance
from robot_drum_performance import (DrumPerformance, DrumPerformanceSettling, DrumPerformanceBounds,
                                    DrumPerformanceSessionError, DRUM_PROFILES,
                                    MIN_HIT_INTERVAL_MS, LATE_MS, REST_SETTLE_MS, REST_POLL_MS)
from robot_control import RobotControlService
from test_robot_control import FakeRibs, FakeDrums, FakeHead
from test_robot_serial import FakeSerialTest


class Hardware(FakeDrums):
    def __init__(self):
        super().__init__()
        self._lock = threading.RLock()
        self.time = 10000
        self.moves = []
        self.fault = None
        self.settling = set()
        self.outside = set()
        self.recoveries = []
        self.performance = DrumPerformance(self, now=lambda: self.time, threaded=False)

    def performance_prepare(self, instruments, cancelled):
        self.moves.extend((motor, DRUM_PROFILES[motor]["rest"], 500) for motor in instruments)

    def performance_verify(self, motor, rest, cancelled):
        if self.fault == motor:
            raise RuntimeError(f"Drum {motor} failed read-back")
        if motor in self.outside:
            raise DrumPerformanceBounds(f"Drum {motor} position is outside its bounds.")
        if motor in self.settling:
            raise DrumPerformanceSettling(f"Drum {motor} raised rest was not confirmed: read {rest - 35}, "
                                         f"expected {rest} ± 20. No hit was sent.")

    def performance_move(self, motor, target, duration, cancelled, **kwargs):
        if self.fault == motor:
            raise RuntimeError(f"Drum {motor} failed read-back")
        self.moves.append((motor, target, duration))

    def performance_recover(self, motor, cancelled):
        target = 2590 if motor == 3 else DRUM_PROFILES[motor]["rest"]
        self.recoveries.append(motor)
        self.moves.append((motor, target, 2000))
        return {"target": target, "duration_ms": 2000}

    def performance_stage(self, motor, rest, target, duration, cancelled, **kwargs):
        self.performance_verify(motor, rest, cancelled)
        return {"target": target, "duration": duration, "sampled_ms": self.time}

    def performance_commit(self, motor, target, ticket, cancelled, **kwargs):
        self.performance_move(motor, target, ticket["duration"], cancelled)

    def request_stop(self):
        super().request_stop()
        self.performance.invalidate()

    def advance(self, milliseconds):
        self.time += milliseconds
        self.performance.pump()


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.hardware = Hardware()
        self.performance = self.hardware.performance

    def ready(self, instruments=None):
        self.performance.start("run", instruments or [0, 1, 2, 3])
        self.assertEqual(self.performance.snapshot()["state"], "preparing")
        self.performance.schedule("run", [])
        self.hardware.advance(500)
        self.assertEqual(self.performance.snapshot()["state"], "ready")

    def event(self, name="a", motor=0, after=300):
        return {"id": name, "motor_id": motor, "contact_ms": self.hardware.time + after}

    def test_prepares_once_and_confirms_rest(self):
        self.performance.start("run", [1, 2])
        self.performance.start("run", [1, 2])
        self.assertEqual(self.hardware.moves, [(1, 1850, 500), (2, 2300, 500)])
        self.hardware.fault = 2
        self.hardware.advance(500)
        self.assertEqual(self.performance.snapshot()["state"], "ready")
        self.assertEqual(self.performance.arms[1]["state"], "ready")
        self.assertEqual(self.performance.arms[2]["state"], "error")
        self.performance.start("run", [1, 2])
        self.assertEqual(len(self.hardware.moves), 2)

    def test_fresh_preflight_recoil_waits_for_rest_without_ending_other_arms(self):
        self.ready([0, 2])
        self.hardware.settling.add(2)
        result = self.performance.schedule("run", [self.event("healthy", 0, 700), self.event("recoil", 2, 700)])
        self.assertEqual(result["accepted"], ["healthy", "recoil"])
        self.hardware.advance(100)
        arm = self.performance.arms[2]
        deadline = arm["settle_deadline_ms"]
        self.assertEqual(arm["state"], "returning")
        self.assertTrue(arm["settling"])
        self.assertEqual(self.performance.snapshot()["state"], "ready")
        self.assertEqual(len(self.hardware.moves), 2, "position mismatch must not issue a strike or another rest goal")
        self.hardware.advance(REST_POLL_MS)
        self.assertEqual(arm["settle_deadline_ms"], deadline)
        self.hardware.settling.clear()
        self.hardware.advance(REST_POLL_MS)
        self.assertEqual(arm["state"], "ready")
        self.hardware.advance(350)
        self.assertEqual(self.performance.played, 2)
        self.assertEqual(self.performance.skipped, 0)

    def test_long_held_arm_gets_one_fixed_recheck_window_despite_repeated_recoil(self):
        self.ready([2])
        for _ in range(3):
            self.hardware.advance(500)
            self.performance.schedule("run", [])
        original_stage = self.hardware.performance_stage

        def recoiling(motor, rest, *args, **kwargs):
            raise DrumPerformanceSettling(f"Drum {motor} read {rest - 35}, expected {rest} ± 20")

        self.hardware.performance_stage = recoiling
        self.performance.schedule("run", [self.event("recoil", 2, 700)])
        self.hardware.advance(100)
        arm = self.performance.arms[2]
        deadline = arm["settle_deadline_ms"]
        self.assertEqual(deadline, self.hardware.time + REST_SETTLE_MS)
        for _ in range(4):
            # The ordinary rest poll succeeds; the subsequent fresh preflight
            # sees recoil again. Those successful reads cannot renew the window.
            self.hardware.advance(REST_POLL_MS)
            self.assertEqual(arm["state"], "returning")
            self.assertEqual(arm["settle_deadline_ms"], deadline)
            self.assertEqual(self.performance.played, 0)
        self.hardware.performance_stage = original_stage
        self.hardware.advance(REST_POLL_MS)
        self.hardware.advance(200)
        self.assertEqual(self.performance.played, 1)

    def test_arm_failure_survives_other_faults_and_stop_cleanup(self):
        self.ready([0, 2])
        self.performance.schedule("run", [self.event("kick", 0), self.event("snare", 2)])
        self.performance.pump()
        self.hardware.advance(150)
        self.hardware.fault = 2
        self.hardware.advance(150)
        original = self.performance.arms[2]["error"]
        self.assertEqual(original, "Drum 2 failed read-back")
        self.assertIsNone(self.performance.error)
        self.assertEqual(self.performance.schedule("run", []), {"accepted": [], "skipped": []})
        self.hardware.fault = 0
        self.hardware.advance(150)
        self.performance.stop("run")
        self.performance.stop("run")
        self.performance.invalidate()
        state = self.performance.snapshot()
        self.assertEqual(state["state"], "stopped")
        self.assertIsNone(state["error"])
        self.assertEqual(self.performance.arms[2]["error"], original)
        with self.assertRaisesRegex(RuntimeError, "no longer active"):
            self.performance.schedule("run", [])
        with self.assertRaisesRegex(RuntimeError, "no longer active"):
            self.performance.schedule("different-session", [])
        self.hardware.fault = None
        self.performance.start("new", [0, 2])
        self.assertIsNone(self.performance.snapshot()["error"], "a deliberate new session starts with its own diagnostics")

    def test_simultaneous_arms_and_independent_recovery(self):
        self.ready()
        events = [self.event("kick", 0), self.event("snare", 2), self.event("hat", 3),
                  self.event("fast-kick", 0, 500), self.event("next-kick", 0, 650)]
        result = self.performance.schedule("run", events)
        self.assertEqual(set(result["accepted"]), {"kick", "snare", "hat"})
        self.assertEqual(result["skipped"], [{"id": "fast-kick", "reason": "arm_recovering"},
                                              {"id": "next-kick", "reason": "hit_rate_limited"}])
        self.hardware.advance(100)  # Hat begins 200 ms before intended contact.
        self.assertIn((3, 2430, 200), self.hardware.moves)
        self.hardware.advance(50)
        self.assertIn((0, 2370, 150), self.hardware.moves)
        self.assertIn((2, 2150, 150), self.hardware.moves)
        self.hardware.advance(150)
        self.assertTrue(all((motor, DRUM_PROFILES[motor]["rest"], 150) in self.hardware.moves for motor in (0, 2, 3)))
        self.hardware.advance(150)
        self.hardware.advance(50)
        self.assertEqual(self.hardware.moves.count((0, 2370, 150)), 1)
        result = self.performance.schedule("run", [self.event("one-second-kick", 0, 800)])
        self.assertEqual(result["accepted"], ["one-second-kick"])
        self.hardware.advance(650)
        self.assertEqual(self.hardware.moves.count((0, 2370, 150)), 2)

    def test_one_second_spacing_across_packets_includes_exact_boundary(self):
        self.ready([0])
        first = self.event()
        self.performance.schedule("run", [first])
        for _ in range(3):
            self.hardware.advance(150)
        result = self.performance.schedule("run", [
            {**first, "id": "too-close", "contact_ms": first["contact_ms"] + 999},
            {**first, "id": "boundary", "contact_ms": first["contact_ms"] + 1000},
        ])
        self.assertEqual(result["skipped"], [{"id": "too-close", "reason": "hit_rate_limited"}])
        self.assertEqual(result["accepted"], ["boundary"])
        self.hardware.advance(700)
        self.assertEqual(self.hardware.moves.count((0, 2370, 150)), 2)
        self.assertEqual(self.performance.snapshot()["min_hit_interval_ms"], 1000)

    def test_delayed_dispatch_preserves_actual_spacing_without_blocking_other_drums(self):
        self.ready([0, 1])
        first = self.event()
        self.performance.schedule("run", [first])
        self.hardware.advance(160)  # First strike starts 10 ms late.
        first_contact = self.performance.last_contact_ms[0]
        self.hardware.advance(150)
        self.hardware.advance(150)
        next_contact = first["contact_ms"] + MIN_HIT_INTERVAL_MS
        result = self.performance.schedule("run", [
            {**first, "id": "next", "contact_ms": next_contact},
            {**first, "id": "other", "motor_id": 1, "contact_ms": next_contact},
        ])
        self.assertEqual(result["accepted"], ["next", "other"])
        self.hardware.advance(400)  # Stage both arms before either goal is due.
        self.hardware.advance(290)
        self.assertEqual(self.hardware.moves.count((0, 2370, 150)), 1)
        self.assertIn((1, 2000, 150), self.hardware.moves, "one arm's cooldown cannot delay another arm")
        self.hardware.advance(9)
        self.assertEqual(self.hardware.moves.count((0, 2370, 150)), 1)
        self.hardware.advance(1)
        self.assertEqual(self.hardware.moves.count((0, 2370, 150)), 2)
        self.assertEqual(self.performance.last_contact_ms[0] - first_contact, 1000)

    def test_contact_spacing_survives_stop_and_new_session(self):
        self.ready([0])
        first = self.event()
        self.performance.schedule("run", [first])
        self.hardware.advance(150)
        self.performance.stop("run")
        self.hardware.advance(150)
        self.hardware.advance(150)
        self.performance.start("new", [0])
        self.hardware.advance(500)
        result = self.performance.schedule("new", [
            {**first, "id": "too-close", "contact_ms": first["contact_ms"] + 999},
            {**first, "id": "boundary", "contact_ms": first["contact_ms"] + 1000},
        ])
        self.assertEqual(result["skipped"], [{"id": "too-close", "reason": "hit_rate_limited"}])
        self.assertEqual(result["accepted"], ["boundary"])
        self.hardware.advance(200)
        self.assertEqual(self.hardware.moves.count((0, 2370, 150)), 2)

    def test_cancelled_queued_hits_do_not_reserve_next_session(self):
        self.ready([0])
        self.performance.schedule("run", [self.event(after=1000)])
        self.performance.stop("run")
        self.performance.start("new", [0])
        self.hardware.advance(500)
        result = self.performance.schedule("new", [self.event("new-hit")])
        self.assertEqual(result["accepted"], ["new-hit"])
        self.hardware.advance(150)
        self.assertEqual(self.hardware.moves.count((0, 2370, 150)), 1)

    def test_slower_mechanical_recovery_still_limits_hits(self):
        self.ready([0])
        with mock.patch.object(robot_drum_performance, "RETURN_MS", 1000):
            first = self.event()
            self.performance.schedule("run", [first])
            self.hardware.advance(150)
            self.hardware.advance(150)
            result = self.performance.schedule("run", [{**first, "id": "mechanically-too-soon",
                                                       "contact_ms": first["contact_ms"] + 1000}])
        self.assertEqual(result["skipped"], [{"id": "mechanically-too-soon", "reason": "arm_recovering"}])

    def test_unknown_strike_acknowledgement_preserves_spacing(self):
        self.ready([0])
        first = self.event()
        self.performance.schedule("run", [first])
        original = self.hardware.performance_move

        def uncertain(motor, target, duration, cancelled, **kwargs):
            original(motor, target, duration, cancelled, **kwargs)
            raise RuntimeError("Strike acknowledgement lost")

        self.hardware.performance_move = uncertain
        self.hardware.advance(150)
        self.assertEqual(self.performance.snapshot()["state"], "ready")
        self.assertEqual(self.performance.arms[0]["error"], "Strike acknowledgement lost")
        self.assertEqual(self.performance.last_contact_ms[0], first["contact_ms"])
        self.hardware.performance_move = original
        self.performance.stop("run")
        self.performance.start("new", [0])
        self.hardware.advance(500)
        result = self.performance.schedule("new", [self.event("too-soon")])
        self.assertEqual(result["skipped"], [{"id": "too-soon", "reason": "hit_rate_limited"}])

    def test_duplicates_late_far_future_and_stalled_dispatch_are_skipped(self):
        self.ready([0])
        event = self.event()
        result = self.performance.schedule("run", [event, event, self.event("late", after=100), self.event("far", after=1001)])
        self.assertEqual(result["accepted"], ["a"])
        self.assertEqual({entry["reason"] for entry in result["skipped"]}, {"duplicate", "late", "outside_horizon"})
        self.hardware.advance(150 + LATE_MS + 1)
        self.assertNotIn((0, 2370, 150), self.hardware.moves)
        self.assertEqual(self.performance.snapshot()["queued"], 0)

    def test_normal_stop_finishes_return_and_cancels_pending(self):
        self.ready([0, 2])
        self.performance.schedule("run", [self.event(), self.event("later", 2, 800)])
        self.hardware.advance(150)
        self.performance.stop("run")
        self.assertTrue(self.performance.snapshot()["busy"])
        with self.assertRaises(RuntimeError):
            self.performance.start("new", [0])
        self.hardware.advance(150)
        self.assertEqual(self.hardware.moves[-1], (0, 2200, 150))
        self.hardware.advance(150)
        self.assertFalse(self.performance.snapshot()["busy"])
        self.assertNotIn((2, 2150, 150), self.hardware.moves)
        with self.assertRaises(RuntimeError):
            self.performance.schedule("run", [])

    def test_emergency_cancels_returns_and_old_sessions_cannot_resume(self):
        self.ready([0])
        self.performance.schedule("run", [self.event()])
        self.hardware.advance(150)
        self.performance.invalidate()
        self.hardware.advance(500)
        self.assertNotIn((0, 2200, 150), self.hardware.moves)
        self.assertFalse(self.performance.snapshot()["busy"])
        with self.assertRaises(RuntimeError):
            self.performance.start("run", [0])
        self.performance.stop("not-arrived")
        with self.assertRaises(RuntimeError):
            self.performance.start("not-arrived", [0])

    def test_watchdog_never_replays_a_queue(self):
        self.ready([0])
        self.performance.schedule("run", [self.event()])
        self.hardware.advance(1001)
        self.assertEqual(self.performance.snapshot()["state"], "error")
        self.assertIn("heartbeat", self.performance.snapshot()["error"])
        self.assertNotIn((0, 2370, 150), self.hardware.moves)
        with self.assertRaises(RuntimeError):
            self.performance.schedule("run", [])

    def test_fault_on_one_arm_preserves_healthy_return(self):
        self.ready([0, 2])
        self.performance.schedule("run", [self.event(), self.event("snare", 2)])
        self.hardware.advance(150)
        self.hardware.fault = 2
        self.hardware.advance(150)
        self.assertEqual(self.performance.snapshot()["state"], "ready")
        self.assertIn((0, 2200, 150), self.hardware.moves)
        self.assertNotIn((2, 2300, 150), self.hardware.moves)
        self.hardware.advance(150)
        result = self.performance.schedule("run", [self.event("next-healthy", 0, 850),
                                                   self.event("next-faulty", 2, 850)])
        self.assertEqual(result["accepted"], ["next-healthy"])
        self.assertEqual(result["skipped"], [{"id": "next-faulty", "reason": "arm_unavailable"}])
        self.hardware.advance(350)
        self.hardware.advance(350)
        self.assertEqual(self.hardware.moves.count((0, 2370, 150)), 2)

    def recovery(self):
        self.ready([0, 3])
        self.hardware.outside.add(3)
        self.performance.schedule("run", [self.event("hat", 3, 700), self.event("kick", 0, 700)])
        self.hardware.advance(50)
        self.assertEqual(self.performance.arms[3]["state"], "recovering")
        return self.performance.arms[3]["due_ms"]

    def advance_with_heartbeat(self, until):
        while self.hardware.time < until:
            self.performance.schedule("run", [])
            self.hardware.advance(min(50, until - self.hardware.time))

    def test_outside_arm_recovers_once_and_rejoins_future_hits_while_peer_plays(self):
        due = self.recovery()
        result = self.performance.schedule("run", [self.event("skip-recovering", 3, 900)])
        self.assertEqual(result["skipped"], [{"id": "skip-recovering", "reason": "arm_recovering"}])
        self.advance_with_heartbeat(due - 1)
        self.assertEqual(self.performance.played, 1)
        self.assertEqual(self.hardware.recoveries, [3])
        self.hardware.outside.clear()
        self.advance_with_heartbeat(due)
        self.assertEqual(self.performance.arms[3]["state"], "ready")
        self.assertEqual(self.performance.played, 1, "cancelled hits must not replay")
        self.performance.schedule("run", [self.event("new-hat", 3, 300)])
        self.advance_with_heartbeat(self.hardware.time + 450)
        self.assertIn((3, 2430, 200), self.hardware.moves)
        self.assertIn((3, 2590, 150), self.hardware.moves, "future returns retain the inset rest")
        self.assertEqual(self.performance.played, 2)

    def test_recovery_has_fixed_deadline_and_does_not_retry_outside_readback(self):
        due = self.recovery()
        self.advance_with_heartbeat(due + REST_SETTLE_MS)
        self.assertEqual(self.performance.arms[3]["state"], "error")
        self.assertIn("timed out", self.performance.arms[3]["error"])
        self.assertEqual(self.hardware.recoveries, [3])
        self.assertEqual(self.performance.state, "ready")
        self.performance.schedule("run", [self.event("later-kick", 0, 300)])
        self.advance_with_heartbeat(self.hardware.time + 150)
        self.assertEqual(self.performance.played, 2)

    def test_uncertain_recovery_goal_is_not_retried_and_only_pauses_its_arm(self):
        original = self.hardware.performance_recover
        def uncertain(*args):
            original(*args)
            raise RuntimeError("Recovery acknowledgement lost")
        self.hardware.performance_recover = uncertain
        self.ready([0, 3])
        self.hardware.outside.add(3)
        self.performance.schedule("run", [self.event("hat", 3, 700), self.event("kick", 0, 700)])
        self.advance_with_heartbeat(self.hardware.time + 800)
        self.assertEqual(self.hardware.recoveries, [3])
        self.assertEqual(self.performance.arms[3]["error"], "Recovery acknowledgement lost")
        self.assertEqual(self.performance.played, 1)
        self.assertEqual(self.performance.state, "ready")

    def test_emergency_cancels_recovery_without_later_reads_or_goals(self):
        due = self.recovery()
        self.performance.invalidate()
        self.hardware.advance(3000)
        self.assertEqual(self.performance.arms[3]["state"], "cancelled")
        self.assertEqual(self.hardware.recoveries, [3])
        self.assertFalse(self.performance.busy())

    def test_stop_does_not_initiate_recovery_on_a_failed_return(self):
        self.ready([3])
        self.performance.schedule("run", [self.event("hat", 3, 300)])
        self.hardware.advance(100)
        self.performance.stop("run")
        def outside(*args, **kwargs):
            raise DrumPerformanceBounds("outside")
        self.hardware.performance_move = outside
        self.hardware.advance(200)
        self.assertEqual(self.hardware.recoveries, [])
        self.assertEqual(self.performance.arms[3]["state"], "error")

    def test_changed_connection_stops_the_whole_session_and_preserves_reason(self):
        self.ready([0, 3])
        def disconnected(*args, **kwargs):
            raise DrumPerformanceSessionError("Verified bus changed")
        self.hardware.performance_stage = disconnected
        self.performance.schedule("run", [self.event("kick", 0, 700), self.event("hat", 3, 700)])
        self.hardware.advance(100)
        self.assertEqual(self.performance.state, "error")
        self.assertEqual(self.performance.error, "Verified bus changed")
        self.assertFalse(self.performance.busy())
        self.performance.stop("run")
        with self.assertRaisesRegex(RuntimeError, "Verified bus changed"):
            self.performance.schedule("run", [])

    def test_malformed_batch_is_atomic_and_cannot_refresh_heartbeat(self):
        self.ready([0])
        heartbeat = self.performance.heartbeat
        for packet in (None, {}, [self.event(), {"id": "bad"}], [self.event(after=float("nan"))],
                       [{**self.event(), "motor_id": True}], [self.event()] * 65):
            with self.assertRaises(ValueError):
                self.performance.schedule("run", packet)
        self.assertEqual(self.performance.heartbeat, heartbeat)
        self.assertEqual(self.performance.events, [])

    def test_old_stop_cannot_stop_new_session(self):
        self.ready([0])
        self.performance.stop("run")
        self.performance.start("new", [0])
        self.performance.stop("run")
        self.assertEqual(self.performance.snapshot()["token"], "new")
        self.assertEqual(self.performance.snapshot()["state"], "preparing")

    def test_event_ids_expire_but_old_absolute_events_still_cannot_play(self):
        self.ready([0])
        old = self.event()
        self.performance.schedule("run", [old])
        for _ in range(10):
            self.hardware.advance(300)
            self.performance.schedule("run", [])
        result = self.performance.schedule("run", [old])
        self.assertEqual(result["skipped"], [{"id": "a", "reason": "late"}])
        self.assertLess(len(self.performance.seen), 2)
        self.assertEqual(self.performance.snapshot()["state"], "ready")


class PerformanceAPITests(unittest.TestCase):
    def setUp(self):
        self.hardware = Hardware()
        self.service = RobotControlService(FakeRibs(), self.hardware, FakeHead())
        self.addCleanup(self.service.close)

    def call(self, action, payload=None, method="POST"):
        return self.service.dispatch(method, "/api/robot/drums/performance/" + action, payload)

    def test_status_start_schedule_stop_and_method_validation(self):
        code, value = self.call("status", method="GET")
        self.assertEqual(code, 200)
        self.assertIn("server_time_ms", value)
        self.assertEqual(value["performance"]["state"], "stopped")
        self.assertEqual(self.call("start", {"token": "run", "instruments": [0, 2]})[0], 200)
        self.assertEqual(self.call("schedule", {"token": "run", "events": []})[0], 200)
        self.hardware.advance(500)
        event = {"id": "a", "motor_id": 0, "contact_ms": self.hardware.time + 300}
        self.assertEqual(self.call("schedule", {"token": "run", "events": [event]})[1]["accepted"], ["a"])
        self.assertEqual(self.call("stop", {"token": "run"})[0], 200)
        self.assertEqual(self.call("schedule", {"token": "run", "events": []})[0], 409)
        self.assertEqual(self.call("start", {"token": "run", "instruments": [0]})[0], 409)
        self.assertEqual(self.call("start", method="GET")[0], 405)
        self.assertEqual(self.call("status")[0], 405)
        self.assertEqual(self.call("unknown")[0], 404)

    def test_packet_validation_and_emergency(self):
        for payload in (None, {}, {"token": "a", "instruments": [True]},
                        {"token": "a", "instruments": [0, 0]}, {"token": "a", "instruments": [0], "other": 1}):
            self.assertEqual(self.call("start", payload)[0], 400)
        self.assertFalse(self.hardware.moves)
        self.service.dispatch("POST", "/api/robot/emergency-stop", {})
        self.assertEqual(self.call("start", {"token": "a", "instruments": [0]})[0], 409)
        self.assertEqual(self.call("stop", {"token": "a"})[0], 200)


class SerialPerformanceTests(FakeSerialTest):
    def setUp(self):
        super().setUp()
        self.positions = {motor: profile["rest"] for motor, profile in DRUM_PROFILES.items()}
        self.drums.check()
        self.time = 10000
        self.drums.performance = DrumPerformance(self.drums, now=lambda: self.time, threaded=False)

    def test_selected_arm_checks_and_preserved_targets(self):
        self.reads.clear()
        self.drums.performance.start("a", [1, 2])
        self.assertEqual({motor for motor, _ in self.reads}, {1, 2})
        self.assertEqual(self.writes, [(1, 112, 500), (1, 116, 1850), (2, 112, 500), (2, 116, 2300)])
        self.assertFalse(self.drums.move([(0, 2200, 150)])["ok"])
        self.assertFalse(self.drums.strike(0, 2370, 150, rest_position=2200)["ok"])
        self.assertFalse(self.drums.torque(True)["ok"])
        self.assertTrue(self.drums.torque(False)["ok"])
        self.assertEqual(self.drums.performance.snapshot()["state"], "stopped")

    def test_invalid_selected_arm_prevents_all_preparation_writes(self):
        for field, value in (("positions", 4000), ("torques", 0), ("profiles", 0), ("modes", 1)):
            original = copy.deepcopy(getattr(self, field))
            getattr(self, field)[2] = value
            with self.assertRaises(RuntimeError):
                self.drums.performance.start(field, [0, 2])
            self.assertEqual(self.writes, [])
            setattr(self, field, original)

    def test_request_stop_and_disconnect_invalidate_without_future_writes(self):
        self.drums.performance.start("a", [0])
        self.drums.request_stop()
        self.time += 500
        self.drums.performance.pump()
        self.assertEqual(len(self.writes), 2)
        self.drums.reset_stop()
        self.drums.performance.start("b", [0])
        self.drums.disconnect()
        self.time += 500
        self.drums.performance.pump()
        self.assertEqual(len(self.writes), 4)

    def test_slow_preflight_cannot_dispatch_a_late_strike(self):
        self.drums.performance.start("a", [0])
        self.time += 500
        self.drums.performance.pump()
        self.drums.performance.schedule("a", [{"id": "hit", "motor_id": 0, "contact_ms": self.time + 300}])
        original = self.drums._performance_read
        reads = 0

        def slow(motor, cancelled):
            nonlocal reads
            row = original(motor, cancelled)
            reads += 1
            self.time += 100
            return row

        self.drums._performance_read = slow
        self.time += 150
        self.drums.performance.pump()
        self.assertEqual(self.writes, [(0, 112, 500), (0, 116, 2200)])
        self.assertEqual(self.drums.performance.snapshot()["skipped"], 1)

    def test_profile_write_delay_does_not_send_goal_after_deadline(self):
        self.drums.performance.start("a", [0])
        self.time += 500
        self.drums.performance.pump()
        self.drums.performance.schedule("a", [{"id": "hit", "motor_id": 0, "contact_ms": self.time + 300}])
        original = self.write

        def slow(port, motor, address, value):
            result = original(port, motor, address, value)
            if address == 112:
                self.time += 100
            return result

        self.packet.write4ByteTxRx.side_effect = slow
        self.time += 150
        self.drums.performance.pump()
        self.assertNotIn((0, 116, 2370), self.writes)
        self.assertEqual(self.drums.performance.snapshot()["skipped"], 1)

    def test_emergency_during_fresh_read_prevents_all_preparation_writes(self):
        original = self.read

        def interrupted(port, motor, address):
            result = original(port, motor, address)
            self.drums.request_stop()
            return result

        self.packet.read4ByteTxRx.side_effect = interrupted
        with self.assertRaises(RuntimeError):
            self.drums.performance.start("a", [0])
        self.assertEqual(self.writes, [])

    def test_performance_cannot_start_while_manual_strike_is_preparing(self):
        self.drums._strike["state"] = "preparing"
        with self.assertRaisesRegex(RuntimeError, "manual"):
            self.drums.performance.start("a", [0])
        self.assertEqual(self.writes, [])


if __name__ == "__main__":
    unittest.main()
