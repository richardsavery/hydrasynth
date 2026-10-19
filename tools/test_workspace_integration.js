"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise application state and transport boundaries without requiring a MIDI
// device, audio device, browser permissions, or paid generation requests.
class TestElement {
  constructor(value = "") {
    Object.assign(this, { value, checked: false, hidden: false, disabled: false,
      textContent: "", innerHTML: "", children: [], dataset: {}, attributes: new Map(),
      selectedIndex: 0, selectedOptions: [{ textContent: "Minor pentatonic" }],
      classList: { add() {}, remove() {}, toggle() {} }, parentElement: null });
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener() {}
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  add(child) { this.children.push(child); }
  querySelectorAll() { return []; }
  closest() { return this.editable ? this : null; }
}

const elements = new Map(), timers = new Map(), writes = new Map();
const bodyClasses = new Set();
const generatedLifecycle = [];
const mixerLifecycle = [], musicLifecycle = [], sourceBridges = [], synthMixerLifecycle = [];
const experimentLifecycle = [];
const responseLifecycle = [];
const robotLifecycle = [], robotLiveLifecycle = [], drumLifecycle = [], drumNotes = [];
let generatedOptions, mixerOptions, synthMixerOptions, robotOptions, robotLiveOptions, responseOptions;
let mixerClock = null, now = 0;
let nextTimer = 0;
const getElement = (id) => {
  if (!elements.has(id)) elements.set(id, new TestElement());
  return elements.get(id);
};
getElement("observer-overlay").hidden = true;
const context = vm.createContext({
  console, Intl, URL, URLSearchParams, Element: TestElement,
  Option: class extends TestElement { constructor(label, value) { super(value); this.textContent = label; } },
  document: {
    addEventListener() {}, getElementById: getElement, querySelectorAll() { return []; },
    querySelector() { return null; }, createElement() { return new TestElement(); },
    body: { classList: {
      add(name) { bodyClasses.add(name); }, remove(name) { bodyClasses.delete(name); },
      contains(name) { return bodyClasses.has(name); },
      toggle(name, value) { if (value) bodyClasses.add(name); else bodyClasses.delete(name); }
    }, dataset: {} }
  },
  window: {
    location: { hash: "#connections", protocol: "http:", origin: "http://localhost" },
    addEventListener() {},
    setTimeout(fn, delay) { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }
  },
  localStorage: { getItem() { return null; }, setItem(key, value) { writes.set(key, value); } },
  performance: { now: () => now },
  navigator: {},
  fetch: async () => { throw new Error("This regression test must not make network requests"); },
  HydraElevenSource: { create(options) {
    const bridge = { describe: () => ({ mode: options.getState().sourceMode, fields: options.getState().fields }),
      prepare() {}, read() {}, reset() {}, bounds() {}, resetRange() {} };
    sourceBridges.push({ options, bridge });
    return bridge;
  } },
  HydraElevenLabs: {
    init(options) { generatedOptions = options; },
    activate() { generatedLifecycle.push("activate"); musicLifecycle.push("generated:activate"); },
    deactivate() { generatedLifecycle.push("deactivate"); musicLifecycle.push("generated:deactivate"); }, stop() {}
  },
  HydraMusicMixer: {
    init(options) { mixerOptions = options; },
    activate() { mixerLifecycle.push("activate"); musicLifecycle.push("mixer:activate"); },
    deactivate() { mixerLifecycle.push("deactivate"); musicLifecycle.push("mixer:deactivate"); },
    transportClock() { return mixerClock; }
  },
  HydraRapExperiment: {
    init() {},
    activate() { experimentLifecycle.push("activate"); },
    deactivate() { experimentLifecycle.push("deactivate"); }
  },
  HydraRapResponse: {
    init(options) { responseOptions = options; },
    activate() { responseLifecycle.push("activate"); },
    deactivate() { responseLifecycle.push("deactivate"); }
  },
  HydraRobotControl: {
    init(options) { robotOptions = options; },
    activate() { robotLifecycle.push("activate"); },
    deactivate() { robotLifecycle.push("deactivate"); }
  },
  HydraRobotDrums: { stop() { drumLifecycle.push("stop"); return Promise.resolve(); }, recordNote(note) { drumNotes.push(note); } },
  HydraRobotLive: {
    init(options) { robotLiveOptions = options; },
    activate() { robotLiveLifecycle.push("activate"); },
    stop() { robotLiveLifecycle.push("stop"); }
  },
  HydraSynthMixer: {
    init(options) { synthMixerOptions = options; },
    activate() { synthMixerLifecycle.push("activate"); },
    deactivate() { synthMixerLifecycle.push("deactivate"); },
    getControls() { return { tempo: 155 }; }, readyReason() { return ""; },
    evaluate() { return { values: [], valid: true }; }, reset() {}
  }
});
context.window.history = {
  replaceState(_state, _title, hash) { context.window.location.hash = hash; },
  pushState(_state, _title, hash) { context.window.location.hash = hash; }
};
context.window.localStorage = context.localStorage;
for (const file of ["drums.js", "sonification.js", "parameters.js", "live.js", "drum-workspace.js", "workspace-shell.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard", file), "utf8"), context, { filename: file });
}
vm.runInContext(`
  globalThis.api = {state, dom, Music, CONTROL_IDS, DRUM_CONTROL_IDS,
    applyMusicalControls, applySavedControls, activateTab, selectSonificationWorkspace, selectConnectionOutput,
    setOutput, connectMidi, renderMidiOutputs, updateMidiStatus,
    handlePlaybackShortcut, togglePlayback, stopPlayback, stopSessionPlayback, saveSettings, renderOutputMode,
    bindSonificationWorkspaces, readPlaybackControls, synthRapClock, rememberSynthBeat, scheduleNextTick, actualPlaybackTick: runPlaybackTick};
  globalThis.effects = {loads: 0, stops: 0, messages: []};
  renderOutputMode = () => {};
  updateControlReadouts = () => {};
  renderSoundControls = () => {};
  renderScale = () => {};
  renderRhythm = () => {};
  renderWorkspaces = () => {};
  renderMappings = () => {};
  renderPlaybackAvailability = () => {};
  renderDrumReadout = () => {};
  applyDrumControls = () => {};
  loadFocusedSeries = async () => { effects.loads++; };
  updatePlayhead = () => {};
  stopAudioVoices = () => { effects.stops++; };
  publishSignalLabActivity = () => {};
  showToast = message => effects.messages.push(message);
`, context);
const { api } = context;
const { state, dom, Music } = api;
for (const [key, id] of Object.entries(api.CONTROL_IDS)) {
  dom[id] = getElement(id);
  dom[id].value = String(Music.DEFAULT_CONTROLS[key]);
}
for (const [key, id] of Object.entries(api.DRUM_CONTROL_IDS)) {
  dom[id] = getElement(id);
  dom[id].value = String(context.HydraDrums.DEFAULTS[key]);
}
for (const id of ["preview-button", "session-state", "wave-progress", "waveform", "playhead",
  "midi-output", "midi-panel", "panic-button", "connect-midi", "midi-status", "midi-choice-detail",
  "apply-patch", "workspace-status", "connection-input-summary", "connection-output-summary"])
  dom[id] = getElement(id);
dom.outputButtons = [];
state.recording = { id: "fixture", name: "Test recording", frames: 12, channels: [] };
state.fields = [{ key: "movement", name: "Movement", reducers: ["value"] }];
state.mappings = [{ id: 1, sources: [{ sourceKey: "movement", reducer: "value" }], targets: [{ destination: "pitch" }] }];
state.tabs = [{ id: 1, name: "Fixture", mappings: state.mappings, controls: Music.controls() }];
state.activeTabId = 1;

const shortcut = (code, target = new TestElement()) => ({ code,
  key: code === "Space" ? " " : code, target, repeat: false,
  prevented: false, preventDefault() { this.prevented = true; } });

async function main() {
  state.saved.controls = { output: "drums" };
  state.saved.connections = { synthOutput: "midi" };
  api.applySavedControls();
  api.renderOutputMode();
  assert.equal(dom["connect-midi"].hidden, true, "legacy drums restore exercises the old visibility before the shell initializes");
  api.bindSonificationWorkspaces();
  assert.equal(sourceBridges.length, 3);
  assert.equal(generatedOptions.sourceBridge, sourceBridges[0].bridge);
  assert.notEqual(mixerOptions.sourceBridge, generatedOptions.sourceBridge,
    "the mixer must keep its playback timing and preparation independent from Generated music");
  assert.equal(mixerOptions.sourceBridge.prepare, sourceBridges[1].bridge.prepare);
  assert.equal(mixerOptions.container, getElement("music-mixer-workspace"));
  assert.equal(responseOptions.container, getElement("rap-response-workspace"));
  assert.equal(robotOptions.container, getElement("robot-setup-workspace"));
  assert.equal(robotLiveOptions.container, getElement("robot-control-workspace"));
  assert.equal(robotLiveOptions.hardware, context.HydraRobotControl);
  assert.equal(robotLiveOptions.clock("synth").running, false);
  assert.equal(sourceBridges[0].options.getState(), sourceBridges[1].options.getState(),
    "both engines share the chosen Connections input");
  assert.equal(sourceBridges[0].options.loadSeries, sourceBridges[1].options.loadSeries);
  assert.equal(synthMixerOptions.container, getElement("synth-mixer-workspace"));
  assert.equal(synthMixerOptions.sourceBridge.prepare, sourceBridges[2].bridge.prepare);
  assert.notEqual(synthMixerOptions.sourceBridge, mixerOptions.sourceBridge,
    "Synth mixer has independent replay timing and calibration");
  assert.equal(sourceBridges[2].options.getState(), state);
  const inputRevision = mixerOptions.sourceBridge.describe().revision;
  state.liveGeneration++;
  assert.notEqual(mixerOptions.sourceBridge.describe().revision, inputRevision,
    "the mixer detects a replaced input before accepting stale samples");
  assert.equal(generatedOptions.sourceBridge.describe().revision, undefined,
    "the new revision wrapper cannot modify the original Generated music bridge");
  api.renderOutputMode();
  assert.equal(state.synthOutput, "midi", "shared connection preference takes precedence over legacy saved engine");
  assert.equal(state.output, "midi");
  assert.equal(dom["connect-midi"].hidden, false, "the shared Connections view restores its MIDI connect button");
  assert.equal(dom["midi-panel"].hidden, false, "the shared MIDI route exposes its device picker after a legacy drums restore");

  state.workspaceView = "synth-legacy";
  state.synthOutput = "midi";
  state.output = "midi";

  // Recording and preset snapshots include legacy output modes. Restoring their
  // sound settings cannot change the global connection or selected workspace.
  for (const savedOutput of ["audio", "drums", "midi"]) {
    api.applyMusicalControls({ output: savedOutput, tempo: 137 });
    assert.equal(state.workspaceView, "synth-legacy");
    assert.equal(state.synthOutput, "midi");
    assert.equal(state.output, "midi", `restoring ${savedOutput} cannot reroute Synth`);
    assert.equal(dom.tempo.value, "137", "sound settings still restore");
  }
  state.tabs.push({ id: 2, name: "Legacy drum preset", mappings: [], controls: Music.controls({ output: "drums", tempo: 112 }) });
  api.activateTab(2);
  assert.equal(state.workspaceView, "synth-legacy");
  assert.equal(state.output, "midi", "opening a legacy preset cannot select a different sonification");

  api.selectSonificationWorkspace("drums", "synth-legacy");
  assert.equal(state.output, "drums");
  assert.equal(state.synthOutput, "midi");
  assert.equal(getElement("connection-output-label").textContent, "Browser audio");
  assert.equal(getElement("connection-output-light").className, "status-light is-ready",
    "browser drums remain ready even when the remembered Synth MIDI device is unavailable");
  api.applyMusicalControls({ output: "audio" });
  assert.equal(state.output, "drums", "restoring a recording must not switch away from Drums");
  api.selectConnectionOutput("audio");
  assert.equal(state.workspaceView, "drums");
  assert.equal(state.output, "drums", "changing Synth routing must not replace the active drum engine");
  assert.equal(state.synthOutput, "audio");
  // Avoid requesting permissions while checking the route's persistence.
  state.midiAccess = { outputs: new Map() };
  api.selectConnectionOutput("midi");
  api.selectSonificationWorkspace("synth-legacy", "drums");
  assert.equal(state.output, "midi");
  assert.equal(state.synthOutput, "midi");
  assert.ok([...writes.values()].some(value => JSON.parse(value).connections?.synthOutput === "midi"),
    "the connection preference is persisted independently of the preset's controls");

  // A permission prompt may resolve after the user navigates elsewhere. That
  // result only updates available devices; it cannot switch engines or routes.
  let resolveMidi;
  context.navigator.requestMIDIAccess = () => new Promise(resolve => { resolveMidi = resolve; });
  state.midiAccess = null;
  state.synthOutput = "audio";
  state.output = "audio";
  const connecting = api.connectMidi();
  api.selectSonificationWorkspace("drums", "synth-legacy");
  const midi = { id: "hydra", name: "Hydrasynth", send() {} };
  resolveMidi({ outputs: new Map([[midi.id, midi]]) });
  await connecting;
  assert.equal(state.workspaceView, "drums");
  assert.equal(state.output, "drums");
  assert.equal(state.synthOutput, "audio");

  state.playing = true;
  state.midiAccess.outputs.clear();
  api.renderMidiOutputs();
  assert.equal(state.playing, true, "unplugging an unused MIDI device cannot stop browser drums");
  state.midiAccess.outputs.set(midi.id, midi);
  api.renderMidiOutputs();

  api.stopPlayback();
  api.selectSonificationWorkspace("synth-legacy", "drums");
  state.playing = true;
  state.midiAccess.outputs.clear();
  api.renderMidiOutputs();
  assert.equal(state.playing, true, "unplugging an unused MIDI device cannot stop browser Synth");
  assert.equal(state.output, "audio");
  state.midiAccess.outputs.set(midi.id, midi);
  api.renderMidiOutputs();

  // Disconnecting a selected MIDI destination cancels its transport without
  // silently switching the user's intended output to browser audio.
  api.selectConnectionOutput("midi");
  api.selectSonificationWorkspace("synth-legacy", "drums");
  state.playing = true;
  state.midiAccess.outputs.clear();
  api.renderMidiOutputs();
  assert.equal(state.playing, false);
  assert.equal(state.midiOutput, null);
  assert.equal(state.output, "midi");
  assert.equal(state.synthOutput, "midi");

  // Hidden controls cannot start a transport, either directly or via Space.
  const preferencesBeforeMusicNavigation = JSON.stringify(state.saved);
  const writesBeforeMusicNavigation = JSON.stringify([...writes]);
  for (const view of ["connections", "elevenlabs", "mixer"]) {
    api.selectSonificationWorkspace(view, state.workspaceView);
    const event = shortcut("Space");
    api.handlePlaybackShortcut(event);
    await api.togglePlayback();
    assert.equal(state.playing, false, `${view} cannot play hidden Synth`);
    assert.equal(state.preparing, false, `${view} cannot prepare hidden Synth`);
    assert.equal(event.prevented, false, `${view} retains the browser's Space behavior`);
  }
  assert.equal(state.output, "audio", "Mixer demo plays through browser audio");
  assert.equal(state.synthOutput, "midi", "Mixer demo preserves the remembered Synth output");
  api.applyMusicalControls({ output: "midi" });
  assert.equal(state.output, "audio", "restoring a recording cannot reroute the mixer to MIDI");
  assert.equal(getElement("connection-output-label").textContent, "Browser audio");
  assert.equal(getElement("connection-output-light").className, "status-light is-ready");
  api.selectSonificationWorkspace("connections", "mixer");
  assert.deepEqual(generatedLifecycle, ["activate"], "Generated music remains active when hidden");
  assert.deepEqual(mixerLifecycle, ["activate"], "Music mixer remains active when hidden");
  assert.deepEqual(musicLifecycle, ["generated:activate", "mixer:activate"],
    "switching views leaves each independent music engine running");
  assert.equal(JSON.stringify(state.saved), preferencesBeforeMusicNavigation,
    "trying the Mixer demo cannot modify saved sonification settings");
  assert.equal(JSON.stringify([...writes]), writesBeforeMusicNavigation,
    "switching music views cannot rewrite the original preferences");
  api.selectSonificationWorkspace("mixer", "connections");
  api.selectSonificationWorkspace("elevenlabs", "mixer");
  assert.deepEqual(musicLifecycle.slice(-2), ["mixer:activate", "generated:activate"],
    "returning to Generated music does not stop the demo transport");
  api.selectSonificationWorkspace("connections", "elevenlabs");

  const savedBeforeSynthMixer = JSON.stringify(state.saved);
  const originalTempo = dom.tempo.value;
  api.selectSonificationWorkspace("synth-mixer", "connections");
  assert.equal(state.output, "midi", "Synth mixer uses the shared Connections route");
  assert.match(synthMixerOptions.transport.status().readyReason, /MIDI device/);
  assert.equal(synthMixerOptions.transport.status().midiFormat, dom["midi-format"].value);
  assert.equal(synthMixerOptions.transport.status().midiRate, Number(dom["midi-rate"].value));
  assert.equal(synthMixerOptions.getDestinations(), Music.DESTINATIONS);
  assert.equal(dom.tempo.value, originalTempo, "Synth mixer cannot replace hidden original controls");
  api.selectSonificationWorkspace("connections", "synth-mixer");
  assert.deepEqual(synthMixerLifecycle, ["activate"]);
  assert.equal(JSON.stringify(state.saved), savedBeforeSynthMixer, "Synth mixer navigation preserves original presets");

  api.selectSonificationWorkspace("rap-experiment", "connections");
  assert.equal(state.output, "audio", "Rap comparisons use browser audio without changing MIDI preferences");
  assert.equal(state.synthOutput, "midi");
  api.selectSonificationWorkspace("connections", "rap-experiment");
  assert.deepEqual(experimentLifecycle, ["activate"], "Rap comparisons continue when their workspace is hidden");

  api.selectSonificationWorkspace("rap-response", "connections");
  assert.equal(state.output, "audio", "Rap replies use browser audio while preserving the chosen MIDI route");
  assert.equal(state.synthOutput, "midi");
  const rapSpace = shortcut("Space");
  api.handlePlaybackShortcut(rapSpace);
  await api.togglePlayback();
  assert.equal(state.playing, false, "Rap response cannot accidentally start hidden Synth controls");
  assert.equal(rapSpace.prevented, false);
  api.selectSonificationWorkspace("connections", "rap-response");
  assert.deepEqual(responseLifecycle, ["activate", "deactivate"], "leaving Rap response releases microphone capture and suppresses late automatic replies");
  assert.deepEqual(experimentLifecycle, ["activate"], "leaving Rap response does not stop unrelated background engines");

  api.selectSonificationWorkspace("robot-setup", "connections");
  assert.equal(state.workspaceView, "robot-setup");
  api.selectSonificationWorkspace("robot-control", "robot-setup");
  assert.equal(state.workspaceView, "robot-control");
  assert.equal(state.playing, false);
  api.selectSonificationWorkspace("connections", "robot-control");
  assert.deepEqual(robotLifecycle, ["activate", "activate"], "Setup and live control share a connection that survives navigation");
  assert.deepEqual(robotLiveLifecycle, ["activate"], "Robot performance stays active after leaving the tab");

  // Leaving while audio setup is pending preserves the requested playback.
  api.selectConnectionOutput("audio");
  api.selectSonificationWorkspace("synth-legacy", "connections");
  state.mappings = [{ id: 1, sources: [{ sourceKey: "movement", reducer: "value" }], targets: [{ destination: "pitch" }] }];
  vm.runInContext(`ensureAudioEngine = () => new Promise(resolve => {globalThis.finishAudio = resolve;});
    loadMappingSet = async () => [];
    startParameterPump = () => {};
    runPlaybackTick = () => { globalThis.playedTempo = readPlaybackControls().tempo; };`, context);
  const starting = api.togglePlayback();
  assert.equal(state.preparing, true);
  api.selectSonificationWorkspace("mixer", "synth-legacy");
  assert.equal(state.preparing, true);
  assert.equal(state.playbackWorkspace, "synth-legacy");
  context.finishAudio();
  await starting;
  assert.equal(state.preparing, false);
  assert.equal(state.playing, true, "the requested setup completes while another workspace is visible");
  assert.equal(context.playedTempo, Number(dom.tempo.value));
  api.selectSonificationWorkspace("synth-mixer", "mixer");
  assert.equal(api.readPlaybackControls().tempo, Number(dom.tempo.value),
    "playing legacy Synth retains its controls when the Synth mixer becomes visible");
  assert.equal(state.playing, true);
  api.selectSonificationWorkspace("mixer", "synth-mixer");
  api.selectConnectionOutput("midi");
  assert.equal(state.playing, false, "an explicit output change still stops the previous destination");
  assert.equal(state.workspaceView, "mixer");
  assert.equal(state.output, "audio", "changing the shared Synth output cannot reroute Mixer demo");
  api.selectSonificationWorkspace("synth-legacy", "mixer");
  assert.equal(state.output, "midi", "returning to Synth restores its selected destination");

  // A running Synth mixer keeps its controls and MIDI destination across every
  // visible workspace; navigating back cannot reset its beat or schedule.
  api.selectSonificationWorkspace("synth-mixer", "synth-legacy");
  state.playing = true; state.playbackWorkspace = "synth-mixer";
  state.rhythmStep = 8; now = 1000;
  api.rememberSynthBeat({ tempo: 120, stepsPerBeat: 2, swing: 0 });
  const generation = state.playbackGeneration, selection = state.selectionGeneration;
  const stopCount = context.effects.stops;
  api.scheduleNextTick(250);
  const scheduled = state.playTimer;
  for (const view of ["mixer", "robot-control", "robot-setup", "connections", "rap-experiment", "rap-response", "synth-legacy", "synth-mixer"]) {
    api.selectSonificationWorkspace(view, state.workspaceView);
    assert.equal(state.playing, true);
    assert.equal(state.output, "midi");
    assert.equal(state.playbackWorkspace, "synth-mixer");
    assert.equal(api.readPlaybackControls().tempo, 155, "the playing Synth retains its own controls");
    assert.equal(synthMixerOptions.transport.status().playing, true);
    assert.equal(api.synthRapClock().playing, true);
    assert.equal(state.playbackGeneration, generation);
    assert.equal(state.selectionGeneration, selection, "navigation cannot reset shared source replay");
    assert.equal(state.playTimer, scheduled);
    assert.equal(context.effects.stops, stopCount);
  }
  now = 1500;
  assert.deepEqual(JSON.parse(JSON.stringify(robotLiveOptions.clock("synth"))),
    { running: true, bpm: 120, beat: 5, at: 1500, token: `${generation}:2:0`, estimated: false, rateChanging: false, source: "synth", label: "Synth" });
  const synthToken = robotLiveOptions.clock("synth").token;
  api.rememberSynthBeat({ tempo: 132, stepsPerBeat: 2, swing: 0 });
  assert.equal(robotLiveOptions.clock("synth").token, synthToken, "mapped tempo changes do not restart arm preparation on every synth tick");
  api.rememberSynthBeat({ tempo: 132, stepsPerBeat: 4, swing: 0 });
  assert.notEqual(robotLiveOptions.clock("synth").token, synthToken, "subdivision changes invalidate the previous phrase timing");
  state.liveSilenced = true;
  assert.equal(robotLiveOptions.clock("synth").running, false, "stale source data also suspends robot beat sync");
  state.liveSilenced = false;
  mixerClock = { playing: true, valid: true, bpm: 105, beat: 17.25, token: "music-track-2", estimated: true, rateChanging: true };
  assert.deepEqual(JSON.parse(JSON.stringify(robotLiveOptions.clock("mixer"))),
    { running: true, bpm: 105, beat: 17.25, at: 1500, token: "music-track-2", estimated: true, rateChanging: true, source: "mixer", label: "Music mixer" });
  mixerClock.valid = false;
  assert.equal(robotLiveOptions.clock("mixer").running, false);

  // Vocal replies share the actual audio transport, including its context and
  // audio-clock timestamp. Hardware clock snapshots cannot schedule a source.
  let musicResumes = 0;
  const musicContext = { currentTime: 12.5, state: "running", destination: {}, async resume() { musicResumes++; } };
  const synthContext = { currentTime: 24.5, state: "running", destination: {} };
  context.responseAudioContext = synthContext;
  vm.runInContext(`globalThis.previousResponseEnsureAudio = ensureAudioEngine;
    globalThis.responseAudioUnlocks = 0;
    ensureAudioEngine = async () => { responseAudioUnlocks++; state.audio = { context: responseAudioContext }; };`, context);
  state.audio = { context: synthContext };
  Object.assign(mixerClock, { context: musicContext, destination: musicContext.destination, at: 12.5 });
  const selectedMusic = responseOptions.getBackingClock();
  assert.equal(selectedMusic.token, mixerClock.token, "playing Music takes priority when both transports are running");
  assert.equal(selectedMusic.valid, false, "an invalid playing Music clock remains selected so the UI can wait for it");
  assert.equal(selectedMusic.context, musicContext, "overlay scheduling keeps the backing AudioContext");
  assert.equal(selectedMusic.destination, musicContext.destination);
  assert.equal(selectedMusic.at, 12.5, "overlay scheduling uses audio seconds, not the hardware clock's performance milliseconds");
  await responseOptions.unlockBacking();
  assert.equal(musicResumes, 1, "an explicit vocal gesture resumes the selected Music AudioContext");
  assert.equal(context.responseAudioUnlocks, 0, "Music playback does not create an unrelated Synth context");
  mixerClock.playing = false;
  const selectedSynth = responseOptions.getBackingClock();
  assert.equal(selectedSynth.context, synthContext, "playing Synth takes priority over a stopped Music track");
  assert.equal(selectedSynth.playing, true);
  assert.equal(selectedSynth.estimated, false);
  const stoppedMusic = mixerClock;
  mixerClock = null;
  assert.equal(responseOptions.getBackingClock().context, synthContext, "Synth remains usable when Music has no track");
  state.audio = null;
  assert.equal(responseOptions.getBackingClock().playing, true);
  assert.equal(responseOptions.getBackingClock().context, null, "inspecting MIDI-only Synth does not create an AudioContext");
  assert.equal(context.responseAudioUnlocks, 0);
  await responseOptions.unlockBacking();
  assert.equal(context.responseAudioUnlocks, 1, "an explicit vocal gesture enables browser voice audio over MIDI Synth");
  assert.equal(responseOptions.getBackingClock().context, synthContext);
  assert.equal(state.playing, true, "enabling vocal audio preserves the MIDI backing transport");
  assert.equal(state.playbackGeneration, generation);
  mixerClock = stoppedMusic;

  // Stop is still explicit and session restore cancels every persistent engine.
  api.selectSonificationWorkspace("robot-control", "synth-mixer");
  synthMixerOptions.transport.stop();
  assert.equal(state.playing, false, "the Synth Stop action also works while its view is hidden");
  assert.equal(state.playbackWorkspace, null);
  assert.equal(timers.has(scheduled), false);
  assert.equal(robotLiveOptions.clock("synth").running, false);
  assert.equal(responseOptions.getBackingClock().token, mixerClock.token,
    "a stopped Music selection remains available for setup without claiming playback");
  assert.equal(responseOptions.getBackingClock().playing, false);
  mixerClock = null;
  assert.equal(responseOptions.getBackingClock().playing, false, "no active backing never masquerades as running");
  state.audio = null;
  await responseOptions.unlockBacking();
  assert.equal(context.responseAudioUnlocks, 1, "an absent backing never starts or unlocks another transport");
  assert.equal(state.audio, null);
  vm.runInContext("ensureAudioEngine = previousResponseEnsureAudio;", context);

  // An isolated voice layers over the ongoing performance. It must not reset
  // its backing transport either when listening or when the vocal is ready.
  for (const hook of ["onBeforeListen", "onBeforePlay"]) {
    state.playing = true; state.playbackWorkspace = "synth-mixer";
    const before = [generatedLifecycle, mixerLifecycle, synthMixerLifecycle, experimentLifecycle].map(events => events.length);
    const playbackGeneration = state.playbackGeneration, stoppedVoices = context.effects.stops;
    await responseOptions[hook]({ output_mode: "vocals" });
    assert.equal(state.playing, true, `${hook} keeps Synth running underneath isolated vocals`);
    assert.equal(state.playbackWorkspace, "synth-mixer");
    assert.equal(state.playbackGeneration, playbackGeneration, `${hook} preserves the backing beat clock`);
    assert.equal(context.effects.stops, stoppedVoices, `${hook} leaves existing notes ringing`);
    for (const [index, events] of [generatedLifecycle, mixerLifecycle, synthMixerLifecycle, experimentLifecycle].entries())
      assert.equal(events.length, before[index], `${hook} leaves every backing engine active for isolated vocals`);
  }

  // The original full-mix path still makes room for its own generated backing.
  for (const hook of ["onBeforeListen", "onBeforePlay"]) for (const mode of [undefined, { output_mode: "mix" }]) {
    state.playing = true; state.playbackWorkspace = "synth-legacy";
    const before = [generatedLifecycle, mixerLifecycle, synthMixerLifecycle, experimentLifecycle].map(events => events.length);
    await responseOptions[hook](mode);
    assert.equal(state.playing, false, `${hook} stops the existing Synth transport`);
    for (const [index, events] of [generatedLifecycle, mixerLifecycle, synthMixerLifecycle, experimentLifecycle].entries()) {
      assert.equal(events.length, before[index] + 1, `${hook} visits each existing music player once`);
      assert.equal(events.at(-1), "deactivate");
    }
  }
  state.connectionsReady = true;
  await api.stopSessionPlayback();
  assert.equal(generatedLifecycle.at(-1), "deactivate");
  assert.equal(mixerLifecycle.at(-1), "deactivate");
  assert.equal(synthMixerLifecycle.at(-1), "deactivate");
  assert.equal(experimentLifecycle.at(-1), "deactivate");
  assert.equal(responseLifecycle.at(-1), "deactivate", "session restore also cancels microphone capture and pending auto-play");
  assert.equal(robotLifecycle.at(-1), "deactivate");
  assert.equal(robotLiveLifecycle.at(-1), "stop");
  assert.equal(drumLifecycle.at(-1), "stop", "loading a session stops automatic drumming as well as robot effects");

  // Feed actual emitted note callbacks into the drummer, including delayed
  // ratchets. A chord is one rhythmic onset regardless of its note count.
  vm.runInContext(`
    globalThis.emittedNotes = [];
    controlsAt = () => ({ valid: true, tempo: 120, stepsPerBeat: 2, swing: 0,
      soundMode: "off", parameters: [], cc: new Map(), pitch: 60 });
    Music.rhythmStep = () => ({ interval: 250, notes: [
      { offset: 0, velocity: 96, duration: 100 }, { offset: 100, velocity: 71, duration: 80 } ] });
    Music.chordNotes = () => [60, 64, 67];
    playMidiNote = (note, velocity) => emittedNotes.push({ note, velocity });
    renderHarmony = () => {};
  `, context);
  state.playing = true; state.output = "midi"; state.playbackWorkspace = "synth-mixer";
  state.sourceMode = "recording"; state.rhythmStep = 0; state.cursor = 0; state.maxSteps = 20; state.nextTickAt = now;
  const onsetCount = drumNotes.length;
  await api.actualPlaybackTick();
  assert.equal(drumNotes.length, onsetCount + 1, "a three-note chord creates one drum influence event");
  assert.deepEqual(JSON.parse(JSON.stringify(drumNotes.at(-1))), {
    beat: 0, token: `${state.playbackGeneration}:2:0`, notes: [60, 64, 67], velocity: 96
  });
  assert.equal(context.emittedNotes.length, 3);
  const delayedNote = [...state.noteTimers][0];
  const delayedCallback = timers.get(delayedNote).fn; timers.delete(delayedNote);
  now += 100; delayedCallback();
  assert.equal(drumNotes.length, onsetCount + 2);
  assert.ok(Math.abs(drumNotes.at(-1).beat - .2) < 1e-9, "a delayed note records its actual clock position");
  assert.equal(drumNotes.at(-1).velocity, 71);
  await api.actualPlaybackTick();
  const cancelledNote = timers.get([...state.noteTimers][0]).fn;
  const notesBeforeStop = drumNotes.length;
  api.stopPlayback(); now += 100; cancelledNote();
  assert.equal(drumNotes.length, notesBeforeStop, "cancelled synth notes cannot influence later drum patterns");

  // Space remains available in sonification views, but must not override form
  // controls or accidentally play underneath the Observer overlay.
  vm.runInContext("globalThis.shortcutCalls = 0; togglePlayback = () => {shortcutCalls++;};", context);
  state.workspaceView = "synth-legacy";
  const space = shortcut("Space");
  api.handlePlaybackShortcut(space);
  assert.equal(context.shortcutCalls, 1);
  assert.equal(space.prevented, true);
  api.handlePlaybackShortcut({ ...shortcut("Space"), repeat: true });
  api.handlePlaybackShortcut({ ...shortcut("Space"), defaultPrevented: true });
  const input = new TestElement(); input.editable = true;
  api.handlePlaybackShortcut(shortcut("Space", input));
  getElement("observer-overlay").hidden = false;
  bodyClasses.add("observer-overlay-open");
  api.handlePlaybackShortcut(shortcut("Space"));
  assert.equal(context.shortcutCalls, 1, "editable controls and Observer retain their own shortcuts");

  console.log("workspace integration: persistent playback, routing, beat clocks, explicit stop, restore, MIDI lifecycle and shortcuts passed.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
