"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/elevenlabs.js"), "utf8"), context);
const { sectionAt, canGenerate, matchesPlan, hasPendingWork } = context.HydraElevenLabs;

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
