"use strict";

globalThis.HydraRapExperiment = (() => {
  const KEY = "hydra-rap-experiment-v1";
  const DEFAULT_TEXT = "Signals rise, we find the flow\nTurn the dial and let it go\nBass and motion, light and sound\nKeep the rhythm moving round";
  const NOTES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  const SCALES = ["minor", "major", "chromatic"];
  const MELODIES = { follow: "Follow voice", drone: "One note", two_note: "Two notes", rising: "Rising", falling: "Falling", arpeggio: "Arpeggio", hook: "Pop hook" };
  const RHYTHMS = { natural: "Natural", phrases: "Phrases on beats", flow: "Beat flow" };
  const AUDITION_GROUPS = [["neutral", "Neutral · Rhythm"], ["jade", "Jade · Melodies"], ["clear", "Clear & rhythmic"], ["deep", "Deep & gritty"], ["bright", "Bright & synthetic"]];
  const musicalKey = value => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) < 12 ? Number(value) : 0;
  const musicalScale = value => SCALES.includes(value) ? value : "minor";
  const melodyMode = value => Object.hasOwn(MELODIES, value) ? value : "follow";
  const melodyOctave = value => Number.isInteger(Number(value)) && Number(value) >= 2 && Number(value) <= 5 ? Number(value) : 3;
  const noteBeats = value => [.5, 1, 2].includes(Number(value)) ? Number(value) : 1;
  const rhythmMode = value => Object.hasOwn(RHYTHMS, value) ? value : "natural";
  const robotLabel = value => {
    if (value?.robot_style !== "autotune") return ({ metallic: "Metallic", radio: "Radio", vocoder: "Vocoder" })[value?.robot_style] || "Metallic";
    const melody = melodyMode(value.robot_melody), beats = noteBeats(value.robot_note_beats), scale = musicalScale(value.robot_scale);
    return `Autotune · ${NOTES[musicalKey(value.robot_key)]} ${scale}${scale === "chromatic" && melody !== "follow" ? " (major melody)" : ""} · ${MELODIES[melody]}` +
      (melody === "follow" ? "" : ` · Octave ${melodyOctave(value.robot_octave)} · ${beats} beat${beats === 1 ? "" : "s"}/note`);
  };
  const VARIANTS = [
    ["flash", "Fast clean voice", "A fresh voice recording using the fast speech model."],
    ["robot", "Robot voice", "The same fast recording, shaped with robot voice effects."],
    ["baseline", "Natural voice", "Original speech cadence, without beat cuts."],
    ["phrases", "Phrases on beats", "The same voice, with phrase starts placed on beats."],
    ["fresh", "Fresh performance", "A new recording of the same words and voice."],
    ["alternate", "Different voice", "The same words performed by the alternate voice."],
    ["expressive", "Expressive delivery", "A new performance with the selected delivery direction."],
    ["bars", "Fit to bars", "Whole phrases fitted to bars while preserving pitch."],
    ["produced", "Vocal production", "Compression, EQ and subtle doubling on the bar-fitted vocal."],
    ["music", "Music-generated rap", "A rap performance generated with music, then separated into vocals."]
  ];
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const modelLabel = value => ({ eleven_flash_v2_5: "Eleven Flash 2.5", eleven_multilingual_v2: "Eleven Multilingual v2", eleven_v3: "Eleven v3", eleven_v4: "Eleven v4", music_v2_5: "Eleven Music 2.5" })[value] || String(value || "").replace(/_/g, " ");
  const uid = () => globalThis.crypto?.randomUUID?.() || `experiment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const audioURL = value => typeof value === "string" && /^\/api\//.test(value) ? value : "";
  const done = value => ["complete", "partial", "partial_failure", "failed", "error", "unknown", "skipped"].includes(value);
  const fastJob = value => {
    const requested = value?.variants || value?.examples?.map(item => item.id || item.variant) || [];
    return requested.length > 0 && requested.every(id => ["flash", "robot"].includes(id));
  };
  const unavailableAudition = value => AUDITION_GROUPS.some(([id]) => id === value?.audition_group) && ["failed", "error", "unknown"].includes(value.state);
  let root, onSave = () => {}, initialized = false, active = false, run = 0, controller, poll;
  let experiment = null, experiments = [], savedOrder = [], selected = "", pending = null, busy = false, voices = [], defaultVoice = "", alternateVoice = "";
  let context, source, gain, playing = "", starting = "", playRun = 0, metronomeTimer, nextClick = 0, beat = 0, clicks = new Set();
  let adoptLatestDraft = true, manualVoice = false, manualAlternate = false;
  const $ = key => root.querySelector(`[data-rx-${key}]`);
  const voiceLabel = value => {
    const id = value || defaultVoice;
    return voices.find(voice => voice.voice_id === id)?.name || (id ? `Voice ${id.slice(0, 8)}${id.length > 8 ? "…" : ""}` : "");
  };
  const draft = () => ({ text: $("text").value.trim(), bpm: Number($("bpm").value), voice_id: $("voice").value.trim(),
    alternate_voice_id: $("alternate").value.trim(), delivery: $("delivery").value,
    robot_style: $("robot-style").value, robot_amount: Number($("robot-amount").value) / 100, robot_tone_hz: Number($("robot-tone").value),
    robot_key: musicalKey($("robot-key").value), robot_scale: musicalScale($("robot-scale").value),
    robot_melody: melodyMode($("robot-melody").value), robot_octave: melodyOctave($("robot-octave").value), robot_note_beats: noteBeats($("robot-note-beats").value),
    robot_rhythm: rhythmMode($("robot-rhythm").value) });
  const matchingSource = (key, settings = draft()) => selected === experiment?.id && experiment?.sources?.[key]?.state === "complete" &&
    settings.text === experiment.text && (settings.voice_id || defaultVoice) === experiment.voice_id && (key === "flash" || settings.delivery === experiment.delivery);
  const seconds = value => Number.isFinite(value) && value >= 0 ? `${value < 10 ? value.toFixed(2) : value.toFixed(1)} s` : "";
  function timingText(timings = {}) {
    return [timings.source_reused ? "Saved voice" : seconds(timings.source_seconds) ? `Voice ${seconds(timings.source_seconds)}` : "",
      seconds(timings.processing_seconds) ? `Processing ${seconds(timings.processing_seconds)}` : "",
      seconds(timings.ready_seconds) ? `Ready in ${seconds(timings.ready_seconds)}` : ""].filter(Boolean).join(" · ");
  }
  async function request(path, body, signal = controller?.signal) {
    const response = await fetch(`/api/rap-experiment${path}`, { method: body ? "POST" : "GET", signal,
      headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || "The experiment could not be loaded."), { status: response.status });
    return result;
  }
  function status(message, error = false) { $("status").textContent = message; $("status").classList.toggle("is-error", error); }
  function getState() { return initialized ? { ...draft(), experiment_id: selected, pending,
    metronome: $("metronome").checked, volume: Number($("volume").value) } : {}; }
  function flush({ strict = false } = {}) {
    if (!initialized) return;
    try { localStorage.setItem(KEY, JSON.stringify(getState())); }
    catch (error) { if (strict) throw error; }
    onSave();
  }
  function setDraft(value = {}) {
    $("text").value = typeof value.text === "string" ? value.text.slice(0, 1000) : DEFAULT_TEXT;
    $("bpm").value = Number.isFinite(Number(value.bpm)) && Number(value.bpm) >= 40 && Number(value.bpm) <= 240 ? Number(value.bpm) : 100;
    $("voice").value = typeof value.voice_id === "string" ? value.voice_id.slice(0, 80) : "";
    $("alternate").value = typeof value.alternate_voice_id === "string" ? value.alternate_voice_id.slice(0, 80) : "";
    $("delivery").value = ["punchy", "relaxed", "gritty"].includes(value.delivery) ? value.delivery : "punchy";
    $("robot-style").value = ["autotune", "metallic", "radio"].includes(value.robot_style) ? value.robot_style : "autotune";
    $("robot-amount").value = Number.isFinite(value.robot_amount) ? Math.max(0, Math.min(100, value.robot_amount * 100)) : 100;
    $("robot-tone").value = Number.isFinite(value.robot_tone_hz) ? Math.max(800, Math.min(8000, value.robot_tone_hz)) : 6000;
    $("robot-key").value = String(musicalKey(value.robot_key));
    $("robot-scale").value = musicalScale(value.robot_scale);
    $("robot-melody").value = melodyMode(value.robot_melody);
    $("robot-octave").value = String(melodyOctave(value.robot_octave));
    $("robot-note-beats").value = String(noteBeats(value.robot_note_beats));
    $("robot-rhythm").value = rhythmMode(value.robot_rhythm);
    manualVoice = manualAlternate = false; renderVoices();
  }
  function restore(value = {}) {
    if (!initialized) return;
    stop(); clearTimeout(poll); controller?.abort(); controller = new AbortController(); ++run;
    setDraft(value); selected = typeof value.experiment_id === "string" ? value.experiment_id : "";
    pending = value.pending?.request_id && typeof value.pending.request_id === "string" ? value.pending : null;
    $("metronome").checked = value.metronome === true;
    $("volume").value = Number.isFinite(value.volume) ? Math.max(0, Math.min(1, value.volume)) : 0.8;
    experiment = null; busy = false; adoptLatestDraft = !value.text; render(); flush();
    if (active) void load(run);
  }
  function renderVoices() {
    for (const [field, forced, id] of [["voice", manualVoice, defaultVoice], ["alternate", manualAlternate, alternateVoice]]) {
      const value = $(field).value.trim(), known = voices.some(voice => voice.voice_id === value), name = voices.find(voice => voice.voice_id === id)?.name;
      $(`${field}-select`).innerHTML = `<option value="">${escape(name ? `Default · ${name}` : field === "alternate" ? "Default alternate voice" : "Default voice")}</option>` +
        voices.map(voice => `<option value="${escape(voice.voice_id)}">${escape(voice.name)}</option>`).join("") + '<option value="__custom__">Custom voice ID…</option>';
      $(`${field}-select`).value = !forced && value === id ? "" : forced || value && !known ? "__custom__" : value;
      $(`${field}-custom`).hidden = $(`${field}-select`).value !== "__custom__";
    }
  }
  function renderSaved() {
    const known = experiments.some(item => item.id === selected);
    const option = item => {
      const title = typeof item.text === "string" ? item.text.split("\n")[0].slice(0, 60) : "Rap comparison";
      const date = item.created_at ? new Date(item.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : item.id.slice(0, 8);
      const variants = item.variants || item.examples?.map(example => example.id || example.variant) || [];
      const style = robotLabel(item);
      const fastLabel = fastJob(item) ? variants.includes("robot") ? variants.includes("flash") ? `Fast + ${style}` : `Robot · ${style}` : "Fast clean" : "";
      const name = variants.length === 1 && variants[0] === "music" ? "" : voiceLabel(item.voice_id);
      const rhythm = rhythmMode(item.robot_rhythm);
      const label = fastLabel ? [name, fastLabel, rhythm === "natural" ? "" : RHYTHMS[rhythm], title] : [title, name];
      const auditionLabel = typeof item.audition_label === "string" ? item.audition_label.trim().slice(0, 120) : "";
      const unavailableLabel = unavailableAudition(item) ? `Unavailable · ${voiceLabel(item.voice_id) || "Voice"}` : "";
      return `<option value="${escape(item.id)}">${escape(unavailableLabel || auditionLabel || `${label.filter(Boolean).join(" · ")} · ${item.bpm || 100} BPM · ${date}`)}</option>`;
    };
    const groups = AUDITION_GROUPS.map(([id, title]) => [title, experiments.filter(item => item.audition_group === id && !unavailableAudition(item))
      .sort((a, b) => String(a.audition_label || "").localeCompare(String(b.audition_label || ""), undefined, { numeric: true, sensitivity: "base" }))]);
    groups.push(["Other comparisons", experiments.filter(item => unavailableAudition(item) || !AUDITION_GROUPS.some(([id]) => id === item.audition_group))]);
    savedOrder = groups.flatMap(([, items]) => items.map(item => item.id));
    $("saved").innerHTML = '<option value="">Choose a saved comparison…</option>' + groups.filter(([, items]) => items.length)
      .map(([title, items]) => `<optgroup label="${escape(title)}">${items.map(option).join("")}</optgroup>`).join("") +
      (selected && !known ? `<option value="${escape(selected)}">Current comparison · ${escape(selected.slice(0, 8))}</option>` : "");
    $("saved").value = selected;
    renderNavigation();
  }
  function renderNavigation() {
    const index = savedOrder.indexOf(selected);
    $("saved").disabled = !!pending;
    $("previous").disabled = !!pending || index <= 0;
    $("next").disabled = !!pending || index < 0 || index >= savedOrder.length - 1;
  }
  function selectExperiment(id) {
    if (!active || pending) { $("saved").value = selected; return; }
    stop(); clearTimeout(poll); controller?.abort(); controller = new AbortController(); const token = ++run;
    selected = id; experiment = null; busy = false; renderSaved(); render(); flush();
    if (selected) void check(selected, token, true);
  }
  function browse(offset) {
    const index = savedOrder.indexOf(selected), next = index + offset;
    if (index >= 0 && next >= 0 && next < savedOrder.length) selectExperiment(savedOrder[next]);
  }
  function render() {
    if (!initialized) return;
    renderNavigation();
    const invalid = !$("text").value.trim() || !Number.isFinite(Number($("bpm").value)) || Number($("bpm").value) < 40 || Number($("bpm").value) > 240;
    const pendingFast = pending?.variants?.some(id => ["flash", "robot"].includes(id));
    $("generate").disabled = busy || (!pending && invalid) || !!pendingFast;
    $("generate").textContent = pending && !pendingFast ? "Recover comparison" : "Generate all eight comparisons";
    $("fast").disabled = busy && (!!pending || !experiment || fastJob(experiment)) || (!pending && invalid) || !!pending && !pendingFast;
    $("fast").textContent = pendingFast ? "Recover fast voice" : "Generate fast voice";
    $("apply-robot").disabled = busy || !!pending || invalid || !matchingSource("flash");
    $("robot-amount-value").textContent = `${Math.round(Number($("robot-amount").value))}%`;
    $("robot-tone-value").textContent = `${(Number($("robot-tone").value) / 1000).toFixed(1)} kHz`;
    $("tuning-controls").hidden = $("robot-style").value !== "autotune";
    $("melody-controls").hidden = $("robot-style").value !== "autotune" || $("robot-melody").value === "follow";
    $("chromatic-label").textContent = $("robot-melody").value === "follow" ? "Chromatic" : "Chromatic (major melody)";
    $("robot-help").textContent = matchingSource("flash") ? "Apply effects reuses this recording without generating a new voice." : "Generate a fast voice to compare the clean and robot versions.";
    $("rhythm-help").textContent = ({ natural: "Keep the original speech rhythm.", phrases: "Start whole phrases on the beat.", flow: "Fit whole phrases to the beat." })[rhythmMode($("robot-rhythm").value)];
    $("stop").disabled = !playing && !starting;
    $("now").textContent = playing ? `Playing · ${VARIANTS.find(v => playing.startsWith(`${v[0]}:`))?.[1] || "Example"}${playing.endsWith(":full") ? " · Full mix" : ""}` : starting ? "Loading audio…" : "";
    const auditionLabel = typeof experiment?.audition_label === "string" ? experiment.audition_label.trim().slice(0, 120) : "";
    $("comparison").textContent = auditionLabel || (experiment ? `${experiment.bpm} BPM · ${experiment.text?.split("\n")[0] || "Saved comparison"}` : "Same lyrics. Eight approaches.");
    $("audition-meta").textContent = auditionLabel ? [AUDITION_GROUPS.find(([id]) => id === experiment.audition_group)?.[1], voiceLabel(experiment.voice_id), `${experiment.bpm} BPM`].filter(Boolean).join(" · ") : "";
    const examples = Array.isArray(experiment?.examples) ? experiment.examples : [];
    $("job-timing").textContent = experiment?.timings?.ready_seconds != null ? `Comparison ready in ${seconds(experiment.timings.ready_seconds)}` : "";
    const shown = experiment ? VARIANTS.filter(([id]) => examples.some(item => item.id === id || item.variant === id)) : VARIANTS.filter(([id]) => !["flash", "robot"].includes(id));
    $("cards").classList.toggle("rx-cards-fast", shown.length > 0 && shown.every(([id]) => ["flash", "robot"].includes(id)));
    $("cards").innerHTML = shown.map(([id, title, description], index) => {
      const example = examples.find(item => item.id === id || item.variant === id), url = audioURL(example?.audio_url), fullURL = audioURL(example?.full_mix_url);
      const key = `${id}:vocal`, current = playing === key || starting === key;
      const state = example?.state || (busy ? "waiting" : "unprepared");
      const readableState = ({ complete: "Ready", failed: "Unavailable", error: "Unavailable", unknown: "Interrupted", skipped: "Skipped", queued: "Queued", generating: "Generating", rendering: "Processing", waiting: "Waiting", unprepared: "Not generated" })[state] || state;
      const isFast = ["flash", "robot"].includes(id), rhythm = rhythmMode(example?.rhythm_mode ?? experiment?.robot_rhythm);
      const cardDescription = isFast && rhythm !== "natural" ? id === "flash" ? rhythm === "flow" ? "The clean recording, with whole phrases fitted to the beat." : "The clean recording, with whole phrase starts placed on beats." : "The same timed recording, shaped with robot voice effects." : example?.description || description;
      const notes = Array.isArray(example?.notes) ? example.notes.filter(n => typeof n === "string" && !n.startsWith("Playback levels are matched")) : [];
      if (id === "robot" && example?.robot?.style === "autotune" && example.robot.applied === true && Number.isFinite(example.robot.voiced_fraction) && example.robot.voiced_fraction >= 0 && example.robot.voiced_fraction < .15) {
        notes.push("Only a small part of this voice can be tuned; very low or unpitched sections stay unchanged.");
      }
      return `<article class="rx-card${current || playing === `${id}:full` ? " is-playing" : ""}" data-rx-card="${id}">
        <div class="rx-card-top"><span class="rx-number">${String(index + 1).padStart(2, "0")}</span><span class="rx-state${["failed", "error", "unknown"].includes(state) ? " is-error" : ""}">${escape(readableState)}</span></div>
        <h3>${escape(example?.title || title)}</h3><p class="rx-description">${escape(cardDescription)}</p>
        <p class="rx-meta">${escape([id === "music" ? null : voiceLabel(id === "alternate" ? experiment?.alternate_voice_id || alternateVoice : experiment?.voice_id), modelLabel(example?.model_id), example?.sample_rate ? `${example.sample_rate / 1000} kHz` : null, id === "robot" ? robotLabel(experiment) : null, isFast ? `Rhythm · ${RHYTHMS[rhythm]}` : null].filter(Boolean).join(" · "))}</p>
        ${timingText(example?.timings) ? `<p class="rx-timing">${escape(timingText(example.timings))}</p>` : ""}
        ${example?.error ? `<p class="rx-error">${escape(example.error)}</p>` : ""}
        ${notes.length ? `<p class="rx-notes">${notes.map(escape).join(" · ")}</p>` : ""}
        <div class="rx-card-actions"><button type="button" class="mm-button${current ? " mm-primary" : ""}" data-rx-play="${id}" ${url ? "" : "disabled"}>${current ? "■ Stop" : id === "music" ? "▶ Isolated vocals" : "▶ Play"}</button>
        ${url ? `<a class="rx-download" href="${escape(url)}" download>Download${id === "music" ? " vocals" : ""}</a>` : ""}</div>
        ${fullURL ? `<div class="rx-card-actions rx-full-mix"><button type="button" class="mm-button" data-rx-full="${id}">${playing === `${id}:full` || starting === `${id}:full` ? "■ Stop full mix" : "▶ Full mix"}</button><a class="rx-download" href="${escape(fullURL)}" download>Download mix</a></div>` : ""}
        <button type="button" class="rx-take" data-rx-take="${id}" ${busy || pending || id === "robot" && !matchingSource("flash") ? "disabled" : ""}>${example ? ["produced", "robot"].includes(id) ? "Apply effects" : ["phrases", "bars"].includes(id) ? "Apply timing" : "New take" : "Generate example"}</button></article>`;
    }).join("");
  }
  function reportExperiment() {
    if (!experiment) return;
    const examples = Array.isArray(experiment.examples) ? experiment.examples : [];
    const ready = examples.filter(item => item.audio_url && item.state === "complete").length;
    const failed = examples.filter(item => ["failed", "error", "unknown", "skipped"].includes(item.state)).length;
    if (!done(experiment.state)) status(`${ready} of ${examples.length || 8} examples ready. Preparing the remaining examples…`);
    else if (failed) status(`${ready} examples ready · ${failed} could not be completed. You can play the available examples or try a new take.`);
    else status(`${ready} examples ready. Choose an approach to listen.`);
  }
  function receive(value, token, fillDraft = false) {
    if (!active || token !== run) return;
    experiment = value; selected = value.id; busy = !done(value.state); pending = null;
    if (fillDraft) setDraft(value);
    const index = experiments.findIndex(item => item.id === value.id);
    if (index >= 0) experiments[index] = value; else experiments.unshift(value);
    renderSaved(); reportExperiment(); render(); flush(); clearTimeout(poll);
    if (busy) poll = setTimeout(() => check(selected, token), fastJob(value) ? 200 : 1500);
  }
  async function check(id, token, fillDraft = false) {
    try { receive(await request(`/experiments/${encodeURIComponent(id)}`), token, fillDraft); }
    catch (error) {
      if (active && token === run && error.name !== "AbortError") {
        status(`${error.message} Use Refresh to check again.`, true); busy = false; render();
      }
    }
  }
  async function load(token) {
    const results = await Promise.allSettled([request("/status"), request("/voices"), request("/experiments")]);
    if (!active || token !== run) return;
    const [service, catalog, saved] = results;
    if (service.status === "fulfilled") {
      defaultVoice = service.value.default_voice_id || ""; alternateVoice = service.value.alternate_voice_id || service.value.default_alternate_voice_id || "";
    }
    const validVoices = value => (Array.isArray(value) ? value : []).filter(voice => typeof voice?.voice_id === "string" && voice.voice_id && typeof voice.name === "string" && voice.name);
    const suggested = validVoices(service.status === "fulfilled" ? service.value.suggested_voices : []);
    const catalogVoices = validVoices(catalog.status === "fulfilled" ? catalog.value.voices : []);
    voices = Array.from(new Map([...suggested, ...catalogVoices].map(voice => [voice.voice_id, voice])).values()).slice(0, 300);
    if (catalog.status === "fulfilled") {
      defaultVoice = (service.status === "fulfilled" ? service.value.default_voice_id : "") || catalog.value.default_voice_id || defaultVoice;
      alternateVoice = catalog.value.alternate_voice_id || catalog.value.default_alternate_voice_id || alternateVoice;
    }
    renderVoices(); $("voice-status").textContent = catalogVoices.length ? "" : suggested.length ? "Suggested voices available. Use a custom voice ID for another voice." : "Voice list unavailable. Default voices and custom voice IDs still work.";
    if (saved.status === "fulfilled") {
      experiments = (Array.isArray(saved.value.experiments) ? saved.value.experiments : Array.isArray(saved.value) ? saved.value : []).filter(item => typeof item?.id === "string");
      if (!selected && !pending && experiments.length) selected = experiments[0].id;
      renderSaved();
    }
    if (pending) { status("A voice request needs checking. Use Recover to retrieve the same request."); render(); }
    else if (selected) { const fillDraft = adoptLatestDraft; adoptLatestDraft = false; await check(selected, token, fillDraft); }
    else if (saved.status === "rejected") status(saved.reason.message, true);
  }
  async function generate(variant) {
    if (!active || busy && !(variant === "fast" && !pending && experiment && !fastJob(experiment))) return;
    if (!pending && (!draft().text || !Number.isFinite(draft().bpm) || draft().bpm < 40 || draft().bpm > 240)) return;
    if (!pending && variant === "robot" && !matchingSource("flash")) return;
    stop(); clearTimeout(poll); busy = true;
    if (!pending) {
      const settings = draft();
      const sourceKey = variant === "robot" ? "flash" : variant === "phrases" ? "baseline" : ["bars", "produced"].includes(variant) ? "expressive" : null;
      const reusable = sourceKey && matchingSource(sourceKey, settings);
      pending = { ...settings, alternate_voice_id: settings.alternate_voice_id || alternateVoice || undefined, request_id: uid(),
        ...(variant ? { variants: variant === "fast" ? ["flash", "robot"] : [variant] } : {}),
        ...(reusable ? { source_experiment_id: selected, ...(variant === "robot" ? { include_clean: true } : {}) } : {}) };
    }
    const token = ++run; controller?.abort(); controller = new AbortController();
    status(pending.variants?.includes("flash") ? "Generating fast voice…" : pending.variants?.includes("robot") ? "Applying robot effects…" : "Preparing comparison…"); render(); flush();
    try { receive(await request("/experiments", pending), token); }
    catch (error) {
      if (!active || token !== run || error.name === "AbortError") return;
      busy = false;
      if ([400, 413, 422].includes(error.status)) pending = null;
      status(`${error.message}${pending ? " Use Recover to check the same request." : ""}`, true); render(); flush();
    }
  }
  function stopClicks() {
    clearInterval(metronomeTimer); metronomeTimer = null;
    for (const click of clicks) { try { click.oscillator.stop(); } catch (_) {} click.oscillator.disconnect(); click.gain.disconnect(); }
    clicks.clear();
  }
  function stop() {
    ++playRun; playing = starting = ""; stopClicks();
    if (source) { source.onended = null; try { source.stop(); } catch (_) {} source.disconnect(); source = null; }
    gain?.disconnect(); gain = null; if (initialized) render();
  }
  function scheduleClicks() {
    if (!context || !playing || !$("metronome").checked) return;
    while (nextClick < context.currentTime + 0.12) {
      if (nextClick >= context.currentTime) {
        const oscillator = context.createOscillator(), clickGain = context.createGain();
        oscillator.frequency.value = beat % 4 === 0 ? 1400 : 950;
        clickGain.gain.setValueAtTime(0.13, nextClick); clickGain.gain.exponentialRampToValueAtTime(0.001, nextClick + 0.045);
        oscillator.connect(clickGain); clickGain.connect(context.destination);
        const click = { oscillator, gain: clickGain }; clicks.add(click);
        oscillator.onended = () => { clicks.delete(click); oscillator.disconnect(); clickGain.disconnect(); };
        oscillator.start(nextClick); oscillator.stop(nextClick + 0.05);
      }
      nextClick += 60 / (experiment?.bpm || 100); beat++;
    }
  }
  async function play(id, full = false) {
    if (!active) return;
    const example = experiment?.examples?.find(item => item.id === id || item.variant === id), url = audioURL(full ? example?.full_mix_url : example?.audio_url);
    const key = `${id}:${full ? "full" : "vocal"}`;
    if (!url) return;
    if (playing === key || starting === key) { stop(); return; }
    stop(); starting = key; const token = playRun; render();
    try {
      context ||= new (globalThis.AudioContext || globalThis.webkitAudioContext)();
      await context.resume();
      const response = await fetch(url, { signal: controller?.signal });
      if (!response.ok) throw new Error("The example audio could not be loaded.");
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      if (!active || token !== playRun) return;
      source = context.createBufferSource(); source.buffer = buffer;
      gain = context.createGain(); gain.gain.value = Number($("volume").value); source.connect(gain); gain.connect(context.destination);
      const start = context.currentTime + 0.08, currentSource = source;
      source.onended = () => { if (source === currentSource) stop(); };
      starting = ""; playing = key; nextClick = start; beat = 0;
      source.start(start); scheduleClicks(); metronomeTimer = setInterval(scheduleClicks, 25); render();
    } catch (error) { if (token === playRun) { stop(); if (error.name !== "AbortError") status(error.message, true); } }
  }
  function init(options = {}) {
    if (initialized) return api;
    root = options.container || document.querySelector("#rap-experiment-workspace"); if (!root) return null;
    onSave = options.onSave || (() => {}); initialized = true; root.classList.add("mm-workspace", "rx-workspace");
    root.innerHTML = `<header class="mm-header"><div><div class="mm-eyebrow">Voice & rhythm</div><h1>Rap experiment</h1><p>Compare voices, delivery and timing with the same lyrics.</p></div></header>
      <section class="rx-direction" aria-labelledby="rx-direction-title"><div class="mm-section-heading"><h2 id="rx-direction-title">Lyrics & voice</h2></div>
      <label for="rx-text">Lyrics<textarea id="rx-text" data-rx-text maxlength="1000" rows="4"></textarea></label>
      <div class="rx-options"><label for="rx-bpm">Tempo · BPM<input id="rx-bpm" data-rx-bpm type="number" min="40" max="240" step="1"></label>
      <div><label for="rx-voice-select">Main voice<select id="rx-voice-select" data-rx-voice-select></select></label><label class="rx-custom" data-rx-voice-custom hidden for="rx-voice">Voice ID<input id="rx-voice" data-rx-voice maxlength="80" placeholder="ElevenLabs voice ID"></label></div>
      <div><label for="rx-alternate-select">Alternate voice<select id="rx-alternate-select" data-rx-alternate-select></select></label><label class="rx-custom" data-rx-alternate-custom hidden for="rx-alternate">Alternate voice ID<input id="rx-alternate" data-rx-alternate maxlength="80" placeholder="ElevenLabs voice ID"></label></div>
      <label for="rx-delivery">Expressive delivery<select id="rx-delivery" data-rx-delivery><option value="punchy">Punchy</option><option value="relaxed">Relaxed</option><option value="gritty">Gritty</option></select></label></div>
      <p class="rx-voice-status" data-rx-voice-status></p>
      <div class="rx-fast" aria-labelledby="rx-fast-title"><h2 id="rx-fast-title">Fast robot</h2>
      <div class="rx-robot-controls"><label for="rx-robot-style">Voice effect<select id="rx-robot-style" data-rx-robot-style><option value="autotune">Autotune</option><option value="metallic">Metallic</option><option value="radio">Radio</option></select></label>
      <label for="rx-robot-amount">Effect amount <output for="rx-robot-amount" data-rx-robot-amount-value>100%</output><input id="rx-robot-amount" data-rx-robot-amount type="range" min="0" max="100" step="1"></label>
      <label for="rx-robot-tone">Tone <output for="rx-robot-tone" data-rx-robot-tone-value>6.0 kHz</output><input id="rx-robot-tone" data-rx-robot-tone type="range" min="800" max="8000" step="100"></label></div>
      <div class="rx-rhythm-control"><label for="rx-robot-rhythm">Rhythm<select id="rx-robot-rhythm" data-rx-robot-rhythm aria-describedby="rx-rhythm-help">${Object.entries(RHYTHMS).map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label><p id="rx-rhythm-help" class="rx-robot-help" data-rx-rhythm-help></p></div>
      <div class="rx-tuning-controls" data-rx-tuning-controls hidden><label for="rx-robot-key">Key<select id="rx-robot-key" data-rx-robot-key>${NOTES.map((note, index) => `<option value="${index}">${note}</option>`).join("")}</select></label>
      <label for="rx-robot-scale">Scale<select id="rx-robot-scale" data-rx-robot-scale><option value="minor">Minor</option><option value="major">Major</option><option value="chromatic" data-rx-chromatic-label>Chromatic</option></select></label>
      <label class="rx-melody-select" for="rx-robot-melody">Melody<select id="rx-robot-melody" data-rx-robot-melody>${Object.entries(MELODIES).map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label>
      <div class="rx-melody-controls" data-rx-melody-controls hidden><label for="rx-robot-octave">Octave<select id="rx-robot-octave" data-rx-robot-octave>${[2, 3, 4, 5].map(octave => `<option value="${octave}">${octave}</option>`).join("")}</select></label>
      <label for="rx-robot-note-beats">Note speed<select id="rx-robot-note-beats" data-rx-robot-note-beats><option value="0.5">Every half beat</option><option value="1">Every beat</option><option value="2">Every 2 beats</option></select></label></div></div>
      <div class="rx-actions"><button type="button" class="mm-button mm-primary" data-rx-fast>Generate fast voice</button><button type="button" class="mm-button" data-rx-apply-robot disabled>Apply effects</button></div>
      <p class="rx-robot-help" data-rx-robot-help>Generate a fast voice to compare the clean and robot versions.</p></div>
      <div class="rx-actions"><button type="button" class="mm-button" data-rx-generate>Generate all eight comparisons</button><p class="rx-status" data-rx-status role="status">Generate examples or choose a saved comparison.</p></div></section>
      <div class="rx-listen"><div class="rx-saved-field"><label for="rx-saved">Saved comparisons</label><div class="rx-saved-row"><select id="rx-saved" data-rx-saved></select><button type="button" class="mm-button" data-rx-previous disabled>Previous</button><button type="button" class="mm-button" data-rx-next disabled>Next</button></div></div><button type="button" class="mm-button" data-rx-refresh>Refresh</button><label class="rx-check"><input type="checkbox" data-rx-metronome> Metronome</label><label class="rx-volume" for="rx-volume">Volume<input id="rx-volume" data-rx-volume type="range" min="0" max="1" step="0.01"></label><button type="button" class="mm-button" data-rx-stop disabled>■ Stop</button></div>
      <div class="rx-comparison-heading"><div><h2 data-rx-comparison>Same lyrics. Eight approaches.</h2><p class="rx-timing" data-rx-audition-meta></p><p class="rx-timing" data-rx-job-timing></p></div><span data-rx-now role="status"></span></div><div class="rx-cards" data-rx-cards></div>`;
    $("generate").addEventListener("click", () => generate());
    $("fast").addEventListener("click", () => generate("fast"));
    $("apply-robot").addEventListener("click", () => generate("robot"));
    $("stop").addEventListener("click", stop);
    $("refresh").addEventListener("click", () => { if (active) { clearTimeout(poll); void load(run); } });
    $("saved").addEventListener("change", () => selectExperiment($("saved").value));
    $("previous").addEventListener("click", () => browse(-1));
    $("next").addEventListener("click", () => browse(1));
    for (const field of ["text", "bpm", "delivery", "voice", "alternate"]) $(field).addEventListener(field === "delivery" ? "change" : "input", () => { adoptLatestDraft = false; render(); flush(); });
    for (const field of ["robot-style", "robot-amount", "robot-tone", "robot-key", "robot-scale", "robot-melody", "robot-octave", "robot-note-beats", "robot-rhythm"]) $(field).addEventListener(["robot-amount", "robot-tone"].includes(field) ? "input" : "change", () => { adoptLatestDraft = false; render(); flush(); });
    for (const field of ["voice", "alternate"]) $(`${field}-select`).addEventListener("change", () => {
      const custom = $(`${field}-select`).value === "__custom__";
      if (field === "voice") manualVoice = custom; else manualAlternate = custom;
      if (!custom) $(field).value = $(`${field}-select`).value;
      adoptLatestDraft = false; renderVoices(); render(); flush();
    });
    $("volume").addEventListener("input", () => { if (gain) gain.gain.setTargetAtTime(Number($("volume").value), context.currentTime, 0.015); flush(); });
    $("metronome").addEventListener("change", () => { if (!$("metronome").checked) stopClicks(); else if (playing) { scheduleClicks(); metronomeTimer = setInterval(scheduleClicks, 25); } flush(); });
    root.addEventListener("click", event => {
      const target = event.target.closest("[data-rx-play], [data-rx-full], [data-rx-take]"); if (!target || target.disabled) return;
      if (target.dataset.rxPlay) void play(target.dataset.rxPlay);
      else if (target.dataset.rxFull) void play(target.dataset.rxFull, true);
      else if (target.dataset.rxTake) void generate(target.dataset.rxTake);
    });
    let saved = options.saved;
    if (!saved) { try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (_) { saved = {}; } }
    restore(saved || {}); return api;
  }
  function activate() { if (!initialized) init(); if (!initialized || active) return; active = true; controller = new AbortController(); void load(++run); }
  function deactivate() { if (!initialized) return; active = false; ++run; stop(); clearTimeout(poll); controller?.abort(); busy = false; flush(); }
  const api = { init, activate, deactivate, getState, restore, flush };
  return api;
})();
