/* A disposable, virtual ALSA MIDI peer used only by test_native_linux.py. */
#define _POSIX_C_SOURCE 200809L
#include <alsa/asoundlib.h>
#include <errno.h>
#include <poll.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static double seconds(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (double)now.tv_sec + (double)now.tv_nsec / 1e9;
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    setvbuf(stdin, NULL, _IONBF, 0);
    snd_seq_t *seq = NULL;
    int result = snd_seq_open(&seq, "default", SND_SEQ_OPEN_DUPLEX, SND_SEQ_NONBLOCK);
    if (result < 0) {
        fprintf(stderr, "test peer: %s\n", snd_strerror(result));
        return 1;
    }
    char name[96];
    snprintf(name, sizeof(name), "Hydra Linux Test %ld", (long)getpid());
    snd_seq_set_client_name(seq, name);
    bool split = argc > 1 && strcmp(argv[1], "--split") == 0;
    unsigned caps = SND_SEQ_PORT_CAP_WRITE | SND_SEQ_PORT_CAP_SUBS_WRITE;
    if (!split) caps |= SND_SEQ_PORT_CAP_READ | SND_SEQ_PORT_CAP_SUBS_READ;
    int port = snd_seq_create_simple_port(seq, name, caps,
        SND_SEQ_PORT_TYPE_MIDI_GENERIC | SND_SEQ_PORT_TYPE_APPLICATION);
    if (port < 0) {
        fprintf(stderr, "test peer port: %s\n", snd_strerror(port));
        snd_seq_close(seq);
        return 1;
    }
    int source = port;
    if (split) {
        source = snd_seq_create_simple_port(seq, name,
            SND_SEQ_PORT_CAP_READ | SND_SEQ_PORT_CAP_SUBS_READ,
            SND_SEQ_PORT_TYPE_MIDI_GENERIC | SND_SEQ_PORT_TYPE_APPLICATION);
        if (source < 0) {
            fprintf(stderr, "test peer source: %s\n", snd_strerror(source));
            snd_seq_close(seq);
            return 1;
        }
    }
    snd_midi_event_t *encoder = NULL, *decoder = NULL;
    if (snd_midi_event_new(1024, &encoder) < 0 ||
        snd_midi_event_new(1024, &decoder) < 0) {
        fputs("test peer: cannot allocate MIDI converter\n", stderr);
        snd_seq_close(seq);
        return 1;
    }
    snd_midi_event_no_status(decoder, 1);
    printf("{\"type\":\"ready\",\"name\":\"%s\",\"address\":\"%d:%d\"}\n",
           name, snd_seq_client_id(seq), port);
    int count = snd_seq_poll_descriptors_count(seq, POLLIN);
    struct pollfd *polls = calloc((size_t)count + 1, sizeof(*polls));
    if (count < 0 || polls == NULL) return 1;
    polls[0].fd = STDIN_FILENO;
    polls[0].events = POLLIN;
    snd_seq_poll_descriptors(seq, polls + 1, (unsigned int)count, POLLIN);
    bool running = true;
    while (running) {
        if (poll(polls, (nfds_t)count + 1, -1) < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (polls[0].revents & POLLIN) {
            char line[1024];
            if (fgets(line, sizeof(line), stdin) == NULL) break;
            if (strncmp(line, "quit", 4) == 0) break;
            if (strncmp(line, "disconnect-input", 16) == 0) {
                result = snd_seq_delete_simple_port(seq, source);
                printf("{\"type\":\"input_disconnected\",\"ok\":%s}\n", result >= 0 ? "true" : "false");
                if (source == port) port = -1;
                source = -1;
            } else if (strncmp(line, "disconnect", 10) == 0) {
                result = snd_seq_delete_simple_port(seq, port);
                printf("{\"type\":\"disconnected\",\"ok\":%s}\n", result >= 0 ? "true" : "false");
                if (source == port) source = -1;
                port = -1;
            } else if (strncmp(line, "send ", 5) == 0) {
                unsigned char bytes[256];
                size_t length = 0;
                char *cursor = line + 5;
                while (*cursor && length < sizeof(bytes)) {
                    char *end;
                    long value = strtol(cursor, &end, 16);
                    if (end == cursor) break;
                    if (value < 0 || value > 255) return 2;
                    bytes[length++] = (unsigned char)value;
                    cursor = end;
                }
                snd_seq_event_t event;
                snd_seq_ev_clear(&event);
                snd_midi_event_reset_encode(encoder);
                long consumed = snd_midi_event_encode(encoder, bytes, (long)length, &event);
                result = -EINVAL;
                if (source >= 0 && consumed == (long)length && event.type != SND_SEQ_EVENT_NONE) {
                    snd_seq_ev_set_source(&event, source);
                    snd_seq_ev_set_subs(&event);
                    snd_seq_ev_set_direct(&event);
                    result = snd_seq_event_output_direct(seq, &event);
                }
                printf("{\"type\":\"sent\",\"ok\":%s}\n", result >= 0 ? "true" : "false");
            }
        }
        if (polls[0].revents & (POLLHUP | POLLERR)) running = false;
        snd_seq_event_t *event = NULL;
        while (snd_seq_event_input(seq, &event) >= 0) {
            unsigned char bytes[1024];
            long length = snd_midi_event_decode(decoder, bytes, sizeof(bytes), event);
            if (length > 0) {
                printf("{\"type\":\"midi\",\"time\":%.9f,\"bytes\":[", seconds());
                for (long i = 0; i < length; ++i) printf("%s%u", i == 0 ? "" : ",", bytes[i]);
                puts("]}");
            }
            snd_seq_free_event(event);
        }
    }
    free(polls);
    snd_midi_event_free(encoder);
    snd_midi_event_free(decoder);
    snd_seq_close(seq);
    return 0;
}
