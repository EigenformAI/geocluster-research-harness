import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import json
import subprocess
import sys
from unittest.mock import patch

HELPER = Path(__file__).resolve().parents[2] / "scripts/workspace-client.py"
spec = importlib.util.spec_from_file_location("workspace_client", HELPER)
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class SourceTests(unittest.TestCase):
    def test_same_descriptor_survives_path_replacement_and_preserves_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.write_bytes(b"original")
            source.chmod(0o600)
            before = source.stat()
            with client.open_source(str(source)) as held:
                length, digest = client.hash_source(held)
                replacement = Path(directory) / "replacement"
                replacement.write_bytes(b"changed")
                replacement.replace(source)
                self.assertEqual(held.read(), b"original")
                self.assertEqual(length, 8)
                self.assertEqual(len(digest), 64)
                after = os.fstat(held.fileno())
                self.assertEqual((before.st_mode, before.st_uid, before.st_mtime_ns),
                                 (after.st_mode, after.st_uid, after.st_mtime_ns))

    def test_nonregular_and_symlink_sources_reject_without_blocking(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.write_bytes(b"data")
            link = Path(directory) / "link"
            link.symlink_to(source)
            fifo = Path(directory) / "fifo"
            os.mkfifo(fifo)
            for name in [directory, str(link), str(fifo)]:
                with self.assertRaises((OSError, ValueError)):
                    with client.open_source(name):
                        self.fail("accepted nonregular source")

    def test_replay_requires_both_original_fences_before_docker(self):
        for args in [["upload", "a", "b", "--operation-id", "old"],
                     ["status", "old", "--workspace-id", "id"]]:
            with self.assertRaises(ValueError):
                client.parse_args(args)

    def test_usage_is_known_rejection_not_unknown_publication(self):
        result = subprocess.run([sys.executable, str(HELPER), "upload", "one-argument"], capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["error"], "setup_failed")
        with self.assertRaises(ValueError):
            client.parse_args(["check", "--path", ""])

    def test_clean_launcher_and_only_nonsecret_config(self):
        config = {"Config": {"Env": ["RUNTIME_AUTH_DISABLED=1", "NODE_OPTIONS=evil", "IDE_LLM_TOKEN=secret"]}}
        command = client.container_command(["docker", "compose"], config, "info")
        self.assertEqual(command[2:7], ["exec", "-T", "--user", "geocluster", "geology-ide"])
        self.assertIn("/usr/bin/env", command)
        self.assertIn("-i", command)
        self.assertIn("/usr/local/bin/node", command)
        self.assertNotIn("secret", " ".join(command))
        self.assertNotIn("NODE_OPTIONS", " ".join(command))
        for env in [[], ["RUNTIME_AUTH_DISABLED=0"], ["RUNTIME_AUTH_DISABLED=1", "FLY_MACHINE_ID=managed"]]:
            with self.assertRaises(ValueError):
                client.container_command(["docker", "compose"], {"Config": {"Env": env}}, "info")


class LauncherTests(unittest.TestCase):
    def test_mock_docker_binary_streams_same_source_and_reports_unknown_without_retry(self):
        fake = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ["CALLS"], "a") as out: out.write(json.dumps(args) + "\\n")
identity = {"workspaceId": "original-id", "workspaceEpoch": "original-epoch"}
if args[0] == "inspect":
 print(json.dumps([{"State": {"Running": True}, "Config": {"Env": ["RUNTIME_AUTH_DISABLED=1", "NODE_OPTIONS=--evil", "IDE_LLM_TOKEN=secret"]}}]))
elif "ps" in args: print("selected-container")
elif "exec" in args:
 action, raw = args[-2:]; intent = json.loads(raw)
 if action == "info": print(json.dumps({**identity, "projectId": "project", "limits": {"uploadBytes": 1024}, "operations": ["upload"]}))
 elif action == "upload":
  Path(os.environ["BYTES"]).write_bytes(sys.stdin.buffer.read())
  if os.environ["OUTCOME"] == "lost": sys.exit(9)
  if os.environ["OUTCOME"] == "false": print(json.dumps({"operationId": intent["operationId"], "state": "accepted"}))
  else: print(json.dumps({"operationId": intent["operationId"], "state": "committed", "duplicate": True, "currentSourcePublished": False}))
'''
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            docker = folder / "docker"
            docker.write_text(fake)
            docker.chmod(0o755)
            source = folder / "source"
            source.write_bytes(b"unchanged private bytes")
            source.chmod(0o600)
            before = source.stat()
            for outcome in ("lost", "false", "duplicate"):
                log = folder / (outcome + ".calls")
                received = folder / (outcome + ".bytes")
                env = {**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"], "OUTCOME": outcome, "CALLS": str(log), "BYTES": str(received), "PYTHONDONTWRITEBYTECODE": "1", "COMPOSE_PROJECT_NAME": "selected-project", "COMPOSE_ENV_FILES": ".env.selected"}
                result = subprocess.run([sys.executable, str(HELPER), "upload", str(source), "inputs/data", "--operation-id", "original-op", "--workspace-id", "original-id", "--workspace-epoch", "original-epoch"], env=env, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0 if outcome == "duplicate" else 2, result.stderr)
                value = json.loads(result.stdout)
                if outcome != "duplicate":
                    self.assertEqual(value["statusCommand"], "./scripts/workspace.sh status original-op --workspace-id original-id --workspace-epoch original-epoch")
                else:
                    self.assertFalse(value["currentSourcePublished"])
                calls = [json.loads(line) for line in log.read_text().splitlines()]
                execs = [call for call in calls if "exec" in call]
                self.assertEqual(len(execs), 2, "one info and one upload; never blind retry")
                self.assertEqual(json.loads(execs[0][-1]), {"workspaceId": "original-id", "workspaceEpoch": "original-epoch"})
                self.assertIn("-T", execs[-1])
                self.assertEqual(execs[-1][execs[-1].index("/usr/bin/env") + 1], "-i")
                self.assertNotIn("secret", " ".join(execs[-1]))
                self.assertEqual(received.read_bytes(), b"unchanged private bytes")
                self.assertEqual(source.read_bytes(), b"unchanged private bytes")
                after = source.stat()
                self.assertEqual((before.st_mode, before.st_uid, before.st_mtime_ns), (after.st_mode, after.st_uid, after.st_mtime_ns))


class DiagnosticTests(unittest.TestCase):
    def test_draining_probe_never_reaches_host_or_docker_mount_mutation(self):
        class Installation:
            def require(self, action, payload=None):
                if action == "info":
                    return {"workspaceId": "id", "workspaceEpoch": "epoch"}
                if action == "admission":
                    raise client.CheckFailure({"error": "draining", "agent": "file-service", "tool": "lifecycle-admission", "action": "Retry after restart."})
                raise AssertionError("probe advanced after draining")
        with patch.object(client, "run", side_effect=AssertionError("host/Docker effects before admission")):
            with self.assertRaises(client.CheckFailure) as failure:
                client.check(Installation(), client.parse_args(["check"]))
            self.assertEqual(failure.exception.result["error"], "draining")

    def test_cleanup_failure_is_visible_and_retains_exact_inspection_command(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            root = source / "project"
            root.mkdir()
            own = {"workspaceId": "id", "workspaceEpoch": "epoch", "projectId": "project", "cwd": "/workspace/project", "captures": {"state": "available"}, "trash": {"available": True}, "operations": ["upload", "delete"]}

            class Installation:
                inspection = {"Mounts": [{"Type": "bind", "Destination": "/workspace", "Source": directory, "RW": True}]}

                def require(self, action, payload=None, user="geocluster"):
                    if action == "info": return own
                    if action == "admission": return {"admission": "open"}
                    if action == "path": return {"storage": {"availableBytes": 1024}}
                    probe = root / payload["path"]
                    if action == "probe-service":
                        assert user == "gc-files"
                        assert (probe / "host.txt").read_text() == payload["marker"]
                    elif action == "probe-agent":
                        assert user == "geocluster"
                        (probe / "host.txt").write_text("agent-edited")
                        (probe / "agent.txt").write_text("agent-output")
                    else: raise AssertionError(action)
                    return {"passed": True}

                def call(self, action, payload=None, source=None):
                    if action == "upload":
                        (root / payload["path"]).write_bytes(source.read())
                        return 0, {"operationId": payload["operationId"], "state": "committed"}
                    assert action == "cleanup"
                    return 1, {"error": "permission_denied", "agent": "file-service", "tool": "delete", "action": "Inspect ACL."}

            def docker(command, **kwargs):
                if command[1:3] == ["context", "show"]: value = b"default\n"
                elif command[1:3] == ["context", "inspect"]: value = b'[{"Endpoints":{"docker":{"Host":"unix:///var/run/docker.sock"}}}]'
                elif command[1] == "info": value = b'{"OperatingSystem":"Linux","Architecture":"x86_64"}'
                else: value = b""
                return subprocess.CompletedProcess(command, 0, value, b"")

            with patch.object(client, "run", side_effect=docker), patch.dict(os.environ, {"DOCKER_HOST": "", "DOCKER_CONTEXT": ""}):
                code, report = client.check(Installation(), client.parse_args(["check"]))
            self.assertEqual(code, 1)
            self.assertFalse(report["passed"])
            self.assertEqual(report["cleanupFailure"]["error"], "permission_denied")
            self.assertIn("--workspace-id id --workspace-epoch epoch", report["cleanupFailure"]["statusCommand"])
            self.assertTrue(Path(report["cleanupPath"]).exists(), "failed API deletion must not be hidden by host removal")


if __name__ == "__main__":
    unittest.main()
