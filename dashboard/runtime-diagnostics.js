"use strict";

// Small, bounded health samples. This never captures input values, MIDI, live
// frames, audio, error messages, URLs or study events.
(function (root) {
  const INTERVAL_MS = 5000;
  function create(host) {
    let interval = null, request = null, timeout = null, stopped = true, sequence = 0;
    let lastTick = 0, errorCount = 0, rejectionCount = 0, sendFailures = 0;
    const errors = [];
    const clientId = host.crypto.randomUUID();
    const now = () => host.performance.now();
    function error(event) {
      errorCount += 1;
      // Only static script names and numeric locations; exception text can
      // contain a provider response, user text or credentials.
      const filename = String(event.filename || "").split(/[?#]/, 1)[0].split("/").pop();
      if (/^[a-zA-Z0-9_-]{1,80}\.js$/.test(filename)) {
        errors.push({ file: filename, line: Number(event.lineno) || 0, column: Number(event.colno) || 0 });
        if (errors.length > 8) errors.shift();
      }
    }
    function rejection() { rejectionCount += 1; }
    function sample(reason = "heartbeat") {
      const tick = now(), memory = host.performance.memory;
      const canvases = host.document.getElementsByTagName("canvas");
      let canvasPixels = 0;
      for (const canvas of canvases) canvasPixels += Number(canvas.width) * Number(canvas.height);
      const result = {
        client_id: clientId, sequence: sequence++, reason,
        uptime_ms: Math.round(tick), tick_late_ms: Math.round(Math.max(0, tick - lastTick - INTERVAL_MS)),
        visibility: host.document.visibilityState === "hidden" ? "hidden" : "visible",
        dom_nodes: host.document.getElementsByTagName("*").length,
        canvas_count: canvases.length, canvas_pixels: canvasPixels,
        error_count: errorCount, rejection_count: rejectionCount, send_failures: sendFailures,
        errors: errors.slice(),
      };
      for (const [key, field] of [["heap_used_bytes", "usedJSHeapSize"], ["heap_total_bytes", "totalJSHeapSize"], ["heap_limit_bytes", "jsHeapSizeLimit"]]) {
        if (Number.isFinite(memory?.[field])) result[key] = memory[field];
      }
      lastTick = tick;
      return result;
    }
    async function send() {
      if (stopped || request) return;
      const controller = new host.AbortController();
      request = controller;
      timeout = host.setTimeout(() => controller.abort(), 3000);
      try {
        const response = await host.fetch("/api/runtime-diagnostics/sample", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sample()), signal: controller.signal, cache: "no-store",
        });
        if (!response.ok) sendFailures += 1;
      } catch (_) { sendFailures += 1; }
      finally {
        host.clearTimeout(timeout);
        timeout = null;
        request = null;
      }
    }
    function pagehide(event = {}) {
      if (stopped) return;
      try {
        host.navigator.sendBeacon("/api/runtime-diagnostics/sample",
          new host.Blob([JSON.stringify(sample("pagehide"))], { type: "application/json" }));
      } catch (_) {}
      stop();
      if (event.persisted) host.addEventListener("pageshow", start, { once: true });
    }
    function start() {
      if (!stopped) return;
      stopped = false;
      lastTick = now();
      host.addEventListener("error", error, true);
      host.addEventListener("unhandledrejection", rejection);
      host.addEventListener("pagehide", pagehide);
      interval = host.setInterval(() => { void send(); }, INTERVAL_MS);
      void send();
    }
    function stop() {
      stopped = true;
      host.clearInterval(interval);
      host.clearTimeout(timeout);
      request?.abort();
      host.removeEventListener("error", error, true);
      host.removeEventListener("unhandledrejection", rejection);
      host.removeEventListener("pagehide", pagehide);
    }
    return { start, stop };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { create, INTERVAL_MS };
  else if (root.document && root.crypto?.randomUUID) {
    try { create(root).start(); } catch (_) {} // Diagnostics must never prevent startup.
  }
})(globalThis);
