"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto").webcrypto;
const context = vm.createContext({ console, AbortController, crypto });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/midi-safety.js"), "utf8"), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/sonification.js"), "utf8"), context);
const Safety = context.HydraMidiSafety;
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  let time = 0, next = 0;
  const timers = new Map(), sent = [], queued = [], active = new Map(), sustain = new Set();
  const keys = new Set(), sustained = new Set();
  let pedal = false;
  const options = { now: () => time, schedule(fn, ms) { timers.set(++next, { fn, at: time + ms }); return next; }, cancel(id) { timers.delete(id); } };
  function deliver(bytes) {
    const [kind, note, value] = bytes;
    if (kind === 0x90) keys.add(note);
    if (kind === 0x80) { keys.delete(note); if (pedal) sustained.add(note); }
    if (kind === 0xB0 && note === 64) { pedal = value > 0; if (!pedal) sustained.clear(); }
    // ASM assigns CC120 to ARP Octave, so it cannot silence a stuck note.
    if (kind === 0xB0 && note === 123) { keys.clear(); sustained.clear(); }
  }
  const output = { name: "HYDRASYNTH EXPLORER MIDI 1", send(bytes, timestamp) {
    sent.push({ bytes: [...bytes], timestamp });
    if (timestamp > time) queued.push({ bytes: [...bytes], at: timestamp }); else deliver(bytes);
  } };
  const notes = Safety.createNotes({ ...options, active, sustain });
  return { ...options, timers, sent, queued, active, sustain, keys, sustained, output, notes,
    advanceNative(ms) { time += ms; for (const entry of [...queued]) if (entry.at <= time) { queued.splice(queued.indexOf(entry), 1); deliver(entry.bytes); } },
    async flushTimers() {
      for (const [id, task] of [...timers]) if (task.at <= time && timers.has(id)) { timers.delete(id); task.fn(); }
      await settle();
    }
  };
}

function appFixture(send) {
  const h = fixture(), calls = [], errors = [];
  const sandbox = vm.createContext({ console, AbortController, crypto, URLSearchParams,
    document: { addEventListener() {} },
    window: { setTimeout: h.schedule, clearTimeout: h.cancel },
    performance: { now: h.now }, localStorage: { getItem() { return null; } },
    fetch: async (url, options) => {
      calls.push(url);
      const result = await send(url.split("/").at(-1), JSON.parse(options.body));
      return { ok: result.ok !== false, status: result.status || 200, json: async () => result };
    }, testError: message => errors.push(message)
  });
  for (const file of ["drums.js", "sonification.js", "parameters.js", "midi-safety.js", "app.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard", file), "utf8"), sandbox, { filename: file });
  vm.runInContext(`
    activeSynthMixer = () => ({ reset() {} });
    playbackUnavailableReason = () => "";
    readPlaybackControls = () => ({ soundMode: "off" });
    for (const name of ["renderPlaybackAvailability", "updatePlayhead", "renderRhythm", "startParameterPump", "stopAudioVoices", "publishSignalLabActivity"])
      globalThis[name] = () => {};
    showToast = testError;
    runPlaybackTick = () => { if (state.output === "midi") playMidiNote(60, 90, 200); };
    ensureAudioEngine = async () => {};
    state.workspaceView = "synth-mixer";
    state.output = state.synthOutput = "midi";
    dom["preview-button"] = { classList: { add() {}, remove() {} } };
    dom["session-state"] = {};
    globalThis.api = { state, togglePlayback, stopPlayback, playMidiNote, panicMidi };
  `, sandbox);
  sandbox.api.state.midiOutput = h.output;
  return { ...h, ...sandbox.api, calls, errors };
}

async function main() {
  {
    const h = appFixture(async () => ({ ok: true }));
    h.output.send([0x90, 60, 90]);
    h.output.send([0xB0, 120, 0]);
    assert.equal(h.keys.has(60), true, "the fixture follows Hydrasynth's CC120 meaning");
    h.sent.length = 0;
    h.panicMidi();
    assert.deepEqual(h.sent.map(item => item.bytes), [[0xB0, 64, 0],
      ...Array.from({ length: 128 }, (_, note) => [0x80, note, 0]), [0xB0, 123, 0]]);
    assert.equal(h.keys.size, 0, "panic releases notes absent from the page's ledger");
  }
  {
    const h = fixture();
    assert.equal(Safety.MAX_NOTE_MS, 5000);
    const slowest = context.HydraSonification.rhythmStep({ tempo: 20, stepsPerBeat: 1, swing: 65,
      ratchet: 1, gate: 100, density: 16, chance: 100 }, 0);
    assert.equal(slowest.notes[0].duration, 4653, "the longest current rhythm gate fits the handover bound");
    for (const duration of [5000.01, Infinity, NaN])
      assert.throws(() => h.notes.play(h.output, 60, 90, duration), /five seconds/);
    assert.equal(h.sent.length, 0, "overlong notes fail before any MIDI is sent");
    assert.equal(h.notes.play(h.output, 60, 90, 5000), true);
    assert.equal(h.queued[0].at, 5000);
  }
  {
    const h = fixture();
    for (const pitch of [60, 64, 67]) assert.equal(h.notes.play(h.output, pitch, 90, 200), true);
    assert.deepEqual([...h.keys], [60, 64, 67]);
    assert.equal(h.queued.length, 3, "all note-offs are handed to native MIDI immediately");
    h.advanceNative(200); // No JavaScript timer executes while the page is frozen.
    assert.equal(h.keys.size, 0, "the complete chord ends even when every JS callback is frozen");
    const sent = h.sent.length;
    await h.flushTimers();
    assert.equal(h.sent.length, sent, "cleanup callbacks never emit MIDI");
    assert.equal(h.active.size, 0);
  }
  {
    const h = fixture();
    h.notes.play(h.output, 60, 90, 200);
    const oldCleanup = [...h.timers.values()][0].fn;
    oldCleanup();
    assert.equal(h.notes.play(h.output, 60, 100, 500), false, "an early cleanup cannot erase a future native deadline");
    assert.equal(h.notes.play(h.output, 60, 100, 500), false, "overlapping same-pitch retriggers cannot inherit an old release");
    h.notes.stop();
    assert.equal(h.keys.size, 0);
    assert.equal(h.notes.play(h.output, 60, 100, 500), false, "Stop cannot retract a queued note-off in Chromium");
    h.advanceNative(201);
    assert.equal(h.notes.play(h.output, 60, 100, 500), true);
    oldCleanup();
    assert.equal(h.active.size, 1, "a stale cleanup cannot remove the restarted note");
    assert.equal(h.keys.size, 1);
    h.advanceNative(500);
    assert.equal(h.keys.size, 0);
  }
  {
    const h = fixture(), other = { send() {} };
    h.notes.play(h.output, 60, 90, 200);
    assert.equal(h.notes.play(other, 60, 90, 200), true, "release deadlines are scoped to the physical output");
    h.output.send([0xB0, 64, 127]); h.sustain.add(h.output);
    h.advanceNative(250);
    assert.equal(h.sustained.size, 1, "a scheduled note-off alone does not defeat sustain");
    await h.flushTimers();
    h.notes.stop();
    assert.equal(h.sustained.size, 0, "Stop still releases sustain after note cleanup");
    h.notes.play(other, 62, 80, 100);
    other.send = () => { throw new Error("disconnected"); };
    assert.doesNotThrow(() => h.notes.stop(), "disconnect cannot interrupt cleanup");
  }
  {
    const h = fixture(), failures = [], calls = [];
    let lease = null, serial = 0;
    const send = async (method, body) => {
      calls.push({ method, body });
      if (method === "arm") {
        lease = { id: `lease-${++serial}`, deadline: h.now() + 2500 };
        return { ok: true, lease_id: lease.id, heartbeat_ms: 500, timeout_ms: 2500 };
      }
      if (!lease || body.lease_id !== lease.id || h.now() >= lease.deadline) throw new Error("Stale MIDI safety lease");
      if (method === "heartbeat") lease.deadline = h.now() + 2500;
      if (method === "disarm") { h.output.send([0xB0, 64, 0]); h.output.send([0xB0, 123, 0]); lease = null; }
      return { ok: true };
    };
    const guard = Safety.createGuard({ ...h, send, onFailure(error) { failures.push(error.message); h.notes.stop(); } });
    await guard.arm(h.output, 1);
    guard.assertReady(h.output);
    assert.deepEqual({ ...calls[0].body }, { port_name: h.output.name, channel: 1, owner_id: calls[0].body.owner_id });
    assert.match(calls[0].body.owner_id, /^[0-9a-f]{32}$/);
    h.output.send([0xB0, 64, 127]); h.sustain.add(h.output);
    h.notes.play(h.output, 60, 90, 200);
    h.advanceNative(500); await h.flushTimers();
    assert.equal(calls.filter(call => call.method === "heartbeat").length, 1);
    h.advanceNative(2600); // Simulate renderer death; backend deadline remains independent.
    if (lease && h.now() >= lease.deadline) { h.output.send([0xB0, 64, 0]); h.output.send([0xB0, 123, 0]); lease = null; }
    assert.equal(h.sustained.size, 0, "the server watchdog can silence sustained notes without JS");
    assert.throws(() => guard.assertReady(h.output), /expired/, "a recovered JS thread cannot resume an expired session");
    await h.flushTimers();
    assert.equal(failures.length, 1, "expiry is reported once");
    assert.equal(h.active.size, 0);
  }
  {
    const h = fixture(), pending = deferred(), calls = [];
    const guard = Safety.createGuard({ ...h, send: async (method, body) => {
      calls.push({ method, body });
      if (method === "arm") return pending.promise;
      return { ok: true };
    } });
    const arming = guard.arm(h.output, 1);
    await settle();
    const stopped = guard.stop();
    pending.resolve({ ok: true, lease_id: "late", heartbeat_ms: 500, timeout_ms: 2500 });
    assert.equal(await arming, false, "Stop cancels an arm that was already in flight");
    await stopped;
    assert.deepEqual(calls.map(call => call.method), ["arm", "disarm"]);
    assert.equal(calls[1].body.lease_id, "late");
    assert.throws(() => guard.assertReady(h.output), /expired/);
    assert.equal(h.timers.size, 0);
  }
  {
    const h = fixture(), disarm = deferred(), calls = [];
    const owners = [];
    let count = 0;
    const guard = Safety.createGuard({ ...h, send: async (method, body) => {
      calls.push(method);
      if (method === "arm") { owners.push(body.owner_id); return { ok: true, lease_id: `lease-${++count}`, heartbeat_ms: 500, timeout_ms: 2500 }; }
      if (method === "disarm" && body.lease_id === "lease-1") return disarm.promise;
      return { ok: true };
    } });
    await guard.arm(h.output, 1);
    const stopped = guard.stop(), restarted = guard.arm(h.output, 1);
    await settle();
    assert.deepEqual(calls, ["arm", "disarm"], "restart waits for the previous native panic");
    disarm.resolve({ ok: true }); await stopped;
    assert.equal(await restarted, true);
    assert.deepEqual(calls, ["arm", "disarm", "arm"]);
    assert.equal(owners[0], owners[1], "ordinary Stop/Play retains the page's ownership and release deadlines");
    await guard.stop();
    assert.equal(h.timers.size, 0);
    const reloaded = Safety.createGuard({ ...h, send: async (method, body) => {
      if (method === "arm") {
        assert.notEqual(body.owner_id, owners[0], "a reloaded page gets a new owner and cannot bypass handover");
        return { ok: true, lease_id: "reloaded", heartbeat_ms: 500, timeout_ms: 2500 };
      }
      return { ok: true };
    } });
    await reloaded.arm(h.output, 1); await reloaded.stop();
  }
  {
    const h = fixture(), failures = [];
    const guard = Safety.createGuard({ ...h, send: async method => {
      if (method === "arm") return { ok: true, lease_id: "one", heartbeat_ms: 500, timeout_ms: 2500 };
      if (method === "heartbeat") throw new Error("Stale MIDI safety lease");
      return { ok: true };
    }, onFailure: error => failures.push(error.message) });
    await guard.arm(h.output, 1);
    h.advanceNative(500); await h.flushTimers();
    assert.match(failures[0], /Stale/);
    assert.throws(() => guard.assertReady(h.output), /expired/);
    assert.equal(h.timers.size, 0);
  }
  {
    const h = fixture();
    const guard = Safety.createGuard({ ...h, send: () => new Promise(() => {}) });
    const arming = guard.arm(h.output, 1);
    const rejection = assert.rejects(arming, /stopped responding/);
    await settle(); h.advanceNative(2000); await h.flushTimers(); await rejection;
    assert.throws(() => guard.assertReady(h.output), /expired/);
    assert.equal(h.timers.size, 0);
  }
  {
    const pending = deferred();
    const h = appFixture(async method => method === "arm" ? pending.promise : { ok: true });
    const starting = h.togglePlayback(); await settle();
    assert.equal(h.state.preparing, true);
    assert.equal(h.sent.length, 0, "actual app transport awaits native guard before any notes");
    h.stopPlayback();
    pending.resolve({ ok: true, lease_id: "cancelled", heartbeat_ms: 500, timeout_ms: 2500 });
    await starting; await settle();
    assert.equal(h.state.playing, false);
    assert.equal(h.state.preparing, false);
    assert.equal(h.sent.length, 0, "a delayed arm response cannot revive stopped transport");
    assert.ok(h.calls.includes("/api/midi-safety/disarm"));
  }
  {
    const h = appFixture(async method => method === "arm"
      ? { ok: true, lease_id: "active", heartbeat_ms: 500, timeout_ms: 2500 }
      : { ok: false, status: 409, error: "MIDI lease was replaced" });
    await h.togglePlayback();
    assert.equal(h.state.playing, true);
    assert.equal(h.queued.length, 1, "the app queues the release when the first note starts");
    h.advanceNative(500);
    const beforeFailure = h.sent.length;
    await h.flushTimers();
    assert.equal(h.state.playing, false);
    assert.match(h.state.playbackError, /replaced/);
    assert.equal(h.sent.length, beforeFailure, "a stale lease cannot panic the new tab's output");
  }
  {
    const h = appFixture(async () => ({ ok: false, status: 503, error: "Native MIDI protection is unavailable" }));
    await h.togglePlayback();
    assert.equal(h.state.playing, false);
    assert.equal(h.sent.length, 0, "missing native protection fails before playing");
    assert.match(h.state.playbackError, /Native MIDI protection/);
    h.state.output = h.state.synthOutput = "audio";
    const count = h.calls.length;
    await h.togglePlayback();
    assert.equal(h.state.playing, true, "browser audio works without the native MIDI guard");
    assert.equal(h.calls.length, count);
    h.stopPlayback();
  }
  for (const wakeup of ["expiry-timer", "note-callback"]) {
    const h = appFixture(async method => method === "arm"
      ? { ok: true, lease_id: "old-tab", heartbeat_ms: 500, timeout_ms: 2500 }
      : { ok: false, status: 409, error: "MIDI lease was replaced" });
    await h.togglePlayback();
    h.advanceNative(8000); // Old renderer freezes while another page takes over.
    h.output.send([0x90, 60, 100]); // New owner's note after all old releases.
    const beforeWakeup = h.sent.length;
    if (wakeup === "note-callback") assert.throws(() => h.playMidiNote(64, 90, 200), /expired/);
    await h.flushTimers();
    assert.equal(h.state.playing, false);
    assert.equal(h.sent.length, beforeWakeup, `${wakeup}: a locally expired page cannot panic the new owner`);
    assert.equal(h.keys.has(60), true);
  }
  console.log("MIDI safety: native-clock releases, overlap/restart, sustain, lease expiry, cancellation and stale responses passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
