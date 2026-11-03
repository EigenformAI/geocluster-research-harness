"""Saved launch and Docker destination contracts; no running daemon required."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent))
import setup_common as common
from setup_transfer import TransferError, capture_source


class FakeDocker(common.Docker):
    endpoint = 'unix:///var/run/docker.sock'
    server_id = 'daemon-one'
    version = '1'
    def _run(self, args, **kwargs):
        if args == ['context', 'show']:
            return b'default\n'
        if args[:2] == ['context', 'inspect']:
            return json.dumps(self.endpoint).encode()
        if args[0] == 'info':
            return json.dumps({'ID': self.server_id, 'OSType': 'linux',
                'Architecture': 'x86_64', 'ServerErrors': None,
                'OperatingSystem': 'Debian GNU/Linux', 'SecurityOptions': []}).encode()
        raise AssertionError(args)


class CommonTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_destination_change_stops_before_storage_access(self):
        docker = FakeDocker()
        original = docker.fingerprint
        docker.server_id = 'another-daemon'
        with self.assertRaisesRegex(common.SetupError, 'connection changed'):
            docker.check()
        self.assertEqual(docker.fingerprint, original)

    def test_endpoint_and_context_alias_are_part_of_identity(self):
        docker = FakeDocker()
        with patch.dict(os.environ, {'DOCKER_CONTEXT': 'alias'}):
            with self.assertRaises(common.SetupError):
                docker.check()
        docker.endpoint = 'tcp://user:secret@somewhere:2376'
        with self.assertRaises(common.SetupError) as error:
            docker.check()
        self.assertNotIn('secret', str(error.exception))
        self.assertNotIn('somewhere', str(error.exception))

    def test_empty_context_does_not_hide_host_override(self):
        with patch.dict(os.environ, {'DOCKER_CONTEXT': '', 'DOCKER_HOST': 'tcp://private:2376'}):
            docker = FakeDocker()
            self.assertFalse(docker.local_host)

    def test_profiles_are_bounded_data_not_shell_and_preserve_previous(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(common, 'STATE', Path(directory)):
                profile = {'version': 2, 'image': {'reference': 'runtime:test',
                    'id': 'sha256:' + 'a' * 64, 'created': 'today'},
                    'docker': {'fingerprint': 'b' * 64, 'label': 'local Linux Docker'},
                    'storage': {'kind': 'volume', 'name': 'a-workspace'},
                    'project': 'default', 'operation': None,
                    'starter': {'kind': 'none', 'destination': None}}
                common.save_profile(profile, 'first-use guide\n')
                self.assertEqual(common.load_profile(), profile)
                with self.assertRaises(common.SetupError):
                    common.save_profile({**profile, 'project': '../escape'}, 'bad')
                self.assertEqual(common.load_profile(), profile)
                real_write = common._write
                def failed_settings(parent, name, raw):
                    if name == 'setup.json':
                        raise OSError('simulated settings write failure')
                    return real_write(parent, name, raw)
                with patch.object(common, '_write', side_effect=failed_settings):
                    with self.assertRaisesRegex(OSError, 'simulated'):
                        common.save_profile({**profile, 'storage': {'kind': 'volume', 'name': 'another'}}, 'new guide\n')
                self.assertEqual(common.load_profile(), profile)
                self.assertEqual((Path(directory) / 'next-steps.txt').read_text(), 'first-use guide\n')
                (Path(directory) / 'setup.json').write_text('{"version":1,"version":1}')
                with self.assertRaises(common.SetupError):
                    common.load_profile()

    def test_pending_excludes_source_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(common, 'STATE', Path(directory)):
                with self.assertRaises(common.SetupError):
                    common.save_pending({'version': 2, 'source': '/private/folder'})

    def test_import_scan_reports_nested_entry_and_preserves_details(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / 'a').mkdir()
            (source / 'a' / 'python3').write_text('ordinary file')
            (source / 'work' / 'venv' / 'bin').mkdir(parents=True)
            link = source / 'work' / 'venv' / 'bin' / 'python3'
            link.symlink_to(source / 'missing')
            with self.assertRaises(common.SetupError) as caught:
                common.prepare_import(source)
            error = caught.exception
            self.assertEqual(error.code, 'unsafe_path')
            self.assertEqual(error.details['path'], 'work/venv/bin/python3')
            self.assertEqual(error.details['entry_type'], 'symlink')
            self.assertEqual(error.details['source'], str(source))
            self.assertIsInstance(error.__cause__, TransferError)
            message = str(error)
            self.assertEqual(message.count('Source folder:'), 1)
            self.assertEqual(message.count(str(source)), 1)
            self.assertIn('work/venv/bin/python3', message)
            self.assertIn(str(error.__cause__), message)
            self.assertIn(error.details['hint'], message)
            self.assertTrue(link.is_symlink())
            self.assertEqual((source / 'a' / 'python3').read_text(), 'ordinary file')

    def test_import_preflight_rejects_archive_path_before_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            name = 'x' * 101
            member = source / name
            member.write_text('retain me')
            before = member.stat()
            docker = MagicMock()
            with self.assertRaises(common.SetupError) as caught:
                common.prepare_import(source)
            error = caught.exception
            self.assertEqual(error.code, 'unsupported_path')
            self.assertEqual(error.details['path'], name)
            self.assertEqual(error.details['source'], str(source))
            self.assertIn(name, str(error))
            self.assertIn('USTAR', str(error))
            self.assertIsInstance(error.__cause__, TransferError)
            with self.assertRaises(common.SetupError):
                common.import_source(docker, {}, '', 'default', 'data', source, True)
            docker.operation.assert_not_called()
            self.assertEqual(member.read_text(), 'retain me')
            self.assertEqual(member.stat().st_mode, before.st_mode)
            # A valid Unicode name remains accepted by the same preflight.
            member.rename(source / 'café.csv')
            manifest, _ = common.prepare_import(source)
            self.assertIn('café.csv', [entry['path'] for entry in manifest['entries']])

    def test_late_archive_failure_preserves_diagnostic_without_runtime_call(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            name = 'é' * 51
            (source / name).write_text('retain me')
            manifest = capture_source(source)  # Deliberately bypass import preflight.
            docker = MagicMock()
            with self.assertRaises(common.SetupError) as caught:
                common.import_source(docker, {}, '', 'default', 'data', source, True,
                                     manifest=manifest)
            error = caught.exception
            self.assertEqual(error.code, 'unsupported_path')
            self.assertEqual(error.details['path'], name)
            self.assertEqual(error.details['source'], str(source))
            self.assertIsInstance(error.__cause__, TransferError)
            self.assertIn(str(error.__cause__), str(error))
            self.assertIn(error.details['hint'], str(error))
            self.assertIn(name, str(error))
            docker.operation.assert_not_called()

    def test_transfer_paths_keep_unicode_but_escape_terminal_controls(self):
        source = '/private/café\n\x1b[2J\udcff'
        path = "work/été'\n\r\t\x1b[2J\x85\u202e\udcff"
        original = TransferError('unsafe_path', 'Symbolic links are not supported.',
                                 path=path, entry_type='symlink', hint='Use a separate copy.')
        with patch.object(common, 'capture_source', side_effect=original):
            with self.assertRaises(common.SetupError) as caught:
                common.prepare_import(source)
        error = caught.exception
        message = str(error)
        self.assertEqual(error.details['path'], path)
        self.assertEqual(error.details['source'], source)
        self.assertEqual(original.details, {'path': path, 'entry_type': 'symlink',
                                           'hint': 'Use a separate copy.'})
        self.assertIs(error.__cause__, original)
        self.assertIn('café', message)
        self.assertIn('été', message)
        for escaped in (r'\n', r'\r', r'\t', r'\x1b', r'\x85', r'\u202e', r'\udcff'):
            self.assertIn(escaped, message)
        for control in ('\r', '\t', '\x1b', '\x85', '\u202e', '\udcff'):
            self.assertNotIn(control, message)
        self.assertEqual(len(message.splitlines()), 4)

    def test_runtime_transfer_errors_share_safe_formatting_and_hide_stderr(self):
        docker = object.__new__(common.Docker)
        path = 'work/café\n\x1b[2J\udcff'
        payload = {'error': 'unsafe_path', 'message': 'Symbolic links are not supported.',
                   'path': path, 'entry_type': 'symlink', 'hint': 'Use a separate copy.',
                   'path_scope': 'transfer_source'}
        stderr = b'connection: ssh://user:secret@private-host\n' + json.dumps(payload).encode()
        result = subprocess.CompletedProcess([], 1, b'', stderr)
        with patch.object(common.subprocess, 'run', return_value=result):
            with self.assertRaises(common.SetupError) as caught:
                docker._run(['run'])
        error = caught.exception
        self.assertEqual(error.code, payload['error'])
        self.assertEqual(error.details, payload)
        message = str(error)
        self.assertIn('relative to transfer source', message)
        self.assertNotIn('Source folder:', message)
        self.assertIn('café', message)
        self.assertIn(r'\n\x1b[2J\udcff', message)
        self.assertIn(payload['message'], message)
        self.assertIn(payload['hint'], message)
        self.assertNotIn('secret', message)
        self.assertNotIn('private-host', message)

    def test_private_workspace_path_is_not_presented_as_an_import_source(self):
        docker = object.__new__(common.Docker)
        payload = {'error': 'unsafe_path', 'message': 'Expected an ordinary directory',
                   'path': '.runtime'}
        result = subprocess.CompletedProcess([], 1, b'', json.dumps(payload).encode())
        with patch.object(common.subprocess, 'run', return_value=result):
            with self.assertRaises(common.SetupError) as caught:
                docker._run(['run'])
        self.assertEqual(str(caught.exception), payload['message'])
        self.assertEqual(caught.exception.details, payload)

    def test_transfer_error_without_hint_does_not_invent_advice(self):
        original = TransferError('unsupported_path', 'Header mode cannot fit the archive.',
                                 path='été.csv', header_field='mode')
        with patch.object(common, 'capture_source', side_effect=original):
            with self.assertRaises(common.SetupError) as caught:
                common.prepare_import('/private/source')
        error = caught.exception
        self.assertEqual(error.code, original.code)
        self.assertEqual(error.details['header_field'], 'mode')
        self.assertIn(str(original), str(error))
        self.assertNotIn('Next step:', str(error))
        self.assertNotIn('Shorten', str(error))

    def test_unrelated_and_incomplete_errors_keep_original_messages(self):
        docker = object.__new__(common.Docker)
        for code, details in (('unsafe_workspace', {'path': 'elsewhere', 'hint': 'Not transfer advice.'}),
                              ('unsafe_path', {}), ('unsupported_path', {'path': 42})):
            with self.subTest(code=code, details=details):
                original = TransferError(code, 'Original diagnostic.', **details)
                with patch.object(common, 'capture_source', side_effect=original):
                    with self.assertRaises(common.SetupError) as caught:
                        common.prepare_import('/private/source')
                self.assertEqual(str(caught.exception), 'Original diagnostic.')
                self.assertEqual(caught.exception.details, {**details, 'source': '/private/source'})
                self.assertIs(caught.exception.__cause__, original)
                payload = {'error': code, 'message': 'Original diagnostic.', **details}
                result = subprocess.CompletedProcess([], 1, b'', json.dumps(payload).encode())
                with patch.object(common.subprocess, 'run', return_value=result):
                    with self.assertRaises(common.SetupError) as caught:
                        docker._run(['run'])
                self.assertEqual(str(caught.exception), 'Original diagnostic.')
                self.assertEqual(caught.exception.details, payload)
        result = subprocess.CompletedProcess([], 1, b'', b'ssh://user:secret@private-host')
        with patch.object(common.subprocess, 'run', return_value=result):
            with self.assertRaises(common.SetupError) as caught:
                docker._run(['run'])
        self.assertEqual(caught.exception.code, 'docker_failed')
        self.assertNotIn('secret', str(caught.exception))
        self.assertNotIn('private-host', str(caught.exception))

    def test_pending_uses_six_stages_and_only_the_fixed_workspace(self):
        for stage in range(1, 7):
            common.validate_profile({'version': 2, 'stage': stage, 'project': 'default'}, True)
        common.validate_profile({'version': 2, 'stage': 1}, True)
        common.validate_profile({'version': 2, 'stage': 1, 'project': None}, True)
        for value in ({'version': 2, 'stage': 7}, {'version': 2, 'project': 'Drilling_2026'}):
            with self.assertRaises(common.SetupError):
                common.validate_profile(value, True)

    def test_old_settings_are_rejected_without_docker_or_file_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory, '.geocluster')
            state.mkdir(mode=0o700)
            workspace = Path(directory, 'workspace', 'Drilling_2026')
            workspace.mkdir(parents=True)
            retained = workspace / 'input.csv'
            retained.write_text('keep this data\n')
            with patch.object(common, 'STATE', state), patch.object(common, 'Docker') as docker:
                for name, loader in (('setup.json', common.load_profile), ('pending.json', common.load_pending)):
                    record = state / name
                    raw = json.dumps({'version': 1, 'project': 'Drilling_2026'}).encode()
                    record.write_bytes(raw)
                    record.chmod(0o600)
                    with self.assertRaises(common.SetupError) as error:
                        loader()
                    message = str(error.exception)
                    self.assertIn('mv -T -n --', message)
                    self.assertIn('.geocluster', message)
                    self.assertIn('retain', message.lower())
                    self.assertIn('./scripts/setup.sh', message)
                    self.assertEqual(record.read_bytes(), raw)
                docker.assert_not_called()
            self.assertEqual(retained.read_text(), 'keep this data\n')

    def test_invalid_guided_names_are_not_rewritten(self):
        for name in ('datasets', '_private', '.runtime', '../x', 'a b', 'x' * 65):
            with self.assertRaises(ValueError):
                common.validate_project(name)
        self.assertEqual(common.validate_project('Drill_2026-11'), 'Drill_2026-11')

    def test_saved_launch_pins_image_docker_and_fixed_workspace(self):
        profile = {'version': 2, 'image': {'reference': 'runtime:mutable',
            'id': 'sha256:' + 'a' * 64, 'created': 'today'},
            'docker': {'fingerprint': 'b' * 64, 'label': 'local Linux Docker'},
            'storage': {'kind': 'volume', 'name': 'my-geology'},
            'project': 'default', 'operation': None,
            'starter': {'kind': 'existing', 'destination': None}}
        docker = MagicMock()
        docker.inspect.return_value = {'exists': True}
        with patch.object(common, 'Docker', return_value=docker), patch.object(common.subprocess, 'call', return_value=0) as execute:
            self.assertEqual(common.launch(profile), 0)
            docker.image.assert_called_once_with(profile['image']['id'])
            docker.inspect.assert_called_once_with(profile['storage'], 'default', profile['image']['id'])
            docker.check.assert_called_with(profile['docker']['fingerprint'])
            command = execute.call_args.args[0]
            self.assertIn('my-geology', command)
            self.assertNotIn('--project', command)
            self.assertIn('--require-existing-workspace', command)
            self.assertNotIn('runtime:mutable', command)
            docker.inspect.return_value = {'exists': False}
            execute.reset_mock()
            with self.assertRaisesRegex(common.SetupError, "couldn't find.*workspace"):
                common.launch(profile)
            execute.assert_not_called()
        with patch.object(common, 'Docker') as docker:
            for incompatible in ({**profile, 'project': 'Drilling_2026'},
                                 {**profile, 'version': 1, 'project': 'Drilling_2026'},
                                 {**profile, 'version': 1}):
                with self.assertRaises(common.SetupError):
                    common.launch(incompatible)
            docker.assert_not_called()

    def test_unsafe_settings_are_not_repaired(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory, 'settings')
            state.mkdir(mode=0o755)
            state.chmod(0o755)
            with patch.object(common, 'STATE', state):
                with self.assertRaisesRegex(common.SetupError, 'mode 0700'):
                    common.load_profile()
            self.assertEqual(state.stat().st_mode & 0o777, 0o755)

    def test_failed_first_profile_does_not_leave_an_orphan_guide(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = {'version': 2, 'image': {'reference': 'runtime:test',
                'id': 'sha256:' + 'a' * 64, 'created': 'today'},
                'docker': {'fingerprint': 'b' * 64, 'label': 'local Linux Docker'},
                'storage': {'kind': 'volume', 'name': 'test-workspace'},
                'project': 'default', 'operation': None,
                'starter': {'kind': 'none', 'destination': None}}
            real_write = common._write
            def fail_profile(parent, name, raw):
                if name == 'setup.json':
                    raise OSError('simulated profile failure')
                return real_write(parent, name, raw)
            with patch.object(common, 'STATE', Path(directory)), patch.object(common, '_write', side_effect=fail_profile):
                with self.assertRaisesRegex(OSError, 'simulated profile failure'):
                    common.save_profile(profile, 'project ready\n')
                self.assertIsNone(common.load_profile())
                self.assertFalse((Path(directory) / 'next-steps.txt').exists())

    def test_selected_image_disappearing_cannot_trigger_an_implicit_pull(self):
        docker = FakeDocker()
        original = docker._run
        runs = []
        def daemon(args, **kwargs):
            if args[:2] == ['image', 'inspect']:
                return json.dumps({'Os': 'linux', 'Architecture': 'amd64',
                    'Id': 'sha256:' + 'a' * 64, 'Created': 'today'}).encode()
            if args[:2] == ['volume', 'inspect']:
                return b'"test-volume"'
            if args[0] == 'run':
                runs.append(args)
                # Docker would resolve an absent ID as a registry reference unless
                # the client forbids pulling, even after a successful inspection.
                self.assertIn('--pull=never', args, 'selected images must never fall back to registry pulls')
                if '--capabilities' in args:
                    return b'{"protocol":1,"initialize":true,"import":true,"export":true,"bundles":["wattle-creek/v1"]}'
                return b'{"exists":true,"state":"verified","unchanged":true}'
            return original(args, **kwargs)
        with patch.object(docker, '_run', side_effect=daemon):
            selected = docker.image('runtime:installed')
            storage = {'kind': 'volume', 'name': 'test-volume'}
            docker.inspect(storage, 'default', selected['id'])
            docker.operation(storage, selected['id'], ['prepare', '--project', 'default', '--expect', 'existing'])
        self.assertEqual(len(runs), 3)


if __name__ == '__main__':
    unittest.main()
