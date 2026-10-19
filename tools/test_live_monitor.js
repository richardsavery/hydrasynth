"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor() {
    this.innerHTML = ""; this.textContent = ""; this.hidden = false; this.disabled = false;
    this.value = ""; this.dataset = {}; this.attributes = {}; this.listeners = new Map();
    this.classes = new Set(); this.classList = { add: (value) => this.classes.add(value),
      toggle: (value, enabled) => enabled ? this.classes.add(value) : this.classes.delete(value) };
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  async dispatch(name) { await this.listeners.get(name)?.({ target: this }); }
}

(async () => {
  const elements = new Map();
  const container = new Element();
  container.querySelector = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const $ = (id) => container.querySelector(`#${id}`);
  let copied = "", clearCount = 0, reconnectCount = 0;
  const context = vm.createContext({ URL, navigator: { clipboard: { writeText: async (contents) => { copied = contents; } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard/live-monitor.js"), "utf8"), context);
  let now = 100, current = 0.2;
  let field = { key: "robot|data:0", channelId: "robot", name: "joint_1 position", kind: "position", reducer: "value", value: current,
    count: 1, preview: [current], minimum: 0, maximum: 1, stale: false, age: 0 };
  let snapshot = { now, url: "ws://user:pass@example.test:8765/path?token=secret#private", connected: true, state: "open", rate: 10,
    dataAge: 0, counts: { messages: 4, dataFrames: 4, statusFrames: 0, invalidFrames: 0 },
    channels: [{ id: "robot", name: "Robot", numeric: true, stale: false }], fields: [field],
    raw: { text: "<img src=x onerror=alert(1)>", length: 29, truncated: false }, events: [],
    diagnostic: { level: "good", title: "Live data is arriving", detail: "Numeric values are ready." } };
  const monitor = context.HydraLiveMonitor.init({ container, getSnapshot: () => structuredClone(snapshot),
    getInspection: (key) => key === field.key ? { ...structuredClone(field), points: [[0, 0], [now, current]] } : null,
    onClear: () => { clearCount++; }, onReconnect: () => { reconnectCount++; } });
  assert.equal($("lm-state").textContent, "Receiving data");
  assert.equal($("lm-value").textContent, "0.2");
  assert.match($("lm-field").innerHTML, /joint_1 Position/);
  assert.equal($("lm-raw").textContent, "<img src=x onerror=alert(1)>", "Raw input must be inserted as text, never HTML");
  assert.match($("lm-raw-meta").textContent, /characters/);
  const firstGraph = $("lm-scope-path").attributes.d;

  // Pausing is a display operation: readers remain live and diagnostics keep updating.
  await $("lm-pause").dispatch("click");
  now = 5000; current = 0.8;
  field = { ...field, value: current, preview: [current], stale: true, age: 4100 };
  snapshot = { ...snapshot, now, rate: 0, fields: [field], dataAge: 4100,
    channels: [{ ...snapshot.channels[0], stale: true }], counts: { ...snapshot.counts, messages: 8 } };
  monitor.render();
  assert.equal($("lm-value").textContent, "0.2");
  assert.equal($("lm-scope-path").attributes.d, firstGraph);
  assert.equal($("lm-state").textContent, "Data is stale");
  assert.equal($("lm-message-count").textContent, "8");
  assert.equal(clearCount + reconnectCount, 0, "Pausing must not call any connection or data mutation");
  await $("lm-pause").dispatch("click");
  assert.equal($("lm-value").textContent, "0.8");
  assert.match($("lm-field-age").textContent, /Stale/);

  // Channel/field labels are escaped even when new senders introduce HTML-shaped names.
  field = { ...field, name: '<script>bad()</script> velocity' };
  snapshot = { ...snapshot, fields: [field] };
  monitor.render();
  assert.match($("lm-field").innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch($("lm-values").innerHTML, /<script>/);

  await $("lm-copy").dispatch("click");
  const exportData = JSON.parse(copied);
  assert.equal(exportData.url, "ws://example.test:8765/path", "Export omits credentials and query tokens");
  assert.equal(exportData.counts.messages, 8);
  await $("lm-reconnect").dispatch("click");
  await $("lm-clear").dispatch("click");
  assert.equal(reconnectCount, 1);
  assert.equal(clearCount, 1);

  field = { ...field, name: "data", kind: "array", reducer: "mean", value: null, count: 2, preview: [null, null] };
  snapshot = { ...snapshot, fields: [field], channels: [{ ...snapshot.channels[0], numeric: false }],
    counts: { ...snapshot.counts, noNumericFrames: 3 } };
  monitor.render();
  assert.match($("lm-field").innerHTML, />Data</);
  assert.equal($("lm-reduction").textContent, "Mean");
  assert.equal($("lm-no-numeric-count").textContent, "3");
  assert.match($("lm-channels").innerHTML, /No numbers/);

  await $("lm-pause").dispatch("click");
  monitor.reset();
  assert.equal($("lm-pause").attributes["aria-pressed"], "false");
  assert.equal($("lm-paused").hidden, true);
  console.log("Live monitor display tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
