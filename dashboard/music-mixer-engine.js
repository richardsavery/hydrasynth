"use strict";

// The mixer owns its input calibration and transport. It never generates audio
// or changes the Generated music workspace's mappings or saved preferences.
globalThis.HydraMusicMixerEngine = (() => {
  const helpers = globalThis.HydraElevenRealtime;
  const TARGETS = helpers.TARGETS;
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const list = (value) => Array.isArray(value) ? value : [];
  const safeName = (value) => typeof value === "string" && /^[^\x00-\x1f]{1,100}$/.test(value);
  const isVocalName = (value) => typeof value === "string" && /^vocals?$/i.test(value.trim());
  const instrumentalStems = (stems) => list(stems).filter((stem) => !isVocalName(stem?.name) && !isVocalName(stem?.id));
  const selectedStems = (selected) => Array.isArray(selected?.stems) ? selected.stems : list(selected?.stem_separation?.stems);
  const onlyVocalStems = (selected) => selectedStems(selected).length > 0 && instrumentalStems(selectedStems(selected)).length === 0;
  const unavailableInstrumentalMessage = "This track has no instrumental stems. Choose another track or generate new music.";
  const operators = ["average", "weighted", "difference", "minimum", "maximum"];
  const effects = ["cutoff", "highpass", "pan", "reverbMix", "delayMix", "resonance", "rate", "pitch"];
  const EFFECT_DEFAULTS_VERSION = 2;
  const previousRanges = { cutoff: [220, 14000], resonance: [0.7, 6], highpass: [20, 900],
    gain: [0.2, 0.85], pan: [-0.8, 0.8], rate: [0.85, 1.15], delayMix: [0, 0.4], reverbMix: [0.05, 0.5] };
  const DEMO_FIELDS = ["movement", "energy", "pace"].map((name) => ({
    key: `demo:${name}`, name: `${name[0].toUpperCase()}${name.slice(1)} · simulated`,
    label: `${name[0].toUpperCase()}${name.slice(1)}`, reducers: ["value"], default_reducer: "value", minimum: 0, maximum: 1
  }));

  function defaultChannel(name = "master") {
    return { name, level: name === "master" ? 0.8 : 1, muted: false, solo: false,
      cutoff: 20000, highpass: 20, pan: 0, reverbMix: 0, delayMix: 0, resonance: 0.7, rate: 1, pitch: 0, routes: [] };
  }
  function validateConfig(value) {
    const incoming = value && typeof value === "object" ? value : {};
    const ids = new Set(), names = new Set();
    const buses = list(incoming.buses).slice(0, 4).map((bus, index) => {
      bus = bus && typeof bus === "object" ? bus : {};
      let id = safeName(bus.id) ? bus.id : `bus-${index + 1}`, suffix = 1;
      while (ids.has(id)) id = `bus-${index + 1}-${suffix++}`;
      ids.add(id);
      return { id, name: safeName(bus.name) ? bus.name : `Mix ${index + 1}`,
        operator: operators.includes(bus.operator) ? bus.operator : "average",
        sources: list(bus.sources).slice(0, 6).map((source) => helpers.validateSource(source)) };
    });
    const channels = [];
    // The master always exists and occupies one of the seven channel slots.
    const incomingChannels = list(incoming.channels);
    const master = incomingChannels.find((channel) => channel?.name === "master") || defaultChannel();
    for (const channel of [master, ...incomingChannels.filter((channel) => channel?.name !== "master")]) {
      if (!channel || !safeName(channel.name) || isVocalName(channel.name) || isVocalName(channel.id) || names.has(channel.name) || channels.length >= 7) continue;
      names.add(channel.name);
      const result = defaultChannel(channel.name);
      result.level = finite(channel.level) ? clamp(channel.level, 0, 1) : result.level;
      result.muted = channel.muted === true; result.solo = channel.solo === true;
      for (const effect of effects) {
        if (effect === "rate" && channel.name !== "master") continue;
        if (finite(channel[effect])) result[effect] = clamp(channel[effect], TARGETS[effect].min, TARGETS[effect].max);
      }
      // One route per effect; the last supplied route wins deterministically.
      const routes = new Map();
      for (const route of list(channel.routes).slice(0, 9)) {
        if (!route || !safeName(route.busId) || !Object.hasOwn(TARGETS, route.target) ||
            (channel.name !== "master" && route.target === "rate")) continue;
        const target = TARGETS[route.target];
        const previous = previousRanges[route.target];
        const upgrade = previous && incoming.effectDefaultsVersion !== EFFECT_DEFAULTS_VERSION &&
          route.outputMin === previous[0] && route.outputMax === previous[1];
        routes.set(route.target, { busId: route.busId, target: route.target,
          outputMin: !upgrade && finite(route.outputMin) ? clamp(route.outputMin, target.min, target.max) : target.low,
          outputMax: !upgrade && finite(route.outputMax) ? clamp(route.outputMax, target.min, target.max) : target.high,
          invert: route.invert === true, strength: finite(route.strength) ? clamp(route.strength, 0, 1) : 1 });
      }
      result.routes = [...routes.values()]; channels.push(result);
    }
    return { mode: incoming.mode === "demo" ? "demo" : "shared", buses, channels, effectDefaultsVersion: EFFECT_DEFAULTS_VERSION };
  }

  function create({ sourceBridge, onUpdate = () => {}, onError = () => {}, onTransition = () => {},
    Player = globalThis.HydraElevenPlayer?.Player, now = () => performance.now() } = {}) {
    let config = validateConfig({}), active = false, running = false, starting = false;
    let track = null, player = null, unlockedPlayer = null, timer = null, epoch = 0, error = null;
    let trackHasOnlyVocals = false;
    let queuedTrack = null, preparingTrack = null, queueing = false, queueSequence = 0;
    const retainedChannels = new Map();
    let fields = [], sourceLabel = "Choose an input in Connections", buses = [], channels = [];
    let controls = {}, sourceValid = true, preparedKey = null, pendingKey = null, preparation = 0;
    let attemptedKey = null, description = {}, demoOrigin = now();
    const sources = () => config.buses.flatMap((bus) => bus.sources);
    const fieldKeys = () => new Set(fields.map((field) => field.key));
    const sourceIdentity = (source) => JSON.stringify([source.sourceKey, source.reducer, source.index]);
    const stemNamesFor = (selected) => [...new Set(instrumentalStems(selected?.stems).map((stem) => stem?.name).filter(safeName))].slice(0, 6);
    const trackStemNames = () => stemNamesFor(track);
    const soundingNames = () => (player && running && !starting ? player.playingStemNames || player.stemNames || [] : trackStemNames()).filter((name) => !isVocalName(name));
    const availableNames = () => [...new Set([...soundingNames(), ...stemNamesFor(preparingTrack || queuedTrack)])].slice(0, 12);
    const normalizeTrack = (selected) => {
      const next = selected && typeof selected === "object" ? copy(selected) : null;
      if (next) {
        next.stems = instrumentalStems(selectedStems(next));
        if (next.stem_separation && Array.isArray(next.stem_separation.stems)) {
          next.stem_separation.stems = instrumentalStems(next.stem_separation.stems);
        }
      }
      return next;
    };
    const trackIdentity = (selected) => selected?.id || selected?.audio_url || null;

    function snapshot() {
      return copy({ active, running, starting, track, queuedTrack, queueing, fields, sourceLabel, buses, channels, controls,
        sourceValid, position: player?.currentPosition || 0,
        duration: player?.duration || track?.audio?.duration_seconds || track?.requested_duration_seconds || track?.duration_seconds || 0, error });
    }
    function transportClock(bpm) {
      const selected = player?.currentTrack || track;
      const requested = selected?.realtime?.generation_settings?.bpm ?? selected?.generation_settings?.bpm ?? selected?.request?.settings?.bpm ?? bpm;
      const clock = (player || unlockedPlayer)?.transportClock?.(requested);
      if (!running) {
        if (!clock && !selected) return null;
        // A recalled track already has a tempo before its audio is unlocked.
        // Use the same current rate that start() will seed into the player;
        // an unlocked, empty player still has its default rate at this point.
        const tempo = Number(requested), validTempo = Number.isFinite(tempo) && tempo >= 20 && tempo <= 300;
        const rate = Number(controls.rate) || 1;
        return { context: clock?.context || null, destination: clock?.destination || null,
          playing: false, valid: validTempo, bpm: validTempo ? tempo * rate : null,
          baseBpm: validTempo ? tempo : null, rate, beat: 0, at: clock?.at || 0,
          token: `${epoch}:stopped:${trackIdentity(selected)}:${tempo}:${rate}`, estimated: true, rateChanging: false };
      }
      if (!clock) return null;
      return { ...clock, playing: active && running && clock.playing,
        valid: clock.valid && (!running || sourceValid), token: `${epoch}:${clock.token}` };
    }
    function emit() { onUpdate(snapshot()); }
    function report(cause) {
      error = cause?.message || String(cause); onError(error);
    }
    function newPlayer() {
      if (!Player) throw new Error("Audio playback is unavailable in this browser.");
      let candidate = null;
      candidate = new Player({ onState(state) {
        // Runtime audio failures happen after start() has returned. Keep the
        // transport honest, but let a failed upcoming decode keep playing.
        if (!candidate || candidate !== player || !active || state.status !== "error") return;
        report(state.error || "Audio playback stopped. Press Play to restart the track.");
        stop();
      }, onTransition(next, details) {
        if (candidate !== player || !active || !running || trackIdentity(next) === trackIdentity(track)) return;
        track = normalizeTrack(next);
        trackHasOnlyVocals = onlyVocalStems(next);
        if (trackIdentity(queuedTrack) === trackIdentity(next)) queuedTrack = null;
        error = null; tick(); onTransition(copy(track), details);
      } });
      return candidate;
    }
    async function unlock() {
      if (!active) return false;
      const run = epoch;
      try {
        const candidate = player || (unlockedPlayer ||= newPlayer());
        // Resume immediately inside the user's gesture; later generation may
        // take minutes, but start will reuse this already-unlocked context.
        await candidate.resume();
        return active && run === epoch;
      } catch (cause) {
        if (run === epoch && active) { report(cause); emit(); }
        return false;
      }
    }
    function describeSource() {
      if (config.mode === "demo") return { mode: "demo", revision: "demo", label: "Demo signals · simulated", fields: DEMO_FIELDS };
      try { return sourceBridge?.describe?.() || {}; }
      catch (cause) { return { label: cause.message, fields: [] }; }
    }
    function prepareInput() {
      description = describeSource(); fields = list(description.fields);
      sourceLabel = description.label || "Choose an input in Connections";
      if (!active || config.mode !== "shared") return;
      const key = JSON.stringify([description.mode, description.revision, description.label,
        fields.map((field) => [field.key, field.reducers, field.default_reducer]), sources().map(sourceIdentity)]);
      if (key === preparedKey || key === pendingKey || key === attemptedKey) return;
      const token = ++preparation, keys = fieldKeys();
      preparedKey = null; pendingKey = key; attemptedKey = key;
      const available = sources().filter((source) => keys.has(source.sourceKey));
      // A missing field invalidates only its own bus; prepare the other fields.
      Promise.resolve().then(() => active && token === preparation && available.length ? sourceBridge?.prepare?.(available) : undefined).then(() => {
        if (!active || token !== preparation) return;
        preparedKey = key; pendingKey = null; tick();
      }).catch((cause) => {
        if (!active || token !== preparation) return;
        pendingKey = null; report(cause); tick();
      });
    }
    function sample(source, at) {
      if (config.mode === "demo") {
        const seconds = (at - demoOrigin) / 1000;
        const phases = { "demo:movement": [0.55, 0], "demo:energy": [0.27, 1.2], "demo:pace": [0.9, 2.5] };
        const phase = phases[source.sourceKey];
        return phase ? { value: (Math.sin(seconds * phase[0] + phase[1]) + 1) / 2, at, minimum: 0, maximum: 1 } : null;
      }
      if (!preparedKey || !fieldKeys().has(source.sourceKey)) return null;
      try { return sourceBridge?.read?.(source, at) || null; } catch (_) { return null; }
    }
    function readInputs(at) {
      buses = config.buses.map((bus) => {
        const readings = bus.sources.map((source) => {
          const reading = sample(source, at), normalized = helpers.normalizeSource(source, reading, at);
          const valid = finite(normalized);
          return { value: valid ? reading.value : null, normalized, valid,
            minimum: source.rangeMode === "auto" ? source.learnedMin : source.inputMin,
            maximum: source.rangeMode === "auto" ? source.learnedMax : source.inputMax };
        });
        const value = helpers.combineInputs(readings.map((reading) => reading.normalized), bus.sources, bus.operator);
        return { id: bus.id, name: bus.name, value, valid: finite(value), sources: readings };
      });
    }
    function computeControls() {
      const available = new Set(availableNames()), sounding = new Set(soundingNames());
      const values = new Map(buses.map((bus) => [bus.id, bus.value]));
      const configured = new Map([...retainedChannels, ...config.channels.map((channel) => [channel.name, channel])]);
      const all = [configured.get("master") || defaultChannel(), ...[...available].map((name) => configured.get(name) || defaultChannel(name)),
        ...config.channels.filter((channel) => channel.name !== "master" && !available.has(channel.name))];
      const masterSolo = configured.get("master")?.solo;
      const anySolo = !masterSolo && all.some((channel) => sounding.has(channel.name) && channel.solo);
      const nextSolo = !masterSolo && all.some((channel) => available.has(channel.name) && channel.solo);
      controls = { cutoff: 20000, highpass: 20, pan: 0, reverbMix: 0, delayMix: 0, resonance: 0.7, rate: 1, pitch: 0, gain: 0.8,
        stemGains: Object.create(null), stemControls: Object.create(null) };
      sourceValid = true;
      channels = all.map((channel) => {
        const isMaster = channel.name === "master", present = isMaster || available.has(channel.name);
        const effective = { ...defaultChannel(channel.name), ...channel, gain: 1 };
        let valid = true;
        for (const route of channel.routes) {
          // Turning modulation off restores the manual setting, even when its
          // input is disconnected. Volume modulation multiplies the fader.
          if (route.strength === 0) continue;
          const input = values.get(route.busId);
          if (!finite(input)) { valid = false; continue; }
          const mapped = helpers.mapValue(route.invert ? 1 - input : input, route);
          const baseline = effective[route.target];
          effective[route.target] = route.strength === 1 ? mapped
            : TARGETS[route.target].logarithmic && baseline > 0 && mapped > 0
              ? baseline * Math.pow(mapped / baseline, route.strength)
              : baseline + route.strength * (mapped - baseline);
        }
        const muted = channel.muted || (!isMaster && (sounding.has(channel.name) ? anySolo : nextSolo) && !channel.solo);
        const level = muted ? 0 : channel.level;
        const gain = level * effective.gain;
        if (present) {
          // Missing modulation on a silent strip must not silence an audible
          // solo. Restore its input requirement as soon as its fader is heard.
          if (level > 0 && (isMaster || sounding.has(channel.name))) sourceValid = sourceValid && valid;
          if (isMaster) {
            for (const effect of effects) controls[effect] = effective[effect];
            controls.gain = gain;
          } else {
            controls.stemGains[channel.name] = level;
            controls.stemControls[channel.name] = Object.fromEntries(effects.filter((effect) => effect !== "rate").map((effect) => [effect, effective[effect]]));
            controls.stemControls[channel.name].gain = effective.gain;
          }
        }
        return { ...channel, available: present, gain: present && valid ? gain : 0, valid,
          values: { ...Object.fromEntries(effects.map((effect) => [effect, effective[effect]])), gain } };
      });
    }
    function tick() {
      if (!active) return;
      prepareInput(); readInputs(now()); computeControls();
      if (running && player) {
        // While input is missing, keep the gate closed instead of reviving the
        // last mapped value. The next valid frame applies all manual edits too.
        if (sourceValid) player.updateControls(controls, true);
        else player.setSourceValid(false);
      }
      emit();
    }
    function stop(preserveUnlocked = false) {
      epoch++; queueSequence++; starting = false; running = false; queuedTrack = null; preparingTrack = null; queueing = false;
      const previous = player; player = null; previous?.dispose();
      if (!preserveUnlocked) { unlockedPlayer?.dispose(); unlockedPlayer = null; }
      computeControls(); emit();
    }
    function deactivate() {
      active = false; preparation++; preparedKey = null; pendingKey = null; attemptedKey = null;
      if (timer !== null) { globalThis.clearInterval(timer); timer = null; }
      stop();
    }
    function activate() {
      if (active) return;
      // Music playback and Synth input buses are independent engine instances.
      // Opening another workspace must not stop this instance's audio or clock.
      active = true; error = null;
      timer = globalThis.setInterval(tick, 100); tick();
    }
    function setConfig(incoming) {
      const next = validateConfig(incoming), oldBuses = new Map(config.buses.map((bus) => [bus.id, bus]));
      for (const bus of next.buses) bus.sources = bus.sources.map((source, index) => {
        const previous = oldBuses.get(bus.id)?.sources[index];
        // Preserve live range registration through unrelated fader edits.
        return previous && sourceIdentity(previous) === sourceIdentity(source) ? Object.assign(previous, source) : source;
      });
      if (next.mode !== config.mode) {
        preparation++; preparedKey = null; pendingKey = null; attemptedKey = null; demoOrigin = now();
      }
      for (const channel of [...config.channels, ...next.channels]) retainedChannels.set(channel.name, channel);
      // Keep settings for recent stem names so rebuilding the visible strips
      // on promotion cannot reset a still-audible retiring deck.
      const protectedNames = new Set(["master", ...availableNames(), ...next.channels.map((channel) => channel.name)]);
      for (const name of retainedChannels.keys()) {
        if (retainedChannels.size <= 24) break;
        if (!protectedNames.has(name)) retainedChannels.delete(name);
      }
      config = next; error = null;
      if (active) tick(); else { readInputs(now()); computeControls(); emit(); }
      return getConfig();
    }
    function getConfig() { return copy(validateConfig(config)); }
    async function setTrack(next) {
      stop(true); trackHasOnlyVocals = onlyVocalStems(next); track = normalizeTrack(next); error = null;
      computeControls(); emit(); return true;
    }
    function clearQueuedTrack() {
      queueSequence++; queuedTrack = null; preparingTrack = null; queueing = false;
      const cleared = player?.clearQueuedTrack?.() !== false;
      if (active) tick(); else { computeControls(); emit(); }
      return cleared;
    }
    async function queueTrack(next) {
      if (!active || !running || !player || queueing || queuedTrack) return false;
      if (onlyVocalStems(next)) { report(new Error(unavailableInstrumentalMessage)); emit(); return false; }
      const incoming = normalizeTrack(next);
      if (!incoming?.audio_url || trackIdentity(incoming) === trackIdentity(track)) return false;
      const candidate = player, run = epoch, sequence = ++queueSequence;
      preparingTrack = incoming; queueing = true; error = null;
      // A queue may start its crossfade as soon as decode completes. Seed all
      // upcoming controls first, especially solo and mute on new stem names.
      readInputs(now()); computeControls(); candidate.updateControls(controls, true); candidate.setSourceValid(sourceValid); emit();
      try {
        const prepared = await candidate.queueTrack(incoming, { requireStems: true });
        if (!active || !running || run !== epoch || sequence !== queueSequence || player !== candidate || prepared === false) return false;
        queuedTrack = trackIdentity(track) === trackIdentity(incoming) ? null : incoming;
        return true;
      } catch (cause) {
        if (active && run === epoch && sequence === queueSequence && player === candidate) report(cause);
        return false;
      } finally {
        if (run === epoch && sequence === queueSequence && player === candidate) {
          preparingTrack = null; queueing = false; tick();
        }
      }
    }
    async function start() {
      if (!active || starting) return false;
      if (running) return true;
      if (!track?.audio_url) { report(new Error("Choose a saved track to play.")); emit(); return false; }
      if (trackHasOnlyVocals) { report(new Error(unavailableInstrumentalMessage)); emit(); return false; }
      const run = ++epoch;
      // A deliberate Play also retries a failed input load, without a timer
      // repeatedly issuing requests while the source is unavailable.
      if (!preparedKey && !pendingKey) attemptedKey = null;
      starting = true; error = null; tick();
      let candidate;
      try {
        candidate = player = unlockedPlayer || newPlayer(); unlockedPlayer = null;
        // Seed levels before the audio deck is created: muted stems must be
        // silent from their very first sample, including after a reload.
        candidate.updateControls(controls, true); candidate.setSourceValid(false);
        const resumed = candidate.resume();
        await resumed;
        if (run !== epoch || !active) return false;
        const loaded = await candidate.loadTrack(track, { requireStems: true });
        if (run !== epoch || !active || loaded === false) return false;
        const expected = trackStemNames();
        if (expected.length && expected.some((name) => !candidate.stemNames.includes(name))) {
          throw new Error("The saved stems could not be loaded. Retry before using the mixer’s stem controls.");
        }
        readInputs(now()); computeControls();
        candidate.updateControls(controls, true); candidate.setSourceValid(sourceValid);
        const played = await candidate.start();
        if (run !== epoch || !active || played === false) return false;
        starting = false; running = true; tick(); return true;
      } catch (cause) {
        if (run === epoch && active) report(cause);
        return false;
      } finally {
        if (run === epoch) {
          starting = false;
          if (!running) { candidate?.dispose(); if (player === candidate) player = null; }
          computeControls(); emit();
        }
      }
    }
    function relearn(busId, sourceIndex) {
      const source = config.buses.find((bus) => bus.id === busId)?.sources[sourceIndex];
      if (!source) return false;
      Object.assign(source, { rangeMode: "auto", learnedMin: null, learnedMax: null, awaitingBounds: true });
      delete source.recordedBounds;
      if (config.mode === "shared") sourceBridge?.resetRange?.(source);
      if (active) tick(); else emit(); return true;
    }
    function freeze(busId, sourceIndex) {
      const source = config.buses.find((bus) => bus.id === busId)?.sources[sourceIndex];
      if (!source || !finite(source.learnedMin) || !finite(source.learnedMax) || source.learnedMax <= source.learnedMin) return false;
      Object.assign(source, { rangeMode: "fixed", inputMin: source.learnedMin, inputMax: source.learnedMax, awaitingBounds: false });
      if (active) tick(); else emit(); return true;
    }
    const api = { activate, deactivate, setConfig, getConfig, setTrack, queueTrack, clearQueuedTrack, unlock, start, stop, snapshot, transportClock, relearn, freeze };
    computeControls(); return api;
  }
  return { create, validateConfig, defaultChannel, instrumentalStems, TARGETS, DEMO_FIELDS };
})();
