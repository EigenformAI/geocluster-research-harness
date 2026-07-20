# =============================================================================
# Geocluster Research Harness — production image
#
# Stage 1 (builder): builds the Geology Agent VSIX, the agent CLI bundle, and
#                    the helper extensions from source.
# Stage 2 (runtime): code-server + built extensions + geological MCP server.
#
# Nothing prebuilt is committed to the repo — a fresh clone builds everything:
#   git clone --recurse-submodules … && docker compose up --build
# =============================================================================

# =============================================================================
# Stage 1 — builder
# =============================================================================
FROM node:20 AS builder

WORKDIR /build

# ---- Agent (Cline fork) ----
COPY agent/ agent/
RUN cd agent && npm ci
RUN cd agent/webview-ui && npm ci
RUN cd agent/cli && npm ci

# Generate proto bindings (src/generated/ is not committed), then bundle and
# package the VSIX. Type-checking/esbuild of the full fork needs a larger
# old-space than the node default.
RUN cd agent && npm run protos && \
    NODE_OPTIONS=--max-old-space-size=4096 npm run package && \
    npx vsce package --allow-package-secrets sendgrid --no-dependencies --out /build/geology-agent.vsix

# CLI bundle — MUST come from the same source tree as the VSIX (the
# specialist-dispatch protocol between extension and CLI is version-coupled).
RUN cd agent && npm run cli:build:production && \
    mkdir -p /build/cline-cli && \
    cp -r agent/cli/dist /build/cline-cli/dist && \
    cp agent/cli/package.json /build/cline-cli/ && \
    if [ -f agent/cli/package-lock.json ]; then cp agent/cli/package-lock.json /build/cline-cli/; fi

# ---- Helper extensions (LAS/geology file viewers, CSV viewer) ----
COPY extensions/ extensions/
RUN cd extensions/geology-formats && npm ci && npm run package && \
    cp *.vsix /build/geology-formats.vsix
RUN cd extensions/csv-viewer && npm ci && npm run package && \
    cp *.vsix /build/csv-viewer.vsix

# =============================================================================
# Stage 2 — runtime
# =============================================================================
FROM node:20-slim

LABEL maintainer="EigenformAI"
LABEL description="Geocluster Research Harness — browser IDE with a geology-specialized AI agent"

# ---- Runtime dependencies ----
# - curl: health checks and code-server download
# - git: VCS operations (agent detectVcs, user workflows)
# - python3 + venv: workspace analysis scripts
# - libgdal-dev: geospatial data processing
# - gosu: privilege drop from root to non-root user
# - pandoc + cairo/pango libs: markdown -> DOCX/PDF report export (weasyprint)
RUN apt-get update && apt-get install -y \
    curl \
    procps \
    unzip \
    zip \
    git \
    python3 \
    python3-pip \
    python3-venv \
    gosu \
    jq \
    libgdal-dev \
    libsecret-1-0 \
    pandoc \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgdk-pixbuf2.0-0 \
    libffi-dev \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# ---- Install code-server ----
# IMPORTANT: the two patches below (Copilot removal, navigator-trap sed) and
# docker/navigator-shim.js are validated against EXACTLY this version. Bumping
# CODE_SERVER_VERSION requires re-validating all three.
ARG CODE_SERVER_VERSION=4.109.2
ARG TARGETARCH=amd64
RUN curl -fsSL https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-${TARGETARCH}.tar.gz \
    | tar -xz -C /opt && \
    ln -s /opt/code-server-${CODE_SERVER_VERSION}-linux-${TARGETARCH}/bin/code-server /usr/local/bin/code-server

# ---- Remove built-in Copilot/Chat extensions (the Geology Agent replaces them) ----
RUN EXTENSIONS_DIR="/opt/code-server-${CODE_SERVER_VERSION}-linux-${TARGETARCH}/lib/vscode/extensions" && \
    rm -rf "$EXTENSIONS_DIR"/github.copilot* \
           "$EXTENSIONS_DIR"/github-copilot* \
           "$EXTENSIONS_DIR"/chat* && \
    ls "$EXTENSIONS_DIR" | grep -iE 'copilot|chat' || echo "Built-in Copilot/Chat extensions removed"

# ---- Patch extensionHostProcess.js: disable navigator trap ----
# code-server 4.109+ installs a getter trap on globalThis.navigator that throws
# PendingMigrationError. This breaks extension dependencies (Anthropic SDK, Zod)
# that read navigator at module load time. The patch short-circuits the condition
# so the trap is never installed, leaving navigator undefined (normal Node.js).
RUN EH_FILE="/opt/code-server-${CODE_SERVER_VERSION}-linux-${TARGETARCH}/lib/vscode/out/vs/workbench/api/node/extensionHostProcess.js" && \
    if grep -q 'supportGlobalNavigator' "$EH_FILE" 2>/dev/null; then \
        sed -i 's/\.supportGlobalNavigator||/.supportGlobalNavigator||true||/' "$EH_FILE" && \
        echo "Patched navigator trap in extensionHostProcess.js"; \
    else \
        echo "WARNING: navigator trap pattern not found — re-validate against this code-server version"; \
    fi

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Python packages for workspace analysis scripts
COPY docker/requirements.txt /tmp/requirements.txt
RUN uv pip install --system --break-system-packages --no-cache -r /tmp/requirements.txt \
    && rm -rf /tmp/requirements.txt

# ---- Non-root user ----
RUN groupadd -r theia && useradd -r -g theia -m -d /home/theia theia
RUN mkdir -p /workspace /var/log/theia \
    && chown -R theia:theia /workspace /var/log/theia

WORKDIR /home/theia

# ---- Pre-create code-server config (suppress first-run auth setup) ----
RUN mkdir -p /home/theia/.config/code-server && \
    printf 'bind-addr: 127.0.0.1:3001\nauth: none\ncert: false\n' \
    > /home/theia/.config/code-server/config.yaml && \
    chown -R theia:theia /home/theia/.config/code-server

# ---- Install extensions built in stage 1 ----
COPY --from=builder --chown=theia:theia /build/geology-agent.vsix /tmp/extensions/
COPY --from=builder --chown=theia:theia /build/geology-formats.vsix /tmp/extensions/
COPY --from=builder --chown=theia:theia /build/csv-viewer.vsix /tmp/extensions/
USER theia
RUN for vsix in /tmp/extensions/*.vsix; do \
        echo "Installing extension: $vsix"; \
        code-server --install-extension "$vsix" || true; \
    done && rm -rf /tmp/extensions

# Verify the agent installed
RUN code-server --list-extensions | tee /dev/stderr | grep -q "eigenformai.geology-agent" || \
    (echo "FATAL: Geology Agent extension not installed" && exit 1)
USER root

# ---- Navigator shim for the code-server extension host ----
# The "extensions.supportNodeGlobalNavigator" setting only works in VS Code
# desktop. This preload script defines navigator before the trap is installed.
COPY --chown=theia:theia docker/navigator-shim.js /home/theia/navigator-shim.js

# ---- Seed the agent's MCP settings ----
RUN mkdir -p /home/theia/.local/share/code-server/User/globalStorage/eigenformai.geology-agent/settings
COPY --chown=theia:theia sample-workspace/.vscode/mcp.json \
    /home/theia/.local/share/code-server/User/globalStorage/eigenformai.geology-agent/settings/cline_mcp_settings.json
RUN chown -R theia:theia /home/theia/.local/share/code-server

# ---- Agent CLI (for specialist dispatch) ----
COPY --from=builder --chown=theia:theia /build/cline-cli/ /home/theia/cline-cli/
RUN ln -s /home/theia/cline-cli/dist/cli.mjs /usr/local/bin/cline && \
    chmod +x /home/theia/cline-cli/dist/cli.mjs && \
    cd /home/theia/cline-cli && \
    (npm install --production --ignore-scripts 2>/dev/null || npm install --production 2>/dev/null)

# ---- Geological MCP server (git submodule: EigenformAI/geocluster-mcp) ----
# If this COPY fails, the submodule is missing:
#   git submodule update --init
COPY --chown=theia:theia mcp-server/ /home/theia/mcp-server/
RUN chmod -R 777 /var/log/theia
WORKDIR /home/theia/mcp-server
RUN rm -rf .venv && uv sync && chown -R theia:theia .venv
WORKDIR /home/theia

# ---- Seed data (sample project) ----
# Stored outside /workspace/ because the volume mount hides image contents;
# entrypoint.sh copies it into the workspace on first start.
COPY --chown=theia:theia sample-workspace/ /opt/seed-data/

# ---- Entrypoint + proxy ----
COPY --chown=theia:theia docker/ide-proxy.js /home/theia/ide-proxy.js
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV SHELL=/bin/bash

# 3000: IDE (via ide-proxy), 7654: MCP server
EXPOSE 3000
EXPOSE 7654

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/healthz || exit 1

# NOTE: No USER directive — entrypoint.sh starts as root (workspace ownership,
# /proc hidepid) and drops to 'theia' via gosu before starting code-server.
VOLUME ["/workspace"]

ENTRYPOINT ["/entrypoint.sh"]
