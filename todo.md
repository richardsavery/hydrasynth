# Hydrasynth control roadmap

Last hardware check: 31 July 2026, ASM Hydrasynth Explorer over USB MIDI on
macOS 26.5.1.

This document tracks the current boundary of the controller and the work needed
to turn it into a reliable, expressive pipeline that an agent or generative
process can use in real time.

## Working now

- [x] Discover the `HYDRASYNTH EXPLORER` CoreMIDI destination.
- [x] Send note-on and note-off with note names, MIDI note numbers, velocity,
  duration, and MIDI channel.
- [x] Play monophonic note sequences with configurable step and gate time.
- [x] Send pitch bend.
- [x] Release sustain, send up to four explicit note-offs per tracked
  channel/pitch, and send all-notes-off/all-sound-off on every channel with
  service `panic`, clearing state only after successful channel cleanup.
- [x] Send arbitrary 7-bit MIDI CC messages.
- [x] Control a useful named CC subset, including filters, envelopes, oscillator
  levels, macros, delay, and reverb.
- [x] Send arbitrary 14-bit NRPN parameter/value pairs.
- [x] Run a bounded live CC-randomization session over one persistent MIDI
  connection.
- [x] Optionally switch among longer patch locations during a live
  randomization session.
- [x] Select Single-mode patches A001 through H128 using Bank Select and Program
  Change.
- [x] List matching CoreMIDI input sources as well as output destinations.
- [x] Run a persistent CoreMIDI session with a language-neutral NDJSON v1
  command/response API.
- [x] Decode incoming channel MIDI into asynchronous events and maintain active
  note, observed CC/NRPN, and known-patch state.
- [x] Give recent physical CC and NRPN movements priority over conflicting
  agent changes with a configurable takeover window and explicit force
  override.
- [x] Classify matching, recently transmitted incoming CC and NRPN values as
  agent echoes rather than new user takeovers.
- [x] Run the full service panic sequence on shutdown, termination signal, or
  input EOF and expose whether it succeeded.
- [x] Queue 1-16-note chords with bounded duration, velocity, delay, channel,
  automatic note-off, and reference-counted active-note state.
- [x] Queue concurrent linear ramps for named timbre controls or raw CCs with
  bounded duration, delay, update rate, takeover handling, and force override.
- [x] Return scheduler job IDs and emit sequenced agent note/CC events plus job
  states `complete`, `partial`, `failed`, and `canceled`, with sent/blocked
  event accounting on completed jobs.
- [x] Cancel all queued jobs before service panic cleanup and restart the
  scheduler afterward, emitting a canceled event for each discarded job and an
  event barrier in the panic response.
- [x] Cancel a specific ramp job safely at any point, and cancel a scheduled
  chord only before any note-on was sent so its required note-offs cannot be
  discarded.
- [x] Isolate asynchronous notifications behind a sequenced 1,024-entry writer
  queue so slow standard output cannot block scheduled MIDI; count and expose
  dropped notifications.
- [x] Give delivered async notifications `event_sequence` and monotonic
  `server_time_ms`, and expose sequence/queue/drop state for reconciliation.
- [x] Preserve string IDs and every valid JSON-number form in protocol
  responses.
- [x] Retry a failed scheduled note-off twice, then attempt bounded emergency
  channel cleanup with CC 64/123/120 and report the failure.
- [x] List Core Audio input devices and meter an explicitly routed mono channel
  with the native `hydra-audio` tool, including machine-readable JSON output.
- [x] Advertise named timbre controls and bounded operating limits in the
  service's machine-readable `capabilities` response.
- [x] Run a dependency-free local Python bridge that owns and continuously
  drains the service, polls snapshots, and serves a bounded read-only dashboard
  API.
- [x] Share that persistent service with agent clients through a token-gated,
  AF_UNIX-only command broker while keeping the HTTP/browser surface read-only.
- [x] Provide live and self-running simulated demo dashboards with connection,
  patch, note, transport, parameter, takeover, and event views.
- [x] Build and validate a versioned catalog containing 117 CC mappings and
  1,032 logical NRPN controls from ASM's official legacy MIDI specification.
- [x] Build without third-party dependencies using C and macOS CoreMIDI.
- [x] Run unit-level checks for note/bank parsing, exact MIDI encoding,
  JSON/incoming MIDI, audio-stat accumulation, dashboard reduction, catalog
  validation, and JavaScript syntax checks with `make test`.

## Required Hydrasynth state

- MIDI RX must be `1` for the default commands, or `Omni`. A different receive
  channel requires `--channel`.
- `PARAM RX = CC` is required for the current named `timbre` controls.
- `PARAM TX = CC` makes physical parameter movements available as CC events;
  `PARAM TX = NRPN` makes them available as reconstructed NRPN events.
- `PGM CHG RX = On` is required for `patch`.
- `PGM CHG TX = On` is required to observe patch changes made from the front
  panel.
- On the connected Explorer, `PGM CHG RX` did not take effect until the synth
  was power-cycled.
- Keep MPE off for the current single-channel implementation.
- USB carries MIDI only. Audio must come from the Hydrasynth's analog outputs.

`PARAM RX` can accept CC or NRPN, not both at once. Use CC receive mode for
named `timbre` controls and NRPN receive mode for raw high-resolution `nrpn`
control. The controller should continue to make this operating mode explicit
to clients.

## Next milestone: persistent real-time controller

Priority: highest.

- [x] Continue the current C/CoreMIDI implementation for the persistent
  controller.
- [x] Replace one-process-per-command operation with a long-running CoreMIDI
  session.
- [x] Provide a versioned JSON-lines command API over standard input/output.
- [x] Keep one output port open to avoid repeated CoreMIDI startup latency.
- [ ] Recover automatically when the synth is unplugged and reconnected.
- [x] Queue events against monotonic due times using relative waits.
- [x] Allow notes to remain active while subsequent parameter and patch
  commands are processed.
- [x] Send bounded explicit note-offs for tracked pitches during panic and
  clean shutdown, followed by per-channel CC cleanup and failure reporting.
- [ ] Retry transient CoreMIDI connection failures with bounded backoff.
- [x] Expose connection/input state and the selected source/destination.
- [x] Keep the command protocol language-neutral so a future Python process can
  use or replace the C service without changing clients.

Acceptance check:

- [x] From one running process, select a patch, play a polyphonic phrase, sweep
  two timbre parameters smoothly, and stop without a hanging note.

Hardware pass on 31 July 2026: A001, a scheduled 3.2-second C/E/G chord, and
concurrent 2.5-second cutoff/resonance ramps. All three jobs completed,
`active_notes` was empty, and shutdown was clean. A separate delayed chord was
canceled by `panic` and never sounded.

## Musical event model

- [x] Add simultaneous notes and 1-16-note scheduled chords.
- [x] Add bounded common duration, velocity, delay, and MIDI channel to a
  scheduled chord.
- [ ] Add rests and independently timed per-note duration, velocity, and gate
  within multi-event phrases.
- [ ] Add tempo in BPM and musical units such as beats and sixteenth notes.
- [ ] Add looping with a bounded or explicitly cancellable duration.
- [x] Add targeted cancellation by scheduler job ID; keep `panic` as the
  explicit cancel-all and MIDI-cleanup operation.
- [ ] Add sustain pedal, modulation wheel, channel pressure, and polyphonic
  aftertouch messages.
- [ ] Add reusable phrase files in a documented JSON format.
- [ ] Add transformations: transpose, invert, reverse, rotate, humanize, and
  velocity scaling.
- [ ] Add deterministic random seeds for reproducible generated phrases.
- [ ] Add MIDI clock start, stop, continue, and tempo synchronization.

## Deep timbre control

- [ ] Move the parameter definitions out of C code into a data file.
- [x] Record the legacy specification's parameter names, CC/NRPN identifiers,
  ranges, enums, polarity, source rows, document hash, and firmware/model
  compatibility in a machine-readable data file.
- [x] Validate catalog counts, address/range invariants, declared collisions,
  and known source ambiguities without guessing missing values.
- [ ] Add named controls for oscillator mode and waveform selection.
- [ ] Add WaveScan and wave-position controls.
- [ ] Add Mutant type, ratio, depth, source, feedback, and wet/dry controls.
- [ ] Add mixer levels, pan, ring modulation, noise, and filter routing.
- [ ] Add filter type and every Filter 1/2 parameter.
- [ ] Add complete envelopes and LFOs, including trigger and sync modes.
- [ ] Add complete pre-FX, post-FX, delay, and reverb controls.
- [ ] Add modulation-matrix source, destination, and depth editing.
- [ ] Add arpeggiator configuration.
- [x] Add bounded-duration linear ramps for named timbre controls and raw CCs.
- [ ] Add selectable interpolation curves and high-resolution NRPN ramps.
- [ ] Add timbre snapshots that can be recalled without writing patch memory.
- [ ] Validate the legacy ASM NRPN 1.5 map against Explorer firmware 2.2.
- [ ] Document parameters added after the published NRPN 1.5 specification.

Catalog provenance: official ASM legacy Keyboard/Desktop MIDI specification
1.5.0, 31 pages, SHA-256
`f86b31024d7b79c2ca648e9977104f9909383cc9c560092918f2ed899871416b`.
The detailed CC table agrees with its independent CC-sorted appendix for all
117 numbers. The catalog explicitly records four published decoder collisions
and two rhythm-list ambiguities rather than inventing resolutions.

## Bidirectional MIDI and patch data

- [x] List and connect to Hydrasynth MIDI sources as well as destinations.
- [x] Expose decoded incoming notes, CC, NRPN, program changes, pressure, and
  pitch bend as asynchronous NDJSON events.
- [x] Decode physical front-panel CC and NRPN movements while agent automation
  is active.
- [x] Reassemble incoming NRPN Select/Data Entry CC 99/98/6/38 and Data
  Increment/Decrement CC 96/97 into 7- or 14-bit parameter events.
- [x] Track each observed CC and NRPN value with source, update age, and an
  authoritative remaining user-takeover window.
- [x] Pause CC/timbre or raw NRPN automation for the conflicting parameter
  during a configurable user takeover window.
- [ ] Optionally resume automation with a smooth ramp from the user's value.
- [x] Keep a takeover-blocked ramp on its original timeline, emit
  `automation_blocked`, and continue from the current scheduled target after
  the window expires.
- [x] Distinguish matching CC and NRPN values received within 250 ms of
  transmission as `agent_echo`, without starting a user takeover.
- [ ] Generalize loop suppression beyond the current short CC echo heuristic.
- [x] Track Program Change from the Hydrasynth front panel, including the bank
  when Bank Select LSB was received first.
- [ ] Add MIDI identity request/reply and report model and firmware when
  available.
- [ ] Research and document ASM SysEx framing and checksums.
- [ ] Receive a patch dump without modifying synth memory.
- [ ] Decode patch names and parameters from a received patch.
- [ ] Add patch transmission only after round-trip verification.
- [ ] Require explicit confirmation before any operation writes a patch slot.
- [ ] Provide patch backup before enabling remote save or bulk transfer.

## Expressive and tuning features

- [ ] Implement polyphonic aftertouch.
- [ ] Implement MPE channel allocation, per-note bend, pressure, and timbre.
- [ ] Add a clearly separated MPE mode and document the required synth setting.
- [ ] Add microtonal pitch support using MPE bend or Hydrasynth scale data.
- [ ] Add configurable pitch-bend range and matching synth setup checks.

## Audio feedback

- [x] Identify the current audio path: Black Lion Audio Revolution 2x2, input
  channel 1.
- [x] Discover the Core Audio endpoint receiving the Hydrasynth's analog
  output and record its stable device identifier and channel map.
- [x] Capture and meter the current mono channel 1 signal with explicit stable
  UID routing.
- [ ] Add optional stereo capture when both Hydrasynth outputs are connected.
- [x] Add RMS/dBFS, peak/dBFS, DC, clipping, non-finite, frame/sample, elapsed,
  and interruption checks for the selected input.
- [ ] Record rendered phrases with patch and controller metadata.
- [ ] Extract basic loudness, onset, pitch, and spectral measurements.
- [ ] Add closed-loop comparisons so parameter changes can be evaluated from
  captured audio rather than MIDI delivery alone.
- [ ] Evaluate Essentia's Python bindings for offline and streaming analysis.
- [ ] Record the dependency/version plan and review Essentia's AGPL licensing
  implications before distributing the combined application.

Confirmed Core Audio path and native meter status:

- Device name: `Revolution 2x2`; manufacturer: Black Lion Audio.
- Stable UID:
  `AppleUSBAudioEngine:Black Lion Audio:Revolution 2x2:FFFFFFFF:1,2`.
  The currently observed numeric device ID (`123`) is ephemeral and must not be
  stored in configuration.
- Two inputs are exposed: channel 1 `Analogue 1` (zero-based index `0`) and
  channel 2 `Analogue 2`.
- The observed format was 44.1 kHz with a 512-frame buffer. The interface
  advertises 44.1, 48, 88.2, 96, 176.4, and 192 kHz.
- `build/hydra-audio list [--json]` reports input device names, stable UIDs,
  input counts, and nominal sample rates. Host discovery confirmed the exact
  UID above, two inputs, and 44.1 kHz.
- `build/hydra-audio meter` defaults to `Revolution 2x2`, one-based channel 1,
  and 10 seconds. `--device` selects by name, while `--uid` selects the exact
  stable UID; `--channel`, `--duration`, and `--json` configure capture/report
  behavior.
- The native AudioQueue is explicitly assigned by stable UID and starts with
  three preallocated buffers. The current tool retains aggregate statistics
  only and does not save audio samples.
- A two-second channel-1 hardware meter passed: elapsed 2.014 seconds, 88,576
  frames, RMS -54.585 dBFS, peak -32.313 dBFS, DC offset `6.83e-06`, zero
  clipped samples, and zero non-finite samples.
- The first `AudioQueueStart` waited about 20 seconds for macOS Microphone
  authorization. Meter timing now starts after `AudioQueueStart`, so privacy
  prompt latency is excluded. The terminal/Codex host must be allowed under
  **System Settings > Privacy & Security > Microphone**.
- No `ffmpeg`, SoX/`rec`, `afrecord`, PortAudio, libsndfile, or Essentia
  dependency is currently installed; `hydra-audio` uses native CoreAudio and
  AudioToolbox.

## Future Python option

Python is not required for timing-critical MIDI delivery. It is now used for
the higher-level read-only HTTP/dashboard bridge while C continues to own
CoreMIDI delivery and scheduling.

- [ ] Spike Python MIDI I/O using PyObjC CoreMIDI and `python-rtmidi`.
- [ ] Compare Python and C for input/output, reconnect behavior, event timing,
  deployment, and maintainability before considering a migration.
- [x] Add a Python client/process bridge over the C service's language-neutral
  API rather than rewriting the working MIDI transport.
- [ ] Consider a separate Python audio-analysis worker that shares state with
  the C controller.
- [ ] Use Essentia through its Python bindings if that provides the clearest
  audio-analysis workflow.

## Visualization

Build a live view over the controller's language-neutral state/event stream so
the user can understand what the synth, the user, and the agent are doing.

- [x] Show the selected device endpoints, MIDI channel, active patch, and
  conservative service/transport health.
- [x] Show tracked active notes, sustain CC state, and recent pitch-bend
  activity.
- [ ] Preserve authoritative note velocities, pressure, bend, sustain, and job
  state in service snapshots instead of relying on recent events.
- [x] Group surfaced parameters by synthesizer section and provide a searchable
  index over every catalogued CC and logical NRPN definition.
- [x] Display observed raw and normalized values while keeping unobserved
  catalog entries visibly unknown.
- [x] Convert every catalog value kind into its musical units or enum label,
  retaining explicit unknown/ambiguous states where the source cannot decide.
- [x] Animate changed parameters and retain a short in-browser time-series
  history.
- [x] Label changes by user, agent, agent echo, or takeover provenance.
- [x] Visualize user-priority takeover countdowns and blocked automation
  events.
- [x] Detect event-sequence gaps, incoming/notification drops, and parse errors,
  then continue reconciling from fresh service snapshots.
- [x] Show note, patch, controller, pressure, bend, automation, and job events
  on a compact timeline.
- [x] Add filters for changed, user, agent, takeover, and catalog views plus
  full parameter search.
- [ ] Add an expandable event inspector with complete raw MIDI/JSON details.
- [ ] Add optional live Black Lion input meters and later analysis features.
- [x] Start with a read-only local web dashboard; reject HTTP writes and require
  explicit opt-in before binding beyond loopback.
- [x] Add a shared authenticated command broker so the dashboard and agent can
  use one service process without adding browser controls.
- [ ] Hardware-check live visual changes in both Hydrasynth CC and NRPN
  transmit modes, including patch invalidation and takeover.
- [ ] Add browser regression tests for filters, catalog search, responsive
  layouts, and disconnect/error states.

Initial implementation status:

- `make dashboard` serves the hardware-backed monitor at
  `http://127.0.0.1:8790`; `make dashboard-demo` uses self-running simulated
  telemetry.
- `GET /api/snapshot` is bounded and polled by the UI; the 1,149-definition
  catalog is loaded once from `GET /api/catalog`.
- Live mode creates a fresh mode-`0600` token and AF_UNIX socket for
  `tools/hydra_command.py`; requests are bounded, timed, internally correlated,
  and followed by prompt state reconciliation after successful mutations.
- Demo mode leaves the command broker unavailable, and `--no-broker` disables
  it explicitly.
- Desktop, tall, catalog-search, and true 390 px responsive renders were
  visually inspected. The narrow layout has no document overflow; its filter
  rail scrolls internally. JavaScript syntax and dashboard reducer self-tests
  pass.
- The service's `connected:true` means endpoints were selected at startup, not
  verified hot-plug health; the UI deliberately says “selected.”

Remaining presentation/detail work:

- [ ] Replace startup-only endpoint status with verified reconnect/hot-plug
  health once the service exposes it.
- [ ] Add collapsible group summaries and window/virtualize very large catalog
  result sets if the display limit is later removed.
- [ ] Persist selected layout, filters, and short histories across page reloads.

## Agent-facing control and safety

- [x] Define and document a versioned NDJSON command schema for notes, timed
  chords, patches, CC/NRPN timbre, ramps, panic, status, and state.
- [ ] Add an MCP or equivalent local tool adapter after the daemon API is stable.
- [x] Bound scheduled chord size, velocity, duration/delay, ramp duration, and
  ramp update rate.
- [x] Bound asynchronous notification memory and keep scheduler/MIDI delivery
  independent from slow output consumers.
- [x] Bound scheduled note-off recovery to two retries followed by one
  channel-wide emergency cleanup sequence.
- [ ] Set safe limits for note duration, velocity, repetition rate, and outgoing
  MIDI traffic.
- [ ] Make unbounded loops opt-in and always cancellable.
- [ ] Distinguish temporary edit-buffer changes from persistent patch writes.
- [ ] Keep a visible event log containing requested and transmitted messages.
- [ ] Add a dry-run mode that prints exact MIDI bytes without sending them.

## Testing and documentation

- [ ] Unit-test every generated MIDI message, including exact byte sequences.
- [ ] Create a virtual CoreMIDI test destination for integration tests.
- [x] Hardware-test cancel-all: queue a delayed `play`, invoke `panic`, and
  confirm the job does not fire.
- [x] Unit-test targeted ramp removal, active-note protection, and the
  in-flight event guard.
- [x] Hardware-test targeted cancellation through the shared dashboard broker:
  a delayed ramp removed all 41 queued events with zero sent or blocked.
- [ ] Test reconnect, malformed input, scheduler saturation/failure,
  notification drops, and stuck-note recovery.
- [x] Hardware-test native mono metering on Revolution 2x2 channel 1, including
  explicit routing, expected duration, signal statistics, and zero
  clip/non-finite counts.
- [x] Validate the parameter catalog's 117 CC and 1,032 expanded logical NRPN
  definitions, including four explicitly declared source collisions.
- [x] Self-test dashboard snapshot reduction, stale-state/event ordering,
  authenticated broker dispatch/correlation/limits, and JavaScript semantics
  and syntax.
- [x] Live-test dashboard startup, Hydrasynth input/output endpoint selection,
  capability/catalog delivery, and clean shutdown.
- [x] Add the repeatable manual hardware acceptance checklist in
  [`docs/hardware_acceptance.md`](docs/hardware_acceptance.md).
- [ ] Generate the named parameter reference from the parameter data file.
- [ ] Document the relevant Hydrasynth System Setup pages with firmware version.
- [ ] Add troubleshooting for channel mismatch, CC/NRPN mode, MPE lock, USB
  enumeration, and program-change reception.

## Known issues and observations

- Codex's normal execution sandbox cannot connect to the user's CoreMIDI service
  and reports status `-10833`; hardware commands must run with MIDI access.
- Rapid creation of several CoreMIDI clients produced one transient status
  `-304`; retry succeeded. A persistent client should remove this failure mode.
- CoreMIDI sends asynchronously. Immediate commands need a short drain period
  before their client and port are disposed.
- Patch selection needs ordered Bank Select MSB, Bank Select LSB, and Program
  Change messages.
- Changing patches discards unsaved edit-buffer changes.
- The NDJSON service does not reconnect automatically, schedule in tempo/beat
  units, or parse SysEx. Its CC/NRPN echo classification is a 250 ms
  matching-value heuristic.
- Targeted `cancel` waits for an already-popped event, then removes only that
  job's remaining events. It refuses a `play` job after any note-on was sent,
  preserving its note-offs; use `panic` to cancel all jobs and clean up MIDI.
  Panic's response `event_barrier` lets clients drain pre-response
  cancellation events.
- Async notifications are buffered separately from MIDI scheduling. After
  1,024 queued notifications, new events are dropped while MIDI continues.
  Clients must drain output, detect `event_sequence` gaps, and check
  `notification_queued`/`notification_dropped` in `status`.
- If a scheduled note-off and both retries fail, emergency CC 64/123/120
  cleanup intentionally silences every user and other-job note on that MIDI
  channel.
- Panic limits explicit note-offs to four per tracked channel/pitch, then
  relies on CC 64/123/120. State is cleared only for channels whose CC cleanup
  succeeds.
- A ramp step blocked by takeover is not retried. Later steps keep their
  original due times and resume at the then-current scheduled target, without
  a smooth transition from the user's value.
- Incoming NRPN reconstruction emits a 7-bit-resolution event at Data Entry
  MSB (CC 6), then a 14-bit-resolution event if Data Entry LSB (CC 38)
  follows. Both events are emitted; the latest value is retained in
  `state.nrpn` with source, update age, and authoritative takeover time
  remaining.
- Physical parameter and patch observation depends on the Hydrasynth transmit
  settings (`PARAM TX = CC` or `NRPN`, and `PGM CHG TX = On` respectively).
- The parameter catalog is based on ASM's legacy Keyboard/Desktop MIDI document
  1.5.0. The current Explorer firmware line is 2.2, so mappings remain reference
  data until the model/version difference is verified on hardware.
- The dashboard owns the service subprocess and intentionally exposes no HTTP
  write endpoint. Local agent control shares that process through a
  cryptographic-token-gated AF_UNIX socket; `shutdown` remains owned by the
  dashboard lifecycle.
- `--allow-remote` affects telemetry HTTP only and is unauthenticated and
  unencrypted, including `stderr_tail`; the command broker never uses TCP.

## Suggested implementation order

1. Harden the persistent C/CoreMIDI/NDJSON service with reconnect,
   scheduler/output-pressure failure tests, and integration tests.
2. Hardware-check command-broker control alongside live dashboard monitoring,
   including targeted cancellation, patch invalidation, takeover, CC, and NRPN.
3. Expand visualization with authoritative expressive/job state, verified
   connection health, collapsible catalog groups, and the Black Lion meter.
4. Add multi-event phrases, tempo/beat timing, selectable ramp curves, and
   optional looping.
5. Validate the legacy catalog against the Explorer, then drive named CC/NRPN
   control and displayed enum/unit formatting from the data file.
6. Add integration tests for NRPN edge cases, echo classification, takeover,
   state reconciliation, and browser behavior.
7. Audio recording, metadata alignment, and deeper analysis.
8. Safe SysEx patch read/backup, followed later by optional writes.
9. MPE, polyphonic aftertouch, microtuning, and an MCP/agent tool adapter.
