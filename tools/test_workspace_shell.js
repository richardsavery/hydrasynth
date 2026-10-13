"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/workspace-shell.js"), "utf8"), context);
const { create, normalizeView } = context.HydraWorkspace;

class Element {
  constructor(dataset = {}) {
    this.dataset = dataset; this.hidden = false; this.value = ""; this.attributes = {};
    this.listeners = new Map(); this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }
  addEventListener(name, callback) {
    const listeners = this.listeners.get(name) || []; listeners.push(callback); this.listeners.set(name, listeners);
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  async dispatch(name, overrides = {}) {
    const event = { target: this, button: 0, prevented: false, preventDefault() { this.prevented = true; }, ...overrides };
    for (const callback of this.listeners.get(name) || []) await callback(event);
    return event;
  }
}

function fixture({ hash = "", saved, unavailableStorage = false } = {}) {
  const ids = new Map();
  for (const id of ["connections-workspace", "signal-lab-workspace", "elevenlabs-workspace", "music-mixer-workspace", "sonification-kind",
    "connection-input-label", "connection-output-label", "connection-input-light", "connection-output-light",
    "connection-output", "connection-midi-controls", "midi-panel", "panic-button", "connection-recording-pane", "connection-live-pane",
    "test-browser-audio", "browser-audio-status", "return-to-recording"]) ids.set(id, new Element());
  ids.get("connection-output").value = "audio";
  const links = ["connections", "synth", "drums", "elevenlabs", "mixer"].map((workspace) => new Element({ workspace }));
  const modes = ["basic", "advanced"].map((detailMode) => new Element({ detailMode }));
  const inputs = ["recording", "live"].map((inputPane) => new Element({ inputPane }));
  const skip = new Element();
  const document = { body: new Element(), getElementById: (id) => ids.get(id),
    querySelector: () => skip, querySelectorAll: (selector) => ({ "a[data-workspace]": links,
      "[data-detail-mode]": modes, "[data-input-pane]": inputs })[selector] || [] };
  const stored = new Map(saved === undefined ? [] : [["hydra.interface-detail.v1", saved]]);
  const storage = { getItem(key) { if (unavailableStorage) throw new Error("Unavailable"); return stored.get(key); },
    setItem(key, value) { if (unavailableStorage) throw new Error("Unavailable"); stored.set(key, value); } };
  const window = new Element(); window.location = { hash }; window.localStorage = storage;
  const history = [];
  window.history = Object.fromEntries(["pushState", "replaceState"].map((method) => [method, (_, __, hash) => {
    history.push({ method, hash }); window.location.hash = hash;
  }]));
  const calls = [];
  const shell = create({ document, window });
  const callbacks = { onNavigate: (view, previous) => calls.push(["navigate", view, previous]),
    onAdvancedChange: (advanced) => calls.push(["advanced", advanced]),
    onOutputChange: (output) => calls.push(["output", output]), onTestAudio: async () => {} };
  return { shell, document, window, stored, ids, links, modes, inputs, skip, history, calls, callbacks,
    start(options = {}) { shell.init({ ...callbacks, ...options }); return this; } };
}

(async () => {
  // Start at Connections in Basic mode without creating or replacing engine state.
  const f = fixture().start();
  assert.equal(f.shell.currentView, "connections");
  assert.equal(f.shell.advanced, false);
  assert.equal(f.document.body.classes.has("basic-mode"), true);
  assert.equal(f.ids.get("connections-workspace").hidden, false);
  assert.equal(f.ids.get("signal-lab-workspace").hidden, true);
  assert.equal(f.ids.get("elevenlabs-workspace").hidden, true);
  assert.equal(f.ids.get("music-mixer-workspace").hidden, true);
  assert.deepEqual(f.history, [{ method: "replaceState", hash: "#connections" }]);
  assert.deepEqual(f.calls, [["advanced", false], ["navigate", "connections", null]]);

  // Navigating and browser history select the correct engine, exactly once.
  const click = await f.links[2].dispatch("click");
  assert.equal(click.prevented, true);
  assert.equal(f.shell.currentView, "drums");
  assert.equal(f.ids.get("signal-lab-workspace").hidden, false);
  assert.equal(f.ids.get("connections-workspace").hidden, true);
  assert.equal(f.ids.get("sonification-kind").textContent, "DRUMS");
  assert.equal(f.links[2].attributes["aria-current"], "page");
  assert.equal(f.links[0].attributes["aria-current"], undefined);
  const count = f.calls.length;
  await f.window.dispatch("hashchange");
  assert.equal(f.calls.length, count, "hashchange following navigation must not restart audio twice");
  f.window.location.hash = "#synth";
  await f.window.dispatch("popstate");
  assert.equal(f.shell.currentView, "synth");
  assert.equal(f.history.length, 2, "following history must not append more history entries");
  await f.links[3].dispatch("click");
  assert.equal(f.ids.get("signal-lab-workspace").hidden, true);
  assert.equal(f.ids.get("elevenlabs-workspace").hidden, false);
  assert.equal(f.skip.href, "#elevenlabs-workspace");
  assert.equal(f.document.body.classes.has("elevenlabs-active"), true);
  assert.equal(f.shell.navigate("not-a-view"), false);
  assert.equal(f.shell.currentView, "elevenlabs");
  const modified = await f.links[1].dispatch("click", { metaKey: true });
  assert.equal(modified.prevented, false, "modified links retain open-in-new-tab behavior");
  assert.equal(f.shell.currentView, "elevenlabs");
  f.window.location.hash = "#drum-panel";
  await f.window.dispatch("hashchange");
  assert.equal(f.shell.currentView, "elevenlabs", "in-page anchors must not navigate to Connections");

  await f.links[4].dispatch("click");
  assert.equal(f.shell.currentView, "mixer");
  assert.equal(f.ids.get("music-mixer-workspace").hidden, false);
  for (const id of ["connections-workspace", "signal-lab-workspace", "elevenlabs-workspace"])
    assert.equal(f.ids.get(id).hidden, true, `${id} stays hidden in the Mixer demo`);
  assert.equal(f.skip.href, "#music-mixer-workspace");
  assert.equal(f.links[4].attributes["aria-current"], "page");
  assert.equal(f.links[3].attributes["aria-current"], undefined);
  assert.equal(f.document.body.classes.has("elevenlabs-active"), false);
  f.window.location.hash = "#elevenlabs";
  await f.window.dispatch("popstate");
  assert.equal(f.ids.get("music-mixer-workspace").hidden, true);
  assert.equal(f.ids.get("elevenlabs-workspace").hidden, false);
  const mixerBookmark = fixture({ hash: "#mixer" }).start();
  assert.equal(mixerBookmark.shell.currentView, "mixer", "Mixer demo has its own restorable bookmark");
  assert.equal(mixerBookmark.ids.get("music-mixer-workspace").hidden, false);
  assert.equal(mixerBookmark.ids.get("elevenlabs-workspace").hidden, true);
  assert.deepEqual(mixerBookmark.calls, [["advanced", false], ["navigate", "mixer", null]]);

  // Detail mode changes presentation in-place. Input/output and route do not change.
  const previousCalls = f.calls.filter((call) => call[0] === "navigate").length;
  await f.modes[1].dispatch("click");
  assert.equal(f.shell.advanced, true);
  assert.equal(f.document.body.classes.has("basic-mode"), false);
  assert.equal(f.document.body.classes.has("advanced-mode"), true);
  assert.equal(f.stored.get("hydra.interface-detail.v1"), "advanced");
  assert.equal(f.calls.filter((call) => call[0] === "navigate").length, previousCalls);
  assert.equal(f.modes[1].attributes["aria-pressed"], "true");
  const restored = fixture({ hash: "#signal-lab", saved: "advanced" }).start();
  assert.equal(restored.shell.currentView, "synth", "existing Signal Lab bookmarks remain valid");
  assert.equal(restored.shell.advanced, true);
  const unavailable = fixture({ unavailableStorage: true }).start();
  await unavailable.modes[1].dispatch("click");
  assert.equal(unavailable.shell.advanced, true, "storage failures leave the session usable");
  assert.equal(fixture({ saved: "corrupt" }).start().shell.advanced, false);

  // Shared status does not connect anything and must not interrupt inspecting another input.
  f.shell.updateConnections({ inputMode: "recording", inputLabel: "Morning movement", inputState: "ready",
    output: "midi", outputLabel: "Hydrasynth", midiReady: true });
  assert.equal(f.ids.get("connection-midi-controls").hidden, false);
  assert.equal(f.ids.get("midi-panel").hidden, false);
  assert.equal(f.ids.get("panic-button").hidden, false);
  assert.equal(f.ids.get("connection-input-label").textContent, "Morning movement");
  assert.equal(f.ids.get("connection-output-light").className, "status-light is-ready");
  await f.inputs[1].dispatch("click");
  assert.equal(f.ids.get("connection-live-pane").hidden, false);
  f.shell.updateConnections({ inputMode: "recording", inputState: "ready" });
  assert.equal(f.ids.get("connection-live-pane").hidden, false, "status refresh must not switch the input form under the user");
  assert.equal(f.calls.some((call) => call[0] === "output"), false, "status refresh must not change engine routing");
  f.shell.updateConnections({ inputMode: "live", inputState: "connecting" });
  assert.equal(f.ids.get("connection-input-light").className, "status-light is-pending");
  f.shell.updateConnections({ inputState: "offline", midiReady: false });
  assert.equal(f.ids.get("connection-input-light").className, "status-light is-warning");
  assert.equal(f.ids.get("connection-output-light").className, "status-light is-warning");
  assert.equal(f.ids.get("midi-panel").hidden, false, "unconnected MIDI destinations must remain available to choose");
  assert.equal(f.ids.get("panic-button").hidden, true);
  f.ids.get("connection-output").value = "audio";
  await f.ids.get("connection-output").dispatch("change");
  assert.equal(f.ids.get("connection-midi-controls").hidden, true);
  assert.deepEqual(f.calls.at(-1), ["output", "audio"]);

  // A failed audio test stays explicit and can be tried again.
  const failure = fixture().start({ onTestAudio: async () => { throw new Error("Audio device unavailable"); } });
  await failure.ids.get("test-browser-audio").dispatch("click");
  assert.equal(failure.ids.get("browser-audio-status").textContent, "Audio device unavailable");
  assert.equal(failure.ids.get("test-browser-audio").disabled, false);
  await f.ids.get("test-browser-audio").dispatch("click");
  assert.equal(f.ids.get("browser-audio-status").textContent, "Test sound played. Browser audio is ready.");
  const beforeReinit = f.calls.length;
  f.shell.init(f.callbacks);
  assert.equal(f.calls.length, beforeReinit, "initialization is idempotent");
  assert.equal(normalizeView("#stage"), "synth");
  console.log("Workspace shell: navigation, detail preferences, connection state, and audio-test recovery passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
