#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef GC_PREVIEW_NODE
#define GC_PREVIEW_NODE "/usr/local/bin/node"
#endif
#ifndef GC_PREVIEW_WORKER
#define GC_PREVIEW_WORKER "/opt/geocluster-runtime/lib/file-segments-worker.js"
#endif

#define SERVICE_UID 998
#define SERVICE_GID 999
#define WORKER_UID 997
#define WORKER_GID 997
#define MIB ((rlim_t)1024 * 1024)

static void fail(const char *operation) {
	fprintf(stderr, "preview-launcher: %s failed (errno %d). Inspect the root-owned launcher, IPC pipes and container permissions.\n", operation, errno);
	_exit(1);
}

static void limit(int resource, rlim_t value) {
	const struct rlimit bound = { value, value };
	if (setrlimit(resource, &bound) != 0) fail("resource limit");
}

static void drop(uid_t uid, gid_t gid) {
	if (setgroups(0, NULL) != 0) fail("clear supplementary groups");
	if (setresgid(gid, gid, gid) != 0) fail("drop group");
	if (setresuid(uid, uid, uid) != 0) fail("drop user");
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("no_new_privs");
}

static void parent_death(pid_t expected) {
	/* Credential changes clear PDEATHSIG; call this after the final UID/GID drop. */
	if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) fail("parent-death signal");
	if (getppid() != expected) { errno = ESRCH; fail("parent lifetime"); }
}

int main(int argc, char **argv) {
	/* FileSegments appends node arguments. None of them select executable code. */
	(void)argc;
	(void)argv;
	const uid_t caller = getuid();
	if (caller != SERVICE_UID && caller != 0) { errno = EPERM; fail("caller UID (only 998 or root allowed)"); }
	if (geteuid() != 0) { errno = EPERM; fail("setuid-root provisioning"); }
	const pid_t caller_parent = getppid();
	if (clearenv() != 0) fail("clear environment");
	for (int fd = 0; fd < 3; fd++) {
		struct stat st;
		if (fstat(fd, &st) != 0 || (!S_ISFIFO(st.st_mode) && !S_ISSOCK(st.st_mode))) { errno = EINVAL; fail("standard descriptor IPC policy"); }
		const int flags = fcntl(fd, F_GETFL);
		if (flags < 0 || (fd == 0 ? (flags & O_ACCMODE) == O_WRONLY : (flags & O_ACCMODE) == O_RDONLY)) { errno = EINVAL; fail("IPC descriptor access"); }
	}
#ifdef SYS_close_range
	if (syscall(SYS_close_range, 3U, ~0U, 0) != 0) fail("close inherited descriptors");
#else
	#error "preview-launcher requires Linux close_range"
#endif
	if (chdir("/") != 0) fail("working directory");
	if (prctl(PR_SET_DUMPABLE, 0) != 0) fail("disable launcher dumps");
	sigset_t empty;
	if (sigemptyset(&empty) != 0 || sigprocmask(SIG_SETMASK, &empty, NULL) != 0) fail("reset signal mask");
	struct sigaction action = { .sa_handler = SIG_DFL };
	if (sigemptyset(&action.sa_mask) != 0) fail("signal defaults");
	for (int signal = 1; signal < NSIG; signal++) {
		if (signal == SIGKILL || signal == SIGSTOP) continue;
		if (sigaction(signal, &action, NULL) != 0 && errno != EINVAL) fail("reset signal disposition");
	}
	limit(RLIMIT_CORE, 0);
	limit(RLIMIT_CPU, 8);
	limit(RLIMIT_DATA, 512 * MIB);
	limit(RLIMIT_FSIZE, 8 * MIB); /* Pipe output is bounded independently by FileSegments. */
	limit(RLIMIT_NOFILE, 64);
	const pid_t monitor = getpid();
	const pid_t child = fork();
	if (child < 0) fail("fork parser");
	if (child == 0) {
		drop(WORKER_UID, WORKER_GID);
		parent_death(monitor);
		char *const args[] = { GC_PREVIEW_NODE, "--max-old-space-size=128", GC_PREVIEW_WORKER, NULL };
		char *const environment[] = { "LANG=C.UTF-8", NULL };
		execve(GC_PREVIEW_NODE, args, environment);
		fail("fixed parser exec");
	}
	/* The service must be able to kill its child on timeout. This monitor remains
	 * signalable as UID 998; the kernel kills UID 997 when the monitor dies. */
	drop(SERVICE_UID, SERVICE_GID);
	parent_death(caller_parent);
	int status;
	while (waitpid(child, &status, 0) < 0) if (errno != EINTR) fail("wait parser");
	if (WIFEXITED(status)) return WEXITSTATUS(status);
	if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
	return 1;
}
