"use strict";

// Exercise the real UI with controllable HTTP, microphone, storage and audio boundaries.
// These tests do not contact ElevenLabs or create paid generations.
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const clone = value => JSON.parse(JSON.stringify(value));
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const decoded = (rate = 48000, duration = .1, channels = 1, sample = .5) => ({ sampleRate: rate, length: Math.round(rate * duration), numberOfChannels: channels,
  getChannelData() { return new Float32Array(Math.round(rate * duration)).fill(sample); } });
const responseJob = (extra = {}) => ({ id: "response-one", request_id: "request-one", state: "complete", transcript: "I missed the bus", lyrics: "Still in the race\nSet your own pace",
  bpm: 95, style: "boom_bap", bars: 4, audio_url: "/api/rap-response/responses/response-one/audio", ...extra });

function fixture(options = {}) {
  const elements = new Map(), requests = [], contexts = [], timers = new Map(), recorders = [], jobs = new Map(), storage = new Map();
  let timerId = 0, requestId = 0, listens = 0, plays = 0, microphoneCalls = 0;
  if (!options.fresh) storage.set("hydra.rap-response.v1", JSON.stringify({ output_mode: "mix", ...options.saved }));
  const listenOptions = [], playOptions = [];
  const stream = { tracks: [{ stopped: 0, stop() { this.stopped++; } }], getTracks() { return this.tracks; } };
  const el = key => {
    if (!elements.has(key)) elements.set(key, { value: "", checked: false, disabled: false, textContent: "", innerHTML: "", hidden: false, handlers: {},
      attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
      classList: { add() {}, toggle() {} }, addEventListener(type, handler) { this.handlers[type] = handler; } });
    return elements.get(key);
  };
  class AudioContext {
    constructor() { this.state = "running"; this.currentTime = 10; this.destination = {}; this.sources = []; this.gains = []; contexts.push(this); }
    async resume() { if (options.resume) return options.resume(this); this.state = "running"; }
    async decodeAudioData(bytes) { return options.decode ? options.decode(bytes) : decoded(); }
    createGain() { const gain = { gain: { value: 1 }, connect(destination) { this.destination = destination; }, disconnect() { this.disconnected = true; } }; this.gains.push(gain); return gain; }
    createBufferSource() { const source = { started: false, stopped: false, connect(destination) { this.destination = destination; }, disconnect() {},
      start(at) { this.started = true; this.at = at; }, stop() { this.stopped = true; } }; this.sources.push(source); return source; }
  }
  const backing = options.backing ? { context: new AudioContext(), destination: {}, bpm: 100, beat: 0, at: 9, token: "main-track-1", valid: true, playing: true, rateChanging: false, ...options.backing } : null;
  class MediaRecorder {
    static isTypeSupported(type) { return type === (options.mimeType || "audio/webm;codecs=opus"); }
    constructor(s, config = {}) { if (options.recorderError) throw new Error("Recorder unavailable"); this.stream = s; this.mimeType = config.mimeType || "audio/webm"; this.state = "inactive"; recorders.push(this); }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["microphone data"]) }); this.onstop?.();
    }
  }
  const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value, arrayBuffer: async () => new ArrayBuffer(8) });
  const box = vm.createContext({ console, AbortController, AudioContext, MediaRecorder, Blob, ArrayBuffer, DataView, Uint8Array, Float32Array, HydraStudy: options.study,
    btoa: text => Buffer.from(text, "binary").toString("base64"), crypto: { randomUUID: () => `request-${++requestId}` },
    navigator: { mediaDevices: { async getUserMedia() { microphoneCalls++; return options.getUserMedia ? options.getUserMedia() : stream; } } },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; }, clearTimeout(id) { timers.delete(id); },
    async fetch(url, init = {}) {
      const req = { url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null, signal: init.signal, headers: init.headers || {} }; requests.push(req);
      if (options.fetch) { const result = await options.fetch(req, response); if (result !== undefined) return result; }
      if (url.endsWith("/status")) return response({ ready: true, defaults: { bpm: 95, style: "boom_bap", bars: 4 } });
      if (url.endsWith("/audio") || url.startsWith("/rap-voice-demos/")) return response(null);
      if (req.method === "POST" && url.endsWith("/cancel")) {
        const found = jobs.get(url.split("/").at(-2)) || responseJob(); const job = { ...found, state: "cancelled" }; jobs.set(job.id, job); return response(job);
      }
      if (req.method === "POST" && url.endsWith("/vocals")) { const job = responseJob({ output_mode: "vocals", vocal_state: "complete", vocal_audio_url: "/api/rap-response/responses/response-one/vocals/audio" }); jobs.set(job.id, job); return response(job); }
      if (req.method === "POST" && url.endsWith("/effects")) {
        const parent = jobs.get(url.split("/").at(-2)) || responseJob();
        const job = { ...parent, ...req.body, id: "response-effects", source_response_id: parent.id, state: "complete", can_apply_effects: true,
          audio_url: "/api/rap-response/responses/response-effects/audio", vocal_state: "complete", vocal_audio_url: "/api/rap-response/responses/response-effects/vocals/audio" };
        jobs.set(job.id, job); return response(job);
      }
      if (req.method === "POST") { const job = responseJob({ ...req.body, ...options.newJob }); jobs.set(job.id, job); return response(job); }
      if (url.endsWith("/responses")) return response({ responses: options.library || [...jobs.values()] });
      if (url.includes("/requests/")) return response([...jobs.values()].find(job => job.request_id === url.split("/").at(-1)) || { error: "Not found" },
        [...jobs.values()].some(job => job.request_id === url.split("/").at(-1)) ? 200 : 404);
      return response(jobs.get(url.split("/").at(-1)) || responseJob());
    }
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/../dashboard/rap.js`, "utf8"), box, { filename: "rap.js" });
  vm.runInContext(fs.readFileSync(`${__dirname}/../dashboard/rap-response.js`, "utf8"), box, { filename: "rap-response.js" });
  const panel = box.HydraRapResponse;
  const container = { classList: { add() {} }, innerHTML: "", querySelector: selector => el(selector.slice(9, -1)) };
  panel.init({ container,
    onBeforeListen(value) { listens++; listenOptions.push(value); options.beforeListen?.(value); }, onBeforePlay(value) { plays++; playOptions.push(value); options.beforePlay?.(value); }, getBackingClock: () => backing, unlockBacking: async () => options.unlockBacking?.(backing, AudioContext) });
  return { panel, box, el, container, stream, recorders, requests, contexts, timers, jobs, storage, backing, listenOptions, playOptions,
    event: (key, type = "click") => el(key).handlers[type](),
    get microphoneCalls() { return microphoneCalls; }, get listens() { return listens; }, get plays() { return plays; },
    get sources() { return contexts.flatMap(context => context.sources); },
    async timer(delay) { const found = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(found, `expected ${delay}ms timer`); timers.delete(found[0]); await found[1].callback(); await settle(); }
  };
}

async function main() {
  {
    const h = fixture(), previous = h.storage.get("hydra.rap-response.v1");
    const quota = new Error("Browser storage is full");
    h.box.localStorage.setItem = () => { throw quota; };
    h.el("text").value = "The latest unsaved words";
    assert.doesNotThrow(() => h.event("text", "input"), "ordinary editing still works when autosave fails");
    assert.equal(h.panel.getState().text, "The latest unsaved words");
    assert.equal(h.storage.get("hydra.rap-response.v1"), previous);
    assert.throws(() => h.panel.flush({ strict: true }), error => error === quota,
      "explicit session capture must fail instead of snapshotting an older prompt");
    h.box.localStorage.setItem = (key, value) => h.storage.set(key, value);
    h.panel.flush({ strict: true });
    assert.equal(JSON.parse(h.storage.get("hydra.rap-response.v1")).text, "The latest unsaved words");
  }
  {
    const h = fixture({ fetch: (req, response) => req.url.endsWith("/status") ? response({ ready: false, transcription_ready: false }) : undefined });
    await h.panel.activate();
    assert.equal(h.requests.some(req => req.url.startsWith("/rap-voice-demos/")), false, "mounting does not preload demos");
    assert.equal(h.sources.length, 0, "mounting never autoplays demos");
    h.el("voice").value = "warren"; h.event("voice", "change");
    h.el("pitch").value = "12"; h.el("autotune").value = "100";
    const originalState = clone(h.panel.getState());
    for (const [voice, name] of [["eva", "Eva"], ["cold_android", "Cold Android"], ["peter", "Peter"], ["elowen", "Elowen"], ["maisie", "Maisie"], ["warren", "Warren"]]) {
      const button = h.el(`demo-${voice}`);
      assert.equal(button.disabled, false, "demos work without generation or transcription configuration");
      await h.event(`demo-${voice}`);
      assert.equal(h.requests.at(-1).url, `/rap-voice-demos/${voice}.wav`);
      assert.equal(button.textContent, `Stop ${name}`); assert.equal(button.attributes["aria-pressed"], "true");
      assert.equal(h.sources.filter(source => source.started && !source.stopped).length, 1, "switching demos keeps one audio source");
      assert.equal(h.sources.at(-1).buffer.numberOfChannels, 1);
      assert.equal(h.sources.at(-1).destination.gain.value, .85, "demos use the rap volume");
      assert.equal(h.sources.at(-1).destination.destination, h.contexts[0].destination, "demos play without a backing transport");
    }
    assert.equal(h.plays, 0, "preview does not ask the main mixers to stop");
    assert.deepEqual(clone(h.panel.getState()), originalState, "preview leaves voice choices and persisted settings unchanged");
    assert.equal(h.requests.some(req => req.method === "POST"), false, "all demo requests are static reads, with no generation calls");
    h.el("volume").value = "0.25"; h.event("volume", "input");
    assert.equal(h.sources.at(-1).destination.gain.value, .25, "changing rap volume also changes the playing demo");
    await h.event("demo-warren"); assert.equal(h.sources.at(-1).stopped, true); assert.match(h.el("demo-status").textContent, /stopped/);
    assert.equal(h.el("demo-warren").textContent, "Play Warren"); h.panel.deactivate(); assert.equal(h.timers.size, 0);
  }
  {
    let session = "demo-session-original"; const events = [];
    const h = fixture({ study: { getContext: () => ({ session_id: session, client_id: "demo-client" }), emit: (type, payload) => events.push({ type, payload: clone(payload) }) } });
    await h.panel.activate(); await h.event("demo-eva"); session = "demo-session-new";
    h.contexts[0].currentTime += .05; await h.event("demo-eva");
    const playbackEvents = events.filter(event => event.type.startsWith("rap.demo."));
    assert.deepEqual(playbackEvents.map(event => event.type), ["rap.demo.requested", "rap.demo.started", "rap.demo.stopped"]);
    for (const event of playbackEvents) {
      assert.equal(event.payload.session_id, "demo-session-original", "the whole demo belongs to the participant who requested it");
      assert.equal(event.payload.voice, "eva"); assert.equal(event.payload.label, "Eva");
      assert.equal(event.payload.audio_url, "/rap-voice-demos/eva.wav"); assert.equal(event.payload.demo_set, "contrasting-voices-2026-10-19");
      assert.equal(Object.hasOwn(event.payload, "job_id"), false, "a demo is not attributed to a generated rap job");
    }
    assert.equal(playbackEvents[1].payload.duration_seconds, .1);
    assert.ok(Math.abs(playbackEvents[2].payload.listened_seconds - .05) < .00001);
    await h.event("demo-peter"); h.contexts[0].currentTime += .2; h.sources.at(-1).onended();
    const ended = events.find(event => event.type === "rap.demo.ended");
    assert.equal(ended.payload.session_id, "demo-session-new"); assert.equal(ended.payload.listened_seconds, .1, "listening duration is capped at the clip length");
    assert.equal(h.el("demo-peter").attributes["aria-pressed"], "false");
    assert.equal(events.filter(event => event.type === "rap.demo.stopped").length, 1, "natural completion emits ended without a duplicate stopped event"); h.panel.deactivate();
  }
  {
    let decoding = 0; const slow = defer(), h = fixture({ decode: () => ++decoding === 1 ? slow.promise : decoded() });
    await h.panel.activate(); const first = h.event("demo-eva"); await settle();
    assert.equal(h.el("demo-eva").textContent, "Cancel Eva"); await h.event("demo-warren");
    slow.resolve(decoded()); await first;
    assert.equal(h.sources.length, 1, "a superseded decode cannot start after the next demo");
    assert.equal(h.el("demo-warren").textContent, "Stop Warren");
    assert.equal(h.requests.find(req => req.url === "/rap-voice-demos/eva.wav").signal.aborted, true); h.panel.deactivate();
  }
  for (const action of ["stop", "leave", "record", "generate", "apply-effects", "play"]) {
    const slow = defer(), h = fixture({ saved: { response_id: "response-one", auto_play: false }, newJob: { can_apply_effects: true },
      fetch: (req, response) => req.url.endsWith("/response-one") ? response(responseJob({ can_apply_effects: true })) : undefined,
      decode: () => slow.promise });
    await h.panel.activate(); const first = h.event("demo-eva"); await settle();
    if (action === "stop") await h.event("demo-eva");
    else if (action === "leave") h.panel.deactivate();
    else if (action === "generate") { h.el("text").value = "A different request"; await h.event("generate"); }
    else if (action === "play") { void h.event("play"); await settle(); }
    else await h.event(action);
    slow.resolve(decoded()); await first; await settle();
    assert.equal(h.el("demo-eva").textContent, "Play Eva", `${action} clears the pending demo`);
    assert.equal(h.sources.length, action === "play" ? 1 : 0, `${action} prevents late demo playback`);
    if (action === "record") {
      assert.equal(h.microphoneCalls, 1); assert.equal(h.el("demo-warren").disabled, true);
      await h.event("demo-warren"); assert.equal(h.requests.filter(req => req.url.startsWith("/rap-voice-demos/")).length, 1, "recording blocks demo playback");
    }
    h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { response_id: "response-one" } }); await h.panel.activate();
    await h.event("play"); const rap = h.sources.at(-1); await h.event("demo-maisie");
    assert.equal(rap.stopped, true, "a demo stops current rap playback"); const preview = h.sources.at(-1);
    await h.event("play"); assert.equal(preview.stopped, true, "rap playback stops a playing demo");
    await h.event("demo-eva"); const beforeRecording = h.sources.at(-1); await h.event("record");
    assert.equal(beforeRecording.stopped, true, "a playing demo stops before microphone capture"); h.panel.deactivate();
  }
  {
    const events = [], h = fixture({ study: { emit: (type, payload) => events.push({ type, payload: clone(payload) }) },
      fetch: (req, response) => req.url.startsWith("/rap-voice-demos/") ? response({}, 404) : undefined });
    await h.panel.activate(); await h.event("demo-elowen");
    assert.match(h.el("demo-status").textContent, /Elowen demo could not be loaded/);
    assert.equal(h.el("demo-elowen").textContent, "Play Elowen"); assert.equal(h.sources.length, 0);
    assert.equal(events.filter(event => event.type === "rap.demo.failed").length, 1); assert.equal(h.requests.some(req => req.method === "POST"), false);
    h.panel.deactivate();
  }
  {
    const h = fixture(), encode = h.panel.pcm16Wav, bytes = encode(decoded(48000, .1, 2, .5)), view = new DataView(bytes);
    assert.equal(Buffer.from(bytes).subarray(0, 4).toString(), "RIFF"); assert.equal(view.getUint16(22, true), 1); assert.equal(view.getUint32(24, true), 16000);
    assert.equal(view.getUint16(34, true), 16); assert.equal(bytes.byteLength, 44 + 1600 * 2); assert.equal(view.getInt16(44, true), 16384);
    const clipping = new DataView(encode(decoded(16000, .1, 1, -2))); assert.equal(clipping.getInt16(44, true), -32768);
    assert.equal(new DataView(encode(decoded(16000, .1, 1, NaN))).getInt16(44, true), 0);
    const stereo = decoded(16000, .1, 2); stereo.getChannelData = channel => new Float32Array(1600).fill(channel ? -1 : 1);
    assert.equal(new DataView(encode(stereo)).getInt16(44, true), 0, "channels are downmixed before PCM encoding");
    assert.equal(encode(decoded(48000, 30.1)).byteLength, 960044, "small stop latency is trimmed to the 30-second upload cap");
    assert.throws(() => encode(decoded(48000, 32)), /30 seconds/); assert.throws(() => encode(decoded(0)), /30 seconds/);
    assert.throws(() => encode(decoded(48000, .099)), /too short/, "recording must meet the transcription endpoint's minimum duration");
    assert.equal(encode(decoded(44100, .1)).byteLength, 3244, "noninteger resampling ratio preserves duration");
  }
  {
    const h = fixture({ saved: { response_id: "response-one", auto_play: true } }); await h.panel.activate();
    assert.equal(h.microphoneCalls, 0); assert.equal(h.sources.length, 0); assert.equal(h.requests.some(req => req.method === "POST"), false);
    assert.equal(h.el("play").disabled, false); await h.event("play"); assert.equal(h.sources.length, 1); assert.equal(h.plays, 1);
    await h.event("play"); assert.equal(h.sources.length, 2); assert.equal(h.sources[0].stopped, true); assert.equal(h.requests.some(req => req.method === "POST"), false);
    h.jobs.set("response-two", responseJob({ id: "response-two", transcript: "A second message" }));
    h.el("saved").value = "response-two"; await h.event("saved", "change"); assert.equal(h.panel.getState().response_id, "response-two");
    assert.equal(h.el("transcript").textContent, "A second message"); assert.equal(h.sources.length, 2, "selecting a saved mix remains silent");
    assert.equal(h.sources[1].stopped, true, "selecting another saved response stops the previous mix");
    assert.match(h.el("result-label").textContent, /Original generated voice/, "legacy performances are not labelled with the new draft voice");
    h.panel.deactivate(); assert.equal(h.sources[1].stopped, true); assert.equal(h.timers.size, 0);
  }
  {
    const loading = defer(), h = fixture({ fetch: req => req.url.endsWith("/response-two") ? loading.promise : undefined });
    await h.panel.activate(); h.el("saved").value = "response-two"; const selection = h.event("saved", "change"); await settle();
    h.el("saved").value = ""; await h.event("saved", "change");
    loading.resolve({ ok: true, json: async () => responseJob({ id: "response-two" }) }); await selection;
    assert.equal(h.panel.getState().response_id, "", "clearing the selection invalidates an earlier in-flight saved response");
    assert.equal(h.el("play").disabled, true); h.panel.deactivate();
  }
  {
    const h = fixture({ fetch: (req, response) => req.url.endsWith("/status") ? response({ ready: true, transcription_ready: false, transcription_issues: ["Local Whisper small is not ready."] }) : undefined });
    await h.panel.activate(); assert.equal(h.el("record").disabled, true); assert.match(h.el("microphone").textContent, /Whisper small/);
    await h.event("record"); assert.equal(h.microphoneCalls, 0, "microphone capture needs the separate local transcription service");
    h.el("text").value = "Typing still works"; h.event("text", "input"); assert.equal(h.el("generate").disabled, false);
    await h.event("generate"); await settle(); assert.equal(h.requests.filter(req => req.method === "POST").length, 1); h.panel.deactivate();
  }
  {
    const configuration = defer(), listing = defer(), creating = defer();
    const h = fixture({ fetch: req => {
      if (req.url.endsWith("/status")) return configuration.promise;
      if (req.url.endsWith("/responses")) return req.method === "POST" ? creating.promise : listing.promise;
    } });
    const opening = h.panel.activate(); h.el("text").value = "Before loading finishes"; const submission = h.event("generate"); await settle();
    configuration.resolve({ ok: true, json: async () => ({ ready: true }) }); listing.resolve({ ok: true, json: async () => ({ responses: [] }) }); await opening;
    assert.equal(h.requests.some(req => req.url.includes("/requests/")), false, "late initial loading cannot start recovery over an explicit submission");
    creating.resolve({ ok: true, json: async () => responseJob({ request_id: "request-1" }) }); await submission; await settle();
    assert.equal(h.sources.length, 1, "initial loading cannot disarm an explicit new response"); assert.equal(h.panel.getState().pending, null); h.panel.deactivate();
  }
  {
    const h = fixture(); await h.panel.activate(); h.el("text").value = "I missed the bus"; await h.event("generate"); await settle();
    const submitted = h.requests.find(req => req.method === "POST"); assert.equal(submitted.body.text, "I missed the bus"); assert.equal(submitted.body.bpm, 95);
    assert.equal(submitted.body.voice, "eva", "new requests use the first auditioned voice"); assert.equal(submitted.body.vocal_preset, "");
    assert.match(h.el("result-label").textContent, /Eva/); assert.match(h.el("saved").innerHTML, /Eva/);
    assert.equal(h.sources.length, 1, "an explicit new response may autoplay the full mix");
    assert.equal(h.el("lyrics").textContent, "Still in the race\nSet your own pace"); assert.match(h.el("download").href, /\/audio$/);
    h.panel.deactivate();
  }
  {
    const h = fixture(); await h.panel.activate();
    for (const [voice, name] of [["eva", "Eva"], ["cold_android", "Cold Android"], ["peter", "Peter"], ["elowen", "Elowen"], ["maisie", "Maisie"], ["warren", "Warren"]]) {
      assert.ok(h.container.innerHTML.includes(`<option value="${voice}">${name}</option>`));
      h.el("voice").value = voice; h.event("voice", "change"); h.el("text").value = `A reply from ${name}`;
      await h.event("generate"); await settle();
      assert.equal(h.requests.filter(req => req.method === "POST").at(-1).body.voice, voice);
      assert.ok(h.el("result-label").textContent.startsWith(`${name} ·`));
    }
    assert.equal(h.container.innerHTML.includes("Voice experiments"), false); h.panel.deactivate();
  }
  {
    const events = [], h = fixture({ study: { getContext: () => ({ session_id: "session-direct" }), emit: (type, payload) => events.push({ type, payload: clone(payload) }) } });
    await h.panel.activate(); h.el("text-mode").value = "lyrics"; h.event("text-mode", "change");
    assert.equal(h.el("record-row").hidden, true); assert.equal(h.el("record").disabled, true);
    await h.event("record"); assert.equal(h.microphoneCalls, 0, "direct lyrics never open the microphone");
    assert.equal(h.el("generate").textContent, "Rap my words");
    h.el("text").value = Array(49).fill("word").join(" "); await h.event("generate");
    assert.equal(h.requests.some(req => req.method === "POST"), false, "oversized direct lyrics are rejected before generation");
    assert.match(h.el("status").textContent, /48 words/);
    h.el("bars").value = "8"; h.event("bars", "change");
    const lyrics = "I choose my words, keep every line.\n  Leave this beat and rhythm mine!";
    h.el("text").value = lyrics; h.el("voice").value = "maisie";
    h.el("pitch").value = "-3"; h.el("autotune").value = "65"; h.el("key").value = "5"; h.el("scale").value = "major";
    h.el("melody").value = "hook"; h.el("octave").value = "4"; h.el("note-beats").value = "0.5";
    await h.event("generate"); await settle();
    const body = h.requests.find(req => req.method === "POST").body;
    assert.equal(body.text, lyrics, "direct lyrics retain punctuation, spacing and line breaks"); assert.equal(body.text_mode, "lyrics");
    const effectSettings = { autotune_amount: .65, pitch_semitones: -3, key: 5, scale: "major", melody: "hook", octave: 4, note_beats: .5 };
    assert.deepEqual(body.effects, effectSettings);
    const submitted = events.find(event => event.type === "rap.response.submitted").payload;
    assert.equal(submitted.voice, "maisie"); assert.equal(submitted.text_mode, "lyrics"); assert.deepEqual(submitted.effects, effectSettings);
    const saved = JSON.parse(h.storage.get("hydra.rap-response.v1")); h.panel.deactivate();
    const restored = fixture({ saved }); await restored.panel.activate();
    assert.equal(restored.el("text-mode").value, "lyrics"); assert.equal(restored.el("voice").value, "maisie");
    assert.deepEqual(clone(restored.panel.getState().effects), effectSettings); assert.equal(restored.requests.some(req => req.method === "POST"), false);
    assert.equal(restored.sources.length, 0, "restoring voice customization is silent");
    restored.event("reset-effects"); assert.equal(restored.el("pitch").value, "0"); assert.equal(restored.el("autotune").value, "0");
    restored.el("text-mode").value = "reply"; restored.event("text-mode", "change"); assert.equal(restored.el("record-row").hidden, false); restored.panel.deactivate();
  }
  for (const state of ["converting", "rendering"]) {
    const h = fixture({ newJob: { state } }); await h.panel.activate(); h.el("text").value = "Keep the voice settings"; await h.event("generate");
    assert.equal(h.el("voice").disabled, true); assert.equal(h.el("pitch").disabled, true); assert.equal(h.el("text-mode").disabled, true);
    assert.ok(h.panel.getState().pending); assert.match(h.el("status").textContent, state === "converting" ? /chosen voice/ : /voice settings/); h.panel.deactivate();
  }
  {
    let session = "session-original"; const events = [];
    const h = fixture({ study: { getContext: () => ({ session_id: session, client_id: "study-client" }), emit: (type, payload) => events.push({ type, payload: clone(payload) }) }, newJob: { can_apply_effects: true } });
    await h.panel.activate(); h.el("text").value = "Keep this performance"; h.el("voice").value = "peter"; await h.event("generate"); await settle();
    assert.equal(h.el("apply-effects").disabled, false); session = "session-effects";
    h.el("voice").value = "warren"; h.el("pitch").value = "5"; h.el("autotune").value = "100";
    await h.event("apply-effects"); await settle();
    const posts = h.requests.filter(req => req.method === "POST"); assert.equal(posts.length, 2); assert.equal(posts[1].url, "/api/rap-response/responses/response-one/effects");
    assert.deepEqual(Object.keys(posts[1].body).sort(), ["effects", "request_id"]); assert.equal(posts[1].body.effects.pitch_semitones, 5);
    assert.equal(posts[1].headers["X-Study-Session"], "session-effects", "new effects child belongs to the current participant");
    assert.match(h.el("result-label").textContent, /^Peter ·/, "effects retain the saved voice rather than applying the new-rap selector");
    assert.match(h.el("result-label").textContent, /Pitch \+5/); assert.equal(h.panel.getState().response_id, "response-effects");
    const event = events.find(event => event.type === "rap.effects.submitted").payload;
    assert.equal(event.source_response_id, "response-one"); assert.equal(event.session_id, "session-effects"); assert.equal(event.voice, "peter"); h.panel.deactivate();
  }
  {
    let fail = true; const h = fixture({ newJob: { can_apply_effects: true }, fetch: req => { if (req.url.endsWith("/effects") && fail) { fail = false; throw new Error("Connection lost"); } } });
    await h.panel.activate(); h.el("text").value = "Reuse this voice"; await h.event("generate"); await settle();
    h.el("pitch").value = "-6"; await h.event("apply-effects");
    const original = clone(h.requests.find(req => req.url.endsWith("/effects")).body), saved = JSON.parse(h.storage.get("hydra.rap-response.v1"));
    assert.equal(saved.pending.effects_source_id, "response-one"); assert.equal(saved.pending.effects.pitch_semitones, -6);
    h.panel.deactivate(); const restored = fixture({ saved }); await restored.panel.activate();
    assert.equal(restored.requests.some(req => req.method === "POST"), false, "restoring an uncertain effects request is passive");
    restored.el("pitch").value = "10"; await restored.event("generate"); await settle();
    const retry = restored.requests.filter(req => req.method === "POST"); assert.equal(retry.length, 1);
    assert.equal(retry[0].url, "/api/rap-response/responses/response-one/effects", "effects recovery never falls back to a paid rap generation");
    assert.deepEqual(retry[0].body, original, "effects retry preserves its original request ID and effect settings"); restored.panel.deactivate();
  }
  for (const action of ["stop", "uncheck", "leave"]) {
    const waiting = defer(); const h = fixture({ fetch: req => req.method === "POST" ? waiting.promise : undefined });
    await h.panel.activate(); h.el("text").value = "A new day"; const task = h.event("generate"); await settle();
    if (action === "stop") h.panel.stop();
    if (action === "uncheck") { h.el("auto").checked = false; h.event("auto", "change"); }
    if (action === "leave") h.panel.deactivate();
    waiting.resolve({ ok: true, json: async () => responseJob({ request_id: "request-1" }) }); await task; await settle();
    assert.equal(h.sources.length, 0, `${action} disarms delayed autoplay`); h.panel.deactivate();
  }
  {
    let failure = true;
    const h = fixture({ fetch: req => { if (req.method === "POST" && failure) { failure = false; throw new Error("Connection lost"); } } });
    await h.panel.activate(); h.el("text").value = "Original message"; h.el("bpm").value = "110"; h.el("voice").value = "elowen"; h.el("pitch").value = "-4"; h.el("autotune").value = "70"; await h.event("generate");
    const original = clone(h.requests.find(req => req.method === "POST").body); assert.ok(h.panel.getState().pending);
    assert.equal(original.voice, "elowen"); assert.equal(h.panel.getState().pending.voice, "elowen"); assert.equal(h.el("voice").disabled, true);
    h.el("text").value = "Edited draft"; h.el("bpm").value = "90"; h.el("voice").value = "eva"; h.el("pitch").value = "8"; h.el("autotune").value = "0"; await h.event("generate"); await settle();
    assert.deepEqual(h.requests.filter(req => req.method === "POST").map(req => req.body), [original, original], "an explicit retry uses the original id and payload");
    assert.equal(h.panel.getState().text, "Edited draft"); h.panel.deactivate();
  }
  {
    const saved = { text: "Draft", auto_play: true, pending: { request_id: "request-accepted", text: "Original", bpm: 108, bars: 8, style: "trap" } };
    const h = fixture({ saved, fetch: (req, response) => req.url.includes("/requests/") ? response(responseJob({ request_id: "request-accepted" })) : undefined });
    await h.panel.activate(); assert.equal(h.sources.length, 0); assert.equal(h.microphoneCalls, 0); assert.equal(h.panel.getState().pending, null);
    assert.equal(h.requests.some(req => req.method === "POST"), false, "accepted requests recover through read-only lookup"); h.panel.deactivate();
    const missing = fixture({ saved }); await missing.panel.activate(); assert.equal(missing.requests.some(req => req.method === "POST"), false);
    assert.ok(missing.panel.getState().pending, "missing restored request waits for explicit recovery");
    assert.equal(missing.panel.getState().pending.vocal_preset, "", "legacy pending identity is preserved despite the new default");
    assert.equal(missing.panel.getState().voice, "eva"); await missing.event("generate");
    const recovered = missing.requests.find(req => req.method === "POST").body;
    assert.equal(recovered.text, "Original"); assert.equal(recovered.vocal_preset, "", "legacy retries never silently select a new voice");
    assert.equal(Object.hasOwn(recovered, "voice"), false); assert.equal(Object.hasOwn(recovered, "effects"), false); assert.equal(Object.hasOwn(recovered, "text_mode"), false); missing.panel.deactivate();
  }
  {
    const h = fixture({ saved: { pending: { request_id: "audio-request", recorded: true, bpm: 95, bars: 4, style: "boom_bap" } } });
    await h.panel.activate(); await h.event("generate"); assert.equal(h.requests.some(req => req.method === "POST"), false);
    assert.match(h.el("status").textContent, /record again/); await h.event("cancel"); assert.equal(h.panel.getState().pending, null); h.panel.deactivate();
  }
  for (const action of ["leave", "cancel"]) {
    const permission = defer(), h = fixture({ getUserMedia: () => permission.promise }); await h.panel.activate(); const recording = h.event("record"); await settle();
    assert.equal(h.listens, 1); assert.equal(h.el("cancel").hidden, false);
    if (action === "leave") h.panel.deactivate(); else await h.event("cancel");
    permission.resolve(h.stream); await recording; await settle();
    assert.ok(h.stream.tracks[0].stopped > 0, `${action} releases a microphone granted after cancellation`);
    assert.equal(h.recorders.length, 0); assert.equal(h.requests.some(req => req.method === "POST"), false); h.panel.deactivate();
  }
  {
    const h = fixture({ recorderError: true }); await h.panel.activate(); await h.event("record");
    assert.ok(h.stream.tracks[0].stopped > 0); assert.match(h.el("status").textContent, /Recorder unavailable/); assert.equal(h.el("cancel").hidden, true); h.panel.deactivate();
  }
  {
    const h = fixture({ mimeType: "audio/mp4", fetch: req => { if (req.method === "POST") throw new Error("Connection interrupted"); } });
    await h.panel.activate(); h.el("voice").value = "peter"; await h.event("record"); assert.equal(h.recorders[0].mimeType, "audio/mp4"); assert.equal(h.el("record").textContent, "Finish & rap");
    assert.equal(h.el("voice").disabled, true); h.el("voice").value = "eva";
    await h.event("record"); await settle(); await new Promise(resolve => setImmediate(resolve)); await settle();
    assert.ok(h.stream.tracks[0].stopped > 0); const sent = h.requests.find(req => req.method === "POST"); assert.ok(sent?.body.audio_base64);
    assert.equal(sent.body.voice, "peter", "recording uses the voice selected when recording began");
    const wave = Buffer.from(sent.body.audio_base64, "base64"); assert.equal(wave.readUInt32LE(24), 16000); assert.equal(wave.readUInt16LE(22), 1);
    assert.equal(wave.length, 3244); assert.ok(!h.storage.get("hydra.rap-response.v1").includes("audio_base64"), "microphone bytes are never persisted in localStorage");
    assert.equal(h.panel.getState().pending.recorded, true); assert.equal(h.panel.getState().pending.voice, "peter"); h.panel.deactivate();
  }
  {
    const decoding = defer(), h = fixture({ decode: () => decoding.promise }); await h.panel.activate(); await h.event("record"); await h.event("record");
    await settle(); await new Promise(resolve => setImmediate(resolve)); await h.event("cancel"); decoding.resolve(decoded()); await settle();
    assert.equal(h.requests.some(req => req.method === "POST"), false, "cancelling during decoding never submits the audio"); h.panel.deactivate();
  }
  {
    const h = fixture(); await h.panel.activate(); await h.event("record"); await h.timer(30000); await new Promise(resolve => setImmediate(resolve)); await settle();
    assert.ok(h.stream.tracks[0].stopped > 0); assert.equal(h.requests.filter(req => req.method === "POST").length, 1, "the recording limit finishes one bounded message"); h.panel.deactivate();
  }
  {
    const h = fixture(); await h.panel.activate(); await h.event("record"); h.recorders[0].onerror();
    assert.ok(h.stream.tracks[0].stopped > 0); assert.equal(h.el("cancel").hidden, true); assert.equal(h.timers.size, 0); h.panel.deactivate();
  }
  {
    const creating = defer(); let accepted = false;
    const h = fixture({ fetch: (req, response) => {
      if (req.method === "POST" && req.url.endsWith("/responses")) return creating.promise;
      if (req.url.includes("/requests/") && accepted) return response(responseJob({ request_id: "request-1", state: "generating" }));
    } });
    await h.panel.activate(); h.el("text").value = "Wait for me"; const task = h.event("generate"); await settle(); const cancelling = h.event("cancel"); await settle();
    assert.equal(h.requests.some(req => req.url.includes("/requests/")), false, "cancel waits for creation to settle before looking up its result");
    accepted = true; creating.resolve({ ok: true, json: async () => responseJob({ request_id: "request-1", state: "generating" }) }); await task; await cancelling; await settle();
    assert.equal(h.requests.filter(req => req.url.endsWith("/cancel")).length, 1); assert.equal(h.sources.length, 0); assert.equal(h.panel.getState().pending, null); h.panel.deactivate();
  }
  {
    const creating = defer(); let accepted = false;
    const h = fixture({ saved: { pending: { request_id: "retry-request", text: "Recover this", bpm: 95, bars: 4, style: "boom_bap", vocal_preset: "emo_trap" } }, fetch: (req, response) => {
      if (req.method === "POST" && req.url.endsWith("/responses")) return creating.promise;
      if (req.url.includes("/requests/") && accepted) return response(responseJob({ request_id: "retry-request", state: "generating" }));
    } });
    await h.panel.activate(); const recovery = h.event("generate"); await settle();
    assert.equal(h.requests.filter(req => req.method === "POST").length, 1, "explicit recovery retries a missing request once");
    assert.equal(h.requests.find(req => req.method === "POST").body.vocal_preset, "emo_trap");
    const lookups = h.requests.filter(req => req.url.includes("/requests/")).length, cancelling = h.event("cancel"); await settle();
    assert.equal(h.panel.getState().pending.vocal_preset, "emo_trap", "cancellation preserves the submitted voice while acceptance is unresolved");
    assert.equal(h.requests.filter(req => req.url.includes("/requests/")).length, lookups, "cancellation waits for the recovery POST to settle");
    accepted = true; creating.resolve({ ok: true, json: async () => responseJob({ request_id: "retry-request", state: "generating" }) });
    await recovery; await cancelling; await settle(); assert.equal(h.requests.filter(req => req.url.endsWith("/cancel")).length, 1);
    assert.equal(h.panel.getState().pending, null); assert.equal(h.sources.length, 0); h.panel.deactivate();
  }
  {
    const h = fixture({ newJob: { state: "generating" } }); await h.panel.activate(); h.el("text").value = "A pending response"; await h.event("generate");
    const saved = h.panel.getState(); h.panel.deactivate(); assert.equal(h.timers.size, 0); await h.panel.activate();
    h.jobs.set("response-one", responseJob({ request_id: saved.pending.request_id })); await h.timer(1400);
    assert.equal(h.sources.length, 0, "a response finishing after navigation stays silent"); assert.equal(h.requests.filter(req => req.method === "POST").length, 1); h.panel.deactivate();
  }
  {
    const h = fixture({ fetch: req => req.method === "POST" ? new Promise((resolve, reject) => req.signal.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })))) : undefined });
    await h.panel.activate(); h.el("text").value = "Timeout"; const task = h.event("generate"); await settle(); await h.timer(30000); await task;
    assert.match(h.el("status").textContent, /too long/); assert.ok(h.panel.getState().pending); assert.equal(h.el("generate").disabled, false); h.panel.deactivate();
  }
  {
    const h = fixture({ fresh: true }); await h.panel.activate();
    assert.equal(h.panel.getState().output_mode, "vocals", "new drafts default to a voice over the main music");
    assert.equal(h.panel.getState().voice, "eva"); assert.equal(h.panel.getState().vocal_preset, "");
    assert.equal(h.panel.getState().volume, .85); h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { vocal_preset: "emo_trap", response_id: "response-one" }, library: [responseJob({ vocal_preset: "deep_hiphop" })],
      fetch: (req, response) => req.url.endsWith("/response-one") ? response(responseJob({ vocal_preset: "deep_hiphop" })) : undefined });
    await h.panel.activate();
    assert.equal(h.el("voice").value, "eva", "old drafts migrate to Eva while legacy saved performances retain their own identity");
    assert.match(h.el("result-label").textContent, /Deep Hip-Hop Voice/); assert.match(h.el("saved").innerHTML, /Deep Hip-Hop Voice/);
    assert.equal(h.microphoneCalls, 0); assert.equal(h.sources.length, 0); assert.equal(h.requests.some(req => req.method === "POST"), false);
    const requests = h.requests.length; h.el("voice").value = "warren"; h.event("voice", "change");
    assert.equal(h.requests.length, requests, "changing the voice only edits the draft"); assert.equal(h.sources.length, 0);
    h.el("voice").value = "cold_android"; h.event("voice", "change");
    assert.equal(JSON.parse(h.storage.get("hydra.rap-response.v1")).voice, "cold_android");
    assert.match(h.el("result-label").textContent, /Deep Hip-Hop Voice/, "changing the draft never relabels saved audio");
    await h.event("play"); assert.equal(h.requests.some(req => req.method === "POST"), false, "saved playback never regenerates with a newly selected voice");
    h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { vocal_preset: "unrecognised-voice" } }); await h.panel.activate();
    assert.equal(h.el("voice").value, "eva", "invalid stored draft voices fall back to Eva"); h.panel.deactivate();
  }
  {
    const pending = { request_id: "preset-retry", text: "Keep this voice", bpm: 95, bars: 4, style: "trap", vocal_preset: "emo_trap", output_mode: "mix" };
    const h = fixture({ saved: { vocal_preset: "deep_hiphop", pending } }); await h.panel.activate();
    assert.equal(h.requests.some(req => req.method === "POST"), false, "restoring a preset request remains passive");
    assert.equal(h.panel.getState().pending.vocal_preset, "emo_trap"); assert.equal(h.el("voice").disabled, true);
    await h.event("generate"); await settle(); assert.deepEqual(h.requests.find(req => req.method === "POST").body, pending);
    assert.match(h.el("result-label").textContent, /Emo Trap Autotune/); assert.match(h.el("saved").innerHTML, /Emo Trap Autotune/);
    assert.equal(h.el("voice").disabled, false); h.panel.deactivate();
  }
  {
    const pending = { request_id: "future-preset", text: "Keep my future voice", bpm: 95, bars: 4, style: "trap", vocal_preset: "future_voice", output_mode: "mix" };
    const h = fixture({ saved: { pending }, fetch: (req, response) => req.method === "POST" ? response({ error: "Unsupported vocal preset" }, 400) : undefined });
    await h.panel.activate(); assert.equal(h.requests.some(req => req.method === "POST"), false);
    assert.equal(h.panel.getState().pending.vocal_preset, "future_voice"); h.panel.flush();
    assert.equal(JSON.parse(h.storage.get("hydra.rap-response.v1")).pending.vocal_preset, "future_voice", "serializing an unsupported pending preset preserves its identity");
    await h.event("generate");
    assert.deepEqual(h.requests.filter(req => req.method === "POST").map(req => req.body), [pending], "recovery never downgrades an unsupported preset to the original random voice");
    assert.match(h.el("status").textContent, /Unsupported vocal preset/); h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { output_mode: "vocals" }, backing: { bpm: 112 }, newJob: {
      vocal_state: "complete", vocal_audio_url: "/api/rap-response/responses/response-one/vocals/audio" } });
    await h.panel.activate(); h.el("text").value = "Keep the music going"; await h.event("generate"); await settle();
    const submitted = h.requests.find(req => req.method === "POST");
    assert.equal(submitted.body.output_mode, "vocals"); assert.equal(submitted.body.bpm, 112, "generation follows the current backing BPM");
    assert.equal(h.backing.playing, true); assert.equal(h.playOptions[0].output_mode, "vocals");
    assert.equal(h.backing.context.sources.length, 1, "voice playback shares the backing AudioContext");
    const source = h.backing.context.sources[0], gain = source.destination;
    assert.equal(source.at, h.box.HydraRap.nextBar(h.backing, h.backing.context.currentTime));
    assert.equal(gain.destination, h.backing.destination); assert.equal(gain.gain.value, .85);
    assert.ok(h.requests.some(req => req.url.endsWith("/vocals/audio"))); assert.equal(h.requests.some(req => /response-one\/audio$/.test(req.url)), false);
    assert.equal(h.el("download").hidden, false); assert.equal(h.el("download-vocals").hidden, false);
    h.el("volume").value = ".4"; h.event("volume", "input"); assert.equal(gain.gain.value, .4);
    h.backing.playing = false; await h.timer(100); assert.equal(source.stopped, true, "stopping backing stops only the voice");
    assert.match(h.el("status").textContent, /changed or stopped/); h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { output_mode: "vocals" }, newJob: { vocal_state: "complete", vocal_audio_url: "/api/rap-response/responses/response-one/vocals/audio" } });
    await h.panel.activate(); h.el("text").value = "Wait for music"; await h.event("generate"); await settle();
    assert.equal(h.sources.length, 0, "isolated voice never autoplays without backing music");
    assert.equal(h.plays, 0); assert.match(h.el("status").textContent, /Start the main music/);
    assert.equal(h.requests.some(req => req.url.endsWith("/audio")), false, "no mix fallback is fetched");
    h.el("result-mode").value = "mix"; h.event("result-mode", "change"); await h.event("play");
    assert.equal(h.sources.length, 1); assert.equal(h.playOptions[0].output_mode, "mix", "the full mix is an explicit playback choice");
    h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { output_mode: "vocals" }, backing: { bpm: 125 } });
    await h.panel.activate(); await h.event("record");
    assert.equal(h.listenOptions[0].output_mode, "vocals"); assert.equal(h.backing.playing, true);
    await h.event("record"); await new Promise(resolve => setImmediate(resolve)); await settle();
    const request = h.requests.find(req => req.method === "POST"); assert.equal(request.body.bpm, 125); assert.equal(request.body.output_mode, "vocals");
    h.panel.deactivate();
  }
  for (const change of [{ bpm: 155 }, { rateChanging: true }, { valid: false }]) {
    const h = fixture({ saved: { output_mode: "vocals" }, backing: change });
    await h.panel.activate(); h.el("text").value = "Match this music"; await h.event("generate"); await h.event("record");
    assert.equal(h.requests.some(req => req.method === "POST"), false, "invalid backing tempo prevents a mismatched paid generation");
    assert.equal(h.microphoneCalls, 0); h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { response_id: "response-one", auto_play: true }, backing: {}, fetch: (req, response) => req.url.endsWith("/response-one") ? response(responseJob({
      output_mode: "vocals", vocal_state: "complete", vocal_audio_url: "/api/rap-response/responses/response-one/vocals/audio", timings: { ready_seconds: 9.4, isolating_seconds: 3.2 }
    })) : undefined });
    await h.panel.activate(); assert.equal(h.sources.length, 0); assert.equal(h.el("result-mode").value, "vocals");
    assert.match(h.el("timing").textContent, /Voice separation: 3.2 seconds/);
    assert.equal(h.requests.some(req => req.method === "POST"), false); await h.event("play");
    assert.equal(h.backing.context.sources.length, 1); h.panel.deactivate(); assert.equal(h.backing.context.sources[0].stopped, true);
  }
  for (const change of [{ token: "track-2" }, { bpm: 101 }, { rateChanging: true }, { playing: false }]) {
    const decoding = defer(), h = fixture({ saved: { response_id: "response-one" }, backing: {}, decode: () => decoding.promise,
      fetch: (req, response) => req.url.endsWith("/response-one") ? response(responseJob({ output_mode: "vocals", vocal_state: "complete", vocal_audio_url: "/api/rap-response/responses/response-one/vocals/audio" })) : undefined });
    await h.panel.activate(); const playing = h.event("play"); await settle(); Object.assign(h.backing, change); decoding.resolve(decoded()); await playing;
    assert.equal(h.sources.length, 0, "backing changes during decode cannot start a stale vocal"); assert.match(h.el("status").textContent, /changed while/); h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { response_id: "response-one" }, backing: {}, fetch: (req, response) => req.url.endsWith("/response-one") ? response(responseJob({ output_mode: "vocals", state: "failed", vocal_state: "failed", error: "Isolation failed" })) : undefined });
    await h.panel.activate(); assert.equal(h.el("play").disabled, true); assert.equal(h.el("download").hidden, false);
    assert.equal(h.el("download-vocals").hidden, true); assert.equal(h.el("isolate").hidden, true);
    h.el("result-mode").value = "mix"; h.event("result-mode", "change"); await h.event("play");
    assert.equal(h.sources.length, 1, "failed isolation keeps the original complete mix available"); h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { response_id: "response-one" }, backing: {} }); await h.panel.activate();
    h.el("voice").value = "maisie"; h.event("voice", "change");
    assert.equal(h.el("isolate").hidden, false); const isolating = h.event("isolate"); await h.event("isolate"); await isolating; await settle();
    assert.equal(h.requests.filter(req => req.method === "POST").length, 1, "double clicking only requests one isolation attempt");
    assert.ok(h.requests.find(req => req.method === "POST").url.endsWith("/response-one/vocals"));
    assert.deepEqual(h.requests.find(req => req.method === "POST").body, {}, "isolation never applies the newly selected voice to a saved performance");
    assert.match(h.el("result-label").textContent, /Original generated voice/);
    assert.equal(h.el("result-mode").value, "vocals"); assert.equal(h.backing.context.sources.length, 1); h.panel.deactivate();
  }
  {
    const saved = { response_id: "response-one", pending: { id: "response-one", request_id: "request-one", output_mode: "vocals", isolation: true, recorded: true } };
    const h = fixture({ saved, backing: {} }); await h.panel.activate();
    assert.equal(h.requests.some(req => req.method === "POST"), false, "restoring an unreceived isolation never starts it automatically");
    assert.equal(h.panel.getState().pending.isolation, true); await h.event("generate"); await settle();
    assert.equal(h.requests.filter(req => req.method === "POST").length, 1); assert.ok(h.requests.find(req => req.method === "POST").url.endsWith("/vocals")); h.panel.deactivate();
  }
  {
    const submitted = defer(), h = fixture({ saved: { response_id: "response-one" }, backing: {}, fetch: req => req.method === "POST" && req.url.endsWith("/vocals") ? submitted.promise : undefined });
    await h.panel.activate(); const isolating = h.event("isolate"); await settle(); const cancelling = h.event("cancel"); await settle();
    assert.equal(h.requests.some(req => req.url.endsWith("/cancel")), false, "cancellation waits for in-flight isolation acceptance");
    submitted.resolve({ ok: true, json: async () => responseJob({ state: "isolating", output_mode: "vocals", vocal_state: "isolating" }) });
    await isolating; await cancelling; await settle(); assert.equal(h.requests.filter(req => req.url.endsWith("/cancel")).length, 1);
    assert.equal(h.sources.length, 0); assert.equal(h.panel.getState().pending, null); h.panel.deactivate();
  }
  {
    const lookup = defer(); let lookups = 0;
    const h = fixture({ saved: { pending: { id: "response-one", request_id: "request-one", output_mode: "vocals", isolation: true, recorded: true } },
      fetch: (req, response) => req.url.endsWith("/response-one") ? ++lookups === 1 ? response(responseJob()) : lookup.promise : undefined });
    await h.panel.activate(); const recovery = h.event("generate"); await settle(); h.panel.deactivate();
    lookup.resolve({ ok: true, json: async () => responseJob() }); await recovery;
    assert.equal(h.requests.some(req => req.method === "POST"), false, "leaving during isolation recovery never starts a delayed POST");
  }
  {
    let unlocks = 0;
    const h = fixture({ saved: { output_mode: "vocals", response_id: "response-one" }, backing: { context: null, destination: null },
      unlockBacking: (clock, AudioContext) => { unlocks++; clock.context ||= new AudioContext(); clock.destination = clock.context.destination; },
      fetch: (req, response) => req.url.endsWith("/response-one") ? response(responseJob({ output_mode: "vocals", vocal_state: "complete", vocal_audio_url: "/api/rap-response/responses/response-one/vocals/audio" })) : undefined });
    await h.panel.activate(); assert.equal(unlocks, 0, "passive restoration never unlocks Synth audio");
    assert.equal(h.backing.context, null); await h.event("play"); assert.equal(unlocks, 1);
    assert.equal(h.backing.context.sources.length, 1, "explicit overlay playback can unlock a MIDI-only Synth context"); h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { output_mode: "vocals" }, backing: { context: null, destination: null, bpm: 117 },
      unlockBacking: (clock, AudioContext) => { clock.context ||= new AudioContext(); clock.destination = clock.context.destination; } });
    await h.panel.activate(); h.el("text").value = "MIDI is already playing"; await h.event("generate");
    assert.equal(h.requests.find(req => req.method === "POST").body.bpm, 117, "MIDI-only backing supplies BPM before its browser context exists"); h.panel.deactivate();
  }
  console.log("Rap response UI: six static voice demos, no-generation previews, study listening events, preview cancellation and races, PCM/WAV conversion, microphone release, async cancellation, bounded capture, request recovery, silent restoration, vocal presets and legacy identity, full-mix playback, vocal isolation recovery, shared-clock overlay, next-bar start and backing-change guards passed.");
}

module.exports = { fixture, settle, defer, decoded, responseJob };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
