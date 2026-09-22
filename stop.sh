#!/usr/bin/env bash
# =============================================================================
# Geocluster Research Harness — single-run stopper (macOS / Linux)
#
# Counterpart to run.sh: stops and removes the container started by
# `docker compose up` / run.sh. The built image is kept, so the next
# `./run.sh` starts fast without rebuilding.
# =============================================================================

set -euo pipefail

if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; RED=""; RESET=""
fi
info() { printf '%s\n' "${BOLD}==>${RESET} $*"; }
ok()   { printf '%s\n' "${GREEN}✓${RESET} $*"; }
fail() { printf '%s\n' "${RED}✗ $*${RESET}" >&2; exit 1; }

cd "$(dirname "$0")"

[ -f docker-compose.yml ] || fail "docker-compose.yml not found here — run this script from inside the cloned geocluster-research-harness folder."

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  fail "Docker isn't running, so there's nothing to stop."
fi

if [ -z "$(docker compose ps -q 2>/dev/null)" ]; then
  ok "Nothing running — already stopped."
  exit 0
fi

info "Stopping the harness..."
docker compose down
ok "Stopped. Your projects are untouched in copy-your-files-here/."
echo "   To start it again: ./run.sh or ./run.command"
