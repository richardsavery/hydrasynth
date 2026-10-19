"use strict";

// Mixer preferences stay separate from the previous music interface.
globalThis.HydraMusicMixer = (() => {
  const KEY = "hydra.music-mixer.demo.v1";
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
  const history = new Map();
  const $ = (id) => root.querySelector(`#mm-${id}`);
  const api = () => globalThis.HydraMusicMixerEngine;
  const fields = () => snapshot?.fields || [];
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
    if (signalLibrary?.sync(config)) { engine.setConfig(config); config = engine.getConfig(); history.clear(); }
    renderBuses(); renderChannels(); save();
  }
  function commit(render = "all") {
    engine.setConfig(config);
    config = engine.getConfig();
    publishSignals();
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
    if (["position", "velocity"].includes(field.kind)) {
      const joint = field.label || name.replace(new RegExp(`\\s+${field.kind}$`, "i"), "");
      return `${readable(joint)} · ${readable(field.kind)}`;
    }
    return readable(name);
  }
  const channelLabel = (field) => readable(field?.channelName || field?.channelId || (field?.key?.startsWith("demo:") ? "Simulated signal" : ""));
  const combinationLabel = (bus) => bus.sources.length === 1 ? "Single input" : `${bus.sources.length} inputs · ${OPERATORS[bus.operator]}`;
  function sourceOptions(selected) {
    const items = fields(), groups = new Map();
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
      <p class="mm-source-caption">${escape(field ? [channelLabel(field), source.reducer === "index" ? `Element ${source.index + 1}` : READ_MODES[source.reducer] || readable(source.reducer)].filter(Boolean).join(" · ") : source.sourceKey === "__unassigned" ? "No input selected" : "Input unavailable")}</p>
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
    $("play").textContent = next.starting ? "Loading…" : "▶ Play saved track";
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
  }
  function updateGeneration(next) {
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
    shownTrackId = track.id; selectedId = track.id;
    rememberTrack(track);
    const names = ["master", ...[...new Set(api().instrumentalStems(track.stems || track.stem_separation?.stems).map((stem) => stem.name))].filter((name) => name !== "master").slice(0, 6)];
    config = engine.getConfig();
    config.channels = names.map((name) => config.channels.find((channel) => channel.name === name) || api().defaultChannel(name));
    commit("channels");
  }
  function updateView(next) {
    if (!root) return;
    snapshot = next;
    if (engine && next.track?.id !== shownTrackId) syncTrack(next.track);
    generation?.update(next);
    renderTransport();
    $("source-label").textContent = next.sourceLabel || "Choose an input in Connections";
    $("clock").textContent = `${time(next.position)} / ${time(next.duration)}`;
    $("progress").value = next.duration ? next.position / next.duration : 0;
    $("transport-status").textContent = next.running ? next.sourceValid ? "Playing" : "Waiting for mapped input" : next.starting ? "Loading audio" : "Stopped";
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
    if (!response.ok) throw new Error(`Could not load saved music (${response.status}).`);
    return response.json();
  }
  function renderTracks() {
    $("track").innerHTML = '<option value="">Recall a track…</option>' + tracks.map((track) => `<option value="${escape(track.id)}" ${track.id === selectedId ? "selected" : ""}>${escape(trackLabel(track))}</option>`).join("");
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
    const date = new Date(track.created_at), when = Number.isNaN(date.getTime()) ? "Saved track" : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const title = track.realtime?.generation_settings?.style || track.generation_settings?.style;
    return `${when} · ${Math.round(track.audio?.duration_seconds || track.requested_duration_seconds || 0)}s${title ? ` · ${title.slice(0, 45)}` : ""}`;
  }
  function readyTrack(job) {
    return job.state === "complete" && (job.separate_stems !== true || (job.stem_separation?.state === "complete" && job.stem_separation.stems?.length));
  }
  async function selectTrack(id, run, signal, explicitRecall = false) {
    loadingTrack = true; updateView(engine.snapshot());
    try {
      if (!id) { selectedId = ""; await engine.setTrack(null); config.channels = [api().defaultChannel("master")]; renderTracks(); commit("channels"); return; }
      const job = await read(`/generations/${encodeURIComponent(id)}`, signal);
      if (run !== fetchRun || !active) return;
      if (!readyTrack(job)) throw new Error("This track's stems are not ready yet.");
      if (!job.generation_settings && !job.realtime?.generation_settings && job.plan_id) {
        try { job.generation_settings = (await read(`/plans/${encodeURIComponent(job.plan_id)}`, signal)).settings; }
        catch (error) { if (error.name === "AbortError") throw error; }
        if (run !== fetchRun || !active) return;
      }
      const stems = job.stem_separation?.state === "complete" ? job.stem_separation.stems : [];
      const names = ["master", ...[...new Set(api().instrumentalStems(stems).map((stem) => stem.name))].filter((name) => name !== "master").slice(0, 6)];
      config = engine.getConfig();
      config.channels = names.map((name) => config.channels.find((channel) => channel.name === name) || api().defaultChannel(name));
      selectedId = id;
      commit("channels");
      const track = { ...job, audio_url: job.audio_url || `/api/elevenlabs/generations/${encodeURIComponent(id)}/audio`, stems };
      if (explicitRecall) await generation.recall(track);
      else await engine.setTrack(track);
      renderTracks(); save();
      notice("");
    } catch (error) { if (run === fetchRun) renderTracks(); throw error; }
    finally { if (run === fetchRun) { loadingTrack = false; updateView(engine.snapshot()); } }
  }
  async function refresh() {
    const run = ++fetchRun;
    controller?.abort(); controller = new AbortController();
    $("refresh").disabled = true;
    try {
      const data = await read("/generations", controller.signal);
      if (run !== fetchRun || !active) return;
      tracks = (data.jobs || []).filter(readyTrack);
      if (snapshot?.track && !tracks.some((job) => job.id === snapshot.track.id)) tracks.unshift(snapshot.track);
      const id = tracks.some((job) => job.id === selectedId) ? selectedId : tracks[0]?.id || "";
      renderTracks();
      if (!generationState.enabled && !snapshot?.running && !snapshot?.starting) await selectTrack(id, run, controller.signal);
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
    engine.setConfig(config);
    const label = percent(route.strength);
    el.closest(".mm-strength").querySelector("[data-strength-value]").textContent = label;
    el.setAttribute("aria-valuetext", label);
    if (persist) save();
  }
  function onChange(event) {
    if (rendering) return;
    const el = event.target;
    if (el.hasAttribute("data-next-field")) {
      if (el.id === "mm-next-track") nextTrackId = el.value;
      save(); renderTransport(); generation?.settingsChanged(); return;
    }
    if (el.hasAttribute("data-prompt-field")) { save(); generation?.settingsChanged(); return; }
    const { bus, channel, source, route } = context(el);
    if (el.id === "mm-shared-mix") { renderLibrary(); return; }
    if (el.id === "mm-track") {
      generation.stop(); const run = ++fetchRun; controller?.abort(); controller = new AbortController();
      selectTrack(el.value, run, controller.signal, true).catch((error) => { if (run === fetchRun && error.name !== "AbortError") notice(error.message, true); });
      return;
    }
    if (el.id === "mm-mode") {
      signalLibrary?.detachAll();
      config.mode = el.value;
      const available = el.value === "demo" ? api().DEMO_FIELDS : sourceBridge?.describe?.().fields || [];
      config.buses.forEach((item, index) => { item.sources = [sourceFor(available[index % Math.max(1, available.length)]?.key, available)]; });
      history.clear(); commit();
      notice(""); return;
    }
    if (el.hasAttribute("data-bus-name")) { bus.name = el.value.trim() || "Signal mix"; commit("all"); return; }
    if (el.hasAttribute("data-operator")) { bus.operator = el.value; commit("buses"); return; }
    if (source && el.dataset.sourceField) {
      const key = el.dataset.sourceField;
      if (key === "sourceKey") Object.assign(source, sourceFor(el.value));
      else if (["inputMin", "inputMax", "weight", "index"].includes(key)) {
        if (!Number.isFinite(el.valueAsNumber)) { notice("Enter a finite number for the input range.", true); return; }
        source[key] = el.valueAsNumber;
        if (key.startsWith("input") && source.inputMax <= source.inputMin) { notice("The maximum must be greater than the minimum.", true); return; }
      } else source[key] = el.value;
      if (key === "reducer" || key === "index" || (key === "rangeMode" && el.value === "auto")) { source.learnedMin = null; source.learnedMax = null; }
      commit("buses"); return;
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
      commit("channels");
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
    channel[key] = Number(el.value); engine.setConfig(config); save();
    const row = el.closest("[data-channel]");
    if (key === "level") row.querySelector("[data-fader-value]").textContent = percent(channel.level);
    else row.querySelector(`[data-control-value="${key}"]`).textContent = controlValue(key, channel[key]);
  }
  function onClick(event) {
    const el = event.target.closest("button"); if (!el) return;
    if (el.id === "mm-refresh") { refresh(); return; }
    if (["mm-play", "mm-generate", "mm-retry"].includes(el.id)) {
      if (loadingTrack) return;
      ++fetchRun; controller?.abort(); $("refresh").disabled = false; notice(""); save();
      const action = el.id === "mm-generate" ? "startNew" : el.id === "mm-retry" ? "retry" : "resume";
      Promise.resolve(generation[action]()).catch((error) => notice(error.message, true)); return;
    }
    if (el.id === "mm-stop") { generation.stop(); return; }
    const { bus, channel, sourceIndex, routeIndex } = context(el);
    if (el.id === "mm-add-shared") {
      try { signalLibrary?.attach($("shared-mix").value, config, `mix-${Date.now().toString(36)}`); commit(); notice(""); }
      catch (error) { notice(error.message, true); }
      return;
    }
    if (el.dataset.action === "share-mix") {
      try { signalLibrary?.share(bus, config.mode); renderBuses(); save(); notice(""); }
      catch (error) { notice(error.message, true); }
      return;
    }
    if (el.dataset.action === "detach-mix") { signalLibrary?.detach(bus.id); renderBuses(); save(); return; }
    if (el.id === "mm-add-bus") {
      if (config.buses.length >= 4) return;
      const id = `mix-${Date.now().toString(36)}`; config.buses.push(newBus(id, `Mix ${String.fromCharCode(65 + config.buses.length)}`, fields()[config.buses.length % Math.max(1, fields().length)]?.key)); commit(); return;
    }
    switch (el.dataset.action) {
      case "add-source": if (bus.sources.length < 6) bus.sources.push(sourceFor(fields().find((field) => !bus.sources.some((source) => source.sourceKey === field.key))?.key || fields()[0]?.key)); commit("buses"); break;
      case "remove-source": if (bus.sources.length > 1) bus.sources.splice(sourceIndex, 1); commit("buses"); break;
      case "remove-bus":
        if (config.buses.length === 1) return;
        config.buses = config.buses.filter((item) => item !== bus); config.channels.forEach((item) => { item.routes = item.routes.filter((route) => route.busId !== bus.id); }); history.delete(bus.id); commit(); break;
      case "freeze": engine.freeze(bus.id, sourceIndex); config = engine.getConfig(); publishSignals(); renderBuses(); save(); break;
      case "relearn": engine.relearn(bus.id, sourceIndex); config = engine.getConfig(); publishSignals(); renderBuses(); save(); break;
      case "mute": channel.muted = !channel.muted; commit("channels"); break;
      case "solo": channel.solo = !channel.solo; commit("channels"); break;
      case "add-route": {
        const target = ["cutoff", "gain", "pan", "reverbMix", "delayMix", "highpass", "resonance", "pitch", ...(channel.name === "master" ? ["rate"] : [])].find((key) => !channel.routes.some((route) => route.target === key));
        if (!target || !config.buses.length) return;
        const bounds = globalThis.HydraElevenRealtime.TARGETS[target]; channel.routes.push({ busId: config.buses[0].id, target, outputMin: bounds.low, outputMax: bounds.high, invert: false, strength: 1 }); commit("channels"); break;
      }
      case "remove-route": channel.routes.splice(routeIndex, 1); commit("channels"); break;
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
        <div class="mm-transport-readout"><span id="mm-transport-status">Stopped</span><progress id="mm-progress" value="0" max="1" aria-label="Track progress"></progress><span id="mm-clock">0:00 / 0:00</span></div>
        <details class="mm-recent"><summary>Recent tracks</summary><div class="mm-recent-row"><label class="sr-only" for="mm-track">Recall a recent track</label><select id="mm-track"><option value="">Recall a track…</option></select><button id="mm-refresh" class="mm-button">Refresh</button></div></details>
      </section>
      <p id="mm-notice" class="mm-notice" role="status" hidden></p>
      <section aria-labelledby="mm-input-title"><div class="mm-section-heading"><div><span class="mm-eyebrow">02 / SIGNALS</span><h2 id="mm-input-title">Signal mixes</h2></div><button id="mm-add-bus" class="mm-button">+ Signal mix</button></div><div class="mm-source-toolbar"><label>Signals from<select id="mm-mode"><option value="shared">Connections input</option><option value="demo">Simulated demo signals</option></select></label><span id="mm-source-label">Choose an input in Connections</span><a href="#connections" data-workspace="connections">Connections ↗</a></div><div class="mm-library-toolbar"><label>Shared signal mixes<select id="mm-shared-mix"></select></label><button id="mm-add-shared" class="mm-button">Add shared mix</button></div><div id="mm-buses" class="mm-buses"></div></section>
      <div class="mm-flowline" aria-hidden="true"><span>INPUT SIGNALS</span><i>→</i><span>SIGNAL MIXES</span><i>→</i><span>CHANNEL EFFECTS</span></div>
      <section aria-labelledby="mm-mix-title"><div class="mm-section-heading"><div><span class="mm-eyebrow">03 / MIXING DESK</span><h2 id="mm-mix-title">Mixer</h2></div></div><p id="mm-stem-hint" class="mm-footnote"></p><div class="mm-console-scroll" role="region" tabindex="0" aria-label="Music mixer channels; scroll horizontally for more stems"><div id="mm-channels" class="mm-console"></div></div></section>`;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (_) { /* Fresh mix. */ }
    // Keep earlier voice drafts in saved sessions without mounting another rap player.
    savedRap = saved?.rap;
    signalLibrary = globalThis.HydraSignalLibrary?.create(saved?.signalLinks);
    restorePrompt(saved?.prompt);
    engine = api().create({ sourceBridge: options.sourceBridge, onUpdate: updateView, onError: (error) => notice(error.message || String(error), true) });
    generation = globalThis.HydraMusicMixerGeneration.create({ engine, getSettings: generationSettings, getNextTrack: nextTrackChoice,
      onUpdate: updateGeneration, onTrack: rememberTrack, onError: (error) => notice(error.message || String(error), true) });
    selectedId = typeof saved?.trackId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(saved.trackId) ? saved.trackId : "";
    config = api().validateConfig(saved?.config || { mode: "shared", buses: [newBus("mix-a", "Mix A")], channels: [api().defaultChannel("master")] });
    engine.setConfig(config); config = engine.getConfig(); $("mode").value = config.mode;
    renderBuses(); renderChannels(); renderTransport();
    root.addEventListener("change", onChange); root.addEventListener("input", onInput); root.addEventListener("click", onClick);
  }
  function activate() {
    if (!initialized) return;
    syncSignals();
    if (active) { renderTransport(); return; }
    active = true; engine.activate(); refresh();
  }
  function deactivate() { if (!initialized) return; active = false; ++fetchRun; controller?.abort(); loadingTrack = false; $("refresh").disabled = false; save(); generation.deactivate(); engine.deactivate(); }
  return { init, activate, deactivate, refresh, getState, flush, save,
    transportClock: () => engine?.transportClock?.(Number($("bpm").value)),
    get snapshot() { return engine?.snapshot(); }, get generationSnapshot() { return generation?.snapshot(); } };
})();
