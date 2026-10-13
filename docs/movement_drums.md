# Movement drums

Signal Lab can turn recorded or live RAPP movement into an electronic drum groove.
Choose an input in **Connections**, open the **Drums** tab, then press **Preview**.
Basic keeps the main kit, style, sensitivity, and volume controls visible.
Advanced reveals detailed rhythm settings, source selection, and presets.
The kit plays through the browser's speakers or headphones. It needs no
Hydrasynth, MIDI device, sample downloads, or additional dependencies.

Start the dashboard with `make dashboard-sonify` and open
`http://127.0.0.1:8790/`. Python 3 runs the local server; use a browser with
Web Audio support. Playback begins after a user presses Preview.

## Choose the movement

Select a recording in **Connections**, or choose **Live stream** using the
WebSocket address supplied by the RAPP producer. See [Live input](live_streaming.md)
for the protocol and replay-server setup. Open **Drums** after
choosing either source. A live connection still needs incoming numeric fields
before the groove can follow movement.

Automatic selection combines up to six signals. It prefers velocity fields,
then joint positions, then other numeric fields. Open the movement-signal
controls to choose specific signals; **Use automatic selection** restores the
automatic choice. Multiple signals contribute to one overall activity measure.
They are independent of the melodic/parameter mapping recipes.

Velocity contributes its absolute speed, so either movement direction counts.
Position and other fields contribute their change per second: holding a joint
at a high position does not count as continuous movement. Unlabeled array inputs
use changes in their root-mean-square (RMS) magnitude. A vector can change
direction while keeping the same magnitude, so use labeled joint fields when
those movements need to affect the groove. Activity is normalized by the
available signal ranges and combined using root mean square. It is a relative
musical control, not a measurement in physical units.

## Shape the groove

The display shows movement activity, tempo, density and a six-lane, sixteen-step
pattern. Its highlighted step follows the beat. The lanes are kick, snare,
clap, closed hi-hat, open hi-hat and percussion. Select a lane name to mute it.

- **Tempo range:** defaults to 75 BPM for calm movement and 150 BPM for high
  activity. Moving the endpoints changes how far the groove speeds up.
- **Rhythm density:** defaults to 10%–90%. More activity adds hits to the
  underlying groove. Calm movement can retain a sparse beat; set the calm
  density to zero if you want the groove to fade toward silence at rest.
- **Sensitivity:** increase it if small movements barely change the groove;
  decrease it if the activity meter stays near its maximum.
- **Smoothing:** higher settings make tempo and density react more gradually.
- **Groove:** choose 4 on the floor, Broken beat, or Half-time.
- **Electronic kit:** Electro, Warehouse and Minimal provide different
  synthesized drum sounds.
- **Swing:** delays alternate steps for a less even feel.
- **Fills:** adds extra variation on every fourth bar when activity is high
  enough. At zero, only the core groove plays.
- **Kit volume:** changes listening level independently of movement activity.

Tempo changes affect the drum clock. A recording continues along its original
timeline, so a faster groove does not make the robot recording run faster.
The shared Loop control repeats recorded playback. Live input follows fresh
incoming frames while the drum clock sets the timing of hits.

The drum settings, chosen sources and muted lanes belong to the active mapping
tab and are included in saved presets. Switching back to Browser preview or
Hydrasynth MIDI keeps their mapping recipes available.

## Observer and transport

Observer's Auto or Signal Lab view follows the same performance. During drum
playback it shows the virtual kit, movement activity, BPM, density and drum-hit
names. These events describe browser audio; they do not send notes or program
changes to external MIDI hardware. Switching between Signal Lab and Observer
inside the shared dashboard keeps playback running.

Stop, source/output changes and disconnected or stale live input silence the
drum engine. A held live frame does not generate new movement; its contribution
decays while waiting for fresh values. The existing live-input timeout handles
missing channels and stale sources. See the live-input document for reconnect
behavior.

## Implementation and checks

`dashboard/drums.js` contains movement analysis, density-based patterns, kit
synthesis and voice cleanup. `dashboard/drum-workspace.js` connects it to the
source library, playback transport, controls, presets and Observer feed.
`make dashboard-test` includes movement, pattern, audio-lifecycle and playback
regressions alongside the existing dashboard tests.
