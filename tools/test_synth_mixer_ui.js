"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const elements = new Map(), handlers = {}, saved = new Map();
const savedRap = { text: "Saved verse", enabled: true, requestId: "earlier-rap" };
saved.set("hydra.synth-mixer.v1", JSON.stringify({ rap: savedRap }));
const selectedPatches = [];
const timers = new Map(); let nextTimer = 0, activations = 0, configurationWrites = 0, transportStops = 0;
const setInterval = fn => { timers.set(++nextTimer, fn); return nextTimer; };
const clearInterval = id => timers.delete(id);
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    id, value: "", innerHTML: "", textContent: "", dataset: {},
    classList: { toggle() {} }, contains: () => false, querySelectorAll: () => [],
    addEventListener() {}, focus() {}, showModal() { this.open = true; }, close() { this.open = false; }
  });
  return elements.get(id);
}
const root = { classList: { add() {} }, querySelector: (selector) => element(selector.slice(1)),
  querySelectorAll: () => [], addEventListener(type, fn) { handlers[type] = fn; } };
let output = "audio", storageError = false, finishPatch;
const context = vm.createContext({ document: { activeElement: null }, performance: { now: () => 0 },
  setInterval, clearInterval, window: { setInterval, clearInterval },
  HydraRap: { create() { throw new Error("Rap must only run in its dedicated workspace"); } },
  localStorage: { getItem: (key) => saved.get(key) || null, setItem(key, value) { if (storageError) throw new Error("Storage full"); saved.set(key, value); } }
});
for (const name of ["sonification.js", "parameters.js", "elevenlabs-realtime.js", "music-mixer-engine.js", "signal-library.js", "synth-mixer-engine.js", "synth-mixer.js"])
  vm.runInContext(fs.readFileSync(`${__dirname}/../dashboard/${name}`, "utf8"), context);
const catalog = JSON.parse(fs.readFileSync(`${__dirname}/../data/hydrasynth_parameters.json`, "utf8"));
context.HydraParameters.install(catalog);
const createEngine = context.HydraSynthMixerEngine.create;
context.HydraSynthMixerEngine.create = options => {
  const engine = createEngine(options), activate = engine.activate, setConfig = engine.setConfig;
  engine.activate = () => { activations++; return activate(); };
  engine.setConfig = config => { configurationWrites++; return setConfig(config); };
  return engine;
};
context.HydraSynthMixer.init({ container: root, transport: {
  status: () => ({ output, midiReady: output === "midi", midiFormat: "nrpn" }), stop: () => { transportStops++; },
  selectPatch(bank, number) { selectedPatches.push({ bank, number }); return new Promise(resolve => { finishPatch = resolve; }); }
} });
function button(id, dataset = {}) { return { id, dataset, closest: (selector) => selector === "button" ? button(id, dataset) : null }; }
function click(id, dataset) { return handlers.click({ target: button(id, dataset) }); }
(async () => {
  assert.doesNotMatch(root.innerHTML, /id="sm-rap"/, "Synth mixer has no embedded rap controls");
  assert.equal(JSON.stringify(context.HydraSynthMixer.getState().rap), JSON.stringify(savedRap), "earlier rap drafts survive session exports without running");
  assert.equal(element("sm-apply-patch").disabled, true, "patch selection requires connected MIDI output");
  await click("sm-apply-patch");
  assert.equal(selectedPatches.length, 0, "browser audio cannot send MIDI patches");
  await click("sm-add-parameter");
  const picker = element("sm-picker-results");
  assert.equal((picker.innerHTML.match(/data-add-destination=/g) || []).length, context.HydraSonification.DESTINATIONS.length - 5,
    "the normal browser-output picker exposes every remaining catalog entry, without an 80-item cutoff");
  const last = context.HydraParameters.entries.at(-1);
  assert.ok(picker.innerHTML.includes(`data-add-destination="${last.id}"`));
  const unavailable = context.HydraParameters.entries.find((entry) => entry.unavailable);
  assert.match(picker.innerHTML, new RegExp(`data-add-destination="${unavailable.id}" disabled`));
  const hardware = context.HydraParameters.entries.find((entry) => !entry.unavailable && entry.choices?.length && entry.kind === "nrpn");
  await click("", { addDestination: hardware.id });
  assert.ok(context.HydraSynthMixer.getState().parameters.some((parameter) => parameter.destination === hardware.id));
  assert.ok(element("sm-parameters").innerHTML.includes("MIDI only"), "hardware cards explain browser-output availability");
  assert.match(element("sm-parameters").innerHTML, /<select id="sm-parameter-5-value" data-parameter-field="value" disabled>/);
  const before = context.HydraSynthMixer.getState().parameters.length;
  await click("", { addDestination: unavailable.id });
  assert.equal(context.HydraSynthMixer.getState().parameters.length, before, "unavailable documentation entries cannot become active controls");
  await click("sm-add-parameter");
  element("sm-parameter-search").value = last.id;
  handlers.input({ target: { id: "sm-parameter-search" } });
  assert.equal((picker.innerHTML.match(/data-add-destination=/g) || []).length, 1, "full-catalog IDs remain searchable");
  const parameters = element("sm-parameters");
  assert.match(parameters.innerHTML, /Signal strength <output data-strength-value>100%<\/output>/,
    "each parameter exposes a visible percentage control");
  assert.match(parameters.innerHTML, /id="sm-parameter-0-strength" type="range" min="0" max="100" step="1"[^>]*disabled/,
    "manual parameters keep signal strength inactive until a mix is chosen");
  const readouts = new Map();
  const card = { dataset: { parameter: "pitch" }, querySelector(selector) {
    if (!readouts.has(selector)) readouts.set(selector, { textContent: "" });
    return readouts.get(selector);
  } };
  const control = { id: "sm-parameter-0-bus", dataset: { parameterField: "busId" }, value: "mix-a", type: "select-one", tagName: "SELECT",
    hasAttribute: () => false, closest: (selector) => selector === "[data-parameter]" ? card : null,
    setAttribute(name, value) { this[name] = value; } };
  handlers.change({ target: control });
  assert.match(parameters.innerHTML, /<span>Base value <output data-manual-value>/,
    "mapped parameters expose the base value used by reduced signal strength");
  assert.match(parameters.innerHTML, /id="sm-parameter-0-value"[^>]*data-parameter-field="value"\s*>/,
    "base values remain editable when a signal is mapped");
  let parameterMarkup = parameters.innerHTML, replacements = 0;
  Object.defineProperty(parameters, "innerHTML", { get: () => parameterMarkup, set(value) { replacements++; parameterMarkup = value; } });
  Object.assign(control, { id: "sm-parameter-0-strength", dataset: { parameterField: "strength" }, type: "range", tagName: "INPUT", valueAsNumber: 35 });
  handlers.input({ target: control });
  assert.equal(context.HydraSynthMixer.getState().parameters[0].strength, .35);
  assert.equal(card.querySelector("[data-strength-value]").textContent, "35%", "dragging updates the visible percentage immediately");
  assert.equal(control["aria-valuetext"], "35%", "assistive technology receives the percentage");
  assert.equal(JSON.parse(saved.get("hydra.synth-mixer.v1")).parameters[0].strength, .35, "strength is saved during adjustment");
  handlers.change({ target: control });
  assert.equal(context.HydraSynthMixer.getState().parameters[0].strength, .35, "change keeps strength numeric");
  assert.equal(replacements, 0, "dragging and releasing strength never replace the focused parameter controls");
  control.valueAsNumber = 0;
  handlers.input({ target: control });
  const silentInput = context.HydraSynthMixer.snapshot.parameters.find((parameter) => parameter.destination === "pitch");
  assert.equal(silentInput.valid, true, "0% uses the base value even when its input has not arrived");
  assert.equal(silentInput.effectiveValue, silentInput.value);
  Object.assign(control, { dataset: { parameterField: "value" }, valueAsNumber: 65 });
  handlers.input({ target: control });
  assert.equal(context.HydraSynthMixer.getState().parameters[0].value, 65, "mapped base values can be adjusted live");
  assert.equal(card.querySelector("[data-manual-value]").textContent, "65");
  assert.equal(replacements, 0);
  const state = context.HydraSynthMixer.flush();
  assert.equal(JSON.parse(saved.get("hydra.synth-mixer.v1")).parameters.length, state.parameters.length);
  assert.ok(state.signalLinks, "session exports preserve shared-mix associations");
  const shareButton = { id: "", dataset: { action: "share-mix" }, closest(selector) {
    if (selector === "button") return this;
    if (selector === "[data-bus]") return { dataset: { bus: "mix-a" } };
    return null;
  } };
  await handlers.click({ target: shareButton });
  context.HydraSynthMixer.activate();
  const activeTimers = [...timers.keys()], initialWrites = configurationWrites;
  context.HydraSynthMixer.activate();
  assert.equal(configurationWrites, initialWrites, "revisiting unchanged shared signals does not rewrite engine config");
  assert.deepEqual([...timers.keys()], activeTimers, "revisiting Synth keeps its input and UI timers");
  const shared = context.HydraSignalLibrary.getState();
  shared.mixes[0].bus.name = "Edited elsewhere"; shared.mixes[0].revision++;
  context.HydraSignalLibrary.replaceState(shared);
  context.HydraSignalLibrary.create().share({ ...state.buses[0], id: "external", name: "New shared input" }, state.mode);
  context.HydraSynthMixer.activate();
  assert.equal(context.HydraSynthMixer.getState().buses[0].name, "Edited elsewhere", "linked edits are adopted on workspace return");
  assert.match(element("sm-shared-mix").innerHTML, /New shared input/, "newly shared inputs appear on return");
  assert.equal(configurationWrites, initialWrites + 1, "only an actual linked edit updates the engine");
  assert.equal(activations, 1, "shared signal refresh cannot restart the input engine");
  assert.equal(transportStops, 0);
  assert.deepEqual([...timers.keys()], activeTimers);
  context.HydraSynthMixer.deactivate();
  assert.equal(timers.size, 0);
  const changeControl = (key, value) => handlers.change({ target: { id: `sm-${key}`, dataset: { control: key },
    value: String(value), valueAsNumber: Number(value), type: typeof value === "number" ? "number" : "select-one", closest: () => null } });
  changeControl("soundMode", "mapped");
  assert.ok(context.HydraSynthMixer.getState().parameters.some(parameter => parameter.destination === "sound"), "Follow mapping makes the sound-position parameter available immediately");
  assert.equal(element("sm-sound-mapping-help").hidden, false);
  changeControl("patchPool", "shortlist");
  changeControl("patchList", "A001, H128");
  changeControl("soundEvery", "64");
  assert.equal(context.HydraSynthMixer.getState().controls.soundEvery, 64);
  assert.equal(element("sm-patch-list").disabled, false);
  output = "midi";
  changeControl("patchBank", "H");
  changeControl("patchNumber", 128);
  assert.equal(element("sm-apply-patch").disabled, false);
  const changing = click("sm-apply-patch");
  assert.deepEqual(selectedPatches, [{ bank: "H", number: 128 }], "manual patch selection uses this mixer's saved controls");
  assert.equal(element("sm-apply-patch").disabled, true);
  await click("sm-apply-patch");
  assert.equal(selectedPatches.length, 1, "repeated clicks cannot overlap patch changes");
  finishPatch(true); await changing;
  assert.equal(element("sm-apply-patch").disabled, false);
  assert.equal(JSON.parse(saved.get("hydra.synth-mixer.v1")).controls.patchList, "A001, H128");
  assert.equal(JSON.stringify(context.HydraSynthMixer.flush().rap), JSON.stringify(savedRap));
  storageError = true;
  assert.throws(() => context.HydraSynthMixer.flush(), /Storage full/, "session capture cannot silently persist stale state");
  assert.doesNotThrow(() => context.HydraSynthMixer.save(), "periodic preference saving remains tolerant");
  console.log("Synth mixer UI: full catalog, percentage strength, live base values, focus preservation, persistent activation, shared signal refresh and session capture passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
