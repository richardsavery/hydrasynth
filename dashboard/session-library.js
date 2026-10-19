"use strict";

// Named snapshots of dashboard preferences. Audio, credentials and running jobs
// are deliberately outside this format.
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
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const bytes = (value) => typeof TextEncoder === "function" ? new TextEncoder().encode(value).length : value.length * 2;
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
    if (Object.keys(value).some((key) => !["schema", "id", "name", "createdAt", "updatedAt", "route", "storage", "extras"].includes(key))) fail("This session contains unsupported fields.");
    if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9_-]{5,79}$/i.test(value.id)) fail("This session has an invalid identifier.");
    nameOf(value.name);
    for (const key of ["createdAt", "updatedAt"]) {
      if (typeof value[key] !== "string" || value[key].length > 32 || !Number.isFinite(Date.parse(value[key]))) fail("This session has an invalid date.");
    }
    if (!ROUTES.has(value.route)) fail("This session uses an unsupported workspace.");
    validateStorage(value.storage);
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
      const session = { schema: 1, id: previous?.id || newId(), name, createdAt: previous?.createdAt || now(), updatedAt: now(), route: ROUTES.has(route) ? route : "#synth-mixer", storage: readStorage() };
      if (options.captureExtras) session.extras = await options.captureExtras();
      return validateSession(session);
    }
    function findSession(id, library = readLibrary()) {
      return library.sessions.find((session) => session.id === id) || fail("That saved version is no longer available.");
    }
    function rememberSelection(id) {
      selectedId = id;
      try { if (id) storage.setItem(ACTIVE_KEY, id); else storage.removeItem(ACTIVE_KEY); } catch (_) { /* The version itself remains saved. */ }
    }
    async function save(name) {
      const session = await capture(name);
      const library = readLibrary(); library.sessions.unshift(session); writeLibrary(library);
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
      if (await options.beforeRestore?.(copy(session)) === false) fail("Could not stop playback. Stop the players and try loading again.");
      const previous = readStorage(), previousSelection = storage.getItem(ACTIVE_KEY);
      try {
        replaceStorage(session.storage);
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
      const sessions = imported.sessions.map((session) => ({ ...session, id: newId() }));
      library.sessions.unshift(...sessions); writeLibrary(library); rememberSelection(sessions[0].id); refresh();
      return copy(sessions);
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
      $("details").textContent = selected ? `Saved ${new Date(selected.updatedAt).toLocaleString()}` : "";
      container.querySelector("[data-sessions-open]").title = `${sessions.length} saved version${sessions.length === 1 ? "" : "s"}`;
    }
    function download(id) {
      const text = exportJSON(id), session = id ? findSession(id) : null;
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = session ? `hydra-session-${session.name.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60)}.json` : "hydra-sessions.json";
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async function action(callback, message) {
      if (busy) return;
      busy = true; notice();
      for (const control of dialog.querySelectorAll("button:not([data-close]), input, select")) control.disabled = true;
      try { await callback(); notice(message); }
      catch (error) { notice(error.message || "This action could not be completed.", true); }
      finally {
        busy = false;
        for (const control of dialog.querySelectorAll("button, input, select")) control.disabled = false;
        try { refresh(); } catch (error) { notice(error.message, true); }
      }
    }
    function open() {
      if (!dialog) return;
      returnFocus = document.activeElement; notice();
      try { refresh(); } catch (error) { notice(error.message, true); }
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
        <label for="hs-versions">Saved versions</label><select id="hs-versions" size="5" aria-describedby="hs-details"></select><p id="hs-details" class="hs-detail"></p>
        <div class="hs-actions"><button type="button" id="hs-load" class="hs-primary" data-needs-selection>Load</button><button type="button" id="hs-update" data-needs-selection>Update selected</button><button type="button" id="hs-rename" data-needs-selection>Rename</button><button type="button" id="hs-delete" data-needs-selection>Delete</button></div>
        <p id="hs-notice" class="hs-notice" role="status" aria-live="polite" hidden></p>
        <div class="hs-portable"><button type="button" id="hs-export" data-needs-selection>Export selected</button><button type="button" id="hs-export-all">Export all</button><button type="button" id="hs-import">Import…</button><input type="file" id="hs-file" accept=".json,application/json" hidden></div>
        <p class="hs-note">Sessions include both mixers, signal mixes and connections. Audio and recordings are referenced, not included. Loading stops playback.</p></div>`;
      document.body.append(dialog);
      container.querySelector("[data-sessions-open]").addEventListener("click", open);
      dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
      dialog.addEventListener("close", () => returnFocus?.focus());
      // Keep Space/Escape and musical shortcuts inside the dialog.
      dialog.addEventListener("keydown", (event) => event.stopPropagation());
      $("versions").addEventListener("change", () => { rememberSelection($("versions").value); $("name").value = findSession(selectedId).name; refresh(); notice(); });
      $("save").addEventListener("click", () => action(() => save($("name").value), "New version saved."));
      $("update").addEventListener("click", () => action(() => update(selectedId), "Selected version updated."));
      $("load").addEventListener("click", () => action(() => load(selectedId), "Version loaded."));
      $("rename").addEventListener("click", () => action(() => rename(selectedId, $("name").value), "Version renamed."));
      $("delete").addEventListener("click", () => action(() => remove(selectedId), "Version deleted."));
      $("export").addEventListener("click", () => action(() => download(selectedId), "Version exported."));
      $("export-all").addEventListener("click", () => action(() => download(), "Sessions exported."));
      $("import").addEventListener("click", () => $("file").click());
      $("file").addEventListener("change", () => {
        const file = $("file").files?.[0]; $("file").value = "";
        if (file) action(async () => { if (file.size > MAX_BYTES) fail("Choose a sessions file smaller than 4 MB."); await importJSON(await file.text()); }, "Versions imported. Select one and Load to use it.");
      });
      return api;
    }
    const api = { init, open, save, update, load, rename, remove, exportJSON, importJSON, list: () => copy(readLibrary().sessions), get selectedId() { return selectedId; } };
    return api;
  }
  let singleton;
  const api = { KEY, ACTIVE_KEY, KEYS, create, validateSession, parseLibrary,
    init(options) { singleton = create(options); singleton.init(); return singleton; },
    open() { singleton?.open(); }
  };
  return api;
})();
