"use strict";

// Shares Connections inputs, while keeping the generated-audio transport independent.
globalThis.HydraElevenSource = (() => {
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const key = (source) => JSON.stringify([source.sourceKey, source.reducer, source.index || 0]);
  function prepareSeries(series) {
    const points = (series.points || []).filter((point) => finite(point[0]) && finite(point[1]));
    const duration = Math.max(0, Number(series.duration_seconds) || 0);
    const intervals = points.slice(1).map((point, i) => (point[0] - points[i][0]) * duration)
      .filter((value) => value > 0).sort((a, b) => a - b);
    const interval = intervals[Math.floor(intervals.length / 2)] || 0;
    return { ...series, points, maxGap: Math.max(0.5, interval * 3) };
  }
  function sample(series, absoluteTime) {
    const points = series.points;
    const elapsed = absoluteTime - series.start_time_seconds;
    const duration = series.duration_seconds;
    if (!points.length || !finite(elapsed) || elapsed < 0 || elapsed > duration) return null;
    if (!duration) return elapsed === 0 ? points[0][1] : null;
    const time = elapsed / duration;
    let low = 0, high = points.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (points[mid][0] < time) low = mid + 1;
      else high = mid;
    }
    const right = points[low], left = points[Math.max(0, low - 1)];
    if (Math.abs(right[0] - time) < 1e-9) return right[1];
    const span = right[0] - left[0];
    if (time < left[0] || span <= 0 || span * duration > series.maxGap) return null;
    return left[1] + (right[1] - left[1]) * (time - left[0]) / span;
  }
  function create({ getState, loadSeries, now = () => performance.now() }) {
    let prepared = new Map(), revision = null, origin = now(), start = 0, duration = 0, generation = 0;
    const revisionFor = (state) => `${state.sourceMode}|${state.recording?.id}|${state.selectionGeneration}|${state.liveGeneration}`;
    function describe() {
      const state = getState();
      const live = state.sourceMode === "live";
      return { mode: live ? "live" : "recording", label: live ? "Live RAPP stream" :
        state.recording ? `${state.recording.name} · replay` : "Choose an input in Connections",
      fields: state.fields || [] };
    }
    async function prepare(sources) {
      const token = ++generation, state = getState(), currentRevision = revisionFor(state);
      prepared = new Map(); revision = null;
      if (state.sourceMode === "live") {
        revision = currentRevision; origin = now(); return;
      }
      if (!state.recording) throw new Error("Choose a recording in Connections first.");
      const unique = new Map(sources.flatMap((source) => Array.isArray(source.sources) ? source.sources : [source]).slice(0, 96).map((source) => [key(source), source]));
      const loaded = await Promise.all([...unique].map(async ([id, source]) => [id, prepareSeries(await loadSeries(source))]));
      if (token !== generation || revisionFor(getState()) !== currentRevision) throw new Error("The Connections input changed while loading. Press Play again.");
      prepared = new Map(loaded);
      const starts = loaded.map(([, series]) => series.start_time_seconds).filter(finite);
      start = finite(state.recording.start_time_seconds) ? state.recording.start_time_seconds : Math.min(...starts);
      duration = Math.max(0, Number(state.recording.duration_seconds) || 0);
      if (!duration && loaded.length) duration = Math.max(...loaded.map(([, series]) => series.end_time_seconds - start));
      revision = currentRevision; origin = now();
    }
    function read(source, at = now()) {
      const state = getState();
      if (state.sourceMode === "live") {
        if (state.liveSocket?.readyState !== 1) return null;
        return state.live?.read(source, at, 3000) || null;
      }
      if (revision !== revisionFor(state)) return null;
      const series = prepared.get(key(source));
      if (!series) return null;
      const elapsed = Math.max(0, (at - origin) / 1000);
      const position = duration > 0 ? elapsed % duration : elapsed;
      const value = sample(series, start + position);
      return finite(value) ? { value, at, minimum: series.minimum, maximum: series.maximum } : null;
    }
    function bounds(source) {
      const state = getState();
      if (state.sourceMode === "live" || revision !== revisionFor(state)) return null;
      const series = prepared.get(key(source));
      return series ? { minimum: series.minimum, maximum: series.maximum } : null;
    }
    return { describe, prepare, read, bounds, resetRange(source) { getState().live?.resetRange?.(source); }, reset(at = now()) { origin = at; } };
  }
  return { create, sample, prepareSeries };
})();
