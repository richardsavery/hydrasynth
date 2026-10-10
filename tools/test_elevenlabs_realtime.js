"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../dashboard/elevenlabs-realtime.js"), "utf8");
const context = vm.createContext({ URL });
vm.runInContext(source, context);
const { normalize, mapValue, replayValue, summarize, shouldGenerate, validateSettings } = context.HydraElevenRealtime;

assert.equal(normalize(null, 0, 1), null, "missing source data must not become zero");
assert.equal(normalize(NaN, 0, 1), null);
assert.equal(normalize(2, 0, 1), 1);
assert.equal(normalize(-2, 0, 1), 0);
assert.equal(normalize(0.25, 0, 1, true), 0.75);
assert.equal(normalize(1, 1, 1), null, "constant/invalid input bounds must not invent motion");
assert.equal(normalize(1, 3, 1), null);
assert.equal(mapValue(0.5, { target: "cutoff", outputMin: 200, outputMax: 20000 }), 2000, "frequency should use a perceptually useful logarithmic scale");
assert.equal(mapValue(0.5, { target: "pan", outputMin: -1, outputMax: 1 }), 0);
assert.equal(mapValue(1, { target: "gain", outputMin: 0, outputMax: 50 }), 1, "audio output bounds must be safe even with an invalid editor input");
assert.equal(mapValue(0.5, { target: "stem:drums", outputMin: 0, outputMax: 1 }), 0.5);

const validated = validateSettings({ mode: "unexpected", address: "javascript:alert(1)", duration: 9999, budget: 9999,
  starterId: "<script>", armed: true, autoStems: true, mappings: Array.from({ length: 8 }, () => ({ target: "__proto__",
    sourceKey: "x".repeat(2000), index: -2, reducer: "unknown", inputMin: 10, inputMax: 1, outputMin: -999, outputMax: 999999, smoothing: 999 })) });
assert.equal(validated.mode, "replay");
assert.equal(validated.address, "ws://127.0.0.1:8765");
assert.equal(validated.duration, 60);
assert.equal(validated.budget, 20);
assert.equal(validated.starterId, null);
assert.equal(validated.mappings.length, 6, "stored mappings must stay within the UI and processing bound");
assert.equal(validated.mappings[0].target, "cutoff");
assert.equal(validated.mappings[0].sourceKey, "activity");
assert.equal(validated.mappings[0].inputMin, 0);
assert.equal(validated.mappings[0].inputMax, 1);
assert.equal(validated.mappings[0].outputMin, 20);
assert.equal(validated.mappings[0].outputMax, 20000);
assert.equal(validated.mappings[0].smoothing, 5);
assert.equal("armed" in validated, false, "credit authorization must never be restored or persisted");
assert.equal("autoStems" in validated, false);
assert.equal(validateSettings({ address: "wss://example.test/live" }).address, "wss://example.test/live");

const analysis = { duration_seconds: 3, settings: { start_seconds: 20, max_gap_seconds: 1.1 },
  timeline: { times: [20, 21, 22], signal: [0, 1, null], channels: { movement: [0.1, 0.5, 0.7] }, valid: [true, true, false] } };
assert.equal(replayValue(analysis, "activity", 0.5), 0.5);
assert.equal(replayValue(analysis, "activity", 3.5), 0.5, "recording replay should loop in source time");
assert.equal(replayValue(analysis, "activity", 1.5), null, "replay must preserve invalid spans");
assert.equal(replayValue(analysis, "missing", 0), null);
assert.equal(replayValue(analysis, "movement", 0), 0.1);
assert.equal(replayValue({ ...analysis, settings: { ...analysis.settings, max_gap_seconds: 0.1 } }, "activity", 0.5), null);

const summary = summarize([{ at: -10000, value: 1 }, { at: 0, value: 0 }, { at: 500, value: null }, { at: 1000, value: 1 }], 1000);
assert.equal(summary.activity, 0.5);
assert.equal(summary.variability, 1);
assert.equal(summary.coverage, 2 / 3);
assert.equal(summary.sample_count, 2);
assert.equal(summary.window_seconds, 1);
assert.equal(summarize([{ at: 1000, value: null }], 1000), null);
const ready = { running: true, armed: true, pending: null, queued: null, used: 0, budget: 3,
  sourceValid: true, features: { ...summary, coverage: 1 }, remaining: 20, lookahead: 50 };
assert.equal(shouldGenerate(ready), true);
for (const guard of [{ running: false }, { armed: false }, { pending: {} }, { queued: {} }, { used: 3 }, { sourceValid: false },
  { features: null }, { features: summary }, { features: { ...summary, coverage: 1, window_seconds: 0.1 } }, { remaining: 60 }]) {
  assert.equal(shouldGenerate({ ...ready, ...guard }), false, `generation guard failed: ${JSON.stringify(guard)}`);
}

function harness(fetchHandler, options = {}) {
  const elements = new Map(), players = [], requests = [], timeouts = [];
  let now = 0, tick, pauseCount = 0, prepareCount = 0, sourceValue = 0.5, stored = JSON.stringify(options.settings || {});
  class Element {
    constructor(id) { this.id = id; this.value = id === "budget" ? "3" : id === "duration" ? "60" : ""; this.checked = false; this.dataset = {}; this.listeners = {}; this.classList = { add() {}, toggle() {} }; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    async event(name, properties = {}) { return this.listeners[name]?.({ target: this, ...properties }); }
  }
  const element = (id) => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const root = { classList: { add() {} }, querySelector(selector) { return element(selector.replace("#el-rt-", "")); } };
  class Player {
    constructor(options) { this.options = options; this.stemNames = []; this.warnings = []; this.remainingSeconds = 15; this.currentPosition = 5; players.push(this); }
    async loadTrack(track) { this.currentTrack = track; this.stemNames = (track.stems || []).map((stem) => stem.name); }
    async resume() {}
    async start() { this.playing = true; }
    stop() { this.playing = false; this.queuedTrack = null; }
    dispose() { this.stop(); }
    setSourceValid(value) { this.valid = value; }
    updateControls(controls, valid) { this.controls = controls; this.valid = valid; }
    async queueTrack(track) { this.queuedTrack = track; }
    transition() { const track = this.queuedTrack; this.currentTrack = track; this.stemNames = (track.stems || []).map((stem) => stem.name); this.queuedTrack = null; this.options.onTransition(track); }
  }
  const sandbox = vm.createContext({ URL, performance: { now: () => now }, crypto: { randomUUID: () => "test-session" },
    localStorage: { getItem() { if (options.storageUnavailable) throw new Error("Storage unavailable"); return stored; },
      setItem(key, value) { if (options.storageUnavailable) throw new Error("Storage unavailable"); stored = value; } },
    HydraElevenPlayer: { Player }, setInterval(callback) { tick = callback; return 1; }, clearInterval() { tick = null; },
    setTimeout(callback, delay) { timeouts.push({ callback, at: now + delay }); }, clearTimeout() {}, fetch: async (url, options) => {
      const request = { url, options, body: options.body ? JSON.parse(options.body) : null }; requests.push(request);
      const data = await fetchHandler(request);
      return { ok: !data.httpStatus || data.httpStatus < 400, status: data.httpStatus || 200, json: async () => data.httpStatus ? data.data : data };
    } });
  vm.runInContext(source, sandbox);
  const selection = { plan: { id: "plan" }, currentJob: options.starter || { id: "starter", plan_id: "plan", state: "complete", audio_url: "/saved.mp3", stems: [{ name: "bass", audio_url: "/bass.mp3" }] }, analysis, jobs: options.jobs || [] };
  sandbox.HydraElevenRealtime.init({ container: root, getSelection: () => selection, pauseOriginal() { pauseCount++; },
    sourceBridge: { describe: () => ({ mode: "recording", label: "test source", fields: [{ key: "activity", name: "activity" }] }),
      read: () => sourceValue === null ? null : ({ value: sourceValue, at: now }), async prepare() { prepareCount++; }, reset() {} } });
  sandbox.HydraElevenRealtime.activate();
  return { app: sandbox.HydraElevenRealtime, elements, element, players, requests, get pauseCount() { return pauseCount; }, get prepareCount() { return prepareCount; }, set sourceValue(value) { sourceValue = value; }, get saved() { return JSON.parse(stored); },
    async advance(milliseconds) { now += milliseconds; for (const timeout of timeouts.splice(0)) { if (timeout.at <= now) timeout.callback(); else timeouts.push(timeout); } tick?.(); for (let i = 0; i < 32; i++) await Promise.resolve(); } };
}

(async () => {
  const savedStems = [{ name: "drums", audio_url: "/drums.mp3" }];
  const app = harness(async (request) => ({ id: `segment-${request.body.sequence}`, plan_id: "next-plan", state: "complete", audio_url: "/next.mp3", generation_latency_seconds: 2, stem_separation: { state: "complete", stems: savedStems } }));
  app.element("source").value = "demo";
  await app.element("source").event("change");
  await app.element("play").event("click");
  await app.advance(2000);
  assert.equal(app.pauseCount, 1, "native audio should pause when reactive playback starts");
  assert.equal(app.requests.length, 0, "Playback with saved stems and local modulation must not trigger paid calls");
  assert.equal(app.players[0].valid, true);
  assert.ok(app.players[0].controls.cutoff >= 220);
  app.element("auto").checked = true;
  await app.element("auto").event("change");
  await app.advance(50);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].url, "/api/elevenlabs/continuations");
  assert.equal(app.requests[0].body.source_job_id, "starter");
  assert.equal(app.requests[0].body.sequence, 0);
  assert.equal(app.requests[0].body.features.source, "demo");
  await app.advance(50);
  assert.equal(app.requests.length, 1, "a queued next track must prevent a second request");
  app.players[0].remainingSeconds = 10;
  for (let i = 0; i < 3; i++) { assert.ok(app.players[0].queuedTrack, `iteration ${i}: ${app.element("notice").textContent}; ${app.element("next").textContent}`); app.players[0].transition(); await app.advance(50); await app.advance(50); }
  assert.equal(app.requests.length, 3, "session generation budget must stop requests after its bound");
  await app.element("stop").event("click");
  assert.equal(app.element("auto").checked, false, "stopping must disarm future spending");
  await app.advance(1000);
  assert.equal(app.requests.length, 3);

  let complete;
  const late = harness(() => new Promise((resolve) => { complete = resolve; }));
  late.element("source").value = "shared"; await late.element("source").event("change");
  await late.element("play").event("click");
  assert.ok(late.prepareCount >= 2, "shared recorded sources must prepare their independently sampled series");
  late.element("auto").checked = true; await late.element("auto").event("change");
  await late.advance(2000);
  assert.equal(late.requests.length, 1);
  late.app.deactivate();
  complete({ id: "late", state: "complete", audio_url: "/late.mp3" });
  await late.advance(50);
  assert.equal(late.players[0].queuedTrack, null, "a paid response arriving after stop must not resurrect audio or queue a track");
  assert.equal(late.element("auto").checked, false);

  const failed = harness(async () => ({ id: "failed", state: "unknown", error: "Timed out" }));
  failed.element("source").value = "demo"; await failed.element("source").event("change");
  await failed.element("play").event("click");
  failed.element("auto").checked = true; await failed.element("auto").event("change");
  await failed.advance(2000);
  await failed.advance(1000);
  assert.equal(failed.requests.length, 1, "unknown provider outcomes must never auto-retry");
  assert.equal(failed.element("auto").checked, false);
  assert.match(failed.element("notice").textContent, /unknown/);

  const missing = harness(async () => { throw new Error("Missing source must not request generation"); });
  missing.element("source").value = "shared"; await missing.element("source").event("change");
  await missing.element("play").event("click");
  missing.sourceValue = null;
  missing.element("auto").checked = true; await missing.element("auto").event("change");
  await missing.advance(5000);
  assert.equal(missing.players[0].valid, false, "missing source must fade audio instead of inventing motion");
  assert.equal(missing.requests.length, 0, "missing source must pause paid requests");

  const stems = harness(async (request) => request.url.endsWith("/stems") ? { state: "complete", stems: savedStems } : { id: "with-stems", plan_id: "plan", state: "complete", audio_url: "/mix.mp3", stem_separation: { state: "queued", stems: [] } });
  stems.element("source").value = "demo"; await stems.element("source").event("change");
  await stems.element("play").event("click");
  stems.element("auto").checked = true; await stems.element("auto").event("change");
  await stems.advance(2000); await stems.advance(50); await stems.advance(50);
  assert.equal(stems.players[0].queuedTrack, undefined, "upcoming music should wait until its automatic separation completes");
  await stems.advance(2000);
  assert.equal(stems.requests.length, 2, "upcoming stems should be prepared by default: one generation and a status read");
  assert.equal(stems.requests[1].options.method, "GET", "server-queued separation must never receive a duplicate paid POST");
  assert.equal(stems.players[0].queuedTrack.stems[0].name, "drums");

  const stemFailure = harness(async () => ({ id: "mix-only", plan_id: "plan", state: "complete", audio_url: "/mix.mp3", stem_separation: { state: "unknown", error: "provider timeout" } }));
  stemFailure.element("source").value = "demo"; await stemFailure.element("source").event("change");
  await stemFailure.element("play").event("click");
  stemFailure.element("auto").checked = true; await stemFailure.element("auto").event("change");
  await stemFailure.advance(2000); await stemFailure.advance(50); await stemFailure.advance(50);
  assert.equal(stemFailure.players[0].queuedTrack.id, "mix-only", "failed stems must preserve the completed original mix");
  assert.equal(stemFailure.element("auto").checked, false, "failed automatic separation must disarm paid requests");
  assert.equal(stemFailure.requests.length, 1, "unknown separation outcomes must not be resubmitted");

  const restored = harness(async () => { throw new Error("Restored settings must not authorize paid calls"); }, {
    settings: { mode: "demo", duration: 40, budget: 7, address: "wss://example.test/live", starterId: "saved-stems", armed: true, autoStems: true,
      mappings: [{ sourceKey: "activity", target: "stem:drums", inputMin: 0, inputMax: 1, outputMin: 0.1, outputMax: 0.9, smoothing: 0.2 }] },
    jobs: [{ id: "saved-stems", state: "complete", audio_url: "/saved-with-stems.mp3", realtime: { conditioning_applied: false }, stem_separation: { state: "complete", stems: [{ name: "drums", audio_url: "/saved-drums.mp3" }] } }] });
  assert.equal(restored.element("track").value, "saved-stems", "reactive starter selection must survive initial offline-plan restoration");
  assert.equal(restored.element("source").value, "demo");
  assert.equal(restored.element("duration").value, "40");
  assert.equal(restored.element("budget").value, "7");
  assert.equal(restored.element("address").value, "wss://example.test/live");
  assert.equal(restored.element("auto").checked, false);
  assert.equal(restored.elements.has("auto-stems"), false, "stem preparation should no longer require an optional checkbox");
  assert.equal(restored.element("audio-download").href, "/saved-with-stems.mp3");
  assert.equal(restored.element("export").href, "/api/elevenlabs/generations/saved-stems/export");
  assert.match(restored.element("track-context").textContent, /generated independently/);
  assert.match(restored.element("mappings").innerHTML, /value="stem:drums" selected/);
  assert.doesNotMatch(restored.element("mappings").innerHTML, /drums · unavailable/, "saved stems from the jobs list must populate mappings even when not the offline currentJob");
  await restored.element("play").event("click"); await restored.advance(2000);
  assert.equal(restored.players[0].currentTrack.stems[0].name, "drums");
  assert.equal(restored.requests.length, 0);
  restored.element("budget").value = "9"; await restored.element("budget").event("change");
  assert.equal(restored.saved.budget, 9);
  assert.equal(restored.saved.mappings[0].target, "stem:drums");
  assert.equal("id" in restored.saved.mappings[0], false, "transient row state should not be persisted");
  assert.equal("armed" in restored.saved, false);
  assert.equal("autoStems" in restored.saved, false);
  await restored.element("stop").event("click");
  restored.element("track").value = "starter"; await restored.element("track").event("change");
  assert.match(restored.element("mappings").innerHTML, /drums · unavailable/, "a stopped old player's stems must not mask the selected full-mix track");
  restored.element("auto").checked = true; await restored.element("auto").event("change");
  await restored.element("disconnect").event("click");
  assert.equal(restored.element("auto").checked, false, "explicit source disconnection must disarm future spending");

  const legacyStarter = { id: "legacy", plan_id: "plan", state: "complete", audio_url: "/legacy.mp3" };
  const legacy = harness(async (request) => request.options.method === "GET" ? { state: "not_requested", stems: [] } : { state: "complete", stems: savedStems }, { starter: legacyStarter, settings: { mode: "demo", armed: true } });
  await legacy.advance(5000);
  assert.equal(legacy.requests.length, 0, "loading, selecting and restoring a legacy track must never submit paid work");
  assert.equal(legacy.element("auto").checked, false, "new music generation remains off even with automatic stem preparation");
  assert.match(legacy.element("play").textContent, /uses credits/, "first play must disclose its stem preparation cost");
  await legacy.element("play").event("click"); await legacy.advance(50);
  assert.equal(legacy.players[0].playing, true, "the existing full mix should keep playing while stems become available");
  assert.equal(legacy.requests.length, 2);
  assert.equal(legacy.requests[0].options.method, "GET");
  assert.equal(legacy.requests[1].options.method, "POST", "first playback should prepare missing legacy stems once");
  assert.equal(legacy.players[0].queuedTrack.stems[0].name, "drums");
  assert.match(legacy.element("mappings").innerHTML, /value="stem:drums"/, "ready stems should populate mapping options before their boundary transition");
  legacy.players[0].transition();
  await legacy.element("stop").event("click");
  await legacy.element("play").event("click"); await legacy.advance(50);
  assert.equal(legacy.requests.length, 2, "replaying prepared legacy stems must reuse cached results without another paid call");
  assert.equal(legacy.players[1].stemNames[0], "drums");

  const durableCached = harness(async () => ({ state: "complete", stems: savedStems }), { starter: legacyStarter, settings: { mode: "demo" } });
  await durableCached.element("play").event("click"); await durableCached.advance(50);
  assert.equal(durableCached.requests.length, 1);
  assert.equal(durableCached.requests[0].options.method, "GET", "metadata missing from an old list must not duplicate an already saved server separation");
  assert.equal(durableCached.players[0].queuedTrack.stems[0].name, "drums");

  const preparingStarter = harness(async () => ({ state: "complete", stems: savedStems }), {
    starter: { ...legacyStarter, stem_separation: { state: "queued", stems: [] } }, settings: { mode: "demo" } });
  await preparingStarter.element("play").event("click");
  assert.equal(preparingStarter.players[0].playing, true, "a new starter still separating on the server should play its full mix immediately");
  await preparingStarter.advance(2000);
  assert.equal(preparingStarter.requests.length, 1);
  assert.equal(preparingStarter.requests[0].options.method, "GET");
  assert.equal(preparingStarter.players[0].queuedTrack.stems[0].name, "drums");

  const legacyFailed = harness(async () => { throw new Error("Previously unresolved stems must not retry"); }, {
    starter: { ...legacyStarter, stem_separation: { state: "unknown", error: "Previous timeout" } }, settings: { mode: "demo" } });
  await legacyFailed.element("play").event("click"); await legacyFailed.advance(100);
  assert.equal(legacyFailed.requests.length, 0);
  assert.equal(legacyFailed.players[0].playing, true);
  assert.match(legacyFailed.element("notice").textContent, /Previous timeout/);

  let finishStatus;
  const stopBeforeSubmit = harness(() => new Promise((resolve) => { finishStatus = resolve; }), { starter: legacyStarter, settings: { mode: "demo" } });
  await stopBeforeSubmit.element("play").event("click");
  stopBeforeSubmit.app.deactivate();
  finishStatus({ state: "not_requested", stems: [] }); await stopBeforeSubmit.advance(50);
  assert.equal(stopBeforeSubmit.requests.length, 1, "stopping during a status read must prevent a later paid POST");
  assert.equal(stopBeforeSubmit.players[0].queuedTrack, null);

  let finishSeparation;
  const stopDuringSubmit = harness(async (request) => request.options.method === "GET" ? { state: "not_requested", stems: [] } : new Promise((resolve) => { finishSeparation = resolve; }), { starter: legacyStarter, settings: { mode: "demo" } });
  await stopDuringSubmit.element("play").event("click"); await stopDuringSubmit.advance(50);
  assert.equal(stopDuringSubmit.requests.length, 2);
  stopDuringSubmit.app.deactivate();
  finishSeparation({ state: "complete", stems: savedStems }); await stopDuringSubmit.advance(50);
  assert.equal(stopDuringSubmit.players[0].queuedTrack, null, "a paid stem result arriving after stop must not queue audio");
  assert.equal(stopDuringSubmit.players[0].playing, false);
  stopDuringSubmit.app.activate();
  await stopDuringSubmit.element("play").event("click"); await stopDuringSubmit.advance(50);
  assert.equal(stopDuringSubmit.requests.length, 2, "a completed late result should be cached for the next deliberate playback");
  assert.equal(stopDuringSubmit.players[1].stemNames[0], "drums");

  const uncertain = harness(async (request) => {
    if (request.options.method === "GET") return { state: "not_requested", stems: [] };
    throw new Error("Connection lost after submission");
  }, { starter: legacyStarter, settings: { mode: "demo" } });
  await uncertain.element("play").event("click"); await uncertain.advance(50);
  await uncertain.element("stop").event("click");
  await uncertain.element("play").event("click"); await uncertain.advance(50);
  assert.equal(uncertain.requests.length, 2, "restarting playback must not retry an uncertain paid stem submission");
  assert.match(uncertain.element("stem-status").textContent, /unknown/);

  const privateMode = harness(async () => { throw new Error("No requests expected"); }, { storageUnavailable: true });
  privateMode.element("source").value = "demo"; await privateMode.element("source").event("change");
  await privateMode.element("play").event("click"); await privateMode.advance(2000);
  assert.equal(privateMode.players[0].valid, true, "unavailable browser storage must not break playback");
  console.log("ElevenLabs realtime: mappings, gaps, generation budgets, default stems, legacy preparation, cache reuse, stop races, missing data, stem fallback and saved configuration passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
