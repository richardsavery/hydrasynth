"use strict";

// Voice synthesis and rhythmic preparation happen in Python. This panel only
// loads the rendered WAV and starts it against the mixer's audio clock.
globalThis.HydraRap = (() => {
  const finite = Number.isFinite;
  const mode = value => value === "natural" || value === "natural_phrase" ? "natural" : "phrase_beats";
  const renderers = { natural: "python-natural-phrase-v2", phrase_beats: "python-phrase-beats-v3" };
  const same = (a, b) => a && b && a.text === b.text && a.bpm === b.bpm && a.voice_id === b.voice_id && a.timing_mode === b.timing_mode;
  const id = () => globalThis.crypto?.randomUUID?.() || `rap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  async function request(path, body, signal) {
    const response = await fetch(`/api/rap${path}`, { method: body ? "POST" : "GET", signal,
      headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || "The rap service could not complete this request."), { status: response.status });
    return data;
  }
  function nextGrid(clock, currentTime, size, lead) {
    const seconds = 60 / clock.bpm, at = Math.max(currentTime + lead, clock.at);
    const beat = clock.beat + (at - clock.at) / seconds;
    const boundary = Math.ceil((beat - 1e-7) / size) * size;
    return at + Math.max(0, boundary - beat) * seconds;
  }
  const nextBeat = (clock, currentTime, lead = 0.08) => nextGrid(clock, currentTime, 1, lead);
  const nextBar = (clock, currentTime, lead = 0.08) => nextGrid(clock, currentTime, 4, lead);
  function create({ container, name, saved = {}, getBpm, clock, unlock, onSave = () => {} }) {
    if (!container) return null;
    saved = saved && typeof saved === "object" ? saved : {};
    const prefix = `rap-${name}`;
    container.classList.add("rap-panel");
    container.innerHTML = `<div class="mm-section-heading"><h2>Rap</h2><span data-rap-tempo></span></div>
      <label for="${prefix}-text">Words to rap<textarea id="${prefix}-text" data-rap-text rows="3" maxlength="1500" placeholder="Type your words. Use punctuation or a new line to start a phrase."></textarea></label>
      <div class="rap-options rap-direction"><label for="${prefix}-timing">Timing<select id="${prefix}-timing" data-rap-timing><option value="phrase_beats">Phrases on beats</option><option value="natural">Natural flow</option></select></label><div><label for="${prefix}-voices">Voice<select id="${prefix}-voices" data-rap-voice-select><option value="">Default voice</option><option value="__custom__">Custom voice ID…</option></select></label><label for="${prefix}-voice" data-rap-custom hidden>ElevenLabs voice ID<input id="${prefix}-voice" data-rap-voice maxlength="80" placeholder="Enter a voice ID"></label><p class="rap-voice-status" data-rap-voice-status role="status"></p></div></div>
      <div class="rap-actions"><button type="button" class="mm-button mm-primary" data-rap-prepare>Prepare rap</button><button type="button" class="mm-button" data-rap-play disabled>▶ Rap on beat</button><button type="button" class="mm-button" data-rap-stop disabled>■ Stop rap</button></div>
      <div class="rap-options"><div class="rap-checks"><label class="rap-check"><input type="checkbox" data-rap-auto> Auto-start when ready</label><label class="rap-check"><input type="checkbox" data-rap-loop> Loop rap</label></div><label for="${prefix}-volume">Rap volume<input id="${prefix}-volume" data-rap-volume type="range" min="0" max="1" step="0.01"></label></div>
      <p class="rap-status" data-rap-status role="status">Type words, then prepare the rap.</p>`;
    const $ = key => container.querySelector(`[data-rap-${key}]`);
    $("text").value = typeof saved.text === "string" ? saved.text.slice(0, 1500) : "";
    $("voice").value = typeof saved.voice_id === "string" ? saved.voice_id.slice(0, 80) : "";
    $("timing").value = mode(saved.timing_mode);
    $("auto").checked = saved.auto_start !== false;
    $("volume").value = finite(saved.volume) ? Math.max(0, Math.min(1, saved.volume)) : 0.8;
    $("loop").checked = saved.loop === true;
    let active = false, timer = null, poll = null, controller = null, generation = 0, preparing = false;
    let intent = saved.pending && typeof saved.pending.request_id === "string" ? saved.pending : null;
    let job = null, renderId = typeof saved.render_id === "string" ? saved.render_id : null;
    let source = null, gain = null, buffer = null, context = null, ownedContext = null, clockToken = null, synced = false;
    let playing = false, starting = false, lastBpm = null, startedAt = null, playRun = 0, playOrigin = null;
    let autoArm = null, explicitPrepareRun = null, voices = [], defaultVoiceId = "", manualVoice = false;
    const bpm = () => { const value = Number(getBpm?.()); return finite(value) && value >= 20 && value <= 300 ? value : 100; };
    const draft = () => ({ text: $("text").value.trim(), bpm: bpm(), voice_id: $("voice").value.trim(), timing_mode: mode($("timing").value) });
    const jobDraft = () => job && ({ text: job.text, bpm: job.bpm, voice_id: job.requested_voice_id ?? "",
      timing_mode: job.timing_mode ? mode(job.timing_mode) : job.renderer === renderers.natural ? "natural" : "phrase_beats" });
    const ready = () => job?.state === "complete" && job.renderer === renderers[draft().timing_mode] && same(draft(), jobDraft());
    function status(message, error = false) { $("status").textContent = message; $("status").classList.toggle("is-error", error); }
    function getState() { return { text: $("text").value, voice_id: $("voice").value, timing_mode: mode($("timing").value),
      auto_start: $("auto").checked, volume: Number($("volume").value), loop: $("loop").checked, render_id: renderId, pending: intent }; }
    function save() { onSave(); }
    function renderVoices() {
      const value = $("voice").value.trim(), known = voices.some(voice => voice.voice_id === value);
      const defaultName = voices.find(voice => voice.voice_id === defaultVoiceId)?.name;
      $("voice-select").innerHTML = `<option value="">${escape(defaultName ? `Default · ${defaultName}` : "Default voice")}</option>` +
        voices.map(voice => `<option value="${escape(voice.voice_id)}">${escape(voice.name)}</option>`).join("") + '<option value="__custom__">Custom voice ID…</option>';
      $("voice-select").value = manualVoice || value && !known ? "__custom__" : value;
      $("custom").hidden = $("voice-select").value !== "__custom__";
    }
    async function loadVoices(run) {
      try {
        const result = await request("/voices", null, controller.signal);
        if (!active || run !== generation) return;
        const unique = new Map();
        for (const voice of (Array.isArray(result.voices) ? result.voices : []).slice(0, 300)) {
          if (typeof voice?.voice_id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(voice.voice_id) && typeof voice.name === "string")
            unique.set(voice.voice_id, { voice_id: voice.voice_id, name: voice.name.slice(0, 100) || voice.voice_id });
        }
        voices = [...unique.values()]; defaultVoiceId = result.default_voice_id || ""; renderVoices();
        $("voice-status").textContent = voices.length ? "" : "No voices listed. Use the default voice or enter a voice ID.";
      } catch (error) {
        if (!active || run !== generation || error.name === "AbortError") return;
        $("voice-status").textContent = "Voice list unavailable. Use the default voice or a custom voice ID.";
      }
    }
    function render() {
      const time = bpm();
      $("tempo").textContent = `${Number(time.toFixed(1))} BPM${clock?.()?.estimated ? " · track tempo" : ""}`;
      if (lastBpm !== null && time !== lastBpm) {
        stop();
        if (job || preparing) status("Tempo changed. Prepare the rap at the new BPM.");
      }
      lastBpm = time;
      if (playing && (context?.state === "closed" || !synced && clock?.()?.playing)) {
        stop(); status("Backing track changed. Start the rap on its next beat.");
      }
      if (playing && synced) {
        const transport = clock?.();
        if (!transport?.playing || !transport.valid || transport.token !== clockToken) {
          stop(); status("Backing track changed or stopped. Rap is ready for the next beat.");
        }
      }
      if (playing && startedAt !== null && context.currentTime >= startedAt) {
        status($("loop").checked ? "Rapping · looping on the beat" : "Rapping"); startedAt = null;
      }
      $("prepare").disabled = preparing || !$("text").value.trim();
      $("prepare").textContent = preparing ? "Preparing…" : intent ? "Check render" : "Prepare rap";
      $("play").disabled = !ready() || preparing || playing || starting;
      $("stop").disabled = !playing && !starting && !autoArm;
      if (autoArm && !starting && !playing && !preparing && ready()) {
        const transport = clock?.();
        if (!same(autoArm.draft, draft()) || !$("auto").checked) autoArm = null;
        else if (transport?.rateChanging || transport?.playing && !transport.valid) status("Ready · waiting for the backing beat…");
        else void play(true);
      }
    }
    function stop() {
      const hadPlayback = playing || starting || Boolean(autoArm);
      autoArm = null; explicitPrepareRun = null; playRun++;
      playing = starting = false; clockToken = null; startedAt = null; playOrigin = null;
      if (source) { source.onended = null; try { source.stop(); } catch (_) {} source.disconnect(); source = null; }
      gain?.disconnect(); gain = null;
      $("stop").disabled = true; $("play").disabled = !ready() || preparing;
      if (hadPlayback) status("Rap stopped.");
    }
    // Called inside Prepare/Play gestures. Start resume calls immediately, before
    // waiting on any network or synthesis work.
    function unlockAudio() {
      const pending = unlock?.();
      const candidate = clock?.()?.context || (ownedContext ||= new (globalThis.AudioContext || globalThis.webkitAudioContext)());
      const resumed = candidate.resume();
      return Promise.all([pending, resumed]).then(() => candidate);
    }
    async function receive(next, run) {
      if (!active || run !== generation) return;
      job = next; renderId = next.id; save();
      if (["queued", "generating", "rendering"].includes(next.state)) {
        status(next.state === "rendering" ? (mode(next.timing_mode || intent?.timing_mode || draft().timing_mode) === "natural"
          ? "Preparing natural flow…" : "Placing phrases on the beat…") : "Preparing the voice…");
        poll = setTimeout(() => check(next.id, run), 1000); return;
      }
      preparing = false;
      if (next.state === "complete") {
        job.requested_voice_id = intent?.voice_id ?? next.requested_voice_id ?? "";
        intent = null; buffer = null; save();
        status(ready() ? `Ready · ${next.bars} bars · ${next.bpm} BPM` : "Prepare this rap again for the selected text, timing and tempo.");
        if (!ready()) autoArm = null;
      } else {
        autoArm = null; intent = null; save(); status(next.error || "Rap preparation failed. Try again when ready.", true);
      }
      render();
    }
    async function check(jobId, run) {
      try { await receive(await request(`/renders/${encodeURIComponent(jobId)}`, null, controller.signal), run); }
      catch (error) {
        if (active && run === generation && error.name !== "AbortError") {
          preparing = false; autoArm = null; status(`${error.message} Use Check render to recover the request.`, true); render();
        }
      }
    }
    async function prepare() {
      if (preparing || !active) return;
      stop(); preparing = true; const run = ++generation;
      explicitPrepareRun = run;
      lastBpm = bpm();
      controller?.abort(); controller = new AbortController(); clearTimeout(poll);
      if (!intent) {
        intent = { ...draft(), request_id: id() };
        if (job?.state === "complete" && job.source_available === true && job.text === intent.text && (job.requested_voice_id ?? "") === intent.voice_id)
          intent.source_render_id = job.id;
        renderId = null;
      }
      // Recovery of older/different work remains explicit but cannot auto-play a
      // draft the user is no longer looking at.
      if ($("auto").checked && same(draft(), intent)) autoArm = { run, draft: draft(), audioReady: false };
      const armed = autoArm;
      let unlocking;
      try { unlocking = unlockAudio(); } catch (error) { unlocking = Promise.reject(error); }
      save(); status("Preparing the voice…"); render();
      try {
        try { await unlocking; if (autoArm === armed && armed) armed.audioReady = true; }
        catch (_) { if (autoArm === armed) autoArm = null; }
        if (!active || run !== generation) return;
        await receive(await request("/renders", intent, controller.signal), run);
      } catch (error) {
        if (active && run === generation && error.name !== "AbortError") {
          preparing = false; autoArm = null;
          if ([400, 413, 422].includes(error.status)) { intent = null; save(); }
          status(`${error.message}${intent ? " Use Check render to recover the request." : ""}`, true); render();
        }
      }
    }
    async function play(automatic = false) {
      if (!ready() || playing || starting || !active) return;
      if (automatic && (!autoArm?.audioReady || !same(autoArm.draft, draft()) || !$("auto").checked)) return;
      if (!automatic) autoArm = null;
      starting = true; playOrigin = automatic ? "auto" : "manual";
      const run = generation, attempt = ++playRun;
      const armed = autoArm;
      try {
        const candidate = automatic ? clock?.()?.context || ownedContext : await unlockAudio();
        if (!active || run !== generation || attempt !== playRun || !starting) return;
        context = candidate;
        if (!context || context.state === "closed" || context.state === "suspended") throw new Error("Rap is ready. Press Rap on beat to enable audio.");
        render();
        if (!active || run !== generation || attempt !== playRun || !starting) return;
        if (!buffer || buffer.context !== context) {
          const response = await fetch(job.audio_url, { signal: controller?.signal });
          if (!active || run !== generation || attempt !== playRun || !starting) return;
          if (!response.ok) throw new Error("Could not load the prepared rap.");
          const decoded = await context.decodeAudioData(await response.arrayBuffer());
          if (!active || run !== generation || attempt !== playRun || !starting) return;
          buffer = { context, audio: decoded };
        }
        const transport = clock?.();
        if (automatic && (autoArm !== armed || !$("auto").checked || !same(armed.draft, draft()))) return;
        if (transport?.context && transport.context !== context) throw new Error("Backing track changed. Press Rap on beat to join it.");
        if (transport?.rateChanging || transport?.playing && !transport.valid) {
          if (automatic) { starting = false; playOrigin = null; status("Ready · waiting for the backing beat…"); render(); return; }
          throw new Error(transport?.rateChanging ? "Playback speed is changing. Start the rap once it settles." : "Waiting for mapped input. Start the rap when the backing track is playing.");
        }
        if (!ready()) throw new Error("Text, timing or tempo changed. Prepare the updated rap.");
        synced = Boolean(transport?.playing); clockToken = synced ? transport.token : null;
        const start = synced ? nextBeat(transport, context.currentTime) : context.currentTime + 0.08;
        gain = context.createGain(); gain.gain.value = Number($("volume").value); gain.connect(transport?.destination || context.destination);
        source = context.createBufferSource(); source.buffer = buffer.audio; source.loop = $("loop").checked; source.connect(gain);
        const currentSource = source;
        source.onended = () => { if (source !== currentSource) return; stop(); status("Finished. Ready for the next beat."); render(); };
        playing = true; starting = false; startedAt = start; autoArm = null;
        source.start(start); status(synced ? "Queued for the next beat…" : "Rapping"); render();
      } catch (error) {
        if (attempt !== playRun) return;
        stop(); if (error.name !== "AbortError") status(error.message, true); render();
      }
    }
    function draftChanged() { stop(); save(); if (job || preparing) status("Text, voice or timing changed. Prepare the updated rap."); render(); }
    $("prepare").addEventListener("click", prepare);
    $("play").addEventListener("click", () => play(false));
    $("stop").addEventListener("click", () => { stop(); status("Rap stopped."); render(); });
    $("text").addEventListener("input", draftChanged);
    $("timing").addEventListener("change", draftChanged);
    $("voice").addEventListener("input", () => { manualVoice = true; renderVoices(); draftChanged(); });
    $("voice-select").addEventListener("change", () => {
      manualVoice = $("voice-select").value === "__custom__";
      if (!manualVoice) $("voice").value = $("voice-select").value;
      renderVoices(); draftChanged();
    });
    $("auto").addEventListener("change", async () => {
      if (!$("auto").checked) {
        autoArm = null;
        if (playOrigin === "auto" && (starting || playing && startedAt !== null && context.currentTime < startedAt)) stop();
      } else if (active && preparing && explicitPrepareRun === generation && same(draft(), intent)) {
        // Checking this during this page's explicit Prepare is another user
        // gesture. Restored work and already-finished renders remain passive.
        const armed = autoArm = { run: generation, draft: draft(), audioReady: false };
        try { await unlockAudio(); if (autoArm === armed) armed.audioReady = true; }
        catch (_) { if (autoArm === armed) autoArm = null; }
      }
      save(); render();
    });
    $("volume").addEventListener("input", () => { if (gain) gain.gain.setTargetAtTime(Number($("volume").value), context.currentTime, 0.015); save(); });
    $("loop").addEventListener("change", () => { if (source) source.loop = $("loop").checked; save(); });
    async function activate() {
      if (active) return;
      active = true; lastBpm = null; timer = setInterval(render, 100); render();
      const run = ++generation; controller?.abort(); controller = new AbortController();
      const voiceLoad = loadVoices(run);
      if (renderId) { preparing = Boolean(intent); await check(renderId, run); }
      else try {
        const service = await request("/status", null, controller.signal);
        if (active && run === generation && service.ready === false) status((service.setup_errors || service.issues)?.join(" ") || "Configure the rap voice service to prepare audio.", true);
      } catch (error) { if (active && run === generation && error.name !== "AbortError") status(error.message, true); }
      await voiceLoad;
    }
    function deactivate() {
      active = false; generation++; controller?.abort(); clearTimeout(poll); clearInterval(timer); stop();
      preparing = false; buffer = null; ownedContext?.close(); ownedContext = null; save();
    }
    renderVoices(); render();
    return { activate, deactivate, getState, stop };
  }
  return { create, nextBeat, nextBar };
})();
