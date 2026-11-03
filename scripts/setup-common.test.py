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
                profile = {'version': 1, 'image': {'reference': 'runtime:test',
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
                        common.save_profile({**profile, 'project': 'another'}, 'new guide\n')
                self.assertEqual(common.load_profile(), profile)
                self.assertEqual((Path(directory) / 'next-steps.txt').read_text(), 'first-use guide\n')
                (Path(directory) / 'setup.json').write_text('{"version":1,"version":1}')
                with self.assertRaises(common.SetupError):
                    common.load_profile()

    def test_pending_excludes_source_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(common, 'STATE', Path(directory)):
                with self.assertRaises(common.SetupError):
                    common.save_pending({'version': 1, 'source': '/private/folder'})

    def test_invalid_guided_names_are_not_rewritten(self):
        for name in ('datasets', '_private', '.runtime', '../x', 'a b', 'x' * 65):
            with self.assertRaises(ValueError):
                common.validate_project(name)
        self.assertEqual(common.validate_project('Drill_2026-11'), 'Drill_2026-11')

    def test_saved_nondefault_launch_pins_image_and_project(self):
        profile = {'version': 1, 'image': {'reference': 'runtime:mutable',
            'id': 'sha256:' + 'a' * 64, 'created': 'today'},
            'docker': {'fingerprint': 'b' * 64, 'label': 'local Linux Docker'},
            'storage': {'kind': 'volume', 'name': 'my-geology'},
            'project': 'Drilling_2026', 'operation': None,
            'starter': {'kind': 'existing', 'destination': None}}
        docker = MagicMock()
        docker.inspect.return_value = {'exists': True}
        with patch.object(common, 'Docker', return_value=docker), patch.object(common.subprocess, 'call', return_value=0) as execute:
            self.assertEqual(common.launch(profile), 0)
            docker.image.assert_called_once_with(profile['image']['id'])
            command = execute.call_args.args[0]
            self.assertIn('my-geology', command)
            self.assertIn('Drilling_2026', command)
            self.assertIn('--require-existing-project', command)
            self.assertNotIn('runtime:mutable', command)
            docker.inspect.return_value = {'exists': False}
            execute.reset_mock()
            with self.assertRaisesRegex(common.SetupError, "couldn't find Drilling_2026"):
                common.launch(profile)
            execute.assert_not_called()

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
            profile = {'version': 1, 'image': {'reference': 'runtime:test',
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
