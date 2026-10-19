"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const fixed = (sourceKey, extra = {}) => ({ sourceKey, reducer: "value", rangeMode: "fixed", inputMin: 0, inputMax: 100, weight: 1, ...extra });
const bus = (id, sources, operator = "average") => ({ id, name: id, sources, operator });

function harness(options = {}) {
  let at = 0, timerId = 0, revision = 1;
  let fields = [{ key: "a", name: "A" }, { key: "b", name: "B" }];
  const timers = new Map(), samples = { a: 20, b: 80 }, reads = [], preparations = [], rangeResets = [], resets = [], updates = [], errors = [];
  const context = vm.createContext({ performance: { now: () => at },
    setInterval(callback, delay) { assert.equal(delay, 100); const id = ++timerId; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); } });
  for (const name of ["sonification.js", "parameters.js", "elevenlabs-realtime.js", "music-mixer-engine.js", "synth-mixer-engine.js"])
    vm.runInContext(fs.readFileSync(`${__dirname}/../dashboard/${name}`, "utf8"), context);
  let destinations = [...context.HydraSonification.DESTINATIONS];
  const sourceBridge = {
    describe: () => ({ mode: "live", revision, fields, label: "Live input" }),
    async prepare(sources) { preparations.push(sources); await options.prepare?.(sources); },
    read(source, time) { reads.push(source); const value = samples[source.sourceKey]; return typeof value === "number" ? { value, at: time } : value || null; },
    resetRange(source) { rangeResets.push(source); }, reset() { resets.push(at); }
  };
  const library = context.HydraSynthMixerEngine;
  const engine = library.create({ sourceBridge, getDestinations: () => destinations,
    onUpdate(state) { updates.push(state); options.onUpdate?.(state); }, onError: (error) => errors.push(error) });
  const parameter = (id, extra = {}) => ({ ...library.defaultParameter(id), ...extra });
  return { engine, library, parameter, timers, samples, reads, preparations, rangeResets, resets, updates, errors, context,
    setFields(value) { fields = value; }, bumpRevision() { revision++; },
    addDestination(value) { destinations.push(value); },
    async tick(time = at + 100) { at = time; for (const callback of [...timers.values()]) callback(); await settle(); } };
}

async function main() {
  {
    const h = harness(), e = h.engine, initial = e.getConfig();
    assert.equal(initial.controls.previewVoice, "warm");
    assert.equal(initial.controls.waveType, "sawtooth");
    assert.equal(initial.controls.attack, 35);
    assert.equal(initial.controls.loop, true);
    assert.equal(initial.buses[0].sources[0].sourceKey, "__unassigned");
    assert.equal(initial.buses[0].sources[0].rangeMode, "auto");
    assert.deepEqual(plain(e.evaluate()), { values: [
      { destination: "pitch", value: 60 }, { destination: "velocity", value: 96 },
      { destination: "cutoff", value: 82 }, { destination: "resonance", value: 42 }, { destination: "reverb", value: 64 }
    ], valid: true }, "manual parameters work without a connected or mapped input");
    e.activate(); await settle();
    assert.equal(e.snapshot().sourceValid, true);
    assert.equal(h.preparations.length, 0, "unassigned input does not request data");
    assert.equal(h.timers.size, 1);
    e.deactivate(); assert.equal(h.timers.size, 0);
  }
  {
    const { library } = harness();
    const old = library.validateConfig({ parameters: [
      { destination: "reverb", value: 20, minimum: 0, maximum: 116 },
      { destination: "cutoff", value: 78, minimum: 35, maximum: 90 }
    ] });
    assert.deepEqual([old.parameters[0].value, old.parameters[0].minimum, old.parameters[0].maximum], [64, 0, 127]);
    assert.deepEqual([old.parameters[1].value, old.parameters[1].minimum, old.parameters[1].maximum], [78, 35, 90], "custom settings survive the default upgrade");
    Object.assign(old.parameters[0], { value: 20, minimum: 0, maximum: 116 });
    assert.equal(library.validateConfig(old).parameters[0].value, 20, "users can choose the previous settings after the one-time upgrade");
    for (const id of ["cutoff", "resonance", "drive", "delay", "reverb"]) {
      const effect = library.defaultParameter(id);
      assert.deepEqual([effect.minimum, effect.maximum], [0, 127], "new synth effect mappings use the full control range");
    }
  }
  {
    const { library } = harness();
    assert.equal(library.defaultParameter("cutoff").strength, 1);
    for (const [input, expected] of [[undefined, 1], [null, 1], ["0.5", 1], [NaN, 1], [Infinity, 1], [-0.2, 0], [1.2, 1], [0, 0], [0.5, 0.5], [1, 1]]) {
      const validated = library.validateConfig({ parameters: [{ destination: "cutoff", strength: input }] });
      assert.equal(validated.parameters[0].strength, expected, `strength ${input} is validated`);
      assert.equal(library.validateConfig(plain(validated)).parameters[0].strength, expected, "strength survives saved configuration validation");
    }
  }
  {
    const h = harness(), e = h.engine;
    e.setConfig({ buses: [bus("mix", [fixed("a")])], parameters: [
      h.parameter("cutoff", { value: 80, busId: "mix", minimum: 0, maximum: 100 }),
      h.parameter("reverb", { value: 60, busId: "mix", minimum: 0, maximum: 100, invert: true }),
      h.parameter("pitch", { value: 60, busId: "mix", minimum: 48, maximum: 76 })
    ] });
    e.activate(); await settle();
    for (const strength of [0, 0.5, 1]) {
      const config = e.getConfig(); for (const parameter of config.parameters) parameter.strength = strength;
      e.setConfig(config);
      const result = Object.fromEntries(e.evaluate().values.map(({ destination, value }) => [destination, value]));
      assert.equal(result.cutoff, 80 - 60 * strength);
      assert.equal(result.reverb, 60 + 20 * strength, "reversed modulation blends from the manual value");
      assert.equal(result.pitch, Math.round(60 + strength * (53.6 - 60)));
      assert.equal(e.getConfig().parameters[0].strength, strength);
    }
    let config = e.getConfig();
    Object.assign(config.parameters[0], { minimum: 100, maximum: 0, strength: 0.5, curve: "exponential", value: 20 });
    config.parameters[2].strength = 0.25; e.setConfig(config);
    assert.equal(e.evaluate().values[0].value, 58, "strength applies after the curve and descending output range");
    assert.equal(e.evaluate().values[2].value, 58, "pitch is quantized after strength blending, without premature note rounding");
    h.samples.a = null; await h.tick();
    assert.equal(e.evaluate().valid, false, "partial strength retains missing-input gating");
    config = e.getConfig(); for (const parameter of config.parameters) { parameter.strength = 0; parameter.busId = "deleted"; }
    e.setConfig(config);
    assert.deepEqual(plain(e.evaluate()), { values: [
      { destination: "cutoff", value: 20 }, { destination: "reverb", value: 60 }, { destination: "pitch", value: 60 }
    ], valid: true }, "zero-strength routes remain manual even with a deleted input mix");
    e.deactivate();
    assert.equal(e.evaluate().valid, true, "inactive input is unnecessary when strength is zero");
  }
  {
    const h = harness(), e = h.engine, parameter = h.parameter;
    e.setConfig({ buses: [bus("mix", [fixed("a"), fixed("b", { weight: 3 })], "weighted")], parameters: [
      parameter("cutoff", { busId: "mix", minimum: 0, maximum: 100 }),
      parameter("reverb", { busId: "mix", minimum: 0, maximum: 100, invert: true }),
      parameter("pitch", { value: 72 })
    ] });
    e.activate(); await settle();
    const values = Object.fromEntries(e.evaluate().values.map((value) => [value.destination, value.value]));
    assert.ok(Math.abs(values.cutoff - 65) < 1e-9);
    assert.ok(Math.abs(values.reverb - 35) < 1e-9);
    assert.equal(values.pitch, 72);
    assert.equal(e.evaluate().valid, true);
    assert.equal(h.preparations.length, 1);
    let next = e.getConfig(); next.buses[0].operator = "difference"; e.setConfig(next);
    assert.ok(Math.abs(e.snapshot().buses[0].value - 0.2) < 1e-9);
    for (const [curve, expected] of [["linear", 20], ["smooth", 10.4], ["exponential", 4], ["inverse", 80], ["steps", 25], ["threshold", 0]]) {
      next = e.getConfig(); next.parameters[0].curve = curve; e.setConfig(next);
      assert.ok(Math.abs(e.evaluate().values[0].value - expected) < 1e-9, curve);
    }
    next = e.getConfig(); next.parameters[0] = parameter("cutoff", { busId: "mix", minimum: 100, maximum: 0 }); e.setConfig(next);
    assert.ok(Math.abs(e.evaluate().values[0].value - 80) < 1e-9, "descending ranges are intentional");
    assert.equal(h.preparations.length, 1, "parameter and operator edits do not restart the input");
    h.samples.b = null; await h.tick();
    assert.equal(e.evaluate().valid, false, "a missing ingredient gates every destination using the mix");
    assert.deepEqual(plain(e.evaluate().values), [{ destination: "pitch", value: 72 }]);
    assert.equal(e.snapshot().parameters[0].effectiveValue, null);
    next = e.getConfig(); next.parameters[0].enabled = false; next.parameters[1].busId = ""; e.setConfig(next);
    assert.equal(e.evaluate().valid, true, "unused or disabled mixes do not gate manual parameters");
    next = e.getConfig(); next.parameters[1].busId = "deleted-mix"; e.setConfig(next);
    assert.equal(e.evaluate().valid, false, "deleted mix references stay invalid instead of becoming manual");
    e.deactivate();
  }
  {
    const h = harness(), e = h.engine;
    e.setConfig({ buses: [bus("learn", [fixed("a", { rangeMode: "auto" })])],
      parameters: [h.parameter("cutoff", { busId: "learn", minimum: 0, maximum: 100 })] });
    e.activate(); await settle();
    assert.equal(e.evaluate().values[0].value, 50);
    assert.equal(e.freeze("learn", 0), false);
    const staleSettings = e.getConfig();
    h.samples.a = { value: 50, at: 100, minimum: 10, maximum: 90 }; await h.tick(100);
    const observedSource = h.reads.at(-1);
    staleSettings.parameters[0].maximum = 90; e.setConfig(staleSettings);
    assert.equal(h.reads.at(-1), observedSource, "input object identities survive parameter edits");
    assert.equal(e.getConfig().buses[0].sources[0].learnedMin, 10);
    assert.equal(e.getConfig().buses[0].sources[0].learnedMax, 90, "even an older UI snapshot preserves recent peaks");
    e.reset(); assert.equal(h.resets.length, 1);
    assert.equal(e.getConfig().buses[0].sources[0].learnedMax, 90, "transport resets preserve learned calibration");
    assert.equal(h.preparations.length, 1);
    assert.equal(e.freeze("learn", 0), true);
    h.samples.a = 500; await h.tick();
    assert.equal(e.evaluate().values[0].value, 90);
    assert.equal(e.getConfig().buses[0].sources[0].inputMax, 90);
    assert.equal(e.relearn("learn", 0), true);
    assert.equal(h.rangeResets.length, 1);
    assert.equal(e.getConfig().buses[0].sources[0].learnedMin, 500);
    h.samples.a = { value: -100, at: 0 }; await h.tick(4000);
    assert.equal(e.evaluate().valid, false);
    assert.equal(e.getConfig().buses[0].sources[0].learnedMin, 500, "stale input cannot calibrate the range");
    h.samples.a = 600; await h.tick(); assert.equal(e.evaluate().valid, true);
    h.bumpRevision(); await h.tick(); assert.equal(h.preparations.length, 2);
    h.setFields([]); await h.tick(); assert.equal(e.evaluate().valid, false);
    e.deactivate(); assert.equal(h.timers.size, 0);
    e.activate(); await settle(); assert.equal(h.timers.size, 1);
    e.deactivate();
  }
  {
    const h = harness(), e = h.engine;
    for (const definition of [
      { id: "hardware", min: 0, max: 16383, from: 0, to: 16383, hardware: true, kind: "nrpn" },
      { id: "choice", min: 0, max: 10, from: 0, to: 10, hardware: true, kind: "cc", number: 1, choices: [{ value: 0 }, { value: 4 }, { value: 10 }] },
      { id: "unavailable", min: 0, max: 127, from: 0, to: 127, unavailable: "Unsupported address" }
    ]) h.addDestination(definition);
    e.setConfig({ parameters: [h.parameter("pitch", { value: 200 }), h.parameter("hardware", { value: 5000, busId: "missing" }),
      h.parameter("choice", { value: 7.8 }), h.parameter("unavailable", { busId: "missing" }),
      h.parameter("future", { value: 9000, minimum: -500, maximum: 12000 })] });
    assert.deepEqual(plain(e.evaluate("audio")), { values: [{ destination: "pitch", value: 96 }], valid: true }, "hardware and unavailable routes do not gate browser audio");
    assert.equal(e.evaluate("midi").valid, false, "an available mapped hardware parameter requires its bus");
    assert.equal(e.evaluate("midi", { midiFormat: "cc" }).valid, true, "Connections MIDI format can override saved synth defaults");
    assert.equal(e.snapshot("midi", { midiFormat: "cc" }).parameters.find((item) => item.destination === "hardware").available, false);
    assert.equal(e.getConfig().controls.midiFormat, "nrpn", "Connections overrides do not rewrite saved sound settings");
    let next = e.getConfig(); next.controls.midiFormat = "cc"; e.setConfig(next);
    assert.deepEqual(plain(e.evaluate("midi")), { values: [{ destination: "pitch", value: 96 }, { destination: "choice", value: 10 }], valid: true });
    assert.equal(e.snapshot("midi").parameters.find((item) => item.destination === "hardware").available, false);
    assert.equal(e.getConfig().parameters.find((item) => item.destination === "future").value, 9000);
    h.addDestination({ id: "future", min: 0, max: 10000, from: 0, to: 10000, hardware: true, kind: "nrpn" });
    next = e.getConfig(); next.controls.midiFormat = "nrpn"; next.parameters[1].enabled = false; e.setConfig(next);
    assert.equal(e.evaluate("midi").values.find((item) => item.destination === "future").value, 9000, "asynchronous catalog availability restores saved parameters");
    assert.equal(e.getConfig().parameters.find((item) => item.destination === "future").minimum, 0);
  }
  {
    const h = harness(), library = h.library;
    const validated = library.validateConfig({ buses: Array.from({ length: 10 }, () => bus("duplicate", Array(8).fill(fixed("a")))),
      parameters: [h.parameter("cutoff"), h.parameter("cutoff", { value: 500, minimum: -1, maximum: 500, curve: "bad" }),
        ...Array.from({ length: 40 }, (_, index) => h.parameter(`unknown-${index}`))] });
    assert.equal(validated.buses.length, 4);
    assert.equal(new Set(validated.buses.map((item) => item.id)).size, 4);
    assert.equal(validated.buses[0].sources.length, 6);
    assert.equal(validated.parameters.length, 41, "all selected catalog destinations survive validation");
    assert.equal(library.validateConfig({ parameters: Array.from({ length: library.MAX_PARAMETERS + 10 }, (_, i) => h.parameter(`parameter-${i}`)) }).parameters.length, library.MAX_PARAMETERS);
    assert.equal(validated.parameters[0].value, 127, "duplicate destinations use the last value");
    assert.equal(validated.parameters[0].minimum, 0);
    assert.equal(validated.parameters[0].maximum, 127);
    assert.equal(validated.parameters[0].curve, "linear");
  }
  {
    let e, calls = 0;
    const h = harness({ onUpdate() { calls++; e?.setConfig(e.getConfig()); } }); e = h.engine;
    e.activate(); await settle();
    assert.ok(calls < 10, "onUpdate persistence cannot recursively reenter callback delivery");
    e.deactivate(); assert.equal(h.timers.size, 0);
  }
  {
    let disconnected = true;
    const h = harness({ prepare: async () => { if (disconnected) throw new Error("Input disconnected"); } }), e = h.engine;
    e.setConfig({ buses: [bus("mix", [fixed("a")])], parameters: [h.parameter("cutoff", { busId: "mix" })] });
    e.activate(); await settle(); await h.tick();
    assert.deepEqual(h.errors, ["Input disconnected"]);
    assert.equal(h.preparations.length, 1, "failed preparation does not create a retry storm");
    assert.equal(e.evaluate().valid, false);
    const edited = e.getConfig(); edited.parameters[0].maximum = 50; e.setConfig(edited);
    disconnected = false; e.reset(); await settle();
    assert.equal(h.preparations.length, 2, "deliberately restarting transport retries failed preparation even after parameter edits");
    assert.equal(e.evaluate().valid, true);
    assert.equal(h.timers.size, 1, "retrying preparation replaces the old timer");
    e.deactivate();
  }
  {
    const h = harness(), e = h.engine;
    e.setConfig({ mode: "demo", buses: [bus("demo", [fixed("demo:movement", { inputMax: 1 })])], parameters: [h.parameter("cutoff", { busId: "demo" })] });
    e.activate(); await settle();
    assert.equal(e.evaluate().valid, true);
    assert.equal(h.preparations.length, 0);
    assert.equal(e.snapshot().fields.length, 3);
    const before = e.evaluate().values[0].value;
    const other = h.context.HydraMusicMixerEngine.create(); other.activate();
    assert.equal(e.snapshot().active, true, "opening Music mixer preserves the Synth input engine");
    assert.equal(e.evaluate().valid, true);
    assert.equal(h.timers.size, 2, "each workspace retains one independent input timer");
    e.activate(); other.activate();
    assert.equal(h.timers.size, 2, "revisiting either workspace cannot duplicate its timer");
    await h.tick(1000);
    assert.notEqual(e.evaluate().values[0].value, before, "hidden Synth mappings keep evaluating new input");
    other.deactivate(); assert.equal(h.timers.size, 1);
    assert.equal(e.snapshot().active, true, "stopping one workspace leaves the other running");
    e.deactivate(); assert.equal(h.timers.size, 0);
  }
  process.stdout.write("Synth mixer engine tests passed\n");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
