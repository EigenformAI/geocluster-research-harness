#!/usr/bin/env bash
set -euo pipefail

repo="$(builtin cd -- "${BASH_SOURCE[0]%/*}/.." && pwd -P)"
if ! command -v python3 >/dev/null 2>&1; then
    printf '%s\n' 'Install Python 3 to continue setup.' 'https://www.python.org/downloads/' >&2
    exit 1
fi
exec python3 "$repo/scripts/setup-wizard.py" "$@"
