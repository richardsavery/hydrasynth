"use strict";

// All stem outputs share this source cursor. The browser never decodes an
// entire uploaded song: the main thread supplies three small PCM windows.
class HydraStreamedAudio extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "playbackRate", defaultValue: 1, minValue: 0.75, maxValue: 1.25, automationRate: "a-rate" }];
  }

  constructor(options = {}) {
    super();
    const settings = options.processorOptions || {};
    this.frames = settings.frames;
    this.chunkFrames = settings.chunkFrames;
    this.sourceRate = settings.sourceRate;
    this.parts = settings.parts;
    this.startFrame = Math.ceil(settings.startTime * sampleRate);
    this.position = 0;
    this.chunks = new Map();
    this.requested = new Set();
    this.wanted = new Set();
    this.window = -1;
    this.disposed = false;
    if (!Number.isSafeInteger(this.frames) || this.frames < 1 ||
        !Number.isInteger(this.chunkFrames) || this.chunkFrames < 1 ||
        !Number.isFinite(this.sourceRate) || this.sourceRate <= 0 || !Number.isFinite(this.startFrame) ||
        !Number.isInteger(this.parts) || this.parts < 1 || this.parts > 6) this.disposed = true;
    this.chunkCount = Math.ceil(this.frames / this.chunkFrames);
    for (let offset = 0; offset < Math.min(3, this.chunkCount); offset++) this.wanted.add(offset);
    this.port.onmessage = ({ data }) => {
      if (data?.type === "dispose") { this.disposed = true; this.chunks.clear(); return; }
      if (this.disposed || data?.type !== "chunk" || !this.wanted.has(data.index)) return;
      const length = Math.min(this.chunkFrames, this.frames - data.index * this.chunkFrames);
      if (!Array.isArray(data.parts) || data.parts.length !== this.parts ||
          data.parts.some((part) => !Array.isArray(part) || part.length !== 2 || part.some((channel) =>
            !ArrayBuffer.isView(channel) || Object.prototype.toString.call(channel) !== "[object Float32Array]" || channel.length !== length))) {
        this.fail(); return;
      }
      this.chunks.set(data.index, data.parts);
      this.requested.delete(data.index);
    };
  }

  fail() {
    if (!this.disposed) this.port.postMessage({ type: "underrun" });
    this.disposed = true;
    this.chunks.clear();
  }

  requestWindow() {
    const index = Math.floor(this.position / this.chunkFrames);
    if (index === this.window) return;
    this.window = index;
    this.wanted.clear();
    for (let offset = 0; offset < Math.min(3, this.chunkCount); offset++) this.wanted.add((index + offset) % this.chunkCount);
    for (const key of this.chunks.keys()) if (!this.wanted.has(key)) this.chunks.delete(key);
    for (const key of this.requested) if (!this.wanted.has(key)) this.requested.delete(key);
    const indices = [];
    for (const key of this.wanted) if (!this.chunks.has(key) && !this.requested.has(key)) { indices.push(key); this.requested.add(key); }
    this.port.postMessage({ type: "need", indices, buffered: [...this.chunks.keys()] });
  }

  process(_inputs, outputs, parameters) {
    if (this.disposed) return false;
    this.requestWindow();
    const length = outputs[0]?.[0]?.length || 128;
    const rates = parameters.playbackRate;
    for (let offset = 0; offset < length; offset++) {
      if (currentFrame + offset < this.startFrame) continue;
      const frame = Math.floor(this.position), fraction = this.position - frame;
      const following = frame + 1 >= this.frames ? 0 : frame + 1;
      const index = Math.floor(frame / this.chunkFrames), nextIndex = Math.floor(following / this.chunkFrames);
      const chunk = this.chunks.get(index), next = this.chunks.get(nextIndex);
      if (!chunk || (!next && fraction > 0)) { this.fail(); return false; }
      const at = frame % this.chunkFrames, after = following % this.chunkFrames;
      for (let part = 0; part < this.parts; part++) {
        for (let channel = 0; channel < 2; channel++) {
          const a = chunk[part][channel][at];
          outputs[part][channel][offset] = fraction ? a + (next[part][channel][after] - a) * fraction : a;
        }
      }
      const rate = rates.length === 1 ? rates[0] : rates[offset];
      this.position = (this.position + rate * this.sourceRate / sampleRate) % this.frames;
      this.requestWindow();
    }
    return true;
  }
}

registerProcessor("hydra-streamed-audio", HydraStreamedAudio);
