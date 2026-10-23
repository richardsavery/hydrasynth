# Mac setup

The app uses the Mac's native CoreMIDI and Core Audio APIs. The automated
installer supports Apple Silicon and Intel Macs. Use a current macOS release:
Homebrew's support and available binary packages depend on the OS and processor.
Older Intel systems may take longer to install or need additional maintenance.
See [Homebrew's requirements](https://docs.brew.sh/Installation).

## Install

If Apple's Command Line Tools are not already installed, run:

```sh
xcode-select --install
```

Finish Apple's installation window before continuing. These tools provide Git,
the C compiler and Make. Then:

```sh
git clone https://github.com/richardsavery/hydrasynth.git
cd hydrasynth
bash tools/setup.sh
```

Run as your normal user. Setup requests administrator access only when the
Homebrew installer needs it. It:

1. Checks Apple's Command Line Tools. If missing, it opens their installer and
   asks you to rerun setup after finishing that window.
2. Finds Homebrew, including its standard Apple Silicon and Intel locations, or
   installs it using [Homebrew's official installer](https://brew.sh/).
3. Installs missing FFmpeg and Homebrew Python 3.12 packages.
4. Creates or reuses `.venv`, and installs or updates the app's Python dependencies.
5. Builds and self-tests the native MIDI and audio tools.
6. Downloads Whisper Small when missing and checks that it loads locally on the CPU.
7. Offers the hidden API-key prompt if no key is already configured.

Existing virtual environments keep their own Python. `PYTHON=/path/to/python3`
selects another Python 3.10+ for a new environment; Python 3.12 is the default
to avoid gaps in the available speech-processing packages. A broken existing
environment is reported and left intact.

Setup keeps your key, recordings, model, calibration and study data. It installs
missing Homebrew packages without upgrading unrelated packages or changing your
shell startup files. Local FFmpeg links in `var/bin` let the app find its audio
tools even when Homebrew is not in a later terminal's `PATH`.

Whisper transcription runs locally after the download. New music and rap
generation require an ElevenLabs key, internet access and provider credits.
The installer does not make paid generation requests or operate connected hardware.

## Start and stop

From the project folder:

```sh
make dashboard-sonify
```

Open <http://127.0.0.1:8790/#synth-mixer>. Leave the terminal open while using the
app. Choose **Connections → Browser audio → Test sound** to check playback.
Stop playback before pressing **Ctrl+C** in the server terminal.

Use the same browser and address to retain your saved settings. Grant microphone
permission when recording. If macOS also asks for microphone access, allow the
browser or audio-capture application you intend to use in System Settings.
Use Chrome or another browser with Web MIDI support for browser MIDI controls.

## Update an existing installation

Stop playback and the dashboard first. In the existing project folder:

```sh
git pull --ff-only && bash tools/setup.sh
```

Setup updates Python dependencies within the supported versions and rebuilds
native tools. It reuses and checks the downloaded Whisper model, and keeps the
saved API key and local data. No new clone is needed. If Git or setup reports
an error, resolve that error before restarting.

Once setup succeeds:

```sh
make dashboard-sonify
```

Refresh the browser. If your usual launch includes a custom port, recordings
directory or `--study-dir`, keep those options. For a connected native Hydrasynth,
use your usual `make dashboard` command instead.

## Connected hardware

To list MIDI devices and start the native synth service:

```sh
./build/hydractl list
make dashboard
```

Power on and connect the Hydrasynth before starting the native service. The
browser's MIDI connection still requires its own permission. For browser parameter
mappings, set the synth's `PARAM RX` to `NRPN`. USB MIDI does not carry the synth's
audio: connect its analogue outputs to headphones, speakers or an audio interface.

List audio inputs with:

```sh
./build/hydra-audio list --json
```

Select the actual device and channel before running a meter. macOS may require
microphone permission for the terminal or application doing native capture.

Keirzo uses the existing serial device discovery and saved robot configuration.
Follow the [robot setup guide](robot_control.md). Transfer head calibration only
for the same physical robot; a different robot needs its own calibration.
Complete the [hardware checks](hardware_acceptance.md) on the actual connected rig.

Each Mac creates its own study identity. The default study location is
`~/Library/Application Support/Keirzo/study-data`; retain a custom `--study-dir`
if one was already supplied. Do not copy another laptop's study database.

## If the browser freezes or turns white

Restart the dashboard after updating, then refresh the browser. Keep the backend
running even when using browser MIDI through `make dashboard-sonify`: Hydrasynth
playback needs its native MIDI watchdog. Refreshing alone leaves an older backend
unchanged.

Notes queue their timestamped MIDI note-offs when they start. During playback,
the browser also checks in every 500 ms. After 2.5 seconds without a check-in,
the backend uses CoreMIDI to release sustain and stop notes on the selected
Hydrasynth and channel, independently of the page's JavaScript. The backend and
MIDI connection must remain available. Reload after a freeze and press Play to
restart playback.
After a reload or starting playback in another dashboard tab, you may be asked
to wait up to eight seconds for the previous page's queued note-offs to finish.
Wait for the stated time, then press Play again. Stop/Play in the same page does
not require this handover wait.

Study capture batches writes and bounds upload passes to keep continuous input
from building a browser-memory backlog. It retains every raw frame without
sampling, and preserves existing recordings and the default study location.
These changes address recording backlog and hanging notes, without guaranteeing
that Chrome cannot crash for another reason.

## Advanced setup

The Mac-specific entry point is `bash tools/setup_macos.sh`. The common
`bash tools/setup.sh` command selects it automatically.

```sh
bash tools/setup.sh --skip-system  # existing compiler, Python and FFmpeg
bash tools/setup.sh --skip-model   # deliberately defer Whisper's model
bash tools/setup.sh --no-key       # configure the key separately
.venv/bin/python tools/configure_api_key.py
```

Default setup includes Whisper. To finish a deferred download, rerun normal
setup or use `.venv/bin/python tools/prepare_rap_transcription.py`.

Node.js is needed for development tests, not for running the app. The manual
GitHub Actions compatibility check builds and tests Linux, Apple Silicon Mac
and Intel Mac software without selecting physical devices.

Windows needs separate native backends and changes to Unix file locking and
local service handling. It is outside this installer’s supported platforms.
