CC := clang
CFLAGS := -std=c17 -Wall -Wextra -Wpedantic -O2
PYTHON ?= python3
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
	$(PYTHON) -B tools/test_recording_library.py
	$(PYTHON) -B tools/validate_parameters.py
	$(PYTHON) -B tools/validate_parameters.py --self-test
	$(NODE) --check dashboard/app.js
	$(NODE) --check dashboard/sonification.js
	$(NODE) --check dashboard/parameters.js
	$(NODE) --check dashboard/live.js
	$(NODE) tools/test_parameters_live.js
	$(NODE) tools/test_sonification.js
	$(NODE) tools/test_sonification_player.js
	$(NODE) tools/test_dashboard_semantics.js
	$(NODE) --check dashboard/observer/app.js
	$(NODE) tools/test_observer_semantics.js

clean:
	rm -f $(TARGETS)
