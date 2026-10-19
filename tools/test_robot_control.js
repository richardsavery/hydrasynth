"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const script = fs.readFileSync(`${__dirname}/../dashboard/robot-control.js`, "utf8");
const drummerScript = fs.readFileSync(`${__dirname}/../dashboard/robot-drums.js`, "utf8");
const copy = value => JSON.parse(JSON.stringify(value));
const motors = [
  { id: 0, name: "Kick", group: "drums", min: 2100, max: 2450, default: 2200, duration_ms: 1000, rest: 2200, strike: 2370, range_source: "Max kick range 2100–2450" },
  { id: 1, name: "Ride", group: "drums", min: 1850, max: 2125, default: 1850, duration_ms: 150, rest: 1850, strike: 2000, range_source: "Max motor 1 range 1850–2125" },
  { id: 2, name: "Snare", group: "drums", min: 2070, max: 2350, default: 2300, duration_ms: 150, rest: 2300, strike: 2150, range_source: "Max motor 2 range 2070–2350" },
  { id: 3, name: "Hi-hat", group: "drums", min: 2410, max: 2600, default: 2600, duration_ms: 200, rest: 2600, strike: 2430, range_source: "Max hi-hat range 2410–2600" },
  { id: 4, name: "Head turn", group: "head", min: 1620, max: 2380, default: 2000, duration_ms: 3000, range_source: "Max head range" },
  { id: 20, name: "Rib 1", group: "ribs", min: 2450, max: 4090, default: 2450, duration_ms: 2500, range_source: "Max rib range" }
];
const ribDevice = "/dev/cu.usbserial-FT78LBUJ";
const drumDevice = "/dev/cu.usbserial-FT7WBEBD", headDevice = "/dev/cu.usbserial-head";
const ledName = "Plasma 2040 CircuitPython usb_midi.ports[0]";
const ribReadings = [20, 21, 22, 25, 26, 27].map(id => ({ id, connected: true, position: id < 25 ? 2450 : 1700, torque_enabled: false, profile_mode: "time", operating_mode: 3, error: null }));
const drumReadings = [0, 1, 2, 3].map(id => ({ id, connected: true, position: id === 3 ? 2613 : id === 1 ? 1900 : 2200, torque_enabled: false, profile_mode: "time", operating_mode: 3, error: null }));
const headReadings = [7, 8].map(id => ({ id, model_number: 1090, firmware: 48, connected: true, position: 2048 + id, torque_enabled: false, profile_mode: "velocity", operating_mode: 3, error: null }));
const liveHeadReadings = [0, 1].map(id => ({ id, model_number: 1090, firmware: 45, connected: true, position: id === 0 ? 2000 : 2500, torque_enabled: false, profile_mode: "time", operating_mode: 3, error: null }));
const liveHeadSaved = { device: headDevice, baudrate: 1000000, axes: [{ id: 0, label: "Turn", min: 1800, centre: 2000, max: 2200 }, { id: 1, label: "Tilt", min: 2300, centre: 2500, max: 2700 }] };
const liveHeadOptions = { headReadings: liveHeadReadings, head: { calibration: { recording: false, state: "idle", saved: liveHeadSaved, saved_matches_connection: false } } };

function harness(initialArmed = false, options = {}) {
  const elements = new Map(), handlers = {}, windowHandlers = {}, requests = [], midiRequests = [], sent = [], timers = new Map(), intervals = new Map();
  const pathInterceptors = new Map();
  let nextTimerId = 1, now = 0, performanceStarted = 0;
  let performanceState = { token: null, state: "stopped", busy: false };
  const retiredPerformances = new Set(), acceptedHits = [];
  let nextId = 0, emergencyStopped = Boolean(options.emergencyStopped), armed = !emergencyStopped, config = { host: "127.0.0.1", port: 5009 }, intercept, liveStops = 0, nextDrumsStatus;
  let ribs = { state: "unchecked", code: "unchecked", message: "Check the serial connection.", device: ribDevice,
    baudrate: 1000000, checked_at: null, ports: [ribDevice, "/dev/cu.usbserial-other"], motors: [], dependency_available: true, ...options.ribs }, nextCheck;
  let drums = { state: "unchecked", device: drumDevice, baudrate: 1000000, port_open: false, ports: [ribDevice, drumDevice, headDevice], motors: [], ...options.drums }, nextDrumsCheck;
  let head = { state: "unchecked", device: "", baudrate: 57600, ports: [ribDevice, drumDevice, headDevice], motors: [], ...options.head }, nextHeadCheck;
  let nextCalibration, nextHeadStatus;
  function parse(markup) {
    for (const match of markup.matchAll(/<(button|input|select|output|div|span|p|ol)\b([^>]*)>/g)) {
      const attributes = {};
      for (const pair of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) attributes[pair[1]] = pair[2];
      if (!attributes.id && !Object.keys(attributes).some(key => key.startsWith("data-robot"))) continue;
      const id = attributes.id || `generated-${nextId++}`;
      const element = get(id);
      element.tagName = match[1].toUpperCase();
      element.dataset = {};
      element.disabled = /\sdisabled(?:\s|$)/.test(match[2]);
      element.hidden = /\shidden(?:\s|$)/.test(match[2]);
      if (attributes.value !== undefined) element.value = attributes.value;
      for (const [key, value] of Object.entries(attributes)) if (key.startsWith("data-")) element.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    }
  }
  function get(id) {
    if (!elements.has(id)) {
      let html = "";
      const element = { id, dataset: {}, value: "", textContent: "", hidden: false, disabled: false, style: {}, markupWrites: 0,
        classList: { add() {}, toggle() {} }, closest(selector) { return selector === "button" ? this : null; } };
      Object.defineProperty(element, "innerHTML", { get: () => html, set(value) { html = value; element.markupWrites++; parse(value); } });
      elements.set(id, element);
    }
    return elements.get(id);
  }
  const root = get("root");
  Object.assign(root, {
    querySelector: selector => get(selector.slice(1)),
    querySelectorAll: selector => [...elements.values()].filter(element => selector === "[data-robot-test]" ? element.dataset.robotTest !== undefined : selector === "[data-robot-led]" && element.dataset.robotLed !== undefined),
    addEventListener(type, callback) { handlers[type] = callback; }
  });
  const output = { id: "led-device", name: ledName, state: "connected", send(bytes) { sent.push(copy(bytes)); }, ...options.output };
  const synthOutput = { id: "synth", name: "Hydrasynth", state: "connected", send() { throw new Error("Must not select synth output automatically"); } };
  const existingHandler = () => {};
  const midi = { outputs: new Map([[synthOutput.id, synthOutput], ...(options.withLED === false ? [] : [[output.id, output]])]), onstatechange: existingHandler,
    addEventListener(type, callback) { this.listener = callback; this.listenerType = type; } };
  const status = () => ({ config, motors: copy(motors), armed, emergency_stopped: emergencyStopped, ribs: copy(ribs), drums: copy(drums), head: copy(head) });
  const context = vm.createContext({
    AbortController, performance: { now: () => now },
    HydraRobotLive: { stop() { liveStops++; } },
    setInterval(callback, delay) { const id = nextTimerId++; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) { const id = nextTimerId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    navigator: { requestMIDIAccess(accessOptions) { midiRequests.push(copy(accessOptions)); return options.requestMIDIAccess ? options.requestMIDIAccess(midi, midiRequests.length) : Promise.resolve(midi); } },
    addEventListener(type, callback) { windowHandlers[type] = callback; },
    async fetch(url, requestOptions) {
      const entry = { path: url.replace("/api/robot/", ""), options: requestOptions, body: requestOptions.body ? JSON.parse(requestOptions.body) : undefined };
      requests.push(entry);
      if (pathInterceptors.has(entry.path)) {
        const handler = pathInterceptors.get(entry.path); pathInterceptors.delete(entry.path);
        const result = await handler(entry); if (result) return result;
      }
      if (intercept) {
        const handler = intercept;
        intercept = undefined;
        const result = await handler(entry);
        if (result) return result;
      }
      let result;
      if (entry.path.startsWith("drums/performance/")) {
        const operation = entry.path.split("/").at(-1), token = entry.body?.token;
        const failure = error => ({ ok: false, status: 409, json: async () => ({ ok: false, error, performance: copy(performanceState) }) });
        if (operation === "start") {
          if (retiredPerformances.has(token) || emergencyStopped) return failure("Drum performance was cancelled.");
          performanceStarted = now;
          performanceState = { token, state: "preparing", busy: true };
        } else if (operation === "schedule") {
          if (token !== performanceState.token || !["ready", "preparing"].includes(performanceState.state) || retiredPerformances.has(token)) return failure("This drum performance session is no longer active.");
          if (now - performanceStarted >= 500) performanceState.state = "ready";
          if (entry.body.events.length && performanceState.state !== "ready") return failure("Wait for raised rest.");
          acceptedHits.push(...copy(entry.body.events));
        } else if (operation === "stop") {
          retiredPerformances.add(token);
          if (token === performanceState.token) performanceState = { token, state: "stopped", busy: false };
        }
        result = { ok: true, server_time_ms: now + 10000, performance: copy(performanceState) };
      } else if (entry.path === "status") result = status();
      else if (entry.path === "arm") throw new Error("The deprecated arm endpoint must never be called.");
      else if (entry.path === "emergency-stop") {
        emergencyStopped = true; armed = false;
        if (performanceState.token) retiredPerformances.add(performanceState.token);
        performanceState = { ...performanceState, state: "stopped", busy: false };
        ribs.motors = ribs.motors.map(motor => ({ ...motor, torque_enabled: false }));
        head.motors = head.motors.map(motor => ({ ...motor, torque_enabled: false }));
        head.busy = false;
        if (options.headAxisMotion) head.motion = [];
        drums = { ...drums, busy: false, motors: drums.motors.map(motor => ({ ...motor, torque_enabled: false })), strike: { ...drums.strike, state: "cancelled" } };
        if (head.calibration) head.calibration = { ...head.calibration, recording: false, state: "stopped" };
        result = { ...status(), ok: true, message: "Emergency stop active." };
      } else if (entry.path === "emergency-reset") { emergencyStopped = false; armed = true; result = { ...status(), ok: true }; }
      else if (entry.path === "ribs/check") {
        ribs = { ...ribs, state: "ready", code: "ready", device: entry.body.device, message: "All six rib motors responded.",
          checked_at: "2026-10-16T00:00:00Z", motors: copy(ribReadings), ...nextCheck };
        nextCheck = undefined;
        result = { ok: true, armed, ribs: copy(ribs) };
      } else if (entry.path === "ribs/disconnect") {
        ribs = { ...ribs, state: "disconnected", message: "Serial connection closed." };
        result = { ok: true, armed, ribs: copy(ribs) };
      } else if (entry.path === "drums/check") {
        drums = { ...drums, ...entry.body, state: "ready", port_open: true, message: "All four arm motors responded.", checked_at: "2026-10-16T00:00:00Z", motors: copy(drumReadings), ...nextDrumsCheck };
        nextDrumsCheck = undefined; result = { ok: true, armed, drums: copy(drums) };
      } else if (entry.path === "head/check") {
        head = { ...head, ...entry.body, state: "ready", message: "Two 2XL430 motors identified.", checked_at: "2026-10-16T00:00:00Z", motors: copy(options.headReadings || headReadings), upright_reference: null, ...nextHeadCheck };
        if (head.calibration?.saved && !nextHeadCheck?.calibration) {
          const connection = head.calibration.saved_connection, savedDevice = connection ? (connection.state === "matched" ? connection.device : null) : head.calibration.saved.device;
          head.calibration = { ...head.calibration, saved_matches_connection: head.device === savedDevice && head.baudrate === head.calibration.saved.baudrate && head.calibration.saved.axes.every(axis => head.motors.some(motor => motor.id === axis.id)) };
        }
        nextHeadCheck = undefined; result = { ok: true, armed, head: copy(head) };
      } else if (entry.path === "head/upright") {
        head.upright_reference = { device: head.device, baudrate: head.baudrate, recorded_at: "2026-10-16T00:01:00Z", positions: head.motors.map(({ id, position }) => ({ id, position })) };
        result = { ok: true, armed, head: copy(head), message: "Upright head position recorded." };
      } else if (entry.path === "head/status") {
        if (nextHeadStatus) { head = { ...head, ...nextHeadStatus }; nextHeadStatus = undefined; }
        result = { ok: true, armed, head: copy(head) };
      } else if (entry.path === "head/calibration/start") {
        head.calibration = { ...head.calibration, state: "recording", recording: true, device: head.device, baudrate: head.baudrate,
          started_at: "2026-10-16T00:01:00Z", sampled_at: "2026-10-16T00:01:00Z", sample_count: 1, message: "Recording manual movement.",
          axes: head.motors.map(motor => ({ id: motor.id, label: "", position: motor.position, min: motor.position, max: motor.position, centre: motor.position })) };
        result = { ok: true, head: copy(head), armed, message: "Recording manual movement." };
      } else if (entry.path === "head/calibration") {
        if (nextCalibration) { head.calibration = { ...head.calibration, ...nextCalibration }; nextCalibration = undefined; }
        result = { ok: true, head: copy(head), armed };
      } else if (entry.path === "head/calibration/stop") {
        head.calibration = { ...head.calibration, state: "stopped", recording: false, message: "Recording stopped." };
        result = { ok: true, head: copy(head), armed, message: "Recording stopped." };
      } else if (entry.path === "head/calibration/centre") {
        head.calibration.axes = head.calibration.axes.map(axis => ({ ...axis, centre: axis.position }));
        result = { ok: true, head: copy(head), armed, message: "Centre recorded." };
      } else if (entry.path === "head/calibration/save") {
        head.calibration = { ...head.calibration, state: "saved", saved_matches_connection: true,
          saved: { device: head.device, baudrate: head.baudrate, axes: head.calibration.axes.map(axis => ({ ...axis, label: entry.body.labels[String(axis.id)] })) } };
        result = { ok: true, head: copy(head), armed, message: "Head range saved." };
      } else if (entry.path === "head/disconnect") {
        head = { ...head, state: "disconnected", message: "Head serial connection closed." }; result = { ok: true, armed, head: copy(head) };
      } else if (entry.path === "drums/disconnect") {
        if (performanceState.token) retiredPerformances.add(performanceState.token);
        performanceState = { ...performanceState, state: "stopped", busy: false };
        drums = { ...drums, state: "disconnected", port_open: false, performance: copy(performanceState), message: "Arm serial connection closed." }; result = { ok: true, armed, drums: copy(drums) };
      } else if (entry.path === "drums/status") {
        if (nextDrumsStatus) { drums = { ...drums, ...nextDrumsStatus }; nextDrumsStatus = undefined; }
        result = { ok: true, armed, drums: copy(drums) };
      }
      else {
        if (entry.body.kind === "ribs_torque") ribs.motors = ribs.motors.map(motor => ({ ...motor, torque_enabled: entry.body.enabled }));
        if (entry.body.kind === "drums_torque") {
          drums.motors = drums.motors.map(motor => ({ ...motor, torque_enabled: entry.body.enabled,
            ...(entry.body.enabled ? { position: motors.find(item => item.group === "drums" && item.id === motor.id).rest, moving: 0 } : {}) }));
          if (!entry.body.enabled) {
            if (performanceState.token) retiredPerformances.add(performanceState.token);
            performanceState = { ...performanceState, state: "stopped", busy: false };
            drums.performance = copy(performanceState);
          }
        }
        if (entry.body.kind === "head_torque") {
          head.motors = head.motors.map(motor => ({ ...motor, torque_enabled: entry.body.enabled }));
          if (!entry.body.enabled) {
            head.busy = false;
            if (options.headAxisMotion) head.motion = [];
          }
        }
        if (["head_move", "head_moves"].includes(entry.body.kind)) {
          const targets = (entry.body.targets || [{ motor_id: entry.body.motor_id, position: entry.body.position, duration_ms: entry.body.duration_ms }])
            .map(target => ({ ...target, duration_ms: options.headActualDuration || target.duration_ms, requested_duration_ms: target.duration_ms }));
          head.busy = Boolean(options.headReportsBusy);
          head.last_move = { ...(entry.body.kind === "head_moves" ? { targets, duration_ms: Math.max(...targets.map(target => target.duration_ms)) } : targets[0]), started_at: "2026-10-16T00:00:00Z" };
          head.motors = head.motors.map(motor => {
            const target = targets.find(target => target.motor_id === motor.id);
            return target ? { ...motor, position: target.position } : motor;
          });
          if (options.headAxisMotion) {
            head.motion = (head.motion || []).filter(motion => !targets.some(target => target.motor_id === motion.motor_id));
            if (options.headReportsBusy) head.motion.push(...targets.map(target => ({ motor_id: target.motor_id, remaining_ms: target.duration_ms })));
            head.busy = head.motion.length > 0;
          }
        }
        if (entry.body.kind === "drums_strike") {
          const motor = motors.find(motor => motor.id === entry.body.motor_id), reading = drums.motors.find(reading => reading.id === motor.id);
          drums = { ...drums, busy: true, strike: { state: "preparing", motor_id: motor.id, origin: reading.position, rest_position: motor.rest, strike_position: motor.strike } };
        }
        result = { ok: true, dry_run: entry.body.dry_run, armed, ribs: copy(ribs), drums: copy(drums), head: copy(head), commands: [{ address: "Dynamixel", args: [entry.body.motor_id ?? 0, entry.body.position ?? 0, entry.body.duration_ms ?? 0] }], message: "Command accepted." };
      }
      return { ok: true, json: async () => copy({ emergency_stopped: emergencyStopped, ...result }) };
    }
  });
  vm.runInContext(script, context);
  const api = context.HydraRobotControl;
  api.init({ container: root });
  const element = key => get(`robot-${key}`);
  const click = key => handlers.click({ target: element(key) });
  const clickData = (field, value) => {
    const button = [...elements.values()].find(item => item.dataset[field] === value && item.tagName === "BUTTON");
    assert.ok(button, `button ${field}=${value} exists`);
    return handlers.click({ target: button });
  };
  const input = (key, value) => { const target = element(key); target.value = String(value); return handlers.input({ target }); };
  const change = (key, value) => { const target = element(key); target.value = value; return handlers.change({ target }); };
  return { api, root, element, click, clickData, input, change, requests, midiRequests, sent, midi, output, existingHandler, windowHandlers,
    status: () => copy(status()),
    updateStatus(value) { if (value.ribs) ribs = { ...ribs, ...value.ribs }; if (value.head) head = { ...head, ...value.head }; if (value.drums) drums = { ...drums, ...value.drums }; },
    createDrummer(clock) {
      vm.runInContext(drummerScript, context);
      return context.HydraRobotDrums.createEngine({ hardware: api, clock, now: () => now,
        setInterval() { return "drummer-timer"; }, clearInterval() {} });
    },
    timers, intervals, acceptedHits,
    get now() { return now; }, advance(milliseconds) { now += milliseconds; },
    runWait() { const [id, timer] = [...timers.entries()].find(([_id, timer]) => timer.delay === 100) || []; assert.ok(timer, "a preparation wait is scheduled"); timers.delete(id); now += timer.delay; timer.callback(); },
    get liveStops() { return liveStops; },
    runStatusPoll() { return [...intervals.values()][0].callback(); },
    runTimer() { const [id, timer] = timers.entries().next().value || []; assert.ok(timer, "a timer is scheduled"); timers.delete(id); return timer.callback(); },
    ledButton(action) { return root.querySelectorAll("[data-robot-led]").find(button => button.dataset.robotLed === action); },
    nextCheck(value) { nextCheck = value; },
    nextDrumsCheck(value) { nextDrumsCheck = value; },
    nextDrumsStatus(value) { nextDrumsStatus = value; },
    testButton(id, kind = "move") { return [...elements.values()].filter(item => item.tagName === "BUTTON" && item.dataset.robotTest === kind && item.dataset.motorId === String(id)).at(-1); },
    nextHeadCheck(value) { nextHeadCheck = value; },
    nextHeadStatus(value) { nextHeadStatus = value; },
    nextCalibration(value) { nextCalibration = value; },
    testMotor(id) { return handlers.click({ target: { disabled: false, dataset: { robotTest: "move", motorId: String(id) }, closest() { return this; } } }); },
    testStrike(id) { return handlers.click({ target: { disabled: false, dataset: { robotTest: "strike", motorId: String(id) }, closest() { return this; } } }); },
    intercept(handler) { intercept = handler; },
    interceptPath(path, handler) { pathInterceptors.set(path, handler); } };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
async function startDrums(h, token = "test-session") {
  const pending = h.api.startDrumming({ token, instruments: [0, 2, 3] });
  await tick();
  for (let attempts = 0; attempts < 12 && [...h.timers.values()].some(timer => timer.delay === 100); attempts++) { h.runWait(); await tick(); }
  return pending;
}

(async () => {
  const startup = harness(), progress = [];
  assert.equal(startup.api.snapshot().active, false);
  const ready = await startup.api.prepareLive({ leds: true, ribs: true }, { onProgress: message => progress.push(message) });
  assert.equal(ready.busy, false, "preparation releases its gate before the live engine starts");
  assert.equal(ready.ribsReady, true); assert.equal(ready.torqueEnabled, true); assert.equal(ready.ledConnected, true);
  assert.deepEqual(startup.requests.map(entry => entry.path), ["status", "status", "ribs/check", "command"], "Start initializes and prepares only selected effects without visiting setup");
  assert.deepEqual(startup.requests.at(-1).body, { kind: "ribs_torque", enabled: true, dry_run: false });
  assert.equal(startup.sent.length, 0, "preparing does not start LED effects or movement");
  assert.ok(progress.indexOf("Connecting LEDs…") < progress.indexOf("Turning rib torque on…"));
  assert.match(startup.root.innerHTML, /Keirzo setup/);
  assert.doesNotMatch(startup.root.innerHTML, />Robot setup</);
  startup.nextCheck({ motors: ribReadings.map(motor => ({ ...motor, torque_enabled: true })) });
  await startup.api.prepareLive({ ribs: true });
  assert.equal(startup.requests.filter(entry => entry.path === "command").length, 1, "fresh readback skips torque-on if all six are already on");

  const ledOnly = harness(); await ledOnly.api.prepareLive({ leds: true });
  assert.ok(ledOnly.requests.every(entry => entry.path === "status"));
  const absentLED = harness(false, { withLED: false });
  await assert.rejects(absentLED.api.prepareLive({ leds: true, ribs: true }), /Pimoroni.*not connected/);
  assert.ok(absentLED.requests.every(entry => entry.path === "status"), "LED failure prevents rib checks and torque");
  assert.equal(absentLED.api.snapshot().busy, false);
  absentLED.midi.outputs.set(absentLED.output.id, absentLED.output);
  await absentLED.api.prepareLive({ leds: true, ribs: true });
  assert.equal(absentLED.api.snapshot().torqueEnabled, true, "a fresh Start recovers after connecting the LEDs");

  for (const failedRibs of [
    { state: "partial", message: "Rib 27 did not respond.", motors: ribReadings.slice(0, 5) },
    { motors: ribReadings.map(motor => ({ ...motor, profile_mode: "velocity" })) },
    { motors: ribReadings.map(motor => ({ ...motor, operating_mode: 1 })) }
  ]) {
    const incompatible = harness(); incompatible.nextCheck(failedRibs);
    await assert.rejects(incompatible.api.prepareLive({ ribs: true }), /did not respond|time profiles and position mode/);
    assert.ok(!incompatible.requests.some(entry => entry.path === "command"), "missing motors or incompatible modes prevent any torque write");
    assert.equal(incompatible.api.snapshot().busy, false);
  }
  const unknownPort = harness(false, { ribs: { device: "", ports: ["/dev/cu.usbmodem-unrelated"] } });
  await assert.rejects(unknownPort.api.prepareLive({ ribs: true }), /Choose the rib cage serial port/);
  assert.ok(unknownPort.requests.every(entry => entry.path === "status"), "automatic preparation never guesses an unrelated adapter");
  const unconfirmed = harness();
  unconfirmed.interceptPath("command", () => ({ ok: true, json: async () => ({ ok: true, emergency_stopped: false, ribs: { state: "ready", device: ribDevice, motors: copy(ribReadings) } }) }));
  await assert.rejects(unconfirmed.api.prepareLive({ ribs: true }), /torque was not confirmed/);

  const stoppedStart = harness(false, { emergencyStopped: true });
  await assert.rejects(stoppedStart.api.prepareLive({ ribs: true }), /emergency|cancelled/i);
  assert.ok(stoppedStart.requests.every(entry => entry.path === "status"));
  await stoppedStart.api.resetEmergency();
  await stoppedStart.api.prepareLive({ ribs: true });
  assert.equal(stoppedStart.api.snapshot().torqueEnabled, true, "only an explicit shared reset permits a fresh Start");

  const between = harness(), betweenAbort = new AbortController();
  await assert.rejects(between.api.prepareLive({ ribs: true }, { signal: betweenAbort.signal, onProgress(message) {
    if (message === "Turning rib torque on…") betweenAbort.abort();
  } }), error => error.name === "AbortError");
  await tick();
  assert.ok(!between.requests.some(entry => entry.path === "command"), "Stop after connection check prevents torque-on");
  const emergencyBetween = harness();
  let emergencyBetweenRequest;
  await assert.rejects(emergencyBetween.api.prepareLive({ ribs: true }, { onProgress(message) {
    if (message === "Turning rib torque on…") emergencyBetweenRequest = emergencyBetween.api.emergencyStop();
  } }), /cancelled|emergency/i);
  await emergencyBetweenRequest;
  assert.ok(!emergencyBetween.requests.some(entry => entry.path === "command"));

  const duplicate = harness(); let finishDuplicateCheck;
  duplicate.interceptPath("ribs/check", () => new Promise(resolve => { finishDuplicateCheck = resolve; }));
  const firstPrepare = duplicate.api.prepareLive({ ribs: true });
  const secondPrepare = duplicate.api.prepareLive({ ribs: true });
  assert.equal(firstPrepare, secondPrepare, "duplicate Start preparation shares one operation");
  await tick(); assert.equal(duplicate.api.snapshot().busy, true);
  finishDuplicateCheck(); await Promise.all([firstPrepare, secondPrepare]);
  assert.equal(duplicate.requests.filter(entry => entry.path === "ribs/check").length, 1);
  assert.equal(duplicate.requests.filter(entry => entry.path === "command").length, 1);

  const checkingCancel = harness(), checkAbort = new AbortController(); let finishCancelledCheck;
  checkingCancel.interceptPath("ribs/check", () => new Promise(resolve => { finishCancelledCheck = resolve; }));
  const cancelledCheck = checkingCancel.api.prepareLive({ ribs: true }, { signal: checkAbort.signal });
  const checkRejected = assert.rejects(cancelledCheck, /cancelled/);
  await tick(); checkAbort.abort(); await checkRejected;
  assert.equal(checkingCancel.api.snapshot().ribsReady, false);
  finishCancelledCheck(); await tick();
  assert.equal(checkingCancel.api.snapshot().ribsReady, false, "late cancelled check results cannot change the client state");
  assert.ok(!checkingCancel.requests.some(entry => entry.path === "command"));
  await checkingCancel.api.prepareLive({ ribs: true });
  assert.equal(checkingCancel.api.snapshot().torqueEnabled, true);

  const stalledRead = harness(), stalledAbort = new AbortController();
  stalledRead.interceptPath("ribs/check", entry => new Promise((resolve, reject) => {
    entry.options.signal.addEventListener("abort", () => reject(Object.assign(new Error("Read aborted"), { name: "AbortError" })), { once: true });
  }));
  const stalledPreparation = stalledRead.api.prepareLive({ ribs: true }, { signal: stalledAbort.signal });
  const stalledRejected = assert.rejects(stalledPreparation, /cancelled/);
  await tick(); stalledAbort.abort(); await stalledRejected; await tick();
  await stalledRead.api.prepareLive({ ribs: true });
  assert.equal(stalledRead.api.snapshot().torqueEnabled, true, "aborting a stalled read frees the request queue for a fresh Start");

  const torqueCancel = harness(), torqueAbort = new AbortController(); let finishCancelledTorque;
  torqueCancel.interceptPath("command", () => new Promise(resolve => { finishCancelledTorque = resolve; }));
  const cancelledTorque = torqueCancel.api.prepareLive({ ribs: true }, { signal: torqueAbort.signal });
  const torqueRejected = assert.rejects(cancelledTorque, /cancelled/);
  await tick(); torqueAbort.abort(); await torqueRejected;
  assert.equal(torqueCancel.api.snapshot().busy, true, "Stop returns promptly but an already-sent torque request retains the preparation gate");
  const requestsWhileTorquePending = torqueCancel.requests.length;
  torqueCancel.nextCheck({ motors: ribReadings.map(motor => ({ ...motor, torque_enabled: true })) });
  const restartAfterTorque = torqueCancel.api.prepareLive({ ribs: true });
  await tick(); assert.equal(torqueCancel.requests.length, requestsWhileTorquePending, "a new Start cannot overlap the cancelled torque request");
  finishCancelledTorque(); await restartAfterTorque;
  assert.equal(torqueCancel.requests.filter(entry => entry.path === "command").length, 1);
  assert.equal(torqueCancel.api.snapshot().torqueEnabled, true, "the next Start uses fresh torque readback after the old write settles");

  let finishPermission;
  const pendingMIDI = harness(false, { requestMIDIAccess: midi => new Promise(resolve => { finishPermission = () => resolve(midi); }) });
  const midiAbort = new AbortController();
  const pendingLEDStart = pendingMIDI.api.prepareLive({ leds: true, ribs: true }, { signal: midiAbort.signal });
  const midiRejected = assert.rejects(pendingLEDStart, /cancelled/);
  await tick(); midiAbort.abort(); await midiRejected; await tick();
  assert.equal(pendingMIDI.api.snapshot().busy, false, "MIDI permission does not prevent Stop from settling preparation");
  assert.ok(pendingMIDI.requests.every(entry => entry.path === "status"));
  finishPermission(); await tick();
  assert.ok(pendingMIDI.requests.every(entry => entry.path === "status"), "late MIDI permission cannot progress a cancelled startup");
  await pendingMIDI.api.prepareLive({ leds: true, ribs: true });

  let finishEmergencyPermission;
  const pendingEmergencyMIDI = harness(false, { requestMIDIAccess: midi => new Promise(resolve => { finishEmergencyPermission = () => resolve(midi); }) });
  const emergencyMIDIStart = pendingEmergencyMIDI.api.prepareLive({ leds: true });
  const emergencyMIDIRejected = assert.rejects(emergencyMIDIStart, /cancelled/);
  await tick(); await pendingEmergencyMIDI.api.emergencyStop(); await emergencyMIDIRejected; await tick();
  assert.equal(pendingEmergencyMIDI.api.snapshot().busy, false, "emergency directly cancels preparations even without a caller AbortSignal");
  finishEmergencyPermission(); await tick();

  const liveHead = harness(false, { ...liveHeadOptions, headActualDuration: 9000 });
  const preparedHead = await liveHead.api.prepareLive({ head: true });
  assert.deepEqual(liveHead.requests.map(entry => entry.path), ["status", "status", "head/check", "command"]);
  assert.deepEqual(liveHead.requests[2].body, { device: headDevice, baudrate: 1000000 }, "head startup uses the saved adapter and baud rate");
  assert.deepEqual(liveHead.requests[3].body, { kind: "head_torque", enabled: true, dry_run: false });
  assert.equal(preparedHead.headReady, true); assert.equal(preparedHead.headConnected, true); assert.equal(preparedHead.headTorqueEnabled, true);
  assert.equal(preparedHead.busy, false); assert.equal(preparedHead.headBusy, false);
  assert.deepEqual(copy(preparedHead.headCalibration), liveHeadSaved);
  assert.deepEqual(copy(preparedHead.headPositions), { 0: 2000, 1: 2500 });
  assert.ok(liveHead.requests.every(entry => !entry.body || !["head_move", "drums_torque", "ribs_torque"].includes(entry.body.kind)), "manual head startup only enables holding torque and never moves or powers other buses");
  assert.equal(liveHead.element("head-calibration-start").disabled, true);
  assert.equal(liveHead.element("head-release").hidden, false);
  const headMovement = await liveHead.api.moveHead(0, 2100, 6500);
  assert.deepEqual(liveHead.requests.at(-1).body, { kind: "head_move", motor_id: 0, position: 2100, duration_ms: 6500, dry_run: false }, "head ID 0 is not routed to the overlapping drum ID");
  assert.equal(headMovement.head.last_move.duration_ms, 9000, "the caller receives the driver’s speed-limited duration");
  assert.equal(liveHead.api.snapshot().headLastMove.duration_ms, 9000);
  assert.equal(liveHead.api.snapshot().headCheckedAt, "2026-10-16T00:00:00Z", "motion planning can distinguish fresh measured poses from historical goals");
  const beforeInvalidHead = liveHead.requests.length;
  await assert.rejects(liveHead.api.moveHead(0, 2201, 1000), /1800.*2200/);
  await assert.rejects(liveHead.api.moveHead(2, 2100, 1000), /saved head axes/);
  await assert.rejects(liveHead.api.moveHead(0, 2100, 999), /1000.*10000/);
  await assert.rejects(liveHead.api.moveHead(0, 2100, 10001), /1000.*10000/);
  assert.equal(liveHead.requests.length, beforeInvalidHead, "invalid head targets and durations never reach the service");
  await liveHead.click("head-release");
  assert.deepEqual(liveHead.requests.at(-1).body, { kind: "head_torque", enabled: false, dry_run: false });
  assert.equal(liveHead.api.snapshot().headTorqueEnabled, false);
  assert.equal(liveHead.api.snapshot().headLastMove, null, "release invalidates the old goal immediately, before its nominal duration expires");
  assert.equal(liveHead.element("head-calibration-start").disabled, false, "releasing the head makes hand calibration available again");
  await assert.rejects(liveHead.api.moveHead(1, 2500, 1000), /head torque on/);
  await liveHead.api.setHeadTorque(true);
  assert.equal(liveHead.api.snapshot().headTorqueEnabled, true);
  assert.equal(liveHead.api.snapshot().headLastMove, null, "manual repositioning and torque-on cannot revive a released target as the planning origin");
  const noSavedHead = harness();
  await assert.rejects(noSavedHead.api.prepareLive({ head: true }), /Record and save both head ranges/);
  assert.ok(noSavedHead.requests.every(entry => entry.path === "status"));

  const recordingHeadStartup = harness(false, { ...liveHeadOptions, head: { calibration: { ...liveHeadOptions.head.calibration, recording: true } } });
  await assert.rejects(recordingHeadStartup.api.prepareLive({ head: true }), /Stop head range recording/);
  assert.ok(!recordingHeadStartup.requests.some(entry => entry.path === "head/check" || entry.path === "command"));
  const malformedHead = harness(false, { ...liveHeadOptions, head: { calibration: { ...liveHeadOptions.head.calibration, saved: { ...liveHeadSaved, axes: [liveHeadSaved.axes[0], liveHeadSaved.axes[0]] } } } });
  await assert.rejects(malformedHead.api.prepareLive({ head: true }), /Record and save both head ranges/);
  for (const failedHead of [
    { motors: liveHeadReadings.map(motor => ({ ...motor, profile_mode: "velocity" })) },
    { motors: liveHeadReadings.map(motor => ({ ...motor, operating_mode: 4 })) },
    { motors: liveHeadReadings.map(motor => ({ ...motor, model_number: 1060 })) },
    { motors: liveHeadReadings.map(motor => ({ ...motor, connected: false })) },
    { motors: liveHeadReadings.map(motor => ({ ...motor, id: motor.id + 7 })) },
    { motors: liveHeadReadings.map(motor => ({ ...motor, torque_enabled: null })) },
    { motors: liveHeadReadings.map(motor => ({ ...motor, position: null })) },
    { calibration: { ...liveHeadOptions.head.calibration, saved_matches_connection: false } }
  ]) {
    const invalidHead = harness(false, liveHeadOptions); invalidHead.nextHeadCheck(failedHead);
    await assert.rejects(invalidHead.api.prepareLive({ head: true, ribs: true }));
    assert.ok(!invalidHead.requests.some(entry => entry.path === "command"), "all requested groups are checked before any torque-on when the head is unsafe");
    assert.equal(invalidHead.api.snapshot().headReady, false);
  }
  const invalidPositionHead = harness(false, liveHeadOptions);
  invalidPositionHead.nextHeadCheck({ motors: liveHeadReadings.map(motor => motor.id === 0 ? { ...motor, position: 823.5 } : motor) });
  await assert.rejects(invalidPositionHead.api.prepareLive({ head: true }), /Head position could not be read/);
  assert.ok(!invalidPositionHead.requests.some(entry => entry.path === "command"), "manual startup never accepts a non-integer position reading");
  const changedHeadPort = harness(false, liveHeadOptions);
  await changedHeadPort.api.activate(); await changedHeadPort.change("head-device", "/dev/cu.usbserial-different");
  await assert.rejects(changedHeadPort.api.prepareLive({ head: true }), /selected head connection does not match/);
  assert.ok(!changedHeadPort.requests.some(entry => entry.path === "head/check" || entry.path === "command"));

  const renamedHeadDevice = "COM7", headIdentity = { vid: 12125, pid: 8706, serial_number: "saved-openrb-serial" };
  const resolvedHeadCalibration = { ...liveHeadOptions.head.calibration, saved_connection: { state: "matched", device: renamedHeadDevice, identity: headIdentity } };
  const renamedHead = harness(false, { ...liveHeadOptions, head: { calibration: resolvedHeadCalibration } });
  const preparedRenamedHead = await renamedHead.api.prepareLive({ head: true });
  assert.deepEqual(renamedHead.requests.find(entry => entry.path === "head/check").body, { device: renamedHeadDevice, baudrate: 1000000 }, "head startup uses the adapter's resolved path on a new computer, not the path saved during calibration");
  assert.equal(preparedRenamedHead.headReady, true);
  assert.equal(preparedRenamedHead.headCalibration.device, headDevice, "resolving a port does not rewrite saved calibration in the browser");
  for (const connectionState of ["missing", "ambiguous", "unavailable"]) {
    const unresolvedHead = harness(false, { ...liveHeadOptions, head: { calibration: { ...resolvedHeadCalibration, saved_connection: { state: connectionState, device: null, identity: headIdentity, message: `Saved head adapter ${connectionState}.` } } } });
    await assert.rejects(unresolvedHead.api.prepareLive({ head: true }), new RegExp(`Saved head adapter ${connectionState}`));
    assert.ok(unresolvedHead.requests.every(entry => entry.path === "status"), "an unresolved head identity never falls back to its old path or enables torque");
    assert.equal(unresolvedHead.api.snapshot().headReady, false);
  }
  for (const invalidReadback of [
    { calibration: { ...resolvedHeadCalibration, saved_matches_connection: false } },
    { device: "/dev/cu.usbserial-wrong" },
    { baudrate: 57600 },
    { motors: liveHeadReadings.map(motor => ({ ...motor, id: motor.id + 7 })) }
  ]) {
    const unsafeResolvedHead = harness(false, { ...liveHeadOptions, head: { calibration: resolvedHeadCalibration } });
    unsafeResolvedHead.nextHeadCheck(invalidReadback);
    await assert.rejects(unsafeResolvedHead.api.prepareLive({ head: true }));
    assert.ok(!unsafeResolvedHead.requests.some(entry => entry.path === "command"), "USB identity does not bypass calibration, baud, path, or motor-ID verification");
  }
  const manualResolvedHead = harness(false, { ...liveHeadOptions, head: { calibration: resolvedHeadCalibration } });
  await manualResolvedHead.api.activate();
  await manualResolvedHead.change("head-device", headDevice);
  await assert.rejects(manualResolvedHead.api.prepareLive({ head: true }), /selected head connection does not match/);
  assert.ok(manualResolvedHead.requests.every(entry => entry.path === "status"));
  await manualResolvedHead.change("head-device", "");
  await assert.rejects(manualResolvedHead.api.prepareLive({ head: true }), /selected head connection does not match/);
  assert.ok(manualResolvedHead.requests.every(entry => entry.path === "status"), "clearing a resolved head selection prevents Start from restoring it");
  await manualResolvedHead.change("head-device", headDevice);
  await manualResolvedHead.change("head-baudrate", "1000000");
  await manualResolvedHead.click("head-check");
  const beforeManualStart = manualResolvedHead.requests.length;
  await assert.rejects(manualResolvedHead.api.prepareLive({ head: true }), /selected head connection does not match/);
  assert.ok(manualResolvedHead.requests.slice(beforeManualStart).every(entry => entry.path === "status"), "checking a manually selected different bus does not let Start replace the user's selection");
  const noHeadAcknowledgement = harness(false, liveHeadOptions);
  noHeadAcknowledgement.interceptPath("command", () => ({ ok: true, json: async () => ({ ok: true, emergency_stopped: false }) }));
  await assert.rejects(noHeadAcknowledgement.api.prepareLive({ head: true }), /Head torque was not confirmed/);

  const abortedHead = harness(false, liveHeadOptions), headStartAbort = new AbortController();
  await assert.rejects(abortedHead.api.prepareLive({ head: true }, { signal: headStartAbort.signal, onProgress(message) {
    if (message === "Holding head in its current position…") headStartAbort.abort();
  } }), /cancelled/);
  assert.ok(!abortedHead.requests.some(entry => entry.path === "command"));
  const stoppedHead = harness(false, liveHeadOptions); let headStartEmergency;
  await assert.rejects(stoppedHead.api.prepareLive({ head: true }, { onProgress(message) {
    if (message === "Holding head in its current position…") headStartEmergency = stoppedHead.api.emergencyStop();
  } }), /cancelled|emergency/i);
  await headStartEmergency;
  assert.ok(!stoppedHead.requests.some(entry => entry.path === "command"));

  for (const outsidePosition of [823, 1799, 2201]) {
    const outsideHead = harness(false, { ...liveHeadOptions, headReadings: liveHeadReadings.map(motor => motor.id === 0 ? { ...motor, position: outsidePosition } : motor) });
    await assert.rejects(outsideHead.api.prepareLive({ head: true, ribs: true, drums: true }), /outside its saved range.*Support the head.*hold it near the saved centre/);
    assert.ok(!outsideHead.requests.some(entry => entry.path === "command"), "a head outside its saved range blocks all powered requests");
    assert.equal(outsideHead.api.snapshot().headTorqueEnabled, false);
  }
  const supportedPositions = { 0: 2010, 1: 2490 };
  const supportedHead = harness(false, { ...liveHeadOptions, headReadings: liveHeadReadings.map(motor => ({ ...motor, position: supportedPositions[motor.id] })) });
  const supported = await supportedHead.api.prepareLive({ head: true });
  assert.deepEqual(copy(supported.headPositions), supportedPositions, "Start holds the manually supported pose without recentering it");
  assert.deepEqual(supportedHead.requests.filter(entry => entry.path === "command").map(entry => entry.body), [{ kind: "head_torque", enabled: true, dry_run: false }]);
  supportedHead.nextHeadCheck({ motors: liveHeadReadings.map(motor => ({ ...motor, torque_enabled: true })) });
  const beforeHeldStart = supportedHead.requests.filter(entry => entry.path === "command").length;
  await supportedHead.api.prepareLive({ head: true });
  assert.equal(supportedHead.requests.filter(entry => entry.path === "command").length, beforeHeldStart, "fresh readback skips torque-on when both head motors already hold");

  const partialHeadTorque = harness(false, liveHeadOptions);
  partialHeadTorque.interceptPath("command", () => ({ ok: true, json: async () => ({ ok: true, emergency_stopped: false, head: { ...partialHeadTorque.status().head, motors: liveHeadReadings.map(motor => ({ ...motor, torque_enabled: motor.id === 0 })) } }) }));
  await assert.rejects(partialHeadTorque.api.prepareLive({ head: true, ribs: true, drums: true }), /Head torque was not confirmed/);
  assert.deepEqual(partialHeadTorque.requests.filter(entry => entry.path === "command").map(entry => entry.body.kind), ["head_torque"], "partial holding torque cannot start other groups");

  const acceptedHeadTorque = harness(false, liveHeadOptions), acceptedHeadTorqueAbort = new AbortController(); let finishAcceptedHeadTorque;
  acceptedHeadTorque.interceptPath("command", entry => new Promise(resolve => {
    assert.equal(entry.body.kind, "head_torque");
    assert.equal(entry.body.enabled, true);
    assert.equal(entry.options.signal, undefined, "Stop does not abort the accepted powered request");
    finishAcceptedHeadTorque = resolve;
  }));
  const acceptedHeadTorqueStart = acceptedHeadTorque.api.prepareLive({ head: true, ribs: true }, { signal: acceptedHeadTorqueAbort.signal });
  const rejectedAcceptedHead = assert.rejects(acceptedHeadTorqueStart, /cancelled/);
  await tick();
  acceptedHeadTorqueAbort.abort(); await rejectedAcceptedHead; await tick();
  assert.deepEqual(acceptedHeadTorque.requests.filter(entry => entry.path === "command").map(entry => entry.body), [{ kind: "head_torque", enabled: true, dry_run: false }], "Stop cancels subsequent requests without releasing the supported head");
  assert.equal(acceptedHeadTorque.api.snapshot().busy, true, "an accepted torque request retains its preparation gate until the HTTP response settles");
  const beforeRestart = acceptedHeadTorque.requests.length;
  const acceptedHeadTorqueRestart = acceptedHeadTorque.api.prepareLive({ head: true });
  await tick(); assert.equal(acceptedHeadTorque.requests.length, beforeRestart);
  finishAcceptedHeadTorque(); await acceptedHeadTorqueRestart;
  assert.equal(acceptedHeadTorque.api.snapshot().headReady, true);
  assert.equal(acceptedHeadTorque.api.snapshot().headTorqueEnabled, true);
  assert.ok(!acceptedHeadTorque.requests.some(entry => entry.body?.kind === "ribs_torque"), "the cancelled mixed start never resumes its other groups");

  const emergencyHead = harness(false, liveHeadOptions); let finishEmergencyHead;
  emergencyHead.interceptPath("command", () => new Promise(resolve => { finishEmergencyHead = () => resolve({ ok: true, json: async () => ({ ...emergencyHead.status(), emergency_stopped: false, head: { ...emergencyHead.status().head, motors: liveHeadReadings.map(motor => ({ ...motor, torque_enabled: true })) } }) }); }));
  const emergencyHeadStart = emergencyHead.api.prepareLive({ head: true, ribs: true });
  const rejectedEmergencyHead = assert.rejects(emergencyHeadStart, /cancelled|emergency/i);
  await tick(); await emergencyHead.api.emergencyStop(); await rejectedEmergencyHead;
  finishEmergencyHead(); await tick();
  assert.equal(emergencyHead.api.snapshot().headTorqueEnabled, false, "late torque acknowledgement cannot overwrite an emergency stop");
  assert.equal(emergencyHead.api.snapshot().emergencyStopped, true);
  assert.ok(!emergencyHead.requests.some(entry => entry.body?.kind === "ribs_torque"));

  const mixedHead = harness(false, liveHeadOptions);
  await mixedHead.api.prepareLive({ ribs: true, head: true });
  assert.deepEqual(mixedHead.requests.filter(entry => entry.path.endsWith("/check") || entry.path === "command").map(entry => entry.body.kind || entry.path), ["ribs/check", "head/check", "head_torque", "ribs_torque"]);
  let finishMixedRibs;
  mixedHead.interceptPath("command", () => new Promise(resolve => { finishMixedRibs = resolve; }));
  const mixedRibsMove = mixedHead.api.moveRibs(40, 1000);
  const mixedHeadMove = mixedHead.api.moveHead(1, 2550, 1000);
  await tick();
  assert.equal(mixedHead.requests.at(-1).body.kind, "ribs");
  assert.equal(mixedHead.api.snapshot().ribsBusy, true); assert.equal(mixedHead.api.snapshot().headBusy, true);
  assert.equal(mixedHead.api.snapshot().commandBusy, false, "live movement gates are separate from setup/preparation work");
  await assert.rejects(mixedHead.api.moveRibs(80, 1000), /busy/);
  await assert.rejects(mixedHead.api.moveHead(0, 2050, 1000), /busy/);
  finishMixedRibs(); await Promise.all([mixedRibsMove, mixedHeadMove]);
  assert.deepEqual(mixedHead.requests.slice(-2).map(entry => entry.body.kind), ["ribs", "head_move"], "one head and one rib move share the serial queue without starvation or overlap");
  assert.equal(mixedHead.api.snapshot().busy, false);

  const releaseQueuedHead = harness(false, liveHeadOptions);
  await releaseQueuedHead.api.prepareLive({ head: true, ribs: true });
  let finishHeadBeforeRelease;
  releaseQueuedHead.interceptPath("command", () => new Promise(resolve => { finishHeadBeforeRelease = resolve; }));
  const releaseCueAbort = new AbortController();
  const movingBeforeRelease = releaseQueuedHead.api.moveHead(0, 2100, 1000, { signal: releaseCueAbort.signal });
  const stoppedBeforeRelease = assert.rejects(movingBeforeRelease, /cancelled/);
  await tick(); releaseCueAbort.abort();
  const pendingHeadRelease = releaseQueuedHead.api.setHeadTorque(false);
  assert.equal(releaseQueuedHead.api.setHeadTorque(false), pendingHeadRelease, "repeated Release shares one queued torque-off request");
  await assert.rejects(releaseQueuedHead.api.moveHead(1, 2550, 1000), /busy/);
  const ribsAfterRelease = releaseQueuedHead.api.moveRibs(45, 1000);
  finishHeadBeforeRelease();
  await Promise.all([stoppedBeforeRelease, pendingHeadRelease, ribsAfterRelease]);
  assert.deepEqual(releaseQueuedHead.requests.slice(-3).map(entry => entry.body.kind), ["head_move", "head_torque", "ribs"], "Release reserves the next request slot ahead of later movement");
  assert.equal(releaseQueuedHead.requests.at(-2).body.enabled, false);
  assert.equal(releaseQueuedHead.api.snapshot().headTorqueEnabled, false, "one Release click turns torque off after the accepted head cue settles");
  assert.equal(releaseQueuedHead.api.snapshot().headBusy, false);

  await releaseQueuedHead.api.setHeadTorque(true);
  let finishHeadDuringEmergency;
  releaseQueuedHead.interceptPath("command", () => new Promise(resolve => { finishHeadDuringEmergency = resolve; }));
  const headBeforeEmergency = releaseQueuedHead.api.moveHead(0, 2050, 1000);
  const headBeforeEmergencyRejected = assert.rejects(headBeforeEmergency, /changed|cancelled/i);
  await tick();
  const releaseBeforeEmergency = releaseQueuedHead.api.setHeadTorque(false);
  const releaseBeforeEmergencyRejected = assert.rejects(releaseBeforeEmergency, /changed|cancelled/i);
  const beforeEmergencyReleaseCount = releaseQueuedHead.requests.filter(entry => entry.body?.kind === "head_torque" && entry.body.enabled === false).length;
  await releaseQueuedHead.api.emergencyStop();
  assert.equal(releaseQueuedHead.requests.at(-1).path, "emergency-stop", "emergency bypasses both an accepted cue and its queued ordinary release");
  finishHeadDuringEmergency(); await Promise.all([headBeforeEmergencyRejected, releaseBeforeEmergencyRejected]);
  assert.equal(releaseQueuedHead.requests.filter(entry => entry.body?.kind === "head_torque" && entry.body.enabled === false).length, beforeEmergencyReleaseCount, "the old queued release cannot run after emergency changes the session");
  assert.equal(releaseQueuedHead.api.snapshot().headTorqueEnabled, false);

  let finishAcceptedHead;
  mixedHead.interceptPath("command", entry => new Promise(resolve => { assert.equal(entry.options.signal, undefined, "an accepted motor request is not aborted by Stop"); finishAcceptedHead = resolve; }));
  const stoppedFrame = new AbortController();
  const acceptedHead = mixedHead.api.moveHead(0, 2050, 1000, { signal: stoppedFrame.signal });
  const waitingRibs = mixedHead.api.moveRibs(20, 1000, { signal: stoppedFrame.signal });
  const acceptedHeadRejected = assert.rejects(acceptedHead, /cancelled/), waitingRibsRejected = assert.rejects(waitingRibs, /cancelled/);
  await tick(); const beforeStoppedFrame = mixedHead.requests.length;
  stoppedFrame.abort(); finishAcceptedHead(); await Promise.all([acceptedHeadRejected, waitingRibsRejected]);
  assert.equal(mixedHead.requests.length, beforeStoppedFrame, "Stop prevents a queued motor group from starting after an accepted move settles");
  assert.equal(mixedHead.api.snapshot().headPositions[0], 2050, "Stop preserves actual readbacks from an accepted motor command");
  assert.equal(mixedHead.api.snapshot().headLastMove.position, 2050, "accepted movement metadata remains available after Stop");
  assert.equal(mixedHead.api.snapshot().busy, false);

  const timedHead = harness(false, { ...liveHeadOptions, headReportsBusy: true });
  await timedHead.api.prepareLive({ head: true });
  await timedHead.api.moveHead(0, 2150, 1000);
  assert.equal(timedHead.api.snapshot().headBusy, true);
  assert.equal(timedHead.timers.size, 1, "accepted head movement starts cached status polling");
  assert.equal(timedHead.element("head-release").disabled, false, "release remains available during the driver duration gate");
  let finishHeadStatus;
  timedHead.interceptPath("head/status", () => new Promise(resolve => { finishHeadStatus = resolve; }));
  const pollingTimedHead = timedHead.runTimer(); await tick();
  assert.equal(timedHead.timers.size, 0, "only one cached head status request is in flight");
  timedHead.root.hidden = true; await timedHead.api.activate();
  assert.equal(timedHead.timers.size, 0, "tab changes do not duplicate polling or cancel head movement");
  finishHeadStatus(); await pollingTimedHead;
  timedHead.interceptPath("head/status", () => Promise.reject(new Error("Status temporarily unavailable")));
  await timedHead.runTimer();
  assert.equal([...timedHead.timers.values()][0].delay, 500, "head status retries with backoff");
  assert.equal(timedHead.api.snapshot().headBusy, true, "a failed status poll does not pretend movement has finished");
  timedHead.nextHeadStatus({ busy: false, motors: liveHeadReadings.map(motor => ({ ...motor, torque_enabled: true })) });
  await timedHead.runTimer();
  assert.equal(timedHead.api.snapshot().headBusy, false, "fresh cached status clears the driver duration gate");
  assert.equal(timedHead.api.snapshot().headPositions[0], 2000, "positions use reported measurements rather than the last requested target");
  assert.equal(timedHead.timers.size, 0);

  await timedHead.api.moveHead(1, 2550, 1000);
  const staleHeadStatus = timedHead.status(); let finishStaleHeadStatus;
  timedHead.interceptPath("head/status", () => new Promise(resolve => { finishStaleHeadStatus = resolve; }));
  const staleHeadPolling = timedHead.runTimer(); await tick();
  await timedHead.api.setHeadTorque(false);
  finishStaleHeadStatus({ ok: true, json: async () => ({ ok: true, emergency_stopped: false, head: staleHeadStatus.head }) });
  await staleHeadPolling;
  assert.equal(timedHead.api.snapshot().headBusy, false, "an older head poll cannot restore a busy gate after release");
  assert.equal(timedHead.api.snapshot().headTorqueEnabled, false, "an older head poll cannot restore torque after release");
  assert.equal(timedHead.timers.size, 0);

  const acceptedTimedHead = harness(false, { ...liveHeadOptions, headReportsBusy: true });
  await acceptedTimedHead.api.prepareLive({ head: true });
  let finishStoppedHead;
  acceptedTimedHead.interceptPath("command", () => new Promise(resolve => { finishStoppedHead = resolve; }));
  const acceptedHeadAbort = new AbortController();
  const stoppedHeadMove = acceptedTimedHead.api.moveHead(0, 2100, 2000, { signal: acceptedHeadAbort.signal });
  const stoppedHeadRejected = assert.rejects(stoppedHeadMove, /cancelled/);
  await tick(); acceptedHeadAbort.abort(); finishStoppedHead(); await stoppedHeadRejected;
  assert.equal(acceptedTimedHead.api.snapshot().headBusy, true, "ordinary Stop retains an accepted head move’s physical duration gate");
  assert.equal(acceptedTimedHead.api.snapshot().headLastMove.duration_ms, 2000);
  assert.equal(acceptedTimedHead.timers.size, 1, "stopped effects still refresh the accepted move until its duration finishes");
  await acceptedTimedHead.api.emergencyStop();
  assert.equal(acceptedTimedHead.api.snapshot().headTorqueEnabled, false);
  assert.equal(acceptedTimedHead.api.snapshot().headBusy, false);
  assert.equal(acceptedTimedHead.timers.size, 0);

  const axisHead = harness(false, { ...liveHeadOptions, headReportsBusy: true, headAxisMotion: true });
  await axisHead.api.prepareLive({ head: true });
  const axes = [{ motor_id: 0, position: 2100, duration_ms: 3000 }, { motor_id: 1, position: 2550, duration_ms: 7000 }];
  const batchHeadMove = axisHead.api.moveHeadAxes(axes);
  assert.equal(axisHead.api.snapshot().headCommandBusy, true, "a queued/in-flight head batch reserves the command bridge");
  axes[0].position = 9999;
  await batchHeadMove;
  assert.deepEqual(axisHead.requests.at(-1).body, { kind: "head_moves", targets: [
    { motor_id: 0, position: 2100, duration_ms: 3000 }, { motor_id: 1, position: 2550, duration_ms: 7000 }
  ], dry_run: false }, "both axes share one request and caller mutation cannot alter a queued target");
  const batchSnapshot = axisHead.api.snapshot();
  assert.equal(batchSnapshot.headBusy, true);
  assert.equal(batchSnapshot.headCommandBusy, false, "native motor profiles do not occupy the HTTP command gate");
  assert.deepEqual(copy(batchSnapshot.headMotion), [{ motor_id: 0, remaining_ms: 3000 }, { motor_id: 1, remaining_ms: 7000 }]);
  assert.equal(batchSnapshot.headLastMove.duration_ms, 7000);
  assert.deepEqual(copy(batchSnapshot.headLastMove.targets), [
    { motor_id: 0, position: 2100, duration_ms: 3000, requested_duration_ms: 3000 },
    { motor_id: 1, position: 2550, duration_ms: 7000, requested_duration_ms: 7000 }
  ]);
  batchSnapshot.headMotion[0].remaining_ms = 0;
  batchSnapshot.headMotion.push({ motor_id: 99, remaining_ms: 5 });
  batchSnapshot.headLastMove.targets[0].position = 9999;
  assert.equal(axisHead.api.snapshot().headMotion[0].remaining_ms, 3000, "motion snapshots cannot mutate the bridge cache");
  assert.equal(axisHead.api.snapshot().headMotion.length, 2);
  assert.equal(axisHead.api.snapshot().headLastMove.targets[0].position, 2100, "last-move batch targets are also copied");
  const beforeInvalidAxes = axisHead.requests.length;
  for (const targets of [[], [null], [axes[1], axes[1]], [axes[1], axes[1], axes[1]],
    [{ motor_id: 2, position: 2100, duration_ms: 1000 }],
    [{ motor_id: 0, position: 2201, duration_ms: 1000 }],
    [{ motor_id: 0, position: 2000, duration_ms: 999 }],
    [{ motor_id: 0, position: 2000, duration_ms: 10001 }],
    [{ motor_id: 0, position: 2000, duration_ms: 1000, extra: true }]]) {
    await assert.rejects(axisHead.api.moveHeadAxes(targets));
  }
  await assert.rejects(axisHead.api.moveHeadAxes([{ motor_id: 1, position: 2500, duration_ms: 1000 }]), /busy/);
  await assert.rejects(axisHead.api.moveHead(0, 2050, 1000), /busy/);
  assert.equal(axisHead.requests.length, beforeInvalidAxes, "invalid batches and occupied axes never reach the service");
  axisHead.nextHeadStatus({ busy: true, motion: [{ motor_id: 1, remaining_ms: 4000 }] });
  await axisHead.runTimer();
  await axisHead.api.moveHeadAxes([{ motor_id: 0, position: 1900, duration_ms: 1000 }]);
  assert.equal(axisHead.requests.at(-1).body.kind, "head_moves", "an idle axis may move while its peer's native profile continues");
  assert.deepEqual(copy(axisHead.api.snapshot().headMotion).map(motion => motion.motor_id).sort(), [0, 1]);
  await axisHead.api.setHeadTorque(false);
  assert.deepEqual(copy(axisHead.api.snapshot().headMotion), []);
  assert.equal(axisHead.api.snapshot().headLastMove, null);
  await axisHead.api.setHeadTorque(true);
  assert.equal(axisHead.api.snapshot().headLastMove, null, "torque-on does not restore a released batch goal");
  await axisHead.api.moveHeadAxes([{ motor_id: 0, position: 2050, duration_ms: 1000 }]);
  assert.equal(axisHead.api.snapshot().headLastMove.targets[0].position, 2050, "a different batch remains visible even when legacy fields and timestamps match the released batch");

  const resumeHead = harness(false, { ...liveHeadOptions, headReportsBusy: true, headAxisMotion: true });
  await resumeHead.api.prepareLive({ head: true });
  await resumeHead.api.moveHeadAxes([{ motor_id: 0, position: 2100, duration_ms: 3000 },
    { motor_id: 1, position: 2550, duration_ms: 7000 }]);
  resumeHead.interceptPath("head/check", () => { throw new Error("Cannot rediscover moving head axes"); });
  const beforeResume = resumeHead.requests.length;
  const resumeProgress = [];
  await resumeHead.api.prepareLive({ head: true }, { onProgress: message => resumeProgress.push(message) });
  assert.ok(resumeProgress.some(message => /Continuing/.test(message)), "Start robot reuses accepted profiles after ordinary Stop");
  assert.equal(resumeHead.requests.slice(beforeResume).some(entry => entry.path === "head/check" || entry.path === "command"), false,
    "an already verified moving head is not rediscovered, re-torqued or retargeted during preparation");
  assert.equal(resumeHead.api.snapshot().headMotion.length, 2);
  resumeHead.updateStatus({ head: { last_move: { ...resumeHead.api.snapshot().headLastMove, partial: true } } });
  await assert.rejects(resumeHead.api.prepareLive({ head: true }), /Cannot rediscover/, "a partial goal failure does not qualify for reusing active motion");

  const queuedAxes = harness(false, { ...liveHeadOptions, headReportsBusy: true, headAxisMotion: true });
  await queuedAxes.api.prepareLive({ ribs: true, head: true });
  let finishBeforeAxes;
  queuedAxes.interceptPath("command", () => new Promise(resolve => { finishBeforeAxes = resolve; }));
  const ribsBeforeAxes = queuedAxes.api.moveRibs(40, 1000);
  const queuedAxisMove = queuedAxes.api.moveHeadAxes([{ motor_id: 0, position: 2100, duration_ms: 1000 }]);
  const rejectedQueuedAxis = assert.rejects(queuedAxisMove, /busy/);
  await tick();
  const beforeQueuedAxisDispatch = queuedAxes.requests.length;
  queuedAxes.updateStatus({ head: { busy: true, motion: [{ motor_id: 0, remaining_ms: 3000 }] } });
  finishBeforeAxes(); await Promise.all([ribsBeforeAxes, rejectedQueuedAxis]);
  assert.equal(queuedAxes.requests.length, beforeQueuedAxisDispatch, "the queued batch rechecks selected-axis occupancy immediately before dispatch");
  assert.equal(queuedAxes.api.snapshot().headCommandBusy, false);
  assert.equal(queuedAxes.api.snapshot().headBusy, true);
  await queuedAxes.api.moveHeadAxes([{ motor_id: 1, position: 2600, duration_ms: 2000 }]);
  assert.equal(queuedAxes.requests.at(-1).body.targets[0].motor_id, 1);
  await assert.rejects(queuedAxes.api.setHeadTorque(true), /current head movement/);
  await queuedAxes.api.emergencyStop();
  assert.deepEqual(copy(queuedAxes.api.snapshot().headMotion), []);
  assert.equal(queuedAxes.api.snapshot().headLastMove, null);
  await assert.rejects(queuedAxes.api.moveHeadAxes([{ motor_id: 0, position: 2000, duration_ms: 1000 }]), /emergency stop/);

  await assert.rejects(timedHead.api.moveHeadAxes([{ motor_id: 0, position: 2000, duration_ms: 1000 }]), /head torque on/);
  const unknownMotion = harness(false, { ...liveHeadOptions, headReportsBusy: true });
  await unknownMotion.api.prepareLive({ head: true });
  await unknownMotion.api.moveHead(0, 2100, 1000);
  await assert.rejects(unknownMotion.api.moveHeadAxes([{ motor_id: 1, position: 2600, duration_ms: 1000 }]), /current head movement/);

  const cancelledAxes = harness(false, { ...liveHeadOptions, headReportsBusy: true, headAxisMotion: true });
  await cancelledAxes.api.prepareLive({ ribs: true, head: true });
  let finishBeforeCancelledAxes;
  cancelledAxes.interceptPath("command", () => new Promise(resolve => { finishBeforeCancelledAxes = resolve; }));
  const heldRibs = cancelledAxes.api.moveRibs(40, 1000);
  const queuedBatchAbort = new AbortController();
  const neverSentAxes = cancelledAxes.api.moveHeadAxes([{ motor_id: 0, position: 2100, duration_ms: 2000 }], { signal: queuedBatchAbort.signal });
  const neverSentAxesRejected = assert.rejects(neverSentAxes, /cancelled/);
  await tick(); const beforeBatchAbort = cancelledAxes.requests.length;
  queuedBatchAbort.abort(); finishBeforeCancelledAxes();
  await Promise.all([heldRibs, neverSentAxesRejected]);
  assert.equal(cancelledAxes.requests.length, beforeBatchAbort, "Stop removes an unsent batch from the shared command queue");
  const acceptedBatchAbort = new AbortController();
  let finishAcceptedAxes;
  cancelledAxes.interceptPath("command", entry => new Promise(resolve => {
    assert.equal(entry.options.signal, undefined, "an accepted batch keeps its hardware acknowledgement");
    finishAcceptedAxes = resolve;
  }));
  const acceptedAxes = cancelledAxes.api.moveHeadAxes([
    { motor_id: 0, position: 2100, duration_ms: 2000 }, { motor_id: 1, position: 2550, duration_ms: 3000 }
  ], { signal: acceptedBatchAbort.signal });
  const acceptedAxesRejected = assert.rejects(acceptedAxes, /cancelled/);
  await tick(); acceptedBatchAbort.abort(); finishAcceptedAxes(); await acceptedAxesRejected;
  assert.equal(cancelledAxes.api.snapshot().headMotion.length, 2, "ordinary Stop retains both accepted physical profiles");
  assert.equal(cancelledAxes.api.snapshot().headCommandBusy, false);
  assert.equal(cancelledAxes.api.snapshot().headBusy, true);
  assert.equal(cancelledAxes.api.snapshot().headLastMove.targets.length, 2);
  await cancelledAxes.api.setHeadTorque(false);
  let finishHeadDiagnostic;
  cancelledAxes.interceptPath("head/check", () => new Promise(resolve => { finishHeadDiagnostic = resolve; }));
  const headDiagnostic = cancelledAxes.click("head-check"); await tick();
  assert.equal(cancelledAxes.api.snapshot().headCommandBusy, true, "head diagnostics reserve the command gate");
  const beforeDiagnosticBatch = cancelledAxes.requests.length;
  await assert.rejects(cancelledAxes.api.moveHeadAxes([{ motor_id: 0, position: 2000, duration_ms: 1000 }]), /head connection or recording/);
  assert.equal(cancelledAxes.requests.length, beforeDiagnosticBatch);
  finishHeadDiagnostic(); await headDiagnostic;
  assert.equal(cancelledAxes.api.snapshot().headCommandBusy, false);

  const h = harness();
  assert.equal(h.requests.length, 0, "initialization neither contacts robot service nor enables output");
  assert.equal(h.midiRequests.length, 0);
  assert.equal(h.sent.length, 0);
  assert.doesNotMatch(h.root.innerHTML, /robot-mode|Dry run|Preview colour|Preview off/, "the UI has no dry-run option");
  await h.api.activate();
  assert.deepEqual(h.requests.map(item => item.path), ["status"], "opening the tab reads status without sending hardware commands");
  assert.deepEqual(h.midiRequests, [{ sysex: false }], "opening robot controls automatically requests MIDI access");
  assert.equal(h.element("midi-device").textContent, ledName, "the Plasma is automatically identified even when the synth output appears first");
  assert.equal(h.element("midi-connect").hidden, true, "connected MIDI needs no manual connection button");
  assert.doesNotMatch(h.root.innerHTML, /id="robot-midi-output"/, "LED controller selection is automatic");
  assert.equal(h.sent.length, 0);
  assert.equal(h.ledButton("color").textContent, "Test colour");
  assert.equal(h.ledButton("off").textContent, "LEDs off");
  assert.equal(h.api.snapshot().armed, true, "the session starts ready for checked motors without a separate enable step");
  assert.doesNotMatch(h.root.innerHTML, /id="robot-arm"|id="robot-disable"|Enable motor output/);
  assert.equal(h.element("torque-on").disabled, true, "torque-on requires a checked connection");
  assert.equal(h.element("release").disabled, false, "release remains available without enabling output");
  assert.match(h.element("drums-motors").innerHTML, /min="2100" max="2450"/);
  assert.match(h.element("drums-motors").innerHTML, /Max kick range 2100–2450/);
  assert.equal(h.element("duration-20").value, "2500", "motor catalog duration is retained");
  assert.doesNotMatch(h.root.innerHTML, /robot-head-motors/, "head movement controls are not rendered");
  assert.match(h.root.innerHTML, /Connection checks and upright capture do not move the head/);
  assert.doesNotMatch(h.root.innerHTML, /OSC destination|robot-config-save|robot-host|robot-head-torque/, "serial setup exposes no OSC destination or head torque controls");
  assert.ok(h.root.innerHTML.indexOf('id="robot-head-title"') < h.root.innerHTML.indexOf('id="robot-ribs-title"'), "head identification appears first");
  assert.equal(h.element("head-device").value, "", "an unknown head bus is never guessed from available serial ports");
  assert.equal(h.element("head-baudrate").value, "57600");
  assert.equal(h.element("head-check").disabled, true);
  assert.equal(h.element("head-upright").disabled, true);
  assert.equal(h.element("drums-device").value, drumDevice);
  assert.equal(h.element("drums-baudrate").value, "1000000");
  await h.testMotor(4);
  assert.equal(h.requests.length, 1, "a stale head action cannot send a command");

  h.input("position-0", 2290);
  assert.equal(h.element("number-0").value, "2290");
  assert.equal(h.requests.length, 1, "dragging does not send commands");
  await h.clickData("robotPreset", "0");
  assert.equal(h.requests.length, 1, "preset selection only edits the next target");
  h.input("number-0", 2370);
  h.input("duration-0", 800);
  await h.clickData("robotTest", "move");
  await h.testMotor(0);
  assert.equal(h.requests.length, 1, "both the button and command handler require a checked connection");
  assert.match(h.element("status").textContent, /drumming arm connection/);
  const beforeDrumsCheck = h.requests.length;
  await h.testMotor(0);
  assert.equal(h.requests.length, beforeDrumsCheck, "arm positions require their own checked serial connection");
  assert.match(h.element("status").textContent, /drumming arm connection/);
  await h.click("drums-check");
  assert.equal(h.requests.at(-1).path, "drums/check");
  assert.deepEqual(h.requests.at(-1).body, { device: drumDevice, baudrate: 1000000 });
  assert.equal(h.element("drums-state").textContent, "Connected");
  assert.equal(h.api.snapshot().armed, true, "checking the arms preserves the shared output gate");
  const beforeArmTorque = h.requests.length;
  await h.testMotor(0);
  assert.equal(h.requests.length, beforeArmTorque, "positions require measured torque on");
  await h.click("drums-torque-on");
  await h.clickData("robotTest", "move");
  assert.deepEqual(h.requests.at(-1).body, { kind: "move", motor_id: 0, position: 2370, duration_ms: 800, dry_run: false });
  assert.match(h.element("history").innerHTML, /Sent/);
  assert.doesNotMatch(h.element("history").innerHTML, /Dry run/);

  const beforeInvalid = h.requests.length;
  h.input("number-0", 2451);
  await h.clickData("robotTest", "move");
  assert.equal(h.requests.length, beforeInvalid, "out-of-range position never reaches backend");
  assert.match(h.element("status").textContent, /2100 to 2450/);
  assert.equal(h.element("refresh").disabled, false, "validation error clears pending action");
  h.input("number-0", 2200);
  h.intercept(() => { throw new Error("Network unavailable"); });
  await h.clickData("robotTest", "move");
  assert.match(h.element("status").textContent, /Network unavailable/);
  assert.equal(h.element("refresh").disabled, false, "network error clears pending action");
  await h.clickData("robotTest", "move");
  assert.match(h.element("status").textContent, /accepted/);

  h.input("ribs-position", 127);
  const beforeUncheckedMove = h.requests.length;
  await h.clickData("robotTest", "ribs");
  await h.testMotor(20);
  assert.equal(h.requests.length, beforeUncheckedMove, "rib moves require a checked connection even when output is enabled");
  const beforeCheck = h.requests.length;
  await h.click("ribs-check");
  assert.equal(h.requests.length, beforeCheck + 1, "connection check requests only the read-only check endpoint");
  assert.equal(h.requests.at(-1).path, "ribs/check");
  assert.deepEqual(h.requests.at(-1).body, { device: ribDevice });
  assert.equal(h.element("ribs-state").textContent, "Connected");
  assert.equal((h.element("ribs-readings").innerHTML.match(/<tr>/g) || []).length, 6);
  assert.match(h.element("ribs-readings").innerHTML, /2450/);
  assert.match(h.element("ribs-readings").innerHTML, /Off/);
  assert.match(h.element("ribs-checked").textContent, /Last checked:.*not live feedback/);
  assert.equal(h.element("torque-on").disabled, false, "a successful check immediately permits explicit torque-on");
  assert.equal(h.api.snapshot().armed, true);
  await h.click("torque-on");
  assert.deepEqual(h.requests.at(-1).body, { kind: "ribs_torque", enabled: true, dry_run: false });
  await h.clickData("robotTest", "ribs");
  assert.deepEqual(h.requests.at(-1).body, { kind: "ribs", position: 127, duration_ms: 2500, dry_run: false });
  await h.testMotor(20);
  assert.deepEqual(h.requests.at(-1).body, { kind: "move", motor_id: 20, position: 2450, duration_ms: 2500, dry_run: false });
  await h.click("release");
  assert.deepEqual(h.requests.at(-1).body, { kind: "ribs_torque", enabled: false, dry_run: false });
  assert.equal(h.element("torque-on").disabled, false, "release leaves explicit torque-on available");
  assert.equal(h.api.snapshot().armed, true);
  const beforeUnarmedRelease = h.requests.length;
  await h.click("release");
  assert.equal(h.requests.length, beforeUnarmedRelease + 1, "release sends a real command even while output is disabled");
  assert.deepEqual(h.requests.at(-1).body, { kind: "ribs_torque", enabled: false, dry_run: false });
  h.intercept(() => ({ ok: false, status: 502, json: async () => ({ ok: false, armed: false, error: "Arm serial send failed" }) }));
  await h.clickData("robotTest", "move");
  assert.equal(h.element("torque-on").disabled, false, "an arm send failure does not globally latch other motors");
  assert.equal(h.api.snapshot().emergencyStopped, false);
  assert.match(h.element("status").textContent, /Arm serial send failed/);

  const beforeLED = h.requests.length;
  h.input("led-color", "#ff8000");
  h.input("led-brightness", 50);
  assert.equal(h.sent.length, 0, "editing LED controls does not send messages");
  assert.equal(h.requests.length, beforeLED);
  assert.deepEqual(h.midiRequests, [{ sysex: false }]);
  assert.equal(h.midi.listenerType, "statechange");
  assert.equal(h.midi.onstatechange, h.existingHandler, "MIDI listeners do not overwrite shared handlers");
  assert.equal(h.element("midi-device").textContent, ledName, "discovery recognizes the LED controller alongside the synth");
  assert.equal(h.element("midi-connect").hidden, true);
  assert.doesNotMatch(h.root.innerHTML, /robot-midi-output/, "automatic discovery needs no output selector");
  assert.equal(h.ledButton("color").textContent, "Test colour");
  assert.equal(h.ledButton("off").textContent, "LEDs off");
  await h.clickData("robotLed", "color");
  assert.deepEqual(h.sent, [[0x90, 1, 64], [0xA0, 32, 0]], "LED tests work with motor output disabled and use seven-bit RGB");
  assert.match(h.element("history").innerHTML, /90 01 40\nA0 20 00/, "firmware fill protocol uses channel 1");
  await h.clickData("robotLed", "off");
  assert.deepEqual(h.sent.slice(-2), [[0x90, 1, 0], [0xA0, 0, 0]]);
  assert.match(h.element("history").innerHTML, /90 01 00\nA0 00 00/);
  h.input("led-brightness", 0);
  assert.match(h.element("midi-hint").textContent, /Brightness is 0%/);
  h.input("led-brightness", 100);
  assert.doesNotMatch(h.element("midi-hint").textContent, /Brightness is 0%/);
  assert.equal(h.sent.length, 4, "LED sliders do not send");
  await h.clickData("robotLed", "color");
  assert.deepEqual(h.sent.slice(-2), [[0x90, 1, 127], [0xA0, 64, 0]]);
  h.output.state = "disconnected";
  h.midi.listener();
  assert.equal(h.element("midi-device").textContent, "Pimoroni not connected");
  assert.match(h.element("midi-hint").textContent, /reconnect automatically/);
  await h.clickData("robotLed", "color");
  assert.equal(h.sent.length, 6, "a disconnected LED controller cannot receive tests");
  assert.match(h.element("status").textContent, /Pimoroni not connected/);
  h.output.state = "connected";
  h.midi.listener();
  assert.equal(h.element("midi-device").textContent, ledName, "the LED controller is rediscovered after reconnecting");
  assert.equal(h.sent.length, 6, "reconnection does not send LED messages");

  const beforeLeave = h.requests.length;
  await h.api.deactivate();
  assert.equal(h.requests.length, beforeLeave, "deactivation never sends automatic motor commands");
  assert.equal(h.intervals.size, 0);
  await h.testMotor(0);
  await h.clickData("robotLed", "color");
  assert.equal(h.requests.length, beforeLeave, "inactive controls cannot send motor commands");
  assert.equal(h.sent.length, 6);
  await h.api.activate();
  assert.equal(h.requests.at(-1).path, "status");
  assert.equal(h.api.snapshot().armed, true, "reactivation retains the server session without enabling output");
  assert.equal(h.element("midi-device").textContent, ledName);
  const beforePagehide = h.requests.length;
  h.windowHandlers.pagehide();
  await tick();
  assert.equal(h.requests.length, beforePagehide, "page shutdown does not change motor torque or latch state");
  assert.equal(h.element("emergency-stop").disabled, true);
  await h.windowHandlers.pageshow({ persisted: true });
  assert.equal(h.requests.at(-1).path, "status");
  assert.equal(h.api.snapshot().armed, true);
  h.windowHandlers.pagehide();
  await tick();
  h.root.hidden = true;
  const beforeHiddenRestore = h.requests.length;
  await h.windowHandlers.pageshow({ persisted: true });
  assert.equal(h.requests.length, beforeHiddenRestore);
  assert.equal(h.element("refresh").disabled, true);
  assert.ok(h.requests.every(entry => entry.path !== "arm"), "no lifecycle or setup action calls the removed enable gate");
  assert.ok(h.requests.filter(entry => entry.path === "command").every(entry => entry.body.dry_run === false));

  const r = harness();
  await r.api.activate();
  r.nextCheck({ state: "partial", code: "partial", message: "Motor 21 did not respond. Check power and wiring.",
    motors: ribReadings.map(motor => motor.id === 21 ? { ...motor, connected: false, position: null, torque_enabled: null, error: "No response" } : motor) });
  await r.click("ribs-check");
  assert.equal(r.element("ribs-state").textContent, "Partial connection");
  assert.match(r.element("ribs-message").textContent, /Motor 21 did not respond/);
  assert.match(r.element("ribs-readings").innerHTML, /No response/);
  const beforePartialMove = r.requests.length;
  await r.clickData("robotTest", "ribs");
  await r.testMotor(20);
  assert.equal(r.requests.length, beforePartialMove, "partial connections prevent both grouped and individual live rib moves");
  assert.equal(r.element("torque-on").disabled, true, "partial connections prevent enabling rib torque");
  assert.equal(r.element("release").disabled, false, "release remains available for best-effort partial connection recovery");
  await r.click("release");
  assert.deepEqual(r.requests.at(-1).body, { kind: "ribs_torque", enabled: false, dry_run: false });

  r.nextCheck({ state: "error", code: "missing_dependency", dependency_available: false, message: "Dynamixel SDK is not installed in the dashboard environment.", motors: [] });
  await r.click("ribs-check");
  assert.equal(r.element("ribs-state").textContent, "Connection error");
  assert.match(r.element("ribs-message").textContent, /SDK is not installed/);
  assert.equal(r.element("ribs-readback").hidden, true);
  assert.equal(r.element("ribs-check").disabled, false, "dependency errors leave connection check retry available");
  r.nextCheck({ dependency_available: true });
  await r.click("ribs-check");
  assert.equal(r.api.snapshot().armed, true);
  const readySnapshot = { state: "ready", device: ribDevice, ports: [ribDevice], motors: ribReadings.map(motor => ({ ...motor, torque_enabled: true })), checked_at: "2026-10-16T00:01:00Z" };
  r.intercept(() => ({ ok: true, json: async () => ({ ok: true, armed: true, ribs: readySnapshot, commands: [{ transport: "serial", motor_ids: [20, 21, 22, 25, 26, 27], torque_enabled: true }] }) }));
  await r.click("torque-on");
  assert.match(r.element("ribs-readings").innerHTML, /On/, "successful command snapshots refresh displayed motor state");
  assert.match(r.element("history").innerHTML, /serial/, "serial command previews remain readable");
  r.intercept(() => ({ ok: false, status: 502, json: async () => ({ ok: false, armed: false, error: "Rib serial connection lost", ribs: { ...readySnapshot, state: "disconnected", message: "USB serial device disconnected." } }) }));
  await r.clickData("robotTest", "ribs");
  assert.equal(r.element("ribs-state").textContent, "Disconnected");
  assert.match(r.element("ribs-message").textContent, /device disconnected/);
  assert.equal(r.element("torque-on").disabled, true);
  assert.equal(r.api.snapshot().armed, true);

  await r.change("ribs-device", "/dev/cu.usbserial-other");
  assert.equal(r.api.snapshot().armed, true);
  assert.equal(r.element("ribs-state").textContent, "Check required");
  assert.match(r.element("ribs-message").textContent, /Port changed/);
  const beforeStaleMove = r.requests.length;
  await r.testMotor(20);
  assert.equal(r.requests.length, beforeStaleMove, "changing serial port invalidates previous readiness even after arming");
  await r.click("ribs-check");
  assert.deepEqual(r.requests.at(-1).body, { device: "/dev/cu.usbserial-other" });
  assert.equal(r.element("ribs-state").textContent, "Connected");
  const beforeDisconnect = r.requests.length;
  await r.click("ribs-disconnect");
  assert.equal(r.requests.length, beforeDisconnect + 1);
  assert.equal(r.requests.at(-1).path, "ribs/disconnect");
  assert.deepEqual(r.requests.at(-1).body, {}, "disconnect does not send torque or movement commands");
  assert.equal(r.element("ribs-state").textContent, "Disconnected");

  const identified = harness();
  await identified.api.activate();
  const beforeIdentify = identified.requests.length;
  await identified.click("head-check");
  await identified.click("head-upright");
  assert.equal(identified.requests.length, beforeIdentify, "head identification requires an explicitly chosen port and upright capture requires identification");
  await identified.change("head-device", headDevice);
  assert.equal(identified.requests.length, beforeIdentify, "choosing a head port does not send hardware commands or disable other motors");
  assert.equal(identified.api.snapshot().armed, true);
  await identified.click("head-check");
  assert.equal(identified.requests.at(-1).path, "head/check");
  assert.deepEqual(identified.requests.at(-1).body, { device: headDevice, baudrate: 57600 });
  assert.equal(identified.element("head-state").textContent, "Connected");
  assert.equal(identified.element("head-upright").disabled, false);
  assert.match(identified.element("head-readings").innerHTML, /2XL430-W250-T \(1090\)/);
  assert.match(identified.element("head-readings").innerHTML, /<th scope="row">7<\/th>/, "discovered motor IDs are displayed without assuming factory or legacy IDs");
  assert.match(identified.element("head-readings").innerHTML, /48/);
  assert.match(identified.element("head-readings").innerHTML, /2055/);
  assert.match(identified.element("head-readings").innerHTML, /velocity \/ 3/);
  assert.equal(identified.api.snapshot().armed, true);
  await identified.click("head-upright");
  assert.equal(identified.requests.at(-1).path, "head/upright");
  assert.deepEqual(identified.requests.at(-1).body, {}, "upright capture asks the backend for a fresh reading without specifying a target");
  assert.match(identified.element("head-reference").textContent, /motor 7 = 2055 · motor 8 = 2056/);
  assert.match(identified.element("head-reference").textContent, /not movement limits/);
  assert.ok(identified.requests.every(entry => entry.path !== "command"), "head setup has no movement or torque commands");
  await identified.change("head-baudrate", "1000000");
  assert.equal(identified.element("head-state").textContent, "Check required");
  assert.equal(identified.element("head-upright").disabled, true);
  assert.equal(identified.api.snapshot().armed, true, "changing head baud does not disarm the rib cage");
  identified.nextHeadCheck({ state: "partial", message: "Expected two 2XL430 motors; only one replied.", motors: headReadings.slice(0, 1) });
  await identified.click("head-check");
  assert.deepEqual(identified.requests.at(-1).body, { device: headDevice, baudrate: 1000000 });
  assert.equal(identified.element("head-state").textContent, "Partial connection");
  assert.equal(identified.element("head-upright").disabled, true, "a partial head cannot be recorded as a two-axis upright reference");
  assert.match(identified.element("head-message").textContent, /only one replied/);
  await identified.click("head-check");
  identified.intercept(() => ({ ok: false, status: 502, json: async () => ({ ok: false, error: "Head connection lost", head: { state: "disconnected", device: headDevice, baudrate: 1000000, motors: [], message: "Head adapter was unplugged." } }) }));
  await identified.click("head-upright");
  assert.equal(identified.element("head-state").textContent, "Disconnected");
  assert.match(identified.element("head-message").textContent, /unplugged/);
  assert.equal(identified.element("head-upright").disabled, true);
  assert.equal(identified.api.snapshot().armed, true, "a head read error does not disable other motor groups");
  await identified.click("head-disconnect");
  assert.equal(identified.requests.at(-1).path, "head/disconnect");
  assert.deepEqual(identified.requests.at(-1).body, {});

  const unverifiedHead = harness(false, { head: { device: headDevice, baudrate: 1000000 } });
  await unverifiedHead.api.activate();
  assert.equal(unverifiedHead.element("head-device").value, "", "a server port without a completed check is not automatically selected");
  assert.equal(unverifiedHead.element("head-baudrate").value, "57600");
  const measuredHead = harness(false, { head: { state: "ready", device: headDevice, baudrate: 1000000,
    checked_at: "2026-10-16T00:01:00Z", motors: headReadings } });
  await measuredHead.api.activate();
  assert.deepEqual(measuredHead.requests.map(entry => entry.path), ["status"], "loading a previously checked head performs no new scan or hardware action");
  assert.equal(measuredHead.element("head-device").value, headDevice, "a completed explicit server check restores the verified head port");
  assert.equal(measuredHead.element("head-baudrate").value, "1000000", "the verified baud is restored together with the port");
  assert.equal(measuredHead.element("head-state").textContent, "Connected");
  assert.equal(measuredHead.element("head-upright").disabled, false);
  await measuredHead.change("head-baudrate", "115200");
  await measuredHead.click("refresh");
  assert.equal(measuredHead.element("head-baudrate").value, "115200", "refresh preserves a local baud change despite a cached server reading");
  assert.equal(measuredHead.element("head-state").textContent, "Check required");
  assert.equal(measuredHead.element("head-upright").disabled, true);
  await measuredHead.change("head-device", "");
  await measuredHead.click("refresh");
  assert.equal(measuredHead.element("head-device").value, "", "refresh does not override a deliberately cleared head port");
  assert.equal(measuredHead.element("head-check").disabled, true);
  assert.ok(measuredHead.requests.every(entry => entry.path === "status"));

  for (const group of ["head", "drums", "ribs"]) {
    const preferred = { state: "matched", device: "COM8", baudrate: 1000000, label: `${group} controller`, identity: { vid: 1027, pid: 24596, serial_number: `${group}-usb-serial` } };
    const automatic = harness(false, { [group]: { preferred_connection: preferred } });
    await automatic.api.activate();
    assert.equal(automatic.element(`${group}-device`).value, "COM8", `${group} recognizes its configured USB identity without a path assumption`);
    assert.equal(automatic.element(`${group}-state`).textContent, "Not checked");
    if (group !== "ribs") assert.equal(automatic.element(`${group}-baudrate`).value, "1000000");
    assert.match(automatic.element(`${group}-identity`).textContent, new RegExp(`${group}-usb-serial.*COM8`));
    assert.ok(automatic.requests.every(entry => entry.path === "status"), "automatic defaults do not scan, open, move or enable motors");
    automatic.updateStatus({ [group]: { preferred_connection: { ...preferred, device: "/dev/ttyACM2" } } });
    await automatic.click("refresh");
    assert.equal(automatic.element(`${group}-device`).value, "/dev/ttyACM2", "an unchecked automatic selection follows a renamed adapter on Refresh ports");
    automatic.updateStatus({ [group]: { preferred_connection: { ...preferred, state: "missing", device: null, message: "Saved adapter is not connected." } } });
    await automatic.click("refresh");
    assert.equal(automatic.element(`${group}-device`).value, "", "an unplugged saved adapter clears an automatic choice without falling back to the old path");
    assert.equal(automatic.element(`${group}-check`).disabled, true);
    assert.match(automatic.element(`${group}-identity`).textContent, /Saved adapter is not connected/);
    for (const unresolved of ["ambiguous", "unavailable"]) {
      const absent = harness(false, { [group]: { preferred_connection: { ...preferred, state: unresolved, device: null } } });
      await absent.api.activate();
      assert.equal(absent.element(`${group}-device`).value, "", `${unresolved} identity must suppress legacy configured paths for ${group}`);
      assert.ok(absent.requests.every(entry => entry.path === "status"));
    }
    await automatic.change(`${group}-device`, "COM12");
    automatic.updateStatus({ [group]: { preferred_connection: preferred } });
    await automatic.click("refresh");
    assert.equal(automatic.element(`${group}-device`).value, "COM12", "an explicit manual port overrides the saved USB default");
    await automatic.change(`${group}-device`, "");
    await automatic.click("refresh");
    assert.equal(automatic.element(`${group}-device`).value, "", "Refresh ports preserves an explicitly cleared selection");
    assert.ok(automatic.requests.every(entry => entry.path === "status"));
    const connected = harness(false, { [group]: { state: "ready", device: "COM9", baudrate: 1000000, checked_at: "2026-10-16T00:01:00Z", port_open: true, preferred_connection: preferred } });
    await connected.api.activate();
    assert.equal(connected.element(`${group}-device`).value, "COM9", "loading setup preserves an already checked, open bus");
    connected.updateStatus({ [group]: { preferred_connection: { ...preferred, device: "COM10" } } });
    await connected.click("refresh");
    assert.equal(connected.element(`${group}-device`).value, "COM9", "passive discovery cannot replace an active connection");
    assert.ok(connected.requests.every(entry => entry.path === "status"));
  }

  const automaticHeadBaud = harness(false, { head: { preferred_connection: { state: "matched", device: headDevice, baudrate: 1000000 } } });
  await automaticHeadBaud.api.activate();
  await automaticHeadBaud.change("head-baudrate", "115200");
  await automaticHeadBaud.click("refresh");
  assert.equal(automaticHeadBaud.element("head-baudrate").value, "115200", "USB defaults preserve a manually edited baud rate");
  assert.equal(automaticHeadBaud.element("head-state").textContent, "Check required");

  const readyHead = { state: "ready", device: headDevice, baudrate: 1000000, checked_at: "2026-10-16T00:01:00Z", motors: headReadings };
  const recording = harness(false, { head: readyHead });
  await recording.api.activate();
  assert.equal(recording.timers.size, 0, "head sampling is never started by opening the tab");
  assert.equal(recording.element("head-calibration-start").disabled, false);
  assert.equal(recording.element("head-calibration-save").disabled, true);
  await recording.click("head-calibration-start");
  assert.equal(recording.requests.at(-1).path, "head/calibration/start");
  assert.deepEqual(recording.requests.at(-1).body, {}, "recording starts by asking the read-only backend to sample; no target is sent");
  assert.equal(recording.api.snapshot().armed, true);
  assert.equal(recording.api.snapshot().busy, false, "head recording does not mark live ribs busy");
  assert.equal(recording.element("head-calibration-state").textContent, "Recording");
  assert.equal(recording.element("head-calibration-start").disabled, true);
  assert.equal(recording.element("head-calibration-save").disabled, true);
  assert.equal(recording.timers.size, 1);
  assert.equal([...recording.timers.values()][0].delay, 250);
  recording.input("head-label-7", "Turn");
  recording.input("head-label-8", "Tilt");
  const rangeTableWrites = recording.element("head-calibration-axes").markupWrites;
  const measuredAxes = headReadings.map(motor => ({ id: motor.id, label: "", position: motor.position + 10, min: motor.position - 50, max: motor.position + 50, centre: motor.position }));
  recording.nextCalibration({ sampled_at: "2026-10-16T00:01:01Z", sample_count: 6, axes: measuredAxes });
  await recording.runTimer();
  assert.equal(recording.requests.at(-1).path, "head/calibration");
  assert.equal(recording.requests.at(-1).options.method, "GET", "polls only fetch cached readings");
  assert.equal(recording.element("head-calibration-axes").markupWrites, rangeTableWrites, "polls update values without replacing the axis-name inputs or their focus");
  assert.equal(recording.element("head-label-7").value, "Turn");
  assert.equal(recording.element("head-axis-7-position").textContent, "2065");
  assert.equal(recording.element("head-axis-7-min").textContent, "2005");
  assert.match(recording.element("head-calibration-sampled").textContent, /6 samples/);
  recording.root.hidden = true;
  const beforeRecordingTabChange = recording.requests.length;
  await recording.api.activate();
  assert.equal(recording.requests.length, beforeRecordingTabChange, "changing tabs leaves the head recording session running");
  assert.equal(recording.timers.size, 1);
  let finishPoll;
  recording.intercept(() => new Promise(resolve => { finishPoll = resolve; }));
  const pendingPoll = recording.runTimer();
  await tick();
  assert.equal(recording.timers.size, 0, "no next poll is queued while the previous request is pending");
  await recording.api.activate();
  assert.equal(recording.timers.size, 0, "idempotent activation cannot overlap a pending poll");
  finishPoll(); await pendingPoll;
  assert.equal(recording.timers.size, 1);
  recording.intercept(() => { throw new Error("Temporary network error"); });
  await recording.runTimer();
  assert.match(recording.element("head-calibration-message").textContent, /Temporary network error.*Retrying/);
  assert.equal([...recording.timers.values()][0].delay, 500, "network failures back off without stopping the server recording");
  assert.equal(recording.api.snapshot().armed, true);
  assert.equal(recording.element("head-calibration-stop").disabled, false);
  await recording.runTimer();
  assert.equal([...recording.timers.values()][0].delay, 250, "successful refresh restores normal polling");
  assert.doesNotMatch(recording.element("head-calibration-message").textContent, /Retrying/);
  await recording.click("head-calibration-centre");
  assert.equal(recording.requests.at(-1).path, "head/calibration/centre");
  assert.deepEqual(recording.requests.at(-1).body, {});
  assert.equal(recording.element("head-axis-7-centre").textContent, "2065");
  assert.equal(recording.element("head-label-7").value, "Turn");
  await recording.click("head-calibration-stop");
  assert.equal(recording.timers.size, 0);
  assert.equal(recording.element("head-calibration-state").textContent, "Recording stopped");
  assert.equal(recording.element("head-calibration-save").disabled, false);
  assert.equal(recording.element("head-calibration-centre").disabled, false, "centre may also be captured after stopping");
  await recording.click("head-calibration-save");
  assert.equal(recording.requests.at(-1).path, "head/calibration/save");
  assert.deepEqual(recording.requests.at(-1).body, { labels: { "7": "Turn", "8": "Tilt" } });
  assert.match(recording.element("head-calibration-saved").textContent, /Saved range for this head: Turn \(ID 7\) 2005 \/ 2065 \/ 2105/);
  assert.match(recording.root.innerHTML, /Release head torque before moving it by hand/);
  assert.ok(recording.requests.every(entry => entry.path !== "command"), "head range recording never uses a movement or torque endpoint");

  const resumedCalibration = { recording: true, state: "recording", device: headDevice, baudrate: 1000000, axes: measuredAxes,
    sampled_at: "2026-10-16T00:01:01Z", sample_count: 6 };
  const resumed = harness(false, { head: { ...readyHead, calibration: resumedCalibration } });
  await resumed.api.activate();
  assert.deepEqual(resumed.requests.map(entry => entry.path), ["status"], "reloading discovers an existing recording without starting another reader");
  assert.equal(resumed.timers.size, 1);
  await resumed.api.deactivate();
  assert.equal(resumed.timers.size, 0, "deactivation stops only the browser polling timer");
  assert.ok(resumed.requests.every(entry => entry.path !== "head/calibration/stop"), "leaving the browser does not stop server recording");
  await resumed.api.activate();
  assert.equal(resumed.timers.size, 1);
  await resumed.change("head-device", "");
  assert.equal(resumed.element("head-calibration-start").disabled, true);
  assert.equal(resumed.element("head-calibration-centre").disabled, true);
  assert.equal(resumed.element("head-calibration-stop").disabled, false, "a changed selector cannot trap a running recording");
  await resumed.click("head-calibration-stop");
  assert.equal(resumed.requests.at(-1).path, "head/calibration/stop");
  assert.equal(resumed.timers.size, 0);
  assert.equal(resumed.element("head-calibration-save").disabled, true, "a recording cannot be saved against a different selected connection");

  const poweredHead = harness(false, { head: { ...readyHead, motors: headReadings.map(motor => ({ ...motor, torque_enabled: true })), calibration: resumedCalibration } });
  await poweredHead.api.activate();
  assert.equal(poweredHead.element("head-calibration-start").disabled, true);
  assert.equal(poweredHead.element("head-calibration-centre").disabled, true, "manual capture requires both motor torque readings off");
  assert.equal(poweredHead.element("head-calibration-stop").disabled, false);
  poweredHead.nextCalibration({ recording: false, state: "error", message: "Motor torque was enabled. Recording stopped." });
  await poweredHead.runTimer();
  assert.equal(poweredHead.timers.size, 0, "server sampling errors stop the UI polling loop");
  assert.equal(poweredHead.element("head-calibration-state").textContent, "Recording error");
  assert.match(poweredHead.element("head-calibration-message").textContent, /torque was enabled/);
  assert.equal(poweredHead.element("head-calibration-save").disabled, true);

  const savedCalibration = { recording: false, state: "idle", axes: [], saved_matches_connection: false,
    saved: { device: "/dev/cu.usbserial-previous-head", baudrate: 57600, axes: measuredAxes.map(axis => ({ ...axis, label: axis.id === 7 ? "Turn" : "Tilt" })) } };
  const savedHead = harness(false, { head: { ...readyHead, calibration: savedCalibration } });
  await savedHead.api.activate();
  assert.equal(savedHead.element("head-calibration-readback").hidden, false, "persisted ranges remain visible after reload before a new recording");
  assert.equal(savedHead.element("head-label-7").value, "Turn");
  assert.match(savedHead.element("head-calibration-saved").textContent, /different or unverified connection/);
  assert.equal(savedHead.element("head-calibration-save").disabled, true);
  assert.equal(savedHead.timers.size, 0);

  const invalidRange = harness(false, { head: { ...readyHead, calibration: { ...resumedCalibration, state: "stopped", recording: false,
    axes: measuredAxes.map(axis => ({ ...axis, centre: axis.max + 1 })) } } });
  await invalidRange.api.activate();
  assert.equal(invalidRange.element("head-calibration-save").disabled, true, "a centre outside measured travel prevents saving");

  const delayedRecording = harness(false, { head: readyHead });
  await delayedRecording.api.activate();
  let finishStart;
  delayedRecording.intercept(() => new Promise(resolve => { finishStart = resolve; }));
  const startingRecording = delayedRecording.click("head-calibration-start");
  await tick();
  assert.equal(delayedRecording.element("head-calibration-stop").disabled, false, "Stop remains available while Start is in flight");
  const stoppingRecording = delayedRecording.click("head-calibration-stop");
  await tick();
  assert.deepEqual(delayedRecording.requests.map(entry => entry.path), ["status", "head/calibration/start"], "Stop waits behind Start so it cannot reach the server first");
  assert.equal(delayedRecording.api.snapshot().busy, false, "the calibration mutation queue is independent of motor output");
  finishStart();
  await Promise.all([startingRecording, stoppingRecording]);
  assert.deepEqual(delayedRecording.requests.map(entry => entry.path), ["status", "head/calibration/start", "head/calibration/stop"]);
  assert.equal(delayedRecording.element("head-calibration-state").textContent, "Recording stopped");
  assert.equal(delayedRecording.timers.size, 0);

  const stoppingWithPoll = harness(false, { head: { ...readyHead, calibration: resumedCalibration } });
  await stoppingWithPoll.api.activate();
  let finishOldPoll;
  stoppingWithPoll.intercept(() => new Promise(resolve => { finishOldPoll = resolve; }));
  const oldPoll = stoppingWithPoll.runTimer();
  await tick();
  await stoppingWithPoll.click("head-calibration-stop");
  finishOldPoll({ ok: true, json: async () => ({ ok: true, head: { ...readyHead, calibration: resumedCalibration }, armed: false }) });
  await oldPoll;
  assert.equal(stoppingWithPoll.element("head-calibration-state").textContent, "Recording stopped", "an older cached poll cannot resurrect recording after Stop");
  assert.equal(stoppingWithPoll.timers.size, 0);

  const changedTorque = harness(false, { head: { ...readyHead, calibration: resumedCalibration } });
  await changedTorque.api.activate();
  changedTorque.intercept(() => ({ ok: true, json: async () => ({ ok: true, armed: false, head: { ...readyHead,
    motors: headReadings.map(motor => ({ ...motor, torque_enabled: true })),
    calibration: { ...resumedCalibration, state: "error", recording: false, message: "Torque enabled; recording stopped." } } }) }));
  await changedTorque.runTimer();
  assert.match(changedTorque.element("head-readings").innerHTML, /On/, "when recording stops, readback refreshes even if connection state remains ready");
  assert.doesNotMatch(changedTorque.element("head-readings").innerHTML, /<td>Off<\/td>/);

  const arms = harness();
  await arms.api.activate();
  arms.nextDrumsCheck({ state: "partial", message: "Motor 2 did not reply.", motors: drumReadings.map(motor => motor.id === 2 ? { ...motor, connected: false, error: "No reply" } : motor) });
  await arms.click("drums-check");
  assert.equal(arms.element("drums-state").textContent, "Partial connection");
  assert.match(arms.element("drums-readings").innerHTML, /No reply/);
  assert.equal(arms.element("drums-torque-on").disabled, true);
  const beforePartialArmMove = arms.requests.length;
  await arms.testMotor(0);
  assert.equal(arms.requests.length, beforePartialArmMove, "partial arm responses block direct moves");
  await arms.click("drums-release");
  assert.deepEqual(arms.requests.at(-1).body, { kind: "drums_torque", enabled: false, dry_run: false }, "release remains available on a partial arm connection");
  await arms.click("drums-check");
  assert.equal(arms.element("drums-torque-on").disabled, false);
  await arms.click("drums-torque-on");
  assert.deepEqual(arms.requests.at(-1).body, { kind: "drums_torque", enabled: true, dry_run: false });
  await arms.change("drums-baudrate", "2000000");
  assert.equal(arms.element("drums-torque-on").disabled, true);
  assert.equal(arms.element("drums-release").disabled, true, "release cannot target the previous connection after the selector changes");
  assert.equal(arms.element("drums-state").textContent, "Check required");
  assert.equal(arms.api.snapshot().armed, true);
  const beforeStaleArmRelease = arms.requests.length;
  await arms.click("drums-release");
  assert.equal(arms.requests.length, beforeStaleArmRelease);
  await arms.click("drums-check");
  assert.deepEqual(arms.requests.at(-1).body, { device: drumDevice, baudrate: 2000000 });
  assert.equal(arms.element("drums-torque-on").disabled, false);
  await arms.click("drums-torque-on");
  arms.intercept(() => ({ ok: false, status: 502, json: async () => ({ ok: false, armed: false, error: "Arm motor timed out", drums: { state: "partial", device: drumDevice, baudrate: 2000000, motors: drumReadings, message: "Arm motor timed out." } }) }));
  await arms.testMotor(0);
  assert.equal(arms.element("drums-state").textContent, "Partial connection", "arm command errors reconcile the arm snapshot");
  assert.equal(arms.api.snapshot().armed, true, "transport errors do not latch an emergency");
  await arms.click("drums-disconnect");
  assert.equal(arms.requests.at(-1).path, "drums/disconnect");
  assert.equal(arms.element("drums-state").textContent, "Disconnected");

  const strikes = harness();
  await strikes.api.activate();
  await strikes.click("drums-check");
  assert.equal(strikes.testButton(0, "strike").disabled, true, "a connected arm with torque off cannot strike");
  await strikes.click("drums-torque-on");
  assert.equal(strikes.testButton(0, "strike").disabled, false, "an in-range powered arm is immediately available");
  assert.equal(strikes.testButton(3, "strike").disabled, false, "torque-on returns the out-of-range hi-hat to rest");
  assert.deepEqual(strikes.status().drums.motors.map(motor => motor.position), [2200, 1850, 2300, 2600]);
  strikes.nextDrumsCheck({ motors: drumReadings.map(motor => ({ ...motor, torque_enabled: true })) });
  await strikes.click("drums-check");
  assert.equal(strikes.testButton(3, "strike").disabled, true, "an out-of-range hi-hat cannot strike");
  assert.match(strikes.element("strike-reason-3").textContent, /2613.*outside 2410–2600.*Arm torque on \+ rest/);
  assert.match(strikes.element("motor-readback-0").textContent, /Measured 2200 · Torque on/);
  assert.match(strikes.element("drums-motors").innerHTML, /<details class="robot-motor-advanced"><summary>Advanced position test<\/summary>/);
  assert.doesNotMatch(strikes.element("drums-motors").innerHTML, /<details[^>]* open/);
  strikes.input("number-0", 2101); strikes.input("duration-0", 1234);
  await strikes.testStrike(0);
  assert.deepEqual(strikes.requests.at(-1).body, { kind: "drums_strike", motor_id: 0, dry_run: false }, "basic strike uses backend Max targets, independent of advanced drafts");
  assert.equal(strikes.testButton(0, "strike").disabled, true);
  assert.equal(strikes.testButton(0, "move").disabled, true);
  assert.equal(strikes.testButton(3, "move").disabled, true, "all arm movement is blocked while a strike is pending");
  assert.match(strikes.element("strike-reason-0").textContent, /Raising to rest/);
  for (const id of [0, 1, 2, 3]) {
    assert.equal(strikes.testButton(id, "strike").disabled, true, `motor ${id} strike is disabled during preparation`);
    assert.equal(strikes.testButton(id, "move").disabled, true, `motor ${id} manual movement is disabled during preparation`);
  }
  assert.equal(strikes.timers.size, 1);
  const beforeOverlappingStrike = strikes.requests.length;
  await strikes.testStrike(0); await strikes.testMotor(3);
  assert.equal(strikes.requests.length, beforeOverlappingStrike, "handler checks prevent overlapping arm actions even if UI buttons are bypassed");
  let finishDrumPoll;
  strikes.intercept(() => new Promise(resolve => { finishDrumPoll = resolve; }));
  const drumPolling = strikes.runTimer(); await tick();
  assert.equal(strikes.timers.size, 0, "only one cached arm poll can be in flight");
  strikes.root.hidden = true; await strikes.api.activate();
  assert.equal(strikes.timers.size, 0, "tab activation neither duplicates polls nor cancels the strike");
  finishDrumPoll(); await drumPolling;
  strikes.nextDrumsStatus({ busy: true, strike: { state: "striking", motor_id: 0, origin: 2200, rest_position: 2200 } });
  await strikes.runTimer();
  assert.match(strikes.element("strike-reason-0").textContent, /Striking/);
  assert.equal(strikes.testButton(1, "strike").disabled, true, "other arms remain blocked through the hit phase");
  strikes.nextDrumsStatus({ busy: true, strike: { state: "returning", motor_id: 0, origin: 2200 } });
  await strikes.runTimer();
  assert.match(strikes.element("strike-reason-0").textContent, /Returning to raised rest/);
  assert.equal(strikes.testButton(2, "move").disabled, true, "manual movement remains blocked through the return phase");
  strikes.nextDrumsStatus({ busy: false, strike: { state: "complete", motor_id: 0, origin: 2200 }, motors: drumReadings.map(motor => ({ ...motor, torque_enabled: true })) });
  await strikes.runTimer();
  assert.equal(strikes.timers.size, 0);
  assert.equal(strikes.testButton(0, "strike").disabled, false);
  assert.match(strikes.element("strike-reason-0").textContent, /commands complete/);
  assert.equal(strikes.element("number-0").value, "2101", "polling preserves advanced values");
  assert.equal(strikes.testButton(3, "strike").disabled, true, "the hat remains independently blocked after another arm completes");

  const swappedArms = harness();
  await swappedArms.api.activate(); await swappedArms.click("drums-check"); await swappedArms.click("drums-torque-on");
  const armCards = swappedArms.element("drums-motors").innerHTML;
  const rideCard = armCards.match(/<article[^>]*data-robot-motor="1"[\s\S]*?<\/article>/)[0];
  const snareCard = armCards.match(/<article[^>]*data-robot-motor="2"[\s\S]*?<\/article>/)[0];
  assert.match(rideCard, /<h3>Ride<\/h3>[\s\S]*min="1850" max="2125"/);
  assert.match(snareCard, /<h3>Snare<\/h3>[\s\S]*min="2070" max="2350"/);
  assert.match(rideCard, /Set rest \(up\) · 1850[\s\S]*Set hit \(down\) · 2000/);
  assert.match(snareCard, /Set rest \(up\) · 2300[\s\S]*Set hit \(down\) · 2150/);
  assert.equal(swappedArms.element("strike-reason-1").textContent, "Rest (up) 1850 → hit (down) 2000 → rest.");
  assert.equal(swappedArms.element("strike-reason-2").textContent, "Rest (up) 2300 → hit (down) 2150 → rest.");
  await swappedArms.testStrike(1);
  assert.deepEqual(swappedArms.requests.at(-1).body, { kind: "drums_strike", motor_id: 1, dry_run: false }, "Ride selects motor 1 without swapping its calibrated range");
  assert.equal(swappedArms.status().drums.strike.rest_position, 1850);
  assert.equal(swappedArms.status().drums.strike.strike_position, 2000);
  swappedArms.nextDrumsStatus({ busy: false, strike: { state: "complete", motor_id: 1 } });
  await swappedArms.runTimer();
  await swappedArms.testStrike(2);
  assert.deepEqual(swappedArms.requests.at(-1).body, { kind: "drums_strike", motor_id: 2, dry_run: false }, "Snare selects motor 2 and keeps its opposite tick direction");
  assert.equal(swappedArms.status().drums.strike.rest_position, 2300);
  assert.equal(swappedArms.status().drums.strike.strike_position, 2150);

  const stopping = harness();
  await stopping.api.activate(); await stopping.click("drums-check"); await stopping.click("drums-torque-on");
  const oldMoveStatus = stopping.status();
  let finishMoveBeforeStop;
  stopping.intercept(() => new Promise(resolve => { finishMoveBeforeStop = resolve; }));
  const oldMove = stopping.testMotor(0); await tick();
  assert.equal(stopping.api.snapshot().busy, true);
  assert.equal(stopping.element("emergency-stop").disabled, false, "emergency stop remains available while a motor command is blocked");
  const stopPending = stopping.api.emergencyStop();
  assert.equal(stopping.api.snapshot().emergencyStopped, true, "emergency latches locally before any HTTP response");
  assert.ok(stopping.liveStops > 0, "live patterns stop immediately");
  assert.equal(stopping.requests.at(-1).path, "emergency-stop", "emergency bypasses the outstanding motor request");
  assert.equal(stopping.element("emergency-reset").disabled, true);
  await stopPending;
  finishMoveBeforeStop({ ok: true, json: async () => ({ ...oldMoveStatus, ok: true, emergency_stopped: false, commands: [], message: "Late movement response" }) });
  await oldMove;
  assert.equal(stopping.api.snapshot().emergencyStopped, true, "a stale successful move cannot clear an emergency");
  assert.match(stopping.element("motor-readback-0").textContent, /Torque off/, "the stale response cannot restore old torque readbacks");
  assert.equal(stopping.testButton(0, "strike").disabled, true);
  await stopping.click("emergency-reset");
  assert.equal(stopping.requests.at(-1).path, "emergency-reset");
  assert.equal(stopping.api.snapshot().armed, true);
  assert.equal(stopping.api.snapshot().emergencyStopped, false);
  assert.equal(stopping.testButton(0, "strike").disabled, true, "reset alone never turns torque on");
  assert.equal(stopping.element("drums-torque-on").disabled, false);
  assert.equal(stopping.element("emergency-reset").hidden, true);

  const queued = harness();
  await queued.api.activate(); await queued.click("drums-check"); await queued.click("drums-torque-on");
  const commandsBeforeQueued = queued.requests.filter(entry => entry.path === "command").length;
  const notSent = queued.testMotor(0);
  const queueStop = queued.api.emergencyStop();
  await Promise.all([notSent, queueStop]);
  assert.equal(queued.requests.filter(entry => entry.path === "command").length, commandsBeforeQueued, "commands waiting for their queue turn are discarded after emergency stop");

  const remoteStop = harness();
  await remoteStop.api.activate();
  remoteStop.intercept(() => ({ ok: true, json: async () => ({ ...remoteStop.status(), emergency_stopped: true, armed: false }) }));
  await remoteStop.runStatusPoll();
  assert.equal(remoteStop.api.snapshot().emergencyStopped, true, "cached status polling discovers another client’s stop");
  assert.ok(remoteStop.liveStops > 0);
  await remoteStop.runStatusPoll();
  assert.equal(remoteStop.api.snapshot().emergencyStopped, true, "ordinary status responses cannot reset a latched client");
  await remoteStop.click("emergency-reset");
  assert.equal(remoteStop.api.snapshot().emergencyStopped, false);

  const staleStop = harness(false, { emergencyStopped: true });
  await staleStop.api.activate();
  const latchedStatus = staleStop.status();
  let finishLatchedPoll;
  staleStop.intercept(() => new Promise(resolve => { finishLatchedPoll = resolve; }));
  const latchedPoll = staleStop.runStatusPoll(); await tick();
  await staleStop.click("emergency-reset");
  assert.equal(staleStop.api.snapshot().emergencyStopped, false);
  const stopsAfterReset = staleStop.liveStops;
  finishLatchedPoll({ ok: true, json: async () => ({ ...latchedStatus, emergency_stopped: true, armed: false }) });
  await latchedPoll;
  assert.equal(staleStop.api.snapshot().emergencyStopped, false, "a status request started before reset cannot relatch the client after reset succeeds");
  assert.equal(staleStop.status().emergency_stopped, false);
  assert.equal(staleStop.liveStops, stopsAfterReset, "the stale latched response cannot stop a new session");
  assert.equal(staleStop.element("emergency-reset").hidden, true);

  const resetRace = harness(false, { emergencyStopped: true });
  await resetRace.api.activate();
  let finishReset;
  resetRace.intercept(() => new Promise(resolve => { finishReset = resolve; }));
  const resetting = resetRace.click("emergency-reset"); await tick();
  const newerStop = resetRace.api.emergencyStop(); await tick();
  assert.equal(resetRace.requests.at(-1).path, "emergency-stop", "a new stop is sent immediately even during reset");
  finishReset(); await Promise.all([resetting, newerStop]);
  assert.equal(resetRace.requests.at(-1).path, "emergency-stop", "stop is repeated after the older reset settles");
  assert.equal(resetRace.status().emergency_stopped, true, "the final server state is latched");
  assert.equal(resetRace.api.snapshot().emergencyStopped, true);

  const failedStop = harness();
  await failedStop.api.activate();
  failedStop.intercept(() => ({ ok: false, status: 503, json: async () => ({ ok: false, emergency_stopped: true, armed: false, error: "Arm 1 did not acknowledge torque off" }) }));
  await assert.rejects(failedStop.api.emergencyStop(), /did not acknowledge/);
  assert.equal(failedStop.api.snapshot().emergencyStopped, true);
  assert.match(failedStop.element("status").textContent, /remains active.*did not acknowledge/);
  assert.equal(failedStop.element("emergency-stop").disabled, false, "release errors permit an explicit stop retry");

  const prearmed = harness(true);
  await prearmed.api.activate();
  assert.deepEqual(prearmed.requests.map(item => [item.path, item.body]), [["status", undefined]]);
  assert.match(prearmed.element("drums-motors").innerHTML, /Kick/, "opening an existing session retains the motor catalog");
  assert.equal(prearmed.api.snapshot().armed, true);
  assert.equal(prearmed.element("torque-on").disabled, true);

  const noMatch = harness(false, { withLED: false });
  await noMatch.api.activate();
  assert.equal(noMatch.element("midi-connect").hidden, true, "successful MIDI access waits for hotplug without a retry button");
  assert.doesNotMatch(noMatch.element("midi-device").textContent, /Hydrasynth/);
  await noMatch.clickData("robotLed", "color");
  assert.equal(noMatch.sent.length, 0, "a synth-only MIDI list cannot receive LED commands");
  assert.match(noMatch.element("status").textContent, /Pimoroni|Plasma/i);
  noMatch.midi.outputs.set(noMatch.output.id, noMatch.output);
  await noMatch.midi.listener();
  assert.equal(noMatch.element("midi-device").textContent, ledName, "a newly attached Plasma connects automatically");
  assert.equal(noMatch.sent.length, 0, "hotplug in live mode does not change the LEDs");
  await noMatch.clickData("robotLed", "color");
  assert.equal(noMatch.sent.length, 2, "a deliberate live test reaches the newly attached Plasma");

  for (const output of [{ name: "Pimoroni LED controller" }, { name: "CircuitPython MIDI", manufacturer: "Pimoroni" }]) {
    const recognized = harness(false, { output });
    await recognized.api.activate();
    assert.equal(recognized.element("midi-device").textContent, output.name, "Pimoroni in the name or manufacturer identifies the controller");
    assert.equal(recognized.sent.length, 0);
  }

  const denied = harness(false, { requestMIDIAccess(midi, attempt) {
    return attempt === 1 ? Promise.reject(new Error("MIDI permission denied")) : Promise.resolve(midi);
  } });
  await denied.api.activate();
  await tick();
  assert.equal(denied.element("midi-connect").hidden, false, "permission failure exposes the MIDI retry button");
  assert.equal(denied.element("midi-connect").disabled, false);
  assert.match(denied.element("midi-hint").textContent, /MIDI permission denied/);
  await denied.clickData("robotLed", "color");
  assert.equal(denied.sent.length, 0);
  await denied.click("midi-connect");
  assert.equal(denied.midiRequests.length, 2);
  assert.equal(denied.element("midi-device").textContent, ledName);
  assert.equal(denied.element("midi-connect").hidden, true, "successful retry hides the connection action again");
  assert.equal(denied.sent.length, 0, "permission retry does not send LED commands");

  let finishMIDIPermission;
  const delayed = harness(false, { requestMIDIAccess(midi) {
    return new Promise(resolve => { finishMIDIPermission = () => resolve(midi); });
  } });
  const firstActivation = delayed.api.activate();
  await tick();
  assert.equal(delayed.midiRequests.length, 1);
  await delayed.api.deactivate();
  const secondActivation = delayed.api.activate();
  await tick();
  assert.equal(delayed.midiRequests.length, 1, "reopening during a pending permission request does not duplicate it");
  finishMIDIPermission();
  await Promise.all([firstActivation, secondActivation]);
  await tick();
  assert.equal(delayed.element("midi-device").textContent, ledName, "delayed permission completes discovery for the reopened workspace");
  assert.equal(delayed.element("midi-connect").hidden, true);
  assert.equal(delayed.api.snapshot().armed, true);
  assert.equal(delayed.sent.length, 0);
  await delayed.clickData("robotLed", "color");
  assert.equal(delayed.sent.length, 2, "the reopened workspace can use the asynchronously discovered controller");

  // Setup and live control share the same session, regardless of visible tab.
  const shared = harness(), snapshots = [];
  const unsubscribe = shared.api.subscribe(value => snapshots.push(copy(value)));
  assert.equal(snapshots.at(-1).active, false);
  await shared.api.activate();
  assert.equal(snapshots.at(-1).ledConnected, true);
  assert.equal(snapshots.at(-1).torqueEnabled, false);
  await assert.rejects(shared.api.moveRibs(64, 1000), /torque/i);
  shared.nextCheck({ motors: ribReadings.map(motor => ({ ...motor, torque_enabled: true })) });
  await shared.click("ribs-check");
  shared.root.hidden = true;
  const requestsBeforeReturn = shared.requests.length;
  await shared.api.activate();
  await shared.api.activate();
  assert.equal(shared.requests.length, requestsBeforeReturn, "switching between setup and control preserves the shared session without disarming");
  assert.equal(shared.api.snapshot().armed, true);
  shared.api.sendColour("#ff8000", 50);
  assert.deepEqual(shared.sent, [[0x90, 1, 64], [0xA0, 32, 0]], "live LED control uses the same detected controller while setup is hidden");
  assert.throws(() => shared.api.sendColour("#invalid", 50), /colour/);
  assert.throws(() => shared.api.sendColour("#ffffff", Infinity), /Brightness/);
  assert.equal(shared.sent.length, 2, "invalid live colours never reach MIDI");
  await shared.api.moveRibs(64, 1000);
  assert.deepEqual(shared.requests.at(-1).body, { kind: "ribs", position: 64, duration_ms: 1000, dry_run: false });
  await shared.change("head-device", headDevice);
  let finishIdentification;
  shared.intercept(() => new Promise(resolve => { finishIdentification = resolve; }));
  const identifying = shared.click("head-check");
  await tick();
  assert.equal(shared.element("head-check").disabled, true, "duplicate checks on one serial bus are prevented");
  assert.equal(shared.api.snapshot().busy, false, "head discovery does not mark the live rib connection busy");
  await shared.click("drums-check");
  assert.equal(shared.element("drums-state").textContent, "Connected", "separate bus diagnostics do not wait behind the head scan");
  await shared.api.moveRibs(48, 1000);
  assert.deepEqual(shared.requests.at(-1).body, { kind: "ribs", position: 48, duration_ms: 1000, dry_run: false }, "live rib commands continue while the head is being identified");
  finishIdentification();
  await identifying;
  assert.equal(shared.element("head-state").textContent, "Connected");
  assert.equal(shared.api.snapshot().armed, true);
  let finishMove;
  shared.intercept(() => new Promise(resolve => { finishMove = resolve; }));
  const moving = shared.api.moveRibs(32, 500);
  await tick();
  assert.equal(shared.api.snapshot().busy, true);
  const beforeOverlap = shared.requests.length;
  await assert.rejects(shared.api.moveRibs(96, 500), /busy/);
  assert.equal(shared.requests.length, beforeOverlap, "live commands cannot build a queue behind a slow serial operation");
  finishMove();
  await moving;
  assert.equal(shared.api.snapshot().busy, false);
  shared.intercept(() => ({ ok: false, status: 502, json: async () => ({ ok: false, armed: false, error: "Connection lost", ribs: { state: "disconnected", motors: [] } }) }));
  await assert.rejects(shared.api.moveRibs(64, 1000), /Connection lost/);
  assert.equal(shared.api.snapshot().armed, true, "connection loss only changes that group’s readiness");
  assert.equal(snapshots.at(-1).ribsReady, false, "live subscribers receive serial failures");
  shared.output.state = "disconnected";
  shared.midi.listener();
  assert.equal(snapshots.at(-1).ledConnected, false, "live subscribers receive LED hotplug state");
  unsubscribe();
  const snapshotCount = snapshots.length;
  await shared.api.deactivate();
  assert.equal(snapshots.length, snapshotCount);
  assert.throws(() => shared.api.sendColour("#ffffff", 50), /Keirzo control/);
  await assert.rejects(shared.api.moveRibs(64, 1000), /Keirzo control/);

  // Robot startup prepares all arms even while the separate drummer is stopped.
  const robotWithArms = harness(false, liveHeadOptions), robotArmProgress = [];
  const stoppedDrummer = robotWithArms.createDrummer(() => ({ running: true, bpm: 120, beat: 0, at: robotWithArms.now, token: "playing-track" }));
  robotWithArms.nextDrumsCheck({ motors: drumReadings.map(motor => ({ ...motor, position: [900, 3000, 1000, 2613][motor.id] })) });
  const robotWithArmsReady = await robotWithArms.api.prepareLive({ leds: true, ribs: true, head: true, drums: true }, { onProgress: message => robotArmProgress.push(message) });
  assert.equal(robotWithArmsReady.drumTorqueEnabled, true);
  assert.deepEqual(robotWithArms.status().drums.motors.map(motor => motor.position), [2200, 1850, 2300, 2600]);
  assert.equal(robotWithArms.requests.filter(entry => entry.body?.kind === "drums_torque" && entry.body.enabled).length, 1);
  assert.ok(robotArmProgress.includes("Moving arms to rest…"));
  assert.equal(robotArmProgress.at(-1), "Keirzo ready.");
  stoppedDrummer.hardwareChanged(); stoppedDrummer.tick(); await tick();
  assert.equal(stoppedDrummer.snapshot().enabled, false);
  assert.equal(robotWithArms.requests.some(entry => entry.path.startsWith("drums/performance/") || entry.body?.kind === "drums_strike"), false, "robot startup and playing music never enable drum hits without Start drumming");
  assert.equal(robotWithArms.acceptedHits.length, 0);

  const missingArmAdapter = harness(false, { drums: { device: "", ports: [] } });
  await assert.rejects(missingArmAdapter.api.prepareLive({ drums: true }), /Choose the drumming arm serial port/);
  assert.equal(missingArmAdapter.requests.some(entry => entry.path === "command" || entry.path === "drums/check"), false, "a missing arm adapter cannot lead to a guessed port or torque command");

  const disconnectedArms = harness();
  disconnectedArms.nextDrumsCheck({ state: "disconnected", message: "Drumming arm adapter not found.", motors: [] });
  await assert.rejects(disconnectedArms.api.prepareLive({ drums: true }), /adapter not found/);
  assert.equal(disconnectedArms.requests.some(entry => entry.path === "command" || entry.path.startsWith("drums/performance/")), false);

  for (const busyArms of [{ busy: true }, { performance: { state: "ready", busy: true } }]) {
    const inUseArms = harness(false, { ...liveHeadOptions, drums: busyArms });
    await assert.rejects(inUseArms.api.prepareLive({ head: true, ribs: true, drums: true }), /Stop automatic drumming or wait for the arm test/);
    assert.equal(inUseArms.requests.some(entry => entry.path === "command" || entry.path === "drums/check"), false, "Start robot cannot reposition arms or power other groups during a drum performance");
  }
  const busyOnArmCheck = harness();
  busyOnArmCheck.nextDrumsCheck({ busy: true });
  await assert.rejects(busyOnArmCheck.api.prepareLive({ drums: true }), /Stop automatic drumming or wait for the arm test/);
  assert.equal(busyOnArmCheck.requests.some(entry => entry.path === "command"), false, "a strike begun during discovery still blocks the rest command");

  const duplicateArmIds = harness();
  duplicateArmIds.nextDrumsCheck({ motors: drumReadings.map(motor => ({ ...motor, id: 0 })) });
  await assert.rejects(duplicateArmIds.api.prepareLive({ drums: true }), /healthy position readbacks/);
  assert.equal(duplicateArmIds.requests.some(entry => entry.path === "command"), false);

  const cancelledArmPreparation = harness(), armStartAbort = new AbortController();
  await assert.rejects(cancelledArmPreparation.api.prepareLive({ drums: true }, { signal: armStartAbort.signal, onProgress(message) {
    if (message === "Moving arms to rest…") armStartAbort.abort();
  } }), /cancelled/);
  assert.equal(cancelledArmPreparation.requests.some(entry => entry.path === "command"), false, "Stop before arm torque dispatch prevents the powered movement");

  const acceptedArmPreparation = harness(), acceptedArmAbort = new AbortController(); let finishArmPreparation;
  acceptedArmPreparation.interceptPath("command", () => new Promise(resolve => { finishArmPreparation = resolve; }));
  const pendingArmPreparation = acceptedArmPreparation.api.prepareLive({ drums: true }, { signal: acceptedArmAbort.signal });
  const cancelledAcceptedArms = assert.rejects(pendingArmPreparation, /cancelled/);
  await tick(); acceptedArmAbort.abort(); await cancelledAcceptedArms;
  assert.equal(acceptedArmPreparation.api.snapshot().busy, true, "an accepted torque-to-rest command retains the gate after Stop");
  const duringArmPreparation = acceptedArmPreparation.requests.length;
  acceptedArmPreparation.nextDrumsCheck({ motors: drumReadings.map(motor => ({ ...motor, torque_enabled: true, position: motors.find(item => item.group === "drums" && item.id === motor.id).rest })) });
  const restartedArms = acceptedArmPreparation.api.prepareLive({ drums: true });
  await tick(); assert.equal(acceptedArmPreparation.requests.length, duringArmPreparation, "another Start waits until the accepted rest movement has settled");
  finishArmPreparation(); await restartedArms;
  assert.equal(acceptedArmPreparation.requests.filter(entry => entry.body?.kind === "drums_torque").length, 1, "fresh readbacks avoid replaying a completed rest movement");
  assert.equal(acceptedArmPreparation.requests.some(entry => entry.path.startsWith("drums/performance/")), false);

  // Drumming prepares only its own serial bus and preserves absolute contact timing.
  const performer = harness(false, { withLED: false });
  const prepared = await startDrums(performer);
  assert.equal(prepared.performance.state, "ready");
  assert.equal(performer.api.snapshot().drumsReady, true);
  assert.equal(performer.api.snapshot().drumTorqueEnabled, true);
  assert.ok(performer.requests.some(entry => entry.path === "drums/check"));
  assert.deepEqual(performer.requests.filter(entry => entry.path === "command").map(entry => entry.body.kind), ["drums_torque"], "drum startup does not enable ribs or head torque");
  assert.equal(performer.requests.some(entry => entry.path === "ribs/check" || entry.path === "head/check"), false);
  const heartbeats = performer.requests.filter(entry => entry.path === "drums/performance/schedule");
  assert.equal(heartbeats.length, 5, "preparation stays alive while the arms reach raised rest");
  assert.ok(heartbeats.every(entry => entry.body.events.length === 0), "no hit is queued during preparation");
  const contactAt = performer.now + 500;
  await performer.api.scheduleDrums({ token: "test-session", events: [{ id: "hit-1", motor_id: 0, contactAt }] });
  assert.deepEqual(performer.acceptedHits, [{ id: "hit-1", motor_id: 0, contact_ms: contactAt + 10000 }], "browser monotonic contact times are translated into the server clock");
  await assert.rejects(performer.api.scheduleDrums({ token: "test-session", events: [{ contactAt: NaN }] }), /contact times/);
  const acceptedBeforeStop = performer.acceptedHits.length;
  await performer.api.stopDrumming();
  assert.equal(performer.requests.at(-1).options.keepalive, true);
  await assert.rejects(performer.api.scheduleDrums({ token: "test-session", events: [{ id: "late", motor_id: 0, contactAt: performer.now + 500 }] }), /no longer active/);
  assert.equal(performer.acceptedHits.length, acceptedBeforeStop);

  const isolatedArm = harness(); await startDrums(isolatedArm, "isolated-arm");
  const partialDrums = { ...isolatedArm.status().drums, state: "partial", port_open: true,
    motors: isolatedArm.status().drums.motors.map(motor => motor.id === 3
      ? { ...motor, torque_enabled: false, error: "Torque lost" } : motor) };
  isolatedArm.interceptPath("drums/performance/schedule", () => ({ ok: true, json: async () => ({
    ok: true, drums: partialDrums, performance: { token: "isolated-arm", state: "ready", busy: true,
      error: null, arms: [{ motor_id: 0, state: "ready" }, { motor_id: 3, state: "error", error: "Torque lost" }] }
  }) }));
  await isolatedArm.api.scheduleDrums({ token: "isolated-arm", events: [] });
  assert.equal(isolatedArm.api.snapshot().drumsReady, false);
  assert.equal(isolatedArm.api.snapshot().drumTorqueEnabled, false);
  assert.equal(isolatedArm.api.snapshot().drumPerformanceConnected, true);
  const beforePeerHit = isolatedArm.requests.length;
  await isolatedArm.api.scheduleDrums({ token: "isolated-arm", events: [{ id: "healthy-kick", motor_id: 0, contactAt: isolatedArm.now + 500 }] });
  assert.equal(isolatedArm.requests.length, beforePeerHit + 1, "one arm's fault must not block healthy goals at the bridge");
  await assert.rejects(isolatedArm.api.scheduleDrums({ token: "obsolete", events: [] }), /no longer active/);
  assert.equal(isolatedArm.requests.length, beforePeerHit + 1, "session identity remains mandatory");
  isolatedArm.updateStatus({ drums: { ...partialDrums, port_open: false } });
  await isolatedArm.click("refresh");
  const afterDisconnect = isolatedArm.requests.length;
  await assert.rejects(isolatedArm.api.scheduleDrums({ token: "isolated-arm", events: [] }), /no longer connected/);
  assert.equal(isolatedArm.requests.length, afterDisconnect, "whole-adapter disconnect still blocks before HTTP");

  const alreadyPoweredArms = harness();
  alreadyPoweredArms.nextDrumsCheck({ motors: drumReadings.map(motor => ({ ...motor, torque_enabled: true, position: motor.id === 0 ? 900 : motor.position })) });
  await startDrums(alreadyPoweredArms, "powered-away-from-rest");
  assert.deepEqual(alreadyPoweredArms.requests.filter(entry => entry.path === "command").map(entry => entry.body), [{ kind: "drums_torque", enabled: true, dry_run: false }], "already-powered arms outside their strike ranges return to rest before performance");
  assert.ok(alreadyPoweredArms.requests.findIndex(entry => entry.path === "command") < alreadyPoweredArms.requests.findIndex(entry => entry.path === "drums/performance/start"));
  assert.deepEqual(alreadyPoweredArms.status().drums.motors.map(motor => motor.position), [2200, 1850, 2300, 2600]);

  const restedReadings = drumReadings.map(reading => ({ ...reading, torque_enabled: true, position: motors.find(motor => motor.group === "drums" && motor.id === reading.id).rest }));
  const restingArms = harness();
  restingArms.nextDrumsCheck({ motors: restedReadings });
  await startDrums(restingArms, "already-at-rest");
  assert.equal(restingArms.requests.some(entry => entry.path === "command"), false, "powered arms already at rest skip the torque-on movement");

  const justOutsideRest = harness();
  justOutsideRest.nextDrumsCheck({ motors: restedReadings.map(motor => ({ ...motor, position: motor.id === 3 ? 2613 : motor.position })) });
  await startDrums(justOutsideRest, "near-rest-outside-range");
  assert.equal(justOutsideRest.requests.filter(entry => entry.body?.kind === "drums_torque").length, 1, "rest tolerance does not bypass the ordinary hit bounds");

  for (const invalidReadback of [{ position: null }, { torque_enabled: null }, { error: "Read failed" }]) {
    const unreadableArm = harness();
    unreadableArm.nextDrumsCheck({ motors: restedReadings.map(motor => motor.id === 0 ? { ...motor, ...invalidReadback } : motor) });
    await assert.rejects(unreadableArm.api.prepareLive({ drums: true }), /healthy position readbacks/);
    assert.equal(unreadableArm.requests.some(entry => entry.path === "command" || entry.path === "drums/performance/start"), false, "unreadable arms cannot enter rest recovery");
  }

  const unconfirmedArmRest = harness();
  unconfirmedArmRest.interceptPath("command", () => ({ ok: true, json: async () => ({ ...unconfirmedArmRest.status(), ok: true,
    drums: { ...unconfirmedArmRest.status().drums, motors: drumReadings.map(motor => ({ ...motor, torque_enabled: true })) } }) }));
  await assert.rejects(unconfirmedArmRest.api.prepareLive({ drums: true }), /did not confirm their rest positions/);
  assert.equal(unconfirmedArmRest.requests.some(entry => entry.path === "drums/performance/start"), false);

  // Delay the response to a submitted start: Stop must retire that session and
  // wait for startup cleanup instead of allowing a late completion to arm it.
  const lateDrumStart = harness();
  let finishDrumStart;
  lateDrumStart.interceptPath("drums/performance/start", () => new Promise(resolve => { finishDrumStart = resolve; }));
  const lateStarting = lateDrumStart.api.startDrumming({ token: "late-start", instruments: [0] });
  const lateRejected = assert.rejects(lateStarting, /cancel|no longer active/i);
  await tick(); assert.equal(typeof finishDrumStart, "function");
  let stopFinished = false;
  const lateStopping = lateDrumStart.api.stopDrumming({ token: "late-start" }).then(() => { stopFinished = true; });
  await tick(); assert.equal(stopFinished, false, "Stop awaits the pending start's cleanup");
  finishDrumStart(); await lateRejected; await lateStopping;
  assert.equal(lateDrumStart.acceptedHits.length, 0);
  assert.equal(lateDrumStart.requests.some(entry => entry.path.endsWith("/schedule")), false);

  for (const action of ["drums-release", "drums-disconnect", "emergency-stop"]) {
    const stopped = harness(); await startDrums(stopped, action);
    await stopped.click(action);
    const requestCount = stopped.requests.length;
    await assert.rejects(stopped.api.scheduleDrums({ token: action, events: [{ id: "after-stop", motor_id: 0, contactAt: stopped.now + 500 }] }), /no longer connected|no longer active|ready|emergency/i);
    assert.equal(stopped.requests.length, requestCount, `${action} blocks new hits before HTTP`);
    assert.equal(stopped.acceptedHits.length, 0);
  }

  const returning = harness(); await startDrums(returning, "returning-arms");
  const returningPerformance = { token: "returning-arms", state: "stopped", busy: true,
    arms: [{ motor_id: 0, state: "returning" }] };
  returning.interceptPath("drums/performance/stop", () => ({ ok: true, json: async () => ({ ok: true,
    performance: returningPerformance,
    drums: { ...returning.status().drums, busy: true, performance: returningPerformance } }) }));
  await returning.api.stopDrumming({ token: "returning-arms" });
  assert.equal(returning.api.snapshot().drumsBusy, true, "an accepted arm return remains busy after future hits are cancelled");
  assert.equal(returning.testButton(0, "strike").disabled, true);
  assert.ok([...returning.timers.values()].some(timer => timer.delay === 200), "stopped performance continues polling until accepted returns finish");
  returning.nextDrumsStatus({ busy: false, performance: { token: "returning-arms", state: "stopped", busy: false,
    arms: [{ motor_id: 0, state: "ready" }] } });
  await returning.runTimer();
  assert.equal(returning.api.snapshot().drumPerformance.busy, false, "arm status refresh also updates the cached performance");
  assert.equal(returning.api.snapshot().drumsBusy, false);
  assert.equal(returning.element("drums-check").disabled, false, "connection checks become available after return completion");
  assert.equal(returning.testButton(0, "strike").disabled, false, "manual tests become available after return completion");
  assert.equal(returning.timers.size, 0, "return completion ends the temporary polling loop");

  const staleReply = harness(); await startDrums(staleReply, "stale-reply");
  let finishStaleReply;
  staleReply.interceptPath("drums/performance/schedule", () => new Promise(resolve => {
    finishStaleReply = () => resolve({ ok: true, json: async () => ({ ok: true, server_time_ms: staleReply.now + 10000,
      performance: { token: "stale-reply", state: "ready", busy: true } }) });
  }));
  const outstandingHeartbeat = staleReply.api.scheduleDrums({ token: "stale-reply", events: [] });
  await tick(); await staleReply.api.stopDrumming({ token: "stale-reply" });
  finishStaleReply(); await outstandingHeartbeat.catch(() => {});
  assert.equal(staleReply.api.snapshot().drumPerformance.state, "stopped", "a late ready response cannot revive a stopped performance in the hardware cache");
  assert.equal(staleReply.api.snapshot().drumsBusy, false, "stale heartbeat replies cannot leave manual arm controls locked");

  const missingClock = harness();
  missingClock.interceptPath("drums/performance/status", () => undefined);
  missingClock.interceptPath("drums/check", () => {
    missingClock.interceptPath("drums/performance/status", () => ({ ok: true, json: async () => ({ ok: true, performance: { state: "stopped", busy: false } }) }));
  });
  await assert.rejects(missingClock.api.startDrumming({ token: "missing-clock", instruments: [0] }), /timing clock/);
  assert.equal(missingClock.requests.some(entry => entry.path === "drums/performance/start"), false);

  const malformedStart = harness();
  malformedStart.interceptPath("drums/performance/start", () => ({ ok: true, json: async () => ({ ok: true, performance: { token: "foreign-session", state: "ready" } }) }));
  await assert.rejects(malformedStart.api.startDrumming({ token: "bad-ready", instruments: [0] }), /not ready/);
  assert.equal(malformedStart.requests.at(-1).path, "drums/performance/stop");

  const roundTrips = harness();
  const clockSamples = [{ elapsed: 40, offset: 10000 }, { elapsed: 10, offset: 11000 }, { elapsed: 30, offset: 9000 }];
  const nextClockSample = () => roundTrips.interceptPath("drums/performance/status", () => {
    const sample = clockSamples.shift(), began = roundTrips.now;
    roundTrips.advance(sample.elapsed);
    if (clockSamples.length) nextClockSample();
    return { ok: true, json: async () => ({ ok: true, server_time_ms: began + sample.elapsed / 2 + sample.offset,
      performance: { token: null, state: "stopped", busy: false } }) };
  });
  roundTrips.interceptPath("drums/check", nextClockSample);
  await startDrums(roundTrips, "round-trips");
  const measuredContact = roundTrips.now + 450;
  await roundTrips.api.scheduleDrums({ token: "round-trips", events: [{ id: "measured", motor_id: 0, contactAt: measuredContact }] });
  assert.equal(roundTrips.acceptedHits.at(-1).contact_ms, measuredContact + 11000, "clock conversion uses the shortest round trip's midpoint");

  const slowClock = harness();
  let samplesRemaining = 3;
  const slowSample = () => slowClock.interceptPath("drums/performance/status", () => {
    slowClock.advance(150);
    if (--samplesRemaining) slowSample();
    return { ok: true, json: async () => ({ ok: true, server_time_ms: slowClock.now + 10000,
      performance: { token: null, state: "stopped", busy: false } }) };
  });
  slowClock.interceptPath("drums/check", slowSample);
  await assert.rejects(slowClock.api.startDrumming({ token: "slow-clock", instruments: [0] }), /too slowly/);
  assert.equal(slowClock.requests.some(entry => entry.path === "drums/performance/start"), false, "unreliable timing cannot start arm preparation");

  // Exercise the real pattern engine through the real browser hardware bridge.
  // Only the HTTP/serial endpoint is replaced, so API shape and lifecycle drift
  // cannot hide behind separate mocks in the two unit suites.
  const integrated = harness(false, { withLED: false });
  let musicPlaying = true;
  const drummer = integrated.createDrummer(() => ({ running: musicPlaying, bpm: 120,
    beat: integrated.now / 500, at: integrated.now, token: "track-one" }));
  const integratedStart = drummer.start(); await tick();
  for (let attempt = 0; attempt < 12 && [...integrated.timers.values()].some(timer => timer.delay === 100); attempt++) { integrated.runWait(); await tick(); }
  await integratedStart;
  integrated.advance(50); drummer.tick(); await tick();
  assert.equal(drummer.snapshot().running, true);
  assert.ok(integrated.acceptedHits.length > 0, "the actual engine schedules its generated groove through the actual bridge");
  assert.ok(integrated.acceptedHits.every(hit => hit.contact_ms > integrated.now + 10000), "hardware contacts are still in the future");
  musicPlaying = false; drummer.tick(); await tick();
  assert.equal(drummer.snapshot().waiting, true);
  assert.equal(integrated.api.snapshot().drumPerformance.state, "stopped", "source pause reaches the backend cancellation route");
  const hitsAtPause = integrated.acceptedHits.length;
  integrated.advance(1000); drummer.tick(); await tick();
  assert.equal(integrated.acceptedHits.length, hitsAtPause, "a paused source cannot enqueue more physical hits");
  await drummer.stop();

  const scheduleFailure = harness(); await startDrums(scheduleFailure, "failure");
  scheduleFailure.interceptPath("drums/performance/schedule", () => ({ ok: false, status: 502, json: async () => ({ ok: false, error: "Drum 2 stopped responding." }) }));
  await assert.rejects(scheduleFailure.api.scheduleDrums({ token: "failure", events: [] }), /Drum 2 stopped responding/);
  assert.equal(scheduleFailure.acceptedHits.length, 0);

  console.log("Keirzo setup tests passed: automatic live preparation, drum contact clocks, late response cancellation, serial buses, head calibration, emergency reset, tab continuity and Pimoroni MIDI.");
})().catch(error => { console.error(error); process.exitCode = 1; });
