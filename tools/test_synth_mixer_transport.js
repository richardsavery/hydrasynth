"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the shared synth scheduler with the new workspace's independent
// controls and live values. No browser audio, MIDI hardware, or network needed.
const timers = new Map(), writes = new Map(), notes = [], effects = [], voiceUpdates = [];
const evaluationOptions = [];
let timerId = 0, resets = 0, stops = 0, readyReason = "", valid = true;
let values = [{ destination: "pitch", value: 72 }, { destination: "velocity", value: 101 },
  { destination: "cutoff", value: 40 }];
const settings = { tempo: 132, stepsPerBeat: 2, previewVoice: "warm", waveType: "sawtooth",
  attack: 35, release: 90, brightness: 42, voices: 1, scaleName: "chromatic", ratchet: 2,
  midiFormat: "nrpn", midiRate: 50, soundMode: "off" };
const element = (value = "") => ({ value, checked: false, hidden: false, disabled: false,
  children: [], classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {},
  parentElement: { classList: { toggle() {} } } });
const context = vm.createContext({
  console, Intl, URLSearchParams, document: { addEventListener() {} },
  window: {
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  },
  localStorage: { getItem() { return null; }, setItem(key, value) { writes.set(key, value); } },
  performance: { now: () => 0 },
  fetch: async () => { throw new Error("Synth mixer transport must not fetch original mappings"); },
  HydraSynthMixer: {
    getControls: () => settings, evaluate: (output, options) => {
      evaluationOptions.push({ output, ...options }); return { values, valid };
    },
    readyReason: () => readyReason, reset: () => { resets++; }, activate() {}, deactivate() {}
  },
  recordNote: (...args) => notes.push(args),
  recordEffects: (cc) => effects.push(new Map(cc)),
  recordStop: () => { stops++; }
});
for (const file of ["drums.js", "sonification.js", "parameters.js", "live.js", "drum-workspace.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard", file), "utf8"), context, { filename: file });
}
context.catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/hydrasynth_parameters.json")));
vm.runInContext(`
  HydraParameters.install(catalog);
  globalThis.api = { state, dom, Music, CONTROL_IDS, DRUM_CONTROL_IDS, controlsAt, readMusicalControls,
    effectivePreviewVoice, togglePlayback, stopPlayback, runPlaybackTick, startParameterPump,
    playbackUnavailableReason, saveSettings, selectSonificationWorkspace, changeSoundAtBoundary, selectMidiPatch };
  ensureAudioEngine = async () => {};
  playAudioNote = (...args) => recordNote(...args);
  updateAudioEffects = cc => recordEffects(cc);
  stopAudioVoices = () => { recordStop(); state.activeVoices.clear(); };
  for (const name of ["renderPlaybackAvailability", "renderRhythm", "renderHarmony", "renderSoundControls",
    "renderOutputMode", "updatePlayhead", "publishSignalLabActivity", "showToast", "updateConnectionSummary"])
    globalThis[name] = () => {};
`, context);
const { api } = context, { state, dom, Music } = api;
for (const [key, id] of Object.entries(api.CONTROL_IDS)) dom[id] = element(String(Music.DEFAULT_CONTROLS[key]));
for (const [key, id] of Object.entries(api.DRUM_CONTROL_IDS)) dom[id] = element(String(context.HydraDrums.DEFAULTS[key]));
for (const id of ["preview-button", "session-state", "apply-patch", "workspace-status", "midi-parameter-status"]) dom[id] = element();
state.workspaceView = "synth-mixer";
state.output = state.synthOutput = "audio";
state.sourceMode = "live";
state.liveSocket = null;
state.recording = null;
state.mappings = [{ id: 11, sources: [{ sourceKey: "missing-original-input" }], targets: [
  { destination: "pitch", minimum: 24, maximum: 24, curve: "linear" }
] }];
state.tabs = [{ id: 1, name: "Original fixture", mappings: state.mappings, controls: Music.controls() }];
state.activeTabId = 1;
const originalMappings = JSON.stringify(state.mappings);
const fire = async (id) => {
  const timer = timers.get(id);
  assert.ok(timer, `Expected timer ${id}`);
  timers.delete(id);
  await timer.callback();
  await Promise.resolve();
};

async function main() {
  const rap = context.HydraSynthRapTransport;
  assert.equal(rap.clock().context, null, "reading the rap clock cannot unlock audio");
  assert.equal(rap.clock().playing, false);
  const idleClock = rap.clock();
  assert.equal(idleClock.bpm, 132);
  api.selectSonificationWorkspace("robot-control", "synth-mixer");
  assert.equal(rap.clock().bpm, idleClock.bpm, "standalone Synth rap keeps its tempo while another workspace is visible");
  assert.equal(rap.clock().token, idleClock.token, "navigation cannot invalidate standalone rap preparation");
  api.selectSonificationWorkspace("synth-mixer", "robot-control");
  assert.equal(api.playbackUnavailableReason(), "", "demo and unmapped playback need no original recording/live socket");
  assert.equal(api.readMusicalControls().tempo, 96, "original controls are isolated from workspace defaults");
  assert.equal(api.controlsAt(0).tempo, 132);
  assert.equal(api.controlsAt(0).pitch, 72, "original mappings are ignored by Synth mixer playback");
  assert.equal(api.effectivePreviewVoice().name, "Warm pad");
  assert.equal(api.effectivePreviewVoice().brightness, 42);
  const originalControls = JSON.stringify(api.readMusicalControls());
  await api.togglePlayback();
  state.audio = { context: { currentTime: 10, destination: {} } };
  const rapStart = rap.clock();
  assert.equal(rapStart.context, state.audio.context);
  assert.equal(rapStart.destination, state.audio.context.destination);
  assert.equal(rapStart.playing, true);
  assert.equal(rapStart.valid, true);
  assert.equal(rapStart.bpm, 132);
  assert.equal(rapStart.beat, 0, "the voice grid starts on the first synth step");
  assert.equal(rapStart.estimated, false);
  assert.equal(state.playing, true);
  assert.equal(resets, 1, "Play resets only the independent signal reader");
  assert.ok(notes.some(([pitch, velocity]) => pitch === 72 && velocity === 101));
  assert.equal(effects.at(-1).get(74), 40);
  assert.equal(writes.size, 0, "playing the new workspace never saves original presets");

  // Continuous transport must not inherit the hidden old workspace's Loop
  // checkbox or end after its empty series reaches the two-step fallback.
  dom.loop.checked = false;
  for (let count = 0; count < 5; count++) await fire(state.playTimer);
  assert.equal(state.playing, true);
  assert.ok(notes.length >= 6);
  assert.equal(rap.clock().beat, 2.5, "two subdivisions advance one quarter-note beat");
  const beforeTempoChange = rap.clock().token;
  const beforeRobotTempoChange = context.HydraBeatClock.snapshot("synth").token;
  settings.tempo = 144;
  await fire(state.playTimer);
  assert.equal(rap.clock().bpm, 144);
  assert.notEqual(rap.clock().token, beforeTempoChange, "mapped or edited tempo changes invalidate a prepared schedule");
  assert.equal(context.HydraBeatClock.snapshot("synth").token, beforeRobotTempoChange, "Synth tempo changes retain the live robot session");
  assert.equal(context.HydraBeatClock.snapshot("synth").bpm, 144);
  settings.tempo = 132;
  await fire(state.playTimer);

  state.activeVoices.add({ updateControls: (cc) => voiceUpdates.push(new Map(cc)) });
  values = [{ destination: "cutoff", value: 95 }, { destination: "reverb", value: 80 }];
  await fire(state.parameterTimer);
  assert.equal(effects.at(-1).get(91), 80, "effects update between notes");
  assert.equal(voiceUpdates.at(-1).get(74), 95, "sustained voices receive realtime filter updates");

  // A stale mapped input cancels queued repeats and silences sustained voices.
  const delayed = timers.get([...state.noteTimers][0])?.callback;
  const noteCount = notes.length, stopsBefore = stops;
  valid = false;
  await fire(state.parameterTimer);
  assert.equal(state.liveSilenced, true);
  assert.equal(rap.clock().valid, false, "stale synth mappings gate the rap clock");
  assert.notEqual(rap.clock().token, rapStart.token, "stale data invalidates queued voice playback");
  assert.ok(stops > stopsBefore);
  assert.equal(state.noteTimers.size, 0);
  delayed?.();
  assert.equal(notes.length, noteCount, "an already-dispatched repeat cannot revive stale input");
  valid = true;
  await fire(state.playTimer);
  assert.equal(state.liveSilenced, false);
  assert.ok(notes.length > noteCount, "fresh inputs resume notes");
  api.stopPlayback();
  assert.equal(rap.clock().playing, false);
  assert.equal(timers.size, 0);
  assert.equal(state.playing, false);

  // Catalog destinations retain the existing encoder, and the continuous MIDI
  // pump reads current buses even with Connections set to recording mode.
  state.sourceMode = "recording";
  state.synthOutput = state.output = "midi";
  assert.match(api.playbackUnavailableReason(), /Connect a MIDI device/);
  await api.togglePlayback();
  assert.equal(state.playing, false);
  assert.match(state.playbackError, /MIDI device/);
  const midi = [];
  state.midiOutput = { send: (bytes) => midi.push([...bytes]) };
  Object.assign(settings, { soundMode: "mapped", soundEvery: 32, patchPool: "shortlist", patchList: "A001, H128" });
  values = [{ destination: "sound", value: 100 }];
  state.rhythmStep = 0;
  const mappedPatch = api.changeSoundAtBoundary(api.controlsAt(0));
  while (state.patchTimers.size) await fire(state.patchTimers.keys().next().value);
  assert.equal(await mappedPatch, true);
  assert.deepEqual(midi, [[0xb0, 0, 0], [0xb0, 32, 7], [0xc0, 127]],
    "a mapped sound value selects the matching location from the Synth mixer's own palette");
  settings.soundMode = "off";
  midi.length = 0;
  values = [{ destination: "nrpn-08097-mutator1-mode", value: 7 }];
  assert.equal(api.controlsAt(0).parameters[0].value, 7);
  await api.togglePlayback();
  await fire(state.parameterTimer);
  assert.ok(midi.some((bytes) => bytes[0] === 0xb0 && bytes[1] === 99), "parameter pump emits encoded NRPN");
  values = [{ destination: "nrpn-08097-mutator1-mode", value: 1 }];
  await fire(state.parameterTimer);
  assert.equal(state.midiPacer.sent.values().next().value, 1, "recording-mode buses update MIDI between rhythm steps");

  // Manual patch changes mute only MIDI while the existing transport and rap
  // beat grid keep advancing. Neither fresh Play nor source resets are needed.
  const beforeManual = { generation: state.playbackGeneration, owner: state.playbackWorkspace,
    resets, token: rap.clock().token, step: state.rhythmStep, cursor: state.cursor };
  const oldRepeat = timers.get([...state.noteTimers][0])?.callback;
  const manualStart = midi.length;
  const manualPatch = api.selectMidiPatch({ bank: "D", number: 42 }, "synth-mixer");
  assert.equal(state.playing, true);
  assert.equal(state.preparing, false, "a playing transport is not converted into a new preparation");
  assert.equal(state.playbackGeneration, beforeManual.generation);
  assert.equal(state.playbackWorkspace, beforeManual.owner);
  assert.equal(state.rhythmStep, beforeManual.step);
  assert.equal(state.cursor, beforeManual.cursor);
  assert.equal(resets, beforeManual.resets);
  assert.equal(rap.clock().token, beforeManual.token);
  assert.equal(state.patchChanging, true);
  const messagesAfterBankStart = midi.length;
  await assert.rejects(api.selectMidiPatch({ bank: "G", number: 9 }, "synth-mixer"), /patch|change|wait/i);
  assert.equal(midi.length, messagesAfterBankStart, "a second patch cannot interleave its bank bytes");
  assert.equal(state.playing, true, "rejecting overlap cannot stop the first patch's playing transport");
  assert.equal(api.changeSoundAtBoundary({ ...api.controlsAt(0), soundMode: "cycle", soundEvery: 1 }), null,
    "automatic sound selection waits while a manual patch is in flight");
  const noteCountBeforePatch = midi.filter(bytes => bytes[0] === 0x90).length;
  values = [{ destination: "nrpn-08097-mutator1-mode", value: 2 }];
  for (const gap of [20, 20, 100]) {
    const patchTimer = state.patchTimers.keys().next().value;
    assert.equal(timers.get(patchTimer).delay, gap);
    const messagesBeforeMutedTick = midi.length;
    oldRepeat?.();
    await fire(state.playTimer);
    await fire(state.parameterTimer);
    assert.equal(midi.length, messagesBeforeMutedTick, "scheduled notes and parameter updates stay silent during every patch gap");
    assert.equal(rap.clock().token, beforeManual.token, "the live rap backing token survives each muted beat");
    await fire(patchTimer);
  }
  assert.equal(await manualPatch, true);
  assert.equal(state.patchChanging, false);
  assert.equal(state.playing, true);
  assert.equal(state.playbackWorkspace, beforeManual.owner);
  assert.equal(state.playbackGeneration, beforeManual.generation);
  assert.equal(resets, beforeManual.resets);
  assert.ok(state.rhythmStep > beforeManual.step, "the rhythm advances through the synth's patch cutout");
  assert.equal(rap.clock().token, beforeManual.token);
  const patchBytes = midi.slice(manualStart).filter(bytes => bytes[0] === 0xc0 || bytes[0] === 0xb0 && [0, 32].includes(bytes[1]));
  assert.deepEqual(patchBytes, [[0xb0, 0, 0], [0xb0, 32, 3], [0xc0, 41]]);
  assert.equal(midi.filter(bytes => bytes[0] === 0x90).length, noteCountBeforePatch);
  oldRepeat?.();
  assert.equal(midi.filter(bytes => bytes[0] === 0x90).length, noteCountBeforePatch,
    "a dispatched repeat from before patch selection cannot sound after the new patch is ready");
  await fire(state.parameterTimer);
  assert.equal(state.midiPacer.sent.values().next().value, 2, "current mapped parameters are reapplied to the newly selected sound");
  await fire(state.playTimer);
  assert.ok(midi.filter(bytes => bytes[0] === 0x90).length > noteCountBeforePatch,
    "the next scheduled tick resumes notes without another Play action");
  assert.equal(resets, beforeManual.resets);

  const stoppedPatch = api.selectMidiPatch({ bank: "F", number: 12 }, "synth-mixer");
  const pendingAfterPatch = [...timers.values()].map(timer => timer.callback);
  api.stopPlayback();
  const messagesAfterStop = midi.length;
  assert.equal(await stoppedPatch, false);
  for (const callback of pendingAfterPatch) await callback();
  assert.equal(state.playing, false, "Stop during a patch cannot trigger automatic resurrection");
  assert.equal(state.preparing, false);
  assert.equal(state.patchChanging, false);
  assert.equal(state.patchTimers.size, 0);
  assert.equal(timers.size, 0);
  assert.equal(midi.length, messagesAfterStop, "cancelled patch, rhythm and repeat callbacks cannot send more MIDI");
  values = [{ destination: "nrpn-08097-mutator1-mode", value: 1 }];
  await api.togglePlayback();
  await fire(state.parameterTimer);

  dom["midi-format"].value = "cc";
  dom["midi-rate"].value = "25";
  assert.equal(api.controlsAt(0).parameters.length, 0, "Connections CC mode disables NRPN commands immediately");
  assert.equal(api.controlsAt(0).midiRate, 25, "Connections controls the shared MIDI pacing rate");
  assert.equal(evaluationOptions.at(-1).midiFormat, "cc", "mapping availability uses the same live format as command encoding");
  assert.equal(settings.midiFormat, "nrpn", "connection settings do not rewrite the workspace's saved sound configuration");
  values = [{ destination: "cutoff", value: 64 }];
  const midiBeforeRateChange = midi.length;
  await fire(state.parameterTimer);
  assert.equal(midi.length, midiBeforeRateChange, "25 changes/sec emits every other 20 ms pump");
  await fire(state.parameterTimer);
  assert.deepEqual(midi.at(-1), [0xb0, 74, 64], "CC connection mode emits CC without NRPN conversion");
  dom["midi-format"].value = "nrpn";
  dom["midi-rate"].value = "50";
  values = [{ destination: "cc-064-sustain-pedal", value: 127 }];
  // Use the catalog's actual ID so sustain cleanup is checked alongside encoding.
  values[0].destination = context.HydraParameters.entries.find((entry) => entry.kind === "cc" && entry.number === 64).id;
  await fire(state.parameterTimer);
  assert.deepEqual(midi.at(-1), [0xb0, 64, 127], "sustain remains a system CC in NRPN mode");
  assert.equal(state.midiSustainOutputs.size, 1);
  const beforeStale = midi.length;
  valid = false;
  await fire(state.parameterTimer);
  assert.deepEqual(midi[beforeStale], [0xb0, 64, 0], "stale inputs release sustain before stopping notes");
  assert.equal(state.midiSustainOutputs.size, 0);
  assert.equal(state.midiPacer.pending.size, 0, "stale buses clear queued parameter changes");
  assert.equal(state.midiNoteTimers.size, 0, "stale buses release MIDI notes");
  api.stopPlayback();
  valid = true;
  state.output = state.synthOutput = "audio";
  values = [{ destination: "nrpn-08097-mutator1-mode", value: 1 }];
  assert.equal(api.controlsAt(0).parameters.length, 0, "hardware-only mappings never masquerade as browser effects");

  // Navigation preserves pending setup and the original controls; the running
  // synth and its beat clock continue while robot control is on screen.
  vm.runInContext("ensureAudioEngine = () => new Promise(resolve => { globalThis.finishAudio = resolve; });", context);
  const starting = api.togglePlayback();
  assert.equal(state.preparing, true);
  api.selectSonificationWorkspace("synth-legacy", "synth-mixer");
  assert.equal(api.controlsAt(0).tempo, 132, "pending setup retains Synth mixer controls in the other Synth view");
  api.selectSonificationWorkspace("connections", "synth-legacy");
  assert.equal(state.preparing, true);
  context.finishAudio();
  await starting;
  assert.equal(state.preparing, false);
  assert.equal(state.playing, true);
  assert.equal(state.playbackWorkspace, "synth-mixer");
  assert.equal(rap.clock().playing, true);
  const starts = resets, notesBeforeNavigation = notes.length, timerBeforeNavigation = state.playTimer;
  api.selectSonificationWorkspace("robot-control", "connections");
  assert.equal(state.playTimer, timerBeforeNavigation);
  for (let count = 0; count < 4; count++) await fire(state.playTimer);
  assert.equal(state.playing, true, "hidden Synth mixer still loops with the old Loop checkbox off");
  assert.ok(notes.length > notesBeforeNavigation, "the actual synth scheduler keeps emitting notes after navigation");
  assert.equal(api.controlsAt(0).tempo, 132);
  assert.equal(context.HydraBeatClock.snapshot("synth").running, true);
  api.selectSonificationWorkspace("synth-mixer", "robot-control");
  assert.equal(resets, starts, "returning to the workspace cannot restart its signal reader");
  api.selectSonificationWorkspace("synth-legacy", "synth-mixer");
  await fire(state.playTimer);
  assert.equal(state.playing, true);
  assert.equal(api.controlsAt(0).tempo, 132, "the other Synth view cannot change active transport controls");
  assert.equal(rap.clock().playing, true);
  api.selectSonificationWorkspace("synth-mixer", "synth-legacy");
  api.stopPlayback();
  assert.equal(timers.size, 0);
  const restarted = api.togglePlayback();
  context.finishAudio(); await restarted;
  assert.equal(state.playing, true);
  assert.equal(rap.clock().beat, 0, "explicit Stop followed by Play resets the beat grid");
  assert.equal(resets, starts + 1);
  api.stopPlayback();
  const canceled = api.togglePlayback();
  assert.equal(state.preparing, true);
  api.selectSonificationWorkspace("connections", "synth-mixer");
  api.stopPlayback();
  context.finishAudio();
  await canceled;
  assert.equal(state.playing, false, "explicit Stop still cancels pending audio setup from any workspace");
  assert.equal(state.preparing, false);
  assert.equal(timers.size, 0);
  assert.equal(JSON.stringify(state.mappings), originalMappings);
  assert.equal(JSON.stringify(api.readMusicalControls()), originalControls);
  api.saveSettings();
  assert.equal(state.tabs[0].controls.tempo, 96, "saving connections retains original Synth controls");
  assert.equal(state.saved.controls.previewVoice, "custom");
  let musicClock = { playing: true, valid: true, bpm: 120, beat: 4, token: "rate-1", transportToken: "track-1" };
  context.HydraMusicMixer = { transportClock: () => musicClock };
  const musicRobotClock = context.HydraBeatClock.snapshot("mixer");
  musicClock = { ...musicClock, bpm: 160, beat: 4.1, token: "rate-2", rateChanging: true };
  const changingRobotClock = context.HydraBeatClock.snapshot("mixer");
  assert.equal(changingRobotClock.token, musicRobotClock.token, "the shared robot clock uses transport continuity instead of the rendered-voice tempo token");
  assert.equal(changingRobotClock.running, true);
  assert.equal(changingRobotClock.bpm, 160);
  assert.equal(changingRobotClock.rateChanging, true);
  musicClock = { ...musicClock, transportToken: "track-2" };
  assert.notEqual(context.HydraBeatClock.snapshot("mixer").token, musicRobotClock.token, "new tracks still invalidate robot timing");
  musicClock = { ...musicClock, detected: true, context: { currentTime: 10 },
    beatContacts: [{ key: "deck:0:2:0", beat: 2, at: 10.825 }] };
  const detectedRobotClock = context.HydraBeatClock.snapshot("mixer");
  assert.equal(detectedRobotClock.detected, true);
  assert.equal(detectedRobotClock.beatContacts[0].at, detectedRobotClock.at + 825,
    "detected audio-clock contact times become performance-clock milliseconds at the bridge");
  assert.equal(detectedRobotClock.beatContacts[0].key, "deck:0:2:0");
  musicClock = { ...musicClock, valid: false, beatTrackingError: "Detected beats are unavailable.", beatContacts: [] };
  assert.equal(context.HydraBeatClock.snapshot("mixer").running, false);
  assert.equal(context.HydraBeatClock.snapshot("mixer").beatTrackingError, "Detected beats are unavailable.");
  console.log("synth mixer transport: isolated presets, persistent playback across tabs, realtime audio/MIDI, stale-input gating and explicit cancellation passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
