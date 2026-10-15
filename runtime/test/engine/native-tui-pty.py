"""Bounded stdlib PTY adapter. JSON commands on stdin; terminal/exit events on stdout.

The first command supplies argv, cwd and an explicit environment. Credentials never
become argv. The child has a controlling terminal and runs as image UID/GID 999.
"""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def emit(value):
    print(json.dumps(value), flush=True)


spec = json.loads(sys.stdin.readline())
pid, master = pty.fork()
if pid == 0:
    os.setgroups([])
    os.setgid(spec.get("gid", 999))
    os.setuid(spec.get("uid", 999))
    os.chdir(spec["cwd"])
    os.execve(spec["argv"][0], spec["argv"], spec["env"])


def resize(rows, cols):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)


resize(40, 140)
emit({"pid": pid})
deadline = time.monotonic() + 180
buffer = b""
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([sys.stdin.buffer, master], [], [], 0.1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if data:
                emit({"terminal": base64.b64encode(data).decode()})
                # Answer terminal discovery without pretending to be a pixel renderer.
                if b"\x1b[6n" in data:
                    os.write(master, b"\x1b[1;1R")
                if b"\x1b[c" in data or b"\x1b[0c" in data:
                    os.write(master, b"\x1b[?1;2c")
                if b"\x1b]11;?" in data:
                    os.write(master, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
        if sys.stdin.buffer in ready:
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                break
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                command = json.loads(line)
                if "send" in command:
                    os.write(master, command["send"].encode())
                if "resize" in command:
                    resize(*command["resize"])
                    emit({"resized": command["resize"]})
                if "signal" in command:
                    os.kill(pid, getattr(signal, command["signal"]))
                if command.get("loss"):
                    os.close(master)
                    master = None
                    os.kill(pid, signal.SIGHUP)
                    break
        gone, status = os.waitpid(pid, os.WNOHANG)
        if gone:
            emit({"exit": os.waitstatus_to_exitcode(status)})
            pid = None
            break
        if master is None:
            for _ in range(30):
                gone, status = os.waitpid(pid, os.WNOHANG)
                if gone:
                    emit({"exit": os.waitstatus_to_exitcode(status), "terminalLoss": True})
                    pid = None
                    break
                time.sleep(0.1)
            break
    else:
        emit({"error": "PTY deadline exceeded"})
finally:
    if pid:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    if master is not None:
        os.close(master)
