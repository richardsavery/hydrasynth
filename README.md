# Hydrasynth control

A small, dependency-free macOS command-line controller for an ASM Hydrasynth over
USB MIDI. It uses Apple's CoreMIDI framework directly.

## Interactive sonification dashboard

The dashboard can turn RAPP newline-delimited JSON into music without requiring
the Hydrasynth to be connected. Portable gzip-compressed copies of the three
current recordings are included in [`recordings/`](recordings/), so a fresh
clone is ready to use on macOS without the RAPP repository beside it. The
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

On a MacBook, clone the repository and run:

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
to another Mac, also copy `var/robot/head-calibration.json` from the original
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
return. Stop and tab switching silence notes and stop parameter updates.
Settings save separately under `hydra.synth-mixer.v1`; the original Synth's
mapping sets and sound controls stay independent.

### Rap response

Open **Rap response**, choose Boom bap, Trap or Lo-fi, then **Record a message**.
**Finish & rap** sends the recording and prepares a musical answer. Recording
is limited to 30 seconds. You can also type what you would say and press
**Make rap response**. Choose four or eight bars and Boom bap, Trap or Lo-fi.
The default **Over main music** mode keeps the Music mixer or Synth mixer
playing, separates the generated rap vocal, and starts it on the next bar.
Start the backing in its mixer first, then switch to Rap response. Its tempo
is used for new replies when it is within the supported 70–140 BPM range.
Use headphones when recording with music playing to keep the backing out of
the microphone. **With generated beat** plays the complete generated song
and stops the other dashboard audio.

Choose **Voice for new replies** to reuse a vocal preset: **Deep Hip-Hop
Voice** (the default) or **Emo Trap Autotune**. Each selection pins an ElevenLabs
music finetune, giving subsequent performances the same vocal foundation.
Delivery, accent, and expression can still vary; audition several replies to
check the consistency you need. The selected voice is saved with each response
and shown in the response library. Changing the selector affects new replies;
existing recordings retain their original voice.

The backend transcribes recordings locally with **Whisper Small** through
`faster-whisper` using CPU int8 inference. Microphone audio is not sent to
ElevenLabs. Only the transcript goes to ElevenLabs: a Music composition plan
writes a relevant rhyming answer, then Eleven Music performs the vocal and
backing together using the existing `ELEVENLABS_API_KEY`. The curated vocal
finetunes use their catalogued base model, `music_v2`; legacy requests without
a vocal preset retain `music_v2_5`. This uses the music API's `finetune_id`,
not a text-to-speech voice ID or a voice-conversion step. For playback
over main music, the ElevenLabs two-stem separation endpoint then extracts
the vocal. This adds processing time and an API request. No separate
LLM account or ElevenAgent setup is needed. Typed input skips transcription.
FFmpeg and ffprobe validate the finished audio, as in the existing
generated-music workflow. New musical replies use music credits; local
transcription and replaying saved replies use no API credits.

Install the local transcription dependency and download Whisper Small once:

```sh
.venv/bin/python -m pip install -r requirements-rap-response.txt
.venv/bin/python tools/prepare_rap_transcription.py
```

The model is stored in `var/whisper/small` and loaded on the first recording,
then reused. Transcription runs offline after setup; the dashboard does not
download models when recording or starting up. Typed replies remain available
if the local transcription dependency or model is missing.

The prompt requests short rhyming lines that answer the message, with rhythmic
rap delivery and an immediate instrumental backing. The music model applies
the selected vocal preset and interprets the requested tempo. This generates
a new short song for each message, so expect a
generation wait. The transcript and reply lyrics appear as the steps finish.
The next-bar start follows the mixer's clock; music generation does not
guarantee the requested BPM, so the vocal may drift against the backing.
Changing or stopping the backing stops the vocal. An isolated vocal waits
for backing music before playing; it never substitutes the original full mix.
Saved full-mix responses can be isolated without regenerating their lyrics
or music. Both the full mix and the isolated vocal can be downloaded.

**Play when my new response is ready** only applies to a reply you just requested. Opening a
saved reply or restoring a session never records, generates or plays on its own.
Recording and vocal playback in **Over main music** preserve the backing.
Leaving the tab releases the microphone, stops the reply vocal and cancels pending auto-play; an
already submitted generation can finish in the background. Cancel stops
remaining generation steps, but an API request already in flight may still use
credits. Interrupted requests are recoverable by their request ID and are never
automatically repeated.

Replies and submitted recordings are stored locally under `var/rap-response`.
Browser settings and saved sessions retain preferences and job references,
without embedding microphone recordings. The API key remains on the backend.

Rap controls live in **Rap response**. The Synth and Music mixers contain only
their instrumental controls; start a backing track there, then open Rap response
to record or type a message. Earlier embedded voice drafts and prepared-render
references remain in saved mixer settings and named sessions, without starting
a hidden voice player.

### Rap experiment

**Rap response → Voice experiments** opens the comparison workspace. Its
existing `#rap-experiment` bookmarks still work. Enter one verse, BPM, a main
voice, an alternate voice and a delivery direction, then **Generate all eight comparisons**.
It prepares eight examples: natural speech, phrases placed on beats, a fresh
take, a different voice, expressive Eleven v4 delivery, whole-line bar fitting,
a produced vocal, and a rap generated by Eleven Music with its vocal separated.

For a quicker result, **Generate fast voice** uses Eleven Flash 2.5 at 24 kHz
and creates clean and robot versions from one speech request. Jade is the default
voice for this experiment; an explicit `ELEVENLABS_VOICE_ID` still takes precedence.
**Autotune** can follow the voice and snap it to a selected key and scale, or
force its voiced sections onto a fixed melody: one note, two notes, rising,
falling, arpeggio or pop hook. Melody controls select octave 2–5 and a new note
every half, one or two beats. The pattern follows the BPM from the start of the
clip, continuing through pauses while consonants remain intact. Fixed patterns
use major intervals when Chromatic is selected; Follow voice retains chromatic
scale correction.
**Rhythm** independently controls phrasing: Natural retains the original take,
Phrases on beats moves complete phrases to beat starts, and Beat flow gently
stretches whole lyric lines to beat lengths. Put each phrase on its own line for
Beat flow. Stretching stays within 0.8–1.25 of the original duration, preserving
pitch; short phrases use half beats or keep their original duration. It retains
phrase tails and never slices individual words. This improves rhythmic phrasing,
but does not turn a spoken take into a performed rap. Stretched word timestamps
are estimates. Both clean and processed examples use the selected rhythm.
**Metallic** adds ring modulation and **Radio** adds filtering and digital
distortion. Effect amount controls the wet/dry mix (100% for new drafts), and Tone
controls its brightness (6 kHz for new drafts). Explicit saved values remain.
**Apply effects**
reprocesses the saved recording locally when the lyrics and main voice match;
it includes a clean comparison and does not request another voice. Natural
rhythm preserves the original speech timing.
Fast requests have a separate worker so they can run alongside longer comparison
jobs. Cards show measured voice-generation, processing and total ready times;
playback becomes available when the complete clip is ready.
Older Vocoder examples remain playable; their next effects edit uses Autotune.

Examples have individual Play and Download controls. Only one plays at a time;
the optional metronome starts with the example. Generated rap also exposes its
full mix separately from the isolated vocal. Saved comparisons reopen without
generation or playback. Lyrics, selected comparison and listening preferences
are included in named sessions; audio remains in `var/rap-experiment`.

The default full comparison uses four speech generations, one music generation
and one two-stem separation. Natural/phrases share one source, while expressive,
bar timing and vocal production share another. **New take** on a voice card
requests a new performance; timing/production cards reuse a matching saved
source through **Apply timing** or **Apply effects** when possible. Per-example
failures leave successful examples available.
Interrupted provider requests are never automatically repeated. The optional
voice catalog needs the key's `voices_read` permission; default and custom voice
IDs remain usable without that catalog permission.
The Main voice selector also offers a public shortlist when the account catalog
is unavailable. Compare the clean take first, then its processed version; saved
comparison labels include the selected voice. Labelled audition sets appear in
**Neutral · Rhythm** first, followed by Jade · Melodies, Clear & rhythmic,
Deep & gritty, and Bright & synthetic groups. Stable IDs such as N01, J01, A1,
B2 and C3 make feedback
specific. Previous/Next browses the same order without starting playback.
The Jade set includes eight treatments of the same saved Jade take, plus two
melodies each for Elowen and Maisie. Every treatment includes its clean source,
with the same lyrics, 100 BPM, 100% effect and 6 kHz tone. Earlier auditions stay
available in their original groups.
The Neutral set compares Jade in a middle register with natural, phrase and
beat-flow timing, plus a Maisie alternative. These are listening candidates for a
more neutral presentation; pitch alone does not determine perceived gender.
To use an original designed voice, create and save one with ElevenLabs
[Voice Design](https://elevenlabs.io/docs/eleven-creative/voices/voice-design),
then choose **Custom voice ID** here. The dashboard does not create new voice
identities or add voices to the account.

Python performs all voice preparation. Bar fitting uses restrained,
pitch-preserving WSOLA on whole lyric lines; short lines retain their natural
delivery and receive padding. Vocal production adds EQ, compression, mild
saturation and stereo doubling. Speech comparisons use active-signal RMS
matching with peak protection. The expressive source is 24 kHz versus the
16 kHz baseline. These changes affect delivery, timing and fidelity together;
the expressive comparison is not a controlled sample-rate-only test.

Bar fitting, production and robot effects require NumPy (`python3 -m pip install numpy`). The music
comparison requires FFmpeg and ffprobe, using the existing local music tools.
Music generation chooses its own vocal identity and only requests the supplied
BPM; it may not precisely follow the metronome, and separated vocals may retain
instrument bleed. This tab is for auditioning approaches before adopting one in
the mixers. The implementation uses the official
[speech timing API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps),
[expressive voice directions](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices),
and [music API](https://elevenlabs.io/docs/api-reference/music/compose).

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
does not generate music, request MIDI access, or reconnect live inputs. Press
Connect live or Connect MIDI device when needed, then Play to resume.
Running generation jobs are separate from saved sessions.

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

Mixer preferences save separately from the existing interface. Switching tabs
stops playback and keeps Connections available. Reloading restores the mix
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
Stopping or leaving the tab disarms future requests; work already sent may
finish its music-and-stems pipeline and incur charges. Automatic generation is
never armed after reload.

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

Match **Parameter format** to the synth's `PARAM RX`. NRPN mode converts the
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

Native MIDI command traffic is never accepted over TCP or exposed to browser
JavaScript. The browser can publish Signal Lab observer events and use the
local ElevenLabs workflow over HTTP `POST`; other mutation routes are rejected.
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
