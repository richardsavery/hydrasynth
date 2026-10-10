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
  constructor() { this.currentTime = 0; this.sampleRate = 48000; this.sources = []; this.nodes = []; this.destination = {}; this.resumeCalls = 0; FakeContext.last = this; }
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
const context = vm.createContext({ console, AbortController, setTimeout, clearTimeout, Float32Array });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/elevenlabs-player.js"), "utf8"), context);
const { Player } = context.HydraElevenPlayer;
const track = (id, extra = {}) => ({ id, audio_url: `/audio/${id}`, ...extra });
function fixture(options = {}) {
  const timers = new Map(), requests = [], assets = new Map();
  let nextTimer = 0;
  const player = new Player({ AudioContext: FakeContext,
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
    assert.equal(player._delayWet.gain.value, 0.65);
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
    let resolveFetch;
    const { player } = fixture();
    await player.loadTrack(track("current"));
    await player.start();
    player._fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
    const queued = player.queueTrack(track("slow-next"));
    await Promise.resolve();
    player.stop();
    resolveFetch({ ok: true, arrayBuffer: async () => ({ decoded: buffer() }) });
    assert.equal(await queued, false);
    assert.equal(player.queuedTrack, null);
    assert.equal(FakeContext.last.sources.length, 1, "a stale queued fetch cannot revive the stopped player");
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
