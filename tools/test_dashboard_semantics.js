"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(
  path.join(projectRoot, "dashboard", "app.js"),
  "utf8"
);
const context = vm.createContext({
  console,
  document: { addEventListener() {} },
  window: {},
  Intl,
  URLSearchParams
});

vm.runInContext(
  `${source}
globalThis.__dashboardTests = {
  semanticParameterValue,
  parameterSurfaceSignature,
  state
};`,
  context,
  { filename: "dashboard/app.js" }
);

const {
  semanticParameterValue,
  parameterSurfaceSignature,
  state
} = context.__dashboardTests;

const parameter = (overrides = {}) => ({
  key: "nrpn:1:100:test",
  rawKey: "",
  kind: "nrpn",
  number: 100,
  name: "Test",
  short: "TEST",
  group: "Test",
  aliases: [],
  observed: true,
  channel: 1,
  value: 0,
  max: 127,
  normalized: 0,
  source: "user",
  age: 0,
  resolutionBits: 7,
  catalog: true,
  catalogId: "test",
  valueKind: "range",
  valueDefinition: { kind: "range", raw_min: 0, raw_max: 127 },
  rawValue: null,
  decodedValue: null,
  displayValue: null,
  displayLabel: "",
  displayUnmapped: false,
  contextDependent: false,
  dependency: "",
  decodeStatus: "decoded",
  encoding: {},
  rangeAuthoritative: true,
  catalogAmbiguous: false,
  catalogMatchCount: 0,
  ambiguityLabel: "",
  changedAt: 0,
  takeoverRemaining: 0,
  ...overrides
});

assert.equal(
  semanticParameterValue(parameter({
    value: 1,
    valueKind: "enum",
    valueDefinition: {
      kind: "enum",
      items: [{ value: 0, label: "Off" }, { value: 1, label: "On" }]
    }
  })).text,
  "On"
);

state.catalog.rhythmLists = {
  lfo_rate: {
    items: [{ value: 0, label: "1/64T" }, { value: 1, label: "1/64" }]
  }
};
assert.equal(
  semanticParameterValue(parameter({
    value: 1,
    valueKind: "enum_reference",
    valueDefinition: { kind: "enum_reference", enum: "lfo_rate" }
  })).text,
  "1/64"
);

assert.equal(
  semanticParameterValue(parameter({
    value: 4096,
    max: 8192,
    normalized: 0.5,
    valueKind: "bipolar",
    valueDefinition: {
      kind: "bipolar",
      raw_min: 0,
      raw_center: 4096,
      raw_max: 8192,
      display_min: -128,
      display_center: 0,
      display_max: 128
    }
  })).text,
  "0"
);

assert.equal(
  semanticParameterValue(parameter({
    value: 8191,
    max: 8192,
    valueKind: "signed_wrap",
    valueDefinition: {
      kind: "signed_wrap",
      pivot: 4096,
      subtract_above_pivot: 8192
    }
  })).text,
  "-1"
);

assert.equal(
  semanticParameterValue(parameter({
    value: 70,
    rawValue: 198,
    valueKind: "selected_byte",
    valueDefinition: {
      kind: "selected_byte",
      items: [{ value: 70, label: "Choice" }]
    },
    encoding: { kind: "selected_byte", selector: 1, payload: 70 }
  })).text,
  "Choice · payload 70"
);

assert.equal(
  semanticParameterValue(parameter({
    value: 133,
    max: 383,
    valueKind: "packed_index",
    valueDefinition: {
      kind: "packed_index",
      segments: [{ prefix: 4, offset: 128 }]
    },
    encoding: { kind: "packed_index", prefix: 4, payload: 5 }
  })).text,
  "Index 133 · p4/b5"
);

assert.match(
  semanticParameterValue(parameter({
    value: 32,
    valueKind: "curve",
    valueDefinition: {
      kind: "curve",
      anchors: [
        { raw: 0, display: -64, label: "Log" },
        { raw: 64, display: 0, label: "Lin" }
      ]
    }
  })).text,
  /-32 · interpolated/
);

assert.match(
  semanticParameterValue(parameter({
    valueKind: "context_dependent",
    valueDefinition: {
      kind: "context_dependent",
      dependency: "PRE-FX type"
    }
  })).text,
  /needs PRE-FX type/
);

assert.match(
  semanticParameterValue(parameter({
    catalogAmbiguous: true,
    catalogMatchCount: 2
  })).text,
  /unresolved address/
);

const structural = parameter();
state.filter = "all";
state.query = "";
const before = parameterSurfaceSignature([structural]);
structural.value = 99;
structural.normalized = 0.75;
structural.source = "agent";
structural.age = 2;
assert.equal(
  parameterSurfaceSignature([structural]),
  before,
  "dynamic telemetry must not force a structural rerender"
);
structural.name = "Renamed";
assert.notEqual(
  parameterSurfaceSignature([structural]),
  before,
  "structural metadata must rebuild the card surface"
);

console.log("dashboard semantic tests: ok");
