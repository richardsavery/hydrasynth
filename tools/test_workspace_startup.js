"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise real app initialization and navigation with one broken workspace.
// No browser permissions, hardware, network calls, or paid requests are needed.
class Element {
  constructor() {
    this.children = []; this.dataset = {}; this.handlers = {}; this.attributes = {};
    this.hidden = false; this.value = ""; this.textContent = "";
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  get childElementCount() { return this.children.length; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

const modules = {
  HydraElevenLabs: "elevenlabs-workspace", HydraMusicMixer: "music-mixer-workspace",
  HydraRapExperiment: "rap-experiment-workspace", HydraRapResponse: "rap-response-workspace",
  HydraRobotControl: "robot-setup-workspace", HydraRobotLive: "robot-control-workspace",
  HydraSynthMixer: "synth-mixer-workspace"
};

function fixture({ broken, failure = "throw", route = "#synth-mixer" } = {}) {
  const elements = new Map(), created = [], calls = [], errors = [], events = [], writes = [];
  const saved = new Map([["hydra.connections.v1", JSON.stringify({ synthOutput: "midi", midiName: "Other computer" })]]);
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const create = () => { const result = new Element(); created.push(result); return result; };
  const context = vm.createContext({
    console: { error: (...args) => errors.push(args) }, performance: { now: () => 0 },
    document: {
      addEventListener() {}, getElementById: element, createElement: create,
      querySelector: () => null,
      querySelectorAll: selector => selector === "a[data-workspace]" ? created.filter(node => node.dataset.workspace) : [],
      body: new Element()
    },
    window: { location: { hash: route, reload() { calls.push("reload"); } }, addEventListener() {} },
    localStorage: { getItem: key => saved.get(key) || null,
      setItem: (...args) => writes.push(["set", ...args]), removeItem: (...args) => writes.push(["remove", ...args]) },
    fetch() { throw new Error("Startup recovery must not send network requests"); },
    HydraStudy: { emit: (type, payload) => events.push({ type, payload }) },
    HydraElevenSource: { create: () => ({ describe: () => ({}) }) },
    HydraSessions: { init: () => calls.push("sessions:init") }
  });
  context.window.history = {
    replaceState(_state, _title, hash) { context.window.location.hash = hash; },
    pushState(_state, _title, hash) { context.window.location.hash = hash; }
  };
  for (const [name, id] of Object.entries(modules)) {
    if (name === broken && failure === "missing") continue;
    context[name] = {
      init(options) {
        calls.push(`${name}:init`);
        if (name === broken && failure === "empty") return;
        (options.container || element(id)).replaceChildren(create());
        if (name === broken) throw new Error("Engine setup failed");
      },
      activate() { assert.notEqual(name, broken, "failed modules cannot activate"); calls.push(`${name}:activate`); },
      deactivate() { assert.notEqual(name, broken, "failed modules cannot save partial settings on cleanup"); calls.push(`${name}:deactivate`); },
      stop() { assert.notEqual(name, broken); calls.push(`${name}:stop`); }
    };
  }
  for (const file of ["drums.js", "sonification.js", "workspace-shell.js", "app.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard", file), "utf8"), context, { filename: file });
  }
  vm.runInContext(`
    renderSoundControls = () => {};
    renderOutputMode = () => {};
    stopPlayback = () => {};
    disconnectLive = () => {};
    panicMidi = () => {};
    globalThis.startup = { bindSonificationWorkspaces, stopDashboardOnUnload, playbackUnavailableReason,
      stopSessionPlayback, state };
  `, context);
  context.startup.bindSonificationWorkspaces();
  return { context, element, calls, errors, events, writes, saved };
}

for (const failure of ["throw", "missing", "empty"]) {
  const h = fixture({ broken: "HydraMusicMixer", failure });
  assert.ok(h.calls.includes("HydraSynthMixer:init"));
  assert.ok(h.calls.includes("HydraSynthMixer:activate"));
  assert.ok(h.calls.includes("sessions:init"));
  const panel = h.element("music-mixer-workspace").children[0];
  assert.equal(panel.attributes.role, "alert");
  assert.match(panel.children[1].textContent, /saved settings are kept/);
  assert.equal(h.errors.length, 1, "the failure remains visible in browser diagnostics");
  assert.equal(h.events[0].type, "client.workspace_error");
  assert.equal(h.events[0].payload.workspace, "mixer");
  h.context.HydraWorkspace.navigate("mixer");
  assert.equal(h.element("music-mixer-workspace").hidden, false);
  assert.match(h.context.startup.playbackUnavailableReason(), /could not start/);
  h.context.HydraWorkspace.navigate("connections");
  assert.equal(h.element("connections-workspace").hidden, false);
  h.context.HydraWorkspace.navigate("synth-mixer");
  assert.equal(h.element("synth-mixer-workspace").hidden, false);
  assert.doesNotThrow(() => h.context.startup.stopDashboardOnUnload());
  h.context.startup.state.connectionsReady = true;
  assert.doesNotThrow(() => h.context.startup.stopSessionPlayback(), "session restore also skips partially initialized modules");
  const beforeReload = h.calls.length;
  panel.children[3].children[0].handlers.click();
  assert.deepEqual(h.calls.slice(beforeReload), ["reload"], "recovery reloads only after an explicit click");
  assert.deepEqual(h.writes, [], "recovery never overwrites settings, connections, or pending generation journals");
  assert.equal(JSON.parse(h.saved.get("hydra.connections.v1")).midiName, "Other computer");
}

{
  const h = fixture({ broken: "HydraSynthMixer", failure: "empty", route: "#synth-mixer" });
  assert.equal(h.element("synth-mixer-workspace").hidden, false);
  assert.match(h.context.startup.playbackUnavailableReason(), /could not start/,
    "keyboard playback cannot fall through to the legacy synth after a failed mixer startup");
  h.context.HydraWorkspace.navigate("mixer");
  assert.ok(h.calls.includes("HydraMusicMixer:activate"));
}

{
  const h = fixture({ broken: "HydraRobotControl" });
  assert.equal(h.errors.length, 2, "dependent robot controls also show a recovery message");
  assert.ok(!h.calls.includes("HydraRobotLive:init"));
  h.context.HydraWorkspace.navigate("robot-control");
  assert.ok(!h.calls.includes("HydraRobotLive:activate"));
  assert.doesNotThrow(() => h.context.startup.stopDashboardOnUnload());
}

console.log("Workspace startup: failed, missing and empty modules are isolated; navigation, recovery and saved settings remain available.");
