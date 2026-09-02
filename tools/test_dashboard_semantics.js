"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(projectRoot, "dashboard", "app.js"), "utf8");
const context = vm.createContext({
  console,
  document: { addEventListener() {} },
  window: {},
  localStorage: { getItem() { return null; }, setItem() {} },
  Intl,
  URLSearchParams,
  Element: class Element {}
});

vm.runInContext(
  `${source}
globalThis.__dashboardTests = {
  applyCurve,
  clamp,
  combineSeries,
  combineValues,
  destinationFor,
  formatDuration,
  formatNumber,
  fieldsForRecording,
  reducerLabel,
  DESTINATIONS,
  SCALE_INTERVALS
};`,
  context,
  { filename: "dashboard/app.js" }
);

const {
  applyCurve,
  clamp,
  combineSeries,
  combineValues,
  destinationFor,
  formatDuration,
  formatNumber,
  fieldsForRecording,
  reducerLabel,
  DESTINATIONS,
  SCALE_INTERVALS
} = context.__dashboardTests;

assert.equal(applyCurve(0.25, "linear"), 0.25);
assert.equal(applyCurve(0.25, "inverse"), 0.75);
assert.equal(applyCurve(0.5, "smooth"), 0.5);
assert.equal(applyCurve(0.5, "exponential"), 0.25);
assert.equal(clamp(-2, 0, 127), 0);
assert.equal(clamp(200, 0, 127), 127);
assert.equal(combineValues([0.2, 0.8], "average"), 0.5);
assert.ok(Math.abs(combineValues([0.2, 0.8], "weighted", [3, 1]) - 0.35) < 1e-12);
assert.ok(Math.abs(combineValues([0.8, 0.2], "difference") - 0.6) < 1e-12);
assert.deepEqual(
  Array.from(combineSeries([
    { points: [[0, 0], [1, 10]], minimum: 0, maximum: 10 },
    { points: [[0, 10], [1, 0]], minimum: 0, maximum: 10 }
  ], "average").points, (point) => Array.from(point)),
  [[0, 0.5], [1, 0.5]]
);
assert.equal(destinationFor("cutoff").cc, 74);
assert.equal(destinationFor("reverb").cc, 93);
assert.equal(destinationFor("macro8").cc, 23);
assert.equal(DESTINATIONS.filter((item) => item.cc !== undefined).length, 13);
assert.deepEqual(Array.from(SCALE_INTERVALS["minor-pentatonic"]), [0, 3, 5, 7, 10]);
assert.equal(formatDuration(65), "1:05");
assert.equal(formatDuration(3661), "1:01:01");
assert.equal(formatNumber(0.00001), "1.00e-5");
assert.equal(reducerLabel("rms"), "RMS energy");
const flattened = fieldsForRecording({
  channels: [{
    id: "activation_energy",
    name: "activation energy",
    fields: [{ id: "tensor:encoder_out_norm", name: "encoder out norm" }]
  }]
});
assert.equal(flattened[0].channelId, "activation_energy");
assert.equal(flattened[0].fieldId, "tensor:encoder_out_norm");
assert.equal(flattened[0].key, "activation_energy|tensor%3Aencoder_out_norm");

console.log("dashboard sonification tests: ok");
