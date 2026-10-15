#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#include "../reader-jail.h"

#define WORKER "/opt/geocluster-runtime/gis-worker"
#define MIB ((rlim_t)1048576)
static volatile sig_atomic_t child_pid;
static void stop(int sig) { (void)sig; if (child_pid > 0) kill(child_pid, SIGKILL); }
static void fail(const char *what) { dprintf(2, "gis-launcher: %s failed (errno=%d); install fixed root-controlled paths and Linux confinement.\n", what, errno); _exit(1); }
static void limit(int resource, rlim_t value) { const struct rlimit r = {value, value}; if (setrlimit(resource, &r)) fail("resource envelope"); }
static void drop(uid_t uid, gid_t gid) { if (setgroups(0, NULL) || setresgid(gid, gid, gid) || setresuid(uid, uid, uid) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("identity drop"); }
static void parent_death(pid_t parent, int sig) { if (prctl(PR_SET_PDEATHSIG, sig) || getppid() != parent) fail("parent lifetime"); }
static void confine(void) {
	reader_jail_enter(GC_GIS_JAIL, "gis-launcher");
	reader_jail_dependency(WORKER, 0, 1, "gis-launcher");
	reader_jail_dependency("/usr/share/gdal", 1, 0, "gis-launcher");
	reader_jail_dependency("/usr/share/proj", 1, 0, "gis-launcher");
	reader_jail_close_descriptors("gis-launcher");
}
int main(int argc, char **argv) {
	(void)argv;
	if (argc != 1 || (getuid() != 998 && getuid() != 0) || geteuid() != 0) { errno = EPERM; fail("setuid caller policy"); }
	pid_t caller = getppid(); if (clearenv()) fail("environment scrub");
	for (int fd = 0; fd < 3; fd++) {
		struct stat st; int flags = fcntl(fd, F_GETFL);
		if (fstat(fd, &st) || (!S_ISFIFO(st.st_mode) && !S_ISSOCK(st.st_mode)) || flags < 0 || (fd == 0 ? (flags & O_ACCMODE) == O_WRONLY : (flags & O_ACCMODE) == O_RDONLY)) fail("IPC descriptors");
		if (S_ISSOCK(st.st_mode)) { int domain; socklen_t length = sizeof(domain); if (getsockopt(fd, SOL_SOCKET, SO_DOMAIN, &domain, &length) || domain != AF_UNIX) fail("local IPC sockets"); }
	}
	if (syscall(SYS_close_range, 3U, ~0U, 0) || chdir("/") || prctl(PR_SET_DUMPABLE, 0)) fail("descriptor/dump policy");
	sigset_t empty; sigemptyset(&empty); if (sigprocmask(SIG_SETMASK, &empty, NULL)) fail("signal mask");
	struct sigaction action = { .sa_handler = SIG_DFL }; sigemptyset(&action.sa_mask);
	for (int s = 1; s < NSIG; s++) if (s != SIGKILL && s != SIGSTOP && sigaction(s, &action, NULL) && errno != EINVAL) fail("reset signals");
	// Publish the child and restore CAP_KILL before any stop signal is delivered.
	// The child resets handlers and unblocks only after its irreversible confinement.
	sigset_t startup; sigemptyset(&startup); sigaddset(&startup, SIGTERM); sigaddset(&startup, SIGINT); sigaddset(&startup, SIGALRM);
	if (sigprocmask(SIG_BLOCK, &startup, NULL)) fail("startup signal block");
	action.sa_handler = stop; if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL) || sigaction(SIGALRM, &action, NULL)) fail("monitor handlers");
	limit(RLIMIT_CORE, 0); limit(RLIMIT_CPU, 30); limit(RLIMIT_DATA, 512 * MIB); limit(RLIMIT_AS, 1536 * MIB); limit(RLIMIT_FSIZE, 0); limit(RLIMIT_NOFILE, 64);
	pid_t monitor = getpid(), child = fork(); if (child < 0) fail("fork fixed worker");
	if (!child) {
		action.sa_handler = SIG_DFL; sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL); sigaction(SIGALRM, &action, NULL);
		confine();
		if (prctl(PR_SET_KEEPCAPS, 0, 0, 0, 0)) fail("worker no keep capabilities");
		drop(997, 997);
		if (reader_jail_clear_capabilities()) fail("worker zero capabilities");
		parent_death(monitor, SIGKILL);
		if (sigprocmask(SIG_SETMASK, &empty, NULL)) fail("worker signal unblock");
		char *const args[] = {WORKER, NULL};
		char *const env[] = {"LANG=C.UTF-8", "TZ=UTC", "PROJ_NETWORK=OFF", "GDAL_DATA=/usr/share/gdal", "PROJ_DATA=/usr/share/proj", "GDAL_DRIVER_PATH=disable", "OPENBLAS_NUM_THREADS=1", "OMP_NUM_THREADS=1", NULL};
		execve(WORKER, args, env); fail("fixed native exec");
	}
	child_pid = child;
	// The monitor parses no input. Only CAP_KILL survives the irreversible UID drop.
	if (prctl(PR_SET_KEEPCAPS, 1, 0, 0, 0)) fail("keep kill capability");
	drop(998, 999);
	struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
	struct __user_cap_data_struct caps[2] = {{0}, {0}}; caps[CAP_KILL / 32].effective = caps[CAP_KILL / 32].permitted = 1U << (CAP_KILL % 32);
	if (syscall(SYS_capset, &header, caps) || prctl(PR_SET_KEEPCAPS, 0, 0, 0, 0) || prctl(PR_SET_DUMPABLE, 0)) fail("monitor capabilities");
	parent_death(caller, SIGTERM); alarm(30); if (sigprocmask(SIG_SETMASK, &empty, NULL)) fail("monitor signal unblock");
	int status; while (waitpid(child, &status, 0) < 0) if (errno != EINTR) fail("wait worker");
	return WIFEXITED(status) ? WEXITSTATUS(status) : WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 1;
}
