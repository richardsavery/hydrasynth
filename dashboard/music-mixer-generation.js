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
    if (!response.ok) throw Object.assign(new Error(data.error || data.message || `Music request failed (${response.status}).`), { status: response.status });
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
  function create({ engine, getSettings, onUpdate = () => {}, onTrack = () => {}, onError = () => {},
    request: send = request, sleep = wait, storage, now = () => Date.now() } = {}) {
    if (!engine || typeof getSettings !== "function") throw new Error("Mixer generation needs an engine and musical direction.");
    if (storage === undefined) { try { storage = globalThis.localStorage; } catch (_) { /* Storage may be disabled. */ } }
    let pending = null;
    try {
      const saved = JSON.parse(storage?.getItem(KEY) || "null");
      if (saved && ["original", "next"].includes(saved.kind) && saved.path === (saved.kind === "original" ? "/generations" : "/continuations") &&
          saved.body && typeof saved.body.plan_id === "string" && (saved.kind === "original" ||
            saved.body.kind === "prompt" && typeof saved.body.session_id === "string" && Number.isInteger(saved.body.sequence)) &&
          ["submitting", "polling", "ready", "failed"].includes(saved.stage)) pending = saved;
    } catch (_) { /* A corrupt draft cannot start a request. */ }
    let epoch = 0, busy = false, enabled = false, phase = "idle", error = null, controller = null;
    let current = engine.snapshot().track || null, queued = null;
    const session = `mixer-${now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    let sequence = 0;
    function snapshot() {
      return { phase, enabled, pendingId: pending?.jobId || null, queuedId: queued?.id || null,
        currentId: current?.id || null, error, busy, recovering: Boolean(pending && !enabled) };
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
    function fail(cause) {
      error = cause?.message || String(cause); phase = "error";
      onError(error); emit();
    }
    function direction() {
      const value = copy(getSettings());
      if (![20, 40, 60].includes(value.duration_seconds) || !value.settings || typeof value.settings !== "object") {
        throw new Error("Choose a track length and musical direction before generating.");
      }
      return value;
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
            pending.stage = "failed"; persist();
            throw new Error(separation.error || "Stem separation failed. The current track will repeat.");
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
      pending.stage = "ready"; pending.jobId = job.id; persist();
      onTrack(job);
      if (pending.kind === "original") {
        if (pending.saveOnly) {
          pending = null; persist(); phase = "ready"; emit(); return;
        }
        await engine.setTrack(job); assertActive(run);
        current = job;
        if (await engine.start() === false) throw new Error(engine.snapshot().error || "The track is ready. Press Play to start audio.");
        assertActive(run); pending = null; persist();
      } else {
        // A recalled track may have changed while a provider job was already
        // underway. Save that result without inserting it into another song.
        if (current?.id !== pending.sourceId) { pending = null; persist(); return; }
        queued = job; emit();
        if (await engine.queueTrack(job) === false) { queued = null; throw new Error(engine.snapshot().error || "The next track could not be loaded. The current track will repeat."); }
        assertActive(run);
      }
      phase = "ready"; emit();
    }
    async function recover(run, retryMissing = false) {
      let job;
      if (pending.jobId) job = await call(`/generations/${encodeURIComponent(pending.jobId)}`, {}, run);
      else {
        const jobs = (await call("/generations", {}, run)).jobs || [];
        const matches = pending.kind === "next"
          ? jobs.filter((item) => item.realtime?.session_id === pending.body.session_id && item.realtime?.sequence === pending.body.sequence)
          : jobs.filter((item) => item.plan_id === pending.body.plan_id && !pending.previousIds?.includes(item.id));
        if (matches.length === 0 && retryMissing && pending.kind === "next") {
          // Only explicit Retry may repeat this POST. Its persisted session and
          // sequence make it idempotent even if the earlier response was lost.
          job = await call(pending.path, { method: "POST", body: copy(pending.body) }, run);
        } else {
          if (matches.length !== 1) throw new Error("The last request has no confirmed result yet. Check again to recover it without submitting another generation.");
          job = matches[0];
        }
      }
      await install(await readyJob(job, run), run);
    }
    async function submit(path, body, kind, sourceId, run) {
      const previousIds = kind === "original" ? ((await call("/generations", {}, run)).jobs || []).map((job) => job.id) : [];
      pending = { kind, sourceId, path, body: copy(body), previousIds, stage: "submitting", jobId: null };
      persist(); emit();
      let job;
      try { job = await call(path, { method: "POST", body }, run); }
      catch (cause) {
        // An HTTP rejection is known not to have allocated this job. A lost
        // response must retain intent: repeated Play cannot silently rebill.
        if (cause.status && cause.status >= 400 && cause.status < 500 && run === epoch) { pending.stage = "failed"; persist(); }
        throw cause;
      }
      await install(await readyJob(job, run), run);
    }
    function launch(action, nextPhase) {
      if (busy) return Promise.resolve(false);
      busy = true; phase = nextPhase; error = null;
      const run = epoch; emit();
      return (async () => {
        try { await action(run); return true; }
        catch (cause) { if (run === epoch && cause.name !== "AbortError") fail(cause); return false; }
        finally {
          if (run === epoch) { busy = false; emit(); fill(); }
        }
      })();
    }
    function fill() {
      if (!enabled || busy || error || queued || !current || !engine.snapshot().running) return;
      // launch locks synchronously before any callback can re-enter update().
      void launch(async (run) => {
        if (pending) { await recover(run); return; }
        const settings = direction();
        const body = { kind: "prompt", plan_id: current.plan_id, source_job_id: current.id,
          session_id: session, sequence: sequence++, ...settings };
        await submit("/continuations", body, "next", current.id, run);
      }, "generating-next");
    }
    function begin() {
      enabled = true; error = null; controller?.abort(); controller = new AbortController(); epoch++;
    }
    function startNew() {
      if (busy || enabled && queued) return Promise.resolve(false);
      begin();
      return launch(async (run) => {
        // launch locks first; unlock can synchronously emit an engine update.
        // This still runs in the button gesture, before the first await.
        const unlocked = engine.unlock?.();
        if (unlocked && await unlocked === false) throw new Error("Audio playback could not be started.");
        assertActive(run);
        if (pending && pending.stage !== "failed") {
          const recalledOriginal = pending.kind === "original" && pending.saveOnly;
          if (pending.kind === "next" && current && !engine.snapshot().running && await engine.start() === false) {
            throw new Error(engine.snapshot().error || "Audio playback could not be started.");
          }
          await recover(run);
          if (!recalledOriginal) return;
        }
        pending = null; persist();
        const settings = direction();
        const plan = await call("/plans", { method: "POST", body: { kind: "original", ...settings } }, run);
        await submit("/generations", { plan_id: plan.id, variation: true }, "original", null, run);
      }, "generating-first");
    }
    function resume(retryMissing = false) {
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
          if (pending.stage === "failed") throw new Error("The last generation failed. Retry when ready.");
          await recover(run, retryMissing);
        } else if (!current) throw new Error("Generate a starting track or recall saved music.");
        phase = "ready";
      }, pending?.kind === "original" && !pending.saveOnly ? "generating-first" : "generating-next");
    }
    function retry() {
      if (busy) return Promise.resolve(false);
      if (pending?.stage === "failed") { pending = null; persist(); }
      if (!current && !pending) return startNew();
      return resume(true);
    }
    function stop() {
      enabled = false; ++epoch; controller?.abort(); controller = null; busy = false; queued = null;
      phase = "idle"; error = null; engine.stop(); emit();
    }
    async function recall(track) {
      stop();
      if (pending?.kind === "original") { pending.saveOnly = true; persist(); }
      try {
        await engine.setTrack(track);
        current = engine.snapshot().track || null; emit(); return true;
      } catch (cause) { fail(cause); return false; }
    }
    function update(next = engine.snapshot()) {
      current = next.track || null;
      if (queued && current?.id === queued.id) {
        queued = null; pending = null; persist(); phase = "ready"; emit();
      }
      fill();
    }
    return { startNew, resume, stop, deactivate: stop, retry, recall, update, snapshot };
  }
  return { create };
})();
