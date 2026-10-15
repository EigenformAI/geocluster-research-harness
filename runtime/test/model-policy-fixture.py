"""Network and clock-controlled observations of the root discovery handoff."""
import asyncio
import importlib.util
import json
import os
import stat
import tempfile
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location('policy', Path(__file__).parents[1] / 'preprocessing-model-policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def discovery():
    return {'discovery_schema_version': 2, 'managed_access_enabled': True,
            'allowed_model_ids': ['fixture/image', 'fixture/text'],
            'default_model_id': 'fixture/image',
            'managed_models': {name: {'name': name,
                                     'capabilities': {'tools': True, 'input': modalities, 'output': ['text']},
                                     'limit': {'context': 65536, 'input': 32768, 'output': 8192},
                                     'variants': [{'id': effort, 'settings': {'reasoning': {'effort': effort}}}
                                                  for effort in variants]}
                               for name, modalities, variants in [
                                   ('fixture/image', ['text', 'image'], ['low', 'high']),
                                   ('fixture/text', ['text'], [])]},
            'model_limits': {name: {'default_output_tokens': 4096, 'max_output_tokens': 8192,
                                   'max_input_tokens': 32768} for name in ['fixture/image', 'fixture/text']},
            'model_capabilities': {
                'fixture/image': {'input': ['text', 'image'], 'output': ['text'],
                                  'image_input': {'mime_types': ['image/png', 'image/jpeg'], 'max_images': 4,
                                                  'max_bytes': 8388608, 'max_pixels': 16000000,
                                                  'tokens_per_image': 1024, 'detail': 'high'},
                                  'allowed_reasoning_efforts': ['low', 'high']},
                'fixture/text': {'input': ['text'], 'output': ['text'], 'image_input': None,
                                 'allowed_reasoning_efforts': []}},
            'as_of': '2026-10-14T00:00:00+00:00', 'billing': {'secret': 'upstream-secret'},
            'supplier_route': 'https://secret-route', 'token': 'local-secret'}


async def main():
    mixed = discovery()
    for name, inputs, outputs in [
        ('fixture/audio', ['audio'], ['text']),
        ('fixture/video', ['text', 'video'], ['text']),
        ('fixture/pdf', ['text', 'pdf'], ['text']),
        ('fixture/audio-output', ['text'], ['audio']),
    ]:
        mixed['allowed_model_ids'].append(name)
        mixed['managed_models'][name] = {
            **mixed['managed_models']['fixture/text'],
            'capabilities': {'tools': False, 'input': inputs, 'output': outputs},
        }
        mixed['model_capabilities'][name] = {
            'input': inputs, 'output': outputs, 'image_input': None, 'allowed_reasoning_efforts': [],
        }
    projected = policy.projection(mixed, 1, 'fixture-boot')
    assert projected['allowed_model_ids'] == ['fixture/image', 'fixture/text']
    assert set(projected['model_capabilities']) == {'fixture/image', 'fixture/text'}
    assert projected['model_capabilities']['fixture/image']['image_input']['detail'] == 'high'
    mixed['managed_models']['fixture/audio']['capabilities']['input'] = ['unknown']
    try:
        policy.projection(mixed, 1, 'fixture-boot')
    except ValueError:
        pass
    else:
        raise AssertionError('Malformed non-extraction declaration bypassed shared schema validation')
    missing_image = discovery()
    missing_image['model_capabilities']['fixture/image']['image_input'] = None
    assert policy.projection(missing_image, 1, 'fixture-boot')['model_capabilities']['fixture/image']['image_input'] is None
    requests = []
    mode = ['success']
    async def respond(reader, writer):
        try:
            raw = await reader.readuntil(b'\r\n\r\n')
            requests.append(raw.decode())
            if mode[0] == 'slow':
                await asyncio.sleep(4)
                return
            body = json.dumps(discovery()).encode()
            status = '200 OK'
            extra = ''
            if mode[0] == 'redirect':
                status = '302 Found'
                extra = 'Location: /stolen\r\n'
            elif mode[0] == 'oversize':
                body = b'x' * (policy.MAX_BYTES + 1)
            elif mode[0] == 'invalid':
                body = b'{"discovery_schema_version":1,"managed_access_enabled":"true"}'
            elif mode[0] == 'failure':
                status = '503 Unavailable'
                body = b'upstream-secret'
            elif mode[0] in ('original', 'auto'):
                value = discovery()
                value['model_capabilities']['fixture/image']['image_input']['detail'] = mode[0]
                body = json.dumps(value).encode()
            elif mode[0] == 'large-account':
                value = discovery()
                value['account_notes'] = 'x' * 70000
                body = json.dumps(value).encode()
            elif mode[0] == 'revoked':
                value = discovery()
                value['managed_access_enabled'] = False
                value['allowed_model_ids'] = []
                value['managed_models'] = {}
                value['default_model_id'] = None
                value['model_limits'] = {}
                value['model_capabilities'] = {}
                body = json.dumps(value).encode()
            elif mode[0] in ('legacy', 'unknown', 'bad-default', 'bad-context', 'route-injection'):
                value = discovery()
                if mode[0] == 'legacy': value['discovery_schema_version'] = 1
                if mode[0] == 'unknown': value['discovery_schema_version'] = 3
                if mode[0] == 'bad-default': value['default_model_id'] = 'fixture/absent'
                if mode[0] == 'bad-context': value['managed_models']['fixture/image']['limit']['context'] = 32768
                if mode[0] == 'route-injection': value['managed_models']['fixture/image']['endpoint'] = 'http://untrusted'
                body = json.dumps(value).encode()
            if mode[0] == 'chunked':
                writer.write(b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' + hex(len(body))[2:].encode() + b'\r\n' + body + b'\r\n0\r\n\r\n')
            else:
                writer.write(f'HTTP/1.1 {status}\r\nContent-Length: {len(body)}\r\n{extra}\r\n'.encode() + body)
            await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()
    server = await asyncio.start_server(respond, '127.0.0.1', 0)
    url = f'http://127.0.0.1:{server.sockets[0].getsockname()[1]}/llm'
    try:
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            parent.chmod(0o710)
            if os.getuid() == 0:
                os.chown(parent, 0, 996)
            path = parent / 'model-policy.json'
            clock = [10000]
            adapter = policy.ModelPolicy(url, 'local-secret', path, clock=lambda: clock[0], boot_id='fixture-boot')
            assert await adapter.refresh()
            old = path.read_bytes()
            snapshot = json.loads(old)
            assert snapshot['fetched_at_monotonic_ms'] == 10000 and snapshot['boot_id'] == 'fixture-boot'
            assert snapshot['allowed_model_ids'] == ['fixture/image', 'fixture/text']
            assert set(snapshot) == {'discovery_schema_version', 'managed_access_enabled', 'allowed_model_ids', 'model_limits', 'model_capabilities', 'as_of', 'fetched_at_monotonic_ms', 'boot_id'}
            assert b'secret' not in old and b'route' not in old and b'billing' not in old
            info = path.stat()
            assert stat.S_IMODE(info.st_mode) == 0o640
            if os.getuid() == 0:
                assert (info.st_uid, info.st_gid) == (0, 996)
                child = await asyncio.create_subprocess_exec('python3', '-c', 'import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.read_bytes();\ntry: p.write_text("forged")\nexcept PermissionError: pass\nelse: raise AssertionError("writable policy")\ntry: (p.parent / "forged").touch()\nexcept PermissionError: pass\nelse: raise AssertionError("writable parent")', str(path), user=996, group=996, extra_groups=[])
                assert await child.wait() == 0
            assert requests[-1].startswith('GET /llm/account HTTP/1.1\r\n')
            assert 'Authorization: Bearer local-secret\r\n' in requests[-1]
            mode[0] = 'original'
            clock[0] += 10
            assert await adapter.refresh(), 'Backend-qualified original detail must be accepted'
            old = path.read_bytes()
            snapshot = json.loads(old)
            assert snapshot['model_capabilities']['fixture/image']['image_input']['detail'] == 'original'
            assert snapshot['fetched_at_monotonic_ms'] == clock[0]
            # One malformed candidate invalidates the entire discovery response.
            # Failed refreshes must preserve original detail and freshness evidence.
            mode[0] = 'auto'
            clock[0] += 1000
            assert not await adapter.refresh(), 'Unqualified auto detail must invalidate discovery'
            assert path.read_bytes() == old
            assert json.loads(path.read_bytes())['fetched_at_monotonic_ms'] == snapshot['fetched_at_monotonic_ms']
            for bad in ['redirect', 'oversize', 'invalid', 'failure', 'legacy', 'unknown', 'bad-default', 'bad-context', 'route-injection']:
                mode[0] = bad
                clock[0] += 40000
                count = len(requests)
                assert not await adapter.refresh()
                assert len(requests) == count + 1  # A redirect must never issue a second credential-bearing request.
                assert path.read_bytes() == old  # Even past expiry, failures never rewrite success evidence.
            assert clock[0] - snapshot['fetched_at_monotonic_ms'] > 120000
            mode[0] = 'chunked'
            assert await adapter.refresh()
            assert json.loads(path.read_bytes())['fetched_at_monotonic_ms'] == clock[0]
            mode[0] = 'large-account'
            assert await adapter.refresh(), 'The discovery budget bounds the whole response, not just processor evidence'
            assert len(path.read_bytes()) < policy.MAX_POLICY_BYTES
            mode[0] = 'revoked'
            clock[0] += 10
            assert await adapter.refresh()
            assert json.loads(path.read_bytes())['managed_access_enabled'] is False
            old = path.read_bytes()
            mode[0] = 'slow'
            start = asyncio.get_running_loop().time()
            assert not await adapter.refresh()
            assert 2.8 <= asyncio.get_running_loop().time() - start < 3.6
            assert path.read_bytes() == old
            # Setting the shared stop event also cancels an in-flight request.
            for trial in range(10):
                stopped = asyncio.Event()
                task = asyncio.create_task(adapter.run(stopped))
                await asyncio.sleep(.001 * (trial % 4))
                stopped.set()
                await asyncio.wait_for(task, .2)
                assert path.read_bytes() == old
            task = asyncio.create_task(adapter.run(asyncio.Event()))
            await asyncio.sleep(.02)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError('refresh task did not cancel')
            assert path.read_bytes() == old
            for failures in range(1, 20):
                for random_value in [0, .5, 1]:
                    delay = policy.retry_delay(failures, random_value)
                    assert 5 <= delay <= 30
            assert policy.retry_delay(1, .5) == 5
            assert policy.retry_delay(2, .5) == 10
            assert policy.retry_delay(3, .5) == 20
            assert policy.retry_delay(4, .5) == 30
            assert policy.retry_delay(3, 0) == 16 and policy.retry_delay(3, 1) == 24
            assert not list(parent.glob('.model-policy.json.*'))
            # Observe retry intervals from the live network loop, including
            # return to the success cadence. No wall-clock 30s sleeps are needed.
            delays = []
            adapter = policy.ModelPolicy(url, 'local-secret', path, clock=lambda: clock[0], boot_id='fixture-boot')
            stopped = asyncio.Event()
            mode[0] = 'failure'
            async def advance(awaitable, delay):
                awaitable.close()
                delays.append(delay)
                if len(delays) == 4:
                    mode[0] = 'success'
                if len(delays) == 5:
                    stopped.set()
                await asyncio.sleep(0)
                raise TimeoutError
            count = len(requests)
            with patch.object(policy.random, 'random', return_value=.5), patch.object(policy.asyncio, 'wait_for', advance):
                await adapter.run(stopped)
            assert delays == [5, 10, 20, 30, 30]
            assert len(requests) == count + 5
            unsafe = parent / 'unsafe'
            unsafe.mkdir()
            unsafe.chmod(0o770)
            try:
                policy.atomic_policy(unsafe / 'model-policy.json', snapshot)
            except ValueError:
                pass
            else:
                raise AssertionError('processor-writable policy directory accepted')
            # Exercise root main's actual command and credential handoff while
            # discovery refreshes independently of the one owner/service launch.
            pair_spec = importlib.util.spec_from_file_location('pair', Path(__file__).parents[1] / 'preprocessing-pair.py')
            pair = importlib.util.module_from_spec(pair_spec)
            pair_spec.loader.exec_module(pair)
            boot = {'base': str(parent), 'model': 'proxy/absent/preference#high', 'proxyUrl': url,
                    'port': 8765, 'allowModelFallback': True, 'fallbackModels': ['proxy/fixture/image#low'],
                    'minContextTokens': 123, 'minOutputTokens': 456, 'modelPolicyMaxAgeMs': 120000,
                    'modelPolicyRefreshMs': 2, 'startupSeconds': 300,
                    'serviceShutdownSeconds': 180, 'ownerShutdownSeconds': 30}
            (parent / 'boot.json').write_text(json.dumps(boot))
            (parent / 'proxy-token').write_text('local-secret')
            (parent / 'service-token').write_text('service-secret')
            mode[0] = 'success'
            calls = []
            async def supervised(owner, service, descriptor, stopped, **options):
                calls.append((owner, service))
                assert options['identity'] == 996
                assert options['owner_env']['PREPROCESSING_PROXY_TOKEN'] == 'local-secret'
                assert options['service_env']['PREPROCESSING_TOKEN'] == 'service-secret'
                assert 'PREPROCESSING_PROXY_TOKEN' not in options['service_env']
                expected = {'--model-policy': str(path), '--model-declarations': str(parent / 'engine.json'),
                            '--allow-model-fallback': 'true', '--fallback-models': '["proxy/fixture/image#low"]',
                            '--model-policy-max-age-ms': '120000', '--model': 'proxy/absent/preference#high'}
                for flag, value in expected.items():
                    assert service[service.index(flag) + 1] == value
                for key, flag in [('minContextTokens', '--min-context-tokens'), ('minOutputTokens', '--min-output-tokens')]:
                    if boot[key] is None:
                        assert flag not in service  # The processor derives the default; never pass None or a fake floor.
                    else:
                        assert service[service.index(flag) + 1] == str(boot[key])
                count = len(requests)
                async with asyncio.timeout(1):
                    while len(requests) < count + 3:
                        await asyncio.sleep(.002)
                observed = json.loads(path.read_bytes())
                assert observed['boot_id'] == Path('/proc/sys/kernel/random/boot_id').read_text().strip()
                assert observed['fetched_at_monotonic_ms'] > 0
                stopped.set()
                await asyncio.sleep(.01)
                return 0
            loop = asyncio.get_running_loop()
            for context, output in [(123, 456), (None, None), (None, 32000), (1050000, None)]:
                boot.update(minContextTokens=context, minOutputTokens=output)
                (parent / 'boot.json').write_text(json.dumps(boot))
                with patch.object(pair, 'run_pair', supervised), patch.object(pair, 'extraction_config', return_value=parent / 'engine.json'), patch.object(loop, 'add_reader'), patch.object(loop, 'add_signal_handler'), patch.object(pair.sys, 'argv', ['pair', str(parent)]):
                    assert await pair.main() == 0
            assert len(calls) == 4  # One pair launch per invocation, despite repeated discovery refreshes.
            count = len(requests)
            await asyncio.sleep(.02)
            assert len(requests) == count
    finally:
        server.close()
        await server.wait_closed()
    print('model policy behavior verified')
    print('image detail original retained; auto rejected without replacing or renewing snapshot')


asyncio.run(main())
