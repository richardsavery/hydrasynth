"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto").webcrypto;
const source = name => fs.readFileSync(path.join(__dirname, "../dashboard", name), "utf8");
const context = vm.createContext({ console, AbortController, crypto });
vm.runInContext(source("native-midi.js"), context);
vm.runInContext(source("midi-safety.js"), context);
const Native = context.HydraNativeMidi, Safety = context.HydraMidiSafety;
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const info = { id: "native:HYDRASYNTH EXPLORER: HYDRASYNTH EXPLORER MIDI 1", name: "HYDRASYNTH EXPLORER MIDI 1", type: "output" };
function fixture(options = {}) {
  let time = 0, next = 0;
  const timers = new Map(), calls = [], failures = [];
  const clock = { now: () => time,
    schedule(fn, ms) { timers.set(++next, { fn, at: time + ms }); return next; },
    cancel(id) { timers.delete(id); } };
  const send = async (method, body) => {
    calls.push({ method, body: body && plain(body) });
    return options.send ? options.send(method, body) : { ok: true };
  };
  const output = Native.createOutput(info, { ...clock, send, ownerId: "a".repeat(32),
    onFailure(error) { failures.push(error); options.onFailure?.(error); } });
  return { ...clock, calls, failures, timers, send, output,
    async advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= time && timers.has(id)) { timers.delete(id); timer.fn(); }
      await settle();
    } };
}

function appFixture() {
  const clock = fixture(), calls = [], errors = [];
  let sendFailure = false;
  const sandbox = vm.createContext({ console, AbortController, crypto, URLSearchParams,
    HydraDashboardConfig: { native_midi: true },
    document: { addEventListener() {} },
    window: { setTimeout: clock.schedule, clearTimeout: clock.cancel },
    setTimeout: clock.schedule, clearTimeout: clock.cancel,
    performance: { now: clock.now }, localStorage: { getItem() { return null; } },
    navigator: { requestMIDIAccess() { throw new Error("Linux playback must not touch Chrome MIDI"); } },
    fetch: async (url, options = {}) => {
      const method = url.split("/").at(-1), body = options.body && JSON.parse(options.body);
      calls.push({ method, body });
      if (sendFailure && method === "send") return { ok: false, status: 503, json: async () => ({ ok: false, error: "Native transport disconnected" }) };
      const data = method === "ports" ? { ok: true, outputs: [info] }
        : method === "arm" ? { ok: true, lease_id: "app-lease", heartbeat_ms: 500, timeout_ms: 2500 } : { ok: true };
      return { ok: true, status: 200, json: async () => data };
    }, testError: message => errors.push(message)
  });
  for (const file of ["drums.js", "sonification.js", "parameters.js", "native-midi.js", "midi-safety.js", "app.js"])
    vm.runInContext(source(file), sandbox, { filename: file });
  vm.runInContext(`
    activeSynthMixer = () => ({ reset() {} });
    playbackUnavailableReason = () => "";
    readPlaybackControls = () => ({ soundMode: "off" });
    for (const name of ["renderPlaybackAvailability", "updatePlayhead", "renderRhythm", "startParameterPump", "stopAudioVoices",
      "publishSignalLabActivity", "updateMidiStatus", "updateConnectionSummary", "renderSoundControls"])
      globalThis[name] = () => {};
    renderMidiOutputs = () => { state.midiOutput = [...state.midiAccess.outputs.values()].find(output => output.state === "connected"); };
    showToast = testError;
    runPlaybackTick = () => { if (state.output === "midi") playMidiNote(60, 90, 200); };
    ensureAudioEngine = async () => {};
    state.workspaceView = "synth-mixer";
    state.output = state.synthOutput = "midi";
    dom["preview-button"] = { classList: { add() {}, remove() {} } };
    dom["session-state"] = {};
    globalThis.api = { state, connectMidi, togglePlayback, stopPlayback, playMidiNote, sendMidiPatch };
  `, sandbox);
  return { ...clock, ...sandbox.api, calls, errors, failSend() { sendFailure = true; } };
}

async function main() {
  {
    const h = fixture();
    assert.throws(() => h.output.play(60, 90, 200), /active safety/);
    h.output.bindLease({ id: "first", channel: 1 });
    for (const duration of [NaN, Infinity, 5000.01]) assert.throws(() => h.output.play(60, 90, duration), /five seconds/);
    for (const note of [60, 64, 67]) h.output.play(note, 90, 200.5);
    h.output.commands([{ op: "nrpn", parameter: 8064, value: 12200 }]);
    assert.equal(h.calls.length, 0, "the bounded queue batches a chord and its parameter update");
    await h.output.flush();
    assert.deepEqual(h.calls, [{ method: "send", body: { lease_id: "first", commands: [
      ...[60, 64, 67].map(note => ({ op: "play", notes: [note], velocity: 90, duration_ms: 201, channel: 1 })),
      { op: "nrpn", parameter: 8064, value: 12200, channel: 1 }
    ] } }]);
    assert.equal(h.timers.size, 0, "no browser timer owns any note release");
    assert.throws(() => h.output.send([0x90, 60, 90]), /bounded duration/);
    assert.throws(() => h.output.send([0x80, 60, 0], 200), /browser timestamps/);
  }
  {
    const h = fixture();
    h.output.send([0xB0, 0, 0]); h.output.send([0xB0, 32, 2]); h.output.send([0xC0, 17]);
    await h.output.flush();
    assert.deepEqual(h.calls[0], { method: "control", body: { owner_id: "a".repeat(32),
      port_name: "HYDRASYNTH EXPLORER: HYDRASYNTH EXPLORER MIDI 1", channel: 1,
      commands: [{ op: "cc", number: 0, value: 0, channel: 1 }, { op: "cc", number: 32, value: 2, channel: 1 },
        { op: "program", number: 17, channel: 1 }] } });
    await h.output.panic();
    assert.deepEqual(h.calls[1].body.commands, [{ op: "panic", channel: 1 }], "manual panic is owner-checked by the backend");
    h.output.send([0xB0, 7, 40]); h.output.send([0xB1, 7, 50]); await h.output.flush();
    assert.deepEqual(h.calls.slice(2).map(call => call.body.channel), [1, 2], "unleased channels use separate request validation contexts");
  }
  {
    const h = fixture();
    h.output.bindLease({ id: "first", channel: 1 });
    h.output.play(60, 90, 5000); h.output.stopNotes(); await h.output.flush();
    assert.deepEqual(h.calls[0].body.commands, [{ op: "panic", channel: 1 }], "Stop drops unsent notes before requesting a native scheduler panic");
    h.output.play(64, 90, 200); h.output.detachLease(); await h.advance(20);
    assert.equal(h.calls.length, 1, "disarm never leaves unsent notes for a later playback");
    h.output.bindLease({ id: "second", channel: 1 });
    h.output.state = "disconnected";
    assert.doesNotThrow(() => h.output.stopNotes(), "hot unplug must not interrupt the app's disarm cleanup");
    h.output.detachLease();
  }
  {
    const pending = deferred();
    const h = fixture({ send: (_method, body) => body.lease_id === "first" ? pending.promise : { ok: true } });
    h.output.bindLease({ id: "first", channel: 1 });
    h.output.play(60, 90, 200); await h.advance(5);
    h.output.detachLease(); h.output.bindLease({ id: "second", channel: 1 });
    h.output.play(67, 90, 200);
    const flushed = h.output.flush();
    assert.equal(h.calls.length, 1, "only one MIDI request can be in flight");
    pending.reject(Object.assign(new Error("Old lease was revoked"), { status: 409 }));
    await flushed;
    assert.deepEqual(h.calls.map(call => call.body.lease_id), ["first", "second"]);
    assert.equal(h.calls[1].body.commands[0].notes[0], 67);
    assert.equal(h.failures.length, 0, "a stale request failure cannot stop the replacement lease");
  }
  {
    const h = fixture(); h.output.bindLease({ id: "bounded", channel: 1 });
    for (let index = 0; index < Native.MAX_QUEUE; index++) h.output.play(60, 90, 200);
    await h.output.flush();
    assert.deepEqual(h.calls.map(call => call.body.commands.length), [64, 64]);
    const stalled = fixture(); stalled.output.bindLease({ id: "stalled", channel: 1 });
    for (let index = 0; index < Native.MAX_QUEUE; index++) stalled.output.play(60, 90, 200);
    assert.throws(() => stalled.output.play(60, 90, 200), /could not keep up/);
    assert.equal(stalled.output.pendingCount, 0);
    assert.equal(stalled.failures.length, 1);
    await stalled.advance(100);
    assert.equal(stalled.calls.length, 0, "overflow fails closed instead of playing a late backlog");
  }
  {
    const h = fixture({ send: async () => { throw new Error("Native process exited"); } });
    h.output.bindLease({ id: "failed", channel: 1 }); h.output.play(60, 90, 200);
    await assert.rejects(h.output.flush(), /process exited/);
    assert.equal(h.failures.length, 1);
    assert.throws(() => h.output.play(64, 90, 200), /process exited/);
  }
  {
    let ports = [info], changes = 0, unavailable = 0;
    const h = fixture();
    const access = await Native.createAccess({ ...h, ownerId: "a".repeat(32),
      send: async () => { if (ports === null) throw new Error("Dashboard disconnected"); return { ok: true, outputs: ports }; },
      onUnavailable() { unavailable++; } });
    access.onstatechange = () => { changes++; };
    const original = access.outputs.get(info.id);
    await access.refresh(); assert.equal(changes, 0, "unchanged port polls do not rebuild the connection UI");
    ports = null; await assert.rejects(access.refresh(), /disconnected/);
    assert.equal(original.state, "disconnected"); assert.equal(unavailable, 1);
    ports = [info]; await access.refresh();
    assert.equal(access.outputs.get(info.id), original, "transient network loss preserves the selected port object");
    assert.equal(original.state, "connected");
    ports = []; await access.refresh(); assert.equal(original.state, "disconnected");
    ports = [info]; await access.refresh(); assert.equal(access.outputs.size, 1);
    access.close(); assert.equal(h.timers.size, 0, "closing the page cancels port polling");
  }
  {
    const patch = deferred();
    const h = fixture({ send: method => method === "control" ? patch.promise : { ok: true } });
    const guard = Safety.createGuard({ ...h, send: async (method, body) => {
      h.calls.push({ method, body: plain(body) });
      return method === "arm" ? { ok: true, lease_id: "new", heartbeat_ms: 500, timeout_ms: 2500 } : { ok: true };
    } });
    h.output.send([0xC0, 17]); await h.advance(5);
    h.output.send([0xC0, 18]);
    const arming = guard.arm(h.output, 1); await settle();
    assert.deepEqual(h.calls.map(call => call.method), ["control"], "Play waits for an in-flight unleased patch request");
    patch.resolve({ ok: true }); assert.equal(await arming, true);
    assert.deepEqual(h.calls.map(call => call.method), ["control", "arm"], "an unsent old patch cannot enter the new playback");
    await guard.stop();
  }
  {
    const h = fixture(), disarm = deferred(); let serial = 0;
    const guard = Safety.createGuard({ ...h, send: async (method, body) => {
      h.calls.push({ method, body: plain(body) });
      if (method === "arm") return { ok: true, lease_id: `lease-${++serial}`, heartbeat_ms: 500, timeout_ms: 2500 };
      if (method === "disarm" && body.lease_id === "lease-1") return disarm.promise;
      return { ok: true };
    } });
    await guard.arm(h.output, 1);
    assert.equal(h.calls[0].body.transport, "native");
    assert.equal(h.calls[0].body.port_name, h.output.portName);
    h.output.play(60, 90, 200); await h.output.flush();
    h.output.play(62, 90, 200);
    const stopped = guard.stop(), restart = guard.arm(h.output, 1); await settle();
    assert.equal(h.output.pendingCount, 0);
    assert.throws(() => h.output.play(64, 90, 200), /active safety/);
    assert.equal(serial, 1, "rearming waits for native cancellation of the prior notes");
    disarm.resolve({ ok: true }); await stopped; assert.equal(await restart, true);
    h.output.play(67, 90, 200); await h.output.flush();
    assert.equal(h.calls.at(-1).body.lease_id, "lease-2");
    await guard.stop(); assert.equal(h.timers.size, 0);
  }
  {
    const h = appFixture();
    await h.connectMidi({ automatic: true });
    await h.togglePlayback(); await h.state.midiOutput.flush();
    assert.equal(h.state.playing, true);
    assert.deepEqual(h.calls.map(call => call.method), ["ports", "arm", "send"]);
    const arm = h.calls.find(call => call.method === "arm");
    assert.equal(arm.body.transport, "native");
    assert.equal(h.calls.at(-1).body.commands[0].op, "play");
    h.failSend(); h.playMidiNote(64, 90, 200); await h.state.midiOutput.flush(); await settle();
    assert.equal(h.state.playing, false, "a real adapter send failure stops the actual dashboard transport");
    assert.match(h.state.playbackError, /disconnected/);
    assert.equal(h.calls.filter(call => call.method === "disarm").length, 1);
    const sends = h.calls.filter(call => call.method === "send").length;
    await h.advance(1000);
    assert.equal(h.calls.filter(call => call.method === "send").length, sends, "failed cleanup cannot produce a panic/error retry loop");
    h.state.midiAccess.close();
  }
  {
    const h = appFixture(); await h.connectMidi({ automatic: true });
    const patch = h.sendMidiPatch({ bank: "B", number: 12 }, h.state.playbackGeneration);
    await settle();
    h.stopPlayback(); await h.advance(100); assert.equal(await patch, false);
    assert.deepEqual(h.calls.filter(call => call.method === "control").flatMap(call => call.body.commands.map(command => command.op)), ["cc"],
      "cancelling a manual patch after its first request prevents all later bank/program writes");
    h.state.midiAccess.close();
  }
  console.log("Native MIDI: bounded batches, native note releases, control changes, disconnects, stale requests and Stop/Play ownership passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
