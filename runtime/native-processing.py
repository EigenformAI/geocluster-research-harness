"""Native, non-restarting processor owner. FD3 is finite config; stdin is the parent lease."""
import argparse
import asyncio
import contextlib
import copy
import fcntl
import hashlib
import json
import math
import os
import re
import secrets
import signal
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, ProxyHandler

from preprocessing.dev import PrivateServer, atomic_json, http_request, _NoRedirect
from preprocessing.engine import SYSTEM, OpenCodeServerEngine
from preprocessing.engine_owner import StandaloneEngineOwner
from preprocessing.engine_version import cli_version, compatibility

TOKEN_ENV = 'GEOCLUSTER_NATIVE_PROCESSING_TOKEN'
PLUGIN_ID = 'geocluster.native.extraction'
MCP_URL = 'http://127.0.0.1:8765/mcp'
MAX_HANDOFF = 4 * 1024 * 1024
BUILTINS = json.loads(Path(__file__).with_name('native-extraction-plugins.json').read_text())
DENY = [{'action': '*', 'resource': '*', 'effect': 'deny'}]
FAILURE_ACTIONS = {
    'startup_failed': 'inspect_retained_state', 'startup_timeout': 'inspect_retained_state',
    'startup_interrupted': 'restart_explicitly', 'selected_model_unavailable': 'check_model_and_connection',
    'engine_context_unavailable': 'check_engine_context', 'processor_exited': 'inspect_retained_state',
    'dependency_exited': 'restart_explicitly',
}


class DrainRequested(Exception):
    pass


class NativeFailure(Exception):
    def __init__(self, code):
        self.code = code


def emit(value):
    with contextlib.suppress(OSError):
        print(json.dumps(value, separators=(',', ':')), flush=True)


def startup_failure(code, stage, model, reason=None):
    code = code if code in FAILURE_ACTIONS else 'startup_failed'
    allowed_reasons = {*FAILURE_ACTIONS, 'readiness_unavailable'} - {'startup_failed'}
    return {'code': code, 'stage': stage if stage in ('launch', 'extraction-context', 'reconciliation', 'processor', 'running') else 'launch',
            'model': model if len(model) <= 256 and re.fullmatch(r'[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+(?:#[A-Za-z0-9._-]+)?', model) else 'redacted',
            'reason': reason if reason in allowed_reasons else code if code in allowed_reasons else 'readiness_unavailable',
            'action': FAILURE_ACTIONS[code]}


async def wait_readiness(observe, on_failure, process=None):
    # Catalog initialization is asynchronous. These observations never invoke a model.
    while process is None or process.returncode is None:
        try:
            value = await observe()
            if not isinstance(value, dict):
                raise ValueError('Invalid readiness')
            if value.get('ready') is True:
                return
            reason = value.get('reason')
            code = ('selected_model_unavailable' if reason == 'selected_model_unavailable' else
                    'engine_context_unavailable' if value.get('executionReady') is False else 'startup_failed')
            on_failure(code, reason if reason == 'selected_model_unavailable' else
                       'engine_context_unavailable' if code == 'engine_context_unavailable' else 'readiness_unavailable')
        except (OSError, ValueError, TimeoutError):
            pass  # A transport miss cannot erase the last meaningful observation.
        await asyncio.sleep(.1)
    raise NativeFailure('processor_exited')


def private_directory(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise ValueError('Private state must have mode 0700')
    return path


def processor_environment(token):
    # No inherited credentials, provider routing, native config, or backend controls.
    return {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/nonexistent', 'LANG': 'C.UTF-8',
            'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUNBUFFERED': '1', TOKEN_ENV: token}


def extraction_context(state, model):
    directory = private_directory(state / 'extraction')
    overlay = private_directory(directory / '.opencode')
    plugin = private_directory(directory / 'native-extraction-plugin')
    atomic_json(plugin / 'package.json', {'type': 'module', 'main': 'index.js'})
    source = ('const SYSTEM=' + json.dumps(SYSTEM) + ';\nexport default {id:' + json.dumps(PLUGIN_ID)
              + ',setup:async ctx=>{await ctx.agent.transform(editor=>{for(const a of editor.list())editor.remove(a.id);'
              + 'editor.update("preprocessing",a=>{a.mode="primary";a.hidden=true;a.system=SYSTEM;a.steps=1;a.permissions='
              + json.dumps(DENY) + ';});editor.default("preprocessing");});}};\n')
    fd = os.open(plugin / 'index.js', os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(source)
    atomic_json(overlay / 'opencode.json', {'model': model, 'plugins': ['-*', *BUILTINS, str(plugin)],
                'warming': False, 'snapshots': False, 'compaction': {'auto': False}})
    return directory, plugin


class NativeOwner(StandaloneEngineOwner):
    """Use installed reconciliation; borrowed recovery never acquires local death claims."""
    def __init__(self, *args, external=None, **kwargs):
        self.external = copy.deepcopy(external)
        super().__init__(*args, **kwargs)
        if self.external is not None:
            # Installed cleanup reads owner state, not the exported recovery map.
            # These identities come from the external owner, never local PIDs.
            for identity in self.external['recovery']['deadEngineInstances']:
                if identity not in self.state['deadEngineInstances']:
                    self.state['deadEngineInstances'].append(identity)

    def recovery(self):
        local = super().recovery()
        if self.external is None:
            return local
        recovery = copy.deepcopy(self.external['recovery'])
        recovery['fencedGenerations'] = list(dict.fromkeys([*recovery['fencedGenerations'], *local['fencedGenerations']]))
        receipts = recovery.get('cleanupReceipts', [])
        for receipt in local['cleanupReceipts']:
            if receipt not in receipts:
                receipts.append(receipt)
        recovery['cleanupReceipts'] = receipts
        return recovery


class GuardedService(PrivateServer):
    def __init__(self, root, executable):
        super().__init__(private_directory(root), executable, {}, [])

    def acquire(self, name):
        self.lock_fd = os.open(self.root / name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            os.close(self.lock_fd)
            self.lock_fd = None
            raise

    async def start_service(self, command, env, cwd):
        self.process, self.lease_fd = await self._spawn(command, env, cwd,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)

    def terminate_leader(self):
        # Guardian's direct child is the service. Do not signal the server guardian.
        if self.process is not None and self.process.returncode is None:
            children = Path(f'/proc/{self.process.pid}/task/{self.process.pid}/children')
            with contextlib.suppress(FileNotFoundError, ProcessLookupError):
                for value in children.read_text().split():
                    fd = os.pidfd_open(int(value))
                    try:
                        signal.pidfd_send_signal(fd, signal.SIGTERM)
                    finally:
                        os.close(fd)


class NativeServer(GuardedService):
    def __init__(self, root, executable, env, workspace, extraction, plugin):
        super().__init__(root, executable)
        self.env, self.workspace, self.extraction, self.plugin = dict(env), workspace, extraction, plugin
        self.plugin_digest = hashlib.sha256((plugin / 'index.js').read_bytes()).digest()
        self.output_task = None
        self.confirmed_dead = []

    async def start(self, recovery=None):
        self.acquire('server.lock')
        # Only lock acquisition, not PID disappearance, establishes prior descendants' death.
        identity_path = self.root / 'identity.json'
        previous = json.loads(identity_path.read_text()) if identity_path.exists() else {}
        self.confirmed_dead = list(dict.fromkeys([*previous.get('deadEngineInstances', []),
                                                *([previous['engineInstanceId']] if previous.get('engineInstanceId') else [])]))
        recovery = copy.deepcopy(recovery)
        recovery['deadEngineInstances'] = list(dict.fromkeys([*recovery['deadEngineInstances'], *self.confirmed_dead]))
        version, lease = await self._spawn([self.executable, '--version'], self.env, self.workspace,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            async with asyncio.timeout(10):
                output = await version.stdout.read(1025)
                await version.wait()
                if version.returncode or len(output) > 1024:
                    raise ValueError('Pinned engine version unavailable')
                actual_version = cli_version(output)
                if actual_version is None:
                    raise ValueError('Pinned engine version unavailable')
        finally:
            os.close(lease)
            await version.wait()
        password = secrets.token_hex(32)
        self.env['OPENCODE_PASSWORD'] = password
        self.process, self.lease_fd = await self._spawn(
            [self.executable, 'serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], self.env, self.workspace,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        async with asyncio.timeout(30):
            raw = await self.process.stdout.readline()
            if len(raw) > 4096:
                raise ValueError('Invalid engine readiness')
            ready = json.loads(raw)
            url = urlsplit(ready['url'])
            if url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.path not in ('', '/') or url.username or url.password or url.query or url.fragment:
                raise ValueError('Invalid engine readiness')
            async def consume():
                while await self.process.stdout.read(65536):
                    pass
            self.output_task = asyncio.create_task(consume())
            descriptor = {'serverUrl': ready['url'], 'username': 'opencode', 'password': password,
                'version': actual_version, 'engineInstanceId': uuid.uuid4().hex, 'mode': 'standalone',
                'owner': str(self.root), 'directory': str(self.extraction), 'contextVerified': True, 'recovery': recovery}
            status, info = await asyncio.to_thread(http_request, descriptor, 'GET', '/api/info')
            children = Path(f'/proc/{self.process.pid}/task/{self.process.pid}/children').read_text().split()
            if status != 200 or not isinstance(info, dict) or str(info.get('pid')) not in children:
                raise ValueError('Engine readiness identity mismatch')
            descriptor['compatibility'] = compatibility(cli=actual_version, http=info.get('version'), descriptor=actual_version)
            if info.get('version') != actual_version:
                raise ValueError('Engine readiness version mismatch')
            # Record ownership before context probes, so a crash cannot lose engine identity.
            atomic_json(identity_path, {'engineInstanceId': descriptor['engineInstanceId'],
                                      'deadEngineInstances': recovery['deadEngineInstances']})
            await self.verify_context(descriptor)
            self.descriptor = descriptor
            return descriptor

    async def verify_context(self, descriptor):
        query = '?' + urlencode({'location[directory]': str(self.extraction)})
        expected = {'id': 'preprocessing', 'name': 'preprocessing', 'mode': 'primary', 'hidden': True,
            'system': SYSTEM, 'steps': 1, 'permissions': DENY, 'request': {'settings': {}, 'headers': {}, 'body': {}}}
        end = time.monotonic() + 15
        while True:
            status, agents = await asyncio.to_thread(http_request, descriptor, 'GET', '/api/agent' + query)
            if status == 200 and agents.get('data') == [expected]:
                break
            if time.monotonic() >= end:
                raise ValueError('Exact extraction agent unavailable')
            await asyncio.sleep(.05)
        status, plugins = await asyncio.to_thread(http_request, descriptor, 'GET', '/api/plugin' + query)
        values = plugins.get('data', []) if isinstance(plugins, dict) else []
        if status != 200 or len(values) != len(BUILTINS) + 1 or {p['id'] for p in values} != {*BUILTINS, PLUGIN_ID}:
            raise ValueError('Extraction contributors differ from pinned set')
        for plugin in values:
            source = plugin.get('source', {})
            if plugin.get('state') != {'status': 'active'}:
                raise ValueError('Inactive extraction plugin')
            if plugin['id'] in BUILTINS:
                if source != {'type': 'builtin'}:
                    raise ValueError('Extraction builtin source mismatch')
            elif not ((source.get('type') == 'local' and source.get('path') == str(self.plugin / 'index.js'))
                      or (source.get('type') == 'package' and source.get('target') == str(self.plugin))):
                raise ValueError('Extraction plugin source mismatch')
        if hashlib.sha256((self.plugin / 'index.js').read_bytes()).digest() != self.plugin_digest:
            raise ValueError('Extraction plugin changed')

    async def close(self):
        await super().close()
        if self.output_task:
            await self.output_task
            self.output_task = None


class ParentLease:
    def __init__(self, budget_ms):
        self.stopped = asyncio.Event()
        self.budget = budget_ms / 1000
        self.deadline = float('inf')
        self.raw = bytearray()
        self.loop = asyncio.get_running_loop()
        self.loop.add_reader(0, self.read)
        for sig in (signal.SIGTERM, signal.SIGINT):
            self.loop.add_signal_handler(sig, self.stop)

    def stop(self):
        self.deadline = min(self.deadline, time.monotonic() + self.budget)
        self.stopped.set()

    def read(self):
        chunk = os.read(0, 4096)
        self.raw.extend(chunk)
        if len(self.raw) > 4096:
            self.deadline = time.monotonic()
            self.stop()
        elif b'\n' in self.raw or not chunk:
            self.loop.remove_reader(0)
            if self.raw:
                try:
                    value = json.loads(self.raw)['deadlineMs']
                    if type(value) not in (int, float) or not math.isfinite(value):
                        raise ValueError()
                    self.deadline = min(self.deadline, time.monotonic() + max(0, value / 1000 - time.time()))
                except (ValueError, KeyError, TypeError):
                    self.deadline = time.monotonic()
            self.stop()

    def remaining(self):
        return max(0, self.deadline - time.monotonic())

    async def startup(self, awaitable):
        work = asyncio.create_task(awaitable)
        stop = asyncio.create_task(self.stopped.wait())
        try:
            done, _ = await asyncio.wait([work, stop], timeout=60, return_when=asyncio.FIRST_COMPLETED)
            if work not in done or self.stopped.is_set():
                work.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await work
                if self.stopped.is_set():
                    raise DrainRequested()
                raise TimeoutError('Startup timed out')
            return await work
        finally:
            stop.cancel()


async def launch_handoff():
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    raw = bytearray()
    def read():
        try:
            value = os.read(3, 65536)
            raw.extend(value)
            if len(raw) > MAX_HANDOFF:
                raise ValueError('Launch descriptor too large')
            if not value:
                future.set_result(json.loads(raw))
                loop.remove_reader(3)
        except Exception as error:
            loop.remove_reader(3)
            future.set_exception(error)
    loop.add_reader(3, read)
    try:
        result = await future
        env = result['engineEnv']
        if not isinstance(env, dict) or any(not isinstance(k, str) or not isinstance(v, str) or '\0' in k + v or '=' in k for k, v in env.items()):
            raise ValueError('Invalid engine environment')
        return result
    finally:
        loop.remove_reader(3)
        os.close(3)


def capabilities(token):
    request = Request('http://127.0.0.1:8765/preprocessing/capabilities', headers={'Authorization': 'Bearer ' + token})
    with build_opener(ProxyHandler({}), _NoRedirect()).open(request, timeout=1) as response:
        raw = response.read(MAX_HANDOFF + 1)
        if len(raw) > MAX_HANDOFF:
            raise ValueError('Oversized capabilities')
        value = json.loads(raw)
        dependency = value.get('dependency') if isinstance(value, dict) else None
        if not isinstance(dependency, dict):
            raise ValueError('Invalid capabilities')
        return dependency


async def run(args):
    os.umask(0o077)
    lease = ParentLease(args.drain_timeout_ms)
    state = private_directory(args.state_dir.resolve())
    descriptor_path = state / 'engine.json'
    service = GuardedService(state / 'service', args.engine_bin)
    owner = server = probe = None
    lock = None
    owns_state = False
    result = 1
    stage = 'launch'
    service_code = None
    failure = readiness = None
    cleanup = {'complete': True, 'failures': []}
    def observe_failure(code, reason):
        nonlocal readiness
        diagnostic = startup_failure(code, stage, args.model, reason)
        if diagnostic != readiness:
            readiness = diagnostic
            emit({'readiness': diagnostic})
    try:
        lock = os.open(state / 'owner.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        owns_state = True
        for stale in (descriptor_path, state / 'drain.json'):
            with contextlib.suppress(FileNotFoundError):
                stale.unlink()
        launch = await lease.startup(launch_handoff())
        external = launch.get('engineDescriptor')
        token = secrets.token_hex(32)
        # Fence predecessor service descendants before reading/reconciling final projection.
        async def acquire_service():
            while True:
                try:
                    service.acquire('service.lock')
                    return
                except BlockingIOError:
                    await asyncio.sleep(.05)
        await lease.startup(acquire_service())
        data = private_directory(state / 'data')
        owner = NativeOwner(private_directory(state / 'owner'), data / '.preprocessing/engine-lease.json', external=external)
        await lease.startup(owner.reconcile(force=True))
        if any(g not in owner.state['fencedGenerations'] for g in owner.state['pendingGenerations']):
            raise ValueError('Prior service writer remains unfenced')
        if external is not None:
            stage = 'extraction-context'
            probe = OpenCodeServerEngine(external, input_roots=[])
            await lease.startup(wait_readiness(probe.ready, observe_failure))
            readiness = None
            descriptor = copy.deepcopy(probe.descriptor)
        else:
            stage = 'extraction-context'
            extraction, plugin = extraction_context(state, args.model)
            env = dict(launch['engineEnv'])
            env.pop(TOKEN_ENV, None)
            server = NativeServer(state / 'server', args.engine_bin, env, args.workspace.resolve(), extraction, plugin)
            descriptor = await lease.startup(server.start(recovery=owner.recovery()))
            for identity in server.confirmed_dead:
                if identity not in owner.state['deadEngineInstances']:
                    owner.state['deadEngineInstances'].append(identity)
            owner.save()
        async def request(method, path, body=None):
            if method != 'GET':
                status, info = await asyncio.to_thread(http_request, descriptor, 'GET', '/api/info')
                if status != 200 or not isinstance(info, dict):
                    raise ValueError('Engine unavailable for scoped cleanup')
                compatibility(cli=descriptor.get('compatibility', {}).get('cliVersion'), http=info.get('version'), descriptor=descriptor['version'])
            return await asyncio.to_thread(http_request, descriptor, method, path, body)
        owner.request = request
        stage = 'reconciliation'
        if not await lease.startup(owner.reconcile(force=True)):
            raise ValueError('Unsettled retained operations block this engine; retain ownership evidence')
        descriptor['recovery'] = owner.recovery()
        owner.descriptor, owner.descriptor_path = descriptor, descriptor_path
        owner.save()
        stage = 'processor'
        command = [sys.executable, '-I', '-u', '-m', 'preprocessing.cli', 'serve', '--data-root', str(data),
            '--workspace', str(args.workspace.resolve()), '--engine-descriptor', str(descriptor_path), '--model', args.model,
            '--host', '127.0.0.1', '--port', '8765', '--token-env', TOKEN_ENV]
        await lease.startup(service.start_service(command, processor_environment(token), args.workspace.resolve()))
        readiness = None
        async def observe():
            return await asyncio.to_thread(capabilities, token)
        await lease.startup(wait_readiness(observe, observe_failure, service.process))
        readiness = None
        handoff = ({'borrowed': True} if external is not None else
                   {'url': descriptor['serverUrl'], 'password': descriptor['password'], 'engineInstanceId': descriptor['engineInstanceId']})
        handoff['processorToken'] = token
        emit(handoff)
        stage = 'running'
        while not lease.stopped.is_set():
            if service.process.returncode is not None or (server is not None and server.process.returncode is not None):
                raise NativeFailure('dependency_exited')
            await lease.startup(owner.reconcile())
            await asyncio.sleep(.1)
        result = 0
    except DrainRequested:
        result = 0 if stage == 'running' else 1
        if result:
            failure = readiness or startup_failure('startup_interrupted', stage, args.model)
    except (Exception, asyncio.CancelledError) as error:
        failure = (readiness if isinstance(error, TimeoutError) and readiness else
                   startup_failure(error.code if isinstance(error, NativeFailure) else
                                   'startup_timeout' if isinstance(error, TimeoutError) else 'startup_failed', stage, args.model))
    finally:
        lease.stop()
        if failure:
            emit({'failure': failure})
        def failed(component):
            cleanup['complete'] = False
            entry = {'component': component, 'code': 'cleanup_unverified'}
            if entry not in cleanup['failures']:
                cleanup['failures'].append(entry)
        async def attempt(component, work):
            try:
                await work()
            except (Exception, asyncio.CancelledError):
                failed(component)
        async def remove_descriptor():
            if owns_state:
                with contextlib.suppress(FileNotFoundError):
                    descriptor_path.unlink()
            if owner:
                owner.descriptor = None
        await attempt('descriptor', remove_descriptor)
        async def close_processor():
            nonlocal service_code
            # TERM closes listener/admission and settles while the engine is still alive.
            try:
                if service.process is not None:
                    service.terminate_leader()
                    try:
                        await asyncio.wait_for(asyncio.shield(service.process.wait()), max(.001, lease.remaining()))
                        service_code = service.process.returncode
                        # Guardian encodes a child's negative signal as 256-signum.
                        if service_code not in (0, -signal.SIGTERM, 256 - signal.SIGTERM):
                            failed('processor')
                    except (Exception, asyncio.CancelledError):
                        failed('processor')
            finally:
                # Even a failed TERM/wait must surrender the descendant lease.
                await asyncio.wait_for(service.close(), max(.001, lease.remaining()))
        await attempt('processor', close_processor)
        try:
            if service.lease_fd is not None:
                os.close(service.lease_fd)
                service.lease_fd = None
        except OSError:
            failed('processor')
        async def reconcile():
            if owner:
                settled = await asyncio.wait_for(owner.reconcile(force=True), max(.001, lease.remaining()))
                if not settled:
                    failed('ownership')
        await attempt('ownership', reconcile)
        async def close_probe():
            if probe is not None:
                await asyncio.wait_for(probe.close(), max(.001, lease.remaining()))
        await attempt('probe', close_probe)
        async def close_engine():
            if server is not None:
                try:
                    await asyncio.wait_for(server.close(), max(.001, lease.remaining()))
                finally:
                    if server.lease_fd is not None:
                        os.close(server.lease_fd)
                        server.lease_fd = None
        await attempt('engine', close_engine)
        try:
            if owns_state:
                atomic_json(state / 'drain.json', {'invocationId': args.invocation_id, 'complete': cleanup['complete'],
                            'stage': stage, 'serviceExitCode': service_code, 'failure': failure, 'cleanup': cleanup})
        except Exception:
            failed('receipt')
        finally:
            if lock is not None:
                os.close(lock)
    return result if cleanup['complete'] else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--drain-timeout-ms', type=int, required=True)
    parser.add_argument('--invocation-id', type=uuid.UUID, required=True)
    parser.add_argument('--engine-bin', type=Path, default=Path('/usr/local/bin/opencode'))
    args = parser.parse_args()
    args.invocation_id = str(args.invocation_id)
    if args.drain_timeout_ms <= 0:
        parser.error('drain timeout must be positive')
    try:
        return asyncio.run(run(args))
    except Exception:
        print('Native processing blocked; inspect private state permissions and installed processor compatibility.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
