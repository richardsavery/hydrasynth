"use strict";
const assert = require("node:assert/strict");
require("../dashboard/live.js");
require("../dashboard/live-monitor-model.js");

const joints = ["nose", "neck", "right_shoulder", "right_elbow", "right_wrist", "left_shoulder",
  "left_elbow", "left_wrist", "right_hip", "right_knee", "right_ankle", "left_hip", "left_knee",
  "left_ankle", "right_eye", "left_eye", "right_ear", "left_ear"];
const axes = ["x", "y", "z"];
const coordinates = () => joints.map((_, index) => [index + 1, -(index + 1) / 2, (index + 1) / 4]);
const source = (id, options = {}) => ({ sourceKey: `skeleton|${encodeURIComponent(id)}`, reducer: "value", index: 0, ...options });
const jointSource = (joint, axis, options) => source(`skeleton:${joint}:${axis}`, options);
const read = (stream, joint, axis, now = 100) => stream.read(jointSource(joint, axis), now)?.value ?? null;

// Both supported encodings expose all BODY_18 joints in the documented order.
for (const nested of [false, true]) for (const shape of [undefined, [18, 3], [54]]) {
  const stream = new HydraLive.Stream(), data = coordinates();
  const frame = { channel: "skeleton", data: nested ? data : data.flat(), ...(shape ? { shape } : {}) };
  assert.equal(stream.ingest(frame, 10), true);
  assert.equal(stream.fields.length, 80);
  joints.forEach((joint, index) => axes.forEach((axis, component) => {
    assert.equal(read(stream, joint, axis), data[index][component], `${joint} ${axis}`);
    const field = stream.fieldIndex.get(jointSource(joint, axis).sourceKey);
    assert.equal(field.kind, "position");
    assert.equal(field.joint, joint);
    assert.equal(field.axis, axis);
    assert.equal(field.unit, "m");
    assert.deepEqual(field.reducers, ["value"]);
    assert.equal(field.default_reducer, "value");
  }));
  assert.equal(stream.fieldIndex.get(jointSource("right_wrist", "z").sourceKey).name, "Right wrist Z (up)");
  assert.equal(stream.fieldIndex.get(jointSource("left_ankle", "y").sourceKey).label, "Left ankle Y (left)");
  assert.equal(stream.fieldIndex.get(jointSource("nose", "x").sourceKey).optionLabel, "Nose X (forward)");
  assert.equal(stream.read(source("data", { reducer: "index", index: 14 }), 100).value, data[4][2]);
  assert.equal(stream.read(source("data", { reducer: "mean" }), 100).value, data.flat().reduce((sum, value) => sum + value, 0) / 54);
  assert.equal(read(stream, "nose", "x", 3011), null, "Old frames expire normally");
}

// Arbitrary arrays must not acquire body labels merely because they have 54 values.
for (const channel of ["other", "skeleton_features", "Skeleton"]) {
  const stream = new HydraLive.Stream();
  stream.ingest({ channel, shape: [18, 3], data: coordinates().flat() }, 10);
  assert.equal(stream.fields.length, 1);
  assert.equal(stream.fields[0].fieldId, "data");
}
for (const shape of [[3, 18], [54, 1], [18, 3, 1], [], null, "18,3", ["18", 3]]) {
  const stream = new HydraLive.Stream();
  stream.ingest({ channel: "skeleton", shape, data: coordinates().flat() }, 10);
  assert.equal(stream.fields.length, 1, JSON.stringify(shape));
}
{
  const stream = new HydraLive.Stream(), ragged = coordinates();
  ragged[0].push(ragged[1].pop());
  for (const data of [ragged, coordinates().flat().slice(0, 53), [coordinates().flat()], coordinates().map(joint => joint.map(value => [value]))]) {
    stream.ingest({ channel: "skeleton", data }, 10);
    assert.equal(stream.fields.length, 1);
  }
}

// Legacy labeled sources and raw indices retain their IDs and meanings.
{
  const stream = new HydraLive.Stream(), data = coordinates().flat();
  const labels = data.map((_, index) => `Coordinate ${index}`);
  stream.ingest({ channel: "skeleton", data, labels }, 10);
  assert.equal(stream.fields.length, 134);
  assert.equal(stream.read(source("data:14"), 20).value, data[14]);
  assert.equal(stream.read(source("data", { reducer: "index", index: 14 }), 20).value, data[14]);
  assert.equal(read(stream, "right_wrist", "z"), data[14]);
}

// A missing coordinate invalidates the whole joint, but never renumbers later joints.
for (const missing of [null, NaN, Infinity, "2", false]) {
  const stream = new HydraLive.Stream(), data = coordinates();
  data[4][1] = missing;
  stream.ingest({ channel: "skeleton", data }, 10);
  for (const axis of axes) assert.equal(read(stream, "right_wrist", axis), null);
  assert.equal(read(stream, "left_shoulder", "x"), 6);
  assert.equal(stream.read(source("data", { reducer: "index", index: 12 }), 20).value, 5);
  assert.equal(stream.read(source("data", { reducer: "index", index: 13 }), 20), null);
}
{
  const stream = new HydraLive.Stream(), data = coordinates();
  data[4] = [0, 0, 0];
  data[5] = [0, -2, 0];
  stream.ingest({ channel: "skeleton", data }, 10);
  for (const axis of axes) assert.equal(read(stream, "right_wrist", axis), null);
  assert.equal(read(stream, "left_shoulder", "x"), 0, "A valid joint may have a zero coordinate");
}

// Per-frame shape validation prevents an old descriptor from reading a new incompatible array.
{
  const stream = new HydraLive.Stream(), data = coordinates();
  const mapping = jointSource("right_wrist", "z", { rangeMode: "learn" });
  stream.ingest({ channel: "skeleton", data }, 10);
  assert.equal(stream.read(mapping, 20).value, 1.25);
  data[4][2] = 2;
  stream.ingest({ channel: "skeleton", shape: [18, 3], data: data.flat() }, 30);
  assert.deepEqual(stream.getRange(mapping), { minimum: 1.25, maximum: 2 });
  stream.ingest({ channel: "skeleton", shape: [3, 18], data: data.flat() }, 40);
  assert.equal(stream.read(mapping, 41), null);
  assert.equal(stream.read(source("data", { reducer: "index", index: 14 }), 41).value, 2);
  assert.deepEqual(stream.getRange(mapping), { minimum: 1.25, maximum: 2 });
  const malformed = data.map(joint => [...joint]);
  malformed[0].push(malformed[1].pop());
  stream.ingest({ channel: "skeleton", data: malformed }, 50);
  assert.equal(stream.read(mapping, 51), null);
  data[4] = [0, 0, 0];
  stream.ingest({ channel: "skeleton", data }, 60);
  assert.equal(stream.read(mapping, 61), null);
  assert.deepEqual(stream.getRange(mapping), { minimum: 1.25, maximum: 2 });
  data[4] = [5, -2.5, 3];
  stream.ingest({ channel: "skeleton", data }, 70);
  assert.equal(stream.read(mapping, 71).normalized, 1);
  assert.deepEqual(stream.getRange(mapping), { minimum: 1.25, maximum: 3 });
}

// The live monitor displays scalar coordinates, skips dropouts, and never learns mapping ranges.
{
  const stream = new HydraLive.Stream(), model = HydraLiveMonitorModel.create(), data = coordinates();
  model.connection({ state: "open", now: 0 });
  const send = (frame, now) => model.message(JSON.stringify(frame), now, stream);
  const key = jointSource("right_wrist", "z").sourceKey;
  send({ channel: "skeleton", shape: [18, 3], data }, 10);
  assert.equal(stream.ranges.size, 0);
  assert.equal(stream.samples.size, 0);
  let field = model.inspect(stream, key, 11);
  assert.equal(field.name, "Right wrist Z (up)");
  assert.equal(field.reducer, "value");
  assert.equal(field.count, 1);
  assert.equal(field.numericCount, 1);
  assert.equal(field.value, 1.25);
  assert.deepEqual(field.preview, [1.25]);
  assert.deepEqual(field.points, [[10, 1.25]]);
  const mapping = jointSource("right_wrist", "z", { rangeMode: "learn" });
  stream.read(mapping, 11);
  const savedRange = stream.getRange(mapping);
  data[4] = [0, 0, 0];
  send({ channel: "skeleton", shape: [18, 3], data }, 120);
  field = model.inspect(stream, key, 121);
  assert.equal(field.value, null);
  assert.equal(field.numericCount, 0);
  assert.equal(field.stale, true);
  assert.deepEqual(field.points, []);
  assert.deepEqual(stream.getRange(mapping), savedRange);
  assert.equal(stream.samples.size, 1);
  assert.equal(model.snapshot(stream, 121).channels[0].fieldCount, 80);
  send({ channel: "skeleton", shape: [3, 18], data }, 130);
  assert.equal(model.inspect(stream, key, 131).value, null);
  data[4][2] = 2;
  send({ channel: "skeleton", data }, 220);
  assert.deepEqual(model.inspect(stream, key, 221).points, [[220, 2]]);
  assert.equal(model.inspect(stream, key, 3221).stale, true);
}

// Study capture retains the original values and their declared shape, without derived duplicates.
{
  const events = [], stream = new HydraLive.Stream();
  globalThis.HydraStudy = { emit: (name, payload) => events.push({ name, payload }) };
  stream.ingest({ channel: "skeleton", shape: [18, 3], data: coordinates() }, 10);
  delete globalThis.HydraStudy;
  const frame = events.find(event => event.name === "live.input.frame").payload;
  assert.deepEqual(frame.arrays, [{ key: "data", value_count: 54, shape: [18, 3] }]);
  assert.equal(events.filter(event => event.name === "live.input.values").length, 1);
  assert.deepEqual(events.find(event => event.name === "live.input.values").payload.values, coordinates().flat());
}

// XYZ motion is a speed, not distance from the camera or a signed average.
{
  const stream = new HydraLive.Stream(), data = coordinates();
  const wrist = jointSource("right_wrist", "speed", { rangeMode: "auto" });
  const arm = source("skeleton:region:right_arm:speed");
  const send = (time, at, shape = [18, 3]) => stream.ingest({ channel: "skeleton", t_recv: time, shape, data: data.flat() }, at);
  send(100, 10);
  assert.equal(stream.fields.filter(field => field.skeletonLevel === "region").length, 7);
  assert.equal(stream.fields.filter(field => field.skeletonLevel === "joint").length, 18);
  assert.equal(stream.fields.filter(field => field.skeletonLevel === "axis").length, 54);
  assert.equal(stream.read(wrist, 10), null, "First frame establishes a baseline");
  data[4][0] += 0.3; data[4][1] += 0.4;
  data[3][0] -= 0.5;
  send(100.1, 11); // Network batching must use sender time, not 1ms receipt time.
  assert.ok(Math.abs(stream.read(wrist, 11).value - 5) < 1e-9);
  assert.ok(Math.abs(stream.read(arm, 11).value - 10 / 3) < 1e-9, "Opposite joint movements do not cancel");
  assert.equal(stream.fieldIndex.get(wrist.sourceKey).unit, "m/s");
  assert.equal(stream.fieldIndex.get(arm.sourceKey).name, "Right arm movement");
  send(100.2, 20);
  assert.equal(stream.read(wrist, 20).value, 0, "Stationary tracking is valid zero motion");
  const saved = [...data[4]];
  data[4] = [0, 0, 0]; send(100.3, 30);
  assert.equal(stream.read(wrist, 30), null);
  assert.equal(stream.read(arm, 30).value, 0, "Region averages its remaining tracked joint pairs");
  data[4] = saved.map(value => value + 2); send(100.4, 40);
  assert.equal(stream.read(wrist, 40), null, "Reacquired joint needs a new baseline");
  send(100.5, 50);
  assert.equal(stream.read(wrist, 50).value, 0);
  assert.ok(Math.abs(stream.getRange(wrist).maximum - 5) < 1e-9, "Dropout and reacquisition cannot expand learned range");
  send(101.1, 60);
  assert.equal(stream.read(wrist, 60), null, "A long sender gap resets motion");
  send(101.2, 70); assert.equal(stream.read(wrist, 70).value, 0);
  send(101.1, 80); assert.equal(stream.read(wrist, 80), null, "A replay or clock reset restarts the baseline");
  send(101.2, 90); assert.equal(stream.read(wrist, 90).value, 0);
  send(101.2, 100); assert.equal(stream.read(wrist, 100), null, "Duplicate timestamps cannot produce speed");
  send(101.3, 700); assert.equal(stream.read(wrist, 700), null, "A long receipt gap also resets live motion");
  send(101.4, 710); assert.equal(stream.read(wrist, 710).value, 0);
  send(101.5, 720, [3, 18]); assert.equal(stream.read(wrist, 720), null);
  send(101.6, 730); assert.equal(stream.read(wrist, 730), null, "Malformed body frames break the baseline");
  send(101.7, 740); assert.equal(stream.read(wrist, 740).value, 0);
  stream.ingest({ channel: "skeleton", data: [] }, 745);
  send(101.8, 750); assert.equal(stream.read(wrist, 750), null, "Rejected frames cannot bridge lost tracking");
}

// Tiny intervals are coalesced, and receipt-time fallback works without timestamps.
{
  const stream = new HydraLive.Stream(), data = coordinates(), wrist = jointSource("right_wrist", "speed");
  const send = (time, at) => stream.ingest({ channel: "skeleton", t_recv: time, data }, at);
  send(10, 100);
  data[4][0] += .03; send(10.0001, 101);
  assert.equal(stream.read(wrist, 101), null);
  data[4][0] += .07; send(10.1, 102);
  assert.ok(Math.abs(stream.read(wrist, 102).value - 1) < 1e-9);
  stream.ingest({ channel: "skeleton", data }, 200);
  assert.equal(stream.read(wrist, 200), null, "Switching time sources resets motion");
  data[4][2] += .2;
  stream.ingest({ channel: "skeleton", data }, 300);
  assert.ok(Math.abs(stream.read(wrist, 300).value - 2) < 1e-9);
  data[4] = [0, 0, 0]; stream.ingest({ channel: "skeleton", data }, 300.1);
  data[4] = [20, 20, 20]; stream.ingest({ channel: "skeleton", data }, 400);
  assert.equal(stream.read(wrist, 400), null, "Even a short dropout forgets that joint’s old baseline");
}

// A raw descriptor discovered before a valid skeleton gains the correct UI level.
{
  const stream = new HydraLive.Stream();
  stream.ingest({ channel: "skeleton", data: [1] }, 10);
  stream.ingest({ channel: "skeleton", data: coordinates() }, 20);
  assert.equal(stream.fields.find(field => field.fieldId === "data").skeletonLevel, "raw");
  const model = HydraLiveMonitorModel.create();
  model.connection({ state: "open", now: 0 });
  const tracked = new HydraLive.Stream();
  model.message(JSON.stringify({ channel: "skeleton", t_recv: 1, data: coordinates() }), 10, tracked);
  model.message(JSON.stringify({ channel: "skeleton", t_recv: 1.1, data: coordinates() }), 100, tracked);
  const field = model.inspect(tracked, jointSource("right_wrist", "speed").sourceKey, 101);
  assert.equal(field.value, 0); assert.equal(field.reducer, "value");
  assert.equal(tracked.ranges.size, 0, "Inspecting motion does not learn musical mapping ranges");
}

console.log("Skeleton live input: body regions, joint speed, timing, dropouts and original axes passed");
