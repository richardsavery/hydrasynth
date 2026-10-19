"use strict";

// Synth destinations share the music mixer's calibrated input buses. This
// adapter evaluates parameter values; audio and MIDI stay with the synth transport.
globalThis.HydraSynthMixerEngine = (() => {
  const MAX_PARAMETERS = 2048;
  const inputs = globalThis.HydraMusicMixerEngine;
  const music = globalThis.HydraSonification;
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const list = (value) => Array.isArray(value) ? value : [];
  const safeId = (value) => typeof value === "string" && /^[^\x00-\x1f]{1,160}$/.test(value);
  const defaults = { pitch: 60, velocity: 96, cutoff: 82, resonance: 42, reverb: 64 };
  const effectValues = { cutoff: 82, resonance: 42, reverb: 64, delay: 64, drive: 24 };
  const previousValues = { cutoff: 100, resonance: 15, reverb: 20, delay: 0, drive: 0 };
  const previousRanges = { cutoff: [5, 124], resonance: [0, 108], reverb: [0, 116], delay: [0, 112], drive: [0, 120] };
  const EFFECT_DEFAULTS_VERSION = 2;
  const curves = ["linear", "smooth", "exponential", "inverse", "steps", "threshold"];
  const integerParameters = new Set(["pitch", "velocity", "voices", "inversion", "spread", "density", "rotation", "ratchet"]);
  const destinations = () => music.DESTINATIONS;

  function defaultParameter(destination, available = destinations()) {
    const definition = typeof destination === "string" ? available.find((item) => item.id === destination) : destination;
    const id = definition?.id || destination;
    const minimum = finite(definition?.min) ? definition.min : 0;
    const maximum = finite(definition?.max) ? definition.max : 127;
    const effect = Object.hasOwn(effectValues, id);
    return { destination: safeId(id) ? id : "pitch", value: clamp((effect ? effectValues[id] : Object.hasOwn(defaults, id) ? defaults[id] : definition?.from) ?? minimum, minimum, maximum),
      busId: "", minimum: effect ? minimum : finite(definition?.from) ? definition.from : minimum,
      maximum: effect ? maximum : finite(definition?.to) ? definition.to : maximum, curve: "linear", invert: false, enabled: true, strength: 1 };
  }

  function defaultConfig() {
    return { mode: "shared", buses: [{ id: "mix-a", name: "Mix A", operator: "average", sources: [
      globalThis.HydraElevenRealtime.validateSource({ sourceKey: "__unassigned", reducer: "mean", rangeMode: "auto" })
    ] }], parameters: Object.keys(defaults).map((id) => defaultParameter(id)),
    controls: music.controls({ ...music.VOICES.find((voice) => voice.id === "warm"), previewVoice: "warm", loop: true }), effectDefaultsVersion: EFFECT_DEFAULTS_VERSION };
  }

  function validateConfig(raw, available = destinations()) {
    const incoming = raw && typeof raw === "object" ? raw : {};
    const base = defaultConfig(), byId = new Map(list(available).map((item) => [item.id, item]));
    const input = inputs.validateConfig({ mode: incoming.mode, buses: incoming.buses ?? base.buses });
    const parameters = new Map();
    for (const rawParameter of list(incoming.parameters ?? base.parameters).slice(0, MAX_PARAMETERS)) {
      if (!rawParameter || !safeId(rawParameter.destination)) continue;
      const definition = byId.get(rawParameter.destination), fallback = defaultParameter(definition || rawParameter.destination, available);
      // Catalog destinations can arrive after stored settings. Preserve their
      // values until the catalog supplies their actual range and availability.
      const low = finite(definition?.min) ? definition.min : -1e12;
      const high = finite(definition?.max) ? definition.max : 1e12;
      const bounded = (value, otherwise) => finite(value) ? clamp(value, low, high) : otherwise;
      const previous = previousRanges[rawParameter.destination];
      const upgrade = incoming.effectDefaultsVersion !== EFFECT_DEFAULTS_VERSION && previous;
      const upgradeRange = upgrade && rawParameter.minimum === previous[0] && rawParameter.maximum === previous[1];
      parameters.set(rawParameter.destination, { destination: rawParameter.destination,
        value: upgradeRange && rawParameter.value === previousValues[rawParameter.destination] ? fallback.value : bounded(rawParameter.value, fallback.value), busId: safeId(rawParameter.busId) ? rawParameter.busId : "",
        minimum: upgradeRange ? fallback.minimum : bounded(rawParameter.minimum, fallback.minimum), maximum: upgradeRange ? fallback.maximum : bounded(rawParameter.maximum, fallback.maximum),
        curve: curves.includes(rawParameter.curve) ? rawParameter.curve : "linear",
        invert: rawParameter.invert === true, enabled: rawParameter.enabled !== false,
        strength: finite(rawParameter.strength) ? clamp(rawParameter.strength, 0, 1) : 1 });
    }
    return { mode: input.mode, buses: input.buses, parameters: [...parameters.values()], effectDefaultsVersion: EFFECT_DEFAULTS_VERSION,
      controls: music.controls({ ...base.controls, ...(incoming.controls || {}) }) };
  }

  function curved(value, curve) {
    if (curve === "inverse") return 1 - value;
    if (curve === "smooth") return value * value * (3 - 2 * value);
    if (curve === "exponential") return value * value;
    if (curve === "steps") return Math.round(value * 4) / 4;
    if (curve === "threshold") return value >= 0.5 ? 1 : 0;
    return value;
  }

  function create({ sourceBridge, getDestinations = destinations, onUpdate = () => {}, onError = () => {} } = {}) {
    let config = validateConfig(defaultConfig(), getDestinations()), inputEngine, inputSnapshot;
    let emitting = false, initializing = true, preparationFailed = false;

    function getConfig() {
      const currentInput = inputEngine?.getConfig();
      return copy(validateConfig({ ...config, ...(currentInput ? { mode: currentInput.mode, buses: currentInput.buses } : {}) }, getDestinations()));
    }
    function parameterStates(output = config.controls.output, options = {}) {
      const definitions = new Map(list(getDestinations()).map((item) => [item.id, item]));
      const buses = new Map(list(inputSnapshot?.buses).map((bus) => [bus.id, bus]));
      const midiFormat = options.midiFormat || config.controls.midiFormat;
      return config.parameters.map((parameter) => {
        const definition = definitions.get(parameter.destination);
        const available = globalThis.HydraParameters?.availability
          ? !globalThis.HydraParameters.availability(definition, { output, midiFormat })
          : Boolean(definition && !definition.unavailable && !(output === "audio" && definition.hardware)
            && !(output === "midi" && midiFormat === "cc" && definition.kind === "nrpn"));
        const bus = buses.get(parameter.busId);
        const mapped = Boolean(parameter.busId) && parameter.strength > 0;
        const valid = available && (!mapped || Boolean(inputSnapshot?.active && bus?.valid && finite(bus.value)));
        let effectiveValue = null;
        if (valid) {
          const normalized = mapped ? curved(parameter.invert ? 1 - clamp(bus.value, 0, 1) : clamp(bus.value, 0, 1), parameter.curve) : null;
          const mappedValue = mapped ? parameter.minimum + normalized * (parameter.maximum - parameter.minimum) : parameter.value;
          const value = !mapped ? parameter.value : parameter.strength === 1 ? mappedValue
            : parameter.value + parameter.strength * (mappedValue - parameter.value);
          effectiveValue = clamp(value, definition.min, definition.max);
          if (definition.discrete || integerParameters.has(definition.id)) effectiveValue = Math.round(effectiveValue);
          if (globalThis.HydraParameters?.logicalValue) effectiveValue = globalThis.HydraParameters.logicalValue(definition, effectiveValue);
          else if (definition.choices?.length) effectiveValue = definition.choices.reduce((best, item) =>
            Math.abs(item.value - effectiveValue) < Math.abs(best.value - effectiveValue) ? item : best).value;
        }
        return { ...parameter, effectiveValue, valid, available };
      });
    }
    function snapshot(output = config.controls.output, options = {}) {
      const parameters = parameterStates(output, options);
      return copy({ active: inputSnapshot?.active || false, fields: inputSnapshot?.fields || [], buses: inputSnapshot?.buses || [],
        sourceLabel: inputSnapshot?.sourceLabel || "Choose an input in Connections", error: inputSnapshot?.error || null,
        sourceValid: parameters.every((parameter) => !parameter.enabled || !parameter.available || parameter.valid),
        parameters, controls: config.controls });
    }
    function emit() {
      // UI persistence may call setConfig synchronously. Its state is accepted,
      // but never recursively delivers another onUpdate in that same call.
      if (initializing || emitting) return;
      emitting = true;
      try { onUpdate(snapshot()); } finally { emitting = false; }
    }
    inputEngine = inputs.create({ sourceBridge, onError(error) { preparationFailed = true; onError(error); },
      onUpdate(state) { inputSnapshot = state; emit(); } });

    function setConfig(incoming) {
      const next = validateConfig(incoming, getDestinations());
      const previousBuses = new Map(list(inputEngine.getConfig().buses).map((bus) => [bus.id, bus]));
      for (const bus of next.buses) bus.sources.forEach((source, index) => {
        const previous = previousBuses.get(bus.id)?.sources[index];
        if (!previous || next.mode !== config.mode || source.rangeMode !== "auto" || previous.rangeMode !== "auto"
          || source.sourceKey !== previous.sourceKey || source.reducer !== previous.reducer || source.index !== previous.index) return;
        // Editing a parameter from an earlier UI snapshot must not discard
        // the input peaks learned since that snapshot was rendered.
        if (finite(previous.learnedMin) && finite(previous.learnedMax)) {
          source.learnedMin = finite(source.learnedMin) ? Math.min(source.learnedMin, previous.learnedMin) : previous.learnedMin;
          source.learnedMax = finite(source.learnedMax) ? Math.max(source.learnedMax, previous.learnedMax) : previous.learnedMax;
        }
      });
      config = next;
      inputEngine.setConfig({ mode: config.mode, buses: config.buses, channels: [inputs.defaultChannel()] });
      return getConfig();
    }
    function evaluate(output = "audio", options = {}) {
      const enabled = parameterStates(output, options).filter((parameter) => parameter.enabled && parameter.available);
      return { values: enabled.filter((parameter) => parameter.valid).map((parameter) => ({ destination: parameter.destination, value: parameter.effectiveValue })),
        valid: enabled.every((parameter) => parameter.valid) };
    }
    function reset() {
      sourceBridge?.reset?.();
      if (inputSnapshot?.active && (preparationFailed || inputSnapshot.error)) {
        // A deliberate Play retries a failed load, while ordinary replay
        // resets keep successfully prepared data and live range registrations.
        preparationFailed = false; inputEngine.deactivate(); inputEngine.activate(); return;
      }
      // Re-read immediately without restarting preparation or changing ranges.
      inputEngine.setConfig(inputEngine.getConfig());
    }
    setConfig(config); initializing = false;
    return { setConfig, getConfig, snapshot, evaluate, reset,
      activate: () => { if (!inputSnapshot?.active) preparationFailed = false; inputEngine.activate(); }, deactivate: () => inputEngine.deactivate(),
      freeze: (busId, sourceIndex) => inputEngine.freeze(busId, sourceIndex),
      relearn: (busId, sourceIndex) => inputEngine.relearn(busId, sourceIndex) };
  }
  return { create, validateConfig, defaultConfig, defaultParameter, MAX_PARAMETERS };
})();
