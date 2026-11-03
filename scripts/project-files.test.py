"""Host transfer user contracts, with no paid inference or daemon writes."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location('project_files', Path(__file__).with_name('project-files.py'))
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)


class TransferTests(unittest.TestCase):
    def test_explicit_options_never_merge_saved_storage(self):
        args = files.parser().parse_args(['import', '/source', '--project', 'another'])
        with patch.object(files, 'load_profile', side_effect=AssertionError('must not load saved settings')):
            with self.assertRaisesRegex(files.SetupError, 'cannot be mixed'):
                files.select(None, args)

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
