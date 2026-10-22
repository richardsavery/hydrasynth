"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Param {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(value, time) { this.value = value; this.events.push(["set", value, time]); }
  setTargetAtTime(value, time, constant) { this.value = value; this.events.push(["target", value, time, constant]); }
  linearRampToValueAtTime(value, time) { this.value = value; this.events.push(["ramp", value, time]); }
  cancelScheduledValues(time) { this.events.push(["cancel", time]); }
  cancelAndHoldAtTime(time) { this.events.push(["hold", time]); }
}
class Node {
  constructor(kind) {
    this.kind = kind; this.connections = []; this.disconnected = false;
    for (const name of ["gain", "frequency", "Q", "pan", "delayTime", "threshold", "knee", "ratio", "attack", "release", "playbackRate"]) this[name] = new Param();
  }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnected = true; this.connections = []; }
}
class Source extends Node {
  constructor() { super("source"); this.stops = []; }
  start(when, offset) { this.started = { when, offset }; }
  stop(when) { this.stops.push(when); }
}
const buffer = (duration = 20, channels = 2) => ({ duration, numberOfChannels: channels, length: duration * 1000 });
class FakeContext {
  constructor() { this.currentTime = 0; this.sampleRate = 48000; this.sources = []; this.nodes = []; this.destination = {}; this.resumeCalls = 0;
    this.audioWorklet = { addModule: async (url) => { this.streamModule = url; } }; FakeContext.last = this; }
  node(kind) { const node = new Node(kind); this.nodes.push(node); return node; }
  createGain() { return this.node("gain"); }
  createBiquadFilter() { return this.node("filter"); }
  createStereoPanner() { return this.node("panner"); }
  createDynamicsCompressor() { return this.node("compressor"); }
  createDelay() { return this.node("delay"); }
  createConvolver() { return this.node("convolver"); }
  createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
  createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
  async decodeAudioData(data) { if (data.fail) throw new Error("Corrupt audio"); return data.decoded || buffer(); }
  async resume() { this.resumeCalls++; }
  async close() { this.closed = true; }
}
class FakeStreamNode extends Node {
  constructor(ctx, name, options) {
    super("stream"); this.processorName = name; this.options = options;
    this.parameters = new Map([["playbackRate", new Param(options.parameterData.playbackRate)]]);
    this.port = { messages: [], onmessage: null, postMessage(message) { this.messages.push(message); }, start() {}, close() { this.closed = true; } };
    ctx.nodes.push(this);
  }
}
function pcmWindow(duration = 10) {
  const frames = Math.round(duration * 48000), data = new ArrayBuffer(44 + frames * 4), view = new DataView(data);
  const text = (at, value) => [...value].forEach((letter, index) => view.setUint8(at + index, letter.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, data.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true); view.setUint32(24, 48000, true);
  view.setUint32(28, 192000, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, frames * 4, true);
  for (let frame = 0; frame < frames; frame++) { view.setInt16(44 + frame * 4, 8192, true); view.setInt16(46 + frame * 4, -8192, true); }
  return data;
}
const FakePitch = {
  async register(ctx) { ctx.pitchRegistrations = (ctx.pitchRegistrations || 0) + 1; },
  latencySeconds() { return 0; },
  create(ctx, values) {
    const node = ctx.node("pitch");
    node.parameters = new Map(Object.entries(values).map(([name, value]) => [name, new Param(value)]));
    node.port = { messages: [], closed: false,
      postMessage(message) { this.messages.push(message); },
      close() { this.closed = true; } };
    return node;
  }
};
const context = vm.createContext({ console, AbortController, setTimeout, clearTimeout, Float32Array });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/elevenlabs-player.js"), "utf8"), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/robot-drums.js"), "utf8"), context);
const { Player } = context.HydraElevenPlayer;
const track = (id, extra = {}) => ({ id, audio_url: `/audio/${id}`, ...extra });
const beatMetadata = { source: "mix", audio_sha256: "a".repeat(64), source_sha256: "a".repeat(64), bpm_min: 80, bpm_max: 140 };
function fixture(options = {}) {
  const timers = new Map(), requests = [], assets = new Map();
  let nextTimer = 0;
  const player = new Player({ AudioContext: FakeContext, AudioWorkletNode: FakeStreamNode, Pitch: FakePitch,
    setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, request) => {
      requests.push({ url, request });
      const data = assets.get(url) || { decoded: buffer() };
      if (data.error) throw new Error(data.error);
      return { ok: true, headers: { get() { return null; } }, arrayBuffer: async () => data };
    }, ...options });
  return { player, timers, requests, assets,
    tick(time) {
      FakeContext.last.currentTime = time;
      const entry = [...timers].find(([, timer]) => timer.delay === 80);
      assert.ok(entry, "the running player has exactly one scheduling timer");
      timers.delete(entry[0]); entry[1].callback();
    } };
}
function near(actual, expected, label, tolerance = 1e-8) { assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual} versus ${expected}`); }

async function main() {
  {
    const complete = { ...beatMetadata, state: "complete", schema_version: 1, duration_seconds: 20,
      bpm_median: 120, beats_seconds: [1, 1.5, 2], active_regions: [{ start_seconds: 1, end_seconds: 2.1 }] };
    const invalidMaps = [undefined, { state: "queued" }, { state: "analyzing" }, { state: "failed" },
      { ...complete, schema_version: 2 }, { ...complete, beats_seconds: [1, 1] },
      { ...complete, beats_seconds: [1, 1.5, 20] }, { ...complete, duration_seconds: 30 },
      { ...complete, active_regions: [{ start_seconds: 1.2, end_seconds: 2.1 }] },
      { ...complete, active_regions: [{ start_seconds: .9, end_seconds: 1.1 }, { start_seconds: 1.4, end_seconds: 2.1 }] },
      { ...complete, bpm_median: NaN }, { ...complete, audio_sha256: "b".repeat(64) },
      { ...complete, first_beat_in_bar: 5 }, { ...complete, bar_phase_confidence: NaN }];
    for (const analysis of invalidMaps) {
      const options = { enabled: true }, { player } = fixture({ beatTracking: () => options });
      await player.loadTrack(track("invalid-detected", { beat_analysis: analysis })); await player.start();
      const clock = player.transportClock(120);
      assert.equal(clock.valid, false, "enabled missing, pending, failed or malformed detection cannot fall back to manual BPM");
      assert.equal(clock.bpm, null); assert.equal(clock.beatContacts.length, 0);
      assert.match(clock.beatTrackingError, /retry beat alignment/);
      assert.equal(clock.playing, true, "unavailable beat analysis does not block listening to the audio");
      options.enabled = false;
      assert.equal(player.transportClock(120).valid, true, "only explicit opt-out restores a fixed manual beat grid");
      player.dispose();
    }
  }
  {
    const analysis = { ...beatMetadata, state: "complete", schema_version: 1, duration_seconds: 20,
      bpm_median: 120, first_beat_in_bar: 4, bar_phase_confidence: .82,
      beats_seconds: [1, 1.5, 2], active_regions: [{ start_seconds: 1, end_seconds: 2.1 }] };
    const options = { enabled: true }, { player } = fixture({ beatTracking: () => options });
    await player.loadTrack(track("automatic-groove-phase", { beat_analysis: analysis })); await player.start();
    let contact = player.transportClock(null).beatContacts.find(item => item.key.endsWith(":0:0"));
    assert.equal(contact.beat, 3, "the detected pickup position sets groove phase without a manual bar setting");
    options.firstBeatInBar = 2;
    contact = player.transportClock(null).beatContacts.find(item => item.key.endsWith(":0:0"));
    assert.equal(contact.beat, 1, "an optional saved correction overrides the automatic estimate");
    player.dispose();
  }
  {
    const analysis = { ...beatMetadata, state: "complete", schema_version: 1, duration_seconds: 20,
      bpm_median: 120, beats_seconds: [0, .5, 1], active_regions: [{ start_seconds: 0, end_seconds: 1.1 }] };
    const { player } = fixture({ beatTracking: { enabled: true } });
    await player.loadTrack(track("opening-beat", { beat_analysis: analysis }));
    await player.start({ leadSeconds: 1.2 });
    const clock = player.transportClock(null), first = clock.beatContacts.find(item => item.beat === 0);
    near(first.at, 1.22, "startup preparation leaves time to schedule a beat at file time zero");
    near(player.currentPosition, 0, "preparation does not seek into or trim the file");
    assert.equal(clock.playing, true, "the follower can prepare before the first audio sample");
    player.dispose();
  }
  {
    const analysis = { ...beatMetadata, state: "complete", schema_version: 1, duration_seconds: 20, bpm_median: 110,
      beats_seconds: [2, 2.5, 3.1, 3.9, 7, 7.4, 7.85],
      active_regions: [{ start_seconds: 1.9, end_seconds: 4.1 }, { start_seconds: 6.9, end_seconds: 8.1 }] };
    const options = { enabled: true, offsetSeconds: 0.1, firstBeatInBar: 3 };
    const { player } = fixture({ beatTracking: () => options, Pitch: { ...FakePitch, latencySeconds: () => .25 } });
    await player.loadTrack(track("detected-map", { beat_analysis: analysis })); await player.start();
    const ctx = FakeContext.last;
    let clock = player.transportClock(null);
    assert.equal(clock.valid, true, "a detected map does not need a manually supplied BPM");
    assert.equal(clock.estimated, false);
    assert.equal(clock.beatContacts.length, 0, "leading silence never acquires an extrapolated grid");
    ctx.currentTime = 1.6; clock = player.transportClock(null);
    const first = clock.beatContacts.find(contact => contact.beat === 2);
    near(first.at, 2.37, "first detected beat includes file offset, manual timing and processor latency");
    ctx.currentTime = 3; player.updateControls({ rate: 1.25 });
    clock = player.transportClock(null);
    assert.ok(clock.beatContacts.length > 3, "variable-tempo intervals provide subdivisions");
    for (const contact of clock.beatContacts) {
      const [, , indexText, partText] = contact.key.split(":"), index = Number(indexText), part = Number(partText);
      const expectedSource = analysis.beats_seconds[index] + .1 + (part ? (analysis.beats_seconds[index + 1] - analysis.beats_seconds[index]) * part / 4 : 0);
      near(player._clockAt(player._active, contact.at - .25).position, expectedSource, "every contact inverts the audible rate ramp exactly");
    }
    player.updateControls({ rate: 1 }); ctx.currentTime = 5;
    assert.equal(player.transportClock(null).beatContacts.length, 0, "no quarter beats are invented across an inactive region");
    ctx.currentTime = 10;
    assert.equal(player.transportClock(null).beatContacts.length, 0, "the last detected beat is not extended into an outro");
    options.enabled = false;
    assert.equal(player.transportClock(null).valid, false, "disabling detection restores manual-tempo requirements");
    assert.equal(player.transportClock(120).estimated, true);
    player.dispose();
  }
  {
    const analysis = { ...beatMetadata, state: "complete", schema_version: 1, duration_seconds: 6, bpm_median: 120,
      beats_seconds: [.2, .7, 1.3, 2, 3.5, 4], active_regions: [{ start_seconds: .1, end_seconds: 4.1 }] };
    const { player, assets, tick } = fixture({ beatTracking: { enabled: true, firstBeatInBar: 1 } });
    assets.set("/audio/detected-loop", { decoded: buffer(6) });
    await player.loadTrack(track("detected-loop", { beat_analysis: analysis })); await player.start();
    const ctx = FakeContext.last, initial = player.transportClock(null);
    tick(5.6);
    assert.equal(player._transition, null, "detected loops use the complete file instead of an early crossfade");
    const before = player.transportClock(null), upcoming = before.beatContacts.find(contact => contact.beat === 0);
    near(upcoming.at, 6.22, "the next loop's first beat can be scheduled before its boundary");
    assert.ok(upcoming.key.includes(":1:0:0"));
    ctx.currentTime = 6.3;
    assert.equal(player.transportClock(null).transportToken, initial.transportToken, "natural loops retain the prepared hardware session");
    assert.notEqual(player.transportClock(null).mapToken, initial.mapToken, "each loop still has a distinct contact identity");
    player.setSourceValid(false); player.setSourceValid(true);
    assert.notEqual(player.transportClock(null).transportToken, initial.transportToken, "an actual input interruption invalidates queued robot contacts");
    player.dispose();
  }
  {
    const analysis = { ...beatMetadata, state: "complete", schema_version: 1, duration_seconds: 20, bpm_median: 120,
      beats_seconds: Array.from({ length: 40 }, (_, index) => index * .5), active_regions: [{ start_seconds: 0, end_seconds: 20 }] };
    const { player, tick } = fixture({ beatTracking: { enabled: true } });
    await player.loadTrack(track("detected-old", { beat_analysis: analysis })); await player.start();
    await player.queueTrack(track("detected-new", { beat_analysis: analysis }));
    tick(18);
    const transition = player._transition, before = player.transportClock(null);
    assert.ok(transition);
    assert.ok(before.beatContacts.every(contact => !contact.key.startsWith(`${transition.old.syncId}:`) || contact.at <= transition.start),
      "old map contacts stop at the incoming deck's audible handoff");
    assert.ok(before.beatContacts.some(contact => contact.key.startsWith(`${transition.next.syncId}:`)), "the armed incoming map supplies future contacts");
    FakeContext.last.currentTime = transition.start + .01;
    assert.equal(player.transportClock(null).transportToken, before.transportToken, "a detected handoff does not cancel already scheduled incoming contacts");
    assert.ok(player.transportClock(null).beatContacts.every(contact => contact.key.startsWith(`${transition.next.syncId}:`)));
    player.dispose();
  }
  {
    const analysis = { ...beatMetadata, state: "complete", schema_version: 1, duration_seconds: 6, bpm_median: 110,
      beats_seconds: [1.1, 1.6, 2.2, 2.7, 4, 4.65],
      active_regions: [{ start_seconds: 1, end_seconds: 2.8 }, { start_seconds: 3.9, end_seconds: 4.8 }] };
    const { player, tick } = fixture({ beatTracking: { enabled: true }, Pitch: { ...FakePitch, latencySeconds: () => .25 },
      fetch: async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => pcmWindow(6) }) });
    await player.loadTrack(track("detected-stream", { origin: "uploaded", audio: { duration_seconds: 6 }, beat_analysis: analysis }));
    player.updateControls({ rate: 1.2 }); await player.start();
    const ctx = FakeContext.last, starts = [], stops = [], hits = [], ready = token => ({ ok: true, performance: { token, state: "ready" } });
    const drums = context.HydraRobotDrums.createEngine({
      settings: { density: 100 }, now: () => ctx.currentTime * 1000,
      clock() { const clock = player.transportClock(null); return { ...clock, running: clock.playing && clock.valid,
        at: ctx.currentTime * 1000, token: clock.transportToken, beatContacts: clock.beatContacts.map(contact => ({ ...contact, at: contact.at * 1000 })) }; },
      setInterval: () => 1, clearInterval() {}, hardware: {
        snapshot: () => ({ drumsReady: true, drumTorqueEnabled: true, emergencyStopped: false }),
        startDrumming(payload) { starts.push(payload); return Promise.resolve(ready(payload.token)); },
        scheduleDrums(payload) { hits.push(...payload.events); return Promise.resolve(ready(payload.token)); },
        stopDrumming(payload) { stops.push(payload); return Promise.resolve({ ok: true }); }
      }
    });
    await drums.start();
    for (let index = 1; index <= 220; index++) { tick(index * .05); drums.tick(); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(starts.length, 1, "a streamed upload keeps one ready robot session through silence and two loops");
    assert.equal(stops.length, 0);
    assert.ok(hits.length > 15);
    assert.ok(hits.some(hit => hit.id.includes(":1:0:0:")), "the robot receives beat zero in the next natural loop");
    for (const hit of hits) {
      const [, cycleText, indexText, partText] = hit.id.split(":").slice(-5, -1);
      const cycle = Number(cycleText), index = Number(indexText), part = Number(partText);
      const source = analysis.beats_seconds[index] + (part ? (analysis.beats_seconds[index + 1] - analysis.beats_seconds[index]) * part / 4 : 0);
      const expected = Math.round((.33 + (cycle * 6 + source) / 1.2) * 1000);
      assert.equal(hit.contactAt, expected, "the robot's actual scheduled contact follows source beats, playback rate and audible latency");
    }
    await drums.stop(); player.dispose();
  }
  {
    const requests = [], length = 75.25;
    const { player } = fixture({ fetch: async (url, options) => {
      requests.push({ url, options });
      const start = Number(new URL(url, "http://localhost").searchParams.get("start"));
      return { ok: true, headers: { get: () => null }, arrayBuffer: async () => pcmWindow(Math.min(10, length - start)) };
    } });
    const stems = ["Bass", "Drums", "Guitar", "Piano", "Other", "Vocals"].map((name) => ({ name, audio_url: `/long/${name}`, duration_seconds: length }));
    await player.loadTrack(track("long-upload", { origin: "uploaded", audio: { duration_seconds: length }, stems, generation_settings: { bpm: 220 } }), { requireStems: true });
    assert.equal(player.streaming, true);
    assert.equal(player.duration, length);
    assert.equal(requests.length, 18, "prepare only three ten-second windows per stem, independent of full song length");
    assert.ok(requests.every(({ url }) => url.includes("duration=10&sample_rate=48000") && !url.includes("/audio/long-upload")));
    assert.equal(player._cache.size, 0, "uploaded songs never enter the full-file decoding cache");
    assert.equal(player._prepared.initial.size, 3);
    near(player.decodedBytes, 30 * 48000 * 8 * 6, "initial stream memory is bounded");
    await player.start();
    const deck = player._active, source = deck.stream.node;
    assert.equal(source.processorName, "hydra-streamed-audio");
    assert.equal(source.options.numberOfOutputs, 6, "all six stems come from a single synchronized source");
    assert.equal(player._prepared.initial.size, 1, "only the first window is pinned for loops");
    assert.deepEqual(source.port.messages.map((message) => message.index), [0, 1, 2]);
    assert.equal(source.port.messages[0].parts[0][0][0], 0.25);
    assert.equal(source.port.messages[0].parts[0][1][0], -0.25);
    assert.equal(player.transportClock(null).valid, false, "uploaded audio never claims a generator BPM or automatic detection");
    assert.equal(player.transportClock(123).baseBpm, 123, "manual source BPM is used for uploaded tracks");
    player.updateControls({ rate: 1.25, pitch: 3, stemControls: { Vocals: { pitch: -2 } } });
    assert.equal(deck.parts[5].pitch.parameters.get("pitchSemitones").value, 1);
    assert.ok(deck.parts.every((part) => part.source.playbackRate === source.parameters.get("playbackRate")), "every stem uses exactly the same rate parameter");
    source.port.onmessage({ data: { type: "need", indices: [3], buffered: [1, 2] } });
    source.port.onmessage({ data: { type: "need", indices: [3], buffered: [1, 2] } });
    await deck.stream.serial;
    assert.equal(requests.length, 24, "duplicate requests cannot duplicate a pending window fetch");
    assert.equal(source.port.messages.at(-1).index, 3);
    assert.ok(player.decodedBytes <= 40 * 48000 * 8 * 6, "one loop window plus three moving windows bounds decoded memory");
    source.port.onmessage({ data: { type: "underrun" } });
    assert.equal(player.status, "error");
    assert.equal(player.transportClock(123).playing, false, "an underrun stops every stem and the musical clock together");
    assert.match(player._error, /synchronized/);
    assert.equal(source.port.closed, true);
    assert.equal(source.disconnected, true);
    assert.equal(deck.stream.controller.signal.aborted, true);
    player.dispose();
  }
  {
    let waiting = false, abandonedSignal;
    const { player } = fixture({ fetch: async (_url, options) => {
      if (waiting) return new Promise((_resolve, reject) => {
        abandonedSignal = options.signal;
        options.signal.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })));
      });
      return { ok: true, headers: { get: () => null }, arrayBuffer: async () => pcmWindow() };
    } });
    await player.loadTrack(track("cancel-stream", { origin: "uploaded", audio: { duration_seconds: 3600 } }));
    await player.start();
    const deck = player._active;
    waiting = true;
    deck.stream.node.port.onmessage({ data: { type: "need", indices: [3], buffered: [1, 2] } });
    await Promise.resolve();
    player.stop();
    await deck.stream.serial;
    assert.equal(abandonedSignal.aborted, true, "stopping aborts active window fetches");
    assert.equal(player.status, "stopped", "late aborted fetches cannot turn an intentional stop into an error");
    player.dispose();
  }
  {
    let waiting = false;
    const { player, timers } = fixture({ fetch: async (_url, { signal }) => {
      if (waiting) return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted"))));
      return { ok: true, headers: { get: () => null }, arrayBuffer: async () => pcmWindow() };
    } });
    await player.loadTrack(track("timeout-stream", { origin: "uploaded", audio: { duration_seconds: 3600 } }));
    await player.start();
    waiting = true;
    const deck = player._active;
    deck.stream.node.port.onmessage({ data: { type: "need", indices: [3], buffered: [1, 2] } });
    await Promise.resolve();
    const timeout = [...timers.values()].find((timer) => timer.delay === 60000);
    assert.ok(timeout);
    timeout.callback();
    await deck.stream.serial;
    assert.equal(player.status, "error", "a refill timeout cannot leave the UI playing while its source is silent");
    assert.match(player._error, /timed out/);
    assert.equal(deck.stream.controller.signal.aborted, true);
    assert.equal(player.transportClock(120).playing, false);
    player.dispose();
  }
  {
    let created = 0;
    const { player, tick, timers } = fixture({ Pitch: { ...FakePitch, create(...args) {
      if (++created > 1) throw new Error("Processor creation failed");
      return FakePitch.create(...args);
    } } });
    await player.loadTrack(track("transition-processor-error")); await player.start();
    assert.doesNotThrow(() => tick(18), "transition processor failure cannot escape the scheduling timer");
    assert.equal(player.status, "error");
    assert.equal(player.transportClock(120).playing, false);
    assert.equal(timers.size, 0);
    player.dispose();
  }
  {
    const { player } = fixture();
    const stems = [{ name: "Bass", audio_url: "/pitch-bass" }, { name: "Drums", audio_url: "/pitch-drums" }];
    await player.loadTrack(track("independent-pitch", { stems, generation_settings: { bpm: 100 } }));
    player.updateControls({ rate: 1.2, pitch: 5, stemControls: { Bass: { pitch: -7 }, Drums: { pitch: 3 } } });
    await player.start();
    const ctx = FakeContext.last, [bass, drums] = player._active.parts;
    assert.equal(bass.pitch.parameters.get("pitchSemitones").value, -2, "master and Bass pitch offsets combine in semitones");
    assert.equal(drums.pitch.parameters.get("pitchSemitones").value, 8, "each stem keeps its independent pitch offset");
    for (const part of [bass, drums]) {
      assert.equal(part.source.playbackRate.value, 1.2, "all stems retain a shared playback speed");
      assert.equal(part.pitch.parameters.get("playbackRate").value, 1.2, "the pitch processor compensates the source speed");
      assert.ok(part.source.connections.includes(part.pitch));
      assert.ok(part.pitch.connections.includes(part.highpass), "pitch processing feeds the existing stem effects");
    }
    ctx.currentTime = 2;
    const before = player.transportClock(100);
    const sourceEvents = bass.source.playbackRate.events.length;
    player.updateControls({ pitch: -4 });
    assert.equal(bass.pitch.parameters.get("pitchSemitones").value, -11);
    assert.equal(drums.pitch.parameters.get("pitchSemitones").value, -1);
    assert.equal(player.transportClock(100).token, before.token, "pitch-only changes cannot interrupt a synchronized rap");
    assert.equal(player.transportClock(100).bpm, before.bpm, "pitch-only changes cannot alter tempo");
    assert.equal(bass.source.playbackRate.events.length, sourceEvents, "pitch-only changes leave source speed untouched");
    player.updateControls({ rate: 0.8 });
    for (const part of [bass, drums]) {
      assert.deepEqual(part.source.playbackRate.events.slice(-3), part.pitch.parameters.get("playbackRate").events.slice(-3),
        "source speed and pitch compensation share exact ramp values and audio-clock times");
    }
    assert.equal(bass.pitch.parameters.get("pitchSemitones").value, -11, "speed changes preserve the chosen pitch");
    player.stop();
    for (const part of [bass, drums]) {
      assert.equal(part.pitch.port.messages.length, 1);
      assert.equal(part.pitch.port.messages[0].type, "dispose", "stopping releases the processor's audio-thread buffers");
      assert.equal(part.pitch.port.closed, true);
      assert.equal(part.pitch.disconnected, true);
      assert.equal(part.pitch.onprocessorerror, null);
    }
    await player.loadTrack(track("fullmix-pitch"));
    player.updateControls({ pitch: 7, rate: 1.1 });
    await player.start();
    const full = player._active.parts[0];
    assert.equal(full.name, null);
    assert.equal(full.pitch.parameters.get("pitchSemitones").value, 7, "the full mix uses the same independent pitch processing");
    assert.equal(full.pitch.parameters.get("playbackRate").value, 1.1);
    assert.ok(full.pitch.connections.includes(full.gain));
    player.dispose();
  }
  {
    const latency = 0.25;
    const { player } = fixture({ Pitch: { ...FakePitch, latencySeconds: () => latency } });
    await player.loadTrack(track("delayed-clock", { generation_settings: { bpm: 120 } }));
    await player.start();
    const ctx = FakeContext.last, deck = player._active;
    near(player.transportClock(120).at, 0.27, "beat zero is reported at the first audible sample");
    near(player.transportClock(120).beat, 0, "the processor's startup silence cannot advance the beat grid");
    near(player.remainingSeconds, 20.27, "remaining time includes initial source scheduling and processor latency");
    assert.ok(deck.gain.gain.events.some(event => event[0] === "set" && event[1] === 0 && event[2] === 0.27));
    near(deck.gain.gain.events.at(-1)[2], 0.3, "the initial fade follows the delayed audio");
    ctx.currentTime = 1;
    player.updateControls({ rate: 1.25 });
    assert.equal(player.transportClock(120).rateChanging, true, "rap waits while the first speed change is buffered");
    near(player.currentPosition, 0.73, "audible position retains pre-change history");
    ctx.currentTime = 1.04;
    player.updateControls({ rate: 0.75 });
    near(player.transportClock(120).bpm, 120, "a second speed command cannot erase the still-audible original tempo");
    near(player.currentPosition, 0.77, "two changes within the latency retain the old source timeline");
    // Source position reaches 1.0975 at 1.12s, then runs at 0.75 until 20s.
    const audibleEnd = 1.12 + (20 - 1.0975) / 0.75 + latency;
    near(player.remainingSeconds, audibleEnd - ctx.currentTime, "remaining time integrates both known ramps before the audible end");
    ctx.currentTime = 1.27;
    near(player.currentPosition, 1.000625, "the first speed ramp remains available after the second command");
    near(player.transportClock(120).bpm, 127.5, "the beat clock follows the audible first ramp");
    assert.equal(player.transportClock(120).rateChanging, true);
    near(player.remainingSeconds, audibleEnd - ctx.currentTime, "an older audible ramp still uses the already-scheduled later speed");
    ctx.currentTime = 1.31;
    near(player.currentPosition, 1.0440625, "the second speed ramp continues from the actual interrupted first ramp");
    near(player.transportClock(120).bpm, 123.75);
    ctx.currentTime = 1.38;
    near(player.transportClock(120).bpm, 90, "rap receives the final audible tempo");
    assert.equal(player.transportClock(120).rateChanging, false, "auto-start is released only after the audible ramp settles");
    player.dispose();
  }
  {
    const { player } = fixture({ Pitch: { ...FakePitch, latencySeconds: () => 0.25 } });
    await player.loadTrack(track("buffered-fallback-loop")); await player.start();
    const ctx = FakeContext.last;
    // Keep the UI scheduler idle while the looping source crosses its boundary.
    ctx.currentTime = 19.9;
    const before = player.transportClock(120).token;
    ctx.currentTime = 20.1;
    near(player.remainingSeconds, 0.17, "buffered end-of-loop samples retain the old audible boundary");
    assert.equal(player.transportClock(120).token, before, "a source loop cannot invalidate rap before the loop is audible");
    ctx.currentTime = 20.3;
    near(player.currentPosition, 0.03, "the audible fallback loop wraps only after processor latency");
    near(player.remainingSeconds, 19.97, "the new audible cycle reports its own remaining duration");
    assert.notEqual(player.transportClock(120).token, before, "the audible fallback loop invalidates the previous rap phase");
    player.dispose();
  }
  {
    const latency = 0.25, transitions = [];
    const { player, tick } = fixture({ Pitch: { ...FakePitch, latencySeconds: () => latency },
      onTransition: value => transitions.push(value.id) });
    await player.loadTrack(track("delayed-current")); await player.start();
    await player.queueTrack(track("delayed-obsolete")); tick(18);
    const canceled = player._transition;
    near(canceled.start, canceled.next.parts[0].source.started.when + latency, "crossfades begin when incoming samples become audible");
    near(canceled.end, 20.27, "crossfade ends at the audible outgoing boundary");
    FakeContext.last.currentTime = canceled.next.parts[0].source.started.when + 0.1;
    assert.equal(player.clearQueuedTrack(), true, "a warmed-up but inaudible replacement can still be withdrawn");
    assert.equal(canceled.next.parts[0].pitch.port.closed, true);
    assert.equal(canceled.old.parts[0].source.stops.length, 0);
    assert.deepEqual(transitions, []);
    await player.queueTrack(track("delayed-next"));
    const transition = player._transition;
    tick(transition.start + 0.01);
    assert.equal(player.currentTrack.id, "delayed-next");
    assert.deepEqual(transitions, ["delayed-next"]);
    tick(transition.end - latency + 0.03);
    assert.equal(transition.old.parts[0].source.disconnected, false, "the outgoing processor remains connected while delayed samples are fading");
    tick(transition.end + 0.03);
    assert.equal(transition.old.parts[0].pitch.port.closed, true);
    assert.equal(transition.old.parts[0].source.disconnected, true);
    player.dispose();
  }
  {
    const { player } = fixture({ Pitch: { ...FakePitch, async register() { throw new Error("Worklet registration failed"); } } });
    await assert.rejects(player.loadTrack(track("requires-pitch")), /Worklet registration failed/);
    assert.equal(player.status, "error");
    assert.equal(FakeContext.last.sources.length, 0, "processor failure cannot silently fall back to coupled pitch and speed");
    assert.equal(player.currentTrack, null);
    player.dispose();
  }
  {
    const { player, timers } = fixture();
    await player.loadTrack(track("processor-error")); await player.start();
    const part = player._active.parts[0];
    part.pitch.onprocessorerror();
    assert.equal(player.status, "error", "an audio-thread failure is exposed rather than silently losing pitch correction");
    assert.equal(player.transportClock(100).playing, false);
    assert.equal(part.pitch.port.closed, true);
    assert.equal(timers.size, 0);
    player.dispose();
  }
  {
    const { player, tick } = fixture();
    await player.loadTrack(track("rap-current", { generation_settings: { bpm: 112 } }));
    await player.start();
    await player.queueTrack(track("rap-next", { realtime: { generation_settings: { bpm: 140 } } }));
    tick(18);
    const before = player.transportClock(100);
    assert.equal(before.baseBpm, 112, "current track metadata supplies the requested tempo");
    assert.equal(player.transportClock(175).baseBpm, 112, "editing the next-track prompt cannot change the original track tempo");
    FakeContext.last.currentTime = player._transition.start + 0.01;
    const next = player.transportClock(100);
    assert.equal(player.currentTrack.id, "rap-current", "the timer has not promoted the pending deck yet");
    assert.equal(next.baseBpm, 140, "the voice clock follows the audible incoming deck before its UI promotion");
    assert.notEqual(next.token, before.token);
    assert.notEqual(next.transportToken, before.transportToken, "live beat followers also resynchronize to an incoming track");
    player.dispose();
  }
  {
    const { player, tick } = fixture();
    assert.equal(player.transportClock(120).context, null, "clock inspection never creates audio");
    assert.equal(player.transportClock(120).playing, false);
    await player.loadTrack(track("rap-grid"));
    const ctx = FakeContext.last;
    assert.equal(player.transportClock(120).context, ctx, "decoded/stopped players expose the unlocked context");
    await player.start();
    ctx.currentTime = 1.02;
    const clock = player.transportClock(120);
    assert.equal(clock.destination, ctx.destination);
    near(clock.beat, 2, "rap beat grid follows the audio deck");
    assert.equal(clock.bpm, 120);
    assert.equal(clock.valid, true);
    assert.equal(clock.estimated, true, "requested BPM is never described as audio beat detection");
    player.updateControls({ rate: 1.25 });
    assert.notEqual(player.transportClock(120).token, clock.token, "rate changes invalidate a rendered voice schedule");
    assert.equal(player.transportClock(120).transportToken, clock.transportToken, "mapped rate changes preserve a live beat follower's session");
    ctx.currentTime = 1.10;
    near(player.transportClock(120).bpm, 150, "the voice clock includes mapped playback rate");
    player.setSourceValid(false);
    assert.equal(player.transportClock(120).valid, false, "stale accompaniment also gates the voice");
    player.setSourceValid(true);
    assert.notEqual(player.transportClock(120).transportToken, clock.transportToken, "a source interruption invalidates old robot timing even after recovery");
    assert.equal(player.transportClock(NaN).valid, false);
    player.updateControls({ rate: 1 });
    const beforeLoop = player.transportClock(120);
    tick(21);
    assert.notEqual(player.transportClock(120).token, beforeLoop.token, "audio-thread fallback loops invalidate phase even if the UI timer is late");
    assert.notEqual(player.transportClock(120).transportToken, beforeLoop.transportToken, "looping also changes the live beat follower's phase");
    const beforeStop = player.transportClock(120);
    player.stop();
    assert.equal(player.transportClock(120).playing, false);
    assert.notEqual(player.transportClock(120).token, beforeStop.token);
    assert.notEqual(player.transportClock(120).transportToken, beforeStop.transportToken);
    player.dispose();
    assert.equal(player.transportClock(120).valid, false);
  }
  {
    const { player, assets } = fixture({ Pitch: { ...FakePitch, latencySeconds: () => 0.25 } });
    assets.set("/audio/mapped-robot", { decoded: buffer(60) });
    await player.loadTrack(track("mapped-robot", { generation_settings: { bpm: 120 } }));
    await player.start();
    const ctx = FakeContext.last, starts = [], stops = [], hits = [];
    const ready = token => ({ ok: true, performance: { token, state: "ready" } });
    const drums = context.HydraRobotDrums.createEngine({
      settings: { density: 100, instruments: [0, 1, 2, 3] }, now: () => ctx.currentTime * 1000,
      clock() {
        const clock = player.transportClock(120);
        return { ...clock, running: clock.playing && clock.valid, at: ctx.currentTime * 1000, token: clock.transportToken };
      },
      setInterval: () => 1, clearInterval() {},
      hardware: {
        snapshot: () => ({ drumsReady: true, drumTorqueEnabled: true, emergencyStopped: false }),
        startDrumming(payload) { starts.push(payload); return Promise.resolve(ready(payload.token)); },
        scheduleDrums(payload) { hits.push(...payload.events); return Promise.resolve(ready(payload.token)); },
        stopDrumming(payload) { stops.push(payload); return Promise.resolve({ ok: true }); }
      }
    });
    await drums.start();
    for (let index = 1; index <= 240; index++) {
      ctx.currentTime = index * 0.05;
      player.updateControls({ rate: 1 + 0.24 * Math.sin(index / 4) });
      assert.equal(player.transportClock(120).rateChanging, true, "the mapped speed never settles in this regression");
      drums.tick();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(starts.length, 1, "the audible clock's buffered ramps do not restart drum preparation");
    assert.equal(stops.length, 0);
    assert.equal(drums.snapshot().running, true);
    assert.ok(hits.length > 20, "Keirzo keeps scheduling hits while the real player clock changes continuously");
    assert.ok(hits.some(hit => hit.contactAt > 11000), "drumming continues throughout the mapped performance");
    await drums.stop();
    player.dispose();
  }
  {
    const { player, timers, tick } = fixture();
    assert.equal(player.status, "empty");
    await player.loadTrack(track("first", { plan_id: "plan-a" }));
    assert.equal(player.status, "ready");
    assert.equal(FakeContext.last.sources.length, 0, "decoding alone never starts audio");
    await player.start();
    const ctx = FakeContext.last, first = ctx.sources[0];
    assert.equal(player.status, "playing");
    assert.equal(first.loop, true, "audio thread loops safely while generation or a UI timer is late");
    assert.equal(first.loopEnd, 20);
    assert.equal(first.started.when, 0.02);
    ctx.currentTime = 10.02;
    near(player.currentPosition, 10, "source position");
    player.updateControls({ cutoff: 1250, resonance: 100, highpass: 150, gain: 0.5, pan: -0.7,
      rate: 1.25, delayMix: 1, reverbMix: 0.4 });
    assert.ok(player._lowpass.frequency.events.some((event) => event[0] === "target" && event[1] === 1250), "filter mappings change the actual AudioParam with smoothing");
    assert.equal(player._lowpass.Q.value, 12, "resonance is bounded");
    assert.equal(player._delayWet.gain.value, 0.85);
    assert.equal(player._feedback.gain.value, 0.42, "stronger repeats remain below unity feedback");
    assert.equal(player._panner.pan.value, -0.7);
    assert.equal(player._volume.gain.value, 0.5);
    assert.equal(player._highpass.frequency.value, 150);
    assert.equal(player._reverbWet.gain.value, 0.4);
    assert.ok(player._gate.connections.includes(player._panner));
    assert.ok(player._panner.connections.includes(player._limiter), "a compressor limits the final output including effects");
    ctx.currentTime = 10.10;
    near(player.currentPosition, 10.09, "rate ramps are integrated in playback position");
    near(player.remainingSeconds, (20 - 10.09) / 1.25, "remaining time follows playback rate");
    player.updateControls({ cutoff: NaN, gain: Infinity, rate: -20 });
    assert.equal(player.controls.cutoff, 1250);
    assert.equal(player.controls.gain, 0.5);
    assert.equal(player.controls.rate, 0.75);
    player.updateControls({ cutoff: 5000 }, false);
    assert.equal(player.sourceValid, false);
    assert.equal(player._gate.gain.value, 0, "stale data smoothly silences every audible path");
    assert.equal(player.controls.cutoff, 1250, "invalid data cannot change controls");
    player.updateControls({ cutoff: 900 }, true);
    assert.equal(player._gate.gain.value, 1, "fresh data restores playback");
    const callbacks = [...timers.values()].map((timer) => timer.callback);
    player.stop();
    assert.equal(player.status, "stopped");
    assert.equal(timers.size, 0);
    assert.ok(first.disconnected && first.stops.length);
    callbacks.forEach((callback) => callback());
    assert.equal(ctx.sources.length, 1, "already-dispatched callbacks cannot create sound after stop");
    await player.start();
    tick(ctx.currentTime + 1);
    player.dispose();
    assert.equal(player.status, "disposed");
    assert.equal(player.decodedBytes, 0);
    assert.equal(ctx.closed, true);
    assert.equal(timers.size, 0);
  }
  {
    const transitions = [];
    const { player, tick } = fixture({ onTransition: (value) => transitions.push(value.id) });
    await player.loadTrack(track("original"));
    await player.start();
    const ctx = FakeContext.last;
    tick(18.0);
    assert.equal(ctx.sources.length, 2, "the current sample crossfades its own seam when the next generation is late");
    const loop = player._transition;
    assert.equal(loop.reason, "loop");
    near(loop.start, 18.02, "loop fade starts before the end");
    near(loop.end, 20.02, "loop fade finishes at the old source boundary");
    tick(20.1);
    assert.equal(player.currentTrack.id, "original");
    assert.deepEqual(transitions, [], "a fallback loop does not masquerade as a new generation");
    assert.equal(ctx.sources[0].disconnected, true);
    assert.equal(ctx.sources[1].loop, true);
    // Simulate a tab being suspended for multiple complete loops: audio thread
    // sources keep running, and the next scheduler pass uses the current phase.
    tick(65);
    assert.equal(player.status, "playing");
    assert.ok(ctx.sources[1].stops.length === 0);
    await player.queueTrack(track("next", { plan_id: "plan-b" }));
    assert.equal(player.queuedTrack.id, "next");
    const phase = player.currentPosition;
    tick(ctx.currentTime + (20 - phase) - 1.95);
    const replacement = player._transition;
    assert.equal(replacement.reason, "crossfade");
    assert.equal(replacement.next.parts[0].source.started.when, replacement.start);
    assert.equal(player.queuedTrack.id, "next", "a scheduled replacement remains visible until it is audible");
    tick(replacement.start + 0.001);
    assert.equal(player.currentTrack.id, "next");
    assert.equal(player.currentTrack.plan_id, "plan-b", "track metadata survives preparation and transitions");
    assert.equal(player.queuedTrack, null);
    assert.deepEqual(transitions, ["next"]);
    tick(replacement.end + 0.03);
    assert.equal(player._transition, null);
    assert.equal(replacement.old.parts[0].source.disconnected, true);
    assert.equal(ctx.sources.filter((source) => !source.disconnected).length, 1, "retired sources are disconnected");
    player.stop();
  }
  {
    const transitions = [];
    const { player, tick } = fixture({ onTransition: (value) => transitions.push(value.id) });
    await player.loadTrack(track("prompt-original"));
    await player.start();
    await player.queueTrack(track("old-direction"));
    assert.equal(player.clearQueuedTrack(), true);
    assert.equal(player.queuedTrack, null, "a prompt edit removes a ready but unplayed spare");
    await player.queueTrack(track("old-direction"));
    tick(17.9);
    const canceled = player._transition, original = canceled.old;
    assert.equal(canceled.reason, "crossfade");
    assert.equal(player.clearQueuedTrack(), true, "a scheduled track can still be replaced until the audio fade starts");
    assert.equal(player._transition, null);
    assert.equal(canceled.next.parts[0].source.disconnected, true);
    assert.equal(original.parts[0].source.stops.length, 0, "withdrawing a scheduled fade cannot leave a pending stop on the playing source");
    assert.equal(original.gain.gain.value, 1);
    assert.equal(player.currentTrack.id, "prompt-original");
    await player.queueTrack(track("latest-direction"));
    const latest = player._transition;
    tick(latest.start + 0.01);
    assert.equal(player.currentTrack.id, "latest-direction");
    assert.deepEqual(transitions, ["latest-direction"], "the obsolete prompt never becomes the audible next song");
    assert.equal(player.clearQueuedTrack(), false, "a fade which is already audible continues smoothly");
    assert.equal(player._transition, latest);
    await player.queueTrack(track("following-spare"));
    assert.equal(player.queuedTrack.id, "following-spare");
    assert.equal(player.clearQueuedTrack(), false);
    assert.equal(player.queuedTrack, null, "a following spare can be removed while the current transition finishes");
    assert.equal(player._transition, latest);
    assert.equal(player.currentTrack.id, "latest-direction");
    tick(latest.end + 0.03);
    assert.equal(original.parts[0].source.disconnected, true);
    player.dispose();
  }
  {
    const transitions = [];
    const { player, tick } = fixture({ onTransition: (value) => transitions.push(value.id) });
    await player.loadTrack(track("original-clock")); await player.start();
    await player.queueTrack(track("audible-before-ui")); tick(17.9);
    const pending = player._transition;
    assert.equal(player.transportTrack.id, "original-clock");
    FakeContext.last.currentTime = pending.start + 0.01;
    assert.equal(player.currentTrack.id, "original-clock", "simulate audio starting between scheduler ticks");
    assert.equal(player.transportTrack.id, "audible-before-ui", "tempo metadata follows the audible deck before a delayed UI tick promotes it");
    assert.equal(player.clearQueuedTrack(), false);
    assert.equal(player.currentTrack.id, "audible-before-ui", "clearing synchronizes metadata to the real audio clock before generating another song");
    assert.deepEqual(transitions, ["audible-before-ui"]);
    player.dispose();
  }
  {
    const { player, tick, assets } = fixture();
    assets.set("/audio/decoded-short", { decoded: buffer(8) });
    await player.loadTrack(track("decoded-short", { requested_duration_seconds: 60 }));
    await player.start(); tick(5.9);
    const fallback = player._transition;
    assert.equal(fallback.reason, "loop");
    assert.equal(player.queuedTrack, null, "a backup repeat is not reported as a generated next song");
    await player.queueTrack(track("just-in-time"));
    assert.equal(fallback.next.parts[0].source.disconnected, true, "a prepared spare replaces a fallback repeat that has not started yet");
    assert.equal(player._transition.reason, "crossfade");
    near(player._transition.end, 8.02, "automatic handoff uses decoded duration rather than requested metadata");
    tick(player._transition.start + 0.01);
    assert.equal(player.currentTrack.id, "just-in-time");
    player.dispose();
  }
  {
    const { player, tick } = fixture();
    const firstStems = Array.from({ length: 6 }, (_, index) => ({ name: `Old ${index}`, audio_url: `/old-stem-${index}` }));
    const nextStems = Array.from({ length: 6 }, (_, index) => ({ name: `New ${index}`, audio_url: `/new-stem-${index}` }));
    await player.loadTrack(track("old-mute-set", { stems: firstStems }));
    await player.start();
    const names = [...firstStems, ...nextStems].map((stem) => stem.name);
    player.updateControls({ stemGains: Object.fromEntries(names.map((name) => [name, 0])),
      stemControls: Object.fromEntries(names.map((name) => [name, { gain: 1, cutoff: 1200 }])) });
    await player.queueTrack(track("new-mute-set", { stems: nextStems }));
    tick(18);
    const fading = player._transition;
    assert.equal(player.playingStemNames.length, 12, "both sides of a crossfade expose their stem names");
    tick(fading.start + 0.01);
    assert.equal(player.currentTrack.id, "new-mute-set");
    assert.equal(player.playingStemNames.length, 12, "old names remain visible until their fade completes");
    for (const deck of [fading.old, fading.next]) for (const part of deck.parts) {
      assert.equal(part.gain.gain.value, 0, "all twelve stem controls survive a crossfade between different names");
      assert.equal(part.lowpass.frequency.value, 1200);
    }
    tick(fading.end + 0.03);
    assert.deepEqual([...player.playingStemNames], nextStems.map((stem) => stem.name));
    player.stop();
  }
  {
    const { player, assets, tick } = fixture();
    const stems = [{ name: "bass", audio_url: "/bass" }, { name: "drums", audio_url: "/drums" }];
    await player.loadTrack(track("stems", { stems }));
    assert.deepEqual([...player.stemNames], ["bass", "drums"]);
    player.updateControls({ stemGains: { bass: 0, drums: 0.6 } });
    await player.start();
    const ctx = FakeContext.last, [bass, drums] = player._active.parts;
    assert.equal(bass.gain.gain.value, 0);
    assert.equal(drums.gain.gain.value, 0.6);
    assert.equal(bass.source.started.when, drums.source.started.when, "stems start on the same audio clock sample");
    assert.equal(ctx.sources.length, 2, "the full mix must not play on top of its stems");
    ctx.currentTime = 4;
    player.updateControls({ rate: 1.1, stemGains: { bass: 0.3, drums: 0 } });
    assert.equal(bass.gain.gain.value, 0.3);
    assert.equal(drums.gain.gain.value, 0);
    assert.deepEqual(bass.source.playbackRate.events, drums.source.playbackRate.events, "all stems share playback rate automation");
    player.stop();
    assets.set("/bad-duration", { decoded: buffer(7) });
    await player.loadTrack(track("unaligned", { stems: [{ name: "drums", audio_url: "/bad-duration" }] }));
    assert.deepEqual([...player.stemNames], []);
    assert.match(player.warnings[0], /duration does not align/);
    await player.start();
    tick(18);
    player.stop();
  }
  {
    const { player, assets } = fixture();
    assets.set("/missing", { error: "File unavailable" });
    await player.loadTrack(track("fallback", { stems: [{ name: "drums", audio_url: "/missing" }] }));
    assert.deepEqual([...player.stemNames], []);
    assert.match(player.warnings[0], /original mix/);
    await player.start();
    assert.equal(FakeContext.last.sources.length, 1);
    assets.set("/audio/broken", { fail: true });
    await assert.rejects(player.queueTrack(track("broken")), /Corrupt audio/);
    assert.equal(player.status, "playing", "a failed replacement leaves the current audio playing");
    assert.equal(player.currentTrack.id, "fallback");
    player.stop();
  }
  {
    const { player, assets, tick } = fixture();
    const stems = [{ name: "Bass", audio_url: "/strict-bass" }, { name: "Drums", audio_url: "/strict-drums" }];
    await player.loadTrack(track("strict-current", { stems }), { requireStems: true });
    player.updateControls({ stemGains: { Bass: 0, Drums: 0.7 } }); await player.start();
    assets.set("/unavailable-stem", { error: "File unavailable" });
    const broken = track("strict-next", { stems: [{ name: "Bass", audio_url: "/unavailable-stem" }] });
    await assert.rejects(player.queueTrack(broken, { requireStems: true }), /saved stems could not be loaded/);
    assert.equal(player.queuedTrack, null, "strict queue failures cannot install a fullmix replacement");
    assert.equal(player.currentTrack.id, "strict-current");
    assert.equal(player._active.parts[0].gain.gain.value, 0, "failed preparation leaves current mutes intact");
    tick(18); tick(18.1);
    assert.equal(player._transition.reason, "loop", "the last working stems repeat when replacement preparation fails");
    assert.equal(player._transition.next.parts[0].gain.gain.value, 0);
    tick(20.1);
    assets.delete("/unavailable-stem");
    await player.queueTrack(broken, { requireStems: true });
    assert.equal(player.queuedTrack.id, "strict-next", "a later valid replacement remains possible after failure");
    player.stop();
    assets.set("/missing-first-stem", { error: "File unavailable" });
    await assert.rejects(player.loadTrack(track("strict-load", { stems: [{ name: "Bass", audio_url: "/missing-first-stem" }] }),
      { requireStems: true }), /saved stems could not be loaded/);
    assert.equal(player.currentTrack, null, "strict initial loads also cannot install an unmuted fullmix");
    player.dispose();
  }
  {
    const { player, tick } = fixture();
    const stems = [{ name: "Bass", audio_url: "/isolated-bass" }, { name: "Drums", audio_url: "/isolated-drums" }];
    await player.loadTrack(track("stem-effects", { stems }));
    player.updateControls({ cutoff: 9000, stemGains: { Bass: 0.5 }, stemControls: {
      Bass: { cutoff: 450, resonance: 3, highpass: 80, gain: 0.4, pan: -0.6, delayMix: 0.2, reverbMix: 0.3 },
      Drums: { cutoff: 11000, pan: 0.2 }
    } });
    await player.start();
    const [bass, drums] = player._active.parts;
    assert.equal(bass.lowpass.frequency.value, 450, "a Bass filter acts on the Bass graph");
    assert.equal(drums.lowpass.frequency.value, 11000, "Drums has a separate filter");
    assert.equal(player._lowpass.frequency.value, 9000, "the master remains independent");
    assert.equal(bass.highpass.frequency.value, 80);
    assert.equal(bass.lowpass.Q.value, 3);
    near(bass.gain.gain.value, 0.2, "mapping volume multiplies the manual stem mixer");
    assert.equal(bass.pan.pan.value, -0.6);
    assert.equal(bass.delayWet.gain.value, 0.2);
    assert.equal(bass.reverbWet.gain.value, 0.3);
    assert.ok(bass.source.connections.includes(bass.pitch));
    assert.ok(bass.pitch.connections.includes(bass.highpass));
    assert.ok(bass.reverbWet.connections.includes(bass.gain), "stem volume controls effect tails too");
    assert.ok(bass.pan.connections.includes(player._active.gain), "every stem effect still passes through the master and stale-input gate");
    assert.equal(bass.reverb.buffer, player._convolver.buffer, "stems share the immutable impulse buffer");
    const copy = player.controls;
    copy.stemControls.Bass.cutoff = 1;
    assert.equal(player.controls.stemControls.Bass.cutoff, 450, "control snapshots cannot mutate live settings");
    player.updateControls({ stemGains: { Bass: 0 }, stemControls: {
      Bass: { gain: 1, delayMix: 0.65, reverbMix: 0.65 }, Drums: { gain: 0.7 }
    } });
    assert.equal(bass.gain.gain.value, 0, "a manual mute overrides mapped volume and both stem wet paths");
    assert.equal(drums.gain.gain.value, 0.7, "muting one stem leaves other stems audible");
    player.updateControls({ stemGains: { Bass: 0.5 } });
    assert.equal(bass.gain.gain.value, 0.5, "unmute can restore the remembered mix level without resetting the mapping");
    player.updateControls({ stemControls: { Bass: { cutoff: 800, resonance: 900, delayMix: 3, rate: 0.5 } } });
    assert.equal(bass.lowpass.frequency.value, 800);
    assert.equal(bass.lowpass.Q.value, 12, "stem resonance is bounded");
    assert.equal(bass.delayWet.gain.value, 0.85, "stem wet levels are bounded");
    assert.equal(bass.feedback.gain.value, 0.42, "stem repeats use the stronger feedback too");
    assert.equal(drums.lowpass.frequency.value, 20000, "removing a mapped stem effect restores its default");
    assert.equal(bass.source.playbackRate.value, drums.source.playbackRate.value, "per-stem speed cannot break alignment");
    assert.equal(player.controls.stemControls.Bass.rate, undefined);
    await player.queueTrack(track("replacement-stems", { stems }));
    tick(18);
    const transition = player._transition;
    assert.equal(transition.next.parts[0].lowpass.frequency.value, 800, "stem mappings carry across generated segments");
    player.updateControls({ stemControls: { Bass: { cutoff: 1200, pan: 0.5 } } });
    for (const deck of [transition.old, transition.next]) {
      assert.equal(deck.parts[0].lowpass.frequency.value, 1200, "both sides of a crossfade follow mapped stem effects");
      assert.equal(deck.parts[0].pan.pan.value, 0.5);
    }
    player.updateControls({ stemGains: { Bass: 0 } });
    assert.equal(transition.old.parts[0].gain.gain.value, 0);
    assert.equal(transition.next.parts[0].gain.gain.value, 0, "a mute covers both sides of a segment crossfade");
    player.updateControls({ stemControls: { Missing: { cutoff: 20 } } });
    assert.equal(bass.lowpass.frequency.value, 20000);
    assert.equal(player._lowpass.frequency.value, 9000, "an unavailable stem never redirects its effect to master");
    player.updateControls({}, false);
    assert.equal(player._gate.gain.value, 0, "stale data silences the master after all stem effects");
    const parts = [...transition.old.parts, ...transition.next.parts];
    player.stop();
    assert.ok(parts.every(part => part.nodes.every(node => node.disconnected)), "stop disconnects all per-stem effects, including feedback loops");
  }
  {
    const { player, tick, timers } = fixture();
    player.onTransition = () => player.stop();
    await player.loadTrack(track("stop-on-transition"));
    await player.start();
    await player.queueTrack(track("last"));
    tick(18.0);
    tick(18.03);
    assert.equal(player.status, "stopped");
    assert.equal(timers.size, 0, "a transport callback may stop a transition without restarting the scheduling timer");
  }
  {
    let finishDecode, decodeStarted;
    const decoding = new Promise((resolve) => { decodeStarted = resolve; });
    class SlowContext extends FakeContext {
      decodeAudioData() { decodeStarted(); return new Promise((resolve) => { finishDecode = resolve; }); }
    }
    const { player, timers } = fixture({ AudioContext: SlowContext });
    const loading = player.loadTrack(track("slow"), { autostart: true });
    await decoding;
    player.stop();
    finishDecode(buffer());
    assert.equal(await loading, false);
    assert.equal(FakeContext.last.sources.length, 0, "a decode completed after stop must not start playback");
    assert.equal(timers.size, 0);
    assert.equal(player.currentTrack, null);
    player.dispose();
  }
  {
    let resolveFetch, fetchStarted;
    const fetching = new Promise(resolve => { fetchStarted = resolve; });
    const { player } = fixture();
    await player.loadTrack(track("current"));
    await player.start();
    player._fetch = () => new Promise((resolve) => { resolveFetch = resolve; fetchStarted(); });
    const queued = player.queueTrack(track("slow-next"));
    await fetching;
    player.stop();
    resolveFetch({ ok: true, arrayBuffer: async () => ({ decoded: buffer() }) });
    assert.equal(await queued, false);
    assert.equal(player.queuedTrack, null);
    assert.equal(FakeContext.last.sources.length, 1, "a stale queued fetch cannot revive the stopped player");
  }
  {
    let resolveOld, fetchStarted;
    const fetching = new Promise(resolve => { fetchStarted = resolve; });
    const { player } = fixture();
    await player.loadTrack(track("keeps-playing")); await player.start();
    const regularFetch = player._fetch;
    player._fetch = (url, request) => url === "/audio/obsolete-decode" ? new Promise((resolve) => { resolveOld = resolve; fetchStarted(); }) : regularFetch(url, request);
    const old = player.queueTrack(track("obsolete-decode"));
    await fetching;
    assert.equal(player.clearQueuedTrack(), true);
    const latest = player.queueTrack(track("latest-decode"));
    resolveOld({ ok: true, arrayBuffer: async () => ({ decoded: buffer() }) });
    assert.equal(await old, false, "a stale response cannot install an obsolete prompt after cancellation");
    assert.equal(await latest, true);
    assert.equal(player.queuedTrack.id, "latest-decode");
    assert.equal(player.currentTrack.id, "keeps-playing");
    assert.equal(player._cache.has("/audio/obsolete-decode"), false);
    player.dispose();
  }
  {
    const { player, assets, tick } = fixture();
    const names = ["Bass", "Drums", "Guitar", "Piano", "Other", "Vocals"];
    const longTrack = (id) => {
      const audio = track(id, { stems: names.map((name) => ({ name, audio_url: `/audio/${id}/${name}` })) });
      for (const url of [audio.audio_url, ...audio.stems.map((stem) => stem.audio_url)]) {
        // Realistic decoded sizing without allocating hundreds of megabytes.
        assets.set(url, { decoded: { duration: 60.04, length: 60.04 * 48000, numberOfChannels: 2 } });
      }
      return audio;
    };
    await player.loadTrack(longTrack("long-current"));
    await player.start();
    player.updateControls({ stemGains: { Drums: 0.2, Bass: 0.6 } });
    await player.queueTrack(longTrack("long-next"));
    assert.equal(player._queued.parts.length, 6, "default 60-second segments must retain all queued stems alongside the playing stems");
    assert.deepEqual([...player._queued.warnings], [], "normal 48 kHz stereo stem playback must not fall back to the full mix");
    assert.ok(player.decodedBytes <= player.maxDecodedBytes, "the larger default still enforces its decoded memory bound");
    tick(58.04);
    tick(58.08);
    assert.equal(player.currentTrack.id, "long-next");
    assert.deepEqual([...player.stemNames], names, "stem controls survive a default-duration transition");
    assert.equal(player._active.parts.find((part) => part.name === "Drums").gain.gain.value, 0.2);
    assert.equal(player._active.parts.find((part) => part.name === "Bass").gain.gain.value, 0.6);
    tick(60.12);
    await player.queueTrack(longTrack("long-third"));
    assert.equal(player._queued.parts.length, 6, "later segments can evict obsolete stems while retaining the current track");
    assert.ok(player.decodedBytes <= player.maxDecodedBytes, "rolling through more segments cannot grow the cache beyond its bound");
    player.dispose();
  }
  {
    const { player, assets, requests } = fixture({ maxDecodedBytes: 1024 * 1024 });
    for (const id of ["a", "b", "c"]) assets.set(`/audio/${id}`, { decoded: buffer(60) });
    await player.loadTrack(track("a"));
    await player.loadTrack(track("b"));
    await player.loadTrack(track("c"));
    assert.ok(player.decodedBytes <= 1024 * 1024, "decoded cache has a firm memory limit");
    assert.equal(player._cache.has("/audio/a"), false, "least recently used unreferenced audio is evicted");
    await player.loadTrack(track("b"));
    assert.equal(requests.filter((request) => request.url === "/audio/b").length, 1, "cached saved audio is reused");
    await player.start();
    await player.queueTrack(track("c"));
    assert.ok(player._cache.has("/audio/b"), "an audible buffer is protected from eviction");
    player.dispose();
  }
  {
    let releaseResume;
    class SlowResumeContext extends FakeContext { resume() { return new Promise((resolve) => { releaseResume = resolve; }); } }
    const { player } = fixture({ AudioContext: SlowResumeContext });
    await player.loadTrack(track("resume"));
    const starting = player.start();
    player.stop();
    releaseResume();
    assert.equal(await starting, false);
    assert.equal(FakeContext.last.sources.length, 0, "a delayed browser permission/resume cannot restart stopped audio");
    player.dispose();
  }
  console.log("ElevenLabs player: realtime DSP, looping/crossfades, stems, memory bounds and cancellation tests passed.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
