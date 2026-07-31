# Hydrasynth control

A small, dependency-free macOS command-line controller for an ASM Hydrasynth over
USB MIDI. It uses Apple's CoreMIDI framework directly.

## First connection

1. Connect and power on the Hydrasynth.
2. On the Hydrasynth, open **SYSTEM SETUP** and set:
   - MIDI RX channel to `1` (or pass the matching `--channel` below).
   - `PARAM RX` to `CC` for the named timbre controls.
   - `PARAM TX` to `CC` if the service should observe front-panel parameter
     movements as CC, or to `NRPN` for reconstructed high-resolution NRPN
     events.
   - `PGM CHG RX` to `On` for remote patch selection, and `PGM CHG TX` to
     `On` if the service should observe patch changes made on the synth.
3. Check that macOS exposes it:

   ```sh
   make
   ./build/hydractl rescan
   ./build/hydractl list
   ```

The destination should contain `HYDRASYNTH`. If USB sees the synth but the list
is empty, open **Audio MIDI Setup**, choose **Window > Show MIDI Studio**, and
click **Rescan MIDI**. Then try, in order:

1. Power-cycle the synth and restart the Mac.
2. Connect the synth directly to the Mac rather than through a dock or hub.
3. Try another known-good USB data cable.
4. Confirm the synth is not in update/bootloader mode.

The USB connection carries MIDI, not the Hydrasynth's audio. Listen at the
synth's headphone/audio outputs, or route its analog outputs through an audio
interface.

Current test rig: the Hydrasynth audio is connected to a **Black Lion Audio
Revolution 2x2**, input channel 1 (`Analogue 1`, zero-based channel index `0`).
Core Audio reports two inputs and a current format of 44.1 kHz with a 512-frame
buffer. See [todo.md](todo.md#audio-feedback) for the stable device identifier,
available sample rates, and capture status.

## Pitches

Play middle C for one second:

```sh
./build/hydractl note C4
```

Play a sequence:

```sh
./build/hydractl sequence C4 E4 G4 B4 --step 0.25 --gate 0.8
```

Notes can be names (`C#4`, `Db4`) or MIDI numbers (`60`). Useful options are
`--velocity 1..127`, `--duration SECONDS`, `--channel 1..16`, and
`--device TEXT` to select a destination by name.

Stop held notes on the selected MIDI channel:

```sh
./build/hydractl panic
```

## Timbre

Named controls accept a normalized value from `0.0` to `1.0`:

```sh
./build/hydractl timbre cutoff 0.70
./build/hydractl timbre resonance 0.35
./build/hydractl timbre env-attack 0.05
./build/hydractl timbre macro1 1.0
./build/hydractl timbre list
```

Run a bounded live parameter-randomization session while playing the keyboard:

```sh
./build/hydractl randomize --duration 60 --step 2
./build/hydractl randomize --duration 60 --step 2 --patches
```

The `--patches` form switches among longer factory patch locations during the
session. Parameter changes affect only the current edit buffer and are not
saved.

Raw MIDI is available for parameters not yet named:

```sh
./build/hydractl cc 74 96
./build/hydractl nrpn 1234 8192
./build/hydractl bend -0.5
```

`cc` values are `0..127`; NRPN identifiers and values are `0..16383`; pitch
bend is normalized from `-1.0` to `1.0`.

## Patches

Enable `PGM CHG RX` in the Hydrasynth's System Setup, then select any Single-mode
patch by its front-panel bank and one-based patch number:

```sh
./build/hydractl patch A 1
./build/hydractl patch H 128
```

If patch selection is ignored immediately after enabling `PGM CHG RX`,
power-cycle the Hydrasynth once and retry.

Changing patches discards any unsaved changes in the current edit buffer.

## Persistent NDJSON service

`serve` keeps the CoreMIDI ports open and accepts one protocol-v1 JSON object
per line on standard input. It writes only newline-delimited JSON (NDJSON) to
standard output; diagnostics go to standard error.

```sh
./build/hydractl serve --channel 1 --takeover 3
```

Read the initial `ready` object before sending requests. Keep the process's
standard input open for the lifetime of the session. Requests may use a string
`id` or an `id` in any valid JSON-number form, including a fraction or
exponent; each response repeats that `id`. Incoming MIDI and scheduler activity
appear as independent `event` objects.

```json
{"v":1,"id":"patch-1","op":"patch","bank":"A","number":1}
{"v":1,"id":"on-1","op":"note_on","note":"C4","velocity":96}
{"v":1,"id":"filter-1","op":"timbre","name":"cutoff","value":0.7}
{"v":1,"id":"state-1","op":"state"}
{"v":1,"id":"off-1","op":"note_off","note":"C4"}
{"v":1,"id":"stop-1","op":"shutdown"}
```

Protocol-v1 operations are:

- `ping`, `status`, `capabilities`, and `state`
- `play` (a timed chord) and `ramp` (timed named-timbre or raw-CC automation)
- `cancel` (a positive scheduler `job` ID)
- `note_on` and `note_off`
- `cc` (`number` and `value`, both `0..127`)
- `timbre` (`name` and normalized `value`, `0.0..1.0`)
- `nrpn` (`parameter` and `value`, both `0..16383`; optional `force`)
- `bend` (`value`, `-1.0..1.0`)
- `patch` (`bank` A-H and one-based `number` 1-128)
- `program` (zero-based `number` 0-127), `panic`, `set_takeover`, and
  `shutdown`

Most musical operations accept an optional `channel` from 1 to 16. The
`capabilities` response is the machine-readable source of truth for available
operations. It also reports the named CC/timbre controls and bounded scheduler,
duration, ramp-rate, and notification limits so clients do not need to copy
those definitions.

### Asynchronous event delivery

All asynchronous MIDI, automation, and job notifications pass through one
bounded writer queue. Each delivered notification has a monotonically
increasing `event_sequence` and a monotonic `server_time_ms` relative to service
startup. This includes incoming keyboard/panel events as well as agent events.

The queue holds 1,024 notifications. A slow standard-output reader does not
block scheduled MIDI delivery: once the queue is full, new notifications are
dropped instead. Clients must therefore drain standard output continuously,
retain the last sequence number, and treat a sequence gap as lost
notifications. The `status` response exposes `event_writer`,
`notification_queued`, cumulative `notification_dropped`, and
`event_sequence`, alongside scheduler queue/job counts. The `state` snapshot
also includes the latest allocated `event_sequence`. After a gap or increasing
drop count, query `status` and `state` to reconcile the client view.

Command responses share standard output with notifications and may interleave
with them; correlate responses by request `id`, not by line position.

### Timed chords and parameter ramps

`play` queues one to 16 MIDI note numbers as a chord. It schedules both the
note-ons and matching note-offs, so the request returns immediately:

```json
{"v":1,"id":"chord-1","op":"play","notes":[60,64,67],"velocity":96,"duration_ms":3200}
{"v":1,"id":"later-1","op":"play","notes":[72],"duration_ms":500,"delay_ms":1000,"channel":1}
```

`duration_ms` is required and ranges from 10 to 120,000. `velocity` defaults to
100 and ranges from 1 to 127; `delay_ms` defaults to zero and ranges from zero
to 600,000; `channel` defaults to the service channel. A successful response
has `state:"queued"` and a numeric `job` ID.

Cancel a queued job with its returned ID:

```json
{"v":1,"id":"cancel-1","op":"cancel","job":12}
```

A ramp can be canceled after any step; if one CC is already in flight, the
service lets that send finish before removing the remaining events. A `play`
job can be canceled only before its first note-on is sent. Once a note is
active, `cancel` returns `cannot_cancel_active_notes` without removing its
note-off; use `panic` when the active notes should also be silenced. A
successful response reports the job `kind`, `removed_events`, and prior
sent/blocked counts. It is written before the sequenced terminal job event,
which has `state:"canceled"` and `reason:"client"`.

`ramp` linearly automates either a named timbre control or a raw CC number.
`from` and `to` are normalized values from 0.0 to 1.0:

```json
{"v":1,"id":"cutoff-1","op":"ramp","name":"cutoff","from":0.2,"to":0.85,"duration_ms":2500}
{"v":1,"id":"res-1","op":"ramp","number":71,"from":0.1,"to":0.55,"duration_ms":2500,"rate_hz":40,"force":false}
```

Ramp duration ranges from 50 to 120,000 ms. Optional `delay_ms` has the same
range as `play`; `rate_hz` defaults to 30 and ranges from 1 to 100. Optional
`channel` and `force` have the same meaning as immediate CC/timbre commands.
The queued response includes the `job` ID, resolved CC number, step count, and
scheduled start time.

The scheduler uses monotonic due times and relative waits, so wall-clock
adjustments do not move queued events. Chords and ramps can overlap. Active
notes are reference-counted by channel and pitch; `state.active_notes` includes
the current `count`. Panic uses that count but caps explicit note-offs at four
per channel/pitch before channel-wide CC cleanup.
`status` exposes scheduler availability, queued-event count, and active-job
count.

Each transmitted scheduled note or CC produces an agent event containing its
`job` ID. A terminal `event:"job"` reports:

- `complete` when every event was sent;
- `partial` when one or more ramp steps were blocked by user takeover;
- `failed` after a MIDI send failure; or
- `canceled` when targeted cancel, panic, or shutdown removes the queued job.

Completion/partial/failure events include `sent_events` and `blocked_events`;
cancellation events include a `reason`. Targeted `cancel` preserves every
other job. `panic` remains the cancel-all operation: it stops the scheduler,
emits one `state:"canceled"` event per discarded job, performs note cleanup,
and starts a fresh scheduler.

A successful panic response includes `canceled_jobs`, scheduler status, and an
`event_barrier`. Canceled-job notifications allocated by that panic have
sequences at or below the barrier, so a client can consume through it before
considering its local job table reconciled. Sequence gaps or a rising
`notification_dropped` count still require a `status`/`state` refresh.

When takeover blocks a ramp step, that step is skipped and an
`automation_blocked` event reports `retry_after_ms`. Later steps remain at
their original times; after takeover expires, the ramp continues at its
current scheduled target. It does not retry the missed points or smoothly
resume from the user's value. Set `force:true` only when deliberately
overriding the performer.

### Monitoring and user takeover

By default, `serve` connects to the matching Hydrasynth MIDI input source as
well as its output destination. Incoming notes, CC, NRPN, program changes,
pressure, and pitch bend are decoded into asynchronous event objects. `state`
reports observed CC and NRPN values with their source, update age, and
authoritative `takeover_remaining` seconds, active notes, the current known
patch, and the takeover duration. The remaining takeover window persists even
after a forced agent write changes the value's source. NRPN entries also
include `resolution_bits` (`7` or `14`). Use `--no-input` for an output-only
service.

Set the Hydrasynth's `PARAM TX` to the representation the service should
observe: `CC` for CC events or `NRPN` for reconstructed NRPN events. Incoming
NRPN Select/Data Entry messages (CC 99, 98, 6, and 38) and Data
Increment/Decrement (CC 96 and 97) produce high-level `nrpn` events in addition
to the underlying CC events. CC 6 produces a 7-bit-resolution value; a
following CC 38 upgrades it to a 14-bit-resolution value.

The receive mode is independent: use `PARAM RX = CC` for named `timbre`
commands or `PARAM RX = NRPN` for raw `nrpn` control. To observe front-panel
patch changes, set `PGM CHG TX = On`. `PGM CHG RX` controls patch changes sent
to the synth.

An incoming user CC temporarily owns that CC, and an incoming NRPN value owns
that NRPN parameter. Conflicting agent `cc`, `timbre`, or `nrpn` requests are
rejected with `error.code = "user_takeover"` until the configurable window
expires (three seconds by default). The response includes `retry_after_ms`.
Change the window at startup or while running:

```json
{"v":1,"id":"takeover-1","op":"set_takeover","seconds":5}
```

A client may deliberately bypass the window by adding `"force":true` to a
`cc`, `timbre`, or `nrpn` request. Matching CC/NRPN input received within
250 ms of an outgoing agent value is classified as `agent_echo`, rather than
as a new user movement.

Current service limitations:

- There is no reconnect/backoff yet; restart `serve` after unplugging or
  reconnecting the synth.
- Scheduling currently uses milliseconds, not tempo, beats, phrase files, or
  MIDI clock. Direct `note_on` still requires a matching client `note_off`;
  scheduled `play` supplies its own note-offs.
- Ramps are linear CC automation only. There are no selectable curves, NRPN
  ramps, or smooth post-takeover resume yet.
- Front-panel patch tracking needs transmitted Bank Select followed by Program
  Change; without a known bank, the event reports `?`.
- SysEx and patch dumps are ignored. A patch load invalidates the service's
  remembered CC and NRPN state.
- The parser intentionally accepts the documented top-level scalar fields,
  not arbitrary JSON structures. A request line is limited to 16,384 bytes.

For a normal scheduled note-off failure, the scheduler makes two bounded
retries. If all three attempts fail, it sends emergency sustain-off (CC 64),
all-notes-off (CC 123), and all-sound-off (CC 120) on that MIDI channel. This
deliberately silences user-played notes and notes owned by other jobs on the
same channel. The resulting job is `failed`, and a `note_off_failed` event
reports whether emergency cleanup succeeded.

The service's `panic` operation and shutdown path send at most four explicit
note-offs per tracked channel/pitch, then send CC 64/123/120 on all 16
channels. A channel's tracked state is cleared only after its CC cleanup
succeeds; otherwise unconfirmed state is retained. A request-time failure
returns `midi_send_failed`; the final `stopping` event reports `panic_ok`.

Hardware validation on 31 July 2026 passed the persistent-controller acceptance
run on A001: a scheduled 3.2-second C/E/G chord played while concurrent
2.5-second cutoff and resonance ramps completed; all three job-completion events
arrived, `state.active_notes` was empty, and shutdown was clean. A separate
delayed `play` job was canceled by `panic` and did not fire. Repeatable checks
are listed in
[`docs/hardware_acceptance.md`](docs/hardware_acceptance.md).

The shared dashboard path was also exercised on the connected instrument. A
60-second-delayed cutoff ramp was queued through the authenticated broker and
target-canceled before transmission: 41 events were removed, zero were sent or
blocked, and the scheduler returned to zero active jobs and queued events.
During the same run, the dashboard captured user note, poly-pressure, and
note-off events. Shutdown removed the private socket and token and closed the
HTTP listener.

## Live visualization dashboard

The local dashboard presents the service as a polished, read-only instrument
monitor. It shows the selected MIDI endpoints, patch, tracked notes, recent
pitch bend, sustain, queue/drop health, parameter provenance, takeover windows,
short value histories, and a sequenced event timeline.

Start the live dashboard, then open
[http://127.0.0.1:8790](http://127.0.0.1:8790):

```sh
make dashboard
```

`make dashboard` builds `hydractl`, starts one persistent service, polls its
`state`, `status`, and `capabilities` responses, and opens an authenticated
local command broker for agent clients. Stop it with Control-C; the bridge
stops accepting commands, removes its socket and token file, requests a clean
service shutdown, and performs the service's normal panic cleanup.

While that dashboard is running, a second terminal can send commands through
the same service process:

```sh
python3 -B tools/hydra_command.py \
  '{"v":1,"id":"chord-1","op":"play","notes":[60,64,67],"velocity":90,"duration_ms":900}'

python3 -B tools/hydra_command.py \
  '{"v":1,"id":"filter-1","op":"timbre","name":"cutoff","value":0.72}'

python3 -B tools/hydra_command.py --pretty \
  '{"v":1,"id":"state-1","op":"state"}'
```

The client also reads one request from standard input, including through the
Make target:

```sh
printf '%s\n' '{"v":1,"id":"patch-1","op":"patch","bank":"A","number":5}' |
  make dashboard-command
```

Each dashboard run creates a fresh cryptographic token in
`/tmp/hydrasynth-dashboard-<uid>.token` and an AF_UNIX socket at
`/tmp/hydrasynth-dashboard-<uid>.sock`; both are mode `0600`. The client reads
the token and wraps one protocol request in the authenticated envelope without
printing the token. Caller IDs, including numeric IDs, are restored in service
responses. Input is bounded to 16 KiB, connections and service requests have
finite timeouts, and successful mutations trigger an immediate state/status
reconciliation. The broker refuses `shutdown` because the dashboard owns that
lifecycle; use Control-C in the dashboard terminal. `--no-broker` disables the
broker, and demo mode does not create one.

The same interface can be explored without touching the synth:

```sh
make dashboard-demo
```

The browser surface remains deliberately read-only: HTTP `POST` requests are
rejected, and command traffic is never accepted over TCP or exposed to browser
JavaScript. HTTP binds only to loopback by default. A non-loopback `--host`
requires explicit `--allow-remote`, but this is not a secured remote mode: it
exposes unauthenticated, unencrypted telemetry, including `stderr_tail`, to the
bound network. The token-gated command broker remains AF_UNIX-only regardless
of the HTTP bind. The browser receives bounded snapshots from
`GET /api/snapshot`; it loads the larger reference catalog once from
`GET /api/catalog`.

The parameter field includes the controller's named CC controls and every CC or
NRPN observed from the instrument. Its **Catalog** view searches 1,149
machine-readable definitions: 117 CC mappings and 1,032 expanded logical NRPN
controls. For example:

```text
http://127.0.0.1:8790/?view=catalog&q=filter1
```

The catalog in
[`data/hydrasynth_parameters.json`](data/hydrasynth_parameters.json) was
cross-checked against the two tables in
[ASM's official legacy Keyboard/Desktop MIDI specification 1.5.0](https://www.mecldata.com/download/asm/legacy/Hydrasynth_KB_DR_MIDI_Spec_1.5.0.pdf).
[ASM's current downloads](https://www.ashunsoundmachines.com/downloads) list
Explorer firmware 2.2, while the connected unit's exact version has not yet
been queried. The UI therefore identifies these definitions as reference data
rather than claiming complete runtime compatibility. Published collisions and
ambiguities are recorded without guessed resolutions. Validate the catalog
with:

```sh
python3 -B tools/validate_parameters.py
```

Python is used here as a dependency-free HTTP/process orchestration layer while
the timing-sensitive MIDI transport and scheduler remain in C. The authenticated
local broker lets monitoring and agent commands share the dashboard-owned
service process without adding browser-side write controls.

## Native audio input meter

`hydra-audio` discovers Core Audio input devices and meters one input channel
without saving audio:

```sh
./build/hydra-audio list
./build/hydra-audio list --json
./build/hydra-audio meter --duration 2
```

The meter defaults to the input device whose name contains `Revolution 2x2`,
channel 1, for 10 seconds. Selection can instead use a device-name query or the
exact stable Core Audio UID:

```sh
./build/hydra-audio meter --device 'Revolution 2x2' --channel 1 --duration 2
./build/hydra-audio meter \
  --uid 'AppleUSBAudioEngine:Black Lion Audio:Revolution 2x2:FFFFFFFF:1,2' \
  --channel 1 --duration 2 --json
```

`--uid` and `--device` are alternatives. Durations range from 0.1 to 3,600
seconds. The tool resolves the selection to its stable UID and explicitly
assigns that device to a native AudioQueue with three preallocated input
buffers. Only the selected one-based channel is accumulated; no sample file or
audio history is retained.

The JSON report includes requested/elapsed duration, sample rate, frame and
valid-sample counts, RMS and RMS dBFS, peak and peak dBFS, DC offset,
clipping/sample count, non-finite sample count, and whether capture was
interrupted. Plain output presents the main measurements for a human reader.
Clipping means an absolute input sample at or above 1.0 (0 dBFS).

The first capture may trigger macOS's Microphone authorization prompt. Grant
the terminal/Codex host access under **System Settings > Privacy & Security >
Microphone**. In the first hardware run, `AudioQueueStart` waited about 20
seconds for authorization; the requested metering interval now starts only
after `AudioQueueStart` succeeds, so permission latency is not counted as
capture time.

Hardware validation on channel 1 of the Black Lion Revolution 2x2 passed at
44.1 kHz. A two-second request produced 2.014 seconds and 88,576 frames, with
RMS -54.585 dBFS, peak -32.313 dBFS, DC offset `6.83e-06`, zero clipped
samples, and zero non-finite samples. Device listing also confirmed two inputs
and the exact UID shown above.

Build and run the self-tests:

```sh
make test
```

Run `./build/hydractl help` for the complete command summary.

## Development

See [todo.md](todo.md) for the current capability inventory, known hardware
quirks, and prioritized development roadmap.

## Scope

The controller now covers immediate notes, pitch bend, program changes,
CC-based timbre, arbitrary high-resolution NRPN output, and a persistent NDJSON
service with CC/NRPN input observation, timed chords, and concurrent linear CC
ramps. A local Python bridge now supplies a read-only live dashboard and a
searchable, versioned CC/NRPN catalog. The native audio tool provides explicit
mono routing and level/clipping measurements without recording. Tempo/beat
phrase scheduling, selectable curves, reconnect handling, Explorer-2.2
validation of the legacy parameter map, audio recording/deeper analysis, and
safe patch-data round trips remain future layers.
