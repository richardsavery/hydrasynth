# Hydra Signal Lab

Make music from movement, create rap responses, and control Keirzo and the
Hydrasynth. You can start with laptop sound and no connected hardware.

## Install on Linux

On **Ubuntu or Debian**, open a terminal and run:

```sh
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/richardsavery/hydrasynth.git
cd hydrasynth
bash tools/setup_linux.sh
```

**Setup installs everything needed to run the app**, including Python packages,
FFmpeg, native MIDI/audio tools, and **Whisper Small for microphone transcription**.
You do not need to install or download Whisper separately.
Keep the internet connected and allow a few GB of free space.

Run setup as your normal user; it asks for your password if needed.
Paste this laptop's ElevenLabs API key when prompted, or press Enter to skip.
New music and rap generation need a key and use credits; browser sound and saved
demos work without one.

## Start

From the `hydrasynth` folder:

```sh
make dashboard-sonify
```

Open **<http://127.0.0.1:8790/#synth-mixer>** and leave the terminal open.
Try **Connections → Browser audio → Test sound**.
When finished, stop playback, then press **Ctrl+C** in the terminal.

## Update an existing laptop

Stop playback and press **Ctrl+C** in the server terminal. From the existing
`hydrasynth` folder, run:

```sh
git pull --ff-only && bash tools/setup_linux.sh
```

The same setup script updates Python packages and rebuilds the native tools.
It keeps your API key, downloaded Whisper model, recordings, robot calibration,
and study data. **You do not need to clone again or reinstall Whisper.**

Once setup finishes, start again and refresh the browser:

```sh
make dashboard-sonify
```

## More help

- **Using the app:** [User guide (PDF)](docs/user-guide.pdf) · [Offline HTML](docs/user-guide.html)
- **Installation, updates and troubleshooting:** [Linux guide](docs/linux.md)
- **Keys for six laptops:** [Laptop setup](docs/linux.md#installing-on-six-laptops)
- **Connected hardware:** [Hydrasynth MIDI](docs/linux.md#native-midi) · [Keirzo setup](docs/robot_control.md)
- **Full instructions:** [Operator manual (PDF)](docs/instruction-manual.pdf) · [Offline HTML](docs/instruction-manual.html)
- **Advanced features, macOS and development:** [Technical reference](docs/reference.md)
