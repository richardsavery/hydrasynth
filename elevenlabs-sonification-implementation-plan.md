# Standalone data sonification with ElevenLabs

Implementation plan · 8 October 2026

## 1. First outcome

Build a local application that converts a time-series recording into music whose sections reflect changes in the data. Start with a 60-second recording, two mappings, and six 10-second musical sections. Display the data, the generated instructions, and the resulting audio together.

The app is independent of the Hydrasynth project. Its inputs are numeric recordings; its output is an audio file plus an explanation of how the data shaped it. This document specifies a proposed implementation; the app has not been built or tested against a paid ElevenLabs account.

**First experiment:** can a listener distinguish low and high activity when activity controls the requested musical density? Establish that before building a large mapping interface.

## 2. Decisions for the prototype

| Area | Initial decision |
| --- | --- |
| Deployment | Single-user local app, bound to `127.0.0.1` |
| Backend | Python, FastAPI, HTTPX; NumPy for feature calculations |
| Audio validation | FFmpeg for decode checks; ffprobe for duration and format inspection |
| Frontend | Plain HTML, CSS, and JavaScript; native audio player and canvas plots |
| Input | CSV and flat JSONL, with an explicit timestamp column and numeric channels |
| Data duration | Default 60-second selection; longer recordings can be cropped |
| Time mapping | One second of source data maps to one second of music |
| Musical sections | Default 10 seconds; respect provider limits below |
| Mappings | Activity → density; variability → articulation |
| Musical anchors | One chosen style, requested 100 BPM, requested D minor throughout |
| Generation | One composition-plan request for the whole selection |
| Model | Explicitly select `music_v2_5` |
| Persistence | Files for inputs/plans/audio; SQLite for job records |
| Concurrency | One generation job at a time |
| Live input | A later milestone after recorded-data mappings work |

Use deterministic rules to translate features into styles. A separate language model is unnecessary for the first version and would make it harder to trace why a musical instruction changed.

## 3. What the API can control

The compose API accepts a prompt or a composition plan and returns audio. Use the plan route for this project. With `music_v2_5`, plans contain ordered chunks with `duration_ms`, `text`, `positive_styles`, `negative_styles`, and `context_adherence`. [1][2]

| Property | Implementation treatment |
| --- | --- |
| Section duration | Explicit milliseconds; retain the requested section timeline |
| Density, register, articulation, instrumentation | Musical directions expressed through styles; validate by listening |
| BPM and key | Requested style anchors, not measured or guaranteed numerical outputs |
| Instrumental result | Request instrumental styles and exclude vocals/lyrics; verify the result |
| Precise notes or event onsets | No direct note/event control in this generation interface |
| Live changes during generation | The documented stream endpoint delivers audio from a submitted request; it has no ongoing sensor-control input [3] |

Validate these documented plan limits: 1–30 chunks, 3–120 seconds per chunk, and 3–600 seconds overall. Styles must be English; each positive/negative style list allows up to 50 entries. [2]

For a composition-plan request, omit `prompt`, `music_length_ms`, and `force_instrumental`. The latter two belong to prompt-based requests. The API's default model is currently `music_v1`, so always send the chosen model explicitly. [1]

This first version produces an expressive interpretation of data. Treat a mapping as successful only when its audible effect survives listening tests.

## 4. Data preparation and feature extraction

### Input contract

Start with a small flat format:

```csv
t_seconds,joint_a_velocity,joint_b_velocity
0.0,0.10,-0.04
0.1,0.12,-0.06
0.2,0.09,-0.03
```

Equivalent JSONL:

```jsonl
{"t_seconds":0.0,"joint_a_velocity":0.10,"joint_b_velocity":-0.04}
{"t_seconds":0.1,"joint_a_velocity":0.12,"joint_b_velocity":-0.06}
{"t_seconds":0.2,"joint_a_velocity":0.09,"joint_b_velocity":-0.03}
```

These are format examples, not full test recordings. Generate longer fixtures for validation.

The import UI selects the timestamp field, timestamp units, source channels, and their meaning: velocity, position, or generic scalar. Implement an explicit adapter for nested RAPP data later; do not silently guess tensor axes or timestamp units.

### Canonicalize the timeline

1. Convert timestamps to elapsed seconds and sort them. Report whether sorting changed input order.
2. For duplicate timestamps, keep the last row and report the count.
3. Reject non-finite timestamps; mark missing or non-finite channel values as unavailable.
4. Resample selected channels onto a shared grid. Start at 10 Hz for movement data; retain this setting in the session.
5. Interpolate only across short gaps. Default the maximum gap to the larger of 0.5 seconds or three median input intervals; make it configurable.
6. Average or filter when reducing a much faster source rate. Keep missing-data masks through resampling.
7. Block generation for sections with less than 90% valid coverage. Let the user crop the selection or repair the source; never equate missing data with stillness.

### Transform channels into a movement signal

For velocity channels, use absolute speed. For position channels, estimate change per elapsed second, then use its magnitude. Smooth noisy positions before differentiating. For a generic scalar, retain its value unless the user explicitly selects a change-based interpretation.

Normalize each channel before combining channels with different units:

```text
z(t) = clip((q(t) - lower_bound) / (upper_bound - lower_bound), 0, 1)
```

Use fixed physical bounds when known. Otherwise fit the 5th and 95th percentiles once across the selected baseline and save them. Reuse that baseline when comparing recordings. Report the percentage of clipped values. If both bounds are equal, report a degenerate normalization range and ask for explicit bounds or exclude the channel. Only label it constant if its finite minimum and maximum also match: sparse spikes can collapse percentile bounds despite changing data. Do not divide by zero or silently invent activity.

For multiple comparable movement channels, combine normalized values with RMS at each time step. Use the same selected channel set across all sections.

### Compute section features

For each default 10-second window, retain source start/end times, valid coverage, and:

| Feature | Calculation | Initial use |
| --- | --- | --- |
| Activity | Mean of the normalized movement signal | Sparse to dense arrangement |
| Variability | Standard deviation of that signal | Sustained to articulated texture |
| Trend | Fitted slope against elapsed seconds | Optional later mapping to rising/falling contour |

Since the signal is bounded to 0–1, its standard deviation is at most 0.5. A simple initial variability score is `clip(std / 0.5, 0, 1)`. Keep these features visible before musical translation.

Preserve the source duration. Merge a final remainder shorter than three seconds into the preceding section. For more than 30 windows, increase window length or ask the user to crop; do not silently drop the tail. Validate the resulting plan before generation. [2]

## 5. Mapping rules

Begin with three levels per feature. Initial thresholds are design choices to tune with real recordings: low below 0.33, medium from 0.33 to below 0.67, and high at or above 0.67.

| Feature | Low | Medium | High |
| --- | --- | --- | --- |
| Activity → density | Sparse arrangement, occasional notes, restrained percussion | Regular pulse, moderate percussion, several interacting parts | Dense arrangement, busy percussion, frequent rhythmic events |
| Variability → articulation | Sustained tones, smooth phrasing, long envelopes | Short phrases, mixed sustained and plucked sounds | Short percussive attacks, irregular accents, fragmented phrases |

Test activity on its own first. Enable variability only after the activity mapping is audible. Keep genre, key, tempo, and instrument family stable while assessing each mapping.

For every section, combine:

- Global anchors: chosen style, requested tempo/key, instrument palette, instrumental direction.
- Mapped directions: the descriptors selected from that section's feature values.
- Negative styles: unwanted vocals and styles, plus contradictions such as sparse and dense requests occurring together.
- Continuity: begin with `context_adherence: "high"`; test a lower value only if strong intended changes are consistently suppressed.

Store `mapping_version`, feature values, thresholds, and the exact descriptors emitted. Updating a mapping creates a new plan revision. Manual plan edits also create a revision so the exported explanation reflects the actual request.

Future mappings can include mean value → register, signed trend → melodic contour, and repetition → recurring motifs. For relationships between channels, distinguish parallel from inverse coordination; negative correlation does not automatically mean dissonance.

## 6. A small API experiment to try first

Before implementing the UI, save the following as `request.json`. It deliberately contrasts two levels of activity while keeping other musical directions similar. It requests 20 seconds total.

```json
{
  "model_id": "music_v2_5",
  "composition_plan": {
    "chunks": [
      {
        "text": "[Low activity]",
        "duration_ms": 10000,
        "positive_styles": [
          "instrumental electronic music",
          "100 BPM",
          "D minor",
          "warm synthesizer tones",
          "soft electronic percussion",
          "sparse arrangement with occasional notes",
          "restrained rhythmic activity"
        ],
        "negative_styles": ["vocals", "lyrics", "dense percussion"],
        "context_adherence": "high"
      },
      {
        "text": "[High activity]",
        "duration_ms": 10000,
        "positive_styles": [
          "instrumental electronic music",
          "100 BPM",
          "D minor",
          "warm synthesizer tones",
          "soft electronic percussion",
          "dense arrangement with frequent notes",
          "busy rhythmic activity"
        ],
        "negative_styles": ["vocals", "lyrics", "sparse arrangement"],
        "context_adherence": "high"
      }
    ]
  }
}
```

Set `ELEVENLABS_API_KEY` in your local environment using an account with music API access and sufficient credits. Keep the key out of source control. Then run:

```bash
curl --fail --show-error --silent \
  --connect-timeout 15 --max-time 300 \
  --request POST \
  'https://api.elevenlabs.io/v1/music?output_format=auto' \
  --header "xi-api-key: ${ELEVENLABS_API_KEY:?Set ELEVENLABS_API_KEY locally}" \
  --header 'Content-Type: application/json' \
  --data-binary @request.json \
  --output generated.mp3
```

This is a real generation request and consumes account credits. Only play the output after a successful command exit. A timeout can leave a partial file and an uncertain provider outcome; do not automatically rerun the command. The 300-second timeout is a starting client setting, not a generation-time promise. The prototype should expose it as configuration.

Listen without looking at the section labels. Can you hear the density increase? If not, strengthen that one contrast before adding more mappings. Do not infer that a section was followed accurately just because the JSON was accepted.

## 7. Application components

Keep the first application small. Serve the frontend and local API from the same process/origin.

| Proposed file | Responsibility |
| --- | --- |
| `app/main.py` | Local routes, upload limits, startup and static frontend |
| `app/ingest.py` | CSV/JSONL parsing, timestamp conversion, validation |
| `app/features.py` | Resampling, normalization, windows and feature values |
| `app/mappings.py` | Versioned feature-to-style rules |
| `app/plans.py` | Compile and validate provider request bodies |
| `app/elevenlabs_client.py` | HTTP request, response validation, timeouts and error classification |
| `app/jobs.py` | One background worker, persisted job state, duplicate suppression |
| `app/storage.py` | SQLite metadata, immutable plan revisions, audio and exports |
| `web/index.html`, `web/app.js`, `web/styles.css` | Import, mappings, plan inspection and playback |
| `tests/` | Feature fixtures, plan limits, job failures and response mocks |

Use a local ignored `var/` directory for datasets and generated files. Bind only to loopback and restrict browser origins to the app. Keep the API key in the backend environment. The browser must never receive it.

Only musical instructions and necessary generation parameters need to go to ElevenLabs for this workflow. Keep original datasets and feature tables local.

### Proposed local API

These are endpoints to implement in the new app, not ElevenLabs endpoints.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/datasets` | Upload a bounded file; return columns, time range and validation issues |
| `POST /api/analyses` | Select channels, source interval, baseline and window settings |
| `POST /api/plans` | Compile an immutable plan revision from an analysis and mappings |
| `GET /api/plans/{id}` | Return section features, instructions and source/audio time ranges |
| `POST /api/generations` | Accept a plan ID and create or reuse a job; return quickly |
| `GET /api/generations/{id}` | Return status, errors and completed audio metadata |
| `GET /api/generations/{id}/audio` | Serve completed audio, with seeking support |
| `GET /api/generations/{id}/export` | Download audio, request, features and manifest as a ZIP |

A single local worker is sufficient. Persist the exact request before sending it. Run provider I/O away from the UI request so the browser can continue polling and displaying the plan.

## 8. Generation jobs, caching and exports

Use these local job states:

| State | Meaning |
| --- | --- |
| `queued` | Waiting for the local worker; nothing sent yet |
| `generating` | Provider request started |
| `complete` | Successful response saved and validated |
| `failed` | Known validation or provider rejection; show an actionable message |
| `unknown` | Request may have reached the provider, but the result is unavailable |
| `cancelled` | Cancelled before sending |

Do not imply that stopping local playback or disconnecting HTTP cancels a billable provider generation. After a crash, recover previously transmitting jobs as `unknown`. Avoid automatic retries of ambiguous POST outcomes. A deliberate retry creates another attempt and may incur another charge.

Hash the canonical input content, selected interval, baseline, analysis settings, mapping version, exact provider request, model, optional seed, and output format. Reuse an existing complete result for the same hash, and reuse an in-flight job on a double-click. Provide an explicit **Generate another variation** action for intentional new attempts. A seed may improve consistency but does not guarantee exact reproducibility. [1]

Write audio to a temporary file. Check HTTP status, the returned media type, and nonempty content. On the backend, use FFmpeg to decode the file fully and ffprobe to inspect its format and duration before marking the job complete and exposing its audio URL. Check these executables at startup and show a setup error if unavailable. Record measured duration and flag a difference exceeding the larger of 0.5 seconds or 2% of requested duration. This tolerance is a prototype check, not a provider guarantee. A decodable but off-duration result can be retained with a visible timing warning. Never mark a partial or error response as a completed cache result.

After successful validation, atomically rename the temporary file to its final path, then commit the completed job record. Clean up abandoned temporary files on restart.

The export should contain:

| File | Contents |
| --- | --- |
| `audio.mp3` | Saved generated audio, using its actual format/extension |
| `request.json` | Exact provider request without credentials |
| `features.json` | Section boundaries, feature values, validity and selected descriptors |
| `manifest.json` | Schema/mapping versions, hashes, model, seed if present, baseline, settings, requested/measured duration, timestamps, and provider song ID if returned |

Expose requested generation duration and attempt count before sending. Do not invent a price estimate; add account-specific costing only when current rates are configured. Raw source data can be a separate opt-in export.

## 9. User interface

Use one workspace with a clear sequence:

1. **Import:** show source columns, units, duration, gaps and a data plot. Include a built-in synthetic recording so the app is usable immediately.
2. **Map:** choose channels and one or two mappings. Show numeric features and their low/medium/high bands.
3. **Inspect:** show section cards on a timeline, with source interval, instructions and expected musical change. Provide the exact request JSON in an expandable panel.
4. **Generate:** show duration, model, cached-result availability and job status. Changes to mappings alone must not trigger generation.
5. **Listen:** play/seek the saved audio and highlight the matching planned section and source interval. Permit A/B comparison of saved attempts and export.

Drive the playback marker from audio playback time, including seeking and pauses. Use cumulative requested section durations for the initial timeline. Label these as planned boundaries; transitions can be gradual and musical events need not land exactly on them. Preserve source/audio start and end times explicitly so later time compression is possible without changing the data model.

## 10. Implementation milestones and acceptance checks

### Milestone A — establish an audible mapping

- [ ] Run the 20-second API experiment with a configured account.
- [ ] Save the successful audio and exact request.
- [ ] Check that the result decodes and its duration is close to the request.
- [ ] Listen for density contrast and unwanted vocals.

**Exit condition:** the basic contrast is useful enough to justify building the pipeline. If it is inconsistent, simplify the prompt or try another musical palette first.

### Milestone B — generate plans without paid calls

- [ ] Implement ingestion, canonical time, frozen normalization, and section features.
- [ ] Add versioned mappings and plan validation.
- [ ] Create a 60-second fixture with alternating low/high activity and a fixed 0–1 baseline.
- [ ] Export request JSON and a feature table without calling ElevenLabs.

**Exit condition:** identical source and settings produce identical plans. Every section can be traced back to a source window. Invalid coverage or provider limits block generation locally.

### Milestone C — complete one recording-to-music run

- [ ] Implement the backend client, persisted jobs, audio cache and one worker.
- [ ] Send the six-section plan as one request.
- [ ] Connect the UI's Generate action, polling, audio playback and export.
- [ ] Confirm reopening a completed session uses its saved audio.

**Exit condition:** a user can import data, inspect the mapping, generate once, hear the result and retain enough metadata to explain it.

### Milestone D — validate reliability

- [ ] Test constant inputs, ramps, spikes, missing data, duplicate timestamps, irregular sampling and mixed units.
- [ ] Verify similar source curves sampled at different densities produce similar features after canonicalization.
- [ ] Exercise mocked HTTP errors, timeout after sending, truncated audio and double-clicks; verify no automatic duplicate paid request.
- [ ] Check secrets are absent from UI responses, logs and exports.
- [ ] Try a small listening experiment with low/high examples in both temporal orders to control for a natural musical buildup.

For a practical initial listening test, use two generated examples and five listeners, yielding ten low/high choices. A provisional target is at least eight correct choices. Treat that as a product check, not statistical proof. If it fails, simplify the mapping or change descriptors before expanding the feature set.

**Exit condition:** keep only mappings that listeners can distinguish reasonably consistently. Record failures as well as successes.

## 11. Later live-input milestone

Use two update speeds:

- **Immediate playback:** live features control local gain, filtering, panning or crossfades on prepared audio. Start with approximately 10–20 control updates per second and smooth parameter changes.
- **New musical material:** sustained state changes request a new section in the background. Switch only when audio is ready; retain the current material if generation is delayed or fails.

Prepare a coherent set of low/medium/high musical states first. Independent generated tracks may not share a precise beat grid or harmony; use ambient material initially, or analyze and align rhythmic material before switching. Avoid treating a short crossfade as a guaranteed musical transition.

Freeze calibration and use hysteresis so noisy values do not repeatedly switch states. On stale input, fade toward silence or a clearly indicated idle state. Keep at most one pending generation; do not queue one request per incoming frame.

A later extension can separate generated audio into stems and map data to individual layers. Separation returns audio layers; it does not guarantee that every requested conceptual instrument is independently available. Reference-audio conditioning and inpainting may help develop related sections after the basic system works. [4][5]

## 12. Definition of done for the first version

- [ ] Runs locally without MIDI hardware.
- [ ] Accepts flat CSV/JSONL recordings and a built-in example.
- [ ] Shows the data, features, mapping rules and compiled plan before generation.
- [ ] Produces one playable piece from a multi-section request.
- [ ] Keeps requested musical properties distinct from measured results.
- [ ] Handles errors without silent retries or misleading completed states.
- [ ] Reuses saved results and exports audio with its complete explanation.
- [ ] Demonstrates at least one audible, repeatable-enough data mapping in a small listening trial.

## References

Official API documentation checked on 8 October 2026. Recheck schemas and account access when implementing; this plan does not pin SDK versions or assume a price.

1. [ElevenLabs — Compose music](https://elevenlabs.io/docs/api-reference/music/compose)
2. [ElevenLabs — Composition plans](https://elevenlabs.io/docs/eleven-api/guides/how-to/music/composition-plans)
3. [ElevenLabs — Stream music](https://elevenlabs.io/docs/api-reference/music/stream)
4. [ElevenLabs — Stem separation](https://elevenlabs.io/docs/api-reference/music/separate-stems)
5. [ElevenLabs — Music inpainting and conditioning](https://elevenlabs.io/docs/eleven-api/guides/how-to/music/inpainting)
