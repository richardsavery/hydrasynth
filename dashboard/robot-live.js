"use strict";

// The performance clock belongs to the application, independently of its visible tab.
globalThis.HydraRobotLive = (() => {
  const presets = {
    aurora: { name: "Aurora", colours: ["#48e0c0", "#6699ff", "#b580ff", "#ff83c5"] },
    fire: { name: "Firelight", colours: ["#ffb347", "#ff683b", "#f03854", "#ffd67a"] },
    ocean: { name: "Ocean", colours: ["#46dcff", "#337dff", "#2954b8", "#62ffc5"] },
    candy: { name: "Candy", colours: ["#ff61be", "#b18aff", "#6edcff", "#ffe68a"] }
  };
  const defaults = { source: "mixer", leds: true, ledMode: "cycle", palette: presets.aurora.colours,
    brightness: 65, ledBeats: 1, ribs: false, ribMin: 20, ribMax: 100, ribBeats: 4,
    headBeatSync: true, headBusyness: 0, headBusynessAuto: false };
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const storageKey = "hydra-robot-live-settings-v1";
  const now = () => globalThis.performance?.now() ?? Date.now();
  // Leave ten percent of each recorded half-range unused at the largest span.
  function headTarget(axis, amount, position) {
    if (!axis || ![axis.min, axis.centre, axis.max].every(Number.isInteger) || axis.min > axis.centre || axis.centre > axis.max || axis.min === axis.max) throw new Error("Record and save the head range in Keirzo setup first.");
    const extent = position < 0 ? axis.centre - axis.min : axis.max - axis.centre;
    return Math.round(axis.centre + extent * .9 * amount / 100 * position / 100);
  }
  const serialBusy = (hardware, group) => hardware.commandBusy === undefined ? hardware.busy : hardware.commandBusy || hardware[`${group}Busy`];

  function settings(value = {}) {
    const input = { ...defaults, ...value };
    // Preserve whether older sessions selected the head. Enabled is now separate
    // from activity so the bottom of the slider can still move continuously.
    if (value.headBusyness === undefined && value.head === true) input.headBusyness = 25;
    const number = (key, min, max) => {
      const n = Number(input[key]);
      if (String(input[key]).trim() === "" || !Number.isFinite(n) || n < min || n > max) throw new Error(`${key === "ribMin" || key === "ribMax" ? "Rib range" : key === "brightness" ? "Brightness" : key === "headBusyness" ? "Head busy-ness" : "Beat interval"} must be between ${min} and ${max}.`);
      return n;
    };
    if (!["solid", "cycle", "pulse"].includes(input.ledMode)) throw new Error("Choose an LED pattern.");
    if (!Array.isArray(input.palette) || input.palette.length < 1 || input.palette.length > 8 || input.palette.some(colour => !/^#[a-f\d]{6}$/i.test(colour))) throw new Error("Choose valid palette colours.");
    // Legacy local-tempo settings fall back to playback; never create a robot clock.
    const source = ["manual", "auto"].includes(input.source) ? "mixer" : input.source;
    if (!["mixer", "synth"].includes(source)) throw new Error("Choose Music mixer or Synth mixer to follow.");
    const result = { source, leds: Boolean(input.leds),
      ledMode: input.ledMode, palette: [...input.palette], brightness: number("brightness", 0, 100),
      ledBeats: number("ledBeats", .25, 16), ribs: Boolean(input.ribs),
      ribMin: number("ribMin", 0, 127), ribMax: number("ribMax", 0, 127), ribBeats: number("ribBeats", 1, 16),
      headBeatSync: Boolean(input.headBeatSync), headBusyness: number("headBusyness", 0, 100),
      headBusynessAuto: Boolean(input.headBusynessAuto) };
    if (!Number.isInteger(result.ribMin) || !Number.isInteger(result.ribMax) || result.ribMin >= result.ribMax) throw new Error("The rib minimum must be a whole number below the maximum (0–127).");
    if (!Number.isInteger(result.headBusyness)) throw new Error("Head busy-ness must be a whole number from 0 to 100.");
    result.headEnabled = value.headEnabled === undefined
      ? value.head === true || result.headBusynessAuto || result.headBusyness > 0 : Boolean(value.headEnabled);
    result.head = result.headEnabled;
    return result;
  }

  function createEngine(environment) {
    const env = { setInterval: (callback, delay) => setInterval(callback, delay),
      clearInterval: timer => clearInterval(timer), now, random: Math.random, clock: () => ({ running: false, bpm: null, beat: 0 }), ...environment };
    const listeners = new Set();
    let config = settings(environment.settings), running = false, waiting = false, error = "", timer = null;
    let generation = 0, ribPending = false, headPending = false, headPosition = null, ribController, headController;
    let lastHead = null;
    let observedHeadMove = "", phrase = null;
    const glanceTargets = new Map(), headUntil = new Map();
    let autoBusyness = clamp(config.headBusyness || 25, 15, 65), autoTarget = autoBusyness, autoAt = null, autoNext = 0;
    let lastLED = "", lastRib = null, lastBeat = null, currentColour = config.palette[0], currentBrightness = 0, ribPosition = null;
    let currentClock = clock();

    function clock() {
      const external = env.clock(config.source) || {};
      const bpm = Number(external.bpm), beat = Number(external.beat);
      return { ...external, source: config.source, label: config.source === "synth" ? "Synth mixer" : "Music mixer",
        running: external.running === true && Number.isFinite(bpm) && bpm > 0 && Number.isFinite(beat),
        bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null, beat: Number.isFinite(beat) ? Math.max(0, beat) : 0 };
    }
    function snapshot() {
      return { running, waiting, error, clock: { ...currentClock }, settings: { ...config, palette: [...config.palette] },
        colour: currentColour, brightness: currentBrightness, ribPosition, ribPending, headPending,
        headMoving: headPending || [...headUntil.values()].some(until => env.now() < until), headPosition, headBusyness: Math.round(activity()) };
    }
    function publish() { const value = snapshot(); for (const listener of listeners) listener(value); }
    const random = () => clamp(Number(env.random()) || 0, 0, .999999999);
    function activity() { return config.headBusynessAuto ? autoBusyness : config.headBusyness; }
    function resetAuto(restart = false) {
      autoAt = null; autoNext = 0;
      if (restart) autoBusyness = clamp(config.headBusyness || 25, 15, 65);
      autoTarget = autoBusyness;
    }
    function updateActivity(time) {
      if (!config.headBusynessAuto) return;
      const elapsed = autoAt === null ? 0 : clamp(time - autoAt, 0, config.headBeatSync ? 2 : 1);
      autoAt = time;
      const change = elapsed * (config.headBeatSync ? .75 : 1.5);
      autoBusyness += clamp(autoTarget - autoBusyness, -change, change);
      if (time >= autoNext) {
        autoTarget = 15 + 50 * random();
        autoNext = time + (config.headBeatSync ? 32 : 16) * (1 + random());
      }
    }
    function behaviour() {
      const busy = activity();
      return { busy, span: 25 + busy * .55 };
    }
    function forgetReleasedHead(hardware) {
      if (hardware.emergencyStopped || (Array.isArray(hardware.headMotion)
          && hardware.headMotion.length === 0 && hardware.headLastMove === null)) {
        headUntil.clear(); glanceTargets.clear(); observedHeadMove = "";
      }
    }
    function observeHeadMove(hardware) {
      const move = hardware.headLastMove;
      if (!move) return;
      const targets = Array.isArray(move.targets) ? move.targets : [move];
      const key = JSON.stringify([targets, move.started_at]);
      if (key !== observedHeadMove) {
        const checkedAt = Date.parse(hardware.headCheckedAt), startedAt = Date.parse(move.started_at);
        for (const target of targets) {
          if (!Number.isInteger(target.motor_id) || !Number.isInteger(target.position)) continue;
          const moving = Array.isArray(hardware.headMotion)
            ? hardware.headMotion.some(row => row.motor_id === target.motor_id) : hardware.headBusy;
          const duration = target.duration_ms ?? move.duration_ms;
          const measuredAfterMove = !moving && Number.isFinite(checkedAt) && Number.isFinite(startedAt)
            && Number.isFinite(duration) && checkedAt >= startedAt + duration;
          // Fresh supported poses supersede historical goals; active axes keep
          // their acknowledged endpoint while the peer starts another profile.
          if (!measuredAfterMove) glanceTargets.set(target.motor_id, target.position);
        }
        observedHeadMove = key;
      }
    }
    function resetGlances() {
      phrase = null;
      const hardware = env.hardware.snapshot();
      forgetReleasedHead(hardware);
      const activeTargets = new Map([...glanceTargets].filter(([id]) => env.now() < (headUntil.get(id) || 0)));
      glanceTargets.clear(); observedHeadMove = "";
      for (const axis of hardware.headCalibration?.axes || []) {
        const active = hardware.headMotion?.find(row => row.motor_id === axis.id);
        const position = active?.position ?? activeTargets.get(axis.id) ?? hardware.headPositions?.[axis.id];
        if (Number.isInteger(position)) glanceTargets.set(axis.id, position);
      }
      observeHeadMove(hardware);
    }
    function randomGlances(hardware, motion) {
      // A cancelled UI cue may still have reached the controller before Stop.
      // Observe that acknowledged target once, without reseeding old readbacks.
      observeHeadMove(hardware);
      const axes = hardware.headCalibration.axes.filter(axis => {
        if (env.now() < (headUntil.get(axis.id) || 0)
            || hardware.headMotion?.some(row => row.motor_id === axis.id)) return false;
        const previous = glanceTargets.get(axis.id) ?? axis.centre;
        return headTarget(axis, motion.span, -100) !== previous || headTarget(axis, motion.span, 100) !== previous;
      });
      if (!axes.length) return [];
      // Sustained phrases coordinate both axes; each axis finishes its native
      // profile before receiving another goal. There is no future motion queue.
      if (!phrase?.remaining) {
        const kinds = ["sweep", "wander", "drift"].filter(kind => kind !== phrase?.kind);
        phrase = { kind: kinds[Math.floor(random() * kinds.length)], remaining: 4 + Math.floor(random() * 4) };
      }
      const ends = new Map(headUntil), targets = [];
      for (const axis of axes) {
        const low = headTarget(axis, motion.span, -100), high = headTarget(axis, motion.span, 100);
        const previous = glanceTargets.get(axis.id) ?? axis.centre;
        const separation = Math.max(1, Math.round((high - low) * .35));
        const direction = random() < .5 ? -1 : 1;
        let position, pace;
        if (phrase.kind === "sweep") {
          position = headTarget(axis, motion.span, (previous >= axis.centre ? -1 : 1) * (65 + 35 * random()));
          pace = 60 + 5 * random();
        } else if (phrase.kind === "drift") {
          position = Math.round(clamp(previous + direction * (high - low) * (.22 + .28 * random()), low, high));
          pace = 50 + 10 * random();
        } else {
          position = headTarget(axis, motion.span, direction * (35 + 65 * random()));
          pace = 55 + 10 * random();
        }
        if (Math.abs(position - previous) < separation) position = Math.abs(low - previous) > Math.abs(high - previous) ? low : high;
        const step = value => Math.round(clamp(value, previous - 675, previous + 675));
        const durationFor = value => {
          const distance = Math.abs(value - previous);
          let duration = Math.max(clamp(1000 * distance / pace, 1000, 10000), Math.ceil(2000 * distance / 150));
          if (config.headBeatSync) {
            const beatMs = 60000 / currentClock.bpm, aligned = Math.ceil(duration / beatMs) * beatMs;
            if (aligned <= 10000 && distance * 1000 / aligned >= 40) duration = aligned;
          }
          return Math.round(clamp(duration, 1000, 10000));
        };
        position = step(position);
        if (position === previous) continue;
        let duration = durationFor(position);
        const peerEnd = [...ends].find(([id, end]) => id !== axis.id && end > env.now())?.[1];
        if (peerEnd !== undefined && Math.abs(env.now() + duration - peerEnd) < 500) {
          // Stagger turnarounds by changing travel, not by slowing a small move
          // or interrupting a profile. The other axis carries motion through it.
          const alternatives = [low, high, previous + (position - previous) * .65, previous + (position - previous) * 1.35,
            previous - separation, previous + separation]
            .map(value => step(clamp(value, low, high)))
            .filter(value => Math.abs(value - previous) >= Math.min(separation, 675))
            .map(value => ({ position: value, duration: durationFor(value) }));
          const staggered = alternatives.find(value => Math.abs(env.now() + value.duration - peerEnd) >= 500);
          if (staggered) ({ position, duration } = staggered);
        }
        targets.push({ motor_id: axis.id, position, duration_ms: duration });
        ends.set(axis.id, env.now() + duration);
      }
      return targets;
    }
    function stop(reason = "") {
      const turnOffLEDs = running && config.leds && !reason;
      ribController?.abort(); ribController = null; headController?.abort(); headController = null;
      running = false; waiting = false; generation++; error = reason;
      if (timer !== null) env.clearInterval(timer);
      timer = null;
      if (turnOffLEDs && env.hardware.snapshot().ledConnected) {
        try { env.hardware.sendColour("#000000", 0); currentBrightness = 0; }
        catch (failure) { error = failure.message || "Could not turn the LEDs off."; }
      }
      currentClock = clock(); publish();
    }
    function available() {
      const hardware = env.hardware.snapshot();
      if (hardware.emergencyStopped) throw new Error("Emergency stop active. Reset it before starting Keirzo.");
      if (!config.leds && !config.ribs && !config.head) {
        if (!hardware.drumsReady) throw new Error("Drum arms disconnected. Press Start robot to reconnect and move them to rest.");
        if (!hardware.drumTorqueEnabled) throw new Error("Arm torque is off. Press Start robot to enable the arms and move them to rest.");
      }
      if (config.leds && !hardware.ledConnected) throw new Error("LED controller disconnected. Press Start robot to reconnect.");
      if (config.ribs && !hardware.ribsReady) throw new Error("Rib cage is not connected. Press Start robot to reconnect.");
      if (config.ribs && !hardware.armed) throw new Error("Emergency stop active. Reset it before starting Keirzo.");
      if (config.ribs && !hardware.torqueEnabled) throw new Error("Rib torque is off. Start robot turns rib torque on.");
      const axesReady = hardware.headCalibration?.axes?.length === 2;
      if (config.head && (!hardware.headReady || !axesReady)) throw new Error(hardware.headError || "Head is not ready. Check its saved range in Keirzo setup, then press Start robot.");
      if (config.head && (!hardware.armed || !hardware.headTorqueEnabled)) throw new Error("Head torque is off. Start robot turns head torque on.");
      return hardware;
    }
    function tick() {
      if (!running) return;
      try {
        const hardware = available();
        currentClock = clock();
        waiting = Boolean(config.leds || config.ribs || config.head) && !currentClock.running && !(config.head && !config.headBeatSync);
        if (!currentClock.running) {
          ribController?.abort();
          if (config.headBeatSync) headController?.abort();
        }
        const beat = currentClock.beat;
        if (currentClock.running && lastBeat !== null && beat < lastBeat) {
          ribController?.abort(); lastLED = ""; lastRib = null;
          if (config.headBeatSync) {
            headController?.abort(); lastHead = null; resetGlances(); resetAuto();
          }
        }
        if (currentClock.running) lastBeat = beat;
        if (config.leds && currentClock.running) {
          const paletteIndex = config.ledMode === "solid" ? 0 : Math.floor(beat / config.ledBeats) % config.palette.length;
          const colour = config.palette[paletteIndex];
          // One pulse per quarter note; colours can change at a separate musical interval.
          const envelope = config.ledMode === "pulse" ? Math.pow(1 - (beat % 1), 2) : 1;
          const brightness = Math.round(config.brightness * envelope);
          const key = `${colour}:${brightness}`;
          if (key !== lastLED) {
            env.hardware.sendColour(colour, brightness);
            lastLED = key; currentColour = colour; currentBrightness = brightness;
          }
        }
        if (config.ribs && currentClock.running) {
          const bucket = Math.floor(beat / config.ribBeats);
          if (bucket !== lastRib) {
            // Consume the boundary even if serial is busy: never queue a backlog of movements.
            lastRib = bucket;
            if (!ribPending && !serialBusy(hardware, "ribs")) {
              const position = bucket % 2 === 0 ? config.ribMin : config.ribMax;
              const duration = Math.round(clamp(config.ribBeats * 60000 / currentClock.bpm * .9, 100, 5000));
              const token = generation;
              ribPending = true; ribPosition = position;
              const controller = new AbortController(); ribController = controller;
              let request;
              try { request = env.hardware.moveRibs(position, duration, { signal: controller.signal }); }
              catch (failure) { ribPending = false; throw failure; }
              Promise.resolve(request).then(() => {
                ribPending = false;
                if (running && token === generation) publish();
              }, failure => {
                ribPending = false;
                if (running && token === generation && !controller.signal.aborted) stop(failure.message || "Rib movement failed. Check Keirzo setup.");
              });
            }
          }
        }
        if (config.head && (!config.headBeatSync || currentClock.running)) {
          const headTime = config.headBeatSync ? beat : env.now() / 1000;
          updateActivity(headTime);
          const motion = behaviour();
          let eligible = !config.headBeatSync, boundary = null;
          if (config.headBeatSync) {
            boundary = Math.floor(beat);
            // Align the start of a phrase, then let long profiles flow without
            // adding a new beat-sized standstill after every settled movement.
            eligible = lastHead !== null || (beat - boundary) * 60000 / currentClock.bpm <= 150;
          }
          // Each axis owns its full native profile. An idle axis can start its
          // next segment while its peer is moving, without accumulating a queue.
          const headBlocked = hardware.headCommandBusy ?? (Array.isArray(hardware.headMotion)
            ? hardware.commandBusy : serialBusy(hardware, "head"));
          if (eligible && !headPending && !headBlocked) {
            const targets = randomGlances(hardware, motion);
            if (!targets.length) { publish(); return; }
            lastHead = boundary;
            const token = generation;
            headPending = true; headPosition = targets[0].position;
            const controller = new AbortController(); headController = controller;
            let request;
            try { request = env.hardware.moveHeadAxes(targets, { signal: controller.signal }); }
            catch (failure) { headPending = false; throw failure; }
            Promise.resolve(request).then(result => {
              headPending = false;
              const move = result?.head?.last_move;
              for (const target of targets) {
                const accepted = move?.targets?.find(row => row.motor_id === target.motor_id);
                const actual = Number(accepted?.duration_ms ?? move?.duration_ms);
                const remaining = result?.head?.motion?.find(row => row.motor_id === target.motor_id)?.remaining_ms;
                // Convert a fresh response exactly once. Reusing a cached
                // remaining_ms value on each tick would keep extending the wait.
                headUntil.set(target.motor_id, env.now() + (Number.isFinite(remaining) && remaining >= 0
                  ? remaining : Number.isFinite(actual) && actual >= 1000 ? actual : target.duration_ms));
                glanceTargets.set(target.motor_id, accepted?.position ?? target.position);
              }
              if (running && token === generation && !controller.signal.aborted) {
                if (phrase) phrase.remaining--;
                publish();
              }
            }, failure => {
              headPending = false;
              if (running && token === generation && !controller.signal.aborted) stop(failure.message || "Head movement failed. Check Keirzo setup.");
            });
          }
        }
        publish();
      } catch (failure) {
        stop(failure.message || "Keirzo stopped after a connection error.");
      }
    }
    function start() {
      if (running) return snapshot();
      if (ribPending && config.ribs) throw new Error("Wait for the current rib movement request to finish.");
      if (headPending && config.head) throw new Error("Wait for the current head movement request to finish.");
      available();
      generation++; running = true; error = "";
      lastLED = ""; lastRib = null; lastHead = null; lastBeat = null;
      resetGlances(); resetAuto(true);
      timer = env.setInterval(tick, 50);
      tick();
      return snapshot();
    }
    function configure(update) {
      const next = settings({ ...config, ...update });
      const changedSource = next.source !== config.source;
      const changedRibs = changedSource || next.ribs !== config.ribs || next.ribMin !== config.ribMin || next.ribMax !== config.ribMax || next.ribBeats !== config.ribBeats;
      const changedHead = (changedSource && next.headBeatSync) || ["headEnabled", "headBeatSync", "headBusyness", "headBusynessAuto"].some(key => next[key] !== config[key]);
      const changedAuto = next.headBusynessAuto !== config.headBusynessAuto;
      if (running && config.leds && !next.leds) {
        try { env.hardware.sendColour("#000000", 0); currentBrightness = 0; }
        catch (failure) { stop(failure.message || "Could not turn the LEDs off."); }
      }
      if (next.leds !== config.leds || changedSource) lastLED = "";
      if (changedSource) lastBeat = null;
      config = next;
      if (changedRibs) { ribController?.abort(); lastRib = null; }
      if (changedHead) { headController?.abort(); lastHead = null; resetGlances(); resetAuto(changedAuto); }
      currentClock = clock();
      waiting = running && Boolean(config.leds || config.ribs || config.head) && !currentClock.running && !(config.head && !config.headBeatSync);
      publish();
      return snapshot();
    }
    function refresh() { currentClock = clock(); publish(); }
    function hardwareChanged() {
      forgetReleasedHead(env.hardware.snapshot());
      if (running) { try { available(); } catch (failure) { stop(failure.message); } }
      publish();
    }
    return { start, stop, configure, snapshot, refresh, hardwareChanged, tick,
      subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); } };
  }

  let root, hardware, engine, initialized = false, uiError = "";
  let starting = false, startProgress = "", startGeneration = 0, startController = null, startPromise = null;
  let resettingEmergency = false;
  let syncingSource = false;
  const $ = name => root.querySelector(`#robot-live-${name}`);
  function markup() {
    return `<header class="robot-heading"><div><span class="eyebrow">Performance</span><h1>Keirzo control</h1><p>Colour and movement, in time with your music.</p></div><span id="robot-live-badge" class="robot-badge">Stopped</span></header>
      <section class="robot-live-transport" aria-label="Keirzo transport">
        <div class="robot-live-tempo"><label for="robot-live-source">Follow<select id="robot-live-source"><option value="mixer">Music mixer</option><option value="synth">Synth mixer</option></select></label><a id="robot-live-source-link" href="#mixer">Music mixer ↗</a></div>
        <div class="robot-live-playback"><div class="robot-live-beat" id="robot-live-beat" aria-hidden="true"><i></i><i></i><i></i><i></i></div><span id="robot-live-clock-label" class="robot-live-clock-label">Waiting for music</span>
          <div class="robot-actions"><button type="button" id="robot-live-start" class="robot-button robot-primary">Start robot</button><button type="button" id="robot-live-stop" class="robot-button" disabled>Stop</button><button type="button" id="robot-live-emergency-stop" class="robot-button robot-emergency">Emergency stop</button><button type="button" id="robot-live-reset-emergency" class="robot-button robot-live-reset" hidden>Reset emergency stop</button></div></div>
      </section>
      <div class="robot-live-status-row"><p id="robot-live-status" class="robot-status" role="status">Start robot connects your selected effects. Patterns keep running as you change tabs.</p><a href="#robot-setup" class="robot-live-setup-link">Keirzo setup (if needed) ↗</a></div>
      <div id="robot-live-drumming"></div>
      <div class="robot-sections">
        <section class="robot-section robot-live-leds" aria-labelledby="robot-live-leds-title">
          <header class="robot-section-heading"><div><span class="eyebrow">Light</span><h2 id="robot-live-leds-title">LED performance</h2></div><label class="robot-live-switch"><input id="robot-live-leds" type="checkbox" checked>Enabled</label></header>
          <p id="robot-live-led-connection" class="robot-live-connection">Connects when you press Start robot</p>
          <div class="robot-live-led-top"><div id="robot-live-preview" class="robot-live-preview" aria-hidden="true"><span></span></div><div class="robot-live-led-fields"><label for="robot-live-mode">Pattern<select id="robot-live-mode"><option value="solid">Solid colour</option><option value="cycle" selected>Palette cycle</option><option value="pulse">Beat pulse</option></select></label><label for="robot-live-led-beats">Change colour every<select id="robot-live-led-beats"><option value="0.25">¼ beat</option><option value="0.5">½ beat</option><option value="1" selected>1 beat</option><option value="2">2 beats</option><option value="4">4 beats</option><option value="8">8 beats</option><option value="16">16 beats</option></select></label></div></div>
          <div class="robot-live-palette-heading"><label for="robot-live-preset">Colour palette</label><select id="robot-live-preset">${Object.entries(presets).map(([key, preset]) => `<option value="${key}">${preset.name}</option>`).join("")}<option value="custom">Custom</option></select></div>
          <div class="robot-live-palette">${defaults.palette.map((colour, index) => `<label for="robot-live-colour-${index}"><input type="color" id="robot-live-colour-${index}" data-live-colour="${index}" value="${colour}" aria-label="Palette colour ${index + 1}"><span>${index + 1}</span></label>`).join("")}</div>
          <div class="robot-position-label"><label for="robot-live-brightness">Brightness</label><output id="robot-live-brightness-value" for="robot-live-brightness">65%</output></div><input id="robot-live-brightness" type="range" min="0" max="100" step="1" value="65"><div class="robot-range"><span>0%</span><span>100%</span></div>
        </section>
        <section class="robot-section robot-live-ribs" aria-labelledby="robot-live-ribs-title">
          <header class="robot-section-heading"><div><span class="eyebrow">Movement</span><h2 id="robot-live-ribs-title">Rib breathing</h2></div><label class="robot-live-switch"><input id="robot-live-ribs" type="checkbox">Enabled</label></header>
          <p id="robot-live-rib-connection" class="robot-live-connection">Enable rib breathing to include it when you start.</p>
          <div class="robot-live-breath" aria-hidden="true"><div id="robot-live-breath-shape"><i></i><i></i><i></i></div><span id="robot-live-rib-position">—</span></div>
          <div class="robot-pair robot-live-rib-range"><label for="robot-live-rib-min">Minimum position<input id="robot-live-rib-min" type="number" min="0" max="126" step="1" value="20"></label><label for="robot-live-rib-max">Maximum position<input id="robot-live-rib-max" type="number" min="1" max="127" step="1" value="100"></label></div>
          <label for="robot-live-rib-beats" class="robot-live-rib-speed">Move to the next position every<select id="robot-live-rib-beats"><option value="1">1 beat</option><option value="2">2 beats</option><option value="4" selected>4 beats</option><option value="8">8 beats</option><option value="16">16 beats</option></select></label>
          <p class="robot-note">Alternates between your two positions using the original 0–127 mapping.</p>
        </section>
        <section class="robot-section robot-live-head" aria-labelledby="robot-live-head-title">
          <header class="robot-section-heading"><div><span class="eyebrow">Movement</span><h2 id="robot-live-head-title">Head</h2></div><label class="robot-live-switch"><input id="robot-live-head-enabled" type="checkbox">Enabled</label></header>
          <p id="robot-live-head-connection" class="robot-live-connection">Uses the ranges recorded in Keirzo setup.</p>
          <label class="robot-live-switch"><input id="robot-live-head-beat-sync" type="checkbox" checked>Beat sync</label>
          <div class="robot-position-label robot-live-head-busyness">
            <label for="robot-live-head-busyness">Busy-ness</label>
            <div class="robot-live-head-busyness-controls"><select id="robot-live-head-busyness-mode" aria-label="Busy-ness control"><option value="manual">Manual</option><option value="auto">Auto</option></select><output id="robot-live-head-busyness-value" for="robot-live-head-busyness">0%</output></div>
          </div>
          <input id="robot-live-head-busyness" type="range" min="0" max="100" step="1" value="0"><div class="robot-range"><span>Flowing</span><span>Expansive</span></div>
          <p class="robot-note">Both axes move together through flowing sweeps and turns. 0% keeps moving; higher levels explore more of the saved range. Turn Enabled off to finish the current movements and stop.</p>
        </section>
      </div>`;
  }

  function notice(message, isError) {
    if ($("status").textContent !== message) $("status").textContent = message;
    $("status").classList.toggle("is-error", Boolean(isError));
  }
  function cancelStartup() {
    startGeneration++;
    startController?.abort();
    startController = null; startPromise = null; starting = false; startProgress = "";
  }
  function stopLive() {
    cancelStartup(); uiError = ""; engine.stop();
  }
  function startLive({ prepareDrums = true } = {}) {
    if (startPromise) return startPromise;
    if (engine.snapshot().running || resettingEmergency) return Promise.resolve();
    let config;
    try {
      config = settings(formSettings());
      if (hardware.snapshot().emergencyStopped) throw new Error("Emergency stop active. Reset it before starting Keirzo.");
      uiError = ""; engine.stop(); engine.configure(config); saveSettings();
    } catch (error) { uiError = error.message; render(); return Promise.resolve(); }
    const token = ++startGeneration, controller = new AbortController();
    startController = controller; starting = true; startProgress = "Connecting Keirzo…";
    const current = () => token === startGeneration && startController === controller && !controller.signal.aborted;
    render();
    startPromise = Promise.resolve().then(async () => {
      if (!current()) return;
      await hardware.prepareLive({ leds: config.leds, ribs: config.ribs, head: config.head, drums: prepareDrums }, {
        signal: controller.signal,
        onProgress(message) { if (current()) { startProgress = String(message); render(); } }
      });
      if (current()) engine.start();
    }).catch(error => {
      if (current() && !error?.cancelled && error?.name !== "AbortError") uiError = error?.message || "Keirzo could not start.";
    }).finally(() => {
      if (token !== startGeneration) return;
      startController = null; startPromise = null; starting = false; startProgress = ""; render();
    });
    return startPromise;
  }
  function emergencyStop() {
    stopLive();
    const token = startGeneration;
    try {
      Promise.resolve(hardware.emergencyStop()).catch(error => {
        if (token === startGeneration) { uiError = error.message; render(); }
      });
    } catch (error) { uiError = error.message; render(); }
  }
  function resetEmergency() {
    const status = hardware.snapshot();
    if (resettingEmergency || status.emergencyPending || status.emergencyResetPending || !status.emergencyStopped) return;
    stopLive(); resettingEmergency = true; render();
    Promise.resolve().then(() => hardware.resetEmergency()).then(() => {
      uiError = ""; engine.stop();
    }).catch(error => { uiError = error.message || "Emergency stop could not be reset."; }).finally(() => {
      resettingEmergency = false; render();
    });
  }
  function render(value = engine.snapshot()) {
    const status = hardware.snapshot(), config = value.settings;
    const drums = globalThis.HydraRobotDrums?.snapshot?.() || {};
    const resetting = resettingEmergency || status.emergencyResetPending;
    const performing = (value.running && !value.waiting) || drums.running;
    const awaitingMusic = !performing && ((value.running && value.waiting) || (drums.enabled && drums.waiting));
    for (const indicator of globalThis.document?.querySelectorAll("[data-robot-live-indicator]") || []) {
      indicator.hidden = !value.running && !starting && !drums.enabled;
      indicator.textContent = starting || drums.preparing ? "Starting" : awaitingMusic ? "Waiting" : "Live";
    }
    $("badge").textContent = starting || drums.preparing ? "Starting" : resetting ? "Resetting" : value.running || drums.enabled ? awaitingMusic ? "Waiting for beat" : "Running" : "Stopped";
    $("badge").classList.toggle("is-live", value.running || drums.running);
    $("badge").classList.toggle("is-starting", starting || resetting);
    $("start").disabled = value.running || starting || resetting || status.emergencyStopped;
    $("start").setAttribute("aria-busy", String(starting));
    $("stop").disabled = !value.running && !starting && !drums.enabled;
    $("reset-emergency").hidden = !status.emergencyStopped;
    $("reset-emergency").disabled = resetting || status.emergencyPending;
    for (const id of ["source", "leds", "mode", "led-beats", "preset", "brightness", "ribs", "rib-min", "rib-max", "rib-beats", "head-enabled", "head-beat-sync", "head-busyness-mode", "head-busyness", "colour-0", "colour-1", "colour-2", "colour-3"]) $(id).disabled = starting || resetting;
    $("led-beats").disabled = starting || resetting || config.ledMode === "solid";
    const clock = value.clock;
    $("source").value = config.source;
    $("source-link").href = config.source === "synth" ? "#synth-mixer" : "#mixer";
    $("source-link").textContent = `${clock.label} ↗`;
    $("clock-label").textContent = clock.running ? `${clock.label} · ${Math.round(clock.bpm)} BPM` : value.running && config.head && !config.headBeatSync ? "Head at its own pace · music stopped" : `Waiting for ${clock.label}`;
    $("beat").dataset.beat = value.running && clock.running ? String(Math.floor(clock.beat) % 4) : "";
    const colour = value.running ? value.colour : config.palette[0];
    $("preview").style.setProperty("--live-colour", colour);
    $("preview").style.setProperty("--live-level", String((value.running ? value.brightness : config.brightness) / 100));
    $("brightness-value").textContent = `${config.brightness}%`;
    $("rib-position").textContent = value.ribPosition === null ? "—" : String(value.ribPosition);
    $("breath-shape").style.setProperty("--live-breath", String(value.ribPosition === null ? .6 : .3 + value.ribPosition / 127 * .7));
    $("led-connection").textContent = status.ledConnected ? status.ledName || "LED controller connected" : "Connects when you press Start robot";
    $("led-connection").classList.toggle("is-error", false);
    $("rib-connection").textContent = status.emergencyStopped ? "Emergency stop active" : !config.ribs ? "Enable rib breathing to include it when you start." : !status.ribsReady ? "Start robot connects and enables rib torque." : !status.torqueEnabled ? "Rib cage connected · Start robot enables torque" : "Rib cage connected · ready to move";
    $("rib-connection").classList.toggle("is-error", config.ribs && status.emergencyStopped);
    const axes = status.headCalibration?.axes || [];
    const headBusyness = config.headBusynessAuto ? Math.round(clamp(Number(value.headBusyness) || 0, 0, 100)) : config.headBusyness;
    $("head-enabled").checked = config.headEnabled;
    $("head-beat-sync").checked = config.headBeatSync;
    $("head-busyness-mode").value = config.headBusynessAuto ? "auto" : "manual";
    $("head-busyness").value = String(headBusyness);
    $("head-busyness").disabled = starting || resetting || config.headBusynessAuto;
    $("head-busyness-value").textContent = `${headBusyness}%`;
    $("head-connection").textContent = status.emergencyStopped ? "Emergency stop active" : !config.headEnabled ? "Enable head movement to include it when you start." : status.headRecording ? "Recording range · torque must stay off" : !axes.length ? "Record and save the head range in Keirzo setup." : !status.headReady ? status.headError || "Saved range ready · connects on Start robot" : status.headTorqueEnabled ? "Head connected · torque on" : "Head connected · torque off";
    $("head-connection").classList.toggle("is-error", Boolean(config.head && (status.headError || status.emergencyStopped)));
    if (status.emergencyStopped) notice(uiError || (status.emergencyPending ? "Emergency stop active. Releasing motor torque…" : "Emergency stop active. Reset it here, then press Start robot when ready."), true);
    else if (uiError || value.error) notice(uiError || value.error, true);
    else if (starting) notice(startProgress || "Connecting Keirzo…", false);
    else if (resetting) notice("Resetting emergency stop…", false);
    else if (value.running && !config.leds && !config.ribs && !config.head && !drums.enabled) notice("Drum arms ready at rest. Start drumming when you want hits, or enable another effect.", false);
    else if (value.running && value.waiting) notice(`Waiting for ${clock.label || "the beat source"}. Start playback in its tab.`, false);
    else if (value.running && config.head && !config.headBeatSync && !clock.running) notice(config.leds || config.ribs ? "Head running at its own pace. Music patterns will resume with playback." : "Head running at its own pace · continues when you change tabs.", false);
    else if (value.running) notice("Running · continues when you change tabs.", false);
    else if (drums.enabled) notice(drums.waiting ? "Automatic drumming is waiting for its selected source." : "Automatic drumming is active. Stop ends all performances.", false);
    else notice("Start robot enables the drum arms and moves them to rest, and connects your selected effects. Patterns keep running as you change tabs.", false);
  }
  function edit(patch) {
    if (starting || resettingEmergency) return;
    try {
      const previous = engine.snapshot(), next = settings({ ...formSettings(), ...patch });
      const prepareHead = previous.running && !previous.settings.head && next.head;
      uiError = "";
      if (prepareHead) engine.stop();
      engine.configure(next); saveSettings();
      if (next.source !== previous.settings.source) {
        // Drumming emits its old settings while cancelling an active session.
        // Ignore that intermediate snapshot until the new source is installed.
        syncingSource = true;
        try { globalThis.HydraRobotDrums?.setSource?.(next.source); }
        finally { syncingSource = false; }
      }
      // Enabling a live effect must leave an ongoing drum performance alone.
      if (prepareHead) startLive({ prepareDrums: false });
    }
    catch (error) { uiError = error.message; render(); }
  }
  function saveSettings() {
    try { globalThis.localStorage?.setItem(storageKey, JSON.stringify(engine.snapshot().settings)); } catch (_) { /* Storage is optional. */ }
  }
  function formSettings() {
    const current = engine.snapshot().settings;
    return { source: $("source").value, leds: $("leds").checked, ledMode: $("mode").value, ledBeats: $("led-beats").value,
      palette: [0, 1, 2, 3].map(index => $(`colour-${index}`).value), brightness: $("brightness").value,
      ribs: $("ribs").checked, ribMin: $("rib-min").value, ribMax: $("rib-max").value, ribBeats: $("rib-beats").value,
      headEnabled: $("head-enabled").checked, headBeatSync: $("head-beat-sync").checked, headBusynessAuto: $("head-busyness-mode").value === "auto",
      // Auto displays its effective level without replacing the manual setting.
      headBusyness: current.headBusynessAuto ? current.headBusyness : $("head-busyness").value };
  }
  function fillForm(config) {
    for (const [id, key] of Object.entries({ source: "source", mode: "ledMode", "led-beats": "ledBeats", brightness: "brightness", "rib-min": "ribMin", "rib-max": "ribMax", "rib-beats": "ribBeats", "head-busyness": "headBusyness" })) $(id).value = String(config[key]);
    $("leds").checked = config.leds; $("ribs").checked = config.ribs; $("head-enabled").checked = config.headEnabled; $("head-beat-sync").checked = config.headBeatSync;
    $("head-busyness-mode").value = config.headBusynessAuto ? "auto" : "manual";
    config.palette.forEach((colour, index) => { $(`colour-${index}`).value = colour; });
    $("preset").value = Object.entries(presets).find(([, preset]) => preset.colours.every((colour, index) => colour === config.palette[index]))?.[0] || "custom";
  }
  function init(options) {
    if (initialized) return;
    root = options.container; hardware = options.hardware;
    if (!root || !hardware) return;
    initialized = true;
    root.classList.add("robot-workspace", "robot-live-workspace");
    root.innerHTML = markup();
    if (globalThis.HydraRobotDrums) globalThis.HydraRobotDrums.init($("drumming"), hardware);
    else $("drumming").textContent = "Automatic drumming could not load. Restart the dashboard server and reload this page.";
    let saved;
    try {
      const stored = JSON.parse(globalThis.localStorage?.getItem(storageKey) || "{}");
      saved = settings({ ...stored, source: stored.source ?? globalThis.HydraRobotDrums?.snapshot?.()?.settings?.source ?? defaults.source });
      if (saved.palette.length !== 4) saved = settings();
    } catch (_) { saved = settings(); }
    engine = createEngine({ hardware, clock: options.clock, settings: saved });
    fillForm(saved);
    globalThis.HydraRobotDrums?.setSource?.(saved.source);
    engine.subscribe(render);
    globalThis.HydraRobotDrums?.subscribe?.(value => {
      const source = value?.settings?.source;
      if (!syncingSource && ["mixer", "synth"].includes(source) && source !== engine.snapshot().settings.source) {
        engine.configure({ source }); saveSettings();
      }
      render();
    });
    hardware.subscribe(() => {
      if (hardware.snapshot().emergencyStopped && starting) cancelStartup();
      engine.hardwareChanged(); render();
    });
    root.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button || button.disabled) return;
      if (button.id === "robot-live-start") {
        startLive();
      } else if (button.id === "robot-live-stop") { stopLive(); globalThis.HydraRobotDrums?.stop(); }
      else if (button.id === "robot-live-emergency-stop") emergencyStop();
      else if (button.id === "robot-live-reset-emergency") resetEmergency();
    });
    root.addEventListener("input", event => {
      if (event.target.id === "robot-live-brightness") edit({ brightness: Number(event.target.value) });
      if (event.target.id === "robot-live-head-busyness" && !engine.snapshot().settings.headBusynessAuto) edit({ headBusyness: Number(event.target.value) });
      if (event.target.dataset.liveColour !== undefined) {
        const palette = engine.snapshot().settings.palette;
        palette[Number(event.target.dataset.liveColour)] = event.target.value;
        $("preset").value = "custom"; edit({ palette });
      }
    });
    root.addEventListener("change", event => {
      const element = event.target;
      const key = { "robot-live-source": "source", "robot-live-leds": "leds", "robot-live-mode": "ledMode", "robot-live-led-beats": "ledBeats", "robot-live-ribs": "ribs", "robot-live-rib-min": "ribMin", "robot-live-rib-max": "ribMax", "robot-live-rib-beats": "ribBeats", "robot-live-head-enabled": "headEnabled", "robot-live-head-beat-sync": "headBeatSync" }[element.id];
      if (key) {
        const value = element.type === "checkbox" ? element.checked : element.value;
        edit({ [key]: value });
      } else if (element.id === "robot-live-head-busyness-mode") {
        edit({ headBusynessAuto: element.value === "auto" });
      } else if (element.id === "robot-live-head-busyness" && !engine.snapshot().settings.headBusynessAuto) {
        edit({ headBusyness: Number(element.value) });
      } else if (element.id === "robot-live-preset" && presets[element.value]) {
        const palette = [...presets[element.value].colours];
        palette.forEach((colour, index) => { $(`colour-${index}`).value = colour; });
        edit({ palette });
      }
    });
  }
  return { init, createEngine, activate() { if (initialized) { engine.refresh(); globalThis.HydraRobotDrums?.activate?.(); } },
    stop() { if (initialized) stopLive(); return globalThis.HydraRobotDrums?.stop(); },
    snapshot: () => engine ? { ...engine.snapshot(), starting, startProgress, resettingEmergency } : { running: false, starting: false },
    subscribe(listener) { return engine ? engine.subscribe(listener) : () => {}; } };
})();
