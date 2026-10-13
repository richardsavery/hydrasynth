/* Shared navigation and presentation preferences. Audio and connections stay in app.js. */
(function (root) {
  "use strict";

  const DETAIL_KEY = "hydra.interface-detail.v1";
  const VIEWS = new Set(["connections", "synth", "drums", "elevenlabs", "mixer"]);

  function normalizeView(value) {
    const view = String(value || "").replace(/^#/, "");
    if (view === "signal-lab" || view === "stage") return "synth";
    return VIEWS.has(view) ? view : null;
  }

  function createWorkspace(environment = {}) {
    let document, window, storage, callbacks, links, modes, inputButtons;
    let currentView = null, advanced = false, initialized = false, inputMode = null;
    let output = "audio", midiReady = false;
    const $ = (id) => document.getElementById(id);
    const listen = (element, name, callback) => element?.addEventListener(name, callback);

    function setAdvanced(value, persist = true) {
      advanced = Boolean(value);
      document.body.classList.toggle("advanced-mode", advanced);
      document.body.classList.toggle("basic-mode", !advanced);
      modes.forEach((button) => button.setAttribute("aria-pressed", String((button.dataset.detailMode === "advanced") === advanced)));
      if (persist) {
        try { storage?.setItem(DETAIL_KEY, advanced ? "advanced" : "basic"); } catch (_) { /* Session-only still works. */ }
      }
      callbacks.onAdvancedChange?.(advanced);
    }

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
      $("signal-lab-workspace").hidden = view !== "synth" && view !== "drums";
      $("elevenlabs-workspace").hidden = view !== "elevenlabs";
      $("music-mixer-workspace").hidden = view !== "mixer";
      if ($("sonification-kind")) $("sonification-kind").textContent = view === "drums" ? "DRUMS" : "SYNTH";
      const skip = document.querySelector(".skip-link");
      if (skip) skip.href = view === "connections" ? "#connections-workspace" : view === "elevenlabs" ? "#elevenlabs-workspace" : view === "mixer" ? "#music-mixer-workspace" : "#stage";
      links.forEach((link) => {
        const selected = normalizeView(link.dataset.workspace) === view;
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
      try { storage = environment.storage || window.localStorage; } catch (_) { storage = null; }
      callbacks = options;
      links = [...document.querySelectorAll("a[data-workspace]")];
      modes = [...document.querySelectorAll("[data-detail-mode]")];
      inputButtons = [...document.querySelectorAll("[data-input-pane]")];
      initialized = true;
      links.forEach((link) => listen(link, "click", (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
        event.preventDefault();
        navigate(link.dataset.workspace);
      }));
      modes.forEach((button) => listen(button, "click", () => setAdvanced(button.dataset.detailMode === "advanced")));
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
      let saved;
      try { saved = storage?.getItem(DETAIL_KEY); } catch (_) { /* Default to Basic. */ }
      setAdvanced(saved === "advanced", false);
      showOutput($("connection-output")?.value || "audio");
      navigate(normalizeView(window.location.hash) || "connections", { replace: true });
      return api;
    }

    const api = { init, navigate, updateConnections, setAdvanced, showInputPane,
      get currentView() { return currentView; }, get advanced() { return advanced; } };
    return api;
  }

  root.HydraWorkspace = Object.assign(createWorkspace(), { create: createWorkspace, normalizeView });
})(globalThis);
