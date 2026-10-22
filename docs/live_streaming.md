# Live sonification input

Signal Lab connects directly from the browser to RAPP's WebSocket server. The
Python dashboard does not need an extra WebSocket dependency or a proxy. Both
the robot bridge and `viz_student_pack/player.py` broadcast the same protocol.

## Try the supplied replay server

From a checkout of [RAPP-Realtime-Viz](https://github.com/maleenj/RAPP-Realtime-Viz),
run:

```sh
cd viz_student_pack
python3 -m pip install websockets
python3 player.py recordings/enact_viz_01.jsonl.txt --loop
```

The checked-in recordings currently have `.jsonl.txt` names; use the actual
filename in your checkout. `--host 127.0.0.1 --port 8765` restricts playback to the
local machine. In **Connections → Live stream**, enter `ws://localhost:8765`
and click **Connect live**. Inspect the incoming data in Connections, then open
**Synth mixer**, **Drums** or **Music mixer** once sources appear. For the robot,
use the address supplied by the workshop, such as `ws://192.168.1.50:8765`.
Browser local-network permission and network access to that host/port are needed.
A dashboard served over HTTPS requires a secure `wss://` endpoint.

## Inspect and troubleshoot the connection

The live monitor works without playing sound. It shows message rate, time since
the last usable data, channel freshness, and current signal values. Choose a
channel and signal to see its recent graph. Joint positions and velocities are
separate inputs; unlabelled arrays and tensors use their mean for the graph and show a
bounded preview of the underlying elements.

**Pause display** freezes only the inspection view. Incoming messages, automatic
range learning and sonification continue. Resume to see current values.

Open **Troubleshooting** for connection events, invalid-message reasons, a
bounded latest-message preview and a valid JSON example. Reconnect retries the
address in the form. Diagnostic reports can be copied or downloaded; clearing
diagnostic history does not reset mapping ranges.

- **Cannot connect:** check the sender is running and the host/port match. Check
  browser local-network permission if prompted. A generic WebSocket error does
  not identify whether the sender, network, TLS or browser permission caused it.
- **Connected, no data:** the sender may be idle or paused. It must broadcast
  text messages in the format below, without a subscription request.
- **Status messages only:** the greeting confirms a connection, but contains no
  values for mappings. Start the sender's replay or robot data feed.
- **Invalid messages:** inspect the reason and latest message. Each message must
  be one JSON object with a channel and supported numeric arrays or tensors.
- **Stale channel:** that channel has stopped updating for over three seconds.
  Activity on another channel cannot make its old values usable.

Diagnostic history and message previews are bounded, and are not included in
saved sessions. Freshness uses browser receipt time, not the sender's timestamp.

## Protocol

Each text message contains one JSON object. No subscription message is needed.
The optional greeting is ignored for sonification:

```json
{"channel":"__status__","msg":"connected","server":"vam_player"}
```

Labelled joint positions and optional velocities become individual sources:

```json
{"channel":"robot_joint_states","shape":[2],"labels":["joint_1","joint_2"],"data":[0.1,-1.57],"velocity":[0.02,0.01]}
```

Unlabelled arrays and named tensors support mean, RMS, minimum, maximum and one
flattened index:

```json
{"channel":"activations","tensors":{"hidden":{"shape":[2,2],"data":[1,2,3,4]}}}
```

Nested arrays are accepted too. `shape`, timestamps and other metadata do not
control the musical clock. Invalid numbers are excluded from aggregate reducers;
an invalid indexed element is treated as missing, without shifting indices.

### Map individual body parts

The `skeleton` channel automatically exposes the ZED BODY_18 layout from the
ENACT participant handout: 18 body points, each with X, Y and Z coordinates in
metres. It accepts 54 flat values in joint-major order or 18 nested triples.
The optional `shape` must be `[18,3]` or `[54]`.

In Synth mixer or Music mixer, choose **Connections input**. The input menu
defaults to seven movement signals: **Whole body**, **Head**, **Torso**,
**Left arm**, **Right arm**, **Left leg** and **Right leg**. Each region averages
the speeds of its tracked joints. **Skeleton detail → Joints · XYZ combined**
shows one movement signal for each of the 18 joints instead.

Movement speed combines changes in all three coordinates:
`sqrt(dx² + dy² + dz²) / elapsed_seconds`, in metres per second. Stationary
tracking gives zero; movement in any direction contributes. Arms use shoulder,
elbow and wrist; legs use hip, knee and ankle; torso uses neck, shoulders and
hips; head uses nose, eyes and ears; whole body uses all 18 points. Regions
average only joint pairs tracked in both frames and wait when none are usable.
Movement IDs include `skeleton:region:left_arm:speed` and
`skeleton:right_wrist:speed`.

Motion is calculated before recording downsampling. Live input uses numeric
`t_recv` or `stamp` seconds when available, otherwise browser receipt time;
recordings need one of those timestamps. The first frame, a clock reset or a
gap over half a second starts a new baseline. Sub-millisecond intervals are
coalesced to avoid artificial speed spikes. A joint reacquired after tracking
loss needs two valid frames before its speed is available again.

**Skeleton detail → XYZ axes** retains the original 54 position inputs and raw
arrays. X increases forward, Y increases left and Z increases upward in the
camera reference frame. Left and right identify the person's body sides.
Changing the detail view only filters the menu; a selected input stays visible
and saved mappings keep their meaning. The same inputs work with recordings,
shared signal mixes and saved sessions.

Joint order is nose, neck, right shoulder, right elbow, right wrist, left
shoulder, left elbow, left wrist, right hip, right knee, right ankle, left hip,
left knee, left ankle, right eye, left eye, right ear, left ear. Thus right wrist
Z reads flat index 14 (joint 4, axis 2). Named source IDs are stable, for example
`skeleton:right_wrist:z` within the `skeleton` channel. The original **Data**
array remains available for existing mean, RMS and index mappings.

A live joint containing an invalid coordinate or the tracker's missing-joint marker
`[0,0,0]` is unavailable to named mappings until tracking recovers. It does not
contribute a false zero to automatic range learning. Other 54-element channels
are not interpreted as skeletons.

## Timing, ranges and disconnection

The musical clock samples the latest values at the chosen tempo. It does not
play one note per network frame. MIDI parameter updates run independently at
25, 50 or 100 changes/second and replace queued values with the newest values.
In both Synth mixer and Music mixer, each mapping input can automatically learn
its incoming minimum and maximum, or use an editable fixed range. Registered
inputs learn every fresh frame, including peaks between playback ticks.
Constant learned signals map to the midpoint. **Freeze** keeps the learned
range; **Relearn** resets that input without changing other mappings. Combine
inputs after normalization with average, weighted average, normalized sum,
difference, minimum, or maximum. These controls are available in Basic.
Synth's **Reset learned ranges** resets the connection's learned ranges;
learned Synth ranges persist across automatic reconnects and restart with a
new connection. Explicit fixed ranges persist with saved mappings.

Every enabled recipe requires fresh data for all its inputs. A missing source
or a channel older than three seconds silences notes and parameter output;
other active channels cannot conceal its loss. Fresh data resumes playback if
the connection remained open. A socket closure stops playback immediately;
automatic reconnect waits 1, 2, 4, 8, then at most 10 seconds between attempts.
Press **Preview** after reconnection. Switching sources, disconnecting and
stopping release notes and cancel queued MIDI/patch actions.

Live workspaces save tabs per URL. Missing sources remain in a saved live recipe
until their channels arrive, rather than silently changing its inputs.

## Bounds and implementation

- At most 32 channels and 256 discovered fields per connection.
- Latest arrays only: at most 262,144 numeric positions per channel/frame.
- At most 512 reduced source histories, each with 256 samples.
- At most 8 MiB of JSON text per message and eight nested array levels.
- Up to 32 input recipes × 64 destinations; input recipes support six sources.

`dashboard/live.js` owns frame validation, discovery, reduction and range
learning. `dashboard/parameters.js` owns catalog values, MIDI encoding and the
bounded latest-value queue. `dashboard/app.js` connects these to the shared
mapping, rhythm, chord and sound-palette engine.

Automated tests cover stale channels, tensor/joint reduction, malformed and large
frames, fixed ranges, parameter encoding, queue fairness and preset round trips.
Browser integration was exercised against the repository's actual `player.py`
with simulated MIDI output. Physical robot networking and Hydrasynth sound
response require checking on the connected hardware.
