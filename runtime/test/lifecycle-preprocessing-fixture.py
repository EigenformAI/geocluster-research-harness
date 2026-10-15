"""Observable Linux process fixtures for the runtime standalone adapter."""
import asyncio
import ctypes
import importlib.util
import json
import os
import signal
import sys
import tempfile
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location('runtime_pair', Path(__file__).parents[1] / 'preprocessing-pair.py')
pair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pair)

CHILD = r'''
import json, os, signal, subprocess, sys, time
from pathlib import Path
role, root, behavior, version = sys.argv[1:]
root = Path(root)
def event(value):
    with (root / 'events').open('a') as handle: handle.write(value + '\n')
def stop(*args):
    event(role + ':term')
    if behavior in ('hang', 'hang-startup'): return
    time.sleep(.06)
    event(role + ':checkpoint')
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
if role == 'owner' and behavior != 'hang-startup':
    if behavior == 'invalid':
        raw = ' ' * (4 * 1024 * 1024) + json.dumps({'mode':'standalone', 'engineInstanceId':'fresh'}) if version == 'oversized' else version
    else:
        raw = json.dumps({'version':version, 'mode':'standalone', 'engineInstanceId':'retained' if behavior == 'stale' else str(os.getpid())})
    (root / 'descriptor').write_text(raw)
if role == 'service':
    assert 'OWNER_SECRET' not in os.environ
    assert os.environ['SERVICE_SECRET'] == 'service-only'
    child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'], start_new_session=True)
    (root / 'descendant').write_text(str(child.pid))
if role == 'owner':
    assert 'SERVICE_SECRET' not in os.environ
    assert os.environ['OWNER_SECRET'] == 'owner-only'
event(role + ':started')
while True: time.sleep(.02)
'''


async def check(behavior, version='2.0.19'):
    ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)
    with tempfile.TemporaryDirectory(prefix='lifecycle-pair-') as temp:
        root = Path(temp)
        stopped = asyncio.Event()
        owner_behavior = 'normal'
        # Startup-force verifies that a forced owner cannot be reported as clean.
        if behavior == 'startup-force':
            owner_behavior = 'hang-startup'
        if behavior == 'stale':
            owner_behavior = 'stale'
            (root / 'descriptor').write_text(json.dumps({'version':'2.0.19', 'mode':'standalone', 'engineInstanceId':'retained', 'recovery': {}}))
        if behavior == 'invalid':
            owner_behavior = 'invalid'
        task = asyncio.create_task(pair.run_pair(
            [sys.executable, '-c', CHILD, 'owner', temp, owner_behavior, version],
            [sys.executable, '-c', CHILD, 'service', temp, 'hang' if behavior == 'force' else 'normal', version],
            root / 'descriptor', stopped,
            owner_env={'PATH': os.defpath, 'OWNER_SECRET': 'owner-only'},
            service_env={'PATH': os.defpath, 'SERVICE_SECRET': 'service-only'},
            service_seconds=.12 if behavior == 'force' else 1,
            owner_seconds=.12 if behavior == 'startup-force' else 1, startup_seconds=2,
            deadline=lambda: time.monotonic() + 1))
        deadline = time.monotonic() + 3
        while not ((root / 'events').exists() if behavior in ('startup-force', 'stale', 'invalid') else (root / 'descendant').exists()):
            assert time.monotonic() < deadline, 'service did not start'
            await asyncio.sleep(.02)
        await asyncio.sleep(.12)
        stopped.set()
        result = await asyncio.wait_for(task, 2)
        events = (root / 'events').read_text().splitlines()
        if behavior in ('stale', 'invalid'):
            assert result == 0, result
            assert 'service:started' not in events, 'stale or invalid descriptor admitted a service'
            print(json.dumps({'behavior': behavior, 'result': result, 'events': events, 'descendantAlive': False}))
            return
        if behavior == 'startup-force':
            assert result == 1, 'forced startup owner falsely reported complete'
            assert 'service:started' not in events, events
            print(json.dumps({'behavior': behavior, 'result': result, 'events': events, 'descendantAlive': False}))
            return
        assert events.index('service:term') < events.index('owner:term'), events
        if behavior == 'graceful':
            assert result == 0, result
            assert events.index('service:checkpoint') < events.index('owner:term'), events
        else:
            assert result == 1, 'forced termination falsely reported complete'
        child = int((root / 'descendant').read_text())
        assert pair.process_identity(child) is None, f'parser descendant survived: {child}'
        assert (root / 'descriptor').exists(), 'retained recovery record erased'
        print(json.dumps({'behavior': behavior, 'result': result, 'events': events, 'descendantAlive': False}))


if __name__ == '__main__':
    asyncio.run(check(*sys.argv[1:]))
