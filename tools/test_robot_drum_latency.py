#!/usr/bin/env python3
"""Real controller timing tests using fake serial ports only."""
import threading
import time
import unittest

from robot_drum_performance import (DrumPerformance, DrumPerformanceLate, DrumPerformanceSettling,
                                   DRUM_PROFILES, LATE_MS, MIN_HIT_INTERVAL_MS, PREPARE_MS,
                                   REST_POLL_MS, REST_SETTLE_MS, RETURN_MS)
from test_robot_serial import FakeSerialTest


class DrumPreflightTests(FakeSerialTest):
    def setUp(self):
        super().setUp()
        self.positions = {motor: profile["rest"] for motor, profile in DRUM_PROFILES.items()}
        self.drums.check()
        self.time, self.transaction_ms = 10000, 0
        self.goal_times = []
        self.pending_rest_positions = {}
        self.packet.read1ByteTxRx.side_effect = self.timed_read
        self.packet.read4ByteTxRx.side_effect = self.timed_read
        self.packet.write4ByteTxRx.side_effect = self.timed_write
        self.drums.performance = DrumPerformance(self.drums, now=lambda: self.time, threaded=False)
        self.cancelled = threading.Event()

    def timed_read(self, port, motor, address):
        self.time += self.transaction_ms
        return self.read(port, motor, address)

    def timed_write(self, port, motor, address, value):
        if address == 116:
            self.goal_times.append((motor, value, self.time))
        self.time += self.transaction_ms
        result = self.write(port, motor, address, value)
        if address == 116 and result == (0, 0):
            # Some regressions hold the shaft short of rest after the goal has
            # been acknowledged; the fake encoder advances independently later.
            self.positions[motor] = (self.pending_rest_positions.get(motor, value)
                                     if value == DRUM_PROFILES[motor]["rest"] else value)
        return result

    def stage(self, motor=0, lead=350):
        profile = DRUM_PROFILES[motor]
        return self.drums.performance_stage(motor, profile["rest"], profile["strike"],
                                             profile["duration_ms"], self.cancelled,
                                             deadline_ms=self.time + lead, clock=lambda: self.time)

    def commit(self, ticket, motor=0, deadline=None):
        self.drums.performance_commit(motor, DRUM_PROFILES[motor]["strike"], ticket, self.cancelled,
                                      deadline_ms=self.time + 20 if deadline is None else deadline,
                                      clock=lambda: self.time, max_age_ms=400)

    def ready(self, instruments=None):
        performance = self.drums.performance
        performance.start("latency", instruments or [0, 1, 2, 3])
        self.time += 500
        performance.pump()
        self.assertEqual(performance.snapshot()["state"], "ready")
        self.reads.clear()
        self.writes.clear()
        self.goal_times.clear()
        return performance

    def advance(self, deadline):
        while self.time < deadline:
            self.time = min(deadline, self.time + 5)
            self.drums.performance.pump()

    def waiting_return(self):
        performance = self.ready([2])
        self.pending_rest_positions[2] = 2265
        contact = self.time + 300
        result = performance.schedule("latency", [{"id": "first", "motor_id": 2, "contact_ms": contact}])
        self.assertEqual(result["accepted"], ["first"])
        self.advance(contact + RETURN_MS)
        state = performance.snapshot()
        self.assertEqual(state["state"], "ready")
        self.assertEqual(state["arms"][0]["state"], "returning")
        self.assertTrue(state["arms"][0]["settling"])
        self.assertIsNone(state["error"])
        return performance, contact

    def test_verify_and_stage_reject_unsettled_arm_before_any_write(self):
        self.positions[2] = 2265
        with self.assertRaisesRegex(DrumPerformanceSettling, "2265.*2300"):
            self.drums.performance_verify(2, 2300, self.cancelled)
        with self.assertRaisesRegex(DrumPerformanceSettling, "2265.*2300"):
            self.stage(motor=2)
        self.assertEqual(self.writes, [])
        for position in (2280, 2320):
            with self.subTest(position=position):
                self.positions[2] = position
                self.drums.performance_verify(2, 2300, self.cancelled)
        self.positions[2] = 2279
        with self.assertRaises(DrumPerformanceSettling):
            self.drums.performance_verify(2, 2300, self.cancelled)

    def test_unsafe_readback_is_never_classified_as_rest_settling(self):
        for problem in ("torque", "range", "hardware", "read", "profile", "mode"):
            with self.subTest(problem=problem):
                self.positions[2] = 2265
                self.failures.clear()
                self.torques.clear()
                self.modes.clear()
                self.profiles.clear()
                if problem == "torque":
                    self.torques[2] = 0
                elif problem == "range":
                    self.positions[2] = 2351
                elif problem == "hardware":
                    self.failures[(2, 70)] = (4, 0, 0)
                elif problem == "read":
                    self.failures[(2, 132)] = (0, -1, 0)
                elif problem == "profile":
                    self.profiles[2] = 0
                else:
                    self.modes[2] = 1
                with self.assertRaises(RuntimeError) as raised:
                    self.drums.performance_verify(2, 2300, self.cancelled)
                self.assertNotIsInstance(raised.exception, DrumPerformanceSettling)
                self.assertEqual(self.writes, [])

    def test_preparation_polls_until_exact_rest_tolerance_without_reissuing_goals(self):
        performance = self.drums.performance
        self.pending_rest_positions[2] = 2265
        performance.start("latency", [0, 2])
        self.advance(self.time + PREPARE_MS)
        state = performance.snapshot()
        self.assertEqual(state["state"], "preparing")
        self.assertEqual([arm["state"] for arm in state["arms"]], ["ready", "preparing"])
        self.assertIsNone(state["error"])
        with self.assertRaisesRegex(RuntimeError, "Wait until"):
            performance.schedule("latency", [{"id": "early", "motor_id": 2,
                                               "contact_ms": self.time + 300}])
        reads_before = len(self.reads)
        self.positions[2] = 2280
        self.advance(self.time + REST_POLL_MS - 1)
        self.assertEqual(len(self.reads), reads_before, "Do not poll on every scheduler tick")
        self.assertEqual(performance.snapshot()["state"], "preparing")
        self.advance(self.time + 1)
        state = performance.snapshot()
        self.assertEqual(state["state"], "ready")
        self.assertFalse(state["arms"][1]["settling"])
        self.assertEqual([(motor, target) for motor, target, _ in self.goal_times], [(0, 2200), (2, 2300)])
        self.assertEqual(state["played"], 0)

    def test_slow_return_can_settle_and_repeat_at_one_second_contact_intervals(self):
        performance = self.ready([2])
        self.pending_rest_positions[2] = 2265
        first_contact = self.time + 300
        cycles = 8
        for cycle in range(cycles):
            contact = first_contact + cycle * MIN_HIT_INTERVAL_MS
            result = performance.schedule("latency", [{"id": f"cycle-{cycle}", "motor_id": 2,
                                                       "contact_ms": contact}])
            self.assertEqual(result["accepted"], [f"cycle-{cycle}"])
            self.advance(contact + RETURN_MS)
            state = performance.snapshot()
            self.assertEqual(state["arms"][0]["state"], "returning")
            self.assertTrue(state["arms"][0]["settling"])
            self.assertEqual(state["played"], cycle + 1)
            self.assertIsNone(state["error"])
            self.positions[2] = 2280
            self.advance(self.time + REST_POLL_MS)
            self.assertEqual(performance.snapshot()["arms"][0]["state"], "ready")
        strikes = [sent_at for motor, target, sent_at in self.goal_times if target == DRUM_PROFILES[motor]["strike"]]
        self.assertEqual(len(strikes), cycles)
        self.assertEqual([later - earlier for earlier, later in zip(strikes, strikes[1:])],
                         [MIN_HIT_INTERVAL_MS] * (cycles - 1))
        self.assertEqual(performance.snapshot()["skipped"], 0)

    def test_other_arm_can_strike_and_heartbeat_continues_during_rest_settling(self):
        performance = self.ready([0, 2])
        self.pending_rest_positions[2] = 2265
        first_contact = self.time + 300
        result = performance.schedule("latency", [{"id": "slow-arm", "motor_id": 2,
                                                   "contact_ms": first_contact}])
        self.assertEqual(result["accepted"], ["slow-arm"])
        self.advance(first_contact + RETURN_MS)
        self.assertEqual(performance.snapshot()["arms"][1]["state"], "returning")
        other_contact = first_contact + 900
        result = performance.schedule("latency", [{"id": "other-arm", "motor_id": 0,
                                                   "contact_ms": other_contact}])
        self.assertEqual(result["accepted"], ["other-arm"])
        self.advance(first_contact + 650)
        heartbeat = self.time
        result = performance.schedule("latency", [])
        self.assertEqual(result, {"accepted": [], "skipped": []})
        self.assertEqual(performance.heartbeat, heartbeat)
        self.advance(other_contact - DRUM_PROFILES[0]["duration_ms"])
        state = performance.snapshot()
        self.assertEqual(state["state"], "ready")
        self.assertEqual(state["played"], 2)
        self.assertEqual([arm["state"] for arm in state["arms"]], ["striking", "returning"])
        self.assertTrue(state["arms"][1]["settling"])
        self.assertEqual(self.positions[2], 2265)
        self.assertIsNone(state["error"])
        self.assertEqual([(motor, target) for motor, target, _ in self.goal_times],
                         [(2, 2150), (2, 2300), (0, 2370)])

    def test_return_still_settling_skips_a_due_strike_without_sending_another_goal(self):
        performance, contact = self.waiting_return()
        result = performance.schedule("latency", [{"id": "next", "motor_id": 2,
                                                   "contact_ms": contact + MIN_HIT_INTERVAL_MS}])
        self.assertEqual(result["accepted"], ["next"])
        self.advance(contact + MIN_HIT_INTERVAL_MS - DRUM_PROFILES[2]["duration_ms"])
        state = performance.snapshot()
        self.assertEqual(state["played"], 1)
        self.assertEqual(state["skip_reasons"], {"arm_not_ready": 1})
        self.assertEqual(state["arms"][0]["state"], "returning")
        self.assertIsNone(state["error"])
        self.assertEqual([(motor, target) for motor, target, _ in self.goal_times], [(2, 2150), (2, 2300)])
        self.positions[2] = 2280
        self.advance(self.time + REST_POLL_MS)
        self.assertEqual(performance.snapshot()["arms"][0]["state"], "ready")
        self.assertEqual(performance.snapshot()["played"], 1, "A skipped hit must never be replayed after settling")

    def test_return_settle_timeout_uses_fixed_deadline_including_exact_boundary(self):
        performance, contact = self.waiting_return()
        deadline = contact + RETURN_MS + REST_SETTLE_MS
        while self.time < deadline - 1:
            performance.schedule("latency", [])
            self.advance(min(self.time + REST_POLL_MS, deadline - 1))
            state = performance.snapshot()
            self.assertEqual(state["state"], "ready")
            self.assertEqual(state["arms"][0]["state"], "returning")
            self.assertEqual(state["arms"][0]["settle_deadline_ms"], deadline)
            self.assertIsNone(state["error"])
        self.advance(deadline)
        state = performance.snapshot()
        self.assertEqual(state["state"], "ready")
        self.assertEqual(state["arms"][0]["state"], "error")
        self.assertIsNone(state["error"])
        self.assertIn("timed out", state["arms"][0]["error"])
        self.assertIn("2265", state["arms"][0]["error"])
        self.assertEqual([(motor, target) for motor, target, _ in self.goal_times], [(2, 2150), (2, 2300)])

    def test_torque_loss_during_settling_fails_at_next_poll_without_waiting_for_timeout(self):
        performance, contact = self.waiting_return()
        self.torques[2] = 0
        self.advance(self.time + REST_POLL_MS)
        state = performance.snapshot()
        self.assertLess(self.time, contact + RETURN_MS + REST_SETTLE_MS)
        self.assertEqual(state["state"], "ready")
        self.assertEqual(state["arms"][0]["state"], "error")
        self.assertIsNone(state["error"])
        self.assertIn("torque is off", state["arms"][0]["error"])
        self.assertNotIn("timed out", state["arms"][0]["error"])
        self.assertEqual([(motor, target) for motor, target, _ in self.goal_times], [(2, 2150), (2, 2300)])

    def test_two_tick_overshoot_recovers_while_other_arm_keeps_playing_on_slow_bus(self):
        performance = self.ready([0, 3])
        self.transaction_ms = 8
        self.positions[3] = 2602
        start = self.time
        performance.schedule("latency", [
            {"id": "overshot-hat", "motor_id": 3, "contact_ms": start + 900},
            {"id": "kick-1", "motor_id": 0, "contact_ms": start + 900},
        ])
        self.advance(start + 400)
        arm = performance.arms[3]
        self.assertEqual(arm["state"], "recovering")
        self.assertEqual(self.writes[:2], [(3, 112, 2000), (3, 116, 2590)])
        due = arm["due_ms"]
        second_scheduled = False
        while self.time < due + 50:
            performance.schedule("latency", [])
            if not second_scheduled and self.time >= start + 1150:
                result = performance.schedule("latency", [{"id": "kick-2", "motor_id": 0,
                                                           "contact_ms": start + 2000}])
                self.assertEqual(result["accepted"], ["kick-2"])
                second_scheduled = True
            self.advance(min(self.time + 100, due + 50))
        self.assertEqual(performance.state, "ready")
        self.assertEqual(arm["state"], "ready")
        strikes = [(motor, target, at) for motor, target, at in self.goal_times if target == DRUM_PROFILES[motor]["strike"]]
        self.assertEqual([motor for motor, _, _ in strikes], [0, 0])
        self.assertGreaterEqual(strikes[1][2] - strikes[0][2], MIN_HIT_INTERVAL_MS)
        self.assertEqual(sum(target == 2590 for _, target, _ in self.goal_times), 1)
        performance.schedule("latency", [{"id": "rejoined-hat", "motor_id": 3, "contact_ms": self.time + 800}])
        self.advance(self.time + 950)
        self.assertEqual(performance.played, 3)
        self.assertEqual(self.goal_times[-1][0:2], (3, 2590))

    def test_stage_reads_once_sets_only_profile_and_commit_only_sends_goal(self):
        self.transaction_ms = 8
        self.reads.clear()
        ticket = self.stage()
        self.assertEqual([address for _, address in self.reads], [132, 64, 70, 10, 11])
        self.assertEqual(self.writes, [(0, 112, 150)])
        self.time += 250
        self.commit(ticket)
        self.assertEqual(len(self.reads), 5, "The timed goal must not repeat the serial preflight")
        self.assertEqual(self.writes, [(0, 112, 150), (0, 116, 2370)])
        with self.assertRaisesRegex(RuntimeError, "no longer valid"):
            self.commit(ticket)
        self.assertEqual(len(self.writes), 2, "A prepared goal is consumed exactly once")

    def test_expired_or_late_ticket_never_sends_goal(self):
        for expired in (False, True):
            with self.subTest(expired=expired):
                ticket = self.stage()
                before = len(self.writes)
                deadline = self.time - 1 if not expired else self.time + 1000
                if expired:
                    self.time += 401
                with self.assertRaises(DrumPerformanceLate):
                    self.commit(ticket, deadline=deadline)
                self.assertEqual(len(self.writes), before)
                self.assertTrue(ticket["used"])

    def test_stop_changed_connection_cancel_and_mismatched_goal_block_commit(self):
        for change in ("stop", "cancel", "device", "port", "target"):
            with self.subTest(change=change):
                ticket = self.stage()
                before = len(self.writes)
                original_device, original_port = self.drums._device, self.drums._port
                if change == "stop":
                    self.drums.request_stop()
                    self.drums.reset_stop()
                elif change == "cancel":
                    self.cancelled.set()
                elif change == "device":
                    self.drums._device = "/dev/cu.usbserial-OTHER"
                elif change == "port":
                    self.drums._port = None
                else:
                    ticket["target"] += 1
                with self.assertRaises(RuntimeError):
                    self.commit(ticket)
                self.assertEqual(len(self.writes), before)
                self.drums._device, self.drums._port = original_device, original_port
                self.cancelled = threading.Event()

    def test_failed_read_unsafe_pose_or_slow_stage_never_sets_goal(self):
        for problem in ("fault", "rest", "torque", "mode", "profile", "late", "read"):
            with self.subTest(problem=problem):
                self.positions[0] = DRUM_PROFILES[0]["rest"]
                self.failures.clear()
                self.torques.clear()
                self.modes.clear()
                self.profiles.clear()
                self.transaction_ms = 0
                if problem == "fault":
                    self.failures[(0, 70)] = (4, 0, 0)
                elif problem == "rest":
                    self.positions[0] = 2300
                elif problem == "torque":
                    self.torques[0] = 0
                elif problem == "mode":
                    self.modes[0] = 1
                elif problem == "profile":
                    self.profiles[0] = 0
                elif problem == "late":
                    self.transaction_ms = 10
                else:
                    self.failures[(0, 132)] = (0, -1, 0)
                before = len(self.writes)
                with self.assertRaises(RuntimeError):
                    self.stage(lead=20 if problem == "late" else 350)
                self.assertEqual(len(self.writes), before)

    def test_stop_during_preflight_prevents_profile_and_goal(self):
        def stopped_read(port, motor, address):
            row = self.read(port, motor, address)
            self.drums.request_stop()
            self.drums.reset_stop()
            return row

        self.packet.read4ByteTxRx.side_effect = stopped_read
        with self.assertRaises(RuntimeError):
            self.stage()
        self.assertEqual(self.writes, [])

    def assert_four_arm_latency(self, transaction_ms):
        performance = self.ready()
        self.transaction_ms = transaction_ms
        contact = self.time + 700
        result = performance.schedule("latency", [
            {"id": f"hit-{motor}", "motor_id": motor, "contact_ms": contact}
            for motor in DRUM_PROFILES])
        self.assertEqual(len(result["accepted"]), 4)
        self.advance(contact - 100)
        result = performance.snapshot()
        self.assertEqual((result["played"], result["skipped"]), (4, 0))
        self.assertEqual(len(self.reads), 20, "Exactly one fresh five-register preflight per arm")
        for motor, target, sent_at in self.goal_times:
            profile = DRUM_PROFILES[motor]
            self.assertEqual(target, profile["strike"])
            dispatch = contact - profile["duration_ms"]
            self.assertGreaterEqual(sent_at, dispatch)
            self.assertLessEqual(sent_at, dispatch + LATE_MS)

    def test_four_arms_with_eight_ms_usb_transaction_latency(self):
        self.assert_four_arm_latency(8)

    def test_four_arms_with_sixteen_ms_usb_transaction_latency(self):
        self.assert_four_arm_latency(16)

    def test_stop_after_staging_sends_no_goals_even_when_timers_advance(self):
        performance = self.ready([0])
        self.transaction_ms = 8
        contact = self.time + 700
        performance.schedule("latency", [{"id": "hit", "motor_id": 0, "contact_ms": contact}])
        self.advance(contact - 300)
        self.assertIn((0, 112, 150), self.writes)
        self.assertEqual(self.goal_times, [])
        performance.stop("latency")
        self.advance(contact + 100)
        self.assertEqual(self.goal_times, [])
        self.assertEqual(performance.snapshot()["played"], 0)

    def test_real_worker_preflights_ahead_and_commits_without_additional_reads(self):
        performance = self.ready([0])
        anchor, started = self.time, time.monotonic()
        performance.now = lambda: anchor + (time.monotonic() - started) * 1000
        hit = threading.Event()
        profile_times = []

        def read(port, motor, address):
            time.sleep(.002)
            return self.read(port, motor, address)

        def write(port, motor, address, value):
            sent_at = performance.now()
            time.sleep(.002)
            result = self.write(port, motor, address, value)
            if address == 112:
                profile_times.append(sent_at)
            if address == 116:
                self.positions[motor] = value
                self.goal_times.append((motor, value, sent_at))
                if value == DRUM_PROFILES[motor]["strike"]:
                    hit.set()
            return result

        self.packet.read1ByteTxRx.side_effect = read
        self.packet.read4ByteTxRx.side_effect = read
        self.packet.write4ByteTxRx.side_effect = write
        contact = performance.now() + 700
        performance.schedule("latency", [{"id": "threaded", "motor_id": 0, "contact_ms": contact}])
        worker = threading.Thread(target=performance._run, daemon=True)
        performance.thread = worker
        worker.start()
        try:
            self.assertTrue(hit.wait(2), "The existing worker must dispatch the staged hit")
            with performance.lock:
                self.assertEqual(performance.played, 1)
                self.assertEqual(len(self.reads), 5)
                self.assertLess(profile_times[0], contact - 300)
                self.assertLessEqual(self.goal_times[0][2], contact - 150 + LATE_MS)
        finally:
            performance.stop("latency")
            worker.join(2)
        self.assertFalse(worker.is_alive(), "Normal stop completes the return and closes the worker")


if __name__ == "__main__":
    unittest.main()
