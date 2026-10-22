"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const clone = value => JSON.parse(JSON.stringify(value));
const elements = new Map(), events = new Map(), posts = [], gets = [], sources = [], timers = new Map(), pollDelays = [];
let nextTimer = 0, stored = {}, deferredPost = null, nextFailure = null;
let catalog = null, library = null, serviceDefault = "main";
const suggestions = [{ voice_id: "main", name: "George" }, { voice_id: "other", name: "Warren" }, { voice_id: "jade", name: "Jade" }, { voice_id: "elara", name: "Elara" }];
function el(name) {
  if (!elements.has(name)) elements.set(name, { value: "", checked: false, disabled: false, hidden: false, innerHTML: "", textContent: "",
    classList: { toggle() {} }, addEventListener(type, callback) { events.set(`${name}:${type}`, callback); } });
  return elements.get(name);
}
const root = { innerHTML: "", classList: { add() {} },
  querySelector(selector) { return el(selector.match(/data-rx-([^\]]+)/)[1]); },
  addEventListener(type, callback) { events.set(`root:${type}`, callback); }
};
const sample = id => ({ id, title: `${id} example`, state: "complete", audio_url: `/api/rap-experiment/audio/${id}.wav`,
  ...(id === "music" ? { full_mix_url: "/api/rap-experiment/audio/full.wav" } : {}), model_id: "eleven_multilingual_v2", sample_rate: 44100, notes: ["Playback levels are matched for comparison, with clipping protection."] });
let current = { id: "saved-one", state: "complete", text: "Saved lyrics\nSecond line", bpm: 105, voice_id: "main", alternate_voice_id: "other", delivery: "gritty",
  sources: { baseline: { state: "complete" }, expressive: { state: "complete" } },
  examples: [sample("baseline"), sample("phrases"), sample("music"), { id: "alternate", state: "failed", error: "Voice unavailable <script>" }] };
const response = (data, ok = true, status = 200) => ({ ok, status, json: async () => clone(data), arrayBuffer: async () => new ArrayBuffer(16) });
class AudioContext {
  constructor() { this.currentTime = 0; this.destination = {}; }
  async resume() {}
  async decodeAudioData() { return { duration: 8 }; }
  createGain() { return { gain: { value: 1, setTargetAtTime() {}, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  createBufferSource() {
    const source = { stopped: false, disconnect() {}, connect() {}, start() { this.started = true; }, stop() { this.stopped = true; }, onended: null };
    sources.push(source); return source;
  }
  createOscillator() { return { frequency: {}, connect() {}, disconnect() {}, start() {}, stop() {} }; }
}
const context = vm.createContext({
  console, AudioContext, AbortController, setTimeout: (cb, delay) => { pollDelays.push(delay); timers.set(++nextTimer, cb); return nextTimer; }, clearTimeout: id => timers.delete(id),
  setInterval: cb => { timers.set(++nextTimer, cb); return nextTimer; }, clearInterval: id => timers.delete(id),
  localStorage: { getItem: () => JSON.stringify(stored), setItem: (_key, value) => { stored = JSON.parse(value); } },
  crypto: { randomUUID: () => `request-${posts.length + 1}` },
  fetch: async (url, options = {}) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body));
      if (nextFailure) { const error = nextFailure; nextFailure = null; throw error; }
      if (deferredPost) return deferredPost.promise;
      const body = posts.at(-1);
      return response({ ...current, robot_style: body.robot_style, robot_key: body.robot_key, robot_scale: body.robot_scale,
        robot_melody: body.robot_melody, robot_octave: body.robot_octave, robot_note_beats: body.robot_note_beats,
        robot_rhythm: body.robot_rhythm,
        id: `new-${posts.length}`, state: "queued", variants: body.variants || ["baseline", "phrases", "fresh", "alternate", "expressive", "bars", "produced", "music"] });
    }
    gets.push(url);
    if (url.endsWith("/status")) return response({ default_voice_id: serviceDefault, default_alternate_voice_id: "other", suggested_voices: suggestions });
    if (url.endsWith("/voices")) return catalog ? response({ voices: catalog, default_voice_id: "main" }) : response({ error: "Missing voices_read" }, false, 401);
    if (url.endsWith("/experiments")) return response({ experiments: library || [current] });
    if (url.includes("/audio/")) return response({});
    return response(library?.find(item => item.id === decodeURIComponent(url.split("/").at(-1))) || current);
  }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/rap-experiment.js"), "utf8"), context, { filename: "rap-experiment.js" });
const app = context.HydraRapExperiment;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
async function trigger(name, type = "click") { const result = events.get(`${name}:${type}`)?.(); await result; await settle(); }
async function card(action, id) { events.get("root:click")({ target: { closest: () => ({ dataset: { [action]: id } }) } }); await settle(); }

(async () => {
  app.init({ container: root });
  assert.match(root.innerHTML, /Rap experiment/);
  assert.match(root.innerHTML, /maxlength="1000"/);
  assert.match(root.innerHTML, /max="240"/);
  assert.match(root.innerHTML, /Fast robot/);
  assert.match(root.innerHTML, /Generate fast voice/);
  assert.match(root.innerHTML, /Effect amount/);
  assert.match(root.innerHTML, /value="autotune">Autotune/);
  assert.doesNotMatch(root.innerHTML, /value="vocoder"/);
  assert.equal(app.getState().robot_style, "autotune");
  assert.equal(app.getState().robot_key, 0);
  assert.equal(app.getState().robot_scale, "minor");
  assert.equal(el("tuning-controls").hidden, false);
  assert.equal(app.getState().robot_amount, 1);
  assert.equal(app.getState().robot_tone_hz, 6000);
  assert.equal(app.getState().robot_melody, "follow");
  assert.equal(app.getState().robot_octave, 3);
  assert.equal(app.getState().robot_note_beats, 1);
  assert.equal(app.getState().robot_rhythm, "natural");
  assert.match(root.innerHTML, /data-rx-robot-rhythm aria-describedby="rx-rhythm-help"/);
  assert.match(root.innerHTML, /value="flow">Beat flow/);
  assert.match(el("rhythm-help").textContent, /original speech rhythm/);
  assert.equal(el("melody-controls").hidden, true);
  assert.equal(el("apply-robot").disabled, true, "effects cannot generate a voice implicitly");
  assert.equal((el("cards").innerHTML.match(/data-rx-card=/g) || []).length, 8, "initial comparison placeholders remain available");
  assert.equal(posts.length, 0);
  assert.equal(gets.length, 0, "initialization stays passive");
  assert.match(el("text").value, /Signals rise/);
  app.activate(); await settle();
  assert.equal(el("text").value, current.text, "first visit adopts the latest saved examples");
  assert.equal(app.getState().experiment_id, "saved-one");
  assert.equal(el("bpm").value, 105);
  assert.equal(app.getState().robot_rhythm, "natural", "legacy saved comparisons keep their original rhythm");
  assert.equal(sources.length, 0, "saved examples never auto-play");
  assert.equal(posts.length, 0, "visiting never generates audio");
  assert.equal(el("voice-custom").hidden, true, "saved default voice stays simple despite catalog denial");
  assert.equal(el("voice-select").value, "");
  assert.match(el("voice-select").innerHTML, /Default · George/);
  assert.match(el("voice-select").innerHTML, /value="jade">Jade/);
  assert.match(el("voice-select").innerHTML, /value="elara">Elara/);
  assert.equal(el("voice").value, "main", "hiding default voice ID preserves its value");
  assert.equal(el("alternate-custom").hidden, true);
  assert.equal(el("alternate-select").value, "");
  assert.equal(el("alternate").value, "other");
  assert.match(el("cards").innerHTML, /Eleven Multilingual v2/);
  assert.doesNotMatch(el("cards").innerHTML, /Playback levels are matched/);
  assert.match(el("cards").innerHTML, /data-rx-take="phrases"[^>]*>Apply timing/);
  assert.equal(el("voice-status").textContent, "Suggested voices available. Use a custom voice ID for another voice.");
  assert.match(el("saved").innerHTML, /Saved lyrics · George/);
  assert.match(el("cards").innerHTML, /George · Eleven Multilingual v2/);
  assert.match(el("cards").innerHTML, /Warren/, "alternate example identifies its own voice");
  assert.equal((el("cards").innerHTML.match(/data-rx-card=/g) || []).length, 4, "saved comparisons show only their requested examples");
  assert.match(el("cards").innerHTML, /Voice unavailable &lt;script&gt;/);
  assert.match(el("cards").innerHTML, /Isolated vocals/);
  assert.match(el("cards").innerHTML, /Full mix/);

  await card("rxPlay", "baseline");
  assert.equal(sources.length, 1); assert.equal(sources[0].started, true);
  await card("rxPlay", "phrases");
  assert.equal(sources[0].stopped, true, "comparison only plays one sample at a time");
  assert.equal(sources.length, 2);
  await card("rxFull", "music");
  assert.equal(sources[1].stopped, true); assert.match(el("now").textContent, /Full mix/);
  app.deactivate(); assert.equal(sources[2].stopped, true, "leaving stops audio");
  app.activate(); await settle(); assert.equal(sources.length, 3, "returning does not auto-play");

  await card("rxTake", "bars");
  assert.deepEqual(posts[0].variants, ["bars"]);
  assert.equal(posts[0].source_experiment_id, "saved-one");
  assert.equal(posts[0].voice_id, "main");
  assert.equal(el("generate").disabled, true);
  assert.equal(el("fast").disabled, false, "accepted slow work does not block starting a fast voice");
  assert.equal(sources.length, 3, "preparing never plays audio");
  assert.equal(app.getState().experiment_id, "new-1");
  assert.equal(app.getState().pending, null, "accepted requests are recovered by experiment ID");
  current = { ...current, id: "new-1", state: "partial", examples: [sample("baseline"), { id: "bars", state: "failed", error: "Stretch failed" }] };
  await trigger("refresh");
  assert.match(el("status").textContent, /1 examples ready · 1/);
  assert.match(el("cards").innerHTML, /audio\/baseline.wav/);
  assert.match(el("cards").innerHTML, /Stretch failed/);

  nextFailure = new Error("Connection lost");
  await trigger("generate");
  const failedId = posts.at(-1).request_id;
  assert.equal(app.getState().pending.request_id, failedId);
  assert.equal(el("generate").textContent, "Recover comparison");
  app.deactivate(); app.activate(); await settle();
  assert.equal(app.getState().pending.request_id, failedId, "navigation preserves unknown POST while a previous experiment is selected");
  assert.equal(posts.length, 2, "navigation never replays a paid request");
  await trigger("generate");
  assert.equal(posts.at(-1).request_id, failedId, "recovery reuses request ID");
  assert.equal(posts.length, 3);

  app.restore({ text: "Different text", bpm: 120, voice_id: "custom-id", delivery: "relaxed", experiment_id: "saved-one", volume: .6 }); await settle();
  assert.equal(el("text").value, "Different text", "restoring a draft is not overwritten by saved audio");
  assert.equal(el("bpm").value, 120);
  assert.equal(el("voice-custom").hidden, false, "non-default custom IDs remain editable");
  assert.equal(posts.length, 3);
  assert.equal(el("voice-select").value, "__custom__");
  await card("rxPlay", "baseline");
  app.restore({ text: "Restored", bpm: 100 });
  assert.equal(sources.at(-1).stopped, true, "restore stops playback");
  app.deactivate();
  assert.equal(timers.size, 0, "deactivation clears polling and audio timers");

  current = { ...current, id: "unknown-job", state: "unknown", examples: [sample("baseline"), { id: "music", state: "unknown", error: "Interrupted" }] };
  app.restore({ text: current.text, bpm: 240, voice_id: "", alternate_voice_id: "", delivery: current.delivery, experiment_id: current.id });
  app.activate(); await settle();
  assert.equal(el("bpm").value, 240);
  assert.equal(timers.size, 0, "interrupted provider outcomes are terminal, not polled forever");
  await card("rxTake", "phrases");
  assert.equal(posts.at(-1).source_experiment_id, "unknown-job", "blank main voice resolves to default for source matching");
  assert.equal(posts.at(-1).alternate_voice_id, "other", "default alternate voice is sent when no custom ID is chosen");

  app.restore({ text: "Edited lyrics", bpm: 100, voice_id: "main", delivery: "gritty", experiment_id: current.id }); await settle();
  await card("rxTake", "bars");
  assert.equal(posts.at(-1).source_experiment_id, undefined, "edited lyrics generate a source rather than submitting a mismatched source");
  app.restore({ text: current.text, bpm: 100, voice_id: current.voice_id, delivery: current.delivery, experiment_id: current.id }); await settle();
  await card("rxTake", "baseline");
  assert.equal(posts.at(-1).source_experiment_id, undefined, "fresh baseline never claims to reuse a selected source");
  current = { ...current, sources: {}, state: "complete" };
  app.restore({ text: current.text, bpm: 100, voice_id: current.voice_id, delivery: current.delivery, experiment_id: current.id }); await settle();
  await card("rxTake", "bars");
  assert.equal(posts.at(-1).source_experiment_id, undefined, "missing expressive source causes a fresh source request");
  app.deactivate();
  assert.equal(timers.size, 0);
  {
    const previous = clone(stored), originalSet = context.localStorage.setItem;
    const quota = new Error("Browser storage is full");
    context.localStorage.setItem = () => { throw quota; };
    el("text").value = "The latest comparison words";
    assert.doesNotThrow(() => events.get("text:input")(), "ordinary editing still works when autosave fails");
    assert.equal(app.getState().text, "The latest comparison words");
    assert.deepEqual(stored, previous);
    assert.throws(() => app.flush({ strict: true }), error => error === quota,
      "explicit session capture cannot silently keep stale comparison settings");
    context.localStorage.setItem = originalSet;
    app.flush({ strict: true });
    assert.equal(stored.text, "The latest comparison words");
  }

  current = { ...current, id: "fast-saved", state: "complete", variants: ["flash", "robot"], sources: { flash: { state: "complete" } },
    robot_style: "radio", robot_amount: .7, robot_tone_hz: 3000, timings: { ready_seconds: 1.4 },
    examples: [ { ...sample("flash"), model_id: "eleven_flash_v2_5", sample_rate: 24000, timings: { source_seconds: 1.2, processing_seconds: .03, ready_seconds: 1.23 } },
      { ...sample("robot"), model_id: "eleven_flash_v2_5", timings: { source_seconds: 1.2, processing_seconds: .15, ready_seconds: 1.4 } } ] };
  const restoreFast = async (changes = {}) => { app.restore({ ...current, experiment_id: current.id, ...changes }); app.activate(); await settle(); };
  await restoreFast();
  assert.match(el("saved").innerHTML, /Fast \+ Radio · Saved lyrics/);
  assert.equal((el("cards").innerHTML.match(/data-rx-card=/g) || []).length, 2, "fast job shows its two examples without blank comparison cards");
  assert.doesNotMatch(el("cards").innerHTML, /data-rx-card="music"/);
  assert.match(el("cards").innerHTML, /Eleven Flash 2.5/);
  assert.match(el("cards").innerHTML, /Voice 1.20 s · Processing 0.15 s · Ready in 1.40 s/);
  assert.match(el("job-timing").textContent, /1.40 s/);
  assert.equal(app.getState().robot_style, "radio");
  assert.equal(app.getState().robot_amount, .7);
  assert.equal(app.getState().robot_tone_hz, 3000);
  assert.equal(el("apply-robot").disabled, false);
  assert.equal(el("tuning-controls").hidden, true, "Radio does not show musical tuning controls");
  el("robot-style").value = "autotune"; await trigger("robot-style", "change");
  assert.equal(el("tuning-controls").hidden, false);
  el("robot-key").value = "0"; await trigger("robot-key", "change");
  el("robot-scale").value = "major"; await trigger("robot-scale", "change");
  el("robot-amount").value = "92"; await trigger("robot-amount", "input");
  el("robot-tone").value = "5600"; await trigger("robot-tone", "input");
  el("delivery").value = "relaxed"; await trigger("delivery", "change");
  el("bpm").value = "140"; await trigger("bpm", "input");
  el("robot-rhythm").value = "flow"; await trigger("robot-rhythm", "change");
  assert.equal(el("rhythm-help").textContent, "Fit whole phrases to the beat.");
  assert.equal(el("robot-amount-value").textContent, "92%");
  assert.equal(el("robot-tone-value").textContent, "5.6 kHz");
  await trigger("apply-robot");
  assert.deepEqual(posts.at(-1).variants, ["robot"]);
  assert.match(el("saved").innerHTML, /Robot · Autotune · C major · Follow voice · Beat flow · Saved lyrics/, "saved autotune jobs include key, scale, melody and rhythm");
  assert.equal(posts.at(-1).source_experiment_id, "fast-saved", "robot effects reuse the matching flash source despite delivery/BPM changes");
  assert.equal(posts.at(-1).include_clean, true, "effect changes retain a clean companion without new TTS");
  assert.equal(posts.at(-1).robot_style, "autotune");
  assert.equal(posts.at(-1).robot_key, 0, "C is sent as numeric zero, not omitted as a falsy value");
  assert.equal(posts.at(-1).robot_scale, "major");
  assert.equal(posts.at(-1).robot_amount, .92);
  assert.equal(posts.at(-1).robot_tone_hz, 5600);
  assert.equal(posts.at(-1).robot_rhythm, "flow");
  assert.equal(stored.robot_rhythm, "flow", "rhythm edits persist with the other effect controls");
  assert.match(el("cards").innerHTML, /clean recording, with whole phrases fitted to the beat/);
  assert.match(el("cards").innerHTML, /same timed recording, shaped with robot voice effects/);
  assert.equal((el("cards").innerHTML.match(/Rhythm · Beat flow/g) || []).length, 2, "clean and tuned comparisons identify the same timing treatment");
  assert.equal(pollDelays.at(-1), 200, "fast job ready state is checked promptly");
  assert.equal(el("fast").disabled, true, "cannot duplicate an active fast request");
  assert.equal(stored.robot_amount, .92);
  assert.equal(stored.robot_key, 0);
  assert.equal(stored.robot_scale, "major");

  await restoreFast({ robot_style: "autotune", robot_melody: "hook", robot_octave: 4, robot_note_beats: .5, robot_rhythm: "phrases" });
  assert.equal(el("melody-controls").hidden, false);
  assert.equal(el("chromatic-label").textContent, "Chromatic (major melody)");
  assert.equal(el("rhythm-help").textContent, "Start whole phrases on the beat.");
  await trigger("apply-robot");
  assert.equal(posts.at(-1).robot_melody, "hook");
  assert.equal(posts.at(-1).robot_octave, 4);
  assert.equal(posts.at(-1).robot_note_beats, .5, "half-beat speed remains a numeric value");
  assert.equal(posts.at(-1).robot_rhythm, "phrases");
  assert.equal(stored.robot_rhythm, "phrases");
  assert.equal(stored.robot_melody, "hook");
  assert.equal(stored.robot_octave, 4);
  assert.equal(stored.robot_note_beats, .5);
  assert.match(el("saved").innerHTML, /Pop hook · Octave 4 · 0.5 beats\/note/);
  assert.match(el("cards").innerHTML, /Pop hook · Octave 4 · 0.5 beats\/note/);
  await restoreFast({ robot_style: "metallic", robot_melody: "hook", robot_octave: 4, robot_note_beats: .5 });
  assert.equal(el("melody-controls").hidden, true, "musical controls stay hidden for non-tuning effects");
  await restoreFast({ robot_style: "autotune", robot_melody: "invalid", robot_octave: 99, robot_note_beats: 0, robot_rhythm: "invalid", robot_amount: 0, robot_tone_hz: 800 });
  assert.equal(app.getState().robot_melody, "follow");
  assert.equal(app.getState().robot_octave, 3);
  assert.equal(app.getState().robot_note_beats, 1);
  assert.equal(app.getState().robot_rhythm, "natural", "invalid stored rhythm falls back to unchanged timing");
  assert.equal(app.getState().robot_amount, 0, "a saved zero effect value remains zero despite new stronger defaults");
  assert.equal(app.getState().robot_tone_hz, 800);
  assert.equal(el("melody-controls").hidden, true);
  assert.equal(el("chromatic-label").textContent, "Chromatic");
  for (const melody of ["drone", "two_note", "rising", "falling", "arpeggio", "hook"]) {
    el("robot-melody").value = melody; await trigger("robot-melody", "change");
    assert.equal(app.getState().robot_melody, melody);
    assert.equal(el("melody-controls").hidden, false);
  }
  el("robot-octave").value = "2"; await trigger("robot-octave", "change");
  el("robot-note-beats").value = "2"; await trigger("robot-note-beats", "change");
  assert.equal(app.getState().robot_octave, 2);
  assert.equal(app.getState().robot_note_beats, 2);

  await restoreFast({ text: "New lyrics" });
  assert.equal(el("apply-robot").disabled, true);
  let count = posts.length;
  await trigger("apply-robot");
  await card("rxTake", "robot");
  assert.equal(posts.length, count, "Apply effects never makes a paid request for changed lyrics");
  await restoreFast({ voice_id: "different-voice" });
  assert.equal(el("apply-robot").disabled, true);
  await trigger("apply-robot");
  assert.equal(posts.length, count, "Apply effects refuses a mismatched voice");
  await restoreFast({ voice_id: "" });
  assert.equal(el("apply-robot").disabled, false, "blank voice resolves to service default for Flash reuse");
  await card("rxTake", "flash");
  assert.deepEqual(posts.at(-1).variants, ["flash"]);
  assert.match(el("saved").innerHTML, /Fast clean · Saved lyrics/);
  assert.equal(posts.at(-1).source_experiment_id, undefined, "Fast clean New take always requests a new recording");
  assert.equal(posts.at(-1).include_clean, undefined);

  await restoreFast({ robot_rhythm: "flow" });
  await trigger("fast");
  assert.deepEqual(posts.at(-1).variants, ["flash", "robot"]);
  assert.equal(posts.at(-1).source_experiment_id, undefined, "Generate fast voice creates a fresh shared source");
  assert.equal(posts.at(-1).robot_rhythm, "flow", "fresh fast voice generation includes the selected rhythm");
  assert.equal(pollDelays.at(-1), 200);
  await restoreFast({ robot_style: "autotune", robot_key: 9, robot_scale: "chromatic", robot_melody: "two_note", robot_octave: 5, robot_note_beats: 2, robot_rhythm: "flow" });
  nextFailure = new Error("Connection lost");
  await trigger("fast");
  const fastPendingId = posts.at(-1).request_id;
  assert.equal(posts.at(-1).robot_key, 9);
  assert.equal(posts.at(-1).robot_scale, "chromatic");
  assert.equal(el("fast").textContent, "Recover fast voice");
  assert.equal(el("generate").disabled, true, "unknown fast request is recovered through its own button");
  el("robot-key").value = "2"; await trigger("robot-key", "change");
  el("robot-scale").value = "minor"; await trigger("robot-scale", "change");
  el("robot-melody").value = "rising"; await trigger("robot-melody", "change");
  el("robot-octave").value = "2"; await trigger("robot-octave", "change");
  el("robot-note-beats").value = "0.5"; await trigger("robot-note-beats", "change");
  el("robot-rhythm").value = "natural"; await trigger("robot-rhythm", "change");
  const pendingSnapshot = clone(app.getState());
  app.restore(pendingSnapshot); await settle();
  assert.equal(app.getState().robot_rhythm, "natural", "restoration retains the edited draft while a request is pending");
  await trigger("fast");
  assert.equal(posts.at(-1).request_id, fastPendingId);
  assert.equal(posts.at(-1).robot_key, 9, "recovery retains the original key despite later draft changes");
  assert.equal(posts.at(-1).robot_scale, "chromatic");
  assert.equal(posts.at(-1).robot_melody, "two_note", "recovery retains the submitted melody despite draft edits");
  assert.equal(posts.at(-1).robot_octave, 5);
  assert.equal(posts.at(-1).robot_note_beats, 2);
  assert.equal(posts.at(-1).robot_rhythm, "flow", "recovery keeps the submitted rhythm despite later edits and session restoration");

  const legacyPending = clone(posts.at(-1));
  delete legacyPending.robot_rhythm;
  await restoreFast({ pending: legacyPending, robot_rhythm: "phrases" });
  await trigger("fast");
  assert.deepEqual(posts.at(-1), legacyPending, "recovering a legacy request never adds the new rhythm field or changes its identity");

  const originalFast = clone(current);
  current = { ...current, robot_rhythm: "flow", examples: current.examples.map(example => ({ ...example, rhythm_mode: "phrases" })) };
  await restoreFast();
  assert.equal((el("cards").innerHTML.match(/Rhythm · Phrases on beats/g) || []).length, 2, "rendered timing metadata takes precedence over job settings");
  assert.match(el("cards").innerHTML, /whole phrase starts placed on beats/);
  assert.doesNotMatch(el("cards").innerHTML, /Rhythm · Beat flow/);
  current = originalFast;

  current = { ...current, id: "legacy-vocoder", robot_style: "vocoder" };
  await restoreFast();
  assert.equal(app.getState().robot_style, "autotune", "legacy Vocoder restores Autotune for the next effect request");
  assert.equal(el("tuning-controls").hidden, false);
  assert.match(el("saved").innerHTML, /Fast \+ Vocoder · Saved lyrics/, "saved Vocoder recordings retain their original label");
  assert.match(el("cards").innerHTML, /Vocoder/, "the existing recording remains labeled by its original effect");
  count = posts.length;
  await card("rxPlay", "robot");
  assert.equal(sources.at(-1).started, true, "legacy Vocoder recordings remain playable");
  assert.equal(posts.length, count);
  await restoreFast({ robot_key: 99, robot_scale: "invalid" });
  assert.equal(app.getState().robot_key, 0);
  assert.equal(app.getState().robot_scale, "minor");
  el("robot-style").value = "metallic"; await trigger("robot-style", "change");
  assert.equal(el("tuning-controls").hidden, true);
  await restoreFast({ robot_style: "autotune", robot_key: 3, robot_scale: "minor" });
  assert.equal(app.getState().robot_key, 3);
  assert.equal(app.getState().robot_scale, "minor");
  await trigger("apply-robot");
  assert.equal(posts.at(-1).robot_style, "autotune");
  assert.equal(posts.at(-1).robot_key, 3);
  assert.equal(posts.at(-1).source_experiment_id, "legacy-vocoder", "legacy source can receive new autotune effects locally");
  assert.match(el("saved").innerHTML, /Robot · Autotune · E♭ minor/);

  catalog = [{ voice_id: "main", name: "George catalog name" }, { voice_id: "catalog-only", name: "A catalog voice" }, { invalid: true }];
  await restoreFast();
  assert.equal((el("voice-select").innerHTML.match(/value="main"/g) || []).length, 1, "catalog entries merge with suggestions without duplicate IDs");
  assert.match(el("voice-select").innerHTML, /value="main">George catalog name/);
  assert.match(el("voice-select").innerHTML, /value="jade">Jade/, "suggestions remain alongside the full catalog");
  assert.match(el("voice-select").innerHTML, /value="catalog-only">A catalog voice/);
  assert.equal(el("voice-status").textContent, "");
  assert.equal(el("voice-custom").hidden, true, "catalog merge retains simple default voice selection");
  assert.equal(el("voice-select").value, "");
  assert.match(el("saved").innerHTML, />George catalog name · Fast \+ Vocoder · Saved lyrics/, "fast comparisons lead with voice identity");
  assert.match(el("cards").innerHTML, /George catalog name · Eleven Flash 2.5/);
  el("voice-select").value = "jade"; await trigger("voice-select", "change");
  assert.equal(app.getState().voice_id, "jade");
  assert.equal(el("voice-custom").hidden, true, "suggested voices need no custom ID entry");
  assert.equal(el("apply-robot").disabled, true, "changing to a suggested voice requires a new recording");
  serviceDefault = "jade";
  await restoreFast({ voice_id: "" });
  assert.match(el("voice-select").innerHTML, /Default · Jade/, "the experimental service default wins over a generic catalog default");
  assert.equal(app.getState().voice_id, "");
  await restoreFast({ voice_id: "main" });
  assert.equal(app.getState().voice_id, "main", "the new Jade default never overwrites an explicitly saved voice");
  assert.equal(el("voice-select").value, "main");
  serviceDefault = "main";
  current = { ...current, voice_id: "unknown-voice-id" };
  await restoreFast();
  assert.match(el("saved").innerHTML, />Voice unknown-… · Fast \+ Vocoder · Saved lyrics/);
  assert.match(el("cards").innerHTML, /Voice unknown-… · Eleven Flash 2.5/);
  catalog = null;

  current = { ...current, state: "generating", variants: ["music"], examples: [{ id: "music", state: "generating" }] };
  await restoreFast();
  assert.equal(el("fast").disabled, false);
  count = posts.length;
  await trigger("fast");
  assert.equal(posts.length, count + 1, "a fast request can start while music generation continues in its own queue");
  assert.deepEqual(posts.at(-1).variants, ["flash", "robot"]);
  app.deactivate();
  assert.equal(timers.size, 0);

  const audition = (id, group, label) => ({ ...current, id, state: "complete", voice_id: "main", variants: ["flash", "robot"],
    robot_style: "autotune", examples: [sample("flash"), { ...sample("robot"), robot: { style: "autotune", applied: true, voiced_fraction: id === "c1" ? .096 : .6 } }], audition_group: group, audition_label: label });
  library = [{ ...audition("other-one"), state: "failed" }, audition("c1", "bright", "C1 · Elara · bright tuning"), audition("a10", "clear", "A10 · <Voice>"),
    { ...audition("n2", "neutral", "N02 · Neutral · Beat flow"), robot_rhythm: "flow" }, audition("n1", "neutral", "N01 · Neutral · Natural"),
    audition("j2", "jade", "J2 · Jade · Pop hook"), audition("j1", "jade", "J1 · Jade · One note"),
    { ...audition("failed-a3", "clear", "A3 · Missing voice"), state: "failed" },
    { ...audition("error-b3", "deep", "B3 · Missing voice"), state: "error" },
    { ...audition("unknown-c3", "bright", "C3 · Interrupted voice"), state: "unknown" },
    { ...audition("b1", "deep", "B1 · George · low tuning"), state: "partial" }, audition("a2", "clear", "A2 · Jade · light tuning"), audition("a1", "clear", "A1 · Warren · light tuning"), audition("other-two")];
  current = library.find(item => item.id === "a1");
  await restoreFast();
  const menu = el("saved").innerHTML;
  assert.match(menu, /optgroup label="Neutral · Rhythm"/);
  assert.match(menu, /optgroup label="Jade · Melodies"/);
  assert.match(menu, /optgroup label="Clear &amp; rhythmic"/);
  assert.match(menu, /optgroup label="Deep &amp; gritty"/);
  assert.match(menu, /optgroup label="Bright &amp; synthetic"/);
  assert.match(menu, /optgroup label="Other comparisons"/);
  const orderedIds = [...menu.matchAll(/<option value="([^\"]+)"/g)].map(match => match[1]);
  assert.deepEqual(orderedIds, ["n1", "n2", "j1", "j2", "a1", "a2", "a10", "b1", "c1", "other-one", "failed-a3", "error-b3", "unknown-c3", "other-two"], "Neutral rhythm leads the naturally sorted review groups; Jade and older directions remain accessible");
  assert.match(menu, /<option value="failed-a3">Unavailable · George<\/option>/);
  assert.match(menu, /<option value="error-b3">Unavailable · George<\/option>/);
  assert.match(menu, /<option value="unknown-c3">Unavailable · George<\/option>/);
  assert.doesNotMatch(menu, /<option value="other-one">Unavailable/, "ordinary failed comparisons keep their usual historical label");
  assert.doesNotMatch(menu, /A3 · Missing voice|B3 · Missing voice|C3 · Interrupted voice/, "unavailable attempts do not compete with replacement sample labels");
  assert.ok(menu.indexOf('value="failed-a3"') > menu.indexOf('optgroup label="Other comparisons"'));
  assert.match(menu, /A10 · &lt;Voice&gt;/);
  assert.equal(el("comparison").textContent, "A1 · Warren · light tuning");
  assert.doesNotMatch(el("cards").innerHTML, /Only a small part of this voice/, "normal voiced samples do not show a tuning caveat");
  assert.match(el("audition-meta").textContent, /Clear & rhythmic · George · 105 BPM/);
  assert.equal(el("previous").disabled, false);
  assert.equal(el("next").disabled, false);
  el("saved").value = "n1"; await trigger("saved", "change");
  assert.equal(el("previous").disabled, true);
  assert.match(el("audition-meta").textContent, /Neutral · Rhythm/);
  assert.equal(app.getState().robot_rhythm, "natural");
  await trigger("next");
  assert.equal(app.getState().robot_rhythm, "flow", "selecting a saved comparison restores its rhythm setting");
  assert.equal(stored.robot_rhythm, "flow");
  await trigger("next");
  assert.equal(app.getState().experiment_id, "j1");
  assert.equal(app.getState().robot_rhythm, "natural", "browsing from a rhythmic take to a legacy take restores natural timing");
  assert.equal(el("comparison").textContent, "J1 · Jade · One note");
  assert.match(el("audition-meta").textContent, /Jade · Melodies/);
  el("saved").value = "a1"; await trigger("saved", "change");
  await card("rxPlay", "robot");
  const beforeBrowse = sources.length;
  count = posts.length;
  await trigger("next");
  assert.equal(app.getState().experiment_id, "a2");
  assert.equal(sources.at(-1).stopped, true, "browsing stops the previous sample");
  assert.equal(sources.length, beforeBrowse, "browsing never auto-plays the next sample");
  assert.equal(posts.length, count, "browsing existing samples is read-only");
  assert.equal(el("comparison").textContent, "A2 · Jade · light tuning");
  const savedAudition = clone(app.getState());
  app.restore(savedAudition); await settle();
  assert.equal(app.getState().experiment_id, "a2", "session restoration retains the selected sample");
  assert.equal(sources.length, beforeBrowse);
  await trigger("next");
  assert.equal(app.getState().experiment_id, "a10");
  await trigger("next");
  assert.equal(app.getState().experiment_id, "b1", "Next crosses groups in visual order");
  await trigger("previous");
  assert.equal(app.getState().experiment_id, "a10");
  el("saved").value = "other-two"; await trigger("saved", "change");
  assert.equal(el("next").disabled, true);
  await trigger("next");
  assert.equal(app.getState().experiment_id, "other-two", "navigation does not wrap past the final sample");
  assert.equal(el("audition-meta").textContent, "", "ordinary comparisons keep their original heading");
  el("saved").value = "failed-a3"; await trigger("saved", "change");
  assert.equal(app.getState().experiment_id, "failed-a3", "unavailable auditions remain accessible in Other comparisons");
  assert.equal(el("comparison").textContent, "A3 · Missing voice", "the original failed attempt retains its details");
  el("saved").value = "c1"; await trigger("saved", "change");
  assert.equal((el("cards").innerHTML.match(/Only a small part of this voice can be tuned; very low or unpitched sections stay unchanged\./g) || []).length, 1, "only the low-voiced tuned card explains why tuning has less effect");
  el("saved").value = "a2"; await trigger("saved", "change");
  assert.doesNotMatch(el("cards").innerHTML, /Only a small part of this voice/);
  nextFailure = new Error("Connection lost");
  await trigger("fast");
  const auditionPending = app.getState().pending.request_id;
  assert.equal(posts.at(-1).audition_group, undefined, "manual takes never inherit a curated audition group");
  assert.equal(posts.at(-1).audition_label, undefined, "manual takes never inherit a curated sample label");
  assert.equal(el("saved").disabled, true);
  assert.equal(el("previous").disabled, true);
  assert.equal(el("next").disabled, true);
  await trigger("next");
  await trigger("previous");
  el("saved").value = "c1"; await trigger("saved", "change");
  assert.equal(app.getState().experiment_id, "a2", "ambiguous POST keeps its selected job while awaiting recovery");
  assert.equal(el("saved").value, "a2");
  assert.equal(app.getState().pending.request_id, auditionPending);
  await trigger("fast");
  assert.equal(posts.at(-1).request_id, auditionPending, "audition browsing preserves safe request recovery");
  app.deactivate();
  assert.equal(timers.size, 0);
  console.log("Rap experiment UI: comparison playback, request recovery, fast generation, reusable robot effects, measured timing, state persistence and independent fast queue passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
