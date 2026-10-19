"use strict";

// Local audio processing only. No audio or configuration leaves the browser.
globalThis.HydraPitch = (() => {
  const registrations = new WeakMap();
  const script = globalThis.document?.currentScript?.src;
  const workletURL = script ? new URL("audio-pitch-worklet.js", script).href : "audio-pitch-worklet.js";
  const PROCESSOR = "hydra-independent-pitch";
  const LATENCY_SECONDS = 0.256;
  const latencyFrames = (context) => Math.ceil(context.sampleRate * LATENCY_SECONDS / 128) * 128;
  const latencySeconds = (context) => latencyFrames(context) / context.sampleRate;

  function register(context) {
    if (!context?.audioWorklet?.addModule || !globalThis.AudioWorkletNode) {
      return Promise.reject(new Error("Independent pitch and speed need AudioWorklet support. Open the dashboard on localhost or HTTPS in a current browser."));
    }
    let pending = registrations.get(context);
    if (!pending) {
      pending = context.audioWorklet.addModule(workletURL).catch((error) => {
        registrations.delete(context);
        throw new Error(`Could not load independent pitch processing: ${error.message || error}`);
      });
      registrations.set(context, pending);
    }
    return pending;
  }

  function create(context, { pitchSemitones = 0, playbackRate = 1 } = {}) {
    const semitones = Number.isFinite(Number(pitchSemitones)) ? Math.max(-24, Math.min(24, Number(pitchSemitones))) : 0;
    const rate = Number.isFinite(Number(playbackRate)) ? Math.max(0.75, Math.min(1.25, Number(playbackRate))) : 1;
    const node = new globalThis.AudioWorkletNode(context, PROCESSOR, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2,
      channelCountMode: "explicit", channelInterpretation: "speakers",
      parameterData: { pitchSemitones: semitones, playbackRate: rate },
      processorOptions: { latencyFrames: latencyFrames(context), pitchSemitones: semitones, playbackRate: rate },
    });
    // Drain diagnostic messages even when the UI does not subscribe to them.
    node.port.start();
    return node;
  }

  return { register, create, latencyFrames, latencySeconds, LATENCY_SECONDS };
})();
