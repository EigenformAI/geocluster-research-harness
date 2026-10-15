"""Run external tests against installed code; never expose pytest failures or locals."""
import contextlib
import json
import os
import sys
from pathlib import Path


class Proof:
    def __init__(self):
        self.collected = []
        self.passed = []
        self.candidates = {}
        self.skipped = 0
        self.failed = 0

    def pytest_collection_modifyitems(self, items):
        self.collected = [item.nodeid for item in items]
        self.candidates = {item.nodeid: item.callspec.params.get('candidate')
                           for item in items if hasattr(item, 'callspec')
                           and 'completed_text_and_image_turns_with_service_ledger' in item.nodeid}

    def pytest_runtest_logreport(self, report):
        if report.skipped:
            self.skipped += 1
        if report.failed:
            self.failed += 1
        if report.when == 'call' and report.passed:
            self.passed.append(report.nodeid)


def main():
    import preprocessing
    import preprocessing.engine
    import pytest
    root = Path('/opt/geocluster-preprocessing').resolve()
    installed = all(Path(module.__file__).resolve().is_relative_to(root)
                    for module in (preprocessing, preprocessing.engine))
    if not installed or os.environ.get('PREPROCESSING_TEST_OPENCODE') != '/opt/opencode/engine/bin/opencode':
        raise ValueError('installed_package_required')
    proof = Proof()
    # Discard all pytest output, including assertion values, tracebacks and provider bodies.
    with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        status = pytest.main(['-q', '--tb=no', '-p', 'no:cacheprovider', '-o', 'asyncio_mode=auto',
                             '-o', 'asyncio_default_fixture_loop_scope=function', '/qualification/test_engine_http_real.py'], plugins=[proof])
    installed = installed and all(Path(module.__file__).resolve().is_relative_to(root)
                                 for name, module in sys.modules.items()
                                 if name.startswith('preprocessing.') and getattr(module, '__file__', None))
    completed = any('completed_text_and_image_turns_with_service_ledger' in name for name in proof.passed)
    candidates = {proof.candidates[name] for name in proof.passed if name in proof.candidates
                  and isinstance(proof.candidates[name], str) and 0 < len(proof.candidates[name]) <= 128}
    two = len(candidates) == 2
    result = {'ok': status == 0 and installed and len(proof.collected) >= 3 and len(proof.passed) == len(proof.collected)
                    and proof.skipped == 0 and proof.failed == 0 and completed and two,
              'installedPackage': installed, 'collected': len(proof.collected), 'passed': len(proof.passed),
              'skipped': proof.skipped, 'failed': proof.failed, 'completedTurns': completed,
              'twoCandidates': two, 'completedCandidates': len(candidates), 'evidenceBeforeDelete': completed}
    print(json.dumps(result))
    return 0 if result['ok'] else 1


try:
    sys.exit(main())
except Exception:  # noqa: BLE001 - never expose pytest assertion values or raw protocol data
    print(json.dumps({'ok': False, 'failure': 'installed_protocol_failed'}))
    sys.exit(1)
