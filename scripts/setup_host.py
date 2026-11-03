"""Read-only host workspace approvals and one captured-source sudo operation."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import stat
import subprocess
import sys
import types


REPO = Path(__file__).resolve().parent.parent
SOURCE = Path(__file__).with_name("setup-host-root.py")
SOURCE_LIMIT = 1024 * 1024
_READONLY_HELPER = None


class HostRootPlan(dict):
    """An in-memory approval, deliberately not a saved-profile representation."""
    def close(self):
        for name in ("_fds", "_home_fds"):
            fds = self.get(name, [])
            while fds:
                os.close(fds.pop())

    def __del__(self):
        self.close()


def _capture_source():
    fd = os.open(SOURCE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= SOURCE_LIMIT:
            raise ValueError("Host helper source must be one bounded regular, single-link file.")
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, min(65536, SOURCE_LIMIT + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > SOURCE_LIMIT:
                raise ValueError("Host helper source exceeds its capture bound.")
        after = os.fstat(fd)
        fields = ("st_dev", "st_ino", "st_uid", "st_mode", "st_size", "st_mtime_ns", "st_ctime_ns")
        if size != before.st_size or any(getattr(before, key) != getattr(after, key) for key in fields):
            raise ValueError("Host helper source changed while being captured.")
        return b"".join(chunks)
    finally:
        os.close(fd)


def _account():
    if os.getuid() == 0 or os.getuid() != os.geteuid():
        raise ValueError("Run guided setup as your ordinary invoking account, not root.")
    try:
        return pwd.getpwuid(os.getuid())
    except KeyError as error:
        raise ValueError("The invoking account no longer exists.") from error


def _validation_helper(code=None):
    global _READONLY_HELPER
    if code is None and _READONLY_HELPER is not None:
        return _READONLY_HELPER
    helper = types.ModuleType("_captured_host_root")
    exec(compile(_capture_source() if code is None else code, str(SOURCE), "exec"), helper.__dict__)
    _READONLY_HELPER = helper
    return helper


def allowed_host_base() -> Path:
    """Return the system-account home base, never $HOME or an XDG override."""
    invoking = _account()
    helper = _validation_helper()
    account = helper.account_record(invoking.pw_uid, invoking.pw_name, invoking.pw_dir)
    fds, records = helper.open_chain(Path(account.pw_dir), account.pw_uid)
    try:
        helper.validate_home(fds, records, account)
        helper.revalidate_chain(fds, records, account.pw_uid)
        return helper.workspace_base(account)
    finally:
        helper.close_fds(fds)


def validate_existing_root(path) -> None:
    """Read-only protected bind-boundary check, also accepting a prepared empty root.

    Native/managed profile content remains the locked container's responsibility.
    This routine never elevates and reuses already-captured validation code.
    """
    helper = _validation_helper()
    invoking = _account()
    account = helper.account_record(invoking.pw_uid, invoking.pw_name, invoking.pw_dir)
    target = helper.validate_target(helper.canonical_path(os.fspath(path)), account, REPO, creating=False)
    fds, records = helper.open_chain(target, account.pw_uid)
    try:
        home_fds, home_records = helper.open_chain(Path(account.pw_dir), account.pw_uid)
        try:
            helper.validate_home(home_fds, home_records, account)
            helper.revalidate_chain(home_fds, home_records, account.pw_uid)
        finally:
            helper.close_fds(home_fds)
        if records[-1]["path"] != str(target):
            raise ValueError("The prepared workspace root is missing.")
        helper.validate_prepared_root(fds[-1])
        helper.revalidate_chain(fds, records, account.pw_uid)
    finally:
        helper.close_fds(fds)


def _system_python(helper):
    candidates = ["/usr/bin/python3", "/usr/local/bin/python3", "/run/current-system/sw/bin/python3", sys.executable]
    for candidate in candidates:
        try:
            path = Path(candidate).resolve(strict=True)
            if (not (str(path).startswith("/usr/") or str(path).startswith("/nix/store/"))
                    or not re.fullmatch(r"python3(?:\.[0-9]+)*", path.name)):
                continue
            fds, records = helper.open_chain(path.parent, 0)
            try:
                if records[-1]["path"] != str(path.parent):
                    continue
                fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fds[-1])
                try:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o7022 or not info.st_mode & 0o111:
                        continue
                    helper.reject_acl(fd)
                    return str(path), records, helper.identity(fd, path)
                finally:
                    os.close(fd)
            finally:
                helper.close_fds(fds)
        except (ValueError, OSError):
            continue
    raise ValueError("No root-owned, non-writable system Python 3 is available for administrator access.")


def _command(plan):
    account = plan["_account"]
    return ["sudo", "--", plan["_python"], "-I", "-", "--path", plan["path"],
            "--uid", str(account.pw_uid), "--user", account.pw_name,
            "--home", account.pw_dir, "--checkout", str(REPO),
            "--parents", json.dumps(plan["_records"], sort_keys=True, separators=(",", ":"))]


def host_root_plan(path) -> dict:
    """Snapshot a target and captured helper before approval, holding safe ancestors.

    Public fields are path, digest, source, command, and existing. The command's
    parent identities are completed after approved missing parents are created.
    Keep this object in memory, and close it when cancelling or replacing it.
    """
    account = _account()
    code = _capture_source()
    helper = _validation_helper(code)
    account = helper.account_record(account.pw_uid, account.pw_name, account.pw_dir)
    target = helper.canonical_path(os.fspath(path))
    helper.validate_target(target, account, REPO, creating=False)
    fds, records = helper.open_chain(target, account.pw_uid)
    plan = HostRootPlan(path=str(target), source=str(SOURCE), digest=hashlib.sha256(code).hexdigest(),
                        _code=code, _helper=helper, _account=account, _fds=fds, _records=records)
    try:
        # An outside-base prepared root still requires an independently verified home.
        home_fds, home_records = helper.open_chain(Path(account.pw_dir), account.pw_uid)
        plan.update(_home_fds=home_fds, _home_records=home_records)
        helper.validate_home(home_fds, home_records, account)
        existing = records[-1]["path"] == str(target)
        plan["existing"] = existing
        if existing:
            helper.validate_prepared_root(fds[-1])
            plan["command"] = ""
            plan["_missing"] = []
            plan["description"] = "Reuse the protected workspace without changing ownership or permissions. The locked container verifies its native profile."
        else:
            helper.validate_target(target, account, REPO, creating=True)
            helper.validate_home(fds, records, account)
            nearest = Path(records[-1]["path"])
            plan["_missing"] = list(target.parent.relative_to(nearest).parts)
            if not plan["_missing"] and records[-1]["uid"] != account.pw_uid:
                raise ValueError("The immediate workspace parent must belong to the invoking account.")
            interpreter, parents, binary = _system_python(helper)
            plan.update(_python=interpreter, _python_parents=parents, _python_identity=binary)
            plan["command"] = shlex.join(_command(plan))
            plan["description"] = (
                "Create only the selected root as root-owned, mode 0755. "
                "Approved missing application-data parents are created as the invoking account. "
                "Their inode identities are added to the displayed command after creation; "
                "the target, account, interpreter, and captured stdin code stay fixed. "
                "No existing object is chowned or chmodded.")
        helper.revalidate_chain(fds, records, account.pw_uid)
        helper.revalidate_chain(home_fds, home_records, account.pw_uid)
        return plan
    except BaseException:
        plan.close()
        raise


def create_host_root(plan) -> None:
    """Apply only this retained approval, without reopening its helper source."""
    if not isinstance(plan, HostRootPlan) or not plan.get("_fds"):
        raise ValueError("A live in-memory host workspace approval is required.")
    helper, account = plan["_helper"], plan["_account"]
    current = _account()
    helper.account_record(current.pw_uid, account.pw_name, account.pw_dir)
    fds, records = plan["_fds"], plan["_records"]
    helper.revalidate_chain(plan["_home_fds"], plan["_home_records"], account.pw_uid)
    helper.validate_home(plan["_home_fds"], plan["_home_records"], account)
    helper.revalidate_chain(fds, records, account.pw_uid)
    if plan["existing"]:
        helper.validate_prepared_root(fds[-1])
        return
    target = helper.validate_target(plan["path"], account, REPO, creating=True)
    if hashlib.sha256(plan["_code"]).hexdigest() != plan["digest"]:
        raise ValueError("Captured host helper does not match its approved digest.")
    for part in list(plan["_missing"]):
        helper.revalidate_chain(fds, records, account.pw_uid)
        parent = Path(records[-1]["path"])
        # Existing unplanned entries, even safe ones, require renewed review.
        os.mkdir(part, 0o755, dir_fd=fds[-1])
        child = os.open(part, helper.DIRECTORY_FLAGS, dir_fd=fds[-1])
        fds.append(child)
        helper.validate_directory(child, {account.pw_uid})
        captured = helper.identity(child, parent / part)
        if captured["mount"] != records[-1]["mount"] or captured["dev"] != records[-1]["dev"]:
            raise ValueError("An approved missing parent crossed a mount boundary.")
        records.append(captured)
        plan["_missing"].pop(0)
        helper.revalidate_chain(fds, records, account.pw_uid)
        os.fsync(fds[-2])
    if records[-1]["path"] != str(target.parent) or records[-1]["uid"] != account.pw_uid:
        raise ValueError("The approved workspace parent is incomplete or has the wrong owner.")
    try:
        os.stat(target.name, dir_fd=fds[-1], follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise ValueError("The approved missing workspace now exists; retain it and review the path again.")
    interpreter, parents, binary = _system_python(helper)
    if (interpreter, parents, binary) != (plan["_python"], plan["_python_parents"], plan["_python_identity"]):
        raise ValueError("The approved system Python identity changed.")
    helper.revalidate_chain(fds, records, account.pw_uid)
    command = _command(plan)
    plan["command"] = shlex.join(command)
    # Passwords remain on sudo's terminal; stdin is only the approved code bytes.
    result = subprocess.run(command, input=plan["_code"], check=False)
    if result.returncode:
        raise ValueError("Administrator access did not create a verified protected workspace; retain any created folders for inspection.")
    helper.revalidate_chain(fds, records, account.pw_uid)
    leaf = os.open(target.name, helper.DIRECTORY_FLAGS, dir_fd=fds[-1])
    try:
        helper.validate_directory(leaf, {0})
        created = helper.identity(leaf, target)
        if (stat.S_IMODE(created["mode"]) != 0o755 or created["mount"] != records[-1]["mount"]
                or created["dev"] != records[-1]["dev"]):
            raise ValueError("The new protected workspace failed verification; retain it for inspection.")
        helper.revalidate_chain(fds + [leaf], records + [created], account.pw_uid)
    finally:
        os.close(leaf)
