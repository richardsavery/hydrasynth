"use strict";

// Generated audio is a local instrument: no provider calls originate in this player.
// Sources loop in the audio thread, so a slow generation or a throttled UI timer
// cannot leave silence between segments. Ready replacements fade in at a boundary.
globalThis.HydraElevenPlayer = (() => {
  const DEFAULTS = Object.freeze({ cutoff: 20000, resonance: 0.7, highpass: 20, gain: 0.8,
    pan: 0, rate: 1, delayMix: 0, reverbMix: 0 });
  const LIMITS = Object.freeze({ cutoff: [20, 20000], resonance: [0.1, 12], highpass: [20, 2000],
    gain: [0, 1], pan: [-1, 1], rate: [0.75, 1.25], delayMix: [0, 0.65], reverbMix: [0, 0.65] });
  const MAX_STEMS = 6;
  const RATE_RAMP = 0.08;
  const MiB = 1024 * 1024;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const bytesOf = (buffer) => buffer.length * buffer.numberOfChannels * 4;
  const positiveModulo = (value, divisor) => ((value % divisor) + divisor) % divisor;

  class Player {
    constructor(options = {}) {
      this._AudioContext = options.AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext;
      this._fetch = options.fetch || globalThis.fetch?.bind(globalThis);
      this._setTimeout = options.setTimeout || globalThis.setTimeout.bind(globalThis);
      this._clearTimeout = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
      this.onState = options.onState || (() => {});
      this.onTransition = options.onTransition || (() => {});
      this.crossfadeSeconds = clamp(Number(options.crossfadeSeconds) || 2, 0.1, 8);
      // A 60-second stereo segment at 48 kHz uses about 132 MiB for six
      // stems. Keep room for current and upcoming stems plus their full mixes.
      this.maxDecodedBytes = Math.max(MiB, Number(options.maxDecodedBytes) || 384 * MiB);
      this._cache = new Map();
      this._cacheClock = 0;
      this._operations = new Set();
      this._preparation = Promise.resolve();
      this._epoch = 0;
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
      this._controls = { ...DEFAULTS, stemGains: Object.create(null) };
    }

    get status() { return this._status; }
    get currentTrack() { return (this._active?.prepared || this._prepared)?.track || null; }
    get queuedTrack() { return this._queued?.track || (!this._transition?.promoted && this._transition?.next.prepared.track) || null; }
    get duration() { return (this._active?.prepared || this._prepared)?.duration || 0; }
    get currentPosition() { return this._active ? this._position(this._active, this._context.currentTime) : 0; }
    get remainingSeconds() { return this._active ? this._remaining(this._active, this._context.currentTime) : this.duration / this._controls.rate; }
    get stemNames() { return (this._active?.prepared || this._prepared)?.parts.filter((part) => part.name !== null).map((part) => part.name) || []; }
    get warnings() { return [...((this._active?.prepared || this._prepared)?.warnings || [])]; }
    get sourceValid() { return this._valid; }
    get controls() { return { ...this._controls, stemGains: { ...this._controls.stemGains } }; }
    get decodedBytes() { return [...this._cache.values()].reduce((total, entry) => total + entry.bytes, 0); }

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
      this._feedback.gain.value = 0.22;
      this._delayWet = ctx.createGain();
      this._reverbWet = ctx.createGain();
      this._convolver = ctx.createConvolver();
      const impulse = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * 1.2), ctx.sampleRate);
      let random = 12345;
      for (let channel = 0; channel < 2; channel++) {
        const samples = impulse.getChannelData(channel);
        for (let i = 0; i < samples.length; i++) {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          samples[i] = (random / 2147483648 - 1) * Math.pow(1 - i / samples.length, 3);
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
        // Only six stems can be active, and unrelated names cannot grow state forever.
        const next = Object.create(null);
        for (const [name, value] of Object.entries(values.stemGains).slice(0, MAX_STEMS)) {
          if (Number.isFinite(Number(value))) next[name] = clamp(Number(value), 0, 1);
        }
        this._controls.stemGains = next;
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
          for (const part of deck.parts) this._smooth(part.gain.gain, part.name === null ? 1 : (this._controls.stemGains[part.name] ?? 1));
        }
      }
      return this.controls;
    }

    setSourceValid(valid) {
      const changed = this._valid !== Boolean(valid);
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

    async _prepare(track, operation) {
      this._assertValid(operation);
      if (!track || typeof track !== "object") throw new Error("Choose a saved generated track first.");
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
          prepared.warnings.push(`Playing the original mix because the stems could not be prepared: ${error.message}`);
        }
      }
      return prepared;
    }

    _prepareSerial(track, operation) {
      // Audio decoding cannot be aborted. Serialize preparations to cap outstanding
      // decodes even if a user selects several tracks and stops in quick succession.
      const task = this._preparation.then(() => this._prepare(track, operation));
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
        const prepared = await this._prepareSerial(track, operation);
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

    async queueTrack(track) {
      if (this._disposed) throw new Error("This audio player has been disposed.");
      if (!this._prepared) return this.loadTrack(track);
      this._queueSequence++;
      for (const operation of this._operations) if (operation.queue) operation.controller.abort();
      this._queued = null;
      const operation = this._newOperation(true);
      try {
        const prepared = await this._prepareSerial(track, operation);
        this._assertValid(operation);
        this._queued = prepared;
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

    async start() {
      const ctx = this._ensureContext();
      const epoch = this._epoch;
      // Call resume synchronously from the click handler, before awaiting work.
      await ctx.resume();
      if (this._disposed || epoch !== this._epoch) return false;
      if (this._running) return true;
      if (!this._prepared) throw new Error("Load a saved track before starting playback.");
      this._running = true;
      this._error = null;
      const when = ctx.currentTime + 0.02;
      this._active = this._createDeck(this._prepared, when);
      this._active.gain.gain.setValueAtTime(0, when);
      this._active.gain.gain.linearRampToValueAtTime(1, when + 0.03);
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
      const deck = { prepared, gain: ctx.createGain(), parts: [], disposed: false,
        clock: { time: when, position: 0, initial: this._controls.rate, target: this._controls.rate, ramp: 0 } };
      deck.gain.connect(this._input);
      try {
        for (const part of prepared.parts) {
          const source = ctx.createBufferSource(), gain = ctx.createGain();
          source.buffer = part.buffer;
          source.loop = true;
          source.loopStart = 0;
          source.loopEnd = prepared.duration;
          source.playbackRate.setValueAtTime(this._controls.rate, when);
          gain.gain.value = part.name === null ? 1 : (this._controls.stemGains[part.name] ?? 1);
          source.connect(gain);
          gain.connect(deck.gain);
          deck.parts.push({ name: part.name, source, gain });
          source.start(when, 0);
        }
      } catch (error) { this._destroyDeck(deck); throw error; }
      return deck;
    }

    _clockAt(deck, when) {
      const clock = deck.clock, elapsed = Math.max(0, when - clock.time);
      const rampTime = Math.min(clock.ramp, elapsed);
      const slope = clock.ramp ? (clock.target - clock.initial) / clock.ramp : 0;
      return { position: clock.position + clock.initial * rampTime + slope * rampTime * rampTime / 2 +
        clock.target * Math.max(0, elapsed - clock.ramp),
        rate: rampTime < clock.ramp ? clock.initial + slope * rampTime : clock.target,
        rampRemaining: Math.max(0, clock.ramp - elapsed) };
    }

    _position(deck, when) { return positiveModulo(this._clockAt(deck, when).position, deck.prepared.duration); }

    _remaining(deck, when) {
      const state = this._clockAt(deck, when);
      const distance = deck.prepared.duration - positiveModulo(state.position, deck.prepared.duration);
      const pendingStart = Math.max(0, deck.clock.time - when);
      const average = (state.rate + deck.clock.target) / 2;
      const rampDistance = average * state.rampRemaining;
      if (state.rampRemaining && distance < rampDistance) {
        const slope = (deck.clock.target - state.rate) / state.rampRemaining;
        return pendingStart + (Math.abs(slope) < 1e-8 ? distance / state.rate :
          2 * distance / (state.rate + Math.sqrt(state.rate * state.rate + 2 * slope * distance)));
      }
      return pendingStart + state.rampRemaining + (distance - rampDistance) / deck.clock.target;
    }

    _changeRate(deck, target) {
      if (deck.clock.target === target) return;
      const when = Math.max(this._context.currentTime, deck.clock.time);
      const current = this._clockAt(deck, when);
      deck.clock = { time: when, position: current.position, initial: current.rate, target, ramp: RATE_RAMP };
      for (const part of deck.parts) {
        part.source.playbackRate.cancelScheduledValues(when);
        part.source.playbackRate.setValueAtTime(current.rate, when);
        part.source.playbackRate.linearRampToValueAtTime(target, when + RATE_RAMP);
      }
    }

    _scheduleTransition(now) {
      const old = this._active, next = this._queued || old.prepared;
      const reason = this._queued ? "crossfade" : "loop";
      const fade = Math.min(this.crossfadeSeconds, old.prepared.duration / this._controls.rate / 4,
        next.duration / this._controls.rate / 4);
      const remaining = this._remaining(old, now);
      if (remaining > fade + 0.2) return;
      const start = Math.max(now + 0.01, now + remaining - fade);
      const end = start + fade;
      const deck = this._createDeck(next, start);
      deck.gain.gain.setValueAtTime(0, start);
      // Linear fades also preserve loudness for a correlated replacement (e.g.
      // the same composition after stem extraction) without a +3 dB midpoint.
      deck.gain.gain.linearRampToValueAtTime(1, end);
      old.gain.gain.cancelScheduledValues(start);
      old.gain.gain.setValueAtTime(1, start);
      old.gain.gain.linearRampToValueAtTime(0, end);
      for (const part of old.parts) part.source.stop(end + 0.01);
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
      if (!this._transition) this._scheduleTransition(now);
      this._timer = this._setTimeout(() => {
        this._timer = null;
        if (epoch === this._epoch && this._running) this._tick();
      }, 80);
    }

    _destroyDeck(deck) {
      if (!deck || deck.disposed) return;
      deck.disposed = true;
      for (const part of deck.parts) {
        try { part.source.stop(); } catch (_) { /* A scheduled source may already have stopped. */ }
        part.source.disconnect();
        part.gain.disconnect();
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

  return { Player, DEFAULTS, LIMITS };
})();
