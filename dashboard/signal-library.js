"use strict";

// Shared definitions keep each workspace's bus IDs and output mappings intact.
globalThis.HydraSignalLibrary = (() => {
  const KEY = "hydra.signal-library.v1";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const modes = new Set(["shared", "demo"]);
  const operators = new Set(["average", "weighted", "difference", "minimum", "maximum"]);
  const safeId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !["__proto__", "prototype", "constructor"].includes(value);
  function definition(bus) {
    return {
      name: typeof bus?.name === "string" ? bus.name.slice(0, 30) : "Signal mix",
      operator: operators.has(bus?.operator) ? bus.operator : "average",
      sources: (Array.isArray(bus?.sources) ? bus.sources : []).slice(0, 6).map((source) => ({
        ...globalThis.HydraElevenRealtime.validateSource(source),
        weight: Number.isFinite(source?.weight) ? Math.max(0, Math.min(100, source.weight)) : 1
      }))
    };
  }
  // Automatic calibration remains local; only deliberate edits publish changes.
  function signature(bus) {
    const value = definition(bus);
    for (const source of value.sources) { delete source.learnedMin; delete source.learnedMax; delete source.awaitingBounds; }
    return JSON.stringify(value);
  }
  function normalize(raw) {
    const ids = new Set();
    return { version: 1, mixes: (Array.isArray(raw?.mixes) ? raw.mixes : []).slice(0, 128).flatMap((item) => {
      if (!safeId(item?.id) || ids.has(item.id) || !modes.has(item.mode)) return [];
      const bus = definition(item.bus);
      if (!bus.sources.length) return [];
      ids.add(item.id);
      return [{ id: item.id, mode: item.mode, bus,
        revision: Number.isSafeInteger(item.revision) && item.revision > 0 ? item.revision : 1 }];
    }) };
  }
  function getState() {
    try { return normalize(JSON.parse(localStorage.getItem(KEY) || "null")); }
    catch (_) { return { version: 1, mixes: [] }; }
  }
  function replaceState(raw) {
    const state = normalize(raw);
    localStorage.setItem(KEY, JSON.stringify(state));
    return state;
  }
  const newId = () => `shared-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  function create(savedLinks = {}) {
    let links = {};
    for (const [busId, link] of Object.entries(savedLinks || {})) {
      if (safeId(busId) && safeId(link?.id)) links[busId] = {
        id: link.id, revision: Number.isSafeInteger(link.revision) ? link.revision : 0,
        signature: typeof link.signature === "string" ? link.signature : ""
      };
    }
    function sync(config) {
      const state = getState(); let changed = false;
      for (const [busId, link] of Object.entries(links)) {
        const index = config.buses.findIndex((bus) => bus.id === busId);
        const entry = state.mixes.find((item) => item.id === link.id);
        if (index < 0 || !entry || entry.mode !== config.mode) { delete links[busId]; continue; }
        if (link.revision !== entry.revision) {
          const previous = config.buses[index];
          config.buses[index] = { id: busId, ...clone(entry.bus) };
          if (signature(previous) === signature(entry.bus)) {
            config.buses[index].sources.forEach((source, i) => {
              source.learnedMin = previous.sources[i].learnedMin;
              source.learnedMax = previous.sources[i].learnedMax;
            });
          }
          changed = true;
        }
        link.revision = entry.revision; link.signature = signature(entry.bus);
      }
      return changed;
    }
    function publish(config) {
      const state = getState(), updated = []; let changed = false;
      for (const [busId, link] of Object.entries(links)) {
        const bus = config.buses.find((item) => item.id === busId);
        const entry = state.mixes.find((item) => item.id === link.id);
        if (!bus || !entry || entry.mode !== config.mode) { delete links[busId]; continue; }
        const nextSignature = signature(bus);
        if (nextSignature !== link.signature) {
          entry.bus = definition(bus); entry.revision += 1; changed = true;
          updated.push({ link, signature: nextSignature, revision: entry.revision });
        }
      }
      if (changed) {
        replaceState(state);
        for (const update of updated) { update.link.signature = update.signature; update.link.revision = update.revision; }
      }
    }
    function share(bus, mode) {
      if (!bus || !modes.has(mode)) throw new Error("Choose a signal mix to share.");
      const state = getState();
      if (state.mixes.length >= 128) throw new Error("The shared signal library is full.");
      const entry = { id: newId(), mode, bus: definition(bus), revision: 1 };
      if (!entry.bus.sources.length) throw new Error("Add an input before sharing this mix.");
      state.mixes.push(entry); replaceState(state);
      links[bus.id] = { id: entry.id, revision: entry.revision, signature: signature(bus) };
      return clone(entry);
    }
    function attach(id, config, busId) {
      const entry = getState().mixes.find((item) => item.id === id);
      if (!entry) throw new Error("This shared signal mix is no longer available.");
      if (entry.mode !== config.mode) throw new Error(`Select ${entry.mode === "demo" ? "Simulated demo signals" : "Connections input"} before adding this mix.`);
      if (Object.entries(links).some(([linkedBusId, link]) => link.id === id && config.buses.some((bus) => bus.id === linkedBusId))) {
        throw new Error("This shared signal mix is already in this workspace.");
      }
      if (config.buses.length >= 4) throw new Error("Remove a signal mix before adding another.");
      if (!safeId(busId) || config.buses.some((bus) => bus.id === busId)) throw new Error("Choose a unique signal mix ID.");
      config.buses.push({ id: busId, ...clone(entry.bus) });
      links[busId] = { id, revision: entry.revision, signature: signature(entry.bus) };
    }
    return { sync, publish, share, attach, linkFor: (busId) => links[busId] ? clone(links[busId]) : null,
      detach: (busId) => { delete links[busId]; }, detachAll: () => { links = {}; },
      getLinks: () => clone(links) };
  }
  return { KEY, create, getState, exportState: getState, replaceState, signature };
})();
