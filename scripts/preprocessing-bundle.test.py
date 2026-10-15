#!/usr/bin/env python3
"""Legal files survive processor source capture without admitting other files."""
import importlib.util
import tarfile
import tempfile
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    'preprocessing_bundle', Path(__file__).with_name('preprocessing-bundle.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BundleLegalFilesTest(unittest.TestCase):
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
        first = module.bundle(self.source, output)
        with tarfile.open(output / 'source.tar') as archive:
            for name, raw in legal.items():
                self.assertEqual(archive.extractfile(name).read(), raw)
            self.assertNotIn('.env', archive.getnames())
        (self.source / 'NOTICE').write_bytes(b'Updated attribution\n')
        second = module.bundle(self.source, output)
        self.assertNotEqual(first['digest'], second['digest'])

    def test_development_source_without_legal_files_can_be_captured(self):
        output = self.root / 'bundle'
        module.bundle(self.source, output)
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
                        module.bundle(self.source, self.root / 'bundle')
                finally:
                    link.unlink()

    def test_rejects_directory_in_place_of_legal_file(self):
        (self.source / 'NOTICE').mkdir()
        with self.assertRaisesRegex(ValueError, 'regular files'):
            module.bundle(self.source, self.root / 'bundle')


if __name__ == '__main__':
    unittest.main()
