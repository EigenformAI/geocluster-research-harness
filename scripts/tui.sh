#!/usr/bin/env bash
set -euo pipefail

repo="$(builtin cd -- "${BASH_SOURCE[0]%/*}/.." && pwd -P)"
exec bash "$repo/scripts/run-runtime-tui.sh" "$@"
