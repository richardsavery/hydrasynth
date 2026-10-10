"use strict";

// Recorded planning and a realtime generated-audio instrument share this workspace.
globalThis.HydraElevenLabs = (() => {
  const API = "/api/elevenlabs";
  const STORAGE_KEY = "hydra.elevenlabs.workspace.v1";
  const ACTIVE_STATES = new Set(["queued", "generating"]);
  const state = { initialized: false, loaded: false, active: false, dataset: null, analysis: null,
    plan: null, jobs: [], plans: [], currentJob: null, status: null, busy: false,
    dirty: false, requestDirty: false, baseline: null, timer: null, playbackFrame: null };
  let root;
  const $ = (id) => root.querySelector(`#el-${id}`);
  const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const number = (value, digits = 2) => Number.isFinite(Number(value)) && value !== null ? Number(value).toFixed(digits) : "—";
  const seconds = (value) => `${number(value, 1)} s`;
  const localDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Saved plan" : new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium", timeStyle: "short"
    }).format(date);
  };
  const list = (value) => Array.isArray(value) ? value : [];
  const message = (value) => typeof value === "string" ? value : value?.message || JSON.stringify(value);
  const sectionAt = (sections, time) => sections.findIndex((section, index) => time >= section.audio_start &&
    (time < section.audio_end || (index === sections.length - 1 && time === section.audio_end)));
  const matchesPlan = (job, plan) => Boolean(plan && (job.plan_id === plan.id || (plan.cache_key && job.cache_key === plan.cache_key)));
  const hasPendingWork = (job) => ACTIVE_STATES.has(job.state) || ACTIVE_STATES.has(job.stem_separation?.state);
  const canGenerate = ({ plan, dirty, requestDirty, busy, status, jobs }) => Boolean(plan?.can_generate && !dirty && !requestDirty && !busy &&
    (jobs.some((job) => matchesPlan(job, plan)) || (status?.ready && !jobs.some(hasPendingWork))));

  async function api(path, body) {
    const response = await fetch(`${API}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error(`The local server returned an unreadable response (${response.status}).`); }
    if (!response.ok) throw new Error(message(data.error || data.detail || data.message || `Request failed (${response.status}).`));
    return data;
  }

  function remember() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ planId: state.plan?.id, jobId: state.currentJob?.id, baseline: state.baseline })); } catch (_) { /* Server persistence still works without browser storage. */ }
  }
  function remembered() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch (_) { return {}; } }
  function notice(text, error = false) {
    $("notice").textContent = text;
    $("notice").classList.toggle("is-error", error);
  }
  function busy(value) {
    state.busy = value;
    $("settings").disabled = value;
    $("file").disabled = value;
    $("synthetic").disabled = value;
    $("saved-plan").disabled = value;
    $("save-request").disabled = value || !state.requestDirty;
    updateActions();
  }
  async function task(action) {
    if (state.busy) return;
    busy(true);
    try { await action(); } catch (error) { notice(error.message, true); }
    finally { busy(false); }
  }

  const selection = () => ({ plan: state.plan, currentJob: state.currentJob,
    analysis: state.analysis, status: state.status, jobs: state.jobs });
  const syncRealtime = () => globalThis.HydraElevenRealtime?.setSelection(selection());

  function init({ sourceBridge } = {}) {
    if (state.initialized) return;
    root = document.getElementById("elevenlabs-workspace");
    if (!root) return;
    state.initialized = true;
    root.classList.add("el-workspace");
    root.innerHTML = `
      <header class="el-heading">
        <div><span class="eyebrow">DATA → GENERATED MUSIC → LIVE CONTROL</span><h1>ElevenLabs <span>sonification</span></h1>
          <p>Play generated music as a live instrument. Map data to its sound, and prepare upcoming music in the background.</p></div>
        <span class="el-badge">MUSIC V2.5</span>
      </header>
      <p id="el-notice" class="el-notice" role="status" aria-live="polite">Import a recording or try the 60-second example. Building a plan is free.</p>
      <div id="el-realtime"></div>
      <div class="el-layout">
        <aside class="el-controls" aria-label="Recording and mapping settings">
          <section class="el-panel">
            <div class="el-panel-title"><span class="eyebrow">01 / IMPORT</span><h2>Your recording</h2></div>
            <label class="el-file-label" for="el-file">Import CSV or flat JSONL<input id="el-file" type="file" accept=".csv,.jsonl,.ndjson,text/csv,application/x-ndjson"></label>
            <button id="el-synthetic" class="el-button el-secondary" type="button">Try a 60-second example</button>
            <p class="el-help">Alternating low and high movement, with fixed 0–1 bounds. No generation credits are used.</p>
            <div id="el-dataset" class="el-source-summary">No recording selected.</div>
            <label class="el-label el-saved-label">Reopen a saved plan<select id="el-saved-plan"><option value="">No saved plans</option></select></label>
          </section>
          <form id="el-form">
            <fieldset id="el-settings" class="el-settings" disabled>
              <section class="el-panel">
                <div class="el-panel-title"><span class="eyebrow">02 / PREPARE</span><h2>Time & channels</h2></div>
                <div class="el-field-pair"><label class="el-label">Timestamp column<select id="el-timestamp" required></select></label>
                  <label class="el-label">Timestamp units<select id="el-units"><option value="seconds">Seconds</option><option value="milliseconds">Milliseconds</option><option value="microseconds">Microseconds</option></select></label></div>
                <p class="el-help">Select numeric channels and their meaning. Position uses speed; velocity uses magnitude. Generic scalar keeps its value.</p>
                <div id="el-channels" class="el-channels"></div>
                <label class="el-check"><input id="el-reuse-baseline" type="checkbox">Reuse saved normalization bounds</label>
                <p id="el-baseline-note" class="el-help">Leave bounds blank to fit the 5th–95th percentiles once. Fixed bounds take precedence.</p>
                <details class="el-details"><summary>Selection & sampling</summary>
                  <div class="el-field-pair"><label class="el-label">Start · seconds<input id="el-start" type="number" min="0" step="any" value="0" required></label>
                    <label class="el-label">End · seconds<input id="el-end" type="number" min="0" step="any" placeholder="First 60 s or full length"></label></div>
                  <div class="el-field-pair"><label class="el-label">Window · seconds<input id="el-window" type="number" min="3" max="120" step="any" value="10" required></label>
                    <label class="el-label">Sample rate · Hz<input id="el-rate" type="number" min="1" max="200" step="any" value="10" required></label></div>
                  <label class="el-label">Maximum interpolation gap · seconds<input id="el-gap" type="number" min="0" step="any" placeholder="Auto: ≥0.5 s or 3 input intervals"></label>
                  <p class="el-help">Time starts at the first source timestamp. Sections need at least 90% valid coverage. Missing data remains missing.</p>
                </details>
              </section>
              <section class="el-panel">
                <div class="el-panel-title"><span class="eyebrow">03 / MAP</span><h2>Musical direction</h2></div>
                <div class="el-mapping-rule"><b>Activity → density</b><span>Low: sparse · medium: regular pulse · high: dense</span></div>
                <label class="el-check"><input id="el-variability" type="checkbox">Variability → articulation</label>
                <p class="el-help">Start with activity alone. Bands: low &lt;0.33, medium &lt;0.67, high ≥0.67.</p>
                <label class="el-label">Style · English<input id="el-style" type="text" value="instrumental electronic music" maxlength="300" required></label>
                <div class="el-field-pair"><label class="el-label">Requested BPM<input id="el-bpm" type="number" min="20" max="300" value="100" required></label>
                  <label class="el-label">Requested key<input id="el-key" type="text" value="D minor" maxlength="80" required></label></div>
                <label class="el-label">Instrument palette · comma separated<textarea id="el-palette" rows="2">warm synthesizer tones, soft electronic percussion</textarea></label>
                <details class="el-details"><summary>Continuity & reproducibility</summary>
                  <label class="el-label">Context adherence<select id="el-context"><option value="high">High · preserve continuity</option><option value="medium">Medium</option><option value="low">Low · stronger variation</option></select></label>
                  <label class="el-label">Optional seed<input id="el-seed" type="number" min="0" max="2147483647" step="1" placeholder="Provider chooses"></label>
                  <p class="el-help">BPM, key and instrumentation are requested musical directions. A seed does not guarantee an identical result.</p>
                </details>
                <button id="el-build" class="el-button el-primary" type="submit">Build & inspect plan <span>Free</span></button>
              </section>
            </fieldset>
          </form>
        </aside>
        <div class="el-results">
          <section class="el-panel el-plot-panel" aria-labelledby="el-plot-title">
            <div class="el-panel-title el-panel-title-row"><div><span class="eyebrow">DATA / NORMALIZED MOVEMENT</span><h2 id="el-plot-title">From signal to sections</h2></div><span id="el-duration" class="el-small-mono">—</span></div>
            <div class="el-chart-wrap"><canvas id="el-chart" height="210" role="img" aria-label="Normalized movement plot. Build a plan to see the recording."></canvas><p id="el-chart-empty" class="el-chart-empty">Your recording will appear here.</p></div>
            <div class="el-chart-key"><span><i></i>Normalized movement</span><span><i class="el-coral"></i>Playback position</span><span>Gaps remain unfilled</span></div>
            <div id="el-quality" class="el-quality" hidden></div>
          </section>
          <section class="el-panel" aria-labelledby="el-inspect-title">
            <div class="el-panel-title el-panel-title-row"><div><span class="eyebrow">04 / INSPECT</span><h2 id="el-inspect-title">The planned arrangement</h2></div><span id="el-plan-meta" class="el-small-mono">No plan yet</span></div>
            <p class="el-help">One second of data requests one second of music. Boundaries are planned; audible transitions can be gradual.</p>
            <div id="el-sections" class="el-sections"><div class="el-empty">Build a plan to inspect activity, coverage and the musical instructions for every section.</div></div>
            <div class="el-export-row"><button id="el-request-download" class="el-button el-small" type="button" disabled>Download request JSON</button><button id="el-features-download" class="el-button el-small" type="button" disabled>Download features</button><a id="el-plan-export" class="el-button el-small" hidden>Export plan bundle</a></div>
            <details id="el-request-details" class="el-details"><summary>Exact provider request & manual revision</summary>
              <p class="el-help">Only this musical request goes to ElevenLabs. Your source data and features stay on this computer. Manual changes create a new saved revision; keep section durations unchanged.</p>
              <label class="el-label" for="el-request">Request JSON</label><textarea id="el-request" class="el-json" rows="16" spellcheck="false" readonly placeholder="Build a plan first."></textarea>
              <div class="el-export-row"><button id="el-edit-request" class="el-button el-small" type="button" disabled>Edit request</button><button id="el-save-request" class="el-button el-small" type="button" disabled>Save new revision</button></div>
            </details>
          </section>
          <section class="el-panel el-generate-panel" aria-labelledby="el-generate-title">
            <div class="el-panel-title"><span class="eyebrow">05 / GENERATE & LISTEN</span><h2 id="el-generate-title">Hear the interpretation</h2></div>
            <div id="el-setup" class="el-setup" role="status">Checking the local generation service…</div>
            <div class="el-generation-facts"><div><span>Requested duration</span><b id="el-requested-duration">—</b></div><div><span>Saved attempts</span><b id="el-attempt-count">0</b></div><div><span>Model</span><b>music_v2_5</b></div></div>
            <p id="el-generation-note" class="el-help">Each new track includes automatic stem separation. Both generation and separation use ElevenLabs credits.</p>
            <div class="el-generation-buttons"><button id="el-generate" class="el-button el-primary" type="button" disabled>Generate music & stems · uses credits</button><button id="el-variation" class="el-button el-secondary" type="button" disabled>Generate another variation & stems · uses credits</button></div>
            <p id="el-job-status" class="el-job-status" role="status" aria-live="polite">No generation started.</p>
            <div id="el-listen" class="el-listen" hidden>
              <div class="el-field-pair"><label class="el-label">Listening to<select id="el-attempt"></select></label><label class="el-label">Compare with<select id="el-compare"></select></label></div>
              <div class="el-export-row"><button id="el-swap" class="el-button el-small" type="button">Switch A/B at current position</button><a id="el-export" class="el-button el-small">Export audio & explanation</a><a id="el-audio-download" class="el-button el-small" download>Download audio</a></div>
              <audio id="el-audio" controls preload="metadata" aria-label="Generated sonification audio"></audio>
              <p id="el-playback" class="el-playback">Choose a saved attempt to listen.</p>
              <p id="el-timing-warning" class="el-help el-warning" hidden></p>
            </div>
            <div id="el-attempts" class="el-attempts"></div>
          </section>
        </div>
      </div>`;
    globalThis.HydraElevenRealtime?.init({ container: $("realtime"), getSelection: selection,
      sourceBridge, pauseOriginal: () => $("audio").pause() });
    bind();
    const saved = remembered();
    state.baseline = saved.baseline || null;
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => drawChart()).observe($("chart"));
  }

  function bind() {
    $("synthetic").addEventListener("click", () => task(async () => {
      await loadDataset(await api("/datasets", { synthetic: true }));
      notice("The example is loaded. Building its six-section plan…");
      await buildPlan();
    }));
    $("file").addEventListener("change", () => task(async () => {
      const file = $("file").files[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) throw new Error("Please choose a CSV or JSONL file smaller than 8 MB.");
      const dataset = await api("/datasets", { filename: file.name, content: await file.text() });
      await loadDataset(dataset);
      notice("Recording imported. Confirm timestamp units, channel meanings and bounds, then build a plan.");
    }));
    $("form").addEventListener("submit", (event) => { event.preventDefault(); task(buildPlan); });
    $("form").addEventListener("input", markDirty);
    $("form").addEventListener("change", (event) => {
      if (event.target === $("timestamp")) renderChannels(channelSettings());
      if (event.target.matches("[data-channel-lower], [data-channel-upper], [data-channel-meaning], [data-channel-change], #el-units, #el-timestamp")) $("reuse-baseline").checked = false;
      if (event.target === $("reuse-baseline")) updateBaseline();
      markDirty();
    });
    $("saved-plan").addEventListener("change", () => {
      const id = $("saved-plan").value;
      if (id) task(() => restorePlan(id));
    });
    $("request-download").addEventListener("click", () => download("request.json", state.plan.request));
    $("features-download").addEventListener("click", () => download("features.json", state.plan.sections));
    $("edit-request").addEventListener("click", () => { $("request").readOnly = false; $("request").focus(); notice("Edit the musical instructions, then save a new revision before generating."); });
    $("request").addEventListener("input", () => { state.requestDirty = true; $("save-request").disabled = false; updateActions(); });
    $("save-request").addEventListener("click", () => task(async () => {
      if (state.dirty) throw new Error("Build the updated settings before editing the request.");
      let request;
      try { request = JSON.parse($("request").value); } catch (_) { throw new Error("Request JSON is not valid. Check commas, quotes and brackets."); }
      const plan = await api("/plans", { analysis_id: state.plan.analysis_id, settings: state.plan.settings, request });
      setPlan(plan);
      await refreshLists();
      notice("Manual revision saved. Review it before generating.");
    }));
    $("generate").addEventListener("click", () => task(() => generate(false)));
    $("variation").addEventListener("click", () => task(() => generate(true)));
    $("attempt").addEventListener("change", () => chooseAttempt($("attempt").value));
    $("swap").addEventListener("click", () => {
      const target = $("compare").value;
      const previous = state.currentJob?.id;
      if (target) { chooseAttempt(target, true); $("compare").value = previous || ""; }
    });
    $("audio").addEventListener("timeupdate", syncPlayback);
    $("audio").addEventListener("seeked", syncPlayback);
    $("audio").addEventListener("loadedmetadata", syncPlayback);
    $("audio").addEventListener("play", () => {
      globalThis.HydraElevenRealtime?.deactivate();
      if (state.active) globalThis.HydraElevenRealtime?.activate();
      stopAnimation(); animatePlayback();
    });
    $("audio").addEventListener("pause", () => { stopAnimation(); syncPlayback(); });
    $("audio").addEventListener("ended", () => { stopAnimation(); syncPlayback(); });
    $("audio").addEventListener("error", () => notice("The saved audio could not be loaded. Reopen the attempt or inspect the generation status.", true));
    $("sections").addEventListener("click", (event) => {
      const button = event.target.closest("[data-seek]");
      if (button && $("audio").getAttribute("src")) { $("audio").currentTime = Number(button.dataset.seek); syncPlayback(); }
    });
    $("attempts").addEventListener("click", (event) => {
      const button = event.target.closest("[data-job]");
      if (button) chooseAttempt(button.dataset.job);
    });
  }

  function markDirty() {
    if (!state.dataset) return;
    state.dirty = true;
    updateActions();
  }
  function updateBaseline() {
    const entries = Object.entries(state.baseline || {});
    $("reuse-baseline").disabled = !entries.length;
    $("baseline-note").textContent = entries.length
      ? `Saved bounds: ${entries.map(([name, bound]) => `${name} ${number(bound.lower_bound, 3)}–${number(bound.upper_bound, 3)} (${number(bound.clipped_percent || 0, 1)}% clipped)`).join("; ")}. Explicit channel bounds override these.`
      : "Leave bounds blank to fit the 5th–95th percentiles once. Fixed bounds take precedence.";
  }
  function channelSettings() {
    return [...root.querySelectorAll(".el-channel")].map((row) => {
      const selected = row.querySelector("[data-channel-selected]").checked;
      const result = { name: row.dataset.name, meaning: row.querySelector("[data-channel-meaning]").value,
        change_based: row.querySelector("[data-channel-change]").checked, selected };
      const lower = row.querySelector("[data-channel-lower]").value;
      const upper = row.querySelector("[data-channel-upper]").value;
      if (lower !== "") result.lower_bound = Number(lower);
      if (upper !== "") result.upper_bound = Number(upper);
      return result;
    });
  }
  function renderChannels(settings = []) {
    const columns = list(state.dataset?.columns).map((column) => typeof column === "string" ? column : column.name);
    $("channels").innerHTML = columns.filter((name) => name !== $("timestamp").value).map((name, index) => {
      const setting = settings.find((item) => item.name === name);
      const selected = setting ? setting.selected !== false : false;
      const meaning = setting?.meaning || "scalar";
      return `<div class="el-channel" data-name="${escapeHTML(name)}"><div class="el-channel-heading"><label class="el-check"><input type="checkbox" data-channel-selected ${selected ? "checked" : ""}>${escapeHTML(name)}</label>
        <select data-channel-meaning aria-label="Meaning of ${escapeHTML(name)}"><option value="velocity" ${meaning === "velocity" ? "selected" : ""}>Velocity</option><option value="position" ${meaning === "position" ? "selected" : ""}>Position</option><option value="scalar" ${meaning === "scalar" ? "selected" : ""}>Generic scalar</option></select></div>
        <div class="el-field-pair"><label class="el-label" for="el-lower-${index}">Lower bound<input id="el-lower-${index}" data-channel-lower type="number" step="any" value="${escapeHTML(setting?.lower_bound ?? "")}" placeholder="Fit baseline"></label>
          <label class="el-label" for="el-upper-${index}">Upper bound<input id="el-upper-${index}" data-channel-upper type="number" step="any" value="${escapeHTML(setting?.upper_bound ?? "")}" placeholder="Fit baseline"></label></div>
        <label class="el-check el-subtle"><input type="checkbox" data-channel-change ${setting?.change_based ? "checked" : ""}>Use change for generic scalar</label></div>`;
    }).join("");
  }
  async function loadDataset(dataset, settings) {
    state.dataset = dataset;
    state.analysis = null;
    state.plan = null;
    state.currentJob = null;
    state.dirty = true;
    state.requestDirty = false;
    $("audio").pause();
    $("audio").removeAttribute("src");
    $("listen").hidden = true;
    const defaults = settings || dataset.defaults || {};
    const columns = list(dataset.columns).map((column) => typeof column === "string" ? column : column.name);
    $("dataset").textContent = `${dataset.filename || "Recording"} · ${Number(dataset.row_count || 0).toLocaleString()} rows · ${columns.length} columns`;
    $("timestamp").innerHTML = columns.map((name) => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join("");
    $("timestamp").value = defaults.timestamp_column || columns[0];
    $("units").value = defaults.timestamp_units || "seconds";
    $("start").value = defaults.start_seconds ?? 0;
    $("end").value = defaults.end_seconds ?? "";
    $("window").value = defaults.window_seconds ?? 10;
    $("rate").value = defaults.sample_rate_hz ?? 10;
    $("gap").value = defaults.max_gap_seconds ?? "";
    if (settings?.baseline) state.baseline = settings.baseline;
    $("reuse-baseline").checked = Boolean(settings?.baseline);
    renderChannels(defaults.channels || []);
    updateBaseline();
    renderPlan();
    updateActions();
  }

  function collectSettings() {
    const channels = channelSettings().filter((channel) => channel.selected).map(({ selected, ...channel }) => channel);
    if (!channels.length) throw new Error("Choose at least one numeric channel.");
    for (const channel of channels) {
      const hasLower = channel.lower_bound !== undefined;
      const hasUpper = channel.upper_bound !== undefined;
      if (hasLower !== hasUpper) throw new Error(`Set both normalization bounds for ${channel.name}, or leave both blank.`);
      if (hasLower && channel.lower_bound >= channel.upper_bound) throw new Error(`The upper bound for ${channel.name} must exceed the lower bound.`);
    }
    const settings = { timestamp_column: $("timestamp").value, timestamp_units: $("units").value, channels,
      start_seconds: Number($("start").value), sample_rate_hz: Number($("rate").value), window_seconds: Number($("window").value) };
    if ($("end").value !== "") settings.end_seconds = Number($("end").value);
    if ($("gap").value !== "") settings.max_gap_seconds = Number($("gap").value);
    if ($("reuse-baseline").checked) settings.baseline = state.baseline;
    return settings;
  }
  function mappingSettings() {
    const settings = { style: $("style").value.trim(), bpm: Number($("bpm").value), key: $("key").value.trim(),
      instrument_palette: $("palette").value.split(",").map((value) => value.trim()).filter(Boolean),
      enable_variability: $("variability").checked, context_adherence: $("context").value };
    if ($("seed").value !== "") settings.seed = Number($("seed").value);
    return settings;
  }
  async function buildPlan() {
    if (!state.dataset) throw new Error("Import a recording first.");
    notice("Analyzing the recording and compiling musical instructions…");
    const analysis = await api("/analyses", { dataset_id: state.dataset.id, settings: collectSettings() });
    state.analysis = analysis;
    const plan = await api("/plans", { analysis_id: analysis.id, settings: mappingSettings() });
    setPlan(plan);
    await refreshLists();
    notice(plan.can_generate ? "Plan saved. Inspect the section instructions, then generate when ready." : "Plan saved with data issues. Review the highlighted coverage or bounds before generating.", !plan.can_generate);
  }
  function setPlan(plan) {
    state.plan = plan;
    state.dirty = false;
    state.requestDirty = false;
    state.baseline = state.analysis?.baseline || plan.baseline || state.baseline;
    $("reuse-baseline").checked = Boolean(state.baseline && Object.keys(state.baseline).length);
    $("request").readOnly = true;
    if (!matchesPlan(state.currentJob || {}, plan)) {
      state.currentJob = null;
      $("audio").pause();
      $("audio").removeAttribute("src");
    }
    updateBaseline();
    renderPlan();
    renderAttempts();
    remember();
  }
  async function restorePlan(id, preferredJobId) {
    notice("Opening the saved plan…");
    const plan = await api(`/plans/${encodeURIComponent(id)}`);
    const analysis = await api(`/analyses/${encodeURIComponent(plan.analysis_id)}`);
    const dataset = await api(`/datasets/${encodeURIComponent(analysis.dataset_id)}`);
    await loadDataset(dataset, analysis.settings);
    state.analysis = analysis;
    const settings = plan.settings || {};
    $("style").value = settings.style || "instrumental electronic music";
    $("bpm").value = settings.bpm ?? 100;
    $("key").value = settings.key || "D minor";
    $("palette").value = list(settings.instrument_palette).join(", ");
    $("variability").checked = Boolean(settings.enable_variability);
    $("context").value = settings.context_adherence || "high";
    $("seed").value = settings.seed ?? "";
    setPlan(plan);
    await refreshLists();
    const job = state.jobs.find((item) => item.id === preferredJobId && matchesPlan(item, plan)) ||
      state.jobs.find((item) => matchesPlan(item, plan) && item.state === "complete") || state.jobs.find((item) => matchesPlan(item, plan));
    if (job) chooseAttempt(job.id);
    schedulePoll();
    notice("Saved plan restored. Completed audio can be played without generating again.");
  }

  function renderPlan() {
    const plan = state.plan;
    const sections = list(plan?.sections);
    $("duration").textContent = state.analysis ? `${seconds(state.analysis.duration_seconds)} selected / ${seconds(state.analysis.source_duration_seconds)} source` : "—";
    $("chart-empty").hidden = Boolean(state.analysis?.timeline);
    $("chart").setAttribute("aria-label", state.analysis ? `Normalized movement for ${seconds(state.analysis.duration_seconds)}. Section features and coverage are listed below.` : "Normalized movement plot. Build a plan to see the recording.");
    const warnings = [...list(state.analysis?.warnings), ...list(plan?.warnings)].map(message);
    const blockers = [...list(state.analysis?.blocking_reasons), ...list(plan?.blocking_reasons)].map(message);
    const issues = [...new Set([...blockers, ...warnings])];
    $("quality").hidden = !issues.length;
    $("quality").classList.toggle("is-error", blockers.length > 0);
    $("quality").innerHTML = issues.map((issue) => `<p>${escapeHTML(issue)}</p>`).join("");
    $("plan-meta").textContent = plan ? `${sections.length} sections · ${plan.mapping_version || "saved revision"}` : "No plan yet";
    $("sections").innerHTML = sections.length ? sections.map((section, index) => {
      const activity = section.bands?.activity || "—";
      const variability = section.bands?.variability || "—";
      return `<article class="el-section ${section.coverage < 0.9 ? "has-gap" : ""}" data-section="${index}">
        <div class="el-section-head"><b>${String(index + 1).padStart(2, "0")}</b><span>${seconds(section.audio_start)} — ${seconds(section.audio_end)}</span><button class="el-seek" type="button" data-seek="${Number(section.audio_start)}" ${!state.currentJob?.audio_url ? "disabled" : ""} aria-label="Seek to section ${index + 1}">Seek ↗</button></div>
        <div class="el-feature"><span>Activity</span><meter min="0" max="1" value="${Number(section.activity) || 0}" aria-label="Section ${index + 1} activity">${number(section.activity)}</meter><b>${number(section.activity)} · ${escapeHTML(activity)}</b></div>
        <div class="el-section-metrics"><span>Variability ${number(section.variability)} · ${escapeHTML(variability)}</span><span>Coverage ${number(section.coverage * 100, 1)}%</span><span>Trend ${number(section.trend, 4)}/s</span></div>
        <p class="el-section-directions">${escapeHTML(list(section.positive_styles).join(" · "))}</p>
        <details class="el-section-details"><summary>Source & exclusions</summary><p>Source ${seconds(section.source_start)}–${seconds(section.source_end)} · requested ${seconds(section.duration_ms / 1000)}</p><p>Text: ${escapeHTML(section.text || "(none)")}</p><p>Exclude: ${escapeHTML(list(section.negative_styles).join(", "))}</p></details>
      </article>`;
    }).join("") : '<div class="el-empty">Build a plan to inspect activity, coverage and the musical instructions for every section.</div>';
    $("request").value = plan ? JSON.stringify(plan.request, null, 2) : "";
    $("request-download").disabled = !plan;
    $("features-download").disabled = !plan;
    $("edit-request").disabled = !plan;
    $("save-request").disabled = true;
    $("plan-export").hidden = !plan;
    if (plan) $("plan-export").href = `${API}/plans/${encodeURIComponent(plan.id)}/export`;
    drawChart();
    updateActions();
  }

  function drawChart() {
    if (!root || root.hidden) return;
    const canvas = $("chart");
    const width = Math.max(240, canvas.getBoundingClientRect().width || 600);
    const height = 210;
    const ratio = globalThis.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== height * ratio) { canvas.width = Math.round(width * ratio); canvas.height = height * ratio; }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const margin = { left: 35, right: 12, top: 15, bottom: 25 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    ctx.font = "10px monospace";
    const timeline = state.analysis?.timeline;
    const sections = list(state.plan?.sections);
    const start = sections[0]?.source_start ?? timeline?.times?.[0] ?? 0;
    const end = sections.at(-1)?.source_end ?? timeline?.times?.at(-1) ?? 60;
    const duration = Math.max(0.001, end - start);
    const x = (time) => margin.left + ((time - start) / duration) * plotWidth;
    const y = (value) => margin.top + (1 - value) * plotHeight;
    sections.forEach((section, index) => {
      ctx.fillStyle = section.coverage < 0.9 ? "rgba(255,122,98,.1)" : index % 2 === 0 ? "rgba(199,248,111,.035)" : "rgba(199,248,111,.075)";
      ctx.fillRect(x(section.source_start), margin.top, x(section.source_end) - x(section.source_start), plotHeight);
    });
    [0, 0.5, 1].forEach((value) => {
      ctx.strokeStyle = "#343934"; ctx.beginPath(); ctx.moveTo(margin.left, y(value)); ctx.lineTo(width - margin.right, y(value)); ctx.stroke();
      ctx.fillStyle = "#969d93"; ctx.fillText(number(value, 1), 3, y(value) + 3);
    });
    if (timeline) {
      ctx.save(); ctx.beginPath(); ctx.rect(margin.left, margin.top, plotWidth, plotHeight); ctx.clip();
      ctx.strokeStyle = "#c7f86f"; ctx.lineWidth = 1.7; ctx.beginPath();
      let drawing = false;
      timeline.times.forEach((time, index) => {
        const value = timeline.signal[index];
        if (value === null || !Number.isFinite(value) || timeline.valid?.[index] === false) { drawing = false; return; }
        if (drawing) ctx.lineTo(x(time), y(value)); else ctx.moveTo(x(time), y(value));
        drawing = true;
      });
      ctx.stroke();
      const audio = $("audio");
      if (audio.getAttribute("src")) {
        const sectionIndex = sectionAt(sections, audio.currentTime);
        if (sectionIndex >= 0) {
          const section = sections[sectionIndex];
          const sourceTime = section.source_start + (audio.currentTime - section.audio_start) *
            (section.source_end - section.source_start) / (section.audio_end - section.audio_start);
          ctx.strokeStyle = "#ff7a62"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x(sourceTime), margin.top); ctx.lineTo(x(sourceTime), margin.top + plotHeight); ctx.stroke();
        }
      }
      ctx.restore();
    }
    ctx.fillStyle = "#969d93"; ctx.textAlign = "left"; ctx.fillText(`${number(start, 1)} s`, margin.left, height - 5);
    ctx.textAlign = "right"; ctx.fillText(`${number(end, 1)} s`, width - margin.right, height - 5); ctx.textAlign = "left";
  }

  function renderStatus() {
    const status = state.status;
    $("setup").classList.toggle("is-error", !status?.ready);
    $("setup").textContent = status?.ready ? "API key configured on the server · audio validation ready" :
      list(status?.setup_errors).map(message).join(" ") || "The local generation service is not ready. Check the dashboard server configuration.";
    updateActions();
  }
  function planJobs() { return state.jobs.filter((job) => matchesPlan(job, state.plan)); }
  function updateActions() {
    syncRealtime();
    if (!root) return;
    $("settings").disabled = state.busy || !state.dataset;
    const jobs = planJobs();
    const complete = jobs.find((job) => job.state === "complete");
    const running = jobs.find((job) => ACTIVE_STATES.has(job.state));
    const unresolved = jobs.some((job) => job.state === "unknown");
    const allowed = canGenerate(state);
    $("generate").disabled = !allowed;
    $("generate").textContent = complete ? "Use saved audio · no new charge" : running ? "View generation in progress" : jobs.length ? "View previous attempt · no retry" : "Generate music & stems · uses credits";
    $("variation").disabled = !state.plan?.can_generate || state.dirty || state.requestDirty || state.busy || !state.status?.ready || jobs.length === 0 || state.jobs.some(hasPendingWork);
    $("requested-duration").textContent = state.plan ? seconds(state.plan.duration_seconds) : "—";
    $("attempt-count").textContent = String(jobs.length);
    $("generation-note").textContent = state.requestDirty ? "Save your manual request revision before generating." : state.dirty && state.plan ?
      "Settings have changed. Build and inspect a new plan before generating." : !state.plan ?
      "Inspect a plan before generating. New tracks include stem separation; both use ElevenLabs credits." : !state.plan.can_generate ?
      "Generation is blocked by the data or plan issues shown above. Correct the settings and rebuild." : complete ?
      "A saved result is available. Another variation generates new music and separates its stems; both use credits." : unresolved ?
      "An earlier outcome is unknown and may have used credits. Only Generate another variation starts a deliberate new attempt." :
      jobs.length ? "The previous attempt did not complete. View its details or choose Generate another variation for a new paid attempt." :
      `${seconds(state.plan.duration_seconds)} of music · ${jobs.length} prior attempt${jobs.length === 1 ? "" : "s"}. Music generation is followed by automatic stem separation; both use credits.`;
  }
  async function refreshLists() {
    const results = await Promise.all([api("/generations"), api("/plans")]);
    state.jobs = list(results[0].jobs).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    state.plans = list(results[1].plans);
    $("saved-plan").innerHTML = '<option value="">Choose a saved plan…</option>' + state.plans.map((plan) => `<option value="${escapeHTML(plan.id)}">${escapeHTML(plan.dataset_name || plan.filename || "Plan")} · ${seconds(plan.duration_seconds)} · ${escapeHTML(localDate(plan.created_at))}</option>`).join("");
    if (state.plan) $("saved-plan").value = state.plan.id;
    if (state.currentJob) state.currentJob = state.jobs.find((job) => job.id === state.currentJob.id) || state.currentJob;
    renderAttempts();
    updateActions();
  }
  async function generate(variation) {
    if (!state.plan || state.dirty || state.requestDirty || !state.plan.can_generate) throw new Error("Build and inspect a valid plan before generating.");
    const cached = !variation && planJobs().find((job) => job.state === "complete");
    if (cached) { chooseAttempt(cached.id); notice("Loaded saved audio. No new generation request was sent."); return; }
    notice(variation ? "Starting an intentional new variation…" : "Submitting the inspected composition plan…");
    // No retry: a lost response can still represent a billable provider attempt.
    let job;
    try { job = await api("/generations", { plan_id: state.plan.id, variation }); }
    catch (error) {
      try { await refreshLists(); schedulePoll(); } catch (_) { /* The next tab activation will refresh local state. */ }
      throw new Error(`${error.message} No automatic retry was made. Check saved attempts before requesting a new variation.`);
    }
    state.currentJob = job;
    await refreshLists();
    chooseAttempt(job.id);
    schedulePoll();
    notice(job.state === "complete" ? "A saved result was reused." : job.reused ? "Showing the existing attempt. No new generation request was sent." : "Generation submitted. You can inspect the plan while the server works.");
  }
  function renderAttempts() {
    const jobs = planJobs();
    const completed = jobs.filter((job) => job.state === "complete");
    const label = (job) => `Attempt ${job.attempt_count || jobs.slice().reverse().findIndex((item) => item.id === job.id) + 1} · ${seconds(job.audio?.duration_seconds ?? job.requested_duration_seconds)}`;
    const options = completed.map((job) => `<option value="${escapeHTML(job.id)}">${escapeHTML(label(job))}</option>`).join("");
    const alternatives = completed.filter((job) => job.id !== state.currentJob?.id);
    const compareValue = $("compare").value;
    $("attempt").innerHTML = options;
    $("compare").innerHTML = '<option value="">Select another saved attempt</option>' + alternatives.map((job) => `<option value="${escapeHTML(job.id)}">${escapeHTML(label(job))}</option>`).join("");
    if (alternatives.some((job) => job.id === compareValue)) $("compare").value = compareValue;
    else if (completed.length > 1) $("compare").value = alternatives[0]?.id || "";
    $("swap").disabled = completed.length < 2;
    $("listen").hidden = completed.length === 0;
    if (state.currentJob?.state === "complete") $("attempt").value = state.currentJob.id;
    $("attempts").innerHTML = jobs.length ? `<div class="el-attempts-heading">Saved attempts for this plan</div>${jobs.map((job) => `<button class="el-attempt ${job.id === state.currentJob?.id ? "is-selected" : ""}" data-job="${escapeHTML(job.id)}" type="button"><span>${escapeHTML(label(job))}</span><b class="el-state-${escapeHTML(job.state)}">${escapeHTML(job.state)}</b></button>`).join("")}` : "";
    showJobStatus();
  }
  function showJobStatus() {
    const job = state.currentJob;
    const descriptions = { queued: "Queued locally; not sent yet.", generating: "Generating on ElevenLabs. Leaving this tab or stopping playback does not cancel the request.", complete: "Audio saved and validated.",
      failed: "Generation failed. No automatic retry was made.", unknown: "The result is unknown. The request may have reached ElevenLabs and used credits. No automatic retry was made.", cancelled: "Cancelled before sending." };
    const stemState = job?.stem_separation?.state;
    const stemDescription = { queued: " Stem separation is queued; the full mix is ready to play.",
      generating: " Separating stems; the full mix is ready to play.", complete: " Stems are saved and ready for live mappings.",
      failed: " Stem separation failed; the full mix remains available. No automatic retry was made.",
      unknown: " Stem separation has an unknown outcome and may have used credits. The full mix remains available; no automatic retry was made." };
    $("job-status").textContent = job ? `${descriptions[job.state] || job.state}${job.error ? ` ${message(job.error)}` : ""}${stemDescription[stemState] || ""}` : "No generation started.";
    $("job-status").classList.toggle("is-error", [job?.state, stemState].some((value) => value === "failed" || value === "unknown"));
  }
  function chooseAttempt(id, preservePosition = false) {
    const job = state.jobs.find((item) => item.id === id);
    if (!job) return;
    const audio = $("audio");
    const time = preservePosition ? audio.currentTime : 0;
    const wasPlaying = preservePosition && !audio.paused;
    state.currentJob = job;
    if (job.state === "complete") {
      const source = job.audio_url || `${API}/generations/${encodeURIComponent(job.id)}/audio`;
      if (audio.getAttribute("src") !== source) {
        audio.pause();
        audio.src = source;
        audio.addEventListener("loadedmetadata", () => {
          audio.currentTime = Math.min(time, Number.isFinite(audio.duration) ? audio.duration : time);
          if (wasPlaying) audio.play().catch(() => {});
          syncPlayback();
        }, { once: true });
      }
      $("export").href = job.export_url || `${API}/generations/${encodeURIComponent(job.id)}/export`;
      $("audio-download").href = source;
      const warning = job.audio?.timing_warning || job.warning || "";
      $("timing-warning").hidden = !warning;
      $("timing-warning").textContent = message(warning);
      root.querySelectorAll("[data-seek]").forEach((button) => { button.disabled = false; });
    } else {
      audio.pause();
      audio.removeAttribute("src");
      $("listen").hidden = true;
      root.querySelectorAll("[data-seek]").forEach((button) => { button.disabled = true; });
    }
    renderAttempts();
    if (job.state !== "complete") $("listen").hidden = true;
    syncPlayback();
    remember();
    syncRealtime();
  }
  function syncPlayback() {
    if (!state.plan) return;
    const audio = $("audio");
    const hasAudio = Boolean(audio.getAttribute("src"));
    const index = hasAudio ? sectionAt(state.plan.sections, audio.currentTime) : -1;
    root.querySelectorAll("[data-section]").forEach((card) => {
      const active = Number(card.dataset.section) === index;
      card.classList.toggle("is-playing", active);
      if (active) card.setAttribute("aria-current", "true"); else card.removeAttribute("aria-current");
    });
    const section = state.plan.sections[index];
    $("playback").textContent = section ? `${seconds(audio.currentTime)} · planned section ${index + 1} · source ${seconds(section.source_start)}–${seconds(section.source_end)}` : hasAudio ? `${seconds(audio.currentTime)} · outside the requested section timeline` : "Choose a saved attempt to listen.";
    drawChart();
  }
  function animatePlayback() {
    syncPlayback();
    if (state.active && !$("audio").paused) state.playbackFrame = requestAnimationFrame(animatePlayback);
  }
  function stopAnimation() { if (state.playbackFrame !== null) cancelAnimationFrame(state.playbackFrame); state.playbackFrame = null; }
  function schedulePoll() {
    clearTimeout(state.timer);
    if (!state.active || !state.jobs.some(hasPendingWork)) return;
    state.timer = setTimeout(async () => {
      try {
        const previous = state.currentJob;
        await refreshLists();
        if (previous && state.currentJob?.state === "complete" && previous.state !== "complete") chooseAttempt(previous.id);
        schedulePoll();
      } catch (error) {
        notice(`Status check failed: ${error.message} No generation request was retried. Reopen this tab to refresh.`, true);
      }
    }, 2000);
  }
  function download(filename, content) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function activate() {
    init();
    if (!state.initialized) return;
    state.active = true;
    globalThis.HydraElevenRealtime?.activate();
    try {
      const status = await api("/status");
      state.status = status;
      renderStatus();
      const previousJob = state.currentJob;
      await refreshLists();
      if (state.currentJob?.state === "complete" && (previousJob?.state !== "complete" || !$("audio").getAttribute("src"))) chooseAttempt(state.currentJob.id);
      if (!state.loaded) {
        state.loaded = true;
        const saved = remembered();
        const id = saved.planId && state.plans.some((plan) => plan.id === saved.planId) ? saved.planId : state.plans[0]?.id;
        if (id) await task(() => restorePlan(id, saved.jobId));
      }
      schedulePoll();
      drawChart();
    } catch (error) { notice(error.message, true); $("setup").textContent = error.message; }
  }
  function deactivate() {
    state.active = false;
    globalThis.HydraElevenRealtime?.deactivate();
    clearTimeout(state.timer);
    stopAnimation();
    if (state.initialized) $("audio").pause();
  }

  return { init, activate, deactivate, sectionAt, canGenerate, matchesPlan, hasPendingWork };
})();
