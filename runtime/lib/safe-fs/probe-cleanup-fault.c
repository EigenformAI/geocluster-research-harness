/* Test-only LD_PRELOAD fault: FICLONE fails after the probe's directory has
 * moved and an empty replacement occupies its old name. */
#define _GNU_SOURCE
#include <errno.h>
#include <linux/fs.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

int ioctl(int fd, unsigned long request, ...) {
    if (request == FICLONE) {
        char address[64], target[4096], moved[4096];
        snprintf(address, sizeof(address), "/proc/self/fd/%d", fd);
        ssize_t length = readlink(address, target, sizeof(target) - 1);
        if (length < 0) return -1;
        target[length] = 0;
        char *slash = strrchr(target, '/');
        if (!slash) { errno = EIO; return -1; }
        *slash = 0;
        const char *name = strrchr(target, '/');
        if (name && !strncmp(name + 1, ".gc-file-", 9)) {
            if (snprintf(moved, sizeof(moved), "%s-moved", target) >= (int)sizeof(moved)) { errno = ENAMETOOLONG; return -1; }
            if (rename(target, moved) < 0 || mkdir(target, 0700) < 0) return -1;
            errno = EIO;
            return -1;
        }
    }
    va_list args;
    va_start(args, request);
    unsigned long argument = va_arg(args, unsigned long);
    va_end(args);
    return (int)syscall(SYS_ioctl, fd, request, argument);
}
