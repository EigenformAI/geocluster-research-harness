#!/usr/bin/env python3
"""Resolve the launcher's CLI sharing mode; stdout is only the bootstrap UID."""

import json
import os
import re
import subprocess
import sys


class SetupError(Exception):
    pass


def report(message):
    print(f"runtime-tui: {message}", file=sys.stderr)


def probe(label, *command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError, UnicodeError):
        raise SetupError(f"{label} probe failed") from None
    if result.returncode:
        raise SetupError(f"{label} probe failed")
    return result.stdout.removesuffix("\n")


def invalid_json_constant(value):
    raise ValueError("non-finite JSON number")


def read_json(label, *command):
    try:
        return json.loads(probe(label, *command), parse_constant=invalid_json_constant)
    except ValueError:
        raise SetupError(f"{label} metadata is malformed") from None


def valid_uid(uid):
    return (re.fullmatch(r"[1-9][0-9]{0,9}", uid) is not None
            and int(uid) <= 4294967294 and int(uid) not in range(996, 1000))


def resolve_endpoint(details):
    context_override = os.environ.get("DOCKER_CONTEXT", "")
    host_override = os.environ.get("DOCKER_HOST", "")
    if context_override:
        details["endpoint source"] = "DOCKER_CONTEXT"
        context = context_override
    elif host_override:
        details["endpoint source"] = "DOCKER_HOST"
        return host_override
    else:
        details["endpoint source"] = "docker context show"
        context = probe("Docker context", "docker", "context", "show")
    # Context names are useful diagnostics, but never echo arbitrary URLs.
    details["context"] = context if re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", context) else "unknown"
    data = read_json("Docker context", "docker", "context", "inspect", context)
    try:
        if not isinstance(data, list) or len(data) != 1:
            raise TypeError
        endpoint = data[0]["Endpoints"]["docker"]["Host"]
        if not isinstance(endpoint, str) or not endpoint:
            raise TypeError
        return endpoint
    except (KeyError, TypeError):
        raise SetupError("Docker context endpoint metadata is unavailable") from None


def default_endpoint(endpoint, details):
    return (details["endpoint source"] == "docker context show"
            and details["context"] == "default"
            and endpoint in ("unix:///var/run/docker.sock", "unix:///run/docker.sock"))


def qualify_daemon(details):
    # Full-object JSON omits healthy ServerErrors; project it explicitly as null.
    template = ('{"OSType":{{json .OSType}},"OperatingSystem":{{json .OperatingSystem}},'
                '"SecurityOptions":{{json .SecurityOptions}},"ServerErrors":{{json .ServerErrors}}}')
    info = read_json("Docker daemon", "docker", "info", "--format", template)
    if not isinstance(info, dict):
        raise SetupError("Docker daemon metadata is unavailable")
    platform = info.get("OSType")
    system = info.get("OperatingSystem")
    security = info.get("SecurityOptions")
    if platform in ("linux", "windows"):
        details["daemon"] = platform
    desktop = isinstance(system, str) and "docker desktop" in system.casefold()
    if isinstance(system, str):
        details["Desktop"] = str(desktop).lower()
    if isinstance(security, list) and all(isinstance(option, str) for option in security):
        options = {part for option in security for part in option.split(",")}
        details["rootless"] = str("name=rootless" in options).lower()
        details["userns"] = str("name=userns" in options).lower()
    else:
        raise SetupError("Docker daemon security metadata is unavailable")
    if (not {"OSType", "OperatingSystem", "SecurityOptions", "ServerErrors"} <= info.keys()
            or not isinstance(system, str) or info["ServerErrors"] not in (None, [])):
        raise SetupError("Docker daemon metadata is unavailable or reports server errors")
    if platform != "linux" or desktop or details["rootless"] == "true" or details["userns"] == "true":
        raise SetupError("automatic sharing requires a Linux daemon without Docker Desktop, rootless, or userns remapping")


def select_uid(mode, bind_source):
    if mode not in ("auto", "none") and not valid_uid(mode):
        raise SetupError("--host-uid must be auto, none, or a canonical decimal UID from 1 through 4294967294, excluding 996–999")
    if not bind_source:
        if mode not in ("auto", "none"):
            raise SetupError("numeric --host-uid requires --workspace-root")
        report("host sharing disabled (volume transfer mode)")
        return ""
    if mode == "none":
        report("host sharing disabled (--host-uid none); existing permissions are unchanged")
        return ""

    details = {"endpoint source": "unknown", "context": "unknown", "daemon": "unknown",
               "rootless": "unknown", "userns": "unknown", "Desktop": "unknown"}
    if mode != "auto":
        try:
            conventional = default_endpoint(resolve_endpoint(details), details)
        except SetupError:
            conventional = False
        if not conventional:
            report(f"warning: bind source {bind_source!r} is a daemon-host path; client-side path resolution does not prove locality. Explicit UID {mode} remains subject to container mapping and ACL checks")
        report(f"host sharing explicit UID {mode}")
        return mode

    try:
        if probe("client platform", "uname", "-s") != "Linux":
            raise SetupError("automatic sharing requires a Linux client")
        endpoint = resolve_endpoint(details)
        if not default_endpoint(endpoint, details):
            raise SetupError("automatic sharing requires the default context and standard local socket, without Docker endpoint overrides")
        qualify_daemon(details)
        uid = probe("invoking UID", "id", "-u")
        if not valid_uid(uid):
            raise SetupError("invoking UID must be canonical decimal from 1 through 4294967294, excluding 996–999; run as an ordinary account or choose an explicit UID")
    except SetupError as error:
        state = "; ".join(f"{key}={value}" for key, value in details.items())
        raise SetupError(f"automatic host sharing unavailable: {error} ({state}). Use a named volume for volume transfer mode, --host-uid none for custom permissions, or --host-uid UID for an explicit daemon-host account") from None
    report(f"host sharing auto selected UID {uid}")
    return uid


if __name__ == "__main__":
    try:
        print(select_uid(*sys.argv[1:]))
    except SetupError as error:
        report(str(error))
        sys.exit(2)
