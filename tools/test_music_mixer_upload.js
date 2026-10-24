"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const copy = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let index = 0; index < 35; index++) await Promise.resolve(); };
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => copy(data) });
const file = { name: "My rehearsal.wav", size: 4096, type: "audio/wav" };
const stems = [{ id: "vocals", name: "Vocals", audio_url: "/voice.wav" }, { id: "drums", name: "Drums", audio_url: "/drums.wav" }];
const uploaded = id => ({ id, plan_id: `plan-${id}`, origin: "uploaded", name: "My rehearsal", state: "complete", separate_stems: false,
  requested_duration_seconds: null, audio: { duration_seconds: 30 }, audio_url: `/api/elevenlabs/generations/${id}/audio` });
const KEY = "hydra.music-mixer.demo.v1", UPLOAD_KEY = "hydra.music-mixer.upload.v1";

function harness(options = {}) {
  const elements = new Map(), handlers = {}, calls = [], jobs = new Map(), separations = new Map(), analyses = new Map(), timers = new Map();
  const storage = options.storage || new Map(), selected = [], generationCalls = [], beatPreparations = [];
  let timerId = 0, config, engine, emit, fetchHook, generationUpdate;
  let snapshot = { fields: [], buses: [], channels: [], running: false, starting: false, track: null };
  function element(id) {
    if (!elements.has(id)) elements.set(id, { id: `mm-${id}`, value: "", innerHTML: "", textContent: "", disabled: false, hidden: false,
      classList: { toggle() {} }, dataset: {}, hasAttribute: () => false,
      closest(selector) { return selector === "button" ? this : null; } });
    return elements.get(id);
  }
  const root = { classList: { add() {} }, querySelector: selector => element(selector.slice(4)), querySelectorAll: () => [],
    addEventListener(type, handler) { handlers[type] = handler; } };
  const context = vm.createContext({ AbortController, crypto: crypto.webcrypto, performance: { now: () => 0 },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; }, clearTimeout(id) { timers.delete(id); },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    HydraMusicMixerGeneration: { create(options) { generationUpdate = options.onUpdate; return {
      snapshot() { return { phase: "idle", enabled: false }; },
      update() {}, settingsChanged() {}, stop() { generationCalls.push("stop"); snapshot.running = false; snapshot.starting = false; emit(copy(snapshot)); }, deactivate() {},
      async recall(track) { generationCalls.push("recall"); await engine.setTrack(track); },
      resume() { generationCalls.push("resume"); snapshot.starting = snapshot.beatTiming?.state === "preparing"; snapshot.running = !snapshot.starting; emit(copy(snapshot)); }, startNew() { generationCalls.push("startNew"); }
    }; } },
    fetch: async (url, request = {}) => {
      const route = url.replace("/api/elevenlabs", ""), method = request.method || "GET";
      calls.push({ route, method, body: request.body, headers: request.headers });
      if (fetchHook) { const result = await fetchHook(route, request); if (result !== undefined) return result; }
      if (route === "/status") return response({ ready: options.ready !== false, beat_tracking_available: options.beatAvailable !== false,
        beat_tracking_setup_error: options.beatAvailable === false ? "Install local audio analysis dependencies." : null });
      if (route === "/plans") return response({ plans: [] });
      if (route === "/generations") return response({ jobs: [...jobs.values()] });
      if (route.startsWith("/uploads?")) {
        const id = new URLSearchParams(route.split("?")[1]).get("request_id"), job = uploaded(id);
        jobs.set(id, job); return response(job);
      }
      const match = route.match(/^\/generations\/([^/]+)(\/stems|\/beats)?$/);
      if (match) {
        const job = jobs.get(match[1]);
        if (!job) return response({ error: "Track not found" }, 404);
        if (!match[2]) return response(job);
        if (match[2] === "/beats") {
          if (method === "POST" && !["queued", "analyzing", "complete"].includes(analyses.get(job.id)?.state)) {
            const analysis = { state: "queued", beats_seconds: [] };
            analyses.set(job.id, analysis); job.beat_analysis = analysis;
          }
          return response(analyses.get(job.id) || { state: "not_requested", beats_seconds: [] });
        }
        if (method === "POST") {
          const separation = { state: "queued", stems: [] };
          separations.set(job.id, separation); job.stem_separation = separation;
        }
        return response(separations.get(job.id) || { state: "not_requested", stems: [] });
      }
      return response({ error: "Not found" }, 404);
    }
  });
  for (const filename of ["elevenlabs-realtime.js", "elevenlabs.js", "elevenlabs-player.js", "music-mixer-engine.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard", filename), "utf8"), context, { filename });
  }
  context.HydraMusicMixerEngine.create = engineOptions => {
    emit = engineOptions.onUpdate;
    engine = {
      setConfig(value) { config = copy(context.HydraMusicMixerEngine.validateConfig(value)); emit(copy(snapshot)); }, getConfig: () => copy(config),
      snapshot: () => copy(snapshot), activate() {}, deactivate() {},
      updateBeatAnalysis(id, analysis) {
        if (snapshot.running || snapshot.starting || snapshot.track?.id !== id) return false;
        snapshot.track = { ...snapshot.track, beat_analysis: copy(analysis) }; emit(copy(snapshot)); return true;
      },
      async prepareBeatTiming(value = {}) { beatPreparations.push(copy(value)); snapshot.beatTiming = { state: "preparing", trackId: snapshot.track.id }; emit(copy(snapshot)); return true; },
      async setTrack(track) {
        selected.push(copy(track)); snapshot = { ...snapshot, track, running: false, starting: false, beatTiming: null };
        if (track?.origin === "uploaded" && options.manualTiming) {
          config.beatTracking ??= {};
          config.beatTracking[track.id] ??= { enabled: false, mode: "manual" };
        } else if (track?.origin === "uploaded" && options.automaticTiming) {
          const previous = config.beatTracking?.[track.id] || {};
          config.beatTracking = { ...config.beatTracking, [track.id]: { ...previous, mode: "auto", enabled: true } };
          snapshot.beatTiming = { state: track.beat_analysis?.state === "complete" ? "ready" : "preparing", trackId: track.id };
        }
        emit(copy(snapshot));
      }
    };
    return engine;
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/music-mixer.js"), "utf8"), context);
  context.HydraMusicMixer.init({ container: root });
  return { root, element, calls, jobs, separations, analyses, selected, storage, generationCalls, beatPreparations, timers, context,
    get config() { return config; }, get current() { return copy(snapshot); },
    setFetch(hook) { fetchHook = hook; },
    setGeneration(value) { generationUpdate(value); },
    async activate() { await context.HydraMusicMixer.activate(); await settle(); },
    async chooseFile(value = file) { element("audio-file").files = [value]; handlers.change({ target: element("audio-file") }); await settle(); },
    async click(id) { handlers.click({ target: element(id) }); await settle(); },
    async select(id) { element("track").value = id; handlers.change({ target: element("track") }); await settle(); },
    async setBpm(value) { element("track-bpm").value = value; handlers.change({ target: element("track-bpm") }); await settle(); },
    async beatSetting(id, value) { element(id)[id === "use-beats" ? "checked" : "value"] = value; handlers.change({ target: element(id) }); await settle(); },
    setRunning(value) { snapshot.running = value; emit(copy(snapshot)); },
    beatTiming(state, analysis, error) {
      if (analysis) { snapshot.track = { ...snapshot.track, beat_analysis: copy(analysis) }; jobs.set(snapshot.track.id, copy(snapshot.track)); }
      snapshot.beatTiming = { state, trackId: snapshot.track.id, ...(error ? { error } : {}) }; emit(copy(snapshot));
    },
    async next(value) { const el = element("next-mode"); el.value = value; el.hasAttribute = attr => attr === "data-next-field"; handlers.change({ target: el }); await settle(); },
    async tick() { const scheduled = [...timers.values()]; timers.clear(); for (const callback of scheduled) callback(); await settle(); },
    separateAs(id, state, extra = {}) { const value = { state, stems: state === "complete" ? stems : [], ...extra }; separations.set(id, value); jobs.get(id).stem_separation = value; },
    analyzeAs(id, state, extra = {}) { const value = { state, beats_seconds: [], ...extra }; analyses.set(id, value); jobs.get(id).beat_analysis = value; },
    state() { return copy(context.HydraMusicMixer.getState()); }
  };
}

async function tests() {
  for (const state of ["unknown", "failed"]) {
    const recover = harness();
    const id = "saved-full-mix";
    recover.jobs.set(id, { id, plan_id: "saved-plan", name: "Saved generation", state: "complete", separate_stems: true,
      audio: { duration_seconds: 60 }, audio_url: "/saved.mp3", generation_settings: {}, stem_separation: { state, error: "Provider interrupted" } });
    await recover.activate();
    assert.match(recover.element("track").innerHTML, /Full mix only/, "complete music remains an explicit saved-track choice");
    await recover.next("new");
    if (state === "unknown") {
      recover.setGeneration({ phase: "error", enabled: false, pendingId: id, error: "Stem separation outcome unknown" });
      assert.equal(recover.element("use-full-mix").hidden, false);
      await recover.click("use-full-mix");
    } else await recover.select(id);
    assert.equal(recover.current.track.id, id);
    assert.equal(recover.current.track.stem_separation.state, state, "saved provider outcome is preserved");
    assert.deepEqual(recover.config.channels.map(channel => channel.name), ["master"]);
    assert.equal(recover.element("next-mode").value, "loop", "full-mix recovery disarms automatic paid generation");
    assert.equal(recover.current.running, false, "loading the mix waits for the user's Play action");
    assert.match(recover.element("notice").textContent, /Loaded the saved full mix/);
    await recover.click("play");
    assert.equal(recover.current.running, true);
    assert.equal(recover.calls.filter(call => call.method === "POST").length, 0, "full-mix selection and Play use no provider credits");
  }
  const h = harness(); await h.activate();
  assert.match(h.root.innerHTML, /<details id="mm-custom" class="mm-custom"><summary>Use your own audio<\/summary>/);
  assert.match(h.element("custom-status").textContent, /128 MB, no fixed duration limit/);
  assert.equal(h.element("custom-tempo").hidden, true);
  await h.chooseFile();
  const job = h.selected.at(-1), id = job.id;
  assert.equal(job.origin, "uploaded"); assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(h.calls.find(call => call.method === "POST").body, file, "upload sends the exact File bytes, not JSON or a local path");
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1, "choosing audio never submits separation");
  assert.equal(h.current.running, false); assert.equal(h.element("next-mode").value, "loop");
  assert.deepEqual(h.config.channels.map(channel => channel.name), ["master"]);
  assert.match(h.element("current").textContent, /My rehearsal · 30s · [a-f0-9]{8} · Uploaded/);
  assert.match(h.element("custom-cost").textContent, /Uploads this audio to ElevenLabs and uses credits/);
  assert.equal(h.element("separate").disabled, false);
  assert.equal(h.element("custom-tempo").hidden, false);
  assert.equal(h.element("track-bpm").value, "", "upload BPM starts unknown rather than inheriting the generation prompt");
  await h.setBpm("92.5");
  assert.equal(h.state().config.uploadedBpms[id], 92.5, "manual tempo is included in session state");
  assert.equal(JSON.parse(h.storage.get(KEY)).config.uploadedBpms[id], 92.5);
  assert.equal(h.config.channels[0].rate, 1, "entering source tempo does not stretch audio");
  const requestsBeforeTempo = h.calls.length;
  await h.setBpm("301");
  assert.equal(h.state().config.uploadedBpms[id], 92.5, "invalid tempo leaves the saved value intact");
  await h.setBpm("");
  assert.equal(h.state().config.uploadedBpms, undefined, "clearing tempo restores unknown");
  await h.setBpm("92.5");
  assert.equal(h.calls.length, requestsBeforeTempo, "tempo metadata is local and never triggers generation or separation");
  await h.next("similar");
  assert.equal(h.element("next-mode").value, "new");
  assert.match(h.element("notice").textContent, /uses your prompt/);

  const preflight = defer();
  h.setFetch((route, request) => route.endsWith("/stems") && !request.method ? preflight.promise : undefined);
  await h.click("separate"); await h.click("separate");
  assert.equal(h.calls.filter(call => call.route.endsWith("/stems")).length, 1, "double clicks share a single preflight");
  h.setFetch(null); preflight.resolve(response({ state: "not_requested", stems: [] })); await settle();
  assert.equal(h.calls.filter(call => call.method === "POST" && call.route.endsWith("/stems")).length, 1);
  assert.equal(h.element("separate").disabled, true); assert.match(h.element("custom-status").textContent, /separating stems/);
  h.separateAs(id, "generating"); await h.tick();
  assert.equal(h.timers.size, 1, "provider generating status keeps polling");
  h.separateAs(id, "complete"); await h.tick();
  assert.deepEqual(h.config.channels.map(channel => channel.name), ["master", "Vocals", "Drums"]);
  assert.equal(h.config.includeVocals, true); assert.equal(h.current.running, false);
  assert.equal(h.element("next-mode").value, "new", "finishing separation while stopped preserves the chosen next-track mode");
  assert.equal(h.calls.filter(call => call.method === "POST" && call.route.endsWith("/stems")).length, 1);
  const loadedCount = h.selected.length;
  await h.context.HydraMusicMixer.refresh(); await settle();
  assert.equal(h.selected.length, loadedCount, "refreshing completed custom audio preserves the loaded mixer");

  const sameName = uploaded("ffffffffffffffffffffffffffffffff");
  h.jobs.set(sameName.id, sameName); await h.context.HydraMusicMixer.refresh(); await settle();
  assert.match(h.element("track").innerHTML, /My rehearsal · 30s · ffffffff · Uploaded/);
  assert.match(h.element("track").innerHTML, new RegExp(`My rehearsal · 30s · ${id.slice(-8)} · Uploaded`), "same filenames have distinct stable labels");
  await h.select(sameName.id);
  assert.equal(h.element("track-bpm").value, "", "another file does not inherit the previous upload tempo");
  await h.setBpm("138");
  await h.select(id);
  assert.equal(h.element("track-bpm").value, "92.5");
  assert.equal(h.config.uploadedBpms[sameName.id], 138);

  for (const mode of ["new", "old"]) {
    const restoredStorage = new Map(h.storage), state = JSON.parse(restoredStorage.get(KEY));
    state.prompt.next_mode = mode; state.prompt.next_track_id = sameName.id; restoredStorage.set(KEY, JSON.stringify(state));
    const preserved = harness({ storage: restoredStorage });
    preserved.jobs.set(id, uploaded(id)); preserved.separateAs(id, "complete"); await preserved.activate();
    assert.equal(preserved.element("next-mode").value, mode, `restoring uploaded audio preserves saved ${mode} mode`);
    assert.equal(preserved.state().prompt.next_track_id, sameName.id);
    assert.deepEqual(preserved.config, h.config, "restoration retains uploaded stem channel settings");
    assert.equal(preserved.element("track-bpm").value, "92.5", "reload restores the per-track manual tempo without requesting analysis");
    assert.equal(preserved.current.running, false);
    assert.equal(preserved.calls.filter(call => call.method === "POST").length, 0);
  }

  const finishOld = harness(); await finishOld.activate(); await finishOld.chooseFile();
  const finishOldId = finishOld.current.track.id; await finishOld.click("separate"); await finishOld.next("old");
  finishOld.separateAs(finishOldId, "complete"); await finishOld.tick();
  assert.equal(finishOld.element("next-mode").value, "old", "same-ID stem upgrade preserves an intentional Choose old mode");
  assert.equal(finishOld.current.track.stems.length, 2);

  const invalid = harness(); await invalid.activate();
  await invalid.chooseFile({ ...file, name: "wrong.txt" });
  await invalid.chooseFile({ ...file, size: 128 * 1024 * 1024 + 1 });
  assert.equal(invalid.calls.filter(call => call.method === "POST").length, 0);
  assert.match(invalid.element("custom-status").textContent, /128 MB/);
  const offline = harness({ ready: false }); await offline.activate(); await offline.chooseFile();
  assert.equal(offline.selected.length, 1, "missing API key still allows local uploads");
  assert.equal(offline.element("separate").disabled, true);
  assert.match(offline.element("custom-cost").textContent, /local audio playback still works/);

  const race = harness(); await race.activate();
  const original = { ...uploaded("previous"), origin: "generated", name: "Previous", generation_settings: { style: "Previous" } };
  race.jobs.set(original.id, original); await race.select(original.id);
  const held = defer(); race.setFetch(route => route.startsWith("/uploads?") ? held.promise : undefined);
  await race.chooseFile();
  assert.equal(race.current.track.id, original.id, "uploading preserves the original selection");
  const preservedConfig = copy(race.config);
  await race.click("play");
  const pendingUpload = JSON.parse(race.storage.get(UPLOAD_KEY));
  const newcomer = uploaded(pendingUpload.id); race.jobs.set(newcomer.id, newcomer);
  held.resolve(response(newcomer)); await settle();
  assert.equal(race.current.track.id, original.id, "finishing an upload never interrupts music started while waiting");
  assert.deepEqual(race.config, preservedConfig);
  assert.equal(race.element("custom-load").hidden, false);

  const failure = harness(); await failure.activate(); await failure.chooseFile();
  const failureId = failure.current.track.id;
  await failure.click("separate"); failure.separateAs(failureId, "failed", { error: "Provider could not separate this audio." }); await failure.tick();
  assert.equal(failure.current.track.id, failureId); assert.equal(failure.current.track.stems.length, 0);
  assert.match(failure.element("custom-status").textContent, /Provider could not separate/);
  await failure.click("separate");
  assert.equal(failure.calls.filter(call => call.method === "POST" && call.route.endsWith("/stems")).length, 1, "failed provider requests are not silently billed again");

  const lost = harness(); await lost.activate(); await lost.chooseFile();
  const lostId = lost.current.track.id;
  lost.setFetch((route, request) => {
    if (route.endsWith("/stems") && request.method === "POST") { lost.separateAs(lostId, "generating"); throw new Error("Connection lost"); }
  });
  await lost.click("separate");
  assert.match(lost.element("custom-status").textContent, /Check status/);
  assert.equal(lost.element("separate").disabled, true);
  lost.setFetch(null); await lost.click("custom-check");
  assert.match(lost.element("custom-status").textContent, /separating stems/);
  lost.separateAs(lostId, "unknown", { error: "Provider outcome unknown" }); await lost.tick();
  assert.match(lost.element("custom-status").textContent, /outcome is uncertain/);
  assert.equal(lost.element("separate").disabled, true);
  assert.equal(lost.calls.filter(call => call.method === "POST" && call.route.endsWith("/stems")).length, 1);

  const restored = harness({ storage: new Map(lost.storage) });
  restored.jobs.set(lostId, uploaded(lostId)); restored.separateAs(lostId, "generating"); await restored.activate();
  assert.equal(restored.calls.filter(call => call.method === "POST").length, 0, "reload recovery only reads the stable job ID");
  restored.separateAs(lostId, "complete"); await restored.tick();
  assert.equal(restored.current.track.stems.length, 2);
  assert.equal(restored.current.running, false);

  const switchTrack = harness(); await switchTrack.activate(); await switchTrack.chooseFile();
  const switchingId = switchTrack.current.track.id; await switchTrack.click("separate");
  switchTrack.jobs.set(original.id, original); await switchTrack.select(original.id);
  switchTrack.separateAs(switchingId, "complete"); await switchTrack.tick();
  assert.equal(switchTrack.current.track.id, original.id, "completed separation never replaces a newer track selection");
  assert.notEqual(switchTrack.config.includeVocals, true);

  const lostUpload = harness(); await lostUpload.activate();
  lostUpload.setFetch(route => {
    if (route.startsWith("/uploads?")) { const id = new URLSearchParams(route.split("?")[1]).get("request_id"); lostUpload.jobs.set(id, uploaded(id)); throw new Error("Upload response lost"); }
  });
  await lostUpload.chooseFile(); assert.equal(lostUpload.current.track, null);
  lostUpload.setFetch(null); await lostUpload.click("custom-check");
  assert.match(lostUpload.element("custom-status").textContent, /Saved locally/);
  await lostUpload.click("custom-load"); assert.equal(lostUpload.current.track.origin, "uploaded");
  assert.equal(lostUpload.calls.filter(call => call.method === "POST").length, 1);

  const already = harness(); await already.activate(); await already.chooseFile();
  already.separateAs(already.current.track.id, "complete"); await already.click("separate");
  assert.equal(already.calls.filter(call => call.method === "POST" && call.route.endsWith("/stems")).length, 0, "preflight reuses work submitted in another tab");
  assert.equal(already.current.track.stems.length, 2);

  const stale = harness(); await stale.activate();
  const staleRead = defer();
  stale.setFetch(route => /^\/generations\/[a-f0-9]{32}$/.test(route) ? staleRead.promise : undefined);
  await stale.chooseFile();
  stale.jobs.set(original.id, original); await stale.select(original.id);
  const staleId = JSON.parse(stale.storage.get(UPLOAD_KEY)).id;
  staleRead.resolve(response(uploaded(staleId))); await settle();
  assert.equal(stale.current.track.id, original.id, "a late upload-selection GET cannot replace a newer manual selection");

  const left = harness(); await left.activate(); await left.chooseFile();
  const leftId = left.current.track.id; await left.click("separate");
  left.context.HydraMusicMixer.deactivate();
  assert.equal(left.timers.size, 0, "leaving the workspace cancels polling without cancelling the submitted job");
  left.separateAs(leftId, "complete"); await left.activate();
  assert.equal(left.current.track.stems.length, 2, "returning recovers finished stems without another paid request");
  assert.equal(left.calls.filter(call => call.method === "POST" && call.route.endsWith("/stems")).length, 1);

  const beats = harness({ manualTiming: true }); await beats.activate();
  assert.equal(beats.element("beats").hidden, true);
  assert.match(beats.root.innerHTML, /<details id="mm-beats" class="mm-beats" hidden><summary>Beat timing · Advanced<\/summary>/);
  await beats.chooseFile(); const beatId = beats.current.track.id;
  assert.equal(beats.element("beats").hidden, false);
  assert.match(beats.element("beat-status").textContent, /No ElevenLabs credits/);
  await beats.setBpm("93.5");
  const beforeAnalysis = copy(beats.config), recallsBeforeAnalysis = beats.selected.length;
  await beats.click("analyze-beats"); await beats.click("analyze-beats");
  assert.equal(beats.calls.filter(call => call.route.endsWith("/beats") && call.method === "POST").length, 1);
  assert.deepEqual(JSON.parse(beats.calls.find(call => call.route.endsWith("/beats")).body), { bpm_hint: 93.5 });
  assert.equal(beats.element("analyze-beats").disabled, true);
  beats.analyzeAs(beatId, "analyzing"); await beats.tick();
  assert.equal(beats.timers.size, 1, "local analysis polls until completion");
  const beatMap = { schema_version: 1, duration_seconds: 30, audio_sha256: "a".repeat(64), source_sha256: "b".repeat(64), source_stem_id: "drums",
    beats_seconds: [1.3, 1.95, 2.59, 3.21], active_regions: [{ start_seconds: 1.3, end_seconds: 3.8 }],
    source: "drums", bpm_median: 93.5, bpm_min: 91, bpm_max: 97, warnings: ["Check the first beat's bar position."] };
  beats.setRunning(true);
  beats.analyzeAs(beatId, "complete", beatMap); await beats.tick();
  assert.deepEqual(beats.config, beforeAnalysis, "analysis completion does not change a playing track's clock or mixer");
  assert.equal(beats.current.track.beat_analysis, undefined, "new timing is not installed while playing");
  assert.equal(beats.selected.length, recallsBeforeAnalysis, "analysis never reloads or starts playback");
  assert.equal(beats.element("use-beats").disabled, true);
  assert.match(beats.element("beat-status").textContent, /4 beats · First at 1.3 s · 93.5 BPM \(91–97\) · Drum stem/);
  assert.match(beats.element("beat-status").textContent, /Stop playback/);
  await beats.beatSetting("use-beats", true);
  assert.deepEqual(beats.config, beforeAnalysis, "programmatic change events cannot bypass the stopped-player guard");
  beats.setRunning(false); await beats.beatSetting("use-beats", true);
  assert.deepEqual(beats.config.beatTracking[beatId], { enabled: true, mode: "manual", offsetSeconds: 0 });
  assert.deepEqual(beats.current.track.beat_analysis.beats_seconds, beatMap.beats_seconds);
  await beats.beatSetting("beat-offset", "-45"); await beats.beatSetting("beat-bar", "3");
  assert.deepEqual(beats.state().config.beatTracking[beatId], { enabled: true, mode: "manual", offsetSeconds: -0.045, firstBeatInBar: 3 });
  assert.deepEqual(beats.config.channels, beforeAnalysis.channels, "beat alignment preserves all sound controls");
  await beats.beatSetting("beat-offset", "10001");
  assert.equal(beats.config.beatTracking[beatId].offsetSeconds, -0.045);
  assert.match(beats.element("notice").textContent, /10000/);
  const restoredBeats = harness({ storage: new Map(beats.storage), manualTiming: true });
  restoredBeats.jobs.set(beatId, uploaded(beatId)); restoredBeats.analyzeAs(beatId, "complete", beatMap); await restoredBeats.activate();
  assert.equal(restoredBeats.element("use-beats").checked, true);
  assert.equal(restoredBeats.element("beat-offset").value, "-45");
  assert.equal(restoredBeats.element("beat-bar").value, "3");
  assert.equal(restoredBeats.calls.filter(call => call.method === "POST").length, 0, "restoration never starts analysis or paid work");
  await restoredBeats.beatSetting("use-beats", false);
  assert.equal(restoredBeats.config.beatTracking[beatId].enabled, false, "manual BPM remains available as a fallback");
  await restoredBeats.beatSetting("use-beats", true);
  await restoredBeats.setBpm("187"); await restoredBeats.click("analyze-beats");
  assert.deepEqual(JSON.parse(restoredBeats.calls.at(-1).body), { bpm_hint: 187 }, "Analyze again uses the corrected starting tempo");
  assert.equal(restoredBeats.config.beatTracking[beatId].enabled, false, "reanalysis while stopped requires explicit re-enabling");
  assert.equal(restoredBeats.config.beatTracking[beatId].offsetSeconds, -0.045, "reanalysis preserves manual timing adjustments");
  assert.equal(restoredBeats.current.running, false);
  assert.equal(restoredBeats.element("analyze-beats").textContent, "Analyze again");

  const generatedId = "abababababababababababababababab";
  const generated = { ...uploaded(generatedId), origin: "generated", generation_settings: { bpm: 115 } };
  beats.jobs.set(generatedId, generated); await beats.select(generatedId); await beats.click("analyze-beats");
  assert.equal(beats.calls.at(-1).route, `/generations/${generatedId}/beats`, "beat timing targets the current generated track rather than the previous upload");
  assert.deepEqual(JSON.parse(beats.calls.at(-1).body), { bpm_hint: 115 });
  beats.analyzeAs(generatedId, "failed", { error: "No reliable pulse found." }); await beats.tick();
  assert.match(beats.element("beat-status").textContent, /No reliable pulse/);
  assert.equal(beats.element("analyze-beats").textContent, "Retry beat analysis");
  await beats.click("analyze-beats");
  assert.equal(beats.calls.filter(call => call.route === `/generations/${generatedId}/beats` && call.method === "POST").length, 2);
  beats.context.HydraMusicMixer.deactivate(); assert.equal(beats.timers.size, 0);
  beats.analyzeAs(generatedId, "complete", beatMap); await beats.activate(); await beats.tick();
  assert.match(beats.element("beat-status").textContent, /4 beats/);
  assert.equal(beats.element("use-beats").checked, false, "a different track does not inherit enabled beat timing");

  const unavailable = harness({ beatAvailable: false, manualTiming: true }); await unavailable.activate(); await unavailable.chooseFile();
  assert.equal(unavailable.element("analyze-beats").disabled, true);
  assert.match(unavailable.element("beat-status").textContent, /Install local audio analysis/);
  const lostBeats = harness({ manualTiming: true }); await lostBeats.activate(); await lostBeats.chooseFile();
  const lostBeatId = lostBeats.current.track.id;
  lostBeats.setFetch((route, request) => {
    if (route.endsWith("/beats") && request.method === "POST") { lostBeats.analyzeAs(lostBeatId, "analyzing"); throw new Error("Response lost"); }
  });
  await lostBeats.click("analyze-beats"); assert.equal(lostBeats.element("beat-check").hidden, false);
  lostBeats.setFetch(null); await lostBeats.click("beat-check");
  lostBeats.analyzeAs(lostBeatId, "complete", beatMap); await lostBeats.tick();
  assert.match(lostBeats.element("beat-status").textContent, /4 beats/);
  assert.equal(lostBeats.calls.filter(call => call.route.endsWith("/beats") && call.method === "POST").length, 1);
  assert.equal(lostBeats.calls.filter(call => call.route.endsWith("/stems") && call.method === "POST").length, 0);
  const lateBeats = harness({ manualTiming: true }); await lateBeats.activate(); await lateBeats.chooseFile();
  const lateBeatId = lateBeats.current.track.id, delayedBeats = defer();
  lateBeats.setFetch((route, request) => route.endsWith("/beats") && request.method === "POST" ? delayedBeats.promise : undefined);
  await lateBeats.click("analyze-beats");
  lateBeats.jobs.set(generatedId, { ...generated, beat_analysis: undefined }); await lateBeats.select(generatedId);
  delayedBeats.resolve(response({ state: "complete", ...beatMap })); await settle();
  assert.equal(lateBeats.current.track.id, generatedId);
  assert.equal(lateBeats.current.track.beat_analysis, undefined);
  assert.match(lateBeats.element("beat-status").textContent, /Analyze locally/, "a late old-track result cannot populate the newer track's controls");
  assert.equal(lateBeats.state().config.beatTracking?.[lateBeatId].enabled, false);

  for (const [state, extra] of [["not_requested", {}], ["queued", {}], ["failed", { error: "Analysis interrupted" }],
    ["complete", { ...beatMap, audio_sha256: "invalid" }], ["complete", { ...beatMap, duration_seconds: 99 }]]) {
    const storage = new Map(restoredBeats.storage), saved = JSON.parse(storage.get(KEY));
    saved.trackId = beatId; saved.config.beatTracking[beatId].enabled = true; storage.set(KEY, JSON.stringify(saved));
    const recovery = harness({ storage, manualTiming: true }); recovery.jobs.set(beatId, uploaded(beatId)); recovery.analyzeAs(beatId, state, extra);
    await recovery.activate();
    assert.equal(recovery.element("use-beats").checked, true);
    assert.equal(recovery.element("use-beats").disabled, false, `${state} metadata must not trap an enabled saved clock`);
    assert.doesNotMatch(recovery.element("beat-status").textContent, /Detected beats are used for sync/);
    if (state === "complete") assert.match(recovery.element("beat-status").textContent, /invalid or belongs to different audio/);
    await recovery.beatSetting("use-beats", false);
    assert.equal(recovery.config.beatTracking[beatId].enabled, false, `saved ${state} timing can be disabled without a usable map`);
    assert.equal(recovery.element("use-beats").disabled, true);
    await recovery.beatSetting("use-beats", true);
    assert.equal(recovery.config.beatTracking[beatId].enabled, false, "unusable timing cannot be enabled through a synthetic change event");
    assert.equal(recovery.calls.filter(call => call.method === "POST").length, 0);
  }

  const departed = harness({ manualTiming: true }); await departed.activate(); await departed.chooseFile();
  const departedId = departed.current.track.id, delayedPost = defer();
  departed.setFetch((route, request) => route.endsWith("/beats") && request.method === "POST" ? delayedPost.promise : undefined);
  await departed.click("analyze-beats"); departed.context.HydraMusicMixer.deactivate();
  departed.analyzeAs(departedId, "complete", beatMap);
  delayedPost.resolve(response(departed.analyses.get(departedId))); await settle();
  departed.setFetch(null); await departed.activate();
  assert.match(departed.element("beat-status").textContent, /4 beats/, "returning recovers analysis whose initial response arrived after leaving");
  assert.doesNotMatch(departed.element("beat-status").textContent, /Finding beat positions|Checking beat analysis/);
  assert.equal(departed.calls.filter(call => call.route.endsWith("/beats") && call.method === "GET").length, 1);
  assert.equal(departed.calls.filter(call => call.route.endsWith("/beats") && call.method === "POST").length, 1);
  assert.equal(departed.element("use-beats").checked, false);
  assert.equal(departed.current.track.beat_analysis, undefined, "recovery leaves applying the clock explicit");
  assert.equal(departed.current.running, false);
  const waitingStorage = new Map(restoredBeats.storage), waitingState = JSON.parse(waitingStorage.get(KEY));
  waitingState.trackId = beatId; waitingState.config.beatTracking[beatId].enabled = true; waitingStorage.set(KEY, JSON.stringify(waitingState));
  const waiting = harness({ storage: waitingStorage, manualTiming: true }); waiting.jobs.set(beatId, uploaded(beatId)); waiting.analyzeAs(beatId, "queued"); await waiting.activate();
  waiting.analyzeAs(beatId, "complete", { ...beatMap, warnings: { malformed: true } }); await waiting.tick();
  assert.match(waiting.element("beat-status").textContent, /off and back on/, "newly recovered metadata is not falsely labelled installed");
  assert.doesNotMatch(waiting.element("beat-status").textContent, /Detected beats are used for sync/);
  assert.equal(waiting.current.track.beat_analysis.state, "queued", "completion leaves the previously loaded clock untouched");
  await waiting.beatSetting("use-beats", false); await waiting.beatSetting("use-beats", true);
  assert.match(waiting.element("beat-status").textContent, /Detected beats are used for sync/);

  const automatic = harness({ automaticTiming: true }); await automatic.activate(); await automatic.chooseFile();
  const automaticId = automatic.current.track.id;
  assert.equal(automatic.element("beat-sync").hidden, false);
  assert.equal(automatic.element("beat-sync").textContent, "Aligning beats…");
  assert.equal(automatic.element("use-beats-field").hidden, true, "an imported track does not require an apply checkbox");
  assert.equal(automatic.element("beat-mode").value, "auto");
  assert.equal(automatic.element("beat-bar").value, "", "bar alignment defaults to the detector's estimate");
  assert.equal(automatic.calls.filter(call => call.route.endsWith("/beats")).length, 0, "automatic preparation belongs to the engine, without duplicate UI requests");
  assert.deepEqual(automatic.generationCalls.filter(call => call !== "stop"), ["recall"], "loading never starts music or generation");
  await automatic.click("play");
  assert.equal(automatic.element("play").textContent, "Aligning beats…");
  assert.equal(automatic.element("stop").disabled, false, "pending playback can be cancelled");
  await automatic.click("stop");
  const startsBeforeReady = automatic.generationCalls.filter(call => call === "resume").length;
  automatic.beatTiming("ready", { state: "complete", ...beatMap, first_beat_in_bar: 3 });
  assert.equal(automatic.current.running, false);
  assert.equal(automatic.generationCalls.filter(call => call === "resume").length, startsBeforeReady, "analysis completion cannot undo Stop");
  assert.equal(automatic.element("beat-sync").textContent, "Beat sync ready");
  assert.match(automatic.element("beat-status").textContent, /applied automatically/);
  assert.equal(automatic.element("use-beats").checked, true);
  assert.equal(automatic.config.beatTracking[automaticId].firstBeatInBar, undefined, "automatic accent does not become a manual override");
  await automatic.beatSetting("beat-bar", "2");
  assert.equal(automatic.config.beatTracking[automaticId].firstBeatInBar, 2);
  await automatic.beatSetting("beat-bar", "");
  assert.equal(automatic.config.beatTracking[automaticId].firstBeatInBar, undefined, "Automatic removes the optional bar override");
  const automaticState = automatic.state(); automatic.context.HydraMusicMixer.flush();
  const automaticRestore = harness({ automaticTiming: true, storage: new Map(automatic.storage) });
  automaticRestore.jobs.set(automaticId, { ...uploaded(automaticId), beat_analysis: automatic.current.track.beat_analysis });
  await automaticRestore.activate();
  assert.equal(automaticRestore.element("beat-sync").textContent, "Beat sync ready");
  assert.equal(automaticRestore.calls.filter(call => call.method === "POST").length, 0, "saved ready timing is reused without analysis or paid work");
  assert.equal(automaticRestore.current.running, false, "session restoration remains passive");
  assert.deepEqual(automaticRestore.state().config.beatTracking, automaticState.config.beatTracking);
  automatic.beatTiming("failed", null, "The recording has no reliable pulse.");
  assert.match(automatic.element("beat-sync").textContent, /unavailable/);
  assert.match(automatic.element("beat-status").textContent, /no reliable pulse/);
  assert.equal(automatic.element("analyze-beats").textContent, "Retry beat analysis");
  await automatic.click("analyze-beats");
  assert.deepEqual(automatic.beatPreparations, [{ force: true }], "retry requests local automatic preparation and apply");
  assert.equal(automatic.element("beat-sync").textContent, "Aligning beats…");
  assert.equal(automatic.calls.filter(call => call.route.endsWith("/stems") && call.method === "POST").length, 0, "automatic alignment does not request separation");
  automatic.beatTiming("ready", { state: "complete", ...beatMap });
  await automatic.beatSetting("beat-mode", "manual");
  assert.equal(automatic.config.beatTracking[automaticId].mode, "manual");
  assert.equal(automatic.config.beatTracking[automaticId].enabled, false, "fixed-grid timing requires an explicit advanced override");
  assert.equal(automatic.element("beat-sync").hidden, true);
  await automatic.beatSetting("beat-mode", "auto");
  assert.equal(automatic.config.beatTracking[automaticId].mode, "auto");
  assert.equal(automatic.config.beatTracking[automaticId].enabled, true);
  assert.deepEqual(automatic.beatPreparations.at(-1), {});
  console.log("Music mixer custom audio: upload, separation, automatic timing status and retry, cancelled starts, optional overrides, saved reuse, manual analysis and selection races passed.");
}
tests().catch(error => { console.error(error); process.exitCode = 1; });
