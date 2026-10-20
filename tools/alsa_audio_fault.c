/* Fault injection for disposable ALSA file/null capture integration tests. */
#define _GNU_SOURCE
#include <alsa/asoundlib.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* libasound may bind its internal snd_card_next calls locally, bypassing the
 * wrapper below. Hide physical device nodes at the libc boundary too, so the
 * real hint parser sees only the private file/null configuration on any host. */
static int isolated_open(const char *symbol_name, const char *path, int flags,
                         mode_t mode) {
    const char *fault = getenv("HYDRA_TEST_FAULT");
    if (fault && strcmp(fault, "list") == 0 &&
        (strncmp(path, "/dev/snd/", 9) == 0 ||
         strncmp(path, "/dev/aload", 10) == 0)) {
        errno = ENOENT;
        return -1;
    }
    void *symbol = dlsym(RTLD_NEXT, symbol_name);
    if (!symbol) { errno = ENOSYS; return -1; }
    int (*original)(const char *, int, ...);
    memcpy(&original, &symbol, sizeof(original));
    return original(path, flags, mode);
}

int open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if ((flags & O_CREAT) || (flags & O_TMPFILE) == O_TMPFILE) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
    }
    return isolated_open("open", path, flags, mode);
}

int open64(const char *path, int flags, ...) {
    mode_t mode = 0;
    if ((flags & O_CREAT) || (flags & O_TMPFILE) == O_TMPFILE) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
    }
    return isolated_open("open64", path, flags, mode);
}

int __open_2(const char *path, int flags) {
    return isolated_open("open", path, flags, 0);
}

int __open64_2(const char *path, int flags) {
    return isolated_open("open64", path, flags, 0);
}

int snd_card_next(int *card) {
    const char *fault = getenv("HYDRA_TEST_FAULT");
    if (fault && strcmp(fault, "list") == 0) {
        /* The private file/null config deliberately has no system ctl aliases.
         * Keep enumeration independent of host cards and never probe them. */
        *card = -1;
        return 0;
    }
    void *symbol = dlsym(RTLD_NEXT, "snd_card_next");
    if (!symbol) return -ENOSYS;
    int (*original)(int *);
    memcpy(&original, &symbol, sizeof(original));
    return original(card);
}

snd_pcm_sframes_t snd_pcm_readi(snd_pcm_t *pcm, void *buffer,
                               snd_pcm_uframes_t size) {
    const char *fault = getenv("HYDRA_TEST_FAULT");
    if (fault && strcmp(fault, "overrun") == 0) return -EPIPE;
    if (fault && strcmp(fault, "timeout") == 0) return -EAGAIN;
    static int calls;
    if (fault && strcmp(fault, "delayed") == 0 && calls++ == 0) {
        struct timespec delay = { .tv_nsec = 110000000 };
        nanosleep(&delay, NULL);
    }
    void *symbol = dlsym(RTLD_NEXT, "snd_pcm_readi");
    if (!symbol) return -ENOSYS;
    snd_pcm_sframes_t (*original)(snd_pcm_t *, void *, snd_pcm_uframes_t);
    memcpy(&original, &symbol, sizeof(original));
    return original(pcm, buffer, size);
}

int snd_pcm_start(snd_pcm_t *pcm) {
    const char *fault = getenv("HYDRA_TEST_FAULT");
    if (fault && strcmp(fault, "list") == 0) abort();
    void *symbol = dlsym(RTLD_NEXT, "snd_pcm_start");
    if (!symbol) return -ENOSYS;
    int (*original)(snd_pcm_t *);
    memcpy(&original, &symbol, sizeof(original));
    return original(pcm);
}

int snd_pcm_open(snd_pcm_t **pcm, const char *name, snd_pcm_stream_t stream,
                 int mode) {
    const char *fault = getenv("HYDRA_TEST_FAULT");
    /* Plugin discovery must not open its backend or try to start a server. */
    if (fault && strcmp(fault, "list") == 0) abort();
    void *symbol = dlsym(RTLD_NEXT, "snd_pcm_open");
    if (!symbol) return -ENOSYS;
    int (*original)(snd_pcm_t **, const char *, snd_pcm_stream_t, int);
    memcpy(&original, &symbol, sizeof(original));
    return original(pcm, name, stream, mode);
}
