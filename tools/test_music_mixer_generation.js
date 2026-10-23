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
  let clock = 0, timerId = 0, queueRun = 0, queueing = false;
  const timers = new Map();
  const settings = { duration_seconds: 60, settings: { style: "ambient strings", bpm: 80, key: "D minor", instrument_palette: ["cello"] } };
  const state = () => ({ track, queuedTrack, running, queueing });
  function emit() { coordinator?.update(state()); }
  const engine = {
    snapshot: state,
    unlock() { calls.push({ audio: "unlock" }); emit(); return Promise.resolve(true); },
    async setTrack(value) { calls.push({ audio: "set", id: value.id }); track = value; running = false; emit(); },
    async start() { calls.push({ audio: "start" }); running = true; emit(); return true; },
    async queueTrack(value) {
      const run = ++queueRun; queueing = true;
      calls.push({ audio: "queue", id: value.id }); emit();
      if (options.queue) await options.queue(value);
      if (run !== queueRun) return false;
      queueing = false; queuedTrack = value; emit(); return true;
    },
    clearQueuedTrack() {
      ++queueRun; queueing = false; calls.push({ audio: "clear" });
      if (options.audible && queuedTrack) track = queuedTrack;
      queuedTrack = null; emit(); return !options.audible;
    },
    stop(preserveUnlocked = false) { calls.push({ audio: "stop", preserveUnlocked }); running = false; queuedTrack = null; emit(); }
  };
  const storage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: (key) => saved.delete(key) };
  const context = vm.createContext({ AbortController, Math, Date, fetch: options.fetch });
  vm.runInContext(fs.readFileSync(`${__dirname}/../dashboard/music-mixer-generation.js`, "utf8"), context);
  coordinator = context.HydraMusicMixerGeneration.create({ engine, storage, getSettings: () => {
    if (options.getSettings) return options.getSettings(settings);
    return settings;
  }, ...(options.choice ? { getNextTrack: () => options.choice } : {}), now: () => clock,
    schedule(callback, milliseconds) { const id = ++timerId; timers.set(id, { at: clock + milliseconds, callback }); return id; },
    unschedule: (id) => timers.delete(id),
    onTrack: (value) => tracks.push(plain(value)), onError: (message) => errors.push(message),
    onUpdate(value) { updates.push(plain(value)); if (options.reentrant) emit(); },
    sleep(ms, signal) {
      assert.equal(ms, 1500); const task = defer(); waits.push(task);
      signal.addEventListener("abort", () => task.reject(Object.assign(new Error("stopped"), { name: "AbortError" })), { once: true });
      return task.promise;
    },
    request: options.fetch ? undefined : async function(path, request = {}) {
      calls.push({ path, method: request.method || "GET", body: request.body ? plain(request.body) : undefined });
      if (options.request) { const result = await options.request(path, request); if (result !== undefined) return result; }
      if (path === "/plans") return { id: "new-plan" };
      if (path === "/generations" && request.method !== "POST") return { jobs: [] };
      if (request.method === "POST") return job(`new-${++serial}`, { realtime: path === "/continuations" ? plain(request.body) : undefined });
      throw new Error(`Unexpected GET ${path}`);
    }
  });
  return { coordinator, engine, settings, choice: options.choice, calls, tracks, errors, updates, waits, saved, timers,
    advance(milliseconds) {
      clock += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.at <= clock && timers.delete(id)) timer.callback();
    },
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
    assert.equal(next.continuity_mode, "fresh", "new mixer sessions request a fresh interpretation by default");
    assert.equal(h.calls.find(call => call.path === "/plans").body.continuity_mode, undefined, "original music plans never receive continuation-only controls");
    assert.equal(next.settings.continuity_mode, undefined, "continuity belongs to the continuation envelope, not musical settings");
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
    const h = harness({ track: job("saved") });
    await h.coordinator.resume(); await settle();
    assert.equal(h.paid()[0].body.continuity_mode, "fresh");
    h.settings.continuity_mode = "evolve"; h.coordinator.settingsChanged();
    assert.equal(h.engine.snapshot().queuedTrack, null, "changing continuity withdraws an inaudible waiting track");
    h.advance(650); await settle();
    assert.equal(h.paid().length, 2);
    assert.equal(h.paid()[1].body.continuity_mode, "evolve");
    assert.equal(h.paid()[1].body.settings.style, "ambient strings", "continuity edits retain the user's musical direction");
    const persisted = JSON.parse([...h.saved.values()][0]);
    assert.equal(persisted.direction.continuity_mode, "evolve");
    assert.equal(persisted.body.continuity_mode, "evolve");
    h.coordinator.settingsChanged(); h.advance(1000); await settle();
    assert.equal(h.paid().length, 2, "duplicate input/change events do not submit the same continuity twice");
    h.coordinator.stop();
  }
  {
    const pending = defer();
    const h = harness({ track: job("saved"), request(path, options) {
      if (path === "/continuations" && options.body.sequence === 0) return pending.promise;
    } });
    await h.coordinator.resume(); await settle();
    h.settings.continuity_mode = "evolve"; h.coordinator.settingsChanged(); h.advance(650); await settle();
    assert.equal(h.paid().length, 1, "continuity changes wait for the existing provider request");
    pending.resolve(job("old-continuity")); await settle();
    assert.ok(h.tracks.some(track => track.id === "old-continuity"), "the superseded generation stays in Recent tracks");
    assert.ok(!h.calls.some(call => call.audio === "queue" && call.id === "old-continuity"));
    assert.equal(h.paid().length, 2);
    assert.equal(h.paid()[1].body.continuity_mode, "evolve");
    h.coordinator.stop();
  }
  {
    const h = harness();
    h.settings.continuity_mode = "evolve";
    await h.coordinator.startNew(); await settle();
    const original = h.calls.find(call => call.path === "/plans");
    assert.deepEqual(Object.keys(original.body).sort(), ["duration_seconds", "kind", "settings"]);
    assert.equal(original.body.settings.continuity_mode, undefined);
    assert.equal(h.paid()[1].body.continuity_mode, "evolve", "an explicitly chosen evolution mode applies only to following tracks");
    h.coordinator.stop();
  }
  {
    const saved = new Map([["hydra.music-mixer.pending.v1", JSON.stringify({ kind: "next", sourceId: "saved", path: "/continuations",
      body: { kind: "prompt", plan_id: "plan-saved", source_job_id: "saved", session_id: "legacy-session", sequence: 0,
        duration_seconds: 60, settings: { style: "ambient strings", bpm: 80, key: "D minor", instrument_palette: ["cello"] } },
      stage: "ready", jobId: "legacy-conditioned" })]]);
    const h = harness({ saved, track: job("saved"), request(path) {
      if (path === "/generations/legacy-conditioned") return job("legacy-conditioned");
    } });
    await h.coordinator.resume(); await settle();
    assert.ok(h.tracks.some(track => track.id === "legacy-conditioned"), "legacy submitted work is recovered into history");
    assert.ok(!h.calls.some(call => call.audio === "queue" && call.id === "legacy-conditioned"), "old implicitly conditioned audio cannot masquerade as Fresh interpretation");
    assert.equal(h.paid().length, 1);
    assert.equal(h.paid()[0].body.continuity_mode, "fresh");
    h.coordinator.stop();
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
    await h.coordinator.recall(job("recalled"), { preserveUnlocked: true });
    assert.equal(h.calls.filter(call => call.audio === "stop").at(-1).preserveUnlocked, true, "example recall retains the player unlocked by the click");
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
  {
    const h = harness({ track: job("saved"), reentrant: true });
    await h.coordinator.resume(); await settle();
    h.settings.settings.style = "gentle piano"; h.coordinator.settingsChanged();
    assert.equal(h.engine.snapshot().queuedTrack, null, "typing immediately withdraws a prepared old prompt");
    assert.equal(h.coordinator.snapshot().phase, "updating-prompt");
    h.advance(600); await settle(); assert.equal(h.paid().length, 1);
    h.settings.settings.style = "gentle piano and bells"; h.coordinator.settingsChanged();
    h.advance(600); await settle(); assert.equal(h.paid().length, 1, "typing waits for a quiet interval");
    h.advance(50); await settle();
    assert.equal(h.paid().length, 2); assert.equal(h.paid()[1].body.settings.style, "gentle piano and bells");
    assert.equal(h.coordinator.snapshot().nextPrompt, "gentle piano and bells");
    assert.equal(h.coordinator.snapshot().queuedId, "new-2");
    h.coordinator.settingsChanged(); h.advance(1000); await settle();
    assert.equal(h.paid().length, 2, "duplicate input/change events do not regenerate identical settings");
    h.coordinator.stop();
  }
  {
    const waiting = defer();
    const h = harness({ track: job("saved"), request(path, options) {
      if (path === "/continuations" && options.body.sequence === 0) return waiting.promise;
    } });
    await h.coordinator.resume(); await settle();
    h.settings.settings.style = "new direction"; h.coordinator.settingsChanged(); h.advance(650); await settle();
    assert.equal(h.paid().length, 1, "an in-flight paid job finishes before its replacement is submitted");
    waiting.resolve(job("outdated")); await settle();
    assert.ok(h.tracks.some((track) => track.id === "outdated"), "superseded tracks remain available in recall history");
    assert.ok(!h.calls.some((call) => call.audio === "queue" && call.id === "outdated"));
    assert.equal(h.paid().length, 2); assert.equal(h.paid()[1].body.settings.style, "new direction");
    h.coordinator.stop();
  }
  {
    const decode = defer();
    const h = harness({ track: job("saved"), queue: (track) => track.id === "new-1" ? decode.promise : undefined });
    await h.coordinator.resume(); await settle();
    h.settings.settings.style = "edited during decode"; h.coordinator.settingsChanged(); h.advance(650);
    decode.resolve(); await settle();
    assert.equal(h.coordinator.snapshot().queuedId, "new-2");
    assert.equal(h.coordinator.snapshot().phase, "ready", "withdrawn audio decoding is not reported as provider failure");
    assert.equal(h.errors.length, 0); h.coordinator.stop();
  }
  {
    const h = harness({ track: job("saved"), audible: true, reentrant: true });
    await h.coordinator.resume(); await settle();
    h.settings.settings.style = "after the audible fade"; h.coordinator.settingsChanged(); h.advance(650); await settle();
    assert.equal(h.engine.snapshot().track.id, "new-1", "an already-audible transition is allowed to finish");
    assert.equal(h.paid().length, 2);
    assert.equal(h.paid()[1].body.source_job_id, "new-1", "a synchronous fade promotion updates the next lineage");
    assert.equal(h.paid()[1].body.settings.style, "after the audible fade"); h.coordinator.stop();
  }
  {
    const h = harness({ track: job("saved"), getSettings(settings) {
      if (!settings.settings.style) throw new Error("Enter a next track prompt."); return settings;
    } });
    await h.coordinator.resume(); await settle();
    h.settings.settings.style = ""; h.coordinator.settingsChanged(); h.advance(650); await settle();
    assert.equal(h.coordinator.snapshot().phase, "waiting-prompt");
    assert.equal(h.coordinator.snapshot().queuedId, null); assert.equal(h.paid().length, 1);
    assert.equal(h.engine.snapshot().running, true, "partial form edits keep current music playing");
    h.settings.settings.style = "valid again"; h.coordinator.settingsChanged(); h.advance(650); await settle();
    assert.equal(h.paid().length, 2); assert.equal(h.coordinator.snapshot().phase, "ready"); h.coordinator.stop();
  }
  {
    const original = defer(); let submissions = 0;
    const h = harness({ request(path, request) {
      if (path === "/generations" && request.method === "POST" && ++submissions === 1) return original.promise;
    } });
    const started = h.coordinator.startNew(); await settle();
    h.settings.settings.style = "new starting track"; h.coordinator.settingsChanged(); h.advance(650);
    original.resolve(job("stale-original")); await started; await settle();
    assert.ok(h.tracks.some((track) => track.id === "stale-original"));
    assert.ok(!h.calls.some((call) => call.audio === "set" && call.id === "stale-original"));
    assert.equal(h.calls.filter((call) => call.path === "/plans")[1].body.settings.style, "new starting track");
    assert.equal(h.engine.snapshot().running, true); h.coordinator.stop();
  }
  {
    const h = harness({ track: job("saved") });
    h.settings.settings.style = "before playback"; h.coordinator.settingsChanged(); h.advance(1000); await settle();
    assert.equal(h.calls.length, 0, "editing a stopped workspace cannot enable generation");
    await h.coordinator.resume(); await settle();
    h.settings.settings.style = "stop before debounce"; h.coordinator.settingsChanged(); h.coordinator.stop();
    h.advance(1000); await settle(); assert.equal(h.paid().length, 1); assert.equal(h.timers.size, 0);
  }
  {
    let attempts = 0;
    const h = harness({ track: job("saved"), request(path) {
      if (path === "/continuations" && ++attempts <= 2) throw Object.assign(
        new Error("Another music or stem request is pending. Keep playing the current track and wait for it to finish."), { status: 409 });
    } });
    await h.coordinator.resume(); await settle();
    assert.equal(h.coordinator.snapshot().phase, "waiting-retry"); assert.equal(h.coordinator.snapshot().retryAt, 10000);
    h.advance(9999); await settle(); assert.equal(h.paid().length, 1);
    h.advance(1); await settle(); assert.equal(h.paid().length, 2);
    assert.deepEqual(h.paid()[1].body, h.paid()[0].body, "known busy rejection retries the same idempotent payload");
    assert.equal(h.coordinator.snapshot().retryAt, 30000, "service busy retries back off");
    h.advance(20000); await settle(); assert.equal(h.coordinator.snapshot().phase, "ready");
    h.coordinator.stop(); assert.equal(h.timers.size, 0);
  }
  {
    const h = harness({ track: job("saved"), request(path) {
      if (path === "/continuations") throw Object.assign(new Error("The saved request has different settings."), { status: 409 });
    } });
    await h.coordinator.resume(); await settle(); h.advance(60000); await settle();
    assert.equal(h.coordinator.snapshot().phase, "error"); assert.equal(h.paid().length, 1, "other conflicts are never automatically resubmitted");
    h.coordinator.stop();
  }
  {
    const h = harness({ track: job("saved"), request(path) { if (path === "/generations/new-1") return job("new-1"); } });
    await h.coordinator.resume(); await settle(); h.coordinator.stop();
    await h.coordinator.startNew(); await settle();
    assert.equal(h.coordinator.snapshot().queuedId, "new-1");
    h.promote(); await settle();
    assert.equal(h.paid().at(-1).path, "/continuations", "Start after Stop keeps recovered continuations in the crossfade pipeline");
    assert.equal(h.paid().at(-1).body.source_job_id, "new-1");
    assert.equal(h.calls.filter((call) => call.audio === "set").length, 0); h.coordinator.stop();
  }
  {
    const h = harness({ getSettings(settings) {
      if (!settings.settings.style) throw new Error("Enter a next track prompt."); return settings;
    } });
    h.settings.settings.style = ""; h.coordinator.settingsChanged();
    assert.equal(await h.coordinator.startNew(), false);
    assert.equal(h.coordinator.snapshot().phase, "waiting-prompt"); assert.equal(h.paid().length, 0);
    h.settings.settings.style = "valid first prompt"; h.coordinator.settingsChanged(); h.advance(650); await settle();
    assert.equal(h.engine.snapshot().running, true, "a corrected first prompt starts without another click");
    assert.equal(h.paid().length, 2); h.coordinator.stop();
  }
  for (const ambiguous of [false, true]) {
    const h = harness({ track: job("saved"), request(path) {
      if (path === "/continuations") {
        if (ambiguous) throw new Error("Provider outcome unknown");
        return job("bad", { state: "failed", error: "Provider refused" });
      }
    } });
    await h.coordinator.resume(); await settle();
    h.settings.settings.style = "edited after error"; h.coordinator.settingsChanged(); h.advance(650); await settle();
    assert.equal(h.coordinator.snapshot().phase, "error", "editing a failed request preserves the explicit recovery action");
    assert.equal(h.paid().length, 1, "an edited error is not automatically rebilled"); h.coordinator.stop();
  }
  {
    let first = true;
    const h = harness({ track: job("saved"), request(path) {
      if (path === "/continuations" && first) {
        first = false;
        throw Object.assign(new Error("Another music or stem request is pending. Wait until it finishes."), { status: 409 });
      }
    } });
    await h.coordinator.resume(); await settle();
    h.settings.settings.style = "latest after busy"; h.coordinator.settingsChanged(); h.advance(650); await settle();
    assert.equal(h.paid().length, 2); assert.equal(h.paid()[1].body.settings.style, "latest after busy");
    assert.equal(h.coordinator.snapshot().phase, "ready");
    h.advance(10000); await settle(); assert.equal(h.paid().length, 2, "replaced known-busy request cancels its old retry timer");
    h.coordinator.stop();
  }
  {
    const uncertain = job("uncertain-stems", { stem_separation: { state: "unknown", error: "Stem request outcome unknown" } });
    const h = harness({ track: job("saved"), request(path) {
      if (path === "/continuations" || path === "/generations/uncertain-stems") return uncertain;
    } });
    await h.coordinator.resume(); await settle(); await h.coordinator.retry(); await settle();
    assert.equal(h.paid().length, 1, "unknown stem outcomes are recovered by GET without starting new paid music");
    assert.equal(h.coordinator.snapshot().phase, "error"); h.coordinator.stop();
  }
  {
    const h = harness({ track: job("saved"), choice: { mode: "loop", trackId: "" }, reentrant: true,
      getSettings() { throw new Error("Enter a next track prompt."); } });
    await settle(); assert.equal(h.calls.length, 0, "restoring Loop is passive");
    await h.coordinator.resume(); await settle();
    assert.equal(h.engine.snapshot().running, true); assert.equal(h.coordinator.snapshot().phase, "looping");
    assert.equal(h.coordinator.snapshot().error, null, "Loop ignores an unfinished generation prompt");
    await h.coordinator.startNew(); await h.coordinator.retry(); await settle();
    assert.equal(h.paid().length, 0, "every Loop action keeps existing music without provider work");
    h.coordinator.stop();
  }
  {
    const h = harness({ choice: { mode: "loop", trackId: "" }, reentrant: true });
    await h.coordinator.startNew(); await settle();
    assert.equal(h.paid().length, 1, "explicit Loop start with no audio creates only the first track");
    assert.equal(h.engine.snapshot().running, true); assert.equal(h.coordinator.snapshot().phase, "looping");
    assert.equal(h.coordinator.snapshot().queuedId, null); h.coordinator.stop();
  }
  {
    const original = defer();
    const h = harness({ choice: { mode: "new", trackId: "" }, request(path, request) {
      if (path === "/generations" && request.method === "POST") return original.promise;
    } });
    const started = h.coordinator.startNew(); await settle();
    h.choice.mode = "loop"; h.coordinator.settingsChanged();
    original.resolve(job("original")); await started; await settle();
    assert.equal(h.engine.snapshot().track.id, "original", "Loop retains the first already-accepted generation");
    assert.equal(h.engine.snapshot().running, true); assert.equal(h.paid().length, 1);
    assert.equal(h.coordinator.snapshot().phase, "looping"); h.coordinator.stop();
  }
  for (const audible of [false, true]) {
    const h = harness({ track: job("saved"), choice: { mode: "new", trackId: "" }, audible, reentrant: true });
    await h.coordinator.resume(); await settle();
    h.choice.mode = "loop"; h.coordinator.settingsChanged(); await settle();
    assert.equal(h.engine.snapshot().track.id, audible ? "new-1" : "saved");
    assert.equal(h.engine.snapshot().queuedTrack, null); assert.equal(h.coordinator.snapshot().queuedId, null);
    assert.equal(h.paid().length, 1, "Loop withdraws inaudible audio without submitting a replacement");
    assert.equal(h.engine.snapshot().running, true); assert.equal(h.coordinator.snapshot().phase, "looping"); h.coordinator.stop();
  }
  {
    const generation = defer();
    const h = harness({ track: job("saved"), choice: { mode: "new", trackId: "" }, reentrant: true, request(path) {
      if (path === "/continuations") return generation.promise;
      if (path === "/generations/chosen") return job("chosen", { generation_settings: { bpm: 104 } });
    } });
    await h.coordinator.resume(); await settle();
    h.choice.mode = "old"; h.choice.trackId = "chosen"; h.coordinator.settingsChanged(); await settle();
    assert.equal(h.coordinator.snapshot().queuedId, "chosen", "saved tracks load while accepted generation is still running");
    h.promote(); await settle();
    assert.ok(h.saved.size, "saved-track promotion preserves the unrelated provider recovery journal");
    assert.equal(h.coordinator.snapshot().phase, "looping");
    generation.resolve(job("retired")); await settle();
    assert.ok(h.tracks.some(track => track.id === "retired"), "retired work remains in Recent tracks");
    assert.equal(h.engine.snapshot().track.id, "chosen"); assert.equal(h.coordinator.snapshot().queuedId, null);
    assert.equal(h.paid().length, 1); assert.equal(h.saved.size, 0, "finished retired work clears only its own journal");
    h.coordinator.stop();
  }
  {
    const h = harness({ choice: { mode: "old", trackId: "chosen" }, reentrant: true,
      getSettings() { throw new Error("Enter a next track prompt."); }, request(path) {
        if (path === "/generations/chosen") return job("chosen", { audio_url: undefined });
        if (path === "/plans/plan-chosen") return { settings: { bpm: 112 } };
      } });
    await settle(); assert.equal(h.calls.length, 0, "restoring Choose old does not load or play anything");
    assert.equal(await h.coordinator.startNew(), true); await settle();
    assert.equal(h.engine.snapshot().running, true); assert.equal(h.engine.snapshot().track.id, "chosen");
    assert.equal(h.engine.snapshot().track.generation_settings.bpm, 112, "saved tracks recover the original plan tempo");
    assert.equal(h.engine.snapshot().track.audio_url, "/api/elevenlabs/generations/chosen/audio");
    assert.equal(h.engine.snapshot().track.stems.length, 2); assert.equal(h.coordinator.snapshot().phase, "looping");
    assert.equal(h.coordinator.snapshot().error, null); assert.equal(h.paid().length, 0);
    assert.ok(h.calls.filter(call => call.path).every(call => call.method === "GET"), "Choose old uses GET only");
    const readCount = h.calls.filter(call => call.path).length;
    h.coordinator.settingsChanged(); for (let i = 0; i < 10; i++) h.coordinator.update(); await settle();
    assert.equal(h.calls.filter(call => call.path).length, readCount, "the chosen track repeats without loading a replacement");
    h.coordinator.stop();
  }
  for (const immediate of [false, true]) {
    const h = harness({ track: job("saved"), choice: { mode: "old", trackId: "chosen" }, reentrant: true, request(path) {
      if (path === "/generations/chosen") return job("chosen", { generation_settings: { bpm: 100 } });
    } });
    await (immediate ? h.coordinator.startNew() : h.coordinator.resume()); await settle();
    assert.equal(h.engine.snapshot().track.id, immediate ? "chosen" : "saved");
    assert.equal(h.coordinator.snapshot().queuedId, immediate ? null : "chosen", "Play queues saved music at the normal boundary; explicit load starts it immediately");
    if (!immediate) { h.promote(); await settle(); }
    assert.equal(h.engine.snapshot().track.id, "chosen"); assert.equal(h.coordinator.snapshot().phase, "looping");
    assert.equal(h.paid().length, 0); h.coordinator.stop();
  }
  for (const state of ["empty", "failed", "stems"]) {
    const h = harness({ track: job("saved"), choice: { mode: "old", trackId: state === "empty" ? "" : "chosen" }, request(path) {
      if (path === "/generations/chosen") return job("chosen", state === "failed" ? { state: "failed" } : { stem_separation: { state: "generating" } });
    } });
    await h.coordinator.resume(); await settle();
    assert.equal(h.engine.snapshot().running, true);
    assert.equal(h.coordinator.snapshot().phase, state === "empty" ? "waiting-track" : "error");
    assert.equal(h.paid().length, 0); assert.ok(h.calls.every(call => !call.path?.endsWith("/stems")));
    h.coordinator.stop();
  }
  {
    const decode = defer();
    const h = harness({ track: job("saved"), choice: { mode: "new", trackId: "" }, queue: () => decode.promise });
    await h.coordinator.resume(); await settle();
    h.choice.mode = "loop"; h.coordinator.settingsChanged(); decode.resolve(); await settle();
    assert.equal(h.coordinator.snapshot().queuedId, null); assert.equal(h.engine.snapshot().queuedTrack, null);
    assert.equal(h.coordinator.snapshot().phase, "looping"); assert.equal(h.errors.length, 0); assert.equal(h.paid().length, 1);
    h.coordinator.stop();
  }
  {
    const decode = defer();
    const h = harness({ track: job("saved"), choice: { mode: "old", trackId: "a" }, reentrant: true,
      queue: track => track.id === "a" ? decode.promise : undefined, request(path) {
        if (path.startsWith("/generations/")) return job(path.split("/").at(-1), { generation_settings: { bpm: 100 } });
      } });
    const resumed = h.coordinator.resume(); await settle();
    h.choice.trackId = "b"; h.coordinator.settingsChanged(); await settle();
    assert.equal(h.coordinator.snapshot().queuedId, "b", "changing saved choice invalidates earlier decoding immediately");
    decode.resolve(); await resumed; await settle();
    assert.equal(h.engine.snapshot().queuedTrack.id, "b"); assert.equal(h.paid().length, 0); h.coordinator.stop();
  }
  {
    const oldRequest = { kind: "next", path: "/continuations", sourceId: "saved", stage: "submitting", serviceBusy: true,
      body: { kind: "prompt", plan_id: "plan-saved", session_id: "original-session", sequence: 4, duration_seconds: 60,
        settings: { style: "ambient strings", bpm: 80, key: "D minor", instrument_palette: ["cello"] }, continuity_mode: "fresh" } };
    for (const mode of ["loop", "old"]) {
      const saved = new Map([["hydra.music-mixer.pending.v1", JSON.stringify(oldRequest)]]);
      const h = harness({ saved, track: job("saved"), choice: { mode, trackId: "" } });
      await h.coordinator.resume(); await h.coordinator.retry(); await settle(); h.advance(60000); await settle();
      assert.equal(h.paid().length, 0, `${mode} never retries a restored provider submission`);
      assert.ok(h.saved.size, "pending provider work remains recoverable when generation is later enabled"); h.coordinator.stop();
    }
  }
  {
    const h = harness({ track: job("saved"), choice: { mode: "similar", trackId: "" } });
    h.settings.continuity_mode = "fresh";
    await h.coordinator.resume(); await settle(); assert.equal(h.paid()[0].body.continuity_mode, "evolve");
    h.choice.mode = "new"; h.coordinator.settingsChanged(); h.advance(650); await settle();
    assert.equal(h.paid()[1].body.continuity_mode, "fresh"); assert.equal(h.coordinator.snapshot().nextMode, "new");
    h.coordinator.stop();
  }
  {
    const h = harness({ track: job("saved"), choice: { mode: "loop", trackId: "" }, reentrant: true });
    await h.coordinator.resume();
    h.choice.mode = "old"; h.choice.trackId = "saved"; h.coordinator.settingsChanged(); await settle();
    assert.equal(h.coordinator.snapshot().phase, "looping"); assert.equal(h.updates.at(-1).phase, "looping", "selecting the playing track updates the visible state");
    assert.equal(h.calls.filter(call => call.path).length, 0, "selecting the playing track does not reload or queue itself");
    h.coordinator.stop();
  }
  for (const mode of ["old", "loop"]) {
    const plan = defer();
    const h = harness({ track: job("saved"), choice: { mode: "new", trackId: "" }, request(path) {
      if (path === "/plans") return plan.promise;
    } });
    const started = h.coordinator.startNew(); await settle();
    h.choice.mode = mode; h.coordinator.settingsChanged(); plan.resolve({ id: "late-plan" }); await started; await settle();
    assert.equal(h.paid().length, 0, `changing to ${mode} before the plan response blocks a later music POST`);
    h.coordinator.stop();
  }
  {
    const generation = defer(); let ready = false;
    const h = harness({ track: job("saved"), choice: { mode: "new", trackId: "" }, request(path) {
      if (path === "/continuations") return generation.promise;
      if (path === "/generations/chosen") return job("chosen", { state: ready ? "complete" : "queued", generation_settings: { bpm: 100 } });
    } });
    await h.coordinator.resume(); await settle();
    h.choice.mode = "old"; h.choice.trackId = "chosen"; h.coordinator.settingsChanged(); await settle();
    assert.equal(h.coordinator.snapshot().phase, "error"); ready = true;
    assert.equal(await h.coordinator.retry(), true); await settle();
    assert.equal(h.coordinator.snapshot().queuedId, "chosen", "saved-track retry bypasses unrelated provider busy");
    generation.resolve(job("retired")); await settle(); assert.equal(h.paid().length, 1); h.coordinator.stop();
  }
  {
    const original = defer();
    const h = harness({ choice: { mode: "new", trackId: "" }, reentrant: true, request(path, request) {
      if (path === "/generations" && request.method === "POST") return original.promise;
      if (path === "/generations/chosen") return job("chosen", { generation_settings: { bpm: 100 } });
    } });
    const started = h.coordinator.startNew(); await settle();
    h.choice.mode = "old"; h.choice.trackId = "chosen"; h.coordinator.settingsChanged(); await settle();
    assert.equal(h.engine.snapshot().track.id, "chosen"); assert.equal(h.engine.snapshot().running, true);
    assert.equal(JSON.parse([...h.saved.values()][0]).saveOnly, true, "saved playback persists ownership over a pending original");
    h.choice.mode = "new"; h.coordinator.settingsChanged(); h.advance(650); await settle();
    original.resolve(job("retired-original")); await started; await settle();
    assert.equal(h.engine.snapshot().track.id, "chosen", "returning to generation cannot abruptly install an older original");
    assert.ok(h.tracks.some(track => track.id === "retired-original"));
    assert.ok(!h.calls.some(call => call.audio === "set" && call.id === "retired-original"));
    assert.equal(h.paid().at(-1).body.source_job_id, "chosen", "new generation follows the explicitly chosen song");
    h.coordinator.stop();
  }
  {
    const original = defer();
    const h = harness({ track: job("stopped"), choice: { mode: "new", trackId: "" }, request(path, request) {
      if (path === "/generations" && request.method === "POST") return original.promise;
      if (path === "/generations/chosen") return job("chosen", { generation_settings: { bpm: 100 } });
    } });
    const started = h.coordinator.startNew(); await settle();
    h.choice.mode = "old"; h.choice.trackId = "chosen"; h.coordinator.settingsChanged(); await settle();
    assert.equal(h.coordinator.snapshot().phase, "ready", "a stopped current track does not pretend saved audio is already loading");
    assert.ok(!h.calls.some(call => call.path === "/generations/chosen"));
    assert.equal(await h.coordinator.startNew(), true); await settle();
    assert.equal(h.engine.snapshot().track.id, "chosen"); assert.equal(h.engine.snapshot().running, true);
    original.resolve(job("retired-original")); await started; await settle();
    assert.equal(h.paid().length, 1); assert.equal(h.engine.snapshot().track.id, "chosen"); h.coordinator.stop();
  }
  {
    const uploaded = job("custom", { origin: "uploaded" });
    const h = harness({ choice: { mode: "loop", trackId: "" }, reentrant: true });
    await h.coordinator.recall(uploaded); await h.coordinator.resume(); await settle();
    assert.equal(h.engine.snapshot().track.id, uploaded.id);
    assert.equal(h.engine.snapshot().running, true);
    assert.equal(h.coordinator.snapshot().phase, "looping");
    assert.equal(h.calls.filter(call => call.path).length, 0, "recalling and playing custom audio in Loop never submits generation or separation");
    h.coordinator.stop();
  }
  for (const mode of ["new", "similar"]) {
    const uploaded = job("custom", { origin: "uploaded" });
    const h = harness({ track: uploaded, choice: { mode: "loop", trackId: "" }, reentrant: true });
    await h.coordinator.resume();
    h.choice.mode = mode; h.coordinator.settingsChanged(); h.advance(650); await settle();
    assert.equal(h.paid().length, 1);
    assert.equal(h.paid()[0].path, "/generations", "custom audio never becomes a provider continuation anchor");
    assert.equal(h.paid()[0].body.plan_id, "new-plan");
    assert.deepEqual(h.calls.find(call => call.path === "/plans").body,
      { kind: "original", duration_seconds: 60, settings: h.settings.settings }, "upcoming custom-audio generations use only the current musical prompt");
    assert.equal(h.engine.snapshot().track.id, uploaded.id, "custom audio continues while the new piece is prepared");
    assert.equal(h.engine.snapshot().queuedTrack.id, "new-1");
    assert.equal(h.calls.filter(call => call.audio === "set").length, 0, "a prompt-based next track is queued without restarting playback");
    const pending = JSON.parse([...h.saved.values()][0]);
    assert.equal(pending.kind, "next"); assert.equal(pending.path, "/generations"); assert.equal(pending.sourceId, uploaded.id);
    h.promote(); await settle();
    assert.equal(h.paid().at(-1).path, "/continuations", "generated music resumes its normal continuation flow after promotion");
    h.coordinator.stop();
  }
  {
    const uploaded = job("custom", { origin: "uploaded" }), inFlight = defer();
    const original = job("older-original", { plan_id: "new-plan" });
    let submitted = false;
    const h = harness({ choice: { mode: "new", trackId: "" }, reentrant: true, request(path, options) {
      if (path === "/generations" && options.method === "POST" && !submitted) { submitted = true; return inFlight.promise; }
      if (path === "/generations" && options.method !== "POST") return { jobs: submitted ? [original] : [] };
    } });
    const started = h.coordinator.startNew(); await settle();
    h.choice.mode = "loop"; h.coordinator.settingsChanged(); await h.coordinator.recall(uploaded);
    inFlight.resolve(original); await started;
    await h.coordinator.resume(); await settle();
    assert.equal(h.engine.snapshot().track.id, uploaded.id);
    assert.equal(h.paid().length, 1, "upload recall never resumes an earlier generation pipeline");
    assert.equal(JSON.parse([...h.saved.values()][0]).saveOnly, true);
    h.choice.mode = "new"; h.coordinator.settingsChanged(); h.advance(650); await settle();
    assert.ok(h.tracks.some(track => track.id === original.id), "earlier accepted work remains recoverable into history");
    assert.equal(h.engine.snapshot().track.id, uploaded.id, "recovered older originals cannot replace custom audio");
    assert.ok(!h.calls.some(call => call.audio === "set" && call.id === original.id));
    assert.equal(h.paid().length, 2); assert.equal(h.paid()[1].path, "/generations");
    assert.equal(h.engine.snapshot().queuedTrack.id, "new-1"); h.coordinator.stop();
  }
  {
    const uploaded = job("custom", { origin: "uploaded" });
    const h = harness({ track: uploaded, choice: { mode: "new", trackId: "" }, request(path, options) {
      if (path === "/generations" && options.method === "POST") throw new Error("Response lost");
    } });
    await h.coordinator.resume(); await settle();
    assert.equal(h.paid().length, 1);
    await h.coordinator.retry(); await settle();
    assert.equal(h.paid().length, 1, "even explicit retry cannot repeat an uncertain non-idempotent original request");
    h.coordinator.stop();
    const recovered = job("fresh-custom-next", { plan_id: "new-plan" });
    const restored = harness({ track: uploaded, saved: h.saved, choice: { mode: "new", trackId: "" }, request(path) {
      if (path === "/generations") return { jobs: [recovered] };
    } });
    await settle(); assert.equal(restored.calls.length, 0, "restoring an upload's upcoming track does not resume work");
    await restored.coordinator.resume(); await settle();
    assert.equal(restored.paid().length, 0, "an uncertain original request is recovered by GET without another charge");
    assert.equal(restored.engine.snapshot().track.id, uploaded.id);
    assert.equal(restored.engine.snapshot().queuedTrack.id, recovered.id); restored.coordinator.stop();
  }
  {
    let rejected = true, submissions = 0, reads = 0;
    const fetch = async (url, options) => {
      const path = url.replace("/api/elevenlabs", "");
      let body, status = 200;
      if (path === "/plans") body = { id: "new-plan" };
      else if (options.method === "POST") {
        submissions++;
        if (rejected) { status = 503; body = { error: "Set ELEVENLABS_API_KEY", code: "generation_not_submitted" }; }
        else body = job(`accepted-${submissions}`);
      } else { reads++; body = { jobs: [] }; }
      return { ok: status === 200, status, json: async () => body };
    };
    const first = harness({ fetch });
    assert.equal(await first.coordinator.startNew(), false);
    assert.equal(JSON.parse(first.saved.get("hydra.music-mixer.pending.v1")).stage, "failed");
    first.coordinator.stop(); rejected = false;
    const before = [submissions, reads], restored = harness({ fetch, saved: first.saved });
    await settle(); assert.deepEqual([submissions, reads], before, "configuring a key and reloading never submits automatically");
    assert.equal(await restored.coordinator.retry(), true); await settle();
    assert.equal(submissions, 3, "explicit retry replaces the rejected attempt and prepares one spare");
    assert.equal(restored.engine.snapshot().running, true);
    restored.coordinator.stop();
  }
  for (const status of [500, 503]) {
    const h = harness({ request(path, options) {
      if (path === "/generations" && options.method === "POST") throw Object.assign(new Error("Service unavailable"), { status });
    } });
    await h.coordinator.startNew();
    assert.equal(JSON.parse(h.saved.get("hydra.music-mixer.pending.v1")).stage, "submitting");
    await h.coordinator.retry(); await settle();
    assert.equal(h.paid().length, 1, "unmarked server failures remain ambiguous and cannot automatically resubmit");
    h.coordinator.stop();
    const restored = harness({ saved: h.saved });
    assert.equal(restored.coordinator.snapshot().canClearPending, true);
    restored.saved.set("another-workspace", "keep me");
    assert.equal(restored.coordinator.clearPending(), true);
    assert.equal(restored.saved.has("hydra.music-mixer.pending.v1"), false);
    assert.equal(restored.saved.get("another-workspace"), "keep me");
    assert.equal(restored.coordinator.snapshot().canClearPending, false);
    assert.equal(restored.coordinator.snapshot().enabled, false);
    assert.equal(restored.calls.some(call => call.path), false, "clearing the local journal neither deletes server jobs nor submits work");
  }
  {
    const response = defer(), h = harness({ request(path, options) {
      if (path === "/generations" && options.method === "POST") return response.promise;
    } });
    const started = h.coordinator.startNew(); await settle();
    assert.equal(h.coordinator.clearPending(), false, "an active submission cannot be cleared");
    response.resolve(job("accepted", { state: "queued" })); await settle();
    h.coordinator.stop(); await started;
    assert.equal(h.coordinator.snapshot().canClearPending, false);
    assert.equal(h.coordinator.clearPending(), false, "a confirmed saved job must retain its recovery journal");
    assert.equal(JSON.parse(h.saved.get("hydra.music-mixer.pending.v1")).jobId, "accepted");
  }
  console.log("Mixer generation tests passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
