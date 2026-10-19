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
  for (const id of ["connections-workspace", "signal-lab-workspace", "elevenlabs-workspace", "music-mixer-workspace", "synth-mixer-workspace", "rap-experiment-workspace", "rap-response-workspace", "robot-control-workspace", "robot-setup-workspace", "sonification-kind",
    "connection-input-label", "connection-output-label", "connection-input-light", "connection-output-light",
    "connection-output", "connection-midi-controls", "midi-panel", "panic-button", "connection-recording-pane", "connection-live-pane",
    "test-browser-audio", "browser-audio-status", "return-to-recording"]) ids.set(id, new Element());
  ids.get("connection-output").value = "audio";
  const links = ["connections", "synth-legacy", "drums", "elevenlabs", "mixer", "synth-mixer", "rap-experiment", "robot-control", "robot-setup", "rap-response"].map((workspace) => new Element({ workspace }));
  const inputs = ["recording", "live"].map((inputPane) => new Element({ inputPane }));
  const skip = new Element();
  const document = { body: new Element(), getElementById: (id) => ids.get(id),
    querySelector: () => skip, querySelectorAll: (selector) => ({ "a[data-workspace]": links,
      "[data-input-pane]": inputs })[selector] || [] };
  const stored = new Map(saved === undefined ? [] : [["hydra.interface-detail.v1", saved]]);
  const storageCalls = [];
  const storage = { getItem(key) { storageCalls.push(["get", key]); if (unavailableStorage) throw new Error("Unavailable"); return stored.get(key); },
    setItem(key, value) { storageCalls.push(["set", key, value]); if (unavailableStorage) throw new Error("Unavailable"); stored.set(key, value); } };
  const window = new Element(); window.location = { hash }; window.localStorage = storage;
  const history = [];
  window.history = Object.fromEntries(["pushState", "replaceState"].map((method) => [method, (_, __, hash) => {
    history.push({ method, hash }); window.location.hash = hash;
  }]));
  const calls = [];
  const shell = create({ document, window });
  const callbacks = { onNavigate: (view, previous) => calls.push(["navigate", view, previous]),
    onOutputChange: (output) => calls.push(["output", output]), onTestAudio: async () => {} };
  return { shell, document, window, stored, storageCalls, ids, links, inputs, skip, history, calls, callbacks,
    start(options = {}) { shell.init({ ...callbacks, ...options }); return this; } };
}

(async () => {
  // Start at Connections without creating or replacing engine state.
  const f = fixture().start();
  assert.equal(f.shell.currentView, "connections");
  assert.equal("advanced" in f.shell, false);
  assert.equal("setAdvanced" in f.shell, false);
  assert.equal(f.document.body.classes.has("basic-mode"), false);
  assert.equal(f.document.body.classes.has("advanced-mode"), false);
  assert.equal(f.ids.get("connections-workspace").hidden, false);
  assert.equal(f.ids.get("signal-lab-workspace").hidden, true);
  assert.equal(f.ids.get("elevenlabs-workspace").hidden, true);
  assert.equal(f.ids.get("music-mixer-workspace").hidden, true);
  assert.deepEqual(f.history, [{ method: "replaceState", hash: "#connections" }]);
  assert.deepEqual(f.calls, [["navigate", "connections", null]]);

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
  assert.equal(f.shell.currentView, "synth-mixer");
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
  assert.deepEqual(mixerBookmark.calls, [["navigate", "mixer", null]]);

  await f.links[5].dispatch("click");
  assert.equal(f.shell.currentView, "synth-mixer");
  assert.equal(f.ids.get("synth-mixer-workspace").hidden, false);
  for (const id of ["connections-workspace", "signal-lab-workspace", "elevenlabs-workspace", "music-mixer-workspace"])
    assert.equal(f.ids.get(id).hidden, true, `${id} stays hidden in Synth mixer`);
  assert.equal(f.skip.href, "#synth-mixer-workspace");
  assert.equal(f.links[5].attributes["aria-current"], "page");
  await f.links[1].dispatch("click");
  assert.equal(f.ids.get("synth-mixer-workspace").hidden, true);
  assert.equal(f.ids.get("signal-lab-workspace").hidden, false);
  const synthMixerBookmark = fixture({ hash: "#synth-mixer" }).start();
  assert.equal(synthMixerBookmark.shell.currentView, "synth-mixer");
  assert.equal(synthMixerBookmark.skip.href, "#synth-mixer-workspace");

  await f.links[6].dispatch("click");
  assert.equal(f.shell.currentView, "rap-experiment");
  assert.equal(f.ids.get("rap-experiment-workspace").hidden, false);
  assert.equal(f.skip.href, "#rap-experiment-workspace");
  assert.equal(f.ids.get("signal-lab-workspace").hidden, true);
  assert.equal(f.links[9].attributes["aria-current"], "page", "voice experiments remain inside the Rap response navigation group");
  await f.links[0].dispatch("click");
  assert.equal(f.ids.get("rap-experiment-workspace").hidden, true);
  assert.equal(f.links[9].attributes["aria-current"], undefined);
  assert.equal(fixture({ hash: "#rap-experiment" }).start().shell.currentView, "rap-experiment");

  await f.links[7].dispatch("click");
  assert.equal(f.shell.currentView, "robot-control");
  assert.equal(f.ids.get("robot-control-workspace").hidden, false);
  assert.equal(f.ids.get("rap-experiment-workspace").hidden, true);
  assert.equal(f.skip.href, "#robot-control-workspace");
  assert.equal(f.links[7].attributes["aria-current"], "page");
  await f.links[0].dispatch("click");
  assert.equal(f.ids.get("robot-control-workspace").hidden, true);
  assert.equal(fixture({ hash: "#robot-control" }).start().shell.currentView, "robot-control");

  await f.links[8].dispatch("click");
  assert.equal(f.shell.currentView, "robot-setup");
  assert.equal(f.ids.get("robot-setup-workspace").hidden, false);
  assert.equal(f.ids.get("robot-control-workspace").hidden, true);
  assert.equal(f.skip.href, "#robot-setup-workspace");
  assert.equal(f.links[8].attributes["aria-current"], "page");
  await f.links[7].dispatch("click");
  assert.equal(f.ids.get("robot-setup-workspace").hidden, true);
  assert.equal(f.ids.get("robot-control-workspace").hidden, false);
  assert.equal(fixture({ hash: "#robot-setup" }).start().skip.href, "#robot-setup-workspace");

  await f.links[9].dispatch("click");
  assert.equal(f.shell.currentView, "rap-response");
  assert.equal(f.ids.get("rap-response-workspace").hidden, false);
  assert.equal(f.ids.get("robot-control-workspace").hidden, true);
  assert.equal(f.ids.get("rap-experiment-workspace").hidden, true);
  assert.equal(f.skip.href, "#rap-response-workspace");
  assert.equal(f.links[9].attributes["aria-current"], "page");
  await f.links[0].dispatch("click");
  assert.equal(f.ids.get("rap-response-workspace").hidden, true);
  const responseBookmark = fixture({ hash: "#rap-response" }).start();
  assert.equal(responseBookmark.shell.currentView, "rap-response");
  assert.equal(responseBookmark.skip.href, "#rap-response-workspace");
  assert.deepEqual(responseBookmark.calls, [["navigate", "rap-response", null]]);

  // Public navigation separates setup and performance; old Drum bookmarks still resolve.
  const html = fs.readFileSync(path.join(__dirname, "../dashboard/index.html"), "utf8");
  const navigation = html.match(/<nav class="dashboard-switcher"[\s\S]*?<\/nav>/)[0];
  const setupNavigation = navigation.match(/aria-labelledby="workspace-setup-label"[\s\S]*?<\/div>\s*<\/div>/)[0];
  const useNavigation = navigation.match(/aria-labelledby="workspace-use-label"[\s\S]*?<\/div>\s*<\/div>/)[0];
  const workspaceLinks = markup => [...markup.matchAll(/data-workspace="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(workspaceLinks(setupNavigation), ["connections", "robot-setup"]);
  assert.deepEqual(workspaceLinks(useNavigation), ["synth-mixer", "mixer", "rap-response", "robot-control"]);
  assert.equal(workspaceLinks(navigation).filter(view => view.startsWith("rap-")).length, 1, "rap has one primary tab");
  const rapResponse = fs.readFileSync(path.join(__dirname, "../dashboard/rap-response.js"), "utf8");
  assert.doesNotMatch(rapResponse, /href="#rap-experiment"|Voice experiments/, "voice choices belong in the main rap workspace");
  assert.match(navigation, /href="#robot-setup"[^>]*>Keirzo setup<\/a>/);
  assert.match(navigation, /href="#robot-control"[^>]*>Keirzo control <span data-robot-live-indicator hidden>Live<\/span><\/a>/);
  assert.doesNotMatch(html, /<a[^>]*data-workspace="drums"/);
  assert.equal(normalizeView("#drums"), "drums");
  assert.ok(html.indexOf('src="robot-control.js"') < html.indexOf('src="robot-live.js"'));
  assert.ok(html.indexOf('src="robot-live.js"') < html.indexOf('src="app.js"'));

  // Historical preferences cannot hide controls or change the selected workspace.
  assert.doesNotMatch(html, /data-detail-mode|data-advanced|class="basic-mode"|class="advanced-mode"/);
  for (const value of ["basic", "advanced", "corrupt"]) {
    const restored = fixture({ hash: "#signal-lab", saved: value }).start();
    assert.equal(restored.shell.currentView, "synth-legacy", "existing Signal Lab bookmarks remain valid");
    assert.equal(restored.document.body.classes.has("basic-mode"), false);
    assert.equal(restored.document.body.classes.has("advanced-mode"), false);
    assert.deepEqual(restored.storageCalls, [], "navigation no longer reads or writes the removed detail preference");
  }
  const unavailable = fixture({ unavailableStorage: true }).start();
  assert.equal(unavailable.shell.currentView, "connections", "navigation remains available without browser storage");
  assert.deepEqual(unavailable.storageCalls, []);
  assert.equal(fixture({ hash: "#synth" }).start().shell.currentView, "synth-mixer", "Synth bookmark opens the promoted mixer");
  const presentationCSS = ["workspace-shell.css", "elevenlabs.css", "elevenlabs-realtime.css"]
    .map(file => fs.readFileSync(path.join(__dirname, "../dashboard", file), "utf8")).join("\n");
  assert.doesNotMatch(presentationCSS, /basic-mode|advanced-mode|\[data-advanced\]/,
    "all functional controls remain accessible without a detail-mode CSS dependency");

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
  assert.equal(normalizeView("#stage"), "synth-legacy");
  console.log("Workspace shell: navigation, complete controls, connection state, and audio-test recovery passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
