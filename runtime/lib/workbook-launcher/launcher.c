#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include "../reader-jail.h"

#ifndef GC_WORKBOOK_NODE
#define GC_WORKBOOK_NODE "/usr/local/bin/node"
#endif
#ifndef GC_WORKBOOK_WORKER
#define GC_WORKBOOK_WORKER "/opt/geocluster-runtime/lib/workbook-reader-worker.cjs"
#endif
#ifndef GC_WORKBOOK_POLICY
#define GC_WORKBOOK_POLICY "/opt/geocluster-runtime/workbook-policy.so"
#endif
#ifndef GC_WORKBOOK_DEPS
#define GC_WORKBOOK_DEPS "/opt/geocluster-runtime/node_modules"
#endif

#define MIB ((rlim_t)1024 * 1024)
static volatile sig_atomic_t stop_requested = 0;
static volatile sig_atomic_t worker_pid = 0;
static void stop(int signal) { (void)signal; stop_requested = 1; if (worker_pid > 0) kill((pid_t)worker_pid, SIGKILL); }
static void fail(const char *operation) {
	fprintf(stderr, "workbook-launcher: %s failed (errno=%d); install trusted paths and require Linux chroot/seccomp support.\n", operation, errno);
	_exit(1);
}
static void limit(int resource, rlim_t value) { const struct rlimit bound = {value, value}; if (setrlimit(resource, &bound)) fail("resource envelope"); }
static void drop(uid_t uid, gid_t gid) {
	if (setgroups(0, NULL) || setresgid(gid, gid, gid) || setresuid(uid, uid, uid)) fail("identity drop");
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("no_new_privs");
}
static void monitor_drop(void) {
	/* A UID-998 monitor needs only CAP_KILL to stop its UID-997 child. It cannot
	 * regain root, read privileged files, or exec anything. The fixed monitor uses
	 * this capability only with the child PID returned by its own fork. */
	if (prctl(PR_SET_KEEPCAPS, 1, 0, 0, 0)) fail("monitor keep kill capability");
	drop(998, 999);
	struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
	struct __user_cap_data_struct caps[2] = {{0}, {0}};
	caps[CAP_KILL / 32].effective = caps[CAP_KILL / 32].permitted = 1U << (CAP_KILL % 32);
	if (syscall(SYS_capset, &header, caps) || prctl(PR_SET_KEEPCAPS, 0, 0, 0, 0) || prctl(PR_SET_DUMPABLE, 0)) fail("monitor restricted kill capability");
}
static void parent_death(pid_t expected, int signal) {
	if (prctl(PR_SET_PDEATHSIG, signal) || getppid() != expected) { errno = ESRCH; fail("parent lifetime"); }
}
static void confine(void) {
	reader_jail_enter(GC_WORKBOOK_JAIL, "workbook-launcher");
	reader_jail_dependency(GC_WORKBOOK_NODE, 0, 1, "workbook-launcher");
	reader_jail_dependency(GC_WORKBOOK_WORKER, 0, 0, "workbook-launcher");
	reader_jail_dependency(GC_WORKBOOK_POLICY, 0, 0, "workbook-launcher");
	reader_jail_dependency(GC_WORKBOOK_DEPS "/xlsx", 1, 0, "workbook-launcher");
	reader_jail_dependency(GC_WORKBOOK_DEPS "/saxes", 1, 0, "workbook-launcher");
	reader_jail_dependency(GC_WORKBOOK_DEPS "/xmlchars", 1, 0, "workbook-launcher");
	reader_jail_close_descriptors("workbook-launcher");
}

int main(int argc, char **argv) {
	(void)argv;
	if (argc != 1 || (getuid() != 998 && getuid() != 0) || geteuid() != 0) { errno = EPERM; fail("fixed setuid launcher/caller policy"); }
	const pid_t caller_parent = getppid();
	if (clearenv()) fail("clear environment");
	for (int fd = 0; fd < 3; fd++) {
		struct stat st; const int flags = fcntl(fd, F_GETFL);
		if (fstat(fd, &st) || (!S_ISFIFO(st.st_mode) && !S_ISSOCK(st.st_mode)) || flags < 0 || (fd == 0 ? (flags & O_ACCMODE) == O_WRONLY : (flags & O_ACCMODE) == O_RDONLY)) { errno = EINVAL; fail("stdin/stdout/stderr IPC policy"); }
		if (S_ISSOCK(st.st_mode)) { int domain; socklen_t length = sizeof(domain); if (getsockopt(fd, SOL_SOCKET, SO_DOMAIN, &domain, &length) || domain != AF_UNIX) { errno = EINVAL; fail("local IPC socket policy"); } }
	}
	if (syscall(SYS_close_range, 3U, ~0U, 0)) fail("close inherited descriptors");
	if (chdir("/") || prctl(PR_SET_DUMPABLE, 0)) fail("working directory/dumps");
	sigset_t empty; if (sigemptyset(&empty) || sigprocmask(SIG_SETMASK, &empty, NULL)) fail("reset signal mask");
	struct sigaction action = { .sa_handler = SIG_DFL };
	if (sigemptyset(&action.sa_mask)) fail("reset signals");
	for (int signal = 1; signal < NSIG; signal++) if (signal != SIGKILL && signal != SIGSTOP && sigaction(signal, &action, NULL) && errno != EINVAL) fail("reset signal disposition");
	action.sa_handler = stop; if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) fail("monitor stop handler");
	limit(RLIMIT_CORE, 0); limit(RLIMIT_CPU, 60); limit(RLIMIT_DATA, 1536 * MIB); limit(RLIMIT_FSIZE, 0); limit(RLIMIT_NOFILE, 64);
	const pid_t monitor = getpid(), child = fork(); if (child < 0) fail("fork fixed worker");
	if (child == 0) {
		action.sa_handler = SIG_DFL; if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) fail("worker signal defaults");
		confine();
		if (prctl(PR_SET_KEEPCAPS, 0, 0, 0, 0)) fail("worker no keep capabilities");
		drop(997, 997);
		if (reader_jail_clear_capabilities()) fail("worker zero capabilities");
		parent_death(monitor, SIGKILL);
		/* The byte-only reader needs SHA-256, not system TLS/provider configuration.
		 * Pin an empty config inside the jail so Node startup neither
		 * reads /etc/ssl/openssl.cnf nor imports its image-dependent dependencies. */
		char *const args[] = { GC_WORKBOOK_NODE, "--openssl-config=/dev/null", "--max-old-space-size=768", "--no-addons", GC_WORKBOOK_WORKER, NULL };
		char *const environment[] = { "LANG=C.UTF-8", "TZ=UTC", "LD_PRELOAD=" GC_WORKBOOK_POLICY, NULL };
		execve(GC_WORKBOOK_NODE, args, environment); fail("fixed Node worker exec");
	}
	/* SIGTERM is acknowledged only after waitpid proves worker termination. A
	 * killed monitor also kills the worker through its post-drop PDEATHSIG. */
	worker_pid = child;
	monitor_drop(); parent_death(caller_parent, SIGTERM);
	int status;
	for (;;) {
		if (stop_requested && kill(child, SIGKILL) && errno != ESRCH) fail("stop worker");
		if (waitpid(child, &status, 0) >= 0) break;
		if (errno != EINTR) fail("wait for worker termination");
	}
	if (WIFEXITED(status)) return WEXITSTATUS(status);
	if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
	return 1;
}
