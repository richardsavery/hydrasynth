"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Run the app's actual capture/restore hooks against the sessions library.
// Network, audio creation and MIDI permission requests must never happen here.
const storage = new Map(), timers = new Map(), events = [], midi = [];
let timerId = 0, holdRobotStop = false, finishDrumStop, finishHardwareStop, failVoiceCapture = "", liveRobotSettings, drumSettings, failStorageKey, failStorageOnce;
let reloadedRoute, failReload = false;
const localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => {
    if (key === failStorageKey) throw new Error("Robot settings storage is full");
    if (key === failStorageOnce) { failStorageOnce = undefined; throw new Error("Session restore storage is full"); }
    storage.set(key, value);
  },
  removeItem: (key) => storage.delete(key)
};
const element = (value = "") => ({ value, checked: false, textContent: "", disabled: false,
  classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {},
  parentElement: { classList: { toggle() {} } } });
const failSideEffect = (name) => () => { throw new Error(`Restoring settings must not ${name}`); };
const context = vm.createContext({
  console, URL, URLSearchParams, Intl, TextEncoder, localStorage,
  document: { addEventListener() {} },
  window: { location: { protocol: "http:" },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); }, AudioContext: failSideEffect("create audio") },
  navigator: { requestMIDIAccess: failSideEffect("request MIDI access") },
  WebSocket: failSideEffect("connect a live socket"), fetch: failSideEffect("fetch or generate music"),
  performance: { now: () => 0 },
  HydraSynthMixer: {
    flush() { events.push("flush-synth"); localStorage.setItem("hydra.synth-mixer.v1", JSON.stringify({ marker: "synth-original" })); },
    deactivate() { events.push("stop-synth"); }
  },
  HydraMusicMixer: {
    flush() { events.push("flush-music"); localStorage.setItem("hydra.music-mixer.demo.v1", JSON.stringify({ marker: "music-original" })); },
    deactivate() { events.push("stop-music"); localStorage.setItem("hydra.music-mixer.demo.v1", JSON.stringify({ marker: "deactivated-old-mix" })); }
  },
  HydraRobotLive: { snapshot: () => ({ running: false, settings: liveRobotSettings }), stop() { events.push("stop-robot-effects"); } },
  HydraRobotDrums: { snapshot: () => drumSettings ? { settings: drumSettings } : undefined,
    exportState: () => drumSettings || { source: "mixer", style: "default" }, stop() {
    events.push("stop-robot-drums");
    return holdRobotStop ? new Promise(resolve => { finishDrumStop = resolve; }) : Promise.resolve();
  } },
  HydraRobotControl: { deactivate() {
    events.push("stop-robot-hardware");
    return holdRobotStop ? new Promise(resolve => { finishHardwareStop = resolve; }) : Promise.resolve();
  } },
  HydraElevenLabs: {
    flush(options) { assert.equal(options?.strict, true); if (failVoiceCapture === "elevenlabs") throw new Error("Music settings storage is full"); events.push("flush-elevenlabs"); },
    deactivate() { events.push("stop-elevenlabs"); }
  },
  HydraElevenRealtime: {
    flush(options) { assert.equal(options?.strict, true); if (failVoiceCapture === "realtime") throw new Error("Realtime settings storage is full"); events.push("flush-realtime"); }
  },
  HydraRapExperiment: {
    flush(options) {
      assert.equal(options?.strict, true, "session capture requires the latest comparison settings");
      if (failVoiceCapture === "experiment") throw new Error("Comparison settings storage is full");
      events.push("flush-rap-experiment"); localStorage.setItem("hydra-rap-experiment-v1", JSON.stringify({ text: "Comparison lyrics", bpm: 100, experiment_id: "saved-example" }));
    },
    deactivate() { events.push("stop-rap-experiment"); }
  },
  HydraRapResponse: {
    flush(options) {
      assert.equal(options?.strict, true, "session capture requires the latest response settings");
      if (failVoiceCapture === "response") throw new Error("Response settings storage is full");
      events.push("flush-rap-response"); localStorage.setItem("hydra.rap-response.v1", JSON.stringify({ text: "I missed the bus", bpm: 96, responseId: "saved-response" }));
    },
    deactivate() { events.push("stop-rap-response"); }
  },
  testEvent: (value) => events.push(value)
});
for (const file of ["drums.js", "sonification.js", "parameters.js", "live.js", "drum-workspace.js", "session-library.js", "midi-safety.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard", file), "utf8"), context, { filename: file });
}
vm.runInContext(`
  globalThis.api = { state, dom, Music, CONTROL_IDS, DRUM_CONTROL_IDS,
    captureSessionState, stopSessionPlayback, saveConnectionPreferences,
    restoreConnectionPreferences, selectRecording, selectLiveInput, applyMusicalControls,
    reloadSession, stopDashboardOnUnload, selectSonificationWorkspace };
  for (const name of ["renderPlaybackAvailability", "renderRhythm", "renderHarmony", "renderSoundControls",
    "renderOutputMode", "updatePlayhead", "publishSignalLabActivity", "updateConnectionSummary", "renderWorkspaces",
    "renderMappings", "renderRecordingList", "renderRecordingsForLive", "updateControlReadouts", "renderScale", "updateLiveStatus"])
    globalThis[name] = () => {};
  loadFocusedSeries = async () => {};
  showToast = message => testEvent(message);
`, context);
const { api } = context, { state, dom, Music } = api;
context.window.history = { replaceState(_state, _title, route) { context.window.location.hash = route; } };
context.window.location.reload = () => {
  if (failReload) throw new Error("Navigation unavailable");
  reloadedRoute = context.window.location.hash;
  // Exercise the actual application's unload handler, including a queued route
  // change. A reload stub that only stores the route misses stale mixer writes.
  api.selectSonificationWorkspace(reloadedRoute.slice(1), state.workspaceView);
  api.stopDashboardOnUnload();
};
for (const [key, id] of Object.entries(api.CONTROL_IDS)) dom[id] = element(String(Music.DEFAULT_CONTROLS[key]));
for (const [key, id] of Object.entries(api.DRUM_CONTROL_IDS)) dom[id] = element(String(context.HydraDrums.DEFAULTS[key]));
for (const id of ["preview-button", "session-state", "apply-patch", "workspace-status", "recording-title", "recording-detail", "add-mapping", "live-disconnect"]) dom[id] = element();
dom["live-url"] = element("wss://signals.example.invalid/live");
dom["live-reconnect"] = { checked: false };
state.workspaceView = "synth-mixer";
const recording = (id) => ({ id, name: id, channels: [], frames: 0, size_bytes: 0 });
state.library = { available: true, recordings: [recording("recording-a"), recording("recording-b")] };
state.saved = { controls: Music.controls({ tempo: 112 }), lastRecording: "recording-a", workspaces: {
  "recording-a": { activeIndex: 0, tabs: [{ name: "Recording A", controls: Music.controls({tempo: 112, midiFormat: "cc", midiRate: 20}), mappings: [] }] },
  "recording-b": { activeIndex: 0, tabs: [{ name: "Recording B", controls: Music.controls({tempo: 81, midiFormat: "cc", midiRate: 20}), mappings: [] }] },
  "live:wss://signals.example.invalid/live": { activeIndex: 0, tabs: [{ name: "Live settings", controls: Music.controls({tempo: 93, midiFormat: "cc", midiRate: 20}), mappings: [] }] }
} };

async function main() {
  state.connectionPreferences = { inputMode: "live", recordingId: "recording-a", liveUrl: "wss://signals.example.invalid/live",
    reconnect: false, synthOutput: "midi", midiFormat: "nrpn", midiRate: 100, midiDeviceId: "hydrasynth-saved" };
  storage.set("hydra.connections.v1", JSON.stringify(state.connectionPreferences));
  const initialConnections = storage.get("hydra.connections.v1");
  assert.throws(api.captureSessionState, /loading|ready/i, "an early capture cannot overwrite connections before initialization finishes");
  assert.throws(api.stopSessionPlayback, /loading|ready/i, "session load waits until pending initialization can no longer overwrite its settings");
  assert.equal(storage.get("hydra.connections.v1"), initialConnections);

  await api.restoreConnectionPreferences();
  assert.equal(state.connectionsReady, true);
  assert.equal(state.sourceMode, "live");
  assert.equal(state.liveUrl, "wss://signals.example.invalid/live");
  assert.equal(state.liveWanted, false, "restoring live settings needs a deliberate Connect live action");
  assert.equal(state.liveSocket, null);
  assert.equal(state.playing, false);
  assert.equal(state.midiAccess, null, "the stored device ID is a preference, not automatic permission");
  assert.equal(state.midiOutput, null);
  assert.equal(state.synthOutput, "midi");
  assert.equal(dom["midi-format"].value, "nrpn");
  assert.equal(dom["midi-rate"].value, "100");
  assert.equal(dom.tempo.value, "93", "the saved live workspace's own musical controls restore");
  assert.equal(timers.size, 0, "restoring input does not start polling or reconnect timers");

  // Once initialized, changing input applies its musical setup without changing
  // the separate Connections protocol/rate.
  await api.selectRecording("recording-b");
  assert.equal(dom.tempo.value, "81");
  assert.equal(dom["midi-format"].value, "nrpn");
  assert.equal(dom["midi-rate"].value, "100");
  api.selectLiveInput(new URL("wss://signals.example.invalid/live"), false);
  assert.equal(dom["midi-format"].value, "nrpn");
  assert.equal(dom["midi-rate"].value, "100");
  assert.equal(state.saved.workspaces["recording-a"].tabs[0].controls.tempo, 112, "input switches preserve the other recording's controls");

  storage.set("hydra-robot-drums-v1", JSON.stringify({ source: "synth", style: "broken", density: 35, influence: 70 }));
  storage.set("hydra.signal-library.v1", JSON.stringify({ version: 1, mixes: [{ id: "shared-mix", mode: "shared", bus: { name: "Movement" } }] }));
  const pendingJob = JSON.stringify({ jobId: "pending-server-job", stage: "polling" });
  storage.set("hydra.music-mixer.pending.v1", pendingJob);
  storage.set("unrelated-preferences", "keep-me");
  const sessions = context.HydraSessions.create({ storage: localStorage,
    beforeCapture: api.captureSessionState, beforeRestore: api.stopSessionPlayback,
    getRoute: () => "#synth-mixer", reload: api.reloadSession });
  const first = await sessions.save("Live performance");
  const capturedConnections = JSON.parse(first.storage["hydra.connections.v1"]);
  assert.equal(capturedConnections.inputMode, "live");
  assert.equal(capturedConnections.recordingId, "recording-b", "live setup preserves its return recording");
  assert.equal(capturedConnections.midiDeviceId, "hydrasynth-saved");
  assert.equal(capturedConnections.midiRate, 100);
  assert.equal(JSON.parse(first.storage["hydra.synth-mixer.v1"]).marker, "synth-original");
  assert.equal(JSON.parse(first.storage["hydra.music-mixer.demo.v1"]).marker, "music-original");
  assert.equal(JSON.parse(first.storage["hydra-rap-experiment-v1"]).text, "Comparison lyrics");
  assert.equal(JSON.parse(first.storage["hydra.rap-response.v1"]).text, "I missed the bus", "rap capture flushes its latest prompt before snapshotting");
  assert.equal(JSON.parse(first.storage["hydra-robot-drums-v1"]).source, "synth", "drum source and groove preferences belong to saved versions");
  assert.equal(JSON.parse(first.storage["hydra-robot-drums-v1"]).running, undefined, "drum performance intent is not persisted");
  assert.equal(first.storage["hydra.music-mixer.pending.v1"], undefined, "ongoing server jobs are not replayed by saved versions");
  assert.ok(events.includes("flush-synth") && events.includes("flush-music"), "capture flushes both current mixers before reading storage");
  assert.ok(events.includes("flush-rap-response"));
  assert.ok(events.includes("flush-elevenlabs") && events.includes("flush-realtime"));

  for (const panel of ["experiment", "response", "elevenlabs", "realtime"]) {
    const before = JSON.stringify(sessions.list());
    failVoiceCapture = panel;
    await assert.rejects(sessions.save("Must not save stale voice controls"), /storage is full/);
    assert.equal(JSON.stringify(sessions.list()), before, "failed capture cannot create a misleading saved version");
    await assert.rejects(sessions.update(first.id), /storage is full/);
    assert.equal(JSON.stringify(sessions.list()), before, "failed capture cannot overwrite the earlier saved version");
    failVoiceCapture = "";
  }

  liveRobotSettings = { source: "synth", head: false, leds: true };
  drumSettings = { source: "synth", style: "broken", density: 35, influence: 70 };
  for (const key of ["hydra-robot-live-settings-v1", "hydra-robot-drums-v1"]) {
    const before = JSON.stringify(sessions.list());
    failStorageKey = key;
    await assert.rejects(sessions.save("Must not save stale robot controls"), /storage is full/);
    assert.equal(JSON.stringify(sessions.list()), before);
    failStorageKey = undefined;
  }
  api.captureSessionState();
  assert.deepEqual(JSON.parse(storage.get("hydra-robot-live-settings-v1")), liveRobotSettings);
  assert.deepEqual(JSON.parse(storage.get("hydra-robot-drums-v1")), drumSettings);

  dom.tempo.value = "144";
  const second = await sessions.save("Faster version");
  assert.notEqual(first.id, second.id);
  assert.equal(JSON.parse(sessions.list().find((item) => item.id === first.id).storage["hydra-signal-lab-v1"]).controls.tempo, 93,
    "saving another version must not change an earlier snapshot");

  // A failed storage transaction must leave ordinary unload cleanup enabled.
  // This key is written by restore, but not by the playback-stop hooks.
  failStorageOnce = "hydra.signal-library.v1";
  const previousSharedMixes = storage.get("hydra.signal-library.v1");
  await assert.rejects(sessions.load(first.id), /previous settings were restored/);
  assert.equal(state.sessionReloading, false);
  assert.equal(reloadedRoute, undefined);
  assert.equal(storage.get("hydra.signal-library.v1"), previousSharedMixes);

  const output = { send: (bytes) => midi.push([...bytes]) };
  state.playing = true;
  state.midiOutput = output;
  state.midiSustainOutputs.add(output);
  state.midiNoteTimers.set(60, { output, note: 60, timer: ++timerId });
  timers.set(timerId, () => {});
  state.liveWanted = true;
  state.liveSocket = { close() { events.push("close-live"); } };
  events.length = 0;
  state.workspaceView = "mixer";
  storage.set("hydra-robot-drums-v1", JSON.stringify({ source: "mixer", style: "straight" }));
  const currentDrumSettings = storage.get("hydra-robot-drums-v1");
  holdRobotStop = true;
  const restoring = sessions.load(first.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reloadedRoute, undefined, "loading waits for physical output cancellation acknowledgement");
  assert.equal(storage.get("hydra-robot-drums-v1"), currentDrumSettings, "saved controls are untouched while the old drum session is stopping");
  finishDrumStop(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reloadedRoute, undefined, "hardware cleanup must finish as well as the drum generator");
  finishHardwareStop(); await restoring;
  assert.equal(storage.get("hydra-robot-drums-v1"), first.storage["hydra-robot-drums-v1"]);
  assert.deepEqual(midi.slice(0, 2), [[176, 64, 0], [128, 60, 0]], "loading releases sustain before active notes");
  assert.equal(state.playing, false);
  assert.equal(state.liveWanted, false);
  assert.equal(state.liveSocket, null);
  assert.equal(timers.size, 0);
  assert.ok(["stop-synth", "stop-music", "stop-elevenlabs", "stop-rap-experiment", "stop-rap-response", "stop-robot-effects", "stop-robot-drums", "stop-robot-hardware", "close-live"].every((event) => events.includes(event)));
  assert.equal(reloadedRoute, "#synth-mixer");
  assert.equal(state.workspaceView, "mixer", "a queued hash change cannot reactivate the old workspaces while restoring");
  assert.equal(events.filter(event => event === "stop-music").length, 1, "unload must not flush the old mixer a second time");
  assert.equal(events.filter(event => event === "stop-synth").length, 1);
  assert.equal(storage.get("hydra.music-mixer.demo.v1"), first.storage["hydra.music-mixer.demo.v1"], "deactivating the old mixer cannot overwrite the restored version");
  assert.equal(storage.get("hydra.connections.v1"), first.storage["hydra.connections.v1"]);
  assert.equal(storage.get("hydra.music-mixer.pending.v1"), pendingJob, "session restore leaves paid-job recovery state untouched");
  assert.equal(storage.get("unrelated-preferences"), "keep-me");
  assert.equal(sessions.list().length, 2);
  assert.equal(JSON.parse(sessions.list().find((item) => item.id === second.id).storage["hydra-signal-lab-v1"]).controls.tempo, 144);

  // If navigation itself throws, future navigation still shuts outputs down.
  failReload = true;
  assert.throws(() => api.reloadSession("#mixer"), /Navigation unavailable/);
  assert.equal(state.sessionReloading, false);
  failReload = false; holdRobotStop = false;
  events.length = 0;
  state.playing = true; state.liveWanted = true;
  state.liveSocket = { close() { events.push("close-live"); } };
  api.stopDashboardOnUnload();
  assert.equal(state.playing, false);
  assert.equal(state.liveSocket, null);
  assert.ok(["stop-synth", "stop-music", "stop-elevenlabs", "stop-rap-experiment", "stop-rap-response", "stop-robot-effects", "stop-robot-hardware", "close-live"].every(event => events.includes(event)),
    "ordinary navigation retains audio, MIDI, live-input and hardware cleanup");
  console.log("session integration: saved versions survive unload, failed restores preserve cleanup, and MIDI sustain is released.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
