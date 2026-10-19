"use strict";

// RAPP's live bridge and player.py both broadcast one JSON object per message.
globalThis.HydraLive = (() => {
  const REDUCERS = ["mean", "rms", "minimum", "maximum", "index"];
  const MAX_VALUES = 262144;
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const sourceId = (source) => `${source.sourceKey}|${source.reducer}|${source.index}`;
  const display = (value) => value.replaceAll("_", " ").replaceAll("-", " ");
  const fieldLabel = (value, index) => ["string", "number", "boolean"].includes(typeof value)
    ? String(value).slice(0, 80) : `Input ${index + 1}`;
  function flatten(raw) {
    if (!Array.isArray(raw)) return null;
    const values = [];
    const stack = [{ items: raw, index: 0 }];
    while (stack.length) {
      const top = stack.at(-1);
      if (top.index >= top.items.length) { stack.pop(); continue; }
      const item = top.items[top.index++];
      if (Array.isArray(item)) {
        if (stack.length >= 8) return null;
        stack.push({ items: item, index: 0 });
      } else values.push(finite(item) ? item : NaN);
      if (values.length > MAX_VALUES) return null;
    }
    return values;
  }
  function reduce(values, reducer, index = 0) {
    if (!values) return null;
    if (reducer === "index") return finite(values[index]) ? values[index] : null;
    let count = 0, sum = 0, squares = 0, minimum = Infinity, maximum = -Infinity;
    for (const value of values) {
      if (!finite(value)) continue;
      count++; sum += value; squares += value * value;
      minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
    }
    if (!count) return null;
    const value = reducer === "minimum" ? minimum : reducer === "maximum" ? maximum
      : reducer === "rms" ? Math.sqrt(squares / count) : sum / count;
    return finite(value) ? value : null;
  }
  class Stream {
    constructor() { this.channels = new Map(); this.fieldIndex = new Map(); this.samples = new Map(); this.ranges = new Map(); this.lastAt = null; this.frames = 0; this.invalid = 0; this.lastResult = null; }
    ingest(frame, now) {
      const reject = (reason) => { this.invalid++; this.lastResult = { accepted: false, kind: "invalid", reason }; return false; };
      if (!finite(now) || !frame || typeof frame !== "object" || typeof frame.channel !== "string" || frame.channel.length > 160) return reject("shape");
      if (frame.channel === "__status__") { this.lastResult = { accepted: false, kind: "status" }; return false; }
      const channelId = frame.channel;
      // JSON permits lone surrogate escapes, which cannot become URI-encoded source keys.
      try { encodeURIComponent(channelId); } catch (_) { return reject("shape"); }
      if (!this.channels.has(channelId) && this.channels.size >= 32) return reject("channel_limit");
      const arrays = new Map();
      let size = 0, fieldLimitReached = false;
      for (const key of ["data", "velocity"]) {
        if (Array.isArray(frame[key])) { const values = flatten(frame[key]); if (!values) return reject("array_limit"); arrays.set(key, values); size += values.length; }
      }
      if (frame.tensors && typeof frame.tensors === "object") {
        const tensors = Object.entries(frame.tensors);
        if (tensors.length > 256) fieldLimitReached = true;
        for (const [name, tensor] of tensors.slice(0, 256)) {
          if (name.length > 160 || !Array.isArray(tensor?.data)) continue;
          try { encodeURIComponent(name); } catch (_) { return reject("shape"); }
          const values = flatten(tensor.data);
          if (!values) return reject("array_limit");
          arrays.set(`tensor:${name}`, values); size += values.length;
        }
      }
      if (!size) return reject("no_values");
      if (size > MAX_VALUES) return reject("value_limit");
      const previous = this.channels.get(channelId);
      if (previous && now < previous.at) return reject("out_of_order");
      const channel = { arrays, at: now, revision: (previous?.revision || 0) + 1 };
      this.channels.set(channelId, channel); this.lastAt = now; this.frames++;
      let discovered = false;
      const add = (fieldId, name, kind, indexed = false) => {
        const key = `${encodeURIComponent(channelId)}|${encodeURIComponent(fieldId)}`;
        if (this.fieldIndex.has(key)) return;
        if (this.fieldIndex.size >= 256) { fieldLimitReached = true; return; }
        const reducers = indexed ? ["value"] : REDUCERS;
        this.fieldIndex.set(key, { key, id: fieldId, fieldId, name, kind, channelId,
          channelName: display(channelId), optionLabel: name, reducers, default_reducer: reducers[0] });
        discovered = true;
      };
      for (const [key, values] of arrays) {
        if (["data", "velocity"].includes(key) && Array.isArray(frame.labels) && frame.labels.length === values.length) {
          if (values.length > 256) fieldLimitReached = true;
          values.slice(0, 256).forEach((_, index) => add(`${key}:${index}`, `${fieldLabel(frame.labels[index], index)} ${key === "data" ? "position" : "velocity"}`, key === "data" ? "position" : "velocity", true));
        } else add(key, display(key.replace(/^tensor:/, "")), key.startsWith("tensor:") ? "tensor" : "array");
      }
      // Learn every incoming frame for registered mapping inputs, even between UI/audio ticks.
      const reductions = new Map();
      for (const [source, range] of this.ranges) {
        const field = this.fieldIndex.get(source.sourceKey);
        if (source.rangeMode === "fixed" || range.key !== sourceId(source) || field?.channelId !== channelId) continue;
        if (!reductions.has(range.key)) reductions.set(range.key, this.valueFor(source, field, channel));
        const value = reductions.get(range.key);
        if (value !== null) this.learn(source, value, channel.revision);
      }
      this.lastResult = { accepted: true, kind: "data", channelId, discovered, fieldLimitReached };
      return discovered;
    }
    valueFor(source, field, channel) {
      const indexed = /^(data|velocity):\d+$/.exec(field.fieldId);
      const base = indexed ? field.fieldId.split(":")[0] : field.fieldId;
      const index = indexed ? Number(field.fieldId.split(":")[1]) : source.index;
      return reduce(channel.arrays.get(base), indexed ? "index" : source.reducer, index);
    }
    learn(source, value, revision) {
      const key = sourceId(source);
      let range = this.ranges.get(source);
      if (!range || range.key !== key) {
        if (this.ranges.size >= 512) this.ranges.delete(this.ranges.keys().next().value);
        range = { key, minimum: value, maximum: value, revision };
        this.ranges.set(source, range);
      } else if (source.rangeMode !== "fixed" && range.revision !== revision) {
        range.minimum = Math.min(range.minimum, value); range.maximum = Math.max(range.maximum, value);
        range.revision = revision;
      }
      return range;
    }
    read(source, now, timeout = 3000) {
      const field = this.fieldIndex.get(source.sourceKey);
      const channel = field && this.channels.get(field.channelId);
      if (!finite(now) || !channel || now < channel.at || now - channel.at > timeout) return null;
      const key = sourceId(source);
      let sample = this.samples.get(key);
      if (!sample || sample.revision !== channel.revision) {
        const value = this.valueFor(source, field, channel);
        if (value === null) return null;
        if (!sample) {
          if (this.samples.size >= 512) this.samples.delete(this.samples.keys().next().value);
          sample = { minimum: value, maximum: value, points: [] };
        }
        sample = { ...sample, value, revision: channel.revision, at: channel.at,
          minimum: Math.min(sample.minimum, value), maximum: Math.max(sample.maximum, value) };
        sample.points.push([now, value]);
        if (sample.points.length > 256) sample.points.shift();
        this.samples.set(key, sample);
      }
      // Explicit mapping range modes belong to each input; legacy readers retain shared history.
      const range = source.rangeMode ? this.learn(source, sample.value, channel.revision) : sample;
      const minimum = source.rangeMode === "fixed" ? Number(source.inputMin) : range.minimum;
      const maximum = source.rangeMode === "fixed" ? Number(source.inputMax) : range.maximum;
      if (!finite(minimum) || !finite(maximum) || (source.rangeMode === "fixed" && maximum <= minimum)) return null;
      const normalized = maximum > minimum ? Math.max(0, Math.min(1, (sample.value - minimum) / (maximum - minimum))) : 0.5;
      return { ...sample, minimum, maximum, normalized };
    }
    getRange(source) {
      const range = this.ranges.get(source);
      return range?.key === sourceId(source) ? { minimum: range.minimum, maximum: range.maximum } : null;
    }
    resetRange(source) { this.ranges.delete(source); }
    resetRanges() { this.samples.clear(); this.ranges.clear(); }
    get fields() { return [...this.fieldIndex.values()]; }
  }
  return { Stream, reduce, flatten };
})();
