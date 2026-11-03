#!/usr/bin/env python3
"""Behavior tests for the terminal guide; no Docker daemon or provider is used."""
import copy
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('setup_wizard', Path(__file__).with_name('setup-wizard.py'))
wizard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wizard)


class SetupError(Exception):
    def __init__(self, message, code='failed', details=None):
        super().__init__(message)
        self.code, self.details = code, details


class FakeDocker:
    fingerprint = 'chosen-daemon'
    label = 'local Docker'
    local_host = True

    def __init__(self, owner):
        self.owner = owner

    def check(self, expected=None):
        self.owner.events.append('check')
        if expected and expected != self.fingerprint:
            raise SetupError('Your Docker connection changed during setup.', 'identity')

    def image(self, reference):
        self.owner.events.append('image')
        if not self.owner.installed:
            raise SetupError('Image is missing', 'missing-image')
        return {'reference': reference, 'id': 'sha256:installed', 'created': '2026-11-03'}

    def volume_exists(self, name):
        return self.owner.volume

    def ensure_volume(self, name):
        self.owner.events.append('volume')
        self.owner.volume = True

    def inspect(self, storage, project, image_id):
        self.owner.events.append('inspect')
        return {'exists': self.owner.exists, 'children': self.owner.children,
                'samples': self.owner.samples, 'operations': self.owner.operations}

    def operation(self, storage, image_id, args, **kwargs):
        self.owner.events.append(('operation', args))
        if args[0] == 'receipt':
            return copy.deepcopy(self.owner.receipt)
        if args[0] != 'prepare':
            raise AssertionError('Runtime accepts the prepare operation, not ' + args[0])
        if args[args.index('--expect') + 1] not in ('absent', 'existing'):
            raise AssertionError('Runtime expects absent or existing')
        self.owner.exists = True
        return {'operation': '11111111-1111-4111-8111-111111111111', 'state': 'verified', 'outcome': 'unchanged'}


class Support:
    SetupError = SetupError
    NATIVE_PROJECT = 'default'
    REPO = Path(__file__).resolve().parent.parent

    def __init__(self):
        self.events, self.pending, self.profile = [], None, None
        self.installed, self.volume, self.exists = True, False, False
        self.children, self.receipt = [], None
        self.operations = []
        self.samples = []
        self.saved, self.launched = None, False

    def Docker(self):
        return FakeDocker(self)

    def load_profile(self):
        return copy.deepcopy(self.profile)

    def load_pending(self):
        return copy.deepcopy(self.pending)

    def save_pending(self, plan):
        self.events.append('pending')
        self.pending = copy.deepcopy(plan)

    def save_profile(self, profile, guide):
        self.events.append('save')
        self.saved = copy.deepcopy(profile), guide

    def launch(self, profile):
        self.events.append('launch')
        self.launched = True
        return 0

    def validate_project(self, value):
        import re
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', value) or value == 'datasets':
            raise SetupError('Invalid project name')
        return value

    def validate_destination(self, value):
        if '/' in value or value.startswith('.') or value in ('datasets', '_orchestrator'):
            raise SetupError('Invalid destination')
        return value

    def prepare_import(self, source):
        self.events.append('manifest')
        return {'entries': [{'path': 'private.csv'}]}, ['private.csv']

    def import_source(self, *args, **kwargs):
        self.events.append(('import', kwargs.get('allow_restricted', args[6] if len(args) > 6 else None)))
        self.exists = True
        return {'operation': '11111111-1111-4111-8111-111111111111', 'state': 'verified', 'outcome': 'unchanged'}


class WizardTests(unittest.TestCase):
    def run_guide(self, lines, support=None):
        support = support or Support()
        output = io.StringIO()
        guide = wizard.Wizard(support, io.StringIO(lines), output)
        with patch.object(guide, 'check_tools'), patch.object(guide, 'check_builder'), patch.object(guide, 'source_plan', return_value=Path('/cache/pinned')):
            result = guide.run()
        return result, support, output.getvalue(), guide

    def test_enter_only_prepares_samples_and_launches(self):
        code, support, output, _ = self.run_guide('\n' * 5)
        self.assertEqual(code, 0)
        self.assertTrue(support.launched)
        profile, text = support.saved
        self.assertEqual(profile['starter'], {'kind': 'samples', 'destination': 'wattle-creek'})
        self.assertIn('WC141', text)
        self.assertIn('/connect', output)
        self.assertLess(support.events.index('image'), support.events.index('volume'))

    def test_workspace_setup_needs_only_storage_and_starting_files(self):
        # Image approval, storage, no starting files, preparation approval, no launch.
        code, support, output, _ = self.run_guide('\n\n3\n\nn\n')
        self.assertEqual(code, 0, output)
        self.assertFalse(support.launched)
        self.assertEqual(support.saved[0]['project'], 'default')
        self.assertEqual(support.saved[0]['starter']['kind'], 'none')
        self.assertIn('workspace-files.sh import', output)
        self.assertNotIn('WC141', support.saved[1])
        actions = [event[1] for event in support.events if isinstance(event, tuple) and event[0] == 'operation']
        self.assertTrue(actions)
        for action in actions:
            self.assertEqual(action[action.index('--project') + 1], 'default')
        self.assertIn('Step 6 of 6: Your workspace is ready', output)

    def test_starting_files_back_returns_to_storage(self):
        code, support, output, _ = self.run_guide('\n\nb\n\n3\n\nn\n')
        self.assertEqual(code, 0, output)
        self.assertEqual(output.count('Step 3 of 6: Choose where files are kept'), 2)
        self.assertEqual(support.saved[0]['starter']['kind'], 'none')

    def test_switching_workspace_discards_previous_copy_and_reinspects(self):
        support = Support()
        inspections, actions, prepared = [], [], set()
        original_docker = support.Docker

        def docker():
            client = original_docker()
            original_inspect, original_operation = client.inspect, client.operation

            def inspect(storage, project, image):
                inspections.append(storage['name'])
                if storage['name'] == 'other-workspace':
                    return {'exists': storage['name'] in prepared, 'children': [], 'samples': [], 'operations': []}
                return original_inspect(storage, project, image)

            def operation(storage, image, args, **kwargs):
                actions.append((storage['name'], args))
                prepared.add(storage['name'])
                return original_operation(storage, image, args, **kwargs)

            client.inspect, client.operation = inspect, operation
            return client

        support.Docker = docker
        # Finish one copy, return to storage, select another workspace, add nothing.
        code, support, output, _ = self.run_guide('\n\n\n\nb\n1\n?\nother-workspace\n\n3\n\nn\n', support)
        self.assertEqual(code, 0, output)
        self.assertEqual(support.saved[0]['storage']['name'], 'other-workspace')
        self.assertEqual(support.saved[0]['starter']['kind'], 'none')
        self.assertIn('other-workspace', inspections)
        second = [args for name, args in actions if name == 'other-workspace']
        self.assertEqual(len(second), 1)
        self.assertNotIn('--resume', second[0])
        self.assertNotIn('--samples', second[0])
        self.assertEqual(second[0][second[0].index('--expect') + 1], 'absent')

    def test_eof_never_approves_installed_image(self):
        code, support, output, _ = self.run_guide('')
        self.assertEqual(code, 130)
        self.assertIsNone(support.saved)
        self.assertNotIn('pending', support.events)
        self.assertIn('No changes were made', output)

    def test_existing_workspace_defaults_to_adding_nothing(self):
        support = Support()
        support.exists, support.volume = True, True
        support.children = ['wattle-creek']
        code, support, _, _ = self.run_guide('\n' * 4 + 'n\n', support)
        self.assertEqual(code, 0)
        self.assertEqual(support.saved[0]['starter']['kind'], 'existing')

    def test_sample_collision_uses_fresh_sibling(self):
        support = Support()
        support.exists, support.volume = True, True
        support.children = ['wattle-creek', 'wattle-creek-2']
        code, support, output, _ = self.run_guide('\n\n2\n\n\nn\n', support)
        self.assertEqual(code, 0)
        self.assertEqual(support.saved[0]['starter']['destination'], 'wattle-creek-3')
        self.assertIn('wattle-creek-3/drilling/assays.csv', output)

    def test_personal_permission_is_yes_default_and_source_not_pending(self):
        code, support, _, _ = self.run_guide('\n\n2\n/private/data\n\n\n\nn\n')
        self.assertEqual(code, 0)
        self.assertIn(('import', True), support.events)
        self.assertNotIn('/private/data', str(support.pending))
        self.assertEqual(support.saved[0]['starter']['kind'], 'personal')

    def test_build_approval_builds_before_workspace_choice(self):
        support = Support()
        support.installed = False
        output = io.StringIO()
        guide = wizard.Wizard(support, io.StringIO('\nq\n'), output)
        def build(source):
            support.events.append('build')
            support.installed = True
        with patch.object(guide, 'check_tools'), patch.object(guide, 'check_builder'), patch.object(guide, 'source_plan', return_value=Path('/cache/pinned')), patch.object(guide, 'build', side_effect=build):
            self.assertEqual(guide.run(), 130)
        self.assertLess(support.events.index('pending'), support.events.index('build'))
        self.assertEqual(support.pending['image']['id'], 'sha256:installed')
        self.assertIn('Completed: GeoCluster image built', output.getvalue())

    def test_pending_verified_copy_skips_source_and_duplicate_copy(self):
        support = Support()
        support.volume, support.exists = True, True
        support.pending = self.pending_personal()
        support.receipt = {'state': 'verified', 'unchanged': True, 'operation': support.pending['operation'], 'project': 'default', 'destination': 'my-data'}
        code, support, output, _ = self.run_guide('\n\nn\n', support)
        self.assertEqual(code, 0)
        self.assertEqual(support.saved[0]['storage']['name'], 'chosen')
        self.assertNotIn('Source folder on this computer:', output)
        self.assertFalse(any(event[0] == 'import' for event in support.events if isinstance(event, tuple)))

    def test_required_value_blank_help_and_back(self):
        output = io.StringIO()
        guide = wizard.Wizard(Support(), io.StringIO('\n?\nb\n'), output)
        with self.assertRaises(wizard.Back):
            guide.ask('Source:', help_text='Choose a local folder.', expected='a source folder')
        self.assertIn('Enter a source folder, or type b', output.getvalue())

    def test_yes_no_invalid_never_means_yes(self):
        output = io.StringIO()
        guide = wizard.Wizard(Support(), io.StringIO('maybe\nNO\n'), output)
        self.assertFalse(guide.confirm('Prepare?', help_text='Help'))
        self.assertIn('Enter y or n', output.getvalue())

    def test_completed_launch_back_changes_starter_and_requires_new_approval(self):
        code, support, output, _ = self.run_guide('\n\n\n\nb\n2\n1\n\nn\n')
        self.assertEqual(code, 0)
        self.assertEqual(support.saved[0]['starter']['kind'], 'existing')
        self.assertEqual(output.count('Prepare this workspace? [Y/n]:'), 2)

    def test_change_menu_back_returns_to_review(self):
        code, support, output, _ = self.run_guide('\n\n3\nn\nb\n\nn\n')
        self.assertEqual(code, 0)
        self.assertEqual(output.count('Prepare this workspace? [Y/n]:'), 2)

    def test_image_help_offers_alternatives_without_approval(self):
        code, support, output, _ = self.run_guide('?\nq\n')
        self.assertEqual(code, 130)
        self.assertIn('Other ways to prepare GeoCluster', output)
        self.assertNotIn('pending', support.events)

    def test_reviewed_personal_manifest_is_used_at_copy(self):
        support = Support()
        original = support.import_source
        def check_manifest(*args, **kwargs):
            self.assertEqual(kwargs['manifest'], {'entries': [{'path': 'private.csv'}]})
            return original(*args, **kwargs)
        support.import_source = check_manifest
        code, _, _, _ = self.run_guide('\n\n2\n/private/data\n\n\n\nn\n', support)
        self.assertEqual(code, 0)

    def test_noninteractive_rejected_and_help_allowed(self):
        with patch('sys.stdin', io.StringIO()), patch('sys.stdout', io.StringIO()), patch('sys.stderr', io.StringIO()):
            self.assertEqual(wizard.main([]), 2)
            self.assertEqual(wizard.main(['--help']), 0)

    def pending_personal(self):
        return {'version': 2, 'image': {'reference': 'selected:local', 'id': 'sha256:installed', 'created': 'today'}, 'docker': {'fingerprint': 'chosen-daemon', 'label': 'local Docker'}, 'storage': {'kind': 'volume', 'name': 'chosen'}, 'project': 'default', 'starter': {'kind': 'personal', 'destination': 'my-data'}, 'operation': '11111111-1111-4111-8111-111111111111', 'stage': 5, 'allowRestricted': True}

    def test_modified_or_deleted_receipt_never_recopies(self):
        for outcome in ('modified', 'deleted'):
            with self.subTest(outcome=outcome):
                support = Support()
                support.pending = self.pending_personal()
                support.exists = support.volume = True
                support.receipt = {'state': 'verified', 'outcome': outcome, 'project': 'default', 'destination': 'my-data'}
                support.children = ['my-data'] if outcome == 'modified' else []
                code, support, output, _ = self.run_guide('\n\nn\n', support)
                self.assertEqual(code, 0)
                self.assertEqual(support.saved[0]['starter']['kind'], 'existing')
                self.assertNotIn('Source folder on this computer:', output)

    def test_staged_copy_resumes_without_source(self):
        support = Support()
        support.pending = self.pending_personal()
        support.exists = support.volume = True
        support.receipt = {'state': 'staged', 'outcome': 'staged', 'project': 'default', 'destination': 'my-data'}
        code, support, output, _ = self.run_guide('\n\nn\n', support)
        self.assertEqual(code, 0)
        actions = [event[1] for event in support.events if isinstance(event, tuple) and event[0] == 'operation']
        self.assertTrue(any('--resume' in action for action in actions))
        self.assertNotIn('Source folder on this computer:', output)

    def test_changed_source_fails_without_rereading_a_new_manifest(self):
        support = Support()
        def changed(*args, **kwargs):
            raise SetupError('Source permissions changed after approval.', 'source_changed')
        support.import_source = changed
        code, support, output, _ = self.run_guide('\n\n2\n/private/data\n\n\n\n', support)
        self.assertEqual(code, 1)
        self.assertIsNone(support.saved)
        self.assertEqual(support.events.count('manifest'), 1)
        self.assertNotIn('Step 6', output)

    def test_profile_failure_retries_saving_not_copying(self):
        support = Support()
        original = support.save_profile
        attempts = []
        def save(profile, guide):
            attempts.append(1)
            if len(attempts) == 1:
                raise OSError('disk full')
            original(profile, guide)
        support.save_profile = save
        code, support, output, _ = self.run_guide('\n\n2\n/private/data\n\n\n\n\n\nn\n', support)
        self.assertEqual(code, 0)
        self.assertEqual(len([event for event in support.events if isinstance(event, tuple) and event[0] == 'import']), 1)
        self.assertIn('Your workspace files are ready. We still need to save', output)
        self.assertEqual(output.count('Prepare this workspace? [Y/n]:'), 2)

    def test_modified_cache_is_retained_and_fresh_sibling_is_planned(self):
        with tempfile.TemporaryDirectory() as directory:
            support = Support()
            support.REPO = Path(__file__).resolve().parent.parent
            guide = wizard.Wizard(support, io.StringIO(), io.StringIO())
            import json
            pin = json.loads((support.REPO / 'scripts/preprocessing-release.json').read_text())
            existing = Path(directory) / 'geocluster/processor' / pin['sourceRevision']
            existing.mkdir(parents=True)
            (existing / 'local-work').write_text('keep me')
            with patch.dict('os.environ', {'XDG_CACHE_HOME': directory}), patch.object(guide, 'validate_source', side_effect=SetupError('dirty')):
                result = guide.source_plan()
            self.assertEqual(result.name, existing.name + '-2')
            self.assertFalse(result.exists())
            self.assertEqual((existing / 'local-work').read_text(), 'keep me')

    def test_back_after_build_reuses_installed_image(self):
        support = Support()
        support.installed = False
        output = io.StringIO()
        guide = wizard.Wizard(support, io.StringIO('\nb\n\nq\n'), output)
        def build(source):
            support.events.append('build')
            support.installed = True
        with patch.object(guide, 'check_tools'), patch.object(guide, 'check_builder'), patch.object(guide, 'source_plan', return_value=Path('/cache/pinned')), patch.object(guide, 'build', side_effect=build):
            self.assertEqual(guide.run(), 130)
        self.assertEqual(support.events.count('build'), 1)
        self.assertIn('Use this image? [Y/n]:', output.getvalue())

    def test_lost_client_operation_recovers_matching_workspace_receipt(self):
        support = Support()
        support.pending = self.pending_personal()
        operation = support.pending['operation']
        support.pending['operation'] = None
        support.exists = support.volume = True
        support.receipt = {'state': 'verified', 'outcome': 'unchanged', 'project': 'default', 'destination': 'my-data', 'kind': 'import', 'operation': operation}
        support.operations = [support.receipt]
        code, support, output, _ = self.run_guide('\n\nn\n', support)
        self.assertEqual(code, 0)
        self.assertNotIn('Source folder on this computer:', output)

    def test_existing_verified_sample_reuses_actual_nondefault_destination(self):
        support = Support()
        support.exists = support.volume = True
        support.children = ['wattle-creek', 'wattle-creek-2']
        support.samples = [{'state': 'verified', 'outcome': 'unchanged', 'project': 'default', 'destination': 'wattle-creek-2', 'kind': 'samples', 'operation': '11111111-1111-4111-8111-111111111111'}]
        code, support, output, _ = self.run_guide('\n\n2\n\nn\n', support)
        self.assertEqual(code, 0)
        self.assertEqual(support.saved[0]['starter']['destination'], 'wattle-creek-2')
        self.assertNotIn('Adding Wattle Creek samples', output)

    def test_recorded_sample_deletion_gets_new_name_only_when_explicitly_requested(self):
        support = Support()
        support.exists = support.volume = True
        support.samples = [{'state': 'verified', 'outcome': 'deleted', 'project': 'default', 'destination': 'wattle-creek', 'kind': 'samples', 'operation': '11111111-1111-4111-8111-111111111111'}]
        code, support, _, _ = self.run_guide('\n\n2\n\n\nn\n', support)
        self.assertEqual(code, 0)
        self.assertEqual(support.saved[0]['starter']['destination'], 'wattle-creek-2')

    def test_back_from_workspace_name_returns_to_storage_not_image(self):
        code, support, output, _ = self.run_guide('\n?\nb\nq\n')
        self.assertEqual(code, 130)
        self.assertIsNone(support.saved)
        self.assertNotIn('volume', support.events)
        self.assertIn('Workspace', output)
        self.assertEqual(output.count('Step 2 of 6:'), 1)
        self.assertNotIn('pending', support.events)

    def test_back_from_completed_change_menu_returns_to_launch_without_reapply(self):
        code, support, output, _ = self.run_guide('\n\n\n\nb\nb\nn\n')
        self.assertEqual(code, 0)
        self.assertEqual(output.count('Prepare this workspace? [Y/n]:'), 1)
        self.assertEqual(support.events.count('save'), 1)


if __name__ == '__main__':
    unittest.main()
