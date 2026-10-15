#!/usr/bin/env python3
"""Hold one retained-volume owner lock across exec; never unlink a live lock."""
import fcntl
import os
import stat
import sys
import uuid


def fail(message):
    raise ValueError(message)


def protected_dir(name, parent=None, mode=0o755):
    try:
        os.mkdir(name, mode, dir_fd=parent)
    except FileExistsError:
        pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    info = os.fstat(fd)
    if info.st_uid != os.geteuid() or info.st_mode & 0o022:
        os.close(fd)
        fail("retained-volume ownership is unsafe; use a volume with root-owned, non-writable private parents")
    return fd


def main():
    workspace, profile, *command = sys.argv[1:]
    if profile not in ("native", "managed") or not command:
        fail("expected workspace, native|managed, and owner command")
    # No recursive reownership: the volume root is an operator-provisioned boundary.
    root = protected_dir(workspace)
    private = protected_dir(".runtime", root)
    lock = os.open("owner.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=private)
    info = os.fstat(lock)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077:
        fail("unsafe retained lifecycle lock; inspect .runtime/owner.lock")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fail("workspace volume is already owned by another runtime; stop that owner before retrying")
    try:
        marker = os.open("profile", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=private)
    except FileNotFoundError:
        marker = None
    if marker is not None:
        info = os.fstat(marker)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            fail("unsafe retained profile marker; inspect .runtime/profile")
        saved = os.read(marker, 64).decode("ascii").strip()
        os.close(marker)
        if saved != profile:
            fail("volume profile differs; create a fresh volume and copy only ordinary project files from /workspace/<PROJECT_ID>/ into its project directory; never copy /workspace, .runtime or .ide-state (sessions and credentials do not transfer)")
    else:
        # Recognize older unmarked managed state without relabeling it as native.
        existing = set(os.listdir(private))
        if profile == "native" and existing.intersection({"opencode", "gateway", "conversations"}):
            fail("unmarked managed state exists; create a fresh native volume and copy only ordinary project files, not .runtime or .ide-state")
        if profile == "managed" and "native" in existing:
            fail("unmarked native state exists; create a fresh managed volume and copy only ordinary project files, not .runtime or .ide-state")
        temporary = ".profile." + uuid.uuid4().hex
        marker = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=private)
        try:
            remaining = (profile + "\n").encode()
            while remaining:
                written = os.write(marker, remaining)
                if written <= 0:
                    fail("profile marker write failed")
                remaining = remaining[written:]
            os.fsync(marker)
            os.rename(temporary, "profile", src_dir_fd=private, dst_dir_fd=private)
            os.fsync(private)
        finally:
            os.close(marker)
            try:
                os.unlink(temporary, dir_fd=private)
            except FileNotFoundError:
                pass
    os.close(private)
    os.close(root)
    os.dup2(lock, 9, inheritable=True)
    if lock != 9:
        os.close(lock)
    os.execvp(command[0], command)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, UnicodeError) as error:
        print("runtime lifecycle setup: " + str(error), file=sys.stderr)
        sys.exit(2)
