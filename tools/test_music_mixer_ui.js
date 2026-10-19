"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const copy = (value) => JSON.parse(JSON.stringify(value));

// Recordings reuse a joint label for its position and velocity. Exercise the
// rendered picker and real UI handlers without audio, a browser, or paid calls.
const fields = ["position", "velocity"].flatMap((kind) => [1, 2].map((joint) => ({
  key: `robot_joint_states|${kind === "position" ? "data" : "velocity"}%3A${joint - 1}`,
  channelName: "Robot joint states", channelId: "robot_joint_states",
  fieldId: `${kind === "position" ? "data" : "velocity"}:${joint - 1}`,
  label: `joint_${joint}`, name: `joint_${joint} ${kind}`, kind,
  reducers: ["value"], default_reducer: "value"
})));
fields.push({ key: "activations|tensor%3Ahidden", channelName: "Activations", name: "hidden_layer",
  kind: "tensor", reducers: ["mean", "rms", "minimum", "maximum", "index"], default_reducer: "mean" });

const elements = new Map(), handlers = {}, routes = [];
function element(id) {
  if (!elements.has(id)) elements.set(id, { value: "", textContent: "", innerHTML: "",
    classList: { toggle() {} } });
  return elements.get(id);
}
const root = {
  classList: { add() {} },
  querySelector: (selector) => element(selector.slice(4)),
  querySelectorAll: (selector) => selector === "[data-route]" ? routes : [],
  addEventListener: (type, callback) => { handlers[type] = callback; }
};
let config, onUpdate, onGenerationUpdate, generationOptions, promptChanges = 0;
const generationCalls = [];
const sharedStorage = new Map();
let activations = 0, configurationWrites = 0, refreshRequests = 0;
const savedRap = { text: "Earlier voice draft", experiment_id: "saved-voice", pending: { request_id: "pending-voice", variants: ["flash", "robot"] },
  legacy_rap: { text: "Earlier rap", render_id: "saved-rap" } };
let savedWorkspace = { rap: copy(savedRap), config: { mode: "shared", buses: [{ id: "mix-a", name: "Mix A", operator: "average",
  sources: [{ sourceKey: fields[0].key, reducer: "value", rangeMode: "auto" }] }], channels: [{ name: "master", level: 0.8,
  pan: 0, cutoff: 20000, highpass: 20, reverbMix: 0, delayMix: 0, pitch: 0, rate: 1, muted: false,
  routes: [{ busId: "mix-a", target: "cutoff", outputMin: 80, outputMax: 20000, invert: false, strength: 1 }] },
  { name: "Bass", level: 1, pan: 0, cutoff: 20000, highpass: 20, reverbMix: 0, delayMix: 0, pitch: 0, rate: 1,
    routes: [], muted: false }] } };
const planRequests = [];
const context = vm.createContext({
  AbortController,
  performance: { now: () => 0 },
  localStorage: {
    getItem: key => key === "hydra.signal-library.v1" ? sharedStorage.get(key) || null : JSON.stringify(savedWorkspace),
    setItem(key, value) { if (key === "hydra.signal-library.v1") sharedStorage.set(key, value); else savedWorkspace = JSON.parse(value); }
  },
  HydraElevenLabs: { originalPlanRequest: (duration, settings) => { planRequests.push(copy(settings)); return { kind: "original", duration_seconds: Number(duration), settings }; } },
  HydraRap: { create() { throw new Error("Music mixer must not mount a rap player"); } },
  HydraMusicMixerVoice: { create() { throw new Error("Music mixer must not mount a voice player"); } },
  HydraMusicMixerGeneration: { create: (options) => { generationOptions = options; onGenerationUpdate = options.onUpdate; return {
    update() {}, settingsChanged() { promptChanges++; }, stop() { generationCalls.push("stop"); },
    startNew() { generationCalls.push("startNew"); }, resume() { generationCalls.push("resume"); }
  }; } },
  HydraMusicMixerEngine: {
    validateConfig: copy,
    instrumentalStems: () => [],
    create(options) {
      onUpdate = options.onUpdate;
      return { setConfig: (value) => { configurationWrites++; config = copy(value); }, getConfig: () => copy(config),
        activate() { activations++; }, snapshot: () => ({ fields, buses: [], channels: [], running: true }) };
    }
  },
  fetch: () => { refreshRequests++; throw new Error("No network in UI tests"); }
});
for (const file of ["elevenlabs-realtime.js", "signal-library.js", "music-mixer.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard", file), "utf8"), context, { filename: file });
}
context.HydraMusicMixer.init({ container: root });
assert.doesNotMatch(root.innerHTML, /id="mm-(?:rap|legacy-rap)/, "rap controls live in their own workspace");
assert.deepEqual(copy(context.HydraMusicMixer.getState().rap), savedRap);
assert.equal(element("next-mode").value, "new", "older saved workspaces default to Generate new");
assert.match(root.innerHTML, /id="mm-next-mode" data-next-field/);
assert.match(root.innerHTML, />Loop<.*>Generate similar<.*>Generate new<.*>Choose old</);
assert.deepEqual(copy(generationOptions.getNextTrack()), { mode: "new", trackId: "" });
assert.equal(element("next-track-field").hidden, true);
assert.equal(generationOptions.getSettings().continuity_mode, "fresh");
assert.equal(planRequests.at(-1).continuity_mode, undefined, "continuation controls are excluded from the original-plan settings validator");
onUpdate({ fields, buses: [], channels: [] });

const labels = [...element("buses").innerHTML.matchAll(/<option value="robot_joint_states[^>]+>(.*?)<\/option>/g)].map((match) => match[1]);
assert.deepEqual(labels, ["Joint 1 · Position", "Joint 2 · Position", "Joint 1 · Velocity", "Joint 2 · Velocity"]);
assert.match(element("buses").innerHTML, /<optgroup label="Robot joint states">/);
assert.match(element("buses").innerHTML, /<optgroup label="Activations">/);
assert.match(element("buses").innerHTML, /Robot joint states · Direct value/);
assert.match(element("buses").innerHTML, />Single input<\/p>/);
assert.match(element("buses").innerHTML, /data-operator disabled/);
assert.doesNotMatch(element("buses").innerHTML, /combined signal history/);

const routeCaption = element("route-caption");
routes.push({ querySelector: (selector) => selector === "[data-route-source]" ? routeCaption : { value: "mix-a" } });
const strengthOutput = element("strength-output");
function routeControl(dataset, value, channel = "master") {
  return { dataset, value, attributes: {},
    hasAttribute: () => false,
    setAttribute(name, next) { this.attributes[name] = next; },
    closest(selector) {
      if (selector === "button") return this;
      if (selector === "[data-channel]") return { dataset: { channel } };
      if (selector === "[data-route]") return { dataset: { route: "0" } };
      if (selector === ".mm-strength") return { querySelector: () => strengthOutput };
      return null;
    }
  };
}
assert.match(element("channels").innerHTML, /Signal strength <output data-strength-value>100%<\/output>/);
assert.match(element("channels").innerHTML, /type="range" min="0" max="100" step="1" value="100" data-route-field="strength"/);
const strips = () => [...element("channels").innerHTML.matchAll(/<article\b[\s\S]*?<\/article>/g)].map(([html]) => html);
assert.match(strips()[0], /Pitch shift <output data-control-value="pitch">0 st<\/output>/);
assert.match(strips()[0], /Playback speed <output data-control-value="rate">100%<\/output>/);
assert.match(strips()[0], /min="-12" max="12" step="0.1" value="0" data-channel-field="pitch"/);
assert.match(strips()[0], /min="0.75" max="1.25" step="0.01" value="1" data-channel-field="rate"/);
assert.match(strips()[1], /data-channel-field="pitch"/);
assert.doesNotMatch(strips()[1], /data-channel-field="rate"/);
assert.doesNotMatch(element("channels").innerHTML, /Speed \+ pitch/);
function manualControl(key, value, channel = "master") {
  return { dataset: { channelField: key }, value, hasAttribute: () => false,
    closest(selector) {
      if (selector === "[data-channel]") return { dataset: { channel }, querySelector: () => element(`manual-${channel}-${key}`) };
      return null;
    }
  };
}
handlers.input({ target: manualControl("pitch", "7") });
handlers.input({ target: manualControl("rate", "0.9") });
handlers.input({ target: manualControl("pitch", "-3.5", "Bass") });
assert.equal(config.channels[0].pitch, 7);
assert.equal(config.channels[0].rate, 0.9);
assert.equal(config.channels[1].pitch, -3.5);
assert.equal(config.channels[1].rate, 1);
assert.equal(element("manual-master-pitch").textContent, "+7 st");
assert.equal(element("manual-master-rate").textContent, "90%");
assert.equal(element("manual-Bass-pitch").textContent, "-3.5 st");
assert.equal(savedWorkspace.config.channels[0].pitch, 7);
assert.equal(savedWorkspace.config.channels[0].rate, 0.9);
assert.equal(savedWorkspace.config.channels[1].pitch, -3.5);
const channelHTML = element("channels").innerHTML;
const strengthSlider = routeControl({ routeField: "strength" }, "37");
handlers.input({ target: strengthSlider });
assert.equal(config.channels[0].routes[0].strength, 0.37, "dragging immediately changes the engine's mapping strength");
assert.equal(strengthOutput.textContent, "37%");
assert.equal(strengthSlider.attributes["aria-valuetext"], "37%");
assert.equal(element("channels").innerHTML, channelHTML, "dragging preserves the slider and its focus");
assert.equal(savedWorkspace.config.channels[0].routes[0].strength, 1, "persistence waits for the completed slider change");
handlers.change({ target: strengthSlider });
assert.equal(savedWorkspace.config.channels[0].routes[0].strength, 0.37);
assert.equal(element("channels").innerHTML, channelHTML, "finishing a slider edit also preserves focus");
strengthSlider.value = "0";
handlers.input({ target: strengthSlider });
assert.equal(config.channels[0].routes[0].strength, 0, "zero strength is a valid manual-setting option");
assert.equal(strengthOutput.textContent, "0%");
strengthSlider.value = "100";
handlers.input({ target: strengthSlider });
assert.equal(config.channels[0].routes[0].strength, 1);
assert.equal(strengthOutput.textContent, "100%");
handlers.change({ target: routeControl({ routeField: "strength" }, "24") });
assert.equal(savedWorkspace.config.channels[0].routes[0].strength, 0.24, "a change event alone applies and persists the percentage");
handlers.click({ target: routeControl({ action: "add-route" }) });
assert.equal(config.channels[0].routes[1].strength, 1, "new effect mappings start at full strength");
assert.match(element("channels").innerHTML, /Signal strength <output data-strength-value>24%<\/output>/);
for (let index = 0; index < 8; index++) handlers.click({ target: routeControl({ action: "add-route" }) });
assert.equal(config.channels[0].routes.length, 9, "every master effect can be mapped at once");
assert.ok(config.channels[0].routes.some((mapping) => mapping.target === "pitch"));
assert.ok(config.channels[0].routes.some((mapping) => mapping.target === "rate"));
assert.match(strips()[0], /data-action="add-route" disabled/);
for (let index = 0; index < 9; index++) handlers.click({ target: routeControl({ action: "add-route" }, undefined, "Bass") });
assert.equal(config.channels[1].routes.length, 8);
assert.ok(config.channels[1].routes.some((mapping) => mapping.target === "pitch"));
assert.ok(!config.channels[1].routes.some((mapping) => mapping.target === "rate"));
assert.match(strips()[1], /data-action="add-route" disabled/);
assert.doesNotMatch(strips()[1], /<option value="rate"/);
function busControl(dataset, value, attributes = []) {
  return { dataset, value,
    hasAttribute: (name) => attributes.includes(name),
    closest(selector) {
      if (selector === "button") return this;
      if (selector === "[data-bus]") return { dataset: { bus: "mix-a" } };
      if (selector === "[data-source]") return { dataset: { source: "0" } };
      return null;
    }
  };
}
handlers.click({ target: busControl({ action: "add-source" }) });
assert.equal(config.buses[0].sources.length, 2);
assert.match(element("buses").innerHTML, />2 inputs · Average<\/p>/);
assert.doesNotMatch(element("buses").innerHTML, /data-operator disabled/);
assert.equal(routeCaption.textContent, "2 inputs · Average");

handlers.change({ target: busControl({}, "difference", ["data-operator"]) });
assert.match(element("buses").innerHTML, />2 inputs · Difference<\/p>/);
assert.equal(routeCaption.textContent, "2 inputs · Difference");
handlers.click({ target: busControl({ action: "remove-source" }) });
assert.match(element("buses").innerHTML, />Single input<\/p>/);
assert.equal(routeCaption.textContent, "Joint 2 · Position");

handlers.change({ target: busControl({ sourceField: "sourceKey" }, fields[2].key) });
assert.equal(config.buses[0].sources[0].sourceKey, fields[2].key, "visible names must preserve the exact velocity source key");
assert.equal(routeCaption.textContent, "Joint 1 · Velocity");
handlers.change({ target: busControl({ sourceField: "sourceKey" }, fields[4].key) });
assert.match(element("buses").innerHTML, /Activations · Average/);
assert.match(element("buses").innerHTML, /value="mean" selected>Average<\/option>/);
handlers.change({ target: busControl({ sourceField: "reducer" }, "rms") });
assert.equal(config.buses[0].sources[0].reducer, "rms", "friendly read modes must keep the reducer API value");
assert.match(element("buses").innerHTML, /Activations · RMS magnitude/);

// Live descriptors omit label, but must render the same joint/type names.
onUpdate({ fields: fields.slice(0, 4).map(({ label, ...field }) => field), buses: [], channels: [] });
assert.match(element("buses").innerHTML, />Joint 1 · Velocity<\/option>/);

// Editing any creation field notifies the automatic queue without a separate submit.
handlers.input({ target: busControl({}, "new direction", ["data-prompt-field"]) });
handlers.change({ target: busControl({}, "40", ["data-prompt-field"]) });
assert.equal(promptChanges, 2);
onUpdate({ fields, buses: [], channels: [], running: true });
onGenerationUpdate({ phase: "ready", enabled: true, queuedId: "next", nextPrompt: "Bright instrumental piano" });
assert.match(element("next").textContent, /automatic crossfade/);
assert.equal(element("next-prompt").textContent, "Bright instrumental piano");
assert.equal(element("up-next").hidden, false);
onGenerationUpdate({ phase: "waiting-prompt", enabled: true, error: "Enter a requested key." });
assert.equal(element("notice").textContent, "Enter a requested key.");
onGenerationUpdate({ phase: "generating-next", enabled: true, nextPrompt: "Quiet strings" });
assert.equal(element("notice").hidden, true, "fixing a draft clears its validation message automatically");

function nextControl(id, value) {
  element(id).value = value;
  handlers.change({ target: { id: `mm-${id}`, value, hasAttribute: (name) => name === "data-next-field" } });
}
nextControl("next-mode", "similar");
assert.equal(promptChanges, 3, "mode changes invalidate the automatic track queue");
assert.equal(savedWorkspace.prompt.next_mode, "similar");
assert.equal(savedWorkspace.prompt.continuity_mode, "evolve");
assert.equal(generationOptions.getSettings().continuity_mode, "evolve");
assert.equal(generationOptions.getNextTrack().mode, "similar");
assert.equal(planRequests.at(-1).continuity_mode, undefined);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/music-mixer.js"), "utf8"), context);
context.HydraMusicMixer.init({ container: root });
assert.equal(element("next-mode").value, "similar", "an explicit next-track choice survives save/reload");
assert.equal(generationOptions.getSettings().continuity_mode, "evolve");
assert.equal(config.channels[0].routes[0].strength, 0.24, "saved route strength survives reloading the mixer");
assert.equal(config.channels[0].pitch, 7, "manual pitch survives a mixer reload");
assert.equal(config.channels[0].rate, 0.9);
assert.equal(config.channels[1].pitch, -3.5);
assert.match(element("channels").innerHTML, /Signal strength <output data-strength-value>24%<\/output>/);

nextControl("next-mode", "old");
assert.equal(element("next-track-field").hidden, false);
assert.equal(element("generate").textContent, "Play selected track");
assert.equal(element("generate").disabled, true, "Choose old needs an explicit saved track");
assert.equal(generationOptions.getSettings().continuity_mode, "fresh");
generationOptions.onTrack({ id: "old-a", state: "complete", requested_duration_seconds: 60,
  generation_settings: { style: "Piano memories" } });
assert.match(element("next-track").innerHTML, /Piano memories/);
assert.equal(element("next-track").value, "", "loading recent tracks does not choose one automatically");
nextControl("next-track", "old-a");
assert.equal(element("generate").disabled, false);
onGenerationUpdate({ phase: "idle", enabled: false, busy: true });
assert.equal(element("generate").disabled, false, "retired provider work does not block playback of saved music");
onGenerationUpdate({ phase: "loading-saved", enabled: true, busy: true, savedBusy: false });
assert.equal(element("generate").disabled, false, "pending saved-track intent must not lock playback when no saved request has started");
onGenerationUpdate({ phase: "loading-saved", enabled: true, busy: true, savedBusy: true });
assert.equal(element("generate").disabled, true, "the selected track is already loading");
onGenerationUpdate({ phase: "idle", enabled: false, busy: false });
assert.deepEqual(copy(generationOptions.getNextTrack()), { mode: "old", trackId: "old-a" });
assert.equal(savedWorkspace.prompt.next_track_id, "old-a");
assert.deepEqual(generationCalls, [], "choosing a future track only updates the queue, without stopping or recalling");
assert.equal(promptChanges, 5);
handlers.click({ target: { id: "mm-generate", closest() { return this; } } });
assert.deepEqual(generationCalls, ["startNew"], "explicit Play selected track delegates to the coordinator");
onUpdate({ fields, buses: [], channels: [], running: true });
onGenerationUpdate({ phase: "loading-saved", enabled: true, nextMode: "old", selectedTrackId: "old-a" });
assert.equal(element("next").textContent, "Loading selected track…");
assert.match(element("next-prompt").textContent, /Piano memories/);
assert.equal(element("up-next").hidden, false);
onGenerationUpdate({ phase: "waiting-track", enabled: true });
assert.equal(element("next").textContent, "Choose a saved track");

// Restoring an unavailable old choice preserves its ID; it must never select
// the first available recording or start playback on reload.
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/music-mixer.js"), "utf8"), context);
context.HydraMusicMixer.init({ container: root });
assert.equal(element("next-mode").value, "old");
assert.equal(element("next-track").value, "old-a");
assert.match(element("next-track").innerHTML, /Saved track unavailable/);
generationOptions.onTrack({ id: "old-b", state: "complete", requested_duration_seconds: 20 });
assert.equal(element("next-track").value, "old-a");
assert.match(element("next-track").innerHTML, /Saved track unavailable/);
assert.deepEqual(generationCalls, ["startNew"]);
nextControl("next-mode", "loop");
assert.equal(element("next-track-field").hidden, true);
assert.equal(element("generate").textContent, "Create starting track");
assert.equal(generationOptions.getNextTrack().trackId, "old-a", "a saved choice remains available when switching modes");
onUpdate({ fields, buses: [], channels: [], track: { id: "old-b", requested_duration_seconds: 20 } });
assert.equal(element("generate").textContent, "Play current track");
onGenerationUpdate({ phase: "idle", enabled: false, busy: true });
assert.equal(element("generate").disabled, false, "retired provider work does not block looping the current music");
onGenerationUpdate({ phase: "looping", enabled: true });
assert.equal(element("next").textContent, "Repeating current track");
assert.equal(element("up-next").hidden, true);

delete savedWorkspace.prompt.next_mode;
savedWorkspace.prompt.continuity_mode = "evolve";
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/music-mixer.js"), "utf8"), context);
context.HydraMusicMixer.init({ container: root });
assert.equal(element("next-mode").value, "similar", "legacy Evolve migrates to Generate similar");
assert.equal(generationOptions.getSettings().continuity_mode, "evolve");

handlers.click({ target: busControl({ action: "share-mix" }) });
context.HydraMusicMixer.activate();
const initialWrites = configurationWrites, initialRequests = refreshRequests;
const generationBeforeReturn = [...generationCalls];
context.HydraMusicMixer.activate();
assert.equal(configurationWrites, initialWrites, "returning with unchanged shared signals leaves engine config intact");
const shared = context.HydraSignalLibrary.getState();
shared.mixes[0].bus.name = "Edited in Synth"; shared.mixes[0].revision++;
context.HydraSignalLibrary.replaceState(shared);
context.HydraSignalLibrary.create().share({ ...config.buses[0], id: "external", name: "New shared input" }, config.mode);
context.HydraMusicMixer.activate();
assert.equal(config.buses[0].name, "Edited in Synth", "returning to Music mixer adopts linked signal edits");
assert.match(element("shared-mix").innerHTML, /New shared input/);
assert.equal(configurationWrites, initialWrites + 1, "only the changed linked definition updates the engine");
assert.equal(activations, 1, "returning cannot restart the music input engine");
assert.equal(refreshRequests, initialRequests, "returning cannot recall or refresh the playing track");
assert.deepEqual(generationCalls, generationBeforeReturn, "signal sync preserves automatic generation state");
context.HydraMusicMixer.flush();
assert.deepEqual(savedWorkspace.rap, savedRap, "saving music settings retains earlier voice drafts and pending request references");

console.log("Music mixer UI: distinct inputs, saved mapping strength, next-track choices, shared signal refresh and preserved voice drafts without embedded rap passed.");
