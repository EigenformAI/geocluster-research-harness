#!/bin/bash
# Attach only: select the same retained workspace/project as run-runtime-tui.sh.
set -euo pipefail
# Preserve the caller's terminal while Python reads this embedded selection code.
exec 3<&0
exec python3 - "$@" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys

def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=15).stdout

def main():
    args = sys.argv[1:]
    volume, root, project, container = "geocluster-native-workspace", None, "default", None
    while args and args[0] in ("--workspace-volume", "--workspace-root", "--project", "--container"):
        if len(args) < 2:
            raise ValueError(f"{args[0]} requires a value")
        key, value = args[:2]
        args = args[2:]
        if key == "--workspace-volume": volume, root = value, None
        elif key == "--workspace-root": root = str(Path(value).resolve(strict=True))
        elif key == "--project": project = value
        else: container = value
    if not args or args[0] in ("--help", "-h"):
        print("usage: scripts/process-document.sh [--workspace-volume NAME | --workspace-root DIRECTORY] [--project ID] [--container ID] submit|status|wait|list|cancel|result|export ...\nRequires a running native runtime with --processing-model. Never starts a container.")
        return
    if not project or project in (".", "..", ".runtime", ".ide-state") or "/" in project:
        raise ValueError("project must name a non-reserved project directory")
    ids = [container] if container else run(["docker", "ps", "-q"]).split()
    if not ids:
        raise ValueError("No running native runtime. Start it explicitly with scripts/run-runtime-tui.sh --processing-model PROVIDER/MODEL.")
    candidates = []
    for entry in json.loads(run(["docker", "inspect", *ids])):
        env = dict(item.split("=", 1) for item in entry.get("Config", {}).get("Env", []) if "=" in item)
        if not entry.get("State", {}).get("Running") or env.get("RUNTIME_PROFILE") != "native" or env.get("PROJECT_ID", "default") != project:
            continue
        mounts = entry.get("Mounts", [])
        if not any(m.get("Destination") == "/workspace" and ((m.get("Type") == "bind" and m.get("Source") == root) if root else (m.get("Type") == "volume" and m.get("Name") == volume)) for m in mounts):
            continue
        if not env.get("RUNTIME_NATIVE_PROCESSING_MODEL"):
            continue
        candidates.append(entry["Id"])
    if len(candidates) != 1:
        raise ValueError("Select exactly one running processing-enabled native runtime using the launcher's --workspace-volume/--workspace-root and --project (or --container). No owner was started.")
    terminal = os.isatty(3) and os.isatty(1)
    os.dup2(3, 0)
    os.close(3)
    # A real terminal forwards Ctrl-C to the container CLI's observation handler.
    attach = ["-i", "-t"] if terminal else ["-i"]
    os.execvp("docker", ["docker", "exec", *attach, "--user", "geocluster", candidates[0], "/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", f"PROJECT_ID={project}", "/usr/local/bin/node", "/opt/geocluster-runtime/process-document.mjs", *args])

try:
    main()
except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
    print(f"process-document: {error}", file=sys.stderr)
    sys.exit(1)
PY
