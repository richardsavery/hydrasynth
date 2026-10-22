"use strict";

// Generated audio is a local instrument: no provider calls originate in this player.
// Sources loop in the audio thread, so a slow generation or a throttled UI timer
// cannot leave silence between segments. Ready replacements fade in at a boundary.
globalThis.HydraElevenPlayer = (() => {
  const DEFAULTS = Object.freeze({ cutoff: 20000, resonance: 0.7, highpass: 20, gain: 0.8,
    pan: 0, rate: 1, pitch: 0, delayMix: 0, reverbMix: 0 });
  const LIMITS = Object.freeze({ cutoff: [20, 20000], resonance: [0.1, 12], highpass: [20, 6000],
    gain: [0, 1], pan: [-1, 1], rate: [0.75, 1.25], pitch: [-12, 12], delayMix: [0, 0.85], reverbMix: [0, 0.85] });
  const STEM_DEFAULTS = Object.freeze({ cutoff: 20000, resonance: 0.7, highpass: 20,
    gain: 1, pan: 0, pitch: 0, delayMix: 0, reverbMix: 0 });
  const MAX_STEMS = 6;
  const MAX_STEM_CONTROLS = MAX_STEMS * 2;
  const RATE_RAMP = 0.08;
  const MiB = 1024 * 1024;
  const STREAM_RATE = 48000;
  const STREAM_SECONDS = 10;
  const streamRegistrations = new WeakMap();
  const playerScript = globalThis.document?.currentScript?.src;
  const streamWorkletURL = playerScript ? new URL("audio-stream-worklet.js", playerScript).href : "audio-stream-worklet.js";
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const bytesOf = (buffer) => buffer.length * buffer.numberOfChannels * 4;
  const positiveModulo = (value, divisor) => ((value % divisor) + divisor) % divisor;
  const beatMaps = new WeakMap();
  const BEAT_TRACKING_ERROR = "Beat timing is not ready for this track. Stop playback and retry beat alignment in Music mixer.";
  const lowerBound = (values, target) => {
    let low = 0, high = values.length;
    while (low < high) { const mid = (low + high) >>> 1; if (values[mid] < target) low = mid + 1; else high = mid; }
    return low;
  };
  function readBeatMap(track, options) {
    const analysis = track?.beat_analysis;
    if (options?.enabled !== true || analysis?.state !== "complete" || analysis.schema_version !== 1) return null;
    let map = beatMaps.get(analysis);
    if (map === undefined) {
      const beats = analysis.beats_seconds, duration = analysis.duration_seconds, regions = analysis.active_regions;
      const valid = Array.isArray(beats) && beats.length >= 2 && beats.length <= 250000 && Number.isFinite(duration) && duration > 0 &&
        beats.every((beat, index) => Number.isFinite(beat) && beat >= 0 && beat < duration && (!index || beat > beats[index - 1])) &&
        (analysis.first_beat_in_bar == null || Number.isInteger(analysis.first_beat_in_bar) && analysis.first_beat_in_bar >= 1 && analysis.first_beat_in_bar <= 4) &&
        (analysis.bar_phase_confidence == null || Number.isFinite(analysis.bar_phase_confidence) && analysis.bar_phase_confidence >= 0 && analysis.bar_phase_confidence <= 1) &&
        ["bpm_median", "bpm_min", "bpm_max"].every(key => Number.isFinite(analysis[key]) && analysis[key] >= 15 && analysis[key] <= 400) &&
        ["source_sha256", "audio_sha256"].every(key => /^[a-f0-9]{64}$/.test(analysis[key])) &&
        ["mix", "drums"].includes(analysis.source) && (analysis.source !== "drums" || typeof analysis.source_stem_id === "string") &&
        Array.isArray(regions) && regions.length > 0 && regions.every((region, index) =>
          Number.isFinite(region?.start_seconds) && Number.isFinite(region.end_seconds) && region.start_seconds >= 0 &&
          region.end_seconds > region.start_seconds && region.end_seconds <= duration && (!index || region.start_seconds >= regions[index - 1].end_seconds));
      map = valid ? { beats, regions, duration, bpm: analysis.bpm_median,
        key: `${analysis.audio_sha256 || analysis.source_sha256 || ""}:${analysis.updated_at || ""}` } : null;
      if (map) {
        let region = 0;
        map.regionIndices = beats.map(beat => {
          while (region < regions.length && beat > regions[region].end_seconds) region++;
          return region < regions.length && beat >= regions[region].start_seconds ? region : -1;
        });
        const counts = regions.map(region => {
          const first = lowerBound(beats, region.start_seconds), last = lowerBound(beats, region.end_seconds);
          return last - first + (beats[last] === region.end_seconds ? 1 : 0);
        });
        if (map.regionIndices.includes(-1) || counts.some(count => count < 2)) map = null;
      }
      beatMaps.set(analysis, map);
    }
    if (!map) return null;
    const audioDuration = track.audio?.duration_seconds ?? track.duration_seconds;
    if (Number.isFinite(audioDuration) && Math.abs(audioDuration - map.duration) > .25) return null;
    if (track.origin === "uploaded" && track.source?.sha256 && analysis.audio_sha256 !== track.source.sha256) return null;
    if (analysis.source === "mix" && analysis.source_sha256 !== analysis.audio_sha256) return null;
    return { ...map, offset: clamp(Number(options.offsetSeconds) || 0, -10, 10),
      first: clamp(Math.round(Number(options.firstBeatInBar) || analysis.first_beat_in_bar || 1), 1, 4) - 1 };
  }

  // Window responses have a deliberately small PCM contract. Reading it directly
  // avoids decodeAudioData resampling every window independently at its edges.
  function decodePCMWindow(encoded, length) {
    if (!encoded || encoded.byteLength < 44 || encoded.byteLength > 3 * MiB) throw new Error("The audio window is not a valid WAV file.");
    const view = new DataView(encoded);
    const tag = (at) => String.fromCharCode(...new Uint8Array(encoded, at, 4));
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("The audio window is not a PCM WAV file.");
    let format = null, data = null;
    for (let at = 12; at + 8 <= view.byteLength;) {
      const size = view.getUint32(at + 4, true), start = at + 8;
      if (start + size > view.byteLength) throw new Error("The audio window is incomplete.");
      if (tag(at) === "fmt " && size >= 16) {
        const code = view.getUint16(start, true);
        format = { code: code === 65534 && size >= 40 ? view.getUint16(start + 24, true) : code,
          channels: view.getUint16(start + 2, true), rate: view.getUint32(start + 4, true), bits: view.getUint16(start + 14, true) };
      } else if (tag(at) === "data") data = { start, size };
      at = start + size + (size % 2);
    }
    if (format?.code !== 1 || format.channels !== 2 || format.rate !== STREAM_RATE || format.bits !== 16 || !data || data.size % 4) {
      throw new Error("The audio window must be stereo 48 kHz PCM audio.");
    }
    const frames = data.size / 4;
    if (Math.abs(frames - length) > STREAM_RATE / 20) throw new Error("The audio window does not align with the saved track.");
    const channels = [new Float32Array(length), new Float32Array(length)];
    for (let frame = 0; frame < Math.min(frames, length); frame++) {
      channels[0][frame] = view.getInt16(data.start + frame * 4, true) / 32768;
      channels[1][frame] = view.getInt16(data.start + frame * 4 + 2, true) / 32768;
    }
    return channels;
  }

  class Player {
    constructor(options = {}) {
      this._AudioContext = options.AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext;
      this._Pitch = options.Pitch || globalThis.HydraPitch;
      this._WorkletNode = options.AudioWorkletNode || globalThis.AudioWorkletNode;
      this._fetch = options.fetch || globalThis.fetch?.bind(globalThis);
      this._setTimeout = options.setTimeout || globalThis.setTimeout.bind(globalThis);
      this._clearTimeout = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
      this.onState = options.onState || (() => {});
      this.onTransition = options.onTransition || (() => {});
      this._beatTracking = typeof options.beatTracking === "function" ? options.beatTracking : () => options.beatTracking;
      this.crossfadeSeconds = clamp(Number(options.crossfadeSeconds) || 2, 0.1, 8);
      // A 60-second stereo segment at 48 kHz uses about 132 MiB for six
      // stems. Keep room for current and upcoming stems plus their full mixes.
      this.maxDecodedBytes = Math.max(MiB, Number(options.maxDecodedBytes) || 384 * MiB);
      this._cache = new Map();
      this._cacheClock = 0;
      this._operations = new Set();
      this._preparation = Promise.resolve();
      this._epoch = 0;
      this._deckSequence = 0;
      this._clockRevision = 0;
      this._transportRevision = 0;
      this._queueSequence = 0;
      this._status = "empty";
      this._running = false;
      this._disposed = false;
      this._valid = true;
      this._context = null;
      this._prepared = null;
      this._queued = null;
      this._active = null;
      this._transition = null;
      this._timer = null;
      this._error = null;
      this._controls = { ...DEFAULTS, stemGains: Object.create(null), stemControls: Object.create(null) };
    }

    get status() { return this._status; }
    get currentTrack() { return (this._active?.prepared || this._prepared)?.track || null; }
    get transportTrack() {
      const now = this._context?.currentTime || 0;
      const prepared = this._transition && now >= this._transition.start ? this._transition.next.prepared : this._active?.prepared || this._prepared;
      return prepared?.track || null;
    }
    get queuedTrack() { return this._queued?.track || (this._transition?.reason === "crossfade" && !this._transition.promoted && this._transition.next.prepared.track) || null; }
    get duration() { return (this._active?.prepared || this._prepared)?.duration || 0; }
    get currentPosition() { return this._active ? this._position(this._active, this._context.currentTime - this._active.latency) : 0; }
    get remainingSeconds() { return this._active ? this._remaining(this._active, this._context.currentTime - this._active.latency) : this.duration / this._controls.rate; }
    get stemNames() { return (this._active?.prepared || this._prepared)?.parts.filter((part) => part.name !== null).map((part) => part.name) || []; }
    get playingStemNames() {
      const decks = this._decks();
      return decks.length ? [...new Set(decks.flatMap((deck) => deck.parts.filter((part) => part.name !== null).map((part) => part.name)))] : this.stemNames;
    }
    get warnings() { return [...((this._active?.prepared || this._prepared)?.warnings || [])]; }
    get sourceValid() { return this._valid; }
    get controls() { return { ...this._controls, stemGains: { ...this._controls.stemGains },
      stemControls: Object.fromEntries(Object.entries(this._controls.stemControls).map(([name, values]) => [name, { ...values }])) }; }
    get decodedBytes() {
      let total = [...this._cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      const prepared = new Set([this._prepared, this._queued, ...this._decks().map((deck) => deck.prepared),
        ...[...this._operations].map((operation) => operation.streamPrepared)].filter(Boolean));
      for (const item of prepared) for (const chunk of item.initial?.values() || []) total += this._chunkBytes(item, chunk.index);
      for (const deck of this._decks()) for (const index of deck.stream?.buffered || []) total += this._chunkBytes(deck.prepared, index);
      return total;
    }
    get streaming() { return Boolean((this._active?.prepared || this._prepared)?.streaming); }

    // Read-only bridge for separately rendered voices. Generated music has no
    // detected beat grid: bpm is the requested tempo, with the deck start as
    // beat zero. Never create or resume an AudioContext while inspecting it.
    transportClock(bpm) {
      const context = this._context;
      const now = context?.currentTime || 0;
      const deck = this._transition && now >= this._transition.start ? this._transition.next : this._active;
      const at = deck ? Math.max(now, deck.sourceStart + deck.latency) : now;
      const track = deck?.prepared.track || this._prepared?.track;
      const tempo = Number(track?.origin === "uploaded" ? bpm :
        track?.realtime?.generation_settings?.bpm ?? track?.generation_settings?.bpm ?? track?.request?.settings?.bpm ?? bpm);
      const usableTempo = Number.isFinite(tempo) && tempo >= 20 && tempo <= 300;
      const sourceTime = deck ? at - deck.latency : at;
      const position = deck ? this._clockAt(deck, sourceTime) : null;
      // A buffer can loop before the UI timer schedules its replacement.
      // Include that loop in the token so a voice cannot keep the old phase.
      const cycle = deck ? Math.floor(position.position / deck.prepared.duration) : 0;
      const map = this._beatMap(track);
      const missingMap = this._beatTracking(track)?.enabled === true && !map;
      const detected = map && deck ? this._detectedClock(deck, map, at, position, cycle) : null;
      return { context, destination: context?.destination || null,
        playing: this._running && Boolean(deck) && !this._disposed,
        valid: this._valid && usableTempo && !this._disposed,
        bpm: usableTempo ? tempo * (position?.rate || this._controls.rate) : null,
        baseBpm: usableTempo ? tempo : null, rate: position?.rate || this._controls.rate,
        beat: usableTempo && deck ? positiveModulo(position.position, deck.prepared.duration) * tempo / 60 : 0,
        at, token: `${this._epoch}:${this._clockRevision}:${deck?.syncId || 0}:${cycle}:${deck?.clock.target || this._controls.rate}:${tempo}`,
        // Live beat followers can adapt to tempo changes without restarting.
        // Rendered voices still use the stricter token above.
        transportToken: `${this._epoch}:${this._transportRevision}:${deck?.syncId || 0}:${cycle}:${tempo}`,
        rateChanging: Boolean(position?.rampRemaining || (deck && deck.clock.time > sourceTime + 1e-8)),
        estimated: true, ...(detected || {}), ...(missingMap ? { valid: false, bpm: null, baseBpm: null,
          estimated: false, detected: true, beatContacts: [], beatTrackingError: BEAT_TRACKING_ERROR } : {}) };
    }

    _beatMap(track) {
      const map = readBeatMap(track, this._beatTracking(track));
      const prepared = [this._prepared, this._queued, ...this._decks().map(deck => deck.prepared)].find(item => item?.track === track);
      return map && (!prepared || Math.abs(prepared.duration - map.duration) <= .25) ? map : null;
    }

    _detectedClock(deck, map, at, position, cycle) {
      const duration = deck.prepared.duration, sourcePosition = positiveModulo(position.position, duration) - map.offset;
      const index = Math.min(map.beats.length - 1, Math.max(0, lowerBound(map.beats, sourcePosition + 1e-8) - 1));
      const linked = index + 1 < map.beats.length && map.regionIndices[index] >= 0 && map.regionIndices[index] === map.regionIndices[index + 1];
      const interval = linked ? map.beats[index + 1] - map.beats[index] : null;
      const fraction = interval ? clamp((sourcePosition - map.beats[index]) / interval, 0, 1) : 0;
      const beat = map.first + index + fraction, baseBpm = interval ? 60 / interval : map.bpm;
      const contacts = [], horizon = at + 1.1, transition = this._transition;
      let end = horizon;
      if (transition && deck === transition.old) end = Math.min(end, transition.start - 1e-7);
      else if (!transition && this._queued) {
        // A replacement will take over at the start of its crossfade. Do not
        // dispatch old-track hits past that known boundary before it is armed.
        const fade = Math.min(this.crossfadeSeconds, duration / this._controls.rate / 4, this._queued.duration / this._controls.rate / 4);
        end = Math.min(end, at + this._remaining(deck, at - deck.latency) - fade - 1e-7);
      }
      this._appendBeatContacts(contacts, deck, map, at, end);
      if (transition && deck === transition.old && transition.start <= horizon) {
        const nextMap = this._beatMap(transition.next.prepared.track);
        if (nextMap) this._appendBeatContacts(contacts, transition.next, nextMap, Math.max(at, transition.start), horizon);
      }
      const identity = `${map.key}:${map.offset}:${map.first}`;
      return { detected: true, estimated: false, valid: this._valid && !this._disposed,
        bpm: baseBpm * position.rate, baseBpm, beat, beatContacts: contacts,
        token: `${this._epoch}:${this._clockRevision}:${deck.syncId}:${cycle}:${identity}`,
        // A natural loop or tempo gap changes the map phase, not the hardware
        // performance. Contact IDs carry their own deck/cycle identity.
        transportToken: `${this._epoch}:${this._transportRevision}:detected`,
        mapToken: `${deck.syncId}:${cycle}:${identity}` };
    }

    _appendBeatContacts(contacts, deck, map, start, end) {
      if (end < start) return;
      const duration = deck.prepared.duration;
      const firstPosition = this._clockAt(deck, start - deck.latency).position;
      const lastPosition = this._clockAt(deck, end - deck.latency).position;
      const firstCycle = Math.floor(firstPosition / duration), lastCycle = Math.floor(lastPosition / duration);
      for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
        const localStart = firstPosition - cycle * duration - map.offset;
        const localEnd = lastPosition - cycle * duration - map.offset;
        for (let index = Math.max(0, lowerBound(map.beats, localStart) - 1); index < map.beats.length && map.beats[index] <= localEnd + 1e-8; index++) {
          if (map.regionIndices[index] < 0) continue;
          const linked = index + 1 < map.beats.length && map.regionIndices[index] === map.regionIndices[index + 1];
          for (let part = 0; part < (linked ? 4 : 1); part++) {
            const source = map.beats[index] + map.offset + (linked ? (map.beats[index + 1] - map.beats[index]) * part / 4 : 0);
            if (source < 0 || source >= duration || source < localStart + map.offset - 1e-8 || source > localEnd + map.offset + 1e-8) continue;
            const target = cycle * duration + source;
            const when = start + this._secondsToPosition(deck, start - deck.latency, target);
            if (when < start - 1e-8 || when > end + 1e-8) continue;
            contacts.push({ beat: map.first + index + part / 4, at: when,
              key: `${deck.syncId}:${cycle}:${index}:${part}` });
          }
        }
      }
    }

    _emit(status = this._status) {
      this._status = status;
      try {
        this.onState({ status, currentTrack: this.currentTrack, queuedTrack: this.queuedTrack,
          currentPosition: this.currentPosition, remainingSeconds: this.remainingSeconds,
          duration: this.duration, stemNames: this.stemNames, warnings: this.warnings,
          sourceValid: this.sourceValid, error: this._error });
      } catch (error) { globalThis.console?.error("ElevenLabs player state listener failed", error); }
    }

    _ensureContext() {
      if (this._disposed) throw new Error("This audio player has been disposed.");
      if (this._context) return this._context;
      if (!this._AudioContext) throw new Error("This browser does not support Web Audio playback.");
      const ctx = this._context = new this._AudioContext();
      this._input = ctx.createGain();
      this._highpass = ctx.createBiquadFilter();
      this._highpass.type = "highpass";
      this._highpass.Q.value = 0.707;
      this._lowpass = ctx.createBiquadFilter();
      this._lowpass.type = "lowpass";
      this._volume = ctx.createGain();
      this._gate = ctx.createGain();
      this._gate.gain.value = 0;
      this._panner = ctx.createStereoPanner();
      this._limiter = ctx.createDynamicsCompressor();
      this._limiter.threshold.value = -4;
      this._limiter.knee.value = 0;
      this._limiter.ratio.value = 20;
      this._limiter.attack.value = 0.003;
      this._limiter.release.value = 0.15;
      this._delay = ctx.createDelay(1);
      this._delay.delayTime.value = 0.24;
      this._feedback = ctx.createGain();
      this._feedback.gain.value = 0.42;
      this._delayWet = ctx.createGain();
      this._reverbWet = ctx.createGain();
      this._convolver = ctx.createConvolver();
      const impulse = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * 2.4), ctx.sampleRate);
      let random = 12345;
      for (let channel = 0; channel < 2; channel++) {
        const samples = impulse.getChannelData(channel);
        for (let i = 0; i < samples.length; i++) {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          samples[i] = (random / 2147483648 - 1) * Math.pow(1 - i / samples.length, 2);
        }
      }
      this._convolver.buffer = impulse;
      this._input.connect(this._highpass);
      this._highpass.connect(this._lowpass);
      this._lowpass.connect(this._volume);
      this._lowpass.connect(this._delay);
      this._delay.connect(this._feedback);
      this._feedback.connect(this._delay);
      this._delay.connect(this._delayWet);
      this._delayWet.connect(this._volume);
      this._lowpass.connect(this._convolver);
      this._convolver.connect(this._reverbWet);
      this._reverbWet.connect(this._volume);
      this._volume.connect(this._gate);
      this._gate.connect(this._panner);
      this._panner.connect(this._limiter);
      this._limiter.connect(ctx.destination);
      this.updateControls(this._controls, this._valid);
      return ctx;
    }

    _smooth(param, value, timeConstant = 0.05) {
      const now = this._context.currentTime;
      // cancelAndHold preserves the instantaneous value during repeated updates.
      if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
      else param.cancelScheduledValues(now);
      param.setTargetAtTime(value, now, timeConstant);
    }

    updateControls(values = {}, valid = true) {
      this.setSourceValid(valid);
      if (!valid || this._disposed) return this.controls;
      for (const [key, limits] of Object.entries(LIMITS)) {
        if (values[key] !== undefined && values[key] !== null && Number.isFinite(Number(values[key]))) {
          this._controls[key] = clamp(Number(values[key]), limits[0], limits[1]);
        }
      }
      if (values.stemGains && typeof values.stemGains === "object") {
        // A crossfade can contain two six-stem sets with different names.
        const next = Object.create(null);
        for (const [name, value] of Object.entries(values.stemGains).slice(0, MAX_STEM_CONTROLS)) {
          if (Number.isFinite(Number(value))) next[name] = clamp(Number(value), 0, 1);
        }
        this._controls.stemGains = next;
      }
      if (values.stemControls && typeof values.stemControls === "object") {
        const next = Object.create(null);
        for (const [name, incoming] of Object.entries(values.stemControls).slice(0, MAX_STEM_CONTROLS)) {
          if (!name || name.length > 100 || !incoming || typeof incoming !== "object") continue;
          const settings = {};
          for (const key of Object.keys(STEM_DEFAULTS)) {
            const value = incoming[key];
            if (typeof value === "number" && Number.isFinite(value)) settings[key] = clamp(value, ...LIMITS[key]);
          }
          next[name] = settings;
        }
        this._controls.stemControls = next;
      }
      if (this._context) {
        this._smooth(this._lowpass.frequency, Math.min(this._controls.cutoff, this._context.sampleRate * 0.45));
        this._smooth(this._lowpass.Q, this._controls.resonance);
        this._smooth(this._highpass.frequency, this._controls.highpass);
        this._smooth(this._volume.gain, this._controls.gain);
        this._smooth(this._panner.pan, this._controls.pan);
        this._smooth(this._delayWet.gain, this._controls.delayMix);
        this._smooth(this._reverbWet.gain, this._controls.reverbMix);
        for (const deck of this._decks()) {
          this._changeRate(deck, this._controls.rate);
          for (const part of deck.parts) this._applyPartControls(part);
        }
      }
      return this.controls;
    }

    setSourceValid(valid) {
      const changed = this._valid !== Boolean(valid);
      if (changed) { this._clockRevision += 1; this._transportRevision += 1; }
      this._valid = Boolean(valid);
      if (this._context) this._smooth(this._gate.gain, this._running && this._valid ? 1 : 0, 0.04);
      if (changed) this._emit();
    }

    _newOperation(queue = false) {
      const operation = { epoch: this._epoch, sequence: this._queueSequence,
        queue, pins: new Set(), controller: new AbortController() };
      operation.valid = () => !this._disposed && operation.epoch === this._epoch &&
        (!queue || operation.sequence === this._queueSequence);
      this._operations.add(operation);
      return operation;
    }

    _assertValid(operation) {
      if (!operation.valid()) { const error = new Error("Audio preparation was canceled."); error.name = "AbortError"; throw error; }
    }

    _protectedKeys() {
      const keys = new Set();
      for (const prepared of [this._prepared, this._queued, ...this._decks().map((deck) => deck.prepared)]) {
        for (const part of prepared?.parts || []) keys.add(part.key);
      }
      for (const operation of this._operations) for (const key of operation.pins) keys.add(key);
      return keys;
    }

    _makeRoom(bytes) {
      const protectedKeys = this._protectedKeys();
      const entries = [...this._cache.entries()].sort((a, b) => a[1].used - b[1].used);
      for (const [key] of entries) {
        if (this.decodedBytes + bytes <= this.maxDecodedBytes) break;
        if (!protectedKeys.has(key)) this._cache.delete(key);
      }
      if (this.decodedBytes + bytes > this.maxDecodedBytes) throw new Error("Decoded audio exceeds the playback memory limit; use shorter segments or fewer stems.");
    }

    async _decode(url, operation) {
      this._assertValid(operation);
      if (typeof url !== "string" || !url.trim()) throw new Error("The saved track has no audio URL.");
      let entry = this._cache.get(url);
      if (entry) { entry.used = ++this._cacheClock; operation.pins.add(url); return entry.buffer; }
      const timeout = this._setTimeout(() => operation.controller.abort(), 60000);
      let encoded;
      try {
        const response = await this._fetch(url, { signal: operation.controller.signal });
        this._assertValid(operation);
        if (!response.ok) throw new Error(`Could not load saved audio (${response.status}).`);
        const size = Number(response.headers?.get?.("content-length"));
        if (size > 32 * MiB) throw new Error("This audio file is too large for real-time playback.");
        encoded = await response.arrayBuffer();
        this._assertValid(operation);
        if (encoded.byteLength > 32 * MiB) throw new Error("This audio file is too large for real-time playback.");
      } finally { this._clearTimeout(timeout); }
      const buffer = await this._ensureContext().decodeAudioData(encoded);
      this._assertValid(operation);
      const bytes = bytesOf(buffer);
      if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > 180 ||
          buffer.numberOfChannels > 2 || bytes > 64 * MiB) {
        throw new Error("Use a mono or stereo audio segment no longer than 180 seconds.");
      }
      this._makeRoom(bytes);
      entry = { buffer, bytes, used: ++this._cacheClock };
      this._cache.set(url, entry);
      operation.pins.add(url);
      return buffer;
    }

    async _prepare(track, operation, options = {}) {
      this._assertValid(operation);
      if (!track || typeof track !== "object") throw new Error("Choose a saved generated track first.");
      if (!this._Pitch) throw new Error("Pitch processing is unavailable. Refresh the dashboard and try again.");
      await this._Pitch.register(this._ensureContext());
      this._assertValid(operation);
      if (track.origin === "uploaded") return this._prepareStream(track, operation, options);
      const mix = await this._decode(track.audio_url, operation);
      const prepared = { track: { ...track }, duration: mix.duration,
        parts: [{ name: null, key: track.audio_url, buffer: mix }], warnings: [] };
      if (Array.isArray(track.stems) && track.stems.length) {
        try {
          if (track.stems.length > MAX_STEMS) throw new Error(`At most ${MAX_STEMS} stems can play together.`);
          const names = new Set(), parts = [];
          let size = 0;
          for (const stem of track.stems) {
            const name = String(stem.name || "").trim();
            if (!name || names.has(name)) throw new Error("Every stem needs a unique name.");
            names.add(name);
            const buffer = await this._decode(stem.audio_url, operation);
            size += bytesOf(buffer);
            if (size > 160 * MiB) throw new Error("The stems exceed the per-track playback memory limit.");
            if (Math.abs(buffer.duration - mix.duration) > Math.max(0.15, mix.duration * 0.005)) {
              throw new Error(`The ${name} stem duration does not align with the original mix.`);
            }
            parts.push({ name, key: stem.audio_url, buffer });
          }
          prepared.parts = parts;
          prepared.duration = Math.min(mix.duration, ...parts.map((part) => part.buffer.duration));
        } catch (error) {
          this._assertValid(operation);
          if (options.requireStems) throw new Error(`The saved stems could not be loaded: ${error.message}`);
          prepared.warnings.push(`Playing the original mix because the stems could not be prepared: ${error.message}`);
        }
      }
      return prepared;
    }

    async _registerStream() {
      const ctx = this._ensureContext();
      if (!ctx.audioWorklet?.addModule || !this._WorkletNode) throw new Error("Uploaded audio needs AudioWorklet support. Use a current browser on localhost or HTTPS.");
      let pending = streamRegistrations.get(ctx);
      if (!pending) {
        pending = ctx.audioWorklet.addModule(streamWorkletURL).catch((error) => {
          streamRegistrations.delete(ctx); throw new Error(`Could not load audio streaming: ${error.message || error}`);
        });
        streamRegistrations.set(ctx, pending);
      }
      await pending;
    }

    async _streamChunk(prepared, index, signal, valid) {
      const length = Math.min(STREAM_SECONDS * STREAM_RATE, prepared.frames - index * STREAM_SECONDS * STREAM_RATE);
      this._makeRoom(this._chunkBytes(prepared, index));
      const parts = [];
      for (const part of prepared.parts) {
        if (!valid()) throw Object.assign(new Error("Audio preparation was canceled."), { name: "AbortError" });
        const query = `start=${index * STREAM_SECONDS}&duration=${STREAM_SECONDS}&sample_rate=${STREAM_RATE}`;
        const url = `${part.key}${part.key.includes("?") ? "&" : "?"}${query}`;
        const response = await this._fetch(url, { signal });
        if (!response.ok) throw new Error(`Could not load saved audio (${response.status}).`);
        if (Number(response.headers?.get?.("content-length")) > 3 * MiB) throw new Error("The audio window is unexpectedly large.");
        const encoded = await response.arrayBuffer();
        if (!valid()) throw Object.assign(new Error("Audio preparation was canceled."), { name: "AbortError" });
        parts.push(decodePCMWindow(encoded, length));
      }
      return { index, parts };
    }

    _chunkBytes(prepared, index) {
      return Math.min(STREAM_SECONDS * STREAM_RATE, prepared.frames - index * STREAM_SECONDS * STREAM_RATE) * 8 * prepared.parts.length;
    }

    async _prepareStream(track, operation, options) {
      await this._registerStream();
      this._assertValid(operation);
      const duration = Number(track.audio?.duration_seconds ?? track.duration_seconds);
      const frames = Math.round(duration * STREAM_RATE);
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(frames) || frames < 1) throw new Error("The uploaded audio has no valid duration.");
      const make = (parts) => ({ track: { ...track }, duration: frames / STREAM_RATE, frames,
        parts, warnings: [], streaming: true, initial: new Map() });
      const full = [{ name: null, key: track.audio_url }];
      let prepared = make(full);
      const fill = async () => {
        operation.streamPrepared = prepared;
        for (let index = 0; index < Math.min(3, Math.ceil(duration / STREAM_SECONDS)); index++) {
          const timeout = this._setTimeout(() => operation.controller.abort(), 60000);
          try { prepared.initial.set(index, await this._streamChunk(prepared, index, operation.controller.signal, operation.valid)); }
          finally { this._clearTimeout(timeout); }
        }
      };
      if (Array.isArray(track.stems) && track.stems.length) {
        try {
          if (track.stems.length > MAX_STEMS) throw new Error(`At most ${MAX_STEMS} stems can play together.`);
          const names = new Set();
          const parts = track.stems.map((stem) => {
            const name = String(stem.name || "").trim();
            if (!name || names.has(name)) throw new Error("Every stem needs a unique name.");
            if (typeof stem.audio_url !== "string" || !stem.audio_url.trim()) throw new Error("A stem has no audio URL.");
            const measured = Number(stem.audio?.duration_seconds ?? stem.duration_seconds);
            if (Number.isFinite(measured) && measured > 0 && Math.abs(measured - duration) > Math.max(0.15, duration * 0.005)) {
              throw new Error(`The ${name} stem duration does not align with the original mix.`);
            }
            names.add(name); return { name, key: stem.audio_url };
          });
          prepared = make(parts);
          await fill();
          return prepared;
        } catch (error) {
          this._assertValid(operation);
          if (options.requireStems) throw new Error(`The saved stems could not be loaded: ${error.message}`);
          prepared = make(full);
          prepared.warnings.push(`Playing the original mix because the stems could not be prepared: ${error.message}`);
        }
      }
      if (typeof track.audio_url !== "string" || !track.audio_url.trim()) throw new Error("The saved track has no audio URL.");
      await fill();
      return prepared;
    }

    _prepareSerial(track, operation, options = {}) {
      // Audio decoding cannot be aborted. Serialize preparations to cap outstanding
      // decodes even if a user selects several tracks and stops in quick succession.
      const task = this._preparation.then(() => this._prepare(track, operation, options));
      this._preparation = task.catch(() => {});
      return task;
    }

    async loadTrack(track, options = {}) {
      if (this._disposed) throw new Error("This audio player has been disposed.");
      this.stop();
      this._prepared = null;
      this._error = null;
      this._ensureContext();
      const operation = this._newOperation();
      this._emit("loading");
      try {
        const prepared = await this._prepareSerial(track, operation, options);
        this._assertValid(operation);
        this._prepared = prepared;
        this._emit("ready");
        if (options.autostart) return await this.start();
        return true;
      } catch (error) {
        if (!operation.valid()) return false;
        this._error = error.message;
        this._emit("error");
        throw error;
      } finally { this._operations.delete(operation); }
    }

    _withdrawScheduledTransition() {
      const transition = this._transition, now = this._context.currentTime;
      if (!transition || now >= transition.start) return false;
      transition.old.gain.gain.cancelScheduledValues(now);
      transition.old.gain.gain.setValueAtTime(1, now);
      this._destroyDeck(transition.next);
      this._transition = null;
      return true;
    }

    clearQueuedTrack() {
      if (this._disposed) return true;
      this._queueSequence++;
      for (const operation of this._operations) if (operation.queue) operation.controller.abort();
      this._queued = null;
      const transition = this._transition;
      const audible = transition?.reason === "crossfade" && this._context.currentTime >= transition.start;
      if (transition?.reason === "crossfade" && !audible) {
        // A prompt edit may arrive after scheduling but before the first new
        // sample. Withdraw that deck and leave the original song playing.
        this._withdrawScheduledTransition();
      } else if (audible && !transition.promoted) {
        // Audio runs independently of the UI timer. Report the actual current
        // song before a coordinator chooses the parent for another generation.
        this._tick();
      }
      this._emit();
      return !audible;
    }

    async queueTrack(track, options = {}) {
      if (this._disposed) throw new Error("This audio player has been disposed.");
      if (!this._prepared) return this.loadTrack(track, options);
      this.clearQueuedTrack();
      const operation = this._newOperation(true);
      try {
        const prepared = await this._prepareSerial(track, operation, options);
        this._assertValid(operation);
        this._queued = prepared;
        // Use a just-finished generation at this boundary if the fallback
        // repeat was scheduled but has not actually started sounding yet.
        if (this._transition?.reason === "loop") this._withdrawScheduledTransition();
        this._error = null;
        this._emit();
        if (this._running) this._tick();
        return true;
      } catch (error) {
        if (!operation.valid()) return false;
        this._error = error.message;
        this._emit();
        throw error;
      } finally { this._operations.delete(operation); }
    }

    resume() { return this._ensureContext().resume(); }

    async start({ leadSeconds = 0 } = {}) {
      const ctx = this._ensureContext();
      const epoch = this._epoch;
      // Call resume synchronously from the click handler, before awaiting work.
      await ctx.resume();
      if (this._disposed || epoch !== this._epoch) return false;
      if (this._running) return true;
      if (!this._prepared) throw new Error("Load a saved track before starting playback.");
      this._running = true;
      this._error = null;
      // An already armed beat follower can request preparation time before an
      // opening beat. This shifts the source start, never the saved audio/map.
      const when = ctx.currentTime + (this._prepared.streaming ? 0.08 : 0.02) + clamp(Number(leadSeconds) || 0, 0, 2);
      try { this._active = this._createDeck(this._prepared, when); }
      catch (error) { this._running = false; this._error = error.message; this._emit("error"); throw error; }
      const audible = when + this._active.latency;
      this._active.gain.gain.setValueAtTime(0, audible);
      this._active.gain.gain.linearRampToValueAtTime(1, audible + 0.03);
      this._smooth(this._gate.gain, this._valid ? 1 : 0, 0.03);
      this._emit("playing");
      this._tick();
      return true;
    }

    _decks() {
      return [...new Set([this._active, this._transition?.old, this._transition?.next].filter(Boolean))];
    }

    _createDeck(prepared, when) {
      const ctx = this._context;
      const deck = { prepared, gain: ctx.createGain(), parts: [], disposed: false, syncId: ++this._deckSequence,
        sourceStart: when, latency: this._Pitch.latencySeconds(ctx), clockHistory: [],
        clock: { time: when, position: 0, initial: this._controls.rate, target: this._controls.rate, ramp: 0 } };
      deck.gain.gain.value = 0;
      deck.gain.connect(this._input);
      try {
        if (prepared.streaming) this._createStream(deck, when);
        for (const [index, part] of prepared.parts.entries()) {
          const source = prepared.streaming ? this._streamOutput(deck, index) : ctx.createBufferSource(), gain = ctx.createGain();
          if (!prepared.streaming) {
            source.buffer = part.buffer;
            source.loop = true;
            source.loopStart = 0;
            source.loopEnd = prepared.duration;
          }
          source.playbackRate.setValueAtTime(this._controls.rate, when);
          const pitch = this._Pitch.create(ctx, { playbackRate: this._controls.rate,
            pitchSemitones: this._controls.pitch + (part.name === null ? 0 : this._controls.stemControls[part.name]?.pitch || 0) });
          const playing = { name: part.name, source, gain, pitch, nodes: [source, pitch, gain] };
          deck.parts.push(playing);
          pitch.onprocessorerror = () => {
            if (deck.disposed || this._disposed) return;
            this._error = "Pitch processing stopped. Press Play to restart the track.";
            this.stop(); this._emit("error");
          };
          source.connect(pitch);
          if (part.name === null) {
            pitch.connect(gain); gain.connect(deck.gain);
          } else {
            // Each stem is processed before summing into the master chain.
            // Playback rate stays shared so instrument layers remain aligned.
            const make = (name, method) => {
              const node = playing[name] = ctx[method](); playing.nodes.push(node); return node;
            };
            const highpass = make("highpass", "createBiquadFilter"), lowpass = make("lowpass", "createBiquadFilter");
            const pan = make("pan", "createStereoPanner"), delay = make("delay", "createDelay");
            const feedback = make("feedback", "createGain"), delayWet = make("delayWet", "createGain");
            const reverb = make("reverb", "createConvolver"), reverbWet = make("reverbWet", "createGain");
            highpass.type = "highpass"; highpass.Q.value = 0.707; lowpass.type = "lowpass";
            delay.delayTime.value = 0.24; feedback.gain.value = 0.42;
            reverb.buffer = this._convolver.buffer;
            pitch.connect(highpass); highpass.connect(lowpass); lowpass.connect(gain);
            lowpass.connect(delay); delay.connect(feedback); feedback.connect(delay); delay.connect(delayWet); delayWet.connect(gain);
            lowpass.connect(reverb); reverb.connect(reverbWet); reverbWet.connect(gain);
            gain.connect(pan); pan.connect(deck.gain);
          }
          this._applyPartControls(playing, true);
          source.start(when, 0);
        }
      } catch (error) { this._destroyDeck(deck); throw error; }
      return deck;
    }

    _createStream(deck, when) {
      const prepared = deck.prepared;
      // A single processor advances every stem on the same sample. Only a short
      // moving window lives on the audio thread, independent of song length.
      const node = new this._WorkletNode(this._context, "hydra-streamed-audio", {
        numberOfInputs: 0, numberOfOutputs: prepared.parts.length,
        outputChannelCount: prepared.parts.map(() => 2),
        parameterData: { playbackRate: this._controls.rate },
        processorOptions: { startTime: when, frames: prepared.frames, sourceRate: STREAM_RATE,
          chunkFrames: STREAM_SECONDS * STREAM_RATE, parts: prepared.parts.length },
      });
      const stream = deck.stream = { node, controller: new AbortController(), pending: new Set(), buffered: new Set(), serial: Promise.resolve() };
      const valid = () => !deck.disposed && !this._disposed && !stream.controller.signal.aborted;
      const fail = (error) => {
        if (deck.disposed || this._disposed) return;
        this._error = error?.message || "Audio streaming stopped. Press Play to reload the track.";
        this.stop(); this._emit("error");
      };
      const send = (chunk, preserve = false) => {
        const parts = preserve ? chunk.parts.map((channels) => channels.map((samples) => samples.slice())) : chunk.parts;
        stream.buffered.add(chunk.index);
        node.port.postMessage({ type: "chunk", index: chunk.index, parts }, parts.flat().map((samples) => samples.buffer));
      };
      node.onprocessorerror = () => fail(new Error("Audio streaming stopped. Press Play to restart the track."));
      node.port.onmessage = ({ data }) => {
        if (!valid()) return;
        if (data?.type === "underrun") { fail(new Error("Audio could not be loaded fast enough. Playback stopped to keep the stems synchronized; press Play to retry.")); return; }
        if (data?.type !== "need" || !Array.isArray(data.indices)) return;
        stream.buffered = new Set(data.buffered || []);
        for (const index of data.indices) {
          if (!Number.isInteger(index) || index < 0 || index >= Math.ceil(prepared.frames / (STREAM_SECONDS * STREAM_RATE)) || stream.pending.has(index)) continue;
          stream.pending.add(index);
          stream.serial = stream.serial.then(async () => {
            if (!valid()) return;
            const cached = prepared.initial.get(index);
            const timeout = this._setTimeout(() => fail(new Error("Loading the next audio window timed out. Playback stopped to keep the stems synchronized; press Play to retry.")), 60000);
            try {
              const chunk = cached || await this._streamChunk(prepared, index, stream.controller.signal, valid);
              if (valid()) send(chunk, Boolean(cached));
            } finally { this._clearTimeout(timeout); stream.pending.delete(index); }
          }).catch(fail);
        }
      };
      // Keep the first window available for seamless loops, including when a
      // background tab delays the next fetch. Other initial windows transfer.
      this._makeRoom(this._chunkBytes(prepared, 0));
      for (const [index, chunk] of prepared.initial) {
        send(chunk, index === 0);
        if (index !== 0) prepared.initial.delete(index);
      }
      node.port.start?.();
    }

    _streamOutput(deck, index) {
      const node = deck.stream.node;
      return { playbackRate: node.parameters.get("playbackRate"),
        connect: (target) => node.connect(target, index, 0),
        start() {}, stop() {}, disconnect() {} };
    }

    _applyPartControls(part, initial = false) {
      const set = (param, value) => { if (initial) param.value = value; else this._smooth(param, value); };
      set(part.pitch.parameters.get("pitchSemitones"), this._controls.pitch +
        (part.name === null ? 0 : this._controls.stemControls[part.name]?.pitch || 0));
      if (part.name === null) { set(part.gain.gain, 1); return; }
      const values = { ...STEM_DEFAULTS, ...this._controls.stemControls[part.name] };
      set(part.gain.gain, values.gain * (this._controls.stemGains[part.name] ?? 1));
      set(part.lowpass.frequency, Math.min(values.cutoff, this._context.sampleRate * 0.45));
      set(part.lowpass.Q, values.resonance);
      set(part.highpass.frequency, values.highpass);
      set(part.pan.pan, values.pan);
      set(part.delayWet.gain, values.delayMix);
      set(part.reverbWet.gain, values.reverbMix);
    }

    _clockAt(deck, when) {
      // The audible clock lags source automation by the processor latency.
      // Keep prior ramp segments so another live update cannot erase that past.
      let clock = deck.clock;
      for (let index = deck.clockHistory.length - 1; when < clock.time && index >= 0; index--) clock = deck.clockHistory[index];
      const elapsed = Math.max(0, when - clock.time);
      const rampTime = Math.min(clock.ramp, elapsed);
      const slope = clock.ramp ? (clock.target - clock.initial) / clock.ramp : 0;
      return { position: clock.position + clock.initial * rampTime + slope * rampTime * rampTime / 2 +
        clock.target * Math.max(0, elapsed - clock.ramp),
        rate: rampTime < clock.ramp ? clock.initial + slope * rampTime : clock.target,
        target: clock.target, rampRemaining: Math.max(0, clock.ramp - elapsed) };
    }

    _position(deck, when) { return positiveModulo(this._clockAt(deck, when).position, deck.prepared.duration); }

    _remaining(deck, when) {
      const position = this._clockAt(deck, when).position;
      return this._secondsToPosition(deck, when, position + deck.prepared.duration - positiveModulo(position, deck.prepared.duration));
    }

    _secondsToPosition(deck, when, target) {
      let state = this._clockAt(deck, when);
      let distance = Math.max(0, target - state.position);
      let cursor = Math.max(when, deck.sourceStart), pendingStart = cursor - when;
      // A delayed audible query can precede several already-known rate changes.
      // Integrate those segments before solving the final ramp to the boundary.
      for (const clock of [...deck.clockHistory, deck.clock]) {
        if (clock.time <= cursor) continue;
        const next = this._clockAt(deck, clock.time), covered = next.position - state.position;
        if (covered >= distance) break;
        distance -= covered; pendingStart += clock.time - cursor;
        cursor = clock.time; state = next;
      }
      const average = (state.rate + state.target) / 2;
      const rampDistance = average * state.rampRemaining;
      if (state.rampRemaining && distance < rampDistance) {
        const slope = (state.target - state.rate) / state.rampRemaining;
        return pendingStart + (Math.abs(slope) < 1e-8 ? distance / state.rate :
          2 * distance / (state.rate + Math.sqrt(state.rate * state.rate + 2 * slope * distance)));
      }
      return pendingStart + state.rampRemaining + (distance - rampDistance) / state.target;
    }

    _changeRate(deck, target) {
      if (deck.clock.target === target) return;
      this._clockRevision += 1;
      const when = Math.max(this._context.currentTime, deck.clock.time);
      const current = this._clockAt(deck, when);
      deck.clockHistory.push(deck.clock);
      while (deck.clockHistory.length > 1 && deck.clockHistory[1].time < when - deck.latency - RATE_RAMP - 1) deck.clockHistory.shift();
      deck.clock = { time: when, position: current.position, initial: current.rate, target, ramp: RATE_RAMP };
      const automated = new Set();
      for (const part of deck.parts) {
        // Match compensation to source-rate automation on the audio thread.
        for (const param of [part.source.playbackRate, part.pitch.parameters.get("playbackRate")]) {
          if (automated.has(param)) continue;
          automated.add(param);
          param.cancelScheduledValues(when);
          param.setValueAtTime(current.rate, when);
          param.linearRampToValueAtTime(target, when + RATE_RAMP);
        }
      }
    }

    _scheduleTransition(now) {
      const old = this._active, next = this._queued || old.prepared;
      // Detected timestamps describe the complete file. Its audio-thread loop
      // keeps that duration exact; an early crossfade would shorten every cycle.
      if (!this._queued && this._beatMap(old.prepared.track)) return;
      const reason = this._queued ? "crossfade" : "loop";
      const fade = Math.min(this.crossfadeSeconds, old.prepared.duration / this._controls.rate / 4,
        next.duration / this._controls.rate / 4);
      const remaining = this._remaining(old, now);
      if (remaining > fade + 0.2) return;
      const sourceStart = Math.max(now + 0.01, now + remaining - fade);
      const deck = this._createDeck(next, sourceStart);
      const start = sourceStart + deck.latency;
      const end = start + fade;
      deck.gain.gain.setValueAtTime(0, start);
      // Linear fades also preserve loudness for a correlated replacement (e.g.
      // the same composition after stem extraction) without a +3 dB midpoint.
      deck.gain.gain.linearRampToValueAtTime(1, end);
      old.gain.gain.cancelScheduledValues(start);
      old.gain.gain.setValueAtTime(1, start);
      old.gain.gain.linearRampToValueAtTime(0, end);
      // Destroy the silent old deck after the fade in _tick. Scheduling a
      // source stop here would make a not-yet-audible replacement impossible
      // to withdraw when the user changes the next-track prompt.
      this._queued = null;
      this._transition = { old, next: deck, start, end, promoted: false, reason };
    }

    _tick() {
      if (this._timer !== null) { this._clearTimeout(this._timer); this._timer = null; }
      if (!this._running || this._disposed) return;
      const epoch = this._epoch;
      const now = this._context.currentTime;
      const transition = this._transition;
      if (transition && now >= transition.start && !transition.promoted) {
        transition.promoted = true;
        this._active = transition.next;
        this._prepared = transition.next.prepared;
        this._emit();
        if (epoch !== this._epoch || !this._running) return;
        try { if (transition.reason !== "loop") this.onTransition(this.currentTrack, { reason: transition.reason, warnings: this.warnings }); }
        catch (error) { globalThis.console?.error("ElevenLabs player transition listener failed", error); }
        if (epoch !== this._epoch || !this._running) return;
      }
      if (transition && now >= transition.end + 0.02) {
        this._destroyDeck(transition.old);
        this._transition = null;
      }
      if (!this._transition) {
        try { this._scheduleTransition(now); }
        catch (error) { this._error = error.message; this.stop(); this._emit("error"); return; }
      }
      this._timer = this._setTimeout(() => {
        this._timer = null;
        if (epoch === this._epoch && this._running) this._tick();
      }, 80);
    }

    _destroyDeck(deck) {
      if (!deck || deck.disposed) return;
      deck.disposed = true;
      if (deck.stream) {
        deck.stream.controller.abort();
        deck.stream.node.onprocessorerror = null;
        deck.stream.node.port.onmessage = null;
        deck.stream.node.port.postMessage({ type: "dispose" });
        deck.stream.node.port.close();
        deck.stream.node.disconnect();
        deck.stream.buffered.clear();
      }
      for (const part of deck.parts) {
        try { part.source.stop(); } catch (_) { /* A scheduled source may already have stopped. */ }
        part.pitch.onprocessorerror = null;
        part.pitch.port?.postMessage({ type: "dispose" });
        part.pitch.port?.close();
        for (const node of part.nodes) node.disconnect();
      }
      deck.gain.disconnect();
    }

    stop() {
      this._epoch++;
      this._queueSequence++;
      this._running = false;
      for (const operation of this._operations) operation.controller.abort();
      if (this._timer !== null) this._clearTimeout(this._timer);
      this._timer = null;
      for (const deck of this._decks()) this._destroyDeck(deck);
      this._active = this._transition = this._queued = null;
      if (this._context) {
        this._gate.gain.cancelScheduledValues(this._context.currentTime);
        this._gate.gain.setValueAtTime(0, this._context.currentTime);
      }
      if (!this._disposed) this._emit(this._prepared ? "stopped" : "empty");
    }

    dispose() {
      if (this._disposed) return;
      this.stop();
      this._disposed = true;
      this._prepared = null;
      this._cache.clear();
      if (this._context) {
        for (const node of [this._input, this._highpass, this._lowpass, this._volume, this._gate, this._panner,
          this._limiter, this._delay, this._feedback, this._delayWet, this._reverbWet, this._convolver]) node.disconnect();
        const closing = this._context.close();
        closing?.catch?.(() => {});
      }
      this._emit("disposed");
    }
  }

  return { Player, DEFAULTS, LIMITS, STEM_DEFAULTS, readBeatMap, BEAT_TRACKING_ERROR };
})();
