#ifndef HYDRA_MIDI_H
#define HYDRA_MIDI_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The controller owns one native connection. A zero endpoint is never valid. */
typedef struct HydraMIDI HydraMIDI;
typedef uint64_t HydraMIDIEndpoint;
typedef struct {
    HydraMIDIEndpoint id;
    char name[512];
    char address[32];
} HydraMIDIEndpointInfo;
typedef void (*HydraMIDIReceive)(void *, const uint8_t *, size_t);
typedef void (*HydraMIDIDisconnect)(void *);

int hydra_midi_open(HydraMIDI **midi);
void hydra_midi_close(HydraMIDI *midi);
/* Returns a count, or -1 on failure (including a too-small destination). */
int hydra_midi_enumerate(HydraMIDI *midi, bool input,
                         HydraMIDIEndpointInfo *entries, size_t capacity);
void hydra_midi_endpoint_name(HydraMIDI *midi, HydraMIDIEndpoint endpoint,
                              char *name, size_t size);
bool hydra_midi_same_device(HydraMIDIEndpoint a, HydraMIDIEndpoint b);
int hydra_midi_select_output(HydraMIDI *midi, HydraMIDIEndpoint destination);
/* On input/monitor loss only safety cleanup messages are allowed, and only
 * while the original destination connection is still valid. */
int hydra_midi_send(HydraMIDI *midi, HydraMIDIEndpoint destination,
                    const uint8_t *bytes, size_t length);
/* Source may be zero: disconnect monitoring still runs for the destination.
 * Only the receive callback produces input bytes; stop joins/quiesces it. */
int hydra_midi_start_monitor(HydraMIDI *midi, HydraMIDIEndpoint source,
                             HydraMIDIReceive receive,
                             HydraMIDIDisconnect disconnect, void *context);
void hydra_midi_stop_monitor(HydraMIDI *midi);
int hydra_midi_rescan(void);
uint32_t hydra_random_uniform(uint32_t upper_bound);

#endif
