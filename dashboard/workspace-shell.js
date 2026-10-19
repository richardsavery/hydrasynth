/* Shared navigation. Audio and connections stay in app.js. */
(function (root) {
  "use strict";

  const VIEWS = new Set(["connections", "synth-legacy", "synth-mixer", "drums", "elevenlabs", "mixer", "rap-experiment", "rap-response", "robot-setup", "robot-control"]);

  function normalizeView(value) {
    const view = String(value || "").replace(/^#/, "");
    if (view === "synth") return "synth-mixer";
    if (view === "signal-lab" || view === "stage") return "synth-legacy";
    return VIEWS.has(view) ? view : null;
  }

  function createWorkspace(environment = {}) {
    let document, window, callbacks, links, inputButtons;
    let currentView = null, initialized = false, inputMode = null;
    let output = "audio", midiReady = false;
    const $ = (id) => document.getElementById(id);
    const listen = (element, name, callback) => element?.addEventListener(name, callback);

    function showInputPane(pane) {
      if (pane !== "recording" && pane !== "live") return;
      inputButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.inputPane === pane)));
      if ($("connection-recording-pane")) $("connection-recording-pane").hidden = pane !== "recording";
      if ($("connection-live-pane")) $("connection-live-pane").hidden = pane !== "live";
    }

    function showOutput(value) {
      output = value === "midi" ? "midi" : "audio";
      if ($("connection-output")) $("connection-output").value = output;
      if ($("connection-midi-controls")) $("connection-midi-controls").hidden = output !== "midi";
      if ($("midi-panel")) $("midi-panel").hidden = output !== "midi";
      if ($("panic-button")) $("panic-button").hidden = output !== "midi" || !midiReady;
    }

    function navigate(value, options = {}) {
      const view = normalizeView(value);
      if (!initialized || !view) return false;
      const previous = currentView;
      currentView = view;
      document.body.dataset.workspace = view;
      document.body.classList.toggle("elevenlabs-active", view === "elevenlabs");
      $("connections-workspace").hidden = view !== "connections";
      $("signal-lab-workspace").hidden = view !== "synth-legacy" && view !== "drums";
      $("elevenlabs-workspace").hidden = view !== "elevenlabs";
      $("music-mixer-workspace").hidden = view !== "mixer";
      if ($("synth-mixer-workspace")) $("synth-mixer-workspace").hidden = view !== "synth-mixer";
      if ($("rap-experiment-workspace")) $("rap-experiment-workspace").hidden = view !== "rap-experiment";
      if ($("rap-response-workspace")) $("rap-response-workspace").hidden = view !== "rap-response";
      if ($("robot-setup-workspace")) $("robot-setup-workspace").hidden = view !== "robot-setup";
      if ($("robot-control-workspace")) $("robot-control-workspace").hidden = view !== "robot-control";
      if ($("sonification-kind")) $("sonification-kind").textContent = view === "drums" ? "DRUMS" : "SYNTH";
      const skip = document.querySelector(".skip-link");
      if (skip) skip.href = view === "connections" ? "#connections-workspace" : view === "elevenlabs" ? "#elevenlabs-workspace" : view === "mixer" ? "#music-mixer-workspace" : view === "synth-mixer" ? "#synth-mixer-workspace" : view === "rap-experiment" ? "#rap-experiment-workspace" : view === "rap-response" ? "#rap-response-workspace" : view === "robot-setup" ? "#robot-setup-workspace" : view === "robot-control" ? "#robot-control-workspace" : "#stage";
      links.forEach((link) => {
        const target = normalizeView(link.dataset.workspace);
        const selected = target === view || (view === "rap-experiment" && target === "rap-response");
        link.classList.toggle("is-active", selected);
        if (selected) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
      if (options.history !== false && window.location.hash !== `#${view}`) {
        const method = previous === null || options.replace ? "replaceState" : "pushState";
        window.history[method](null, "", `#${view}`);
      }
      if (previous !== view) callbacks.onNavigate?.(view, previous);
      return true;
    }

    function updateConnections(details = {}) {
      if (!initialized) return;
      if (typeof details.inputLabel === "string") $("connection-input-label").textContent = details.inputLabel;
      if (typeof details.outputLabel === "string") $("connection-output-label").textContent = details.outputLabel;
      if (details.inputState) {
        const state = details.inputState === "connecting" ? "pending" : ["ready", "warning", "error", "pending"].includes(details.inputState) ? details.inputState : "warning";
        $("connection-input-light").className = `status-light is-${state}`;
      }
      if (details.midiReady !== undefined) midiReady = details.midiReady === true;
      if (details.output !== undefined || details.midiReady !== undefined) showOutput(details.output ?? output);
      if (details.midiReady !== undefined || details.output !== undefined || details.outputState) {
        const state = details.outputState || (output === "midi" && !midiReady ? "warning" : "ready");
        $("connection-output-light").className = `status-light is-${["ready", "warning", "error", "pending"].includes(state) ? state : "warning"}`;
      }
      if (details.inputMode && details.inputMode !== inputMode) {
        inputMode = details.inputMode;
        showInputPane(inputMode);
      }
    }

    function init(options = {}) {
      if (initialized) return api;
      document = environment.document || root.document;
      window = environment.window || root.window;
      if (!document || !window) return api;
      callbacks = options;
      links = [...document.querySelectorAll("a[data-workspace]")];
      inputButtons = [...document.querySelectorAll("[data-input-pane]")];
      initialized = true;
      links.forEach((link) => listen(link, "click", (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
        event.preventDefault();
        navigate(link.dataset.workspace);
      }));
      inputButtons.forEach((button) => listen(button, "click", () => showInputPane(button.dataset.inputPane)));
      listen($("connection-output"), "change", (event) => {
        showOutput(event.target.value);
        callbacks.onOutputChange?.(output);
      });
      listen($("test-browser-audio"), "click", async () => {
        const button = $("test-browser-audio"), status = $("browser-audio-status");
        button.disabled = true;
        try {
          if (!callbacks.onTestAudio) throw new Error("Browser audio is not available.");
          await callbacks.onTestAudio();
          status.textContent = "Test sound played. Browser audio is ready.";
        } catch (error) {
          status.textContent = error.message || "Could not play the test sound.";
        } finally { button.disabled = false; }
      });
      listen($("return-to-recording"), "click", () => showInputPane("recording"));
      const followLocation = () => {
        const view = normalizeView(window.location.hash);
        if (view) navigate(view, { history: false });
        else if (!window.location.hash) navigate("connections", { history: false });
      };
      window.addEventListener("hashchange", followLocation);
      window.addEventListener("popstate", followLocation);
      showOutput($("connection-output")?.value || "audio");
      navigate(normalizeView(window.location.hash) || "connections", { replace: true });
      return api;
    }

    const api = { init, navigate, updateConnections, showInputPane,
      get currentView() { return currentView; } };
    return api;
  }

  root.HydraWorkspace = Object.assign(createWorkspace(), { create: createWorkspace, normalizeView });
})(globalThis);
