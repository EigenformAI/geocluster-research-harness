#!/usr/bin/env python3
"""Observable transfer contracts; also runnable without root."""
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import setup_transfer as transfer


class TransferTests(unittest.TestCase):
    def test_nested_unsupported_entries_have_observed_types_and_full_paths(self):
        for kind in ('file-link', 'directory-link', 'dangling-link', 'fifo', 'socket', 'hardlink'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                source = Path(root, 'source')
                (source / 'a/good').mkdir(parents=True)
                (source / 'a/good/item').write_bytes(b'ordinary')
                (source / 'z/nested').mkdir(parents=True)
                target = Path(root, 'target')
                target.mkdir()
                (target / 'file').write_bytes(b'unchanged')
                bad = source / 'z/nested/item'
                sock = None
                if kind == 'file-link':
                    bad.symlink_to(target / 'file')
                elif kind == 'directory-link':
                    bad.symlink_to(target, target_is_directory=True)
                elif kind == 'dangling-link':
                    bad.symlink_to(target / 'missing')
                elif kind == 'fifo':
                    os.mkfifo(bad)
                elif kind == 'socket':
                    sock = socket.socket(socket.AF_UNIX)
                    self.addCleanup(sock.close)
                    sock.bind(str(bad))
                else:
                    os.link(target / 'file', bad)
                before = transfer.snapshot(bad.lstat())
                # A subprocess timeout makes a blocking FIFO open a bounded failure.
                program = """import json,sys
import setup_transfer as transfer
try:
    transfer.capture_source(sys.argv[1])
except transfer.TransferError as error:
    print(json.dumps({'code': error.code, 'message': str(error), **error.details}))
else:
    raise SystemExit('unsupported source was accepted')
"""
                result = subprocess.run([sys.executable, '-c', program, str(source)],
                                        cwd=Path(transfer.__file__).parent,
                                        capture_output=True, timeout=5, check=True)
                error = json.loads(result.stdout)
                self.assertEqual(error['code'], 'unsafe_path')
                self.assertEqual(error['path'], 'z/nested/item')
                self.assertEqual(error['path_scope'], 'transfer_source')
                expected = {'file-link': 'symlink', 'directory-link': 'symlink',
                            'dangling-link': 'symlink', 'hardlink': 'file'}.get(kind, kind)
                self.assertEqual(error['entry_type'], expected)
                self.assertIn('separate import copy', error['hint'])
                if kind == 'hardlink':
                    self.assertEqual(error['message'], 'Multiple hardlinks are not supported')
                    self.assertNotIn('symbolic', error['hint'].lower())
                self.assertEqual(transfer.snapshot(bad.lstat()), before)
                self.assertEqual((target / 'file').read_bytes(), b'unchanged')
                self.assertEqual((source / 'a/good/item').read_bytes(), b'ordinary')
                if sock is not None:
                    sock.close()

    def test_archive_preflight_matches_real_encoder_and_archive_diagnostics(self):
        cases = [
            ('n' * 101, False, False),
            ('é' * 51, False, False),
            ('a' * 80 + '/' + 'b' * 80 + '/' + 'c' * 80, True, False),
            ('a' * 80 + '/' + 'b' * 80, True, True),
            ('a' * 80 + '/' + 'b' * 80, False, True),
            ('n' * 101, True, True),
            ('résumé data.txt', False, True),
            ('é' * 50, False, True),
        ]
        for path, directory, compatible in cases:
            with self.subTest(path=path, directory=directory), tempfile.TemporaryDirectory() as root:
                source = Path(root, 'source')
                source.mkdir()
                # Directory headers append '/', which changes the encoder's split.
                entry = source / path
                if directory:
                    entry.mkdir(parents=True)
                else:
                    entry.parent.mkdir(parents=True, exist_ok=True)
                    entry.write_bytes(b'payload')
                (source / 'ordinary').write_bytes(b'unchanged')
                manifest = transfer.capture_source(source)
                if compatible:
                    transfer.validate_archive_headers(manifest)
                    transfer.build_archive(source, manifest, io.BytesIO())
                else:
                    with self.assertRaises(transfer.TransferError) as preflight:
                        transfer.validate_archive_headers(manifest)
                    with self.assertRaises(transfer.TransferError) as archive:
                        transfer.build_archive(source, manifest, io.BytesIO())
                    error = preflight.exception
                    self.assertEqual(error.code, 'unsupported_path')
                    self.assertEqual(error.details['path'], path)
                    self.assertEqual(error.details['path_scope'], 'transfer_source')
                    self.assertIn('separate import copy', error.details['hint'])
                    self.assertIn('UTF-8', str(error))
                    self.assertIn('name is too long', str(error))
                    self.assertEqual(archive.exception.details, error.details)
                    self.assertEqual(str(archive.exception), str(error))
                self.assertEqual(entry.is_dir(), directory)
                if not directory:
                    self.assertEqual(entry.read_bytes(), b'payload')
                self.assertEqual((source / 'ordinary').read_bytes(), b'unchanged')

    def test_archive_preflight_uses_manifest_header_and_actual_numeric_reason(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, 'input').write_bytes(b'data')
            manifest = transfer.capture_source(root)
            # No file read is necessary to reject a valid manifest's USTAR size.
            manifest['entries'][1]['size'] = 1 << 33
            transfer.validate_manifest(manifest)
            with self.assertRaises(transfer.TransferError) as raised:
                transfer.validate_archive_headers(manifest)
            self.assertEqual(raised.exception.details['path'], 'input')
            self.assertIn('overflow', str(raised.exception))
            self.assertNotIn('name is too long', str(raised.exception))
            manifest['entries'][1]['size'] = 4
            with mock.patch.object(transfer, 'MANIFEST_NAME', 'm' * 101):
                with self.assertRaises(transfer.TransferError) as raised:
                    transfer.validate_archive_headers(manifest)
                self.assertEqual(raised.exception.details['path'], 'm' * 101)

    def test_replacement_during_open_preserves_change_and_io_errors(self):
        for replacement in ('file', 'symlink'):
            with self.subTest(replacement=replacement), tempfile.TemporaryDirectory() as root:
                source = Path(root, 'source')
                (source / 'nested').mkdir(parents=True)
                item = source / 'nested/item'
                item.write_bytes(b'original')
                outside = Path(root, 'outside')
                outside.write_bytes(b'not imported')
                original_open = os.open
                replaced = False
                def replace_before_open(name, flags, *args, **kwargs):
                    nonlocal replaced
                    if name == 'item' and not replaced:
                        replaced = True
                        item.unlink()
                        if replacement == 'file':
                            item.write_bytes(b'replacement')
                        else:
                            item.symlink_to(outside)
                    return original_open(name, flags, *args, **kwargs)
                expected = transfer.TransferError if replacement == 'file' else OSError
                with mock.patch.object(transfer.os, 'open', side_effect=replace_before_open):
                    with self.assertRaises(expected) as raised:
                        transfer.capture_source(source)
                self.assertTrue(replaced)
                if replacement == 'file':
                    self.assertEqual(raised.exception.code, 'source_changed')
                    self.assertEqual(raised.exception.details, {'path': 'nested/item'})
                else:
                    self.assertNotIsInstance(raised.exception, transfer.TransferError)
                self.assertEqual(outside.read_bytes(), b'not imported')

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
