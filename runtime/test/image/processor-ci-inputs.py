#!/usr/bin/env python3
"""Download verified production bytes and matching tests through authenticated gh."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from urllib.parse import quote


def require(value):
    if not value:
        raise ValueError('invalid_inputs')


def gh(args, destination):
    with destination.open('wb') as handle:
        subprocess.run(['gh', *args], stdin=subprocess.DEVNULL, stdout=handle,
                       stderr=subprocess.DEVNULL, check=True, timeout=180)
    require(destination.stat().st_size <= 64 * 1024 * 1024)


def member_bytes(archive, member):
    require(member.isfile() and 0 <= member.size <= 4 * 1024 * 1024)
    return archive.extractfile(member).read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--test-output', required=True)
    args = parser.parse_args()
    repo = os.environ.get('PREPROCESSING_BUNDLE_REPO', '')
    tag = os.environ.get('PREPROCESSING_BUNDLE_TAG', '')
    expected = os.environ.get('PREPROCESSING_BUNDLE_DIGEST', '')
    require(os.environ.get('GH_TOKEN') and re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo))
    require(tag and re.fullmatch(r'[a-f0-9]{64}', expected))
    output, tests = Path(args.output), Path(args.test_output)
    output.mkdir(parents=True, exist_ok=True)
    (tests / 'tests/preprocessing').mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='processor-ci-inputs-') as temporary:
        root = Path(temporary)
        # GitHub resolves annotated and lightweight tags to a commit, then the archive
        # request uses only that SHA. An asset cannot silently select different tests.
        gh(['api', f'repos/{repo}/commits/{quote(tag, safe="")}'], root / 'commit.json')
        commit = json.loads((root / 'commit.json').read_bytes())['sha']
        require(re.fullmatch(r'[a-f0-9]{40}', commit))
        gh(['release', 'download', tag, '--repo', repo, '--pattern', 'source.tar', '--dir', str(output)], root / 'download.log')
        bundle = output / 'source.tar'
        require(bundle.stat().st_size <= 64 * 1024 * 1024)
        digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
        require(digest == expected)
        gh(['api', f'repos/{repo}/tarball/{commit}'], root / 'commit.tar.gz')
        with tarfile.open(root / 'commit.tar.gz') as archive:
            members = {}
            for member in archive.getmembers():
                components = member.name.split('/', 1)
                if len(components) == 2:
                    require(components[1] not in members)
                    members[components[1]] = member
            with tarfile.open(bundle) as production:
                names = set()
                for member in production.getmembers():
                    require(member.name not in names)
                    names.add(member.name)
                    if member.name == 'build-requirements.txt':
                        continue  # Runtime-owned build tooling, absent from processor repository.
                    require(member.name in members)
                    require(member_bytes(production, member) == member_bytes(archive, members[member.name]))
                require({'uv.lock', 'pyproject.toml', 'preprocessing/__init__.py', 'deployment/standalone/supervise.py'} <= names)
                require({name for name in members if name.startswith('preprocessing/') and name.endswith('.py')}
                        == {name for name in names if name.startswith('preprocessing/') and name.endswith('.py')})
                lock = member_bytes(production, production.getmember('uv.lock'))
            name = 'tests/preprocessing/test_engine_http_real.py'
            raw = member_bytes(archive, members[name])
            (tests / name).write_bytes(raw)
        identity = {'digest': digest, 'sourceKind': 'published-bundle', 'sourceRevision': commit,
                    'dependencyLockSha256': hashlib.sha256(lock).hexdigest()}
        (output / 'identity.json').write_text(json.dumps(identity) + '\n')
        provenance = {'sourceRevision': commit, 'testSourceSha256': hashlib.sha256(raw).hexdigest()}
        (tests / 'qualification-provenance.json').write_text(json.dumps(provenance) + '\n')
        print(json.dumps({'bundleDigest': digest, **provenance}))


if __name__ == '__main__':
    try:
        main()
    except Exception:  # noqa: BLE001 - boundary must not print private gh/config diagnostics
        print('Pinned processor inputs failed validation; check asset digest, tag/commit correspondence and read-only repository access.', file=sys.stderr)
        sys.exit(1)
