"use strict";

// Transport and HTTP doubles exercise the actual panel without paid requests.
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const plain = value => JSON.parse(JSON.stringify(value));
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const JADE = "g7LVvkPWALzPxOQbF6OE";
const defaults = { text: "Words on the beat", bpm: 100, voice_id: JADE, robot_style: "autotune", robot_amount: 1, robot_tone_hz: 4500, robot_key: 5, robot_scale: "major", robot_melody: "two_note", robot_octave: 3, robot_note_beats: 1, robot_rhythm: "flow" };
const job = (extra = {}) => { const result = { ...defaults, id: "job-one", state: "complete", sources: { flash: { state: "complete" } }, ...extra };
  result.examples ||= ["flash", "robot"].map(id => ({ id, state: "complete", audio_url: `/api/rap-experiment/experiments/${result.id}/audio/${id}` })); return result; };
function fixture(config = {}) {
  const elements = new Map(), requests = [], timers = new Map(), contexts = [], snapshots = [], jobs = new Map((config.library || []).map(item => [item.id, item]));
  let timerId = 0, requestId = 0, bpm = config.bpm || 100, backingCalls = 0, recallCalls = [];
  const el = key => { if (!elements.has(key)) elements.set(key, { value: "", checked: false, disabled: false, hidden: false, textContent: "", handlers: {}, classList: { add() {}, toggle() {} }, addEventListener(kind, cb) { this.handlers[kind] = cb; } }); return elements.get(key); };
  class AudioContext {
    constructor() { this.currentTime = 10; this.state = "running"; this.destination = {}; this.sources = []; this.gains = []; this.decodes = 0; contexts.push(this); }
    async resume() { this.state = "running"; } async close() { this.state = "closed"; }
    async decodeAudioData(data) { this.decodes++; return config.decode ? config.decode(data, this.decodes) : { duration: 4.8 }; }
    createGain() { const gain = { gain: { value: 1, setTargetAtTime(value) { this.value = value; } }, connect(to) { this.destination = to; }, disconnect() { this.disconnected = true; } }; this.gains.push(gain); return gain; }
    createBufferSource() { const source = { start(at) { this.startedAt = at; }, stop() { this.stopped = true; }, connect(to) { this.destination = to; }, disconnect() { this.disconnected = true; } }; this.sources.push(source); return source; }
  }
  const context = new AudioContext(), output = {};
  const transport = { context, destination: output, playing: true, valid: true, bpm, beat: 1, at: 10, token: "track-one", ...config.transport };
  const response = (body, code = 200) => ({ ok: code < 400, status: code, json: async () => body, arrayBuffer: async () => new ArrayBuffer(4) });
  const box = vm.createContext({ console, AbortController, AudioContext, ArrayBuffer, crypto: { randomUUID: () => `request-${++requestId}` },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; }, clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) { timers.set(++timerId, { callback, delay, repeat: true }); return timerId; }, clearInterval(id) { timers.delete(id); },
    async fetch(url, init = {}) {
      const req = { url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null }; requests.push(req);
      if (config.fetch) { const result = await config.fetch(req, response); if (result !== undefined) return result; }
      if (url.endsWith("/status")) return response({ ready: true, default_voice_id: JADE, suggested_voices: [{ voice_id: JADE, name: "Jade" }, { voice_id: "suggested", name: "Suggested voice" }] });
      if (url.endsWith("/voices")) return response({ error: "No catalogue permission" }, 403);
      if (url.endsWith("/mixer-examples")) return response({ examples: config.examples || [{ id: "neutral", label: "Neutral with music", track_id: "backing-one", experiment_id: "job-one" }] });
      if (url.includes("/audio/")) return response(null);
      if (req.method === "POST") { const value = job({ ...req.body, id: `job-${requestId}` }); jobs.set(value.id, value); return response(value); }
      if (url.endsWith("/experiments")) return response({ experiments: [...jobs.values()] });
      return response(jobs.get(url.split("/").at(-1)) || job());
    }
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/../dashboard/rap.js`, "utf8"), box);
  vm.runInContext(fs.readFileSync(`${__dirname}/../dashboard/music-mixer-voice.js`, "utf8"), box);
  const container = { classList: { add() {} }, querySelector: selector => el(selector.slice(9, -1)), innerHTML: "" };
  let panel;
  panel = box.HydraMusicMixerVoice.create({ container, name: "test", saved: { ...defaults, auto_start: false, ...config.saved }, getBpm: () => bpm, clock: () => transport,
    unlock: config.unlock || (async () => {}), onSave: () => { if (panel) snapshots.push(plain(panel.getState())); },
    onPlayBacking: async () => { backingCalls++; if (config.playBacking) await config.playBacking(transport); else transport.playing = true; },
    onSelectBacking: async id => { recallCalls.push(id); if (config.selectBacking) await config.selectBacking(transport, value => { bpm = value; }); }
  });
  return { panel, context, contexts, transport, output, requests, timers, snapshots, el, jobs,
    get backingCalls() { return backingCalls; }, get recallCalls() { return recallCalls; },
    posts: () => requests.filter(req => req.method === "POST").map(req => req.body), setBpm(value) { bpm = value; transport.bpm = value; },
    event(key, type = "click") { return el(key).handlers[type](); },
    async tick() { for (const item of [...timers.values()].filter(item => item.repeat)) await item.callback(); await settle(); },
    async poll() { const entry = [...timers].find(([, item]) => !item.repeat); assert.ok(entry); timers.delete(entry[0]); await entry[1].callback(); await settle(); }
  };
}
async function ready(config = {}) { const h = fixture(config); await h.panel.activate(); await h.event("prepare"); await settle(); return h; }
async function main() {
  {
    const h = fixture({ saved: { auto_start: true, experiment_id: "job-one" }, library: [job()] }); await h.panel.activate(); await h.tick();
    assert.equal(h.posts().length, 0); assert.equal(h.context.sources.length, 0, "restore never plays or posts");
    assert.equal(h.el("play").disabled, false); assert.match(h.el("voice-select").innerHTML, /Suggested voice/);
    await h.event("play"); assert.equal(h.context.sources[0].startedAt, 10.6); assert.equal(h.context.gains[0].destination, h.output, "uses shared music output");
    h.transport.token = "track-two"; await h.tick(); assert.equal(h.context.sources[0].stopped, true);
    h.panel.deactivate(); assert.equal(h.timers.size, 0);
  }
  {
    const h = await ready({ saved: { auto_start: true } });
    assert.equal(h.posts().length, 1); assert.deepEqual(h.posts()[0].variants, ["flash", "robot"]); assert.equal(h.context.sources.length, 1);
    h.el("auto").checked = false; await h.event("auto", "change"); assert.equal(h.context.sources[0].stopped, true, "unchecking cancels queued voice");
    h.el("auto").checked = true; await h.event("auto", "change"); await h.tick(); assert.equal(h.context.sources.length, 1, "checking preference never replays finished work");
    h.panel.deactivate();
  }
  {
    const h = await ready({ library: [job()] }); assert.deepEqual(h.posts()[0].variants, ["robot"]); assert.equal(h.posts()[0].source_experiment_id, "job-one"); assert.equal(h.posts()[0].include_clean, true);
    h.el("tone").value = "3000"; await h.event("tone", "input"); assert.equal(h.el("play").disabled, true); await h.event("prepare"); assert.equal(h.posts().at(-1).robot_tone_hz, 3000); assert.equal(h.posts().at(-1).include_clean, true);
    h.el("effect").value = "clean"; await h.event("effect", "change"); assert.equal(h.el("play").disabled, false, "clean pair ready immediately"); await h.event("play"); assert.ok(h.requests.some(req => req.url.endsWith("/audio/flash")));
    h.el("text").value = "New words"; await h.event("text", "input"); await h.event("prepare"); assert.deepEqual(h.posts().at(-1).variants, ["flash", "robot"]); assert.equal(h.posts().at(-1).source_experiment_id, undefined);
    h.el("voice-select").value = "suggested"; await h.event("voice-select", "change"); await h.event("prepare"); assert.equal(h.posts().at(-1).voice_id, "suggested"); assert.equal(h.posts().at(-1).source_experiment_id, undefined);
    h.panel.deactivate();
  }
  {
    let fails = true;
    const h = fixture({ fetch: async req => { if (req.method === "POST" && fails) throw new Error("Lost connection"); } }); await h.panel.activate(); await h.event("prepare");
    const original = plain(h.posts()[0]); assert.equal(h.el("prepare").textContent, "Recover voice");
    h.el("key").value = "9"; await h.event("key", "change"); h.el("rhythm").value = "natural"; await h.event("rhythm", "change");
    const snapshot = plain(h.panel.getState()); h.panel.deactivate();
    const restored = fixture({ saved: snapshot }); await restored.panel.activate(); assert.equal(restored.posts().length, 0);
    await restored.event("prepare"); assert.deepEqual(restored.posts()[0], original, "request recovery submits exact original settings and id"); assert.equal(restored.context.sources.length, 0);
    assert.equal(restored.el("play").disabled, true, "different edited draft is not played"); restored.panel.deactivate();
  }
  {
    const decoded = defer(), h = await ready({ decode: () => decoded.promise }); const attempt = h.event("play"); await settle();
    h.transport.token = "new-track"; decoded.resolve({ duration: 4.8 }); await attempt; assert.equal(h.context.sources.length, 0, "track change during decode invalidates scheduling");
    assert.match(h.el("status").textContent, /Track changed/); h.panel.deactivate();
  }
  {
    const start = defer(), h = await ready({ transport: { playing: false }, playBacking: () => start.promise }); const attempt = h.event("play"); await settle();
    await h.event("stop"); start.resolve(); await attempt; assert.equal(h.context.sources.length, 0, "stop during backing startup prevents delayed voice"); h.panel.deactivate();
  }
  {
    const h = await ready(); await h.event("play"); h.setBpm(110); await h.tick(); assert.equal(h.context.sources[0].stopped, true); assert.equal(h.el("play").disabled, true);
    await h.event("prepare"); assert.equal(h.posts().at(-1).bpm, 110); assert.equal(h.posts().at(-1).include_clean, true, "tempo changes reuse speech locally"); h.panel.deactivate();
  }
  {
    const h = fixture({ library: [job({ audition_group: "neutral", audition_label: "N03 · Neutral flow" }), job({ id: "jade-old", audition_group: "jade", audition_label: "J07 · Hook", robot_melody: "hook" })] });
    await h.panel.activate(); assert.match(h.el("saved").innerHTML, /N03 · Neutral flow/); h.el("saved").value = "jade-old"; await h.event("saved", "change");
    assert.equal(h.panel.getState().robot_melody, "hook"); assert.equal(h.posts().length, 0); assert.equal(h.context.sources.length, 0);
    h.el("preset").value = "soft"; await h.event("preset", "change"); assert.equal(h.panel.getState().robot_tone_hz, 3000); assert.equal(h.posts().length, 0);
    h.el("preset").value = "hook"; await h.event("preset", "change"); assert.equal(h.panel.getState().robot_key, 5); assert.equal(h.panel.getState().robot_note_beats, .5);
    h.panel.deactivate();
  }
  {
    const recaller = defer(), h = fixture({ bpm: 120, library: [job()], selectBacking: async (transport, setBpm) => { setBpm(100); transport.bpm = 100; transport.playing = false; await recaller.promise; } });
    await h.panel.activate(); h.el("example").value = "neutral"; await h.event("example", "change"); assert.equal(h.recallCalls.length, 0, "example selection is passive");
    const attempt = h.event("play-example"); await settle(); await h.tick(); recaller.resolve(); await attempt;
    assert.deepEqual(h.recallCalls, ["backing-one"]); assert.equal(h.context.sources.length, 1); assert.equal(h.posts().length, 0, "cached example never generates voice or music");
    assert.equal(h.panel.getState().robot_rhythm, "flow"); h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { auto_start: true }, transport: { valid: false } }); await h.panel.activate(); await h.event("prepare"); await settle();
    assert.equal(h.context.sources.length, 0, "auto waits for valid input beat"); h.transport.valid = true; await h.tick(); assert.equal(h.context.sources.length, 1);
    h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { auto_start: true }, transport: { playing: false, valid: false }, playBacking: async transport => { transport.playing = true; } });
    await h.panel.activate(); await h.event("prepare"); await settle(); assert.equal(h.backingCalls, 1); assert.equal(h.context.sources.length, 0);
    await h.tick(); await h.tick(); assert.equal(h.backingCalls, 1, "auto waits without repeatedly starting invalid backing");
    h.transport.valid = true; await h.tick(); assert.equal(h.context.sources.length, 1, "auto-arm survives backing startup with temporarily invalid input"); assert.equal(h.backingCalls, 1);
    h.panel.deactivate();
  }
  {
    const h = fixture({ saved: { legacy_rap: { render_id: "old-rap", text: "Original words" } } }); assert.equal(h.panel.getState().legacy_rap.render_id, "old-rap"); h.panel.deactivate();
  }
  {
    const decoded = defer(), h = fixture({ saved: { auto_start: true }, decode: () => decoded.promise }); await h.panel.activate(); await h.event("prepare"); await settle();
    h.transport.valid = false; decoded.resolve({ duration: 4.8 }); await settle(); assert.equal(h.context.sources.length, 0);
    h.transport.valid = true; await h.tick(); assert.equal(h.context.sources.length, 1, "input invalidation during decode retains automatic beat intent"); h.panel.deactivate();
  }
  {
    const legacyPending = { text: "Original words", bpm: 100, voice_id: "old", timing_mode: "phrase_beats", request_id: "old-request" };
    const h = fixture({ saved: { pending: legacyPending } }); await h.panel.activate();
    assert.equal(h.panel.getState().pending, null); assert.deepEqual(plain(h.panel.getState().legacy_rap.pending), legacyPending);
    await h.event("prepare"); assert.notEqual(h.posts()[0].request_id, "old-request"); assert.deepEqual(h.posts()[0].variants, ["flash", "robot"]); h.panel.deactivate();
  }
  console.log("Music mixer voice: shared beat playback, clean/effected pairs, source reuse, request recovery, examples, persistence and cancellation passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
