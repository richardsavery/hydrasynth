"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createMappingTracker } = require("../dashboard/study-recorder.js");
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
let engineSnapshot = { fields, buses: [], channels: [], running: false };
let stopOnNextConfig = false;
const studyEvents = [];
const studyRecorder = {
  getContext: () => ({ session_id: "participant-a", client_id: "music-client" }),
  emit(type, payload) { studyEvents.push({ type, payload: copy(payload) }); return `event-${studyEvents.length}`; }
};
const mappingConfigurations = () => studyEvents.filter(event => event.type === "mapping.configuration").map(event => event.payload);
const mappingPlaybacks = () => studyEvents.filter(event => event.type === "mapping.playback").map(event => event.payload);
function pushSnapshot(next) { engineSnapshot = copy(next); onUpdate(next); }
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
  HydraStudy: { emit: studyRecorder.emit, createMappingTracker: workspace => createMappingTracker(studyRecorder, workspace) },
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
      engineSnapshot = { fields, buses: [], channels: [], running: false };
      onUpdate = options.onUpdate;
      return { setConfig: (value) => {
        configurationWrites++; config = copy(value); engineSnapshot = { ...engineSnapshot, channels: copy(config.channels) };
        if (stopOnNextConfig) { engineSnapshot.running = false; stopOnNextConfig = false; }
        onUpdate(copy(engineSnapshot));
      }, getConfig: () => copy(config),
        freeze(busId, sourceIndex) {
          const source = config.buses.find(bus => bus.id === busId)?.sources[sourceIndex];
          if (!Number.isFinite(source?.learnedMin) || !Number.isFinite(source?.learnedMax)) return false;
          Object.assign(source, { rangeMode: "fixed", inputMin: source.learnedMin, inputMax: source.learnedMax }); onUpdate(copy(engineSnapshot)); return true;
        },
        relearn(busId, sourceIndex) {
          const source = config.buses.find(bus => bus.id === busId)?.sources[sourceIndex];
          if (!source) return false;
          Object.assign(source, { rangeMode: "auto", learnedMin: null, learnedMax: null }); onUpdate(copy(engineSnapshot)); return true;
        },
        activate() { activations++; }, snapshot: () => copy(engineSnapshot) };
    }
  },
  fetch: () => { refreshRequests++; throw new Error("No network in UI tests"); }
});
for (const file of ["elevenlabs-realtime.js", "signal-library.js", "music-mixer.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard", file), "utf8"), context, { filename: file });
}
context.HydraMusicMixer.init({ container: root });
assert.equal(mappingConfigurations().length, 1, "restoration records the normalized baseline immediately");
assert.equal(mappingConfigurations()[0].workspace, "music-mixer");
assert.equal(mappingConfigurations()[0].reason, "restored");
assert.deepEqual(mappingConfigurations()[0].config.config, copy(config));
assert.deepEqual(mappingPlaybacks(), [], "configuring a stopped mixer is not evidence of playback");
assert.doesNotMatch(root.innerHTML, /id="mm-(?:rap|legacy-rap)/, "rap controls live in their own workspace");
assert.deepEqual(copy(context.HydraMusicMixer.getState().rap), savedRap);
assert.equal(element("next-mode").value, "new", "older saved workspaces default to Generate new");
assert.match(root.innerHTML, /id="mm-next-mode" data-next-field/);
assert.match(root.innerHTML, />Loop<.*>Generate similar<.*>Generate new<.*>Choose old</);
assert.deepEqual(copy(generationOptions.getNextTrack()), { mode: "new", trackId: "" });
assert.equal(element("next-track-field").hidden, true);
assert.equal(generationOptions.getSettings().continuity_mode, "fresh");
assert.equal(planRequests.at(-1).continuity_mode, undefined, "continuation controls are excluded from the original-plan settings validator");
pushSnapshot({ fields, buses: [], channels: [] });

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
function routeControl(dataset, value, channel = "master", routeIndex = 0) {
  return { dataset, value, attributes: {},
    hasAttribute: () => false,
    setAttribute(name, next) { this.attributes[name] = next; },
    closest(selector) {
      if (selector === "button") return this;
      if (selector === "[data-channel]") return { dataset: { channel } };
      if (selector === "[data-route]") return { dataset: { route: String(routeIndex) } };
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
assert.equal(mappingConfigurations().at(-1).config.config.channels[0].routes[0].strength, 0.37, "intermediate slider values are recorded before persistence or a periodic snapshot");
const strengthRevision = mappingConfigurations().at(-1).revision_id;
assert.equal(strengthOutput.textContent, "37%");
assert.equal(strengthSlider.attributes["aria-valuetext"], "37%");
assert.equal(element("channels").innerHTML, channelHTML, "dragging preserves the slider and its focus");
assert.equal(savedWorkspace.config.channels[0].routes[0].strength, 1, "persistence waits for the completed slider change");
handlers.change({ target: strengthSlider });
assert.equal(mappingConfigurations().at(-1).revision_id, strengthRevision, "the same input/change value creates only one configuration revision");
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
const rapidStart = mappingConfigurations().length;
handlers.click({ target: routeControl({ action: "add-route" }) });
handlers.click({ target: routeControl({ action: "remove-route" }, undefined, "master", 1) });
const rapid = mappingConfigurations().slice(rapidStart);
assert.equal(rapid.length, 2, "a mapping added and removed before the next snapshot retains both complete revisions");
assert.equal(rapid[0].config.config.channels[0].routes.length, 2);
assert.equal(rapid[1].config.config.channels[0].routes.length, 1);
assert.equal(rapid[1].previous_revision_id, rapid[0].revision_id);
assert.deepEqual(mappingPlaybacks(), [], "all pre-play edits remain configured-only, rather than counted as played mappings");
handlers.click({ target: routeControl({ action: "add-route" }) });
assert.equal(config.channels[0].routes[1].strength, 1, "new effect mappings start at full strength");
assert.match(element("channels").innerHTML, /Signal strength <output data-strength-value>24%<\/output>/);
for (let index = 0; index < 8; index++) handlers.click({ target: routeControl({ action: "add-route" }) });
assert.equal(config.channels[0].routes.length, 9, "every master effect can be mapped at once");
assert.ok(config.channels[0].routes.some((mapping) => mapping.target === "pitch"));
assert.ok(config.channels[0].routes.some((mapping) => mapping.target === "rate"));
assert.match(strips()[0], /data-action="add-route" disabled/);
const beforeRejected = mappingConfigurations().length;
handlers.click({ target: routeControl({ action: "add-route" }) });
handlers.change({ target: routeControl({ routeField: "target" }, "gain") });
assert.equal(mappingConfigurations().length, beforeRejected, "a full channel and a duplicate effect rejection produce no accepted revision");
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
pushSnapshot({ fields: fields.slice(0, 4).map(({ label, ...field }) => field), buses: [], channels: [] });
assert.match(element("buses").innerHTML, />Joint 1 · Velocity<\/option>/);

// Editing any creation field notifies the automatic queue without a separate submit.
handlers.input({ target: busControl({}, "new direction", ["data-prompt-field"]) });
handlers.change({ target: busControl({}, "40", ["data-prompt-field"]) });
assert.equal(promptChanges, 2);
pushSnapshot({ fields, buses: [], channels: [], running: true });
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
pushSnapshot({ fields, buses: [], channels: [], running: true });
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
pushSnapshot({ fields, buses: [], channels: [], track: { id: "old-b", requested_duration_seconds: 20 } });
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
assert.ok(mappingConfigurations().at(-1).config.signalLinks["mix-a"], "sharing captures the exact persistent link relationship");
context.HydraMusicMixer.activate();
const initialWrites = configurationWrites, initialRequests = refreshRequests;
const generationBeforeReturn = [...generationCalls];
context.HydraMusicMixer.activate();
assert.equal(configurationWrites, initialWrites, "returning with unchanged shared signals leaves engine config intact");
const beforeSharedUpdate = mappingConfigurations().length;
const shared = context.HydraSignalLibrary.getState();
shared.mixes[0].bus.name = "Edited in Synth"; shared.mixes[0].revision++;
context.HydraSignalLibrary.replaceState(shared);
context.HydraSignalLibrary.create().share({ ...config.buses[0], id: "external", name: "New shared input" }, config.mode);
context.HydraMusicMixer.activate();
assert.equal(config.buses[0].name, "Edited in Synth", "returning to Music mixer adopts linked signal edits");
assert.equal(mappingConfigurations().length, beforeSharedUpdate + 1);
assert.equal(mappingConfigurations().at(-1).reason, "shared_synchronized");
assert.equal(mappingConfigurations().at(-1).config.config.buses[0].name, "Edited in Synth");
assert.match(element("shared-mix").innerHTML, /New shared input/);
assert.equal(configurationWrites, initialWrites + 1, "only the changed linked definition updates the engine");
assert.equal(activations, 1, "returning cannot restart the music input engine");
assert.equal(refreshRequests, initialRequests, "returning cannot recall or refresh the playing track");
assert.deepEqual(generationCalls, generationBeforeReturn, "signal sync preserves automatic generation state");
context.HydraMusicMixer.flush();
assert.deepEqual(savedWorkspace.rap, savedRap, "saving music settings retains earlier voice drafts and pending request references");

// Study history links only running audio, including configuration edits made
// during playback, and does not manufacture trials from periodic engine ticks.
const beforePlay = mappingPlaybacks().length;
pushSnapshot({ fields, buses: [], channels: [], running: true, sourceValid: true });
assert.equal(mappingPlaybacks().length, beforePlay + 1);
assert.equal(mappingPlaybacks().at(-1).phase, "start");
assert.equal(mappingPlaybacks().at(-1).revision_id, mappingConfigurations().at(-1).revision_id);
const playingRevision = mappingConfigurations().at(-1).revision_id;
handlers.input({ target: routeControl({ routeField: "strength" }, "42") });
assert.notEqual(mappingConfigurations().at(-1).revision_id, playingRevision);
assert.equal(mappingPlaybacks().at(-1).phase, "configuration_change");
assert.equal(mappingPlaybacks().at(-1).revision_id, mappingConfigurations().at(-1).revision_id);
const output = studyEvents.filter(event => event.type === "music.output.controls").at(-1).payload;
assert.equal(output.mapping_revision_id, mappingConfigurations().at(-1).revision_id, "the synchronous engine output receives the new revision, not the previous one");
const beforeTicks = mappingConfigurations().length, beforeTickPlayback = mappingPlaybacks().length;
for (let index = 1; index <= 5; index++) {
  config.buses[0].sources[0].learnedMin = -index;
  config.buses[0].sources[0].learnedMax = index;
  pushSnapshot({ fields, buses: [], channels: [], running: true, sourceValid: true, position: index });
}
assert.equal(mappingConfigurations().length, beforeTicks, "automatic range learning and playback ticks do not create user trials");
assert.equal(mappingPlaybacks().length, beforeTickPlayback, "clock-only updates do not duplicate played configuration associations");
handlers.input({ target: routeControl({ routeField: "strength" }, "42") });
assert.equal(mappingConfigurations().length, beforeTicks, "a no-op slider edit does not become a new trial because learned bounds advanced");
handlers.click({ target: busControl({ action: "freeze" }) });
assert.equal(mappingConfigurations().at(-1).reason, "range_frozen");
assert.equal(mappingConfigurations().at(-1).config.config.buses[0].sources[0].inputMin, -5);
handlers.click({ target: busControl({ action: "relearn" }) });
assert.equal(mappingConfigurations().at(-1).reason, "range_relearned");
assert.equal(mappingConfigurations().at(-1).config.config.buses[0].sources[0].learnedMin, null);
const beforeFailedFreeze = mappingConfigurations().length;
handlers.click({ target: busControl({ action: "freeze" }) });
assert.equal(mappingConfigurations().length, beforeFailedFreeze, "freezing without valid learned bounds is not an accepted configuration");
stopOnNextConfig = true;
handlers.input({ target: routeControl({ routeField: "strength" }, "43") });
const stoppedDuringMutation = mappingConfigurations().at(-1);
assert.equal(stoppedDuringMutation.config.config.channels[0].routes[0].strength, 0.43);
assert.ok(!mappingPlaybacks().some(event => event.running && event.revision_id === stoppedDuringMutation.revision_id),
  "a synchronous stopped callback closes the prior playback before capturing an unplayed new revision");
pushSnapshot({ fields, buses: [], channels: [], running: false, sourceValid: true });
assert.equal(mappingPlaybacks().at(-1).phase, "stop");
const beforeIdleEdit = mappingPlaybacks().length;
handlers.input({ target: routeControl({ routeField: "strength" }, "44") });
assert.equal(mappingPlaybacks().length, beforeIdleEdit, "edits after stopping do not create a played trial");
context.HydraMusicMixer.flush();
const storedLinks = copy(savedWorkspace.signalLinks);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/music-mixer.js"), "utf8"), context);
context.HydraMusicMixer.init({ container: root });
assert.equal(mappingConfigurations().at(-1).reason, "restored");
assert.deepEqual(mappingConfigurations().at(-1).config.signalLinks, storedLinks, "a restored revision contains its shared mix relationships");
const externalMix = context.HydraSignalLibrary.getState().mixes.find(entry => entry.bus.name === "New shared input");
element("shared-mix").value = externalMix.id;
const attachButton = { id: "mm-add-shared", closest(selector) { return selector === "button" ? this : null; } };
handlers.click({ target: attachButton });
assert.equal(mappingConfigurations().at(-1).reason, "shared_added");
assert.equal(Object.keys(mappingConfigurations().at(-1).config.signalLinks).length, 2);
const beforeDuplicateAttach = mappingConfigurations().length;
handlers.click({ target: attachButton });
assert.equal(mappingConfigurations().length, beforeDuplicateAttach, "rejected shared-mix duplicates do not create a trial");
handlers.click({ target: busControl({ action: "detach-mix" }) });
assert.equal(mappingConfigurations().at(-1).reason, "shared_detached");
assert.equal(mappingConfigurations().at(-1).config.signalLinks["mix-a"], undefined);

// Track promotion updates the available channel configuration before output is
// attributed, without emitting the superseded pre-normalization snapshot.
context.HydraMusicMixerEngine.instrumentalStems = stems => stems || [];
context.HydraMusicMixerEngine.defaultChannel = name => ({ ...copy(config.channels[0]), name, routes: [] });
const beforePromotion = studyEvents.filter(event => event.type === "music.output.controls").length;
pushSnapshot({ fields, buses: [], channels: [], running: true, sourceValid: true,
  track: { id: "promoted-track", stems: [{ name: "Drums" }] } });
assert.equal(mappingConfigurations().at(-1).reason, "track_channels_changed");
assert.deepEqual(mappingConfigurations().at(-1).config.config.channels.map(channel => channel.name), ["master", "Drums"]);
const promotionOutputs = studyEvents.filter(event => event.type === "music.output.controls").slice(beforePromotion);
assert.equal(promotionOutputs.length, 1, "only the final normalized track snapshot is recorded");
assert.equal(promotionOutputs[0].payload.mapping_revision_id, mappingConfigurations().at(-1).revision_id);
assert.deepEqual(promotionOutputs[0].payload.channels.map(channel => channel.name), ["master", "Drums"]);
assert.deepEqual(studyEvents.filter(event => event.type === "recording.mapping_error"), []);

// Study failures must never prevent accepted mixer edits or saved preferences.
context.HydraStudy = { createMappingTracker() { throw new Error("storage unavailable"); } };
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/music-mixer.js"), "utf8"), context);
context.HydraMusicMixer.init({ container: root });
handlers.input({ target: routeControl({ routeField: "strength" }, "55") });
assert.equal(config.channels[0].routes[0].strength, 0.55);
context.HydraMusicMixer.flush();
assert.equal(savedWorkspace.config.channels[0].routes[0].strength, 0.55);

console.log("Music mixer UI: inputs, saved controls, next-track choices, shared signal refresh, immutable mapping history, playback attribution and recorder failure isolation passed.");
