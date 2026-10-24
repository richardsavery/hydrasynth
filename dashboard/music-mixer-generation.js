"use strict";

// Keeps one new piece ahead of the mixer. Merely opening or restoring the
// workspace never submits work; Play or Generate starts the session.
globalThis.HydraMusicMixerGeneration = (() => {
  const KEY = "hydra.music-mixer.pending.v1";
  const ACTIVE = new Set(["queued", "generating"]);
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const cancelled = () => Object.assign(new Error("Stopped"), { name: "AbortError" });
  async function request(path, { method = "GET", body, signal } = {}) {
    const response = await fetch(`/api/elevenlabs${path}`, { method, signal, cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error("The music service returned an unreadable response."); }
    if (!response.ok) throw Object.assign(new Error(data.error || data.message || `Music request failed (${response.status}).`), { status: response.status, code: data.code });
    return data;
  }
  function wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(cancelled()); return; }
      const abort = () => { clearTimeout(timer); reject(cancelled()); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  function create({ engine, getSettings, getNextTrack, onUpdate = () => {}, onTrack = () => {}, onError = () => {},
    request: send = request, sleep = wait, storage, now = () => Date.now(),
    schedule = globalThis.setTimeout, unschedule = globalThis.clearTimeout } = {}) {
    if (!engine || typeof getSettings !== "function") throw new Error("Mixer generation needs an engine and musical direction.");
    if (storage === undefined) { try { storage = globalThis.localStorage; } catch (_) { /* Storage may be disabled. */ } }
    let pending = null;
    try {
      const saved = JSON.parse(storage?.getItem(KEY) || "null");
      if (saved && ["original", "next"].includes(saved.kind) &&
          (saved.path === "/generations" || saved.kind === "next" && saved.path === "/continuations") &&
          saved.body && typeof saved.body.plan_id === "string" && (saved.path === "/generations" ||
            saved.body.kind === "prompt" && typeof saved.body.session_id === "string" && Number.isInteger(saved.body.sequence)) &&
          ["submitting", "polling", "ready", "failed"].includes(saved.stage)) pending = saved;
    } catch (_) { /* A corrupt draft cannot start a request. */ }
    let epoch = 0, busy = false, enabled = false, phase = "idle", error = null, controller = null;
    let current = engine.snapshot().track || null, queued = null;
    const session = `mixer-${now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    let sequence = 0, promptTimer = null, retryTimer = null, retryAt = null, busyRetries = 0;
    let editing = false, restartOriginal = false, savedBusy = false, savedLaunching = false, savedToken = 0, queuedIntent = null;
    let latestChoice = readChoice();
    let latestDirection = readDirection();
    function generates() { return latestChoice.mode === "new" || latestChoice.mode === "similar"; }
    function snapshot() {
      return { phase, enabled, pendingId: pending?.jobId || null, queuedId: queued?.id || null,
        currentId: current?.id || null, error: error || ((generates() || restartOriginal) && latestDirection.error) || null, busy: busy || savedBusy,
        nextMode: latestChoice.mode, selectedTrackId: latestChoice.trackId, savedBusy: savedBusy || savedLaunching,
        nextPrompt: pending?.direction?.settings?.style || pending?.body?.settings?.style || null,
        retryAt, recovering: Boolean(pending && !enabled), canClearPending: canClearPending() };
    }
    function emit() { onUpdate(snapshot()); }
    function persist() {
      try { if (pending) storage?.setItem(KEY, JSON.stringify(pending)); else storage?.removeItem(KEY); } catch (_) { /* Server jobs remain saved. */ }
    }
    function assertActive(run) { if (run !== epoch || !enabled || controller.signal.aborted) throw cancelled(); }
    async function call(path, options, run) {
      assertActive(run);
      const result = await send(path, { ...options, signal: controller.signal });
      assertActive(run); return result;
    }
    function clearTimer(kind) {
      const timer = kind === "prompt" ? promptTimer : retryTimer;
      if (timer !== null) unschedule?.(timer);
      if (kind === "prompt") promptTimer = null;
      else { retryTimer = null; retryAt = null; }
    }
    const serviceBusy = (cause) => cause?.status === 409 && /^Another music or stem request is pending\./.test(cause.message || "");
    function canClearPending() {
      return Boolean(pending && !pending.jobId && !busy && (!enabled || phase === "error"));
    }
    function fail(cause) {
      if (cause?.draft) { error = null; phase = "waiting-prompt"; emit(); return; }
      error = cause?.message || String(cause); phase = "error";
      if (enabled && serviceBusy(cause)) {
        const delay = Math.min(10000 * 2 ** busyRetries++, 60000), run = epoch;
        retryAt = now() + delay; phase = "waiting-retry";
        retryTimer = schedule(() => {
          retryTimer = null; retryAt = null;
          if (enabled && run === epoch) void retry();
        }, delay);
      } else onError(error);
      emit();
    }
    function direction() {
      try {
        const value = copy(getSettings());
        if (![20, 40, 60].includes(value.duration_seconds) || !value.settings || typeof value.settings !== "object") {
          throw new Error("Choose a track length and musical direction before generating.");
        }
        if (getNextTrack) value.continuity_mode = latestChoice.mode === "similar" ? "evolve" : "fresh";
        if (value.continuity_mode === undefined) value.continuity_mode = "fresh";
        if (!["fresh", "evolve"].includes(value.continuity_mode)) throw new Error("Choose how the next track should follow your prompt.");
        return value;
      } catch (cause) { throw Object.assign(cause, { draft: true }); }
    }
    function readDirection() {
      try { const value = direction(); return { value, key: JSON.stringify(value), error: null }; }
      catch (cause) { return { value: null, key: null, error: cause?.message || String(cause) }; }
    }
    function readChoice() {
      if (typeof getNextTrack === "function") {
        const value = getNextTrack() || {};
        return { mode: ["loop", "similar", "new", "old"].includes(value.mode) ? value.mode : "new", trackId: typeof value.trackId === "string" ? value.trackId : "" };
      }
      try { return { mode: getSettings()?.continuity_mode === "evolve" ? "similar" : "new", trackId: "" }; }
      catch (_) { return { mode: "new", trackId: "" }; }
    }
    function outdated(intent) {
      if (!intent) return false;
      if (latestChoice.mode === "old") return true;
      if (latestChoice.mode === "loop") return !(intent.kind === "original" && !intent.saveOnly && (!current || current.id === intent.jobId && restartOriginal));
      const value = intent.direction || (intent.kind === "next" ? {
        duration_seconds: intent.body.duration_seconds, settings: intent.body.settings,
        ...(intent.body.continuity_mode === undefined ? {} : { continuity_mode: intent.body.continuity_mode })
      } : null);
      return value && JSON.stringify(value) !== latestDirection.key;
    }
    function discard(intent) {
      if (pending === intent) { pending = null; persist(); }
    }
    function saveOriginalForHistory() {
      if (pending?.kind === "original" && !pending.saveOnly) { pending.saveOnly = true; persist(); }
    }
    function settingsChanged() {
      const previousChoice = latestChoice;
      latestChoice = readChoice();
      const choiceChanged = JSON.stringify(latestChoice) !== JSON.stringify(previousChoice);
      const next = readDirection();
      if (!choiceChanged && next.key === latestDirection.key && next.error === latestDirection.error) return;
      latestDirection = next;
      if (!choiceChanged && !generates()) return;
      if (!enabled) return;
      // Lock replacement submissions before clearing the player: clearing a
      // fade can synchronously promote its already-audible incoming track.
      editing = true; clearTimer("prompt");
      if (choiceChanged) { ++savedToken; savedBusy = false; savedLaunching = false; clearTimer("retry"); }
      if (choiceChanged && !["new", "similar"].includes(previousChoice.mode)) error = null;
      if (!generates()) { error = null; if (latestChoice.mode === "old" || current) restartOriginal = false; }
      if (pending?.serviceBusy) { discard(pending); clearTimer("retry"); error = null; }
      phase = error ? "error" : "updating-prompt";
      if (queued) {
        const previous = queued, intent = queuedIntent;
        engine.clearQueuedTrack?.();
        const state = engine.snapshot();
        // clearQueuedTrack can retain an audible fade while clearing a newer
        // spare. Actual queue/current identity is authoritative.
        if (queued === previous && state.queuedTrack?.id !== previous.id && !state.queueing) {
          queued = null; queuedIntent = null;
          if (intent?.stage === "ready") discard(intent);
        }
      }
      if (!generates()) {
        editing = false;
        phase = latestChoice.mode === "loop" ? "looping" : latestChoice.trackId ? "ready" : "waiting-track";
        emit(); fill(); return;
      }
      promptTimer = schedule(() => {
        promptTimer = null; editing = false;
        if (!enabled) return;
        latestChoice = readChoice(); latestDirection = readDirection();
        if (error) { phase = "error"; emit(); return; }
        if (latestDirection.error) { phase = "waiting-prompt"; emit(); return; }
        if (!busy) phase = queued ? "ready" : restartOriginal ? "generating-first" : "generating-next";
        emit(); fill();
      }, 650);
      emit();
    }
    async function readyJob(job, run) {
      while (true) {
        assertActive(run);
        if (!job?.id || !job.plan_id) throw new Error("The music service did not return a saved track.");
        pending.jobId = job.id; pending.stage = "polling"; persist(); emit();
        if (job.state === "complete") {
          const separation = job.stem_separation;
          if (separation?.state === "complete" && separation.stems?.length) {
            return { ...job, stems: copy(separation.stems),
              audio_url: job.audio_url || `/api/elevenlabs/generations/${encodeURIComponent(job.id)}/audio` };
          }
          if (separation?.state === "failed" || separation?.state === "unknown" || separation?.state === "complete") {
            pending.stage = separation?.state === "unknown" ? "polling" : "failed"; persist();
            // Retain the complete mix for an explicit free recovery choice.
            // Automatic playback still requires the requested stems.
            onTrack({ ...job, stems: [] });
            throw new Error(`Music is saved, but stem separation ${separation.state === "unknown" ? "has no confirmed result" : "failed"}. Use saved full mix to continue without another charge. No automatic retry was made.`);
          }
          // Every new job requests stems on the server. Never issue a second
          // paid separation request while that pipeline is finishing.
          if (!separation && job.separate_stems !== true) {
            pending.stage = "failed"; persist();
            throw new Error("This generation has no separated stems.");
          }
        } else if (!ACTIVE.has(job.state)) {
          pending.stage = job.state === "unknown" ? "polling" : "failed"; persist();
          throw new Error(job.error || (job.state === "unknown" ? "The last generation outcome is unknown. Check it before making another request." : "Music generation failed. The current track will repeat."));
        }
        await sleep(1500, controller.signal); assertActive(run);
        job = await call(`/generations/${encodeURIComponent(job.id)}`, {}, run);
      }
    }
    async function install(job, run) {
      assertActive(run);
      const intent = pending;
      intent.stage = "ready"; intent.jobId = job.id; persist();
      onTrack(job);
      if (outdated(intent)) { discard(intent); return; }
      if (intent.kind === "original") {
        if (intent.saveOnly) {
          discard(intent); phase = "ready"; emit(); return;
        }
        await engine.setTrack(job); assertActive(run);
        if (outdated(intent)) { discard(intent); return; }
        current = job;
        if (await engine.start() === false) throw new Error(engine.snapshot().error || "The track is ready. Press Play to start audio.");
        assertActive(run); discard(intent); restartOriginal = false;
      } else {
        // Recalled songs and edited prompts retain finished results in history.
        if (current?.id !== intent.sourceId) { discard(intent); return; }
        queued = job; queuedIntent = intent; emit();
        if (outdated(intent) || pending !== intent) { discard(intent); return; }
        const loaded = await engine.queueTrack(job);
        assertActive(run);
        if (outdated(intent) || pending !== intent) {
          if (queued?.id === job.id) {
            engine.clearQueuedTrack?.(); queued = null; queuedIntent = null;
          }
          discard(intent); return;
        }
        if (loaded === false) {
          queued = null; queuedIntent = null;
          throw new Error(engine.snapshot().error || "The next track could not be loaded. The current track will repeat.");
        }
      }
      busyRetries = 0; phase = "ready"; emit();
    }
    async function recover(run, retryMissing = false) {
      let job;
      if (pending.serviceBusy && outdated(pending)) { discard(pending); return; }
      if (pending.serviceBusy) {
        if (!generates()) throw new Error("The starting track has not been generated. Choose Generate new to retry it.");
        // This exact rejection did not allocate a job, so its persisted
        // idempotent payload can be retried without overlapping provider work.
        job = await postPending(run);
      } else if (pending.jobId) job = await call(`/generations/${encodeURIComponent(pending.jobId)}`, {}, run);
      else {
        const jobs = (await call("/generations", {}, run)).jobs || [];
        const matches = pending.path === "/continuations"
          ? jobs.filter((item) => item.realtime?.session_id === pending.body.session_id && item.realtime?.sequence === pending.body.sequence)
          : jobs.filter((item) => item.plan_id === pending.body.plan_id && !pending.previousIds?.includes(item.id));
        if (matches.length === 0 && retryMissing && pending.path === "/continuations" && generates()) {
          // Only explicit Retry may repeat this POST. Its persisted session and
          // sequence make it idempotent even if the earlier response was lost.
          job = await postPending(run);
        } else {
          if (matches.length !== 1) throw new Error("The last request has no confirmed result yet. Check again to recover it without submitting another generation.");
          job = matches[0];
        }
      }
      await install(await readyJob(job, run), run);
    }
    async function postPending(run) {
      const intent = pending;
      delete intent.serviceBusy; intent.stage = "submitting"; persist();
      try { return await call(intent.path, { method: "POST", body: copy(intent.body) }, run); }
      catch (cause) {
        // Preserve unknown submissions for GET recovery, never fresh retries.
        if (run === epoch && pending === intent) {
          if (serviceBusy(cause)) intent.serviceBusy = true;
          else if (cause.code === "generation_not_submitted" || cause.status >= 400 && cause.status < 500) intent.stage = "failed";
          persist();
        }
        throw cause;
      }
    }
    async function submit(path, body, kind, sourceId, run, settings) {
      const previousIds = path === "/generations" ? ((await call("/generations", {}, run)).jobs || []).map((job) => job.id) : [];
      if (editing || latestChoice.mode === "old" || latestChoice.mode === "loop" && (kind !== "original" || current) || JSON.stringify(settings) !== latestDirection.key && latestChoice.mode !== "loop") return;
      pending = { kind, sourceId, path, body: copy(body), direction: copy(settings), previousIds, stage: "submitting", jobId: null };
      persist(); emit();
      await install(await readyJob(await postPending(run), run), run);
    }
    async function submitOriginal(run, sourceId = null) {
      const settings = direction(); latestDirection = readDirection();
      const plan = await call("/plans", { method: "POST", body: { kind: "original",
        duration_seconds: settings.duration_seconds, settings: settings.settings } }, run);
      if (editing || sourceId && current?.id !== sourceId || latestChoice.mode === "old" || latestChoice.mode === "loop" && current || JSON.stringify(settings) !== latestDirection.key && latestChoice.mode !== "loop") return;
      await submit("/generations", { plan_id: plan.id, variation: true }, sourceId ? "next" : "original", sourceId, run, settings);
    }
    function launch(action, nextPhase) {
      if (busy) return Promise.resolve(false);
      busy = true; phase = nextPhase; error = null;
      const run = epoch; emit();
      return (async () => {
        try { await action(run); return true; }
        catch (cause) {
          if (run === epoch && cause.name !== "AbortError") {
            // A superseded, definitively rejected request cannot block the
            // latest direction. Ambiguous provider outcomes still need recovery.
            if (outdated(pending) && (pending?.stage === "failed" || pending?.serviceBusy)) discard(pending);
            else if (generates() || restartOriginal) fail(cause);
          }
          return false;
        }
        finally {
          if (run === epoch) {
            busy = false;
            if (!error && editing) phase = "updating-prompt";
            else if (!error && (generates() || restartOriginal) && latestDirection.error) phase = "waiting-prompt";
            else if (!error && latestChoice.mode === "loop") phase = "looping";
            emit(); fill();
          }
        }
      })();
    }
    async function loadSaved(immediate = false) {
      if (savedBusy || !enabled || latestChoice.mode !== "old" || !latestChoice.trackId) return false;
      const id = latestChoice.trackId, token = ++savedToken, run = epoch;
      const valid = () => enabled && run === epoch && token === savedToken && latestChoice.mode === "old" && latestChoice.trackId === id;
      savedBusy = true; phase = "loading-saved"; error = null; emit();
      try {
        let track = await call(`/generations/${encodeURIComponent(id)}`, {}, run);
        if (!valid()) return false;
        const separation = track.stem_separation;
        if (track.state !== "complete" || (track.separate_stems === true && !["complete", "failed", "unknown"].includes(separation?.state))) {
          throw new Error("This saved track is not ready. Choose a completed track.");
        }
        if (!track.generation_settings && !track.realtime?.generation_settings && track.plan_id) {
          try { track.generation_settings = (await call(`/plans/${encodeURIComponent(track.plan_id)}`, {}, run)).settings; }
          catch (cause) { if (cause.name === "AbortError") throw cause; }
          if (!valid()) return false;
        }
        track = { ...track, stems: copy(separation?.state === "complete" ? separation.stems || [] : track.stems || []),
          audio_url: track.audio_url || `/api/elevenlabs/generations/${encodeURIComponent(id)}/audio` };
        onTrack(track);
        if (!valid()) return false;
        // An explicit saved selection owns playback even if the user returns
        // to generation before an earlier original request finishes.
        saveOriginalForHistory();
        if (current?.id === id) {
          if (!engine.snapshot().running && await engine.start() === false) throw new Error(engine.snapshot().error || "Press Play to start this track.");
        } else if (immediate || !current) {
          await engine.setTrack(track);
          if (!valid()) return false;
          current = track;
          if (await engine.start() === false) throw new Error(engine.snapshot().error || "Press Play to start this track.");
          if (!valid()) return false;
        } else {
          queued = track; queuedIntent = null; emit();
          if (!valid()) return false;
          const loaded = await engine.queueTrack(track);
          if (!valid()) return false;
          if (loaded === false) {
            queued = null;
            throw new Error(engine.snapshot().error || "The saved track could not be loaded. The current track will repeat.");
          }
        }
        if (!valid()) return false;
        phase = current?.id === id ? "looping" : "ready"; emit(); return true;
      } catch (cause) {
        if (valid() && cause.name !== "AbortError") fail(cause);
        return false;
      } finally {
        if (token === savedToken && run === epoch) { savedBusy = false; emit(); fill(); }
      }
    }
    function fill() {
      if (!enabled || editing || savedLaunching) return;
      if (!generates() && !restartOriginal) {
        if (error) return;
        const waiting = latestChoice.mode === "loop" || current?.id === latestChoice.trackId ? "looping" : !latestChoice.trackId ? "waiting-track" : null;
        if (waiting) {
          if (latestChoice.mode === "old" && current?.id === latestChoice.trackId) saveOriginalForHistory();
          if (phase !== waiting) { phase = waiting; emit(); } return;
        }
        if (!savedBusy && !queued && (!current || engine.snapshot().running)) void loadSaved();
        return;
      }
      if (!enabled || busy || error || editing || latestDirection.error || queued ||
          !restartOriginal && (!current || !engine.snapshot().running)) return;
      // launch locks synchronously before any callback can re-enter update().
      void launch(async (run) => {
        if (pending) { await recover(run); return; }
        if (restartOriginal) { await submitOriginal(run); return; }
        // Uploaded audio has no provider composition to extend. An explicit
        // generation choice creates a fresh prompt-based piece, queued after
        // this track with the same recovery journal as other upcoming music.
        if (current.origin === "uploaded" || !current.plan_id) { await submitOriginal(run, current.id); return; }
        const settings = direction(); latestDirection = readDirection();
        const body = { kind: "prompt", plan_id: current.plan_id, source_job_id: current.id,
          session_id: session, sequence: sequence++, ...settings };
        await submit("/continuations", body, "next", current.id, run, settings);
      }, restartOriginal ? "generating-first" : "generating-next");
    }
    function begin() {
      enabled = true; error = null; clearTimer("retry");
      latestChoice = readChoice(); latestDirection = readDirection();
      ++savedToken; savedBusy = false; savedLaunching = false;
      controller?.abort(); controller = new AbortController(); epoch++;
    }
    function startNew() {
      latestChoice = readChoice(); latestDirection = readDirection();
      if (latestChoice.mode === "old") return playSaved(true);
      if (latestChoice.mode === "loop" && current) return resume();
      if (busy || enabled && queued) return Promise.resolve(false);
      begin(); restartOriginal = true;
      return launch(async (run) => {
        // launch locks first; unlock can synchronously emit an engine update.
        // This still runs in the button gesture, before the first await.
        const unlocked = engine.unlock?.();
        if (unlocked && await unlocked === false) throw new Error("Audio playback could not be started.");
        assertActive(run);
        if (pending && pending.stage !== "failed") {
          const recalledOriginal = pending.kind === "original" && pending.saveOnly;
          if (pending.kind === "next") restartOriginal = false;
          if (pending.kind === "next" && current && !engine.snapshot().running && await engine.start() === false) {
            throw new Error(engine.snapshot().error || "Audio playback could not be started.");
          }
          await recover(run);
          if (!recalledOriginal) return;
        }
        pending = null; persist();
        await submitOriginal(run);
      }, "generating-first");
    }
    async function playSaved(immediate = false) {
      // Saved audio is independent of a paid request already accepted by the
      // service. Leave that request's journal and polling untouched.
      if (!enabled) begin();
      restartOriginal = false; error = null;
      if (savedBusy || savedLaunching) return false;
      savedLaunching = true;
      const token = savedToken, run = epoch;
      if (immediate && queued) {
        engine.clearQueuedTrack?.(); queued = null; queuedIntent = null;
      }
      const unlocked = engine.unlock?.();
      if (unlocked && await unlocked === false) { savedLaunching = false; fail(new Error("Audio playback could not be started.")); return false; }
      if (!enabled || latestChoice.mode !== "old" || token !== savedToken || run !== epoch) return false;
      if (current && !immediate && !engine.snapshot().running && await engine.start() === false) {
        savedLaunching = false; fail(new Error(engine.snapshot().error || "Audio playback could not be started.")); return false;
      }
      if (!enabled || latestChoice.mode !== "old" || token !== savedToken || run !== epoch) return false;
      savedLaunching = false;
      if (!latestChoice.trackId) { phase = "waiting-track"; emit(); return true; }
      if (savedBusy || queued?.id === latestChoice.trackId) return true;
      return loadSaved(immediate);
    }
    function resume(retryMissing = false) {
      latestChoice = readChoice(); latestDirection = readDirection();
      if (latestChoice.mode === "old") return playSaved(false);
      if (latestChoice.mode === "loop" && current && !(pending?.kind === "original" && !pending.saveOnly && pending.jobId === current.id)) {
        if (!enabled) begin();
        restartOriginal = false; error = null;
        // Loop does not recover by POST, even for a known service-busy rejection.
        return Promise.resolve(engine.start()).then((started) => {
          if (started === false) { fail(new Error(engine.snapshot().error || "Audio playback could not be started.")); return false; }
          if (enabled) { phase = "looping"; emit(); } return true;
        });
      }
      if (busy) return Promise.resolve(false);
      if (enabled && engine.snapshot().running && !error) { fill(); return Promise.resolve(true); }
      begin();
      return launch(async (run) => {
        // start() also resumes audio before its first await.
        // A reload can select the first track while its server-side stem
        // separation is still finishing. Recover that original pipeline before
        // starting any selected full-mix version of the same job.
        const starting = current && (pending?.kind !== "original" || pending.saveOnly) ? engine.start() : engine.unlock?.();
        if (starting && await starting === false) throw new Error(engine.snapshot().error || "Audio playback could not be started.");
        assertActive(run);
        if (pending) {
          if (pending.kind === "original" && !pending.saveOnly) restartOriginal = true;
          if (pending.stage === "failed") throw new Error("The last generation failed. Retry when ready.");
          await recover(run, retryMissing);
        } else if (!current) throw new Error("Generate a starting track or recall saved music.");
        phase = "ready";
      }, pending?.kind === "original" && !pending.saveOnly ? "generating-first" : "generating-next");
    }
    function retry() {
      latestChoice = readChoice(); latestDirection = readDirection();
      if (latestChoice.mode === "old" || latestChoice.mode === "loop" && current) return resume(true);
      if (busy) return Promise.resolve(false);
      if (pending?.stage === "failed") { pending = null; persist(); }
      if (!current && !pending) return startNew();
      return resume(true);
    }
    function stop(preserveUnlocked = false) {
      enabled = false; ++epoch; controller?.abort(); controller = null; busy = false; queued = null;
      queuedIntent = null; ++savedToken; savedBusy = false; savedLaunching = false;
      clearTimer("prompt"); clearTimer("retry"); editing = false; restartOriginal = false; busyRetries = 0;
      phase = "idle"; error = null; engine.stop(preserveUnlocked); emit();
    }
    function clearPending() {
      if (!canClearPending()) return false;
      // Explicitly abandon only the browser's recovery journal. Server jobs
      // and saved music remain intact; clearing must never submit new work.
      stop(); pending = null; persist(); emit(); return true;
    }
    async function recall(track, { preserveUnlocked = false } = {}) {
      stop(preserveUnlocked);
      if (pending?.kind === "original") { pending.saveOnly = true; persist(); }
      try {
        await engine.setTrack(track);
        current = engine.snapshot().track || null; emit(); return true;
      } catch (cause) { fail(cause); return false; }
    }
    function update(next = engine.snapshot()) {
      current = next.track || null;
      if (queued && current?.id === queued.id) {
        if (queuedIntent && pending === queuedIntent) discard(queuedIntent);
        queued = null; queuedIntent = null;
        phase = latestChoice.mode === "loop" || latestChoice.mode === "old" && current.id === latestChoice.trackId ? "looping" : "ready"; emit();
      }
      fill();
    }
    return { startNew, resume, stop, deactivate: stop, retry, clearPending, recall, update, settingsChanged, snapshot };
  }
  return { create };
})();
