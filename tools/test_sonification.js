"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/drums.js"), "utf8"), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/sonification.js"), "utf8"), context);
const Music = context.HydraSonification;
const plain = (value) => JSON.parse(JSON.stringify(value));
const fields = Array.from({ length: 12 }, (_, i) => ({ key: `joints|data:${i}`, reducers: ["value"], default_reducer: "value" }));
fields.push({ key: "activations|tensor:energy", reducers: ["mean", "rms", "minimum", "maximum", "index"], default_reducer: "mean" });
let nextId = 1;
const allocateId = () => nextId++;
const seeded = (seed) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };

for (const style of ["balanced", "rhythmic", "wild"]) {
  for (let seed = 0; seed < 40; seed++) {
    const generated = Music.randomMappings(fields, 27, style, seeded(seed));
    assert.equal(generated.length, 27);
    assert.equal(new Set(generated.map((mapping) => mapping.destination)).size, 27);
    assert.deepEqual(plain(generated), plain(Music.randomMappings(fields, 27, style, seeded(seed))));
    for (const mapping of generated) {
      const target = Music.DESTINATIONS.find((item) => item.id === mapping.destination);
      assert.ok(mapping.minimum >= target.min && mapping.maximum <= target.max);
      assert.ok(mapping.sources.length >= 1 && mapping.sources.length <= 6);
      for (const source of mapping.sources) {
        const field = fields.find((item) => item.key === source.sourceKey);
        assert.ok(field && field.reducers.includes(source.reducer));
      }
    }
  }
  const generated = Music.randomMappings(fields, 8, style, seeded(9));
  assert.ok(generated.some((item) => item.destination === "pitch"));
  assert.ok(generated.some((item) => item.destination === "density"));
}
assert.equal(Music.randomMappings([], 12).length, 0);
assert.equal(Music.randomMappings(fields, 999).length, 27);

const generated = Music.randomMappings(fields, 18, "rhythmic", seeded(41));
generated[0].sources[0].weight = 0;
const oldSaved = { controls: { tempo: 133, swing: 42 }, mappingsByRecording: { robot: generated } };
const migrated = Music.restoreWorkspace(oldSaved, "robot", fields, allocateId, () => []);
assert.equal(migrated.tabs[0].name, "Original");
assert.equal(migrated.tabs[0].mappings.length, 18);
assert.equal(migrated.tabs[0].mappings[0].sources[0].weight, 0);
assert.equal(migrated.tabs[0].controls.tempo, 133);
const snapshot = Music.serializeTab(migrated.tabs[0]);
assert.ok(!("id" in snapshot.mappings[0]));
const copyBefore = JSON.stringify(snapshot);
migrated.tabs[0].mappings[0].sources[0].weight = 9;
assert.equal(JSON.stringify(snapshot), copyBefore, "presets must not change when the working tab is edited");
const saved = { workspaces: { robot: { activeIndex: 1, tabs: [snapshot, { name: "Silence", mappings: [], controls: { density: 0, tempo: 71 } }] } } };
const reloaded = Music.restoreWorkspace(JSON.parse(JSON.stringify(saved)), "robot", fields, allocateId, () => generated);
assert.equal(reloaded.activeIndex, 1);
assert.equal(reloaded.tabs[1].mappings.length, 0, "empty tabs stay empty across reloads");
assert.equal(reloaded.tabs[1].controls.density, 0);
assert.equal(reloaded.tabs[0].controls.tempo, 133);
assert.equal(reloaded.tabs[1].controls.tempo, 71);

const incompatible = [{ ...generated[0], sources: [{ sourceKey: fields[0].key }, { sourceKey: "missing" }] }];
assert.equal(Music.restoreMappings(incompatible, fields, allocateId).length, 0, "do not silently remove ingredients from composite presets");
const invalid = [{ destination: "unknown" }, null, { ...generated[0], minimum: NaN, maximum: Infinity }];
const sanitized = Music.restoreMappings(invalid, fields, allocateId);
assert.equal(sanitized.length, 1);
assert.ok(Number.isFinite(sanitized[0].minimum) && Number.isFinite(sanitized[0].maximum));
const exportFile = { format: "hydra-signal-lab-presets", version: 1, presets: [{ ...snapshot, recording: "Robot" }] };
const imported = Music.parsePresetFile(JSON.parse(JSON.stringify(exportFile)));
assert.deepEqual(plain(imported[0].mappings), plain(snapshot.mappings));
assert.deepEqual(plain(imported[0].controls), plain(snapshot.controls));
assert.throws(() => Music.parsePresetFile({ format: "another app", presets: [] }));
assert.throws(() => Music.parsePresetFile({ ...exportFile, presets: [{ mappings: "broken" }] }));
assert.throws(() => Music.parsePresetFile({ ...exportFile, presets: Array(65).fill(snapshot) }));

for (let hits = 0; hits <= 16; hits++) {
  for (let rotation = 0; rotation < 16; rotation++) {
    assert.equal(Music.rhythmPattern(hits, rotation).filter(Boolean).length, hits);
  }
}
assert.deepEqual(plain(Music.rhythmPattern(4, 0)), Array.from({ length: 16 }, (_, i) => i % 4 === 0));
assert.deepEqual(plain(Music.rhythmPattern(4, 1)), Array.from({ length: 16 }, (_, i) => i % 4 === 1));
const rhythm = { ...Music.DEFAULT_CONTROLS, tempo: 120, stepsPerBeat: 4, swing: 40,
  ratchet: 3, velocity: 100, gate: 80, chance: 100 };
const even = Music.rhythmStep(rhythm, 0, () => 0);
const odd = Music.rhythmStep(rhythm, 1, () => 0);
assert.equal(even.interval, 175);
assert.equal(odd.interval, 75);
assert.equal(even.interval + odd.interval, 250, "swing must preserve the duration of a pair of steps");
assert.equal(even.notes.length, 3);
assert.ok(odd.notes[0].velocity < even.notes[0].velocity);
for (const note of even.notes) assert.ok(note.offset + note.duration < even.interval);
assert.equal(Music.rhythmStep({ ...rhythm, density: 0 }, 0, () => 0).notes.length, 0);
assert.equal(Music.rhythmStep({ ...rhythm, chance: 0 }, 0, () => 0).notes.length, 0);
assert.equal(Music.rhythmStep({ ...rhythm, chance: 20 }, 0, () => 0.5).notes.length, 0);
for (const tempo of [20, 240]) {
  for (const stepsPerBeat of [1, 8]) {
    const plan = Music.rhythmStep({ ...rhythm, tempo, stepsPerBeat, swing: 65, ratchet: 4 }, 1, () => 0);
    assert.ok(Number.isFinite(plan.interval) && plan.interval > 0);
    plan.notes.forEach((note) => {
      assert.ok(note.duration > 0 && note.offset + note.duration <= plan.interval);
      assert.ok(note.velocity >= 1 && note.velocity <= 127);
    });
  }
}

// Chords remain in the selected scale and MIDI range even at register extremes.
assert.deepEqual(plain(Music.chordNotes(60, { scaleName: "major", voices: 3 })), [60, 64, 67]);
assert.deepEqual(plain(Music.chordNotes(60, { scaleName: "major", voices: 3, inversion: 1 })), [64, 67, 72]);
assert.deepEqual(plain(Music.chordNotes(60, { scaleName: "major", voices: 3, spread: 1 })), [60, 67, 76]);
const roots = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
for (const [scaleName, scale] of Object.entries(Music.SCALE_INTERVALS)) {
  for (const scaleRoot of roots) for (const pitch of [0, 1, 36, 60, 96, 126, 127]) {
    for (const voices of [1, 3, 8]) for (const voicing of ["thirds", "fourths", "octaves"]) {
      for (const inversion of [0, 3, 7]) for (const spread of [0, 1, 2]) {
        const notes = Music.chordNotes(pitch, { scaleName, scaleRoot, voices, voicing, inversion, spread });
        assert.equal(notes.length, voices);
        assert.equal(new Set(notes).size, voices);
        assert.ok(notes.every((note) => Number.isInteger(note) && note >= 0 && note <= 127));
        assert.ok(notes.every((note) => scale.includes((note - roots.indexOf(scaleRoot) + 12) % 12)));
      }
    }
  }
}
const palette = Music.patchPool({ patchList: "a1, B017; H128 a001" });
assert.deepEqual(plain(palette), [{ bank: "A", number: 1 }, { bank: "B", number: 17 }, { bank: "H", number: 128 }]);
for (const patchList of ["", "A000", "A129", "I001", "A1 Boops", "1", "A-1", Array(33).fill("A001").join(",")]) {
  assert.throws(() => Music.patchPool({ patchList }));
}
assert.equal(Music.controls().patchPool, "all", "MIDI exploration defaults to the whole instrument");
const allPatches = Music.patchPool({ patchPool: "all" });
assert.equal(allPatches.length, 1024);
assert.deepEqual(plain(allPatches.at(-1)), { bank: "H", number: 128 });
assert.equal(Music.soundIndex("mapped", 4, -1, 0), 0);
assert.equal(Music.soundIndex("mapped", 4, -1, 100), 3);
assert.equal(Music.soundIndex("cycle", 4, 3), 0);
for (let previous = 0; previous < 6; previous++) for (let i = 0; i < 100; i++) {
  const index = Music.soundIndex("random", 6, previous, 0, seeded(i));
  assert.ok(index >= 0 && index < 6 && index !== previous);
}
const soundSettings = Music.controls({ voices: 8, inversion: 3, spread: 2, voicing: "fourths", previewVoice: "bell",
  soundMode: "mapped", soundEvery: 64, patchPool: "shortlist", patchList: "C012, H128", patchBank: "H", patchNumber: 128 });
const soundPreset = Music.serializeTab({ name: "Harmony", controls: soundSettings, mappings: generated });
assert.deepEqual(plain(Music.parsePresetFile({ ...exportFile, presets: [soundPreset] })[0].controls), plain(soundSettings));
console.log("sonification presets, generation, rhythm, harmony and sound palette tests: ok");
