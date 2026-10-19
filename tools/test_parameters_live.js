"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
require("../dashboard/drums.js");
require("../dashboard/sonification.js");
require("../dashboard/parameters.js");
require("../dashboard/live.js");
const { HydraParameters: P, HydraSonification: M, HydraLive: L } = globalThis;
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/hydrasynth_parameters.json")));
const summary = P.install(catalog);
assert.equal(summary.total, 1149);
assert.equal(summary.nrpn, 929);
assert.equal(summary.cc, 114);
assert.equal(summary.unavailable, 106);
assert.equal(P.summary, summary);
assert.equal(summary.specification.version, "1.5.0");
const find = (name) => P.entries.find((entry) => entry.kind === "nrpn" && entry.label === name);
const encode = (name, value) => P.encode(find(name), value);
assert.equal(encode("OSC1 Cent", -1).value, 8191);
assert.equal(encode("OSC1 Cent", -4095).value, 4097);
assert.equal(encode("OSC1 Cent", 4096).value, 4096);
assert.equal(encode("OSC1 Semi", -12).value, 116);
assert.equal(encode("OSC2 Semi", -12).value, 244);
assert.equal(encode("Mutator4 Mode", 7).value, 391);
assert.equal(encode("Mutator4 Mode", 100).value, 391);
assert.notEqual(encode("Mutator1 Mode", 1).key, encode("Mutator4 Mode", 1).key);
assert.equal(encode("GlidCurv", -64).value, 0);
assert.equal(encode("GlidCurv", 0).value, 64);
assert.equal(encode("GlidCurv", 64).value, 128);
const bipolar = P.entries.find((entry) => entry.valueSpec.kind === "bipolar");
assert.deepEqual([-128, 0, 128].map((value) => P.encode(bipolar, value).value), [0, 4096, 8192]);
assert.deepEqual([0,127,128,255].map(value => encode("ModMatrix 1 Source", value).value), [128,255,384,511]);
assert.deepEqual([0,127,128,255,256,383].map(value => encode("ModMatrix 1 Target", value).value), [256,383,512,639,640,767]);
assert.notEqual(encode("ModMatrix 1 Source", 0).key, encode("ModMatrix 1 Target", 0).key);
assert.equal(encode("PRE-FX type", 0), null);
assert.equal(encode("ENV5 Loop", 1), null);
assert.equal(P.command({cc: 74}, 127, "nrpn").value, 8192);
assert.equal(P.command({cc: 74}, 127, "cc").value, 127);
assert.equal(P.command(find("Mutator1 Mode"), 3, "cc"), null);
assert.deepEqual(P.messages(encode("Mutator4 Mode", 7)), [[176,99,63],[176,98,33],[176,6,3],[176,38,7]]);
// Every published sound control is exposed even where its CC number has a
// different meaning on generic MIDI devices. NRPN mode uses its ASM equivalent.
for (const [number, name] of [[96, "ENV3 Sustain"], [97, "ENV3 Release"], [120, "ARP Octave"]]) {
  const entry = P.entries.find((item) => item.kind === "cc" && item.number === number);
  assert.equal(entry.label, name);
  assert.equal(entry.unavailable, "");
  assert.deepEqual(P.messages(P.command(entry, 127, "cc")), [[176, number, 127]]);
  assert.equal(P.command(entry, 127, "nrpn").kind, "nrpn");
}
const sustain = P.entries.find((entry) => entry.kind === "cc" && entry.number === 64);
assert.deepEqual(P.messages(P.command(sustain, 127, "nrpn")), [[176, 64, 127]]);
assert.deepEqual(P.messages(P.command(sustain, 0, "cc")), [[176, 64, 0]]);
assert.equal(P.displayValue(find("Mutator4 Mode"), 7), "PhazDiff (7)");
assert.equal(P.displayValue(find("OSC1 Cent"), -12), "-12");
assert.equal(P.displayValue(find("OSC1 Cent"), null), "—");
assert.equal(P.availability(find("Mutator4 Mode"), {output: "audio"}), "MIDI only");
assert.equal(P.availability(find("Mutator4 Mode"), {output: "midi", midiFormat: "cc"}), "Select NRPN in Connections");
assert.equal(P.availability(find("Mutator4 Mode"), {output: "midi", midiFormat: "nrpn"}), "");
assert.equal(P.availability({id: "pitch", min: 0, max: 127}, {output: "audio"}), "");
const futureCC = {id: "future-cc", kind: "cc", number: 2, hardware: true, from: 0};
assert.match(P.availability(futureCC, {output: "midi", midiFormat: "nrpn"}), /select CC/);
assert.equal(P.availability(futureCC, {output: "midi", midiFormat: "cc"}), "");
assert.match(P.availability(find("ENV5 Loop")), /conflicting/);
assert.match(P.availability(find("PRE-FX type")), /effect-type/);
assert.ok(find("Mutator4 Mode").sourcePage > 0);
assert.match(find("Mutator4 Mode").sourceUrl, /Hydrasynth_KB_DR_MIDI_Spec_1.5.0.pdf$/);
// Exercise every enabled entry at boundaries and midpoint, including discrete lists.
for (const entry of P.entries) {
  if (entry.unavailable) { assert.equal(P.encode(entry, 0), null); continue; }
  for (const midiFormat of ["nrpn", "cc"]) {
    assert.equal(Boolean(P.availability(entry, {output: "midi", midiFormat})), !P.command(entry, entry.from, midiFormat),
      `${entry.label} must explain why its selected MIDI format cannot send it`);
  }
  for (const value of [entry.min, (entry.min + entry.max) / 2, entry.max]) {
    const command = P.encode(entry, value);
    assert.ok(Number.isInteger(command.value));
    for (const [status, number, data] of P.messages(command)) {
      assert.equal(status, 176); assert.ok(number >= 0 && number <= 127); assert.ok(data >= 0 && data <= 127);
    }
    if (entry.valueSpec.kind === "selected_byte") assert.equal(command.value >> 7, entry.selector);
  }
}
// A busy stream replaces queued values without starving later destinations.
const pacer = new P.Pacer(), bytes = [];
let commands = Array.from({length: 300}, (_, i) => ({key: `nrpn:${i}`, kind: "nrpn", number: i, value: 1}));
pacer.update(commands);
assert.equal(pacer.flush(b => bytes.push(b), 2).length, 2);
commands = commands.map(item => ({...item, value: 2})); pacer.update(commands);
const next = pacer.flush(b => bytes.push(b), 1)[0];
assert.equal(next.number, 2); assert.equal(next.value, 2);
assert.equal(bytes.length, 12);
const done = pacer.flush(() => {}, 300);
assert.equal(done.length, 299);
pacer.update(commands); assert.equal(pacer.pending.size, 0);
pacer.update([{...commands[0], value: 3}]); assert.equal(pacer.pending.size, 1);
pacer.update([]); assert.equal(pacer.pending.size, 0);
pacer.reset(); pacer.update(commands); assert.equal(pacer.pending.size, 300);
// Real RAPP shapes: status, labelled joints and neural tensor reductions.
const live = new L.Stream();
assert.equal(live.ingest({channel: "__status__", msg: "connected"}, 0), false);
live.ingest({channel: "robot_joint_states", shape: [2], labels: ["joint_1", "joint_2"], data: [-1, 2], velocity: [0, 3]}, 100);
assert.equal(live.fields.length, 4);
const source = {sourceKey: "robot_joint_states|data%3A0", reducer: "value", index: 0, weight: 1};
assert.equal(live.read(source, 100).normalized, 0.5);
live.ingest({channel: "robot_joint_states", labels: ["joint_1", "joint_2"], data: [1, 2]}, 200);
assert.equal(live.read(source, 200).normalized, 1);
assert.equal(live.read({...source, rangeMode: "fixed", inputMin: -2, inputMax: 2}, 200).normalized, .75);
assert.equal(live.read(source, 3201), null, "old values cannot keep playback going");
live.ingest({channel: "activations", tensors: {hidden: {shape: [2,2], data: [[1,2],[3,4]]}}}, 4000);
const tensor = {sourceKey: "activations|tensor%3Ahidden", reducer: "mean", index: 0};
assert.equal(live.read(tensor, 4000).value, 2.5);
assert.equal(live.read({...tensor, reducer: "rms"}, 4000).value, Math.sqrt(7.5));
assert.equal(live.read({...tensor, reducer: "index", index: 2}, 4000).value, 3);
assert.equal(live.read(source, 4000), null, "fresh unrelated channels cannot hide a stale source");
assert.equal(L.reduce([1,NaN,3], "index", 1), null);
assert.equal(L.reduce([1,NaN,3], "mean"), 2);
assert.equal(live.ingest({channel: "bad", data: ["x"]}, 4100), true);
assert.equal(live.read({sourceKey: "bad|data", reducer: "mean", index: 0}, 4100), null);
const invalidBefore = live.invalid;
live.ingest({channel: "oversized", data: new Array(262145).fill(0)}, 4200);
assert.equal(live.invalid, invalidBefore + 1);
live.resetRanges(); assert.equal(live.samples.size, 0);
// Each mapping input learns independently, including peaks between playback ticks.
const calibrated = new L.Stream();
const firstInput = { sourceKey: "sensor|data", reducer: "mean", index: 0, rangeMode: "auto" };
const secondInput = { ...firstInput };
calibrated.ingest({ channel: "sensor", data: [10] }, 100);
assert.equal(calibrated.read(firstInput, 100).normalized, 0.5);
calibrated.read(secondInput, 100);
const reduceValue = calibrated.valueFor.bind(calibrated);
let reductions = 0;
calibrated.valueFor = (...args) => { reductions++; return reduceValue(...args); };
calibrated.ingest({ channel: "sensor", data: [80] }, 200);
assert.equal(reductions, 1, "duplicate input mappings reduce a tensor only once per incoming frame");
calibrated.valueFor = reduceValue;
calibrated.ingest({ channel: "sensor", data: [30] }, 300);
assert.deepEqual(calibrated.getRange(firstInput), { minimum: 10, maximum: 80 });
assert.equal(calibrated.read(firstInput, 300).normalized, 2 / 7);
calibrated.resetRange(firstInput);
assert.equal(calibrated.read(firstInput, 300).normalized, 0.5);
assert.deepEqual(calibrated.getRange(firstInput), { minimum: 30, maximum: 30 });
assert.deepEqual(calibrated.getRange(secondInput), { minimum: 10, maximum: 80 }, "relearn must leave other inputs alone");
Object.assign(secondInput, { rangeMode: "fixed", inputMin: 10, inputMax: 80 });
calibrated.ingest({ channel: "sensor", data: [100] }, 400);
assert.equal(calibrated.read(secondInput, 400).normalized, 1, "fixed ranges clamp outliers");
assert.deepEqual(calibrated.getRange(secondInput), { minimum: 10, maximum: 80 }, "frozen input ranges must stop expanding");
assert.deepEqual(calibrated.getRange(firstInput), { minimum: 30, maximum: 100 });
calibrated.ingest({ channel: "sensor", data: ["bad", null] }, 500);
assert.equal(calibrated.read(firstInput, 500), null);
assert.deepEqual(calibrated.getRange(firstInput), { minimum: 30, maximum: 100 }, "invalid samples cannot poison learning");
calibrated.ingest({ channel: "sensor", data: [-1000] }, 200);
assert.equal(calibrated.read(firstInput, 500), null, "out-of-order frames cannot replace the current sample");
assert.equal(calibrated.read(firstInput, 4000), null);
assert.deepEqual(calibrated.getRange(firstInput), { minimum: 30, maximum: 100 }, "stale reads cannot change learned bounds");
calibrated.ingest({ channel: "sensor", data: [2, 6] }, 4100);
firstInput.reducer = "maximum";
assert.equal(calibrated.read(firstInput, 4100).normalized, 0.5);
assert.deepEqual(calibrated.getRange(firstInput), { minimum: 6, maximum: 6 }, "changing the reducer starts a new input range");
firstInput.reducer = "index"; firstInput.index = 0;
assert.equal(calibrated.read(firstInput, 4100).value, 2);
firstInput.index = 1;
assert.deepEqual(calibrated.getRange(firstInput), null);
assert.equal(calibrated.read(firstInput, 4100).value, 6);
assert.deepEqual(calibrated.getRange(firstInput), { minimum: 6, maximum: 6 });
// A preset keeps independent targets and missing live sources through a round trip.
const mappings = [{sources: [source], operator: "direct", targets: [
  {destination: "pitch", minimum: 40, maximum: 90, curve: "inverse", enabled: true},
  {destination: find("Mutator4 Mode").id, minimum: 1, maximum: 7, curve: "steps", enabled: false}
]}];
let id = 0;
const restored = M.restoreMappings(mappings, [], () => ++id, {allowMissing: true});
assert.equal(restored.length, 1); assert.equal(restored[0].targets.length, 2);
assert.equal(restored[0].targets[1].enabled, false);
assert.equal(restored[0].sources[0].sourceKey, source.sourceKey);
const exported = JSON.parse(JSON.stringify({format: "hydra-signal-lab-presets", version: 1, presets: [{name: "Full engine", mappings: restored}]}));
const imported = M.parsePresetFile(exported)[0];
assert.deepEqual(imported.mappings[0].targets, restored[0].targets);
imported.mappings[0].targets[0].minimum = 0;
assert.equal(restored[0].targets[0].minimum, 40);
exported.presets[0].mappings[0].targets = new Array(65).fill(mappings[0].targets[0]);
assert.throws(() => M.parsePresetFile(exported), /64/);
console.log("parameter encoding, MIDI pacing, live RAPP data and multi-target preset tests: ok");
