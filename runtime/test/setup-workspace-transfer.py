#!/usr/bin/env python3
"""Observable transfer contracts; also runnable without root."""
import io
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import setup_transfer as transfer


class TransferTests(unittest.TestCase):
    def test_approved_tree_round_trip_and_create_only(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root, 'source')
            source.mkdir(mode=0o700)
            (source / 'run').write_bytes(b'#!/bin/sh\necho original\n')
            (source / 'run').chmod(0o751)
            manifest = transfer.capture_source(source)
            self.assertIn('.', manifest['restricted'])
            with tempfile.TemporaryFile() as archive:
                length = transfer.build_archive(source, manifest, archive)
                self.assertEqual(length, archive.tell())
                archive.seek(0)
                transfer.safe_extract(archive, root, 'copy')
                self.assertEqual((Path(root) / 'copy/run').read_bytes(), (source / 'run').read_bytes())
                self.assertEqual((Path(root) / 'copy/run').stat().st_mode & 0o7777, 0o751)
                archive.seek(0)
                with self.assertRaises(ValueError):
                    transfer.safe_extract(archive, root, 'copy')
                self.assertEqual((Path(root) / 'copy/run').read_bytes(), (source / 'run').read_bytes())

    def test_hostile_archive_cannot_escape_or_publish(self):
        with tempfile.TemporaryDirectory() as root:
            for name, kind in [('../escape', tarfile.REGTYPE), ('/escape', tarfile.REGTYPE),
                               ('link', tarfile.SYMTYPE), ('hard', tarfile.LNKTYPE),
                               ('fifo', tarfile.FIFOTYPE), ('.runtime/secret', tarfile.REGTYPE)]:
                with self.subTest(name=name), tempfile.TemporaryFile() as archive:
                    with tarfile.open(fileobj=archive, mode='w', format=tarfile.USTAR_FORMAT) as tar:
                        item = tarfile.TarInfo(name)
                        item.type = kind
                        item.linkname = '../escape' if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ''
                        tar.addfile(item, io.BytesIO())
                    archive.seek(0)
                    with self.assertRaises(ValueError):
                        transfer.safe_extract(archive, root, 'copy')
                    self.assertFalse(Path(root, 'copy').exists())

    def test_source_changes_and_unsupported_entries_fail(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root, 'source')
            source.mkdir()
            item = source / 'input'
            item.write_text('approved')
            manifest = transfer.capture_source(source)
            item.write_text('changed!')
            with tempfile.TemporaryFile() as archive, self.assertRaises(ValueError):
                transfer.build_archive(source, manifest, archive)
            item.unlink()
            item.symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):
                transfer.capture_source(source)

    def test_change_during_read_and_archive_trailing_bytes_fail(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root, 'source')
            source.mkdir()
            item = source / 'input'
            item.write_bytes(b'approved payload')
            item.chmod(0o640)
            manifest = transfer.capture_source(source)
            class ChangingOutput(io.BytesIO):
                def write(self, value):
                    if bytes(value) == b'approved payload':
                        item.chmod(0o600)
                    return super().write(value)
            with self.assertRaises(ValueError):
                transfer.build_archive(source, manifest, ChangingOutput())
            item.chmod(0o640)
            archive = io.BytesIO()
            transfer.build_archive(source, manifest, archive)
            data = archive.getvalue()
            for payload in (data + b'x', data + b'\0' * 512, data + data, data[:-1]):
                with self.subTest(length=len(payload)), self.assertRaises(ValueError):
                    transfer.safe_extract(io.BytesIO(payload), root, 'copy')
                self.assertFalse(Path(root, 'copy').exists())

    def test_symlinked_parent_and_hardlinked_sources_fail(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            (base / 'source').mkdir()
            (base / 'source/input').write_text('original')
            os.link(base / 'source/input', base / 'source/alias')
            with self.assertRaises(ValueError):
                transfer.capture_source(base / 'source')
            (base / 'source/alias').unlink()
            (base / 'linked').symlink_to(base / 'source')
            with self.assertRaises(OSError):
                transfer.capture_source(base / 'linked')

    def test_validation_rejects_reserved_names_and_aliases(self):
        for name in ['', 'datasets', '_orchestrator', '../x', '.runtime', 'a/b', 'a b']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                transfer.validate_project(name)
        for name in ['datasets', '_orchestrator', '.runtime', '.ide-state', '.gc-file-tmp', '../x', 'a/b']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                transfer.validate_destination(name)
        self.assertEqual(transfer.validate_project('demo_1-2'), 'demo_1-2')


if __name__ == '__main__':
    unittest.main(verbosity=2)
