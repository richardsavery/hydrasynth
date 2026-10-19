"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Use the app's real socket lifecycle and frame parser. A controllable socket
// and clock let us deliver callbacks after disconnects and reconnects without
// opening a network connection or using audio/MIDI hardware.
const sockets = [], timers = new Map(), notices = [];
let now = 0, timerId = 0, stopped = 0, renders = 0, resets = 0;
class Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.({}); }
  sendFrame(value) { this.onmessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) }); }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }
}
const element = (value = "") => {
  const listeners = new Map();
  return { value, checked: false, textContent: "", disabled: false,
    classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {},
    addEventListener(type, callback) { listeners.set(type, callback); },
    fire(type) { listeners.get(type)?.(); },
    querySelectorAll() { return []; }, parentElement: { classList: { toggle() {} } } };
};
const context = vm.createContext({
  console, Intl, URL, URLSearchParams, WebSocket: Socket,
  document: { addEventListener() {}, getElementById() { return null; } },
  window: { location: { protocol: "http:" },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); } },
  localStorage: { getItem() { return null; }, setItem() {} },
  performance: { now: () => now },
  fetch() { throw new Error("Live connection tests must not fetch or generate music"); },
  recordStop() { stopped++; }, recordNotice(value) { notices.push(value); }
});
for (const file of ["drums.js", "sonification.js", "parameters.js", "live.js", "live-monitor-model.js", "drum-workspace.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard", file), "utf8"), context, { filename: file });
}
vm.runInContext(`
  globalThis.api = { state, dom, Music, CONTROL_IDS, DRUM_CONTROL_IDS, liveInputUrl,
    selectLiveInput, disconnectLive, openLiveSocket, updateLiveStatus, refreshLiveView,
    returnToRecording, selectRecording, bindLiveInput };
  for (const name of ["renderPlaybackAvailability", "renderRhythm", "renderHarmony", "renderSoundControls",
    "renderOutputMode", "updatePlayhead", "publishSignalLabActivity", "updateConnectionSummary", "renderWorkspaces",
    "renderMappings", "renderRecordingList", "renderRecordingsForLive", "updateControlReadouts", "renderScale",
    "renderDrumSources", "drawLiveWaveform", "updateMappingRangeReadouts", "saveSettings"])
    globalThis[name] = () => {};
  stopPlayback = () => { state.playing = false; recordStop(); };
  loadFocusedSeries = async () => {};
  showToast = message => recordNotice(message);
`, context);
const { api } = context, { state, dom, Music } = api;
context.HydraLiveMonitor = { init() { return { render() { renders++; }, reset() { resets++; } }; } };
for (const [key, id] of Object.entries(api.CONTROL_IDS)) dom[id] = element(String(Music.DEFAULT_CONTROLS[key]));
for (const [key, id] of Object.entries(api.DRUM_CONTROL_IDS)) dom[id] = element(String(context.HydraDrums.DEFAULTS[key]));
for (const id of ["recording-title", "recording-detail", "add-mapping", "live-connect", "live-disconnect", "live-status",
  "live-reset-ranges", "return-to-recording", "recording-list"]) dom[id] = element();
dom["live-url"] = element("ws://signals.example.invalid:8765");
dom["live-reconnect"] = element();
state.saved = { controls: Music.controls(), workspaces: {}, lastRecording: "recording-a",
  live: { url: "ws://signals.example.invalid:8765", reconnect: true } };
state.library = { recordings: [{ id: "recording-a", name: "Recording A", channels: [], frames: 0, size_bytes: 0 }] };
api.bindLiveInput();
const frame = (value, channel = "robot_joint_states") => ({ channel, labels: ["joint_1", "joint_2"],
  data: [value, 2 * value], velocity: [value / 10, value / 20], timestamp: -100000 });
const runTimer = (id) => {
  const timer = timers.get(id);
  assert.ok(timer, `Expected timer ${id}`);
  timers.delete(id); now += timer.delay; timer.callback();
};
const snapshot = () => state.liveDiagnostics.snapshot(state.live, now, {
  sourceMode: state.sourceMode, wanted: state.liveWanted, status: state.liveStatus,
  retryAt: state.liveRetryAt, url: state.liveUrl
});

async function main() {
  assert.equal(api.liveInputUrl().href, "ws://signals.example.invalid:8765/");
  dom["live-url"].value = "https://signals.example.invalid";
  assert.throws(api.liveInputUrl, /ws:\/\/ or wss:\/\//);
  dom["live-url"].value = "ws://user:secret@signals.example.invalid";
  assert.throws(api.liveInputUrl, /ws:\/\/ or wss:\/\//, "credential-bearing socket URLs are rejected");
  context.window.location.protocol = "https:";
  dom["live-url"].value = "ws://signals.example.invalid";
  assert.throws(api.liveInputUrl, /HTTPS page needs/);
  context.window.location.protocol = "http:";
  dom["live-url"].value = "ws://signals.example.invalid:8765";

  // Restoring a saved live input never creates a socket or starts retry timers.
  api.selectLiveInput(api.liveInputUrl(), false);
  assert.equal(state.sourceMode, "live");
  assert.equal(sockets.length, 0);
  assert.equal(timers.size, 0);
  assert.match(dom["live-status"].textContent, /press Connect live/);
  assert.equal(snapshot().connected, false);
  assert.equal(snapshot().counts.messages, 0);
  assert.ok(renders > 0, "a restored disconnected input renders without waiting for a polling timer");
  dom["live-reconnect"].checked = false;
  dom["live-reconnect"].fire("change");
  dom["live-reconnect"].checked = true;
  dom["live-reconnect"].fire("change");
  assert.equal(sockets.length, 0, "enabling automatic reconnect never connects a saved disconnected input");
  assert.equal(timers.size, 0);

  api.selectLiveInput(api.liveInputUrl(), true);
  const first = sockets.at(-1);
  assert.equal(first.url, "ws://signals.example.invalid:8765/");
  assert.match(dom["live-status"].textContent, /Connecting/);
  first.open();
  assert.match(dom["live-status"].textContent, /waiting for data/);
  assert.equal(snapshot().connected, true);
  assert.match(snapshot().diagnostic.title, /waiting for messages/i);
  first.sendFrame({ channel: "__status__", msg: "connected" });
  assert.equal(state.live.frames, 0, "greetings do not become input data");
  assert.equal(snapshot().counts.statusFrames, 1);
  assert.equal(snapshot().counts.messages, 1);
  assert.match(snapshot().diagnostic.title, /no numeric data/i);
  first.sendFrame("not JSON");
  first.onmessage({ data: new Uint8Array([1, 2]) });
  first.sendFrame(" ".repeat(8 * 1024 * 1024 + 1));
  first.sendFrame({ channel: "missing_payload" });
  assert.equal(state.live.invalid, 4, "malformed, binary, oversized and unusable messages are ignored");
  assert.equal(snapshot().counts.invalidFrames, 4);
  assert.equal(snapshot().counts.binaryFrames, 1);
  assert.equal(snapshot().counts.oversizedFrames, 1);
  assert.equal(snapshot().counts.invalidJsonFrames, 1);
  assert.match(snapshot().diagnostic.detail, /array values|data:/);
  now = 100;
  first.sendFrame(frame(1));
  assert.equal(state.live.frames, 1);
  assert.equal(state.live.fields.length, 4, "joint position and velocity remain distinct sources");
  assert.equal(state.live.lastAt, 100, "freshness uses browser receipt time rather than sender timestamps");
  assert.equal(snapshot().counts.dataFrames, 1);
  assert.equal(snapshot().fields.length, 4);
  assert.equal(snapshot().fields[0].value, 1);
  assert.equal(snapshot().fields[0].stale, false);
  assert.equal(state.live.ranges.size, 0, "monitoring doesn't register or alter mapping calibration");
  assert.equal(state.live.samples.size, 0, "monitoring doesn't consume sonification history slots");
  api.refreshLiveView();
  assert.match(dom["live-status"].textContent, /1 channels · 4 fields · 1 frames/);
  assert.match(dom["live-status"].textContent, /4 invalid/);
  const source = { sourceKey: state.live.fields[0].key, reducer: "value", index: 0, rangeMode: "auto" };
  assert.equal(state.live.read(source, now).value, 1);
  const rendered = renders;
  now = 200; first.sendFrame(frame(3));
  assert.equal(state.live.getRange(source).maximum, 3, "learned ranges see every incoming frame");
  // Rendering can be paused independently; the socket must continue feeding
  // sonification and diagnostics without depending on a visible monitor.
  assert.equal(snapshot().fields[0].value, 3);
  assert.equal(renders, rendered);
  assert.equal(state.live.read(source, now).value, 3);
  now = 3201;
  api.updateLiveStatus();
  assert.match(dom["live-status"].textContent, /Stream idle/);
  assert.equal(state.live.read(source, now), null);
  assert.equal(snapshot().fields[0].stale, true);
  assert.match(snapshot().diagnostic.title, /Data has stopped/);

  // Socket closure invalidates cached values and stops playback immediately.
  now = 3250; first.sendFrame(frame(4));
  const staleMessage = first.onmessage, staleOpen = first.onopen, staleClose = first.onclose;
  const stopsBefore = stopped;
  first.close(1006, "");
  assert.ok(stopped > stopsBefore);
  assert.equal(state.live.lastAt, null);
  assert.equal(state.live.read(source, now), null);
  assert.equal(state.live.getRange(source).maximum, 4, "automatic reconnect preserves learned calibration");
  assert.equal(timers.get(state.liveRetry).delay, 1000);
  assert.equal(snapshot().retryAt, now + 1000);
  assert.equal(snapshot().connected, false);
  assert.ok(snapshot().events.some((event) => /closed \(1006\)/.test(event.message)));
  assert.ok(snapshot().fields.every((field) => field.stale));
  runTimer(state.liveRetry);
  const second = sockets.at(-1);
  assert.notEqual(second, first);
  const framesBefore = state.live.frames;
  staleMessage({ data: JSON.stringify(frame(999)) }); staleOpen(); staleClose({ code: 1000 });
  assert.equal(state.live.frames, framesBefore, "callbacks queued by an older socket cannot ingest data");
  assert.equal(snapshot().counts.dataFrames, framesBefore, "old socket callbacks cannot change monitor statistics");
  assert.equal(state.liveSocket, second, "old close callbacks cannot tear down the replacement");
  second.open();
  assert.equal(snapshot().counts.reconnections, 1);
  assert.equal(snapshot().retryAt, null);
  dom["live-reconnect"].checked = false;
  dom["live-reconnect"].fire("change");
  assert.equal(state.liveSocket, second, "disabling automatic reconnect leaves an open socket connected");
  dom["live-reconnect"].checked = true;
  dom["live-reconnect"].fire("change");
  assert.equal(sockets.length, 2, "enabling automatic reconnect cannot create a second open socket");
  assert.equal(state.live.read(source, now), null, "opening a replacement socket cannot freshen cached values");
  now += 10; second.sendFrame(frame(2));
  assert.equal(state.live.read(source, now).value, 2);
  assert.equal(snapshot().fields[0].value, 2);
  assert.equal(snapshot().fields[0].stale, false);

  // Manual disconnect cancels reconnect/render/timeout work, and a new explicit
  // connection starts with clean input discovery and statistics.
  const secondMessage = second.onmessage;
  api.disconnectLive();
  assert.equal(state.liveSocket, null);
  assert.equal(state.liveWanted, false);
  assert.equal(dom["live-disconnect"].disabled, true);
  assert.equal(state.live.lastAt, null, "manual disconnect expires cached receive timestamps too");
  assert.equal(snapshot().state, "disconnected");
  assert.ok(snapshot().fields.every((field) => field.stale));
  assert.equal(timers.has(state.liveRetry), false);
  assert.equal(timers.has(state.liveRenderTimer), false);
  const disconnectedFrames = state.live.frames;
  secondMessage({ data: JSON.stringify(frame(888)) });
  assert.equal(state.live.frames, disconnectedFrames);
  dom["live-reconnect"].checked = false;
  dom["live-reconnect"].fire("change");
  dom["live-reconnect"].checked = true;
  dom["live-reconnect"].fire("change");
  assert.equal(sockets.length, 2, "enabling automatic reconnect respects an explicit Disconnect");
  api.selectLiveInput(api.liveInputUrl(), true);
  assert.equal(state.live.frames, 0);
  assert.equal(state.live.invalid, 0);
  assert.equal(state.live.channels.size, 0);
  assert.equal(snapshot().counts.messages, 0);
  assert.equal(snapshot().fields.length, 0);
  assert.equal(resets, 3, "new live selections reset the monitor's view without resetting automatic reconnects");
  const third = sockets.at(-1);
  dom["live-reconnect"].checked = false;
  third.onerror({});
  assert.equal(snapshot().state, "error");
  assert.match(snapshot().diagnostic.detail, /does not expose the exact network failure/,
    "generic browser errors must not claim a specific network or permission cause");
  runTimer(state.liveConnectTimer);
  assert.equal(third.readyState, Socket.CLOSED);
  assert.equal(state.liveSocket, null);
  assert.equal(timers.has(state.liveRetry), false, "disabling automatic reconnect prevents retries after timeout");
  assert.ok(snapshot().events.some((event) => /timed out/.test(event.message)), "a timeout remains available in diagnostics after the socket closes");

  dom["live-reconnect"].checked = true;
  dom["live-reconnect"].fire("change");
  const fourth = sockets.at(-1);
  assert.notEqual(fourth, third, "re-enabling reconnect immediately retries an interrupted active stream");
  assert.equal(snapshot().state, "connecting");
  dom["live-reconnect"].fire("change");
  assert.equal(sockets.at(-1), fourth, "repeated changes cannot duplicate an in-progress connection");
  fourth.close(1006);
  const pendingRetry = state.liveRetry;
  assert.ok(timers.has(pendingRetry));
  assert.ok(snapshot().retryAt > now);
  dom["live-reconnect"].checked = false;
  dom["live-reconnect"].fire("change");
  assert.equal(timers.has(pendingRetry), false, "turning off reconnect cancels an already scheduled retry");
  assert.equal(state.liveRetry, null);
  assert.equal(state.liveRetryAt, null);
  assert.equal(snapshot().retryAt, null);
  assert.doesNotMatch(snapshot().diagnostic.detail, /reconnect is scheduled/);
  assert.match(dom["live-status"].textContent, /automatic reconnect off/);
  assert.equal(state.liveWanted, true, "disabling retries remembers that this was an active stream");

  await api.returnToRecording();
  assert.equal(state.sourceMode, "recording");
  assert.equal(state.recording.id, "recording-a");
  assert.equal(state.liveWanted, false);
  assert.equal(state.liveSocket, null);
  assert.match(snapshot().diagnostic.title, /recorded input/);
  console.log("live connections: frame validation, receive-time freshness, reconnect calibration, stale callback isolation and recording restore passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
