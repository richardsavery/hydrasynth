"use strict";

// Exercise actual recording, playback, and input-stream boundaries. These
// tests never open a microphone, call a provider, or command robot hardware.
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const { fixture, settle, defer, responseJob } = require("./test_rap_response_ui.js");
const plain = value => JSON.parse(JSON.stringify(value));
function recorder() {
  const events = [], audio = [];
  let context = { session_id: "participant-one", client_id: "browser-one" };
  return { events, audio, setContext(value) { context = value; },
    emit(type, payload) { events.push({ type, payload: plain(payload) }); },
    getContext() { return context; },
    async storeAudio(blob, metadata) { audio.push({ blob, metadata: plain(metadata) }); return `audio-${audio.length}`; } };
}

async function main() {
  {
    const study = recorder(), h = fixture({ study });
    await h.panel.activate(); await h.event("record");
    h.recorders[0].ondataavailable({ data: new Blob(["first chunk"]) });
    study.setContext({ session_id: "participant-two", client_id: "browser-one" });
    await h.event("cancel"); await settle();
    assert.equal(study.audio.length, 1, "cancelled recordings retain original microphone bytes");
    assert.equal(await study.audio[0].blob.text(), "first chunkmicrophone data", "include the final MediaRecorder.stop data chunk");
    assert.equal(study.audio[0].blob.type, "audio/webm;codecs=opus");
    assert.equal(study.audio[0].metadata.session_id, "participant-one", "async audio remains associated with the session at capture start");
    assert.equal(study.audio[0].metadata.outcome, "cancelled");
    assert.equal(study.audio[0].metadata.role, "microphone_original");
    assert.equal(h.requests.filter(request => request.method === "POST").length, 0, "archiving cancellation must never submit a rap");
    assert.equal(study.events.filter(event => event.type === "rap.recording.started").length, 1);
    assert.equal(study.events.filter(event => event.type === "rap.recording.cancelled").length, 1);
    assert.ok(h.stream.tracks.every(track => track.stopped > 0));
    h.panel.deactivate();
  }
  {
    const study = recorder(), h = fixture({ study });
    await h.panel.activate(); h.el("auto").checked = false;
    await h.event("record"); await h.event("record"); await settle();
    assert.equal(study.audio.length, 2, "successful recording retains original and submitted WAV");
    assert.deepEqual(study.audio.map(item => item.metadata.role), ["microphone_original", "microphone_submission"]);
    const wav = Buffer.from(await study.audio[1].blob.arrayBuffer());
    assert.equal(wav.subarray(0, 4).toString(), "RIFF");
    assert.equal(wav.readUInt32LE(24), 16000);
    const sent = h.requests.find(request => request.method === "POST");
    assert.equal(study.audio[0].metadata.request_id, sent.body.request_id);
    assert.equal(study.audio[1].metadata.request_id, sent.body.request_id);
    assert.equal(study.events.find(event => event.type === "rap.response.submitted").payload.capture_id, study.audio[0].metadata.capture_id);
    assert.equal(study.events.find(event => event.type === "rap.response.state").payload.lyrics, responseJob().lyrics);
    assert.ok(!study.events.some(event => event.type.startsWith("rap.playback.")), "generation success is not playback");
    await h.event("play");
    assert.equal(study.events.filter(event => event.type === "rap.playback.scheduled").length, 1);
    assert.equal(study.events.filter(event => event.type === "rap.playback.started").length, 1);
    h.sources.at(-1).onended();
    assert.equal(study.events.filter(event => event.type === "rap.playback.ended").length, 1);
    assert.equal(study.events.filter(event => event.type === "rap.playback.stopped").length, 0, "natural completion is distinct from manual stop");
    h.panel.deactivate();
  }
  {
    const study = recorder(), h = fixture({ study, saved: { response_id: "response-one" }, backing: {},
      fetch: (request, response) => request.url.endsWith("/response-one") ? response(responseJob({ output_mode: "vocals", vocal_state: "complete", vocal_audio_url: "/api/rap-response/responses/response-one/vocals/audio" })) : undefined });
    await h.panel.activate(); await h.event("play");
    assert.equal(study.events.filter(event => event.type === "rap.playback.scheduled").length, 1);
    assert.equal(study.events.filter(event => event.type === "rap.playback.started").length, 0, "next-bar playback has not started when it is scheduled");
    h.backing.context.currentTime = h.sources.at(-1).at;
    await h.timer(100);
    assert.equal(study.events.filter(event => event.type === "rap.playback.started").length, 1);
    await h.event("stop");
    assert.equal(study.events.filter(event => event.type === "rap.playback.stopped").length, 1);
    h.panel.deactivate();
  }
  {
    const study = recorder(), h = fixture({ study });
    await h.panel.activate(); h.el("auto").checked = false;
    await h.event("record");
    study.setContext({ session_id: "participant-two", client_id: "browser-two" });
    await h.event("record"); await settle();
    const created = h.requests.find(request => request.method === "POST");
    assert.equal(created.headers["X-Study-Session"], "participant-one", "finishing an old capture after New participant preserves HTTP attribution");
    assert.equal(created.headers["X-Study-Client"], "browser-one");
    assert.equal(created.body.study_context, undefined, "study attribution is header-only, never provider request payload");
    await h.event("isolate");
    const isolation = h.requests.find(request => request.url.endsWith("/vocals"));
    assert.equal(isolation.headers["X-Study-Session"], "participant-one", "isolation remains linked to the original rap request");
    assert.equal(study.getContext().session_id, "participant-two", "request-scoped attribution cannot mutate the current participant");
    h.el("text").value = "A new participant's reply";
    await h.event("generate");
    const latest = h.requests.filter(request => request.method === "POST").at(-1);
    assert.equal(latest.headers["X-Study-Session"], "participant-two", "new participant actions receive their own context");
    h.panel.deactivate();
  }
  {
    const study = recorder(), h = fixture({ study, newJob: { state: "writing" } });
    await h.panel.activate(); h.el("auto").checked = false; h.el("text").value = "A pending reply";
    await h.event("generate");
    study.setContext({ session_id: "participant-two", client_id: "browser-two" });
    await h.timer(1400);
    const polled = h.requests.find(request => request.method === "GET" && request.url.endsWith("/response-one"));
    assert.equal(polled.headers["X-Study-Session"], "participant-one", "job polling retains originating context");
    await h.event("cancel");
    const cancelled = h.requests.find(request => request.url.endsWith("/cancel"));
    assert.equal(cancelled.headers["X-Study-Session"], "participant-one", "cancellation remains linked to the pending request");
    h.panel.deactivate();
  }
  {
    let submissions = 0;
    const study = recorder(), h = fixture({ study, fetch: (request, response) => {
      if (request.method === "POST" && ++submissions === 1) return response({ error: "Service temporarily unavailable" }, 503);
    } });
    await h.panel.activate(); h.el("auto").checked = false; h.el("text").value = "Recover this participant's request";
    await h.event("generate");
    study.setContext({ session_id: "participant-two", client_id: "browser-two" });
    await h.event("generate");
    const lookup = h.requests.find(request => request.url.includes("/requests/"));
    assert.equal(lookup.headers["X-Study-Session"], "participant-one", "recovery lookup retains originating context");
    assert.equal(h.requests.filter(request => request.method === "POST").at(-1).headers["X-Study-Session"], "participant-one", "safe resubmission retains originating context");
    h.panel.deactivate();
  }
  {
    const study = recorder(), pending = defer(), h = fixture({ study,
      fetch: (request, response) => request.method === "POST" ? pending.promise.then(() => response(responseJob({ request_id: request.body.request_id }))) : undefined });
    await h.panel.activate(); h.el("auto").checked = false; h.el("text").value = "A reply for participant one";
    const submitted = h.event("generate"); await settle();
    study.setContext({ session_id: "participant-two", client_id: "browser-one" });
    pending.resolve(); await submitted;
    assert.equal(study.events.find(event => event.type === "rap.response.state").payload.session_id, "participant-one", "late job results retain the submitting participant");
    h.panel.deactivate();
  }
  {
    const study = recorder(), pending = defer(), h = fixture({ study, getUserMedia: () => pending.promise });
    await h.panel.activate(); const opening = h.event("record");
    pending.reject(Object.assign(new Error("Denied"), { name: "NotAllowedError" }));
    await opening; await settle();
    assert.ok(study.events.some(event => event.type === "rap.recording.failed" && event.payload.reason === "NotAllowedError"));
    assert.equal(study.audio.length, 0, "permission failures cannot produce microphone audio");
    h.panel.deactivate();
  }
  {
    const h = fixture({ study: { emit() { throw new Error("Recorder unavailable"); }, getContext() { throw new Error("Recorder unavailable"); }, storeAudio() { return Promise.reject(new Error("Disk unavailable")); } } });
    await h.panel.activate(); h.el("auto").checked = false;
    await h.event("record"); await h.event("record"); await settle();
    assert.equal(h.requests.filter(request => request.method === "POST").length, 1, "study failures cannot block the participant's existing rap workflow");
    h.panel.deactivate();
  }
  {
    const study = recorder(), box = vm.createContext({ HydraStudy: study });
    vm.runInContext(fs.readFileSync(`${__dirname}/../dashboard/live.js`, "utf8"), box);
    const stream = new box.HydraLive.Stream(), values = Array.from({ length: 1600 }, (_, index) => index / 8);
    const frame = { channel: "motion", sequence: 7, timestamp: 42.5, labels: ["first", "second"],
      data: [values.slice(0, 900), values.slice(900)], velocity: [1, 2], tensors: { position: { shape: [2, 2], data: [[1, 2], [3, 4]] } }, api_key: "never-record" };
    assert.equal(stream.ingest(frame, 100), true);
    const metadata = study.events.find(event => event.type === "live.input.frame").payload;
    assert.equal(metadata.sequence, 7); assert.equal(metadata.timestamp, 42.5);
    const chunks = study.events.filter(event => event.type === "live.input.values" && event.payload.array_key === "data");
    assert.equal(chunks.length, 4);
    assert.deepEqual(chunks.map(event => event.payload.offset), [0, 512, 1024, 1536]);
    assert.deepEqual(chunks.flatMap(event => event.payload.values), values, "chunking preserves all accepted samples");
    assert.ok(!JSON.stringify(study.events).includes("never-record"), "unrecognized network fields cannot enter study records");
    const before = study.events.length;
    stream.ingest({ ...frame, sequence: 8 }, 101);
    assert.equal(study.events.length - before, before, "each incoming frame is preserved without rate decimation");
    box.HydraStudy = { emit() { throw new Error("Recorder unavailable"); } };
    stream.ingest({ channel: "motion", data: [9] }, 102);
    assert.equal(stream.frames, 3, "archive errors cannot disrupt live input processing");
  }
  console.log("Study semantic hooks: original/cancelled microphone retention, request/session association, actual playback boundaries, failure isolation, and complete chunked live frames passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
