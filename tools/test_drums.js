"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/drums.js"), "utf8"), context);
const Drums = context.HydraDrums;
const plain = (value) => JSON.parse(JSON.stringify(value));
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, message || `${actual} != ${expected}`);
const rawMotion = { drumSmoothing: 0, drumSensitivity: 50 };
const position = (value, at, key = "arm") => ({ key, value, at, kind: "position", minimum: 0, maximum: 1 });
const velocity = (value, at, key = "speed") => ({ key, value, at, kind: "velocity", minimum: -2, maximum: 2 });

const validated = Drums.settings({ drumKit: "unknown", drumStyle: "unknown", drumTempoMin: 999, drumTempoMax: -10,
  drumDensityMin: 100, drumDensityMax: -20, drumSensitivity: Infinity, drumSwing: 99,
  drumSources: ["a", "a", null, ...Array.from({ length: 12 }, (_, index) => `source${index}`)],
  drumMuted: ["kick", "kick", "missing", "openHat"] });
assert.equal(validated.drumTempoMin, 20);
assert.equal(validated.drumTempoMax, 240);
assert.equal(validated.drumDensityMin, 0);
assert.equal(validated.drumDensityMax, 100);
assert.equal(validated.drumSwing, 65);
assert.equal(validated.drumSensitivity, 50);
assert.equal(validated.drumKit, "electro");
assert.equal(validated.drumStyle, "broken");
assert.equal(validated.drumSources.length, 6);
assert.equal(new Set(validated.drumSources).size, 6);
assert.deepEqual(plain(validated.drumMuted), ["kick", "openHat"]);
assert.deepEqual(plain(Drums.settings(null)), plain(Drums.DEFAULTS));
assert.deepEqual(plain(Drums.settings(validated)), plain(validated));

const held = new Drums.Motion();
assert.equal(held.update([position(1, 0)], 0, rawMotion), 0, "a high held position is not movement");
assert.equal(held.update([position(1, 100)], 100, rawMotion), 0);
assert.equal(held.update([position(1, 200)], 200, rawMotion), 0);
close(held.update([position(.95, 300)], 300, rawMotion), .5, "position movement is scaled by elapsed source time");
close(held.update([position(.90, 400)], 400, rawMotion), .5);
assert.equal(held.update([position(.90, 500)], 500, rawMotion), 0, "a new stationary frame stops movement");

for (const sign of [-1, 1]) {
  const detector = new Drums.Motion();
  close(detector.update([velocity(sign, 0)], 0, rawMotion), .5, "speed is direction independent");
  close(detector.update([velocity(sign, 100)], 100, rawMotion), .5, "constant nonzero velocity remains motion");
  assert.equal(detector.update([velocity(0, 200)], 200, rawMotion), 0);
}
const average = new Drums.Motion();
close(average.update([velocity(-2, 0, "a"), velocity(0, 0, "b")], 0, rawMotion), Math.sqrt(.5), "joint energies combine without opposite directions cancelling");
close(average.update([velocity(-2, 100, "a"), velocity(0, 100, "b")], 100,
  { ...rawMotion, drumSources: ["b"] }), 0, "the selected sources control activity");

const timing = new Drums.Motion();
timing.update([position(0, 0)], 0, rawMotion);
close(timing.update([position(.05, 100)], 100, rawMotion), .5);
close(timing.update([position(.05, 100)], 200, rawMotion), .5, "between-frame reads retain the last measured speed briefly");
assert.ok(timing.update([position(.05, 100)], 700, rawMotion) < .2, "an old frame decays, rather than inventing fresh motion");
assert.equal(timing.update([position(.05, 100)], 1700, rawMotion), 0);
assert.equal(timing.update([position(.05, 50)], 1800, rawMotion), 0, "a backwards source timestamp primes the position history again");
assert.equal(timing.update([position(.5, 50)], 1900, rawMotion), 0, "duplicate frame timestamps do not make movement even if read twice differently");
timing.reset();
assert.equal(timing.update([position(.8, 9999)], 2000, rawMotion), 0, "reset does not compare different recordings");
assert.equal(timing.update([position(.9, 10099)], 10, rawMotion), 0, "a backwards processing clock also resets the detector");

const fastFrames = new Drums.Motion();
const slowFrames = new Drums.Motion();
fastFrames.update([position(0, 0)], 0, rawMotion);
slowFrames.update([position(0, 0)], 0, rawMotion);
close(fastFrames.update([position(.01, 20)], 20, rawMotion), slowFrames.update([position(.1, 200)], 200, rawMotion), "frame rate does not change measured physical motion");
const smooth = new Drums.Motion();
const first = smooth.update([velocity(2, 0)], 0, { drumSmoothing: 80 });
assert.ok(first > 0 && first < .1, "smoothing eases into movement");
let rising = first;
for (let time = 100; time <= 5000; time += 100) rising = smooth.update([velocity(2, time)], time, { drumSmoothing: 80 });
assert.ok(rising > .99, "smoothing reaches sustained activity");
const falling = smooth.update([velocity(0, 5100)], 5100, { drumSmoothing: 80 });
assert.ok(falling < rising && falling > .8, "smoothing also eases back to rest");
assert.ok(new Drums.Motion().update([velocity(.2, 0)], 0, { ...rawMotion, drumSensitivity: 100 }) >
  new Drums.Motion().update([velocity(.2, 0)], 0, { ...rawMotion, drumSensitivity: 0 }));
for (const bad of [null, undefined, [], [{ key: "bad", value: NaN }], [{ key: "bad", value: Infinity }], [{ value: 1 }]]) {
  assert.equal(new Drums.Motion().update(bad, 100, rawMotion), 0);
}

const count = (grid) => grid.reduce((sum, track) => sum + track.steps.filter((value) => value > 0).length, 0);
for (const { id: drumStyle } of Drums.STYLES) {
  for (const bar of [0, 3, 7]) {
    let previous = Drums.pattern({ drumStyle, drumDensityMin: 0, drumDensityMax: 100, drumFill: 100 }, 0, bar);
    assert.equal(count(previous), 0, "zero density is a true rest");
    for (let percent = 1; percent <= 100; percent++) {
      const grid = Drums.pattern({ drumStyle, drumDensityMin: 0, drumDensityMax: 100, drumFill: 100 }, percent / 100, bar);
      assert.equal(grid.length, 6);
      assert.ok(count(grid) >= count(previous), "increasing activity adds to the established groove");
      grid.forEach((track, row) => {
        assert.equal(track.steps.length, 16);
        track.steps.forEach((value, column) => {
          assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
          if (previous[row].steps[column]) assert.ok(value >= previous[row].steps[column]);
        });
      });
      previous = grid;
    }
    assert.ok(count(previous) >= 30);
    assert.ok(previous.find((track) => track.id === "kick").steps[0], "all styles retain a clear downbeat");
    assert.ok(previous.find((track) => track.id === "snare").steps[drumStyle === "half" ? 8 : 4], "backbeat defines the style");
  }
}
const busy = { drumDensityMin: 90, drumDensityMax: 90, drumFill: 100 };
assert.ok(count(Drums.pattern(busy, 1, 3)) > count(Drums.pattern(busy, 1, 0)), "fourth-bar fills expand the groove");
assert.deepEqual(plain(Drums.pattern({ ...busy, drumFill: 0 }, 1, 3)), plain(Drums.pattern({ ...busy, drumFill: 0 }, 1, 0)));
assert.deepEqual(plain(Drums.pattern(busy, .6, 3)), plain(Drums.pattern(busy, .6, 3)), "preview and playback share one deterministic pattern");
const muted = Drums.pattern({ ...busy, drumMuted: ["kick", "snare", "closedHat"] }, 1);
assert.ok(muted.filter((track) => ["kick", "snare", "closedHat"].includes(track.id)).every((track) => track.steps.every((value) => value === 0)));
assert.ok(muted.find((track) => track.id === "perc").steps.some(Boolean));
for (const drumSwing of [0, 12, 65]) for (const activity of [0, .5, 1]) {
  const config = { drumSwing, drumTempoMin: 60, drumTempoMax: 180, drumDensityMin: 0, drumDensityMax: 100 };
  const even = Drums.step(config, activity, 0);
  const odd = Drums.step(config, activity, 1);
  close(even.tempo, 60 + 120 * activity);
  close(even.density, 100 * activity);
  close(even.interval + odd.interval, 30000 / even.tempo, "swing preserves the musical clock");
  assert.ok(odd.interval > 0);
  for (let index = 0; index < 64; index++) {
    const plan = Drums.step(config, activity, index);
    for (const hit of plan.hits) {
      assert.ok(hit.velocity >= 1 && hit.velocity <= 127 && Number.isInteger(hit.velocity));
      assert.ok(Drums.TRACKS.some((track) => track.id === hit.track && track.note === hit.note));
      assert.ok(hit.duration > 0);
      assert.ok(plan.pattern.find((track) => track.id === hit.track).steps[index % 16]);
    }
  }
}

// A small audio-graph double verifies lifecycle and scheduling, not timbre.
class Param {
  constructor() { this.value = 0; this.events = []; }
  setValueAtTime(value, time) { this.events.push(["set", value, time]); }
  exponentialRampToValueAtTime(value, time) { assert.ok(value > 0); this.events.push(["ramp", value, time]); }
  setTargetAtTime(value, time, constant) { this.events.push(["target", value, time, constant]); }
  cancelScheduledValues(time) { this.events.push(["cancel", time]); }
}
class AudioNode {
  constructor() { this.gain = new Param(); this.frequency = new Param(); this.Q = new Param(); this.connections = []; this.stops = []; }
  connect(destination) { this.connections.push(destination); }
  disconnect() { this.connections = []; this.disconnected = true; }
  start(time) { this.started = time; }
  stop(time) { this.stops.push(time); }
}
const audio = { currentTime: 2, sampleRate: 48000, destination: new AudioNode(),
  createGain: () => new AudioNode(), createOscillator: () => new AudioNode(),
  createBiquadFilter: () => new AudioNode(), createBufferSource: () => new AudioNode(),
  createBuffer: (_, length) => ({ getChannelData: () => new Float32Array(length) }) };
const engine = new Drums.Engine(audio);
assert.equal(engine.output.connections[0], audio.destination);
for (const kit of Drums.KITS) for (const track of Drums.TRACKS) {
  const voice = engine.hit(track.id, 100, kit.id, 2.5, .7);
  assert.ok(voice.sources.length > 0);
  voice.sources.forEach((source) => {
    assert.equal(source.started, 2.5);
    assert.ok(source.stops[0] > 2.5);
    assert.ok(source.connections.length > 0);
  });
  for (const source of [...voice.sources]) source.onended?.();
  assert.ok(!engine.voices.has(voice));
  assert.ok(voice.nodes.every((node) => node.disconnected), "natural note completion disconnects the full graph");
}
const open = engine.hit("openHat", 100, "warehouse", 2.5);
engine.hit("closedHat", 100, "warehouse", 2.7);
assert.ok(open.released, "closed hats choke the previous open hat");
assert.ok(open.sources.every((source) => source.stops.at(-1) >= 2.7));
assert.ok(open.nodes.some((node) => node.connections.length > 0), "a future choke must not disconnect the open hat before the scheduled time");
for (let index = 0; index < 100; index++) engine.hit("kick", 100);
assert.ok(engine.voices.size <= 64, "voice stealing bounds audio resources");
const beforeStop = [...engine.voices];
engine.stop();
assert.equal(engine.voices.size, 0);
assert.ok(beforeStop.every((voice) => voice.nodes.every((node) => node.disconnected)), "stop silences every track and clears the graph");
engine.hit("kick", 0);
engine.hit("kick", 100, "electro", 2, 0);
engine.hit("unknown", 100);
assert.equal(engine.voices.size, 0);
assert.ok(engine.hit("kick", 100), "stop permits playback to restart");
engine.dispose();
assert.equal(engine.voices.size, 0);
assert.ok(engine.output.disconnected);
assert.equal(engine.hit("kick", 100), undefined);

console.log("drum movement, groove density, timing, kit synthesis and voice lifecycle tests: ok");
