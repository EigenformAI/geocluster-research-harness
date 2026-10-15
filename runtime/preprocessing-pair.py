"""Root-owned standalone pair adapter: separate credentials and service-first settlement."""
import asyncio
import contextlib
import ctypes
import importlib.util
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

_spec = importlib.util.spec_from_file_location('preprocessing_model_policy', Path(__file__).with_name('preprocessing-model-policy.py'))
policy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(policy)


def process_identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return None if fields[0] == 'Z' else (int(fields[1]), fields[19])
    except (OSError, ValueError, IndexError):
        return None


def descendants(pid, known):
    table = {}
    for name in os.listdir('/proc'):
        if name.isdigit() and (identity := process_identity(int(name))):
            table[int(name)] = identity
    queue = [pid] if pid in table else []
    for parent in queue:
        for child, identity in table.items():
            if identity[0] == parent and child not in queue:
                known[child] = identity
                queue.append(child)


def send(pid, identity, sig):
    if not alive(pid, identity):
        return
    try:
        fd = os.pidfd_open(pid)
        try:
            if alive(pid, identity):
                signal.pidfd_send_signal(fd, sig)
        finally:
            os.close(fd)
    except ProcessLookupError:
        pass


def alive(pid, identity):
    current = process_identity(pid)
    # Parent changes on adoption; start time remains the PID-reuse fence.
    return current is not None and current[1] == identity[1]


async def stop_child(process, known, seconds, deadline):
    if process is None:
        return True
    descendants(process.pid, known)
    if process.returncode is None:
        with contextlib.suppress(ProcessLookupError):
            process.terminate()  # Only the service/owner leader; never its engine first.
    end = min(deadline(), time.monotonic() + seconds)
    forced = False
    while process.returncode is None and time.monotonic() < end:
        descendants(process.pid, known)
        await asyncio.sleep(.02)
    if process.returncode is None:
        forced = True
        with contextlib.suppress(ProcessLookupError):
            process.kill()
    await process.wait()
    # Parser and guardian descendants can have independent sessions. Identity-fenced
    # cleanup happens only after their owning leader's settlement allowance.
    for pid, identity in known.items():
        send(pid, identity, signal.SIGKILL)
    while any(alive(pid, identity) for pid, identity in known.items()) and time.monotonic() < min(deadline(), end + 1):
        await asyncio.sleep(.02)
    return not forced and process.returncode in (0, -signal.SIGTERM) and not any(alive(pid, identity) for pid, identity in known.items())


def descriptor_instance(path):
    """Read the owner handoff; engine compatibility is validated by owner and service."""
    try:
        with path.open('rb') as handle:
            raw = handle.read(4 * 1024 * 1024 + 1)
        value = json.loads(raw) if len(raw) <= 4 * 1024 * 1024 else None
        if (isinstance(value, dict) and value.get('mode') == 'standalone'
                and isinstance(value.get('engineInstanceId'), str) and value['engineInstanceId']):
            return value['engineInstanceId']
    except (OSError, ValueError, RecursionError):
        pass
    return None


async def run_pair(owner_command, service_command, descriptor, stopped, *, owner_env=None,
                   service_env=None, identity=None, startup_seconds=300,
                   service_seconds=180, owner_seconds=30, deadline=lambda: float('inf')):
    """Equivalent standalone ordering, with independent child environments and UID."""
    owner = service = None
    owner_tree, service_tree = {}, {}
    previous = descriptor_instance(descriptor)
    result = 0
    options = {'start_new_session': True, 'stdin': asyncio.subprocess.DEVNULL}
    if identity is not None:
        options.update(user=identity, group=identity, extra_groups=[])
    try:
        owner = await asyncio.create_subprocess_exec(*owner_command, env=owner_env, **options)
        end = time.monotonic() + startup_seconds
        ready = False
        while not stopped.is_set() and owner.returncode is None and time.monotonic() < end:
            descendants(owner.pid, owner_tree)
            current = descriptor_instance(descriptor)
            if current is not None and current != previous:
                ready = True
                break
            await asyncio.sleep(.05)
        if ready and not stopped.is_set() and owner.returncode is None:
            service = await asyncio.create_subprocess_exec(*service_command, env=service_env, **options)
            while not stopped.is_set() and owner.returncode is None and service.returncode is None:
                descendants(owner.pid, owner_tree)
                descendants(service.pid, service_tree)
                await asyncio.sleep(.05)
        if not stopped.is_set():
            result = 1
    finally:
        # These allowances share the root's absolute total deadline.
        try:
            if not await stop_child(service, service_tree, service_seconds, deadline):
                result = 1
        finally:
            if not await stop_child(owner, owner_tree, owner_seconds, deadline):
                result = 1
        # PR_SET_CHILD_SUBREAPER adopts descendants after a forced leader exit.
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    break
            except ChildProcessError:
                break
    return result


def bootstrap_model(boot, models, *, require_image=True):
    """Choose only an installed bootstrap; fresh job admission remains the processor's."""
    preferred = boot['model']
    if not policy.model_reference(preferred):
        raise ValueError('Select an explicit managed preprocessing model')
    candidates = [preferred]
    if boot.get('allowModelFallback', True):
        candidates.extend(boot.get('fallbackModels', []))
        # Match processor ordering: variants need explicit alternative references.
        if '#' not in preferred:
            candidates.extend('proxy/' + name for name in sorted(models))
    for reference in candidates:
        if not policy.model_reference(reference):
            continue
        name, _, variant = reference[6:].partition('#')
        model = models.get(name)
        if (model is not None and (not require_image or {'text', 'image'} <= set(model['capabilities']['input']))
                and model['capabilities']['output'] == ['text']
                and (not variant or variant in {item['id'] for item in model['variants']})):
            return reference
    raise ValueError('Extraction requires a permitted installed model and qualified variant with suitable input')


def model_config(boot, catalog):
    from preprocessing.engine import SYSTEM
    from preprocessing.dev import validate_config
    models = trusted_models(catalog)
    selected = bootstrap_model(boot, models)
    deny = [{'action': '*', 'resource': '*', 'effect': 'deny'}]
    config = {'model': selected, 'default_agent': 'preprocessing', 'permissions': deny,
                  'agents': {'preprocessing': {'mode': 'primary', 'hidden': False, 'system': SYSTEM, 'permissions': deny, 'steps': 1}},
                  'providers': {'proxy': {'name': 'Managed models', 'package': '@opencode/ai/providers/openrouter',
                       'settings': {'baseURL': boot['proxyUrl'], 'apiKey': '{env:PREPROCESSING_PROXY_TOKEN}'},
                       'models': models}},
                  'mcp': {'servers': {}}, 'plugins': ['-opencode.agent', '-opencode.plan'], 'skills': [],
              'snapshots': False, 'warming': False, 'compaction': {'auto': False}, 'update': 'disable'}
    return validate_config(config, ['PREPROCESSING_PROXY_TOKEN'])


def trusted_models(catalog):
    """Project validated public declarations; no native configuration or maker table."""
    if type(catalog.get('discovery_schema_version')) is not int or catalog['discovery_schema_version'] != 2:
        raise ValueError('Unsupported installed managed catalog schema')
    models = catalog.get('managed_models')
    if not isinstance(models, dict):
        raise ValueError('Invalid installed managed models')
    result = {}
    for name, model in models.items():
        if not policy.model_id(name) or not isinstance(model, dict) or set(model) != {'name', 'limit', 'capabilities', 'variants'}:
            raise ValueError('Invalid installed model declaration')
        caps, limits = model.get('capabilities'), model.get('limit')
        if (not isinstance(caps, dict) or set(caps) != {'tools', 'input', 'output'} or type(caps.get('tools')) is not bool
                or not isinstance(caps.get('input'), list) or not isinstance(caps.get('output'), list)
                or not isinstance(limits, dict) or set(limits) != {'context', 'input', 'output'}
                or not isinstance(model.get('name'), str) or not model['name'].strip()):
            raise ValueError('Invalid installed modality or model metadata')
        budgets = {key: policy.positive(limits.get(key)) for key in ('context', 'input', 'output')}
        if budgets['input'] > budgets['context'] - budgets['output']:
            raise ValueError('Invalid installed token budgets')
        variants = model['variants']
        if not isinstance(variants, list):
            raise ValueError('Invalid installed variants')
        result[name] = {'name': model['name'],
                        'limit': budgets, 'variants': variants,
                        'capabilities': {'tools': False, 'input': list(caps['input']), 'output': list(caps['output'])}}
    return result


def managed_config(config, boot, catalog, *, require_image=False):
    """Custom operations may use text-only models, never change installed metadata."""
    providers = config.get('providers', {})
    if set(providers) != {'proxy'}:
        raise ValueError('Preprocessing must use the managed proxy only')
    proxy = providers['proxy']
    models = proxy.get('models', {})
    trusted = trusted_models(catalog)
    if (not isinstance(models, dict) or not models
            or proxy.keys() - {'name', 'package', 'settings', 'models'}
            or ('name' in proxy and proxy['name'] != 'Managed models')
            or any(name not in trusted or declared != trusted[name] for name, declared in models.items())
            or proxy.get('package') != '@opencode/ai/providers/openrouter'
            or proxy.get('settings') != {'baseURL': boot['proxyUrl'], 'apiKey': '{env:PREPROCESSING_PROXY_TOKEN}'}):
        raise ValueError('Preprocessing must retain its managed model route and purpose credential')
    if config.get('model') != bootstrap_model(boot, models, require_image=require_image):
        raise ValueError('Select a permitted installed preprocessing bootstrap model and qualified variant')
    return config


def extraction_config(boot, run):
    from preprocessing.dev import validate_config
    def bounded_json(path):
        with Path(path).open('rb') as handle:
            raw = handle.read(policy.MAX_BYTES + 1)
        if len(raw) > policy.MAX_BYTES:
            raise ValueError('Extraction configuration exceeds 64 KiB')
        return json.loads(raw)
    # Root validates the identity envelope and digest through the shared validator.
    # Only public metadata crosses to the owner, never native state or account credentials.
    catalog_env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'PROJECT_ID': boot['projectId'],
                   'RUNTIME_MANAGED_CATALOG_PATH': boot['managedCatalogPath'],
                   'RUNTIME_MANAGED_BACKEND_BASE_URL': boot['managedBackendBaseUrl'],
                   'RUNTIME_MANAGED_GENERATION': boot.get('runtimeGeneration') or '',
                   'RUNTIME_MANAGED_DISCOVERY_MAX_BYTES': str(boot['managedDiscoveryMaxBytes'])}
    try:
        catalog = json.loads(subprocess.check_output(['node', str(Path(__file__).with_name('lib') / 'managed-catalog.js'), 'read'], env=catalog_env, timeout=5))
    except (subprocess.SubprocessError, OSError) as error:
        raise ValueError('Managed extraction catalog unavailable') from error
    if boot.get('engineConfig'):
        config = bounded_json(boot['engineConfig'])
    else:
        config = model_config(boot, catalog)
    validate_config(config, ['PREPROCESSING_PROXY_TOKEN'])
    managed_config(config, boot, catalog, require_image=not bool(boot.get('engineConfig')))
    target = Path(boot['base']) / 'config/engine.json'
    with target.open('w') as handle:
        os.fchmod(handle.fileno(), 0o640)
        os.fchown(handle.fileno(), 0, 996)
        json.dump(config, handle)
    return target


async def main():
    run = Path(sys.argv[1])
    boot = json.loads((run / 'boot.json').read_text())
    # Adoption plus explicit tracked cleanup; this supervisor is never passed to
    # the runtime's generic tree killer.
    ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)
    stopped = asyncio.Event()
    end = [float('inf')]
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopped.set)
    def control():
        raw = os.read(0, 4096)
        if raw:
            try:
                end[0] = time.monotonic() + max(0, float(json.loads(raw)['deadlineMs']) / 1000 - time.time())
            except (ValueError, KeyError):
                end[0] = time.monotonic()
        else:
            loop.remove_reader(0)
        stopped.set()
    loop.add_reader(0, control)
    base = Path(boot['base'])
    config = extraction_config(boot, run)
    descriptor = base / 'engine/descriptor.json'
    owner = [sys.executable, '-m', 'preprocessing.engine_owner', '--state-dir', str(base / 'engine'),
             '--projection', str(base / 'data/.preprocessing/engine-lease.json'), '--descriptor', str(descriptor),
             '--opencode-executable', '/usr/local/bin/opencode', '--engine-config', str(config), '--credential-env', 'PREPROCESSING_PROXY_TOKEN']
    service = [sys.executable, '-m', 'preprocessing.cli', 'serve', '--data-root', str(base / 'data'),
               '--workspace', str(base / 'inbox'), '--engine-descriptor', str(descriptor), '--model', boot['model'],
               '--host', '127.0.0.1', '--port', str(boot['port']), '--token-env', 'PREPROCESSING_TOKEN']
    service += ['--model-policy', str(run / 'model-policy.json'), '--model-declarations', str(config),
                '--allow-model-fallback', 'true' if boot['allowModelFallback'] else 'false',
                '--fallback-models', json.dumps(boot['fallbackModels']),
                '--model-policy-max-age-ms', str(boot['modelPolicyMaxAgeMs'])]
    for key, flag in [('minContextTokens', '--min-context-tokens'), ('minOutputTokens', '--min-output-tokens')]:
        if boot.get(key) is not None:
            service += [flag, str(boot[key])]
    if boot.get('profile'):
        service += ['--profile', boot['profile']]
    clean = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/nonexistent', 'PYTHONUNBUFFERED': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
    proxy_token = (run / 'proxy-token').read_text().strip()
    adapter = policy.ModelPolicy(boot['proxyUrl'], proxy_token, run / 'model-policy.json', refresh_ms=boot['modelPolicyRefreshMs'])
    refresh_task = asyncio.create_task(adapter.run(stopped))
    try:
        return await run_pair(owner, service, descriptor, stopped,
            owner_env={**clean, 'PREPROCESSING_PROXY_TOKEN': proxy_token},
            service_env={**clean, 'PREPROCESSING_TOKEN': (run / 'service-token').read_text().strip()},
            identity=996, deadline=lambda: end[0], startup_seconds=boot['startupSeconds'],
            service_seconds=boot['serviceShutdownSeconds'], owner_seconds=boot['ownerShutdownSeconds'])
    finally:
        refresh_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await refresh_task


if __name__ == '__main__':
    try:
        raise SystemExit(asyncio.run(main()))
    except (OSError, ValueError, KeyError):
        print('Preprocessing pair blocked: inspect private configuration and retained ownership evidence.', file=sys.stderr)
        raise SystemExit(1)
