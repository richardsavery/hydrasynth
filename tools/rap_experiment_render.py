"""Independent, offline rap comparisons; existing mixer playback is untouched.

Natural/phrase comparisons and gain matching use the standard library. Bar
fitting, vocal production and robot effects require NumPy (imported only when
requested). Robot processing preserves continuous speech and its timing.
Whole phrases are stretched with waveform-similarity overlap-add (WSOLA), never
word slices. This can improve phrasing but cannot turn a spoken take into a
performed rap. Word timestamps after stretching are estimates, not realignment.
"""

from __future__ import annotations

from array import array
from difflib import SequenceMatcher
import io
import math
import re
import sys
import time
import wave

from rap_render import (BEATS_PER_BAR, MAX_SECONDS, _WORD_RE, _phrase_groups,
                        choose_alignment, render_rap, validate_plan,
                        words_from_alignment)

MIN_STRETCH = .80
MAX_STRETCH = 1.25
MELODY_PATTERNS = {"drone": (0,), "two_note": (0, 4), "rising": (0, 1, 2, 4),
                   "falling": (4, 2, 1, 0), "arpeggio": (0, 2, 4, 2),
                   "hook": (0, 0, 2, 4, 2, 1, 0, 4)}


def _numpy():
    try:
        import numpy
    except ImportError as error:
        raise RuntimeError("Bar fitting, vocal production and robot effects need NumPy; install it in the dashboard's Python environment") from error
    return numpy


def _wav(samples, sample_rate, channels=1):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as target:
        target.setnchannels(channels)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        target.writeframes(samples)
    return buffer.getvalue()


def match_loudness(wav_bytes, target_dbfs=-20.0):
    """Match gated 20 ms RMS, keeping at least 1 dB of peak headroom.

    This is active-signal RMS matching, not a LUFS measurement. Quiet padding
    does not make a slower example louder. Peak-limited examples disclose their
    lower achieved level so a listener is not promised an impossible match.
    """
    with wave.open(io.BytesIO(wav_bytes), "rb") as source:
        rate, channels, width = source.getframerate(), source.getnchannels(), source.getsampwidth()
        if width != 2 or channels not in (1, 2):
            raise ValueError("Comparison audio must be 16-bit mono or stereo WAV")
        samples = array("h")
        samples.frombytes(source.readframes(source.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        raise ValueError("Comparison audio is empty")
    block = max(1, round(rate * .020)) * channels
    powers = []
    for start in range(0, len(samples), block):
        part = samples[start:start + block]
        powers.append((sum(value * value for value in part), len(part)))
    max_power = max(total / count for total, count in powers)
    gate = max(32768 ** 2 * 10 ** (-60 / 10), max_power * 10 ** (-35 / 10))
    active = [(total, count) for total, count in powers if total / count >= gate]
    rms = math.sqrt(sum(total for total, _ in active) / sum(count for _, count in active)) if active else 0.0
    peak = max(abs(value) for value in samples)
    desired = 32768 * 10 ** (target_dbfs / 20) / rms if rms else 1.0
    ceiling = math.floor(32767 * 10 ** (-1 / 20))
    gain = min(desired, 10 ** (18 / 20), ceiling / peak if peak else 1.0)
    result = array("h", (round(value * gain) for value in samples))
    if sys.byteorder != "little":
        result.byteswap()
    metadata = {"method": "gated_active_rms", "target_dbfs": target_dbfs,
                "achieved_dbfs": 20 * math.log10(rms * gain / 32768) if rms else None,
                "gain_db": 20 * math.log10(gain), "peak_ceiling_dbfs": -1.0,
                "peak_limited": bool(peak and gain < desired and gain == ceiling / peak)}
    return _wav(result.tobytes(), rate, channels), metadata


def _without_delivery_tags(payload):
    """Expressive TTS may return zero-duration bracketed directions in alignment."""
    alignment = choose_alignment(payload)
    arrays = [alignment.get(key) for key in ("characters", "character_start_times_seconds", "character_end_times_seconds")]
    if not all(isinstance(items, list) for items in arrays) or not 0 < len(arrays[0]) <= 16000 or any(len(items) != len(arrays[0]) for items in arrays):
        raise ValueError("Character alignment must contain matching timestamp arrays")
    if any(not isinstance(char, str) or not char or len(char) > 32 for char in arrays[0]):
        raise ValueError("Character alignment contains an invalid character")
    source_text = "".join(alignment["characters"])
    spans = [match.span() for match in re.finditer(r"\[[^\]\n]{1,80}\]", source_text)]
    if not spans:
        return payload
    kept, offset = [], 0
    for index, char in enumerate(alignment["characters"]):
        end = offset + len(char)
        if not any(left <= offset and end <= right for left, right in spans):
            kept.append(index)
        offset = end
    return {key: [alignment[key][index] for index in kept] for key in (
        "characters", "character_start_times_seconds", "character_end_times_seconds")}


def _bound_terminal_alignment(payload, duration):
    """Repair at most 120 ms of provider timestamp drift at the final word.

    The complete PCM is kept. Only the final word/trailing punctuation may
    extend beyond it, and that word must actually begin inside the recording.
    Original type, monotonicity and word-duration validation still runs before
    this narrowly bounded correction; misplaced earlier words are rejected.
    """
    tolerance = .120
    alignment = choose_alignment(payload)
    words = words_from_alignment(payload, duration + tolerance)
    overrun = max(alignment["character_end_times_seconds"]) - duration
    if overrun <= 1e-9:
        return payload, 0.0
    if overrun > tolerance + 1e-9:
        raise ValueError("Speech alignment exceeds the audio by more than 120 ms")
    if words[-1]["source_start"] >= duration or any(word["source_end"] > duration for word in words[:-1]):
        raise ValueError("Only a final word starting inside the audio can have its endpoint adjusted")
    result = {"characters": list(alignment["characters"])}
    for key in ("character_start_times_seconds", "character_end_times_seconds"):
        result[key] = [min(value, duration) for value in alignment[key]]
    # Catch any zero-duration spoken word introduced by the final clamp.
    words_from_alignment(result, duration)
    return result, overrun


def _alignment_metadata(metadata, overrun):
    if overrun:
        metadata["alignment_end_clamped_seconds"] = overrun
        metadata.setdefault("warnings", []).append(
            f"The provider's final-word timestamp extended {round(overrun * 1000)} ms past the audio and was adjusted to its end; no audio was removed")


def stretch_phrase(samples, target_frames, sample_rate):
    """Pitch-preserving, exact-length WSOLA, with restrained duration ratios.

    A 40 ms frame advances by 20 ms in the destination. A local correlation
    search chooses phase-compatible source grains. The last grain explicitly
    contains the source tail, rather than truncating a word to hit the duration.
    """
    np = _numpy()
    samples = np.asarray(samples, dtype=np.float64)
    source_frames = len(samples)
    if source_frames == target_frames:
        return samples.copy()
    if source_frames < 1 or not isinstance(target_frames, int) or target_frames < 1:
        raise ValueError("Phrase lengths must be positive")
    ratio = target_frames / source_frames
    if ratio < MIN_STRETCH - 1e-4 or ratio > MAX_STRETCH + 1e-4:
        raise ValueError("Phrase stretch must stay between 0.8 and 1.25")
    frame = min(round(sample_rate * .040), source_frames, target_frames)
    if frame < 8 or min(source_frames, target_frames) < round(sample_rate * .080):
        # Tiny non-verbal fragments cannot support a useful WSOLA window.
        raise ValueError("Phrase is too short for pitch-preserving bar fitting")
    hop = frame // 2
    seek = round(sample_rate * .012)
    stride = max(1, sample_rate // 12000)
    output = np.zeros(target_frames, dtype=np.float64)
    output[:frame] = samples[:frame]
    # Distribute the final fractional hop across the phrase. A tiny last hop
    # would crossfade almost the entire tail instead of retaining its ending.
    steps = math.ceil((target_frames - frame) / hop)
    positions = [round(step * (target_frames - frame) / steps) for step in range(1, steps + 1)]
    previous_destination, previous_source = 0, 0
    for destination in positions:
        if destination <= previous_destination:
            continue
        overlap = previous_destination + frame - destination
        expected = round(destination * (source_frames - frame) / (target_frames - frame))
        if destination == target_frames - frame:
            source_at = source_frames - frame
        else:
            low = max(previous_source + 1, expected - seek, 0)
            high = min(source_frames - frame, expected + seek)
            if high < low:
                low = high = min(source_frames - frame, max(0, expected))
            reference = output[destination:destination + overlap:stride]
            candidates = samples[low:high + overlap:stride]
            if len(reference) < 2 or float(np.dot(reference, reference)) < 1e-12:
                source_at = min(high, max(low, expected))
            else:
                correlation = np.correlate(candidates, reference, mode="valid")
                squares = np.concatenate(([0.0], np.cumsum(candidates * candidates)))
                energy = squares[len(reference):] - squares[:-len(reference)]
                score = correlation / np.sqrt(np.maximum(energy, 1e-15))
                # Nearly periodic material has many equivalent phase matches;
                # prefer the nominal location to prevent systematic drift.
                offsets = low + np.arange(len(score)) * stride
                score -= abs(offsets - expected) / max(1, seek) * math.sqrt(float(np.dot(reference, reference))) * .002
                coarse = int(offsets[int(np.argmax(score))])
                fine_low, fine_high = max(low, coarse - stride), min(high, coarse + stride)
                full_reference = output[destination:destination + overlap]
                best_score, source_at = -math.inf, coarse
                for candidate in range(fine_low, fine_high + 1):
                    segment = samples[candidate:candidate + overlap]
                    value = float(np.dot(segment, full_reference)) / math.sqrt(max(1e-15, float(np.dot(segment, segment))))
                    if value > best_score:
                        best_score, source_at = value, candidate
        grain = samples[source_at:source_at + frame]
        if overlap:
            fade = np.linspace(0.0, 1.0, overlap, endpoint=False)
            output[destination:destination + overlap] *= 1.0 - fade
            output[destination:destination + overlap] += grain[:overlap] * fade
        output[destination + overlap:destination + frame] = grain[overlap:]
        previous_destination, previous_source = destination, source_at
    return output


def _bar_groups(words, payload, text):
    """Typed lines define bars; commas/breaths within a line stay continuous.

    If there are no explicit multiple lyric lines, the standard punctuation
    grouping remains useful. Normalized TTS sometimes removes line breaks, so
    recover their boundaries by matching words, never by assuming word counts.
    Overlapping timestamps remain a single phrase to avoid cutting either word.
    """
    typed = []
    for line_number, line in enumerate(text.splitlines()):
        typed.extend({"word": match.group(), "line": line_number} for match in _WORD_RE.finditer(line))
    if len({word["line"] for word in typed}) < 2:
        return _phrase_groups(words, payload, text)
    normalize = lambda word: word.casefold().replace("\u2019", "'")
    matcher = SequenceMatcher(None, [normalize(word["word"]) for word in typed],
                              [normalize(word["word"]) for word in words], autojunk=False)
    matched = {block.a + offset: block.b + offset for block in matcher.get_matching_blocks()
               for offset in range(block.size)}
    boundaries = set()
    for index in range(1, len(typed)):
        if typed[index - 1]["line"] == typed[index]["line"]:
            continue
        if index in matched:
            boundaries.add(matched[index])
        elif index - 1 in matched:
            boundaries.add(matched[index - 1] + 1)
    groups, first = [], 0
    for index in range(1, len(words)):
        if index in boundaries and words[index]["source_start"] - words[index - 1]["source_end"] >= .012:
            groups.append(words[first:index])
            first = index
    groups.append(words[first:])
    return groups


def _bar_audio(samples, payload, text, bpm, sample_rate):
    np = _numpy()
    words = words_from_alignment(payload, len(samples) / sample_rate)
    groups = _bar_groups(words, payload, text)
    cuts = [0] + [round((left[-1]["source_end"] + right[0]["source_start"]) * sample_rate / 2)
                  for left, right in zip(groups, groups[1:])] + [len(samples)]
    frames_per_bar = sample_rate * BEATS_PER_BAR * 60 / bpm
    phrases, timings, segments, total_bars = [], [], [], 0
    for index, group in enumerate(groups):
        start, end = cuts[index:index + 2]
        segment = samples[start:end]
        comfortable = [bars for bars in range(1, 65)
                       if MIN_STRETCH <= round(bars * frames_per_bar) / len(segment) <= MAX_STRETCH]
        bar_count = min(comfortable, key=lambda bars: abs(math.log(round(bars * frames_per_bar) / len(segment)))) if comfortable else max(1, math.ceil(len(segment) / frames_per_bar))
        destination = round(total_bars * frames_per_bar)
        target_end = round((total_bars + bar_count) * frames_per_bar)
        target_frames = target_end - destination
        ratio = target_frames / len(segment) if comfortable else 1.0
        if total_bars + bar_count > 64 or target_end / sample_rate > MAX_SECONDS:
            raise ValueError("Bar-fitted phrases exceed 120 seconds; shorten the text or use Natural flow")
        if comfortable and target_frames != len(segment):
            fitted = stretch_phrase(segment, target_frames, sample_rate)
        else:
            fitted = segment.copy()
        segments.append((destination, fitted))
        phrases.append({"source_start": group[0]["source_start"], "source_end": group[-1]["source_end"],
                        "source_audio_start": start / sample_rate, "source_audio_end": end / sample_rate,
                        "audio_start": destination / sample_rate, "audio_end": (destination + len(fitted)) / sample_rate,
                        "start": (destination + (group[0]["source_start"] * sample_rate - start) * ratio) / sample_rate,
                        "end": (destination + (group[-1]["source_end"] * sample_rate - start) * ratio) / sample_rate,
                        "bar": total_bars, "bars": bar_count, "beat": total_bars * BEATS_PER_BAR,
                        "stretch_ratio": ratio, "word_count": len(group),
                        "padding_seconds": (target_frames - len(fitted)) / sample_rate})
        for word in group:
            at = destination / sample_rate + (word["source_start"] - start / sample_rate) * ratio
            until = destination / sample_rate + (word["source_end"] - start / sample_rate) * ratio
            timings.append({"word": word["word"], "start": at, "end": until,
                            "beat": at * bpm / 60, "line": word["line"], "phrase": index,
                            "source_start": word["source_start"], "source_end": word["source_end"]})
        total_bars += bar_count
    output = np.zeros(round(total_bars * frames_per_bar), dtype=np.float64)
    for destination, segment in segments:
        output[destination:destination + len(segment)] = segment
    return output, {"duration_seconds": len(output) / sample_rate, "speech_duration_seconds": len(samples) / sample_rate,
                    "bars": total_bars, "beats_per_bar": BEATS_PER_BAR, "bpm": bpm,
                    "timing_mode": "bars", "phrase_offset_seconds": 0,
                    "word_timings": timings, "phrase_timings": phrases, "word_timings_estimated": True,
                    "stretch_method": "WSOLA", "stretch_limits": [MIN_STRETCH, MAX_STRETCH],
                    "warnings": ["Short phrases keep their natural duration and are padded to the next bar"] if any(phrase["padding_seconds"] > .05 for phrase in phrases) else []}


def _flow_audio(samples, payload, text, bpm, sample_rate):
    """Fit complete phrases to beat lengths, preserving every source segment.

    Typed lines stay together. Only when there is one line do punctuation and
    breath pauses define the phrases. Complete spans choose the nearest whole
    beat that permits gentle WSOLA; half beats are a fallback for short phrases.
    Room for the following preroll lets phrases follow without an extra empty
    beat. All prerolls and tails are retained; only unspoken edges get 3 ms fades.
    """
    np = _numpy()
    words = words_from_alignment(payload, len(samples) / sample_rate)
    groups = _bar_groups(words, payload, text)
    cuts = [0] + [round((left[-1]["source_end"] + right[0]["source_start"]) * sample_rate / 2)
                  for left, right in zip(groups, groups[1:])] + [len(samples)]
    frames_per_beat = sample_rate * 60 / bpm
    phrases, timings, segments, end = [], [], [], 0
    for index, group in enumerate(groups):
        first, last = cuts[index:index + 2]
        segment = samples[first:last]
        preroll = group[0]["source_start"] * sample_rate - first
        # Reserve enough space for the next phrase's preroll even if that
        # phrase takes the maximum allowed stretch. This avoids adding almost
        # a full beat merely because adjacent phrases have different prerolls.
        next_preroll = ((groups[index + 1][0]["source_start"] * sample_rate - last) * MAX_STRETCH
                        if index + 1 < len(groups) else 0)
        remaining = len(segment) - preroll
        candidates = []
        for step in (1., .5):
            candidates = [count * step for count in range(1, 513)
                          if MIN_STRETCH <= (count * step * frames_per_beat - next_preroll) / remaining <= MAX_STRETCH]
            if candidates:
                break
        beat_length = min(candidates, key=lambda beats: abs(math.log((beats * frames_per_beat - next_preroll) / remaining))) if candidates else None
        target_frames = round(len(segment) * (beat_length * frames_per_beat - next_preroll) / remaining) if beat_length else len(segment)
        # A very short fragment cannot support the 40 ms WSOLA analysis frame.
        if min(len(segment), target_frames) < round(sample_rate * .080):
            target_frames, beat_length = len(segment), None
        ratio = target_frames / len(segment)
        pre_frames = round(preroll * ratio)
        earliest_onset = end + pre_frames
        beat = max(0, math.ceil(earliest_onset / frames_per_beat))
        if beat and round((beat - 1) * frames_per_beat) >= earliest_onset:
            beat -= 1
        onset = round(beat * frames_per_beat)
        destination = onset - pre_frames
        end = destination + target_frames
        if end / sample_rate > MAX_SECONDS or end > round(64 * BEATS_PER_BAR * frames_per_beat):
            raise ValueError("Beat-flow phrases exceed 120 seconds; shorten the text or use Natural flow")
        fitted = stretch_phrase(segment, target_frames, sample_rate) if target_frames != len(segment) else segment.copy()
        fade_in = min(round(.003 * sample_rate), max(0, pre_frames))
        fade_out = min(round(.003 * sample_rate), max(0, round((last - group[-1]["source_end"] * sample_rate) * ratio)))
        if fade_in:
            fitted[:fade_in] *= np.linspace(0, 1, fade_in)
        if fade_out:
            fitted[-fade_out:] *= np.linspace(1, 0, fade_out)
        segments.append((destination, fitted))
        shift = onset / sample_rate - group[0]["source_start"] * ratio
        phrases.append({"source_start": group[0]["source_start"], "source_end": group[-1]["source_end"],
                        "source_audio_start": first / sample_rate, "source_audio_end": last / sample_rate,
                        "audio_start": destination / sample_rate, "audio_end": end / sample_rate,
                        "start": onset / sample_rate, "end": group[-1]["source_end"] * ratio + shift,
                        "beat": beat, "fit_beats": beat_length, "stretch_ratio": ratio,
                        "word_count": len(group), "fade_in_frames": fade_in, "fade_out_frames": fade_out})
        for word in group:
            at, until = word["source_start"] * ratio + shift, word["source_end"] * ratio + shift
            timings.append({"word": word["word"], "start": at, "end": until,
                            "beat": at * bpm / 60, "line": word["line"], "phrase": index,
                            "source_start": word["source_start"], "source_end": word["source_end"]})
    frames_per_bar = frames_per_beat * BEATS_PER_BAR
    bars = max(1, math.ceil(end / frames_per_bar))
    if bars > 1 and round((bars - 1) * frames_per_bar) >= end:
        bars -= 1
    total_frames = round(bars * frames_per_bar)
    if bars > 64 or total_frames / sample_rate > MAX_SECONDS:
        raise ValueError("Beat-flow phrases exceed 120 seconds; shorten the text or use Natural flow")
    output = np.zeros(total_frames, dtype=np.float64)
    for destination, fitted in segments:
        output[destination:destination + len(fitted)] = fitted
    return output, {"duration_seconds": total_frames / sample_rate,
                    "content_duration_seconds": end / sample_rate, "speech_duration_seconds": len(samples) / sample_rate,
                    "bars": bars, "beats_per_bar": BEATS_PER_BAR, "bpm": bpm,
                    "timing_mode": "beat_flow", "phrase_offset_seconds": 0,
                    "word_timings": timings, "phrase_timings": phrases,
                    "word_timings_estimated": any(phrase["stretch_ratio"] != 1 for phrase in phrases),
                    "stretch_method": "WSOLA", "stretch_limits": [MIN_STRETCH, MAX_STRETCH],
                    "warnings": ["Very short phrases keep their natural duration"] if any(phrase["fit_beats"] is None for phrase in phrases) else []}


def _produce(samples, sample_rate, doubling):
    np = _numpy()
    # Symmetric frequency-domain EQ: low-cut rumble, gentle presence, softer air.
    # Padding avoids circular wraparound from the end into the beginning.
    pad = round(sample_rate * .080)
    size = 1 << (len(samples) + 2 * pad - 1).bit_length()
    signal = np.pad(samples, (pad, size - len(samples) - pad))
    frequency = np.fft.rfftfreq(size, 1 / sample_rate)
    safe_frequency = np.maximum(frequency, .001)
    highpass = 1 / np.sqrt(1 + (85 / safe_frequency) ** 4)
    presence_db = 3 * np.exp(-.5 * (np.log2(safe_frequency / 2800) / .8) ** 2)
    air_db = -2 / (1 + (7000 / safe_frequency) ** 4)
    equalized = np.fft.irfft(np.fft.rfft(signal) * highpass * 10 ** ((presence_db + air_db) / 20), n=size)[pad:pad + len(samples)]
    step = max(1, round(sample_rate * .004))
    blocks = np.pad(equalized, (0, (-len(equalized)) % step)).reshape(-1, step)
    levels_db = 10 * np.log10(np.maximum(np.mean(blocks * blocks, axis=1), 1e-12))
    above = levels_db - (-24)
    knee, ratio = 6.0, 3.0
    reduction = np.where(above < -knee / 2, 0.0,
                         np.where(above > knee / 2, above * (1 - 1 / ratio),
                                  (above + knee / 2) ** 2 / (2 * knee) * (1 - 1 / ratio)))
    smooth, previous = [], 0.0
    for value in reduction:
        coefficient = math.exp(-step / sample_rate / (.008 if value > previous else .090))
        previous = coefficient * previous + (1 - coefficient) * value
        smooth.append(previous)
    gain_db = np.interp(np.arange(len(equalized)), (np.arange(len(smooth)) + .5) * step, smooth)
    compressed = equalized * 10 ** (-gain_db / 20)
    saturated = np.tanh(compressed * 1.3) / 1.3
    if doubling:
        left, right = saturated.copy(), saturated.copy()
        for output, delay in ((left, .011), (right, .017)):
            shift = round(delay * sample_rate)
            output[shift:] += .10 * saturated[:-shift]
        result = np.column_stack((left, right))
    else:
        result = saturated
    return result, {"eq": "85 Hz low cut, +3 dB presence, gentle high shelf",
                    "compression_ratio": 3, "compression_threshold_dbfs": -24,
                    "saturation": "mild", "doubling": bool(doubling), "doubling_wet": .10 if doubling else 0,
                    "channels": 2 if doubling else 1}


def render_experiment(pcm_bytes, alignment_payload, *, text, bpm, sample_rate=24000,
                      timing_mode="bars", produced=False, doubling=True):
    """Render a separate comparison WAV and inspectable timing/processing metadata."""
    validate_plan(text, bpm, timing_mode="natural")
    if timing_mode not in ("natural", "phrase_beats", "bars", "beat_flow"):
        raise ValueError("Experiment timing must be natural, phrase_beats, bars or beat_flow")
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or not 8000 <= sample_rate <= 48000:
        raise ValueError("Unsupported PCM sample rate")
    if not isinstance(pcm_bytes, (bytes, bytearray)) or not pcm_bytes or len(pcm_bytes) % 2:
        raise ValueError("Speech must be nonempty 16-bit mono PCM")
    if len(pcm_bytes) / 2 / sample_rate > MAX_SECONDS:
        raise ValueError("Speech is longer than the 120-second rap limit")
    alignment_payload = _without_delivery_tags(alignment_payload)
    alignment_payload, alignment_overrun = _bound_terminal_alignment(alignment_payload, len(pcm_bytes) / 2 / sample_rate)
    if timing_mode in ("natural", "phrase_beats"):
        audio, metadata = render_rap(pcm_bytes, alignment_payload, text=text, bpm=bpm,
                                     sample_rate=sample_rate, timing_mode=timing_mode)
        if not produced:
            audio, metadata["loudness"] = match_loudness(audio)
            metadata.update({"sample_rate": sample_rate, "channels": 1, "produced": False})
            _alignment_metadata(metadata, alignment_overrun)
            return audio, metadata
        np = _numpy()
        with wave.open(io.BytesIO(audio), "rb") as source:
            samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float64) / 32768
    else:
        np = _numpy()
        samples = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float64) / 32768
        render = _flow_audio if timing_mode == "beat_flow" else _bar_audio
        samples, metadata = render(samples, alignment_payload, text, float(bpm), sample_rate)
    channels = 1
    if produced:
        samples, metadata["production"] = _produce(samples, sample_rate, doubling)
        channels = metadata["production"]["channels"]
    # Avoid integer clipping before the common loudness pass, even for input
    # already at full scale. The relative waveform remains intact.
    peak = float(np.max(np.abs(samples)))
    pre_gain = min(1.0, .999 / peak) if peak else 1.0
    pcm = np.round(samples * pre_gain * 32767).astype("<i2").tobytes()
    audio, metadata["loudness"] = match_loudness(_wav(pcm, sample_rate, channels))
    metadata.update({"sample_rate": sample_rate, "channels": channels, "produced": bool(produced)})
    _alignment_metadata(metadata, alignment_overrun)
    return audio, metadata


def _robot_filter(samples, sample_rate, *, low=100, high=4000):
    """Smooth, padded frequency-domain filtering without circular end wrap."""
    np = _numpy()
    pad = round(sample_rate * .080)
    size = 1 << (len(samples) + 2 * pad - 1).bit_length()
    frequency = np.fft.rfftfreq(size, 1 / sample_rate)
    response = 1 / np.sqrt(1 + (low / np.maximum(frequency, .001)) ** 6)
    response *= 1 / np.sqrt(1 + (frequency / min(high, sample_rate * .47)) ** 8)
    response[0] = 0
    signal = np.pad(samples, (pad, size - len(samples) - pad))
    return np.fft.irfft(np.fft.rfft(signal) * response, n=size)[pad:pad + len(samples)]


def _vocode(samples, sample_rate):
    """Twelve speech-band envelopes modulate a fixed-pitch harmonic carrier.

    Analysis uses overlapping 43 ms windows every 10 ms. Carrier bands are
    periodic lookup tables, so synthesis needs no per-sample Python DSP loop.
    FFT batches stay bounded even for the longest permitted source recording.
    A small amount of high-frequency speech preserves consonants; this is an
    envelope vocoder, not pitch shifting or merely modulating the whole voice.
    """
    np = _numpy()
    frame = 1 << max(8, round(sample_rate * .043) - 1).bit_length()
    hop = max(1, round(sample_rate * .010))
    window = np.hanning(frame)
    padding = frame // 2
    signal = np.pad(samples, (padding, padding + hop))
    frames = np.lib.stride_tricks.sliding_window_view(signal, frame)[::hop]
    frequency = np.fft.rfftfreq(frame, 1 / sample_rate)
    # Mel spacing keeps even the lowest bands wider than one carrier harmonic.
    # Narrow log bands could miss the carrier entirely and lose low vowels.
    edges = 700 * np.expm1(np.linspace(math.log1p(80 / 700),
                                       math.log1p(min(8000, sample_rate * .47) / 700), 13))
    bands = [(frequency >= low) & (frequency < high) for low, high in zip(edges, edges[1:])]
    envelopes = np.zeros((len(frames), len(bands)))
    scale = 2 / (frame * float(np.sum(window ** 2)))
    for offset in range(0, len(frames), 128):
        spectrum = np.abs(np.fft.rfft(frames[offset:offset + 128] * window, axis=1)) ** 2
        for band_index, mask in enumerate(bands):
            envelopes[offset:offset + len(spectrum), band_index] = np.sqrt(np.sum(spectrum[:, mask], axis=1) * scale)
    # Rounded period keeps the carrier phase continuous for the entire clip.
    period = max(8, round(sample_rate / 120))
    carrier_frequency = np.fft.rfftfreq(period, 1 / sample_rate)
    harmonic = np.arange(len(carrier_frequency))
    positions = np.arange(len(samples))
    centers = np.arange(len(frames)) * hop
    result = np.zeros(len(samples))
    for band_index, (low, high) in enumerate(zip(edges, edges[1:])):
        mask = (carrier_frequency >= low) & (carrier_frequency < high)
        spectrum = np.where(mask, 1 / np.sqrt(np.maximum(harmonic, 1)), 0).astype(complex)
        carrier = np.fft.irfft(spectrum, n=period)
        rms = float(np.sqrt(np.mean(carrier ** 2)))
        if rms == 0:
            continue
        carrier /= rms
        envelope = np.interp(positions, centers, envelopes[:, band_index])
        result += envelope * carrier[positions % period]
    result += .15 * _robot_filter(samples, sample_rate, low=3000, high=8000)
    return result, {"analysis_bands": 12, "carrier_hz": sample_rate / period,
                    "consonant_mix": .15, "method": "multiband_envelope_vocoder"}


def _active_rms(samples, sample_rate):
    np = _numpy()
    block = max(1, round(sample_rate * .020))
    powers = np.mean(np.pad(samples, (0, (-len(samples)) % block)).reshape(-1, block) ** 2, axis=1)
    active = powers[powers >= max(1e-6, float(np.max(powers)) * 10 ** (-35 / 10))]
    return float(np.sqrt(np.mean(active))) if len(active) else 0.0


def _voice_pitch(samples, sample_rate):
    """Bounded, batched YIN-style difference analysis every 10 ms.

    The cumulative-mean difference test rejects aperiodic consonants. Its first
    good local minimum avoids the common lower-octave autocorrelation error.
    Based on de Cheveigne/Kawahara, doi:10.1121/1.1458024; this lightweight
    detector is intended for clean monophonic speech, not polyphonic music.
    """
    np = _numpy()
    hop = max(1, round(sample_rate * .010))
    frame = max(64, round(sample_rate * .050))
    minimum, maximum = max(2, math.floor(sample_rate / 600)), math.ceil(sample_rate / 65)
    padded = np.pad(samples, (frame // 2, frame // 2 + hop))
    frames = np.lib.stride_tricks.sliding_window_view(padded, frame)[::hop]
    frequencies = np.zeros(len(frames))
    power = np.empty(len(frames))
    for offset in range(0, len(frames), 128):
        batch = frames[offset:offset + 128]
        power[offset:offset + len(batch)] = np.mean(batch ** 2, axis=1)
    gate = max(1e-8, float(np.max(power)) * .000625)
    fft_size = 1 << (2 * frame - 1).bit_length()
    lags = np.arange(maximum + 1)
    for offset in range(0, len(frames), 128):
        batch = frames[offset:offset + 128]
        batch = batch - np.mean(batch, axis=1, keepdims=True)
        spectrum = np.fft.rfft(batch, n=fft_size, axis=1)
        correlation = np.fft.irfft(spectrum * np.conjugate(spectrum), n=fft_size, axis=1)[:, :maximum + 1]
        energy = np.pad(np.cumsum(batch ** 2, axis=1), ((0, 0), (1, 0)))
        difference = np.maximum(0, energy[:, frame - lags] + energy[:, -1:] - energy[:, lags] - 2 * correlation)
        # Compensate for fewer contributing samples at longer lags.
        difference /= frame - lags
        normalized = np.ones_like(difference)
        normalized[:, 1:] = difference[:, 1:] * lags[1:] / np.maximum(np.cumsum(difference[:, 1:], axis=1), 1e-20)
        for local, curve in enumerate(normalized):
            if power[offset + local] < gate:
                continue
            candidates = np.flatnonzero(curve[minimum:maximum] < .16)
            lag = minimum + int(candidates[0]) if len(candidates) else minimum + int(np.argmin(curve[minimum:maximum]))
            while lag < maximum - 1 and curve[lag + 1] < curve[lag]:
                lag += 1
            if curve[lag] > .28:
                continue
            left, center, right = curve[lag - 1:lag + 2]
            denominator = left - 2 * center + right
            adjustment = .5 * (left - right) / denominator if denominator else 0
            refined = lag + float(np.clip(adjustment, -.5, .5))
            frequencies[offset + local] = sample_rate / refined
    original = frequencies.copy()
    for index in range(len(frequencies)):
        neighbors = original[max(0, index - 1):index + 2]
        voiced = neighbors[neighbors > 0]
        # Isolated periodic frames in noisy consonants are not voice runs.
        if original[index] and len(voiced) >= 2:
            frequencies[index] = float(np.median(voiced))
        else:
            frequencies[index] = 0
    return np.arange(len(frames)) * hop, frequencies, hop


def _autotune(samples, sample_rate, key, scale, *, bpm=100, melody="follow", octave=3, note_beats=1):
    """Hard note correction using pitch-synchronous overlap-add.

    New pulses use quantized note periods but remain on the original timeline;
    each takes a bell-windowed grain from its nearest original pulse. Unvoiced
    regions are copied rather than synthesized. The resynthesis follows the
    principles documented at https://www.fon.hum.uva.nl/praat/manual/overlap-add.html
    and does not use Praat code or impose a fixed carrier voice.
    """
    np = _numpy()
    centers, pitch, hop = _voice_pitch(samples, sample_rate)
    scales = {"chromatic": tuple(range(12)), "minor": (0, 2, 3, 5, 7, 8, 10),
              "major": (0, 2, 4, 5, 7, 9, 11)}
    intervals = scales[scale]
    allowed = np.array([note for note in range(24, 97) if (note - key) % 12 in intervals])
    target_notes = np.zeros(len(pitch))
    previous = None
    melody_notes = None
    if melody == "follow":
        for index, frequency in enumerate(pitch):
            if not frequency:
                previous = None
                continue
            note = 69 + 12 * math.log2(frequency / 440)
            chosen = int(allowed[int(np.argmin(np.abs(allowed - note)))])
            # A ten-cent boundary margin prevents rapid two-note chatter.
            if previous is not None and chosen != previous and abs(previous - note) - abs(chosen - note) < .10:
                chosen = previous
            target_notes[index], previous = chosen, chosen
    else:
        # Fixed patterns are scale degrees, not semitone offsets. Chromatic
        # correction still allows every note in Follow; selected melodic
        # patterns use major degrees so their root/fifth shape stays musical.
        melody_scale = "major" if scale == "chromatic" else scale
        root_note = 12 * (octave + 1) + key
        melody_notes = [root_note + scales[melody_scale][degree] for degree in MELODY_PATTERNS[melody]]
        step_frames = sample_rate * 60 / bpm * note_beats
        steps = np.floor(centers / step_frames + 1e-9).astype(int) % len(melody_notes)
        target_notes = np.asarray(melody_notes)[steps]
    target_frequency = 440 * 2 ** ((target_notes - 69) / 12)
    voiced_mask = pitch > 0
    changes = np.diff(np.pad(voiced_mask.astype(int), (1, 1)))
    runs = zip(np.flatnonzero(changes == 1), np.flatnonzero(changes == -1))
    output = samples.copy()
    corrected_frames = 0
    def fractional(positions):
        lower = np.floor(positions).astype(int)
        fraction = positions - lower
        lower = np.clip(lower, 0, len(samples) - 1)
        return samples[lower] * (1 - fraction) + samples[np.minimum(lower + 1, len(samples) - 1)] * fraction
    for first, until in runs:
        if until - first < 3:
            continue
        start = max(0, int(centers[first] - hop // 2))
        end = min(len(samples), int(centers[until - 1] + hop // 2))
        if end - start < sample_rate * .030:
            continue
        local_centers, local_pitch = centers[first:until], pitch[first:until]
        first_period = sample_rate / local_pitch[0]
        search_end = min(end, start + round(first_period))
        pulse = float(start + int(np.argmax(np.abs(samples[start:search_end]))))
        source_pulses = [pulse]
        # Cross-correlation puts successive marks on matching waveform phase,
        # rather than assuming a glottal pulse is the largest positive sample.
        while pulse < end:
            period = sample_rate / float(np.interp(pulse, local_centers, local_pitch))
            expected = pulse + period
            half = max(3, round(period * .45))
            low = max(math.ceil(pulse + 1), start + half, round(expected - period * .20))
            high = min(end - half - 1, round(expected + period * .20))
            if high < low or pulse - half < start:
                candidate = expected
                if candidate >= end:
                    break
            else:
                reference = fractional(pulse + np.arange(-half, half + 1))
                candidates = samples[low - half:high + half + 1]
                correlation = np.correlate(candidates, reference, mode="valid")
                energy = np.concatenate(([0.], np.cumsum(candidates ** 2)))
                energy = energy[len(reference):] - energy[:-len(reference)]
                score = correlation / np.sqrt(np.maximum(energy * float(np.dot(reference, reference)), 1e-20))
                score -= .03 * np.abs(np.arange(low, high + 1) - expected) / period
                best = int(np.argmax(score))
                correction = 0
                if 0 < best < len(score) - 1:
                    a, b, c = score[best - 1:best + 2]
                    denominator = a - 2 * b + c
                    correction = float(np.clip(.5 * (a - c) / denominator, -.5, .5)) if denominator else 0
                candidate = low + best + correction
            source_pulses.append(candidate)
            pulse = candidate
        if len(source_pulses) < 3:
            continue
        source_pulses = np.array(source_pulses)
        synthesized, weight = np.zeros(end - start), np.zeros(end - start)
        target = float(source_pulses[0])
        while target < end:
            at = round(target)
            frame_index = min(until - 1, max(first, int((target + hop / 2) // hop)))
            if melody_notes is None:
                target_period = sample_rate / target_frequency[frame_index]
            else:
                note_index = math.floor(target / step_frames + 1e-9) % len(melody_notes)
                target_period = sample_rate / (440 * 2 ** ((melody_notes[note_index] - 69) / 12))
            index = int(np.searchsorted(source_pulses, target))
            if index == len(source_pulses) or (index > 0 and target - source_pulses[index - 1] < source_pulses[index] - target):
                index -= 1
            source_at = float(source_pulses[index])
            source_period = sample_rate / float(np.interp(source_at, local_centers, local_pitch))
            left_period = source_at - source_pulses[index - 1] if index else source_period
            right_period = source_pulses[index + 1] - source_at if index + 1 < len(source_pulses) else source_period
            left = max(1, round(min(left_period, target_period)))
            right = max(1, round(min(right_period, target_period)))
            offsets = np.arange(-left, right + 1)
            relative = offsets + at - target
            window = np.cos(np.pi * relative / (2 * np.where(relative < 0, left, right))) ** 2
            valid = (source_at + relative >= start) & (source_at + relative < end) & (at + offsets >= start) & (at + offsets < end)
            offsets, relative, window = offsets[valid], relative[valid], window[valid]
            destination = at + offsets - start
            synthesized[destination] += fractional(source_at + relative) * window
            weight[destination] += window
            target += target_period
        if melody_notes is None:
            valid = weight > .1
            synthesized[valid] /= weight[valid]
            synthesized[~valid] = samples[start:end][~valid]
        else:
            # Large downward moves can leave space between pulse windows.
            # Keep their smooth bell edges instead of inserting original-pitch
            # speech in the gaps. This deliberately makes extreme corrections
            # more synthetic while preserving the syllable envelope/timeline.
            synthesized /= np.maximum(weight, 1)
        fade = min(round(sample_rate * .008), (end - start) // 2)
        mix = np.ones(end - start)
        if fade:
            mix[:fade] = np.linspace(0, 1, fade)
            mix[-fade:] = np.linspace(1, 0, fade)
        output[start:end] = samples[start:end] * (1 - mix) + synthesized * mix
        corrected_frames += end - start
    corrected = pitch > 0
    cents = 1200 * np.log2(target_frequency[corrected] / pitch[corrected])
    metadata = {"method": "pitch_synchronous_note_correction", "pitch_detector": "YIN_difference",
                "key": key, "scale": scale, "voiced_fraction": corrected_frames / len(samples),
                "target_midi_notes": sorted(set(int(note) for note in target_notes[corrected])),
                "mean_correction_cents": float(np.mean(np.abs(cents))) if len(cents) else 0,
                "pitch_range_hz": [65, 600], "retune_ms": 0, "melody": melody,
                "octave": octave, "note_beats": float(note_beats)}
    if melody_notes is not None:
        metadata.update({"melody_scale": melody_scale, "melody_midi_notes": melody_notes,
                         "melody_step_seconds": 60 / bpm * note_beats, "melody_bpm": float(bpm)})
    return output, metadata


def render_fast_voice(pcm_bytes, alignment_payload, *, text, bpm, sample_rate=24000,
                      robot=False, robot_style="metallic", robot_amount=.8,
                      robot_tone_hz=4000, robot_key=0, robot_scale="minor",
                      robot_melody="follow", robot_octave=3, robot_note_beats=1,
                      robot_rhythm="natural"):
    """Render a fast speech take with optional whole-phrase timing and effects.

    Natural retains the complete original recording. Phrases places intact
    phrases on beats, and flow gently stretches whole phrases to beat lengths.
    No mode slices individual words. Every mode is padded to transport bars.
    Robot amount zero returns the exact dry WAV for the selected rhythm mode.
    """
    started = time.perf_counter()
    if not isinstance(robot, bool):
        raise ValueError("Robot must be true or false")
    if not isinstance(robot_rhythm, str) or robot_rhythm not in ("natural", "phrases", "flow"):
        raise ValueError("Robot rhythm must be natural, phrases or flow")
    if robot_style not in ("metallic", "radio", "vocoder", "autotune"):
        raise ValueError("Robot style must be metallic, radio, autotune or vocoder")
    if isinstance(robot_key, bool) or not isinstance(robot_key, int) or not 0 <= robot_key <= 11:
        raise ValueError("Robot key must be an integer between 0 and 11")
    if robot_scale not in ("chromatic", "minor", "major"):
        raise ValueError("Robot scale must be chromatic, minor or major")
    if not isinstance(robot_melody, str) or (robot_melody != "follow" and robot_melody not in MELODY_PATTERNS):
        raise ValueError("Robot melody must be follow, drone, two_note, rising, falling, arpeggio or hook")
    if isinstance(robot_octave, bool) or not isinstance(robot_octave, int) or not 2 <= robot_octave <= 5:
        raise ValueError("Robot octave must be an integer between 2 and 5")
    if isinstance(robot_note_beats, bool) or not isinstance(robot_note_beats, (int, float)) or robot_note_beats not in (.5, 1, 2):
        raise ValueError("Robot note beats must be 0.5, 1 or 2")
    for name, value, low, high in (("Robot amount", robot_amount, 0, 1),
                                   ("Robot tone", robot_tone_hz, 800, 8000)):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f"{name} must be between {low} and {high}")
    audio, metadata = render_experiment(pcm_bytes, alignment_payload, text=text, bpm=bpm,
                                        sample_rate=sample_rate,
                                        timing_mode={"natural": "natural", "phrases": "phrase_beats", "flow": "beat_flow"}[robot_rhythm])
    metadata["rhythm_mode"] = robot_rhythm
    if robot_rhythm != "natural":
        metadata["content_duration_seconds"] = metadata["phrase_timings"][-1]["audio_end"]
    metadata["robot"] = {"enabled": robot, "style": robot_style, "amount": float(robot_amount),
                         "tone_hz": float(robot_tone_hz), "applied": bool(robot and robot_amount),
                         "key": robot_key, "scale": robot_scale, "melody": robot_melody,
                         "octave": robot_octave, "note_beats": float(robot_note_beats), "rhythm": robot_rhythm}
    if not robot or robot_amount == 0:
        metadata["processing_seconds"] = time.perf_counter() - started
        return audio, metadata
    np = _numpy()
    with wave.open(io.BytesIO(audio), "rb") as source:
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float64) / 32768
    source_frames = round(metadata["content_duration_seconds"] * sample_rate) if robot_rhythm != "natural" else len(pcm_bytes) // 2
    dry = samples[:source_frames]
    if robot_style == "metallic":
        seconds = np.arange(source_frames) / sample_rate
        carrier = .75 * np.sin(2 * np.pi * 70 * seconds) + .25 * np.sin(2 * np.pi * 131 * seconds)
        wet = np.tanh(dry * 2.2) * carrier
        metadata["robot"].update({"method": "dual_carrier_ring_modulation", "carrier_hz": [70, 131], "drive": 2.2})
    elif robot_style == "radio":
        bandpassed = _robot_filter(dry, sample_rate, low=420, high=min(robot_tone_hz, 3200))
        driven = np.tanh(bandpassed * 7)
        hold = max(1, round(sample_rate / 6000))
        wet = np.repeat(driven[::hold], hold)[:source_frames]
        # Keep a continuous path beneath the quantizer so a quiet syllable
        # cannot disappear merely because it falls below one integer step.
        wet = .8 * np.round(wet * 31) / 31 + .2 * wet
        metadata["robot"].update({"method": "bandpass_drive_bitcrush", "drive": 7, "bit_depth": 6,
                                   "bitcrush_mix": .8, "sample_hold_hz": sample_rate / hold, "highpass_hz": 420})
    elif robot_style == "autotune":
        wet, details = _autotune(dry, sample_rate, robot_key, robot_scale, bpm=float(bpm),
                                 melody=robot_melody, octave=robot_octave, note_beats=float(robot_note_beats))
        metadata["robot"].update(details)
    else:
        wet, details = _vocode(dry, sample_rate)
        metadata["robot"].update(details)
    wet = _robot_filter(wet, sample_rate, low=100, high=robot_tone_hz)
    dry_rms, wet_rms = _active_rms(dry, sample_rate), _active_rms(wet, sample_rate)
    if wet_rms:
        wet *= min(16, dry_rms / wet_rms)
    # Only the processed branch fades. Dry amount zero bypasses this entirely.
    fade_frames = min(round(sample_rate * .003), source_frames // 2)
    if fade_frames:
        fade = np.linspace(0, 1, fade_frames)
        wet[:fade_frames] *= fade
        wet[-fade_frames:] *= fade[::-1]
    if robot_rhythm != "natural":
        # Filtering can regrow a small edge after the timing pass's fade.
        # Reapply it only to wet audio in unspoken prerolls and tails.
        for phrase in metadata["phrase_timings"]:
            first, last = round(phrase["audio_start"] * sample_rate), round(phrase["audio_end"] * sample_rate)
            fade_in, fade_out = phrase.get("fade_in_frames", 0), phrase.get("fade_out_frames", 0)
            if fade_in:
                wet[first:first + fade_in] *= np.linspace(0, 1, fade_in)
            if fade_out:
                wet[last - fade_out:last] *= np.linspace(1, 0, fade_out)
    samples[:source_frames] = dry * (1 - robot_amount) + wet * robot_amount
    if robot_rhythm != "natural":
        # FFT filtering must not ring into newly inserted scheduling gaps, nor
        # must processing stop at the old source length and omit later phrases.
        cursor = 0
        for phrase in metadata["phrase_timings"]:
            first, last = round(phrase["audio_start"] * sample_rate), round(phrase["audio_end"] * sample_rate)
            samples[cursor:first] = 0
            cursor = last
        samples[cursor:] = 0
    peak = float(np.max(np.abs(samples)))
    gain = min(1.0, .999 / peak) if peak else 1.0
    pcm = np.round(samples * gain * 32767).astype("<i2").tobytes()
    audio, metadata["loudness"] = match_loudness(_wav(pcm, sample_rate))
    metadata["processing_seconds"] = time.perf_counter() - started
    return audio, metadata
