"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const timers = new Map();
let timerId = 0, now = 0;
const element = (value = "") => ({ value, checked: false, hidden: false, disabled: false,
  children: [], classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {},
  parentElement: { classList: { toggle() {} } } });
const context = vm.createContext({
  console, document: { addEventListener() {} },
  window: { setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); } },
  localStorage: { getItem() { return null; }, setItem() {} },
  performance: { now() { return now; } }, Intl, URLSearchParams,
  fetch: async () => ({ ok: true }),
});
for (const file of ["drums.js", "sonification.js", "parameters.js", "live.js", "drum-workspace.js", "midi-safety.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard", file), "utf8"), context);
}
vm.runInContext("globalThis.player = {state, dom, controlsAt, runPlaybackTick, stopPlayback, playMidiNote, stopActiveMidiNotes, togglePlayback, Music, CONTROL_IDS, sendMidiPatch, selectMidiPatch, changeSoundAtBoundary, loadMappingSourceSeries, learnedMappingRange, resetMappingSourceRange, usableFixedRange};", context);
const { state, dom, Music, CONTROL_IDS } = context.player;
for (const [key, id] of Object.entries(CONTROL_IDS)) dom[id] = element(String(Music.DEFAULT_CONTROLS[key]));
dom["scale-root"].selectedIndex = 0;
for (const id of ["preview-button", "session-state", "playhead", "wave-progress", "waveform", "rhythm-pattern", "rhythm-readout", "toast", "voice-name", "sound-status", "sound-help", "patch-controls", "apply-patch", "harmony-readout"]) dom[id] = element();
dom["rhythm-pattern"].children = Array.from({ length: 16 }, () => element());
state.recording = { id: "test", name: "test" };
state.playSeries = new Map();

async function main() {
  // Mapping data reaches rhythm controls, rather than merely changing labels.
  state.mappings = [{ id: 1, destination: "density", curve: "linear", minimum: 0, maximum: 16 },
    { id: 2, destination: "tempo", curve: "linear", minimum: 60, maximum: 180 }];
  state.playSeries = new Map([[1, { points: [[0, 0], [1, 1]], minimum: 0, maximum: 1 }],
    [2, { points: [[0, 0], [1, 1]], minimum: 0, maximum: 1 }]]);
  assert.equal(context.player.controlsAt(0).density, 0);
  assert.equal(context.player.controlsAt(1).density, 16);
  assert.equal(context.player.controlsAt(0).tempo, 60);
  assert.equal(context.player.controlsAt(1).tempo, 180);

  context.catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/hydrasynth_parameters.json")));
  vm.runInContext("HydraParameters.install(catalog)", context);
  state.mappings = [{id: 1, sources: [], targets: [
    {destination: "pitch", minimum: 48, maximum: 72, curve: "linear"},
    {destination: "density", minimum: 0, maximum: 16, curve: "inverse"},
    {destination: "nrpn-08097-mutator1-mode", minimum: 0, maximum: 7, curve: "steps"},
    {destination: "tempo", minimum: 60, maximum: 180, curve: "linear", enabled: false}
  ]}];
  const low = context.player.controlsAt(0), high = context.player.controlsAt(1);
  assert.equal(low.pitch, 48); assert.equal(high.pitch, 72);
  assert.equal(low.density, 16); assert.equal(high.density, 0);
  assert.equal(high.tempo, Number(dom.tempo.value), "disabled destinations cannot override the base controls");
  assert.equal(high.parameters[0].value, 7);
  // A missing source blocks notes and pending parameter updates in live mode.
  state.sourceMode = "live";
  vm.runInContext("state.live = new Live.Stream()", context);
  state.mappings[0].sources = [{sourceKey: "missing|data", reducer: "mean", index: 0}];
  assert.equal(context.player.controlsAt(0).valid, false);
  state.sourceMode = "recording";

  const messages = [];
  state.midiGuard = { assertReady() {}, stop: async () => {} };
  const first = { send(message) { messages.push(["first", ...message]); } };
  const second = { send(message) { messages.push(["second", ...message]); } };
  state.midiOutput = first;
  context.player.playMidiNote(60, 90, 1000);
  state.midiOutput = second;
  context.player.stopActiveMidiNotes();
  assert.deepEqual(messages, [["first", 0x90, 60, 90], ["first", 0x80, 60, 0], ["first", 0xB0, 64, 0], ["first", 0x80, 60, 0]],
    "Stop releases sustain and notes on the original MIDI output");
  assert.equal(timers.size, 0);
  now = 1001;

  state.midiOutput = first;
  state.output = "midi";
  state.mappings = [];
  state.playSeries = new Map();
  state.playing = true;
  dom.ratchet.value = "4";
  dom.tempo.value = "120";
  await context.player.runPlaybackTick();
  assert.equal(state.midiNoteTimers.size, 3, "each hit plays a three-note chord by default");
  assert.equal(state.noteTimers.size, 3, "four repeats include one immediate note and three pending notes");
  const pendingCallbacks = [...timers.values()].map((item) => item.callback);
  const noteOnsBeforeStop = messages.filter((item) => item[1] === 0x90).length;
  context.player.stopPlayback();
  assert.equal(state.noteTimers.size, 0);
  assert.equal(state.midiNoteTimers.size, 0);
  assert.equal(state.playing, false);
  assert.equal(timers.size, 0);
  pendingCallbacks.forEach((callback) => callback());
  assert.equal(messages.filter((item) => item[1] === 0x90).length, noteOnsBeforeStop,
    "even an already-dispatched repeat callback must not play after stop");

  state.playing = true;
  state.midiOutput = { send() { throw new Error("Disconnected output"); } };
  await context.player.runPlaybackTick();
  assert.equal(state.playing, false);
  assert.equal(state.noteTimers.size, 0, "an output failure must not enqueue later chord repeats");
  state.midiOutput = first;

  const advancePatch = async () => {
    const timer = state.patchTimers.keys().next().value;
    const callback = timers.get(timer).callback;
    timers.delete(timer);
    callback();
    await Promise.resolve();
    await Promise.resolve();
  };
  messages.length = 0;
  const changing = context.player.sendMidiPatch({ bank: "H", number: 128 }, state.playbackGeneration);
  assert.deepEqual(messages, [["first", 0xB0, 0, 0]]);
  await advancePatch();
  assert.deepEqual(messages.at(-1), ["first", 0xB0, 32, 7]);
  await advancePatch();
  assert.deepEqual(messages.at(-1), ["first", 0xC0, 127]);
  await advancePatch();
  assert.equal(await changing, true);
  assert.equal(state.currentPatch.bank, "H");
  assert.equal(state.patchTimers.size, 0);
  for (const gaps of [0, 1]) {
    messages.length = 0;
    const canceled = context.player.sendMidiPatch({ bank: "B", number: 17 }, state.playbackGeneration);
    if (gaps) await advancePatch();
    context.player.stopPlayback();
    assert.equal(await canceled, false);
    assert.ok(!messages.some((message) => message[1] === 0xC0), "stop cancels bank changes before program change");
    assert.equal(state.patchTimers.size, 0);
  }
  messages.length = 0;
  dom["patch-bank"].value = "A";
  dom["patch-number"].value = "1";
  state.playing = true;
  state.playbackWorkspace = "synth-legacy";
  const manualGeneration = state.playbackGeneration, manualStep = state.rhythmStep;
  const manual = context.player.selectMidiPatch({ bank: "G", number: 96 }, "synth-mixer");
  assert.equal(state.playing, true, "manual patch selection keeps the synth transport running");
  assert.equal(state.preparing, false);
  assert.equal(state.playbackWorkspace, "synth-legacy", "patch selection preserves the running transport's original controls");
  assert.equal(state.playbackGeneration, manualGeneration);
  await advancePatch(); await advancePatch(); await advancePatch();
  assert.equal(await manual, true);
  assert.deepEqual(messages, [["first", 0xb0, 0, 0], ["first", 0xb0, 32, 6], ["first", 0xc0, 95]],
    "manual selection uses explicit mixer values rather than hidden legacy controls");
  assert.equal(state.preparing, false);
  assert.equal(state.patchTimers.size, 0);
  assert.equal(state.playing, true, "settling the new patch does not stop playback");
  assert.equal(state.rhythmStep, manualStep, "patch selection does not rewind the sequence");
  for (const patch of [{ bank: "I", number: 1 }, { bank: "A", number: 129 }, { bank: "A", number: 1.5 }]) {
    const sent = messages.length;
    await assert.rejects(context.player.selectMidiPatch(patch), /Choose a bank/);
    assert.equal(messages.length, sent, "invalid patch selection cannot send MIDI");
  }
  const canceledManual = context.player.selectMidiPatch({ bank: "A", number: 5 }, "synth-mixer");
  context.player.stopPlayback();
  assert.equal(await canceledManual, false);
  assert.equal(state.playing, false, "Stop during patch loading remains stopped");
  assert.equal(state.preparing, false);
  assert.equal(state.patchTimers.size, 0);
  const idleManual = context.player.selectMidiPatch({ bank: "B", number: 2 }, "synth-mixer");
  assert.equal(state.playbackWorkspace, "synth-mixer", "the mixer's Stop button owns its idle patch selection");
  assert.equal(state.preparing, true);
  await advancePatch(); await advancePatch(); await advancePatch();
  assert.equal(await idleManual, true);
  assert.equal(state.playing, false, "selecting a patch while stopped never starts playback");
  assert.equal(state.preparing, false);
  state.playing = true;
  state.midiOutput = { send() { throw new Error("Patch output disconnected"); } };
  await assert.rejects(context.player.selectMidiPatch({ bank: "B", number: 3 }), /Patch output disconnected/);
  assert.equal(state.playing, false, "a failed MIDI output still stops the affected transport");
  assert.equal(state.patchChanging, false, "failed sends cannot leave patch loading latched");
  assert.equal(state.patchTimers.size, 0);
  state.midiOutput = first;
  dom["sound-mode"].value = "cycle";
  state.rhythmStep = 32;
  const sentBeforeThrottle = messages.length;
  context.player.changeSoundAtBoundary(context.player.controlsAt(0));
  assert.equal(messages.length, sentBeforeThrottle, "rapid phrase boundaries cannot thrash MIDI patches");
  state.output = "audio";
  state.currentPreviewVoice = null;
  context.player.changeSoundAtBoundary(context.player.controlsAt(0));
  assert.equal(state.currentPreviewVoice.id, "glass");
  context.player.changeSoundAtBoundary(context.player.controlsAt(0));
  assert.equal(state.currentPreviewVoice.id, "pluck");
  dom["sound-mode"].value = "off";
  // A delayed recording fetch cannot assign calibration to a newly selected input/session.
  vm.runInContext("globalThis.originalSourceLoader = loadSourceSeries; globalThis.rangeLoads = []; loadSourceSeries = () => new Promise(resolve => rangeLoads.push(resolve));", context);
  const calibratedInput = { sourceKey: "first", reducer: "mean", index: 0, rangeMode: "auto" };
  const lateRange = context.player.loadMappingSourceSeries(calibratedInput);
  calibratedInput.sourceKey = "second";
  context.rangeLoads.shift()({ minimum: 5, maximum: 15 });
  await lateRange;
  assert.equal(context.player.learnedMappingRange(calibratedInput), null, "source changes invalidate pending calibration");
  const changedRecording = context.player.loadMappingSourceSeries(calibratedInput);
  state.selectionGeneration++;
  context.rangeLoads.shift()({ minimum: 20, maximum: 40 });
  await changedRecording;
  assert.equal(context.player.learnedMappingRange(calibratedInput), null, "recording switches invalidate pending calibration");
  const validRange = context.player.loadMappingSourceSeries(calibratedInput);
  context.rangeLoads.shift()({ minimum: 2, maximum: 8 });
  await validRange;
  assert.equal(context.player.learnedMappingRange(calibratedInput).minimum, 2);
  assert.equal(context.player.learnedMappingRange(calibratedInput).maximum, 8);
  context.player.resetMappingSourceRange(calibratedInput);
  assert.equal(context.player.learnedMappingRange(calibratedInput), null);
  const frozenConstant = context.player.usableFixedRange({ minimum: 12, maximum: 12 });
  assert.ok(frozenConstant.maximum > frozenConstant.minimum);
  assert.ok(Math.abs((12 - frozenConstant.minimum) / (frozenConstant.maximum - frozenConstant.minimum) - .5) < 1e-12,
    "freezing a constant signal preserves its midpoint response");
  vm.runInContext("loadSourceSeries = originalSourceLoader", context);
  state.mappings = [{ id: 8, destination: "pitch", sources: [] }];
  vm.runInContext("globalThis.finishLoads = []; ensureAudioEngine = async () => {}; loadSeries = () => new Promise(resolve => finishLoads.push(resolve));", context);
  const starting = context.player.togglePlayback();
  await Promise.resolve();
  assert.equal(state.preparing, true);
  assert.equal(context.finishLoads.length, 1);
  context.player.stopPlayback();
  context.finishLoads.forEach((resolve) => resolve({ points: [[0, 0], [1, 1]], minimum: 0, maximum: 1 }));
  await starting;
  assert.equal(state.playing, false, "a canceled recording fetch must not restart playback when it completes");
  assert.equal(state.preparing, false);
  assert.equal(state.noteTimers.size, 0);
  console.log("sonification player mapping and cancellation tests: ok");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
