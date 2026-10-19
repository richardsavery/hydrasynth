"""Prepare natural voice or continuous phrases for beat-synced playback.

Character-to-word alignment is adapted from the user's sibling
``rapping_2026/src/anchor_rap_voice/alignment.py``. That project's audible path
preserves a continuous voice performance and starts it on a downbeat; its timing
map does not split or stretch individual words. This renderer follows that
approach, retaining the complete PCM and adding silence only after the phrase
so it can loop on whole 4/4 bars. The dashboard schedules the downbeat start.
The optional phrase-beat mode moves complete phrases to quarter-note onsets;
it never cuts, stretches or inserts silence between words inside a phrase.
No Max, FFmpeg or package from the sibling checkout is required.
"""

from __future__ import annotations

import io
import math
import re
import struct
import wave
from difflib import SequenceMatcher

MAX_SECONDS = 120.0
MAX_WORDS = 300
BEATS_PER_BAR = 4
_JOINERS = {"'", "\u2019", "-"}
_WORD_RE = re.compile(r"[^\W_]+(?:['\u2019-][^\W_]+)*")
_ABBREVIATIONS = {"mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "eg", "ie", "no", "fig"}
TIMING_MODES = {"natural", "phrase_beats"}


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    return float(value)


def choose_alignment(payload):
    """Prefer original text timestamps to retain line breaks and typed words."""
    if not isinstance(payload, dict):
        raise ValueError("Speech response has no character alignment")
    candidates = [payload] if "characters" in payload else [
        payload.get("alignment"), payload.get("normalized_alignment")
    ]
    for candidate in candidates:
        if isinstance(candidate, dict) and candidate.get("characters"):
            return candidate
    raise ValueError("Speech response has no character alignment")


def words_from_alignment(payload, duration):
    alignment = choose_alignment(payload)
    chars = alignment.get("characters")
    starts = alignment.get("character_start_times_seconds")
    ends = alignment.get("character_end_times_seconds")
    if not all(isinstance(items, list) for items in (chars, starts, ends)):
        raise ValueError("Character alignment must contain timestamp arrays")
    if not len(chars) == len(starts) == len(ends) or not 0 < len(chars) <= 16000:
        raise ValueError("Character alignment arrays have different or unsupported lengths")
    words, pieces = [], []
    start, end, line = 0.0, 0.0, 0
    char_offset = word_char_start = word_char_end = 0
    previous_start = previous_end = 0.0

    def flush():
        nonlocal pieces
        word = "".join(pieces).strip("'-\u2019")
        if word and any(char.isalnum() for char in word):
            words.append({"word": word, "source_start": start, "source_end": end, "line": line,
                          "char_start": word_char_start, "char_end": word_char_end})
        pieces = []

    for index, char in enumerate(chars):
        if not isinstance(char, str) or not char or len(char) > 32:
            raise ValueError("Character alignment contains an invalid character")
        char_start = _number(starts[index], "Character start")
        char_end = _number(ends[index], "Character end")
        if char_start < 0 or char_end < char_start or char_end > duration + 0.05:
            raise ValueError("Character timestamps lie outside the speech audio")
        if char_start + 1e-6 < previous_start or char_end + 1e-6 < previous_end:
            raise ValueError("Character timestamps must be in order")
        previous_start, previous_end = char_start, char_end
        if any(part.isalnum() for part in char) or char in _JOINERS:
            if not pieces:
                start = char_start
                word_char_start = char_offset
            end = min(duration, char_end)
            word_char_end = char_offset + len(char)
            pieces.append(char)
        else:
            flush()
            line += char.count("\n")
        char_offset += len(char)
    flush()
    if not words or len(words) > MAX_WORDS:
        raise ValueError(f"Rap needs between 1 and {MAX_WORDS} spoken words")
    if any(word["source_end"] <= word["source_start"] for word in words):
        raise ValueError("Speech response has a word with no usable duration")
    return words


def validate_plan(text, bpm, bars=None, timing_mode="natural"):
    """Check bounded input before speech synthesis; its duration is not known yet."""
    bpm = _number(bpm, "BPM")
    if not 40 <= bpm <= 240:
        raise ValueError("BPM must be between 40 and 240")
    if not isinstance(timing_mode, str) or timing_mode not in TIMING_MODES:
        raise ValueError("Timing mode must be natural or phrase_beats")
    if not isinstance(text, str) or not text.strip() or len(text) > 2000:
        raise ValueError("Rap text must contain 1 to 2000 characters")
    if bars is not None and (isinstance(bars, bool) or not isinstance(bars, int) or not 1 <= bars <= 64):
        raise ValueError("Bars must be an integer between 1 and 64, or Auto")
    count = len(_WORD_RE.findall(text))
    if not 0 < count <= MAX_WORDS:
        raise ValueError(f"Rap needs between 1 and {MAX_WORDS} spoken words")
    duration = bars * BEATS_PER_BAR * 60 / bpm if bars is not None else None
    if duration is not None and duration > MAX_SECONDS:
        raise ValueError("Rap would exceed 120 seconds; use fewer bars or increase BPM")
    return {"bars": bars, "word_count": count, "duration_seconds": duration}


def _punctuation_boundary(text, left, right):
    """Punctuation between words, excluding numbers, titles and initials."""
    gap = text[left["char_end"]:right["char_start"]]
    for offset, char in enumerate(gap):
        at = left["char_end"] + offset
        before = text[at - 1] if at else ""
        after = text[at + 1] if at + 1 < len(text) else ""
        if char in "\n\r;!?":
            return True
        if char in ",:." and before.isdigit() and after.isdigit():
            continue  # 1,000, 3.14 and 12:30 are not multiple phrases.
        if char in ",:":
            return True
        if char == ".":
            normalized = left["word"].casefold().strip("'.\u2019")
            if normalized in _ABBREVIATIONS or len(normalized) == 1:
                continue
            return True
    return False


def _phrase_groups(words, alignment_payload, text):
    source_text = "".join(choose_alignment(alignment_payload)["characters"])
    boundaries = {index for index in range(1, len(words))
                  if _punctuation_boundary(source_text, words[index - 1], words[index])}
    # Normalized TTS can remove punctuation or expand numbers. Recover only
    # boundaries anchored to matching words; never guess from word counts.
    typed = [{"word": match.group(), "char_start": match.start(), "char_end": match.end()}
             for match in _WORD_RE.finditer(text)]
    normalize = lambda word: word.casefold().replace("\u2019", "'")
    matcher = SequenceMatcher(None, [normalize(word["word"]) for word in typed],
                              [normalize(word["word"]) for word in words], autojunk=False)
    matched = {block.a + offset: block.b + offset for block in matcher.get_matching_blocks()
               for offset in range(block.size)}
    for index in range(1, len(typed)):
        if not _punctuation_boundary(text, typed[index - 1], typed[index]):
            continue
        if index in matched:
            boundaries.add(matched[index])
        elif index - 1 in matched:
            boundaries.add(matched[index - 1] + 1)
    groups = []
    first = 0
    for index in range(1, len(words)):
        gap = words[index]["source_start"] - words[index - 1]["source_end"]
        # With overlapping word estimates there is no safe phrase cut. Keep
        # that run together rather than truncating either word's voiced tail.
        if gap >= .012 and (index in boundaries or gap >= .35):
            groups.append(words[first:index])
            first = index
    groups.append(words[first:])
    return groups


def _phrase_layout(words, alignment_payload, text, sample_rate, source_frames, bpm):
    groups = _phrase_groups(words, alignment_payload, text)
    cuts = [0] + [round((left[-1]["source_end"] + right[0]["source_start"]) * sample_rate / 2)
                  for left, right in zip(groups, groups[1:])] + [source_frames]
    frames_per_beat = sample_rate * 60.0 / bpm
    phrases, timings, end = [], [], 0
    for index, group in enumerate(groups):
        cut_start, cut_end = cuts[index:index + 2]
        onset_frame = round(group[0]["source_start"] * sample_rate)
        earliest_onset = end + onset_frame - cut_start
        beat = max(0, math.ceil(earliest_onset / frames_per_beat))
        if beat and round((beat - 1) * frames_per_beat) >= earliest_onset:
            beat -= 1
        offset_frames = round(beat * frames_per_beat) - onset_frame
        audio_start, end = cut_start + offset_frames, cut_end + offset_frames
        if end > round(MAX_SECONDS * sample_rate):
            raise ValueError("Beat-aligned phrases exceed 120 seconds; shorten the text")
        # Metadata anchors the onset to the same sample as the audio scheduler.
        shift = round(beat * frames_per_beat) / sample_rate - group[0]["source_start"]
        phrases.append({"source_start": group[0]["source_start"], "source_end": group[-1]["source_end"],
                        "start": group[0]["source_start"] + shift, "end": group[-1]["source_end"] + shift,
                        "audio_start": audio_start / sample_rate, "audio_end": end / sample_rate,
                        "source_audio_start": cut_start / sample_rate, "source_audio_end": cut_end / sample_rate,
                        "word_count": len(group), "beat": beat,
                        "fade_in_frames": min(round(.003 * sample_rate), max(0, onset_frame - cut_start)),
                        "fade_out_frames": min(round(.003 * sample_rate), max(0, cut_end - round(group[-1]["source_end"] * sample_rate)))})
        for word in group:
            timings.append({"word": word["word"], "start": word["source_start"] + shift,
                            "end": word["source_end"] + shift, "beat": (word["source_start"] + shift) * bpm / 60,
                            "line": word["line"], "phrase": index,
                            "source_start": word["source_start"], "source_end": word["source_end"]})
    return phrases, timings, end


def _place_phrases(pcm_bytes, phrases, target_frames, sample_rate):
    output = bytearray(target_frames * 2)
    for phrase in phrases:
        source_start = round(phrase["source_audio_start"] * sample_rate)
        source_end = round(phrase["source_audio_end"] * sample_rate)
        segment = bytearray(pcm_bytes[source_start * 2:source_end * 2])
        # Apply at most 3 ms only at the outer phrase edges and only where the
        # timestamped words leave room. All words and internal pauses are exact.
        for edge, size in (("in", phrase["fade_in_frames"]), ("out", phrase["fade_out_frames"])):
            for index in range(size):
                position = index * 2 if edge == "in" else len(segment) - 2 - index * 2
                sample = struct.unpack_from("<h", segment, position)[0]
                struct.pack_into("<h", segment, position, round(sample * (index + 1) / size))
        destination = round(phrase["audio_start"] * sample_rate) * 2
        output[destination:destination + len(segment)] = segment
    return output


def render_rap(pcm_bytes, alignment_payload, *, text, bpm, sample_rate=16000, bars=None, timing_mode="natural"):
    """Return continuous voice padded to an exact 4/4 loop duration.

    Voice audio and every pause within it are preserved sample for sample. BPM
    controls the bar-length padding, while the playback transport schedules the
    complete clip on its next downbeat. Phrase-beat mode additionally places
    complete punctuation/pause-delimited phrases on quarter-note onsets. Neither
    mode moves words individually or stretches the voice.
    """
    validate_plan(text, bpm, bars, timing_mode)
    bpm = float(bpm)
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or not 8000 <= sample_rate <= 48000:
        raise ValueError("Unsupported PCM sample rate")
    if not isinstance(pcm_bytes, (bytes, bytearray)) or not pcm_bytes or len(pcm_bytes) % 2:
        raise ValueError("Speech must be nonempty 16-bit mono PCM")
    source_frames = len(pcm_bytes) // 2
    duration = source_frames / sample_rate
    if duration > MAX_SECONDS:
        raise ValueError("Speech is longer than the 120-second rap limit")
    words = words_from_alignment(alignment_payload, duration)
    phrases = []
    content_frames = source_frames
    if timing_mode == "phrase_beats":
        phrases, timings, content_frames = _phrase_layout(words, alignment_payload, text, sample_rate, source_frames, bpm)
    else:
        timings = [{"word": word["word"], "start": word["source_start"],
                    "end": word["source_end"], "beat": word["source_start"] * bpm / 60.0,
                    "line": word["line"], "source_start": word["source_start"],
                    "source_end": word["source_end"]} for word in words]
    frames_per_bar = sample_rate * BEATS_PER_BAR * 60.0 / bpm
    if bars is None:
        # Determine the smallest whole number of bars whose rounded PCM length
        # contains the complete source. Never remove its tail to make it fit.
        total_bars = max(1, math.ceil(content_frames / frames_per_bar))
        if total_bars > 1 and round((total_bars - 1) * frames_per_bar) >= content_frames:
            total_bars -= 1
    else:
        total_bars = bars
    target_frames = round(total_bars * frames_per_bar)
    if target_frames < content_frames:
        raise ValueError("The natural voice is longer than the requested bars; use Auto bars or more bars")
    if total_bars > 64 or target_frames / sample_rate > MAX_SECONDS:
        raise ValueError("Rap would exceed 120 seconds; shorten the text or change BPM")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as destination:
        destination.setnchannels(1)
        destination.setsampwidth(2)
        destination.setframerate(sample_rate)
        if timing_mode == "phrase_beats":
            destination.writeframes(_place_phrases(pcm_bytes, phrases, target_frames, sample_rate))
        else:
            destination.writeframes(pcm_bytes)
            destination.writeframes(b"\x00\x00" * (target_frames - source_frames))
    return buffer.getvalue(), {"duration_seconds": target_frames / sample_rate,
                              "speech_duration_seconds": duration, "bars": total_bars,
                              "beats_per_bar": BEATS_PER_BAR, "bpm": bpm,
                              "timing_mode": timing_mode, "phrase_offset_seconds": 0,
                              "word_timings": timings, "phrase_timings": phrases, "warnings": []}
