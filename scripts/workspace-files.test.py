"""Host transfer user contracts, with no paid inference or daemon writes."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location('workspace_files', Path(__file__).with_name('workspace-files.py'))
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)


class TransferTests(unittest.TestCase):
    def test_command_reports_rejected_nested_entry_before_runtime_import(self):
        for kind in ('link', 'long-name'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / 'survey-data'
                nested = source / 'work' / 'tools'
                nested.mkdir(parents=True)
                if kind == 'link':
                    entry = nested / 'python3'
                    entry.symlink_to('/must-not-follow-this-target')
                else:
                    entry = nested / ('x' * 101)
                    entry.write_text('unchanged')
                docker = root / 'docker'
                log = root / 'docker-calls.jsonl'
                docker.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['TEST_DOCKER_LOG'], 'a') as stream:
    stream.write(json.dumps(args) + '\\n')
if args == ['context', 'show']:
    print('default')
elif args[:2] == ['context', 'inspect']:
    print(json.dumps('unix:///var/run/docker.sock'))
elif args[0] == 'info':
    print(json.dumps({'ID': 'fixture', 'OSType': 'linux', 'Architecture': 'amd64',
                      'ServerErrors': None, 'OperatingSystem': 'Linux', 'SecurityOptions': []}))
elif args[:2] == ['image', 'inspect']:
    print(json.dumps({'Id': 'sha256:' + 'a' * 64, 'Os': 'linux', 'Architecture': 'amd64'}))
elif args[0] == 'run' and args[-1] == '--capabilities':
    print(json.dumps({'protocol': 1, 'initialize': True, 'import': True,
                      'export': True, 'bundles': ['wattle-creek/v1']}))
else:
    raise SystemExit('unexpected Docker operation')
''')
                docker.chmod(0o700)
                result = subprocess.run([sys.executable, str(Path(files.__file__)), 'import',
                                         str(source), '--workspace-volume', 'fixture'],
                                        env={**os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH'],
                                             'TEST_DOCKER_LOG': str(log), 'DOCKER_CONTEXT': 'default', 'DOCKER_HOST': ''},
                                        text=True, capture_output=True, timeout=15)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(str(source), result.stderr)
                self.assertIn(str(entry.relative_to(source)), result.stderr)
                self.assertIn('Reason:', result.stderr)
                self.assertIn('Next step:', result.stderr)
                calls = [json.loads(line) for line in log.read_text().splitlines()]
                self.assertFalse(any('/opt/geocluster-runtime/lifecycle-lock.py' in call for call in calls))
                if kind == 'link':
                    self.assertTrue(entry.is_symlink())
                else:
                    self.assertEqual(entry.read_text(), 'unchanged')

    def test_explicit_options_never_merge_saved_storage(self):
        args = files.parser().parse_args(['import', '/source', '--image', 'custom:latest'])
        with patch.object(files, 'load_profile', side_effect=AssertionError('must not load saved settings')):
            with self.assertRaisesRegex(files.SetupError, 'cannot be mixed'):
                files.select(None, args)

    def test_explicit_storage_targets_the_native_workspace(self):
        for option, value, storage in (
            ('--workspace-volume', 'native-data', {'kind': 'volume', 'name': 'native-data'}),
            ('--workspace-root', '/native-data', {'kind': 'bind', 'path': '/native-data'}),
        ):
            with self.subTest(option=option):
                args = files.parser().parse_args(['import', '/source', option, value])
                docker = Mock()
                docker.image.return_value = {'id': 'sha256:' + 'a' * 64}
                with patch.object(files, 'load_profile', side_effect=AssertionError('must not load saved settings')):
                    self.assertEqual(files.select(docker, args), (storage, 'default', docker.image.return_value['id']))
                docker.image.assert_called_once_with('geocluster-runtime:latest')

    def test_project_selection_is_rejected_before_docker(self):
        with patch.object(files, 'Docker', side_effect=AssertionError('must not touch Docker')):
            with self.assertRaises(SystemExit) as error:
                files.main(['import', '/source', '--workspace-volume', 'native-data', '--project', 'another'])
        self.assertEqual(error.exception.code, 2)

    def test_unattended_missing_source_is_reported_before_docker(self):
        with patch.object(files.sys.stdin, 'isatty', return_value=False):
            with patch.object(files, 'Docker', side_effect=AssertionError('must not touch Docker')):
                with self.assertRaisesRegex(files.SetupError, 'needs a source'):
                    files.main(['import'])

    def test_eof_is_not_default_approval(self):
        with patch.object(files.sys.stdin, 'isatty', return_value=True), patch.object(files.sys.stdout, 'isatty', return_value=True):
            with patch('builtins.input', side_effect=EOFError):
                with self.assertRaises(files.Cancelled):
                    files.confirm('Include private files?')

    def test_free_name_does_not_merge_existing_destinations(self):
        self.assertEqual(files.fresh_name('samples', ['samples', 'samples-2']), 'samples-3')

    def test_reviewed_manifest_is_reused_not_silently_recaptured(self):
        from setup_common import import_source, prepare_import
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, 'data')
            source.mkdir(mode=0o755)
            source.chmod(0o755)
            (source / 'assays.csv').write_text('hole,value\nWC1,1\n')
            manifest, _ = prepare_import(source)
            (source / 'assays.csv').write_text('hole,value\nWC1,2\n')
            class NoTransfer:
                def operation(self, *args, **kwargs):
                    raise AssertionError('changed source must fail before sending a stream')
            with self.assertRaises(ValueError):
                import_source(NoTransfer(), {'kind': 'volume', 'name': 'remote'},
                              'sha256:' + 'a' * 64, 'default', 'data', str(source), True,
                              manifest=manifest)


if __name__ == '__main__':
    unittest.main()
