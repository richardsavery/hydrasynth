"use strict";

// Original music creation and realtime playback share one workspace.
globalThis.HydraElevenLabs = (() => {
  const API = "/api/elevenlabs";
  const STORAGE_KEY = "hydra.elevenlabs.workspace.v1";
  const ACTIVE_STATES = new Set(["queued", "generating"]);
  const state = { initialized: false, loaded: false, active: false, analysis: null,
    plan: null, jobs: [], plans: [], currentJob: null, status: null, busy: false,
    dirty: false, timer: null, playbackFrame: null, unavailablePlanId: null, unavailableJobId: null };
  let root;
  const $ = (id) => root.querySelector(`#el-${id}`);
  const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const number = (value, digits = 2) => Number.isFinite(Number(value)) && value !== null ? Number(value).toFixed(digits) : "—";
  const seconds = (value) => `${number(value, 1)} s`;
  const localDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Saved music" : new Intl.DateTimeFormat(undefined, {
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

  function musicLabel(record, plan = {}) {
    const settings = record.realtime?.generation_settings || record.generation_settings || record.settings || plan.settings || {};
    const title = String(record.name || settings.style || (record.origin === "original" ? "Original music" : "Generated music"))
      .replace(/\s+/g, " ").trim();
    const duration = Number(record.audio?.duration_seconds ?? record.requested_duration_seconds ?? record.duration_seconds ?? plan.duration_seconds);
    const date = record.created_at || plan.created_at;
    return [title.length > 60 ? `${title.slice(0, 57)}…` : title,
      Number(settings.bpm) > 0 ? `${settings.bpm} BPM` : "", settings.key,
      Number.isFinite(duration) && duration > 0 ? `${Number(duration.toFixed(1))}s` : "",
      date && !Number.isNaN(new Date(date).getTime()) ? localDate(date) : "",
      record.id ? String(record.id).slice(-8) : ""].filter(Boolean).join(" · ");
  }

  async function api(path, body) {
    const response = await fetch(`${API}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error(`The local server returned an unreadable response (${response.status}).`); }
    if (!response.ok) {
      const error = new Error(message(data.error || data.detail || data.message || `Request failed (${response.status}).`));
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function remember({ strict = false } = {}) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ planId: state.plan?.id || state.unavailablePlanId || undefined, jobId: state.currentJob?.id || state.unavailableJobId || undefined, generationSettings: readGenerationSettings(), durationSeconds: Number($("length").value) })); }
    catch (error) { if (strict) throw error; /* Server persistence still works without browser storage. */ }
  }
  function flush(options) { if (state.initialized && state.loaded) remember(options); }
  function remembered() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    } catch (_) { return {}; }
  }
  function notice(text, error = false) {
    $("notice").textContent = text;
    $("notice").classList.toggle("is-error", error);
  }
  function busy(value) {
    state.busy = value;
    $("generation-direction").querySelectorAll("input, select").forEach((input) => { input.disabled = value; });
    $("length").disabled = value;
    $("saved-plan").disabled = value;
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
        <div><span class="eyebrow">ELEVENLABS</span><h1>Generated <span>music</span></h1>
          <p>Create your music here. Route input to the master or individual stems to shape it as it plays.</p></div>
        <span class="el-badge" data-advanced>MUSIC V2.5</span>
      </header>
      <p id="el-notice" class="el-notice" role="status" aria-live="polite">Describe your music and generate an original starting track, or play a saved track below.</p>
      <section id="el-next-settings" class="el-next-settings" aria-labelledby="el-next-title">
        <div class="el-panel-title"><span class="eyebrow">MUSICAL DIRECTION</span><h2 id="el-next-title">What creates next</h2></div>
        <p class="el-help">Set the direction for your first track and upcoming segments. Recent input activity shapes how sparse or dense each new segment is. Changes apply to the next request; mappings below shape the music already playing.</p>
        <div id="el-generation-direction" class="el-generation-direction">
          <label class="el-label el-style-field">Describe the music<input id="el-style" type="text" value="instrumental electronic music" maxlength="300" required></label>
          <label class="el-label">Requested BPM<input id="el-bpm" type="number" min="20" max="300" value="100" required></label>
          <label class="el-label">Requested key<input id="el-key" type="text" value="D minor" maxlength="80" required></label>
          <label class="el-label el-palette-field">Instruments · comma separated<input id="el-palette" type="text" value="warm synthesizer tones, soft electronic percussion"></label>
          <details class="el-details el-generation-advanced" data-advanced><summary>How input shapes new music</summary>
            <div class="el-mapping-rule"><b>Recent activity → density</b><span>Low: sparse · medium: regular pulse · high: dense</span></div>
            <label class="el-check"><input id="el-variability" type="checkbox">Variability → articulation</label>
            <div class="el-field-pair"><label class="el-label">Context adherence<select id="el-context"><option value="high">High · preserve continuity</option><option value="medium">Medium</option><option value="low">Low · stronger variation</option></select></label>
              <label class="el-label">Optional seed<input id="el-seed" type="number" min="0" max="2147483647" step="1" placeholder="Provider chooses"></label></div>
            <p class="el-help">BPM, key and instrumentation are musical directions. A seed does not guarantee an identical result.</p>
          </details>
        </div>
      <details id="el-create" class="el-create-disclosure" data-el-create-track open>
        <summary>Create an original starting track</summary>
        <p class="el-help">Generate new instrumental music from the direction above, ready for live mappings. Stems are separated automatically.</p>
        <div class="el-create-row">
          <label class="el-label">Starting track length<select id="el-length"><option value="20">20 seconds</option><option value="40">40 seconds</option><option value="60">60 seconds</option></select></label>
          <div class="el-generation-buttons"><button id="el-generate" class="el-button el-primary" type="button" disabled>Generate original music &amp; stems · uses credits</button><button id="el-variation" class="el-button el-secondary" type="button" disabled>Generate another version · uses credits</button></div>
        </div>
        <div id="el-setup" class="el-setup" role="status">Checking the generation service…</div>
        <div id="el-quality" class="el-quality" hidden></div>
        <p id="el-generation-note" class="el-help">Music generation and automatic stem separation both use ElevenLabs credits.</p>
        <p id="el-job-status" class="el-job-status" role="status" aria-live="polite">No generation started.</p>
        <details class="el-details" data-advanced>
          <summary>Saved music &amp; downloads</summary>
          <label class="el-label el-saved-label">Reopen saved music<select id="el-saved-plan"><option value="">No saved music</option></select></label>
          <div id="el-attempts" class="el-attempts"></div>
          <div id="el-listen" class="el-listen" hidden>
            <div class="el-field-pair"><label class="el-label">Listening to<select id="el-attempt"></select></label><label class="el-label">Compare with<select id="el-compare"></select></label></div>
            <div class="el-export-row"><button id="el-swap" class="el-button el-small" type="button">Switch A/B at current position</button><a id="el-export" class="el-button el-small">Export track bundle</a><a id="el-audio-download" class="el-button el-small" download>Download audio</a></div>
            <audio id="el-audio" controls preload="metadata" aria-label="Generated music preview"></audio>
            <button id="el-use-track" class="el-button el-primary" type="button">Use this track for mappings</button>
            <p id="el-playback" class="el-playback">Choose saved music to listen.</p>
            <p id="el-timing-warning" class="el-help el-warning" hidden></p>
          </div>
        </details>
      </details></section>
      <div id="el-realtime"></div>`;
    globalThis.HydraElevenRealtime?.init({ container: $("realtime"), getSelection: selection,
      sourceBridge, pauseOriginal: () => $("audio").pause(), createTrack: () => showView("create"),
      generationSettingsContainer: $("next-settings"), getGenerationSettings: mappingSettings });
    bind();
    const saved = remembered();
    if ([20, 40, 60].includes(Number(saved.durationSeconds))) $("length").value = String(saved.durationSeconds);
  }

  function bind() {
    $("use-track").addEventListener("click", () => {
      const completed = state.currentJob?.state === "complete" ? state.currentJob : planJobs().find((job) => job.state === "complete");
      if (completed) chooseAttempt(completed.id);
      showView("play");
    });
    $("generation-direction").addEventListener("input", markDirty);
    $("generation-direction").addEventListener("change", markDirty);
    $("length").addEventListener("change", markDirty);
    $("saved-plan").addEventListener("change", () => {
      const id = $("saved-plan").value;
      if (id) task(() => restorePlan(id));
    });
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
    $("attempts").addEventListener("click", (event) => {
      const button = event.target.closest("[data-job]");
      if (button) chooseAttempt(button.dataset.job);
    });
  }

  // Retained as a focus helper for callers; creation and playback share one page.
  function showView(view) {
    if (!state.initialized) return;
    const target = view === "create" ? $("create") : $("realtime");
    if (view === "create") $("create").open = true;
    else $("audio").pause();
    target.scrollIntoView?.({ behavior: "smooth", block: "start" });
    if (view === "create") $("style").focus({ preventScroll: true });
  }

  function markDirty() {
    state.dirty = true;
    remember();
    updateActions();
  }
  function readGenerationSettings() {
    const settings = { style: $("style").value.trim(), bpm: Number($("bpm").value), key: $("key").value.trim(),
      instrument_palette: $("palette").value.split(",").map((value) => value.trim()).filter(Boolean),
      enable_variability: $("variability").checked, context_adherence: $("context").value };
    settings.seed = $("seed").value === "" ? null : Number($("seed").value);
    return settings;
  }
  function validateGenerationSettings(settings) {
    if (!settings.style || settings.style.length > 300) throw new Error("Describe the music in 1–300 characters.");
    if (!Number.isFinite(settings.bpm) || settings.bpm < 20 || settings.bpm > 300) throw new Error("Requested BPM must be between 20 and 300.");
    if (!settings.key || settings.key.length > 80) throw new Error("Enter a requested key in 1–80 characters.");
    if (!Array.isArray(settings.instrument_palette) || settings.instrument_palette.length > 20 || settings.instrument_palette.some((value) => typeof value !== "string" || !value.trim() || value.length > 300)) throw new Error("Use up to 20 comma-separated instrument descriptions, each up to 300 characters.");
    if (!["high", "medium", "low"].includes(settings.context_adherence)) throw new Error("Choose a continuity setting.");
    if (settings.seed !== undefined && settings.seed !== null && (!Number.isInteger(settings.seed) || settings.seed < 0 || settings.seed > 2147483647)) throw new Error("The optional seed must be a whole number between 0 and 2147483647.");
    return settings;
  }
  function mappingSettings() { return validateGenerationSettings(readGenerationSettings()); }
  function applyGenerationSettings(settings = {}) {
    $("style").value = settings.style || "instrumental electronic music";
    $("bpm").value = settings.bpm ?? 100;
    $("key").value = settings.key || "D minor";
    $("palette").value = list(settings.instrument_palette).join(", ");
    $("variability").checked = Boolean(settings.enable_variability);
    $("context").value = settings.context_adherence || "high";
    $("seed").value = settings.seed ?? "";
  }
  function originalPlanRequest(duration, settings) {
    const durationSeconds = Number(duration);
    if (![20, 40, 60].includes(durationSeconds)) throw new Error("Choose a starting track length of 20, 40 or 60 seconds.");
    return { kind: "original", duration_seconds: durationSeconds, settings: validateGenerationSettings(settings) };
  }
  function setPlan(plan, preferredJobId = null) {
    state.plan = plan;
    state.unavailablePlanId = null;
    state.unavailableJobId = preferredJobId;
    state.dirty = false;
    if (!matchesPlan(state.currentJob || {}, plan)) {
      state.currentJob = null;
      $("audio").pause();
      $("audio").removeAttribute("src");
    }
    renderPlan();
    renderAttempts();
    remember();
  }
  async function restorePlan(id, preferredJobId) {
    notice("Opening saved music…");
    let plan;
    try { plan = await api(`/plans/${encodeURIComponent(id)}`); }
    catch (error) {
      renderSavedPlans();
      if (error.status === 404) throw new Error(`Saved music ${id} is unavailable. Restore its session bundle or choose another saved track. Your saved selection has been kept.`);
      throw error;
    }
    state.analysis = null;
    // Old tracks can still use their optional recording replay. Their audio does
    // not depend on that recording being available, and original music has none.
    if (plan.analysis_id) {
      try { state.analysis = await api(`/analyses/${encodeURIComponent(plan.analysis_id)}`); }
      catch (_) { /* Shared Connections input and saved audio remain usable. */ }
    }
    applyGenerationSettings(plan.settings);
    if (plan.origin === "original" && [20, 40, 60].includes(plan.duration_seconds)) $("length").value = String(plan.duration_seconds);
    setPlan(plan, preferredJobId || null);
    await refreshLists();
    let job;
    if (preferredJobId) {
      job = state.jobs.find((item) => item.id === preferredJobId && matchesPlan(item, plan));
      if (!job) {
        // Older saved versions can fall outside the recent-jobs listing.
        try {
          const saved = await api(`/generations/${encodeURIComponent(preferredJobId)}`);
          if (matchesPlan(saved, plan)) { job = saved; state.jobs.push(saved); }
        } catch (error) { if (error.status !== 404) throw error; }
      }
      if (!job) {
        state.currentJob = null;
        $("audio").pause(); $("audio").removeAttribute("src");
        renderAttempts(); updateActions(); remember();
        throw new Error(`Saved track ${preferredJobId} is unavailable. Restore its session bundle or choose another saved version. Your saved selection has been kept.`);
      }
    } else job = state.jobs.find((item) => matchesPlan(item, plan) && item.state === "complete") || state.jobs.find((item) => matchesPlan(item, plan));
    if (job) chooseAttempt(job.id);
    schedulePoll();
    notice("Saved music restored. Play it below or generate an original starting track from your musical direction.");
  }
  function renderPlan() {
    const issues = [...new Set([...list(state.plan?.blocking_reasons), ...list(state.plan?.warnings)].map(message))];
    $("quality").hidden = !issues.length;
    $("quality").classList.toggle("is-error", Boolean(state.plan?.blocking_reasons?.length));
    $("quality").innerHTML = issues.map((issue) => `<p>${escapeHTML(issue)}</p>`).join("");
    updateActions();
  }
  function renderStatus() {
    const status = state.status;
    $("setup").classList.toggle("is-error", !status?.ready);
    $("setup").textContent = status?.ready ? "Ready to generate" :
      list(status?.setup_errors).map(message).join(" ") || "The local generation service is not ready. Check the dashboard server configuration.";
    updateActions();
  }
  function planJobs() { return state.jobs.filter((job) => matchesPlan(job, state.plan)); }
  function originalJobs() { return state.plan?.origin === "original" && !state.dirty ? planJobs() : []; }
  function updateActions() {
    syncRealtime();
    if (!root) return;
    const jobs = originalJobs();
    const complete = jobs.find((job) => job.state === "complete");
    const running = jobs.find((job) => ACTIVE_STATES.has(job.state));
    const blocked = state.jobs.some(hasPendingWork);
    $("generate").disabled = state.busy || (!jobs.length && (!state.status?.ready || blocked));
    $("generate").textContent = complete ? "Use saved music · no new charge" : running ? "View generation in progress" : jobs.length ? "View previous attempt · no retry" : "Generate original music & stems · uses credits";
    $("variation").hidden = jobs.length === 0;
    $("variation").disabled = state.busy || !state.status?.ready || blocked || !jobs.length;
    $("generation-note").textContent = complete ? "This music is saved. Another version creates new music and separates its stems; both use credits." : jobs.some((job) => job.state === "unknown") ?
      "An earlier outcome is unknown and may have used credits. Generate another version starts a deliberate new attempt." : running ?
      "Generation is in progress. Stems will be separated automatically; both generation and separation use credits." : blocked ?
      "Wait for the current music or stem request to finish before creating a new track." :
      `${$("length").value || 20} seconds of original music. Music generation and automatic stem separation both use ElevenLabs credits.`;
  }
  async function refreshLists() {
    const results = await Promise.all([api("/generations"), api("/plans")]);
    state.jobs = list(results[0].jobs).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    state.plans = list(results[1].plans);
    renderSavedPlans();
    if (state.currentJob) state.currentJob = state.jobs.find((job) => job.id === state.currentJob.id) || state.currentJob;
    renderAttempts();
    updateActions();
  }
  function renderSavedPlans() {
    const selected = state.plan?.id || state.unavailablePlanId;
    const missing = selected && !state.plans.some((plan) => plan.id === selected);
    $("saved-plan").innerHTML = '<option value="">Choose saved music…</option>'
      + (missing ? `<option value="${escapeHTML(selected)}">${escapeHTML(state.plan ? musicLabel(state.plan) : `Saved music unavailable · ${selected}`)}</option>` : "")
      + state.plans.map((plan) => `<option value="${escapeHTML(plan.id)}">${escapeHTML(musicLabel(plan))}</option>`).join("");
    $("saved-plan").value = selected || "";
  }
  async function generate(variation) {
    // Capture and validate the user's direction before the first request. Creating
    // the local plan is free; only this explicit button action submits generation.
    const request = originalPlanRequest($("length").value, mappingSettings());
    let existing = originalJobs();
    if (variation && !existing.length) throw new Error("Choose an existing original track before making another version.");
    if (!existing.length || variation) {
      if (!state.status?.ready) throw new Error("The music service is not ready. Check the connection status above.");
      if (state.jobs.some(hasPendingWork)) throw new Error("Wait for the current music or stem request to finish.");
    }
    if (state.plan?.origin !== "original" || state.dirty) {
      notice("Preparing your original music…");
      const plan = await api("/plans", request);
      if (!plan.can_generate) throw new Error(list(plan.blocking_reasons).map(message).join(" ") || "These musical settings cannot be generated.");
      state.analysis = null;
      setPlan(plan);
      await refreshLists();
      existing = originalJobs();
    }
    if (!variation && existing.length) {
      const saved = existing.find((job) => job.state === "complete") || existing[0];
      chooseAttempt(saved.id);
      schedulePoll();
      notice(saved.state === "complete" ? "Loaded saved music. No new generation request was sent." : "Showing the saved attempt. No new generation request was sent.");
      return;
    }
    notice(variation ? "Starting a new version of your original music…" : "Generating original music from your direction…");
    // No retry: a lost response can still represent a billable provider attempt.
    let job;
    try { job = await api("/generations", { plan_id: state.plan.id, variation }); }
    catch (error) {
      try { await refreshLists(); schedulePoll(); } catch (_) { /* Reopening the tab will refresh saved state. */ }
      throw new Error(`${error.message} No automatic retry was made. Check saved music before requesting another version.`);
    }
    state.currentJob = job;
    await refreshLists();
    chooseAttempt(job.id);
    schedulePoll();
    notice(job.state === "complete" ? "Saved music was reused." : job.reused ? "Showing the existing attempt. No new generation request was sent." : "Original music is generating. Its stems will be separated automatically for live mappings.");
  }
  function renderAttempts() {
    const jobs = planJobs();
    const completed = jobs.filter((job) => job.state === "complete");
    const label = (job) => musicLabel(job, state.plan || {});
    const options = completed.map((job) => `<option value="${escapeHTML(job.id)}">${escapeHTML(label(job))}</option>`).join("");
    const alternatives = completed.filter((job) => job.id !== state.currentJob?.id);
    const compareValue = $("compare").value;
    $("attempt").innerHTML = (state.unavailableJobId ? `<option value="${escapeHTML(state.unavailableJobId)}">Saved track unavailable · ${escapeHTML(state.unavailableJobId)}</option>` : "") + options;
    if (state.unavailableJobId) $("attempt").value = state.unavailableJobId;
    $("compare").innerHTML = '<option value="">Select another saved attempt</option>' + alternatives.map((job) => `<option value="${escapeHTML(job.id)}">${escapeHTML(label(job))}</option>`).join("");
    if (alternatives.some((job) => job.id === compareValue)) $("compare").value = compareValue;
    else if (completed.length > 1) $("compare").value = alternatives[0]?.id || "";
    $("swap").disabled = completed.length < 2;
    $("listen").hidden = completed.length === 0 || Boolean(state.unavailableJobId);
    if (state.currentJob?.state === "complete") $("attempt").value = state.currentJob.id;
    $("attempts").innerHTML = jobs.length ? `<div class="el-attempts-heading">Saved versions</div>${jobs.map((job) => `<button class="el-attempt ${job.id === state.currentJob?.id ? "is-selected" : ""}" data-job="${escapeHTML(job.id)}" type="button"><span>${escapeHTML(label(job))}</span><b class="el-state-${escapeHTML(job.state)}">${escapeHTML(job.state)}</b></button>`).join("")}` : "";
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
    state.unavailableJobId = null;
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
    } else {
      audio.pause();
      audio.removeAttribute("src");
      $("listen").hidden = true;
    }
    renderAttempts();
    if (job.state !== "complete") $("listen").hidden = true;
    syncPlayback();
    remember();
    syncRealtime();
  }
  function syncPlayback() {
    const audio = $("audio");
    $("playback").textContent = audio.getAttribute("src") ? `${seconds(audio.currentTime)} · saved music preview` : "Choose saved music to listen.";
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
  async function activate() {
    init();
    if (!state.initialized || state.active) return;
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
        const saved = remembered();
        state.unavailablePlanId = saved.planId || null;
        state.unavailableJobId = saved.jobId || null;
        const id = saved.planId || state.plans[0]?.id;
        if (id) await task(() => restorePlan(id, saved.jobId));
        if (saved.generationSettings) {
          const planned = JSON.stringify(readGenerationSettings());
          applyGenerationSettings(saved.generationSettings);
          if (state.plan && JSON.stringify(readGenerationSettings()) !== planned) state.dirty = true;
          updateActions();
          remember();
        }
        if ([20, 40, 60].includes(Number(saved.durationSeconds))) {
          if (Number($("length").value) !== Number(saved.durationSeconds)) state.dirty = true;
          $("length").value = String(saved.durationSeconds);
          updateActions();
          remember();
        }
        $("create").open = true;
        state.loaded = true;
      }
      schedulePoll();
    } catch (error) { notice(error.message, true); $("setup").textContent = error.message; }
  }
  function deactivate() {
    state.active = false;
    globalThis.HydraElevenRealtime?.deactivate();
    clearTimeout(state.timer);
    stopAnimation();
    if (state.initialized) $("audio").pause();
  }

  return { init, activate, deactivate, flush, showView, sectionAt, canGenerate, matchesPlan, hasPendingWork, validateGenerationSettings, originalPlanRequest, musicLabel };
})();
