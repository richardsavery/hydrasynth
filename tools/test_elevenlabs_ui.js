"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/elevenlabs.js"), "utf8"), context);
const { sectionAt, canGenerate, matchesPlan, hasPendingWork, musicLabel } = context.HydraElevenLabs;

const namedTrack = { id: "generation-12345678", requested_duration_seconds: 40,
  generation_settings: { style: "  Quiet  cello & piano ", bpm: 85, key: "A minor" } };
assert.equal(musicLabel(namedTrack), "Quiet cello & piano · 85 BPM · A minor · 40s · 12345678");
assert.equal(musicLabel({ id: "original", duration_seconds: 20, settings: { style: "Slow strings", bpm: 60, key: "C major" } }),
  "Slow strings · 60 BPM · C major · 20s · original");
assert.equal(musicLabel({ ...namedTrack, generation_settings: undefined }, { settings: namedTrack.generation_settings }), musicLabel(namedTrack),
  "original jobs inherit descriptive names from their saved plan");
assert.notEqual(musicLabel(namedTrack), musicLabel({ ...namedTrack, id: "generation-87654321" }), "same-direction versions remain distinct");
assert.match(musicLabel({ ...namedTrack, realtime: { generation_settings: { style: "Bright brass", bpm: 120, key: "F major" } } }), /^Bright brass · 120 BPM · F major/);

// Seeking follows the requested audio timeline, independently of cropped source times.
const sections = [
  { source_start: 20, source_end: 30, audio_start: 0, audio_end: 10 },
  { source_start: 30, source_end: 40, audio_start: 10, audio_end: 20 },
  { source_start: 40, source_end: 51.5, audio_start: 20, audio_end: 31.5 },
];
assert.equal(sectionAt(sections, 0), 0);
assert.equal(sectionAt(sections, 9.999), 0);
assert.equal(sectionAt(sections, 10), 1);
assert.equal(sectionAt(sections, 20), 2);
assert.equal(sectionAt(sections, 31.5), 2);
assert.equal(sectionAt(sections, 31.501), -1, "off-duration audio must not pretend to map to a source section");
assert.equal(sectionAt(sections, -1), -1);
assert.equal(sectionAt([], 0), -1);

// Equivalent saved plans share cached audio even when revision IDs differ.
const plan = { id: "revision-2", cache_key: "same-request-and-data", can_generate: true };
const cached = { id: "saved", plan_id: "revision-1", cache_key: "same-request-and-data", state: "complete" };
assert.equal(matchesPlan(cached, plan), true);
assert.equal(matchesPlan({ ...cached, cache_key: "different-request" }, plan), false);
assert.equal(matchesPlan({ plan_id: "revision-2" }, plan), true);
assert.equal(matchesPlan({ plan_id: "unrelated" }, { id: "revision-2" }), false);
assert.equal(matchesPlan(cached, null), false);
const ready = { plan, status: { ready: true }, jobs: [], dirty: false, requestDirty: false, busy: false };
assert.equal(canGenerate(ready), true);
for (const key of ["dirty", "requestDirty", "busy"]) {
  assert.equal(canGenerate({ ...ready, [key]: true }), false, `${key} must prevent submitting stale or concurrent requests`);
}
assert.equal(canGenerate({ ...ready, plan: { ...plan, can_generate: false } }), false);
assert.equal(canGenerate({ ...ready, plan: null }), false);
assert.equal(canGenerate({ ...ready, status: { ready: false } }), false);
assert.equal(canGenerate({ ...ready, status: { ready: false }, jobs: [cached] }), true, "saved audio needs no provider configuration");
assert.equal(canGenerate({ ...ready, jobs: [{ ...cached, cache_key: "unrelated", state: "generating" }] }), false, "only one generation can run at a time");
assert.equal(canGenerate({ ...ready, jobs: [{ ...cached, state: "generating" }] }), true, "an in-flight identical job can be viewed without resubmitting");
assert.equal(canGenerate({ ...ready, jobs: [{ ...cached, state: "unknown" }], status: { ready: false } }), true, "unknown outcomes remain inspectable, without an automatic retry");
for (const stemState of ["queued", "generating"]) {
  const separating = { ...cached, stem_separation: { state: stemState } };
  assert.equal(hasPendingWork(separating), true, "polling must continue after audio completes until default stems finish");
  assert.equal(canGenerate({ ...ready, jobs: [separating] }), true, "saved full-mix audio remains available during separation");
  assert.equal(canGenerate({ ...ready, jobs: [{ ...separating, plan_id: "other", cache_key: "other" }] }), false,
    "a different music request cannot overlap the default stem request");
}
for (const stemState of ["complete", "failed", "unknown"]) {
  assert.equal(hasPendingWork({ ...cached, stem_separation: { state: stemState } }), false, "terminal stem outcomes must not poll forever");
}
console.log("ElevenLabs UI: timeline, cache revisions, and generation guards passed.");

// Next-segment directions are read at dispatch, independently of a stale initial
// plan. Editing them persists a draft and never starts a paid request.
const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, {
    value: "", checked: false, hidden: false, open: false,
    listeners: {}, classList: { add() {}, toggle() {} },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    pause() {}, focus() {}, scrollIntoView() {},
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 600 }; }, getContext() { return null; },
  });
  return elements.get(id);
};
const workspace = { hidden: false, classList: { add() {}, toggle() {} },
  querySelector: (selector) => element(selector.slice(4)), querySelectorAll: () => [] };
let realtimeOptions, stopped = 0, paidRequests = 0;
const storage = new Map();
const browserContext = vm.createContext({
  document: { getElementById: () => workspace },
  localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  HydraElevenRealtime: { init: (options) => { realtimeOptions = options; }, setSelection() {}, deactivate: () => stopped++ },
  fetch: () => { paidRequests++; throw new Error("Unexpected request from a local UI edit"); },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/elevenlabs.js"), "utf8"), browserContext);
browserContext.HydraElevenLabs.init();
for (const [id, value] of Object.entries({ style: "ambient strings", bpm: "85", key: "A minor", palette: "cello, soft percussion", context: "high", seed: "", length: "20" })) element(id).value = value;
element("generation-direction").listeners.input();
assert.equal(paidRequests, 0);
const savedDirections = JSON.parse(storage.get("hydra.elevenlabs.workspace.v1")).generationSettings;
assert.equal(savedDirections.style, "ambient strings");
assert.equal(savedDirections.seed, null, "clearing the seed must override an anchor plan's old seed");
assert.equal(realtimeOptions.getGenerationSettings().bpm, 85);
element("bpm").value = "120";
assert.equal(realtimeOptions.getGenerationSettings().bpm, 120, "the next segment uses the current direction, not the plan's saved direction");
assert.equal(realtimeOptions.generationSettingsContainer, element("next-settings"));
for (const [id, value, error] of [
  ["bpm", "", /BPM/], ["bpm", "301", /BPM/],
  ["style", " ", /Describe/], ["key", "", /requested key/],
  ["palette", Array(21).fill("cello").join(","), /20 comma-separated/],
  ["seed", "1.5", /whole number/], ["context", "unknown", /continuity/],
]) {
  const original = element(id).value;
  element(id).value = value;
  assert.throws(() => realtimeOptions.getGenerationSettings(), error, "invalid directions fail before any generation request");
  element(id).value = original;
}
browserContext.HydraElevenLabs.showView("create");
assert.equal(element("create").open, true);
assert.equal(element("realtime").hidden, false);
assert.equal(stopped, 0, "opening samepage creation must keep reactive playback running");
assert.equal(paidRequests, 0);
console.log("ElevenLabs UI: samepage creation, saved directions, and pre-request validation passed.");

const defaults = { style: "instrumental electronic music", bpm: 100, key: "D minor",
  instrument_palette: ["warm synthesizer tones", "soft electronic percussion"], enable_variability: false,
  context_adherence: "high", seed: null };
const clone = (value) => JSON.parse(JSON.stringify(value));
const original = (id, settings = defaults) => ({ id, origin: "original", analysis_id: null, dataset_id: null,
  dataset_name: "Original music", duration_seconds: 20, settings, can_generate: true, cache_key: "original-key",
  sections: [{ audio_start: 0, audio_end: 20 }], created_at: "2026-10-11T00:00:00Z" });
const savedJob = (plan) => ({ id: "saved-music", plan_id: plan.id, cache_key: plan.cache_key,
  state: "complete", audio_url: "/saved.mp3", audio: { duration_seconds: 20 }, stem_separation: { state: "complete" } });

// Exercise the real initialization, click, restore and fetch paths. These fake
// server responses cannot reach ElevenLabs or spend credits.
function creationHarness({ initialPlan, initialJob, unlistedPlan, unlistedJob, stored = {}, missingAnalysis = false, ready: serviceReady = true } = {}) {
  const nodes = new Map(), requests = [], plans = initialPlan ? [clone(initialPlan)] : [], jobs = initialJob ? [clone(initialJob)] : [];
  let selection, planGate, rejectGeneration = false;
  const storage = new Map([["hydra.elevenlabs.workspace.v1", JSON.stringify(stored)]]);
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", checked: false, disabled: false, hidden: false,
      open: false, paused: true, currentTime: 0, listeners: {}, attributes: {}, classList: { add() {}, toggle() {} },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      querySelectorAll() { return []; }, setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return name === "src" ? this.src : this.attributes[name] || null; },
      removeAttribute(name) { delete this.attributes[name]; if (name === "src") delete this.src; },
      pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); }, focus() {}, scrollIntoView() {},
    });
    return nodes.get(id);
  };
  const workspace = { hidden: false, classList: { add() {}, toggle() {} }, querySelectorAll: () => [],
    querySelector: (selector) => node(selector.slice(4)) };
  const fetch = async (url, options) => {
    const method = options?.method || "GET", body = options?.body ? JSON.parse(options.body) : undefined;
    const route = url.replace("/api/elevenlabs", "");
    requests.push({ method, route, body });
    let result;
    if (method === "GET" && route === "/status") result = { ready: serviceReady };
    else if (method === "GET" && route === "/plans") result = { plans: clone(plans) };
    else if (method === "GET" && route === "/generations") result = { jobs: clone(jobs) };
    else if (method === "GET" && (route.startsWith("/plans/") || route.startsWith("/generations/"))) {
      const records = route.startsWith("/plans/") ? [...plans, unlistedPlan] : [...jobs, unlistedJob];
      result = records.find((record) => record?.id === route.split("/").at(-1));
      if (!result) return { ok: false, status: 404, json: async () => ({ error: "Saved music not found" }) };
    }
    else if (method === "GET" && route.startsWith("/analyses/")) {
      if (missingAnalysis) return { ok: false, status: 404, json: async () => ({ error: "Missing old analysis" }) };
      result = { id: route.slice(10), timeline: { times: [0, 1], signal: [0, 1], channels: {} } };
    } else if (method === "POST" && route === "/plans") {
      if (planGate) await planGate;
      result = { ...original(`new-original-${plans.length + 1}`, body.settings), duration_seconds: body.duration_seconds };
      plans.unshift(result);
    } else if (method === "POST" && route === "/generations") {
      result = { ...savedJob(plans.find((plan) => plan.id === body.plan_id)), id: `new-audio-${jobs.length + 1}` };
      if (rejectGeneration) {
        jobs.unshift({ ...result, state: "unknown" });
        return { ok: false, status: 502, json: async () => ({ error: "Connection lost" }) };
      }
      jobs.unshift(result);
    } else throw new Error(`Unexpected request: ${method} ${route}`);
    return { ok: true, status: 200, json: async () => clone(result) };
  };
  const context = vm.createContext({
    document: { getElementById: () => workspace }, fetch,
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    setTimeout: () => 1, clearTimeout() {}, cancelAnimationFrame() {}, requestAnimationFrame: () => 1,
    HydraElevenRealtime: { init() {}, setSelection: (value) => { selection = value; }, activate() {}, deactivate() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/elevenlabs.js"), "utf8"), context);
  context.HydraElevenLabs.init();
  for (const [id, value] of Object.entries({ style: defaults.style, bpm: "100", key: "D minor", palette: defaults.instrument_palette.join(", "), context: "high", seed: "", length: "20" })) node(id).value = value;
  return { ui: context.HydraElevenLabs, context, node, workspace, requests, plans, jobs, storage,
    get selection() { return selection; },
    delayPlan() { let release; planGate = new Promise((resolve) => { release = resolve; }); return release; },
    loseGenerationResponse() { rejectGeneration = true; },
    click(id) { return node(id).listeners.click(); },
    edit(id, value) { node(id).value = value; node(id === "length" ? "length" : "generation-direction").listeners[id === "length" ? "change" : "input"](); },
  };
}

async function originalCreationTests() {
  for (const stored of [null, false, 3, "old settings", []]) {
    const h = creationHarness({ stored });
    await h.ui.activate();
    assert.equal(h.requests.some(request => request.method === "POST"), false,
      "invalid stored settings cannot prevent startup or submit generation requests");
    assert.equal(h.node("generate").disabled, false);
  }
  {
    const saved = { planId: "not-opened", jobId: "saved-track", generationSettings: { ...defaults, style: "Remember this direction" }, durationSeconds: 60 };
    const unopened = creationHarness({ stored: saved });
    unopened.ui.flush({ strict: true });
    assert.deepEqual(JSON.parse(unopened.storage.get("hydra.elevenlabs.workspace.v1")), saved,
      "session capture preserves remembered music before the legacy workspace has loaded");
    const h = creationHarness(); await h.ui.activate();
    const previous = h.storage.get("hydra.elevenlabs.workspace.v1"), quota = new Error("Browser storage is full");
    h.context.localStorage.setItem = () => { throw quota; };
    assert.doesNotThrow(() => h.edit("style", "The current direction"), "ordinary editing remains available when autosave fails");
    assert.equal(h.storage.get("hydra.elevenlabs.workspace.v1"), previous);
    assert.throws(() => h.ui.flush({ strict: true }), error => error === quota,
      "session capture cannot save a stale music direction");
    h.context.localStorage.setItem = (key, value) => h.storage.set(key, value);
    h.ui.flush({ strict: true });
    assert.equal(JSON.parse(h.storage.get("hydra.elevenlabs.workspace.v1")).generationSettings.style, "The current direction");
  }
  const h = creationHarness();
  await h.ui.activate();
  assert.equal(h.requests.some((request) => request.method === "POST"), false, "opening the page must never generate");
  assert.doesNotMatch(h.workspace.innerHTML, /Import CSV|JSONL|Request JSON|Preview track plan|el-synthetic|el-file/,
    "creation must have no recording or JSON workflow in either view");
  h.edit("style", "quiet cello and piano"); h.edit("length", "40");
  assert.equal(h.requests.some((request) => request.method === "POST"), false, "direction and length edits are free");
  const release = h.delayPlan();
  const firstClick = h.click("generate");
  assert.equal(h.node("generate").disabled, true, "the first click locks creation before awaiting the local plan");
  await h.click("generate");
  assert.equal(h.requests.filter((request) => request.method === "POST").length, 1, "double clicks share a single in-flight action");
  release(); await firstClick;
  const submissions = h.requests.filter((request) => request.method === "POST");
  assert.deepEqual(submissions.map((request) => request.route), ["/plans", "/generations"]);
  assert.deepEqual(submissions[0].body, { kind: "original", duration_seconds: 40,
    settings: { ...defaults, style: "quiet cello and piano" } });
  assert.deepEqual(submissions[1].body, { plan_id: h.plans[0].id, variation: false });
  assert.equal(h.selection.analysis, null);
  assert.equal(h.selection.currentJob.state, "complete");
  assert.equal(h.requests.some((request) => /datasets|analyses/.test(request.route)), false, "original creation never needs input files or analyses");
  await h.click("generate");
  assert.equal(h.requests.filter((request) => request.method === "POST").length, 2, "clicking saved music must not submit again");
  assert.match(h.node("notice").textContent, /No new generation request/);

  const cachedPlan = original("cached-original"), cachedJob = savedJob(cachedPlan);
  const equivalent = creationHarness({ initialPlan: cachedPlan, initialJob: cachedJob });
  await equivalent.ui.activate();
  equivalent.edit("style", "another direction"); equivalent.edit("style", defaults.style);
  await equivalent.click("generate");
  assert.equal(equivalent.requests.filter((request) => request.method === "POST" && request.route === "/plans").length, 1);
  assert.equal(equivalent.requests.some((request) => request.method === "POST" && request.route === "/generations"), false,
    "equivalent settings may save a new local plan but reuse the previous audio by cache key");
  assert.notEqual(equivalent.selection.plan.id, equivalent.selection.currentJob.plan_id);
  assert.equal(equivalent.selection.currentJob.id, cachedJob.id);
  await equivalent.click("variation");
  assert.deepEqual(equivalent.requests.filter((request) => request.method === "POST" && request.route === "/generations").map((request) => request.body),
    [{ plan_id: equivalent.selection.plan.id, variation: true }], "another version is a separate explicit paid action");
  for (const withDirections of [false, true]) {
    const restored = creationHarness({ initialPlan: cachedPlan, initialJob: cachedJob,
      stored: { planId: cachedPlan.id, jobId: cachedJob.id, ...(withDirections ? { generationSettings: { ...defaults, style: "saved draft" }, durationSeconds: 60 } : {}) } });
    await restored.ui.activate();
    assert.equal(restored.node("audio").src, cachedJob.audio_url);
    assert.equal(restored.requests.some((request) => /analyses|datasets|\/null/.test(request.route)), false);
    assert.equal(restored.requests.some((request) => request.method === "POST"), false, "restoring music or unsent directions cannot generate");
    if (withDirections) {
      assert.equal(restored.node("style").value, "saved draft");
      assert.equal(restored.node("length").value, "60");
      assert.match(restored.node("generate").textContent, /Generate original/);
    } else assert.match(restored.node("generate").textContent, /Use saved music/);
    assert.match(restored.node("saved-plan").innerHTML, /instrumental electronic music · 100 BPM · D minor · 20s/);
    assert.match(restored.node("attempts").innerHTML, /instrumental electronic music · 100 BPM · D minor · 20s/);
  }

  const missingPlan = creationHarness({ initialPlan: cachedPlan, initialJob: cachedJob,
    stored: { planId: "missing-plan", jobId: "missing-track", generationSettings: { ...defaults, style: "Unsent draft" } } });
  await missingPlan.ui.activate();
  assert.equal(missingPlan.selection.plan, null, "a missing saved plan cannot silently select the latest plan");
  assert.equal(missingPlan.node("audio").src, undefined);
  assert.match(missingPlan.node("notice").textContent, /Saved music missing-plan is unavailable/);
  assert.equal(missingPlan.node("saved-plan").value, "missing-plan");
  assert.match(missingPlan.node("saved-plan").innerHTML, /Saved music unavailable/);
  missingPlan.edit("style", "Updated draft");
  assert.equal(JSON.parse(missingPlan.storage.get("hydra.elevenlabs.workspace.v1")).planId, "missing-plan");
  assert.equal(JSON.parse(missingPlan.storage.get("hydra.elevenlabs.workspace.v1")).jobId, "missing-track");

  const missingAttempt = creationHarness({ initialPlan: cachedPlan, initialJob: cachedJob,
    stored: { planId: cachedPlan.id, jobId: "missing-attempt", generationSettings: defaults } });
  await missingAttempt.ui.activate();
  assert.equal(missingAttempt.selection.currentJob, null, "a missing saved attempt cannot silently select another version");
  assert.equal(missingAttempt.node("audio").src, undefined);
  assert.match(missingAttempt.node("notice").textContent, /Saved track missing-attempt is unavailable/);
  assert.equal(JSON.parse(missingAttempt.storage.get("hydra.elevenlabs.workspace.v1")).jobId, "missing-attempt");

  const oldPlan = original("outside-recent-plans"), oldJob = { ...savedJob(oldPlan), id: "outside-recent-jobs" };
  const older = creationHarness({ initialPlan: cachedPlan, initialJob: cachedJob, unlistedPlan: oldPlan, unlistedJob: oldJob,
    stored: { planId: oldPlan.id, jobId: oldJob.id } });
  await older.ui.activate();
  assert.equal(older.selection.plan.id, oldPlan.id);
  assert.equal(older.selection.currentJob.id, oldJob.id, "a saved reference outside recent-list limits still restores directly");
  for (const harness of [missingPlan, missingAttempt, older]) {
    assert.equal(harness.requests.some((request) => request.method === "POST"), false, "restoring missing or older saved music must not generate");
  }

  const legacyPlan = { ...original("legacy-plan"), origin: undefined, analysis_id: "old-analysis", dataset_id: "old-dataset", dataset_name: "movement.jsonl", cache_key: "legacy-key" };
  for (const missingAnalysis of [false, true]) {
    const legacy = creationHarness({ initialPlan: legacyPlan, initialJob: savedJob(legacyPlan), missingAnalysis });
    await legacy.ui.activate();
    assert.equal(legacy.node("audio").src, "/saved.mp3", "saved legacy audio opens even if its old analysis was removed");
    assert.equal(legacy.requests.filter((request) => request.route === "/analyses/old-analysis").length, 1);
    assert.equal(legacy.requests.some((request) => request.route.startsWith("/datasets")), false);
    assert.equal(legacy.requests.some((request) => request.method === "POST"), false);
    assert.equal(Boolean(legacy.selection.analysis), !missingAnalysis, "available legacy replay remains supported");
    assert.doesNotMatch(legacy.node("saved-plan").innerHTML, /jsonl|movement/);
    assert.match(legacy.node("generate").textContent, /Generate original/, "old recorded music is not resubmitted as the starting track");
  }

  const unknown = creationHarness();
  await unknown.ui.activate(); unknown.loseGenerationResponse();
  await unknown.click("generate");
  assert.match(unknown.node("notice").textContent, /No automatic retry/);
  await unknown.click("generate");
  assert.equal(unknown.requests.filter((request) => request.method === "POST" && request.route === "/generations").length, 1,
    "an unknown provider outcome must not be billed again by the normal button");
  assert.match(unknown.node("generate").textContent, /View previous attempt/);

  const bad = creationHarness(); await bad.ui.activate();
  bad.edit("length", "25"); await bad.click("generate");
  assert.match(bad.node("notice").textContent, /20, 40 or 60/);
  bad.edit("length", "20"); bad.edit("bpm", ""); await bad.click("generate");
  assert.match(bad.node("notice").textContent, /BPM/);
  assert.equal(bad.requests.some((request) => request.method === "POST"), false, "invalid settings fail before even the free local plan request");

  const unavailable = creationHarness({ ready: false }); await unavailable.ui.activate();
  await unavailable.click("generate");
  assert.equal(unavailable.requests.some((request) => request.method === "POST"), false);
  console.log("ElevenLabs UI: original creation, duplicate clicks, cache/unknown guards, draft reload and legacy playback passed.");
}
originalCreationTests().catch((error) => { console.error(error); process.exitCode = 1; });
