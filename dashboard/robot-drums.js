"use strict";

// Percussion follows musical contact times. The hardware bridge advances each
// contact by the configured stroke time; this module never sends positions.
globalThis.HydraRobotDrums = (() => {
  const STORAGE_KEY = "hydra-robot-drums-v1";
  const MIN_HIT_INTERVAL_MS = 1000;
  const ARMS = [
    { id: 0, role: "kick", name: "Kick", recovery: 350 },
    { id: 2, role: "snare", name: "Snare", recovery: 350 },
    { id: 3, role: "hat", name: "Hi-hat", recovery: 400 },
    { id: 1, role: "ride", name: "Ride", recovery: 350 }
  ];
  const DEFAULTS = { source: "mixer", style: "straight", density: 55, influence: 65, fills: 25, instruments: [0, 2, 3] };
  const copy = value => JSON.parse(JSON.stringify(value));
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const now = () => globalThis.performance?.now() ?? Date.now();
  let sequence = 0;

  function settings(raw = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Choose valid drumming settings.");
    const input = { ...DEFAULTS, ...raw };
    if (!["mixer", "synth"].includes(input.source)) throw new Error("Choose Music mixer or Synth mixer as the beat source.");
    if (!["straight", "broken", "half"].includes(input.style)) throw new Error("Choose a drumming style.");
    const result = { source: input.source, style: input.style };
    for (const key of ["density", "influence", "fills"]) {
      const value = Number(input[key]);
      if (String(input[key]).trim() === "" || !Number.isFinite(value) || value < 0 || value > 100) throw new Error("Drumming amounts must be between 0 and 100.");
      result[key] = value;
    }
    if (!Array.isArray(input.instruments) || input.instruments.some(id => !Number.isInteger(id) || !ARMS.some(arm => arm.id === id))) throw new Error("Choose valid drumming arms.");
    result.instruments = ARMS.filter(arm => input.instruments.includes(arm.id)).map(arm => arm.id);
    return result;
  }

  // A deterministic bar means preview and scheduling make the same choices.
  // Density adds accents; fast notes are subsequently thinned for each arm.
  function pattern(raw = {}, bar = 0, previousNotes = []) {
    const config = settings(raw), events = new Map(), density = config.density;
    const add = (role, step, threshold, accent = 1, fromSynth = false) => {
      const arm = ARMS.find(item => item.role === role);
      if (density <= 0 || density < threshold || !config.instruments.includes(arm.id)) return;
      const key = `${arm.id}:${step}`;
      const existing = events.get(key);
      if (!existing || accent > existing.accent) events.set(key, { motor_id: arm.id, role, step, beat: Math.max(0, bar) * 4 + step / 4, accent, fromSynth });
    };
    const synth = config.source === "synth" && config.influence > 0;
    add("kick", 0, 1);
    if (!synth || config.influence < 75) add("kick", config.style === "broken" ? 10 : config.style === "half" ? 11 : 8, 35, .85);
    if (config.style === "half") add("snare", 8, 20);
    else { add("snare", 4, 20); add("snare", 12, 20); }
    for (let i = 0; i < 4; i++) {
      add("hat", i * 4 + (config.style === "broken" ? 2 : 0), 25 + (i % 2) * 10, .55);
      add("ride", i * 4, 60 + (i % 2) * 15, .6);
    }
    if (density >= 80) for (const step of config.style === "broken" ? [4, 12] : [2, 10]) add("hat", step, 80, .35);
    if (synth) {
      for (const note of previousNotes) {
        const beat = Number(note.beat), pitches = Array.isArray(note.notes) ? note.notes.filter(Number.isFinite) : [];
        if (!Number.isFinite(beat) || Math.floor(beat / 4) !== bar - 1 || !pitches.length) continue;
        const step = clamp(Math.round((beat - (bar - 1) * 4) * 4), 0, 15);
        const velocity = clamp(Number(note.velocity) || 64, 1, 127);
        const strength = config.influence / 100 * velocity / 127;
        const lowest = Math.min(...pitches);
        if (lowest <= 60 || velocity >= 100) add("kick", step, 35 + (1 - strength) * 35, .65 + .35 * strength, true);
        else add(lowest >= 72 ? "ride" : "hat", step, 30 + (1 - strength) * 40, .45 + .4 * strength, true);
      }
    }
    if (Math.floor(bar) % 4 === 3 && config.fills > 0) {
      add("snare", 14, 90 - config.fills * .3, .65);
      if (config.fills >= 65) add("ride", 15, 75, .7);
    }
    return [...events.values()].sort((a, b) => a.beat - b.beat || a.motor_id - b.motor_id);
  }

  function createEngine(environment = {}) {
    const env = { now, clock: source => globalThis.HydraBeatClock?.snapshot(source),
      setInterval: (callback, delay) => setInterval(callback, delay), clearInterval: timer => clearInterval(timer), ...environment };
    let config = settings(env.settings), enabled = false, phase = "stopped", error = "", message = "", timer = null;
    let session = null, stopTask = null, startTask = null, scheduleTask = null, generation = 0;
    let previousClock = null, currentClock = null, scheduled = 0, played = 0, skipped = 0, lastHeartbeat = -Infinity;
    let sessionPlayed = 0, sessionSkipped = 0;
    let notesToken = null, notes = [], preview = [];
    const listeners = new Set(), seen = new Map(), lastContact = new Map();
    const emit = () => { const value = snapshot(); for (const listener of listeners) listener(value); };
    const usable = clock => clock.running && !clock.rateChanging;

    function readClock() {
      const input = env.clock(config.source) || {}, time = env.now(), bpm = Number(input.bpm), beat = Number(input.beat);
      const at = Number.isFinite(input.at) ? input.at : time;
      const valid = Number.isFinite(bpm) && bpm > 0 && bpm <= 300 && Number.isFinite(beat) && beat >= 0
        && Number.isFinite(input.at) && at <= time + 100 && time - at <= 500;
      return { source: config.source, label: config.source === "synth" ? "Synth mixer" : "Music mixer", running: input.running === true && valid,
        bpm: valid ? bpm : null, beat: valid ? beat + Math.max(0, time - at) * bpm / 60000 : 0,
        token: String(input.token ?? ""), at: time, estimated: Boolean(input.estimated), rateChanging: Boolean(input.rateChanging) };
    }
    function snapshot() {
      return { enabled, running: phase === "running", preparing: phase === "preparing", waiting: enabled && ["waiting", "stopping"].includes(phase),
        phase, error, message, settings: copy(config), clock: currentClock ? { ...currentClock } : null,
        scheduled, played, skipped, pattern: copy(preview), sessionToken: session?.token || null, noteCount: notes.length };
    }
    function resetPlan() { seen.clear(); lastContact.clear(); previousClock = null; lastHeartbeat = -Infinity; }
    function clearNotes(token = null) { notes = []; notesToken = token; }
    function endSession() {
      const old = session;
      if (!old) return stopTask || Promise.resolve();
      session = null; generation++; old.controller.abort(); resetPlan();
      // The retired request may never resolve. Its generation guards already
      // reject late results, so it must not block scheduling in a new session.
      scheduleTask = null;
      const preparing = startTask;
      startTask = null;
      phase = enabled ? "stopping" : "stopped";
      const operation = (async () => {
        await env.hardware.stopDrumming({ token: old.token });
        // An HTTP prepare can resolve after abort. Close that token again before
        // another session is allowed to prepare; it must never regain ownership.
        if (preparing) {
          try { await preparing; } catch (_) { /* The initiating error is reported separately. */ }
          await env.hardware.stopDrumming({ token: old.token });
        }
      })();
      stopTask = operation.catch(failure => {
        const stopError = failure?.message || "Could not stop the drumming arms.";
        enabled = false; phase = "error";
        error = error ? `${error} Stop could not be confirmed: ${stopError}` : stopError;
        if (timer !== null) env.clearInterval(timer); timer = null;
      }).finally(() => {
        stopTask = null;
        if (enabled) { phase = "waiting"; message = "Waiting for the next beat…"; }
        emit();
      });
      return stopTask;
    }
    function stop(reason = "") {
      enabled = false; error = reason; message = "";
      if (timer !== null) env.clearInterval(timer); timer = null;
      const stopped = endSession();
      phase = reason ? "error" : "stopped"; previousClock = null;
      emit(); return stopped;
    }
    function fail(failure) {
      const performance = failure?.result?.performance;
      observePerformance(performance);
      const sessionError = session && performance?.token === session.token ? performance.error : null;
      return stop(sessionError || failure?.message || String(failure || "Drumming stopped after a connection error."));
    }
    function observePerformance(performance) {
      if (!session || performance?.token !== session.token) return;
      if (Number.isInteger(performance.played) && performance.played >= 0) {
        played += Math.max(0, performance.played - sessionPlayed);
        sessionPlayed = Math.max(sessionPlayed, performance.played);
      }
      if (Number.isInteger(performance.skipped) && performance.skipped >= 0) {
        skipped += Math.max(0, performance.skipped - sessionSkipped);
        sessionSkipped = Math.max(sessionSkipped, performance.skipped);
      }
    }
    function responseReady(result, expected) {
      const performance = result?.performance;
      observePerformance(performance);
      if (result?.ok === false || !performance || performance.state !== "ready" || performance.token !== expected) {
        throw new Error(performance?.error || "The drumming session ended. Press Start drumming to prepare again.");
      }
    }
    function hardwareError(hardware) {
      if (hardware.emergencyStopped) return "Emergency stop active. Reset it before starting the drums again.";
      if (phase !== "running") return "";
      const performance = hardware.drumPerformance;
      // The server keeps healthy arms playing during a local arm recovery or
      // fault. Only the matching session on its still-open bus has that right.
      if (typeof hardware.drumPerformanceConnected === "boolean") {
        if (!hardware.drumPerformanceConnected) return "Drumming arms disconnected. Prepare them again with Start drumming.";
        if (performance?.token !== session?.token || performance?.state !== "ready") return performance?.token === session?.token && performance?.error || "The drumming session ended. Press Start drumming to prepare again.";
      } else {
        if (hardware.drumsReady === false || hardware.drumTorqueEnabled === false) return "Drumming arms disconnected or torque released. Prepare them again with Start drumming.";
        if (performance?.token === session?.token && performance?.state !== "ready") return performance.error || "The drumming session ended. Press Start drumming to prepare again.";
      }
      return "";
    }
    function prepare(clock) {
      const id = ++generation, token = `drums-${Math.floor(env.now())}-${Date.now().toString(36)}-${++sequence}`;
      const controller = new AbortController();
      session = { token, controller, clockToken: clock.token, bpm: clock.bpm, generation: id };
      sessionPlayed = 0; sessionSkipped = 0;
      phase = "preparing"; message = "Preparing drumming arms…"; emit();
      const current = () => enabled && session?.generation === id && !controller.signal.aborted;
      const operation = Promise.resolve().then(() => current() ? env.hardware.startDrumming({ token, instruments: [...config.instruments] }, {
        signal: controller.signal, onProgress(value) { if (current()) { message = String(value); emit(); } }
      }) : null).then(result => {
        if (!current()) return;
        responseReady(result, token);
        phase = "running"; message = ""; resetPlan();
      }).catch(failure => {
        if (current()) {
          // Clear startTask before stopping so failure cleanup cannot await itself.
          startTask = null; fail(failure);
        }
      }).finally(() => { if (startTask === operation) startTask = null; emit(); });
      startTask = operation;
      return operation;
    }
    function changedClock(clock) {
      if (!session || clock.token !== session.clockToken || Math.abs(clock.bpm - session.bpm) > Math.max(2, session.bpm * .02)) return true;
      if (!previousClock) return false;
      const expected = previousClock.beat + (clock.at - previousClock.at) * previousClock.bpm / 60000;
      return Math.abs(clock.beat - expected) > .2;
    }
    function schedule(clock) {
      if (scheduleTask) return;
      const time = env.now(), lead = 650, horizon = 950, millisPerBeat = 60000 / clock.bpm;
      const first = Math.max(0, Math.ceil((clock.beat + lead / millisPerBeat) * 4 - 1e-8));
      const last = Math.floor((clock.beat + horizon / millisPerBeat) * 4 + 1e-8);
      const batch = [], bars = new Map();
      for (let step = first; step <= last; step++) {
        const bar = Math.floor(step / 16);
        if (!bars.has(bar)) bars.set(bar, pattern(config, bar, notes));
        for (const hit of bars.get(bar).filter(hit => Math.round(hit.beat * 4) === step)) {
          const key = `${step}:${hit.motor_id}`;
          if (seen.has(key)) continue;
          const contactAt = Math.round(time + (hit.beat - clock.beat) * millisPerBeat);
          seen.set(key, hit.beat);
          const arm = ARMS.find(item => item.id === hit.motor_id);
          if (contactAt - (lastContact.get(arm.id) ?? -Infinity) < Math.max(MIN_HIT_INTERVAL_MS, arm.recovery) || contactAt < env.now() + lead - 1) { skipped++; continue; }
          lastContact.set(arm.id, contactAt);
          batch.push({ id: `${session.token}:${key}`, motor_id: arm.id, contactAt });
        }
      }
      for (const [key, beat] of seen) if (beat < clock.beat - 8) seen.delete(key);
      if (!batch.length && time - lastHeartbeat < 200) return;
      const token = session.token, id = session.generation;
      lastHeartbeat = time;
      const operation = Promise.resolve().then(() => {
        if (!enabled || session?.generation !== id) return null;
        return env.hardware.scheduleDrums({ token, events: batch });
      }).then(result => {
        if (!enabled || session?.generation !== id || !result) return;
        responseReady(result, token);
        scheduled += Array.isArray(result.accepted) ? result.accepted.length : batch.length;
        if (!Number.isInteger(result.performance?.skipped)) skipped += Array.isArray(result.skipped) ? result.skipped.length : 0;
      }).catch(failure => { if (enabled && session?.generation === id) fail(failure); })
        .finally(() => { if (scheduleTask === operation) scheduleTask = null; emit(); });
      scheduleTask = operation;
    }
    function tick() {
      currentClock = readClock();
      preview = pattern(config, Math.floor(currentClock.beat / 4), notes);
      if (!enabled) { emit(); return; }
      try {
        const hardware = env.hardware.snapshot();
        observePerformance(hardware.drumPerformance);
        const hardwareFailure = hardwareError(hardware);
        if (hardwareFailure) throw new Error(hardwareFailure);
        if (notesToken !== currentClock.token) clearNotes(currentClock.token);
        notes = notes.filter(note => note.beat >= currentClock.beat - 12);
        if (!usable(currentClock)) {
          if (session) endSession();
          else if (!stopTask) phase = "waiting";
          message = currentClock.rateChanging ? "Waiting for the track speed to settle…" : `Waiting for ${currentClock.label} playback…`;
          previousClock = null; emit(); return;
        }
        if (session && changedClock(currentClock)) {
          endSession(); message = "Resynchronising to the music…"; emit(); return;
        }
        previousClock = { ...currentClock };
        if (!session && !stopTask) prepare(currentClock);
        else if (phase === "running") schedule(currentClock);
      } catch (failure) { fail(failure); }
      emit();
    }
    function start() {
      if (enabled) return startTask || Promise.resolve(snapshot());
      if (!config.instruments.length) throw new Error("Enable at least one drumming arm.");
      if (env.hardware.snapshot().emergencyStopped) throw new Error("Reset emergency stop before starting the drums.");
      enabled = true; error = ""; phase = "waiting"; scheduled = 0; played = 0; skipped = 0; resetPlan();
      timer = env.setInterval(tick, 50); tick();
      return startTask || Promise.resolve(snapshot());
    }
    function configure(update) {
      const next = settings({ ...config, ...update });
      if (JSON.stringify(next) !== JSON.stringify(config)) {
        stop(); config = next; clearNotes(); currentClock = readClock(); preview = pattern(config, Math.floor(currentClock.beat / 4)); emit();
      }
      return copy(config);
    }
    function recordNote(event) {
      if (!event || !Number.isFinite(event.beat) || event.beat < 0 || !Array.isArray(event.notes)) return;
      const pitches = event.notes.filter(note => Number.isInteger(note) && note >= 0 && note <= 127);
      if (!pitches.length) return;
      const source = env.clock("synth") || {}, token = String(event.token ?? "");
      if (token !== String(source.token ?? "") || !source.running) return;
      if (notesToken !== token) clearNotes(token);
      notes.push({ beat: event.beat, notes: pitches, velocity: clamp(Number(event.velocity) || 64, 1, 127) });
      if (notes.length > 512) notes = notes.slice(-512);
    }
    function importState(value) { const next = settings(value); stop(); config = next; clearNotes(); tick(); return copy(config); }
    function hardwareChanged() {
      if (!enabled) { emit(); return; }
      const state = env.hardware.snapshot();
      observePerformance(state.drumPerformance);
      const hardwareFailure = hardwareError(state);
      if (hardwareFailure) fail(new Error(hardwareFailure));
      else emit();
    }
    currentClock = readClock(); preview = pattern(config, Math.floor(currentClock.beat / 4));
    return { start, stop, tick, configure, recordNote, importState, exportState: () => copy(config), snapshot, hardwareChanged,
      subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); } };
  }

  let root, engine, hardware;
  const $ = name => root.querySelector(`#robot-drums-${name}`);
  function markup() {
    return `<section class="robot-section robot-drums-panel" aria-labelledby="robot-drums-performance-title">
      <header class="robot-section-heading"><div><span class="eyebrow">Percussion</span><h2 id="robot-drums-performance-title">Automatic drumming</h2></div><span id="robot-drums-badge" class="robot-badge">Stopped</span></header>
      <p class="robot-section-intro">Start robot turns arm torque on and moves the arms to rest. Start drumming makes them follow the track’s beat or answer your synth phrase.</p>
      <div class="robot-drums-fields"><label for="robot-drums-source">Follow<select id="robot-drums-source"><option value="mixer">Music mixer · track beat</option><option value="synth">Synth mixer · rhythm and notes</option></select></label><label for="robot-drums-style">Groove<select id="robot-drums-style"><option value="straight">Straight</option><option value="broken">Broken beat</option><option value="half">Half-time</option></select></label></div>
      <fieldset class="robot-drums-arms"><legend>Drumming arms</legend>${ARMS.map(arm => `<label><input type="checkbox" id="robot-drums-arm-${arm.id}" data-drum-arm="${arm.id}">${arm.name}</label>`).join("")}</fieldset>
      <div class="robot-drums-amounts">${[["density", "Density", "Sparse", "Busy"], ["influence", "Synth influence", "Steady groove", "Follow accents"], ["fills", "Fills", "None", "Every fourth bar"]].map(([id, label, low, high]) => `<div id="robot-drums-${id}-field"><div class="robot-position-label"><label for="robot-drums-${id}">${label}</label><output id="robot-drums-${id}-value" for="robot-drums-${id}"></output></div><input id="robot-drums-${id}" type="range" min="0" max="100" step="1"><div class="robot-range"><span>${low}</span><span>${high}</span></div></div>`).join("")}</div>
      <p id="robot-drums-source-help" class="robot-note"></p>
      <div class="robot-drums-preview" role="img" aria-label="Four-beat drum pattern; highlighted cells indicate planned hits"><div class="robot-drums-grid-head"><span></span>${Array.from({ length: 16 }, (_, step) => `<span>${step % 4 === 0 ? step / 4 + 1 : "·"}</span>`).join("")}</div>${ARMS.map(arm => `<div class="robot-drums-grid-row"><span>${arm.name}</span>${Array.from({ length: 16 }, (_, step) => `<i id="robot-drums-cell-${arm.id}-${step}" aria-hidden="true"></i>`).join("")}</div>`).join("")}</div>
      <div class="robot-drums-bottom"><span id="robot-drums-clock" class="robot-drums-clock">Waiting for playback</span><div class="robot-actions"><button type="button" id="robot-drums-start" class="robot-button robot-primary">Start drumming</button><button type="button" id="robot-drums-stop" class="robot-button" disabled>Stop</button></div></div>
      <p id="robot-drums-status" class="robot-status" role="status">Press Start drumming when the arms are ready to play.</p>
    </section>`;
  }
  function save() { try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(engine.exportState())); } catch (_) { /* Session controls remain available. */ } }
  function render(value = engine.snapshot()) {
    if (!root) return;
    const config = value.settings, clock = value.clock, state = hardware.snapshot();
    $("badge").textContent = value.preparing ? "Preparing" : value.waiting ? "Waiting" : value.running ? "Drumming" : value.error ? "Stopped" : "Ready";
    $("badge").classList.toggle("is-live", value.running);
    $("start").disabled = value.enabled || state.emergencyStopped || !config.instruments.length;
    $("start").setAttribute("aria-busy", String(value.preparing));
    $("stop").disabled = !value.enabled && !value.preparing;
    for (const key of ["source", "style", "density", "influence", "fills"]) $(key).value = String(config[key]);
    for (const arm of ARMS) $(`arm-${arm.id}`).checked = config.instruments.includes(arm.id);
    for (const key of ["density", "influence", "fills"]) $(`${key}-value`).textContent = `${config[key]}%`;
    $("influence").disabled = config.source !== "synth";
    $("influence-field").classList.toggle("is-muted", config.source !== "synth");
    $("source-help").textContent = config.source === "synth" ? "The previous synth bar’s note accents shape the next drum bar. The synth clock keeps both parts in time." : "Tempo and beat position come directly from the Music mixer. Changes to the track or its speed resynchronise the arms.";
    $("clock").textContent = clock?.running ? `${clock.label} · ${Math.round(clock.bpm)} BPM${clock.estimated ? " · estimated grid" : ""}` : `Waiting for ${clock?.label || "music"}`;
    const hits = new Set(value.pattern.map(hit => `${hit.motor_id}-${hit.step}`));
    const currentStep = value.running && clock ? Math.floor(clock.beat * 4) % 16 : -1;
    for (const arm of ARMS) for (let step = 0; step < 16; step++) {
      const cell = $(`cell-${arm.id}-${step}`);
      cell.classList.toggle("is-hit", hits.has(`${arm.id}-${step}`));
      cell.classList.toggle("is-current", step === currentStep);
    }
    const status = value.error || value.message || (value.running ? "" : "Press Start drumming when the arms are ready to play. Editing the pattern stops drumming.");
    $("status").textContent = status; $("status").hidden = !status;
    $("status").classList.toggle("is-error", Boolean(value.error));
  }
  function init(element, bridge) {
    if (root || !element || !bridge) return;
    root = element; hardware = bridge; root.classList.add("robot-drums"); root.innerHTML = markup();
    let saved;
    try { saved = settings(JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || "{}")); } catch (_) { saved = settings(); }
    engine = createEngine({ hardware, settings: saved });
    engine.subscribe(render); hardware.subscribe?.(() => engine.hardwareChanged());
    root.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button || button.disabled) return;
      if (button.id === "robot-drums-stop") engine.stop();
      if (button.id === "robot-drums-start") {
        try { Promise.resolve(engine.start()).catch(error => engine.stop(error.message)); }
        catch (error) { engine.stop(error.message); }
      }
    });
    root.addEventListener("change", event => {
      const target = event.target, key = target.id.replace("robot-drums-", "");
      try {
        if (target.dataset.drumArm !== undefined) engine.configure({ instruments: ARMS.filter(arm => $(`arm-${arm.id}`).checked).map(arm => arm.id) });
        else if (["source", "style", "density", "influence", "fills"].includes(key)) engine.configure({ [key]: ["source", "style"].includes(key) ? target.value : Number(target.value) });
        save();
      } catch (error) { engine.stop(error.message); }
    });
    root.addEventListener("input", event => {
      const key = event.target.id.replace("robot-drums-", "");
      if (!["density", "influence", "fills"].includes(key)) return;
      try { engine.configure({ [key]: Number(event.target.value) }); save(); }
      catch (error) { engine.stop(error.message); }
    });
  }
  return { init, createEngine, settings, pattern, ARMS: copy(ARMS), STORAGE_KEY,
    setSource(source) { settings({ source }); if (engine && engine.snapshot().settings.source !== source) { engine.configure({ source }); save(); } },
    activate: () => { if (engine) { engine.tick(); render(); } }, stop: reason => engine?.stop(reason),
    snapshot: () => engine?.snapshot(), exportState: () => engine?.exportState() || settings(),
    subscribe: listener => engine?.subscribe(listener) || (() => {}),
    importState(value) { const config = settings(value); if (engine) engine.importState(config); try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(config)); } catch (_) {} return config; },
    recordNote: event => engine?.recordNote(event) };
})();
