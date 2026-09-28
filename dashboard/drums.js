"use strict";

// Motion analysis, deterministic grooves and a self-contained electronic drum kit.
// No MIDI output or downloaded samples: the kit only connects to the supplied audio bus.
globalThis.HydraDrums = (() => {
  const TRACKS = [
    { id: "kick", name: "Kick", note: 36, color: "#f7ba75" },
    { id: "snare", name: "Snare", note: 38, color: "#f48b8e" },
    { id: "clap", name: "Clap", note: 39, color: "#d2a3ed" },
    { id: "closedHat", name: "Closed hat", note: 42, color: "#8bdac9" },
    { id: "openHat", name: "Open hat", note: 46, color: "#9dbaf3" },
    { id: "perc", name: "Percussion", note: 75, color: "#d9df83" }
  ];
  const KITS = [
    { id: "electro", name: "Electro · rounded 808", description: "Deep sine kick, airy hats and a warm snare." },
    { id: "warehouse", name: "Warehouse · punchy 909", description: "Shorter kick, snappy snare and bright metallic hats." },
    { id: "minimal", name: "Minimal · digital", description: "Tight sub, crisp clicks and tuned percussion." }
  ];
  const STYLES = [
    { id: "straight", name: "Four on the floor" },
    { id: "broken", name: "Broken beat" },
    { id: "half", name: "Half time" }
  ];
  const DEFAULTS = {
    drumKit: "electro", drumStyle: "broken", drumTempoMin: 75, drumTempoMax: 150,
    drumDensityMin: 10, drumDensityMax: 90, drumSensitivity: 50, drumSmoothing: 65,
    drumSwing: 12, drumVolume: 65, drumFill: 35, drumSources: [], drumMuted: []
  };
  const clamp = (value, min, max, fallback = min) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };
  const unit = (value) => clamp(value, 0, 1);
  const validNumber = (value) => value !== null && value !== "" && Number.isFinite(Number(value));
  const unique = (items) => [...new Set(items)];
  function settings(raw = {}) {
    const input = raw && typeof raw === "object" ? raw : {};
    const result = { ...DEFAULTS };
    for (const key of ["drumTempoMin", "drumTempoMax", "drumDensityMin", "drumDensityMax", "drumSensitivity", "drumSmoothing", "drumSwing", "drumVolume", "drumFill"]) {
      const tempo = key.startsWith("drumTempo");
      result[key] = clamp(input[key] ?? DEFAULTS[key], tempo ? 20 : 0, tempo ? 240 : key === "drumSwing" ? 65 : 100, DEFAULTS[key]);
    }
    // Endpoints describe increasing activity, so a reversed import is normalized.
    for (const prefix of ["drumTempo", "drumDensity"]) {
      if (result[`${prefix}Min`] > result[`${prefix}Max`]) {
        [result[`${prefix}Min`], result[`${prefix}Max`]] = [result[`${prefix}Max`], result[`${prefix}Min`]];
      }
    }
    result.drumKit = KITS.some((kit) => kit.id === input.drumKit) ? input.drumKit : DEFAULTS.drumKit;
    result.drumStyle = STYLES.some((style) => style.id === input.drumStyle) ? input.drumStyle : DEFAULTS.drumStyle;
    result.drumSources = unique((Array.isArray(input.drumSources) ? input.drumSources : []).filter((key) => typeof key === "string" && key.length > 0 && key.length <= 1024)).slice(0, 6);
    result.drumMuted = unique((Array.isArray(input.drumMuted) ? input.drumMuted : []).filter((id) => TRACKS.some((track) => track.id === id)));
    return result;
  }

  class Motion {
    constructor() { this.reset(); }
    reset() { this.sources = new Map(); this.activity = 0; this.updatedAt = null; }
    update(samples, nowMs, raw = {}) {
      const config = settings(raw);
      const now = clamp(nowMs, 0, Number.MAX_SAFE_INTEGER);
      if (this.updatedAt !== null && now < this.updatedAt) this.reset();
      const elapsed = this.updatedAt === null ? 50 : Math.max(0, now - this.updatedAt);
      this.updatedAt = now;
      const energies = [];
      const seen = new Set();
      for (const sample of (Array.isArray(samples) ? samples : []).slice(0, 128)) {
        if (!sample || typeof sample.key !== "string" || seen.has(sample.key) || !validNumber(sample.value)) continue;
        if (config.drumSources.length && !config.drumSources.includes(sample.key)) continue;
        seen.add(sample.key);
        const value = Number(sample.value);
        const at = validNumber(sample.at) ? Number(sample.at) : now;
        const previous = this.sources.get(sample.key);
        let source = previous;
        if (!previous || at !== previous.at) {
          let speed = 0;
          const boundedRange = validNumber(sample.minimum) && validNumber(sample.maximum);
          if (sample.kind === "velocity") {
            const range = boundedRange ? Math.max(Math.abs(Number(sample.minimum)), Math.abs(Number(sample.maximum))) : 1;
            speed = Math.abs(value) / (range > 1e-9 ? range : 1);
          } else if (previous && at > previous.at) {
            const span = boundedRange ? Math.abs(Number(sample.maximum) - Number(sample.minimum)) : 0;
            const range = span > 1e-9 ? span : Math.max(1, Math.abs(value), Math.abs(previous.value));
            speed = Math.abs(value - previous.value) / range / Math.max(0.001, (at - previous.at) / 1000);
          }
          source = { at, value, speed: Math.min(16, speed), receivedAt: now };
          this.sources.set(sample.key, source);
        }
        // Re-reading one frame never creates a new movement. Hold briefly between
        // frames, then decay; the transport applies its separate stale-data stop.
        const age = Math.max(0, now - source.receivedAt);
        const hold = age > 1500 ? 0 : Math.exp(-Math.max(0, age - 200) / 350);
        energies.push(source.speed * hold);
      }
      for (const key of this.sources.keys()) if (!seen.has(key)) this.sources.delete(key);
      const rms = energies.length ? Math.sqrt(energies.reduce((sum, value) => sum + value * value, 0) / energies.length) : 0;
      const target = unit(rms * 2 ** ((config.drumSensitivity - 50) / 25));
      const smoothing = config.drumSmoothing / 100;
      const amount = smoothing === 0 ? 1 : 1 - Math.exp(-elapsed / (30 + 1500 * smoothing * smoothing));
      this.activity = unit(this.activity + (target - this.activity) * amount);
      if (this.activity < 0.00001) this.activity = 0;
      return this.activity;
    }
  }

  // Every event has a density threshold. Raising density adds events without
  // replacing the existing beat; fills are deterministic on every fourth bar.
  const BASE = {
    straight: {
      kick: [[0, 0.01, 1], [8, 0.16, .92], [4, .28, .95], [12, .4, .95], [14, .91, .56]],
      snare: [[4, .18, .82], [12, .26, .94], [11, .85, .34], [15, .95, .4]],
      clap: [[12, .57, .65], [4, .74, .52]],
      closedHat: [[2, .08, .6], [10, .16, .62], [6, .25, .65], [14, .34, .69], [0, .42, .45], [4, .5, .44], [8, .58, .48], [12, .66, .5], [3, .72, .31], [7, .76, .35], [11, .81, .34], [15, .84, .42], [1, .87, .3], [5, .91, .3], [9, .94, .3], [13, .98, .3]],
      openHat: [[6, .62, .58], [14, .79, .67]],
      perc: [[7, .48, .5], [15, .64, .62], [3, .86, .42]]
    },
    broken: {
      kick: [[0, .01, 1], [10, .15, .86], [6, .37, .77], [14, .68, .75], [3, .9, .48]],
      snare: [[4, .18, .93], [12, .26, 1], [7, .76, .34], [15, .9, .4], [11, .97, .3]],
      clap: [[12, .6, .6], [4, .79, .52]],
      closedHat: [[2, .08, .64], [10, .16, .63], [6, .24, .7], [14, .33, .64], [0, .42, .43], [8, .5, .45], [4, .56, .42], [12, .63, .43], [7, .7, .35], [15, .75, .44], [3, .8, .33], [11, .84, .36], [1, .88, .31], [9, .91, .32], [5, .95, .31], [13, .99, .3]],
      openHat: [[2, .64, .62], [14, .82, .69]],
      perc: [[3, .46, .55], [11, .61, .62], [9, .82, .46], [15, .95, .56]]
    },
    half: {
      kick: [[0, .01, 1], [11, .22, .8], [6, .49, .72], [14, .76, .65], [3, .94, .5]],
      snare: [[8, .18, 1], [7, .8, .34], [15, .94, .42]],
      clap: [[8, .52, .68]],
      closedHat: [[0, .08, .54], [8, .16, .57], [4, .24, .62], [12, .32, .65], [2, .42, .4], [10, .5, .43], [6, .58, .44], [14, .64, .48], [7, .72, .36], [15, .76, .44], [3, .8, .36], [11, .85, .39], [1, .88, .31], [9, .92, .32], [5, .96, .3], [13, .99, .32]],
      openHat: [[6, .65, .63], [14, .84, .68]],
      perc: [[5, .47, .57], [13, .66, .61], [10, .9, .45]]
    }
  };
  function pattern(raw, activity, bar = 0) {
    const config = settings(raw);
    const movement = unit(activity);
    const density = (config.drumDensityMin + (config.drumDensityMax - config.drumDensityMin) * movement) / 100;
    const fill = Math.max(0, Math.floor(Number(bar) || 0)) % 4 === 3 && config.drumFill > 0;
    return TRACKS.map((track) => {
      const steps = Array(16).fill(0);
      if (density <= 0 || config.drumMuted.includes(track.id)) return { ...track, steps };
      for (const [index, threshold, velocity] of BASE[config.drumStyle][track.id]) {
        if (density >= threshold) steps[index] = velocity * (.72 + .28 * movement);
      }
      if (fill && ["snare", "perc", "closedHat"].includes(track.id)) {
        const strength = config.drumFill / 100;
        for (let index = 12; index < 16; index++) {
          const threshold = .55 + (index - 12) * .08 + (track.id === "perc" ? .06 : 0);
          if (density >= threshold && strength >= .05 + (index - 12) * .25) steps[index] = Math.max(steps[index], (.38 + (index - 12) * .13) * (.72 + .28 * movement));
        }
      }
      return { ...track, steps };
    });
  }
  function step(raw, activity, stepIndex = 0) {
    const config = settings(raw);
    const movement = unit(activity);
    const index = Math.max(0, Math.floor(Number(stepIndex) || 0));
    const tempo = config.drumTempoMin + (config.drumTempoMax - config.drumTempoMin) * movement;
    const density = config.drumDensityMin + (config.drumDensityMax - config.drumDensityMin) * movement;
    const interval = 15000 / tempo * (1 + (index % 2 ? -1 : 1) * config.drumSwing / 100);
    const grid = pattern(config, movement, Math.floor(index / 16));
    const hits = grid.flatMap((track) => track.steps[index % 16] > 0 ? [{
      track: track.id, note: track.note, velocity: Math.round(clamp(track.steps[index % 16] * 127, 1, 127)),
      duration: track.id === "openHat" ? 400 : track.id === "kick" ? 280 : track.id === "snare" ? 180 : 85
    }] : []);
    return { tempo, density, interval, hits, pattern: grid };
  }

  class Engine {
    constructor(context, destination) {
      this.context = context;
      this.voices = new Set();
      this.disposed = false;
      this.output = context.createGain();
      this.output.gain.value = .48;
      this.output.connect(destination || context.destination);
      this.noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    hit(track, velocity = 100, kit = "electro", time = this.context.currentTime, volume = .65) {
      if (this.disposed || !TRACKS.some((item) => item.id === track)) return;
      const ctx = this.context;
      const start = Math.max(ctx.currentTime, Number(time) || 0);
      const level = clamp(velocity, 0, 127) / 127 * clamp(volume, 0, 1);
      if (level <= 0) return;
      if (track === "closedHat") for (const voice of this.voices) if (voice.track === "openHat") this.release(voice, start);
      while (this.voices.size >= 64) this.release(this.voices.values().next().value, ctx.currentTime, true);
      const character = kit === "warehouse" ? 1 : kit === "minimal" ? 2 : 0;
      const voice = { track, nodes: [], sources: [], ended: 0, released: false };
      this.voices.add(voice);
      const node = (value) => { voice.nodes.push(value); return value; };
      const amp = node(ctx.createGain());
      amp.connect(this.output);
      amp.gain.setValueAtTime(level, start);
      voice.amp = amp;
      const envelope = (peak, duration, destination = amp, attack = .001) => {
        const gain = node(ctx.createGain());
        gain.gain.setValueAtTime(.0001, start);
        gain.gain.exponentialRampToValueAtTime(Math.max(.0001, peak), start + attack);
        gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
        gain.connect(destination);
        return gain;
      };
      const source = (value, duration, destination) => {
        node(value); voice.sources.push(value); value.connect(destination);
        value.onended = () => {
          voice.ended++;
          if (voice.ended >= voice.sources.length) this.cleanup(voice);
        };
        value.start(start); value.stop(start + duration + .02);
        return value;
      };
      const tone = (frequency, endFrequency, duration, peak, type = "sine", destination = amp) => {
        const oscillator = ctx.createOscillator();
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, start);
        if (endFrequency !== frequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + Math.min(.1, duration * .6));
        return source(oscillator, duration, envelope(peak, duration, destination));
      };
      const noise = (frequency, type, duration, peak, destination = amp) => {
        const filter = node(ctx.createBiquadFilter());
        filter.type = type; filter.frequency.setValueAtTime(frequency, start); filter.Q.value = .7;
        filter.connect(envelope(peak, duration, destination));
        const buffer = ctx.createBufferSource(); buffer.buffer = this.noise;
        return source(buffer, duration, filter);
      };
      if (track === "kick") {
        const duration = [.55, .32, .22][character];
        tone([160, 210, 130][character], [43, 49, 46][character], duration, 1.12);
        noise([1400, 2400, 4200][character], "lowpass", .018, [.22, .42, .2][character]);
      } else if (track === "snare") {
        noise([1700, 2500, 4300][character], "highpass", [.23, .19, .11][character], .65);
        tone([175, 205, 260][character], [120, 150, 190][character], .12, .42, character === 2 ? "triangle" : "sine");
        tone(330, 240, .065, .2);
      } else if (track === "clap") {
        const bursts = node(ctx.createGain()); bursts.connect(amp);
        bursts.gain.setValueAtTime(.0001, start);
        for (const offset of [0, .012, .025]) {
          bursts.gain.setValueAtTime(.9, start + offset);
          bursts.gain.exponentialRampToValueAtTime(.02, start + offset + .01);
        }
        bursts.gain.setValueAtTime(.45, start + .037);
        bursts.gain.exponentialRampToValueAtTime(.0001, start + .19);
        noise([1100, 1500, 2400][character], "bandpass", .21, 1, bursts);
      } else if (track === "closedHat" || track === "openHat") {
        const duration = track === "openHat" ? [.42, .52, .24][character] : [.065, .055, .035][character];
        noise([6700, 8000, 10000][character], "highpass", duration, .29);
        const metal = node(ctx.createBiquadFilter()); metal.type = "highpass"; metal.frequency.value = 6800; metal.connect(amp);
        for (const frequency of [421, 587, 845, 1237]) tone(frequency * (character === 2 ? 1.7 : 1), frequency * (character === 2 ? 1.7 : 1), duration, .025, "square", metal);
      } else {
        tone([540, 760, 1120][character], [230, 360, 690][character], [.14, .11, .09][character], .43, character === 2 ? "sine" : "triangle");
        tone([817, 1103, 1680][character], [620, 850, 1420][character], .07, .13);
      }
      return voice;
    }
    cleanup(voice) {
      if (!this.voices.delete(voice)) return;
      for (const node of voice.nodes) { try { node.disconnect(); } catch (_) { /* Already disconnected. */ } }
      for (const source of voice.sources) source.onended = null;
    }
    release(voice, time, immediate = false) {
      if (voice.released && !immediate) return;
      voice.released = true;
      const when = Math.max(this.context.currentTime, time);
      voice.amp.gain.cancelScheduledValues(when);
      voice.amp.gain.setTargetAtTime(.0001, when, .003);
      for (const source of voice.sources) { try { source.stop(when + .015); } catch (_) { /* Already stopped. */ } }
      // Scheduled chokes retain their connection until the audio clock reaches
      // the closed hat. Stops and voice stealing disconnect synchronously.
      if (immediate) this.cleanup(voice);
    }
    stop() { for (const voice of [...this.voices]) this.release(voice, this.context.currentTime, true); }
    dispose() { this.stop(); this.output.disconnect(); this.disposed = true; }
  }
  return { TRACKS, KITS, STYLES, DEFAULTS, settings, Motion, pattern, step, Engine };
})();
