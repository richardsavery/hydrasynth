"use strict";

// Python prepares the voice; this panel schedules its WAV on the music clock.
globalThis.HydraMusicMixerVoice = (() => {
  const JADE = "g7LVvkPWALzPxOQbF6OE", MAISIE = "QtY3JBOUKEB5xzrRfOKc";
  const DEFAULT_TEXT = "Signals rise, we find the flow\nTurn the dial and let it go\nBass and motion, light and sound\nKeep the rhythm moving round";
  const NOTES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  const MELODIES = { follow: "Follow voice", drone: "One note", two_note: "Two notes", rising: "Rising", falling: "Falling", arpeggio: "Arpeggio", hook: "Pop hook" };
  const PRESETS = {
    bounce: { label: "Jade · Neutral bounce", voice_id: JADE, robot_key: 5, robot_melody: "two_note", robot_tone_hz: 6000, robot_note_beats: 1 },
    soft: { label: "Jade · Soft rhythm", voice_id: JADE, robot_key: 5, robot_melody: "two_note", robot_tone_hz: 3000, robot_note_beats: 1 },
    hook: { label: "Jade · Melody hook", voice_id: JADE, robot_key: 5, robot_melody: "hook", robot_tone_hz: 6000, robot_note_beats: .5 },
    maisie: { label: "Maisie · Beat flow", voice_id: MAISIE, robot_key: 5, robot_melody: "two_note", robot_tone_hz: 6000, robot_note_beats: 1 }
  };
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const uid = () => globalThis.crypto?.randomUUID?.() || `mixer-voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pick = (value, choices, fallback) => choices.includes(value) ? value : fallback;
  const number = (value, low, high, fallback) => Number.isFinite(Number(value)) && value !== null ? Math.max(low, Math.min(high, Number(value))) : fallback;
  const audioURL = value => typeof value === "string" && /^\/api\/rap-experiment\/experiments\/[A-Za-z0-9_-]+\/audio\/(flash|robot)$/.test(value) ? value : "";
  const sourceReady = job => job?.sources?.flash?.state === "complete";
  const exampleAudio = (job, variant) => job?.examples?.find(item => (item.id || item.variant) === variant && item.state === "complete" && audioURL(item.audio_url));
  const defaults = { robot_style: "autotune", robot_amount: 1, robot_tone_hz: 6000, robot_key: 5, robot_scale: "major", robot_melody: "two_note", robot_octave: 3, robot_note_beats: 1, robot_rhythm: "flow" };
  function create({ container, name = "music", saved = {}, getBpm, clock, unlock, onSave = () => {}, onPlayBacking, onSelectBacking }) {
    if (!container) return null;
    saved = saved && typeof saved === "object" ? saved : {};
    const prefix = `mixer-voice-${name}`;
    container.classList.add("mv-panel");
    const select = (field, title, options) => `<label for="${prefix}-${field}">${title}<select id="${prefix}-${field}" data-mv-${field}>${options}</select></label>`;
    const options = values => Object.entries(values).map(([value, label]) => `<option value="${escape(value)}">${escape(label)}</option>`).join("");
    container.innerHTML = `<div class="mm-section-heading"><h2>Voice</h2><span data-mv-tempo></span></div>
      <div class="mv-example-row">${select("example", "Try with music", '<option value="">Choose a voice + track example…</option>')}<button type="button" class="mm-button" data-mv-play-example disabled>▶ Play example</button></div>
      <div class="mv-grid">${select("preset", "Voice starting point", options(Object.fromEntries(Object.entries(PRESETS).map(([key, value]) => [key, value.label]))) + '<option value="custom">Custom settings</option>')}${select("saved", "Saved voices", '<option value="">Choose a saved voice…</option>')}</div>
      <label for="${prefix}-text">Words to rap<textarea id="${prefix}-text" data-mv-text rows="3" maxlength="1000" placeholder="Type words. Use a new line for each phrase."></textarea></label>
      <div class="mv-grid">${select("voice-select", "Voice", "")}${select("rhythm", "Rhythm", options({ flow: "Beat flow", phrases: "Phrases on beats", natural: "Natural speech" }))}${select("effect", "Voice effect", options({ autotune: "Autotune", clean: "Clean voice", metallic: "Metallic", radio: "Radio" }))}</div>
      <label for="${prefix}-voice" data-mv-custom hidden>Voice ID<input id="${prefix}-voice" data-mv-voice maxlength="80" placeholder="ElevenLabs voice ID"></label>
      <details class="mv-advanced"><summary>Advanced voice controls</summary><div class="mv-grid">
        <label for="${prefix}-amount">Effect strength <output data-mv-amount-value></output><input id="${prefix}-amount" data-mv-amount type="range" min="0" max="100" step="1"></label>
        <label for="${prefix}-tone">Tone <output data-mv-tone-value></output><input id="${prefix}-tone" data-mv-tone type="range" min="800" max="8000" step="100"></label></div>
        <div class="mv-grid" data-mv-tuning>${select("key", "Key", options(Object.fromEntries(NOTES.map((note, index) => [index, note]))))}${select("scale", "Scale", options({ major: "Major", minor: "Minor", chromatic: "Chromatic" }))}${select("melody", "Melody", options(MELODIES))}</div>
        <div class="mv-grid" data-mv-notes>${select("octave", "Register", options({ 2: "Low · octave 2", 3: "Middle · octave 3", 4: "High · octave 4", 5: "Very high · octave 5" }))}${select("note-beats", "Note changes", options({ ".5": "Every half beat", 1: "Every beat", 2: "Every two beats" }))}</div>
      </details>
      <div class="mv-actions"><button type="button" class="mm-button mm-primary" data-mv-prepare>Prepare voice</button><button type="button" class="mm-button" data-mv-play disabled>▶ Play with track</button><button type="button" class="mm-button" data-mv-stop disabled>■ Stop voice</button></div>
      <div class="mv-grid mv-transport"><div class="mv-checks"><label><input type="checkbox" data-mv-auto> Auto-start when ready</label><label><input type="checkbox" data-mv-loop> Loop voice</label></div><label for="${prefix}-volume">Voice volume<input id="${prefix}-volume" data-mv-volume type="range" min="0" max="1" step=".01"></label></div>
      <p class="mv-status" data-mv-status role="status">Choose an example, or prepare your words for this track.</p>`;
    const $ = key => container.querySelector(`[data-mv-${key}]`);
    let active = false, generation = 0, playRun = 0, timer, poll, controller, preparing = false;
    let job = null, jobs = [], examples = [], selected = typeof saved.experiment_id === "string" ? saved.experiment_id : "";
    const savedFastRequest = saved.pending?.request_id && Array.isArray(saved.pending.variants) && saved.pending.variants.length && saved.pending.variants.every(value => ["flash", "robot"].includes(value));
    let pending = savedFastRequest ? saved.pending : null, autoArm = null, explicitRun = null;
    let source, gain, context, ownedContext, buffer, playing = false, starting = false, startedAt = null, playOrigin = null, clockToken = null;
    let voices = [{ voice_id: JADE, name: "Jade" }, { voice_id: MAISIE, name: "Maisie" }], defaultVoice = JADE, lastBpm = null, adoptingTrack = false;
    const legacy = saved.legacy_rap || (saved.render_id || saved.pending && !savedFastRequest ? { ...saved } : null);
    const bpm = () => { const value = Number(getBpm?.()); return Number.isFinite(value) ? value : 100; };
    const usableBpm = () => Number.isFinite(bpm()) && bpm() >= 40 && bpm() <= 240;
    function draft() { return { text: $("text").value.trim(), bpm: bpm(), voice_id: $("voice").value.trim(),
      robot_style: $("effect").value === "clean" ? "autotune" : $("effect").value, robot_amount: Number($("amount").value) / 100,
      robot_tone_hz: Number($("tone").value), robot_key: Number($("key").value), robot_scale: $("scale").value,
      robot_melody: $("melody").value, robot_octave: Number($("octave").value), robot_note_beats: Number($("note-beats").value), robot_rhythm: $("rhythm").value }; }
    const variant = () => $("effect").value === "clean" ? "flash" : "robot";
    const baseMatches = (value, settings = draft()) => value && value.text === settings.text && value.voice_id === (settings.voice_id || defaultVoice);
    function matches(value, settings = draft(), clean = variant() === "flash") {
      if (!baseMatches(value, settings) || Number(value.bpm) !== settings.bpm || (value.robot_rhythm || "natural") !== settings.robot_rhythm) return false;
      if (clean) return true;
      const keys = ["robot_style", "robot_amount", "robot_tone_hz", ...(settings.robot_style === "autotune" ? ["robot_key", "robot_scale", "robot_melody", "robot_octave", "robot_note_beats"] : [])];
      return keys.every(key => (value[key] ?? ({ robot_melody: "follow", robot_octave: 3, robot_note_beats: 1 })[key]) === settings[key]);
    }
    const ready = () => usableBpm() && matches(job) && !!exampleAudio(job, variant());
    const reusable = () => [job, ...jobs].find(item => sourceReady(item) && baseMatches(item));
    const snapshot = () => JSON.stringify({ ...draft(), effect: $("effect").value });
    function status(message, error = false) { $("status").textContent = message; $("status").classList.toggle("is-error", error); }
    function save() { onSave(); }
    function getState() { return { ...draft(), effect: $("effect").value, preset: $("preset").value, experiment_id: selected,
      example_id: $("example").value, pending, auto_start: $("auto").checked, loop: $("loop").checked, volume: Number($("volume").value), ...(legacy ? { legacy_rap: legacy } : {}) }; }
    function voiceMenu() {
      const value = $("voice").value;
      $("voice-select").innerHTML = options(Object.fromEntries(voices.map(item => [item.voice_id, item.name]))) + '<option value="__custom__">Custom voice ID…</option>';
      $("voice-select").value = voices.some(item => item.voice_id === value) ? value : "__custom__";
      $("custom").hidden = $("voice-select").value !== "__custom__";
    }
    function setDraft(value, fresh = false) {
      const base = fresh ? { ...defaults, ...PRESETS.bounce } : { robot_style: "autotune", robot_amount: 1, robot_tone_hz: 6000, robot_key: 0, robot_scale: "minor", robot_melody: "follow", robot_octave: 3, robot_note_beats: 1, robot_rhythm: "natural" };
      value = { ...base, ...value };
      $("text").value = typeof value.text === "string" ? value.text.slice(0, 1000) : DEFAULT_TEXT;
      $("voice").value = typeof value.voice_id === "string" && value.voice_id ? value.voice_id : JADE;
      $("effect").value = pick(value.effect || value.robot_style, ["autotune", "clean", "metallic", "radio"], "autotune");
      $("rhythm").value = pick(value.robot_rhythm, ["natural", "phrases", "flow"], "flow");
      $("amount").value = number(value.robot_amount, 0, 1, 1) * 100;
      $("tone").value = number(value.robot_tone_hz, 800, 8000, 4500);
      $("key").value = String(Math.round(number(value.robot_key, 0, 11, 5)));
      $("scale").value = pick(value.robot_scale, ["major", "minor", "chromatic"], "major");
      $("melody").value = pick(value.robot_melody, Object.keys(MELODIES), "two_note");
      $("octave").value = String(Math.round(number(value.robot_octave, 2, 5, 3)));
      $("note-beats").value = Number(value.robot_note_beats) === .5 ? ".5" : String(pick(Number(value.robot_note_beats), [1, 2], 1));
      $("preset").value = Object.hasOwn(PRESETS, value.preset) ? value.preset : fresh ? "bounce" : "custom";
      voiceMenu();
    }
    function savedMenu() {
      const eligible = jobs.filter(item => sourceReady(item) && (exampleAudio(item, "flash") || exampleAudio(item, "robot")));
      const groups = [["Neutral · Rhythm", "neutral"], ["Jade · Melodies", "jade"], ["Other saved voices", null]];
      $("saved").innerHTML = '<option value="">Choose a saved voice…</option>' + groups.map(([label, group]) => {
        const items = eligible.filter(item => group ? item.audition_group === group : !["neutral", "jade"].includes(item.audition_group));
        if (group) items.sort((a, b) => String(a.audition_label).localeCompare(String(b.audition_label), undefined, { numeric: true }));
        return items.length ? `<optgroup label="${label}">${items.map(item => `<option value="${escape(item.id)}">${escape(item.audition_label || `${voices.find(v => v.voice_id === item.voice_id)?.name || "Voice"} · ${item.text.split("\n")[0].slice(0, 45)} · ${item.bpm} BPM`)}</option>`).join("")}</optgroup>` : "";
      }).join("") + (selected && !eligible.some(item => item.id === selected) ? `<option value="${escape(selected)}">Current voice</option>` : "");
      $("saved").value = selected;
    }
    async function request(path, body) {
      const response = await fetch(`/api/rap-experiment${path}`, { method: body ? "POST" : "GET", signal: controller?.signal,
        headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || "Could not load this voice."), { status: response.status });
      return result;
    }
    function stop() {
      autoArm = null; explicitRun = null; adoptingTrack = false; playRun++; playing = starting = false; playOrigin = null; startedAt = null; clockToken = null;
      if (source) { source.onended = null; try { source.stop(); } catch (_) {} source.disconnect(); source = null; }
      gain?.disconnect(); gain = null;
    }
    function render() {
      const time = bpm(), transport = clock?.();
      $("tempo").textContent = `${Number(time.toFixed(1))} BPM`;
      if (!adoptingTrack && lastBpm !== null && lastBpm !== time) { stop(); if (job || preparing) status("Tempo changed. Prepare the voice for this BPM."); }
      lastBpm = time;
      if (playing && (!transport?.playing || !transport.valid || transport.token !== clockToken || transport.context !== context || transport.rateChanging)) {
        stop(); status("Track changed or stopped. Play the voice on its next beat.");
      }
      if (playing && startedAt !== null && context.currentTime >= startedAt) { startedAt = null; status($("loop").checked ? "Voice playing · looping on the beat" : "Voice playing with track"); }
      $("prepare").disabled = preparing || !pending && (!$("text").value.trim() || !usableBpm());
      $("prepare").textContent = preparing ? "Preparing…" : pending ? "Recover voice" : ready() ? "Prepare voice" : reusable() ? "Apply voice settings" : "Prepare voice";
      $("play").disabled = !ready() || preparing || starting || playing;
      $("stop").disabled = !playing && !starting && !autoArm;
      $("saved").disabled = !!pending || preparing;
      $("example").disabled = !!pending || preparing;
      $("play-example").disabled = !$("example").value || !!pending || preparing || starting;
      $("amount-value").textContent = `${Math.round(Number($("amount").value))}%`;
      $("tone-value").textContent = `${(Number($("tone").value) / 1000).toFixed(1)} kHz`;
      $("tuning").hidden = $("effect").value !== "autotune";
      $("notes").hidden = $("tuning").hidden || $("melody").value === "follow";
      $("amount").disabled = $("tone").disabled = $("effect").value === "clean";
      if (autoArm && !preparing && !playing && !starting && ready()) {
        if (!$("auto").checked || autoArm.snapshot !== snapshot()) autoArm = null;
        else if (transport?.rateChanging || transport?.playing && !transport.valid) status("Voice ready · waiting for a steady backing beat…");
        else if (autoArm.audioReady) void play(true);
      }
    }
    function unlockAudio() {
      const task = unlock?.();
      const candidate = clock?.()?.context || (ownedContext ||= new (globalThis.AudioContext || globalThis.webkitAudioContext)());
      return Promise.all([task, candidate.resume()]).then(() => candidate);
    }
    async function receive(value, run) {
      if (!active || run !== generation) return;
      job = value; selected = value.id; buffer = null;
      jobs = [value, ...jobs.filter(item => item.id !== value.id)]; savedMenu(); clearTimeout(poll);
      if (["queued", "generating", "rendering"].includes(value.state)) {
        preparing = true; status(value.state === "rendering" ? "Fitting the voice to the beat…" : "Preparing the voice…");
        poll = setTimeout(() => check(value.id, run), 250);
      } else {
        preparing = false; pending = null;
        if (ready()) status(`Ready · ${value.bpm} BPM · ${variant() === "flash" ? "clean voice" : "processed voice"}`);
        else if (exampleAudio(value, "flash") || exampleAudio(value, "robot")) { autoArm = null; status("Prepare the voice to apply the selected settings and track BPM."); }
        else { autoArm = null; status(value.error || value.examples?.find(item => item.error)?.error || "Voice preparation did not finish. Try preparing again.", true); }
      }
      save(); render();
    }
    async function check(id, run) {
      try { await receive(await request(`/experiments/${encodeURIComponent(id)}`), run); }
      catch (error) { if (active && run === generation && error.name !== "AbortError") { preparing = false; autoArm = null; status(`${error.message} Use Recover voice to check the same request.`, true); render(); } }
    }
    async function prepare() {
      if (!active || preparing || !pending && (!draft().text || !usableBpm())) return;
      stop(); preparing = true; const run = ++generation; explicitRun = run;
      controller?.abort(); controller = new AbortController(); clearTimeout(poll); lastBpm = bpm();
      if (!pending) {
        const reuse = reusable();
        pending = { ...draft(), request_id: uid(), variants: reuse ? ["robot"] : ["flash", "robot"], ...(reuse ? { source_experiment_id: reuse.id, include_clean: true } : {}) };
      }
      if ($("auto").checked && matches(pending, draft(), false)) autoArm = { snapshot: snapshot(), audioReady: false };
      const armed = autoArm;
      let audio;
      try { audio = unlockAudio(); } catch (error) { audio = Promise.reject(error); }
      save(); status(pending.source_experiment_id ? "Applying settings to the saved voice…" : "Preparing a new voice…"); render();
      try {
        try { await audio; if (autoArm === armed && armed) armed.audioReady = true; } catch (_) { if (autoArm === armed) autoArm = null; }
        if (!active || run !== generation) return;
        await receive(await request("/experiments", pending), run);
      } catch (error) {
        if (!active || run !== generation || error.name === "AbortError") return;
        preparing = false; autoArm = null;
        if ([400, 413, 422].includes(error.status)) pending = null;
        status(`${error.message}${pending ? " Use Recover voice to check the same request." : ""}`, true); save(); render();
      }
    }
    async function play(automatic = false, audioUnlocked = false) {
      if (!active || !ready() || playing || starting) return;
      if (automatic && (!autoArm?.audioReady || autoArm.snapshot !== snapshot() || !$("auto").checked)) return;
      const armed = autoArm, run = generation, attempt = ++playRun, settings = snapshot();
      starting = true; playOrigin = automatic ? "auto" : "manual";
      if (!automatic) autoArm = null;
      render();
      try {
        if (!automatic && !audioUnlocked) await unlockAudio();
        if (!active || run !== generation || attempt !== playRun) return;
        if (!clock?.()?.playing) await onPlayBacking?.();
        if (!active || run !== generation || attempt !== playRun) return;
        const transport = clock?.();
        const transportToken = transport?.token;
        if (!transport?.playing) throw new Error("Choose a track and start its playback first.");
        if (!transport.valid || transport.rateChanging) {
          if (automatic) { starting = false; playOrigin = null; status("Voice ready · waiting for a steady backing beat…"); render(); return; }
          throw new Error("Waiting for a steady track beat. Try Play with track once it settles.");
        }
        if (!ready() || settings !== snapshot()) throw new Error("Track tempo or voice settings changed. Prepare the voice for this track.");
        context = transport.context;
        if (!context || context.state !== "running") throw new Error("Press Play with track to enable audio.");
        const clip = exampleAudio(job, variant()), url = audioURL(clip.audio_url);
        if (!buffer || buffer.context !== context || buffer.url !== url) {
          const response = await fetch(url, { signal: controller?.signal });
          if (!response.ok) throw new Error("Could not load the prepared voice.");
          const decoded = await context.decodeAudioData(await response.arrayBuffer());
          if (!active || run !== generation || attempt !== playRun) return;
          buffer = { context, url, audio: decoded };
        }
        const current = clock?.();
        if (!active || run !== generation || attempt !== playRun) return;
        if (automatic && (autoArm !== armed || !$("auto").checked || armed.snapshot !== snapshot())) { starting = false; return; }
        if (automatic && ready() && settings === snapshot() && current?.playing && current.token === transportToken && current.context === context && (!current.valid || current.rateChanging)) {
          starting = false; playOrigin = null; status("Voice ready · waiting for a steady backing beat…"); render(); return;
        }
        if (!ready() || settings !== snapshot() || !current?.playing || !current.valid || current.rateChanging || current.token !== transportToken || current.context !== context)
          throw new Error("Track changed. Play the voice again on its next beat.");
        clockToken = current.token;
        const at = globalThis.HydraRap.nextBeat(current, context.currentTime);
        gain = context.createGain(); gain.gain.value = Number($("volume").value); gain.connect(current.destination || context.destination);
        source = context.createBufferSource(); source.buffer = buffer.audio; source.loop = $("loop").checked; source.connect(gain);
        const currentSource = source;
        source.onended = () => { if (source !== currentSource) return; stop(); status("Voice finished. Ready for the next beat."); render(); };
        playing = true; starting = false; startedAt = at; autoArm = null;
        source.start(at); status("Voice queued for the next beat…"); render();
      } catch (error) {
        if (attempt !== playRun) return;
        stop(); if (error.name !== "AbortError") status(error.message, true); render();
      }
    }
    async function selectSaved(id) {
      if (!active || pending || preparing) { $("saved").value = selected; return; }
      stop(); clearTimeout(poll); controller?.abort(); controller = new AbortController(); const run = ++generation;
      selected = id; job = null; buffer = null; save(); render();
      if (!id) { status("Choose a voice starting point, then prepare your words."); return; }
      try { const value = await request(`/experiments/${encodeURIComponent(id)}`); if (!active || run !== generation) return; setDraft({ ...value, ...(!exampleAudio(value, "robot") ? { effect: "clean" } : {}) }); await receive(value, run); }
      catch (error) { if (active && run === generation && error.name !== "AbortError") status(error.message, true); }
    }
    async function playExample() {
      const example = examples.find(item => item.id === $("example").value);
      if (!active || !example || pending || preparing) return;
      stop(); const run = ++generation, attempt = ++playRun; starting = true; playOrigin = "manual"; adoptingTrack = true;
      controller?.abort(); controller = new AbortController(); clearTimeout(poll); status("Loading voice and track…"); render();
      try {
        // Both callbacks begin in the click gesture. Recall may replace the old
        // player, so its unlock must happen before this panel resumes audio.
        const recalling = onSelectBacking?.(example.track_id);
        await Promise.all([recalling, unlockAudio()]);
        if (!active || run !== generation || attempt !== playRun) return;
        const value = await request(`/experiments/${encodeURIComponent(example.experiment_id)}`);
        if (!active || run !== generation || attempt !== playRun) return;
        lastBpm = bpm(); adoptingTrack = false; setDraft(value); starting = false; await receive(value, run);
        if (!ready()) { status("Prepare this saved voice at the selected track BPM, then play it."); return; }
        await play(false, true);
      } catch (error) { if (active && run === generation && attempt === playRun) { stop(); if (error.name !== "AbortError") status(error.message, true); render(); } }
      finally { if (run === generation) adoptingTrack = false; }
    }
    function changed() { stop(); $("preset").value = "custom"; save(); status(ready() ? "Ready. Play this version with the track." : "Prepare the voice to apply these settings."); render(); }
    $("prepare").addEventListener("click", prepare);
    $("play").addEventListener("click", () => play());
    $("play-example").addEventListener("click", playExample);
    $("stop").addEventListener("click", () => { stop(); status("Voice stopped."); render(); });
    $("saved").addEventListener("change", () => selectSaved($("saved").value));
    $("example").addEventListener("change", () => { stop(); save(); render(); });
    $("preset").addEventListener("change", () => {
      const key = $("preset").value, preset = PRESETS[key]; if (!preset) return;
      stop(); setDraft({ ...draft(), ...defaults, ...preset, preset: key, effect: "autotune" }); save(); status("Prepare this voice starting point for your track."); render();
    });
    $("voice-select").addEventListener("change", () => {
      const value = $("voice-select").value; $("custom").hidden = value !== "__custom__";
      if (value !== "__custom__") { $("voice").value = value; changed(); }
    });
    $("text").addEventListener("input", changed);
    $("voice").addEventListener("input", changed);
    for (const key of ["rhythm", "effect", "key", "scale", "melody", "octave", "note-beats"]) $(key).addEventListener("change", changed);
    for (const key of ["amount", "tone"]) $(key).addEventListener("input", changed);
    $("volume").addEventListener("input", () => { if (gain) gain.gain.setTargetAtTime(Number($("volume").value), context.currentTime, .015); save(); });
    $("loop").addEventListener("change", () => { if (source) source.loop = $("loop").checked; save(); });
    $("auto").addEventListener("change", async () => {
      if (!$("auto").checked) { autoArm = null; if (playOrigin === "auto" && (starting || playing && startedAt !== null && context.currentTime < startedAt)) stop(); }
      else if (active && preparing && explicitRun === generation && matches(pending, draft(), false)) {
        const armed = autoArm = { snapshot: snapshot(), audioReady: false };
        try { await unlockAudio(); if (autoArm === armed) armed.audioReady = true; } catch (_) { if (autoArm === armed) autoArm = null; }
      }
      save(); render();
    });
    async function activate() {
      if (active) return;
      active = true; lastBpm = null; controller?.abort(); controller = new AbortController(); const run = ++generation;
      timer = setInterval(render, 100); render();
      const results = await Promise.allSettled([request("/status"), request("/voices"), request("/experiments"), request("/mixer-examples")]);
      if (!active || run !== generation) return;
      const [service, catalog, library, samples] = results;
      if (service.status === "fulfilled") defaultVoice = service.value.default_voice_id || JADE;
      const available = [...voices, ...(service.status === "fulfilled" ? service.value.suggested_voices || [] : []), ...(catalog.status === "fulfilled" ? catalog.value.voices || [] : [])];
      voices = [...new Map(available.filter(item => typeof item?.voice_id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(item.voice_id) && typeof item.name === "string").map(item => [item.voice_id, item])).values()];
      voiceMenu();
      if (library.status === "fulfilled") jobs = (Array.isArray(library.value) ? library.value : library.value.experiments || []).filter(item => typeof item?.id === "string");
      if (samples.status === "fulfilled") examples = (samples.value.examples || []).filter(item => typeof item?.id === "string" && typeof item.track_id === "string" && typeof item.experiment_id === "string");
      const exampleId = $("example").value || saved.example_id || "";
      $("example").innerHTML = '<option value="">Choose a voice + track example…</option>' + examples.map(item => `<option value="${escape(item.id)}">${escape(item.label || item.id)}</option>`).join("");
      $("example").value = examples.some(item => item.id === exampleId) ? exampleId : "";
      savedMenu(); render();
      if (pending) status("A voice request needs checking. Use Recover voice to retrieve it.");
      else if (selected) await check(selected, run);
      else if (service.status === "fulfilled" && !service.value.ready) status((service.value.issues || service.value.setup_errors || []).join(" ") || "Configure the voice service to prepare new voices.", true);
    }
    function deactivate() { active = false; generation++; controller?.abort(); clearTimeout(poll); clearInterval(timer); stop(); preparing = false; buffer = null; ownedContext?.close(); ownedContext = null; save(); }
    setDraft(saved, !saved.experiment_id && !saved.robot_style);
    $("auto").checked = saved.auto_start !== false;
    $("loop").checked = saved.loop === true;
    $("volume").value = number(saved.volume, 0, 1, .8);
    render();
    return { activate, deactivate, getState, stop };
  }
  return { create };
})();
