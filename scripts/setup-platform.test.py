"""Focused platform-policy tests on Linux; not qualification on another OS."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parent


class PlatformTests(unittest.TestCase):
    def test_non_linux_entries_reject_before_linux_imports_or_docker_and_allow_help(self):
        program = '''
import importlib.abc, runpy, sys
sys.path.insert(0, sys.argv[1])
class BlockLinux(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, *args):
        if fullname in ('setup_transfer', 'setup_host'):
            raise AssertionError('Linux-only import reached: ' + fullname)
sys.meta_path.insert(0, BlockLinux())
import subprocess
def forbidden(*args, **kwargs):
    raise AssertionError('subprocess reached')
subprocess.run = subprocess.call = forbidden
sys.platform = sys.argv[2]
script, args = sys.argv[3], sys.argv[4:]
sys.argv = [script, *args]
runpy.run_path(script, run_name='__main__')
'''
        for platform in ('darwin', 'win32'):
            for name, args in (('setup-client.py', []), ('setup-wizard.py', []),
                               ('workspace-files.py', ['import', '/not-read'])):
                for help_only in (False, True):
                    with self.subTest(platform=platform, name=name, help=help_only):
                        result = subprocess.run([sys.executable, '-c', program, str(SCRIPTS), platform,
                                                 str(SCRIPTS / name), *(['--help'] if help_only else args)],
                                                capture_output=True, text=True, timeout=10)
                        if help_only:
                            self.assertEqual(result.returncode, 0, result.stderr)
                            self.assertIn('usage:', result.stdout.lower())
                        else:
                            self.assertNotEqual(result.returncode, 0)
                            self.assertIn('Linux client', result.stderr)
                            self.assertIn('Linux Docker daemon', result.stderr)
                        self.assertNotIn('Traceback', result.stderr)

    def test_explicit_launcher_platform_check_precedes_terminal_and_docker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'uname').write_text('#!/bin/sh\necho Darwin\n')
            (root / 'uname').chmod(0o700)
            (root / 'docker').write_text('#!/bin/sh\necho DOCKER_REACHED >&2\nexit 99\n')
            (root / 'docker').chmod(0o700)
            env = {**os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH']}
            for args in ([], ['--help']):
                result = subprocess.run(['bash', str(SCRIPTS / 'run-runtime-tui.sh'), *args],
                                        env=env, capture_output=True, text=True, timeout=10)
                self.assertNotIn('DOCKER_REACHED', result.stderr)
                if args:
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('Linux client', result.stderr)
                    self.assertNotIn('requires a terminal', result.stderr)

    def test_processing_attachment_rejects_non_linux_before_docker_and_allows_help(self):
        with tempfile.TemporaryDirectory() as directory:
            python = Path(directory, 'python3')
            python.write_text('#!/bin/sh\nexec ' + sys.executable + ''' -c '
import json, os, pathlib, subprocess, sys
def forbidden(*args, **kwargs):
    raise AssertionError("Docker reached")
subprocess.run = forbidden
sys.platform = "darwin"
sys.argv = sys.argv[1:]
exec(sys.stdin.read())
' "$@"
''')
            python.chmod(0o700)
            for args in (['list'], ['--help']):
                result = subprocess.run(['bash', str(SCRIPTS / 'process-document.sh'), *args],
                                        env={**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH']},
                                        capture_output=True, text=True, timeout=10)
                self.assertNotIn('Traceback', result.stderr)
                if args == ['--help']:
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('Linux client', result.stderr)


if __name__ == '__main__':
    unittest.main()
