"""Offline qualification against the image's actual installed processor and engine."""
import asyncio
import fcntl
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

spec = importlib.util.spec_from_file_location('native_owner', '/source/runtime/native-processing.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


async def main():
    clean = native.processor_environment('abc123')
    assert clean['GEOCLUSTER_NATIVE_PROCESSING_TOKEN'] == 'abc123'
    assert not any(key in clean for key in ('OPENAI_API_KEY', 'IDE_LLM_TOKEN', 'OPENCODE_CONFIG', 'GEOCLUSTER_TOKEN'))
    root = Path(tempfile.mkdtemp(prefix='native-owner-', dir='/tmp'))
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'}
    for key, name in [('HOME', 'home'), ('XDG_CONFIG_HOME', 'config'), ('XDG_DATA_HOME', 'accounts'), ('XDG_CACHE_HOME', 'cache'), ('XDG_STATE_HOME', 'state'), ('XDG_RUNTIME_DIR', 'run'), ('TMPDIR', 'tmp')]:
        directory = root / name
        directory.mkdir(mode=0o700)
        env[key] = str(directory)
    config = root / 'config/opencode'
    config.mkdir()
    (config / 'AGENTS.md').write_text('MUST_NOT_LEAK_INTO_EXTRACTION')
    (config / 'opencode.json').write_text(json.dumps({'providers': {'offline': {
        'name': 'Offline', 'package': '@opencode/ai/providers/openai-compatible',
        'settings': {'baseURL': 'http://127.0.0.1:1/v1', 'apiKey': 'synthetic'},
        'models': {'vision': {'name': 'Vision', 'capabilities': {'tools': False, 'input': ['text', 'image'], 'output': ['text']}, 'limit': {'context': 131072, 'output': 512}}}}}}))
    models = root / 'models.json'
    models.write_text('{}')
    env.update(OPENCODE_MODELS_PATH=str(models), OPENCODE_DISABLE_MODELS_FETCH='1')
    workspace = root / 'workspace'
    workspace.mkdir()
    state = root / 'processing'
    state.mkdir(mode=0o700)
    extraction, plugin = native.extraction_context(state, 'offline/vision')
    server = native.NativeServer(state / 'server', '/usr/local/bin/opencode', env, workspace, extraction, plugin)
    descriptor = await server.start(recovery={'managed': False, 'extractionExcluded': True, 'fencedGenerations': [], 'deadEngineInstances': []})
    try:
        assert descriptor['contextVerified'] is True
        from preprocessing.engine import OpenCodeServerEngine
        probe = OpenCodeServerEngine(descriptor, input_roots=[])
        assert (await probe.ready())['ready'] is True
        await probe.close()
        # Global edits cannot contribute an agent or an instruction hook.
        global_config = json.loads((config / 'opencode.json').read_text())
        global_config['agents'] = {'preprocessing': {'system': 'BAD_GLOBAL_AGENT', 'steps': 9}}
        global_config['plugins'] = ['opencode.config.agent', 'opencode.config.instructions']
        (config / 'opencode.json').write_text(json.dumps(global_config))
        await asyncio.sleep(.8)
        await server.verify_context(descriptor)
    finally:
        await server.close()
    assert server.process is None
    # The installed cleanup adapter preserves external recovery claims verbatim.
    borrowed = {**descriptor, 'recovery': {'managed': True, 'extractionExcluded': False, 'deadEngineInstances': ['external-dead'], 'fencedGenerations': ['external-fence'], 'cleanupReceipts': []}}
    owner = native.NativeOwner(state / 'owner', state / 'data/.preprocessing/engine-lease.json', external=borrowed)
    owner.state['deadEngineInstances'].append('must-not-export-local-death')
    owner.state['fencedGenerations'] = ['local-fence']
    recovery = owner.recovery()
    assert recovery['managed'] is True and recovery['extractionExcluded'] is False
    assert recovery['deadEngineInstances'] == ['external-dead']
    assert set(recovery['fencedGenerations']) == {'external-fence', 'local-fence'}
    # A borrowed owner's confirmed predecessor death settles a fenced operation
    # whose known session is absent. Local PID evidence must not substitute for it.
    pending = {'id': 'op_external_predecessor', 'jobId': 'job_external', 'generation': 'local-fence',
        'engineInstanceId': 'external-dead', 'sessionId': 'ses_external_predecessor',
        'inputId': 'msg_external_predecessor', 'requestHash': 'a' * 64, 'agent': 'preprocessing',
        'model': {'providerID': 'offline', 'id': 'vision'}, 'location': {'directory': descriptor['directory']}}
    owner.state['pendingGenerations']['local-fence'] = {'directory': descriptor['directory'], 'entries': [pending]}
    async def absent_session(method, path, body=None):
        assert method == 'GET' and path == '/api/session/ses_external_predecessor'
        return 404, None
    owner.request = absent_session
    pending['engineInstanceId'] = 'external-live'
    assert not await owner.reconcile(), 'An absent session on an unconfirmed external engine is not settlement'
    pending['engineInstanceId'] = 'external-dead'
    assert await owner.reconcile(), 'Borrowed engine-death evidence must settle its absent predecessor session'
    # Exercise the public FD3/stdin contract using the actual serve CLI, not a stub.
    def launch(external=None, model='offline/vision'):
        read_fd, write_fd = os.pipe()
        invocation = str(uuid.uuid4())
        wrapper = 'import os,sys;os.dup2(int(sys.argv[1]),3);os.execv(sys.executable,[sys.executable,"-I","-u",*sys.argv[2:]])'
        process = subprocess.Popen([sys.executable, '-I', '-c', wrapper, str(read_fd),
            '/source/runtime/native-processing.py', '--state-dir', str(state / 'cli'), '--workspace', str(workspace),
            '--model', model, '--drain-timeout-ms', '10000', '--invocation-id', invocation], pass_fds=(read_fd,),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        os.close(read_fd)
        handoff = {'engineEnv': env}
        if external is not None:
            handoff['engineDescriptor'] = external
        os.write(write_fd, json.dumps(handoff).encode())
        os.close(write_fd)
        process.invocation_id = invocation
        return process
    async def read_ready(process):
        while True:
            raw = await asyncio.to_thread(process.stdout.readline)
            if not raw or 'readiness' not in json.loads(raw):
                return raw
    process = launch()
    raw = await asyncio.wait_for(read_ready(process), 30)
    assert raw, (await asyncio.to_thread(process.communicate))[1].decode()
    ready = json.loads(raw)
    assert set(ready) == {'url', 'password', 'engineInstanceId', 'processorToken'}
    assert len(ready['processorToken']) == 64
    runtime_descriptor = json.loads((state / 'cli/engine.json').read_text())
    _, engine_info = await asyncio.to_thread(native.http_request, runtime_descriptor, 'GET', '/api/info')
    engine_environment = Path(f'/proc/{engine_info["pid"]}/environ').read_bytes().split(b'\0')
    assert not any(value.startswith(native.TOKEN_ENV.encode() + b'=') for value in engine_environment)
    from preprocessing.dev import http_request
    ordinary_id = 'ses_ordinary_retained_native_owner'
    status, _ = await asyncio.to_thread(http_request, runtime_descriptor, 'POST', '/api/session',
        {'id': ordinary_id, 'location': {'directory': str(workspace)}})
    assert status == 200
    process.stdin.write((json.dumps({'deadlineMs': time.time() * 1000 + 10000}) + '\n').encode())
    process.stdin.close()
    assert await asyncio.wait_for(asyncio.to_thread(process.wait), 15) == 0, (process.returncode, process.stderr.read().decode(), (state / 'cli/drain.json').read_text())
    assert process.stdout.read() == b''
    assert json.loads((state / 'cli/drain.json').read_text())['complete'] is True
    assert not (state / 'cli/engine.json').exists()
    previous = ready['engineInstanceId']
    # Replacement on the retained state requires actual prior guardian-lock release.
    process = launch()
    raw = await asyncio.wait_for(read_ready(process), 30)
    assert raw, (await asyncio.to_thread(process.communicate))[1].decode()
    runtime_descriptor = json.loads((state / 'cli/engine.json').read_text())
    assert previous in runtime_descriptor['recovery']['deadEngineInstances']
    status, ordinary = await asyncio.to_thread(http_request, runtime_descriptor, 'GET', '/api/session/' + ordinary_id)
    assert status == 200 and ordinary['data']['id'] == ordinary_id
    status, transcript = await asyncio.to_thread(http_request, runtime_descriptor, 'GET', '/api/session/' + ordinary_id + '/message?limit=10&order=asc')
    assert status == 200 and transcript['data'] == []
    process.stdin.close()
    assert await asyncio.wait_for(asyncio.to_thread(process.wait), 15) == 0, process.stderr.read().decode()
    # Abrupt coordinator loss must fence both actual descendant trees. Jitter
    # spans different heartbeat positions; replacement cannot rely on owner PID.
    for jitter in (.017, .131):
        process = launch()
        raw = await asyncio.wait_for(read_ready(process), 30)
        assert raw, (await asyncio.to_thread(process.communicate))[1].decode()
        killed_identity = json.loads(raw)['engineInstanceId']
        await asyncio.sleep(jitter)
        process.kill()
        await asyncio.to_thread(process.wait)
        async with asyncio.timeout(8):
            for name in ('service/service.lock', 'server/server.lock'):
                with (state / 'cli' / name).open('rb') as lock:
                    while True:
                        try:
                            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            break
                        except BlockingIOError:
                            await asyncio.sleep(.02)
        process = launch()
        raw = await asyncio.wait_for(read_ready(process), 30)
        assert raw, (await asyncio.to_thread(process.communicate))[1].decode()
        assert killed_identity in json.loads((state / 'cli/engine.json').read_text())['recovery']['deadEngineInstances']
        process.stdin.close()
        assert await asyncio.wait_for(asyncio.to_thread(process.wait), 15) == 0, process.stderr.read().decode()
    # Borrowed attachment validates the installed agent/context, exposes only a
    # fresh private processor token, and never closes the external server on service death.
    external_server = native.NativeServer(state / 'external-server', '/usr/local/bin/opencode', env, workspace, extraction, plugin)
    external = await external_server.start(recovery={'managed': False, 'extractionExcluded': True, 'fencedGenerations': [], 'deadEngineInstances': []})
    try:
        process = launch(external)
        raw = await asyncio.wait_for(read_ready(process), 30)
        assert raw, (await asyncio.to_thread(process.communicate))[1].decode()
        borrowed_ready = json.loads(raw)
        assert set(borrowed_ready) == {'borrowed', 'processorToken'} and borrowed_ready['borrowed'] is True
        assert len(borrowed_ready['processorToken']) == 64 and borrowed_ready['processorToken'] != external['password']
        # Kill the real service's leader rather than its guardian/coordinator.
        guardians = Path(f'/proc/{process.pid}/task/{process.pid}/children').read_text().split()
        service_guardian = next(pid for pid in guardians if b'preprocessing.cli' in Path(f'/proc/{pid}/cmdline').read_bytes())
        child = int(Path(f'/proc/{service_guardian}/task/{service_guardian}/children').read_text().split()[0])
        os.kill(child, signal.SIGKILL)
        assert await asyncio.wait_for(asyncio.to_thread(process.wait), 15) != 0
        assert external_server.process.returncode is None
        assert (await asyncio.to_thread(http_request, external, 'GET', '/api/info'))[0] == 200
        assert json.loads(process.stdout.read())['failure']['code'] == 'dependency_exited'
        assert external['password'].encode() not in process.stderr.read()
        # A passive unavailable-model observation remains the primary cause even
        # when the caller ends startup, with independently verified cleanup.
        process = launch(external, model='offline/missing')
        observation = json.loads(await asyncio.wait_for(asyncio.to_thread(process.stdout.readline), 30))
        assert observation['readiness']['code'] == 'selected_model_unavailable', observation
        process.stdin.close()
        assert await asyncio.wait_for(asyncio.to_thread(process.wait), 15) != 0
        receipt = json.loads((state / 'cli/drain.json').read_text())
        assert receipt['invocationId'] == process.invocation_id and receipt['complete'] is True
        assert receipt['failure']['code'] == 'selected_model_unavailable'
        assert external_server.process.returncode is None
        assert (await asyncio.to_thread(http_request, external, 'GET', '/api/info'))[0] == 200
    finally:
        await external_server.close()
    process = launch()
    process.stdin.close()
    assert await asyncio.wait_for(asyncio.to_thread(process.wait), 10) != 0
    assert json.loads(process.stdout.read())['failure']['code'] == 'startup_interrupted'
    assert not (state / 'cli/engine.json').exists()
    assert json.loads((state / 'cli/drain.json').read_text())['complete'] is True
    print('native owner checks passed', flush=True)


asyncio.run(main())
