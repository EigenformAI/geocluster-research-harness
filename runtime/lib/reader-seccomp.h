#ifndef GC_READER_SECCOMP_H
#define GC_READER_SECCOMP_H
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <sys/prctl.h>
#include <sys/syscall.h>

#define GC_READER_DENY_ERRNO(n, e) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, n, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (e))
#define GC_READER_DENY(n) GC_READER_DENY_ERRNO(n, EPERM)
/* Reload nr after inspecting an argument so the rest of either policy still
 * compares syscall numbers. Read-only opens and writes to IPC pipes survive. */
#define GC_READER_OPEN_FLAGS(n, arg) \
	BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, n, 0, 4), \
	BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[arg])), \
	BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, O_ACCMODE | O_CREAT | O_TRUNC | (O_TMPFILE & ~O_DIRECTORY), 0, 1), \
	BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM), \
	BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr))
#define GC_READER_PDEATHSIG \
	BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_prctl, 0, 4), \
	BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])), \
	BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, PR_SET_PDEATHSIG, 0, 1), \
	BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM), \
	BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr))
#ifdef SYS_open
#define GC_READER_LEGACY_OPEN GC_READER_OPEN_FLAGS(SYS_open, 1), GC_READER_DENY(SYS_creat),
#else
#define GC_READER_LEGACY_OPEN
#endif
#ifdef SYS_chmod
#define GC_READER_LEGACY_METADATA GC_READER_DENY(SYS_chmod), GC_READER_DENY(SYS_chown), GC_READER_DENY(SYS_lchown), GC_READER_DENY(SYS_utime), GC_READER_DENY(SYS_utimes), GC_READER_DENY(SYS_futimesat),
#else
#define GC_READER_LEGACY_METADATA
#endif
#ifdef SYS_mkdir
#define GC_READER_LEGACY_NAMES GC_READER_DENY(SYS_mkdir), GC_READER_DENY(SYS_rmdir), GC_READER_DENY(SYS_link), GC_READER_DENY(SYS_unlink), GC_READER_DENY(SYS_rename), GC_READER_DENY(SYS_symlink), GC_READER_DENY(SYS_mknod),
#else
#define GC_READER_LEGACY_NAMES
#endif
#ifndef SYS_fchmodat2
/* Linux assigned 452 on both supported architectures. Older build headers
 * must not leave the newer metadata syscall usable on a newer guest kernel. */
#define SYS_fchmodat2 452
#endif
#define GC_READER_READONLY_FILESYSTEM \
	GC_READER_LEGACY_OPEN \
	GC_READER_OPEN_FLAGS(SYS_openat, 2), GC_READER_DENY_ERRNO(SYS_openat2, ENOSYS), \
	GC_READER_DENY(SYS_truncate), GC_READER_DENY(SYS_ftruncate), \
	GC_READER_LEGACY_METADATA GC_READER_DENY(SYS_fchmodat2), \
	GC_READER_DENY(SYS_fchmod), GC_READER_DENY(SYS_fchmodat), GC_READER_DENY(SYS_fchown), GC_READER_DENY(SYS_fchownat), GC_READER_DENY(SYS_utimensat), \
	GC_READER_LEGACY_NAMES \
	GC_READER_DENY(SYS_mkdirat), GC_READER_DENY(SYS_linkat), GC_READER_DENY(SYS_unlinkat), GC_READER_DENY(SYS_renameat), GC_READER_DENY(SYS_renameat2), GC_READER_DENY(SYS_symlinkat), GC_READER_DENY(SYS_mknodat), \
	GC_READER_DENY(SYS_setxattr), GC_READER_DENY(SYS_lsetxattr), GC_READER_DENY(SYS_fsetxattr), GC_READER_DENY(SYS_removexattr), GC_READER_DENY(SYS_lremovexattr), GC_READER_DENY(SYS_fremovexattr), \
	GC_READER_PDEATHSIG
#endif
