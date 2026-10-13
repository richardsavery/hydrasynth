"use strict";

// Musical rules and portable session data, shared by the UI and offline tests.
globalThis.HydraSonification = (() => {
  const MAX_MAPPINGS = 32;
  const MAX_TARGETS = 64;
  const MAX_TABS = 12;
  const MAX_PRESETS = 64;
  const DESTINATIONS = [
    { id: "pitch", label: "Pitch", group: "Notes", min: 24, max: 96, from: 42, to: 84 },
    { id: "velocity", label: "Velocity", group: "Notes", min: 1, max: 127, from: 35, to: 120 },
    { id: "voices", label: "Chord voices", group: "Harmony", min: 1, max: 8, from: 2, to: 6 },
    { id: "inversion", label: "Chord inversion", group: "Harmony", min: 0, max: 7, from: 0, to: 3 },
    { id: "spread", label: "Chord spread · octaves", group: "Harmony", min: 0, max: 2, from: 0, to: 2 },
    { id: "sound", label: "Sound palette position · %", group: "Sound", min: 0, max: 100, from: 0, to: 100 },
    { id: "tempo", label: "Tempo · BPM", group: "Rhythm", min: 20, max: 240, from: 72, to: 156 },
    { id: "density", label: "Hits per 16 steps", group: "Rhythm", min: 0, max: 16, from: 3, to: 13 },
    { id: "rotation", label: "Pattern rotation · steps", group: "Rhythm", min: 0, max: 15, from: 0, to: 7 },
    { id: "ratchet", label: "Note repeats · per step", group: "Rhythm", min: 1, max: 4, from: 1, to: 4 },
    { id: "swing", label: "Swing · %", group: "Rhythm", min: 0, max: 65, from: 0, to: 60 },
    { id: "accent", label: "Accent strength · %", group: "Rhythm", min: 0, max: 100, from: 15, to: 90 },
    { id: "gate", label: "Gate length · %", group: "Rhythm", min: 5, max: 100, from: 12, to: 92 },
    { id: "chance", label: "Note chance · %", group: "Rhythm", min: 0, max: 100, from: 55, to: 100 },
    { id: "cutoff", label: "Filter cutoff", group: "Timbre", cc: 74, min: 0, max: 127, from: 5, to: 124 },
    { id: "resonance", label: "Filter resonance", group: "Timbre", cc: 71, min: 0, max: 127, from: 0, to: 108 },
    { id: "drive", label: "Filter drive", group: "Timbre", cc: 50, min: 0, max: 127, from: 0, to: 120 },
    { id: "delay", label: "Delay mix", group: "Effects", cc: 92, min: 0, max: 127, from: 0, to: 112 },
    { id: "reverb", label: "Reverb mix", group: "Effects", cc: 91, min: 0, max: 127, from: 0, to: 116 },
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `macro${index + 1}`, label: `Macro ${index + 1}`, group: "Macros",
      cc: 16 + index, min: 0, max: 127, from: 0, to: 127
    }))
  ];
  const DEFAULT_CONTROLS = {
    tempo: 96, stepsPerBeat: 2, waveType: "triangle", attack: 8, release: 38,
    brightness: 64, scaleRoot: "C", scaleName: "minor-pentatonic",
    density: 16, rotation: 0, ratchet: 1, swing: 0, accent: 35, loop: false,
    voices: 3, voicing: "thirds", inversion: 0, spread: 0, previewVoice: "custom",
    soundMode: "off", soundEvery: 32, patchPool: "all",
    patchList: "A001, A017, B001, C001", patchBank: "A", patchNumber: 1, midiFormat: "nrpn", midiRate: 50
  };
  const ROOTS = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const SCALES = ["minor-pentatonic", "major-pentatonic", "minor", "major", "chromatic"];
  const SCALE_INTERVALS = {
    "minor-pentatonic": [0, 3, 5, 7, 10], "major-pentatonic": [0, 2, 4, 7, 9],
    minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11],
    chromatic: Array.from({ length: 12 }, (_, i) => i)
  };
  const VOICES = [
    { id: "glass", name: "Glass", waveType: "sine", attack: 1, release: 65, brightness: 90, harmonic: 0.28, ratio: 3 },
    { id: "pluck", name: "Pluck", waveType: "triangle", attack: 0, release: 8, brightness: 80, decay: true },
    { id: "warm", name: "Warm pad", waveType: "sawtooth", attack: 35, release: 90, brightness: 42 },
    { id: "reed", name: "Reed", waveType: "square", attack: 4, release: 24, brightness: 60 },
    { id: "bell", name: "Bell", waveType: "sine", attack: 0, release: 95, brightness: 100, harmonic: 0.6, ratio: 2.76, decay: true },
    { id: "bass", name: "Soft bass", waveType: "triangle", attack: 1, release: 12, brightness: 28, octave: -1 }
  ];
  const OPERATORS = ["direct", "average", "weighted", "sum", "difference", "minimum", "maximum"];
  const CURVES = ["linear", "smooth", "exponential", "inverse", "steps", "threshold"];
  const bounded = (value, min, max, fallback = min) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const name = (value, fallback) => typeof value === "string" && value.trim()
    ? value.trim().slice(0, 60) : fallback;

  function controls(raw = {}) {
    const input = raw && typeof raw === "object" ? raw : {};
    const result = { ...DEFAULT_CONTROLS };
    const ranges = { tempo: [20, 240], attack: [0, 100], release: [5, 100], brightness: [0, 100],
      density: [0, 16], rotation: [0, 15], ratchet: [1, 4], swing: [0, 65], accent: [0, 100],
      voices: [1, 8], inversion: [0, 7], spread: [0, 2], patchNumber: [1, 128] };
    Object.entries(ranges).forEach(([key, [min, max]]) => {
      result[key] = bounded(input[key] ?? result[key], min, max, result[key]);
    });
    result.stepsPerBeat = [1, 2, 4, 8].includes(Number(input.stepsPerBeat)) ? Number(input.stepsPerBeat) : 2;
    result.waveType = ["sine", "triangle", "sawtooth", "square"].includes(input.waveType) ? input.waveType : "triangle";
    result.scaleRoot = ROOTS.includes(input.scaleRoot) ? input.scaleRoot : "C";
    result.scaleName = SCALES.includes(input.scaleName) ? input.scaleName : "minor-pentatonic";
    result.loop = input.loop === true;
    for (const [key, allowed] of Object.entries({ voicing: ["thirds", "fourths", "octaves"],
      previewVoice: ["custom", ...VOICES.map((voice) => voice.id)], soundMode: ["off", "cycle", "random", "mapped"],
      midiFormat: ["nrpn", "cc"], patchPool: ["shortlist", "all"], patchBank: [..."ABCDEFGH"] })) {
      if (allowed.includes(input[key])) result[key] = input[key];
    }
    result.midiRate = [25, 50, 100].includes(Number(input.midiRate)) ? Number(input.midiRate) : 50;
    result.soundEvery = [16, 32, 64, 128].includes(Number(input.soundEvery)) ? Number(input.soundEvery) : 32;
    if (typeof input.patchList === "string") result.patchList = input.patchList.slice(0, 512);
    result.output = ["audio", "midi", "drums"].includes(input.output) ? input.output : "audio";
    if (globalThis.HydraDrums) Object.assign(result, globalThis.HydraDrums.settings(input));
    return result;
  }

  function restoreMappings(raw, fields, allocateId, { allowMissing = false } = {}) {
    if (!Array.isArray(raw)) return [];
    const byKey = new Map(fields.map((field) => [field.key, field]));
    return raw.slice(0, MAX_MAPPINGS).flatMap((mapping) => {
      if (!mapping || typeof mapping !== "object") return [];
      const targets = mappingTargets(mapping).slice(0, MAX_TARGETS).flatMap((target) => {
        if (!target || typeof target !== "object") return [];
        const destination = DESTINATIONS.find((item) => item.id === target.destination);
        if (!destination) return [];
        return [{ destination: destination.id, enabled: target.enabled !== false,
          curve: CURVES.includes(target.curve) ? target.curve : CURVES.includes(mapping.curve) ? mapping.curve : "linear",
          minimum: bounded(target.minimum ?? destination.from, destination.min, destination.max, destination.from),
          maximum: bounded(target.maximum ?? destination.to, destination.min, destination.max, destination.to) }];
      });
      if (!targets.length) return [];
      const rawSources = Array.isArray(mapping.sources) ? mapping.sources : [{ ...mapping, weight: 1 }];
      // A recipe is kept intact or omitted; never silently change its ingredients.
      if (!rawSources.length || rawSources.some((source) => !source || typeof source.sourceKey !== "string" || (!allowMissing && !byKey.has(source.sourceKey)))) return [];
      const sources = rawSources.slice(0, 6).map((source) => {
        const field = byKey.get(source.sourceKey) || { key: source.sourceKey,
          reducers: ["value", "mean", "rms", "minimum", "maximum", "index"], default_reducer: "mean" };
        return { sourceKey: field.key,
          reducer: field.reducers.includes(source.reducer) ? source.reducer : field.default_reducer,
          index: Math.round(bounded(source.index ?? 0, 0, 1_000_000)),
          weight: bounded(source.weight ?? 1, 0, 10, 1),
          rangeMode: source.rangeMode === "fixed" ? "fixed" : "auto",
          inputMin: bounded(source.inputMin ?? -1, -1e12, 1e12, -1),
          inputMax: bounded(source.inputMax ?? 1, -1e12, 1e12, 1) };
      });
      return [{ id: allocateId(), sources,
        operator: sources.length === 1 ? "direct" : OPERATORS.includes(mapping.operator) ? mapping.operator : "average",
        ...targets[0], ...(Array.isArray(mapping.targets) ? { targets } : {}) }];
    });
  }

  function mappingTargets(mapping) {
    return Array.isArray(mapping.targets) ? mapping.targets : [mapping];
  }

  function targetCount(mappings) {
    return mappings.reduce((count, mapping) => count + mappingTargets(mapping).length, 0);
  }

  function serializeTab(tab) {
    return { name: name(tab.name, "Untitled"), controls: controls(tab.controls),
      mappings: tab.mappings.slice(0, MAX_MAPPINGS).map(({ id, ...mapping }) => copy(mapping)) };
  }

  function restoreWorkspace(saved, recordingId, fields, allocateId, defaultMappings) {
    const workspace = saved.workspaces?.[recordingId];
    const legacy = saved.mappingsByRecording?.[recordingId];
    const rawTabs = Array.isArray(workspace?.tabs) && workspace.tabs.length
      ? workspace.tabs.slice(0, MAX_TABS)
      : [{ name: "Original", controls: saved.controls,
          mappings: Array.isArray(legacy) ? legacy : defaultMappings() }];
    const tabs = rawTabs.map((raw) => ({
      id: allocateId(), name: name(raw?.name, "Untitled"),
      controls: controls(raw?.controls), mappings: restoreMappings(raw?.mappings, fields, allocateId, { allowMissing: recordingId.startsWith("live:") })
    }));
    const activeIndex = Math.round(bounded(workspace?.activeIndex ?? 0, 0, tabs.length - 1));
    return { tabs, activeIndex };
  }

  function randomMappings(fields, count = 12, style = "balanced", random = Math.random) {
    if (!fields.length) return [];
    const pick = (items) => items[Math.min(items.length - 1, Math.floor(random() * items.length))];
    const shuffle = (items) => {
      const result = [...items];
      for (let i = result.length - 1; i > 0; i--) {
        const j = Math.min(i, Math.floor(random() * (i + 1)));
        [result[i], result[j]] = [result[j], result[i]];
      }
      return result;
    };
    const core = style === "rhythmic"
      ? ["pitch", "density", "ratchet", "gate", "accent", "swing", "velocity", "cutoff"]
      : ["pitch", "density", "gate", "velocity", "cutoff", "drive", "delay", "reverb"];
    core.push("voices", "sound");
    const remaining = shuffle(DESTINATIONS.slice(0, 27).filter((item) => !core.includes(item.id)).map((item) => item.id));
    const targets = [...core, ...remaining].slice(0, Math.round(bounded(count, 4, 27, 12)));
    const shuffledFields = shuffle(fields);
    return targets.map((target, index) => {
      const destination = DESTINATIONS.find((item) => item.id === target);
      const field = shuffledFields[index % shuffledFields.length];
      const inputFields = [field];
      if (fields.length > 1 && random() < (style === "wild" ? 0.65 : 0.3)) {
        inputFields.push(pick(fields.filter((candidate) => candidate.key !== field.key)));
      }
      const sources = inputFields.map((input) => ({ sourceKey: input.key,
        reducer: pick(input.reducers.filter((reducer) => reducer !== "index")), index: 0,
        weight: pick([0.5, 1, 2, 3]), rangeMode: "auto", inputMin: -1, inputMax: 1 }));
      let minimum = destination.from;
      let maximum = destination.to;
      if (target === "pitch") { minimum = pick([36, 42, 48]); maximum = pick([72, 84, 96]); }
      if (target === "chance") minimum = style === "wild" ? 30 : 70;
      if (target === "tempo") { minimum = style === "wild" ? 55 : 80; maximum = style === "wild" ? 210 : 140; }
      const curve = pick(style === "wild" ? CURVES : ["linear", "smooth", "inverse", "steps"]);
      return { sources, operator: sources.length === 1 ? "direct" : pick(["average", "weighted", "difference", "maximum"]),
        destination: target, minimum, maximum, curve };
    });
  }

  function rhythmPattern(density = 16, rotation = 0) {
    const hits = Math.round(bounded(density, 0, 16, 16));
    const shift = Math.round(bounded(rotation, 0, 15));
    return Array.from({ length: 16 }, (_, step) => ((step - shift + 16) % 16 * hits) % 16 < hits);
  }

  function chordNotes(pitch, raw = {}) {
    const settings = controls(raw);
    const scale = SCALE_INTERVALS[settings.scaleName];
    const root = ROOTS.indexOf(settings.scaleRoot);
    const atDegree = (degree) => root + Math.floor(degree / scale.length) * 12
      + scale[(degree % scale.length + scale.length) % scale.length];
    const target = bounded(pitch, 0, 127, 60);
    let degree = 0;
    for (let i = -scale.length; atDegree(i) <= 139; i++) {
      if (Math.abs(atDegree(i) - target) < Math.abs(atDegree(degree) - target)) degree = i;
    }
    const count = Math.round(settings.voices);
    const stride = settings.voicing === "octaves" ? scale.length : settings.voicing === "fourths" ? 3 : 2;
    let notes = Array.from({ length: count }, (_, index) => atDegree(degree + index * stride));
    for (let i = 0; i < Math.round(settings.inversion) % count; i++) {
      const lowest = notes.shift();
      notes.push(lowest + 12 * Math.ceil((notes.at(-1) + 1 - lowest) / 12));
    }
    notes = notes.map((note, index) => note + (index % 2) * Math.round(settings.spread) * 12);
    const unique = new Set();
    notes = notes.map((note) => { while (unique.has(note)) note += 12; unique.add(note); return note; }).sort((a, b) => a - b);
    // Keep the whole voicing in MIDI range, preserving pitch classes and intervals.
    while (notes.at(-1) > 127) notes = notes.map((note) => note - 12);
    while (notes[0] < 0) notes = notes.map((note) => note + 12);
    return notes;
  }

  function patchPool(settings) {
    if (settings.patchPool === "all") return Array.from({ length: 1024 }, (_, i) => ({ bank: "ABCDEFGH"[Math.floor(i / 128)], number: i % 128 + 1 }));
    const tokens = String(settings.patchList || "").trim().split(/[\s,;]+/).filter(Boolean);
    if (!tokens.length || tokens.length > 32) throw new Error("Enter 1–32 patch locations, such as A001, B017, C128.");
    const seen = new Set();
    return tokens.flatMap((token) => {
      const match = /^([A-H])0*(\d{1,3})$/i.exec(token);
      if (!match || Number(match[2]) < 1 || Number(match[2]) > 128) throw new Error(`Invalid patch “${token}”. Use A–H and 001–128.`);
      const patch = { bank: match[1].toUpperCase(), number: Number(match[2]) };
      const key = patch.bank + patch.number;
      if (seen.has(key)) return [];
      seen.add(key);
      return [patch];
    });
  }

  function soundIndex(mode, length, previous = -1, value = 0, random = Math.random) {
    if (mode === "mapped") return Math.min(length - 1, Math.floor(bounded(value, 0, 100) / 100 * length));
    if (mode === "random" && length > 1) {
      const skip = previous >= 0 && previous < length;
      const index = Math.min(length - (skip ? 2 : 1), Math.floor(random() * (length - (skip ? 1 : 0))));
      return skip && index >= previous ? index + 1 : index;
    }
    return (previous + 1) % length;
  }

  function rhythmStep(values, step, random = Math.random) {
    const tempo = bounded(values.tempo, 20, 240, 96);
    const subdivision = bounded(values.stepsPerBeat, 1, 8, 2);
    const swing = bounded(values.swing, 0, 65) / 100;
    const interval = 60000 / tempo / subdivision * (step % 2 === 0 ? 1 + swing : 1 - swing);
    const pattern = rhythmPattern(values.density, values.rotation);
    const repeats = Math.round(bounded(values.ratchet, 1, 4, 1));
    const chance = bounded(values.chance ?? 100, 0, 100, 100);
    const active = pattern[step % 16] && chance > 0 && random() < chance / 100;
    const spacing = interval / repeats;
    const accent = bounded(values.accent, 0, 100) / 100;
    const beat = step % Math.max(1, Math.round(subdivision)) === 0;
    const notes = active ? Array.from({ length: repeats }, (_, repeat) => ({
      offset: repeat * spacing,
      duration: Math.max(2, Math.min(spacing * 0.94, spacing * bounded(values.gate, 5, 100, 66) / 100)),
      velocity: Math.round(bounded(values.velocity, 1, 127, 96) * (beat ? 1 : 1 - accent * 0.65) * (repeat ? 0.82 : 1)) || 1
    })) : [];
    return { interval, pattern, notes, tempo, repeats };
  }

  function parsePresetFile(raw) {
    if (!raw || raw.format !== "hydra-signal-lab-presets" || raw.version !== 1 || !Array.isArray(raw.presets)) {
      throw new Error("Choose a Hydra Signal Lab preset export (version 1).");
    }
    if (raw.presets.length > MAX_PRESETS) throw new Error(`A preset file can contain at most ${MAX_PRESETS} presets.`);
    return raw.presets.map((preset) => {
      if (!preset || !Array.isArray(preset.mappings) || preset.mappings.length > MAX_MAPPINGS) {
        throw new Error("This preset file contains an invalid mapping set.");
      }
      if (preset.mappings.some((mapping) => !mapping || (mapping.targets !== undefined &&
          (!Array.isArray(mapping.targets) || !mapping.targets.length || mapping.targets.length > MAX_TARGETS)))) {
        throw new Error(`Each input recipe supports 1 to ${MAX_TARGETS} destinations.`);
      }
      return { ...serializeTab(preset), recording: name(preset.recording, "Imported") };
    });
  }

  return { DESTINATIONS, DEFAULT_CONTROLS, MAX_MAPPINGS, MAX_TARGETS, MAX_TABS, MAX_PRESETS, VOICES, SCALE_INTERVALS,
    mappingTargets, targetCount,
    controls, chordNotes, patchPool, soundIndex,
    restoreMappings, serializeTab, restoreWorkspace, randomMappings, rhythmPattern, rhythmStep, parsePresetFile };
})();
