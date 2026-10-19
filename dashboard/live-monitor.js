"use strict";

// The monitor only reads diagnostics. Pausing it never pauses incoming data or audio.
globalThis.HydraLiveMonitor = (() => {
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  function number(value) {
    if (!finite(value)) return "—";
    if (value === 0) return "0";
    if (Math.abs(value) >= 1e6 || Math.abs(value) < 0.001) return value.toExponential(2);
    return Number(value.toFixed(3)).toLocaleString("en", { maximumFractionDigits: 3 });
  }
  function age(value) {
    if (!finite(value)) return "No data yet";
    if (value < 1000) return "Just now";
    if (value < 60000) return `${(value / 1000).toFixed(1)}s ago`;
    return `${Math.floor(value / 60000)}m ${Math.floor(value / 1000) % 60}s ago`;
  }
  function signalName(field) {
    const name = String(field?.name || field?.fieldId || "Signal");
    return name === "data" ? "Data" : name.replace(/\b(position|velocity)\b/gi, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
  }
  function reduction(field) { return field && (field.reducer === "mean" || field.kind === "array" || field.kind === "tensor") ? "Mean" : "Value"; }
  function pathFor(points) {
    const safe = (points || []).filter((point) => Array.isArray(point) && finite(point[0]) && finite(point[1])).slice(-160);
    if (!safe.length) return "";
    const values = safe.map((point) => point[1]);
    const minimum = Math.min(...values), maximum = Math.max(...values);
    const start = safe[0][0], span = safe.at(-1)[0] - start;
    const halfSpan = maximum / 2 - minimum / 2;
    const y = (value) => halfSpan > 0 ? 68 - (value / 2 - minimum / 2) / halfSpan * 56 : 40;
    if (safe.length === 1) return `M0 ${y(safe[0][1]).toFixed(2)}H360`;
    return safe.map((point, index) => `${index ? "L" : "M"}${(span > 0 ? (point[0] - start) / span * 360 : index / (safe.length - 1) * 360).toFixed(2)} ${y(point[1]).toFixed(2)}`).join(" ");
  }
  function init({ container, getSnapshot, getInspection, onReconnect = () => {}, onClear = () => {} }) {
    if (!container) return { render() {}, reset() {} };
    container.classList.add("live-monitor");
    container.innerHTML = `<div class="lm-heading"><h3>Incoming data</h3><button id="lm-pause" class="small-button" type="button" aria-pressed="false" title="Pause the values and graph; incoming data and audio keep running.">Pause display</button></div>
      <div class="lm-state"><i id="lm-light" aria-hidden="true"></i><b id="lm-state">Not connected</b><span id="lm-paused" hidden>Display paused</span></div>
      <dl class="lm-stats"><div><dt>Messages / sec</dt><dd id="lm-rate">0</dd></div><div><dt>Channels · signals</dt><dd id="lm-counts">0 · 0</dd></div><div><dt>Last numeric data</dt><dd id="lm-age">No data yet</dd></div></dl>
      <p id="lm-empty" class="lm-empty">Connect a stream to see incoming values.</p>
      <div id="lm-data" hidden><div id="lm-channels" class="lm-channels" aria-label="Channel activity"></div>
        <div class="lm-selectors"><label for="lm-channel">Channel<select id="lm-channel"></select></label><label for="lm-field">Signal<select id="lm-field"></select></label></div>
        <div class="lm-reading"><div><strong id="lm-value">—</strong><span id="lm-reduction">Value</span></div><small id="lm-field-age"></small></div>
        <svg class="lm-scope" viewBox="0 0 360 80" preserveAspectRatio="none" role="img" aria-label="Recent incoming signal values"><path class="lm-scope-grid" d="M0 20H360 M0 40H360 M0 60H360 M90 0V80 M180 0V80 M270 0V80"/><path id="lm-scope-path" d=""/></svg>
        <div class="lm-range"><span id="lm-minimum">Min —</span><span>Recent values</span><span id="lm-maximum">Max —</span></div>
        <div id="lm-preview" class="lm-preview"></div>
        <details class="lm-values"><summary>Values in this channel <span id="lm-values-count"></span></summary><div class="lm-table-wrap"><table><thead><tr><th scope="col">Signal</th><th scope="col">Latest value</th></tr></thead><tbody id="lm-values"></tbody></table></div><p id="lm-values-more" class="lm-hint" hidden></p></details>
      </div>
      <details id="lm-troubleshooting" class="lm-troubleshooting"><summary>Troubleshooting <span id="lm-issue-count"></span></summary>
        <div class="lm-diagnostic"><b id="lm-diagnostic-title"></b><p id="lm-diagnostic-detail"></p></div>
        <div class="lm-actions"><button id="lm-reconnect" class="small-button" type="button">Reconnect</button><button id="lm-copy" class="small-button" type="button">Copy diagnostics</button><button id="lm-clear" class="small-button" type="button">Clear history</button></div>
        <p id="lm-action-status" class="lm-action-status" role="status"></p>
        <dl class="lm-diagnostic-counts"><div><dt>Messages</dt><dd id="lm-message-count">0</dd></div><div><dt>Data</dt><dd id="lm-data-count">0</dd></div><div><dt>Status</dt><dd id="lm-status-count">0</dd></div><div><dt>Invalid</dt><dd id="lm-invalid-count">0</dd></div><div><dt>No numbers</dt><dd id="lm-no-numeric-count">0</dd></div></dl>
        <div class="lm-events-heading">Recent connection events</div><ol id="lm-events" class="lm-events"></ol>
        <details class="lm-raw"><summary>Latest message <span id="lm-raw-meta"></span></summary><pre id="lm-raw">No messages received.</pre></details>
        <details class="lm-format"><summary>Expected message format</summary><pre>{"channel":"robot","labels":["joint_1","joint_2"],"data":[0.2,0.8],"velocity":[0.1,0.3]}</pre><p class="lm-hint">Send one JSON object per WebSocket message. Use numeric arrays in data, velocity, or tensors.name.data. Labels name the values.</p></details>
      </details>`;
    const $ = (id) => container.querySelector(`#${id}`);
    let paused = false, frozen = null, frozenInspection = null, channelKey = "", fieldKey = "", channelSignature = "", fieldSignature = "", channelActivitySignature = "", latest = null;
    function selectedFields(snapshot) { return (snapshot?.fields || []).filter((field) => field.channelId === channelKey); }
    function inspection() { return paused ? frozenInspection : getInspection?.(fieldKey); }
    function setOptions(element, items, selected, label) {
      element.innerHTML = items.map((item) => `<option value="${escape(item.id || item.key)}">${escape(label(item))}</option>`).join("");
      element.value = selected;
    }
    function renderData(snapshot) {
      const channels = snapshot.channels || [];
      $("lm-data").hidden = !channels.length;
      $("lm-empty").hidden = !!channels.length;
      $("lm-empty").textContent = snapshot.connected ? "Waiting for numeric signal values…" : "Connect a stream to see incoming values.";
      if (!channels.length) return;
      if (!channels.some((channel) => channel.id === channelKey)) channelKey = channels[0].id;
      const newChannelSignature = JSON.stringify(channels.map((channel) => [channel.id, channel.name]));
      if (newChannelSignature !== channelSignature) {
        setOptions($("lm-channel"), channels, channelKey, (channel) => channel.name || channel.id);
        channelSignature = newChannelSignature;
      }
      $("lm-channel").value = channelKey;
      const available = selectedFields(snapshot);
      if (!available.some((field) => field.key === fieldKey)) fieldKey = available[0]?.key || "";
      const newFieldSignature = JSON.stringify(available.map((field) => [field.key, signalName(field)]));
      if (newFieldSignature !== fieldSignature) {
        setOptions($("lm-field"), available, fieldKey, signalName);
        fieldSignature = newFieldSignature;
      }
      $("lm-field").value = fieldKey;
      $("lm-field").disabled = !available.length;
      const activitySignature = JSON.stringify([channelKey, channels.map((channel) => [channel.id, channel.name, channel.stale, channel.numeric])]);
      if (activitySignature !== channelActivitySignature) {
        $("lm-channels").innerHTML = channels.map((channel) => `<button type="button" data-lm-channel="${escape(channel.id)}" class="lm-channel${channel.stale ? " is-stale" : ""}${!channel.numeric ? " is-empty" : ""}" aria-pressed="${channel.id === channelKey}"><i aria-hidden="true"></i><span>${escape(channel.name || channel.id)}</span><small>${!channel.numeric ? "No numbers" : channel.stale ? "Stale" : "Live"}</small></button>`).join("");
        channelActivitySignature = activitySignature;
      }
      const field = available.find((item) => item.key === fieldKey), inspected = inspection();
      const selected = inspected?.key === fieldKey ? inspected : field;
      $("lm-value").textContent = number(selected?.value);
      $("lm-reduction").textContent = reduction(selected);
      $("lm-field-age").textContent = field ? `${field.stale ? "Stale · " : ""}${age(field.age)}` : "No numeric signals";
      $("lm-scope-path").setAttribute("d", pathFor(selected?.points));
      $("lm-scope-path").classList.toggle("is-stale", !!field?.stale);
      const points = (selected?.points || []).filter((point) => finite(point[1]));
      $("lm-minimum").textContent = `Min ${number(points.length ? Math.min(...points.map((point) => point[1])) : selected?.minimum)}`;
      $("lm-maximum").textContent = `Max ${number(points.length ? Math.max(...points.map((point) => point[1])) : selected?.maximum)}`;
      const preview = Array.isArray(selected?.preview) ? selected.preview : [];
      $("lm-preview").hidden = !preview.length || !(selected?.count > 1);
      $("lm-preview").textContent = `${selected?.count || preview.length} values · [${preview.map(number).join(", ")}${selected?.count > preview.length ? ", …" : ""}]`;
      $("lm-values-count").textContent = String(available.length);
      $("lm-values").innerHTML = available.slice(0, 32).map((item) => `<tr${item.stale ? ' class="is-stale"' : ""}><th scope="row">${escape(signalName(item))}${reduction(item) === "Mean" ? "<small>Mean</small>" : ""}</th><td>${escape(number(item.value))}${item.stale ? "<small>Stale</small>" : ""}</td></tr>`).join("");
      $("lm-values-more").hidden = available.length <= 32;
      $("lm-values-more").textContent = `Showing 32 of ${available.length} signals. Select any signal above to inspect it.`;
    }
    function renderDiagnostics(snapshot) {
      const counts = snapshot.counts || {};
      $("lm-diagnostic-title").textContent = snapshot.diagnostic?.title || "Ready to connect";
      $("lm-diagnostic-detail").textContent = snapshot.diagnostic?.detail || "Enter the stream address and connect.";
      $("lm-diagnostic-title").dataset.level = snapshot.diagnostic?.level || "info";
      $("lm-issue-count").textContent = counts.invalidFrames ? `${counts.invalidFrames} invalid` : "";
      $("lm-reconnect").disabled = !snapshot.url;
      $("lm-message-count").textContent = number(counts.messages || 0);
      $("lm-data-count").textContent = number(counts.dataFrames || 0);
      $("lm-status-count").textContent = number(counts.statusFrames || 0);
      $("lm-invalid-count").textContent = number(counts.invalidFrames || 0);
      $("lm-no-numeric-count").textContent = number(counts.noNumericFrames || 0);
      const events = (snapshot.events || []).slice(-12).reverse();
      $("lm-events").innerHTML = events.length ? events.map((event) => `<li data-level="${escape(event.level)}"><span>${escape(event.message)}${event.count > 1 ? ` ×${event.count}` : ""}</span><small>${finite(snapshot.now) && finite(event.at) ? escape(age(snapshot.now - event.at)) : ""}</small></li>`).join("") : "<li>No connection events yet.</li>";
      $("lm-raw").textContent = snapshot.raw?.text || "No messages received.";
      $("lm-raw-meta").textContent = snapshot.raw ? `${finite(snapshot.raw.bytes) ? `${number(snapshot.raw.bytes)} bytes` : `${number(snapshot.raw.length)} characters`}${snapshot.raw.truncated ? " · preview truncated" : ""}` : "";
    }
    function render() {
      const snapshot = getSnapshot?.();
      if (!snapshot) return;
      latest = snapshot;
      const numeric = snapshot.channels?.some((channel) => channel.numeric && !channel.stale);
      const title = snapshot.connected ? numeric ? "Receiving data" : snapshot.dataAge !== null && snapshot.dataAge !== undefined ? "Data is stale" : "Connected · waiting for data" : snapshot.state === "connecting" ? "Connecting…" : snapshot.state === "error" ? "Connection error" : "Not connected";
      $("lm-state").textContent = title;
      $("lm-light").dataset.state = snapshot.connected && numeric ? "live" : snapshot.connected || snapshot.state === "connecting" ? "waiting" : "offline";
      $("lm-rate").textContent = Number(snapshot.rate || 0).toFixed(1);
      $("lm-counts").textContent = `${snapshot.channels?.length || 0} · ${snapshot.fields?.length || 0}`;
      $("lm-age").textContent = age(snapshot.dataAge);
      renderData(paused ? frozen : snapshot);
      renderDiagnostics(snapshot);
    }
    $("lm-channel").addEventListener("change", (event) => { channelKey = event.target.value; fieldKey = ""; frozenInspection = null; render(); });
    $("lm-field").addEventListener("change", (event) => { fieldKey = event.target.value; frozenInspection = null; render(); });
    $("lm-channels").addEventListener("click", (event) => {
      const button = event.target.closest("[data-lm-channel]");
      if (!button) return;
      channelKey = button.dataset.lmChannel; fieldKey = ""; frozenInspection = null; render();
    });
    $("lm-pause").addEventListener("click", () => {
      paused = !paused;
      frozen = paused ? latest : null;
      frozenInspection = paused ? getInspection?.(fieldKey) : null;
      $("lm-pause").setAttribute("aria-pressed", String(paused));
      $("lm-pause").textContent = paused ? "Resume display" : "Pause display";
      $("lm-paused").hidden = !paused;
      render();
    });
    $("lm-reconnect").addEventListener("click", () => { onReconnect(); render(); });
    $("lm-clear").addEventListener("click", () => { onClear(); if (paused) { frozen = getSnapshot?.(); frozenInspection = null; } $("lm-action-status").textContent = "Diagnostic history cleared."; render(); });
    $("lm-copy").addEventListener("click", async () => {
      const snapshot = { ...getSnapshot?.() };
      try { const address = new URL(snapshot.url); address.username = ""; address.password = ""; address.search = ""; address.hash = ""; snapshot.url = address.href; } catch (_) { snapshot.url = ""; }
      const contents = JSON.stringify({ exportedAt: new Date().toISOString(), ...snapshot }, null, 2);
      try {
        await navigator.clipboard.writeText(contents);
        $("lm-action-status").textContent = "Diagnostics copied.";
      } catch (_) {
        try {
          const blob = new Blob([contents], { type: "application/json" });
          const url = URL.createObjectURL(blob), anchor = container.ownerDocument.createElement("a");
          anchor.href = url; anchor.download = "hydra-live-diagnostics.json"; anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          $("lm-action-status").textContent = "Diagnostics downloaded.";
        } catch (_) { $("lm-action-status").textContent = "Could not copy diagnostics. Select the details below to copy them."; }
      }
    });
    render();
    return { render, reset() {
      paused = false; frozen = null; frozenInspection = null; channelKey = ""; fieldKey = "";
      $("lm-pause").setAttribute("aria-pressed", "false"); $("lm-pause").textContent = "Pause display";
      $("lm-paused").hidden = true; $("lm-action-status").textContent = "";
      render();
    } };
  }
  return { init };
})();
