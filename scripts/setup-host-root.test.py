#!/usr/bin/env python3
"""Protected host planning and create-only elevation, without requiring sudo."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shlex
import subprocess
import tempfile
import types
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location(
    "setup_host", Path(__file__).with_name("setup_host.py"))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
system_python = host._system_python


class HostWorkspaceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".setup-host-test-", dir=Path.home())
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        real = pwd.getpwuid(os.getuid())
        self.account = pwd.struct_passwd((real.pw_name, real.pw_passwd, real.pw_uid,
                                         real.pw_gid, real.pw_gecos, str(self.home), real.pw_shell))
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(pwd, "getpwuid", return_value=self.account).start()
        mock.patch.object(pwd, "getpwnam", return_value=self.account).start()
        mock.patch.object(host, "_system_python", return_value=("/usr/bin/python3", [], {})).start()
        self.base = self.home / ".local/share/geocluster/workspaces"
        self.target = self.base / "first"

    def plan(self, target=None):
        plan = host.host_root_plan(str(target or self.target))
        self.addCleanup(plan.close)
        return plan

    def reject(self, target):
        with self.assertRaises((ValueError, OSError)):
            self.plan(target)

    def test_plan_is_read_only_and_captures_code_and_command(self):
        plan = self.plan()
        self.assertEqual(host.allowed_host_base(), self.base)
        self.assertEqual(plan["path"], str(self.target))
        self.assertFalse(self.base.exists())
        self.assertEqual(plan["digest"], hashlib.sha256(plan["_code"]).hexdigest())
        self.assertEqual(Path(plan["source"]).name, "setup-host-root.py")
        command = shlex.split(plan["command"])
        self.assertEqual(command[:2], ["sudo", "--"])
        self.assertEqual(command[3:5], ["-I", "-"])
        self.assertTrue(plan["_fds"])
        with self.assertRaises(TypeError):
            json.dumps(plan)
        for fd in plan["_fds"]:
            os.fstat(fd)

    def test_restricts_new_roots_to_dedicated_app_data_children(self):
        for target in (Path("/"), self.home, self.base, self.home / "data",
                       host.REPO / "workspace", self.target / "nested",
                       self.base / ".hidden", self.base / "bad name"):
            with self.subTest(target=target):
                self.reject(target)
        for text in (str(self.base) + "/../escape", str(self.base) + "//first"):
            with self.subTest(target=text):
                self.reject(text)

    def test_rejects_symlinked_home_or_parent_and_writable_parents(self):
        self.base.parent.mkdir(parents=True)
        outside = self.home / "elsewhere"
        outside.mkdir()
        self.base.symlink_to(outside, target_is_directory=True)
        self.reject(self.target)
        self.base.unlink()
        self.base.mkdir(mode=0o777)
        self.base.chmod(0o777)
        self.reject(self.target)
        self.base.chmod(0o755)
        link = self.home / "home-link"
        link.symlink_to(self.home, target_is_directory=True)
        fields = list(self.account)
        fields[5] = str(link)
        linked_account = pwd.struct_passwd(fields)
        with mock.patch.object(pwd, "getpwuid", return_value=linked_account), \
                mock.patch.object(pwd, "getpwnam", return_value=linked_account):
            self.reject(link / ".local/share/geocluster/workspaces/first")

    def test_ordinary_existing_directory_and_source_tree_are_preserved(self):
        self.target.mkdir(parents=True)
        original = self.target / "important.txt"
        original.write_bytes(b"keep these bytes")
        before = self.target.stat()
        self.reject(self.target)
        self.assertEqual(original.read_bytes(), b"keep these bytes")
        self.assertEqual(self.target.stat().st_mode, before.st_mode)
        original.unlink()
        (self.base / ".git").mkdir()
        self.reject(self.base / "other")

    def test_elevation_receives_captured_source_without_reopening_it(self):
        source = self.home / "helper.py"
        source.write_bytes(host.SOURCE.read_bytes())
        with mock.patch.object(host, "SOURCE", source):
            plan = self.plan()
            captured = plan["_code"]
            source.write_bytes(b"raise RuntimeError('replacement must never run')\n")
            with mock.patch.object(host, "_capture_source", side_effect=AssertionError("reopened")), \
                    mock.patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 1)) as run:
                with self.assertRaises(ValueError):
                    host.create_host_root(plan)
        self.assertEqual(run.call_args.kwargs["input"], captured)
        self.assertNotIn("shell", run.call_args.kwargs)
        self.assertEqual(run.call_args.args[0][:2], ["sudo", "--"])
        self.assertTrue(self.base.is_dir())
        self.assertEqual(self.base.stat().st_uid, os.getuid())
        self.assertFalse(self.target.exists())

    def test_substituted_approved_ancestor_is_rejected_before_mkdir_or_sudo(self):
        self.base.mkdir(parents=True)
        plan = self.plan()
        old = self.base.with_name("old-workspaces")
        self.base.rename(old)
        self.base.mkdir()
        with mock.patch.object(subprocess, "run") as run:
            with self.assertRaises((ValueError, OSError)):
                host.create_host_root(plan)
        run.assert_not_called()
        self.assertFalse(self.target.exists())
        self.assertFalse((old / self.target.name).exists())

    def test_substituted_parent_name_is_detected_even_when_held_fd_is_valid(self):
        self.base.mkdir(parents=True)
        plan = self.plan()
        parent = self.base.parent
        parent.rename(parent.with_name("old-geocluster"))
        self.base.mkdir(parents=True)
        with mock.patch.object(subprocess, "run") as run:
            with self.assertRaises((ValueError, OSError)):
                host.create_host_root(plan)
        run.assert_not_called()

    def test_unapproved_missing_parent_collision_is_not_adopted(self):
        plan = self.plan()
        (self.home / ".local").mkdir()
        before = (self.home / ".local").stat()
        with mock.patch.object(subprocess, "run") as run:
            with self.assertRaises((ValueError, OSError)):
                host.create_host_root(plan)
        run.assert_not_called()
        self.assertEqual((self.home / ".local").stat().st_mode, before.st_mode)
        self.assertFalse(self.base.exists())

    def test_helper_rejects_replaced_parent_and_forged_mount_identity(self):
        self.base.mkdir(parents=True)
        plan = self.plan()
        helper = plan["_helper"]
        argv = shlex.split(plan["command"])[5:]
        identities = json.loads(argv[-1])
        identities[-1]["mount"] += 1
        forged = argv[:-1] + [json.dumps(identities)]
        environment = {"SUDO_UID": str(os.getuid()), "SUDO_USER": self.account.pw_name, "HOME": "/untrusted"}
        with mock.patch.object(os, "geteuid", return_value=0), mock.patch.dict(os.environ, environment):
            with self.assertRaisesRegex(ValueError, "identities"):
                helper.main(forged)
            self.base.rename(self.base.with_name("original"))
            self.base.mkdir()
            with self.assertRaisesRegex(ValueError, "identities"):
                helper.main(argv)
        self.assertFalse(self.target.exists())

    def test_helper_rejects_acl_or_writable_ancestors_independently(self):
        self.base.mkdir(parents=True)
        plan = self.plan()
        helper = plan["_helper"]
        argv = shlex.split(plan["command"])[5:]
        environment = {"SUDO_UID": str(os.getuid()), "SUDO_USER": self.account.pw_name}
        with mock.patch.object(os, "geteuid", return_value=0), mock.patch.dict(os.environ, environment):
            with mock.patch.object(os, "listxattr", return_value=["system.posix_acl_default"]):
                with self.assertRaisesRegex(ValueError, "ACL"):
                    helper.main(argv)
            self.base.chmod(0o777)
            with self.assertRaisesRegex(ValueError, "permission"):
                helper.main(argv)
        self.assertFalse(self.target.exists())

    def root_owner(self, path):
        """Emulate only root ownership, not privilege or kernel access control."""
        original = os.fstat
        def inspect(fd):
            info = original(fd)
            name = os.readlink(f"/proc/self/fd/{fd}")
            if name == str(path) or name.startswith(str(path) + "/"):
                fields = {key: getattr(info, key) for key in dir(info) if key.startswith("st_")}
                fields["st_uid"] = 0
                return types.SimpleNamespace(**fields)
            return info
        return mock.patch.object(os, "fstat", side_effect=inspect)

    def test_mocked_root_creation_creates_only_leaf_without_repairs(self):
        plan = self.plan()
        def elevate(command, **options):
            self.assertEqual(options["input"], plan["_code"])
            environment = {"SUDO_UID": str(os.getuid()), "SUDO_USER": self.account.pw_name, "HOME": "/ignored"}
            with mock.patch.object(os, "geteuid", return_value=0), mock.patch.dict(os.environ, environment):
                plan["_helper"].main(command[5:])
            return subprocess.CompletedProcess(command, 0)
        with self.root_owner(self.target), mock.patch.object(subprocess, "run", side_effect=elevate) as run, \
                mock.patch.object(os, "chmod", side_effect=AssertionError("chmod")), \
                mock.patch.object(os, "chown", side_effect=AssertionError("chown")), \
                mock.patch.object(host, "_capture_source", side_effect=AssertionError("reopened")):
            self.assertIsNone(host.create_host_root(plan))
            self.assertIsNone(host.validate_existing_root(str(self.target)))
        run.assert_called_once()
        self.assertEqual(list(self.base.iterdir()), [self.target])
        self.assertEqual(list(self.target.iterdir()), [])
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.base.stat().st_uid, os.getuid())
        self.assertEqual(len(plan["_fds"]), len(plan["_records"]))

    def test_prepared_root_reuse_checks_metadata_without_permission_changes(self):
        private = self.target / ".runtime"
        private.mkdir(parents=True)
        (private / "profile").write_bytes(b"native\n")
        (private / "profile").chmod(0o600)
        (private / "owner.lock").touch(mode=0o600)
        (private / "setup").mkdir(mode=0o700)
        before = {str(path): path.stat().st_mode for path in self.target.rglob("*")}
        with self.root_owner(self.target), mock.patch.object(subprocess, "run") as run, \
                mock.patch.object(os, "chmod", side_effect=AssertionError("chmod")), \
                mock.patch.object(os, "chown", side_effect=AssertionError("chown")):
            plan = self.plan()
            self.assertTrue(plan["existing"])
            self.assertIsNone(host.create_host_root(plan))
        run.assert_not_called()
        self.assertEqual(before, {str(path): path.stat().st_mode for path in self.target.rglob("*")})

    def test_host_rejects_acl_and_symlink_helper_source(self):
        with mock.patch.object(os, "listxattr", return_value=["system.posix_acl_access"]):
            self.reject(self.target)
        source = self.home / "source-link"
        source.symlink_to(host.SOURCE)
        with mock.patch.object(host, "SOURCE", source):
            self.reject(self.target)

    def test_parent_renamed_during_creation_never_redirects_sudo(self):
        plan = self.plan()
        original = os.mkdir
        def replace(name, *args, **kwargs):
            result = original(name, *args, **kwargs)
            if name == "share":
                (self.home / ".local").rename(self.home / "renamed-local")
                (self.home / ".local").mkdir()
            return result
        with mock.patch.object(os, "mkdir", side_effect=replace), mock.patch.object(subprocess, "run") as run:
            with self.assertRaises((ValueError, OSError)):
                host.create_host_root(plan)
        run.assert_not_called()
        self.assertFalse(self.base.exists())
        self.assertFalse((self.home / "renamed-local/share/geocluster").exists())

    def test_helper_parent_rename_cannot_redirect_privileged_leaf_creation(self):
        self.base.mkdir(parents=True)
        plan = self.plan()
        old = self.base.with_name("renamed-workspaces")
        original = os.mkdir
        def replace(name, *args, **kwargs):
            if name == self.target.name:
                self.base.rename(old)
                original(self.base)
            return original(name, *args, **kwargs)
        environment = {"SUDO_UID": str(os.getuid()), "SUDO_USER": self.account.pw_name}
        with self.root_owner(old / self.target.name), mock.patch.object(os, "geteuid", return_value=0), \
                mock.patch.dict(os.environ, environment), mock.patch.object(os, "mkdir", side_effect=replace):
            with self.assertRaisesRegex(ValueError, "renamed|replaced"):
                plan["_helper"].main(shlex.split(plan["command"])[5:])
        self.assertFalse(self.target.exists())
        self.assertTrue((old / self.target.name).is_dir())
        self.assertEqual(list((old / self.target.name).iterdir()), [])

    def test_closed_approval_cannot_be_applied(self):
        plan = self.plan()
        fds = list(plan["_fds"]) + list(plan["_home_fds"])
        plan.close()
        plan.close()
        for fd in fds:
            with self.assertRaises(OSError):
                os.fstat(fd)
        with mock.patch.object(subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "live"):
                host.create_host_root(plan)
        run.assert_not_called()
        self.assertFalse(self.base.exists())

    def test_root_helper_preserves_leaf_collisions(self):
        self.base.mkdir(parents=True)
        plan = self.plan()
        self.target.write_bytes(b"keep an unexpected ordinary file")
        self.target.chmod(0o600)
        environment = {"SUDO_UID": str(os.getuid()), "SUDO_USER": self.account.pw_name}
        with mock.patch.object(os, "geteuid", return_value=0), mock.patch.dict(os.environ, environment), \
                mock.patch.object(os, "chmod", side_effect=AssertionError("chmod")), \
                mock.patch.object(os, "chown", side_effect=AssertionError("chown")):
            with self.assertRaises(FileExistsError):
                plan["_helper"].main(shlex.split(plan["command"])[5:])
        self.assertEqual(self.target.read_bytes(), b"keep an unexpected ordinary file")
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o600)

    def test_prepared_empty_root_can_be_reused_outside_automatic_creation_base(self):
        outside = self.home / "prepared"
        outside.mkdir()
        with self.root_owner(outside), mock.patch.object(subprocess, "run") as run:
            plan = self.plan(outside)
            self.assertTrue(plan["existing"])
            self.assertIsNone(host.create_host_root(plan))
            self.assertIsNone(host.validate_existing_root(outside))
        run.assert_not_called()
        self.assertEqual(list(outside.iterdir()), [])

    def test_source_capture_is_bounded_and_detects_mid_capture_changes(self):
        source = self.home / "helper.py"
        source.write_bytes(b"x" * (host.SOURCE_LIMIT + 1))
        with mock.patch.object(host, "SOURCE", source):
            with self.assertRaisesRegex(ValueError, "bounded"):
                host._capture_source()
            source.write_bytes(b"original helper bytes\n")
            original = os.read
            def change(fd, count):
                result = original(fd, count)
                source.write_bytes(b"replacement helper bytes\n")
                return result
            with mock.patch.object(os, "read", side_effect=change):
                with self.assertRaisesRegex(ValueError, "changed"):
                    host._capture_source()

    def test_system_interpreter_rejects_an_account_owned_binary(self):
        binary = self.home / "python3"
        binary.write_bytes(b"not a trusted system interpreter")
        binary.chmod(0o755)
        fd = os.open(binary, os.O_RDONLY)
        self.addCleanup(os.close, fd)
        helper = types.SimpleNamespace(
            open_chain=mock.Mock(return_value=([fd], [{"path": "/usr/bin"}])),
            close_fds=mock.Mock(), reject_acl=mock.Mock(), identity=mock.Mock())
        with mock.patch.object(Path, "resolve", return_value=Path("/usr/bin/python3")), \
                mock.patch.object(os, "open", side_effect=lambda *args, **kwargs: os.dup(fd)):
            with self.assertRaisesRegex(ValueError, "system Python"):
                system_python(helper)
        helper.identity.assert_not_called()

    def test_leaf_collision_is_preserved_without_elevation(self):
        self.base.mkdir(parents=True)
        plan = self.plan()
        self.target.mkdir(mode=0o700)
        original = self.target / "keep"
        original.write_bytes(b"untouched")
        with mock.patch.object(subprocess, "run") as run:
            with self.assertRaises((ValueError, OSError)):
                host.create_host_root(plan)
        run.assert_not_called()
        self.assertEqual(original.read_bytes(), b"untouched")
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o700)

    def test_helper_rejects_nonroot_and_mismatched_sudo_identity(self):
        plan = self.plan()
        helper = plan["_helper"]
        argv = shlex.split(plan["command"])[5:]
        with mock.patch.object(os, "geteuid", return_value=os.getuid()):
            with self.assertRaisesRegex(ValueError, "root"):
                helper.main(argv)
        with mock.patch.object(os, "geteuid", return_value=0), \
                mock.patch.dict(os.environ, {"SUDO_UID": str(os.getuid()), "SUDO_USER": "other"}):
            with self.assertRaisesRegex(ValueError, "account|identity"):
                helper.main(argv)
        self.assertFalse(self.base.exists())


if __name__ == "__main__":
    unittest.main()
