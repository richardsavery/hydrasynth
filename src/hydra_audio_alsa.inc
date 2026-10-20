/* Linux ALSA PCM implementation. Included by hydra_audio.c so meter math,
 * selection, CLI parsing and JSON reporting stay identical on both platforms. */
#define ALSA_MAX_CHANNELS 256U
#define ALSA_READ_FRAMES 1024U
#define ALSA_CAPTURE_GRACE_SECONDS 0.25

static void report_alsa_error(const char *operation, int status) {
    fprintf(stderr, "hydra-audio: %s: %s\n", operation, snd_strerror(status));
    if (status == -EBUSY) {
        fputs("hydra-audio: the input is busy; close its other capture client or "
              "select a shared ALSA PCM such as default/pipewire/pulse\n", stderr);
    } else if (status == -EACCES || status == -EPERM) {
        fputs("hydra-audio: check access to the audio device and your desktop "
              "audio session\n", stderr);
    } else if (status == -EPIPE) {
        fputs("hydra-audio: audio capture overran; measurement discarded because "
              "samples were lost. Reduce system load and retry.\n", stderr);
    } else if (status == -ETIMEDOUT) {
        fputs("hydra-audio: the input did not deliver the requested audio frames; "
              "measurement discarded. Check the input and retry.\n", stderr);
    }
}

/* Query capabilities without installing hardware parameters or starting
 * capture. A busy/unavailable device remains listed with unknown (zero) values. */
static void query_alsa_capabilities(AudioDeviceInfo *device) {
    snd_pcm_t *pcm = NULL;
    snd_pcm_hw_params_t *params = NULL;
    if (snd_pcm_open(&pcm, device->uid, SND_PCM_STREAM_CAPTURE,
                     SND_PCM_NONBLOCK) < 0) {
        return;
    }
    if (snd_pcm_hw_params_malloc(&params) >= 0 &&
        snd_pcm_hw_params_any(pcm, params) >= 0) {
        unsigned int minimum = 0;
        unsigned int maximum = 0;
        if (snd_pcm_hw_params_get_channels_min(params, &minimum) >= 0 &&
            snd_pcm_hw_params_get_channels_max(params, &maximum) >= 0) {
            /* Plugins often advertise unbounded channel conversion. Present a
             * useful default, not billions of virtual inputs. */
            unsigned int channels = maximum <= ALSA_MAX_CHANNELS
                                        ? maximum : (minimum > 2 ? minimum : 2);
            if (channels <= ALSA_MAX_CHANNELS) {
                device->input_channels = channels;
            }
        }
        unsigned int rate = 48000;
        int direction = 0;
        if (snd_pcm_hw_params_set_rate_near(pcm, params, &rate, &direction) >= 0) {
            device->nominal_sample_rate = rate;
        }
    }
    snd_pcm_hw_params_free(params);
    (void)snd_pcm_close(pcm);
}

static int append_alsa_device(AudioDeviceInfo **devices, size_t *count,
                              const char *name, const char *uid,
                              bool query_capabilities) {
    if (uid == NULL || uid[0] == '\0' || strlen(uid) >= DEVICE_UID_CAPACITY) {
        return 0;
    }
    for (size_t index = 0; index < *count; ++index) {
        if (strcmp((*devices)[index].uid, uid) == 0) {
            return 0;
        }
    }
    if (*count >= SIZE_MAX / sizeof(**devices)) {
        return -ENOMEM;
    }
    AudioDeviceInfo *grown = realloc(*devices, (*count + 1) * sizeof(**devices));
    if (grown == NULL) {
        return -ENOMEM;
    }
    *devices = grown;
    AudioDeviceInfo *device = &grown[(*count)++];
    memset(device, 0, sizeof(*device));
    snprintf(device->uid, sizeof(device->uid), "%s", uid);
    snprintf(device->name, sizeof(device->name), "%s", name && name[0] ? name : uid);
    for (char *cursor = device->name; *cursor; ++cursor) {
        if (*cursor == '\n' || *cursor == '\r') {
            *cursor = ' ';
        }
    }
    if (query_capabilities) {
        query_alsa_capabilities(device);
    }
    return 0;
}

static int load_input_devices(AudioDeviceInfo **devices_out, size_t *count_out) {
    AudioDeviceInfo *devices = NULL;
    size_t count = 0;
    int card = -1;
    int status = snd_card_next(&card);
    if (status < 0) {
        report_alsa_error("enumerating audio cards", status);
        return 1;
    }
    while (card >= 0) {
        char control_name[32];
        snprintf(control_name, sizeof(control_name), "hw:%d", card);
        snd_ctl_t *control = NULL;
        if (snd_ctl_open(&control, control_name, SND_CTL_NONBLOCK) >= 0) {
            snd_ctl_card_info_t *card_info = NULL;
            snd_pcm_info_t *pcm_info = NULL;
            if (snd_ctl_card_info_malloc(&card_info) < 0 ||
                snd_pcm_info_malloc(&pcm_info) < 0) {
                snd_ctl_card_info_free(card_info);
                snd_pcm_info_free(pcm_info);
                snd_ctl_close(control);
                free(devices);
                return 1;
            }
            if (snd_ctl_card_info(control, card_info) >= 0) {
                int device_number = -1;
                while (snd_ctl_pcm_next_device(control, &device_number) >= 0 &&
                       device_number >= 0) {
                    snd_pcm_info_set_device(pcm_info, (unsigned int)device_number);
                    snd_pcm_info_set_subdevice(pcm_info, 0);
                    snd_pcm_info_set_stream(pcm_info, SND_PCM_STREAM_CAPTURE);
                    if (snd_ctl_pcm_info(control, pcm_info) < 0) {
                        continue;
                    }
                    char uid[DEVICE_UID_CAPACITY];
                    char name[DEVICE_NAME_CAPACITY];
                    /* Card IDs survive normal numeric card ordering changes. */
                    snprintf(uid, sizeof(uid), "hw:CARD=%s,DEV=%d",
                             snd_ctl_card_info_get_id(card_info), device_number);
                    snprintf(name, sizeof(name), "%s — %s",
                             snd_ctl_card_info_get_name(card_info),
                             snd_pcm_info_get_name(pcm_info));
                    status = append_alsa_device(&devices, &count, name, uid, true);
                    if (status < 0) {
                        break;
                    }
                }
            }
            snd_ctl_card_info_free(card_info);
            snd_pcm_info_free(pcm_info);
            snd_ctl_close(control);
            if (status < 0) {
                free(devices);
                return 1;
            }
        }
        status = snd_card_next(&card);
        if (status < 0) {
            report_alsa_error("enumerating audio cards", status);
            free(devices);
            return 1;
        }
    }

    /* Add named desktop/custom PCMs without duplicating the hardware aliases.
     * null is deliberately opt-in via --uid, not a real input in the picker. */
    void **hints = NULL;
    if (snd_device_name_hint(-1, "pcm", &hints) >= 0) {
        for (void **hint = hints; hint && *hint; ++hint) {
            char *name = snd_device_name_get_hint(*hint, "NAME");
            char *description = snd_device_name_get_hint(*hint, "DESC");
            char *direction = snd_device_name_get_hint(*hint, "IOID");
            if (name && strcmp(name, "null") != 0 &&
                (!direction || strcmp(direction, "Output") != 0) &&
                !strstr(name, ":CARD=") && strncmp(name, "hw:", 3) != 0 &&
                strncmp(name, "plughw:", 7) != 0) {
                /* Opening a named plugin can start a desktop audio server or
                 * contact a remote backend. List its hint without opening it;
                 * rate/channels become known when explicitly metering it. */
                status = append_alsa_device(&devices, &count, description, name, false);
            }
            free(name);
            free(description);
            free(direction);
            if (status < 0) {
                break;
            }
        }
        snd_device_name_free_hint(hints);
    }
    if (status < 0) {
        free(devices);
        return 1;
    }
    if (count > 1) {
        qsort(devices, count, sizeof(*devices), compare_devices);
    }
    *devices_out = devices;
    *count_out = count;
    return 0;
}

/* Decode directly to double: converting S32 through float would round its
 * largest positive sample up to 1.0 and falsely report clipping. */
static double alsa_sample_value(const unsigned char *sample,
                                 snd_pcm_format_t format) {
    int bytes = snd_pcm_format_physical_width(format) / 8;
    bool big_endian = snd_pcm_format_big_endian(format) == 1;
    uint32_t value = 0;
    for (int index = 0; index < bytes; ++index) {
        int shift = (big_endian ? bytes - index - 1 : index) * 8;
        value |= (uint32_t)sample[index] << shift;
    }
    if (format == SND_PCM_FORMAT_FLOAT_LE || format == SND_PCM_FORMAT_FLOAT_BE) {
        float floating;
        memcpy(&floating, &value, sizeof(floating));
        return floating;
    }
    int bits = snd_pcm_format_width(format);
    if (format == SND_PCM_FORMAT_U8) {
        return ((double)value - 128.0) / 128.0;
    }
    uint32_t sign = UINT32_C(1) << (bits - 1);
    uint32_t mask = bits == 32 ? UINT32_MAX : (UINT32_C(1) << bits) - 1;
    value &= mask;
    int64_t signed_value = value;
    if (value & sign) {
        signed_value -= INT64_C(1) << bits;
    }
    return (double)signed_value / (double)sign;
}

static void accumulate_alsa_samples(MeterStats *stats, const unsigned char *samples,
                                     size_t frames, unsigned int channels,
                                     unsigned int channel,
                                     snd_pcm_format_t format) {
    size_t sample_bytes = (size_t)snd_pcm_format_physical_width(format) / 8;
    for (size_t frame = 0; frame < frames; ++frame) {
        double sample = alsa_sample_value(
            samples + (frame * channels + channel) * sample_bytes, format);
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

static int configure_alsa_pcm(snd_pcm_t *pcm, AudioDeviceInfo *device,
                               const MeterOptions *options,
                               snd_pcm_format_t *format_out) {
    snd_pcm_hw_params_t *params = NULL;
    int status = snd_pcm_hw_params_malloc(&params);
    if (status < 0) {
        return status;
    }
    status = snd_pcm_hw_params_any(pcm, params);
    if (status >= 0) {
        status = snd_pcm_hw_params_set_access(pcm, params, SND_PCM_ACCESS_RW_INTERLEAVED);
    }
    const snd_pcm_format_t formats[] = {
        SND_PCM_FORMAT_FLOAT_LE, SND_PCM_FORMAT_FLOAT_BE,
        SND_PCM_FORMAT_S32_LE, SND_PCM_FORMAT_S32_BE,
        SND_PCM_FORMAT_S24_3LE, SND_PCM_FORMAT_S24_3BE,
        SND_PCM_FORMAT_S24_LE, SND_PCM_FORMAT_S24_BE,
        SND_PCM_FORMAT_S16_LE, SND_PCM_FORMAT_S16_BE,
        SND_PCM_FORMAT_S8, SND_PCM_FORMAT_U8,
    };
    snd_pcm_format_t format = SND_PCM_FORMAT_UNKNOWN;
    if (status >= 0) {
        for (size_t index = 0; index < sizeof(formats) / sizeof(formats[0]); ++index) {
            if (snd_pcm_hw_params_test_format(pcm, params, formats[index]) == 0) {
                format = formats[index];
                break;
            }
        }
        status = format == SND_PCM_FORMAT_UNKNOWN ? -EINVAL
                     : snd_pcm_hw_params_set_format(pcm, params, format);
    }
    unsigned int channels = options->channel > 2 ? options->channel : 2;
    if (status >= 0) {
        status = snd_pcm_hw_params_set_channels_near(pcm, params, &channels);
        if (status >= 0 && (channels < options->channel || channels > ALSA_MAX_CHANNELS)) {
            fprintf(stderr, "hydra-audio: channel %u is unavailable; negotiated "
                    "input has %u channel(s) (maximum supported: %u)\n",
                    options->channel, channels, ALSA_MAX_CHANNELS);
            status = -EINVAL;
        }
    }
    unsigned int rate = 48000;
    int direction = 0;
    if (status >= 0) {
        status = snd_pcm_hw_params_set_rate_near(pcm, params, &rate, &direction);
    }
    unsigned int period_us = 10000;
    unsigned int buffer_us = 100000;
    if (status >= 0) {
        direction = 0;
        status = snd_pcm_hw_params_set_period_time_near(pcm, params, &period_us, &direction);
    }
    if (status >= 0) {
        direction = 0;
        status = snd_pcm_hw_params_set_buffer_time_near(pcm, params, &buffer_us, &direction);
    }
    if (status >= 0) {
        status = snd_pcm_hw_params(pcm, params);
    }
    snd_pcm_hw_params_free(params);
    if (status >= 0) {
        device->input_channels = channels;
        device->nominal_sample_rate = rate;
        *format_out = format;
        status = snd_pcm_prepare(pcm);
    }
    return status;
}

static void pause_until(double deadline) {
    while (STOP_SIGNAL == 0) {
        double remaining = deadline - monotonic_seconds();
        if (remaining <= 0.0) {
            break;
        }
        /* Check cancellation at least every 20 ms, including synthetic PCMs. */
        if (remaining > 0.02) {
            remaining = 0.02;
        }
        struct timespec pause = {.tv_sec = 0, .tv_nsec = (long)(remaining * 1e9)};
        (void)nanosleep(&pause, NULL);
    }
}

static int run_meter(const MeterOptions *options) {
    if (options->channel > ALSA_MAX_CHANNELS) {
        fprintf(stderr, "hydra-audio: Linux capture supports channels 1 to %u\n",
                ALSA_MAX_CHANNELS);
        return 3;
    }
    AudioDeviceInfo device;
    memset(&device, 0, sizeof(device));
    if (options->uid != NULL) {
        if (strlen(options->uid) >= sizeof(device.uid)) {
            fputs("hydra-audio: ALSA PCM name is too long\n", stderr);
            return 3;
        }
        snprintf(device.uid, sizeof(device.uid), "%s", options->uid);
        snprintf(device.name, sizeof(device.name), "%s", options->uid);
    } else {
        AudioDeviceInfo *devices = NULL;
        size_t count = 0;
        if (load_input_devices(&devices, &count) != 0) {
            return 1;
        }
        const AudioDeviceInfo *selected = select_device(devices, count, options);
        if (selected == NULL) {
            free(devices);
            return 3;
        }
        device = *selected;
        free(devices);
    }

    snd_pcm_t *pcm = NULL;
    int status = snd_pcm_open(&pcm, device.uid, SND_PCM_STREAM_CAPTURE, SND_PCM_NONBLOCK);
    if (status < 0) {
        report_alsa_error("opening the selected ALSA capture PCM", status);
        return 4;
    }
    /* A direct UID should still report the hardware's readable name. */
    snd_pcm_info_t *info = NULL;
    if (options->uid && snd_pcm_info_malloc(&info) >= 0) {
        if (snd_pcm_info(pcm, info) >= 0 && snd_pcm_info_get_name(info)[0]) {
            snprintf(device.name, sizeof(device.name), "%s", snd_pcm_info_get_name(info));
        }
        snd_pcm_info_free(info);
    }
    snd_pcm_format_t format = SND_PCM_FORMAT_UNKNOWN;
    status = configure_alsa_pcm(pcm, &device, options, &format);
    if (status < 0) {
        report_alsa_error("configuring the selected ALSA capture PCM", status);
        snd_pcm_close(pcm);
        return 4;
    }
    size_t sample_bytes = (size_t)snd_pcm_format_physical_width(format) / 8;
    size_t buffer_bytes = ALSA_READ_FRAMES * device.input_channels * sample_bytes;
    unsigned char *buffer = malloc(buffer_bytes);
    if (buffer == NULL) {
        fputs("hydra-audio: unable to allocate audio capture buffer\n", stderr);
        snd_pcm_close(pcm);
        return 1;
    }
    struct sigaction old_interrupt;
    struct sigaction old_terminate;
    STOP_SIGNAL = 0;
    if (install_signal_handlers(&old_interrupt, &old_terminate) != 0) {
        free(buffer);
        snd_pcm_close(pcm);
        return 1;
    }
    if (!options->json) {
        printf("Metering %s, input channel %u, for %.3f seconds...\n",
               device.name, options->channel, options->duration);
        fflush(stdout);
    }
    status = snd_pcm_start(pcm);
    double started_at = monotonic_seconds();
    MeterStats stats;
    reset_stats(&stats);
    uint64_t wanted = (uint64_t)ceil(options->duration * device.nominal_sample_rate);
    /* Hardware delivers complete periods, so the final requested frame may
     * become readable just after the nominal wall-clock duration. Wait for it
     * with bounded grace instead of silently returning a truncated capture. */
    double deadline = started_at + options->duration + ALSA_CAPTURE_GRACE_SECONDS;
    while (status >= 0 && STOP_SIGNAL == 0 && stats.frame_count < wanted) {
        if (monotonic_seconds() >= deadline) {
            status = -ETIMEDOUT;
            break;
        }
        snd_pcm_uframes_t frames = ALSA_READ_FRAMES;
        if (wanted - stats.frame_count < frames) {
            frames = (snd_pcm_uframes_t)(wanted - stats.frame_count);
        }
        /* The ALSA null plugin advances frames without writing bytes. Set the
         * format's silence value so this explicit test source is deterministic. */
        (void)snd_pcm_format_set_silence(format, buffer,
                                        (unsigned int)(frames * device.input_channels));
        snd_pcm_sframes_t received = snd_pcm_readi(pcm, buffer, frames);
        if (received == -EINTR) {
            continue;
        }
        if (received == -EAGAIN || received == 0) {
            double remaining = deadline - monotonic_seconds();
            int timeout_ms = (int)ceil(fmin(remaining, 0.05) * 1000.0);
            if (timeout_ms <= 0) {
                status = -ETIMEDOUT;
                break;
            }
            status = snd_pcm_wait(pcm, timeout_ms);
            if (status == -EINTR) {
                status = 0;
            }
            continue;
        }
        if (received < 0) {
            status = (int)received;
            break;
        }
        accumulate_alsa_samples(&stats, buffer, (size_t)received,
                                device.input_channels, options->channel - 1U, format);
        /* Rate-limit non-clocked PCMs (null/file), while hardware PCMs naturally
         * wait for input. This also bounds synthetic capture's memory/CPU use. */
        pause_until(started_at + (double)stats.frame_count / device.nominal_sample_rate);
    }
    double elapsed = monotonic_seconds() - started_at;
    int drop_status = snd_pcm_drop(pcm);
    int close_status = snd_pcm_close(pcm);
    int received_signal = STOP_SIGNAL;
    restore_signal_handlers(&old_interrupt, &old_terminate);
    free(buffer);
    if (status < 0 || drop_status < 0 || close_status < 0) {
        report_alsa_error("capturing audio", status < 0 ? status
                                            : (drop_status < 0 ? drop_status : close_status));
        return 4;
    }
    if (stats.sample_count == 0) {
        if (received_signal) {
            return received_signal == SIGINT ? 130 : 143;
        }
        fputs("hydra-audio: capture completed without receiving any samples\n", stderr);
        return 5;
    }
    report_meter(&device, options, &stats, elapsed, received_signal != 0);
    return received_signal == SIGINT ? 130 : (received_signal == SIGTERM ? 143 : 0);
}

static int alsa_format_self_test(void) {
    static const struct {
        snd_pcm_format_t format;
        unsigned char sample[4];
        double expected;
    } cases[] = {
        {SND_PCM_FORMAT_S32_LE, {0xff, 0xff, 0xff, 0x7f}, 2147483647.0 / 2147483648.0},
        {SND_PCM_FORMAT_S32_BE, {0x80, 0, 0, 0}, -1.0},
        {SND_PCM_FORMAT_S24_LE, {0, 0, 0x80, 0}, -1.0},
        {SND_PCM_FORMAT_S24_BE, {0, 0x40, 0, 0}, 0.5},
        {SND_PCM_FORMAT_S24_3LE, {0, 0, 0x40, 0}, 0.5},
        {SND_PCM_FORMAT_S24_3BE, {0xff, 0xff, 0xff, 0}, -1.0 / 8388608.0},
        {SND_PCM_FORMAT_S16_LE, {0, 0x80, 0, 0}, -1.0},
        {SND_PCM_FORMAT_S16_BE, {0x40, 0, 0, 0}, 0.5},
        {SND_PCM_FORMAT_S8, {0x80, 0, 0, 0}, -1.0},
        {SND_PCM_FORMAT_U8, {0x80, 0, 0, 0}, 0.0},
        {SND_PCM_FORMAT_FLOAT_LE, {0, 0, 0x80, 0x3e}, 0.25},
        {SND_PCM_FORMAT_FLOAT_BE, {0xbe, 0x80, 0, 0}, -0.25},
    };
    for (size_t index = 0; index < sizeof(cases) / sizeof(cases[0]); ++index) {
        double value = alsa_sample_value(cases[index].sample, cases[index].format);
        if (fabs(value - cases[index].expected) > DBL_EPSILON) {
            fprintf(stderr, "hydra-audio self-test: ALSA format %s failed\n",
                    snd_pcm_format_name(cases[index].format));
            return 1;
        }
    }
    unsigned char full_scale[] = {0xff, 0xff, 0xff, 0x7f, 0, 0, 0, 0x80};
    MeterStats stats;
    reset_stats(&stats);
    accumulate_alsa_samples(&stats, full_scale, 2, 1, 0, SND_PCM_FORMAT_S32_LE);
    if (stats.clip_count != 1 || stats.sample_count != 2) {
        fputs("hydra-audio self-test: integer clipping threshold failed\n", stderr);
        return 1;
    }
    /* Interleaved channels must be isolated and non-finite float input must
     * never leak into JSON metrics. The other channel intentionally clips. */
    const unsigned char floating_stereo[] = {
        0, 0, 0x80, 0x3f, 0, 0, 0x80, 0x3e, /*  1.0,  0.25 */
        0, 0, 0x80, 0xbf, 0, 0, 0x80, 0xbe, /* -1.0, -0.25 */
        0, 0, 0,    0,    0, 0, 0x80, 0x7f, /*  0.0, +inf  */
        0, 0, 0,    0,    0, 0, 0xc0, 0x7f, /*  0.0,  NaN  */
    };
    reset_stats(&stats);
    accumulate_alsa_samples(&stats, floating_stereo, 4, 2, 1, SND_PCM_FORMAT_FLOAT_LE);
    if (stats.frame_count != 4 || stats.sample_count != 2 ||
        stats.nonfinite_count != 2 || stats.clip_count != 0 ||
        fabs(stats.peak - 0.25) > DBL_EPSILON ||
        fabs(meter_rms(&stats) - 0.25) > DBL_EPSILON ||
        fabs(meter_dc(&stats)) > DBL_EPSILON) {
        fputs("hydra-audio self-test: channel selection/non-finite input failed\n", stderr);
        return 1;
    }
    return 0;
}
