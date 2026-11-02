#!/bin/bash
# =============================================================================
# GeologyIDE Docker Build Script
# Builds an image with pinned-release or explicit development processor sources.
# =============================================================================

set -e

# Configuration
IMAGE_NAME="${IMAGE_NAME:-geocluster-runtime}"
PREPROCESSING_BUILD_MODE="${PREPROCESSING_BUILD_MODE:-release}"
case "$PREPROCESSING_BUILD_MODE" in
    release) IMAGE_TAG="${IMAGE_TAG:-latest}" ;;
    development) IMAGE_TAG="${IMAGE_TAG:-local}" ;;
    *) echo "PREPROCESSING_BUILD_MODE must be release or development" >&2; exit 1 ;;
esac
REGISTRY="${REGISTRY:-}"
NO_CACHE="${NO_CACHE:-false}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Navigate to project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

log_info "Building GeologyIDE Docker image..."
log_info "Project root: $PROJECT_ROOT"
log_info "Image: ${IMAGE_NAME}:${IMAGE_TAG}"

# Build options
BUILD_OPTS="--progress=plain"

if [ "$NO_CACHE" = "true" ]; then
    BUILD_OPTS="$BUILD_OPTS --no-cache"
    log_info "Building without cache..."
fi

# Build identity for /readyz.build (the Dockerfile's last ARG): commit, plus -dirty for local changes
BUILD_SHA="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
if [ "$BUILD_SHA" != "unknown" ] && [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    BUILD_SHA="${BUILD_SHA}-dirty"
fi
log_info "Build sha: ${BUILD_SHA}"

# Build the image
log_info "Starting Docker build..."
# Release builds verify both the reviewed commit and exact production bytes.
# Explicit development builds retain working-tree changes without claiming a release.
PROCESSOR_SOURCE="${PREPROCESSING_SOURCE_DIR:?Set PREPROCESSING_SOURCE_DIR to the processor checkout}"
BUILD_TMP="${TMPDIR:-/tmp}"
if [ -z "${TMPDIR:-}" ] && [ -d /tmp/opencode ]; then BUILD_TMP=/tmp/opencode; fi
PROCESSOR_BUNDLE="${PREPROCESSING_BUILD_CONTEXT:-$(mktemp -d "$BUILD_TMP/preprocessing-bundle.XXXXXX")}"
python3 "$SCRIPT_DIR/preprocessing-bundle.py" --source "$PROCESSOR_SOURCE" --output "$PROCESSOR_BUNDLE" --mode "$PREPROCESSING_BUILD_MODE" >/dev/null
PROCESSOR_DIGEST="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["digest"])' "$PROCESSOR_BUNDLE/identity.json")"
PROCESSOR_REVISION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sourceRevision"])' "$PROCESSOR_BUNDLE/identity.json")"
log_info "Processor source mode: $PREPROCESSING_BUILD_MODE"
log_info "Processor bundle SHA-256: $PROCESSOR_DIGEST"
if [ "$PREPROCESSING_BUILD_MODE" = development ]; then
    log_warn "Local development processor bytes; not a verified release source."
fi
docker buildx build --load $BUILD_OPTS \
    --build-context preprocessing_bundle="$PROCESSOR_BUNDLE" \
    --build-arg PREPROCESSING_BUNDLE_DIGEST="$PROCESSOR_DIGEST" \
    --build-arg PREPROCESSING_BUILD_MODE="$PREPROCESSING_BUILD_MODE" \
    --build-arg PREPROCESSING_SOURCE_REVISION="$PROCESSOR_REVISION" \
    --build-arg RUNTIME_BUILD_SHA="$BUILD_SHA" \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    -f Dockerfile \
    .

# Tag for registry if specified
if [ -n "$REGISTRY" ]; then
    FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
    log_info "Tagging for registry: $FULL_IMAGE"
    docker tag "${IMAGE_NAME}:${IMAGE_TAG}" "$FULL_IMAGE"
fi

# Show image info
log_info "Build complete!"
docker images "${IMAGE_NAME}:${IMAGE_TAG}"

# Show image size
SIZE=$(docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format "{{.Size}}")
log_info "Image size: $SIZE"

# Optimization suggestions
if [[ "$SIZE" == *"GB"* ]]; then
    log_warn "Image size is large. Consider:"
    log_warn "  - Using multi-stage build (already implemented)"
    log_warn "  - Reducing node_modules with yarn --production"
    log_warn "  - Using node:20-alpine as base image"
fi

log_info "Done! To run locally: ./scripts/run-runtime-tui.sh --image ${IMAGE_NAME}:${IMAGE_TAG}"
