"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const copy = (value) => JSON.parse(JSON.stringify(value));

// Recordings reuse a joint label for its position and velocity. Exercise the
// rendered picker and real UI handlers without audio, a browser, or paid calls.
const fields = ["position", "velocity"].flatMap((kind) => [1, 2].map((joint) => ({
  key: `robot_joint_states|${kind === "position" ? "data" : "velocity"}%3A${joint - 1}`,
  channelName: "Robot joint states", channelId: "robot_joint_states",
  fieldId: `${kind === "position" ? "data" : "velocity"}:${joint - 1}`,
  label: `joint_${joint}`, name: `joint_${joint} ${kind}`, kind,
  reducers: ["value"], default_reducer: "value"
})));
fields.push({ key: "activations|tensor%3Ahidden", channelName: "Activations", name: "hidden_layer",
  kind: "tensor", reducers: ["mean", "rms", "minimum", "maximum", "index"], default_reducer: "mean" });

const elements = new Map(), handlers = {}, routes = [];
function element(id) {
  if (!elements.has(id)) elements.set(id, { value: "", textContent: "", innerHTML: "",
    classList: { toggle() {} } });
  return elements.get(id);
}
const root = {
  classList: { add() {} },
  querySelector: (selector) => element(selector.slice(4)),
  querySelectorAll: (selector) => selector === "[data-route]" ? routes : [],
  addEventListener: (type, callback) => { handlers[type] = callback; }
};
let config, onUpdate;
const context = vm.createContext({
  performance: { now: () => 0 },
  localStorage: {
    getItem: () => JSON.stringify({ config: { mode: "shared", buses: [{ id: "mix-a", name: "Mix A", operator: "average",
      sources: [{ sourceKey: fields[0].key, reducer: "value", rangeMode: "auto" }] }], channels: [] } }),
    setItem() {}
  },
  HydraMusicMixerGeneration: { create: () => ({ update() {} }) },
  HydraMusicMixerEngine: {
    validateConfig: copy,
    create(options) {
      onUpdate = options.onUpdate;
      return { setConfig: (value) => { config = copy(value); }, getConfig: () => copy(config) };
    }
  },
  fetch: () => { throw new Error("Input edits must not send generation requests"); }
});
for (const file of ["elevenlabs-realtime.js", "music-mixer.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../dashboard", file), "utf8"), context, { filename: file });
}
context.HydraMusicMixer.init({ container: root });
onUpdate({ fields, buses: [], channels: [] });

const labels = [...element("buses").innerHTML.matchAll(/<option value="robot_joint_states[^>]+>(.*?)<\/option>/g)].map((match) => match[1]);
assert.deepEqual(labels, ["Joint 1 · Position", "Joint 2 · Position", "Joint 1 · Velocity", "Joint 2 · Velocity"]);
assert.match(element("buses").innerHTML, /<optgroup label="Robot joint states">/);
assert.match(element("buses").innerHTML, /<optgroup label="Activations">/);
assert.match(element("buses").innerHTML, /Robot joint states · Direct value/);
assert.match(element("buses").innerHTML, />Single input<\/p>/);
assert.match(element("buses").innerHTML, /data-operator disabled/);
assert.doesNotMatch(element("buses").innerHTML, /combined signal history/);

const routeCaption = element("route-caption");
routes.push({ querySelector: (selector) => selector === "[data-route-source]" ? routeCaption : { value: "mix-a" } });
function busControl(dataset, value, attributes = []) {
  return { dataset, value,
    hasAttribute: (name) => attributes.includes(name),
    closest(selector) {
      if (selector === "button") return this;
      if (selector === "[data-bus]") return { dataset: { bus: "mix-a" } };
      if (selector === "[data-source]") return { dataset: { source: "0" } };
      return null;
    }
  };
}
handlers.click({ target: busControl({ action: "add-source" }) });
assert.equal(config.buses[0].sources.length, 2);
assert.match(element("buses").innerHTML, />2 inputs · Average<\/p>/);
assert.doesNotMatch(element("buses").innerHTML, /data-operator disabled/);
assert.equal(routeCaption.textContent, "2 inputs · Average");

handlers.change({ target: busControl({}, "difference", ["data-operator"]) });
assert.match(element("buses").innerHTML, />2 inputs · Difference<\/p>/);
assert.equal(routeCaption.textContent, "2 inputs · Difference");
handlers.click({ target: busControl({ action: "remove-source" }) });
assert.match(element("buses").innerHTML, />Single input<\/p>/);
assert.equal(routeCaption.textContent, "Joint 2 · Position");

handlers.change({ target: busControl({ sourceField: "sourceKey" }, fields[2].key) });
assert.equal(config.buses[0].sources[0].sourceKey, fields[2].key, "visible names must preserve the exact velocity source key");
assert.equal(routeCaption.textContent, "Joint 1 · Velocity");
handlers.change({ target: busControl({ sourceField: "sourceKey" }, fields[4].key) });
assert.match(element("buses").innerHTML, /Activations · Average/);
assert.match(element("buses").innerHTML, /value="mean" selected>Average<\/option>/);
handlers.change({ target: busControl({ sourceField: "reducer" }, "rms") });
assert.equal(config.buses[0].sources[0].reducer, "rms", "friendly read modes must keep the reducer API value");
assert.match(element("buses").innerHTML, /Activations · RMS magnitude/);

// Live descriptors omit label, but must render the same joint/type names.
onUpdate({ fields: fields.slice(0, 4).map(({ label, ...field }) => field), buses: [], channels: [] });
assert.match(element("buses").innerHTML, />Joint 1 · Velocity<\/option>/);

console.log("Music mixer UI: distinct position/velocity inputs, channels, read modes, and combined signals passed.");
