"use strict";

// Observes received frames without registering mapping inputs or learning their ranges.
globalThis.HydraLiveMonitorModel = (() => {
  const MAX_TEXT = 12 * 1024, MAX_FRAME = 8 * 1024 * 1024;
  const MAX_EVENTS = 40, MAX_POINTS = 120, MAX_RATE_BUCKETS = 21;
  const TIMEOUT = 3000, WINDOW = 2000;
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const age = (now, at) => finite(at) ? Math.max(0, now - at) : null;
  const label = (value) => String(value).replaceAll("_", " ").replaceAll("-", " ");
  const boundedText = (value, length = 400) => ["string", "number", "boolean"].includes(typeof value)
    ? String(value).slice(0, length) : "";
  const emptyCounts = () => ({ messages: 0, dataFrames: 0, statusFrames: 0, invalidFrames: 0,
    binaryFrames: 0, oversizedFrames: 0, invalidJsonFrames: 0, invalidShapeFrames: 0,
    noNumericFrames: 0, limitFrames: 0, reconnections: 0 });
  const reasons = {
    binary: "Binary message ignored. Send one JSON object as a WebSocket text message.",
    oversized: "Message exceeds the 8 MiB text limit. Send smaller frames.",
    json: "Invalid JSON ignored. Send one complete JSON object per message.",
    shape: "Message needs a string channel and numeric arrays in data, velocity or tensors.",
    no_values: "No array values found. Use data: [number, ...], velocity, or tensors[name].data.",
    no_numeric: "Arrays contain no finite numbers. Use numeric JSON values, not strings or null.",
    channel_limit: "Channel limit reached: at most 32 channels can be received per connection.",
    array_limit: "Array limit reached: use at most eight nested levels and 262,144 values per frame.",
    value_limit: "Frame exceeds 262,144 values across its arrays. Send smaller frames.",
    out_of_order: "Frame received with an older local timestamp and ignored.",
    field_limit: "Field limit reached: only the first 256 fields are available for mapping."
  };

  function create() {
    let url = "", state = "disconnected", startedAt = null, connectedAt = null, retryAt = null;
    let lastMessageAt = null, lastDataAt = null, lastProblem = null, lastProblemAt = null, lastConnectionProblem = null;
    let counts = emptyCounts(), raw = null, events = [], rates = [], channelInfo = new Map(), fields = new Map();
    let hasOpened = false, connectionHasMessage = false, connectionHasData = false;

    function event(now, level, message) {
      const previous = events.at(-1);
      if (previous?.level === level && previous.message === message) { previous.at = now; previous.count++; }
      else { events.push({ at: now, level, message, count: 1 }); if (events.length > MAX_EVENTS) events.shift(); }
    }

    function reset(options = {}) {
      url = boundedText(options.url, 2048); startedAt = finite(options.now) ? options.now : null;
      state = "disconnected"; connectedAt = retryAt = lastMessageAt = lastDataAt = lastProblemAt = null;
      lastProblem = lastConnectionProblem = raw = null; counts = emptyCounts(); events = []; rates = [];
      channelInfo.clear(); fields.clear(); hasOpened = connectionHasMessage = connectionHasData = false;
    }

    function connection(options = {}) {
      const now = finite(options.now) ? options.now : 0;
      if (options.url !== undefined) url = boundedText(options.url, 2048);
      if (startedAt === null) startedAt = now;
      state = options.state || "disconnected";
      retryAt = finite(options.retryAt) ? options.retryAt : null;
      if (state === "connecting") {
        lastConnectionProblem = null;
        connectionHasMessage = connectionHasData = false;
        for (const field of fields.values()) { field.current = false; field.points = []; }
        rates = [];
        event(now, "info", hasOpened ? "Reconnecting to the stream" : "Connecting to the stream");
      } else if (state === "open") {
        lastConnectionProblem = null;
        if (hasOpened) counts.reconnections++;
        hasOpened = true; connectedAt = now;
        connectionHasMessage = connectionHasData = false;
        for (const field of fields.values()) { field.current = false; field.points = []; }
        rates = [];
        event(now, "good", "Connection opened");
      } else if (state === "closed") {
        const code = finite(options.code) ? ` (${options.code})` : "";
        const reason = options.reason ? `: ${boundedText(options.reason, 200)}` : "";
        event(now, "warning", `Connection closed${code}${reason}`);
      } else if (state === "error") { lastConnectionProblem = "error"; event(now, "error", "Connection error: check the server, address and browser permissions"); }
      else if (state === "timeout") { lastConnectionProblem = "timeout"; event(now, "error", "Connection timed out after 10 seconds"); }
      else { lastConnectionProblem = null; event(now, "info", "Disconnected from the stream"); }
    }

    function reject(stream, kind, now) {
      stream.invalid++;
      stream.lastResult = { accepted: false, kind: "invalid", reason: kind };
      counts.invalidFrames++;
      if (kind === "binary") counts.binaryFrames++;
      if (kind === "oversized") { counts.oversizedFrames++; counts.limitFrames++; }
      if (kind === "json") counts.invalidJsonFrames++;
      if (kind === "shape") counts.invalidShapeFrames++;
      lastProblem = kind; lastProblemAt = now;
      event(now, "warning", reasons[kind]);
      return false;
    }

    function summarize(values) {
      let count = 0, mean = 0, minimum = Infinity, maximum = -Infinity;
      for (const value of values) {
        if (!finite(value)) continue;
        count++;
        // Divide before adding to avoid overflow for large, finite array elements.
        mean = mean * ((count - 1) / count) + value / count;
        minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
      }
      return { count: values.length, numericCount: count, value: count && finite(mean) ? mean : null,
        currentMinimum: count ? minimum : null, currentMaximum: count ? maximum : null,
        preview: values.slice(0, 8).map((value) => finite(value) ? value : null) };
    }

    function observe(frame, stream, now) {
      const channel = stream.channels.get(frame.channel), summaries = new Map();
      let valueCount = 0, numericCount = 0;
      for (const [key, values] of channel.arrays) {
        const summary = summarize(values); summaries.set(key, summary);
        valueCount += summary.count; numericCount += summary.numericCount;
      }
      const first = summaries.get("data") || summaries.values().next().value;
      channelInfo.set(frame.channel, { id: frame.channel, name: label(frame.channel), at: now,
        valueCount, numericCount, numeric: numericCount > 0,
        shape: Array.isArray(frame.shape) ? frame.shape.slice(0, 8).map((value) => finite(value) ? value : null) : null,
        preview: first?.preview || [] });
      for (const field of stream.fieldIndex.values()) {
        if (field.channelId !== frame.channel) continue;
        const indexed = /^(data|velocity):(\d+)$/.exec(field.fieldId);
        const scalar = field.reducers?.length === 1 && field.reducers[0] === "value";
        const base = indexed ? indexed[1] : field.fieldId;
        let summary = summaries.get(base) || { value: null, count: 0, numericCount: 0, preview: [], currentMinimum: null, currentMaximum: null };
        if (scalar) {
          const value = stream.valueFor({ reducer: "value", index: 0 }, field, channel);
          summary = { value: finite(value) ? value : null, count: 1, numericCount: finite(value) ? 1 : 0,
            preview: [finite(value) ? value : null], currentMinimum: finite(value) ? value : null, currentMaximum: finite(value) ? value : null };
        }
        const previous = fields.get(field.key);
        const points = previous?.points || [];
        if (summary.value !== null) {
          const bucket = Math.floor(now / 100);
          if (previous?.bucket === bucket && points.length) points[points.length - 1] = [now, summary.value];
          else { points.push([now, summary.value]); if (points.length > MAX_POINTS) points.shift(); }
        } else if (points.length) points.length = 0;
        fields.set(field.key, { key: field.key, channelId: field.channelId,
          name: field.fieldId === "data" ? "Data" : field.fieldId === "velocity" ? "Velocity" : field.name,
          kind: field.kind, reducer: scalar ? "value" : "mean", at: now, ...summary,
          minimum: summary.value === null ? previous?.minimum ?? null : Math.min(previous?.minimum ?? Infinity, summary.value),
          maximum: summary.value === null ? previous?.maximum ?? null : Math.max(previous?.maximum ?? -Infinity, summary.value),
          points, bucket: Math.floor(now / 100), current: true });
      }
      return numericCount > 0;
    }

    function message(text, now, stream) {
      if (!stream || !finite(now)) return false;
      if (startedAt === null) startedAt = now;
      counts.messages++; lastMessageAt = now; connectionHasMessage = true;
      const bucket = Math.floor(now / 100);
      if (rates.at(-1)?.bucket === bucket) rates.at(-1).count++;
      else rates.push({ at: now, bucket, count: 1, data: 0 });
      while (rates.length > MAX_RATE_BUCKETS || rates.length && rates[0].at < now - WINDOW) rates.shift();
      if (typeof text !== "string") {
        raw = { text: "[Binary message]", at: now, bytes: finite(text?.size) ? text.size : finite(text?.byteLength) ? text.byteLength : null, truncated: false };
        return reject(stream, "binary", now);
      }
      raw = { text: text.slice(0, MAX_TEXT), at: now, length: text.length, bytes: null, truncated: text.length > MAX_TEXT };
      if (text.length > MAX_FRAME) return reject(stream, "oversized", now);
      let frame;
      try { frame = JSON.parse(text); } catch (_) { return reject(stream, "json", now); }
      let discovered;
      const previousInvalid = stream.invalid;
      try { discovered = stream.ingest(frame, now); }
      catch (_) { stream.invalid = previousInvalid; return reject(stream, "shape", now); }
      const result = stream.lastResult;
      if (result?.kind === "status") {
        counts.statusFrames++;
        const greeting = boundedText(frame.msg, 200) || boundedText(frame.message, 200) || "Server status received";
        event(now, "info", greeting);
      } else if (!result?.accepted) {
        const reason = result?.reason || "shape";
        counts.invalidFrames++;
        if (reason.endsWith("_limit")) counts.limitFrames++;
        else if (reason === "no_values") counts.noNumericFrames++;
        else counts.invalidShapeFrames++;
        lastProblem = reason; lastProblemAt = now;
        event(now, "warning", reasons[reason] || reasons.shape);
      } else if (observe(frame, stream, now)) {
        counts.dataFrames++; lastDataAt = now; connectionHasData = true; rates.at(-1).data++;
        if (result.fieldLimitReached) {
          lastProblem = "field_limit"; lastProblemAt = now; event(now, "warning", reasons.field_limit);
        }
      } else {
        counts.noNumericFrames++; lastProblem = "no_numeric"; lastProblemAt = now;
        event(now, "warning", reasons.no_numeric);
      }
      return discovered;
    }

    function fieldSnapshot(field, stream, now) {
      const channel = stream?.channels.get(field.channelId);
      const stale = state !== "open" || !field.current || !finite(channel?.at) || now - channel.at > TIMEOUT || field.value === null;
      const { points: _points, bucket: _bucket, current: _current, ...summary } = field;
      return { ...summary, preview: [...summary.preview], age: age(now, field.at), stale };
    }

    function diagnostic(context, channels, now) {
      if (context.sourceMode && context.sourceMode !== "live") return { level: "info", title: "Using recorded input", detail: "Select Live stream and connect to inspect incoming data." };
      if (state === "connecting") return { level: "info", title: "Connecting to the stream", detail: "Waiting for the WebSocket server to accept the connection." };
      if (state !== "open") {
        const retry = finite(Object.hasOwn(context, "retryAt") ? context.retryAt : retryAt) ? " Automatic reconnect is scheduled." : "";
        const failure = state === "error" || state === "timeout" ? state : lastConnectionProblem;
        if (failure) return { level: "error", title: failure === "timeout" ? "Connection timed out" : hasOpened ? "Connection lost" : "Could not connect", detail: "Check that the streaming server is running, the address and port are correct, and browser local-network access is allowed. The browser does not expose the exact network failure." + retry };
        return { level: "info", title: "Stream disconnected", detail: "Connect to receive live values." + retry };
      }
      if (!connectionHasMessage) return { level: "warning", title: "Connected, waiting for messages", detail: "The socket is open. Start playback or streaming on the sender; it must send one JSON object per text message." };
      if (!connectionHasData) return { level: "warning", title: "Connected, no numeric data", detail: lastProblem && lastProblemAt >= connectedAt ? reasons[lastProblem] : "Only status messages have arrived. Send channel and numeric data, velocity or tensor arrays." };
      if (lastDataAt === null || now - lastDataAt > TIMEOUT) return { level: "warning", title: "Data has stopped", detail: "No usable numeric frame has arrived for more than 3 seconds. Check the sender is still playing and the network is connected." };
      const stale = channels.filter((channel) => channel.stale);
      if (stale.length) return { level: "warning", title: "Some channels have stopped", detail: `${stale.map((channel) => channel.name).slice(0, 3).join(", ")}${stale.length > 3 ? ` and ${stale.length - 3} more` : ""} ${stale.length === 1 ? "has" : "have"} no fresh numeric data. Mappings using those channels wait for fresh values.` };
      if (lastProblem && now - lastProblemAt < TIMEOUT) return { level: "warning", title: "Data arriving with a warning", detail: reasons[lastProblem] };
      return { level: "good", title: "Live data is arriving", detail: "Numeric values are ready to use in either mixer." };
    }

    function snapshot(stream, now, context = {}) {
      const availableFields = [...fields.values()].map((field) => fieldSnapshot(field, stream, now));
      const channels = [...channelInfo.values()].map((channel) => {
        const received = stream?.channels.get(channel.id);
        return { ...channel, preview: [...channel.preview], age: age(now, channel.at),
          fieldCount: availableFields.filter((field) => field.channelId === channel.id).length,
          stale: state !== "open" || !connectionHasData || !finite(received?.at) || received.at < connectedAt || now - received.at > TIMEOUT || !channel.numeric };
      });
      const recent = rates.filter((item) => now - item.at <= WINDOW && item.at <= now);
      // A fixed two-second window is steady and remains meaningful at high stream rates.
      const rate = recent.reduce((sum, item) => sum + item.count, 0) / (WINDOW / 1000);
      const dataRate = recent.reduce((sum, item) => sum + item.data, 0) / (WINDOW / 1000);
      return { now, url: context.url || url, state, connected: state === "open", wanted: !!context.wanted,
        sourceMode: context.sourceMode || "live", status: context.status || "", startedAt, connectedAt,
        retryAt: Object.hasOwn(context, "retryAt") ? context.retryAt : retryAt, counts: { ...counts }, rate, dataRate,
        lastMessageAt, lastDataAt, messageAge: age(now, lastMessageAt), dataAge: age(now, lastDataAt),
        raw: raw && { ...raw }, channels, fields: availableFields, events: events.map((item) => ({ ...item })),
        diagnostic: diagnostic(context, channels, now) };
    }

    function inspect(stream, sourceKey, now) {
      const field = fields.get(sourceKey);
      return field ? { ...fieldSnapshot(field, stream, now), points: field.points.map((point) => [...point]) } : null;
    }

    function clearHistory(now) {
      counts = emptyCounts(); rates = []; events = []; raw = null; lastProblem = lastProblemAt = null;
      startedAt = finite(now) ? now : startedAt;
      for (const field of fields.values()) { field.points = []; field.minimum = field.value; field.maximum = field.value; }
      event(startedAt, "info", "Monitor history cleared");
    }

    return { reset, connection, message, snapshot, inspect, clearHistory };
  }

  return { create };
})();
