"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createMappingTracker } = require("../dashboard/study-recorder.js");
const studyEvents = [];
const studyRecorder = { getContext: () => ({ session_id: "synth-test-session", client_id: "synth-test-client" }),
  emit(type, payload) { studyEvents.push({ type, payload: JSON.parse(JSON.stringify(payload)) }); return `event-${studyEvents.length}`; } };
const mappingEvents = () => studyEvents.filter(event => event.type === "mapping.configuration").map(event => event.payload);
const playbackEvents = () => studyEvents.filter(event => event.type === "mapping.playback").map(event => event.payload);
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
let output = "audio", storageError = false, finishPatch, finishStart, playing = false, preparing = false;
let connectedFields = [];
const context = vm.createContext({ document: { activeElement: null }, performance: { now: () => 0 },
  setInterval, clearInterval, window: { setInterval, clearInterval },
  HydraRap: { create() { throw new Error("Rap must only run in its dedicated workspace"); } },
  HydraStudy: { emit: studyRecorder.emit, createMappingTracker: workspace => createMappingTracker(studyRecorder, workspace) },
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
context.HydraSynthMixer.init({ container: root,
  sourceBridge: { describe: () => ({ mode: "live", label: "Connected inputs", fields: connectedFields }) }, transport: {
  status: () => ({ output, playing, preparing, midiReady: output === "midi", midiFormat: "nrpn" }), stop: () => { transportStops++; playing = false; },
  start() { preparing = true; return new Promise(resolve => { finishStart = () => { preparing = false; playing = true; resolve(); }; }); },
  selectPatch(bank, number) { selectedPatches.push({ bank, number }); return new Promise(resolve => { finishPatch = resolve; }); }
} });
function button(id, dataset = {}) { return { id, dataset, closest: (selector) => selector === "button" ? button(id, dataset) : null }; }
function click(id, dataset) { return handlers.click({ target: button(id, dataset) }); }
(async () => {
  assert.equal(mappingEvents().length, 1, "restoring saved controls establishes a complete mapping baseline");
  assert.equal(mappingEvents()[0].workspace, "synth-mixer");
  assert.equal(mappingEvents()[0].action, "restore");
  assert.equal(mappingEvents()[0].restored, true);
  assert.equal(mappingEvents()[0].config.config.parameters.length, 5, "restored partial settings are normalized before recording");
  assert.deepEqual(mappingEvents()[0].config.signalLinks, {});
  assert.equal(playbackEvents().length, 0, "restoring controls does not imply that they played");
  assert.doesNotMatch(root.innerHTML, /id="sm-rap"/, "Synth mixer has no embedded rap controls");
  assert.equal(element("sm-skeleton-detail-field").hidden, true, "skeleton controls stay hidden for ordinary sources");
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
  assert.equal(mappingEvents().at(-1).action, "add_parameter");
  assert.ok(mappingEvents().at(-1).config.config.parameters.some(parameter => parameter.destination === hardware.id));
  const beforeDuplicate = mappingEvents().length;
  await click("", { addDestination: hardware.id });
  assert.equal(mappingEvents().length, beforeDuplicate, "a rejected duplicate parameter creates no mapping revision");
  assert.ok(context.HydraSynthMixer.getState().parameters.some((parameter) => parameter.destination === hardware.id));
  assert.ok(element("sm-parameters").innerHTML.includes("MIDI only"), "hardware cards explain browser-output availability");
  assert.match(element("sm-parameters").innerHTML, /<select id="sm-parameter-5-value" data-parameter-field="value" disabled>/);
  const before = context.HydraSynthMixer.getState().parameters.length;
  await click("", { addDestination: unavailable.id });
  assert.equal(mappingEvents().length, beforeDuplicate, "an unavailable parameter is not recorded as an accepted mapping");
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
  const rapidDestination = context.HydraSonification.DESTINATIONS.find(destination => !destination.unavailable &&
    !context.HydraSynthMixer.getState().parameters.some(parameter => parameter.destination === destination.id));
  const rapidBefore = mappingEvents().length;
  await click("", { addDestination: rapidDestination.id });
  const removeParameter = { id: "", dataset: { action: "remove-parameter" }, closest(selector) {
    if (selector === "button") return this;
    if (selector === "[data-parameter]") return { dataset: { parameter: rapidDestination.id } };
    return null;
  } };
  await handlers.click({ target: removeParameter });
  const rapid = mappingEvents().slice(rapidBefore);
  assert.deepEqual(rapid.map(event => event.action), ["add_parameter", "remove_parameter"], "rapid add/remove retains both accepted configurations without debounce");
  assert.ok(rapid[0].config.config.parameters.some(parameter => parameter.destination === rapidDestination.id));
  assert.ok(!rapid[1].config.config.parameters.some(parameter => parameter.destination === rapidDestination.id));
  assert.equal(rapid[1].previous_revision_id, rapid[0].revision_id);
  assert.equal(playbackEvents().length, 0, "editing while stopped does not count as trying a mapping in playback");
  const state = context.HydraSynthMixer.flush();
  assert.equal(JSON.parse(saved.get("hydra.synth-mixer.v1")).parameters.length, state.parameters.length);
  assert.ok(state.signalLinks, "session exports preserve shared-mix associations");
  const shareButton = { id: "", dataset: { action: "share-mix" }, closest(selector) {
    if (selector === "button") return this;
    if (selector === "[data-bus]") return { dataset: { bus: "mix-a" } };
    return null;
  } };
  await handlers.click({ target: shareButton });
  assert.equal(mappingEvents().at(-1).action, "share");
  assert.ok(mappingEvents().at(-1).config.signalLinks["mix-a"].id, "the recorded configuration includes shared signal relationships");
  context.HydraSynthMixer.activate();
  const activeTimers = [...timers.keys()], initialWrites = configurationWrites, initialRevisions = mappingEvents().length;
  context.HydraSynthMixer.activate();
  assert.equal(configurationWrites, initialWrites, "revisiting unchanged shared signals does not rewrite engine config");
  assert.deepEqual([...timers.keys()], activeTimers, "revisiting Synth keeps its input and UI timers");
  assert.equal(mappingEvents().length, initialRevisions, "revisiting an unchanged shared configuration creates no revision");
  const shared = context.HydraSignalLibrary.getState();
  shared.mixes[0].bus.name = "Edited elsewhere"; shared.mixes[0].revision++;
  context.HydraSignalLibrary.replaceState(shared);
  context.HydraSignalLibrary.create().share({ ...state.buses[0], id: "external", name: "New shared input" }, state.mode);
  context.HydraSynthMixer.activate();
  assert.equal(context.HydraSynthMixer.getState().buses[0].name, "Edited elsewhere", "linked edits are adopted on workspace return");
  assert.match(element("sm-shared-mix").innerHTML, /New shared input/, "newly shared inputs appear on return");
  assert.equal(configurationWrites, initialWrites + 1, "only an actual linked edit updates the engine");
  assert.equal(mappingEvents().at(-1).action, "shared_sync");
  assert.equal(mappingEvents().at(-1).config.config.buses[0].name, "Edited elsewhere");
  assert.equal(mappingEvents().at(-1).config.signalLinks["mix-a"].revision, shared.mixes[0].revision);
  assert.equal(activations, 1, "shared signal refresh cannot restart the input engine");
  assert.equal(transportStops, 0);
  assert.deepEqual([...timers.keys()], activeTimers);
  const playPending = click("sm-play");
  assert.equal(playbackEvents().length, 0, "clicking Play while preparation is pending does not count as actual playback");
  finishStart(); await playPending;
  assert.equal(playbackEvents().at(-1).phase, "start");
  assert.equal(playbackEvents().at(-1).revision_id, mappingEvents().at(-1).revision_id);
  assert.equal(context.HydraSynthMixer.mappingStudyContext().revision_id, mappingEvents().at(-1).revision_id, "real output can link to the active mapping revision");
  const beforeFader = mappingEvents().length;
  for (const value of [66, 67]) { control.valueAsNumber = value; handlers.input({ target: control }); }
  const faderRevisions = mappingEvents().slice(beforeFader);
  assert.deepEqual(faderRevisions.map(event => event.config.config.parameters[0].value), [66, 67], "each accepted slider intermediate is retained");
  assert.deepEqual(playbackEvents().slice(-2).map(event => [event.phase, event.revision_id]),
    faderRevisions.map(event => ["configuration_change", event.revision_id]), "mapping edits during playback link to their precise revision");
  const noChangeEvents = studyEvents.length;
  for (const refresh of timers.values()) refresh();
  assert.equal(mappingEvents().length, beforeFader + 2, "normal input refresh does not create mapping revisions");
  assert.ok(studyEvents.slice(noChangeEvents).every(event => event.type !== "mapping.playback"), "unchanged playback status is deduplicated");
  await click("sm-stop");
  assert.equal(playbackEvents().at(-1).phase, "stop");
  assert.equal(playbackEvents().at(-1).revision_id, faderRevisions.at(-1).revision_id);
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
  shareButton.dataset.action = "detach-mix";
  await handlers.click({ target: shareButton });
  assert.equal(mappingEvents().at(-1).action, "detach_shared");
  assert.deepEqual(mappingEvents().at(-1).config.signalLinks, {}, "making a shared mix independent records the detached relation");
  element("sm-shared-mix").value = context.HydraSignalLibrary.getState().mixes.find(mix => mix.bus.name === "New shared input").id;
  await click("sm-add-shared");
  assert.equal(mappingEvents().at(-1).action, "attach_shared");
  const attached = mappingEvents().at(-1), addedBus = attached.config.config.buses.at(-1);
  assert.equal(attached.config.signalLinks[addedBus.id].id, element("sm-shared-mix").value, "attached definitions and their shared IDs are retained together");
  const beforeRejectedAttach = mappingEvents().length;
  await click("sm-add-shared");
  assert.equal(mappingEvents().length, beforeRejectedAttach, "rejected duplicate shared attachment creates no revision");
  handlers.change({ target: { id: "sm-mode", dataset: {}, value: "demo", closest: () => null, hasAttribute: () => false } });
  assert.equal(mappingEvents().at(-1).action, "mode");
  assert.equal(mappingEvents().at(-1).config.config.mode, "demo");
  assert.deepEqual(mappingEvents().at(-1).config.signalLinks, {}, "changing input mode records the discarded shared links");
  const sourceControl = { id: "", dataset: { sourceField: "rangeMode" }, value: "fixed", hasAttribute: () => false, closest(selector) {
    if (selector === "[data-bus]") return { dataset: { bus: "mix-a" } };
    if (selector === "[data-source]") return { dataset: { source: "0" } };
    return null;
  } };
  handlers.change({ target: sourceControl });
  assert.equal(mappingEvents().at(-1).config.config.buses[0].sources[0].rangeMode, "fixed");
  sourceControl.dataset.sourceField = "inputMin"; sourceControl.valueAsNumber = -2;
  handlers.change({ target: sourceControl });
  assert.equal(mappingEvents().at(-1).config.config.buses[0].sources[0].inputMin, -2);
  const acceptedRange = mappingEvents().length;
  sourceControl.valueAsNumber = 10;
  handlers.change({ target: sourceControl });
  assert.equal(mappingEvents().length, acceptedRange, "a rejected reversed source range is not recorded as an accepted configuration");
  const rangeAction = { id: "", dataset: { action: "freeze" }, closest(selector) { return selector === "button" ? this : sourceControl.closest(selector); } };
  await handlers.click({ target: rangeAction });
  assert.equal(mappingEvents().at(-1).action, "freeze");
  assert.equal(mappingEvents().at(-1).config.config.buses[0].sources[0].rangeMode, "fixed");
  rangeAction.dataset.action = "relearn";
  await handlers.click({ target: rangeAction });
  const firstRelearn = mappingEvents().at(-1).revision_id;
  await handlers.click({ target: rangeAction });
  assert.equal(mappingEvents().at(-1).action, "relearn");
  assert.notEqual(mappingEvents().at(-1).revision_id, firstRelearn, "deliberate range relearning is retained even if its configured values are already reset");

  const skeletonField = (id, name, skeletonLevel) => ({ key: `skeleton|${encodeURIComponent(id)}`, fieldId: id,
    channelId: "skeleton", channelName: "Skeleton", name, optionLabel: name, skeletonLevel,
    kind: ["region", "joint"].includes(skeletonLevel) ? "motion" : "array", reducers: ["value"], default_reducer: "value" });
  connectedFields = [skeletonField("data", "Data", "raw"),
    ...Array.from({ length: 54 }, (_, i) => skeletonField(`skeleton:joint_${Math.floor(i / 3)}:${"xyz"[i % 3]}`, `Joint ${Math.floor(i / 3)} ${"XYZ"[i % 3]}`, "axis")),
    ...Array.from({ length: 18 }, (_, i) => skeletonField(`skeleton:joint_${i}:speed`, `Joint ${i} movement`, "joint")),
    ...["whole_body", "head", "torso", "left_arm", "right_arm", "left_leg", "right_leg"].map(region =>
      skeletonField(`skeleton:region:${region}:speed`, `${region.replaceAll("_", " ")} movement`, "region")),
    { key: "other|data", channelName: "Other input", name: "Data", reducers: ["mean"], default_reducer: "mean" }];
  const simpleControl = (id, value) => ({ id, dataset: {}, value, closest: () => null, hasAttribute: () => false });
  const skeletonView = value => handlers.change({ target: simpleControl("sm-skeleton-detail", value) });
  const skeletonOptions = () => [...element("sm-buses").innerHTML.match(/data-source-field="sourceKey">([\s\S]*?)<\/select>/)[1]
    .matchAll(/<option value="(skeleton\|[^"]+)"/g)].map(match => match[1]);
  context.HydraSynthMixer.activate();
  handlers.change({ target: simpleControl("sm-mode", "shared") });
  assert.equal(element("sm-skeleton-detail-field").hidden, false);
  assert.equal(element("sm-skeleton-detail").value, "region");
  assert.equal(skeletonOptions().length, 7, "the default skeleton picker has seven combined regions");
  assert.match(context.HydraSynthMixer.getState().buses[0].sources[0].sourceKey, /skeleton%3Aregion%3A/,
    "switching into Connections selects from the compact list even when raw and axis fields arrive first");
  assert.match(element("sm-buses").innerHTML, /Skeleton · Movement speed · m\/s/);
  assert.match(element("sm-buses").innerHTML, /<optgroup label="Other input">/, "unrelated channels remain accessible");
  const regionBefore = context.HydraSynthMixer.getState().buses[0].sources[0].sourceKey;
  skeletonView("joint");
  assert.equal(skeletonOptions().length, 19, "the selected region stays visible beside the eighteen joints");
  assert.ok(skeletonOptions().includes(regionBefore));
  skeletonView("axis");
  assert.equal(skeletonOptions().length, 56, "axes, raw array and the selected region all remain available");
  const mappedAxis = connectedFields[1];
  Object.assign(sourceControl, { dataset: { sourceField: "sourceKey" }, value: mappedAxis.key });
  handlers.change({ target: sourceControl });
  const stateBeforeView = JSON.stringify(context.HydraSynthMixer.getState());
  const writesBeforeView = configurationWrites, eventsBeforeView = mappingEvents().length;
  skeletonView("region");
  assert.equal(skeletonOptions().length, 8, "restored or selected axes remain visible when returning to compact view");
  assert.ok(skeletonOptions().includes(mappedAxis.key));
  assert.equal(JSON.stringify(context.HydraSynthMixer.getState()), stateBeforeView);
  assert.equal(configurationWrites, writesBeforeView, "view changes cannot overwrite saved mappings");
  assert.equal(mappingEvents().length, eventsBeforeView, "view changes do not create mapping revisions");
  const addSource = { id: "", dataset: { action: "add-source" }, closest(selector) { return selector === "button" ? this : sourceControl.closest(selector); } };
  await handlers.click({ target: addSource });
  assert.match(context.HydraSynthMixer.getState().buses[0].sources.at(-1).sourceKey, /skeleton%3Aregion%3A/,
    "adding an input uses the compact choices");
  await click("sm-add-bus");
  assert.match(context.HydraSynthMixer.getState().buses.at(-1).sources[0].sourceKey, /skeleton%3Aregion%3A/,
    "adding a mix uses the compact choices");
  handlers.change({ target: simpleControl("sm-mode", "demo") });
  assert.equal(element("sm-skeleton-detail-field").hidden, true, "the extra selector disappears when leaving skeleton input");
  context.HydraSynthMixer.deactivate();
  storageError = true;
  assert.throws(() => context.HydraSynthMixer.flush(), /Storage full/, "session capture cannot silently persist stale state");
  assert.doesNotThrow(() => context.HydraSynthMixer.save(), "periodic preference saving remains tolerant");
  console.log("Synth mixer UI: full catalog, live controls, shared signals, complete mapping revisions and actual playback attribution passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
