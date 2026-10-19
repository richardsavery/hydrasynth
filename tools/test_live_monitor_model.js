"use strict";
const assert = require("node:assert/strict");
require("../dashboard/live.js");
require("../dashboard/live-monitor-model.js");

function setup() {
  const stream = new HydraLive.Stream(), model = HydraLiveMonitorModel.create();
  model.reset({ url: "ws://localhost:8765", now: 0 });
  model.connection({ state: "connecting", now: 0 });
  model.connection({ state: "open", now: 10 });
  return { stream, model, send: (frame, now) => model.message(JSON.stringify(frame), now, stream),
    snapshot: (now = 100) => model.snapshot(stream, now, { sourceMode: "live", wanted: true }) };
}

// Discovery and accepted updates are different; ingest exactly once on either path.
{
  const { stream, model, send, snapshot } = setup();
  assert.match(snapshot().diagnostic.title, /waiting for messages/);
  assert.equal(send({ channel: "__status__", msg: "Player connected" }, 20), false);
  assert.equal(stream.frames, 0);
  assert.equal(snapshot().counts.statusFrames, 1);
  assert.match(snapshot().diagnostic.title, /no numeric data/);
  assert.equal(send({ channel: "robot_joint_states", labels: ["joint_1", "joint_2"], shape: [2], data: [1, 3], velocity: [0.1, 0.3] }, 30), true);
  assert.equal(send({ channel: "robot_joint_states", labels: ["joint_1", "joint_2"], data: [2, 4], velocity: [0.2, 0.4] }, 140), false);
  assert.equal(stream.frames, 2);
  let result = snapshot(150);
  assert.equal(result.counts.messages, 3);
  assert.equal(result.counts.dataFrames, 2);
  assert.equal(result.channels.length, 1);
  assert.equal(result.fields.length, 4);
  assert.equal(result.channels[0].numericCount, 4);
  assert.equal(result.fields[0].value, 2);
  assert.equal(result.fields[0].name, "joint_1 position");
  assert.equal(result.fields[2].name, "joint_1 velocity");
  assert.equal(result.fields[0].reducer, "value");
  assert.equal(result.dataAge, 10);
  assert.equal(result.diagnostic.level, "good");
  const inspected = model.inspect(stream, result.fields[0].key, 150);
  assert.deepEqual(inspected.points, [[30, 1], [140, 2]]);
  assert.equal(inspected.minimum, 1);
  assert.equal(inspected.maximum, 2);
  inspected.points[0][1] = 999;
  assert.equal(model.inspect(stream, result.fields[0].key, 150).points[0][1], 1);
  assert.equal(stream.ranges.size, 0);
  assert.equal(stream.samples.size, 0);
}

// Tensor and unlabeled arrays show a mean, plus a bounded actual-value preview.
{
  const { send, snapshot } = setup();
  send({ channel: "arrays", data: [1, 2, null, "3", 6], tensors: { hidden: { data: [[2, 4], [6, 8]] } } }, 20);
  const result = snapshot();
  assert.equal(result.fields[0].name, "Data");
  assert.equal(result.fields[0].value, 3);
  assert.equal(result.fields[0].numericCount, 3);
  assert.equal(result.fields[0].count, 5);
  assert.equal(result.fields[0].reducer, "mean");
  assert.deepEqual(result.fields[0].preview, [1, 2, null, null, 6]);
  assert.equal(result.fields[1].value, 5);
  assert.equal(result.fields[1].name, "hidden");
}

// Reject invalid wire frames without conflating accepted but nonnumeric arrays.
{
  const { stream, model, send, snapshot } = setup();
  model.message(new Uint8Array([1, 2]).buffer, 11, stream);
  assert.equal(snapshot().raw.text, "[Binary message]");
  assert.equal(snapshot().raw.bytes, 2);
  model.message("not JSON", 12, stream);
  send({ data: [1] }, 13);
  send({ channel: "empty", data: [] }, 14);
  send({ channel: "empty", data: [null, "2", {}] }, 15);
  let result = snapshot();
  assert.equal(stream.invalid, 4);
  assert.equal(stream.frames, 1);
  assert.equal(result.counts.invalidFrames, 4);
  assert.equal(result.counts.binaryFrames, 1);
  assert.equal(result.counts.invalidJsonFrames, 1);
  assert.equal(result.counts.invalidShapeFrames, 1);
  assert.equal(result.counts.noNumericFrames, 2);
  assert.equal(result.counts.dataFrames, 0);
  assert.equal(result.lastDataAt, null);
  assert.equal(result.fields[0].value, null);
  assert.equal(result.fields[0].stale, true);
  assert.match(result.diagnostic.detail, /no finite numbers/);
  model.message(" ".repeat(8 * 1024 * 1024 + 1), 16, stream);
  result = snapshot();
  assert.equal(result.counts.oversizedFrames, 1);
  assert.equal(result.raw.text.length, 12 * 1024);
  assert.equal(result.raw.truncated, true);
  assert.equal(stream.invalid, 5);
  assert.match(result.diagnostic.detail, /8 MiB/);
}

// Malformed metadata cannot throw out of a socket handler or hide otherwise usable numeric data.
{
  const { stream, model, send, snapshot } = setup();
  assert.doesNotThrow(() => send({ channel: "__status__", msg: { toString: null } }, 20));
  assert.doesNotThrow(() => send({ channel: "__status__", msg: [{ toString: {} }], message: "Fallback status" }, 21));
  assert.equal(snapshot().counts.statusFrames, 2);
  assert.equal(snapshot().events.at(-1).message, "Fallback status");
  assert.doesNotThrow(() => send({ channel: "robot", labels: [{ toString: null }, [{ toString: {} }], "joint_3"], data: [1, 2, 3] }, 22));
  assert.equal(snapshot().counts.dataFrames, 1);
  assert.deepEqual(snapshot().fields.map((field) => field.name), ["Input 1 position", "Input 2 position", "joint_3 position"]);
  assert.deepEqual(snapshot().fields.map((field) => field.value), [1, 2, 3]);
  assert.doesNotThrow(() => model.message('{"channel":"\\ud800","data":[1]}', 23, stream));
  assert.doesNotThrow(() => model.message('{"channel":"robot","tensors":{"\\udfff":{"data":[1]}}}', 24, stream));
  assert.equal(snapshot().counts.invalidShapeFrames, 2);
  assert.equal(stream.frames, 1);
  assert.equal(stream.invalid, 2);
  assert.equal(stream.channels.size, 1);
  // A future ingest failure is still contained at the WebSocket message boundary.
  const originalIngest = stream.ingest;
  stream.ingest = () => { throw new TypeError("Unsupported metadata"); };
  assert.doesNotThrow(() => send({ channel: "robot", data: [4] }, 25));
  assert.equal(snapshot().counts.invalidShapeFrames, 3);
  assert.equal(stream.invalid, 3);
  stream.ingest = originalIngest;
  send({ channel: "robot", labels: ["joint_1", "joint_2", "joint_3"], data: [4, 5, 6] }, 26);
  assert.equal(snapshot().counts.dataFrames, 2);
  assert.equal(snapshot().fields[0].value, 4);
}

// A stopped channel stays stale while another remains busy. Inspector never learns ranges.
{
  const { stream, model, send, snapshot } = setup();
  send({ channel: "slow", data: [1] }, 20);
  send({ channel: "fast", data: [2] }, 21);
  const source = { sourceKey: stream.fields[0].key, reducer: "mean", index: 0, rangeMode: "learn" };
  stream.read(source, 22);
  const range = stream.getRange(source), samples = stream.samples.size, ranges = stream.ranges.size;
  send({ channel: "fast", data: [3] }, 3100);
  let result = snapshot(3110);
  assert.equal(result.channels[0].stale, true);
  assert.equal(result.channels[1].stale, false);
  assert.equal(result.fields[0].stale, true);
  assert.match(result.diagnostic.title, /Some channels/);
  assert.match(result.diagnostic.detail, /slow/);
  model.inspect(stream, source.sourceKey, 3110);
  model.clearHistory(3111);
  assert.deepEqual(stream.getRange(source), range);
  assert.equal(stream.samples.size, samples);
  assert.equal(stream.ranges.size, ranges);
  assert.equal(snapshot(6500).rate, 0);
  assert.match(snapshot(6500).diagnostic.title, /Data has stopped/);
}

// Closure makes existing values stale immediately; reconnection never joins graph segments.
{
  const { stream, model, send, snapshot } = setup();
  send({ channel: "robot", data: [1] }, 20);
  const key = stream.fields[0].key;
  model.connection({ state: "closed", now: 30, code: 1006, retryAt: 1030 });
  assert.equal(snapshot(31).fields[0].stale, true);
  assert.equal(snapshot(31).channels[0].stale, true);
  assert.match(snapshot(31).events.at(-1).message, /1006/);
  assert.equal(snapshot(31).retryAt, 1030);
  model.connection({ state: "connecting", now: 1030 });
  assert.deepEqual(model.inspect(stream, key, 1030).points, []);
  model.connection({ state: "open", now: 1040 });
  assert.equal(snapshot(1041).counts.reconnections, 1);
  assert.equal(snapshot(1041).fields[0].stale, true);
  assert.equal(snapshot(1041).channels[0].stale, true);
  assert.match(snapshot(1041).diagnostic.title, /waiting for messages/);
  send({ channel: "robot", data: [2] }, 1050);
  assert.deepEqual(model.inspect(stream, key, 1051).points, [[1050, 2]]);
  assert.equal(snapshot(1051).fields[0].stale, false);
  assert.equal(snapshot(1051).counts.messages, 2);
  model.reset({ url: "ws://other:8765", now: 1100 });
  assert.equal(snapshot(1101).counts.messages, 0);
  assert.deepEqual(snapshot(1101).fields, []);
  assert.equal(snapshot(1101).url, "ws://other:8765");
}

// Browsers usually close immediately after an error; retain the actionable failure hint.
{
  const { stream, model, snapshot } = setup();
  model.connection({ state: "error", now: 20 });
  model.connection({ state: "closed", now: 21, retryAt: 1021 });
  assert.equal(snapshot(22).diagnostic.level, "error");
  assert.match(snapshot(22).diagnostic.title, /Connection lost/);
  assert.match(snapshot(22).diagnostic.detail, /Automatic reconnect/);
  const canceledRetry = model.snapshot(stream, 23, { sourceMode: "live", retryAt: null });
  assert.equal(canceledRetry.retryAt, null);
  assert.doesNotMatch(canceledRetry.diagnostic.detail, /Automatic reconnect/);
  model.connection({ state: "connecting", now: 1021 });
  assert.equal(snapshot(1022).diagnostic.level, "info");
  model.connection({ state: "timeout", now: 11021 });
  model.connection({ state: "closed", now: 11022 });
  assert.match(snapshot(11023).diagnostic.title, /timed out/);
  model.connection({ state: "disconnected", now: 11024 });
  assert.equal(snapshot(11025).diagnostic.level, "info");
}

// Every retained structure is bounded, and high-rate measurements don't saturate a sample queue.
{
  const { stream, model, send, snapshot } = setup();
  for (let i = 0; i < 1000; i++) send({ channel: "robot", data: [i] }, 20 + i * 100);
  const inspected = model.inspect(stream, stream.fields[0].key, 100000);
  assert.equal(inspected.points.length, 120);
  for (let i = 0; i < 100; i++) model.connection({ state: i % 2 ? "closed" : "error", now: 100000 + i });
  assert.equal(snapshot(100100).events.length, 40);
  model.clearHistory(100101);
  model.connection({ state: "open", now: 100102 });
  for (let i = 0; i < 3000; i++) send({ channel: "robot", data: [i] }, 100103 + i / 10);
  assert.equal(snapshot(100403).rate, 1500);
  assert.equal(snapshot(100403).dataRate, 1500);
  assert.equal(model.inspect(stream, stream.fields[0].key, 100403).points.length, 4);
  assert.equal(snapshot(100403).channels[0].preview.length, 1);
  assert.equal(snapshot(100403).fields[0].minimum, 0);
  assert.equal(snapshot(100403).fields[0].maximum, 2999);
}

// Expose channel/field/array limits instead of silently hiding missing input discovery.
{
  const { stream, send, snapshot } = setup();
  for (let i = 0; i < 32; i++) send({ channel: `channel_${i}`, data: [i] }, 20 + i);
  send({ channel: "overflow", data: [1] }, 60);
  assert.equal(snapshot().counts.limitFrames, 1);
  assert.equal(stream.lastResult.reason, "channel_limit");
  assert.match(snapshot().diagnostic.detail, /32 channels/);
  send({ channel: "channel_0", data: Array(262145).fill(1) }, 61);
  assert.equal(snapshot().counts.limitFrames, 2);
  assert.equal(stream.lastResult.reason, "array_limit");
}
{
  const { stream, send, snapshot } = setup();
  send({ channel: "many", labels: Array.from({ length: 256 }, (_, i) => `joint_${i}`), data: Array(256).fill(1), velocity: Array(256).fill(2) }, 20);
  assert.equal(stream.fields.length, 256);
  assert.equal(snapshot().fields.length, 256);
  assert.match(snapshot().diagnostic.detail, /first 256 fields/);
  assert.equal(stream.lastResult.fieldLimitReached, true);
}
console.log("Live monitor model tests passed");
