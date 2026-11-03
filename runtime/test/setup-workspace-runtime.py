#!/usr/bin/env python3
"""Root fixtures for lifecycle authority, publication, and restart recovery."""
import io
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME))
import setup_transfer as transfer

HELPER = RUNTIME / 'setup-workspace.py'
LOCK = RUNTIME / 'lifecycle-lock.py'


class ErrorOutputTests(unittest.TestCase):
    def test_surrogate_argument_remains_a_valid_json_error(self):
        rejected = '--filename-' + os.fsdecode(b'\xff')
        result = subprocess.run([sys.executable, '-B', str(HELPER), rejected],
                                capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(result.stdout, b'')
        response = json.loads(result.stderr)
        self.assertEqual(response['error'], 'invalid_arguments')
        self.assertIn(rejected, response['message'])
        self.assertTrue(result.stderr.isascii())


@unittest.skipUnless(os.geteuid() == 0, 'root fixture requires sudo -n or a root container')
class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='setup-workspace-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.workspace = self.base / 'workspace'
        self.workspace.mkdir(mode=0o755)

    def run_helper(self, *arguments, data=None, locked=True, program=None):
        command = [sys.executable, '-B', str(HELPER), '--workspace', str(self.workspace), *arguments]
        if program is not None:
            command = [sys.executable, '-B', '-c', program, str(HELPER), '--workspace', str(self.workspace), *arguments]
        if locked:
            command = [sys.executable, '-B', str(LOCK), str(self.workspace), 'native', *command]
        return subprocess.run(command, input=data, capture_output=True, timeout=20)

    def success(self, *arguments, **kwargs):
        result = self.run_helper(*arguments, **kwargs)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        return json.loads(result.stdout)

    def failure(self, code, *arguments, **kwargs):
        result = self.run_helper(*arguments, **kwargs)
        self.assertEqual(result.returncode, 2, result.stderr.decode())
        self.assertEqual(result.stdout, b'')
        response = json.loads(result.stderr)
        self.assertEqual(response['error'], code, response)
        return response

    def source_archive(self, *, private=False):
        source = self.base / 'source'
        source.mkdir(mode=0o755)
        (source / 'folder').mkdir(mode=0o755)
        (source / 'folder/input').write_bytes(b'approved personal bytes\x00\xff')
        (source / 'folder/input').chmod(0o4751 if private else 0o4750)
        if private:
            source.chmod(0o700)
            (source / 'secret').write_text('private')
            (source / 'secret').chmod(0o600)
        manifest = transfer.capture_source(source)
        with tempfile.TemporaryFile() as archive:
            length = transfer.build_archive(source, manifest, archive)
            archive.seek(0)
            body = archive.read()
        header = {'project': 'default', 'destination': 'personal', 'allowRestricted': private,
                  'manifestHash': transfer.canonical_hash(manifest), 'archiveLength': length, 'expect': 'absent'}
        return source, manifest, header, body

    def frame(self, header, body, raw=None):
        encoded = transfer.canonical_bytes(header) if raw is None else raw
        return struct.pack('>I', len(encoded)) + encoded + body

    def test_capabilities_and_read_only_inspection_create_nothing(self):
        result = subprocess.run([sys.executable, '-B', str(HELPER), '--capabilities'], capture_output=True)
        self.assertEqual(json.loads(result.stdout), {'protocol': 1, 'initialize': True, 'import': True, 'export': True, 'bundles': ['wattle-creek/v1']})
        before = list(self.workspace.iterdir())
        result = self.success('inspect', '--project', 'default', locked=False)
        self.assertFalse(result['exists'])
        self.assertEqual(result['children'], [])
        self.assertEqual(list(self.workspace.iterdir()), before)

    def test_creation_native_permissions_and_expectation_revalidation(self):
        result = self.success('prepare', '--project', 'default', '--expect', 'absent')
        self.assertEqual((result['state'], result['created']), ('verified', True))
        info = (self.workspace / 'default').stat()
        self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (999, 999, 0o2775))
        self.failure('project_exists', 'prepare', '--project', 'default', '--expect', 'absent')
        self.failure('project_missing', 'prepare', '--project', 'missing', '--expect', 'existing')
        (self.workspace / 'default').chmod(0o700)
        self.failure('unsafe_project', 'prepare', '--project', 'default', '--expect', 'existing')
        self.assertEqual(stat.S_IMODE((self.workspace / 'default').stat().st_mode), 0o700)

    def test_descriptor_nine_requires_this_locked_workspace(self):
        self.failure('lock_required', 'prepare', '--project', 'default', '--expect', 'absent', locked=False)
        self.success('prepare', '--project', 'default', '--expect', 'absent')
        program = "import os,runpy,sys; sys.path.insert(0,os.path.dirname(sys.argv[1])); fd=os.open(sys.argv[2]+'/.runtime/owner.lock',os.O_RDWR); os.dup2(fd,9); helper,root=sys.argv[1:]; sys.argv=[helper,'--workspace',root,'receipt','--operation','00000000-0000-4000-8000-000000000000']; runpy.run_path(helper,run_name='__main__')"
        forged = subprocess.run([sys.executable, '-B', '-c', program, str(HELPER), str(self.workspace)], capture_output=True)
        self.assertEqual(forged.returncode, 2, forged.stderr)
        self.assertEqual(json.loads(forged.stderr)['error'], 'lock_required')

    def test_samples_verify_image_inventory_and_replay_without_recopying(self):
        result = self.success('prepare', '--project', 'default', '--expect', 'absent', '--samples')
        sample = self.workspace / 'default/wattle-creek'
        before = sample.stat().st_ino
        self.assertEqual(result['state'], 'verified')
        self.assertIn('WC141', (sample / 'drilling/assays.csv').read_text())
        replay = self.success('prepare', '--project', 'default', '--expect', 'absent', '--samples')
        self.assertEqual(replay['operation'], result['operation'])
        self.assertTrue(replay['reused'])
        self.assertEqual(sample.stat().st_ino, before)
        inspection = self.success('inspect', '--project', 'default', locked=False)
        self.assertEqual(inspection['samples'][0]['outcome'], 'unchanged')
        setup = self.workspace / '.runtime/setup'
        for directory in (setup, setup / 'staging', setup / 'receipts', setup / 'staging' / result['operation']):
            info = directory.stat()
            self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (0, 0, 0o700))
        receipt = setup / 'receipts' / (result['operation'] + '.json')
        self.assertEqual(stat.S_IMODE(receipt.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((sample / 'drilling').stat().st_mode), 0o2770)
        self.assertEqual(stat.S_IMODE((sample / 'drilling/assays.csv').stat().st_mode), 0o660)

    def test_image_samples_are_checked_against_provenance_before_copy(self):
        spec = importlib.util.spec_from_file_location('setup_fixture', HELPER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        bundle = self.base / 'bundle'
        shutil.copytree(module.BUNDLE_PATH, bundle)
        module.BUNDLE_PATH = bundle
        (bundle / 'drilling/assays.csv').write_text('not the bundled bytes')
        with self.assertRaises(transfer.TransferError) as raised:
            module.verify_bundle()
        self.assertEqual(raised.exception.code, 'invalid_bundle')

    def test_native_profile_and_protected_permissions_are_not_repaired(self):
        self.success('prepare', '--project', 'default', '--expect', 'absent')
        private = self.workspace / '.runtime'
        (private / 'profile').write_text('managed\n')
        self.failure('profile_mismatch', 'inspect', '--project', 'default', locked=False)
        (private / 'profile').write_text('native\n')
        (private / 'setup').chmod(0o750)
        self.failure('unsafe_workspace', 'inspect', '--project', 'default', locked=False)
        self.assertEqual(stat.S_IMODE((private / 'setup').stat().st_mode), 0o750)

    def test_private_workspace_links_keep_generic_errors_without_import_advice(self):
        self.success('prepare', '--project', 'default', '--expect', 'absent')
        private = self.workspace / '.runtime'
        for name, directory in (('.runtime', True), ('profile', False), ('owner.lock', False)):
            with self.subTest(name=name):
                item = private if directory else private / name
                saved = item.with_name(item.name + '-saved')
                item.rename(saved)
                item.symlink_to(saved, target_is_directory=directory)
                try:
                    arguments = ('receipt', '--operation', '00000000-0000-4000-8000-000000000000') if name == 'owner.lock' else ('inspect', '--project', 'default')
                    response = self.failure('unsafe_path', *arguments, locked=False)
                    self.assertEqual(response['message'], 'Expected an ordinary ' + ('directory' if directory else 'file'))
                    self.assertNotIn('hint', response)
                    self.assertNotIn('path_scope', response)
                    self.assertNotIn('import', response['message'])
                finally:
                    item.unlink()
                    saved.rename(item)

    def test_edited_and_deleted_samples_are_never_restored(self):
        result = self.success('prepare', '--project', 'default', '--expect', 'absent', '--samples')
        sample = self.workspace / 'default/wattle-creek'
        (sample / 'drilling/assays.csv').write_text('user edits')
        self.failure('unverified_copy', 'prepare', '--project', 'default', '--expect', 'existing', '--samples')
        self.assertEqual((sample / 'drilling/assays.csv').read_text(), 'user edits')
        self.assertEqual(self.success('receipt', '--operation', result['operation'])['outcome'], 'modified')
        shutil.rmtree(sample)
        self.failure('unverified_copy', 'prepare', '--project', 'default', '--expect', 'existing', '--samples')
        self.assertFalse(sample.exists())
        self.assertEqual(self.success('receipt', '--operation', result['operation'])['outcome'], 'deleted')
        empty = self.success('prepare', '--project', 'default', '--expect', 'existing')
        self.assertEqual(empty['state'], 'verified')
        self.assertFalse(sample.exists())
        fresh = self.success('prepare', '--project', 'default', '--expect', 'existing', '--samples', '--destination', 'wattle-creek-2')
        self.assertEqual(fresh['destination'], 'wattle-creek-2')

    def test_import_restricted_opt_in_ownership_modes_and_export_round_trip(self):
        source, manifest, header, body = self.source_archive(private=True)
        header['allowRestricted'] = False
        self.failure('restricted_source', 'import', data=self.frame(header, body))
        self.assertFalse((self.workspace / 'default/personal').exists())
        header.update(allowRestricted=True, expect='existing')
        result = self.success('import', data=self.frame(header, body))
        copied = self.workspace / 'default/personal'
        info = (copied / 'folder/input').stat()
        self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (999, 999, 0o770))
        self.assertEqual(stat.S_IMODE((copied / 'secret').stat().st_mode), 0o660)
        self.assertEqual((source / 'secret').stat().st_mode & 0o7777, 0o600)
        self.failure('destination_exists', 'import', data=self.frame(header, body))
        exported = self.run_helper('export', '--project', 'default', '--path', 'personal')
        self.assertEqual(exported.returncode, 0, exported.stderr)
        self.assertEqual(exported.stderr, b'')
        transfer.safe_extract(io.BytesIO(exported.stdout), str(self.base), 'export')
        self.assertEqual((self.base / 'export/folder/input').read_bytes(), (source / 'folder/input').read_bytes())
        self.assertEqual(self.success('receipt', '--operation', result['operation'])['outcome'], 'unchanged')

    def test_host_export_uses_callers_group_not_destination_setgid(self):
        _, _, _, body = self.source_archive()
        output = self.base / 'output'
        output.mkdir()
        os.chown(output, 0, 999)
        output.chmod(0o2770)
        transfer.safe_extract(io.BytesIO(body), str(output), 'copy')
        for path in (output / 'copy', output / 'copy/folder', output / 'copy/folder/input'):
            info = path.stat()
            self.assertEqual((info.st_uid, info.st_gid), (os.geteuid(), os.getegid()))

    def test_malformed_frames_do_not_publish(self):
        _, _, header, body = self.source_archive()
        variants = [b'', b'\0\0\0\0', struct.pack('>I', 8193), self.frame(header, body[:-1]),
                    self.frame(header, body) + b'x', self.frame(header, body, raw=b'[]'),
                    self.frame(header, body, raw=b'{"project":"default","project":"other"}')]
        for field, value in [('extra', True), ('allowRestricted', 'yes'), ('archiveLength', True),
                             ('expect', 'anything'), ('manifestHash', 'f' * 63), ('project', '../outside'),
                             ('destination', '.runtime')]:
            changed = dict(header, **{field: value})
            variants.append(self.frame(changed, body))
        for data in variants:
            with self.subTest(data=data[:70]):
                result = self.run_helper('import', data=data)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(result.stdout, b'')
                self.assertIn('error', json.loads(result.stderr))
                self.assertFalse((self.workspace / 'default/personal').exists())

    def test_archive_mismatch_and_valid_manifest_hostile_members_are_rejected(self):
        _, manifest, header, body = self.source_archive()
        header['manifestHash'] = '0' * 64
        self.failure('manifest_mismatch', 'import', data=self.frame(header, body))
        header.update(manifestHash=transfer.canonical_hash(manifest), expect='existing')
        # A valid approved manifest followed by a forbidden member must not be
        # trusted just because the first manifest and its hash were valid.
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE):
            out = io.BytesIO()
            with tarfile.open(fileobj=out, mode='w', format=tarfile.USTAR_FORMAT) as tar:
                raw = transfer.canonical_bytes(manifest)
                item = tarfile.TarInfo(transfer.MANIFEST_NAME)
                item.mode, item.size = 0o600, len(raw)
                tar.addfile(item, io.BytesIO(raw))
                for entry in manifest['entries']:
                    item = tarfile.TarInfo(entry['path'])
                    item.mode, item.size = entry['mode'], entry['size']
                    item.type = tarfile.DIRTYPE if entry['type'] == 'directory' else kind
                    item.linkname = '/etc/passwd' if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) and entry['type'] == 'file' else ''
                    tar.addfile(item, io.BytesIO(b'x' * item.size))
            hostile = out.getvalue()
            header['archiveLength'] = len(hostile)
            self.failure('invalid_archive', 'import', data=self.frame(header, hostile))
            self.assertFalse((self.workspace / 'default/personal').exists())

    def interrupted_samples(self, state):
        patch = {
            'staged': "m.Workspace.publish=lambda *args: os._exit(71)",
            'uncertain': "original=m.Workspace.save_receipt\ndef save(self,record):\n if record['state']=='published': os._exit(72)\n return original(self,record)\nm.Workspace.save_receipt=save",
            'published': "original=m.Workspace.save_receipt\ndef save(self,record):\n if record['state']=='verified' and record['kind']=='samples': os._exit(73)\n return original(self,record)\nm.Workspace.save_receipt=save",
        }[state]
        program = "import importlib.util,os,sys\nsys.path.insert(0,os.path.dirname(sys.argv[1]))\ns=importlib.util.spec_from_file_location('setup',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n" + patch + "\nsys.argv=sys.argv[1:];m.main()"
        result = self.run_helper('prepare', '--project', 'default', '--expect', 'absent', '--samples', program=program)
        self.assertIn(result.returncode, (71, 72, 73), result.stderr)
        records = list((self.workspace / '.runtime/setup/receipts').glob('*.json'))
        self.assertEqual(len(records), 1)
        return json.loads(records[0].read_text())

    def test_staged_receipt_recovers_without_source_or_duplicate_copy(self):
        record = self.interrupted_samples('staged')
        self.assertEqual(record['state'], 'staged')
        self.assertFalse((self.workspace / 'default/wattle-creek').exists())
        result = self.success('prepare', '--project', 'default', '--expect', 'absent', '--resume', record['operation'])
        self.assertEqual((result['state'], result['outcome']), ('verified', 'unchanged'))
        self.assertTrue(result['reused'])
        self.assertEqual(result['operation'], record['operation'])

    def test_receipts_survive_new_container_mount_identifiers(self):
        record = self.interrupted_samples('staged')
        # A new Docker helper has a new mount namespace. mnt_id is essential for
        # live traversal checks, but its numeric value is not a retained identity.
        program = "import importlib.util,os,sys\nsys.path.insert(0,os.path.dirname(sys.argv[1]))\ns=importlib.util.spec_from_file_location('setup',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\noriginal=m.transfer.mount_id\nm.transfer.mount_id=lambda fd: original(fd)+1000000\nsys.argv=sys.argv[1:]\nresult=m.main()\nprint(m.transfer.canonical_bytes(result).decode())"
        result = self.success('prepare', '--project', 'default', '--expect', 'absent', '--resume', record['operation'], program=program)
        self.assertEqual(result['outcome'], 'unchanged')
        self.assertEqual(result['state'], 'verified')

    def test_publication_without_verified_receipt_is_never_promoted(self):
        for state in ('uncertain', 'published'):
            with self.subTest(state=state):
                if (self.workspace / 'default').exists():
                    shutil.rmtree(self.workspace)
                    self.workspace.mkdir(mode=0o755)
                record = self.interrupted_samples(state)
                sample = self.workspace / 'default/wattle-creek'
                inode = sample.stat().st_ino
                self.assertEqual(self.success('receipt', '--operation', record['operation'])['outcome'], 'unverified')
                self.failure('unverified_copy', 'prepare', '--project', 'default', '--expect', 'existing', '--resume', record['operation'])
                self.assertEqual(sample.stat().st_ino, inode)
                if state == 'published':
                    shutil.rmtree(sample)
                    self.failure('unverified_copy', 'prepare', '--project', 'default', '--expect', 'existing', '--resume', record['operation'])
                    self.assertFalse(sample.exists())

    def test_untrusted_receipt_and_stage_are_not_recovery_authority(self):
        record = self.interrupted_samples('staged')
        stage = self.workspace / '.runtime/setup/staging' / record['operation']
        (stage / 'tree/drilling/assays.csv').write_text('tampered stage')
        self.failure('manifest_mismatch', 'prepare', '--project', 'default', '--expect', 'existing', '--resume', record['operation'])
        self.assertFalse((self.workspace / 'default/wattle-creek').exists())
        receipt = self.workspace / '.runtime/setup/receipts' / (record['operation'] + '.json')
        os.chown(receipt, 999, 999)
        self.failure('unsafe_workspace', 'receipt', '--operation', record['operation'])
        self.assertTrue(stage.exists())

    def test_private_exports_symlinks_hardlinks_and_special_objects_fail_closed(self):
        self.success('prepare', '--project', 'default', '--expect', 'absent')
        project = self.workspace / 'default'
        ordinary = project / 'runs/session-one/results'
        ordinary.mkdir(parents=True)
        (ordinary / 'answer.txt').write_text('result')
        paths = self.success('list', '--project', 'default', '--offset', '1', '--limit', '1')
        self.assertEqual(paths['paths'], ['runs/session-one'])
        self.assertEqual(paths['nextOffset'], 2)
        self.assertTrue(paths['hasMore'])
        for name in ('.runtime', 'datasets', '_orchestrator', '.env'):
            self.failure('reserved_path', 'export', '--project', 'default', '--path', name)
        link = ordinary / 'bad'
        link.symlink_to('/etc/passwd')
        response = self.failure('unsafe_path', 'export', '--project', 'default', '--path', 'runs')
        self.assertEqual(response['path'], 'session-one/results/bad')
        self.assertEqual(response['entry_type'], 'symlink')
        self.assertEqual(response['path_scope'], 'transfer_source')
        self.assertIn('separate import copy', response['hint'])
        link.unlink()
        os.link(ordinary / 'answer.txt', link)
        self.failure('unsafe_path', 'export', '--project', 'default', '--path', 'runs')
        link.unlink()
        os.mkfifo(link)
        response = self.failure('unsafe_path', 'list', '--project', 'default')
        self.assertEqual(response['path'], 'runs/session-one/results/bad')
        self.assertEqual(response['entry_type'], 'fifo')
        self.assertEqual(response['path_scope'], 'transfer_source')

    def test_same_filesystem_mount_boundary_check(self):
        root = os.open('/', transfer.DIRECTORY_FLAGS)
        try:
            with self.assertRaises(ValueError):
                transfer.open_child(root, 'proc', directory=True)
        finally:
            os.close(root)

    def test_lifecycle_contention_and_jittered_copy_replay(self):
        self.success('prepare', '--project', 'default', '--expect', 'absent')
        command = [sys.executable, '-B', str(LOCK), str(self.workspace), 'native', sys.executable, '-B',
                   '-c', "import os,random,runpy,sys,time;sys.path.insert(0,os.path.dirname(sys.argv[1]));time.sleep(random.uniform(0,.025));sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')",
                   str(HELPER), '--workspace', str(self.workspace), 'prepare', '--project', 'default', '--expect', 'existing', '--samples']
        operations = set()
        for trial in range(3):
            children = [subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(6)]
            successes = 0
            results = [(child, child.communicate(timeout=20)) for child in children]
            for child, (out, error) in results:
                if child.returncode == 0:
                    successes += 1
                    operations.add(json.loads(out)['operation'])
                else:
                    self.assertEqual(child.returncode, 2, error)
                    self.assertIn(b'already owned', error)
            self.assertGreaterEqual(successes, 1)
        self.assertEqual(len(operations), 1)
        self.assertEqual(len(list((self.workspace / '.runtime/setup/receipts').glob('*.json'))), 2)
        self.assertEqual(self.success('receipt', '--operation', operations.pop())['outcome'], 'unchanged')


if __name__ == '__main__':
    unittest.main(verbosity=2)
