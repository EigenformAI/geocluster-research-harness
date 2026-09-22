#!/usr/bin/env bash
# =============================================================================
# Geocluster Research Harness — single-run launcher (macOS / Linux)
#
# For someone who doesn't want to know about Docker: run this from inside the
# cloned repo and it builds (first run only), starts, waits until ready, and
# opens the IDE in your browser.
# =============================================================================

set -euo pipefail

if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; RED=""; YELLOW=""; RESET=""
fi
info() { printf '%s\n' "${BOLD}==>${RESET} $*"; }
ok()   { printf '%s\n' "${GREEN}✓${RESET} $*"; }
warn() { printf '%s\n' "${YELLOW}!${RESET} $*"; }
fail() { printf '%s\n' "${RED}✗ $*${RESET}" >&2; exit 1; }

cd "$(dirname "$0")"

[ -f docker-compose.yml ] || fail "docker-compose.yml not found here — run this script from inside the cloned geocluster-research-harness folder."

if ! command -v docker >/dev/null 2>&1; then
  fail "Docker isn't installed. Install Docker Desktop first: https://docs.docker.com/get-docker/ — then run this script again."
fi

if ! docker info >/dev/null 2>&1; then
  fail "Docker is installed but not running. Open Docker Desktop, wait for it to finish starting, then run this script again."
fi
ok "Docker is installed and running"

if ! docker compose version >/dev/null 2>&1; then
  fail "'docker compose' isn't available — update Docker Desktop to a recent version."
fi

if [ -d .git ] || [ -f .git ]; then
  if ! command -v git >/dev/null 2>&1; then
    warn "git isn't installed — can't sync the MCP server submodule automatically. Install git, then run: git submodule update --init"
  else
    # Always run this, not just when mcp-server/ is empty: `git pull` on the
    # main repo updates which commit the submodule *should* be at, but never
    # touches the submodule's checked-out files — only this does. Cheap and
    # a no-op when already in sync, so there's no cost to always checking.
    info "Syncing the MCP server (git submodule)..."
    git submodule update --init
    ok "MCP server in sync"
  fi
else
  warn "This doesn't look like a git checkout — skipping submodule setup. If mcp-server/ is empty, the build will fail; re-clone with 'git clone --recurse-submodules'."
fi

mkdir -p copy-your-files-here
ok "copy-your-files-here/ ready — that's where your project files go"

info "Building and starting the harness (first run takes a few minutes)..."
docker compose up --build -d

info "Waiting for the IDE to become ready..."
container_name="geocluster-research-harness"
elapsed=0
timeout=600
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$container_name" 2>/dev/null)" = "healthy" ]; do
  if [ "$elapsed" -ge "$timeout" ]; then
    fail "Timed out waiting for the harness to become healthy. Run 'docker compose logs' to see what happened."
  fi
  sleep 3
  elapsed=$((elapsed + 3))
done
ok "Harness is up and healthy"

host_addr="$(docker compose port harness 3000 2>/dev/null || true)"
if [ -n "$host_addr" ]; then
  url="http://${host_addr}"
else
  warn "Couldn't read the published port from docker compose — falling back to localhost:3000."
  url="http://localhost:3000"
fi

case "$(uname -s)" in
  Darwin) open "$url" >/dev/null 2>&1 || true ;;
  Linux) command -v xdg-open >/dev/null 2>&1 && xdg-open "$url" >/dev/null 2>&1 || true ;;
esac

echo
ok "Ready! Opening ${url}"
echo "   Your projects live in: $(pwd)/copy-your-files-here/"
echo "   To stop it later: ./stop.sh or ./stop.command"
