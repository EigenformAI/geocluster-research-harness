#!/usr/bin/env python3
"""Capture production working-tree bytes, including uncommitted extraction changes."""
import argparse
import hashlib
import io
import json
import subprocess
import tarfile
from pathlib import Path


def bundle(source, output):
    source, output = Path(source).resolve(), Path(output)
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
        # These bytes are part of the digest README.md pins: update that digest whenever the
        # requirements file or this archive layout changes (a comment in that file counts).
        raw = Path(__file__).with_name('preprocessing-build-requirements.txt').read_bytes()
        info = tarfile.TarInfo('build-requirements.txt')
        info.size, info.mode, info.mtime = len(raw), 0o644, 0
        archive.addfile(info, io.BytesIO(raw))
    digest = hashlib.sha256((output / 'source.tar').read_bytes()).hexdigest()
    revision = subprocess.run(['git', '-C', str(source), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip() or 'unversioned'
    identity = {'digest': digest, 'sourceRevision': revision, 'sourceKind': 'working-tree', 'dependencyLockSha256': hashlib.sha256((source / 'uv.lock').read_bytes()).hexdigest()}
    (output / 'identity.json').write_text(json.dumps(identity, sort_keys=True) + '\n')
    return identity


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    print(json.dumps(bundle(args.source, args.output)))
