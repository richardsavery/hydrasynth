import { SoundTouch } from "./vendor/soundtouch-2.1.1.js";

function makePipe(rate, latencyFrames, history) {
  const pipe = new SoundTouch({ sampleRate, sampleBufferType: "circular" });
  pipe.setStretchParameters({ sequenceMs: 40, seekWindowMs: 8, overlapMs: 8, quickSeek: true });
  const intermediate = pipe.transposer.outputBuffer;
  pipe.stretch.inputBuffer = pipe.inputBuffer;
  pipe.stretch.outputBuffer = intermediate;
  pipe.transposer.inputBuffer = intermediate;
  pipe.transposer.outputBuffer = pipe.outputBuffer;
  pipe.stretch.tempo = 1 / rate;
  pipe.transposer.rate = rate;
  const warmFrames = latencyFrames * 2;
  // Every possible overlap/interpolation of the initial silence is also zero.
  // Skip those expensive kernels while priming so creating six stem processors
  // for a crossfade does not spend tens of milliseconds on the rendering thread.
  const seek = pipe.stretch.seekBestOverlapPosition;
  const interpolate = pipe.transposer.resolvedInterpolationKernel;
  if (!history) {
    pipe.stretch.seekBestOverlapPosition = () => 0;
    pipe.transposer.resolvedInterpolationKernel = () => 0;
  }
  pipe.inputBuffer.putSamples(history || new Float32Array(warmFrames * 2), 0, warmFrames);
  pipe.stretch.process();
  pipe.transposer.process();
  pipe.stretch.seekBestOverlapPosition = seek;
  pipe.transposer.resolvedInterpolationKernel = interpolate;
  pipe.outputBuffer.receive(warmFrames - latencyFrames);
  return pipe;
}

// The transport supplies speed; this processor counteracts the pitch change and
// adds the requested semitones. A common 256 ms buffering budget keeps all stem
// paths on the same nominal timeline, including the exact neutral bypass.
// WSOLA aligns waveform overlaps: individual transients can move by tens of ms,
// especially at octave extremes. This is an estimated beat grid, not beat detection.
class HydraIndependentPitch extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "pitchSemitones", defaultValue: 0, minValue: -24, maxValue: 24, automationRate: "k-rate" },
      { name: "playbackRate", defaultValue: 1, minValue: 0.75, maxValue: 1.25, automationRate: "k-rate" },
    ];
  }

  constructor(options = {}) {
    super();
    const settings = options.processorOptions || {};
    this.latencyFrames = Math.ceil(sampleRate * 0.256 / 128) * 128;
    // Keep the processing order fixed. Upstream rewires the intermediate FIFO
    // when pitch crosses unity; frequent live mappings would reinterpret those
    // queued samples and progressively change latency. Stretch -> transpose
    // works on both sides of unity and preserves a single streaming timeline.
    this.ratio = this._ratio(settings.pitchSemitones ?? 0, settings.playbackRate ?? 1);
    // Drop the pre-roll preceding the common output origin, retaining enough
    // processed silence to absorb SoundTouch's variable-size output chunks.
    this.pipe = makePipe(this.ratio, this.latencyFrames);
    this.previousPipe = null;
    this.reprimeFade = 0;
    this.history = new Float32Array(this.latencyFrames * 4);
    this.historyIndex = 0;
    this.reprimes = 0;
    this.inputSamples = new Float32Array(256);
    this.outputSamples = new Float32Array(256);
    this.previousSamples = new Float32Array(256);
    this.dry = [new Float32Array(this.latencyFrames), new Float32Array(this.latencyFrames)];
    this.dryIndex = 0;
    this.wet = Math.abs(this.ratio - 1) < 1e-7 ? 0 : 1;
    this.disposed = false;
    this.underruns = 0;
    this.blocks = 0;
    this.port.onmessage = (event) => { if (event.data?.type === "dispose") this.disposed = true; };
  }

  _ratio(semitones, rate) {
    const pitch = Number.isFinite(semitones) ? Math.max(-24, Math.min(24, semitones)) : 0;
    const speed = Number.isFinite(rate) ? Math.max(0.75, Math.min(1.25, rate)) : 1;
    return Math.pow(2, pitch / 12) / speed;
  }

  _setRatio(ratio) {
    if (ratio === this.ratio) return;
    this.ratio = ratio;
    // Preserve fractional input consumption across parameter updates. Resetting
    // it every render block would accumulate transport drift during a sweep.
    for (const pipe of [this.pipe, this.previousPipe]) {
      if (!pipe) continue;
      const carry = pipe.stretch.skipFract;
      pipe.stretch.tempo = 1 / ratio;
      pipe.stretch.skipFract = carry;
      pipe.transposer.rate = ratio;
    }
  }

  _reprimeIfNeeded() {
    const buffered = this.pipe.outputBuffer.frameCount;
    if (this.previousPipe || (buffered >= sampleRate * 0.025 && buffered < this.latencyFrames * 2)) return;
    // Very long, rapid modulation can change the accumulated WSOLA overlap
    // alignment. Rebuild from the rolling source history before the FIFO runs
    // dry, then crossfade the two continuous streams over 20 ms. This bounds
    // memory and drift without dropping whole phrases or inserting silence.
    const chronological = new Float32Array(this.history.length);
    chronological.set(this.history.subarray(this.historyIndex));
    chronological.set(this.history.subarray(0, this.historyIndex), this.history.length - this.historyIndex);
    this.previousPipe = this.pipe;
    this.pipe = makePipe(this.ratio, this.latencyFrames, chronological);
    this.reprimeFade = Math.ceil(sampleRate * 0.02);
    this.reprimes++;
  }

  _renderPipe(pipe, output, count) {
    pipe.inputBuffer.putSamples(this.inputSamples, 0, count);
    pipe.stretch.process();
    pipe.transposer.process();
    const available = Math.min(count, pipe.outputBuffer.frameCount);
    if (available < count && pipe === this.pipe) this.underruns++;
    pipe.outputBuffer.extract(output, 0, available);
    pipe.outputBuffer.receive(available);
    if (available < count) output.fill(0, available * 2, count * 2);
  }

  process(inputs, outputs, parameters) {
    if (this.disposed) return false;
    const output = outputs[0];
    if (!output?.[0]?.length) return true;
    const count = output[0].length;
    const input = inputs[0] || [];
    const left = input[0], right = input[1] || left;
    const leftOut = output[0], rightOut = output[1] || leftOut;
    if (this.inputSamples.length < count * 2) {
      this.inputSamples = new Float32Array(count * 2);
      this.outputSamples = new Float32Array(count * 2);
      this.previousSamples = new Float32Array(count * 2);
    }
    this._setRatio(this._ratio(parameters.pitchSemitones[0], parameters.playbackRate[0]));
    this._reprimeIfNeeded();
    for (let i = 0; i < count; i++) {
      this.inputSamples[i * 2] = Number.isFinite(left?.[i]) ? left[i] : 0;
      this.inputSamples[i * 2 + 1] = Number.isFinite(right?.[i]) ? right[i] : 0;
      this.history[this.historyIndex] = this.inputSamples[i * 2];
      this.history[this.historyIndex + 1] = this.inputSamples[i * 2 + 1];
      this.historyIndex = (this.historyIndex + 2) % this.history.length;
    }
    this._renderPipe(this.pipe, this.outputSamples, count);
    if (this.previousPipe) this._renderPipe(this.previousPipe, this.previousSamples, count);
    const targetWet = Math.abs(this.ratio - 1) < 1e-7 ? 0 : 1;
    const wetStep = 1 / (sampleRate * 0.02);
    for (let i = 0; i < count; i++) {
      const l = this.dry[0][this.dryIndex], r = this.dry[1][this.dryIndex];
      this.dry[0][this.dryIndex] = this.inputSamples[i * 2];
      this.dry[1][this.dryIndex] = this.inputSamples[i * 2 + 1];
      this.dryIndex = (this.dryIndex + 1) % this.latencyFrames;
      this.wet += Math.max(-wetStep, Math.min(wetStep, targetWet - this.wet));
      let processedL = this.outputSamples[i * 2], processedR = this.outputSamples[i * 2 + 1];
      if (this.reprimeFade > 0) {
        const previousMix = this.reprimeFade / Math.ceil(sampleRate * 0.02);
        processedL += previousMix * (this.previousSamples[i * 2] - processedL);
        processedR += previousMix * (this.previousSamples[i * 2 + 1] - processedR);
        this.reprimeFade--;
      }
      const mixedL = l + this.wet * (processedL - l), mixedR = r + this.wet * (processedR - r);
      leftOut[i] = Number.isFinite(mixedL) ? mixedL : 0;
      rightOut[i] = Number.isFinite(mixedR) ? mixedR : 0;
    }
    if (this.previousPipe && this.reprimeFade === 0) this.previousPipe = null;
    if (++this.blocks % 200 === 0) this.port.postMessage({ type: "metrics", underruns: this.underruns,
      framesBuffered: this.pipe.outputBuffer.frameCount, latencyFrames: this.latencyFrames, reprimes: this.reprimes });
    return true;
  }
}

registerProcessor("hydra-independent-pitch", HydraIndependentPitch);
