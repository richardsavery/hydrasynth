# Linux setup

The dashboard, native MIDI controller and input audio meter support Linux.
The native tools use ALSA; existing macOS CoreMIDI/Core Audio backends remain
available. The Python dashboard and command broker use the same CLI and JSON
protocol on both systems.

For step-by-step operation, see the illustrated [instruction manual (PDF)](instruction-manual.pdf)
or [offline HTML manual](instruction-manual.html), starting with its quick start.

The common `bash tools/setup.sh` command selects the Linux installer here.
The original `bash tools/setup_linux.sh` command remains available. For Mac,
see [Mac setup](macos.md).

## Install and build

On a new Ubuntu/Debian computer, install Git if needed, clone the repository,
then run the setup command as your normal user:

```sh
sudo apt-get install git
git clone https://github.com/richardsavery/hydrasynth.git
cd hydrasynth
bash tools/setup.sh
make dashboard-sonify
```

Use your normal GitHub authentication if the repository is private. Open
<http://127.0.0.1:8790/#synth-mixer>; leave the terminal open, and use Ctrl+C
to stop. Setup does not start a background or login service.

Setup installs missing system packages (asking for your sudo password when
needed), creates or reuses `.venv`, installs or updates the Python runtime
dependencies, builds and self-tests the native tools, automatically downloads
Whisper Small if missing, checks that it loads locally, and offers a hidden
API-key prompt when no key is already configured. Press Enter to skip the key.
Existing keys and local data are preserved when rerunning setup. The key is never passed as a shell argument.
No physical MIDI, audio capture or robot commands are used during setup.

Whisper and its Python dependencies are included by default. No separate model
installation is needed. Existing complete model files are reused. Python packages
are upgraded within the versions allowed by the requirements files; indirect
dependencies are upgraded only when required. Setup does not perform a general
operating-system upgrade.

Useful options:

```sh
bash tools/setup.sh --skip-model  # defer the model download
bash tools/setup.sh --skip-system  # system dependencies already provided
bash tools/setup.sh --no-key  # configure the key separately later
.venv/bin/python tools/configure_api_key.py  # hidden prompt
.venv/bin/python tools/configure_api_key.py --replace  # rotate a saved key
```

The default interpreter is `/usr/bin/python3` (Python 3.10+), avoiding an asdf
shim that has not been set up on the new computer. Set `PYTHON` to another
interpreter before running setup if needed. Node.js is only needed for the
JavaScript regression tests, so the runtime installer does not install it.

The equivalent manual installation is:

```sh
sudo apt-get install build-essential pkg-config libasound2-dev alsa-utils python3-venv ffmpeg ca-certificates
/usr/bin/python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-robot.txt -r requirements-rap-response.txt -r requirements-beat-tracking.txt
make
.venv/bin/python tools/prepare_rap_transcription.py
.venv/bin/python tools/configure_api_key.py
```

Node.js is needed for the dashboard tests, not for serving the dashboard.
The checked-in `.tool-versions` selects Python 3.12.9 and Node.js 22.20.0 for
asdf users. Other installations can use their existing Python 3.10+ and a
current Node.js; `PYTHON`, `NODE`, and `CC` may be supplied to `make`.

The build uses `pkg-config` for ALSA when available. An unprivileged Ubuntu
setup can instead download the matching `libasound2-dev` package and extract
it into `var/native-deps` with `dpkg-deb -x`. If system ALSA development
metadata is absent, the Makefile detects the extracted
`var/native-deps/usr/include/alsa/asoundlib.h` and links to the installed
`libasound.so.2` runtime. Match the headers to the installed ALSA version;
this fallback does not install or change system packages.

## Installing on six laptops

Provision a separate restricted ElevenLabs key for each laptop you manage,
named for example `hydrasynth-laptop-01` through `hydrasynth-laptop-06`. This
lets you revoke one laptop's key without updating the others. Keys can have
endpoint permissions and credit limits; usage still belongs to the same
workspace quota. See [ElevenLabs key administration](https://elevenlabs.io/docs/overview/administration/workspaces/api-keys).
Enable only the features you use: music generation/stem separation,
text-to-speech, voice changing and voice listing as applicable. Test account
access after provisioning; setup never makes a paid provider request.

Paste each key at the hidden setup prompt, or provision a `.env` file from
your password manager or a USB drive you control. For example, a separate
file `laptop-01.env` contains `ELEVENLABS_API_KEY=the-key-for-that-laptop`:

```sh
# From the cloned repository, using your actual USB path:
install -m 600 /media/USB/laptop-01.env .env
```

The file-copy method replaces `.env`; use the prompt to preserve other
existing settings. Never commit a real key, including to a private repository.
`.env` is ignored; `.env.example` is a blank template. Keys load at dashboard
startup, and a process environment variable takes precedence over `.env`.

A locally stored key is readable by someone who controls that laptop/account;
file permissions do not hide it from that person. For other people's own
computers, use their own account/workspace key, or a central authenticated
generation service if they should not possess the provider key. This project
currently calls ElevenLabs directly from its local Python backend; it does
not include that central service.

For faster provisioning, download Whisper once and copy only
`var/whisper/small/` to the same location in each new clone before setup.
The current model is approximately 464 MiB. Setup reuses a complete model and
checks that it loads locally. Recreate `.venv` and native binaries on each
machine; do not copy them from another laptop. Allow a few GB for dependencies,
download caches and generated audio.

Each laptop should create its own study directory and identity. Do not copy
`var/` wholesale or copy another laptop's study database. New installs use
`~/.local/share/keirzo/study-data` by default (or `$XDG_DATA_HOME`); an explicit
`--study-dir` overrides this. Keep the existing location when updating; no
storage override is needed for the default. Transfer robot calibration only for the
same physical robot. Browser microphone/MIDI permission is still a first-use
step on each laptop.

Follow [Update an existing installation](#update-an-existing-installation) on
each laptop to receive new versions. Repository changes must be committed and
pushed before another computer can receive them via clone/pull.

## Update an existing installation

Stop playback, let pending study records finish saving, and stop the dashboard
with **Ctrl+C** in its terminal. Open a terminal in the existing project folder:

```sh
git pull --ff-only && bash tools/setup.sh
```

The setup script installs any newly required system packages, updates the Python
runtime packages and rebuilds the native tools. It reuses `.venv` and the existing
Whisper model, verifies the model can load, and keeps the saved API key. Recordings,
generated audio, robot calibration, browser settings and study data are retained.
There is no need to clone again, delete `.venv`, or download Whisper again. If an
older installation has no model, setup downloads it automatically.

The `&&` runs setup only if the pull succeeds. If Git reports local source changes
or divergent history, preserve those changes and resolve the reported problem
before retrying; do not force-reset the laptop. If setup fails, correct the reported
problem and rerun it. Do not restart for a session until setup succeeds.

Start the dashboard again, using the same launch options as before, and refresh
the browser. For the usual browser-audio setup:

```sh
make dashboard-sonify
```

If you normally use `make dashboard` for a connected synth or pass a custom
`--study-dir`, recordings directory or port, retain those settings when restarting.
Updates require internet access. The script leaves running dashboards alone,
so stopping the server before updating is a manual step.

## Run without hardware

```sh
make dashboard-sonify
```

Open <http://127.0.0.1:8790/#synth-mixer>. Browser audio, the three bundled
recordings, simulated signals and bundled voice demos do not require a synth,
robot or provider key. Stop an existing dashboard before starting another
against the same storage directories. Ctrl+C stops a foreground dashboard.

Setup already prepares microphone transcription. If you deliberately used
`--skip-model`, download the deferred model with:

```sh
.venv/bin/python tools/prepare_rap_transcription.py
```

New music and rap generation additionally need `ELEVENLABS_API_KEY` in the
local ignored `.env` file, followed by a dashboard restart. Generation consumes
provider credits. Microphone permission is separate from installing the model.

## Native MIDI

After connecting the Hydrasynth:

```sh
./build/hydractl list
make dashboard
```

This runs the native `hydractl serve` process, input monitoring and the local
command broker. Use `DASHBOARD_ARGS='--device "unique device name" ...'` when
the default Hydrasynth selection needs disambiguation. The controller accepts
a unique name or an explicit ALSA `client:port` address. Numeric ALSA addresses
can change after reconnecting or rebooting; prefer a unique device name for
saved launch commands. Ambiguous selections fail rather than silently choosing
a different instrument.

Keep the synth MIDI RX channel consistent with `--channel` (default 1), set
`PARAM RX` to NRPN for dashboard catalog mappings, and set `PARAM TX` to the
format you want to monitor. Named native timbre commands send CC and need
`PARAM RX=CC`. USB MIDI does not carry the Hydrasynth's audio; connect its
analogue output to headphones, speakers or an audio interface separately.

The server does not silently switch to another device after a disconnect.
Stop/restart it after reconnecting the intended synth. On Linux the dashboard's
Hydrasynth output uses the native MIDI service, including in `dashboard-sonify`;
it does not request browser MIDI permission. The macOS browser MIDI route remains
available with its saved connection settings.

## If the browser freezes or turns white

After updating, restart the dashboard terminal process and refresh the browser.
Keep that process running, including when using `make dashboard-sonify` with
**MIDI device** selected. Hydrasynth playback needs the updated backend's native
MIDI watchdog; refreshing the page alone does not update an older server.

A locally inspected Chrome crash dump identified a fatal dangling-pointer check
inside Chrome's native MIDI callback on Linux. Linux Hydrasynth playback now
bypasses Web MIDI entirely: the dashboard submits each note and its duration to
`hydractl`, whose scheduler sends the note-off independently of JavaScript.
Refresh any old dashboard tabs after restarting the server to load this route.

The browser also checks in with the backend every 500 ms during playback. After
2.5 seconds without a check-in, the backend cancels native scheduled notes and
releases them. If that transport fails, a separate ALSA command sends sustain-off,
explicit note-offs for all 128 pitches, and all-notes-off to the selected synth
and channel. CC120 is deliberately excluded: the Hydrasynth uses it for ARP Octave.
This protection requires the backend and MIDI connection to remain available;
the patch's release envelope may still produce a tail. Reload after a freeze and
press Play to restart. The macOS Web MIDI route retains its timestamped note-offs
and may require a short handover wait after replacing a dashboard tab.

Small browser health counters and MIDI stop outcomes are saved in
`var/diagnostics/browser-health.jsonl`, with one rotated backup and a combined
limit of approximately 1 MiB. This is separate from study recording and does not
capture input values, audio, or error-message text.

Study recording is disabled by default while diagnosing the remaining crashes.
Restart the dashboard, then refresh the page to apply this to the browser as well
as the backend. Disabled mode does not open the study outbox, capture events or
clips, or retry pending uploads. Existing study data and queued browser records
are retained; the default study directory is unchanged. The MIDI watchdog remains
enabled. `--no-study-recording` is also accepted for an explicit disabled launch.

To resume study capture and automatic backups later, use
`make dashboard-sonify DASHBOARD_ARGS='--study-recording'`. Enabled capture saves
every raw frame in batches; it does not sample or discard input. Disabling
recording isolates one source of load; it does not establish that every possible
Chrome crash has been eliminated.

## Audio routing

```sh
./build/hydra-audio list --json
./build/hydra-audio meter --device 'Revolution 2x2' --channel 1 --duration 2 --json
```

Use an exact ALSA UID from the list to disambiguate devices:

```sh
./build/hydra-audio meter --uid 'hw:CARD=USB,DEV=0' --channel 1 --duration 2 --json
```

Replace that example UID with the actual interface. Card-name UIDs are more
stable than numeric card indices. `--uid default` or an explicitly configured
PipeWire/PulseAudio ALSA PCM can route capture through the desktop sound server.
Direct `hw:` capture may be busy if another application owns the device; close
that capture client or select a shared PCM route. No system audio-server change
is required by this project.

Named desktop/custom PCM routes are listed without opening their backends.
Their channel count and nominal sample rate are `0` (unknown) until you select
one for metering; this avoids starting an audio server merely to list devices.

The meter negotiates input format/rate, measures only the requested one-based
channel, and returns the existing RMS, peak, clipping and timing fields. It
does not save captured audio or implement native playback/synthesis. The
dashboard's browser sound engine remains responsible for playback.

## Device checks

`aconnect -l` lists ALSA sequencer clients; `arecord -l` lists audio capture
hardware. `hydractl list` needs access to `/dev/snd/seq`. Use an ordinary logged-in
desktop account with device access; an isolated container may need explicit
sound-device access. A missing sequencer device or permission error is reported
without pretending an empty list is a successful connection.

Robot serial identification and control use the existing `pyserial` and
`dynamixel-sdk` dependencies. On Ubuntu, serial devices normally require
`dialout` membership. If an actual device reports permission denied, check
group membership and device permissions, then log out/in after any group change.
Do not run the dashboard as root. This setup's account already belongs to
`dialout`; no extra permission changes were needed.

Copy the same robot's `var/robot/head-calibration.json` from its previous
computer or perform manual calibration before powered head movement. See
[robot setup](robot_control.md). Nothing connects motors or enables torque
merely by starting the dashboard.

## Tests and physical checks

```sh
make native-test
make test
```

`native-test` runs both C self-tests and, on Linux, the ALSA integration tests.
Those tests create isolated virtual MIDI peers and synthetic audio; they do
not select physical instruments or microphones. Tests needing ALSA sequencer
access report a skip if it is unavailable. `make test` also runs the full
Python/JavaScript dashboard suite and needs permission to create local sockets.

After connecting hardware, complete the [hardware acceptance checklist](hardware_acceptance.md):
MIDI send/read-back, CC/NRPN reception, note-off/panic, scheduling and disconnect
behavior, plus audio channel selection, rates, levels and device recovery.
Robot calibration, emergency stop and physical stroke limits also require the
actual rig. A successful virtual test cannot establish these physical results.
