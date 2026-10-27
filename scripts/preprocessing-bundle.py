#!/usr/bin/env python3
"""Capture processor bytes as a pinned release or explicit development bundle."""
import argparse
import hashlib
import io
import json
import re
import subprocess
import tarfile
from pathlib import Path


def git(source, *args):
    result = subprocess.run(['git', '-C', str(source), *args], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


def read_object(path, label):
    value = json.loads(Path(path).read_text())
    if not isinstance(value, dict):
        raise ValueError(f'{label} must be a JSON object')
    return value


def hex_string(value, length):
    return isinstance(value, str) and bool(re.fullmatch(f'[0-9a-f]{{{length}}}', value))


def read_release_pin(path):
    if path is None:
        raise ValueError('A release pin is required for release mode')
    pin = read_object(path, 'The release pin')
    if not hex_string(pin.get('sourceRevision'), 40):
        raise ValueError('The release pin requires an exact processor commit')
    if not hex_string(pin.get('bundleSha256'), 64):
        raise ValueError('The release pin requires an exact bundle SHA-256')
    return pin


def check_release_source(source, pin):
    if git(source, 'status', '--porcelain', '--untracked-files=all') != '':
        raise ValueError('Release mode requires a clean processor checkout; use development mode for local work')
    if git(source, 'rev-parse', 'HEAD') != pin['sourceRevision']:
        raise ValueError('Processor revision does not match the release pin')


def bundle(source, output, *, mode='release', release_pin=None):
    if mode not in ('release', 'development'):
        raise ValueError(f'Unknown build mode: {mode}')
    source, output = Path(source).resolve(), Path(output)
    pin = read_release_pin(release_pin) if mode == 'release' else None
    if pin:
        check_release_source(source, pin)
    output.mkdir(parents=True, exist_ok=True)
    paths = [source / name for name in ('pyproject.toml', 'uv.lock', 'deployment/standalone/supervise.py')]
    for name in ('LICENSE', 'LICENSE.txt', 'NOTICE', 'NOTICE.txt', 'ThirdPartyNotices.txt'):
        path = source / name
        if path.exists() or path.is_symlink():
            paths.append(path)
    paths.extend(sorted((source / 'preprocessing').rglob('*.py')))
    if not (source / 'preprocessing/__init__.py').is_file():
        raise ValueError('Missing production package')
    # Only production sources, build inputs and explicit legal files enter the context.
    with tarfile.open(output / 'source.tar', 'w', format=tarfile.USTAR_FORMAT) as archive:
        for path in sorted(paths):
            if path.is_symlink() or not path.is_file():
                raise ValueError('Bundle inputs must be regular files')
            raw = path.read_bytes()
            info = tarfile.TarInfo(str(path.relative_to(source)))
            info.size, info.mode, info.mtime = len(raw), 0o644, 0
            archive.addfile(info, io.BytesIO(raw))
        # Build requirements and archive layout are part of the pinned bundle digest.
        raw = Path(__file__).with_name('preprocessing-build-requirements.txt').read_bytes()
        info = tarfile.TarInfo('build-requirements.txt')
        info.size, info.mode, info.mtime = len(raw), 0o644, 0
        archive.addfile(info, io.BytesIO(raw))
    digest = hashlib.sha256((output / 'source.tar').read_bytes()).hexdigest()
    if pin:
        check_release_source(source, pin)
        if digest != pin['bundleSha256']:
            raise ValueError('Processor bundle digest does not match the release pin')
    revision = git(source, 'rev-parse', 'HEAD') or 'unversioned'
    status = git(source, 'status', '--porcelain', '--untracked-files=all')
    identity = {
        'digest': digest,
        'sourceRevision': revision,
        'sourceKind': 'pinned-release' if pin else 'working-tree',
        'sourceDirty': bool(status) if status is not None else None,
        'buildMode': mode,
        'dependencyLockSha256': hashlib.sha256((source / 'uv.lock').read_bytes()).hexdigest(),
    }
    (output / 'identity.json').write_text(json.dumps(identity, sort_keys=True) + '\n')
    return identity


def verify_bundle(output, *, mode, release_pin=None):
    output = Path(output)
    identity = read_object(output / 'identity.json', 'Processor identity')
    if not hex_string(identity.get('digest'), 64) or not hex_string(identity.get('dependencyLockSha256'), 64):
        raise ValueError('Processor identity requires SHA-256 strings for bundle and dependency lock digests')
    revision = identity.get('sourceRevision')
    if not hex_string(revision, 40) and not (mode == 'development' and revision == 'unversioned'):
        raise ValueError('Processor identity requires an exact source revision or unversioned development source')
    expected_kind = {'release': 'pinned-release', 'development': 'working-tree'}.get(mode)
    if expected_kind is None or identity.get('buildMode') != mode or identity.get('sourceKind') != expected_kind:
        raise ValueError('Processor source mode does not match the requested build mode')
    digest = hashlib.sha256((output / 'source.tar').read_bytes()).hexdigest()
    if identity.get('digest') != digest:
        raise ValueError('Processor bundle digest does not match its identity')
    if mode == 'release':
        pin = read_release_pin(release_pin)
        if identity.get('sourceDirty') is not False or identity.get('sourceRevision') != pin['sourceRevision']:
            raise ValueError('Processor revision does not match the clean release pin')
        if digest != pin['bundleSha256']:
            raise ValueError('Processor bundle digest does not match the release pin')
    return identity


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--source')
    action.add_argument('--verify', action='store_true', help='Verify an existing build context')
    parser.add_argument('--output', required=True)
    parser.add_argument('--mode', choices=('release', 'development'), default='release')
    parser.add_argument('--release-pin', default=str(Path(__file__).with_name('preprocessing-release.json')))
    args = parser.parse_args()
    try:
        if args.verify:
            identity = verify_bundle(args.output, mode=args.mode, release_pin=args.release_pin)
        else:
            identity = bundle(args.source, args.output, mode=args.mode, release_pin=args.release_pin)
        print(json.dumps(identity))
    except (ValueError, OSError) as error:
        parser.exit(1, f'{error}\n')
