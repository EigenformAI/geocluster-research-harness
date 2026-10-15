#!/usr/bin/env python3
"""Generate sanitized test discovery using the backend's real pure projection."""
import argparse
import hashlib
import json
import sys
from pathlib import Path


def build(source):
    source = Path(source).resolve()
    sys.path.insert(0, str(source))
    from app.core.managed_model_defaults import _route
    from app.services.model_discovery import build_model_discovery
    # Controlled routes explicitly qualify two image candidates. These settings
    # are test policy, not claims about deployed supplier authorization.
    candidates = ['openai/gpt-6-luna', 'google/gemini-3.8-flash']
    routes = {model: _route('Local test model', 'local-test-only', 'Local test only', 1050000,
                           max_prompt=922000, efforts=('low', 'medium', 'high'), images=True)
              for model in candidates}
    routes[candidates[0]]['image_input']['detail'] = 'original'
    projection = build_model_discovery(candidates, routes)
    assert projection['allowed_model_ids'] == candidates
    assert all(projection['model_capabilities'][model]['input'] == ['text', 'image'] for model in candidates)
    assert projection['model_capabilities'][candidates[0]]['image_input']['detail'] == 'original'
    projection.update(managed_access_enabled=True, as_of='2026-10-14T00:00:00+00:00')
    builder = source / 'app/services/model_discovery.py'
    files = ['app/services/model_discovery.py', 'app/services/account_usage_policy.py',
             'app/services/managed_images.py', 'app/core/managed_model_defaults.py']
    return {'provenance': {
        'builder': 'app.services.model_discovery.build_model_discovery',
        'builderSha256': hashlib.sha256(builder.read_bytes()).hexdigest(),
        'sourceFiles': {name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in files},
        'generator': 'processor-discovery-fixture.py; two controlled image-qualified routes; no account or supplier data',
    }, 'projection': projection}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend-source', required=True)
    parser.add_argument('--output')
    args = parser.parse_args()
    try:
        result = json.dumps(build(args.backend_source), indent=2, sort_keys=True) + '\n'
        if args.output:
            Path(args.output).write_text(result)
        else:
            print(result, end='')
    except Exception:  # noqa: BLE001 - never expose imported backend configuration in errors
        print('Backend discovery fixture generation failed; supply the pure builder and its Pillow dependency.', file=sys.stderr)
        sys.exit(1)
