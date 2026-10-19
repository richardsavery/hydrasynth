"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const script = fs.readFileSync(`${__dirname}/../dashboard/robot-live.js`, "utf8");
const copy = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const headCalibration = { device: "/dev/cu.MOCK-HEAD", baudrate: 1000000, axes: [
  { id: 0, label: "Motor 0", min: 1400, centre: 2000, max: 2700 },
  { id: 1, label: "Motor 1", min: 1900, centre: 2500, max: 3100 }
] };
const headState = { headReady: true, headConnected: true, headTorqueEnabled: true, headCalibration, headPositions: { 0: 2000, 1: 2500 } };

function harness(config = {}, environment = {}) {
  let now = 0, timer = null, interval, move = () => Promise.resolve(), headMove = () => Promise.resolve();
  let external = { running: true, bpm: 120, beat: 0, source: "mixer", label: "Music mixer" };
  const state = { armed: true, emergencyStopped: false, ribsReady: true, torqueEnabled: true, drumsReady: true, drumTorqueEnabled: true, ledConnected: true, ledName: "Plasma 2040", busy: false, ...headState };
  const leds = [], ribs = [], heads = [], headCues = [], headBatches = [], changes = [], clockSources = [], context = vm.createContext({ AbortController, performance: { now: () => now }, setInterval() {}, clearInterval() {} });
  vm.runInContext(script, context);
  const hardware = { snapshot: () => ({ ...state }), sendColour(colour, brightness) { leds.push({ colour, brightness }); },
    moveRibs(position, duration, options) { ribs.push({ position, duration }); return move(options); },
    moveHeadAxes(targets, options) {
      headBatches.push({ targets: copy(targets), time: now, beat: external.beat });
      for (const { motor_id: id, position, duration_ms: duration } of targets) {
        heads.push({ id, position, duration }); headCues.push({ id, position, duration, time: now, beat: external.beat });
      }
      return headMove(options, targets);
    } };
  const engine = context.HydraRobotLive.createEngine({ hardware, settings: config, now: () => now,
    setInterval(callback, delay) { timer = callback; interval = delay; return 1; }, clearInterval() { timer = null; },
    clock(source) { clockSources.push(source); assert.ok(["mixer", "synth"].includes(source)); return { ...external }; }, ...environment });
  engine.subscribe(value => changes.push(copy(value)));
  return { engine, hardware, state, leds, ribs, heads, headCues, headBatches, changes, clockSources,
    advance(ms) { now += ms; if (external.running) external.beat += ms * external.bpm / 60000; if (timer) timer(); },
    clock(value) { external = { ...external, ...value }; },
    setMove(callback) { move = callback; }, setHeadMove(callback) { headMove = callback; }, get now() { return now; }, get timer() { return timer; }, get interval() { return interval; } };
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
}

function uiHarness(saved = {}, initialState = {}, options = {}) {
  let now = 0, callback, hardwareListener, emergencyCalls = 0, resetCalls = 0, prepare;
  let external = { running: true, bpm: 120, beat: 0, label: "Music mixer" };
  const elements = new Map(), markupIds = new Set(), listeners = {}, sent = [], persisted = new Map([["hydra-robot-live-settings-v1", JSON.stringify(saved)]]);
  const prepareCalls = [], headMoves = [], headTorques = [];
  const state = { armed: true, emergencyStopped: false, ribsReady: true, torqueEnabled: true, drumsReady: true, drumTorqueEnabled: true, ledConnected: true, ledName: "Plasma 2040", busy: false, ...headState, ...initialState };
  function get(id) {
    if (!elements.has(id)) elements.set(id, { id, value: "", textContent: "", checked: false, disabled: false, hidden: false, dataset: {},
      classList: { add() {}, toggle() {} }, style: { setProperty() {} }, setAttribute(key, value) { this[key] = value; }, closest() { return this; } });
    return elements.get(id);
  }
  const root = { classList: { add() {} }, querySelector: selector => get(selector.slice(1)), addEventListener: (kind, listener) => { listeners[kind] = listener; } };
  Object.defineProperty(root, "innerHTML", { set(html) {
    for (const match of html.matchAll(/<(input|select|button|output|span|p|div)\b([^>]*)>/g)) {
      const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(pair => [pair[1], pair[2]]));
      if (!attrs.id) continue;
      markupIds.add(attrs.id);
      Object.assign(get(attrs.id), { value: attrs.value || "", type: attrs.type || "", checked: /\schecked(?:\s|$)/.test(match[2]), disabled: /\sdisabled(?:\s|$)/.test(match[2]) });
    }
  } });
  const indicator = get("indicator");
  const hardware = { snapshot: () => ({ ...state }), subscribe(listener) { hardwareListener = listener; listener(); return () => {}; },
    prepareLive(options, context) { prepareCalls.push({ options: copy(options), context }); return prepare(options, context); },
    emergencyStop() { emergencyCalls++; state.emergencyStopped = true; state.armed = false; state.torqueEnabled = false; hardwareListener(); return Promise.resolve(); },
    resetEmergency() { resetCalls++; state.emergencyStopped = false; state.armed = true; hardwareListener(); return Promise.resolve(); },
    sendColour(colour, brightness) { sent.push({ colour, brightness }); }, moveRibs() { return Promise.resolve(); },
    moveHeadAxes(targets, options) { headMoves.push({ targets: copy(targets), signal: options?.signal }); return Promise.resolve({ head: { last_move: { targets } } }); },
    setHeadTorque(enabled) { headTorques.push(enabled); state.headTorqueEnabled = enabled; hardwareListener(); return Promise.resolve(); } };
  const defaultPrepare = async ({ leds, ribs, head, drums }) => {
    if (leds) state.ledConnected = true;
    if (ribs) { state.ribsReady = true; state.torqueEnabled = true; state.armed = true; }
    if (head) { state.headReady = true; state.headConnected = true; state.headTorqueEnabled = true; }
    if (drums) { state.drumsReady = true; state.drumTorqueEnabled = true; }
    hardwareListener(); return hardware.snapshot();
  };
  prepare = defaultPrepare;
  const drumListeners = new Set(), drumSourceChanges = [];
  let drumState = { enabled: false, settings: { source: options.drumSource || "mixer" } };
  const drumAPI = {
    init() {}, snapshot: () => drumState,
    setSource(source) {
      if (source === drumState.settings.source) return;
      drumSourceChanges.push(source);
      // Match the real cancellation callback with the old settings first.
      drumState = { ...drumState, enabled: false };
      for (const listener of drumListeners) listener(drumState);
      drumState = { ...drumState, settings: { source } };
      for (const listener of drumListeners) listener(drumState);
    },
    subscribe(listener) { drumListeners.add(listener); listener(drumState); return () => drumListeners.delete(listener); },
    stop() { drumState = { ...drumState, enabled: false }; }, activate() {}
  };
  const context = vm.createContext({ performance: { now: () => now }, setInterval(fn) { callback = fn; return 1; }, clearInterval() { callback = null; },
    ...(options.drums ? { HydraRobotDrums: drumAPI } : {}),
    AbortController,
    document: { querySelectorAll: () => [indicator] }, localStorage: { getItem: key => persisted.get(key), setItem: (key, value) => persisted.set(key, value) } });
  vm.runInContext(script, context);
  const api = context.HydraRobotLive;
  api.init({ container: root, hardware, clock(source) { assert.ok(["mixer", "synth"].includes(source)); return options.clock ? options.clock(source) : { ...external }; } });
  const element = key => get(`robot-live-${key}`);
  return { api, sent, indicator, persisted, element, state, prepareCalls, headMoves, headTorques, drumAPI, drumSourceChanges, hasElement: key => markupIds.has(`robot-live-${key}`),
    get emergencyCalls() { return emergencyCalls; },
    get resetCalls() { return resetCalls; },
    setPrepare(callback) { prepare = callback || defaultPrepare; },
    emitHardware() { hardwareListener(); },
    resetEmergency() { state.emergencyStopped = false; state.armed = true; hardwareListener(); },
    input(key, value) { const target = element(key); target.value = String(value); listeners.input({ target }); },
    change(key, value) { const target = element(key); if (target.type === "checkbox") target.checked = value; else target.value = String(value); listeners.change({ target }); },
    click(key) { listeners.click({ target: element(key) }); },
    clock(value) { external = { ...external, ...value }; },
    advance(ms) { now += ms; if (external.running) external.beat += ms * external.bpm / 60000; if (callback) callback(); } };
}

(async () => {
  const h = harness();
  assert.equal(h.leds.length, 0);
  assert.equal(h.ribs.length, 0);
  assert.equal(h.timer, null, "initialization does not run the clock or send outputs");
  h.engine.configure({ brightness: 50, palette: ["#ff0000", "#00ff00", "#0000ff"] });
  h.engine.stop();
  assert.equal(h.leds.length, 0, "editing and stopping before Start never send hardware commands");
  h.engine.start();
  assert.equal(h.interval, 50);
  assert.deepEqual(h.leds, [{ colour: "#ff0000", brightness: 50 }]);
  h.advance(250);
  assert.equal(h.leds.length, 1, "steady colour isn't resent every timer tick");
  h.advance(250);
  assert.deepEqual(h.leds[1], { colour: "#00ff00", brightness: 50 });
  h.advance(500);
  assert.deepEqual(h.leds[2], { colour: "#0000ff", brightness: 50 });
  const beforeDelay = h.leds.length;
  h.advance(11000);
  assert.ok(h.leds.length <= beforeDelay + 1, "a delayed timer sends at most the current colour, not missed beats");
  h.engine.stop();
  assert.deepEqual(h.leds.at(-1), { colour: "#000000", brightness: 0 }, "explicit Stop switches LEDs off");
  const stoppedCount = h.leds.length;
  h.advance(10000);
  assert.equal(h.leds.length, stoppedCount);
  assert.equal(h.timer, null);

  const pulse = harness({ ledMode: "pulse", brightness: 64, palette: ["#ff0000"] });
  pulse.engine.start();
  pulse.advance(125);
  assert.equal(pulse.leds.at(-1).brightness, 36);
  pulse.advance(375);
  assert.equal(pulse.leds.at(-1).brightness, 64, "pulse returns to full intensity on the beat");
  pulse.engine.configure({ leds: false });
  assert.deepEqual(pulse.leds.at(-1), { colour: "#000000", brightness: 0 });
  assert.equal(pulse.engine.snapshot().running, true, "turning off effects keeps the prepared drum arms ready");
  pulse.engine.stop();

  const tempo = harness({ source: "manual", bpm: 240, palette: ["#ff0000", "#00ff00"] });
  tempo.engine.start(); tempo.advance(250);
  assert.equal(tempo.leds.length, 1, "legacy robot tempo cannot override Music tempo");
  tempo.clock({ bpm: 60 }); tempo.advance(250);
  assert.equal(tempo.engine.snapshot().clock.beat, .75, "Music tempo changes preserve its current beat phase");
  assert.equal(tempo.leds.length, 1, "LEDs wait for the beat at the new Music tempo");
  tempo.advance(250);
  assert.equal(tempo.engine.snapshot().clock.beat, 1);
  assert.equal(tempo.leds.at(-1).colour, "#00ff00", "LED timing follows Music tempo changes");
  assert.equal(tempo.engine.snapshot().settings.bpm, undefined);
  assert.equal(tempo.engine.snapshot().settings.source, "mixer");
  assert.ok(tempo.clockSources.length > 0);
  tempo.engine.stop();

  const synced = harness({ source: "synth" });
  synced.clock({ running: false, beat: 12 }); synced.engine.start();
  assert.equal(synced.engine.snapshot().waiting, true);
  assert.equal(synced.leds.length, 0, "a stopped source produces no initial cue");
  synced.clock({ running: true }); synced.advance(50);
  assert.equal(synced.leds.length, 1);
  synced.clock({ running: false, beat: 12.5 }); synced.advance(10000);
  assert.equal(synced.leds.length, 1, "source pause suspends cues");
  assert.equal(synced.engine.snapshot().clock.beat, 12.5, "waiting does not substitute a robot clock");
  synced.clock({ running: true, beat: 63 }); synced.advance(50);
  assert.equal(synced.leds.length, 2, "resume advances directly to the current source beat");
  synced.clock({ beat: 0 }); synced.advance(50);
  assert.equal(synced.leds.length, 3, "transport rewind resets pattern boundaries");
  synced.engine.stop();

  const clocks = { mixer: { running: false, bpm: 120, beat: 0 }, synth: { running: true, bpm: 90, beat: 8 } };
  const sourceRequests = [];
  const synthFollower = harness({ source: "synth", ribs: true, headEnabled: true }, {
    clock(source) { sourceRequests.push(source); return { ...clocks[source] }; }, random: seededRandom(4)
  });
  synthFollower.engine.start(); await flush();
  assert.equal(synthFollower.engine.snapshot().waiting, false, "Synth mixer can drive all effects while Music mixer is stopped");
  assert.equal(synthFollower.engine.snapshot().clock.label, "Synth mixer");
  assert.equal(synthFollower.engine.snapshot().clock.bpm, 90);
  assert.equal(synthFollower.leds.length, 1);
  assert.equal(synthFollower.ribs.length, 1);
  assert.ok(synthFollower.heads.length > 0);
  assert.ok(sourceRequests.every(source => source === "synth"));
  clocks.synth.running = false;
  clocks.mixer.running = true;
  const pausedCounts = [synthFollower.leds.length, synthFollower.ribs.length, synthFollower.heads.length];
  synthFollower.advance(12000); await flush();
  assert.equal(synthFollower.engine.snapshot().waiting, true, "another playing mixer cannot override the selected source");
  assert.deepEqual([synthFollower.leds.length, synthFollower.ribs.length, synthFollower.heads.length], pausedCounts);
  clocks.synth = { running: true, bpm: 150, beat: 20 };
  synthFollower.advance(50); await flush();
  assert.equal(synthFollower.engine.snapshot().clock.bpm, 150);
  assert.equal(synthFollower.engine.snapshot().waiting, false);
  assert.ok(synthFollower.ribs.length > pausedCounts[1]);
  const beforeSwitch = synthFollower.heads.length;
  synthFollower.engine.configure({ source: "mixer" });
  synthFollower.advance(50); await flush();
  assert.equal(synthFollower.engine.snapshot().clock.source, "mixer");
  assert.equal(synthFollower.heads.length, beforeSwitch, "switching clocks does not retarget an accepted head movement");
  synthFollower.engine.stop();

  const ribs = harness({ leds: false, ribs: true });
  ribs.engine.start(); await flush();
  assert.deepEqual(ribs.ribs, [{ position: 20, duration: 1800 }]);
  ribs.advance(2000); await flush();
  assert.deepEqual(ribs.ribs.at(-1), { position: 100, duration: 1800 });
  ribs.advance(2000); await flush();
  assert.equal(ribs.ribs.at(-1).position, 20);
  ribs.clock({ bpm: 60 }); ribs.advance(4000); await flush();
  assert.deepEqual(ribs.ribs.at(-1), { position: 100, duration: 3600 }, "the next rib movement uses the Music tempo");
  ribs.clock({ bpm: 20 }); ribs.engine.configure({ ribBeats: 16 }); ribs.advance(50); await flush();
  assert.equal(ribs.ribs.at(-1).duration, 5000, "movement duration never exceeds the hardware limit");
  ribs.engine.stop();
  const count = ribs.ribs.length;
  ribs.advance(50000);
  assert.equal(ribs.ribs.length, count);
  assert.equal(ribs.leds.length, 0, "rib-only performance never touches LEDs");

  const slow = harness({ leds: false, ribs: true });
  let resolveMove;
  slow.setMove(() => new Promise(resolve => { resolveMove = resolve; }));
  slow.engine.start();
  slow.advance(2000);
  assert.equal(slow.ribs.length, 1, "in-flight serial request prevents overlapping movement");
  resolveMove(); await flush(); slow.advance(100);
  assert.equal(slow.ribs.length, 1, "a skipped boundary is not replayed when serial finishes");
  slow.advance(1900);
  assert.equal(slow.ribs.length, 2, "movement resumes on a fresh boundary");
  slow.engine.stop();
  assert.throws(() => slow.engine.start(), /Wait for the current rib/);
  resolveMove(); await flush(); slow.advance(10000);
  assert.equal(slow.ribs.length, 2, "finishing an old request after Stop cannot send another movement");

  const busy = harness({ leds: false, ribs: true });
  busy.state.busy = true; busy.engine.start(); busy.state.busy = false; busy.advance(50);
  assert.equal(busy.ribs.length, 0, "a setup request is not overlapped or queued behind");
  busy.advance(1950); await flush(); assert.equal(busy.ribs.length, 1); busy.engine.stop();

  const failure = harness({ ribs: true });
  failure.setMove(() => Promise.reject(new Error("Motor 21 stopped responding")));
  failure.engine.start(); await flush();
  assert.equal(failure.engine.snapshot().running, false);
  assert.match(failure.engine.snapshot().error, /Motor 21/);
  const errorCount = failure.leds.length; failure.advance(10000);
  assert.equal(failure.leds.length, errorCount, "a failed movement stops further cues");
  const synchronous = harness({ ribs: true });
  synchronous.setMove(() => { throw new Error("Serial disconnected"); }); synchronous.engine.start();
  assert.equal(synchronous.engine.snapshot().ribPending, false);
  assert.equal(synchronous.engine.snapshot().running, false);

  const stale = harness({ leds: false, ribs: true });
  let rejectOld;
  stale.setMove(() => new Promise((_, reject) => { rejectOld = reject; }));
  stale.engine.start(); stale.engine.stop(); rejectOld(new Error("Old cancelled request")); await flush();
  assert.equal(stale.engine.snapshot().error, "", "late failure from a stopped performance cannot replace its status");

  for (const [field, message] of [["armed", /Emergency stop/], ["ribsReady", /not connected/], ["torqueEnabled", /torque on/]]) {
    const unavailable = harness({ leds: false, ribs: true }); unavailable.state[field] = false;
    assert.throws(() => unavailable.engine.start(), message);
    assert.equal(unavailable.ribs.length, 0);
  }
  const emergency = harness();
  emergency.engine.start();
  emergency.state.emergencyStopped = true; emergency.engine.hardwareChanged();
  assert.equal(emergency.engine.snapshot().running, false, "an emergency stops LED-only performance too");
  assert.throws(() => emergency.engine.start(), /Emergency stop/);
  emergency.state.emergencyStopped = false; emergency.engine.hardwareChanged();
  assert.equal(emergency.engine.snapshot().running, false, "resetting emergency never resumes patterns automatically");
  const disconnect = harness(); disconnect.engine.start(); disconnect.state.ledConnected = false; disconnect.engine.hardwareChanged();
  assert.equal(disconnect.engine.snapshot().running, false);
  assert.match(disconnect.engine.snapshot().error, /LED controller disconnected/);
  const disabled = harness({ leds: false });
  assert.equal(disabled.engine.start().running, true, "the robot can stay ready with only its drum arms prepared");
  assert.equal(disabled.heads.length + disabled.ribs.length + disabled.leds.length, 0);
  disabled.engine.stop();
  assert.throws(() => disabled.engine.configure({ ribMin: 120, ribMax: 100 }), /minimum/);
  assert.equal(disabled.engine.snapshot().settings.ribMin, 20, "rejected configuration cannot partially update the pattern");
  assert.throws(() => disabled.engine.configure({ palette: ["red"] }), /palette/);

  const ui = uiHarness({ source: "manual", bpm: 240, brightness: 42 });
  assert.equal(ui.sent.length, 0);
  assert.equal(ui.api.snapshot().running, false, "restoring saved settings never starts the robot");
  assert.equal(ui.api.snapshot().settings.brightness, 42, "LED settings survive removal of saved robot tempo");
  assert.equal(ui.api.snapshot().settings.bpm, undefined);
  assert.equal(ui.api.snapshot().settings.source, "mixer");
  assert.equal(ui.prepareCalls.length, 0, "restoring settings does not connect hardware");
  for (const control of ["bpm", "tap"]) assert.equal(ui.hasElement(control), false, `robot has no ${control} control`);
  assert.equal(ui.hasElement("source"), true);
  ui.change("rib-min", 120);
  assert.match(ui.element("status").textContent, /minimum/);
  ui.click("start");
  assert.equal(ui.api.snapshot().running, false, "Start validates the displayed form, not an older accepted range");
  assert.equal(ui.sent.length, 0);
  assert.equal(ui.prepareCalls.length, 0, "an invalid displayed range never starts preparation");
  ui.change("rib-max", 125); ui.click("start"); await flush();
  assert.equal(ui.api.snapshot().running, true);
  assert.equal(ui.indicator.hidden, false);
  assert.match(ui.element("clock-label").textContent, /120 BPM/);
  const first = ui.sent.length;
  ui.api.activate(); ui.api.activate(); ui.advance(500);
  assert.equal(ui.api.snapshot().running, true, "changing tabs cannot stop or reset the clock");
  assert.equal(ui.sent.length, first + 1);
  ui.click("stop"); assert.equal(ui.indicator.hidden, true);
  assert.deepEqual(ui.sent.at(-1), { colour: "#000000", brightness: 0 });
  const stored = JSON.parse(ui.persisted.get("hydra-robot-live-settings-v1"));
  assert.equal(stored.ribMin, 120);
  assert.equal(stored.ribMax, 125, "the complete accepted form is persisted after fixing an invalid field");
  assert.equal(stored.running, undefined, "only control settings are saved; performance never auto-starts");
  assert.equal(stored.bpm, undefined, "Music tempo is not saved in robot settings");
  assert.equal(stored.source, "mixer");

  const sourceUI = uiHarness({}, {}, { drums: true, clock: source => ({ running: source === "synth", bpm: 108, beat: 0 }) });
  sourceUI.change("source", "synth");
  assert.equal(sourceUI.api.snapshot().settings.source, "synth");
  assert.equal(sourceUI.drumAPI.snapshot().settings.source, "synth", "one Follow control selects the source for movements and drums");
  assert.equal(sourceUI.sent.length + sourceUI.prepareCalls.length, 0, "source selection does not start hardware");
  assert.equal(JSON.parse(sourceUI.persisted.get("hydra-robot-live-settings-v1")).source, "synth");
  sourceUI.click("start"); await flush();
  assert.equal(sourceUI.api.snapshot().waiting, false);
  assert.equal(sourceUI.element("clock-label").textContent, "Synth mixer · 108 BPM");
  assert.equal(sourceUI.element("source-link").href, "#synth-mixer");
  sourceUI.drumAPI.setSource("mixer");
  assert.equal(sourceUI.element("source").value, "mixer", "the existing drum Follow selector also updates the shared source");
  assert.equal(sourceUI.api.snapshot().waiting, true);
  assert.match(sourceUI.element("status").textContent, /Waiting for Music mixer/);
  sourceUI.change("source", "synth");
  assert.equal(sourceUI.api.snapshot().settings.source, "synth", "cancellation snapshots cannot revert a source edit");
  sourceUI.click("stop");
  const restoredSource = uiHarness(JSON.parse(sourceUI.persisted.get("hydra-robot-live-settings-v1")), {}, { drums: true });
  assert.equal(restoredSource.api.snapshot().settings.source, "synth");
  assert.equal(restoredSource.drumAPI.snapshot().settings.source, "synth");
  assert.equal(restoredSource.prepareCalls.length + restoredSource.sent.length, 0);
  const migratedSource = uiHarness({}, {}, { drums: true, drumSource: "synth" });
  assert.equal(migratedSource.api.snapshot().settings.source, "synth", "existing Synth drumming preferences migrate to the shared control");

  const waiting = uiHarness();
  waiting.clock({ running: false }); waiting.click("start"); await flush(); waiting.advance(10000);
  assert.equal(waiting.api.snapshot().running, true);
  assert.equal(waiting.api.snapshot().waiting, true);
  assert.equal(waiting.sent.length, 0, "starting the robot waits for stopped Music without generating a separate beat");
  assert.match(waiting.element("status").textContent, /Music/);
  waiting.clock({ running: true }); waiting.advance(500);
  assert.equal(waiting.sent.length, 1, "Music playback starts robot cues on its current beat");
  waiting.click("stop");
  const emergencyUI = uiHarness();
  assert.equal(emergencyUI.hasElement("emergency-stop"), true);
  emergencyUI.click("start"); await flush();
  emergencyUI.click("emergency-stop");
  assert.equal(emergencyUI.api.snapshot().running, false, "the live emergency action stops cues immediately");
  assert.equal(emergencyUI.emergencyCalls, 1, "live emergency uses the shared hardware latch");
  assert.equal(emergencyUI.element("start").disabled, true);
  assert.match(emergencyUI.element("status").textContent, /Emergency stop active/);
  emergencyUI.resetEmergency();
  assert.equal(emergencyUI.api.snapshot().running, false);
  assert.equal(emergencyUI.element("start").disabled, false);

  const automatic = uiHarness({ ribs: true }, { ledConnected: false, ribsReady: false, torqueEnabled: false, armed: false });
  assert.match(automatic.element("led-connection").textContent, /Connects when you press Start robot/);
  assert.match(automatic.element("rib-connection").textContent, /Start robot connects and enables rib torque/);
  automatic.click("start");
  assert.equal(automatic.api.snapshot().starting, true);
  assert.equal(automatic.element("badge").textContent, "Starting");
  assert.equal(automatic.element("start").disabled, true);
  assert.equal(automatic.element("stop").disabled, false);
  assert.equal(automatic.sent.length, 0, "no cue runs before automatic connection and torque preparation");
  await flush();
  assert.equal(automatic.api.snapshot().running, true);
  assert.equal(automatic.api.snapshot().starting, false);
  assert.deepEqual(automatic.prepareCalls[0].options, { leds: true, ribs: true, head: false, drums: true }, "Start always prepares the drum arms alongside selected effects");
  assert.equal(automatic.state.torqueEnabled, true);
  assert.equal(automatic.resetCalls, 0, "ordinary Start never resets emergency stop");
  automatic.click("stop");

  const armsOnly = uiHarness({ leds: false, ribs: false, headEnabled: false });
  armsOnly.clock({ running: false }); armsOnly.click("start"); await flush();
  assert.deepEqual(armsOnly.prepareCalls[0].options, { leds: false, ribs: false, head: false, drums: true });
  assert.equal(armsOnly.api.snapshot().running, true);
  assert.equal(armsOnly.api.snapshot().waiting, false);
  assert.equal(armsOnly.sent.length + armsOnly.headMoves.length, 0);
  assert.match(armsOnly.element("status").textContent, /Drum arms ready at rest/);
  armsOnly.click("stop");

  for (const [field, message] of [["drumsReady", /Drum arms disconnected/], ["drumTorqueEnabled", /Arm torque is off/]]) {
    const lostArms = uiHarness({ leds: false, ribs: false, headEnabled: false });
    lostArms.click("start"); await flush();
    lostArms.state[field] = false; lostArms.emitHardware();
    assert.equal(lostArms.api.snapshot().running, false, "arms-only readiness ends when its connection or holding torque is lost");
    assert.match(lostArms.element("status").textContent, message);
    assert.equal(lostArms.element("start").disabled, false, "Start is available to recover arm readiness");
    lostArms.state[field] = true; lostArms.emitHardware();
    assert.equal(lostArms.api.snapshot().running, false, "recovering readbacks alone never restarts the robot");
    lostArms.click("start"); await flush();
    assert.equal(lostArms.prepareCalls.at(-1).options.drums, true);
    assert.equal(lostArms.api.snapshot().running, true);
    lostArms.click("stop");
  }

  const preparing = uiHarness({}, { ledConnected: false });
  let finishPreparing, preparation;
  preparing.setPrepare((_, context) => {
    preparation = context; context.onProgress("Connecting the LED controller…");
    return new Promise(resolve => { finishPreparing = resolve; });
  });
  preparing.click("start"); await flush();
  assert.match(preparing.element("status").textContent, /Connecting the LED/);
  preparing.click("start");
  preparing.element("start").disabled = false; preparing.click("start");
  await flush();
  assert.equal(preparing.prepareCalls.length, 1, "concurrent starts coalesce even if the disabled button guard is bypassed");
  preparing.api.activate(); preparing.api.activate();
  assert.equal(preparing.api.snapshot().starting, true, "changing tabs does not cancel startup");
  assert.equal(preparation.signal.aborted, false);
  preparing.state.ledConnected = true; finishPreparing(); await flush();
  assert.equal(preparing.api.snapshot().running, true);
  assert.equal(preparing.sent.length, 1);
  preparing.click("stop");

  const immediateStop = uiHarness();
  immediateStop.click("start"); immediateStop.click("stop"); await flush();
  assert.equal(immediateStop.prepareCalls.length, 0, "Stop in the same turn prevents even starting preparation");
  assert.equal(immediateStop.api.snapshot().running, false);
  assert.equal(immediateStop.api.snapshot().starting, false);
  assert.equal(immediateStop.sent.length, 0);

  const cancelled = uiHarness({}, { ledConnected: false });
  let finishCancelled;
  cancelled.setPrepare(() => new Promise(resolve => { finishCancelled = resolve; }));
  cancelled.click("start"); await flush();
  cancelled.click("stop");
  assert.equal(cancelled.prepareCalls[0].context.signal.aborted, true);
  assert.equal(cancelled.api.snapshot().starting, false);
  cancelled.prepareCalls[0].context.onProgress("Late connection message");
  assert.doesNotMatch(cancelled.element("status").textContent, /Late connection/);
  cancelled.state.ledConnected = true; finishCancelled(); await flush();
  assert.equal(cancelled.api.snapshot().running, false, "late successful preparation after Stop cannot start cues");
  assert.equal(cancelled.sent.length, 0);

  const replace = uiHarness({}, { ledConnected: false });
  const completions = [];
  replace.setPrepare(() => new Promise(resolve => completions.push(resolve)));
  replace.click("start"); await flush();
  replace.api.stop(); replace.click("start"); await flush();
  assert.equal(replace.prepareCalls.length, 2);
  replace.state.ledConnected = true;
  completions[0](); await flush();
  assert.equal(replace.api.snapshot().running, false, "an old completion cannot start the replacement attempt");
  assert.equal(replace.api.snapshot().starting, true, "an old finally cannot clear the replacement's progress");
  completions[1](); await flush();
  assert.equal(replace.api.snapshot().running, true);
  replace.click("stop");

  const preparationFailure = uiHarness({}, { ledConnected: false });
  preparationFailure.setPrepare(() => Promise.reject(new Error("LED controller was not found")));
  preparationFailure.click("start"); await flush();
  assert.equal(preparationFailure.api.snapshot().running, false);
  assert.equal(preparationFailure.api.snapshot().starting, false);
  assert.equal(preparationFailure.element("start").disabled, false);
  assert.match(preparationFailure.element("status").textContent, /LED controller was not found/);
  assert.equal(preparationFailure.sent.length, 0);
  preparationFailure.setPrepare(); preparationFailure.click("start"); await flush();
  assert.equal(preparationFailure.api.snapshot().running, true, "failed preparation can be retried with Start");
  preparationFailure.click("stop");

  const notReady = uiHarness({}, { ledConnected: false });
  notReady.setPrepare(() => Promise.resolve());
  notReady.click("start"); await flush();
  assert.equal(notReady.api.snapshot().running, false, "pure engine readiness checks still protect a premature preparation result");
  assert.match(notReady.element("status").textContent, /LED controller disconnected/);
  assert.equal(notReady.sent.length, 0);

  const emergencyPreparing = uiHarness({}, { ledConnected: false });
  let finishAfterEmergency;
  emergencyPreparing.setPrepare(() => new Promise(resolve => { finishAfterEmergency = resolve; }));
  emergencyPreparing.click("start"); await flush(); emergencyPreparing.click("emergency-stop");
  assert.equal(emergencyPreparing.prepareCalls[0].context.signal.aborted, true);
  assert.equal(emergencyPreparing.emergencyCalls, 1);
  assert.equal(emergencyPreparing.element("reset-emergency").hidden, false);
  emergencyPreparing.state.ledConnected = true; finishAfterEmergency(); await flush();
  assert.equal(emergencyPreparing.api.snapshot().running, false);
  assert.equal(emergencyPreparing.sent.length, 0);
  assert.equal(emergencyPreparing.resetCalls, 0, "emergency is never reset as a side effect of startup");
  emergencyPreparing.click("reset-emergency"); await flush();
  assert.equal(emergencyPreparing.resetCalls, 1, "Control has an explicit shared emergency reset");
  assert.equal(emergencyPreparing.api.snapshot().running, false, "explicit reset never resumes performance");
  assert.equal(emergencyPreparing.element("reset-emergency").hidden, true);
  assert.equal(emergencyPreparing.prepareCalls.length, 1, "reset does not reconnect or enable torque");
  emergencyPreparing.setPrepare(); emergencyPreparing.click("start"); await flush();
  assert.equal(emergencyPreparing.api.snapshot().running, true, "starting after reset still needs a separate Start action");
  emergencyPreparing.click("stop");

  const externalEmergency = uiHarness();
  let finishExternal;
  externalEmergency.setPrepare(() => new Promise(resolve => { finishExternal = resolve; }));
  externalEmergency.click("start"); await flush();
  externalEmergency.state.emergencyStopped = true; externalEmergency.emitHardware();
  assert.equal(externalEmergency.prepareCalls[0].context.signal.aborted, true, "Setup emergency also cancels Control startup");
  finishExternal(); await flush();
  externalEmergency.resetEmergency();
  assert.equal(externalEmergency.api.snapshot().running, false);
  assert.equal(externalEmergency.api.snapshot().starting, false);

  const pendingStop = uiHarness({}, { emergencyStopped: true, emergencyPending: true });
  assert.equal(pendingStop.element("reset-emergency").disabled, true);
  pendingStop.click("reset-emergency"); await flush();
  assert.equal(pendingStop.resetCalls, 0, "reset waits for a shared emergency release to settle");
  pendingStop.state.emergencyPending = false; pendingStop.state.emergencyResetPending = true; pendingStop.emitHardware();
  assert.equal(pendingStop.element("reset-emergency").disabled, true);
  pendingStop.state.emergencyResetPending = false; pendingStop.emitHardware();
  pendingStop.click("reset-emergency"); await flush();
  assert.equal(pendingStop.resetCalls, 1);
  assert.equal(pendingStop.api.snapshot().running, false);
  assert.match(script, /<h1>Keirzo control<\/h1>/);
  assert.match(script, /Keirzo setup \(if needed\)/);
  assert.doesNotMatch(script, /Robot setup|Robot control/);

  const freshHeadSettings = harness().engine.snapshot().settings;
  assert.equal(freshHeadSettings.headBeatSync, true);
  assert.equal(freshHeadSettings.headBusyness, 0);
  assert.equal(freshHeadSettings.headBusynessAuto, false);
  assert.equal(freshHeadSettings.head, false);
  assert.equal(freshHeadSettings.headEnabled, false, "fresh settings leave head hardware disabled");
  const migratedHead = harness({ head: true, headMode: "pulse", headAxis: 1, headAmount: 100, headBeats: 16, brightness: 42 });
  assert.equal(migratedHead.engine.snapshot().settings.headBusyness, 25, "old enabled head preferences migrate to a conservative manual activity");
  assert.equal(migratedHead.engine.snapshot().settings.head, true);
  assert.equal(migratedHead.engine.snapshot().settings.brightness, 42);
  for (const key of ["headMode", "headAxis", "headAmount", "headBeats"]) assert.equal(migratedHead.engine.snapshot().settings[key], undefined, `legacy ${key} is not canonical configuration`);
  assert.equal(harness({ head: false }).engine.snapshot().settings.headBusyness, 0);
  assert.equal(harness({ head: true, headBusyness: 0 }).engine.snapshot().settings.head, true, "legacy enabled settings remain enabled at the new moving baseline");
  assert.equal(harness({ headEnabled: true, headBusyness: 0 }).engine.snapshot().settings.head, true, "zero activity is a moving baseline when the head is enabled");
  assert.equal(harness({ headEnabled: false, head: true, headBusyness: 100, headBusynessAuto: true }).engine.snapshot().settings.head, false, "explicit disable wins over legacy state, activity and Auto");
  assert.equal(harness({ headBusyness: 0, headBusynessAuto: true }).engine.snapshot().settings.head, true, "Auto selects head hardware even when stored manual activity is zero");
  for (const value of [-1, 101, 25.5, ""]) assert.throws(() => migratedHead.engine.configure({ headBusyness: value }), /busy|whole|integer|between/i);

  async function advanceHead(instance, duration, step = 100) {
    for (let elapsed = 0; elapsed < duration; elapsed += step) { instance.advance(Math.min(step, duration - elapsed)); await flush(); }
  }
  async function headRun(config = {}, random = seededRandom(9123), duration = 120000, clock = { running: false, bpm: null, beat: 0 }) {
    const instance = harness({ leds: false, headEnabled: true, headBeatSync: false, headBusyness: 25, ...config }, { random });
    instance.clock(clock); instance.engine.start(); await flush();
    await advanceHead(instance, duration); instance.engine.stop(); return instance;
  }
  function assertHeadBounds(cues, maximumSpan) {
    for (const cue of cues) {
      const axis = headCalibration.axes.find(axis => axis.id === cue.id);
      assert.ok(axis, "only a saved head axis may move");
      const low = Math.round(axis.centre - (axis.centre - axis.min) * .9 * maximumSpan);
      const high = Math.round(axis.centre + (axis.max - axis.centre) * .9 * maximumSpan);
      assert.ok(Number.isInteger(cue.position) && cue.position >= low && cue.position <= high, "head activity stays within its conservative fraction of the recorded range");
      assert.ok(cue.duration >= 1000 && cue.duration <= 10000, "head movement uses eased profiles within the controller's time limits");
    }
  }
  const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const travel = cue => {
    const axis = headCalibration.axes.find(axis => axis.id === cue.id);
    return Math.abs(cue.position - axis.centre) / (cue.position < axis.centre ? axis.centre - axis.min : axis.max - axis.centre);
  };

  const zeroHead = harness({ headEnabled: false, headBeatSync: false, headBusyness: 100, headBusynessAuto: true });
  zeroHead.state.headReady = false; zeroHead.state.headTorqueEnabled = false; zeroHead.state.headCalibration = null;
  zeroHead.engine.start(); await advanceHead(zeroHead, 20000);
  assert.equal(zeroHead.heads.length, 0, "disabled head never sends goals or requires a connection, including with Auto selected");
  assert.ok(zeroHead.leds.length > 0, "disabling the head leaves other effects available"); zeroHead.engine.stop();

  const baselineHead = await headRun({ headBusyness: 0 });
  assert.ok(baselineHead.heads.length > 10, "enabled zero activity continuously moves the head");
  assertHeadBounds(baselineHead.heads, .25);
  assert.ok(baselineHead.heads.some(cue => travel(cue) > .15), "the new baseline reaches the old maximum activity envelope");
  assert.ok(baselineHead.heads.some(cue => cue.duration < 3000), "short baseline gestures finish promptly instead of inheriting a long minimum");

  const quietHead = await headRun({ headBusyness: 20 });
  const busyHead = await headRun({ headBusyness: 90 });
  const replayBusy = await headRun({ headBusyness: 90 });
  assert.deepEqual(busyHead.headCues, replayBusy.headCues, "seeded activity is reproducible without depending on random-call order");
  assert.ok(quietHead.heads.length > 4);
  assert.ok(average(busyHead.heads.map(travel)) > average(quietHead.heads.map(travel)), "higher activity explores larger distances");
  const familiarHead = await headRun({ headBusyness: 25 });
  assertHeadBounds(familiarHead.heads, .3875);
  assertHeadBounds(busyHead.heads, .745);
  const maximumHead = await headRun({ headBusyness: 100 }, seededRandom(8321), 90000);
  assertHeadBounds(maximumHead.heads, .80);
  const timedTravel = [baselineHead, familiarHead, busyHead, maximumHead].flatMap(instance => {
    const positions = new Map(headCalibration.axes.map(axis => [axis.id, axis.centre]));
    return instance.heads.map(cue => {
      const distance = Math.abs(cue.position - positions.get(cue.id));
      positions.set(cue.id, cue.position);
      return { distance, duration: cue.duration };
    });
  }).sort((a, b) => a.distance - b.distance);
  const quarter = Math.floor(timedTravel.length / 4);
  assert.ok(average(timedTravel.slice(-quarter).map(cue => cue.duration)) > average(timedTravel.slice(0, quarter).map(cue => cue.duration)), "larger sweeps receive longer average profiles than short gestures");
  for (const instance of [baselineHead, familiarHead, busyHead, maximumHead]) {
    assert.deepEqual([...new Set(instance.heads.map(cue => cue.id))].sort(), [0, 1]);
    const positions = new Map(headCalibration.axes.map(axis => [axis.id, axis.centre]));
    assert.equal(instance.headBatches[0].targets.length, 2, "both head axes start in one coordinated command");
    const previousCues = new Map();
    for (const cue of instance.headCues) {
      const previous = previousCues.get(cue.id);
      if (previous) {
        assert.notEqual(cue.position, previous.position, "each axis receives a different endpoint");
        const gap = cue.time - previous.time - previous.duration;
        assert.ok(gap >= 0 && gap <= 100, "each axis continues on its next ready tick even while its peer is moving");
      }
      previousCues.set(cue.id, cue);
    }
    for (const cue of instance.heads) {
      const distance = Math.abs(cue.position - positions.get(cue.id));
      assert.ok(distance > 0 && distance <= 675, "each planned segment moves its axis without exceeding the bounded step size");
      assert.ok(cue.duration >= Math.ceil(2000 * distance / 150), "requested duration accommodates known travel at the existing peak speed limit");
      assert.ok(distance * 1000 / cue.duration >= 49.95, "normal calibrated free movement retains a moderate average pace");
      positions.set(cue.id, cue.position);
    }
  }
  assert.ok(new Set(maximumHead.heads.map(cue => cue.duration)).size > 3, "longer movements vary in duration");
  assert.ok(new Set(maximumHead.heads.map(cue => `${cue.id}:${cue.position}`)).size > 6, "movement explores varied goals instead of repeating one gesture");

  // Model independent physical profiles, including headBusy=true while only
  // one axis is moving. This catches accidentally retaining the old global gate.
  const flowing = harness({ leds: false, headEnabled: true, headBeatSync: false, headBusyness: 60 }, { random: seededRandom(113) });
  const profiles = new Map();
  const movingAxes = () => [...profiles].filter(([, move]) => move.end > flowing.now)
    .map(([motor_id, move]) => ({ motor_id, position: move.position, duration_ms: move.duration, remaining_ms: move.end - flowing.now }));
  flowing.hardware.snapshot = () => ({ ...flowing.state, headCommandBusy: false, headBusy: movingAxes().length > 0, headMotion: movingAxes() });
  flowing.setHeadMove((options, targets) => {
    for (const target of targets) {
      assert.ok((profiles.get(target.motor_id)?.end || 0) <= flowing.now, "no active axis receives a replacement goal");
      profiles.set(target.motor_id, { end: flowing.now + target.duration_ms, position: target.position, duration: target.duration_ms });
    }
    return Promise.resolve({ head: { last_move: { targets }, motion: movingAxes() } });
  });
  flowing.engine.start(); await flush();
  assert.equal(flowing.headBatches[0].targets.length, 2);
  assert.ok(Math.abs(flowing.heads[0].duration - flowing.heads[1].duration) >= 500, "the initial turnarounds are staggered");
  let movingSamples = 0, bothMovingSamples = 0;
  for (let sample = 0; sample < 2400; sample++) {
    flowing.advance(50); await flush();
    const count = movingAxes().length;
    if (count > 0) movingSamples++;
    if (count === 2) bothMovingSamples++;
  }
  assert.ok(flowing.headBatches.slice(1).some(batch => batch.targets.length === 1), "each idle axis is replenished while its peer continues");
  assert.ok(movingSamples / 2400 > .99, "the head remains in motion through individual turnarounds");
  assert.ok(bothMovingSamples / 2400 > .90, "most of each sustained phrase uses both axes together");
  const countBeforeStop = flowing.headBatches.length;
  flowing.engine.stop(); await advanceHead(flowing, 15000);
  assert.equal(flowing.headBatches.length, countBeforeStop, "Stop ends future coordinated cues");

  const freshTiming = harness({ leds: false, headEnabled: true, headBeatSync: false, headBusyness: 40 });
  freshTiming.setHeadMove((options, targets) => Promise.resolve({ head: {
    last_move: { targets: targets.map(target => ({ ...target, duration_ms: 4000 })) },
    motion: targets.map(target => ({ motor_id: target.motor_id, remaining_ms: 1800 }))
  } }));
  freshTiming.engine.start(); await flush();
  await advanceHead(freshTiming, 1700);
  assert.equal(freshTiming.headBatches.length, 1);
  await advanceHead(freshTiming, 100);
  assert.equal(freshTiming.headBatches.length, 2, "the freshly reported remaining time avoids adding a second full duration after acknowledgement");
  freshTiming.engine.stop();
  for (const fixedRandom of [0, .5, .999999]) {
    const frozen = await headRun({ headBusyness: 60 }, () => fixedRandom, 60000);
    assert.ok(frozen.heads.length > 4, "a constant random source cannot trap target selection in a retry loop");
    assert.deepEqual([...new Set(frozen.heads.map(cue => cue.id))].sort(), [0, 1]);
    assertHeadBounds(frozen.heads, .58);
  }

  const narrowHead = harness({ leds: false, headEnabled: true, headBeatSync: false, headBusyness: 0 }, { random: seededRandom(18) });
  narrowHead.state.headCalibration = { ...headCalibration, axes: headCalibration.axes.map(axis => ({ ...axis, min: axis.centre - 20, max: axis.centre + 20 })) };
  narrowHead.engine.start(); await advanceHead(narrowHead, 10000); narrowHead.engine.stop();
  assert.ok(narrowHead.heads.length > 3);
  for (const cue of narrowHead.heads) {
    const axis = narrowHead.state.headCalibration.axes.find(axis => axis.id === cue.id);
    assert.ok(cue.position >= axis.min && cue.position <= axis.max, "pace never enlarges a narrow saved range");
    assert.equal(cue.duration, 1000, "tiny saved ranges retain the controller minimum even when that limits pace");
  }

  const slowBeatHead = await headRun({ headBusyness: 0, headBeatSync: true }, seededRandom(21), 30000, { running: true, bpm: 30, beat: 0 });
  assert.ok(slowBeatHead.heads.some(cue => cue.duration % 2000 !== 0), "slow beats cannot stretch every short gesture into a crawl");
  const slowBeatPositions = new Map(headCalibration.axes.map(axis => [axis.id, axis.centre]));
  for (const cue of slowBeatHead.heads) {
    const distance = Math.abs(cue.position - slowBeatPositions.get(cue.id));
    assert.ok(distance * 1000 / cue.duration >= 39.95, "beat synchronization preserves a moderate average movement pace");
    assert.ok(cue.duration >= Math.ceil(2000 * distance / 150), "skipping beat alignment preserves the peak-speed bound");
    slowBeatPositions.set(cue.id, cue.position);
  }

  for (const startsAtEdge of [false, true]) {
    const wideHead = harness({ leds: false, headEnabled: true, headBeatSync: false, headBusyness: 100 }, { random: seededRandom(83) });
    wideHead.state.headCalibration = { ...headCalibration, axes: [
      { id: 0, min: 0, centre: 2048, max: 4095 },
      { id: 1, min: 0, centre: 3000, max: 4095 }
    ] };
    wideHead.state.headPositions = startsAtEdge ? { 0: 0, 1: 4095 } : { 0: 2048, 1: 3000 };
    const positions = new Map(Object.entries(wideHead.state.headPositions).map(([id, position]) => [Number(id), position]));
    wideHead.engine.start(); await flush(); await advanceHead(wideHead, 120000); wideHead.engine.stop();
    assert.ok(wideHead.heads.length > 10, "large saved ranges and edge poses remain usable without overlong goals");
    for (const cue of wideHead.heads) {
      const axis = wideHead.state.headCalibration.axes.find(axis => axis.id === cue.id);
      const distance = Math.abs(cue.position - positions.get(cue.id));
      assert.ok(cue.position >= axis.min && cue.position <= axis.max, "intermediate approach goals stay inside the saved mechanical range");
      assert.ok(distance > 0 && distance <= 675, "wide or edge-starting ranges are traversed in bounded segments");
      assert.ok(cue.duration >= Math.ceil(2000 * distance / 150) && cue.duration <= 10000, "wide-range motion remains within existing profile and speed limits");
      positions.set(cue.id, cue.position);
    }
  }

  const repositionedHead = harness({ leds: false, headEnabled: true, headBeatSync: false, headBusyness: 100 }, { random: () => 0 });
  repositionedHead.state.headCalibration = { ...headCalibration, axes: [
    { id: 0, min: 0, centre: 2048, max: 4095 },
    { id: 1, min: 0, centre: 2048, max: 4095 }
  ] };
  repositionedHead.state.headPositions = { 0: 0, 1: 2048 };
  repositionedHead.state.headLastMove = { motor_id: 0, position: 3500, duration_ms: 9000, started_at: "2026-10-19T00:00:00.000Z" };
  repositionedHead.state.headCheckedAt = "2026-10-19T00:00:20.000Z";
  repositionedHead.state.commandBusy = false; repositionedHead.state.headBusy = false;
  repositionedHead.engine.start(); await flush();
  assert.equal(repositionedHead.heads[0].id, 0);
  assert.ok(repositionedHead.heads[0].position > 0 && repositionedHead.heads[0].position <= 675, "a fresh supported pose supersedes a completed historical goal when restarting");
  const repositionedFirst = repositionedHead.heads[0];
  repositionedHead.advance(repositionedFirst.duration); await flush();
  assert.equal(repositionedHead.headBatches.length, 2);
  assert.equal(repositionedHead.heads.filter(cue => cue.id === 0)[1].id, 0);
  assert.ok(Math.abs(repositionedHead.heads.filter(cue => cue.id === 0)[1].position - repositionedFirst.position) <= 675, "an ignored historical goal cannot overwrite the new trajectory on later ticks");
  repositionedHead.engine.stop();

  const releasedHead = harness({ leds: false, headEnabled: true, headBeatSync: false, headBusyness: 100 }, { random: () => 0 });
  releasedHead.state.headCalibration = repositionedHead.state.headCalibration;
  releasedHead.setHeadMove((options, targets) => Promise.resolve({ head: { last_move: {
    targets: targets.map(target => ({ ...target, duration_ms: 9000 }))
  } } }));
  releasedHead.engine.start(); await flush();
  releasedHead.state.headTorqueEnabled = false;
  releasedHead.state.headMotion = []; releasedHead.state.headLastMove = null;
  releasedHead.engine.hardwareChanged();
  assert.equal(releasedHead.engine.snapshot().running, false);
  assert.equal(releasedHead.engine.snapshot().headMoving, false, "release discards the old powered deadlines");
  releasedHead.state.headPositions = { 0: 0, 1: 4095 };
  releasedHead.state.headTorqueEnabled = true;
  releasedHead.engine.hardwareChanged();
  releasedHead.engine.start(); await flush();
  assert.equal(releasedHead.headBatches.length, 2, "a supported restart after release does not wait for cancelled profiles");
  for (const target of releasedHead.headBatches[1].targets) {
    assert.ok(Math.abs(target.position - releasedHead.state.headPositions[target.motor_id]) <= 675,
      "both axes plan from the newly supported pose after release, not their old goals");
  }
  releasedHead.engine.stop();

  for (const resetKind of ["configure", "rewind"]) {
    const acknowledgedHead = harness({ leds: false, headEnabled: true, headBeatSync: resetKind === "rewind", headBusyness: 100 }, { random: () => 0 });
    acknowledgedHead.state.headCalibration = repositionedHead.state.headCalibration;
    acknowledgedHead.state.headPositions = { 0: 0, 1: 2048 };
    acknowledgedHead.state.headLastMove = { motor_id: 0, position: 3500, duration_ms: 9000, started_at: "2026-10-19T00:00:30.000Z" };
    acknowledgedHead.state.headCheckedAt = "2026-10-19T00:00:20.000Z";
    acknowledgedHead.state.commandBusy = false; acknowledgedHead.state.headBusy = false;
    acknowledgedHead.engine.start(); await flush();
    const first = acknowledgedHead.heads[0];
    assert.equal(first.id, 0);
    assert.ok(Math.abs(first.position - 3500) <= 675, "a readback older than the acknowledged move does not replace its target origin");
    acknowledgedHead.state.headLastMove = { motor_id: first.id, position: first.position, duration_ms: first.duration, started_at: "2026-10-19T00:00:40.000Z" };
    if (resetKind === "configure") acknowledgedHead.engine.configure({ headBusyness: 90 });
    else { acknowledgedHead.clock({ beat: 10 }); acknowledgedHead.advance(0); acknowledgedHead.clock({ beat: 0 }); acknowledgedHead.advance(0); }
    await flush();
    acknowledgedHead.advance(first.duration - 1); await flush();
    assert.equal(acknowledgedHead.heads.filter(cue => cue.id === 0).length, 1, `${resetKind} still waits for the acknowledged movement profile`);
    acknowledgedHead.advance(1); await flush();
    assert.equal(acknowledgedHead.heads.filter(cue => cue.id === 0).length, 2);
    assert.equal(acknowledgedHead.heads.filter(cue => cue.id === 0)[1].id, 0);
    assert.ok(Math.abs(acknowledgedHead.heads.filter(cue => cue.id === 0)[1].position - first.position) <= 675, `${resetKind} keeps the acknowledged origin when cached pose readings predate the move`);
    acknowledgedHead.engine.stop();
  }

  const freeStoppedMusic = await headRun({ headBusyness: 60 }, seededRandom(64), 30000, { running: false, bpm: null, beat: 0 });
  const freePlayingMusic = await headRun({ headBusyness: 60 }, seededRandom(64), 30000, { running: true, bpm: 173, beat: 17 });
  assert.ok(freeStoppedMusic.heads.length > 3, "Beat sync off permits movement with Music stopped");
  assert.deepEqual(freeStoppedMusic.heads, freePlayingMusic.heads, "free head movement does not borrow Music's BPM");
  assert.deepEqual(freeStoppedMusic.headCues.map(cue => cue.time), freePlayingMusic.headCues.map(cue => cue.time), "free activity uses monotonic elapsed time rather than musical beat position");

  const freeCombined = harness({ leds: true, ribs: true, headBeatSync: false, headBusyness: 50 }, { random: seededRandom(74) });
  freeCombined.clock({ running: false, bpm: null, beat: 0 }); freeCombined.engine.start(); await flush();
  await advanceHead(freeCombined, 20000);
  assert.ok(freeCombined.heads.length > 2);
  assert.equal(freeCombined.leds.length, 0); assert.equal(freeCombined.ribs.length, 0, "unsynced head motion does not start LED or rib cues without Music");
  assert.equal(freeCombined.engine.snapshot().running, true);
  freeCombined.clock({ running: true, bpm: 120, beat: 0 }); freeCombined.advance(0); await flush();
  assert.ok(freeCombined.leds.length > 0); assert.ok(freeCombined.ribs.length > 0);
  freeCombined.engine.stop();

  const syncedHead = harness({ leds: false, headBeatSync: true, headBusyness: 100 }, { random: seededRandom(21) });
  syncedHead.clock({ running: false, bpm: 120, beat: 0 }); syncedHead.engine.start(); await advanceHead(syncedHead, 10000);
  assert.equal(syncedHead.heads.length, 0); assert.equal(syncedHead.engine.snapshot().waiting, true);
  syncedHead.clock({ running: true, bpm: 120, beat: .6 }); syncedHead.advance(0); await flush();
  assert.equal(syncedHead.heads.length, 0, "synchronized head motion waits through a stale partial beat");
  await advanceHead(syncedHead, 30000, 50);
  assert.ok(syncedHead.heads.length > 3);
  assert.ok(syncedHead.headCues[0].beat % 1 <= .31, "synchronized movement starts on a fresh musical boundary");
  assert.ok(syncedHead.headCues.some(cue => cue.duration % 500 === 0), "synchronized profile lengths still follow whole beats when pace permits");
  for (const id of [0, 1]) {
    const cues = syncedHead.headCues.filter(cue => cue.id === id);
    for (let index = 1; index < cues.length; index++) {
      const previous = cues[index - 1], current = cues[index];
      const gap = current.time - previous.time - previous.duration;
      assert.ok(gap >= 0 && gap <= 50, "beat sync does not add a beat-sized pause between an axis's settled profiles");
    }
  }
  const beforeSyncedPause = syncedHead.heads.length;
  syncedHead.clock({ running: false }); await advanceHead(syncedHead, 10000);
  assert.equal(syncedHead.heads.length, beforeSyncedPause);
  syncedHead.clock({ running: true, beat: 0 }); syncedHead.advance(0); await flush();
  assert.equal(syncedHead.heads.length, beforeSyncedPause + 2, "rewind resets synchronized activity after physical movement has settled");
  syncedHead.engine.stop();

  const freshBeatHead = harness({ leds: false, headEnabled: true, headBeatSync: true, headBusyness: 0 }, { random: seededRandom(21) });
  freshBeatHead.state.commandBusy = false; freshBeatHead.state.headBusy = true;
  freshBeatHead.engine.start(); await flush();
  assert.equal(freshBeatHead.headBatches.length, 0);
  freshBeatHead.advance(100); await flush();
  freshBeatHead.state.headBusy = false; freshBeatHead.advance(0); await flush();
  assert.equal(freshBeatHead.headBatches.length, 1, "a still-fresh beat remains available when the motor becomes ready within its cue window");
  freshBeatHead.engine.stop();

  const continuousSync = harness({ leds: false, headEnabled: true, headBeatSync: true, headBusyness: 50 });
  let acknowledgeHead;
  continuousSync.setHeadMove(() => new Promise(resolve => { acknowledgeHead = resolve; }));
  continuousSync.engine.start(); await flush();
  const firstContinuous = continuousSync.heads[0];
  continuousSync.advance(275); acknowledgeHead({ head: { last_move: { duration_ms: firstContinuous.duration } } }); await flush();
  continuousSync.setHeadMove(() => Promise.resolve());
  await advanceHead(continuousSync, firstContinuous.duration - 50, 50);
  assert.equal(continuousSync.headBatches.length, 1, "long profiles receive no intermediate replacement goals");
  continuousSync.advance(50); await flush();
  assert.equal(continuousSync.headBatches.length, 2, "a delayed acknowledgement does not force another beat wait at the next endpoint");
  assert.ok(continuousSync.headBatches[1].beat % 1 > .3, "continuation is deliberately allowed outside the initial beat window");
  continuousSync.engine.stop();

  const gatedHead = harness({ leds: false, headBeatSync: false, headBusyness: 100 }, { random: () => 0 });
  gatedHead.state.commandBusy = false; gatedHead.state.headBusy = true;
  gatedHead.engine.start(); await advanceHead(gatedHead, 12000);
  assert.equal(gatedHead.headBatches.length, 0, "backend busy prevents activity from building a motor queue");
  gatedHead.state.headBusy = false;
  gatedHead.setHeadMove(() => Promise.resolve({ head: { last_move: { duration_ms: 9800 } } }));
  for (let count = 0; count < 100 && !gatedHead.headBatches.length; count++) { gatedHead.advance(100); await flush(); }
  assert.equal(gatedHead.headBatches.length, 1);
  await advanceHead(gatedHead, 9700);
  assert.equal(gatedHead.headBatches.length, 1, "even maximum activity honors the driver's actual duration");
  await advanceHead(gatedHead, 1000);
  assert.ok(gatedHead.headBatches.length >= 2);
  for (let index = 1; index < gatedHead.headBatches.length; index++) assert.ok(gatedHead.headBatches[index].time - gatedHead.headBatches[index - 1].time >= 9800);
  gatedHead.state.headBusy = true;
  const beforeBusyHold = gatedHead.headBatches.length; await advanceHead(gatedHead, 20000);
  assert.equal(gatedHead.headBatches.length, beforeBusyHold, "hardware busy continues to block goals after the expected profile has elapsed");
  gatedHead.state.headBusy = false; gatedHead.advance(0); await flush();
  assert.equal(gatedHead.headBatches.length, beforeBusyHold + 1, "clearing hardware busy starts one current movement without replaying a backlog");
  gatedHead.engine.stop();

  const autoHead = harness({ leds: false, headBeatSync: false, headBusyness: 7, headBusynessAuto: true }, { random: seededRandom(44) });
  const autoMusic = harness({ leds: false, headBeatSync: false, headBusyness: 7, headBusynessAuto: true }, { random: seededRandom(44) });
  autoMusic.clock({ running: true, bpm: 173, beat: 12, amplitude: 1 }); autoMusic.engine.start();
  autoHead.clock({ running: false, bpm: null, beat: 0, amplitude: 0 }); autoHead.engine.start(); await flush();
  const autoLevels = [autoHead.engine.snapshot().headBusyness];
  const musicAutoLevels = [autoMusic.engine.snapshot().headBusyness];
  for (let index = 0; index < 2400; index++) {
    if (index === 800) autoHead.clock({ amplitude: 1, bpm: 200 });
    if (index === 1600) autoHead.clock({ amplitude: 0, bpm: null });
    autoHead.advance(100); autoMusic.advance(100); await flush();
    autoLevels.push(autoHead.engine.snapshot().headBusyness); musicAutoLevels.push(autoMusic.engine.snapshot().headBusyness);
  }
  assert.deepEqual(autoLevels, musicAutoLevels, "free Auto activity is independent of Music playback, BPM, beat position and audio amplitude");
  assert.deepEqual(autoHead.heads, autoMusic.heads, "audio changes do not influence autonomous head goals"); autoMusic.engine.stop();
  assert.ok(autoLevels.every(value => Number.isFinite(value) && value >= 15 && value <= 65), "Auto maintains a bounded autonomous activity level");
  assert.ok(new Set(autoLevels.map(Math.round)).size > 8, "Auto evolves through different activity levels over time");
  assert.ok(autoLevels.slice(1).every((value, index) => Math.abs(value - autoLevels[index]) <= 5), "Auto transitions smoothly instead of jumping between activity levels");
  assert.equal(autoHead.engine.snapshot().settings.headBusyness, 7, "Auto never overwrites the user's stored manual activity");
  assert.equal(autoHead.engine.snapshot().settings.headBusynessAuto, true);
  assertHeadBounds(autoHead.heads, .6075);
  assert.ok(autoHead.heads.length > 10, "Auto is autonomous while Music is stopped and Beat sync is off");
  autoHead.engine.configure({ headBusynessAuto: false });
  assert.equal(autoHead.engine.snapshot().headBusyness, 7, "Manual immediately restores its saved activity");
  autoHead.engine.stop();

  const both = harness({ leds: false, ribs: true, headBeatSync: true, headBusyness: 50 }, { random: seededRandom(8) });
  both.state.commandBusy = false; both.state.headBusy = false; both.state.ribsBusy = false;
  both.setMove(() => { both.state.busy = true; both.state.ribsBusy = true; return Promise.resolve(); });
  both.engine.start(); await flush();
  assert.equal(both.ribs.length, 1); assert.equal(both.headBatches.length, 1, "head and ribs can share a beat without starving either group"); both.engine.stop();

  const pendingHead = harness({ headBeatSync: true, headBusyness: 100 }, { random: seededRandom(12) });
  let cueSignal, rejectCue;
  pendingHead.setHeadMove(({ signal }) => { cueSignal = signal; return new Promise((_, reject) => { rejectCue = reject; }); });
  pendingHead.engine.start(); await flush(); await advanceHead(pendingHead, 10000);
  assert.equal(pendingHead.headBatches.length, 1, "a pending head cue prevents a backlog at any activity level");
  pendingHead.engine.configure({ headEnabled: false });
  assert.equal(cueSignal.aborted, true, "disabling the head cancels an unsent cue");
  rejectCue(Object.assign(new Error("Cancelled"), { cancelled: true })); await flush();
  assert.equal(pendingHead.engine.snapshot().running, true, "head inactivity leaves LED playback running");
  const beforeZeroHead = pendingHead.headBatches.length; await advanceHead(pendingHead, 5000);
  assert.equal(pendingHead.headBatches.length, beforeZeroHead);
  pendingHead.engine.configure({ headEnabled: true }); pendingHead.clock({ beat: 0 }); pendingHead.advance(0); await flush();
  assert.equal(pendingHead.headBatches.length, 2);
  pendingHead.clock({ running: false }); pendingHead.advance(50); await flush();
  assert.equal(cueSignal.aborted, true, "Music pause cancels a queued synchronized glance");
  rejectCue(Object.assign(new Error("Cancelled"), { cancelled: true })); await flush();
  pendingHead.clock({ running: true, beat: 1 }); pendingHead.advance(0); await flush();
  assert.equal(pendingHead.headBatches.length, 3);
  pendingHead.clock({ beat: 10 }); pendingHead.advance(0); pendingHead.clock({ beat: 0 }); pendingHead.advance(0); await flush();
  assert.equal(cueSignal.aborted, true, "Music rewind cancels the old synchronized cue");
  rejectCue(Object.assign(new Error("Cancelled"), { cancelled: true })); await flush();
  pendingHead.engine.configure({ headBeatSync: false }); pendingHead.advance(0); await flush();
  assert.equal(pendingHead.headBatches.length, 4);
  pendingHead.clock({ running: false }); pendingHead.advance(50); await flush();
  assert.equal(cueSignal.aborted, false, "Music stopping does not cancel an independent free-running head cue");
  pendingHead.engine.stop(); assert.equal(cueSignal.aborted, true);
  rejectCue(Object.assign(new Error("Cancelled"), { cancelled: true })); await flush();
  await advanceHead(pendingHead, 10000); assert.equal(pendingHead.headBatches.length, 4);
  assert.equal(pendingHead.engine.snapshot().error, "");

  const acceptedHead = harness({ leds: false, headBeatSync: false, headBusyness: 100 }, { random: () => 0 });
  let finishAccepted;
  acceptedHead.setHeadMove(() => new Promise(resolve => { finishAccepted = resolve; }));
  acceptedHead.engine.start(); acceptedHead.engine.stop();
  assert.throws(() => acceptedHead.engine.start(), /current head movement/, "a stopped but unresolved head command still owns its request slot");
  finishAccepted({ head: { last_move: { duration_ms: 6000 } } }); await flush();
  acceptedHead.setHeadMove(() => Promise.resolve()); acceptedHead.engine.start();
  await advanceHead(acceptedHead, 5900);
  assert.equal(acceptedHead.headBatches.length, 1, "a late accepted result preserves its physical duration even after Stop and Start");
  await advanceHead(acceptedHead, 1000);
  assert.equal(acceptedHead.headBatches.length, 2); acceptedHead.engine.stop();

  const queuedRib = harness({ ribs: true });
  let ribSignal, rejectRib;
  queuedRib.setMove(({ signal }) => { ribSignal = signal; return new Promise((_, reject) => { rejectRib = reject; }); });
  queuedRib.engine.start(); queuedRib.engine.configure({ ribs: false });
  assert.equal(ribSignal.aborted, true, "disabling ribs also cancels their unsent queue entry");
  rejectRib(Object.assign(new Error("Cancelled"), { cancelled: true })); await flush();
  assert.equal(queuedRib.engine.snapshot().running, true); queuedRib.engine.stop();

  const failedHead = harness({ leds: false, headBusyness: 50 }, { random: () => 0 });
  failedHead.setHeadMove(() => Promise.reject(new Error("Head calibration no longer matches")));
  failedHead.engine.start(); await flush();
  assert.equal(failedHead.engine.snapshot().running, false); assert.match(failedHead.engine.snapshot().error, /calibration/);
  for (const [key, value] of [["headReady", false], ["headTorqueEnabled", false], ["headCalibration", null]]) {
    const unavailableHead = harness({ leds: false, headBusyness: 50 }); unavailableHead.state[key] = value;
    assert.throws(() => unavailableHead.engine.start(), /Head|head/); assert.equal(unavailableHead.heads.length, 0);
  }
  const emergencyHead = harness({ leds: false, headBeatSync: false, headBusynessAuto: true });
  emergencyHead.engine.start(); await flush(); emergencyHead.state.emergencyStopped = true; emergencyHead.engine.hardwareChanged();
  const headCountAtEmergency = emergencyHead.heads.length; await advanceHead(emergencyHead, 10000);
  assert.equal(emergencyHead.heads.length, headCountAtEmergency); assert.equal(emergencyHead.engine.snapshot().running, false);
  emergencyHead.state.emergencyStopped = false; emergencyHead.engine.hardwareChanged();
  assert.equal(emergencyHead.engine.snapshot().running, false, "reset never resumes Auto head movement");

  const headUI = uiHarness({ leds: false, headBeatSync: false, headBusyness: 40 }, { headReady: false, headTorqueEnabled: false });
  for (const id of ["head-enabled", "head-beat-sync", "head-busyness-mode", "head-busyness", "head-busyness-value"]) assert.equal(headUI.hasElement(id), true, `simplified head control exposes ${id}`);
  for (const id of ["head", "head-axis", "head-mode", "head-amount", "head-beats", "head-position", "head-move", "head-centre", "head-enable", "head-release"]) assert.equal(headUI.hasElement(id), false, `obsolete head widget ${id} is removed`);
  assert.equal(headUI.headMoves.length, 0, "restored activity preferences never start hardware");
  headUI.clock({ running: false, bpm: null }); headUI.click("start"); await flush();
  assert.deepEqual(headUI.prepareCalls[0].options, { leds: false, ribs: false, head: true, drums: true });
  assert.equal(headUI.api.snapshot().running, true); assert.equal(headUI.headMoves.length, 1, "Start prepares and runs an unsynced head with Music stopped");
  headUI.api.activate(); await flush(); headUI.advance(20000); await flush();
  assert.equal(headUI.api.snapshot().running, true, "head activity continues across tab changes");
  headUI.click("stop"); assert.equal(headUI.api.snapshot().running, false);

  const migratedUI = uiHarness({ head: true, headMode: "sweep", headAxis: 1, headAmount: 90, headBeats: 16, brightness: 42 });
  assert.equal(migratedUI.api.snapshot().settings.headBusyness, 25);
  assert.equal(migratedUI.element("head-busyness").value, "25");
  migratedUI.input("brightness", 45);
  const savedMigration = JSON.parse(migratedUI.persisted.get("hydra-robot-live-settings-v1"));
  for (const key of ["headMode", "headAxis", "headAmount", "headBeats"]) assert.equal(savedMigration[key], undefined);
  assert.equal(savedMigration.headBusyness, 25); assert.equal(savedMigration.brightness, 45);
  assert.equal(savedMigration.headEnabled, true, "migration persists explicit head enablement");

  const autoUI = uiHarness({ headBeatSync: false, headBusyness: 31 });
  autoUI.change("head-busyness-mode", "auto");
  assert.equal(autoUI.api.snapshot().settings.headBusynessAuto, true);
  assert.equal(autoUI.element("head-busyness").disabled, true, "Auto owns the displayed activity while retaining the manual preference");
  autoUI.clock({ running: false, bpm: null }); autoUI.click("start"); await flush();
  autoUI.advance(15000); await flush();
  assert.equal(Number(autoUI.element("head-busyness").value), Math.round(autoUI.api.snapshot().headBusyness));
  autoUI.input("brightness", 55);
  assert.equal(autoUI.api.snapshot().settings.headBusyness, 31, "editing LEDs while Auto is displayed does not save its transient activity as the manual value");
  const savedAuto = JSON.parse(autoUI.persisted.get("hydra-robot-live-settings-v1"));
  assert.equal(savedAuto.headBusyness, 31); assert.equal(savedAuto.headBusynessAuto, true); assert.equal(savedAuto.headBeatSync, false);
  autoUI.change("head-busyness-mode", "manual");
  assert.equal(autoUI.api.snapshot().settings.headBusynessAuto, false);
  assert.equal(autoUI.element("head-busyness").value, "31"); assert.equal(autoUI.element("head-busyness").disabled, false);
  autoUI.change("head-busyness", 0);
  assert.equal(autoUI.api.snapshot().settings.head, true, "zero busyness preserves explicit head enablement");
  const beforeBaselineUIHead = autoUI.headMoves.length; autoUI.advance(20000); await flush();
  assert.ok(autoUI.headMoves.length > beforeBaselineUIHead, "setting the live slider to zero continues baseline movement");
  autoUI.change("head-enabled", false);
  assert.equal(autoUI.api.snapshot().settings.head, false);
  const noMoreUIHead = autoUI.headMoves.length; autoUI.advance(20000); await flush();
  assert.equal(autoUI.headMoves.length, noMoreUIHead);
  autoUI.click("emergency-stop"); await flush(); assert.equal(autoUI.api.snapshot().running, false);

  for (const mode of ["manual", "auto"]) {
    const enableUI = uiHarness({ headBeatSync: false, headBusyness: 0 }, { headReady: false, headTorqueEnabled: false });
    enableUI.click("start"); await flush();
    assert.equal(enableUI.api.snapshot().running, true); assert.equal(enableUI.prepareCalls[0].options.head, false);
    if (mode === "auto") enableUI.change("head-busyness-mode", "auto"); else enableUI.input("head-busyness", 35);
    await flush();
    assert.equal(enableUI.prepareCalls.length, 1, "editing activity or Auto while disabled does not prepare head hardware");
    assert.equal(enableUI.api.snapshot().settings.head, false);
    assert.equal(enableUI.headMoves.length, 0);
    enableUI.change("head-enabled", true); await flush();
    assert.equal(enableUI.prepareCalls.length, 2, "enabling head during playback prepares its connection without requiring Setup");
    assert.equal(enableUI.prepareCalls[1].options.head, true);
    assert.equal(enableUI.prepareCalls[1].options.drums, false, "enabling the head does not prepare the drum arms again");
    assert.equal(enableUI.api.snapshot().running, true); assert.equal(enableUI.headMoves.length, 1);
    enableUI.click("stop");
  }

  const enableDuringDrums = uiHarness({ ribs: true, headBeatSync: false }, { headReady: false, headTorqueEnabled: false });
  enableDuringDrums.click("start"); await flush();
  enableDuringDrums.state.drumsBusy = true;
  enableDuringDrums.state.drumPerformance = { state: "ready", busy: true, token: "playing-drums" };
  enableDuringDrums.setPrepare(async options => {
    assert.equal(options.drums, false, "head reconfiguration does not request rest while the drummer owns the arms");
    enableDuringDrums.state.headReady = true; enableDuringDrums.state.headTorqueEnabled = true;
    enableDuringDrums.emitHardware();
  });
  enableDuringDrums.change("head-enabled", true); await flush();
  assert.equal(enableDuringDrums.api.snapshot().running, true, "enabling head during drumming resumes the existing live effects");
  assert.equal(enableDuringDrums.headMoves.length, 1);
  assert.equal(enableDuringDrums.state.drumPerformance.token, "playing-drums");
  assert.doesNotMatch(enableDuringDrums.element("status").textContent, /Stop automatic drumming/);
  enableDuringDrums.click("stop");

  const cancelEnableUI = uiHarness({ headBeatSync: false, headBusyness: 0 }, { headReady: false, headTorqueEnabled: false });
  cancelEnableUI.click("start"); await flush();
  let finishEnable;
  cancelEnableUI.setPrepare(() => new Promise(resolve => { finishEnable = resolve; }));
  cancelEnableUI.change("head-enabled", true); await flush();
  assert.equal(cancelEnableUI.api.snapshot().starting, true); assert.equal(cancelEnableUI.headMoves.length, 0);
  cancelEnableUI.click("stop");
  assert.equal(cancelEnableUI.prepareCalls[1].context.signal.aborted, true);
  cancelEnableUI.state.headReady = true; cancelEnableUI.state.headTorqueEnabled = true; finishEnable(); await flush();
  assert.equal(cancelEnableUI.api.snapshot().running, false); assert.equal(cancelEnableUI.headMoves.length, 0, "late preparation cannot restart a cancelled head effect");

  console.log("Keirzo live tests passed: head activity controls, autonomous/free/synced motion, migration, safety bounds, duration gates, cancellation, startup and tab continuity.");
})().catch(error => { console.error(error); process.exitCode = 1; });
