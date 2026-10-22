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
  // ENACT/RAPP skeleton frames use ZED BODY_18, in metres: X forward, Y left, Z up.
  const SKELETON_JOINTS = ["nose", "neck", "right_shoulder", "right_elbow", "right_wrist",
    "left_shoulder", "left_elbow", "left_wrist", "right_hip", "right_knee", "right_ankle",
    "left_hip", "left_knee", "left_ankle", "right_eye", "left_eye", "right_ear", "left_ear"];
  const SKELETON_AXES = [["x", "forward"], ["y", "left"], ["z", "up"]];
  const SKELETON_REGIONS = [
    ["whole_body", "Whole body", SKELETON_JOINTS.map((_, index) => index)],
    ["head", "Head", [0, 14, 15, 16, 17]], ["torso", "Torso", [1, 2, 5, 8, 11]],
    ["left_arm", "Left arm", [5, 6, 7]], ["right_arm", "Right arm", [2, 3, 4]],
    ["left_leg", "Left leg", [11, 12, 13]], ["right_leg", "Right leg", [8, 9, 10]]
  ];
  const SKELETON_FIELDS = new Map(SKELETON_JOINTS.flatMap((joint, jointIndex) => SKELETON_AXES.map(([axis, direction], axisIndex) => {
    const name = `${display(joint).replace(/^./, letter => letter.toUpperCase())} ${axis.toUpperCase()} (${direction})`;
    return [`skeleton:${joint}:${axis}`, { name, joint, axis, jointIndex, index: jointIndex * 3 + axisIndex }];
  })));
  function isSkeleton(frame) {
    if (frame.channel !== "skeleton" || !Array.isArray(frame.data)) return false;
    if (Object.hasOwn(frame, "shape") && !(Array.isArray(frame.shape) &&
      (frame.shape.length === 1 && frame.shape[0] === 54 || frame.shape.length === 2 && frame.shape[0] === 18 && frame.shape[1] === 3))) return false;
    return frame.data.length === 54 && frame.data.every(value => !Array.isArray(value)) ||
      frame.data.length === 18 && frame.data.every(joint => Array.isArray(joint) && joint.length === 3 && joint.every(value => !Array.isArray(value)));
  }
  function skeletonJoint(values, index) {
    const joint = values?.slice(index * 3, index * 3 + 3);
    return joint?.length === 3 && joint.every(finite) && joint.some(value => value !== 0) ? joint : null;
  }
  function skeletonMotion(frame, values, now, previous) {
    const clock = finite(frame.t_recv) ? "t_recv" : finite(frame.stamp) ? "stamp" : "receipt";
    const time = clock === "receipt" ? now / 1000 : frame[clock];
    const joints = SKELETON_JOINTS.map((_, index) => skeletonJoint(values, index));
    const before = finite(previous?.at) && now - previous.at <= 500 ? previous.skeletonMotion : null;
    const elapsed = before?.clock === clock ? time - before.time : null;
    let baseline = { time, clock, joints };
    const motion = new Map();
    // Coalesced delivery must not turn sub-millisecond intervals into huge
    // speeds. Keep the older baseline, while forgetting joints lost meanwhile.
    if (elapsed > 0 && elapsed < 0.001) {
      baseline = { ...before, joints: before.joints.map((joint, index) => joints[index] ? joint : null) };
    } else if (elapsed >= 0.001 && elapsed <= 0.5) {
      const speeds = joints.map((joint, index) => {
        const old = before.joints[index];
        if (!joint || !old) return null;
        const speed = Math.hypot(...joint.map((value, axis) => value - old[axis])) / elapsed;
        return finite(speed) ? speed : null;
      });
      speeds.forEach((speed, index) => motion.set(`skeleton:${SKELETON_JOINTS[index]}:speed`, speed));
      for (const [id, , members] of SKELETON_REGIONS) {
        const tracked = members.map(index => speeds[index]).filter(finite);
        motion.set(`skeleton:region:${id}:speed`, tracked.length ? tracked.reduce((sum, speed) => sum + speed / tracked.length, 0) : null);
      }
    }
    return { baseline, motion };
  }
  function recordFrame(frame, arrays, now, revision, result) {
    if (!globalThis.HydraStudy?.emit) return;
    try {
      const frameId = `${frame.channel}:${revision}:${now}`;
      const scalar = value => finite(value) || typeof value === "boolean" ? value : typeof value === "string" ? value.slice(0, 160) : null;
      globalThis.HydraStudy.emit("live.input.frame", { frame_id: frameId, channel: frame.channel, revision, received_performance_ms: now,
        timestamp: scalar(frame.timestamp), time: scalar(frame.time), sequence: scalar(frame.sequence),
        labels: Array.isArray(frame.labels) ? frame.labels.slice(0, 256).map(fieldLabel) : [], labels_truncated: Array.isArray(frame.labels) && frame.labels.length > 256,
        arrays: [...arrays].map(([key, values]) => ({ key, value_count: values.length,
          shape: key === "data" && Array.isArray(frame.shape) ? frame.shape.slice(0, 8).map(scalar)
            : key.startsWith("tensor:") && Array.isArray(frame.tensors?.[key.slice(7)]?.shape) ? frame.tensors[key.slice(7)].shape.slice(0, 8).map(scalar) : null })),
        result, encoding: "flattened_numeric_chunks", chunk_size: 512 });
      // Preserve every validated numeric value; chunking bounds each event
      // without reducing the incoming frame rate or sampling the signals.
      for (const [key, values] of arrays) for (let offset = 0; offset < values.length; offset += 512) {
        globalThis.HydraStudy.emit("live.input.values", { frame_id: frameId, channel: frame.channel, revision, received_performance_ms: now,
          array_key: key, offset, values: values.slice(offset, offset + 512).map(value => finite(value) ? value : null) });
      }
    } catch (_) { /* Recording must not interrupt live movement processing. */ }
  }
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
      const reject = (reason) => {
        this.invalid++; this.lastResult = { accepted: false, kind: "invalid", reason };
        // A rejected skeleton frame cannot become a bridge across lost tracking.
        const previous = frame?.channel === "skeleton" && this.channels.get("skeleton");
        if (previous) previous.skeletonMotion = null;
        try { globalThis.HydraStudy?.emit?.("live.input.rejected", { reason, channel: typeof frame?.channel === "string" ? frame.channel.slice(0, 160) : null,
          received_performance_ms: finite(now) ? now : null, invalid_count: this.invalid }); } catch (_) {}
        return false;
      };
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
      const channel = { arrays, at: now, revision: (previous?.revision || 0) + 1, skeleton: isSkeleton(frame) };
      if (channel.skeleton) {
        const { baseline, motion } = skeletonMotion(frame, arrays.get("data"), now, previous);
        channel.skeletonMotion = baseline; channel.motion = motion;
      }
      this.channels.set(channelId, channel); this.lastAt = now; this.frames++;
      let discovered = false;
      const add = (fieldId, name, kind, indexed = false, metadata = {}) => {
        const key = `${encodeURIComponent(channelId)}|${encodeURIComponent(fieldId)}`;
        const existing = this.fieldIndex.get(key);
        if (existing) {
          if (Object.entries(metadata).some(([name, value]) => existing[name] !== value)) {
            Object.assign(existing, metadata); discovered = true;
          }
          return;
        }
        if (this.fieldIndex.size >= 256) { fieldLimitReached = true; return; }
        const reducers = indexed ? ["value"] : REDUCERS;
        this.fieldIndex.set(key, { key, id: fieldId, fieldId, name, kind, channelId,
          channelName: display(channelId), optionLabel: name, reducers, default_reducer: reducers[0], ...metadata });
        discovered = true;
      };
      for (const [key, values] of arrays) {
        const metadata = channel.skeleton && ["data", "velocity"].includes(key) ? { skeletonLevel: "raw" } : {};
        if (channel.skeleton && key === "data") add(key, "data", "array", false, metadata);
        if (["data", "velocity"].includes(key) && Array.isArray(frame.labels) && frame.labels.length === values.length) {
          if (values.length > 256) fieldLimitReached = true;
          values.slice(0, 256).forEach((_, index) => add(`${key}:${index}`, `${fieldLabel(frame.labels[index], index)} ${key === "data" ? "position" : "velocity"}`, key === "data" ? "position" : "velocity", true, metadata));
        } else add(key, display(key.replace(/^tensor:/, "")), key.startsWith("tensor:") ? "tensor" : "array", false, metadata);
      }
      if (channel.skeleton) {
        for (const [id, name] of SKELETON_REGIONS) {
          add(`skeleton:region:${id}:speed`, `${name} movement`, "motion", true, {
            skeletonLevel: "region", label: `${name} movement`, unit: "m/s",
            description: "Average XYZ movement speed across the region’s tracked joints." });
        }
        for (const joint of SKELETON_JOINTS) {
          const name = `${display(joint).replace(/^./, letter => letter.toUpperCase())} movement`;
          add(`skeleton:${joint}:speed`, name, "motion", true, { skeletonLevel: "joint", label: name, joint, unit: "m/s",
            description: "Movement speed combines changes in X, Y and Z in metres per second." });
        }
        for (const [id, field] of SKELETON_FIELDS) {
          add(id, field.name, "position", true, { skeletonLevel: "axis", label: field.name, joint: field.joint, axis: field.axis, unit: "m" });
        }
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
      recordFrame(frame, arrays, now, channel.revision, this.lastResult);
      return discovered;
    }
    valueFor(source, field, channel) {
      if (field.kind === "motion" && field.skeletonLevel) return channel.motion?.get(field.fieldId) ?? null;
      const skeleton = SKELETON_FIELDS.get(field.fieldId);
      if (skeleton) {
        if (!channel.skeleton) return null;
        const values = channel.arrays.get("data"), joint = skeletonJoint(values, skeleton.jointIndex);
        // RAPP sends zeroed or non-finite triples when a body joint is not tracked.
        if (!joint) return null;
        return values[skeleton.index];
      }
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
