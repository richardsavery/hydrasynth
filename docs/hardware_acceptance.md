# Hydrasynth hardware acceptance checklist

Use this checklist after changes to MIDI transport, scheduling, parameter
decoding, the dashboard, or audio capture. It is intentionally manual: each
step includes something that must be heard or seen on the physical rig.

Test rig recorded on 31 July 2026:

- ASM Hydrasynth Explorer over USB MIDI
- MIDI channel 1, MPE off
- Black Lion Audio Revolution 2x2, analogue input channel 1
- macOS CoreMIDI and Core Audio

Do not run the sound-producing sections through speakers at an unknown level.
Start with the monitor volume low, then raise it deliberately.

## 1. Build and preflight

```sh
make clean all test
./build/hydractl list
./build/hydra-audio list
```

Pass when:

- both native tools build without warnings;
- every self-test passes;
- a MIDI destination and source containing `HYDRASYNTH` are listed;
- `Revolution 2x2` is listed with at least one input channel.

On the Hydrasynth, confirm:

- MIDI RX is channel 1 or Omni;
- PGM CHG RX and PGM CHG TX are On;
- PARAM RX is CC for the named-control checks;
- PARAM TX is CC for the first monitoring check;
- MPE is Off.

If program receive was just enabled and patch changes are ignored, power-cycle
the Hydrasynth once.

## 2. Immediate MIDI and cleanup

```sh
./build/hydractl patch A 1
./build/hydractl note C4 --velocity 72 --duration 0.5
./build/hydractl sequence C4 E4 G4 C5 --velocity 72 --step 0.2 --gate 0.7
./build/hydractl panic
```

Pass when:

- the display changes to A001;
- the single note and four-note phrase are heard at the expected pitches;
- no note remains sounding after panic.

## 3. Persistent scheduling

Start the service:

```sh
./build/hydractl serve --channel 1 --takeover 3
```

After its `ready` line, send these NDJSON requests one line at a time:

```json
{"v":1,"id":"patch","op":"patch","bank":"A","number":1}
{"v":1,"id":"chord","op":"play","notes":[60,64,67],"velocity":80,"duration_ms":3200}
{"v":1,"id":"cutoff","op":"ramp","name":"cutoff","from":0.2,"to":0.85,"duration_ms":2500,"rate_hz":40}
{"v":1,"id":"resonance","op":"ramp","name":"resonance","from":0.1,"to":0.55,"duration_ms":2500,"rate_hz":40}
{"v":1,"id":"state","op":"state"}
{"v":1,"id":"stop","op":"shutdown"}
```

Pass when:

- the chord and both sweeps overlap audibly;
- each queued response has a distinct numeric job ID;
- three terminal job events arrive;
- the final state has no active notes;
- shutdown completes without a hanging note.

Queue a second ramp with a delay, note its returned `job`, and cancel it before
the delay expires:

```json
{"v":1,"id":"later-ramp","op":"ramp","name":"cutoff","from":0.2,"to":0.8,"duration_ms":2000,"delay_ms":3000}
{"v":1,"id":"cancel-ramp","op":"cancel","job":4}
```

Use the actual job ID returned by `later-ramp`. Pass when the response reports
the matching job as canceled, its sequenced terminal event has
`reason:"client"`, and the delayed sweep is not heard. Also verify that trying
to cancel a `play` job after its note-on returns
`cannot_cancel_active_notes` and that the scheduled note-off still arrives.

## 4. Dashboard and shared command path

When the dashboard is running, send one quiet note, a parameter change, and a
short ramp through the documented local command client. Pass when each response
retains the caller's request ID and the same operation appears in the dashboard
without starting a second `hydractl` service. Confirm that an absent or invalid
broker token is rejected and that HTTP `POST` remains read-only.

## 5. Dashboard: CC transmit mode

Leave PARAM TX set to CC, then run:

```sh
make dashboard
```

Open <http://127.0.0.1:8790>. Move Filter 1 cutoff, Filter 1 resonance, a
macro, and an envelope control on the synth.

Pass when:

- the route names the Hydrasynth destination and input source;
- the current patch is correct;
- played keys appear and release on the keyboard view;
- moved controls update without a page reload and are labelled `USER`;
- short histories move smoothly and the activity timeline remains ordered;
- the takeover countdown remains visible for three seconds after the last
  physical movement;
- queue, drop, parse-error, and event-gap indicators remain healthy.

Search for `filter1`, switch between All, Changed, User, and Catalog, then use
the page at a narrow window width. Pass when the focused search field remains
focused during updates, the layout does not overflow horizontally, and catalog
entries not observed from hardware remain visibly unknown.

Stop the dashboard with Control-C. Pass when its child service shuts down and
the synth has no held notes.

## 6. Dashboard: NRPN transmit mode

The Synth mixer parameter picker exposes all 1,149 catalog definitions: 929
usable NRPN controls, 114 usable CC controls/aliases, and 106 entries with an
explicit reason they cannot be mapped. CC and NRPN aliases are not independent
synth parameters. The catalog preserves the published ranges and selector
bytes; it does not fill undocumented ranges with guessed values.

The source remains ASM's [Keyboard/Desktop MIDI specification 1.5.0](https://www.mecldata.com/download/asm/legacy/Hydrasynth_KB_DR_MIDI_Spec_1.5.0.pdf),
linked from [ASM's legacy downloads](https://www.ashunsoundmachines.com/download-legacy)
when reviewed on 13 October 2026. Explorer firmware 2.2 hardware compatibility
still requires this physical acceptance run.

The documented CC assignments include ENV3 Sustain (96), ENV3 Release (97),
and ARP Octave (120). Do not use CC120 as a panic message on this instrument.
Stopping playback releases sustain with CC64=0 before individual Note Off
messages. Panic also sends All Notes Off (123).

Set PARAM TX to NRPN, restart the dashboard, and move the same controls. Also
move an arpeggiator control and a modulation-matrix source or target if the
current patch exposes them.

Pass when:

- NRPN movements are reconstructed without showing CC 6/38/98/99 as musical
  controls;
- an address with a selector byte resolves only to the matching logical
  control;
- a packed modulation index displays the decoded logical index;
- any collision that the legacy ASM document cannot distinguish is explicitly
  labelled ambiguous rather than assigned a guessed name;
- rapidly moved controls finish at the same value shown by a fresh state
  snapshot;
- no event-gap or dropped-notification warning appears during normal movement.

Return PARAM TX to the mode preferred for normal use after this test.

## 7. User takeover

Run the persistent service with a three-second takeover window. Move a physical
control, then immediately request an agent write or ramp to the same control.

Pass when:

- a non-forced write is rejected with `user_takeover`;
- a ramp reports blocked steps and continues on its original timeline;
- `takeover_remaining` counts down in state and the dashboard;
- a forced write succeeds but does not erase the still-active takeover
  countdown;
- a normal write succeeds after the window expires.

## 8. Audio route

With the Hydrasynth analogue output connected to Revolution 2x2 input 1:

```sh
./build/hydra-audio meter \
  --device 'Revolution 2x2' \
  --channel 1 \
  --duration 2 \
  --json
```

Play while the meter is running. Pass when:

- elapsed duration and frame count are non-zero and plausible;
- RMS and peak are finite and rise above the interface's idle noise floor;
- `nonfinite_count` is zero;
- `clip_count` is zero at the intended recording level.

The first run may wait for macOS microphone permission. That authorization
delay is not part of the requested two-second metering interval.

## 9. Disconnect behavior

Automatic hot-plug recovery is not implemented yet. For now, document the
result rather than treating this as a pass requirement:

1. Start the service and verify normal MIDI.
2. Unplug and reconnect USB.
3. Request status, state, one quiet note, and panic.
4. Record send errors, endpoint fields, whether input events resume, and
   whether a service restart restores both directions.

This becomes a required pass section once reconnect and bounded retry support
land.

## Result record

Record one row for each run:

| Date/time | Firmware | MIDI mode | Build commit | Result | Notes |
| --- | --- | --- | --- | --- | --- |
|  |  | CC / NRPN |  | Pass / Fail |  |

For a failure, retain the exact command/request, the relevant JSON response and
events, the dashboard warning text, and whether panic successfully silenced
the instrument.
