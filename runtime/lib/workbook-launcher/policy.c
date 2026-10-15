#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <sys/socket.h>
#include <signal.h>
#include "../reader-seccomp.h"

#if defined(__x86_64__)
#define GC_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define GC_ARCH AUDIT_ARCH_AARCH64
#else
#error "workbook seccomp supports x86_64 and aarch64 only"
#endif
#define DENY(number) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, number, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)

/* Loaded by the one fixed exec, before Node initializes. Once this constructor
 * returns, process creation/execution and network/signal syscalls are forbidden. */
__attribute__((constructor)) static void confine(void) {
	const struct sock_filter filter[] = {
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, GC_ARCH, 1, 0),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
		/* Reject the x32 syscall-number ABI as well. */
		BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
		DENY(SYS_socket), DENY(SYS_socketpair), DENY(SYS_connect), DENY(SYS_bind), DENY(SYS_listen), DENY(SYS_accept), DENY(SYS_accept4),
		DENY(SYS_sendto), DENY(SYS_sendmsg), DENY(SYS_recvmsg), DENY(SYS_recvmmsg), DENY(SYS_sendmmsg),
		DENY(SYS_execve), DENY(SYS_execveat), DENY(SYS_kill), DENY(SYS_tkill), DENY(SYS_tgkill),
		DENY(SYS_rt_sigqueueinfo), DENY(SYS_rt_tgsigqueueinfo), DENY(SYS_ptrace), DENY(SYS_process_vm_readv), DENY(SYS_process_vm_writev),
		DENY(SYS_unshare), DENY(SYS_setns), DENY(SYS_mount), DENY(SYS_umount2), DENY(SYS_pivot_root), DENY(SYS_chroot),
		DENY(SYS_bpf), DENY(SYS_perf_event_open), DENY(SYS_userfaultfd), DENY(SYS_open_by_handle_at),
		GC_READER_READONLY_FILESYSTEM,
#ifdef SYS_fork
		DENY(SYS_fork),
#endif
#ifdef SYS_vfork
		DENY(SYS_vfork),
#endif
#ifdef SYS_pidfd_send_signal
		DENY(SYS_pidfd_send_signal),
#endif
#ifdef SYS_pidfd_getfd
		DENY(SYS_pidfd_getfd),
#endif
#ifdef SYS_pidfd_open
		DENY(SYS_pidfd_open),
#endif
#ifdef SYS_io_uring_setup
		DENY(SYS_io_uring_setup), DENY(SYS_io_uring_enter), DENY(SYS_io_uring_register),
#endif
#ifdef SYS_clone3
		/* glibc falls back to clone; clone3's pointed-to flags cannot be inspected. */
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone3, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
#endif
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 4),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
		BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_THREAD, 1, 0),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
	};
	const struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = (struct sock_filter *)filter };
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) {
		dprintf(2, "workbook-policy: seccomp enforcement failed (errno=%d); kernel policy is required.\n", errno); _exit(1);
	}
	/* These raw calls distinguish syscall denial from a missing executable or a
	 * refused TCP connection. No actual program runs and no signal is delivered. */
	if (socket(AF_INET, SOCK_STREAM, 0) != -1 || errno != EPERM || kill(getpid(), 0) != -1 || errno != EPERM) _exit(1);
	char *const args[] = { "/nonexistent-workbook-probe", NULL };
	char *const env[] = { NULL };
	if (execve(args[0], args, env) != -1 || errno != EPERM) _exit(1);
	/* Check raw flags and lifetime mutations before Node creates its own handles.
	 * Nonexistent paths are intentional: EPERM must precede path resolution. */
	const int flags[] = {O_WRONLY, O_RDWR, O_RDONLY | O_CREAT, O_RDONLY | O_TRUNC, O_TMPFILE | O_RDWR};
	for (unsigned int i = 0; i < sizeof(flags) / sizeof(flags[0]); i++) {
		if (syscall(SYS_openat, AT_FDCWD, "/nonexistent-workbook-write-probe", flags[i], 0600) != -1 || errno != EPERM) _exit(1);
#ifdef SYS_open
		if (syscall(SYS_open, "/nonexistent-workbook-write-probe", flags[i], 0600) != -1 || errno != EPERM) _exit(1);
#endif
	}
	if (syscall(SYS_openat2, AT_FDCWD, "/nonexistent-workbook-probe", NULL, 0) != -1 || errno != ENOSYS ||
		truncate("/nonexistent-workbook-probe", 0) != -1 || errno != EPERM ||
		ftruncate(0, 0) != -1 || errno != EPERM ||
		prctl(PR_SET_PDEATHSIG, 0, 0, 0, 0) != -1 || errno != EPERM) _exit(1);
	for (int fd = 3; fd < 64; fd++) if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) _exit(1);
	if (setenv("GC_WORKBOOK_READONLY_PROBES", "1", 1) || setenv("GC_WORKBOOK_DESCRIPTOR_PROBES", "1", 1)) _exit(1);
	if (setenv("GC_WORKBOOK_SECCOMP", "1", 1) || setenv("GC_WORKBOOK_SYSCALL_PROBES", "1", 1)) _exit(1);
}
