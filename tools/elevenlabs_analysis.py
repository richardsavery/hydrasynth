"""Deterministic, dependency-free recorded-data analysis and ElevenLabs plans.

This module never reads credentials, persists files, or calls a provider. Missing
values remain unavailable all the way through section coverage validation.
"""
from __future__ import annotations

import bisect
import csv
import hashlib
import io
import json
import math
import re
import statistics
from pathlib import Path

SCHEMA_VERSION = 1
MAPPING_VERSION = "activity-density-v1"
THRESHOLDS = {"low": 0.33, "high": 0.67}
_TIME_UNITS = {"seconds": 1.0, "milliseconds": 0.001, "microseconds": 0.000001}


def _canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
        return (0.0 if number == 0 else number) if math.isfinite(number) else None
    except (ValueError, TypeError, OverflowError):
        return None


def _setting_number(settings, key, default):
    value = settings.get(key)
    if value is None or value == "":
        return default
    number = _number(value)
    if number is None:
        raise ValueError(f"{key} must be a finite number.")
    return number


def parse_dataset(content: str, filename: str) -> dict:
    """Parse a small flat CSV/JSONL recording, retaining unavailable cells."""
    if not isinstance(content, str) or not content.strip():
        raise ValueError("The recording is empty; upload CSV or flat JSONL text.")
    filename = Path(str(filename or "recording.csv")).name
    content = content.lstrip("\ufeff")
    rows = []
    if filename.lower().endswith((".jsonl", ".ndjson")):
        columns = []
        for line_number, line in enumerate(content.splitlines(), 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except (ValueError, TypeError) as error:
                raise ValueError(f"Invalid JSON on line {line_number}.") from error
            if not isinstance(row, dict) or not row:
                raise ValueError(f"Line {line_number} must be a nonempty flat JSON object.")
            if any(not key.strip() or isinstance(value, (dict, list)) for key, value in row.items()):
                raise ValueError(f"Line {line_number} contains nested data or an empty column name; select a flat export.")
            for key in row:
                if key not in columns:
                    columns.append(key)
            rows.append(row)
    elif filename.lower().endswith(".csv"):
        try:
            reader = csv.DictReader(io.StringIO(content))
            columns = reader.fieldnames or []
            if not columns or any(not name.strip() for name in columns) or len(set(columns)) != len(columns):
                raise ValueError("CSV must have unique, nonempty column names.")
            for line_number, row in enumerate(reader, 2):
                if None in row:
                    raise ValueError(f"CSV row {line_number} has more values than its header.")
                rows.append(row)
        except csv.Error as error:
            raise ValueError(f"Invalid CSV: {error}") from error
    else:
        raise ValueError("Choose a .csv, .jsonl, or .ndjson recording.")
    if len(columns) < 2 or not rows:
        raise ValueError("Include a timestamp column, at least one channel, and at least one data row.")
    if len(columns) > 128 or len(rows) > 250000:
        raise ValueError("Recordings are limited to 128 columns and 250,000 rows; crop the source first.")
    # Numeric strings and numeric JSON cells have the same canonical identity.
    canonical = []
    for row in rows:
        item = {}
        for column in columns:
            value = row.get(column)
            numeric = _number(value)
            item[column] = numeric if numeric is not None else (
                None if value is None or isinstance(value, (float, int)) or str(value).strip().lower()
                in ("", "nan", "inf", "+inf", "-inf", "infinity", "+infinity", "-infinity", "null") else str(value)
            )
        canonical.append(item)
    return {
        "schema_version": SCHEMA_VERSION, "filename": filename, "columns": columns,
        "rows": canonical, "row_count": len(canonical), "preview": canonical[:20],
        "content_hash": _canonical_hash({"columns": columns, "rows": canonical}),
        "defaults": {"timestamp_column": columns[0], "timestamp_units": "seconds",
                     "channels": [{"name": columns[1], "meaning": "scalar"}]},
    }


def synthetic_dataset() -> dict:
    rows = [{"t_seconds": index / 10, "activity": 0.12 if (index // 100) % 2 == 0 else 0.88}
            for index in range(601)]
    # The endpoint is the final high section's value, not a new section.
    rows[-1]["activity"] = 0.88
    result = parse_dataset("\n".join(json.dumps(row) for row in rows), "synthetic-low-high.jsonl")
    result["defaults"] = {"timestamp_column": "t_seconds", "timestamp_units": "seconds",
                          "channels": [{"name": "activity", "meaning": "velocity",
                                        "lower_bound": 0.0, "upper_bound": 1.0}],
                          "start_seconds": 0.0, "end_seconds": 60.0}
    result["description"] = "60 seconds alternating low and high activity every 10 seconds; fixed 0–1 bounds."
    return result


def _percentile(values, fraction):
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    left = int(position)
    right = min(left + 1, len(ordered) - 1)
    fraction = position - left
    return ordered[left] * (1 - fraction) + ordered[right] * fraction


def _interpolate(times, values, instant, max_gap):
    index = bisect.bisect_left(times, instant)
    if index < len(times) and abs(times[index] - instant) < 1e-9:
        return values[index]
    if index > 0 and abs(times[index - 1] - instant) < 1e-9:
        return values[index - 1]
    if index == 0 or index == len(times):
        return None
    left, right = index - 1, index
    gap = times[right] - times[left]
    if gap > max_gap + 1e-9 or values[left] is None or values[right] is None:
        return None
    ratio = (instant - times[left]) / gap
    return values[left] * (1 - ratio) + values[right] * ratio


def _average_interval(times, values, start, end, max_gap):
    """Integrate the linear interpolant before decimation, without bridging holes."""
    first = bisect.bisect_right(times, start)
    last = bisect.bisect_left(times, end)
    knots = [start] + times[first:last] + [end]
    total = 0.0
    previous_value = _interpolate(times, values, start, max_gap)
    for left, right in zip(knots, knots[1:]):
        value = _interpolate(times, values, right, max_gap)
        # Checking the midpoint also detects a long gap bounded by exact samples.
        if previous_value is None or value is None or _interpolate(times, values, (left + right) / 2, max_gap) is None:
            return None
        total += (previous_value + value) * 0.5 * (right - left)
        previous_value = value
    return total / (end - start)


def _resample(times, values, grid, end, rate, max_gap, downsample):
    if downsample:
        return [_average_interval(times, values, instant, min(instant + 1 / rate, end), max_gap)
                for instant in grid]
    return [_interpolate(times, values, instant, max_gap) for instant in grid]


def _derivative(values, times, smooth):
    if smooth:
        filtered = []
        for index, value in enumerate(values):
            if value is None:
                filtered.append(None)
                continue
            neighbors = [value * 2]
            weights = 2
            for neighbor in (index - 1, index + 1):
                if 0 <= neighbor < len(values) and values[neighbor] is not None:
                    neighbors.append(values[neighbor])
                    weights += 1
            filtered.append(sum(neighbors) / weights)
        values = filtered
    result = []
    for index, value in enumerate(values):
        if value is None:
            result.append(None)
            continue
        left = index - 1 if index > 0 and values[index - 1] is not None else index
        right = index + 1 if index + 1 < len(values) and values[index + 1] is not None else index
        if left == right:
            result.append(None)
        else:
            result.append(abs((values[right] - values[left]) / (times[right] - times[left])))
    return result


def _band(value):
    if value is None:
        return "unavailable"
    return "low" if value < THRESHOLDS["low"] else "medium" if value < THRESHOLDS["high"] else "high"


def _windows(start, end, length):
    boundaries = [start]
    while boundaries[-1] + length < end - 1e-9:
        boundaries.append(boundaries[-1] + length)
    if len(boundaries) > 1 and end - boundaries[-1] < 3 - 1e-9:
        boundaries.pop()
    boundaries.append(end)
    return list(zip(boundaries, boundaries[1:]))


def analyze_dataset(dataset: dict, settings: dict) -> dict:
    if not isinstance(settings, dict):
        raise ValueError("Analysis settings must be an object.")
    defaults = dataset.get("defaults", {})
    timestamp_column = settings.get("timestamp_column") or defaults.get("timestamp_column")
    units = settings.get("timestamp_units") or defaults.get("timestamp_units", "seconds")
    columns = dataset.get("columns", [])
    if timestamp_column not in columns:
        raise ValueError("Select an existing timestamp column.")
    if units not in _TIME_UNITS:
        raise ValueError("Select timestamp units: seconds, milliseconds, or microseconds.")
    channel_settings = settings.get("channels", defaults.get("channels", []))
    if not isinstance(channel_settings, list) or not channel_settings:
        raise ValueError("Select at least one channel and its meaning.")
    channels = []
    for channel in channel_settings:
        if not isinstance(channel, dict) or channel.get("name") not in columns or channel.get("name") == timestamp_column:
            raise ValueError("Each channel must name an existing column other than the timestamp.")
        meaning = channel.get("meaning")
        if meaning not in ("velocity", "position", "scalar"):
            raise ValueError("Choose velocity, position, or scalar for each channel.")
        if any(item["name"] == channel["name"] for item in channels):
            raise ValueError("Select each source channel only once.")
        change_based = channel.get("change_based", False)
        if not isinstance(change_based, bool):
            raise ValueError(f"The change interpretation for {channel['name']} must be true or false.")
        # Settings cross Python/JavaScript JSON boundaries. Canonicalize omitted
        # flags, numeric types, and UI-only fields before persisting/cache hashing.
        canonical_channel = {"name": channel["name"], "meaning": meaning,
                             "change_based": change_based if meaning == "scalar" else False}
        for bound_name in ("lower_bound", "upper_bound"):
            bound = _setting_number(channel, bound_name, None)
            if bound is not None:
                canonical_channel[bound_name] = bound
        channels.append(canonical_channel)
    raw_times = [_number(row.get(timestamp_column)) for row in dataset["rows"]]
    if any(instant is None for instant in raw_times):
        raise ValueError("Timestamps must all be finite numbers; repair missing or non-finite timestamps.")
    ordered = sorted(enumerate(raw_times), key=lambda item: item[1])
    sorting_changed = [index for index, _ in ordered] != list(range(len(raw_times)))
    unique = {}
    for index, instant in ordered:
        unique[instant] = dataset["rows"][index]
    duplicate_count = len(ordered) - len(unique)
    absolute_times = list(unique)
    if len(absolute_times) < 2:
        raise ValueError("At least two distinct timestamps are required.")
    first_time = absolute_times[0]
    times = [(instant - first_time) * _TIME_UNITS[units] for instant in absolute_times]
    if any(not math.isfinite(instant) for instant in times):
        raise ValueError("Elapsed timestamps exceed the supported finite range.")
    duration = times[-1]
    median_interval = statistics.median([right - left for left, right in zip(times, times[1:])])
    start = _setting_number(settings, "start_seconds", 0.0)
    end = _setting_number(settings, "end_seconds", min(start + 60.0, duration))
    if start < 0 or end <= start or end > duration + 1e-7:
        raise ValueError(f"Select an elapsed interval within 0–{duration:g} seconds, with end after start.")
    end = min(end, duration)
    rate = _setting_number(settings, "sample_rate_hz", 10.0)
    gap = _setting_number(settings, "max_gap_seconds", max(0.5, 3 * median_interval))
    window = _setting_number(settings, "window_seconds", 10.0)
    if rate < 1 or rate > 200:
        raise ValueError("sample_rate_hz must be between 1 and 200 Hz.")
    if gap <= 0 or window < 3 or window > 120:
        raise ValueError("Use a positive maximum gap and a section length from 3 to 120 seconds.")
    count = int(math.ceil((end - start) * rate - 1e-9))
    if count > 200000:
        raise ValueError("The selected grid exceeds 200,000 samples; crop the interval or reduce the sample rate.")
    grid = [start + index / rate for index in range(count)]
    weights = [min(instant + 1 / rate, end) - instant for instant in grid]
    downsample = median_interval < 0.75 / rate
    warnings = []
    reasons = []
    if sorting_changed:
        warnings.append("Timestamps were sorted into ascending order.")
    if duplicate_count:
        warnings.append(f"Kept the last row at {duplicate_count} duplicate timestamp(s).")
    if downsample:
        warnings.append("Averaged the interpolated signal over each output interval before reducing the source rate.")
    source_gaps = sum(right - left > gap + 1e-9 for left, right in zip(times, times[1:]))
    if source_gaps:
        warnings.append(f"Found {source_gaps} source interval(s) longer than the interpolation gap limit.")
    frozen_baseline = settings.get("baseline") or {}
    if not isinstance(frozen_baseline, dict):
        raise ValueError("A saved baseline must be an object indexed by channel name.")
    baseline = {}
    normalized = {}
    transformed = {}
    for channel in channels:
        name, meaning = channel["name"], channel["meaning"]
        values = [_number(unique[instant].get(name)) for instant in absolute_times]
        if meaning == "velocity":
            values = [abs(value) if value is not None else None for value in values]
        values = _resample(times, values, grid, end, rate, gap, downsample)
        if meaning == "position" or (meaning == "scalar" and channel.get("change_based", False)):
            values = _derivative(values, grid, smooth=meaning == "position")
        if any(value is not None and not math.isfinite(value) for value in values):
            reasons.append(f"{name}: numerical overflow while transforming the channel; use smaller source units or repair extreme values.")
            values = [value if value is None or math.isfinite(value) else None for value in values]
        transformed[name] = values
        finite = [value for value in values if value is not None]
        saved = frozen_baseline.get(name, {})
        if not isinstance(saved, dict):
            raise ValueError(f"Saved bounds for {name} must be an object.")
        explicit_bounds = channel.get("lower_bound") not in (None, "") and channel.get("upper_bound") not in (None, "")
        matching_interpretation = (saved.get("meaning", meaning) == meaning and
                                   bool(saved.get("change_based", False)) == bool(channel.get("change_based", False)))
        if saved and not explicit_bounds and not matching_interpretation:
            raise ValueError(f"Saved baseline for {name} has a different channel meaning or change interpretation; choose a matching baseline or fit a new one.")
        lower = _setting_number(channel, "lower_bound", saved.get("lower_bound"))
        upper = _setting_number(channel, "upper_bound", saved.get("upper_bound"))
        if (lower is None) != (upper is None):
            raise ValueError(f"Provide both lower and upper bounds for {name}.")
        if lower is not None:
            lower, upper = _number(lower), _number(upper)
            if lower is None or upper is None:
                raise ValueError(f"Bounds for {name} must be finite numbers.")
        method = "fixed" if lower is not None else "percentile_5_95"
        using_saved_bounds = bool(saved) and matching_interpretation and lower is not None and (
            lower == _number(saved.get("lower_bound")) and upper == _number(saved.get("upper_bound")))
        if using_saved_bounds:
            # A reopened analysis must retain its identity: changing the label
            # from "fixed" to "saved" alone would otherwise invalidate audio cache.
            method = saved.get("method", "saved_baseline")
        provenance = saved if using_saved_bounds else {}
        if lower is None and finite:
            lower, upper = _percentile(finite, 0.05), _percentile(finite, 0.95)
        if lower is not None and lower > upper:
            raise ValueError(f"Bounds for {name} must be finite with lower below upper.")
        constant = bool(finite) and min(finite) == max(finite)
        invalid_span = lower is not None and upper is not None and not math.isfinite(upper - lower)
        degenerate = lower is None or upper is None or lower == upper or invalid_span
        if degenerate:
            if invalid_span:
                reason = f"{name}: normalization range overflows; use smaller source units or finite explicit bounds."
            elif not finite:
                reason = f"{name}: no available data in the selection."
            else:
                state = "constant channel" if constant else "degenerate percentile range despite changing data"
                reason = f"{name}: {state}; provide explicit bounds or exclude the channel."
            reasons.append(reason)
            normalized[name] = [None] * len(grid)
        else:
            normalized[name] = [(0.0 if value <= lower else 1.0 if value >= upper else (value - lower) / (upper - lower))
                                if value is not None else None for value in values]
        clipped = sum(value < lower or value > upper for value in finite) if not degenerate else 0
        baseline[name] = {"lower_bound": lower, "upper_bound": upper, "method": method,
                          "finite_min": min(finite) if finite else None,
                          "finite_max": max(finite) if finite else None,
                          "constant": constant, "degenerate": degenerate,
                          "clipped_percent": 100 * clipped / len(finite) if finite else 0.0,
                          "source_start": _setting_number(provenance, "source_start", start),
                          "source_end": _setting_number(provenance, "source_end", end),
                          "dataset_hash": provenance.get("dataset_hash", dataset["content_hash"]), "meaning": meaning,
                          "change_based": bool(channel.get("change_based", False))}
    signal = []
    raw_valid = []
    for index in range(count):
        values = [normalized[channel["name"]][index] for channel in channels]
        raw_valid.append(all(transformed[channel["name"]][index] is not None for channel in channels))
        signal.append(math.sqrt(sum(value * value for value in values) / len(values))
                      if all(value is not None for value in values) else None)
    sections = []
    for index, (left, right) in enumerate(_windows(start, end, window)):
        samples = []
        covered = 0.0
        for point in range(max(0, bisect.bisect_right(grid, left) - 1), bisect.bisect_left(grid, right)):
            overlap = min(grid[point] + weights[point], right) - max(grid[point], left)
            if overlap <= 0:
                continue
            if raw_valid[point]:
                covered += overlap
            if signal[point] is not None:
                samples.append((grid[point], signal[point], overlap))
        coverage = min(1.0, covered / (right - left))
        activity = variability = trend = None
        if samples:
            total_weight = sum(item[2] for item in samples)
            activity = sum(value * weight for _, value, weight in samples) / total_weight
            std = math.sqrt(sum(weight * (value - activity) ** 2 for _, value, weight in samples) / total_weight)
            variability = min(1.0, max(0.0, std / 0.5))
            center_time = sum(instant * weight for instant, _, weight in samples) / total_weight
            denominator = sum(weight * (instant - center_time) ** 2 for instant, _, weight in samples)
            trend = sum(weight * (instant - center_time) * (value - activity) for instant, value, weight in samples) / denominator if denominator else 0.0
        if coverage < 0.9 - 1e-9:
            reasons.append(f"Section {index + 1} has {coverage:.1%} valid coverage; at least 90% is required. Crop or repair the recording.")
        audio_start_ms, audio_end_ms = round((left - start) * 1000), round((right - start) * 1000)
        sections.append({"index": index, "source_start": left, "source_end": right,
                         "audio_start": audio_start_ms / 1000, "audio_end": audio_end_ms / 1000,
                         "duration_ms": audio_end_ms - audio_start_ms, "coverage": coverage,
                         "activity": activity, "variability": variability, "trend": trend,
                         "bands": {"activity": _band(activity), "variability": _band(variability)}})
    if not 3 <= (end - start) <= 600:
        reasons.append("Music plans must be between 3 and 600 seconds; crop the selected interval.")
    if len(sections) > 30:
        reasons.append("More than 30 sections: increase section length or crop the selected interval.")
    if any(not 3000 <= section["duration_ms"] <= 120000 for section in sections):
        reasons.append("Every section must last 3–120 seconds; adjust the section length or crop the selection.")
    actual_settings = {"timestamp_column": timestamp_column, "timestamp_units": units,
                       "channels": channels, "start_seconds": start, "end_seconds": end,
                       "sample_rate_hz": rate, "max_gap_seconds": gap, "window_seconds": window,
                       "baseline": baseline}
    return {"schema_version": SCHEMA_VERSION, "dataset_hash": dataset["content_hash"],
            "settings": actual_settings, "baseline": baseline,
            "timeline": {"times": grid, "signal": signal, "valid": raw_valid, "channels": normalized},
            "sections": sections, "duration_seconds": end - start, "source_duration_seconds": duration,
            "diagnostics": {"sorting_changed": sorting_changed, "duplicate_timestamps": duplicate_count,
                            "source_gap_count": source_gaps, "median_input_interval_seconds": median_interval,
                            "downsampled_with_averaging": downsample},
            "warnings": warnings, "blocking_reasons": reasons, "can_generate": not reasons}


_DENSITY = {
    "low": (["sparse arrangement with occasional notes", "restrained rhythmic activity"],
            ["dense percussion", "busy rhythmic activity"]),
    "medium": (["regular pulse", "moderate percussion", "several interacting parts"], []),
    "high": (["dense arrangement with frequent notes", "busy percussion", "frequent rhythmic events"],
             ["sparse arrangement", "restrained rhythmic activity"]),
    "unavailable": (["activity unavailable; repair source data before generating"], []),
}
_ARTICULATION = {
    "low": ["sustained tones", "smooth phrasing", "long envelopes"],
    "medium": ["short phrases", "mixed sustained and plucked sounds"],
    "high": ["short percussive attacks", "irregular accents", "fragmented phrases"],
    "unavailable": [],
}


def _style_list(value, name):
    if not isinstance(value, list) or len(value) > 50 or any(
            not isinstance(style, str) or not style.strip() or len(style) > 1000 for style in value):
        raise ValueError(f"{name} must be a list of at most 50 nonempty English style strings (up to 1000 characters each).")
    return value


def validate_request(request: dict) -> None:
    if not isinstance(request, dict) or set(request) - {"model_id", "composition_plan", "seed", "store_for_inpainting"}:
        raise ValueError("Plan requests allow only model_id, composition_plan, optional seed and store_for_inpainting.")
    if "store_for_inpainting" in request and type(request["store_for_inpainting"]) is not bool:
        raise ValueError("store_for_inpainting must be true or false.")
    if request.get("model_id") != "music_v2_5":
        raise ValueError("This workflow requires model_id music_v2_5.")
    if "seed" in request and (type(request["seed"]) is not int or not 0 <= request["seed"] <= 2147483647):
        raise ValueError("seed must be an integer between 0 and 2147483647.")
    plan = request.get("composition_plan")
    if not isinstance(plan, dict) or set(plan) != {"chunks"}:
        raise ValueError("composition_plan must contain an ordered chunks list.")
    chunks = plan["chunks"]
    if not isinstance(chunks, list) or not 1 <= len(chunks) <= 30:
        raise ValueError("A composition plan must contain 1–30 chunks.")
    duration = 0
    for index, chunk in enumerate(chunks, 1):
        expected = {"duration_ms", "text", "positive_styles", "negative_styles", "context_adherence"}
        if not isinstance(chunk, dict) or not expected <= set(chunk) or set(chunk) - expected - {"conditioning_ref", "condition_strength"}:
            raise ValueError(f"Chunk {index} must contain duration_ms, text, positive_styles, negative_styles, and context_adherence.")
        milliseconds = chunk["duration_ms"]
        if type(milliseconds) is not int or not 3000 <= milliseconds <= 120000:
            raise ValueError(f"Chunk {index} duration must be an integer from 3000 to 120000 milliseconds.")
        duration += milliseconds
        if not isinstance(chunk["text"], str) or len(chunk["text"]) > 10000:
            raise ValueError(f"Chunk {index} text must be a string of at most 10,000 characters.")
        _style_list(chunk["positive_styles"], f"Chunk {index} positive_styles")
        _style_list(chunk["negative_styles"], f"Chunk {index} negative_styles")
        if chunk["context_adherence"] not in ("low", "medium", "high"):
            raise ValueError(f"Chunk {index} context_adherence must be low, medium, or high.")
        if "condition_strength" in chunk and ("conditioning_ref" not in chunk or chunk["condition_strength"] not in ("low", "medium", "high")):
            raise ValueError("condition_strength requires conditioning_ref and must be low, medium or high.")
        if "conditioning_ref" in chunk:
            reference = chunk["conditioning_ref"]
            if not isinstance(reference, dict) or set(reference) != {"song_id", "range"}:
                raise ValueError("conditioning_ref must contain song_id and range.")
            if not isinstance(reference["song_id"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", reference["song_id"]):
                raise ValueError("conditioning_ref song_id is invalid.")
            span = reference["range"]
            if not isinstance(span, dict) or set(span) != {"start_ms", "end_ms"}:
                raise ValueError("conditioning_ref range requires start_ms and end_ms.")
            start, end = span["start_ms"], span["end_ms"]
            if type(start) is not int or type(end) is not int or not 0 <= start < end <= 600000 or end - start > 30000:
                raise ValueError("conditioning_ref must reference at most 30 seconds within a song.")
    if not 3000 <= duration <= 600000:
        raise ValueError("Total music duration must be 3–600 seconds.")


def compile_plan(analysis: dict, settings: dict) -> dict:
    if not isinstance(settings, dict):
        raise ValueError("Mapping settings must be an object.")
    style = settings.get("style", "instrumental electronic music")
    key = settings.get("key", "D minor")
    if not isinstance(style, str) or not style.strip() or not isinstance(key, str) or not key.strip():
        raise ValueError("Provide a musical style and requested key in English.")
    bpm = _setting_number(settings, "bpm", 100.0)
    if not 20 <= bpm <= 300:
        raise ValueError("Requested BPM must be between 20 and 300.")
    palette = _style_list(settings.get("instrument_palette", ["warm synthesizer tones", "soft electronic percussion"]), "instrument_palette")
    negatives = _style_list(settings.get("negative_styles", []), "negative_styles")
    variability_enabled = bool(settings.get("enable_variability", False))
    context = settings.get("context_adherence", "high")
    anchors = [style, "instrumental music", f"{bpm:g} BPM", key] + palette
    chunks, sections = [], []
    for section in analysis["sections"]:
        band = section["bands"]["activity"]
        density, opposites = _DENSITY[band]
        articulation = _ARTICULATION[section["bands"]["variability"]] if variability_enabled else []
        chunk = {"text": f"[{band.title()} activity]", "duration_ms": section["duration_ms"],
                 "positive_styles": list(dict.fromkeys(anchors + density + articulation)),
                 "negative_styles": list(dict.fromkeys(["vocals", "lyrics"] + negatives + opposites)),
                 "context_adherence": context}
        chunks.append(chunk)
        sections.append({**section, **chunk, "descriptors": {"density": density, "articulation": articulation}})
    request = {"model_id": "music_v2_5", "composition_plan": {"chunks": chunks}}
    if settings.get("seed") is not None and settings.get("seed") != "":
        request["seed"] = settings["seed"]
    reasons = list(analysis.get("blocking_reasons", []))
    try:
        validate_request(request)
    except ValueError as error:
        reasons.append(str(error))
    actual_settings = {"style": style, "key": key, "bpm": bpm, "instrument_palette": palette,
                       "negative_styles": negatives, "enable_variability": variability_enabled,
                       "context_adherence": context}
    if "seed" in request:
        actual_settings["seed"] = request["seed"]
    return {"schema_version": SCHEMA_VERSION, "mapping_version": MAPPING_VERSION,
            "thresholds": dict(THRESHOLDS), "request": request, "sections": sections,
            "settings": actual_settings, "analysis_settings": analysis["settings"],
            "baseline": analysis["baseline"], "dataset_hash": analysis["dataset_hash"],
            "duration_seconds": analysis["duration_seconds"], "warnings": list(analysis.get("warnings", [])),
            "blocking_reasons": reasons, "can_generate": not reasons}
