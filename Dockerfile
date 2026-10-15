# syntax=docker/dockerfile:1.7
# =============================================================================
# Runtime machine - Production Dockerfile
# OpenCode engine (one `opencode acp`, ACP) + runtime gateway + one shared geocluster MCP.
# No editor, no VS Code.
# =============================================================================

# Source-pinned patched OpenCode: recipe, source digest, maintained patches and frozen upstream lock.
FROM oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73 AS opencode-engine-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git unzip python3 make g++ pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY opencode/engine/source-build.json opencode/engine/build.ts opencode/engine/*.patch /recipe/
RUN bun /recipe/build.ts --workdir=/build/opencode --output=/out

# Export with: docker build --target opencode-engine-artifact --output type=local,dest=/tmp/opencode-engine .
FROM scratch AS opencode-engine-artifact
COPY --from=opencode-engine-build /out/ /

# preprocessing_bundle is an explicit named build context captured by scripts/build-docker.sh.
FROM node:20-bookworm-slim AS preprocessing-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.11.17 /uv /usr/local/bin/uv
WORKDIR /build
ARG PREPROCESSING_BUNDLE_DIGEST
COPY --from=preprocessing_bundle source.tar identity.json ./
RUN test -n "$PREPROCESSING_BUNDLE_DIGEST" \
    && printf '%s  source.tar\n' "$PREPROCESSING_BUNDLE_DIGEST" | sha256sum --check \
    && tar -xf source.tar \
    && uv export --locked --no-dev --no-emit-project --format requirements-txt --output-file requirements.txt \
    && uv venv /build/build-env --python /usr/bin/python3 \
    && uv pip install --python /build/build-env/bin/python --only-binary :all: --require-hashes -r build-requirements.txt \
    && uv build --wheel --no-build-isolation --python /build/build-env/bin/python \
    && uv venv /opt/geocluster-preprocessing --python /usr/bin/python3.11 \
    && uv pip install --python /opt/geocluster-preprocessing/bin/python --only-binary :all: --require-hashes -r requirements.txt \
    && uv pip install --python /opt/geocluster-preprocessing/bin/python --no-deps dist/*.whl \
    && cp deployment/standalone/supervise.py /opt/geocluster-preprocessing/standalone-supervise.py \
    && cp identity.json /opt/geocluster-preprocessing/build-identity.json \
    && mkdir -p /opt/geocluster-preprocessing/legal \
    && for file in LICENSE LICENSE.txt NOTICE NOTICE.txt ThirdPartyNotices.txt; do \
         if [ -f "$file" ]; then cp "$file" /opt/geocluster-preprocessing/legal/; fi; \
       done \
    && chmod -R go-w /opt/geocluster-preprocessing

FROM node:20-bookworm-slim
ARG PREPROCESSING_BUNDLE_DIGEST
ENV PREPROCESSING_BUNDLE_DIGEST=${PREPROCESSING_BUNDLE_DIGEST}
LABEL org.geocluster.preprocessing.bundle.sha256=${PREPROCESSING_BUNDLE_DIGEST}

# Labels for container identification
LABEL maintainer="GeoCluster AI Team"
LABEL description="Runtime machine - geology agent (OpenCode over ACP) with file APIs"
LABEL version="4.0.0"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# ---- Install runtime dependencies ----
# - rclone: R2 file sync / private dataset hydration
# - inotify-tools: ordinary file sync watcher
# - curl: health probes, backend calls
# - procps: process management (ps command)
# - python3 + pip: ML clustering (scikit-learn)
# - libgdal-dev: geospatial data processing
# - git: the engine's project detection, user workflows
# - gosu: dropping privileges from root to non-root user
# - jq: manifest parsing in entrypoint.sh
# - ripgrep: the gateway's /files/search + /files/find and the agent's file search. Keep it
#   with OpenCode: its glob/grep use /usr/bin/rg; without it the engine downloads rg from GitHub
#   at runtime, unverified
# - pandoc + pango/cairo: markdown → DOCX/PDF report export (weasyprint)
# - poppler-utils: model-independent PDF text extraction from authorized read bytes
# - build-essential: build the pinned SQLite binding and safe-fs helper
# - libgomp1: OpenMP for the shared MCP (NUMBA_THREADING_LAYER=omp); explicit, it only arrived transitively
RUN apt-get update && apt-get install -y \
    rclone \
    inotify-tools \
    curl \
    procps \
    unzip \
    zip \
    git \
    python3 \
    python3-pip \
    python3-venv \
    gosu \
    acl \
    jq \
    ripgrep \
    libgdal-dev \
    libjson-c-dev \
    libproj-dev \
    libssl-dev \
    pkg-config \
    pandoc \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgdk-pixbuf2.0-0 \
    libffi-dev \
    libcairo2 \
    build-essential \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Install uv
COPY --from=ghcr.io/astral-sh/uv:0.11.17 /uv /usr/local/bin/uv
COPY --from=preprocessing-build --chown=root:root /opt/geocluster-preprocessing /opt/geocluster-preprocessing

# Install Python ML dependencies from requirements.txt
COPY requirements.txt /tmp/requirements.txt
RUN uv pip install --system --break-system-packages --no-cache -r /tmp/requirements.txt \
    && rm -rf /tmp/requirements.txt

# ---- Separate agent, file-service and parser identities ----
RUN groupadd -r -g 999 geocluster \
    && useradd -r -u 999 -g geocluster -m -d /home/geocluster geocluster \
    && useradd -r -u 998 -g geocluster -M -d /nonexistent -s /usr/sbin/nologin gc-files \
    && groupadd -r -g 997 gc-preview \
    && useradd -r -u 997 -g gc-preview -M -d /nonexistent -s /usr/sbin/nologin gc-preview \
    && groupadd -r -g 996 gc-preprocessing \
    && useradd -r -u 996 -g gc-preprocessing -M -d /nonexistent -s /usr/sbin/nologin gc-preprocessing \
    && usermod -aG gc-preprocessing gc-files

# Protected volume/runtime parents and separate log directories. Root never writes logs
# inside /var/log/runtime, where the agent could swap a log for a symlink.
RUN mkdir -p /workspace /etc/rclone /var/log/runtime /var/log/runtime-root /run/runtime /opt/geocluster-runtime \
    && chown root:root /workspace /opt /opt/geocluster-runtime \
    && chmod 755 /workspace /opt /opt/geocluster-runtime \
    && chown geocluster:geocluster /var/log/runtime \
    && chown root:root /var/log/runtime-root /run/runtime \
    && chmod 755 /var/log/runtime /var/log/runtime-root \
    && chmod 700 /run/runtime \
    && install -d -o gc-files -g geocluster -m 0750 /run/geocluster

# ---- MCP server (before the often-edited layers below: its ~1 GB uv sync layer stays cached) ----
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
COPY --chown=geocluster:geocluster geocluster-mcp/ /home/geocluster/mcp-server/
WORKDIR /home/geocluster/mcp-server
RUN rm -rf .venv && uv sync --locked && chown -R geocluster:geocluster .venv

WORKDIR /home/geocluster

# Model-independent PDF reads. Keep this after the cached Python/MCP environment.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# ---- OpenCode engine (source-pinned GeoCluster build) ----
# package-lock.json retains the official 2.0.19 regression baseline; production uses the source recipe above.
COPY --from=opencode-engine-build /out/opencode /opt/opencode/engine/bin/opencode
COPY --from=opencode-engine-build /out/build-identity.json /opt/opencode/engine/build-identity.json
COPY --from=opencode-engine-build /out/LICENSE /usr/share/doc/opencode/LICENSE
RUN ln -s /opt/opencode/engine/bin/opencode /usr/local/bin/opencode \
    && check=$(mktemp -d) \
    && env -i PATH="$PATH" HOME="$check" TMPDIR="$check" XDG_DATA_HOME="$check/data" XDG_CONFIG_HOME="$check/config" \
        XDG_STATE_HOME="$check/state" XDG_CACHE_HOME="$check/cache" OPENCODE_DISABLE_AUTOUPDATE=1 opencode --version \
    && rm -rf "$check" /root/.npm
# The upstream MIT notice and patched build identity ship with the binary.
COPY LICENSE NOTICE ThirdPartyNotices.txt /usr/share/doc/geocluster-runtime/

# ---- Agent config: root-owned, read-only to the agent (P6) ----
# Tool shells run as geocluster, the engine's own uid, so nothing the engine reads config from may be
# writable by it: config/ is OPENCODE_CONFIG_DIR (opencode.json, prompts, plugins, the empty model catalog);
# home/ and xdg-config/ are the engine's empty HOME (it reads ~/.claude, ~/.agents, ~/.gitconfig) and
# XDG_CONFIG_HOME (git's config). On the rootfs, not the volume: a root-owned folder inside a
# geocluster-owned one can be renamed away by its owner.
COPY opencode/config/ /opt/opencode/config/
COPY opencode/scripts/build-config.mjs /opt/opencode/scripts/build-config.mjs
RUN mkdir -p /opt/opencode/home /opt/opencode/xdg-config \
    && chown -R root:root /opt/opencode \
    && find /opt/opencode -type d -exec chmod 755 {} + \
    && find /opt/opencode/config -type f -exec chmod 644 {} +

# ---- Trusted runtime code: gateway, root gate and private file daemon ----
# The daemon and preview launcher require this fixed path. Install from the lockfile;
# SQLite's install script builds its native binding. build:native compiles safe-fs
# and the preview launcher before all runtime code becomes read-only to the agent.
COPY --chown=root:root runtime/package.json runtime/package-lock.json /opt/geocluster-runtime/
WORKDIR /opt/geocluster-runtime
RUN npm ci --omit=dev --no-audit --no-fund
# Install the same checksum-pinned projection grids as the overlay before native
# compilation and jail packaging. Keep downloads cached across runtime edits.
COPY --chown=root:root runtime/lib/gis-grids/build.mjs runtime/lib/gis-grids/grids.lock.json runtime/lib/gis-grids/LICENSE.txt /opt/geocluster-runtime/lib/gis-grids/
RUN node lib/gis-grids/build.mjs
COPY --chown=root:root runtime/ /opt/geocluster-runtime/
RUN npm run build:native \
    && chown -R root:root /opt/geocluster-runtime \
    && chmod -R go-w /opt/geocluster-runtime \
    && chmod 4755 /opt/geocluster-runtime/lib/preview-launcher/build/preview-launcher \
    && install -o root -g root -m 4755 /opt/geocluster-runtime/lib/workbook-launcher/build/workbook-launcher /opt/geocluster-runtime/workbook-launcher \
    && install -o root -g root -m 0555 /opt/geocluster-runtime/lib/workbook-launcher/build/workbook-policy.so /opt/geocluster-runtime/workbook-policy.so \
    && install -o root -g root -m 4755 /opt/geocluster-runtime/lib/gis-launcher/build/gis-launcher /opt/geocluster-runtime/gis-launcher \
    && install -o root -g root -m 0555 /opt/geocluster-runtime/lib/gis-launcher/build/gis-worker /opt/geocluster-runtime/gis-worker \
    && node lib/reader-jails/build.mjs \
    && rm -rf /root/.npm

# Set working directory
WORKDIR /home/geocluster

# ---- Seed data ----
# A fresh checkout has no bundled sample datasets. Keep the optional seed
# directory present; project uploads and dataset hydration supply actual data.
RUN mkdir -p /opt/seed-data/sample-data \
    && chown -R root:root /opt/seed-data && chmod -R go-w /opt/seed-data

# ---- Infrastructure ----
# Copy entrypoint script (runs as root: root-owned, not writable by the agent)
COPY --chown=root:root entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

# ---- Environment ----
ENV NODE_ENV=production
ENV SHELL=/bin/bash
ENV RUNTIME_FILES_PORT=3002
ENV FILES_AGENT_UIDS=999
ENV FILES_WORKER_UIDS=997
ENV FILES_WORKER_UID=997
ENV VOXEL_AGENT_ENABLED=true
ENV RUNTIME_DRAIN_TIMEOUT_S=240
ENV PREPROCESSING_ENABLED=false
ENV RUNTIME_AGGREGATE_ACTIVITY=false
STOPSIGNAL SIGTERM

# Expose ports: 3000 (access gate, public). The shared MCP (127.0.0.1:7710), the gateway
# (127.0.0.1:3001), file daemon (127.0.0.1:3002) and engine's private server (random port)
# are loopback-only.
EXPOSE 3000

# Frontends own health checks: native TUI has no access gate. Managed deployment
# templates install the HTTP check instead of inheriting it from the image.
HEALTHCHECK NONE

# NOTE: No USER directive here — entrypoint.sh runs as root to:
# 1. Configure rclone with secrets (writes to /etc/rclone/rclone.conf, mode 600)
# 2. Start background sync processes as root
# 3. Scrub all secret env vars
# 4. Drop privileges to 'geocluster' via gosu for the gateway; the gate stays root
# 5. Provision protected volume parents and run the file daemon as gc-files

# Volume for workspace persistence
VOLUME ["/workspace"]

# Entry point with R2 sync
ENTRYPOINT ["/entrypoint.sh"]

# Build identity (API-01, runtime/lib/build-info.js): the commit this image was built from, shown in
# /readyz.build. Last on purpose: a new value per commit must not invalidate the layers above.
# scripts/build-docker.sh and .github/workflows/fly-deploy.yml pass it (.dockerignore excludes .git).
ARG RUNTIME_BUILD_SHA=unknown
ENV RUNTIME_BUILD_SHA=${RUNTIME_BUILD_SHA}
