"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const timers = new Map();
let now = 0, timer = 0;
const element = (value = "") => ({ value, checked: false, hidden: false, disabled: false, children: [], dataset: {},
  listeners: new Map(), attributes: new Map(), textContent: "",
  classList: { add() {}, remove() {}, toggle() {} },
  setAttribute(name, value) { this.attributes.set(name, String(value)); },
  removeAttribute(name) { this.attributes.delete(name); },
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  },
  dispatch(type) { for (const listener of this.listeners.get(type) || []) listener({ target: this }); },
  append(...children) { this.children.push(...children); },
  replaceChildren(...children) { this.children = children; },
  parentElement: { classList: { toggle() {} } } });
const context = vm.createContext({ console, Intl, URLSearchParams,
  document: { addEventListener() {}, createElement: () => element(), getElementById() { return null; }, querySelectorAll() { return []; }, body: { classList: { toggle() {} } } },
  localStorage: { getItem() { return null; }, setItem() {} }, performance: { now: () => now },
  window: { setTimeout(fn, ms) { timers.set(++timer, { fn, ms }); return timer; }, clearTimeout(id) { timers.delete(id); } },
  fetch: async () => ({ ok: true })
});
for (const file of ["drums.js", "sonification.js", "parameters.js", "live.js", "drum-workspace.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard", file), "utf8"), context);
}
vm.runInContext(`globalThis.api = {state, dom, Music, Drums, CONTROL_IDS, DRUM_CONTROL_IDS,
  togglePlayback, stopPlayback, runPlaybackTick, setOutput, drumSourceKeys, recordedDrumSamples, readMusicalControls, acceptDrumSeries,
  bindDrumInterface, renderMappings, playbackUnavailableReason, renderPlaybackAvailability, returnToRecording};
  globalThis.hits = []; globalThis.publications = []; globalThis.loads = [];
  ensureAudioEngine = async () => { state.audio = {context: {currentTime: 0}, master: {}}; };
  stopAudioVoices = () => {}; renderOutputMode = () => {}; renderHarmony = () => {}; clearWaveform = () => {};
  renderSoundControls = () => {}; loadFocusedSeries = async () => {}; saveSettings = () => {};
  publishSignalLabActivity = payload => publications.push(payload);
  loadDrumSeries = async () => loads;
  state.drumEngine = {hit(...args) { hits.push(args); }, stop() {}};
`, context);
const { api } = context;
const { state, dom, Music, Drums } = api;
for (const [key, id] of Object.entries(api.CONTROL_IDS)) dom[id] = element(String(Music.DEFAULT_CONTROLS[key]));
for (const [key, id] of Object.entries(api.DRUM_CONTROL_IDS)) dom[id] = element(String(Drums.DEFAULTS[key]));
for (const id of ["preview-button", "session-state", "wave-progress", "waveform", "playhead", "rhythm-pattern", "rhythm-readout", "toast",
  "drum-auto-sources", "drum-grid", "drum-activity", "drum-activity-value", "drum-tempo-readout", "drum-density-readout", "drum-status",
  "add-mapping", "mapping-rows", "playback-help", "return-to-recording"]) dom[id] = element();
dom["rhythm-pattern"].children = Array.from({ length: 16 }, () => element());
state.output = "drums";
state.recording = { id: "robot", name: "Movement" };
state.fields = [{ key: "v", kind: "velocity", fieldId: "velocity:0", reducers: ["value"] },
  { key: "p", kind: "position", fieldId: "data:0", reducers: ["value"] }];
state.fieldIndex = new Map(state.fields.map(field => [field.key, field]));
state.midiOutput = { send() { throw new Error("Drum playback must not send MIDI"); } };
context.loads = [["v", { points: [[0, 0], [.1, .8], [.4, .2], [1, 1]], minimum: 0, maximum: 1, duration_seconds: 10 }]];

async function main() {
  api.bindDrumInterface();
  assert.deepEqual([...api.drumSourceKeys()], ["v"], "automatic sources prefer joint velocity over position");
  state.drumSources = ["p"];
  assert.deepEqual([...api.drumSourceKeys()], ["p"]);
  state.drumSources = [];
  // Drums must start with no melodic recipes, and accept the just-loaded series.
  state.mappings = [];
  await api.togglePlayback();
  assert.equal(state.playing, true);
  assert.equal(state.drumSeries.get("v").duration_seconds, 10);
  assert.equal(state.drumDuration, 10);
  assert.equal(state.parameterTimer, null, "drums never start the synth parameter pump");
  assert.ok(context.hits.length > 0);
  assert.ok(context.hits[0][3] >= .008, "hits use the audio clock with a short scheduling lead");
  now = 2000;
  await api.runPlaybackTick();
  const initialProgress = context.publications.at(-1).progress;
  assert.equal(initialProgress, .2);
  assert.equal(api.recordedDrumSamples(.39)[0].value, .8, "recorded samples follow timestamps, not array ordinal");
  dom["drum-tempo-max"].value = "240";
  await api.runPlaybackTick();
  assert.equal(context.publications.at(-1).progress, initialProgress, "tempo cannot accelerate the recording timeline");
  // A newly discovered live field must not silently change a playing automatic selection.
  state.fields.unshift({ key: "v2", kind: "velocity", fieldId: "velocity:1", reducers: ["value"] });
  assert.deepEqual([...api.drumSourceKeys()], ["v"]);
  state.fields.shift();
  api.stopPlayback();
  assert.equal(timers.size, 0);
  assert.equal(state.drumActivity, 0);

  const offsetSeries = [
    ["v", { points: [[0, 0], [.5, .8], [1, 1]], minimum: 0, maximum: 1, start_time_seconds: 100, duration_seconds: 10 }],
    ["p", { points: [[0, 0], [.5, 5], [1, 10]], minimum: 0, maximum: 10, start_time_seconds: 105, duration_seconds: 20 }]
  ];
  state.drumSources = ["v", "p"];
  api.acceptDrumSeries(offsetSeries);
  assert.equal(state.drumDuration, 25);
  assert.equal(api.recordedDrumSamples(.1)[1], null, "a later channel cannot provide data before its start");
  const aligned = api.recordedDrumSamples(.6); // 15 seconds into the shared timeline
  assert.equal(aligned[0].value, 1, "shorter channels must not stretch to the longest channel's duration");
  assert.equal(aligned[1].value, 5, "source start offsets are preserved");
  state.drumSources = [];

  // EOF remains replayable, and all scheduled work is canceled when changing engine.
  api.acceptDrumSeries(context.loads);
  state.cursor = state.maxSteps - 1;
  await api.togglePlayback();
  assert.equal(state.playing, true);
  assert.equal(context.publications.at(-1).progress, 0);
  const callbacks = [...timers.values()].map(item => item.fn);
  api.setOutput("audio");
  assert.equal(state.playing, false);
  assert.equal(timers.size, 0);
  const count = context.hits.length;
  callbacks.forEach(fn => fn());
  assert.equal(context.hits.length, count);

  // Fresh live input produces hits; losing ANY selected channel silences it.
  state.output = "drums"; state.sourceMode = "live"; state.liveSocket = { readyState: 1 };
  vm.runInContext(`state.live = new Live.Stream(); state.live.ingest({channel:'robot',labels:['joint'],velocity:[1]}, performance.now());
    state.live.ingest({channel:'other',labels:['joint2'],velocity:[1]}, performance.now());
    state.fields=state.live.fields; state.fieldIndex=new Map(state.fields.map(f=>[f.key,f]));`, context);
  await api.togglePlayback();
  assert.equal(state.playing, true);
  now += 3001;
  vm.runInContext(`state.live.ingest({channel:'other',labels:['joint2'],velocity:[1]}, performance.now());`, context);
  const freshHits = context.hits.length;
  await api.runPlaybackTick();
  assert.equal(state.liveSilenced, true);
  assert.equal(context.hits.length, freshHits);
  assert.equal(context.publications.at(-1).stop, true);
  vm.runInContext(`state.live.ingest({channel:'robot',labels:['joint'],velocity:[.5]}, performance.now());`, context);
  await api.runPlaybackTick();
  assert.equal(state.liveSilenced, false);
  api.stopPlayback();

  // A canceled preparation cannot start sound once its request completes.
  state.sourceMode = "recording";
  vm.runInContext("loadDrumSeries = () => new Promise(resolve => {globalThis.finishLoad=resolve;});", context);
  const loading = api.togglePlayback();
  await Promise.resolve();
  assert.equal(state.preparing, true);
  api.stopPlayback();
  context.finishLoad(context.loads);
  await loading;
  assert.equal(state.playing, false);
  assert.equal(timers.size, 0);

  const controls = Music.controls({ output: "drums", drumKit: "warehouse", drumSources: ["a", "b"], drumMuted: ["snare"], drumTempoMax: 169 });
  const preset = Music.serializeTab({ name: "Robot groove", controls, mappings: [] });
  const imported = Music.parsePresetFile({ format: "hydra-signal-lab-presets", version: 1, presets: [preset] })[0];
  assert.equal(imported.controls.output, "drums");
  assert.equal(imported.controls.drumTempoMax, 169);
  assert.deepEqual([...imported.controls.drumSources], ["a", "b"]);
  assert.deepEqual([...imported.controls.drumMuted], ["snare"]);

  // A disconnected live source must explain why Preview is unavailable, even
  // after a kit change. Exercise the real kit event handlers and readout here.
  state.output = "drums";
  state.recording = { id: "live:fixture", name: "Live RAPP" };
  state.sourceMode = "live";
  state.playing = state.preparing = false;
  state.liveSocket = null;
  state.liveWanted = false;
  state.fields = [];
  state.fieldIndex = new Map();
  state.drumSources = [];
  state.drumPlayingKeys = null;
  vm.runInContext("state.live = new Live.Stream();", context);
  api.renderPlaybackAvailability();
  assert.equal(dom["preview-button"].disabled, true);
  const disconnectedReason = api.playbackUnavailableReason();
  assert.match(disconnectedReason, /connect|disconnected|live/i);
  assert.match(dom["drum-status"].textContent, /connect|disconnected|live/i);
  assert.equal(dom["playback-help"].textContent, disconnectedReason);
  assert.equal(dom["playback-help"].hidden, false);
  assert.equal(dom["return-to-recording"].hidden, false);
  const unavailableHits = context.hits.length;
  await api.togglePlayback();
  assert.equal(state.preparing, false, "unavailable input cannot enter a pending preparation state");
  assert.equal(context.hits.length, unavailableHits);
  for (const kit of ["warehouse", "minimal", "electro"]) {
    dom["drum-kit"].value = kit;
    dom["drum-kit"].dispatch("input");
    dom["drum-kit"].dispatch("change");
    assert.equal(state.sourceMode, "live", "kit selection never changes the input source");
    assert.equal(dom["preview-button"].disabled, true);
    assert.equal(api.playbackUnavailableReason(), disconnectedReason);
    assert.ok(!/\bready\b/i.test(dom["drum-status"].textContent), "a kit redraw cannot claim unavailable input is ready");
  }
  state.liveSocket = { readyState: 1 };
  api.renderPlaybackAvailability();
  assert.equal(dom["preview-button"].disabled, true);
  assert.match(api.playbackUnavailableReason(), /wait|data|signal|movement/i);
  vm.runInContext(`state.live.ingest({channel:'robot',labels:['joint'],velocity:[1]}, performance.now());
    state.fields = state.live.fields; state.fieldIndex = new Map(state.fields.map(field => [field.key, field]));`, context);
  api.renderPlaybackAvailability();
  assert.equal(api.playbackUnavailableReason(), "");
  assert.equal(dom["preview-button"].disabled, false);
  assert.equal(dom["playback-help"].hidden, true);
  state.drumSources = ["missing-joint"];
  api.renderPlaybackAvailability();
  assert.equal(dom["preview-button"].disabled, true);
  assert.match(api.playbackUnavailableReason(), /missing|available|waiting|source|signal/i);

  // Unavailable input never disables the user's Stop or Cancel action.
  for (const phase of ["playing", "preparing"]) {
    state.playing = phase === "playing";
    state.preparing = phase === "preparing";
    api.renderPlaybackAvailability();
    assert.equal(dom["preview-button"].disabled, false, `${phase} must remain cancelable when a source disappears`);
  }
  state.preparing = false;
  state.playing = true;
  state.drumSources = [];
  const beforeKitGeneration = state.playbackGeneration;
  for (const kit of ["warehouse", "minimal", "electro"]) {
    dom["drum-kit"].value = kit;
    dom["drum-kit"].dispatch("input");
    dom["drum-kit"].dispatch("change");
    assert.equal(state.playing, true, "changing kit while playing keeps the drum transport running");
    assert.equal(state.sourceMode, "live");
    assert.equal(state.playbackGeneration, beforeKitGeneration);
    assert.equal(api.readMusicalControls().drumKit, kit);
  }
  state.mappings = [];
  api.renderMappings();
  assert.equal(state.playing, true, "an empty melodic mapping matrix cannot stop active drums");
  assert.equal(state.playbackGeneration, beforeKitGeneration);
  state.playing = false;
  state.preparing = true;
  api.renderMappings();
  assert.equal(state.preparing, true, "an empty melodic matrix cannot cancel drum preparation either");
  api.stopPlayback();

  // Returning from live mode chooses a real recording and awaits its selection.
  vm.runInContext(`globalThis.recordingSelections = [];
    selectRecording = id => new Promise(resolve => {
      recordingSelections.push(id); globalThis.finishRecordingSelection = resolve;
    });`, context);
  state.library = { recordings: [{ id: "first" }, { id: "remembered" }] };
  state.saved.lastRecording = "remembered";
  api.renderPlaybackAvailability();
  assert.equal(dom["return-to-recording"].disabled, false);
  let returned = false;
  const returning = api.returnToRecording().then(() => { returned = true; });
  await Promise.resolve();
  assert.deepEqual([...context.recordingSelections], ["remembered"]);
  assert.equal(returned, false, "the return action waits for recording data to be selected");
  context.finishRecordingSelection();
  await returning;
  assert.equal(returned, true);
  state.saved.lastRecording = "removed";
  const fallback = api.returnToRecording();
  assert.equal(context.recordingSelections.at(-1), "first", "a removed last recording falls back to the first available one");
  context.finishRecordingSelection();
  await fallback;
  console.log("movement drum player: timing, lifecycle, live readiness, kit switching, return to recording and presets: ok");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
