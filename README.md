# Hydrasynth control

A command-line controller for an ASM Hydrasynth over USB MIDI, with native
macOS CoreMIDI and Linux ALSA backends. The audio input meter uses Core Audio
on macOS and ALSA PCM on Linux. The browser dashboard runs on either platform.

## Guides

- **Using an already prepared laptop:** start with the illustrated [user guide (PDF)](docs/user-guide.pdf)
  or [offline HTML user guide](docs/user-guide.html). It covers everyday use,
  a first-sound walkthrough, saving settings and common problems.
- **Preparing or maintaining the laptops:** use the full [instruction manual (PDF)](docs/instruction-manual.pdf)
  or [offline HTML manual](docs/instruction-manual.html), including installation,
  credentials, hardware calibration and study administration.

Download either HTML file and open it locally; its screenshots are embedded.

## Quick start on Linux

The browser dashboard works without the robot or Hydrasynth connected. It
includes three movement recordings, simulated signals, browser sound and six
saved voice demos. These features need no API key. New music and rap generation
require an ElevenLabs key and use provider credits.

On Ubuntu/Debian, install Git if needed, then clone and set up the project:

```sh
sudo apt-get install git
git clone https://github.com/richardsavery/hydrasynth.git
cd hydrasynth
bash tools/setup_linux.sh
make dashboard-sonify
```

Run setup as your normal user. It requests sudo only for missing system
packages, creates `.venv`, installs Python dependencies, builds and self-tests
native Linux MIDI/audio, downloads and checks Whisper Small, and offers a
**hidden API-key prompt**. Paste the key for this laptop or press Enter to skip.
Setup preserves existing keys and local data; it sends no physical robot/MIDI
commands and makes no paid provider request. Node.js is needed for the test
suite, not to run the dashboard.

Open <http://127.0.0.1:8790/#synth-mixer> and leave the terminal running:

1. Open **Setup → Connections**, choose **Browser audio**, and press **Test sound**.
2. Open **Use → Synth mixer**, set **Signals from → Simulated demo signals**, then
   choose **Movement** for Mix A, and assign **Mix A** to **Filter cutoff → Signal mix**.
   Press **Play** to hear the mapping, then **Stop** to finish.
3. To use recorded movement, select a bundled recording in Connections and set
   the mixer's signals source to **Connections input**.
4. Open **Rap response → Voice demos** to hear saved examples without generating
   anything. Later, use **Sessions** to save/export your mixer settings.

Stop playback, wait for pending study records to save, then press **Ctrl+C** in
the server terminal to shut down. On a later day, run `make dashboard-sonify`
from the same checkout. Installation does not add a background or login service.
When the synth is connected and you want native MIDI monitoring, use
`make dashboard`; see the [Linux device checks](docs/linux.md#native-midi).

For a quicker install that defers transcription and credentials:

```sh
bash tools/setup_linux.sh --skip-model --no-key
```

Prepare the deferred model or configure/rotate a key later:

```sh
.venv/bin/python tools/prepare_rap_transcription.py
.venv/bin/python tools/configure_api_key.py
.venv/bin/python tools/configure_api_key.py --replace
```

The helper saves the key in Git-ignored `.env` with owner-only permissions
(`600`). Restart the dashboard after changing it. A process environment variable
takes precedence over `.env`. Never commit a real key, even to a private repo.

## Install on six laptops

For laptops you manage, provision a separate restricted key per laptop through
a password manager or controlled USB file, then paste it at the hidden prompt.
Name them `hydrasynth-laptop-01` through `hydrasynth-laptop-06` so one can be
revoked independently. Configure endpoint permissions and credit limits in
[ElevenLabs key administration](https://elevenlabs.io/docs/overview/administration/workspaces/api-keys).
All keys still use the workspace quota. Anyone controlling a laptop account can
read a key stored there; for other people's own machines use their own credentials
or a central authenticated generation service (not included in this project).

Download Whisper once and copy **only `var/whisper/small/`** into each clone
before setup to save roughly 464 MiB of downloads per additional laptop. Setup
checks the copied model. Create `.venv` and native binaries on each machine.
Do not copy `var/` or study databases wholesale: each laptop needs its own study
identity. Copy robot calibration only for the same physical robot.

Study recording and incremental backups are automatic. Linux defaults to
`~/.local/share/keirzo/study-data` (or `$XDG_DATA_HOME/keirzo/study-data`); an explicit `--study-dir`
overrides it. Open <http://127.0.0.1:8790/?researcher=1> for recording health,
participant handovers and exports. At collection time retain **every ZIP** in
each laptop's `backups` tree; the latest incremental ZIP is not a full snapshot.
Sessions settings exports and study-data exports serve different purposes.

To update: stop the dashboard, review `git status --short`, run
`git pull --ff-only`, rerun `bash tools/setup_linux.sh`, then start it again.
The repository owner must commit and push changes before other laptops can
receive them through clone/pull.

The illustrated instruction manual is available as a [printable PDF](docs/instruction-manual.pdf)
and a [self-contained HTML file](docs/instruction-manual.html). Download the HTML
file and open it locally; GitHub displays its source rather than the rendered page.
Both include a quick start, detailed workspace walkthroughs, screenshots, hardware
procedures, study collection and troubleshooting. See
[Linux setup](docs/linux.md) for installation and device details. macOS uses the
existing manual setup and CoreMIDI/Core Audio backends; the automated installer
is for Ubuntu/Debian.

To rebuild the prepared-laptop guide from `docs/user-guide-content.json` and
`docs/manual-assets`, run `.venv/bin/python tools/build_manual.py --audience user`.
Omit `--audience user` to rebuild the full operator manual. PDF authoring needs
`requirements-manual.txt` and DejaVu fonts; `--html-only` uses standard Python.

## Interactive sonification dashboard

The dashboard can turn RAPP newline-delimited JSON into music without requiring
the Hydrasynth to be connected. Portable gzip-compressed copies of the three
current recordings are included in [`recordings/`](recordings/), so a fresh
clone is ready to use on macOS or Linux without the RAPP repository beside it. The
dashboard reads the compressed files directly, discovers their channels and
numeric fields, and reduces large tensors to a bounded series before they reach
the browser.

Open **Keirzo control** and press **Start robot** to enable drum-arm torque and
move all four arms to rest, connect the selected LED effects, and enable torque
for selected rib/head movement. Drum hits still require **Start drumming**.
Choose **Follow → Music mixer** or **Synth mixer** for lights, ribs, head beat sync,
and drums. The head can also move at its own pace with Beat sync off.
**Keirzo setup** is available for calibration, manual tests, and connection
troubleshooting. The older movement-driven drum
groove remains available through its [direct link](http://127.0.0.1:8790/#drums)
and saved sessions; it is no longer in the top navigation.

Clone the repository and run:

```sh
cd hydrasynth
make dashboard-sonify
```

For Keirzo's motors, install the serial dependencies once before starting:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-robot.txt
make dashboard-sonify
```

The head, ribs, and drum adapters are recognised by their USB identities in
[`config/robot-devices.json`](config/robot-devices.json), so their default ports
follow the same devices across USB sockets and computers. Discovery selects
ports without connecting motors or starting movement. When moving this setup
to another computer with the same robot, also copy `var/robot/head-calibration.json` from the original
machine: saved head ranges are local files and are not included in a Git clone.
Use a browser with Web MIDI support and grant its MIDI permission for the
Pimoroni LEDs. See [moving Keirzo to another computer](docs/robot_control.md#move-this-setup-to-another-computer)
for the full setup and checks.

The top navigation groups **Connections** and **Keirzo setup** under **Setup**.
**Use** contains **Synth mixer**, **Music mixer**, **Rap response**, and
**Keirzo control**. The same service provides these workspaces:

- **Connections** at <http://127.0.0.1:8790/> for choosing a recording or live
  stream, testing browser audio, and connecting a MIDI device.
- **Synth mixer** at <http://127.0.0.1:8790/#synth-mixer> for shaping browser audio
  or Hydrasynth MIDI parameters with named signal mixes. `#synth` opens this view too.
- **Music mixer** at <http://127.0.0.1:8790/#mixer> for creating tracks and
  mixing their stems with combined input signals, faders, and effect mappings.
- **Rap response** at <http://127.0.0.1:8790/#rap-response> for recording a
  message and hearing a rhyming reply over the playing music or its own hip-hop beat.
- **Keirzo setup** at <http://127.0.0.1:8790/#robot-setup> for testing the
  rib cage and drumming arms directly over separate USB serial connections,
  using the Max patch ranges, plus LED tests over USB MIDI. The two-axis head
  has a separate read-only connection check, upright-position reference and
  range recorder for moving each axis by hand. Saved ranges persist across
  restarts and bound the powered controls in Keirzo control.
  Drum tests raise to rest, hit down, and return to raised rest; manual
  positions are in Advanced. Motor output is available by default with separate
  torque controls and a latched emergency stop.
- **Keirzo control** at <http://127.0.0.1:8790/#robot-control> for live LED palettes
  and optional rib breathing synced to the selected mixer's tempo. The head panel
  has **Enabled**, **Beat sync**, and **Busy-ness** controls. Both calibrated axes
  move together, with staggered turnarounds for continuous movement. Busy-ness 0
  keeps a calm flow; higher values explore more of the saved range. Auto gently
  varies activity independently of the audio. Turn Beat sync off for movement
  at its own pace, even when music is stopped. **Release head** remains in Keirzo setup.
  **Start robot** connects the required hardware and enables selected motor torque;
  preliminary setup is only needed if a connection or calibration needs attention.
  **Automatic drumming** follows Music mixer timing or the previous Synth mixer bar's
  note accents. Choose the arms and groove, then press **Start drumming** in its
  panel. It uses the original drum stroke timings, skips hits that exceed arm
  recovery, and limits each drum to one hit per second. An out-of-range healthy
  arm returns to rest before rejoining; a fault pauses only the affected arm.
  Upcoming hits are cancelled when the source stops. The top **Stop**
  ends both drumming and the other robot effects.
  See [setup and controls](docs/robot_control.md).
- **Observer** at <http://127.0.0.1:8790/observer/> for the original live
  Hydrasynth telemetry view.

Start in **Connections**, then open a sonification tab. All playback, sound,
mapping, and connection controls are available in one interface. Local expandable
sections keep optional settings together. Switching dashboard tabs
keeps playback, robot control, and connections running; use each workspace's
Stop control to stop it. Synth remembers its browser/MIDI output choice
independently; Music mixer uses browser audio. Loading a preset does not
change that connection choice.

Observer is available in the top bar. Observer's **Auto** source follows Signal Lab whenever its
preview is playing, then falls back to native/demo telemetry after the preview
stops. Choose **Signal Lab** in Observer to keep that view locked to the
sonification feed. This works for browser audio as well as MIDI output and does
not depend on the Hydrasynth echoing its controls back to the computer.

This preview-only path needs Python 3 but does not build the native MIDI
controller. When a larger or newer external dataset is preferred, pass
`RECORDINGS_DIR=/path/to/recordings` or set `RAPP_RECORDINGS_DIR`; an explicit
folder takes priority over the bundled copies.

The previous Synth interface is available through **Previous version**
in Synth mixer, or directly at <http://127.0.0.1:8790/#synth-legacy>. It retains its
existing presets and lets you:

- keep up to 12 named mapping tabs for each recording, with separate voice,
  scale, tempo and rhythm settings; audition one tab at a time;
- save named presets, open them in new tabs, and export/import a JSON preset
  library;
- generate small musical sets or 64, 128, 256 and larger Hydrasynth parameter sets
  in a new tab, with Balanced, Rhythmic or Wild character;
- choose a recording or connect directly to the live RAPP WebSocket stream;
- use direct joint position/velocity values or reduce tensor fields by mean,
  RMS energy, minimum, maximum, or one flattened index;
- combine up to six robot fields in one mapping using average, weighted average,
  sum, difference, minimum, or maximum before shaping the output;
- map signals to pitch, velocity, tempo, rhythmic hit density, pattern rotation,
  note repeats, swing, accents, gate length, note probability, Hydrasynth
  filter/effect controls, any of the eight macros, chord voices/inversion/spread,
  or sound palette position;
- adjust input curves, output ranges, tempo, rhythmic resolution, scale, and
  preview voice; and
- audition the result through browser audio now, then choose a Web MIDI output
  and send notes plus catalog-based CC/NRPN mappings to the Hydrasynth later.

For MIDI output, connect and power on the synth, set `PARAM RX` to `NRPN`
(the dashboard’s default format), and grant browser MIDI access when prompted.
The dashboard requests MIDI access on startup and automatically selects the
saved device or a single Hydrasynth. It reconnects when that device returns,
including a changed port ID when its name and manufacturer identify one output.
If several devices match, choose the intended output in **Connections**.
A new setup uses Hydrasynth for Synth output when found; an existing **Browser
audio** choice or another selected MIDI device is preserved. Connecting never
starts playback or changes patches. After a disconnection, press Play again.
Use **Connect MIDI device** to retry if browser permission was declined.
The dashboard sends on MIDI channel 1 and provides a dedicated all-notes-off
control. Mapping tabs save automatically in browser storage for each recording.
Existing saved mappings migrate to an **Original** tab, including their sound
settings. Browser storage is specific to the browser and page origin; use
**Export** to move saved presets to another browser or machine.

### Synth mixer

Choose a sound, tempo, and scale at the top, then build named **Signal mixes**
using the same input controls as Music mixer. Each mix can combine up to six
inputs, with automatic or fixed ranges. Use Connections input for recordings
and live data, or Simulated demo signals to try the controls.

In the **Parameter desk**, each card controls a synth destination. Set its value
manually or choose a named signal mix, then set the output range and direction.
Reuse one mix for several parameters. **+ Parameter** offers notes, rhythm,
filters, effects, and the full published Hydrasynth catalog. Search by name or
group. Hardware controls are marked **MIDI only**;
unsupported entries show the reason they cannot be sent. Enum parameters offer
named choices. Hardware mappings remain saved while using browser audio.

Effect mappings use pronounced sweeps by default. Synth filter, resonance,
drive, delay and reverb cover their full control range; the initial resonance
and reverb are stronger. Music uses full pan and volume sweeps, a 6 kHz
high-pass sweep, and delay/reverb mixes up to 85%. Both players have longer
reverb tails and stronger delay repeats. Existing ranges that exactly match
the previous defaults upgrade once; custom ranges remain adjustable.

Playback uses the existing browser synth or the MIDI output selected in
Connections. Missing data in an enabled mapping pauses sound until fresh values
return. **Stop** silences notes and stops parameter updates. Switching dashboard
workspaces keeps playback running, so use Stop deliberately.
Settings save separately under `hydra.synth-mixer.v1`; the original Synth's
mapping sets and sound controls stay independent.

### Rap response

Open **Rap response** to record or type a message and generate a rhyming answer.
Recording is limited to 30 seconds. Choose **Rap my words** to perform supplied
text instead: this skips reply writing and sends your words directly as the rap
lyrics. Four bars support up to 48 words; eight bars support up to 96 words.
Line breaks are preserved. Choose Boom bap, Trap or Lo-fi and a requested tempo
between 70 and 140 BPM.

The six voice choices are **Eva**, **Cold Android**, **Peter**, **Elowen**,
**Maisie**, and **Warren**, using the same fixed voice identities as the approved
six-voice audition. Each generated rap is separated into vocal and instrumental
stems, then the vocal is converted with ElevenLabs Voice Changer. The selected
identity is fixed; delivery and expression can vary between performances.
Saved recordings keep their original voice and settings.

The collapsible **Voice demos** box at the bottom of Rap response contains all
six saved audition recordings. It starts closed; opening it lets you listen
without generating anything or using API credits. Closing it stops the preview.
The demos are bundled with the
dashboard for use on each laptop, including when generation is unavailable.
Previews play one at a time and leave the chosen voice unchanged. They use the
original clean audio; pitch and autotune settings apply to generated raps.
Demo listening actions are included in the study records.

Voice customization includes **pitch shift** (−12 to +12 semitones) and
**autotune amount**, key, scale, melody, octave and note speed. Clean vocals are
the default. Autotune can follow the voice or use a repeating melody. These
local effects process only the vocal and preserve its duration; pitch shift
transposes the tuned vocal, while the instrumental keeps its timing and pitch.
**Apply to this rap** makes a new version
of a completed rap using its retained clean vocal, without another provider
request. It keeps that recording's voice and words. Choose a voice and generate
a new rap to change the voice identity.

The default **Over main music** mode keeps the Music mixer or Synth mixer
playing and starts the isolated vocal on the next bar. Start the backing in its
mixer first, then switch to Rap response. Its tempo is used for new raps when it
is within the supported range. Use headphones when recording with music playing
to keep the backing out of the microphone. **With generated beat** plays the
processed vocal mixed with its generated instrumental and stops other dashboard
audio. Both the full mix and vocal can be downloaded.

The backend transcribes recordings locally with **Whisper Small** through
`faster-whisper` using CPU int8 inference. Original microphone audio is not sent
to ElevenLabs. Reply mode sends the transcript to a Music composition plan to
write a rhyming answer; **Rap my words** skips this step. ElevenMusic performs
the lyrics and backing using the audition's Deep Hip-Hop finetune on `music_v2`.
Two-stem separation extracts the vocal, and Voice
Changer applies the selected voice using `eleven_multilingual_sts_v2` at 24 kHz.
The fixed conversion settings match the audition: stability 0.5, similarity
0.85, style 0, speaker boost enabled and seed 1729. Seeded conversion is
best-effort, not a guarantee of identical audio. Existing saved finetune jobs
remain playable and recoverable with their original settings.

These services use the existing `ELEVENLABS_API_KEY`; no separate LLM account
or ElevenAgent setup is needed. New raps use provider credits for music, stem
separation and voice conversion, plus lyric planning in reply mode. Local
transcription, local effects and replaying saved raps use no API credits.
FFmpeg and ffprobe validate and prepare the audio. NumPy supplies local pitch
correction. Install the dependencies and download Whisper Small once:

```sh
.venv/bin/python -m pip install -r requirements-rap-response.txt
.venv/bin/python tools/prepare_rap_transcription.py
```

The model is stored in `var/whisper/small` and loaded on the first recording,
then reused. Transcription runs offline after setup. Typed input remains
available if the local transcription model is missing.

Music generation interprets supplied lyrics and requested BPM; next-bar
playback follows the mixer's clock, but the generated performance can drift
against the backing. Changing or stopping the backing stops the vocal. An
isolated vocal waits for backing music before playing. A failed voice
conversion never silently substitutes the music model's original voice.

**Play when my new response is ready** applies only to a request you just made.
Opening a saved rap or restoring a session never records, generates or plays on
its own. Leaving the tab releases the microphone, stops the vocal and cancels
pending auto-play; an already submitted job can finish in the background.
Cancel stops remaining steps, but an API request already in flight may still
use credits. Interrupted requests are recoverable by request ID and are never
automatically repeated.

Recordings and generated versions are stored under `var/rap-response`. Study
records include input mode, selected voice, effects, supplied text, generated
lyrics, playback actions and the source relationship for each effects version.
Automatic study backups collect their audio assets. Browser settings and saved
sessions retain preferences and job references without embedding microphone
audio. The API key remains on the backend.

All participant rap controls now live in **Rap response**; the Voice experiments
entry has been removed. Historical experiments and their saved audio remain on
disk and old direct bookmarks remain compatible. The Synth and Music mixers
contain their instrumental controls; start a backing there, then open Rap
response to record or type.

### Shared signal mixes

In either mixer, **Share mix** adds a signal mix to the shared library. In the
other mixer, choose it under **Shared signal mixes** and press **Add shared mix**.
Input, combination and fixed-range edits follow the shared definition when
switching mixers; each mix keeps its local mappings to synth parameters or stems.
**Make independent** keeps a local copy that can be changed separately.
Connections inputs and simulated signals are listed separately and require the
matching **Signals from** mode. Automatically learned ranges stay local.

Both mixers provide **Signal strength** for each mapping. At **0%**, the manual
base setting stays unchanged; **100%** applies the full mapped range. Values
between them reduce the signal's influence, independently for each parameter or
channel effect. Frequency controls blend logarithmically. Strength settings save
with the mixer and sessions; existing mappings start at 100%. A mapping at 0%
does not wait for its input to arrive.

### Saved sessions

Open **Sessions** in the header and use **Save new version** to name a snapshot
of both mixers, their mappings and sound controls, shared signal definitions,
music prompt and selected track, connection preferences, Drums, and previous
interface settings. **Load** restores the selected version; **Update selected**
replaces that version. Versions can also be renamed or deleted.

Sessions save in this browser. **Export selected**, **Export all**, and **Import**
provide portable JSON copies. Audio files and recordings are referenced by ID,
so they must still exist on the dashboard server. Loading stops playback and
does not generate music or reconnect live movement input. The page reloads, so
normal browser MIDI discovery and permission handling may run. Use Connect live
or Connect MIDI device when needed, then Play to resume.
Running generation jobs are separate from saved sessions.

### Academic study recording

The dashboard records study data and creates local backup bundles automatically.
The normal participant view has no Study controls or save/export steps.
For researcher controls, open <http://127.0.0.1:8790/?researcher=1>.
The **Study** panel shows recording health, backup status and folder, the laptop's
installation ID, and the current session. The query option changes visibility;
it is not an authentication mechanism.

Participant codes are optional. In the same browser tab participants use, a
researcher can open `?researcher=1`, choose **New participant** at each handover,
then remove the query option to return to the participant view. A separate
researcher tab has its own session and cannot mark a handover in another tab.
Without that handover marker, the
app logs a continuous session and cannot infer that a different person has
started using it. A page reload retains that tab's session and starts a new
client run. Activity without a participant code is still recorded.
These study sessions are separate from the **Sessions** settings library.

The recorder saves:

- Interface clicks, input and selection changes, intermediate slider values,
  relevant keyboard shortcuts, navigation, focus, and periodic settings snapshots.
- Complete mapping configurations after accepted edits, including rapid add/remove
  actions, shared signal relationships, and edits made during playback. Control
  events identify their mapping/bus/channel context; clicks include page position,
  scroll offsets, and viewport size. Opening and closing disclosure panels is recorded.
- Original microphone clips, including canceled attempts, the WAV submitted for
  local transcription, transcripts, rap lyrics, generation settings, voice/model
  identifiers, timing, errors, and references to generated audio.
- Rap playback scheduling, starts, ends and stops; mixer transport and patch
  changes; emitted notes and parameter values; robot commands and outcomes.
- Validated numeric data from incoming live movement frames, with chunk offsets
  for reconstructing large arrays; browser errors and backend job transitions.

Events have a unique event ID, laptop ID, session/client IDs, UTC timestamps,
elapsed time, sequence number, application revision, and structured payload.
Backend hardware events without a known participant remain explicitly unassigned;
they can be aligned by laptop and timestamp. The recorder describes commanded
and scheduled output; it does not verify acoustic playback through the speakers
or the robot's physical contact. It does not add continuous ambient microphone,
screen, or camera recording. Microphone recording retains the existing explicit
record-button workflow, including its echo cancellation and noise suppression.
An abrupt browser/process termination can lose an unfinished microphone clip
and events that had not yet reached persistent storage.

For mapping analysis, `mapping.configuration` stores each full accepted state with
a `revision_id` and `previous_revision_id`. `mapping.playback` links revisions to
transport start, changes while running, and stop; synth/music output events also
carry `mapping_revision_id`. These events distinguish configuring a mapping from
using it during playback. Invalid choices remain in raw UI events without becoming
accepted mapping revisions. Revision IDs identify occurrences, not unique content:
compare the stored configurations to define distinct trials during analysis.
Automatic range calibration does not create a new revision by itself. The
`configured-values-v1` comparison ignores `learnedMin`, `learnedMax`,
`awaitingBounds`, and input bounds only when `rangeMode` is `auto`; all those values
remain in recorded configurations. Explicit freeze/relearn actions are retained.

The browser queues events and completed clips in IndexedDB and retries until the
local backend acknowledges saving them. The backend uses SQLite with separate
audio files. Pending data and storage errors remain visible in the researcher
**Study** panel; keep the tab open while data is pending. Recording runs
independently of internet connectivity. There is no automatic deletion of study
sessions or recordings.

Live study data is outside the source checkout and cloud-sync folders by default:

- macOS: `~/Library/Application Support/Keirzo/study-data`
- Linux: `$XDG_DATA_HOME/keirzo/study-data`, or `~/.local/share/keirzo/study-data`
- Windows path selection: `%LOCALAPPDATA%/Keirzo/study-data` (the native hardware
  tools in this repository support macOS and Linux).

Override with `KEIRZO_STUDY_DIR` or `--study-dir /path/to/local/study-data`.
`--no-study-recording` is available for development runs; `--no-study-backups`
disables only the automatic backup bundles. Copy the application
to each laptop, but let each installation create its own study directory and
device ID. Keep laptop clocks synchronized before data collection; timestamps
alone cannot correct clock drift between different laptops.

Automatic backups run on startup, every two minutes, and at a normal dashboard
shutdown. Completed ZIP bundles appear under `study-data/backups/<laptop-id>/`.
Each bundle adds new events, microphone clips, and new or changed generated
audio, so earlier audio is not repeatedly copied. A failed backup is retried;
the primary local recordings remain intact. Data still waiting in the browser
is included after it reaches the backend. No data is automatically uploaded.

For USB collection, wait for the researcher's Study panel to show no pending
recordings, close the dashboard normally to finish its last backup, then copy
the **entire `backups` folder** from each laptop onto the USB drive. Retain all
ZIPs: each is part of the study, not a complete replacement for previous bundles.
The per-laptop subfolders keep the six installations separate. The automatic
copies are on the same laptop until you collect them onto another device.

For a separate complete snapshot, choose **Study → Export this laptop** after its
pending queue has drained. The ZIP contains events in exact JSONL and
analysis-friendly CSV, participant-session
records, linked microphone/generated audio, job metadata, and a manifest of
file hashes and any unavailable assets. Exports include all recorded sessions
on that laptop and leave the originals intact. Generated audio still being
prepared is reported as unavailable at export time; export again when it finishes.
The manual export leaves automatic backup progress unchanged.

`tools/study_merge.py` combines bundles from the six laptops and deduplicates
repeated exports by event ID:

```sh
python3 tools/study_merge.py /path/to/collected-laptops --output study-analysis
```

The command finds ZIP bundles recursively; individual ZIP paths also work.
The output includes `combined.sqlite3`, event/session/media CSVs, exact JSONL,
and collected audio. `media.csv` links each microphone clip to its participant
session and local file. JSONL preserves nested payloads; CSV escapes formula-like
text for spreadsheet use. Exceptionally large browser events are preserved as
`recording.event_chunk` fragments: join their JSON strings in `chunk_index`
order for each `logical_event_id` to reconstruct the original event.
The event log supports analyses such as control choices,
time spent in each workspace, response latency, replay/abandonment rates, and
movement-to-output relationships.

### Music mixer

The **Music mixer** tab opens the mixer, with **Create instrumental music** at the top.
The next-track prompt, BPM, key, instruments, and length stay visible.
**Start music** requests original instrumental music and separates its
stems. The mixer plays and shows only instrumental stems; the separated vocal
stem is excluded from playback and mappings. **Recent tracks** recalls saved music;
**Play saved track** starts the selected track and follows the **Next track** choice.
The previous interface remains available through **Previous version**
or directly at <http://127.0.0.1:8790/#elevenlabs>.

**Next track** has four choices:

- **Loop** repeats the current track without requesting another generation.
- **Generate similar** prepares a new track using the prompt and a low-strength
  reference to the current music when available.
- **Generate new** (the default) prepares a fresh interpretation of the prompt.
- **Choose old** lets you select saved music for the next crossfade. The selected
  track then repeats until you choose something else; it uses no generation or
  stem-separation requests.

The generation modes keep one spare track ready, including stems. Each transition
frees the slot for another generation, with no session cap. Editing the prompt,
BPM, key, instruments, or length replaces the waiting generation after a short
typing pause. Switching to Loop or Choose old stops further generation requests;
already submitted work can finish and remains available in **Recent tracks**.
A crossfade already under way finishes smoothly, and the following track uses
the new choice. **Up next** shows the pending music. Key and instrument fields
still constrain both generation modes, so update them with a new style.
The choice and selected saved track are included in saved mixer preferences and
sessions. **Recent tracks** remains available for immediate recall.
Ready tracks crossfade near the loop
boundary; tempo and beat alignment depend on the generated audio. The current
track repeats while its replacement is late, and keeps repeating after an error
until **Retry next track** succeeds. Requests rejected because another music or
stem job is still running retry automatically with a delay. Failed or uncertain
generations are not automatically resubmitted. Every new track and its stem
separation use credits. **Stop** stops playback and automatic generation;
opening or restoring the mixer does not start either.

Use **Connections input** for live or recorded signals, or explicitly choose
**Simulated demo signals**. Add up to four signal mixes, each combining up to six
inputs using average, weighted blend, difference, minimum, or maximum. Inputs
learn their ranges; expand an input to freeze, relearn, or enter fixed bounds.
Input names distinguish joint position from velocity and show their source channel.
Each mix identifies whether it uses a single input or combines several inputs.

Each channel has a volume fader, mute, pan, filters, delay, and reverb; stems also
have solo. **Map a signal** routes a combined signal mix to a channel effect.
Reuse one mix across channels, or add several effect mappings to one channel.
**More effects** includes independent **Playback speed** (75–125%, master only)
and **Pitch shift** (−12 to +12 semitones, master and each stem). Speed preserves
the notes while changing tempo; pitch shifts preserve playback timing. Master
and stem pitch offsets add together. Both controls can be mapped to signals and
use the mapping's **Signal strength** percentage.
Pitch processing runs locally in an AudioWorklet, using the vendored
[SoundTouchJS](https://github.com/cutterbl/SoundTouchJS) processor. It adds a short
buffering delay (about 256 ms) that playback fades and the rap clock account for.
Large shifts can soften or move individual transients; the rap beat grid still
uses the track's requested BPM.
Mapped volume multiplies the manual fader, and mute/solo takes priority. The
vertical meters show effective volume settings, not measured audio loudness.
An audible mapped channel waits for the input signals of mappings above 0% strength; missing inputs on
muted or solo-excluded channels do not silence the other channels.

Mixer preferences save separately from the existing interface. Switching dashboard
workspaces keeps playback running and keeps Connections available. Reloading restores the mix
without starting audio or generation. Stop also stops future generation;
already submitted work can finish and remains in recent tracks. Pending work is
recovered by checking its saved result when playback resumes.

### Previous generated music interface

Start with `make dashboard-sonify`, open **Music mixer**, and choose
**Previous version**. This
workspace uses the existing local server and works without MIDI hardware.
It has its own generated-audio mappings and saved music, and defaults to the
recording or live RAPP stream selected in Connections. Playback, **What creates
next**, inline **Create a starting track**, and realtime mappings share one page.
Existing browser/MIDI recipes remain in Synth and
movement grooves in Drums.

Set `ELEVENLABS_API_KEY` in the repository's ignored `.env` file or the process
environment (the environment takes precedence). Install `ffmpeg` and `ffprobe`
on `PATH`, or place executable copies in `var/bin/`. The workspace reports
missing setup requirements before generation.
Only the backend reads the key. Original recordings, feature tables, and local
paths are never included in the provider request.

**Realtime playback:** choose a saved track as the starting sound, choose a
control source, and press **Play**. The shared Connections input is the
default. **Input override for this instrument** also offers **Separate RAPP WebSocket**
to connect directly, **Replay this track's recording** for the analyzed flat file, or
the clearly labeled demo movement to try the controls. Replay of a track's
recording is available for older tracks that have a saved analysis. New starting
music is generated directly from musical direction, without a recording or
example dataset. RAPP recordings still work as mapping inputs through Connections.

Each live mapping follows **input(s) → audio source → filter/effect**. Choose
the master or an available stem, then low-pass cutoff, resonance, high-pass
cutoff, volume, stereo pan, pitch shift, delay, or reverb. Playback speed applies
to the master so stems stay synchronized; pitch can also be changed per stem.
Create up to 16 mappings, combining up to six
inputs in each with average, weighted average, normalized sum, difference,
minimum, or maximum. Each input is normalized before combining; later rows win
when they address the same audio source and control.

New inputs use **Auto learn**: incoming values expand the observed minimum and
maximum, and constant signals map to the midpoint. Recordings use their full
saved range. **Freeze** keeps the learned range fixed; **Relearn** starts it
again. **Adjust input range** also accepts manual bounds, and output range,
inversion, and smoothing remain editable. Existing saved fixed ranges are kept.
The Synth tab exposes the same combine, auto-learning, freeze, and manual-range
workflow under each input. Controls
update at 20 Hz with audio-parameter smoothing. Missing or stale input fades
the audio and prevents new automatic generation. Playback speed preserves pitch;
tempo and key in a generation plan remain musical requests.
Mapping rows, source settings and the starter selection are saved in the browser.
Automatic upcoming music generation always starts off after a reload.

**Stem separation is automatic by default.** Every new starting track, variation,
and upcoming segment is separated into six instrument layers after generation.
Both music generation and stem separation use provider credits. Older saved
tracks without stems are separated on their first reactive playback; selecting
or reopening a track alone does not start a paid request. Saved stems are reused.
Saved stems play in sync and replace the full mix. Their
sliders and mapping destinations control each layer independently; separation
quality and instrument isolation depend on the provider. Stem filters and
effects run before the layers reach the master filters and effects. A missing
stem is marked unavailable and its mappings never redirect to the master.
The **Stem mixer** includes a **Mute/Unmute** button
for each stem. Mute overrides the stem's mapped volume; unmute restores its
manual level while mappings keep working. Mutes and volume preferences are
remembered by stem name across Stop/Play, upcoming segments, and reloads.
A failed separation leaves the original audio
available. Failed or unknown stem outcomes are not automatically retried.

**Generate upcoming music automatically** is an explicit, initially disabled
credit-using option. Choose 20, 40, or 60 seconds (default 60) and a session cap
(default three new segments). **What creates next** sets style, requested BPM,
key, and instruments for the next submitted request. **Input for new music**
chooses the average of all mappings or one mapping to drive arrangement density;
variability can also shape articulation. Editing these directions does not alter
current playback or submit a request. Directions are saved in the browser, and
each generated segment records the settings used.
The next request starts early using measured generation latency. Only one
request and one ready segment can be pending; current audio loops while waiting
and crossfades when the replacement is ready. Every upcoming segment includes
stem separation; lookahead accounts for its additional processing time.
Press Stop or disable automatic generation to disarm future requests. Switching
dashboard workspaces can leave generation running; work already sent may finish
its music-and-stems pipeline and incur charges. Automatic generation is never
armed after reload.

Rolling segments are saved separately with their observed feature summary and
provenance. They extrapolate recent activity and are not aligned to the original
recording's section timeline. New rolling audio is stored for provider
conditioning; a following segment can reference up to its last 30 seconds.
Older tracks without retained provider audio use the shared musical directions
and a local crossfade. Neither path guarantees beat or melody continuity.

**Create an original starting track:**

1. Set the music description, requested BPM, key, and instruments in **What
   creates next**.
2. Open **Create a starting track**, choose 20, 40, or 60 seconds, and generate.
   This creates original music directly from those choices and automatically
   separates its stems. Both steps consume credits; no file import or recording
   analysis is required.
3. Play the saved result and map your input to its master or stems. Enable
   upcoming music when you want data to guide later segments.

Editing settings never submits a generation request. Duplicate requests reuse
an existing attempt; generating another version is a deliberate paid action.
Previously saved music remains available, including older tracks created from
recordings. Downloads and exports remain available with each saved track.

Jobs, inputs, immutable plan revisions, and audio persist under ignored
`var/elevenlabs/`. One worker sends generation requests at a time. Interrupted
or ambiguous provider outcomes become **unknown**, with no automatic retry;
another attempt may incur another charge. Successful responses must fully
decode before playback becomes available. Duration mismatches remain visible.
Tempo, key, articulation, and density are requested musical properties;
listening is needed to assess the musical result.

The provider timeout defaults to 300 seconds and can be configured with
`ELEVENLABS_TIMEOUT_SECONDS`. Music routes accept same-origin JSON requests
on a loopback server only, including when remote telemetry is otherwise enabled.
The implementation follows the [composition plan API](https://elevenlabs.io/docs/eleven-api/guides/how-to/music/composition-plans),
[compose endpoint](https://elevenlabs.io/docs/api-reference/music/compose),
[stem separation endpoint](https://elevenlabs.io/docs/api-reference/music/separate-stems),
and [audio conditioning guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/music/inpainting).

### Mapping tabs and presets

Use **New tab** for an empty set, **Duplicate** to vary an existing idea, and
the **Tab name** field to name it. Switching tabs stops playback and cancels
queued repeats and active notes. **Remove tab** has an **Undo remove** action
until another tab is removed or a different recording is selected.

**Save preset** captures the current tab's mappings and musical settings as a
separate snapshot. Saving again creates another snapshot, so editing a working
tab never overwrites a preset. Choose a saved preset and **Open in new tab** to
restore it. A preset can be reused on recordings with matching channel and field
identifiers. Incompatible recipes are omitted with an explicit count; their
saved definitions are preserved. The library holds up to 64 presets, and each
tab supports up to 32 input recipes, each with up to 64 destinations.

For an immediate starting point, choose **Rhythmic**, **18** mappings, then
**Generate tab** and **Preview**. Generation keeps previous tabs and uses
distinct destinations, varied signal combinations and wide output ranges.
The server extracts uncached signals together in a single recording scan.
**Stepped** and **Switch** curves produce more pronounced changes than smooth
continuous movement. Generated tabs use three base voices and enable sound changes
(following the sound mapping when present, otherwise cycling the palette).
If enabled mappings share a parameter, the last destination in row order
supplies its value, including CC aliases of the same NRPN parameter.

### Rhythm and preview sound

The 16-step rhythm view shows hits and rests. **Hits / 16** distributes the
selected number of hits across that pattern, **Rotate** shifts it, and
**Repeats** divides a hit into one to four shorter notes. **Swing** alternates
long and short steps; **Accent** reduces offbeat and repeated-note velocities.
Every one of these settings, plus **Tempo**, **Gate length** and **Note chance**,
can be driven by a signal mapping. Green base-setting labels indicate mapped
controls. A mapped value overrides its base setting during playback. Enable
**Loop recording** for repeated playback; Stop also cancels future repeats.

Browser audio and Web MIDI use the same rhythm plan. The browser voice has a
filter, saturation/drive, tempo-related delay and convolution reverb, with
bounded voices and an output compressor. Its eight macros control brightness,
resonance, harmonics, detune, attack, release, echo and space respectively.
The Reverb destination sends CC 91 (reverb dry/wet); CC 93 controls pre-effects
mix on the Hydrasynth. Hydrasynth macros retain the meanings assigned by its current patch; the
browser voice is an audition instrument, not an emulation of that patch.

### Harmony and changing sounds

Each rhythm hit now plays a scale-based chord, with **Voices** from 1–8 (default
3), **Scale thirds**, **Scale fourths** or **Octaves** voicings, **Inversion**, and
**Spread**. Voices, inversion and spread can also be mapped to recording signals.
Thirds/fourths count degrees in the selected scale, including pentatonic scales.
The player keeps notes distinct and within MIDI range; browser chords have
compensated levels to avoid a large volume jump when adding voices. The observer
shows all notes in the chord. MIDI chords use channel 1; the synth patch must be
configured for polyphonic playing.

The Synth mixer **Browser voice** menu provides Glass, Pluck, Warm pad, Reed, Bell and Soft
bass. Wave/envelope/brightness edits return to Custom. Under **Sounds & patches**, **Automatic sound changes** can
keep the selected sound, cycle, choose randomly without immediately repeating,
or **Follow mapping** using the **Sound palette position** destination (0–100%).
Changes are sampled at the start of playback and every 16, 32, 64 or 128 steps.
A mapping alone does not enable patch changes; select Follow mapping to use it.
In Synth mixer this adds the Sound palette position parameter if needed; choose
a signal mix on that parameter to drive patch selection.

For MIDI output, the default **All banks A–H** palette explores all 1,024
locations. **Custom selection** optionally narrows that to 1–32 locations such as
`A001, B017, H128`. The manual **Bank** and
**Patch** selectors and **Select patch** button select a specific location
while keeping playback running. Notes continue automatically after the brief
sound change, without resetting the sequence or pressing Play again. Selecting
a patch while stopped leaves playback stopped. Selecting a patch replaces any
unsaved edit-buffer sound on the synth. Changes release active notes, send bank MSB/LSB and Program
Change with the same 20 ms gaps as the native driver, and wait 100 ms before
resuming notes. Automatic changes are at least two seconds apart; Stop and output changes
cancel pending sends. Workspace navigation keeps playback running. The observer reports the location *sent*,
not an acknowledgement from the hardware or a known patch name.

Enable **Pgm Chg RX** on the Hydrasynth and match its MIDI receive channel to
channel 1. Banks A–H are documented in the current
[ASM Keyboard/Desktop manual](https://www.mecldata.com/download/asm/Hydrasynth_KB_DR_Owners_Manual_2.2.0.pdf).
These controls select sounds already stored on the instrument. Import new
sound packs or rearrange banks with [ASM Manager](https://www.ashunsoundmachines.com/downloads);
the dashboard does not transfer patch-library files or read patch names.

Browser automation uses the six preview sounds; MIDI automation uses instrument
patch locations. Their timbres are independent. Harmony and sound-change settings,
including the MIDI palette, are stored with the Synth mixer session (and with
mapping tabs and presets in the previous Synth interface). Existing
tabs default to keeping the current sound until automation is enabled.

Recording samples advance at the musical clock's pace, not their original
timestamps. Mapping source edits reload the affected playing series; switching
recordings or tabs cancels an unfinished playback preparation.

### Full Hydrasynth parameter mappings

In the previous Synth interface, click **+ Destinations** in a mapping row to search the catalog, filter by group,
and select several targets at once. Each target has an enable switch, its own
curve, and independent From/To values. This allows one joint angle, for example,
to move filter cutoff, invert a mutant depth, change oscillator wave selection,
and increase rhythmic density together. A recipe can also combine up to six
input signals before sending the result to its destinations.

The picker exposes **1,043 usable hardware destinations**, including **929 NRPN
parameters**: oscillators, mutants, filters, envelopes, LFOs and steps, mixer,
effects, arpeggiator, voice settings, macros and modulation routing. CC entries
are often aliases of these parameters, so this count is not 1,043 independent
synthesis controls. Another 106 reference entries remain visible but disabled
because their ranges are missing, addresses conflict, or they use reserved MIDI
control numbers. The catalog is based on ASM's legacy v1.5 MIDI specification;
behavior on the connected instrument's firmware still needs hardware checking.

Choose **Full Hydrasynth engine** in the generator for large sets. **All
generatable** uses every eligible distinct NRPN destination plus musical
controls; raw modulation routing indices, unresolved entries and alternate
BPM-sync-on variants are excluded from random generation. Routing indices are
available for deliberate manual mapping. Some parameters only affect sound when
the patch enables their oscillator mode, modulation route or BPM-sync setting.

Match **PARAM RX mode** in Connections to the synth's `PARAM RX`. NRPN mode converts the
small preview palette's CC controls to their catalog NRPN equivalents. CC mode
sends CC targets and leaves explicit NRPN targets inactive. Browser audio plays
the musical and preview controls; it does not emulate the full Hydrasynth engine.

Updates use a latest-value queue at **25, 50 or 100 parameter changes/second**
(default 50), with complete NRPN transactions and unchanged values skipped.
Large sets therefore evolve more slowly: 256 changing parameters need roughly
five seconds per pass at the default rate. Patch changes pause the queue and
reapply mapped values to the new patch. Stopping, changing tabs or losing the
output cancels pending updates and releases active notes.

### Live RAPP input

**Connections → Live stream** connects directly to the robot or the supplied replay
server, using the protocol in the
[RAPP student pack](https://github.com/maleenj/RAPP-Realtime-Viz/tree/main/viz_student_pack).
Enter the server's `ws://` or `wss://` address and click **Connect live**. The
incoming-data monitor works before playback: inspect channel freshness, signal
values and a selected signal's recent history. Unlabelled arrays and tensors show their
mean, with the selected input's raw elements available in the inspector.
**Pause display** freezes the inspection view while the stream and mappings
continue. **Troubleshooting** provides recent connection events, invalid-message
details, the latest message, a JSON format example, reconnect and diagnostic
copy/download controls. Clearing diagnostics keeps learned mapping ranges.

Open Synth mixer, Drums or Music mixer when ready to play. The default stream
address is `ws://localhost:8765`; replace localhost with the
robot or workshop server's address when needed. Allow local-network access if
the browser requests it. An HTTPS-hosted dashboard requires a `wss://` stream.

Joint positions, velocities, numeric arrays and named tensors appear as they
arrive. The musical clock samples their latest values for rhythm and notes;
MIDI parameters update independently at the selected rate. **Input range** on
each source lets you choose learned minimum/maximum or a fixed physical range,
for example −3.14 to 3.14 radians. **Reset learned ranges** recalibrates the live
session. Live tabs are saved per stream URL, and presets can reuse matching
channel/field names from recordings.

Missing or stale mapped data silences playback after three seconds. A closed
connection immediately releases notes and retries with bounded backoff when
**Reconnect automatically** is enabled. Start playback again after a
reconnection. Clicking a recording returns to file playback. See
[docs/live_streaming.md](docs/live_streaming.md) for replay setup and protocol
limits.

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
3. Build and check the native MIDI device list (Linux first needs the
   [ALSA development package](docs/linux.md)):

   ```sh
   make
   ./build/hydractl rescan
   ./build/hydractl list
   ```

The destination should contain `HYDRASYNTH`. On Linux, compare the list with
`aconnect -l` and follow the [Linux device checks](docs/linux.md#device-checks).
On macOS, if USB sees the synth but the list is empty, open **Audio MIDI Setup**, choose **Window > Show MIDI Studio**, and
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

`serve` keeps the native MIDI ports open and accepts one protocol-v1 JSON object
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

**Hydrasynth cleanup caveat:** the repository's MIDI mapping assigns CC 120 to
ARP Octave. Native panic/shutdown therefore needs hardware validation before it
can be treated as a reset that preserves arpeggiator settings. The browser's
All notes off path uses CC 64/123 without CC 120. See the manual's
[native MIDI chapter](docs/instruction-manual.html#native-midi-audio).

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

The native command broker is not exposed through HTTP or browser JavaScript.
The dashboard also has HTTP `POST` routes for Signal Lab observer events,
music and rap generation, robot control, and study recording/export. These
routes have their own validation and local-access rules; the browser can also
send MIDI directly through its separate Web MIDI connection.
HTTP binds only to loopback by default. A non-loopback `--host`
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
http://127.0.0.1:8790/observer/?view=catalog&q=filter1
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

`hydra-audio` discovers native input devices (Core Audio on macOS, ALSA on Linux)
and meters one input channel without saving audio:

```sh
./build/hydra-audio list
./build/hydra-audio list --json
./build/hydra-audio meter --duration 2
```

The meter defaults to the input device whose name contains `Revolution 2x2`,
channel 1, for 10 seconds. Selection can instead use a device-name query or the
exact device UID. On Linux, use the ALSA PCM UID printed by `list --json`, such
as `hw:CARD=USB,DEV=0`; the Apple UID in the second example is macOS-only:

```sh
./build/hydra-audio meter --device 'Revolution 2x2' --channel 1 --duration 2
./build/hydra-audio meter \
  --uid 'AppleUSBAudioEngine:Black Lion Audio:Revolution 2x2:FFFFFFFF:1,2' \
  --channel 1 --duration 2 --json
```

`--uid` and `--device` are alternatives. Durations range from 0.1 to 3,600
seconds. On macOS, the tool resolves the selection to its stable UID and
assigns that device to a native AudioQueue with three preallocated input
buffers. Only the selected one-based channel is accumulated; no sample file or
audio history is retained.

The JSON report includes requested/elapsed duration, sample rate, frame and
valid-sample counts, RMS and RMS dBFS, peak and peak dBFS, DC offset,
clipping/sample count, non-finite sample count, and whether capture was
interrupted. Plain output presents the main measurements for a human reader.
Clipping means an absolute input sample at or above 1.0 (0 dBFS).

On Linux, capture negotiates the channel count, sample format and rate with
ALSA. `--uid` can also select an explicitly configured `default`, PipeWire or
PulseAudio ALSA PCM. See [Linux audio routing](docs/linux.md#audio-routing).
This tool measures input levels; browser synthesis and playback are separate.

The first capture on macOS may trigger its Microphone authorization prompt. Grant
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
