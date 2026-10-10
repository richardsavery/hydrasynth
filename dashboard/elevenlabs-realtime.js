"use strict";

// Local audio controls run independently of the slower, explicitly armed paid requests.
globalThis.HydraElevenRealtime = (() => {
  const API = "/api/elevenlabs";
  const STORAGE_KEY = "hydra.elevenlabs.realtime.v1";
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
  function validateSettings(value) {
    const saved = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const result = { mode: ["replay", "shared", "live", "demo"].includes(saved.mode) ? saved.mode : "replay",
      address: "ws://127.0.0.1:8765", duration: [20, 40, 60].includes(saved.duration) ? saved.duration : 60,
      budget: finite(saved.budget) ? Math.round(clamp(saved.budget, 1, 20)) : 3,
      starterId: typeof saved.starterId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(saved.starterId) ? saved.starterId : null, mappings: [] };
    if (typeof saved.address === "string" && saved.address.length <= 2048) {
      try { const url = new URL(saved.address); if (["ws:", "wss:"].includes(url.protocol)) result.address = url.href; } catch (_) { /* Keep the default address. */ }
    }
    for (const mapping of (Array.isArray(saved.mappings) ? saved.mappings : []).slice(0, 6)) {
      if (!mapping || typeof mapping !== "object") continue;
      const target = typeof mapping.target === "string" && (Object.prototype.hasOwnProperty.call(TARGETS, mapping.target) || /^stem:[^\x00-\x1f]{1,100}$/.test(mapping.target)) ? mapping.target : "cutoff";
      const definition = targetFor(target);
      let inputMin = finite(mapping.inputMin) ? clamp(mapping.inputMin, -1e12, 1e12) : 0;
      let inputMax = finite(mapping.inputMax) ? clamp(mapping.inputMax, -1e12, 1e12) : 1;
      if (inputMax <= inputMin) { inputMin = 0; inputMax = 1; }
      result.mappings.push({ sourceKey: typeof mapping.sourceKey === "string" && mapping.sourceKey.length > 0 && mapping.sourceKey.length <= 1024 ? mapping.sourceKey : "activity",
        reducer: ["value", "mean", "rms", "minimum", "maximum", "index"].includes(mapping.reducer) ? mapping.reducer : "mean",
        index: finite(mapping.index) ? Math.round(clamp(mapping.index, 0, 262143)) : 0, rangeMode: "fixed", inputMin, inputMax, target,
        outputMin: finite(mapping.outputMin) ? clamp(mapping.outputMin, definition.min, definition.max) : definition.low,
        outputMax: finite(mapping.outputMax) ? clamp(mapping.outputMax, definition.min, definition.max) : definition.high,
        invert: mapping.invert === true, smoothing: finite(mapping.smoothing) ? clamp(mapping.smoothing, 0, 5) : 0.15 });
    }
    return result;
  }
  const state = { initialized: false, active: false, running: false, starting: false, selection: {}, mappings: [],
    mode: "replay", sourceStarted: 0, points: [], sourceValid: false, timer: null, fieldsKey: "", run: 0,
    armed: false, used: 0, session: "", sequence: 0, pending: null, next: null, latency: 40,
    calibration: null, ws: null, stream: null, stemPending: null, stems: new Map(), stemResults: new Map(), stemMix: {}, lastRender: 0,
    tracks: new Map(), starterId: null, starterKey: "", stemMixTrackId: null };
  let root, bridge, getSelection, pauseOriginal, player;
  const $ = (id) => root.querySelector(`#el-rt-${id}`);
  function targetFor(id) { return TARGETS[id] || { label: `Stem · ${id.slice(5)}`, min: 0, max: 1, low: 0, high: 1 }; }
  function notice(text, error = false) { if (!root) return; $("notice").textContent = text; $("notice").classList.toggle("is-error", error); }
  function remember() {
    if (!root) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(validateSettings({ mode: state.mode, address: $("address").value,
      duration: Number($("duration").value), budget: budget(), starterId: state.starterId, mappings: state.mappings }))); }
    catch (_) { /* Playback and server artifacts remain available without browser storage. */ }
  }
  function restoreSettings() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch (_) { saved = {}; }
    const settings = validateSettings(saved);
    state.mode = settings.mode; state.starterId = settings.starterId;
    $("address").value = settings.address; $("duration").value = String(settings.duration); $("budget").value = String(settings.budget);
    if (settings.mappings.length) state.mappings = settings.mappings.map((mapping) => ({ ...mapping,
      id: Math.random().toString(36).slice(2), normalized: null, value: null, mapped: null }));
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
    root = options.container; bridge = options.sourceBridge; getSelection = options.getSelection; pauseOriginal = options.pauseOriginal;
    state.initialized = true;
    root.classList.add("el-realtime");
    root.innerHTML = `<section class="el-panel el-rt-panel" aria-labelledby="el-rt-title">
      <div class="el-panel-title el-panel-title-row"><div><span class="eyebrow">LIVE DATA → REACTIVE AUDIO</span><h2 id="el-rt-title">Play now. Shape what comes next.</h2></div><span id="el-rt-badge" class="el-badge">LOCAL AUDIO · 20 Hz</span></div>
      <p class="el-help">Start with a saved track below. Your data changes its filters, volume, stereo position, speed and effects immediately. Optional upcoming music follows the last 10 seconds of activity and crossfades in when ready.</p>
      <div class="el-rt-grid"><div class="el-rt-source">
        <label class="el-label">Saved starter track<select id="el-rt-track"><option value="">Select a saved generation below</option></select></label>
        <label class="el-label">Control source<select id="el-rt-source"><option value="replay">Replay this recording</option><option value="shared">SignalLab source</option><option value="live">RAPP / player WebSocket</option><option value="demo">Demo movement · simulated</option></select></label>
        <p id="el-rt-source-note" class="el-help"></p>
        <div id="el-rt-live" hidden><label class="el-label">WebSocket address<input id="el-rt-address" value="ws://127.0.0.1:8765" type="url" spellcheck="false"></label><div class="el-export-row"><button id="el-rt-connect" class="el-button el-small" type="button">Connect source</button><button id="el-rt-disconnect" class="el-button el-small" type="button">Disconnect</button></div><p id="el-rt-connection" class="el-help">Disconnected. Waiting for real data.</p></div>
        <div class="el-rt-transport"><button id="el-rt-play" class="el-button el-primary" type="button" disabled>Play reactive</button><button id="el-rt-stop" class="el-button" type="button" disabled>Stop</button></div>
        <p id="el-rt-starter" class="el-help">Select a saved, completed generation below.</p>
        <div id="el-rt-downloads" class="el-export-row" hidden><a id="el-rt-audio-download" class="el-button el-small" download>Download audio</a><a id="el-rt-export" class="el-button el-small">Export track & context</a></div>
        <p id="el-rt-track-context" class="el-help" hidden></p>
      </div><div class="el-rt-monitor" aria-label="Reactive playback status">
        <div><span>Current track</span><b id="el-rt-current">Stopped</b></div><div><span>Next track</span><b id="el-rt-next">Automatic generation is off</b></div>
        <div><span>Recent activity</span><b id="el-rt-activity">Waiting for data</b></div><div><span>Playback</span><b id="el-rt-position">Ready when you are</b></div>
        <meter id="el-rt-meter" min="0" max="1" value="0" aria-label="Recent normalized activity"></meter>
      </div></div>
      <div class="el-rt-section-heading"><div><h3>Live mappings</h3><p class="el-help">Input bounds stay fixed. Out-of-range values clamp to the nearest bound. Calibrate captures 5 seconds, then freezes the measured range. Later rows win if targets repeat.</p></div><button id="el-rt-add" class="el-button el-small" type="button">Add mapping</button></div>
      <div id="el-rt-mappings" class="el-rt-mappings"></div>
      <details class="el-details" open><summary>Upcoming music</summary>
        <label class="el-check"><input id="el-rt-auto" type="checkbox">Generate upcoming music automatically (uses credits)</label>
        <p class="el-help">Every new track is automatically separated into instrument stems. Generation and stem separation both use credits. Saved stems are reused.</p>
        <p class="el-help">One music-and-stems pipeline at a time, with a fixed session limit. The current audio loops if the next segment is late. Stop or leaving this tab disarms future requests; an already submitted music-and-stems pipeline may still finish and use credits. Failures require you to re-arm.</p>
        <div class="el-field-pair"><label class="el-label">Next segment length<select id="el-rt-duration"><option value="20">20 seconds</option><option value="40">40 seconds</option><option value="60" selected>60 seconds</option></select></label><label class="el-label">New segments allowed this session<input id="el-rt-budget" type="number" min="1" max="20" step="1" value="3"></label></div>
        <p id="el-rt-budget-note" class="el-help">0 / 3 new segments requested. Automatic generation is off.</p>
      </details>
      <details class="el-details"><summary>Stem mixer</summary><p class="el-help">Stems are prepared by default for individual volume mappings. Playing an older track without stems starts its separation once, using credits. The full mix plays while stems are prepared, then switches at a loop boundary. Filters and effects apply to the combined mix.</p>
        <button id="el-rt-separate" class="el-button el-small" type="button" disabled>Prepare stems now (uses credits)</button><button id="el-rt-use-stems" class="el-button el-small" type="button" hidden>Use saved stems · no credits</button><p id="el-rt-stem-status" class="el-help">Stems are prepared by default.</p><div id="el-rt-stems" class="el-rt-stems"></div>
      </details><p id="el-rt-notice" class="el-notice" role="status" aria-live="polite">Select a saved track, then press Play reactive. Stem separation uses credits once per track; live controls and saved stems use no credits.</p>
    </section>`;
    state.sourceStarted = performance.now();
    state.mappings = [newMapping("cutoff"), newMapping("gain")];
    restoreSettings();
    bind();
    setSelection(getSelection?.() || {});
    renderMappings(); renderState();
  }
  function newMapping(target = "cutoff") {
    const definition = targetFor(target);
    return { id: Math.random().toString(36).slice(2), sourceKey: fields()[0]?.key || "activity", reducer: "mean", index: 0,
      rangeMode: "fixed", inputMin: 0, inputMax: 1, target, outputMin: definition.low, outputMax: definition.high,
      invert: false, smoothing: 0.15, normalized: null, value: null, mapped: null };
  }
  function fields() {
    if (state.mode === "live") return state.stream?.fields || [];
    if (state.mode === "shared") return bridge?.describe?.()?.fields || [];
    if (state.mode === "demo") return [{ key: "activity", name: "Demo activity", reducers: ["value"] }, { key: "detail", name: "Demo detail", reducers: ["value"] }];
    const timeline = state.selection.analysis?.timeline;
    return timeline ? [{ key: "activity", name: "Combined activity", reducers: ["value"] }, ...Object.keys(timeline.channels || {}).map((key) => ({ key, name: key, reducers: ["value"] }))] : [];
  }
  function bind() {
    $("track").addEventListener("change", () => { state.starterId = $("track").value || null; renderMappings(); renderState(); remember(); });
    $("play").addEventListener("click", () => start());
    $("stop").addEventListener("click", () => stop());
    $("source").addEventListener("change", () => {
      disconnect(); state.mode = $("source").value; state.points = []; state.sourceValid = false; state.sourceStarted = performance.now();
      state.fieldsKey = ""; state.calibration = null;
      for (const mapping of state.mappings) { mapping.sourceKey = fields()[0]?.key || "activity"; mapping.inputMin = 0; mapping.inputMax = 1; mapping.normalized = null; mapping.reducer = fields()[0]?.default_reducer || "mean"; }
      renderMappings(); renderState(); prepareSource(); remember();
    });
    $("connect").addEventListener("click", connect);
    $("disconnect").addEventListener("click", () => {
      disconnect(); state.armed = false; $("auto").checked = false;
      notice("Source disconnected. Automatic generation is off; an already submitted music-and-stems pipeline may still finish."); renderState();
    });
    $("add").addEventListener("click", () => { if (state.mappings.length < 6) { state.mappings.push(newMapping()); renderMappings(); prepareSource(); remember(); } });
    $("mappings").addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove]"), calibrate = event.target.closest("[data-calibrate]");
      if (remove && state.mappings.length > 1) { state.mappings = state.mappings.filter((row) => row.id !== remove.dataset.remove); state.points = []; renderMappings(); remember(); }
      if (calibrate) { state.calibration = { id: calibrate.dataset.calibrate, until: performance.now() + 5000, values: [] }; notice("Capturing this source for 5 seconds; the resulting input bounds will then stay fixed."); }
    });
    $("mappings").addEventListener("change", (event) => {
      const input = event.target.closest("[data-property]"), row = input?.closest("[data-mapping]");
      if (!row) return;
      const mapping = state.mappings.find((item) => item.id === row.dataset.mapping), property = input.dataset.property;
      mapping[property] = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
      if (property === "target") { const target = targetFor(mapping.target); mapping.outputMin = target.low; mapping.outputMax = target.high; }
      if (property === "sourceKey") { const field = fields().find((item) => item.key === mapping.sourceKey); mapping.reducer = field?.default_reducer || field?.reducers?.[0] || "mean"; }
      mapping.normalized = null; state.points = []; state.calibration = null;
      renderMappings();
      if (["sourceKey", "reducer", "index"].includes(property)) prepareSource();
      remember();
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
        state.next = updated; renderState();
        try { await player.queueTrack(updated); if (run === state.run) notice("Saved stems will replace the full mix at the next loop boundary."); }
        catch (error) { if (run === state.run) { state.next = null; notice(error.message, true); } }
      } else { state.tracks.set(updated.id, updated); notice("Saved stems selected. Press Play reactive to hear and map them."); }
    });
    $("stems").addEventListener("input", (event) => { const name = event.target.dataset.stem; if (name) state.stemMix[name] = clamp(Number(event.target.value)); });
  }
  function renderMappings() {
    const available = fields(), names = availableStemNames();
    state.fieldsKey = JSON.stringify(available.map((field) => [field.key, field.name]));
    $("mappings").innerHTML = state.mappings.map((mapping, index) => {
      const field = available.find((item) => item.key === mapping.sourceKey), target = targetFor(mapping.target);
      const reducers = field?.reducers || ["mean", "rms", "minimum", "maximum", "index"];
      const options = available.map((item) => `<option value="${escapeHTML(item.key)}" ${item.key === mapping.sourceKey ? "selected" : ""}>${escapeHTML(item.channelName ? `${item.channelName} / ${item.name}` : item.optionLabel || item.name || item.key)}</option>`).join("");
      const input = (label, property, value, attributes = "") => `<label class="el-label">${label}<input type="number" data-property="${property}" value="${value}" step="any" ${attributes}></label>`;
      const targets = [...Object.keys(TARGETS), ...names.map((name) => `stem:${name}`)];
      const unavailable = !targets.includes(mapping.target);
      return `<div class="el-rt-mapping" data-mapping="${mapping.id}"><div class="el-rt-map-main"><label class="el-label">${index + 1}. Source<select data-property="sourceKey">${!field ? `<option value="${escapeHTML(mapping.sourceKey)}">${available.length ? "Choose a source field" : "Waiting for source fields"}</option>` : ""}${options}</select></label><label class="el-label">Audio control<select data-property="target">${unavailable ? `<option value="${escapeHTML(mapping.target)}" selected>${escapeHTML(target.label)} · unavailable</option>` : ""}${targets.map((id) => `<option value="${escapeHTML(id)}" ${id === mapping.target ? "selected" : ""}>${escapeHTML(targetFor(id).label)}</option>`).join("")}</select></label><output id="el-rt-value-${mapping.id}" class="el-rt-map-value">${unavailable ? "Stem unavailable" : "Waiting"}</output><button class="el-button el-small" type="button" data-remove="${mapping.id}" ${state.mappings.length <= 1 ? "disabled" : ""} aria-label="Remove mapping ${index + 1}">Remove</button></div>
        <details class="el-rt-map-details"><summary>Bounds, reducer & smoothing</summary><div class="el-rt-map-settings">
          ${input("Input minimum", "inputMin", mapping.inputMin)}${input("Input maximum", "inputMax", mapping.inputMax)}
          <label class="el-label">Array reducer<select data-property="reducer">${reducers.map((id) => `<option value="${id}" ${id === mapping.reducer ? "selected" : ""}>${id}</option>`).join("")}</select></label>${input("Array index", "index", mapping.index, 'min="0"')}
          ${input("Output minimum", "outputMin", mapping.outputMin, `min="${target.min}" max="${target.max}"`)}${input("Output maximum", "outputMax", mapping.outputMax, `min="${target.min}" max="${target.max}"`)}${input("Smoothing · seconds", "smoothing", mapping.smoothing, 'min="0" max="5"')}
          <label class="el-check"><input type="checkbox" data-property="invert" ${mapping.invert ? "checked" : ""}>Invert input</label>
        </div><button class="el-button el-small" type="button" data-calibrate="${mapping.id}">Calibrate 5 s, then freeze</button><span class="el-help"> ${target.logarithmic ? "Frequency uses a logarithmic scale." : "Output uses a linear scale."}</span></details></div>`;
    }).join("");
    $("add").disabled = state.mappings.length >= 6;
  }
  function starterTrack() { return state.tracks.get(state.starterId) || state.tracks.get(state.selection.currentJob?.id) || state.selection.currentJob; }
  function selectedTrack() { return state.running && player?.currentTrack ? player.currentTrack : starterTrack(); }
  function availableStemNames() { return state.stems.get(selectedTrack()?.id)?.map((stem) => stem.name) || (state.running ? player?.stemNames || [] : []); }
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
    const track = selectedTrack(), ready = track?.state === "complete" || Boolean(track?.audio_url);
    if (state.stemMixTrackId !== track?.id) { state.stemMixTrackId = track?.id; state.stemMix = {}; }
    const starters = [...state.tracks.values()].filter((job) => job.state === "complete" || job.audio_url);
    const starterKey = starters.map((job) => job.id).join("|");
    if (state.starterKey !== starterKey) {
      state.starterKey = starterKey;
      $("track").innerHTML = starters.length ? starters.map((job) => `<option value="${escapeHTML(job.id)}">${escapeHTML(job.id.slice(0, 12))}${job.realtime ? " · live continuation" : " · saved generation"}${job.audio?.duration_seconds ? ` · ${Math.round(job.audio.duration_seconds)} s` : ""}</option>`).join("") : '<option value="">Select a saved generation below</option>';
    }
    $("track").value = starterTrack()?.id || "";
    $("track").disabled = state.running || state.starting;
    $("play").disabled = !ready || state.running || state.starting || Boolean(state.stemPending);
    $("stop").disabled = !state.running && !state.starting && !state.stemPending;
    const separation = stemResult(track), hasStems = state.stems.has(track?.id);
    const needsSeparation = ready && !hasStems && !separation;
    $("play").textContent = needsSeparation ? "Play reactive · prepares stems (uses credits)" : "Play reactive · no new credits";
    $("starter").textContent = ready ? `${state.running ? "Playing" : "Starter"}: ${track.id.slice(0, 12)} · saved audio. ${needsSeparation ? "First play also prepares stems using credits." : "Playback and live effects use no additional credits."}` : "Select a saved, completed generation below, or generate your first track.";
    $("downloads").hidden = !ready;
    if (ready) {
      $("audio-download").href = track.audio_url || `${API}/generations/${encodeURIComponent(track.id)}/audio`;
      $("export").href = track.export_url || `${API}/generations/${encodeURIComponent(track.id)}/export`;
    }
    $("track-context").hidden = !track?.realtime;
    $("track-context").textContent = track?.realtime ? `Generated from recent activity to guide the next segment. ${track.realtime.conditioning_applied ? "Earlier music was included as musical context." : "This segment was generated independently."} Live controls continue responding to your current data.` : "";
    $("source").value = state.mode; $("live").hidden = state.mode !== "live";
    const description = state.mode === "shared" ? bridge?.describe?.() : null;
    $("source-note").textContent = state.mode === "replay" ? "Loops the recording's normalized timeline, preserving missing-data gaps." : state.mode === "demo" ? "Simulated movement for auditioning the mappings. This is not live sensor data." : state.mode === "shared" ? `Uses ${description?.label || "the selected SignalLab source"}. Configure that source in the main workspace.` : "Numeric RAPP or player.py frames feed the mappings. A source older than 3 seconds fades the audio and pauses upcoming requests.";
    $("current").textContent = state.starting ? "Loading saved audio…" : state.running ? `${player?.currentTrack?.id?.slice(0, 12) || "Saved track"}${player?.stemNames?.length ? " · stems" : " · full mix"}` : "Stopped";
    $("next").textContent = state.pending ? `Generating ${state.pending.id?.slice(0, 10) || "next segment"}…` : state.next ? `Ready · ${state.next.id.slice(0, 12)}` : state.armed ? (state.used >= budget() ? "Session limit reached" : "Waiting for fresh data / lookahead") : "Automatic generation is off";
    $("budget-note").textContent = `${state.used} / ${budget()} new segments requested. ${state.armed ? `Lookahead ≈ ${Math.ceil(lookahead())} s, adjusted to observed generation time.` : "Automatic generation is off."}`;
    $("separate").disabled = !needsSeparation || Boolean(state.stemPending || state.pending);
    $("stem-status").textContent = hasStems ? `${state.stems.get(track.id).length} stems saved. Map individual stem volumes under Live mappings.`
      : separation && !["queued", "generating", "separating"].includes(separation.state) ? `Stem separation ${separation.state}. ${typeof separation.error === "string" ? separation.error : "The full mix remains available; no automatic retry will be made."}`
      : separation || state.stemPending?.id === track?.id ? "Preparing stems. The full mix remains playable; saved stems will be used when ready."
      : "Stems will be prepared on first play, using credits once for this track.";
    $("use-stems").hidden = !state.stems.has(track?.id) || Boolean(state.running && player?.stemNames?.length);
    $("use-stems").disabled = Boolean(state.running && (state.pending || state.next));
    const names = availableStemNames();
    if ($( "stems").dataset.track !== `${track?.id}:${names.join("|")}`) {
      $("stems").dataset.track = `${track?.id}:${names.join("|")}`;
      $("stems").innerHTML = names.map((name) => `<label class="el-label">${escapeHTML(name)}<input data-stem="${escapeHTML(name)}" type="range" min="0" max="1" step="0.01" value="${state.stemMix[name] ?? 1}" aria-label="${escapeHTML(name)} stem volume"></label>`).join("");
    }
  }
  function setSelection(selection) {
    const previousId = state.selection.currentJob?.id;
    state.selection = selection || {};
    for (const job of [...(selection?.jobs || []), selection?.currentJob].filter(Boolean)) {
      state.tracks.set(job.id, job);
      if (job.stem_separation) rememberStems(job.id, job.stem_separation);
      const stems = Array.isArray(job.stems) ? job.stems : job.stem_separation?.state === "complete" ? job.stem_separation.stems : null;
      if (Array.isArray(stems) && stems.length) state.stems.set(job.id, stems);
    }
    if (selection?.currentJob?.id && (!state.starterId || (previousId && previousId !== selection.currentJob.id))) state.starterId = selection.currentJob.id;
    if (!state.initialized) return;
    renderMappings(); renderState(); remember();
  }
  function activate() {
    if (!state.initialized) return;
    state.active = true;
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
    pauseOriginal?.();
    state.starting = true; state.used = 0; state.sequence = 0; state.points = [];
    state.session = globalThis.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    state.sourceStarted = performance.now();
    player?.dispose();
    const sessionPlayer = player = new globalThis.HydraElevenPlayer.Player({ onTransition: (next) => {
      if (run !== state.run) return;
      state.next = null; state.stemMix = {}; renderMappings(); renderState();
      notice(`Now playing ${next.id.slice(0, 12)}. Live mappings continue across the transition.`);
    } });
    renderState();
    try {
      const load = sessionPlayer.loadTrack({ ...track, audio_url: track.audio_url || `${API}/generations/${encodeURIComponent(track.id)}/audio`, stems: state.stems.get(track.id) || track.stems });
      // Resume inside the user gesture before awaiting network/decode work.
      const unlock = sessionPlayer.resume();
      await Promise.all([load, unlock, state.mode === "shared" ? bridge?.prepare?.(state.mappings) : undefined]);
      if (run !== state.run) return;
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
    try { await bridge?.prepare?.(state.mappings); bridge?.reset?.(performance.now()); }
    catch (error) { notice(`Could not prepare SignalLab source: ${error.message}`, true); }
  }
  function stop(showNotice = true) {
    const pending = Boolean(state.pending || state.stemPending);
    state.run++; state.running = false; state.starting = false; state.armed = false; state.pending = null; state.stemPending = null; state.next = null; state.calibration = null;
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
            for (const mapping of state.mappings) if (!state.stream.fields.some((field) => field.key === mapping.sourceKey)) mapping.sourceKey = state.stream.fields[0]?.key || mapping.sourceKey;
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
      pan: 0, rate: 1, delayMix: 0, reverbMix: 0, stemGains: { ...state.stemMix } };
    for (const mapping of state.mappings) {
      let sample;
      try { sample = read(mapping, now); } catch (_) { sample = null; }
      const valid = sample && finite(sample.value) && (!finite(sample.at) || now - sample.at <= 3000);
      const normalized = valid ? normalize(sample.value, mapping.inputMin, mapping.inputMax, mapping.invert) : null;
      mapping.value = valid ? sample.value : null;
      if (state.calibration?.id === mapping.id && valid) state.calibration.values.push(sample.value);
      if (normalized === null) { mapping.mapped = null; mapping.normalized = null; continue; }
      const smoothing = clamp(mapping.smoothing || 0, 0, 5), alpha = smoothing > 0 ? 1 - Math.exp(-0.05 / smoothing) : 1;
      mapping.normalized = finite(mapping.normalized) ? mapping.normalized + alpha * (normalized - mapping.normalized) : normalized;
      mapping.mapped = mapValue(mapping.normalized, mapping);
      if (!finite(mapping.mapped)) continue;
      norms.push(normalized);
      if (mapping.target.startsWith("stem:")) controls.stemGains[mapping.target.slice(5)] = mapping.mapped;
      else controls[mapping.target] = mapping.mapped;
    }
    state.sourceValid = norms.length === state.mappings.length && norms.length > 0;
    const activity = state.sourceValid ? norms.reduce((sum, value) => sum + value, 0) / norms.length : null;
    state.points.push({ at: now, value: activity });
    state.points = state.points.filter((point) => point.at >= now - 10000);
    if (state.running) player.updateControls(controls, state.sourceValid);
    if (state.calibration && now >= state.calibration.until) {
      const { id, values } = state.calibration, mapping = state.mappings.find((item) => item.id === id);
      state.calibration = null;
      const low = Math.min(...values), high = Math.max(...values);
      if (mapping && values.length >= 2 && high > low) { mapping.inputMin = low; mapping.inputMax = high; mapping.normalized = null; state.points = []; renderMappings(); remember(); notice(`Calibration frozen: ${low.toPrecision(4)} to ${high.toPrecision(4)}. These bounds will not drift during playback.`); }
      else notice("Calibration needs changing, valid values. Previous fixed bounds were retained.", true);
    }
    const features = summarize(state.points, now);
    if (shouldGenerate({ running: state.running, armed: state.armed, pending: state.pending || state.stemPending, queued: state.next || player?.queuedTrack,
      used: state.used, budget: budget(), sourceValid: state.sourceValid, features, remaining: player?.remainingSeconds, lookahead: lookahead() })) generateNext(features);
    if (now - state.lastRender < 250) return;
    state.lastRender = now;
    const fieldKey = JSON.stringify(fields().map((field) => [field.key, field.name]));
    if (state.fieldsKey !== fieldKey) renderMappings();
    for (const mapping of state.mappings) {
      const output = $(`value-${mapping.id}`);
      if (output) output.textContent = mapping.target.startsWith("stem:") && !player?.stemNames?.includes(mapping.target.slice(5)) ? "Stem unavailable · no effect" : finite(mapping.mapped) ? `${mapping.value.toFixed(3)} → ${mapping.mapped.toFixed(mapping.target.includes("pass") || mapping.target === "cutoff" ? 0 : 2)}` : "Missing / invalid";
    }
    $("activity").textContent = state.sourceValid && features ? `${Math.round(features.activity * 100)}% · variability ${Math.round(features.variability * 100)}%` : "Missing / stale · audio fading";
    $("meter").value = features?.activity || 0;
    $("position").textContent = state.running ? `${(player.currentPosition || 0).toFixed(1)} s · ${Math.max(0, player.remainingSeconds || 0).toFixed(1)} s to loop / transition${state.pending ? " · current track loops if late" : ""}` : "Ready when you are";
    renderState();
  }
  function disarm(error) { state.armed = false; $("auto").checked = false; notice(error, true); renderState(); }
  async function generateNext(features) {
    const run = state.run, selected = state.selection.plan, track = player?.currentTrack;
    const planId = track?.plan_id || selected?.id;
    if (!planId) { disarm("Build or reopen a plan before arming upcoming music."); return; }
    state.used++; state.pending = { started: performance.now() };
    const sequence = state.sequence++;
    renderState();
    try {
      const job = await api("/continuations", { plan_id: planId, source_job_id: track?.id,
        duration_seconds: Number($("duration").value), features: { ...features, source: state.mode }, session_id: state.session, sequence });
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
        await player.queueTrack(updated);
        if (run !== state.run) return;
        notice("Stems are ready and will replace the full mix at the next loop boundary. Individual stem volume mappings are available.");
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
  return { init, setSelection, activate, deactivate, stop, normalize, mapValue, summarize, replayValue, shouldGenerate, validateSettings, TARGETS };
})();
