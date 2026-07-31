"use strict";

const POLL_INTERVAL_MS = 250;
const HISTORY_LIMIT = 30;
const MAX_TIMELINE_EVENTS = 12;
const CHANGED_WINDOW_SECONDS = 8;
const CATALOG_DISPLAY_LIMIT = 160;
const CATALOG_SEARCH_LIMIT = 240;
const NRPN_TRANSPORT_CCS = new Set([6, 38, 96, 97, 98, 99]);

const GROUP_ORDER = [
  "Oscillators",
  "Mixer",
  "Filters",
  "Envelopes",
  "Effects",
  "Macros",
  "NRPN",
  "Other MIDI"
];

const CC_DEFINITIONS = new Map([
  [44, { name: "Oscillator 1 Level", short: "OSC 1 LEVEL", group: "Oscillators" }],
  [46, { name: "Oscillator 2 Level", short: "OSC 2 LEVEL", group: "Oscillators" }],
  [48, { name: "Oscillator 3 Level", short: "OSC 3 LEVEL", group: "Oscillators" }],
  [3, { name: "Noise Level", short: "NOISE", group: "Mixer" }],
  [9, { name: "Ring Mod Level", short: "RING MOD", group: "Mixer" }],
  [74, { name: "Filter 1 Cutoff", short: "FILTER 1 CUTOFF", group: "Filters", aliases: ["cutoff"] }],
  [71, { name: "Filter 1 Resonance", short: "FILTER 1 RES", group: "Filters", aliases: ["resonance"] }],
  [50, { name: "Filter 1 Drive", short: "FILTER 1 DRIVE", group: "Filters" }],
  [55, { name: "Filter 2 Cutoff", short: "FILTER 2 CUTOFF", group: "Filters" }],
  [56, { name: "Filter 2 Resonance", short: "FILTER 2 RES", group: "Filters" }],
  [81, { name: "Envelope Attack", short: "ENV ATTACK", group: "Envelopes" }],
  [82, { name: "Envelope Decay", short: "ENV DECAY", group: "Envelopes" }],
  [83, { name: "Envelope Sustain", short: "ENV SUSTAIN", group: "Envelopes" }],
  [84, { name: "Envelope Release", short: "ENV RELEASE", group: "Envelopes" }],
  [14, { name: "Delay Feedback", short: "DELAY FDBK", group: "Effects" }],
  [15, { name: "Delay Time", short: "DELAY TIME", group: "Effects" }],
  [92, { name: "Delay Mix", short: "DELAY MIX", group: "Effects" }],
  [65, { name: "Reverb Time", short: "REVERB TIME", group: "Effects" }],
  [67, { name: "Reverb Tone", short: "REVERB TONE", group: "Effects" }],
  [93, { name: "Reverb Mix", short: "REVERB MIX", group: "Effects" }],
  [16, { name: "Macro 1", short: "MACRO 1", group: "Macros" }],
  [17, { name: "Macro 2", short: "MACRO 2", group: "Macros" }],
  [18, { name: "Macro 3", short: "MACRO 3", group: "Macros" }],
  [19, { name: "Macro 4", short: "MACRO 4", group: "Macros" }],
  [20, { name: "Macro 5", short: "MACRO 5", group: "Macros" }],
  [21, { name: "Macro 6", short: "MACRO 6", group: "Macros" }],
  [22, { name: "Macro 7", short: "MACRO 7", group: "Macros" }],
  [23, { name: "Macro 8", short: "MACRO 8", group: "Macros" }]
]);

const state = {
  snapshot: null,
  parameters: new Map(),
  histories: new Map(),
  previousValues: new Map(),
  changedAt: new Map(),
  events: [],
  seenEvents: new Set(),
  filter: "all",
  query: "",
  lastSuccessAt: 0,
  firstSnapshotReceived: false,
  requestInFlight: false,
  pitchBend: null,
  eventSequence: null,
  eventGap: false,
  eventAnnouncementCounter: 0,
  parameterRenderSignature: "",
  eventRenderSignature: "",
  catalog: {
    loaded: false,
    entries: [],
    byId: new Map(),
    byCc: new Map(),
    byNrpn: new Map(),
    rhythmLists: {},
    count: 0,
    visibleCount: 0,
    error: null
  }
};

const dom = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheDom();
  buildKeyboard();
  bindInterface();
  applyInitialView();
  updateClock();
  window.setInterval(updateClock, 1000);
  loadCatalog();
  pollSnapshot();
  window.setInterval(pollSnapshot, POLL_INTERVAL_MS);
  window.setInterval(updateRelativeTimes, 500);
});

function cacheDom() {
  [
    "connection-label", "connection-detail", "connection-light",
    "error-banner", "error-title", "error-message", "mode-badge",
    "patch-bank", "patch-number", "device-name", "midi-route",
    "stream-orbit", "stat-sequence", "stat-queue", "stat-jobs",
    "stat-dropped", "health-fill", "health-caption", "active-note-count",
    "midi-channel", "keyboard", "note-readout", "expression-readout",
    "parameter-summary", "snapshot-age", "live-pulse", "parameter-search",
    "parameter-filter-form",
    "parameter-loading", "parameter-empty", "parameter-groups",
    "event-count", "event-timeline", "event-announcer",
    "takeover-status", "takeover-copy",
    "footer-clock"
  ].forEach((id) => {
    dom[id] = document.getElementById(id);
  });
  dom.filterButtons = Array.from(document.querySelectorAll(".filter-chip"));
}

function bindInterface() {
  dom["parameter-filter-form"].addEventListener("submit", (event) => {
    event.preventDefault();
  });

  dom["parameter-search"].addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    refreshParameterSurface();
    renderParameters();
  });

  dom.filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter || "all";
      dom.filterButtons.forEach((candidate) => {
        const selected = candidate === button;
        candidate.classList.toggle("is-active", selected);
        candidate.setAttribute("aria-pressed", String(selected));
      });
      refreshParameterSurface();
      renderParameters();
    });
  });

  document.addEventListener("keydown", (event) => {
    if (
      event.key === "/" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !isEditableTarget(event.target)
    ) {
      event.preventDefault();
      dom["parameter-search"].focus();
    }
    if (event.key === "Escape" && document.activeElement === dom["parameter-search"]) {
      dom["parameter-search"].value = "";
      state.query = "";
      refreshParameterSurface();
      renderParameters();
      dom["parameter-search"].blur();
    }
  });
}

function applyInitialView() {
  const parameters = new URLSearchParams(window.location.search);
  const requestedFilter = firstString(parameters.get("view")).toLowerCase();
  const allowedFilters = new Set([
    "all", "changed", "user", "agent", "takeover", "catalog"
  ]);
  if (allowedFilters.has(requestedFilter)) {
    state.filter = requestedFilter;
    dom.filterButtons.forEach((button) => {
      const selected = button.dataset.filter === requestedFilter;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }
  const requestedQuery = firstString(parameters.get("q"));
  if (requestedQuery) {
    dom["parameter-search"].value = requestedQuery;
    state.query = requestedQuery.toLowerCase();
  }
}

function refreshParameterSurface() {
  if (state.snapshot) ingestSnapshot(state.snapshot);
}

async function loadCatalog() {
  try {
    const response = await fetch("/api/catalog", {
      method: "GET",
      cache: "no-cache",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Catalog request returned ${response.status}`);
    const catalog = await response.json();
    const entries = [];
    arrayOrEmpty(catalog.cc_parameters).forEach((entry) => {
      const normalized = normalizeCatalogEntry(entry, "cc");
      if (normalized) entries.push(normalized);
    });
    arrayOrEmpty(catalog.nrpn_parameters).forEach((entry) => {
      const normalized = normalizeCatalogEntry(entry, "nrpn");
      if (normalized) entries.push(normalized);
    });
    const byId = new Map();
    const byCc = new Map();
    const byNrpn = new Map();
    entries.forEach((entry) => {
      byId.set(entry.id, entry);
      const index = entry.kind === "cc" ? byCc : byNrpn;
      if (!index.has(entry.number)) index.set(entry.number, []);
      index.get(entry.number).push(entry);
    });
    state.catalog = {
      loaded: true,
      entries,
      byId,
      byCc,
      byNrpn,
      rhythmLists: objectOrEmpty(catalog.rhythm_lists),
      count: entries.length,
      visibleCount: 0,
      error: null
    };
    refreshParameterSurface();
    renderParameters();
  } catch (error) {
    state.catalog.error = error instanceof Error ? error.message : "Catalog unavailable";
  }
}

function normalizeCatalogEntry(entry, kind) {
  if (!entry || typeof entry !== "object") return null;
  const number = kind === "cc"
    ? boundedInteger(entry.number, 0, 127)
    : boundedInteger(objectOrEmpty(entry.address).number, 0, 16383);
  const name = stringValue(entry.name);
  if (number === null || !name) return null;
  const value = objectOrEmpty(entry.value);
  return {
    id: firstString(entry.id, `${kind}-${number}-${slug(name)}`),
    kind,
    number,
    name,
    short: name.toUpperCase(),
    group: firstString(entry.group, kind === "cc" ? "Other MIDI" : "NRPN"),
    aliases: arrayOrEmpty(entry.aliases).map(stringValue).filter(Boolean),
    valueKind: firstString(value.kind, "continuous"),
    valueDefinition: { ...value },
    selectorValues: arrayOrEmpty(value.selector_values)
      .map((selector) => boundedInteger(selector, 0, 127))
      .filter((selector) => selector !== null),
    resolutionBits: boundedInteger(value.resolution_bits, 1, 14) ||
      (kind === "cc" ? 7 : 14),
    max: finiteNumber(value.raw_max) || (kind === "cc" ? 127 : 16383)
  };
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

async function pollSnapshot() {
  if (state.requestInFlight) return;
  state.requestInFlight = true;

  try {
    const response = await fetch("/api/snapshot", {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`Snapshot request returned ${response.status}`);
    }
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Snapshot response was not an object");
    }

    state.snapshot = payload;
    state.lastSuccessAt = Date.now();
    state.firstSnapshotReceived = true;
    ingestSnapshot(payload);
    render(payload);
    setError(null);
  } catch (error) {
    setError(error instanceof Error ? error.message : "Unable to read the snapshot");
    renderConnection(state.snapshot || {});
    updateSnapshotAge();
  } finally {
    state.requestInFlight = false;
  }
}

function ingestSnapshot(snapshot) {
  const serverState = objectOrEmpty(snapshot.state);
  const status = objectOrEmpty(snapshot.status);
  const ccItems = arrayOrEmpty(serverState.cc);
  const nrpnItems = arrayOrEmpty(serverState.nrpn);
  const suppliedParameters = arrayOrEmpty(snapshot.parameters);
  const definitions = capabilityCcDefinitions(snapshot);
  const defaultChannel =
    boundedInteger(status.channel, 1, 16) ||
    firstObservedChannel(suppliedParameters, ccItems, nrpnItems) ||
    1;
  const now = Date.now();
  const nextParameters = new Map();

  definitions.forEach((definition, number) => {
    const key = parameterKey("cc", defaultChannel, number);
    nextParameters.set(key, makeParameter({
      key,
      kind: "cc",
      number,
      definition,
      observed: false,
      channel: defaultChannel
    }));
  });

  const parameterItems = suppliedParameters.length
    ? suppliedParameters
    : [
        ...ccItems.map((item) => ({ ...objectOrEmpty(item), kind: "cc" })),
        ...nrpnItems.map((item) => ({ ...objectOrEmpty(item), kind: "nrpn" }))
      ];

  seedCatalogParameters(nextParameters, defaultChannel);

  parameterItems.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const kind = parameterKind(item);
    if (kind !== "cc" && kind !== "nrpn") return;
    const maximumNumber = kind === "cc" ? 127 : 16383;
    const number = boundedInteger(
      kind === "cc"
        ? (item.number ?? item.cc)
        : (item.parameter ?? item.number),
      0,
      maximumNumber
    );
    if (number === null) return;
    if (kind === "cc" && NRPN_TRANSPORT_CCS.has(number)) return;
    const channel = boundedInteger(item.channel, 1, 16) || defaultChannel;
    const baseKey = parameterKey(kind, channel, number);
    const rawKey = stringValue(item.key);
    const knownDefinition = kind === "cc" ? definitions.get(number) : null;
    const addressCatalogEntries = catalogEntriesFor(kind, number);
    const catalogMatch = catalogMatchForItem(item, rawKey, addressCatalogEntries);
    const catalogEntries = catalogMatch.entry
      ? [catalogMatch.entry]
      : addressCatalogEntries;
    const catalogDefinition = catalogMatch.entry ||
      (catalogMatch.ambiguous ? null : catalogEntries[0]) ||
      null;
    const key = kind === "nrpn" && catalogMatch.entry
      ? `${baseKey}:${catalogMatch.entry.id}`
      : rawKey.startsWith(`${baseKey}:`)
        ? rawKey
        : baseKey;
    if (kind === "nrpn") {
      if (catalogMatch.entry) {
        nextParameters.delete(`catalog:${catalogMatch.entry.id}`);
      } else if (!catalogMatch.ambiguous && catalogEntries.length === 1) {
        nextParameters.delete(`catalog:${catalogEntries[0].id}`);
      }
    }
    const suppliedName = firstString(item.name, item.label);
    const definition = knownDefinition || (
      catalogMatch.ambiguous
        ? {
            name: `${kind.toUpperCase()} ${number}`,
            short: `${kind.toUpperCase()} ${number}`,
            group: commonCatalogGroup(catalogEntries) || "NRPN",
            aliases: [
              ...arrayOrEmpty(item.aliases).map(stringValue).filter(Boolean),
              ...catalogEntries.map((entry) => entry.name)
            ]
          }
        : {
            name: suppliedName || catalogDefinition?.name || `${kind.toUpperCase()} ${number}`,
            short: suppliedName
              ? suppliedName.toUpperCase()
              : catalogDefinition?.short ||
                `${kind.toUpperCase()} ${String(number).padStart(kind === "cc" ? 3 : 1, "0")}`,
            group: firstString(
              item.group,
              catalogDefinition?.group,
              kind === "nrpn" ? "NRPN" : "Other MIDI"
            ),
            aliases: [
              ...arrayOrEmpty(item.aliases).map(stringValue).filter(Boolean),
              ...catalogEntries.map((entry) => entry.name)
            ]
          }
    );
    const semanticDefinition = catalogDefinition
      ? {
          ...definition,
          valueKind: catalogDefinition.valueKind,
          valueDefinition: catalogDefinition.valueDefinition
        }
      : definition;
    const bits = kind === "nrpn"
      ? (boundedInteger(item.resolution_bits ?? item.resolutionBits, 1, 14) || 14)
      : 7;
    const parameter = makeParameter({
      key,
      rawKey,
      kind,
      number,
      definition: semanticDefinition,
      observed: true,
      channel,
      value: finiteNumber(item.value),
      source: normalizeSource(item.source),
      age: nonNegativeNumber(item.age),
      resolutionBits: bits,
      max: finiteNumber(item.max),
      normalized: finiteNumber(item.normalized),
      catalog: catalogEntries.length > 0,
      catalogId: catalogDefinition?.id || "",
      catalogAmbiguous: catalogMatch.ambiguous,
      catalogMatchCount: catalogMatch.ambiguous ? catalogEntries.length : 0,
      ambiguityLabel: catalogMatch.ambiguous
        ? catalogAmbiguityLabel(catalogEntries)
        : "",
      valueKind: firstString(item.value_kind, item.valueKind),
      rawValue: finiteNumber(item.raw_value ?? item.rawValue),
      decodedValue: finiteNumber(item.decoded_value ?? item.decodedValue),
      displayValue: displayScalar(item.display_value ?? item.displayValue),
      displayLabel: firstString(item.display_label, item.displayLabel),
      displayUnmapped: booleanValue(item.display_unmapped ?? item.displayUnmapped),
      contextDependent: booleanValue(item.context_dependent ?? item.contextDependent),
      dependency: firstString(item.dependency),
      decodeStatus: firstString(item.decode_status, item.decodeStatus),
      encoding: objectOrEmpty(item.encoding),
      rangeAuthoritative: booleanValue(
        item.range_authoritative ?? item.rangeAuthoritative
      ),
      takeoverRemaining: nonNegativeNumber(
        item.takeover_remaining ?? item.takeoverRemaining
      )
    });
    nextParameters.set(key, parameter);
  });

  nextParameters.forEach((parameter, key) => {
    const previous = state.previousValues.get(key);
    if (parameter.observed && parameter.value !== null) {
      if (previous !== undefined && previous !== parameter.value) {
        state.changedAt.set(key, now);
      } else if (!state.changedAt.has(key) && parameter.age !== null) {
        state.changedAt.set(key, now - parameter.age * 1000);
      }
      state.previousValues.set(key, parameter.value);
      appendHistory(key, parameter.normalized);
    } else if (!state.histories.has(key)) {
      state.histories.set(key, []);
    }
    parameter.changedAt = state.changedAt.get(key) || 0;
    parameter.takeoverRemaining = parameter.takeoverRemaining ??
      takeoverRemaining(parameter, serverState);
  });

  state.parameters = nextParameters;
  ingestEvents(arrayOrEmpty(snapshot.events));
  const bridgeGap = booleanValue(objectOrEmpty(snapshot.bridge).sequence_gap);
  if (bridgeGap !== null) state.eventGap = bridgeGap;
}

function capabilityCcDefinitions(snapshot) {
  const definitions = new Map();
  CC_DEFINITIONS.forEach((definition, number) => {
    definitions.set(number, {
      ...definition,
      aliases: [...(definition.aliases || [])]
    });
  });

  const capabilities = objectOrEmpty(snapshot.capabilities);
  arrayOrEmpty(capabilities.timbre_controls).forEach((control) => {
    if (!control || typeof control !== "object") return;
    const number = boundedInteger(control.cc ?? control.number, 0, 127);
    const rawName = firstString(control.name, control.label);
    if (number === null || !rawName) return;
    const existing = definitions.get(number);
    if (existing) {
      const aliases = new Set([
        ...(existing.aliases || []),
        rawName,
        slug(rawName)
      ]);
      definitions.set(number, { ...existing, aliases: Array.from(aliases) });
      return;
    }
    definitions.set(number, {
      name: formatControlName(rawName),
      short: rawName.replace(/[-_]+/g, " ").toUpperCase(),
      group: groupForControlName(rawName),
      aliases: [rawName]
    });
  });
  return definitions;
}

function formatControlName(name) {
  return String(name)
    .replace(/[-_]+/g, " ")
    .replace(/\bosc(\d*)\b/gi, (_, number) => `Oscillator${number ? ` ${number}` : ""}`)
    .replace(/\benv\b/gi, "Envelope")
    .replace(/\bfilter(\d+)\b/gi, "Filter $1")
    .replace(/\bmacro(\d+)\b/gi, "Macro $1")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function groupForControlName(name) {
  const normalized = String(name).toLowerCase();
  if (normalized.includes("osc")) return "Oscillators";
  if (normalized.includes("noise") || normalized.includes("ring")) return "Mixer";
  if (normalized.includes("filter") || normalized === "cutoff" || normalized === "resonance") {
    return "Filters";
  }
  if (normalized.includes("env")) return "Envelopes";
  if (normalized.includes("delay") || normalized.includes("reverb") || normalized.includes("fx")) {
    return "Effects";
  }
  if (normalized.includes("macro")) return "Macros";
  return "Other MIDI";
}

function firstObservedChannel(...collections) {
  for (const collection of collections) {
    for (const item of arrayOrEmpty(collection)) {
      const channel = boundedInteger(item?.channel, 1, 16);
      if (channel !== null) return channel;
    }
  }
  return null;
}

function parameterKind(item) {
  const kind = stringValue(item.kind).toLowerCase();
  const key = stringValue(item.key).toLowerCase();
  if (kind.includes("nrpn") || key.startsWith("nrpn:")) return "nrpn";
  if (kind.includes("cc") || key.startsWith("cc:")) return "cc";
  return item.parameter !== undefined ? "nrpn" : "cc";
}

function parameterKey(kind, channel, number) {
  return `${kind}:${channel}:${number}`;
}

function catalogEntriesFor(kind, number) {
  const index = kind === "cc" ? state.catalog.byCc : state.catalog.byNrpn;
  return index instanceof Map ? (index.get(number) || []) : [];
}

function catalogMatchForItem(item, rawKey, entries) {
  const explicitAmbiguous =
    booleanValue(item.catalog_ambiguous ?? item.catalogAmbiguous) === true;
  const declaredIds = Array.from(new Set([
    firstString(item.catalog_id, item.catalogId),
    ...arrayOrEmpty(item.catalog_ids ?? item.catalogIds)
      .map(stringValue)
      .filter(Boolean)
  ].filter(Boolean)));
  let exactId = declaredIds.length === 1 ? declaredIds[0] : "";

  if (!exactId && rawKey) {
    const rawMatch = entries.find((entry) =>
      rawKey === entry.id ||
      rawKey === `catalog:${entry.id}` ||
      rawKey.endsWith(`:${entry.id}`)
    );
    exactId = rawMatch?.id || "";
  }

  const entry = !explicitAmbiguous && exactId
    ? (state.catalog.byId.get(exactId) || entries.find((candidate) => candidate.id === exactId))
    : null;
  return {
    entry: entry || null,
    ambiguous: explicitAmbiguous || declaredIds.length > 1 || (!entry && entries.length > 1)
  };
}

function commonCatalogGroup(entries) {
  const groups = new Set(entries.map((entry) => entry.group).filter(Boolean));
  return groups.size === 1 ? Array.from(groups)[0] : "";
}

function catalogAmbiguityLabel(entries) {
  const kinds = new Set(entries.map((entry) => entry.valueKind));
  if (kinds.has("packed_index")) return "Packed identity unresolved";
  if (kinds.has("selected_byte")) return "Selector unresolved";
  return "Shared address unresolved";
}

function seedCatalogParameters(nextParameters, defaultChannel) {
  const includeCatalog = state.filter === "catalog";
  if (!state.catalog.loaded || (!includeCatalog && !state.query)) {
    state.catalog.visibleCount = 0;
    return;
  }
  const matches = state.catalog.entries.filter((entry) => {
    if (!state.query) return true;
    const text = [
      entry.id,
      entry.name,
      entry.group,
      entry.kind,
      entry.number,
      ...entry.aliases
    ].join(" ").toLowerCase();
    return text.includes(state.query);
  });
  const limit = state.query ? CATALOG_SEARCH_LIMIT : CATALOG_DISPLAY_LIMIT;
  const selected = matches.slice(0, limit);
  state.catalog.visibleCount = selected.length;
  selected.forEach((entry) => {
    const key = entry.kind === "cc"
      ? parameterKey("cc", defaultChannel, entry.number)
      : `catalog:${entry.id}`;
    const existing = nextParameters.get(key);
    if (existing) {
      existing.catalog = true;
      existing.catalogId = entry.id;
      return;
    }
    nextParameters.set(key, makeParameter({
      key,
      rawKey: entry.id,
      kind: entry.kind,
      number: entry.number,
      definition: entry,
      observed: false,
      channel: defaultChannel,
      resolutionBits: entry.resolutionBits,
      max: entry.max,
      catalog: true,
      catalogId: entry.id
    }));
  });
}

function makeParameter(options) {
  const naturalMax = options.kind === "nrpn"
    ? Math.pow(2, options.resolutionBits || 14) - 1
    : 127;
  const max = options.max !== null && options.max > 0
    ? options.max
    : naturalMax;
  const value = options.value === undefined ? null : options.value;
  const suppliedNormalized = options.normalized;
  const normalized = suppliedNormalized !== null && suppliedNormalized !== undefined
    ? clamp(suppliedNormalized, 0, 1)
    : value === null ? 0 : clamp(value / max, 0, 1);
  return {
    key: options.key,
    rawKey: options.rawKey || "",
    kind: options.kind,
    number: options.number,
    name: options.definition.name,
    short: options.definition.short,
    group: options.definition.group,
    aliases: options.definition.aliases || [],
    observed: options.observed,
    channel: options.channel ?? null,
    value,
    max,
    normalized,
    source: options.source || "unknown",
    age: options.age ?? null,
    resolutionBits: options.resolutionBits || 7,
    catalog: Boolean(options.catalog),
    catalogId: options.catalogId || "",
    valueKind: options.valueKind || options.definition.valueKind || "",
    valueDefinition: options.definition.valueDefinition || null,
    rawValue: options.rawValue ?? null,
    decodedValue: options.decodedValue ?? null,
    displayValue: options.displayValue ?? null,
    displayLabel: options.displayLabel || "",
    displayUnmapped: options.displayUnmapped === true,
    contextDependent: options.contextDependent === true,
    dependency: options.dependency || "",
    decodeStatus: options.decodeStatus || "",
    encoding: options.encoding || {},
    rangeAuthoritative: options.rangeAuthoritative,
    catalogAmbiguous: Boolean(options.catalogAmbiguous),
    catalogMatchCount: options.catalogMatchCount || 0,
    ambiguityLabel: options.ambiguityLabel || "",
    changedAt: 0,
    takeoverRemaining: options.takeoverRemaining ?? null
  };
}

function appendHistory(key, value) {
  const history = state.histories.get(key) || [];
  const last = history[history.length - 1];
  if (!last || last.value !== value || Date.now() - last.time >= 1000) {
    history.push({ value, time: Date.now() });
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
    state.histories.set(key, history);
  }
}

function takeoverRemaining(parameter, serverState) {
  if (parameter.source !== "user" || parameter.age === null) return 0;
  const duration = nonNegativeNumber(
    serverState.takeover_seconds ?? objectOrEmpty(state.snapshot?.status).takeover_seconds
  );
  if (!duration) return 0;
  return Math.max(0, duration - parameter.age);
}

function ingestEvents(events) {
  const addedEvents = [];
  events.forEach((event, index) => {
    if (!event || typeof event !== "object") return;
    const key = eventIdentity(event, index);
    if (state.seenEvents.has(key)) return;
    state.seenEvents.add(key);
    if (state.seenEvents.size > 600) {
      state.seenEvents = new Set(Array.from(state.seenEvents).slice(-350));
    }

    const sequence = finiteNumber(event.event_sequence ?? event.sequence);
    if (
      sequence !== null &&
      state.eventSequence !== null &&
      sequence > state.eventSequence + 1
    ) {
      state.eventGap = true;
    }
    if (sequence !== null) state.eventSequence = Math.max(state.eventSequence || 0, sequence);

    if (String(event.event || event.type).toLowerCase() === "pitch_bend") {
      let pitchBend = finiteNumber(event.normalized ?? event.value);
      if (pitchBend !== null && Math.abs(pitchBend) > 1) {
        pitchBend = (pitchBend - 8192) / 8192;
      }
      if (pitchBend !== null) {
        state.pitchBend = { value: pitchBend, receivedAt: Date.now() };
      }
    }

    const received = { ...event, _receivedAt: Date.now(), _identity: key };
    state.events.unshift(received);
    addedEvents.push(received);
  });
  if (state.events.length > 80) state.events.length = 80;
  if (addedEvents.length && dom["event-announcer"]) {
    const newest = state.events[0];
    const copy = eventDescription(newest);
    state.eventAnnouncementCounter += 1;
    setText(
      dom["event-announcer"],
      `Activity update ${state.eventAnnouncementCounter}: ${copy.title}. ${copy.detail}.`
    );
  }
}

function eventIdentity(event, index) {
  const sequence = event.event_sequence ?? event.sequence;
  if (sequence !== undefined && sequence !== null) return `seq:${sequence}`;
  return `event:${JSON.stringify(event)}`;
}

function render(snapshot) {
  renderConnection(snapshot);
  renderPatch(snapshot);
  renderTransport(snapshot);
  renderPerformance(snapshot);
  renderParameters();
  renderEvents();
  renderTakeover(snapshot);
  updateSnapshotAge();
}

function renderConnection(snapshot) {
  const status = objectOrEmpty(snapshot.status);
  const bridge = objectOrEmpty(snapshot.bridge);
  const connection = objectOrEmpty(snapshot.connection);
  const mode = firstString(bridge.mode, snapshot.mode).toLowerCase();
  const isDemo = mode === "demo";
  const bridgeContractPresent = Object.keys(bridge).length > 0;
  const serviceRunning = booleanValue(
    bridge.service_running ?? snapshot.ready
  );
  const outputSelected = booleanValue(
    bridge.connected ?? connection.connected ?? status.connected ??
    (typeof snapshot.connection === "boolean" ? snapshot.connection : undefined)
  );
  const inputSelected = booleanValue(
    bridge.input_connected ?? connection.input_connected ?? status.input_connected
  );
  const connected = bridgeContractPresent
    ? serviceRunning === true && outputSelected === true
    : outputSelected ?? serviceRunning ?? false;
  const stale = state.lastSuccessAt && Date.now() - state.lastSuccessAt > 1500;
  const hasError = Boolean(snapshot.error || bridge.error) ||
    (bridgeContractPresent && serviceRunning === false) ||
    (!state.firstSnapshotReceived && stale);

  dom["connection-light"].className = "connection-light";
  if (isDemo) {
    dom["connection-light"].classList.add("is-demo");
  } else if (hasError || (state.firstSnapshotReceived && !connected)) {
    dom["connection-light"].classList.add("is-error");
  } else if (connected) {
    dom["connection-light"].classList.add("is-live");
  } else {
    dom["connection-light"].classList.add("is-pending");
  }

  if (isDemo) {
    setText(dom["connection-label"], "Demo snapshot");
    setText(dom["connection-detail"], "Server-provided demonstration state");
  } else if (serviceRunning && outputSelected && inputSelected) {
    setText(dom["connection-label"], "MIDI endpoints selected");
    setText(dom["connection-detail"], connectionDetail(snapshot) || "Output and input monitoring available");
  } else if (serviceRunning && outputSelected) {
    setText(dom["connection-label"], "Output endpoint selected");
    setText(dom["connection-detail"], connectionDetail(snapshot) || "Input monitoring is unavailable");
  } else if (serviceRunning) {
    setText(dom["connection-label"], "MIDI service running");
    setText(dom["connection-detail"], "Waiting for a Hydrasynth endpoint");
  } else if (connected) {
    setText(dom["connection-label"], "MIDI endpoint selected");
    setText(dom["connection-detail"], connectionDetail(snapshot) || "Endpoint reported by the service");
  } else if (state.firstSnapshotReceived) {
    setText(dom["connection-label"], "MIDI service offline");
    setText(dom["connection-detail"], connectionDetail(snapshot) || "Waiting for the local bridge");
  } else {
    setText(dom["connection-label"], "Connecting");
    setText(dom["connection-detail"], "Waiting for the local MIDI service");
  }

  dom["mode-badge"].classList.toggle("is-demo", isDemo);
  setText(dom["mode-badge"], isDemo ? "Demo data" : "Live");
  dom["live-pulse"].classList.toggle("is-live", connected || isDemo);
}

function connectionDetail(snapshot) {
  const bridge = objectOrEmpty(snapshot.bridge);
  const connection = objectOrEmpty(snapshot.connection);
  const status = objectOrEmpty(snapshot.status);
  const destination = firstString(
    bridge.destination,
    connection.destination,
    connection.output,
    connection.device,
    status.destination,
    snapshot.device
  );
  const source = firstString(
    bridge.source,
    connection.source,
    connection.input,
    status.source
  );
  if (destination && source && destination !== source) return `${source} → ${destination}`;
  return destination || source || "";
}

function renderPatch(snapshot) {
  const serverState = objectOrEmpty(snapshot.state);
  const patch = objectOrEmpty(serverState.patch);
  const bridge = objectOrEmpty(snapshot.bridge);
  const connection = objectOrEmpty(snapshot.connection);
  const status = objectOrEmpty(snapshot.status);
  const bank = firstString(patch.bank, serverState.bank);
  const number = boundedInteger(patch.number ?? patch.program ?? serverState.program, 0, 9999);
  const device = firstString(
    bridge.destination,
    connection.device,
    connection.destination,
    status.destination,
    snapshot.device,
    "Hydrasynth"
  );
  const source = firstString(bridge.source, connection.source, status.source);
  const destination = firstString(
    bridge.destination,
    connection.destination,
    status.destination
  );

  setText(
    dom["patch-bank"],
    bank && bank !== "?" ? bank.slice(0, 2).toUpperCase() : "—"
  );
  setText(dom["patch-number"], number === null ? "---" : String(number).padStart(3, "0"));
  setText(dom["device-name"], device);
  setText(
    dom["midi-route"],
    source && destination && source !== destination
      ? `${source} → ${destination}`
      : source || destination || "MIDI route not reported"
  );
}

function renderTransport(snapshot) {
  const status = objectOrEmpty(snapshot.status);
  const bridge = objectOrEmpty(snapshot.bridge);
  const serverState = objectOrEmpty(snapshot.state);
  const sequence = finiteNumber(
    bridge.event_sequence ?? status.event_sequence ?? serverState.event_sequence
  );
  const queued = finiteNumber(status.queued_events ?? status.queue_depth ?? status.notification_queued);
  const jobs = finiteNumber(status.active_jobs ?? status.jobs);
  const notificationDropped = finiteNumber(status.notification_dropped) || 0;
  const incomingDropped = finiteNumber(status.incoming_dropped) || 0;
  const parseErrors = finiteNumber(bridge.parse_errors) || 0;
  const dropped = notificationDropped + incomingDropped;
  const eventWriter = booleanValue(status.event_writer);
  const scheduler = booleanValue(status.scheduler);
  const healthy = dropped === 0 &&
    parseErrors === 0 &&
    eventWriter !== false &&
    scheduler !== false &&
    !state.eventGap &&
    booleanValue(bridge.service_running) !== false;

  setText(dom["stat-sequence"], sequence === null ? "—" : compactNumber(sequence));
  setText(dom["stat-queue"], queued === null ? "—" : compactNumber(queued));
  setText(dom["stat-jobs"], jobs === null ? "—" : compactNumber(jobs));
  setText(dom["stat-dropped"], dropped ? compactNumber(dropped) : "0");
  dom["stat-dropped"].classList.toggle("has-alert", dropped > 0);

  const health = !state.firstSnapshotReceived ? 0 : healthy ? 100 : Math.max(18, 100 - dropped * 12);
  dom["health-fill"].style.width = `${health}%`;
  dom["health-fill"].classList.toggle("has-alert", !healthy);
  dom["stream-orbit"].classList.toggle(
    "is-idle",
    Boolean(snapshot.error || bridge.error)
  );

  if (state.eventGap) {
    setText(dom["health-caption"], "Sequence gap detected · state reconciled from latest snapshot");
  } else if (dropped > 0 || parseErrors > 0) {
    const issues = [];
    if (dropped > 0) issues.push(`${dropped} dropped message${dropped === 1 ? "" : "s"}`);
    if (parseErrors > 0) issues.push(`${parseErrors} parse error${parseErrors === 1 ? "" : "s"}`);
    setText(dom["health-caption"], `${issues.join(" · ")} reported`);
  } else if (state.firstSnapshotReceived && healthy) {
    setText(dom["health-caption"], "State and event transport nominal");
  } else {
    setText(dom["health-caption"], "Transport details not yet reported");
  }
}

function renderPerformance(snapshot) {
  const serverState = objectOrEmpty(snapshot.state);
  const status = objectOrEmpty(snapshot.status);
  const notes = arrayOrEmpty(serverState.active_notes)
    .map(normalizeNote)
    .filter(Boolean);
  const activeNumbers = new Set(notes.map((note) => note.note));

  dom.keyboard.querySelectorAll(".key").forEach((key) => {
    const note = Number(key.dataset.note);
    const active = activeNumbers.has(note);
    key.classList.toggle("is-active", active);
    key.setAttribute("aria-hidden", String(!active));
  });

  const noteNames = notes.map((note) => midiNoteName(note.note));
  setText(dom["active-note-count"], notes.reduce((sum, note) => sum + note.count, 0));
  setText(
    dom["note-readout"],
    noteNames.length ? noteNames.join(" · ") : "No notes held"
  );
  dom.keyboard.setAttribute(
    "aria-label",
    noteNames.length ? `Active notes: ${noteNames.join(", ")}` : "No active notes"
  );

  const channel = boundedInteger(
    status.channel ?? notes[0]?.channel ?? serverState.channel,
    1,
    16
  );
  setText(dom["midi-channel"], channel ?? "—");

  const sustain = findCcValue(serverState.cc, 64);
  const sustainCopy = sustain === null ? "Sustain —" : sustain >= 64 ? "Sustain on" : "Sustain off";
  const bendIsRecent = state.pitchBend &&
    Date.now() - state.pitchBend.receivedAt < 30000;
  const bendCopy = !bendIsRecent
    ? "Recent bend —"
    : `Recent bend ${signedPercent(state.pitchBend.value)}`;
  setText(dom["expression-readout"], `${sustainCopy} · ${bendCopy}`);
}

function normalizeNote(item) {
  if (typeof item === "number") {
    const note = boundedInteger(item, 0, 127);
    return note === null ? null : { note, channel: null, count: 1 };
  }
  if (!item || typeof item !== "object") return null;
  const note = boundedInteger(item.note ?? item.number, 0, 127);
  if (note === null) return null;
  return {
    note,
    channel: boundedInteger(item.channel, 1, 16),
    count: Math.max(1, boundedInteger(item.count, 1, 65535) || 1)
  };
}

function findCcValue(items, number) {
  const found = arrayOrEmpty(items).find((item) => Number(item?.number ?? item?.cc) === number);
  return found ? finiteNumber(found.value) : null;
}

function renderParameters() {
  if (!state.firstSnapshotReceived) {
    dom["parameter-loading"].hidden = false;
    dom["parameter-empty"].hidden = true;
    if (state.parameterRenderSignature !== "loading") {
      dom["parameter-groups"].replaceChildren();
      state.parameterRenderSignature = "loading";
    }
    return;
  }
  dom["parameter-loading"].hidden = true;

  const parameters = Array.from(state.parameters.values()).filter(matchesParameterView);
  const observed = Array.from(state.parameters.values()).filter((parameter) => parameter.observed);
  const changed = observed.filter(isRecentlyChanged);
  if (state.filter === "catalog") {
    setText(
      dom["parameter-summary"],
      state.query
        ? `${parameters.length} matching controls · ${state.catalog.count.toLocaleString()} catalogued`
        : `Showing ${parameters.length} of ${state.catalog.count.toLocaleString()} catalogued controls · search to narrow`
    );
  } else {
    const catalogCopy = state.catalog.loaded
      ? `${state.catalog.count.toLocaleString()} catalogued`
      : `${state.parameters.size} mapped`;
    setText(
      dom["parameter-summary"],
      `${observed.length} observed · ${changed.length} recently changed · ${catalogCopy}`
    );
  }

  if (!parameters.length) {
    dom["parameter-empty"].hidden = false;
    const emptySignature = `empty:${state.filter}:${state.query}`;
    if (state.parameterRenderSignature !== emptySignature) {
      dom["parameter-groups"].replaceChildren();
      state.parameterRenderSignature = emptySignature;
    }
    return;
  }
  dom["parameter-empty"].hidden = true;

  const signature = parameterSurfaceSignature(parameters);
  if (signature === state.parameterRenderSignature) {
    updateDynamicParameterCards(parameters);
    return;
  }

  const focusedCard = document.activeElement?.closest?.(".parameter-card");
  const focusedKey = focusedCard?.dataset.parameterKey || "";
  const groups = new Map();
  parameters.forEach((parameter) => {
    if (!groups.has(parameter.group)) groups.set(parameter.group, []);
    groups.get(parameter.group).push(parameter);
  });

  const fragment = document.createDocumentFragment();
  GROUP_ORDER.forEach((groupName, groupIndex) => {
    const groupParameters = groups.get(groupName);
    if (!groupParameters?.length) return;
    groupParameters.sort((a, b) => a.number - b.number);
    fragment.appendChild(renderParameterGroup(groupName, groupParameters, groupIndex));
  });
  Array.from(groups.keys())
    .filter((name) => !GROUP_ORDER.includes(name))
    .sort()
    .forEach((groupName, index) => {
      fragment.appendChild(
        renderParameterGroup(groupName, groups.get(groupName), GROUP_ORDER.length + index)
      );
    });
  dom["parameter-groups"].replaceChildren(fragment);
  state.parameterRenderSignature = signature;
  updateDynamicParameterCards(parameters);

  if (focusedKey) {
    const replacement = Array.from(
      dom["parameter-groups"].querySelectorAll(".parameter-card")
    ).find((card) => card.dataset.parameterKey === focusedKey);
    replacement?.focus({ preventScroll: true });
  }
}

function parameterSurfaceSignature(parameters) {
  const fingerprints = parameters.map((parameter) => {
    return [
      parameter.key,
      parameter.name,
      parameter.short,
      parameter.group,
      parameter.max,
      parameter.catalog,
      parameter.catalogId,
      parameter.catalogAmbiguous,
      parameter.catalogMatchCount,
      parameter.valueKind,
      parameter.resolutionBits
    ];
  });
  return JSON.stringify([state.filter, state.query, fingerprints]);
}

function updateDynamicParameterCards(parameters) {
  const parameterByKey = new Map(parameters.map((parameter) => [parameter.key, parameter]));
  dom["parameter-groups"].querySelectorAll(".parameter-card").forEach((card) => {
    const parameter = parameterByKey.get(card.dataset.parameterKey);
    if (!parameter) return;
    updateParameterCard(card, parameter);
  });
  dom["parameter-groups"].querySelectorAll(".parameter-group").forEach((group) => {
    const cards = Array.from(group.querySelectorAll(".parameter-card"));
    const activeCount = cards.reduce((count, card) => {
      return count + (parameterByKey.get(card.dataset.parameterKey)?.observed ? 1 : 0);
    }, 0);
    setText(
      group.querySelector(".group-count"),
      `${activeCount}/${cards.length} active`
    );
  });
}

function matchesParameterView(parameter) {
  const searchText = [
    parameter.name,
    parameter.short,
    parameter.kind,
    parameter.number,
    parameter.rawKey,
    parameter.group,
    ...parameter.aliases
  ].join(" ").toLowerCase();
  if (state.query && !searchText.includes(state.query)) return false;

  if (state.filter === "changed") return isRecentlyChanged(parameter);
  if (state.filter === "user") return parameter.source === "user";
  if (state.filter === "agent") {
    return parameter.source === "agent" || parameter.source === "agent_echo";
  }
  if (state.filter === "takeover") return parameter.takeoverRemaining > 0;
  if (state.filter === "catalog") return parameter.catalog;
  return true;
}

function isRecentlyChanged(parameter) {
  return parameter.changedAt > 0 &&
    Date.now() - parameter.changedAt <= CHANGED_WINDOW_SECONDS * 1000;
}

function renderParameterGroup(name, parameters, index) {
  const section = document.createElement("section");
  section.className = "parameter-group";
  section.setAttribute("aria-labelledby", `group-${slug(name)}`);

  const heading = document.createElement("div");
  heading.className = "group-heading";
  heading.innerHTML = `
    <span class="group-index">${String(index + 1).padStart(2, "0")}</span>
    <h3 id="group-${slug(name)}"></h3>
    <span class="group-line" aria-hidden="true"></span>
    <span class="group-count"></span>
  `;
  heading.querySelector("h3").textContent = name;
  heading.querySelector(".group-count").textContent =
    `${parameters.filter((parameter) => parameter.observed).length}/${parameters.length} active`;

  const grid = document.createElement("div");
  grid.className = "parameter-grid";
  parameters.forEach((parameter) => grid.appendChild(renderParameterCard(parameter)));
  section.append(heading, grid);
  return section;
}

function renderParameterCard(parameter) {
  const card = document.createElement("article");
  card.className = "parameter-card";
  card.tabIndex = 0;
  card.dataset.parameterKey = parameter.key;

  const protocolLabel = parameter.kind === "cc"
    ? `CC ${parameter.number}`
    : `NRPN ${parameter.number} · ${parameter.resolutionBits}-BIT`;

  card.innerHTML = `
    <div class="parameter-meta">
      <div class="parameter-title">
        <h4></h4>
        <small></small>
        <span class="ambiguity-badge" hidden></span>
      </div>
      <span class="source-badge"></span>
    </div>
    <div class="control-face">
      <div class="dial" role="meter" aria-valuemin="0" aria-valuemax="${parameter.max}">
        <span class="dial-needle" aria-hidden="true"></span>
        <span class="dial-center" aria-hidden="true"></span>
      </div>
      <div class="value-stack">
        <span class="parameter-value"></span>
        <span class="semantic-value" hidden></span>
        <span class="normalized-value"></span>
        <div class="value-bar" aria-hidden="true"><span></span></div>
      </div>
    </div>
    <div class="parameter-history" aria-hidden="true">
      <svg viewBox="0 0 100 32" preserveAspectRatio="none">
        <path class="history-fill"></path>
        <polyline class="history-line"></polyline>
      </svg>
    </div>
    <div class="parameter-footer">
      <span class="updated-copy"></span>
      <span class="takeover-copy"></span>
    </div>
  `;

  card.querySelector("h4").textContent = parameter.name;
  card.querySelector(".parameter-title small").textContent = protocolLabel;
  const ambiguityBadge = card.querySelector(".ambiguity-badge");
  if (parameter.catalogAmbiguous) {
    ambiguityBadge.hidden = false;
    ambiguityBadge.textContent =
      `${parameter.ambiguityLabel} · ${parameter.catalogMatchCount} definitions`;
  }
  updateParameterCard(card, parameter);
  return card;
}

function updateParameterCard(card, parameter) {
  const sourceClass = `source-${slug(parameter.source)}`;
  if (card.dataset.sourceClass !== sourceClass) {
    if (card.dataset.sourceClass) card.classList.remove(card.dataset.sourceClass);
    card.classList.add(sourceClass);
    card.dataset.sourceClass = sourceClass;
  }
  card.classList.toggle("is-unobserved", !parameter.observed);
  card.classList.toggle("is-ambiguous", parameter.catalogAmbiguous);
  card.classList.toggle("is-takeover", parameter.takeoverRemaining > 0);
  card.classList.toggle(
    "just-changed",
    parameter.changedAt > 0 && Date.now() - parameter.changedAt < 900
  );
  card.style.setProperty("--level", parameter.normalized.toFixed(5));
  card.setAttribute("aria-label", parameterAriaLabel(parameter));

  const sourceCopy = parameter.observed
    ? sourceLabel(parameter.source)
    : parameter.catalog ? "Catalog" : "Mapped";
  const valueCopy = parameter.value === null ? "—" : formatParameterValue(parameter);
  const semantic = semanticParameterValue(parameter);
  setText(card.querySelector(".source-badge"), sourceCopy);
  setText(card.querySelector(".parameter-value"), valueCopy);
  const semanticElement = card.querySelector(".semantic-value");
  semanticElement.hidden = !semantic.text;
  semanticElement.classList.toggle("is-context", semantic.kind === "context");
  semanticElement.classList.toggle("is-unmapped", semantic.kind === "unmapped");
  setText(semanticElement, semantic.text);
  semanticElement.title = semantic.detail || "";
  setText(
    card.querySelector(".normalized-value"),
    normalizedParameterCopy(parameter, semantic)
  );

  const dial = card.querySelector(".dial");
  dial.setAttribute("aria-valuemax", String(parameter.max));
  dial.style.setProperty("--dial-angle", `${-135 + parameter.normalized * 270}deg`);
  if (parameter.value !== null) {
    dial.setAttribute("aria-valuenow", String(parameter.value));
    dial.setAttribute(
      "aria-valuetext",
      [valueCopy, semantic.text, sourceCopy].filter(Boolean).join(", ")
    );
  } else {
    dial.removeAttribute("aria-valuenow");
    dial.setAttribute("aria-valuetext", "Not observed");
  }

  const history = state.histories.get(parameter.key) || [];
  const paths = sparklinePaths(history);
  card.querySelector(".history-fill").setAttribute("d", paths.fill);
  card.querySelector(".history-line").setAttribute("points", paths.line);
  setText(
    card.querySelector(".updated-copy"),
    parameter.age === null ? "NO DATA" : `${relativeAge(parameter.age)} AGO`
  );
  setText(
    card.querySelector(".takeover-copy"),
    parameter.takeoverRemaining > 0
      ? `USER LOCK ${parameter.takeoverRemaining.toFixed(1)}s`
      : ""
  );
}

function parameterAriaLabel(parameter) {
  if (!parameter.observed) {
    return `${parameter.name}, ${parameter.kind.toUpperCase()} ${parameter.number}, not yet observed`;
  }
  const takeover = parameter.takeoverRemaining > 0
    ? `, user takeover for ${parameter.takeoverRemaining.toFixed(1)} more seconds`
    : "";
  const ambiguity = parameter.catalogAmbiguous
    ? `, ${parameter.ambiguityLabel}; raw address could represent ${parameter.catalogMatchCount} catalog definitions`
    : "";
  const semantic = semanticParameterValue(parameter);
  const semanticCopy = semantic.text ? `, displayed as ${semantic.text}` : "";
  return `${parameter.name}, raw value ${formatParameterValue(parameter)} of ${parameter.max}${semanticCopy}, ${sourceLabel(parameter.source)}${ambiguity}${takeover}`;
}

function formatParameterValue(parameter) {
  if (parameter.value === null) return "—";
  return Math.round(parameter.value).toLocaleString();
}

function semanticParameterValue(parameter) {
  const rawValue = finiteNumber(parameter.value);
  if (rawValue === null || parameter.catalogAmbiguous) {
    return parameter.catalogAmbiguous
      ? {
          text: "Raw only · unresolved address",
          detail: "The shared NRPN address has not been resolved to one catalog definition.",
          kind: "unmapped"
        }
      : { text: "", detail: "", kind: "none" };
  }

  const definition = objectOrEmpty(parameter.valueDefinition);
  const kind = firstString(parameter.valueKind, definition.kind).toLowerCase();
  const logicalValue = finiteNumber(parameter.decodedValue) ?? rawValue;
  const backendDisplay = parameter.displayValue;
  const backendLabel = parameter.displayLabel;
  const dependency = firstString(parameter.dependency, definition.dependency);

  if (
    parameter.contextDependent ||
    kind === "context_dependent"
  ) {
    return {
      text: dependency ? `Raw only · needs ${dependency}` : "Raw only · context dependent",
      detail: dependency
        ? `Meaning depends on ${dependency}; no value has been inferred.`
        : "Meaning depends on another parameter; no value has been inferred.",
      kind: "context"
    };
  }

  if (kind === "range" || !kind || kind === "raw" || kind === "continuous") {
    return { text: "", detail: "", kind: "none" };
  }

  if (parameter.displayUnmapped) {
    return {
      text: `Raw only · unmapped ${humanize(kind)}`,
      detail: "The value is outside the labels documented by the catalog.",
      kind: "unmapped"
    };
  }

  if (kind === "enum" || kind === "enum_reference") {
    const label = backendLabel ||
      (typeof backendDisplay === "string" ? backendDisplay : "") ||
      enumLabelForValue(definition, logicalValue);
    if (label) {
      return {
        text: label,
        detail: `Documented ${kind === "enum_reference" ? "rhythm-list" : "enum"} label for raw value ${formatSemanticNumber(logicalValue)}.`,
        kind: "mapped"
      };
    }
    return {
      text: "Raw only · enum value unmapped",
      detail: "No documented label matches this value.",
      kind: "unmapped"
    };
  }

  if (kind === "bipolar") {
    const display = finiteNumber(backendDisplay) ??
      bipolarDisplayValue(definition, logicalValue);
    if (display !== null) {
      return {
        text: formatSemanticNumber(display, true),
        detail: `Documented bipolar display value; raw value ${formatSemanticNumber(logicalValue)}.`,
        kind: "mapped"
      };
    }
    return undocumentedSemanticValue("bipolar");
  }

  if (kind === "signed_wrap") {
    const display = finiteNumber(backendDisplay) ??
      signedWrapDisplayValue(definition, logicalValue);
    if (display !== null) {
      return {
        text: formatSemanticNumber(display, true),
        detail: `Documented signed display value; raw value ${formatSemanticNumber(logicalValue)}.`,
        kind: "mapped"
      };
    }
    return undocumentedSemanticValue("signed");
  }

  if (kind === "selected_byte") {
    const decoded = decodeSelectedByte(parameter, definition, logicalValue);
    if (decoded.payload === null) return undocumentedSemanticValue("selected-byte");
    const label = backendLabel ||
      (typeof backendDisplay === "string" ? backendDisplay : "") ||
      enumItemLabel(definition.items, decoded.payload);
    const selectorCopy = decoded.selector === null
      ? ""
      : ` · selector ${formatSemanticNumber(decoded.selector)}`;
    return {
      text: label
        ? `${label} · payload ${formatSemanticNumber(decoded.payload)}`
        : `Payload ${formatSemanticNumber(decoded.payload)}${selectorCopy}`,
      detail: [
        `Decoded selected-byte payload ${formatSemanticNumber(decoded.payload)}`,
        decoded.selector === null
          ? ""
          : `selector ${formatSemanticNumber(decoded.selector)}`,
        label ? `documented label ${label}` : ""
      ].filter(Boolean).join("; ") + ".",
      kind: "mapped"
    };
  }

  if (kind === "packed_index") {
    const decoded = decodePackedIndex(parameter, definition, logicalValue);
    if (decoded.index === null) {
      return {
        text: "Raw only · packed prefix unmapped",
        detail: "No documented packed-index segment matches the prefix.",
        kind: "unmapped"
      };
    }
    const byteCopy = decoded.prefix === null || decoded.payload === null
      ? ""
      : ` · p${formatSemanticNumber(decoded.prefix)}/b${formatSemanticNumber(decoded.payload)}`;
    return {
      text: `Index ${formatSemanticNumber(decoded.index)}${byteCopy}`,
      detail: decoded.prefix === null || decoded.payload === null
        ? `Decoded logical index ${formatSemanticNumber(decoded.index)}.`
        : `Decoded logical index ${formatSemanticNumber(decoded.index)} from prefix ${formatSemanticNumber(decoded.prefix)} and payload ${formatSemanticNumber(decoded.payload)}.`,
      kind: "mapped"
    };
  }

  if (kind === "curve") {
    const curve = curveDisplayValue(definition, logicalValue);
    const display = finiteNumber(backendDisplay) ?? curve.value;
    const label = backendLabel || curve.label;
    if (display !== null) {
      return {
        text: [
          label,
          formatSemanticNumber(display, true),
          curve.exact ? "anchor" : "interpolated"
        ].filter(Boolean).join(" · "),
        detail: curve.exact
          ? `Exact documented curve anchor at raw value ${formatSemanticNumber(logicalValue)}.`
          : `Linear interpolation between the nearest documented curve anchors at raw value ${formatSemanticNumber(logicalValue)}.`,
        kind: "mapped"
      };
    }
    return {
      text: "Raw only · outside curve anchors",
      detail: "The raw value is outside the documented curve anchors; no extrapolation was applied.",
      kind: "unmapped"
    };
  }

  if (backendLabel || backendDisplay !== null) {
    const display = backendLabel || formatSemanticScalar(backendDisplay);
    if (display) {
      return {
        text: display,
        detail: `Decoded display supplied by the local bridge for ${humanize(kind)}.`,
        kind: "mapped"
      };
    }
  }

  return undocumentedSemanticValue(kind);
}

function normalizedParameterCopy(parameter, semantic) {
  if (parameter.value === null) return "not observed";
  if (semantic.kind === "context") return "context dependent · raw preserved";
  if (semantic.kind === "unmapped") return "documented meaning unavailable · raw preserved";
  return `${(parameter.normalized * 100).toFixed(1)}% normalized`;
}

function enumLabelForValue(definition, value) {
  if (definition.kind === "enum_reference") {
    const enumName = firstString(definition.enum);
    const rhythm = objectOrEmpty(state.catalog.rhythmLists[enumName]);
    return enumItemLabel(rhythm.items, value);
  }
  return enumItemLabel(definition.items, value);
}

function enumItemLabel(items, value) {
  const rounded = Math.round(value);
  const match = arrayOrEmpty(items).find((item) => {
    return item && typeof item === "object" &&
      boundedInteger(item.value, -16383, 16383) === rounded;
  });
  return match ? firstString(match.label) : "";
}

function bipolarDisplayValue(definition, value) {
  const rawMin = finiteNumber(definition.raw_min);
  const rawCenter = finiteNumber(definition.raw_center);
  const rawMax = finiteNumber(definition.raw_max);
  const displayMin = finiteNumber(definition.display_min);
  const displayCenter = finiteNumber(definition.display_center);
  const displayMax = finiteNumber(definition.display_max);
  if (
    rawMin === null || rawCenter === null || rawMax === null ||
    displayMin === null || displayCenter === null || displayMax === null
  ) return null;
  if (value <= rawCenter && rawCenter > rawMin) {
    const fraction = (value - rawMin) / (rawCenter - rawMin);
    return displayMin + fraction * (displayCenter - displayMin);
  }
  if (value >= rawCenter && rawMax > rawCenter) {
    const fraction = (value - rawCenter) / (rawMax - rawCenter);
    return displayCenter + fraction * (displayMax - displayCenter);
  }
  return null;
}

function signedWrapDisplayValue(definition, value) {
  const pivot = finiteNumber(definition.pivot);
  const subtract = finiteNumber(definition.subtract_above_pivot);
  if (pivot === null || subtract === null) return null;
  return value > pivot ? value - subtract : value;
}

function decodeSelectedByte(parameter, definition, logicalValue) {
  const encoding = objectOrEmpty(parameter.encoding);
  let selector = finiteNumber(encoding.selector);
  let payload = finiteNumber(encoding.payload);
  const wireValue = finiteNumber(parameter.rawValue);
  if (payload === null && wireValue !== null) payload = Math.round(wireValue) & 0x7F;
  if (selector === null && wireValue !== null) selector = Math.floor(Math.round(wireValue) / 128);
  if (
    payload === null &&
    parameter.decodeStatus !== "decoded" &&
    logicalValue >= 0
  ) {
    payload = Math.round(logicalValue) & 0x7F;
    selector = selector ?? Math.floor(Math.round(logicalValue) / 128);
  }
  if (payload === null) payload = logicalValue;
  return { selector, payload };
}

function decodePackedIndex(parameter, definition, logicalValue) {
  const encoding = objectOrEmpty(parameter.encoding);
  let prefix = finiteNumber(encoding.prefix);
  let payload = finiteNumber(encoding.payload);
  const wireValue = finiteNumber(parameter.rawValue);
  if (payload === null && wireValue !== null) payload = Math.round(wireValue) & 0x7F;
  if (prefix === null && wireValue !== null) prefix = Math.floor(Math.round(wireValue) / 128);
  if (
    (prefix === null || payload === null) &&
    parameter.decodeStatus !== "decoded"
  ) {
    const packed = Math.round(logicalValue);
    prefix = prefix ?? Math.floor(packed / 128);
    payload = payload ?? (packed & 0x7F);
  }
  const backendIndex = finiteNumber(parameter.decodedValue) ??
    (parameter.decodeStatus === "decoded" ? logicalValue : null);
  if (backendIndex !== null) return { index: backendIndex, prefix, payload };
  const segment = arrayOrEmpty(definition.segments).find((candidate) => {
    return candidate && typeof candidate === "object" &&
      finiteNumber(candidate.prefix) === prefix;
  });
  const offset = finiteNumber(segment?.offset);
  return {
    index: offset === null || payload === null ? null : offset + payload,
    prefix,
    payload
  };
}

function curveDisplayValue(definition, value) {
  const anchors = arrayOrEmpty(definition.anchors)
    .map((anchor) => ({
      raw: finiteNumber(anchor?.raw),
      display: finiteNumber(anchor?.display),
      label: firstString(anchor?.label)
    }))
    .filter((anchor) => anchor.raw !== null && anchor.display !== null)
    .sort((left, right) => left.raw - right.raw);
  const exact = anchors.find((anchor) => anchor.raw === value);
  if (exact) return { value: exact.display, label: exact.label, exact: true };
  for (let index = 0; index < anchors.length - 1; index += 1) {
    const lower = anchors[index];
    const upper = anchors[index + 1];
    if (lower.raw <= value && value <= upper.raw && upper.raw > lower.raw) {
      const fraction = (value - lower.raw) / (upper.raw - lower.raw);
      return {
        value: lower.display + fraction * (upper.display - lower.display),
        label: "",
        exact: false
      };
    }
  }
  return { value: null, label: "", exact: false };
}

function undocumentedSemanticValue(kind) {
  return {
    text: `Raw only · incomplete ${humanize(kind)} map`,
    detail: "The catalog does not provide enough information to decode this value safely.",
    kind: "unmapped"
  };
}

function formatSemanticNumber(value, forceSign = false) {
  const number = finiteNumber(value);
  if (number === null) return "";
  const rounded = Math.round(number);
  const copy = Math.abs(number - rounded) < 0.0001
    ? String(rounded)
    : number.toFixed(2).replace(/\.?0+$/, "");
  if (forceSign && number > 0) return `+${copy}`;
  return copy;
}

function formatSemanticScalar(value) {
  if (typeof value === "string") return value.trim();
  return formatSemanticNumber(value);
}

function sparklinePaths(history) {
  if (!history.length) {
    return { line: "", fill: "" };
  }
  const values = history.length === 1
    ? [{ ...history[0], value: history[0].value }, history[0]]
    : history;
  const points = values.map((entry, index) => {
    const x = values.length === 1 ? 100 : index / (values.length - 1) * 100;
    const y = 29 - clamp(entry.value, 0, 1) * 25;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return {
    line: points.join(" "),
    fill: `M ${points[0]} L ${points.slice(1).join(" L ")} L 100,32 L 0,32 Z`
  };
}

function renderEvents() {
  const events = state.events.slice(0, MAX_TIMELINE_EVENTS);
  setText(
    dom["event-count"],
    `${state.events.length} event${state.events.length === 1 ? "" : "s"}`
  );
  const signature = events.map((event) => event._identity).join("|") || "empty";
  if (signature === state.eventRenderSignature) return;
  state.eventRenderSignature = signature;
  if (!events.length) {
    dom["event-timeline"].innerHTML = `
      <li class="timeline-empty">
        <span class="timeline-mark"></span>
        <div>
          <strong>Awaiting activity</strong>
          <small>Performance and parameter events will appear here.</small>
        </div>
      </li>
    `;
    return;
  }

  const fragment = document.createDocumentFragment();
  events.forEach((event) => {
    const item = document.createElement("li");
    const source = normalizeSource(event.source);
    item.className = `event-item source-${slug(source)}`;
    const copy = eventDescription(event);
    const mark = document.createElement("span");
    mark.className = "timeline-mark";
    mark.setAttribute("aria-hidden", "true");
    const content = document.createElement("div");
    content.className = "event-copy";
    const title = document.createElement("strong");
    title.textContent = copy.title;
    const detail = document.createElement("small");
    detail.textContent = `${sourceLabel(source)} · ${copy.detail}`;
    content.append(title, detail);
    const time = document.createElement("time");
    time.className = "event-time";
    time.dateTime = eventDateTime(event);
    time.textContent = eventTimeLabel(event);
    item.append(mark, content, time);
    fragment.appendChild(item);
  });
  dom["event-timeline"].replaceChildren(fragment);
}

function eventDescription(event) {
  const type = String(event.event || event.type || "event").toLowerCase();
  const channel = boundedInteger(event.channel, 1, 16);
  const channelCopy = channel ? `CH ${channel}` : "MIDI";
  if (type === "cc") {
    const number = boundedInteger(event.number ?? event.cc, 0, 127);
    const name = number === null ? "Control change" : (CC_DEFINITIONS.get(number)?.name || `CC ${number}`);
    return { title: name, detail: `value ${valueOrDash(event.value)} · ${channelCopy}` };
  }
  if (type === "nrpn") {
    return {
      title: `NRPN ${valueOrDash(event.parameter ?? event.number)}`,
      detail: `value ${valueOrDash(event.value)} · ${channelCopy}`
    };
  }
  if (type === "note" || type === "note_on" || type === "note_off") {
    const active = type === "note_on" || (type === "note" && Number(event.velocity) > 0);
    return {
      title: `${active ? "Note on" : "Note off"} · ${midiNoteName(Number(event.note))}`,
      detail: `velocity ${valueOrDash(event.velocity)} · ${channelCopy}`
    };
  }
  if (type === "patch" || type === "program") {
    const bank = firstString(event.bank);
    return {
      title: "Patch changed",
      detail: `${bank ? `${bank} ` : ""}${valueOrDash(event.number ?? event.program)} · ${channelCopy}`
    };
  }
  if (type === "job" || type === "job_complete" || type === "job_canceled") {
    return {
      title: firstString(event.kind, event.status, "Scheduled job"),
      detail: `job ${valueOrDash(event.job ?? event.id)} · ${firstString(event.status, "updated")}`
    };
  }
  if (type === "pitch_bend") {
    const normalized = finiteNumber(event.normalized);
    return {
      title: "Pitch bend",
      detail: `${normalized === null ? valueOrDash(event.value) : signedPercent(normalized)} · ${channelCopy}`
    };
  }
  return {
    title: humanize(type),
    detail: event.value === undefined ? channelCopy : `value ${valueOrDash(event.value)} · ${channelCopy}`
  };
}

function renderTakeover(snapshot) {
  const serverState = objectOrEmpty(snapshot.state);
  const duration = nonNegativeNumber(
    serverState.takeover_seconds ?? objectOrEmpty(snapshot.status).takeover_seconds
  );
  const active = Array.from(state.parameters.values())
    .filter((parameter) => parameter.takeoverRemaining > 0)
    .sort((a, b) => b.takeoverRemaining - a.takeoverRemaining);
  const remaining = active[0]?.takeoverRemaining || 0;
  const level = duration ? clamp(remaining / duration, 0, 1) : 0;
  dom["takeover-status"].style.setProperty("--takeover-level", level.toFixed(4));

  if (!duration) {
    setText(dom["takeover-copy"], state.firstSnapshotReceived ? "Not configured" : "Waiting for state");
  } else if (active.length) {
    setText(
      dom["takeover-copy"],
      `${active.length} control${active.length === 1 ? "" : "s"} protected · ${remaining.toFixed(1)}s`
    );
  } else {
    setText(dom["takeover-copy"], `${duration.toFixed(1)}s window · idle`);
  }
}

function buildKeyboard() {
  const first = 36;
  const last = 84;
  const whitePitchClasses = new Set([0, 2, 4, 5, 7, 9, 11]);
  const whiteNotes = [];
  for (let note = first; note <= last; note += 1) {
    if (whitePitchClasses.has(note % 12)) whiteNotes.push(note);
  }
  const whiteWidth = 100 / whiteNotes.length;
  const whiteIndexByNote = new Map();

  whiteNotes.forEach((note, index) => {
    whiteIndexByNote.set(note, index);
    const key = document.createElement("span");
    key.className = "key key--white";
    key.dataset.note = String(note);
    key.style.left = `${index * whiteWidth}%`;
    key.style.width = `${whiteWidth + 0.08}%`;
    key.title = midiNoteName(note);
    key.setAttribute("aria-hidden", "true");
    dom.keyboard.appendChild(key);
  });

  for (let note = first; note <= last; note += 1) {
    if (whitePitchClasses.has(note % 12)) continue;
    let previousWhite = note - 1;
    while (!whiteIndexByNote.has(previousWhite) && previousWhite >= first) previousWhite -= 1;
    const index = whiteIndexByNote.get(previousWhite);
    if (index === undefined) continue;
    const key = document.createElement("span");
    key.className = "key key--black";
    key.dataset.note = String(note);
    key.style.left = `${(index + 0.68) * whiteWidth}%`;
    key.style.width = `${whiteWidth * 0.62}%`;
    key.title = midiNoteName(note);
    key.setAttribute("aria-hidden", "true");
    dom.keyboard.appendChild(key);
  }
}

function setError(message) {
  const serverError =
    state.snapshot?.error ||
    objectOrEmpty(state.snapshot?.bridge).error;
  if (!message && !serverError) {
    dom["error-banner"].hidden = true;
    return;
  }
  const errorMessage = message || errorToString(serverError);
  dom["error-banner"].hidden = false;
  setText(
    dom["error-title"],
    state.firstSnapshotReceived ? "Telemetry interrupted" : "Telemetry unavailable"
  );
  setText(dom["error-message"], `${errorMessage}. Retrying automatically.`);
}

function updateRelativeTimes() {
  updateSnapshotAge();
  if (!state.firstSnapshotReceived) return;
  if (state.snapshot) {
    ingestSnapshot(state.snapshot);
    renderParameters();
    renderTakeover(state.snapshot);
  }
}

function updateSnapshotAge() {
  if (!state.lastSuccessAt) {
    setText(dom["snapshot-age"], "Not yet updated");
    return;
  }
  const elapsed = Math.max(0, Date.now() - state.lastSuccessAt);
  setText(
    dom["snapshot-age"],
    elapsed < 1000 ? "Updated just now" : `Updated ${(elapsed / 1000).toFixed(1)}s ago`
  );
  const stale = elapsed > 1500;
  dom["live-pulse"].classList.toggle("is-live", !stale);
}

function updateClock() {
  const now = new Date();
  setText(
    dom["footer-clock"],
    new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now)
  );
}

function eventDateTime(event) {
  const direct = firstString(event.timestamp, event.time);
  if (direct) {
    const parsed = new Date(direct);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(event._receivedAt || Date.now()).toISOString();
}

function eventTimeLabel(event) {
  const milliseconds = finiteNumber(event.server_time_ms);
  if (milliseconds !== null) return `${(milliseconds / 1000).toFixed(1)}s`;
  const date = new Date(eventDateTime(event));
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function relativeAge(seconds) {
  if (seconds < 0.05) return "NOW";
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m`;
}

function midiNoteName(note) {
  if (!Number.isFinite(note)) return "—";
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const rounded = Math.round(note);
  return `${names[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

function sourceLabel(source) {
  if (source === "agent_echo") return "Agent echo";
  if (source === "agent") return "Agent";
  if (source === "user") return "User";
  if (source === "patch") return "Patch";
  return source ? humanize(source) : "Unknown";
}

function normalizeSource(source) {
  const normalized = String(source || "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized.includes("echo")) return "agent_echo";
  if (normalized.includes("agent") || normalized.includes("automation")) return "agent";
  if (normalized.includes("user") || normalized.includes("hardware") || normalized.includes("panel")) return "user";
  if (normalized.includes("patch")) return "patch";
  return normalized || "unknown";
}

function humanize(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function signedPercent(value) {
  const bounded = clamp(value, -1, 1) * 100;
  if (Math.abs(bounded) < 0.05) return "center";
  return `${bounded > 0 ? "+" : ""}${bounded.toFixed(1)}%`;
}

function compactNumber(value) {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10000 ? "compact" : "standard",
    maximumFractionDigits: 1
  }).format(value);
}

function firstString(...values) {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}

function stringValue(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function displayScalar(value) {
  if (typeof value === "string") return value.trim();
  return finiteNumber(value);
}

function finiteNumber(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.max(0, number);
}

function boundedInteger(value, minimum, maximum) {
  const number = finiteNumber(value);
  if (number === null) return null;
  const rounded = Math.round(number);
  return rounded >= minimum && rounded <= maximum ? rounded : null;
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "true") return true;
  if (value === 0 || value === "false") return false;
  return null;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function errorToString(error) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    return firstString(error.message, error.code, error.error, "Service reported an error");
  }
  return "Service reported an error";
}

function valueOrDash(value) {
  const number = finiteNumber(value);
  return number === null ? firstString(value, "—") : String(Math.round(number));
}

function setText(element, value) {
  if (!element) return;
  const text = String(value);
  if (element.textContent !== text) element.textContent = text;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function slug(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}
