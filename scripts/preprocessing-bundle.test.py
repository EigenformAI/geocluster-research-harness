#!/usr/bin/env python3
"""Legal files survive processor source capture without admitting other files."""
import importlib.util
import hashlib
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    'preprocessing_bundle', Path(__file__).with_name('preprocessing-bundle.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BundleFixture(unittest.TestCase):
    def setUp(self):
        preferred = Path('/tmp/opencode')
        self.temporary = tempfile.TemporaryDirectory(
            prefix='preprocessing-bundle-', dir=preferred if preferred.is_dir() else None)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        for name in ('pyproject.toml', 'uv.lock', 'preprocessing/__init__.py',
                     'deployment/standalone/supervise.py'):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('# fixture\n')


class BundleLegalFilesTest(BundleFixture):
    def test_preserves_legal_bytes_and_binds_them_to_identity(self):
        legal = {
            'LICENSE': b'Original license\n',
            'LICENSE.txt': b'Additional license\n',
            'NOTICE': b'Original attribution\n',
            'NOTICE.txt': b'Additional attribution\n',
            'ThirdPartyNotices.txt': b'Upstream dependency terms\n',
        }
        for name, raw in legal.items():
            (self.source / name).write_bytes(raw)
        (self.source / '.env').write_text('DO_NOT_BUNDLE=fixture\n')
        output = self.root / 'bundle'
        first = module.bundle(self.source, output, mode='development')
        with tarfile.open(output / 'source.tar') as archive:
            for name, raw in legal.items():
                self.assertEqual(archive.extractfile(name).read(), raw)
            self.assertNotIn('.env', archive.getnames())
        (self.source / 'NOTICE').write_bytes(b'Updated attribution\n')
        second = module.bundle(self.source, output, mode='development')
        self.assertNotEqual(first['digest'], second['digest'])

    def test_development_source_without_legal_files_can_be_captured(self):
        output = self.root / 'bundle'
        module.bundle(self.source, output, mode='development')
        with tarfile.open(output / 'source.tar') as archive:
            self.assertEqual(archive.extractfile('preprocessing/__init__.py').read(),
                             b'# fixture\n')

    def test_rejects_legal_file_symlinks_including_dangling_links(self):
        for target in ('uv.lock', 'missing'):
            with self.subTest(target=target):
                link = self.source / 'LICENSE'
                link.symlink_to(target)
                try:
                    with self.assertRaisesRegex(ValueError, 'regular files'):
                        module.bundle(self.source, self.root / 'bundle', mode='development')
                finally:
                    link.unlink()

    def test_rejects_directory_in_place_of_legal_file(self):
        (self.source / 'NOTICE').mkdir()
        with self.assertRaisesRegex(ValueError, 'regular files'):
            module.bundle(self.source, self.root / 'bundle', mode='development')


class BundleReleaseTest(BundleFixture):
    def setUp(self):
        super().setUp()
        self.git('init', '-q')
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
                 'commit', '-qm', 'Fixture processor')
        self.revision = self.git('rev-parse', 'HEAD').strip()
        captured = module.bundle(self.source, self.root / 'development', mode='development')
        self.pin = self.root / 'release.json'
        self.pin.write_text(json.dumps({
            'sourceRevision': self.revision,
            'bundleSha256': captured['digest'],
        }))

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.source), *args], text=True)

    def release(self):
        return module.bundle(self.source, self.root / 'release', mode='release',
                             release_pin=self.pin)

    def test_release_requires_exact_revision_and_bundle_bytes(self):
        identity = self.release()
        self.assertEqual(identity['sourceKind'], 'pinned-release')
        self.assertEqual(identity['sourceRevision'], self.revision)
        self.assertEqual(identity['digest'], json.loads(self.pin.read_text())['bundleSha256'])
        pin = json.loads(self.pin.read_text())
        pin['bundleSha256'] = '0' * 64
        self.pin.write_text(json.dumps(pin))
        with self.assertRaisesRegex(ValueError, 'digest does not match'):
            self.release()

    def test_dirty_and_untracked_sources_require_explicit_development_mode(self):
        for name in ('preprocessing/__init__.py', 'new-local-note.txt'):
            with self.subTest(name=name):
                path = self.source / name
                original = path.read_bytes() if path.exists() else None
                path.write_text('local work\n')
                try:
                    with self.assertRaisesRegex(ValueError, 'clean processor checkout'):
                        self.release()
                    identity = module.bundle(self.source, self.root / 'development',
                                             mode='development')
                    self.assertEqual(identity['sourceKind'], 'working-tree')
                    self.assertEqual(identity['sourceDirty'], True)
                finally:
                    if original is None:
                        path.unlink()
                    else:
                        path.write_bytes(original)

    def test_changed_revision_cannot_claim_release_even_with_matching_bytes(self):
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
                 'commit', '--allow-empty', '-qm', 'Different revision')
        with self.assertRaisesRegex(ValueError, 'revision does not match'):
            self.release()

    def test_unpinned_or_invalid_modes_never_claim_release(self):
        with self.assertRaisesRegex(ValueError, 'release pin'):
            module.bundle(self.source, self.root / 'release', mode='release')
        with self.assertRaisesRegex(ValueError, 'Unknown build mode'):
            module.bundle(self.source, self.root / 'release', mode='production')

    def test_library_default_requires_a_release_pin(self):
        with self.assertRaisesRegex(ValueError, 'release pin'):
            module.bundle(self.source, self.root / 'default')
        identity = module.bundle(self.source, self.root / 'default', release_pin=self.pin)
        self.assertEqual(identity['sourceKind'], 'pinned-release')

    def test_build_context_verification_rejects_development_as_release_and_tampering(self):
        output = self.root / 'release'
        self.release()
        verified = module.verify_bundle(output, mode='release', release_pin=self.pin)
        self.assertEqual(verified['sourceRevision'], self.revision)
        module.bundle(self.source, output, mode='development')
        with self.assertRaisesRegex(ValueError, 'source mode'):
            module.verify_bundle(output, mode='release', release_pin=self.pin)
        module.verify_bundle(output, mode='development')
        with (output / 'source.tar').open('ab') as archive:
            archive.write(b'changed bytes')
        with self.assertRaisesRegex(ValueError, 'bundle digest'):
            module.verify_bundle(output, mode='development')

    def test_forged_release_identity_cannot_bypass_the_pinned_bytes(self):
        output = self.root / 'release'
        identity = self.release()
        with (output / 'source.tar').open('ab') as archive:
            archive.write(b'arbitrary processor bytes')
        identity['digest'] = hashlib.sha256((output / 'source.tar').read_bytes()).hexdigest()
        (output / 'identity.json').write_text(json.dumps(identity))
        with self.assertRaisesRegex(ValueError, 'digest does not match the release pin'):
            module.verify_bundle(output, mode='release', release_pin=self.pin)

    def assert_concise_cli_failure(self, *args):
        result = subprocess.run(['python3', str(Path(__file__).with_name('preprocessing-bundle.py')),
                                 *args], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('Traceback', result.stderr)
        self.assertEqual(len(result.stderr.splitlines()), 1, result.stderr)

    def test_corrupt_pin_metadata_fails_concisely(self):
        valid = json.loads(self.pin.read_text())
        invalid = [None, [], 'not an object',
                   {**valid, 'sourceRevision': None},
                   {**valid, 'sourceRevision': []},
                   {**valid, 'bundleSha256': 123}]
        for value in invalid:
            with self.subTest(value=value):
                self.pin.write_text(json.dumps(value))
                self.assert_concise_cli_failure('--source', str(self.source),
                                                '--output', str(self.root / 'corrupt'),
                                                '--release-pin', str(self.pin))

    def test_corrupt_identity_metadata_fails_concisely_in_development_too(self):
        output = self.root / 'development'
        valid = json.loads((output / 'identity.json').read_text())
        invalid = [None, [], 'not an object',
                   {**valid, 'sourceRevision': None},
                   {**valid, 'sourceRevision': []},
                   {**valid, 'digest': 123},
                   {**valid, 'dependencyLockSha256': None}]
        for value in invalid:
            with self.subTest(value=value):
                (output / 'identity.json').write_text(json.dumps(value))
                self.assert_concise_cli_failure('--verify', '--output', str(output),
                                                '--mode', 'development')


class BuildScriptTest(BundleFixture):
    def run_build(self, mode=None):
        binaries = self.root / 'bin'
        binaries.mkdir(exist_ok=True)
        docker = binaries / 'docker'
        docker.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_CALLS"\n'
                          'if [ "$1" = images ]; then echo 12MB; fi\n')
        docker.chmod(0o755)
        env = {key: value for key, value in os.environ.items()
               if not key.startswith('PREPROCESSING_') and key not in ('IMAGE_NAME', 'IMAGE_TAG', 'REGISTRY', 'NO_CACHE')}
        env.update(PATH=f'{binaries}:{os.environ["PATH"]}',
                   DOCKER_CALLS=str(self.root / 'docker-calls'),
                   PREPROCESSING_SOURCE_DIR=str(self.source),
                   PREPROCESSING_BUILD_CONTEXT=str(self.root / 'build context'))
        if mode:
            env['PREPROCESSING_BUILD_MODE'] = mode
        return subprocess.run(['bash', str(Path(__file__).with_name('build-docker.sh'))],
                              capture_output=True, text=True, env=env)

    def test_default_build_rejects_unreviewed_source_before_docker(self):
        result = self.run_build()
        self.assertEqual(result.returncode, 1)
        self.assertIn('clean processor checkout', result.stderr)
        self.assertFalse((self.root / 'docker-calls').exists())

    def test_explicit_development_build_keeps_local_bytes_and_does_not_publish(self):
        (self.source / 'preprocessing/__init__.py').write_text('local extraction change\n')
        result = self.run_build('development')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('not a verified release source', result.stdout)
        calls = (self.root / 'docker-calls').read_text()
        self.assertIn('PREPROCESSING_BUILD_MODE=development', calls)
        self.assertIn('geocluster-runtime:local', calls)
        self.assertNotIn('push', calls)
        identity = json.loads((self.root / 'build context/identity.json').read_text())
        self.assertEqual(identity['sourceKind'], 'working-tree')
        with tarfile.open(self.root / 'build context/source.tar') as archive:
            self.assertEqual(archive.extractfile('preprocessing/__init__.py').read(),
                             b'local extraction change\n')


if __name__ == '__main__':
    unittest.main()
