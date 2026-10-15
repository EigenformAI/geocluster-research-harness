#!/bin/bash
# =============================================================================
# Runtime image test: boots the image through its real entrypoint, offline,
# and checks the OpenCode layout.
#
#   IMAGE_NAME=geocluster-runtime IMAGE_TAG=latest scripts/test-docker.sh [--keep] [--skip-engine-smoke]
#
# Needs docker and node (>= 20) on the host; no model, token or network. All the
# checks live in runtime/test/image/image-test.mjs (one PASS/FAIL line each).
# For a long-running local instance use scripts/run-runtime-dev.sh instead.
# =============================================================================
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-geocluster-runtime}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec node "$ROOT/runtime/test/image/image-test.mjs" --image "${IMAGE_NAME}:${IMAGE_TAG}" "$@"
