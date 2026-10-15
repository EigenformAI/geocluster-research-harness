#pragma once
#include <cerrno>
#include <cstddef>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
#include "../reader-seccomp.h"

#if defined(__x86_64__)
#define GC_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define GC_ARCH AUDIT_ARCH_AARCH64
#else
#error "GIS confinement requires x86_64 or aarch64"
#endif
#define GC_DENY(n) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, n, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
static void install_seccomp() {
	const sock_filter filter[] = {
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(seccomp_data, arch)), BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, GC_ARCH, 1, 0), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(seccomp_data, nr)),
#if defined(__x86_64__)
		BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
		GC_DENY(SYS_socket), GC_DENY(SYS_socketpair), GC_DENY(SYS_connect), GC_DENY(SYS_bind), GC_DENY(SYS_listen), GC_DENY(SYS_accept), GC_DENY(SYS_accept4),
		GC_DENY(SYS_sendto), GC_DENY(SYS_sendmsg), GC_DENY(SYS_sendmmsg), GC_DENY(SYS_recvmsg), GC_DENY(SYS_recvmmsg),
		GC_DENY(SYS_execve), GC_DENY(SYS_execveat), GC_DENY(SYS_clone),
		GC_READER_READONLY_FILESYSTEM,
#ifdef SYS_clone3
		GC_DENY(SYS_clone3),
#endif
#ifdef SYS_fork
		GC_DENY(SYS_fork), GC_DENY(SYS_vfork),
#endif
		GC_DENY(SYS_kill), GC_DENY(SYS_tkill), GC_DENY(SYS_tgkill), GC_DENY(SYS_rt_sigqueueinfo), GC_DENY(SYS_rt_tgsigqueueinfo),
		GC_DENY(SYS_ptrace), GC_DENY(SYS_process_vm_readv), GC_DENY(SYS_process_vm_writev), GC_DENY(SYS_unshare), GC_DENY(SYS_setns), GC_DENY(SYS_mount), GC_DENY(SYS_umount2), GC_DENY(SYS_pivot_root), GC_DENY(SYS_chroot),
		GC_DENY(SYS_bpf), GC_DENY(SYS_perf_event_open), GC_DENY(SYS_userfaultfd), GC_DENY(SYS_open_by_handle_at),
#ifdef SYS_pidfd_getfd
		GC_DENY(SYS_pidfd_getfd), GC_DENY(SYS_pidfd_open), GC_DENY(SYS_pidfd_send_signal),
#endif
#ifdef SYS_io_uring_setup
		GC_DENY(SYS_io_uring_setup), GC_DENY(SYS_io_uring_enter), GC_DENY(SYS_io_uring_register),
#endif
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
	};
	const sock_fprog program = {static_cast<unsigned short>(sizeof(filter) / sizeof(filter[0])), const_cast<sock_filter *>(filter)};
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) _exit(1);
}
