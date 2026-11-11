#!/usr/bin/env python3
"""Create one approved protected workspace leaf; run captured source with Python -I -."""
import argparse
import errno
import json
import os
from pathlib import Path
import pwd
import re
import stat
import sys


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
IDENTITY_FIELDS = {"path", "dev", "ino", "uid", "gid", "mode", "mount"}


def canonical_path(value):
    if (not isinstance(value, str) or not value.startswith("/") or len(value) > 4096
            or any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value)
            or "\\" in value or (value != "/" and any(p in ("", ".", "..") for p in value[1:].split("/")))):
        raise ValueError("Use an absolute canonical path without links, dot components, or control characters.")
    return Path(value)


def account_record(uid, user=None, home=None):
    try:
        account = pwd.getpwuid(uid)
        named = pwd.getpwnam(account.pw_name)
    except KeyError as error:
        raise ValueError("The invoking account no longer exists.") from error
    if (uid <= 0 or account.pw_uid != uid or named.pw_uid != uid
            or named.pw_name != account.pw_name or named.pw_gid != account.pw_gid
            or named.pw_dir != account.pw_dir
            or (user is not None and account.pw_name != user)
            or (home is not None and account.pw_dir != home)):
        raise ValueError("The invoking account identity does not match system accounts.")
    if canonical_path(account.pw_dir) == Path("/"):
        raise ValueError("The invoking account needs a dedicated canonical home.")
    return account


def workspace_base(account):
    return canonical_path(account.pw_dir) / ".local/share/geocluster/workspaces"


def validate_target(path, account, checkout, creating):
    path, checkout = canonical_path(str(path)), canonical_path(str(checkout))
    home, base = Path(account.pw_dir), workspace_base(account)
    if (path == Path("/") or path == home or path == base or path in base.parents
            or path == checkout or checkout in path.parents or path in checkout.parents):
        raise ValueError("A workspace cannot be home, a filesystem root, the checkout, or an application-data parent.")
    if creating and (path.parent != base or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", path.name)):
        raise ValueError(f"Automatic creation requires a dedicated named child of {base}; use an existing prepared workspace elsewhere.")
    return path


def reject_acl(fd):
    try:
        try:
            names = os.listxattr(fd)
        except OSError as error:
            if error.errno != errno.EBADF:
                raise
            # O_PATH lets an ordinary account inspect a root-only marker's
            # metadata. This kernel link denotes the held inode, not its name.
            names = os.listxattr(f"/proc/self/fd/{fd}")
    except OSError as error:
        if error.errno in (errno.ENOTSUP, errno.EOPNOTSUPP):
            return
        raise
    if any("acl" in name.lower() for name in names):
        raise ValueError("Unexpected access or default ACL on a protected path.")


def identity(fd, path):
    info = os.fstat(fd)
    # Device alone misses a replacement bind mount of the same filesystem.
    with open(f"/proc/self/fdinfo/{fd}", encoding="ascii") as stream:
        mounts = [line.split(":", 1)[1].strip() for line in stream if line.startswith("mnt_id:")]
    if len(mounts) != 1 or not mounts[0].isdecimal():
        raise ValueError("Cannot establish the protected path's Linux mount identity.")
    return {"path": str(path), "dev": info.st_dev, "ino": info.st_ino,
            "uid": info.st_uid, "gid": info.st_gid, "mode": info.st_mode, "mount": int(mounts[0])}


def validate_directory(fd, owners):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in owners or info.st_mode & 0o7022:
        raise ValueError("Unsafe directory owner or writable/special permission bits in workspace ancestors.")
    reject_acl(fd)


def reject_source_tree(fd):
    for name in (".git", ".hg", ".svn"):
        try:
            os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            continue
        raise ValueError("Source trees cannot be used as workspace paths.")


def close_fds(fds):
    for fd in reversed(fds):
        os.close(fd)
    fds.clear()


def open_chain(path, uid):
    """Hold every existing component, without following any link or mutating paths."""
    path = canonical_path(str(path))
    fds, records = [], []
    try:
        fd = os.open("/", DIRECTORY_FLAGS)
        fds.append(fd)
        current = Path("/")
        validate_directory(fd, {0, uid})
        reject_source_tree(fd)
        records.append(identity(fd, current))
        for part in path.parts[1:]:
            try:
                child = os.open(part, DIRECTORY_FLAGS, dir_fd=fds[-1])
            except FileNotFoundError:
                break
            fds.append(child)
            current = current / part
            validate_directory(child, {0, uid})
            reject_source_tree(child)
            records.append(identity(child, current))
        return fds, records
    except BaseException:
        close_fds(fds)
        raise


def revalidate_chain(fds, records, uid):
    if len(fds) != len(records) or not records:
        raise ValueError("Missing held ancestor identities.")
    for index, (fd, expected) in enumerate(zip(fds, records)):
        validate_directory(fd, {0, uid})
        reject_source_tree(fd)
        if identity(fd, expected["path"]) != expected:
            raise ValueError("An approved ancestor identity changed; review the workspace path again.")
        # A held inode alone does not prove it still has its approved name.
        named = os.open("/" if index == 0 else Path(expected["path"]).name,
                        DIRECTORY_FLAGS, dir_fd=None if index == 0 else fds[index - 1])
        try:
            if identity(named, expected["path"]) != expected:
                raise ValueError("An approved ancestor name was replaced or renamed.")
        finally:
            os.close(named)


def validate_home(fds, records, account):
    homes = [(fd, item) for fd, item in zip(fds, records) if item["path"] == account.pw_dir]
    if len(homes) != 1 or os.fstat(homes[0][0]).st_uid != account.pw_uid:
        raise ValueError("The canonical account home must exist and belong to the invoking account.")


def validate_prepared_root(root):
    """Check the prepared boundary without modifying it or reading private state.

    The normal locked container inspection must verify the profile value: its
    root-only marker is deliberately not readable by the host invoking account.
    """
    validate_directory(root, {0})
    reject_source_tree(root)
    try:
        private = os.open(".runtime", DIRECTORY_FLAGS, dir_fd=root)
    except FileNotFoundError:
        # An empty root-owned boundary is also a manually prepared workspace;
        # initialization, not this helper, creates its private layout later.
        with os.scandir(root) as entries:
            if next(entries, None) is None:
                return
        raise ValueError("Existing ordinary folders are not prepared workspaces.")
    try:
        validate_directory(private, {0})
        marker = os.open("profile", os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=private)
        try:
            info = os.fstat(marker)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
                    or info.st_mode & 0o7022 or not 0 < info.st_size <= 64):
                raise ValueError("Existing workspace has an unsafe native profile marker.")
            reject_acl(marker)
        finally:
            os.close(marker)
        for name in ("owner.lock", "native", "setup"):
            try:
                info = os.stat(name, dir_fd=private, follow_symlinks=False)
            except FileNotFoundError:
                continue
            flags = os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC
            child = os.open(name, flags | (os.O_DIRECTORY if name != "owner.lock" else 0), dir_fd=private)
            try:
                info = os.fstat(child)
                if name == "owner.lock":
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o7077:
                        raise ValueError("Existing workspace has an unsafe lifecycle lock.")
                    reject_acl(child)
                else:
                    validate_directory(child, {0})
            finally:
                os.close(child)
    finally:
        os.close(private)


def parse_records(raw):
    if len(raw) > 65536:
        raise ValueError("Approved parent identities exceed the argument bound.")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate approved identity field.")
            result[key] = value
        return result
    records = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(records, list) or not 1 <= len(records) <= 256:
        raise ValueError("Expected bounded approved parent identities.")
    for record in records:
        if not isinstance(record, dict) or set(record) != IDENTITY_FIELDS:
            raise ValueError("Invalid approved parent identity fields.")
        canonical_path(record["path"])
        if any(type(record[key]) is not int or record[key] < 0 for key in IDENTITY_FIELDS - {"path"}):
            raise ValueError("Invalid approved parent identity value.")
    return records


def main(argv=None):
    if os.geteuid() != 0:
        raise ValueError("The protected workspace helper requires effective root identity.")
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("path", "user", "home", "checkout", "parents"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--uid", required=True, type=int)
    options = parser.parse_args(argv)
    account = account_record(options.uid, options.user, options.home)
    if os.environ.get("SUDO_UID") != str(account.pw_uid) or os.environ.get("SUDO_USER") != account.pw_name:
        raise ValueError("sudo identity does not match the approved invoking account.")
    path = validate_target(options.path, account, options.checkout, creating=True)
    approved = parse_records(options.parents)
    fds, records = open_chain(path.parent, account.pw_uid)
    try:
        validate_home(fds, records, account)
        if records != approved or records[-1]["path"] != str(path.parent):
            raise ValueError("Approved parent identities changed or are incomplete.")
        if records[-1]["uid"] != account.pw_uid:
            raise ValueError("The immediate workspace parent must belong to the invoking account.")
        revalidate_chain(fds, approved, account.pw_uid)
        previous_umask = os.umask(0o022)
        try:
            # mkdir is exclusive: collisions are not opened for permission repair.
            os.mkdir(path.name, 0o755, dir_fd=fds[-1])
        finally:
            os.umask(previous_umask)
        leaf = os.open(path.name, DIRECTORY_FLAGS, dir_fd=fds[-1])
        try:
            validate_directory(leaf, {0})
            created = identity(leaf, path)
            if (stat.S_IMODE(created["mode"]) != 0o755 or created["mount"] != records[-1]["mount"]
                    or created["dev"] != records[-1]["dev"]):
                raise ValueError("New protected root has unexpected permissions or mount identity; retain it for inspection.")
            revalidate_chain(fds + [leaf], records + [created], account.pw_uid)
            os.fsync(leaf)
            os.fsync(fds[-1])
        finally:
            os.close(leaf)
    finally:
        close_fds(fds)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, UnicodeError) as error:
        print("Protected workspace creation: " + str(error), file=sys.stderr)
        sys.exit(1)
