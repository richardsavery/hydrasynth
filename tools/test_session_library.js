"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(`${__dirname}/../dashboard/session-library.js`, "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
function harness(options = {}) {
  const values = new Map(), writes = [], events = [];
  let failAt = null, failOnce = false, id = 0;
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) {
      writes.push([key, value]);
      if (key === failAt) { if (failOnce) failAt = null; const error = new Error("Quota exceeded"); error.name = "QuotaExceededError"; throw error; }
      values.set(key, value);
    },
    removeItem(key) { values.delete(key); }
  };
  const context = vm.createContext({ TextEncoder, crypto: { randomUUID: () => `00000000-0000-0000-0000-${String(++id).padStart(12, "0")}` } });
  vm.runInContext(source, context);
  const library = context.HydraSessions;
  const api = library.create({ storage, now: () => "2026-10-13T12:00:00.000Z", getRoute: () => "#synth-mixer",
    beforeCapture: async () => { events.push("capture"); await options.beforeCapture?.(storage); },
    beforeRestore: async (session) => { events.push("stop"); await options.beforeRestore?.(storage, session); },
    reload: async (route) => { events.push(`reload:${route}`); await options.reload?.(storage, route); },
    ...options.override });
  return { api, library, values, writes, events, storage, fail(key, once = true) { failAt = key; failOnce = once; } };
}
const set = (h, key, value) => h.values.set(key, JSON.stringify(value));

async function main() {
  // Robot setup and performance are independent bookmarks; old Drum sessions remain loadable.
  for (const route of ["#robot-setup", "#robot-control", "#drums", "#rap-response"]) {
    const h = harness({ override: { getRoute: () => route } });
    const saved = await h.api.save(`Workspace ${route}`);
    assert.equal(saved.route, route);
    const imported = h.api.importJSON(h.api.exportJSON(saved.id));
    await h.api.load(imported[0].id);
    assert.equal(h.events.at(-1), `reload:${route}`);
  }
  {
    const h = harness({ beforeCapture(storage) { storage.setItem("hydra.connections.v1", '{"inputMode":"live","synthOutput":"midi"}'); } });
    set(h, "hydra.synth-mixer.v1", { parameters: [{ destination: "pitch", value: 65 }] });
    set(h, "hydra.music-mixer.demo.v1", { trackId: "cached-track", config: {}, signalLinks: {} });
    set(h, "hydra.signal-library.v1", { version: 1, mixes: [{ id: "linked", name: "Movement" }] });
    set(h, "hydra-robot-live-settings-v1", { source: "manual", bpm: 108, palette: ["#48e0c0"], ribs: false });
    set(h, "hydra.rap-response.v1", { text: "I missed the bus", bpm: 96, duration: 20, responseId: "saved-response" });
    h.values.set("hydra.interface-detail.v1", "advanced");
    h.values.set("api-key", "SECRET"); h.values.set("hydra.music-mixer.pending.v1", "running-job");
    const first = await h.api.save("  Movement A  ");
    assert.equal(first.name, "Movement A");
    assert.equal(first.route, "#synth-mixer");
    assert.equal(JSON.parse(first.storage["hydra.connections.v1"]).inputMode, "live", "flush finishes before snapshot");
    assert.equal(JSON.parse(first.storage["hydra-robot-live-settings-v1"]).bpm, 108, "robot preferences belong to the saved session");
    assert.equal(JSON.parse(first.storage["hydra.rap-response.v1"]).bpm, 96, "rap response settings belong to the saved session");
    assert.equal(first.storage["api-key"], undefined); assert.equal(first.storage["hydra.music-mixer.pending.v1"], undefined);
    set(h, "hydra.synth-mixer.v1", { parameters: [{ destination: "pitch", value: 80 }] });
    const second = await h.api.save("Movement B");
    assert.notEqual(first.id, second.id);
    assert.equal(h.api.list().length, 2);
    assert.equal(JSON.parse(h.api.list()[1].storage["hydra.synth-mixer.v1"]).parameters[0].value, 65, "new saves never replace old versions");
    set(h, "hydra.synth-mixer.v1", { parameters: [{ destination: "pitch", value: 90 }] });
    const updated = await h.api.update(second.id);
    assert.equal(updated.createdAt, second.createdAt); assert.equal(updated.name, "Movement B");
    assert.equal(JSON.parse(updated.storage["hydra.synth-mixer.v1"]).parameters[0].value, 90);
    h.api.rename(second.id, "Lively"); assert.equal(h.api.list()[0].name, "Lively");
    h.values.set("hydra.elevenlabs.workspace.v1", '{"generationSettings":{}}');
    set(h, "hydra.rap-response.v1", { text: "A newer prompt", bpm: 120 });
    await h.api.load(first.id);
    assert.equal(h.values.has("hydra.elevenlabs.workspace.v1"), false, "keys absent from snapshot reset to defaults");
    assert.equal(JSON.parse(h.values.get("hydra.synth-mixer.v1")).parameters[0].value, 65);
    assert.equal(JSON.parse(h.values.get("hydra.rap-response.v1")).text, "I missed the bus", "loading restores the previous rap prompt and settings");
    assert.equal(h.values.get("api-key"), "SECRET"); assert.equal(h.values.get("hydra.music-mixer.pending.v1"), "running-job");
    assert.deepEqual(h.events.slice(-2), ["stop", "reload:#synth-mixer"]);
    assert.equal(h.values.get(h.library.ACTIVE_KEY), first.id);
    assert.equal(h.library.create({ storage: h.storage }).selectedId, first.id, "loading an older version keeps it selected after reload");
    assert.equal(h.api.list().length, 2, "loading leaves the saved versions intact");
    const outside = h.api.list(); outside[0].name = "Changed outside";
    assert.equal(h.api.list()[0].name, "Lively", "public snapshots are copied");
    h.api.remove(second.id); assert.equal(h.api.list().length, 1);
    assert.throws(() => h.api.remove(second.id), /no longer available/);
  }
  {
    const origin = harness(); set(origin, "hydra-signal-lab-v1", { lastRecording: "recording.jsonl", controls: {} });
    const saved = await origin.api.save("<img src=x onerror=alert(1)>");
    const exported = origin.api.exportJSON(saved.id), target = harness();
    set(target, "hydra.synth-mixer.v1", { parameters: [] });
    set(target, "hydra.rap-response.v1", { text: "Previous active rap", bpm: 100 });
    const activeBefore = target.values.get("hydra.synth-mixer.v1");
    const imported = target.api.importJSON(exported);
    assert.equal(imported[0].name, saved.name, "names remain plain text for escaped UI rendering");
    assert.equal(target.values.get("hydra.synth-mixer.v1"), activeBefore, "import alone never changes active settings");
    target.api.importJSON(exported);
    assert.equal(target.api.list().length, 2); assert.equal(new Set(target.api.list().map((item) => item.id)).size, 2, "reimport adds copies");
    await target.api.load(imported[0].id);
    assert.equal(JSON.parse(target.values.get("hydra-signal-lab-v1")).lastRecording, "recording.jsonl");
    assert.equal(target.values.has("hydra.rap-response.v1"), false, "older sessions without rap settings restore its defaults");
  }
  {
    const h = harness(); set(h, "hydra.synth-mixer.v1", { parameters: [] });
    const saved = await h.api.save("Safe"), valid = JSON.parse(h.api.exportJSON(saved.id));
    const before = [...h.values], stopped = h.events.length;
    const malicious = [
      "invalid JSON", "null", "[]", JSON.stringify({ ...valid, version: 9 }),
      JSON.stringify({ ...valid, sessions: [null] }),
      JSON.stringify({ ...valid, sessions: [valid.sessions[0], valid.sessions[0]] }),
      JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], schema: 2 }] }),
      JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], name: "" }] }),
      JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], createdAt: "not-a-date" }] }),
      JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], route: "https://evil.example" }] }),
      JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], storage: { "api-key": "value" } }] }),
      JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], storage: { "hydra.music-mixer.pending.v1": "{}" } }] }),
      JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], storage: { "hydra.synth-mixer.v1": [] } }] }),
      JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], storage: { "hydra.synth-mixer.v1": "null" } }] }),
      JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], storage: { "hydra.synth-mixer.v1": '{"__proto__":{"polluted":true}}' } }] }),
      JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], storage: { "hydra.signal-library.v1": '{"version":2,"mixes":[]}' } }] }),
      JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], storage: { "hydra.interface-detail.v1": "anything" } }] }),
      " ".repeat(4 * 1024 * 1024 + 1),
      JSON.stringify({ ...valid, sessions: Array.from({ length: 51 }, (_, i) => ({ ...valid.sessions[0], id: `version-${i}` })) })
    ];
    for (const input of malicious) {
      assert.throws(() => h.api.importJSON(input), undefined, input.slice(0, 120));
      assert.deepEqual([...h.values], before, "invalid import leaves active settings and saved library untouched");
      assert.equal(h.events.length, stopped, "invalid import does not stop or start playback");
    }
    const deep = {}; let current = deep; for (let i = 0; i < 50; i++) current = current.child = {};
    assert.throws(() => h.api.importJSON(JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], storage: { "hydra.synth-mixer.v1": JSON.stringify(deep) } }] })), /too complex/);
  }
  {
    const h = harness(); set(h, "hydra.synth-mixer.v1", { value: "original saved" });
    set(h, "hydra.connections.v1", { synthOutput: "audio" });
    const saved = await h.api.save("Original");
    set(h, "hydra.synth-mixer.v1", { value: "current active" });
    set(h, "hydra.connections.v1", { synthOutput: "midi" });
    set(h, "hydra.elevenlabs.realtime.v1", { mappings: ["current"] });
    const before = [...h.values].sort();
    h.fail("hydra.synth-mixer.v1");
    await assert.rejects(h.api.load(saved.id), /previous settings were restored.*storage is full/);
    assert.deepEqual([...h.values].sort(), before, "partial storage failures roll back all prior active keys");
    assert.equal(h.events.filter((event) => event.startsWith("reload:")).length, 0, "failed restore never reloads");
    h.fail(h.library.ACTIVE_KEY);
    await assert.rejects(h.api.load(saved.id), /previous settings were restored/);
    assert.deepEqual([...h.values].sort(), before, "selection persistence failure rolls back the entire restore");
    h.fail(h.library.KEY);
    await assert.rejects(h.api.save("Cannot fit"), /storage is full or unavailable/);
    assert.equal(h.api.list().length, 1, "failed save preserves the existing library");
  }
  {
    let allow = false;
    const h = harness({ override: { beforeRestore: () => allow } });
    set(h, "hydra.synth-mixer.v1", { value: 1 }); const saved = await h.api.save("Saved");
    set(h, "hydra.synth-mixer.v1", { value: 2 });
    await assert.rejects(h.api.load(saved.id), /Could not stop playback/);
    assert.equal(JSON.parse(h.values.get("hydra.synth-mixer.v1")).value, 2);
    allow = true; await h.api.load(saved.id);
    assert.equal(JSON.parse(h.values.get("hydra.synth-mixer.v1")).value, 1);
    await assert.rejects(h.api.save(" "), /version name/);
    await assert.rejects(h.api.update("missing-session"), /no longer available/);
  }
  {
    const h = harness(); h.values.set(h.library.KEY, "corrupt");
    await assert.rejects(h.api.save("Safe"), /not a valid JSON/);
    assert.equal(h.values.get(h.library.KEY), "corrupt", "corrupt libraries are never silently overwritten");
    const blocked = h.library.create({ storage: null });
    await assert.rejects(blocked.save("No storage"), /storage is unavailable/);
  }
  console.log("Session library: snapshot, versioning, import validation, safe restore, rollback and isolation checks passed.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
