"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const storage = new Map(); let writes = 0, failStorage = false;
const context = vm.createContext({ localStorage: {
  getItem: (key) => storage.get(key) || null,
  setItem(key, value) { if (failStorage) throw new Error("Storage full"); writes++; storage.set(key, value); }
} });
for (const name of ["elevenlabs-realtime.js", "signal-library.js"])
  vm.runInContext(fs.readFileSync(`${__dirname}/../dashboard/${name}`, "utf8"), context);
const api = context.HydraSignalLibrary;
const plain = (value) => JSON.parse(JSON.stringify(value));
const bus = (id, name = "Motion") => ({ id, name, operator: "weighted", sources: [
  { sourceKey: "motion:joint_1:position", reducer: "mean", rangeMode: "auto", weight: 2, learnedMin: 10, learnedMax: 30 },
  { sourceKey: "motion:joint_2:velocity", reducer: "rms", rangeMode: "fixed", inputMin: 0, inputMax: 80, weight: 1 }
] });
const synth = { mode: "shared", buses: [bus("synth-a")], parameters: [{ destination: "cutoff", busId: "synth-a" }] };
const music = { mode: "shared", buses: [bus("music-a", "Independent")], channels: [{ routes: [{ busId: "music-a", target: "pan" }] }] };
const a = api.create(), b = api.create();
const entry = a.share(synth.buses[0], synth.mode);
assert.equal(api.getState().mixes.length, 1);
assert.equal(a.linkFor("synth-a").id, entry.id);
b.attach(entry.id, music, "music-shared");
assert.throws(() => b.attach(entry.id, music, "music-duplicate"), /already in this workspace/,
  "a shared definition cannot have two competing live copies in one workspace");
assert.equal(music.buses[1].id, "music-shared");
assert.equal(music.buses[1].sources[1].sourceKey, synth.buses[0].sources[1].sourceKey);
assert.equal(music.channels[0].routes[0].busId, "music-a", "adding a shared mix preserves independent mappings");
music.channels[0].routes.push({ busId: "music-shared", target: "cutoff" });
let before = writes;
synth.buses[0].sources[0].learnedMin = -200;
a.publish(synth);
assert.equal(writes, before, "passive calibration never republishes or feeds back");
synth.buses[0].name = "Body motion"; synth.buses[0].sources[1].inputMax = 120;
a.publish(synth);
assert.equal(api.getState().mixes[0].revision, 2);
assert.equal(b.sync(music), true);
assert.equal(music.buses[1].name, "Body motion");
assert.equal(music.buses[1].sources[1].inputMax, 120);
assert.equal(music.buses[1].id, "music-shared");
assert.equal(music.channels[0].routes[1].busId, "music-shared", "updates preserve existing destination references");
assert.equal(b.sync(music), false, "unchanged revisions do not reset engines");
Object.assign(synth.buses[0].sources[0], { rangeMode: "fixed", inputMin: -200, inputMax: 30 });
a.publish(synth); b.sync(music);
assert.equal(music.buses[1].sources[0].rangeMode, "fixed", "freezing a learned range updates linked definitions");
assert.equal(music.buses[1].sources[0].inputMin, -200);
Object.assign(synth.buses[0].sources[0], { rangeMode: "auto", learnedMin: null, learnedMax: null, awaitingBounds: true });
a.publish(synth); b.sync(music);
assert.equal(music.buses[1].sources[0].rangeMode, "auto", "learning again releases a shared fixed range");
const restored = api.create(plain(b.getLinks()));
music.buses[1].operator = "maximum"; restored.publish(music);
a.sync(synth); assert.equal(synth.buses[0].operator, "maximum", "edits can flow in either direction after reload");
restored.detach("music-shared");
music.buses[1].name = "My private version"; restored.publish(music);
assert.equal(api.getState().mixes[0].bus.name, "Body motion");
synth.buses[0].name = "New shared name"; a.publish(synth); restored.sync(music);
assert.equal(music.buses[1].name, "My private version", "detached copies remain independent");
assert.throws(() => b.attach(entry.id, { mode: "demo", buses: [] }, "demo"), /Connections input/, "demo signals cannot silently read Connections definitions");
const wrongMode = api.create(a.getLinks());
wrongMode.sync({ mode: "demo", buses: [bus("synth-a")] });
assert.equal(wrongMode.linkFor("synth-a"), null);
before = api.getState().mixes[0].revision;
synth.buses[0].operator = "minimum"; failStorage = true;
assert.throws(() => a.publish(synth), /Storage full/);
assert.equal(a.linkFor("synth-a").revision, before, "failed writes keep retryable metadata");
failStorage = false; a.publish(synth);
assert.equal(api.getState().mixes[0].revision, before + 1);
const savedLibrary = api.exportState();
api.replaceState({ mixes: [] }); assert.equal(api.getState().mixes.length, 0);
api.replaceState(savedLibrary); assert.equal(api.getState().mixes[0].bus.operator, "minimum", "session state restores shared definitions");
const corrupt = api.create(JSON.parse('{"__proto__":{"id":"abc"},"fine":{"id":"constructor"}}'));
assert.deepEqual(plain(corrupt.getLinks()), {});
storage.set(api.KEY, "invalid-json"); assert.deepEqual(plain(api.getState()), { version: 1, mixes: [] });
console.log("Shared signal library tests passed");
