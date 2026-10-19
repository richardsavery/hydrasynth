"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const plain = (value) => JSON.parse(JSON.stringify(value));
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const fixed = (sourceKey, extra = {}) => ({ sourceKey, reducer: "value", rangeMode: "fixed", inputMin: 0, inputMax: 100, weight: 1, ...extra });
const bus = (id, sources, operator = "average") => ({ id, name: id, sources, operator });
const route = (busId, target, outputMin, outputMax, invert = false) => ({ busId, target, outputMin, outputMax, invert });
const track = { id: "saved", audio_url: "/saved.mp3", stems: [{ name: "Bass", audio_url: "/bass.mp3" }, { name: "Drums", audio_url: "/drums.mp3" }] };

function harness(options = {}) {
  const timers = new Map(), players = [], updates = [], errors = [], reads = [], preparations = [], resets = [], transitions = [];
  let time = 0, timerId = 0, revision = 1;
  let fields = [{ key: "a", name: "A" }, { key: "b", name: "B" }];
  const samples = { a: 20, b: 80 };
  const bridge = {
    describe: () => ({ mode: "live", label: "Live input", revision, fields }),
    async prepare(sources) { preparations.push(sources); if (options.prepare) await options.prepare(sources); },
    read(source, at) {
      reads.push(source); const value = samples[source.sourceKey];
      return typeof value === "number" ? { value, at } : value || null;
    },
    resetRange(source) { resets.push(source); }
  };
  class Player {
    constructor(callbacks = {}) {
      this.callbacks = callbacks; this.stemNames = []; this.duration = 20; this.currentPosition = 3; players.push(this);
      if (options.constructorState) callbacks.onState?.(options.constructorState);
    }
    updateControls(controls, valid) { this.controls = plain(controls); this.valid = valid; }
    setSourceValid(valid) { this.valid = valid; }
    async resume() { this.resumed = true; if (options.resume) await options.resume(); }
    transportClock(bpm) { return { bpm, playing: Boolean(this.playing), valid: this.valid !== false, token: "fake-deck", context: this }; }
    async loadTrack(selected) {
      this.track = selected;
      if (options.load) await options.load();
      this.stemNames = options.stemFailure ? [] : (selected.stems || []).map((stem) => stem.name);
      return !this.disposed;
    }
    async start() {
      this.initialControls = plain(this.controls); this.initialValid = this.valid;
      if (options.start) await options.start();
      this.playing = !this.disposed; return this.playing;
    }
    async queueTrack(selected, queueOptions) {
      const sequence = this.queueSequence || 0;
      this.queueOptions = queueOptions; this.queueInitialControls = plain(this.controls);
      if (options.queue) await options.queue(selected);
      if (this.disposed || sequence !== (this.queueSequence || 0)) return false;
      this.queued = selected; return true;
    }
    clearQueuedTrack() { this.queueSequence = (this.queueSequence || 0) + 1; this.queued = null; return true; }
    promote() {
      const next = this.queued;
      this.playingStemNames = [...this.stemNames, ...next.stems.map((stem) => stem.name)];
      this.stemNames = next.stems.map((stem) => stem.name); this.track = next; this.queued = null;
      this.callbacks.onTransition?.(next, { reason: "crossfade" });
    }
    dispose() { this.disposed = true; this.playing = false; }
  }
  const context = vm.createContext({
    performance: { now: () => time },
    setInterval(callback, interval) { assert.equal(interval, 100); const id = ++timerId; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); }
  });
  for (const file of ["elevenlabs-realtime.js", "music-mixer-engine.js"])
    vm.runInContext(fs.readFileSync(`${__dirname}/../dashboard/${file}`, "utf8"), context);
  const library = context.HydraMusicMixerEngine;
  const engine = library.create({ sourceBridge: bridge, Player, now: () => time, onUpdate: (state) => updates.push(state), onError: (message) => errors.push(message),
    onTransition: (selected, details) => transitions.push({ selected, details }) });
  return { library, engine, bridge, Player, timers, players, updates, errors, samples, reads, preparations, resets, transitions,
    async tick(at = time + 100) { time = at; for (const callback of [...timers.values()]) callback(); await settle(); },
    setFields(value) { fields = value; }, bumpRevision() { revision++; } };
}

async function main() {
  {
    const { library: lib } = harness();
    const old = lib.validateConfig({ channels: [{ name: "master", routes: [
      route("mix", "cutoff", 220, 14000), route("mix", "delayMix", 0, 0.4), route("mix", "pan", -0.25, 0.25)
    ] }] });
    assert.deepEqual(plain(old.channels[0].routes.map(r => [r.outputMin, r.outputMax])), [[80, 20000], [0, 0.85], [-0.25, 0.25]], "upgrade only the old default ranges");
    Object.assign(old.channels[0].routes[1], { outputMin: 0, outputMax: 0.4 });
    assert.equal(lib.validateConfig(old).channels[0].routes[1].outputMax, 0.4, "a later custom choice is not upgraded again");
    assert.deepEqual([lib.TARGETS.highpass.low, lib.TARGETS.highpass.high], [20, 6000]);
    assert.deepEqual([lib.TARGETS.pan.low, lib.TARGETS.pan.high], [-1, 1]);
    assert.deepEqual([lib.TARGETS.gain.low, lib.TARGETS.gain.high], [0, 1]);
    assert.deepEqual([lib.TARGETS.pitch.low, lib.TARGETS.pitch.high], [-12, 12]);
  }
  {
    const { library: lib } = harness();
    assert.equal(lib.defaultChannel().pitch, 0);
    assert.equal(lib.defaultChannel("Bass").pitch, 0);
    const allRoutes = Object.entries(lib.TARGETS).map(([target, bounds]) => route("mix", target, bounds.low, bounds.high));
    const validated = lib.validateConfig({ channels: [
      { name: "master", rate: 1.2, pitch: -7, routes: allRoutes },
      { name: "Bass", rate: 1.2, pitch: 99, routes: allRoutes }
    ] });
    assert.equal(validated.channels[0].routes.length, 9, "the master accepts all nine effects together");
    assert.equal(validated.channels[1].routes.length, 8, "stems accept independent pitch with all other stem effects");
    assert.equal(validated.channels[0].pitch, -7);
    assert.equal(validated.channels[0].rate, 1.2);
    assert.equal(validated.channels[1].pitch, 12, "manual pitch is limited to one octave");
    assert.equal(validated.channels[1].rate, 1, "stems retain shared transport speed");
    assert.ok(!validated.channels[1].routes.some((mapping) => mapping.target === "rate"));
    assert.deepEqual(plain(lib.validateConfig(plain(validated))), plain(validated), "independent pitch and speed survive saved configurations");
    const malformed = lib.validateConfig({ channels: [{ name: "master", pitch: NaN }, { name: "Bass", pitch: -99,
      routes: [route("mix", "pitch", -99, 99)] }] });
    assert.equal(malformed.channels[0].pitch, 0);
    assert.equal(malformed.channels[1].pitch, -12);
    assert.deepEqual(plain(malformed.channels[1].routes[0]), { ...route("mix", "pitch", -12, 12), strength: 1 });
  }
  {
    const { library: lib } = harness();
    for (const [input, expected] of [[undefined, 1], [null, 1], ["0.5", 1], [NaN, 1], [Infinity, 1], [-0.2, 0], [1.2, 1], [0, 0], [0.5, 0.5], [1, 1]]) {
      const validated = lib.validateConfig({ channels: [{ name: "master", routes: [{ ...route("mix", "pan", -1, 1), strength: input }] }] });
      assert.equal(validated.channels[0].routes[0].strength, expected, `strength ${input} is validated`);
      assert.equal(lib.validateConfig(plain(validated)).channels[0].routes[0].strength, expected, "strength survives a saved configuration round trip");
    }
  }
  {
    const h = harness(), { engine: e, library: lib } = h;
    const routes = [route("mix", "cutoff", 200, 20000), route("mix", "highpass", 20, 2000),
      route("mix", "pan", -1, 1), route("mix", "gain", 0, 1), route("mix", "rate", 0.75, 1.25), route("mix", "pitch", -12, 12)];
    e.setConfig({ buses: [bus("mix", [fixed("a"), fixed("b")])], channels: [
      { ...lib.defaultChannel(), level: 0.6, highpass: 80, pan: 0.4, rate: 1.1, pitch: -4, routes },
      { ...lib.defaultChannel("Bass"), level: 0.4, cutoff: 5000, pitch: 3, routes: [route("mix", "cutoff", 200, 20000), route("mix", "gain", 0, 1), route("mix", "pitch", 0, 12)] }
    ] });
    await e.setTrack(track); e.activate(); await settle(); assert.equal(await e.start(), true);
    const player = h.players[0];
    for (const strength of [0, 0.5, 1]) {
      const config = e.getConfig();
      for (const channel of config.channels) for (const mapping of channel.routes) mapping.strength = strength;
      e.setConfig(config);
      assert.equal(e.getConfig().channels[0].routes[0].strength, strength);
      assert.ok(Math.abs(player.controls.cutoff - (strength === 0 ? 20000 : strength === 1 ? 2000 : Math.sqrt(20000 * 2000))) < 1e-9, "frequency strength is perceptual, with exact endpoints");
      assert.ok(Math.abs(player.controls.highpass - (strength === 0 ? 80 : strength === 1 ? 200 : Math.sqrt(80 * 200))) < 1e-9);
      assert.ok(Math.abs(player.controls.pan - 0.4 * (1 - strength)) < 1e-9);
      assert.ok(Math.abs(player.controls.rate - (1.1 - 0.1 * strength)) < 1e-9);
      assert.ok(Math.abs(player.controls.pitch - -4 * (1 - strength)) < 1e-9, "pitch strength blends semitones linearly without altering speed");
      assert.equal(player.controls.stemControls.Bass.pitch, 3 + 3 * strength, "stem pitch has its own manual value and signal range");
      assert.equal(player.controls.stemControls.Bass.rate, undefined);
      assert.ok(Math.abs(player.controls.gain - 0.6 * (1 - 0.5 * strength)) < 1e-9, "gain strength blends modulation before multiplying the manual fader");
      assert.equal(player.controls.stemGains.Bass, 0.4);
      assert.ok(Math.abs(player.controls.stemControls.Bass.gain - (1 - 0.5 * strength)) < 1e-9);
      assert.ok(Math.abs(player.controls.stemControls.Bass.cutoff - 5000 * Math.pow(2000 / 5000, strength)) < 1e-9);
    }
    h.samples.a = 0; h.samples.b = 0;
    let config = e.getConfig();
    Object.assign(config.channels[0].routes[0], { outputMin: 20000, outputMax: 200, invert: true, strength: 0.5 });
    e.setConfig(config);
    assert.equal(player.controls.cutoff, 2000, "strength follows both an inverted signal and a descending frequency range");
    h.samples.a = null; await h.tick();
    assert.equal(player.valid, false, "nonzero strength retains missing-input gating");
    config = e.getConfig();
    for (const channel of config.channels) for (const mapping of channel.routes) { mapping.strength = 0; mapping.busId = "deleted"; }
    e.setConfig(config);
    assert.equal(player.valid, true, "zero strength ignores unavailable and deleted input mixes");
    assert.equal(e.snapshot().sourceValid, true);
    assert.equal(player.controls.cutoff, 20000); assert.equal(player.controls.pan, 0.4); assert.equal(player.controls.gain, 0.6);
    assert.equal(player.controls.stemControls.Bass.cutoff, 5000); assert.equal(player.controls.stemControls.Bass.gain, 1);
    assert.equal(player.controls.pitch, -4); assert.equal(player.controls.stemControls.Bass.pitch, 3);
    e.deactivate();
  }
  {
    const h = harness(), e = h.engine;
    assert.equal(e.transportClock(100), null, "idle inspection does not create a player");
    e.activate();
    await e.unlock();
    assert.equal(e.transportClock(100).playing, false);
    assert.equal(e.transportClock(100).context, h.players[0], "standalone rap can use the gesture-unlocked context");
    await e.setTrack({ ...track, generation_settings: { bpm: 112 } });
    assert.equal(e.transportClock(175).bpm, 112, "a stopped recalled track keeps its tempo when the next-track prompt differs");
    await e.start();
    assert.equal(e.transportClock(144).bpm, 112, "the sounding track tempo wins over a changed next-track prompt");
    assert.equal(e.transportClock(144).playing, true);
    const token = e.transportClock(144).token;
    e.stop();
    assert.equal(e.transportClock(144).context, null, "stopping disposes the accompaniment's voice context");
    assert.equal(e.transportClock(144).bpm, 112, "the selected track tempo remains available after disposing its player");
    await e.unlock();
    assert.notEqual(e.transportClock(144).token, token, "a new transport cannot retain a queued voice");
    e.deactivate();
  }
  {
    const h = harness(), e = h.engine;
    await e.setTrack({ ...track, generation_settings: { bpm: 100 } });
    const clock = e.transportClock(175);
    assert.equal(clock.bpm, 100, "preparing rap before any Play uses the recalled track tempo");
    assert.equal(clock.context, null);
    assert.equal(clock.playing, false);
    assert.equal(h.players.length, 0, "reading the stopped tempo cannot create or unlock audio");
    e.setConfig({ channels: [{ name: "master", rate: 1.25, pitch: 12 }] });
    assert.equal(e.transportClock(175).bpm, 125, "preparation includes the rate that playback will apply");
    e.setConfig({ channels: [{ name: "master", rate: 1.25, pitch: -12 }] });
    assert.equal(e.transportClock(175).bpm, 125, "pitch changes do not change the tempo used to prepare rap");
    e.activate(); await e.unlock();
    assert.equal(e.transportClock(175).bpm, 125, "unlocking an empty player does not revert the prepared tempo to its default rate");
    e.deactivate();
  }
  {
    const h = harness(), { engine: e, library: lib } = h;
    const validated = lib.validateConfig({ buses: Array.from({ length: 10 }, (_, i) => bus(i ? "duplicate" : "bus-2-1", Array(10).fill(fixed("a")))),
      channels: Array.from({ length: 12 }, (_, i) => ({ ...lib.defaultChannel(`stem${i}`), level: 100, cutoff: -1,
        routes: [route("x", "__proto__", 0, 1), route("x", "rate", 0.5, 2), route("x", "gain", 0, 0.5), route("y", "gain", 0, 10)] })) });
    assert.equal(validated.buses.length, 4);
    assert.equal(new Set(validated.buses.map((item) => item.id)).size, 4);
    assert.equal(validated.buses[0].sources.length, 6);
    assert.equal(validated.channels.length, 7);
    assert.equal(validated.channels[0].name, "master");
    assert.equal(validated.channels[1].level, 1);
    assert.equal(validated.channels[1].cutoff, 20);
    assert.deepEqual(plain(validated.channels[1].routes), [{ ...route("y", "gain", 0, 1), strength: 1 }], "only the last valid route to an effect survives");
    e.setConfig({ buses: [bus("combined", [fixed("a"), fixed("b", { weight: 3 })], "weighted")] });
    e.activate(); await settle();
    assert.equal(e.snapshot().running, false);
    assert.ok(Math.abs(e.snapshot().buses[0].value - 0.65) < 1e-12, "normalized signals combine before routing even while stopped");
    assert.equal(h.preparations.length, 1);
    const settings = e.getConfig(); settings.buses[0].operator = "difference"; e.setConfig(settings);
    assert.ok(Math.abs(e.snapshot().buses[0].value - 0.2) < 1e-12);
    await h.tick(); assert.equal(h.preparations.length, 1, "operator and mixer edits do not restart recording input");
    h.bumpRevision(); await h.tick(); assert.equal(h.preparations.length, 2, "same-name input revision re-prepares its data");
    h.setFields([{ key: "a" }]); await h.tick();
    assert.equal(e.snapshot().buses[0].value, null, "removing a configured signal cannot hold its last value");
    assert.equal(h.preparations.at(-1).length, 1, "unavailable fields do not block preparation of valid fields");
    e.deactivate(); assert.equal(h.timers.size, 0);
  }
  {
    const h = harness(), e = h.engine;
    e.setConfig({ buses: [bus("learn", [fixed("a", { rangeMode: "auto" })])] });
    e.activate(); await settle();
    assert.equal(e.snapshot().buses[0].value, 0.5, "first constant sample is neutral");
    assert.equal(e.freeze("learn", 0), false, "cannot freeze an empty-width range");
    h.samples.a = { value: 50, at: 100, minimum: 10, maximum: 90 }; await h.tick(100);
    assert.equal(e.snapshot().buses[0].value, 0.5);
    assert.equal(e.getConfig().buses[0].sources[0].learnedMin, 10);
    assert.equal(e.getConfig().buses[0].sources[0].learnedMax, 90, "captured stream peaks expand the range between UI frames");
    const observedSource = h.reads.at(-1), settings = e.getConfig(); settings.channels[0].level = 0.2; e.setConfig(settings);
    assert.equal(h.reads.at(-1), observedSource, "channel edits preserve the live source object and its peak registration");
    assert.equal(e.freeze("learn", 0), true);
    h.samples.a = 500; await h.tick(); assert.equal(e.snapshot().buses[0].value, 1);
    assert.equal(e.getConfig().buses[0].sources[0].inputMax, 90, "fixed calibration never drifts");
    e.relearn("learn", 0); assert.equal(h.resets.length, 1);
    assert.equal(e.snapshot().buses[0].value, 0.5);
    assert.equal(e.getConfig().buses[0].sources[0].learnedMin, 500);
    h.samples.a = { value: -100, at: 0 }; await h.tick(4000);
    assert.equal(e.snapshot().buses[0].value, null);
    assert.equal(e.getConfig().buses[0].sources[0].learnedMin, 500, "stale input never changes learned calibration");
    e.deactivate();
  }
  {
    const h = harness(), { engine: e, library: lib } = h;
    e.setConfig({ buses: [bus("mix", [fixed("a"), fixed("b")])], channels: [
      { ...lib.defaultChannel(), level: 0.5, routes: [route("mix", "gain", 0, 1)] },
      { ...lib.defaultChannel("Bass"), level: 0.4, muted: true,
        routes: [route("mix", "cutoff", 200, 20000), route("mix", "gain", 0, 1), route("mix", "pan", -1, 1, true)] },
      lib.defaultChannel("Drums"),
      { ...lib.defaultChannel("Absent"), solo: true, routes: [route("missing", "cutoff", 20, 100)] }
    ] });
    await e.setTrack(track); e.activate(); await settle(); assert.equal(await e.start(), true);
    const p = h.players[0];
    assert.equal(p.initialControls.stemGains.Bass, 0, "mute is seeded before the first audio deck starts");
    assert.equal(p.initialControls.stemControls.Bass.gain, 0.5);
    assert.equal(p.controls.gain, 0.25, "master fader multiplies its mapped gain");
    assert.equal(p.controls.stemControls.Bass.cutoff, 2000);
    assert.equal(p.controls.cutoff, 20000, "stem filters never become master effects");
    assert.equal(p.controls.stemControls.Bass.pan, 0);
    assert.equal(p.controls.stemGains.Drums, 1, "an absent solo stem cannot silence the current track");
    assert.equal(e.snapshot().channels.find((channel) => channel.name === "Absent").available, false);
    assert.equal(e.snapshot().sourceValid, true, "absent stem routes are never rerouted to master");
    let settings = e.getConfig(); settings.channels[1].muted = false; e.setConfig(settings);
    assert.equal(e.snapshot().channels.find((channel) => channel.name === "Bass").gain, 0.2);
    settings = e.getConfig(); settings.channels[1].solo = true; e.setConfig(settings);
    assert.equal(p.controls.stemGains.Drums, 0); assert.equal(p.controls.stemGains.Bass, 0.4);
    settings = e.getConfig(); settings.channels[0].muted = true; e.setConfig(settings);
    assert.equal(p.controls.gain, 0, "master mute overrides every mapped volume");
    settings = e.getConfig(); settings.channels[0].muted = false; e.setConfig(settings);
    h.samples.b = null; await h.tick();
    assert.equal(p.valid, false, "a missing constituent gates playback rather than sticking to the last control value");
    assert.equal(e.snapshot().buses[0].value, null);
    h.samples.b = 30; await h.tick(); assert.equal(p.valid, true);
    e.stop(); assert.equal(p.disposed, true); assert.equal(e.snapshot().active, true);
    assert.equal(await e.start(), true); assert.equal(h.players.length, 2);
    await e.setTrack({ id: "other", audio_url: "/other.mp3" });
    assert.equal(h.players[1].disposed, true, "choosing another track stops the old audio before selection changes");
    assert.equal(e.snapshot().running, false); e.deactivate();
  }
  {
    const h = harness(), { engine: e, library: lib } = h;
    e.setConfig({ buses: [bus("present", [fixed("a")])], channels: [lib.defaultChannel(),
      { ...lib.defaultChannel("Bass"), muted: true, routes: [route("missing", "cutoff", 20, 20000)] },
      { ...lib.defaultChannel("Piano"), solo: true, routes: [route("present", "gain", 0, 1)] }
    ] });
    await e.setTrack({ ...track, stems: [track.stems[0], { name: "Piano", audio_url: "/piano.mp3" }] });
    e.activate(); await settle(); assert.equal(await e.start(), true);
    const p = h.players[0];
    assert.equal(p.valid, true, "missing input on muted Bass does not silence a valid Piano solo");
    assert.equal(p.controls.stemGains.Bass, 0);
    let config = e.getConfig(); config.channels[1].muted = false; e.setConfig(config);
    assert.equal(p.valid, true, "a strip excluded by solo also ignores its missing mapped input");
    config = e.getConfig(); config.channels[2].solo = false; e.setConfig(config);
    assert.equal(p.valid, false, "restoring the missing-input strip to the mix restores its data requirement");
    config = e.getConfig(); config.channels[1].muted = true; e.setConfig(config);
    assert.equal(p.valid, true, "muting only the unavailable strip restores the other audible stem");
    config = e.getConfig(); config.channels[1].muted = false; config.channels[1].level = 0; e.setConfig(config);
    assert.equal(p.valid, true, "zero-level channels do not require valid modulation");
    config = e.getConfig(); config.channels[1].level = 0.1; e.setConfig(config);
    assert.equal(p.valid, false, "raising a silent strip requires its mapped input again");
    e.deactivate();
  }
  {
    const h = harness(), { engine: e, library: lib } = h;
    const vocals = [{ id: "vocals", name: "Vocals", audio_url: "/vocals.mp3" },
      { id: "VOICE", name: " vOcAl ", audio_url: "/voice.mp3" },
      { id: "VOCALS", name: "Singing", audio_url: "/singing.mp3" }];
    const saved = { ...track, stems: [vocals[0], ...track.stems, ...vocals.slice(1)],
      stem_separation: { status: "ready", stems: [vocals[0], ...track.stems] } };
    const before = plain(saved);
    assert.deepEqual(plain(lib.instrumentalStems(saved.stems)), track.stems, "vocal names and identifiers are excluded case-insensitively");
    e.setConfig({ channels: [lib.defaultChannel(),
      { ...lib.defaultChannel("Vocals"), solo: true, routes: [route("missing", "gain", 0, 1)] },
      { ...lib.defaultChannel(" vOcAl "), solo: true },
      { ...lib.defaultChannel("Bass"), level: 0.6 }, lib.defaultChannel("Drums")] });
    assert.deepEqual(plain(e.getConfig().channels.map((channel) => channel.name)), ["master", "Bass", "Drums"],
      "restored vocal strips and their solo/mapping state are removed from saved configuration");
    await e.setTrack(saved); e.activate(); assert.equal(await e.start(), true);
    const p = h.players[0];
    assert.deepEqual(plain(p.track.stems), track.stems, "the player receives only instrumental stems, rather than a hidden audible vocal strip");
    assert.deepEqual(plain(p.track.stem_separation.stems), track.stems);
    assert.deepEqual(plain(e.snapshot().track.stems), track.stems);
    assert.equal(p.controls.stemGains.Bass, 0.6);
    assert.equal(p.controls.stemGains.Drums, 1, "a saved vocal solo cannot silence the instrumental mix");
    assert.equal(p.controls.stemGains.Vocals, undefined);
    assert.equal(p.valid, true, "removed vocal mappings cannot gate the instrumental mix");
    assert.deepEqual(saved, before, "playback filtering never modifies the saved track object");
    const next = { id: "instrumental-next", audio_url: "/next.mp3", stem_separation: { status: "ready", stems: [
      vocals[0], { name: "Piano", audio_url: "/piano.mp3" }] } };
    assert.equal(await e.queueTrack(next), true);
    assert.deepEqual(plain(p.queued.stems.map((stem) => stem.name)), ["Piano"]);
    assert.deepEqual(plain(p.queued.stem_separation.stems.map((stem) => stem.name)), ["Piano"]);
    assert.deepEqual(plain(e.snapshot().queuedTrack.stems.map((stem) => stem.name)), ["Piano"]);
    assert.equal(p.queueInitialControls.stemGains.Vocals, undefined);
    assert.equal(p.queueInitialControls.stemGains.Piano, 1);
    p.promote();
    assert.deepEqual(plain(e.snapshot().track.stems.map((stem) => stem.name)), ["Piano"]);
    assert.deepEqual(plain(h.transitions[0].selected.stem_separation.stems.map((stem) => stem.name)), ["Piano"]);
    e.setConfig({ channels: [lib.defaultChannel(), { ...lib.defaultChannel("VOCALS"), solo: true }, lib.defaultChannel("Piano")] });
    assert.equal(p.controls.stemGains.Bass, 0.6, "retiring instrument settings persist through a crossfade after removing vocal settings");
    assert.equal(p.controls.stemGains.Piano, 1);
    assert.ok(e.snapshot().channels.every((channel) => !/vocals?/i.test(channel.name)));
    e.deactivate();
  }
  {
    const h = harness(), e = h.engine;
    const vocalOnly = { id: "voice-only", audio_url: "/mixed-with-vocals.mp3", stem_separation: {
      stems: [{ id: "vocals", name: "Vocals", audio_url: "/vocals.mp3" }] } };
    await e.setTrack(vocalOnly); e.activate();
    assert.equal(await e.start(), false, "removing every stem cannot fall back to the potentially vocal full mix");
    assert.equal(h.players.length, 0);
    assert.match(e.snapshot().error, /no instrumental stems/);
    assert.deepEqual(plain(e.snapshot().track.stems), []);
    assert.deepEqual(plain(e.snapshot().track.stem_separation.stems), []);
    await e.setTrack({ id: "original", audio_url: "/original-instrumental.mp3" });
    assert.equal(await e.start(), true, "saved original tracks with no stem separation still support full-mix playback");
    const p = h.players[0];
    assert.equal(await e.queueTrack(vocalOnly), false);
    assert.equal(p.queued, undefined);
    assert.equal(e.snapshot().queuedTrack, null);
    assert.equal(e.snapshot().track.id, "original");
    assert.equal(e.snapshot().running, true, "a vocal-only replacement keeps the current track repeating");
    assert.match(e.snapshot().error, /no instrumental stems/);
    e.deactivate();
  }
  {
    const h = harness(); h.setFields([]);
    const e = h.engine;
    e.setConfig({ buses: [bus("waiting", [fixed("__unassigned")])] });
    await e.setTrack({ audio_url: "/mix.mp3" }); e.activate(); await settle();
    assert.equal(await e.start(), true); assert.equal(h.players[0].valid, true, "manual playback needs no input connection when nothing is routed");
    const config = e.getConfig(); config.channels[0].routes = [route("waiting", "cutoff", 20, 20000)]; e.setConfig(config);
    assert.equal(h.players[0].valid, false);
    config.mode = "demo"; config.buses[0].sources = [fixed("demo:movement", { rangeMode: "auto" })]; e.setConfig(config);
    assert.equal(h.players[0].valid, true); assert.match(e.snapshot().sourceLabel, /simulated/);
    assert.equal(e.snapshot().fields.length, 3); assert.equal(e.snapshot().buses[0].value, 0.5);
    await h.tick(1000); assert.ok(e.snapshot().buses[0].value > 0.5); e.deactivate();
  }
  {
    const loading = defer(), h = harness({ load: () => loading.promise }), e = h.engine;
    await e.setTrack(track); e.activate(); const pending = e.start(); await settle();
    assert.equal(e.snapshot().starting, true); e.deactivate(); loading.resolve();
    assert.equal(await pending, false); assert.equal(h.players[0].disposed, true);
    assert.equal(h.players[0].playing, false); assert.equal(e.snapshot().active, false);
    assert.equal(h.errors.length, 0, "canceled loads do not surface as playback errors");
  }
  {
    const h = harness(), e = h.engine, lib = h.library;
    const next = { id: "next", audio_url: "/next.mp3", stems: [{ name: "Piano", audio_url: "/piano.mp3" }] };
    e.setConfig({ channels: [lib.defaultChannel(), { ...lib.defaultChannel("Bass"), solo: true, level: 0.4 },
      { ...lib.defaultChannel("Piano"), muted: true, cutoff: 750 }] });
    await e.setTrack(track); e.activate(); assert.equal(await e.start(), true);
    const p = h.players[0], before = e.getConfig();
    assert.equal(await e.queueTrack(next), true);
    assert.equal(p.queueOptions.requireStems, true, "prepared replacements cannot bypass mute with a fullmix fallback");
    assert.equal(p.queueInitialControls.stemGains.Piano, 0, "upcoming mutes are seeded before queue decode can schedule a deck");
    assert.equal(p.queueInitialControls.stemControls.Piano.cutoff, 750);
    assert.equal(e.snapshot().track.id, "saved", "preparing next audio must not switch the current track");
    assert.equal(e.snapshot().queuedTrack.id, "next");
    assert.equal(await e.queueTrack({ ...next, id: "third" }), false, "one prepared spare is retained until promotion");
    p.promote();
    assert.equal(e.snapshot().track.id, "next"); assert.equal(e.snapshot().queuedTrack, null);
    assert.equal(h.transitions.length, 1);
    assert.equal(h.transitions[0].details.reason, "crossfade");
    p.callbacks.onTransition(next, { reason: "crossfade" });
    assert.equal(h.transitions.length, 1, "a repeated state callback cannot count the same promotion twice");
    assert.deepEqual(plain(e.getConfig()), plain(before), "transition retains channel levels, mute, solo and routes");
    assert.equal(p.controls.stemGains.Bass, 0.4, "the retiring deck still has its manual volume during crossfade");
    e.setConfig({ channels: [before.channels[0], before.channels[2]] });
    assert.equal(p.controls.stemGains.Bass, 0.4, "rebuilding visible strips must not reset a retiring stem");
    p.playingStemNames = p.stemNames; await h.tick();
    assert.equal(p.controls.stemGains.Bass, undefined, "retired names stop occupying live control slots");
    e.deactivate();
  }
  {
    const h = harness(), e = h.engine, lib = h.library;
    e.setConfig({ channels: [lib.defaultChannel(), { ...lib.defaultChannel("Bass"), solo: true }] });
    await e.setTrack(track); e.activate(); await e.start();
    const next = { id: "other-stems", audio_url: "/other.mp3", stems: [{ name: "Strings", audio_url: "/strings.mp3" }] };
    await e.queueTrack(next);
    assert.equal(h.players[0].queueInitialControls.stemGains.Strings, 0, "new unconfigured stem names respect the audible solo before their first frame");
    assert.equal(h.players[0].controls.stemGains.Bass, 1);
    e.deactivate();
  }
  {
    const h = harness(), e = h.engine, lib = h.library;
    const oldStems = Array.from({ length: 6 }, (_, i) => ({ name: `Old ${i}`, audio_url: `/old-${i}.mp3` }));
    const newStems = Array.from({ length: 6 }, (_, i) => ({ name: `New ${i}`, audio_url: `/new-${i}.mp3` }));
    e.setConfig({ channels: [lib.defaultChannel(), ...oldStems.map((stem) => ({ ...lib.defaultChannel(stem.name), muted: true }))] });
    await e.setTrack({ id: "six-old", audio_url: "/old.mp3", stems: oldStems }); e.activate(); await e.start();
    e.setConfig({ channels: [lib.defaultChannel(), ...newStems.map((stem) => ({ ...lib.defaultChannel(stem.name), muted: true }))] });
    await e.queueTrack({ id: "six-new", audio_url: "/new.mp3", stems: newStems });
    const p = h.players[0];
    assert.equal(Object.keys(p.queueInitialControls.stemGains).length, 12, "both complete six-stem sets are seeded");
    p.promote();
    assert.equal(Object.keys(p.controls.stemGains).length, 12);
    assert.ok(Object.values(p.controls.stemGains).every((gain) => gain === 0), "the crossfade preserves all twelve mutes");
    e.deactivate();
  }
  for (const cancel of ["stop", "deactivate", "setTrack"]) {
    const loading = defer(), h = harness({ queue: () => loading.promise }), e = h.engine;
    await e.setTrack(track); e.activate(); await e.start();
    const pending = e.queueTrack({ id: "next", audio_url: "/next.mp3", stems: track.stems });
    assert.equal(e.snapshot().queueing, true);
    if (cancel === "setTrack") await e.setTrack({ id: "manual", audio_url: "/manual.mp3" }); else e[cancel]();
    loading.resolve(); assert.equal(await pending, false);
    assert.equal(e.snapshot().queueing, false); assert.equal(e.snapshot().queuedTrack, null);
    assert.equal(h.errors.length, 0, `${cancel} cancels pending queues without an error`);
    assert.equal(h.transitions.length, 0); assert.equal(e.snapshot().running, false);
    assert.equal(await e.queueTrack(track), false, "stopped engines never prepare replacements");
    e.deactivate();
  }
  {
    const oldDecode = defer(), freshDecode = defer();
    const h = harness({ queue: (selected) => selected.id === "obsolete" ? oldDecode.promise : freshDecode.promise }), e = h.engine;
    await e.setTrack(track); e.activate(); await e.start();
    const old = e.queueTrack({ ...track, id: "obsolete", audio_url: "/obsolete.mp3" });
    assert.equal(e.snapshot().queueing, true);
    assert.equal(e.clearQueuedTrack(), true);
    assert.equal(e.snapshot().queueing, false);
    const latest = e.queueTrack({ ...track, id: "latest", audio_url: "/latest.mp3" });
    oldDecode.resolve(); assert.equal(await old, false);
    assert.equal(e.snapshot().queueing, true, "a canceled decode's finally cannot clear its replacement's preparation state");
    assert.equal(e.snapshot().queuedTrack, null);
    freshDecode.resolve(); assert.equal(await latest, true);
    assert.equal(e.snapshot().queueing, false);
    assert.equal(e.snapshot().queuedTrack.id, "latest");
    assert.equal(h.players[0].queued.id, "latest");
    assert.equal(e.snapshot().track.id, "saved", "prompt edits keep the current song playing");
    assert.equal(e.clearQueuedTrack(), true);
    assert.equal(e.snapshot().queuedTrack, null);
    assert.equal(h.players[0].queued, null);
    assert.equal(h.players[0].playing, true);
    assert.deepEqual(h.errors, []);
    e.deactivate();
  }
  {
    const h = harness({ queue: () => { throw new Error("The saved stems could not be loaded"); } }), e = h.engine;
    await e.setTrack(track); e.activate(); await e.start();
    assert.equal(await e.queueTrack({ id: "broken", audio_url: "/broken.mp3", stems: track.stems }), false);
    assert.equal(e.snapshot().running, true); assert.equal(e.snapshot().track.id, "saved");
    assert.equal(h.players[0].playing, true, "a failed replacement leaves current audio repeating");
    assert.equal(e.snapshot().queuedTrack, null); assert.match(e.snapshot().error, /saved stems/);
    e.deactivate();
  }
  {
    const h = harness(), e = h.engine;
    await e.setTrack(track); e.activate(); await e.start();
    const player = h.players[0];
    player.callbacks.onState({ status: "playing", error: "An upcoming track could not be decoded." });
    assert.equal(e.snapshot().running, true, "a queue preparation warning does not stop current playback");
    assert.equal(player.disposed, undefined);
    await e.queueTrack({ ...track, id: "upcoming", audio_url: "/upcoming.mp3" });
    player.callbacks.onState({ status: "error", error: "Pitch processing stopped. Press Play to restart the track." });
    assert.equal(e.snapshot().running, false, "runtime processing errors stop the mixer transport");
    assert.equal(e.snapshot().starting, false);
    assert.equal(e.snapshot().queueing, false);
    assert.equal(e.snapshot().queuedTrack, null);
    assert.match(e.snapshot().error, /Pitch processing stopped/);
    assert.equal(player.disposed, true);
    assert.equal(h.errors.length, 1);
    assert.equal(await e.start(), true, "the user can restart after a runtime processor failure");
    player.callbacks.onState({ status: "error", error: "Late error from the disposed player" });
    assert.equal(e.snapshot().running, true, "a stale player's error cannot stop its replacement");
    assert.equal(h.errors.length, 1);
    e.deactivate();
  }
  {
    const h = harness({ constructorState: { status: "error", error: "Not yet an active player" } }), e = h.engine;
    await e.setTrack(track); e.activate();
    assert.equal(await e.start(), true, "a constructor callback cannot access an uninitialized candidate");
    assert.equal(h.errors.length, 0);
    e.deactivate();
  }
  {
    const h = harness({ load: () => {
      h.players[0].callbacks.onState({ status: "error", error: "The initial audio could not be loaded" });
      throw new Error("The initial audio could not be loaded");
    } }), e = h.engine;
    await e.setTrack(track); e.activate();
    assert.equal(await e.start(), false);
    assert.equal(e.snapshot().running, false);
    assert.equal(e.snapshot().starting, false);
    assert.equal(h.players[0].disposed, true);
    assert.equal(h.errors.length, 1, "a loading error is reported once without recursive disposal");
    assert.match(e.snapshot().error, /initial audio/);
    e.deactivate();
  }
  {
    const h = harness(), e = h.engine;
    e.activate(); const unlocking = e.unlock();
    assert.equal(h.players[0].resumed, true, "audio unlock starts synchronously inside the gesture");
    assert.equal(await unlocking, true);
    await e.setTrack(track); await e.start();
    assert.equal(h.players.length, 1, "generation uses the context unlocked before its asynchronous job");
    assert.equal(h.players[0].disposed, undefined);
    e.stop(); assert.equal(h.players[0].disposed, true);
    await e.unlock(); const reserved = h.players[1];
    e.deactivate(); assert.equal(reserved.disposed, true, "leaving a pending generation disposes its reserved context");
  }
  {
    const resuming = defer(), h = harness({ resume: () => resuming.promise }), e = h.engine;
    await e.setTrack(track); e.activate(); const pending = e.start(); await settle();
    await e.setTrack({ audio_url: "/replacement.mp3" }); resuming.resolve();
    assert.equal(await pending, false); assert.equal(h.players[0].track, undefined, "stale resume must not load a newly selected track");
    assert.equal(h.players[0].disposed, true); e.deactivate();
  }
  {
    const h = harness({ stemFailure: true }), e = h.engine;
    await e.setTrack(track); e.activate(); await settle();
    assert.equal(await e.start(), false); assert.match(h.errors[0], /stems could not be loaded/);
    assert.equal(h.players[0].disposed, true, "stem preparation failures cannot bypass mute/solo by playing the master mix");
    e.deactivate();
  }
  {
    const loading = defer(), h = harness({ prepare: () => loading.promise }), e = h.engine;
    e.setConfig({ buses: [bus("a", [fixed("a")])] }); e.activate(); await settle();
    e.deactivate(); const count = h.updates.length; loading.resolve(); await settle();
    assert.equal(h.updates.length, count, "late input preparation cannot reactivate a stopped workspace");
    const other = h.library.create({ sourceBridge: h.bridge, Player: h.Player });
    await e.setTrack(track); e.activate(); await settle(); await e.start();
    const player = h.players[0];
    other.activate();
    assert.equal(e.snapshot().active, true);
    assert.equal(e.snapshot().running, true);
    assert.equal(player.playing, true, "another workspace input engine cannot stop the sounding player");
    assert.equal(player.disposed, undefined);
    assert.equal(h.timers.size, 2, "independent mixer input engines can stay active together");
    e.activate(); other.activate();
    assert.equal(h.timers.size, 2, "repeated activation cannot create duplicate timers");
    h.samples.a = 60; await h.tick();
    assert.equal(e.snapshot().buses[0].value, 0.6, "playing mappings still update with another workspace active");
    other.deactivate(); assert.equal(h.timers.size, 1);
    assert.equal(player.playing, true);
    e.deactivate(); assert.equal(h.timers.size, 0); assert.equal(player.disposed, true);
  }
  console.log("Music mixer engine: combined inputs, learning, stem DSP, mute/solo, stale-data gating and canceled playback passed.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
