#!/usr/bin/env bash
set -euo pipefail

repo="$(builtin cd -- "${BASH_SOURCE[0]%/*}/.." && pwd -P)"
exec python3 "$repo/scripts/setup-client.py" "$@"
