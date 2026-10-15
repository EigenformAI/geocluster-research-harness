"""Root discovery adapter. Catalog declarations are not account authorization."""
import asyncio
import contextlib
import datetime
import json
import os
import random
import re
import ssl
import stat
import sys
import tempfile
import time
import unicodedata
from pathlib import Path
from urllib.parse import urlsplit

MAX_BYTES = int(os.environ.get('RUNTIME_MANAGED_DISCOVERY_MAX_BYTES', 1024 * 1024))
if not 0 < MAX_BYTES <= 2**53 - 1:
    raise ValueError('RUNTIME_MANAGED_DISCOVERY_MAX_BYTES must be a positive safe integer')
MAX_POLICY_BYTES = 65536  # The installed processor's private handoff budget.
SAFE_INTEGER = 2**53 - 1


def model_id(value):
    return (isinstance(value, str) and bool(value)
            and not any(char.isspace() or unicodedata.category(char) in {'Cc', 'Cf'}
                        or char in '#?\\:\ufffd' for char in value))


def model_reference(value):
    """Exact preference syntax only; a variant still needs processor qualification."""
    if not isinstance(value, str) or len(value) > 166 or not value.startswith('proxy/'):
        return False
    name, marker, variant = value[6:].partition('#')
    return model_id(name) and (not marker or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', variant) is not None)


def positive(value):
    if type(value) is not int or not 0 < value <= SAFE_INTEGER:
        raise ValueError('Policy limits must be positive safe integers')
    return value


def modalities(value):
    return (isinstance(value, list) and bool(value)
            and all(isinstance(item, str) and item in {'text', 'image', 'audio', 'video', 'pdf'} for item in value)
            and len(set(value)) == len(value))


def validate_declarations(value, allowed):
    """Validate public execution metadata before projecting extraction evidence."""
    models = value.get('managed_models')
    if not isinstance(models, dict) or set(models) != set(allowed):
        raise ValueError('Invalid managed_models')
    default = value.get('default_model_id')
    if 'default_model_id' not in value or (default is not None and default not in models):
        raise ValueError('Invalid default_model_id')
    for name, item in models.items():
        if not isinstance(item, dict) or set(item) != {'name', 'capabilities', 'limit', 'variants'}:
            raise ValueError('Invalid managed_models declaration fields')
        if (not isinstance(item['name'], str) or not item['name'].strip()
                or any(ord(char) < 32 or ord(char) == 127 for char in item['name'])):
            raise ValueError('Invalid managed_models name')
        caps = item['capabilities']
        if (not isinstance(caps, dict) or set(caps) != {'tools', 'input', 'output'}
                or type(caps['tools']) is not bool or not modalities(caps['input'])
                or not modalities(caps['output'])):
            raise ValueError('Invalid managed_models capabilities')
        limits = item['limit']
        if not isinstance(limits, dict) or set(limits) != {'context', 'input', 'output'}:
            raise ValueError('Invalid managed_models limit')
        for amount in limits.values():
            positive(amount)
        if limits['input'] + limits['output'] > limits['context']:
            raise ValueError('Invalid managed_models context budget')
        variants = item['variants']
        if not isinstance(variants, list):
            raise ValueError('Invalid managed_models variants')
        identities = set()
        for variant in variants:
            if not isinstance(variant, dict) or set(variant) != {'id', 'settings'}:
                raise ValueError('Invalid managed_models variant fields')
            identity, settings = variant['id'], variant['settings']
            if (not isinstance(identity, str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', identity) is None
                    or identity in identities or not isinstance(settings, dict) or set(settings) != {'reasoning'}
                    or not isinstance(settings['reasoning'], dict) or set(settings['reasoning']) != {'effort'}
                    or settings['reasoning']['effort'] not in {'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'}):
                raise ValueError('Invalid managed_models reasoning variant')
            identities.add(identity)


def projection(value, fetched_at, boot_id):
    """Allowlist only the agreed wire evidence; never retain account or route data."""
    if (not isinstance(value, dict) or type(value.get('discovery_schema_version')) is not int
            or value['discovery_schema_version'] != 2 or type(value.get('managed_access_enabled')) is not bool):
        raise ValueError('Unsupported account discovery')
    allowed = value.get('allowed_model_ids')
    if (not isinstance(allowed, list)
            or not all(model_id(item) for item in allowed) or len(set(allowed)) != len(allowed)):
        raise ValueError('Invalid accepted model IDs')
    validate_declarations(value, allowed)
    limits, capabilities = value.get('model_limits'), value.get('model_capabilities')
    if not isinstance(limits, dict) or not isinstance(capabilities, dict):
        raise ValueError('Invalid model evidence')
    candidates = [name for name in allowed
                  if set(value['managed_models'][name]['capabilities']['input']) <= {'text', 'image'}
                  and value['managed_models'][name]['capabilities']['output'] == ['text']]
    projected_limits, projected_caps = {}, {}
    for name in candidates:
        # Missing candidate evidence stays missing, so the processor cannot select it.
        if name in limits:
            item = limits[name]
            if not isinstance(item, dict):
                raise ValueError('Invalid model limits')
            projected_limits[name] = {key: positive(item[key]) for key in
                                      ('default_output_tokens', 'max_output_tokens', 'max_input_tokens') if key in item}
            if ('default_output_tokens' in item and 'max_output_tokens' in item
                    and item['default_output_tokens'] > item['max_output_tokens']):
                raise ValueError('Contradictory output limits')
            declaration = value['managed_models'][name]['limit']
            if (declaration['input'] > item.get('max_input_tokens', 0)
                    or declaration['output'] > item.get('max_output_tokens', 0)):
                raise ValueError('Managed declarations exceed extraction admission bounds')
        if name in capabilities:
            item = capabilities[name]
            if (not isinstance(item, dict) or not modalities(item.get('input'))
                    or not set(item['input']) <= {'text', 'image'}
                    or item.get('output') != ['text'] or 'image_input' not in item):
                raise ValueError('Invalid model capabilities')
            efforts = item.get('allowed_reasoning_efforts')
            if (not isinstance(efforts, list) or len(efforts) > 16 or len(set(efforts)) != len(efforts)
                    or any(not isinstance(effort, str) or effort not in
                           {'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'default'} for effort in efforts)):
                raise ValueError('Invalid reasoning evidence')
            image = item['image_input']
            # A null image qualification remains null even when advertised input
            # includes images. Missing qualification must not become permission.
            if image is not None:
                if not isinstance(image, dict):
                    raise ValueError('Invalid image qualification')
                mime_types = image.get('mime_types')
                if (not isinstance(mime_types, list) or not 1 <= len(mime_types) <= 16
                        or any(not isinstance(mime, str) or len(mime) > 64
                               or re.fullmatch(r'image/[a-z0-9.+-]+', mime) is None for mime in mime_types)
                        or len(set(mime_types)) != len(mime_types) or image.get('detail') not in {'low', 'high', 'original'}):
                    raise ValueError('Invalid image qualification')
                image = {**{key: positive(image.get(key)) for key in
                            ('max_images', 'max_bytes', 'max_pixels', 'tokens_per_image')},
                         'mime_types': list(mime_types), 'detail': image['detail']}
            projected_caps[name] = {'input': list(item['input']), 'output': ['text'],
                                    'image_input': image, 'allowed_reasoning_efforts': list(efforts)}
            declaration = value['managed_models'][name]
            if (declaration['capabilities']['input'] != item['input']
                    or declaration['capabilities']['output'] != item['output']
                    or any(variant['settings']['reasoning']['effort'] not in efforts
                           for variant in declaration['variants'])):
                raise ValueError('Managed declarations contradict extraction evidence')
    as_of = value.get('as_of')
    if not isinstance(as_of, str) or len(as_of) > 64 or datetime.datetime.fromisoformat(as_of.replace('Z', '+00:00')).tzinfo is None:
        raise ValueError('Invalid discovery observation time')
    # This private processor handoff has its own pinned schema. It is not a
    # version-1 backend adapter: only validated version-2 discovery reaches it.
    result = {'discovery_schema_version': 1, 'managed_access_enabled': value['managed_access_enabled'],
              'allowed_model_ids': candidates, 'model_limits': projected_limits,
              'model_capabilities': projected_caps, 'as_of': as_of,
              'fetched_at_monotonic_ms': fetched_at, 'boot_id': boot_id}
    if len(json.dumps(result, allow_nan=False).encode()) > MAX_POLICY_BYTES:
        raise ValueError('Projected evidence exceeds parsing bound')
    return result


async def fetch_discovery(proxy_url, token):
    """One bounded request, no redirects or ambient HTTP proxy, cancellable in 3s."""
    target = urlsplit(proxy_url.rstrip('/') + '/account')
    if (target.scheme not in {'http', 'https'} or not target.hostname or target.username
            or target.password or target.query or target.fragment or not token
            or any(ord(char) < 33 or ord(char) > 126 for char in token)):
        raise ValueError('Invalid managed discovery route or credential')
    writer = None
    try:
        async with asyncio.timeout(3):
            tls = ssl.create_default_context() if target.scheme == 'https' else None
            reader, writer = await asyncio.open_connection(target.hostname, target.port or (443 if tls else 80), ssl=tls, limit=16384)
            writer.write((f'GET {target.path} HTTP/1.1\r\nHost: {target.netloc}\r\n'
                          f'Authorization: Bearer {token}\r\nAccept: application/json\r\n'
                          'Cache-Control: no-store\r\nConnection: close\r\n\r\n').encode('ascii'))
            await writer.drain()
            head = await reader.readuntil(b'\r\n\r\n')
            lines = head.decode('ascii').split('\r\n')
            status = lines[0].split(' ')
            if len(status) < 2 or status[0] not in {'HTTP/1.0', 'HTTP/1.1'} or status[1] != '200':
                raise ValueError('Account discovery did not succeed')
            headers = {}
            for line in lines[1:-2]:
                key, separator, value = line.partition(':')
                key = key.lower()
                if not separator or key in headers:
                    raise ValueError('Invalid discovery headers')
                headers[key] = value.strip()
            if headers.get('content-encoding', 'identity') != 'identity':
                raise ValueError('Encoded discovery is unsupported')
            raw = bytearray()
            if 'transfer-encoding' in headers:
                if headers['transfer-encoding'].lower() != 'chunked' or 'content-length' in headers:
                    raise ValueError('Invalid discovery transfer framing')
                while True:
                    line = await reader.readuntil(b'\r\n')
                    size = int(line.split(b';', 1)[0], 16)
                    if size < 0 or size > MAX_BYTES - len(raw):
                        raise ValueError('Discovery response exceeds byte budget')
                    if not size:
                        # Bounded trailers are ignored, never projected.
                        total = 0
                        while (line := await reader.readuntil(b'\r\n')) != b'\r\n':
                            total += len(line)
                            if total > 16384:
                                raise ValueError('Discovery trailers exceed bound')
                        break
                    raw.extend(await reader.readexactly(size))
                    if await reader.readexactly(2) != b'\r\n':
                        raise ValueError('Invalid discovery chunk')
            elif 'content-length' in headers:
                length = int(headers['content-length'])
                if not 0 <= length <= MAX_BYTES:
                    raise ValueError('Discovery response exceeds byte budget')
                raw.extend(await reader.readexactly(length))
            else:
                while chunk := await reader.read(min(8192, MAX_BYTES + 1 - len(raw))):
                    raw.extend(chunk)
                    if len(raw) > MAX_BYTES:
                        raise ValueError('Discovery response exceeds byte budget')
            return json.loads(raw)
    finally:
        if writer is not None:
            writer.close()


def atomic_policy(path, value):
    """Root-only parent plus atomic root:996 0640 replacement."""
    path = Path(path)
    info = path.parent.lstat()
    if os.getuid() != 0 or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('Policy parent must be root-owned and not group writable')
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name + '.')
    try:
        with os.fdopen(fd, 'w') as handle:
            os.fchmod(handle.fileno(), 0o640)
            os.fchown(handle.fileno(), 0, 996)
            json.dump(value, handle, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


def retry_delay(failures, random_value=None):
    base = min(30, 5 * 2**min(max(failures - 1, 0), 3))
    return min(30, max(5, base * (1 + .2 * (2 * (random.random() if random_value is None else random_value) - 1))))


class ModelPolicy:
    def __init__(self, proxy_url, token, path, *, refresh_ms=30000, clock=None, boot_id=None):
        self.proxy_url, self.token, self.path = proxy_url, token, Path(path)
        self.refresh_ms = positive(refresh_ms)
        self.clock = clock or (lambda: time.monotonic_ns() // 1000000)
        self.boot_id = boot_id or Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        self.failures = 0

    async def refresh(self):
        try:
            upstream = await fetch_discovery(self.proxy_url, self.token)
            # Timestamp the successful fetch, not disk reads, retries or backend as_of.
            value = projection(upstream, self.clock(), self.boot_id)
            atomic_policy(self.path, value)
        except (OSError, ValueError, TypeError, RecursionError, TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            self.failures += 1
            print('preprocessing-owner / model-policy: discovery failed; retain original evidence; inspect gateway account discovery and retry.', file=sys.stderr)
            return False
        self.failures = 0
        return True

    async def run(self, stopped):
        worker = asyncio.create_task(self._refresh_loop(stopped))
        stopping = asyncio.create_task(stopped.wait())
        try:
            await asyncio.wait([worker, stopping], return_when=asyncio.FIRST_COMPLETED)
            if worker.done():
                await worker
        finally:
            worker.cancel()
            stopping.cancel()
            await asyncio.gather(worker, stopping, return_exceptions=True)

    async def _refresh_loop(self, stopped):
        while not stopped.is_set():
            await self.refresh()
            delay = retry_delay(self.failures) if self.failures else self.refresh_ms / 1000
            try:
                await asyncio.wait_for(stopped.wait(), delay)
            except TimeoutError:
                pass
