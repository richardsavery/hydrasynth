"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const script = fs.readFileSync(`${__dirname}/../dashboard/robot-drums.js`, "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const context = vm.createContext({ AbortController, performance: { now: () => 0 } });
vm.runInContext(script, context);
const Drums = context.HydraRobotDrums;

function harness(config = {}, clockSettings = {}) {
  let time = 0, timer = null, prepare, schedule, activeToken = null;
  let external = { running: true, bpm: 120, beat: 0, token: "track-1", rateChanging: false, ...clockSettings };
  const state = { drumsReady: true, drumTorqueEnabled: true, emergencyStopped: false, drumPerformance: null };
  const starts = [], schedules = [], stops = [], changes = [], clockSources = [];
  const ready = token => ({ ok: true, server_time_ms: 10000 + time, performance: { token, state: "ready" } });
  const hardware = {
    snapshot: () => ({ ...state }),
    startDrumming(payload, options) {
      starts.push({ ...plain(payload), options }); activeToken = payload.token;
      return prepare ? prepare(payload, options) : Promise.resolve(ready(payload.token));
    },
    scheduleDrums(payload) {
      schedules.push({ ...plain(payload), sentAt: time });
      return schedule ? schedule(payload) : Promise.resolve(ready(payload.token));
    },
    stopDrumming(payload) { stops.push(plain(payload)); if (activeToken === payload.token) activeToken = null; return Promise.resolve({ ok: true, performance: { token: payload.token, state: "stopped" } }); }
  };
  const engine = Drums.createEngine({ hardware, settings: config, now: () => time,
    clock(source) { clockSources.push(source); return { ...external, at: Object.hasOwn(external, "at") ? external.at : time }; },
    setInterval(callback, delay) { assert.equal(delay, 50); timer = callback; return 1; }, clearInterval() { timer = null; } });
  engine.subscribe(value => changes.push(plain(value)));
  return { engine, hardware, state, starts, schedules, stops, changes, clockSources, ready,
    get timer() { return timer; }, get now() { return time; }, get external() { return { ...external }; },
    clock(patch) { external = { ...external, ...patch }; },
    setPrepare(callback) { prepare = callback; }, setSchedule(callback) { schedule = callback; },
    async advance(ms, single = false) {
      const increment = single ? ms : 50;
      for (let remaining = ms; remaining > 0;) {
        const step = Math.min(increment, remaining); remaining -= step; time += step;
        if (external.running) external.beat += step * external.bpm / 60000;
        if (timer) timer(); await flush();
      }
    }
  };
}

function uiHarness(saved = {}) {
  const elements = new Map(), listeners = {}, stored = new Map([[Drums.STORAGE_KEY, JSON.stringify(saved)]]), calls = [];
  let timer = null, hardwareListener;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, value: "", checked: false, disabled: false, dataset: {}, textContent: "", classList: { add() {}, toggle() {} }, setAttribute() {}, closest() { return this; } });
    return elements.get(id);
  };
  const root = { innerHTML: "", classList: { add() {} }, querySelector: selector => element(selector.slice(1)), addEventListener(type, fn) { listeners[type] = fn; } };
  const state = { drumsReady: true, drumTorqueEnabled: true, emergencyStopped: false };
  const hardware = { snapshot: () => state, subscribe(listener) { hardwareListener = listener; listener(); },
    startDrumming(payload) { calls.push({ type: "start", ...payload }); return Promise.resolve({ ok: true, performance: { token: payload.token, state: "ready" } }); },
    scheduleDrums(payload) { calls.push({ type: "schedule", ...payload }); return Promise.resolve({ ok: true, performance: { token: payload.token, state: "ready" } }); },
    stopDrumming(payload) { calls.push({ type: "stop", ...payload }); return Promise.resolve({ ok: true }); } };
  const local = vm.createContext({ AbortController, performance: { now: () => 0 },
    setInterval(fn) { timer = fn; return 1; }, clearInterval() { timer = null; },
    localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    HydraBeatClock: { snapshot: () => ({ running: true, bpm: 120, beat: 0, at: 0, token: "ui" }) } });
  vm.runInContext(script, local);
  local.HydraRobotDrums.init(root, hardware);
  return { api: local.HydraRobotDrums, root, stored, calls, state,
    element: key => element(`robot-drums-${key}`),
    click(key) { listeners.click({ target: this.element(key) }); },
    change(key, value, type = "change") { const target = this.element(key); target.value = String(value); listeners[type]({ target }); },
    hardwareChanged() { hardwareListener(); }, tick() { timer?.(); } };
}

(async () => {
  assert.deepEqual(plain(Drums.ARMS.map(arm => [arm.id, arm.role])), [[0, "kick"], [2, "snare"], [3, "hat"], [1, "ride"]]);
  assert.deepEqual(plain(Drums.settings().instruments), [0, 2, 3]);
  assert.deepEqual(plain(Drums.settings({ instruments: [3, 0, 3] }).instruments), [0, 3]);
  for (const invalid of [{ instruments: [4] }, { source: "manual" }, { style: "unknown" }, { density: -1 }, { influence: Infinity }, { fills: "" }, null]) assert.throws(() => Drums.settings(invalid));
  assert.deepEqual(plain(Drums.pattern({ density: 0 })), [], "zero density emits no events");
  const baseline = plain(Drums.pattern());
  assert.deepEqual(baseline.filter(hit => hit.role === "kick").map(hit => hit.step), [0, 8]);
  assert.deepEqual(baseline.filter(hit => hit.role === "snare").map(hit => hit.step), [4, 12]);
  assert.deepEqual(baseline.filter(hit => hit.role === "hat").map(hit => hit.step), [0, 4, 8, 12]);
  assert.ok(Drums.pattern({ style: "half" }).some(hit => hit.role === "snare" && hit.step === 8));
  assert.ok(Drums.pattern({ style: "broken" }).some(hit => hit.role === "kick" && hit.step === 10));
  const motif = [{ beat: .5, notes: [48, 60, 67], velocity: 120 }, { beat: 1.75, notes: [80], velocity: 80 }];
  const synthPattern = plain(Drums.pattern({ source: "synth", density: 100, influence: 100, instruments: [0, 1, 2, 3] }, 1, motif));
  assert.ok(synthPattern.some(hit => hit.role === "kick" && hit.beat === 4.5 && hit.fromSynth), "a prior-bar low note creates a kick at the matching phrase position");
  assert.ok(synthPattern.some(hit => hit.role === "ride" && hit.beat === 5.75 && hit.fromSynth), "high notes can cue the ride");
  assert.ok(!Drums.pattern({ source: "synth", density: 100, influence: 0 }, 1, motif).some(hit => hit.fromSynth));
  assert.ok(!Drums.pattern({ source: "synth", density: 100, influence: 100 }, 2, motif).some(hit => hit.fromSynth), "old notes are not repeated indefinitely");
  assert.ok(Drums.pattern({ density: 100, fills: 100 }, 3).length > Drums.pattern({ density: 100, fills: 0 }, 3).length);

  const idle = harness();
  idle.engine.tick(); idle.engine.configure({ density: 60 }); idle.engine.importState({ source: "synth" }); await idle.engine.stop();
  assert.equal(idle.starts.length + idle.stops.length + idle.schedules.length, 0, "mount, settings, restore, and pre-start Stop never touch hardware");
  assert.equal(idle.timer, null);
  assert.equal(idle.engine.snapshot().enabled, false);
  idle.state.drumsReady = false; idle.state.drumTorqueEnabled = false;
  idle.engine.hardwareChanged();
  idle.state.drumsReady = true; idle.state.drumTorqueEnabled = true;
  idle.engine.hardwareChanged(); idle.engine.tick(); await idle.advance(500);
  assert.equal(idle.starts.length + idle.stops.length + idle.schedules.length, 0, "Start robot preparing arm torque and rest does not enable the stopped drummer, even with music playing");
  assert.equal(idle.engine.snapshot().enabled, false);

  const h = harness();
  await h.engine.start(); await h.advance(1500);
  assert.equal(h.starts.length, 1); assert.equal(h.engine.snapshot().running, true);
  const initialHits = h.schedules.flatMap(item => item.events);
  assert.ok(initialHits.length > 3);
  assert.ok(initialHits.some(hit => hit.motor_id === 0 && hit.contactAt === 1000)
    && initialHits.some(hit => hit.motor_id === 0 && hit.contactAt === 2000), "floating-point beat arithmetic cannot discard exactly one-second repetitions");
  assert.ok(initialHits.some(hit => initialHits.some(other => other.motor_id !== hit.motor_id && other.contactAt === hit.contactAt)), "different drums remain free to strike simultaneously");
  for (const batch of h.schedules) for (const event of batch.events) {
    assert.ok(event.contactAt - batch.sentAt >= 649, "contacts leave time for serial safety checks before the strike");
    assert.ok(event.contactAt - batch.sentAt <= 951, "events stay inside the short planning horizon");
  }
  const ids = initialHits.map(hit => hit.id);
  assert.equal(new Set(ids).size, ids.length, "overlapping lookahead windows never duplicate contacts");
  assert.ok(h.schedules.some(batch => !batch.events.length), "a ready session receives heartbeats between notes");
  for (let i = 1; i < h.schedules.length; i++) assert.ok(h.schedules[i].sentAt - h.schedules[i - 1].sentAt <= 200);
  await h.engine.stop(); const afterStop = h.schedules.length; await h.advance(1000);
  assert.equal(h.schedules.length, afterStop); assert.equal(h.timer, null); assert.ok(h.stops.length);

  const dense = harness({ density: 100, fills: 100, instruments: [0, 1, 2, 3] }, { bpm: 240 });
  await dense.engine.start(); await dense.advance(8000);
  const byArm = new Map();
  for (const hit of dense.schedules.flatMap(batch => batch.events)) {
    const previous = byArm.get(hit.motor_id);
    if (previous !== undefined) assert.ok(hit.contactAt - previous >= 1000, "each drum plays at most once per second even in dense fills");
    byArm.set(hit.motor_id, hit.contactAt);
  }
  assert.ok(dense.engine.snapshot().skipped > 0);
  await dense.engine.stop();

  const wait = harness({}, { running: false });
  await wait.engine.start(); await wait.advance(250);
  assert.equal(wait.starts.length, 0); assert.equal(wait.engine.snapshot().waiting, true);
  wait.clock({ running: true }); await wait.advance(150);
  assert.equal(wait.starts.length, 1); assert.ok(wait.schedules.length);
  wait.clock({ running: false }); await wait.advance(100);
  assert.equal(wait.engine.snapshot().enabled, true); assert.ok(wait.stops.length);
  const scheduledWhilePaused = wait.schedules.length;
  await wait.advance(500); assert.equal(wait.schedules.length, scheduledWhilePaused);
  wait.clock({ running: true, beat: 0, token: "track-2" }); await wait.advance(200);
  assert.equal(wait.starts.length, 2); assert.notEqual(wait.starts[0].token, wait.starts[1].token);
  await wait.engine.stop();

  const transitions = harness();
  await transitions.engine.start(); await transitions.advance(150);
  transitions.clock({ bpm: 121 }); await transitions.advance(100);
  assert.equal(transitions.starts.length, 1, "small mapped tempo variation does not keep re-preparing the arms");
  transitions.clock({ bpm: 140 }); await transitions.advance(200);
  assert.equal(transitions.starts.length, 1, "tempo changes adapt upcoming hits without re-preparing the arms");
  transitions.clock({ beat: transitions.external.beat + 2 }); await transitions.advance(200);
  assert.equal(transitions.starts.length, 2, "a seek or phase discontinuity cannot retain future hits");
  transitions.clock({ rateChanging: true }); await transitions.advance(200);
  assert.equal(transitions.starts.length, 2); assert.equal(transitions.engine.snapshot().running, true);
  transitions.clock({ rateChanging: false }); await transitions.advance(200);
  assert.equal(transitions.starts.length, 2);
  transitions.clock({ token: "new-track" }); await transitions.advance(200);
  assert.equal(transitions.starts.length, 3, "a new track still cancels old timing even at the same BPM and beat");
  await transitions.engine.stop();

  const detected = harness({ density: 100 }, { detected: true, bpm: 120, beat: 0, beatContacts: [] });
  await detected.engine.start(); await detected.advance(1000);
  assert.equal(detected.schedules.flatMap(batch => batch.events).length, 0, "leading silence sends only keepalives, never extrapolated hits");
  detected.clock({ bpm: 83, beat: 0, beatContacts: [
    { key: "deck:0:0:0", beat: 0, at: 1825 },
    { key: "deck:0:1:0", beat: 1, at: 2460 },
    { key: "deck:0:2:0", beat: 2, at: 3210 }
  ] });
  await detected.advance(1600);
  const detectedHits = detected.schedules.flatMap(batch => batch.events);
  assert.ok(detectedHits.some(hit => hit.contactAt === 1825));
  assert.ok(detectedHits.some(hit => hit.contactAt === 2460));
  assert.ok(detectedHits.some(hit => hit.contactAt === 3210));
  assert.ok(detectedHits.every(hit => [1825, 2460, 3210].includes(hit.contactAt)), "the file map supplies contact times even when displayed BPM differs");
  assert.equal(new Set(detectedHits.map(hit => hit.id)).size, detectedHits.length, "overlapping map windows cannot send a hit twice");
  detected.clock({ bpm: 190, beat: 200, beatContacts: [] });
  await detected.advance(1500);
  assert.equal(detected.schedules.flatMap(batch => batch.events).length, detectedHits.length, "a silent gap does not continue the last tempo");
  detected.clock({ bpm: 100, beat: 0, beatContacts: [{ key: "deck:1:0:0", beat: 0, at: detected.now + 850 }] });
  await detected.advance(200);
  assert.ok(detected.schedules.flatMap(batch => batch.events).length > detectedHits.length, "a fresh loop can schedule beat zero with its own identity");
  assert.equal(detected.starts.length, 1, "tempo jumps, silent regions, and natural loops preserve the prepared arms");
  assert.equal(detected.stops.length, 0);
  await detected.engine.stop();
  const missingMap = harness({}, { detected: true, running: false, bpm: 120, beatContacts: [],
    beatTrackingError: "Detected beats are unavailable. Analyse beats before drumming." });
  await missingMap.engine.start(); await missingMap.advance(500);
  assert.equal(missingMap.starts.length, 0, "missing selected beat timing cannot prepare or schedule the robot");
  assert.equal(missingMap.schedules.length, 0);
  assert.match(missingMap.engine.snapshot().message, /Analyse beats before drumming/);
  await missingMap.engine.stop();

  for (const source of ["mixer", "synth"]) {
    const mapped = harness({ source, density: 100, fills: 100, instruments: [0, 1, 2, 3] },
      { bpm: 80, rateChanging: source === "mixer" });
    let finishPrepare;
    mapped.setPrepare(payload => new Promise(resolve => { finishPrepare = () => resolve(mapped.ready(payload.token)); }));
    const starting = mapped.engine.start();
    await flush();
    for (let index = 0; index < 240; index++) {
      const bpm = source === "synth" ? 80 + (index % 6) * 25 : 135 + 60 * Math.sin(index / 6);
      mapped.clock({ bpm });
      if (index === 15) { finishPrepare(); await starting; }
      await mapped.advance(50);
      if (index > 15) assert.equal(mapped.engine.snapshot().running, true, `${source}: changing tempo cannot starve preparation or playback`);
    }
    assert.equal(mapped.starts.length, 1, `${source}: continuous mapped changes share one hardware session`);
    assert.equal(mapped.stops.length, 0, `${source}: a tempo update cannot cancel committed contacts`);
    const hits = mapped.schedules.flatMap(batch => batch.events);
    assert.ok(hits.length > 20, `${source}: sustained changing input must produce hits, not just heartbeats`);
    assert.equal(new Set(hits.map(hit => hit.id)).size, hits.length, "tempo changes never duplicate a beat's hit");
    const previous = new Map();
    for (const batch of mapped.schedules) for (const hit of batch.events) {
      assert.ok(hit.contactAt - batch.sentAt >= 649 && hit.contactAt - batch.sentAt <= 951);
      assert.ok(hit.contactAt - (previous.get(hit.motor_id) ?? -Infinity) >= 1000, "mapped tempo retains motor recovery spacing");
      previous.set(hit.motor_id, hit.contactAt);
    }
    for (let from = 2000; from < 12000; from += 2000) {
      assert.ok(hits.some(hit => hit.contactAt >= from && hit.contactAt < from + 2000), `${source}: no silent interval during continuous tempo changes`);
    }
    assert.ok(mapped.schedules.some(batch => !batch.events.length));
    await mapped.engine.stop();
  }

  const noteFeed = harness({ source: "synth", density: 100, influence: 100 }, { token: "synth-1" });
  noteFeed.engine.recordNote({ beat: 2.5, notes: [48], velocity: 120, token: "old-synth" });
  assert.equal(noteFeed.engine.snapshot().noteCount, 0, "events from an obsolete source are rejected");
  noteFeed.engine.recordNote({ beat: 2.5, notes: [48], velocity: 120, token: "synth-1" });
  noteFeed.engine.recordNote({ beat: .5, notes: [NaN, 200], velocity: 120, token: "synth-1" });
  assert.equal(noteFeed.engine.snapshot().noteCount, 1);
  await noteFeed.engine.start(); await noteFeed.advance(3400);
  assert.ok(noteFeed.schedules.flatMap(batch => batch.events).some(hit => hit.motor_id === 0 && Math.abs(hit.contactAt - 3250) < .001), "the previous synth bar's actual onset schedules an answering kick when its drum has recovered");
  noteFeed.clock({ token: "synth-2", beat: 0 }); await noteFeed.advance(150);
  assert.equal(noteFeed.engine.snapshot().noteCount, 0, "a new synth transport clears its previous phrase");
  await noteFeed.engine.stop();

  const late = harness();
  await late.engine.start(); await late.advance(100); await late.advance(4000, true);
  for (const batch of late.schedules) for (const hit of batch.events) assert.ok(hit.contactAt >= batch.sentAt + 649, "returning from a suspended tab never catches up old strikes");
  await late.engine.stop();

  for (const fault of ["emergency", "torque", "disconnect", "server"]) {
    const safety = harness(); await safety.engine.start(); await safety.advance(100);
    if (fault === "emergency") safety.state.emergencyStopped = true;
    if (fault === "torque") safety.state.drumTorqueEnabled = false;
    if (fault === "disconnect") safety.state.drumsReady = false;
    if (fault === "server") safety.state.drumPerformance = { token: safety.starts[0].token, state: "error", error: "Watchdog stopped" };
    safety.engine.hardwareChanged(); await safety.advance(50); await flush();
    assert.equal(safety.engine.snapshot().enabled, false, `${fault} stops explicit drumming intent`);
    assert.ok(safety.engine.snapshot().error);
    safety.state.emergencyStopped = false; safety.state.drumTorqueEnabled = true; safety.state.drumsReady = true; safety.state.drumPerformance = null;
    await safety.advance(500); assert.equal(safety.starts.length, 1, "hardware recovery does not restart arms without another Start");
  }

  const invalidResponse = harness();
  invalidResponse.setSchedule(({ token }) => Promise.resolve({ ok: true, performance: { token, state: "error", error: "Watchdog expired" } }));
  await invalidResponse.engine.start(); await invalidResponse.advance(100);
  assert.equal(invalidResponse.engine.snapshot().enabled, false); assert.match(invalidResponse.engine.snapshot().error, /Watchdog/);

  const failedReturn = harness();
  const returnError = "Drum 2 did not reach raised rest before the settling timeout: read 2265, expected 2300 ± 20.";
  failedReturn.setSchedule(({ token }) => Promise.reject(Object.assign(new Error("This drum performance session is no longer active."), {
    result: { ok: false, performance: { token, state: "error", error: returnError, played: 3, skipped: 0 } }
  })));
  failedReturn.hardware.stopDrumming = () => Promise.reject(new Error("Connection lost during stop."));
  await failedReturn.engine.start(); await failedReturn.advance(100);
  assert.equal(failedReturn.engine.snapshot().enabled, false);
  assert.equal(failedReturn.engine.snapshot().played, 3, "fault responses retain the strikes sent before failure");
  assert.equal(failedReturn.engine.snapshot().error, `${returnError} Stop could not be confirmed: Connection lost during stop.`, "cleanup failure cannot hide the original return error");
  await failedReturn.advance(2000);
  assert.equal(failedReturn.starts.length, 1, "a real return failure does not automatically start more motion");

  const unrelatedError = harness();
  unrelatedError.setSchedule(() => Promise.reject(Object.assign(new Error("This drum performance session is no longer active."), {
    result: { performance: { token: "another-session", state: "error", error: "Unrelated fault", played: 99 } }
  })));
  await unrelatedError.engine.start(); await unrelatedError.advance(100);
  assert.equal(unrelatedError.engine.snapshot().error, "This drum performance session is no longer active.");
  assert.equal(unrelatedError.engine.snapshot().played, 0, "a different session's fault must not be attributed to this one");

  const accepted = harness();
  accepted.setSchedule(({ token, events }) => Promise.resolve({ ...accepted.ready(token), accepted: events.slice(0, 1).map(hit => hit.id), skipped: events.slice(1).map(hit => ({ id: hit.id, reason: "arm_recovering" })) }));
  await accepted.engine.start(); await accepted.advance(1000);
  assert.equal(accepted.engine.snapshot().scheduled, accepted.schedules.filter(batch => batch.events.length).length, "the readout counts server-accepted hits, not every attempted hit");
  assert.ok(accepted.engine.snapshot().skipped > 0, "server-side skips are reflected in the readout");
  await accepted.engine.stop();

  const feedback = harness({ density: 0 });
  feedback.setSchedule(({ token }) => Promise.resolve({ ...feedback.ready(token), skipped: [{ id: "rejected", reason: "late" }],
    performance: { token, state: "ready", played: 2, skipped: 3 } }));
  await feedback.engine.start(); await feedback.advance(500);
  assert.equal(feedback.engine.snapshot().played, 2, "the readout reports dispatched strikes, not merely accepted events");
  assert.equal(feedback.engine.snapshot().skipped, 3, "server dispatch skips are counted once across heartbeats and admission results");
  feedback.state.drumPerformance = { token: feedback.starts[0].token, state: "ready", played: 3, skipped: 5 };
  feedback.engine.hardwareChanged();
  await feedback.advance(250);
  assert.equal(feedback.engine.snapshot().played, 3, "an older schedule response cannot overwrite newer hardware counts");
  assert.equal(feedback.engine.snapshot().skipped, 5);
  await feedback.engine.stop();

  const isolated = harness({ density: 100 });
  await isolated.engine.start(); await isolated.advance(100);
  isolated.state.drumPerformanceConnected = true;
  isolated.state.drumsReady = false;
  isolated.state.drumTorqueEnabled = false;
  const isolatedToken = isolated.starts[0].token;
  isolated.state.drumPerformance = { token: isolatedToken, state: "ready", error: null,
    arms: [{ motor_id: 0, state: "ready" }, { motor_id: 3, state: "recovering" }] };
  isolated.engine.hardwareChanged();
  const beforeRecovery = isolated.schedules.length;
  await isolated.advance(600);
  assert.equal(isolated.engine.snapshot().enabled, true, "a recovering arm cannot stop its peers");
  assert.ok(isolated.schedules.length > beforeRecovery, "heartbeats and future hits continue");
  isolated.state.drumPerformance.arms[1] = { motor_id: 3, state: "error", error: "Torque lost" };
  isolated.engine.hardwareChanged(); await isolated.advance(600);
  assert.equal(isolated.engine.snapshot().enabled, true, "an isolated permanent fault also leaves healthy arms running");
  assert.equal(isolated.stops.length, 0);
  await isolated.engine.stop();

  for (const reason of ["disconnect", "released", "emergency", "wrong-token"]) {
    const stopped = harness();
    await stopped.engine.start(); await stopped.advance(100);
    stopped.state.drumPerformanceConnected = reason !== "disconnect";
    stopped.state.drumPerformance = { token: reason === "wrong-token" ? "other-session" : stopped.starts[0].token,
      state: reason === "released" ? "stopped" : "ready" };
    stopped.state.emergencyStopped = reason === "emergency";
    const before = stopped.schedules.length;
    stopped.engine.hardwareChanged(); await stopped.advance(250);
    assert.equal(stopped.engine.snapshot().enabled, false, `${reason} ends the entire performance`);
    assert.equal(stopped.schedules.length, before);
    assert.ok(stopped.stops.length);
  }

  for (const timestamp of [undefined, -501, 10000]) {
    const stale = harness({}, { at: timestamp });
    await stale.engine.start(); await stale.advance(50);
    assert.equal(stale.starts.length, 0, "missing, stale, and future clock timestamps cannot start a performance");
    await stale.engine.stop();
  }
  const staleDuringRun = harness();
  await staleDuringRun.engine.start(); await staleDuringRun.advance(100);
  staleDuringRun.clock({ at: staleDuringRun.now - 501 }); await staleDuringRun.advance(50);
  assert.equal(staleDuringRun.engine.snapshot().waiting, true); assert.ok(staleDuringRun.stops.length);
  await staleDuringRun.engine.stop();

  const rejection = harness(); rejection.setPrepare(() => Promise.reject(new Error("No arm connection")));
  await rejection.engine.start(); await flush();
  assert.equal(rejection.engine.snapshot().enabled, false); assert.match(rejection.engine.snapshot().error, /No arm/); assert.ok(rejection.stops.length);

  const cancelled = harness();
  let resolvePreparation;
  cancelled.setPrepare(payload => new Promise(resolve => { resolvePreparation = () => resolve(cancelled.ready(payload.token)); }));
  const starting = cancelled.engine.start(); await flush();
  const stopping = cancelled.engine.stop();
  assert.equal(cancelled.starts[0].options.signal.aborted, true);
  resolvePreparation(); await starting; await stopping;
  assert.equal(cancelled.engine.snapshot().enabled, false); assert.equal(cancelled.schedules.length, 0);
  assert.equal(cancelled.stops.length, 2, "a preparation that completes after cancellation is closed again");

  const immediate = harness();
  const immediatelyStarting = immediate.engine.start(); const immediatelyStopping = immediate.engine.stop();
  await immediatelyStarting; await immediatelyStopping;
  assert.equal(immediate.starts.length, 0, "Stop before preparation dispatch prevents the start request");

  const pendingSchedule = harness();
  const pendingReplies = [];
  pendingSchedule.setSchedule(payload => new Promise(resolve => pendingReplies.push({ token: payload.token, resolve })));
  await pendingSchedule.engine.start(); await pendingSchedule.advance(50);
  assert.equal(pendingReplies.length, 1);
  await pendingSchedule.engine.stop(); await pendingSchedule.engine.start(); await pendingSchedule.advance(50);
  assert.equal(pendingReplies.length, 2, "an unresolved retired schedule request cannot block a new performance");
  assert.notEqual(pendingReplies[0].token, pendingReplies[1].token);
  pendingReplies[0].resolve({ ok: true, performance: { token: pendingReplies[0].token, state: "error", error: "Old session expired" } });
  await flush(); await pendingSchedule.advance(250);
  assert.equal(pendingSchedule.engine.snapshot().running, true, "an old response cannot stop the new performance");
  assert.equal(pendingReplies.length, 2, "an old finally callback cannot clear the new in-flight request");
  pendingReplies[1].resolve(pendingSchedule.ready(pendingReplies[1].token)); await flush();
  pendingSchedule.setSchedule(payload => Promise.resolve(pendingSchedule.ready(payload.token)));
  await pendingSchedule.advance(50);
  assert.ok(pendingSchedule.schedules.length > 2, "new-session heartbeats continue after its own request completes");
  await pendingSchedule.engine.stop();

  const edits = harness(); await edits.engine.start(); await edits.advance(100);
  edits.engine.configure({ source: "synth" }); await flush();
  assert.equal(edits.engine.snapshot().enabled, false); assert.equal(edits.engine.snapshot().settings.source, "synth");
  await edits.engine.start(); await edits.advance(100);
  edits.engine.importState({ density: 20 }); await flush();
  assert.equal(edits.engine.snapshot().enabled, false, "restoring settings always stops performance");
  assert.ok(!Object.hasOwn(edits.engine.exportState(), "enabled"), "session exports contain settings, never running state");

  const ui = uiHarness({ source: "synth", density: 42 });
  assert.equal(ui.calls.length, 0, "mount is passive even with saved settings");
  assert.equal(ui.element("source").value, "synth"); assert.equal(ui.element("density").value, "42");
  assert.match(ui.root.innerHTML, /Start drumming/); assert.match(ui.root.innerHTML, /robot-drums-performance-title/);
  let uiUpdates = 0; ui.api.subscribe(() => uiUpdates++);
  ui.click("start"); await flush(); ui.tick(); await flush();
  assert.ok(ui.calls.some(call => call.type === "start")); assert.ok(uiUpdates > 1);
  const beforeSameSource = ui.calls.length;
  ui.api.setSource("synth");
  assert.equal(ui.api.snapshot().enabled, true, "synchronising the same Follow choice cannot stop drumming");
  assert.equal(ui.calls.length, beforeSameSource);
  ui.api.setSource("mixer"); await flush();
  assert.equal(ui.api.snapshot().enabled, false, "changing the shared Follow choice cancels queued drum hits");
  assert.equal(ui.element("source").value, "mixer");
  assert.equal(ui.element("influence").disabled, true);
  assert.equal(JSON.parse(ui.stored.get(Drums.STORAGE_KEY)).source, "mixer");
  assert.ok(ui.calls.some(call => call.type === "stop"));
  const afterSourceStop = ui.calls.length;
  ui.tick(); await flush();
  assert.equal(ui.calls.length, afterSourceStop, "source changes never restart drumming automatically");
  ui.change("density", 25, "input"); await flush();
  assert.equal(ui.api.snapshot().enabled, false); assert.equal(ui.element("density-value").textContent, "25%");
  assert.equal(JSON.parse(ui.stored.get(Drums.STORAGE_KEY)).density, 25);
  ui.api.importState({ source: "mixer", density: 0 }); await flush();
  assert.equal(ui.element("influence").disabled, true); assert.equal(ui.api.snapshot().enabled, false);
  console.log("Robot drum generator, scheduling, cancellation, shared source selection, and passive UI tests passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
