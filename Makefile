CC := clang
CFLAGS := -std=c17 -Wall -Wextra -Wpedantic -O2
PYTHON ?= $(if $(wildcard .venv/bin/python),.venv/bin/python,python3)
NODE ?= node
MIDI_FRAMEWORKS := -framework CoreMIDI -framework CoreFoundation
AUDIO_FRAMEWORKS := -framework AudioToolbox -framework CoreAudio -framework CoreFoundation
MIDI_TARGET := build/hydractl
AUDIO_TARGET := build/hydra-audio
TARGETS := $(MIDI_TARGET) $(AUDIO_TARGET)

.PHONY: all test clean dashboard dashboard-demo dashboard-sonify dashboard-command dashboard-test

all: $(TARGETS)

$(MIDI_TARGET): src/hydractl.c
	mkdir -p build
	$(CC) $(CFLAGS) $< $(MIDI_FRAMEWORKS) -o $@

$(AUDIO_TARGET): src/hydra_audio.c
	mkdir -p build
	$(CC) $(CFLAGS) $< $(AUDIO_FRAMEWORKS) -o $@

test: $(TARGETS)
	$(MIDI_TARGET) self-test
	$(AUDIO_TARGET) self-test
	$(MAKE) dashboard-test

dashboard: $(MIDI_TARGET)
	$(PYTHON) tools/hydra_dashboard.py

dashboard-demo:
	$(PYTHON) tools/hydra_dashboard.py --demo

dashboard-sonify:
	$(PYTHON) tools/hydra_dashboard.py --demo $(if $(RECORDINGS_DIR),--recordings-dir "$(RECORDINGS_DIR)",)

dashboard-command:
	$(PYTHON) -B tools/hydra_command.py

dashboard-test:
	$(PYTHON) -B tools/hydra_dashboard.py --self-test
	$(PYTHON) -B tools/test_robot_control.py
	$(PYTHON) -B tools/test_robot_devices.py
	$(PYTHON) -B tools/test_robot_ribs.py
	$(PYTHON) -B tools/test_robot_serial.py
	$(PYTHON) -B tools/test_robot_http.py
	$(PYTHON) -B tools/test_robot_drum_performance.py
	$(PYTHON) -B tools/test_robot_drum_latency.py
	$(NODE) --check dashboard/robot-control.js
	$(NODE) tools/test_robot_control.js
	$(NODE) --check dashboard/robot-live.js
	$(NODE) tools/test_robot_live.js
	$(NODE) --check dashboard/robot-drums.js
	$(NODE) tools/test_robot_drums.js
	$(PYTHON) -B tools/test_recording_library.py
	$(PYTHON) -B tools/test_elevenlabs_analysis.py
	$(PYTHON) -B tools/test_elevenlabs_service.py
	$(PYTHON) -B tools/test_elevenlabs_realtime.py
	$(PYTHON) -B tools/test_elevenlabs_http.py
	$(PYTHON) -B tools/test_rap_render.py
	$(PYTHON) -B tools/test_rap_service.py
	$(PYTHON) -B tools/test_rap_http.py
	$(PYTHON) -B tools/test_rap_experiment_render.py
	$(PYTHON) -B tools/test_rap_experiment_service.py
	$(PYTHON) -B tools/test_rap_experiment_http.py
	$(PYTHON) -B tools/test_rap_response_service.py
	$(PYTHON) -B tools/test_rap_transcription.py
	$(PYTHON) -B tools/test_rap_response_http.py
	$(PYTHON) -B tools/validate_parameters.py
	$(PYTHON) -B tools/validate_parameters.py --self-test
	$(NODE) --check dashboard/app.js
	$(NODE) --check dashboard/workspace-shell.js
	$(NODE) --check dashboard/sonification.js
	$(NODE) --check dashboard/parameters.js
	$(NODE) --check dashboard/live.js
	$(NODE) --check dashboard/live-monitor-model.js
	$(NODE) --check dashboard/live-monitor.js
	$(NODE) --check dashboard/drums.js
	$(NODE) --check dashboard/drum-workspace.js
	$(NODE) --check dashboard/elevenlabs.js
	$(NODE) --check dashboard/elevenlabs-player.js
	$(NODE) --check dashboard/audio-pitch.js
	$(NODE) --check dashboard/audio-pitch-worklet.js
	$(NODE) --check dashboard/elevenlabs-realtime.js
	$(NODE) --check dashboard/elevenlabs-source.js
	$(NODE) --check dashboard/music-mixer-engine.js
	$(NODE) --check dashboard/music-mixer-generation.js
	$(NODE) --check dashboard/music-mixer.js
	$(NODE) --check dashboard/rap.js
	$(NODE) --check dashboard/music-mixer-voice.js
	$(NODE) --check dashboard/rap-experiment.js
	$(NODE) --check dashboard/rap-response.js
	$(NODE) --check dashboard/synth-mixer-engine.js
	$(NODE) --check dashboard/synth-mixer.js
	$(NODE) --check dashboard/signal-library.js
	$(NODE) --check dashboard/session-library.js
	$(NODE) tools/test_synth_mixer_engine.js
	$(NODE) tools/test_synth_mixer_transport.js
	$(NODE) tools/test_synth_mixer_ui.js
	$(NODE) tools/test_signal_library.js
	$(NODE) tools/test_session_library.js
	$(NODE) tools/test_session_integration.js
	$(NODE) tools/test_music_mixer_engine.js
	$(NODE) tools/test_music_mixer_generation.js
	$(NODE) tools/test_music_mixer_ui.js
	$(NODE) tools/test_rap_ui.js
	$(NODE) tools/test_music_mixer_voice.js
	$(NODE) tools/test_rap_experiment_ui.js
	$(NODE) tools/test_rap_response_ui.js
	$(NODE) tools/test_elevenlabs_ui.js
	$(NODE) tools/test_elevenlabs_source.js
	$(NODE) tools/test_elevenlabs_player.js
	$(NODE) tools/test_audio_pitch.js
	$(NODE) tools/test_elevenlabs_realtime.js
	$(NODE) tools/test_parameters_live.js
	$(NODE) tools/test_live_monitor_model.js
	$(NODE) tools/test_live_monitor.js
	$(NODE) tools/test_live_connections.js
	$(NODE) tools/test_sonification.js
	$(NODE) tools/test_sonification_player.js
	$(NODE) tools/test_drums.js
	$(NODE) tools/test_drum_player.js
	$(NODE) tools/test_dashboard_semantics.js
	$(NODE) tools/test_workspace_shell.js
	$(NODE) tools/test_workspace_integration.js
	$(NODE) tools/test_midi_connection.js
	$(NODE) --check dashboard/observer/app.js
	$(NODE) tools/test_observer_semantics.js

clean:
	rm -f $(TARGETS)
