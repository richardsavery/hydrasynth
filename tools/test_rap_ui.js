"use strict";

// Exercise the actual panel against controllable transport, audio, and HTTP
// boundaries. These tests never synthesize a voice or contact a provider.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const plain = value => JSON.parse(JSON.stringify(value));
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const rendered = (extra = {}) => ({ id: "render-one", state: "complete", text: "Words on the beat", bpm: 120,
  renderer: "python-phrase-beats-v3", timing_mode: "phrase_beats", requested_voice_id: "", bars: 2, audio_url: "/api/rap/renders/render-one/audio", ...extra });

function fixture(options = {}) {
  const elements = new Map(), requests = [], contexts = [], timers = new Map(), saved = [], jobs = new Map();
  let timerId = 0, requestId = 0, bpm = options.bpm || 120;
  const el = key => {
    if (!elements.has(key)) elements.set(key, { value: "", checked: false, disabled: false, textContent: "", handlers: {},
      classList: { add() {}, toggle() {} }, addEventListener(kind, handler) { this.handlers[kind] = handler; } });
    return elements.get(key);
  };
  class AudioContext {
    constructor() { this.currentTime = 10; this.state = "running"; this.destination = {}; this.sources = []; this.gains = []; this.decodes = 0; contexts.push(this); }
    async resume() { this.state = "running"; }
    async close() { this.state = "closed"; }
    async decodeAudioData(data) { this.decodes++; return options.decode ? options.decode(data, this.decodes) : { duration: 4, data }; }
    createGain() { const gain = { disconnected: false, gain: { value: 1, setTargetAtTime(value) { this.value = value; } },
      connect(to) { this.destination = to; }, disconnect() { this.disconnected = true; } }; this.gains.push(gain); return gain; }
    createBufferSource() { const source = { stopped: false, disconnected: false,
      start(at) { this.startedAt = at; }, stop() { this.stopped = true; },
      connect(to) { this.destination = to; }, disconnect() { this.disconnected = true; } }; this.sources.push(source); return source; }
  }
  const context = new AudioContext();
  const transport = { context, destination: context.destination, playing: true, valid: true,
    bpm, baseBpm: bpm, beat: 1, at: 10, token: "deck-one", estimated: false, ...options.transport };
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(4) });
  const box = vm.createContext({ console, AbortController, AudioContext, ArrayBuffer,
    crypto: { randomUUID: () => `request-${++requestId}` },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay, repeat: false }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) { timers.set(++timerId, { callback, delay, repeat: true }); return timerId; },
    clearInterval(id) { timers.delete(id); },
    async fetch(url, init = {}) {
      const req = { url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null, signal: init.signal };
      requests.push(req);
      if (options.fetch) { const result = await options.fetch(req, response); if (result !== undefined) return result; }
      if (url === "/api/rap/status") return response({ ready: true });
      if (url === "/api/rap/voices") return response({ voices: [{ voice_id: "voice-fixture", name: "Fixture voice" }], default_voice_id: "voice-fixture" });
      if (url.endsWith("/audio")) return response(null);
      if (req.method === "POST") { const job = rendered({ ...req.body, renderer: req.body.timing_mode === "natural" ? "python-natural-phrase-v2" : "python-phrase-beats-v3", requested_voice_id: req.body.voice_id }); jobs.set(job.id, job); return response(job); }
      return response(jobs.get(url.split("/").at(-1)) || rendered());
    }
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/../dashboard/rap.js`, "utf8"), box, { filename: "rap.js" });
  const container = { classList: { add() {} }, querySelector: selector => el(selector.slice(10, -1)), innerHTML: "" };
  let panel;
  panel = box.HydraRap.create({ container, name: "test", saved: { text: "Words on the beat", auto_start: false, ...options.saved },
    getBpm: () => bpm, clock: () => transport, unlock: options.unlock || (async () => {}),
    onSave: () => { if (panel) saved.push(plain(panel.getState())); } });
  return { panel, transport, context, contexts, requests, saved, timers, el, box,
    setBpm(value) { bpm = value; },
    event(key, kind = "click") { return el(key).handlers[kind](); },
    async tick() { for (const item of [...timers.values()].filter(item => item.repeat)) await item.callback(); await settle(); },
    async poll() { const entry = [...timers].find(([, item]) => !item.repeat); assert.ok(entry, "expected a status poll"); timers.delete(entry[0]); await entry[1].callback(); await settle(); }
  };
}

async function readyFixture(options = {}) { const h = fixture(options); await h.panel.activate(); await h.event("prepare"); assert.equal(h.el("play").disabled, false); return h; }

async function main() {
  {
    const h = fixture({ saved: { auto_start: undefined } });
    assert.equal(h.el("auto").checked, true, "new and older drafts default to starting after explicit preparation");
    assert.equal(h.el("timing").value, "phrase_beats");
    const next = h.box.HydraRap.nextBeat;
    assert.equal(next({ bpm: 120, beat: 1, at: 10 }, 10), 10.5);
    assert.equal(next({ bpm: 120, beat: 2, at: 10 }, 10), 10.5, "a beat already reached is skipped to leave scheduling lead time");
    assert.equal(next({ bpm: 120, beat: 0, at: 12 }, 10), 12);
    await h.panel.activate();
    assert.equal(h.context.sources.length, 0, "opening a checked auto-start preference does not play");
    await h.event("prepare"); await settle();
    assert.equal(h.requests.find(req => req.method === "POST").body.timing_mode, "phrase_beats");
    assert.equal(h.context.sources.length, 1, "explicit Prepare automatically starts the completed render");
    assert.equal(h.context.sources[0].startedAt, 10.5);
    assert.equal(h.panel.getState().auto_start, true);
    assert.equal(h.panel.getState().timing_mode, "phrase_beats");
    h.el("auto").checked = false; await h.event("auto", "change");
    assert.equal(h.context.sources[0].stopped, true, "unchecking auto-start cancels audio queued for a future beat");
    h.el("auto").checked = true; await h.event("auto", "change"); await h.tick();
    assert.equal(h.context.sources.length, 1, "checking the preference does not replay an already prepared render");
    h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { auto_start: true, render_id: "render-one" } });
    await h.panel.activate(); await h.tick();
    assert.equal(h.el("play").disabled, false);
    assert.equal(h.context.sources.length, 0, "restoring complete audio never arms automatic playback");
    assert.equal(h.requests.some(req => req.method === "POST"), false);
    h.panel.deactivate();
  }
  {
    const response = defer(); let unlocks = 0;
    const h = fixture({ saved: { auto_start: false }, unlock: async () => { unlocks++; },
      fetch: req => req.method === "POST" ? response.promise : undefined });
    await h.panel.activate(); const preparation = h.event("prepare"); await settle();
    h.el("auto").checked = true; await h.event("auto", "change");
    assert.equal(unlocks, 2, "checking auto during an explicit Prepare unlocks audio in that new gesture");
    response.resolve({ ok: true, json: async () => rendered() }); await preparation; await settle();
    assert.equal(h.context.sources.length, 1, "checking auto while this page is preparing arms the pending render");
    assert.equal(h.context.sources[0].startedAt, 10.5);
    h.panel.deactivate();
  }
  {
    let reads = 0;
    const h = fixture({ saved: { auto_start: false, render_id: "render-one", pending: {
      text: "Words on the beat", bpm: 120, voice_id: "", timing_mode: "phrase_beats", request_id: "passive-toggle" } },
      fetch: (req, response) => req.url.endsWith("/render-one") ? response(rendered({ state: ++reads === 1 ? "rendering" : "complete" })) : undefined });
    await h.panel.activate(); h.el("auto").checked = true; await h.event("auto", "change");
    await h.poll(); await h.tick();
    assert.equal(h.context.sources.length, 0, "checking a preference on a passively restored pending job does not arm it");
    h.panel.deactivate();
  }
  {
    let reads = 0;
    const h = fixture({ saved: { auto_start: true, render_id: "render-one", pending: {
      text: "Words on the beat", bpm: 120, voice_id: "", timing_mode: "phrase_beats", request_id: "restore-pending" } },
      fetch: (req, response) => req.url.endsWith("/render-one") ? response(rendered({ state: ++reads === 1 ? "rendering" : "complete" })) : undefined });
    await h.panel.activate(); await h.poll(); await h.tick();
    assert.equal(h.el("play").disabled, false);
    assert.equal(h.context.sources.length, 0, "completion of a restored pending job is passive even with auto-start saved");
    assert.equal(h.requests.some(req => req.method === "POST"), false);
    h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { auto_start: true }, transport: { valid: false } });
    await h.panel.activate(); await h.event("prepare"); await settle();
    assert.equal(h.context.sources.length, 0);
    assert.equal(h.el("stop").disabled, false, "waiting automatic playback can be canceled");
    assert.match(h.el("status").textContent, /waiting for the backing beat/);
    h.transport.valid = true; h.transport.token = "fresh-data-clock"; await h.tick();
    assert.equal(h.context.sources.length, 1, "fresh data schedules against the current clock rather than an obsolete token");
    assert.equal(h.context.sources[0].startedAt, 10.5);
    h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { auto_start: true } });
    await h.panel.activate();
    h.setBpm(144); h.transport.bpm = 144;
    await h.event("prepare"); await settle();
    assert.equal(h.requests.find(req => req.method === "POST").body.bpm, 144);
    assert.equal(h.context.sources.length, 1, "an explicit Prepare after a tempo edit uses the new tempo without waiting for the UI timer");
    h.panel.deactivate();
  }
  for (const cancel of ["stop", "uncheck", "text", "voice", "timing", "bpm", "navigate"]) {
    const response = defer();
    const h = fixture({ saved: { auto_start: true }, fetch: req => req.method === "POST" ? response.promise : undefined });
    await h.panel.activate(); const preparation = h.event("prepare"); await settle();
    assert.equal(h.el("stop").disabled, false, "Stop is available while preparing an armed render");
    if (cancel === "stop") h.panel.stop();
    if (cancel === "uncheck") { h.el("auto").checked = false; await h.event("auto", "change"); }
    if (cancel === "text") { h.el("text").value = "Updated lyrics"; await h.event("text", "input"); }
    if (cancel === "voice") { h.el("voice-select").value = "voice-fixture"; await h.event("voice-select", "change"); }
    if (cancel === "timing") { h.el("timing").value = "natural"; await h.event("timing", "change"); }
    if (cancel === "bpm") { h.setBpm(144); await h.tick(); }
    if (cancel === "navigate") h.panel.deactivate();
    response.resolve({ ok: true, json: async () => rendered() }); await preparation; await settle(); await h.tick();
    assert.equal(h.context.sources.length, 0, `${cancel} prevents a late completed render from reviving automatic playback`);
    assert.equal(h.requests.filter(req => req.method === "POST").length, 1, "canceling playback does not submit replacement synthesis");
    h.panel.deactivate();
  }
  for (const cancel of ["stop", "uncheck", "navigate"]) {
    const decode = defer();
    const h = fixture({ saved: { auto_start: true }, decode: () => decode.promise });
    await h.panel.activate(); await h.event("prepare"); await settle();
    assert.equal(h.context.decodes, 1);
    if (cancel === "stop") h.panel.stop();
    if (cancel === "uncheck") { h.el("auto").checked = false; await h.event("auto", "change"); }
    if (cancel === "navigate") h.panel.deactivate();
    decode.resolve({ duration: 4 }); await settle();
    assert.equal(h.context.sources.length, 0, `${cancel} invalidates an automatic decode already in flight`);
    h.panel.deactivate();
  }
  {
    const h = await readyFixture({ saved: { auto_start: false } });
    await h.event("play");
    h.el("auto").checked = false; await h.event("auto", "change");
    assert.equal(h.context.sources[0].stopped, false, "the auto-start checkbox cannot cancel manually requested playback");
    h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { voice_id: "my-custom-voice" }, fetch: (req, response) => req.url === "/api/rap/voices" ? response({ voices: [
      { voice_id: "voice-fixture", name: "<Fixture voice>" }, { voice_id: "bad\"id", name: "Invalid" }], default_voice_id: "voice-fixture" }) : undefined });
    await h.panel.activate();
    assert.match(h.el("voice-select").innerHTML, /Default · &lt;Fixture voice&gt;/);
    assert.doesNotMatch(h.el("voice-select").innerHTML, /value="bad/);
    assert.equal(h.el("voice-select").value, "__custom__");
    assert.equal(h.el("voice").value, "my-custom-voice", "an unlisted saved voice is never overwritten");
    assert.equal(h.el("custom").hidden, false);
    h.el("voice-select").value = "voice-fixture"; await h.event("voice-select", "change");
    assert.equal(h.panel.getState().voice_id, "voice-fixture");
    assert.equal(h.el("custom").hidden, true);
    await h.event("prepare");
    assert.equal(h.requests.find(req => req.method === "POST").body.voice_id, "voice-fixture");
    h.panel.deactivate();
  }
  {
    const h = fixture({ fetch: (req, response) => req.url === "/api/rap/voices" ? response({ error: "Voice permission missing" }, 403) : undefined });
    await h.panel.activate();
    assert.match(h.el("voice-status").textContent, /Voice list unavailable/);
    h.el("voice-select").value = "__custom__"; await h.event("voice-select", "change");
    h.el("voice").value = "manual-voice"; await h.event("voice", "input");
    await h.event("prepare");
    assert.equal(h.requests.find(req => req.method === "POST").body.voice_id, "manual-voice");
    h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { render_id: "render-one", timing_mode: "natural_phrase" }, fetch: (req, response) =>
      req.url.endsWith("/render-one") ? response(rendered({ timing_mode: "natural_phrase", renderer: "python-natural-phrase-v2", source_available: true })) : undefined });
    await h.panel.activate();
    assert.equal(h.el("timing").value, "natural");
    assert.equal(h.el("play").disabled, false, "the explicit Natural flow mode accepts saved natural_phrase renders");
    h.el("timing").value = "phrase_beats"; await h.event("timing", "change");
    assert.equal(h.el("play").disabled, true, "timing mode is part of render readiness");
    await h.event("prepare");
    const body = h.requests.find(req => req.method === "POST").body;
    assert.equal(body.source_render_id, "render-one", "same voice and text can reuse retained speech for local timing changes");
    assert.equal(body.timing_mode, "phrase_beats");
    assert.equal(h.el("play").disabled, false);
    h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { render_id: "render-one" }, fetch: (req, response) => req.url.endsWith("/render-one") ? response(rendered({ source_available: true })) : undefined });
    await h.panel.activate();
    h.el("voice").value = "changed-voice"; await h.event("voice", "input");
    await h.event("prepare");
    assert.equal(h.requests.find(req => req.method === "POST").body.source_render_id, undefined, "changed voices require new speech rather than mismatched local reuse");
    h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { render_id: "render-one" },
      fetch: (req, response) => req.url.endsWith("/render-one") ? response(rendered({ renderer: undefined })) : undefined });
    await h.panel.activate();
    assert.equal(h.el("play").disabled, true, "saved word-chopped audio needs preparation with natural delivery");
    assert.match(h.el("status").textContent, /Prepare this rap again/);
    assert.equal(h.requests.filter(req => req.method === "POST").length, 0, "migration never buys another voice automatically");
    await h.event("prepare");
    assert.equal(h.el("play").disabled, false);
    h.panel.deactivate();
  }
  {
    const h = fixture();
    const next = h.box.HydraRap.nextBar;
    assert.equal(next({ bpm: 120, beat: 1, at: 10 }, 10), 11.5);
    assert.equal(next({ bpm: 120, beat: 4, at: 10 }, 10), 12, "leave lead time rather than start on a bar already reached");
    assert.equal(next({ bpm: 120, beat: 0, at: 12 }, 10), 12, "scheduled future deck starts share the same bar zero");
    await h.panel.activate();
    assert.equal(h.requests.filter(req => req.method === "POST").length, 0, "opening a panel never buys a render");
    await h.event("prepare");
    assert.equal(h.requests.filter(req => req.method === "POST").length, 1);
    assert.equal(h.el("play").disabled, false);
    await h.event("play");
    const source = h.context.sources[0];
    assert.equal(source.startedAt, 10.5, "Python-rendered audio is scheduled on the backing track's next beat");
    assert.equal(source.buffer.duration, 4);
    assert.equal(source.destination.destination, h.context.destination);
    assert.equal(h.contexts.length, 1, "the backing context is reused");
    h.el("volume").value = "0.3"; await h.event("volume", "input");
    assert.equal(h.context.gains[0].gain.value, 0.3);
    h.el("loop").checked = true; await h.event("loop", "change");
    assert.equal(source.loop, true);
    h.transport.token = "deck-two"; await h.tick();
    assert.equal(source.stopped, true, "a track transition invalidates the old rap phase");
    assert.equal(h.el("play").disabled, false);
    h.panel.deactivate();
    assert.equal(h.timers.size, 0);
    assert.equal(h.context.state, "running", "the rap panel never closes an accompaniment-owned context");
  }
  {
    const h = await readyFixture();
    await h.event("play"); const first = h.context.sources[0];
    h.el("text").value = "Edited words"; await h.event("text", "input");
    assert.equal(first.stopped, true);
    assert.equal(h.el("play").disabled, true, "an old voice cannot speak newly edited lyrics");
    assert.equal(h.panel.getState().text, "Edited words");
    assert.equal(h.requests.filter(req => req.method === "POST").length, 1, "typing never spends credits automatically");
    h.panel.deactivate();
  }
  {
    const firstDecode = defer(), secondDecode = defer();
    const h = await readyFixture({ decode: (_data, number) => number === 1 ? firstDecode.promise : secondDecode.promise });
    const firstPlay = h.event("play"); await settle(); assert.equal(h.context.decodes, 1);
    await h.event("stop");
    const secondPlay = h.event("play"); await settle(); assert.equal(h.context.decodes, 2);
    firstDecode.resolve({ duration: 4, marker: "obsolete" }); await firstPlay;
    assert.equal(h.context.sources.length, 0, "a canceled decode cannot steal a subsequent Play request");
    secondDecode.resolve({ duration: 4, marker: "current" }); await secondPlay;
    assert.equal(h.context.sources.length, 1);
    assert.equal(h.context.sources[0].buffer.marker, "current");
    h.panel.deactivate();
  }
  {
    const decoding = defer();
    const h = await readyFixture({ decode: () => decoding.promise });
    const playback = h.event("play"); await settle(); h.panel.deactivate();
    decoding.resolve({ duration: 4 }); await playback;
    assert.equal(h.context.sources.length, 0, "navigation cancels audio that is still decoding");
    assert.equal(h.timers.size, 0);
  }
  {
    const pending = defer();
    const h = fixture({ fetch: req => req.method === "POST" ? pending.promise : undefined });
    await h.panel.activate(); const preparing = h.event("prepare"); await settle();
    h.panel.deactivate(); pending.resolve({ ok: true, json: async () => rendered() }); await preparing;
    assert.equal(h.panel.getState().render_id, null, "a late response cannot mutate an inactive panel");
    assert.equal(h.context.sources.length, 0);
    assert.equal(h.timers.size, 0);
  }
  {
    let fail = true;
    const h = fixture({ fetch: req => { if (req.method === "POST" && fail) { fail = false; throw new Error("Connection interrupted"); } } });
    await h.panel.activate(); await h.event("prepare");
    const requestId = h.panel.getState().pending.request_id;
    assert.equal(h.el("prepare").textContent, "Check render");
    const recovered = fixture({ saved: h.panel.getState() });
    await recovered.panel.activate();
    assert.equal(recovered.requests.filter(req => req.method === "POST").length, 0, "restoring an uncertain request cannot re-spend credits");
    await recovered.event("prepare");
    assert.equal(recovered.requests.at(-1).body.request_id, requestId, "manual recovery keeps the server idempotency key");
    assert.equal(recovered.panel.getState().pending, null);
    assert.equal(recovered.el("play").disabled, false);
    h.panel.deactivate(); recovered.panel.deactivate();
  }
  {
    const pending = defer();
    let submissions = 0;
    const h = await readyFixture({ fetch: req => {
      if (req.method === "POST" && ++submissions === 2) return pending.promise;
    } });
    assert.equal(h.panel.getState().render_id, "render-one");
    h.el("text").value = "New words for the second render";
    await h.event("text", "input");
    const preparing = h.event("prepare"); await settle();
    const requestId = h.panel.getState().pending.request_id;
    assert.equal(h.panel.getState().render_id, null, "new pending work cannot retain an older render's recovery ID");
    h.panel.deactivate();
    const recovered = fixture({ saved: h.panel.getState() });
    await recovered.panel.activate();
    assert.equal(recovered.requests.some(req => req.url === "/api/rap/renders/render-one"), false,
      "restoring a new pending submission must not load and complete the previous render");
    assert.equal(recovered.panel.getState().pending.request_id, requestId);
    assert.equal(recovered.requests.filter(req => req.method === "POST").length, 0);
    pending.resolve({ ok: true, json: async () => rendered({ id: "render-two", text: "New words for the second render" }) });
    await preparing;
    assert.equal(h.panel.getState().pending.request_id, requestId, "a late inactive response cannot discard pending recovery");
    await recovered.event("prepare");
    assert.equal(recovered.requests.at(-1).body.request_id, requestId);
    assert.equal(recovered.requests.at(-1).body.text, "New words for the second render");
    assert.equal(recovered.panel.getState().pending, null);
    assert.equal(recovered.el("play").disabled, false);
    recovered.panel.deactivate();
  }
  {
    const h = fixture({ saved: { render_id: "render-one", pending: { request_id: "recover-queued", text: "Words on the beat", bpm: 120, voice_id: "" } },
      fetch: (req, response) => req.url === "/api/rap/renders/render-one" ? response(rendered({ state: "rendering" })) : undefined });
    await h.panel.activate();
    assert.match(h.el("status").textContent, /Placing phrases/);
    await h.poll();
    assert.equal(h.requests.filter(req => req.method === "POST").length, 0, "restored active renders poll without another generation call");
    h.panel.deactivate();
  }
  {
    const h = await readyFixture();
    h.transport.valid = false; await h.event("play");
    assert.equal(h.context.sources.length, 0, "missing backing data prevents rap playback");
    assert.match(h.el("status").textContent, /Waiting for mapped input/);
    h.transport.valid = true; h.transport.rateChanging = true; await h.event("play");
    assert.equal(h.context.sources.length, 0, "do not choose a bar during a playback-rate ramp");
    h.transport.rateChanging = false; await h.event("play");
    const source = h.context.sources[0]; h.transport.valid = false; await h.tick();
    assert.equal(source.stopped, true);
    h.transport.valid = true; h.setBpm(144); await h.tick();
    assert.equal(h.el("play").disabled, true, "tempo edits require a newly rendered rhythm");
    assert.match(h.el("status").textContent, /Tempo changed/);
    h.panel.deactivate();
  }
  {
    const h = await readyFixture({ transport: { playing: false } });
    await h.event("play"); const source = h.context.sources[0];
    assert.equal(source.startedAt, 10.08, "a stopped backing supports standalone rendered rap");
    h.transport.playing = true; await h.tick();
    assert.equal(source.stopped, true, "starting accompaniment requires the standalone voice to rejoin its next bar");
    h.panel.deactivate();
  }
  console.log("Rap UI: phrase/natural timing, voices, next-beat scheduling, armed auto-start cancellation, recovery and local speech reuse passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
