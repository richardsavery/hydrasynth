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
  const vocalPresets = { deep_hiphop: "Deep Hip-Hop Voice", emo_trap: "Emo Trap Autotune" };
  const voiceLabel = value => Object.hasOwn(vocalPresets, value?.vocal_preset) ? vocalPresets[value.vocal_preset] : value?.vocal_preset ? "Unavailable voice preset" : "Original generated voice";
  const settings = value => ({ bpm: Number.isFinite(Number(value.bpm)) && Number(value.bpm) >= 70 && Number(value.bpm) <= 140 ? Number(value.bpm) : 95,
    style: ["boom_bap", "trap", "lofi"].includes(value.style) ? value.style : "boom_bap", bars: Number(value.bars) === 8 ? 8 : 4, output_mode: value.output_mode === "mix" ? "mix" : "vocals",
    vocal_preset: Object.hasOwn(vocalPresets, value.vocal_preset) ? value.vocal_preset : "" });
  // A submitted request keeps its original voice, including a preset this UI no longer offers.
  // The server can reject an unavailable preset; recovery must never silently select another voice.
  const submittedSettings = value => ({ ...settings(value), vocal_preset: typeof value.vocal_preset === "string" ? value.vocal_preset : "" });
  const label = state => ({ queued: "Queued", transcribing: "Listening to your message…", writing: "Writing a rhyming reply…", generating: "Performing the rap with music…", isolating: "Separating the rap voice from its generated beat…", complete: "Rap ready", failed: "Could not make this rap", unknown: "Generation was interrupted", cancelled: "Cancelled" })[state] || "";
  let root, active = false, initialized = false, ready = null, transcriptionReady = null, beforeListen = () => {}, beforePlay = () => {}, getBackingClock = () => null, unlockBacking = async () => {};
  let life = 0, jobRun = 0, playRun = 0, controller, poll, busy = false, pending = null, selected = "", job = null, library = [];
  let context, source, gain, clockPoll, playbackMode = "mix", startedAt = null, playing = false, loading = false, autoplay = "", capture = null, creation = null;
  const $ = name => root.querySelector(`[data-rr-${name}]`);
  const current = token => active && token === life;
  const draft = () => ({ text: $("text").value.slice(0, 1000), ...settings({ bpm: $("bpm").value, style: $("style").value, bars: $("bars").value, output_mode: $("mode").value, vocal_preset: $("voice").value }), auto_play: $("auto").checked, volume: Number($("volume").value) });
  function status(message, error = false) { $("status").textContent = message; $("status").classList.toggle("is-error", error); }
  function getState() {
    if (!initialized) return {};
    const savedPending = pending ? { request_id: pending.request_id, ...submittedSettings(pending), ...(pending.id ? { id: pending.id } : {}), ...(pending.isolation ? { isolation: true } : {}),
      ...(typeof pending.text === "string" ? { text: pending.text } : { recorded: true }) } : null;
    return { ...draft(), response_id: selected, pending: savedPending };
  }
  function flush() { if (initialized) { try { localStorage.setItem(KEY, JSON.stringify(getState())); } catch (_) {} } }
  async function request(path, body) {
    const abort = new AbortController(), parent = controller?.signal;
    let timedOut = false;
    const cancelRequest = () => abort.abort(), timer = setTimeout(() => { timedOut = true; abort.abort(); }, 30000);
    parent?.addEventListener("abort", cancelRequest, { once: true }); if (parent?.aborted) abort.abort();
    try {
      const response = await fetch(`${API}${path}`, { method: body === undefined ? "GET" : "POST", signal: abort.signal,
        headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
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
    const working = busy || !!pending || !!capture;
    $("record").textContent = capture?.phase === "recording" ? "Finish & rap" : capture?.phase === "processing" ? "Preparing recording…" : capture ? "Opening microphone…" : "Record a message";
    $("record").disabled = !active || !capture && (ready === false || transcriptionReady === false) || busy || !!pending || !!capture && capture.phase !== "recording";
    $("generate").textContent = pending ? "Recover response" : "Make rap response";
    $("generate").disabled = !active || busy || !!capture || ready === false && !pending || !pending && !$("text").value.trim();
    $("cancel").hidden = !working;
    $("cancel").disabled = !active;
    $("saved").disabled = working;
    $("play").disabled = !active || !!capture || !urlFor(job, playbackMode) || loading;
    $("play").textContent = loading ? "Loading audio…" : playbackMode === "vocals" ? playing ? "Replay over music" : "Play over main music" : playing ? "Replay rap + beat" : "Play rap + generated beat";
    for (const name of ["mode", "bpm", "style", "bars", "voice"]) $(name).disabled = working;
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
    $("transcript").textContent = job?.transcript || "Your message will appear here.";
    $("lyrics").textContent = job?.lyrics || "Your rhyming reply will appear here.";
    $("result-label").textContent = job ? `${voiceLabel(job)} · Requested ${job.bpm || 95} BPM · ${({ boom_bap: "Boom bap", trap: "Trap", lofi: "Lo-fi" })[job.style] || "Hip-hop"} · ${job.bars || 4} bars` : "Rhyming rap, with your music";
    $("now").textContent = playing ? playbackMode === "vocals" ? startedAt !== null ? "Voice starts at the next bar…" : "Rapping over the main music" : "Playing the generated full mix" : loading ? "Loading audio…" : "";
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
  function stop() {
    ++playRun; autoplay = ""; playing = loading = false; startedAt = null; clearTimeout(clockPoll);
    if (source) { source.onended = null; try { source.stop(); } catch (_) {} source.disconnect(); source = null; }
    gain?.disconnect(); gain = null; render();
  }
  const timingReady = clock => !!(clock?.playing && clock.valid && !clock.rateChanging && Number.isFinite(clock.bpm) && clock.bpm > 0 && Number.isFinite(clock.at) && Number.isFinite(clock.beat));
  const clockReady = clock => timingReady(clock) && !!clock.context && !!clock.destination;
  const sameTiming = (clock, origin) => timingReady(clock) && clock.token === origin.token && Math.abs(clock.bpm - origin.bpm) < .01;
  const sameClock = (clock, origin) => clockReady(clock) && clock.context === origin.context && sameTiming(clock, origin);
  function unlockForRequest(mode) { if (mode === "vocals" && getBackingClock()?.playing) void unlockBacking().catch(() => {}); void unlock().catch(() => {}); }
  function watchBacking(origin, token) {
    if (!active || token !== playRun) return;
    if (!sameClock(getBackingClock(), origin) || origin.context.state !== "running") { stop(); status("Main music changed or stopped. Press Play to start the voice with it again."); return; }
    if (startedAt !== null && origin.context.currentTime >= startedAt) { startedAt = null; render(); }
    clockPoll = setTimeout(() => watchBacking(origin, token), 100);
  }
  async function play() {
    if (!active || capture || !urlFor(job, playbackMode)) return;
    stop(); const token = playRun, mode = playbackMode, url = urlFor(job, mode); let origin = mode === "vocals" ? { ...getBackingClock() } : null;
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
      source.onended = () => { if (token === playRun) stop(); };
      startedAt = mode === "vocals" ? globalThis.HydraRap.nextBar(getBackingClock(), audio.currentTime) : null;
      source.start(startedAt ?? 0); playing = true; loading = false; render();
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
        if (!submitted.text && !submitted.audio_base64) throw new Error("This recording was not received. Cancel this request, then record again.");
        const { id, recorded, ...payload } = submitted; value = await createResponse(payload);
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
  async function submit(input, recordingSettings) {
    if (!active || busy || capture || ready === false && !pending) return;
    if (!pending && !input?.audio_base64 && !$("text").value.trim()) return;
    let chosen;
    try { chosen = pending ? null : recordingSettings || newSettings(); } catch (error) { status(error.message, true); return; }
    stop(); unlockForRequest(pending?.output_mode || chosen?.output_mode);
    const token = life, turn = ++jobRun, recovery = !!pending;
    if (!pending) pending = { request_id: uid(), ...chosen, ...(input?.audio_base64 ? input : { text: $("text").value.trim().slice(0, 1000) }) };
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
  async function isolate() {
    if (!active || busy || pending || capture || !urlFor(job) || ![undefined, "not_requested"].includes(job.vocal_state)) return;
    stop(); unlockForRequest("vocals"); playbackMode = "vocals"; const token = life, turn = ++jobRun;
    pending = { id: job.id, request_id: job.request_id, ...submittedSettings({ ...job, output_mode: "vocals" }), isolation: true, recorded: true };
    autoplay = $("auto").checked ? job.request_id : ""; busy = true; clearTimeout(poll); render(); flush(); status("Separating the voice from this saved performance…");
    try { accept(await createResponse({}, `/responses/${encodeURIComponent(job.id)}/vocals`), token, turn); }
    catch (error) { if (current(token) && turn === jobRun && error.name !== "AbortError") { busy = false; autoplay = ""; status(`${error.message} Use Recover response to check the same isolation request.`, true); render(); flush(); } }
  }
  function release(session) { session?.stream?.getTracks().forEach(track => track.stop()); clearTimeout(session?.timer); }
  function discardCapture() {
    const session = capture; capture = null; if (!session) return;
    if (session.recorder) { session.recorder.ondataavailable = session.recorder.onstop = session.recorder.onerror = null; try { if (session.recorder.state !== "inactive") session.recorder.stop(); } catch (_) {} }
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
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      capture = null; render(); await submit({ audio_base64: btoa(binary) }, session.settings);
    } catch (error) { if (capture === session) { discardCapture(); status(error.message, true); } }
  }
  function finishRecording() {
    if (capture?.phase !== "recording") return;
    const session = capture; session.phase = "processing"; clearTimeout(session.timer); status("Preparing your recorded message…"); render();
    try { session.recorder.stop(); release(session); } catch (error) { discardCapture(); status(error.message, true); }
  }
  async function record() {
    if (capture?.phase === "recording") { finishRecording(); return; }
    if (!active || busy || pending || capture || ready === false || transcriptionReady === false) return;
    if (!globalThis.navigator?.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) { status("Microphone recording is unavailable here. Type a message below.", true); return; }
    let chosen;
    try { chosen = newSettings(); } catch (error) { status(error.message, true); return; }
    stop(); const session = { phase: "permission", chunks: [], size: 0, settings: chosen }; capture = session; render();
    try {
      beforeListen({ output_mode: session.settings.output_mode }); unlockForRequest(session.settings.output_mode);
      session.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (!active || capture !== session) { release(session); return; }
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find(type => MediaRecorder.isTypeSupported?.(type));
      session.recorder = new MediaRecorder(session.stream, mimeType ? { mimeType } : {});
      session.recorder.ondataavailable = event => {
        if (capture !== session) return;
        session.size += event.data.size;
        if (session.size > 8 * MAX_BYTES) { discardCapture(); status("The recording is too large. Try a shorter message.", true); return; }
        if (event.data.size) session.chunks.push(event.data);
      };
      session.recorder.onstop = () => { release(session); if (capture === session) { session.phase = "processing"; render(); void encodeRecording(session); } };
      session.recorder.onerror = () => { if (capture === session) { discardCapture(); status("The microphone stopped unexpectedly. Please try again.", true); } };
      session.recorder.start(1000); session.phase = "recording"; session.timer = setTimeout(finishRecording, 30000);
      status("Recording… press Finish & rap when you’re done. Maximum 30 seconds."); render();
    } catch (error) {
      release(session);
      if (capture === session) { discardCapture(); status(error.name === "NotAllowedError" ? "Microphone access was denied. Allow access or type a message below." : error.message, true); }
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
    root.innerHTML = `<header class="mm-header"><div><div class="mm-eyebrow">Call & response</div><h1>Rap response</h1><p>Say something. Get a rhyming rap over your music.</p></div><a class="mm-button" href="#rap-experiment" data-workspace="rap-experiment">Voice experiments ↗</a></header>
      <p class="rr-setup" data-rr-setup></p><div class="rr-grid"><section class="rr-compose" aria-labelledby="rr-message-title"><h2 id="rr-message-title">Your message</h2>
      <div class="rr-record"><button type="button" class="mm-button mm-primary" data-rr-record>Record a message</button><span data-rr-microphone>Up to 30 seconds</span></div>
      <label for="rr-text">Or type something<textarea id="rr-text" data-rr-text rows="4" maxlength="1000" placeholder="I missed the bus and now I’m late…"></textarea></label>
      <label class="rr-output" for="rr-mode">New response<select id="rr-mode" data-rr-mode><option value="vocals">Over main music · isolated voice</option><option value="mix">With generated beat · full mix</option></select></label>
      <p class="rr-hint">Use headphones when recording over music. The voice starts on the next bar; generated timing can drift.</p>
      <label class="rr-voice" for="rr-voice">Voice for new replies<select id="rr-voice" data-rr-voice aria-describedby="rr-voice-hint"><option value="deep_hiphop">Deep Hip-Hop Voice</option><option value="emo_trap">Emo Trap Autotune</option></select></label>
      <p class="rr-hint" id="rr-voice-hint">Each preset keeps a recognizable voice; phrasing and delivery can vary.</p>
      <div class="rr-options"><label for="rr-bpm">Requested BPM<input id="rr-bpm" data-rr-bpm type="number" min="70" max="140" step="1"></label>
      <label for="rr-style">Beat style<select id="rr-style" data-rr-style><option value="boom_bap">Boom bap</option><option value="trap">Trap</option><option value="lofi">Lo-fi</option></select></label>
      <label for="rr-bars">Length<select id="rr-bars" data-rr-bars><option value="4">4 bars</option><option value="8">8 bars</option></select></label></div>
      <div class="rr-actions"><button type="button" class="mm-button mm-primary" data-rr-generate>Make rap response</button><button type="button" class="mm-button" data-rr-cancel hidden>Cancel</button></div>
      <label class="rr-check"><input type="checkbox" data-rr-auto> Play when my new response is ready</label><p class="rr-status" data-rr-status role="status" aria-live="polite"></p></section>
      <section class="rr-result" aria-labelledby="rr-result-title"><div class="rr-result-heading"><h2 id="rr-result-title">The reply</h2><span data-rr-result-label></span></div>
      <h3>You said</h3><p class="rr-transcript" data-rr-transcript></p><h3>The rap</h3><p class="rr-lyrics" data-rr-lyrics></p>
      <div class="rr-playback"><label for="rr-result-mode">Play this response<select id="rr-result-mode" data-rr-result-mode><option value="vocals">Over main music · isolated voice</option><option value="mix">With generated beat · full mix</option></select></label><label for="rr-volume">Rap volume<input id="rr-volume" data-rr-volume type="range" min="0" max="1" step="0.01"></label></div>
      <div class="rr-actions"><button type="button" class="mm-button mm-primary" data-rr-play disabled>Play over main music</button><button type="button" class="mm-button" data-rr-stop disabled>Stop voice</button><button type="button" class="mm-button" data-rr-isolate hidden>Isolate this voice</button></div>
      <div class="rr-downloads"><a data-rr-download download hidden>Download full mix</a><a data-rr-download-vocals download hidden>Download voice</a></div>
      <p class="rr-now" data-rr-now role="status"></p><p class="rr-timing" data-rr-timing></p></section></div>
      <section class="rr-library"><label for="rr-saved">Saved responses<select id="rr-saved" data-rr-saved></select></label><button type="button" class="mm-button" data-rr-refresh>Refresh</button></section>`;
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (_) {}
    if (!saved || typeof saved !== "object") saved = {};
    const defaults = settings(saved); $("text").value = typeof saved.text === "string" ? saved.text.slice(0, 1000) : "";
    for (const name of ["bpm", "style", "bars"]) $(name).value = String(defaults[name]);
    $("mode").value = defaults.output_mode;
    $("voice").value = defaults.vocal_preset || "deep_hiphop";
    $("volume").value = String(Number.isFinite(saved.volume) ? Math.max(0, Math.min(1, saved.volume)) : .85);
    $("auto").checked = saved.auto_play !== false; selected = typeof saved.response_id === "string" ? saved.response_id : "";
    if (idOK(saved.pending?.request_id)) pending = { request_id: saved.pending.request_id, ...submittedSettings({ ...saved.pending, output_mode: saved.pending.output_mode || "mix" }), ...(saved.pending.isolation ? { isolation: true } : {}),
      ...(typeof saved.pending.id === "string" ? { id: saved.pending.id } : {}), ...(typeof saved.pending.text === "string" ? { text: saved.pending.text.slice(0, 1000) } : { recorded: true }) };
    $("record").addEventListener("click", record); $("generate").addEventListener("click", () => submit()); $("cancel").addEventListener("click", cancel);
    $("isolate").addEventListener("click", isolate);
    $("result-mode").addEventListener("change", () => { const mode = $("result-mode").value; stop(); playbackMode = mode === "vocals" ? "vocals" : "mix"; render(); if (playbackMode === "vocals" && !urlFor(job, "vocals")) status(job?.vocal_state === "failed" || job?.vocal_state === "unknown" || job?.vocal_state === "cancelled" ? "Voice isolation did not complete. The full mix is still available." : "Use Isolate this voice to separate the rap from its generated beat."); });
    $("volume").addEventListener("input", () => { if (gain) gain.gain.value = Number($("volume").value); flush(); });
    $("play").addEventListener("click", play); $("stop").addEventListener("click", stop);
    $("refresh").addEventListener("click", () => { if (active && !busy && !capture) return load(life); });
    $("saved").addEventListener("change", async () => {
      if (!active || busy || pending || capture) { render(); return; }
      const id = $("saved").value, turn = ++jobRun; stop(); clearTimeout(poll); selected = id; job = null; render(); flush();
      if (selected) await check(selected, life, turn);
    });
    for (const name of ["text", "bpm", "style", "bars", "mode", "voice"]) $(name).addEventListener(["text", "bpm"].includes(name) ? "input" : "change", () => { render(); flush(); });
    $("auto").addEventListener("change", () => { if (!$("auto").checked) stop(); flush(); });
    render(); return api;
  }
  function activate() { if (!initialized) init(); if (!initialized || active) return; active = true; controller = new AbortController(); render(); return load(++life); }
  function deactivate() { if (!initialized) return; active = false; ++life; ++jobRun; stop(); discardCapture(); clearTimeout(poll); controller?.abort(); busy = false; flush(); }
  const api = { init, activate, deactivate, flush, stop, getState, pcm16Wav };
  return api;
})();
