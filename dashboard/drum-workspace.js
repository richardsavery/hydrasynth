"use strict";

// Movement drums use their own signal selection; melodic mapping recipes remain intact.
const DRUM_CONTROL_IDS = {
  drumKit: "drum-kit", drumStyle: "drum-style", drumTempoMin: "drum-tempo-min", drumTempoMax: "drum-tempo-max",
  drumDensityMin: "drum-density-min", drumDensityMax: "drum-density-max", drumSensitivity: "drum-sensitivity",
  drumSmoothing: "drum-smoothing", drumSwing: "drum-swing", drumVolume: "drum-volume", drumFill: "drum-fill"
};

function readDrumControls() {
  return { ...Object.fromEntries(Object.entries(DRUM_CONTROL_IDS).map(([key, id]) => [key, dom[id]?.value])),
    drumSources: state.drumSources, drumMuted: state.drumMuted };
}

function applyDrumControls(settings) {
  Object.entries(DRUM_CONTROL_IDS).forEach(([key, id]) => { if (dom[id]) dom[id].value = settings[key]; });
  state.drumSources = [...(settings.drumSources || [])];
  state.drumMuted = [...(settings.drumMuted || [])];
  state.drumSeries = new Map();
  state.drumHistory = [];
  state.drumActivity = 0;
  state.drumPlayingKeys = null;
  state.drumMotion?.reset();
  renderDrumSources();
  renderDrumReadout(0);
}

function bindDrumInterface() {
  Object.entries(DRUM_CONTROL_IDS).forEach(([key, id]) => {
    dom[id].addEventListener("input", () => {
      if (key === "drumKit") state.drumEngine?.stop();
      renderDrumReadout(state.drumActivity);
      saveSettings();
    });
    dom[id].addEventListener("change", () => {
      // Show the bounded, ordered endpoints actually used by the player.
      const settings = readMusicalControls();
      for (const [control, elementId] of Object.entries(DRUM_CONTROL_IDS)) dom[elementId].value = settings[control];
      renderDrumReadout(state.drumActivity);
      if (!state.playing && ["drumSensitivity", "drumSmoothing"].includes(key)) drawDrumRecordingWaveform();
      saveSettings();
    });
  });
  dom["drum-auto-sources"].addEventListener("click", () => {
    stopPlayback();
    state.drumSources = [];
    state.drumPlayingKeys = null;
    renderDrumSources();
    saveSettings();
    loadDrumPreview();
  });
}

function drumSourceKeys() {
  if (state.drumPlayingKeys && state.playing) return state.drumPlayingKeys;
  if (state.drumSources.length) return state.drumSources;
  const velocity = state.fields.filter((field) => field.kind === "velocity" || /^velocity(?::|$)/.test(field.fieldId));
  const positions = state.fields.filter((field) => field.kind === "position");
  return (velocity.length ? velocity : positions.length ? positions : state.fields).slice(0, 6).map((field) => field.key);
}

function drumSource(key) {
  const field = state.fieldIndex.get(key);
  return { sourceKey: key, reducer: field?.reducers.includes("value") ? "value" : "rms", index: 0 };
}

function renderDrumSources() {
  if (!dom["drum-sources"]) return;
  const keys = drumSourceKeys();
  const selected = new Set(keys);
  const fields = [...state.fields];
  for (const key of keys) if (!state.fieldIndex.has(key)) fields.push({ key, name: `Waiting for ${key}`, channelName: "Missing source" });
  dom["drum-sources"].replaceChildren(...fields.map((field) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = selected.has(field.key);
    input.disabled = !input.checked && selected.size >= 6;
    const text = document.createElement("span");
    text.textContent = `${field.channelName} · ${field.name}`;
    label.append(input, text);
    input.addEventListener("change", () => {
      const updated = new Set(drumSourceKeys());
      if (input.checked) updated.add(field.key); else updated.delete(field.key);
      if (!updated.size) { input.checked = true; showToast("Keep at least one movement source selected."); return; }
      stopPlayback();
      state.drumSources = [...updated].slice(0, 6);
      state.drumPlayingKeys = null;
      renderDrumSources(); saveSettings(); loadDrumPreview();
    });
    return label;
  }));
  const missing = keys.filter((key) => !state.fieldIndex.has(key)).length;
  dom["drum-source-summary"].textContent = !keys.length ? "Waiting for recording or live movement data."
    : `${state.drumSources.length ? "Selected" : "Automatic"} · ${keys.length} signals combined by movement energy${missing ? ` · ${missing} waiting for data` : ""}.`;
  renderPlaybackAvailability();
}

function renderOutputMode() {
  if (!dom.outputButtons) return;
  const drums = state.output === "drums";
  dom.outputButtons.forEach((button) => {
    const selected = button.dataset.output === state.output;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", String(selected));
  });
  for (const id of ["melodic-rhythm-panel", "preview-synth", "harmony-panel", "sound-palette-panel", "melodic-output-note",
    "transport-tempo", "transport-subdivision", "mapping-panel", "catalog-status", "mapping-help", "connect-midi"]) {
    const element = document.getElementById(id);
    if (element) element.hidden = drums;
  }
  for (const element of document.querySelectorAll(".generator-toolbar")) element.hidden = drums;
  for (const id of ["drum-panel", "drum-output-note"]) {
    const element = document.getElementById(id);
    if (element) element.hidden = !drums;
  }
  document.body.classList.toggle("drum-mode", drums);
  dom["midi-panel"].hidden = state.output !== "midi";
  dom["panic-button"].hidden = state.output !== "midi";
  if (drums) { renderDrumSources(); renderDrumReadout(state.drumActivity); }
  renderPlaybackAvailability();
}

function drumKitName() {
  return Drums?.KITS.find((kit) => kit.id === dom["drum-kit"]?.value)?.name || "Electronic kit";
}

function renderDrumReadout(activity = 0, plan = null, message) {
  if (!Drums || !dom["drum-grid"]) return;
  const settings = readMusicalControls();
  const display = plan || Drums.step(settings, activity, state.rhythmStep);
  dom["drum-activity"].value = activity;
  dom["drum-activity-value"].textContent = `${Math.round(activity * 100)}%`;
  dom["drum-tempo-readout"].textContent = String(Math.round(display.tempo));
  dom["drum-density-readout"].textContent = String(Math.round(display.density));
  const unavailable = playbackUnavailableReason();
  if (!state.playing && !state.preparing && unavailable) dom["drum-status"].textContent = unavailable;
  else if (message) dom["drum-status"].textContent = message;
  for (const key of ["sensitivity", "smoothing", "swing", "volume", "fill"]) {
    const output = document.getElementById(`drum-${key}-output`);
    if (output) output.textContent = `${dom[`drum-${key}`].value}%`;
  }
  if (!dom["drum-grid"].children.length) {
    const header = document.createElement("div");
    header.className = "drum-grid-header";
    const title = document.createElement("span"); title.className = "drum-lane-label"; title.textContent = "KIT / MUTE"; header.append(title);
    for (let i = 0; i < 16; i++) { const label = document.createElement("span"); label.textContent = i % 4 ? "·" : String(i / 4 + 1); header.append(label); }
    dom["drum-grid"].append(header);
    for (const track of display.pattern) {
      const row = document.createElement("div"); row.className = "drum-lane"; row.dataset.voice = track.id;
      const button = document.createElement("button"); button.type = "button"; button.className = "drum-lane-label";
      button.textContent = track.name; button.title = `Mute or unmute ${track.name}`;
      button.addEventListener("click", () => {
        const muted = new Set(state.drumMuted);
        if (muted.has(track.id)) muted.delete(track.id); else muted.add(track.id);
        state.drumMuted = [...muted];
        state.drumEngine?.stop(); renderDrumReadout(state.drumActivity); saveSettings();
      });
      row.append(button);
      for (let i = 0; i < 16; i++) { const cell = document.createElement("span"); cell.className = "drum-step"; row.append(cell); }
      dom["drum-grid"].append(row);
    }
  }
  display.pattern.forEach((track, index) => {
    const row = dom["drum-grid"].children[index + 1];
    const muted = state.drumMuted.includes(track.id);
    row.classList.toggle("is-muted", muted);
    row.children[0].setAttribute("aria-pressed", String(muted));
    row.children[0].setAttribute("aria-label", `${track.name}${muted ? " muted" : " active"}; toggle mute`);
    row.setAttribute("aria-label", `${track.name}: ${track.steps.filter(Boolean).length} hits per bar${muted ? ", muted" : ""}`);
    track.steps.forEach((velocity, step) => {
      const cell = row.children[step + 1];
      cell.classList.toggle("is-hit", velocity > 0);
      cell.classList.toggle("is-accent", velocity > 0.8);
      cell.classList.toggle("is-current", state.playing && !state.liveSilenced && step === state.rhythmStep % 16);
      cell.setAttribute("aria-hidden", "true");
    });
  });
}

async function loadDrumSeries() {
  const keys = drumSourceKeys();
  if (!keys.length) throw new Error("Choose movement sources first.");
  // Reuse the batch cache while keeping original units and timestamps for speed estimates.
  const loaded = await loadMappingSet(keys.map((key) => ({ id: key, sources: [drumSource(key)], operator: "direct" })));
  return loaded;
}

function acceptDrumSeries(loaded) {
  state.drumSeries = new Map(loaded);
  state.drumStart = Math.min(...loaded.map(([, series]) => Number.isFinite(series.start_time_seconds) ? series.start_time_seconds : 0));
  state.drumDuration = Math.max(1, ...loaded.map(([, series]) =>
    (Number.isFinite(series.start_time_seconds) ? series.start_time_seconds : 0) - state.drumStart + (series.duration_seconds || 0)));
  state.maxSteps = Math.max(2, ...loaded.map(([, series]) => series.points.length));
}

function recordedDrumSamples(progress) {
  return drumSourceKeys().map((key) => {
    const series = state.drumSeries.get(key);
    const field = state.fieldIndex.get(key);
    if (!series?.points.length || !field) return null;
    const elapsed = progress * state.drumDuration;
    const offset = (Number.isFinite(series.start_time_seconds) ? series.start_time_seconds : 0) - (state.drumStart || 0);
    if (elapsed < offset) return null;
    const sourceProgress = clamp((elapsed - offset) / (series.duration_seconds || state.drumDuration), 0, 1);
    // Binary search timestamped values; don't assume a constant input frame rate.
    let low = 0, high = series.points.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (series.points[mid][0] <= sourceProgress) low = mid; else high = mid - 1;
    }
    const point = series.points[low];
    return { key, value: point[1], at: (offset + point[0] * (series.duration_seconds || state.drumDuration)) * 1000,
      kind: field.kind === "velocity" || /^velocity(?::|$)/.test(field.fieldId) ? "velocity" : "position",
      minimum: series.minimum, maximum: series.maximum };
  });
}

function liveDrumSamples(now) {
  return drumSourceKeys().map((key) => {
    const sample = state.live?.read(drumSource(key), now);
    const field = state.fieldIndex.get(key);
    if (!sample || !field) return null;
    return { ...sample, key, kind: field.kind === "velocity" || /^velocity(?::|$)/.test(field.fieldId) ? "velocity" : "position" };
  });
}

async function loadDrumPreview() {
  renderDrumSources();
  if (state.sourceMode === "live") { drawDrumLiveWaveform(); return; }
  if (!state.recording || !drumSourceKeys().length) { clearWaveform("Choose a recording or connect a live stream."); return; }
  const revision = ++state.drumRevision;
  const generation = state.selectionGeneration;
  dom["drum-status"].textContent = "Reading movement signals…";
  try {
    const loaded = await loadDrumSeries();
    if (generation !== state.selectionGeneration || revision !== state.drumRevision || state.output !== "drums") return;
    acceptDrumSeries(loaded);
    drawDrumRecordingWaveform();
    renderDrumReadout(0, null, "Ready · press Preview to hear the movement. Click a kit lane to mute it.");
  } catch (error) {
    if (revision !== state.drumRevision || generation !== state.selectionGeneration) return;
    clearWaveform(error.message);
    dom["drum-status"].textContent = error.message;
  }
}

function drumWaveformTitle() {
  dom["signal-title"].textContent = `Overall movement · ${drumSourceKeys().length} signals`;
  dom["source-summary"].hidden = false;
  dom["source-channel"].textContent = "Movement energy";
  dom["source-field"].textContent = drumSourceKeys().map((key) => state.fieldIndex.get(key)?.name || "Waiting for source").join(" + ");
}

function drawDrumRecordingWaveform() {
  if (state.output !== "drums" || state.sourceMode === "live" || !state.drumSeries.size) return;
  const motion = new Drums.Motion();
  const settings = readMusicalControls();
  const points = Array.from({ length: state.maxSteps }, (_, i) => {
    const progress = i / (state.maxSteps - 1);
    const samples = recordedDrumSamples(progress);
    return [progress, samples.some((sample) => !sample) ? 0 : motion.update(samples, progress * state.drumDuration * 1000, settings)];
  });
  drumWaveformTitle();
  renderWaveform({ points, minimum: 0, maximum: 1 });
}

function drawDrumLiveWaveform() {
  if (!dom["drum-panel"] || !Drums) return;
  drumWaveformTitle();
  const samples = liveDrumSamples(performance.now());
  if (!samples.length || samples.some((sample) => !sample)) { clearWaveform("Waiting for fresh data from every movement source."); return; }
  const history = state.drumHistory || [];
  if (!history.length) { clearWaveform("Press Preview to see and hear live movement energy."); return; }
  renderWaveform({ points: history.map((value, i) => [i / Math.max(1, history.length - 1), value]), minimum: 0, maximum: 1 });
}

async function runDrumTick(generation) {
  const now = performance.now();
  let progress = 0;
  if (state.sourceMode !== "live") {
    progress = Math.max(0, (now - state.drumOrigin) / (state.drumDuration * 1000));
    if (progress >= 1) {
      if (!dom.loop.checked) { state.cursor = state.maxSteps - 1; stopPlayback(); return; }
      progress %= 1;
      state.drumOrigin = now - progress * state.drumDuration * 1000;
      state.drumMotion.reset();
    }
    state.cursor = Math.floor(progress * (state.maxSteps - 1));
  }
  const samples = state.sourceMode === "live" ? liveDrumSamples(now) : recordedDrumSamples(progress);
  if (!samples.length || samples.some((sample) => !sample)) {
    silenceStaleInput(); scheduleNextTick(100); return;
  }
  if (state.liveSilenced) await ensureAudioEngine();
  if (!state.playing || generation !== state.playbackGeneration) return;
  state.liveSilenced = false;
  const settings = readMusicalControls();
  const activity = state.drumMotion.update(samples, now, settings);
  state.drumActivity = activity;
  const plan = Drums.step(settings, activity, state.rhythmStep);
  const audioAt = state.audio.context.currentTime + Math.max(.008, (state.nextTickAt - performance.now()) / 1000 + .05);
  for (const hit of plan.hits) state.drumEngine.hit(hit.track, hit.velocity, settings.drumKit, audioAt, settings.drumVolume / 100);
  dom["session-state"].textContent = "PLAYING · MOVEMENT DRUMS";
  renderDrumReadout(activity, plan, `${drumKitName()} · ${Math.floor(state.rhythmStep / 16) + 1} bars · ${drumSourceKeys().length} movement signals`);
  publishSignalLabActivity({ progress, notes: plan.hits.map((hit) => ({ number: hit.note, velocity: hit.velocity, duration_ms: hit.duration })),
    drums: { activity, tempo: plan.tempo, density: plan.density, kit: settings.drumKit, style: settings.drumStyle } });
  if (state.sourceMode === "live") {
    state.drumHistory ||= [];
    state.drumHistory.push(activity);
    if (state.drumHistory.length > 256) state.drumHistory.shift();
  }
  updatePlayhead();
  state.rhythmStep++;
  scheduleNextTick(plan.interval);
}
