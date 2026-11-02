"""Offline startup regressions; effect adapters replace the installed processor only."""
import asyncio
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import types
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch


def atomic_json(path, value):
    Path(path).write_text(json.dumps(value))


for name, attributes in {
    'preprocessing': {},
    'preprocessing.dev': {'PrivateServer': object, 'atomic_json': atomic_json, 'http_request': None, '_NoRedirect': object},
    'preprocessing.engine': {'SYSTEM': 'test', 'OpenCodeServerEngine': object},
    'preprocessing.engine_owner': {'StandaloneEngineOwner': object},
    'preprocessing.engine_version': {'cli_version': None, 'compatibility': None},
}.items():
    sys.modules[name] = types.SimpleNamespace(**attributes)
spec = importlib.util.spec_from_file_location('native', Path(__file__).resolve().parents[2] / 'native-processing.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class Lease:
    def __init__(self, budget):
        self.stopped = asyncio.Event()

    def stop(self):
        self.stopped.set()

    def remaining(self):
        return 1

    async def startup(self, work):
        return await asyncio.wait_for(work, .25)


class Service:
    def __init__(self, *args):
        self.process = self.lease_fd = None

    def acquire(self, name):
        pass

    async def start_service(self, *args):
        self.process = types.SimpleNamespace(returncode=None, wait=self.wait)

    async def wait(self):
        return self.process.returncode

    def terminate_leader(self):
        self.process.returncode = 0

    async def close(self):
        self.process = None


class Server:
    def __init__(self, *args):
        self.confirmed_dead = []
        self.lease_fd = None
        self.process = types.SimpleNamespace(returncode=None)

    async def start(self, **kwargs):
        return {'serverUrl': 'http://127.0.0.1:1', 'password': 'opaque-credential', 'engineInstanceId': 'engine'}

    async def close(self):
        pass


class Owner:
    def __init__(self, *args, **kwargs):
        self.state = {'fencedGenerations': [], 'pendingGenerations': [], 'deadEngineInstances': []}

    def recovery(self):
        return {}

    def save(self):
        pass

    async def reconcile(self, **kwargs):
        return True


class Startup(unittest.IsolatedAsyncioTestCase):
    async def execute(self, observations, *, borrowed=False, cleanup_failure=False, probe_observations=None, runtime_failure=False, engine_env=None):
        self.calls = []
        self.engine_envs = []
        with tempfile.TemporaryDirectory(prefix='native-startup-') as directory:
            state = Path(directory)
            state.chmod(0o700)
            invocation = str(uuid.uuid4())
            args = types.SimpleNamespace(state_dir=state, workspace=state, model='offline/vision',
                                         engine_bin='/unused', drain_timeout_ms=1000, invocation_id=invocation)
            launch = {'engineEnv': engine_env or {}, 'invocationId': invocation}
            if borrowed:
                launch['engineDescriptor'] = {'password': 'borrowed-secret'}
            lease = Lease(1000)
            calls = self.calls
            engine_envs = self.engine_envs

            class TestService(Service):
                async def close(self):
                    calls.append('processor-close')
                    await super().close()
                    if cleanup_failure:
                        raise ValueError('processor-secret')

            class TestServer(Server):
                def __init__(self, *args):
                    engine_envs.append(args[2])
                    super().__init__(*args)

                async def close(self):
                    calls.append('engine-close')
                    if cleanup_failure:
                        raise ValueError('engine-secret')

            class TestOwner(Owner):
                async def reconcile(self, **kwargs):
                    if not kwargs.get('force'):
                        if runtime_failure:
                            raise TimeoutError('runtime-secret')
                        lease.stop()
                    return True

            class Probe:
                def __init__(self, *args, **kwargs):
                    self.descriptor = {'serverUrl': 'http://127.0.0.1:1', 'password': 'borrowed-secret'}

                async def ready(self):
                    calls.append('probe-get')
                    return probe_observations.pop(0) if probe_observations and len(probe_observations) > 1 else {'ready': True}

                async def close(self):
                    calls.append('probe-close')

            async def handoff():
                return launch

            def observe(token):
                calls.append('capabilities-get')
                value = observations.pop(0) if len(observations) > 1 else observations[0]
                if isinstance(value, Exception):
                    raise value
                return value

            output, errors = io.StringIO(), io.StringIO()
            with contextlib.ExitStack() as stack:
                for name, value in {'ParentLease': lambda _: lease, 'GuardedService': TestService, 'NativeServer': TestServer,
                                    'NativeOwner': TestOwner, 'OpenCodeServerEngine': Probe, 'launch_handoff': handoff,
                                    'capabilities': observe, 'extraction_context': lambda *args: (state, state)}.items():
                    stack.enter_context(patch.object(native, name, value))
                stack.enter_context(contextlib.redirect_stdout(output))
                stack.enter_context(contextlib.redirect_stderr(errors))
                code = await native.run(args)
            receipt = json.loads((state / 'drain.json').read_text())
            self.assertNotIn('secret', output.getvalue() + errors.getvalue() + json.dumps(receipt))
            self.assertEqual(receipt['invocationId'], invocation)
            return code, receipt, [json.loads(line) for line in output.getvalue().splitlines()]

    async def test_selected_model_failure_is_primary_even_with_clean_cleanup(self):
        code, receipt, output = await self.execute([{'ready': False, 'reason': 'selected_model_unavailable', 'password': 'provider-secret'}])
        self.assertEqual(code, 1)
        self.assertTrue(receipt['complete'])
        self.assertEqual(receipt['failure'], {'code': 'selected_model_unavailable', 'stage': 'processor', 'model': 'offline/vision',
                                              'reason': 'selected_model_unavailable', 'action': 'check_model_and_connection'})
        self.assertEqual(output[-1]['failure'], receipt['failure'])
        self.assertEqual(self.calls[-2:], ['processor-close', 'engine-close'])

    async def test_cleanup_attempts_are_independent_and_secondary(self):
        code, receipt, _ = await self.execute([{'ready': False, 'reason': 'selected_model_unavailable'}], cleanup_failure=True)
        self.assertEqual(code, 1)
        self.assertFalse(receipt['complete'])
        self.assertEqual(receipt['failure']['code'], 'selected_model_unavailable')
        self.assertEqual([entry['component'] for entry in receipt['cleanup']['failures']], ['processor', 'engine'])
        self.assertEqual(self.calls[-2:], ['processor-close', 'engine-close'])

    async def test_transient_catalog_can_recover_without_inference_or_fallback(self):
        code, receipt, output = await self.execute([{'ready': False, 'reason': 'selected_model_unavailable'}, OSError('transport-secret'), {'ready': True}])
        self.assertEqual(code, 0)
        self.assertTrue(receipt['complete'])
        self.assertIsNone(receipt['failure'])
        self.assertTrue(any('url' in message for message in output))
        self.assertEqual(self.calls.count('capabilities-get'), 3)

    async def test_last_meaningful_observation_survives_transport_failure(self):
        code, receipt, _ = await self.execute([{'ready': False, 'reason': 'selected_model_unavailable'}, OSError('transport-secret')])
        self.assertEqual(code, 1)
        self.assertEqual(receipt['failure']['code'], 'selected_model_unavailable')

    async def test_recovered_readiness_cannot_mask_a_later_runtime_failure(self):
        code, receipt, _ = await self.execute([{'ready': False, 'reason': 'selected_model_unavailable'}, {'ready': True}], runtime_failure=True)
        self.assertEqual(code, 1)
        self.assertEqual(receipt['failure']['stage'], 'running')
        self.assertNotEqual(receipt['failure']['code'], 'selected_model_unavailable')

    async def test_unknown_readiness_text_is_not_forwarded(self):
        code, receipt, _ = await self.execute([{'ready': False, 'reason': 'Authorization: provider-secret'}])
        self.assertEqual(code, 1)
        self.assertEqual(receipt['failure']['reason'], 'readiness_unavailable')

    async def test_borrowed_context_retries_and_never_closes_engine(self):
        code, receipt, output = await self.execute([{'ready': True}], borrowed=True,
                                                  probe_observations=[{'ready': False, 'reason': 'catalog-secret'}, {'ready': True}])
        self.assertEqual(code, 0)
        self.assertTrue(receipt['complete'])
        self.assertEqual(self.calls.count('probe-get'), 2)
        self.assertIn('probe-close', self.calls)
        self.assertNotIn('engine-close', self.calls)
        self.assertTrue(any(message.get('borrowed') is True for message in output))

    async def test_processor_token_is_private_for_owned_and_borrowed_handoffs(self):
        for borrowed in (False, True):
            code, receipt, output = await self.execute([{'ready': True}], borrowed=borrowed,
                                                      engine_env={native.TOKEN_ENV: 'stale-engine-value'})
            self.assertEqual(code, 0)
            ready = next(message for message in output if 'url' in message or message.get('borrowed'))
            self.assertRegex(ready['processorToken'], r'^[a-f0-9]{64}$')
            self.assertNotIn('mcpToken', ready)
            for env in self.engine_envs:
                self.assertNotIn(native.TOKEN_ENV, env)


unittest.main()
