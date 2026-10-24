"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRecorder, createIndexedDBQueue, createMappingTracker, clean, controlValue, controlDescription, installBrowser } = require("../dashboard/study-recorder.js");
const tick = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
let serial = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;
function storage() { const values = new Map(); return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), key: index => [...values.keys()][index], get length() { return values.size; } }; }
function memoryQueue() {
  let serial = 0;
  const queue = { records: [], failWrites: false,
    async put(record) { if (this.failWrites) throw new Error("Quota exceeded"); const queue_id = ++serial; this.records.push(structuredClone({ ...record, queue_id })); return queue_id; },
    async putMany(records) { if (this.failWrites) throw new Error("Quota exceeded"); return Promise.all(records.map(record => this.put(record))); },
    async lastId() { return this.records.at(-1)?.queue_id || 0; },
    async first(count, excluded = new Set()) { return structuredClone(this.records.filter(row => !excluded.has(row.queue_id)).slice(0, count)); },
    async update(record) { this.records = this.records.map(row => row.queue_id === record.queue_id ? structuredClone(record) : row); },
    async rejections() { return structuredClone(this.records.filter(row => row.rejected)); },
    async count() { return this.records.length; },
    async remove(ids) { this.records = this.records.filter(row => !ids.includes(row.queue_id)); }
  };
  return queue;
}
function fixture(options = {}) {
  const queue = options.queue || memoryQueue(), sessionStorage = options.sessionStorage || storage(), calls = [], events = [], media = [];
  let online = options.online !== false, acknowledging = true;
  const states = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body, init });
    if (!online) throw new Error("Offline");
    let value;
    if (url.endsWith("/status")) value = { ready: true, device_id: "laptop-1" };
    if (url.endsWith("/sessions")) value = { session_id: body.session_id };
    if (url.endsWith("/events")) { events.push(...body.events); value = { acknowledged_event_ids: acknowledging ? body.events.map(event => event.event_id) : [] }; }
    if (url.endsWith("/media")) { media.push(body); value = { acknowledged_media_id: acknowledging ? body.media_id : null }; }
    if (options.fetch) { const result = await options.fetch(url, init, value); if (result) return result; }
    return { ok: true, status: 200, json: async () => value };
  };
  const recorder = createRecorder({ queue, sessionStorage, fetch, uuid, monotonic: () => 100, now: () => "2026-10-19T12:00:00.000Z", onState: value => states.push(value), ...options.recorderOptions });
  return { queue, sessionStorage, calls, events, media, states, recorder, setOnline: value => { online = value; }, setAcknowledging: value => { acknowledging = value; } };
}

// A small transactional IndexedDB double: success is not durable until oncomplete.
function fakeIndexedDB() {
  const database = { records: [], next: 0, fail: false, transactions: [], createObjectStore() {}, close() {},
    transaction(name, mode) {
      const staged = structuredClone(database.records), tx = { mode, error: null };
      let pendingRequests = 0;
      const store = {
        add(record) { const queue_id = ++database.next; staged.push(structuredClone({ ...record, queue_id })); return { result: queue_id }; },
        getAll(_query, count) { return { result: structuredClone(staged.slice(0, count)) }; },
        index() { return { getAll() { return { result: structuredClone(staged.filter(row => row.rejected)) }; } }; },
        openCursor(_query, direction) {
          const request = {}; let index = 0;
          const rows = direction === "prev" ? staged.slice().reverse() : staged;
          const advance = () => { pendingRequests--; const row = rows[index++]; request.result = row ? { key: row.queue_id, value: structuredClone(row), continue() { pendingRequests++; queueMicrotask(advance); } } : null; request.onsuccess?.(); };
          pendingRequests++; queueMicrotask(advance); return request;
        },
        count() { return { result: staged.length }; },
        delete(id) { const index = staged.findIndex(row => row.queue_id === id); if (index !== -1) staged.splice(index, 1); }
      };
      tx.objectStore = () => store;
      tx.abort = () => { tx.aborted = true; tx.error = new Error("Transaction aborted"); queueMicrotask(() => tx.onabort()); };
      tx.commit = () => { if (tx.aborted) return; if (pendingRequests) { queueMicrotask(tx.commit); return; } if (database.fail) { tx.error = new Error("Transaction aborted"); tx.onabort(); } else { if (mode === "readwrite") database.records = staged; tx.oncomplete(); } };
      database.transactions.push(tx);
      return tx;
    }
  };
  return { database, open() { const request = { result: database }; queueMicrotask(() => request.onsuccess()); return request; } };
}

async function main() {
  testMappingTracker();
  await testRecordingDisabled();
  await testBrowserErrors();
  await testSustainedCapture();
  await testNotificationRate();
  {
    const h = fixture({ fetch: async (url, init) => url.endsWith("/media") && JSON.parse(init.body).metadata.role === "bad_capture" ?
      { ok: false, status: 413, json: async () => ({ error: "Capture exceeds limit" }) } : null });
    const badId = await h.recorder.storeAudio(new Blob([new Uint8Array([1, 2, 3])]), { role: "bad_capture" });
    const goodId = await h.recorder.storeAudio(new Blob([new Uint8Array([4, 5, 6])]), { role: "microphone_original" });
    const eventId = h.recorder.emit("ui.click", { value: "after rejected clip" });
    await h.recorder.whenPersisted(); await h.recorder.flush();
    assert.ok(h.events.some(event => event.event_id === eventId), "one rejected clip cannot block later interaction events");
    assert.ok(h.media.some(item => item.media_id === goodId), "other audio still uploads");
    assert.equal(h.queue.records.length, 1);
    assert.equal(h.queue.records[0].data.media_id, badId);
    assert.deepEqual(new Uint8Array(await h.queue.records[0].audio.arrayBuffer()), new Uint8Array([1, 2, 3]));
    assert.equal(h.recorder.getState().rejected_count, 1);
    assert.equal(h.recorder.getState().rejected_error, "Capture exceeds limit");
    const attempts = h.media.filter(item => item.media_id === badId).length;
    await h.recorder.flush();
    assert.equal(h.media.filter(item => item.media_id === badId).length, attempts, "permanent media errors back off rather than repeatedly sending large blobs");
    const replay = fixture({ queue: h.queue, sessionStorage: h.sessionStorage });
    await replay.recorder.ready;
    assert.equal(replay.recorder.getState().rejected_count, 1, "rejected upload health survives reload");
    replay.recorder.emit("ui.click", { value: "after reload" });
    await replay.recorder.whenPersisted(); await replay.recorder.flush();
    assert.ok(replay.events.some(event => event.payload.value === "after reload"));
    assert.equal(replay.queue.records.length, 1, "unacknowledged original remains durable");
  }
  {
    const h = fixture({ online: false });
    const eventId = h.recorder.emit("ui.input", { value: "42" });
    await h.recorder.whenPersisted(); await h.recorder.flush();
    assert.ok(h.queue.records.some(row => row.data.event_id === eventId));
    assert.equal(h.recorder.getState().server_available, false);
    assert.equal(h.recorder.getState().memory_pending, 0, "offline data remains durable in IndexedDB");
    const previousSession = h.recorder.getContext().session_id;
    const replay = fixture({ queue: h.queue, sessionStorage: h.sessionStorage });
    assert.equal(replay.recorder.getContext().session_id, previousSession, "reload resumes participant session");
    assert.notEqual(replay.recorder.getContext().client_id, h.recorder.getContext().client_id, "each page load has distinct monotonic clock identity");
    await replay.recorder.whenPersisted(); await replay.recorder.flush();
    assert.ok(replay.events.some(event => event.event_id === eventId));
    assert.equal(replay.queue.records.length, 0);
    assert.equal(replay.recorder.getState().pending, 0);
    assert.equal(replay.recorder.getState().server_available, true);
  }
  {
    const h = fixture();
    await h.recorder.whenPersisted(); h.setAcknowledging(false);
    await h.recorder.flush();
    const retainedIds = h.queue.records.map(row => row.data.event_id).filter(Boolean);
    assert.ok(retainedIds.length);
    assert.match(h.recorder.getState().network_error, /not acknowledged/);
    h.setAcknowledging(true); await h.recorder.flush();
    for (const id of retainedIds) assert.equal(h.events.filter(event => event.event_id === id).length, 2, "retry preserves event ID for server deduplication");
    assert.equal(h.queue.records.length, 0);
  }
  {
    const h = fixture();
    await h.recorder.whenPersisted(); await h.recorder.flush();
    h.queue.failWrites = true;
    const id = h.recorder.emit("ui.input", { value: "not lost" });
    await h.recorder.whenPersisted();
    assert.match(h.recorder.getState().storage_error, /Quota/);
    assert.equal(h.recorder.getState().memory_pending, 1);
    h.queue.failWrites = false;
    await h.recorder.flush();
    assert.ok(h.events.some(event => event.event_id === id));
    assert.equal(h.recorder.getState().storage_error, "");
  }
  {
    const h = fixture({ online: false });
    const originalContext = h.recorder.getContext();
    h.recorder.newSession("P002");
    const bytes = Uint8Array.from([26, 69, 223, 163, 2, 3, 4]);
    const id = await h.recorder.storeAudio(new Blob([bytes], { type: "audio/webm;codecs=opus" }), { ...originalContext, role: "microphone_original", outcome: "cancelled" });
    await tick();
    const row = h.queue.records.find(item => item.data.media_id === id);
    assert.ok(row);
    assert.equal(row.data.session_id, originalContext.session_id, "capture belongs to session at microphone start");
    assert.equal(row.audio.type, "audio/webm;codecs=opus");
    assert.deepEqual(new Uint8Array(await row.audio.arrayBuffer()), bytes);
    h.setOnline(true); await h.recorder.flush();
    assert.equal(h.media[0].audio_base64, Buffer.from(bytes).toString("base64"));
    assert.equal(h.media[0].metadata.outcome, "cancelled");
    assert.equal(h.media[0].metadata.client_id, originalContext.client_id);
    assert.ok(h.events.find(event => event.type === "session.end" && event.session_id === originalContext.session_id));
    assert.ok(h.events.find(event => event.type === "session.start" && event.payload.participant_code === "P002"));
    const oldSession = h.recorder.getContext().session_id;
    assert.throws(() => h.recorder.newSession("x".repeat(101)), /at most 100/);
    assert.equal(h.recorder.getContext().session_id, oldSession);
  }
  {
    const h = fixture({ online: false });
    await h.recorder.whenPersisted(); h.queue.failWrites = true;
    await assert.rejects(h.recorder.storeAudio(new Blob([new Uint8Array([1, 2, 3])]), { role: "microphone_original" }), /Quota/);
    assert.equal(h.recorder.getState().memory_pending, 1, "failed audio write stays available for in-tab recovery");
    h.queue.failWrites = false; h.setOnline(true); await h.recorder.flush();
    assert.equal(h.media.length, 1);
  }
  {
    const h = fixture();
    for (let i = 0; i < 125; i++) h.recorder.emit("ui.input", { value: i, text: "é".repeat(2500) });
    await h.recorder.whenPersisted();
    await Promise.all([h.recorder.flush(), h.recorder.flush()]);
    const inputEvents = h.events.filter(event => event.type === "ui.input");
    assert.equal(inputEvents.length, 125);
    assert.deepEqual(inputEvents.map(event => event.payload.value), Array.from({ length: 125 }, (_, index) => index));
    assert.equal(new Set(inputEvents.map(event => event.event_id)).size, 125, "concurrent flush never duplicates local POSTs");
    const posts = h.calls.filter(call => call.url.endsWith("/events"));
    assert.ok(posts.every(call => call.body.events.length <= 40 && Buffer.byteLength(call.init.body) < 193000));
    assert.equal(h.queue.records.length, 0);
  }
  {
    const h = fixture();
    await h.recorder.whenPersisted();
    for (let index = 0; index < 12; index++) h.recorder.emit("ui.input", { value: "é".repeat(4000) });
    await h.recorder.whenPersisted(); await h.recorder.flush({ keepalive: true });
    // First flush acknowledges the session only, preserving order; next sends a bounded event batch.
    await h.recorder.flush({ keepalive: true });
    const call = h.calls.find(item => item.url.endsWith("/events"));
    assert.equal(call.init.keepalive, true);
    assert.ok(Buffer.byteLength(call.init.body) < 48000);
    assert.ok(h.queue.records.length > 0);
  }
  {
    let healthy = false;
    const h = fixture({ fetch: async url => url.endsWith("/status") ? { ok: true, json: async () => ({ device_id: "laptop-1", ready: healthy, last_error: healthy ? "" : "Audio archive failed" }) } : null });
    await h.recorder.status();
    await h.recorder.whenPersisted(); await h.recorder.flush();
    assert.equal(h.recorder.getState().pending, 0);
    assert.equal(h.recorder.getState().backend_health_error, "Audio archive failed", "event acknowledgements cannot hide server recording failures");
    healthy = true; await h.recorder.status();
    assert.equal(h.recorder.getState().backend_health_error, "");
  }
  {
    const h = fixture(), payload = { settings: { saved_sessions: "very large settings 😀".repeat(90000) } };
    const logicalId = h.recorder.emit("settings.snapshot", payload);
    const laterId = h.recorder.emit("ui.click", { value: "after big snapshot" });
    await h.recorder.whenPersisted(); await h.recorder.flush();
    const chunks = h.events.filter(event => event.type === "recording.event_chunk");
    assert.ok(chunks.length > 2);
    assert.equal(new Set(chunks.map(event => event.payload.logical_event_id)).size, 1);
    const reconstructed = JSON.parse(chunks.sort((a, b) => a.payload.chunk_index - b.payload.chunk_index).map(event => event.payload.json_fragment).join(""));
    assert.equal(reconstructed.event_id, logicalId);
    assert.equal(reconstructed.type, "settings.snapshot");
    assert.deepEqual(reconstructed.payload, payload, "oversized data reconstructs exactly, including split surrogate pairs");
    assert.ok(chunks.every(event => Buffer.byteLength(JSON.stringify(event)) < 1000000));
    assert.ok(chunks.every(event => event.payload.json_fragment.isWellFormed()), "each chunk is valid Unicode accepted by Python UTF-8 storage");
    assert.ok(h.events.some(event => event.event_id === laterId), "large snapshots cannot poison the ordered outbox");
  }
  {
    const h = fixture(); let nested = { value: "retained" };
    for (let depth = 0; depth < 45; depth++) nested = { nested };
    const id = h.recorder.emit("settings.snapshot", nested);
    await h.recorder.whenPersisted(); await h.recorder.flush();
    const chunk = h.events.find(event => event.payload.logical_event_id === id);
    assert.equal(chunk.type, "recording.event_chunk", "deep settings cannot exceed backend nesting limits and block the outbox");
    assert.deepEqual(JSON.parse(chunk.payload.json_fragment).payload, nested);
  }
  {
    const values = Array.from({ length: 1024 }, (_, index) => index);
    assert.deepEqual(clean({ password: "hidden", apiKey: "hidden", nested: { refresh_token: "hidden", transport_token: "track-one", token: "music-clock" }, values }),
      { nested: { transport_token: "track-one", token: "music-clock" }, values });
    const cyclic = {}; cyclic.self = cyclic;
    assert.equal(clean(cyclic).self, "[circular reference]");
    assert.equal(controlValue({ type: "password", value: "secret" }), "[excluded credential field]");
    assert.equal(controlValue({ type: "checkbox", checked: true }), true);
    assert.deepEqual(controlValue({ type: "file", files: [{ name: "signal.csv", size: 42, type: "text/csv" }] }), [{ name: "signal.csv", size: 42, type: "text/csv" }]);
    const parent = { id: "panel", children: [], tagName: "DIV" };
    const one = { parentElement: parent, tagName: "INPUT", dataset: {}, getAttribute: () => null }, two = { ...one };
    parent.children = [one, two];
    assert.notEqual(controlDescription(one).path, controlDescription(two).path, "anonymous sibling controls have distinct stable paths");
    parent.dataset = { mappingId: "mapping-2", source: "gesture", bus: "master", channel: "left", route: "route-3" };
    one.dataset = { parameter: "cutoff", bus: "filter" };
    assert.deepEqual(controlDescription(one).mapping_context,
      { parameter: "cutoff", bus: "filter", mapping_id: "mapping-2", source: "gesture", channel: "left", route: "route-3" },
      "repeated controls inherit their mapping identity and each closest routing attribute");
  }
  {
    const indexedDB = fakeIndexedDB(), queue = createIndexedDBQueue(indexedDB);
    let committed = false;
    const operation = queue.put({ kind: "event", data: { event_id: uuid() } }).then(() => { committed = true; });
    await tick();
    assert.equal(committed, false, "request success alone must not count as durable");
    assert.equal(indexedDB.database.records.length, 0);
    indexedDB.database.transactions.at(-1).commit(); await operation;
    assert.equal(committed, true); assert.equal(indexedDB.database.records.length, 1);
    indexedDB.database.fail = true;
    const failed = queue.put({ kind: "event", data: { event_id: uuid() } });
    await tick(); indexedDB.database.transactions.at(-1).commit();
    await assert.rejects(failed, /aborted/);
    assert.equal(indexedDB.database.records.length, 1);
    indexedDB.database.fail = false;
    indexedDB.database.records.push({ queue_id: 42, kind: "event", data: { event_id: uuid() } });
    const selected = queue.first(40, new Set([indexedDB.database.records[0].queue_id]));
    await tick(); indexedDB.database.transactions.at(-1).commit();
    assert.deepEqual((await selected).map(row => row.queue_id), [42], "IndexedDB cursor skips a rejected clip and reaches later events");
  }
  {
    const indexedDB = fakeIndexedDB(), queue = createIndexedDBQueue(indexedDB);
    const records = Array.from({ length: 128 }, (_, sequence) => ({ kind: "event", data: { event_id: uuid(), sequence } }));
    let committed = false;
    const operation = queue.putMany(records).then(ids => { committed = true; return ids; });
    await tick();
    assert.equal(indexedDB.database.transactions.length, 1, "a complete batch uses one IndexedDB transaction");
    assert.equal(committed, false);
    assert.equal(indexedDB.database.records.length, 0);
    indexedDB.database.transactions.at(-1).commit();
    const ids = await operation;
    assert.equal(ids.length, records.length);
    assert.deepEqual(indexedDB.database.records.map(row => row.data), records.map(row => row.data));
    indexedDB.database.fail = true;
    const failed = queue.putMany(records);
    await tick(); indexedDB.database.transactions.at(-1).commit();
    await assert.rejects(failed, /aborted/);
    assert.equal(indexedDB.database.records.length, records.length, "aborted batches cannot partly commit or lose the existing outbox");
    indexedDB.database.fail = false;
    const boundary = queue.lastId();
    await tick(); indexedDB.database.transactions.at(-1).commit();
    assert.equal(await boundary, ids.at(-1), "upload boundaries use the highest durable queue ID");
    await assert.rejects(queue.putMany([records[0], { kind: "invalid", value() {} }]), /clone/);
    const aborted = indexedDB.database.transactions.at(-1);
    assert.equal(aborted.aborted, true, "a synchronous add failure aborts earlier additions in the same batch");
    aborted.commit();
    assert.equal(indexedDB.database.records.length, records.length);
  }
  const html = fs.readFileSync(path.join(__dirname, "../dashboard/index.html"), "utf8");
  assert.match(html, /<details[^>]+id="study-panel"[^>]+\shidden[\s>]/, "researcher controls are hidden before JavaScript initializes");
  assert.match(html, /<script src="\/dashboard-config\.js" defer><\/script>\s*<script src="study-recorder\.js" defer>/, "server configuration precedes browser capture");
  const observerHTML = fs.readFileSync(path.join(__dirname, "../dashboard/observer/index.html"), "utf8");
  assert.match(observerHTML, /<script src="\/dashboard-config\.js" defer><\/script>\s*<script src="\/study-recorder\.js" defer>/, "standalone and embedded Observer use the same recording switch");
  assert.match(observerHTML, /<script src="\/study-recorder\.js" defer><\/script>\s*<script src="app\.js" defer>/, "standalone and embedded Observer initialize capture before app handlers");
  await testBrowserInteractions();
  await testBrowserInteractions({ query: "?researcher=1", researcher: true });
  await testBrowserInteractions({ query: "?researcher=0", researcher: false });
  await testBrowserInteractions({ pathname: "/observer/" });
  await testEmbeddedObserver();
  console.log("Study recorder: durable retry, acknowledgement, audio, sessions, background capture, researcher controls and redaction tests passed.");
}

async function testSustainedCapture() {
  const queue = memoryQueue(), commits = [], batchSizes = [], write = queue.putMany.bind(queue);
  queue.putMany = records => new Promise((resolve, reject) => {
    batchSizes.push(records.length);
    commits.push(async () => { try { resolve(await write(records)); } catch (error) { reject(error); } });
  });
  const h = fixture({ queue }), expected = [];
  function produce(count) {
    for (let index = 0; index < count; index++) {
      const payload = { input_sequence: expected.length, samples: Array.from({ length: 32 }, (_, value) => value / 31) };
      expected.push(payload); h.recorder.emit("input.frame", payload);
    }
  }
  produce(256);
  let finished = false;
  const flushing = h.recorder.flush().then(() => { finished = true; });
  await tick();
  // Input never stops while this flush is running. More records also arrive
  // during upload transactions, beyond the captured durable queue boundary.
  for (let step = 0; step < 30 && !finished; step++) {
    produce(128);
    assert.ok(commits.length, "the shared drain continues committing during live input");
    await commits.shift()(); await tick();
  }
  assert.ok(h.calls.some(call => call.url.endsWith("/events")), "continuous input cannot starve uploads waiting for an empty memory queue");
  assert.equal(finished, true, "a flush finishes at a finite boundary while new events keep arriving");
  await flushing;
  const persisted = h.recorder.whenPersisted();
  for (let step = 0; h.recorder.getState().memory_pending && step < 30; step++) {
    assert.ok(commits.length); await commits.shift()(); await tick();
  }
  await persisted; await h.recorder.flush();
  const actual = h.events.filter(event => event.type === "input.frame");
  assert.deepEqual(actual.map(event => event.payload), expected, "every full raw frame reaches the server exactly in input order");
  assert.equal(new Set(actual.map(event => event.event_id)).size, expected.length);
  assert.equal(h.recorder.getState().pending, 0);
  assert.equal(h.recorder.getState().memory_pending, 0);
  assert.ok(batchSizes.every(count => count <= 128), "transactions have bounded work");
  assert.ok(batchSizes.length < expected.length / 50, "bursts share transactions instead of allocating a write task per event");

  queue.failWrites = true;
  produce(256);
  const failedPersist = h.recorder.whenPersisted(); await tick();
  await commits.shift()(); await failedPersist;
  assert.equal(h.recorder.getState().memory_pending, 256, "the complete failed batch and following events remain in memory");
  assert.match(h.recorder.getState().storage_error, /Quota/);
  const before = batchSizes.length;
  produce(128); await tick();
  assert.equal(batchSizes.length, before, "ongoing input does not create a retry storm after storage failure");
  queue.failWrites = false;
  const recovering = h.recorder.flush(); await tick();
  for (let step = 0; h.recorder.getState().memory_pending && step < 10; step++) {
    await commits.shift()(); await tick();
  }
  await recovering;
  assert.deepEqual(h.events.filter(event => event.type === "input.frame").map(event => event.payload), expected, "recovery preserves failed records and later input without duplication");
  assert.equal(h.recorder.getState().storage_error, "");
  assert.equal(h.recorder.getState().pending, 0);
}

async function testNotificationRate() {
  let clock = 0, timerId = 0;
  const timers = new Map(), notifications = [];
  const h = fixture({ recorderOptions: { monotonic: () => clock,
    setTimeout(fn, delay) { timers.set(++timerId, { fn, due: clock + delay }); return timerId; },
    onState(state) { notifications.push({ time: clock, state }); } } });
  function advance(time) {
    for (const [id, timer] of timers) if (timer.due <= time) {
      clock = timer.due; timers.delete(id); timer.fn();
    }
    clock = time;
  }
  for (let index = 0; index < 500; index++) {
    advance(index * 2); h.recorder.emit("input.frame", { value: index });
    await tick();
  }
  await h.recorder.whenPersisted(); await h.recorder.flush(); advance(1250);
  assert.ok(notifications.length <= 6, "500 Hz capture produces at most four state updates per second plus endpoints");
  for (let index = 1; index < notifications.length; index++) {
    assert.ok(notifications[index].time - notifications[index - 1].time >= 250, "state rendering is separated by at least 250 ms");
  }
  assert.equal(notifications.at(-1).state.pending, 0, "the trailing notification publishes the latest committed state");
  assert.equal(h.events.filter(event => event.type === "input.frame").length, 500, "UI throttling never samples the captured stream");
}

function testMappingTracker() {
  function mappingFixture() {
    let context = { session_id: "participant-a", client_id: "browser-a" }, failType = null, brokenContext = false;
    const events = [];
    const recorder = {
      getContext() { if (brokenContext) throw new Error("Context unavailable"); return { ...context }; },
      emit(type, payload) {
        if (failType === type || failType === "*") throw new Error("Capture unavailable");
        events.push({ type, payload: structuredClone(payload) }); return uuid();
      }
    };
    return { events, recorder, tracker: createMappingTracker(recorder, "synth-mixer"),
      configurations: () => events.filter(event => event.type === "mapping.configuration").map(event => event.payload),
      playback: () => events.filter(event => event.type === "mapping.playback").map(event => event.payload),
      setContext: value => { context = value; }, setFailure: type => { failType = type; }, breakContext: () => { brokenContext = true; } };
  }
  {
    const h = mappingFixture(), a = { mappings: [{ id: "m1", source: "head", range: [0, 1], learnedMin: -2, learnedMax: 3 }], enabled: true };
    const first = h.tracker.capture(a, { action: "initial", nested: { retained: "yes" } });
    a.mappings[0].range[0] = -9;
    const b = h.tracker.capture(a, { action: "range" });
    a.mappings[0].range[0] = 0;
    const third = h.tracker.capture(a, { action: "undo" });
    const revisions = h.configurations();
    assert.equal(revisions.length, 3, "rapid A to B to A edits are preserved without snapshot debouncing");
    assert.equal(revisions[0].previous_revision_id, null);
    assert.equal(revisions[1].previous_revision_id, first.revision_id);
    assert.equal(revisions[2].previous_revision_id, b.revision_id);
    assert.notEqual(third.revision_id, first.revision_id, "returning to A is a distinct historical revision");
    assert.deepEqual(revisions[0].config, revisions[2].config);
    assert.equal(revisions[0].config.mappings[0].range[0], 0, "later mutations never change an earlier full configuration");
    assert.deepEqual(revisions[0].nested, { retained: "yes" });
    assert.equal("config" in h.tracker.current(), false, "frequent output associations do not clone full configurations");
    third.revision_id = "modified-by-caller";
    assert.equal(h.tracker.current().revision_id, revisions[2].revision_id);
    h.tracker.capture({ enabled: true, mappings: [{ range: [0, 1], source: "head", learnedMax: 3, learnedMin: -2, id: "m1" }] });
    assert.equal(h.configurations().length, 3, "object property ordering cannot create phantom trials");
    a.mappings[0].learnedMin = -50; a.mappings[0].learnedMax = 40;
    h.tracker.capture(a, { action: "same-value-edit" });
    assert.equal(h.configurations().length, 3, "automatic learned bounds do not turn an unchanged choice into another trial");
    h.tracker.capture(a, { action: "freeze", force: true });
    assert.equal(h.configurations().length, 4);
    assert.equal(h.configurations()[3].config.mappings[0].learnedMin, -50, "forced intentional learning actions retain complete actual bounds");
    assert.equal(h.configurations()[3].identity_policy, "configured-values-v1");
    assert.equal(h.playback().length, 0, "editing does not imply that a configuration was played");
  }
  {
    const h = mappingFixture(), config = { mappings: [{ source: { rangeMode: "auto", inputMin: 0, inputMax: 1,
      learnedMin: null, learnedMax: null, awaitingBounds: true, weight: 1 } }] };
    h.tracker.capture(config);
    Object.assign(config.mappings[0].source, { inputMin: -30, inputMax: 40, learnedMin: -30, learnedMax: 40, awaitingBounds: false });
    h.tracker.capture(config);
    assert.equal(h.configurations().length, 1, "all automatic calibration fields are excluded from configured-value comparison");
    h.tracker.capture(config, { action: "relearn", force: true });
    assert.equal(h.configurations().length, 2, "an explicit relearn action remains a distinct recorded choice");
    assert.deepEqual(h.configurations()[1].config, config, "identity exclusions never discard full configuration data");
    config.mappings[0].source.rangeMode = "fixed";
    h.tracker.capture(config, { action: "freeze" });
    config.mappings[0].source.inputMin = -10;
    h.tracker.capture(config, { action: "inputMin" });
    config.mappings[0].source.inputMax = 20;
    h.tracker.capture(config, { action: "inputMax" });
    assert.equal(h.configurations().length, 5, "fixed range minimum and maximum choices remain part of mapping identity");
  }
  {
    const h = mappingFixture(), a = { mappings: [{ id: "one", source: "pitch", learnedMin: 0, learnedMax: 1 }] };
    h.tracker.playback(a, { running: false, output: "hydrasynth" });
    assert.equal(h.configurations().length, 1);
    assert.equal(h.playback().length, 0, "idle startup does not create a played-mapping event");
    h.tracker.playback(null, { running: true, output: "hydrasynth", track: "take-1", reason: "start" });
    for (let tick = 0; tick < 100; tick++) {
      a.mappings[0].learnedMin = -tick;
      h.tracker.playback(null, { track: "take-1", output: "hydrasynth", running: true, reason: `refresh-${tick}` });
    }
    assert.equal(h.configurations().length, 1, "playback refreshes do not sample mutable engine configurations");
    assert.equal(h.playback().length, 1, "repeated playback status cannot flood the journal");
    const edited = h.tracker.capture({ mappings: [{ id: "one", source: "amplitude" }] }, { action: "source" });
    assert.equal(h.playback().at(-1).phase, "configuration_change");
    assert.equal(h.playback().at(-1).revision_id, edited.revision_id);
    h.tracker.playback(null, { running: true, output: "hydrasynth", track: "take-1" });
    assert.equal(h.playback().length, 2, "explicit status after capture shares the existing association");
    h.tracker.playback(null, { running: true, output: "speakers", track: "take-1" });
    assert.equal(h.playback().at(-1).phase, "context_change");
    h.tracker.playback(null, { running: false, reason: "stop" });
    h.tracker.playback(null, { running: false, reason: "still stopped" });
    h.tracker.playback(null, { running: true, output: "speakers", track: "take-1" });
    assert.deepEqual(h.playback().map(event => event.phase), ["start", "configuration_change", "context_change", "stop", "start"]);
    h.setContext({ session_id: "participant-b", client_id: "browser-a" });
    assert.equal(h.tracker.current(), null, "an old participant revision is never returned as the new participant's current mapping");
    const baseline = h.tracker.playback(null, { running: true, output: "speakers", track: "take-1" });
    assert.equal(h.configurations().length, 3);
    assert.equal(h.configurations().at(-1).previous_revision_id, null);
    assert.deepEqual(h.configurations().at(-1).config, { mappings: [{ id: "one", source: "amplitude" }] });
    assert.equal(baseline.session_id, "participant-b");
    assert.equal(h.playback().at(-1).session_id, "participant-b");
    assert.equal(h.playback().at(-1).phase, "start");
    h.setContext({ session_id: "participant-b", client_id: "browser-b" });
    h.tracker.capture({ mappings: [{ id: "one", source: "amplitude" }] });
    assert.equal(h.configurations().at(-1).previous_revision_id, null, "a new browser client has its own baseline chain");
    assert.equal(h.configurations().at(-1).client_id, "browser-b");
  }
  {
    const h = mappingFixture(); h.setFailure("mapping.configuration");
    assert.doesNotThrow(() => h.tracker.capture({ mappings: [] }));
    assert.equal(h.tracker.current(), null);
    assert.ok(h.events.some(event => event.type === "recording.mapping_error"));
    h.setFailure(null); h.tracker.capture({ mappings: [] });
    assert.equal(h.configurations().length, 1, "an emit failure does not advance configuration deduplication");
    h.setFailure("mapping.playback");
    assert.doesNotThrow(() => h.tracker.playback(null, { running: true }));
    h.setFailure(null); h.tracker.playback(null, { running: true });
    assert.equal(h.playback().length, 1, "failed playback association is retried on the next observed state");
    h.setFailure("mapping.playback");
    const next = h.tracker.capture({ mappings: [{ id: "new" }] });
    assert.equal(h.configurations().length, 2, "a configuration accepted before a playback error remains recorded");
    h.setFailure(null); h.tracker.capture({ mappings: [{ id: "new" }] });
    assert.equal(h.playback().at(-1).revision_id, next.revision_id, "a no-op capture retries its failed active-playback association");
    const before = h.tracker.current();
    assert.doesNotThrow(() => h.tracker.capture({ invalid: 1n }));
    assert.deepEqual(h.tracker.current(), before, "unserializable input does not corrupt the previously accepted revision");
    h.setFailure("*"); h.breakContext();
    assert.doesNotThrow(() => h.tracker.capture({ mappings: [] }));
    assert.doesNotThrow(() => h.tracker.playback(null, { running: true }));
    assert.equal(h.tracker.current(), null);
  }
}

async function testRecordingDisabled() {
  for (const configured of [false, undefined]) for (const embedded of [false, true]) {
    const elements = new Map(), readyListeners = [], fetches = [];
    for (const id of ["study-panel", "study-status", "study-description", "study-session", "study-device", "study-backup-status",
      "study-participant", "study-new-session", "study-export", "study-warning", "study-backup-warning"]) {
      elements.set(id, { hidden: true, dataset: {}, attributes: { href: "/api/study/export" },
        removeAttribute(name) { delete this.attributes[name]; }, setAttribute(name, value) { this.attributes[name] = value; } });
    }
    const browser = {
      HydraDashboardConfig: configured === undefined ? undefined : { study_recording: configured },
      document: { readyState: embedded ? "complete" : "loading", getElementById: id => elements.get(id),
        addEventListener(type, callback) { assert.equal(type, "DOMContentLoaded", "disabled capture installs no interaction listeners"); readyListeners.push(callback); },
        querySelectorAll() { assert.fail("disabled capture must not inspect controls"); } },
      location: { href: `http://localhost:8790/${embedded ? "observer/" : "?researcher=1"}` },
      parent: embedded ? { get HydraStudy() { assert.fail("disabled frames cannot borrow an enabled parent's recorder"); } } : undefined,
      fetch: async (...args) => { fetches.push(args); return { ok: true }; },
      history: { pushState() {}, replaceState() {} },
      addEventListener() { assert.fail("disabled capture installs no window listeners"); },
      setTimeout() { assert.fail("disabled capture schedules no tasks"); },
      setInterval() { assert.fail("disabled capture schedules no retries or snapshots"); },
      MutationObserver: class { constructor() { assert.fail("disabled capture must not observe DOM mutations"); } }
    };
    for (const key of ["indexedDB", "sessionStorage", "localStorage", "crypto", "navigator"]) {
      Object.defineProperty(browser, key, { get() { assert.fail(`disabled capture must not access ${key} or modify existing data`); } });
    }
    const originalFetch = browser.fetch, originalPush = browser.history.pushState, originalReplace = browser.history.replaceState;
    installBrowser(browser); readyListeners.forEach(callback => callback()); await tick();
    assert.equal(browser.HydraStudy, undefined, "semantic event hooks remain inactive");
    assert.equal(browser.fetch, originalFetch); assert.equal(browser.history.pushState, originalPush); assert.equal(browser.history.replaceState, originalReplace);
    assert.equal(fetches.length, 0, "disabled mode makes no health check, upload or queued-data replay requests");
    assert.equal(elements.get("study-status").textContent, "Disabled");
    assert.equal(elements.get("study-status").dataset.state, "disabled");
    assert.equal(elements.get("study-panel").hidden, embedded);
    assert.equal(elements.get("study-warning").hidden, true);
    assert.equal(elements.get("study-new-session").disabled, true);
    assert.equal(elements.get("study-export").attributes.href, undefined);
    await browser.fetch("/api/midi-safety/heartbeat", { method: "POST", body: "{}" });
    assert.equal(fetches[0][0], "/api/midi-safety/heartbeat", "ordinary app requests, including MIDI safety, remain untouched");
    assert.equal(fetches[0][1].headers, undefined);
  }
}

async function testBrowserErrors() {
  const parent = fixture(), listeners = [];
  const browser = {
    HydraDashboardConfig: { study_recording: true },
    parent: { location: { origin: "http://localhost:8790" }, HydraStudy: parent.recorder },
    location: { origin: "http://localhost:8790", href: "http://localhost:8790/observer/", pathname: "/observer/", hash: "" },
    document: { readyState: "loading", baseURI: "http://localhost:8790/assets/", addEventListener() {} },
    history: { pushState() {}, replaceState() {} },
    addEventListener(type, callback, options) { listeners.push({ type, callback, capture: options === true || options?.capture === true }); },
    async fetch() { assert.fail("recording browser errors must not fetch resources"); }
  };
  installBrowser(browser);
  const error = (target, details = {}) => {
    // Resource errors reach window only during capture; a runtime ErrorEvent targets window itself.
    for (const listener of listeners) if (listener.type === "error" && (target === browser || listener.capture)) listener.callback({ target, ...details });
  };
  error({ tagName: "SCRIPT", src: "https://private-user:private-password@example.org/app.js?token=private-token#private-fragment" });
  error({ tagName: "LINK", rel: "alternate STYLESHEET", href: "mixer.css?token=private-token#private-fragment" });
  error({ tagName: "SCRIPT", src: "data:text/javascript,private-script-body" });
  error({ tagName: "LINK", rel: "stylesheet", href: "http://[invalid-private-host" });
  error({ tagName: "IMG", src: "private-image-url" });
  error({ tagName: "AUDIO", src: "private-audio-url" });
  error({ tagName: "LINK", rel: "icon", href: "private-icon-url" });
  error({ tagName: "LINK", rel: "preload", href: "private-preload-url" });
  error(browser, { message: "Workspace failed", filename: "/app.js", lineno: 12, colno: 4, error: { stack: "Error: Workspace failed\n    at /app.js:12:4" } });
  await parent.recorder.whenPersisted(); await parent.recorder.flush();
  const resources = parent.events.filter(event => event.type === "client.resource_error");
  assert.deepEqual(resources.map(event => [event.payload.resource_type, event.payload.path]), [
    ["script", "/app.js"], ["stylesheet", "/assets/mixer.css"], ["script", null], ["stylesheet", null]
  ], "capture missing scripts and stylesheets without recording other resource errors");
  assert.ok(!JSON.stringify(resources).includes("private-"), "resource diagnostics omit credentials, query strings, fragments, and non-HTTP URLs");
  const runtime = parent.events.filter(event => event.type === "client.error");
  assert.equal(runtime.length, 1, "runtime JavaScript errors are still recorded exactly once");
  assert.equal(runtime[0].payload.message, "Workspace failed");
  assert.equal(runtime[0].payload.filename, "/app.js");
  assert.equal(runtime[0].payload.line, 12);
  assert.equal(runtime[0].payload.column, 4);
  assert.equal(runtime[0].payload.stack, "Error: Workspace failed\n    at /app.js:12:4");
}

async function testBrowserInteractions({ query = "", researcher = false, pathname = "/" } = {}) {
  const uiTimers = new Map(); let timerId = 0;
  const renderPending = () => {
    for (const [id, timer] of uiTimers) if (timer.delay > 100 && timer.delay <= 250) {
      uiTimers.delete(id); timer.fn();
    }
  };
  const listeners = new Map(), windowListeners = new Map(), elements = new Map(), requests = [], sessionStorage = storage(), localStorage = storage();
  let online = true, backendError = "", persistenceRequests = 0, persistenceChecks = 0;
  const backup = { enabled: true, destination: "/local-study/backups/browser-laptop", state: "idle", last_completed_at: "2026-10-19T12:00:00Z", last_error: "" };
  const add = (collection, type, fn) => { if (!collection.has(type)) collection.set(type, []); collection.get(type).push(fn); };
  function element(id, value, type = "range") {
    const item = { id, value, type, tagName: "INPUT", dataset: {}, labels: [], name: "", hidden: false, listeners: new Map(),
      closest(selector) { return selector === "[data-study-ui]" ? null : this; }, getAttribute: () => null,
      addEventListener(type, fn) { add(this.listeners, type, fn); } };
    elements.set(id, item); return item;
  }
  const slider = element("busy", "20"), text = element("lyrics", "hello", "text"), password = element("api-key", "private-key", "password");
  for (const id of ["study-panel", "study-status", "study-device", "study-session", "study-warning", "study-new-session", "study-participant", "study-export", "study-backup-status", "study-backup-path", "study-backup-warning"]) element(id, "", "text");
  elements.get("study-panel").hidden = true;
  localStorage.setItem("hydra.settings", JSON.stringify({ value: 2, password: "nope", transport_token: "track-one" }));
  localStorage.setItem("unrelated", "do not capture");
  // Auto-commit transactions after handlers are installed.
  const indexedDB = fakeIndexedDB();
  const transaction = indexedDB.database.transaction.bind(indexedDB.database);
  indexedDB.database.transaction = (...args) => { const tx = transaction(...args); queueMicrotask(() => tx.commit()); return tx; };
  const document = { readyState: "loading", body: { dataset: { workspace: "synth-mixer" } },
    getElementById: id => elements.get(id) || null, querySelectorAll: () => [slider, text, password],
    addEventListener: (type, fn) => add(listeners, type, fn) };
  const browser = { HydraDashboardConfig: { study_recording: true }, document, indexedDB, crypto: { randomUUID: uuid }, sessionStorage, localStorage,
    navigator: { userAgent: "Test browser", language: "en", storage: {
      persisted() { persistenceChecks++; return Promise.resolve(false); },
      persist() { persistenceRequests++; return Promise.resolve(true); }
    } }, innerWidth: 1280, innerHeight: 800,
    location: { href: `http://localhost:8790${pathname}${query}#synth-mixer`, origin: "http://localhost:8790", pathname, hash: "#synth-mixer" },
    history: { pushState() {}, replaceState() {} },
    setTimeout(fn, delay) { uiTimers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout(id) { uiTimers.delete(id); }, setInterval() {},
    addEventListener: (type, fn) => add(windowListeners, type, fn),
    async fetch(url, init = {}) {
      const body = init.body ? JSON.parse(init.body) : null; requests.push({ url, init, body });
      if (!online) throw new Error("Offline");
      let payload = { ready: !backendError, last_error: backendError, device_id: "browser-laptop", backup: { ...backup } };
      if (String(url).endsWith("/sessions")) payload = { session_id: body.session_id };
      if (String(url).endsWith("/events")) payload = { acknowledged_event_ids: body.events.map(event => event.event_id) };
      return { ok: true, status: 200, json: async () => payload };
    }
  };
  installBrowser(browser);
  for (const fn of listeners.get("DOMContentLoaded")) fn();
  await tick();
  assert.equal(elements.get("study-panel").hidden, !researcher, "only the explicit researcher URL reveals the controls");
  assert.equal(persistenceRequests, researcher ? 1 : 0, "participant mode cannot trigger a storage permission prompt");
  assert.equal(persistenceChecks, researcher ? 0 : 1);
  const dispatch = (type, target, more = {}) => { for (const fn of listeners.get(type) || []) fn({ type, target, isTrusted: true, ...more }); };
  dispatch("pointerdown", slider);
  for (const value of ["21", "22", "24"]) { slider.value = value; dispatch("input", slider); }
  slider.value = "99"; dispatch("input", slider, { isTrusted: false });
  dispatch("focusin", text); text.value = "new draft"; dispatch("input", text, { inputType: "insertText" });
  dispatch("input", password);
  dispatch("keydown", text, { key: "a", code: "KeyA" });
  dispatch("keydown", text, { key: "Escape", code: "Escape" });
  const mappingRow = { tagName: "DIV", id: "mapping-row", dataset: { mappingId: "mapping-42", bus: "drums" }, children: [] };
  const choice = element("mapping-source", "amplitude", "select-one");
  choice.tagName = "SELECT"; choice.parentElement = mappingRow; choice.dataset = { parameter: "velocity" }; mappingRow.children.push(choice);
  dispatch("focusin", choice); choice.value = "pitch"; dispatch("change", choice);
  const disclosure = { tagName: "DETAILS", id: "advanced-mapping", dataset: {}, open: false, children: [], closest: () => null };
  const summary = { tagName: "SUMMARY", dataset: {}, textContent: "Advanced mappings", parentElement: disclosure,
    closest(selector) { return selector === "[data-study-ui]" ? null : selector === "details" ? disclosure : this; } };
  disclosure.children.push(summary);
  dispatch("click", summary, { clientX: 25, clientY: 40, button: 0, pointerType: "mouse" });
  disclosure.open = true; dispatch("toggle", disclosure);
  const background = { tagName: "DIV", id: "canvas-background", dataset: {}, textContent: "Unrelated page text is not a control label", closest: () => null };
  browser.scrollY = 200;
  dispatch("click", background, { clientX: 11, clientY: 24, button: 0, pointerType: "touch" });
  dispatch("input", background, { inputType: "insertText" });
  const hiddenResearcher = { ...background, id: "researcher-background", closest: selector => selector === "[data-study-ui]" ? {} : null };
  dispatch("click", hiddenResearcher, { clientX: 1, clientY: 1 });
  await browser.HydraStudy.whenPersisted(); await browser.HydraStudy.flush();
  const events = requests.filter(request => String(request.url).endsWith("/events")).flatMap(request => request.body.events);
  assert.equal(events.find(event => event.type === "client.open").payload.page, `${pathname}#synth-mixer`);
  const sliders = events.filter(event => event.type === "ui.input" && event.payload.control.id === "busy");
  assert.deepEqual(sliders.map(event => [event.payload.previous_value, event.payload.value]), [["20", "21"], ["21", "22"], ["22", "24"]]);
  assert.equal(events.filter(event => event.type === "ui.shortcut").length, 1, "typing characters are not duplicated as keystrokes");
  assert.equal(events.find(event => event.type === "ui.input" && event.payload.control.id === "lyrics").payload.value, "new draft");
  const choiceEvent = events.find(event => event.type === "ui.change" && event.payload.control.id === "mapping-source");
  assert.equal(choiceEvent.payload.previous_value, "amplitude");
  assert.equal(choiceEvent.payload.value, "pitch");
  assert.deepEqual(choiceEvent.payload.control.mapping_context, { parameter: "velocity", mapping_id: "mapping-42", bus: "drums" });
  const summaryClick = events.find(event => event.type === "ui.click" && event.payload.control.tag === "summary");
  assert.equal(summaryClick.payload.control.label, "Advanced mappings");
  assert.equal(summaryClick.payload.value, false, "summary click captures the state before its default disclosure action");
  assert.equal(events.find(event => event.type === "ui.disclosure").payload.open, true, "disclosure event records the resulting open state");
  const backgroundClick = events.find(event => event.type === "ui.click" && event.payload.control.id === "canvas-background");
  assert.equal(backgroundClick.payload.control.label, null, "noncontrol clicks do not duplicate arbitrary page text");
  assert.equal(backgroundClick.payload.x, 11); assert.equal(backgroundClick.payload.y, 24);
  assert.equal(backgroundClick.payload.page_x, 11); assert.equal(backgroundClick.payload.page_y, 224);
  assert.equal(backgroundClick.payload.scroll_y, 200);
  assert.deepEqual(backgroundClick.payload.viewport, { width: 1280, height: 800 });
  assert.equal(events.filter(event => event.payload.control?.id === "canvas-background").length, 1, "only click expands capture to arbitrary elements");
  assert.equal(events.filter(event => event.payload.control?.id === "researcher-background").length, 0, "arbitrary clicks still exclude researcher controls");
  assert.equal(typeof browser.HydraStudy.createMappingTracker, "function");
  const snapshot = events.find(event => event.type === "settings.snapshot");
  assert.deepEqual(snapshot.payload.settings, { "hydra.settings": { value: 2, transport_token: "track-one" } });
  assert.ok(!JSON.stringify(events).includes("private-key"));
  assert.equal(browser.HydraStudy.getState().pending, 0, "capture is acknowledged in the background with or without visible controls");
  renderPending();
  assert.equal(elements.get("study-status").textContent, "Saved locally");
  assert.match(elements.get("study-backup-status").textContent, /^Backup written /);
  assert.equal(elements.get("study-backup-path").textContent, backup.destination);
  backup.last_error = "Backup destination is full"; backup.state = "error";
  await browser.HydraStudy.status();
  renderPending();
  assert.equal(browser.HydraStudy.getState().backend_health_error, "", "backup failure is independent of local recording health");
  assert.equal(elements.get("study-status").textContent, "Saved locally · backup error");
  assert.match(elements.get("study-backup-warning").textContent, /Backup destination is full/);
  assert.equal(elements.get("study-backup-warning").hidden, false);
  assert.equal(elements.get("study-panel").hidden, !researcher, "backup failure never interrupts the participant interface");
  backup.last_error = ""; backup.state = "writing";
  await browser.HydraStudy.status();
  renderPending();
  assert.match(elements.get("study-backup-status").textContent, /^Writing backup/);
  assert.equal(elements.get("study-backup-warning").hidden, true);
  backup.state = "idle"; await browser.HydraStudy.status();
  online = false;
  text.value = "offline edit"; dispatch("input", text);
  await browser.HydraStudy.whenPersisted(); await browser.HydraStudy.flush();
  renderPending();
  assert.ok(browser.HydraStudy.getState().pending > 0);
  assert.equal(elements.get("study-warning").hidden, false, "pending failure details remain available inside researcher controls");
  assert.match(elements.get("study-warning").textContent, /Offline/);
  assert.equal(elements.get("study-panel").hidden, !researcher, "an error never reveals controls to participants");
  online = true; await browser.HydraStudy.flush();
  assert.equal(browser.HydraStudy.getState().pending, 0);
  backendError = "Disk full"; await browser.HydraStudy.status();
  renderPending();
  assert.equal(elements.get("study-status").textContent, "Recording error");
  assert.equal(elements.get("study-warning").textContent, "Disk full");
  assert.equal(elements.get("study-panel").hidden, !researcher);
  backendError = ""; await browser.HydraStudy.status();
  browser.location.hash = "#rap-response";
  for (const fn of windowListeners.get("hashchange") || []) fn();
  assert.equal(elements.get("study-panel").hidden, !researcher, "switching workspaces preserves the selected view");
  if (researcher) {
    const before = browser.HydraStudy.getContext().session_id;
    elements.get("study-participant").value = "P123";
    for (const fn of elements.get("study-new-session").listeners.get("click") || []) fn();
    assert.notEqual(browser.HydraStudy.getContext().session_id, before);
    assert.equal(browser.HydraStudy.getState().participant_code, "P123");
    assert.equal(elements.get("study-participant").value, "");
  } else assert.equal(elements.get("study-new-session").listeners.size, 0);
  await browser.fetch("/api/rap-response/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(requests.at(-1).init.headers.get("X-Study-Session"), browser.HydraStudy.getContext().session_id);
  await browser.fetch("https://api.example.org/external");
  assert.equal(requests.at(-1).init.headers, undefined, "study IDs never leak to third-party requests");
  await browser.fetch("/api/study/status");
  assert.equal(requests.at(-1).init.headers, undefined, "recorder's own traffic is not wrapped recursively");
}

async function testEmbeddedObserver() {
  const parent = fixture(), documentListeners = new Map(), windowListeners = new Map(), requests = [], intervals = [];
  const add = (collection, type, fn) => { if (!collection.has(type)) collection.set(type, []); collection.get(type).push(fn); };
  const source = { id: "observer-source", tagName: "SELECT", value: "auto", type: "select-one", dataset: {}, labels: [],
    closest(selector) { return selector === "[data-study-ui]" ? null : this; }, getAttribute: () => null };
  const parentWindow = { location: { origin: "http://localhost:8790" }, HydraStudy: parent.recorder };
  const browser = {
    HydraDashboardConfig: { study_recording: true },
    parent: parentWindow,
    location: { origin: "http://localhost:8790", href: "http://localhost:8790/observer/?embedded=1&researcher=1", pathname: "/observer/", hash: "" },
    document: { readyState: "loading", body: { dataset: {} }, getElementById: () => null, querySelectorAll: () => [source],
      addEventListener: (type, fn) => add(documentListeners, type, fn) },
    localStorage: storage(), navigator: { userAgent: "Observer frame", language: "en", storage: {
      persist() { assert.fail("an embedded frame must not request storage permission"); },
      persisted() { assert.fail("browser storage is owned by the parent recorder"); }
    } }, innerWidth: 1000, innerHeight: 700,
    history: { pushState() {}, replaceState() {} }, setTimeout: () => 1, clearTimeout() {},
    setInterval: (fn, delay) => intervals.push({ fn, delay }),
    addEventListener: (type, fn) => add(windowListeners, type, fn),
    async fetch(url, init = {}) { requests.push({ url, init }); return { ok: true, status: 200, json: async () => ({}) }; }
  };
  Object.defineProperty(browser, "indexedDB", { get() { assert.fail("embedded capture must use the existing parent's outbox"); } });
  Object.defineProperty(browser, "sessionStorage", { get() { assert.fail("embedded capture must not initialize a separate participant session"); } });
  Object.defineProperty(browser, "crypto", { get() { assert.fail("embedded capture must not initialize another client"); } });
  const firstContext = parent.recorder.getContext();
  installBrowser(browser);
  for (const fn of documentListeners.get("DOMContentLoaded")) fn();
  const dispatch = type => { for (const fn of documentListeners.get(type) || []) fn({ type, target: source, isTrusted: true }); };
  dispatch("pointerdown"); source.value = "signal-lab"; dispatch("change");
  for (const fn of windowListeners.get("focus") || []) fn();
  await browser.HydraStudy.whenPersisted(); await parent.recorder.flush();
  assert.equal(parent.calls.filter(call => call.url.endsWith("/sessions")).length, 1);
  assert.equal(parent.events.filter(event => event.type === "client.open").length, 1, "frame initialization must not duplicate the parent client's open event");
  const changed = parent.events.find(event => event.type === "ui.change");
  assert.equal(changed.session_id, firstContext.session_id);
  assert.equal(changed.client_id, firstContext.client_id);
  assert.equal(changed.payload.value, "signal-lab");
  assert.equal(changed.payload.frame_path, "/observer/");
  assert.equal(changed.payload.source_page, "/observer/");
  assert.equal(parent.events.find(event => event.type === "client.focus").payload.frame_path, "/observer/");
  assert.deepEqual(intervals.map(item => item.delay), [30000], "only frame snapshots repeat; the parent owns flush and health timers");
  assert.equal(requests.length, 0, "embedded capture creates no independent recorder traffic");
  const secondContext = parent.recorder.newSession("P002");
  dispatch("click");
  await browser.fetch("/api/observer/source", { method: "POST", body: "{}" });
  assert.equal(requests.at(-1).init.headers.get("X-Study-Session"), secondContext.session_id);
  assert.equal(requests.at(-1).init.headers.get("X-Study-Client"), firstContext.client_id);
  await browser.HydraStudy.whenPersisted(); await parent.recorder.flush();
  const clicked = parent.events.find(event => event.type === "ui.click");
  assert.equal(clicked.session_id, secondContext.session_id, "a parent handover immediately changes frame event attribution");
  assert.equal(clicked.payload.frame_path, "/observer/");
  assert.equal(parent.calls.filter(call => call.url.endsWith("/sessions")).length, 2, "only the explicit parent handover adds a session");
  assert.equal(parent.events.filter(event => event.type === "client.open").length, 1);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
