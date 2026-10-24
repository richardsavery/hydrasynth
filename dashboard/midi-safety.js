"use strict";

globalThis.HydraMidiSafety = (() => {
  // Keep this bound in sync with the backend's handover settling window.
  const MAX_NOTE_MS = 5000;
  const expiredLease = message => Object.assign(new Error(message), { status: 409 });
  // Release messages belong to the browser's MIDI scheduler, not a JavaScript
  // timer. The latter stops running when a tab freezes or its renderer dies.
  function createNotes({ active = new Map(), sustain = new Set(), now = () => performance.now(),
    schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), channel = 0 } = {}) {
    const pending = new WeakMap();
    function play(output, note, velocity, durationMs) {
      if (!output) return false;
      const time = now(), duration = Math.max(1, Number(durationMs));
      if (!Number.isFinite(duration) || duration > MAX_NOTE_MS) throw new Error("MIDI notes must finish within five seconds.");
      let pitches = pending.get(output);
      if (!pitches) { pitches = new Map(); pending.set(output, pitches); }
      // Chromium has no MIDIOutput.clear(). An already scheduled old note-off
      // would cut a new note of the same pitch short, including after Stop.
      if (pitches.get(note)?.deadline > time) return false;
      const record = { output, note, deadline: time + duration, timer: null };
      output.send([0x90 | channel, note, velocity]);
      try { output.send([0x80 | channel, note, 0], record.deadline); }
      catch (error) {
        try { output.send([0x80 | channel, note, 0]); } catch (_) {}
        throw error;
      }
      pitches.set(note, record);
      active.set(record, record);
      const cleanup = () => {
        if (!active.has(record)) return;
        // Fractional timer delays may round down. Retain the release deadline
        // until the native timestamp has actually passed.
        if (now() < record.deadline) {
          record.timer = schedule(cleanup, Math.max(1, record.deadline - now()));
          return;
        }
        active.delete(record);
        if (pitches.get(note) === record) pitches.delete(note);
      };
      record.timer = schedule(cleanup, duration);
      return true;
    }
    function stop({ release = true } = {}) {
      const outputs = new Set([...active.values()].map(record => record.output));
      for (const output of sustain) outputs.add(output);
      for (const output of release ? outputs : []) {
        try { output.send([0xB0 | channel, 64, 0]); } catch (_) {}
      }
      sustain.clear();
      for (const record of active.values()) {
        cancel(record.timer);
        if (release) try { record.output.send([0x80 | channel, record.note, 0]); } catch (_) {}
      }
      active.clear();
      // Keep pending deadlines: panic cannot retract native queued messages.
    }
    return { play, stop };
  }

  async function request(path, body, signal) {
    const response = await fetch(`/api/midi-safety/${path}`, { method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
      keepalive: path === "disarm" });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error("The MIDI safety service returned an unreadable response. Restart the dashboard."); }
    if (!response.ok || !data.ok) throw Object.assign(new Error(data.error || "The MIDI safety service is unavailable. Restart the dashboard."), { status: response.status });
    return data;
  }

  // A server-side watchdog releases sustain and all notes when this page stops
  // checking in. It survives a crashed renderer, unlike an unload callback.
  function createGuard({ send = request, now = () => performance.now(),
    schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), onFailure = () => {} } = {}) {
    // Deliberately page-local: reloads lose the pending native-release records
    // and must wait for the backend's handover window before sounding notes.
    const ownerId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    let generation = 0, lease = null, timer = null, expiryTimer = null;
    let transition = Promise.resolve();
    function clearTimers() { cancel(timer); cancel(expiryTimer); timer = expiryTimer = null; }
    async function call(path, body) {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      let timeout;
      try {
        return await Promise.race([send(path, body, controller?.signal), new Promise((_, reject) => {
          timeout = schedule(() => {
            controller?.abort();
            reject(new Error("The MIDI safety service stopped responding. Restart the dashboard before playing."));
          }, 2000);
        })]);
      } finally { cancel(timeout); }
    }
    function fail(error, current) {
      if (lease !== current) return;
      // After a frozen page resumes, another page may already own the synth.
      // Only the token-checked server disarm may release an expired lease.
      if (now() >= current.deadline) error.status = 409;
      stop().catch(() => {});
      onFailure(error);
    }
    function expires(current) {
      cancel(expiryTimer);
      expiryTimer = schedule(() => fail(expiredLease("MIDI playback stopped because the page or safety connection stopped responding. Press Play to restart."), current),
        Math.max(0, current.deadline - now()));
    }
    async function heartbeat(current) {
      if (lease !== current) return;
      const started = now();
      if (started >= current.deadline) {
        fail(expiredLease("MIDI playback stopped after the page stopped responding. Press Play to restart."), current);
        return;
      }
      try {
        await call("heartbeat", { lease_id: current.id });
        if (lease !== current) return;
        current.deadline = started + current.timeout - 100;
        expires(current);
        timer = schedule(() => heartbeat(current), current.interval);
      } catch (error) { fail(error, current); }
    }
    function stop() {
      generation++;
      clearTimers();
      const previous = lease;
      lease = null;
      previous?.output.detachLease?.();
      const operation = transition.then(() => previous ? call("disarm", { lease_id: previous.id }) : undefined);
      transition = operation.catch(() => {});
      return operation;
    }
    function arm(output, channel) {
      const stopped = stop();
      const version = generation;
      const operation = stopped.catch(() => {}).then(async () => {
        if (version !== generation) return false;
        // A manual patch request may have started without a playback lease.
        // Finish that request before arming a new session, so its late program
        // change or panic cannot alter the new playback.
        output.cancelPending?.();
        await output.settled?.();
        if (version !== generation) return false;
        const started = now();
        const result = await call("arm", { port_name: output.portName || output.name, channel, owner_id: ownerId,
          ...(output.transport === "native" ? { transport: "native" } : {}) });
        if (typeof result.lease_id !== "string" || !result.lease_id || !(result.timeout_ms > 200) || !(result.heartbeat_ms > 0)) {
          throw new Error("The MIDI safety service returned an invalid lease. Restart the dashboard.");
        }
        if (version !== generation || now() >= started + result.timeout_ms - 100) {
          await call("disarm", { lease_id: result.lease_id });
          return false;
        }
        const current = { id: result.lease_id, output, timeout: result.timeout_ms,
          interval: result.heartbeat_ms, deadline: started + result.timeout_ms - 100 };
        lease = current;
        output.bindLease?.({ id: current.id, channel, ownerId });
        expires(current);
        timer = schedule(() => heartbeat(current), current.interval);
        return true;
      });
      transition = operation.catch(() => {});
      return operation;
    }
    function assertReady(output) {
      if (!lease || lease.output !== output || now() >= lease.deadline) {
        const error = expiredLease("MIDI safety connection expired. Stop and press Play to reconnect safely.");
        if (lease) fail(error, lease);
        throw error;
      }
    }
    return { arm, stop, assertReady, ownerId, settled: () => transition };
  }
  return { createNotes, createGuard, MAX_NOTE_MS };
})();
