"""Bounded host source transfer and operator diagnostics for the selected Compose service."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid

REPO = Path(__file__).resolve().parent.parent
TRUSTED_PATH = "/usr/local/bin:/usr/bin:/bin"


class UsageParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def canonical(value):
    if not value or any(part in ("", ".", "..") for part in value.split("/")) or "\\" in value or any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise ValueError("Use a canonical UTF-8 project-relative POSIX path.")
    return value


def parse_args(args):
    parser = UsageParser(description="Local workspace checks and explicit shared uploads; exit 0 committed/pass, 1 rejection, 2 unknown/pending.")
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="Bounded host/agent/service round trip; retains API receipts and private recovery entries.")
    check.add_argument("--path", help="Read-only metadata and effective-access diagnosis; no file content reads.")
    upload = sub.add_parser("upload", help="Publish one regular source; create-only by default. Query status before replaying an uncertain transfer.")
    upload.add_argument("source")
    upload.add_argument("destination")
    upload.add_argument("--force-replace", action="store_true")
    upload.add_argument("--processing", choices=["auto", "skip"], default="auto")
    upload.add_argument("--operation-id", help="Explicit replay ID; requires both ORIGINAL workspace fences and identical intent/bytes.")
    status_parser = sub.add_parser("status", help="Inspect the original retained operation; never refresh its fence.")
    status_parser.add_argument("operation_id")
    for item in (upload, status_parser):
        item.add_argument("--workspace-id")
        item.add_argument("--workspace-epoch")
    options = parser.parse_args(args)
    if options.command in ("upload", "status"):
        pair = (options.workspace_id, options.workspace_epoch)
        if bool(pair[0]) != bool(pair[1]) or (options.operation_id and not all(pair)) or (all(pair) and not options.operation_id):
            raise ValueError("Explicit operation IDs require both ORIGINAL --workspace-id and --workspace-epoch; never replay with newly fetched fences.")
        for value in pair:
            if value and not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
                raise ValueError("Invalid workspace fence.")
        if options.operation_id and not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", options.operation_id):
            raise ValueError("Invalid operation ID.")
    if options.command == "upload":
        canonical(options.destination)
    if options.command == "check" and options.path is not None:
        canonical(options.path)
    return options


def open_source(name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Upload source must be one regular file, not a directory, link, or special file.")
        return os.fdopen(fd, "rb", buffering=0)
    except BaseException:
        os.close(fd)
        raise


def hash_source(source, ceiling=2**53 - 1):
    if not isinstance(ceiling, int) or isinstance(ceiling, bool) or not 0 < ceiling <= 2**53 - 1:
        raise ValueError("The service did not advertise a valid upload byte ceiling.")
    if os.fstat(source.fileno()).st_size > ceiling:
        raise ValueError(f"Source exceeds advertised uploadBytes={ceiling}.")
    digest, size = hashlib.sha256(), 0
    while True:
        chunk = source.read(1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > ceiling:
            raise ValueError(f"Source exceeds advertised uploadBytes={ceiling}.")
        digest.update(chunk)
    source.seek(0)
    return size, digest.hexdigest()


def run(command, **kwargs):
    if command[:2] == ['docker', 'compose']:
        # Inspection/exec never builds. Compose still requires build interpolation
        # when the terminal launcher is the only setup command the user has run.
        env = dict(kwargs.pop('env', os.environ))
        env.setdefault('PREPROCESSING_BUILD_CONTEXT', str(REPO / '.geocluster-local' / 'bundle'))
        env.setdefault('PREPROCESSING_BUNDLE_DIGEST', '0' * 64)
        kwargs['env'] = env
    return subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=kwargs.pop("timeout", 30), **kwargs)


def checked_json(command):
    result = run(command)
    if result.returncode:
        raise ValueError("Docker/Compose inspection failed. Check the selected context and service with docker compose ps.")
    return json.loads(result.stdout)


def container_command(compose, inspection, action, payload=None, user="geocluster"):
    # Inspect in the host process. Never print or forward the configured environment.
    env = dict(item.split("=", 1) for item in inspection.get("Config", {}).get("Env", []) if "=" in item)
    if env.get("RUNTIME_AUTH_DISABLED") != "1" or env.get("FLY_MACHINE_ID"):
        raise ValueError("This helper requires local RUNTIME_AUTH_DISABLED=1. Use your existing authenticated file API client for authenticated deployments.")
    return compose + ["exec", "-T", "--user", user, "geology-ide", "/usr/bin/env", "-i", f"PATH={TRUSTED_PATH}", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "RUNTIME_AUTH_DISABLED=1", "/usr/local/bin/node", "/opt/geocluster-runtime/workspace-client.mjs", action, json.dumps(payload or {}, ensure_ascii=True)]


class Installation:
    def __init__(self):
        self.compose = ["docker", "compose", "--project-directory", str(REPO), "-f", str(REPO / "docker-compose.yml")]
        selected = run(self.compose + ["ps", "-q", "geology-ide"])
        ids = selected.stdout.decode().split()
        if selected.returncode or len(ids) != 1:
            raise ValueError("Select exactly one running geology-ide service using COMPOSE_PROJECT_NAME and COMPOSE_ENV_FILES; run docker compose ps.")
        self.inspection = checked_json(["docker", "inspect", ids[0]])[0]
        if not self.inspection.get("State", {}).get("Running"):
            raise ValueError("Selected geology-ide container is not running; start it before using this helper.")
        container_command(self.compose, self.inspection, "info")

    def call(self, action, payload=None, source=None, user="geocluster"):
        command = container_command(self.compose, self.inspection, action, payload, user)
        try:
            result = run(command, stdin=source if source is not None else subprocess.DEVNULL, timeout=660 if action == "upload" else 40)
            value = json.loads(result.stdout)
            if not isinstance(value, dict):
                raise ValueError("Expected a structured helper result.")
            return result.returncode, value
        except (subprocess.TimeoutExpired, ValueError, OSError) as error:
            return (2 if action in ("upload", "status", "cleanup") else 1), failure("transport_unknown", f"Container helper response unavailable: {type(error).__name__}.")

    def require(self, action, payload=None, user="geocluster"):
        code, result = self.call(action, payload, user=user)
        if code:
            raise CheckFailure(result)
        return result


class CheckFailure(Exception):
    def __init__(self, result):
        self.result = result


def failure(error, message):
    return {"error": error, "message": message, "agent": "local-workspace", "tool": "workspace-client", "action": "Inspect the selected mount, service logs, mode and effective ACL masks; correct setup and retry."}


def recoverable(result, intent):
    result.update({key: intent[key] for key in ("operationId", "workspaceId", "workspaceEpoch")})
    result["statusCommand"] = f"./scripts/workspace.sh status {intent['operationId']} --workspace-id {intent['workspaceId']} --workspace-epoch {intent['workspaceEpoch']}"
    return result


def upload(installation, options):
    # Hold the descriptor from validation through hashing and Docker's stdin read.
    with open_source(options.source) as source:
        original = {"workspaceId": options.workspace_id, "workspaceEpoch": options.workspace_epoch} if options.operation_id else {}
        info = installation.require("info", original)
        if "upload" not in info.get("operations", []):
            raise CheckFailure(failure("upload_unavailable", f"Protected upload unavailable: {info.get('captures')}"))
        length, digest = hash_source(source, info["limits"]["uploadBytes"])
        intent = {**{key: info[key] for key in ("workspaceId", "workspaceEpoch")}, **original,
                  "operationId": options.operation_id or str(uuid.uuid4()), "path": options.destination,
                  "mode": "force-replace" if options.force_replace else "create", "processing": options.processing,
                  "length": length, "digest": digest}
        print(json.dumps({"projectId": info.get("projectId"), "destination": intent["path"], **recoverable({}, intent)}), file=sys.stderr, flush=True)
        code, result = installation.call("upload", intent, source)
        if code not in (0, 1, 2):
            code, result = 2, failure("transport_unknown", "Docker exec ended without a confirmed publication receipt.")
        if code == 0 and (result.get("state") != "committed" or result.get("operationId") != intent["operationId"]):
            code, result = 2, failure("transport_unknown", "No matching committed operation receipt was returned.")
        if code == 2:
            recoverable(result, intent)
        return code, result


def host_path(root, relative):
    current = root
    for part in canonical(relative).split("/"):
        current = current / part
        if current.is_symlink():
            raise ValueError(f"symlink: {current}; select a real contained project path.")
    return current


def read_probe(name):
    with open_source(str(name)) as held:
        if os.fstat(held.fileno()).st_size > 1024:
            raise ValueError("Probe output exceeds the 1024-byte diagnostic bound.")
        result = held.read(1025)
        if len(result) > 1024:
            raise ValueError("Probe output grew beyond the diagnostic bound.")
        return result


def check(installation, options):
    info = installation.require("info")
    fence = {key: info[key] for key in ("workspaceId", "workspaceEpoch")}
    report = {"info": info, "observations": [], "warnings": [], "mutationProbe": not bool(options.path)}
    if options.path:
        report["access"] = [installation.require("path", {**fence, "info": info, "path": options.path}, user=user) for user in ("geocluster", "gc-files")]
        report["passed"] = all(item["readable"] and item["writable"] and item["parentWritable"] and item["traversable"] is not False for item in report["access"])
        return (0 if report["passed"] else 1), report
    # Query admission before creating any host entries. No model or processing work.
    installation.require("admission", fence)
    if info.get("captures", {}).get("state") != "available" or not info.get("trash", {}).get("available") or not {"upload", "delete"}.issubset(info.get("operations", [])):
        raise CheckFailure(failure("capability_unavailable", f"Capture/trash provider: {info.get('captures')}; {info.get('trash')}"))
    context_name = run(["docker", "context", "show"]).stdout.decode().strip()
    context = checked_json(["docker", "context", "inspect", context_name])[0]
    endpoint = os.environ.get("DOCKER_HOST") if not os.environ.get("DOCKER_CONTEXT") else None
    endpoint = endpoint or context.get("Endpoints", {}).get("docker", {}).get("Host", "")
    report["context"] = {"name": context_name, "endpoint": endpoint}
    if endpoint.startswith(("ssh:", "tcp:", "http:", "https:")):
        raise CheckFailure(failure("host_roundtrip_failed", "Remote Docker binds are not a verified host editing surface. Streamed uploads remain available."))
    daemon = run(["docker", "info", "--format", "{{json .}}"])
    if daemon.returncode == 0:
        data = json.loads(daemon.stdout)
        report["docker"] = {key: data.get(key) for key in ("OperatingSystem", "OSType", "Architecture", "Driver")}
        if "desktop" in str(data.get("OperatingSystem", "")).lower() or sys.platform != "linux":
            report["warnings"].append("Docker Desktop/host permission translation is unqualified; this probe does not qualify native storage or performance.")
    mounts = [mount for mount in installation.inspection.get("Mounts", []) if mount.get("Destination") == "/workspace"]
    if len(mounts) != 1 or mounts[0].get("Type") != "bind" or not mounts[0].get("RW"):
        raise CheckFailure(failure("host_roundtrip_failed", "The actual /workspace mount must be one writable host bind."))
    mount = mounts[0]
    source = Path(mount["Source"])
    if not source.is_dir() or source.is_symlink():
        raise CheckFailure(failure("host_roundtrip_failed", "Actual bind source is missing, inaccessible, or a symlink; no source directory was created."))
    project = canonical(info.get("projectId") or "")
    if "/" in project or info.get("cwd") != f"/workspace/{project}":
        raise ValueError("The selected service does not identify a direct /workspace project subtree.")
    root = host_path(source, project)
    if not root.is_dir():
        raise CheckFailure(failure("host_roundtrip_failed", "Actual selected project source is missing or inaccessible; no project directory was created."))
    report["mount"] = {key: mount.get(key) for key in ("Source", "Destination", "Type", "RW")}
    storage = os.statvfs(root)
    report["storage"] = {"availableBytes": storage.f_bavail * storage.f_frsize, "availableInodes": storage.f_favail}
    usage = run(["docker", "system", "df", "--format", "{{json .}}"])
    report["dockerStorage"] = usage.stdout.decode().splitlines() if usage.returncode == 0 else "unavailable"
    relative, created, uncertain = "workspace-check-" + uuid.uuid4().hex, False, False
    probe = root / relative
    try:
        installation.require("admission", fence)
        probe.mkdir(mode=0o777)
        created = True
        marker = uuid.uuid4().hex
        marker_path = probe / "host.txt"
        with marker_path.open("xb") as out:
            out.write(marker.encode())
        report["observations"].append("host-created ordinary directory and bounded marker")
        payload = {**fence, "info": info, "path": relative, "marker": marker}
        report["filesystem"] = installation.require("path", {**fence, "info": info, "path": relative})
        report["observations"].append(installation.require("probe-service", payload, user="gc-files"))
        installation.require("admission", fence)
        report["observations"].append(installation.require("probe-agent", payload))
        if read_probe(marker_path) != b"agent-edited":
            raise CheckFailure(failure("host_roundtrip_failed", "Host cannot observe agent in-place editing of its marker."))
        # Publish into the host-created directory through the daemon, with extraction skipped.
        with open_source(str(marker_path)) as held:
            length, digest = hash_source(held, 1024)
            intent = {**fence, "operationId": str(uuid.uuid4()), "path": f"{relative}/service.txt", "mode": "create", "processing": "skip", "length": length, "digest": digest}
            print(json.dumps(recoverable({"probeUpload": intent["path"]}, intent)), file=sys.stderr, flush=True)
            code, receipt = installation.call("upload", intent, held)
            if code or receipt.get("state") != "committed":
                uncertain = code != 1
                raise CheckFailure(recoverable(receipt, intent))
            report["observations"].append(receipt)
        for name, expected in (("agent.txt", b"agent-output"), ("service.txt", b"agent-edited")):
            target = host_path(probe, name)
            if read_probe(target) != expected:
                raise CheckFailure(failure("host_roundtrip_failed", f"Unexpected {name} bytes from selected bind."))
            fd = os.open(target, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "r+b") as out:
                if not stat.S_ISREG(os.fstat(out.fileno()).st_mode):
                    raise ValueError("Probe output is no longer a regular file.")
                out.write(b"host-edited")
                out.truncate()
            replacement = probe / (name + ".replacement")
            with replacement.open("xb") as out:
                out.write(b"host-replaced")
            replacement.replace(target)
            report["observations"].append(f"host read, edited, and replaced {name}")
        installation.require("admission", fence)
        report["passed"] = True
    except (CheckFailure, OSError, ValueError) as error:
        report["failure"] = error.result if isinstance(error, CheckFailure) else failure("host_roundtrip_failed", str(error))
    finally:
        if created:
            cleanup_intent = {**fence, "path": relative, "operationId": str(uuid.uuid4())}
            code, receipt = installation.call("cleanup", cleanup_intent)
            report["cleanup"] = receipt
            report["retentionNotice"] = "Visible probe entries use normal API deletion; operation receipts and private recovery entries remain under normal retention."
            if code or receipt.get("state") != "committed":
                uncertain = uncertain or code != 1
                report["cleanupFailure"] = recoverable(receipt, cleanup_intent)
                report["cleanupPath"] = str(probe)
    report["passed"] = not uncertain and "failure" not in report and "cleanupFailure" not in report
    return (2 if uncertain else 1 if "failure" in report or "cleanupFailure" in report else 0), report


def main(args):
    try:
        options = parse_args(args)
        installation = Installation()
        if options.command == "upload":
            code, result = upload(installation, options)
        elif options.command == "status":
            intent = {"operationId": options.operation_id, "workspaceId": options.workspace_id, "workspaceEpoch": options.workspace_epoch}
            code, result = installation.call("status", intent)
            if code not in (0, 1, 2) or code == 0 and (result.get("state") != "committed" or result.get("operationId") != options.operation_id):
                code, result = 2, failure("transport_unknown", "No matching committed receipt returned.")
            if code == 2:
                recoverable(result, intent)
        else:
            code, result = check(installation, options)
    except CheckFailure as error:
        code, result = 1, error.result
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        code, result = 1, failure("setup_failed", str(error))
    print(json.dumps(result, ensure_ascii=True))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
