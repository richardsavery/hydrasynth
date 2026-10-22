"use strict";

const SERIES_LIMIT = 720;
const SETTINGS_KEY = "hydra-signal-lab-v1";
const CONNECTIONS_KEY = "hydra.connections.v1";
const MIDI_CHANNEL = 0;
const MAX_MAPPING_SOURCES = 6;
function recordStudyEvent(type, payload) { try { globalThis.HydraStudy?.emit?.(type, payload); } catch (_) {} }
const legacyStudyMappings = new Map();
function legacyStudyTracker(workspace = "synth-legacy") {
  try {
    if (!legacyStudyMappings.has(workspace)) {
      const tracker = globalThis.HydraStudy?.createMappingTracker?.(workspace);
      if (tracker) legacyStudyMappings.set(workspace, tracker);
    }
    return legacyStudyMappings.get(workspace) || null;
  } catch (_) { return null; }
}
function legacyStudyConfiguration() {
  return { source_mode: state.sourceMode, recording_id: state.recording?.id || null,
    active_tab_id: state.activeTabId, mappings: state.mappings, tabs: state.tabs,
    controls: readMusicalControls(), drum_sources: state.drumSources, drum_muted: state.drumMuted };
}
function captureLegacyStudyMappings(reason = "settings_changed") {
  try {
    const workspace = state.workspaceView === "drums" ? "drums" : "synth-legacy";
    return legacyStudyTracker(workspace)?.capture(legacyStudyConfiguration(), { reason }) || null;
  } catch (_) { return null; }
}
function mappingPlaybackStudy(running = state.playing, reason = "output") {
  try {
    const workspace = state.playbackWorkspace || state.workspaceView;
    if (workspace === "synth-mixer") return globalThis.HydraSynthMixer?.mappingStudyContext?.() || null;
    if (!["synth-legacy", "drums", null].includes(workspace)) return null;
    const tracker = legacyStudyTracker(workspace || "synth-legacy");
    if (!tracker) return null;
    if (!tracker.current()) tracker.capture(legacyStudyConfiguration(), { reason: "playback_baseline" });
    tracker.playback(null, { running, reason, generation: state.playbackGeneration,
      output: state.output, source_mode: state.sourceMode, recording_id: state.recording?.id || null });
    return tracker.current();
  } catch (_) { return null; }
}
const COMBINE_OPERATORS = new Set([
  "direct", "average", "weighted", "sum", "difference", "minimum", "maximum"
]);

const Music = globalThis.HydraSonification;
const { DESTINATIONS, MAX_MAPPINGS, MAX_TARGETS, MAX_TABS, MAX_PRESETS } = Music;
const Parameters = globalThis.HydraParameters;
const Live = globalThis.HydraLive;
const Drums = globalThis.HydraDrums;

const SCALE_INTERVALS = Music.SCALE_INTERVALS;

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

const state = {
  library: null,
  sourceMode: "recording",
  live: null, liveSocket: null, liveGeneration: 0, liveRetry: null, liveWanted: false,
  liveRenderTimer: null, liveNeedsDefaults: false, liveDiscoveryPending: false,
  liveStatus: "Not connected", liveLastDraw: 0,
  liveDiagnostics: globalThis.HydraLiveMonitorModel?.create(), liveMonitorUI: null, liveRetryAt: null,
  catalogReady: false, catalogSummary: null,
  picker: null, expandedTargets: new Set(),
  midiPacer: Parameters ? new Parameters.Pacer() : null, parameterTimer: null, parameterCarry: 0,
  patchChanging: false, currentParameterCommands: [],
  recording: null,
  fields: [],
  fieldIndex: new Map(),
  mappings: [],
  tabs: [],
  activeTabId: null,
  removedTab: null,
  selectedPreset: "",
  preparing: false,
  playbackGeneration: 0,
  selectionGeneration: 0,
  seriesRevision: 0,
  rhythmStep: 0,
  synthBeatClock: null, synthBeatRevision: 0,
  noteTimers: new Set(),
  patchTimers: new Map(),
  currentPatch: null,
  currentPreviewVoice: null,
  lastSoundChange: -Infinity,
  activeVoices: new Set(),
  nextTickAt: 0,
  nextMappingId: 1,
  seriesCache: new Map(),
  mappingRanges: new WeakMap(),
  openInputRanges: new WeakSet(),
  focusedMappingId: null,
  playing: false,
  playbackError: null,
  playTimer: null,
  cursor: 0,
  maxSteps: SERIES_LIMIT,
  output: "audio",
  workspaceView: null,
  playbackWorkspace: null,
  synthOutput: "audio",
  drumSources: [], drumMuted: [], drumSeries: new Map(), drumMotion: null,
  drumActivity: 0, drumEngine: null, drumOrigin: 0, drumDuration: 1, drumRevision: 0,
  audio: null,
  midiAccess: null,
  midiOutput: null,
  midiConnecting: null, midiConnectionError: "",
  connectionPreferences: loadConnectionPreferences(), connectionsReady: false,
  sessionReloading: false,
  midiNoteTimers: new Map(),
  midiSustainOutputs: new Set(),
  activityPending: false,
  activityQueued: null,
  saved: loadSavedSettings()
};

// Remember whether a route was chosen before startup loads recordings and saves
// their default controls. A first connection may choose Hydrasynth; a saved
// browser-audio route or a choice made during the permission prompt wins.
state.midiAutoRoute = !["audio", "midi"].includes(state.connectionPreferences.synthOutput
  ?? state.saved.connections?.synthOutput ?? state.saved.controls?.output);

const dom = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheDom();
  bindInterface();
  bindWorkspaces();
  bindParameterPicker();
  bindLiveInput();
  bindDrumInterface();
  bindDashboardSwitcher();
  applySavedControls();
  bindSonificationWorkspaces();
  renderScale();
  renderRhythm();
  updateClock();
  window.setInterval(updateClock, 1000);
  loadParameterCatalog().then(() => loadRecordings(false)).then(() => restoreConnectionPreferences({ autoConnectMidi: true })).catch((error) => {
    setEngineState("error", "Catalog unavailable", error.message);
    dom["catalog-status"].textContent = `${error.message} Use Refresh to retry.`;
    return restoreConnectionPreferences({ autoConnectMidi: true });
  }).finally(() => { state.connectionsReady = true; });
});

function bindSonificationWorkspaces() {
  const sourceBridge = globalThis.HydraElevenSource?.create({
    getState: () => state, loadSeries: loadSourceSeries
  });
  globalThis.HydraElevenLabs?.init({ sourceBridge });
  const mixerInput = globalThis.HydraElevenSource?.create({
    getState: () => state, loadSeries: loadSourceSeries
  });
  const mixerBridge = mixerInput && {
    ...mixerInput,
    describe: () => ({ ...mixerInput.describe(),
      revision: `${state.sourceMode}|${state.recording?.id}|${state.selectionGeneration}|${state.liveGeneration}` })
  };
  globalThis.HydraMusicMixer?.init({
    container: document.getElementById("music-mixer-workspace"), sourceBridge: mixerBridge
  });
  globalThis.HydraRapExperiment?.init({ container: document.getElementById("rap-experiment-workspace") });
  const quietForRapResponse = ({ output_mode } = {}) => {
    // An isolated rap uses the current backing transport, including while
    // recording the listener's message. Only standalone mixes take it over.
    if (output_mode === "vocals") return;
    stopPlayback();
    globalThis.HydraSynthMixer?.deactivate();
    globalThis.HydraMusicMixer?.deactivate();
    globalThis.HydraRapExperiment?.deactivate();
    globalThis.HydraElevenLabs?.deactivate();
  };
  globalThis.HydraRapResponse?.init({ container: document.getElementById("rap-response-workspace"),
    onBeforeListen: quietForRapResponse, onBeforePlay: quietForRapResponse,
    getBackingClock: () => {
      const music = globalThis.HydraMusicMixer?.transportClock?.();
      if (music?.playing) return { ...music, label: "Music mixer" };
      const synth = synthRapClock();
      if (synth?.playing) return { ...synth, label: "Synth mixer" };
      return music || synth;
    },
    unlockBacking: async () => {
      const music = globalThis.HydraMusicMixer?.transportClock?.();
      if (music?.playing) await music.context?.resume();
      else if (synthRapClock().playing) await ensureAudioEngine();
    } });
  globalThis.HydraRobotControl?.init({ container: document.getElementById("robot-setup-workspace") });
  globalThis.HydraRobotLive?.init({ container: document.getElementById("robot-control-workspace"),
    hardware: globalThis.HydraRobotControl, clock: source => globalThis.HydraBeatClock.snapshot(source) });
  const synthInput = globalThis.HydraElevenSource?.create({
    getState: () => state, loadSeries: loadSourceSeries
  });
  globalThis.HydraSynthMixer?.init({
    container: document.getElementById("synth-mixer-workspace"),
    sourceBridge: synthInput && { ...synthInput, describe: () => ({ ...synthInput.describe(),
      revision: `${state.sourceMode}|${state.recording?.id}|${state.selectionGeneration}|${state.liveGeneration}` }) },
    getDestinations: () => Music.DESTINATIONS,
    transport: {
      selectPatch: (bank, number) => {
        if (state.synthOutput !== "midi") throw new Error("Select MIDI output in Connections first.");
        return selectMidiPatch({ bank, number }, "synth-mixer");
      },
      start: () => state.workspaceView === "synth-mixer" ? togglePlayback() : Promise.resolve(),
      stop: () => { if (state.playbackWorkspace === "synth-mixer") { state.playbackError = null; stopPlayback(); } },
      status: () => ({ playing: state.playbackWorkspace === "synth-mixer" && state.playing,
        preparing: state.playbackWorkspace === "synth-mixer" && state.preparing,
        patchChanging: state.patchChanging,
        output: state.synthOutput, midiReady: Boolean(state.midiOutput), currentPatch: state.currentPatch, error: state.playbackError,
        ...readMidiConnectionControls(),
        readyReason: state.workspaceView === "synth-mixer" ? playbackUnavailableReason() : "" })
    }
  });
  globalThis.HydraWorkspace?.init({
    onNavigate: selectSonificationWorkspace,
    onOutputChange: selectConnectionOutput,
    onTestAudio: testConnectionAudio
  });
  globalThis.HydraSessions?.init({
    container: document.getElementById("session-library"),
    beforeCapture: captureSessionState,
    beforeRestore: stopSessionPlayback,
    reload: reloadSession,
    getRoute: () => `#${state.workspaceView || "connections"}`
  });
  updateConnectionSummary();
}

function captureSessionState() {
  if (!state.connectionsReady) throw new Error("Wait for the saved settings to finish loading, then save the session.");
  if (!saveSettings()) throw new Error("Could not save the current controls. Free browser storage and try again.");
  saveConnectionPreferences();
  globalThis.HydraSynthMixer?.flush();
  globalThis.HydraMusicMixer?.flush();
  globalThis.HydraRapExperiment?.flush({ strict: true });
  globalThis.HydraRapResponse?.flush({ strict: true });
  globalThis.HydraElevenLabs?.flush?.({ strict: true });
  globalThis.HydraElevenRealtime?.flush?.({ strict: true });
  const robotSettings = globalThis.HydraRobotLive?.snapshot?.()?.settings;
  if (robotSettings) localStorage.setItem("hydra-robot-live-settings-v1", JSON.stringify(robotSettings));
  if (globalThis.HydraRobotDrums?.snapshot?.()?.settings) {
    localStorage.setItem("hydra-robot-drums-v1", JSON.stringify(globalThis.HydraRobotDrums.exportState()));
  }
}

function stopSessionPlayback() {
  if (!state.connectionsReady) throw new Error("Wait for the saved settings to finish loading, then load the session.");
  stopPlayback();
  globalThis.HydraSynthMixer?.deactivate();
  globalThis.HydraMusicMixer?.deactivate();
  globalThis.HydraRapExperiment?.deactivate();
  globalThis.HydraRapResponse?.deactivate();
  globalThis.HydraRobotLive?.stop();
  const drumsStopped = globalThis.HydraRobotDrums?.stop();
  const hardwareStopped = globalThis.HydraRobotControl?.deactivate();
  globalThis.HydraElevenLabs?.deactivate();
  disconnectLive();
  return Promise.all([drumsStopped, hardwareStopped]);
}

function reloadSession(route) {
  // SessionLibrary calls this only after playback cleanup and the storage
  // transaction succeed. Deactivating again on unload would save the old mixers
  // over the version we just restored.
  state.sessionReloading = true;
  try {
    window.history.replaceState(null, "", route);
    window.location.reload();
  } catch (error) {
    state.sessionReloading = false;
    throw error;
  }
}

function stopDashboardOnUnload() {
  if (state.sessionReloading) return;
  disconnectLive(); stopPlayback(); panicMidi();
  globalThis.HydraSynthMixer?.deactivate(); globalThis.HydraMusicMixer?.deactivate();
  globalThis.HydraRapExperiment?.deactivate(); globalThis.HydraElevenLabs?.deactivate();
  globalThis.HydraRapResponse?.deactivate();
  globalThis.HydraRobotLive?.stop();
  Promise.resolve(globalThis.HydraRobotControl?.deactivate()).catch(() => {});
}

function selectSonificationWorkspace(view, previous) {
  if (state.sessionReloading) return;
  if (view === state.workspaceView) return;
  // Microphone capture and automatic replies only belong to the visible tab.
  if (previous === "rap-response") globalThis.HydraRapResponse?.deactivate();
  // Navigation only changes visibility. The transport keeps its original
  // controls, output and pending preparation until explicitly stopped.
  state.workspaceView = view;
  if (!state.playing && !state.preparing) {
    state.output = view === "drums" ? "drums" : ["mixer", "rap-experiment", "rap-response"].includes(view) ? "audio" : state.synthOutput;
  }
  renderSoundControls();
  renderOutputMode();
  if (view === "elevenlabs") globalThis.HydraElevenLabs?.activate();
  if (view === "mixer") globalThis.HydraMusicMixer?.activate();
  if (view === "synth-mixer") globalThis.HydraSynthMixer?.activate();
  if (view === "rap-experiment") globalThis.HydraRapExperiment?.activate();
  if (view === "rap-response") globalThis.HydraRapResponse?.activate();
  if (view === "robot-setup" || view === "robot-control") globalThis.HydraRobotControl?.activate();
  if (view === "robot-control") globalThis.HydraRobotLive?.activate();
  if ((view === "synth-legacy" || view === "drums") && state.recording && !state.playing && !state.preparing) loadFocusedSeries();
  updateConnectionSummary();
}

function selectConnectionOutput(output) {
  if (!["audio", "midi"].includes(output)) return;
  state.midiAutoRoute = false;
  setOutput(output);
}

function updateConnectionSummary() {
  if (!globalThis.HydraWorkspace || !state.workspaceView) return;
  const live = state.sourceMode === "live";
  const connected = state.liveSocket?.readyState === 1;
  const fresh = connected && Number.isFinite(state.live?.lastAt) && performance.now() - state.live.lastAt <= 3000;
  const browserOnly = ["drums", "elevenlabs", "mixer", "rap-experiment", "rap-response"].includes(state.workspaceView);
  globalThis.HydraWorkspace.updateConnections({
    inputMode: state.sourceMode,
    inputLabel: live ? "Live RAPP stream" : state.recording?.name || "Choose an input",
    inputState: live ? fresh ? "ready" : connected ? "waiting" : state.liveWanted ? "connecting" : "offline"
      : state.recording ? "ready" : "offline",
    output: state.synthOutput,
    outputLabel: browserOnly || state.synthOutput === "audio" ? "Browser audio" : state.midiOutput?.name || "MIDI · connect a device",
    outputState: browserOnly || state.synthOutput === "audio" || state.midiOutput ? "ready" : "warning",
    midiReady: Boolean(state.midiOutput)
  });
}

async function testConnectionAudio() {
  try {
    await ensureAudioEngine();
    const { context, master } = state.audio;
    const oscillator = context.createOscillator(), gain = context.createGain();
    const now = context.currentTime;
    oscillator.frequency.value = 440;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.02);
    gain.gain.linearRampToValueAtTime(0, now + 0.3);
    oscillator.connect(gain); gain.connect(master);
    oscillator.addEventListener("ended", () => { oscillator.disconnect(); gain.disconnect(); }, { once: true });
    oscillator.start(now); oscillator.stop(now + 0.31);
    showToast("Browser audio test played");
  } catch (error) {
    showToast(error.message || "Browser audio is unavailable");
    throw error;
  }
}

function handlePlaybackShortcut(event) {
  if (event.defaultPrevented || document.body.classList.contains("observer-overlay-open")) return;
  if (document.querySelector("dialog[open]")) return;
  if (state.workspaceView && !["synth-legacy", "synth-mixer", "drums"].includes(state.workspaceView)) return;
  if (event.key === "Escape" && (state.playing || state.preparing)) stopPlayback();
  if (event.code === "Space" && !event.repeat && !isEditable(event.target)) {
    event.preventDefault();
    togglePlayback();
  }
}

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
    "preview-button", "playback-help", "signal-title", "signal-min", "signal-max", "waveform",
    "signal-area", "signal-line", "playhead", "wave-empty", "wave-progress",
    "add-mapping", "mapping-rows", "mapping-help", "wave-type", "voice-name",
    "attack", "attack-output", "release", "release-output", "brightness",
    "brightness-output", "scale-copy", "scale-root", "scale-name", "piano-roll",
    "midi-panel", "midi-output", "midi-status", "midi-choice-detail",
    "connect-midi", "panic-button", "recording-link-status", "footer-clock",
    "session-state", "mapping-template", "mapping-source-template", "toast",
    "mapping-tabs", "tab-name", "new-tab", "duplicate-tab", "remove-tab", "undo-tab",
    "save-preset", "saved-presets", "load-preset", "delete-preset", "export-presets",
    "import-presets", "preset-file", "random-count", "random-style", "randomize-mappings",
    "workspace-status", "rhythm-pattern", "rhythm-readout", "density", "rotation",
    "ratchet", "swing", "accent", "loop", "mapping-panel",
    "voices", "voicing", "inversion", "spread", "harmony-readout", "preview-voice",
    "sound-mode", "sound-every", "sound-help", "sound-status", "patch-controls",
    "patch-pool", "patch-list", "patch-bank", "patch-number", "apply-patch",
    "random-palette", "catalog-status", "midi-format", "midi-rate", "midi-parameter-status",
    "parameter-picker", "picker-close", "picker-search", "picker-group", "picker-results", "picker-prev", "picker-next",
    "picker-page", "picker-status", "picker-add", "picker-select-page", "picker-select-group", "picker-clear", "picker-description",
    "live-url", "live-connect", "live-disconnect", "live-reconnect", "live-status", "live-reset-ranges", "return-to-recording",
    ...Object.values(DRUM_CONTROL_IDS), "drum-panel", "drum-grid", "drum-sources", "drum-source-summary",
    "drum-auto-sources", "drum-activity", "drum-activity-value", "drum-tempo-readout", "drum-density-readout", "drum-status"
  ].forEach((id) => { dom[id] = document.getElementById(id); });
  dom.outputButtons = Array.from(document.querySelectorAll("[data-output]"));
}

function bindInterface() {
  dom["refresh-recordings"].addEventListener("click", async () => {
    try { if (!state.catalogReady) await loadParameterCatalog(); await loadRecordings(true); }
    catch (error) { showToast(error.message); }
  });
  dom["preview-button"].addEventListener("click", togglePlayback);
  dom["add-mapping"].addEventListener("click", () => {
    if (!state.fields.length || state.mappings.length >= MAX_MAPPINGS) return;
    const usedDestinations = new Set(state.mappings.flatMap((mapping) => Music.mappingTargets(mapping).map((target) => target.destination)));
    const destination = DESTINATIONS.find((item) => !usedDestinations.has(item.id)) || DESTINATIONS[0];
    state.mappings.push(createMapping(state.fields[state.mappings.length % state.fields.length], destination.id));
    state.focusedMappingId = state.mappings[state.mappings.length - 1].id;
    renderMappings();
    loadFocusedSeries();
    refreshPlaybackSeries();
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
  dom["apply-patch"].addEventListener("click", applyMidiPatch);
  Object.values(CONTROL_IDS).forEach((id) => {
    dom[id].addEventListener("input", () => {
      if (["sound-mode", "sound-every", "patch-pool", "patch-list", "midi-format", "midi-rate"].includes(id)) stopPlayback();
      if (["wave-type", "attack", "release", "brightness"].includes(id)) {
        dom["preview-voice"].value = "custom";
        state.currentPreviewVoice = null;
      }
      if (id === "preview-voice") {
        const voice = Music.VOICES.find((item) => item.id === dom[id].value);
        if (voice) for (const key of ["waveType", "attack", "release", "brightness"]) dom[CONTROL_IDS[key]].value = voice[key];
        state.currentPreviewVoice = null;
      }
      updateControlReadouts();
      renderScale();
      renderRhythm();
      saveSettings();

    });
  });
  dom["waveform"].addEventListener("pointerdown", seekFromPointer);
  dom["waveform"].addEventListener("keydown", (event) => {
    if (state.sourceMode === "live") return;
    if (!state.recording) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      state.cursor = clamp(state.cursor + (event.key === "ArrowLeft" ? -1 : 1), 0, state.maxSteps - 1);
      if (state.output === "drums") {
        state.drumOrigin = performance.now() - state.cursor / Math.max(1, state.maxSteps - 1) * state.drumDuration * 1000;
        state.drumMotion?.reset();
      }
      updatePlayhead();
    }
  });
  document.addEventListener("keydown", handlePlaybackShortcut);
  window.addEventListener("beforeunload", stopDashboardOnUnload);
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
    if (state.sourceMode === "live") return;
    const preferredId = state.recording?.id || state.saved.lastRecording || state.library.recordings[0].id;
    const preferred = state.library.recordings.find((item) => item.id === preferredId) || state.library.recordings[0];
    await selectRecording(preferred.id);
    setEngineState("ready", "Preview engine ready", `${state.library.recordings.length} recordings · browser audio available`);
  } catch (error) {
    renderRecordingError(error instanceof Error ? error.message : "Unable to load recordings");
    setEngineState("error", "Recording link unavailable", "The dashboard is still available");
  } finally {
    dom["recording-list"].setAttribute("aria-busy", "false");
    renderPlaybackAvailability();
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
  stopPlayback();
  saveSettings();
  if (state.sourceMode === "live") disconnectLive();
  state.sourceMode = "recording";
  updateLiveStatus();
  state.selectionGeneration += 1;
  const recording = state.library?.recordings.find((item) => item.id === recordingId);
  if (!recording) return;
  state.recording = recording;
  state.cursor = 0;
  state.fields = fieldsForRecording(recording);
  state.fieldIndex = new Map(state.fields.map((field) => [field.key, field]));
  state.seriesCache = new Map();
  state.saved.lastRecording = recording.id;
  const workspace = Music.restoreWorkspace(state.saved, recording.id, state.fields, () => state.nextMappingId++, createDefaultMappings);
  state.tabs = workspace.tabs;
  state.activeTabId = state.tabs[workspace.activeIndex].id;
  state.mappings = activeTab().mappings;
  applyMusicalControls(activeTab().controls);
  state.focusedMappingId = state.mappings[0]?.id || null;
  state.removedTab = null;
  renderWorkspaces();
  dom["recording-title"].textContent = recording.name;
  dom["recording-detail"].textContent = `${formatInteger(recording.frames)} JSON frames · ${recording.channels.length} channels · ${formatBytes(recording.size_bytes)}`;
  renderPlaybackAvailability();
  dom["add-mapping"].disabled = !state.fields.length;
  renderRecordingList();
  renderMappings();
  saveSettings();
  await loadFocusedSeries();
}


const CONTROL_IDS = {
  tempo: "tempo", stepsPerBeat: "steps-per-beat", waveType: "wave-type", attack: "attack",
  release: "release", brightness: "brightness", scaleRoot: "scale-root", scaleName: "scale-name",
  density: "density", rotation: "rotation", ratchet: "ratchet", swing: "swing", accent: "accent", loop: "loop",
  voices: "voices", voicing: "voicing", inversion: "inversion", spread: "spread", previewVoice: "preview-voice",
  soundMode: "sound-mode", soundEvery: "sound-every", patchPool: "patch-pool", patchList: "patch-list",
  patchBank: "patch-bank", patchNumber: "patch-number", midiFormat: "midi-format", midiRate: "midi-rate"
};

function readMusicalControls() {
  return Music.controls({ ...Object.fromEntries(Object.entries(CONTROL_IDS).map(([key, id]) =>
    [key, key === "loop" ? dom[id].checked : dom[id].value])),
    ...readDrumControls(), output: state.output });
}

function activeSynthMixer() {
  const workspace = state.playing || state.preparing ? state.playbackWorkspace : state.workspaceView;
  return workspace === "synth-mixer" ? globalThis.HydraSynthMixer : null;
}

function readMidiConnectionControls() {
  const controls = Music.controls({ midiFormat: dom["midi-format"]?.value, midiRate: dom["midi-rate"]?.value });
  return { midiFormat: controls.midiFormat, midiRate: controls.midiRate };
}

// Playback can use the experimental workspace without changing the original
// Synth's controls, mappings, or the snapshots persisted by saveSettings().
function readPlaybackControls() {
  const mixer = activeSynthMixer();
  return mixer ? Music.controls({ ...mixer.getControls(), ...readMidiConnectionControls(), output: state.output }) : readMusicalControls();
}

function applyMusicalControls(raw) {
  state.currentPreviewVoice = null;
  const controls = Music.controls(state.connectionsReady ? { ...raw, ...readMidiConnectionControls() } : raw);
  Object.entries(CONTROL_IDS).forEach(([key, id]) => {
    if (key === "loop") dom[id].checked = controls[key];
    else dom[id].value = String(controls[key]);
  });
  applyDrumControls(controls);
  if (!state.playing && !state.preparing) state.output = state.workspaceView ? state.workspaceView === "drums" ? "drums" : state.workspaceView === "mixer" ? "audio" : state.synthOutput : controls.output;
  renderOutputMode();
  updateControlReadouts();
  renderScale();
  renderRhythm();
}

function activeTab() {
  return state.tabs.find((tab) => tab.id === state.activeTabId);
}

function commitActiveTab() {
  const tab = activeTab();
  if (tab) { tab.mappings = state.mappings; tab.controls = readMusicalControls(); }
}

function activateTab(id) {
  const tab = state.tabs.find((candidate) => candidate.id === id);
  if (!tab) return;
  commitActiveTab();
  stopPlayback();
  state.selectionGeneration += 1;
  state.activeTabId = id;
  state.mappings = tab.mappings;
  state.focusedMappingId = state.mappings[0]?.id || null;
  state.cursor = 0;
  applyMusicalControls(tab.controls);
  renderWorkspaces();
  renderMappings();
  loadFocusedSeries();
  saveSettings();
}

function addTab(name, mappings = [], controls = readMusicalControls()) {
  if (!state.recording) return false;
  if (state.tabs.length >= MAX_TABS) {
    showToast(`Keep up to ${MAX_TABS} tabs per recording. Save a preset before removing a tab.`);
    return false;
  }
  const tab = { id: state.nextMappingId++, name: String(name).slice(0, 60), controls: Music.controls(controls),
    mappings: Music.restoreMappings(mappings, state.fields, () => state.nextMappingId++, { allowMissing: state.sourceMode === "live" }) };
  state.tabs.push(tab);
  activateTab(tab.id);
  return true;
}

function presetLibrary() {
  if (!Array.isArray(state.saved.presets)) state.saved.presets = [];
  state.saved.presets = state.saved.presets.filter((preset) => preset && typeof preset.id === "string" && Array.isArray(preset.mappings)).slice(0, MAX_PRESETS);
  return state.saved.presets;
}

function renderWorkspaces() {
  const current = activeTab();
  dom["mapping-tabs"].replaceChildren(...state.tabs.map((tab) => {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `mapping-tab-${tab.id}`;
    button.className = "mapping-tab";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", "mapping-panel");
    button.setAttribute("aria-selected", String(tab.id === state.activeTabId));
    button.tabIndex = tab.id === state.activeTabId ? 0 : -1;
    button.textContent = tab.name;
    button.title = `${tab.name} · ${tab.mappings.length} mappings`;
    button.addEventListener("click", () => activateTab(tab.id));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = state.tabs.indexOf(tab);
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? state.tabs.length - 1
        : (index + (event.key === "ArrowLeft" ? -1 : 1) + state.tabs.length) % state.tabs.length;
      activateTab(state.tabs[nextIndex].id);
      document.getElementById(`mapping-tab-${state.activeTabId}`).focus();
    });
    return button;
  }));
  dom["tab-name"].value = current?.name || "";
  dom["tab-name"].disabled = !current;
  dom["mapping-panel"].setAttribute("aria-labelledby", current ? `mapping-tab-${current.id}` : "mapping-title");
  ["new-tab", "duplicate-tab", "randomize-mappings"].forEach((id) => {
    dom[id].disabled = !state.fields.length || state.tabs.length >= MAX_TABS;
  });
  dom["remove-tab"].disabled = state.tabs.length <= 1;
  dom["undo-tab"].hidden = !state.removedTab;
  dom["undo-tab"].disabled = state.tabs.length >= MAX_TABS;
  dom["save-preset"].disabled = !current || presetLibrary().length >= MAX_PRESETS;
  const picker = dom["saved-presets"];
  picker.replaceChildren(new Option("Saved presets…", ""));
  presetLibrary().forEach((preset) => picker.add(new Option(`${preset.name} · ${preset.recording}`, preset.id)));
  picker.value = state.selectedPreset;
  dom["load-preset"].disabled = !picker.value || !state.recording || state.tabs.length >= MAX_TABS;
  dom["delete-preset"].disabled = !picker.value;
  dom["export-presets"].disabled = !presetLibrary().length;
}

function bindWorkspaces() {
  dom["new-tab"].addEventListener("click", () => addTab(`Idea ${state.tabs.length + 1}`));
  dom["duplicate-tab"].addEventListener("click", () => {
    commitActiveTab();
    const tab = activeTab();
    if (tab) addTab(`${tab.name} copy`, tab.mappings, tab.controls);
  });
  dom["tab-name"].addEventListener("change", () => {
    const tab = activeTab();
    if (!tab) return;
    tab.name = dom["tab-name"].value.trim().slice(0, 60) || "Untitled";
    saveSettings();
    renderWorkspaces();
  });
  dom["remove-tab"].addEventListener("click", () => {
    if (state.tabs.length <= 1) return;
    commitActiveTab();
    state.removedTab = Music.serializeTab(activeTab());
    state.tabs = state.tabs.filter((tab) => tab.id !== state.activeTabId);
    activateTab(state.tabs[0].id);
  });
  dom["undo-tab"].addEventListener("click", () => {
    if (!state.removedTab) return;
    const tab = state.removedTab;
    if (addTab(tab.name, tab.mappings, tab.controls)) state.removedTab = null;
    renderWorkspaces();
  });
  const updateGeneratorCounts = () => {
    const fullEngine = dom["random-palette"].value === "engine";
    for (const option of dom["random-count"].options) option.disabled = !fullEngine && Number(option.value) > 27;
    if (!fullEngine && Number(dom["random-count"].value) > 27) dom["random-count"].value = "27";
  };
  dom["random-palette"].addEventListener("change", updateGeneratorCounts);
  updateGeneratorCounts();
  dom["randomize-mappings"].addEventListener("click", () => {
    const style = dom["random-style"].value;
    const fullEngine = dom["random-palette"].value === "engine";
    const count = dom["random-count"].value === "all" ? (fullEngine ? 2048 : 27) : Number(dom["random-count"].value);
    const mappings = fullEngine ? generateEngineMappings(count, style) : Music.randomMappings(state.fields, count, style);
    const voice = { ...readMusicalControls(), waveType: style === "wild" ? "sawtooth" : "triangle",
      stepsPerBeat: style === "rhythmic" ? 4 : 2, attack: 2, release: style === "rhythmic" ? 12 : 32,
      voices: 3, previewVoice: "custom", midiFormat: fullEngine ? "nrpn" : readMusicalControls().midiFormat,
      soundMode: mappings.some((mapping) => Music.mappingTargets(mapping).some((target) => target.destination === "sound")) ? "mapped" : "cycle" };
    if (addTab(`${style[0].toUpperCase()}${style.slice(1)} ${state.tabs.length + 1}`, mappings, voice)) {
      dom["workspace-status"].textContent = `${Music.targetCount(mappings)} destinations across ${mappings.length} input recipes. ${fullEngine ? "Full engine targets play through Hydrasynth MIDI with PARAM RX = NRPN." : "Press Preview to hear this tab."}`;
    }
  });
  dom["save-preset"].addEventListener("click", savePreset);
  dom["saved-presets"].addEventListener("change", () => {
    state.selectedPreset = dom["saved-presets"].value;
    renderWorkspaces();
  });
  dom["load-preset"].addEventListener("click", () => {
    const preset = presetLibrary().find((item) => item.id === state.selectedPreset);
    if (!preset) return;
    const mappings = Music.restoreMappings(preset.mappings, state.fields, () => state.nextMappingId++, { allowMissing: state.sourceMode === "live" });
    if (preset.controls?.output !== "drums" && preset.mappings.length && !mappings.length) {
      dom["workspace-status"].textContent = `This preset needs fields from ${preset.recording}. Select a compatible recording first.`;
      return;
    }
    if (addTab(preset.name, mappings, preset.controls)) {
      const omitted = preset.mappings.length - mappings.length;
      dom["workspace-status"].textContent = omitted
        ? `Opened ${mappings.length} mappings. ${omitted} recipes need fields absent from this recording and were omitted. The saved preset is unchanged.`
        : `Opened “${preset.name}” in a new tab.`;
    }
  });
  dom["delete-preset"].addEventListener("click", () => {
    state.saved.presets = presetLibrary().filter((item) => item.id !== state.selectedPreset);
    state.selectedPreset = "";
    saveSettings();
    renderWorkspaces();
  });
  dom["export-presets"].addEventListener("click", () => {
    const data = JSON.stringify({ format: "hydra-signal-lab-presets", version: 1,
      presets: presetLibrary().map(({ id, ...preset }) => preset) }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "hydra-signal-lab-presets.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  dom["import-presets"].addEventListener("click", () => dom["preset-file"].click());
  dom["preset-file"].addEventListener("change", importPresets);
  renderWorkspaces();
}

function savePreset() {
  commitActiveTab();
  const tab = activeTab();
  if (!tab || presetLibrary().length >= MAX_PRESETS) return;
  const preset = { ...Music.serializeTab(tab), id: `preset-${Date.now()}-${state.nextMappingId++}`,
    recording: state.recording.name };
  const names = new Set(presetLibrary().map((item) => item.name));
  let suffix = 2;
  while (names.has(preset.name)) preset.name = `${tab.name} (${suffix++})`;
  state.saved.presets.push(preset);
  state.selectedPreset = preset.id;
  if (saveSettings()) dom["workspace-status"].textContent = `Saved “${preset.name}” in this browser. Export presets to keep a portable copy.`;
  renderWorkspaces();
}

async function importPresets() {
  const file = dom["preset-file"].files[0];
  dom["preset-file"].value = "";
  if (!file) return;
  try {
    if (file.size > 32 * 1024 * 1024) throw new Error("Choose a preset file smaller than 32 MB.");
    const presets = Music.parsePresetFile(JSON.parse(await file.text()));
    if (presetLibrary().length + presets.length > MAX_PRESETS) throw new Error(`Keep up to ${MAX_PRESETS} saved presets; export and remove some first.`);
    state.saved.presets.push(...presets.map((preset) => ({ ...preset, id: `preset-${Date.now()}-${state.nextMappingId++}` })));
    if (saveSettings()) dom["workspace-status"].textContent = `Imported ${presets.length} presets. Choose one to open in a new tab.`;
    renderWorkspaces();
  } catch (error) {
    dom["workspace-status"].textContent = error.message || "Could not read the preset file.";
  }
}

function renderRhythm(values = readMusicalControls(), currentStep = -1) {
  const pattern = Music.rhythmPattern(values.density, values.rotation);
  if (!dom["rhythm-pattern"].children.length) {
    dom["rhythm-pattern"].replaceChildren(...pattern.map((_, index) => {
      const cell = document.createElement("span");
      cell.className = "rhythm-step";
      cell.textContent = String(index + 1);
      return cell;
    }));
  }
  Array.from(dom["rhythm-pattern"].children).forEach((cell, index) => {
    cell.classList.toggle("is-hit", pattern[index]);
    cell.classList.toggle("is-current", index === currentStep % 16);
  });
  dom["rhythm-pattern"].setAttribute("aria-label", `${pattern.filter(Boolean).length} hits in 16 steps, rotation ${Math.round(values.rotation)}`);
  ["density", "rotation", "ratchet", "swing", "accent"].forEach((id) => {
    const mapped = state.mappings.some((mapping) => Music.mappingTargets(mapping).some((target) => target.enabled !== false && target.destination === id));
    dom[id].parentElement.classList.toggle("is-mapped", mapped);
    dom[id].title = mapped ? "A signal mapping overrides this base value during playback." : "Base rhythm setting";
  });
  dom["rhythm-readout"].textContent = state.playing
    ? `${Math.round(values.tempo)} BPM · ${Math.round(values.density)} hits · ${Math.round(values.ratchet)} repeats · ${Math.round(values.swing)}% swing`
    : "Map signals to rhythm destinations below. Green labels have mappings that override their base settings.";
}

function fieldsForRecording(recording) {
  return recording.channels.flatMap((channel) => channel.fields.map((field) => ({
    ...field,
    key: `${encodeURIComponent(channel.id)}|${encodeURIComponent(field.id)}`,
    channelId: channel.id,
    channelName: channel.name,
    fieldId: field.id,
    optionLabel: field.name
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
    weight: 1,
    rangeMode: "auto",
    inputMin: -1,
    inputMax: 1
  };
}

function renderMappings() {
  dom["add-mapping"].disabled = !state.fields.length || state.mappings.length >= MAX_MAPPINGS;
  renderPlaybackAvailability();
  renderRhythm();
  renderHarmony();
  renderSoundControls();
  dom["mapping-rows"].replaceChildren();
  if (!state.mappings.length) {
    if (!activeSynthMixer() && state.output !== "drums" && (state.playing || state.preparing)) stopPlayback();
    const placeholder = document.createElement("div");
    placeholder.className = "mapping-placeholder";
    placeholder.textContent = "Add a mapping to turn a signal into sound.";
    dom["mapping-rows"].append(placeholder);
    if (state.output !== "drums") clearWaveform();
    return;
  }
  state.mappings.forEach((mapping) => {
    const fragment = dom["mapping-template"].content.cloneNode(true);
    const row = fragment.querySelector(".mapping-row");
    const sourcesContainer = fragment.querySelector('[data-role="sources"]');
    const operatorSelect = fragment.querySelector('[data-role="operator"]');
    const addSourceButton = fragment.querySelector('[data-role="add-source"]');
    const targetsContainer = fragment.querySelector('[data-role="targets"]');
    const targets = ensureTargets(mapping);
    fragment.querySelector('[data-role="target-count"]').textContent = `${targets.length} destination${targets.length === 1 ? "" : "s"}`;
    fragment.querySelector('[data-role="add-targets"]').addEventListener("click", () => openParameterPicker(mapping.id));
    const visible = state.expandedTargets.has(mapping.id) ? targets : targets.slice(0, 3);
    visible.forEach((target, index) => targetsContainer.append(renderMappingTarget(mapping, target, index)));
    if (targets.length > 3) {
      const more = document.createElement("button"); more.type = "button"; more.className = "small-button target-more";
      more.textContent = state.expandedTargets.has(mapping.id) ? "Show fewer" : `Show ${targets.length - 3} more destinations`;
      more.addEventListener("click", () => {
        if (state.expandedTargets.has(mapping.id)) state.expandedTargets.delete(mapping.id);
        else state.expandedTargets.add(mapping.id);
        renderMappings();
      });
      targetsContainer.append(more);
    }
    const removeButton = fragment.querySelector('[data-role="remove"]');
    row.dataset.mappingId = String(mapping.id);
    row.classList.toggle("is-focused", mapping.id === state.focusedMappingId);
    operatorSelect.value = mapping.sources.length === 1 ? "direct" : mapping.operator;
    operatorSelect.disabled = mapping.sources.length === 1;
    addSourceButton.disabled = !state.fields.length || mapping.sources.length >= MAX_MAPPING_SOURCES;
    mapping.sources.forEach((source, sourceIndex) => {
      sourcesContainer.append(renderMappingSource(mapping, source, sourceIndex));
    });

    row.addEventListener("pointerdown", () => focusMapping(mapping.id));
    operatorSelect.addEventListener("change", () => {
      mapping.operator = COMBINE_OPERATORS.has(operatorSelect.value)
        ? operatorSelect.value
        : "average";
      mappingChanged(mapping, true);
    });
    addSourceButton.addEventListener("click", () => {
      if (!state.fields.length || mapping.sources.length >= MAX_MAPPING_SOURCES) return;
      const field = state.fields[(mapping.sources.length + state.mappings.indexOf(mapping)) % state.fields.length];
      mapping.sources.push(createMappingSource(field));
      if (mapping.operator === "direct") mapping.operator = "average";
      mappingChanged(mapping, true);
    });
    removeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      mapping.sources.forEach(resetMappingSourceRange);
      state.mappings = state.mappings.filter((candidate) => candidate.id !== mapping.id);
      if (state.focusedMappingId === mapping.id) state.focusedMappingId = state.mappings[0]?.id || null;
      renderMappings();
      loadFocusedSeries();
      refreshPlaybackSeries();
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
  const rangeDetails = fragment.querySelector(".source-range");
  rangeDetails.open = state.openInputRanges.has(source);
  rangeDetails.addEventListener("toggle", () => {
    if (rangeDetails.open) state.openInputRanges.add(source);
    else state.openInputRanges.delete(source);
  });
  sourceRow.dataset.sourceIndex = String(sourceIndex);
  sourceNumber.textContent = String(sourceIndex + 1);
  appendGroupedOptions(sourceSelect, state.fields, "channelName", "key", "optionLabel");
  if (!state.fieldIndex.has(source.sourceKey)) sourceSelect.add(new Option(`Waiting for ${source.sourceKey}`, source.sourceKey));
  sourceSelect.value = source.sourceKey;
  const field = state.fieldIndex.get(source.sourceKey) || { reducers: ["value", "mean", "rms", "minimum", "maximum", "index"] };
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
    resetMappingSourceRange(source);
    mappingChanged(mapping, true);
  });
  reducerSelect.addEventListener("change", () => {
    source.reducer = reducerSelect.value;
    resetMappingSourceRange(source);
    mappingChanged(mapping, true);
  });
  indexInput.addEventListener("change", () => {
    source.index = Math.round(clamp(Number(indexInput.value) || 0, 0, 1_000_000));
    resetMappingSourceRange(source);
    mappingChanged(mapping, true);
  });
  weightInput.addEventListener("change", () => {
    source.weight = clamp(Number(weightInput.value) || 0, 0, 10);
    mappingChanged(mapping, true);
  });
  removeSourceButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (mapping.sources.length === 1) return;
    resetMappingSourceRange(source);
    mapping.sources.splice(sourceIndex, 1);
    if (mapping.sources.length === 1) mapping.operator = "direct";
    mappingChanged(mapping, true);
  });
  const rangeMode = fragment.querySelector('[data-role="range-mode"]');
  const inputMin = fragment.querySelector('[data-role="input-min"]');
  const inputMax = fragment.querySelector('[data-role="input-max"]');
  rangeMode.value = source.rangeMode || "auto";
  inputMin.value = source.inputMin ?? -1; inputMax.value = source.inputMax ?? 1;
  inputMin.disabled = inputMax.disabled = rangeMode.value !== "fixed";
  rangeMode.addEventListener("change", () => {
    source.rangeMode = rangeMode.value;
    if (source.rangeMode === "fixed") {
      const bounds = usableFixedRange(learnedMappingRange(source));
      source.inputMin = bounds?.minimum ?? source.inputMin ?? -1;
      source.inputMax = bounds?.maximum ?? source.inputMax ?? 1;
    } else resetMappingSourceRange(source);
    mappingChanged(mapping, true);
  });
  [inputMin, inputMax].forEach((input) => input.addEventListener("change", () => {
    const minimum = Number(inputMin.value), maximum = Number(inputMax.value);
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) {
      showToast("Input range To must be greater than From."); renderMappings(); return;
    }
    source.inputMin = minimum; source.inputMax = maximum; mappingChanged(mapping, true);
  }));
  fragment.querySelector('[data-role="freeze-range"]').addEventListener("click", () => {
    const bounds = usableFixedRange(learnedMappingRange(source));
    if (!bounds) return;
    Object.assign(source, { rangeMode: "fixed", inputMin: bounds.minimum, inputMax: bounds.maximum });
    mappingChanged(mapping, true);
  });
  fragment.querySelector('[data-role="relearn-range"]').addEventListener("click", () => {
    source.rangeMode = "auto"; resetMappingSourceRange(source); mappingChanged(mapping, true);
  });
  updateMappingSourceRange(sourceRow, source);
  if (state.sourceMode !== "live") {
    loadMappingSourceSeries(source).then(() => {
      if (sourceRow.isConnected) updateMappingSourceRange(sourceRow, source);
    }).catch(() => {}); // The waveform and transport report source loading failures.
  }
  return sourceRow;
}

function mappingSourceIdentity(source) {
  return JSON.stringify([state.recording?.id, source.sourceKey, source.reducer, source.index]);
}

function learnedMappingRange(source) {
  if (state.sourceMode === "live") return state.live?.getRange(source) || null;
  const range = state.mappingRanges.get(source);
  return range?.identity === mappingSourceIdentity(source) ? range : null;
}

function resetMappingSourceRange(source) {
  state.mappingRanges.delete(source);
  state.live?.resetRange(source);
}

function usableFixedRange(range) {
  if (!range || !Number.isFinite(range.minimum) || !Number.isFinite(range.maximum)) return null;
  if (range.maximum > range.minimum) return range;
  const padding = Math.max(0.001, Math.abs(range.minimum) * 0.01);
  return { minimum: range.minimum - padding, maximum: range.maximum + padding };
}

function updateMappingSourceRange(row, source) {
  if (state.sourceMode === "live" && state.liveSocket?.readyState === 1) state.live?.read(source, performance.now());
  const range = learnedMappingRange(source), fixed = source.rangeMode === "fixed";
  const text = (minimum, maximum) => `${formatNumber(minimum)} to ${formatNumber(maximum)}`;
  row.querySelector('[data-role="range-summary"]').textContent = fixed
    ? `Fixed · ${text(source.inputMin, source.inputMax)}`
    : range ? `Auto learn · ${text(range.minimum, range.maximum)}` : "Auto learn · waiting for data";
  row.querySelector('[data-role="range-status"]').textContent = fixed
    ? "Values outside this range are limited to its ends. Relearn starts automatic mapping again."
    : !range ? (state.sourceMode === "live" ? "Waiting for fresh input. A constant signal maps to the middle." : "Learning the full recording range…")
    : state.sourceMode === "live" ? "Learns each fresh sample. Freeze to keep this range, or Relearn to start again."
    : "Learned from the full recording. Freeze to edit the input range.";
  row.querySelector('[data-role="freeze-range"]').disabled = fixed || !range;
  if (!fixed && range) {
    row.querySelector('[data-role="input-min"]').value = range.minimum;
    row.querySelector('[data-role="input-max"]').value = range.maximum;
  }
}

function updateMappingRangeReadouts() {
  dom["mapping-rows"]?.querySelectorAll(".mapping-row").forEach((row) => {
    const mapping = state.mappings.find((candidate) => candidate.id === Number(row.dataset.mappingId));
    if (!mapping) return;
    row.querySelectorAll(".mapping-source").forEach((sourceRow) => {
      const source = mapping.sources[Number(sourceRow.dataset.sourceIndex)];
      if (source) updateMappingSourceRange(sourceRow, source);
    });
  });
}

function mappingChanged(mapping, signalChanged) {
  syncPrimaryTarget(mapping);
  if (signalChanged) { state.livePlot?.delete(mapping.id); refreshPlaybackSeries(); }
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
  if (state.output === "drums") { await loadDrumPreview(); return; }
  if (state.sourceMode === "live") { updateSourceSummary(); drawLiveWaveform(); return; }
  const mapping = state.mappings.find((candidate) => candidate.id === state.focusedMappingId);
  if (!mapping) {
    clearWaveform();
    return;
  }
  updateSourceSummary();
  dom["wave-empty"].hidden = false;
  dom["wave-empty"].textContent = "Reducing the selected JSON signal…";
  const generation = state.selectionGeneration;
  const revision = ++state.seriesRevision;
  try {
    const series = await loadSeries(mapping);
    if (generation !== state.selectionGeneration || revision !== state.seriesRevision || mapping.id !== state.focusedMappingId) return;
    renderWaveform(series);
  } catch (error) {
    if (generation !== state.selectionGeneration || revision !== state.seriesRevision) return;
    clearWaveform(error instanceof Error ? error.message : "Signal unavailable");
  }
}

async function loadSeries(mapping) {
  const series = await Promise.all(mapping.sources.map(async (source) => {
    const loaded = await loadMappingSourceSeries(source);
    if (source.rangeMode !== "fixed") return loaded;
    if (!Number.isFinite(source.inputMin) || !Number.isFinite(source.inputMax) || source.inputMax <= source.inputMin)
      throw new Error("Input range To must be greater than From.");
    return { ...loaded, minimum: source.inputMin, maximum: source.inputMax };
  }));
  return combineSeries(series, mapping.operator, mapping.sources.map((source) => source.weight));
}

async function loadMappingSourceSeries(source) {
  const identity = mappingSourceIdentity(source), generation = state.selectionGeneration;
  const loaded = await loadSourceSeries(source);
  if (generation === state.selectionGeneration && identity === mappingSourceIdentity(source)
      && state.sourceMode !== "live" && Number.isFinite(loaded.minimum) && Number.isFinite(loaded.maximum))
    state.mappingRanges.set(source, { identity, minimum: loaded.minimum, maximum: loaded.maximum });
  return loaded;
}

async function loadMappingSet(mappings) {
  const cache = state.seriesCache;
  const requested = new Map();
  for (const mapping of mappings) {
    for (const source of mapping.sources) {
      const field = state.fieldIndex.get(source.sourceKey);
      if (!field) throw new Error("Source field unavailable");
      const key = [state.recording.id, field.channelId, field.fieldId, source.reducer, source.index].join("|");
      if (!cache.has(key)) requested.set(key, {
        channel: field.channelId, field: field.fieldId, reducer: source.reducer, index: source.index, limit: SERIES_LIMIT
      });
    }
  }
  if (requested.size) {
    const query = new URLSearchParams({ sources: JSON.stringify([...requested.values()]) });
    const request = fetch(`/api/recordings/${encodeURIComponent(state.recording.id)}/series-batch?${query}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(humanizeError(payload.error));
        if (!Array.isArray(payload.series) || payload.series.length !== requested.size) throw new Error("Incomplete recording series");
        return payload.series;
      });
    [...requested.keys()].forEach((key, index) => {
      cache.set(key, request.then((series) => series[index]));
    });
    // Every cached promise is consumed below, including batch failures.
  }
  const loads = mappings.map(async (mapping) => [mapping.id, await loadSeries(mapping)]);
  try { return await Promise.all(loads); }
  catch (error) { requested.forEach((_source, key) => cache.delete(key)); throw error; }
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
  const cache = state.seriesCache;
  const request = fetch(`/api/recordings/${encodeURIComponent(state.recording.id)}/series?${query}`, { cache: "no-store" })
    .then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(humanizeError(payload.error));
      return payload;
    });
  cache.set(cacheKey, request);
  try { return await request; }
  catch (error) { cache.delete(cacheKey); throw error; }
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
  return {
    points,
    minimum: operator === "difference" ? -1 : 0,
    maximum: operator === "sum" ? usable.length : 1,
    composite: true,
    source_count: usable.length,
    operator
  };
}

function combineValues(values, operator, weights = []) {
  if (!values.length) return 0.5;
  if (operator === "direct") return values[0];
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
  if (!state.playing && !state.preparing) state.maxSteps = Math.max(2, points.length);
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

function playbackUnavailableReason() {
  const mixer = activeSynthMixer();
  if (mixer) {
    if (state.synthOutput === "midi" && !state.midiOutput) return "Connect a MIDI device in Connections before playing.";
    return mixer.readyReason() || "";
  }
  if (state.workspaceView === "synth-legacy" && state.synthOutput === "midi" && !state.midiOutput) return "Connect a MIDI device in Connections before playing.";
  if (!state.recording) return "Choose a recording or connect live movement data to enable Preview.";
  if (state.sourceMode === "live") {
    if (state.liveSocket?.readyState !== 1) return "Live input is disconnected. Connect live or return to a recording to enable Preview.";
    if (!state.fields.length) return "Live input is connected. Waiting for movement data before Preview is available.";
  }
  if (state.output === "drums") {
    const keys = drumSourceKeys();
    if (!keys.length) return "No movement signals are available. Choose another recording or connect live data.";
    if (keys.some((key) => !state.fieldIndex.has(key))) return "Some selected movement signals are missing. Use Auto-select movement or choose available sources.";
  } else if (!state.mappings.length) return "Add a mapping or generate a tab to enable Preview.";
  return "";
}

function renderPlaybackAvailability() {
  updateConnectionSummary();
  const reason = playbackUnavailableReason();
  const active = state.playing || state.preparing;
  if (dom["preview-button"]) {
    // Missing input must never prevent the user from stopping or canceling.
    dom["preview-button"].disabled = !active && Boolean(reason);
    dom["preview-button"].title = active ? "" : reason;
  }
  if (dom["playback-help"]) {
    dom["playback-help"].textContent = reason;
    dom["playback-help"].hidden = active || !reason;
  }
  if (dom["return-to-recording"]) {
    dom["return-to-recording"].hidden = state.sourceMode !== "live";
    dom["return-to-recording"].disabled = !state.library?.recordings.length;
  }
  if (state.output === "drums" && !active && dom["drum-status"]) {
    dom["drum-status"].textContent = reason || "Ready · press Preview to hear the movement.";
  }
}

async function togglePlayback() {
  if (state.workspaceView && !["synth-legacy", "synth-mixer", "drums"].includes(state.workspaceView)) return;
  if (state.playing || state.preparing) { stopPlayback(); return; }
  const unavailable = playbackUnavailableReason();
  if (unavailable) {
    state.playbackError = unavailable;
    renderPlaybackAvailability();
    showToast(unavailable);
    return;
  }
  const generation = ++state.playbackGeneration;
  const mixer = activeSynthMixer();
  state.playbackWorkspace = state.workspaceView;
  state.playbackError = null;
  state.preparing = true;
  renderPlaybackAvailability();
  dom["preview-button"].innerHTML = "<span>■</span> Cancel";
  dom["session-state"].textContent = state.output === "drums" ? "PREPARING MOVEMENT" : "PREPARING MAPPINGS";
  try {
    // Ask for audio/MIDI access in the user's click, before fetching recordings.
    if (state.output !== "midi") await ensureAudioEngine();
    else if (!state.midiOutput) await connectMidi();
    if (generation !== state.playbackGeneration) return;
    if (state.output === "midi" && !state.midiOutput) throw new Error("Choose a MIDI destination before playing");
    const settings = readPlaybackControls();
    if (state.output === "midi" && settings.soundMode !== "off") Music.patchPool(settings);
    if (!mixer && state.sourceMode === "live" && state.liveSocket?.readyState !== 1) throw new Error("Connect a live stream before playing");
    const loaded = mixer || state.sourceMode === "live" ? [] : state.output === "drums"
      ? await loadDrumSeries() : await loadMappingSet(state.mappings);
    if (generation !== state.playbackGeneration) return;
    mixer?.reset();
    if (state.output === "drums") {
      if (state.sourceMode !== "live") acceptDrumSeries(loaded);
      state.drumPlayingKeys = [...drumSourceKeys()];
    }
    state.playSeries = new Map(loaded);
    state.maxSteps = Math.max(...loaded.map(([_id, series]) => series.points.length), 2);
    state.cursor = clamp(state.cursor, 0, state.maxSteps - 1);
    if (state.output === "drums" && state.sourceMode !== "live" && state.cursor >= state.maxSteps - 1) state.cursor = 0;
    state.preparing = false;
    state.playing = true;
    const mappingRevision = mappingPlaybackStudy(true, "started");
    recordStudyEvent("synth.transport.started", { generation, workspace: state.playbackWorkspace, output: state.output,
      source_mode: state.sourceMode, recording_id: state.recording?.id || null, controls: settings,
      mapping_revision_id: mappingRevision?.revision_id || null });
    state.rhythmStep = 0;
    state.currentPreviewVoice = null;
    state.lastSoundChange = -Infinity;
    state.nextTickAt = performance.now();
    if (state.output === "drums") {
      state.drumMotion = new Drums.Motion();
      state.drumActivity = 0;
      state.drumOrigin = performance.now() - (state.cursor / Math.max(1, state.maxSteps - 1)) * state.drumDuration * 1000;
      state.drumEngine ||= new Drums.Engine(state.audio.context, state.audio.master);
    }
    dom["preview-button"].classList.add("is-playing");
    dom["preview-button"].innerHTML = "<span>■</span> Stop";
    dom["session-state"].textContent = state.output === "midi" ? "PLAYING · HYDRASYNTH MIDI" : "PLAYING · BROWSER AUDIO";
    if (state.output !== "drums") startParameterPump();
    runPlaybackTick();
  } catch (error) {
    if (generation !== state.playbackGeneration) return;
    stopPlayback();
    state.playbackError = error instanceof Error ? error.message : "Could not start playback";
    showToast(state.playbackError);
  }
}

async function refreshPlaybackSeries() {
  if (activeSynthMixer()) return;
  if (state.sourceMode === "live") return;
  if (state.preparing) { stopPlayback(); return; }
  if (!state.playing) return;
  const generation = state.playbackGeneration;
  const revision = (refreshPlaybackSeries.revision || 0) + 1;
  refreshPlaybackSeries.revision = revision;
  try {
    const loaded = await loadMappingSet(state.mappings);
    if (generation !== state.playbackGeneration || revision !== refreshPlaybackSeries.revision) return;
    state.playSeries = new Map(loaded);
  } catch (error) {
    if (generation !== state.playbackGeneration || revision !== refreshPlaybackSeries.revision) return;
    stopPlayback();
    showToast(error.message || "Could not update the playing mappings");
  }
}

async function runPlaybackTick() {
  if (!state.playing) return;
  const generation = state.playbackGeneration;
  try {
    if (state.output === "drums") { await runDrumTick(generation); return; }
    const progress = state.maxSteps > 1 ? state.cursor / (state.maxSteps - 1) : 0;
    const controls = controlsAt(progress);
    state.currentParameterCommands = controls.parameters;
    if (!controls.valid) {
      silenceStaleInput();
      scheduleNextTick(100);
      return;
    }
    if (state.liveSilenced && state.output === "audio") await ensureAudioEngine();
    if (generation !== state.playbackGeneration) return;
    state.liveSilenced = false;
    dom["session-state"].textContent = state.output === "midi" ? "PLAYING · HYDRASYNTH MIDI" : "PLAYING · BROWSER AUDIO";
    const change = changeSoundAtBoundary(controls);
    if (change) {
      if (!await change || !state.playing || generation !== state.playbackGeneration) return;
      state.nextTickAt = performance.now();
    }
    const plan = Music.rhythmStep(controls, state.rhythmStep);
    rememberSynthBeat(controls);
    const notes = Music.chordNotes(controls.pitch, controls);
    const notePatch = state.currentPatch;
    renderHarmony(controls, notes);
    if (state.output === "audio") updateAudioEffects(controls.cc, plan.interval);
    publishSignalLabActivity({ progress, ...(state.output === "audio" ? { cc: Array.from(controls.cc, ([number, value]) => ({ number, value })) } : {}) });
    plan.notes.forEach((hit) => {
      if (!state.playing || generation !== state.playbackGeneration) return;
      const sound = () => {
        if (!state.playing || generation !== state.playbackGeneration) return;
        // Keep the rhythm clock running through manual patch changes, but do
        // not send notes during loading or revive repeats from the old patch.
        if (state.output === "midi" && (state.patchChanging || state.currentPatch !== notePatch)) return;
        if ((activeSynthMixer() || state.sourceMode === "live") && !controlsAt(0).valid) { silenceStaleInput(); return; }
        try {
          notes.forEach((note) => {
            if (state.output === "midi") playMidiNote(note, hit.velocity, hit.duration);
            else playAudioNote(note, hit.velocity, hit.duration, controls.cc, 1 / Math.sqrt(notes.length));
          });
          const beatClock = globalThis.HydraBeatClock.snapshot("synth");
          globalThis.HydraRobotDrums?.recordNote({ beat: beatClock.beat, token: beatClock.token,
            notes, velocity: hit.velocity });
          publishSignalLabActivity({ progress, notes: notes.map((number) => ({ number, velocity: hit.velocity, duration_ms: hit.duration })) });
        } catch (error) {
          stopPlayback();
          state.playbackError = error.message || "The audio or MIDI output became unavailable";
          showToast(state.playbackError);
        }
      };
      if (hit.offset === 0) sound();
      else {
        const timer = window.setTimeout(() => { state.noteTimers.delete(timer); sound(); }, hit.offset);
        state.noteTimers.add(timer);
      }
    });
    if (!state.playing || generation !== state.playbackGeneration) return;
    renderRhythm(controls, state.rhythmStep);
    updatePlayhead();
    state.rhythmStep += 1;
    state.cursor += 1;
    scheduleNextTick(plan.interval);
  } catch (error) {
    if (generation !== state.playbackGeneration) return;
    stopPlayback();
    state.playbackError = error.message || "Could not play the next step";
    showToast(state.playbackError);
  }
}

function effectivePreviewVoice() {
  if (state.currentPreviewVoice) return state.currentPreviewVoice;
  if (activeSynthMixer()) {
    const settings = readPlaybackControls();
    const preset = Music.VOICES.find((voice) => voice.id === settings.previewVoice);
    return { ...preset, name: preset?.name || "Custom", waveType: settings.waveType,
      attack: settings.attack, release: settings.release, brightness: settings.brightness };
  }
  const preset = Music.VOICES.find((voice) => voice.id === dom["preview-voice"].value);
  return { ...preset, name: preset?.name || "Custom", waveType: dom["wave-type"].value,
    attack: Number(dom.attack.value), release: Number(dom.release.value), brightness: Number(dom.brightness.value) };
}

function renderHarmony(settings = readMusicalControls(), notes = Music.chordNotes(60, settings)) {
  if (!dom["harmony-readout"]) return;
  for (const id of ["voices", "inversion", "spread"]) {
    const mapped = state.mappings.some((mapping) => Music.mappingTargets(mapping).some((target) => target.enabled !== false && target.destination === id));
    dom[id].parentElement.classList.toggle("is-mapped", mapped);
    dom[id].title = mapped ? "A signal mapping overrides this base value during playback." : "Base harmony setting";
  }
  dom["harmony-readout"].textContent = `${notes.length} voice${notes.length === 1 ? "" : "s"} · ${notes.map((note) => NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1)).join(" · ")}`;
}

const patchLabel = (patch) => `${patch.bank}${String(patch.number).padStart(3, "0")}`;

function renderSoundControls() {
  if (!dom["sound-status"]) return;
  const midi = state.output === "midi";
  const settings = readMusicalControls();
  dom["patch-controls"].hidden = !midi;
  dom["patch-list"].disabled = settings.patchPool === "all";
  dom["sound-every"].disabled = settings.soundMode === "off";
  dom["sound-help"].textContent = midi
    ? "MIDI changes use the patch palette below. Changes wait at least two seconds and pause notes briefly. Follow mapping uses Sound palette position."
    : "Browser audio explores six preview sounds. Follow mapping uses the Sound palette position destination.";
  const selected = midi ? state.currentPatch ? `Sent ${patchLabel(state.currentPatch)}` : "Current synth patch"
    : effectivePreviewVoice().name;
  const mode = settings.soundMode === "off" ? "Keeping sound"
    : `${settings.soundMode === "mapped" ? "Following mapping" : settings.soundMode === "cycle" ? "Cycling" : "Random selection"} / ${settings.soundEvery} steps`;
  dom["sound-status"].textContent = `${selected} · ${mode}`;
  if (settings.soundMode === "mapped" && !state.mappings.some((mapping) => Music.mappingTargets(mapping).some((target) => target.enabled !== false && target.destination === "sound"))) {
    dom["sound-status"].textContent += " · Add a Sound palette position mapping to vary the sound";
  }
  dom["voice-name"].textContent = effectivePreviewVoice().name.toUpperCase();
}

function changeSoundAtBoundary(settings) {
  if (state.patchChanging) return null;
  if (settings.soundMode === "off" || state.rhythmStep % settings.soundEvery !== 0) return null;
  if (state.output === "audio") {
    const previous = Music.VOICES.findIndex((voice) => voice.id === (state.currentPreviewVoice?.id || settings.previewVoice));
    state.currentPreviewVoice = Music.VOICES[Music.soundIndex(settings.soundMode, Music.VOICES.length, previous, settings.sound)];
    renderSoundControls();
    return null;
  }
  if (performance.now() - state.lastSoundChange < 2000) return null;
  const pool = Music.patchPool(settings);
  const previous = state.currentPatch ? pool.findIndex((patch) => patchLabel(patch) === patchLabel(state.currentPatch)) : -1;
  const patch = pool[Music.soundIndex(settings.soundMode, pool.length, previous, settings.sound)];
  if (state.currentPatch && patchLabel(patch) === patchLabel(state.currentPatch)) return null;
  return sendMidiPatch(patch, state.playbackGeneration);
}

function waitForPatch(milliseconds, generation, output) {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      state.patchTimers.delete(timer);
      resolve(generation === state.playbackGeneration && output === state.midiOutput);
    }, milliseconds);
    state.patchTimers.set(timer, resolve);
  });
}

async function sendMidiPatch(patch, generation) {
  const output = state.midiOutput;
  if (!output || generation !== state.playbackGeneration || state.patchChanging) return false;
  state.patchChanging = true;
  if (dom["apply-patch"]) dom["apply-patch"].disabled = true;
  try {
    state.midiPacer?.reset();
    stopActiveMidiNotes();
    if (state.output === "midi") {
      state.noteTimers.forEach((timer) => window.clearTimeout(timer));
      state.noteTimers.clear();
    }
    // Match the native driver's bank-select sequence, with cancellable gaps.
    output.send([0xB0 | MIDI_CHANNEL, 0, 0]);
    if (!await waitForPatch(20, generation, output)) return false;
    output.send([0xB0 | MIDI_CHANNEL, 32, "ABCDEFGH".indexOf(patch.bank)]);
    if (!await waitForPatch(20, generation, output)) return false;
    output.send([0xC0 | MIDI_CHANNEL, patch.number - 1]);
    state.currentPatch = { ...patch };
    recordStudyEvent("synth.patch.sent", { generation, bank: patch.bank, number: patch.number, midi_channel: MIDI_CHANNEL,
      destination_id: output.id || null, destination_name: output.name || null, playback_continuing: state.playing });
    state.lastSoundChange = performance.now();
    renderSoundControls();
    if (state.output === "midi") publishSignalLabActivity({ stop: true });
    return await waitForPatch(100, generation, output);
  } finally {
    if (generation === state.playbackGeneration) {
      state.patchChanging = false;
      if (dom["apply-patch"]) dom["apply-patch"].disabled = false;
    }
  }
}

async function selectMidiPatch(patch, workspace = state.workspaceView) {
  if (!patch || ![..."ABCDEFGH"].includes(patch.bank) || !Number.isInteger(patch.number) || patch.number < 1 || patch.number > 128) {
    throw new Error("Choose a bank A–H and a patch from 1–128.");
  }
  if (!state.midiOutput) throw new Error("Connect and select a MIDI output first.");
  if (state.patchChanging) throw new Error("Wait for the current patch change to finish.");
  const keepPlaying = state.playing;
  if (!keepPlaying) {
    stopPlayback();
    state.playbackWorkspace = workspace;
    state.preparing = true;
    dom["preview-button"].innerHTML = "<span>■</span> Cancel";
  }
  const generation = state.playbackGeneration;
  const sessionStatus = dom["session-state"].textContent;
  dom["session-state"].textContent = "SELECTING PATCH";
  try {
    const sent = await sendMidiPatch(patch, generation);
    if (sent) {
      showToast(`Sent patch ${patchLabel(state.currentPatch)}`);
    }
    return sent;
  } catch (error) {
    if (keepPlaying && state.output === "midi" && generation === state.playbackGeneration) {
      stopPlayback();
      state.playbackError = error.message || "Could not select the MIDI patch";
    }
    throw error;
  } finally {
    if (generation === state.playbackGeneration) {
      if (!keepPlaying) stopPlayback();
      else if (dom["session-state"].textContent === "SELECTING PATCH") dom["session-state"].textContent = sessionStatus;
    }
  }
}

async function applyMidiPatch() {
  const settings = readMusicalControls();
  try { await selectMidiPatch({ bank: settings.patchBank, number: Math.round(settings.patchNumber) }); }
  catch (error) { showToast(error.message || "Could not select the MIDI patch"); }
}

function scheduleNextTick(interval) {
  if (!state.playing) return;
  window.clearTimeout(state.playTimer);
  const now = performance.now();
  state.nextTickAt = Math.max(state.nextTickAt + interval, now);
  state.playTimer = window.setTimeout(() => {
    if (activeSynthMixer()) state.cursor %= state.maxSteps;
    else if (state.sourceMode !== "live" && state.cursor >= state.maxSteps) {
      state.cursor = 0;
      if (!dom.loop.checked) { stopPlayback(); return; }
    }
    runPlaybackTick();
  }, Math.max(0, state.nextTickAt - now));
}

function controlsAt(progress) {
  const controls = { ...readPlaybackControls(), pitch: 60, velocity: 96, gate: 66, chance: 100, sound: 0, cc: new Map(), valid: true };
  const parameters = new Map();
  const assign = (destination, value) => {
    if (!destination || destination.unavailable || !Number.isFinite(value)) return;
    if (activeSynthMixer() && state.output !== "midi" && destination.hardware) return;
    const output = clamp(value, destination.min, destination.max);
    if (destination.cc !== undefined) controls.cc.set(destination.cc, clamp(Math.round(output), 0, 127));
    else if (!destination.hardware) controls[destination.id] = output;
    const command = Parameters?.command(destination, output, controls.midiFormat);
    if (command) parameters.set(command.key, command);
  };
  const mixer = activeSynthMixer();
  if (mixer) {
    const evaluated = mixer.evaluate(state.output, { midiFormat: controls.midiFormat });
    controls.valid = evaluated.valid !== false;
    for (const value of evaluated.values) assign(destinationFor(value.destination), value.value);
  } else state.mappings.forEach((mapping) => {
    if (!Music.mappingTargets(mapping).some((target) => target.enabled !== false)) return;
    let normalized;
    if (state.sourceMode === "live") {
      normalized = liveMappingValue(mapping, performance.now());
      if (normalized === null) { controls.valid = false; return; }
    } else {
      const series = state.playSeries.get(mapping.id);
      if (!series?.points?.length) return;
      const index = Math.round(clamp(progress, 0, 1) * (series.points.length - 1));
      const span = series.maximum - series.minimum;
      normalized = span > 0 ? (series.points[index][1] - series.minimum) / span : 0.5;
    }
    for (const target of Music.mappingTargets(mapping)) {
      const destination = destinationFor(target.destination);
      if (target.enabled === false || !destination || destination.unavailable) continue;
      const curved = applyCurve(clamp(normalized, 0, 1), target.curve);
      const output = target.minimum + curved * (target.maximum - target.minimum);
      assign(destination, output);
    }
  });
  controls.parameters = [...parameters.values()];
  controls.velocity = clamp(Math.round(controls.velocity), 1, 127);
  controls.gate = clamp(controls.gate, 5, 100);
  controls.chance = clamp(controls.chance, 0, 100);
  return controls;
}

function silenceStaleInput() {
  state.currentParameterCommands = [];
  state.midiPacer?.reset();
  if (!state.liveSilenced) {
    state.synthBeatRevision += 1;
    state.liveSilenced = true;
    state.noteTimers.forEach((timer) => window.clearTimeout(timer));
    state.noteTimers.clear();
    stopActiveMidiNotes();
    stopAudioVoices();
    state.drumEngine?.stop();
    state.drumMotion?.reset();
    state.drumActivity = 0;
    if (state.output === "drums") renderDrumReadout(0, null, "Waiting for fresh data from every selected movement source.");
    publishSignalLabActivity({ stop: true });
  }
  dom["session-state"].textContent = state.sourceMode === "live" ? "WAITING FOR FRESH LIVE DATA" : "WAITING FOR MOVEMENT DATA";
}

function startParameterPump() {
  window.clearTimeout(state.parameterTimer);
  state.midiPacer?.reset();
  state.parameterCarry = 0;
  const generation = state.playbackGeneration;
  const pump = () => {
    if (!state.playing || generation !== state.playbackGeneration) return;
    try {
      const controls = activeSynthMixer() || state.sourceMode === "live" ? controlsAt(0) : null;
      if (controls && !controls.valid) silenceStaleInput();
      else if (state.output === "midi" && state.midiOutput && !state.patchChanging) {
        const settings = controls || readPlaybackControls();
        state.midiPacer.update(controls ? controls.parameters : state.currentParameterCommands);
        state.parameterCarry += settings.midiRate / 50;
        const limit = Math.floor(state.parameterCarry);
        state.parameterCarry -= limit;
        const emitted = state.midiPacer.flush((bytes) => state.midiOutput.send(bytes), limit);
        for (const command of emitted) if (command.kind === "cc" && command.number === 64) {
          if (command.value > 0) state.midiSustainOutputs.add(state.midiOutput);
          else state.midiSustainOutputs.delete(state.midiOutput);
        }
        if (emitted.length) publishSignalLabActivity({
          cc: emitted.filter((item) => item.kind === "cc"), nrpn: emitted.filter((item) => item.kind === "nrpn")
        });
        if (dom["midi-parameter-status"]) dom["midi-parameter-status"].textContent =
          `${settings.midiFormat.toUpperCase()} · ${state.midiPacer.pending.size} waiting · up to ${settings.midiRate} parameter changes/sec`;
      } else if (activeSynthMixer() && controls && state.output === "audio" && !state.liveSilenced) {
        updateAudioEffects(controls.cc, 60000 / controls.tempo / controls.stepsPerBeat);
        state.activeVoices.forEach((voice) => voice.updateControls?.(controls.cc));
      }
    } catch (error) {
      stopPlayback(); state.playbackError = error.message || "Audio or MIDI output disconnected";
      showToast(state.playbackError); return;
    }
    state.parameterTimer = window.setTimeout(pump, 20);
  };
  state.parameterTimer = window.setTimeout(pump, 20);
}

function publishSignalLabActivity(activity = {}) {
  const compositeCount = state.mappings.filter((mapping) => mapping.sources?.length > 1).length;
  const queued = state.activityQueued;
  state.activityQueued = {
    recording: state.recording?.name || state.recording?.id || null,
    output: state.output,
    mapping_count: state.mappings.length,
    destination_count: Music.targetCount(state.mappings),
    source_mode: state.sourceMode,
    composite_count: compositeCount,
    patch: state.output === "midi" ? state.currentPatch : null,
    voice_name: state.output === "drums" ? drumKitName() : state.output === "audio" ? effectivePreviewVoice().name || "Custom" : null,
    ...activity
  };
  // Preserve every emitted output event before the separate Signal Lab display
  // coalesces pending updates. This describes commands sent, not microphone audio.
  const mappingRevision = activity.stop ? null : mappingPlaybackStudy(state.playing, "output");
  recordStudyEvent("synth.output", { ...state.activityQueued, generation: state.playbackGeneration,
    workspace: state.playbackWorkspace, rhythm_step: state.rhythmStep, performance_ms: performance.now(),
    mapping_revision_id: activity.mapping_revision_id || mappingRevision?.revision_id || null });
  // Preserve emitted parameter changes while the previous HTTP request is in flight.
  if (queued && !activity.stop) {
    for (const kind of ["cc", "nrpn"]) {
      const merged = new Map([...(queued[kind] || []), ...(activity[kind] || [])].map((item) => [item.key || item.number, item]));
      if (merged.size) state.activityQueued[kind] = [...merged.values()].slice(-64);
    }
    if (!activity.notes && queued.notes && !queued.stop) state.activityQueued.notes = queued.notes;
    if (queued.stop && !activity.notes) state.activityQueued.stop = true;
  }
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
  const wasPlaying = state.playing || state.preparing;
  const mappingRevision = wasPlaying ? mappingPlaybackStudy(false, "stopped") : null;
  if (wasPlaying) recordStudyEvent("synth.transport.stopped", { generation: state.playbackGeneration,
    workspace: state.playbackWorkspace, output: state.output, was_preparing: state.preparing, source_mode: state.sourceMode,
    mapping_revision_id: mappingRevision?.revision_id || null });
  state.playing = false;
  state.preparing = false;
  state.playbackWorkspace = null;
  state.playbackGeneration += 1;
  state.synthBeatClock = null;
  state.synthBeatRevision += 1;
  window.clearTimeout(state.playTimer);
  state.playTimer = null;
  window.clearTimeout(state.parameterTimer);
  state.parameterTimer = null;
  state.midiPacer?.reset();
  state.currentParameterCommands = [];
  state.patchChanging = false;
  state.liveSilenced = false;
  state.noteTimers.forEach((timer) => window.clearTimeout(timer));
  state.noteTimers.clear();
  state.patchTimers.forEach((resolve, timer) => { window.clearTimeout(timer); resolve(false); });
  state.patchTimers.clear();
  if (dom["apply-patch"]) dom["apply-patch"].disabled = false;
  stopActiveMidiNotes();
  stopAudioVoices();
  state.drumEngine?.stop();
  state.drumMotion?.reset();
  state.drumPlayingKeys = null;
  state.drumActivity = 0;
  dom["preview-button"].classList.remove("is-playing");
  dom["preview-button"].innerHTML = "<span>▶</span> Preview";
  dom["session-state"].textContent = "LOCAL SESSION · READY";
  updatePlayhead();
  renderRhythm();
  if (state.output === "drums") renderDrumReadout(0, null, "Ready · press Preview to hear the movement.");
  renderPlaybackAvailability();
  if (wasPlaying) publishSignalLabActivity({ stop: true, mapping_revision_id: mappingRevision?.revision_id || null });
}

function rememberSynthBeat(controls) {
  const bpm = clamp(Number(controls.tempo), 20, 240);
  const subdivision = clamp(Number(controls.stepsPerBeat), 1, 8);
  const swing = clamp(Number(controls.swing) || 0, 0, 65) / 100;
  const signature = `${bpm}:${subdivision}:${swing}`;
  if (state.synthBeatClock?.signature !== signature) state.synthBeatRevision += 1;
  // Swing shifts odd subdivisions later; retain an unswung quarter-note grid
  // so the next four-beat bar agrees with the actual synth scheduler.
  state.synthBeatClock = { at: performance.now() / 1000, bpm, signature,
    beat: (state.rhythmStep + (state.rhythmStep % 2 ? swing : 0)) / subdivision };
}

function synthRapClock() {
  const context = state.audio?.context || null, anchor = state.synthBeatClock;
  const playing = state.playbackWorkspace === "synth-mixer" && state.playing;
  // Standalone Synth rap also uses this clock while its sequencer is stopped.
  // Its tempo belongs to the Synth mixer even when another tab is visible.
  const bpm = anchor?.bpm || Number(globalThis.HydraSynthMixer?.getControls?.()?.tempo) || Number(readMusicalControls().tempo) || 96;
  return { context, destination: context?.destination || null,
    playing, valid: !state.liveSilenced && (!playing || Boolean(anchor)), bpm, baseBpm: bpm, rate: 1,
    beat: anchor ? anchor.beat + Math.max(0, performance.now() / 1000 - anchor.at) * bpm / 60 : 0,
    at: context?.currentTime || 0, token: `${state.playbackGeneration}:${state.synthBeatRevision}`, estimated: false };
}

globalThis.HydraSynthRapTransport = { unlock: () => ensureAudioEngine(), clock: synthRapClock };
globalThis.HydraBeatClock = {
  snapshot(source = "synth") {
    const mixer = source === "mixer";
    const clock = mixer ? globalThis.HydraMusicMixer?.transportClock?.() : synthRapClock();
    const running = mixer ? Boolean(clock?.playing && clock.valid !== false)
      : Boolean(state.playing && state.output !== "drums" && !state.liveSilenced && state.synthBeatClock);
    const sampledAt = performance.now();
    const detected = mixer && clock?.detected === true;
    const audioOffset = sampledAt - (Number(clock?.context?.currentTime) || 0) * 1000;
    return { running, bpm: Number(clock?.bpm) || 96,
      beat: Number.isFinite(clock?.beat) ? clock.beat : 0,
      at: sampledAt,
      token: mixer ? clock?.transportToken ?? clock?.token ?? null : `${state.playbackGeneration}:${state.synthBeatClock?.signature?.split(":").slice(1).join(":") || "stopped"}`,
      estimated: clock?.estimated === true, rateChanging: clock?.rateChanging === true,
      ...(clock?.beatTrackingError ? { beatTrackingError: clock.beatTrackingError } : {}),
      ...(detected ? { detected: true, beatContacts: (clock.beatContacts || []).map(contact => ({ ...contact, at: audioOffset + contact.at * 1000 })) } : {}),
      source: mixer ? "mixer" : "synth", label: mixer ? "Music mixer" : "Synth" };
  }
};

async function ensureAudioEngine() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) throw new Error("This browser does not support audio preview");
  if (!state.audio) {
    const context = new AudioContext();
    const master = context.createGain();
    const compressor = context.createDynamicsCompressor();
    const delayInput = context.createGain();
    const delay = context.createDelay(2);
    const feedback = context.createGain();
    const delayReturn = context.createGain();
    const reverbInput = context.createGain();
    const reverb = context.createConvolver();
    const reverbReturn = context.createGain();
    const impulse = context.createBuffer(2, Math.round(context.sampleRate * 3.0), context.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const samples = impulse.getChannelData(channel);
      for (let i = 0; i < samples.length; i += 1) samples[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / samples.length, 1.8);
    }
    reverb.buffer = impulse;
    master.gain.value = 0.5;
    compressor.threshold.value = -16;
    compressor.knee.value = 16;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.12;
    delayInput.gain.value = 0;
    reverbInput.gain.value = 0;
    delay.delayTime.value = 0.25;
    feedback.gain.value = 0.48;
    delayReturn.gain.value = 0.85;
    delayInput.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(delayReturn);
    delayReturn.connect(master);
    reverbInput.connect(reverb);
    reverb.connect(reverbReturn);
    reverbReturn.connect(master);
    master.connect(compressor);
    compressor.connect(context.destination);
    state.audio = { context, master, delay, delayInput, reverbInput, delayReturn, reverbReturn, driveCurves: new Map() };
  }
  const { context, master } = state.audio;
  // A newly selected drum kit should not bring back the melodic engine's effect tails.
  state.audio.delayReturn.gain.setValueAtTime(state.output === "drums" ? 0 : .85, context.currentTime);
  state.audio.reverbReturn.gain.setValueAtTime(state.output === "drums" ? 0 : 1, context.currentTime);
  master.gain.cancelScheduledValues(context.currentTime);
  master.gain.setTargetAtTime(0.5, context.currentTime, 0.015);
  await context.resume();
}

function updateAudioEffects(cc, interval) {
  if (!state.audio) return;
  const { context, delay, delayInput, reverbInput } = state.audio;
  const echo = Math.max((cc.get(92) ?? 0) / 127, (cc.get(22) ?? 0) / 127);
  const space = Math.max((cc.get(91) ?? 16) / 127, (cc.get(23) ?? 0) / 127);
  delayInput.gain.setTargetAtTime(echo, context.currentTime, 0.02);
  reverbInput.gain.setTargetAtTime(space, context.currentTime, 0.02);
  delay.delayTime.setTargetAtTime(clamp(interval / 1000 * 1.5, 0.06, 1.5), context.currentTime, 0.1);
}

function stopAudioVoices() {
  if (!state.audio) return;
  const now = state.audio.context.currentTime;
  state.audio.master.gain.cancelScheduledValues(now);
  state.audio.master.gain.setTargetAtTime(0, now, 0.008);
  for (const voice of [...state.activeVoices]) voice.stop();
}

function playAudioNote(note, velocity, durationMs, cc, level = 1) {
  if (!state.audio) return;
  const { context, master, delayInput, reverbInput, driveCurves } = state.audio;
  while (state.activeVoices.size >= 48) state.activeVoices.values().next().value.stop();
  const now = context.currentTime;
  const sound = effectivePreviewVoice();
  const attackValue = cc.has(20) ? 0.002 + cc.get(20) / 127 * 0.4 : sound.attack / 100;
  const attack = Math.max(0.001, Math.min(attackValue, durationMs / 1000 * 0.7));
  const release = cc.has(21) ? 0.025 + cc.get(21) / 127 * 1.6 : 0.05 + sound.release / 100 * 1.2;
  const end = now + durationMs / 1000;
  const gain = context.createGain();
  const filter = context.createBiquadFilter();
  const drive = context.createWaveShaper();
  const oscillator = context.createOscillator();
  const harmonic = context.createOscillator();
  const harmonicGain = context.createGain();
  const cutoffValue = cc.get(74) ?? Math.round(sound.brightness * 1.27);
  const macroBrightness = cc.has(16) ? Math.pow(2, (cc.get(16) / 127 - 0.5) * 5) : 1;
  const resonance = (cc.get(71) ?? 12) / 127 * 12 + (cc.get(17) ?? 0) / 127 * 10;
  const driveValue = cc.get(50) ?? 0;
  if (!driveCurves.has(driveValue)) {
    const curve = new Float32Array(257);
    const amount = 1 + driveValue / 127 * 45;
    for (let i = 0; i < curve.length; i += 1) {
      const x = i * 2 / (curve.length - 1) - 1;
      curve[i] = driveValue === 0 ? x : Math.tanh(x * amount) / Math.tanh(amount);
    }
    driveCurves.set(driveValue, curve);
  }
  drive.curve = driveCurves.get(driveValue);
  drive.oversample = "2x";
  const frequency = 440 * Math.pow(2, (note + (sound.octave || 0) * 12 - 69) / 12);
  oscillator.type = sound.waveType;
  harmonic.type = "sine";
  oscillator.frequency.value = frequency;
  harmonic.frequency.value = frequency * (cc.has(18) ? cc.get(18) > 80 ? 3 : 2 : sound.ratio || 2);
  const detune = (cc.get(19) ?? 12) / 127 * 45;
  oscillator.detune.value = -detune / 2;
  harmonic.detune.value = detune;
  harmonicGain.gain.value = cc.has(18) ? 0.04 + cc.get(18) / 127 * 0.55 : sound.harmonic ?? 0.12;
  filter.type = "lowpass";
  filter.frequency.value = clamp(55 * Math.pow(260, cutoffValue / 127) * macroBrightness, 40, Math.min(18000, context.sampleRate * 0.45));
  filter.Q.value = 0.4 + resonance;
  const peak = velocity / 127 * 0.2 * level;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), now + attack);
  if (sound.decay) gain.gain.exponentialRampToValueAtTime(Math.max(0.001, peak * 0.2), end);
  else gain.gain.setValueAtTime(Math.max(0.001, peak), end);
  gain.gain.exponentialRampToValueAtTime(0.0001, end + release);
  oscillator.connect(drive);
  harmonic.connect(harmonicGain);
  harmonicGain.connect(drive);
  drive.connect(filter);
  filter.connect(gain);
  gain.connect(master);
  gain.connect(delayInput);
  gain.connect(reverbInput);
  const nodes = [oscillator, harmonic, harmonicGain, drive, filter, gain];
  let stopped = false;
  const voice = { updateControls(next) {
    if (stopped) return;
    const brightness = next.get(74) ?? Math.round(effectivePreviewVoice().brightness * 1.27);
    const multiplier = next.has(16) ? Math.pow(2, (next.get(16) / 127 - 0.5) * 5) : 1;
    filter.frequency.setTargetAtTime(clamp(55 * Math.pow(260, brightness / 127) * multiplier,
      40, Math.min(18000, context.sampleRate * 0.45)), context.currentTime, 0.02);
    filter.Q.setTargetAtTime(0.4 + (next.get(71) ?? 12) / 127 * 12 + (next.get(17) ?? 0) / 127 * 10,
      context.currentTime, 0.02);
  }, stop() {
    if (stopped) return;
    stopped = true;
    state.activeVoices.delete(voice);
    gain.gain.cancelScheduledValues(context.currentTime);
    gain.gain.setTargetAtTime(0.0001, context.currentTime, 0.004);
    oscillator.stop(context.currentTime + 0.025);
    harmonic.stop(context.currentTime + 0.025);
  } };
  state.activeVoices.add(voice);
  oscillator.start(now);
  harmonic.start(now);
  oscillator.stop(end + release + 0.03);
  harmonic.stop(end + release + 0.03);
  oscillator.addEventListener("ended", () => {
    state.activeVoices.delete(voice);
    nodes.forEach((node) => node.disconnect());
  }, { once: true });
}

function connectMidi(options = {}) {
  const automatic = options.automatic === true;
  if (state.midiConnecting) return state.midiConnecting;
  if (!navigator.requestMIDIAccess) {
    state.midiConnectionError = "Web MIDI is not available in this browser. Browser preview still works.";
    updateMidiStatus();
    if (!automatic) showToast(state.midiConnectionError);
    return Promise.resolve(null);
  }
  state.midiConnectionError = "";
  let accessRequest;
  try { accessRequest = state.midiAccess || navigator.requestMIDIAccess({ sysex: false }); }
  catch (error) { accessRequest = Promise.reject(error); }
  state.midiConnecting = Promise.resolve(accessRequest).then(access => {
    state.midiAccess = access;
    state.midiAccess.onstatechange = renderMidiOutputs;
    renderMidiOutputs();
    if (!automatic && !state.workspaceView) {
      dom["midi-panel"].hidden = false;
      dom["panic-button"].hidden = false;
      if (state.midiOutput && state.output !== "midi") setOutput("midi");
    }
    updateConnectionSummary();
    return state.midiOutput;
  }).catch(error => {
    state.midiConnectionError = "MIDI access was not granted. Use Connect MIDI device to try again.";
    updateMidiStatus();
    if (!automatic) showToast(error?.message || state.midiConnectionError);
    return null;
  }).finally(() => { state.midiConnecting = null; });
  return state.midiConnecting;
}

function midiDeviceIdentity(output) {
  return { midiDeviceId: output?.id || "", midiDeviceName: output?.name || "",
    midiDeviceManufacturer: output?.manufacturer || "" };
}

function isHydrasynthOutput(output) {
  return /hydra\s*synth/i.test(output?.name || "");
}

function renderMidiOutputs() {
  const outputs = state.midiAccess ? Array.from(state.midiAccess.outputs.values()).filter(output => output.state !== "disconnected") : [];
  const preferences = state.connectionPreferences;
  const previous = state.midiOutput ? midiDeviceIdentity(state.midiOutput) : preferences;
  const previousId = previous.midiDeviceId || dom["midi-output"].value;
  const normalize = value => String(value || "").trim().toLowerCase();
  const identityMatches = previous.midiDeviceName ? outputs.filter(output => normalize(output.name) === normalize(previous.midiDeviceName)
    && (!previous.midiDeviceManufacturer || normalize(output.manufacturer) === normalize(previous.midiDeviceManufacturer))) : [];
  const hydrasynths = outputs.filter(isHydrasynthOutput);
  const hasPreference = previousId || previous.midiDeviceName || preferences.midiDeviceExplicit;
  const selected = outputs.find(output => output.id === previousId)
    || (identityMatches.length === 1 ? identityMatches[0] : null)
    || (!hasPreference && hydrasynths.length === 1 ? hydrasynths[0] : null);
  dom["midi-output"].replaceChildren(new Option("No device selected", ""));
  outputs.forEach((output) => dom["midi-output"].add(new Option(output.name || "MIDI output", output.id)));
  dom["midi-output"].value = selected?.id || "";
  if (state.midiOutput?.id !== selected?.id) {
    if (state.midiOutput) {
      Object.assign(preferences, midiDeviceIdentity(state.midiOutput));
      if (state.output === "midi") stopPlayback();
      else stopActiveMidiNotes();
    }
    state.currentPatch = null;
  }
  state.midiOutput = selected;
  if (selected) {
    Object.assign(preferences, midiDeviceIdentity(selected));
    if (state.midiAutoRoute && isHydrasynthOutput(selected) && !state.playing && !state.preparing) {
      state.midiAutoRoute = false;
      state.synthOutput = "midi";
      if (!["drums", "elevenlabs", "mixer", "rap-experiment", "rap-response"].includes(state.workspaceView)) state.output = "midi";
      state.midiPacer?.reset();
      renderOutputMode();
    }
    if (state.connectionsReady) {
      try { saveConnectionPreferences(); } catch (_) { /* The selected route still works without storage. */ }
    }
  }
  updateMidiStatus();
  updateConnectionSummary();
}

function selectMidiOutput() {
  stopPlayback();
  state.midiAutoRoute = false;
  state.currentPatch = null;
  const selected = state.midiAccess?.outputs.get(dom["midi-output"].value);
  state.midiOutput = selected?.state !== "disconnected" ? selected || null : null;
  Object.assign(state.connectionPreferences, midiDeviceIdentity(state.midiOutput), { midiDeviceExplicit: true });
  saveSettings();
  updateMidiStatus();
  updateConnectionSummary();
}

function updateMidiStatus() {
  renderSoundControls();
  if (state.midiOutput) {
    dom["midi-status"].textContent = `${state.midiOutput.name} is ready on channel ${MIDI_CHANNEL + 1}.`;
    dom["midi-choice-detail"].textContent = state.midiOutput.name;
    dom["connect-midi"].innerHTML = `MIDI connected <span>✓</span>`;
  } else {
    dom["midi-status"].textContent = state.midiConnectionError || "Waiting for the saved MIDI device or a single Hydrasynth. Choose a device if several are connected.";
    dom["midi-choice-detail"].textContent = "No output selected";
    dom["connect-midi"].innerHTML = `Connect MIDI device <span>→</span>`;
    if (state.output === "midi") {
      if (state.workspaceView) stopPlayback();
      else setOutput("audio");
    }
  }
  renderPlaybackAvailability();
}

function playMidiNote(note, velocity, durationMs) {
  const output = state.midiOutput;
  if (!output) return;
  const existing = state.midiNoteTimers.get(note);
  if (existing) {
    window.clearTimeout(existing.timer);
    existing.output.send([0x80 | MIDI_CHANNEL, note, 0]);
  }
  output.send([0x90 | MIDI_CHANNEL, note, velocity]);
  const timer = window.setTimeout(() => {
    state.midiNoteTimers.delete(note);
    try { output.send([0x80 | MIDI_CHANNEL, note, 0]); }
    catch (error) { stopPlayback(); showToast(error.message || "MIDI output disconnected"); }
  }, durationMs);
  state.midiNoteTimers.set(note, { timer, output });
}

function sendMidiCc(ccValues) {
  if (!state.midiOutput) return;
  ccValues.forEach((value, cc) => state.midiOutput.send([0xB0 | MIDI_CHANNEL, cc, value]));
  if (ccValues.has(64)) {
    if (ccValues.get(64) > 0) state.midiSustainOutputs.add(state.midiOutput);
    else state.midiSustainOutputs.delete(state.midiOutput);
  }
}

function stopActiveMidiNotes() {
  const outputs = new Set([...state.midiNoteTimers.values()].map((item) => item.output));
  for (const output of state.midiSustainOutputs) outputs.add(output);
  for (const output of outputs) {
    try { output.send([0xB0 | MIDI_CHANNEL, 64, 0]); }
    catch (_error) { /* Disconnected outputs cannot sustain new notes. */ }
  }
  state.midiSustainOutputs.clear();
  state.midiNoteTimers.forEach(({ timer, output }, note) => {
    window.clearTimeout(timer);
    try { output.send([0x80 | MIDI_CHANNEL, note, 0]); }
    catch (_error) { /* The original output may already have disconnected. */ }
  });
  state.midiNoteTimers.clear();
}

function panicMidi() {
  stopActiveMidiNotes();
  state.midiOutput?.send([0xB0 | MIDI_CHANNEL, 64, 0]);
  state.midiOutput?.send([0xB0 | MIDI_CHANNEL, 123, 0]);
}

function setOutput(output) {
  if (!['audio', 'midi', 'drums'].includes(output)) return;
  if (state.playing || state.preparing) stopPlayback();
  state.selectionGeneration += 1;
  if (state.workspaceView) {
    if (output !== "drums") state.synthOutput = output;
    state.output = state.workspaceView === "drums" ? "drums" : state.workspaceView === "mixer" ? "audio" : state.synthOutput;
  } else state.output = output;
  state.midiPacer?.reset();
  renderSoundControls();
  renderOutputMode();
  if (!state.workspaceView && output === "midi" && !state.midiAccess) connectMidi();
  saveSettings();
  if (state.recording) loadFocusedSeries();
  updateConnectionSummary();
}

function seekFromPointer(event) {
  if (!state.recording || state.sourceMode === "live") return;
  const bounds = dom["waveform"].getBoundingClientRect();
  const progress = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
  state.cursor = Math.round(progress * (state.maxSteps - 1));
  if (state.output === "drums") {
    state.drumOrigin = performance.now() - progress * state.drumDuration * 1000;
    state.drumMotion?.reset();
  }
  updatePlayhead();
}

function updatePlayhead() {
  if (state.sourceMode === "live") {
    dom.playhead.setAttribute("d", "");
    dom["wave-progress"].textContent = "LIVE";
    dom.waveform.setAttribute("aria-valuetext", "Live stream; seeking is unavailable");
    return;
  }
  dom.waveform.removeAttribute?.("aria-valuetext");
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

function updateControlReadouts() {
  dom["attack-output"].textContent = `${(Number(dom.attack.value) / 100).toFixed(2)}s`;
  dom["release-output"].textContent = `${(0.05 + Number(dom.release.value) / 100 * 1.2).toFixed(2)}s`;
  dom["brightness-output"].textContent = `${dom.brightness.value}%`;
  renderHarmony();
  renderSoundControls();
}

function applySavedControls() {
  const savedOutput = state.saved.connections?.synthOutput ?? state.saved.controls?.output;
  state.synthOutput = savedOutput === "midi" ? "midi" : "audio";
  applyMusicalControls(state.saved.controls);
  renderSoundControls();
  dom.outputButtons.forEach((button) => {
    const selected = button.dataset.output === state.output;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", String(selected));
  });
}

function loadSavedSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function saveSettings() {
  commitActiveTab();
  captureLegacyStudyMappings();
  state.saved.controls = { ...readMusicalControls(), output: state.output };
  state.saved.connections = { synthOutput: state.synthOutput };
  if (state.recording) {
    if (state.sourceMode !== "live") state.saved.lastRecording = state.recording.id;
    if (!state.saved.workspaces || typeof state.saved.workspaces !== "object" || Array.isArray(state.saved.workspaces)) state.saved.workspaces = {};
    state.saved.workspaces[state.recording.id] = {
      activeIndex: Math.max(0, state.tabs.findIndex((tab) => tab.id === state.activeTabId)),
      tabs: state.tabs.map(Music.serializeTab)
    };
  }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.saved));
    if (state.connectionsReady) saveConnectionPreferences();
    return true;
  } catch (_error) {
    dom["workspace-status"].textContent = "Browser storage is unavailable or full. This session still works; export presets before closing it.";
    return false;
  }
}

function loadConnectionPreferences() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONNECTIONS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) { return {}; }
}

function saveConnectionPreferences() {
  const preferences = {
    inputMode: state.sourceMode, recordingId: state.sourceMode === "live" ? state.saved.lastRecording : state.recording?.id,
    liveUrl: dom["live-url"]?.value || "ws://localhost:8765", reconnect: dom["live-reconnect"]?.checked !== false,
    synthOutput: state.synthOutput, ...readMidiConnectionControls(),
    ...(state.midiOutput ? midiDeviceIdentity(state.midiOutput) : {
      midiDeviceId: state.connectionPreferences.midiDeviceId || "",
      midiDeviceName: state.connectionPreferences.midiDeviceName || "",
      midiDeviceManufacturer: state.connectionPreferences.midiDeviceManufacturer || ""
    }),
    midiDeviceExplicit: state.connectionPreferences.midiDeviceExplicit === true
  };
  localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(preferences));
  state.connectionPreferences = preferences;
}

async function restoreConnectionPreferences({ autoConnectMidi = false } = {}) {
  const preferences = state.connectionPreferences;
  if (preferences.recordingId && state.sourceMode !== "live" && state.recording?.id !== preferences.recordingId
      && state.library?.recordings.some((recording) => recording.id === preferences.recordingId)) {
    await selectRecording(preferences.recordingId);
  }
  if (typeof preferences.liveUrl === "string") dom["live-url"].value = preferences.liveUrl;
  if (typeof preferences.reconnect === "boolean") dom["live-reconnect"].checked = preferences.reconnect;
  if (preferences.inputMode === "live") {
    try { selectLiveInput(liveInputUrl(), false); } catch (error) { showToast(error.message); }
  }
  if (preferences.midiFormat) dom["midi-format"].value = Music.controls(preferences).midiFormat;
  if (preferences.midiRate) dom["midi-rate"].value = String(Music.controls(preferences).midiRate);
  if (["audio", "midi"].includes(preferences.synthOutput)) {
    state.midiAutoRoute = false;
    setOutput(preferences.synthOutput);
  }
  state.connectionsReady = true;
  updateConnectionSummary();
  // Permission can wait for the user while the rest of the dashboard remains
  // ready. Connecting only selects a port; playback and patch changes stay idle.
  if (autoConnectMidi) void connectMidi({ automatic: true });
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

function applyCurve(value, curve) {
  if (curve === "inverse") return 1 - value;
  if (curve === "smooth") return value * value * (3 - 2 * value);
  if (curve === "exponential") return value * value;
  if (curve === "steps") return Math.round(value * 4) / 4;
  if (curve === "threshold") return value >= 0.5 ? 1 : 0;
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
  return target instanceof Element && Boolean(target.closest("input, select, textarea, button, a, summary, [contenteditable]"));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
}

async function loadParameterCatalog() {
  const response = await fetch("/api/catalog", { cache: "no-cache" });
  if (!response.ok) throw new Error("Could not load the Hydrasynth parameter catalog.");
  const catalog = await response.json();
  state.catalogSummary = Parameters.install(catalog);
  state.catalogReady = true;
  dom["live-connect"].disabled = false;
  dom["catalog-status"].textContent = `${state.catalogSummary.available} hardware destinations available, including ${state.catalogSummary.nrpn} NRPN parameters. ${state.catalogSummary.unavailable} reference entries have unsupported ranges or address conflicts. Legacy MIDI reference; verify behavior on your firmware.`;
}

function ensureTargets(mapping) {
  if (!Array.isArray(mapping.targets)) mapping.targets = [{ destination: mapping.destination, minimum: mapping.minimum,
    maximum: mapping.maximum, curve: mapping.curve, enabled: mapping.enabled !== false }];
  return mapping.targets;
}

function syncPrimaryTarget(mapping) {
  if (mapping.targets?.length) Object.assign(mapping, mapping.targets[0]);
}

function targetLabel(destination, value) {
  const choice = destination.choices?.find((item) => item.value === Math.round(value));
  return choice ? `${choice.label} (${choice.value})` : String(Math.round(value * 100) / 100);
}

function renderMappingTarget(mapping, target, index) {
  const destination = destinationFor(target.destination);
  const row = document.createElement("div"); row.className = "mapping-target";
  const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = target.enabled !== false;
  enabled.disabled = Boolean(destination.unavailable); enabled.setAttribute("aria-label", `Enable ${destination.label}`);
  enabled.addEventListener("change", () => { target.enabled = enabled.checked; mappingChanged(mapping, false); });
  const name = document.createElement("button"); name.type = "button"; name.className = "target-name";
  const label = document.createElement("b"); label.textContent = destination.label;
  const group = document.createElement("small"); group.textContent = destination.group + (destination.hardware ? " · MIDI" : "");
  name.append(label, group); name.title = destination.unavailable || destination.hint || "Choose a different destination";
  name.addEventListener("click", () => openParameterPicker(mapping.id, index));
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "remove-source-button"; remove.textContent = "×";
  remove.disabled = mapping.targets.length === 1; remove.setAttribute("aria-label", `Remove ${destination.label}`);
  remove.addEventListener("click", () => { mapping.targets.splice(index, 1); mappingChanged(mapping, false); });
  const curveLabel = document.createElement("label"); curveLabel.textContent = "Curve";
  const curve = document.createElement("select"); curve.dataset.role = "target-curve";
  for (const [value, text] of [["linear", "Linear"], ["smooth", "Soft S"], ["exponential", "Exponential"], ["inverse", "Inverted"], ["steps", "5 levels"], ["threshold", "Switch"]]) curve.add(new Option(text, value));
  curve.value = target.curve || "linear"; curve.addEventListener("change", () => { target.curve = curve.value; mappingChanged(mapping, false); });
  curveLabel.append(curve);
  row.append(enabled, name, remove, curveLabel);
  for (const key of ["minimum", "maximum"]) {
    const wrapper = document.createElement("label"); wrapper.textContent = key === "minimum" ? "From" : "To";
    const input = document.createElement("input"); input.type = "number"; input.min = destination.min; input.max = destination.max;
    input.step = destination.valueSpec?.kind === "bipolar" ? "0.1" : "1"; input.value = target[key]; input.dataset.role = key;
    input.title = targetLabel(destination, target[key]);
    input.addEventListener("change", () => {
      target[key] = clamp(Number(input.value) || 0, destination.min, destination.max); mappingChanged(mapping, false);
    });
    wrapper.append(input); row.append(wrapper);
  }
  if (destination.choices || destination.hint || destination.unavailable) {
    const detail = document.createElement("small"); detail.className = "target-detail";
    detail.textContent = destination.unavailable || destination.hint || `${targetLabel(destination, target.minimum)} → ${targetLabel(destination, target.maximum)}`;
    row.append(detail);
  }
  row.classList.toggle("is-disabled", target.enabled === false || Boolean(destination.unavailable));
  return row;
}

function openParameterPicker(mappingId, targetIndex = null) {
  state.picker = { mappingId, targetIndex, selected: new Set(), page: 0, filtered: [] };
  dom["picker-search"].value = "";
  dom["picker-group"].replaceChildren(new Option("All groups", ""));
  [...new Set(DESTINATIONS.map((item) => item.group))].forEach((group) => dom["picker-group"].add(new Option(group, group)));
  dom["picker-description"].textContent = targetIndex === null
    ? `Each input recipe supports ${MAX_TARGETS} destinations. Select several or add a whole group.` : "Choose a replacement destination.";
  dom["parameter-picker"].showModal(); renderParameterPicker(); dom["picker-search"].focus();
}

function bindParameterPicker() {
  dom["picker-close"].addEventListener("click", () => dom["parameter-picker"].close());
  for (const id of ["picker-search", "picker-group"]) dom[id].addEventListener("input", () => { state.picker.page = 0; renderParameterPicker(); });
  dom["picker-prev"].addEventListener("click", () => { state.picker.page--; renderParameterPicker(); });
  dom["picker-next"].addEventListener("click", () => { state.picker.page++; renderParameterPicker(); });
  dom["picker-clear"].addEventListener("click", () => { state.picker.selected.clear(); renderParameterPicker(); });
  for (const [id, all] of [["picker-select-page", false], ["picker-select-group", true]]) {
    dom[id].addEventListener("click", () => {
      const picker = state.picker;
      const mapping = state.mappings.find((item) => item.id === picker.mappingId);
      const used = new Set(ensureTargets(mapping).map((target) => target.destination));
      const available = picker.filtered.filter((item) => !item.unavailable && !used.has(item.id));
      const options = all ? available : picker.filtered.slice(picker.page * 40, picker.page * 40 + 40).filter((item) => !item.unavailable && !used.has(item.id));
      for (const option of options) {
        if (picker.selected.size >= MAX_TARGETS - mapping.targets.length) break;
        picker.selected.add(option.id);
      }
      renderParameterPicker();
    });
  }
  dom["picker-add"].addEventListener("click", () => {
    const picker = state.picker;
    const mapping = state.mappings.find((item) => item.id === picker.mappingId);
    if (!mapping) { dom["parameter-picker"].close(); return; }
    const additions = [...picker.selected].map((id) => destinationFor(id)).filter((item) => item && !item.unavailable).map((item) =>
      ({ destination: item.id, minimum: item.from, maximum: item.to, curve: "linear", enabled: true }));
    if (picker.targetIndex !== null && additions.length) mapping.targets[picker.targetIndex] = additions[0];
    else mapping.targets.push(...additions.slice(0, MAX_TARGETS - mapping.targets.length));
    mappingChanged(mapping, false); dom["parameter-picker"].close();
  });
}

function renderParameterPicker() {
  const picker = state.picker;
  if (!picker) return;
  const mapping = state.mappings.find((item) => item.id === picker.mappingId);
  if (!mapping) return;
  const used = new Set(ensureTargets(mapping).filter((_, index) => index !== picker.targetIndex).map((target) => target.destination));
  const query = dom["picker-search"].value.trim().toLowerCase().replaceAll("mutant", "mutator");
  const group = dom["picker-group"].value;
  picker.filtered = DESTINATIONS.filter((item) => (!group || item.group === group)
    && `${item.label} ${item.group} ${item.id}`.toLowerCase().replaceAll("mutant", "mutator").includes(query));
  const pages = Math.max(1, Math.ceil(picker.filtered.length / 40));
  picker.page = clamp(picker.page, 0, pages - 1);
  dom["picker-results"].replaceChildren(...picker.filtered.slice(picker.page * 40, picker.page * 40 + 40).map((item) => {
    const row = document.createElement("label"); row.className = "picker-result";
    const input = document.createElement("input"); input.type = "checkbox"; input.checked = picker.selected.has(item.id);
    input.disabled = Boolean(item.unavailable) || used.has(item.id);
    const copy = document.createElement("span"); const label = document.createElement("b"); label.textContent = item.label;
    const detail = document.createElement("small"); detail.textContent = item.unavailable || `${item.group} · ${item.min} to ${item.max}${used.has(item.id) ? " · already added" : ""}`;
    copy.append(label, detail); row.append(input, copy);
    input.addEventListener("change", () => {
      if (input.checked) {
        if (picker.targetIndex !== null) picker.selected.clear();
        else if (picker.selected.size >= MAX_TARGETS - mapping.targets.length) { input.checked = false; return; }
        picker.selected.add(item.id);
      } else picker.selected.delete(item.id);
      renderParameterPicker();
    });
    return row;
  }));
  dom["picker-page"].textContent = `${picker.page + 1} / ${pages} · ${picker.filtered.length} matches`;
  dom["picker-prev"].disabled = picker.page === 0; dom["picker-next"].disabled = picker.page >= pages - 1;
  dom["picker-select-page"].disabled = dom["picker-select-group"].disabled = picker.targetIndex !== null;
  dom["picker-status"].textContent = `${picker.selected.size} selected · ${picker.targetIndex !== null ? "replacing one destination" : `${MAX_TARGETS - mapping.targets.length - picker.selected.size} spaces left in this recipe`}. Hardware entries require MIDI; browser preview plays the musical and preview controls.`;
  dom["picker-add"].disabled = !picker.selected.size;
}

function generateEngineMappings(count, style) {
  const basics = Music.randomMappings(state.fields, 8, style);
  const entries = Parameters.entries.filter((entry) => entry.kind === "nrpn" && entry.randomEligible);
  for (let i = entries.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [entries[i], entries[j]] = [entries[j], entries[i]]; }
  const used = new Set(basics.map((mapping) => Parameters.command(destinationFor(mapping.destination), mapping.minimum)?.key));
  const targets = [];
  for (const entry of entries) {
    const key = Parameters.encode(entry, entry.min)?.key;
    if (!key || used.has(key) || targets.length + basics.length >= count) continue;
    used.add(key);
    let minimum = entry.min, maximum = entry.max;
    if (!entry.discrete && style !== "wild") {
      minimum = entry.min + (entry.max - entry.min) * 0.15;
      maximum = entry.min + (entry.max - entry.min) * (/Attack|Delay|Hold/.test(entry.label) ? 0.35 : 0.85);
    }
    targets.push({ destination: entry.id, minimum: Math.round(minimum), maximum: Math.round(maximum), curve: ["linear", "smooth", "inverse", "steps"][Math.floor(Math.random() * 4)], enabled: true });
  }
  const result = basics.map((mapping) => ({ ...mapping, targets: [{ destination: mapping.destination,
    curve: mapping.curve, minimum: mapping.minimum, maximum: mapping.maximum, enabled: true }] }));
  for (let i = 0; i < targets.length; i++) {
    let mapping = result[i % Math.min(16, Math.max(8, Math.ceil((targets.length + 8) / MAX_TARGETS)))];
    if (!mapping || mapping.targets.length >= MAX_TARGETS) {
      mapping = { ...Music.randomMappings(state.fields, 4, style)[0], targets: [] };
      result.push(mapping);
    }
    mapping.targets.push(targets[i]);
  }
  return result.slice(0, MAX_MAPPINGS).map((mapping) => ({ ...mapping, ...mapping.targets[0] }));
}

function bindLiveInput() {
  dom["live-url"].value = state.saved.live?.url || "ws://localhost:8765";
  dom["live-reconnect"].checked = state.saved.live?.reconnect !== false;
  dom["live-url"].addEventListener("change", saveSettings);
  dom["live-reconnect"].addEventListener("change", updateLiveReconnect);
  dom["live-connect"].addEventListener("click", connectLive);
  dom["live-disconnect"].addEventListener("click", () => { disconnectLive(); updateLiveStatus(); });
  dom["return-to-recording"].addEventListener("click", returnToRecording);
  dom["live-reset-ranges"].addEventListener("click", () => { state.live?.resetRanges(); state.livePlot?.clear(); state.drumMotion?.reset(); showToast("Live input ranges reset"); });
  state.liveMonitorUI = globalThis.HydraLiveMonitor?.init({
    container: document.getElementById("live-monitor"),
    getSnapshot: () => state.liveDiagnostics?.snapshot(state.live, performance.now(), {
      sourceMode: state.sourceMode, wanted: state.liveWanted, status: state.liveStatus,
      retryAt: state.liveRetryAt, url: state.liveUrl || dom["live-url"].value
    }),
    getInspection: (key) => state.liveDiagnostics?.inspect(state.live, key, performance.now()),
    onReconnect: connectLive,
    onClear: () => { state.liveDiagnostics?.clearHistory(performance.now()); updateLiveStatus(); }
  });
  state.liveMonitorUI?.render();
}

function updateLiveReconnect() {
  saveSettings();
  if (!dom["live-reconnect"].checked) {
    window.clearTimeout(state.liveRetry);
    state.liveRetry = null;
    state.liveRetryAt = null;
    if (state.sourceMode === "live" && state.liveWanted && !state.liveSocket)
      state.liveStatus = "Disconnected · automatic reconnect off";
  } else if (state.sourceMode === "live" && state.liveWanted && !state.liveSocket && state.liveRetry === null) {
    openLiveSocket(state.liveGeneration);
    return;
  }
  updateLiveStatus();
}

async function returnToRecording() {
  const recordings = state.library?.recordings || [];
  const recording = recordings.find((item) => item.id === state.saved.lastRecording) || recordings[0];
  if (recording) await selectRecording(recording.id);
  else showToast("Add a recording to the recordings folder, then refresh the list.");
}

function disconnectLive() {
  window.clearTimeout(state.liveConnectTimer);
  state.liveWanted = false;
  state.liveGeneration++;
  window.clearTimeout(state.liveRetry); window.clearTimeout(state.liveRenderTimer);
  state.liveRetry = state.liveRenderTimer = null;
  state.liveRetryAt = null;
  const socket = state.liveSocket; state.liveSocket = null;
  if (socket) { socket.onclose = socket.onmessage = socket.onerror = socket.onopen = null; socket.close(); }
  if (state.live) {
    for (const channel of state.live.channels.values()) channel.at = -Infinity;
    state.live.lastAt = null;
  }
  if (state.sourceMode === "live") stopPlayback();
  state.liveStatus = "Disconnected";
  state.liveDiagnostics?.connection({ state: "disconnected", now: performance.now() });
  if (dom["live-disconnect"]) dom["live-disconnect"].disabled = true;
  updateLiveStatus();
}

function liveInputUrl() {
  const url = new URL(dom["live-url"].value.trim());
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Use a ws:// or wss:// stream address.");
  if (window.location.protocol === "https:" && url.protocol === "ws:") throw new Error("An HTTPS page needs a wss:// stream, or open this dashboard over local HTTP.");
  return url;
}

function connectLive() {
  try { selectLiveInput(liveInputUrl(), true); }
  catch (error) { showToast(error.message || "Enter a valid WebSocket address"); }
}

function selectLiveInput(url, connect) {
  stopPlayback(); saveSettings(); disconnectLive();
  state.sourceMode = "live"; state.live = new Live.Stream(); state.livePlot = new Map(); state.liveWanted = connect;
  state.liveUrl = url.href; state.liveAttempts = 0; state.fields = []; state.fieldIndex = new Map();
  state.liveDiagnostics?.reset({ url: url.href, now: performance.now() });
  state.liveMonitorUI?.reset();
  state.selectionGeneration++; state.seriesCache.clear();
  state.recording = { id: `live:${url.href}`, name: "Live RAPP", channels: [], frames: 0, size_bytes: 0 };
  state.liveNeedsDefaults = !state.saved.workspaces?.[state.recording.id];
  const workspace = Music.restoreWorkspace(state.saved, state.recording.id, [], () => state.nextMappingId++, () => []);
  state.tabs = workspace.tabs; state.activeTabId = state.tabs[workspace.activeIndex].id;
  state.mappings = activeTab().mappings; state.focusedMappingId = state.mappings[0]?.id || null;
  applyMusicalControls(activeTab().controls); state.cursor = 0;
  dom["recording-title"].textContent = "Live RAPP";
  dom["recording-detail"].textContent = url.href;
  state.saved.live = { url: url.href, reconnect: dom["live-reconnect"].checked };
  renderRecordingsForLive(); renderWorkspaces(); renderMappings(); saveSettings();
  if (connect) {
    openLiveSocket(state.liveGeneration);
    state.liveRenderTimer = window.setTimeout(refreshLiveView, 250);
  } else {
    state.liveStatus = "Saved live input · press Connect live to reconnect";
    updateLiveStatus();
  }
}

function renderRecordingsForLive() {
  dom["recording-list"].querySelectorAll(".recording").forEach((button) => { button.classList.remove("is-selected"); button.setAttribute("aria-selected", "false"); });
}

function openLiveSocket(generation) {
  if (!state.liveWanted || generation !== state.liveGeneration) return;
  state.liveRetry = null; state.liveRetryAt = null;
  state.liveDiagnostics?.connection({ state: "connecting", now: performance.now() });
  state.liveStatus = state.liveAttempts ? "Reconnecting…" : "Connecting…"; updateLiveStatus();
  let socket;
  try { socket = new WebSocket(state.liveUrl); }
  catch (error) {
    state.liveStatus = error.message; state.liveWanted = false;
    state.liveDiagnostics?.connection({ state: "error", now: performance.now(), reason: error.message });
    updateLiveStatus(); return;
  }
  state.liveSocket = socket;
  dom["live-disconnect"].disabled = false;
  const current = () => generation === state.liveGeneration && socket === state.liveSocket;
  window.clearTimeout(state.liveConnectTimer);
  state.liveConnectTimer = window.setTimeout(() => {
    if (current() && socket.readyState === WebSocket.CONNECTING) {
      state.liveStatus = "Connection timed out · check address and browser permissions";
      state.liveDiagnostics?.connection({ state: "timeout", now: performance.now() });
      socket.close(); updateLiveStatus();
    }
  }, 10000);
  socket.onopen = () => {
    if (!current()) return;
    window.clearTimeout(state.liveConnectTimer);
    state.liveAttempts = 0; state.liveStatus = "Connected · waiting for data";
    recordStudyEvent("live.connection.opened", { generation, performance_ms: performance.now() });
    state.liveDiagnostics?.connection({ state: "open", now: performance.now() });
    dom["live-disconnect"].disabled = false; updateLiveStatus();
  };
  socket.onmessage = (event) => {
    if (!current()) return;
    if (state.liveDiagnostics) {
      state.liveDiscoveryPending = state.liveDiagnostics.message(event.data, performance.now(), state.live) || state.liveDiscoveryPending;
      return;
    }
    if (typeof event.data !== "string" || event.data.length > 8 * 1024 * 1024) { state.live.invalid++; return; }
    try {
      const frame = JSON.parse(event.data);
      state.liveDiscoveryPending = state.live.ingest(frame, performance.now()) || state.liveDiscoveryPending;
    } catch (_error) { state.live.invalid++; }
  };
  socket.onerror = () => {
    if (!current()) return;
    state.liveStatus = "Connection error · check address and network";
    recordStudyEvent("live.connection.error", { generation, performance_ms: performance.now() });
    state.liveDiagnostics?.connection({ state: "error", now: performance.now() });
    updateLiveStatus();
  };
  socket.onclose = (event) => {
    if (!current()) return;
    recordStudyEvent("live.connection.closed", { generation, code: event?.code || null, reason: String(event?.reason || "").slice(0, 500), performance_ms: performance.now() });
    window.clearTimeout(state.liveConnectTimer);
    state.liveSocket = null; stopPlayback();
    // Old values cannot look fresh after a reconnect, even if it is immediate.
    for (const channel of state.live.channels.values()) channel.at = -Infinity;
    state.live.lastAt = null;
    state.liveRetryAt = null;
    if (state.liveWanted && dom["live-reconnect"].checked) {
      const delay = Math.min(10000, 1000 * 2 ** Math.min(state.liveAttempts++, 4));
      state.liveRetryAt = performance.now() + delay;
      state.liveStatus = `Disconnected · retrying in ${delay / 1000}s`;
      state.liveRetry = window.setTimeout(() => openLiveSocket(generation), delay);
    } else state.liveStatus = "Disconnected";
    state.liveDiagnostics?.connection({ state: "closed", now: performance.now(), code: event?.code,
      reason: event?.reason, retryAt: state.liveRetryAt });
    updateLiveStatus();
  };
}

function updateLiveStatus() {
  renderPlaybackAvailability();
  updateConnectionSummary();
  state.liveMonitorUI?.render();
  if (!dom["live-status"]) return;
  let label = state.liveStatus;
  if (state.liveSocket?.readyState === 1 && state.live?.lastAt !== null) {
    const age = performance.now() - state.live.lastAt;
    label = age > 3000 ? "Stream idle · waiting for fresh data" : `${state.live.channels.size} channels · ${state.live.fields.length} fields · ${state.live.frames} frames`;
  }
  dom["live-status"].textContent = label + (state.live?.invalid ? ` · ${state.live.invalid} invalid frames ignored` : "");
}

function refreshLiveView() {
  if (state.sourceMode !== "live" || !state.liveWanted) return;
  if (state.liveDiscoveryPending) {
    state.liveDiscoveryPending = false; state.fields = state.live.fields; state.fieldIndex = new Map(state.fields.map((field) => [field.key, field]));
    if (state.liveNeedsDefaults && state.fields.length) {
      state.mappings = createDefaultMappings(); state.focusedMappingId = state.mappings[0]?.id;
      state.liveNeedsDefaults = false;
    }
    renderWorkspaces(); renderMappings(); renderDrumSources(); saveSettings();
  }
  dom["recording-detail"].textContent = `${state.liveUrl} · ${state.live?.channels.size || 0} channels · latest values`;
  updateLiveStatus(); drawLiveWaveform(); updateMappingRangeReadouts();
  state.liveRenderTimer = window.setTimeout(refreshLiveView, 250);
}

function liveMappingValue(mapping, now) {
  const samples = mapping.sources.map((source) => state.live?.read(source, now));
  if (!samples.length || samples.some((sample) => !sample)) return null;
  const values = samples.map((sample) => sample.normalized);
  let value = combineValues(values, mapping.operator, mapping.sources.map((source) => source.weight));
  if (mapping.operator === "sum") value /= values.length;
  if (mapping.operator === "difference") value = (value + 1) / 2;
  return clamp(value, 0, 1);
}

function drawLiveWaveform() {
  if (state.sourceMode !== "live") return;
  if (state.output === "drums") { drawDrumLiveWaveform(); return; }
  const mapping = state.mappings.find((item) => item.id === state.focusedMappingId);
  if (!mapping) { clearWaveform("Waiting for RAPP data and mappings."); return; }
  const now = performance.now();
  const value = liveMappingValue(mapping, now);
  if (value === null) { clearWaveform("Waiting for fresh data from every source in this recipe."); return; }
  state.livePlot ||= new Map();
  const history = state.livePlot.get(mapping.id) || [];
  history.push([now, value]);
  if (history.length > 256) history.shift();
  if (!state.livePlot.has(mapping.id) && state.livePlot.size >= MAX_MAPPINGS * MAX_TABS) state.livePlot.delete(state.livePlot.keys().next().value);
  state.livePlot.set(mapping.id, history);
  const points = history.map((point, index, all) => [index / Math.max(1, all.length - 1), point[1]]);
  renderWaveform({ points, minimum: 0, maximum: 1 });
  dom["wave-progress"].textContent = "LIVE";
  updateSourceSummary();
}
