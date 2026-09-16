"use strict";

// Catalog values are logical UI values; encoding is centralized here so selectors
// and routing prefixes can never be overwritten by an ordinary range mapping.
globalThis.HydraParameters = (() => {
  let entries = [];
  let byId = new Map();
  let ccEntries = new Map();
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const excludedCc = new Set([0, 6, 32, 38, 64, 96, 97, 98, 99, 100, 101, 120, 121, 123]);

  function install(catalog) {
    if (catalog?.schema_version !== 1 || !Array.isArray(catalog.nrpn_parameters) || !Array.isArray(catalog.cc_parameters)) {
      throw new Error("The Hydrasynth parameter catalog is unavailable or invalid.");
    }
    const ambiguous = new Set((catalog.source_ambiguities?.decoder_collisions || []).flatMap((item) => item.parameter_ids));
    entries = [...catalog.cc_parameters.map((entry) => makeEntry(entry, "cc")),
      ...catalog.nrpn_parameters.map((entry) => makeEntry(entry, "nrpn"))];
    function makeEntry(entry, kind) {
      const value = entry.value || {};
      let minimum = value.raw_min;
      let maximum = value.raw_max;
      let choices = value.items || (value.kind === "enum_reference" ? catalog.rhythm_lists?.[value.enum]?.items : null);
      let unavailable = "";
      if (choices?.length) {
        choices = choices.filter((item) => Number.isInteger(item.value)).sort((a, b) => a.value - b.value);
        minimum = choices[0]?.value; maximum = choices.at(-1)?.value;
      }
      if (value.kind === "bipolar") { minimum = value.display_min; maximum = value.display_max; }
      if (value.kind === "curve") { minimum = value.anchors[0].display; maximum = value.anchors.at(-1).display; }
      if (value.kind === "signed_wrap") { minimum = value.pivot + 1 - value.subtract_above_pivot; maximum = value.pivot; }
      if (value.display_encoding?.kind === "signed_7bit") { minimum = -63; maximum = 64; }
      if (value.kind === "packed_index") { minimum = 0; maximum = Math.max(...value.segments.map((part) => part.offset)) + 127; }
      if (ambiguous.has(entry.id)) unavailable = "The published MIDI specification assigns this address to conflicting parameters.";
      if (value.kind === "context_dependent") unavailable = `The specification does not give a usable range; depends on ${value.dependency}.`;
      if (/^(PRE|POST)-FX type$/i.test(entry.name)) unavailable = "The published catalog does not define the effect-type values.";
      if (kind === "cc" && excludedCc.has(entry.number)) unavailable = "Reserved MIDI control number; use its NRPN equivalent or dedicated patch/transport control.";
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) { unavailable ||= "No documented value range."; minimum = 0; maximum = 127; }
      if (value.kind === "selected_byte" && Number.isFinite(maximum)) maximum = Math.min(127, maximum);
      const number = kind === "cc" ? entry.number : entry.address.number;
      const selector = value.kind === "selected_byte" ? value.selector_values?.[0] : undefined;
      if (value.kind === "selected_byte" && !Number.isInteger(selector)) unavailable ||= "No unambiguous parameter selector.";
      const discrete = Boolean(choices) || ["selected_byte", "packed_index"].includes(value.kind)
        || /(?:Type|Mode|Wave|Trig|Source|Dest)/i.test(entry.name);
      return { id: entry.id, label: entry.name, group: `${kind.toUpperCase()} · ${entry.group}`,
        family: entry.group, kind, number, min: minimum, max: maximum, from: minimum, to: maximum,
        choices, discrete, unavailable, valueSpec: value, selector, equivalents: entry.nrpn_equivalents || [],
        ccEquivalent: entry.cc_equivalent, hardware: true,
        randomEligible: !unavailable && value.kind !== "packed_index" && !/BPM Sync on/i.test(entry.name),
        hint: value.documented_out_of_7bit_range ? "Limited to 0–127: the reference's upper value cannot fit in one MIDI data byte."
          : value.kind === "packed_index" ? "Routing index; consult the synth's modulation source/destination list."
          : /BPM Sync (on|off)/i.test(entry.name) ? "Applies when the synth's BPM Sync setting matches this parameter." : "" };
    }
    byId = new Map(entries.map((entry) => [entry.id, entry]));
    ccEntries = new Map(entries.filter((entry) => entry.kind === "cc").map((entry) => [entry.number, entry]));
    const music = globalThis.HydraSonification;
    music.DESTINATIONS.splice(27, music.DESTINATIONS.length - 27, ...entries);
    return { total: entries.length, available: entries.filter((entry) => !entry.unavailable).length,
      nrpn: entries.filter((entry) => entry.kind === "nrpn" && !entry.unavailable).length,
      unavailable: entries.filter((entry) => entry.unavailable).length };
  }

  function logicalValue(entry, value) {
    let output = clamp(Number.isFinite(Number(value)) ? Number(value) : entry.from, entry.min, entry.max);
    if (entry.choices?.length) output = entry.choices.reduce((best, item) =>
      Math.abs(item.value - output) < Math.abs(best.value - output) ? item : best).value;
    return output;
  }

  function encode(entry, value) {
    if (!entry || entry.unavailable) return null;
    const logical = logicalValue(entry, value);
    const spec = entry.valueSpec || {};
    let raw = logical;
    if (spec.kind === "bipolar") {
      raw = logical < 0 ? spec.raw_center + logical / -spec.display_min * (spec.raw_center - spec.raw_min)
        : spec.raw_center + logical / spec.display_max * (spec.raw_max - spec.raw_center);
    } else if (spec.kind === "curve") raw = logical - entry.min;
    else if (spec.kind === "signed_wrap") raw = logical < 0 ? logical + spec.subtract_above_pivot : logical;
    else if (spec.kind === "selected_byte") {
      const payload = spec.display_encoding?.kind === "signed_7bit" && logical < 0 ? logical + 128 : logical;
      raw = entry.selector * 128 + clamp(Math.round(payload), 0, 127);
    } else if (spec.kind === "packed_index") {
      const index = Math.round(logical);
      const segment = [...spec.segments].reverse().find((part) => part.offset <= index);
      raw = segment.prefix * 128 + index - segment.offset;
    }
    const suffix = spec.kind === "selected_byte" ? `:selector:${entry.selector}`
      : spec.kind === "packed_index" ? `:routing:${spec.segments[0].prefix}` : "";
    return { key: `${entry.kind}:${entry.number}${suffix}`, kind: entry.kind, number: entry.number,
      value: Math.round(clamp(raw, 0, entry.kind === "cc" ? 127 : 16383)), parameterId: entry.id };
  }

  function command(destination, value, format = "nrpn") {
    if (!destination || destination.unavailable) return null;
    if (destination.kind === "nrpn") return format === "nrpn" ? encode(destination, value) : null;
    const number = destination.kind === "cc" ? destination.number : destination.cc;
    if (number === undefined) return null;
    const cc = ccEntries.get(number);
    if (format === "nrpn" && cc?.equivalents.length) {
      const candidates = cc.equivalents.map((id) => byId.get(id)).filter((entry) => entry && !entry.unavailable);
      const target = candidates.find((entry) => !/BPM Sync on/i.test(entry.label)) || candidates[0];
      if (!target) return null;
      return encode(target, target.min + clamp(value, 0, 127) / 127 * (target.max - target.min));
    }
    // Mod wheel, volume and expression are System MIDI controls in either mode.
    if (format === "nrpn" && ![1, 7, 11].includes(number)) return null;
    return { key: `cc:${number}`, kind: "cc", number, value: Math.round(clamp(value, 0, 127)), parameterId: destination.id };
  }

  function messages(command, channel = 0) {
    const status = 0xB0 | channel;
    return command.kind === "cc" ? [[status, command.number, command.value]] : [
      [status, 99, command.number >> 7], [status, 98, command.number & 127],
      [status, 6, command.value >> 7], [status, 38, command.value & 127]
    ];
  }

  class Pacer {
    constructor() { this.pending = new Map(); this.sent = new Map(); }
    update(commands) {
      const desired = new Map(commands.map((item) => [item.key, item]));
      for (const key of this.pending.keys()) if (!desired.has(key)) this.pending.delete(key);
      for (const [key, item] of desired) {
        if (this.sent.get(key) !== item.value) this.pending.set(key, item);
        else this.pending.delete(key);
      }
    }
    flush(send, limit = 1) {
      const emitted = [];
      for (const [key, item] of this.pending) {
        if (emitted.length >= limit) break;
        // Send each four-message NRPN transaction without interleaving selectors.
        for (const bytes of messages(item)) send(bytes);
        this.pending.delete(key); this.sent.set(key, item.value); emitted.push(item);
      }
      return emitted;
    }
    reset() { this.pending.clear(); this.sent.clear(); }
  }
  return { install, encode, command, messages, logicalValue, Pacer, get entries() { return entries; }, get byId() { return byId; } };
})();
