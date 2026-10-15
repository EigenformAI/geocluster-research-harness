"""Streamed root probe. Only allowlisted proof leaves the isolated container."""
import base64
import hashlib
import json
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

stage = 'identity'


def require(condition):
    if not condition:
        raise ValueError('qualification_failed')


def read_json(path):
    with open(path, 'rb') as handle:
        raw = handle.read(65537)
    require(len(raw) <= 65536)
    return json.loads(raw)


def request(url, headers=None):
    require(url.startswith('http://127.0.0.1:'))
    # Never follow redirects, even to another loopback listener.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(urllib.request.Request(url, headers=headers or {}), timeout=2) as response:
            raw = response.read(65537)
            require(len(raw) <= 65536)
            return response.status, json.loads(raw)
    except urllib.error.HTTPError as error:
        return error.code, None


def children():
    result = {'owners': 0, 'services': 0}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / 'cmdline').read_bytes().split(b'\0')
            kind = 'owners' if b'preprocessing.engine_owner' in args else 'services' if b'preprocessing.cli' in args and b'serve' in args else None
            if kind is None:
                continue
            status = (entry / 'status').read_text()
            values = dict(line.split(':', 1) for line in status.splitlines())
            if values['State'].strip().startswith('Z'):
                continue
            require(all(int(value) == 996 for value in values['Uid'].split()))
            require(all(int(value) == 996 for value in values['Gid'].split()))
            result[kind] += 1
        except (FileNotFoundError, ProcessLookupError):
            continue
    return result


def managed_boundary():
    """Probe the installed Unix and relay boundary, not plugin permission rules."""
    private = ['/run/runtime/machine-token', '/run/runtime/machine-credentials.json',
               '/run/runtime/gate', '/run/runtime/files-control']
    require(Path('/root').stat().st_mode & 0o777 == 0o700)
    require(all(Path(name).is_file() for name in private))
    credentials = read_json(private[1])
    secrets = [Path(private[0]).read_bytes().strip(), Path(private[2]).read_bytes().strip(),
               Path(private[3]).read_bytes().strip()]
    secrets += [credentials[key].encode() for key in ('llmToken', 'activityToken', 'datasetToken')]
    require(all(secrets))
    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        try:
            identity = next(line for line in (process / 'status').read_text().splitlines() if line.startswith('Uid:'))
            uid = int(identity.split()[1])
            if uid in (999, 996, 997):
                # Docker root need not have CAP_SYS_PTRACE. Inspect through the
                # same identity that untrusted code actually uses.
                reader = "import pathlib,sys\ntry: sys.stdout.buffer.write(pathlib.Path(sys.argv[1]).read_bytes())\nexcept (PermissionError,FileNotFoundError,ProcessLookupError): sys.exit(77)"
                observed = subprocess.run(['/usr/bin/python3', '-I', '-c', reader, str(process / 'environ')],
                                          user=uid, group=uid, extra_groups=[], env={},
                                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                          stderr=subprocess.DEVNULL, timeout=5, check=False)
                require(observed.returncode in (0, 77) and len(observed.stdout) <= 1048576)
                require(not any(secret in observed.stdout for secret in secrets))
        except (FileNotFoundError, ProcessLookupError):
            continue
    program = '''import json,pathlib,sys,urllib.request,urllib.error
for name in json.loads(sys.argv[1]):
    try: pathlib.Path(name).read_bytes()
    except PermissionError: pass
    else: raise AssertionError('private authority was readable')
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
for route in ['/files-backend/limits','/work-backend/claims']:
    try: opener.open('http://127.0.0.1:3003'+route,timeout=2)
    except urllib.error.HTTPError as error: assert error.code==403
    else: raise AssertionError('private relay route was admitted')
'''
    for identity in (999, 996, 997):
        result = subprocess.run(['/usr/bin/python3', '-I', '-c', program, json.dumps(private)],
                                user=identity, group=identity, extra_groups=[],
                                env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'},
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=10, check=False)
        require(result.returncode == 0)


def main():
    global stage
    expected = json.loads(sys.argv[1])
    end = time.monotonic() + expected['deadlineMs'] / 1000
    identity = read_json('/opt/geocluster-preprocessing/build-identity.json')
    require(identity['digest'] == expected['digest'])
    build = read_json('/opt/opencode/engine/build-identity.json')
    require(all(build.get(key) == value for key, value in expected['engineInput'].items()))
    require(hashlib.sha256(Path('/opt/opencode/engine/bin/opencode').read_bytes()).hexdigest() == build['binarySha256'])
    with tempfile.TemporaryDirectory(prefix='processor-version-') as root:
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': root, 'TMPDIR': root,
               'OPENCODE_DISABLE_AUTOUPDATE': '1', 'NO_COLOR': '1'}
        for key in ('XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'):
            env[key] = root + '/' + key
        observed = subprocess.run(['/usr/local/bin/opencode', '--version'], env=env, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, check=False, timeout=min(10, max(.01, end-time.monotonic())))
        require(observed.returncode == 0 and len(observed.stdout) <= 256)
        version = observed.stdout.decode().strip().removeprefix('opencode v')
    require(version == build['version'])
    while time.monotonic() < end:
        try:
            stage = 'boot'
            boot = read_json('/run/runtime/preprocessing/boot.json')
            require(boot['configured'] is True and boot['enabled'] is False and boot['aggregate'] is False)
            token = Path('/run/runtime/preprocessing/service-token').read_text().strip()
            url = f"http://127.0.0.1:{boot['port']}/preprocessing/capabilities"
            stage = 'service'
            denied, _ = request(url)
            require(denied == 401)
            status, capabilities = request(url, {'Authorization': 'Bearer ' + token})
            require(status == 200)
            dependency = capabilities['dependency']
            stage = 'dependency'
            require(dependency.get('ready') is True and dependency.get('executionReady') is True)
            require(dependency.get('eligibleCandidateCount') == 2)
            require(dependency.get('selectedModel') == 'proxy/openai/gpt-6-luna')
            stage = 'policy'
            policy = read_json('/run/runtime/preprocessing/model-policy.json')
            require(policy['model_capabilities']['openai/gpt-6-luna']['image_input']['detail'] == 'original')
            require(dependency.get('version') == version)
            stage = 'identity'
            descriptor = read_json(Path(boot['base']) / 'engine/descriptor.json')
            credentials = base64.b64encode((descriptor.get('username', 'opencode') + ':' + descriptor['password']).encode()).decode()
            status, info = request(descriptor['serverUrl'].rstrip('/') + '/api/info', {'Authorization': 'Basic ' + credentials})
            require(status == 200 and info.get('version') == version and descriptor.get('version') == version)
            processes = children()
            stage = 'processes'
            require(processes == {'owners': 1, 'services': 1})
            fixture = read_json('/tmp/processor-discovery-observation.json')
            stage = 'discovery'
            require(fixture['requests'] > 0 and fixture['inferenceRequests'] == 0)
            try:
                stage = 'boundary'
                managed_boundary()
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                raise RuntimeError('managed_boundary_failed') from error
            return {'ok': True, 'bundleDigest': identity['digest'], 'engineVersion': version,
                    'engineIdentityVerified': True, 'managedBoundaryVerified': True,
                    'authenticated': True, 'unauthenticatedStatus': denied,
                    'ready': True, 'executionReady': True, **processes, 'uid': 996, 'gid': 996,
                    'eligibleCandidateCount': 2, 'selectedModel': dependency['selectedModel'],
                    'discoveryRequests': fixture['requests'], 'inferenceRequests': 0}
        except (OSError, ValueError, KeyError, TypeError):
            time.sleep(min(.2, max(0, end-time.monotonic())))
    raise ValueError('startup_deadline_exceeded')


try:
    print(json.dumps(main()))
except Exception:  # noqa: BLE001 - never expose descriptors, credentials or raw responses
    print(json.dumps({'ok': False, 'failure': 'installed_startup_failed', 'stage': stage}))
    sys.exit(1)
