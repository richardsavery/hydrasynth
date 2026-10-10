"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(`${__dirname}/../dashboard/elevenlabs-source.js`, "utf8"), context);
const { create, prepareSeries, sample } = context.HydraElevenSource;

async function main() {
  const a = { sourceKey: "a", reducer: "value", index: 0 };
  const b = { ...a, sourceKey: "b" };
  const series = {
    a: { start_time_seconds: 100, end_time_seconds: 101, duration_seconds: 1,
      points: [[0, 0], [0.5, 1], [1, 2]], minimum: 0, maximum: 2 },
    b: { start_time_seconds: 100.25, end_time_seconds: 100.75, duration_seconds: 0.5,
      points: [[0, 2], [1, 3]], minimum: 2, maximum: 3 }
  };
  let clock = 0;
  const state = { sourceMode: "recording", selectionGeneration: 1, liveGeneration: 0,
    recording: { id: "test", name: "Test", start_time_seconds: 100, duration_seconds: 1 }, fields: [a, b] };
  const bridge = create({ getState: () => state, loadSeries: async (source) => series[source.sourceKey], now: () => clock });
  assert.equal(bridge.read(a), null, "unprepared replay is unavailable");
  await bridge.prepare([a, b]);
  assert.equal(bridge.read(a, 0).value, 0);
  assert.equal(bridge.read(b, 0), null, "a later channel must not be stretched to recording start");
  assert.equal(bridge.read(a, 500).value, 1);
  assert.equal(bridge.read(b, 500).value, 2.5);
  assert.equal(bridge.read(b, 900), null, "ended channel must not hold its last sample");
  assert.equal(bridge.read(a, 1250).value, 0.5, "recording replay loops at its shared duration");
  bridge.reset(1000);
  assert.equal(bridge.read(a, 1500).value, 1);
  state.selectionGeneration++;
  assert.equal(bridge.read(a, 1500), null, "a source switch invalidates cached series");

  const gaps = prepareSeries({ start_time_seconds: 0, duration_seconds: 10,
    points: [[0, 0], [0.01, 1], [0.02, 2], [0.9, 9], [0.91, 10], [1, 11]] });
  assert.equal(sample(gaps, 4), null, "a long data gap is not fabricated into smooth motion");
  assert.equal(sample(gaps, 0.05), 0.5);

  let release;
  const pending = create({ getState: () => state,
    loadSeries: () => new Promise((resolve) => { release = resolve; }), now: () => clock });
  const preparing = pending.prepare([a]);
  state.selectionGeneration++;
  release(series.a);
  await assert.rejects(preparing, /changed while loading/);
  assert.equal(pending.read(a), null);

  state.sourceMode = "live";
  state.liveSocket = { readyState: 1 };
  state.live = { read: (_mapping, at, timeout) => at <= timeout ? { value: 42, at: 0 } : null };
  assert.equal(bridge.read(a, 1).value, 42, "live raw values are passed through without another normalization");
  assert.equal(bridge.read(a, 3001), null, "stale live input is unavailable");
  state.liveSocket.readyState = 3;
  assert.equal(bridge.read(a, 1), null, "disconnected sockets cannot reuse a fresh cached value");
  console.log("ElevenLabs source: shared timing, gaps, loop, source changes and stale input passed.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
