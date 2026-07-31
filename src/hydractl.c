#include <CoreFoundation/CoreFoundation.h>
#include <CoreMIDI/CoreMIDI.h>

#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define MAX_POSITIONALS 128
#define MAX_NAME 512
#define MAX_JSON_LINE 16384
#define MIDI_INPUT_RING_CAPACITY 1024
#define MAX_TRACKED_NRPN 512
#define MAX_SCHEDULED_EVENTS 4096
#define MAX_SCHEDULED_JOBS 256
#define MAX_CHORD_NOTES 16
#define NOTIFICATION_QUEUE_CAPACITY 1024
#define MAX_NOTIFICATION_LINE 512

typedef struct {
    const char *device;
    int channel;
    int velocity;
    double duration;
    double step;
    double gate;
    double takeover;
    bool randomize_patches;
    bool monitor_input;
    const char *positionals[MAX_POSITIONALS];
    int positional_count;
} Options;

typedef struct {
    const char *name;
    int cc;
} TimbreControl;

typedef struct {
    const char *name;
    int cc;
    int minimum;
    int maximum;
} RandomControl;

typedef struct {
    char bank;
    int patch;
} RandomPatch;

typedef struct {
    bool known;
    int value;
    double updated_at;
    double user_updated_at;
    double agent_updated_at;
    int agent_value;
    const char *source;
} CCState;

typedef struct {
    uint8_t status;
    uint8_t data1;
    uint8_t data2;
} IncomingMIDI;

typedef struct {
    bool selected;
    int parameter_msb;
    int parameter_lsb;
    int data_msb;
    int data_lsb;
    bool possible_agent_echo;
} IncomingNRPN;

typedef struct {
    bool used;
    int channel;
    int parameter;
    int value;
    int resolution_bits;
    double updated_at;
    double user_updated_at;
    double agent_updated_at;
    int agent_value;
    const char *source;
} NRPNState;

typedef enum {
    SCHEDULED_NOTE_ON,
    SCHEDULED_NOTE_OFF,
    SCHEDULED_CC,
} ScheduledEventKind;

typedef struct {
    bool used;
    bool armed;
    double due_at;
    uint64_t job_id;
    ScheduledEventKind kind;
    int channel;
    int data1;
    int data2;
    bool force;
} ScheduledEvent;

typedef struct {
    bool used;
    uint64_t id;
    int pending_events;
    int in_flight_events;
    bool cancel_requested;
    bool failed;
    int blocked_events;
    int sent_events;
    const char *kind;
} ScheduledJob;

typedef enum {
    CANCEL_JOB_OK,
    CANCEL_JOB_NOT_FOUND,
    CANCEL_JOB_IN_FLIGHT,
    CANCEL_JOB_ACTIVE_NOTES,
} CancelJobStatus;

typedef struct {
    uint64_t id;
    char kind[16];
    int removed_events;
    int sent_events;
    int blocked_events;
} CanceledJob;

typedef struct {
    MIDIClientRef client;
    MIDIPortRef output_port;
    MIDIPortRef input_port;
    MIDIEndpointRef destination;
    MIDIEndpointRef source;
    int default_channel;
    double takeover_seconds;
    double started_at;
    pthread_mutex_t output_lock;
    pthread_mutex_t state_lock;
    pthread_mutex_t midi_lock;
    pthread_mutex_t scheduler_lock;
    pthread_cond_t scheduler_condition;
    bool scheduler_running;
    bool scheduler_available;
    pthread_t scheduler_thread;
    ScheduledEvent scheduled_events[MAX_SCHEDULED_EVENTS];
    ScheduledJob scheduled_jobs[MAX_SCHEDULED_JOBS];
    uint64_t next_job_id;
    pthread_mutex_t notification_lock;
    pthread_cond_t notification_condition;
    bool notification_running;
    bool notification_available;
    pthread_t notification_thread;
    char notifications[NOTIFICATION_QUEUE_CAPACITY][MAX_NOTIFICATION_LINE];
    size_t notification_read;
    size_t notification_write;
    size_t notification_count;
    uint64_t notification_dropped;
    uint64_t notification_sequence;
    CCState cc[16][128];
    IncomingNRPN incoming_nrpn[16];
    NRPNState nrpn[MAX_TRACKED_NRPN];
    size_t nrpn_count;
    uint16_t active_notes[16][128];
    bool patch_known;
    int patch_bank;
    int patch_number;
    int incoming_bank_lsb[16];
    uint8_t running_status;
    uint8_t incoming_data[2];
    int incoming_data_count;
    bool in_sysex;
    IncomingMIDI incoming_ring[MIDI_INPUT_RING_CAPACITY];
    atomic_uint incoming_write;
    atomic_uint incoming_read;
    atomic_uint incoming_dropped;
    atomic_bool input_consumer_running;
    atomic_bool protocol_ready;
    pthread_t input_consumer_thread;
} ServerContext;

static const TimbreControl TIMBRE_CONTROLS[] = {
    {"cutoff", 74},
    {"delay-feedback", 14},
    {"delay-mix", 92},
    {"delay-time", 15},
    {"env-attack", 81},
    {"env-decay", 82},
    {"env-release", 84},
    {"env-sustain", 83},
    {"filter1-cutoff", 74},
    {"filter1-drive", 50},
    {"filter1-resonance", 71},
    {"filter2-cutoff", 55},
    {"filter2-resonance", 56},
    {"macro1", 16},
    {"macro2", 17},
    {"macro3", 18},
    {"macro4", 19},
    {"macro5", 20},
    {"macro6", 21},
    {"macro7", 22},
    {"macro8", 23},
    {"noise-level", 3},
    {"osc1-level", 44},
    {"osc2-level", 46},
    {"osc3-level", 48},
    {"resonance", 71},
    {"reverb-mix", 93},
    {"reverb-time", 65},
    {"reverb-tone", 67},
    {"ringmod-level", 9},
};

static const RandomControl RANDOM_CONTROLS[] = {
    {"filter1-cutoff", 74, 20, 120},
    {"filter1-resonance", 71, 0, 88},
    {"filter1-drive", 50, 0, 64},
    {"filter2-cutoff", 55, 24, 120},
    {"filter2-resonance", 56, 0, 76},
    {"env-attack", 81, 0, 52},
    {"env-decay", 82, 8, 108},
    {"env-release", 84, 8, 108},
    {"delay-feedback", 14, 4, 84},
    {"delay-time", 15, 8, 120},
    {"delay-mix", 92, 0, 64},
    {"reverb-time", 65, 20, 112},
    {"reverb-tone", 67, 16, 112},
    {"reverb-mix", 93, 0, 68},
    {"macro1", 16, 0, 127},
    {"macro2", 17, 0, 127},
    {"macro3", 18, 0, 127},
    {"macro4", 19, 0, 127},
};

static const RandomPatch RANDOM_PATCHES[] = {
    {'A', 1},
    {'A', 2},
    {'A', 11},
    {'A', 17},
    {'A', 21},
    {'A', 33},
    {'A', 36},
};

static const char *USAGE =
    "hydractl - control an ASM Hydrasynth over macOS CoreMIDI\n"
    "\n"
    "USAGE\n"
    "  hydractl list\n"
    "  hydractl rescan\n"
    "  hydractl note NOTE [--velocity N] [--duration S] [--channel N]\n"
    "  hydractl sequence NOTE... [--step S] [--gate 0...1]\n"
    "  hydractl timbre NAME 0...1\n"
    "  hydractl timbre list\n"
    "  hydractl randomize --duration S [--step S] [--patches]\n"
    "  hydractl serve [--device TEXT] [--channel N] [--takeover S] [--no-input]\n"
    "  hydractl cc NUMBER VALUE\n"
    "  hydractl nrpn PARAMETER VALUE\n"
    "  hydractl bend -1...1\n"
    "  hydractl patch BANK 1...128\n"
    "  hydractl program 0...127\n"
    "  hydractl panic\n"
    "\n"
    "All sending commands accept --device TEXT and --channel 1...16.\n";

static volatile sig_atomic_t SERVER_STOP_REQUESTED = 0;

static bool parse_long(const char *text, long *value) {
    char *end = NULL;
    errno = 0;
    long parsed = strtol(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0') {
        return false;
    }
    *value = parsed;
    return true;
}

static bool parse_double_value(const char *text, double *value) {
    char *end = NULL;
    errno = 0;
    double parsed = strtod(text, &end);
    if (errno != 0 || end == text || *end != '\0' || !isfinite(parsed)) {
        return false;
    }
    *value = parsed;
    return true;
}

static int parse_note(const char *text, int *note) {
    long numeric;
    if (parse_long(text, &numeric)) {
        if (numeric < 0 || numeric > 127) {
            return -1;
        }
        *note = (int)numeric;
        return 0;
    }

    size_t length = strlen(text);
    if (length < 2 || length > 4) {
        return -1;
    }

    char letter = (char)toupper((unsigned char)text[0]);
    const char *letters = "C D EF G A B";
    int semitone = -1;
    for (int index = 0; index < 12; index++) {
        if (letters[index] == letter) {
            semitone = index;
            break;
        }
    }
    if (semitone < 0) {
        return -1;
    }

    const char *cursor = text + 1;
    if (*cursor == '#') {
        semitone++;
        cursor++;
    } else if (*cursor == 'b') {
        semitone--;
        cursor++;
    }

    long octave;
    if (!parse_long(cursor, &octave) || octave < -1 || octave > 9) {
        return -1;
    }
    int value = ((int)octave + 1) * 12 + semitone;
    if (value < 0 || value > 127) {
        return -1;
    }
    *note = value;
    return 0;
}

static int status_byte(int base, int channel, uint8_t *status) {
    if (channel < 1 || channel > 16) {
        fprintf(stderr, "error: MIDI channel must be 1...16, got %d\n", channel);
        return -1;
    }
    *status = (uint8_t)(base | (channel - 1));
    return 0;
}

static int validate_7bit(const char *label, int value) {
    if (value < 0 || value > 127) {
        fprintf(stderr, "error: %s must be 0...127, got %d\n", label, value);
        return -1;
    }
    return 0;
}

static int validate_14bit(const char *label, int value) {
    if (value < 0 || value > 16383) {
        fprintf(stderr, "error: %s must be 0...16383, got %d\n", label, value);
        return -1;
    }
    return 0;
}

static void destination_name(MIDIEndpointRef endpoint, char *buffer, size_t size) {
    CFStringRef name = NULL;
    OSStatus status = MIDIObjectGetStringProperty(
        endpoint, kMIDIPropertyDisplayName, &name
    );
    if (status == noErr && name != NULL) {
        if (CFStringGetCString(name, buffer, (CFIndex)size, kCFStringEncodingUTF8)) {
            CFRelease(name);
            return;
        }
        CFRelease(name);
    }
    snprintf(buffer, size, "MIDI destination %u", endpoint);
}

static bool contains_case_insensitive(const char *text, const char *query) {
    size_t query_length = strlen(query);
    if (query_length == 0) {
        return true;
    }
    for (; *text != '\0'; text++) {
        size_t index = 0;
        while (
            index < query_length &&
            text[index] != '\0' &&
            tolower((unsigned char)text[index]) ==
                tolower((unsigned char)query[index])
        ) {
            index++;
        }
        if (index == query_length) {
            return true;
        }
    }
    return false;
}

static int create_midi_client(MIDIClientRef *client) {
    *client = 0;
    OSStatus status = MIDIClientCreate(CFSTR("HydraControl"), NULL, NULL, client);
    if (status != noErr) {
        fprintf(
            stderr, "error: connecting to CoreMIDI failed (status %d)\n", status
        );
        return -1;
    }
    return 0;
}

static int list_destinations(void) {
    MIDIClientRef client;
    if (create_midi_client(&client) != 0) {
        return 1;
    }
    ItemCount destination_count = MIDIGetNumberOfDestinations();
    puts("Outputs (commands sent to the synth):");
    if (destination_count == 0) {
        puts("  none");
    }
    for (ItemCount index = 0; index < destination_count; index++) {
        char name[MAX_NAME];
        destination_name(MIDIGetDestination(index), name, sizeof(name));
        printf("  [%lu] %s\n", (unsigned long)index, name);
    }

    ItemCount source_count = MIDIGetNumberOfSources();
    puts("Inputs (keyboard and panel changes from the synth):");
    if (source_count == 0) {
        puts("  none");
    }
    for (ItemCount index = 0; index < source_count; index++) {
        char name[MAX_NAME];
        destination_name(MIDIGetSource(index), name, sizeof(name));
        printf("  [%lu] %s\n", (unsigned long)index, name);
    }
    MIDIClientDispose(client);
    return 0;
}

static MIDIEndpointRef find_destination(const char *query) {
    ItemCount count = MIDIGetNumberOfDestinations();
    for (ItemCount index = 0; index < count; index++) {
        MIDIEndpointRef endpoint = MIDIGetDestination(index);
        char name[MAX_NAME];
        destination_name(endpoint, name, sizeof(name));
        if (
            (query != NULL && contains_case_insensitive(name, query)) ||
            (query == NULL && contains_case_insensitive(name, "hydra"))
        ) {
            return endpoint;
        }
    }
    return 0;
}

static MIDIEndpointRef find_source(const char *query) {
    ItemCount count = MIDIGetNumberOfSources();
    for (ItemCount index = 0; index < count; index++) {
        MIDIEndpointRef endpoint = MIDIGetSource(index);
        char name[MAX_NAME];
        destination_name(endpoint, name, sizeof(name));
        if (
            (query != NULL && contains_case_insensitive(name, query)) ||
            (query == NULL && contains_case_insensitive(name, "hydra"))
        ) {
            return endpoint;
        }
    }
    return 0;
}

static int send_bytes(
    MIDIPortRef port,
    MIDIEndpointRef destination,
    const uint8_t *message,
    size_t length
) {
    union {
        MIDIPacketList alignment;
        uint8_t bytes[1024];
    } storage;
    MIDIPacketList *list = (MIDIPacketList *)storage.bytes;
    MIDIPacket *packet = MIDIPacketListInit(list);
    packet = MIDIPacketListAdd(
        list, sizeof(storage.bytes), packet, 0, length, message
    );
    if (packet == NULL) {
        fputs("error: MIDI packet is too large\n", stderr);
        return -1;
    }
    OSStatus status = MIDISend(port, destination, list);
    if (status != noErr) {
        fprintf(stderr, "error: sending MIDI failed (status %d)\n", status);
        return -1;
    }
    return 0;
}

static int encode_three(
    int base,
    int data1,
    int data2,
    int channel,
    uint8_t message[3]
) {
    uint8_t status;
    if (
        status_byte(base, channel, &status) != 0 ||
        validate_7bit("MIDI data byte", data1) != 0 ||
        validate_7bit("MIDI data byte", data2) != 0
    ) {
        return -1;
    }
    message[0] = status;
    message[1] = (uint8_t)data1;
    message[2] = (uint8_t)data2;
    return 0;
}

static int send_three(
    MIDIPortRef port,
    MIDIEndpointRef destination,
    int base,
    int data1,
    int data2,
    int channel
) {
    uint8_t message[3];
    if (encode_three(base, data1, data2, channel, message) != 0) {
        return -1;
    }
    return send_bytes(port, destination, message, sizeof(message));
}

static int send_cc(
    MIDIPortRef port,
    MIDIEndpointRef destination,
    int cc,
    int value,
    int channel
) {
    if (
        validate_7bit("CC number", cc) != 0 ||
        validate_7bit("CC value", value) != 0
    ) {
        return -1;
    }
    return send_three(port, destination, 0xB0, cc, value, channel);
}

static int encode_nrpn(
    int parameter,
    int value,
    int channel,
    uint8_t bytes[12]
) {
    if (
        validate_14bit("NRPN parameter", parameter) != 0 ||
        validate_14bit("NRPN value", value) != 0
    ) {
        return -1;
    }
    int controllers[] = {99, 98, 6, 38};
    int values[] = {
        (parameter >> 7) & 0x7F,
        parameter & 0x7F,
        (value >> 7) & 0x7F,
        value & 0x7F,
    };
    for (size_t index = 0;
         index < sizeof(controllers) / sizeof(controllers[0]);
         index++) {
        if (encode_three(
            0xB0, controllers[index], values[index], channel,
            &bytes[index * 3]
        ) != 0) {
            return -1;
        }
    }
    return 0;
}

static int send_nrpn(
    MIDIPortRef port,
    MIDIEndpointRef destination,
    int parameter,
    int value,
    int channel
) {
    uint8_t bytes[12];
    if (encode_nrpn(parameter, value, channel, bytes) != 0) {
        return -1;
    }
    return send_bytes(port, destination, bytes, sizeof(bytes));
}

static void sleep_seconds(double seconds) {
    if (seconds <= 0) {
        return;
    }
    struct timespec delay = {
        .tv_sec = (time_t)seconds,
        .tv_nsec = (long)((seconds - floor(seconds)) * 1000000000.0),
    };
    while (nanosleep(&delay, &delay) == -1 && errno == EINTR) {
    }
}

static double monotonic_seconds(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (double)now.tv_sec + (double)now.tv_nsec / 1000000000.0;
}

static const char *option_value(int argc, char **argv, int *index) {
    if (*index + 1 >= argc) {
        fprintf(stderr, "error: missing value after %s\n", argv[*index]);
        return NULL;
    }
    (*index)++;
    return argv[*index];
}

static int parse_options(int argc, char **argv, Options *options) {
    *options = (Options){
        .channel = 1,
        .velocity = 100,
        .duration = 1.0,
        .step = 0.4,
        .gate = 0.8,
        .takeover = 3.0,
        .monitor_input = true,
    };

    for (int index = 0; index < argc; index++) {
        const char *argument = argv[index];
        const char *value = NULL;
        long integer;
        double number;

        if (strcmp(argument, "--device") == 0) {
            value = option_value(argc, argv, &index);
            if (value == NULL) return -1;
            options->device = value;
        } else if (strcmp(argument, "--channel") == 0) {
            value = option_value(argc, argv, &index);
            if (value == NULL || !parse_long(value, &integer)) return -1;
            options->channel = (int)integer;
        } else if (strcmp(argument, "--velocity") == 0) {
            value = option_value(argc, argv, &index);
            if (value == NULL || !parse_long(value, &integer)) return -1;
            options->velocity = (int)integer;
        } else if (strcmp(argument, "--duration") == 0) {
            value = option_value(argc, argv, &index);
            if (value == NULL || !parse_double_value(value, &number)) return -1;
            options->duration = number;
        } else if (strcmp(argument, "--step") == 0) {
            value = option_value(argc, argv, &index);
            if (value == NULL || !parse_double_value(value, &number)) return -1;
            options->step = number;
        } else if (strcmp(argument, "--gate") == 0) {
            value = option_value(argc, argv, &index);
            if (value == NULL || !parse_double_value(value, &number)) return -1;
            options->gate = number;
        } else if (strcmp(argument, "--takeover") == 0) {
            value = option_value(argc, argv, &index);
            if (value == NULL || !parse_double_value(value, &number)) return -1;
            options->takeover = number;
        } else if (strcmp(argument, "--no-input") == 0) {
            options->monitor_input = false;
        } else if (strcmp(argument, "--patches") == 0) {
            options->randomize_patches = true;
        } else if (strncmp(argument, "--", 2) == 0) {
            fprintf(stderr, "error: unknown option %s\n", argument);
            return -1;
        } else {
            if (options->positional_count >= MAX_POSITIONALS) {
                fputs("error: too many arguments\n", stderr);
                return -1;
            }
            options->positionals[options->positional_count++] = argument;
        }
    }
    if (options->channel < 1 || options->channel > 16) {
        fprintf(
            stderr, "error: MIDI channel must be 1...16, got %d\n",
            options->channel
        );
        return -1;
    }
    if (options->takeover < 0 || options->takeover > 3600) {
        fprintf(
            stderr, "error: --takeover must be 0...3600 seconds, got %.3f\n",
            options->takeover
        );
        return -1;
    }
    return 0;
}

static bool valid_note_velocity(int velocity) {
    return velocity >= 1 && velocity <= 127;
}

static bool valid_positive_seconds(double seconds) {
    return isfinite(seconds) && seconds > 0;
}

static int find_timbre_cc(const char *name) {
    size_t count = sizeof(TIMBRE_CONTROLS) / sizeof(TIMBRE_CONTROLS[0]);
    for (size_t index = 0; index < count; index++) {
        if (strcmp(TIMBRE_CONTROLS[index].name, name) == 0) {
            return TIMBRE_CONTROLS[index].cc;
        }
    }
    return -1;
}

static int parse_bank(const char *text, int *bank) {
    if (strlen(text) == 1) {
        char letter = (char)toupper((unsigned char)text[0]);
        if (letter >= 'A' && letter <= 'H') {
            *bank = letter - 'A';
            return 0;
        }
    }
    long number;
    if (parse_long(text, &number) && number >= 1 && number <= 8) {
        *bank = (int)number - 1;
        return 0;
    }
    return -1;
}

static int encode_program(
    int program,
    int channel,
    uint8_t message[2]
) {
    uint8_t status;
    if (
        validate_7bit("Program", program) != 0 ||
        status_byte(0xC0, channel, &status) != 0
    ) {
        return -1;
    }
    message[0] = status;
    message[1] = (uint8_t)program;
    return 0;
}

static int send_program(
    MIDIPortRef port,
    MIDIEndpointRef destination,
    int program,
    int channel
) {
    uint8_t message[2];
    if (encode_program(program, channel, message) != 0) {
        return -1;
    }
    return send_bytes(port, destination, message, sizeof(message));
}

static const char *skip_json_space(const char *cursor) {
    while (*cursor != '\0' && isspace((unsigned char)*cursor)) {
        cursor++;
    }
    return cursor;
}

/*
 * This is deliberately a small command-protocol parser rather than a general
 * JSON implementation. It locates top-level string keys and accepts the scalar
 * values used by hydractl's JSON-lines API.
 */
static const char *json_find_value(const char *json, const char *key) {
    const char *cursor = skip_json_space(json);
    if (*cursor != '{') {
        return NULL;
    }
    cursor++;
    while (*cursor != '\0') {
        cursor = skip_json_space(cursor);
        if (*cursor == '}') {
            return NULL;
        }
        if (*cursor != '"') {
            return NULL;
        }
        cursor++;
        const char *key_start = cursor;
        bool escaped = false;
        while (*cursor != '\0') {
            if (!escaped && *cursor == '"') break;
            if (!escaped && *cursor == '\\') {
                escaped = true;
            } else {
                escaped = false;
            }
            cursor++;
        }
        if (*cursor != '"') {
            return NULL;
        }
        size_t key_length = (size_t)(cursor - key_start);
        bool matches =
            memchr(key_start, '\\', key_length) == NULL &&
            strlen(key) == key_length &&
            strncmp(key_start, key, key_length) == 0;
        cursor = skip_json_space(cursor + 1);
        if (*cursor != ':') {
            return NULL;
        }
        cursor = skip_json_space(cursor + 1);
        if (matches) {
            return cursor;
        }

        int depth = 0;
        bool in_string = false;
        escaped = false;
        while (*cursor != '\0') {
            char character = *cursor;
            if (in_string) {
                if (!escaped && character == '"') {
                    in_string = false;
                }
                if (!escaped && character == '\\') {
                    escaped = true;
                } else {
                    escaped = false;
                }
            } else if (character == '"') {
                in_string = true;
            } else if (character == '{' || character == '[') {
                depth++;
            } else if (character == '}' || character == ']') {
                if (depth == 0) {
                    return NULL;
                }
                depth--;
            } else if (character == ',' && depth == 0) {
                cursor++;
                break;
            }
            cursor++;
        }
    }
    return NULL;
}

static bool json_get_string(
    const char *json,
    const char *key,
    char *buffer,
    size_t size
) {
    const char *cursor = json_find_value(json, key);
    if (cursor == NULL || *cursor != '"' || size == 0) {
        return false;
    }
    cursor++;
    size_t used = 0;
    while (*cursor != '\0' && *cursor != '"') {
        unsigned char character = (unsigned char)*cursor++;
        if (character < 0x20) {
            return false;
        }
        if (character == '\\') {
            character = (unsigned char)*cursor++;
            switch (character) {
                case '"':
                case '\\':
                case '/':
                    break;
                case 'b':
                    character = '\b';
                    break;
                case 'f':
                    character = '\f';
                    break;
                case 'n':
                    character = '\n';
                    break;
                case 'r':
                    character = '\r';
                    break;
                case 't':
                    character = '\t';
                    break;
                default:
                    return false;
            }
        }
        if (used + 1 >= size) {
            return false;
        }
        buffer[used++] = (char)character;
    }
    if (*cursor != '"') {
        return false;
    }
    buffer[used] = '\0';
    return true;
}

static bool json_get_long(const char *json, const char *key, long *value) {
    const char *cursor = json_find_value(json, key);
    if (cursor == NULL) {
        return false;
    }
    const char *number_start = cursor;
    if (*cursor == '-') {
        cursor++;
    }
    if (!isdigit((unsigned char)*cursor)) {
        return false;
    }
    if (*cursor == '0') {
        cursor++;
        if (isdigit((unsigned char)*cursor)) {
            return false;
        }
    } else {
        while (isdigit((unsigned char)*cursor)) {
            cursor++;
        }
    }
    if (!(*cursor == ',' || *cursor == '}' || isspace((unsigned char)*cursor))) {
        return false;
    }
    char *end = NULL;
    errno = 0;
    long parsed = strtol(number_start, &end, 10);
    if (errno != 0 || end != cursor) {
        return false;
    }
    *value = parsed;
    return true;
}

static bool json_get_uint64(
    const char *json,
    const char *key,
    uint64_t *value
) {
    const char *cursor = json_find_value(json, key);
    if (cursor == NULL || !isdigit((unsigned char)*cursor)) {
        return false;
    }
    const char *number_start = cursor;
    if (*cursor == '0') {
        cursor++;
        if (isdigit((unsigned char)*cursor)) {
            return false;
        }
    } else {
        while (isdigit((unsigned char)*cursor)) {
            cursor++;
        }
    }
    if (!(*cursor == ',' || *cursor == '}' || isspace((unsigned char)*cursor))) {
        return false;
    }
    char *end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(number_start, &end, 10);
    uint64_t converted = (uint64_t)parsed;
    if (
        errno != 0 || end != cursor ||
        (unsigned long long)converted != parsed
    ) {
        return false;
    }
    *value = converted;
    return true;
}

static bool json_get_double(
    const char *json,
    const char *key,
    double *value
) {
    const char *cursor = json_find_value(json, key);
    if (cursor == NULL) {
        return false;
    }
    char *end = NULL;
    errno = 0;
    double parsed = strtod(cursor, &end);
    if (
        errno != 0 || end == cursor || !isfinite(parsed) ||
        !(*end == ',' || *end == '}' || isspace((unsigned char)*end))
    ) {
        return false;
    }
    *value = parsed;
    return true;
}

static bool json_get_bool(const char *json, const char *key, bool *value) {
    const char *cursor = json_find_value(json, key);
    if (cursor == NULL) {
        return false;
    }
    if (
        strncmp(cursor, "true", 4) == 0 &&
        (cursor[4] == ',' || cursor[4] == '}' ||
         isspace((unsigned char)cursor[4]))
    ) {
        *value = true;
        return true;
    }
    if (
        strncmp(cursor, "false", 5) == 0 &&
        (cursor[5] == ',' || cursor[5] == '}' ||
         isspace((unsigned char)cursor[5]))
    ) {
        *value = false;
        return true;
    }
    return false;
}

static bool json_has_key(const char *json, const char *key) {
    return json_find_value(json, key) != NULL;
}

static const char *json_parse_value_token(const char *cursor, int depth);

static const char *json_parse_string_token(const char *cursor) {
    if (*cursor != '"') {
        return NULL;
    }
    cursor++;
    while (*cursor != '\0') {
        unsigned char character = (unsigned char)*cursor++;
        if (character == '"') {
            return cursor;
        }
        if (character < 0x20) {
            return NULL;
        }
        if (character == '\\') {
            char escape = *cursor++;
            if (escape == '\0') {
                return NULL;
            }
            if (strchr("\"\\/bfnrt", escape) != NULL) {
                continue;
            }
            if (escape != 'u') {
                return NULL;
            }
            for (int index = 0; index < 4; index++) {
                if (
                    *cursor == '\0' ||
                    !isxdigit((unsigned char)*cursor)
                ) {
                    return NULL;
                }
                cursor++;
            }
        }
    }
    return NULL;
}

static const char *json_parse_number_token(const char *cursor) {
    if (*cursor == '-') cursor++;
    if (*cursor == '0') {
        cursor++;
    } else {
        if (*cursor < '1' || *cursor > '9') return NULL;
        while (isdigit((unsigned char)*cursor)) cursor++;
    }
    if (*cursor == '.') {
        cursor++;
        if (!isdigit((unsigned char)*cursor)) return NULL;
        while (isdigit((unsigned char)*cursor)) cursor++;
    }
    if (*cursor == 'e' || *cursor == 'E') {
        cursor++;
        if (*cursor == '+' || *cursor == '-') cursor++;
        if (!isdigit((unsigned char)*cursor)) return NULL;
        while (isdigit((unsigned char)*cursor)) cursor++;
    }
    return cursor;
}

static const char *json_parse_object_token(const char *cursor, int depth) {
    if (*cursor != '{' || depth >= 64) return NULL;
    cursor = skip_json_space(cursor + 1);
    if (*cursor == '}') return cursor + 1;
    while (*cursor != '\0') {
        cursor = json_parse_string_token(cursor);
        if (cursor == NULL) return NULL;
        cursor = skip_json_space(cursor);
        if (*cursor != ':') return NULL;
        cursor = json_parse_value_token(cursor + 1, depth + 1);
        if (cursor == NULL) return NULL;
        cursor = skip_json_space(cursor);
        if (*cursor == '}') return cursor + 1;
        if (*cursor != ',') return NULL;
        cursor = skip_json_space(cursor + 1);
    }
    return NULL;
}

static const char *json_parse_array_token(const char *cursor, int depth) {
    if (*cursor != '[' || depth >= 64) return NULL;
    cursor = skip_json_space(cursor + 1);
    if (*cursor == ']') return cursor + 1;
    while (*cursor != '\0') {
        cursor = json_parse_value_token(cursor, depth + 1);
        if (cursor == NULL) return NULL;
        cursor = skip_json_space(cursor);
        if (*cursor == ']') return cursor + 1;
        if (*cursor != ',') return NULL;
        cursor = skip_json_space(cursor + 1);
    }
    return NULL;
}

static const char *json_parse_value_token(const char *cursor, int depth) {
    cursor = skip_json_space(cursor);
    if (*cursor == '"') return json_parse_string_token(cursor);
    if (*cursor == '{') return json_parse_object_token(cursor, depth);
    if (*cursor == '[') return json_parse_array_token(cursor, depth);
    if (strncmp(cursor, "true", 4) == 0) return cursor + 4;
    if (strncmp(cursor, "false", 5) == 0) return cursor + 5;
    if (strncmp(cursor, "null", 4) == 0) return cursor + 4;
    if (*cursor == '-' || isdigit((unsigned char)*cursor)) {
        return json_parse_number_token(cursor);
    }
    return NULL;
}

static bool json_is_complete_object(const char *json) {
    const char *cursor = skip_json_space(json);
    if (*cursor != '{') return false;
    cursor = json_parse_object_token(cursor, 0);
    return cursor != NULL && *skip_json_space(cursor) == '\0';
}

static void json_escape(
    const char *input,
    char *buffer,
    size_t size
);

static void json_id_fragment(
    const char *json,
    char *buffer,
    size_t size
) {
    const char *cursor = json_find_value(json, "id");
    if (cursor == NULL || size < 5) {
        snprintf(buffer, size, "null");
        return;
    }
    if (*cursor == '"') {
        const char *end = json_parse_string_token(cursor);
        if (end != NULL && (size_t)(end - cursor) < size) {
            size_t length = (size_t)(end - cursor);
            memcpy(buffer, cursor, length);
            buffer[length] = '\0';
            return;
        }
    } else if (
        strncmp(cursor, "null", 4) == 0 &&
        (cursor[4] == ',' || cursor[4] == '}' ||
         isspace((unsigned char)cursor[4]))
    ) {
        snprintf(buffer, size, "null");
        return;
    } else if (*cursor == '-' || isdigit((unsigned char)*cursor)) {
        const char *end = json_parse_number_token(cursor);
        if (
            end != NULL &&
            (*end == ',' || *end == '}' ||
             isspace((unsigned char)*end)) &&
            (size_t)(end - cursor) < size
        ) {
            size_t length = (size_t)(end - cursor);
            memcpy(buffer, cursor, length);
            buffer[length] = '\0';
            return;
        }
    }
    snprintf(buffer, size, "null");
}

static void json_escape(
    const char *input,
    char *buffer,
    size_t size
) {
    if (size == 0) return;
    size_t used = 0;
    for (; *input != '\0' && used + 1 < size; input++) {
        unsigned char character = (unsigned char)*input;
        const char *escape = NULL;
        switch (character) {
            case '"': escape = "\\\""; break;
            case '\\': escape = "\\\\"; break;
            case '\b': escape = "\\b"; break;
            case '\f': escape = "\\f"; break;
            case '\n': escape = "\\n"; break;
            case '\r': escape = "\\r"; break;
            case '\t': escape = "\\t"; break;
            default: break;
        }
        if (escape != NULL) {
            if (used + 2 >= size) break;
            buffer[used++] = escape[0];
            buffer[used++] = escape[1];
        } else if (character >= 0x20) {
            buffer[used++] = (char)character;
        }
    }
    buffer[used] = '\0';
}

static bool server_emit(ServerContext *context, const char *format, ...) {
    pthread_mutex_lock(&context->output_lock);
    va_list arguments;
    va_start(arguments, format);
    bool ok = vfprintf(stdout, format, arguments) >= 0;
    va_end(arguments);
    if (fputc('\n', stdout) == EOF) ok = false;
    if (fflush(stdout) != 0) ok = false;
    pthread_mutex_unlock(&context->output_lock);
    return ok;
}

static bool server_response(
    ServerContext *context,
    const char *id,
    bool ok,
    const char *fields
) {
    if (fields == NULL || fields[0] == '\0') {
        return server_emit(
            context, "{\"v\":1,\"type\":\"response\",\"id\":%s,\"ok\":%s}",
            id, ok ? "true" : "false"
        );
    } else {
        return server_emit(
            context,
            "{\"v\":1,\"type\":\"response\",\"id\":%s,\"ok\":%s,%s}",
            id, ok ? "true" : "false", fields
        );
    }
}

static void server_error(
    ServerContext *context,
    const char *id,
    const char *code,
    const char *message
) {
    char escaped_code[128];
    char escaped_message[512];
    json_escape(code, escaped_code, sizeof(escaped_code));
    json_escape(message, escaped_message, sizeof(escaped_message));
    server_emit(
        context,
        "{\"v\":1,\"type\":\"response\",\"id\":%s,\"ok\":false,"
        "\"error\":{\"code\":\"%s\",\"message\":\"%s\"}}",
        id, escaped_code, escaped_message
    );
}

static bool server_notify(ServerContext *context, const char *format, ...) {
    char line[MAX_NOTIFICATION_LINE];
    va_list arguments;
    va_start(arguments, format);
    int length = vsnprintf(line, sizeof(line), format, arguments);
    va_end(arguments);
    if (length < 0 || (size_t)length >= sizeof(line)) {
        pthread_mutex_lock(&context->notification_lock);
        context->notification_dropped++;
        pthread_mutex_unlock(&context->notification_lock);
        return false;
    }

    pthread_mutex_lock(&context->notification_lock);
    uint64_t sequence = ++context->notification_sequence;
    if (context->notification_sequence == 0) {
        sequence = ++context->notification_sequence;
    }
    if (
        !context->notification_available ||
        context->notification_count >= NOTIFICATION_QUEUE_CAPACITY
    ) {
        context->notification_dropped++;
        pthread_mutex_unlock(&context->notification_lock);
        return false;
    }
    int stored_length;
    if (line[0] == '{') {
        stored_length = snprintf(
            context->notifications[context->notification_write],
            MAX_NOTIFICATION_LINE,
            "{\"event_sequence\":%llu,%s",
            (unsigned long long)sequence, line + 1
        );
    } else {
        stored_length = snprintf(
            context->notifications[context->notification_write],
            MAX_NOTIFICATION_LINE,
            "{\"event_sequence\":%llu,\"type\":\"event\","
            "\"event\":\"message\",\"value\":\"%s\"}",
            (unsigned long long)sequence, line
        );
    }
    if (
        stored_length < 0 ||
        stored_length >= MAX_NOTIFICATION_LINE
    ) {
        context->notification_dropped++;
        pthread_mutex_unlock(&context->notification_lock);
        return false;
    }
    context->notification_write =
        (context->notification_write + 1) % NOTIFICATION_QUEUE_CAPACITY;
    context->notification_count++;
    pthread_cond_signal(&context->notification_condition);
    pthread_mutex_unlock(&context->notification_lock);
    return true;
}

static void *server_notification_writer(void *opaque_context) {
    ServerContext *context = opaque_context;
    while (true) {
        char line[MAX_NOTIFICATION_LINE];
        pthread_mutex_lock(&context->notification_lock);
        while (
            context->notification_running &&
            context->notification_count == 0
        ) {
            pthread_cond_wait(
                &context->notification_condition,
                &context->notification_lock
            );
        }
        if (
            !context->notification_running &&
            context->notification_count == 0
        ) {
            pthread_mutex_unlock(&context->notification_lock);
            break;
        }
        snprintf(
            line, sizeof(line), "%s",
            context->notifications[context->notification_read]
        );
        context->notification_read =
            (context->notification_read + 1) % NOTIFICATION_QUEUE_CAPACITY;
        context->notification_count--;
        pthread_mutex_unlock(&context->notification_lock);
        (void)server_emit(context, "%s", line);
    }
    return NULL;
}

static bool server_start_notification_writer(ServerContext *context) {
    pthread_mutex_lock(&context->notification_lock);
    context->notification_running = true;
    pthread_mutex_unlock(&context->notification_lock);
    if (
        pthread_create(
            &context->notification_thread, NULL,
            server_notification_writer, context
        ) != 0
    ) {
        pthread_mutex_lock(&context->notification_lock);
        context->notification_running = false;
        pthread_mutex_unlock(&context->notification_lock);
        return false;
    }
    pthread_mutex_lock(&context->notification_lock);
    context->notification_available = true;
    pthread_mutex_unlock(&context->notification_lock);
    return true;
}

static void server_stop_notification_writer(ServerContext *context) {
    pthread_mutex_lock(&context->notification_lock);
    bool join_thread = context->notification_available;
    context->notification_running = false;
    context->notification_available = false;
    pthread_cond_broadcast(&context->notification_condition);
    pthread_mutex_unlock(&context->notification_lock);
    if (join_thread) {
        pthread_join(context->notification_thread, NULL);
    }
}

static int server_channel(
    ServerContext *context,
    const char *json,
    int *channel
) {
    long requested;
    if (!json_has_key(json, "channel")) {
        *channel = context->default_channel;
        return 0;
    }
    if (
        !json_get_long(json, "channel", &requested) ||
        requested < 1 || requested > 16
    ) {
        return -1;
    }
    *channel = (int)requested;
    return 0;
}

static int server_note_value(const char *json, int *note) {
    char name[16];
    if (json_get_string(json, "note", name, sizeof(name))) {
        return parse_note(name, note);
    }
    long numeric;
    if (
        !json_get_long(json, "note", &numeric) ||
        numeric < 0 || numeric > 127
    ) {
        return -1;
    }
    *note = (int)numeric;
    return 0;
}

static bool json_get_note_array(
    const char *json,
    int *notes,
    size_t capacity,
    size_t *count
) {
    const char *cursor = json_find_value(json, "notes");
    if (cursor == NULL || *cursor != '[') {
        return false;
    }
    cursor = skip_json_space(cursor + 1);
    size_t used = 0;
    if (*cursor == ']') {
        return false;
    }
    while (*cursor != '\0') {
        if (used >= capacity) {
            return false;
        }
        const char *start = cursor;
        if (*cursor == '-') cursor++;
        if (!isdigit((unsigned char)*cursor)) {
            return false;
        }
        if (*cursor == '0') {
            cursor++;
            if (isdigit((unsigned char)*cursor)) return false;
        } else {
            while (isdigit((unsigned char)*cursor)) cursor++;
        }
        char *end = NULL;
        errno = 0;
        long value = strtol(start, &end, 10);
        if (
            errno != 0 || end != cursor ||
            value < 0 || value > 127
        ) {
            return false;
        }
        notes[used++] = (int)value;
        cursor = skip_json_space(cursor);
        if (*cursor == ']') {
            *count = used;
            return true;
        }
        if (*cursor != ',') {
            return false;
        }
        cursor = skip_json_space(cursor + 1);
    }
    return false;
}

static void server_update_note(
    ServerContext *context,
    int channel,
    int note,
    int velocity,
    bool active,
    double now
) {
    pthread_mutex_lock(&context->state_lock);
    uint16_t *count = &context->active_notes[channel - 1][note];
    if (active && *count < UINT16_MAX) {
        (*count)++;
    } else if (!active && *count > 0) {
        (*count)--;
    }
    server_notify(
        context,
        "{\"v\":1,\"type\":\"event\",\"event\":\"%s\",\"source\":\"user\","
        "\"channel\":%d,\"note\":%d,\"velocity\":%d,"
        "\"server_time_ms\":%.3f}",
        active ? "note_on" : "note_off", channel, note,
        active ? velocity : 0, (now - context->started_at) * 1000.0
    );
    pthread_mutex_unlock(&context->state_lock);
}

static int server_send_note(
    ServerContext *context,
    int channel,
    int note,
    int velocity,
    bool active,
    uint64_t event_job_id
) {
    pthread_mutex_lock(&context->midi_lock);
    int result = send_three(
        context->output_port, context->destination,
        active ? 0x90 : 0x80, note, active ? velocity : 0, channel
    );
    if (result == 0) {
        pthread_mutex_lock(&context->state_lock);
        uint16_t *count = &context->active_notes[channel - 1][note];
        if (active && *count < UINT16_MAX) {
            (*count)++;
        } else if (!active && *count > 0) {
            (*count)--;
        }
        if (event_job_id != 0) {
            server_notify(
                context,
                "{\"v\":1,\"type\":\"event\",\"event\":\"%s\","
                "\"source\":\"agent\",\"job\":%llu,\"channel\":%d,"
                "\"note\":%d,\"velocity\":%d,\"server_time_ms\":%.3f}",
                active ? "note_on" : "note_off",
                (unsigned long long)event_job_id, channel, note,
                active ? velocity : 0,
                (monotonic_seconds() - context->started_at) * 1000.0
            );
        }
        pthread_mutex_unlock(&context->state_lock);
    }
    pthread_mutex_unlock(&context->midi_lock);
    return result;
}

/*
 * Return 1 when the message is intentionally blocked by the user's takeover
 * window, -1 on MIDI failure, and 0 when it was sent.
 */
static double takeover_remaining_seconds(
    double user_updated_at,
    double now,
    double takeover_seconds
) {
    if (user_updated_at <= 0 || takeover_seconds <= 0) {
        return 0;
    }
    double user_age = fmax(0, now - user_updated_at);
    return fmax(0, takeover_seconds - user_age);
}

static int server_send_cc(
    ServerContext *context,
    int channel,
    int cc,
    int value,
    bool force,
    double *blocked_for,
    uint64_t event_job_id
) {
    if (
        channel < 1 || channel > 16 ||
        cc < 0 || cc > 127 ||
        value < 0 || value > 127
    ) {
        return -1;
    }
    double now = monotonic_seconds();
    pthread_mutex_lock(&context->midi_lock);
    pthread_mutex_lock(&context->state_lock);
    CCState *state = &context->cc[channel - 1][cc];
    double remaining = takeover_remaining_seconds(
        state->user_updated_at, now, context->takeover_seconds
    );
    if (
        !force && remaining > 0
    ) {
        if (blocked_for != NULL) {
            *blocked_for = remaining;
        }
        pthread_mutex_unlock(&context->state_lock);
        pthread_mutex_unlock(&context->midi_lock);
        return 1;
    }
    int result = send_cc(
        context->output_port, context->destination, cc, value, channel
    );
    if (result == 0) {
        state->known = true;
        state->value = value;
        state->agent_value = value;
        state->updated_at = now;
        state->agent_updated_at = now;
        state->source = "agent";
        if (event_job_id != 0) {
            server_notify(
                context,
                "{\"v\":1,\"type\":\"event\",\"event\":\"cc\","
                "\"source\":\"agent\",\"job\":%llu,\"channel\":%d,"
                "\"number\":%d,\"value\":%d,\"server_time_ms\":%.3f}",
                (unsigned long long)event_job_id, channel, cc, value,
                (now - context->started_at) * 1000.0
            );
        }
    }
    pthread_mutex_unlock(&context->state_lock);
    pthread_mutex_unlock(&context->midi_lock);
    return result == 0 ? 0 : -1;
}

static NRPNState *server_find_nrpn_locked(
    ServerContext *context,
    int channel,
    int parameter,
    bool create
) {
    for (size_t index = 0; index < context->nrpn_count; index++) {
        NRPNState *state = &context->nrpn[index];
        if (
            state->used &&
            state->channel == channel &&
            state->parameter == parameter
        ) {
            return state;
        }
    }
    if (!create || context->nrpn_count >= MAX_TRACKED_NRPN) {
        return NULL;
    }
    NRPNState *state = &context->nrpn[context->nrpn_count++];
    *state = (NRPNState){
        .used = true,
        .channel = channel,
        .parameter = parameter,
        .source = "unknown",
    };
    return state;
}

/*
 * As with server_send_cc: 1 means user takeover, -1 means send failure,
 * and 0 means transmitted.
 */
static int server_send_nrpn_value(
    ServerContext *context,
    int channel,
    int parameter,
    int value,
    bool force,
    double *blocked_for
) {
    double now = monotonic_seconds();
    pthread_mutex_lock(&context->midi_lock);
    pthread_mutex_lock(&context->state_lock);
    NRPNState *parameter_state = server_find_nrpn_locked(
        context, channel, parameter, false
    );
    if (parameter_state != NULL) {
        double remaining = takeover_remaining_seconds(
            parameter_state->user_updated_at, now,
            context->takeover_seconds
        );
        if (
            !force && remaining > 0
        ) {
            if (blocked_for != NULL) {
                *blocked_for = remaining;
            }
            pthread_mutex_unlock(&context->state_lock);
            pthread_mutex_unlock(&context->midi_lock);
            return 1;
        }
    }

    int result = send_nrpn(
        context->output_port, context->destination,
        parameter, value, channel
    );
    if (result == 0) {
        int controllers[] = {99, 98, 6, 38};
        int values[] = {
            (parameter >> 7) & 0x7F,
            parameter & 0x7F,
            (value >> 7) & 0x7F,
            value & 0x7F,
        };
        for (size_t index = 0;
             index < sizeof(controllers) / sizeof(controllers[0]);
             index++) {
            CCState *cc_state =
                &context->cc[channel - 1][controllers[index]];
            cc_state->known = true;
            cc_state->value = values[index];
            cc_state->agent_value = values[index];
            cc_state->updated_at = now;
            cc_state->agent_updated_at = now;
            cc_state->source = "agent";
        }
        parameter_state = server_find_nrpn_locked(
            context, channel, parameter, true
        );
        if (parameter_state != NULL) {
            parameter_state->value = value;
            parameter_state->resolution_bits = 14;
            parameter_state->updated_at = now;
            parameter_state->agent_updated_at = now;
            parameter_state->agent_value = value;
            parameter_state->source = "agent";
        }
    }
    pthread_mutex_unlock(&context->state_lock);
    pthread_mutex_unlock(&context->midi_lock);
    return result == 0 ? 0 : -1;
}

static void server_reset_nrpn_locked(ServerContext *context) {
    memset(context->incoming_nrpn, 0, sizeof(context->incoming_nrpn));
    for (int channel = 0; channel < 16; channel++) {
        context->incoming_nrpn[channel].parameter_msb = -1;
        context->incoming_nrpn[channel].parameter_lsb = -1;
        context->incoming_nrpn[channel].data_msb = -1;
        context->incoming_nrpn[channel].data_lsb = -1;
    }
    memset(context->nrpn, 0, sizeof(context->nrpn));
    context->nrpn_count = 0;
}

static void server_clear_patch_state(
    ServerContext *context,
    int bank,
    int patch
) {
    pthread_mutex_lock(&context->state_lock);
    memset(context->cc, 0, sizeof(context->cc));
    server_reset_nrpn_locked(context);
    context->patch_known = true;
    context->patch_bank = bank;
    context->patch_number = patch;
    pthread_mutex_unlock(&context->state_lock);
}

static int server_select_patch(
    ServerContext *context,
    int channel,
    int bank,
    int patch
) {
    pthread_mutex_lock(&context->midi_lock);
    if (
        send_cc(context->output_port, context->destination, 0, 0, channel) != 0
    ) {
        pthread_mutex_unlock(&context->midi_lock);
        return -1;
    }
    sleep_seconds(0.02);
    if (
        send_cc(
            context->output_port, context->destination, 32, bank, channel
        ) != 0
    ) {
        pthread_mutex_unlock(&context->midi_lock);
        return -1;
    }
    sleep_seconds(0.02);
    if (
        send_program(
            context->output_port, context->destination, patch - 1, channel
        ) != 0
    ) {
        pthread_mutex_unlock(&context->midi_lock);
        return -1;
    }
    server_clear_patch_state(context, bank, patch);
    pthread_mutex_unlock(&context->midi_lock);
    return 0;
}

static int server_emergency_channel_cleanup(
    ServerContext *context,
    int channel,
    uint64_t job_id,
    int failed_note
) {
    pthread_mutex_lock(&context->midi_lock);
    pthread_mutex_lock(&context->state_lock);
    int failures = 0;
    if (
        send_cc(
            context->output_port, context->destination, 64, 0, channel
        ) != 0
    ) {
        failures++;
    }
    if (
        send_cc(
            context->output_port, context->destination, 123, 0, channel
        ) != 0
    ) {
        failures++;
    }
    if (
        send_cc(
            context->output_port, context->destination, 120, 0, channel
        ) != 0
    ) {
        failures++;
    }
    if (failures == 0) {
        memset(
            context->active_notes[channel - 1], 0,
            sizeof(context->active_notes[channel - 1])
        );
        server_notify(
            context,
            "{\"v\":1,\"type\":\"event\","
            "\"event\":\"note_off_failed\",\"source\":\"agent\","
            "\"job\":%llu,\"channel\":%d,\"note\":%d,"
            "\"emergency_cleanup\":true,\"server_time_ms\":%.3f}",
            (unsigned long long)job_id, channel, failed_note,
            (monotonic_seconds() - context->started_at) * 1000.0
        );
    }
    pthread_mutex_unlock(&context->state_lock);
    pthread_mutex_unlock(&context->midi_lock);
    return failures == 0 ? 0 : -1;
}

static int server_panic(
    ServerContext *context,
    uint64_t *event_barrier
) {
    int failures = 0;
    pthread_mutex_lock(&context->midi_lock);
    pthread_mutex_lock(&context->state_lock);
    for (int channel = 1; channel <= 16; channel++) {
        bool channel_cleanup_ok = true;
        if (send_cc(
            context->output_port, context->destination, 64, 0, channel
        ) != 0) {
            channel_cleanup_ok = false;
            failures++;
        }
        for (int note = 0; note < 128; note++) {
            uint16_t count = context->active_notes[channel - 1][note];
            uint16_t released = 0;
            uint16_t attempts = count > 4 ? 4 : count;
            for (uint16_t voice = 0; voice < attempts; voice++) {
                if (send_three(
                    context->output_port, context->destination,
                    0x80, note, 0, channel
                ) == 0) {
                    released++;
                } else {
                    failures++;
                }
            }
            context->active_notes[channel - 1][note] -= released;
        }
        if (send_cc(
            context->output_port, context->destination, 123, 0, channel
        ) != 0) {
            channel_cleanup_ok = false;
            failures++;
        }
        if (send_cc(
            context->output_port, context->destination, 120, 0, channel
        ) != 0) {
            channel_cleanup_ok = false;
            failures++;
        }
        if (channel_cleanup_ok) {
            for (int note = 0; note < 128; note++) {
                context->active_notes[channel - 1][note] = 0;
            }
        }
    }
    if (event_barrier != NULL) {
        pthread_mutex_lock(&context->notification_lock);
        *event_barrier = context->notification_sequence;
        pthread_mutex_unlock(&context->notification_lock);
    }
    pthread_mutex_unlock(&context->state_lock);
    pthread_mutex_unlock(&context->midi_lock);
    return failures == 0 ? 0 : -1;
}

static ScheduledJob *server_find_job_locked(
    ServerContext *context,
    uint64_t job_id
) {
    for (size_t index = 0; index < MAX_SCHEDULED_JOBS; index++) {
        if (
            context->scheduled_jobs[index].used &&
            context->scheduled_jobs[index].id == job_id
        ) {
            return &context->scheduled_jobs[index];
        }
    }
    return NULL;
}

static void server_set_job_events_armed_locked(
    ServerContext *context,
    uint64_t job_id,
    bool armed
) {
    for (size_t index = 0; index < MAX_SCHEDULED_EVENTS; index++) {
        ScheduledEvent *event = &context->scheduled_events[index];
        if (event->used && event->job_id == job_id) {
            event->armed = armed;
        }
    }
}

/*
 * The caller must hold scheduler_lock. In-flight events cannot be canceled:
 * the scheduler has already removed them from the queue and may be sending
 * outside the lock. The request handler pauses the remaining events and waits
 * for that send to be accounted before calling this helper again.
 */
static CancelJobStatus server_cancel_job_locked(
    ServerContext *context,
    uint64_t job_id,
    CanceledJob *canceled
) {
    ScheduledJob *job = server_find_job_locked(context, job_id);
    if (job == NULL) {
        return CANCEL_JOB_NOT_FOUND;
    }
    if (
        job->kind != NULL && strcmp(job->kind, "play") == 0 &&
        job->sent_events > 0
    ) {
        return CANCEL_JOB_ACTIVE_NOTES;
    }
    if (job->in_flight_events > 0) {
        return CANCEL_JOB_IN_FLIGHT;
    }

    memset(canceled, 0, sizeof(*canceled));
    canceled->id = job->id;
    snprintf(
        canceled->kind, sizeof(canceled->kind), "%s",
        job->kind == NULL ? "unknown" : job->kind
    );
    canceled->sent_events = job->sent_events;
    canceled->blocked_events = job->blocked_events;
    for (size_t index = 0; index < MAX_SCHEDULED_EVENTS; index++) {
        ScheduledEvent *event = &context->scheduled_events[index];
        if (event->used && event->job_id == job_id) {
            event->used = false;
            canceled->removed_events++;
        }
    }
    job->pending_events = 0;
    job->used = false;
    pthread_cond_broadcast(&context->scheduler_condition);
    return CANCEL_JOB_OK;
}

static void server_resume_canceled_play_locked(
    ServerContext *context,
    uint64_t job_id
) {
    ScheduledJob *job = server_find_job_locked(context, job_id);
    if (job == NULL) return;
    job->cancel_requested = false;
    server_set_job_events_armed_locked(context, job_id, true);
    pthread_cond_broadcast(&context->scheduler_condition);
}

static struct timespec relative_timespec(double seconds) {
    struct timespec delay;
    if (seconds < 0) seconds = 0;
    delay.tv_sec = (time_t)floor(seconds);
    delay.tv_nsec =
        (long)((seconds - (double)delay.tv_sec) * 1000000000.0);
    return delay;
}

static void *server_scheduler(void *opaque_context) {
    ServerContext *context = opaque_context;
    while (true) {
        ScheduledEvent event;
        bool have_event = false;

        pthread_mutex_lock(&context->scheduler_lock);
        while (context->scheduler_running && !have_event) {
            size_t earliest_index = MAX_SCHEDULED_EVENTS;
            double earliest_time = 0;
            for (size_t index = 0; index < MAX_SCHEDULED_EVENTS; index++) {
                const ScheduledEvent *candidate =
                    &context->scheduled_events[index];
                if (
                    candidate->used && candidate->armed &&
                    (earliest_index == MAX_SCHEDULED_EVENTS ||
                     candidate->due_at < earliest_time)
                ) {
                    earliest_index = index;
                    earliest_time = candidate->due_at;
                }
            }
            if (earliest_index == MAX_SCHEDULED_EVENTS) {
                pthread_cond_wait(
                    &context->scheduler_condition,
                    &context->scheduler_lock
                );
                continue;
            }
            double remaining = earliest_time - monotonic_seconds();
            if (remaining > 0) {
                struct timespec delay = relative_timespec(remaining);
                (void)pthread_cond_timedwait_relative_np(
                    &context->scheduler_condition,
                    &context->scheduler_lock,
                    &delay
                );
                continue;
            }
            event = context->scheduled_events[earliest_index];
            context->scheduled_events[earliest_index].used = false;
            ScheduledJob *job = server_find_job_locked(
                context, event.job_id
            );
            if (job != NULL) {
                job->in_flight_events++;
            }
            have_event = true;
        }
        bool running = context->scheduler_running;
        pthread_mutex_unlock(&context->scheduler_lock);
        if (!running) {
            break;
        }
        if (!have_event) {
            continue;
        }

        int send_result = -1;
        double blocked_for = 0;
        if (event.kind == SCHEDULED_NOTE_ON) {
            send_result = server_send_note(
                context, event.channel, event.data1, event.data2, true,
                event.job_id
            );
        } else if (event.kind == SCHEDULED_NOTE_OFF) {
            send_result = server_send_note(
                context, event.channel, event.data1, 0, false,
                event.job_id
            );
        } else if (event.kind == SCHEDULED_CC) {
            send_result = server_send_cc(
                context, event.channel, event.data1, event.data2,
                event.force, &blocked_for, event.job_id
            );
        }
        bool emergency_cleanup = false;
        if (event.kind == SCHEDULED_NOTE_OFF && send_result < 0) {
            for (int retry = 0; retry < 2 && send_result < 0; retry++) {
                sleep_seconds(retry == 0 ? 0.005 : 0.020);
                send_result = server_send_note(
                    context, event.channel, event.data1, 0, false,
                    event.job_id
                );
            }
            if (send_result < 0) {
                emergency_cleanup =
                    server_emergency_channel_cleanup(
                        context, event.channel, event.job_id, event.data1
                    ) == 0;
            }
        }

        double event_time =
            (monotonic_seconds() - context->started_at) * 1000.0;
        if (
            send_result == 1 && event.kind == SCHEDULED_CC
        ) {
            server_notify(
                context,
                "{\"v\":1,\"type\":\"event\","
                "\"event\":\"automation_blocked\","
                "\"source\":\"user_takeover\",\"job\":%llu,"
                "\"channel\":%d,\"number\":%d,\"value\":%d,"
                "\"retry_after_ms\":%.3f,\"server_time_ms\":%.3f}",
                (unsigned long long)event.job_id, event.channel,
                event.data1, event.data2, blocked_for * 1000.0, event_time
            );
        } else if (
            send_result < 0 && event.kind == SCHEDULED_NOTE_OFF &&
            !emergency_cleanup
        ) {
            server_notify(
                context,
                "{\"v\":1,\"type\":\"event\","
                "\"event\":\"note_off_failed\",\"source\":\"agent\","
                "\"job\":%llu,\"channel\":%d,\"note\":%d,"
                "\"emergency_cleanup\":%s,\"server_time_ms\":%.3f}",
                (unsigned long long)event.job_id, event.channel,
                event.data1, emergency_cleanup ? "true" : "false",
                event_time
            );
        }

        bool job_complete = false;
        bool job_failed = false;
        int blocked_events = 0;
        int sent_events = 0;
        const char *job_kind = "unknown";
        pthread_mutex_lock(&context->scheduler_lock);
        ScheduledJob *job = server_find_job_locked(context, event.job_id);
        if (job != NULL) {
            if (job->in_flight_events > 0) {
                job->in_flight_events--;
            }
            if (send_result < 0) {
                job->failed = true;
            } else if (send_result == 1) {
                job->blocked_events++;
            } else {
                job->sent_events++;
            }
            if (job->pending_events > 0) {
                job->pending_events--;
            }
            if (job->pending_events == 0 && !job->cancel_requested) {
                job_complete = true;
                job_failed = job->failed;
                blocked_events = job->blocked_events;
                sent_events = job->sent_events;
                job_kind = job->kind;
                job->used = false;
            }
            pthread_cond_broadcast(&context->scheduler_condition);
        }
        pthread_mutex_unlock(&context->scheduler_lock);
        if (job_complete) {
            server_notify(
                context,
                "{\"v\":1,\"type\":\"event\",\"event\":\"job\","
                "\"job\":%llu,\"kind\":\"%s\",\"state\":\"%s\","
                "\"sent_events\":%d,\"blocked_events\":%d,"
                "\"server_time_ms\":%.3f}",
                (unsigned long long)event.job_id, job_kind,
                job_failed ? "failed" :
                    (blocked_events > 0 ? "partial" : "complete"),
                sent_events, blocked_events,
                (monotonic_seconds() - context->started_at) * 1000.0
            );
        }
    }
    return NULL;
}

static bool server_start_scheduler(ServerContext *context) {
    pthread_mutex_lock(&context->scheduler_lock);
    if (context->scheduler_available) {
        pthread_mutex_unlock(&context->scheduler_lock);
        return true;
    }
    context->scheduler_running = true;
    pthread_mutex_unlock(&context->scheduler_lock);

    if (
        pthread_create(
            &context->scheduler_thread, NULL, server_scheduler, context
        ) != 0
    ) {
        pthread_mutex_lock(&context->scheduler_lock);
        context->scheduler_running = false;
        pthread_mutex_unlock(&context->scheduler_lock);
        return false;
    }
    pthread_mutex_lock(&context->scheduler_lock);
    context->scheduler_available = true;
    pthread_mutex_unlock(&context->scheduler_lock);
    return true;
}

static size_t server_stop_scheduler(
    ServerContext *context,
    bool clear_queue,
    const char *reason
) {
    pthread_mutex_lock(&context->scheduler_lock);
    bool join_thread = context->scheduler_available;
    context->scheduler_running = false;
    context->scheduler_available = false;
    pthread_cond_broadcast(&context->scheduler_condition);
    pthread_mutex_unlock(&context->scheduler_lock);
    if (join_thread) {
        pthread_join(context->scheduler_thread, NULL);
    }

    size_t canceled_jobs = 0;
    uint64_t canceled_ids[MAX_SCHEDULED_JOBS];
    const char *canceled_kinds[MAX_SCHEDULED_JOBS];
    if (clear_queue) {
        pthread_mutex_lock(&context->scheduler_lock);
        for (size_t index = 0; index < MAX_SCHEDULED_JOBS; index++) {
            if (context->scheduled_jobs[index].used) {
                canceled_ids[canceled_jobs] =
                    context->scheduled_jobs[index].id;
                canceled_kinds[canceled_jobs] =
                    context->scheduled_jobs[index].kind;
                canceled_jobs++;
            }
        }
        memset(
            context->scheduled_events, 0,
            sizeof(context->scheduled_events)
        );
        memset(
            context->scheduled_jobs, 0,
            sizeof(context->scheduled_jobs)
        );
        pthread_mutex_unlock(&context->scheduler_lock);
        for (size_t index = 0; index < canceled_jobs; index++) {
            server_notify(
                context,
                "{\"v\":1,\"type\":\"event\",\"event\":\"job\","
                "\"job\":%llu,\"kind\":\"%s\",\"state\":\"canceled\","
                "\"reason\":\"%s\",\"server_time_ms\":%.3f}",
                (unsigned long long)canceled_ids[index],
                canceled_kinds[index] == NULL ?
                    "unknown" : canceled_kinds[index],
                reason == NULL ? "controller" : reason,
                (monotonic_seconds() - context->started_at) * 1000.0
            );
        }
    }
    return canceled_jobs;
}

static void server_cancel_job(
    ServerContext *context,
    const char *id,
    uint64_t job_id
) {
    CanceledJob canceled;
    bool paused_for_in_flight = false;

    pthread_mutex_lock(&context->scheduler_lock);
    CancelJobStatus status = server_cancel_job_locked(
        context, job_id, &canceled
    );
    if (status == CANCEL_JOB_IN_FLIGHT) {
        ScheduledJob *job = server_find_job_locked(context, job_id);
        if (job != NULL) {
            /*
             * Prevent the scheduler from starting another event while the
             * already-popped event finishes. This makes a successful cancel
             * response a firm barrier: no event from that job can be sent
             * after the response.
             */
            job->cancel_requested = true;
            server_set_job_events_armed_locked(context, job_id, false);
            paused_for_in_flight = true;
            pthread_cond_broadcast(&context->scheduler_condition);
            while (true) {
                job = server_find_job_locked(context, job_id);
                if (job == NULL || job->in_flight_events == 0) break;
                pthread_cond_wait(
                    &context->scheduler_condition,
                    &context->scheduler_lock
                );
            }
            status = server_cancel_job_locked(context, job_id, &canceled);
        } else {
            status = CANCEL_JOB_NOT_FOUND;
        }
    }
    pthread_mutex_unlock(&context->scheduler_lock);

    if (status == CANCEL_JOB_OK) {
        char fields[320];
        snprintf(
            fields, sizeof(fields),
            "\"state\":\"canceled\",\"op\":\"cancel\",\"job\":%llu,"
            "\"kind\":\"%s\",\"removed_events\":%d,"
            "\"sent_events\":%d,\"blocked_events\":%d",
            (unsigned long long)canceled.id, canceled.kind,
            canceled.removed_events, canceled.sent_events,
            canceled.blocked_events
        );
        (void)server_response(context, id, true, fields);
        /*
         * Allocate the terminal event only after writing the command
         * response. This preserves response-before-cancellation ordering for
         * clients that correlate the two streams by job ID.
         */
        server_notify(
            context,
            "{\"v\":1,\"type\":\"event\",\"event\":\"job\","
            "\"job\":%llu,\"kind\":\"%s\",\"state\":\"canceled\","
            "\"reason\":\"client\",\"removed_events\":%d,"
            "\"sent_events\":%d,\"blocked_events\":%d,"
            "\"server_time_ms\":%.3f}",
            (unsigned long long)canceled.id, canceled.kind,
            canceled.removed_events, canceled.sent_events,
            canceled.blocked_events,
            (monotonic_seconds() - context->started_at) * 1000.0
        );
        return;
    }

    if (status == CANCEL_JOB_ACTIVE_NOTES) {
        if (paused_for_in_flight) {
            pthread_mutex_lock(&context->scheduler_lock);
            server_resume_canceled_play_locked(context, job_id);
            pthread_mutex_unlock(&context->scheduler_lock);
        }
        /*
         * Resume required note-offs before writing the error response, since
         * a slow stdout reader must never extend or hang an active note.
         */
        server_error(
            context, id, "cannot_cancel_active_notes",
            "play jobs cannot be canceled after a note-on was sent; "
            "use panic to stop active notes safely"
        );
        return;
    }

    if (paused_for_in_flight) {
        pthread_mutex_lock(&context->scheduler_lock);
        server_resume_canceled_play_locked(context, job_id);
        pthread_mutex_unlock(&context->scheduler_lock);
    }
    if (status == CANCEL_JOB_NOT_FOUND) {
        server_error(
            context, id, "job_not_found",
            "no active scheduler job has that ID"
        );
    } else {
        server_error(
            context, id, "cancel_in_progress",
            "the job has an event in flight; retry cancellation"
        );
    }
}

static void server_queue_play(
    ServerContext *context,
    const char *id,
    const int *notes,
    size_t note_count,
    int velocity,
    int channel,
    long duration_ms,
    long delay_ms
) {
    pthread_mutex_lock(&context->scheduler_lock);
    if (!context->scheduler_available || !context->scheduler_running) {
        pthread_mutex_unlock(&context->scheduler_lock);
        server_error(
            context, id, "scheduler_unavailable",
            "the timed-event scheduler is unavailable"
        );
        return;
    }
    size_t free_events = 0;
    for (size_t index = 0; index < MAX_SCHEDULED_EVENTS; index++) {
        if (!context->scheduled_events[index].used) {
            free_events++;
        }
    }
    ScheduledJob *job = NULL;
    for (size_t index = 0; index < MAX_SCHEDULED_JOBS; index++) {
        if (!context->scheduled_jobs[index].used) {
            job = &context->scheduled_jobs[index];
            break;
        }
    }
    if (job == NULL || free_events < note_count * 2) {
        pthread_mutex_unlock(&context->scheduler_lock);
        server_error(
            context, id, "queue_full",
            "the timed-event queue has no capacity for this chord"
        );
        return;
    }

    uint64_t job_id = context->next_job_id++;
    if (context->next_job_id == 0) {
        context->next_job_id = 1;
    }
    *job = (ScheduledJob){
        .used = true,
        .id = job_id,
        .pending_events = (int)(note_count * 2),
        .kind = "play",
    };
    double start = monotonic_seconds() + (double)delay_ms / 1000.0;
    for (size_t note_index = 0; note_index < note_count; note_index++) {
        for (int phase = 0; phase < 2; phase++) {
            for (size_t slot = 0; slot < MAX_SCHEDULED_EVENTS; slot++) {
                if (!context->scheduled_events[slot].used) {
                    context->scheduled_events[slot] = (ScheduledEvent){
                        .used = true,
                        .due_at = start +
                            (phase == 0 ? 0 :
                             (double)duration_ms / 1000.0),
                        .job_id = job_id,
                        .kind = phase == 0 ?
                            SCHEDULED_NOTE_ON : SCHEDULED_NOTE_OFF,
                        .channel = channel,
                        .data1 = notes[note_index],
                        .data2 = velocity,
                    };
                    break;
                }
            }
        }
    }

    char fields[320];
    snprintf(
        fields, sizeof(fields),
        "\"state\":\"queued\",\"op\":\"play\",\"job\":%llu,"
        "\"notes\":%lu,\"start_server_time_ms\":%.3f,"
        "\"duration_ms\":%ld",
        (unsigned long long)job_id, (unsigned long)note_count,
        (start - context->started_at) * 1000.0, duration_ms
    );
    pthread_mutex_unlock(&context->scheduler_lock);
    bool response_delivered = server_response(context, id, true, fields);
    pthread_mutex_lock(&context->scheduler_lock);
    for (size_t slot = 0; slot < MAX_SCHEDULED_EVENTS; slot++) {
        if (
            context->scheduled_events[slot].used &&
            context->scheduled_events[slot].job_id == job_id
        ) {
            if (response_delivered) {
                context->scheduled_events[slot].armed = true;
            } else {
                context->scheduled_events[slot].used = false;
            }
        }
    }
    if (response_delivered) {
        pthread_cond_signal(&context->scheduler_condition);
    } else {
        ScheduledJob *queued_job = server_find_job_locked(context, job_id);
        if (queued_job != NULL) queued_job->used = false;
    }
    pthread_mutex_unlock(&context->scheduler_lock);
}

static void server_queue_ramp(
    ServerContext *context,
    const char *id,
    int cc,
    double from,
    double to,
    int channel,
    long duration_ms,
    long delay_ms,
    double rate_hz,
    bool force
) {
    int values[128];
    double offsets[128];
    size_t step_count = 0;
    long sample_count =
        (long)ceil((double)duration_ms * rate_hz / 1000.0) + 1;
    if (sample_count < 2) sample_count = 2;
    int previous = -1;
    for (long sample = 0; sample < sample_count; sample++) {
        double phase = (double)sample / (double)(sample_count - 1);
        int value = (int)lround((from + (to - from) * phase) * 127.0);
        if (value < 0) value = 0;
        if (value > 127) value = 127;
        if (value != previous) {
            if (step_count >= sizeof(values) / sizeof(values[0])) {
                break;
            }
            values[step_count] = value;
            offsets[step_count] =
                (double)duration_ms * phase / 1000.0;
            step_count++;
            previous = value;
        } else if (sample == sample_count - 1 && step_count > 0) {
            offsets[step_count - 1] = (double)duration_ms / 1000.0;
        }
    }

    pthread_mutex_lock(&context->scheduler_lock);
    if (!context->scheduler_available || !context->scheduler_running) {
        pthread_mutex_unlock(&context->scheduler_lock);
        server_error(
            context, id, "scheduler_unavailable",
            "the timed-event scheduler is unavailable"
        );
        return;
    }
    size_t free_events = 0;
    for (size_t index = 0; index < MAX_SCHEDULED_EVENTS; index++) {
        if (!context->scheduled_events[index].used) free_events++;
    }
    ScheduledJob *job = NULL;
    for (size_t index = 0; index < MAX_SCHEDULED_JOBS; index++) {
        if (!context->scheduled_jobs[index].used) {
            job = &context->scheduled_jobs[index];
            break;
        }
    }
    if (job == NULL || free_events < step_count) {
        pthread_mutex_unlock(&context->scheduler_lock);
        server_error(
            context, id, "queue_full",
            "the timed-event queue has no capacity for this ramp"
        );
        return;
    }

    uint64_t job_id = context->next_job_id++;
    if (context->next_job_id == 0) context->next_job_id = 1;
    *job = (ScheduledJob){
        .used = true,
        .id = job_id,
        .pending_events = (int)step_count,
        .kind = "ramp",
    };
    double start = monotonic_seconds() + (double)delay_ms / 1000.0;
    size_t step = 0;
    for (size_t slot = 0;
         slot < MAX_SCHEDULED_EVENTS && step < step_count;
         slot++) {
        if (!context->scheduled_events[slot].used) {
            context->scheduled_events[slot] = (ScheduledEvent){
                .used = true,
                .due_at = start + offsets[step],
                .job_id = job_id,
                .kind = SCHEDULED_CC,
                .channel = channel,
                .data1 = cc,
                .data2 = values[step],
                .force = force,
            };
            step++;
        }
    }

    char fields[384];
    snprintf(
        fields, sizeof(fields),
        "\"state\":\"queued\",\"op\":\"ramp\",\"job\":%llu,"
        "\"number\":%d,\"from\":%.6f,\"to\":%.6f,\"steps\":%lu,"
        "\"start_server_time_ms\":%.3f,\"duration_ms\":%ld",
        (unsigned long long)job_id, cc, from, to,
        (unsigned long)step_count,
        (start - context->started_at) * 1000.0, duration_ms
    );
    pthread_mutex_unlock(&context->scheduler_lock);
    bool response_delivered = server_response(context, id, true, fields);
    pthread_mutex_lock(&context->scheduler_lock);
    for (size_t slot = 0; slot < MAX_SCHEDULED_EVENTS; slot++) {
        if (
            context->scheduled_events[slot].used &&
            context->scheduled_events[slot].job_id == job_id
        ) {
            if (response_delivered) {
                context->scheduled_events[slot].armed = true;
            } else {
                context->scheduled_events[slot].used = false;
            }
        }
    }
    if (response_delivered) {
        pthread_cond_signal(&context->scheduler_condition);
    } else {
        ScheduledJob *queued_job = server_find_job_locked(context, job_id);
        if (queued_job != NULL) queued_job->used = false;
    }
    pthread_mutex_unlock(&context->scheduler_lock);
}

static void server_emit_state(
    ServerContext *context,
    const char *id
) {
    typedef struct {
        int channel;
        int cc;
        int value;
        double age;
        double takeover_remaining;
        const char *source;
    } StateItem;
    typedef struct {
        int channel;
        int parameter;
        int value;
        int resolution_bits;
        double age;
        double takeover_remaining;
        const char *source;
    } NRPNItem;
    StateItem items[16 * 128];
    NRPNItem nrpn_items[MAX_TRACKED_NRPN];
    size_t count = 0;
    size_t nrpn_count = 0;
    bool patch_known;
    int patch_bank;
    int patch_number;
    uint16_t notes[16][128];
    uint64_t event_sequence;
    double takeover_seconds;
    double now = monotonic_seconds();

    pthread_mutex_lock(&context->state_lock);
    takeover_seconds = context->takeover_seconds;
    patch_known = context->patch_known;
    patch_bank = context->patch_bank;
    patch_number = context->patch_number;
    memcpy(notes, context->active_notes, sizeof(notes));
    for (int channel = 0; channel < 16; channel++) {
        for (int cc = 0; cc < 128; cc++) {
            const CCState *state = &context->cc[channel][cc];
            if (state->known) {
                items[count++] = (StateItem){
                    .channel = channel + 1,
                    .cc = cc,
                    .value = state->value,
                    .age = fmax(0, now - state->updated_at),
                    .takeover_remaining = takeover_remaining_seconds(
                        state->user_updated_at, now, takeover_seconds
                    ),
                    .source = state->source == NULL ? "unknown" : state->source,
                };
            }
        }
    }
    for (size_t index = 0; index < context->nrpn_count; index++) {
        const NRPNState *state = &context->nrpn[index];
        if (state->used) {
            nrpn_items[nrpn_count++] = (NRPNItem){
                .channel = state->channel,
                .parameter = state->parameter,
                .value = state->value,
                .resolution_bits = state->resolution_bits,
                .age = fmax(0, now - state->updated_at),
                .takeover_remaining = takeover_remaining_seconds(
                    state->user_updated_at, now, takeover_seconds
                ),
                .source =
                    state->source == NULL ? "unknown" : state->source,
            };
        }
    }
    pthread_mutex_lock(&context->notification_lock);
    event_sequence = context->notification_sequence;
    pthread_mutex_unlock(&context->notification_lock);
    pthread_mutex_unlock(&context->state_lock);

    pthread_mutex_lock(&context->output_lock);
    fprintf(
        stdout,
        "{\"v\":1,\"type\":\"response\",\"id\":%s,\"ok\":true,"
        "\"state\":{\"uptime\":%.3f,\"event_sequence\":%llu,"
        "\"takeover_seconds\":%.3f,\"patch\":",
        id, fmax(0, now - context->started_at),
        (unsigned long long)event_sequence, takeover_seconds
    );
    if (patch_known) {
        fprintf(
            stdout, "{\"bank\":\"%c\",\"number\":%d}",
            'A' + patch_bank, patch_number
        );
    } else {
        fputs("null", stdout);
    }
    fputs(",\"cc\":[", stdout);
    for (size_t index = 0; index < count; index++) {
        if (index > 0) fputc(',', stdout);
        fprintf(
            stdout,
            "{\"channel\":%d,\"number\":%d,\"value\":%d,"
            "\"source\":\"%s\",\"age\":%.3f,"
            "\"takeover_remaining\":%.3f}",
            items[index].channel, items[index].cc, items[index].value,
            items[index].source, items[index].age,
            items[index].takeover_remaining
        );
    }
    fputs("],\"nrpn\":[", stdout);
    for (size_t index = 0; index < nrpn_count; index++) {
        if (index > 0) fputc(',', stdout);
        fprintf(
            stdout,
            "{\"channel\":%d,\"parameter\":%d,\"value\":%d,"
            "\"resolution_bits\":%d,\"source\":\"%s\",\"age\":%.3f,"
            "\"takeover_remaining\":%.3f}",
            nrpn_items[index].channel, nrpn_items[index].parameter,
            nrpn_items[index].value, nrpn_items[index].resolution_bits,
            nrpn_items[index].source, nrpn_items[index].age,
            nrpn_items[index].takeover_remaining
        );
    }
    fputs("],\"active_notes\":[", stdout);
    bool first = true;
    for (int channel = 0; channel < 16; channel++) {
        for (int note = 0; note < 128; note++) {
            if (notes[channel][note]) {
                if (!first) fputc(',', stdout);
                fprintf(
                    stdout,
                    "{\"channel\":%d,\"note\":%d,\"count\":%u}",
                    channel + 1, note, (unsigned int)notes[channel][note]
                );
                first = false;
            }
        }
    }
    fputs("]}}\n", stdout);
    fflush(stdout);
    pthread_mutex_unlock(&context->output_lock);
}

static void server_emit_capabilities(
    ServerContext *context,
    const char *id
) {
    pthread_mutex_lock(&context->output_lock);
    fprintf(
        stdout,
        "{\"v\":1,\"type\":\"response\",\"id\":%s,\"ok\":true,"
        "\"ops\":[\"ping\",\"status\",\"capabilities\",\"state\","
        "\"play\",\"ramp\",\"cancel\",\"note_on\",\"note_off\",\"cc\",\"timbre\","
        "\"nrpn\",\"bend\",\"patch\",\"program\",\"panic\","
        "\"set_takeover\",\"shutdown\"],"
        "\"timbre_controls\":[",
        id
    );
    size_t control_count =
        sizeof(TIMBRE_CONTROLS) / sizeof(TIMBRE_CONTROLS[0]);
    for (size_t index = 0; index < control_count; index++) {
        if (index > 0) fputc(',', stdout);
        fprintf(
            stdout,
            "{\"name\":\"%s\",\"kind\":\"cc\",\"number\":%d,"
            "\"minimum\":0,\"maximum\":127,\"normalized\":true}",
            TIMBRE_CONTROLS[index].name,
            TIMBRE_CONTROLS[index].cc
        );
    }
    fprintf(
        stdout,
        "],\"limits\":{\"max_chord_notes\":%d,"
        "\"max_note_duration_ms\":120000,\"max_delay_ms\":600000,"
        "\"max_ramp_duration_ms\":120000,\"max_ramp_rate_hz\":100,"
        "\"max_scheduled_events\":%d,\"max_scheduled_jobs\":%d,"
        "\"notification_queue\":%d}}\n",
        MAX_CHORD_NOTES, MAX_SCHEDULED_EVENTS, MAX_SCHEDULED_JOBS,
        NOTIFICATION_QUEUE_CAPACITY
    );
    fflush(stdout);
    pthread_mutex_unlock(&context->output_lock);
}

static void server_process_nrpn_cc(
    ServerContext *context,
    int channel,
    int controller,
    int controller_value,
    const char *cc_source,
    double now
) {
    if (
        controller != 99 && controller != 98 &&
        controller != 101 && controller != 100 &&
        controller != 6 && controller != 38 &&
        controller != 96 && controller != 97
    ) {
        return;
    }

    bool emit = false;
    int parameter = 0;
    int value = 0;
    int resolution_bits = 14;
    const char *event_source;
    pthread_mutex_lock(&context->state_lock);
    IncomingNRPN *parser = &context->incoming_nrpn[channel - 1];
    if (controller == 99) {
        parser->selected = false;
        parser->parameter_msb = controller_value;
        parser->parameter_lsb = -1;
        parser->data_msb = -1;
        parser->data_lsb = -1;
        parser->possible_agent_echo =
            strcmp(cc_source, "agent_echo") == 0;
    } else if (controller == 98) {
        parser->parameter_lsb = controller_value;
        parser->selected =
            parser->parameter_msb >= 0 &&
            !(parser->parameter_msb == 127 && parser->parameter_lsb == 127);
        parser->possible_agent_echo =
            parser->possible_agent_echo &&
            strcmp(cc_source, "agent_echo") == 0;
    } else if (controller == 101 || controller == 100) {
        parser->selected = false;
        parser->parameter_msb = -1;
        parser->parameter_lsb = -1;
        parser->data_msb = -1;
        parser->data_lsb = -1;
    } else if (controller == 6 && parser->selected) {
        parser->data_msb = controller_value;
        parser->data_lsb = 0;
        parser->possible_agent_echo =
            parser->possible_agent_echo &&
            strcmp(cc_source, "agent_echo") == 0;
        parameter =
            (parser->parameter_msb << 7) | parser->parameter_lsb;
        value = parser->data_msb << 7;
        resolution_bits = 7;
        emit = true;
    } else if (
        controller == 38 && parser->selected && parser->data_msb >= 0
    ) {
        parser->data_lsb = controller_value;
        parser->possible_agent_echo =
            parser->possible_agent_echo &&
            strcmp(cc_source, "agent_echo") == 0;
        parameter =
            (parser->parameter_msb << 7) | parser->parameter_lsb;
        value = (parser->data_msb << 7) | parser->data_lsb;
        resolution_bits = 14;
        emit = true;
    } else if (
        (controller == 96 || controller == 97) && parser->selected
    ) {
        parameter =
            (parser->parameter_msb << 7) | parser->parameter_lsb;
        NRPNState *current = server_find_nrpn_locked(
            context, channel, parameter, false
        );
        value = current == NULL ? 0 : current->value;
        value += controller == 96 ? 1 : -1;
        if (value < 0) value = 0;
        if (value > 16383) value = 16383;
        parser->possible_agent_echo =
            strcmp(cc_source, "agent_echo") == 0;
        emit = true;
    }

    if (emit) {
        bool echo = parser->possible_agent_echo;
        event_source = echo ? "agent_echo" : "user";
        NRPNState *state = server_find_nrpn_locked(
            context, channel, parameter, true
        );
        if (state != NULL) {
            state->value = value;
            state->resolution_bits = resolution_bits;
            state->updated_at = now;
            if (echo) {
                state->source = "agent";
            } else {
                state->source = "user";
                state->user_updated_at = now;
            }
        }
        server_notify(
            context,
            "{\"v\":1,\"type\":\"event\",\"event\":\"nrpn\","
            "\"source\":\"%s\",\"channel\":%d,\"parameter\":%d,"
            "\"value\":%d,\"resolution_bits\":%d,"
            "\"server_time_ms\":%.3f}",
            event_source, channel, parameter, value, resolution_bits,
            (now - context->started_at) * 1000.0
        );
    }
    pthread_mutex_unlock(&context->state_lock);
}

static void server_receive_message(
    ServerContext *context,
    uint8_t status,
    uint8_t data1,
    uint8_t data2
) {
    int channel = (status & 0x0F) + 1;
    int kind = status & 0xF0;
    double now = monotonic_seconds();
    if (kind == 0x80 || kind == 0x90) {
        bool active = kind == 0x90 && data2 > 0;
        server_update_note(
            context, channel, data1, data2, active, now
        );
    } else if (kind == 0xA0) {
        server_notify(
            context,
            "{\"v\":1,\"type\":\"event\",\"event\":\"poly_pressure\","
            "\"source\":\"user\",\"channel\":%d,\"note\":%d,"
            "\"value\":%d,\"server_time_ms\":%.3f}",
            channel, data1, data2, (now - context->started_at) * 1000.0
        );
    } else if (kind == 0xB0) {
        const char *source = "user";
        pthread_mutex_lock(&context->state_lock);
        CCState *state = &context->cc[channel - 1][data1];
        bool echo =
            state->agent_updated_at > 0 &&
            now - state->agent_updated_at <= 0.250 &&
            state->agent_value == data2;
        state->known = true;
        state->value = data2;
        state->updated_at = now;
        if (echo) {
            source = "agent_echo";
            state->source = "agent";
        } else {
            state->user_updated_at = now;
            state->source = "user";
        }
        if (data1 == 32) {
            context->incoming_bank_lsb[channel - 1] = data2;
        }
        server_notify(
            context,
            "{\"v\":1,\"type\":\"event\",\"event\":\"cc\",\"source\":\"%s\","
            "\"channel\":%d,\"number\":%d,\"value\":%d,"
            "\"server_time_ms\":%.3f}",
            source, channel, data1, data2,
            (now - context->started_at) * 1000.0
        );
        pthread_mutex_unlock(&context->state_lock);
        server_process_nrpn_cc(
            context, channel, data1, data2, source, now
        );
    } else if (kind == 0xC0) {
        int bank;
        pthread_mutex_lock(&context->state_lock);
        bank = context->incoming_bank_lsb[channel - 1];
        context->patch_known = bank >= 0 && bank <= 7;
        context->patch_bank = bank;
        context->patch_number = data1 + 1;
        memset(context->cc, 0, sizeof(context->cc));
        server_reset_nrpn_locked(context);
        server_notify(
            context,
            "{\"v\":1,\"type\":\"event\",\"event\":\"patch\",\"source\":\"user\","
            "\"channel\":%d,\"bank\":\"%c\",\"number\":%d,"
            "\"server_time_ms\":%.3f}",
            channel, bank >= 0 && bank <= 7 ? 'A' + bank : '?',
            data1 + 1, (now - context->started_at) * 1000.0
        );
        pthread_mutex_unlock(&context->state_lock);
    } else if (kind == 0xD0) {
        server_notify(
            context,
            "{\"v\":1,\"type\":\"event\",\"event\":\"channel_pressure\","
            "\"source\":\"user\",\"channel\":%d,\"value\":%d,"
            "\"server_time_ms\":%.3f}",
            channel, data1, (now - context->started_at) * 1000.0
        );
    } else if (kind == 0xE0) {
        int value = data1 | (data2 << 7);
        server_notify(
            context,
            "{\"v\":1,\"type\":\"event\",\"event\":\"pitch_bend\","
            "\"source\":\"user\",\"channel\":%d,\"value\":%d,"
            "\"normalized\":%.6f,\"server_time_ms\":%.3f}",
            channel, value, ((double)value - 8192.0) / 8192.0,
            (now - context->started_at) * 1000.0
        );
    }
}

static int channel_message_data_length(uint8_t status) {
    int kind = status & 0xF0;
    if (kind == 0xC0 || kind == 0xD0) return 1;
    if (kind >= 0x80 && kind <= 0xE0) return 2;
    return 0;
}

static void server_enqueue_incoming(
    ServerContext *context,
    uint8_t status,
    uint8_t data1,
    uint8_t data2
) {
    unsigned int write =
        atomic_load_explicit(&context->incoming_write, memory_order_relaxed);
    unsigned int next = (write + 1U) % MIDI_INPUT_RING_CAPACITY;
    unsigned int read =
        atomic_load_explicit(&context->incoming_read, memory_order_acquire);
    if (next == read) {
        atomic_fetch_add_explicit(
            &context->incoming_dropped, 1U, memory_order_relaxed
        );
        return;
    }
    context->incoming_ring[write] = (IncomingMIDI){
        .status = status,
        .data1 = data1,
        .data2 = data2,
    };
    atomic_store_explicit(
        &context->incoming_write, next, memory_order_release
    );
}

static void server_receive_byte(ServerContext *context, uint8_t byte) {
    if (byte >= 0xF8) {
        return;
    }
    if (byte == 0xF0) {
        context->in_sysex = true;
        context->running_status = 0;
        context->incoming_data_count = 0;
        return;
    }
    if (context->in_sysex) {
        if (byte == 0xF7) {
            context->in_sysex = false;
        }
        return;
    }
    if ((byte & 0x80) != 0) {
        if (byte < 0xF0) {
            context->running_status = byte;
        } else {
            context->running_status = 0;
        }
        context->incoming_data_count = 0;
        return;
    }
    int length = channel_message_data_length(context->running_status);
    if (length == 0) {
        return;
    }
    context->incoming_data[context->incoming_data_count++] = byte;
    if (context->incoming_data_count == length) {
        server_enqueue_incoming(
            context, context->running_status, context->incoming_data[0],
            length == 2 ? context->incoming_data[1] : 0
        );
        context->incoming_data_count = 0;
    }
}

static bool server_dequeue_incoming(
    ServerContext *context,
    IncomingMIDI *message
) {
    unsigned int read =
        atomic_load_explicit(&context->incoming_read, memory_order_relaxed);
    unsigned int write =
        atomic_load_explicit(&context->incoming_write, memory_order_acquire);
    if (read == write) {
        return false;
    }
    *message = context->incoming_ring[read];
    atomic_store_explicit(
        &context->incoming_read,
        (read + 1U) % MIDI_INPUT_RING_CAPACITY,
        memory_order_release
    );
    return true;
}

static void *server_input_consumer(void *opaque_context) {
    ServerContext *context = opaque_context;
    while (
        atomic_load_explicit(
            &context->input_consumer_running, memory_order_acquire
        ) ||
        atomic_load_explicit(
            &context->incoming_read, memory_order_relaxed
        ) != atomic_load_explicit(
            &context->incoming_write, memory_order_acquire
        )
    ) {
        if (
            !atomic_load_explicit(
                &context->protocol_ready, memory_order_acquire
            )
        ) {
            sleep_seconds(0.001);
            continue;
        }
        IncomingMIDI message;
        if (server_dequeue_incoming(context, &message)) {
            server_receive_message(
                context, message.status, message.data1, message.data2
            );
        } else {
            sleep_seconds(0.002);
        }
    }
    return NULL;
}

static void server_midi_read(
    const MIDIPacketList *packet_list,
    void *read_context,
    void *source_context
) {
    (void)source_context;
    ServerContext *context = read_context;
    const MIDIPacket *packet = &packet_list->packet[0];
    for (UInt32 packet_index = 0; packet_index < packet_list->numPackets;
         packet_index++) {
        for (UInt16 byte_index = 0; byte_index < packet->length; byte_index++) {
            server_receive_byte(context, packet->data[byte_index]);
        }
        packet = MIDIPacketNext(packet);
    }
}

static void server_signal_handler(int signal_number) {
    (void)signal_number;
    SERVER_STOP_REQUESTED = 1;
}

static bool server_force_value(
    const char *json,
    bool *force
) {
    *force = false;
    return !json_has_key(json, "force") ||
        json_get_bool(json, "force", force);
}

static void server_transmit_response(
    ServerContext *context,
    const char *id,
    const char *operation
) {
    char escaped[128];
    char fields[256];
    json_escape(operation, escaped, sizeof(escaped));
    snprintf(
        fields, sizeof(fields),
        "\"state\":\"transmitted\",\"op\":\"%s\",\"server_time_ms\":%.3f",
        escaped, (monotonic_seconds() - context->started_at) * 1000.0
    );
    server_response(context, id, true, fields);
}

static int server_handle_line(
    ServerContext *context,
    const char *json,
    bool *shutdown_requested
) {
    char id[256];
    char operation[64];
    json_id_fragment(json, id, sizeof(id));
    if (!json_is_complete_object(json)) {
        server_error(
            context, id, "invalid_json",
            "request must be one complete JSON object"
        );
        return 0;
    }
    if (!json_get_string(json, "op", operation, sizeof(operation))) {
        server_error(
            context, id, "invalid_request",
            "request must contain a string 'op' field"
        );
        return 0;
    }
    long version;
    if (
        json_has_key(json, "v") &&
        (!json_get_long(json, "v", &version) || version != 1)
    ) {
        server_error(
            context, id, "unsupported_version",
            "only protocol version 1 is supported"
        );
        return 0;
    }

    if (strcmp(operation, "ping") == 0) {
        char fields[160];
        snprintf(
            fields, sizeof(fields),
            "\"pong\":true,\"server_time_ms\":%.3f",
            (monotonic_seconds() - context->started_at) * 1000.0
        );
        server_response(context, id, true, fields);
        return 0;
    }

    if (strcmp(operation, "status") == 0) {
        unsigned int dropped = atomic_load_explicit(
            &context->incoming_dropped, memory_order_relaxed
        );
        size_t queued_events = 0;
        size_t active_jobs = 0;
        pthread_mutex_lock(&context->scheduler_lock);
        for (size_t index = 0; index < MAX_SCHEDULED_EVENTS; index++) {
            if (context->scheduled_events[index].used) queued_events++;
        }
        for (size_t index = 0; index < MAX_SCHEDULED_JOBS; index++) {
            if (context->scheduled_jobs[index].used) active_jobs++;
        }
        pthread_mutex_unlock(&context->scheduler_lock);
        uint64_t notification_dropped;
        uint64_t notification_sequence;
        size_t notification_queued;
        bool event_writer;
        pthread_mutex_lock(&context->notification_lock);
        notification_dropped = context->notification_dropped;
        notification_sequence = context->notification_sequence;
        notification_queued = context->notification_count;
        event_writer = context->notification_available;
        pthread_mutex_unlock(&context->notification_lock);
        char fields[512];
        snprintf(
            fields, sizeof(fields),
            "\"connected\":true,\"input_connected\":%s,"
            "\"scheduler\":%s,\"queued_events\":%lu,\"active_jobs\":%lu,"
            "\"event_writer\":%s,\"notification_queued\":%lu,"
            "\"notification_dropped\":%llu,\"event_sequence\":%llu,"
            "\"channel\":%d,\"takeover_seconds\":%.3f,"
            "\"incoming_dropped\":%u,\"server_time_ms\":%.3f",
            context->input_port != 0 && context->source != 0 ? "true" : "false",
            context->scheduler_available ? "true" : "false",
            (unsigned long)queued_events, (unsigned long)active_jobs,
            event_writer ? "true" : "false",
            (unsigned long)notification_queued,
            (unsigned long long)notification_dropped,
            (unsigned long long)notification_sequence,
            context->default_channel, context->takeover_seconds, dropped,
            (monotonic_seconds() - context->started_at) * 1000.0
        );
        server_response(context, id, true, fields);
        return 0;
    }

    if (strcmp(operation, "capabilities") == 0) {
        server_emit_capabilities(context, id);
        return 0;
    }

    if (strcmp(operation, "state") == 0) {
        server_emit_state(context, id);
        return 0;
    }

    if (strcmp(operation, "cancel") == 0) {
        uint64_t job_id;
        if (!json_get_uint64(json, "job", &job_id) || job_id == 0) {
            server_error(
                context, id, "invalid_field",
                "cancel requires a positive integer job ID"
            );
            return 0;
        }
        server_cancel_job(context, id, job_id);
        return 0;
    }

    if (strcmp(operation, "play") == 0) {
        int notes[MAX_CHORD_NOTES];
        size_t note_count = 0;
        long velocity = 100;
        long duration_ms;
        long delay_ms = 0;
        int channel;
        if (
            !json_get_note_array(
                json, notes, MAX_CHORD_NOTES, &note_count
            ) ||
            server_channel(context, json, &channel) != 0 ||
            !json_get_long(json, "duration_ms", &duration_ms) ||
            duration_ms < 10 || duration_ms > 120000 ||
            (json_has_key(json, "velocity") &&
             (!json_get_long(json, "velocity", &velocity) ||
              velocity < 1 || velocity > 127)) ||
            (json_has_key(json, "delay_ms") &&
             (!json_get_long(json, "delay_ms", &delay_ms) ||
              delay_ms < 0 || delay_ms > 600000))
        ) {
            server_error(
                context, id, "invalid_field",
                "play requires 1...16 MIDI notes, duration_ms 10...120000; "
                "velocity 1...127, delay_ms 0...600000, channel 1...16"
            );
            return 0;
        }
        server_queue_play(
            context, id, notes, note_count, (int)velocity, channel,
            duration_ms, delay_ms
        );
        return 0;
    }

    if (strcmp(operation, "ramp") == 0) {
        char name[128];
        int cc = -1;
        long raw_cc;
        double from;
        double to;
        double rate_hz = 30.0;
        long duration_ms;
        long delay_ms = 0;
        int channel;
        bool force;
        if (json_get_string(json, "name", name, sizeof(name))) {
            cc = find_timbre_cc(name);
        } else if (
            json_get_long(json, "number", &raw_cc) &&
            raw_cc >= 0 && raw_cc <= 127
        ) {
            cc = (int)raw_cc;
        }
        if (
            cc < 0 ||
            server_channel(context, json, &channel) != 0 ||
            !server_force_value(json, &force) ||
            !json_get_double(json, "from", &from) ||
            !json_get_double(json, "to", &to) ||
            from < 0 || from > 1 || to < 0 || to > 1 ||
            !json_get_long(json, "duration_ms", &duration_ms) ||
            duration_ms < 50 || duration_ms > 120000 ||
            (json_has_key(json, "delay_ms") &&
             (!json_get_long(json, "delay_ms", &delay_ms) ||
              delay_ms < 0 || delay_ms > 600000)) ||
            (json_has_key(json, "rate_hz") &&
             (!json_get_double(json, "rate_hz", &rate_hz) ||
              rate_hz < 1 || rate_hz > 100))
        ) {
            server_error(
                context, id, "invalid_field",
                "ramp requires a known timbre name or CC number, from/to "
                "0...1, duration_ms 50...120000; rate_hz 1...100, "
                "delay_ms 0...600000, channel 1...16"
            );
            return 0;
        }
        server_queue_ramp(
            context, id, cc, from, to, channel, duration_ms,
            delay_ms, rate_hz, force
        );
        return 0;
    }

    if (
        strcmp(operation, "note_on") == 0 ||
        strcmp(operation, "note_off") == 0
    ) {
        int note;
        int channel;
        long velocity = 100;
        if (
            server_note_value(json, &note) != 0 ||
            server_channel(context, json, &channel) != 0
        ) {
            server_error(
                context, id, "invalid_field",
                "note must be 0...127 or a note name; channel must be 1...16"
            );
            return 0;
        }
        if (
            json_has_key(json, "velocity") &&
            (!json_get_long(json, "velocity", &velocity) ||
             velocity < 1 || velocity > 127)
        ) {
            server_error(
                context, id, "invalid_field",
                "velocity must be an integer from 1 to 127"
            );
            return 0;
        }
        bool active = strcmp(operation, "note_on") == 0;
        if (
            server_send_note(
                context, channel, note, (int)velocity, active, 0
            ) != 0
        ) {
            server_error(context, id, "midi_send_failed", "MIDI send failed");
            return 0;
        }
        server_transmit_response(context, id, operation);
        return 0;
    }

    if (
        strcmp(operation, "cc") == 0 ||
        strcmp(operation, "timbre") == 0
    ) {
        int cc;
        int value;
        int channel;
        bool force;
        if (
            server_channel(context, json, &channel) != 0 ||
            !server_force_value(json, &force)
        ) {
            server_error(
                context, id, "invalid_field",
                "channel must be 1...16 and force must be boolean"
            );
            return 0;
        }
        if (strcmp(operation, "cc") == 0) {
            long requested_cc;
            long requested_value;
            if (
                !json_get_long(json, "number", &requested_cc) ||
                !json_get_long(json, "value", &requested_value) ||
                requested_cc < 0 || requested_cc > 127 ||
                requested_value < 0 || requested_value > 127
            ) {
                server_error(
                    context, id, "invalid_field",
                    "CC number and value must be integers from 0 to 127"
                );
                return 0;
            }
            cc = (int)requested_cc;
            value = (int)requested_value;
        } else {
            char name[128];
            double normalized;
            if (
                !json_get_string(json, "name", name, sizeof(name)) ||
                (cc = find_timbre_cc(name)) < 0 ||
                !json_get_double(json, "value", &normalized) ||
                normalized < 0 || normalized > 1
            ) {
                server_error(
                    context, id, "invalid_field",
                    "timbre requires a known name and value from 0.0 to 1.0"
                );
                return 0;
            }
            value = (int)lround(normalized * 127.0);
        }

        double blocked_for = 0;
        int result = server_send_cc(
            context, channel, cc, value, force, &blocked_for, 0
        );
        if (result == 1) {
            char fields[256];
            snprintf(
                fields, sizeof(fields),
                "\"error\":{\"code\":\"user_takeover\","
                "\"message\":\"recent user movement has priority\","
                "\"retry_after_ms\":%.3f},\"number\":%d",
                blocked_for * 1000.0, cc
            );
            server_response(context, id, false, fields);
        } else if (result < 0) {
            server_error(context, id, "midi_send_failed", "MIDI send failed");
        } else {
            server_transmit_response(context, id, operation);
        }
        return 0;
    }

    if (strcmp(operation, "nrpn") == 0) {
        long parameter;
        long value;
        int channel;
        bool force;
        if (
            server_channel(context, json, &channel) != 0 ||
            !server_force_value(json, &force) ||
            !json_get_long(json, "parameter", &parameter) ||
            !json_get_long(json, "value", &value) ||
            parameter < 0 || parameter > 16383 ||
            value < 0 || value > 16383
        ) {
            server_error(
                context, id, "invalid_field",
                "NRPN parameter/value must be 0...16383; channel 1...16"
            );
            return 0;
        }
        double blocked_for = 0;
        int result = server_send_nrpn_value(
            context, channel, (int)parameter, (int)value,
            force, &blocked_for
        );
        if (result == 1) {
            char fields[256];
            snprintf(
                fields, sizeof(fields),
                "\"error\":{\"code\":\"user_takeover\","
                "\"message\":\"recent user movement has priority\","
                "\"retry_after_ms\":%.3f},\"parameter\":%ld",
                blocked_for * 1000.0, parameter
            );
            server_response(context, id, false, fields);
        } else if (result < 0) {
            server_error(context, id, "midi_send_failed", "MIDI send failed");
        } else {
            server_transmit_response(context, id, operation);
        }
        return 0;
    }

    if (strcmp(operation, "bend") == 0) {
        double normalized;
        int channel;
        if (
            server_channel(context, json, &channel) != 0 ||
            !json_get_double(json, "value", &normalized) ||
            normalized < -1 || normalized > 1
        ) {
            server_error(
                context, id, "invalid_field",
                "bend value must be -1.0...1.0; channel 1...16"
            );
            return 0;
        }
        int value = (int)lround((normalized + 1.0) * 8191.5);
        pthread_mutex_lock(&context->midi_lock);
        int bend_result = send_three(
            context->output_port, context->destination, 0xE0,
            value & 0x7F, (value >> 7) & 0x7F, channel
        );
        pthread_mutex_unlock(&context->midi_lock);
        if (bend_result != 0) {
            server_error(context, id, "midi_send_failed", "MIDI send failed");
        } else {
            server_transmit_response(context, id, operation);
        }
        return 0;
    }

    if (strcmp(operation, "patch") == 0) {
        char bank_name[16];
        long patch;
        int bank;
        int channel;
        if (
            server_channel(context, json, &channel) != 0 ||
            !json_get_string(json, "bank", bank_name, sizeof(bank_name)) ||
            parse_bank(bank_name, &bank) != 0 ||
            !json_get_long(json, "number", &patch) ||
            patch < 1 || patch > 128
        ) {
            server_error(
                context, id, "invalid_field",
                "patch requires bank A...H, number 1...128, channel 1...16"
            );
            return 0;
        }
        if (
            server_select_patch(
                context, channel, bank, (int)patch
            ) != 0
        ) {
            server_error(context, id, "midi_send_failed", "MIDI send failed");
        } else {
            server_transmit_response(context, id, operation);
        }
        return 0;
    }

    if (strcmp(operation, "program") == 0) {
        long program;
        int channel;
        if (
            server_channel(context, json, &channel) != 0 ||
            !json_get_long(json, "number", &program) ||
            program < 0 || program > 127
        ) {
            server_error(
                context, id, "invalid_field",
                "program number must be 0...127; channel 1...16"
            );
            return 0;
        }
        pthread_mutex_lock(&context->midi_lock);
        int program_result = send_program(
            context->output_port, context->destination,
            (int)program, channel
        );
        pthread_mutex_unlock(&context->midi_lock);
        if (program_result != 0) {
            server_error(context, id, "midi_send_failed", "MIDI send failed");
        } else {
            pthread_mutex_lock(&context->state_lock);
            context->patch_number = (int)program + 1;
            context->patch_known =
                context->patch_bank >= 0 && context->patch_bank <= 7;
            memset(context->cc, 0, sizeof(context->cc));
            server_reset_nrpn_locked(context);
            pthread_mutex_unlock(&context->state_lock);
            server_transmit_response(context, id, operation);
        }
        return 0;
    }

    if (strcmp(operation, "panic") == 0) {
        size_t canceled_jobs = server_stop_scheduler(
            context, true, "panic"
        );
        uint64_t event_barrier = 0;
        int panic_result = server_panic(context, &event_barrier);
        bool scheduler_restarted = server_start_scheduler(context);
        if (panic_result != 0) {
            char fields[512];
            snprintf(
                fields, sizeof(fields),
                "\"error\":{\"code\":\"midi_send_failed\","
                "\"message\":\"one or more panic messages failed; "
                "unconfirmed note state was retained\"},"
                "\"canceled_jobs\":%lu,\"scheduler\":%s,"
                "\"event_barrier\":%llu,\"server_time_ms\":%.3f",
                (unsigned long)canceled_jobs,
                scheduler_restarted ? "true" : "false",
                (unsigned long long)event_barrier,
                (monotonic_seconds() - context->started_at) * 1000.0
            );
            server_response(context, id, false, fields);
        } else {
            char fields[256];
            snprintf(
                fields, sizeof(fields),
                "\"state\":\"transmitted\",\"op\":\"panic\","
                "\"canceled_jobs\":%lu,\"scheduler\":%s,"
                "\"event_barrier\":%llu,"
                "\"server_time_ms\":%.3f",
                (unsigned long)canceled_jobs,
                scheduler_restarted ? "true" : "false",
                (unsigned long long)event_barrier,
                (monotonic_seconds() - context->started_at) * 1000.0
            );
            server_response(context, id, true, fields);
        }
        return 0;
    }

    if (strcmp(operation, "set_takeover") == 0) {
        double seconds;
        if (
            !json_get_double(json, "seconds", &seconds) ||
            seconds < 0 || seconds > 3600
        ) {
            server_error(
                context, id, "invalid_field",
                "takeover seconds must be from 0 to 3600"
            );
            return 0;
        }
        pthread_mutex_lock(&context->state_lock);
        context->takeover_seconds = seconds;
        pthread_mutex_unlock(&context->state_lock);
        char fields[128];
        snprintf(fields, sizeof(fields), "\"takeover_seconds\":%.3f", seconds);
        server_response(context, id, true, fields);
        return 0;
    }

    if (
        strcmp(operation, "shutdown") == 0 ||
        strcmp(operation, "quit") == 0
    ) {
        server_response(context, id, true, "\"state\":\"stopping\"");
        *shutdown_requested = true;
        return 1;
    }

    server_error(context, id, "unknown_op", "unknown operation");
    return 0;
}

static int run_server(
    const Options *options,
    MIDIClientRef client,
    MIDIPortRef output_port,
    MIDIEndpointRef destination
) {
    ServerContext context;
    memset(&context, 0, sizeof(context));
    context.client = client;
    context.output_port = output_port;
    context.destination = destination;
    context.default_channel = options->channel;
    context.takeover_seconds = options->takeover;
    context.started_at = monotonic_seconds();
    context.patch_bank = -1;
    for (int channel = 0; channel < 16; channel++) {
        context.incoming_bank_lsb[channel] = -1;
    }
    pthread_mutex_init(&context.output_lock, NULL);
    pthread_mutex_init(&context.state_lock, NULL);
    pthread_mutex_init(&context.midi_lock, NULL);
    pthread_mutex_init(&context.scheduler_lock, NULL);
    pthread_cond_init(&context.scheduler_condition, NULL);
    pthread_mutex_init(&context.notification_lock, NULL);
    pthread_cond_init(&context.notification_condition, NULL);
    server_reset_nrpn_locked(&context);
    context.next_job_id = 1;
    atomic_init(&context.incoming_write, 0);
    atomic_init(&context.incoming_read, 0);
    atomic_init(&context.incoming_dropped, 0);
    atomic_init(&context.input_consumer_running, false);
    atomic_init(&context.protocol_ready, false);

    struct sigaction action;
    struct sigaction old_interrupt;
    struct sigaction old_terminate;
    struct sigaction old_pipe;
    struct sigaction ignore_pipe;
    SERVER_STOP_REQUESTED = 0;
    memset(&action, 0, sizeof(action));
    action.sa_handler = server_signal_handler;
    sigemptyset(&action.sa_mask);
    sigaction(SIGINT, &action, &old_interrupt);
    sigaction(SIGTERM, &action, &old_terminate);
    memset(&ignore_pipe, 0, sizeof(ignore_pipe));
    ignore_pipe.sa_handler = SIG_IGN;
    sigemptyset(&ignore_pipe.sa_mask);
    sigaction(SIGPIPE, &ignore_pipe, &old_pipe);

    char destination_raw[MAX_NAME];
    char destination_json[MAX_NAME * 2];
    destination_name(destination, destination_raw, sizeof(destination_raw));
    json_escape(destination_raw, destination_json, sizeof(destination_json));

    bool consumer_started = false;
    if (options->monitor_input) {
        context.source = find_source(options->device);
        if (context.source != 0) {
            OSStatus status = MIDIInputPortCreate(
                client, CFSTR("HydraControl Input"), server_midi_read,
                &context, &context.input_port
            );
            if (status == noErr) {
                status = MIDIPortConnectSource(
                    context.input_port, context.source, NULL
                );
            }
            if (status == noErr) {
                atomic_store_explicit(
                    &context.input_consumer_running, true,
                    memory_order_release
                );
                if (
                    pthread_create(
                        &context.input_consumer_thread, NULL,
                        server_input_consumer, &context
                    ) == 0
                ) {
                    consumer_started = true;
                } else {
                    status = -1;
                    atomic_store_explicit(
                        &context.input_consumer_running, false,
                        memory_order_release
                    );
                }
            }
            if (status != noErr) {
                fprintf(
                    stderr,
                    "warning: Hydrasynth input monitoring unavailable "
                    "(status %d)\n",
                    status
                );
                if (context.input_port != 0 && context.source != 0) {
                    MIDIPortDisconnectSource(
                        context.input_port, context.source
                    );
                }
                if (context.input_port != 0) {
                    MIDIPortDispose(context.input_port);
                    context.input_port = 0;
                }
                context.source = 0;
            }
        } else {
            fputs(
                "warning: no matching Hydrasynth MIDI input source; "
                "continuing output-only\n",
                stderr
            );
        }
    }

    if (!server_start_notification_writer(&context)) {
        fputs(
            "warning: asynchronous event writer unavailable\n",
            stderr
        );
    }
    if (!server_start_scheduler(&context)) {
        fputs(
            "warning: timed-event scheduler unavailable\n",
            stderr
        );
    }

    char source_json[MAX_NAME * 2];
    if (context.source != 0) {
        char source_raw[MAX_NAME];
        destination_name(context.source, source_raw, sizeof(source_raw));
        json_escape(source_raw, source_json, sizeof(source_json));
    } else {
        source_json[0] = '\0';
    }
    if (context.source != 0) {
        server_emit(
            &context,
            "{\"v\":1,\"type\":\"ready\",\"connected\":true,"
            "\"destination\":\"%s\",\"input_connected\":true,"
            "\"source\":\"%s\",\"scheduler\":%s,\"event_writer\":%s,"
            "\"channel\":%d,"
            "\"takeover_seconds\":%.3f,\"max_line_bytes\":%d}",
            destination_json, source_json,
            context.scheduler_available ? "true" : "false",
            context.notification_available ? "true" : "false",
            options->channel,
            options->takeover, MAX_JSON_LINE
        );
    } else {
        server_emit(
            &context,
            "{\"v\":1,\"type\":\"ready\",\"connected\":true,"
            "\"destination\":\"%s\",\"input_connected\":false,"
            "\"source\":null,\"scheduler\":%s,\"event_writer\":%s,"
            "\"channel\":%d,"
            "\"takeover_seconds\":%.3f,\"max_line_bytes\":%d}",
            destination_json,
            context.scheduler_available ? "true" : "false",
            context.notification_available ? "true" : "false",
            options->channel,
            options->takeover, MAX_JSON_LINE
        );
    }
    atomic_store_explicit(
        &context.protocol_ready, true, memory_order_release
    );

    int result = 0;
    bool shutdown_requested = false;
    char line[MAX_JSON_LINE + 2];
    while (!SERVER_STOP_REQUESTED && !shutdown_requested) {
        errno = 0;
        if (fgets(line, sizeof(line), stdin) == NULL) {
            if (errno == EINTR) {
                clearerr(stdin);
                continue;
            }
            break;
        }
        size_t length = strlen(line);
        bool complete = length > 0 && line[length - 1] == '\n';
        if (!complete && !feof(stdin)) {
            int character;
            while ((character = fgetc(stdin)) != '\n' && character != EOF) {
            }
            server_error(
                &context, "null", "line_too_long",
                "request exceeds the 16384-byte limit"
            );
            continue;
        }
        while (
            length > 0 &&
            (line[length - 1] == '\n' || line[length - 1] == '\r')
        ) {
            line[--length] = '\0';
        }
        const char *trimmed = skip_json_space(line);
        if (*trimmed == '\0') {
            continue;
        }
        (void)server_handle_line(
            &context, trimmed, &shutdown_requested
        );
    }

    (void)server_stop_scheduler(&context, true, "shutdown");

    if (server_panic(&context, NULL) != 0) {
        fputs(
            "warning: one or more shutdown panic messages failed\n",
            stderr
        );
        result = 1;
    }
    sleep_seconds(0.05);

    if (context.input_port != 0 && context.source != 0) {
        MIDIPortDisconnectSource(context.input_port, context.source);
    }
    if (context.input_port != 0) {
        MIDIPortDispose(context.input_port);
        context.input_port = 0;
    }
    if (consumer_started) {
        atomic_store_explicit(
            &context.input_consumer_running, false, memory_order_release
        );
        pthread_join(context.input_consumer_thread, NULL);
    }
    server_stop_notification_writer(&context);
    server_emit(
        &context,
        "{\"v\":1,\"type\":\"event\",\"event\":\"stopping\","
        "\"reason\":\"%s\",\"panic_ok\":%s,\"server_time_ms\":%.3f}",
        shutdown_requested ? "request" :
            (SERVER_STOP_REQUESTED ? "signal" : "eof"),
        result == 0 ? "true" : "false",
        (monotonic_seconds() - context.started_at) * 1000.0
    );
    sigaction(SIGINT, &old_interrupt, NULL);
    sigaction(SIGTERM, &old_terminate, NULL);
    sigaction(SIGPIPE, &old_pipe, NULL);
    pthread_mutex_destroy(&context.state_lock);
    pthread_mutex_destroy(&context.output_lock);
    pthread_mutex_destroy(&context.midi_lock);
    pthread_cond_destroy(&context.scheduler_condition);
    pthread_mutex_destroy(&context.scheduler_lock);
    pthread_cond_destroy(&context.notification_condition);
    pthread_mutex_destroy(&context.notification_lock);
    return result;
}

static int self_test(void) {
    struct {
        const char *text;
        int expected;
    } notes[] = {
        {"C-1", 0}, {"C4", 60}, {"C#4", 61}, {"Db4", 61},
        {"A4", 69}, {"0", 0}, {"127", 127},
    };
    for (size_t index = 0; index < sizeof(notes) / sizeof(notes[0]); index++) {
        int actual = -1;
        if (parse_note(notes[index].text, &actual) != 0 || actual != notes[index].expected) {
            fprintf(
                stderr, "self-test failed: %s => %d, expected %d\n",
                notes[index].text, actual, notes[index].expected
            );
            return 1;
        }
    }
    int invalid;
    if (parse_note("H4", &invalid) == 0 || parse_note("128", &invalid) == 0) {
        fputs("self-test failed: invalid note accepted\n", stderr);
        return 1;
    }
    int bank;
    if (
        parse_bank("A", &bank) != 0 || bank != 0 ||
        parse_bank("h", &bank) != 0 || bank != 7 ||
        parse_bank("4", &bank) != 0 || bank != 3 ||
        parse_bank("I", &bank) == 0
    ) {
        fputs("self-test failed: bank parsing\n", stderr);
        return 1;
    }
    if (
        takeover_remaining_seconds(10, 11, 3) != 2 ||
        takeover_remaining_seconds(10, 14, 3) != 0 ||
        takeover_remaining_seconds(0, 1, 3) != 0 ||
        takeover_remaining_seconds(10, 11, 0) != 0
    ) {
        fputs("self-test failed: takeover remaining calculation\n", stderr);
        return 1;
    }
    if (
        !valid_note_velocity(1) ||
        !valid_note_velocity(127) ||
        valid_note_velocity(0) ||
        valid_note_velocity(128) ||
        !valid_positive_seconds(0.001) ||
        valid_positive_seconds(0) ||
        valid_positive_seconds(-1) ||
        valid_positive_seconds(NAN)
    ) {
        fputs("self-test failed: playback option bounds\n", stderr);
        return 1;
    }

    uint8_t three_bytes[3];
    uint8_t program_bytes[2];
    uint8_t nrpn_bytes[12];
    const uint8_t expected_note[] = {0x90, 60, 100};
    const uint8_t expected_cc[] = {0xBF, 74, 96};
    const uint8_t expected_bend[] = {0xE0, 0, 64};
    const uint8_t expected_program[] = {0xC1, 127};
    const uint8_t expected_nrpn[] = {
        0xB0, 99, 9,
        0xB0, 98, 82,
        0xB0, 6, 64,
        0xB0, 38, 0,
    };
    if (
        encode_three(0x90, 60, 100, 1, three_bytes) != 0 ||
        memcmp(three_bytes, expected_note, sizeof(expected_note)) != 0 ||
        encode_three(0xB0, 74, 96, 16, three_bytes) != 0 ||
        memcmp(three_bytes, expected_cc, sizeof(expected_cc)) != 0 ||
        encode_three(0xE0, 0, 64, 1, three_bytes) != 0 ||
        memcmp(three_bytes, expected_bend, sizeof(expected_bend)) != 0 ||
        encode_program(127, 2, program_bytes) != 0 ||
        memcmp(
            program_bytes, expected_program, sizeof(expected_program)
        ) != 0 ||
        encode_nrpn(1234, 8192, 1, nrpn_bytes) != 0 ||
        memcmp(nrpn_bytes, expected_nrpn, sizeof(expected_nrpn)) != 0
    ) {
        fputs("self-test failed: exact MIDI byte encoding\n", stderr);
        return 1;
    }

    const char *json =
        "{\"v\":1,\"id\":\"r1\",\"op\":\"cc\","
        "\"number\":74,\"value\":96,\"force\":true}";
    char operation[16];
    char id_fragment[64];
    long number;
    uint64_t job_number;
    bool force;
    json_id_fragment(
        "{\"id\":-1.25e+2,\"op\":\"ping\"}",
        id_fragment, sizeof(id_fragment)
    );
    if (
        !json_is_complete_object(json) ||
        !json_get_string(json, "op", operation, sizeof(operation)) ||
        strcmp(operation, "cc") != 0 ||
        !json_get_long(json, "number", &number) || number != 74 ||
        !json_get_bool(json, "force", &force) || !force ||
        strcmp(id_fragment, "-1.25e+2") != 0 ||
        !json_get_uint64(
            "{\"job\":18446744073709551615}", "job", &job_number
        ) ||
        job_number != UINT64_MAX ||
        json_get_uint64("{\"job\":-1}", "job", &job_number) ||
        json_get_uint64("{\"job\":1.5}", "job", &job_number) ||
        json_is_complete_object("{\"op\":\"ping\"} trailing") ||
        json_get_long(json, "missing", &number)
    ) {
        fputs("self-test failed: JSON command parsing\n", stderr);
        return 1;
    }
    const char *valid_json[] = {
        "{\"meta\":{\"x\":[1,{\"s\":\",\"}]},\"op\":\"ping\"}",
        " { \"op\" : \"ping\", \"n\" : -1.25e+2 } ",
        "{\"op\":\"ping\",\"escaped\":\"\\\"\\\\\\/\\b\\f\\n\\r\\t\"}",
        "{\"op\":\"ping\",\"unicode\":\"\\u03bb\"}",
    };
    const char *invalid_json[] = {
        "[]",
        "{\"op\":\"ping\"",
        "{\"op\":\"ping\"} trailing",
        "{\"op\":\"ping\",}",
        "{\"op\":\"ping\" \"id\":1}",
        "{\"op\":\"ping\",\"n\":+1}",
        "{\"op\":\"ping\",\"n\":.5}",
        "{\"op\":\"ping\",\"n\":01}",
        "{\"op\":\"ping\",\"n\":1.}",
        "{\"op\":\"ping\",\"b\":truex}",
        "{\"op\":\"ping\",\"s\":\"\\q\"}",
        "{\"op\":\"ping\",\"s\":\"\\",
    };
    for (
        size_t index = 0;
        index < sizeof(valid_json) / sizeof(valid_json[0]);
        index++
    ) {
        if (!json_is_complete_object(valid_json[index])) {
            fprintf(
                stderr, "self-test failed: valid JSON rejected: %s\n",
                valid_json[index]
            );
            return 1;
        }
    }
    for (
        size_t index = 0;
        index < sizeof(invalid_json) / sizeof(invalid_json[0]);
        index++
    ) {
        if (json_is_complete_object(invalid_json[index])) {
            fprintf(
                stderr, "self-test failed: invalid JSON accepted: %s\n",
                invalid_json[index]
            );
            return 1;
        }
    }

    {
        ServerContext cancel_context;
        memset(&cancel_context, 0, sizeof(cancel_context));
        pthread_mutex_init(&cancel_context.scheduler_lock, NULL);
        pthread_cond_init(&cancel_context.scheduler_condition, NULL);
        cancel_context.scheduled_jobs[0] = (ScheduledJob){
            .used = true,
            .id = 42,
            .pending_events = 2,
            .sent_events = 3,
            .kind = "ramp",
        };
        cancel_context.scheduled_events[0] = (ScheduledEvent){
            .used = true, .armed = true, .job_id = 42,
        };
        cancel_context.scheduled_events[1] = (ScheduledEvent){
            .used = true, .armed = true, .job_id = 42,
        };
        cancel_context.scheduled_events[2] = (ScheduledEvent){
            .used = true, .armed = true, .job_id = 99,
        };
        CanceledJob canceled;
        pthread_mutex_lock(&cancel_context.scheduler_lock);
        CancelJobStatus cancel_status = server_cancel_job_locked(
            &cancel_context, 42, &canceled
        );
        pthread_mutex_unlock(&cancel_context.scheduler_lock);
        if (
            cancel_status != CANCEL_JOB_OK ||
            canceled.id != 42 || strcmp(canceled.kind, "ramp") != 0 ||
            canceled.removed_events != 2 || canceled.sent_events != 3 ||
            cancel_context.scheduled_jobs[0].used ||
            cancel_context.scheduled_events[0].used ||
            cancel_context.scheduled_events[1].used ||
            !cancel_context.scheduled_events[2].used
        ) {
            fputs("self-test failed: targeted ramp cancellation\n", stderr);
            pthread_cond_destroy(&cancel_context.scheduler_condition);
            pthread_mutex_destroy(&cancel_context.scheduler_lock);
            return 1;
        }

        cancel_context.scheduled_jobs[0] = (ScheduledJob){
            .used = true,
            .id = 43,
            .pending_events = 1,
            .sent_events = 1,
            .kind = "play",
        };
        cancel_context.scheduled_events[0] = (ScheduledEvent){
            .used = true, .armed = true, .job_id = 43,
        };
        pthread_mutex_lock(&cancel_context.scheduler_lock);
        cancel_status = server_cancel_job_locked(
            &cancel_context, 43, &canceled
        );
        pthread_mutex_unlock(&cancel_context.scheduler_lock);
        if (
            cancel_status != CANCEL_JOB_ACTIVE_NOTES ||
            !cancel_context.scheduled_jobs[0].used ||
            !cancel_context.scheduled_events[0].used
        ) {
            fputs("self-test failed: active-note cancel guard\n", stderr);
            pthread_cond_destroy(&cancel_context.scheduler_condition);
            pthread_mutex_destroy(&cancel_context.scheduler_lock);
            return 1;
        }

        cancel_context.scheduled_jobs[1] = (ScheduledJob){
            .used = true,
            .id = 44,
            .pending_events = 1,
            .in_flight_events = 1,
            .kind = "ramp",
        };
        pthread_mutex_lock(&cancel_context.scheduler_lock);
        cancel_status = server_cancel_job_locked(
            &cancel_context, 44, &canceled
        );
        pthread_mutex_unlock(&cancel_context.scheduler_lock);
        if (cancel_status != CANCEL_JOB_IN_FLIGHT) {
            fputs("self-test failed: in-flight cancel guard\n", stderr);
            pthread_cond_destroy(&cancel_context.scheduler_condition);
            pthread_mutex_destroy(&cancel_context.scheduler_lock);
            return 1;
        }
        pthread_cond_destroy(&cancel_context.scheduler_condition);
        pthread_mutex_destroy(&cancel_context.scheduler_lock);
    }

    ServerContext input_context;
    memset(&input_context, 0, sizeof(input_context));
    atomic_init(&input_context.incoming_write, 0);
    atomic_init(&input_context.incoming_read, 0);
    atomic_init(&input_context.incoming_dropped, 0);
    uint8_t incoming[] = {
        0xB0, 74, 96, 75, 97,
        0xF0, 1, 2, 0xF7,
        0x90, 60, 110,
    };
    for (size_t index = 0; index < sizeof(incoming); index++) {
        server_receive_byte(&input_context, incoming[index]);
    }
    IncomingMIDI message;
    if (
        !server_dequeue_incoming(&input_context, &message) ||
        message.status != 0xB0 || message.data1 != 74 || message.data2 != 96 ||
        !server_dequeue_incoming(&input_context, &message) ||
        message.status != 0xB0 || message.data1 != 75 || message.data2 != 97 ||
        !server_dequeue_incoming(&input_context, &message) ||
        message.status != 0x90 || message.data1 != 60 || message.data2 != 110 ||
        server_dequeue_incoming(&input_context, &message)
    ) {
        fputs("self-test failed: incoming MIDI parsing\n", stderr);
        return 1;
    }
    puts("All hydractl self-tests passed.");
    return 0;
}

static int run_command(
    const char *command,
    const Options *options,
    MIDIPortRef port,
    MIDIEndpointRef destination
) {
    if (strcmp(command, "randomize") == 0) {
        if (
            options->positional_count != 0 ||
            !valid_positive_seconds(options->duration) ||
            options->duration > 600 ||
            options->step < 0.1 || options->step > 30
        ) {
            fputs(
                "error: randomize expects --duration greater than 0 and "
                "at most 600 seconds, and --step 0.1...30 seconds\n",
                stderr
            );
            return 1;
        }

        size_t control_count =
            sizeof(RANDOM_CONTROLS) / sizeof(RANDOM_CONTROLS[0]);
        size_t previous = control_count;
        size_t patch_count =
            sizeof(RANDOM_PATCHES) / sizeof(RANDOM_PATCHES[0]);
        size_t previous_patch = patch_count;
        double next_patch_at = 0;
        double started = monotonic_seconds();
        while (true) {
            double elapsed = monotonic_seconds() - started;
            if (elapsed >= options->duration) break;

            if (options->randomize_patches && elapsed >= next_patch_at) {
                size_t patch_index;
                do {
                    patch_index = arc4random_uniform((uint32_t)patch_count);
                } while (patch_count > 1 && patch_index == previous_patch);
                previous_patch = patch_index;
                const RandomPatch *patch = &RANDOM_PATCHES[patch_index];

                if (send_cc(port, destination, 0, 0, options->channel) != 0) {
                    return 1;
                }
                sleep_seconds(0.02);
                if (
                    send_cc(
                        port, destination, 32, patch->bank - 'A',
                        options->channel
                    ) != 0
                ) {
                    return 1;
                }
                sleep_seconds(0.02);
                if (
                    send_program(
                        port, destination, patch->patch - 1, options->channel
                    ) != 0
                ) {
                    return 1;
                }
                sleep_seconds(0.35);
                printf(
                    "%5.1fs  PATCH                %c%03d\n",
                    elapsed, patch->bank, patch->patch
                );
                fflush(stdout);
                next_patch_at = elapsed + 9.0 +
                    (double)arc4random_uniform(401) / 100.0;
            }

            size_t index;
            do {
                index = arc4random_uniform((uint32_t)control_count);
            } while (control_count > 1 && index == previous);
            previous = index;

            const RandomControl *control = &RANDOM_CONTROLS[index];
            uint32_t width = (uint32_t)(control->maximum - control->minimum + 1);
            int value = control->minimum + (int)arc4random_uniform(width);
            if (
                send_cc(
                    port, destination, control->cc, value, options->channel
                ) != 0
            ) {
                return 1;
            }
            printf(
                "%5.1fs  %-20s %3d  (%.3f)\n",
                elapsed, control->name, value, (double)value / 127.0
            );
            fflush(stdout);

            double jitter = 0.70 +
                (double)arc4random_uniform(61) / 100.0;
            double pause = options->step * jitter;
            double remaining =
                options->duration - (monotonic_seconds() - started);
            sleep_seconds(fmin(pause, remaining));
        }
        return 0;
    }

    if (strcmp(command, "note") == 0) {
        if (options->positional_count != 1) {
            fputs("error: note expects one note name or MIDI number\n", stderr);
            return 1;
        }
        int note;
        if (parse_note(options->positionals[0], &note) != 0) {
            fprintf(stderr, "error: invalid note '%s'\n", options->positionals[0]);
            return 1;
        }
        if (!valid_note_velocity(options->velocity)) {
            fputs("error: --velocity must be 1...127\n", stderr);
            return 1;
        }
        if (!valid_positive_seconds(options->duration)) {
            fputs("error: --duration must be positive\n", stderr);
            return 1;
        }
        if (
            send_three(
                port, destination, 0x90, note, options->velocity, options->channel
            ) != 0
        ) return 1;
        sleep_seconds(options->duration);
        return send_three(port, destination, 0x80, note, 0, options->channel) != 0;
    }

    if (strcmp(command, "sequence") == 0) {
        if (options->positional_count == 0) {
            fputs("error: sequence expects at least one note\n", stderr);
            return 1;
        }
        if (
            !valid_positive_seconds(options->step) ||
            options->gate < 0 || options->gate > 1
        ) {
            fputs("error: --step must be positive and --gate must be 0...1\n", stderr);
            return 1;
        }
        if (!valid_note_velocity(options->velocity)) {
            fputs("error: --velocity must be 1...127\n", stderr);
            return 1;
        }
        for (int index = 0; index < options->positional_count; index++) {
            int note;
            if (parse_note(options->positionals[index], &note) != 0) {
                fprintf(
                    stderr, "error: invalid note '%s'\n",
                    options->positionals[index]
                );
                return 1;
            }
            if (
                send_three(
                    port, destination, 0x90, note, options->velocity,
                    options->channel
                ) != 0
            ) return 1;
            sleep_seconds(options->step * options->gate);
            if (
                send_three(port, destination, 0x80, note, 0, options->channel) != 0
            ) return 1;
            sleep_seconds(options->step * (1 - options->gate));
        }
        return 0;
    }

    if (strcmp(command, "timbre") == 0) {
        if (options->positional_count != 2) {
            fputs("error: timbre expects NAME and a value from 0.0 to 1.0\n", stderr);
            return 1;
        }
        int cc = find_timbre_cc(options->positionals[0]);
        double normalized;
        if (cc < 0) {
            fprintf(
                stderr, "error: unknown timbre '%s'; run 'hydractl timbre list'\n",
                options->positionals[0]
            );
            return 1;
        }
        if (
            !parse_double_value(options->positionals[1], &normalized) ||
            normalized < 0 || normalized > 1
        ) {
            fputs("error: timbre value must be from 0.0 to 1.0\n", stderr);
            return 1;
        }
        return send_cc(
            port, destination, cc, (int)lround(normalized * 127), options->channel
        ) != 0;
    }

    if (strcmp(command, "cc") == 0) {
        long cc, value;
        if (
            options->positional_count != 2 ||
            !parse_long(options->positionals[0], &cc) ||
            !parse_long(options->positionals[1], &value)
        ) {
            fputs("error: cc expects NUMBER VALUE\n", stderr);
            return 1;
        }
        return send_cc(port, destination, (int)cc, (int)value, options->channel) != 0;
    }

    if (strcmp(command, "nrpn") == 0) {
        long parameter, value;
        if (
            options->positional_count != 2 ||
            !parse_long(options->positionals[0], &parameter) ||
            !parse_long(options->positionals[1], &value)
        ) {
            fputs("error: nrpn expects PARAMETER VALUE\n", stderr);
            return 1;
        }
        return send_nrpn(
            port, destination, (int)parameter, (int)value, options->channel
        ) != 0;
    }

    if (strcmp(command, "bend") == 0) {
        double normalized;
        if (
            options->positional_count != 1 ||
            !parse_double_value(options->positionals[0], &normalized) ||
            normalized < -1 || normalized > 1
        ) {
            fputs("error: bend expects a value from -1.0 to 1.0\n", stderr);
            return 1;
        }
        int value = (int)lround((normalized + 1.0) * 8191.5);
        return send_three(
            port, destination, 0xE0, value & 0x7F, (value >> 7) & 0x7F,
            options->channel
        ) != 0;
    }

    if (strcmp(command, "patch") == 0) {
        long patch;
        int bank;
        if (
            options->positional_count != 2 ||
            parse_bank(options->positionals[0], &bank) != 0 ||
            !parse_long(options->positionals[1], &patch) ||
            patch < 1 || patch > 128
        ) {
            fputs(
                "error: patch expects BANK A...H (or 1...8) and PATCH 1...128\n",
                stderr
            );
            return 1;
        }
        if (send_cc(port, destination, 0, 0, options->channel) != 0) return 1;
        sleep_seconds(0.02);
        if (send_cc(port, destination, 32, bank, options->channel) != 0) return 1;
        sleep_seconds(0.02);
        int result = send_program(
            port, destination, (int)patch - 1, options->channel
        );
        sleep_seconds(0.25);
        return result != 0;
    }

    if (strcmp(command, "program") == 0) {
        long program;
        if (
            options->positional_count != 1 ||
            !parse_long(options->positionals[0], &program)
        ) {
            fputs("error: program expects a value from 0 to 127\n", stderr);
            return 1;
        }
        return send_program(
            port, destination, (int)program, options->channel
        ) != 0;
    }

    if (strcmp(command, "panic") == 0) {
        if (send_cc(port, destination, 64, 0, options->channel) != 0) return 1;
        if (send_cc(port, destination, 123, 0, options->channel) != 0) return 1;
        return send_cc(port, destination, 120, 0, options->channel) != 0;
    }

    fprintf(stderr, "error: unknown command '%s'\n\n%s", command, USAGE);
    return 1;
}

int main(int argc, char **argv) {
    if (
        argc < 2 ||
        strcmp(argv[1], "help") == 0 ||
        strcmp(argv[1], "-h") == 0 ||
        strcmp(argv[1], "--help") == 0
    ) {
        fputs(USAGE, stdout);
        return 0;
    }
    if (strcmp(argv[1], "self-test") == 0) {
        return self_test();
    }
    if (strcmp(argv[1], "list") == 0) {
        return list_destinations();
    }
    if (strcmp(argv[1], "rescan") == 0) {
        MIDIClientRef client;
        if (create_midi_client(&client) != 0) {
            return 1;
        }
        OSStatus status = MIDIRestart();
        MIDIClientDispose(client);
        if (status != noErr) {
            fprintf(
                stderr, "error: restarting CoreMIDI failed (status %d)\n", status
            );
            return 1;
        }
        sleep_seconds(1.0);
        return list_destinations();
    }
    if (
        strcmp(argv[1], "timbre") == 0 &&
        argc == 3 &&
        strcmp(argv[2], "list") == 0
    ) {
        size_t count = sizeof(TIMBRE_CONTROLS) / sizeof(TIMBRE_CONTROLS[0]);
        for (size_t index = 0; index < count; index++) {
            printf("%s: CC %d\n", TIMBRE_CONTROLS[index].name, TIMBRE_CONTROLS[index].cc);
        }
        return 0;
    }

    Options options;
    if (parse_options(argc - 2, argv + 2, &options) != 0) {
        return 1;
    }

    MIDIClientRef client = 0;
    MIDIPortRef port = 0;
    if (create_midi_client(&client) != 0) {
        return 1;
    }

    MIDIEndpointRef destination = find_destination(options.device);
    if (destination == 0) {
        if (options.device != NULL) {
            fprintf(
                stderr,
                "error: no MIDI destination contains '%s'; run 'hydractl list'\n",
                options.device
            );
        } else {
            fputs(
                "error: no MIDI destinations found; run 'hydractl list'\n",
                stderr
            );
        }
        MIDIClientDispose(client);
        return 1;
    }

    OSStatus status = MIDIOutputPortCreate(
        client, CFSTR("HydraControl Output"), &port
    );
    if (status != noErr) {
        fprintf(stderr, "error: creating CoreMIDI output failed (status %d)\n", status);
        if (client != 0) MIDIClientDispose(client);
        return 1;
    }

    int result;
    if (strcmp(argv[1], "serve") == 0) {
        if (options.positional_count != 0) {
            fputs("error: serve does not accept positional arguments\n", stderr);
            result = 1;
        } else {
            result = run_server(&options, client, port, destination);
        }
    } else {
        result = run_command(argv[1], &options, port, destination);
    }
    if (result == 0) {
        // CoreMIDI delivery is asynchronous. Let immediate messages leave the
        // output port before disposing the client that owns it.
        sleep_seconds(0.05);
    }
    MIDIPortDispose(port);
    MIDIClientDispose(client);
    return result;
}
