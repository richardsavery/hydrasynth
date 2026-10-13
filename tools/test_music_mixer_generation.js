"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const plain = (value) => JSON.parse(JSON.stringify(value));
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const job = (id, extra = {}) => ({ id, plan_id: `plan-${id}`, state: "complete", audio_url: `/${id}.mp3`, separate_stems: true,
  stem_separation: { state: "complete", stems: [{ name: "Bass", audio_url: `/${id}-bass.mp3` }, { name: "Drums", audio_url: `/${id}-drums.mp3` }] }, ...extra });
function harness(options = {}) {
  const calls = [], tracks = [], errors = [], updates = [], waits = [], saved = options.saved || new Map();
  let serial = 0, coordinator, track = options.track || null, queuedTrack = null, running = false;
  const settings = { duration_seconds: 60, settings: { style: "ambient strings", bpm: 80, key: "D minor", instrument_palette: ["cello"] } };
  const state = () => ({ track, queuedTrack, running });
  function emit() { coordinator?.update(state()); }
  const engine = {
    snapshot: state,
    unlock() { calls.push({ audio: "unlock" }); emit(); return Promise.resolve(true); },
    async setTrack(value) { calls.push({ audio: "set", id: value.id }); track = value; running = false; emit(); },
    async start() { calls.push({ audio: "start" }); running = true; emit(); return true; },
    async queueTrack(value) { calls.push({ audio: "queue", id: value.id }); queuedTrack = value; emit(); return true; },
    stop() { calls.push({ audio: "stop" }); running = false; queuedTrack = null; emit(); }
  };
  const storage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: (key) => saved.delete(key) };
  const context = vm.createContext({ AbortController, Math, Date });
  vm.runInContext(fs.readFileSync(`${__dirname}/../dashboard/music-mixer-generation.js`, "utf8"), context);
  coordinator = context.HydraMusicMixerGeneration.create({ engine, storage, getSettings: () => settings,
    onTrack: (value) => tracks.push(plain(value)), onError: (message) => errors.push(message),
    onUpdate(value) { updates.push(plain(value)); if (options.reentrant) emit(); },
    sleep(ms, signal) {
      assert.equal(ms, 1500); const task = defer(); waits.push(task);
      signal.addEventListener("abort", () => task.reject(Object.assign(new Error("stopped"), { name: "AbortError" })), { once: true });
      return task.promise;
    },
    async request(path, request = {}) {
      calls.push({ path, method: request.method || "GET", body: request.body ? plain(request.body) : undefined });
      if (options.request) { const result = await options.request(path, request); if (result !== undefined) return result; }
      if (path === "/plans") return { id: "new-plan" };
      if (path === "/generations" && request.method !== "POST") return { jobs: [] };
      if (request.method === "POST") return job(`new-${++serial}`, { realtime: path === "/continuations" ? plain(request.body) : undefined });
      throw new Error(`Unexpected GET ${path}`);
    }
  });
  return { coordinator, engine, settings, calls, tracks, errors, updates, waits, saved,
    paid: () => calls.filter((call) => call.method === "POST" && call.path !== "/plans"),
    promote() { track = queuedTrack; queuedTrack = null; emit(); },
    recall(value) { coordinator.stop(); track = value; emit(); } };
}

async function main() {
  {
    const h = harness({ reentrant: true }), c = h.coordinator;
    await settle(); assert.equal(h.calls.length, 0, "opening the tab never generates or resumes playback");
    const started = c.startNew();
    assert.equal(h.calls[0].audio, "unlock", "audio unlock is synchronous with the Generate gesture");
    assert.equal(await c.startNew(), false, "double clicks cannot create overlapping generations");
    assert.equal(await started, true); await settle();
    assert.equal(h.paid().length, 2, "first music immediately gets exactly one spare");
    assert.deepEqual(h.paid()[0].body, { plan_id: "new-plan", variation: true }, "original request explicitly asks for fresh music");
    const next = h.paid()[1].body;
    assert.equal(next.kind, "prompt"); assert.equal(next.source_job_id, "new-1"); assert.equal(next.plan_id, "plan-new-1");
    assert.equal(next.duration_seconds, 60); assert.equal(next.settings.style, "ambient strings"); assert.equal(next.features, undefined);
    assert.equal(c.snapshot().queuedId, "new-2"); assert.equal(h.engine.snapshot().running, true);
    for (let i = 0; i < 20; i++) c.update(h.engine.snapshot()); await settle();
    assert.equal(h.paid().length, 2, "repeated transport updates cannot fill more than one spare");
    h.settings.settings.style = "bright piano"; h.settings.duration_seconds = 40;
    h.promote(); await settle();
    assert.equal(h.paid().length, 3, "promotion triggers one replacement spare");
    assert.equal(h.paid()[2].body.source_job_id, "new-2");
    assert.equal(h.paid()[2].body.settings.style, "bright piano"); assert.equal(h.paid()[2].body.duration_seconds, 40);
    assert.equal(h.paid()[2].body.sequence, next.sequence + 1);
    assert.equal(h.paid()[2].body.session_id, next.session_id);
    assert.equal(h.tracks.length, 3, "both current and queued tracks enter recall history");
    c.stop(); assert.equal(h.engine.snapshot().running, false); assert.equal(c.snapshot().enabled, false);
    c.update(); await settle(); assert.equal(h.paid().length, 3);
  }
  {
    const pending = defer();
    const h = harness({ track: job("saved"), request(path) { if (path === "/continuations") return pending.promise; } });
    await h.coordinator.resume(); await settle();
    assert.equal(h.engine.snapshot().running, true); assert.equal(h.paid().length, 1);
    assert.equal(h.paid()[0].body.kind, "prompt", "a recalled song immediately generates a prompt-based spare");
    for (let i = 0; i < 15; i++) h.coordinator.update();
    assert.equal(h.paid().length, 1, "pending work is a locked slot");
    h.coordinator.stop(); pending.resolve(job("late")); await settle();
    assert.equal(h.tracks.length, 0); assert.equal(h.calls.filter((call) => call.audio === "queue").length, 0);
    assert.equal(h.paid().length, 1, "a late completion cannot queue or generate after leaving the workspace");
    assert.ok(h.saved.size, "an interrupted submitted job is retained for recovery");
  }
  {
    let reads = 0;
    const h = harness({ request(path, options) {
      if (path === "/generations" && options.method === "POST") return job("building", { state: "queued", stem_separation: undefined });
      if (path === "/generations/building") {
        return ++reads === 1 ? job("building", { stem_separation: { state: "generating" } }) : job("building");
      }
    } });
    const result = h.coordinator.startNew(); await settle();
    assert.equal(h.waits.length, 1); assert.equal(h.tracks.length, 0);
    h.waits[0].resolve(); await settle();
    assert.equal(h.waits.length, 2); assert.equal(h.tracks.length, 0, "wait for separated stems before playback");
    h.waits[1].resolve(); assert.equal(await result, true); await settle();
    assert.equal(h.tracks[0].stems.length, 2);
    assert.ok(h.calls.every((call) => !call.path?.endsWith("/stems")), "automatic stems are never billed a second time");
    h.coordinator.stop();
  }
  {
    const h = harness({ track: job("saved"), request(path) {
      if (path === "/continuations") return job("failed", { state: "failed", error: "Provider failed" });
    } });
    await h.coordinator.resume(); await settle();
    assert.equal(h.coordinator.snapshot().phase, "error"); assert.equal(h.engine.snapshot().running, true);
    for (let i = 0; i < 15; i++) h.coordinator.update(); await settle();
    assert.equal(h.paid().length, 1, "errors keep repeating the current audio without automatic paid retries");
    await h.coordinator.retry(); await settle(); assert.equal(h.paid().length, 2, "explicit Retry starts another failed continuation attempt");
    h.coordinator.stop();
  }
  {
    let requested;
    const first = harness({ track: job("saved"), request(path, options) {
      if (path === "/continuations") { requested = plain(options.body); throw new Error("Lost response"); }
    } });
    await first.coordinator.resume(); await settle();
    assert.equal(first.coordinator.snapshot().phase, "error"); assert.equal(first.engine.snapshot().running, true);
    first.coordinator.stop();
    const restored = harness({ saved: first.saved, track: job("saved"), request(path) {
      if (path === "/generations") return { jobs: [job("recovered", { realtime: requested })] };
    } });
    await settle(); assert.equal(restored.calls.length, 0, "restoring pending intent alone never polls or bills");
    await restored.coordinator.resume(); await settle();
    assert.equal(restored.paid().length, 0, "Play recovers a lost continuation via GET rather than resubmitting");
    assert.equal(restored.coordinator.snapshot().queuedId, "recovered");
    restored.coordinator.stop();
  }
  {
    let paid = 0, discover = false;
    const h = harness({ request(path, options) {
      if (path === "/generations" && options.method === "POST") { paid++; throw new Error("Lost response"); }
      if (path === "/generations") return { jobs: [job("older", { plan_id: "new-plan" }), ...(discover ? [job("newer", { plan_id: "new-plan" })] : [])] };
    } });
    assert.equal(await h.coordinator.startNew(), false); assert.equal(paid, 1);
    await h.coordinator.retry(); await settle(); assert.equal(paid, 1, "unknown original submissions are never casually duplicated");
    assert.match(h.coordinator.snapshot().error, /confirmed result/);
    discover = true; await h.coordinator.retry(); await settle();
    assert.equal(paid, 1); assert.equal(h.engine.snapshot().track.id, "newer");
    h.coordinator.stop();
  }
  {
    let stemFailure = true;
    const h = harness({ request(path, options) {
      if (path === "/generations" && options.method === "POST" && stemFailure) {
        return job("bad-stems", { stem_separation: { state: "failed", error: "Cannot separate" } });
      }
    } });
    assert.equal(await h.coordinator.startNew(), false);
    assert.equal(h.engine.snapshot().running, false); assert.equal(h.tracks.length, 0, "failed stems cannot silently fall back to the full mix");
    stemFailure = false; await h.coordinator.retry(); await settle();
    assert.equal(h.engine.snapshot().running, true); h.coordinator.stop();
  }
  {
    const h = harness({ track: job("saved"), request(path) { if (path === "/generations/new-1") return job("new-1"); } });
    await h.coordinator.resume(); await settle();
    const id = h.coordinator.snapshot().queuedId, count = h.paid().length;
    h.coordinator.stop(); await h.coordinator.resume(); await settle();
    assert.equal(h.coordinator.snapshot().phase, "ready");
    assert.equal(h.coordinator.snapshot().queuedId, id, "Stop/Play restores the already generated spare");
    assert.equal(h.paid().length, count, "restoring a ready spare does not bill another generation");
    h.coordinator.stop();
  }
  {
    const h = harness({ track: job("saved"), request(path) { if (path === "/generations/new-1") return job("new-1"); } });
    await h.coordinator.resume(); await settle();
    h.recall(job("different")); await h.coordinator.resume(); await settle();
    assert.equal(h.engine.snapshot().track.id, "different");
    assert.equal(h.paid().length, 2);
    assert.equal(h.paid()[1].body.source_job_id, "different", "recalling another track generates from its own musical lineage");
    assert.equal(h.coordinator.snapshot().queuedId, "new-2", "the previous song's spare is retained in history rather than queued into another song");
    h.coordinator.stop();
  }
  {
    const h = harness({ track: job("saved"), request(path) {
      if (path === "/continuations") return job("unknown", { state: "unknown", error: "Provider outcome unknown" });
      if (path === "/generations/unknown") return job("unknown", { state: "unknown", error: "Provider outcome unknown" });
    } });
    await h.coordinator.resume(); await settle();
    await h.coordinator.retry(); await settle();
    assert.equal(h.paid().length, 1, "known job with ambiguous provider outcome is checked, never resubmitted");
    assert.equal(h.engine.snapshot().running, true);
    h.coordinator.stop();
  }
  {
    const building = job("original", { stem_separation: { state: "generating" } });
    const saved = new Map([["hydra.music-mixer.pending.v1", JSON.stringify({ kind: "original", path: "/generations",
      body: { plan_id: building.plan_id, variation: true }, stage: "polling", jobId: building.id })]]);
    let reads = 0;
    const h = harness({ track: building, saved, request(path) {
      if (path === "/generations/original") return ++reads === 1 ? building : job("original");
    } });
    const resumed = h.coordinator.resume(); await settle();
    assert.equal(h.engine.snapshot().running, false, "restored first generation waits for stems even if the library has selected its full mix");
    assert.equal(h.calls.filter((call) => call.audio === "start").length, 0);
    h.waits[0].resolve(); assert.equal(await resumed, true); await settle();
    assert.equal(h.engine.snapshot().running, true); assert.equal(h.engine.snapshot().track.stems.length, 2);
    h.coordinator.stop();
  }
  {
    const inFlight = defer(); let originalReady = false;
    const original = job("interrupted", { plan_id: "new-plan" });
    const h = harness({ request(path, options) {
      if (path === "/generations" && options.method === "POST") return inFlight.promise;
      if (path === "/generations") return { jobs: originalReady ? [original] : [] };
    } });
    const initial = h.coordinator.startNew(); await settle();
    await h.coordinator.recall(job("recalled"));
    assert.equal(JSON.parse([...h.saved.values()][0]).saveOnly, true, "explicit recall persists that interrupted originals are history only");
    originalReady = true; inFlight.resolve(original); await initial;
    await h.coordinator.resume(); await settle();
    assert.equal(h.engine.snapshot().track.id, "recalled", "an interrupted original cannot replace an explicit recall");
    assert.ok(h.tracks.some((track) => track.id === "interrupted"), "the completed interrupted track remains in recall history");
    assert.equal(h.paid().at(-1).body.source_job_id, "recalled");
    h.coordinator.stop();
  }
  {
    const saved = new Map([["hydra.music-mixer.pending.v1", JSON.stringify({ kind: "original", path: "/generations",
      body: { plan_id: "plan-interrupted", variation: true }, stage: "polling", jobId: "interrupted" })]]);
    const before = harness({ saved, track: job("old") });
    await before.coordinator.recall(job("recalled"));
    const h = harness({ saved, track: job("recalled"), request(path) {
      if (path === "/generations/interrupted") return job("interrupted");
    } });
    const resumed = h.coordinator.resume();
    assert.equal(h.engine.snapshot().running, true, "recalled audio starts immediately while recovering the interrupted original");
    assert.equal(h.calls.filter((call) => call.audio === "set").length, 0);
    await resumed; await settle();
    assert.equal(h.engine.snapshot().track.id, "recalled", "recall wins after a browser reload as well");
    assert.equal(h.paid().length, 1); assert.equal(h.paid()[0].body.source_job_id, "recalled");
    h.coordinator.stop();
  }
  {
    let attempts = 0;
    const h = harness({ track: job("saved"), request(path) {
      if (path === "/continuations" && ++attempts === 1) throw new Error("Request did not reach server");
    } });
    await h.coordinator.resume(); await settle();
    assert.equal(h.paid().length, 1);
    for (let i = 0; i < 10; i++) h.coordinator.update(); await settle();
    assert.equal(h.paid().length, 1, "ambiguous requests are never automatically retried");
    await h.coordinator.retry(); await settle();
    assert.equal(h.paid().length, 2);
    assert.deepEqual(h.paid()[1].body, h.paid()[0].body, "explicit retry keeps the exact idempotent prompt payload including session and sequence");
    assert.ok(h.coordinator.snapshot().queuedId); assert.equal(h.coordinator.snapshot().phase, "ready");
    h.coordinator.stop();
  }
  console.log("Mixer generation tests passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
