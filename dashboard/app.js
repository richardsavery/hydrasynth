"use strict";

const SERIES_LIMIT = 720;
const SETTINGS_KEY = "hydra-signal-lab-v1";
const MIDI_CHANNEL = 0;
const MAX_MAPPING_SOURCES = 6;
const COMBINE_OPERATORS = new Set([
  "direct", "average", "weighted", "sum", "difference", "minimum", "maximum"
]);

const DESTINATIONS = [
  { id: "pitch", label: "Pitch", group: "Notes", min: 24, max: 96, from: 48, to: 84 },
  { id: "velocity", label: "Velocity", group: "Notes", min: 1, max: 127, from: 48, to: 116 },
  { id: "gate", label: "Gate length", group: "Rhythm", min: 5, max: 100, from: 30, to: 88 },
  { id: "chance", label: "Note chance", group: "Rhythm", min: 0, max: 100, from: 45, to: 100 },
  { id: "cutoff", label: "Filter cutoff", group: "Hydrasynth timbre", cc: 74, min: 0, max: 127, from: 18, to: 110 },
  { id: "resonance", label: "Filter resonance", group: "Hydrasynth timbre", cc: 71, min: 0, max: 127, from: 5, to: 88 },
  { id: "drive", label: "Filter drive", group: "Hydrasynth timbre", cc: 50, min: 0, max: 127, from: 0, to: 72 },
  { id: "delay", label: "Delay mix", group: "Hydrasynth effects", cc: 92, min: 0, max: 127, from: 0, to: 70 },
  { id: "reverb", label: "Reverb mix", group: "Hydrasynth effects", cc: 93, min: 0, max: 127, from: 8, to: 82 },
  ...Array.from({ length: 8 }, (_value, index) => ({
    id: `macro${index + 1}`,
    label: `Macro ${index + 1}`,
    group: "Hydrasynth macros",
    cc: 16 + index,
    min: 0,
    max: 127,
    from: 0,
    to: 127
  }))
];

const SCALE_INTERVALS = {
  "minor-pentatonic": [0, 3, 5, 7, 10],
  "major-pentatonic": [0, 2, 4, 7, 9],
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

const state = {
  library: null,
  recording: null,
  fields: [],
  fieldIndex: new Map(),
  mappings: [],
  nextMappingId: 1,
  seriesCache: new Map(),
  focusedMappingId: null,
  playing: false,
  playTimer: null,
  cursor: 0,
  maxSteps: SERIES_LIMIT,
  output: "audio",
  audio: null,
  midiAccess: null,
  midiOutput: null,
  midiNoteTimers: new Map(),
  activityPending: false,
  activityQueued: null,
  saved: loadSavedSettings()
};

const dom = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheDom();
  bindInterface();
  bindDashboardSwitcher();
  applySavedControls();
  renderScale();
  updateClock();
  window.setInterval(updateClock, 1000);
  loadRecordings(false);
});

function bindDashboardSwitcher() {
  const openLink = document.querySelector("[data-open-observer]");
  const overlay = document.getElementById("observer-overlay");
  const frame = document.getElementById("observer-frame");
  const closeButton = document.getElementById("close-observer");
  if (!openLink || !overlay || !frame || !closeButton) return;

  const closeObserver = () => {
    overlay.hidden = true;
    document.body.classList.remove("observer-overlay-open");
    openLink.focus();
  };
  openLink.addEventListener("click", (event) => {
    event.preventDefault();
    if (!frame.src) frame.src = frame.dataset.src || "/observer/?embedded=1";
    overlay.hidden = false;
    document.body.classList.add("observer-overlay-open");
    closeButton.focus();
  });
  closeButton.addEventListener("click", closeObserver);
  window.addEventListener("message", (event) => {
    if (
      event.origin === window.location.origin &&
      event.data?.type === "hydra-close-observer"
    ) {
      closeObserver();
    }
  });
}

function cacheDom() {
  [
    "engine-state", "refresh-recordings", "recording-list", "recording-empty",
    "source-summary", "source-channel", "source-field", "recordings-path",
    "recording-title", "recording-detail", "tempo", "steps-per-beat",
    "preview-button", "signal-title", "signal-min", "signal-max", "waveform",
    "signal-area", "signal-line", "playhead", "wave-empty", "wave-progress",
    "add-mapping", "mapping-rows", "mapping-help", "wave-type", "voice-name",
    "attack", "attack-output", "release", "release-output", "brightness",
    "brightness-output", "scale-copy", "scale-root", "scale-name", "piano-roll",
    "midi-panel", "midi-output", "midi-status", "midi-choice-detail",
    "connect-midi", "panic-button", "recording-link-status", "footer-clock",
    "session-state", "mapping-template", "mapping-source-template", "toast"
  ].forEach((id) => { dom[id] = document.getElementById(id); });
  dom.outputButtons = Array.from(document.querySelectorAll("[data-output]"));
}

function bindInterface() {
  dom["refresh-recordings"].addEventListener("click", () => loadRecordings(true));
  dom["preview-button"].addEventListener("click", togglePlayback);
  dom["add-mapping"].addEventListener("click", () => {
    if (!state.fields.length) return;
    const usedDestinations = new Set(state.mappings.map((mapping) => mapping.destination));
    const destination = DESTINATIONS.find((item) => !usedDestinations.has(item.id)) || DESTINATIONS[0];
    state.mappings.push(createMapping(state.fields[state.mappings.length % state.fields.length], destination.id));
    state.focusedMappingId = state.mappings[state.mappings.length - 1].id;
    renderMappings();
    loadFocusedSeries();
    saveSettings();
  });
  dom.outputButtons.forEach((button) => button.addEventListener("click", () => setOutput(button.dataset.output)));
  dom["connect-midi"].addEventListener("click", connectMidi);
  dom["midi-output"].addEventListener("change", selectMidiOutput);
  dom["panic-button"].addEventListener("click", () => {
    stopPlayback();
    panicMidi();
    showToast("All MIDI notes stopped");
  });
  ["tempo", "steps-per-beat", "wave-type", "attack", "release", "brightness", "scale-root", "scale-name"].forEach((id) => {
    dom[id].addEventListener("input", () => {
      updateControlReadouts();
      renderScale();
      saveSettings();
      if (state.playing && ["tempo", "steps-per-beat"].includes(id)) {
        window.clearTimeout(state.playTimer);
        scheduleNextTick();
      }
    });
  });
  dom["waveform"].addEventListener("pointerdown", seekFromPointer);
  dom["waveform"].addEventListener("keydown", (event) => {
    if (!state.recording) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      state.cursor = clamp(state.cursor + (event.key === "ArrowLeft" ? -1 : 1), 0, state.maxSteps - 1);
      updatePlayhead();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.playing) stopPlayback();
    if (event.code === "Space" && !isEditable(event.target)) {
      event.preventDefault();
      togglePlayback();
    }
  });
  window.addEventListener("beforeunload", () => panicMidi());
}

async function loadRecordings(refresh) {
  dom["recording-list"].setAttribute("aria-busy", "true");
  setEngineState("pending", "Reading recordings", "Indexing JSONL channels and fields");
  try {
    const response = await fetch(`/api/recordings${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Recording index returned ${response.status}`);
    state.library = await response.json();
    renderRecordingList();
    if (!state.library.available || !state.library.recordings.length) {
      setEngineState("warning", "Preview engine ready", "Link a recordings folder to begin");
      return;
    }
    const preferredId = state.recording?.id || state.saved.lastRecording || state.library.recordings[0].id;
    const preferred = state.library.recordings.find((item) => item.id === preferredId) || state.library.recordings[0];
    await selectRecording(preferred.id);
    setEngineState("ready", "Preview engine ready", `${state.library.recordings.length} recordings · browser audio available`);
  } catch (error) {
    renderRecordingError(error instanceof Error ? error.message : "Unable to load recordings");
    setEngineState("error", "Recording link unavailable", "The dashboard is still available");
  } finally {
    dom["recording-list"].setAttribute("aria-busy", "false");
  }
}

function renderRecordingList() {
  const library = state.library || { available: false, recordings: [] };
  dom["recording-list"].replaceChildren();
  dom["recording-empty"].hidden = library.available && library.recordings.length > 0;
  dom["recordings-path"].textContent = library.directory || "No directory configured";
  dom["recordings-path"].title = library.directory || "";
  dom["recording-link-status"].innerHTML = library.available
    ? `<i class="status-light"></i> ${library.recordings.length} RAPP recording${library.recordings.length === 1 ? "" : "s"} linked`
    : `<i class="status-light is-warning"></i> RAPP folder not linked`;
  library.recordings.forEach((recording) => {
    const button = document.createElement("button");
    button.className = `recording${state.recording?.id === recording.id ? " is-selected" : ""}`;
    button.type = "button";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(state.recording?.id === recording.id));
    const copy = document.createElement("span");
    const title = document.createElement("b");
    const detail = document.createElement("small");
    const duration = document.createElement("i");
    title.textContent = recording.name;
    detail.textContent = `${recording.channels.length} channel${recording.channels.length === 1 ? "" : "s"} · ${formatInteger(recording.frames)} frames`;
    duration.textContent = formatDuration(recording.duration_seconds);
    copy.append(title, detail);
    button.append(copy, duration);
    button.addEventListener("click", () => selectRecording(recording.id));
    dom["recording-list"].append(button);
  });
}

function renderRecordingError(message) {
  dom["recording-list"].replaceChildren();
  dom["recording-empty"].hidden = false;
  dom["recording-empty"].querySelector("b").textContent = "Could not read recordings";
  dom["recording-empty"].querySelector("p").textContent = message;
}

async function selectRecording(recordingId) {
  if (state.playing) stopPlayback();
  const recording = state.library?.recordings.find((item) => item.id === recordingId);
  if (!recording) return;
  state.recording = recording;
  state.cursor = 0;
  state.fields = fieldsForRecording(recording);
  state.fieldIndex = new Map(state.fields.map((field) => [field.key, field]));
  state.seriesCache.clear();
  state.saved.lastRecording = recording.id;
  state.mappings = restoreMappings(recording.id) || createDefaultMappings();
  state.focusedMappingId = state.mappings[0]?.id || null;
  dom["recording-title"].textContent = recording.name;
  dom["recording-detail"].textContent = `${formatInteger(recording.frames)} JSON frames · ${recording.channels.length} channels · ${formatBytes(recording.size_bytes)}`;
  dom["preview-button"].disabled = !state.fields.length;
  dom["add-mapping"].disabled = !state.fields.length;
  renderRecordingList();
  renderMappings();
  saveSettings();
  await loadFocusedSeries();
}

function restoreMappings(recordingId) {
  const savedMappings = state.saved.mappingsByRecording?.[recordingId];
  if (!Array.isArray(savedMappings)) return null;
  const restored = savedMappings
    .filter((mapping) => mapping && destinationFor(mapping.destination))
    .slice(0, 12)
    .map((mapping) => {
      const destination = destinationFor(mapping.destination);
      const rawSources = Array.isArray(mapping.sources)
        ? mapping.sources
        : [{
            sourceKey: mapping.sourceKey,
            reducer: mapping.reducer,
            index: mapping.index,
            weight: 1
          }];
      const sources = rawSources
        .filter((source) => source && state.fieldIndex.has(source.sourceKey))
        .slice(0, MAX_MAPPING_SOURCES)
        .map((source) => restoreMappingSource(source));
      if (!sources.length) return null;
      const requestedOperator = COMBINE_OPERATORS.has(mapping.operator)
        ? mapping.operator
        : sources.length > 1 ? "average" : "direct";
      return {
        id: state.nextMappingId++,
        sources,
        operator: sources.length === 1 ? "direct" : requestedOperator,
        curve: ["linear", "smooth", "exponential", "inverse"].includes(mapping.curve) ? mapping.curve : "linear",
        destination: destination.id,
        minimum: clamp(Number(mapping.minimum), destination.min, destination.max),
        maximum: clamp(Number(mapping.maximum), destination.min, destination.max)
      };
    })
    .filter(Boolean);
  return restored.length ? restored : null;
}

function restoreMappingSource(source) {
  const field = state.fieldIndex.get(source.sourceKey);
  return {
    sourceKey: field.key,
    reducer: field.reducers.includes(source.reducer) ? source.reducer : field.default_reducer,
    index: clamp(Number(source.index) || 0, 0, 1_000_000),
    weight: clamp(Number(source.weight) || 1, 0, 10)
  };
}

function fieldsForRecording(recording) {
  return recording.channels.flatMap((channel) => channel.fields.map((field) => ({
    ...field,
    key: `${encodeURIComponent(channel.id)}|${encodeURIComponent(field.id)}`,
    channelId: channel.id,
    channelName: channel.name,
    fieldId: field.id,
    optionLabel: `${channel.name} / ${field.name}`
  })));
}

function createDefaultMappings() {
  if (!state.fields.length) return [];
  const findField = (...terms) => state.fields.find((field) => {
    const haystack = `${field.channelId} ${field.fieldId} ${field.name}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  const pitchField = findField("activation_energy", "encoder_out_norm") || findField("position") || state.fields[0];
  const cutoffField = findField("robot_joint_states", "velocity:1") || findField("velocity") || state.fields[1] || pitchField;
  const reverbField = findField("attn_entropy") || state.fields[2] || pitchField;
  return [
    createMapping(pitchField, "pitch"),
    createMapping(cutoffField, "cutoff", "smooth"),
    createMapping(reverbField, "reverb", "inverse")
  ];
}

function createMapping(field, destinationId, curve = "linear") {
  const destination = destinationFor(destinationId) || DESTINATIONS[0];
  return {
    id: state.nextMappingId++,
    sources: [createMappingSource(field)],
    operator: "direct",
    curve,
    destination: destination.id,
    minimum: destination.from,
    maximum: destination.to
  };
}

function createMappingSource(field) {
  return {
    sourceKey: field.key,
    reducer: field.default_reducer,
    index: 0,
    weight: 1
  };
}

function renderMappings() {
  dom["mapping-rows"].replaceChildren();
  if (!state.mappings.length) {
    const placeholder = document.createElement("div");
    placeholder.className = "mapping-placeholder";
    placeholder.textContent = "Add a mapping to turn a signal into sound.";
    dom["mapping-rows"].append(placeholder);
    clearWaveform();
    return;
  }
  state.mappings.forEach((mapping) => {
    const fragment = dom["mapping-template"].content.cloneNode(true);
    const row = fragment.querySelector(".mapping-row");
    const sourcesContainer = fragment.querySelector('[data-role="sources"]');
    const operatorSelect = fragment.querySelector('[data-role="operator"]');
    const addSourceButton = fragment.querySelector('[data-role="add-source"]');
    const curveSelect = fragment.querySelector('[data-role="curve"]');
    const destinationSelect = fragment.querySelector('[data-role="destination"]');
    const minimumInput = fragment.querySelector('[data-role="minimum"]');
    const maximumInput = fragment.querySelector('[data-role="maximum"]');
    const removeButton = fragment.querySelector('[data-role="remove"]');
    row.dataset.mappingId = String(mapping.id);
    row.classList.toggle("is-focused", mapping.id === state.focusedMappingId);
    operatorSelect.value = mapping.sources.length === 1 ? "direct" : mapping.operator;
    operatorSelect.disabled = mapping.sources.length === 1;
    addSourceButton.disabled = mapping.sources.length >= MAX_MAPPING_SOURCES;
    mapping.sources.forEach((source, sourceIndex) => {
      sourcesContainer.append(renderMappingSource(mapping, source, sourceIndex));
    });
    curveSelect.value = mapping.curve;
    appendGroupedOptions(destinationSelect, DESTINATIONS, "group", "id", "label");
    destinationSelect.value = mapping.destination;
    configureRangeInput(minimumInput, mapping, "minimum");
    configureRangeInput(maximumInput, mapping, "maximum");

    row.addEventListener("pointerdown", () => focusMapping(mapping.id));
    operatorSelect.addEventListener("change", () => {
      mapping.operator = COMBINE_OPERATORS.has(operatorSelect.value)
        ? operatorSelect.value
        : "average";
      mappingChanged(mapping, true);
    });
    addSourceButton.addEventListener("click", () => {
      if (mapping.sources.length >= MAX_MAPPING_SOURCES) return;
      const field = state.fields[(mapping.sources.length + state.mappings.indexOf(mapping)) % state.fields.length];
      mapping.sources.push(createMappingSource(field));
      if (mapping.operator === "direct") mapping.operator = "average";
      mappingChanged(mapping, true);
    });
    curveSelect.addEventListener("change", () => {
      mapping.curve = curveSelect.value;
      mappingChanged(mapping, false);
    });
    destinationSelect.addEventListener("change", () => {
      mapping.destination = destinationSelect.value;
      const destination = destinationFor(mapping.destination);
      mapping.minimum = destination.from;
      mapping.maximum = destination.to;
      mappingChanged(mapping, false);
    });
    minimumInput.addEventListener("change", () => {
      const destination = destinationFor(mapping.destination);
      mapping.minimum = clamp(Number(minimumInput.value), destination.min, destination.max);
      mappingChanged(mapping, false);
    });
    maximumInput.addEventListener("change", () => {
      const destination = destinationFor(mapping.destination);
      mapping.maximum = clamp(Number(maximumInput.value), destination.min, destination.max);
      mappingChanged(mapping, false);
    });
    removeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      state.mappings = state.mappings.filter((candidate) => candidate.id !== mapping.id);
      if (state.focusedMappingId === mapping.id) state.focusedMappingId = state.mappings[0]?.id || null;
      renderMappings();
      loadFocusedSeries();
      saveSettings();
    });
    dom["mapping-rows"].append(fragment);
  });
}

function renderMappingSource(mapping, source, sourceIndex) {
  const fragment = dom["mapping-source-template"].content.cloneNode(true);
  const sourceRow = fragment.querySelector(".mapping-source");
  const sourceNumber = fragment.querySelector('[data-role="source-number"]');
  const sourceSelect = fragment.querySelector('[data-role="source"]');
  const reducerSelect = fragment.querySelector('[data-role="reducer"]');
  const indexControl = fragment.querySelector(".index-control");
  const indexInput = fragment.querySelector('[data-role="index"]');
  const weightControl = fragment.querySelector(".weight-control");
  const weightInput = fragment.querySelector('[data-role="weight"]');
  const removeSourceButton = fragment.querySelector('[data-role="remove-source"]');
  sourceNumber.textContent = String(sourceIndex + 1);
  appendGroupedOptions(sourceSelect, state.fields, "channelName", "key", "optionLabel");
  sourceSelect.value = source.sourceKey;
  const field = state.fieldIndex.get(source.sourceKey) || state.fields[0];
  field.reducers.forEach((reducer) => reducerSelect.add(new Option(reducerLabel(reducer), reducer)));
  reducerSelect.value = source.reducer;
  indexControl.hidden = source.reducer !== "index";
  indexInput.value = String(source.index);
  weightControl.hidden = mapping.operator !== "weighted";
  weightInput.value = String(source.weight);
  removeSourceButton.disabled = mapping.sources.length === 1;
  removeSourceButton.setAttribute(
    "aria-label",
    `Remove source ${sourceIndex + 1}`
  );

  sourceSelect.addEventListener("change", () => {
    source.sourceKey = sourceSelect.value;
    const nextField = state.fieldIndex.get(source.sourceKey);
    source.reducer = nextField.default_reducer;
    source.index = 0;
    mappingChanged(mapping, true);
  });
  reducerSelect.addEventListener("change", () => {
    source.reducer = reducerSelect.value;
    mappingChanged(mapping, true);
  });
  indexInput.addEventListener("change", () => {
    source.index = clamp(Number(indexInput.value) || 0, 0, 1_000_000);
    mappingChanged(mapping, true);
  });
  weightInput.addEventListener("change", () => {
    source.weight = clamp(Number(weightInput.value) || 1, 0, 10);
    mappingChanged(mapping, true);
  });
  removeSourceButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (mapping.sources.length === 1) return;
    mapping.sources.splice(sourceIndex, 1);
    if (mapping.sources.length === 1) mapping.operator = "direct";
    mappingChanged(mapping, true);
  });
  return sourceRow;
}

function mappingChanged(mapping, signalChanged) {
  state.focusedMappingId = mapping.id;
  renderMappings();
  if (signalChanged) loadFocusedSeries();
  else updateSourceSummary();
  saveSettings();
}

function focusMapping(mappingId) {
  if (state.focusedMappingId === mappingId) return;
  state.focusedMappingId = mappingId;
  dom["mapping-rows"].querySelectorAll(".mapping-row").forEach((row) => {
    row.classList.toggle("is-focused", Number(row.dataset.mappingId) === mappingId);
  });
  loadFocusedSeries();
}

async function loadFocusedSeries() {
  const mapping = state.mappings.find((candidate) => candidate.id === state.focusedMappingId);
  if (!mapping) {
    clearWaveform();
    return;
  }
  updateSourceSummary();
  dom["wave-empty"].hidden = false;
  dom["wave-empty"].textContent = "Reducing the selected JSON signal…";
  try {
    const series = await loadSeries(mapping);
    if (mapping.id !== state.focusedMappingId) return;
    renderWaveform(series);
  } catch (error) {
    clearWaveform(error instanceof Error ? error.message : "Signal unavailable");
  }
}

async function loadSeries(mapping) {
  const series = await Promise.all(mapping.sources.map(loadSourceSeries));
  return combineSeries(series, mapping.operator, mapping.sources.map((source) => source.weight));
}

async function loadSourceSeries(source) {
  const field = state.fieldIndex.get(source.sourceKey);
  if (!field || !state.recording) throw new Error("Source field unavailable");
  const cacheKey = [state.recording.id, field.channelId, field.fieldId, source.reducer, source.index].join("|");
  if (state.seriesCache.has(cacheKey)) return state.seriesCache.get(cacheKey);
  const query = new URLSearchParams({
    channel: field.channelId,
    field: field.fieldId,
    reducer: source.reducer,
    index: String(source.index),
    limit: String(SERIES_LIMIT)
  });
  const response = await fetch(`/api/recordings/${encodeURIComponent(state.recording.id)}/series?${query}`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(humanizeError(payload.error));
  state.seriesCache.set(cacheKey, payload);
  return payload;
}

function combineSeries(seriesList, operator = "direct", weights = []) {
  const usable = seriesList.filter((series) => Array.isArray(series?.points) && series.points.length);
  if (!usable.length) return { points: [], minimum: 0, maximum: 0, composite: true };
  if (usable.length === 1 || operator === "direct") return usable[0];
  const pointCount = Math.max(...usable.map((series) => series.points.length));
  const normalizedSeries = usable.map((series) => {
    const span = series.maximum - series.minimum;
    return series.points.map((point) => span > 0
      ? clamp((point[1] - series.minimum) / span, 0, 1)
      : 0.5);
  });
  const activeWeights = usable.map((_series, index) => clamp(weights[index] ?? 1, 0, 10));
  const points = Array.from({ length: pointCount }, (_unused, pointIndex) => {
    const progress = pointCount > 1 ? pointIndex / (pointCount - 1) : 0;
    const values = normalizedSeries.map((valuesForSource) => {
      const sourceIndex = Math.round(progress * (valuesForSource.length - 1));
      return valuesForSource[sourceIndex];
    });
    return [progress, combineValues(values, operator, activeWeights)];
  });
  const values = points.map((point) => point[1]);
  return {
    points,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    composite: true,
    source_count: usable.length,
    operator
  };
}

function combineValues(values, operator, weights = []) {
  if (!values.length) return 0.5;
  if (operator === "weighted") {
    const totalWeight = values.reduce((sum, _value, index) => sum + (weights[index] ?? 1), 0);
    if (totalWeight <= 0) return 0.5;
    return values.reduce((sum, value, index) => sum + value * (weights[index] ?? 1), 0) / totalWeight;
  }
  if (operator === "sum") return values.reduce((sum, value) => sum + value, 0);
  if (operator === "difference") {
    if (values.length === 1) return values[0];
    const remainderAverage = values.slice(1).reduce((sum, value) => sum + value, 0) / (values.length - 1);
    return values[0] - remainderAverage;
  }
  if (operator === "minimum") return Math.min(...values);
  if (operator === "maximum") return Math.max(...values);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderWaveform(series) {
  const points = series.points || [];
  if (!points.length) {
    clearWaveform("This signal contains no finite numeric values.");
    return;
  }
  const span = series.maximum - series.minimum;
  const coordinates = points.map(([time, value]) => {
    const normalized = span > 0 ? (value - series.minimum) / span : 0.5;
    return [clamp(time, 0, 1) * 900, 180 - clamp(normalized, 0, 1) * 170];
  });
  const linePath = coordinates.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  dom["signal-line"].setAttribute("d", linePath);
  dom["signal-area"].setAttribute("d", `${linePath} L900 190 L0 190 Z`);
  dom["signal-min"].textContent = `MIN ${formatNumber(series.minimum)}`;
  dom["signal-max"].textContent = `MAX ${formatNumber(series.maximum)}`;
  dom["wave-empty"].hidden = true;
  state.maxSteps = Math.max(2, points.length);
  state.cursor = clamp(state.cursor, 0, state.maxSteps - 1);
  updatePlayhead();
}

function clearWaveform(message = "Select a mapping source to inspect its shape.") {
  dom["signal-line"].setAttribute("d", "");
  dom["signal-area"].setAttribute("d", "");
  dom["wave-empty"].hidden = false;
  dom["wave-empty"].textContent = message;
  dom["signal-min"].textContent = "MIN —";
  dom["signal-max"].textContent = "MAX —";
  updatePlayhead();
}

function updateSourceSummary() {
  const mapping = state.mappings.find((candidate) => candidate.id === state.focusedMappingId);
  const inputs = mapping
    ? mapping.sources.map((source) => ({
        source,
        field: state.fieldIndex.get(source.sourceKey)
      })).filter((input) => input.field)
    : [];
  dom["source-summary"].hidden = !inputs.length;
  if (!inputs.length) {
    dom["signal-title"].textContent = "Waiting for a source";
    return;
  }
  const operator = combineOperatorLabel(mapping.operator);
  dom["source-channel"].textContent = inputs.length === 1
    ? inputs[0].field.channelName
    : `${inputs.length} signals · ${operator}`;
  dom["source-field"].textContent = inputs
    .map(({ source, field }) => `${field.name} (${reducerLabel(source.reducer)})`)
    .join(" + ");
  dom["signal-title"].textContent = inputs.length === 1
    ? `${inputs[0].field.channelName} / ${inputs[0].field.name} · ${reducerLabel(inputs[0].source.reducer)}`
    : `${operator} of ${inputs.map(({ field }) => field.name).join(" + ")}`;
}

async function togglePlayback() {
  if (dom["preview-button"].disabled) return;
  if (state.playing) {
    stopPlayback();
    return;
  }
  try {
    dom["preview-button"].disabled = true;
    dom["preview-button"].innerHTML = "<span>···</span> Preparing";
    const loaded = await Promise.all(state.mappings.map(async (mapping) => [mapping.id, await loadSeries(mapping)]));
    state.playSeries = new Map(loaded);
    state.maxSteps = Math.max(...loaded.map(([_id, series]) => series.points.length), 2);
    if (state.output === "audio") await ensureAudioEngine();
    if (state.output === "midi" && !state.midiOutput) {
      await connectMidi();
      if (!state.midiOutput) throw new Error("Choose a MIDI destination before playing");
    }
    state.playing = true;
    dom["preview-button"].classList.add("is-playing");
    dom["preview-button"].innerHTML = "<span>■</span> Stop";
    dom["session-state"].textContent = state.output === "midi" ? "PLAYING · HYDRASYNTH MIDI" : "PLAYING · BROWSER AUDIO";
    runPlaybackTick();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Could not start playback");
  } finally {
    dom["preview-button"].disabled = !state.recording;
  }
}

function runPlaybackTick() {
  if (!state.playing) return;
  const progress = state.maxSteps > 1 ? state.cursor / (state.maxSteps - 1) : 0;
  const controls = controlsAt(progress);
  let noteActivity = null;
  if (Math.random() * 100 <= controls.chance) {
    const note = quantizeNote(controls.pitch);
    const interval = playbackInterval();
    const duration = clamp(interval * controls.gate / 100, 25, interval * 0.96);
    noteActivity = { number: note, velocity: controls.velocity, duration_ms: duration };
    if (state.output === "midi") playMidiNote(note, controls.velocity, duration, controls.cc);
    else playAudioNote(note, controls.velocity, duration, controls.cc);
  } else if (state.output === "midi") {
    sendMidiCc(controls.cc);
  }
  publishSignalLabActivity({
    progress,
    cc: Array.from(controls.cc, ([number, value]) => ({ number, value })),
    note: noteActivity
  });
  updatePlayhead();
  state.cursor += 1;
  if (state.cursor >= state.maxSteps) {
    state.cursor = 0;
    stopPlayback();
    return;
  }
  scheduleNextTick();
}

function scheduleNextTick() {
  if (!state.playing) return;
  window.clearTimeout(state.playTimer);
  state.playTimer = window.setTimeout(runPlaybackTick, playbackInterval());
}

function controlsAt(progress) {
  const controls = { pitch: 60, velocity: 96, gate: 66, chance: 100, cc: new Map() };
  state.mappings.forEach((mapping) => {
    const series = state.playSeries.get(mapping.id);
    if (!series?.points?.length) return;
    const index = Math.round(progress * (series.points.length - 1));
    const value = series.points[index][1];
    const span = series.maximum - series.minimum;
    let normalized = span > 0 ? (value - series.minimum) / span : 0.5;
    normalized = applyCurve(clamp(normalized, 0, 1), mapping.curve);
    const output = mapping.minimum + normalized * (mapping.maximum - mapping.minimum);
    const destination = destinationFor(mapping.destination);
    if (destination.cc !== undefined) controls.cc.set(destination.cc, clamp(Math.round(output), 0, 127));
    else controls[destination.id] = output;
  });
  controls.velocity = clamp(Math.round(controls.velocity), 1, 127);
  controls.gate = clamp(controls.gate, 5, 100);
  controls.chance = clamp(controls.chance, 0, 100);
  return controls;
}

function publishSignalLabActivity(activity = {}) {
  const compositeCount = state.mappings.filter((mapping) => mapping.sources.length > 1).length;
  state.activityQueued = {
    recording: state.recording?.name || state.recording?.id || null,
    output: state.output,
    mapping_count: state.mappings.length,
    composite_count: compositeCount,
    ...activity
  };
  flushSignalLabActivity();
}

async function flushSignalLabActivity() {
  if (state.activityPending) return;
  state.activityPending = true;
  try {
    while (state.activityQueued) {
      const payload = state.activityQueued;
      state.activityQueued = null;
      const response = await fetch("/api/signal-lab/events", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`Signal Lab activity returned ${response.status}`);
    }
  } catch (_error) {
    state.activityQueued = null;
  } finally {
    state.activityPending = false;
    if (state.activityQueued) flushSignalLabActivity();
  }
}

function stopPlayback() {
  const wasPlaying = state.playing;
  state.playing = false;
  window.clearTimeout(state.playTimer);
  state.playTimer = null;
  dom["preview-button"].classList.remove("is-playing");
  dom["preview-button"].innerHTML = "<span>▶</span> Preview";
  dom["session-state"].textContent = "LOCAL SESSION · READY";
  stopActiveMidiNotes();
  updatePlayhead();
  if (wasPlaying) publishSignalLabActivity({ stop: true, progress: 0 });
}

async function ensureAudioEngine() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) throw new Error("This browser does not support audio preview");
  if (!state.audio) {
    const context = new AudioContext();
    const master = context.createGain();
    const delay = context.createDelay(1);
    const feedback = context.createGain();
    master.gain.value = 0.55;
    delay.delayTime.value = 0.19;
    feedback.gain.value = 0.22;
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(master);
    master.connect(context.destination);
    state.audio = { context, master, delay };
  }
  await state.audio.context.resume();
}

function playAudioNote(note, velocity, durationMs, ccValues) {
  if (!state.audio) return;
  const { context, master, delay } = state.audio;
  const now = context.currentTime;
  const attack = Math.min(
    Number(dom.attack.value) / 100,
    durationMs / 1000 * 0.8
  );
  const release = 0.05 + Number(dom.release.value) / 100 * 1.2;
  const end = now + durationMs / 1000;
  const gain = context.createGain();
  const filter = context.createBiquadFilter();
  const wet = context.createGain();
  const oscillator = context.createOscillator();
  const harmonic = context.createOscillator();
  const harmonicGain = context.createGain();
  const cutoffValue = ccValues.get(74) ?? Math.round(Number(dom.brightness.value) * 1.27);
  const resonanceValue = ccValues.get(71) ?? 18;
  const reverbValue = ccValues.get(93) ?? 16;
  const frequency = 440 * Math.pow(2, (note - 69) / 12);
  oscillator.type = dom["wave-type"].value;
  harmonic.type = "sine";
  oscillator.frequency.value = frequency;
  harmonic.frequency.value = frequency * 2;
  harmonic.detune.value = 5;
  harmonicGain.gain.value = 0.12;
  filter.type = "lowpass";
  filter.frequency.value = 90 * Math.pow(120, cutoffValue / 127);
  filter.Q.value = 0.4 + resonanceValue / 127 * 14;
  wet.gain.value = reverbValue / 127 * 0.38;
  const peak = velocity / 127 * 0.23;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), now + Math.max(0.008, attack));
  gain.gain.setValueAtTime(Math.max(0.001, peak), end);
  gain.gain.exponentialRampToValueAtTime(0.0001, end + release);
  oscillator.connect(gain);
  harmonic.connect(harmonicGain);
  harmonicGain.connect(gain);
  gain.connect(filter);
  filter.connect(master);
  filter.connect(wet);
  wet.connect(delay);
  oscillator.start(now);
  harmonic.start(now);
  oscillator.stop(end + release + 0.03);
  harmonic.stop(end + release + 0.03);
  oscillator.addEventListener("ended", () => {
    oscillator.disconnect();
    harmonic.disconnect();
    harmonicGain.disconnect();
    gain.disconnect();
    filter.disconnect();
    wet.disconnect();
  }, { once: true });
}

async function connectMidi() {
  if (!navigator.requestMIDIAccess) {
    showToast("Web MIDI is not available in this browser. Browser preview still works.");
    return;
  }
  try {
    state.midiAccess = state.midiAccess || await navigator.requestMIDIAccess({ sysex: false });
    state.midiAccess.onstatechange = renderMidiOutputs;
    renderMidiOutputs();
    dom["midi-panel"].hidden = false;
    dom["panic-button"].hidden = false;
    if (state.midiOutput) setOutput("midi");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "MIDI permission was not granted");
  }
}

function renderMidiOutputs() {
  const outputs = state.midiAccess ? Array.from(state.midiAccess.outputs.values()) : [];
  const previousId = state.midiOutput?.id || dom["midi-output"].value;
  dom["midi-output"].replaceChildren(new Option("No device selected", ""));
  outputs.forEach((output) => dom["midi-output"].add(new Option(output.name || "MIDI output", output.id)));
  const hydra = outputs.find((output) => /hydra/i.test(output.name || ""));
  const selected = outputs.find((output) => output.id === previousId) || hydra || null;
  dom["midi-output"].value = selected?.id || "";
  state.midiOutput = selected;
  updateMidiStatus();
}

function selectMidiOutput() {
  state.midiOutput = state.midiAccess?.outputs.get(dom["midi-output"].value) || null;
  updateMidiStatus();
}

function updateMidiStatus() {
  if (state.midiOutput) {
    dom["midi-status"].textContent = `${state.midiOutput.name} is ready on channel ${MIDI_CHANNEL + 1}.`;
    dom["midi-choice-detail"].textContent = state.midiOutput.name;
    dom["connect-midi"].innerHTML = `MIDI connected <span>✓</span>`;
  } else {
    dom["midi-status"].textContent = "Connect the Hydrasynth, then choose it here.";
    dom["midi-choice-detail"].textContent = "No output selected";
    dom["connect-midi"].innerHTML = `Connect MIDI device <span>→</span>`;
    if (state.output === "midi") setOutput("audio");
  }
}

function playMidiNote(note, velocity, durationMs, ccValues) {
  if (!state.midiOutput) return;
  sendMidiCc(ccValues);
  const existing = state.midiNoteTimers.get(note);
  if (existing) {
    window.clearTimeout(existing);
    state.midiOutput.send([0x80 | MIDI_CHANNEL, note, 0]);
  }
  state.midiOutput.send([0x90 | MIDI_CHANNEL, note, velocity]);
  const timer = window.setTimeout(() => {
    state.midiOutput?.send([0x80 | MIDI_CHANNEL, note, 0]);
    state.midiNoteTimers.delete(note);
  }, durationMs);
  state.midiNoteTimers.set(note, timer);
}

function sendMidiCc(ccValues) {
  if (!state.midiOutput) return;
  ccValues.forEach((value, cc) => state.midiOutput.send([0xB0 | MIDI_CHANNEL, cc, value]));
}

function stopActiveMidiNotes() {
  state.midiNoteTimers.forEach((timer, note) => {
    window.clearTimeout(timer);
    state.midiOutput?.send([0x80 | MIDI_CHANNEL, note, 0]);
  });
  state.midiNoteTimers.clear();
}

function panicMidi() {
  stopActiveMidiNotes();
  state.midiOutput?.send([0xB0 | MIDI_CHANNEL, 123, 0]);
  state.midiOutput?.send([0xB0 | MIDI_CHANNEL, 120, 0]);
}

function setOutput(output) {
  if (!['audio', 'midi'].includes(output)) return;
  if (state.playing) stopPlayback();
  state.output = output;
  dom.outputButtons.forEach((button) => {
    const selected = button.dataset.output === output;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", String(selected));
  });
  dom["midi-panel"].hidden = output !== "midi" && !state.midiAccess;
  dom["panic-button"].hidden = output !== "midi";
  if (output === "midi" && !state.midiAccess) connectMidi();
  saveSettings();
}

function seekFromPointer(event) {
  if (!state.recording) return;
  const bounds = dom["waveform"].getBoundingClientRect();
  const progress = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
  state.cursor = Math.round(progress * (state.maxSteps - 1));
  updatePlayhead();
}

function updatePlayhead() {
  const progress = state.maxSteps > 1 ? clamp(state.cursor / (state.maxSteps - 1), 0, 1) : 0;
  dom.playhead.setAttribute("d", `M${(progress * 900).toFixed(2)} 0v190`);
  dom["wave-progress"].textContent = `${Math.round(progress * 100)}%`;
  dom["waveform"].setAttribute("aria-valuenow", String(Math.round(progress * 100)));
}

function renderScale() {
  const root = dom["scale-root"] ? dom["scale-root"].selectedIndex : 0;
  const scaleName = dom["scale-name"] ? dom["scale-name"].value : "minor-pentatonic";
  const intervals = SCALE_INTERVALS[scaleName] || SCALE_INTERVALS["minor-pentatonic"];
  if (!dom["piano-roll"]) return;
  dom["piano-roll"].replaceChildren(...Array.from({ length: 12 }, (_value, note) => {
    const key = document.createElement("i");
    const relative = (note - root + 12) % 12;
    key.classList.toggle("on", intervals.includes(relative));
    return key;
  }));
  const scaleLabel = dom["scale-name"].selectedOptions[0]?.textContent.toLowerCase() || "scale";
  dom["scale-copy"].textContent = `${NOTE_NAMES[root]} ${scaleLabel}`;
}

function quantizeNote(value) {
  const target = clamp(Math.round(value), 0, 127);
  const root = dom["scale-root"].selectedIndex;
  const intervals = SCALE_INTERVALS[dom["scale-name"].value] || SCALE_INTERVALS.chromatic;
  let best = target;
  let bestDistance = Infinity;
  for (let candidate = Math.max(0, target - 12); candidate <= Math.min(127, target + 12); candidate += 1) {
    const relative = (candidate - root + 120) % 12;
    if (!intervals.includes(relative)) continue;
    const distance = Math.abs(candidate - target);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function updateControlReadouts() {
  dom["attack-output"].textContent = `${(Number(dom.attack.value) / 100).toFixed(2)}s`;
  dom["release-output"].textContent = `${(0.05 + Number(dom.release.value) / 100 * 1.2).toFixed(2)}s`;
  dom["brightness-output"].textContent = `${dom.brightness.value}%`;
  dom["voice-name"].textContent = `${dom["wave-type"].selectedOptions[0].textContent.toUpperCase()} / 01`;
}

function applySavedControls() {
  const controls = state.saved.controls || {};
  const values = {
    tempo: controls.tempo ?? 96,
    "steps-per-beat": controls.stepsPerBeat ?? 2,
    "wave-type": controls.waveType ?? "triangle",
    attack: controls.attack ?? 8,
    release: controls.release ?? 38,
    brightness: controls.brightness ?? 64,
    "scale-root": controls.scaleRoot ?? "C",
    "scale-name": controls.scaleName ?? "minor-pentatonic"
  };
  Object.entries(values).forEach(([id, value]) => {
    if (dom[id]) dom[id].value = String(value);
  });
  state.output = controls.output === "midi" ? "midi" : "audio";
  dom.outputButtons.forEach((button) => {
    const selected = button.dataset.output === state.output;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", String(selected));
  });
  updateControlReadouts();
}

function loadSavedSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function saveSettings() {
  state.saved.controls = {
    tempo: Number(dom.tempo.value),
    stepsPerBeat: Number(dom["steps-per-beat"].value),
    waveType: dom["wave-type"].value,
    attack: Number(dom.attack.value),
    release: Number(dom.release.value),
    brightness: Number(dom.brightness.value),
    scaleRoot: dom["scale-root"].value,
    scaleName: dom["scale-name"].value,
    output: state.output
  };
  if (state.recording) {
    state.saved.lastRecording = state.recording.id;
    state.saved.mappingsByRecording = state.saved.mappingsByRecording || {};
    state.saved.mappingsByRecording[state.recording.id] = state.mappings.map(({ id: _id, ...mapping }) => mapping);
  }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.saved));
  } catch (_error) {
    // Device-local persistence is optional; the live session still works.
  }
}

function appendGroupedOptions(select, items, groupKey, valueKey, labelKey) {
  const groups = new Map();
  items.forEach((item) => {
    const group = item[groupKey] || "Other";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  });
  groups.forEach((groupItems, groupName) => {
    const optionGroup = document.createElement("optgroup");
    optionGroup.label = groupName;
    groupItems.forEach((item) => optionGroup.append(new Option(item[labelKey], item[valueKey])));
    select.append(optionGroup);
  });
}

function configureRangeInput(input, mapping, key) {
  const destination = destinationFor(mapping.destination);
  input.min = String(destination.min);
  input.max = String(destination.max);
  input.step = "1";
  input.value = String(Math.round(mapping[key]));
}

function destinationFor(identifier) {
  return DESTINATIONS.find((item) => item.id === identifier);
}

function playbackInterval() {
  const bpm = clamp(Number(dom.tempo.value) || 96, 20, 240);
  const steps = clamp(Number(dom["steps-per-beat"].value) || 2, 1, 4);
  return 60000 / bpm / steps;
}

function applyCurve(value, curve) {
  if (curve === "inverse") return 1 - value;
  if (curve === "smooth") return value * value * (3 - 2 * value);
  if (curve === "exponential") return value * value;
  return value;
}

function reducerLabel(reducer) {
  return ({ mean: "Mean", rms: "RMS energy", minimum: "Minimum", maximum: "Maximum", index: "One index", value: "Direct value" })[reducer] || reducer;
}

function combineOperatorLabel(operator) {
  return ({
    direct: "Single signal",
    average: "Average",
    weighted: "Weighted average",
    sum: "Sum",
    difference: "Difference",
    minimum: "Minimum",
    maximum: "Maximum"
  })[operator] || "Average";
}

function setEngineState(kind, title, detail) {
  dom["engine-state"].innerHTML = `<span class="status-light is-${kind}"></span><span><b>${escapeHtml(title)}</b><small>${escapeHtml(detail)}</small></span>`;
}

function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { dom.toast.hidden = true; }, 4200);
}

function humanizeError(code) {
  return String(code || "Signal unavailable").replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatInteger(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if ((absolute > 0 && absolute < 0.001) || absolute >= 10000) return value.toExponential(2);
  return value.toFixed(absolute < 10 ? 3 : 2).replace(/\.0+$/, "");
}

function updateClock() {
  dom["footer-clock"].textContent = new Intl.DateTimeFormat([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).format(new Date());
}

function clamp(value, minimum, maximum) {
  const number = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(number) ? number : minimum));
}

function isEditable(target) {
  return target instanceof Element && Boolean(target.closest("input, select, textarea, button, [contenteditable]"));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
}
