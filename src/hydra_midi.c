#if defined(__linux__)
#define _POSIX_C_SOURCE 200809L
#endif
#include "hydra_midi.h"

#include <errno.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>

/* After input monitoring fails, release already-sounding notes on the still
 * connected destination, but never permit fresh notes or parameter changes. */
static bool is_cleanup_message(const uint8_t *bytes, size_t length) {
    if (!length || length % 3) return false;
    for (size_t offset = 0; offset < length; offset += 3) {
        unsigned status = bytes[offset] & 0xF0;
        unsigned data1 = bytes[offset + 1], data2 = bytes[offset + 2];
        if (data1 > 127 || data2 > 127) return false;
        if (status == 0x80 || (status == 0x90 && data2 == 0)) continue;
        if (status == 0xB0 && data2 == 0 &&
            (data1 == 64 || data1 == 123)) continue;
        return false;
    }
    return true;
}

#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <CoreMIDI/CoreMIDI.h>

struct HydraMIDI {
    pthread_mutex_t callback_lock;
    MIDIClientRef client;
    MIDIPortRef output;
    MIDIPortRef input;
    MIDIEndpointRef destination;
    SInt32 destination_unique_id;
    atomic_bool output_lost;
    MIDIEndpointRef source;
    HydraMIDIReceive receive;
    HydraMIDIDisconnect disconnect;
    void *context;
    atomic_bool monitoring;
    atomic_bool lost;
};

static void midi_notify(const MIDINotification *notification, void *opaque) {
    HydraMIDI *midi = opaque;
    pthread_mutex_lock(&midi->callback_lock);
    if (notification->messageID == kMIDIMsgObjectRemoved &&
        atomic_load_explicit(&midi->monitoring, memory_order_acquire)) {
        const MIDIObjectAddRemoveNotification *removed =
            (const MIDIObjectAddRemoveNotification *)notification;
        if (removed->child == midi->destination) atomic_store(&midi->output_lost, true);
        if (removed->child == midi->destination ||
            (midi->source && removed->child == midi->source)) {
            if (!atomic_exchange(&midi->lost, true) && midi->disconnect)
                midi->disconnect(midi->context);
        }
    }
    pthread_mutex_unlock(&midi->callback_lock);
}

static void midi_read(const MIDIPacketList *packets, void *opaque, void *source) {
    (void)source;
    HydraMIDI *midi = opaque;
    pthread_mutex_lock(&midi->callback_lock);
    if (atomic_load_explicit(&midi->monitoring, memory_order_acquire) && midi->receive) {
        const MIDIPacket *packet = &packets->packet[0];
        for (UInt32 index = 0; index < packets->numPackets; index++) {
            midi->receive(midi->context, packet->data, packet->length);
            packet = MIDIPacketNext(packet);
        }
    }
    pthread_mutex_unlock(&midi->callback_lock);
}

int hydra_midi_open(HydraMIDI **result) {
    *result = NULL;
    HydraMIDI *midi = calloc(1, sizeof(*midi));
    if (!midi) return -1;
    pthread_mutex_init(&midi->callback_lock, NULL);
    atomic_init(&midi->monitoring, false);
    atomic_init(&midi->lost, false);
    atomic_init(&midi->output_lost, false);
    OSStatus status = MIDIClientCreate(CFSTR("HydraControl"), midi_notify,
                                       midi, &midi->client);
    if (status == noErr)
        status = MIDIOutputPortCreate(midi->client, CFSTR("HydraControl Output"),
                                      &midi->output);
    if (status != noErr) {
        fprintf(stderr, "error: connecting to CoreMIDI failed (status %d)\n",
                (int)status);
        hydra_midi_close(midi);
        return -1;
    }
    *result = midi;
    return 0;
}

void hydra_midi_endpoint_name(HydraMIDI *midi, HydraMIDIEndpoint endpoint,
                              char *name, size_t size) {
    (void)midi;
    CFStringRef value = NULL;
    OSStatus status = MIDIObjectGetStringProperty((MIDIEndpointRef)endpoint,
                                                  kMIDIPropertyDisplayName,
                                                  &value);
    bool copied = status == noErr && value &&
        CFStringGetCString(value, name, (CFIndex)size, kCFStringEncodingUTF8);
    if (value) CFRelease(value);
    if (!copied) snprintf(name, size, "MIDI endpoint %u", (unsigned)endpoint);
}

int hydra_midi_enumerate(HydraMIDI *midi, bool input,
                         HydraMIDIEndpointInfo *entries, size_t capacity) {
    ItemCount count = input ? MIDIGetNumberOfSources() : MIDIGetNumberOfDestinations();
    if (count > capacity) return -1;
    for (ItemCount index = 0; index < count; index++) {
        entries[index].id = input ? MIDIGetSource(index) : MIDIGetDestination(index);
        hydra_midi_endpoint_name(midi, entries[index].id, entries[index].name,
                                 sizeof(entries[index].name));
        entries[index].address[0] = '\0';
    }
    return (int)count;
}

bool hydra_midi_same_device(HydraMIDIEndpoint a, HydraMIDIEndpoint b) {
    MIDIEntityRef entity_a = 0, entity_b = 0;
    MIDIDeviceRef device_a = 0, device_b = 0;
    MIDIEndpointGetEntity((MIDIEndpointRef)a, &entity_a);
    MIDIEndpointGetEntity((MIDIEndpointRef)b, &entity_b);
    if (entity_a && entity_a == entity_b) return true;
    if (entity_a) MIDIEntityGetDevice(entity_a, &device_a);
    if (entity_b) MIDIEntityGetDevice(entity_b, &device_b);
    if (device_a && device_a == device_b) return true;
    /* CoreMIDI virtual endpoints have no entity/device. Pair by an identical
     * display name only in that case; the caller rejects duplicate sources. */
    if (!entity_a && !entity_b && a && b) {
        char name_a[512], name_b[512];
        hydra_midi_endpoint_name(NULL, a, name_a, sizeof(name_a));
        hydra_midi_endpoint_name(NULL, b, name_b, sizeof(name_b));
        return !strcmp(name_a, name_b);
    }
    return false;
}

int hydra_midi_select_output(HydraMIDI *midi, HydraMIDIEndpoint destination) {
    midi->destination = (MIDIEndpointRef)destination;
    if (MIDIObjectGetIntegerProperty(midi->destination, kMIDIPropertyUniqueID,
                                     &midi->destination_unique_id) != noErr) {
        fputs("error: selected CoreMIDI output is unavailable\n", stderr);
        return -1;
    }
    return 0;
}

int hydra_midi_send(HydraMIDI *midi, HydraMIDIEndpoint destination,
                    const uint8_t *bytes, size_t length) {
    if (atomic_load(&midi->lost)) {
        SInt32 unique_id = 0;
        if (!is_cleanup_message(bytes, length) || atomic_load(&midi->output_lost) ||
            MIDIObjectGetIntegerProperty(midi->destination, kMIDIPropertyUniqueID,
                                          &unique_id) != noErr ||
            unique_id != midi->destination_unique_id) return -1;
    }
    union { MIDIPacketList alignment; uint8_t bytes[1024]; } storage;
    MIDIPacketList *list = (MIDIPacketList *)storage.bytes;
    MIDIPacket *packet = MIDIPacketListInit(list);
    if (!MIDIPacketListAdd(list, sizeof(storage.bytes), packet, 0, length, bytes)) {
        fputs("error: MIDI packet is too large\n", stderr);
        return -1;
    }
    OSStatus status = MIDISend(midi->output, (MIDIEndpointRef)destination, list);
    if (status != noErr) {
        fprintf(stderr, "error: sending MIDI failed (status %d)\n", (int)status);
        return -1;
    }
    return 0;
}

int hydra_midi_start_monitor(HydraMIDI *midi, HydraMIDIEndpoint source,
                             HydraMIDIReceive receive,
                             HydraMIDIDisconnect disconnect, void *context) {
    pthread_mutex_lock(&midi->callback_lock);
    midi->source = (MIDIEndpointRef)source;
    midi->receive = receive;
    midi->disconnect = disconnect;
    midi->context = context;
    atomic_store_explicit(&midi->monitoring, true, memory_order_release);
    pthread_mutex_unlock(&midi->callback_lock);
    OSStatus status = noErr;
    if (source) {
        status = MIDIInputPortCreate(midi->client, CFSTR("HydraControl Input"),
                                     midi_read, midi, &midi->input);
        if (status == noErr)
            status = MIDIPortConnectSource(midi->input, midi->source, NULL);
    }
    /* Removal before monitoring was enabled need not have produced a callback. */
    SInt32 unique_id = 0;
    if (status == noErr &&
        (MIDIObjectGetIntegerProperty(midi->destination, kMIDIPropertyUniqueID,
                                       &unique_id) != noErr ||
         unique_id != midi->destination_unique_id || atomic_load(&midi->lost))) {
        status = -1;
    }
    if (status != noErr) {
        hydra_midi_stop_monitor(midi);
        return -1;
    }
    return 0;
}

void hydra_midi_stop_monitor(HydraMIDI *midi) {
    /* Quiesce both input and client-notification callbacks before releasing
     * the caller's context. Disposing only the input port is insufficient. */
    pthread_mutex_lock(&midi->callback_lock);
    atomic_store_explicit(&midi->monitoring, false, memory_order_release);
    pthread_mutex_unlock(&midi->callback_lock);
    if (midi->input) {
        if (midi->source) MIDIPortDisconnectSource(midi->input, midi->source);
        MIDIPortDispose(midi->input);
        midi->input = 0;
    }
    midi->source = 0;
}

void hydra_midi_close(HydraMIDI *midi) {
    if (!midi) return;
    hydra_midi_stop_monitor(midi);
    if (midi->output) MIDIPortDispose(midi->output);
    if (midi->client) MIDIClientDispose(midi->client);
    pthread_mutex_destroy(&midi->callback_lock);
    free(midi);
}

int hydra_midi_rescan(void) {
    OSStatus status = MIDIRestart();
    if (status != noErr) {
        fprintf(stderr, "error: restarting CoreMIDI failed (status %d)\n", (int)status);
        return -1;
    }
    return 0;
}

uint32_t hydra_random_uniform(uint32_t upper_bound) {
    return arc4random_uniform(upper_bound);
}

#elif defined(__linux__)
#include <alsa/asoundlib.h>
#include <alloca.h>
#include <poll.h>
#include <pthread.h>
#include <sys/random.h>
#include <unistd.h>

struct HydraMIDI {
    snd_seq_t *seq;
    int output;
    int input;
    snd_seq_addr_t destination;
    snd_seq_addr_t source;
    bool output_connected;
    bool source_connected;
    bool announce_connected;
    bool thread_started;
    pthread_mutex_t lock;
    pthread_t thread;
    atomic_bool monitoring;
    atomic_bool lost;
    HydraMIDIReceive receive;
    HydraMIDIDisconnect disconnect;
    void *context;
};

static HydraMIDIEndpoint endpoint_id(int client, int port) {
    return 1 + ((uint64_t)(unsigned)client << 8) + (unsigned)port;
}

static snd_seq_addr_t endpoint_address(HydraMIDIEndpoint endpoint) {
    endpoint--;
    return (snd_seq_addr_t){ .client = (unsigned char)(endpoint >> 8),
                             .port = (unsigned char)(endpoint & 255) };
}

static bool same_address(snd_seq_addr_t a, snd_seq_addr_t b) {
    return a.client == b.client && a.port == b.port;
}

static bool usable_port(const snd_seq_port_info_t *info, bool input) {
    unsigned caps = snd_seq_port_info_get_capability(info);
    unsigned required = input ? SND_SEQ_PORT_CAP_READ | SND_SEQ_PORT_CAP_SUBS_READ
                              : SND_SEQ_PORT_CAP_WRITE | SND_SEQ_PORT_CAP_SUBS_WRITE;
    return (caps & required) == required;
}

int hydra_midi_open(HydraMIDI **result) {
    *result = NULL;
    HydraMIDI *midi = calloc(1, sizeof(*midi));
    if (!midi) return -1;
    midi->input = midi->output = -1;
    pthread_mutex_init(&midi->lock, NULL);
    atomic_init(&midi->monitoring, false);
    atomic_init(&midi->lost, false);
    int status = snd_seq_open(&midi->seq, "default", SND_SEQ_OPEN_DUPLEX,
                              SND_SEQ_NONBLOCK);
    if (status < 0) {
        fprintf(stderr, "error: opening ALSA MIDI sequencer failed: %s; "
                "check /dev/snd/seq access and the snd_seq kernel module\n",
                snd_strerror(status));
        hydra_midi_close(midi);
        return -1;
    }
    snd_seq_set_client_name(midi->seq, "HydraControl");
    /* These private ports initiate their own subscriptions. Omitting SUBS_*
     * prevents other hydractl processes from mistaking them for instruments. */
    midi->output = snd_seq_create_simple_port(midi->seq, "HydraControl Output",
        SND_SEQ_PORT_CAP_READ | SND_SEQ_PORT_CAP_NO_EXPORT,
        SND_SEQ_PORT_TYPE_MIDI_GENERIC | SND_SEQ_PORT_TYPE_APPLICATION);
    midi->input = snd_seq_create_simple_port(midi->seq, "HydraControl Input",
        SND_SEQ_PORT_CAP_WRITE | SND_SEQ_PORT_CAP_NO_EXPORT,
        SND_SEQ_PORT_TYPE_MIDI_GENERIC | SND_SEQ_PORT_TYPE_APPLICATION);
    if (midi->output < 0 || midi->input < 0) {
        fputs("error: creating ALSA MIDI ports failed\n", stderr);
        hydra_midi_close(midi);
        return -1;
    }
    *result = midi;
    return 0;
}

void hydra_midi_endpoint_name(HydraMIDI *midi, HydraMIDIEndpoint endpoint,
                              char *name, size_t size) {
    snd_seq_addr_t address = endpoint_address(endpoint);
    snd_seq_client_info_t *client;
    snd_seq_port_info_t *port;
    snd_seq_client_info_alloca(&client);
    snd_seq_port_info_alloca(&port);
    pthread_mutex_lock(&midi->lock);
    if (snd_seq_get_any_client_info(midi->seq, address.client, client) >= 0 &&
        snd_seq_get_any_port_info(midi->seq, address.client, address.port, port) >= 0)
        snprintf(name, size, "%s: %s", snd_seq_client_info_get_name(client),
                 snd_seq_port_info_get_name(port));
    else snprintf(name, size, "ALSA MIDI %u:%u", address.client, address.port);
    pthread_mutex_unlock(&midi->lock);
}

int hydra_midi_enumerate(HydraMIDI *midi, bool input,
                         HydraMIDIEndpointInfo *entries, size_t capacity) {
    snd_seq_client_info_t *client;
    snd_seq_port_info_t *port;
    snd_seq_client_info_alloca(&client);
    snd_seq_port_info_alloca(&port);
    int count = 0;
    int result = 0;
    pthread_mutex_lock(&midi->lock);
    snd_seq_client_info_set_client(client, -1);
    while (snd_seq_query_next_client(midi->seq, client) >= 0) {
        int client_id = snd_seq_client_info_get_client(client);
        if (client_id == SND_SEQ_CLIENT_SYSTEM ||
            client_id == snd_seq_client_id(midi->seq)) continue;
        snd_seq_port_info_set_client(port, client_id);
        snd_seq_port_info_set_port(port, -1);
        while (snd_seq_query_next_port(midi->seq, port) >= 0) {
            if (!usable_port(port, input)) continue;
            if ((size_t)count == capacity) {
                fputs("error: too many ALSA MIDI ports to enumerate safely\n", stderr);
                result = -1;
                goto done;
            }
            int port_id = snd_seq_port_info_get_port(port);
            entries[count].id = endpoint_id(client_id, port_id);
            snprintf(entries[count].name, sizeof(entries[count].name), "%s: %s",
                     snd_seq_client_info_get_name(client), snd_seq_port_info_get_name(port));
            snprintf(entries[count].address, sizeof(entries[count].address),
                     "%d:%d", client_id, port_id);
            count++;
        }
    }
    result = count;
done:
    pthread_mutex_unlock(&midi->lock);
    return result;
}

bool hydra_midi_same_device(HydraMIDIEndpoint a, HydraMIDIEndpoint b) {
    return a && b && endpoint_address(a).client == endpoint_address(b).client;
}

int hydra_midi_select_output(HydraMIDI *midi, HydraMIDIEndpoint destination) {
    midi->destination = endpoint_address(destination);
    int status = snd_seq_connect_to(midi->seq, midi->output,
                                    midi->destination.client, midi->destination.port);
    if (status < 0) {
        fprintf(stderr, "error: connecting ALSA MIDI output failed: %s\n",
                snd_strerror(status));
        return -1;
    }
    midi->output_connected = true;
    return 0;
}

static void report_disconnect(HydraMIDI *midi) {
    if (!atomic_exchange(&midi->lost, true) &&
        atomic_load_explicit(&midi->monitoring, memory_order_acquire) &&
        midi->disconnect) midi->disconnect(midi->context);
}

/* Checking the subscription, then sending through it (never to an address)
 * prevents a hot-unplug followed by client-number reuse from redirecting notes. */
static bool output_subscription_alive(HydraMIDI *midi) {
    snd_seq_port_subscribe_t *subscription;
    snd_seq_port_subscribe_alloca(&subscription);
    snd_seq_addr_t sender = { .client = (unsigned char)snd_seq_client_id(midi->seq),
                              .port = (unsigned char)midi->output };
    snd_seq_port_subscribe_set_sender(subscription, &sender);
    snd_seq_port_subscribe_set_dest(subscription, &midi->destination);
    return snd_seq_get_port_subscription(midi->seq, subscription) >= 0;
}

int hydra_midi_send(HydraMIDI *midi, HydraMIDIEndpoint destination,
                    const uint8_t *bytes, size_t length) {
    bool cleanup = is_cleanup_message(bytes, length);
    if ((atomic_load(&midi->lost) && !cleanup) || !midi->output_connected ||
        !same_address(endpoint_address(destination), midi->destination)) return -1;
    snd_midi_event_t *encoder = NULL;
    int status = snd_midi_event_new(1024, &encoder);
    if (status < 0) return -1;
    pthread_mutex_lock(&midi->lock);
    bool alive = output_subscription_alive(midi);
    if (!alive) status = -ENODEV;
    size_t offset = 0;
    while (status >= 0 && offset < length) {
        if (atomic_load(&midi->lost) && !cleanup) { status = -ENODEV; break; }
        snd_seq_event_t event;
        snd_seq_ev_clear(&event);
        long consumed = snd_midi_event_encode(encoder, bytes + offset,
                                              (long)(length - offset), &event);
        if (consumed <= 0 || event.type == SND_SEQ_EVENT_NONE) {
            status = -EINVAL;
            break;
        }
        offset += (size_t)consumed;
        snd_seq_ev_set_source(&event, midi->output);
        snd_seq_ev_set_subs(&event);
        snd_seq_ev_set_direct(&event);
        status = snd_seq_event_output_direct(midi->seq, &event);
    }
    pthread_mutex_unlock(&midi->lock);
    snd_midi_event_free(encoder);
    if (!alive) report_disconnect(midi);
    if (status < 0) {
        fprintf(stderr, "error: sending ALSA MIDI failed: %s\n", snd_strerror(status));
        return -1;
    }
    return 0;
}

static bool target_removed(HydraMIDI *midi, const snd_seq_event_t *event) {
    if (event->source.client != SND_SEQ_CLIENT_SYSTEM) return false;
    if (event->type == SND_SEQ_EVENT_CLIENT_EXIT)
        return event->data.addr.client == midi->destination.client ||
            (midi->source_connected && event->data.addr.client == midi->source.client);
    if (event->type == SND_SEQ_EVENT_PORT_EXIT)
        return same_address(event->data.addr, midi->destination) ||
            (midi->source_connected && same_address(event->data.addr, midi->source));
    if (event->type == SND_SEQ_EVENT_PORT_UNSUBSCRIBED) {
        snd_seq_addr_t ours_out = { .client = (unsigned char)snd_seq_client_id(midi->seq),
                                    .port = (unsigned char)midi->output };
        snd_seq_addr_t ours_in = { .client = ours_out.client,
                                   .port = (unsigned char)midi->input };
        return (same_address(event->data.connect.sender, ours_out) &&
                same_address(event->data.connect.dest, midi->destination)) ||
            (midi->source_connected &&
             same_address(event->data.connect.sender, midi->source) &&
             same_address(event->data.connect.dest, ours_in));
    }
    return false;
}

static void *monitor_thread(void *opaque) {
    HydraMIDI *midi = opaque;
    snd_midi_event_t *decoder = NULL;
    if (snd_midi_event_new(4096, &decoder) < 0) {
        report_disconnect(midi);
        return NULL;
    }
    snd_midi_event_no_status(decoder, 1);
    int count = snd_seq_poll_descriptors_count(midi->seq, POLLIN);
    struct pollfd *fds = count > 0 ? calloc((size_t)count, sizeof(*fds)) : NULL;
    if (!fds) {
        snd_midi_event_free(decoder);
        report_disconnect(midi);
        return NULL;
    }
    snd_seq_poll_descriptors(midi->seq, fds, (unsigned)count, POLLIN);
    while (atomic_load_explicit(&midi->monitoring, memory_order_acquire)) {
        int ready = poll(fds, (nfds_t)count, 100);
        if (ready < 0 && errno == EINTR) continue;
        if (ready < 0) { report_disconnect(midi); break; }
        if (!ready) continue;
        bool failed = false;
        for (int i = 0; i < count; i++)
            if (fds[i].revents & (POLLERR | POLLHUP | POLLNVAL)) failed = true;
        if (failed) { report_disconnect(midi); break; }
        while (atomic_load_explicit(&midi->monitoring, memory_order_acquire)) {
            uint8_t bytes[4096];
            long length = 0;
            bool removed = false;
            snd_seq_event_t *event = NULL;
            pthread_mutex_lock(&midi->lock);
            int status = snd_seq_event_input(midi->seq, &event);
            if (status >= 0 && event) {
                removed = target_removed(midi, event);
                if (midi->source_connected && same_address(event->source, midi->source))
                    length = snd_midi_event_decode(decoder, bytes, sizeof(bytes), event);
                snd_seq_free_event(event);
            }
            pthread_mutex_unlock(&midi->lock);
            if (removed) { report_disconnect(midi); break; }
            if (status == -EAGAIN) break;
            if (status < 0) {
                /* An overrun loses panel changes; fail closed instead of silently
                 * disabling the human-takeover protection. */
                report_disconnect(midi);
                failed = true;
                break;
            }
            if (length > 0 && midi->receive)
                midi->receive(midi->context, bytes, (size_t)length);
        }
        if (failed || atomic_load(&midi->lost)) break;
    }
    free(fds);
    snd_midi_event_free(decoder);
    return NULL;
}

int hydra_midi_start_monitor(HydraMIDI *midi, HydraMIDIEndpoint source,
                             HydraMIDIReceive receive,
                             HydraMIDIDisconnect disconnect, void *context) {
    midi->receive = receive;
    midi->disconnect = disconnect;
    midi->context = context;
    int status = snd_seq_connect_from(midi->seq, midi->input,
                                      SND_SEQ_CLIENT_SYSTEM, SND_SEQ_PORT_SYSTEM_ANNOUNCE);
    if (status < 0) goto fail;
    midi->announce_connected = true;
    if (source) {
        midi->source = endpoint_address(source);
        status = snd_seq_connect_from(midi->seq, midi->input,
                                       midi->source.client, midi->source.port);
        if (status < 0) goto fail;
        midi->source_connected = true;
    }
    pthread_mutex_lock(&midi->lock);
    bool destination_alive = midi->output_connected && output_subscription_alive(midi);
    pthread_mutex_unlock(&midi->lock);
    if (!destination_alive) { status = -ENODEV; goto fail; }
    atomic_store_explicit(&midi->monitoring, true, memory_order_release);
    status = pthread_create(&midi->thread, NULL, monitor_thread, midi);
    if (status) { status = -status; goto fail; }
    midi->thread_started = true;
    return 0;
fail:
    fprintf(stderr, "warning: ALSA MIDI monitoring unavailable: %s\n", snd_strerror(status));
    hydra_midi_stop_monitor(midi);
    return -1;
}

void hydra_midi_stop_monitor(HydraMIDI *midi) {
    atomic_store_explicit(&midi->monitoring, false, memory_order_release);
    if (midi->thread_started) {
        pthread_join(midi->thread, NULL);
        midi->thread_started = false;
    }
    if (midi->source_connected) {
        snd_seq_disconnect_from(midi->seq, midi->input,
                                 midi->source.client, midi->source.port);
        midi->source_connected = false;
    }
    if (midi->announce_connected) {
        snd_seq_disconnect_from(midi->seq, midi->input,
                                 SND_SEQ_CLIENT_SYSTEM, SND_SEQ_PORT_SYSTEM_ANNOUNCE);
        midi->announce_connected = false;
    }
}

void hydra_midi_close(HydraMIDI *midi) {
    if (!midi) return;
    hydra_midi_stop_monitor(midi);
    if (midi->seq) snd_seq_close(midi->seq);
    pthread_mutex_destroy(&midi->lock);
    free(midi);
}

/* ALSA hot-plugs are immediate; enumerating a fresh client is the rescan. */
int hydra_midi_rescan(void) { return 0; }

uint32_t hydra_random_uniform(uint32_t upper_bound) {
    if (upper_bound < 2) return 0;
    uint32_t value;
    uint32_t threshold = (uint32_t)(-upper_bound) % upper_bound;
    do {
        size_t offset = 0;
        while (offset < sizeof(value)) {
            ssize_t count = getrandom((uint8_t *)&value + offset,
                                       sizeof(value) - offset, 0);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) {
                fputs("error: operating-system random source unavailable\n", stderr);
                exit(1);
            }
            offset += (size_t)count;
        }
    } while (value < threshold);
    return value % upper_bound;
}
#else
#error "hydra MIDI supports macOS and Linux"
#endif
