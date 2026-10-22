# Keirzo setup and control

**Keirzo control** is the everyday starting point. **Start robot** connects the
drumming arms, enables their torque and moves them to their raised rest positions,
then prepares the selected effects. It also works with every effect disabled,
leaving the arms ready without starting hits. When head movement is selected,
first support the head near its saved centre with both axes inside their saved
ranges. Start checks that pose and enables holding torque before performance.
LED colours and rib breathing follow the selected Music mixer or Synth mixer.
Head movement can follow that beat or run at its own pace.

**Keirzo setup** is available when needed for calibration, individual tests,
and connection troubleshooting. It connects the rib cage, drumming arms, and
two-axis 2XL430-W250-T head on separate USB serial ports, plus LEDs over USB MIDI.
Ribs have position tests; drums have a one-click strike and return test.
Head setup reads its two axes and records travel by hand with torque off.
Powered head movement is available in Control after saving a matching range.

Switching dashboard tabs keeps playback, MIDI connections, and live robot
control running. Use **Stop** in Keirzo control to stop its sequence. The
dashboard must remain open; closing or reloading it ends browser sequencing.

## Live control

Open **Keirzo control** at `http://127.0.0.1:8790/#robot-control`.
Choose **Follow → Music mixer** or **Follow → Synth mixer** at the top.
Keirzo uses that mixer's playback tempo and beat position, with a read-only BPM
display. The link below the selector opens the chosen mixer. The same source
selection applies to lights, ribs, beat-synced head movement and automatic drums;
the drum panel's Follow selector stays in sync. Changing source cancels queued
drum hits; press **Start drumming** again to play with the new source.

Sync uses the dashboard's playback clock. Imported audio in **Music mixer**
automatically prepares and applies beat timing before playback, including
leading silence, pauses and tempo changes. Press Play normally; it waits for
**Beat sync ready** when analysis is still running. No separate analysis or
apply action is needed. Generated music uses its requested BPM unless detected
timing is selected in **Music mixer → Recent tracks → Beat timing · Advanced**.
If music is stopped, synced effects wait for playback to resume. Head movement
continues at its own pace when **Beat sync** is off.

Choose an Aurora, Firelight, Ocean, or Candy palette, or edit its four colours.
**Solid colour** uses the first colour, **Palette cycle** advances through the
colours, and **Beat pulse** pulses brightness on each beat. Set how often the
colour changes and the overall brightness. LEDs use the same automatically
detected Pimoroni controller as Keirzo setup.

Rib breathing is optional. Set its minimum and maximum positions on the
original **0–127** Max scale and choose how many beats pass before moving to
the next position. For example, 4 beats gives a complete out-and-back cycle
of 8 beats.
The live controls use the same mirrored motor mapping and bounds as the setup
tests. **Start robot** finds the Pimoroni controller for selected LED effects,
checks all six ribs on the selected or default rib adapter when breathing is
enabled, and turns rib torque on if needed. Connection and mode errors appear
in Control; use Setup to change adapters or investigate a fault. Starting
LED-only effects also prepares the drumming arms. All four arms must be connected
and ready at rest before startup completes. An active strike or drumming sequence
blocks rest preparation; stop drumming before starting the robot again.

The head panel has **Enabled**, **Beat sync**, and **Busy-ness** controls, with
Manual and Auto activity choices. **Enabled** includes the head in **Start
robot** preparation; new preferences leave it off. Manual Busy-ness ranges
from 0 to 100. **0** now means calm, ongoing movement, with the same span as the
previous **100** setting. Turn **Enabled** off to stop scheduling head movement.
Higher Busy-ness values make movement wider and more active. The span rises
from 25% to 80% of each recorded half-range around the centre, retaining an
additional 10% margin inside that span. Targets therefore reach up to 22.5%
of each half-range at 0 and 72% at 100.

**Auto** gently varies activity between 15 and 65 over time. It is independent
of the music's volume and energy. Movement varies between sweeps, wandering
paths, and drifting turns in sustained phrases of four to seven cues. Both axes
start together with different travel lengths, then continue independently.
Their turnarounds are staggered so one axis carries the motion while the other
finishes and begins its next segment. Longer profiles and varied targets keep
the head moving without programmed holds between completed moves.

**Beat sync** starts enabled. When enabled, the first movement begins on a
fresh beat from the selected mixer and profile lengths follow whole beats when that keeps
a moderate movement pace. Each axis's subsequent moves
continue as soon as its preceding profile finishes, without another beat-sized
pause. Head movement waits when
playback stops. Turn it off for ongoing movement at its own pace, including
when the selected mixer is stopped. Missed cues are skipped instead of replayed,
and changing tabs keeps the chosen behavior running.

Before starting active head movement, position and support the head near its
saved centre with torque off. Both axes must be inside their saved ranges.
Starting checks the saved connection and preloads the measured current pose
before enabling torque, so torque-on holds that pose. Preparation does not
send a centring move. Normal head movement begins after preparation. See
[Position the head before starting](#position-the-head-before-starting).
**Release head** in **Keirzo setup** stops head movement and turns head torque
off, allowing the range to be recorded again. Motor labels come from the saved
calibration; change them in Setup after identifying the axes.

Control scales head duration with travel, aiming for 50–65 ticks/second average
travel (about 4.4–5.7 degrees/second). Small gestures can finish in one to three
seconds; substantial sweeps stay longer, up to ten seconds. Beat alignment is
skipped if it would slow average travel below 40 ticks/second. The controller's
one-second minimum still applies to unusually small saved ranges. It avoids
tiny corrective gestures when a larger move fits the selected span. Individual steps are
limited to 675 ticks, so wider paths use successive moves. The server lengthens
profiles for larger moves using a conservative 150 ticks/second peak-speed
bound and half-duration acceleration, up to ten seconds; a target requiring
longer is rejected. This bound covers travel from both the measured pose and
the previous goal/internal trajectory, which can differ under load.
Each axis waits for its own actual movement duration and busy state before its
next command; the other axis can continue moving. Each segment sends one goal
per selected axis; the Dynamixel generates its acceleration and deceleration
internally. A paired command validates both targets and stages both profiles
before sending their goals consecutively. A failed or uncertain goal stops the
sequence without automatically retrying the batch. Before normal moves, targeted
reads recheck the already identified axes instead of repeating broadcast discovery.
Full discovery remains part of connection setup. An active axis's goal is never
replaced mid-profile. Rib and head commands share an
ordered queue without starving either group. Music mode remains the only tempo
control.

Press **Start robot** to prepare and run the selected effects and **Stop** to
cancel preparation or stop the sequence. Preparation shows its connection or
torque-on step. Navigating to another dashboard tab keeps the sequence and its
beat source running. Stop turns the LEDs off and stops future rib and head
commands; a movement already sent completes and holding torque remains on.
Use **Release ribs** in Keirzo setup
to turn off rib torque, or **Release head** there for the head.

Palette, timing, and head-activity preferences are remembered and included in
saved dashboard sessions. Older settings using Auto or a positive Manual
Busy-ness retain an enabled head; older Manual 0 settings remain disabled.
Opening or restoring a session does not start robot playback.

## Automatic drumming

In **Keirzo control → Automatic drumming**, choose **Music mixer** or **Synth mixer**,
enable the arms you want, and press **Start drumming**. Drumming has its own
start button; **Start robot** prepares the arms at rest and controls LEDs, ribs, and head.
The top **Stop** ends both performances. The drum panel's Stop affects only drums.
Tab changes keep drumming active. Settings and named sessions restore passively.

**Music mixer** uses the playing track's BPM and beat position. **Synth mixer** uses
the synth clock and actual note events, including probability, rests, chords,
and repeats. The previous bar's note accents shape the next drum bar. A chord
counts as one onset. Straight, Broken beat and Half-time grooves offer density,
synth influence, fills every fourth bar, and individual arm selection. Timing
limits may remove fast hits. Editing a setting stops drumming; review the
settings and press **Start drumming** again when ready.
Each drum is limited to **one hit per second**, including at maximum density
or during fills. Different drums may strike simultaneously or close together;
there is no shared spacing limit between drums. The browser thins the pattern
and the server independently enforces the same per-drum limit.

Start waits for the selected source to play and checks the separate arm adapter.
If any arm is unpowered or away from its configured rest, it enables arm torque
and moves all four arms to rest over two seconds. This also handles arms that
are already powered outside their normal strike ranges. The selected arms then
receive the usual 500 ms rest preparation. Each must be within its strike range
and within 20 ticks of rest before hits are allowed.
The nominal movement duration is not treated as proof of arrival. After preparation
or a return, a healthy arm has up to one additional second to settle, with position
and health checks every 50 ms or when the serial bus is available. It cannot strike
again until rest is confirmed. If a healthy, powered arm reads outside its playing
range, its queued hits are discarded and it returns to rest over two seconds.
Boundary rest targets are inset by 10 ticks (Drum 3 uses 2590) to allow for small
overshoots. The arm rejoins future hits only after an in-range rest readback;
the one-hit-per-second limit still applies. Recovery gets one bounded settling
window and never retries an uncertain write. A settling timeout, lost torque,
or motor fault pauses only that arm and retains its reason in the arm status.
Other arms continue playing. Start a new session after resolving a paused arm's fault.
Source stops, track changes and timing discontinuities cancel queued hits;
while Start remains active, valid playback prepares and rejoins automatically.
Adapter disconnects, explicit torque release, and emergency stop end the entire
session and require a new explicit Start. Resetting emergency stop never restarts drumming.

The server schedules each arm independently using absolute contact times. A
short queue is refreshed from the browser, with a one-second heartbeat timeout.
Expired, duplicated and physically infeasible hits are dropped. Normal Stop
discards upcoming hits and lets healthy arms already moving finish their return;
emergency stop, torque release and disconnect cancel all further motion.
The service status retains dispatched-strike and skipped-hit counts for diagnostics.
Hits are sent 650–950 ms ahead of their intended contact. The controller checks
the arm and stages its profile before the dispatch time, leaving only the goal
write for the timed strike. This avoids spending the strike's entire lateness
allowance on repeated serial reads. A delayed or cancelled goal is still dropped.

Intended strike timing comes from the sibling `drumming-robot` repository:
`dynamixel_control/stroke_colls/` and `stroke_routing.maxpat`. The Max patch
delays by `400 − hit time`, then strikes for the stored hit time, aligning contact
at 400 ms after its trigger. This scheduler equivalently starts at
`target contact − hit time`; it does not add another 400 ms of latency.

| Current part / motor | Profile source | Strike lead | Return | Minimum repeated contact interval |
| --- | --- | --- | --- | --- |
| Kick / 0 | `kick.txt`, row 0 | 150 ms | 150 ms | 1000 ms |
| Ride / 1 | `snare_hit.txt`, row 0 | 150 ms | 150 ms | 1000 ms |
| Snare / 2 | `ride.txt`, row 0 | 150 ms | 150 ms | 1000 ms |
| Hi-hat / 3 | `hihat.txt`, row 1 | 200 ms | 150 ms | 1000 ms |

Mechanical recovery also requires the strike and return durations plus a 50 ms
allowance; the one-second spacing is stricter for these profiles. The exchanged snare
and ride retain their motor-specific positions and profiles. Hi-hat row 0 starts
outside the existing Max bounds, so the in-range row 1 remains in use. These are
the original intended timings; acoustic contact alignment has not been measured
by this implementation. The source repository is read for provenance only and
is not needed at runtime.

Imported music follows detected beat timestamps automatically. Local analysis
runs when the track is loaded and playback waits until alignment is ready. The
analysis prefers a completed drum stem, otherwise the full mix, and does not
require an ElevenLabs request. Drums wait before the first detected beat and
in inactive gaps. When drums are already armed, playback may add a brief startup
delay to provide enough time to schedule the first strike. A four-beat groove accent is estimated from the audio;
ambiguous rhythms can affect the estimate. Optional **First detected beat in
bar** and **Timing adjustment (ms)** overrides live in the collapsed **Beat
timing · Advanced** controls. Positive timing shifts contacts later. Analysis
and settings are retained in Sessions and reused on load. The robot still plays
its selected groove, rather than reproducing individual strikes from the drum
stem. Loading or analyzing a track does not start drumming.

Generated tracks without detected timing, and imported tracks explicitly set to
**Timing mode → Manual BPM**, use a grid estimated from requested generation BPM
or uploaded **Track BPM**, starting at the file's beginning.
Mapped BPM and playback-speed changes keep the
drumming session running, including while speed is ramping. Upcoming hits follow
the latest tempo; contacts already sent retain their timing within the short
planning horizon (up to 950 ms). Abrupt changes can briefly shift alignment or
skip hits to preserve the one-hit-per-second limit for each arm. Stops, manual
track changes, and seeks cancel the old timing and resynchronize. Natural loops
with detected timing keep the drumming session running and schedule the next
loop's beat positions. The BPM-estimated clock also resets its timing on loops.
There is no independent drum tempo and no microphone analysis in this version.

The new scheduler, source following and cancellation behavior are verified using
fake clocks, HTTP requests and simulated serial hardware. Physical strike timing
and continuous multi-arm operation remain to be checked on Keirzo.

## Install serial support

Install the optional serial dependencies in this repository, then start the
dashboard:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-robot.txt
make dashboard-sonify
```

The Makefile uses `.venv/bin/python` when available. `requirements-robot.txt`
pins `dynamixel-sdk` 3.8.4 and `pyserial` 3.5. Open
`http://127.0.0.1:8790/#robot-setup`.

Each motor group has its own port selection and connection check. The
dashboard prevents two groups from opening the same adapter, including its
macOS `/dev/cu.*` and `/dev/tty.*` aliases. Connections remain open when
switching dashboard tabs. Close other serial clients before checking a port;
the legacy `interaction.py` bridge opens both rib and drum ports and is not
needed by these controls.

### Automatic USB identification

[`config/robot-devices.json`](../config/robot-devices.json) maps each motor group
to its adapter's USB vendor ID, product ID, and unique serial number. The
dashboard resolves that identity to the current port when finding defaults;
numbers such as `12201` or `14201` are not part of the saved identity. Moving
the adapter to another USB socket, hub, or computer does not require editing
the port path. These are the configured devices:

| Group | USB device | USB serial number | Baud |
| --- | --- | --- | --- |
| Head | ROBOTIS OpenRB-150 | `6430A5355055344E312E3120FF0C0B25` | 1,000,000 |
| Ribs | FTDI USB serial adapter | `FT78LBUJ` | 1,000,000 |
| Drums | FTDI USB serial adapter | `FT7WBEBD` | 1,000,000 |

Matching uses all three USB fields. The two FTDI adapters share a device type
but have different serial numbers, so they stay assigned to their respective
motor groups. Discovery only reads the computer's port list; it does not open
a serial connection, enable torque, or move a motor. An absent or ambiguous
device is not replaced by another adapter. Manual port selection remains
available in Setup.

After a reconnect, use **Refresh ports** to find current defaults, then the
group's connection check to read its motors. Existing motor checks and head
range validation still apply. Discovery alone does not establish that the
attached motor bus is correct or ready for movement.

### Move this setup to another computer

For another Mac or Linux computer, copy or clone this repository, install Python 3, and run the
serial dependency and dashboard commands above. `make dashboard-sonify` does
not build the native MIDI controller. Connect the same powered hardware,
then open `http://127.0.0.1:8790/#robot-setup` in a browser with Web MIDI support,
such as Chrome.

Bring these setup files with the robot:

- `config/robot-devices.json`, included with the repository, supplies the USB
  identities and baud rates. Carry over any local edits to this file.
- `var/robot/head-calibration.json` contains the head's recorded ranges and
  axis labels. Copy it into the same relative location on the new machine.
  The `var/` directory is ignored by Git, so cloning alone does not transfer
  this calibration. Keep the file with the same mounted head assembly.

Head calibrations with a `device_identity` field follow the head adapter when
its port name changes; the baud rate, motor IDs, and model still have to match.
Older calibrations containing only `device` retain their original path and do
not acquire a new identity just because a similar adapter is connected.

On the new computer, confirm that each group has the expected default, then
use **Identify head** and each **Check connection** button to verify the motors.
These checks read hardware without enabling torque or moving it. The saved
head range must report a matching connection before powered head control is
available. Opening the dashboard does not start robot performance.

Allow browser MIDI access when prompted for the LEDs; permission is granted
on the new browser, not transferred with the repo. The existing Plasma 2040
is discovered by its MIDI name and manufacturer rather than its serial port.
Browser sessions and presets also remain in the original browser; use their
**Export** and **Import** controls to transfer them. Music generation requires
the new machine's own local `.env` configuration, and recorded rap input needs
the [Whisper setup](reference.md#rap-response).

To inspect attached USB serial identities and the robot's role matches without
opening them:

```sh
.venv/bin/python tools/robot_devices.py
```

For the raw pySerial listing, use
`.venv/bin/python -m serial.tools.list_ports -v`.

[pySerial exposes USB identity fields on macOS, Linux, and Windows](https://pyserial.readthedocs.io/en/latest/tools.html).
This makes adapter identification independent of platform port names. The
native tools support macOS and Linux; see [Linux setup](linux.md) for build,
MIDI/audio access and serial permissions. On Linux, the same USB identities
resolve to `/dev/ttyUSB*` or `/dev/ttyACM*` ports. Automated serial tests use
simulated motors on both platforms; physical robot checks are still required.
This does not establish native Windows support.

## Set up and check the rib cage

1. Connect and power the rib cage's Dynamixel interface. Close
   `interaction.py`, Max, or any other serial client using its port. Ribs do
   **not** need the OSC bridge; that bridge opens the rib port itself and must
   not run at the same time as direct rib control.
2. In **Rib cage**, select its serial port. The attached adapter was listed as
   `/dev/cu.usbserial-FT78LBUJ`; check the selection against your device.
3. Press **Check connection**. This reads positions and torque state from
   motors **20, 21, 22, 25, 26, 27** at **1,000,000 baud**, using Dynamixel
   **protocol 2.0**. It does not enable torque or move a motor.

The panel shows each motor's reply or error and the time of the last check.
These readings are a snapshot, not a continuous monitor. A listed serial port
alone does not confirm communication with the motors. All six motors must
respond before live rib movement or torque-on is available. Changing the port
requires another check for that group.

## Test the rib cage

In **Keirzo setup**, after the connection check succeeds, press
**Rib torque on**. Set a position and press **Test rib cage**, or expand
**Individual rib motors** and use **Test position** for one motor.
Test buttons send directly to the hardware and record commands in **Command
log**. Changing a slider, number, colour, or preset only prepares a test.

The grouped 0–127 control mirrors the two sides. At 0, motors 20–22 target
2450 and motors 25–27 target 1700; at 127, they target 4090 and 0 respectively.
**Test rib cage** sends all six targets, with a default time of 2500.

Motor output is available by default; there is no separate enable step.
Movement still requires the selected motor's torque to be on. Connection
checks, tab changes, and releasing one group do not disable other groups.

**Release ribs** affects only the six rib motors and is available even when
emergency stop is latched. Legacy all-motor torque commands are disabled in
both the interface and the server, so these controls cannot affect the head.
On an adapter not yet verified as the rib bus, release first checks all six
rib IDs before writing. On a verified rib bus it attempts to release every rib
even if some motors fail to reply. **Disconnect** closes the serial port and
leaves holding torque unchanged.

Before moving, direct rib control reads all six motors again and requires the
selected motors to have torque enabled, position operating mode, and
time-based profiles. It does not change those mode settings. It writes the
duration to **Profile Velocity (register 112)** and the target to **Goal
Position (register 116)**, checking each write's reply. An acknowledgement
confirms the register write, not arrival at the target. The interface accepts
times from 100–5000 ms; this is the test interface's policy, not a motor limit
recovered from Max.

## Connect and test the drumming arms

Select the drum adapter in **Drumming arms**, then check the connection.
The original adapter is `/dev/cu.usbserial-FT7WBEBD`; choose the actual attached
device. Direct checks read motors **0, 1, 2, 3** at **1,000,000 baud** using
**protocol 2.0**, showing each motor's position, torque state, and errors.
Connection checks do not change torque or move the arms. The OSC bridge is
not needed.

Press **Arm torque on + rest** to move all four arms to their configured rest
positions over two seconds. Any readable valid starting pose is accepted,
including positions outside the normal strike ranges. Pressing it while torque
is already on also returns the arms to rest. The controller confirms all four
arms have stopped within their strike ranges and within 20 ticks of rest before
reporting success.

The controller preloads the fixed rest targets, enables and confirms torque,
then sends the two-second movement profile and rest target again while the
motors are powered. This ensures the move is commanded even if a motor does
not retain a goal while unpowered or resets it at torque-on. Starting position
does not block this rest movement. Every write must be acknowledged; failed
writes are never retried. Settings are read back after the powered command for
diagnostics, and measured arrival and stopped arms determine success. A timeout
reports the arms still away from rest and any differing settings. Communication
errors, motor faults, and emergency stop still stop preparation immediately.

Then use **Test strike** for kick, snare, ride, or hi-hat. Each test raises the
arm to its configured rest position over 500 ms,
hits down using its configured strike target, and returns to that same raised
rest using a 150 ms profile. A fresh read must place the arm within 20 ticks
of rest before the hit is sent. Only one strike can run at a time; another
click does not queue a hit. The server completes the cycle across tab changes.

The snare and ride were physically exchanged: **motor 1 is Ride** and
**motor 2 is Snare**. Their position limits and rest/hit values remain attached
to their motor IDs.

The starting position for a strike must still be inside that drum's Max bounds.
If an arm is outside its range, use **Arm torque on + rest** to return it before
striking. The other drums remain available. Manual
position sliders and presets are under **Advanced** and send a single move
without an automatic return.

Drum torque controls affect only IDs 0–3 on the selected drum port. Release
cancels a pending return and is available while emergency stop is latched.
Disconnecting the drum port also cancels the return, leaving torque unchanged.

Tests use the Max bounds below, require position mode and time-based profiles,
and check the reply to each register write. A successful write confirms the
command was received; it does not confirm arrival at the requested position.

## Emergency stop

**Emergency stop** is available in Keirzo setup and Keirzo control. It stops the
browser's live robot sequence, cancels queued motor commands and drum returns,
and requests torque off for every rib, drum, and head motor on already-open,
verified buses. It does not open unknown adapters.
Head range recording stops and retains its captured samples.

The stop stays latched across tab changes and page reloads while the dashboard
server is running. **Reset emergency stop**, available in both Keirzo tabs,
clears the latch without turning torque on or resuming cancelled actions.
Press **Start robot** again to prepare the selected live effects, or use the
separate group torque buttons for manual testing. A server restart starts with output available, without
opening ports or sending motor commands.

This is a software stop over serial. Failed torque-off writes are reported;
unavailable motors cannot be released through this connection. Torque off
also removes holding force. The ordinary **Stop** in Keirzo control just stops
its sequence and retains motor torque.

## Connect the two-axis head

The connected head was identified read-only on **16 October 2026** through a
**ROBOTIS OpenRB-150**, `/dev/cu.usbmodem12201`, at **1,000,000 baud**.
Both axes report model **1090**, firmware **45**, time-based profiles, and
position operating mode **3**. IDs **0** and **1** are on this separate head
bus; they must not be routed to the drum adapter, which reuses those IDs.

At 14:55:34 Australia/Sydney, the current pose was recorded as the upright
reference: **ID 0 = 2133**, **ID 1 = 2502** ticks. Both reported torque **off**;
no torque, position, or configuration writes were sent. Which ID controls
each physical axis remains unverified. The user subsequently recorded mounted
travel ranges by hand, stored in `var/robot/head-calibration.json`.
The reported device limits **0–4095** are not safe mounted-head limits.

The known head adapter is selected automatically at **1,000,000 baud**. Check
its connection before using it. For a different setup, select the head's
separate serial adapter and actual configured baud rate; **57,600 baud** is
the 2XL430-W250-T factory default. Discovery reports the responding motor IDs and model numbers rather
than assuming factory IDs 1 and 2. The expected model number is **1090**.

Head connection checks use only ping and register reads. They show both axes' measured
positions, torque state, modes, and errors. With the head in its current
upright pose, record those positions as an upright reference. The readings
remain in server memory until restart or a change of head adapter, baud rate,
or discovered axes; they are not saved in dashboard sessions. Recording does
not write to the motors, enable
torque, centre the head, or establish calibrated minimum and maximum positions.

Powered head commands require an exact match to the saved adapter identity
(or port path for older calibrations), baud rate,
two motor IDs and model, healthy readbacks, position mode 3, and time profiles.
They are blocked while range recording runs, for secondary-ID aliases, or when
automatic torque-on by goal update is enabled. Ordinary torque-on and movement
also require the measured pose to be inside the saved range. Support the head
and position it by hand with torque off before starting if it rests outside
that range.
No EEPROM configuration or factory position limits are changed. The sibling robot repo contains
only the previous three-motor head configuration on IDs 4–6; those settings
are not used for this head. See the [ROBOTIS control table](https://emanual.robotis.com/docs/en/dxl/x/2xl430-w250/)
for the model's register definitions and factory settings.

### Record head travel by hand

The head panel can record the two axes while you move them physically. It
does not enable torque or send movement commands. Both axes must respond with
torque off before recording can start.

1. With the head upright, select **Start recording**. The centre comes from
   the upright reference when one exists for this connection; otherwise it
   uses the starting position.
2. Move each axis gently through the travel you intend to use, stopping before
   resistance. The panel shows current position and the lowest and highest
   readings recorded for each motor. Name the axes as you identify them.
3. Select **Stop recording**. If needed, return the head to your preferred
   centre and use **Capture centre**. This reads both motors again.
4. Select **Save range**. Both axes need a nonzero recorded span, with their
   centres inside that span. Saving replaces the previous saved range only
   after validation and a successful file write.

Sampling runs in the server and continues across tab changes. Opening a tab
does not start recording. A read error, torque becoming enabled, or a changed
connection stops recording; the panel reports the reason. Saved ranges live
in `var/robot/head-calibration.json` and survive dashboard restarts. Unsaved
recordings and the upright reference remain in memory only. Loaded ranges
are marked as matching only after the connected adapter, baud rate and motor
identities have been checked.

These are observed positions for this setup, not the motor's factory limits
or proof that every combination of the two axes is safe. Saving does not enable
torque or start movement. Control combines both axes within the saved ranges
and the activity span described above.

### Position the head before starting

The head can rest below its saved movement range when torque is off. Before
starting head movement:

1. Support the head, then use **Release head** in **Keirzo setup** if torque is
   on. Confirm torque is off before moving it by hand.
2. Gently position and support it near the saved centre, with both axes inside
   their saved ranges. **Identify head** reads the current positions without
   enabling torque or moving it.
3. Turn on the head's **Enabled** control, select Auto or a Manual Busy-ness,
   and press **Start robot**.
   Preparation checks both axes and enables torque to hold their measured
   pose. Keep supporting the head until holding torque is confirmed, keeping
   clear of its moving joints. Normal head movement follows after preparation.

For the recorded assembly, the saved centres are **ID 0 = 2075** and
**ID 1 = 2529** ticks, with ranges **1408–2654** and **1948–3071** respectively.
Use the saved range shown in Setup if the calibration has since changed.
Starting is blocked while either measured position is outside its saved range.

**Stop** stops future movement commands and retains holding torque. **Release
head** and emergency stop release torque; support the head before deliberately
releasing it. Opening a page, restoring a session, restarting the dashboard,
or pressing **Identify head** does not enable torque or start performance.

### Read head motion diagnostics

`GET /api/robot/head/diagnostics` takes a read-only sample of the already open,
identified two-axis head. It reports actual position, internal position and
velocity trajectories, goal, motor output, inferred load and supply voltage.
It does not open a connection, enable torque, or send movement commands. It
can sample during a move; ordinary status polling continues to use cached
state. Identification also reports the current position gains and temperature.

The 19 October 2026 small-movement test showed the internal trajectory advancing
while the measured axis stayed still, followed by two forward bursts and about
5.2 degrees of remaining position error. Supply voltage stayed near 12 V. The
user observed back-and-forth vibration which was not resolved by this position
recording, so its physical cause remains unconfirmed. The selected response is
to avoid very slow movement, with no further gain tuning. Position gains remain
unchanged at P 640, I 0, D 2000,
the [2XL430 factory defaults](https://emanual.robotis.com/docs/en/dxl/x/2xl430-w250/#control-table-of-ram-area).

## Connect the LEDs

Connect the Pimoroni Plasma 2040 over USB and open **Keirzo setup**. The
dashboard automatically finds the controller and displays its name; no MIDI
device selection is needed. It also reconnects automatically after the USB
cable is unplugged and reconnected. The device normally appears as
`Plasma 2040 CircuitPython usb_midi.ports[0]`. Use a browser with Web MIDI
support and grant MIDI access when prompted. If access fails, use the MIDI
retry button after allowing access.

Automatic connection matches Plasma 2040 or Pimoroni outputs and never falls
back to the synth. This assumes the current setup's single matching LED board;
connecting a second matching board would need an explicit selection mechanism.
Connecting or reconnecting does not change the LEDs. A new browser needs its
own [MIDI permission](https://support.google.com/chrome/answer/14871962).

Choose **Colour** and **Brightness**, then **Test colour** or **LEDs off**.
These buttons send directly to the detected controller and do not require
motor torque.

If the controller appears but the LEDs stay dark, check the hint beside the
LED controller, use a non-black colour with brightness above 0%, then press
**Test colour**. Changing a slider or connecting MIDI does not send a test.
Reopening the robot workspace reconnects the controller without sending a
colour. A detected MIDI device confirms USB discovery;
it does not confirm the board's LED program is running.

The checked-in `lights/code.py` receives MIDI channel 1 (zero-based channel 0).
A solid colour is two messages, in order:

1. Note On: note **1**, velocity **red**.
2. Polyphonic Key Pressure: note **green**, pressure **blue**.

Each colour component is 0–127. The firmware scales it to 0–255 and fills all
96 LEDs. Off uses the same messages with all three components zero. LEDs use
USB MIDI directly, independently of the motor serial connections.

## Ranges and preset provenance

Motor positions are raw Dynamixel ticks, not degrees. Drum bounds below come
from `max-control.maxpat`, subpatch `p ranges` (`obj-114`), comment `obj-2`.

| Motor | Part | Allowed positions | Max start → end |
| --- | --- | --- | --- |
| 0 | Kick | 2100–2450 | 2100 → 2450 |
| 1 | Ride | 1850–2125 | 1850 → 2125 |
| 2 | Snare | 2070–2350 | 2350 → 2070 |
| 3 | Hi-hat | 2410–2600 | 2600 → 2410 |
| 20, 21, 22 | Rib group A | 2450–4090 | 2450 → 4090 |
| 25, 26, 27 | Rib group B | 0–1700 | 1700 → 0 |

Rib bounds come from the connected `scale` objects in `p ribs` (`obj-99`) in
the same patch. Its all-together movement appends a time of 2500; its ripple
uses 1300. These bounds are narrower than the 2400 minimum in `ribs.py`, whose
range check is commented out.

The single-stroke data comes from `dynamixel_control/stroke_colls/`. These
representative presets fit the Max bounds:

| Motor / current part | Original source | Rest up | Hit down | Hit time |
| --- | --- | --- | --- | --- |
| 0 / Kick | `kick.txt`, row 0 | 2200 | 2370 | 150 |
| 1 / Ride | `snare_hit.txt`, row 0 | 1850 | 2000 | 150 |
| 2 / Snare | `ride.txt`, row 0 | 2300 | 2150 | 150 |
| 3 / Hi-hat | `hihat.txt`, row 1 | 2600 | 2430 | 200 |

The table's hit times are used by **Test strike**. Advanced position presets
leave the currently chosen manual duration unchanged. Source decimals
are truncated to integers, matching the Max abstraction's `unpack i i i`.
For reference, in the original `stroke_routing.maxpat`, the hit is delayed by
`400 − hit time`; a return to the stored rest position follows after the hit
time, with return time 150. That patch does not issue an initial move to rest:
its `append 100` object has no connected input. `dynamixel_control/practice.py`
explicitly prepares the first coll value over 500 ms, hits the second value,
then returns to the first. The dashboard uses this rest → hit → rest sequence
and Max's 150 ms return profile, without Max's initial beat-alignment delay.
The initial measured position is retained for diagnostics and range checks;
it is not the return target. This avoids starting a strike from an arbitrary
lowered pose or accumulating read-back offsets over repeated tests.

There is a hi-hat calibration discrepancy: `drum.py` allows 2410–4000, while
the Max range comment specifies **2410–2600**. Row 0 of `hihat.txt` starts at
2660 and falls outside the Max bounds. The test uses the in-range row 1,
2600 → 2430, instead of expanding the range.

## Verification limits

Automated tests use mocked hardware and local protocol checks without moving
the robot. A direct USB MIDI diagnostic on 16 October 2026 was received and
processed by the Plasma firmware, and the user confirmed the strip lit dim
white. The board also reported the off command as `[1, 0, 0, 0]`. After the
off command was resent, the user confirmed the strip was dark. This diagnostic
does not establish an end-to-end browser test.

The user has tested rib and drum movement and recorded the head ranges by
hand. On 16 October 2026 the accidental kick and snare position changes were
restored to their logged pre-change targets, 2450 and 2040 ticks, using 1000 ms
profiles. Subsequent measured positions were 2449 and 2037; ride and hi-hat
were unchanged. The new strike/return and emergency-stop behavior was tested
with simulated hardware, not exercised on the physical robot. The wider,
flowing head sequence is verified with simulated hardware; no powered test of
this change was sent by the assistant. Check its physical movement at Manual
Busy-ness 0 after manually positioning the head near its saved centre.

A displayed target is a requested position. Connection tables report measured
positions from timestamped checks, including the final read after a strike's
return. They do not continuously track movement or guarantee exact arrival.
The head's observed ranges do not establish safe powered movement.
