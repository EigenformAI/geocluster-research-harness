"""Bootstrap boundary regression; not an engine/package compatibility test.

The released processor validator rejects installed limit.input/variants. This
strict boundary double accepts that full metadata contract, without dropping
fields, and requires the exact selected model and variant to be declared.
"""
import asyncio
import copy
import importlib.util
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('pair', Path(__file__).parents[1] / 'preprocessing-pair.py')
pair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pair)


def catalog():
    return {'discovery_schema_version': 2, 'managed_models': {
        name: {'name': name, 'limit': {'context': 65536, 'input': 32768, 'output': 8192},
               'capabilities': {'tools': True, 'input': inputs, 'output': ['text']},
               'variants': [{'id': 'high', 'settings': {'reasoning': {'effort': 'high'}}}]}
        for name, inputs in [('vendor/image', ['text', 'image']), ('vendor/text', ['text'])]}}


def boot():
    return {'model': 'proxy/vendor/removed#high', 'proxyUrl': 'http://127.0.0.1/llm',
            'allowModelFallback': True, 'fallbackModels': ['proxy/vendor/image#high']}


def validate_config(config, credentials):
    if credentials != ['PREPROCESSING_PROXY_TOKEN']:
        raise ValueError('Unexpected credential boundary')
    models = config['providers']['proxy']['models']
    name, _, variant = config['model'][6:].partition('#')
    if name not in models or (variant and variant not in {v['id'] for v in models[name]['variants']}):
        raise ValueError('Engine bootstrap model/variant must exist')
    for model in models.values():
        if (set(model) != {'name', 'limit', 'capabilities', 'variants'}
                or set(model['limit']) != {'context', 'input', 'output'}
                or model['capabilities']['tools'] is not False):
            raise ValueError('Full installed declarations must remain intact')
    return config


class BootstrapTest(unittest.TestCase):
    def setUp(self):
        modules = {'preprocessing': types.ModuleType('preprocessing'),
                   'preprocessing.engine': types.SimpleNamespace(SYSTEM='extraction-only fixture'),
                   'preprocessing.dev': types.SimpleNamespace(validate_config=validate_config)}
        self.addCleanup(patch.stopall)
        patch.dict('sys.modules', modules).start()

    def test_absent_preference_uses_exact_explicit_fallback_only_for_bootstrap(self):
        value, declarations = boot(), catalog()
        original = copy.deepcopy(value)
        config = pair.model_config(value, declarations)
        self.assertEqual(config['model'], 'proxy/vendor/image#high')
        self.assertEqual(value, original)
        self.assertEqual(config['providers']['proxy']['models'], pair.trusted_models(declarations))
        self.assertIs(pair.managed_config(config, value, declarations), config)

    def test_preferred_and_variant_are_not_rewritten(self):
        for selected in ['proxy/vendor/image', 'proxy/vendor/image#high']:
            value = {**boot(), 'model': selected}
            self.assertEqual(pair.model_config(value, catalog())['model'], selected)

    def test_omitted_policy_fields_use_production_defaults(self):
        value = {'model': 'proxy/vendor/removed', 'proxyUrl': boot()['proxyUrl']}
        config = pair.model_config(value, catalog())
        self.assertEqual(config['model'], 'proxy/vendor/image')
        self.assertIs(pair.managed_config(config, value, catalog()), config)
        value['model'] += '#high'
        with self.assertRaises(ValueError):
            pair.model_config(value, catalog())

    def test_trusted_custom_text_model_retains_exact_variant(self):
        declarations = catalog()
        value = {**boot(), 'model': 'proxy/vendor/text#high', 'allowModelFallback': False}
        config = pair.model_config(boot(), declarations)
        config['model'] = value['model']
        config['providers']['proxy']['models'].pop('vendor/image')
        self.assertIs(pair.managed_config(config, value, declarations), config)
        for selected in ['proxy/vendor/text', 'proxy/vendor/text#unknown']:
            with self.subTest(selected=selected), self.assertRaises(ValueError):
                pair.managed_config({**config, 'model': selected}, value, declarations)
        with self.assertRaises(ValueError):
            pair.model_config(value, declarations)

    def test_generated_and_custom_config_use_their_own_modality_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'config').mkdir()
            value = {**boot(), 'model': 'proxy/vendor/text', 'base': directory, 'projectId': 'fixture',
                     'managedCatalogPath': 'fixture', 'managedBackendBaseUrl': 'http://backend',
                     'managedDiscoveryMaxBytes': 1048576}
            with patch.object(pair.subprocess, 'check_output', return_value=json.dumps(catalog()).encode()), \
                    patch.object(pair.os, 'fchown'):
                path = pair.extraction_config(value, root)
                generated = json.loads(path.read_text())
                self.assertEqual(generated['model'], 'proxy/vendor/image#high')
                generated['model'] = value['model']
                custom = root / 'custom.json'
                custom.write_text(json.dumps(generated))
                value['engineConfig'] = str(custom)
                self.assertEqual(json.loads(pair.extraction_config(value, root).read_text())['model'], value['model'])

    def test_no_permitted_usable_fallback_rejects(self):
        for change in [
            {'allowModelFallback': False}, {'fallbackModels': []},
            {'fallbackModels': ['proxy/vendor/missing#high']},
            {'fallbackModels': ['proxy/vendor/image#unknown']},
            {'fallbackModels': ['proxy/vendor/text#high']},
            {'model': 'proxy/vendor/image#unknown', 'allowModelFallback': False},
        ]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                pair.model_config({**boot(), **change}, catalog())

    def test_unqualified_preference_allows_canonical_but_variant_requires_explicit_fallback(self):
        value = {**boot(), 'model': 'proxy/vendor/removed', 'fallbackModels': []}
        self.assertEqual(pair.model_config(value, catalog())['model'], 'proxy/vendor/image')
        with self.assertRaises(ValueError):
            pair.model_config({**value, 'model': 'proxy/vendor/removed#high'}, catalog())

    def test_custom_config_narrowing_cannot_invent_models_variants_or_enable_fallback(self):
        value, declarations = boot(), catalog()
        config = pair.model_config(value, declarations)
        config['providers']['proxy']['models'].pop('vendor/text')
        self.assertIs(pair.managed_config(config, value, declarations), config)
        for change in ['disabled', 'wrong-variant', 'missing-model', 'changed-metadata']:
            candidate, selected = copy.deepcopy(config), copy.deepcopy(value)
            if change == 'disabled': selected['allowModelFallback'] = False
            if change == 'wrong-variant': candidate['model'] = 'proxy/vendor/image#unknown'
            if change == 'missing-model': candidate['model'] = selected['model']
            if change == 'changed-metadata': candidate['providers']['proxy']['models']['vendor/image']['limit']['input'] += 1
            with self.subTest(change=change), self.assertRaises(ValueError):
                pair.managed_config(candidate, selected, declarations)

    def test_main_keeps_service_policy_while_writing_real_bootstrap_config(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'config').mkdir()
                value = {**boot(), 'base': directory, 'port': 8765, 'projectId': 'fixture',
                         'managedCatalogPath': 'fixture', 'managedBackendBaseUrl': 'http://backend',
                         'managedDiscoveryMaxBytes': 1048576, 'modelPolicyRefreshMs': 30000,
                         'modelPolicyMaxAgeMs': 120000, 'startupSeconds': 300,
                         'serviceShutdownSeconds': 180, 'ownerShutdownSeconds': 30}
                (root / 'boot.json').write_text(json.dumps(value))
                (root / 'proxy-token').write_text('proxy-secret')
                (root / 'service-token').write_text('service-secret')
                calls = []
                async def supervised(owner, service, descriptor, stopped, **options):
                    calls.append(service)
                    config = json.loads((root / 'config/engine.json').read_text())
                    self.assertEqual(config['model'], 'proxy/vendor/image#high')
                    self.assertEqual(service[service.index('--model') + 1], value['model'])
                    self.assertEqual(service[service.index('--allow-model-fallback') + 1], 'true')
                    self.assertEqual(json.loads(service[service.index('--fallback-models') + 1]), value['fallbackModels'])
                    stopped.set()
                    return 0
                async def refresh(self, stopped):
                    await stopped.wait()
                loop = asyncio.get_running_loop()
                with patch.object(pair.subprocess, 'check_output', return_value=json.dumps(catalog()).encode()), \
                        patch.object(pair.os, 'fchown'), patch.object(pair.ctypes, 'CDLL'), \
                        patch.object(pair, 'run_pair', supervised), patch.object(pair.policy.ModelPolicy, 'run', refresh), \
                        patch.object(loop, 'add_reader'), patch.object(loop, 'add_signal_handler'), \
                        patch.object(pair.sys, 'argv', ['pair', directory]):
                    self.assertEqual(await pair.main(), 0)
                self.assertEqual(len(calls), 1)
        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
