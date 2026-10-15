/* Test-only launcher: deny a real kernel primitive in the entire child process,
 * including Node's syscall workers. No production configuration/test override. */
#define _GNU_SOURCE
#include <errno.h>
#include <endian.h>
#include <linux/filter.h>
#include <linux/fs.h>
#include <linux/posix_acl.h>
#include <linux/posix_acl_xattr.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <sys/xattr.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 4) return 2;
    if (!strcmp(argv[1], "acl") || !strcmp(argv[1], "default-acl")) {
        struct {
            struct posix_acl_xattr_header header;
            struct posix_acl_xattr_entry entries[5];
        } acl = { .header = { .a_version = htole32(POSIX_ACL_XATTR_VERSION) } };
        unsigned short tags[] = { ACL_USER_OBJ, ACL_USER, ACL_GROUP_OBJ, ACL_MASK, ACL_OTHER };
        unsigned short perms[] = { 7, 4, 0, 4, 0 };
        for (int i = 0; i < 5; i++) {
            acl.entries[i].e_tag = htole16(tags[i]);
            acl.entries[i].e_perm = htole16(perms[i]);
            acl.entries[i].e_id = htole32(i == 1 ? (unsigned int)strtoul(argv[3], NULL, 10) : (unsigned int)-1);
        }
        if (setxattr(argv[2], !strcmp(argv[1], "acl") ? "system.posix_acl_access" : "system.posix_acl_default", &acl, sizeof(acl), 0) < 0) { perror("setxattr"); return 1; }
        return 0;
    }
    int nr, error = ENOSYS;
    if (!strcmp(argv[1], "openat2")) nr = SYS_openat2;
    else if (!strcmp(argv[1], "renameat2")) nr = SYS_renameat2;
    else if (!strcmp(argv[1], "ioctl")) { nr = SYS_ioctl; error = EOPNOTSUPP; }
    else if (!strcmp(argv[1], "acl-inspection")) nr = SYS_fgetxattr;
    else return 2;
    struct sock_filter filters[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (unsigned int)nr, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (unsigned int)error),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
    };
    struct sock_fprog program = { .len = 4, .filter = filters };
    struct sock_filter clone_filters[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_ioctl, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, FICLONE, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EOPNOTSUPP),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
    };
    if (!strcmp(argv[1], "ioctl")) { program.len = 6; program.filter = clone_filters; }
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) < 0) { perror("seccomp"); return 77; }
    execv(argv[2], argv + 2);
    perror("execv");
    return 1;
}
