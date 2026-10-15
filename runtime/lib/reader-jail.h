#ifndef GC_READER_JAIL_H
#define GC_READER_JAIL_H

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/capability.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* These paths are image-built, never supplied by the caller. Pin the checked
 * directory before changing roots; no host directory descriptor survives exec. */
#define GC_GIS_JAIL "/opt/geocluster-reader-jails/gis"
#define GC_WORKBOOK_JAIL "/opt/geocluster-reader-jails/workbook"
static void reader_jail_fail(const char *launcher) {
	const int saved_errno = errno;
	dprintf(2, "%s: stage=chroot-installation result=-1 errno=%d; fixed reader jail is required.\n", launcher, saved_errno);
	_exit(1);
}
static int reader_jail_directory(const char *path, struct stat *st) {
	if (lstat(path, st)) return -1;
	if (!S_ISDIR(st->st_mode) || st->st_uid != 0 || st->st_gid != 0 || (st->st_mode & 0022)) { errno = EPERM; return -1; }
	return 0;
}
static int reader_jail_parents(const char *path, struct stat *st) {
	char parent[PATH_MAX];
	if (path[0] != '/' || strlen(path) >= sizeof(parent)) { errno = EINVAL; return -1; }
	strcpy(parent, path);
	if (reader_jail_directory("/", st)) return -1;
	for (char *p = parent + 1; *p; p++) if (*p == '/') {
		*p = '\0'; const int result = reader_jail_directory(parent, st); *p = '/';
		if (result) return -1;
	}
	return 0;
}
static void reader_jail_enter(const char *root, const char *launcher) {
	struct stat checked, pinned, entered;
	if (reader_jail_parents(root, &checked) || reader_jail_directory(root, &checked)) reader_jail_fail(launcher);
	const int fd = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
	if (fd < 0 || fstat(fd, &pinned)) reader_jail_fail(launcher);
	if (pinned.st_dev != checked.st_dev || pinned.st_ino != checked.st_ino) { errno = ESTALE; reader_jail_fail(launcher); }
	if (fchdir(fd) || chroot(".") || chdir("/") || lstat("/", &entered)) reader_jail_fail(launcher);
	if (entered.st_dev != pinned.st_dev || entered.st_ino != pinned.st_ino) { errno = ESTALE; reader_jail_fail(launcher); }
	if (close(fd)) reader_jail_fail(launcher);
}
static void reader_jail_dependency(const char *path, int directory, int executable, const char *launcher) {
	struct stat st;
	if (reader_jail_parents(path, &st) || lstat(path, &st)) reader_jail_fail(launcher);
	if (st.st_uid != 0 || st.st_gid != 0 || (st.st_mode & 0022) ||
		(directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) || (executable && !(st.st_mode & 0111))) {
		errno = EPERM; reader_jail_fail(launcher);
	}
}
static void reader_jail_close_descriptors(const char *launcher) {
	if (syscall(SYS_close_range, 3U, ~0U, 0)) reader_jail_fail(launcher);
}
static int reader_jail_clear_capabilities(void) {
	struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
	struct __user_cap_data_struct caps[2] = {{0}, {0}};
	return syscall(SYS_capset, &header, caps);
}
#endif
