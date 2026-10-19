"use strict";

// Exercise legacy configuration saves and output association without hardware.
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const { createMappingTracker } = require("../dashboard/study-recorder.js");
const events = [];
let session = "participant-one", storageFails = false;
const study = {
  getContext: () => ({ session_id: session, client_id: "browser-one" }),
  emit(type, payload) { events.push({ type, payload: JSON.parse(JSON.stringify(payload)) }); return String(events.length); }
};
study.createMappingTracker = workspace => createMappingTracker(study, workspace);
const box = vm.createContext({ console, Intl, URLSearchParams, HydraStudy: study,
  document: { addEventListener() {} }, window: {}, performance: { now: () => 100 },
  localStorage: { getItem: () => null, setItem() { if (storageFails) throw new Error("Unavailable"); } }
});
for (const file of ["drums.js", "sonification.js", "drum-workspace.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(`${__dirname}/../dashboard/${file}`, "utf8"), box, { filename: file });
}
vm.runInContext(`
  readMusicalControls = () => Music.controls();
  effectivePreviewVoice = () => ({ name: "Test voice" });
  flushSignalLabActivity = () => {};
  dom["workspace-status"] = {};
  state.workspaceView = "synth-legacy";
  globalThis.api = { state, saveSettings, mappingPlaybackStudy, publishSignalLabActivity };
`, box);
const { state, saveSettings, mappingPlaybackStudy, publishSignalLabActivity } = box.api;
const configs = () => events.filter(event => event.type === "mapping.configuration");
const playback = () => events.filter(event => event.type === "mapping.playback");
const mapping = { id: 1, operator: "direct", sources: [{ sourceKey: "hand|position", reducer: "mean", rangeMode: "fixed", inputMin: 0, inputMax: 1 }],
  targets: [{ destination: "pitch", minimum: 48, maximum: 72, curve: "linear", enabled: true }] };

assert.equal(saveSettings(), true);
state.mappings.push(mapping); saveSettings();
state.mappings.splice(0, 1); saveSettings();
assert.deepEqual(configs().map(event => event.payload.config.mappings.length), [0, 1, 0], "rapid add/remove saves retain both configurations");
assert.equal(playback().length, 0, "configuration edits do not imply playback");
saveSettings();
assert.equal(configs().length, 3, "repeated save does not inflate distinct revisions");

state.mappings.push(mapping); saveSettings();
state.playbackWorkspace = "synth-legacy"; state.playing = true;
const started = mappingPlaybackStudy(true, "started");
assert.equal(playback().at(-1).payload.running, true);
mapping.targets[0].maximum = 84; saveSettings();
const edited = configs().at(-1).payload;
assert.notEqual(edited.revision_id, started.revision_id);
assert.equal(playback().at(-1).payload.revision_id, edited.revision_id, "an applied edit while playing is associated with playback");
publishSignalLabActivity({ notes: [60] });
assert.equal(events.findLast(event => event.type === "synth.output").payload.mapping_revision_id, edited.revision_id);
assert.equal(configs().at(-2).payload.config.mappings[0].targets[0].maximum, 72, "later edits cannot change earlier history");

mappingPlaybackStudy(false, "stopped"); state.playing = false;
const playedCount = playback().length;
mapping.targets[0].maximum = 96; storageFails = true;
assert.equal(saveSettings(), false);
assert.equal(configs().at(-1).payload.config.mappings[0].targets[0].maximum, 96, "session-only edits are retained even when settings storage fails");
assert.equal(playback().length, playedCount, "stopped edits are not labelled played");
storageFails = false;
session = "participant-two"; state.playing = true;
const second = mappingPlaybackStudy(true, "output");
assert.equal(second.session_id, session);
assert.equal(configs().at(-1).payload.previous_revision_id, null, "handover starts an independent revision chain");
assert.equal(playback().at(-1).payload.session_id, session);

box.HydraSynthMixer = { mappingStudyContext: () => ({ revision_id: "mixer-revision" }) };
state.playbackWorkspace = "synth-mixer";
publishSignalLabActivity({ notes: [64] });
assert.equal(events.findLast(event => event.type === "synth.output").payload.mapping_revision_id, "mixer-revision", "modern synth output uses its independent mapping history");
console.log("Study legacy mappings: rapid changes, playback association, stopped edits, immutable history, storage failure and participant handover passed.");
