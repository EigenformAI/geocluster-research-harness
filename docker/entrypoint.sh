#!/bin/bash
# =============================================================================
# Geocluster Research Harness — container entrypoint
#
# Startup sequence:
#   1. Prepare and seed the workspace (as root)
#   2. Start the geological MCP server (as 'theia' via gosu)
#   3. Write code-server user settings
#   4. Hide /proc from non-root users (best effort)
#   5. Drop privileges to 'theia' and start code-server + the local proxy
#
# This is a single-user container: the OPENROUTER_API_KEY env var (if set) is
# intentionally left in the environment so the agent extension can read it at
# activation and pre-configure the OpenRouter provider.
# =============================================================================

set -e

WORKSPACE_DIR="/workspace"
DEFAULTS_DIR="$WORKSPACE_DIR/defaults"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# =============================================================================
# Graceful shutdown
# =============================================================================
shutdown_handler() {
    log "Received shutdown signal, shutting down..."
    [ -n "$PROXY_PID" ] && kill $PROXY_PID 2>/dev/null || true
    [ -n "$IDE_PID" ] && kill $IDE_PID 2>/dev/null || true
    if [ -n "$MCP_PID" ]; then
        kill $MCP_PID 2>/dev/null || true
        sleep 1
    fi
    log "Shutdown complete"
    exit 0
}
trap shutdown_handler SIGTERM SIGINT SIGQUIT

# =============================================================================
# code-server user settings
# =============================================================================
write_ide_settings() {
    log "Writing code-server user settings..."
    local settings_dir="/home/theia/.local/share/code-server/User"
    mkdir -p "$settings_dir"
    cat > "$settings_dir/settings.json" << 'EOF'
{
    "security.workspace.trust.enabled": false,
    "workbench.colorTheme": "Default Dark Modern",
    "editor.tabSize": 4,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "workbench.startupEditor": "readme",
    "workbench.secondarySideBar.defaultVisibility": "visible",
    "chat.disableAIFeatures": true,
    "chat.agent.enabled": false,
    "chat.commandCenter.enabled": false,
    "extensions.supportNodeGlobalNavigator": true,
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "files.exclude": {
        "**/.clinerules": true
    }
}
EOF
    chown -R theia:theia /home/theia/.local/share/code-server
    log "code-server settings written"
}

# =============================================================================
# Geological MCP server
# =============================================================================
start_mcp_server() {
    log "Starting MCP server for geological analysis..."

    export MCP_WORKSPACE_ROOT="$WORKSPACE_DIR"
    log "MCP workspace root: $MCP_WORKSPACE_ROOT"

    (
        cd /home/theia/mcp-server
        gosu theia uv run python -u main.py 2>&1 | tee -a /var/log/theia/mcp-server.log
    ) &

    MCP_PID=$!
    log "MCP server started (PID: $MCP_PID)"

    log "Waiting for MCP server on port 7654..."
    for i in {1..15}; do
        if curl -s http://localhost:7654/sse --max-time 1 -o /dev/null 2>/dev/null; then
            log "MCP server is ready and accepting connections"
            return 0
        fi
        sleep 1
    done

    log "WARNING: MCP server may have failed to start, check /var/log/theia/mcp-server.log"
    tail -20 /var/log/theia/mcp-server.log 2>/dev/null || true
}

# =============================================================================
# Align theia's UID/GID with the host (PUID/PGID)
# =============================================================================
# We use bind mount to the host filesystem, so `chown -R theia:theia
# /workspace` below normally leaves those files owned by whatever UID 'theia'
# got at image build time — not the host user. Set PUID/PGID (see
# docker-compose.yml) to make files created in the container show up as owned
# by you on the host instead.
align_theia_uid_gid() {
    if [ -z "${PUID:-}" ] && [ -z "${PGID:-}" ]; then
        return 0
    fi

    if [ -n "${PGID:-}" ] && [ "$(id -g theia)" != "$PGID" ]; then
        log "Aligning theia's group to PGID=$PGID"
        groupmod -o -g "$PGID" theia
    fi
    if [ -n "${PUID:-}" ] && [ "$(id -u theia)" != "$PUID" ]; then
        log "Aligning theia's user to PUID=$PUID"
        usermod -o -u "$PUID" theia
    fi

    chown -R theia:theia /home/theia /var/log/theia
}

# =============================================================================
# Main
# =============================================================================
main() {
    log "========================================="
    log "Geocluster Research Harness starting (code-server)"
    log "Running as: $(whoami) (UID: $(id -u))"
    log "========================================="

    align_theia_uid_gid

    # Workspace (owned by theia, created by root)
    mkdir -p "$WORKSPACE_DIR"
    chown -R theia:theia /workspace

    # Seed the sample geology project as a self-contained project folder
    # (defaults/), same shape as any project a user drops in alongside it —
    # including its own .clinerules/.vscode, since Cline only reads those
    # from the root of whichever project folder is opened.
    if [ ! -e "$DEFAULTS_DIR" ] && [ -d /opt/seed-data ] && [ -n "$(ls -A /opt/seed-data 2>/dev/null)" ]; then
        mkdir -p "$DEFAULTS_DIR"
        cp -a /opt/seed-data/. "$DEFAULTS_DIR/"
        log "Seeded sample project into $DEFAULTS_DIR"
    fi

    # Seed the top-level workspace README (explains the multi-project layout
    # and the picker landing page), if not already present.
    if [ ! -e "$WORKSPACE_DIR/README.md" ] && [ -f /opt/seed-root-readme/README.md ]; then
        cp /opt/seed-root-readme/README.md "$WORKSPACE_DIR/README.md"
        log "Seeded workspace README"
    fi

    chown -R theia:theia "$WORKSPACE_DIR"

    log "Workspace ready: $WORKSPACE_DIR"

    # Make /root/ traversable so theia can reach uv's Python install
    # (/root/.local/share/uv/python/...). The mcp-server .venv symlinks point there.
    chmod 755 /root

    start_mcp_server
    write_ide_settings

    # Hide /proc from non-root users (best effort; needs a privileged runtime)
    mount -o remount,hidepid=2 /proc 2>/dev/null || log "NOTE: could not set hidepid=2 on /proc (fine for local use)"

    # =========================================================================
    # Drop privileges and start code-server as 'theia'
    # =========================================================================
    log "Dropping privileges to 'theia' and starting code-server..."

    # Ensure PATH includes standard binary directories so child processes
    # (e.g. the agent's `spawn('git', ...)`) find system binaries after gosu.
    export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

    # code-server on port 3001 (localhost only, behind the proxy on 3000).
    # --auth none is safe ONLY because port 3000 should never be exposed
    # beyond localhost — see the README security note.
    # NODE_OPTIONS preloads the navigator shim to prevent PendingMigrationError
    # in the extension host (code-server 4.109+ traps navigator access).
    export NODE_OPTIONS="--require /home/theia/navigator-shim.js"
    gosu theia code-server \
        --bind-addr 127.0.0.1:3001 \
        --auth none \
        --disable-telemetry \
        --disable-update-check \
        --disable-getting-started-override \
        "$WORKSPACE_DIR" &
    IDE_PID=$!
    log "code-server started (PID: $IDE_PID) on 127.0.0.1:3001"

    # Local reverse proxy on port 3000 (health check + WebSocket pass-through)
    node /home/theia/ide-proxy.js &
    PROXY_PID=$!
    log "ide-proxy started (PID: $PROXY_PID) on 0.0.0.0:3000"

    # If either process dies, shut everything down
    wait -n $IDE_PID $PROXY_PID
    EXIT_CODE=$?
    log "A process exited (code=$EXIT_CODE), shutting down..."
    kill $IDE_PID $PROXY_PID 2>/dev/null || true
    wait $IDE_PID $PROXY_PID 2>/dev/null || true
    exit $EXIT_CODE
}

main "$@"
