"""Bounded drum performance planning; hardware remains behind the serial lock.

Times are server monotonic milliseconds. Intended contact lead times come from
the sibling drumming-robot/dynamixel_control/stroke_colls files. Max's
stroke_routing.maxpat delays each hit by (400 - hit_time), then runs that hit
profile and returns to the stored rest using append 150. Scheduling by absolute
contact time is equivalent: dispatch at contact_ms - hit_time, with no extra
400 ms added. Its append 100 preparation object is disconnected; the explicit
500 ms initial preparation comes from dynamixel_control/practice.py instead.
These are the original intended timings, not measured acoustic impact latency.
No sibling project is imported or executed and no hardware is opened here.
"""
from __future__ import annotations

import copy
import math
import re
import threading
import time


DRUM_PROFILES = {
    0: {"rest": 2200, "strike": 2370, "duration_ms": 150, "source_file": "kick.txt", "source_row": 0},
    # Physical parts 1 and 2 were exchanged; the motor calibrations stay put.
    1: {"rest": 1850, "strike": 2000, "duration_ms": 150, "source_file": "snare_hit.txt", "source_row": 0},
    2: {"rest": 2300, "strike": 2150, "duration_ms": 150, "source_file": "ride.txt", "source_row": 0},
    # Row 0 starts at 2660, outside the preserved Max upper bound of 2600.
    3: {"rest": 2600, "strike": 2430, "duration_ms": 200, "source_file": "hihat.txt", "source_row": 1},
}
PREPARE_MS, RETURN_MS, RECOVERY_MS = 500, 150, 50
REST_SETTLE_MS, REST_POLL_MS = 1000, 50
HORIZON_MS, HEARTBEAT_MS, LATE_MS = 1000, 1000, 75
PREFLIGHT_LEAD_MS, PREFLIGHT_MAX_AGE_MS = 450, 550
PREFLIGHT_BUDGET_MS = 100
MIN_HIT_INTERVAL_MS = 1000
LEGACY_ALIGNMENT_MS = 400


class DrumPerformanceLate(RuntimeError):
    """A read completed too late; leave the arm at rest instead of striking."""


class DrumPerformanceSettling(RuntimeError):
    """All safety checks passed, but the arm has not yet reached raised rest."""


class DrumPerformanceBounds(RuntimeError):
    """A healthy, powered arm is outside its ordinary playing range."""


class DrumPerformanceSessionError(RuntimeError):
    """Shared connection or cancellation state no longer permits movement."""


def identifier(value, label="Token"):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value):
        raise ValueError(f"{label} must contain 1–128 letters, numbers, dots, colons, underscores or hyphens.")
    return value


class DrumPerformance:
    """One scheduler, independent arm recovery, one shared serial writer lock.

    Hardware supplies prepare(ids, cancelled), verify(id, rest, cancelled),
    move(id, target, duration, cancelled) for returns, stage(...) for early
    read-back/profile preparation, commit(...) for the timed goal, and its RLock.
    Methods raise RuntimeError on hardware/session conflicts and ValueError on
    malformed packets. Tests can disable the worker and advance pump directly.
    """
    def __init__(self, hardware, *, now=None, threaded=True):
        self.hardware = hardware
        self.lock = hardware._lock
        self.now = now or (lambda: time.monotonic() * 1000)
        self.threaded = threaded
        self.cancelled = threading.Event()
        self.wake = threading.Event()
        self.thread = None
        self.token = None
        self.state = "stopped"
        self.error = None
        self.arms = {}
        self.events = []
        self.seen = {}
        self.retired = set()
        self.heartbeat = 0
        self.played = self.skipped = 0
        self.skip_reasons = {}
        # Conservative contact estimates from acknowledged strike writes. Keep
        # them across sessions so stopping/restarting cannot bypass arm pacing.
        self.last_contact_ms = {}

    def invalidate(self):
        """Never acquire a serial lock while emergency stop is being latched."""
        self.cancelled.set()
        self.wake.set()

    def _cancel_pending(self, error=None):
        self.events.clear()
        if self.token:
            self.retired.add(self.token)
        # Browser cleanup, watchdogs and repeated Stop requests must not erase
        # the first failure explaining why this particular session ended.
        if self.error is None and error is not None:
            self.error = error
        self.state = "error" if self.error else "stopped"

    def _apply_cancellation(self):
        if self.cancelled.is_set():
            self._cancel_pending()
            for arm in self.arms.values():
                if arm["state"] != "error":
                    arm["state"] = "cancelled"

    def busy(self):
        return self.state in ("preparing", "ready") or any(
            arm["state"] in ("preparing", "striking", "returning", "recovering") for arm in self.arms.values())

    def snapshot(self):
        with self.lock:
            self._apply_cancellation()
            return {"token": self.token, "state": self.state, "error": self.error,
                    "arms": copy.deepcopy(list(self.arms.values())), "queued": len(self.events),
                    "busy": self.busy(), "played": self.played, "skipped": self.skipped,
                    "skip_reasons": dict(self.skip_reasons),
                    "heartbeat_timeout_ms": HEARTBEAT_MS, "horizon_ms": HORIZON_MS,
                    "min_hit_interval_ms": MIN_HIT_INTERVAL_MS,
                    "goal_late_limit_ms": LATE_MS, "preflight_max_age_ms": PREFLIGHT_MAX_AGE_MS,
                    "rest_settle_timeout_ms": REST_SETTLE_MS,
                    "timing_source": "drumming-robot/dynamixel_control/stroke_colls + stroke_routing.maxpat",
                    "legacy_alignment_ms": LEGACY_ALIGNMENT_MS,
                    "timing_calibrated": False}

    def start(self, token, instruments):
        token = identifier(token)
        if (not isinstance(instruments, list) or not 1 <= len(instruments) <= 4
                or any(type(item) is not int or item not in DRUM_PROFILES for item in instruments)
                or len(set(instruments)) != len(instruments)):
            raise ValueError("Instruments must contain one to four unique drum motor IDs 0–3.")
        with self.lock:
            self._apply_cancellation()
            if token in self.retired:
                raise RuntimeError("This performance token was retired. Start a new session.")
            if self.busy():
                if token == self.token and self.state in ("preparing", "ready"):
                    return  # Idempotence never restarts a cancelled session.
                raise RuntimeError("A drum performance or its return is still active.")
            if len(self.retired) >= 4096:
                raise RuntimeError("Restart the robot service before opening another drum session.")
            self.token, self.state, self.error = token, "preparing", None
            self.cancelled = threading.Event()
            self.events, self.seen, self.arms = [], {}, {}
            self.played = self.skipped = 0
            self.skip_reasons = {}
            self.heartbeat = self.now()
            try:
                self.hardware.performance_prepare(instruments, self.cancelled)
                if self.cancelled.is_set():
                    raise RuntimeError("Drum performance was cancelled during preparation.")
                due = self.now() + PREPARE_MS
                self.arms = {item: {"motor_id": item, "state": "preparing", "due_ms": due,
                                   "settle_deadline_ms": due + REST_SETTLE_MS,
                                   "available_ms": due,
                                   "next_contact_ms": self.last_contact_ms.get(item, -MIN_HIT_INTERVAL_MS) + MIN_HIT_INTERVAL_MS,
                                   **DRUM_PROFILES[item]} for item in instruments}
            except Exception as error:
                self._cancel_pending(str(error))
                raise
            self.wake.set()
            if self.threaded and (self.thread is None or not self.thread.is_alive()):
                self.thread = threading.Thread(target=self._run, name="drum-performance", daemon=True)
                self.thread.start()

    def schedule(self, token, events):
        token = identifier(token)
        if not isinstance(events, list) or len(events) > 64:
            raise ValueError("Events must be an array containing at most 64 strikes.")
        parsed = []
        for event in events:
            if not isinstance(event, dict) or set(event) != {"id", "motor_id", "contact_ms"}:
                raise ValueError("Each event needs only id, motor_id and contact_ms.")
            event_id = identifier(event["id"], "Event ID")
            motor = event["motor_id"]
            contact = event["contact_ms"]
            if type(motor) is not int or motor not in DRUM_PROFILES:
                raise ValueError("Drum motor ID must be an integer 0–3.")
            if type(contact) not in (int, float) or not math.isfinite(contact) or contact < 0:
                raise ValueError("Contact time must be finite, nonnegative monotonic milliseconds.")
            parsed.append({"id": event_id, "motor_id": motor, "contact_ms": contact,
                           "dispatch_ms": contact - DRUM_PROFILES[motor]["duration_ms"]})
        with self.lock:
            self._apply_cancellation()
            if token != self.token or self.state not in ("preparing", "ready") or token in self.retired:
                raise RuntimeError(self.error if token == self.token and self.error
                                   else "This drum performance session is no longer active.")
            now = self.now()
            if now - self.heartbeat > HEARTBEAT_MS:
                self._cancel_pending("Drum heartbeat timed out. Start a new performance.")
                raise RuntimeError(self.error)
            if parsed and self.state != "ready":
                raise RuntimeError("Wait until the drumming arms have reached raised rest.")
            if any(event["motor_id"] not in self.arms for event in parsed):
                raise ValueError("A scheduled arm was not selected for this performance.")
            # Old absolute contact times are already rejected as late. Expire
            # their IDs so a healthy performance can run indefinitely.
            self.seen = {key: expiry for key, expiry in self.seen.items() if expiry > now}
            if len(self.seen) + len(parsed) > 8192:
                raise ValueError("Too many drum events were submitted within the scheduling window.")
            self.heartbeat = now
            accepted, skipped = [], []
            for event in sorted(parsed, key=lambda value: value["dispatch_ms"]):
                reason = None
                arm = self.arms[event["motor_id"]]
                if event["id"] in self.seen:
                    reason = "duplicate"
                elif arm["state"] in ("error", "cancelled"):
                    reason = "arm_unavailable"
                elif arm["state"] == "recovering":
                    reason = "arm_recovering"
                elif event["contact_ms"] > now + HORIZON_MS:
                    reason = "outside_horizon"
                elif event["dispatch_ms"] < now + LATE_MS:
                    reason = "late"
                elif event["dispatch_ms"] < arm["available_ms"]:
                    reason = "arm_recovering"
                elif event["contact_ms"] < arm["next_contact_ms"]:
                    reason = "hit_rate_limited"
                self.seen[event["id"]] = now + HORIZON_MS + HEARTBEAT_MS
                if reason:
                    skipped.append({"id": event["id"], "reason": reason})
                    self._skip(reason)
                else:
                    self.events.append(event)
                    arm["available_ms"] = event["contact_ms"] + RETURN_MS + RECOVERY_MS
                    arm["next_contact_ms"] = event["contact_ms"] + MIN_HIT_INTERVAL_MS
                    accepted.append(event["id"])
            self.events.sort(key=lambda value: value["dispatch_ms"])
            self.wake.set()
            return {"accepted": accepted, "skipped": skipped}

    def stop(self, token):
        token = identifier(token)
        with self.lock:
            # Remember even a not-yet-arrived start, so request reordering is safe.
            if len(self.retired) < 4096:
                self.retired.add(token)
            if token == self.token:
                self._cancel_pending()
                self.wake.set()

    def _skip(self, reason):
        self.skipped += 1
        self.skip_reasons[reason] = self.skip_reasons.get(reason, 0) + 1

    def _clear_arm_events(self, arm):
        kept = []
        for event in self.events:
            if event["motor_id"] == arm["motor_id"]:
                self._skip("arm_unavailable")
            else:
                kept.append(event)
        self.events = kept

    def _fail_arm(self, arm, error):
        self._clear_arm_events(arm)
        arm.update(state="error", settling=False)
        if not arm.get("error"):
            arm["error"] = str(error)

    def _handle_fault(self, arm, error):
        if isinstance(error, DrumPerformanceSessionError):
            # A changed bus or cancellation invalidates every cached ticket.
            self._fail_arm(arm, error)
            self._cancel_pending(str(error))
            self.cancelled.set()
            self._apply_cancellation()
        elif isinstance(error, DrumPerformanceBounds) and arm["state"] == "recovering":
            self._await_rest(arm, error)
        elif isinstance(error, DrumPerformanceBounds) and self.state in ("preparing", "ready"):
            self._clear_arm_events(arm)
            try:
                recovery = self.hardware.performance_recover(arm["motor_id"], self.cancelled)
                due = self.now() + recovery["duration_ms"]
                arm.update(state="recovering", due_ms=due, available_ms=due,
                           settle_deadline_ms=due + REST_SETTLE_MS, settling=True,
                           return_position=recovery["target"], rest_recheck_started=False)
            except Exception as recovery_error:
                # An uncertain write may already have moved the arm. Never retry.
                if isinstance(recovery_error, DrumPerformanceSessionError):
                    self._handle_fault(arm, recovery_error)
                else:
                    self._fail_arm(arm, recovery_error)
        else:
            self._fail_arm(arm, error)

    def _await_rest(self, arm, error, *, preflight=False):
        now = self.now()
        if preflight and not arm.get("rest_recheck_started"):
            arm["rest_recheck_started"] = True
            # A later fresh read may reveal recoil after an earlier rest check.
            # Reuse an active settling window; a long-held arm gets one new
            # bounded episode. Intermediate successful reads never renew it.
            if now >= arm["settle_deadline_ms"]:
                arm["settle_deadline_ms"] = now + REST_SETTLE_MS
        if now >= arm["settle_deadline_ms"]:
            self._fail_arm(arm, f"Raised rest settling timed out after {REST_SETTLE_MS} ms: {error}")
        else:
            arm.update(state=arm["state"] if arm["state"] in ("preparing", "recovering") else "returning",
                       settling=True, due_ms=min(now + REST_POLL_MS, arm["settle_deadline_ms"]))

    def _dispatch_ready(self, *, skip_unprepared=False):
        """Prioritize prepared goals; serial reads never occur in this phase."""
        self._apply_cancellation()
        if self.state == "ready" and self.now() - self.heartbeat > HEARTBEAT_MS:
            self._cancel_pending("Drum heartbeat timed out. Start a new performance.")
        deferred = []
        while self.state == "ready" and self.events and self.events[0]["dispatch_ms"] <= self.now():
            event = self.events.pop(0)
            arm = self.arms[event["motor_id"]]
            if self.now() - event["dispatch_ms"] > LATE_MS:
                self._skip("dispatch_late")
                continue
            if arm["state"] != "ready":
                self._skip("arm_not_ready")
                continue
            if "preflight" not in event:
                if skip_unprepared:
                    self._skip("preflight_missing")
                else:
                    deferred.append(event)
                continue
            earliest = (self.last_contact_ms.get(event["motor_id"], -math.inf)
                        + MIN_HIT_INTERVAL_MS - arm["duration_ms"])
            if self.now() < earliest:
                if earliest <= event["dispatch_ms"] + LATE_MS:
                    deferred.append(event)
                else:
                    self._skip("hit_rate_limited")
                continue
            attempted = False
            try:
                attempted = True
                self.hardware.performance_commit(event["motor_id"], arm["strike"], event["preflight"], self.cancelled,
                                                 deadline_ms=event["dispatch_ms"] + LATE_MS, clock=self.now,
                                                 max_age_ms=PREFLIGHT_MAX_AGE_MS)
                contact = self.now() + arm["duration_ms"]
                self.last_contact_ms[event["motor_id"]] = contact
                arm.update(state="striking", due_ms=contact)
                self.played += 1
            except DrumPerformanceLate:
                self._skip("dispatch_late")
            except Exception as error:
                if attempted:
                    # An uncertain acknowledgement can still mean the goal
                    # reached the motor; never retry it or shorten its cooldown.
                    self.last_contact_ms[event["motor_id"]] = self.now() + arm["duration_ms"]
                self._handle_fault(arm, error)
        if self.state == "ready" and not self.cancelled.is_set():
            self.events.extend(event for event in deferred
                               if self.arms[event["motor_id"]]["state"] == "ready")
            self.events.sort(key=lambda value: value["dispatch_ms"])

    def _stage_upcoming(self):
        for event in list(self.events):
            self._dispatch_ready()
            if self.state != "ready":
                return
            if event not in self.events or "preflight" in event:
                continue
            now = self.now()
            if now < event["dispatch_ms"] - PREFLIGHT_LEAD_MS:
                break
            arm = self.arms[event["motor_id"]]
            if arm["state"] != "ready":
                continue
            # Do not bury a prepared, imminent goal behind another full serial
            # read. The 450 ms lead reserves time for four selected arms.
            imminent = min((item["dispatch_ms"] for item in self.events if "preflight" in item), default=math.inf)
            if imminent - now < PREFLIGHT_BUDGET_MS:
                continue
            try:
                event["preflight"] = self.hardware.performance_stage(
                    event["motor_id"], arm["rest"], arm["strike"], arm["duration_ms"], self.cancelled,
                    deadline_ms=event["dispatch_ms"] + LATE_MS, clock=self.now)
            except DrumPerformanceLate:
                self.events.remove(event)
                self._skip("preflight_late")
            except DrumPerformanceSettling as error:
                self._await_rest(arm, error, preflight=True)
            except Exception as error:
                self._handle_fault(arm, error)
        self._dispatch_ready(skip_unprepared=True)

    def pump(self):
        with self.lock:
            self._apply_cancellation()
            if self.cancelled.is_set():
                return
            now = self.now()
            if self.state in ("preparing", "ready") and now - self.heartbeat > HEARTBEAT_MS:
                self._cancel_pending("Drum heartbeat timed out. Start a new performance.")
            self._dispatch_ready()
            # Finish healthy returns even after ordinary stop, watchdog or a peer arm fault.
            for motor, arm in self.arms.items():
                self._dispatch_ready()
                if self.cancelled.is_set():
                    break
                if arm["state"] not in ("preparing", "striking", "returning", "recovering") or self.now() < arm["due_ms"]:
                    continue
                try:
                    if arm["state"] == "striking":
                        self.hardware.performance_move(motor, arm.get("return_position", arm["rest"]), RETURN_MS, self.cancelled)
                        due = self.now() + RETURN_MS
                        arm.update(state="returning", due_ms=due,
                                   settle_deadline_ms=due + REST_SETTLE_MS, settling=False,
                                   rest_recheck_started=False)
                    else:
                        self.hardware.performance_verify(motor, arm["rest"], self.cancelled)
                        arm.update(state="ready", settling=False)
                except DrumPerformanceSettling as error:
                    # A profile's nominal end is not proof that the mechanical
                    # arm has settled. Poll healthy readbacks without sleeping
                    # under the shared bus lock or extending this fixed deadline.
                    self._await_rest(arm, error)
                except Exception as error:
                    self._handle_fault(arm, error)
            if self.state == "preparing" and all(arm["state"] != "preparing" for arm in self.arms.values()):
                self.state = "ready"
            if self.state == "ready":
                self._stage_upcoming()

    def _run(self):
        while True:
            self.wake.wait(.005)
            self.wake.clear()
            self.pump()
            with self.lock:
                if not self.busy():
                    self.thread = None
                    return
