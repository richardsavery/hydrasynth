"use strict";

// Mixer preferences stay separate from the previous music interface.
globalThis.HydraMusicMixer = (() => {
  const KEY = "hydra.music-mixer.demo.v1";
  const UPLOAD_KEY = "hydra.music-mixer.upload.v1", MAX_UPLOAD_BYTES = 128 * 1024 * 1024;
  const study = (type, payload) => { try { globalThis.HydraStudy?.emit?.(type, payload); } catch (_) {} };
  let studyTransport = "", studyGeneration = "";
  let mappingTracker, mappingMutationDepth = 0, pendingMappingSnapshot, viewSequence = 0;
  const OPERATORS = { average: "Average", weighted: "Weighted blend", difference: "Difference", minimum: "Lowest", maximum: "Highest" };
  const READ_MODES = { value: "Direct value", mean: "Average", rms: "RMS magnitude", minimum: "Lowest value", maximum: "Highest value", index: "One element" };
  const LABELS = { cutoff: "Low-pass filter", highpass: "High-pass filter", resonance: "Resonance", gain: "Volume", pan: "Pan", delayMix: "Delay", reverbMix: "Reverb", rate: "Playback speed", pitch: "Pitch shift · semitones" };
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const format = (value) => !finite(value) ? "—" : Math.abs(value) >= 1000 ? value.toFixed(0) : Number(value.toFixed(3)).toString();
  const percent = (value) => finite(value) ? `${Math.round(value * 100)}%` : "—";
  const controlValue = (key, value) => key === "rate" ? percent(value)
    : key === "pitch" ? `${value > 0 ? "+" : ""}${format(value)} st`
      : format(value) + (["cutoff", "highpass"].includes(key) ? " Hz" : "");
  const time = (value) => `${Math.floor((value || 0) / 60)}:${String(Math.floor((value || 0) % 60)).padStart(2, "0")}`;
  let root, engine, generation, config, snapshot, sourceBridge, signalLibrary, savedRap, initialized = false, active = false;
  let generationState = { phase: "idle", enabled: false }, shownTrackId = null;
  let tracks = [], selectedId = "", nextTrackId = "", fieldsKey = "", fetchRun = 0, controller, lastSave = 0, loadingTrack = false, rendering = false;
  let custom = null, customBusy = false, customMessage = "", customError = false, customRun = 0, customTimer, customController, selectionRevision = 0, separationReady = null;
  let beatBusy = false, beatRun = 0, beatTimer, beatController, beatMessage = "", beatError = false, beatAvailable = null, beatSetupError = "";
  const history = new Map();
  const plans = new Map();
  const beatAnalyses = new Map();
  const automaticBeats = (track = snapshot?.track) => track?.origin === "uploaded" && engine?.getConfig().beatTracking?.[track.id]?.mode !== "manual";
  const $ = (id) => root.querySelector(`#mm-${id}`);
  const api = () => globalThis.HydraMusicMixerEngine;
  const fields = () => snapshot?.fields || [];
  let skeletonDetail = "region";
  const visibleFields = (available = fields(), selected) => available.filter((field) => !field.skeletonLevel
    || field.key === selected || field.skeletonLevel === skeletonDetail || (skeletonDetail === "axis" && field.skeletonLevel === "raw"));
  const sourceFor = (key, available = fields()) => {
    const field = available.find((item) => item.key === key);
    return globalThis.HydraElevenRealtime.validateSource({ sourceKey: key || "__unassigned", reducer: field?.default_reducer || field?.reducers?.[0] || "mean", rangeMode: "auto" });
  };
  const newBus = (id, name, key) => ({ id, name, operator: "average", sources: [sourceFor(key)] });
  function notice(message, error = false) {
    $("notice").textContent = message;
    $("notice").hidden = !message;
    $("notice").classList.toggle("is-error", error);
  }
  function nextTrackChoice() {
    const mode = $("next-mode").value;
    return { mode: ["loop", "similar", "new", "old"].includes(mode) ? mode : "new", trackId: nextTrackId };
  }
  function promptDraft() {
    const next = nextTrackChoice();
    return { style: $("prompt").value, bpm: $("bpm").value, key: $("key").value,
      palette: $("instruments").value, duration: $("duration").value,
      next_mode: next.mode, next_track_id: next.trackId,
      continuity_mode: next.mode === "similar" ? "evolve" : "fresh" };
  }
  function generationSettings() {
    const draft = promptDraft();
    const request = globalThis.HydraElevenLabs.originalPlanRequest(draft.duration, {
      style: draft.style.replace(/\s+/g, " ").trim(), bpm: Number(draft.bpm), key: draft.key.trim(),
      instrument_palette: draft.palette.split(",").map((value) => value.trim()).filter(Boolean),
      enable_variability: false, context_adherence: "high", seed: null
    });
    return { duration_seconds: request.duration_seconds, settings: request.settings, continuity_mode: draft.continuity_mode };
  }
  function restorePrompt(draft = {}) {
    $("prompt").value = typeof draft?.style === "string" ? draft.style.slice(0, 300) : "Warm instrumental electronic music, evolving textures and a steady groove";
    $("bpm").value = draft?.bpm ?? 100;
    $("key").value = typeof draft?.key === "string" ? draft.key.slice(0, 80) : "D minor";
    $("instruments").value = typeof draft?.palette === "string" ? draft.palette : "synthesizer, bass, drums";
    $("duration").value = [20, 40, 60].includes(Number(draft?.duration)) ? String(draft.duration) : "60";
    $("next-mode").value = ["loop", "similar", "new", "old"].includes(draft?.next_mode)
      ? draft.next_mode : draft?.continuity_mode === "evolve" ? "similar" : "new";
    nextTrackId = typeof draft?.next_track_id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(draft.next_track_id) ? draft.next_track_id : "";
    renderNextTracks();
  }
  function getState() { return engine ? { trackId: selectedId, config: engine.getConfig(), prompt: promptDraft(), signalLinks: signalLibrary?.getLinks() || {}, ...(savedRap !== undefined ? { rap: savedRap } : {}) } : null; }
  function flush() { const state = getState(); if (state) localStorage.setItem(KEY, JSON.stringify(state)); return state; }
  function save() { try { flush(); } catch (_) { /* Session-only mixing remains available. */ } }
  function captureMapping(reason, details = {}) {
    try { return mappingTracker?.capture({ config: engine.getConfig(), signalLinks: signalLibrary?.getLinks() || {} }, { reason, ...details }); }
    catch (_) { /* Recording must not interrupt music. */ }
  }
  function mappingRevision() { try { return mappingTracker?.current()?.revision_id || null; } catch (_) { return null; } }
  function recordMappingPlayback(next) {
    try { mappingTracker?.playback(null, { running: next.running === true, track_id: next.track?.id || null,
      source_valid: next.sourceValid === true, source_label: next.sourceLabel || null }); } catch (_) { /* Keep playback independent of recording. */ }
  }
  function onEngineUpdate(next) {
    if (mappingMutationDepth) { pendingMappingSnapshot = next; return; }
    updateView(next);
  }
  function changeMapping(change, reason, details = {}, publish = true) {
    // Engine changes emit synchronously. Record their normalized configuration
    // and shared links before associating the resulting output with a revision.
    mappingMutationDepth++;
    try {
      const accepted = change();
      config = engine.getConfig();
      if (accepted !== false) {
        if (publish) publishSignals();
        // A mutation can reveal that playback stopped before its next normal
        // update. Close the old association before creating a new revision.
        if (pendingMappingSnapshot?.running === false) recordMappingPlayback(pendingMappingSnapshot);
        captureMapping(reason, details);
      }
      return accepted;
    } finally {
      mappingMutationDepth--;
      if (!mappingMutationDepth && pendingMappingSnapshot) {
        const next = pendingMappingSnapshot; pendingMappingSnapshot = null; updateView(next);
      }
    }
  }
  function publishSignals() {
    try { signalLibrary?.publish(config); } catch (error) { notice(error.message || "Could not save the shared mix.", true); }
  }
  function libraryRow(bus) {
    const linked = signalLibrary?.linkFor(bus.id);
    return `<div class="mm-library-state ${linked ? "is-shared" : ""}"><span>${linked ? "Shared mix" : "Independent mix"}</span><button class="mm-button" data-action="${linked ? "detach-mix" : "share-mix"}">${linked ? "Make independent" : "Share mix"}</button></div>`;
  }
  function renderLibrary() {
    const select = $("shared-mix"), previous = select.value;
    const mixes = globalThis.HydraSignalLibrary?.getState().mixes || [];
    const added = new Set(config.buses.map((bus) => signalLibrary?.linkFor(bus.id)?.id).filter(Boolean));
    select.innerHTML = '<option value="">Choose a shared mix…</option>' + mixes.map((entry) => `<option value="${escape(entry.id)}" ${entry.mode !== config.mode || added.has(entry.id) ? "disabled" : ""}>${escape(entry.bus.name)} · ${entry.mode === "demo" ? "Demo signals" : "Connections input"}${added.has(entry.id) ? " · Already added" : ""}</option>`).join("");
    if (mixes.some((entry) => entry.id === previous && entry.mode === config.mode && !added.has(entry.id))) select.value = previous;
    $("add-shared").disabled = config.buses.length >= 4 || !select.value;
    select.disabled = !mixes.length || config.buses.length >= 4;
  }
  function syncSignals() {
    config = engine.getConfig();
    const previousLinks = JSON.stringify(signalLibrary?.getLinks() || {});
    if (signalLibrary?.sync(config)) { changeMapping(() => engine.setConfig(config), "shared_synchronized", {}, false); history.clear(); }
    else if (previousLinks !== JSON.stringify(signalLibrary?.getLinks() || {})) captureMapping("shared_synchronized");
    renderBuses(); renderChannels(); save();
  }
  function commit(render = "all", reason = "configuration_changed", details = {}) {
    changeMapping(() => engine.setConfig(config), reason, details);
    if (render === "all" || render === "buses") renderBuses();
    if (render === "all" || render === "channels") renderChannels();
    save();
  }
  function readable(value) {
    const label = String(value || "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  function fieldLabel(field) {
    if (!field) return "Choose an input";
    const name = field.optionLabel || field.name || field.label || field.fieldId || field.key;
    if (field.skeletonLevel) return readable(name);
    if (["position", "velocity"].includes(field.kind)) {
      const joint = field.label || name.replace(new RegExp(`\\s+${field.kind}$`, "i"), "");
      return `${readable(joint)} · ${readable(field.kind)}`;
    }
    return readable(name);
  }
  const channelLabel = (field) => readable(field?.channelName || field?.channelId || (field?.key?.startsWith("demo:") ? "Simulated signal" : ""));
  const combinationLabel = (bus) => bus.sources.length === 1 ? "Single input" : `${bus.sources.length} inputs · ${OPERATORS[bus.operator]}`;
  function sourceOptions(selected) {
    const items = visibleFields(fields(), selected), groups = new Map();
    for (const field of items) {
      const channel = channelLabel(field);
      if (!groups.has(channel)) groups.set(channel, []);
      groups.get(channel).push(field);
    }
    const missing = !items.some((item) => item.key === selected) ? `<option value="${escape(selected)}">${selected === "__unassigned" ? "Choose an input" : `Unavailable · ${escape(selected)}`}</option>` : "";
    return missing + [...groups].map(([channel, group]) => {
      const options = group.map((field) => `<option value="${escape(field.key)}" ${field.key === selected ? "selected" : ""}>${escape(fieldLabel(field))}</option>`).join("");
      return channel ? `<optgroup label="${escape(channel)}">${options}</optgroup>` : options;
    }).join("");
  }
  function sourceHTML(source, index, bus) {
    const field = fields().find((item) => item.key === source.sourceKey);
    const reducers = [...new Set([...(field?.reducers || ["value", "mean", "rms", "minimum", "maximum", "index"]), source.reducer])];
    return `<div class="mm-source" data-source="${index}">
      <div class="mm-source-line"><label class="sr-only" for="mm-${escape(bus.id)}-source-${index}">Input ${index + 1} for ${escape(bus.name)}</label><select id="mm-${escape(bus.id)}-source-${index}" data-source-field="sourceKey">${sourceOptions(source.sourceKey)}</select><output data-raw title="Incoming value">—</output><button class="mm-button mm-icon" data-action="remove-source" aria-label="Remove input ${index + 1}" ${bus.sources.length === 1 ? "disabled" : ""}>×</button></div>
      <p class="mm-source-caption"${field?.kind === "motion" ? ' title="Movement speed combines X, Y and Z. Regions average their tracked joints."' : ""}>${escape(field ? [channelLabel(field), field.kind === "motion" ? "Movement speed · m/s" : source.reducer === "index" ? `Element ${source.index + 1}` : READ_MODES[source.reducer] || readable(source.reducer)].filter(Boolean).join(" · ") : source.sourceKey === "__unassigned" ? "No input selected" : "Input unavailable")}</p>
      <meter min="0" max="1" value="0" data-source-meter aria-label="Normalized input ${index + 1}"></meter>
      <details class="mm-source-details"><summary><span data-range-summary>${source.rangeMode === "auto" ? "Auto learn" : "Fixed range"}</span> <span data-bounds></span></summary>
        <div class="mm-pair"><label>Read as<select data-source-field="reducer">${reducers.map((reducer) => `<option value="${escape(reducer)}" ${reducer === source.reducer ? "selected" : ""}>${escape(READ_MODES[reducer] || readable(reducer))}</option>`).join("")}</select></label><label>Range<select data-source-field="rangeMode"><option value="auto" ${source.rangeMode === "auto" ? "selected" : ""}>Auto learn</option><option value="fixed" ${source.rangeMode === "fixed" ? "selected" : ""}>Fixed</option></select></label></div>
        ${source.reducer === "index" ? `<label>Element index (starts at 0)<input type="number" min="0" max="262143" step="1" data-source-field="index" value="${source.index}"></label>` : ""}
        <div class="mm-pair"><label>Minimum<input type="number" step="any" data-source-field="inputMin" value="${source.inputMin}" ${source.rangeMode === "auto" ? "disabled" : ""}></label><label>Maximum<input type="number" step="any" data-source-field="inputMax" value="${source.inputMax}" ${source.rangeMode === "auto" ? "disabled" : ""}></label></div>
        ${bus.operator === "weighted" ? `<label>Weight<input type="number" min="0" max="100" step="0.1" data-source-field="weight" value="${source.weight}"></label>` : ""}
        <div class="mm-pair"><button class="mm-button" data-action="freeze">Freeze range</button><button class="mm-button" data-action="relearn">Learn again</button></div>
      </details></div>`;
  }
  function renderBuses() {
    rendering = true;
    try {
    $("skeleton-detail-field").hidden = !fields().some((field) => field.skeletonLevel);
    $("skeleton-detail").value = skeletonDetail;
    $("buses").innerHTML = config.buses.map((bus, i) => `<article class="mm-bus mm-color-${i % 4}" data-bus="${escape(bus.id)}">
      <div class="mm-bus-head"><span class="mm-bus-letter">${String.fromCharCode(65 + i)}</span><input data-bus-name value="${escape(bus.name)}" maxlength="30" aria-label="Signal mix name"><output data-bus-value>—</output><button class="mm-button mm-icon" data-action="remove-bus" aria-label="Remove ${escape(bus.name)}" ${config.buses.length === 1 ? "disabled" : ""}>×</button></div>
      <p class="mm-bus-combination">${escape(combinationLabel(bus))}</p>${libraryRow(bus)}
      <svg class="mm-scope" viewBox="0 0 300 54" preserveAspectRatio="none" role="img" aria-label="${escape(bus.name)} ${bus.sources.length > 1 ? "combined " : ""}signal history"><path class="mm-scope-grid" d="M0 13.5H300 M0 27H300 M0 40.5H300 M75 0V54 M150 0V54 M225 0V54"/><path data-scope d=""/></svg>
      <div class="mm-sources">${bus.sources.map((source, index) => sourceHTML(source, index, bus)).join("")}</div>
      <div class="mm-bus-footer"><label>Combine inputs<select data-operator ${bus.sources.length < 2 ? 'disabled title="Add another input to combine signals"' : ""}>${Object.entries(OPERATORS).map(([value, label]) => `<option value="${value}" ${bus.operator === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><button class="mm-button" data-action="add-source" ${bus.sources.length >= 6 ? "disabled" : ""}>+ Input</button></div>
      <p class="mm-bus-status" data-bus-status>Waiting for input</p></article>`).join("");
    $("add-bus").disabled = config.buses.length >= 4;
    renderLibrary();
    renderRouteSources();
    } finally { rendering = false; }
  }
  function routeHTML(route, index, channel) {
    const targets = Object.keys(LABELS).filter((target) => channel.name === "master" || target !== "rate");
    const limits = globalThis.HydraElevenRealtime.TARGETS[route.target];
    return `<div class="mm-route mm-color-${Math.max(0, config.buses.findIndex((bus) => bus.id === route.busId)) % 4}" data-route="${index}"><div class="mm-route-top"><span>Signal → effect</span><button class="mm-button mm-icon" data-action="remove-route" aria-label="Remove mapping ${index + 1} from ${escape(channel.name)}">×</button></div>
      <label>Signal mix<select data-route-field="busId">${!config.buses.some((bus) => bus.id === route.busId) ? '<option value="">Choose a mix</option>' : ""}${config.buses.map((bus) => `<option value="${escape(bus.id)}" ${route.busId === bus.id ? "selected" : ""}>${escape(bus.name)}</option>`).join("")}</select></label>
      <p class="mm-route-source" data-route-source></p>
      <label>Controls<select data-route-field="target">${targets.map((value) => `<option value="${value}" ${route.target === value ? "selected" : ""}>${LABELS[value]}</option>`).join("")}</select></label>
      <label class="mm-strength" title="0% keeps the manual setting; 100% applies the full signal mapping."><span>Signal strength <output data-strength-value>${percent(route.strength ?? 1)}</output></span><input type="range" min="0" max="100" step="1" value="${Math.round((route.strength ?? 1) * 100)}" data-route-field="strength" aria-label="${escape(channel.name === "master" ? "Master" : channel.name)} ${LABELS[route.target]} signal strength" aria-valuetext="${percent(route.strength ?? 1)}"></label>
      <details><summary>Range & direction</summary><div class="mm-pair"><label>From<input type="number" step="any" min="${limits.min}" max="${limits.max}" value="${route.outputMin}" data-route-field="outputMin"></label><label>To<input type="number" step="any" min="${limits.min}" max="${limits.max}" value="${route.outputMax}" data-route-field="outputMax"></label></div><label class="mm-check"><input type="checkbox" data-route-field="invert" ${route.invert ? "checked" : ""}> Reverse</label></details></div>`;
  }
  function renderRouteSources() {
    for (const element of root.querySelectorAll("[data-route]")) {
      const bus = config.buses.find((item) => item.id === element.querySelector('[data-route-field="busId"]').value);
      const caption = element.querySelector("[data-route-source]");
      caption.textContent = !bus ? "Choose a signal mix" : bus.sources.length > 1 ? combinationLabel(bus) : fieldLabel(fields().find((field) => field.key === bus.sources[0]?.sourceKey));
      caption.title = bus ? bus.sources.map((source) => {
        const field = fields().find((item) => item.key === source.sourceKey);
        return field ? [channelLabel(field), fieldLabel(field)].filter(Boolean).join(" / ") : source.sourceKey === "__unassigned" ? "Choose an input" : "Input unavailable";
      }).join(" + ") : "";
    }
  }
  function renderChannels() {
    rendering = true;
    try {
    $("channels").innerHTML = config.channels.map((channel, i) => {
      const master = channel.name === "master", name = master ? "Master" : channel.name;
      return `<article class="mm-channel ${master ? "mm-master" : ""} ${channel.muted ? "is-muted" : ""}" data-channel="${escape(channel.name)}">
        <div class="mm-channel-head"><span>${master ? "OUT" : String(i).padStart(2, "0")}</span><h3>${escape(name)}</h3><small>${master ? "Full mix" : "Stem"}</small></div>
        <div class="mm-channel-buttons"><button class="mm-button" data-action="mute" aria-pressed="${channel.muted}" aria-label="Mute ${escape(name)}">Mute</button>${master ? "" : `<button class="mm-button" data-action="solo" aria-pressed="${channel.solo}" aria-label="Solo ${escape(name)}">Solo</button>`}</div>
        <div class="mm-fader-area"><div class="mm-fader-scale" aria-hidden="true"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div><input class="mm-fader" type="range" min="0" max="1" step="0.01" value="${channel.level}" data-channel-field="level" aria-label="${escape(name)} volume"><div class="mm-level-meter" title="Effective volume setting after mappings" role="meter" aria-label="${escape(name)} effective volume setting" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i data-level-meter></i></div></div>
        <div class="mm-level-readout"><output data-fader-value>${percent(channel.level)}</output><small data-effective-level>Effective —</small></div>
        <div class="mm-knob-row"><label><span>Pan <output data-control-value="pan">${format(channel.pan)}</output></span><input type="range" min="-1" max="1" step="0.01" value="${channel.pan}" data-channel-field="pan" aria-label="${escape(name)} pan"></label><label><span>Low pass <output data-control-value="cutoff">${format(channel.cutoff)} Hz</output></span><input type="range" min="20" max="20000" step="1" value="${channel.cutoff}" data-channel-field="cutoff" aria-label="${escape(name)} low-pass filter"></label></div>
        <details class="mm-effects"><summary>More effects</summary>${[["highpass", "High pass", 20, 6000, 1], ["reverbMix", "Reverb", 0, 0.85, 0.01], ["delayMix", "Delay", 0, 0.85, 0.01], ["pitch", "Pitch shift", -12, 12, 0.1], ...(master ? [["rate", "Playback speed", 0.75, 1.25, 0.01]] : [])].map(([key, label, min, max, step]) => `<label><span>${label} <output data-control-value="${key}">${controlValue(key, channel[key])}</output></span><input type="range" min="${min}" max="${max}" step="${step}" value="${channel[key]}" data-channel-field="${key}" aria-label="${escape(name)} ${label}"></label>`).join("")}</details>
        <div class="mm-routes">${channel.routes.map((route, index) => routeHTML(route, index, channel)).join("")}</div><button class="mm-button mm-add-route" data-action="add-route" ${channel.routes.length >= (master ? 9 : 8) ? "disabled" : ""}>+ Map a signal</button></article>`;
    }).join("");
    $("stem-hint").textContent = config.channels.length > 1 ? `${config.channels.length - 1} stems` : selectedId ? "Full mix" : "";
    renderRouteSources();
    } finally { rendering = false; }
  }
  function renderTransport() {
    const next = snapshot || {}, first = generationState.phase === "generating-first", choice = nextTrackChoice();
    const saved = choice.mode === "old", looping = choice.mode === "loop";
    $("next-track-field").hidden = !saved;
    $("play").disabled = loadingTrack || !next.track || next.running || next.starting || first;
    $("generate").disabled = loadingTrack || next.running || next.starting || first
      || (generationState.busy && !saved && !(looping && next.track)) || generationState.savedBusy === true || (saved && !choice.trackId);
    $("generate").textContent = first ? "Creating music…" : saved ? "Play selected track"
      : looping ? next.track ? "Play current track" : "Create starting track" : "Start music";
    $("stop").disabled = !next.running && !next.starting && !generationState.enabled && !first;
    $("play").textContent = next.starting ? next.beatTiming?.state === "preparing" ? "Aligning beats…" : "Loading…" : "▶ Play saved track";
    $("track").disabled = first;
    $("retry").hidden = generationState.phase !== "error";
    $("current").textContent = next.track ? trackLabel(next.track) : "—";
    $("next").textContent = generationState.phase === "looping" ? "Repeating current track"
      : generationState.phase === "loading-saved" ? "Loading selected track…"
      : generationState.phase === "waiting-track" ? "Choose a saved track"
      : generationState.phase === "generating-first" ? "Creating first track…"
      : generationState.phase === "updating-prompt" ? "Updating next track…"
      : generationState.phase === "waiting-prompt" ? "Finish the next track prompt"
      : generationState.phase === "waiting-retry" ? "Waiting to generate next track…"
      : generationState.phase === "generating-next" ? "Generating next track…"
      : generationState.phase === "ready" && generationState.queuedId ? "Next track ready · automatic crossfade"
      : generationState.phase === "error" ? next.running ? "Repeating current track" : "Generation stopped"
      : generationState.enabled ? "Preparing next track…" : "—";
    const savedTrack = tracks.find((track) => track.id === choice.trackId);
    const nextLabel = looping ? "" : saved ? choice.trackId ? savedTrack ? trackLabel(savedTrack) : "Selected saved track" : "" : generationState.nextPrompt || "";
    $("up-next").hidden = !next.running || !generationState.enabled || !nextLabel;
    $("next-prompt").textContent = nextLabel;
    renderCustom();
  }
  function updateGeneration(next) {
    if (globalThis.HydraStudy?.emit) {
      const value = { phase: next.phase, enabled: next.enabled, error: next.error || null,
        job_id: next.pendingId || null, current_track_id: next.currentId || selectedId || null, queued_track_id: next.queuedId || null,
        next_mode: next.nextMode || null, selected_track_id: next.selectedTrackId || null, next_prompt: next.nextPrompt || null,
        retry_at: next.retryAt ?? null, recovering: next.recovering || false };
      const key = JSON.stringify(value);
      if (key !== studyGeneration) { studyGeneration = key; study("music.generation.state", value); }
    }
    const previous = generationState;
    generationState = next; renderTransport();
    if (next.phase === "error" || next.phase === "waiting-prompt") notice(next.error || "Could not prepare the next track.", true);
    else if (["error", "waiting-prompt"].includes(previous.phase)) notice("");
  }
  function rememberTrack(track) {
    tracks = [track, ...tracks.filter((item) => item.id !== track.id)].slice(0, 100);
    renderTracks();
  }
  function syncTrack(track) {
    if (!track || track.id === shownTrackId) return;
    stopBeatChecks(); beatMessage = ""; beatError = false;
    if (track.beat_analysis) beatAnalyses.set(track.id, track.beat_analysis);
    shownTrackId = track.id; selectedId = track.id;
    rememberTrack(track);
    const names = ["master", ...[...new Set(api().stemsForTrack(track).map((stem) => stem.name))].filter((name) => name !== "master").slice(0, 6)];
    config = engine.getConfig();
    config.includeVocals = track.origin === "uploaded";
    config.channels = names.map((name) => config.channels.find((channel) => channel.name === name) || api().defaultChannel(name));
    commit("channels", "track_channels_changed", { track_id: track.id });
  }
  function updateView(next) {
    if (!root) return;
    const sequence = ++viewSequence;
    snapshot = next;
    // Automatic preparation installs metadata in the engine. Prefer that result
    // to an older manual-analysis response cached by this view.
    if (automaticBeats(next.track) && next.track?.beat_analysis) beatAnalyses.set(next.track.id, next.track.beat_analysis);
    if (engine && next.track?.id !== shownTrackId) syncTrack(next.track);
    // Promoting a track can synchronously publish a newer snapshot after its
    // channels are normalized. That snapshot supersedes this earlier output.
    if (sequence !== viewSequence) return;
    recordMappingPlayback(next);
    if (globalThis.HydraStudy?.emit) {
      const transport = { running: next.running, starting: next.starting, active: next.active, track_id: next.track?.id || null,
        queued_track_id: next.queuedTrack?.id || null, source_valid: next.sourceValid, source_label: next.sourceLabel || null, error: next.error || null };
      const key = JSON.stringify(transport);
      if (key !== studyTransport) { studyTransport = key; study("music.transport.state", { ...transport, mapping_revision_id: mappingRevision(), position_seconds: next.position, duration_seconds: next.duration }); }
      if (next.running) study("music.output.controls", { track_id: next.track?.id || null, position_seconds: next.position,
        mapping_revision_id: mappingRevision(), source_valid: next.sourceValid, controls: next.controls, buses: next.buses, channels: next.channels });
    }
    generation?.update(next);
    renderTransport();
    $("source-label").textContent = next.sourceLabel || "Choose an input in Connections";
    $("clock").textContent = `${time(next.position)} / ${time(next.duration)}`;
    $("progress").value = next.duration ? next.position / next.duration : 0;
    $("transport-status").textContent = next.running ? next.sourceValid ? "Playing" : "Waiting for mapped input" : next.starting ? next.beatTiming?.state === "preparing" ? "Aligning beats…" : "Loading audio" : "Stopped";
    const nextKey = JSON.stringify(next.fields || []);
    if (nextKey !== fieldsKey) { fieldsKey = nextKey; if (config) renderBuses(); }
    for (const bus of next.buses || []) {
      const element = [...root.querySelectorAll("[data-bus]")].find((item) => item.dataset.bus === bus.id);
      if (!element) continue;
      element.querySelector("[data-bus-value]").textContent = percent(bus.value);
      const inputCount = bus.sources?.length || 0, readyCount = (bus.sources || []).filter((source) => source.valid).length;
      element.querySelector("[data-bus-status]").textContent = finite(bus.value) ? inputCount > 1 ? "Combined signal ready" : "Input ready"
        : inputCount > 1 ? `Waiting for ${inputCount - readyCount} of ${inputCount} inputs` : "Waiting for input";
      const points = history.get(bus.id) || []; points.push(finite(bus.value) ? bus.value : null); if (points.length > 90) points.shift(); history.set(bus.id, points);
      let path = "", continuing = false;
      points.forEach((value, i) => { if (!finite(value)) { continuing = false; return; } path += `${continuing ? "L" : "M"}${(i * 300 / 89).toFixed(1)},${(51 - value * 48).toFixed(1)} `; continuing = true; });
      element.querySelector("[data-scope]").setAttribute("d", path);
      (bus.sources || []).forEach((source, index) => {
        const row = element.querySelector(`[data-source="${index}"]`); if (!row) return;
        row.querySelector("[data-raw]").textContent = format(source.value);
        row.querySelector("[data-source-meter]").value = source.normalized || 0;
        row.querySelector("[data-bounds]").textContent = `${format(source.minimum)} … ${format(source.maximum)}`;
      });
    }
    for (const channel of next.channels || []) {
      const element = [...root.querySelectorAll("[data-channel]")].find((item) => item.dataset.channel === channel.name);
      if (!element) continue;
      const gain = finite(channel.gain) ? channel.gain : 0;
      element.querySelector("[data-level-meter]").style.height = `${gain * 100}%`;
      element.querySelector(".mm-level-meter").setAttribute("aria-valuenow", String(Math.round(gain * 100)));
      element.querySelector("[data-effective-level]").textContent = `Effective ${percent(gain)}`;
      element.classList.toggle("is-muted", channel.muted || (channel.name !== "master" && config.channels.some((item) => item.name !== "master" && item.solo) && !channel.solo));
    }
    if (active && performance.now() - lastSave > 2000) { lastSave = performance.now(); save(); }
  }
  async function read(path, signal) {
    const response = await fetch(`/api/elevenlabs${path}`, { cache: "no-store", signal });
    if (!response.ok) {
      const error = new Error(`Could not load saved music (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  function renderTracks() {
    const missing = selectedId && !tracks.some((track) => track.id === selectedId);
    $("track").innerHTML = '<option value="">Recall a track…</option>'
      + (missing ? `<option value="${escape(selectedId)}">Saved track unavailable · ${escape(selectedId)}</option>` : "")
      + tracks.map((track) => `<option value="${escape(track.id)}">${escape(trackLabel(track))}</option>`).join("");
    $("track").value = selectedId;
    renderNextTracks();
  }
  function renderNextTracks() {
    const missing = nextTrackId && !tracks.some((track) => track.id === nextTrackId);
    $("next-track").innerHTML = '<option value="">Choose a saved track…</option>'
      + (missing ? `<option value="${escape(nextTrackId)}">Saved track unavailable</option>` : "")
      + tracks.map((track) => `<option value="${escape(track.id)}">${escape(trackLabel(track))}</option>`).join("");
    $("next-track").value = nextTrackId;
  }
  function trackLabel(track) {
    const label = globalThis.HydraElevenLabs.musicLabel(track, plans.get(track.plan_id));
    return track.origin === "uploaded" ? `${label} · Uploaded` : label;
  }
  function readyTrack(job) {
    return job.state === "complete" && (job.origin === "uploaded" || job.separate_stems !== true || (job.stem_separation?.state === "complete" && job.stem_separation.stems?.length));
  }
  function persistCustom() {
    try {
      if (custom) localStorage.setItem(UPLOAD_KEY, JSON.stringify({ id: custom.id, name: custom.name,
        upload_pending: custom.upload_pending === true, separation_intent: custom.separation_intent === true }));
      else localStorage.removeItem(UPLOAD_KEY);
    } catch (_) { /* Uploads remain available in Recent tracks. */ }
  }
  function renderCustom() {
    const state = custom?.stem_separation?.state;
    const pending = ["queued", "generating", "submitting", "separating", "running"].includes(state);
    $("audio-file").disabled = customBusy || pending;
    $("separate").disabled = customBusy || !custom || custom.state !== "complete" || separationReady === false
      || pending || ["complete", "unknown", "failed"].includes(state) || custom.separation_intent === true && !state;
    $("separate").textContent = pending ? "Separating…" : state === "complete" ? "Stems ready" : "Separate with ElevenLabs";
    $("custom-load").hidden = !custom || custom.state !== "complete" || (selectedId === custom.id && (!custom.stem_separation?.stems?.length || snapshot?.track?.stems?.length));
    $("custom-load").disabled = loadingTrack || snapshot?.starting === true;
    $("custom-check").hidden = !custom || customBusy || (!customError && !pending && !["unknown", "failed"].includes(state) && !custom.upload_pending && custom.state === "complete");
    $("custom-cost").hidden = !custom;
    $("custom-cost").textContent = separationReady === false ? "ElevenLabs separation is unavailable. Configure the API key in server settings; local audio playback still works."
      : "Uploads this audio to ElevenLabs and uses credits.";
    $("custom-tempo").hidden = custom?.state !== "complete" || snapshot?.track?.id !== custom?.id;
    if (globalThis.document?.activeElement !== $("track-bpm")) $("track-bpm").value = String(engine?.getConfig().uploadedBpms?.[custom?.id] ?? "");
    $("custom-status").textContent = customMessage || (custom?.upload_pending ? `${custom.name}: checking local upload…`
      : pending ? `${custom.name}: separating stems with ElevenLabs…`
        : state === "unknown" ? `${custom.name}: the separation outcome is uncertain. Check status before submitting anything again.`
          : state === "failed" ? `${custom.name}: ${custom.stem_separation.error || "Separation failed. The original audio is still available."}`
            : custom?.state === "complete" ? `${custom.name} · ${state === "complete" ? "Stems ready" : "Saved locally"}${selectedId === custom.id ? " · Loaded" : " · Available in Recent tracks"}`
              : custom ? `${custom.name}: check status to restore this audio.` : "WAV, MP3, FLAC, OGG, M4A or AAC · Mono or stereo · Up to 128 MB, no fixed duration limit. Saved locally until you choose separation.");
    $("custom-status").classList.toggle("is-error", customError || ["failed", "unknown"].includes(state));
    renderBeats();
  }
  function renderBeats() {
    const track = snapshot?.track, analysis = beatAnalyses.get(track?.id) || track?.beat_analysis, state = analysis?.state;
    const settings = engine?.getConfig().beatTracking?.[track?.id] || {};
    const automatic = automaticBeats(track), timing = snapshot?.beatTiming?.trackId === track?.id ? snapshot.beatTiming : null;
    const pending = automatic ? timing?.state === "preparing" : ["queued", "analyzing"].includes(state), complete = Boolean(globalThis.HydraElevenPlayer?.readBeatMap?.(
      { ...track, beat_analysis: analysis }, { ...settings, enabled: true }));
    const invalid = state === "complete" && !complete;
    const installed = settings.enabled && complete && track?.beat_analysis?.analysis_id === analysis.analysis_id &&
      track?.beat_analysis?.updated_at === analysis.updated_at && Boolean(globalThis.HydraElevenPlayer?.readBeatMap?.(track, settings));
    const warnings = Array.isArray(analysis?.warnings) ? analysis.warnings.filter(value => typeof value === "string").slice(0, 16) : [];
    const playing = snapshot?.running || snapshot?.starting || loadingTrack;
    const failed = automatic && timing?.state === "failed";
    $("beat-sync").hidden = !automatic;
    $("beat-sync").textContent = !automatic ? "" : pending ? `Aligning beats…${finite(timing.progress) ? ` ${percent(timing.progress)}` : ""}`
      : timing?.state === "ready" && installed ? "Beat sync ready" : failed ? "Beat sync unavailable · Retry in Beat timing" : "Beat sync prepares automatically before playback";
    $("beat-sync").classList.toggle("is-error", failed);
    $("beats").hidden = !track;
    $("beat-mode-field").hidden = track?.origin !== "uploaded";
    $("beat-mode").value = automatic ? "auto" : "manual";
    $("beat-mode").disabled = playing;
    $("analyze-beats").disabled = !track || playing || beatBusy || pending || beatAvailable === false;
    $("analyze-beats").textContent = beatBusy || pending ? "Aligning beats…" : failed || state === "failed" ? "Retry beat analysis" : complete ? "Analyze again" : "Analyze beats";
    $("beat-check").hidden = automatic || !beatError;
    $("beat-check").disabled = beatBusy;
    $("use-beats-field").hidden = automatic;
    $("use-beats").checked = settings.enabled === true;
    $("use-beats").disabled = playing || beatBusy || automatic || !complete && settings.enabled !== true;
    $("beat-adjustments").hidden = !complete;
    for (const id of ["beat-offset", "beat-bar"]) $(id).disabled = playing || beatBusy || pending || !complete;
    if (globalThis.document?.activeElement !== $("beat-offset")) $("beat-offset").value = String(Math.round((settings.offsetSeconds || 0) * 1000));
    if (globalThis.document?.activeElement !== $("beat-bar")) $("beat-bar").value = settings.firstBeatInBar ? String(settings.firstBeatInBar) : "";
    const summary = complete ? `${analysis.beats_seconds.length} beats · First at ${format(analysis.beats_seconds[0])} s · ${format(analysis.bpm_median)} BPM${finite(analysis.bpm_min) && finite(analysis.bpm_max) && Math.round(analysis.bpm_min) !== Math.round(analysis.bpm_max) ? ` (${Math.round(analysis.bpm_min)}–${Math.round(analysis.bpm_max)})` : ""} · ${analysis.source === "drums" ? "Drum stem" : "Full mix"}.` : "";
    $("beat-status").textContent = automatic ? pending ? "Finding beats locally and aligning the track automatically. Play waits until alignment is ready. No ElevenLabs credits."
      : failed ? `${timing.error || "Could not find reliable beat timing."} Retry beat analysis to prepare this track. Playback and synced drums wait for reliable timing.`
        : installed ? `${summary} Beat sync and groove alignment are applied automatically. ${warnings.join(" ")}${playing ? " Stop playback to change advanced timing." : ""}`
          : beatAvailable === false ? beatSetupError || "Install the local audio analysis dependencies to prepare beat sync."
            : "Beat sync is prepared and applied automatically when this track is loaded. No ElevenLabs credits."
      : beatMessage || (pending ? `Finding beat positions locally${finite(analysis.progress) ? ` · ${percent(analysis.progress)}` : ""}. You can leave this panel and return when it is ready.`
      : complete ? `${summary} ${warnings.join(" ")}${playing ? " Stop playback to change beat alignment." : installed ? " Detected beats are used for sync."
        : settings.enabled ? " Switch Use detected beats off and back on while stopped to apply this analysis." : " Enable Use detected beats before playback to align Keirzo."}`
        : invalid ? "Saved beat timing is invalid or belongs to different audio. Analyze again, or switch off Use detected beats to use Track BPM."
          : state === "failed" ? `${analysis.error || "Could not find a reliable beat map."}${settings.enabled ? " Switch off Use detected beats to use Track BPM." : " You can enter Track BPM instead."}`
            : settings.enabled ? "Detected beats are unavailable. Analyze beats, or switch off Use detected beats to use Track BPM."
          : beatAvailable === false ? beatSetupError || "Local beat analysis needs the optional audio analysis dependencies on this computer."
            : `Analyze locally before playback to follow tempo changes and leading silence. No ElevenLabs credits. ${track?.origin === "uploaded" ? "Track BPM is an optional starting estimate." : "The requested BPM supplies a starting estimate when available."}`);
    $("beat-status").classList.toggle("is-error", failed || beatError || state === "failed" || invalid || settings.enabled && !complete && !pending);
  }
  function stopBeatChecks() {
    ++beatRun; clearTimeout(beatTimer); beatTimer = null; beatController?.abort(); beatController = null; beatBusy = false;
  }
  function acceptBeatAnalysis(id, analysis, run) {
    if (!active || run !== beatRun || snapshot?.track?.id !== id) return;
    beatAnalyses.set(id, analysis); beatMessage = ""; beatError = false;
    if (custom?.id === id) custom.beat_analysis = analysis;
    rememberTrack({ ...snapshot.track, beat_analysis: analysis });
    // Results are metadata only. Applying a new clock is an explicit stopped-player action.
    if (["queued", "analyzing"].includes(analysis.state)) {
      clearTimeout(beatTimer); beatTimer = setTimeout(() => checkBeats(), 1500);
    }
    renderBeats();
  }
  async function checkBeats() {
    if (!active || !snapshot?.track || beatBusy) return;
    if (automaticBeats()) return;
    const id = snapshot.track.id, run = ++beatRun;
    clearTimeout(beatTimer); beatController?.abort(); beatController = new AbortController();
    beatBusy = true; beatMessage = "Checking beat analysis…"; renderBeats();
    try {
      const analysis = await customRequest(`/generations/${encodeURIComponent(id)}/beats`, { signal: beatController.signal });
      acceptBeatAnalysis(id, analysis, run);
    } catch (error) {
      if (run !== beatRun || error.name === "AbortError") return;
      beatError = true; beatMessage = `${error.message} Use Check analysis to recover its status.`;
    } finally { if (run === beatRun) { beatBusy = false; renderBeats(); } }
  }
  async function analyzeBeats() {
    if (!active || !snapshot?.track || $("analyze-beats").disabled) return;
    if (automaticBeats()) {
      try { await engine.prepareBeatTiming({ force: true }); save(); }
      catch (error) { notice(error.message || "Could not align this track.", true); }
      return;
    }
    stopBeatChecks();
    const track = snapshot.track, id = track.id, run = beatRun;
    const bpm = track.origin === "uploaded" ? engine.getConfig().uploadedBpms?.[id]
      : track.generation_settings?.bpm ?? track.realtime?.generation_settings?.bpm ?? plans.get(track.plan_id)?.settings?.bpm;
    beatBusy = true; beatError = false; beatMessage = "Finding beat positions locally…";
    // A new analysis must be enabled explicitly before it becomes the clock.
    // Turn off the previous detected map while stopped, preserving its adjustments.
    config = engine.getConfig();
    if (config.beatTracking?.[id]?.enabled) {
      config.beatTracking[id].enabled = false;
      commit("none", "beat_tracking_analysis_requested", { track_id: id });
    }
    renderBeats();
    try {
      const analysis = await customRequest(`/generations/${encodeURIComponent(id)}/beats`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finite(bpm) && bpm >= 20 && bpm <= 300 ? { bpm_hint: bpm } : {}) });
      acceptBeatAnalysis(id, analysis, run);
    } catch (error) {
      if (run !== beatRun) return;
      beatError = true; beatMessage = `${error.message} Use Check analysis to recover its status.`;
    } finally { if (run === beatRun) { beatBusy = false; renderBeats(); } }
  }
  function changeBeatSettings(field) {
    const track = snapshot?.track, analysis = beatAnalyses.get(track?.id) || track?.beat_analysis;
    if (!track || snapshot?.running || snapshot?.starting || loadingTrack || beatBusy) { renderBeats(); return; }
    if (field === "mm-use-beats" && automaticBeats(track)) { renderBeats(); return; }
    if (["mm-beat-offset", "mm-beat-bar"].includes(field) && automaticBeats(track) && snapshot?.beatTiming?.state === "preparing") { renderBeats(); return; }
    config = engine.getConfig();
    if (field === "mm-beat-mode") {
      const automatic = $("beat-mode").value === "auto";
      config.beatTracking = { ...(config.beatTracking || {}), [track.id]: { ...(config.beatTracking?.[track.id] || {}), mode: automatic ? "auto" : "manual", enabled: automatic } };
      stopBeatChecks(); beatMessage = ""; beatError = false;
      commit("none", "beat_tracking_changed", { track_id: track.id, mode: automatic ? "auto" : "manual" });
      if (automatic) engine.prepareBeatTiming().then(save).catch(error => notice(error.message, true));
      renderBeats(); return;
    }
    if (field === "mm-use-beats" && !$("use-beats").checked) {
      // Missing or rejected metadata must never trap a saved session in a
      // detected-clock mode that cannot run. Disabling does not need a map.
      config.beatTracking = { ...(config.beatTracking || {}), [track.id]: { ...(config.beatTracking?.[track.id] || {}), enabled: false } };
      commit("none", "beat_tracking_changed", { track_id: track.id, enabled: false });
      notice(""); renderBeats(); return;
    }
    if (!globalThis.HydraElevenPlayer?.readBeatMap?.({ ...track, beat_analysis: analysis }, { ...config.beatTracking?.[track.id], enabled: true })) {
      renderBeats(); return;
    }
    const milliseconds = Number($("beat-offset").value), firstBeatInBar = $("beat-bar").value === "" ? null : Number($("beat-bar").value);
    if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 10000 || firstBeatInBar !== null && (!Number.isInteger(firstBeatInBar) || firstBeatInBar < 1 || firstBeatInBar > 4)) {
      notice("Use a timing adjustment between −10000 and 10000 ms and a first beat position from 1 to 4.", true); return;
    }
    const settings = { ...(config.beatTracking?.[track.id] || {}), enabled: automaticBeats(track) || $("use-beats").checked, offsetSeconds: milliseconds / 1000 };
    if (firstBeatInBar === null) delete settings.firstBeatInBar; else settings.firstBeatInBar = firstBeatInBar;
    config.beatTracking = { ...(config.beatTracking || {}), [track.id]: settings };
    if (engine.updateBeatAnalysis(track.id, analysis) === false) { config = engine.getConfig(); renderBeats(); return; }
    commit("none", "beat_tracking_changed", { track_id: track.id, ...config.beatTracking[track.id] });
    notice(""); renderBeats();
  }
  async function customRequest(path, options = {}) {
    const response = await fetch(`/api/elevenlabs${path}`, { cache: "no-store", ...options });
    let data;
    try { data = await response.json(); } catch (_) { /* A lost response can be recovered with a GET. */ }
    if (!response.ok || !data) {
      const error = new Error(data?.error?.message || data?.error || data?.message || `Could not complete the audio request (${response.status}).`);
      error.status = response.status; throw error;
    }
    return data;
  }
  function stopCustomChecks() {
    ++customRun; clearTimeout(customTimer); customTimer = null; customController?.abort(); customController = null; customBusy = false;
  }
  async function loadCustom(id, expectedRevision) {
    if (!active || expectedRevision !== undefined && (expectedRevision !== selectionRevision || snapshot?.running || snapshot?.starting || generationState.enabled)) return false;
    const run = ++fetchRun; controller?.abort(); controller = new AbortController();
    generation.stop();
    await selectTrack(id, run, controller.signal, true);
    return run === fetchRun && active;
  }
  function scheduleCustomCheck(run) {
    clearTimeout(customTimer);
    if (active && run === customRun) customTimer = setTimeout(() => recoverCustom(), 2000);
  }
  async function acceptSeparation(separation, run, expectedRevision) {
    if (run !== customRun || !custom) return;
    custom.stem_separation = separation;
    custom.separation_intent = !["complete", "failed", "not_requested"].includes(separation.state);
    customMessage = ""; customError = false; persistCustom(); rememberTrack(custom);
    if (separation.state === "complete") {
      custom.stems = separation.stems || [];
      const loaded = snapshot?.track?.id === custom.id && JSON.stringify(snapshot.track.stems || []) === JSON.stringify(custom.stems);
      if (selectedId === custom.id && !loaded) await loadCustom(custom.id, expectedRevision);
    } else if (["queued", "generating", "submitting", "separating", "running"].includes(separation.state)) scheduleCustomCheck(run);
    renderCustom();
  }
  async function recoverCustom() {
    if (!active || !custom || customBusy) return;
    const id = custom.id, run = ++customRun, intent = selectionRevision;
    clearTimeout(customTimer); customController?.abort(); customController = new AbortController();
    customBusy = true; renderCustom();
    try {
      const job = await customRequest(`/generations/${encodeURIComponent(id)}`, { signal: customController.signal });
      if (run !== customRun || !active || id !== custom?.id) return;
      custom = { ...job, separation_intent: custom.separation_intent }; customMessage = ""; customError = false; persistCustom(); rememberTrack(job);
      const separation = await customRequest(`/generations/${encodeURIComponent(id)}/stems`, { signal: customController.signal });
      await acceptSeparation(separation, run, intent);
    } catch (error) {
      if (run !== customRun || error.name === "AbortError") return;
      customError = true; customMessage = error.status === 404 && custom.upload_pending
        ? "The local upload was not found. Choose the file again to upload it; no separation was started."
        : `Could not check ${custom.name || "custom audio"}: ${error.message} Use Check status to try again.`;
    } finally { if (run === customRun) { customBusy = false; renderCustom(); } }
  }
  async function uploadAudio(file) {
    if (!file || customBusy || ["queued", "generating", "submitting", "separating", "running"].includes(custom?.stem_separation?.state)) return;
    if (!/\.(wav|mp3|flac|ogg|m4a|aac)$/i.test(file.name) || !file.size || file.size > MAX_UPLOAD_BYTES) {
      customMessage = "Choose a mono or stereo WAV, MP3, FLAC, OGG, M4A or AAC file up to 128 MB."; customError = true; renderCustom(); return;
    }
    stopCustomChecks();
    const run = customRun, intent = selectionRevision, previous = custom;
    const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes);
    const id = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    custom = { id, name: file.name.replace(/\.[^.]+$/, ""), upload_pending: true };
    customBusy = true; customMessage = `Saving ${file.name} locally…`; customError = false; persistCustom(); renderCustom();
    try {
      const job = await customRequest(`/uploads?filename=${encodeURIComponent(file.name)}&request_id=${id}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file
      });
      if (run !== customRun) return;
      custom = job; customMessage = ""; persistCustom(); rememberTrack(job);
      await loadCustom(job.id, intent);
    } catch (error) {
      if (run !== customRun) return;
      // A successful server upload can outlive its response. Keep its stable ID
      // for read-only recovery instead of uploading or separating it again.
      if (error.status >= 400 && error.status < 500) custom = previous;
      customError = true; customMessage = `${error.message}${custom?.upload_pending ? " Use Check status to recover the local upload." : ""}`; persistCustom();
    } finally { if (run === customRun) { customBusy = false; $("audio-file").value = ""; renderCustom(); } }
  }
  async function separateCustom() {
    if (customBusy || $("separate").disabled || !custom) return;
    stopCustomChecks();
    const id = custom.id, run = customRun, intent = selectionRevision;
    customBusy = true; customError = false; customMessage = "Checking separation status…"; renderCustom();
    try {
      // Check first: another tab, a refresh, or a lost response may have already
      // submitted this paid request. Only this explicit action may issue a POST.
      let separation = await customRequest(`/generations/${encodeURIComponent(id)}/stems`);
      if (run !== customRun) return;
      if (separation.state === "not_requested") {
        custom.separation_intent = true; custom.stem_separation = undefined; persistCustom();
        customMessage = "Submitting audio to ElevenLabs…"; renderCustom();
        separation = await customRequest(`/generations/${encodeURIComponent(id)}/stems`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
        });
      }
      await acceptSeparation(separation, run, intent);
    } catch (error) {
      if (run !== customRun) return;
      customError = true; customMessage = `${error.message} Use Check status before retrying separation.`;
      if (error.status === 503) separationReady = false;
    } finally { if (run === customRun) { customBusy = false; renderCustom(); } }
  }
  async function selectTrack(id, run, signal, explicitRecall = false) {
    loadingTrack = true; updateView(engine.snapshot());
    try {
      if (!id) { selectedId = ""; await engine.setTrack(null); config.includeVocals = false; config.channels = [api().defaultChannel("master")]; renderTracks(); commit("channels", "track_channels_changed", { track_id: null }); return; }
      const job = await read(`/generations/${encodeURIComponent(id)}`, signal);
      if (run !== fetchRun || !active) return;
      if (!readyTrack(job)) throw new Error("This track's stems are not ready yet.");
      if (job.beat_analysis) beatAnalyses.set(job.id, job.beat_analysis);
      if (job.origin !== "uploaded" && !job.generation_settings && !job.realtime?.generation_settings && job.plan_id) {
        try {
          if (!plans.has(job.plan_id)) plans.set(job.plan_id, await read(`/plans/${encodeURIComponent(job.plan_id)}`, signal));
          job.generation_settings = plans.get(job.plan_id).settings;
        }
        catch (error) { if (error.name === "AbortError") throw error; }
        if (run !== fetchRun || !active) return;
      }
      const stems = job.stem_separation?.state === "complete" ? job.stem_separation.stems : [];
      const names = ["master", ...[...new Set(api().stemsForTrack({ ...job, stems }).map((stem) => stem.name))].filter((name) => name !== "master").slice(0, 6)];
      config = engine.getConfig();
      config.includeVocals = job.origin === "uploaded";
      config.channels = names.map((name) => config.channels.find((channel) => channel.name === name) || api().defaultChannel(name));
      // A newly chosen upload should loop safely, while a session restore or
      // same-track stem upgrade must retain the user's next-track decision.
      if (job.origin === "uploaded" && selectedId !== id) $("next-mode").value = "loop";
      selectedId = id;
      commit("channels", "track_channels_changed", { track_id: id });
      const track = { ...job, audio_url: job.audio_url || `/api/elevenlabs/generations/${encodeURIComponent(id)}/audio`, stems };
      if (explicitRecall) await generation.recall(track);
      else await engine.setTrack(track);
      if (run !== fetchRun || !active) return;
      if (job.origin === "uploaded" && !customBusy) {
        stopCustomChecks(); custom = { ...job, stems }; customMessage = ""; customError = false; persistCustom(); renderCustom();
        if (["queued", "generating", "submitting", "separating", "running"].includes(job.stem_separation?.state)) scheduleCustomCheck(customRun);
      }
      renderTracks(); save();
      notice("");
    } catch (error) {
      if (run === fetchRun) renderTracks();
      if (error.status === 404) throw new Error(`Saved track ${id} is unavailable. Restore its session bundle or choose another track. Your saved selection and mixer settings have been kept.`);
      throw error;
    }
    finally { if (run === fetchRun) {
      loadingTrack = false; updateView(engine.snapshot());
      if (!beatBusy && ["queued", "analyzing"].includes(beatAnalyses.get(snapshot?.track?.id)?.state)) checkBeats();
    } }
  }
  async function refresh() {
    const run = ++fetchRun;
    controller?.abort(); controller = new AbortController();
    $("refresh").disabled = true;
    try {
      const [data, planData] = await Promise.all([
        read("/generations", controller.signal),
        read("/plans", controller.signal).catch((error) => { if (error.name === "AbortError") throw error; return null; })
      ]);
      if (run !== fetchRun || !active) return;
      for (const plan of planData?.plans || []) plans.set(plan.id, plan);
      tracks = (data.jobs || []).filter(readyTrack);
      if (snapshot?.track && !tracks.some((job) => job.id === snapshot.track.id)) tracks.unshift(snapshot.track);
      renderTracks();
      // A refresh must not substitute the newest track or erase saved channels.
      // Fetch the exact saved ID even if it falls outside the recent list.
      if (selectedId && snapshot?.track?.id !== selectedId && !generationState.enabled && !snapshot?.running && !snapshot?.starting) {
        await selectTrack(selectedId, run, controller.signal);
      }
      if (run === fetchRun && custom && !customBusy) recoverCustom();
      // A POST can finish after this workspace was left, before its first
      // response was accepted. Always recover the loaded track by GET.
      if (run === fetchRun && !beatBusy && snapshot?.track) checkBeats();
    } catch (error) { if (run === fetchRun && error.name !== "AbortError") notice(error.message, true); }
    finally { if (run === fetchRun) $("refresh").disabled = false; }
  }
  function context(element) {
    config = engine.getConfig();
    const bus = config.buses.find((item) => item.id === element.closest("[data-bus]")?.dataset.bus);
    const channel = config.channels.find((item) => item.name === element.closest("[data-channel]")?.dataset.channel);
    const sourceIndex = Number(element.closest("[data-source]")?.dataset.source);
    const routeIndex = Number(element.closest("[data-route]")?.dataset.route);
    return { bus, channel, sourceIndex, source: bus?.sources[sourceIndex], routeIndex, route: channel?.routes[routeIndex] };
  }
  function updateStrength(el, route, persist = false) {
    const value = Number(el.value);
    if (!Number.isFinite(value)) return;
    route.strength = Math.max(0, Math.min(1, value / 100));
    changeMapping(() => engine.setConfig(config), "route_strength_changed");
    const label = percent(route.strength);
    el.closest(".mm-strength").querySelector("[data-strength-value]").textContent = label;
    el.setAttribute("aria-valuetext", label);
    if (persist) save();
  }
  function onChange(event) {
    if (rendering) return;
    const el = event.target;
    if (el.id === "mm-audio-file") { uploadAudio(el.files?.[0]); return; }
    if (["mm-use-beats", "mm-beat-offset", "mm-beat-bar", "mm-beat-mode"].includes(el.id)) { changeBeatSettings(el.id); return; }
    if (el.id === "mm-track-bpm") {
      if (custom?.state !== "complete") return;
      const value = el.value.trim(), bpm = Number(value);
      if (value && (!Number.isFinite(bpm) || bpm < 20 || bpm > 300)) {
        notice("Enter a track BPM between 20 and 300, or leave it blank when unknown.", true); return;
      }
      config = engine.getConfig();
      const uploadedBpms = { ...(config.uploadedBpms || {}) }; delete uploadedBpms[custom.id];
      config.uploadedBpms = value ? { [custom.id]: bpm, ...uploadedBpms } : uploadedBpms;
      commit("none", "uploaded_tempo_changed", { track_id: custom.id, bpm: value ? bpm : null });
      notice(""); return;
    }
    if (el.hasAttribute("data-next-field")) {
      if (el.id === "mm-next-track") nextTrackId = el.value;
      if (el.id === "mm-next-mode" && el.value === "similar" && snapshot?.track?.origin === "uploaded") {
        el.value = "new"; notice("Custom audio uses your prompt to generate a new track.");
      }
      save(); renderTransport(); generation?.settingsChanged(); return;
    }
    if (el.hasAttribute("data-prompt-field")) { save(); generation?.settingsChanged(); return; }
    const { bus, channel, source, route } = context(el);
    if (el.id === "mm-skeleton-detail") {
      if (!["region", "joint", "axis"].includes(el.value)) return;
      skeletonDetail = el.value; renderBuses(); return;
    }
    if (el.id === "mm-shared-mix") { renderLibrary(); return; }
    if (el.id === "mm-track") {
      ++selectionRevision;
      generation.stop(); const run = ++fetchRun; controller?.abort(); controller = new AbortController();
      selectTrack(el.value, run, controller.signal, true).catch((error) => { if (run === fetchRun && error.name !== "AbortError") notice(error.message, true); });
      return;
    }
    if (el.id === "mm-mode") {
      signalLibrary?.detachAll();
      config.mode = el.value;
      const available = visibleFields(el.value === "demo" ? api().DEMO_FIELDS : sourceBridge?.describe?.().fields || []);
      config.buses.forEach((item, index) => { item.sources = [sourceFor(available[index % Math.max(1, available.length)]?.key, available)]; });
      history.clear(); commit("all", "input_mode_changed");
      notice(""); return;
    }
    if (el.hasAttribute("data-bus-name")) { bus.name = el.value.trim() || "Signal mix"; commit("all", "bus_name_changed", { bus_id: bus.id }); return; }
    if (el.hasAttribute("data-operator")) { bus.operator = el.value; commit("buses", "bus_operator_changed", { bus_id: bus.id }); return; }
    if (source && el.dataset.sourceField) {
      const key = el.dataset.sourceField;
      if (key === "sourceKey") Object.assign(source, sourceFor(el.value));
      else if (["inputMin", "inputMax", "weight", "index"].includes(key)) {
        if (!Number.isFinite(el.valueAsNumber)) { notice("Enter a finite number for the input range.", true); return; }
        source[key] = el.valueAsNumber;
        if (key.startsWith("input") && source.inputMax <= source.inputMin) { notice("The maximum must be greater than the minimum.", true); return; }
      } else source[key] = el.value;
      if (key === "reducer" || key === "index" || (key === "rangeMode" && el.value === "auto")) { source.learnedMin = null; source.learnedMax = null; }
      commit("buses", "source_changed", { bus_id: bus.id, field: key }); return;
    }
    if (route && el.dataset.routeField) {
      const key = el.dataset.routeField;
      if (key === "strength") { updateStrength(el, route, true); return; }
      if (key === "target") {
        if (channel.routes.some((item) => item !== route && item.target === el.value)) { notice("This channel already has a mapping for that effect. Edit the existing mapping to change its signal mix.", true); renderChannels(); return; }
        route.target = el.value; const target = globalThis.HydraElevenRealtime.TARGETS[el.value]; route.outputMin = target.low; route.outputMax = target.high;
      } else if (key === "invert") route.invert = el.checked;
      else if (key === "outputMin" || key === "outputMax") { if (!Number.isFinite(el.valueAsNumber)) return; route[key] = el.valueAsNumber; }
      else route[key] = el.value;
      commit("channels", "route_changed", { channel: channel.name, field: key });
    }
  }
  function onInput(event) {
    if (rendering) return;
    if (event.target.hasAttribute("data-prompt-field")) { save(); generation?.settingsChanged(); return; }
    const el = event.target, key = el.dataset.channelField;
    if (el.dataset.routeField === "strength") {
      const { route } = context(el);
      if (route) updateStrength(el, route);
      return;
    }
    if (!key) return;
    const { channel } = context(el); if (!channel) return;
    channel[key] = Number(el.value); changeMapping(() => engine.setConfig(config), "channel_control_changed", { channel: channel.name, field: key }); save();
    const row = el.closest("[data-channel]");
    if (key === "level") row.querySelector("[data-fader-value]").textContent = percent(channel.level);
    else row.querySelector(`[data-control-value="${key}"]`).textContent = controlValue(key, channel[key]);
  }
  function onClick(event) {
    const el = event.target.closest("button"); if (!el) return;
    if (el.id === "mm-analyze-beats") { analyzeBeats(); return; }
    if (el.id === "mm-beat-check") { checkBeats(); return; }
    if (el.id === "mm-separate") { separateCustom(); return; }
    if (el.id === "mm-custom-check") { recoverCustom(); return; }
    if (el.id === "mm-custom-load") {
      if (!custom || loadingTrack) return;
      ++selectionRevision;
      loadCustom(custom.id).catch((error) => { if (error.name !== "AbortError") notice(error.message, true); }); return;
    }
    if (el.id === "mm-refresh") { refresh(); return; }
    if (["mm-play", "mm-generate", "mm-retry"].includes(el.id)) {
      if (loadingTrack) return;
      ++selectionRevision;
      ++fetchRun; controller?.abort(); $("refresh").disabled = false; notice(""); save();
      const action = el.id === "mm-generate" ? "startNew" : el.id === "mm-retry" ? "retry" : "resume";
      Promise.resolve(generation[action]()).catch((error) => notice(error.message, true)); return;
    }
    if (el.id === "mm-stop") { ++selectionRevision; generation.stop(); return; }
    const { bus, channel, sourceIndex, routeIndex } = context(el);
    if (el.id === "mm-add-shared") {
      try { signalLibrary?.attach($("shared-mix").value, config, `mix-${Date.now().toString(36)}`); commit("all", "shared_added"); notice(""); }
      catch (error) { notice(error.message, true); }
      return;
    }
    if (el.dataset.action === "share-mix") {
      try { signalLibrary?.share(bus, config.mode); captureMapping("shared_created", { bus_id: bus.id }); renderBuses(); save(); notice(""); }
      catch (error) { notice(error.message, true); }
      return;
    }
    if (el.dataset.action === "detach-mix") { signalLibrary?.detach(bus.id); captureMapping("shared_detached", { bus_id: bus.id }); renderBuses(); save(); return; }
    if (el.id === "mm-add-bus") {
      if (config.buses.length >= 4) return;
      const available = visibleFields();
      const id = `mix-${Date.now().toString(36)}`; config.buses.push(newBus(id, `Mix ${String.fromCharCode(65 + config.buses.length)}`, available[config.buses.length % Math.max(1, available.length)]?.key)); commit("all", "bus_added", { bus_id: id }); return;
    }
    switch (el.dataset.action) {
      case "add-source": if (bus.sources.length >= 6) return; bus.sources.push(sourceFor(visibleFields().find((field) => !bus.sources.some((source) => source.sourceKey === field.key))?.key || visibleFields()[0]?.key)); commit("buses", "source_added", { bus_id: bus.id }); break;
      case "remove-source": if (bus.sources.length <= 1) return; bus.sources.splice(sourceIndex, 1); commit("buses", "source_removed", { bus_id: bus.id, source_index: sourceIndex }); break;
      case "remove-bus":
        if (config.buses.length === 1) return;
        config.buses = config.buses.filter((item) => item !== bus); config.channels.forEach((item) => { item.routes = item.routes.filter((route) => route.busId !== bus.id); }); history.delete(bus.id); commit("all", "bus_removed", { bus_id: bus.id }); break;
      case "freeze": changeMapping(() => engine.freeze(bus.id, sourceIndex), "range_frozen", { bus_id: bus.id, source_index: sourceIndex, force: true }); renderBuses(); save(); break;
      case "relearn": changeMapping(() => engine.relearn(bus.id, sourceIndex), "range_relearned", { bus_id: bus.id, source_index: sourceIndex, force: true }); renderBuses(); save(); break;
      case "mute": channel.muted = !channel.muted; commit("channels", "channel_mute_changed", { channel: channel.name }); break;
      case "solo": channel.solo = !channel.solo; commit("channels", "channel_solo_changed", { channel: channel.name }); break;
      case "add-route": {
        const target = ["cutoff", "gain", "pan", "reverbMix", "delayMix", "highpass", "resonance", "pitch", ...(channel.name === "master" ? ["rate"] : [])].find((key) => !channel.routes.some((route) => route.target === key));
        if (!target || !config.buses.length) return;
        const bounds = globalThis.HydraElevenRealtime.TARGETS[target]; channel.routes.push({ busId: config.buses[0].id, target, outputMin: bounds.low, outputMax: bounds.high, invert: false, strength: 1 }); commit("channels", "route_added", { channel: channel.name }); break;
      }
      case "remove-route": channel.routes.splice(routeIndex, 1); commit("channels", "route_removed", { channel: channel.name, route_index: routeIndex }); break;
    }
  }
  function init(options = {}) {
    if (initialized || !options.container || !api()) return;
    initialized = true; root = options.container; sourceBridge = options.sourceBridge; root.classList.add("mm-workspace");
    root.innerHTML = `<header class="mm-header"><div><span class="mm-eyebrow">INSTRUMENTAL MUSIC</span><h1 id="music-mixer-title">Music mixer</h1></div><a class="mm-button" href="#elevenlabs" data-workspace="elevenlabs" data-advanced>Previous version ↗</a></header>
      <section class="mm-prompt-panel" aria-labelledby="mm-prompt-title"><div class="mm-section-heading"><div><span class="mm-eyebrow">01 / MUSIC CREATION</span><h2 id="mm-prompt-title">Create instrumental music</h2></div><span id="mm-next" class="mm-next-state" role="status">—</span></div>
        <div class="mm-next-controls"><label>Next track<select id="mm-next-mode" data-next-field><option value="loop">Loop</option><option value="similar">Generate similar</option><option value="new">Generate new</option><option value="old">Choose old</option></select></label><label id="mm-next-track-field" hidden>Saved track<select id="mm-next-track" data-next-field><option value="">Choose a saved track…</option></select></label></div>
        <div class="mm-prompt-grid"><label class="mm-prompt-text">Next track prompt<textarea id="mm-prompt" data-prompt-field rows="2" maxlength="300" title="Used for Generate similar, Generate new, or a starting track."></textarea></label><label>BPM<input id="mm-bpm" data-prompt-field type="number" min="20" max="300" step="1"></label><label>Key<input id="mm-key" data-prompt-field maxlength="80"></label><label>Track length<select id="mm-duration" data-prompt-field><option value="20">20 seconds</option><option value="40">40 seconds</option><option value="60">60 seconds</option></select></label><label class="mm-instruments">Instruments<input id="mm-instruments" data-prompt-field placeholder="Synthesizer, bass, drums"></label></div>
        <div class="mm-prompt-actions"><button id="mm-generate" class="mm-button mm-primary">Start music</button><button id="mm-play" class="mm-button" disabled>▶ Play saved track</button><button id="mm-stop" class="mm-button" disabled>■ Stop</button><button id="mm-retry" class="mm-button" hidden>Retry next track</button></div>
        <div class="mm-now-playing"><span>Now playing</span><b id="mm-current">—</b></div>
        <div id="mm-up-next" class="mm-now-playing mm-up-next" hidden><span>Up next</span><b id="mm-next-prompt"></b></div>
        <div class="mm-transport-readout"><span id="mm-transport-status">Stopped</span><progress id="mm-progress" value="0" max="1" aria-label="Track progress"></progress><span id="mm-clock">0:00 / 0:00</span><span id="mm-beat-sync" class="mm-beat-sync" role="status" hidden></span></div>
        <details class="mm-recent"><summary>Recent tracks</summary><div class="mm-recent-row"><label class="sr-only" for="mm-track">Recall a recent track</label><select id="mm-track"><option value="">Recall a track…</option></select><button id="mm-refresh" class="mm-button">Refresh</button></div>
          <details id="mm-custom" class="mm-custom"><summary>Use your own audio</summary><div class="mm-custom-actions"><label class="mm-upload">Choose audio<input id="mm-audio-file" type="file" accept=".wav,.mp3,.flac,.ogg,.m4a,.aac,audio/wav,audio/mpeg,audio/flac,audio/ogg,audio/mp4,audio/aac"></label><button id="mm-separate" class="mm-button" disabled>Separate with ElevenLabs</button><button id="mm-custom-load" class="mm-button" hidden>Load audio</button><button id="mm-custom-check" class="mm-button" hidden>Check status</button></div><p id="mm-custom-status" class="mm-footnote" role="status"></p><p id="mm-custom-cost" class="mm-footnote" hidden>Uploads this audio to ElevenLabs and uses credits.</p></details>
          <details id="mm-beats" class="mm-beats" hidden><summary>Beat timing · Advanced</summary><label id="mm-beat-mode-field" class="mm-beat-mode" hidden>Timing mode<select id="mm-beat-mode"><option value="auto">Automatic</option><option value="manual">Manual BPM</option></select></label><div class="mm-beat-actions"><button id="mm-analyze-beats" class="mm-button">Analyze beats</button><button id="mm-beat-check" class="mm-button" hidden>Check analysis</button><label id="mm-use-beats-field" class="mm-beat-toggle"><input id="mm-use-beats" type="checkbox" disabled>Use detected beats</label></div><p id="mm-beat-status" class="mm-footnote" role="status"></p><div id="mm-custom-tempo" class="mm-custom-tempo" hidden><label>Track BPM (optional)<input id="mm-track-bpm" type="number" min="20" max="300" step="any" placeholder="Unknown" aria-describedby="mm-tempo-help"></label><p id="mm-tempo-help" class="mm-footnote">Beat timing is detected automatically. An optional BPM can guide analysis when the rhythm is ambiguous. Use Playback speed to change how fast the audio plays.</p></div><div id="mm-beat-adjustments" class="mm-beat-adjustments" hidden><label>Timing adjustment (ms)<input id="mm-beat-offset" type="number" min="-10000" max="10000" step="1" value="0" aria-describedby="mm-beat-help"></label><label>First detected beat in bar<select id="mm-beat-bar" aria-describedby="mm-beat-help"><option value="">Automatic</option><option value="1">Beat 1</option><option value="2">Beat 2</option><option value="3">Beat 3</option><option value="4">Beat 4</option></select></label><p id="mm-beat-help" class="mm-footnote">Automatic estimates the groove accent from the audio. These optional overrides can adjust the estimate: positive timing moves beats later, and bar position sets the accent. Changes apply while stopped and do not move or trim the audio.</p></div></details>
        </details>
      </section>
      <p id="mm-notice" class="mm-notice" role="status" hidden></p>
      <section aria-labelledby="mm-input-title"><div class="mm-section-heading"><div><span class="mm-eyebrow">02 / SIGNALS</span><h2 id="mm-input-title">Signal mixes</h2></div><button id="mm-add-bus" class="mm-button">+ Signal mix</button></div><div class="mm-source-toolbar"><label>Signals from<select id="mm-mode"><option value="shared">Connections input</option><option value="demo">Simulated demo signals</option></select></label><label id="mm-skeleton-detail-field" hidden>Skeleton detail<select id="mm-skeleton-detail" title="Choose body regions, individual joints, or XYZ axes. Existing mappings stay selected."><option value="region">Body regions</option><option value="joint">Joints · XYZ combined</option><option value="axis">XYZ axes</option></select></label><span id="mm-source-label">Choose an input in Connections</span><a href="#connections" data-workspace="connections">Connections ↗</a></div><div class="mm-library-toolbar"><label>Shared signal mixes<select id="mm-shared-mix"></select></label><button id="mm-add-shared" class="mm-button">Add shared mix</button></div><div id="mm-buses" class="mm-buses"></div></section>
      <div class="mm-flowline" aria-hidden="true"><span>INPUT SIGNALS</span><i>→</i><span>SIGNAL MIXES</span><i>→</i><span>CHANNEL EFFECTS</span></div>
      <section aria-labelledby="mm-mix-title"><div class="mm-section-heading"><div><span class="mm-eyebrow">03 / MIXING DESK</span><h2 id="mm-mix-title">Mixer</h2></div></div><p id="mm-stem-hint" class="mm-footnote"></p><div class="mm-console-scroll" role="region" tabindex="0" aria-label="Music mixer channels; scroll horizontally for more stems"><div id="mm-channels" class="mm-console"></div></div></section>`;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (_) { /* Fresh mix. */ }
    try { const previous = JSON.parse(localStorage.getItem(UPLOAD_KEY) || "null"); if (/^[a-f0-9]{32}$/.test(previous?.id)) custom = previous; } catch (_) { /* Recent tracks still retain uploads. */ }
    // Keep earlier voice drafts in saved sessions without mounting another rap player.
    savedRap = saved?.rap;
    signalLibrary = globalThis.HydraSignalLibrary?.create(saved?.signalLinks);
    restorePrompt(saved?.prompt);
    try { mappingTracker = globalThis.HydraStudy?.createMappingTracker?.("music-mixer"); } catch (_) { /* Study recording is optional. */ }
    engine = api().create({ sourceBridge: options.sourceBridge, requestBeatTiming: customRequest, onUpdate: onEngineUpdate, onError: (error) => notice(error.message || String(error), true) });
    generation = globalThis.HydraMusicMixerGeneration.create({ engine, getSettings: generationSettings, getNextTrack: nextTrackChoice,
      onUpdate: updateGeneration, onTrack: rememberTrack, onError: (error) => notice(error.message || String(error), true) });
    selectedId = typeof saved?.trackId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(saved.trackId) ? saved.trackId : "";
    config = api().validateConfig(saved?.config || { mode: "shared", buses: [newBus("mix-a", "Mix A")], channels: [api().defaultChannel("master")] });
    changeMapping(() => engine.setConfig(config), saved?.config ? "restored" : "initial", {}, false); $("mode").value = config.mode;
    renderBuses(); renderChannels(); renderTracks(); renderTransport();
    root.addEventListener("change", onChange); root.addEventListener("input", onInput); root.addEventListener("click", onClick);
  }
  function activate() {
    if (!initialized) return;
    syncSignals();
    if (active) { renderTransport(); return; }
    active = true; engine.activate();
    read("/status").then((status) => {
      separationReady = status.ready !== false; beatAvailable = status.beat_tracking_available !== false;
      beatSetupError = status.beat_tracking_setup_error || ""; renderCustom();
    }).catch(() => {});
    return refresh();
  }
  function deactivate() { if (!initialized) return; active = false; ++selectionRevision; ++fetchRun; controller?.abort(); stopCustomChecks(); stopBeatChecks(); loadingTrack = false; $("refresh").disabled = false; save(); generation.deactivate(); engine.deactivate(); }
  return { init, activate, deactivate, refresh, getState, flush, save,
    transportClock: () => engine?.transportClock?.(Number($("bpm").value)),
    get snapshot() { return engine?.snapshot(); }, get generationSnapshot() { return generation?.snapshot(); } };
})();
