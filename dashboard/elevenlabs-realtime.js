"use strict";

// Local audio controls run independently of the slower, explicitly armed paid requests.
globalThis.HydraElevenRealtime = (() => {
  const API = "/api/elevenlabs";
  const STORAGE_KEY = "hydra.elevenlabs.realtime.v1";
  const MAX_MIX_NAMES = 16;
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
  const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TARGETS = {
    cutoff: { label: "Low-pass cutoff · Hz", min: 20, max: 20000, low: 220, high: 14000, logarithmic: true },
    resonance: { label: "Filter resonance · Q", min: 0.1, max: 12, low: 0.7, high: 6 },
    highpass: { label: "High-pass cutoff · Hz", min: 20, max: 2000, low: 20, high: 900, logarithmic: true },
    gain: { label: "Volume", min: 0, max: 1, low: 0.2, high: 0.85 },
    pan: { label: "Stereo pan", min: -1, max: 1, low: -0.8, high: 0.8 },
    rate: { label: "Speed + pitch", min: 0.75, max: 1.25, low: 0.85, high: 1.15 },
    delayMix: { label: "Delay mix", min: 0, max: 0.65, low: 0, high: 0.4 },
    reverbMix: { label: "Reverb mix", min: 0, max: 0.65, low: 0.05, high: 0.5 },
  };
  function normalize(value, minimum, maximum, invert = false) {
    if (!finite(value) || !finite(minimum) || !finite(maximum) || maximum <= minimum) return null;
    const normalized = clamp((value - minimum) / (maximum - minimum));
    return invert ? 1 - normalized : normalized;
  }
  function mapValue(normalized, mapping) {
    const target = TARGETS[mapping.target] || { min: 0, max: 1 };
    if (!finite(normalized) || !finite(mapping.outputMin) || !finite(mapping.outputMax)) return null;
    const low = clamp(mapping.outputMin, target.min, target.max), high = clamp(mapping.outputMax, target.min, target.max);
    return target.logarithmic ? low * Math.pow(high / low, clamp(normalized)) : low + clamp(normalized) * (high - low);
  }
  function summarize(points, now, seconds = 10) {
    const recent = points.filter((point) => point.at >= now - seconds * 1000);
    const valid = recent.filter((point) => finite(point.value));
    if (!valid.length) return null;
    const activity = valid.reduce((sum, point) => sum + point.value, 0) / valid.length;
    const variability = clamp(Math.sqrt(valid.reduce((sum, point) => sum + (point.value - activity) ** 2, 0) / valid.length) * 2);
    return { activity, variability, trend: clamp(valid.at(-1).value - valid[0].value, -1, 1),
      coverage: valid.length / recent.length, window_seconds: Math.max(0, (now - recent[0].at) / 1000), sample_count: valid.length };
  }
  function replayValue(analysis, sourceKey, elapsed) {
    const timeline = analysis?.timeline;
    if (!timeline?.times?.length || !finite(elapsed)) return null;
    const start = analysis.settings?.start_seconds ?? timeline.times[0];
    const duration = analysis.duration_seconds;
    if (!finite(duration) || duration <= 0) return null;
    const instant = start + ((elapsed % duration) + duration) % duration;
    const values = sourceKey === "activity" ? timeline.signal : timeline.channels?.[sourceKey];
    if (!values) return null;
    let low = 0, high = timeline.times.length;
    while (low < high) { const middle = (low + high) >>> 1; if (timeline.times[middle] <= instant) low = middle + 1; else high = middle; }
    const index = Math.max(0, low - 1);
    if (timeline.valid?.[index] === false || !finite(values[index])) return null;
    const next = Math.min(index + 1, timeline.times.length - 1);
    if (next === index || instant === timeline.times[index]) return values[index];
    if (timeline.valid?.[next] === false || !finite(values[next])) return null;
    const gap = timeline.times[next] - timeline.times[index];
    if (gap <= 0 || gap > (analysis.settings?.max_gap_seconds ?? 3)) return null;
    const ratio = clamp((instant - timeline.times[index]) / gap);
    return values[index] + ratio * (values[next] - values[index]);
  }
  function shouldGenerate({ running, armed, pending, queued, used, budget, sourceValid, features, remaining, lookahead }) {
    return Boolean(running && armed && !pending && !queued && used < budget && sourceValid &&
      features && features.coverage >= 0.9 && features.sample_count >= 2 && features.window_seconds >= 1 && remaining <= lookahead);
  }
  const OPERATORS = { direct: "Single input", average: "Average", weighted: "Weighted average", sum: "Sum · normalized", difference: "Difference", minimum: "Minimum", maximum: "Maximum" };
  function validateSource(source, legacy = false) {
    source = source && typeof source === "object" ? source : {};
    let inputMin = finite(source.inputMin) ? clamp(source.inputMin, -1e12, 1e12) : 0;
    let inputMax = finite(source.inputMax) ? clamp(source.inputMax, -1e12, 1e12) : 1;
    if (inputMax < inputMin || (source.rangeMode !== "auto" && inputMax === inputMin)) { inputMin = 0; inputMax = 1; }
    const learned = finite(source.learnedMin) && finite(source.learnedMax) && source.learnedMax >= source.learnedMin;
    return { sourceKey: typeof source.sourceKey === "string" && source.sourceKey.length > 0 && source.sourceKey.length <= 1024 ? source.sourceKey : "activity",
      reducer: ["value", "mean", "rms", "minimum", "maximum", "index"].includes(source.reducer) ? source.reducer : "mean",
      index: finite(source.index) ? Math.round(clamp(source.index, 0, 262143)) : 0,
      rangeMode: source.rangeMode === "auto" && !legacy ? "auto" : "fixed", inputMin, inputMax,
      learnedMin: learned ? clamp(source.learnedMin, -1e12, 1e12) : null, learnedMax: learned ? clamp(source.learnedMax, -1e12, 1e12) : null,
      weight: finite(source.weight) ? clamp(source.weight, 0, 100) : 1,
      autoSource: source.autoSource === true, awaitingBounds: source.awaitingBounds === true };
  }
  function validateSettings(value) {
    const saved = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const result = { mode: ["replay", "shared", "live", "demo"].includes(saved.mode) ? saved.mode : "replay",
      address: "ws://127.0.0.1:8765", duration: [20, 40, 60].includes(saved.duration) ? saved.duration : 60,
      budget: finite(saved.budget) ? Math.round(clamp(saved.budget, 1, 20)) : 3,
      generationInput: saved.generationInput === "all" || Number.isInteger(saved.generationInput) && saved.generationInput >= 0 && saved.generationInput < 16 ? saved.generationInput : "all",
      starterId: typeof saved.starterId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(saved.starterId) ? saved.starterId : null, mappings: [], stemMix: {}, mutedStems: [] };
    const mix = saved.stemMix && typeof saved.stemMix === "object" && !Array.isArray(saved.stemMix) ? saved.stemMix : {};
    const muted = Array.isArray(saved.mutedStems) ? saved.mutedStems : [];
    const mixNames = [...new Set([...muted, ...Object.keys(mix)])].filter((name) => typeof name === "string" && /^[^\x00-\x1f]{1,100}$/.test(name)).slice(0, MAX_MIX_NAMES);
    result.stemMix = Object.fromEntries(mixNames.filter((name) => finite(mix[name])).map((name) => [name, clamp(mix[name])]));
    result.mutedStems = mixNames.filter((name) => muted.includes(name));
    if (typeof saved.address === "string" && saved.address.length <= 2048) {
      try { const url = new URL(saved.address); if (["ws:", "wss:"].includes(url.protocol)) result.address = url.href; } catch (_) { /* Keep the default address. */ }
    }
    for (const mapping of (Array.isArray(saved.mappings) ? saved.mappings : []).slice(0, 16)) {
      if (!mapping || typeof mapping !== "object") continue;
      const legacyStem = typeof mapping.target === "string" && /^stem:[^\x00-\x1f]{1,100}$/.test(mapping.target) ? mapping.target.slice(5) : null;
      const audioSource = legacyStem || (typeof mapping.audioSource === "string" && /^[^\x00-\x1f]{1,100}$/.test(mapping.audioSource) ? mapping.audioSource : "master");
      const target = legacyStem ? "gain" : Object.prototype.hasOwnProperty.call(TARGETS, mapping.target) && !(audioSource !== "master" && mapping.target === "rate") ? mapping.target : "cutoff";
      const definition = targetFor(target);
      const sources = Array.isArray(mapping.sources) && mapping.sources.length ? mapping.sources.slice(0, 6).map((source) => validateSource(source)) : [validateSource(mapping, true)];
      result.mappings.push({ sources, operator: Object.prototype.hasOwnProperty.call(OPERATORS, mapping.operator) ? mapping.operator : sources.length > 1 ? "average" : "direct",
        audioSource, target, outputMin: finite(mapping.outputMin) ? clamp(mapping.outputMin, definition.min, definition.max) : definition.low,
        outputMax: finite(mapping.outputMax) ? clamp(mapping.outputMax, definition.min, definition.max) : definition.high,
        invert: mapping.invert === true, smoothing: finite(mapping.smoothing) ? clamp(mapping.smoothing, 0, 5) : 0.15 });
    }
    return result;
  }
  function resetLearning(source) {
    source.learnedMin = null; source.learnedMax = null; source.awaitingBounds = true; source.recordedBounds = false;
    bridge?.resetRange?.(source); state.stream?.resetRange?.(source);
  }
  function learnRange(source, minimum, maximum = minimum) {
    if (!finite(minimum) || !finite(maximum) || maximum < minimum) return;
    source.learnedMin = finite(source.learnedMin) ? Math.min(source.learnedMin, minimum) : minimum;
    source.learnedMax = finite(source.learnedMax) ? Math.max(source.learnedMax, maximum) : maximum;
    source.inputMin = source.learnedMin; source.inputMax = source.learnedMax;
  }
  function normalizeSource(source, sample, now) {
    if (!sample || !finite(sample.value) || (finite(sample.at) && (sample.at > now || now - sample.at > 3000))) return null;
    if (source.rangeMode === "auto") {
      if (!source.recordedBounds) {
        if (finite(sample.minimum) && finite(sample.maximum)) learnRange(source, sample.minimum, sample.maximum);
        learnRange(source, sample.value);
      }
      return source.learnedMax === source.learnedMin ? 0.5 : normalize(sample.value, source.learnedMin, source.learnedMax);
    }
    return normalize(sample.value, source.inputMin, source.inputMax);
  }
  function combineInputs(values, sources, operator = "average") {
    if (!values.length || values.some((value) => !finite(value))) return null;
    if (operator === "direct") return values[0];
    if (operator === "minimum") return Math.min(...values);
    if (operator === "maximum") return Math.max(...values);
    if (operator === "sum") return clamp(values.reduce((sum, value) => sum + value, 0) / values.length);
    if (operator === "difference") return values.length > 1 ? clamp((1 + values[0] - values.slice(1).reduce((sum, value) => sum + value, 0) / (values.length - 1)) / 2) : values[0];
    if (operator === "weighted") {
      const weights = sources.map((source) => finite(source.weight) ? Math.max(0, source.weight) : 1), total = weights.reduce((sum, weight) => sum + weight, 0);
      return total > 0 ? values.reduce((sum, value, i) => sum + value * weights[i], 0) / total : 0.5;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  function routeControl(controls, mapping, value) {
    if (!finite(value)) return;
    if (mapping.audioSource === "master") controls[mapping.target] = value;
    else if (mapping.target !== "rate") {
      if (!Object.prototype.hasOwnProperty.call(controls.stemControls, mapping.audioSource)) Object.defineProperty(controls.stemControls, mapping.audioSource, { value: {}, enumerable: true, configurable: true });
      controls.stemControls[mapping.audioSource][mapping.target] = value;
    }
  }
  const state = { initialized: false, active: false, running: false, starting: false, selection: {}, mappings: [],
    mode: "replay", sourceStarted: 0, points: [], sourceValid: false, timer: null, fieldsKey: "", run: 0,
    armed: false, used: 0, session: "", sequence: 0, pending: null, next: null, latency: 40,
    ws: null, stream: null, stemPending: null, stems: new Map(), stemResults: new Map(), stemMix: {}, mutedStems: new Set(), lastRender: 0,
    tracks: new Map(), starterId: null, starterKey: "", selectionJobId: null, generationInput: "all", generationKey: "" };
  let root, bridge, getSelection, getGenerationSettings, pauseOriginal, createTrack, player;
  const $ = (id) => root.querySelector(`#el-rt-${id}`);
  function targetFor(id) { return TARGETS[id] || { label: `Stem · ${id.slice(5)}`, min: 0, max: 1, low: 0, high: 1 }; }
  function notice(text, error = false) { if (!root) return; $("notice").textContent = text; $("notice").classList.toggle("is-error", error); }
  function remember() {
    if (!root) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(validateSettings({ mode: state.mode, address: $("address").value,
      duration: Number($("duration").value), budget: budget(), starterId: state.starterId, generationInput: state.generationInput, mappings: state.mappings,
      stemMix: state.stemMix, mutedStems: [...state.mutedStems] }))); }
    catch (_) { /* Playback and server artifacts remain available without browser storage. */ }
  }
  function restoreSettings() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch (_) { saved = {}; }
    const settings = validateSettings(saved);
    state.mode = bridge && !["replay", "shared", "live", "demo"].includes(saved?.mode) ? "shared" : settings.mode;
    state.starterId = settings.starterId; state.generationInput = settings.generationInput;
    state.stemMix = settings.stemMix; state.mutedStems = new Set(settings.mutedStems);
    $("address").value = settings.address; $("duration").value = String(settings.duration); $("budget").value = String(settings.budget);
    if (settings.mappings.length) state.mappings = settings.mappings.map((mapping) => ({ ...mapping,
      id: Math.random().toString(36).slice(2), sources: mapping.sources.map((source) => ({ ...source, awaitingBounds: source.rangeMode === "auto" })), normalized: null, value: null, mapped: null }));
    else state.mappings = [newMapping("cutoff"), newMapping("gain")];
    state.armed = false; $("auto").checked = false;
  }
  async function api(path, body) {
    const response = await fetch(`${API}${path}`, { method: body === undefined ? "GET" : "POST", cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error(`Unreadable server response (${response.status}).`); }
    if (!response.ok) {
      const error = new Error(typeof data.error === "string" ? data.error : data.error?.message || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function init(options) {
    if (state.initialized || !options?.container) return;
    root = options.container; bridge = options.sourceBridge; getSelection = options.getSelection; pauseOriginal = options.pauseOriginal; createTrack = options.createTrack; getGenerationSettings = options.getGenerationSettings;
    state.initialized = true;
    root.classList.add("el-realtime");
    root.innerHTML = `<section class="el-panel el-rt-panel" aria-labelledby="el-rt-title">
      <div class="el-panel-title el-panel-title-row"><h2 id="el-rt-title">Play & map</h2><span id="el-rt-badge" class="el-badge" data-advanced>LOCAL AUDIO · 20 Hz</span></div>
      <div class="el-rt-grid"><div class="el-rt-source">
        <label class="el-label">Your track<select id="el-rt-track"><option value="">No tracks yet</option></select></label>
        <div id="el-rt-empty" class="el-rt-empty"><p>Create a starting track, then map your input to filters and individual instruments.</p><button id="el-rt-create" class="el-button el-primary" type="button">Create your first track</button></div>
        <div class="el-rt-input-summary"><div><span class="el-small-mono">INPUT</span><p id="el-rt-source-note" class="el-help"></p></div><a href="#connections" class="el-button el-small">Connections</a><button id="el-rt-shared" class="el-button el-small" type="button" hidden>Use Connections input</button></div>
        <label class="el-label" data-advanced>Input override for this instrument<select id="el-rt-source"><option value="shared">Connections input</option><option value="replay">Replay this track's recording</option><option value="live">Separate RAPP WebSocket</option><option value="demo">Demo movement · simulated</option></select></label>
        <div id="el-rt-live" data-advanced hidden><label class="el-label">Override WebSocket address<input id="el-rt-address" value="ws://127.0.0.1:8765" type="url" spellcheck="false"></label><div class="el-export-row"><button id="el-rt-connect" class="el-button el-small" type="button">Connect override</button><button id="el-rt-disconnect" class="el-button el-small" type="button">Disconnect override</button></div><p id="el-rt-connection" class="el-help">Disconnected. Waiting for real data.</p></div>
        <div class="el-rt-transport"><button id="el-rt-play" class="el-button el-primary" type="button" disabled>Play reactive</button><button id="el-rt-stop" class="el-button" type="button" disabled>Stop</button></div>
        <p id="el-rt-starter" class="el-help">Choose a track to begin.</p>
        <div id="el-rt-downloads" class="el-export-row" data-advanced hidden><a id="el-rt-audio-download" class="el-button el-small" download>Download audio</a><a id="el-rt-export" class="el-button el-small">Export track & context</a></div>
        <p id="el-rt-track-context" class="el-help" data-advanced hidden></p>
      </div><div class="el-rt-monitor" aria-label="Reactive playback status">
        <div><span>Current track</span><b id="el-rt-current">Stopped</b></div><div><span>Next track</span><b id="el-rt-next">Automatic generation is off</b></div>
        <div><span>Input activity</span><b id="el-rt-activity">Waiting for data</b></div><div data-advanced><span>Playback</span><b id="el-rt-position">Ready when you are</b></div>
        <meter id="el-rt-meter" min="0" max="1" value="0" aria-label="Recent normalized activity"></meter>
      </div></div>
      <div class="el-rt-section-heading"><div><h3>Mappings</h3><p class="el-help">Combine inputs, choose the master mix or a stem, then choose a filter or effect.</p><p class="el-help" data-advanced>New mappings learn incoming ranges automatically. Use Freeze or enter bounds to keep a fixed range.</p></div><div class="el-export-row"><button id="el-rt-learn-all" class="el-button el-small" type="button">Auto-learn all</button><button id="el-rt-add" class="el-button el-small" type="button">Add mapping</button></div></div>
      <div id="el-rt-mappings" class="el-rt-mappings"></div>
      <details id="el-rt-upcoming" class="el-details" open><summary>Generate upcoming segments</summary>
        <label class="el-label">Input for new music<select id="el-rt-generation-input"><option value="all">Average of all mappings</option></select></label>
        <label class="el-check"><input id="el-rt-auto" type="checkbox">Generate upcoming music (uses credits)</label>
        <p class="el-help">New music follows recent input and includes stems. Both use credits. Stop prevents future requests; work already submitted can still finish.</p>
        <p class="el-help" data-advanced>The current audio loops if the next segment is late. One pipeline runs at a time. Leaving this view disarms future requests; failures require you to re-arm.</p>
        <div class="el-field-pair"><label class="el-label">Segment length<select id="el-rt-duration"><option value="20">20 seconds</option><option value="40">40 seconds</option><option value="60" selected>60 seconds</option></select></label><label class="el-label">Maximum new segments<input id="el-rt-budget" type="number" min="1" max="20" step="1" value="3"></label></div>
        <p id="el-rt-budget-note" class="el-help">0 / 3 new segments requested. Automatic generation is off.</p>
      </details>
      <section class="el-rt-stem-mixer" aria-labelledby="el-rt-stem-title"><div class="el-rt-section-heading"><div><h3 id="el-rt-stem-title">Stem mixer</h3><p class="el-help">Mute individual instruments or adjust their volume. Your mix continues across new segments.</p></div></div>
        <p id="el-rt-stem-status" class="el-help">Stems are prepared by default.</p><div id="el-rt-stems" class="el-rt-stems"></div>
        <details class="el-details" data-advanced><summary>Stem preparation</summary><p class="el-help">Stems are prepared by default. An older track's first play prepares missing stems using credits. Choose any stem in a mapping to apply its own filters and effects. Master controls apply to the combined mix.</p><button id="el-rt-separate" class="el-button el-small" type="button" disabled>Prepare stems now (uses credits)</button><button id="el-rt-use-stems" class="el-button el-small" type="button" hidden>Use saved stems · no credits</button></details>
      </section><p id="el-rt-notice" class="el-notice" role="status" aria-live="polite">Choose a track and press Play. Your mappings respond to input immediately.</p>
    </section>`;
    const settingsContainer = options.generationSettingsContainer;
    const upcoming = $("upcoming");
    if (settingsContainer) {
      root.querySelector(".el-rt-panel").insertBefore(settingsContainer, root.querySelector(".el-rt-section-heading"));
      const creation = settingsContainer.querySelector("[data-el-create-track]");
      if (creation) creation.before(upcoming); else settingsContainer.append(upcoming);
    } else if (root.querySelector(".el-rt-panel")?.insertBefore) {
      root.querySelector(".el-rt-panel").insertBefore(upcoming, root.querySelector(".el-rt-section-heading"));
    }
    state.sourceStarted = performance.now();
    state.mappings = [newMapping("cutoff"), newMapping("gain")];
    restoreSettings();
    bind();
    setSelection(getSelection?.() || {});
    renderMappings(); renderState();
  }
  function newSource(field = fields()[0]) {
    const source = { sourceKey: field?.key || "activity", reducer: field?.default_reducer || field?.reducers?.[0] || "mean", index: 0,
      rangeMode: "auto", inputMin: 0, inputMax: 1, learnedMin: null, learnedMax: null, weight: 1, autoSource: !field, awaitingBounds: true };
    useSourceBounds(source, field);
    return source;
  }
  function newMapping(target = "cutoff") {
    const definition = targetFor(target);
    return { id: Math.random().toString(36).slice(2), sources: [newSource()], operator: "direct", audioSource: "master",
      target, outputMin: definition.low, outputMax: definition.high, invert: false, smoothing: 0.15, normalized: null, value: null, mapped: null };
  }
  function allSources() { return state.mappings.flatMap((mapping) => mapping.sources); }
  function useSourceBounds(source, field, sample) {
    if (source.rangeMode !== "auto" || (!source.awaitingBounds && !sample)) return;
    const description = state.mode === "shared" ? bridge?.describe?.() : null;
    if (state.mode === "demo" || state.mode === "replay") { learnRange(source, 0, 1); source.awaitingBounds = false; return; }
    if (description?.mode !== "recording") return;
    const minimum = sample?.minimum ?? field?.inputMin ?? field?.minimum;
    const maximum = sample?.maximum ?? field?.inputMax ?? field?.maximum;
    if (finite(minimum) && finite(maximum) && maximum >= minimum) { source.learnedMin = minimum; source.learnedMax = maximum; source.inputMin = minimum; source.inputMax = maximum; source.recordedBounds = true; source.awaitingBounds = false; }
  }
  function discoverSources() {
    const available = fields();
    let changed = false;
    for (const source of allSources()) {
      if (source.autoSource && available.length) {
        const field = available[0];
        source.sourceKey = field.key; source.reducer = field.default_reducer || field.reducers?.[0] || "mean";
        source.autoSource = false; resetLearning(source); changed = true;
      }
      useSourceBounds(source, available.find((field) => field.key === source.sourceKey));
    }
    return changed;
  }
  function changeSource(mode) {
    disconnect(); state.mode = mode; state.points = []; state.sourceValid = false; state.sourceStarted = performance.now();
    state.fieldsKey = "";
    for (const mapping of state.mappings) { mapping.sources = mapping.sources.map(() => newSource()); mapping.normalized = null; }
    renderMappings(); renderState(); prepareSource(); remember();
  }
  function fields() {
    if (state.mode === "live") return state.stream?.fields || [];
    if (state.mode === "shared") return bridge?.describe?.()?.fields || [];
    if (state.mode === "demo") return [{ key: "activity", name: "Demo activity", reducers: ["value"] }, { key: "detail", name: "Demo detail", reducers: ["value"] }];
    const timeline = state.selection.analysis?.timeline;
    return timeline ? [{ key: "activity", name: "Combined activity", reducers: ["value"] }, ...Object.keys(timeline.channels || {}).map((key) => ({ key, name: key, reducers: ["value"] }))] : [];
  }
  function bind() {
    $("create").addEventListener("click", () => createTrack?.());
    $("shared").addEventListener("click", () => changeSource("shared"));
    $("track").addEventListener("change", () => { state.starterId = $("track").value || null; renderMappings(); renderState(); remember(); });
    $("play").addEventListener("click", () => start());
    $("stop").addEventListener("click", () => stop());
    $("source").addEventListener("change", () => changeSource($("source").value));
    $("connect").addEventListener("click", connect);
    $("disconnect").addEventListener("click", () => {
      disconnect(); state.armed = false; $("auto").checked = false;
      notice("Source disconnected. Automatic generation is off; an already submitted music-and-stems pipeline may still finish."); renderState();
    });
    $("add").addEventListener("click", () => { if (state.mappings.length < 16) { state.mappings.push(newMapping()); renderMappings(); prepareSource(); remember(); } });
    $("learn-all").addEventListener("click", () => {
      for (const source of allSources()) { source.rangeMode = "auto"; resetLearning(source); }
      for (const mapping of state.mappings) mapping.normalized = null;
      state.points = []; discoverSources(); prepareSource(); renderMappings(); remember(); notice("All mappings are learning fresh incoming ranges. Use Freeze to keep a range, or enter your own bounds.");
    });
    $("mappings").addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]"), row = button?.closest("[data-mapping]");
      if (!row) return;
      const mapping = state.mappings.find((item) => item.id === row.dataset.mapping), sourceIndex = Number(button.dataset.sourceIndex || 0), source = mapping.sources[sourceIndex];
      if (button.dataset.action === "remove" && state.mappings.length > 1) {
        const removedIndex = state.mappings.indexOf(mapping);
        if (state.generationInput === removedIndex) state.generationInput = "all";
        else if (Number.isInteger(state.generationInput) && state.generationInput > removedIndex) state.generationInput--;
        state.mappings = state.mappings.filter((item) => item !== mapping);
      }
      if (button.dataset.action === "add-input" && mapping.sources.length < 6) { mapping.sources.push(newSource()); if (mapping.operator === "direct") mapping.operator = "average"; }
      if (button.dataset.action === "remove-input" && mapping.sources.length > 1) { mapping.sources.splice(sourceIndex, 1); if (mapping.sources.length === 1) mapping.operator = "direct"; }
      if (button.dataset.action === "relearn") { source.rangeMode = "auto"; resetLearning(source); useSourceBounds(source, fields().find((field) => field.key === source.sourceKey)); }
      if (button.dataset.action === "freeze") {
        if (!finite(source.learnedMin) || !finite(source.learnedMax)) { notice("Wait for input before freezing, or enter a manual range.", true); return; }
        const padding = source.learnedMin === source.learnedMax ? Math.max(0.001, Math.abs(source.learnedMin) * 0.01) : 0;
        source.rangeMode = "fixed"; source.inputMin = source.learnedMin - padding; source.inputMax = source.learnedMax + padding;
      }
      mapping.normalized = null; state.points = []; renderMappings(); prepareSource(); remember();
    });
    $("mappings").addEventListener("change", (event) => {
      const input = event.target.closest("[data-property]"), row = input?.closest("[data-mapping]");
      if (!row) return;
      const mapping = state.mappings.find((item) => item.id === row.dataset.mapping), property = input.dataset.property;
      const source = input.dataset.sourceIndex !== undefined ? mapping.sources[Number(input.dataset.sourceIndex)] : null, destination = source || mapping;
      destination[property] = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
      if (property === "audioSource" && mapping.audioSource !== "master" && mapping.target === "rate") mapping.target = "cutoff";
      if (property === "target" || property === "audioSource") { const target = targetFor(mapping.target); mapping.outputMin = target.low; mapping.outputMax = target.high; }
      if (source && ["sourceKey", "reducer", "index"].includes(property)) {
        const field = fields().find((item) => item.key === source.sourceKey);
        if (property === "sourceKey") source.reducer = field?.default_reducer || field?.reducers?.[0] || "mean";
        source.autoSource = false; resetLearning(source); useSourceBounds(source, field);
      }
      if (source && property === "rangeMode" && source.rangeMode === "fixed" && source.inputMax <= source.inputMin) { const padding = Math.max(0.001, Math.abs(source.inputMin) * 0.01); source.inputMax = source.inputMin + padding; source.inputMin -= padding; }
      if (source && property === "rangeMode" && source.rangeMode === "auto") { resetLearning(source); useSourceBounds(source, fields().find((field) => field.key === source.sourceKey)); }
      if (source && ["inputMin", "inputMax"].includes(property)) { source.rangeMode = "fixed"; source.awaitingBounds = false; }
      mapping.normalized = null; state.points = [];
      renderMappings();
      if (["sourceKey", "reducer", "index", "rangeMode"].includes(property)) prepareSource();
      remember();
    });
    $("generation-input").addEventListener("change", () => {
      const value = $("generation-input").value;
      state.generationInput = value === "all" ? "all" : Number(value);
      state.points = []; renderState(); remember();
    });
    $("auto").addEventListener("change", () => {
      state.armed = $("auto").checked;
      notice(state.armed ? "Upcoming generation armed. Each new segment includes music and stem separation, both using credits, up to the displayed session limit." : "Automatic generation disarmed. An already submitted music-and-stems pipeline may still finish on the server.");
      renderState();
    });
    $("budget").addEventListener("change", () => { $("budget").value = String(budget()); renderState(); remember(); });
    $("duration").addEventListener("change", remember);
    $("address").addEventListener("change", remember);
    $("separate").addEventListener("click", separateStems);
    $("use-stems").addEventListener("click", async () => {
      const job = selectedTrack(); if (!job || !state.stems.has(job.id)) return;
      const updated = { ...job, stems: state.stems.get(job.id) }, run = state.run;
      if (state.running) {
        if (state.next || state.pending) return;
        state.next = updated; renderState(); updateStemMixer();
        try { await player.queueTrack(updated); if (run === state.run) notice("Saved stems will replace the full mix at the next loop boundary."); }
        catch (error) { if (run === state.run) { state.next = null; notice(error.message, true); } }
      } else { state.tracks.set(updated.id, updated); notice("Saved stems selected. Press Play reactive to hear and map them."); }
    });
    $("stems").addEventListener("input", (event) => {
      const name = event.target.dataset.stem, value = Number(event.target.value);
      if (!availableStemNames().includes(name) || !finite(value)) return;
      Object.defineProperty(state.stemMix, name, { value: clamp(value), enumerable: true, configurable: true, writable: true });
      retainMixPreferences(); updateStemMixer(); remember();
    });
    $("stems").addEventListener("click", (event) => {
      const button = event.target.closest("[data-stem-mute]"), name = button?.dataset.stemMute;
      if (!availableStemNames().includes(name)) return;
      if (state.mutedStems.has(name)) state.mutedStems.delete(name); else state.mutedStems.add(name);
      retainMixPreferences(); updateStemMixer(); remember();
    });
  }
  function renderMappings() {
    const openDetails = new Set([...(root.querySelectorAll?.("[data-detail][open]") || [])].map((node) => node.dataset.detail));
    const available = fields(), names = availableStemNames();
    state.fieldsKey = JSON.stringify(available.map((field) => [field.key, field.name]));
    $("mappings").innerHTML = state.mappings.map((mapping, index) => {
      const target = targetFor(mapping.target), unavailable = mapping.audioSource !== "master" && !names.includes(mapping.audioSource);
      const input = (label, property, value, attributes = "", sourceIndex = null) => `<label class="el-label">${label}<input type="number" data-property="${property}" ${sourceIndex === null ? "" : `data-source-index="${sourceIndex}"`} value="${value}" step="any" ${attributes}></label>`;
      const sources = mapping.sources.map((source, sourceIndex) => {
        const field = available.find((item) => item.key === source.sourceKey), reducers = field?.reducers || ["mean", "rms", "minimum", "maximum", "index"];
        const options = available.map((item) => `<option value="${escapeHTML(item.key)}" ${item.key === source.sourceKey ? "selected" : ""}>${escapeHTML(item.channelName ? `${item.channelName} / ${item.name}` : item.optionLabel || item.name || item.key)}</option>`).join("");
        return `<div class="el-rt-input-row"><label class="el-label">Input ${sourceIndex + 1}<select data-property="sourceKey" data-source-index="${sourceIndex}">${!field ? `<option value="${escapeHTML(source.sourceKey)}">${available.length ? "Choose a source field" : "Waiting for source fields"}</option>` : ""}${options}</select></label><div class="el-rt-range"><span id="el-rt-range-${mapping.id}-${sourceIndex}" class="el-help">${rangeLabel(source)}</span><button class="el-button el-small" type="button" data-action="${source.rangeMode === "auto" ? "freeze" : "relearn"}" data-source-index="${sourceIndex}">${source.rangeMode === "auto" ? "Freeze" : "Auto-learn"}</button>${mapping.sources.length > 1 ? `<button class="el-button el-small" type="button" data-action="remove-input" data-source-index="${sourceIndex}" aria-label="Remove input ${sourceIndex + 1}">×</button>` : ""}</div><details class="el-rt-input-details" data-detail="${mapping.id}-input-${sourceIndex}" ${openDetails.has(`${mapping.id}-input-${sourceIndex}`) ? "open" : ""}><summary>Adjust input range</summary><div class="el-rt-map-settings"><label class="el-label">Range<select data-property="rangeMode" data-source-index="${sourceIndex}"><option value="auto" ${source.rangeMode === "auto" ? "selected" : ""}>Auto-learn</option><option value="fixed" ${source.rangeMode === "fixed" ? "selected" : ""}>Manual / frozen</option></select></label>${input("Input minimum", "inputMin", source.inputMin, "", sourceIndex)}${input("Input maximum", "inputMax", source.inputMax, "", sourceIndex)}${mapping.operator === "weighted" ? input("Weight", "weight", source.weight, 'min="0" max="100"', sourceIndex) : ""}<label class="el-label" data-advanced>Array reducer<select data-property="reducer" data-source-index="${sourceIndex}">${reducers.map((id) => `<option value="${id}" ${id === source.reducer ? "selected" : ""}>${id}</option>`).join("")}</select></label><div data-advanced>${input("Array index", "index", source.index, 'min="0" max="262143"', sourceIndex)}</div></div><button class="el-button el-small" type="button" data-action="relearn" data-source-index="${sourceIndex}">Relearn range</button></details></div>`;
      }).join("");
      const targets = Object.keys(TARGETS).filter((id) => mapping.audioSource === "master" || id !== "rate");
      return `<div class="el-rt-mapping" data-mapping="${mapping.id}"><div class="el-rt-map-title"><b>Mapping ${index + 1}</b><output id="el-rt-value-${mapping.id}" class="el-rt-map-value">${unavailable ? "Stem unavailable" : "Waiting for input"}</output><button class="el-button el-small" type="button" data-action="remove" ${state.mappings.length <= 1 ? "disabled" : ""} aria-label="Remove mapping ${index + 1}">Remove</button></div><div class="el-rt-map-main"><div class="el-rt-map-inputs">${sources}<div class="el-rt-combine"><button class="el-button el-small" type="button" data-action="add-input" ${mapping.sources.length >= 6 ? "disabled" : ""}>Combine input</button>${mapping.sources.length > 1 ? `<label class="el-label">Combine using<select data-property="operator">${Object.entries(OPERATORS).filter(([id]) => id !== "direct").map(([id, label]) => `<option value="${id}" ${id === mapping.operator ? "selected" : ""}>${label}</option>`).join("")}</select></label>` : ""}</div></div><span class="el-rt-arrow" aria-hidden="true">→</span><label class="el-label">Audio source<select data-property="audioSource"><option value="master" ${mapping.audioSource === "master" ? "selected" : ""}>Master · all audio</option>${unavailable ? `<option value="${escapeHTML(mapping.audioSource)}" selected>${escapeHTML(mapping.audioSource)} · unavailable</option>` : ""}${names.map((name) => `<option value="${escapeHTML(name)}" ${name === mapping.audioSource ? "selected" : ""}>${escapeHTML(name)} stem</option>`).join("")}</select></label><span class="el-rt-arrow" aria-hidden="true">→</span><label class="el-label">Filter / effect<select data-property="target">${targets.map((id) => `<option value="${id}" ${id === mapping.target ? "selected" : ""}>${escapeHTML(TARGETS[id].label)}</option>`).join("")}</select></label></div><details class="el-rt-map-details" data-detail="${mapping.id}-output" ${openDetails.has(`${mapping.id}-output`) ? "open" : ""}><summary>Adjust output range & response</summary><div class="el-rt-map-settings">${input("Output minimum", "outputMin", mapping.outputMin, `min="${target.min}" max="${target.max}"`)}${input("Output maximum", "outputMax", mapping.outputMax, `min="${target.min}" max="${target.max}"`)}${input("Smoothing · seconds", "smoothing", mapping.smoothing, 'min="0" max="5"')}<label class="el-check"><input type="checkbox" data-property="invert" ${mapping.invert ? "checked" : ""}>Invert combined input</label></div><p class="el-help">${target.logarithmic ? "Frequency uses a logarithmic scale. " : ""}Each input learns its own range before combining. Later mappings win when the same audio source and effect repeat.</p></details></div>`;
    }).join("");
    $("add").disabled = state.mappings.length >= 16;
  }
  function rangeLabel(source) {
    if (source.rangeMode === "auto" && !finite(source.learnedMin)) return "Auto-learning · waiting for data";
    return `${source.rangeMode === "auto" ? "Learning" : "Fixed"}: ${Number(source.inputMin).toPrecision(4)} – ${Number(source.inputMax).toPrecision(4)}`;
  }
  function starterTrack() { return state.tracks.get(state.starterId) || state.tracks.get(state.selection.currentJob?.id) || state.selection.currentJob; }
  function selectedTrack() { return state.running && player?.currentTrack ? player.currentTrack : starterTrack(); }
  function availableStemNames() { return state.stems.get(selectedTrack()?.id)?.map((stem) => stem.name) || (state.running ? player?.stemNames || [] : []); }
  function retainMixPreferences() {
    const names = [...new Set([...availableStemNames(), ...state.mutedStems, ...Object.keys(state.stemMix)])].slice(0, MAX_MIX_NAMES);
    state.stemMix = Object.fromEntries(names.filter((name) => Object.prototype.hasOwnProperty.call(state.stemMix, name)).map((name) => [name, state.stemMix[name]]));
    state.mutedStems = new Set(names.filter((name) => state.mutedStems.has(name)));
  }
  function stemVolume(name) { return finite(state.stemMix[name]) ? state.stemMix[name] : 1; }
  function effectiveStemGains() {
    // During a crossfade both decks must retain their mix. Prepared next-track
    // names are included before that deck starts, so it cannot briefly unmute.
    const names = [...new Set([...(player?.playingStemNames || player?.stemNames || []), ...availableStemNames(),
      ...(state.next?.stems || []).map((stem) => stem.name), ...state.mutedStems, ...Object.keys(state.stemMix)])].slice(0, 12);
    return Object.fromEntries(names.map((name) => [name, state.mutedStems.has(name) ? 0 : stemVolume(name)]));
  }
  function updateStemMixer() {
    if (state.running) player?.updateControls({ stemGains: effectiveStemGains() }, state.sourceValid);
    for (const row of $("stems").querySelectorAll?.("[data-stem-row]") || []) {
      const name = row.dataset.stemRow, muted = state.mutedStems.has(name), volume = stemVolume(name);
      const button = row.querySelector("[data-stem-mute]");
      row.classList.toggle("is-muted", muted);
      button.setAttribute("aria-pressed", String(muted));
      button.textContent = muted ? "Unmute" : "Mute";
      button.setAttribute("aria-label", `${muted ? "Unmute" : "Mute"} ${name} stem`);
      row.querySelector("output").textContent = `${Math.round(volume * 100)}%${muted ? " · muted" : ""}`;
    }
  }
  function stemResult(track) {
    const result = state.stemResults.get(track?.id) || track?.stem_separation;
    return result?.state === "not_requested" ? null : result;
  }
  function rememberStems(id, result) {
    if (!result) return;
    state.stemResults.set(id, result);
    const track = state.tracks.get(id);
    if (track) state.tracks.set(id, { ...track, stem_separation: result });
    if (result.state === "complete" && result.stems?.length) state.stems.set(id, result.stems);
  }
  function budget() { return Math.round(clamp(Number($("budget").value) || 3, 1, 20)); }
  function lookahead() { return Math.max(12, state.latency * 1.35 + 5); }
  function renderState() {
    if (!root) return;
    if (state.generationInput !== "all" && !state.mappings[state.generationInput]) state.generationInput = "all";
    const generationKey = state.mappings.map((mapping) => mapping.sources.map((source) => source.sourceKey).join(" + ")).join("|");
    if (state.generationKey !== generationKey) {
      state.generationKey = generationKey;
      $("generation-input").innerHTML = `<option value="all">Average of all mappings</option>${state.mappings.map((mapping, index) => `<option value="${index}">Mapping ${index + 1} · ${escapeHTML(mapping.sources.map((source) => fields().find((field) => field.key === source.sourceKey)?.name || source.sourceKey).join(" + ").slice(0, 100))}</option>`).join("")}`;
    }
    $("generation-input").value = String(state.generationInput);
    const track = selectedTrack(), ready = track?.state === "complete" || Boolean(track?.audio_url);
    const starters = [...state.tracks.values()].filter((job) => job.state === "complete" || job.audio_url);
    const starterKey = starters.map((job) => job.id).join("|");
    if (state.starterKey !== starterKey) {
      state.starterKey = starterKey;
      $("track").innerHTML = starters.length ? starters.map((job, index) => `<option value="${escapeHTML(job.id)}">${job.realtime ? "Continued track" : "Saved track"} ${starters.length - index}${job.audio?.duration_seconds ? ` · ${Math.round(job.audio.duration_seconds)} s` : ""} · ${escapeHTML(job.id.slice(0, 6))}</option>`).join("") : '<option value="">No tracks yet</option>';
    }
    $("track").value = starterTrack()?.id || "";
    $("track").disabled = state.running || state.starting;
    $("empty").hidden = starters.length > 0;
    $("play").disabled = !ready || state.running || state.starting || Boolean(state.stemPending);
    $("stop").disabled = !state.running && !state.starting && !state.stemPending;
    const separation = stemResult(track), hasStems = state.stems.has(track?.id);
    const needsSeparation = ready && !hasStems && !separation;
    $("play").textContent = needsSeparation ? "Play & prepare stems · uses credits" : "Play";
    $("starter").textContent = ready ? needsSeparation ? "First play prepares this track's stems using credits." : "Playback and mappings use no additional credits." : "Create a track to begin.";
    $("downloads").hidden = !ready;
    if (ready) {
      $("audio-download").href = track.audio_url || `${API}/generations/${encodeURIComponent(track.id)}/audio`;
      $("export").href = track.export_url || `${API}/generations/${encodeURIComponent(track.id)}/export`;
    }
    $("track-context").hidden = !track?.realtime;
    $("track-context").textContent = track?.realtime ? `Generated from recent activity to guide the next segment. ${track.realtime.conditioning_applied ? "Earlier music was included as musical context." : "This segment was generated independently."} Live controls continue responding to your current data.` : "";
    $("source").value = state.mode; $("live").hidden = state.mode !== "live";
    const replayOption = $("source").querySelector?.('option[value="replay"]');
    if (replayOption) {
      replayOption.disabled = !state.selection.analysis;
      replayOption.textContent = state.selection.analysis ? "Replay this track's recording" : "Track recording · unavailable";
    }
    const description = state.mode === "shared" ? bridge?.describe?.() : null;
    $("source-note").textContent = state.mode === "replay" ? state.selection.analysis ? "Override: this track's recording · replay" : "This track has no recording to replay. Choose Connections input." : state.mode === "demo" ? "Override: simulated demo movement" : state.mode === "shared" ? description?.label || "Choose an input in Connections" : "Override: separate RAPP WebSocket";
    $("shared").hidden = state.mode === "shared" || !bridge;
    $("current").textContent = state.starting ? "Loading saved audio…" : state.running ? `${player?.currentTrack?.id?.slice(0, 12) || "Saved track"}${player?.stemNames?.length ? " · stems" : " · full mix"}` : "Stopped";
    $("next").textContent = state.pending ? `Generating ${state.pending.id?.slice(0, 10) || "next segment"}…` : state.next ? `Ready · ${state.next.id.slice(0, 12)}` : state.armed ? (state.used >= budget() ? "Session limit reached" : "Waiting for fresh data / lookahead") : "Automatic generation is off";
    $("budget-note").textContent = `${state.used} / ${budget()} new segments requested. ${state.armed ? "Automatic generation is on." : "Automatic generation is off."}`;
    $("separate").disabled = !needsSeparation || Boolean(state.stemPending || state.pending);
    $("stem-status").textContent = hasStems ? `${state.stems.get(track.id).length} stems ready.${state.running && !player?.stemNames?.length ? " Your mix will apply when stems replace the full track at the next loop." : " Mute overrides volume mappings; unmute restores your mix."}`
      : separation && !["queued", "generating", "separating"].includes(separation.state) ? `Stem separation ${separation.state}. ${typeof separation.error === "string" ? separation.error : "The full mix remains available; no automatic retry will be made."}`
      : separation || state.stemPending?.id === track?.id ? "Preparing stems. The full mix remains playable; saved stems will be used when ready."
      : ready ? "Stems will be prepared on first play, using credits once for this track." : "Generate a starting track to get individual stem controls.";
    $("use-stems").hidden = !state.stems.has(track?.id) || Boolean(state.running && player?.stemNames?.length);
    $("use-stems").disabled = Boolean(state.running && (state.pending || state.next));
    const names = availableStemNames();
    if ($( "stems").dataset.track !== `${track?.id}:${names.join("|")}`) {
      $("stems").dataset.track = `${track?.id}:${names.join("|")}`;
      $("stems").innerHTML = names.map((name) => {
        const muted = state.mutedStems.has(name), volume = stemVolume(name);
        return `<div class="el-rt-stem-row${muted ? " is-muted" : ""}" data-stem-row="${escapeHTML(name)}"><div class="el-rt-stem-heading"><span>${escapeHTML(name)}</span><button class="el-button el-small" type="button" data-stem-mute="${escapeHTML(name)}" aria-pressed="${muted}" aria-label="${muted ? "Unmute" : "Mute"} ${escapeHTML(name)} stem">${muted ? "Unmute" : "Mute"}</button></div><div class="el-rt-stem-volume"><input data-stem="${escapeHTML(name)}" type="range" min="0" max="1" step="0.01" value="${volume}" aria-label="${escapeHTML(name)} stem volume"><output>${Math.round(volume * 100)}%${muted ? " · muted" : ""}</output></div></div>`;
      }).join("");
    }
  }
  function setSelection(selection) {
    // Building a new plan temporarily clears currentJob. Keep the last chosen
    // job across that gap, while ordinary refreshes preserve a manual starter.
    const previousId = state.selectionJobId;
    state.selection = selection || {};
    for (const job of [...(selection?.jobs || []), selection?.currentJob].filter(Boolean)) {
      state.tracks.set(job.id, job);
      if (job.stem_separation) rememberStems(job.id, job.stem_separation);
      const stems = Array.isArray(job.stems) ? job.stems : job.stem_separation?.state === "complete" ? job.stem_separation.stems : null;
      if (Array.isArray(stems) && stems.length) state.stems.set(job.id, stems);
    }
    if (selection?.currentJob?.id && (!state.starterId || (previousId && previousId !== selection.currentJob.id))) state.starterId = selection.currentJob.id;
    if (selection?.currentJob?.id) state.selectionJobId = selection.currentJob.id;
    if (!state.initialized) return;
    renderMappings(); renderState(); remember();
  }
  function activate() {
    if (!state.initialized) return;
    state.active = true;
    discoverSources(); renderMappings(); prepareSource();
    if (!state.timer) state.timer = setInterval(tick, 50);
    tick();
  }
  function deactivate() {
    if (!state.initialized) return;
    state.active = false; stop();
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }
  async function start() {
    if (state.running || state.starting || state.stemPending) return;
    const track = starterTrack();
    if (!track || (track.state !== "complete" && !track.audio_url)) return;
    if (!globalThis.HydraElevenPlayer?.Player) { notice("The reactive audio player is unavailable. Reload this page.", true); return; }
    const run = ++state.run;
    discoverSources();
    pauseOriginal?.();
    state.starting = true; state.used = 0; state.sequence = 0; state.points = [];
    state.session = globalThis.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    state.sourceStarted = performance.now();
    player?.dispose();
    const sessionPlayer = player = new globalThis.HydraElevenPlayer.Player({ onTransition: (next) => {
      if (run !== state.run) return;
      state.next = null; renderMappings(); renderState();
      notice(`Now playing ${next.id.slice(0, 12)}. Live mappings continue across the transition.`);
    } });
    renderState();
    try {
      // Seed the post-effects gains before the player constructs its first
      // deck. Opening the input gate must never expose a muted stem at unity.
      sessionPlayer.updateControls({ stemGains: effectiveStemGains() }, true);
      sessionPlayer.setSourceValid(false);
      const load = sessionPlayer.loadTrack({ ...track, audio_url: track.audio_url || `${API}/generations/${encodeURIComponent(track.id)}/audio`, stems: state.stems.get(track.id) || track.stems });
      // Resume inside the user gesture before awaiting network/decode work.
      const unlock = sessionPlayer.resume();
      await Promise.all([load, unlock, state.mode === "shared" ? bridge?.prepare?.(allSources()) : undefined]);
      if (run !== state.run) return;
      if (state.mode === "shared") for (const source of allSources()) useSourceBounds(source, fields().find((field) => field.key === source.sourceKey), bridge?.bounds?.(source) || bridge?.read?.(source, performance.now()));
      bridge?.reset?.(performance.now());
      state.sourceStarted = performance.now();
      sessionPlayer.setSourceValid(false);
      await sessionPlayer.start();
      if (run !== state.run) return;
      state.running = true; state.starting = false;
      // Reserve the pipeline before tick can submit another generation.
      if (!state.stems.has(track.id)) preparePlayingStems(track, run);
      tick(); renderMappings(); renderState();
      notice(sessionPlayer.warnings?.length ? sessionPlayer.warnings.join(" ") : "Reactive playback started. The selected source now controls the audio; missing or stale data fades it safely.");
    } catch (error) {
      if (run !== state.run) return;
      stop(false); notice(`Could not start playback: ${error.message}`, true);
    }
  }
  async function prepareSource() {
    if (state.mode !== "shared") return;
    if (!fields().length) return;
    try {
      await bridge?.prepare?.(allSources()); bridge?.reset?.(performance.now());
      for (const source of allSources()) useSourceBounds(source, fields().find((field) => field.key === source.sourceKey), bridge?.bounds?.(source) || bridge?.read?.(source, performance.now()));
      remember();
      renderMappings();
    }
    catch (error) { notice(`Could not prepare Connections input: ${error.message}`, true); }
  }
  function stop(showNotice = true) {
    const pending = Boolean(state.pending || state.stemPending);
    state.run++; state.running = false; state.starting = false; state.armed = false; state.pending = null; state.stemPending = null; state.next = null;
    if (root) $("auto").checked = false;
    player?.stop(); disconnect(); renderState();
    if (showNotice) notice(pending ? "Stopped. An already submitted music-and-stems pipeline may still finish and use credits. No additional tracks will be requested." : "Stopped. Automatic generation is off.");
  }
  function connect() {
    disconnect();
    try {
      const address = new URL($("address").value);
      if (!["ws:", "wss:"].includes(address.protocol)) throw new Error("Use a ws:// or wss:// address.");
      if (!globalThis.HydraLive?.Stream) throw new Error("The live source parser is unavailable.");
      const socket = new WebSocket(address.href); state.ws = socket; state.stream = new globalThis.HydraLive.Stream();
      $("connection").textContent = "Connecting…";
      socket.onopen = () => { if (state.ws === socket) $("connection").textContent = "Connected. Waiting for numeric fields…"; };
      socket.onmessage = (event) => {
        if (state.ws !== socket || typeof event.data !== "string" || event.data.length > 4 * 1024 * 1024) return;
        try {
          const discovered = state.stream.ingest(JSON.parse(event.data), performance.now());
          if (discovered) {
            discoverSources();
            renderMappings();
          }
          $("connection").textContent = `Connected · ${state.stream.frames} frames · ${state.stream.fields.length} fields`;
        } catch (_) { $("connection").textContent = "Received invalid JSON; waiting for valid numeric frames."; }
      };
      socket.onerror = () => { if (state.ws === socket) $("connection").textContent = "Connection error. Check the bridge address and that it is running."; };
      socket.onclose = () => {
        if (state.ws !== socket) return;
        state.ws = null; state.stream = null; state.sourceValid = false; state.armed = false; $("auto").checked = false;
        $("connection").textContent = "Disconnected. Audio will fade; no automatic reconnect. Automatic generation is off.";
        renderState();
      };
    } catch (error) { notice(error.message, true); }
  }
  function disconnect() {
    const socket = state.ws; state.ws = null; state.stream = null;
    if (socket) { socket.onclose = null; socket.onmessage = null; socket.close(); }
    if (root) $("connection").textContent = "Disconnected. Waiting for real data.";
  }
  function read(mapping, now) {
    if (state.mode === "demo") {
      const t = (now - state.sourceStarted) / 1000;
      return { value: mapping.sourceKey === "detail" ? (Math.sin(t * 1.3) + 1) / 2 : (Math.sin(t * 0.29 - Math.PI / 2) + 1) / 2, at: now };
    }
    if (state.mode === "replay") return { value: replayValue(state.selection.analysis, mapping.sourceKey, (now - state.sourceStarted) / 1000), at: now };
    if (state.mode === "live") return state.ws?.readyState === 1 ? state.stream?.read(mapping, now, 3000) : null;
    return bridge?.read?.(mapping, now);
  }
  function tick() {
    if (!root || !state.active) return;
    const now = performance.now(), norms = [], controls = { cutoff: 20000, resonance: 0.7, highpass: 20, gain: 0.8,
      pan: 0, rate: 1, delayMix: 0, reverbMix: 0, stemGains: effectiveStemGains(), stemControls: {} };
    if (discoverSources()) { renderMappings(); prepareSource(); remember(); }
    for (const mapping of state.mappings) {
      const values = mapping.sources.map((source) => {
        let sample;
        try { sample = read(source, now); } catch (_) { sample = null; }
        return normalizeSource(source, sample, now);
      });
      let normalized = combineInputs(values, mapping.sources, mapping.operator);
      mapping.value = normalized;
      if (normalized === null) { mapping.mapped = null; mapping.normalized = null; mapping.activity = null; continue; }
      if (mapping.invert) normalized = 1 - normalized;
      mapping.activity = normalized;
      const smoothing = clamp(mapping.smoothing || 0, 0, 5), alpha = smoothing > 0 ? 1 - Math.exp(-0.05 / smoothing) : 1;
      mapping.normalized = finite(mapping.normalized) ? mapping.normalized + alpha * (normalized - mapping.normalized) : normalized;
      mapping.mapped = mapValue(mapping.normalized, mapping);
      if (!finite(mapping.mapped)) continue;
      norms.push(normalized); routeControl(controls, mapping, mapping.mapped);
    }
    state.sourceValid = norms.length === state.mappings.length && norms.length > 0;
    const activity = state.sourceValid ? state.generationInput === "all" ? norms.reduce((sum, value) => sum + value, 0) / norms.length : state.mappings[state.generationInput]?.activity ?? null : null;
    state.points.push({ at: now, value: activity });
    state.points = state.points.filter((point) => point.at >= now - 10000);
    if (state.running) player.updateControls(controls, state.sourceValid);
    const features = summarize(state.points, now);
    if (shouldGenerate({ running: state.running, armed: state.armed, pending: state.pending || state.stemPending, queued: state.next || player?.queuedTrack,
      used: state.used, budget: budget(), sourceValid: state.sourceValid, features, remaining: player?.remainingSeconds, lookahead: lookahead() })) generateNext(features);
    if (now - state.lastRender < 250) return;
    state.lastRender = now;
    const fieldKey = JSON.stringify(fields().map((field) => [field.key, field.name]));
    if (state.fieldsKey !== fieldKey) renderMappings();
    for (const mapping of state.mappings) {
      const output = $(`value-${mapping.id}`);
      const stemUnavailable = mapping.audioSource !== "master" && !availableStemNames().includes(mapping.audioSource);
      mapping.sources.forEach((source, index) => {
        const range = $(`range-${mapping.id}-${index}`); if (range) range.textContent = rangeLabel(source);
        if (source.rangeMode === "auto" && root.querySelectorAll) for (const property of ["inputMin", "inputMax"]) {
          const input = root.querySelector(`[data-mapping="${mapping.id}"] [data-source-index="${index}"][data-property="${property}"]`);
          if (input && input !== globalThis.document?.activeElement) input.value = String(source[property]);
        }
      });
      if (output) output.textContent = stemUnavailable ? "Stem unavailable" : finite(mapping.mapped) ? `${mapping.value.toFixed(3)} → ${mapping.mapped.toFixed(mapping.target.includes("pass") || mapping.target === "cutoff" ? 0 : 2)}` : "Waiting for input";
    }
    $("activity").textContent = state.sourceValid && features ? `${Math.round(features.activity * 100)}%` : state.running ? "Missing input · audio fading" : "Waiting for input";
    $("meter").value = features?.activity || 0;
    $("position").textContent = state.running ? `${(player.currentPosition || 0).toFixed(1)} s · ${Math.max(0, player.remainingSeconds || 0).toFixed(1)} s to loop / transition${state.pending ? " · current track loops if late" : ""}` : "Ready when you are";
    renderState();
  }
  function disarm(error) { state.armed = false; $("auto").checked = false; notice(error, true); renderState(); }
  async function generateNext(features) {
    const run = state.run, selected = state.selection.plan, track = player?.currentTrack;
    const planId = track?.plan_id || selected?.id;
    if (!planId) { disarm("Build or reopen a plan before arming upcoming music."); return; }
    let generationSettings;
    try { generationSettings = getGenerationSettings?.(); }
    catch (error) { disarm(error.message || "Review the settings for upcoming music."); return; }
    state.used++; state.pending = { started: performance.now() };
    const sequence = state.sequence++;
    renderState();
    try {
      const job = await api("/continuations", { plan_id: planId, source_job_id: track?.id,
        duration_seconds: Number($("duration").value), ...(generationSettings ? { settings: generationSettings } : {}), features: { ...features, source: state.mode }, session_id: state.session, sequence });
      if (run !== state.run) return;
      state.pending.id = job.id;
      const started = state.pending.started;
      let result = job;
      while (["queued", "generating"].includes(result.state)) {
        if (performance.now() - started > 240000) throw new Error("Generation is taking longer than 4 minutes; its outcome is unknown. It may still use credits. Automatic generation is off.");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (run !== state.run) return;
        result = await api(`/generations/${encodeURIComponent(job.id)}`);
      }
      if (run !== state.run) return;
      if (result.state !== "complete" || !result.audio_url) throw new Error(`Upcoming generation ${result.state || "failed"}. ${typeof result.error === "string" ? result.error : result.error?.message || "Inspect saved generations for details."} Automatic generation is off; no retry was made.`);
      state.tracks.set(result.id, result);
      if (result.stem_separation) rememberStems(result.id, result.stem_separation);
      state.latency = result.generation_latency_seconds || Math.max(1, (performance.now() - started) / 1000);
      let nextTrack = result, stemError = null;
      // The server queues separation with every new generation. Reuse and wait
      // for that operation; older servers may need one deduplicated submission.
      if (stemResult(result) || (state.armed && state.sourceValid)) {
        try {
          const separation = await requestStems(result.id, run, state.armed && state.sourceValid);
          if (run !== state.run) return;
          state.stems.set(result.id, separation.stems);
          nextTrack = { ...result, stems: separation.stems };
        } catch (error) {
          if (run !== state.run) return;
          stemError = `Upcoming stem separation failed: ${error.message} The saved full mix is queued. Automatic generation is off.`;
          disarm(stemError);
        }
      }
      if (run !== state.run) return;
      // Look ahead far enough for the complete generation and separation pipeline.
      state.latency = Math.max(state.latency, (performance.now() - started) / 1000);
      state.next = nextTrack;
      updateStemMixer();
      await player.queueTrack(nextTrack);
      if (run !== state.run) return;
      state.pending = null;
      notice(stemError || `Next ${Number($("duration").value)}-second segment ready · ${nextTrack.stems?.length ? "stems" : "full mix"}. It will crossfade near the current loop's end.`, Boolean(stemError));
      renderState();
    } catch (error) {
      if (run !== state.run) return;
      state.pending = null; state.next = null; disarm(error.message);
    }
  }
  async function requestStems(id, run, allowCreate = true) {
    const checkRun = () => { if (run !== state.run) throw new Error("Playback stopped while separation was pending."); };
    checkRun();
    if (state.stems.has(id)) return { state: "complete", stems: state.stems.get(id) };
    const path = `/generations/${encodeURIComponent(id)}/stems`;
    let result = stemResult(state.tracks.get(id));
    if (!result) {
      // Inspect durable status first: a refreshed client may not know that a
      // previous play or another tab already submitted the paid operation.
      try { result = await api(path); }
      catch (error) { if (error.status !== 404) throw error; }
      checkRun();
      if (result?.state === "not_requested") result = null;
      if (!result) {
        if (!allowCreate) throw new Error("Stem preparation paused; no new separation request was submitted.");
        // Preserve an uncertain POST outcome locally until server metadata can
        // resolve it. Stopping/replaying must never silently retry a paid call.
        rememberStems(id, { state: "unknown", error: "The separation request outcome is unresolved; no automatic retry was made." });
        result = await api(path, { stem_variation_id: "six_stems_v1" });
      }
      rememberStems(id, result);
      checkRun();
    }
    const started = performance.now();
    while (["queued", "generating", "separating"].includes(result.state)) {
      if (performance.now() - started > 240000) throw new Error("Stem separation is still unresolved. It may have used credits; no retry was made.");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      checkRun();
      result = await api(path);
      rememberStems(id, result);
      checkRun();
    }
    rememberStems(id, result);
    if (result.state !== "complete" || !result.stems?.length) throw new Error(typeof result.error === "string" ? result.error : "The full track is still available; no automatic retry was made.");
    return result;
  }
  async function preparePlayingStems(track, run) {
    if (state.stemPending || state.stems.has(track.id)) return;
    const operation = { id: track.id, run };
    state.stemPending = operation; renderState();
    try {
      const result = await requestStems(track.id, run);
      if (run !== state.run || !state.running || player.currentTrack?.id !== track.id) return;
      const updated = { ...track, stem_separation: result, stems: result.stems };
      state.tracks.set(track.id, updated);
      if (!state.next && !state.pending) {
        state.next = updated;
        updateStemMixer();
        await player.queueTrack(updated);
        if (run !== state.run) return;
        notice("Stems are ready and will replace the full mix at the next loop boundary. Individual stem filters, effects and volume mappings are available.");
      }
      renderMappings();
    } catch (error) {
      if (run === state.run) disarm(`Stem separation unavailable: ${error.message} The saved full mix keeps playing.`);
    } finally {
      if (state.stemPending === operation) { state.stemPending = null; renderState(); }
    }
  }
  async function separateStems() {
    const track = selectedTrack();
    if (!track || state.stemPending || state.pending || state.stems.has(track.id) || stemResult(track)) return;
    if (state.running) return preparePlayingStems(track, state.run);
    const operation = { id: track.id, run: state.run };
    state.stemPending = operation; renderState();
    try {
      const result = await requestStems(track.id, operation.run);
      if (operation.run !== state.run) return;
      state.stems.set(track.id, result.stems);
      renderMappings();
    } catch (error) { if (operation.run === state.run) notice(error.message, true); }
    finally { if (state.stemPending === operation) { state.stemPending = null; renderState(); } }
  }
  return { init, setSelection, activate, deactivate, stop, normalize, mapValue, summarize, replayValue, shouldGenerate, validateSettings, validateSource, normalizeSource, combineInputs, routeControl, resetLearning, learnRange, TARGETS };
})();
