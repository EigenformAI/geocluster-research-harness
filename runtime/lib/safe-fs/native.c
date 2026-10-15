#define _GNU_SOURCE
#include <node_api.h>
#include <uv.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/fs.h>
#include <linux/openat2.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/xattr.h>
#include <unistd.h>

/* Handles are capabilities, not fd numbers. Jobs keep JS references and duplicate
 * each fd under its mutex on the worker thread, so close cannot cause fd reuse. */
typedef struct {
    int fd;
    pthread_mutex_t mutex;
    uv_work_t disposal;
} handle;

static const napi_type_tag handle_tag = {0xa8b4c421cff03ac1ULL, 0x00ef54228d23bc2dULL};
enum operation { ROOT, OPEN, STAT, READ, WRITE, SYNC, CLOSE, ENTRIES, MKDIR, UNLINK, CREATE, RENAME, CLONE, ACL, PROBE, REOPEN };
static const char *names[] = {"openRoot", "open", "stat", "read", "write", "sync", "close", "entries", "mkdir", "unlink", "create", "rename", "clone", "acl", "probe", "reopen"};

typedef struct {
    napi_env env;
    napi_async_work work;
    napi_deferred deferred;
    enum operation op;
    handle *handles[2];
    int raw[2];
    napi_ref refs[4];
    size_t ref_count;
    char *paths[2];
    int kind, mode, result_fd, error;
    uint64_t resolve;
    const char *syscall_name;
    const char *reason;
    void *bytes;
    napi_ref buffer_ref;
    size_t buffer_size;
    size_t offset, length;
    int64_t position;
    ssize_t count;
    struct stat stat;
    int flags[3];
    char *listing;
} job;

struct linux_dirent64 {
    uint64_t ino;
    int64_t off;
    unsigned short reclen;
    unsigned char type;
    char name[];
};

static int detach(handle *h) {
    pthread_mutex_lock(&h->mutex);
    int fd = h->fd;
    h->fd = -1;
    pthread_mutex_unlock(&h->mutex);
    return fd;
}
static void dispose_execute(uv_work_t *work) {
    handle *h = work->data;
    int fd = detach(h);
    if (fd >= 0) close(fd); /* Linux closes the fd even on EINTR; never retry. */
}
static void dispose_complete(uv_work_t *work, int status) {
    (void)status;
    handle *h = work->data;
    pthread_mutex_destroy(&h->mutex);
    free(h);
}
static void finalize(napi_env env, void *data, void *hint) {
    (void)hint;
    handle *h = data;
    uv_loop_t *loop = NULL;
    h->disposal.data = h;
    if (napi_get_uv_event_loop(env, &loop) == napi_ok &&
        uv_queue_work(loop, &h->disposal, dispose_execute, dispose_complete) == 0) return;
    /* Environment teardown / queue exhaustion: dispose rather than leak. */
    dispose_execute(&h->disposal);
    dispose_complete(&h->disposal, 0);
}
static napi_value make_handle(napi_env env, int fd) {
    handle *h = calloc(1, sizeof(*h));
    if (!h) { close(fd); napi_throw_error(env, "ENOMEM", "safe-fs: allocating descriptor"); return NULL; }
    h->fd = fd;
    pthread_mutex_init(&h->mutex, NULL);
    napi_value object, value;
    napi_create_object(env, &object);
    napi_create_int32(env, fd, &value);
    napi_set_named_property(env, object, "fd", value);
    napi_wrap(env, object, h, finalize, NULL, NULL);
    napi_type_tag_object(env, object, &handle_tag);
    return object;
}
static int duplicate(job *j, int index) {
    int fd;
    j->syscall_name = "fcntl(F_DUPFD_CLOEXEC)";
    if (j->handles[index]) {
        handle *h = j->handles[index];
        pthread_mutex_lock(&h->mutex);
        fd = h->fd >= 0 ? fcntl(h->fd, F_DUPFD_CLOEXEC, 0) : (errno = EBADF, -1);
        pthread_mutex_unlock(&h->mutex);
    } else fd = fcntl(j->raw[index], F_DUPFD_CLOEXEC, 0);
    return fd;
}
static int open_beneath(job *j, int fd, const char *path, int flags, int mode, uint64_t resolve) {
    struct open_how how = { .flags = (uint64_t)(flags | O_CLOEXEC | O_NOFOLLOW), .mode = (uint64_t)mode,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | resolve };
    j->syscall_name = "openat2";
    return (int)syscall(SYS_openat2, fd, path, &how, sizeof(how));
}
static int stat_fd(job *j, int fd, struct stat *st) {
    j->syscall_name = "fstat";
    return fstat(fd, st);
}
static int same_object(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino && (a->st_mode & S_IFMT) == (b->st_mode & S_IFMT);
}
static int reopen_pinned(job *j, int pinned, int kind) {
    struct stat before, after;
    if (stat_fd(j, pinned, &before) < 0) return -1;
    if ((kind == 1 && !S_ISDIR(before.st_mode)) || (kind == 0 && !S_ISREG(before.st_mode))) {
        errno = S_ISLNK(before.st_mode) ? ELOOP : kind == 1 ? ENOTDIR : EOPNOTSUPP;
        j->syscall_name = "regular-file/directory check";
        return -1;
    }
    /* Reopening the verified O_PATH object never opens a swapped FIFO/device.
     * procfs is used only for this kernel-owned descriptor link, never user paths. */
    char address[64];
    snprintf(address, sizeof(address), "/proc/self/fd/%d", pinned);
    j->syscall_name = "open(pinned procfs descriptor)";
    int readable = open(address, O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOCTTY | (kind == 1 ? O_DIRECTORY : 0));
    if (readable < 0) return -1;
    int stat_result = stat_fd(j, readable, &after);
    if (stat_result < 0 || !same_object(&before, &after)) {
        int saved = stat_result < 0 ? errno : ESTALE;
        close(readable);
        errno = saved;
        return -1;
    }
    return readable;
}
static int open_pinned(job *j, int parent, const char *path, int kind, uint64_t resolve) {
    int pinned = open_beneath(j, parent, path, O_PATH, 0, resolve);
    if (pinned < 0 || kind == 2) return pinned; /* Final-symlink metadata is safe. */
    int readable = reopen_pinned(j, pinned, kind);
    int saved = errno;
    close(pinned);
    errno = saved;
    return readable;
}
static int unsupported(int error) {
    return error == ENOSYS || error == EOPNOTSUPP || error == ENOTTY || error == EINVAL || error == EXDEV;
}
static int acl_present(job *j, int fd, const char *name) {
    j->syscall_name = "fgetxattr(POSIX ACL)";
    ssize_t size = fgetxattr(fd, name, NULL, 0);
    if (size >= 0) return 1;
    if (errno == ENODATA) return 0;
    return -1; /* Unknown / unsupported ACL inspection fails closed. */
}
static int rename_native(job *j, int from, const char *a, int to, const char *b, int no_replace) {
    j->syscall_name = "renameat2";
    return (int)syscall(SYS_renameat2, from, a, to, b, no_replace ? RENAME_NOREPLACE : 0);
}
static void probe(job *j, int root) {
    int dir = -1, source = -1, target = -1, clash = -1;
    int saved = 0, source_moved = 0, have_created = 0, may_remove = 0;
    struct stat a, b, current, created;
    const char bytes[] = "safe-fs clone probe";
    char copy[sizeof(bytes)];
    j->syscall_name = "mkdirat(probe)";
    if (mkdirat(root, j->paths[0], 0700) < 0) { j->error = errno; return; }
    if (fstatat(root, j->paths[0], &created, AT_SYMLINK_NOFOLLOW) < 0) { saved = errno; goto cleanup; }
    if (!S_ISDIR(created.st_mode) || created.st_uid != geteuid() || (created.st_mode & 0022)) { saved = EACCES; goto cleanup; }
    have_created = 1;
    dir = open_beneath(j, root, j->paths[0], O_RDONLY | O_DIRECTORY, 0, 0);
    if (dir < 0) { if (!unsupported(errno)) saved = errno; goto cleanup; }
    if (fstat(dir, &a) < 0) { saved = errno; goto cleanup; }
    if (!same_object(&created, &a)) { saved = ESTALE; goto cleanup; }
    j->flags[0] = 1;
    source = open_beneath(j, dir, "source", O_RDWR | O_CREAT | O_EXCL, 0600, 0);
    if (source < 0) { saved = errno; goto cleanup; }
    target = open_beneath(j, dir, "target", O_RDWR | O_CREAT | O_EXCL, 0600, 0);
    if (target < 0) { saved = errno; goto cleanup; }
    clash = open_beneath(j, dir, "clash", O_RDWR | O_CREAT | O_EXCL, 0600, 0);
    if (clash < 0) { saved = errno; goto cleanup; }
    j->syscall_name = "write/fstat(probe)";
    if (write(source, bytes, sizeof(bytes)) != (ssize_t)sizeof(bytes) || fstat(source, &a) < 0 || fstat(clash, &b) < 0) { saved = errno ? errno : EIO; goto cleanup; }
    if (rename_native(j, dir, "source", dir, "clash", 1) == 0) { saved = EIO; goto cleanup; }
    if (errno == EEXIST) {
        if (fstatat(dir, "source", &current, AT_SYMLINK_NOFOLLOW) < 0 || !same_object(&a, &current) ||
            fstatat(dir, "clash", &current, AT_SYMLINK_NOFOLLOW) < 0 || !same_object(&b, &current)) { saved = EIO; goto cleanup; }
        if (rename_native(j, dir, "source", dir, "moved", 1) < 0) { saved = errno; goto cleanup; }
        source_moved = 1;
        if (fstatat(dir, "moved", &current, AT_SYMLINK_NOFOLLOW) < 0 || !same_object(&a, &current)) { saved = EIO; goto cleanup; }
        j->flags[1] = 1;
    } else if (!unsupported(errno)) { saved = errno; goto cleanup; }
    j->syscall_name = "ioctl(FICLONE)";
    if (ioctl(target, FICLONE, source) == 0) {
        if (fstat(target, &current) < 0 || current.st_size != (off_t)sizeof(bytes) ||
            pread(target, copy, sizeof(copy), 0) != (ssize_t)sizeof(copy) || memcmp(bytes, copy, sizeof(bytes))) { saved = EIO; goto cleanup; }
        if (pwrite(source, "!", 1, 0) != 1 || pread(target, copy, sizeof(copy), 0) != (ssize_t)sizeof(copy) || memcmp(bytes, copy, sizeof(bytes))) { saved = EIO; goto cleanup; }
        j->flags[2] = 1;
    } else if (!unsupported(errno)) saved = errno;
cleanup:
    if (dir >= 0) {
        const char *children[] = {source_moved ? "moved" : "source", "target", "clash"};
        int fds[] = {source, target, clash};
        for (size_t i = 0; i < 3; i++) if (fds[i] >= 0 && unlinkat(dir, children[i], 0) < 0 && errno != ENOENT && !saved) saved = errno;
        if (fstat(dir, &a) < 0 || !have_created || !same_object(&created, &a)) {
            have_created = 0;
            if (!saved) saved = ESTALE;
        }
        close(dir);
    }
    /* Cleanup authority is independent of the first operational error. A failed
     * identity comparison never authorizes removal of a replacement entry. */
    if (have_created && fstatat(root, j->paths[0], &b, AT_SYMLINK_NOFOLLOW) == 0 && same_object(&created, &b)) may_remove = 1;
    else if (!saved) saved = ESTALE;
    if (may_remove && unlinkat(root, j->paths[0], AT_REMOVEDIR) < 0 && !saved) saved = errno;
    if (source >= 0) close(source);
    if (target >= 0) close(target);
    if (clash >= 0) close(clash);
    if (saved) j->error = saved;
}
static void execute(napi_env env, void *data) {
    (void)env;
    job *j = data;
    int a = -1, b = -1, result = 0;
    j->syscall_name = names[j->op];
    if (j->op == CLOSE) {
        a = detach(j->handles[0]);
        if (a >= 0 && close(a) < 0) j->error = errno;
        return;
    }
    if (j->op == ROOT) {
        j->syscall_name = "open(/)";
        a = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    } else a = duplicate(j, 0);
    if (a < 0) { j->error = errno; return; }
    if (j->op == RENAME || j->op == CLONE) {
        b = duplicate(j, 1);
        if (b < 0) { j->error = errno; close(a); return; }
    }
    switch (j->op) {
        case ROOT: j->result_fd = open_beneath(j, a, j->paths[0][1] ? j->paths[0] + 1 : ".", O_RDONLY | O_DIRECTORY, 0, 0); result = j->result_fd; break;
        case OPEN: j->result_fd = open_pinned(j, a, j->paths[0], j->kind, j->resolve); result = j->result_fd; break;
        case REOPEN: j->result_fd = reopen_pinned(j, a, j->kind); result = j->result_fd; break;
        case STAT: result = stat_fd(j, a, &j->stat); break;
        case READ: case WRITE:
            j->syscall_name = j->op == READ ? "pread/read" : "pwrite/write";
            do {
                if (j->op == READ) j->count = j->position < 0 ? read(a, j->bytes, j->length) : pread(a, j->bytes, j->length, j->position);
                else j->count = j->position < 0 ? write(a, j->bytes, j->length) : pwrite(a, j->bytes, j->length, j->position);
            } while (j->count < 0 && errno == EINTR);
            result = j->count < 0 ? -1 : 0;
            break;
        case SYNC: j->syscall_name = "fsync"; result = fsync(a); break;
        case ENTRIES:
            j->listing = malloc(32768);
            if (!j->listing) { errno = ENOMEM; result = -1; break; }
            j->syscall_name = "getdents64";
            do { j->count = syscall(SYS_getdents64, a, j->listing, 32768); } while (j->count < 0 && errno == EINTR);
            result = j->count < 0 ? -1 : 0;
            break;
        case MKDIR: j->syscall_name = "mkdirat"; result = mkdirat(a, j->paths[0], j->mode); break;
        case UNLINK: j->syscall_name = "unlinkat"; result = unlinkat(a, j->paths[0], j->kind ? AT_REMOVEDIR : 0); break;
        case CREATE: j->result_fd = open_beneath(j, a, j->paths[0], O_RDWR | O_CREAT | O_EXCL, j->mode, j->resolve); result = j->result_fd; break;
        case RENAME: result = rename_native(j, a, j->paths[0], b, j->paths[1], j->kind); break;
        case CLONE: {
            struct stat source, target;
            if (stat_fd(j, a, &source) < 0 || stat_fd(j, b, &target) < 0) { result = -1; break; }
            if (!S_ISREG(source.st_mode) || !S_ISREG(target.st_mode) || same_object(&source, &target) || target.st_nlink != 1 || target.st_size != 0) { errno = EINVAL; result = -1; break; }
            j->syscall_name = "ioctl(FICLONE)";
            if (ioctl(b, FICLONE, a) == 0) j->flags[0] = 1;
            else if (!unsupported(errno)) result = -1;
            break;
        }
        case ACL:
            j->flags[0] = acl_present(j, a, "system.posix_acl_access");
            if (j->flags[0] < 0) { result = -1; break; }
            if (stat_fd(j, a, &j->stat) < 0) { result = -1; break; }
            if (S_ISDIR(j->stat.st_mode)) {
                j->flags[1] = acl_present(j, a, "system.posix_acl_default");
                if (j->flags[1] < 0) result = -1;
            }
            break;
        case PROBE: probe(j, a); break;
        case CLOSE: break;
    }
    if (result < 0) j->error = errno;
    close(a);
    if (b >= 0) close(b);
}

static void property(napi_env env, napi_value object, const char *name, napi_value value) { napi_set_named_property(env, object, name, value); }
static napi_value text(napi_env env, const char *value) { napi_value out; napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &out); return out; }
static napi_value boolean(napi_env env, int value) { napi_value out; napi_get_boolean(env, value != 0, &out); return out; }
static void bigint(napi_env env, napi_value object, const char *name, int64_t value) { napi_value out; napi_create_bigint_int64(env, value, &out); property(env, object, name, out); }
static void unsigned_bigint(napi_env env, napi_value object, const char *name, uint64_t value) { napi_value out; napi_create_bigint_uint64(env, value, &out); property(env, object, name, out); }
static napi_value stat_value(napi_env env, const struct stat *s) {
    napi_value out;
    napi_create_object(env, &out);
    unsigned_bigint(env, out, "dev", s->st_dev); unsigned_bigint(env, out, "ino", s->st_ino);
    unsigned_bigint(env, out, "mode", s->st_mode); unsigned_bigint(env, out, "nlink", s->st_nlink);
    unsigned_bigint(env, out, "uid", s->st_uid); unsigned_bigint(env, out, "gid", s->st_gid);
    unsigned_bigint(env, out, "rdev", s->st_rdev);
    bigint(env, out, "size", s->st_size); bigint(env, out, "blksize", s->st_blksize); bigint(env, out, "blocks", s->st_blocks);
    /* Seconds and nanoseconds cross the boundary separately. JS BigInt combines
     * them without signed C overflow for valid filesystem dates beyond 2262. */
    bigint(env, out, "atimeSeconds", s->st_atim.tv_sec); bigint(env, out, "atimeNanoseconds", s->st_atim.tv_nsec);
    bigint(env, out, "mtimeSeconds", s->st_mtim.tv_sec); bigint(env, out, "mtimeNanoseconds", s->st_mtim.tv_nsec);
    bigint(env, out, "ctimeSeconds", s->st_ctim.tv_sec); bigint(env, out, "ctimeNanoseconds", s->st_ctim.tv_nsec);
    bigint(env, out, "birthtimeNs", 0);
    return out;
}
static napi_value error_value(job *j, int error) {
    napi_value out, number;
    const char *code = error == EOPNOTSUPP ? "EOPNOTSUPP" : uv_err_name(-error);
    char message[512];
    snprintf(message, sizeof(message), "safe-fs.%s: %s: %s", names[j->op], j->syscall_name ? j->syscall_name : names[j->op], strerror(error));
    napi_create_error(j->env, text(j->env, code), text(j->env, message), &out);
    napi_create_int32(j->env, error, &number);
    property(j->env, out, "errno", number);
    property(j->env, out, "syscall", text(j->env, j->syscall_name ? j->syscall_name : names[j->op]));
    if (j->reason) property(j->env, out, "reason", text(j->env, j->reason));
    property(j->env, out, "agent", text(j->env, "file-service"));
    snprintf(message, sizeof(message), "safe-fs.%s", names[j->op]);
    property(j->env, out, "tool", text(j->env, message));
    property(j->env, out, "action", text(j->env, j->reason ? "Keep read buffers attached and unchanged until the operation settles." : "Inspect the path, descriptor lifetime, and Linux filesystem support before retrying."));
    return out;
}
static void release(job *j) {
    for (size_t i = 0; i < j->ref_count; i++) napi_delete_reference(j->env, j->refs[i]);
    free(j->paths[0]); free(j->paths[1]); free(j->listing); free(j->bytes);
    if (j->work) napi_delete_async_work(j->env, j->work);
    free(j);
}
static void complete(napi_env env, napi_status status, void *data) {
    job *j = data;
    napi_value out;
    napi_get_undefined(env, &out);
    if (status != napi_ok && !j->error) j->error = ECANCELED;
    if (!j->error && j->op == READ) {
        napi_value buffer;
        void *destination = NULL;
        size_t size = 0;
        /* The JS view can be detached while the worker runs. Retaining a Buffer
         * reference is not sufficient: workers use private native storage, and
         * the completion callback reacquires/validates the destination view. */
        if (napi_get_reference_value(env, j->buffer_ref, &buffer) != napi_ok ||
            napi_get_buffer_info(env, buffer, &destination, &size) != napi_ok ||
            size != j->buffer_size || (j->count > 0 && !destination)) {
            j->error = EINVAL; j->reason = "detached_buffer";
            j->syscall_name = "Buffer backing-store check";
        } else if ((size_t)j->count > j->length) j->error = EIO;
        else if (j->count > 0) memcpy((char *)destination + j->offset, j->bytes, (size_t)j->count);
    }
    if (j->error) napi_reject_deferred(env, j->deferred, error_value(j, j->error));
    else {
        switch (j->op) {
            case ROOT: case OPEN: case CREATE: case REOPEN: out = make_handle(env, j->result_fd); break;
            case STAT: out = stat_value(env, &j->stat); break;
            case READ: case WRITE: napi_create_double(env, (double)j->count, &out); break;
            case CLONE: out = boolean(env, j->flags[0]); break;
            case ACL:
                napi_create_object(env, &out);
                property(env, out, "access", boolean(env, j->flags[0]));
                property(env, out, "default", boolean(env, j->flags[1]));
                break;
            case PROBE:
                napi_create_object(env, &out);
                property(env, out, "openat2", boolean(env, j->flags[0]));
                property(env, out, "noReplace", boolean(env, j->flags[1]));
                property(env, out, "reflink", boolean(env, j->flags[2]));
                break;
            case ENTRIES: {
                napi_create_array(env, &out);
                size_t offset = 0;
                uint32_t index = 0;
                while (offset < (size_t)j->count) {
                    struct linux_dirent64 *entry = (struct linux_dirent64 *)(j->listing + offset);
                    size_t prefix = __builtin_offsetof(struct linux_dirent64, name);
                    if ((size_t)j->count - offset < prefix + 1 || entry->reclen < prefix + 1 || entry->reclen > (size_t)j->count - offset) { j->error = EIO; break; }
                    size_t size = strnlen(entry->name, entry->reclen - prefix);
                    if (size == entry->reclen - prefix) { j->error = EIO; break; }
                    if (strcmp(entry->name, ".") && strcmp(entry->name, "..")) {
                        napi_value item, name, type;
                        napi_create_object(env, &item);
                        napi_create_buffer_copy(env, size, entry->name, NULL, &name);
                        napi_create_uint32(env, entry->type, &type);
                        property(env, item, "name", name); property(env, item, "type", type);
                        napi_set_element(env, out, index++, item);
                    }
                    offset += entry->reclen;
                }
                break;
            }
            default: break;
        }
        if (j->error) napi_reject_deferred(env, j->deferred, error_value(j, j->error));
        else if (out) napi_resolve_deferred(env, j->deferred, out);
    }
    release(j);
}
static int keep(job *j, napi_value value) {
    if (j->ref_count >= 4 || napi_create_reference(j->env, value, 1, &j->refs[j->ref_count]) != napi_ok) return 0;
    j->ref_count++;
    return 1;
}
static int descriptor(job *j, napi_value value, int index, int raw_allowed) {
    napi_valuetype type;
    if (napi_typeof(j->env, value, &type) != napi_ok) return 0;
    if (type == napi_number && raw_allowed) {
        double fd;
        if (napi_get_value_double(j->env, value, &fd) != napi_ok || !(fd >= 0 && fd <= INT_MAX) || fd != (int)fd) return 0;
        j->raw[index] = (int)fd;
        return 1;
    }
    bool tagged = false;
    if (type != napi_object || napi_check_object_type_tag(j->env, value, &handle_tag, &tagged) != napi_ok || !tagged) return 0;
    return napi_unwrap(j->env, value, (void **)&j->handles[index]) == napi_ok && keep(j, value);
}
static char *string(napi_env env, napi_value value) {
    napi_valuetype type;
    size_t size, actual;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_string || napi_get_value_string_utf8(env, value, NULL, 0, &size) != napi_ok || size > 4095) return NULL;
    char *out = malloc(size + 1);
    if (!out) return NULL;
    if (napi_get_value_string_utf8(env, value, out, size + 1, &actual) != napi_ok || actual != size || strlen(out) != size) { free(out); return NULL; }
    return out;
}
static int relative(const char *value, int single) {
    if (!value || !*value || value[0] == '/') return 0;
    if (!single && !strcmp(value, ".")) return 1;
    const char *part = value;
    do {
        const char *end = strchr(part, '/');
        size_t size = end ? (size_t)(end - part) : strlen(part);
        if (!size || (size == 1 && part[0] == '.') || (size == 2 && !strncmp(part, "..", 2)) || (single && end)) return 0;
        if (!end) break;
        part = end + 1;
    } while (1);
    return 1;
}
static int number(napi_env env, napi_value value, int64_t *out, int64_t max) {
    double n;
    if (napi_get_value_double(env, value, &n) != napi_ok || !(n >= 0 && n <= (double)max) || n != (int64_t)n) return 0;
    *out = (int64_t)n;
    return 1;
}
static napi_value dispatch(napi_env env, napi_callback_info info) {
    napi_value args[6], promise;
    size_t argc = 6;
    void *operation;
    napi_get_cb_info(env, info, &argc, args, NULL, &operation);
    job *j = calloc(1, sizeof(*j));
    if (!j) { napi_throw_error(env, "ENOMEM", "safe-fs: allocating work"); return NULL; }
    j->env = env; j->op = (enum operation)(uintptr_t)operation; j->result_fd = -1; j->position = -1;
    int valid = 1;
    int64_t n = 0;
    void *buffer_data = NULL;
    bool flag = false;
    const size_t required[] = {1, 4, 1, 5, 5, 1, 1, 1, 3, 3, 4, 5, 2, 1, 2, 2};
    if (argc != required[j->op]) valid = 0;
    if (valid && j->op == ROOT) {
        j->paths[0] = string(env, args[0]);
        valid = j->paths[0] && j->paths[0][0] == '/' && (!j->paths[0][1] || relative(j->paths[0] + 1, 0));
    } else if (valid) valid = descriptor(j, args[0], 0, j->op == CLONE);
    if (valid) switch (j->op) {
        case OPEN: case CREATE:
            j->paths[0] = string(env, args[1]);
            valid = relative(j->paths[0], j->op == CREATE) && number(env, args[2], &n, j->op == OPEN ? 2 : 07777);
            if (j->op == OPEN) j->kind = (int)n; else j->mode = (int)n;
            valid = valid && number(env, args[3], &n, RESOLVE_NO_XDEV) && (n == 0 || n == RESOLVE_NO_XDEV);
            j->resolve = (uint64_t)n;
            break;
        case MKDIR: case UNLINK:
            j->paths[0] = string(env, args[1]);
            valid = relative(j->paths[0], 1);
            if (j->op == MKDIR) { valid = valid && number(env, args[2], &n, 07777); j->mode = (int)n; }
            else { valid = valid && napi_get_value_bool(env, args[2], &flag) == napi_ok; j->kind = flag; }
            break;
        case RENAME:
            j->paths[0] = string(env, args[1]); j->paths[1] = string(env, args[3]);
            valid = relative(j->paths[0], 1) && relative(j->paths[1], 1) && descriptor(j, args[2], 1, 0) && napi_get_value_bool(env, args[4], &flag) == napi_ok;
            j->kind = flag;
            break;
        case CLONE: valid = descriptor(j, args[1], 1, 1); break;
        case REOPEN: valid = number(env, args[1], &n, 1); j->kind = (int)n; break;
        case PROBE: j->paths[0] = string(env, args[1]); valid = relative(j->paths[0], 1) && !strncmp(j->paths[0], ".gc-file-", 9); break;
        case READ: case WRITE: {
            bool is_buffer = false;
            size_t size = 0;
            valid = napi_is_buffer(env, args[1], &is_buffer) == napi_ok && is_buffer && napi_get_buffer_info(env, args[1], &buffer_data, &size) == napi_ok && keep(j, args[1]);
            if (valid) { j->buffer_ref = j->refs[j->ref_count - 1]; j->buffer_size = size; }
            valid = valid && number(env, args[2], &n, (int64_t)size); j->offset = (size_t)n;
            valid = valid && number(env, args[3], &n, (int64_t)(size - j->offset)); j->length = (size_t)n;
            napi_valuetype type;
            napi_typeof(env, args[4], &type);
            if (type != napi_null && type != napi_undefined) { valid = valid && number(env, args[4], &n, 9007199254740991LL); j->position = n; }
            break;
        }
        default: break;
    }
    if (!valid) {
        j->syscall_name = "argument validation";
        napi_value error = error_value(j, EINVAL);
        release(j); napi_throw(env, error); return NULL;
    }
    if (j->op == READ || j->op == WRITE) {
        j->bytes = malloc(j->length ? j->length : 1);
        if (!j->bytes) { napi_value error = error_value(j, ENOMEM); release(j); napi_throw(env, error); return NULL; }
        if (j->op == WRITE && j->length) memcpy(j->bytes, (char *)buffer_data + j->offset, j->length);
    }
    napi_create_promise(env, &j->deferred, &promise);
    if (napi_create_async_work(env, NULL, text(env, names[j->op]), execute, complete, j, &j->work) != napi_ok || napi_queue_async_work(env, j->work) != napi_ok) {
        napi_reject_deferred(env, j->deferred, error_value(j, EIO)); release(j);
    }
    return promise;
}
static napi_value init(napi_env env, napi_value exports) {
    for (uintptr_t op = ROOT; op <= REOPEN; op++) {
        napi_value fn;
        napi_create_function(env, names[op], NAPI_AUTO_LENGTH, dispatch, (void *)op, &fn);
        property(env, exports, names[op], fn);
    }
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
