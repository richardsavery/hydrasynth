"use strict";
const assert = require("node:assert/strict");
const { create, INTERVAL_MS } = require("../dashboard/runtime-diagnostics.js");
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function fixture(fetch) {
  const intervals = new Map(), timers = new Map(), listeners = new Map(), posts = [], beacons = [];
  let clock = 0, next = 0;
  const host = {
    crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" }, AbortController, Blob,
    performance: { now: () => clock, memory: { usedJSHeapSize: 1000, totalJSHeapSize: 2000, jsHeapSizeLimit: 3000 } },
    document: { visibilityState: "visible", getElementsByTagName: tag => tag === "canvas" ? [{ width: 100, height: 200 }] : { length: 150 } },
    navigator: { sendBeacon: (_url, body) => { beacons.push(body); return true; } },
    setInterval: fn => { intervals.set(++next, fn); return next; }, clearInterval: id => intervals.delete(id),
    setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id),
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
    fetch: async (url, options) => { posts.push(JSON.parse(options.body)); return fetch ? fetch(url, options) : { ok: true }; },
  };
  return { host, intervals, timers, listeners, posts, beacons, monitor: create(host),
    async tick(delay = INTERVAL_MS) { clock += delay; for (const fn of intervals.values()) fn(); await settle(); } };
}

(async () => {
  {
    const h = fixture();
    h.monitor.start();
    await settle();
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].dom_nodes, 150);
    assert.equal(h.posts[0].canvas_pixels, 20000);
    assert.equal(h.posts[0].heap_used_bytes, 1000);
    for (let index = 0; index < 100; index++) h.listeners.get("error")({ filename: "http://localhost/app.js?secret=never-save", lineno: index, message: "never-save" });
    h.listeners.get("unhandledrejection")({ reason: "never-save" });
    await h.tick(12000);
    const sample = h.posts.at(-1);
    assert.equal(sample.tick_late_ms, 7000);
    assert.equal(sample.error_count, 100);
    assert.equal(sample.rejection_count, 1);
    assert.equal(sample.errors.length, 8);
    assert.ok(!JSON.stringify(sample).includes("never-save"));
    h.listeners.get("pagehide")();
    assert.equal(h.beacons.length, 1);
    assert.equal(JSON.parse(await h.beacons[0].text()).reason, "pagehide");
    assert.equal(h.intervals.size, 0);
    assert.equal(h.listeners.size, 0);
  }
  {
    const h = fixture((_url, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    h.monitor.start();
    for (let index = 0; index < 1000; index++) await h.tick();
    assert.equal(h.posts.length, 1, "an unresponsive request cannot create a queue");
    assert.equal(h.timers.size, 1);
    for (const fn of [...h.timers.values()]) fn();
    await settle();
    await h.tick();
    assert.equal(h.posts.length, 2, "a timed out request allows the next bounded attempt");
    assert.equal(h.posts[1].send_failures, 1);
    h.monitor.stop();
    await settle();
    assert.equal(h.timers.size, 0);
  }
  console.log("runtime diagnostics: bounded health samples and no private event payloads verified");
})().catch(error => { console.error(error); process.exitCode = 1; });
