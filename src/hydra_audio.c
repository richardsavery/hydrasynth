#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>

#include <ctype.h>
#include <errno.h>
#include <float.h>
#include <limits.h>
#include <math.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define DEFAULT_DEVICE_QUERY "Revolution 2x2"
#define DEFAULT_DURATION_SECONDS 10.0
#define MIN_DURATION_SECONDS 0.1
#define MAX_DURATION_SECONDS 3600.0
#define AUDIO_QUEUE_BUFFER_COUNT 3
#define AUDIO_QUEUE_BUFFER_SECONDS 0.05
#define DEVICE_NAME_CAPACITY 512
#define DEVICE_UID_CAPACITY 1024

typedef struct {
    AudioDeviceID id;
    char name[DEVICE_NAME_CAPACITY];
    char uid[DEVICE_UID_CAPACITY];
    UInt32 input_channels;
    Float64 nominal_sample_rate;
} AudioDeviceInfo;

typedef struct {
    uint64_t frame_count;
    uint64_t sample_count;
    uint64_t clip_count;
    uint64_t nonfinite_count;
    long double sum;
    long double sum_squares;
    double peak;
} MeterStats;

typedef struct {
    AudioStreamBasicDescription format;
    UInt32 selected_channel;
    MeterStats stats;
    atomic_bool stop_requested;
    atomic_bool callback_failed;
    _Atomic(OSStatus) callback_status;
} MeterContext;

typedef struct {
    const char *device_query;
    const char *uid;
    UInt32 channel;
    double duration;
    bool json;
} MeterOptions;

static volatile sig_atomic_t STOP_SIGNAL = 0;

static void usage(FILE *stream) {
    fprintf(stream,
            "Usage:\n"
            "  hydra-audio list [--json]\n"
            "  hydra-audio meter [--device TEXT | --uid UID] [--channel N]\n"
            "                    [--duration SECONDS] [--json]\n"
            "  hydra-audio self-test\n"
            "\n"
            "The meter defaults to the input device whose name contains\n"
            "\"" DEFAULT_DEVICE_QUERY "\", input channel 1, for 10 seconds.\n"
            "Durations must be between %.1f and %.0f seconds. Clipping means\n"
            "an input sample whose absolute value is at least 1.0 (0 dBFS).\n",
            MIN_DURATION_SECONDS,
            MAX_DURATION_SECONDS);
}

static void format_osstatus(OSStatus status, char *buffer, size_t capacity) {
    uint32_t code = (uint32_t)status;
    char fourcc[5];
    fourcc[0] = (char)((code >> 24U) & 0xffU);
    fourcc[1] = (char)((code >> 16U) & 0xffU);
    fourcc[2] = (char)((code >> 8U) & 0xffU);
    fourcc[3] = (char)(code & 0xffU);
    fourcc[4] = '\0';

    bool printable = true;
    for (size_t index = 0; index < 4; ++index) {
        if (!isprint((unsigned char)fourcc[index])) {
            printable = false;
            break;
        }
    }

    if (printable) {
        (void)snprintf(buffer, capacity, "'%s' (%d)", fourcc, (int)status);
    } else {
        (void)snprintf(buffer, capacity, "%d", (int)status);
    }
}

static void report_core_audio_error(const char *operation, OSStatus status) {
    char formatted[64];
    format_osstatus(status, formatted, sizeof(formatted));
    fprintf(stderr, "hydra-audio: %s failed: %s\n", operation, formatted);
}

static bool cf_string_property(AudioObjectID object,
                               AudioObjectPropertySelector selector,
                               AudioObjectPropertyScope scope,
                               char *destination,
                               size_t capacity) {
    AudioObjectPropertyAddress address = {
        .mSelector = selector,
        .mScope = scope,
        .mElement = kAudioObjectPropertyElementMain,
    };
    CFStringRef value = NULL;
    UInt32 size = (UInt32)sizeof(value);
    OSStatus status =
        AudioObjectGetPropertyData(object, &address, 0, NULL, &size, &value);
    if (status != noErr || value == NULL) {
        return false;
    }

    bool copied =
        CFStringGetCString(value, destination, (CFIndex)capacity, kCFStringEncodingUTF8);
    CFRelease(value);
    return copied;
}

static OSStatus input_channel_count(AudioDeviceID device, UInt32 *count_out) {
    AudioObjectPropertyAddress address = {
        .mSelector = kAudioDevicePropertyStreamConfiguration,
        .mScope = kAudioDevicePropertyScopeInput,
        .mElement = kAudioObjectPropertyElementMain,
    };
    UInt32 size = 0;
    OSStatus status =
        AudioObjectGetPropertyDataSize(device, &address, 0, NULL, &size);
    if (status != noErr) {
        return status;
    }
    if (size < sizeof(AudioBufferList)) {
        *count_out = 0;
        return noErr;
    }

    AudioBufferList *buffers = malloc(size);
    if (buffers == NULL) {
        return (OSStatus)kAudio_ParamError;
    }

    status = AudioObjectGetPropertyData(device, &address, 0, NULL, &size, buffers);
    if (status == noErr) {
        uint64_t total = 0;
        for (UInt32 index = 0; index < buffers->mNumberBuffers; ++index) {
            total += buffers->mBuffers[index].mNumberChannels;
        }
        if (total > UINT32_MAX) {
            status = (OSStatus)kAudio_ParamError;
        } else {
            *count_out = (UInt32)total;
        }
    }

    free(buffers);
    return status;
}

static OSStatus nominal_sample_rate(AudioDeviceID device, Float64 *rate_out) {
    AudioObjectPropertyAddress address = {
        .mSelector = kAudioDevicePropertyNominalSampleRate,
        .mScope = kAudioObjectPropertyScopeGlobal,
        .mElement = kAudioObjectPropertyElementMain,
    };
    UInt32 size = (UInt32)sizeof(*rate_out);
    return AudioObjectGetPropertyData(device, &address, 0, NULL, &size, rate_out);
}

static int compare_devices(const void *left_value, const void *right_value) {
    const AudioDeviceInfo *left = left_value;
    const AudioDeviceInfo *right = right_value;
    int name_order = strcmp(left->name, right->name);
    if (name_order != 0) {
        return name_order;
    }
    return strcmp(left->uid, right->uid);
}

static int load_input_devices(AudioDeviceInfo **devices_out, size_t *count_out) {
    AudioObjectPropertyAddress address = {
        .mSelector = kAudioHardwarePropertyDevices,
        .mScope = kAudioObjectPropertyScopeGlobal,
        .mElement = kAudioObjectPropertyElementMain,
    };
    UInt32 size = 0;
    OSStatus status = AudioObjectGetPropertyDataSize(
        kAudioObjectSystemObject, &address, 0, NULL, &size);
    if (status != noErr) {
        report_core_audio_error("reading the audio device list size", status);
        return 1;
    }

    size_t capacity_count = size / sizeof(AudioDeviceID);
    if (capacity_count == 0) {
        *devices_out = NULL;
        *count_out = 0;
        return 0;
    }

    AudioDeviceID *ids = malloc(size);
    AudioDeviceInfo *devices = calloc(capacity_count, sizeof(*devices));
    if (ids == NULL || devices == NULL) {
        fprintf(stderr, "hydra-audio: unable to allocate the audio device list\n");
        free(ids);
        free(devices);
        return 1;
    }

    status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject, &address, 0, NULL, &size, ids);
    if (status != noErr) {
        report_core_audio_error("reading the audio device list", status);
        free(ids);
        free(devices);
        return 1;
    }
    size_t raw_count = size / sizeof(AudioDeviceID);
    if (raw_count > capacity_count) {
        raw_count = capacity_count;
    }

    size_t input_count = 0;
    for (size_t index = 0; index < raw_count; ++index) {
        UInt32 channels = 0;
        status = input_channel_count(ids[index], &channels);
        if (status != noErr || channels == 0) {
            continue;
        }

        AudioDeviceInfo *device = &devices[input_count];
        device->id = ids[index];
        device->input_channels = channels;
        if (!cf_string_property(ids[index],
                                kAudioObjectPropertyName,
                                kAudioObjectPropertyScopeGlobal,
                                device->name,
                                sizeof(device->name))) {
            (void)snprintf(device->name, sizeof(device->name), "(unnamed device)");
        }
        if (!cf_string_property(ids[index],
                                kAudioDevicePropertyDeviceUID,
                                kAudioObjectPropertyScopeGlobal,
                                device->uid,
                                sizeof(device->uid))) {
            device->uid[0] = '\0';
        }
        if (nominal_sample_rate(ids[index], &device->nominal_sample_rate) != noErr ||
            !isfinite(device->nominal_sample_rate) ||
            device->nominal_sample_rate <= 0.0) {
            device->nominal_sample_rate = 0.0;
        }
        ++input_count;
    }

    free(ids);
    qsort(devices, input_count, sizeof(*devices), compare_devices);
    *devices_out = devices;
    *count_out = input_count;
    return 0;
}

static void write_json_string(FILE *stream, const char *value) {
    fputc('"', stream);
    for (const unsigned char *cursor = (const unsigned char *)value;
         *cursor != '\0';
         ++cursor) {
        switch (*cursor) {
            case '"':
                fputs("\\\"", stream);
                break;
            case '\\':
                fputs("\\\\", stream);
                break;
            case '\b':
                fputs("\\b", stream);
                break;
            case '\f':
                fputs("\\f", stream);
                break;
            case '\n':
                fputs("\\n", stream);
                break;
            case '\r':
                fputs("\\r", stream);
                break;
            case '\t':
                fputs("\\t", stream);
                break;
            default:
                if (*cursor < 0x20U) {
                    fprintf(stream, "\\u%04x", (unsigned int)*cursor);
                } else {
                    fputc((int)*cursor, stream);
                }
                break;
        }
    }
    fputc('"', stream);
}

static int run_list(bool json) {
    AudioDeviceInfo *devices = NULL;
    size_t count = 0;
    if (load_input_devices(&devices, &count) != 0) {
        return 1;
    }

    if (json) {
        fputs("{\"devices\":[", stdout);
        for (size_t index = 0; index < count; ++index) {
            if (index != 0) {
                fputc(',', stdout);
            }
            fputs("{\"name\":", stdout);
            write_json_string(stdout, devices[index].name);
            fputs(",\"uid\":", stdout);
            write_json_string(stdout, devices[index].uid);
            fprintf(stdout,
                    ",\"input_channels\":%u,\"nominal_sample_rate\":%.10g}",
                    (unsigned int)devices[index].input_channels,
                    devices[index].nominal_sample_rate);
        }
        fputs("]}\n", stdout);
    } else if (count == 0) {
        puts("No Core Audio input devices found.");
    } else {
        printf("Core Audio input devices (%zu):\n", count);
        for (size_t index = 0; index < count; ++index) {
            printf("%zu. %s\n"
                   "   UID: %s\n"
                   "   Inputs: %u channel%s\n"
                   "   Nominal rate: %.10g Hz\n",
                   index + 1,
                   devices[index].name,
                   devices[index].uid[0] == '\0' ? "(unavailable)"
                                                  : devices[index].uid,
                   (unsigned int)devices[index].input_channels,
                   devices[index].input_channels == 1 ? "" : "s",
                   devices[index].nominal_sample_rate);
        }
    }

    free(devices);
    return 0;
}

static bool contains_case_insensitive(const char *haystack, const char *needle) {
    if (*needle == '\0') {
        return true;
    }

    for (const char *start = haystack; *start != '\0'; ++start) {
        const char *left = start;
        const char *right = needle;
        while (*left != '\0' && *right != '\0' &&
               tolower((unsigned char)*left) == tolower((unsigned char)*right)) {
            ++left;
            ++right;
        }
        if (*right == '\0') {
            return true;
        }
    }
    return false;
}

static bool equal_case_insensitive(const char *left, const char *right) {
    while (*left != '\0' && *right != '\0') {
        if (tolower((unsigned char)*left) != tolower((unsigned char)*right)) {
            return false;
        }
        ++left;
        ++right;
    }
    return *left == '\0' && *right == '\0';
}

static const AudioDeviceInfo *select_device(const AudioDeviceInfo *devices,
                                            size_t count,
                                            const MeterOptions *options) {
    if (options->uid != NULL) {
        for (size_t index = 0; index < count; ++index) {
            if (strcmp(devices[index].uid, options->uid) == 0) {
                return &devices[index];
            }
        }
        fprintf(stderr,
                "hydra-audio: no input device has UID \"%s\"; run "
                "`hydra-audio list` to see available UIDs\n",
                options->uid);
        return NULL;
    }

    const char *query =
        options->device_query == NULL ? DEFAULT_DEVICE_QUERY : options->device_query;
    const AudioDeviceInfo *match = NULL;
    const AudioDeviceInfo *exact_match = NULL;
    size_t match_count = 0;
    size_t exact_count = 0;
    for (size_t index = 0; index < count; ++index) {
        if (equal_case_insensitive(devices[index].name, query)) {
            exact_match = &devices[index];
            ++exact_count;
        }
        if (contains_case_insensitive(devices[index].name, query)) {
            match = &devices[index];
            ++match_count;
        }
    }

    if (exact_count == 1) {
        return exact_match;
    }
    if (match_count == 0) {
        fprintf(stderr,
                "hydra-audio: no input device name contains \"%s\"; connect the "
                "Black Lion Revolution 2x2 or run `hydra-audio list`\n",
                query);
        return NULL;
    }
    if (match_count > 1) {
        fprintf(stderr,
                "hydra-audio: \"%s\" matches %zu input devices; select one with "
                "--uid\n",
                query,
                match_count);
        for (size_t index = 0; index < count; ++index) {
            if (contains_case_insensitive(devices[index].name, query)) {
                fprintf(stderr, "  %s [%s]\n", devices[index].name, devices[index].uid);
            }
        }
        return NULL;
    }
    return match;
}

static bool parse_channel(const char *text, UInt32 *channel_out) {
    errno = 0;
    char *end = NULL;
    unsigned long value = strtoul(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || value == 0 ||
        value > UINT32_MAX) {
        return false;
    }
    *channel_out = (UInt32)value;
    return true;
}

static bool parse_duration(const char *text, double *duration_out) {
    errno = 0;
    char *end = NULL;
    double value = strtod(text, &end);
    if (errno != 0 || end == text || *end != '\0' || !isfinite(value) ||
        value < MIN_DURATION_SECONDS || value > MAX_DURATION_SECONDS) {
        return false;
    }
    *duration_out = value;
    return true;
}

static int parse_meter_options(int argc,
                               char **argv,
                               MeterOptions *options_out) {
    MeterOptions options = {
        .device_query = NULL,
        .uid = NULL,
        .channel = 1,
        .duration = DEFAULT_DURATION_SECONDS,
        .json = false,
    };

    for (int index = 2; index < argc; ++index) {
        if (strcmp(argv[index], "--json") == 0) {
            options.json = true;
        } else if (strcmp(argv[index], "--device") == 0) {
            if (++index >= argc) {
                fprintf(stderr, "hydra-audio: --device requires text\n");
                return 2;
            }
            options.device_query = argv[index];
            if (options.device_query[0] == '\0') {
                fprintf(stderr, "hydra-audio: --device cannot be empty\n");
                return 2;
            }
        } else if (strcmp(argv[index], "--uid") == 0) {
            if (++index >= argc) {
                fprintf(stderr, "hydra-audio: --uid requires a UID\n");
                return 2;
            }
            options.uid = argv[index];
        } else if (strcmp(argv[index], "--channel") == 0) {
            if (++index >= argc ||
                !parse_channel(argv[index], &options.channel)) {
                fprintf(stderr,
                        "hydra-audio: --channel must be a positive integer\n");
                return 2;
            }
        } else if (strcmp(argv[index], "--duration") == 0) {
            if (++index >= argc ||
                !parse_duration(argv[index], &options.duration)) {
                fprintf(stderr,
                        "hydra-audio: --duration must be between %.1f and %.0f "
                        "seconds\n",
                        MIN_DURATION_SECONDS,
                        MAX_DURATION_SECONDS);
                return 2;
            }
        } else if (strcmp(argv[index], "--help") == 0 ||
                   strcmp(argv[index], "-h") == 0) {
            usage(stdout);
            return -1;
        } else {
            fprintf(stderr, "hydra-audio: unknown option: %s\n", argv[index]);
            return 2;
        }
    }

    if (options.uid != NULL && options.device_query != NULL) {
        fprintf(stderr, "hydra-audio: use either --device or --uid, not both\n");
        return 2;
    }

    *options_out = options;
    return 0;
}

static void reset_stats(MeterStats *stats) {
    memset(stats, 0, sizeof(*stats));
}

static void accumulate_interleaved_float(MeterStats *stats,
                                         const Float32 *samples,
                                         UInt32 frame_count,
                                         UInt32 channel_count,
                                         UInt32 selected_channel) {
    for (UInt32 frame = 0; frame < frame_count; ++frame) {
        double sample = samples[(size_t)frame * channel_count + selected_channel];
        ++stats->frame_count;
        if (!isfinite(sample)) {
            ++stats->nonfinite_count;
            continue;
        }

        double magnitude = fabs(sample);
        if (magnitude > stats->peak) {
            stats->peak = magnitude;
        }
        if (magnitude >= 1.0) {
            ++stats->clip_count;
        }
        stats->sum += (long double)sample;
        stats->sum_squares += (long double)sample * (long double)sample;
        ++stats->sample_count;
    }
}

static double meter_rms(const MeterStats *stats) {
    if (stats->sample_count == 0) {
        return 0.0;
    }
    return sqrt((double)(stats->sum_squares / (long double)stats->sample_count));
}

static double meter_dc(const MeterStats *stats) {
    if (stats->sample_count == 0) {
        return 0.0;
    }
    return (double)(stats->sum / (long double)stats->sample_count);
}

static double amplitude_dbfs(double amplitude) {
    if (amplitude <= 0.0) {
        return -INFINITY;
    }
    return 20.0 * log10(amplitude);
}

static void audio_input_callback(void *user_data,
                                 AudioQueueRef queue,
                                 AudioQueueBufferRef buffer,
                                 const AudioTimeStamp *start_time,
                                 UInt32 packet_count,
                                 const AudioStreamPacketDescription *packet_descriptions) {
    (void)start_time;
    (void)packet_count;
    (void)packet_descriptions;

    MeterContext *context = user_data;
    UInt32 bytes_per_frame = context->format.mBytesPerFrame;
    if (bytes_per_frame == 0 ||
        buffer->mAudioDataByteSize % bytes_per_frame != 0) {
        atomic_store_explicit(&context->callback_status,
                              (OSStatus)kAudio_ParamError,
                              memory_order_relaxed);
        atomic_store_explicit(
            &context->callback_failed, true, memory_order_release);
        return;
    }

    UInt32 frames = buffer->mAudioDataByteSize / bytes_per_frame;
    accumulate_interleaved_float(&context->stats,
                                 (const Float32 *)buffer->mAudioData,
                                 frames,
                                 context->format.mChannelsPerFrame,
                                 context->selected_channel);

    if (STOP_SIGNAL == 0 &&
        !atomic_load_explicit(&context->stop_requested, memory_order_acquire)) {
        OSStatus status = AudioQueueEnqueueBuffer(queue, buffer, 0, NULL);
        if (status != noErr &&
            !atomic_load_explicit(&context->stop_requested,
                                  memory_order_acquire)) {
            atomic_store_explicit(
                &context->callback_status, status, memory_order_relaxed);
            atomic_store_explicit(
                &context->callback_failed, true, memory_order_release);
        }
    }
}

static void signal_handler(int signal_number) {
    STOP_SIGNAL = signal_number;
}

static double monotonic_seconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        return 0.0;
    }
    return (double)now.tv_sec + (double)now.tv_nsec / 1000000000.0;
}

static int install_signal_handlers(struct sigaction *old_interrupt,
                                   struct sigaction *old_terminate) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = signal_handler;
    sigemptyset(&action.sa_mask);

    if (sigaction(SIGINT, &action, old_interrupt) != 0) {
        perror("hydra-audio: sigaction(SIGINT)");
        return 1;
    }
    if (sigaction(SIGTERM, &action, old_terminate) != 0) {
        perror("hydra-audio: sigaction(SIGTERM)");
        (void)sigaction(SIGINT, old_interrupt, NULL);
        return 1;
    }
    return 0;
}

static void restore_signal_handlers(const struct sigaction *old_interrupt,
                                    const struct sigaction *old_terminate) {
    (void)sigaction(SIGINT, old_interrupt, NULL);
    (void)sigaction(SIGTERM, old_terminate, NULL);
}

static OSStatus configure_input_queue(const AudioDeviceInfo *device,
                                      UInt32 selected_channel,
                                      MeterContext *context,
                                      AudioQueueRef *queue_out) {
    AudioStreamBasicDescription format;
    memset(&format, 0, sizeof(format));
    format.mSampleRate = device->nominal_sample_rate;
    format.mFormatID = kAudioFormatLinearPCM;
    /* Interleaved is represented by the absence of the non-interleaved flag. */
    format.mFormatFlags = kAudioFormatFlagsNativeFloatPacked;
    format.mFramesPerPacket = 1;
    format.mChannelsPerFrame = device->input_channels;
    format.mBitsPerChannel = 8U * (UInt32)sizeof(Float32);
    format.mBytesPerFrame =
        (UInt32)sizeof(Float32) * format.mChannelsPerFrame;
    format.mBytesPerPacket = format.mBytesPerFrame;

    context->format = format;
    context->selected_channel = selected_channel;
    atomic_init(&context->stop_requested, false);
    atomic_init(&context->callback_failed, false);
    atomic_init(&context->callback_status, noErr);
    reset_stats(&context->stats);

    AudioQueueRef queue = NULL;
    OSStatus status = AudioQueueNewInput(&format,
                                        audio_input_callback,
                                        context,
                                        NULL,
                                        NULL,
                                        0,
                                        &queue);
    if (status != noErr) {
        return status;
    }

    CFStringRef uid =
        CFStringCreateWithCString(NULL, device->uid, kCFStringEncodingUTF8);
    if (uid == NULL) {
        AudioQueueDispose(queue, true);
        return (OSStatus)kAudio_ParamError;
    }
    status = AudioQueueSetProperty(
        queue, kAudioQueueProperty_CurrentDevice, &uid, (UInt32)sizeof(uid));
    CFRelease(uid);
    if (status != noErr) {
        AudioQueueDispose(queue, true);
        return status;
    }

    double requested_frames =
        ceil(format.mSampleRate * AUDIO_QUEUE_BUFFER_SECONDS);
    if (requested_frames < 256.0) {
        requested_frames = 256.0;
    }
    if (requested_frames > 8192.0) {
        requested_frames = 8192.0;
    }
    uint64_t buffer_bytes =
        (uint64_t)requested_frames * (uint64_t)format.mBytesPerFrame;
    if (buffer_bytes == 0 || buffer_bytes > UINT32_MAX) {
        AudioQueueDispose(queue, true);
        return (OSStatus)kAudio_ParamError;
    }

    for (int index = 0; index < AUDIO_QUEUE_BUFFER_COUNT; ++index) {
        AudioQueueBufferRef buffer = NULL;
        status = AudioQueueAllocateBuffer(queue, (UInt32)buffer_bytes, &buffer);
        if (status != noErr) {
            AudioQueueDispose(queue, true);
            return status;
        }
        status = AudioQueueEnqueueBuffer(queue, buffer, 0, NULL);
        if (status != noErr) {
            AudioQueueDispose(queue, true);
            return status;
        }
    }

    *queue_out = queue;
    return noErr;
}

static void print_dbfs_json_value(double amplitude) {
    double value = amplitude_dbfs(amplitude);
    if (isfinite(value)) {
        printf("%.9g", value);
    } else {
        fputs("null", stdout);
    }
}

static void report_meter(const AudioDeviceInfo *device,
                         const MeterOptions *options,
                         const MeterStats *stats,
                         double elapsed,
                         bool interrupted) {
    double rms = meter_rms(stats);
    double dc = meter_dc(stats);
    if (options->json) {
        fputs("{\"type\":\"meter\",\"device\":", stdout);
        write_json_string(stdout, device->name);
        fputs(",\"uid\":", stdout);
        write_json_string(stdout, device->uid);
        fprintf(stdout,
                ",\"channel\":%u,\"sample_rate\":%.10g,\"requested_duration\":"
                "%.9g,\"elapsed\":%.9g,\"frames\":%llu,\"samples\":%llu,"
                "\"rms\":%.9g,\"rms_dbfs\":",
                (unsigned int)options->channel,
                device->nominal_sample_rate,
                options->duration,
                elapsed,
                (unsigned long long)stats->frame_count,
                (unsigned long long)stats->sample_count,
                rms);
        print_dbfs_json_value(rms);
        fprintf(stdout, ",\"peak\":%.9g,\"peak_dbfs\":", stats->peak);
        print_dbfs_json_value(stats->peak);
        fprintf(stdout,
                ",\"dc\":%.9g,\"clip_count\":%llu,\"clipping\":%s,"
                "\"nonfinite_count\":%llu,\"interrupted\":%s}\n",
                dc,
                (unsigned long long)stats->clip_count,
                stats->clip_count == 0 ? "false" : "true",
                (unsigned long long)stats->nonfinite_count,
                interrupted ? "true" : "false");
        return;
    }

    printf("Device: %s\n"
           "UID: %s\n"
           "Input channel: %u of %u\n"
           "Sample rate: %.10g Hz\n"
           "Captured: %.3f s, %llu frames\n"
           "RMS: %.6f",
           device->name,
           device->uid,
           (unsigned int)options->channel,
           (unsigned int)device->input_channels,
           device->nominal_sample_rate,
           elapsed,
           (unsigned long long)stats->frame_count,
           rms);
    if (rms > 0.0) {
        printf(" (%.2f dBFS)\n", amplitude_dbfs(rms));
    } else {
        puts(" (-inf dBFS)");
    }
    printf("Peak: %.6f", stats->peak);
    if (stats->peak > 0.0) {
        printf(" (%.2f dBFS)\n", amplitude_dbfs(stats->peak));
    } else {
        puts(" (-inf dBFS)");
    }
    printf("DC offset: %.9f\n"
           "Clipping: %s (%llu sample%s at or above 0 dBFS)\n",
           dc,
           stats->clip_count == 0 ? "no" : "YES",
           (unsigned long long)stats->clip_count,
           stats->clip_count == 1 ? "" : "s");
    if (stats->nonfinite_count != 0) {
        printf("Non-finite samples ignored: %llu\n",
               (unsigned long long)stats->nonfinite_count);
    }
    if (interrupted) {
        puts("Capture interrupted by signal.");
    }
}

static int run_meter(const MeterOptions *options) {
    AudioDeviceInfo *devices = NULL;
    size_t count = 0;
    if (load_input_devices(&devices, &count) != 0) {
        return 1;
    }
    const AudioDeviceInfo *device = select_device(devices, count, options);
    if (device == NULL) {
        free(devices);
        return 3;
    }
    if (device->uid[0] == '\0') {
        fprintf(stderr,
                "hydra-audio: selected device has no Core Audio UID and cannot "
                "be explicitly routed\n");
        free(devices);
        return 3;
    }
    if (options->channel > device->input_channels) {
        fprintf(stderr,
                "hydra-audio: channel %u is unavailable on %s, which has %u "
                "input channel%s\n",
                (unsigned int)options->channel,
                device->name,
                (unsigned int)device->input_channels,
                device->input_channels == 1 ? "" : "s");
        free(devices);
        return 3;
    }
    if (!isfinite(device->nominal_sample_rate) ||
        device->nominal_sample_rate <= 0.0) {
        fprintf(stderr,
                "hydra-audio: selected device did not report a valid nominal "
                "sample rate\n");
        free(devices);
        return 3;
    }

    MeterContext context;
    memset(&context, 0, sizeof(context));
    AudioQueueRef queue = NULL;
    OSStatus status = configure_input_queue(
        device, options->channel - 1U, &context, &queue);
    if (status != noErr) {
        report_core_audio_error("configuring the selected input device", status);
        free(devices);
        return 4;
    }

    struct sigaction old_interrupt;
    struct sigaction old_terminate;
    STOP_SIGNAL = 0;
    if (install_signal_handlers(&old_interrupt, &old_terminate) != 0) {
        AudioQueueDispose(queue, true);
        free(devices);
        return 1;
    }

    if (!options->json) {
        printf("Metering %s, input channel %u, for %.3f seconds...\n",
               device->name,
               (unsigned int)options->channel,
               options->duration);
        fflush(stdout);
    }

    status = AudioQueueStart(queue, NULL);
    if (status != noErr) {
        report_core_audio_error("starting audio capture", status);
        fputs("hydra-audio: check System Settings > Privacy & Security > "
              "Microphone if access was denied\n",
              stderr);
        restore_signal_handlers(&old_interrupt, &old_terminate);
        AudioQueueDispose(queue, true);
        free(devices);
        return 4;
    }
    /*
     * AudioQueueStart can wait for macOS microphone authorization. Start the
     * requested metering window only after capture is actually running.
     */
    double started_at = monotonic_seconds();

    while (STOP_SIGNAL == 0 &&
           !atomic_load_explicit(&context.callback_failed, memory_order_acquire) &&
           monotonic_seconds() - started_at < options->duration) {
        struct timespec pause = {
            .tv_sec = 0,
            .tv_nsec = 20000000L,
        };
        while (nanosleep(&pause, &pause) != 0 && errno == EINTR &&
               STOP_SIGNAL == 0) {
        }
    }

    atomic_store_explicit(&context.stop_requested, true, memory_order_release);
    OSStatus stop_status = AudioQueueStop(queue, true);
    double elapsed = monotonic_seconds() - started_at;
    OSStatus dispose_status = AudioQueueDispose(queue, true);
    int received_signal = STOP_SIGNAL;
    restore_signal_handlers(&old_interrupt, &old_terminate);

    if (atomic_load_explicit(&context.callback_failed, memory_order_acquire)) {
        report_core_audio_error("processing an audio input buffer",
                                atomic_load_explicit(&context.callback_status,
                                                     memory_order_relaxed));
        free(devices);
        return 4;
    }
    if (stop_status != noErr) {
        report_core_audio_error("stopping audio capture", stop_status);
        free(devices);
        return 4;
    }
    if (dispose_status != noErr) {
        report_core_audio_error("disposing the audio queue", dispose_status);
        free(devices);
        return 4;
    }
    if (context.stats.sample_count == 0) {
        fputs("hydra-audio: capture completed without receiving any samples\n",
              stderr);
        free(devices);
        return 5;
    }

    report_meter(device,
                 options,
                 &context.stats,
                 elapsed,
                 received_signal != 0);
    free(devices);
    return received_signal == SIGINT ? 130
                                     : (received_signal == SIGTERM ? 143 : 0);
}

static int run_self_test(void) {
    const Float32 samples[] = {
        0.0f, -0.25f,
        0.5f, 0.75f,
        -0.5f, -0.75f,
        1.0f, 0.25f,
    };
    MeterStats stats;
    reset_stats(&stats);
    accumulate_interleaved_float(&stats, samples, 4, 2, 0);

    const double expected_rms = sqrt(0.375);
    const double tolerance = 32.0 * DBL_EPSILON;
    if (stats.frame_count != 4 || stats.sample_count != 4 ||
        stats.clip_count != 1 || stats.nonfinite_count != 0 ||
        fabs(stats.peak - 1.0) > tolerance ||
        fabs(meter_dc(&stats) - 0.25) > tolerance ||
        fabs(meter_rms(&stats) - expected_rms) > tolerance) {
        fprintf(stderr,
                "hydra-audio self-test failed: frames=%llu samples=%llu "
                "clips=%llu peak=%.17g dc=%.17g rms=%.17g\n",
                (unsigned long long)stats.frame_count,
                (unsigned long long)stats.sample_count,
                (unsigned long long)stats.clip_count,
                stats.peak,
                meter_dc(&stats),
                meter_rms(&stats));
        return 1;
    }

    puts("hydra-audio self-test: ok");
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2 || strcmp(argv[1], "--help") == 0 ||
        strcmp(argv[1], "-h") == 0 || strcmp(argv[1], "help") == 0) {
        usage(argc < 2 ? stderr : stdout);
        return argc < 2 ? 2 : 0;
    }

    if (strcmp(argv[1], "list") == 0) {
        bool json = false;
        for (int index = 2; index < argc; ++index) {
            if (strcmp(argv[index], "--json") == 0) {
                json = true;
            } else if (strcmp(argv[index], "--help") == 0 ||
                       strcmp(argv[index], "-h") == 0) {
                usage(stdout);
                return 0;
            } else {
                fprintf(stderr,
                        "hydra-audio: unknown list option: %s\n",
                        argv[index]);
                return 2;
            }
        }
        return run_list(json);
    }

    if (strcmp(argv[1], "meter") == 0) {
        MeterOptions options;
        int parse_result = parse_meter_options(argc, argv, &options);
        if (parse_result < 0) {
            return 0;
        }
        if (parse_result != 0) {
            usage(stderr);
            return parse_result;
        }
        return run_meter(&options);
    }

    if (strcmp(argv[1], "self-test") == 0) {
        if (argc != 2) {
            fprintf(stderr, "hydra-audio: self-test takes no options\n");
            return 2;
        }
        return run_self_test();
    }

    fprintf(stderr, "hydra-audio: unknown command: %s\n", argv[1]);
    usage(stderr);
    return 2;
}
