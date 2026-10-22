"""Bounded, local beat analysis for saved audio, with an explicit beat timeline.

The tempo prior can vary at every frame. Long files are decoded in overlapping
windows, and extended silence splits the timeline instead of inventing beats.
Recurring attack accents provide a best estimate of the existing four-beat
groove's starting phase; they do not identify a track's time signature.
"""

from __future__ import annotations

import hashlib
import importlib.util
import math
from bisect import bisect_left, bisect_right
from pathlib import Path
import subprocess
from typing import Callable

SCHEMA_VERSION = 1
ALGORITHM = "librosa-dynamic-v2"
SAMPLE_RATE = 22050
HOP_LENGTH = 256
WINDOW_SECONDS = 60.0
OVERLAP_SECONDS = 8.0
MAX_BEATS = 250000


def available() -> bool:
    return all(importlib.util.find_spec(name) is not None for name in ("numpy", "scipy", "librosa"))


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_beat_analysis(value: dict, duration: float | None = None) -> None:
    """Validate a persisted completed map before it can drive a transport."""
    if (not isinstance(value, dict) or not isinstance(value.get("state"), str)
            or value["state"] not in {"not_requested", "queued", "analyzing", "complete", "failed"}):
        raise ValueError("Invalid saved beat analysis.")
    warnings = value.get("warnings", [])
    if (not isinstance(warnings, list) or len(warnings) > 16
            or any(not isinstance(warning, str) or len(warning) > 1000 for warning in warnings)):
        raise ValueError("Invalid beat analysis warnings.")
    error = value.get("error")
    if error is not None and (not isinstance(error, str) or len(error) > 2000):
        raise ValueError("Invalid beat analysis error message.")
    if value.get("state") == "not_requested":
        return
    if value.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("Invalid saved beat analysis version.")
    hint = value.get("bpm_hint")
    if hint is not None and (type(hint) not in (int, float) or not math.isfinite(hint) or not 20 <= hint <= 300):
        raise ValueError("Invalid beat analysis BPM hint.")
    if value["state"] != "complete":
        return
    first_beat = value.get("first_beat_in_bar")
    if first_beat is not None and (type(first_beat) is not int or not 1 <= first_beat <= 4):
        raise ValueError("Invalid detected first beat in bar.")
    phase_confidence = value.get("bar_phase_confidence")
    if phase_confidence is not None and (type(phase_confidence) not in (int, float)
                                        or not math.isfinite(phase_confidence) or not 0 <= phase_confidence <= 1):
        raise ValueError("Invalid detected bar phase confidence.")
    length = value.get("duration_seconds")
    if type(length) not in (int, float) or not math.isfinite(length) or length <= 0:
        raise ValueError("Invalid beat analysis duration.")
    if duration is not None and abs(length - duration) > .25:
        raise ValueError("Beat analysis does not match the audio duration.")
    beats = value.get("beats_seconds")
    if not isinstance(beats, list) or not 2 <= len(beats) <= MAX_BEATS:
        raise ValueError("Beat analysis needs at least two detected beats.")
    previous = -1
    for beat in beats:
        if type(beat) not in (int, float) or not math.isfinite(beat) or not 0 <= beat < length or beat <= previous:
            raise ValueError("Saved beat timestamps must increase within the audio.")
        previous = beat
    regions = value.get("active_regions")
    if not isinstance(regions, list) or not regions:
        raise ValueError("Beat analysis needs active audio regions.")
    previous = -1
    for region in regions:
        if not isinstance(region, dict):
            raise ValueError("Invalid active audio region.")
        start, end = region.get("start_seconds"), region.get("end_seconds")
        if any(type(item) not in (int, float) or not math.isfinite(item) for item in (start, end)) or not 0 <= start < end <= length or start < previous:
            raise ValueError("Invalid active audio region.")
        previous = end
        if bisect_right(beats, end) - bisect_left(beats, start) < 2:
            raise ValueError("Each active region needs at least two beats.")
    index = 0
    for beat in beats:
        while index < len(regions) and beat > regions[index]["end_seconds"]:
            index += 1
        if index == len(regions) or beat < regions[index]["start_seconds"]:
            raise ValueError("A saved beat falls outside active audio.")
    for name in ("bpm_median", "bpm_min", "bpm_max"):
        number = value.get(name)
        if type(number) not in (int, float) or not math.isfinite(number) or not 15 <= number <= 400:
            raise ValueError("Invalid detected tempo.")
    for field in ("source_sha256", "audio_sha256"):
        source_hash = value.get(field)
        if not isinstance(source_hash, str) or len(source_hash) != 64 or any(c not in "0123456789abcdef" for c in source_hash):
            raise ValueError("Beat analysis needs an audio checksum.")
    if not isinstance(value.get("source"), str) or value["source"] not in {"mix", "drums"}:
        raise ValueError("Invalid beat analysis audio source.")
    if value["source"] == "drums" and not isinstance(value.get("source_stem_id"), str):
        raise ValueError("Beat analysis needs its source drum stem.")


def _decode(path: Path, ffmpeg: str, start: float, length: float):
    import numpy as np
    with path.open("rb") as handle:
        header = handle.read(12)
    # This is a MOV demuxer option; FFmpeg rejects it on WAV/MP3 inputs.
    mov_options = ["-enable_drefs", "0"] if (path.suffix.lower() in {".m4a", ".mp4", ".mov"}
                                                  or header[4:8] in {b"ftyp", b"moov", b"mdat", b"wide"}) else []
    command = [ffmpeg, "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe",
               "-format_whitelist", "mp3,wav,flac,ogg,mov,aac", *mov_options, "-ss", str(start), "-i", str(path),
               "-t", str(length), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
               "-f", "f32le", "pipe:1"]
    try:
        result = subprocess.run(command, capture_output=True, check=True, timeout=90)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError("The saved audio could not be decoded for beat analysis.") from exc
    samples = np.frombuffer(result.stdout, dtype="<f4")
    if len(samples) > int((length + 1) * SAMPLE_RATE) or not np.isfinite(samples).all():
        raise ValueError("The decoded audio failed beat-analysis validation.")
    return samples


def _active_regions(samples):
    """Ignore leading/trailing silence and internal gaps longer than 1.5s."""
    import numpy as np
    frame = max(1, int(SAMPLE_RATE * .02))
    count = len(samples) // frame
    if count == 0:
        return []
    rms = np.sqrt(np.mean(samples[:count * frame].reshape(count, frame) ** 2, axis=1))
    peak = float(np.max(rms))
    if peak < 1e-6:
        return []
    active = np.flatnonzero(rms >= max(1e-6, peak * .003))
    if not len(active):
        return []
    boundaries = np.flatnonzero(np.diff(active) > 1.5 / .02) + 1
    groups = np.split(active, boundaries)
    return [(max(0, int(group[0]) * frame - HOP_LENGTH), min(len(samples), (int(group[-1]) + 1) * frame + HOP_LENGTH))
            for group in groups]


def _window_beats(samples, bpm_hint: float | None):
    import librosa
    import numpy as np
    results = []
    for start, end in _active_regions(samples):
        # Padding preserves the first onset without treating leading silence as
        # a beat. It also gives the last onset a complete spectral window.
        pad = SAMPLE_RATE // 2
        section = np.pad(samples[start:end], (pad, pad))
        onset = librosa.onset.onset_strength(y=section, sr=SAMPLE_RATE, hop_length=HOP_LENGTH)
        if len(onset) < 4 or float(np.max(onset)) <= 0:
            continue
        dynamic = librosa.feature.tempo(onset_envelope=onset, sr=SAMPLE_RATE, hop_length=HOP_LENGTH,
                                        start_bpm=bpm_hint or 120, std_bpm=1.0, ac_size=6, aggregate=None)
        dynamic = np.clip(dynamic, 20, 300)
        _, detected = librosa.beat.beat_track(onset_envelope=onset, sr=SAMPLE_RATE, hop_length=HOP_LENGTH,
                                             bpm=dynamic, tightness=60, trim=False)
        candidates = librosa.onset.onset_detect(onset_envelope=onset, sr=SAMPLE_RATE, hop_length=HOP_LENGTH,
                                                backtrack=False, units="frames")
        if not len(candidates):
            continue
        # Snap the dynamic-programming path to nearby measured attacks. Weak
        # extrapolated beats beyond the audio activity are discarded below.
        region_beats = []
        for frame in detected:
            nearest = candidates[int(np.argmin(np.abs(candidates - frame)))]
            if abs(int(nearest) - int(frame)) <= int(.1 * SAMPLE_RATE / HOP_LENGTH):
                frame = nearest
            local = int(frame) * HOP_LENGTH - pad
            # Refine attack time at 5ms resolution rather than retaining the
            # STFT's latency. Only adjust near a pronounced energy increase.
            left, right = max(0, local - int(.05 * SAMPLE_RATE)), min(end - start, local + int(.02 * SAMPLE_RATE))
            step = max(1, SAMPLE_RATE // 200)
            if right - left >= 3 * step:
                fragment = samples[start + left:start + right]
                envelope = np.sqrt(np.mean(fragment[:len(fragment) // step * step].reshape(-1, step) ** 2, axis=1))
                increase = np.diff(envelope, prepend=0)
                attack = int(np.argmax(increase))
                if increase[attack] > .15 * float(np.max(envelope)):
                    local = left + attack * step
            second = (start + local) / SAMPLE_RATE
            if start / SAMPLE_RATE <= second < end / SAMPLE_RATE:
                region_beats.append(second)
        # The tracker may omit an initial attack while its tempo settles. Add
        # it only when the next beat's spacing agrees with the local period.
        if region_beats:
            first = (start + int(candidates[0]) * HOP_LENGTH - pad) / SAMPLE_RATE
            period = 60 / float(dynamic[int(candidates[0])])
            if first >= start / SAMPLE_RATE and .65 * period < region_beats[0] - first < 1.35 * period:
                region_beats.insert(0, first)
        if len(region_beats) >= 2:
            results.append((region_beats, start / SAMPLE_RATE, end / SAMPLE_RATE))
    return results


def _beat_accents(samples, beats):
    """Measure attacks for groove phase without retaining or re-decoding audio.

    Low-frequency attacks help distinguish a bass-drum accent from a bright
    snare/hi-hat. Both broadband and low-frequency energy still contribute so
    this remains useful on a full mix or a pitched click track.
    """
    import numpy as np
    span = int(.12 * SAMPLE_RATE)
    before = int(.08 * SAMPLE_RATE)
    taper = np.hanning(span)
    frequencies = np.fft.rfftfreq(span, 1 / SAMPLE_RATE)
    low = (frequencies >= 35) & (frequencies <= 180)
    result = []
    for beat in beats:
        start = max(0, int((beat - .01) * SAMPLE_RATE))
        fragment = np.zeros(span, dtype=np.float32)
        available = samples[start:start + span]
        fragment[:len(available)] = available
        baseline = samples[max(0, start - before):start]
        previous = float(np.sqrt(np.mean(baseline ** 2))) if len(baseline) else 0
        attack = max(0, float(np.sqrt(np.mean(fragment ** 2))) - previous)
        spectrum = np.abs(np.fft.rfft(fragment * taper)) ** 2
        low_attack = float(np.sqrt(np.sum(spectrum[low]))) / span
        result.append(.6 * attack + .4 * low_attack)
    return result


def _estimate_bar_phase(accents):
    """Choose a recurring strong accent, or start the groove on beat 1.

    Confidence measures accent contrast, not a probability of a true musical
    downbeat. Identical clicks and equally strong beats 1/3 are deliberately
    ambiguous. A few complete bars are required to avoid trusting one transient.
    """
    import numpy as np
    count = min(len(accents) // 4, 32)
    if count < 3:
        return 1, 0.0
    bars = np.asarray(accents[:count * 4], dtype=float).reshape(count, 4)
    means = np.mean(bars, axis=1)
    bars = bars[means > 1e-9] / means[means > 1e-9, np.newaxis]
    if len(bars) < 3:
        return 1, 0.0
    # Median resists fills and isolated loud notes. The agreement check keeps
    # changing accents from making an arbitrary phase look authoritative.
    scores = np.median(bars, axis=0)
    ranked = np.argsort(scores)
    phase = int(ranked[-1])
    contrast = float((scores[phase] - scores[ranked[-2]]) / max(scores[phase], 1e-9))
    agreement = float(np.mean(np.argmax(bars, axis=1) == phase))
    if contrast < .12 or agreement < .6:
        return 1, 0.0
    return (-phase) % 4 + 1, round(min(1.0, contrast * agreement), 3)


def analyze(path: Path, duration_seconds: float, ffmpeg: str, *, source: str = "mix", bpm_hint: float | None = None,
            source_stem_id: str | None = None, audio_sha256: str | None = None,
            progress: Callable[[float], None] | None = None) -> dict:
    if not available():
        raise ValueError("Install requirements-beat-tracking.txt in the dashboard Python environment to analyze beats locally.")
    if type(duration_seconds) not in (int, float) or not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise ValueError("Beat analysis needs a valid audio duration.")
    if bpm_hint is not None and (type(bpm_hint) not in (int, float) or not math.isfinite(bpm_hint) or not 20 <= bpm_hint <= 300):
        raise ValueError("The optional BPM hint must be between 20 and 300.")
    beats, regions, accents = [], [], {}
    core_start = 0.0
    while core_start < duration_seconds:
        window_start = max(0, core_start - OVERLAP_SECONDS)
        core_end = min(duration_seconds, core_start + WINDOW_SECONDS)
        window_end = min(duration_seconds, core_end + OVERLAP_SECONDS)
        samples = _decode(path, ffmpeg, window_start, window_end - window_start)
        for detected, start, end in _window_beats(samples, bpm_hint):
            retained_local = [value for value in detected if core_start <= window_start + value < core_end]
            retained = [round(window_start + value, 6) for value in retained_local]
            if retained:
                beats.extend(retained)
                # Only the opening section informs one global starting phase.
                # Bound this extra work even when the track is several hours.
                accent_count = max(0, 128 - len(accents))
                if accent_count:
                    accents.update(zip(retained[:accent_count], _beat_accents(samples, retained_local[:accent_count])))
                regions.append({"start_seconds": round(max(core_start, window_start + start), 6),
                                "end_seconds": round(min(core_end, window_start + end), 6)})
        if len(beats) > MAX_BEATS:
            raise ValueError("This track has too many beats to retain safely in one session.")
        core_start = core_end
        if progress:
            progress(core_end / duration_seconds)
    # Merge the overlapping analysis regions; keep real silent gaps intact.
    merged = []
    for region in regions:
        if merged and region["start_seconds"] <= merged[-1]["end_seconds"] + .03:
            merged[-1]["end_seconds"] = region["end_seconds"]
        else:
            merged.append(region)
    cleaned = []
    for beat in sorted(set(beats)):
        if not cleaned or beat - cleaned[-1] >= .15:
            cleaned.append(beat)
    merged = [region for region in merged if bisect_right(cleaned, region["end_seconds"]) - bisect_left(cleaned, region["start_seconds"]) >= 2]
    region_ends = [region["end_seconds"] for region in merged]

    def region_index(beat):
        index = bisect_left(region_ends, beat)
        return index if index < len(merged) and merged[index]["start_seconds"] <= beat else None

    cleaned = [beat for beat in cleaned if region_index(beat) is not None]
    import numpy as np
    intervals = [b - a for a, b in zip(cleaned, cleaned[1:])
                 if .15 <= b - a <= 4 and region_index(a) == region_index(b)]
    if len(cleaned) < 4 or len(intervals) < 3:
        raise ValueError("No reliable beat sequence was found in this audio. Automatic drum timing is unavailable for this track.")
    tempos = 60 / np.asarray(intervals)
    # A silent gap may contain an unknown number of musical beats. Restrict the
    # global starting-phase estimate to the first continuous section.
    first_region = [accents[beat] for beat in cleaned if beat in accents and region_index(beat) == 0]
    first_beat, phase_confidence = _estimate_bar_phase(first_region)
    warnings = ["Beat timing and four-beat groove phase are estimated automatically; unusual rhythms can remain ambiguous."]
    if float(np.percentile(tempos, 90)) > 1.7 * float(np.percentile(tempos, 10)):
        warnings.append("Large tempo changes or half/double-tempo ambiguity were detected.")
    checksum = file_sha256(path)
    result = {"schema_version": SCHEMA_VERSION, "algorithm": ALGORITHM, "state": "complete", "source": source,
              "source_sha256": checksum, "audio_sha256": audio_sha256 or checksum,
              "source_stem_id": source_stem_id, "duration_seconds": duration_seconds,
              "beats_seconds": cleaned, "active_regions": merged,
              "first_beat_in_bar": first_beat, "bar_phase_confidence": phase_confidence,
              "bpm_median": round(float(np.median(tempos)), 3), "bpm_min": round(float(np.min(tempos)), 3),
              "bpm_max": round(float(np.max(tempos)), 3), "warnings": warnings, "error": None}
    validate_beat_analysis(result, duration_seconds)
    return result
