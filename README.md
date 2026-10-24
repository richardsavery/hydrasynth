# Hydra Signal Lab

Make music from movement, create rap responses, and control Keirzo and the
Hydrasynth. You can start with laptop sound and no connected hardware.

## Install

**Ubuntu/Debian:** install Git first:

```sh
sudo apt-get update
sudo apt-get install -y git
```

**Mac:** if Apple's Command Line Tools are not installed, run the following and
finish the installation window before continuing:

```sh
xcode-select --install
```

**Then, on either Mac or Linux:**

```sh
git clone https://github.com/richardsavery/hydrasynth.git
cd hydrasynth
bash tools/setup.sh
```

Setup detects your system and installs the required Python packages, FFmpeg,
native MIDI/audio tools, and **Whisper Small for microphone transcription**.
On Mac, it also installs Homebrew if needed. Whisper needs no separate setup.
Keep the internet connected and allow a few GB of free space.

Run setup as your normal user; it asks for your password if needed.
Paste this laptop's ElevenLabs API key when prompted, or press Enter to skip.
New music and rap generation need a key and use credits; browser sound and saved
demos work without one.

## Start

From the `hydrasynth` folder, on Mac or Linux:

```sh
make dashboard-sonify
```

Open **<http://127.0.0.1:8790/#synth-mixer>** and leave the terminal open.
Try **Connections → Browser audio → Test sound**.
When finished, stop playback, then press **Ctrl+C** in the terminal.

Study recording is disabled by default while investigating browser freezes.
Existing study data stays saved. To explicitly enable capture and local backups,
start with `make dashboard-sonify DASHBOARD_ARGS='--study-recording'`.

## Update an existing laptop

Stop playback and press **Ctrl+C** in the server terminal. From the existing
`hydrasynth` folder, run:

```sh
git pull --ff-only && bash tools/setup.sh
```

Setup updates Python packages and rebuilds the native tools. It keeps your
API key, downloaded Whisper model, recordings, robot calibration and study data.
**No new clone or separate Whisper installation is needed.**

Once setup finishes, start again and refresh the browser:

```sh
make dashboard-sonify
```

## More help

- **Using the app:** [User guide (PDF)](docs/user-guide.pdf) · [Offline HTML](docs/user-guide.html)
- **Setup and troubleshooting:** [Mac](docs/macos.md) · [Linux](docs/linux.md)
- **Keys for six laptops:** [Laptop setup](docs/linux.md#installing-on-six-laptops)
- **Connected hardware:** [Mac MIDI/audio](docs/macos.md#connected-hardware) · [Linux MIDI](docs/linux.md#native-midi) · [Keirzo setup](docs/robot_control.md)
- **Full instructions:** [Operator manual (PDF)](docs/instruction-manual.pdf) · [Offline HTML](docs/instruction-manual.html)
- **Advanced features and development:** [Technical reference](docs/reference.md)

Mac and Linux are the supported targets. Native Windows is not supported.
