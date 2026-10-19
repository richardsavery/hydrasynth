"use strict";

// Shared robot connection and setup. Navigation does not end this session.
globalThis.HydraRobotControl = (() => {
  const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const cancelled = () => Object.assign(new Error("Robot workspace changed."), { cancelled: true });
  let root, initialized = false, active = false, generation = 0, sessionGeneration = 0, busy = false, activation;
  let state = { motors: [], armed: true, emergency_stopped: false, ribs: { state: "unchecked", ports: [], motors: [] }, head: { state: "unchecked", ports: [], motors: [] }, drums: { state: "unchecked", ports: [], motors: [] } };
  let queue = Promise.resolve(), midiAccess, midiPending = false, midiRequest, midiError = "";
  let ribDevice = "", ribsStale = false, ribsManual = false;
  const serial = { head: { device: "", baudrate: 57600, stale: false, manual: false }, drums: { device: "", baudrate: 1000000, stale: false, manual: false } };
  const diagnosticBusy = new Map();
  const baudrates = [57600, 115200, 1000000, 2000000, 3000000, 4000000];
  const drafts = new Map(), history = [], listeners = new Set();
  const headLabels = new Map(), calibrationActions = new Set();
  let calibrationTableKey = "", calibrationTimer, calibrationPollPending = false, calibrationRevision = 0, calibrationFailures = 0, calibrationError = "";
  let calibrationMutationQueue = Promise.resolve();
  let emergencyPending, emergencyResetPending = false, emergencyResetRequest, emergencyRevision = 0, statusTimer, statusPollPending = false;
  let drumsTimer, drumsPollPending = false, drumsPollFailures = 0;
  let headTimer, headPollPending = false, headPollFailures = 0, headRevision = 0;
  let preparation, preparationQueue = Promise.resolve();
  let drumStart, drumStartQueue = Promise.resolve(), drumClockOffset = null;
  let drumPerformance = null;
  let drumResponseRevision = 0;
  const drumStops = new Map();
  let headRelease, releasedHeadMove = "";
  const preparations = new Set();
  const liveCommands = new Map();
  const commandBusy = () => busy || preparations.size > 0;
  const headCommandBusy = () => commandBusy() || liveCommands.has("head") || Boolean(headRelease)
    || diagnosticBusy.has("head") || calibrationActions.size > 0 || state.head?.calibration?.recording === true;
  const workBusy = () => commandBusy() || liveCommands.size > 0 || Boolean(headRelease);
  const responseRevisions = new WeakMap();
  const responseCurrent = result => !result || !responseRevisions.has(result) || responseRevisions.get(result) === emergencyRevision;
  const $ = name => root.querySelector(`#robot-${name}`);
  const isCurrent = token => active && token === generation;
  const ribsReady = () => !ribsStale && state.ribs?.state === "ready" && state.ribs.device === ribDevice;
  const serialSelected = group => !serial[group].stale && Boolean(serial[group].device) && state[group]?.device === serial[group].device && state[group]?.baudrate === serial[group].baudrate;
  const serialReady = group => serialSelected(group) && state[group]?.state === "ready";
  const drumPerformanceConnected = () => active && serialSelected("drums") && state.drums?.port_open === true;

  function snapshot() {
    const output = pimoroniOutput(), readings = state.ribs?.motors || [], head = state.head || {}, headMotors = head.motors || [];
    const headMoveKey = head.last_move ? JSON.stringify([head.device, head.last_move.motor_id, head.last_move.position, head.last_move.targets, head.last_move.started_at]) : "";
    // Once both axes are released, that target no longer predicts their pose.
    // Keep ignoring it through manual positioning and torque-on, even if the
    // old profile's nominal duration has not elapsed yet.
    if (headMotors.length === 2 && headMotors.every(motor => motor.connected && motor.torque_enabled === false)) releasedHeadMove = headMoveKey;
    return { active, armed: active && !state.emergency_stopped, emergencyStopped: state.emergency_stopped,
      emergencyPending: Boolean(emergencyPending), emergencyResetPending, busy: workBusy(), ribsReady: active && ribsReady(),
      torqueEnabled: readings.length === 6 && readings.every(motor => motor.connected && motor.torque_enabled === true),
      commandBusy: commandBusy(), ribsBusy: commandBusy() || liveCommands.has("ribs"), headCommandBusy: headCommandBusy(), headBusy: headCommandBusy() || Boolean(head.busy),
      headMotion: Array.isArray(head.motion) ? head.motion.map(motion => ({ ...motion })) : [],
      headConnected: active && headConnected(), headReady: active && !liveHeadError(),
      headTorqueEnabled: headMotors.length === 2 && headMotors.every(motor => motor.connected && motor.torque_enabled === true),
      headCalibration: savedHeadCalibration(), headPositions: Object.fromEntries(headMotors.map(motor => [motor.id, Number.isInteger(motor.position) ? motor.position : null])),
      headRecording: head.calibration?.recording === true, headError: liveHeadError(), headLastMove: headMoveKey && headMoveKey !== releasedHeadMove
        ? { ...head.last_move, ...(Array.isArray(head.last_move.targets) ? { targets: head.last_move.targets.map(target => ({ ...target })) } : {}) } : null,
      headCheckedAt: head.checked_at || null,
      drumsReady: active && serialReady("drums"),
      drumTorqueEnabled: state.drums?.motors?.length === 4 && state.drums.motors.every(motor => motor.connected && motor.torque_enabled === true),
      drumPerformanceConnected: drumPerformanceConnected(),
      drumsBusy: Boolean(state.drums?.busy || drumStart || drumPerformance?.busy),
      drumPerformance: drumPerformance ? { ...drumPerformance } : null,
      ledConnected: Boolean(active && output), ledName: output?.name || "", error: midiError };
  }

  function publish() { for (const listener of listeners) listener(snapshot()); }
  function subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); }

  async function request(path, body, options = {}) {
    const revision = emergencyRevision;
    const response = await fetch(`/api/robot/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...options
    });
    let result;
    try { result = await response.json(); }
    catch (_) { throw new Error("Robot service returned an unreadable response."); }
    if (revision !== emergencyRevision) throw cancelled();
    responseRevisions.set(result, revision);
    if (result.emergency_stopped === true) { reconcileEmergency(result); updateControls(); }
    if (!response.ok || result.ok === false) throw Object.assign(new Error(result.error || result.message || `Robot request failed (${response.status}).`), { result });
    return result;
  }

  function reconcileEmergency(result, reset = false) {
    if (!responseCurrent(result)) return;
    if (result?.emergency_stopped === true) {
      if (!state.emergency_stopped) {
        state.emergency_stopped = true; state.armed = false; generation++; busy = false; calibrationRevision++;
        for (const entry of preparations) entry.abort();
        globalThis.HydraRobotLive?.stop();
        globalThis.HydraRobotDrums?.stop();
      }
    } else if (reset && result?.emergency_stopped === false) state.emergency_stopped = false;
    state.armed = !state.emergency_stopped;
  }

  async function pollEmergencyStatus() {
    if (!active || statusPollPending) return;
    statusPollPending = true;
    try {
      const result = await request("status");
      if (active && responseCurrent(result)) {
        reconcileEmergency(result);
        if (result.emergency_stopped === true) {
          for (const group of ["ribs", "head", "drums"]) if (result[group]) state[group] = result[group];
          renderConnections();
        }
        updateControls();
      }
    } catch (_) { /* Explicit commands report connection failures; cached status polling retries. */ }
    finally { statusPollPending = false; }
  }

  // Normal motor requests stay ordered; emergency stop bypasses this queue.
  function queuedRequest(path, body, token, options, guard) {
    const operation = queue.catch(() => {}).then(() => {
      if (token !== undefined && !isCurrent(token)) throw cancelled();
      guard?.();
      return request(path, body, options);
    });
    queue = operation.catch(() => {});
    return operation;
  }

  function notice(message, error = false) {
    $("status").textContent = message;
    $("status").classList.toggle("is-error", error);
  }

  function addHistory(label, details, error = false) {
    history.unshift({ label, details, error });
    history.splice(30);
    $("history").innerHTML = history.map(item => `<li class="${item.error ? "is-error" : ""}"><span class="robot-log-kind">${item.error ? "Error" : "Sent"}</span><div><strong>${escape(item.label)}</strong><code>${escape(item.details)}</code></div></li>`).join("");
    $("history-empty").hidden = history.length > 0;
  }

  function updateControls() {
    if (!initialized) return;
    const busy = workBusy();
    $("badge").textContent = state.emergency_stopped ? "Emergency stop active" : "Motor controls ready";
    $("badge").classList.toggle("is-error", state.emergency_stopped);
    $("emergency-stop").disabled = !active || Boolean(emergencyPending);
    $("emergency-reset").hidden = !state.emergency_stopped;
    $("emergency-reset").disabled = !active || Boolean(emergencyPending) || emergencyResetPending;
    $("torque-on").disabled = !active || busy || state.emergency_stopped || !ribsReady() || !state.motors.length;
    $("release").disabled = !active || busy || !state.motors.length;
    $("ribs-device").disabled = busy;
    $("ribs-check").disabled = !active || busy || !ribDevice;
    $("ribs-disconnect").disabled = !active || busy;
    for (const group of ["head", "drums"]) {
      const pending = busy || diagnosticBusy.has(group) || (group === "head" && calibrationActions.size > 0) || (group === "drums" && Boolean(drumStart || drumPerformance?.busy));
      $(`${group}-device`).disabled = pending;
      $(`${group}-baudrate`).disabled = pending;
      $(`${group}-check`).disabled = !active || pending || !serial[group].device;
      $(`${group}-disconnect`).disabled = !active || (group === "drums" ? busy || diagnosticBusy.has(group) : pending);
      $(`${group}-refresh`).disabled = !active || busy || diagnosticBusy.size > 0;
    }
    $("head-upright").disabled = !active || busy || diagnosticBusy.has("head") || calibrationActions.size > 0 || !serialReady("head");
    $("head-release").hidden = !(state.head?.motors || []).some(motor => motor.torque_enabled === true);
    $("head-release").disabled = !active || busy || diagnosticBusy.has("head") || calibrationActions.size > 0 || !serialSelected("head");
    updateCalibrationControls();
    $("drums-torque-on").disabled = !active || busy || state.drums?.busy || diagnosticBusy.has("drums") || state.emergency_stopped || !serialReady("drums");
    $("drums-release").disabled = !active || busy || diagnosticBusy.has("drums") || !serialSelected("drums");
    $("refresh").disabled = !active || busy || diagnosticBusy.size > 0;
    for (const button of root.querySelectorAll("[data-robot-test]")) {
      const motor = state.motors.find(item => item.id === Number(button.dataset.motorId));
      const reason = button.dataset.robotTest === "ribs" ? !ribsReady() || !snapshot().torqueEnabled || state.emergency_stopped : motorTestError(motor, button.dataset.robotTest === "strike");
      button.disabled = !active || busy || Boolean(reason);
    }
    renderDrumReadings();
    updateLEDControls();
    $("motor-hint").textContent = state.emergency_stopped ? "Reset the emergency stop, then turn torque on for the motors you want to use." : "Connect a motor group and turn its torque on to test it.";
  }

  function motorTestError(motor, strike = false) {
    if (!motor || motor.group === "head") return "Head movement is disabled.";
    if (state.emergency_stopped) return "Reset the emergency stop in Keirzo setup or control.";
    const group = motor.group;
    if (group === "drums" && (drumStart || drumPerformance?.busy)) return "Stop automatic drumming before testing an arm.";
    if (group === "drums" && (state.drums?.busy || diagnosticBusy.has("drums"))) return "Wait for the arm test to finish.";
    if (!(group === "ribs" ? ribsReady() : serialReady("drums"))) return "Check this motor group’s connection.";
    const reading = state[group]?.motors?.find(item => item.id === motor.id);
    if (!reading?.connected) return "Motor is not responding.";
    if (reading.torque_enabled !== true) return "Turn torque on for this motor group.";
    if (strike && (!Number.isInteger(reading.position) || reading.position < motor.min || reading.position > motor.max)) return `Measured position ${reading.position ?? "unknown"} is outside ${motor.min}–${motor.max}. Use Arm torque on + rest to return the arms before a strike.`;
    return "";
  }

  function renderDrumReadings() {
    for (const motor of state.motors.filter(item => item.group === "drums")) {
      const reading = state.drums?.motors?.find(item => item.id === motor.id), strike = state.drums?.strike || {};
      $(`motor-readback-${motor.id}`).textContent = `Measured ${Number.isInteger(reading?.position) ? reading.position : "—"} · Torque ${reading?.torque_enabled === true ? "on" : reading?.torque_enabled === false ? "off" : "unknown"}`;
      const progress = strike.motor_id === motor.id ? { preparing: "Raising to rest…", striking: "Striking…", returning: "Returning to raised rest…", complete: "Raise, strike and return commands complete.", cancelled: "Strike cancelled.", error: strike.error || "Strike failed." }[strike.state] : "";
      $(`strike-reason-${motor.id}`).textContent = (state.drums?.busy && progress) || motorTestError(motor, true) || progress || `Rest (up) ${motor.rest} → hit (down) ${motor.strike} → rest.`;
    }
  }

  function motorHTML(motor) {
    const id = Number(motor.id);
    if (!drafts.has(id)) drafts.set(id, { position: motor.default, duration: motor.duration_ms || 1000 });
    const draft = drafts.get(id);
    return `<article class="robot-motor" data-robot-motor="${id}">
      <header><h3>${escape(motor.name)}</h3><span>Motor ${id}</span></header>
      ${motor.group === "drums" ? `<p id="robot-motor-readback-${id}" class="robot-note"></p><button type="button" class="robot-button robot-test" data-robot-test="strike" data-motor-id="${id}">Test strike</button><p id="robot-strike-reason-${id}" class="robot-note" role="status"></p><details class="robot-motor-advanced"><summary>Advanced position test</summary>` : ""}
      <div class="robot-position-label"><label for="robot-position-${id}">Position</label><output id="robot-value-${id}" for="robot-position-${id}">${escape(draft.position)}</output></div>
      <input id="robot-position-${id}" data-robot-position="${id}" type="range" min="${motor.min}" max="${motor.max}" step="1" value="${escape(draft.position)}">
      <div class="robot-range"><span>${motor.min}</span><span>${motor.max}</span></div>
      <div class="robot-pair"><label for="robot-number-${id}">Position value<input id="robot-number-${id}" data-robot-number="${id}" type="number" min="${motor.min}" max="${motor.max}" step="1" value="${escape(draft.position)}"></label><label for="robot-duration-${id}">Duration (ms)<input id="robot-duration-${id}" data-robot-duration="${id}" type="number" min="100" max="5000" step="1" value="${escape(draft.duration)}"></label></div>
      <div class="robot-presets"><button type="button" class="robot-button robot-subtle" data-robot-preset="${id}" data-position="${motor.default}">Set default</button>${["rest", "strike"].filter(key => Number.isInteger(motor[key]) && motor[key] >= motor.min && motor[key] <= motor.max).map(key => `<button type="button" class="robot-button robot-subtle" data-robot-preset="${id}" data-position="${motor[key]}">Set ${key === "rest" ? "rest (up)" : "hit (down)"} · ${motor[key]}</button>`).join("")}</div>
      <button type="button" class="robot-button robot-test" data-robot-test="move" data-motor-id="${id}">Test position</button>
      <p class="robot-range-source">${escape(motor.range_source || "Range from robot configuration")}</p>
      ${motor.group === "drums" ? "</details>" : ""}
    </article>`;
  }

  function renderMotors() {
    for (const group of ["drums", "ribs"]) {
      const motors = state.motors.filter(motor => motor.group === group);
      $(`${group}-motors`).innerHTML = motors.map(motorHTML).join("") || '<p class="robot-empty">Motor controls load when the robot service is available.</p>';
      $(`${group}-count`).textContent = `${motors.length} motors`;
    }
    $("ribs-test").hidden = !state.motors.some(motor => motor.group === "ribs");
    updateControls();
  }

  function applyStatus(result) {
    if (!responseCurrent(result)) return;
    if (result.status && typeof result.status === "object") result = { ...result.status, ...result };
    reconcileEmergency(result);
    const stopped = state.emergency_stopped;
    if (result.head) headRevision++;
    if (result.drums?.performance) drumPerformance = result.drums.performance;
    state = { ...state, ...result, emergency_stopped: stopped, armed: !stopped, motors: Array.isArray(result.motors) ? result.motors : state.motors };
    renderConnections(); renderMotors();
  }

  function renderConnections() { renderRibs(); renderSerial("head"); renderSerial("drums"); }

  function canFollowPreferred(result, manual) {
    return !manual && result.port_open !== true && (!result.checked_at || (result.port_open === false && result.state === "disconnected"));
  }

  function preferredNote(result) {
    const preferred = result.preferred_connection;
    if (!preferred) return "";
    const name = preferred.label || "Saved USB adapter", identity = preferred.identity?.serial_number;
    if (preferred.state === "matched" && preferred.device) return `${name}${identity ? ` · USB serial ${identity}` : ""} · ${preferred.device}. Recognized automatically; check the connection before use.`;
    return `${name}${identity ? ` · USB serial ${identity}` : ""}: ${preferred.message || "The saved adapter could not be uniquely identified. Connect it and refresh ports."}`;
  }

  function serialConnectionHTML(group, label, identify = false) {
    return `<div class="robot-rib-connection"><div class="robot-serial-fields"><label for="robot-${group}-device">${label} serial port<select id="robot-${group}-device"><option value="">Choose the ${label.toLowerCase()} serial port…</option></select></label><label for="robot-${group}-baudrate">Baud rate<select id="robot-${group}-baudrate">${baudrates.map(baudrate => `<option value="${baudrate}">${baudrate.toLocaleString()}</option>`).join("")}</select></label></div><div class="robot-actions"><button id="robot-${group}-check" class="robot-button robot-test" type="button">${identify ? "Identify head" : "Check connection"}</button><button id="robot-${group}-refresh" class="robot-button robot-subtle" type="button" data-robot-refresh="">Refresh ports</button><button id="robot-${group}-disconnect" class="robot-button robot-subtle" type="button">Disconnect</button></div><div class="robot-rib-status"><span id="robot-${group}-state" class="robot-badge">Not checked</span><span>${identify ? "Read only" : "Direct USB"}</span></div><p id="robot-${group}-message" class="robot-note" role="status" aria-live="polite"></p><p id="robot-${group}-identity" class="robot-note" hidden></p><p id="robot-${group}-checked" class="robot-note robot-checked">Not checked yet. Readings are not live feedback.</p><div id="robot-${group}-readback" class="robot-rib-readback" hidden><table><caption>Last measured motor values</caption><thead><tr><th scope="col">Motor</th>${identify ? '<th scope="col">Model</th><th scope="col">Firmware</th>' : ""}<th scope="col">Connection</th><th scope="col">Position</th><th scope="col">Torque</th><th scope="col">Modes</th><th scope="col">Error</th></tr></thead><tbody id="robot-${group}-readings"></tbody></table></div></div>`;
  }

  function renderSerial(group) {
    const result = state[group] || {}, selection = serial[group];
    const preferred = result.preferred_connection;
    if (preferred && canFollowPreferred(result, selection.manual)) {
      selection.device = preferred.state === "matched" ? preferred.device || "" : "";
      if (baudrates.includes(preferred.baudrate)) selection.baudrate = preferred.baudrate;
    // Reuse a bus that was explicitly checked on the server; never guess an unknown port.
    } else if (!selection.device && !selection.stale && !selection.manual && result.checked_at && result.device && baudrates.includes(result.baudrate)) {
      selection.device = result.device; selection.baudrate = result.baudrate;
    }
    if (group === "drums" && !preferred && !selection.device && !selection.stale && !selection.manual) selection.device = result.device || "";
    const ports = [...new Set([selection.device, result.device, ...["head", "drums", "ribs"].flatMap(key => state[key]?.ports || [])].filter(Boolean))];
    const label = group === "head" ? "head" : "drumming arms";
    $(`${group}-device`).innerHTML = `<option value="">Choose the ${label} serial port…</option>` + ports.map(port => `<option value="${escape(port)}">${escape(port)}</option>`).join("");
    $(`${group}-device`).value = selection.device;
    $(`${group}-baudrate`).value = String(selection.baudrate);
    const stale = selection.stale || Boolean(result.checked_at && (result.device !== selection.device || result.baudrate !== selection.baudrate));
    const stateLabel = { unchecked: "Not checked", ready: "Connected", partial: "Partial connection", disconnected: "Disconnected", error: "Connection error" };
    $(`${group}-state`).textContent = stale ? "Check required" : stateLabel[result.state] || "Not checked";
    const hasError = !stale && ["partial", "disconnected", "error"].includes(result.state);
    $(`${group}-state`).classList.toggle("is-error", hasError);
    $(`${group}-message`).classList.toggle("is-error", hasError);
    $(`${group}-message`).textContent = stale ? "Port or baud rate changed. Check this connection before continuing." : result.message || (group === "head" ? "Choose the head’s USB adapter, then identify its two motor IDs. The scan only reads motor information." : "Check the four arm motors on their separate USB adapter.");
    $(`${group}-identity`).textContent = preferredNote(result);
    $(`${group}-identity`).hidden = !preferred;
    const date = result.checked_at ? new Date(result.checked_at) : null;
    $(`${group}-checked`).textContent = `${date ? `Last checked: ${Number.isNaN(date.getTime()) ? result.checked_at : date.toLocaleString()} · ${result.device || ""} · ${result.baudrate?.toLocaleString() || "?"} baud` : "Not checked yet"}. Readings update only when checked; they are not live feedback.`;
    const readings = Array.isArray(result.motors) ? result.motors : [];
    $(`${group}-readings`).innerHTML = readings.map(motor => `<tr><th scope="row">${escape(motor.id)}</th>${group === "head" ? `<td>${motor.model_number === 1090 ? "2XL430-W250-T (1090)" : escape(motor.model_number ?? "—")}</td><td>${escape(motor.firmware ?? "—")}</td>` : ""}<td>${motor.connected ? "Responding" : motor.error ? "No response" : "Not checked"}</td><td>${Number.isInteger(motor.position) ? motor.position : "—"}</td><td>${motor.torque_enabled === true ? "On" : motor.torque_enabled === false ? "Off" : "Unknown"}</td><td>${escape(motor.profile_mode ?? "—")} / ${escape(motor.operating_mode ?? "—")}</td><td>${escape(motor.error || "—")}</td></tr>`).join("");
    $(`${group}-readback`).hidden = readings.length === 0;
    if (group === "head") {
      const reference = result.upright_reference;
      $("head-reference").textContent = reference ? `Upright reference: ${(reference.positions || []).map(motor => `motor ${motor.id} = ${motor.position}`).join(" · ")}. Recorded ${new Date(reference.recorded_at).toLocaleString()} · ${reference.device} · ${reference.baudrate?.toLocaleString()} baud. This records the current position, not movement limits.` : "No upright reference recorded yet. Leave the head upright, identify it, then record its current position.";
      renderCalibration(); syncHeadPolling();
    }
    if (group === "drums") syncDrumsPolling();
  }

  function stopHeadPolling() {
    if (headTimer !== undefined) clearTimeout(headTimer);
    headTimer = undefined;
  }

  function syncHeadPolling() {
    if (!active || !state.head?.busy) { stopHeadPolling(); return; }
    if (headTimer !== undefined || headPollPending) return;
    headTimer = setTimeout(pollHead, Math.min(2000, 250 * 2 ** headPollFailures));
  }

  async function pollHead() {
    headTimer = undefined;
    if (!active || !state.head?.busy || headPollPending) return;
    const token = generation, revision = headRevision;
    headPollPending = true;
    try {
      const result = await request("head/status");
      if (!isCurrent(token) || revision !== headRevision || !responseCurrent(result)) return;
      if (result.head) state.head = result.head;
      headPollFailures = 0; renderSerial("head"); updateControls();
    } catch (error) {
      if (!isCurrent(token) || revision !== headRevision || error.cancelled) return;
      headPollFailures = Math.min(4, headPollFailures + 1);
      notice(`Could not refresh head movement: ${error.message}. Retrying…`, true);
      updateControls();
    } finally { headPollPending = false; syncHeadPolling(); }
  }

  function stopDrumsPolling() {
    if (drumsTimer !== undefined) clearTimeout(drumsTimer);
    drumsTimer = undefined;
  }

  function syncDrumsPolling() {
    // Active performance heartbeats already refresh these readings. After
    // Stop, continue cached polling until any in-flight returns have finished.
    if (["preparing", "ready"].includes(drumPerformance?.state)) { stopDrumsPolling(); return; }
    if (!active || !state.drums?.busy) { stopDrumsPolling(); return; }
    if (drumsTimer !== undefined || drumsPollPending) return;
    drumsTimer = setTimeout(pollDrums, Math.min(2000, 200 * 2 ** drumsPollFailures));
  }

  async function pollDrums() {
    drumsTimer = undefined;
    if (!active || !state.drums?.busy || drumsPollPending) return;
    const token = generation, revision = drumResponseRevision;
    drumsPollPending = true;
    try {
      const result = await request("drums/status");
      if (!isCurrent(token) || revision !== drumResponseRevision || !responseCurrent(result)) return;
      if (result.drums) state.drums = result.drums;
      if (result.drums?.performance) drumPerformance = result.drums.performance;
      drumsPollFailures = 0; renderSerial("drums"); updateControls();
    } catch (error) {
      if (!isCurrent(token) || revision !== drumResponseRevision || error.cancelled) return;
      drumsPollFailures = Math.min(4, drumsPollFailures + 1);
      if (error.result?.drums) state.drums = error.result.drums;
      notice(`Could not refresh arm test: ${error.message}`, true); updateControls();
    } finally { drumsPollPending = false; syncDrumsPolling(); }
  }

  function calibrationHTML() {
    return `<section class="robot-head-calibration" aria-labelledby="robot-head-calibration-title"><header><h3 id="robot-head-calibration-title">Record head range</h3><span id="robot-head-calibration-state" class="robot-badge">Not recording</span></header><p class="robot-note">Start upright, then move each axis gently through the intended range. Stop before resistance.</p><div class="robot-actions"><button id="robot-head-calibration-start" class="robot-button robot-test" type="button">Start recording</button><button id="robot-head-calibration-stop" class="robot-button" type="button">Stop recording</button><button id="robot-head-calibration-centre" class="robot-button" type="button">Capture centre</button><button id="robot-head-calibration-save" class="robot-button robot-primary" type="button">Save range</button></div><p id="robot-head-calibration-message" class="robot-note" role="status" aria-live="polite"></p><p id="robot-head-calibration-sampled" class="robot-note robot-checked"></p><div id="robot-head-calibration-readback" class="robot-rib-readback" hidden><table><caption>Manually measured travel, in motor position units</caption><thead><tr><th scope="col">Motor</th><th scope="col">Axis name</th><th scope="col">Current</th><th scope="col">Minimum</th><th scope="col">Centre</th><th scope="col">Maximum</th></tr></thead><tbody id="robot-head-calibration-axes"></tbody></table></div><p id="robot-head-calibration-saved" class="robot-note robot-saved-range"></p><p class="robot-note">Recording reads positions with torque off. Release head torque before moving it by hand.</p></section>`;
  }

  function headTorqueOff() {
    const motors = state.head?.motors || [];
    return motors.length === 2 && motors.every(motor => motor.connected && motor.torque_enabled === false);
  }

  function savedHeadCalibration() {
    const saved = state.head?.calibration?.saved;
    if (!saved || typeof saved.device !== "string" || !saved.device || !baudrates.includes(saved.baudrate) || saved.axes?.length !== 2) return null;
    const ids = new Set();
    for (const axis of saved.axes) {
      if (!Number.isInteger(axis.id) || axis.id < 0 || axis.id > 252 || ids.has(axis.id) || ![axis.min, axis.centre, axis.max].every(Number.isInteger) || axis.min < 0 || axis.max > 4095 || axis.min >= axis.max || axis.centre < axis.min || axis.centre > axis.max) return null;
      ids.add(axis.id);
    }
    return { device: saved.device, baudrate: saved.baudrate, axes: saved.axes.map(({ id, label, min, centre, max }) => ({ id, label: label || `Motor ${id}`, min, centre, max })) };
  }

  function headConnected() {
    const motors = state.head?.motors || [];
    return serialReady("head") && motors.length === 2 && new Set(motors.map(motor => motor.id)).size === 2 && motors.every(motor => motor.connected && motor.model_number === 1090 && !motor.error);
  }

  function savedHeadConnection(saved) {
    const connection = state.head?.calibration?.saved_connection;
    if (!connection) return { device: saved?.device, error: "" };
    if (connection.state !== "matched" || typeof connection.device !== "string" || !connection.device) return { device: null, error: connection.message || "The USB adapter for the saved head ranges could not be uniquely identified. Connect it and refresh ports." };
    return { device: connection.device, error: "" };
  }

  function liveHeadError() {
    const head = state.head || {}, saved = savedHeadCalibration();
    if (!saved) return head.calibration?.storage_error || "Record and save both head ranges in Keirzo setup before powered movement.";
    if (head.calibration?.recording) return "Stop head range recording before powered movement.";
    const connection = savedHeadConnection(saved);
    if (connection.error) return connection.error;
    if (!headConnected()) return "Identify both 2XL430 head motors on the saved connection before powered movement.";
    if (!head.calibration?.saved_matches_connection || connection.device.replace(/^\/dev\/tty\./, "/dev/cu.") !== head.device.replace(/^\/dev\/tty\./, "/dev/cu.") || saved.baudrate !== head.baudrate || saved.axes.some(axis => !head.motors.some(motor => motor.id === axis.id))) return "The saved head ranges do not match this connection.";
    if (head.motors.some(motor => motor.profile_mode !== "time" || motor.operating_mode !== 3)) return "Both head motors need time profiles and position mode 3 before powered movement.";
    if (head.motors.some(motor => typeof motor.torque_enabled !== "boolean")) return "Head torque could not be read. Check the connection again.";
    if (head.motors.some(motor => !Number.isInteger(motor.position))) return "Head position could not be read. Check the connection again.";
    if (saved.axes.some(axis => {
      const position = head.motors.find(motor => motor.id === axis.id).position;
      return !Number.isInteger(position) || position < axis.min || position > axis.max;
    })) return "The measured head position is outside its saved range. Support the head, release its torque, then hold it near the saved centre before starting.";
    return "";
  }

  function calibrationMatches() {
    const calibration = state.head?.calibration || {};
    return serialSelected("head") && calibration.device === serial.head.device && calibration.baudrate === serial.head.baudrate;
  }

  function calibrationValid() {
    const axes = state.head?.calibration?.axes || [];
    return axes.length === 2 && axes.every(axis => [axis.min, axis.centre, axis.max].every(Number.isInteger) && axis.min < axis.max && axis.centre >= axis.min && axis.centre <= axis.max);
  }

  function updateCalibrationControls() {
    const calibration = state.head?.calibration || {}, pending = commandBusy() || Boolean(headRelease) || liveCommands.has("head") || diagnosticBusy.has("head") || calibrationActions.size > 0;
    const ready = serialReady("head") && headTorqueOff();
    $("head-calibration-start").disabled = !active || state.emergency_stopped || pending || !ready || calibration.recording === true;
    // Stopping the server reader remains available after a failed read or a changed selector.
    $("head-calibration-stop").disabled = !active || calibrationActions.has("stop");
    $("head-calibration-centre").disabled = !active || pending || !ready || !calibrationMatches() || !["recording", "stopped"].includes(calibration.state) || calibration.axes?.length !== 2;
    $("head-calibration-save").disabled = !active || pending || calibration.recording === true || calibration.state !== "stopped" || !calibrationMatches() || !calibrationValid();
  }

  function calibrationLabelKey(id) {
    const calibration = state.head?.calibration || {};
    const source = calibration.axes?.length ? calibration : calibration.saved || calibration;
    return `${source.device || ""}|${source.baudrate || ""}|${id}`;
  }

  function renderCalibration() {
    const calibration = state.head?.calibration || {};
    const stateLabel = { idle: "Not recording", recording: "Recording", stopped: "Recording stopped", error: "Recording error", saved: "Range saved" };
    $("head-calibration-state").textContent = stateLabel[calibration.state] || "Not recording";
    $("head-calibration-state").classList.toggle("is-live", calibration.recording === true);
    $("head-calibration-state").classList.toggle("is-error", calibration.state === "error" || Boolean(calibrationError));
    const message = calibrationError || calibration.storage_error || calibration.message || (headTorqueOff() && serialReady("head") ? "Ready to record manual movement. Centre starts from the upright reference, when available." : "Identify both head motors with torque off to record their range.");
    $("head-calibration-message").textContent = message;
    $("head-calibration-message").classList.toggle("is-error", calibration.state === "error" || Boolean(calibrationError || calibration.storage_error));
    $("head-calibration-sampled").textContent = calibration.sampled_at ? `${calibration.sample_count || 0} samples · Last reading: ${new Date(calibration.sampled_at).toLocaleTimeString()}${calibration.recording ? " · Continues across tabs" : ""}` : "";
    const axes = calibration.axes?.length ? calibration.axes : calibration.saved?.axes || [];
    const tableKey = axes.map(axis => calibrationLabelKey(axis.id)).join(",");
    if (tableKey !== calibrationTableKey) {
      calibrationTableKey = tableKey;
      $("head-calibration-axes").innerHTML = axes.map(axis => {
        const key = calibrationLabelKey(axis.id);
        if (!headLabels.has(key)) headLabels.set(key, axis.label || "");
        return `<tr><th scope="row">${escape(axis.id)}</th><td><input id="robot-head-label-${axis.id}" data-robot-head-label="${axis.id}" aria-label="Name for head motor ${escape(axis.id)}" type="text" maxlength="48" placeholder="e.g. Turn or tilt" value="${escape(headLabels.get(key))}"></td>${["position", "min", "centre", "max"].map(field => `<td><span id="robot-head-axis-${axis.id}-${field}"></span></td>`).join("")}</tr>`;
      }).join("");
    }
    for (const axis of axes) for (const field of ["position", "min", "centre", "max"]) $(`head-axis-${axis.id}-${field}`).textContent = Number.isInteger(axis[field]) ? String(axis[field]) : "—";
    $("head-calibration-readback").hidden = axes.length === 0;
    const saved = calibration.saved;
    $("head-calibration-saved").hidden = !saved;
    $("head-calibration-saved").textContent = saved ? `Saved range${calibration.saved_matches_connection && serialSelected("head") ? " for this head" : " for a different or unverified connection"}: ${(saved.axes || []).map(axis => `${axis.label || `Motor ${axis.id}`} (ID ${axis.id}) ${axis.min} / ${axis.centre} / ${axis.max}`).join(" · ")}. Minimum / centre / maximum.` : "";
    updateCalibrationControls(); syncCalibrationPolling();
  }

  function stopCalibrationPolling() {
    if (calibrationTimer !== undefined) clearTimeout(calibrationTimer);
    calibrationTimer = undefined;
  }

  function syncCalibrationPolling() {
    if (!active || state.head?.calibration?.recording !== true) { stopCalibrationPolling(); return; }
    if (calibrationTimer !== undefined || calibrationPollPending || calibrationActions.size > 0) return;
    calibrationTimer = setTimeout(pollCalibration, Math.min(4000, 250 * 2 ** calibrationFailures));
  }

  async function pollCalibration() {
    calibrationTimer = undefined;
    if (!active || state.head?.calibration?.recording !== true || calibrationPollPending || calibrationActions.size > 0) return;
    const token = generation, revision = calibrationRevision;
    calibrationPollPending = true;
    try {
      const result = await request("head/calibration");
      if (!isCurrent(token) || revision !== calibrationRevision || !responseCurrent(result)) return;
      const previousState = state.head?.state, previousRecording = state.head?.calibration?.recording;
      if (result.head) state.head = result.head;
      calibrationFailures = 0; calibrationError = "";
      if (previousState !== state.head?.state || previousRecording !== state.head?.calibration?.recording) renderSerial("head");
      else renderCalibration();
      updateControls();
    } catch (error) {
      if (!isCurrent(token) || revision !== calibrationRevision || error.cancelled) return;
      calibrationFailures = Math.min(4, calibrationFailures + 1);
      calibrationError = `Could not refresh head readings: ${error.message}. Retrying…`;
      if (error.result?.head) state.head = error.result.head;
      renderCalibration(); updateControls();
    } finally {
      calibrationPollPending = false; syncCalibrationPolling();
    }
  }

  async function calibrationAction(operation) {
    if (!active || calibrationActions.has(operation) || (operation !== "stop" && (commandBusy() || headRelease || liveCommands.has("head") || calibrationActions.size > 0 || diagnosticBusy.has("head")))) return;
    const token = generation, revision = ++calibrationRevision;
    calibrationActions.add(operation); stopCalibrationPolling(); calibrationError = ""; updateControls();
    try {
      if (operation === "start" && state.emergency_stopped) throw new Error("Reset the emergency stop before recording.");
      if (["start", "centre"].includes(operation) && (!serialReady("head") || !headTorqueOff())) throw new Error("Identify both head motors with torque off before recording.");
      if (operation === "centre" && (!calibrationMatches() || !["recording", "stopped"].includes(state.head?.calibration?.state))) throw new Error("Start a recording on this head before capturing its centre.");
      if (operation === "save" && (state.head?.calibration?.recording || state.head?.calibration?.state !== "stopped" || !calibrationMatches() || !calibrationValid())) throw new Error("Stop recording after measuring both ranges and capture a centre within each range before saving.");
      const body = operation === "save" ? { labels: Object.fromEntries((state.head.calibration.axes || []).map(axis => [String(axis.id), (headLabels.get(calibrationLabelKey(axis.id)) || "").trim()])) } : {};
      // Keep Stop behind any pending Start, independently of the motor command queue.
      const pending = calibrationMutationQueue.catch(() => {}).then(() => {
        if (operation !== "stop" && (!isCurrent(token) || (operation === "start" && state.emergency_stopped))) throw cancelled();
        return request(`head/calibration/${operation}`, body);
      });
      calibrationMutationQueue = pending.catch(() => {});
      const result = await pending;
      if (!isCurrent(token) || revision !== calibrationRevision || !responseCurrent(result)) return;
      if (result.head) state.head = result.head;
      calibrationFailures = 0; renderSerial("head"); notice(result.message || state.head.calibration?.message || "Head recording updated.");
    } catch (error) {
      if (!isCurrent(token) || revision !== calibrationRevision || error.cancelled) return;
      if (error.result?.head) state.head = error.result.head;
      calibrationError = error.message || "Head recording failed.";
      renderSerial("head"); notice(calibrationError, true);
    } finally {
      calibrationActions.delete(operation); updateControls(); syncCalibrationPolling();
    }
  }

  function renderRibs() {
    const ribs = state.ribs || {}, ports = Array.isArray(ribs.ports) ? ribs.ports : [];
    const preferred = ribs.preferred_connection;
    if (preferred && canFollowPreferred(ribs, ribsManual)) ribDevice = preferred.state === "matched" ? preferred.device || "" : "";
    else if ((!preferred || ribs.checked_at) && !ribDevice && !ribsManual) ribDevice = ribs.device || "";
    const choices = [...new Set([ribDevice, ribs.device, ...ports].filter(Boolean))];
    $("ribs-device").innerHTML = '<option value="">Choose the rib cage serial port…</option>' + choices.map(port => `<option value="${escape(port)}">${escape(port)}</option>`).join("");
    $("ribs-device").value = ribDevice;
    const stateLabel = { unchecked: "Not checked", ready: "Connected", partial: "Partial connection", disconnected: "Disconnected", error: "Connection error" };
    $("ribs-state").textContent = ribsStale ? "Check required" : stateLabel[ribs.state] || "Not checked";
    const hasError = !ribsStale && ["partial", "disconnected", "error"].includes(ribs.state);
    $("ribs-state").classList.toggle("is-error", hasError);
    $("ribs-message").classList.toggle("is-error", hasError);
    $("ribs-message").textContent = ribsStale ? "Port changed. Check connection before sending to this device." : ribs.message || "Choose the serial port and check the six rib motors. This reads their state without moving them.";
    $("ribs-identity").textContent = preferredNote(ribs);
    $("ribs-identity").hidden = !preferred;
    let checked = "Not checked yet";
    if (ribs.checked_at) {
      const date = new Date(ribs.checked_at);
      checked = `Last checked: ${Number.isNaN(date.getTime()) ? ribs.checked_at : date.toLocaleString()}${ribs.device ? ` · ${ribs.device}` : ""}`;
    }
    $("ribs-checked").textContent = `${checked}. Readings update only when checked; they are not live feedback.`;
    const readings = Array.isArray(ribs.motors) ? ribs.motors : [];
    $("ribs-readings").innerHTML = readings.map(motor => `<tr><th scope="row">${escape(motor.id)}</th><td>${motor.connected ? "Responding" : motor.error ? "No response" : "Not checked"}</td><td>${Number.isInteger(motor.position) ? motor.position : "—"}</td><td>${motor.torque_enabled === true ? "On" : motor.torque_enabled === false ? "Off" : "Unknown"}</td><td>${escape(motor.error || "—")}</td></tr>`).join("");
    $("ribs-readback").hidden = readings.length === 0;
  }

  async function action(callback, diagnosticGroup) {
    if (!active || (diagnosticGroup ? diagnosticBusy.has(diagnosticGroup) : workBusy())) return;
    const token = generation;
    if (diagnosticGroup) diagnosticBusy.set(diagnosticGroup, token);
    else busy = true;
    updateControls();
    try { await callback(token); }
    catch (error) {
      if (isCurrent(token) && !error.cancelled) {
        commandError(error, diagnosticGroup);
      }
    } finally {
      if (diagnosticGroup && diagnosticBusy.get(diagnosticGroup) === token) diagnosticBusy.delete(diagnosticGroup);
      if (isCurrent(token) && !diagnosticGroup) busy = false;
      updateControls();
    }
  }

  function commandError(error, diagnosticGroup) {
    if (error.cancelled || !responseCurrent(error.result)) return;
    reconcileEmergency(error.result);
    if (error.result?.head) headRevision++;
    for (const group of ["ribs", "head", "drums"]) if (error.result?.[group]) state[group] = error.result[group];
    if (error.result?.drums?.performance) drumPerformance = error.result.drums.performance;
    if (diagnosticGroup) {
      const result = error.result?.[diagnosticGroup], selection = serial[diagnosticGroup];
      if (result && result.state !== "ready" && result.device === selection.device && result.baudrate === selection.baudrate) selection.stale = false;
    }
    renderConnections();
    notice(error.message || "Robot command failed.", true); addHistory("Command failed", error.message, true);
  }

  async function moveRibs(position, durationMs, options) {
    if (!active) throw new Error("Start Keirzo control to connect the rib cage.");
    position = integer(position, 0, 127, "Rib cage position");
    durationMs = integer(durationMs, 100, 5000, "Duration");
    if (!snapshot().torqueEnabled) throw new Error("Rib torque is off. Start Keirzo control to reconnect.");
    return liveCommand("ribs", { kind: "ribs", position, duration_ms: durationMs }, `Rib cage → ${position} in ${durationMs} ms`, options);
  }

  function moveHead(motorId, position, durationMs, options) {
    return liveCommand("head", { kind: "head_move", motor_id: motorId, position, duration_ms: durationMs }, `Head motor ${motorId} → ${position}`, options);
  }

  async function moveHeadAxes(targets, options) {
    const checked = headTargets(targets);
    return liveCommand("head", { kind: "head_moves", targets: checked },
      `Head → ${checked.map(target => `${target.motor_id}: ${target.position}`).join(", ")}`, options);
  }

  function headTargets(targets) {
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 2) throw new Error("Choose one or two saved head axes.");
    const ids = new Set(), axes = savedHeadCalibration()?.axes || [];
    return targets.map(target => {
      if (!target || typeof target !== "object" || Array.isArray(target)
          || Object.keys(target).some(key => !["motor_id", "position", "duration_ms"].includes(key))) throw new Error("Each head target needs motor_id, position and duration_ms.");
      const axis = axes.find(axis => axis.id === target.motor_id);
      if (!axis) throw new Error("Choose one of the saved head axes.");
      if (ids.has(axis.id)) throw new Error("Choose each head axis only once.");
      ids.add(axis.id);
      return { motor_id: axis.id, position: integer(target.position, axis.min, axis.max, `${axis.label} position`),
        duration_ms: integer(target.duration_ms, 1000, 10000, "Head duration") };
    });
  }

  function validateHeadCommand(payload) {
    const releasing = payload.kind === "head_torque" && payload.enabled === false;
    if (diagnosticBusy.has("head") || calibrationActions.size > 0) throw new Error("Wait for the head connection or recording command to finish.");
    if (releasing && !serialSelected("head")) throw new Error("Check the selected head connection before releasing its motors.");
    if (!releasing) {
      const error = liveHeadError(); if (error) throw new Error(error);
      if (state.emergency_stopped) throw new Error("Reset the emergency stop before sending motor commands.");
    }
    if (payload.kind === "head_torque") {
      if (typeof payload.enabled !== "boolean") throw new Error("Head torque must be on or off.");
      if (!releasing && state.head?.busy) throw new Error("Wait for the current head movement to finish.");
      return payload;
    }
    const targets = headTargets(payload.kind === "head_moves" ? payload.targets
      : [{ motor_id: payload.motor_id, position: payload.position, duration_ms: payload.duration_ms }]);
    const motion = state.head?.motion;
    // Older or malformed status cannot identify an idle axis reliably.
    if (state.head?.busy && (!Array.isArray(motion) || !motion.length || motion.some(item => !item
        || !savedHeadCalibration().axes.some(axis => axis.id === item.motor_id)
        || !Number.isFinite(item.remaining_ms) || item.remaining_ms <= 0))) throw new Error("Wait for the current head movement to finish.");
    for (const target of targets) {
      if (Array.isArray(motion) && motion.some(item => item?.motor_id === target.motor_id && item.remaining_ms > 0)) {
        throw new Error(`Head motor ${target.motor_id} is busy. Wait for its current movement to finish.`);
      }
    }
    if (!snapshot().headTorqueEnabled) throw new Error("Turn head torque on before powered movement.");
    return payload.kind === "head_moves" ? { ...payload, targets } : { ...payload, ...targets[0] };
  }

  function setHeadTorque(enabled, options) {
    if (enabled === false) {
      if (headRelease) return headRelease;
      if (!active) return Promise.reject(new Error("Start Keirzo control to connect the motors."));
      const token = generation;
      const guard = () => {
        if (options?.signal?.aborted) throw Object.assign(new Error("Head release cancelled."), { name: "AbortError", cancelled: true });
        if (!isCurrent(token)) throw cancelled();
      };
      // Reserve the next queue slot immediately, even while a head cue settles.
      const pending = command({ kind: "head_torque", enabled: false }, "Release head", token, guard).catch(error => {
        if (isCurrent(token) && !error.cancelled) commandError(error);
        throw error;
      }).finally(() => { if (headRelease === pending) headRelease = undefined; updateControls(); });
      headRelease = pending; updateControls(); return pending;
    }
    return liveCommand("head", { kind: "head_torque", enabled }, enabled ? "Head torque on" : "Release head", options);
  }

  async function liveCommand(group, payload, label, { signal } = {}) {
    if (!active) throw new Error("Start Keirzo control to connect the motors.");
    if (commandBusy() || liveCommands.has(group) || (group === "head" && headRelease)) throw new Error("Keirzo is busy. Wait for the current command.");
    const token = generation, operation = {};
    const guard = () => {
      if (signal?.aborted) throw Object.assign(new Error("Keirzo movement cancelled."), { name: "AbortError", cancelled: true });
      if (!isCurrent(token)) throw cancelled();
    };
    guard();
    liveCommands.set(group, operation); updateControls();
    try { return await command(payload, label, token, guard); }
    catch (error) { if (isCurrent(token) && !error.cancelled) commandError(error); throw error; }
    finally { if (liveCommands.get(group) === operation) liveCommands.delete(group); updateControls(); }
  }

  async function command(payload, label, token, guard) {
    guard?.();
    const motor = state.motors.find(item => item.id === payload.motor_id);
    const headCommand = ["head_move", "head_moves", "head_torque"].includes(payload.kind);
    if (!headCommand && motor?.group === "head") throw new Error("Use the saved head axes in Keirzo control for powered movement.");
    const releasing = ["ribs_torque", "drums_torque", "head_torque"].includes(payload.kind) && payload.enabled === false;
    const ribCommand = !headCommand && (payload.kind === "ribs" || payload.kind === "ribs_torque" || motor?.group === "ribs");
    const drumCommand = !headCommand && (payload.kind === "drums_torque" || payload.kind === "drums_strike" || motor?.group === "drums");
    if (headCommand) {
      headRevision++;
      payload = validateHeadCommand(payload);
    }
    if (drumCommand && diagnosticBusy.has("drums")) throw new Error("Wait for the drumming arm connection check to finish.");
    if (drumCommand && releasing && !serialSelected("drums")) throw new Error("Check the selected drumming arm connection before releasing its motors.");
    if (!releasing && state.emergency_stopped) throw new Error("Reset the emergency stop before sending motor commands.");
    if (ribCommand && !releasing && !ribsReady()) throw new Error("Check the rib cage connection before testing. All six motors must respond.");
    if (drumCommand && !releasing && !serialReady("drums")) throw new Error("Check the drumming arm connection before testing. All four motors must respond.");
    if (payload.kind === "move" || payload.kind === "drums_strike") {
      const reason = motorTestError(motor, payload.kind === "drums_strike");
      if (reason) throw new Error(reason);
    }
    if (payload.kind === "ribs" && !snapshot().torqueEnabled) throw new Error("Turn rib torque on before moving the rib cage.");
    if (drumCommand && !releasing && state.drums?.busy) throw new Error("Wait for the arm test to finish.");
    if (drumCommand && releasing) drumResponseRevision++;
    const dispatchGuard = headCommand ? () => { guard?.(); validateHeadCommand(payload); } : guard;
    const result = await queuedRequest("command", { ...payload, dry_run: false }, token, undefined, dispatchGuard);
    if (!isCurrent(token) || !responseCurrent(result)) return;
    reconcileEmergency(result);
    if (result.head) headRevision++;
    for (const group of ["ribs", "head", "drums"]) if (result[group]) state[group] = result[group];
    if (result.drums?.performance) drumPerformance = result.drums.performance;
    renderConnections();
    // Stop cancels future commands; keep actual readbacks from an accepted command.
    guard?.();
    const details = (result.commands || []).map(item => item.address ? `${item.address} ${(item.args || []).join(" ")}` : JSON.stringify(item)).join("\n");
    addHistory(label, details || result.message || "Command accepted");
    notice(result.message || `Sent: ${label}.`);
    return result;
  }

  function liveRibsError() {
    const readings = state.ribs?.motors || [], ids = [20, 21, 22, 25, 26, 27];
    if (!ribsReady() || readings.length !== ids.length || ids.some(id => !readings.some(motor => motor.id === id && motor.connected && !motor.error))) return state.ribs?.message || "All six rib motors must respond before starting.";
    const incompatible = readings.filter(motor => motor.profile_mode !== "time" || ![3, 4].includes(motor.operating_mode));
    if (incompatible.length) return `Rib motors ${incompatible.map(motor => motor.id).join(", ")} need time profiles and position mode. Check their configuration in Keirzo setup.`;
    if (readings.some(motor => typeof motor.torque_enabled !== "boolean")) return "Rib torque could not be read. Check the connection and start again.";
    return "";
  }

  function prepareLive(effects = {}, { signal, onProgress } = {}) {
    const selected = { leds: Boolean(effects.leds), ribs: Boolean(effects.ribs), head: Boolean(effects.head), drums: Boolean(effects.drums) }, key = JSON.stringify(selected);
    const abortError = () => Object.assign(new Error("Keirzo start cancelled."), { name: "AbortError", cancelled: true });
    if (signal?.aborted) return Promise.reject(abortError());
    if (selected.head && headRelease) return Promise.reject(new Error("Wait for head torque release to finish before starting it again."));
    if (preparation && !preparation.cancelled && preparation.key === key) {
      if (onProgress) preparation.progress.add(onProgress);
      if (signal) { const entry = preparation; signal.addEventListener("abort", entry.abort, { once: true }); entry.signals.add(signal); }
      return preparation.promise;
    }
    const entry = { key, cancelled: false, controller: new AbortController(), progress: new Set(onProgress ? [onProgress] : []), signals: new Set(signal ? [signal] : []), waiters: new Set(), token: undefined };
    entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    entry.abort = () => {
      if (entry.cancelled) return;
      entry.cancelled = true;
      entry.controller.abort();
      const error = abortError(); entry.reject(error);
      for (const reject of entry.waiters) reject(error);
      entry.waiters.clear();
    };
    signal?.addEventListener("abort", entry.abort, { once: true });
    preparation = entry; preparations.add(entry); updateControls();
    const guard = () => {
      if (entry.cancelled) throw abortError();
      if (!initialized) throw new Error("Keirzo controls are unavailable.");
      if (state.emergency_stopped || emergencyPending) throw new Error("Reset the emergency stop before starting Keirzo.");
      if (entry.token !== undefined && !isCurrent(entry.token)) throw cancelled();
    };
    const progress = message => { guard(); for (const listener of entry.progress) listener(message); guard(); };
    const wait = async promise => {
      const result = await new Promise((resolve, reject) => {
        entry.waiters.add(reject);
        Promise.resolve(promise).then(resolve, reject).finally(() => entry.waiters.delete(reject));
        if (entry.cancelled) reject(abortError());
      });
      guard(); return result;
    };
    const requireLED = () => { if (selected.leds && !pimoroniOutput()) throw new Error(midiError || "Pimoroni LEDs are not connected. Connect the controller over USB and start again."); };
    const pending = preparationQueue.catch(() => {}).then(async () => {
      guard(); progress("Connecting Keirzo…");
      const opening = activate({ signal: entry.controller.signal }); entry.token = generation;
      await wait(opening); guard();
      const result = await wait(queuedRequest("status", undefined, entry.token, { signal: entry.controller.signal }, guard));
      applyStatus(result); guard();
      if (selected.drums && (state.drums?.busy || state.drums?.performance?.busy)) throw new Error("Stop automatic drumming or wait for the arm test to finish before starting the robot.");
      if (selected.leds) {
        progress("Connecting LEDs…"); await wait(connectMIDI()); requireLED();
      }
      if (selected.ribs) {
        if (!ribDevice) throw new Error("Choose the rib cage serial port in Keirzo setup, then start again.");
        const device = ribDevice;
        progress("Checking six rib motors…");
        const checked = await wait(queuedRequest("ribs/check", { device }, entry.token, { signal: entry.controller.signal }, guard));
        if (ribDevice !== device) throw cancelled();
        ribsStale = false; applyStatus(checked); guard(); requireLED();
        const error = liveRibsError(); if (error) throw new Error(error);
      }
      if (selected.head) {
        const saved = savedHeadCalibration();
        if (!saved) throw new Error(liveHeadError());
        if (state.head?.calibration?.recording) throw new Error("Stop head range recording before powered movement.");
        const connection = savedHeadConnection(saved), device = connection.device;
        if (connection.error) throw new Error(connection.error);
        if ((serial.head.stale || serial.head.manual) && (serial.head.device !== device || serial.head.baudrate !== saved.baudrate)) throw new Error("The selected head connection does not match its saved ranges. Select the saved connection in Keirzo setup.");
        const motion = state.head?.motion;
        const continuing = state.head?.busy && serialReady("head") && serial.head.device === device
          && serial.head.baudrate === saved.baudrate && !liveHeadError() && snapshot().headTorqueEnabled
          && state.head?.last_move && state.head.last_move.partial !== true && Array.isArray(motion) && motion.length > 0 && motion.length <= 2
          && new Set(motion.map(row => row?.motor_id)).size === motion.length
          && motion.every(row => row && saved.axes.some(axis => axis.id === row.motor_id)
            && Number.isFinite(row.remaining_ms) && row.remaining_ms > 0);
        if (continuing) {
          // Ordinary Stop leaves accepted finite profiles running. Their known,
          // verified connection can be reused without rediscovery or torque-on.
          progress("Continuing the current head movements…");
        } else {
          serial.head.device = device; serial.head.baudrate = saved.baudrate; serial.head.stale = true;
          progress("Checking two head motors…");
          const checked = await wait(queuedRequest("head/check", { device, baudrate: saved.baudrate }, entry.token, { signal: entry.controller.signal }, guard));
          if (serial.head.device !== device || serial.head.baudrate !== saved.baudrate) throw cancelled();
          serial.head.stale = false; applyStatus(checked); guard(); requireLED();
        }
        const error = liveHeadError(); if (error) throw new Error(error);
        if (!snapshot().headTorqueEnabled) {
          progress("Holding head in its current position…");
          // An accepted torque request must settle before another preparation uses the bus.
          await command({ kind: "head_torque", enabled: true }, "Hold head position", entry.token, guard);
          guard(); requireLED();
        }
        const readinessError = liveHeadError(); if (readinessError) throw new Error(readinessError);
        if (!snapshot().headTorqueEnabled) throw new Error("Head torque was not confirmed on for both motors. Check the connection and start again.");
      }
      if (selected.drums) {
        if (!serial.drums.device) throw new Error("Choose the drumming arm serial port in Keirzo setup, then start again.");
        const { device, baudrate } = serial.drums;
        progress("Checking four drumming arms…");
        const checked = await wait(queuedRequest("drums/check", { device, baudrate }, entry.token, { signal: entry.controller.signal }, guard));
        if (serial.drums.device !== device || serial.drums.baudrate !== baudrate) throw cancelled();
        serial.drums.stale = false; applyStatus(checked); guard();
        if (!serialReady("drums")) throw new Error(state.drums?.message || "Check the drumming arm connection in Keirzo setup.");
        if (state.drums?.busy || state.drums?.performance?.busy) throw new Error("Stop automatic drumming or wait for the arm test to finish before starting the robot.");
        const readings = state.drums?.motors || [];
        if (readings.length !== 4 || [0, 1, 2, 3].some(id => !readings.some(motor => motor.id === id)) || readings.some(motor => !motor.connected || motor.error || !Number.isInteger(motor.position) || typeof motor.torque_enabled !== "boolean" || motor.profile_mode !== "time" || ![3, 4].includes(motor.operating_mode))) throw new Error("All four arms need healthy position readbacks and time profiles. Check Keirzo setup.");
        const armsAtRest = () => state.drums?.motors?.length === 4 && state.drums.motors.every(reading => {
          const motor = state.motors.find(item => item.group === "drums" && item.id === reading.id);
          return motor && Number.isInteger(motor.rest) && Number.isInteger(reading.position) && reading.position >= motor.min && reading.position <= motor.max && Math.abs(reading.position - motor.rest) <= 20;
        });
        if (!snapshot().drumTorqueEnabled || !armsAtRest()) {
          progress("Moving arms to rest…");
          await command({ kind: "drums_torque", enabled: true }, "Arm torque on + rest", entry.token, guard);
          guard();
        }
        if (!snapshot().drumTorqueEnabled) throw new Error("Arm torque was not confirmed on. Check the connection and start again.");
        if (!armsAtRest()) throw new Error("The arms did not confirm their rest positions. Check the connection and start again.");
      }
      if (selected.ribs) {
        if (!snapshot().torqueEnabled) {
          progress("Turning rib torque on…");
          // Once sent, let torque settle before another preparation can use the bus.
          await command({ kind: "ribs_torque", enabled: true }, "Rib torque on", entry.token, guard);
          guard(); requireLED();
        }
        const readinessError = liveRibsError(); if (readinessError) throw new Error(readinessError);
        if (!snapshot().torqueEnabled) throw new Error("Rib torque was not confirmed on for all six motors. Start again after checking the connection.");
      }
      if (selected.head) {
        const error = liveHeadError(); if (error) throw new Error(error);
        if (!snapshot().headTorqueEnabled) throw new Error("Head torque was not confirmed on for both motors. Check the connection and start again.");
      }
      guard(); requireLED(); progress("Keirzo ready.");
      return snapshot();
    });
    preparationQueue = pending.catch(() => {});
    const finish = () => {
      for (const source of entry.signals) source.removeEventListener("abort", entry.abort);
      preparations.delete(entry); if (preparation === entry) preparation = undefined;
      updateControls();
    };
    pending.then(() => { finish(); entry.resolve(snapshot()); }, error => {
      if (!entry.cancelled && !error.cancelled && isCurrent(entry.token)) commandError(error);
      finish(); entry.reject(error);
    });
    return entry.promise;
  }

  function integer(value, min, max, label) {
    if (String(value).trim() === "" || !Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
    return Number(value);
  }

  const drumNow = () => globalThis.performance?.now() ?? Date.now();
  const drumWait = () => new Promise(resolve => setTimeout(resolve, 100));
  function acceptDrumPerformance(result) {
    if (!responseCurrent(result)) return;
    if (result.drums) state.drums = result.drums;
    if (result.performance) drumPerformance = result.performance;
    syncDrumsPolling();
    updateControls();
  }
  async function drumRequest(operation, payload, options) {
    const revision = drumResponseRevision;
    const result = await request(`drums/performance/${operation}`, payload, options);
    if (revision === drumResponseRevision) acceptDrumPerformance(result);
    return result;
  }
  // A quick round trip maps browser performance time to the server's monotonic
  // clock. The long preparation request must never be used as a clock sample.
  async function syncDrumClock() {
    let best;
    for (let attempt = 0; attempt < 3; attempt++) {
      const begin = drumNow(), result = await drumRequest("status"), end = drumNow();
      if (!Number.isFinite(result.server_time_ms)) throw new Error("The drum service did not provide its timing clock.");
      const sample = { elapsed: end - begin, offset: result.server_time_ms - (begin + end) / 2 };
      if (!best || sample.elapsed < best.elapsed) best = sample;
    }
    if (best.elapsed > 100) throw new Error("The drum connection is responding too slowly for beat timing. Try again when it is responsive.");
    drumClockOffset = best.offset;
  }

  function startDrumming({ token, instruments }, { signal, onProgress } = {}) {
    if (typeof token !== "string" || !token || !Array.isArray(instruments) || !instruments.length || instruments.some(id => !Number.isInteger(id) || id < 0 || id > 3)) return Promise.reject(new Error("Choose drumming arms and a valid performance session."));
    const entry = { token, controller: new AbortController(), promise: null };
    const abort = () => entry.controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const guard = () => {
      if (entry.controller.signal.aborted) throw Object.assign(new Error("Drumming start cancelled."), { name: "AbortError", cancelled: true });
      if (state.emergency_stopped) throw new Error("Reset the emergency stop before starting drumming.");
    };
    drumStart = entry;
    const pending = drumStartQueue.catch(() => {}).then(async () => {
      try {
        guard();
        drumResponseRevision++;
        // A normal stop allows an already-started return to finish before a new
        // session checks and prepares the same arms.
        const deadline = drumNow() + 2500;
        while (true) {
          guard();
          const result = await drumRequest("status");
          if (!result.performance?.busy) break;
          if (drumNow() >= deadline) throw new Error("The arms are still busy. Stop drumming and wait for their return before starting again.");
          await drumWait();
        }
        guard();
        await prepareLive({ drums: true }, { signal: entry.controller.signal, onProgress });
        guard(); await syncDrumClock(); guard();
        onProgress?.("Raising the selected arms to rest…");
        let result = await drumRequest("start", { token, instruments });
        const readyBy = drumNow() + 2500;
        while (result.performance?.state === "preparing") {
          guard();
          if (drumNow() >= readyBy) throw new Error("The arms did not confirm their raised rest positions.");
          await drumWait(); guard();
          result = await drumRequest("schedule", { token, events: [] });
        }
        guard();
        if (result.performance?.token !== token || result.performance?.state !== "ready") throw new Error(result.performance?.error || "The drumming arms are not ready.");
        return result;
      } catch (error) {
        try { await drumRequest("stop", { token }, { keepalive: true }); } catch (_) { /* Server heartbeat expiry also cancels pending hits. */ }
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        if (drumStart === entry) drumStart = null;
        updateControls();
      }
    });
    entry.promise = pending;
    drumStartQueue = pending.catch(() => {});
    return pending;
  }

  function scheduleDrums({ token, events }) {
    if (state.emergency_stopped || !drumPerformanceConnected()) return Promise.reject(new Error("The drumming arms are no longer connected and ready."));
    // A running performance owns readiness for each arm. A single arm can be
    // recovering or unavailable while its neighbours continue on the same bus.
    if (drumPerformance?.token !== token || !["ready", "preparing"].includes(drumPerformance.state)) return Promise.reject(new Error("This drum performance session is no longer active."));
    if (!Number.isFinite(drumClockOffset)) return Promise.reject(new Error("Synchronize the drumming clock before scheduling hits."));
    if (!Array.isArray(events) || events.some(event => !Number.isFinite(event.contactAt))) return Promise.reject(new Error("Drum hits need valid contact times."));
    // Send directly: lighting/head/rib request queues must not delay a beat.
    return drumRequest("schedule", { token, events: events.map(({ id, motor_id, contactAt }) => ({ id, motor_id, contact_ms: contactAt + drumClockOffset })) });
  }

  function stopDrumming({ token } = {}) {
    const session = token || drumStart?.token || drumPerformance?.token;
    if (!session) return Promise.resolve();
    if (drumStart?.token === session) drumStart.controller.abort();
    if (drumStops.has(session)) return drumStops.get(session);
    drumResponseRevision++;
    const pendingStart = drumStart?.token === session ? drumStart.promise : null;
    const pending = (async () => {
      let failure;
      try { await drumRequest("stop", { token: session }, { keepalive: true }); } catch (error) { failure = error; }
      if (pendingStart) await pendingStart.catch(() => {});
      if (failure) throw failure;
    })().finally(() => { if (drumStops.get(session) === pending) drumStops.delete(session); });
    drumStops.set(session, pending);
    return pending;
  }

  function emergencyStop() {
    if (!active) return Promise.reject(new Error("Open Keirzo setup or control before using emergency stop."));
    if (emergencyPending) return emergencyPending;
    const revision = ++emergencyRevision, resetInFlight = emergencyResetRequest;
    reconcileEmergency({ emergency_stopped: true }); generation++; calibrationRevision++; busy = false;
    globalThis.HydraRobotLive?.stop();
    globalThis.HydraRobotDrums?.stop();
    notice("Emergency stop requested. Releasing head, rib and arm torque…");
    const pending = (async () => {
      try {
        let failure, result;
        try { result = await request("emergency-stop", {}); } catch (error) { failure = error; }
        if (resetInFlight) {
          await resetInFlight.catch(() => {});
          result = await request("emergency-stop", {}); failure = undefined;
        }
        if (failure) throw failure;
        if (revision === emergencyRevision) { applyStatus(result); notice(result.message || "Emergency stop active. Check motor readbacks for torque status."); }
        return result;
      } catch (error) {
        if (revision === emergencyRevision) { commandError(error); notice(`Emergency stop remains active. ${error.message}`, true); }
        throw error;
      } finally { if (emergencyPending === pending) emergencyPending = undefined; updateControls(); }
    })();
    emergencyPending = pending; updateControls(); return pending;
  }

  async function resetEmergency() {
    if (!active || emergencyPending || emergencyResetPending || !state.emergency_stopped) return;
    const revision = emergencyRevision;
    emergencyResetPending = true; updateControls();
    try {
      emergencyResetRequest = request("emergency-reset", {});
      const result = await emergencyResetRequest;
      if (revision !== emergencyRevision) return;
      if (result.emergency_stopped !== false) throw new Error("The server did not confirm that the emergency stop was reset.");
      emergencyRevision++; responseRevisions.set(result, emergencyRevision);
      reconcileEmergency(result, true); applyStatus(result);
      notice(result.message || "Emergency stop reset. Turn torque on for the motor group you want to use.");
      return snapshot();
    } catch (error) { if (revision === emergencyRevision) commandError(error); throw error; }
    finally { emergencyResetPending = false; emergencyResetRequest = undefined; updateControls(); }
  }

  function midiOutputs() { return midiAccess ? [...midiAccess.outputs.values()].filter(output => output.state !== "disconnected") : []; }
  function pimoroniOutput() {
    return midiOutputs().find(output => /\bplasma\s*2040\b/i.test(output.name || "") || /\bpimoroni\b/i.test(`${output.manufacturer || ""} ${output.name || ""}`));
  }

  function updateLEDControls() {
    const output = pimoroniOutput();
    for (const button of root.querySelectorAll("[data-robot-led]")) {
      button.disabled = !active || midiPending;
      button.textContent = button.dataset.robotLed === "off" ? "LEDs off" : "Test colour";
    }
    $("midi-device").textContent = output ? output.name || "Pimoroni LED controller" : midiPending ? "Connecting to Pimoroni…" : "Pimoroni not connected";
    $("midi-connect").hidden = !midiError;
    $("midi-connect").disabled = !active || midiPending;
    const connection = midiError || (output ? "Pimoroni connected automatically. Press Test colour to light the LEDs." : midiPending ? "Looking for the Pimoroni LED controller." : midiAccess ? "Connect the Pimoroni over USB; it will reconnect automatically." : "MIDI connects automatically when this tab opens.");
    const brightness = Number($("led-brightness").value) === 0 ? " Brightness is 0%; raise it to see a colour." : "";
    $("midi-hint").textContent = `${connection}${brightness}`;
    publish();
  }

  function renderMIDI() {
    updateLEDControls();
  }

  function connectMIDI() {
    if (!active) return Promise.resolve();
    if (midiRequest) return midiRequest;
    midiPending = true; midiError = ""; updateLEDControls();
    // Reuse a pending permission request across workspace changes.
    // Discovery only identifies the controller; it never sends a colour.
    midiRequest = Promise.resolve().then(async () => {
      if (!globalThis.navigator?.requestMIDIAccess) throw new Error("Web MIDI is unavailable. Use a browser with Web MIDI support.");
      if (!midiAccess) {
        midiAccess = await navigator.requestMIDIAccess({ sysex: false });
        midiAccess.addEventListener("statechange", renderMIDI);
      }
    }).catch(error => {
      midiError = `Could not connect to the Pimoroni: ${error.message || "MIDI access failed."} Allow browser MIDI access, then retry.`;
    }).finally(() => {
      midiPending = false; midiRequest = undefined; renderMIDI();
    });
    return midiRequest;
  }

  function ledBytes(color, brightness) {
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Choose a valid LED colour.");
    if (!Number.isFinite(brightness) || brightness < 0 || brightness > 100) throw new Error("Brightness must be from 0 to 100.");
    const channels = [1, 3, 5].map(index => Math.round(parseInt(color.slice(index, index + 2), 16) / 255 * 127 * brightness / 100));
    return [[0x90, 1, channels[0]], [0xA0, channels[1], channels[2]]];
  }

  function sendColour(color, brightness) {
    if (!active) throw new Error("Start Keirzo control to connect the LEDs.");
    const bytes = ledBytes(color, brightness), output = pimoroniOutput();
    if (!output) throw new Error(midiError || "Pimoroni not connected. Connect it over USB; it will reconnect automatically.");
    for (const message of bytes) output.send(message);
    return bytes;
  }

  function sendLED(off = false) {
    if (!active) return;
    try {
      const brightness = integer($("led-brightness").value, 0, 100, "Brightness");
      const bytes = sendColour($("led-color").value, off ? 0 : brightness);
      const label = off ? "LEDs off" : `LED colour ${$("led-color").value} · ${$("led-brightness").value}%`;
      addHistory(label, bytes.map(message => message.map(byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ")).join("\n"));
      notice(`Sent: ${label}.`);
    } catch (error) { notice(error.message || "LED test failed.", true); addHistory("LED test failed", error.message, true); }
  }

  function updatePosition(id, value, source) {
    const motor = state.motors.find(item => item.id === id), draft = drafts.get(id);
    if (!motor || !draft) return;
    draft.position = value;
    if (source !== "range") $(`position-${id}`).value = value;
    if (source !== "number") $(`number-${id}`).value = value;
    $(`value-${id}`).textContent = value;
  }

  function input(event) {
    const target = event.target;
    if (target.dataset.robotHeadLabel !== undefined) headLabels.set(calibrationLabelKey(Number(target.dataset.robotHeadLabel)), target.value);
    else if (target.dataset.robotPosition !== undefined) updatePosition(Number(target.dataset.robotPosition), target.value, "range");
    else if (target.dataset.robotNumber !== undefined) updatePosition(Number(target.dataset.robotNumber), target.value, "number");
    else if (target.dataset.robotDuration !== undefined) drafts.get(Number(target.dataset.robotDuration)).duration = target.value;
    else if (target.id === "robot-led-brightness") { $("brightness-value").textContent = `${target.value}%`; updateLEDPreview(); }
    else if (target.id === "robot-led-color") updateLEDPreview();
    else if (target.id === "robot-ribs-position") $("ribs-value").textContent = target.value;
  }

  function updateLEDPreview() {
    $("led-swatch").style.backgroundColor = $("led-color").value;
    $("led-swatch").style.opacity = Math.max(.08, Number($("led-brightness").value) / 100);
    updateLEDControls();
  }

  async function change(event) {
    const target = event.target;
    if (target.id === "robot-ribs-device") {
      ribDevice = target.value; ribsStale = true; ribsManual = true; renderRibs();
      updateControls(); notice("Serial port changed. Check the rib cage connection before testing.");
    } else {
      for (const group of ["head", "drums"]) {
        if (target.id !== `robot-${group}-device` && target.id !== `robot-${group}-baudrate`) continue;
        if (target.id.endsWith("-device")) serial[group].device = target.value;
        else serial[group].baudrate = Number(target.value);
        serial[group].stale = true; serial[group].manual = true; renderSerial(group); updateControls();
      }
    }
  }

  async function click(event) {
    const button = event.target.closest("button");
    if (!button || button.disabled || !active) return;
    if (["start", "stop", "centre", "save"].some(operation => button.id === `robot-head-calibration-${operation}`)) return calibrationAction(button.id.replace("robot-head-calibration-", ""));
    if (button.id === "robot-emergency-stop") return emergencyStop().catch(() => {});
    if (button.id === "robot-emergency-reset") return resetEmergency().catch(() => {});
    if (button.id === "robot-head-release") return setHeadTorque(false).catch(() => {});
    if (button.id === "robot-midi-connect") return connectMIDI();
    if (button.dataset.robotLed !== undefined) return sendLED(button.dataset.robotLed === "off");
    if (button.dataset.robotPreset !== undefined) return updatePosition(Number(button.dataset.robotPreset), Number(button.dataset.position));
    if (button.id === "robot-clear-history") { history.splice(0); $("history").innerHTML = ""; $("history-empty").hidden = false; return; }
    const diagnosticGroup = ["robot-head-check", "robot-head-disconnect", "robot-head-upright"].includes(button.id) ? "head" : ["robot-drums-check", "robot-drums-disconnect"].includes(button.id) ? "drums" : undefined;
    return action(async token => {
      if (button.id === "robot-refresh" || button.dataset.robotRefresh !== undefined) {
        const result = await queuedRequest("status", undefined, token);
        if (isCurrent(token)) { applyStatus(result); notice("Available ports refreshed. Choose a port and check its connection."); }
      } else if (["robot-head-check", "robot-drums-check"].includes(button.id)) {
        const group = button.id === "robot-head-check" ? "head" : "drums";
        const result = await request(`${group}/check`, { device: serial[group].device, baudrate: serial[group].baudrate });
        if (isCurrent(token)) {
          serial[group].stale = false; applyStatus(result);
          notice(state[group].message || "Connection checked.", state[group].state !== "ready");
        }
      } else if (["robot-head-disconnect", "robot-drums-disconnect"].includes(button.id)) {
        const group = button.id === "robot-head-disconnect" ? "head" : "drums";
        if (group === "drums") drumResponseRevision++;
        const result = await request(`${group}/disconnect`, {});
        if (isCurrent(token)) { applyStatus(result); notice(state[group].message || "Serial connection closed. Holding torque is unchanged."); }
      } else if (button.id === "robot-head-upright") {
        if (!serialReady("head")) throw new Error("Identify both head motors before recording their upright position.");
        const result = await request("head/upright", {});
        if (isCurrent(token)) { applyStatus(result); notice(result.message || "Upright head position recorded. No movement was sent."); }
      } else if (button.id === "robot-ribs-check") {
        const result = await queuedRequest("ribs/check", { device: ribDevice }, token);
        if (isCurrent(token)) {
          ribsStale = false; applyStatus(result);
          notice(state.ribs.message || "Rib cage connection checked.", state.ribs.state !== "ready");
        }
      } else if (button.id === "robot-ribs-disconnect") {
        const result = await queuedRequest("ribs/disconnect", {}, token);
        if (isCurrent(token)) { applyStatus(result); notice(state.ribs.message || "Rib serial connection closed. Holding torque is unchanged."); }
      } else if (button.id === "robot-torque-on" || button.id === "robot-release") {
        const enabled = button.id === "robot-torque-on";
        await command({ kind: "ribs_torque", enabled }, enabled ? "Rib torque on" : "Release ribs", token);
      } else if (button.id === "robot-drums-torque-on" || button.id === "robot-drums-release") {
        const enabled = button.id === "robot-drums-torque-on";
        if (enabled) notice("Moving arms to rest…");
        await command({ kind: "drums_torque", enabled }, enabled ? "Arm torque on + rest" : "Release arms", token);
      } else if (button.dataset.robotTest === "strike") {
        const motor = state.motors.find(item => item.id === Number(button.dataset.motorId));
        if (!motor || motor.group !== "drums") throw new Error("This drumming motor is unavailable.");
        await command({ kind: "drums_strike", motor_id: motor.id }, `${motor.name} · raise, strike and return`, token);
      } else if (button.dataset.robotTest === "move") {
        const id = Number(button.dataset.motorId), motor = state.motors.find(item => item.id === id), draft = drafts.get(id);
        if (!motor || !draft) throw new Error("This motor is unavailable. Refresh robot configuration.");
        const position = integer(draft.position, motor.min, motor.max, `${motor.name} position`);
        const duration_ms = integer(draft.duration, 100, 5000, "Duration");
        await command({ kind: "move", motor_id: id, position, duration_ms }, `${motor.name} → ${position} in ${duration_ms} ms`, token);
      } else if (button.dataset.robotTest === "ribs") {
        const position = integer($("ribs-position").value, 0, 127, "Rib cage position");
        const duration_ms = integer($("ribs-duration").value, 100, 5000, "Duration");
        await command({ kind: "ribs", position, duration_ms }, `Rib cage → ${position} in ${duration_ms} ms`, token);
      }
    }, diagnosticGroup);
  }

  function init({ container }) {
    if (initialized) return;
    root = container;
    if (!root) return;
    root.classList.add("robot-workspace");
    root.innerHTML = `<header class="robot-heading"><div><span class="eyebrow">Hardware test bench</span><h1>Keirzo setup</h1><p>Check Keirzo’s motors and LEDs. <a href="#robot-control">Open Keirzo control →</a></p></div><span id="robot-badge" class="robot-badge">Motor controls ready</span></header>
      <section class="robot-connection" aria-label="Robot connection and output">
        <div class="robot-connection-top"><div class="robot-actions"><button id="robot-emergency-stop" class="robot-button robot-emergency" type="button">Emergency stop</button><button id="robot-emergency-reset" class="robot-button" type="button" hidden>Reset emergency stop</button></div></div>
        <p id="robot-motor-hint" class="robot-note">Connect a motor group and turn its torque on to test it.</p>
        <p class="robot-note robot-feedback">Emergency stop cancels patterns and head recording, and releases connected head, rib and arm torque. Reset does not enable torque.</p>
      </section>
      <p id="robot-status" class="robot-status" role="status" aria-live="polite">Open this tab to load the robot configuration.</p>
      <div class="robot-sections">
        <section class="robot-section robot-head" aria-labelledby="robot-head-title"><header class="robot-section-heading"><div><span class="eyebrow">01 / Read-only identification</span><h2 id="robot-head-title">Head</h2></div><span>2XL430-W250-T · 2 axes</span></header><p class="robot-section-intro">Start with the head upright. Identify both motors on its own USB adapter, then record this position.</p>${serialConnectionHTML("head", "Head", true)}<div class="robot-head-upright"><button id="robot-head-upright" class="robot-button" type="button">Record upright position</button><button id="robot-head-release" class="robot-button robot-release" type="button" hidden>Release head</button><p id="robot-head-reference" class="robot-note" role="status" aria-live="polite"></p></div><p class="robot-note">Connection checks and upright capture do not move the head. Before starting, support the head, release its torque, and hold it near the saved centre. Start enables holding torque at its current position.</p>${calibrationHTML()}</section>
        <section class="robot-section robot-ribs" aria-labelledby="robot-ribs-title"><header class="robot-section-heading"><div><span class="eyebrow">02 / Direct USB control</span><h2 id="robot-ribs-title">Rib cage</h2></div><span id="robot-ribs-count">0 motors</span></header>
          <p class="robot-section-intro">Connect directly to the six rib motors. Stop the legacy interaction.py bridge before checking this port so it is available here.</p>
          <div class="robot-rib-connection"><label for="robot-ribs-device">Rib cage serial port<select id="robot-ribs-device"><option value="">Choose the rib cage serial port…</option></select></label><div class="robot-actions"><button id="robot-ribs-check" class="robot-button robot-test" type="button">Check connection</button><button id="robot-refresh" class="robot-button robot-subtle" type="button">Refresh ports</button><button id="robot-ribs-disconnect" class="robot-button robot-subtle" type="button">Disconnect</button></div><div class="robot-rib-status"><span id="robot-ribs-state" class="robot-badge">Not checked</span><span>1,000,000 baud</span></div><p id="robot-ribs-message" class="robot-note" role="status" aria-live="polite">Choose the serial port and check the six rib motors.</p><p class="robot-note">Check connection reads positions and torque without moving the motors.</p><p id="robot-ribs-identity" class="robot-note" hidden></p><p id="robot-ribs-checked" class="robot-note robot-checked">Not checked yet. Readings are not live feedback.</p><div id="robot-ribs-readback" class="robot-rib-readback" hidden><table><caption>Last measured motor values</caption><thead><tr><th scope="col">Motor</th><th scope="col">Connection</th><th scope="col">Position</th><th scope="col">Torque</th><th scope="col">Error</th></tr></thead><tbody id="robot-ribs-readings"></tbody></table></div></div>
          <div class="robot-torque"><div class="robot-actions"><button id="robot-torque-on" class="robot-button" type="button">Rib torque on</button><button id="robot-release" class="robot-button robot-release" type="button">Release ribs</button></div><p id="robot-torque-note">Release ribs removes holding torque. Disconnect closes the port and leaves torque unchanged.</p></div>
          <p class="robot-section-intro">Move all six ribs together, or expand individual motors below.</p><div id="robot-ribs-test" class="robot-ribs-test" hidden><div class="robot-position-label"><label for="robot-ribs-position">Rib cage position</label><output id="robot-ribs-value" for="robot-ribs-position">0</output></div><input id="robot-ribs-position" type="range" min="0" max="127" step="1" value="0"><div class="robot-range"><span>0</span><span>127</span></div><div class="robot-rib-actions"><label for="robot-ribs-duration">Duration (ms)<input id="robot-ribs-duration" type="number" min="100" max="5000" step="1" value="2500"></label><button type="button" class="robot-button robot-test" data-robot-test="ribs">Test rib cage</button></div><p class="robot-note">Max mapping, 0–127: motors 20–22 → 2450–4090; motors 25–27 → 1700–0.</p></div><details class="robot-rib-details"><summary>Individual rib motors</summary><div id="robot-ribs-motors" class="robot-motors"></div></details></section>
        <section class="robot-section robot-drums" aria-labelledby="robot-drums-title"><header class="robot-section-heading"><div><span class="eyebrow">03 / Percussion</span><h2 id="robot-drums-title">Drumming arms</h2></div><span id="robot-drums-count">0 motors</span></header><p class="robot-section-intro">Connect the arms on their separate USB adapter. Torque on returns all four arms to rest from their current positions.</p>${serialConnectionHTML("drums", "Drumming arms")}<div class="robot-torque"><div class="robot-actions"><button id="robot-drums-torque-on" class="robot-button" type="button">Arm torque on + rest</button><button id="robot-drums-release" class="robot-button robot-release" type="button">Release arms</button></div><p>Torque on moves all four arms to rest over two seconds, including arms already powered. Release arms removes their holding torque.</p></div><p class="robot-section-intro">Each test raises the arm, hits, then returns to raised rest. Advanced provides manual position tests.</p><div id="robot-drums-motors" class="robot-motors"></div></section>
        <section class="robot-section robot-leds" aria-labelledby="robot-leds-title"><header class="robot-section-heading"><div><span class="eyebrow">04 / Light</span><h2 id="robot-leds-title">LEDs</h2></div><span>USB MIDI</span></header><p class="robot-section-intro">Send a static colour to the LEDs. The Pimoroni connects automatically.</p><div class="robot-midi-controls"><p id="robot-midi-device" class="robot-note" role="status" aria-live="polite">Pimoroni not connected</p><button id="robot-midi-connect" class="robot-button" type="button" hidden>Retry MIDI connection</button></div><p id="robot-midi-hint" class="robot-note">MIDI connects automatically when this tab opens.</p><div class="robot-colour-row"><div id="robot-led-swatch" class="robot-led-swatch" aria-hidden="true"></div><label for="robot-led-color">Colour<input id="robot-led-color" type="color" value="#78aaff"></label></div><div class="robot-position-label"><label for="robot-led-brightness">Brightness</label><output id="robot-brightness-value" for="robot-led-brightness">50%</output></div><input id="robot-led-brightness" type="range" min="0" max="100" step="1" value="50"><div class="robot-actions robot-led-actions"><button type="button" class="robot-button robot-test" data-robot-led="color">Test colour</button><button type="button" class="robot-button" data-robot-led="off">LEDs off</button></div><p class="robot-note">Static RGB and off use the LED firmware’s fill command.</p></section>
      </div><section class="robot-log" aria-labelledby="robot-log-title"><header><h2 id="robot-log-title">Command log</h2><button id="robot-clear-history" class="robot-button robot-subtle" type="button">Clear log</button></header><p id="robot-history-empty" class="robot-note">Commands appear here after a test.</p><ol id="robot-history" aria-label="Recent robot commands"></ol></section>`;
    root.addEventListener("click", click);
    root.addEventListener("input", input);
    root.addEventListener("change", change);
    globalThis.addEventListener?.("pagehide", () => {
      if (!active) return;
      globalThis.HydraRobotLive?.stop();
      deactivate().catch(() => {});
    });
    globalThis.addEventListener?.("pageshow", event => {
      if (event.persisted && !root.hidden) return activate();
    });
    initialized = true;
    renderConnections(); renderMotors(); updateLEDPreview();
  }

  function activate({ signal } = {}) {
    if (!initialized) return Promise.resolve();
    if (active) return activation || Promise.resolve();
    active = true; generation++; calibrationError = ""; calibrationFailures = 0;
    const token = generation, session = ++sessionGeneration, emergency = emergencyRevision;
    busy = true; updateControls(); notice("Loading Keirzo controls…");
    connectMIDI();
    const pending = (async () => { try {
      const result = await queuedRequest("status", undefined, token, signal ? { signal } : undefined);
      if (active && session === sessionGeneration && emergency === emergencyRevision) { applyStatus(result); notice(state.emergency_stopped ? "Emergency stop active." : "Keirzo controls ready."); }
    } catch (error) { if (isCurrent(token) && !error.cancelled && error.name !== "AbortError") notice(`Could not load Keirzo controls: ${error.message}`, true); }
    finally { if (active && session === sessionGeneration) { busy = false; updateControls(); if (statusTimer === undefined) statusTimer = setInterval(pollEmergencyStatus, 1000); } }
    })();
    activation = pending;
    pending.finally(() => { if (activation === pending) activation = undefined; });
    return pending;
  }

  async function deactivate() {
    if (!initialized || !active) return;
    const stoppingDrums = stopDrumming();
    for (const entry of preparations) entry.abort();
    active = false; generation++; sessionGeneration++; busy = false; stopCalibrationPolling(); stopDrumsPolling(); stopHeadPolling();
    if (statusTimer !== undefined) clearInterval(statusTimer);
    statusTimer = undefined; updateControls();
    await stoppingDrums;
  }

  return { init, activate, deactivate, snapshot, subscribe, sendColour, moveRibs, moveHead, moveHeadAxes, setHeadTorque, prepareLive, startDrumming, scheduleDrums, stopDrumming, emergencyStop, resetEmergency };
})();
