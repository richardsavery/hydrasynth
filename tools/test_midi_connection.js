"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture({ preferences = {}, saved = {}, available = true } = {}) {
  const storage = new Map([["hydra.connections.v1", JSON.stringify(preferences)], ["hydra-signal-lab-v1", JSON.stringify(saved)]]);
  const elements = new Map(), calls = [], messages = [], sent = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", checked: true, hidden: false, children: [],
      replaceChildren(...children) { this.children = children; }, add(child) { this.children.push(child); } });
    return elements.get(id);
  };
  let resolve, reject, stops = 0;
  const context = vm.createContext({ console, URL, URLSearchParams,
    document: { addEventListener() {} }, window: {}, performance: { now: () => 0 },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    Option: class { constructor(label, value) { this.textContent = label; this.value = value; } },
    navigator: available ? { requestMIDIAccess(options) {
      calls.push(options); return new Promise((yes, no) => { resolve = yes; reject = no; });
    } } : {},
    testStop: () => { stops++; }, testMessage: text => messages.push(text)
  });
  for (const file of ["drums.js", "sonification.js", "parameters.js", "app.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard", file), "utf8"), context, { filename: file });
  vm.runInContext(`
    globalThis.api = { state, dom, connectMidi, renderMidiOutputs, selectMidiOutput,
      selectConnectionOutput, restoreConnectionPreferences, saveConnectionPreferences };
    renderSoundControls = renderOutputMode = renderPlaybackAvailability = updateConnectionSummary = () => {};
    stopPlayback = () => { testStop(); state.playing = state.preparing = false; };
    showToast = testMessage;
    saveSettings = () => { if (state.connectionsReady) saveConnectionPreferences(); return true; };
  `, context);
  const { api } = context;
  for (const id of ["midi-output", "midi-panel", "panic-button", "midi-status", "midi-choice-detail", "connect-midi", "live-url", "live-reconnect", "midi-format", "midi-rate"])
    api.dom[id] = element(id);
  api.dom["midi-format"].value = "nrpn";
  api.dom["midi-rate"].value = "50";
  api.state.workspaceView = "connections";
  const access = { outputs: new Map() };
  const port = (id, name = "HYDRASYNTH", manufacturer = "ASM", state = "connected") => ({ id, name, manufacturer, state,
    send: bytes => sent.push([id, ...bytes]) });
  return { ...api, access, calls, storage, messages, sent, element, port, get stops() { return stops; },
    resolve: () => resolve(access), reject: () => reject(new Error("Permission denied")),
    async startup() { await api.restoreConnectionPreferences({ autoConnectMidi: true }); return api.state.midiConnecting; },
    async grant() { const pending = api.state.midiConnecting; resolve(access); await pending; },
    change(...ports) { access.outputs = new Map(ports.map(item => [item.id, item])); access.onstatechange(); }
  };
}

async function main() {
  {
    const h = fixture(), hydra = h.port("hydra-1");
    h.access.outputs.set(hydra.id, hydra);
    // Startup stays usable even when the browser's permission prompt is open.
    await h.restoreConnectionPreferences({ autoConnectMidi: true });
    assert.equal(h.state.connectionsReady, true);
    const pending = h.state.midiConnecting;
    assert.equal(h.connectMidi(), pending, "manual connect shares the startup permission request");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].sysex, false);
    await h.grant();
    assert.equal(h.state.midiOutput, hydra);
    assert.equal(h.state.synthOutput, "midi", "a fresh install chooses its unique Hydrasynth");
    assert.equal(h.state.playing, false);
    assert.deepEqual(h.sent, [], "connection never sends notes, program changes or other MIDI messages");
    const saved = JSON.parse(h.storage.get("hydra.connections.v1"));
    assert.equal(saved.midiDeviceName, "HYDRASYNTH");
    assert.equal(saved.midiDeviceManufacturer, "ASM");
    h.state.playing = true;
    h.change({ ...hydra, state: "disconnected" });
    assert.equal(h.state.midiOutput, null, "disconnected ports retained by Web MIDI are excluded");
    assert.equal(h.state.playing, false);
    assert.equal(h.state.synthOutput, "midi");
    const replacement = h.port("new-port-id");
    h.change(replacement);
    assert.equal(h.state.midiOutput, replacement, "a unique matching identity reconnects after its id changes");
    assert.equal(h.state.playing, false, "reconnection never restarts playback");
    assert.equal(JSON.parse(h.storage.get("hydra.connections.v1")).midiDeviceId, "new-port-id");
    assert.deepEqual(h.sent, []);
  }
  for (const settings of [{ preferences: { synthOutput: "audio" } }, { saved: { connections: { synthOutput: "audio" } } }]) {
    const h = fixture(settings), hydra = h.port("hydra");
    h.access.outputs.set(hydra.id, hydra);
    await h.restoreConnectionPreferences({ autoConnectMidi: true }); await h.grant();
    assert.equal(h.state.midiOutput, hydra);
    assert.equal(h.state.synthOutput, "audio", "saved browser audio remains selected after automatic MIDI access");
  }
  {
    const h = fixture();
    h.access.outputs.set("hydra", h.port("hydra"));
    await h.restoreConnectionPreferences({ autoConnectMidi: true });
    h.selectConnectionOutput("audio");
    await h.grant();
    assert.equal(h.state.synthOutput, "audio", "a route selected during the permission prompt takes precedence");
  }
  {
    const h = fixture();
    await h.restoreConnectionPreferences({ autoConnectMidi: true }); await h.grant();
    assert.equal(h.state.midiOutput, null);
    h.state.workspaceView = "mixer"; h.state.output = "audio";
    h.change(h.port("later"));
    assert.equal(h.state.midiOutput.id, "later", "a Hydrasynth plugged in after startup is discovered");
    assert.equal(h.state.synthOutput, "midi");
    assert.equal(h.state.output, "audio", "the music mixer's browser audio route stays unchanged");
  }
  {
    const h = fixture({ preferences: { synthOutput: "midi", midiDeviceId: "other", midiDeviceName: "Keys", midiDeviceManufacturer: "Other" } });
    const other = h.port("other", "Keys", "Other"), hydra = h.port("hydra");
    h.access.outputs = new Map([[other.id, other], [hydra.id, hydra]]);
    await h.restoreConnectionPreferences({ autoConnectMidi: true }); await h.grant();
    assert.equal(h.state.midiOutput, other, "an explicitly selected other MIDI device wins over Hydrasynth");
    h.change(hydra);
    assert.equal(h.state.midiOutput, null, "disconnect cannot silently replace the saved device with Hydrasynth");
    const replacement = h.port("other-new", "Keys", "Other"); h.change(hydra, replacement);
    assert.equal(h.state.midiOutput, replacement);
    h.dom["midi-output"].value = ""; h.selectMidiOutput(); h.change(hydra, replacement);
    assert.equal(h.state.midiOutput, null, "an explicit No device selected choice is retained");
  }
  for (const preferences of [{}, { midiDeviceId: "old", midiDeviceName: "HYDRASYNTH", midiDeviceManufacturer: "ASM" }]) {
    const h = fixture({ preferences });
    h.access.outputs = new Map([["one", h.port("one")], ["two", h.port("two")]]);
    await h.restoreConnectionPreferences({ autoConnectMidi: true }); await h.grant();
    assert.equal(h.state.midiOutput, null, "ambiguous matching synths require a manual selection");
    h.dom["midi-output"].value = "two"; h.selectMidiOutput(); h.change(...h.access.outputs.values());
    assert.equal(h.state.midiOutput.id, "two", "a selected exact id resolves ambiguity");
  }
  {
    const h = fixture({ preferences: { midiDeviceId: "unavailable-legacy-id" } });
    h.access.outputs.set("hydra", h.port("hydra"));
    await h.restoreConnectionPreferences({ autoConnectMidi: true }); await h.grant();
    assert.equal(h.state.midiOutput, null, "a missing saved device without identity is not guessed");
  }
  {
    const h = fixture();
    await h.restoreConnectionPreferences({ autoConnectMidi: true });
    const pending = h.state.midiConnecting; h.reject(); await pending;
    assert.equal(h.state.midiConnecting, null);
    assert.equal(h.state.midiOutput, null);
    assert.match(h.dom["midi-status"].textContent, /not granted/);
    assert.deepEqual(h.messages, [], "automatic permission denial is shown inline without repeated toasts");
    const retry = h.connectMidi(); h.resolve(); await retry;
    assert.equal(h.calls.length, 2, "a deliberate retry may request access after denial");
    assert.equal(h.state.midiConnectionError, "");
  }
  {
    const h = fixture({ available: false });
    await h.restoreConnectionPreferences({ autoConnectMidi: true });
    assert.match(h.dom["midi-status"].textContent, /not available/);
    assert.equal(h.state.connectionsReady, true);
    assert.equal(h.state.synthOutput, "audio");
  }
  console.log("MIDI connections: automatic startup, permission races, saved routes, identity reconnect, ambiguity, disconnect and silent recovery passed.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
