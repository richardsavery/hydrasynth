"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..", "dashboard");
const vendor = fs.readFileSync(path.join(root, "vendor", "soundtouch-2.1.1.js"), "utf8").replace("export { SoundTouch };", "");
const worklet = fs.readFileSync(path.join(root, "audio-pitch-worklet.js"), "utf8").replace(/^import .*;\n/, "");

function processor(sampleRate = 48000) {
  let Processor;
  const Base = class { constructor() { this.port = { postMessage() {}, onmessage: null }; } };
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", vendor + "\n" + worklet)(Base, (name, cls) => {
    if (name === "hydra-independent-pitch") Processor = cls;
  }, sampleRate);
  return Processor;
}

function render({ sampleRate = 48000, seconds = 3, pitch = 0, rate = 1, dynamic = null, signal = null }) {
  const Processor = processor(sampleRate);
  const node = new Processor({ processorOptions: { pitchSemitones: pitch, playbackRate: rate } });
  const length = Math.ceil(seconds * sampleRate / 128) * 128;
  const result = [new Float32Array(length), new Float32Array(length)];
  const inputs = [new Float32Array(128), new Float32Array(128)];
  const outputs = [new Float32Array(128), new Float32Array(128)];
  const params = { pitchSemitones: new Float32Array([pitch]), playbackRate: new Float32Array([rate]) };
  for (let offset = 0; offset < length; offset += 128) {
    if (dynamic) {
      const values = dynamic(offset / sampleRate, offset / 128);
      params.pitchSemitones[0] = values.pitch;
      params.playbackRate[0] = values.rate;
    }
    for (let channel = 0; channel < 2; channel++) {
      for (let i = 0; i < 128; i++) inputs[channel][i] = signal ? signal(offset + i, channel) :
        0.4 * Math.sin(2 * Math.PI * (channel ? 660 : 440) * rate * (offset + i) / sampleRate);
    }
    assert.equal(node.process([inputs], [outputs], params), true);
    for (let channel = 0; channel < 2; channel++) result[channel].set(outputs[channel], offset);
  }
  return { node, result, sampleRate };
}

function frequency(samples, sampleRate) {
  const start = sampleRate, end = samples.length - Math.ceil(sampleRate * 0.1);
  const crossings = [];
  for (let i = start + 1; i < end; i++) if (samples[i - 1] <= 0 && samples[i] > 0) {
    crossings.push(i - 1 - samples[i - 1] / (samples[i] - samples[i - 1]));
  }
  return (crossings.length - 1) * sampleRate / (crossings.at(-1) - crossings[0]);
}

function assertContinuous(samples, sampleRate) {
  for (let offset = Math.ceil(sampleRate * 0.6); offset + 256 <= samples.length; offset += 256) {
    let square = 0;
    for (let i = offset; i < offset + 256; i++) {
      assert.ok(Number.isFinite(samples[i]));
      square += samples[i] * samples[i];
    }
    assert.ok(square > 0.01, `Silent block at ${offset / sampleRate}s`);
  }
}

async function main() {
  // A real sample-level check: neutral processing is bit-exact, with the same
  // advertised buffering delay on each stereo channel and each sample rate.
  for (const sampleRate of [44100, 48000]) {
    const source = (frame, channel) => Math.sin(frame * 0.019 + channel * 0.4) * 0.4;
    const { node, result } = render({ sampleRate, seconds: 1, signal: source });
    for (let channel = 0; channel < 2; channel++) {
      for (let i = 0; i < result[channel].length; i++) {
        const expected = i < node.latencyFrames ? 0 : Math.fround(source(i - node.latencyFrames, channel));
        assert.equal(result[channel][i], expected);
      }
    }
  }

  // Input frequency includes source playbackRate, as it does in Web Audio.
  // The worklet must restore pitch at every speed and apply independent tuning.
  for (const rate of [0.75, 1, 1.25]) {
    for (const pitch of [-24, -12, 0, 7, 12, 24]) {
      const { node, result, sampleRate } = render({ rate, pitch });
      assert.equal(node.underruns, 0, `Underrun at ${pitch} semitones / ${rate} speed`);
      for (let channel = 0; channel < 2; channel++) {
        const expected = (channel ? 660 : 440) * Math.pow(2, pitch / 12);
        const actual = frequency(result[channel], sampleRate);
        assert.ok(Math.abs(actual - expected) < Math.max(2, expected * 0.007), `${pitch} / ${rate}: expected ${expected} Hz, got ${actual}`);
        assertContinuous(result[channel], sampleRate);
      }
    }
  }

  // Fifteen minutes of aggressive changing pitch/speed exercises FIFO bounds
  // and the history-based recovery; it must never create a silent output block.
  const sweeping = render({ seconds: 900, dynamic: (_, block) => ({ pitch: 24 * Math.sin(block / 13), rate: 1 + 0.25 * Math.sin(block / 53) }) });
  assert.equal(sweeping.node.underruns, 0);
  assert.ok(sweeping.node.reprimes > 0, "Long sweep should exercise bounded FIFO recovery");
  assert.ok(sweeping.node.pipe.outputBuffer.frameCount < sweeping.node.latencyFrames * 2);
  for (const channel of sweeping.result) assertContinuous(channel, sweeping.sampleRate);
  sweeping.node.port.onmessage({ data: { type: "dispose" } });
  assert.equal(sweeping.node.process([], [[new Float32Array(128), new Float32Array(128)]], {}), false);

  const calls = [], nodes = [];
  let startedPorts = 0;
  const sandbox = { console, URL, AudioWorkletNode: class { constructor(...args) { nodes.push(args); this.port = { start() { startedPorts++; } }; } }, document: { currentScript: { src: "http://localhost:8790/audio-pitch.js" } } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "audio-pitch.js"), "utf8"), sandbox);
  const context = { sampleRate: 48000, audioWorklet: { addModule: (url) => { calls.push(url); return Promise.resolve(); } } };
  await Promise.all([sandbox.HydraPitch.register(context), sandbox.HydraPitch.register(context)]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "http://localhost:8790/audio-pitch-worklet.js");
  assert.equal(sandbox.HydraPitch.latencySeconds(context), 0.256);
  sandbox.HydraPitch.create(context, { pitchSemitones: 7, playbackRate: 0.75 });
  assert.equal(startedPorts, 1, "Diagnostic messages cannot accumulate in an inactive port queue");
  assert.equal(nodes[0][1], "hydra-independent-pitch");
  assert.equal(nodes[0][2].parameterData.pitchSemitones, 7);
  assert.equal(nodes[0][2].parameterData.playbackRate, 0.75);
  let attempts = 0;
  const failed = { sampleRate: 48000, audioWorklet: { addModule: async () => { if (++attempts === 1) throw new Error("offline"); } } };
  await assert.rejects(sandbox.HydraPitch.register(failed), /Could not load/);
  await sandbox.HydraPitch.register(failed);
  assert.equal(attempts, 2);
  await assert.rejects(sandbox.HydraPitch.register({}), /AudioWorklet/);
  console.log("Independent pitch DSP tests passed: stereo frequency, exact neutral delay, 15-minute modulation/recovery, registration and disposal.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
