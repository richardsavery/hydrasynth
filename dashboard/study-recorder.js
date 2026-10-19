/* Local study capture. Commit to IndexedDB before sending; remove only acknowledged records. */
(function (root) {
  "use strict";

  const SESSION_KEY = "hydra.study.session.v1";
  const SENSITIVE_KEY = /(?:password|passwd|secret|credential|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token)/i;

  function clean(value, seen = new WeakSet()) {
    if (value === undefined) return null;
    if (value === null || typeof value !== "object") return typeof value === "function" ? undefined : value;
    if (seen.has(value)) return "[circular reference]";
    seen.add(value);
    const result = Array.isArray(value) ? value.map(item => clean(item, seen)) : Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEY.test(key)).map(([key, item]) => [key, clean(item, seen)]));
    seen.delete(value);
    return result;
  }

  function deeplyNested(value, depth = 0) {
    if (!value || typeof value !== "object") return false;
    return depth > 30 || Object.values(value).some(item => deeplyNested(item, depth + 1));
  }

  // Mapping configurations are already normalized by their workspace. Keep every
  // field, sort object keys only for comparison, and preserve array order.
  function mappingJSON(value, configuredValuesOnly = false) {
    return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ?
      Object.fromEntries(Object.keys(item).filter(key => !configuredValuesOnly ||
        !["learnedMin", "learnedMax", "awaitingBounds"].includes(key) && !(item.rangeMode === "auto" && ["inputMin", "inputMax"].includes(key)))
        .sort().map(key => [key, item[key]])) : item);
  }

  function createMappingTracker(recorder, workspace) {
    let revision = null, configurationJSON = null, configurationIdentity = null, revisionContext = null, playing = null;
    const contextKey = context => mappingJSON([context.session_id, context.client_id]);
    const clone = value => JSON.parse(JSON.stringify(value));

    function failure(operation, error) {
      try { recorder.emit("recording.mapping_error", { workspace, operation, message: String(error?.message || error) }); }
      catch (_) { /* Study capture must never interrupt participant interaction. */ }
    }
    function current() {
      try {
        if (!revision || revisionContext !== contextKey(recorder.getContext())) return null;
        return { workspace, revision_id: revision.revision_id, previous_revision_id: revision.previous_revision_id,
          session_id: revision.session_id, client_id: revision.client_id };
      }
      catch (_) { return null; }
    }
    function sendPlayback(details, context) {
      const key = contextKey(context), running = details.running === true;
      const previous = playing?.context_key === key ? playing : null;
      // An idle refresh is not evidence that a mapping was played.
      if (!running && !previous?.running) return;
      if (!revision || revisionContext !== key) return;
      const metadata = clone(details), comparison = { ...metadata };
      for (const field of ["running", "reason", "action", "force"]) delete comparison[field];
      const signature = mappingJSON(comparison);
      if (previous && previous.running === running && previous.revision_id === revision.revision_id && previous.signature === signature && !details.force) return;
      const phase = !running ? "stop" : !previous?.running ? "start" :
        previous.revision_id !== revision.revision_id ? "configuration_change" : "context_change";
      const eventId = recorder.emit("mapping.playback", { ...metadata, ...context, workspace,
        revision_id: revision.revision_id, previous_revision_id: previous?.revision_id || null, running, phase });
      if (!eventId) throw new Error("Mapping playback was not accepted by the recorder");
      const retainedDetails = { ...metadata }; delete retainedDetails.force;
      playing = { context_key: key, running, revision_id: revision.revision_id, signature, details: retainedDetails };
    }
    function captureWithinContext(config, details, context, associatePlayback) {
      const serialized = mappingJSON(config);
      if (serialized === undefined) throw new Error("Mapping configuration must be JSON serializable");
      const key = contextKey(context), identity = mappingJSON(JSON.parse(serialized), true);
      // Live range learning is runtime state, not a new participant choice. Keep
      // its values in every emitted full configuration, but exclude learned
      // bounds, awaitingBounds, and inputMin/inputMax only when rangeMode=auto
      // from equality. Explicit freeze/relearn actions use force.
      if (revision && revisionContext === key && configurationIdentity === identity && !details.force) {
        if (associatePlayback && playing?.context_key === key && playing.running) sendPlayback(playing.details, context);
        return;
      }
      const next = { ...clone(details), ...context, workspace, revision_id: root.crypto.randomUUID(),
        previous_revision_id: revisionContext === key ? revision?.revision_id || null : null,
        identity_policy: "configured-values-v1", config: JSON.parse(serialized) };
      const eventId = recorder.emit("mapping.configuration", next);
      if (!eventId) throw new Error("Mapping configuration was not accepted by the recorder");
      // Only advance after emit accepts the immutable event into its durable outbox
      // pipeline (which retains pending writes in memory if browser storage fails).
      revision = clone(next); configurationJSON = serialized; configurationIdentity = identity; revisionContext = key;
      if (associatePlayback && playing?.context_key === key && playing.running) sendPlayback(playing.details, context);
    }
    function capture(config, details = {}) {
      try { captureWithinContext(config, details, { ...recorder.getContext() }, true); }
      catch (error) { failure("capture", error); }
      return current();
    }
    function playback(config, details = {}) {
      try {
        const context = { ...recorder.getContext() }, key = contextKey(context);
        if (config !== null && config !== undefined) captureWithinContext(config, { reason: "playback_configuration" }, context, false);
        else if (revision && revisionContext !== key) {
          // A participant handover starts a new chain even if the workspace has
          // not changed. The full prior configuration establishes their baseline.
          captureWithinContext(JSON.parse(configurationJSON), { reason: "participant_baseline" }, context, false);
        }
        sendPlayback(details, context);
      } catch (error) { failure("playback", error); }
      return current();
    }
    return { capture, playback, current };
  }

  function createIndexedDBQueue(indexedDB) {
    let opening;
    function open() {
      if (!opening) opening = new Promise((resolve, reject) => {
        if (!indexedDB) { reject(new Error("IndexedDB is unavailable")); return; }
        const request = indexedDB.open("hydra-study-outbox", 2);
        request.onupgradeneeded = () => {
          const store = request.result.objectStoreNames.contains("outbox") ? request.transaction.objectStore("outbox") :
            request.result.createObjectStore("outbox", { keyPath: "queue_id", autoIncrement: true });
          if (!store.indexNames.contains("rejected")) store.createIndex("rejected", "rejected");
        };
        request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); opening = null; }; resolve(request.result); };
        request.onerror = () => reject(request.error || new Error("Cannot open study storage"));
        request.onblocked = () => reject(new Error("Study storage is blocked by another browser tab"));
      }).catch(error => { opening = null; throw error; });
      return opening;
    }
    async function transaction(mode, operation) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("outbox", mode);
        const request = operation(tx.objectStore("outbox"));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = tx.onabort = () => reject(tx.error || request?.error || new Error("Study storage transaction failed"));
      });
    }
    return {
      put: record => transaction("readwrite", store => store.add(record)),
      first: (limit = 40, excluded = new Set()) => transaction("readonly", store => {
        if (!excluded.size) return store.getAll(undefined, limit);
        const selected = [], cursor = store.openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current) return;
          if (!excluded.has(current.key)) selected.push(current.value);
          if (selected.length < limit) current.continue();
        };
        return { get result() { return selected; } };
      }),
      update: record => transaction("readwrite", store => store.put(record)),
      rejections: () => transaction("readonly", store => store.index("rejected").getAll()),
      count: () => transaction("readonly", store => store.count()),
      remove: ids => transaction("readwrite", store => { ids.forEach(id => store.delete(id)); })
    };
  }

  function createRecorder(options) {
    const queue = options.queue, fetch = options.fetch, uuid = options.uuid;
    const now = options.now || (() => new Date().toISOString());
    const monotonic = options.monotonic || (() => performance.now());
    const started = monotonic(), clientId = uuid();
    let session, sequence = 0, writeChain = Promise.resolve(), activeFlush = null, pendingMemory = [];
    let serverAvailable = false, storageError = "", networkError = "", backendHealthError = "", inFlight = false, pendingCount = 0, deviceId = null, backup = null;
    const rejectedRecords = new Map(), rejectedUntil = new Map();
    try { session = JSON.parse(options.sessionStorage?.getItem(SESSION_KEY) || "null"); } catch (_) { /* A new session is safer than invalid context. */ }
    if (!session || !/^[A-Za-z0-9_-]{1,100}$/.test(session.session_id || "")) session = { session_id: uuid(), participant_code: "" };

    function rememberSession() {
      try { options.sessionStorage?.setItem(SESSION_KEY, JSON.stringify(session)); }
      catch (_) { emit("recording.session_storage_unavailable", { consequence: "Reload will start a new session" }); }
    }
    function state() {
      return { session_id: session.session_id, participant_code: session.participant_code || "", client_id: clientId,
        device_id: deviceId, pending: pendingCount + pendingMemory.length, memory_pending: pendingMemory.length,
        saving: inFlight, server_available: serverAvailable, storage_error: storageError, network_error: networkError, backend_health_error: backendHealthError,
        rejected_count: rejectedRecords.size, rejected_error: rejectedRecords.values().next().value || "", backup };
    }
    function notify() { options.onState?.(state()); }
    function persist(record) {
      // Keep the original record in memory until the transaction has committed.
      pendingMemory.push(record); notify();
      const operation = writeChain.then(async () => {
        while (pendingMemory.length) {
          const first = pendingMemory[0];
          await queue.put(first);
          pendingMemory.shift(); pendingCount++;
        }
        storageError = ""; notify();
      }).catch(error => { storageError = String(error.message || error); notify(); throw error; });
      writeChain = operation.catch(() => {});
      return operation;
    }
    function emit(type, payload = {}) {
      const value = clean(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : { value: payload });
      const event = { event_id: uuid(), session_id: value?.session_id || session.session_id,
        client_id: value?.client_id || clientId, sequence: ++sequence,
        occurred_at: now(), elapsed_ms: Math.round(monotonic() - started), type: String(type), payload: value };
      const serialized = JSON.stringify(event), byteLength = new TextEncoder().encode(serialized).length;
      if (byteLength > 750000 || deeplyNested(value)) {
        // A single oversized snapshot must not block every later record. Preserve its complete
        // envelope as ordered JSON fragments; joining the fragments reconstructs the original event.
        const chunkSize = 120000, fragments = [];
        for (let offset = 0; offset < serialized.length;) {
          let end = Math.min(offset + chunkSize, serialized.length);
          // Python's UTF-8 JSON storage rejects a lone surrogate; never split an emoji pair.
          if (end < serialized.length && /[\uD800-\uDBFF]/.test(serialized[end - 1]) && /[\uDC00-\uDFFF]/.test(serialized[end])) end--;
          fragments.push(serialized.slice(offset, end)); offset = end;
        }
        for (let index = 0; index < fragments.length; index++) {
          const chunk = { ...event, event_id: uuid(), sequence: ++sequence, type: "recording.event_chunk",
            payload: { logical_event_id: event.event_id, original_type: event.type, chunk_index: index, chunk_count: fragments.length,
              original_byte_length: byteLength, json_fragment: fragments[index] } };
          persist({ kind: "event", data: chunk }).catch(() => {});
        }
      } else persist({ kind: "event", data: event }).catch(() => {});
      return event.event_id;
    }
    async function storeAudio(audio, metadata = {}) {
      const context = { session_id: metadata.session_id || session.session_id, client_id: metadata.client_id || clientId };
      const mediaId = uuid();
      const blob = audio instanceof Blob ? audio : new Blob([audio], { type: metadata.mime_type || metadata.content_type || "audio/wav" });
      const details = clean({ ...metadata, ...context, mime_type: metadata.mime_type || metadata.content_type || blob.type || "audio/wav",
        byte_length: blob.size, occurred_at: now() });
      await persist({ kind: "media", data: { media_id: mediaId, session_id: context.session_id, metadata: details }, audio: blob });
      emit("recording.audio_queued", { ...context, media_id: mediaId, metadata: details });
      void flush();
      return mediaId;
    }
    function newSession(participantCode = "") {
      const code = String(participantCode).trim();
      if (code.length > 100 || /[\u0000-\u001f]/.test(code)) throw new Error("Use a participant code of at most 100 characters");
      emit("session.end", { reason: "new_participant" });
      session = { session_id: uuid(), participant_code: code };
      persist({ kind: "session", data: { ...session } }).catch(() => {});
      rememberSession();
      emit("session.start", { participant_code: code });
      notify(); void flush();
      return { ...session, client_id: clientId };
    }
    async function status() {
      try {
        const response = await fetchWithTimeout("/api/study/status", { cache: "no-store" });
        if (!response.ok) throw new Error(`Study storage returned HTTP ${response.status}`);
        const result = await response.json();
        deviceId = result.device_id; serverAvailable = true; networkError = "";
        backendHealthError = result.ready === false || result.last_error ? String(result.last_error || "Study storage is not ready") : "";
        backup = result.backup && typeof result.backup === "object" ? clean(result.backup) : null;
      } catch (error) { serverAvailable = false; networkError = String(error.message || error); }
      notify(); return state();
    }
    async function fetchWithTimeout(url, init, timeout = 15000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try { return await fetch(url, { ...init, signal: controller.signal }); }
      finally { clearTimeout(timer); }
    }
    async function post(path, body, keepalive) {
      const encoded = JSON.stringify(body);
      const response = await fetchWithTimeout(`/api/study/${path}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: encoded, keepalive: Boolean(keepalive && new TextEncoder().encode(encoded).length < 48000) }, path === "media" ? 60000 : 15000);
      if (!response.ok) {
        let message = `Study ${path} returned HTTP ${response.status}`;
        try { message = (await response.json()).error || message; } catch (_) {}
        const error = new Error(message); error.status = response.status; throw error;
      }
      return response.json();
    }
    async function flush(options = {}) {
      if (activeFlush) return activeFlush;
      activeFlush = (async () => {
        inFlight = true; notify();
        try {
          await writeChain;
          if (pendingMemory.length) {
            const operation = writeChain.then(async () => {
              while (pendingMemory.length) { await queue.put(pendingMemory[0]); pendingMemory.shift(); pendingCount++; }
              storageError = "";
            });
            writeChain = operation.catch(error => { storageError = String(error.message || error); });
            await operation;
          }
          const rejectedThisFlush = new Set([...rejectedUntil].filter(([, until]) => until > Date.now()).map(([id]) => id));
          while (true) {
            const rows = await queue.first(40, rejectedThisFlush);
            if (!rows.length) break;
            const first = rows[0];
            let acknowledged = [];
            if (first.kind === "session") {
              const result = await post("sessions", first.data, options.keepalive);
              if ((result.session_id || result.session?.session_id) !== first.data.session_id) throw new Error("Study session was not acknowledged");
              acknowledged = [first.queue_id];
            } else if (first.kind === "event") {
              const batch = [], limit = options.keepalive ? 44000 : 192000; let bytes = 0;
              for (const row of rows) {
                if (row.kind !== "event") break;
                const size = new TextEncoder().encode(JSON.stringify(row.data)).length;
                if (batch.length && bytes + size > limit) break;
                batch.push(row); bytes += size;
              }
              const result = await post("events", { events: batch.map(row => row.data) }, options.keepalive);
              const ids = new Set(result.acknowledged_event_ids || []);
              acknowledged = batch.filter(row => ids.has(row.data.event_id)).map(row => row.queue_id);
              if (!acknowledged.length) throw new Error("Study events were not acknowledged");
            } else if (first.kind === "media") {
              // Large audio cannot be reliably sent with keepalive; the durable queue survives closing the page.
              if (options.keepalive) break;
              const bytes = new Uint8Array(await first.audio.arrayBuffer());
              let binary = "";
              for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
              let result;
              try { result = await post("media", { ...first.data, audio_base64: btoa(binary) }, false); }
              catch (error) {
                if (![400, 409, 413, 415, 422].includes(error.status)) throw error;
                // A malformed/oversized clip must not hold later interface events hostage.
                // Keep its bytes and rejection durably; retry it on the next flush.
                first.rejected = 1; first.rejected_error = String(error.message || error); first.retry_after = Date.now() + 60000;
                await queue.update(first);
                rejectedRecords.set(first.queue_id, first.rejected_error); rejectedUntil.set(first.queue_id, first.retry_after); rejectedThisFlush.add(first.queue_id);
                notify(); continue;
              }
              if (result.acknowledged_media_id !== first.data.media_id) throw new Error("Study audio was not acknowledged");
              acknowledged = [first.queue_id];
            } else { throw new Error("Unknown study outbox record; retained for recovery"); }
            await queue.remove(acknowledged);
            acknowledged.forEach(id => { rejectedRecords.delete(id); rejectedUntil.delete(id); });
            pendingCount = await queue.count(); serverAvailable = true; networkError = ""; notify();
            if (options.keepalive) break;
          }
        } catch (error) {
          serverAvailable = false; networkError = String(error.message || error);
        } finally { inFlight = false; activeFlush = null; notify(); }
        return state();
      })();
      return activeFlush;
    }

    const ready = Promise.all([queue.count(), queue.rejections()]).then(([count, rejected]) => {
      pendingCount = count; rejected.forEach(row => { rejectedRecords.set(row.queue_id, row.rejected_error); rejectedUntil.set(row.queue_id, row.retry_after || 0); }); notify();
    }).catch(error => { storageError = String(error.message || error); notify(); });
    // Count old records before appending, so pending counts remain accurate after a reload.
    writeChain = ready;
    persist({ kind: "session", data: { ...session } }).catch(() => {});
    rememberSession();
    emit("client.open", { user_agent: options.userAgent || "", page: options.page || "", participant_code: session.participant_code || "" });
    return { emit, storeAudio, newSession, flush, status, ready,
      getContext: () => ({ session_id: session.session_id, client_id: clientId }), getState: state,
      whenPersisted: () => writeChain };
  }

  function controlValue(element) {
    if (!element || element.type === "password" || SENSITIVE_KEY.test(`${element.id || ""} ${element.name || ""}`)) return "[excluded credential field]";
    if (element.type === "checkbox" || element.type === "radio") return Boolean(element.checked);
    if (element.type === "file") return Array.from(element.files || []).map(file => ({ name: file.name, size: file.size, type: file.type }));
    if (element.tagName === "SUMMARY") return Boolean(element.closest?.("details")?.open);
    if (element.tagName === "SELECT" && element.multiple) return Array.from(element.selectedOptions || []).map(option => option.value);
    if ("value" in element) return element.value;
    if (element.isContentEditable) return element.textContent;
    return element.getAttribute?.("aria-pressed") ?? null;
  }

  function controlDescription(element) {
    const labels = Array.from(element.labels || []).map(label => label.textContent.trim());
    let path = "", parent = element;
    for (let i = 0; parent && i < 5; i++, parent = parent.parentElement) {
      const segment = parent.id ? `#${parent.id}` : `${parent.tagName?.toLowerCase() || "element"}:nth-child(${Array.prototype.indexOf.call(parent.parentElement?.children || [], parent) + 1})`;
      path = `${segment}${path ? ` ${path}` : ""}`;
      if (parent.id) break;
    }
    const mappingContext = {}, mappingFields = { mappingId: "mapping_id", bus: "bus", channel: "channel", source: "source", route: "route", parameter: "parameter" };
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      for (const [dataKey, field] of Object.entries(mappingFields)) {
        if (!(field in mappingContext) && ancestor.dataset?.[dataKey] !== undefined) mappingContext[field] = ancestor.dataset[dataKey];
      }
    }
    return { id: element.id || null, name: element.name || null, tag: element.tagName?.toLowerCase(), type: element.type || null,
      data: clean({ ...element.dataset }), mapping_context: mappingContext, path, label: element.getAttribute?.("aria-label") || labels.join(" ") ||
        (["BUTTON", "A", "SUMMARY"].includes(element.tagName) ? element.textContent?.trim() : "") || null };
  }

  function installBrowser(root) {
    const document = root.document;
    if (!document || !root.fetch) return;
    const rawFetch = root.fetch.bind(root), previous = new WeakMap();
    let parentRecorder = null;
    try {
      if (root.parent && root.parent !== root && root.parent.location.origin === root.location.origin && root.parent.HydraStudy?.getContext) {
        parentRecorder = root.parent.HydraStudy;
      }
    } catch (_) { /* A cross-origin parent cannot share its recorder. */ }
    // A presentation mode for researcher controls, not an authentication boundary.
    // All recording runs in both modes; participant sessions never need to opt in here.
    const researcherMode = !parentRecorder && new URL(root.location.href).searchParams.get("researcher") === "1";
    let snapshotTimer = null, recorder;
    const $ = id => document.getElementById(id);
    function render(state) {
      const target = $("study-status");
      const backup = state.backup, backupError = backup?.enabled && backup.last_error ? String(backup.last_error) : "";
      if (target) {
        const text = state.storage_error || state.backend_health_error || state.rejected_count ? "Recording error" : state.pending ? (state.server_available ? "Saving…" : `${state.pending} pending`) : state.server_available ? "Saved locally" : "Connecting…";
        target.textContent = backupError ? `${text} · backup error` : text; target.dataset.state = state.storage_error || state.backend_health_error || state.rejected_count || backupError ? "error" : state.pending || !state.server_available ? "pending" : "saved";
        target.title = state.storage_error ? `Browser storage failed: ${state.storage_error}. Keep this tab open; ${state.memory_pending} records are only in memory.` :
          state.backend_health_error ? `Local study storage reported an error: ${state.backend_health_error}` :
          state.rejected_count ? `${state.rejected_count} recording(s) could not be archived: ${state.rejected_error}. Original bytes remain in this browser; other interactions are still saved.` :
          state.network_error ? `Waiting for local study storage: ${state.network_error}. Pending records are retained in this browser.` : "Recorded on this laptop. Export each laptop's study data for analysis.";
      }
      if ($("study-device")) $("study-device").textContent = state.device_id || "Connecting to local storage";
      if ($("study-session")) $("study-session").textContent = state.participant_code || `Session ${state.session_id.slice(0, 8)}`;
      if ($("study-warning")) { $("study-warning").textContent = state.storage_error || state.rejected_count ? target?.title || state.storage_error || state.rejected_error : state.backend_health_error || state.network_error || ""; $("study-warning").hidden = !state.storage_error && !state.backend_health_error && !state.rejected_count && !state.network_error; }
      if ($("study-backup-status")) {
        const completed = backup?.last_completed_at ? new Date(backup.last_completed_at) : null;
        const date = completed && Number.isFinite(completed.getTime()) ? completed.toLocaleString() : backup?.last_completed_at;
        $("study-backup-status").textContent = !backup ? "Automatic backups unavailable" : !backup.enabled ? "Automatic backups disabled" :
          backup.state === "writing" ? `Writing backup…${date ? ` Last backup: ${date}` : ""}` :
          date ? `Backup written ${date}` : "Waiting for first automatic backup";
      }
      if ($("study-backup-path")) $("study-backup-path").textContent = backup?.destination || "";
      if ($("study-backup-warning")) {
        $("study-backup-warning").textContent = backupError ? `Automatic backup failed: ${backupError}. Check the backup destination or collect a manual export.` : "";
        $("study-backup-warning").hidden = !backupError;
      }
    }
    if (parentRecorder) {
      // The embedded Observer shares its parent's outbox and participant context.
      // Resolve that context per operation so a handover also updates this frame.
      const frameDetails = () => ({ frame_path: root.location.pathname, source_page: root.location.pathname + root.location.hash });
      recorder = { ...parentRecorder,
        emit(type, payload = {}) { return parentRecorder.emit(type, { ...payload, ...frameDetails() }); },
        storeAudio(audio, metadata = {}) { return parentRecorder.storeAudio(audio, { ...metadata, ...frameDetails() }); },
        getContext: () => parentRecorder.getContext(), getState: () => parentRecorder.getState()
      };
    } else {
      let sessionStorage;
      try { sessionStorage = root.sessionStorage; } catch (_) { /* The recorder reports unavailable session persistence. */ }
      recorder = createRecorder({ queue: createIndexedDBQueue(root.indexedDB), fetch: rawFetch,
        uuid: () => root.crypto.randomUUID(), sessionStorage, onState: render,
        userAgent: root.navigator.userAgent, page: root.location.pathname + root.location.hash });
    }

    function snapshot(reason) {
      const settings = {};
      try {
        for (let index = 0; index < root.localStorage.length; index++) {
          const key = root.localStorage.key(index);
          if (!/^hydra[.-]/.test(key) || SENSITIVE_KEY.test(key)) continue;
          let value = root.localStorage.getItem(key); try { value = JSON.parse(value); } catch (_) { /* Preserve plain string settings. */ }
          settings[key] = clean(value);
        }
      } catch (error) { recorder.emit("recording.snapshot_error", { message: String(error.message || error) }); }
      const controls = Array.from(document.querySelectorAll("input, select, textarea, [contenteditable=true]"))
        .filter(element => !element.closest("[data-study-ui]"))
        .map(element => ({ control: controlDescription(element), value: clean(controlValue(element)), disabled: element.disabled, hidden: element.hidden }));
      return recorder.emit("settings.snapshot", { reason, workspace: document.body?.dataset.workspace || null, settings, controls,
        viewport: { width: root.innerWidth, height: root.innerHeight }, language: root.navigator.language });
    }
    root.HydraStudy = { ...recorder, snapshot, createMappingTracker: workspace => createMappingTracker(recorder, workspace),
      newSession(code) { const context = recorder.newSession(code); snapshot("new_participant"); return context; } };

    root.fetch = function (input, init = {}) {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, root.location.href);
      if (url.origin === root.location.origin && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/study/")) {
        const headers = new Headers(init.headers || (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined));
        const context = recorder.getContext();
        if (!headers.has("X-Study-Session")) headers.set("X-Study-Session", context.session_id);
        if (!headers.has("X-Study-Client")) headers.set("X-Study-Client", context.client_id);
        init = { ...init, headers };
      }
      return rawFetch(input, init);
    };
    const selector = "input, select, textarea, button, a, summary, [role=button], [contenteditable=true]";
    function elementOf(event) { const element = event.target?.closest?.(selector); return element && !element.closest("[data-study-ui]") ? element : null; }
    function remember(event) { const element = elementOf(event); if (element) previous.set(element, clean(controlValue(element))); }
    for (const name of ["focusin", "pointerdown", "keydown"]) document.addEventListener(name, remember, true);
    for (const name of ["click", "input", "change", "submit"]) document.addEventListener(name, event => {
      if (!event.isTrusted || event.target?.closest?.("[data-study-ui]")) return;
      const target = event.target?.tagName ? event.target : event.target?.parentElement;
      const element = elementOf(event) || (["submit", "click"].includes(name) ? target : null);
      if (!element) return;
      const value = clean(controlValue(element)), before = previous.has(element) ? previous.get(element) : null;
      recorder.emit(`ui.${name}`, { control: controlDescription(element), previous_value: before, value,
        previous_value_known: previous.has(element), workspace: document.body?.dataset.workspace || null,
        ...(name === "click" ? { button: event.button, pointer_type: event.pointerType || "", x: event.clientX, y: event.clientY,
          page_x: Number.isFinite(event.pageX) ? event.pageX : (event.clientX || 0) + (root.scrollX || 0),
          page_y: Number.isFinite(event.pageY) ? event.pageY : (event.clientY || 0) + (root.scrollY || 0),
          scroll_x: root.scrollX || 0, scroll_y: root.scrollY || 0, viewport: { width: root.innerWidth, height: root.innerHeight } } : {}),
        ...(name === "input" ? { input_type: event.inputType || null } : {}) });
      // A checkbox is already toggled at click dispatch. Keep its pre-click value until input.
      if (name !== "click") previous.set(element, value);
      if (name === "change") { root.clearTimeout(snapshotTimer); snapshotTimer = root.setTimeout(() => snapshot("interface_change"), 100); }
    }, true);
    document.addEventListener("toggle", event => {
      if (event.target?.tagName !== "DETAILS" || event.target.closest?.("[data-study-ui]")) return;
      recorder.emit("ui.disclosure", { control: controlDescription(event.target), open: Boolean(event.target.open),
        trusted: Boolean(event.isTrusted), workspace: document.body?.dataset.workspace || null });
    }, true);
    document.addEventListener("keydown", event => {
      if (!event.isTrusted || event.target?.closest?.("[data-study-ui]")) return;
      const typing = event.target?.closest?.("input, textarea, [contenteditable=true]");
      if (typing && !event.ctrlKey && !event.metaKey && !["Escape", "Enter", "Tab"].includes(event.key)) return;
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && typing) return;
      recorder.emit("ui.shortcut", { key: event.key, code: event.code, alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey,
        control: elementOf(event) ? controlDescription(elementOf(event)) : null });
    }, true);
    for (const name of ["play", "pause", "ended", "seeking", "seeked", "volumechange", "error"]) document.addEventListener(name, event => {
      const media = event.target;
      if (!["AUDIO", "VIDEO"].includes(media?.tagName)) return;
      let source = media.currentSrc || media.src || "";
      try { const url = new URL(source, root.location.href); source = url.origin === root.location.origin ? url.pathname : `${url.origin}${url.pathname}`; } catch (_) {}
      recorder.emit(`media.${name}`, { control: controlDescription(media), source, time: media.currentTime, duration: Number.isFinite(media.duration) ? media.duration : null,
        volume: media.volume, muted: media.muted, rate: media.playbackRate, error: media.error?.message || null });
    }, true);
    function navigation(reason) { recorder.emit("navigation", { reason, path: root.location.pathname, hash: root.location.hash, workspace: document.body?.dataset.workspace || null }); }
    for (const method of ["pushState", "replaceState"]) {
      const original = root.history[method].bind(root.history);
      root.history[method] = function (...args) { const result = original(...args); navigation(method); return result; };
    }
    for (const name of ["hashchange", "popstate"]) root.addEventListener(name, () => navigation(name));
    for (const name of ["focus", "blur"]) root.addEventListener(name, () => recorder.emit(`client.${name}`, { frame_path: root.location.pathname }));
    root.addEventListener("error", event => recorder.emit("client.error", { message: event.message, filename: event.filename, line: event.lineno, column: event.colno, stack: event.error?.stack || null }));
    root.addEventListener("unhandledrejection", event => recorder.emit("client.unhandled_rejection", { message: String(event.reason?.message || event.reason), stack: event.reason?.stack || null }));
    root.addEventListener("online", () => { recorder.emit("client.online", {}); if (!parentRecorder) void recorder.status().then(() => recorder.flush()); });
    root.addEventListener("offline", () => recorder.emit("client.offline", {}));
    document.addEventListener("visibilitychange", () => { recorder.emit("client.visibility", { visibility: document.visibilityState }); if (document.hidden) void recorder.flush({ keepalive: true }); });
    root.addEventListener("pagehide", event => { recorder.emit("client.pagehide", { persisted: event.persisted }); void recorder.flush({ keepalive: true }); });

    function initialize() {
      if ($("study-panel")) $("study-panel").hidden = !researcherMode;
      document.querySelectorAll(selector).forEach(element => previous.set(element, clean(controlValue(element))));
      if (root.MutationObserver) new root.MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node.matches?.(selector)) previous.set(node, clean(controlValue(node)));
          node.querySelectorAll?.(selector).forEach(element => previous.set(element, clean(controlValue(element))));
        }
      }).observe(document.body, { childList: true, subtree: true });
      if (researcherMode) $("study-new-session")?.addEventListener("click", () => {
        try { root.HydraStudy.newSession($("study-participant").value); $("study-participant").value = ""; }
        catch (error) { $("study-warning").textContent = error.message; $("study-warning").hidden = false; }
      });
      if (researcherMode) $("study-export")?.addEventListener("click", async event => {
        event.preventDefault();
        recorder.emit("study.export_requested", {});
        await recorder.flush();
        const current = recorder.getState();
        if (current.pending || current.storage_error || current.backend_health_error || !current.server_available) {
          $("study-warning").textContent = "Export is waiting for pending recordings to reach local storage. Keep this tab open and retry when the status says Saved locally.";
          $("study-warning").hidden = false; return;
        }
        root.location.assign("/api/study/export");
      });
      if (researcherMode) $("study-panel")?.addEventListener("toggle", event => recorder.emit("study.panel", { open: event.target.open }));
      if (parentRecorder) recorder.emit("client.frame_open", {});
      snapshot("page_open"); render(recorder.getState());
      if (parentRecorder) {
        // The parent owns retries, health checks and browser eviction protection.
        root.setInterval(() => snapshot("periodic"), 30000);
        return;
      }
      void recorder.status().then(() => recorder.flush());
      root.setInterval(() => { void recorder.flush(); }, 1500);
      root.setInterval(() => { snapshot("periodic"); void recorder.status(); }, 30000);
      // Firefox can show a permission prompt for persist(). Keep participant mode
      // prompt-free; the researcher view can request protection for the same origin.
      const persistence = researcherMode ? root.navigator.storage?.persist?.() : root.navigator.storage?.persisted?.();
      persistence?.then(granted => recorder.emit("recording.browser_persistence", { granted, requested: researcherMode }))
        .catch(error => recorder.emit("recording.browser_persistence", { granted: false, requested: researcherMode, message: error.message }));
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true }); else initialize();
  }

  const exported = { createRecorder, createIndexedDBQueue, createMappingTracker, clean, controlValue, controlDescription, installBrowser };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  else { root.HydraStudyRecorder = exported; installBrowser(root); }
})(typeof globalThis !== "undefined" ? globalThis : this);
