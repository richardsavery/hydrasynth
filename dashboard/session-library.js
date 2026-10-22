"use strict";

// Named settings snapshots with immutable, server-backed generated audio.
// ZIP exports carry the audio; browser storage holds only small manifests.
globalThis.HydraSessions = (() => {
  const KEY = "hydra.sessions.v1";
  const ACTIVE_KEY = "hydra.sessions.active.v1";
  const FORMAT = "hydra-sessions";
  const KEYS = Object.freeze([
    "hydra-signal-lab-v1", "hydra.connections.v1", "hydra.synth-mixer.v1",
    "hydra.music-mixer.demo.v1", "hydra.signal-library.v1", "hydra-rap-experiment-v1", "hydra-robot-live-settings-v1", "hydra-robot-drums-v1",
    "hydra.rap-response.v1",
    "hydra.elevenlabs.realtime.v1", "hydra.elevenlabs.workspace.v1", "hydra.interface-detail.v1"
  ]);
  const ROUTES = new Set(["#connections", "#synth", "#synth-mixer", "#synth-legacy", "#drums", "#mixer", "#elevenlabs", "#rap-experiment", "#rap-response", "#robot-setup", "#robot-control"]);
  const MAX_SESSIONS = 50, MAX_BYTES = 4 * 1024 * 1024, MAX_SNAPSHOT = 1024 * 1024;
  const MAX_ARCHIVE = 1024 * 1024 * 1024;
  const WORKSPACES = { "#mixer": "Music mixer", "#synth-mixer": "Synth mixer", "#synth": "Synth mixer", "#synth-legacy": "Synth signals", "#drums": "Drums", "#elevenlabs": "Generated music", "#rap-response": "Rap response", "#rap-experiment": "Voice comparison", "#connections": "Connections", "#robot-setup": "Robot setup", "#robot-control": "Robot control" };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const bytes = (value) => typeof TextEncoder === "function" ? new TextEncoder().encode(value).length : value.length * 2;
  const audioSize = (value) => value < 1048576 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / 1048576).toFixed(1)} MB`;
  const object = (value) => value && typeof value === "object" && !Array.isArray(value);
  const fail = (message) => { throw new Error(message); };
  function safeJSON(value) {
    const pending = [[value, 0]];
    let count = 0;
    while (pending.length) {
      const [item, depth] = pending.pop();
      if (++count > 50000 || depth > 40) fail("This session contains settings that are too complex.");
      if (item && typeof item === "object") {
        for (const key of Object.keys(item)) {
          if (["__proto__", "prototype", "constructor"].includes(key)) fail("This session contains an unsupported setting.");
          pending.push([item[key], depth + 1]);
        }
      } else if (!["string", "number", "boolean"].includes(typeof item) && item !== null) fail("This session contains invalid settings.");
    }
  }
  function nameOf(value) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 80) fail("Enter a version name of 1–80 characters.");
    return value.trim();
  }
  function validateStorage(value) {
    if (!object(value)) fail("This session is missing its settings.");
    if (bytes(JSON.stringify(value)) > MAX_SNAPSHOT) fail("This session is too large (maximum 1 MB).");
    for (const [key, raw] of Object.entries(value)) {
      if (!KEYS.includes(key)) fail(`This session includes an unsupported settings key: ${key}.`);
      if (typeof raw !== "string") fail("Session settings must be stored as text.");
      if (key === "hydra.interface-detail.v1") {
        if (!["basic", "advanced"].includes(raw)) fail("This session has an invalid interface setting.");
      } else {
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { fail(`This session contains invalid JSON settings for ${key}.`); }
        if (!object(parsed)) fail(`This session has invalid settings for ${key}.`);
        safeJSON(parsed);
        if (key === "hydra.signal-library.v1" && parsed.version !== 1) fail("This session uses an unsupported signal library version.");
      }
    }
    return value;
  }
  function validateSession(value) {
    if (!object(value) || value.schema !== 1) fail("This file uses an unsupported session version.");
    if (Object.keys(value).some((key) => !["schema", "id", "name", "createdAt", "updatedAt", "route", "storage", "extras", "assets"].includes(key))) fail("This session contains unsupported fields.");
    if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9_-]{5,79}$/i.test(value.id)) fail("This session has an invalid identifier.");
    nameOf(value.name);
    for (const key of ["createdAt", "updatedAt"]) {
      if (typeof value[key] !== "string" || value[key].length > 32 || !Number.isFinite(Date.parse(value[key]))) fail("This session has an invalid date.");
    }
    if (!ROUTES.has(value.route)) fail("This session uses an unsupported workspace.");
    validateStorage(value.storage);
    if (value.assets !== undefined) {
      const assets = value.assets, count = (n) => Number.isSafeInteger(n) && n >= 0;
      if (!object(assets) || !/^[a-f0-9]{32}$/.test(assets.id) || !count(assets.files) || !count(assets.bytes) ||
          !Array.isArray(assets.tracks) || assets.tracks.length > 200 || bytes(JSON.stringify(assets)) > 65536) fail("This session has an invalid audio manifest.");
      safeJSON(assets);
      for (const track of assets.tracks) {
        if (!object(track) || typeof track.id !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(track.id) ||
            !["elevenlabs", "rap-response", "rap-experiment", "rap"].includes(track.kind) ||
            typeof track.name !== "string" || !track.name.trim() || track.name.length > 500 || !count(track.files) || !count(track.bytes)) fail("This session has an invalid audio track.");
      }
    }
    if (value.extras !== undefined) {
      if (!object(value.extras) || bytes(JSON.stringify(value.extras)) > 16384) fail("This session has invalid connection settings.");
      safeJSON(value.extras);
    }
    return copy(value);
  }
  function validateLibrary(value) {
    if (!object(value) || value.format !== FORMAT || value.version !== 1 || !Array.isArray(value.sessions)) fail("Choose a Hydra sessions JSON file (version 1).");
    if (Object.keys(value).some((key) => !["format", "version", "sessions"].includes(key))) fail("This file contains unsupported fields.");
    if (value.sessions.length > MAX_SESSIONS) fail(`Keep at most ${MAX_SESSIONS} saved versions. Export or delete some first.`);
    const sessions = value.sessions.map(validateSession);
    if (new Set(sessions.map((session) => session.id)).size !== sessions.length) fail("This file contains duplicate session identifiers.");
    return { format: FORMAT, version: 1, sessions };
  }
  function parseLibrary(text) {
    if (typeof text !== "string" || bytes(text) > MAX_BYTES) fail("Choose a sessions file smaller than 4 MB.");
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { fail("This is not a valid JSON sessions file."); }
    return validateLibrary(parsed);
  }
  function passiveStorage(values) {
    const result = { ...values };
    const cleanVoice = (value) => {
      if (!object(value)) return;
      delete value.pending;
      if ("auto_play" in value) value.auto_play = false;
      if ("auto_start" in value) value.auto_start = false;
      if (value.legacy_rap) cleanVoice(value.legacy_rap);
    };
    for (const key of ["hydra-rap-experiment-v1", "hydra.rap-response.v1", "hydra.music-mixer.demo.v1", "hydra.synth-mixer.v1"]) {
      if (!result[key]) continue;
      const value = JSON.parse(result[key]);
      if (["hydra.music-mixer.demo.v1", "hydra.synth-mixer.v1"].includes(key)) cleanVoice(value.rap);
      else cleanVoice(value);
      result[key] = JSON.stringify(value);
    }
    return result;
  }
  function networkAssets(fetcher = globalThis.fetch) {
    async function request(path, body, archive = false, download = false) {
      let response;
      try {
        response = await fetcher(`/api/sessions/${path}`, { method: "POST", cache: "no-store",
          headers: { "Content-Type": archive ? "application/zip" : "application/json" }, body: archive ? body : JSON.stringify(body) });
      } catch (_) { fail("Could not reach the dashboard server. Keep it running and try again."); }
      if (!response.ok) {
        let message; try { message = (await response.json()).error; } catch (_) { /* An old server may return HTML. */ }
        fail(message || (response.status === 404 ? "Restart the dashboard server to enable sessions with audio." : `Session audio could not be processed (${response.status}).`));
      }
      return download ? response.blob() : response.json();
    }
    return { capture: (session) => request("capture", { storage: session.storage, name: session.name }),
      restore: (assets) => request("restore", { assets }),
      export: (library) => request("export", library, false, true), import: (file) => request("import", file, true) };
  }
  function create(options = {}) {
    let storage = options.storage;
    if (storage === undefined) { try { storage = globalThis.localStorage; } catch (_) { /* Report on use. */ } }
    let dialog, container, selectedId = "", busy = false, returnFocus;
    try { selectedId = storage?.getItem(ACTIVE_KEY) || ""; } catch (_) { /* Report unavailable storage when used. */ }
    const document = options.document || globalThis.document;
    const location = options.location || globalThis.location;
    const now = () => new Date(options.now?.() ?? Date.now()).toISOString();
    const newId = () => `session-${Date.now().toString(36)}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    const requireStorage = () => { if (!storage) fail("Browser storage is unavailable. Allow site storage to save sessions."); };
    function uniqueName(name, sessions) {
      const names = new Set(sessions.map((session) => session.name.toLocaleLowerCase()));
      if (!names.has(name.toLocaleLowerCase())) return name;
      const numbered = name.match(/^(.*) \((\d+)\)$/);
      const base = numbered?.[1] || name;
      let candidate = name, suffix = numbered && Number(numbered[2]) < 10000 ? Number(numbered[2]) + 1 : 2;
      while (names.has(candidate.toLocaleLowerCase())) {
        const tail = ` (${suffix++})`; candidate = base.slice(0, 80 - tail.length).trimEnd() + tail;
      }
      return candidate;
    }
    function suggestedName() {
      const route = options.getRoute?.() || location?.hash || "#synth-mixer", values = readStorage();
      const settings = (key) => JSON.parse(values[key] || "{}");
      const detail = route === "#mixer" ? settings("hydra.music-mixer.demo.v1").prompt?.style
        : route === "#elevenlabs" ? settings("hydra.elevenlabs.workspace.v1").generationSettings?.style
          : route === "#rap-response" ? settings("hydra.rap-response.v1").text : "";
      const name = [WORKSPACES[route] || "Session", typeof detail === "string" ? detail.replace(/\s+/g, " ").trim().slice(0, 48) : ""].filter(Boolean).join(" · ");
      return uniqueName(name, readLibrary().sessions);
    }
    function readLibrary() {
      requireStorage();
      let text;
      try { text = storage.getItem(KEY); } catch (_) { fail("Browser storage is unavailable. Allow site storage to save sessions."); }
      return text === null ? { format: FORMAT, version: 1, sessions: [] } : parseLibrary(text);
    }
    function writeLibrary(library) {
      const text = JSON.stringify(validateLibrary(library));
      if (bytes(text) > MAX_BYTES) fail("Saved sessions are full. Export or delete some versions before saving another.");
      try { storage.setItem(KEY, text); } catch (_) { fail("Could not save: browser storage is full or unavailable. Export your versions, then delete older ones or allow site storage."); }
    }
    function readStorage() {
      const values = {};
      try { for (const key of KEYS) { const value = storage.getItem(key); if (value !== null) values[key] = value; } }
      catch (_) { fail("Could not read dashboard settings. Allow site storage and try again."); }
      return validateStorage(values);
    }
    async function capture(name, previous) {
      requireStorage(); name = nameOf(name);
      if (await options.beforeCapture?.() === false) fail("Could not save the current settings. Check browser storage and try again.");
      const route = options.getRoute?.() || location?.hash || "#synth-mixer";
      const session = { schema: 1, id: previous?.id || newId(), name, createdAt: previous?.createdAt || now(), updatedAt: now(), route: ROUTES.has(route) ? route : "#synth-mixer", storage: passiveStorage(readStorage()) };
      if (options.captureExtras) session.extras = await options.captureExtras();
      if (options.assets) {
        const assets = await options.assets.capture(copy(session));
        if (assets) session.assets = assets;
      }
      return validateSession(session);
    }
    function findSession(id, library = readLibrary()) {
      return library.sessions.find((session) => session.id === id) || fail("That saved version is no longer available.");
    }
    function rememberSelection(id) {
      selectedId = id;
      try { if (id) storage.setItem(ACTIVE_KEY, id); else storage.removeItem(ACTIVE_KEY); } catch (_) { /* The version itself remains saved. */ }
    }
    async function save(name = suggestedName()) {
      const existing = readLibrary();
      if (existing.sessions.length >= MAX_SESSIONS) fail(`Keep at most ${MAX_SESSIONS} saved versions. Export or delete some first.`);
      const session = await capture(uniqueName(nameOf(name), existing.sessions));
      const library = readLibrary(); session.name = uniqueName(session.name, library.sessions); library.sessions.unshift(session); writeLibrary(library);
      rememberSelection(session.id); refresh(); return copy(session);
    }
    async function update(id) {
      const previous = findSession(id), session = await capture(previous.name, previous);
      const library = readLibrary(), index = library.sessions.findIndex((item) => item.id === id);
      if (index < 0) fail("That saved version is no longer available.");
      library.sessions[index] = session; writeLibrary(library); rememberSelection(id); refresh(); return copy(session);
    }
    function replaceStorage(values) {
      // Remove first so a large old snapshot cannot prevent a smaller one loading.
      for (const key of KEYS) storage.removeItem(key);
      for (const [key, value] of Object.entries(values)) storage.setItem(key, value);
    }
    async function load(id) {
      const session = validateSession(findSession(id));
      // Validation happens before stopping playback or mutating any active state.
      if (session.assets) {
        if (!options.assets) fail("This version includes audio. Open it with the dashboard server running.");
        await options.assets.restore(copy(session.assets));
      }
      if (await options.beforeRestore?.(copy(session)) === false) fail("Could not stop playback. Stop the players and try loading again.");
      const previous = readStorage(), previousSelection = storage.getItem(ACTIVE_KEY);
      try {
        replaceStorage(passiveStorage(session.storage));
        storage.setItem(ACTIVE_KEY, id);
        await options.restoreExtras?.(copy(session.extras || {}));
      } catch (error) {
        try {
          replaceStorage(previous);
          if (previousSelection === null) storage.removeItem(ACTIVE_KEY);
          else storage.setItem(ACTIVE_KEY, previousSelection);
        }
        catch (_) { fail("Loading failed and browser storage could not be restored. Keep this page open, allow site storage, then save your current settings again."); }
        fail(`Could not load this version; your previous settings were restored. ${error?.name === "QuotaExceededError" ? "Browser storage is full. Export or delete older sessions and try again." : "Check browser storage and try again."}`);
      }
      selectedId = id;
      if (options.reload) await options.reload(session.route);
      else if (location) {
        globalThis.history?.replaceState(null, "", session.route);
        location.reload();
      }
      return copy(session);
    }
    function rename(id, name) {
      name = nameOf(name); const library = readLibrary(), session = findSession(id, library);
      if (library.sessions.some((item) => item.id !== id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) fail("Another version already has that name. Choose a different name.");
      session.name = name; session.updatedAt = now(); writeLibrary(library); refresh(); return copy(session);
    }
    function remove(id) {
      const library = readLibrary(); findSession(id, library);
      library.sessions = library.sessions.filter((session) => session.id !== id); writeLibrary(library);
      if (selectedId === id) rememberSelection(""); refresh();
    }
    function exportJSON(id) {
      const library = readLibrary();
      if (id) library.sessions = [findSession(id, library)];
      return JSON.stringify(library, null, 2);
    }
    function importJSON(text) {
      const imported = parseLibrary(text), library = readLibrary();
      if (!imported.sessions.length) fail("This file has no saved sessions.");
      // Imports always add copies. An identifier from a file cannot overwrite a version.
      const sessions = [];
      for (const session of imported.sessions) sessions.push({ ...session, id: newId(), name: uniqueName(session.name, [...library.sessions, ...sessions]) });
      library.sessions.unshift(...sessions); writeLibrary(library); rememberSelection(sessions[0].id); refresh();
      return copy(sessions);
    }
    async function exportArchive(id) {
      if (!options.assets) fail("Start the dashboard server to export sessions with audio.");
      return options.assets.export(JSON.parse(exportJSON(id)));
    }
    async function importFile(file, loadSingle = false) {
      const archive = /\.zip$/i.test(file.name) || ["application/zip", "application/x-zip-compressed"].includes(file.type);
      if (file.size > (archive ? MAX_ARCHIVE : MAX_BYTES)) fail(archive ? "Choose a session ZIP smaller than 1 GB." : "Choose a sessions JSON file smaller than 4 MB.");
      if (archive && !options.assets) fail("Start the dashboard server to open a session ZIP.");
      const imported = importJSON(archive ? JSON.stringify(await options.assets.import(file)) : await file.text());
      if (loadSingle && imported.length === 1) await load(imported[0].id);
      return imported;
    }
    const $ = (id) => dialog?.querySelector(`#hs-${id}`);
    function notice(message = "", isError = false) {
      if (!$("notice")) return;
      $("notice").textContent = message; $("notice").hidden = !message;
      $("notice").classList.toggle("is-error", isError);
    }
    function refresh() {
      if (!dialog) return;
      const sessions = readLibrary().sessions;
      if (!sessions.some((session) => session.id === selectedId)) rememberSelection(sessions[0]?.id || "");
      $("versions").innerHTML = sessions.length ? sessions.map((session) => `<option value="${escape(session.id)}" ${session.id === selectedId ? "selected" : ""}>${escape(session.name)}</option>`).join("") : '<option value="">No saved versions yet</option>';
      $("versions").disabled = busy || !sessions.length;
      for (const button of dialog.querySelectorAll("[data-needs-selection]")) button.disabled = busy || !selectedId;
      $("export-all").disabled = busy || !sessions.length;
      const selected = sessions.find((session) => session.id === selectedId);
      const assets = selected?.assets;
      $("details").textContent = selected ? `${WORKSPACES[selected.route]} · Saved ${new Date(selected.updatedAt).toLocaleString()} · ${assets ? `${assets.files} audio file${assets.files === 1 ? "" : "s"} included (${audioSize(assets.bytes)})` : "Settings saved"}` : "Save your current setup to return to it later.";
      $("audio-list").textContent = assets?.tracks.map((track) => track.name).join("\n") || "";
      $("audio-list").hidden = !assets?.tracks.length;
      container.querySelector("[data-sessions-open]").title = `${sessions.length} saved version${sessions.length === 1 ? "" : "s"}`;
    }
    async function download(id) {
      const session = id ? findSession(id) : null;
      const blob = options.assets ? await exportArchive(id) : new Blob([exportJSON(id)], { type: "application/json" });
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      const extension = options.assets ? "zip" : "json";
      const slug = session?.name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "saved";
      link.href = url; link.download = session ? `hydra-session-${slug}.${extension}` : `hydra-sessions.${extension}`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    async function action(callback, message, progress = "Working…") {
      if (busy) return;
      busy = true; notice(progress); dialog.setAttribute("aria-busy", "true");
      for (const control of dialog.querySelectorAll("button:not([data-close]), input, select")) control.disabled = true;
      try { const result = await callback(); notice(typeof message === "function" ? message(result) : message); }
      catch (error) { notice(error.message || "This action could not be completed.", true); }
      finally {
        busy = false; dialog.setAttribute("aria-busy", "false");
        for (const control of dialog.querySelectorAll("button, input, select")) control.disabled = false;
        try { refresh(); } catch (error) { notice(error.message, true); }
      }
    }
    function open() {
      if (!dialog) return;
      returnFocus = document.activeElement; notice();
      try { refresh(); $("name").value = selectedId ? findSession(selectedId).name : suggestedName(); } catch (error) { notice(error.message, true); }
      dialog.showModal(); $("name").focus();
    }
    function init() {
      container = options.container;
      if (!document || !container) return api;
      container.innerHTML = '<button type="button" class="hs-launch" data-sessions-open>Sessions</button>';
      dialog = document.createElement("dialog"); dialog.className = "hs-dialog";
      dialog.setAttribute("aria-labelledby", "hs-heading");
      dialog.innerHTML = `<div class="hs-heading"><h2 id="hs-heading">Saved sessions</h2><button type="button" data-close aria-label="Close saved sessions">×</button></div>
        <div class="hs-body"><label for="hs-name">Version name</label><div class="hs-new"><input id="hs-name" maxlength="80" placeholder="e.g. Gentle movement" autocomplete="off"><button type="button" id="hs-save" class="hs-primary">Save new version</button></div>
        <p class="hs-help">Save new version keeps a separate copy. Update selected replaces that version with your current setup.</p>
        <label for="hs-versions">Saved versions</label><select id="hs-versions" size="5" aria-describedby="hs-details"></select><p id="hs-details" class="hs-detail"></p><p id="hs-audio-list" class="hs-audio-list" hidden></p>
        <div class="hs-actions"><button type="button" id="hs-load" class="hs-primary" data-needs-selection>Load</button><button type="button" id="hs-update" data-needs-selection>Update selected</button><button type="button" id="hs-rename" data-needs-selection>Rename</button><button type="button" id="hs-delete" data-needs-selection>Delete</button></div>
        <p id="hs-notice" class="hs-notice" role="status" aria-live="polite" hidden></p>
        <div class="hs-portable"><button type="button" id="hs-export" data-needs-selection>Export selected</button><button type="button" id="hs-export-all">Export all</button><button type="button" id="hs-import">Open file…</button><input type="file" id="hs-file" accept=".zip,.json,application/zip,application/json" hidden></div>
        <p class="hs-note">Saves include your settings and the audio used by them, including uploaded files and completed stems. Export a ZIP to take them to another laptop. Movement recordings stay on this laptop. Loading stops playback; press Play when ready.</p></div>`;
      document.body.append(dialog);
      container.querySelector("[data-sessions-open]").addEventListener("click", open);
      dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
      dialog.addEventListener("close", () => returnFocus?.focus());
      // Keep Space/Escape and musical shortcuts inside the dialog.
      dialog.addEventListener("keydown", (event) => event.stopPropagation());
      $("versions").addEventListener("change", () => { rememberSelection($("versions").value); $("name").value = findSession(selectedId).name; refresh(); notice(); });
      const syncName = (session) => { $("name").value = session.name; return `“${session.name}” saved${session.assets ? " with audio" : ""}.`; };
      $("save").addEventListener("click", () => action(() => save($("name").value.trim() || undefined), syncName, "Saving settings and audio…"));
      $("name").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("save").click(); } });
      $("update").addEventListener("click", () => action(() => update(selectedId), syncName, "Updating settings and audio…"));
      $("load").addEventListener("click", () => action(() => load(selectedId), "Version loaded. Press Play when ready.", "Restoring saved audio and settings…"));
      $("rename").addEventListener("click", () => action(() => rename(selectedId, $("name").value), (session) => `Renamed to “${session.name}”.`));
      $("delete").addEventListener("click", () => action(() => { remove(selectedId); $("name").value = selectedId ? findSession(selectedId).name : suggestedName(); }, "Version deleted."));
      $("export").addEventListener("click", () => action(() => download(selectedId), "Version exported with audio.", "Packing settings and audio into a ZIP…"));
      $("export-all").addEventListener("click", () => action(() => download(), "Sessions exported with audio.", "Packing saved versions and audio into a ZIP…"));
      $("import").addEventListener("click", () => $("file").click());
      $("file").addEventListener("change", () => {
        const file = $("file").files?.[0]; $("file").value = "";
        if (file) action(async () => { const imported = await importFile(file, true); $("name").value = imported[0].name; return imported; },
          (imported) => imported.length === 1 ? "Version loaded. Press Play when ready." : `${imported.length} versions imported. Select one and press Load.`, "Opening settings and audio…");
      });
      return api;
    }
    const api = { init, open, save, update, load, rename, remove, exportJSON, importJSON, exportArchive, importFile, suggestedName, list: () => copy(readLibrary().sessions), get selectedId() { return selectedId; } };
    return api;
  }
  let singleton;
  const api = { KEY, ACTIVE_KEY, KEYS, create, validateSession, parseLibrary, networkAssets,
    init(options) { singleton = create({ assets: networkAssets(), ...options }); singleton.init(); return singleton; },
    open() { singleton?.open(); }
  };
  return api;
})();
