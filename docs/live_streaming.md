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
local machine. In Signal Lab, enter `ws://localhost:8765` under **Live RAPP**,
click **Connect live**, and press **Preview** once sources appear. For the robot,
use the address supplied by the workshop, such as `ws://192.168.1.50:8765`.
Browser local-network permission and network access to that host/port are needed.
A dashboard served over HTTPS requires a secure `wss://` endpoint.

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

## Timing, ranges and disconnection

The musical clock samples the latest values at the chosen tempo. It does not
play one note per network frame. MIDI parameter updates run independently at
25, 50 or 100 changes/second and replace queued values with the newest values.
Each source can learn minimum/maximum from samples read during this connection,
or use a fixed physical range. Constant learned signals map to the midpoint.
Use **Reset learned ranges** to recalibrate; learned ranges persist across an
automatic reconnect but start fresh on a new connection.

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
