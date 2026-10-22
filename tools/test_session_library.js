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
  {
    const h = harness({ override: { getRoute: () => "#mixer" } });
    set(h, "hydra.music-mixer.demo.v1", { prompt: { style: "Warm   ambient textures" } });
    const first = await h.api.save();
    assert.equal(first.name, "Music mixer · Warm ambient textures");
    const second = await h.api.save(first.name);
    assert.equal(second.name, `${first.name} (2)`, "new versions get distinct readable names");
    assert.throws(() => h.api.rename(second.id, first.name.toUpperCase()), /already has that name/);
    const imported = h.api.importJSON(h.api.exportJSON(first.id));
    assert.equal(imported[0].name, `${first.name} (3)`, "imported copies are distinguishable");
    const importedCopy = h.api.importJSON(h.api.exportJSON(second.id));
    assert.equal(importedCopy[0].name, `${first.name} (4)`, "copying a numbered version never stacks suffixes");
    const long = await h.api.save("x".repeat(80));
    const duplicate = await h.api.save(long.name);
    assert.equal(duplicate.name.length, 80);
    assert.ok(duplicate.name.endsWith(" (2)"));
  }
  {
    const events = [];
    const manifest = { id: "a".repeat(32), files: 3, bytes: 12345,
      tracks: [{ id: "track-one", name: "Warm pads · 100 BPM · D minor", kind: "elevenlabs", files: 3, bytes: 12345 }] };
    let failCapture = false, failRestore = false, exported;
    const assets = {
      async capture(session) { events.push("audio-capture"); assert.equal(JSON.parse(session.storage["hydra.music-mixer.demo.v1"]).trackId, "track-one"); if (failCapture) throw new Error("Audio missing"); return manifest; },
      async restore(value) { assert.deepEqual(plain(value), manifest); events.push("audio-restore"); if (failRestore) throw new Error("Saved audio unavailable"); },
      async export(library) { exported = plain(library); return "zip-blob"; },
      async import() { return exported; }
    };
    const h = harness({ override: { assets, beforeRestore: () => { events.push("stop"); } } });
    set(h, "hydra.music-mixer.demo.v1", { trackId: "track-one", rap: { pending: { request_id: "pending-voice" }, auto_start: true, legacy_rap: { pending: {}, auto_start: true } } });
    set(h, "hydra.rap-response.v1", { response_id: "response-one", pending: { request_id: "pending-rap" }, auto_play: true });
    const saved = await h.api.save("Audio version");
    assert.deepEqual(plain(saved.assets), manifest);
    const capturedRap = JSON.parse(saved.storage["hydra.rap-response.v1"]);
    assert.equal(capturedRap.pending, undefined); assert.equal(capturedRap.auto_play, false);
    const voice = JSON.parse(saved.storage["hydra.music-mixer.demo.v1"]).rap;
    assert.equal(voice.pending, undefined); assert.equal(voice.auto_start, false); assert.equal(voice.legacy_rap.pending, undefined);
    assert.equal(JSON.parse(h.values.get("hydra.rap-response.v1")).auto_play, true, "saving never changes current controls");
    assert.equal(await h.api.exportArchive(saved.id), "zip-blob");
    assert.deepEqual(exported.sessions[0].assets, manifest);
    failCapture = true;
    await assert.rejects(h.api.update(saved.id), /Audio missing/);
    assert.deepEqual(plain(h.api.list()[0]), plain(saved), "audio capture failures preserve the saved version");
    failRestore = true;
    const before = [...h.values];
    await assert.rejects(h.api.load(saved.id), /audio unavailable/);
    assert.deepEqual([...h.values], before);
    assert.equal(events.includes("stop"), false, "missing audio is reported before stopping playback");
    failRestore = false;
    await h.api.load(saved.id);
    assert.deepEqual(events.slice(-2), ["audio-restore", "stop"], "audio is available before settings change");
    const restored = await h.api.importFile({ name: "session.zip", type: "application/zip", size: 100 }, true);
    assert.equal(restored.length, 1);
    assert.equal(h.api.selectedId, restored[0].id);
    assert.equal(h.events.filter(event => event.startsWith("reload:")).length, 2, "one-version archives load in one action");
    const invalid = plain(exported); invalid.sessions[0].assets.id = "../../outside";
    assert.throws(() => h.api.importJSON(JSON.stringify(invalid)), /audio manifest/);
    await assert.rejects(h.api.importFile({ name: "huge.zip", size: 1025 * 1024 * 1024 }), /1 GB/);
    await assert.rejects(h.api.importFile({ name: "huge.json", size: 5 * 1024 * 1024 }), /4 MB/);
  }
  {
    const origin = harness();
    const saved = await origin.api.save("Old JSON");
    const target = harness();
    await target.api.importFile({ name: "old.json", size: 100, text: async () => origin.api.exportJSON(saved.id) }, true);
    assert.equal(target.events.at(-1), "reload:#synth-mixer", "legacy JSON can be opened directly");
    await origin.api.save("Another version");
    const before = target.events.length;
    await target.api.importFile({ name: "library.json", size: 200, text: async () => origin.api.exportJSON() }, true);
    assert.equal(target.events.length, before, "multi-version imports wait for an explicit selection");
  }
  {
    const h = harness(), requests = [];
    const client = h.library.networkAssets(async (url, options) => { requests.push([url, options]); return { ok: true, json: async () => null, blob: async () => "archive" }; });
    await client.capture({ storage: {}, name: "Music" });
    assert.equal(requests[0][0], "/api/sessions/capture");
    assert.deepEqual(JSON.parse(requests[0][1].body), { storage: {}, name: "Music" });
    assert.equal(await client.export({ sessions: [] }), "archive");
    const file = {}; await client.import(file);
    assert.equal(requests.at(-1)[1].headers["Content-Type"], "application/zip");
    assert.equal(requests.at(-1)[1].body, file);
    await assert.rejects(h.library.networkAssets(async () => { throw new Error("offline"); }).capture({}), /dashboard server/);
    await assert.rejects(h.library.networkAssets(async () => ({ ok: false, status: 404, json: async () => { throw new Error(); } })).capture({}), /Restart/);
  }
  console.log("Session library: snapshot, versioning, import validation, safe restore, rollback and isolation checks passed.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
