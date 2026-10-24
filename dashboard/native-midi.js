"use strict";

// Linux sends through the dashboard's persistent ALSA client. In particular,
// note releases never enter Chromium's delayed Web MIDI task queue.
globalThis.HydraNativeMidi = (() => {
  const MAX_QUEUE = 128, MAX_BATCH = 64;
  async function request(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(`/api/midi-safety/${path}`, { cache: "no-store", signal: controller.signal,
        ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw Object.assign(new Error(data.error || "Native MIDI is unavailable. Restart the dashboard."), { status: response.status });
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Native MIDI stopped responding. Playback stopped; reconnect before playing.");
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function createOutput(info, { ownerId, send = request, onFailure = () => {},
    schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id) } = {}) {
    let lease = null, generation = 0, queue = [], timer = null, active = null, failure = null;
    const output = { ...info, transport: "native", state: "connected",
      portName: String(info.id || "").startsWith("native:") ? info.id.slice(7) : info.name };
    function cancelPending() { generation++; queue = []; cancel(timer); timer = null; failure = null; }
    function report(error, version) {
      if (version !== generation) return;
      failure = error; queue = []; cancel(timer); timer = null;
      onFailure(error, output);
    }
    function startDrain() {
      cancel(timer); timer = null;
      if (active || !queue.length) return active || Promise.resolve();
      const version = generation;
      active = Promise.resolve().then(async () => {
        while (queue.length && generation === version) {
          const first = queue[0], session = first.lease;
          let length = 1;
          while (length < Math.min(queue.length, MAX_BATCH)
              && queue[length].lease === session && queue[length].channel === first.channel) length++;
          const batch = queue.splice(0, length);
          // The token belongs to the accepted commands, never the next Play.
          const body = session ? { lease_id: session.id } : { owner_id: ownerId, port_name: output.portName, channel: batch[0].channel };
          await send(session ? "send" : "control", { ...body, commands: batch.map(item => item.command) });
        }
      }).catch(error => report(error, version)).finally(() => {
        active = null;
        if (queue.length) timer = schedule(() => { void startDrain(); }, 0);
      });
      return active;
    }
    function enqueue(commands, channel = lease?.channel || 1) {
      if (output.state !== "connected") throw new Error("The native MIDI output is disconnected.");
      if (failure) throw failure;
      if (!Array.isArray(commands) || !commands.length) return;
      if (queue.length + commands.length > MAX_QUEUE) {
        const error = new Error("Native MIDI could not keep up. Playback stopped before queued notes could accumulate.");
        report(error, generation); throw error;
      }
      queue.push(...commands.map(command => ({ command: { ...command, channel }, channel, lease })));
      if (!active && timer === null) timer = schedule(() => { void startDrain(); }, 5);
    }
    async function flush() {
      const version = generation;
      do { await startDrain(); } while (version === generation && queue.length);
      if (version === generation && failure) throw failure;
    }
    Object.assign(output, {
      bindLease(session) { cancelPending(); lease = { ...session }; },
      detachLease() { cancelPending(); lease = null; },
      cancelPending, flush, settled: () => active || Promise.resolve(),
      commands(commands) {
        if (!lease) throw new Error("Native MIDI notes and parameters require an active safety connection.");
        enqueue(commands);
      },
      play(note, velocity, durationMs) {
        if (!lease) throw new Error("Native MIDI notes require an active safety connection.");
        if (!Number.isFinite(durationMs) || durationMs > 5000) throw new Error("MIDI notes must finish within five seconds.");
        enqueue([{ op: "play", notes: [note], velocity, duration_ms: Math.max(10, Math.ceil(durationMs)) }]);
        return true;
      },
      stopNotes() {
        cancelPending();
        // Hot unplug must still reach the guard's token-checked disarm. The
        // native watchdog handles a device that vanished before this release.
        if (lease && output.state === "connected") enqueue([{ op: "panic" }]);
      },
      panic() { cancelPending(); enqueue([{ op: "panic" }]); return flush(); },
      send(bytes, timestamp) {
        if (timestamp !== undefined) throw new Error("Native MIDI schedules note releases through play, not browser timestamps.");
        const [status, number, value] = bytes, channel = (status & 15) + 1, kind = status & 0xf0;
        if (kind === 0xb0) enqueue([{ op: "cc", number, value }], channel);
        else if (kind === 0xc0) enqueue([{ op: "program", number }], channel);
        else if (kind === 0x80 || kind === 0x90 && value === 0) enqueue([{ op: "note_off", note: number }], channel);
        else throw new Error("Native note-on messages require a bounded duration.");
      },
      get pendingCount() { return queue.length; }
    });
    return output;
  }
  async function createAccess(options = {}) {
    const { send = request, schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id) } = options;
    let closed = false, timer = null, loading = null, signature = "";
    const access = { outputs: new Map(), onstatechange: null };
    async function refresh() {
      if (closed) return access;
      if (loading) return loading;
      cancel(timer); timer = null;
      loading = (async () => {
        const data = await send("ports");
        if (closed) return access;
        if (!Array.isArray(data.outputs)) throw new Error("Native MIDI returned an invalid device list.");
        const next = new Map();
        for (const info of data.outputs) {
          if (typeof info.id !== "string" || !info.id.startsWith("native:")) continue;
          const previous = access.outputs.get(info.id);
          const output = previous || createOutput(info, options);
          Object.assign(output, info, { state: "connected", transport: "native" }); next.set(info.id, output);
        }
        for (const [id, output] of access.outputs) if (!next.has(id)) { output.state = "disconnected"; output.cancelPending(); }
        access.outputs = next;
        const key = JSON.stringify(data.outputs);
        if (key !== signature) { signature = key; access.onstatechange?.(); }
        return access;
      })().catch(error => {
        if (!closed) {
          for (const output of access.outputs.values()) { output.state = "disconnected"; output.cancelPending(); }
          signature = ""; access.onstatechange?.(); options.onUnavailable?.(error);
        }
        throw error;
      }).finally(() => {
        loading = null;
        if (!closed) timer = schedule(() => { void refresh().catch(() => {}); }, 2000);
      });
      return loading;
    }
    Object.assign(access, { refresh, close() { closed = true; cancel(timer); for (const output of access.outputs.values()) output.cancelPending(); } });
    try { await refresh(); return access; }
    catch (error) { access.close(); throw error; }
  }
  return { createAccess, createOutput, MAX_QUEUE, MAX_BATCH };
})();
