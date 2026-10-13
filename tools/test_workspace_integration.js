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
const mixerLifecycle = [], musicLifecycle = [], sourceBridges = [];
let generatedOptions, mixerOptions;
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
  performance: { now: () => 0 },
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
    deactivate() { mixerLifecycle.push("deactivate"); musicLifecycle.push("mixer:deactivate"); }
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
    handlePlaybackShortcut, togglePlayback, stopPlayback, saveSettings, renderOutputMode, bindSonificationWorkspaces};
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
  assert.equal(sourceBridges.length, 2);
  assert.equal(generatedOptions.sourceBridge, sourceBridges[0].bridge);
  assert.notEqual(mixerOptions.sourceBridge, generatedOptions.sourceBridge,
    "the mixer must keep its playback timing and preparation independent from Generated music");
  assert.equal(mixerOptions.sourceBridge.prepare, sourceBridges[1].bridge.prepare);
  assert.equal(mixerOptions.container, getElement("music-mixer-workspace"));
  assert.equal(sourceBridges[0].options.getState(), sourceBridges[1].options.getState(),
    "both engines share the chosen Connections input");
  assert.equal(sourceBridges[0].options.loadSeries, sourceBridges[1].options.loadSeries);
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

  state.workspaceView = "synth";
  state.synthOutput = "midi";
  state.output = "midi";

  // Recording and preset snapshots include legacy output modes. Restoring their
  // sound settings cannot change the global connection or selected workspace.
  for (const savedOutput of ["audio", "drums", "midi"]) {
    api.applyMusicalControls({ output: savedOutput, tempo: 137 });
    assert.equal(state.workspaceView, "synth");
    assert.equal(state.synthOutput, "midi");
    assert.equal(state.output, "midi", `restoring ${savedOutput} cannot reroute Synth`);
    assert.equal(dom.tempo.value, "137", "sound settings still restore");
  }
  state.tabs.push({ id: 2, name: "Legacy drum preset", mappings: [], controls: Music.controls({ output: "drums", tempo: 112 }) });
  api.activateTab(2);
  assert.equal(state.workspaceView, "synth");
  assert.equal(state.output, "midi", "opening a legacy preset cannot select a different sonification");

  api.selectSonificationWorkspace("drums", "synth");
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
  api.selectSonificationWorkspace("synth", "drums");
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
  api.selectSonificationWorkspace("drums", "synth");
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

  api.selectSonificationWorkspace("synth", "drums");
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
  api.selectSonificationWorkspace("synth", "drums");
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
  assert.deepEqual(generatedLifecycle, ["activate", "deactivate"],
    "leaving Generated runs its cancellation lifecycle");
  assert.deepEqual(mixerLifecycle, ["activate", "deactivate"],
    "leaving Mixer demo runs its independent cancellation lifecycle");
  assert.deepEqual(musicLifecycle, ["generated:activate", "generated:deactivate", "mixer:activate", "mixer:deactivate"],
    "the previous music engine is deactivated before the next activates");
  assert.equal(JSON.stringify(state.saved), preferencesBeforeMusicNavigation,
    "trying the Mixer demo cannot modify saved sonification settings");
  assert.equal(JSON.stringify([...writes]), writesBeforeMusicNavigation,
    "switching music views cannot rewrite the original preferences");
  api.selectSonificationWorkspace("mixer", "connections");
  api.selectSonificationWorkspace("elevenlabs", "mixer");
  assert.deepEqual(musicLifecycle.slice(-3), ["mixer:activate", "mixer:deactivate", "generated:activate"],
    "returning to Generated music first stops the demo transport");
  api.selectSonificationWorkspace("connections", "elevenlabs");

  // Leaving while audio setup is pending invalidates the continuation, even
  // when its promise finishes later.
  api.selectConnectionOutput("audio");
  api.selectSonificationWorkspace("synth", "connections");
  state.mappings = [{ id: 1, sources: [{ sourceKey: "movement", reducer: "value" }], targets: [{ destination: "pitch" }] }];
  vm.runInContext("ensureAudioEngine = () => new Promise(resolve => {globalThis.finishAudio = resolve;});", context);
  const starting = api.togglePlayback();
  assert.equal(state.preparing, true);
  api.selectSonificationWorkspace("mixer", "synth");
  context.finishAudio();
  await starting;
  assert.equal(state.preparing, false);
  assert.equal(state.playing, false, "a canceled setup cannot start notes after navigation");
  api.selectConnectionOutput("midi");
  assert.equal(state.workspaceView, "mixer");
  assert.equal(state.output, "audio", "changing the shared Synth output cannot reroute Mixer demo");
  api.selectSonificationWorkspace("synth", "mixer");
  assert.equal(state.output, "midi", "returning to Synth restores its selected destination");

  // Space remains available in sonification views, but must not override form
  // controls or accidentally play underneath the Observer overlay.
  vm.runInContext("globalThis.shortcutCalls = 0; togglePlayback = () => {shortcutCalls++;};", context);
  state.workspaceView = "synth";
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

  console.log("workspace integration: independent routing, restore, MIDI lifecycle, navigation cancellation and shortcuts passed.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
