"use strict";

// This workspace keeps its sounds and signal mixes separate from the original Synth.
globalThis.HydraSynthMixer = (() => {
  const KEY = "hydra.synth-mixer.v1";
  const OPERATORS = { average: "Average", weighted: "Weighted blend", difference: "Difference", minimum: "Lowest", maximum: "Highest" };
  const READ_MODES = { value: "Direct value", mean: "Average", rms: "RMS magnitude", minimum: "Lowest value", maximum: "Highest value", index: "One element" };
  const CURVES = { linear: "Linear", smooth: "Smooth", exponential: "Exponential", inverse: "Inverse", steps: "Steps", threshold: "Threshold" };
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const format = (value) => !finite(value) ? "—" : Math.abs(value) >= 1000 ? value.toFixed(0) : Number(value.toFixed(2)).toString();
  const percent = (value) => finite(value) ? `${Math.round(value * 100)}%` : "—";
  const readable = (value) => { const text = String(value || "").replace(/_/g, " ").replace(/\s+/g, " ").trim(); return text.charAt(0).toUpperCase() + text.slice(1); };
  let root, engine, config, snapshot, transport, sourceBridge, getDestinations, signalLibrary, savedRap;
  let initialized = false, active = false, rendering = false, starting = false, selectingPatch = false, fieldsKey = "", destinationsKey = "", outputKey = "", lastSave = 0, timer;
  const history = new Map();
  const $ = (id) => root.querySelector(`#sm-${id}`);
  const api = () => globalThis.HydraSynthMixerEngine;
  const fields = () => snapshot?.fields || [];
  const destinations = () => getDestinations?.() || globalThis.HydraSonification.DESTINATIONS;
  const destinationFor = (id) => destinations().find((item) => item.id === id);
  const status = () => transport?.status?.() || { playing: false, preparing: false, output: "audio" };
  const sourceFor = (key, available = fields()) => {
    const field = available.find((item) => item.key === key);
    return globalThis.HydraElevenRealtime.validateSource({ sourceKey: key || "__unassigned", reducer: field?.default_reducer || field?.reducers?.[0] || "mean", rangeMode: "auto" });
  };
  const newBus = (id, name, key) => ({ id, name, operator: "average", sources: [sourceFor(key)] });
  const combinationLabel = (bus) => bus.sources.length === 1 ? "Single input" : `${bus.sources.length} inputs · ${OPERATORS[bus.operator]}`;
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
  function notice(message, error = false) {
    $("notice").textContent = message || "";
    $("notice").hidden = !message;
    $("notice").classList.toggle("is-error", error);
  }
  function getState() { return engine ? { ...engine.getConfig(), signalLinks: signalLibrary?.getLinks() || {}, ...(savedRap === undefined ? {} : { rap: savedRap }) } : null; }
  function flush() { const state = getState(); if (state) localStorage.setItem(KEY, JSON.stringify(state)); return state; }
  function save() { try { flush(); } catch (_) { /* Session-only controls still work. */ } }
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
    renderBuses(); renderParameters(); save();
  }
  function commit(render = "all") {
    engine.setConfig(config); config = engine.getConfig();
    publishSignals();
    if (render === "all" || render === "buses") renderBuses();
    if (render === "all" || render === "parameters") renderParameters();
    save();
  }
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
    const reducers = [...new Set([...(field?.reducers || Object.keys(READ_MODES)), source.reducer])];
    return `<div class="mm-source" data-source="${index}">
      <div class="mm-source-line"><label class="sr-only" for="sm-${escape(bus.id)}-source-${index}">Input ${index + 1} for ${escape(bus.name)}</label><select id="sm-${escape(bus.id)}-source-${index}" data-source-field="sourceKey">${sourceOptions(source.sourceKey)}</select><output data-raw title="Incoming value">—</output><button class="mm-button mm-icon" data-action="remove-source" aria-label="Remove input ${index + 1}" ${bus.sources.length === 1 ? "disabled" : ""}>×</button></div>
      <p class="mm-source-caption">${escape(field ? [channelLabel(field), source.reducer === "index" ? `Element ${source.index + 1}` : READ_MODES[source.reducer] || readable(source.reducer)].filter(Boolean).join(" · ") : source.sourceKey === "__unassigned" ? "No input selected" : "Input unavailable")}</p>
      <meter min="0" max="1" value="0" data-source-meter aria-label="Normalized input ${index + 1}"></meter>
      <details class="mm-source-details" data-detail="${escape(bus.id)}:${index}"><summary><span>${source.rangeMode === "auto" ? "Auto learn" : "Fixed range"}</span> <span data-bounds></span></summary>
        <div class="mm-pair"><label>Read as<select data-source-field="reducer">${reducers.map((reducer) => `<option value="${escape(reducer)}" ${reducer === source.reducer ? "selected" : ""}>${escape(READ_MODES[reducer] || readable(reducer))}</option>`).join("")}</select></label><label>Range<select data-source-field="rangeMode"><option value="auto" ${source.rangeMode === "auto" ? "selected" : ""}>Auto learn</option><option value="fixed" ${source.rangeMode === "fixed" ? "selected" : ""}>Fixed</option></select></label></div>
        ${source.reducer === "index" ? `<label>Element index (starts at 0)<input type="number" min="0" max="262143" step="1" data-source-field="index" value="${source.index}"></label>` : ""}
        <div class="mm-pair"><label>Minimum<input type="number" step="any" data-source-field="inputMin" value="${source.inputMin}" ${source.rangeMode === "auto" ? "disabled" : ""}></label><label>Maximum<input type="number" step="any" data-source-field="inputMax" value="${source.inputMax}" ${source.rangeMode === "auto" ? "disabled" : ""}></label></div>
        ${bus.operator === "weighted" ? `<label>Weight<input type="number" min="0" max="100" step="0.1" data-source-field="weight" value="${source.weight}"></label>` : ""}
        <div class="mm-pair"><button class="mm-button" data-action="freeze">Freeze range</button><button class="mm-button" data-action="relearn">Learn again</button></div>
      </details></div>`;
  }
  function preserveDetails(container, html) {
    const opened = new Set([...container.querySelectorAll("details[open][data-detail]")].map((element) => element.dataset.detail));
    container.innerHTML = html;
    for (const element of container.querySelectorAll("details[data-detail]")) element.open = opened.has(element.dataset.detail);
  }
  function renderBuses() {
    rendering = true;
    try {
      preserveDetails($("buses"), config.buses.map((bus, i) => `<article class="mm-bus mm-color-${i % 4}" data-bus="${escape(bus.id)}">
        <div class="mm-bus-head"><span class="mm-bus-letter">${String.fromCharCode(65 + i)}</span><input data-bus-name value="${escape(bus.name)}" maxlength="30" aria-label="Signal mix name"><output data-bus-value>—</output><button class="mm-button mm-icon" data-action="remove-bus" aria-label="Remove ${escape(bus.name)}" ${config.buses.length === 1 ? "disabled" : ""}>×</button></div>
        <p class="mm-bus-combination">${escape(combinationLabel(bus))}</p>${libraryRow(bus)}
        <svg class="mm-scope" viewBox="0 0 300 54" preserveAspectRatio="none" role="img" aria-label="${escape(bus.name)} signal history"><path class="mm-scope-grid" d="M0 13.5H300 M0 27H300 M0 40.5H300 M75 0V54 M150 0V54 M225 0V54"/><path data-scope d=""/></svg>
        <div class="mm-sources">${bus.sources.map((source, index) => sourceHTML(source, index, bus)).join("")}</div>
        <div class="mm-bus-footer"><label>Combine inputs<select data-operator ${bus.sources.length < 2 ? 'disabled title="Add another input to combine signals"' : ""}>${Object.entries(OPERATORS).map(([value, label]) => `<option value="${value}" ${bus.operator === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><button class="mm-button" data-action="add-source" ${bus.sources.length >= 6 ? "disabled" : ""}>+ Input</button></div>
        <p class="mm-bus-status" data-bus-status>Waiting for input</p></article>`).join(""));
      $("add-bus").disabled = config.buses.length >= 4;
      renderLibrary();
    } finally { rendering = false; }
  }
  function busCaption(bus) {
    return !bus ? "Set a value directly" : bus.sources.length > 1 ? combinationLabel(bus) : fieldLabel(fields().find((field) => field.key === bus.sources[0]?.sourceKey));
  }
  function parameterUnavailable(destination, output) {
    if (!destination) return "Parameter unavailable";
    if (globalThis.HydraParameters?.availability) return globalThis.HydraParameters.availability(destination, { output, midiFormat: status().midiFormat || config.controls.midiFormat });
    if (destination.unavailable) return destination.unavailable;
    if (destination.hardware && output !== "midi") return "MIDI only";
    if (destination.kind === "nrpn" && (status().midiFormat || config.controls.midiFormat) === "cc") return "Select NRPN in Connections";
    return "";
  }
  function renderParameters() {
    rendering = true;
    try {
      const output = status().output || "audio";
      preserveDetails($("parameters"), config.parameters.map((parameter, index) => {
        const destination = destinationFor(parameter.destination) || { id: parameter.destination, label: parameter.destination, group: "Unavailable", min: 0, max: 127 };
        const bus = config.buses.find((item) => item.id === parameter.busId), color = Math.max(0, config.buses.findIndex((item) => item.id === parameter.busId)) % 4;
        const reason = parameterUnavailable(destinationFor(parameter.destination), output), id = `sm-parameter-${index}`;
        const manualControl = destination.choices?.length
          ? `<select id="${id}-value" data-parameter-field="value" ${reason ? "disabled" : ""}>${destination.choices.map((choice) => `<option value="${choice.value}" ${choice.value === parameter.value ? "selected" : ""}>${escape(choice.label || choice.name || choice.value)}</option>`).join("")}</select>`
          : `<input id="${id}-value" type="range" min="${destination.min}" max="${destination.max}" step="${destination.discrete || destination.max - destination.min > 10 ? 1 : 0.01}" value="${parameter.value}" data-parameter-field="value" ${reason ? "disabled" : ""}>`;
        return `<article class="sm-parameter mm-route mm-color-${color} ${parameter.enabled ? "" : "is-disabled"}" data-parameter="${escape(parameter.destination)}">
          <header class="sm-parameter-heading"><div><span>${escape(destination.group || "Sound")}</span><h3>${escape(destination.label)}</h3></div><button class="mm-button sm-remove" data-action="remove-parameter" aria-label="Remove ${escape(destination.label)}">×</button></header>
          <div class="sm-parameter-value"><output data-effective ${destination.choices?.length ? 'class="sm-choice-value"' : ""}>—</output><span data-parameter-state>${escape(reason || (parameter.busId && parameter.strength > 0 ? "Mapped" : "Manual"))}</span></div>
          <meter class="sm-parameter-meter" min="${destination.min}" max="${destination.max}" value="${parameter.value}" data-parameter-meter aria-label="${escape(destination.label)} effective value"></meter>
          <label class="sm-manual-control" for="${id}-value" ${parameter.busId ? 'title="The value used at 0% signal strength."' : ""}><span>${parameter.busId ? "Base value" : "Manual value"} <output data-manual-value>${format(parameter.value)}</output></span>${manualControl}</label>
          <label for="${id}-bus">Signal mix<select id="${id}-bus" data-parameter-field="busId"><option value="" ${!parameter.busId ? "selected" : ""}>Manual</option>${parameter.busId && !bus ? `<option value="${escape(parameter.busId)}" selected>Unavailable mix</option>` : ""}${config.buses.map((item) => `<option value="${escape(item.id)}" ${item.id === parameter.busId ? "selected" : ""}>${escape(item.name)}</option>`).join("")}</select></label>
          <p class="mm-route-source">${escape(busCaption(bus))}</p>
          <label class="mm-strength" for="${id}-strength" title="0% keeps the base value; 100% applies the full signal mapping."><span>Signal strength <output data-strength-value>${percent(parameter.strength)}</output></span><input id="${id}-strength" type="range" min="0" max="100" step="1" value="${Math.round(parameter.strength * 100)}" data-parameter-field="strength" aria-valuetext="${percent(parameter.strength)}" ${!parameter.busId || reason ? "disabled" : ""}></label>
          <details class="sm-mapping-range" data-detail="parameter:${escape(parameter.destination)}"><summary>Range &amp; response</summary><div class="mm-pair"><label>From<input type="number" min="${destination.min}" max="${destination.max}" step="any" value="${parameter.minimum}" data-parameter-field="minimum"></label><label>To<input type="number" min="${destination.min}" max="${destination.max}" step="any" value="${parameter.maximum}" data-parameter-field="maximum"></label></div><label>Response<select data-parameter-field="curve">${Object.entries(CURVES).map(([value, label]) => `<option value="${value}" ${parameter.curve === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label class="mm-check"><input type="checkbox" data-parameter-field="invert" ${parameter.invert ? "checked" : ""}> Reverse</label></details>
          <div class="sm-parameter-footer"><button class="mm-button" data-action="enable-parameter" aria-pressed="${parameter.enabled}" aria-label="Enable ${escape(destination.label)}">${parameter.enabled ? "Enabled" : "Disabled"}</button>${destination.hardware ? '<span class="sm-hardware-tag">MIDI</span>' : ""}</div></article>`;
      }).join("") || '<div class="mm-empty">Choose a parameter to control.<br><button class="mm-button" data-action="open-picker">+ Parameter</button></div>');
      $("parameter-count").textContent = `${config.parameters.length} parameters`;
      $("add-parameter").disabled = config.parameters.length >= (api().MAX_PARAMETERS || 2048);
    } finally { rendering = false; }
  }
  function restoreControls() {
    for (const element of root.querySelectorAll("[data-control]")) {
      const key = element.dataset.control;
      if (config.controls[key] !== undefined) element.value = String(config.controls[key]);
    }
    updateSoundControls();
  }
  function updateSoundControls() {
    const next = status(), midi = next.output === "midi", controls = config.controls;
    const changing = selectingPatch || Boolean(next.patchChanging);
    $("patch-bank").disabled = $("patch-number").disabled = !midi || changing;
    $("apply-patch").disabled = !midi || !next.midiReady || changing || Boolean(next.preparing);
    $("apply-patch").textContent = changing ? "Selecting…" : "Select patch";
    $("patch-palette").hidden = !midi;
    $("patch-list").disabled = controls.patchPool === "all";
    $("sound-every").disabled = controls.soundMode === "off";
    $("sound-help").textContent = midi
      ? "Select stored Hydrasynth sounds. Enable PGM CHG RX on the synth. Playback continues after the brief sound change. Selecting a patch replaces unsaved sound edits."
      : "Connect your Hydrasynth and choose MIDI output in Connections to select stored patches. Automatic changes use browser voices while Browser audio is selected.";
    const mapped = config.parameters.some((item) => item.destination === "sound" && item.enabled && item.busId && item.strength > 0);
    $("sound-mapping-help").hidden = controls.soundMode !== "mapped";
    $("sound-mapping-help").textContent = mapped
      ? "Sound palette position follows its signal mix. MIDI changes wait at least two seconds between patches."
      : "Choose a signal mix on the Sound palette position parameter below to vary the selected sound.";
    $("patch-status").textContent = midi && next.currentPatch
      ? `Last sent: ${next.currentPatch.bank}${String(next.currentPatch.number).padStart(3, "0")}`
      : midi ? "No patch sent this session" : "MIDI output required";
  }
  function updateTransport() {
    const next = status(), busy = starting || selectingPatch || next.preparing;
    $("play").disabled = busy || next.playing || Boolean(next.readyReason);
    $("play").textContent = busy ? "Preparing…" : "▶ Play";
    $("stop").disabled = !busy && !next.playing;
    $("transport-status").textContent = next.error || next.readyReason || (selectingPatch ? "Selecting patch" : next.playing ? snapshot?.sourceValid === false ? "Waiting for mapped input" : "Playing" : busy ? "Preparing signals" : "Stopped");
    $("output").textContent = next.output === "midi" ? next.midiReady ? "MIDI output" : "MIDI · connect a device" : "Browser audio";
    $("voice").disabled = next.output === "midi";
    $("voice").title = next.output === "midi" ? "Use the bank and patch controls below." : "";
    updateSoundControls();
    const key = `${next.output}|${next.midiFormat || config.controls.midiFormat}`;
    if (key !== outputKey) { outputKey = key; renderParameters(); }
  }
  function updateView(next) {
    if (!root || !config) return;
    if (engine) next = engine.snapshot(status().output, { midiFormat: status().midiFormat });
    snapshot = next;
    $("source-label").textContent = next.sourceLabel || "Choose an input in Connections";
    const nextKey = JSON.stringify(next.fields || []);
    // Live fields may be discovered while typing; wait until the edit finishes.
    if (nextKey !== fieldsKey && !$("buses").contains(document.activeElement) && !$("parameters").contains(document.activeElement)) {
      fieldsKey = nextKey; renderBuses(); renderParameters();
    }
    const catalogKey = `${destinations().length}|${destinations().at(-1)?.id}`;
    if (catalogKey !== destinationsKey && !$("parameters").contains(document.activeElement)) {
      destinationsKey = catalogKey; renderParameters();
    }
    for (const bus of next.buses || []) {
      const element = [...root.querySelectorAll("[data-bus]")].find((item) => item.dataset.bus === bus.id);
      if (!element) continue;
      element.querySelector("[data-bus-value]").textContent = percent(bus.value);
      const inputCount = bus.sources?.length || 0, readyCount = (bus.sources || []).filter((source) => source.valid).length;
      element.querySelector("[data-bus-status]").textContent = finite(bus.value) ? inputCount > 1 ? "Combined signal ready" : "Input ready" : inputCount > 1 ? `Waiting for ${inputCount - readyCount} of ${inputCount} inputs` : "Waiting for input";
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
    const output = status().output || "audio";
    for (const parameter of next.parameters || []) {
      const id = parameter.destination;
      const element = [...root.querySelectorAll("[data-parameter]")].find((item) => item.dataset.parameter === id);
      if (!element) continue;
      const saved = config.parameters.find((item) => item.destination === id), destination = destinationFor(id);
      const reason = parameterUnavailable(destination, output);
      element.querySelector("[data-effective]").textContent = reason || saved?.enabled === false ? "—" : globalThis.HydraParameters?.displayValue?.(destination, parameter.effectiveValue) || format(parameter.effectiveValue);
      element.querySelector("[data-parameter-state]").textContent = reason || (saved?.enabled === false ? "Disabled" : !parameter.valid ? "Waiting for input" : saved?.busId && saved.strength > 0 ? "Mapped" : "Manual");
      element.querySelector("[data-parameter-meter]").value = reason || saved?.enabled === false || !finite(parameter.effectiveValue) ? destination?.min || 0 : parameter.effectiveValue;
    }
    updateTransport();
    if (active && performance.now() - lastSave > 2000) { lastSave = performance.now(); save(); }
  }
  function pickerItems() {
    return destinations().filter((item) => !config.parameters.some((parameter) => parameter.destination === item.id));
  }
  function renderPicker() {
    const query = $("parameter-search").value.trim().toLowerCase(), group = $("parameter-group").value;
    const available = pickerItems().filter((item) => (!group || item.group === group) && (!query || `${item.label} ${item.group} ${item.id}`.toLowerCase().includes(query)));
    const usable = available.filter((item) => !item.unavailable).length;
    $("picker-count").textContent = `${available.length} parameters${usable < available.length ? ` · ${available.length - usable} unavailable in the published MIDI specification` : ""}`;
    $("picker-results").innerHTML = available.map((item) => `<button class="sm-picker-item" data-add-destination="${escape(item.id)}" ${item.unavailable ? "disabled" : ""}><span><b>${escape(item.label)}</b><small>${escape(item.group)}${item.hardware ? ' · <span class="sm-picker-kind">MIDI only</span>' : ""}</small>${item.unavailable || item.hint ? `<small>${escape(item.unavailable || item.hint)}</small>` : ""}</span><span aria-hidden="true">${item.unavailable ? "—" : "+"}</span></button>`).join("") || '<p class="sm-picker-empty">No matching parameters.</p>';
  }
  function openPicker() {
    if (config.parameters.length >= (api().MAX_PARAMETERS || 2048)) return;
    $("parameter-search").value = "";
    $("parameter-group").innerHTML = '<option value="">All groups</option>' + [...new Set(pickerItems().map((item) => item.group))].map((group) => `<option value="${escape(group)}">${escape(group)}</option>`).join("");
    renderPicker(); $("picker").showModal(); $("parameter-search").focus();
  }
  function context(element) {
    config = engine.getConfig();
    const bus = config.buses.find((item) => item.id === element.closest("[data-bus]")?.dataset.bus);
    const sourceIndex = Number(element.closest("[data-source]")?.dataset.source);
    const parameter = config.parameters.find((item) => item.destination === element.closest("[data-parameter]")?.dataset.parameter);
    return { bus, sourceIndex, source: bus?.sources[sourceIndex], parameter };
  }
  function onChange(event) {
    if (rendering) return;
    const element = event.target, { bus, source, parameter } = context(element);
    if (element.id === "sm-shared-mix") { renderLibrary(); return; }
    if (element.id === "sm-parameter-group") { renderPicker(); return; }
    if (element.dataset.control) {
      config.controls[element.dataset.control] = element.type === "number" ? element.valueAsNumber : element.value;
      if (element.type === "number" && !finite(element.valueAsNumber)) return;
      if (element.dataset.control === "previewVoice") {
        const voice = globalThis.HydraSonification.VOICES.find((item) => item.id === element.value);
        if (voice) Object.assign(config.controls, { waveType: voice.waveType, attack: voice.attack, release: voice.release, brightness: voice.brightness });
      }
      if (element.dataset.control === "soundMode" && element.value === "mapped" && !config.parameters.some((item) => item.destination === "sound")) {
        config.parameters.push(api().defaultParameter("sound"));
      }
      commit(element.dataset.control === "soundMode" ? "parameters" : "none"); restoreControls(); return;
    }
    if (element.id === "sm-mode") {
      signalLibrary?.detachAll();
      config.mode = element.value;
      const available = element.value === "demo" ? globalThis.HydraMusicMixerEngine.DEMO_FIELDS : sourceBridge?.describe?.().fields || [];
      config.buses.forEach((item, index) => { item.sources = [sourceFor(available[index % Math.max(1, available.length)]?.key, available)]; });
      history.clear(); commit(); notice(""); return;
    }
    if (element.hasAttribute("data-bus-name")) { bus.name = element.value.trim() || "Signal mix"; commit(); return; }
    if (element.hasAttribute("data-operator")) { bus.operator = element.value; commit(); return; }
    if (source && element.dataset.sourceField) {
      const key = element.dataset.sourceField;
      if (key === "sourceKey") Object.assign(source, sourceFor(element.value));
      else if (["inputMin", "inputMax", "weight", "index"].includes(key)) {
        if (!finite(element.valueAsNumber)) { notice("Enter a finite number for the input range.", true); return; }
        source[key] = element.valueAsNumber;
        if (key.startsWith("input") && source.inputMax <= source.inputMin) { notice("The maximum must be greater than the minimum.", true); return; }
      } else source[key] = element.value;
      if (key === "reducer" || key === "index" || (key === "rangeMode" && element.value === "auto")) { source.learnedMin = null; source.learnedMax = null; }
      commit(); notice(""); return;
    }
    if (parameter && element.dataset.parameterField) {
      const key = element.dataset.parameterField;
      if (key === "strength") { onInput(event); return; }
      if (key === "value") { if (element.tagName === "SELECT") { parameter.value = Number(element.value); commit("parameters"); } return; }
      if (key === "invert") parameter[key] = element.checked;
      else if (["minimum", "maximum"].includes(key)) { if (!finite(element.valueAsNumber)) return; parameter[key] = element.valueAsNumber; }
      else parameter[key] = element.value;
      commit("parameters");
    }
  }
  function onInput(event) {
    if (rendering) return;
    const element = event.target;
    if (element.id === "sm-parameter-search") { renderPicker(); return; }
    const key = element.dataset.parameterField;
    if (key !== "value" && key !== "strength") return;
    const { parameter } = context(element); if (!parameter || !finite(element.valueAsNumber)) return;
    parameter[key] = key === "strength" ? Math.max(0, Math.min(100, element.valueAsNumber)) / 100 : element.valueAsNumber;
    engine.setConfig(config); config = engine.getConfig(); save();
    const row = element.closest("[data-parameter]");
    if (key === "strength") {
      row.querySelector("[data-strength-value]").textContent = percent(parameter.strength);
      element.setAttribute("aria-valuetext", percent(parameter.strength));
    } else row.querySelector("[data-manual-value]").textContent = format(parameter.value);
  }
  async function onClick(event) {
    const element = event.target.closest("button"); if (!element) return;
    if (element.id === "sm-play") {
      notice(""); starting = true; updateTransport();
      try { await transport.start(); } catch (error) { notice(error.message || String(error), true); }
      finally { starting = false; updateTransport(); }
      return;
    }
    if (element.id === "sm-stop") { transport.stop(); starting = false; updateTransport(); return; }
    if (element.id === "sm-apply-patch") {
      if (selectingPatch || status().patchChanging || status().output !== "midi" || !status().midiReady || status().preparing) return;
      selectingPatch = true; notice(""); updateTransport();
      try { await transport.selectPatch(config.controls.patchBank, Math.round(config.controls.patchNumber)); }
      catch (error) { notice(error.message || "Could not select the MIDI patch.", true); }
      finally { selectingPatch = false; updateTransport(); }
      return;
    }
    if (element.id === "sm-close-picker") { $("picker").close(); return; }
    if (element.id === "sm-add-parameter" || element.dataset.action === "open-picker") { openPicker(); return; }
    if (element.dataset.addDestination) {
      config = engine.getConfig();
      const destination = destinationFor(element.dataset.addDestination);
      if (destination && !destination.unavailable && config.parameters.length < (api().MAX_PARAMETERS || 2048) && !config.parameters.some((item) => item.destination === destination.id)) {
        config.parameters.push(api().defaultParameter(destination)); commit("parameters");
      }
      $("picker").close(); return;
    }
    const { bus, sourceIndex, parameter } = context(element);
    if (element.id === "sm-add-shared") {
      try { signalLibrary?.attach($("shared-mix").value, config, `mix-${Date.now().toString(36)}`); commit(); notice(""); }
      catch (error) { notice(error.message, true); }
      return;
    }
    if (element.dataset.action === "share-mix") {
      try { signalLibrary?.share(bus, config.mode); renderBuses(); save(); notice(""); }
      catch (error) { notice(error.message, true); }
      return;
    }
    if (element.dataset.action === "detach-mix") { signalLibrary?.detach(bus.id); renderBuses(); save(); return; }
    if (element.id === "sm-add-bus") {
      if (config.buses.length >= 4) return;
      config.buses.push(newBus(`mix-${Date.now().toString(36)}`, `Mix ${String.fromCharCode(65 + config.buses.length)}`, fields()[config.buses.length % Math.max(1, fields().length)]?.key)); commit(); return;
    }
    switch (element.dataset.action) {
      case "add-source": if (bus.sources.length < 6) bus.sources.push(sourceFor(fields().find((field) => !bus.sources.some((source) => source.sourceKey === field.key))?.key || fields()[0]?.key)); commit(); break;
      case "remove-source": if (bus.sources.length > 1) bus.sources.splice(sourceIndex, 1); commit(); break;
      case "remove-bus":
        if (config.buses.length === 1) return;
        config.buses = config.buses.filter((item) => item !== bus);
        config.parameters.forEach((item) => { if (item.busId === bus.id) item.busId = ""; }); history.delete(bus.id); commit(); break;
      case "freeze":
        if (!engine.freeze(bus.id, sourceIndex)) { notice("Wait for incoming data before freezing this range."); return; }
        config = engine.getConfig(); publishSignals(); renderBuses(); save(); notice(""); break;
      case "relearn": engine.relearn(bus.id, sourceIndex); config = engine.getConfig(); publishSignals(); renderBuses(); save(); notice(""); break;
      case "enable-parameter": parameter.enabled = !parameter.enabled; commit("parameters"); break;
      case "remove-parameter": config.parameters = config.parameters.filter((item) => item !== parameter); commit("parameters"); break;
    }
  }
  function init(options = {}) {
    if (initialized || !options.container || !api()) return;
    initialized = true; root = options.container; transport = options.transport; sourceBridge = options.sourceBridge; getDestinations = options.getDestinations;
    root.classList.add("mm-workspace", "sm-workspace");
    const Music = globalThis.HydraSonification;
    root.innerHTML = `<header class="mm-header"><div><span class="mm-eyebrow">SYNTH CONTROL</span><h1>Synth mixer</h1></div><a class="mm-button" href="#synth-legacy" data-workspace="synth-legacy" data-advanced>Previous version ↗</a></header>
      <section class="mm-prompt-panel sm-sound-panel" aria-labelledby="sm-sound-title"><div class="mm-section-heading"><div><span class="mm-eyebrow">01 / SOUND</span><h2 id="sm-sound-title">Shape your sound</h2></div><span id="sm-output" class="sm-output">Browser audio</span></div>
        <div class="sm-sound-grid"><label>Browser voice<select id="sm-voice" data-control="previewVoice"><option value="custom">Custom</option>${Music.VOICES.map((voice) => `<option value="${voice.id}">${escape(voice.name)}</option>`).join("")}</select></label><label>Tempo · BPM<input id="sm-tempo" data-control="tempo" type="number" min="20" max="240" step="1"></label><label>Root<select id="sm-root" data-control="scaleRoot">${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"].map((value) => `<option>${value}</option>`).join("")}</select></label><label>Scale<select id="sm-scale" data-control="scaleName">${Object.keys(Music.SCALE_INTERVALS).map((value) => `<option value="${value}">${readable(value.replace(/-/g, " "))}</option>`).join("")}</select></label><label>Chord voices<input id="sm-voices" data-control="voices" type="number" min="1" max="8" step="1"></label></div>
        <details class="sm-sounds" open><summary>Sounds &amp; patches</summary>
          <div class="sm-patch-select"><label>Bank<select id="sm-patch-bank" data-control="patchBank">${[..."ABCDEFGH"].map((bank) => `<option>${bank}</option>`).join("")}</select></label><label>Patch<input id="sm-patch-number" data-control="patchNumber" type="number" min="1" max="128" step="1"></label><button id="sm-apply-patch" class="mm-button">Select patch</button><span id="sm-patch-status" role="status"></span></div>
          <p id="sm-sound-help" class="mm-footnote"></p>
          <div class="mm-pair"><label>Automatic sound changes<select id="sm-sound-mode" data-control="soundMode"><option value="off">Off · keep current sound</option><option value="cycle">Cycle</option><option value="random">Random</option><option value="mapped">Follow mapping</option></select></label><label>Change every<select id="sm-sound-every" data-control="soundEvery">${[16, 32, 64, 128].map((steps) => `<option value="${steps}">${steps} steps</option>`).join("")}</select></label></div>
          <div id="sm-patch-palette" class="mm-pair"><label>Patch palette<select id="sm-patch-pool" data-control="patchPool"><option value="all">All banks · A–H</option><option value="shortlist">Custom selection</option></select></label><label>Patch locations<input id="sm-patch-list" data-control="patchList" type="text" maxlength="512" placeholder="A001, B017, H128"></label></div>
          <p id="sm-sound-mapping-help" class="mm-footnote" hidden></p>
        </details>
        <div class="sm-transport"><button id="sm-play" class="mm-button mm-primary">▶ Play</button><button id="sm-stop" class="mm-button" disabled>■ Stop</button><span id="sm-transport-status" role="status">Stopped</span><a href="#connections" data-workspace="connections">Connections ↗</a></div>
      </section><p id="sm-notice" class="mm-notice" role="status" hidden></p>
      <section aria-labelledby="sm-input-title"><div class="mm-section-heading"><div><span class="mm-eyebrow">02 / SIGNALS</span><h2 id="sm-input-title">Signal mixes</h2></div><button id="sm-add-bus" class="mm-button">+ Signal mix</button></div><div class="mm-source-toolbar"><label>Signals from<select id="sm-mode"><option value="shared">Connections input</option><option value="demo">Simulated demo signals</option></select></label><span id="sm-source-label">Choose an input in Connections</span><a href="#connections" data-workspace="connections">Connections ↗</a></div><div class="mm-library-toolbar"><label>Shared signal mixes<select id="sm-shared-mix"></select></label><button id="sm-add-shared" class="mm-button">Add shared mix</button></div><div id="sm-buses" class="mm-buses"></div></section>
      <div class="mm-flowline" aria-hidden="true"><span>INPUT SIGNALS</span><i>→</i><span>SIGNAL MIXES</span><i>→</i><span>SYNTH PARAMETERS</span></div>
      <section aria-labelledby="sm-desk-title"><div class="mm-section-heading"><div><span class="mm-eyebrow">03 / PARAMETER DESK</span><h2 id="sm-desk-title">Synth parameters</h2></div><button id="sm-add-parameter" class="mm-button">+ Parameter</button></div><p id="sm-parameter-count" class="mm-footnote"></p><div id="sm-parameters" class="sm-parameters"></div></section>
      <dialog id="sm-picker" class="sm-picker" aria-labelledby="sm-picker-title"><header><h2 id="sm-picker-title">Add a parameter</h2><button id="sm-close-picker" class="mm-button" aria-label="Close parameter picker">×</button></header><div class="sm-picker-controls"><label>Find a parameter<input id="sm-parameter-search" type="search" placeholder="Pitch, filter, envelope…" autocomplete="off"></label><label>Group<select id="sm-parameter-group"></select></label></div><p id="sm-picker-count" class="sm-picker-count"></p><div id="sm-picker-results" class="sm-picker-results"></div></dialog>`;
    let saved;
    try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) { /* Fresh controls. */ }
    // Keep previous drafts in session exports without running an embedded rap player.
    savedRap = saved?.rap;
    signalLibrary = globalThis.HydraSignalLibrary?.create(saved?.signalLinks);
    engine = api().create({ sourceBridge, getDestinations: destinations, onUpdate: updateView, onError: (error) => notice(error.message || String(error), true) });
    // Normalize before setConfig emits: malformed stored JSON values must not
    // reach render callbacks as if they were a valid workspace configuration.
    config = api().validateConfig(saved || api().defaultConfig(), destinations());
    engine.setConfig(config); config = engine.getConfig(); snapshot = engine.snapshot();
    $("mode").value = config.mode; restoreControls(); renderBuses(); renderParameters(); updateTransport();
    root.addEventListener("change", onChange); root.addEventListener("input", onInput); root.addEventListener("click", onClick);
    $("picker").addEventListener("click", (event) => { if (event.target === $("picker")) { const bounds = $("picker").getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $("picker").close(); } });
    root.addEventListener("keydown", (event) => {
      if (!active || event.defaultPrevented) return;
      if ($("picker").open) { event.stopPropagation(); return; }
      if (event.target.closest("input, select, textarea, button, a, summary")) return;
      if (event.key === "Escape") { event.preventDefault(); transport.stop(); updateTransport(); }
      else if (event.code === "Space" && !event.repeat) { event.preventDefault(); (status().playing || status().preparing || starting || selectingPatch ? $("stop") : $("play")).click(); }
    });
  }
  function activate() {
    if (!initialized) return;
    syncSignals();
    if (active) { updateTransport(); return; }
    active = true; engine.activate();
    window.clearInterval(timer); timer = window.setInterval(updateTransport, 100);
  }
  function deactivate() {
    if (!initialized) return; active = false; window.clearInterval(timer); save(); transport.stop(); engine.deactivate();
    if ($("picker").open) $("picker").close();
  }
  return { init, activate, deactivate, getState, flush, save, getControls: () => engine?.getConfig().controls, evaluate: (output, options) => engine?.evaluate(output, options), reset: () => engine?.reset(), readyReason: () => "", get snapshot() { return engine?.snapshot(status().output, { midiFormat: status().midiFormat }); } };
})();
