"use strict";

globalThis.HydraRapResponse = (() => {
  const KEY = "hydra.rap-response.v1", API = "/api/rap-response", MAX_BYTES = 1048576;
  const terminal = state => ["complete", "failed", "unknown", "cancelled"].includes(state);
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const idOK = value => typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(value);
  const urlFor = (job, mode = "mix") => {
    const url = mode === "vocals" ? job?.vocal_audio_url : job?.audio_url;
    const expected = `${API}/responses/${job?.id}/${mode === "vocals" ? "vocals/" : ""}audio`;
    return idOK(job?.id) && url === expected && (mode !== "vocals" || job.vocal_state === "complete") ? url : "";
  };
  const uid = () => globalThis.crypto?.randomUUID?.() || `response-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Optional study hooks never interrupt an existing recording or performance.
  const study = (type, payload) => { try { globalThis.HydraStudy?.emit?.(type, payload); } catch (_) {} };
  const studyContext = () => { try { return { ...globalThis.HydraStudy?.getContext?.() }; } catch (_) { return {}; } };
  const short = value => typeof value === "string" ? value.slice(0, 12000) : null;
  const vocalPresets = { deep_hiphop: "Deep Hip-Hop Voice", emo_trap: "Emo Trap Autotune" };
  const voices = { eva: "Eva", cold_android: "Cold Android", peter: "Peter", elowen: "Elowen", maisie: "Maisie", warren: "Warren" };
  const demoSet = "contrasting-voices-2026-10-19";
  const voiceLabel = value => Object.hasOwn(voices, value?.voice) ? voices[value.voice] : value?.voice ? "Unavailable voice" : Object.hasOwn(vocalPresets, value?.vocal_preset) ? vocalPresets[value.vocal_preset] : value?.vocal_preset ? "Unavailable voice preset" : "Original generated voice";
  const numberIn = (value, min, max, fallback) => Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback;
  const effects = (value = {}) => ({ autotune_amount: numberIn(value.autotune_amount, 0, 1, 0), pitch_semitones: numberIn(value.pitch_semitones, -12, 12, 0),
    key: Number.isInteger(Number(value.key)) ? numberIn(value.key, 0, 11, 0) : 0, scale: ["major", "minor", "chromatic"].includes(value.scale) ? value.scale : "minor",
    melody: ["follow", "drone", "two_note", "rising", "falling", "arpeggio", "hook"].includes(value.melody) ? value.melody : "follow",
    octave: [2, 3, 4, 5].includes(Number(value.octave)) ? Number(value.octave) : 3, note_beats: [.5, 1, 2].includes(Number(value.note_beats)) ? Number(value.note_beats) : 1 });
  const settings = value => ({ bpm: Number.isFinite(Number(value.bpm)) && Number(value.bpm) >= 70 && Number(value.bpm) <= 140 ? Number(value.bpm) : 95,
    style: ["boom_bap", "trap", "lofi"].includes(value.style) ? value.style : "boom_bap", bars: Number(value.bars) === 8 ? 8 : 4, output_mode: value.output_mode === "mix" ? "mix" : "vocals",
    vocal_preset: "", voice: Object.hasOwn(voices, value.voice) ? value.voice : "eva", text_mode: value.text_mode === "lyrics" ? "lyrics" : "reply", effects: effects(value.effects && typeof value.effects === "object" ? value.effects : {}) });
  // Recovery preserves the submitted identity and effects, even if this UI no longer offers them.
  // Do not introduce new fields into legacy requests: they belong to the original paid request.
  const submittedSettings = value => {
    const { voice, text_mode, effects, ...legacy } = settings(value);
    return { ...legacy, vocal_preset: typeof value.vocal_preset === "string" ? value.vocal_preset : "",
      ...(Object.hasOwn(value, "voice") ? { voice: value.voice } : {}), ...(Object.hasOwn(value, "text_mode") ? { text_mode: value.text_mode } : {}),
      ...(Object.hasOwn(value, "effects") ? { effects: value.effects && typeof value.effects === "object" ? { ...value.effects } : value.effects } : {}) };
  };
  const effectControls = ["pitch", "autotune", "key", "scale", "melody", "octave", "note-beats"];
  const label = state => ({ queued: "Queued", transcribing: "Listening to your message…", writing: "Writing a rhyming reply…", generating: "Performing the rap with music…", isolating: "Separating the rap voice from its generated beat…", converting: "Performing in your chosen voice…", rendering: "Applying your voice settings…", complete: "Rap ready", failed: "Could not make this rap", unknown: "Generation was interrupted", cancelled: "Cancelled" })[state] || "";
  let root, active = false, initialized = false, ready = null, transcriptionReady = null, beforeListen = () => {}, beforePlay = () => {}, getBackingClock = () => null, unlockBacking = async () => {};
  let life = 0, jobRun = 0, playRun = 0, controller, poll, busy = false, pending = null, selected = "", job = null, library = [];
  let context, source, gain, clockPoll, playbackMode = "mix", startedAt = null, playing = false, loading = false, autoplay = "", capture = null, creation = null;
  let studyPlayback = null, studyJob = "";
  let demo = null, demoMessage = "", demoError = false;
  const studyRequests = new Map();
  function studyHeaders(path, body) {
    let requestId = body?.request_id;
    const route = /^\/(requests|responses)\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(path);
    if (route?.[1] === "requests") requestId = route[2];
    else if (route && !requestId) requestId = [pending, job, ...library].find(value => value?.id === route[2])?.request_id;
    const origin = studyRequests.get(requestId), headers = {};
    for (const [key, header] of [["session_id", "X-Study-Session"], ["client_id", "X-Study-Client"]]) {
      if (typeof origin?.[key] === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(origin[key])) headers[header] = origin[key];
    }
    return headers;
  }
  const $ = name => root.querySelector(`[data-rr-${name}]`);
  const current = token => active && token === life;
  const draft = () => ({ text: $("text").value.slice(0, 1000), ...settings({ bpm: $("bpm").value, style: $("style").value, bars: $("bars").value, output_mode: $("mode").value, voice: $("voice").value, text_mode: $("text-mode").value,
    effects: { autotune_amount: Number($("autotune").value) / 100, pitch_semitones: $("pitch").value, key: $("key").value, scale: $("scale").value,
      melody: $("melody").value, octave: $("octave").value, note_beats: $("note-beats").value } }), auto_play: $("auto").checked, volume: Number($("volume").value) });
  function status(message, error = false) { $("status").textContent = message; $("status").classList.toggle("is-error", error); if (error) study("rap.error", { message: short(message), job_id: job?.id || null, request_id: pending?.request_id || null }); }
  function setEffects(value) {
    $("autotune").value = String(Math.round(value.autotune_amount * 100)); $("pitch").value = String(value.pitch_semitones);
    for (const name of ["key", "scale", "melody", "octave"]) $(name).value = String(value[name]);
    $("note-beats").value = String(value.note_beats);
  }
  function getState() {
    if (!initialized) return {};
    const savedPending = pending ? { request_id: pending.request_id, ...submittedSettings(pending), ...(pending.id ? { id: pending.id } : {}), ...(pending.isolation ? { isolation: true } : {}), ...(pending.effects_source_id ? { effects_source_id: pending.effects_source_id } : {}),
      ...(typeof pending.text === "string" ? { text: pending.text } : { recorded: true }) } : null;
    return { ...draft(), response_id: selected, pending: savedPending };
  }
  function flush({ strict = false } = {}) {
    if (!initialized) return;
    try { localStorage.setItem(KEY, JSON.stringify(getState())); }
    catch (error) { if (strict) throw error; }
  }
  async function request(path, body) {
    const abort = new AbortController(), parent = controller?.signal;
    let timedOut = false;
    const cancelRequest = () => abort.abort(), timer = setTimeout(() => { timedOut = true; abort.abort(); }, 30000);
    parent?.addEventListener("abort", cancelRequest, { once: true }); if (parent?.aborted) abort.abort();
    try {
      const response = await fetch(`${API}${path}`, { method: body === undefined ? "GET" : "POST", signal: abort.signal,
        headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...studyHeaders(path, body) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.error || "The response could not be loaded."), { status: response.status });
      return value;
    } catch (error) { if (timedOut) throw new Error("The server took too long to respond."); throw error; }
    finally { clearTimeout(timer); parent?.removeEventListener("abort", cancelRequest); }
  }
  async function createResponse(payload, path = "/responses") {
    const submitted = request(path, payload); creation = submitted;
    try { return await submitted; } finally { if (creation === submitted) creation = null; }
  }
  function render() {
    if (!initialized) return;
    const working = busy || !!pending || !!capture, value = draft(), direct = value.text_mode === "lyrics", words = value.text.trim().split(/\s+/).filter(Boolean).length;
    $("record-row").hidden = direct;
    $("text-label").textContent = direct ? "Words to rap" : "Or type something";
    $("text").placeholder = direct ? "Type the exact words you want performed…" : "I missed the bus and now I’m late…";
    $("text-hint").textContent = direct ? `Your words are used as the lyrics. ${words} / ${value.bars * 12} words for ${value.bars} bars.` : "The reply responds to your message with original rhymes.";
    $("text-hint").classList.toggle("is-error", direct && words > value.bars * 12);
    $("pitch-value").textContent = `${value.effects.pitch_semitones > 0 ? "+" : ""}${value.effects.pitch_semitones} semitones`;
    $("autotune-value").textContent = `${Math.round(value.effects.autotune_amount * 100)}%`;
    $("record").textContent = capture?.phase === "recording" ? "Finish & rap" : capture?.phase === "processing" ? "Preparing recording…" : capture ? "Opening microphone…" : "Record a message";
    $("record").disabled = direct || !active || !capture && (ready === false || transcriptionReady === false) || busy || !!pending || !!capture && capture.phase !== "recording";
    $("generate").textContent = pending ? "Recover response" : direct ? "Rap my words" : "Make rap response";
    $("generate").disabled = !active || busy || !!capture || ready === false && !pending || !pending && !$("text").value.trim();
    $("cancel").hidden = !working;
    $("cancel").disabled = !active;
    $("saved").disabled = working;
    $("play").disabled = !active || !!capture || !urlFor(job, playbackMode) || loading;
    $("play").textContent = loading ? "Loading audio…" : playbackMode === "vocals" ? playing ? "Replay over music" : "Play over main music" : playing ? "Replay rap + beat" : "Play rap + generated beat";
    for (const name of ["mode", "bpm", "style", "bars", "voice", "text-mode", ...effectControls]) $(name).disabled = working;
    $("apply-effects").disabled = !active || working || !job?.can_apply_effects;
    $("reset-effects").disabled = working;
    $("effects-hint").textContent = job?.can_apply_effects ? "Use these settings for your next rap, or apply them to the saved rap without generating again." : "These settings are applied to your next rap.";
    $("result-mode").disabled = !job || loading;
    $("result-mode").value = playbackMode;
    $("isolate").hidden = !urlFor(job) || !!urlFor(job, "vocals") || ![undefined, "not_requested"].includes(job?.vocal_state);
    $("isolate").disabled = !active || working;
    $("stop").disabled = !playing && !loading && !autoplay;
    $("stop").textContent = playbackMode === "vocals" ? "Stop voice" : "Stop mix";
    $("download").hidden = !urlFor(job);
    $("download").href = urlFor(job) || "#";
    $("download-vocals").hidden = !urlFor(job, "vocals");
    $("download-vocals").href = urlFor(job, "vocals") || "#";
    $("transcript").textContent = job?.transcript || "Your words will appear here.";
    $("lyrics").textContent = job?.lyrics || "Your rap will appear here.";
    $("result-label").textContent = job ? `${voiceLabel(job)} · Requested ${job.bpm || 95} BPM · ${({ boom_bap: "Boom bap", trap: "Trap", lofi: "Lo-fi" })[job.style] || "Hip-hop"} · ${job.bars || 4} bars${job.effects?.pitch_semitones ? ` · Pitch ${job.effects.pitch_semitones > 0 ? "+" : ""}${job.effects.pitch_semitones}` : ""}${job.effects?.autotune_amount ? ` · Autotune ${Math.round(job.effects.autotune_amount * 100)}%` : ""}` : "Rhyming rap, with your music";
    $("now").textContent = playing ? playbackMode === "vocals" ? startedAt !== null ? "Voice starts at the next bar…" : "Rapping over the main music" : "Playing the generated full mix" : loading ? "Loading audio…" : "";
    for (const [voice, name] of Object.entries(voices)) {
      const button = $(`demo-${voice}`), selectedDemo = demo?.metadata.voice === voice;
      button.disabled = !active || !!capture;
      button.textContent = `${selectedDemo ? demo.loading ? "Cancel" : "Stop" : "Play"} ${name}`;
      button.setAttribute("aria-pressed", String(selectedDemo));
      button.setAttribute("aria-label", `${selectedDemo ? demo.loading ? "Cancel" : "Stop" : "Play"} ${name} demo`);
    }
    $("demo-status").textContent = demoMessage;
    $("demo-status").classList.toggle("is-error", demoError);
    const seconds = job?.timings?.total_seconds ?? job?.timings?.ready_seconds;
    const isolationSeconds = job?.timings?.isolating_seconds;
    $("timing").textContent = [Number.isFinite(seconds) ? `${job.state === "complete" ? "Ready in" : "Elapsed"} ${seconds.toFixed(1)} seconds` : "", Number.isFinite(isolationSeconds) ? `Voice separation: ${isolationSeconds.toFixed(1)} seconds` : ""].filter(Boolean).join(" · ");
    $("saved").innerHTML = '<option value="">Choose a saved response…</option>' + library.map(item => `<option value="${escape(item.id)}">${escape((item.transcript || "Recorded message").split("\n")[0].slice(0, 65))} · ${escape(voiceLabel(item))} · ${escape(label(item.state))}</option>`).join("") +
      (selected && !library.some(item => item.id === selected) ? `<option value="${escape(selected)}">Current response</option>` : "");
    $("saved").value = selected;
  }
  async function unlock() {
    context ||= new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    await context.resume(); return context;
  }
  function stop(reason = "stopped") {
    stopDemo(typeof reason === "string" ? reason : "stopped");
    if (studyPlayback) study("rap.playback.stopped", { ...studyPlayback, reason: typeof reason === "string" ? reason : "stopped" });
    studyPlayback = null;
    ++playRun; autoplay = ""; playing = loading = false; startedAt = null; clearTimeout(clockPoll);
    if (source) { source.onended = null; try { source.stop(); } catch (_) {} source.disconnect(); source = null; }
    gain?.disconnect(); gain = null; render();
  }
  function stopDemo(reason = "stopped", outcome = "stopped") {
    const session = demo; demo = null;
    if (!session) return;
    session.abort.abort(); clearTimeout(session.timer);
    if (session.source) { session.source.onended = null; try { session.source.stop(); } catch (_) {} session.source.disconnect(); }
    session.gain?.disconnect();
    const listened = session.startedAt === null ? 0 : Math.max(0, session.audio.currentTime - session.startedAt);
    study(`rap.demo.${outcome}`, { ...session.metadata, reason, duration_seconds: session.duration,
      listened_seconds: session.duration === null ? listened : Math.min(session.duration, listened) });
    demoError = outcome === "failed";
    demoMessage = demoError ? `${session.metadata.label} demo could not be loaded. Try again.` : `${session.metadata.label} demo ${outcome === "ended" ? "finished" : "stopped"}.`;
    render();
  }
  async function playDemo(voice) {
    if (!active || capture || !Object.hasOwn(voices, voice)) return;
    if (demo?.metadata.voice === voice) { stopDemo(); return; }
    stop("demo_requested");
    const session = { abort: new AbortController(), loading: true, startedAt: null, duration: null,
      metadata: { ...studyContext(), demo_id: uid(), demo_set: demoSet, voice, label: voices[voice], audio_url: `/rap-voice-demos/${voice}.wav`, volume: Number($("volume").value) } };
    demo = session; demoError = false; demoMessage = `Loading ${voices[voice]} demo…`;
    study("rap.demo.requested", session.metadata); render();
    try {
      const audio = await unlock();
      if (!active || demo !== session || capture) return;
      session.timer = setTimeout(() => { session.timedOut = true; session.abort.abort(); }, 30000);
      const response = await fetch(session.metadata.audio_url, { signal: session.abort.signal });
      if (!response.ok) throw new Error("The demo audio could not be loaded.");
      const bytes = await response.arrayBuffer();
      if (!active || demo !== session || capture) return;
      if (session.timedOut) throw new Error("The demo took too long to load.");
      clearTimeout(session.timer);
      const buffer = await audio.decodeAudioData(bytes);
      if (!active || demo !== session || capture) return;
      if (audio.state !== "running") throw new Error("Audio playback could not start.");
      session.audio = audio; session.duration = buffer.duration ?? buffer.length / buffer.sampleRate;
      session.source = audio.createBufferSource(); session.source.buffer = buffer;
      session.gain = audio.createGain(); session.gain.gain.value = Number($("volume").value);
      session.source.connect(session.gain); session.gain.connect(audio.destination);
      session.source.onended = () => { if (demo === session) stopDemo("ended", "ended"); };
      session.source.start(0); session.startedAt = audio.currentTime; session.loading = false;
      demoMessage = `Playing ${voices[voice]} demo.`;
      study("rap.demo.started", { ...session.metadata, volume: session.gain.gain.value, duration_seconds: session.duration, audio_start_time: session.startedAt }); render();
    } catch (error) {
      if (demo === session) stopDemo(session.timedOut ? "The demo took too long to load." : short(error.message), "failed");
    }
  }
  const timingReady = clock => !!(clock?.playing && clock.valid && !clock.rateChanging && Number.isFinite(clock.bpm) && clock.bpm > 0 && Number.isFinite(clock.at) && Number.isFinite(clock.beat));
  const clockReady = clock => timingReady(clock) && !!clock.context && !!clock.destination;
  const sameTiming = (clock, origin) => timingReady(clock) && clock.token === origin.token && Math.abs(clock.bpm - origin.bpm) < .01;
  const sameClock = (clock, origin) => clockReady(clock) && clock.context === origin.context && sameTiming(clock, origin);
  function unlockForRequest(mode) { if (mode === "vocals" && getBackingClock()?.playing) void unlockBacking().catch(() => {}); void unlock().catch(() => {}); }
  function watchBacking(origin, token) {
    if (!active || token !== playRun) return;
    if (!sameClock(getBackingClock(), origin) || origin.context.state !== "running") { stop(); status("Main music changed or stopped. Press Play to start the voice with it again."); return; }
    if (startedAt !== null && origin.context.currentTime >= startedAt) {
      if (studyPlayback) study("rap.playback.started", { ...studyPlayback, observed_audio_time: origin.context.currentTime, observation: "audio_clock" });
      startedAt = null; render();
    }
    clockPoll = setTimeout(() => watchBacking(origin, token), 100);
  }
  async function play() {
    if (!active || capture || !urlFor(job, playbackMode)) return;
    stop("rap_play_requested"); const token = playRun, mode = playbackMode, url = urlFor(job, mode); let origin = mode === "vocals" ? { ...getBackingClock() } : null;
    if (mode === "vocals" && !timingReady(origin)) { status("Start the main music in Music mixer or Synth, then press Play over main music."); return; }
    loading = true; render();
    try {
      beforePlay({ output_mode: mode });
      if (mode === "vocals") {
        await unlockBacking();
        if (!active || token !== playRun || capture) return;
        const unlocked = getBackingClock();
        if (!clockReady(unlocked) || !sameTiming(unlocked, origin) || origin.context && unlocked.context !== origin.context) throw new Error("Main music changed while the voice was loading. Press Play to try again.");
        origin = { ...unlocked };
      }
      const audio = mode === "vocals" ? origin.context : await unlock();
      if (mode === "vocals") await audio.resume();
      const response = await fetch(url, { signal: controller?.signal });
      if (!response.ok) throw new Error("The rap audio could not be loaded.");
      const buffer = await audio.decodeAudioData(await response.arrayBuffer());
      if (!active || token !== playRun || capture) return;
      if (audio.state !== "running") throw new Error("Press Play to start audio.");
      if (mode === "vocals" && !sameClock(getBackingClock(), origin)) throw new Error("Main music changed while the voice was loading. Press Play to try again.");
      source = audio.createBufferSource(); source.buffer = buffer;
      gain = audio.createGain(); gain.gain.value = Number($("volume").value); source.connect(gain); gain.connect(mode === "vocals" ? origin.destination : audio.destination);
      source.onended = () => { if (token === playRun) { if (studyPlayback) study("rap.playback.ended", { ...studyPlayback, observed_audio_time: audio.currentTime }); studyPlayback = null; stop("ended"); } };
      startedAt = mode === "vocals" ? globalThis.HydraRap.nextBar(getBackingClock(), audio.currentTime) : null;
      source.start(startedAt ?? 0); playing = true; loading = false; render();
      studyPlayback = { ...studyContext(), job_id: job.id, request_id: job.request_id, mode, audio_url: url,
        audio_start_time: startedAt ?? audio.currentTime, duration_seconds: buffer.duration ?? buffer.length / buffer.sampleRate,
        volume: Number($("volume").value), backing_token: mode === "vocals" ? String(origin.token ?? "").slice(0, 160) : null, backing_bpm: origin?.bpm ?? null };
      study("rap.playback.scheduled", studyPlayback);
      if (startedAt === null) study("rap.playback.started", { ...studyPlayback, observed_audio_time: audio.currentTime, observation: "audio_clock" });
      if (mode === "vocals") { status("Starting the isolated voice on the next bar. Generated timing may drift from the backing beat."); watchBacking(origin, token); }
    } catch (error) { if (token === playRun) { stop(); if (error.name !== "AbortError") status(error.message, true); } }
  }
  function newSettings() {
    const value = settings(draft()), backing = getBackingClock();
    if (value.output_mode === "vocals" && backing?.playing) {
      if (!timingReady(backing)) throw new Error("Wait for the main music tempo to settle before making the rap.");
      if (backing.bpm < 70 || backing.bpm > 140) throw new Error("Set the main music between 70 and 140 BPM before making a rap to match it.");
      value.bpm = Math.round(backing.bpm); $("bpm").value = String(value.bpm);
    }
    return value;
  }
  function accept(value, token, turn) {
    if (!current(token) || turn !== jobRun) return;
    const recorded = { ...studyRequests.get(value.request_id), job_id: value.id, request_id: value.request_id, state: value.state, vocal_state: value.vocal_state || null,
      transcript: short(value.transcript), lyrics: short(value.lyrics), error: short(value.error), ...submittedSettings(value),
      audio_url: urlFor(value) || null, vocal_audio_url: urlFor(value, "vocals") || null, timings: value.timings || null };
    const signature = JSON.stringify(recorded);
    if (signature !== studyJob) { studyJob = signature; study("rap.response.state", recorded); }
    if (job?.id !== value.id || job?.output_mode !== value.output_mode) playbackMode = value.output_mode === "vocals" ? "vocals" : "mix";
    job = value; selected = value.id;
    const index = library.findIndex(item => item.id === value.id);
    if (index < 0) library.unshift(value); else library[index] = value;
    if (pending) pending.id = value.id;
    else if (!terminal(value.state)) pending = { id: value.id, request_id: value.request_id, ...submittedSettings({ ...value, output_mode: value.output_mode || "mix" }), ...(value.state === "isolating" ? { isolation: true } : {}), recorded: true };
    busy = !terminal(value.state);
    status(value.error || label(value.state), ["failed", "unknown"].includes(value.state));
    if (terminal(value.state)) {
      pending = null; clearTimeout(poll);
      const shouldPlay = value.state === "complete" && autoplay === value.request_id && $("auto").checked;
      autoplay = ""; render(); flush(); if (shouldPlay) void play();
    } else {
      render(); flush(); clearTimeout(poll); poll = setTimeout(() => check(value.id, token, turn), 1400);
    }
  }
  async function check(id, token, turn) {
    try { accept(await request(`/responses/${encodeURIComponent(id)}`), token, turn); }
    catch (error) {
      if (current(token) && turn === jobRun && error.name !== "AbortError") {
        busy = false; autoplay = ""; status(`${error.message} Use Recover response to check again.`, true); render();
      }
    }
  }
  async function recover(token, turn, retry = false) {
    const submitted = pending; if (!submitted) return;
    try {
      let value;
      try { value = await request(submitted.id ? `/responses/${encodeURIComponent(submitted.id)}` : `/requests/${encodeURIComponent(submitted.request_id)}`); }
      catch (error) {
        if (error.status !== 404 || !retry || !current(token) || turn !== jobRun) throw error;
        if (submitted.effects_source_id) value = await createResponse({ request_id: submitted.request_id, effects: submitted.effects }, `/responses/${encodeURIComponent(submitted.effects_source_id)}/effects`);
        else {
          if (!submitted.text && !submitted.audio_base64) throw new Error("This recording was not received. Cancel this request, then record again.");
          const { id, recorded, ...payload } = submitted; value = await createResponse(payload);
        }
      }
      if (!current(token) || turn !== jobRun) return;
      if (submitted.isolation && (!value.vocal_state || value.vocal_state === "not_requested")) {
        if (!retry) throw new Error("Voice isolation has not started. Use Recover response to submit the same request.");
        value = await createResponse({}, `/responses/${encodeURIComponent(submitted.id)}/vocals`);
      }
      accept(value, token, turn);
    } catch (error) {
      if (current(token) && turn === jobRun && error.name !== "AbortError") {
        busy = false; autoplay = ""; status(error.status === 404 ? "This request has not been found yet. Use Recover response to check or retry the same request." : error.message, true); render();
      }
    }
  }
  async function submit(input, recordingSettings, recordingSession) {
    if (!active || busy || capture || ready === false && !pending) return;
    if (!pending && !input?.audio_base64 && !$("text").value.trim()) return;
    let chosen;
    try {
      chosen = pending ? null : recordingSettings || newSettings();
      if (chosen?.text_mode === "lyrics") {
        if (input?.audio_base64) throw new Error("Type the words you want rapped, or choose Reply to me to record a message.");
        if ($("text").value.trim().split(/\s+/).length > chosen.bars * 12) throw new Error(`Use up to ${chosen.bars * 12} words for ${chosen.bars} bars, or choose a longer rap.`);
      }
    } catch (error) { status(error.message, true); return; }
    stop("generation_requested"); unlockForRequest(pending?.output_mode || chosen?.output_mode);
    const token = life, turn = ++jobRun, recovery = !!pending;
    if (!pending) pending = { request_id: recordingSession?.request_id || uid(), ...chosen, ...(input?.audio_base64 ? input : { text: $("text").value.trim().slice(0, 1000) }) };
    if (!studyRequests.has(pending.request_id)) {
      studyRequests.set(pending.request_id, recordingSession?.study_context || studyContext());
      if (studyRequests.size > 100) studyRequests.delete(studyRequests.keys().next().value);
    }
    study(recovery ? "rap.response.recovery_requested" : "rap.response.submitted", { ...studyRequests.get(pending.request_id), request_id: pending.request_id,
      capture_id: recordingSession?.capture_id || null, input: input?.audio_base64 ? "microphone" : "text", text: pending.text || null, ...submittedSettings(pending) });
    autoplay = $("auto").checked ? pending.request_id : ""; busy = true; clearTimeout(poll); flush(); render();
    status(recovery ? "Checking the previous request…" : "Starting your rap response…");
    if (recovery) return recover(token, turn, true);
    try { accept(await createResponse(pending), token, turn); }
    catch (error) {
      if (current(token) && turn === jobRun && error.name !== "AbortError") {
        busy = false; autoplay = "";
        if (error.status && error.status >= 400 && error.status < 500) pending = null;
        status(`${error.message}${pending ? " Use Recover response to safely check the same request." : ""}`, true); render(); flush();
      }
    }
  }
  async function applyEffects() {
    if (!active || busy || pending || capture || !job?.can_apply_effects || !idOK(job.id)) return;
    stop("effects_requested"); const sourceJob = job, token = life, turn = ++jobRun, request_id = uid();
    pending = { request_id, ...submittedSettings(sourceJob), effects: draft().effects, effects_source_id: sourceJob.id, recorded: true };
    studyRequests.set(request_id, studyContext());
    study("rap.effects.submitted", { ...studyRequests.get(request_id), request_id, source_response_id: sourceJob.id, ...submittedSettings(pending) });
    autoplay = $("auto").checked ? request_id : ""; busy = true; clearTimeout(poll); flush(); render(); status("Applying your voice settings…");
    unlockForRequest(pending.output_mode);
    try { accept(await createResponse({ request_id, effects: pending.effects }, `/responses/${encodeURIComponent(sourceJob.id)}/effects`), token, turn); }
    catch (error) {
      if (current(token) && turn === jobRun && error.name !== "AbortError") {
        busy = false; autoplay = "";
        if (error.status && error.status >= 400 && error.status < 500) pending = null;
        status(`${error.message}${pending ? " Use Recover response to safely check the same effects request." : ""}`, true); render(); flush();
      }
    }
  }
  async function isolate() {
    if (!active || busy || pending || capture || !urlFor(job) || ![undefined, "not_requested"].includes(job.vocal_state)) return;
    stop(); unlockForRequest("vocals"); playbackMode = "vocals"; const token = life, turn = ++jobRun;
    pending = { id: job.id, request_id: job.request_id, ...submittedSettings({ ...job, output_mode: "vocals" }), isolation: true, recorded: true };
    autoplay = $("auto").checked ? job.request_id : ""; busy = true; clearTimeout(poll); render(); flush(); status("Separating the voice from this saved performance…");
    try { accept(await createResponse({}, `/responses/${encodeURIComponent(job.id)}/vocals`), token, turn); }
    catch (error) { if (current(token) && turn === jobRun && error.name !== "AbortError") { busy = false; autoplay = ""; status(`${error.message} Use Recover response to check the same isolation request.`, true); render(); flush(); } }
  }
  function release(session) { session?.stream?.getTracks().forEach(track => track.stop()); clearTimeout(session?.timer); }
  function retainAudio(session, audio, role) {
    if (!audio?.size && !audio?.byteLength || !globalThis.HydraStudy?.storeAudio) return;
    const metadata = { ...session.study_context, capture_id: session.capture_id, request_id: session.request_id, role,
      outcome: session.outcome || "finished", started_at: session.started_at || null, settings: session.settings };
    try { Promise.resolve(globalThis.HydraStudy.storeAudio(audio, metadata)).catch(error => study("rap.recording.archive_failed", { ...metadata, message: short(error.message) })); }
    catch (error) { study("rap.recording.archive_failed", { ...metadata, message: short(error.message) }); }
  }
  function retainOriginal(session) {
    if (session.archived) return; session.archived = true;
    if (session.chunks.length) retainAudio(session, new Blob(session.chunks, { type: session.recorder?.mimeType || "audio/webm" }), "microphone_original");
  }
  function discardCapture(reason = "cancelled") {
    const session = capture; capture = null; if (!session) return;
    session.outcome = reason;
    study("rap.recording.cancelled", { ...session.study_context, capture_id: session.capture_id, request_id: session.request_id, reason, phase: session.phase });
    // Keep the final dataavailable/onstop callbacks so cancellation also saves
    // the final microphone chunk, without submitting it to transcription.
    if (session.recorder) { try { if (session.recorder.state !== "inactive") session.recorder.stop(); else retainOriginal(session); } catch (_) { retainOriginal(session); } }
    release(session); render();
  }
  // Downmix and resample bounded decoded audio. Weighted bins avoid dropping samples when downsampling.
  function pcm16Wav(buffer) {
    const rate = buffer.sampleRate, channels = buffer.numberOfChannels;
    if (!Number.isFinite(rate) || rate < 8000 || rate > 192000 || !Number.isInteger(channels) || channels < 1 || channels > 8 || !Number.isInteger(buffer.length) || buffer.length < 1 || buffer.length > rate * 31) throw new Error("Record a message of up to 30 seconds.");
    const count = Math.min(480000, Math.floor(buffer.length * 16000 / rate));
    if (count < 1600) throw new Error("The recording is too short. Speak for at least 0.1 seconds, then try again.");
    const bytes = new ArrayBuffer(44 + count * 2), view = new DataView(bytes), data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
    const word = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    word(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); word(8, "WAVE"); word(12, "fmt "); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, "data"); view.setUint32(40, count * 2, true);
    const ratio = rate / 16000;
    for (let i = 0; i < count; i++) {
      const from = i * ratio, to = Math.min(buffer.length, (i + 1) * ratio); let sum = 0;
      for (let index = Math.floor(from); index < Math.ceil(to); index++) {
        const weight = Math.min(to, index + 1) - Math.max(from, index);
        for (const channel of data) sum += (Number.isFinite(channel[index]) ? channel[index] : 0) * weight;
      }
      const sample = Math.max(-1, Math.min(1, sum / ((to - from) * channels)));
      view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    return bytes;
  }
  async function encodeRecording(session) {
    try {
      const blob = new Blob(session.chunks, { type: session.recorder.mimeType });
      if (!blob.size || blob.size > 8 * MAX_BYTES) throw new Error("The recording is empty or too large. Try a shorter message.");
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      if (!active || capture !== session) return;
      const bytes = new Uint8Array(pcm16Wav(decoded)); let binary = "";
      session.outcome = "submitted"; retainAudio(session, new Blob([bytes], { type: "audio/wav" }), "microphone_submission");
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      capture = null; render(); await submit({ audio_base64: btoa(binary) }, session.settings, session);
    } catch (error) { if (capture === session) { discardCapture("encoding_failed"); status(error.message, true); } }
  }
  function finishRecording() {
    if (capture?.phase !== "recording") return;
    const session = capture; session.phase = "processing"; clearTimeout(session.timer); status("Preparing your recorded message…"); render();
    session.outcome = "finished";
    study("rap.recording.finish_requested", { ...session.study_context, capture_id: session.capture_id, request_id: session.request_id, started_at: session.started_at });
    try { session.recorder.stop(); release(session); } catch (error) { discardCapture("microphone_failed"); status(error.message, true); }
  }
  async function record() {
    if (capture?.phase === "recording") { finishRecording(); return; }
    if (!active || busy || pending || capture || ready === false || transcriptionReady === false || $("text-mode").value === "lyrics") return;
    if (!globalThis.navigator?.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) { study("rap.recording.failed", { reason: "unavailable" }); status("Microphone recording is unavailable here. Type a message below.", true); return; }
    let chosen;
    try { chosen = newSettings(); } catch (error) { status(error.message, true); return; }
    stop("recording_requested"); const session = { phase: "permission", chunks: [], size: 0, settings: chosen, study_context: studyContext(), request_id: uid(),
      capture_id: `capture-${Date.now()}-${Math.random().toString(36).slice(2)}` }; capture = session; render();
    study("rap.recording.permission_requested", { ...session.study_context, capture_id: session.capture_id, request_id: session.request_id, settings: chosen });
    try {
      beforeListen({ output_mode: session.settings.output_mode }); unlockForRequest(session.settings.output_mode);
      session.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (!active || capture !== session) { release(session); return; }
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find(type => MediaRecorder.isTypeSupported?.(type));
      session.recorder = new MediaRecorder(session.stream, mimeType ? { mimeType } : {});
      session.recorder.ondataavailable = event => {
        if (session.archived) return;
        session.size += event.data.size;
        if (session.size > 8 * MAX_BYTES) { if (capture === session) { discardCapture("size_limit"); status("The recording is too large. Try a shorter message.", true); } return; }
        if (event.data.size) session.chunks.push(event.data);
      };
      session.recorder.onstop = () => {
        release(session);
        study("rap.recording.finished", { ...session.study_context, capture_id: session.capture_id, request_id: session.request_id,
          started_at: session.started_at || null, outcome: session.outcome || "finished", chunk_count: session.chunks.length, byte_length: session.size });
        retainOriginal(session);
        if (capture === session) { session.phase = "processing"; render(); void encodeRecording(session); }
      };
      session.recorder.onerror = () => { if (capture === session) { study("rap.recording.failed", { ...session.study_context, capture_id: session.capture_id, request_id: session.request_id, reason: "recorder_error" }); discardCapture("microphone_failed"); status("The microphone stopped unexpectedly. Please try again.", true); } };
      session.recorder.start(1000); session.phase = "recording"; session.timer = setTimeout(finishRecording, 30000);
      session.started_at = new Date().toISOString();
      study("rap.recording.started", { ...session.study_context, capture_id: session.capture_id, request_id: session.request_id, started_at: session.started_at, mime_type: session.recorder.mimeType,
        constraints: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, settings: chosen });
      status("Recording… press Finish & rap when you’re done. Maximum 30 seconds."); render();
    } catch (error) {
      release(session);
      study("rap.recording.failed", { ...session.study_context, capture_id: session.capture_id, request_id: session.request_id, reason: error.name, message: short(error.message) });
      if (capture === session) { discardCapture("microphone_failed"); status(error.name === "NotAllowedError" ? "Microphone access was denied. Allow access or type a message below." : error.message, true); }
    }
  }
  async function cancel() {
    stop();
    if (capture) { discardCapture(); status("Recording cancelled."); return; }
    if (!pending && !busy) return;
    const token = life, turn = ++jobRun, submitted = pending; clearTimeout(poll); busy = true; render(); status("Cancelling…");
    try {
      // An in-flight creation must settle before checking whether the server accepted it.
      if (creation) { try { await creation; } catch (_) {} }
      if (!current(token) || turn !== jobRun) return;
      let found = job?.id === submitted?.id ? job : null;
      if (!found && submitted) { try { found = await request(`/requests/${encodeURIComponent(submitted.request_id)}`); } catch (error) { if (error.status !== 404) throw error; } }
      if (!current(token) || turn !== jobRun) return;
      if (found) { accept(await request(`/responses/${encodeURIComponent(found.id)}/cancel`, {}), token, turn); }
      else { pending = null; busy = false; status("Request cancelled."); render(); flush(); }
    } catch (error) { if (current(token) && turn === jobRun) { busy = false; status(error.message, true); render(); } }
  }
  async function load(token) {
    const turn = jobRun;
    const results = await Promise.allSettled([request("/status"), request("/responses")]);
    if (!current(token)) return;
    if (results[0].status === "fulfilled") {
      const config = results[0].value; ready = config.ready !== false; transcriptionReady = config.transcription_ready !== false;
      $("setup").textContent = ready ? "Rap over the main music, or play the complete generated performance." : (config.issues || []).join(" · ") || "Rap responses need service configuration.";
      $("microphone").textContent = transcriptionReady ? "Up to 30 seconds" : (config.transcription_issues || []).join(" · ") || "Local transcription is not ready. Type a message below.";
    } else { $("setup").textContent = results[0].reason.message; }
    if (turn !== jobRun || capture) { render(); return; }
    if (results[1].status === "fulfilled") library = Array.isArray(results[1].value.responses) ? results[1].value.responses : [];
    if (pending) { busy = true; render(); await recover(token, ++jobRun); }
    else if (selected) { await check(selected, token, ++jobRun); }
    else { status(results[1].status === "rejected" ? results[1].reason.message : "Record or type a message to begin.", results[1].status === "rejected"); }
    render();
  }
  function init(options = {}) {
    if (initialized) return api;
    root = options.container || document.querySelector("#rap-response-workspace"); if (!root) return null;
    beforeListen = options.onBeforeListen || beforeListen; beforePlay = options.onBeforePlay || beforePlay; getBackingClock = options.getBackingClock || getBackingClock; unlockBacking = options.unlockBacking || unlockBacking; initialized = true;
    root.classList.add("mm-workspace", "rr-workspace");
    root.innerHTML = `<header class="mm-header"><div><div class="mm-eyebrow">Call & response</div><h1>Rap response</h1><p>Get a rhyming reply, or hear your own words rapped over music.</p></div></header>
      <p class="rr-setup" data-rr-setup></p><div class="rr-grid"><section class="rr-compose" aria-labelledby="rr-message-title"><h2 id="rr-message-title">Your message</h2>
      <label class="rr-input-mode" for="rr-text-mode">What should the rap say?<select id="rr-text-mode" data-rr-text-mode><option value="reply">Reply to me</option><option value="lyrics">Rap my words</option></select></label>
      <div class="rr-record" data-rr-record-row><button type="button" class="mm-button mm-primary" data-rr-record>Record a message</button><span data-rr-microphone>Up to 30 seconds</span></div>
      <label for="rr-text"><span data-rr-text-label>Or type something</span><textarea id="rr-text" data-rr-text rows="4" maxlength="1000" aria-describedby="rr-text-hint" placeholder="I missed the bus and now I’m late…"></textarea></label>
      <p class="rr-hint" id="rr-text-hint" data-rr-text-hint></p>
      <label class="rr-output" for="rr-mode">New response<select id="rr-mode" data-rr-mode><option value="vocals">Over main music · isolated voice</option><option value="mix">With generated beat · full mix</option></select></label>
      <p class="rr-hint">Use headphones when recording over music. The voice starts on the next bar; generated timing can drift.</p>
      <label class="rr-voice" for="rr-voice">Voice for new raps<select id="rr-voice" data-rr-voice aria-describedby="rr-voice-hint">${Object.entries(voices).map(([id, name]) => `<option value="${id}">${name}</option>`).join("")}</select></label>
      <p class="rr-hint" id="rr-voice-hint">Choose from the six voices. Delivery varies with each performance.</p>
      <details class="rr-effects"><summary>Customize the voice</summary><div class="rr-effect-controls">
      <label for="rr-pitch">Pitch shift <output data-rr-pitch-value for="rr-pitch">0 semitones</output><input id="rr-pitch" data-rr-pitch type="range" min="-12" max="12" step="1" value="0"></label>
      <label for="rr-autotune">Autotune <output data-rr-autotune-value for="rr-autotune">0%</output><input id="rr-autotune" data-rr-autotune type="range" min="0" max="100" step="1" value="0"></label>
      <label for="rr-key">Key<select id="rr-key" data-rr-key>${["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"].map((name, key) => `<option value="${key}">${name}</option>`).join("")}</select></label>
      <label for="rr-scale">Scale<select id="rr-scale" data-rr-scale><option value="minor">Minor</option><option value="major">Major</option><option value="chromatic">Chromatic</option></select></label>
      <label for="rr-melody">Melody<select id="rr-melody" data-rr-melody><option value="follow">Follow the voice</option><option value="drone">One note</option><option value="two_note">Two notes</option><option value="rising">Rising</option><option value="falling">Falling</option><option value="arpeggio">Arpeggio</option><option value="hook">Hook</option></select></label>
      <label for="rr-octave">Melody octave<select id="rr-octave" data-rr-octave><option value="2">2 · Low</option><option value="3">3</option><option value="4">4</option><option value="5">5 · High</option></select></label>
      <label for="rr-note-beats">Note length<select id="rr-note-beats" data-rr-note-beats><option value="0.5">Half a beat</option><option value="1">One beat</option><option value="2">Two beats</option></select></label></div>
      <p class="rr-hint">Autotune follows the selected key and melody. Pitch shift transposes the finished vocal.</p>
      <p class="rr-hint" data-rr-effects-hint></p><div class="rr-actions rr-effect-actions"><button type="button" class="mm-button" data-rr-apply-effects disabled>Apply to this rap</button><button type="button" class="mm-button" data-rr-reset-effects>Reset effects</button></div></details>
      <div class="rr-options"><label for="rr-bpm">Requested BPM<input id="rr-bpm" data-rr-bpm type="number" min="70" max="140" step="1"></label>
      <label for="rr-style">Beat style<select id="rr-style" data-rr-style><option value="boom_bap">Boom bap</option><option value="trap">Trap</option><option value="lofi">Lo-fi</option></select></label>
      <label for="rr-bars">Length<select id="rr-bars" data-rr-bars><option value="4">4 bars</option><option value="8">8 bars</option></select></label></div>
      <div class="rr-actions"><button type="button" class="mm-button mm-primary" data-rr-generate>Make rap response</button><button type="button" class="mm-button" data-rr-cancel hidden>Cancel</button></div>
      <label class="rr-check"><input type="checkbox" data-rr-auto> Play when my new response is ready</label><p class="rr-status" data-rr-status role="status" aria-live="polite"></p></section>
      <section class="rr-result" aria-labelledby="rr-result-title"><div class="rr-result-heading"><h2 id="rr-result-title">Your rap</h2><span data-rr-result-label></span></div>
      <h3>You said</h3><p class="rr-transcript" data-rr-transcript></p><h3>The rap</h3><p class="rr-lyrics" data-rr-lyrics></p>
      <div class="rr-playback"><label for="rr-result-mode">Play this response<select id="rr-result-mode" data-rr-result-mode><option value="vocals">Over main music · isolated voice</option><option value="mix">With generated beat · full mix</option></select></label><label for="rr-volume">Rap volume<input id="rr-volume" data-rr-volume type="range" min="0" max="1" step="0.01"></label></div>
      <div class="rr-actions"><button type="button" class="mm-button mm-primary" data-rr-play disabled>Play over main music</button><button type="button" class="mm-button" data-rr-stop disabled>Stop voice</button><button type="button" class="mm-button" data-rr-isolate hidden>Isolate this voice</button></div>
      <div class="rr-downloads"><a data-rr-download download hidden>Download full mix</a><a data-rr-download-vocals download hidden>Download voice</a></div>
      <p class="rr-now" data-rr-now role="status"></p><p class="rr-timing" data-rr-timing></p></section></div>
      <section class="rr-library"><label for="rr-saved">Saved responses<select id="rr-saved" data-rr-saved></select></label><button type="button" class="mm-button" data-rr-refresh>Refresh</button></section>
      <details id="rr-demos" class="rr-demos" data-rr-demos><summary>Voice demos</summary>
      <p class="rr-hint" id="rr-demos-hint">Listen without generating. Demos use the original voice, without your effects.</p>
      <div class="rr-demo-buttons" aria-describedby="rr-demos-hint">${Object.entries(voices).map(([id, name]) => `<button type="button" class="mm-button" data-rr-demo-${id} aria-pressed="false" aria-label="Play ${name} demo">Play ${name}</button>`).join("")}</div>
      <p class="rr-demo-status" data-rr-demo-status role="status" aria-live="polite"></p></details>`;
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (_) {}
    if (!saved || typeof saved !== "object") saved = {};
    const defaults = settings(saved); $("text").value = typeof saved.text === "string" ? saved.text.slice(0, 1000) : "";
    for (const name of ["bpm", "style", "bars"]) $(name).value = String(defaults[name]);
    $("mode").value = defaults.output_mode;
    $("voice").value = defaults.voice; $("text-mode").value = defaults.text_mode; setEffects(defaults.effects);
    $("volume").value = String(Number.isFinite(saved.volume) ? Math.max(0, Math.min(1, saved.volume)) : .85);
    $("auto").checked = saved.auto_play !== false; selected = typeof saved.response_id === "string" ? saved.response_id : "";
    if (idOK(saved.pending?.request_id)) pending = { request_id: saved.pending.request_id, ...submittedSettings({ ...saved.pending, output_mode: saved.pending.output_mode || "mix" }), ...(saved.pending.isolation ? { isolation: true } : {}), ...(idOK(saved.pending.effects_source_id) ? { effects_source_id: saved.pending.effects_source_id } : {}),
      ...(typeof saved.pending.id === "string" ? { id: saved.pending.id } : {}), ...(typeof saved.pending.text === "string" ? { text: saved.pending.text.slice(0, 1000) } : { recorded: true }) };
    $("record").addEventListener("click", record); $("generate").addEventListener("click", () => submit()); $("cancel").addEventListener("click", cancel);
    $("isolate").addEventListener("click", isolate);
    $("apply-effects").addEventListener("click", applyEffects);
    $("reset-effects").addEventListener("click", () => { if (busy || pending || capture) return; setEffects(effects()); render(); flush(); });
    $("result-mode").addEventListener("change", () => { const mode = $("result-mode").value; stop(); playbackMode = mode === "vocals" ? "vocals" : "mix"; render(); if (playbackMode === "vocals" && !urlFor(job, "vocals")) status(job?.vocal_state === "failed" || job?.vocal_state === "unknown" || job?.vocal_state === "cancelled" ? "Voice isolation did not complete. The full mix is still available." : "Use Isolate this voice to separate the rap from its generated beat."); });
    $("volume").addEventListener("input", () => { if (gain) gain.gain.value = Number($("volume").value); if (demo?.gain) demo.gain.gain.value = Number($("volume").value); flush(); });
    $("play").addEventListener("click", play); $("stop").addEventListener("click", stop);
    for (const voice of Object.keys(voices)) $(`demo-${voice}`).addEventListener("click", () => playDemo(voice));
    $("demos").addEventListener("toggle", () => { if (!$("demos").open) stopDemo("collapsed"); });
    $("refresh").addEventListener("click", () => { if (active && !busy && !capture) return load(life); });
    $("saved").addEventListener("change", async () => {
      if (!active || busy || pending || capture) { render(); return; }
      const id = $("saved").value, turn = ++jobRun; stop(); clearTimeout(poll); selected = id; job = null; render(); flush();
      if (selected) await check(selected, life, turn);
    });
    for (const name of ["text", "bpm", "style", "bars", "mode", "voice", "text-mode", ...effectControls]) $(name).addEventListener(["text", "bpm", "pitch", "autotune"].includes(name) ? "input" : "change", () => { render(); flush(); });
    $("auto").addEventListener("change", () => { if (!$("auto").checked) stop(); flush(); });
    render(); return api;
  }
  function activate() { if (!initialized) init(); if (!initialized || active) return; active = true; controller = new AbortController(); render(); return load(++life); }
  function deactivate() { if (!initialized) return; active = false; ++life; ++jobRun; stop("deactivated"); discardCapture("deactivated"); clearTimeout(poll); controller?.abort(); busy = false; flush(); }
  const api = { init, activate, deactivate, flush, stop, getState, pcm16Wav };
  return api;
})();
