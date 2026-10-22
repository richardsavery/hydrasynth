"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../dashboard/elevenlabs-realtime.js"), "utf8");
const context = vm.createContext({ URL });
vm.runInContext(source, context);
const { normalize, mapValue, replayValue, summarize, shouldGenerate, validateSettings, normalizeSource, resetLearning, combineInputs, routeControl } = context.HydraElevenRealtime;

assert.equal(normalize(null, 0, 1), null, "missing source data must not become zero");
assert.equal(normalize(NaN, 0, 1), null);
assert.equal(normalize(2, 0, 1), 1);
assert.equal(normalize(-2, 0, 1), 0);
assert.equal(normalize(0.25, 0, 1, true), 0.75);
assert.equal(normalize(1, 1, 1), null, "constant/invalid input bounds must not invent motion");
assert.equal(normalize(1, 3, 1), null);
assert.equal(mapValue(0.5, { target: "cutoff", outputMin: 200, outputMax: 20000 }), 2000, "frequency should use a perceptually useful logarithmic scale");
assert.equal(mapValue(0.5, { target: "pan", outputMin: -1, outputMax: 1 }), 0);
assert.equal(mapValue(0.75, { target: "pitch", outputMin: -12, outputMax: 12 }), 6, "pitch maps linearly in semitones");
assert.equal(mapValue(1, { target: "pitch", outputMin: -99, outputMax: 99 }), 12);
assert.equal(mapValue(1, { target: "gain", outputMin: 0, outputMax: 50 }), 1, "audio output bounds must be safe even with an invalid editor input");
assert.equal(mapValue(0.5, { target: "stem:drums", outputMin: 0, outputMax: 1 }), 0.5);

const validated = validateSettings({ mode: "unexpected", address: "javascript:alert(1)", duration: 9999, budget: 9999,
  starterId: "<script>", armed: true, autoStems: true, mappings: Array.from({ length: 20 }, () => ({ target: "__proto__",
    sourceKey: "x".repeat(2000), index: -2, reducer: "unknown", inputMin: 10, inputMax: 1, outputMin: -999, outputMax: 999999, smoothing: 999 })) });
assert.equal(validated.mode, "replay");
assert.equal(validated.address, "ws://127.0.0.1:8765");
assert.equal(validated.duration, 60);
assert.equal(validated.budget, 20);
assert.equal(validated.starterId, null);
assert.equal(validated.mappings.length, 16, "stored mappings must stay within the UI and processing bound");
assert.equal(validated.mappings[0].target, "cutoff");
assert.equal(validated.mappings[0].sources[0].sourceKey, "activity");
assert.equal(validated.mappings[0].sources[0].inputMin, 0);
assert.equal(validated.mappings[0].sources[0].inputMax, 1);
assert.equal(validated.mappings[0].outputMin, 20);
assert.equal(validated.mappings[0].outputMax, 20000);
assert.equal(validated.mappings[0].smoothing, 5);
assert.equal("armed" in validated, false, "credit authorization must never be restored or persisted");
assert.equal("autoStems" in validated, false);
assert.equal(validateSettings({ address: "wss://example.test/live" }).address, "wss://example.test/live");
const validatedMix = validateSettings({ stemMix: { bass: 10, drums: -2, invalid: "loud" }, mutedStems: ["bass", "bass", "", "bad\nname", 42] });
assert.equal(validatedMix.stemMix.bass, 1);
assert.equal(validatedMix.stemMix.drums, 0);
assert.equal(validatedMix.stemMix.invalid, undefined);
assert.deepEqual([...validatedMix.mutedStems], ["bass"]);
assert.equal(validateSettings({ mutedStems: Array.from({ length: 40 }, (_, i) => `stem-${i}`) }).mutedStems.length, 16);

const legacyMapping = validateSettings({ mappings: [{ sourceKey: "pulse", target: "stem:Bass", inputMin: 10, inputMax: 50 }] }).mappings[0];
assert.equal(legacyMapping.audioSource, "Bass");
assert.equal(legacyMapping.target, "gain");
assert.equal(legacyMapping.sources[0].rangeMode, "fixed", "existing mappings preserve deliberate fixed calibration");
assert.equal(legacyMapping.sources[0].inputMin, 10);
const bounded = validateSettings({ mappings: [{ audioSource: "Bass", target: "rate", sources: Array.from({ length: 12 }, () => ({ sourceKey: "x", rangeMode: "auto" })) }] }).mappings[0];
assert.equal(bounded.sources.length, 6);
assert.equal(bounded.target, "cutoff", "stem speed must not break synchronized playback");
const independentPitch = validateSettings({ mappings: [{ audioSource: "Bass", target: "pitch" }, { target: "rate" }] });
assert.equal(independentPitch.mappings[0].target, "pitch", "pitch is available independently on each stem");
assert.equal(independentPitch.mappings[0].outputMin, -12);
assert.equal(independentPitch.mappings[0].outputMax, 12);
assert.equal(independentPitch.mappings[1].target, "rate");
assert.deepEqual(JSON.parse(JSON.stringify(validateSettings(independentPitch).mappings)), JSON.parse(JSON.stringify(independentPitch.mappings)), "pitch and speed mappings persist independently");
const learning = { rangeMode: "auto", inputMin: 0, inputMax: 1, learnedMin: null, learnedMax: null };
assert.equal(normalizeSource(learning, { value: 50, at: 0 }, 0), 0.5, "a constant learned source produces a neutral midpoint");
assert.equal(normalizeSource(learning, { value: 100, at: 50 }, 50), 1);
assert.equal(normalizeSource(learning, { value: 75, at: 100 }, 100), 0.5);
assert.equal(normalizeSource(learning, { value: -500, at: 0 }, 4000), null, "stale input cannot modify calibration");
assert.equal(learning.learnedMin, 50);
assert.equal(normalizeSource(learning, null, 4000), null);
learning.rangeMode = "fixed";
assert.equal(normalizeSource(learning, { value: 200, at: 4000 }, 4000), 1);
assert.equal(learning.inputMax, 100, "fixed bounds never drift");
learning.rangeMode = "auto"; resetLearning(learning);
assert.equal(normalizeSource(learning, { value: -10, at: 5000 }, 5000), 0.5);
assert.equal(learning.learnedMax, -10, "relearning discards the previous capture");
assert.equal(combineInputs([0.2, 0.8], [{}, {}], "average"), 0.5);
assert.ok(Math.abs(combineInputs([0.2, 0.8], [{ weight: 3 }, { weight: 1 }], "weighted") - 0.35) < 1e-12);
assert.equal(combineInputs([0.2, 0.8], [{}, {}], "sum"), 0.5);
assert.equal(combineInputs([0.2, 0.8], [{ weight: 0 }, { weight: 0 }], "weighted"), 0.5, "zero weights are a neutral midpoint, matching Synth");
assert.ok(Math.abs(combineInputs([0.2, 0.8], [{}, {}], "difference") - 0.2) < 1e-12);
assert.equal(combineInputs([0.2, 0.8], [{}, {}], "minimum"), 0.2);
assert.equal(combineInputs([0.2, null], [{}, {}], "average"), null, "a missing combined constituent invalidates the entire mapping");
const routed = { cutoff: 20000, stemControls: {} };
routeControl(routed, { audioSource: "Bass", target: "cutoff" }, 600);
routeControl(routed, { audioSource: "Bass", target: "pan" }, -0.5);
assert.equal(routed.cutoff, 20000, "stem filters must not change the master filter");
assert.equal(routed.stemControls.Bass.cutoff, 600);
assert.equal(routed.stemControls.Bass.pan, -0.5);
routeControl(routed, { audioSource: "Bass", target: "rate" }, 0.8);
assert.equal(routed.stemControls.Bass.rate, undefined);
routeControl(routed, { audioSource: "master", target: "rate" }, 1.1);
routeControl(routed, { audioSource: "master", target: "pitch" }, -5);
routeControl(routed, { audioSource: "Bass", target: "pitch" }, 7);
assert.equal(routed.rate, 1.1);
assert.equal(routed.pitch, -5);
assert.equal(routed.stemControls.Bass.pitch, 7);
routeControl(routed, { audioSource: "__proto__", target: "gain" }, 0.5);
assert.equal(Object.prototype.gain, undefined, "provider stem names cannot modify object prototypes");

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
  let now = 0, tick, pauseCount = 0, prepareCount = 0, createCount = 0, sourceValue = 0.5, stored = JSON.stringify(options.settings || {});
  let sourceValues = options.sourceValues;
  let sourceFields = options.fields || [{ key: "activity", name: "activity" }];
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
    async start() { this.initialControls = JSON.parse(JSON.stringify(this.controls || {})); this.initialValid = this.valid; this.playing = true; }
    stop() { this.playing = false; this.queuedTrack = null; }
    dispose() { this.stop(); }
    setSourceValid(value) { this.valid = value; }
    updateControls(controls, valid) { this.controls = { ...this.controls, ...controls }; this.valid = valid; }
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
  sandbox.HydraElevenRealtime.init({ container: root, getSelection: () => selection, getGenerationSettings: options.getGenerationSettings, pauseOriginal() { pauseCount++; }, createTrack() { createCount++; },
    sourceBridge: { describe: () => ({ mode: options.sourceMode || "recording", label: "test source", fields: sourceFields }),
      bounds: () => options.sourceBounds || null,
      read: (source) => { const value = sourceValues ? sourceValues[source.sourceKey] : sourceValue; return value === null || value === undefined ? null : typeof value === "object" ? value : { value, at: now }; }, async prepare() { prepareCount++; }, reset() {} } });
  sandbox.HydraElevenRealtime.activate();
  return { app: sandbox.HydraElevenRealtime, elements, element, players, requests, get html() { return root.innerHTML; }, get pauseCount() { return pauseCount; }, get prepareCount() { return prepareCount; }, get createCount() { return createCount; }, set sourceValue(value) { sourceValue = value; }, set sourceFields(value) { sourceFields = value; }, set sourceValues(value) { sourceValues = value; }, get saved() { return JSON.parse(stored); },
    async toggleStem(name) { await element("stems").event("click", { target: { closest: () => ({ dataset: { stemMute: name } }) } }); },
    async volumeStem(name, value) { await element("stems").event("input", { target: { dataset: { stem: name }, value: String(value) } }); },
    async mappingAction(action, index = 0, sourceIndex = 0) {
      const ids = [...element("mappings").innerHTML.matchAll(/data-mapping="([^"]+)"/g)].map((match) => match[1]);
      const row = { dataset: { mapping: ids[index] } }, button = { dataset: { action, sourceIndex }, closest: () => row };
      await element("mappings").event("click", { target: { closest: () => button } });
    },
    async advance(milliseconds) { now += milliseconds; for (const timeout of timeouts.splice(0)) { if (timeout.at <= now) timeout.callback(); else timeouts.push(timeout); } tick?.(); for (let i = 0; i < 32; i++) await Promise.resolve(); } };
}

(async () => {
  {
    const options = { settings: { mode: "shared", duration: 40, budget: 3 } };
    const h = harness(async () => { throw new Error("Saving settings must not generate audio"); }, options);
    const previous = JSON.stringify(h.saved);
    options.storageUnavailable = true;
    h.element("duration").value = "60";
    assert.doesNotThrow(() => h.app.flush(), "autosave remains optional for ongoing playback");
    assert.throws(() => h.app.flush({ strict: true }), /Storage unavailable/,
      "session capture cannot silently reuse old realtime mappings or controls");
    assert.equal(JSON.stringify(h.saved), previous);
    options.storageUnavailable = false;
    h.app.flush({ strict: true });
    assert.equal(h.saved.duration, 60);
    assert.equal(h.requests.length, 0);
  }
  const sharedDefault = harness(async () => { throw new Error("Opening simplified UI must not spend credits"); }, {
    fields: [{ key: "motion", name: "Motion", default_reducer: "rms", minimum: 10, maximum: 30 }] });
  assert.equal(sharedDefault.element("source").value, "shared", "a fresh workspace uses the Connections input");
  assert.equal(sharedDefault.saved.mappings[0].sources[0].sourceKey, "motion");
  assert.equal(sharedDefault.saved.mappings[0].sources[0].inputMin, 10, "new mapping bounds should use the recording's fixed range");
  assert.equal(sharedDefault.saved.mappings[0].sources[0].inputMax, 30);
  sharedDefault.sourceValue = 20;
  await sharedDefault.element("play").event("click"); await sharedDefault.advance(2000);
  for (let i = 0; i < 40; i++) await sharedDefault.advance(50);
  assert.equal(sharedDefault.players[0].valid, true);
  assert.ok(Math.abs(sharedDefault.players[0].controls.gain - 0.5) < 0.00001, "Basic should map raw recorded values over the whole useful range");
  await sharedDefault.element("create").event("click");
  assert.equal(sharedDefault.createCount, 1, "the no-track action opens the creation workflow");
  assert.equal(sharedDefault.requests.length, 0);

  const lateChannel = harness(async () => { throw new Error("Preparing input must not spend credits"); }, {
    fields: [{ key: "late-channel", name: "Late channel" }], sourceBounds: { minimum: -8, maximum: 12 } });
  lateChannel.sourceValue = null;
  await lateChannel.advance(50);
  assert.equal(lateChannel.saved.mappings[0].sources[0].inputMin, -8, "recorded bounds remain available before a later channel's first sample");
  assert.equal(lateChannel.saved.mappings[0].sources[0].inputMax, 12);

  const delayedSource = harness(async () => { throw new Error("Source discovery must not spend credits"); }, { fields: [] });
  const reloadedBeforeDiscovery = harness(async () => { throw new Error("Reload must not spend credits"); }, {
    settings: delayedSource.saved, fields: [{ key: "on-reload", name: "Reloaded field", minimum: -2, maximum: 2 }] });
  assert.match(reloadedBeforeDiscovery.element("mappings").innerHTML, /value="on-reload" selected/, "unresolved default sources must still be discovered after a reload");
  delayedSource.sourceFields = [{ key: "late", name: "Late field", reducers: ["value"], inputMin: -1, inputMax: 1 }];
  await delayedSource.advance(300);
  await delayedSource.element("play").event("click"); await delayedSource.advance(500);
  assert.equal(delayedSource.players[0].valid, true, "sources loaded after initialization should fill new mappings");
  assert.match(delayedSource.element("mappings").innerHTML, /value="late" selected/);

  const combined = harness(async () => { throw new Error("Local mappings must not use credits"); }, {
    sourceMode: "live", fields: [{ key: "a", name: "A" }, { key: "b", name: "B" }], sourceValues: { a: 20, b: 200 },
    settings: { mode: "shared", mappings: [{ audioSource: "bass", target: "cutoff", outputMin: 200, outputMax: 20000, smoothing: 0,
      operator: "average", sources: [{ sourceKey: "a", rangeMode: "auto" }, { sourceKey: "b", rangeMode: "auto" }] }] }
  });
  await combined.element("play").event("click"); await combined.advance(50);
  assert.equal(combined.players[0].controls.stemControls.bass.cutoff, 2000);
  assert.equal(combined.players[0].controls.cutoff, 20000);
  combined.sourceValues = { a: 40, b: 400 }; await combined.advance(50);
  assert.equal(combined.players[0].controls.stemControls.bass.cutoff, 20000);
  combined.sourceValues = { a: 30, b: 300 }; await combined.advance(50);
  assert.equal(combined.players[0].controls.stemControls.bass.cutoff, 2000);
  combined.sourceValues = { a: 30, b: null }; await combined.advance(50);
  assert.equal(combined.players[0].valid, false, "missing one combined input must close the audio gate");
  combined.sourceValues = { a: 30, b: { value: 300, at: -10000 } }; await combined.advance(50);
  assert.equal(combined.players[0].valid, false, "stale combined input must close the audio gate");
  combined.sourceValues = { a: 30, b: 300 }; await combined.advance(50);
  assert.equal(combined.players[0].valid, true);
  assert.match(combined.element("mappings").innerHTML, /Audio source/);
  assert.match(combined.element("mappings").innerHTML, /Combine input/);
  assert.match(combined.element("mappings").innerHTML, /Adjust input range/);
  await combined.element("learn-all").event("click"); await combined.advance(50);
  assert.equal(combined.players[0].controls.stemControls.bass.cutoff, 2000, "relearn resets both sources to their neutral constant value");

  await combined.mappingAction("freeze", 0, 0);
  assert.equal(combined.saved.mappings[0].sources[0].rangeMode, "fixed");
  assert.ok(combined.saved.mappings[0].sources[0].inputMax > combined.saved.mappings[0].sources[0].inputMin, "freezing a constant value adds a small centered range");
  assert.equal(combined.saved.mappings[0].sources[1].rangeMode, "auto", "freezing one input must not change its combined partner");
  await combined.mappingAction("relearn", 0, 0);
  assert.equal(combined.saved.mappings[0].sources[0].rangeMode, "auto");
  await combined.mappingAction("add-input");
  assert.equal(combined.saved.mappings[0].sources.length, 3);
  await combined.mappingAction("remove-input", 0, 2);
  assert.equal(combined.saved.mappings[0].sources.length, 2);

  const muteMix = harness(async () => ({ id: "next-mix", plan_id: "plan", state: "complete", audio_url: "/next.mp3",
    stem_separation: { state: "complete", stems: [{ name: "bass", audio_url: "/next-bass.mp3" }, { name: "drums", audio_url: "/next-drums.mp3" }] } }), {
    settings: { mode: "shared", stemMix: { bass: 0.6 }, mappings: [
      { sourceKey: "activity", audioSource: "bass", target: "gain", outputMin: 0.7, outputMax: 0.7, smoothing: 0 },
      { sourceKey: "activity", audioSource: "bass", target: "delayMix", outputMin: 0.5, outputMax: 0.5, smoothing: 0 },
      { sourceKey: "activity", audioSource: "bass", target: "reverbMix", outputMin: 0.4, outputMax: 0.4, smoothing: 0 }
    ] }
  });
  assert.match(muteMix.html, /<section class="el-rt-stem-mixer" aria-labelledby=/, "stem mixer must remain visible in Basic");
  assert.match(muteMix.element("stems").innerHTML, /data-stem-mute="bass" aria-pressed="false"/);
  await muteMix.toggleStem("bass");
  assert.deepEqual(muteMix.saved.mutedStems, ["bass"], "mute can be set before playback");
  await muteMix.element("play").event("click"); await muteMix.advance(50);
  assert.equal(muteMix.players[0].initialControls.stemGains.bass, 0, "mute must be seeded before the initial audio deck is constructed");
  assert.equal(muteMix.players[0].initialValid, false, "source gate must stay closed while the muted deck starts");
  assert.equal(muteMix.players[0].controls.stemGains.bass, 0, "mute overrides an active stem volume mapping");
  assert.equal(muteMix.players[0].controls.stemControls.bass.gain, 0.7);
  assert.equal(muteMix.players[0].controls.stemControls.bass.delayMix, 0.5, "effect mappings continue while the post-effects stem gain is muted");
  assert.equal(muteMix.players[0].controls.stemControls.bass.reverbMix, 0.4);
  await muteMix.volumeStem("bass", 0.35); await muteMix.advance(500);
  assert.equal(muteMix.players[0].controls.stemGains.bass, 0, "editing volume while muted must not unmute");
  await muteMix.toggleStem("bass");
  assert.equal(muteMix.players[0].controls.stemGains.bass, 0.35, "unmute immediately restores manual volume alongside mapped gain");
  assert.equal(muteMix.players[0].controls.stemControls.bass.gain, 0.7);
  await muteMix.toggleStem("bass");
  muteMix.element("auto").checked = true; await muteMix.element("auto").event("change");
  await muteMix.advance(2000);
  assert.equal(muteMix.players[0].queuedTrack.id, "next-mix");
  assert.equal(muteMix.players[0].controls.stemGains.bass, 0, "queued decks receive the mute before their crossfade starts");
  muteMix.players[0].transition(); await muteMix.advance(300);
  assert.equal(muteMix.players[0].controls.stemGains.bass, 0, "automatic track promotion must not clear a mute");
  assert.equal(muteMix.players[0].controls.stemGains.drums, 1, "new unmuted stems keep their normal volume");
  assert.match(muteMix.element("stems").innerHTML, /data-stem-mute="bass" aria-pressed="true"/);
  assert.equal(muteMix.saved.stemMix.bass, 0.35);
  await muteMix.element("stop").event("click");
  await muteMix.element("play").event("click"); await muteMix.advance(50);
  assert.equal(muteMix.players[1].controls.stemGains.bass, 0, "Stop and Play preserve the user's mix");
  await muteMix.toggleStem("bass"); await muteMix.advance(50);
  assert.equal(muteMix.players[1].controls.stemGains.bass, 0.35);
  await muteMix.toggleStem("unavailable");
  assert.deepEqual(muteMix.saved.mutedStems, [], "unavailable stem names cannot create invisible mute controls");
  await muteMix.element("stop").event("click"); await muteMix.toggleStem("bass");
  const restoredMix = harness(async () => { throw new Error("Restoring a stem mix must not spend credits"); }, { settings: muteMix.saved });
  assert.match(restoredMix.element("stems").innerHTML, /data-stem-mute="bass" aria-pressed="true"/);
  await restoredMix.element("play").event("click"); await restoredMix.advance(50);
  assert.equal(restoredMix.players[0].controls.stemGains.bass, 0, "reloading restores deliberate mute settings");
  await restoredMix.toggleStem("bass");
  assert.equal(restoredMix.players[0].controls.stemGains.bass, 0.35);
  const fullMix = harness(async () => { throw new Error("Unresolved separation must not be resubmitted"); }, {
    settings: { mode: "shared", mutedStems: ["bass"], stemMix: { bass: 0.2 }, mappings: [{ sourceKey: "activity", target: "gain", outputMin: 0.6, outputMax: 0.6 }] },
    starter: { id: "full-mix", plan_id: "plan", state: "complete", audio_url: "/full.mp3", stem_separation: { state: "unknown", error: "unresolved" } }
  });
  await fullMix.element("play").event("click"); await fullMix.advance(50);
  assert.equal(fullMix.players[0].controls.gain, 0.6, "an absent muted stem must not mute the master full mix");
  assert.equal(fullMix.players[0].valid, true);
  assert.equal(fullMix.element("stems").innerHTML, "");
  const previousMix = harness(async () => { throw new Error("Manual stem mix must stay local"); }, { settings: { mode: "shared", stemMix: { bass: 0.45 } } });
  await previousMix.element("play").event("click"); await previousMix.advance(50);
  assert.equal(previousMix.players[0].controls.stemGains.bass, 0.45, "manual stem volume works without any mute settings");

  const handoff = harness(async () => { throw new Error("Track selection must never submit generation"); });
  const originalTrack = { id: "original-track", plan_id: "original-plan", state: "complete", audio_url: "/original.mp3" };
  handoff.app.setSelection({ plan: { id: "original-plan" }, currentJob: null, analysis: null });
  assert.equal(handoff.element("track").value, "starter", "building a new plan keeps the current starter until its job exists");
  handoff.app.setSelection({ plan: { id: "original-plan" }, currentJob: originalTrack, jobs: [originalTrack], analysis: null });
  assert.equal(handoff.element("track").value, "original-track", "a newly generated original becomes the starter after a null-job handoff");
  handoff.element("track").value = "starter"; await handoff.element("track").event("change");
  handoff.app.setSelection({ plan: { id: "original-plan" }, currentJob: originalTrack, jobs: [originalTrack], analysis: null });
  assert.equal(handoff.element("track").value, "starter", "refreshing the same original must preserve a deliberate starter selection");
  assert.equal(handoff.requests.length, 0);

  const customTrack = { id: "custom", plan_id: "uploaded-plan", origin: "uploaded", state: "complete", audio_url: "/custom.wav",
    stems: [{ name: "vocals", audio_url: "/custom-vocals.wav" }] };
  const custom = harness(async () => { throw new Error("Prepared custom audio playback never submits work"); }, {
    starter: customTrack, settings: { mode: "demo" } });
  assert.equal(custom.element("auto").disabled, true, "custom audio cannot arm provider continuations");
  assert.match(custom.element("budget-note").textContent, /Generate new in Music mixer/);
  await custom.element("play").event("click"); await custom.advance(2000);
  assert.equal(custom.players[0].playing, true, "the origin guard leaves saved audio and stems playable");
  assert.deepEqual(Array.from(custom.players[0].stemNames), ["vocals"]);
  custom.element("auto").checked = true; await custom.element("auto").event("change"); await custom.advance(50);
  assert.equal(custom.element("auto").checked, false, "an injected change event cannot bypass the origin guard");
  assert.equal(custom.requests.length, 0);
  await custom.element("stop").event("click");
  custom.app.setSelection({ plan: { id: "original-plan" }, currentJob: originalTrack, jobs: [originalTrack], analysis: null });
  assert.equal(custom.element("auto").disabled, false, "selecting generated music restores the continuation option");

  const selectedCustom = harness(async () => { throw new Error("Selecting custom audio must not submit work"); });
  selectedCustom.element("auto").checked = true; await selectedCustom.element("auto").event("change");
  selectedCustom.app.setSelection({ plan: { id: "uploaded-plan", origin: "uploaded" }, currentJob: customTrack, jobs: [customTrack], analysis: null });
  assert.equal(selectedCustom.element("auto").checked, false, "changing a previously armed starter to custom audio disarms it");
  assert.equal(selectedCustom.element("auto").disabled, true);

  const customSeparation = harness(async (request) => request.options.method === "GET"
    ? { state: "not_requested", stems: [] } : { state: "complete", stems: customTrack.stems }, {
    starter: { ...customTrack, stems: undefined }, settings: { mode: "demo" } });
  await customSeparation.advance(2000);
  assert.equal(customSeparation.requests.length, 0, "opening uploaded audio never prepares stems without an action");
  await customSeparation.element("separate").event("click");
  assert.equal(customSeparation.requests.filter(request => request.options.method === "POST").length, 1);
  assert.equal(customSeparation.requests.at(-1).url, "/api/elevenlabs/generations/custom/stems", "explicit separation still works for uploaded audio");
  await customSeparation.element("play").event("click"); await customSeparation.advance(2000);
  assert.equal(customSeparation.players[0].playing, true);
  assert.equal(customSeparation.requests.length, 2, "playing the prepared upload reuses saved stems");

  const generationSelection = harness(async () => ({ id: "selected-next", state: "complete", audio_url: "/next.mp3", stem_separation: { state: "complete", stems: [{ name: "bass", audio_url: "/bass.mp3" }] } }), {
    sourceValues: { a: 0.2, b: 0.8 }, fields: [{ key: "a", name: "A" }, { key: "b", name: "B" }],
    settings: { mode: "shared", generationInput: 0, mappings: [
      { audioSource: "master", target: "gain", sources: [{ sourceKey: "a", rangeMode: "fixed", inputMin: 0, inputMax: 1 }] },
      { audioSource: "bass", target: "cutoff", sources: [{ sourceKey: "b", rangeMode: "fixed", inputMin: 0, inputMax: 1 }] }
    ] }
  });
  await generationSelection.element("play").event("click");
  generationSelection.element("auto").checked = true; await generationSelection.element("auto").event("change");
  await generationSelection.advance(2000);
  assert.equal(generationSelection.requests[0].body.features.activity, 0.2, "selected generation input must be independent from other audio mappings");
  await generationSelection.mappingAction("remove", 0);
  assert.equal(generationSelection.saved.generationInput, "all", "removing the selected mapping returns upcoming music to the explicit default");

  let validGenerationSettings = false;
  const invalidGeneration = harness(async () => ({ id: "valid-settings", state: "complete", audio_url: "/next.mp3", stem_separation: { state: "complete", stems: [{ name: "bass", audio_url: "/bass.mp3" }] } }), {
    settings: { mode: "demo", budget: 1 }, getGenerationSettings() { if (!validGenerationSettings) throw new Error("BPM is invalid"); return { bpm: 90 }; }
  });
  await invalidGeneration.element("play").event("click");
  invalidGeneration.element("auto").checked = true; await invalidGeneration.element("auto").event("change");
  await invalidGeneration.advance(2000);
  assert.equal(invalidGeneration.requests.length, 0);
  assert.match(invalidGeneration.element("budget-note").textContent, /^0 \/ 1/);
  assert.equal(invalidGeneration.element("auto").checked, false);
  validGenerationSettings = true;
  invalidGeneration.element("auto").checked = true; await invalidGeneration.element("auto").event("change"); await invalidGeneration.advance(50);
  assert.equal(invalidGeneration.requests.length, 1, "correcting invalid next settings must leave the paid request budget available");
  assert.equal(invalidGeneration.requests[0].body.sequence, 0);

  const savedStems = [{ name: "drums", audio_url: "/drums.mp3" }];
  const app = harness(async (request) => ({ id: `segment-${request.body.sequence}`, plan_id: "next-plan", state: "complete", audio_url: "/next.mp3", generation_latency_seconds: 2, stem_separation: { state: "complete", stems: savedStems } }), { getGenerationSettings: () => ({ style: "minimal", bpm: 90 }) });
  app.element("source").value = "demo";
  await app.element("source").event("change");
  await app.element("play").event("click");
  await app.advance(2000);
  assert.equal(app.pauseCount, 1, "native audio should pause when reactive playback starts");
  assert.equal(app.requests.length, 0, "Playback with saved stems and local modulation must not trigger paid calls");
  assert.equal(app.players[0].valid, true);
  assert.ok(app.players[0].controls.cutoff >= 80);
  app.element("auto").checked = true;
  await app.element("auto").event("change");
  await app.advance(50);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].url, "/api/elevenlabs/continuations");
  assert.equal(app.requests[0].body.source_job_id, "starter");
  assert.equal(app.requests[0].body.settings.style, "minimal", "upcoming music reads the current shared generation settings");
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
  restored.app.deactivate(); restored.sourceFields = [{ key: "new-shared", name: "New shared input" }]; restored.app.activate();
  assert.equal(restored.element("source").value, "demo", "reopening must preserve an intentional instrument source override");
  assert.equal(restored.element("shared").hidden, false, "saved overrides have an explicit route back to the Connections input");
  assert.equal(restored.element("duration").value, "40");
  assert.equal(restored.element("budget").value, "7");
  assert.equal(restored.element("address").value, "wss://example.test/live");
  assert.equal(restored.element("auto").checked, false);
  assert.equal(restored.elements.has("auto-stems"), false, "stem preparation should no longer require an optional checkbox");
  assert.equal(restored.element("audio-download").href, "/saved-with-stems.mp3");
  assert.equal(restored.element("export").href, "/api/elevenlabs/generations/saved-stems/export");
  assert.match(restored.element("track-context").textContent, /generated independently/);
  assert.match(restored.element("mappings").innerHTML, /value="drums" selected/);
  assert.doesNotMatch(restored.element("mappings").innerHTML, /drums · unavailable/, "saved stems from the jobs list must populate mappings even when not the offline currentJob");
  await restored.element("play").event("click"); await restored.advance(2000);
  assert.equal(restored.players[0].currentTrack.stems[0].name, "drums");
  assert.equal(restored.requests.length, 0);
  restored.element("budget").value = "9"; await restored.element("budget").event("change");
  assert.equal(restored.saved.budget, 9);
  assert.equal(restored.saved.mappings[0].target, "gain");
  assert.equal("id" in restored.saved.mappings[0], false, "transient row state should not be persisted");
  assert.equal("armed" in restored.saved, false);
  assert.equal("autoStems" in restored.saved, false);
  await restored.element("stop").event("click");
  restored.element("track").value = "starter"; await restored.element("track").event("change");
  assert.match(restored.element("mappings").innerHTML, /drums · unavailable/, "a stopped old player's stems must not mask the selected full-mix track");
  restored.element("auto").checked = true; await restored.element("auto").event("change");
  await restored.element("disconnect").event("click");
  assert.equal(restored.element("auto").checked, false, "explicit source disconnection must disarm future spending");
  await restored.element("shared").event("click");
  assert.equal(restored.element("source").value, "shared");
  assert.equal(restored.saved.mappings[0].sources[0].sourceKey, "new-shared");

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
  assert.match(legacy.element("mappings").innerHTML, /value="drums"/, "ready stems should populate mapping options before their boundary transition");
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
