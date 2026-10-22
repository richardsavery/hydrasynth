"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture({ frames = 2519, parts = 6, rate = 48, sourceRate = 48, chunkFrames = 480, startTime = 0 } = {}) {
  let Processor;
  class Base {
    constructor() { this.port = { messages: [], postMessage(message) { this.messages.push(message); }, onmessage: null }; }
  }
  const scope = vm.createContext({ AudioWorkletProcessor: Base, sampleRate: rate, currentFrame: 0,
    registerProcessor(name, value) { assert.equal(name, "hydra-streamed-audio"); Processor = value; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/audio-stream-worklet.js"), "utf8"), scope);
  const processor = new Processor({ processorOptions: { frames, parts, sourceRate, chunkFrames, startTime } });
  const sample = (frame, part, channel) => Math.sin(frame * 0.001) * 0.25 + part * 0.05 + channel * 0.02;
  function supply(index) {
    const length = Math.min(chunkFrames, frames - index * chunkFrames);
    const chunk = Array.from({ length: parts }, (_, part) => [0, 1].map((channel) =>
      Float32Array.from({ length }, (_, offset) => sample(index * chunkFrames + offset, part, channel))));
    processor.port.onmessage({ data: { type: "chunk", index, parts: chunk } });
  }
  for (let index = 0; index < Math.min(3, Math.ceil(frames / chunkFrames)); index++) supply(index);
  return { processor, scope, sample, supply,
    step(playbackRate = 1, refill = true) {
      const outputs = Array.from({ length: parts }, () => [new Float32Array(128), new Float32Array(128)]);
      const rates = typeof playbackRate === "number" ? Float32Array.of(playbackRate) : playbackRate;
      const alive = processor.process([], outputs, { playbackRate: rates });
      scope.currentFrame += 128;
      if (refill) {
        for (const message of processor.port.messages.splice(0)) if (message.type === "need") {
          for (const index of message.indices) supply(index);
        }
      }
      return { outputs, alive, rates };
    } };
}

{
  const test = fixture();
  let position = 0, loops = 0;
  for (let block = 0; block < 90; block++) {
    const rates = Float32Array.from({ length: 128 }, (_, index) => 0.75 + 0.5 * ((block * 128 + index) % 1536) / 1535);
    const { outputs, alive } = test.step(rates);
    assert.equal(alive, true);
    for (let offset = 0; offset < 128; offset++) {
      const at = Math.floor(position), fraction = position - at, next = (at + 1) % 2519;
      for (let part = 0; part < 6; part++) for (let channel = 0; channel < 2; channel++) {
        const a = Math.fround(test.sample(at, part, channel)), b = Math.fround(test.sample(next, part, channel));
        const expected = a + (b - a) * fraction;
        assert.ok(Math.abs(outputs[part][channel][offset] - expected) < 1e-7, "all stems retain sample alignment through rate ramps, chunk boundaries and EOF loops");
      }
      position += rates[offset];
      if (position >= 2519) { position %= 2519; loops++; }
    }
    assert.ok(test.processor.chunks.size <= 3, "the audio thread retains at most three windows");
  }
  assert.ok(loops >= 4);
}

{
  const test = fixture({ frames: 7200 * 48, parts: 6 });
  for (let block = 0; block < 2800; block++) assert.equal(test.step().alive, true);
  assert.ok(test.processor.chunks.size <= 3, "a two-hour song never increases the streaming working set");
  assert.ok(test.processor.position < 7200 * 48);
}

{
  const test = fixture({ frames: 239, parts: 2, rate: 96, sourceRate: 48, chunkFrames: 100, startTime: 0.25 });
  const { outputs } = test.step();
  for (let offset = 0; offset < 24; offset++) assert.equal(outputs[0][0][offset], 0, "scheduled start uses the shared audio clock");
  assert.equal(outputs[0][0][24], 0);
  assert.ok(Math.abs(outputs[1][1][25] - (test.sample(0, 1, 1) + test.sample(1, 1, 1)) / 2) < 1e-7,
    "48 kHz source windows resample together when the device runs at 96 kHz");
}

{
  const test = fixture({ frames: 5000 });
  let alive = true;
  for (let block = 0; block < 20 && alive; block++) alive = test.step(1, false).alive;
  assert.equal(alive, false, "missing a window stops the entire source instead of dropping an individual stem");
  assert.equal(test.processor.port.messages.filter((message) => message.type === "underrun").length, 1);
  assert.equal(test.processor.chunks.size, 0, "underrun releases decoded windows");
  assert.equal(test.step().alive, false);
}

{
  const test = fixture();
  test.processor.port.onmessage({ data: { type: "chunk", index: 1, parts: [[new Float32Array(1), new Float32Array(1)]] } });
  assert.equal(test.step().alive, false, "malformed or incomplete stem windows fail together");
}

{
  const test = fixture({ parts: 1 });
  assert.doesNotThrow(() => test.processor.port.onmessage({ data: { type: "chunk", index: 0, parts: [[null, null]] } }));
  assert.equal(test.step().alive, false, "invalid channel payloads become a coordinated failure rather than a worklet exception");
}

{
  const test = fixture();
  test.processor.port.onmessage({ data: { type: "dispose" } });
  assert.equal(test.processor.chunks.size, 0);
  assert.equal(test.step().alive, false, "stopping frees all audio-thread windows");
}

console.log("Streamed audio: synchronized stems, bounded two-hour playback, ramps, resampling, loops and underrun cleanup passed.");
