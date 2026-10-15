#!/bin/bash
# =============================================================================
# Runtime machine entrypoint
# R2 sync, private datasets, then the runtime gateway (one OpenCode engine over
# ACP, one shared MCP server, file APIs) behind the root access gate.
#
# Security model:
#   Phase A — Configure services as root (secrets available)
#   Phase B — Scrub secrets from environment
#   Phase C — Hide /proc from non-root (hidepid)
#   Phase D — Drop privileges to 'geocluster' for the gateway; the gate stays root
# =============================================================================

set -e
umask 0022

# Configuration from environment variables
PROJECT_ID="${PROJECT_ID:-default}"
USER_ID="${USER_ID:-anonymous}"
R2_BUCKET="${R2_BUCKET_NAME:-${R2_BUCKET:-geocluster-data}}"
R2_ENDPOINT="${R2_ENDPOINT_URL:-${R2_ENDPOINT:-}}"
R2_ACCESS_KEY="${R2_ACCESS_KEY_ID:-${R2_ACCESS_KEY:-}}"
R2_SECRET_KEY="${R2_SECRET_ACCESS_KEY:-${R2_SECRET_KEY:-}}"
SYNC_ENABLED="${SYNC_ENABLED:-false}"
SYNC_INTERVAL="${SYNC_INTERVAL:-30}"  # seconds between syncs
FILES_SYNC_ADAPTER="${FILES_SYNC_ADAPTER:-false}"
WORKSPACE_DIR="/workspace/${PROJECT_ID}"
LOG_DIR="/var/log/runtime"           # geocluster: the gateway's, the engine's and the MCP's logs
# Root's own logs (rclone, datasets). Root-owned, never chowned: a log file
# root opens inside a folder geocluster can write could be swapped for a symlink,
# and root would then create or append to any file on the machine.
ROOT_LOG_DIR="/var/log/runtime-root"

# Private datasets: read-only copies of R2 datasets this workspace receives
# (backend: app/services/private_datasets.py, docs/PRIVATE_DATASETS.md).
# The machine never holds a standing key for the private bucket. At boot it
# presents IDE_DATASET_TOKEN to IDE_DATASETS_URL, receives per-dataset
# temporary credentials (prefix-scoped, read-only, short TTL), copies each tree
# into $DATASETS_DIR/<slug>/ in the background, then forgets the credentials.
# Both env vars are scrubbed in Phase B. Absent token = feature off.
DATASETS_DIR="$WORKSPACE_DIR/datasets"
DATASETS_STAGING="$WORKSPACE_DIR/.datasets-staging"   # copy lands here, then one atomic rename
DATASETS_CONF="/etc/rclone/datasets.conf"             # root:root 600, removed after each pass
DATASETS_MANIFEST="/run/datasets.json"                # root-only copy of the endpoint response
DATASETS_LOG="$ROOT_LOG_DIR/datasets.log"
DATASETS_STATE_DIR="/run/runtime/datasets-status"     # root-only: one status line per slug (the source of both files)
DATASETS_PID=""

# Root-owned rclone config path (not readable by geocluster user)
RCLONE_CONF="/etc/rclone/rclone.conf"

# Access gate (runtime/gate.cjs, root): write_gate_key() moves the backend-issued
# per-project IDE_PROXY_KEY into a root-only file and removes the variable from
# the environment. The gate secret (write_gate_secret) is a per-boot random
# value the gate sends upstream as X-GC-Gate and the gateway demands on every
# request, so the agent (same uid as the gateway) cannot drive 127.0.0.1:3001.
RUN_DIR="/run/runtime"
GATE_KEY_FILE="$RUN_DIR/key"
GATE_SECRET_FILE="$RUN_DIR/gate"
GATE_SECRET=""
FILES_CONTROL_FILE="$RUN_DIR/files-control"
FILES_INPUT_FILE="$RUN_DIR/files-input"
RUNTIME_CODE_DIR="/opt/geocluster-runtime"

# Runtime state on the volume: the engine's database, logs and caches (its XDG
# data/state/cache dirs) and the gateway's per-conversation event logs. Outside
# $WORKSPACE_DIR (hidden from the file API, the MCP path jail and the R2 sync);
# geocluster-only. cline/ (api-1/2 conversations) is only read, as the archive.
RUNTIME_STATE_ROOT="/workspace/.runtime"
MANAGED_CATALOG_PATH="${RUNTIME_MANAGED_CATALOG_PATH:-$RUNTIME_STATE_ROOT/managed-catalog.json}"
ENGINE_STATE_DIR="$RUNTIME_STATE_ROOT/opencode"
GATEWAY_STATE_DIR="$RUNTIME_STATE_ROOT/gateway"
DATASETS_STATUS_DIR="$GATEWAY_STATE_DIR/datasets"
DATASETS_STATUS="$DATASETS_STATUS_DIR/STATUS.md"       # private progress, outside project files
DATASETS_STATUS_JSON="$DATASETS_STATUS_DIR/status.json" # machine-readable copy for the gateway's /readyz
CONVERSATIONS_DIR="$RUNTIME_STATE_ROOT/conversations"
FILES_STATE_DIR="${FILES_STATE_DIR:-$RUNTIME_STATE_ROOT/file-service/$PROJECT_ID}"
FILES_AGENT_UIDS="${FILES_AGENT_UIDS:-999}"
FILES_WORKER_UIDS="${FILES_WORKER_UIDS:-997}"
FILES_WORKER_UID="${FILES_WORKER_UID:-997}"
FILES_TRASH_AVAILABLE="${FILES_TRASH_AVAILABLE:-true}"
FILES_LIMITS="${FILES_LIMITS:-}"
FILES_WORKBOOK_WORKER_BIN="${FILES_WORKBOOK_WORKER_BIN:-/opt/geocluster-runtime/workbook-launcher}"
FILES_WORKBOOK_WORKER_ENABLED="${FILES_WORKBOOK_WORKER_ENABLED:-true}"
FILES_GIS_WORKER_BIN="${FILES_GIS_WORKER_BIN:-/opt/geocluster-runtime/gis-launcher}"
FILES_GIS_WORKER_ENABLED="${FILES_GIS_WORKER_ENABLED:-true}"
VOXEL_LIMITS="${VOXEL_LIMITS:-}"
RUNTIME_DRAIN_TIMEOUT_S="${RUNTIME_DRAIN_TIMEOUT_S:-240}"
PREPROCESSING_ENABLED="${PREPROCESSING_ENABLED:-false}"
RUNTIME_AGGREGATE_ACTIVITY="${RUNTIME_AGGREGATE_ACTIVITY:-false}"
PREPROCESSING_RUN_DIR="$RUN_DIR/preprocessing"
PREPROCESSING_INBOX_DIR="$RUNTIME_STATE_ROOT/preprocessing/$PROJECT_ID/inbox"
PREPROCESSING_TOKEN_FILE="$PREPROCESSING_RUN_DIR/service-token"
PREPROCESSING_URL="http://127.0.0.1:${PREPROCESSING_PORT:-8765}"
GATEWAY_INPUT_FILE="$RUN_DIR/gateway-input"
LIFECYCLE_DIR="$RUNTIME_STATE_ROOT/lifecycle"
LEGACY_STATE_ROOT="/workspace/.ide-state"             # code-server era; archived, never read

# The engine's config, HOME and XDG_CONFIG_HOME: root-owned in the image, so a tool
# shell (the engine's own uid) cannot plant config for the next start.
# The gateway and the gate run from
# RUNTIME_CODE_DIR, also root-owned.
OPENCODE_BIN="/usr/local/bin/opencode"
OPENCODE_ROOT="/opt/opencode"

GATEWAY_PORT=3001
GATE_PORT=3000
FILES_PORT="${RUNTIME_FILES_PORT:-3002}"
GATEWAY_PID=""
MACHINE_GATEWAY_PID=""
MACHINE_TOKEN_FILE=""
MACHINE_CREDENTIALS_URL=""
MACHINE_CREDENTIALS_FILE=""
MACHINE_GATEWAY_PORT="${RUNTIME_MACHINE_GATEWAY_PORT:-3003}"
GATE_PID=""
FILES_PID=""
LIFECYCLE_PID=""
WATCHER_PID=""
GATEWAY_PROBE_PID=""
SHUTDOWN_STARTED="false"
WORKSPACE_PREPARED="false"

# MCP server: the gateway starts ONE shared server for every conversation
# (127.0.0.1:7710, Streamable HTTP; runtime/lib/mcp-supervisor.js).

# OOM-killer preference (before service startup): the gateway and the gate should
# be the last processes the kernel kills; the gateway raises the engine to +300
# and the MCP to +500, and tool processes inherit the engine's (runtime/lib/config.js).
# Lowering needs CAP_SYS_RESOURCE (Fly VMs have it, default Docker does not:
# then only the raised side applies).
CORE_OOM_SCORE_ADJ=-900

# Secret variables no geocluster-owned process may inherit (VULNERABILITIES_FIXING.md
# #16). scrub_secrets unsets them (plus any other R2_*/OPENROUTER_* name) before
# Phase D; geocluster processes started earlier go
# through run_as_geocluster, which removes them from the child's environment.
SECRET_ENV_VARS=(
    IDE_PROXY_KEY
    IDE_MACHINE_TOKEN IDE_MACHINE_TOKEN_FILE IDE_MACHINE_CREDENTIALS_URL IDE_MACHINE_CREDENTIALS_FILE
    R2_ENDPOINT R2_ENDPOINT_URL R2_ACCESS_KEY R2_ACCESS_KEY_ID
    R2_SECRET_KEY R2_SECRET_ACCESS_KEY R2_BUCKET_NAME R2_BUCKET
    OPENROUTER_API_KEY
    IDE_DATASET_TOKEN IDE_DATASETS_URL
    IDE_FILES_TOKEN IDE_WORK_TOKEN RUNTIME_FILES_URL RUNTIME_FILE_WORK_URL
    PREPROCESSING_PROXY_TOKEN PREPROCESSING_TOKEN
)
# Kept through Phase B for the gateway only (it reports agent activity to the
# backend). Never given to the MCP server or the agent: run_as_geocluster strips it
# and the gateway forwards an explicit env whitelist to the agent process.
GATEWAY_ONLY_ENV_VARS=(RUNTIME_ACTIVITY_TOKEN IDE_LLM_TOKEN)

# Boot timing (boot_step): milliseconds since the entrypoint started
BOOT_START_MS=0
BOOT_LAST_MS="$BOOT_START_MS"

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Boot timing: "[boot] step=<name> ms=<since previous step> total_ms=<since start>".
# Never fails the boot: without millisecond date support the line is skipped.
boot_step() {
    local now
    now=$(date +%s%3N 2>/dev/null) || return 0
    case "$now$BOOT_START_MS$BOOT_LAST_MS" in
        ''|*[!0-9]*) return 0 ;;
    esac
    log "[boot] step=$1 ms=$((now - BOOT_LAST_MS)) total_ms=$((now - BOOT_START_MS))"
    BOOT_LAST_MS="$now"
}

# wait_for_tcp <host> <port> <timeout_s>: 0 as soon as the port accepts a TCP
# connection (probed every 0.1 s), 1 after the timeout. Bash /dev/tcp reads
# nothing, so an endpoint that never closes (the MCP SSE stream) cannot stall it.
wait_for_tcp() {
    local host="$1" port="$2" timeout_s="$3"
    local attempts=$((timeout_s * 10)) i=0
    while [ "$i" -lt "$attempts" ]; do
        if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
            return 0
        fi
        sleep 0.1
        i=$((i + 1))
    done
    return 1
}

# ensure_real_dir <path>: make <path> a real directory owned by geocluster.
# The volume is geocluster-writable, so a tool shell can leave a symlink or a
# file where root expects a folder. Root must never resolve such a name: a
# mkdir or chown through a planted link acts on its target (any path on the
# machine), and a non-folder would stop the boot under `set -e`. Whatever is
# there is moved aside (mv -T renames a link itself, never its target).
# Call it top-down (parents first), and only before any geocluster process
# runs at this boot: later, a swap between the check and the use would race.
ensure_real_dir() {
    local owner
    clear_non_dir "$1" && mkdir -p "$1" || return 1
    owner=$(stat -c '%U:%G' -- "$1") || return 1
    if [ "$owner" != "geocluster:geocluster" ]; then
        chown -h geocluster:geocluster "$1"
    fi
}

# clear_non_dir <path>: move aside a symlink or non-folder at <path>; create nothing.
clear_non_dir() {
    local dir="$1" aside
    if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -d "$dir" ]; }; then
        aside="$dir.invalid-$(date -u +%Y%m%d%H%M%S)"
        if ! mv -T "$dir" "$aside"; then
            log "WARNING: $dir is a symlink or not a folder and could not be moved aside"
            return 1
        fi
        log "WARNING: $dir was a symlink or not a folder: moved aside to $aside"
    fi
}

# write_as_geocluster <file>: write stdin to <file> (temp file + rename) as
# geocluster. For root's background loops that update files in the workspace
# while tool shells run: a link planted there resolves with geocluster's rights.
write_as_geocluster() {
    run_as_geocluster sh -c 'cat > "$1.tmp" && mv -f "$1.tmp" "$1"' write_as_geocluster "$1"
}

# run_as_geocluster <cmd...>: `gosu geocluster <cmd...>` with SECRET_ENV_VARS,
# GATEWAY_ONLY_ENV_VARS and any R2_*/OPENROUTER_* name removed from the child's
# environment, so the geocluster process's /proc/<pid>/environ holds no secrets even
# when the caller (a Phase A subshell) still does; hidepid=2 does not hide a
# user's own processes. Only the child is affected.
supplier_credential_name() {
    case "$1" in
        OPENROUTER_*|*_API_KEY|*_AUTH_TOKEN|*_ACCESS_TOKEN|ANTHROPIC_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|AZURE_CLIENT_SECRET) return 0 ;;
        *) return 1 ;;
    esac
}

run_as_geocluster() {
    local args=() name
    for name in "${SECRET_ENV_VARS[@]}" "${GATEWAY_ONLY_ENV_VARS[@]}" $(compgen -e | grep -E '^R2_' || true); do
        args+=(-u "$name")
    done
    for name in $(compgen -e); do
        if supplier_credential_name "$name"; then args+=(-u "$name"); fi
    done
    ( umask 0002; exec env "${args[@]}" gosu geocluster "$@" ) 9>&-
}

# Aligned machine file/work endpoints select the managed owner before any legacy writer starts.
configure_workspace_sync() {
    if [ -n "${RUNTIME_FILES_URL:-}" ] && [ -n "${RUNTIME_FILE_WORK_URL:-}" ]; then
        FILES_SYNC_ADAPTER="true"
    fi
    if [ "$FILES_SYNC_ADAPTER" = "true" ]; then
        [ -n "${RUNTIME_FILES_URL:-}" ] && [ -n "${RUNTIME_FILE_WORK_URL:-}" ] && [ -n "${IDE_MACHINE_CREDENTIALS_URL:-}" ] || { log "ERROR: Aligned file sync requires file/work endpoints and renewable machine credentials"; return 1; }
        SYNC_ENABLED="false"
        log "[files] Managed cloud import selected; legacy workspace download, watcher and final sync disabled"
    fi
}

# =============================================================================
# R2 Configuration (runs as root, writes to /etc/rclone)
# =============================================================================
configure_rclone() {
    if [ -z "$R2_ENDPOINT" ] || [ -z "$R2_ACCESS_KEY" ] || [ -z "$R2_SECRET_KEY" ]; then
        log "WARNING: R2 credentials not configured, file sync disabled"
        SYNC_ENABLED="false"
        return 0
    fi

    log "Configuring rclone for R2 storage..."

    # Write rclone config to root-owned path (not readable by geocluster)
    mkdir -p /etc/rclone
    cat > "$RCLONE_CONF" << EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY}
secret_access_key = ${R2_SECRET_KEY}
endpoint = ${R2_ENDPOINT}
acl = private
EOF
    chmod 600 "$RCLONE_CONF"
    chown root:root "$RCLONE_CONF"

    log "rclone configured at $RCLONE_CONF (root:root, mode 600)"
}

# =============================================================================
# Initial Sync from R2 to Local
# =============================================================================
sync_from_r2() {
    if [ "$FILES_SYNC_ADAPTER" = "true" ] || [ "$SYNC_ENABLED" != "true" ]; then
        log "Sync disabled, skipping R2 download"
        return 0
    fi

    log "Syncing files from R2 to local workspace..."

    # Create workspace directory if not exists
    mkdir -p "$WORKSPACE_DIR"

    # Sync from R2 (download only newer files)
    rclone sync "r2:${R2_BUCKET}/projects/${PROJECT_ID}/" "$WORKSPACE_DIR/" \
        --config "$RCLONE_CONF" \
        --transfers 8 \
        --checkers 16 \
        --contimeout 60s \
        --timeout 300s \
        --retries 3 \
        --low-level-retries 10 \
        --stats-log-level NOTICE \
        --log-file "$ROOT_LOG_DIR/rclone-download.log" \
        2>&1 || {
            log "WARNING: Initial R2 sync failed, continuing with empty workspace"
        }

    log "R2 download complete"
}

# =============================================================================
# Sync from Local to R2 (upload changes)
# =============================================================================
sync_to_r2() {
    if [ "$FILES_SYNC_ADAPTER" = "true" ] || [ "$SYNC_ENABLED" != "true" ]; then
        return 0
    fi

    log "Syncing changes to R2..."

    # Private datasets are never pushed back to the project prefix.
    rclone sync "$WORKSPACE_DIR/" "r2:${R2_BUCKET}/projects/${PROJECT_ID}/" \
        --config "$RCLONE_CONF" \
        --exclude 'datasets/**' \
        --exclude '.datasets-staging/**' \
        --transfers 4 \
        --checkers 8 \
        --contimeout 60s \
        --timeout 300s \
        --retries 3 \
        --stats-log-level NOTICE \
        --log-file "$ROOT_LOG_DIR/rclone-upload.log" \
        2>&1 || {
            log "WARNING: R2 upload sync failed"
        }
}

# =============================================================================
# Background File Watcher for Auto-Sync (runs as root to access rclone config)
# =============================================================================
start_file_watcher() {
    if [ "$FILES_SYNC_ADAPTER" = "true" ] || [ "$SYNC_ENABLED" != "true" ]; then
        log "Sync disabled, file watcher not started"
        return 0
    fi

    log "Starting background file watcher..."

    # Debounced sync - waits for file activity to settle
    (
        LAST_SYNC=0

        while true; do
            # Wait for file changes or timeout (private dataset trees excluded)
            inotifywait -r -q -e modify,create,delete,move \
                --timeout "$SYNC_INTERVAL" \
                --exclude "^$WORKSPACE_DIR/(datasets|\.datasets-staging)(/|$)" \
                "$WORKSPACE_DIR" 2>/dev/null || true

            CURRENT_TIME=$(date +%s)
            TIME_SINCE_SYNC=$((CURRENT_TIME - LAST_SYNC))

            # Only sync if enough time has passed (debounce)
            if [ $TIME_SINCE_SYNC -ge 10 ]; then
                sync_to_r2
                LAST_SYNC=$CURRENT_TIME
            fi
        done
    ) &

    WATCHER_PID=$!
    log "File watcher started (PID: $WATCHER_PID)"
}

# =============================================================================
# Private datasets (runs as root: presents the dataset token, writes /etc/rclone)
# =============================================================================
# Contract with the backend (GET $IDE_DATASETS_URL, Bearer $IDE_DATASET_TOKEN):
#   200 {"datasets":[{slug, version, bucket, prefix, endpoint_url, size_bytes,
#        file_count, expires_at, credentials:{access_key_id, secret_access_key,
#        session_token}}]}   — empty list = nothing granted (stamped dirs get removed)
#   401/403                  — token expired/invalid: keep what is on the volume
#   5xx / no answer          — retry with back-off, then keep what is on the volume
# Each dataset is copied to $DATASETS_STAGING/<slug>/ and renamed into
# $DATASETS_DIR/<slug>/ only when complete, so the agent never sees a half tree.
# $DATASETS_DIR/<slug>/.dataset.json is the stamp (version) that makes re-boots
# idempotent and marks directories this script may remove on revocation.

# JSON string escape for the few characters our own status lines can contain.
json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Machine-readable status for the gateway's /readyz: overall state + per-dataset lines.
# Overall: error if any dataset errored, hydrating while any copy runs, else ready
# (or idle when nothing is granted / the hydrator never ran).
# Both status files are built by root from its own root-only lines and written
# into private gateway state as geocluster (write_as_geocluster): the hydrator
# runs next to tool shells, so root does not open agent-writable status paths.
datasets_status_json() {
    local forced="${1:-}" state="idle" f slug line entries=""
    for f in "$DATASETS_STATE_DIR"/*; do
        [ -f "$f" ] || continue
        slug=$(basename "$f")
        line=$(cat "$f")
        entries="${entries:+$entries,}{\"slug\":\"$(json_escape "$slug")\",\"status\":\"$(json_escape "$line")\"}"
        case "$line" in
            error*) state="error" ;;
            copying*|waiting*) [ "$state" = "error" ] || state="hydrating" ;;
            *) [ "$state" = "idle" ] && state="ready" ;;
        esac
    done
    [ -n "$forced" ] && state="$forced"
    printf '{"state":"%s","updatedAt":"%s","datasets":[%s]}\n' \
        "$state" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$entries" | write_as_geocluster "$DATASETS_STATUS_JSON" \
        || log "WARNING: [datasets] could not write $DATASETS_STATUS_JSON"
}

# Rewrite one dataset's status line and regenerate STATUS.md + .status.json.
datasets_status() {
    local slug="$1" line="$2"
    ( umask 077 && mkdir -p "$DATASETS_STATE_DIR" && echo "$line" > "$DATASETS_STATE_DIR/$slug" )
    {
        echo "# Private datasets"
        echo
        echo "Datasets granted to this workspace are copied into \`datasets/<slug>/\` at boot."
        echo "A dataset directory appears only once its copy is complete; until then its state is listed here."
        echo "Updated $(date -u '+%Y-%m-%dT%H:%M:%SZ')."
        echo
        local f
        for f in "$DATASETS_STATE_DIR"/*; do
            [ -f "$f" ] && echo "- **$(basename "$f")**: $(cat "$f")"
        done
    } | write_as_geocluster "$DATASETS_STATUS" || log "WARNING: [datasets] could not write $DATASETS_STATUS"
    datasets_status_json
}

# Reset on every boot, including boots without a dataset token or with delayed
# demo hydration. Only the per-slug source lives in root-controlled /run.
prepare_dataset_status() {
    clear_non_dir "$DATASETS_STATUS_DIR"
    run_as_geocluster mkdir -p -m 0700 "$DATASETS_STATUS_DIR"
    run_as_geocluster chmod 0700 "$DATASETS_STATUS_DIR"
    run_as_geocluster rm -f "$DATASETS_STATUS" || log "WARNING: [datasets] could not clear $DATASETS_STATUS; continuing boot"
    ( umask 077; rm -rf "$DATASETS_STATE_DIR"; mkdir -p "$DATASETS_STATE_DIR" )
    datasets_status_json idle
}

# Remove only recognizable generated status from retained workspaces. Inspect
# and unlink as the project user, and never traverse a symlinked dataset root.
cleanup_dataset_workspace_status() {
    run_as_geocluster sh -c '
        dir="$1"
        [ -d "$dir" ] && [ ! -L "$dir" ] || exit 0
        for name in .status.json STATUS.md; do
            file="$dir/$name"
            [ -f "$file" ] && [ ! -L "$file" ] || continue
            bytes=$(stat -c %s -- "$file") || continue
            [ "$bytes" -le 65536 ] || continue
            if [ "$name" = .status.json ]; then
                jq -e '\''type == "object" and
                    (.state == "idle" or .state == "hydrating" or .state == "ready" or .state == "error") and
                    (.datasets | type == "array") and
                    (.updatedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*Z$"))'\'' "$file" >/dev/null 2>&1 || continue
            else
                IFS= read -r heading < "$file" || continue
                [ "$heading" = "# Private datasets" ] || continue
                grep -qFx '\''Datasets granted to this workspace are copied into `datasets/<slug>/` at boot.'\'' "$file" || continue
            fi
            rm -f -- "$file"
        done
        rmdir -- "$dir" 2>/dev/null || true
    ' cleanup-dataset-status "$DATASETS_DIR"
}

# Fetch the entitlement manifest. Returns 0 = manifest written; 1 = no token;
# 2 = token rejected (401/403); 3 = backend unavailable / malformed.
fetch_dataset_entitlements() {
    if [ -z "${IDE_DATASET_TOKEN:-}" ] || [ -z "${IDE_DATASETS_URL:-}" ]; then
        return 1
    fi
    local attempt code delay
    for attempt in 1 2 3 4; do
        code=$(curl -sS --max-time 30 -o "$DATASETS_MANIFEST.tmp" -w '%{http_code}' \
            -H "Authorization: Bearer $IDE_DATASET_TOKEN" "$IDE_DATASETS_URL" 2>>"$DATASETS_LOG" || echo "000")
        case "$code" in
            200)
                chmod 600 "$DATASETS_MANIFEST.tmp"
                if ! jq -e '.datasets | type == "array"' "$DATASETS_MANIFEST.tmp" >/dev/null 2>&1; then
                    log "WARNING: [datasets] Malformed manifest from backend: keeping existing datasets"
                    rm -f "$DATASETS_MANIFEST.tmp"
                    return 3
                fi
                mv "$DATASETS_MANIFEST.tmp" "$DATASETS_MANIFEST"
                return 0 ;;
            401|403)
                log "WARNING: [datasets] Dataset token rejected (HTTP $code): keeping existing datasets"
                rm -f "$DATASETS_MANIFEST.tmp"
                return 2 ;;
        esac
        rm -f "$DATASETS_MANIFEST.tmp"
        if [ "$attempt" -lt 4 ]; then
            case "$attempt" in 1) delay=10 ;; 2) delay=30 ;; *) delay=60 ;; esac
            log "WARNING: [datasets] Backend answered HTTP $code (attempt $attempt/4), retrying in ${delay}s"
            sleep "$delay"
        fi
    done
    log "WARNING: [datasets] Backend unavailable after 4 attempts: keeping existing datasets"
    return 3
}

# Copy one dataset from the manifest. Returns 0 = ready (or already current), 1 = not this time.
hydrate_one_dataset() {
    local slug="$1"
    # The slug becomes a directory name; the backend constrains it to [a-z0-9-], re-check here.
    case "$slug" in ""|*[!a-z0-9-]*) log "WARNING: [datasets] Refusing slug '$slug'"; return 1 ;; esac

    local entry version bucket prefix endpoint size_bytes file_count
    entry=$(jq -c --arg s "$slug" '.datasets[] | select(.slug == $s)' "$DATASETS_MANIFEST")
    version=$(jq -r '.version' <<<"$entry")
    bucket=$(jq -r '.bucket' <<<"$entry")
    prefix=$(jq -r '.prefix' <<<"$entry")
    endpoint=$(jq -r '.endpoint_url' <<<"$entry")
    size_bytes=$(jq -r '.size_bytes // 0' <<<"$entry")
    file_count=$(jq -r '.file_count // 0' <<<"$entry")

    local dest="$DATASETS_DIR/$slug"
    # Read as geocluster: the stamp sits in a geocluster-writable folder
    if [ "$(run_as_geocluster jq -r '.version' "$dest/.dataset.json" 2>/dev/null)" = "$version" ]; then
        datasets_status "$slug" "ready — version $version (already on this volume)"
        return 0
    fi

    # Space: the dataset plus 10 % (staging lives on the same volume).
    local avail need
    avail=$(df --output=avail -B1 "$WORKSPACE_DIR" 2>/dev/null | tail -1 | tr -d ' ')
    need=$(( size_bytes + size_bytes / 10 ))
    if [ -n "$avail" ] && [ "$avail" -lt "$need" ] 2>/dev/null; then
        log "WARNING: [datasets] $slug needs $need bytes, volume has $avail free: skipping (volume grows on next restart)"
        datasets_status "$slug" "waiting — insufficient space (need $((need / 1048576)) MB, have $((avail / 1048576)) MB); the volume grows on the next restart"
        return 1
    fi

    # Temporary credentials -> root-only rclone remote (session_token = STS-style creds).
    local ak sk st
    ak=$(jq -r '.credentials.access_key_id' <<<"$entry")
    sk=$(jq -r '.credentials.secret_access_key' <<<"$entry")
    st=$(jq -r '.credentials.session_token' <<<"$entry")
    ( umask 077; cat >> "$DATASETS_CONF" << EOF
[ds_${slug}]
type = s3
provider = Cloudflare
access_key_id = ${ak}
secret_access_key = ${sk}
session_token = ${st}
endpoint = ${endpoint}
acl = private
EOF
    )
    chmod 600 "$DATASETS_CONF"
    chown root:root "$DATASETS_CONF"

    datasets_status "$slug" "copying — version $version, $((size_bytes / 1048576)) MB, $file_count files (started $(date -u '+%H:%M') UTC)"
    log "[datasets] Copying $slug (${bucket}/${prefix}, ~$((size_bytes / 1048576)) MB) -> $DATASETS_STAGING/$slug"
    mkdir -p "$DATASETS_STAGING/$slug"
    # Directory-mode copy only (single-file copyto HEADs the key first and R2 tokens
    # answer 403). `copy` never deletes; a reboot mid-copy resumes.
    if ! rclone copy "ds_${slug}:${bucket}/${prefix}" "$DATASETS_STAGING/$slug/" \
        --config "$DATASETS_CONF" \
        --transfers 16 \
        --checkers 32 \
        --contimeout 60s \
        --timeout 300s \
        --retries 3 \
        --low-level-retries 10 \
        --stats 30s \
        --stats-log-level NOTICE \
        --log-file "$DATASETS_LOG" 2>&1; then
        log "WARNING: [datasets] Copy of $slug failed (see $DATASETS_LOG); resumes on next boot"
        datasets_status "$slug" "error — copy failed, resumes on the next restart (see $DATASETS_LOG)"
        return 1
    fi

    local copied
    copied=$(find "$DATASETS_STAGING/$slug" -type f | wc -l)
    if [ "$file_count" -gt 0 ] && [ "$copied" -ne "$file_count" ]; then
        log "WARNING: [datasets] $slug: copied $copied files, catalogue says $file_count"
    fi

    if ! run_as_geocluster mkdir -p "$DATASETS_DIR"; then
        datasets_status "$slug" "error — could not create dataset directory; resumes on the next restart"
        return 1
    fi
    rm -rf "$dest"
    mv "$DATASETS_STAGING/$slug" "$dest"   # same filesystem: atomic rename
    chown -R geocluster:geocluster "$dest"
    printf '{"slug":"%s","version":"%s","hydrated_at":"%s","file_count":%s,"bytes":%s}\n' \
        "$slug" "$version" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$copied" \
        "$(du -sb "$dest" 2>/dev/null | cut -f1 || echo 0)" | write_as_geocluster "$dest/.dataset.json"
    datasets_status "$slug" "ready — version $version, $copied files"
    log "[datasets] Hydrated $slug ($copied files)"
    return 0
}

# One full pass: fetch manifest, revoke, copy. Runs inside the background subshell.
run_dataset_hydration() {
    fetch_dataset_entitlements || return 0   # 1/2/3 already logged; nothing to change this boot

    local slugs slug stamp
    slugs=$(jq -r '.datasets[].slug' "$DATASETS_MANIFEST")

    # Revocation — only after a 200: stamped directories no longer granted are removed.
    for stamp in "$DATASETS_DIR"/*/.dataset.json; do
        [ -f "$stamp" ] || continue
        slug=$(basename "$(dirname "$stamp")")
        if ! grep -qx -- "$slug" <<<"$slugs"; then
            log "[datasets] Grant for $slug revoked: removing $DATASETS_DIR/$slug"
            rm -rf "$DATASETS_DIR/$slug"
            datasets_status "$slug" "revoked — removed from this workspace"
        fi
    done

    rm -f "$DATASETS_CONF"
    for slug in $slugs; do
        if ! hydrate_one_dataset "$slug"; then
            # Credentials can expire during a long copy: refresh once and resume.
            local exp now
            exp=$(jq -r --arg s "$slug" '.datasets[] | select(.slug == $s) | .expires_at' "$DATASETS_MANIFEST")
            now=$(date -u +%s)
            if [ -n "$exp" ] && [ "$(date -u -d "$exp" +%s 2>/dev/null || echo 0)" -le "$now" ]; then
                log "[datasets] Credentials for $slug expired mid-copy: refreshing once"
                if fetch_dataset_entitlements; then
                    rm -f "$DATASETS_CONF"
                    hydrate_one_dataset "$slug" || true
                fi
            fi
        fi
    done

    rm -f "$DATASETS_CONF" "$DATASETS_MANIFEST"
    # The staging root is only removed when empty: a failed/interrupted copy keeps
    # its partial tree there so the next boot resumes instead of starting over.
    rmdir "$DATASETS_STAGING" 2>/dev/null || true
    run_as_geocluster rmdir "$DATASETS_DIR" 2>/dev/null || true
    log "[datasets] Hydration pass complete"
}

start_dataset_hydrator() {
    cleanup_dataset_workspace_status
    if [ -z "${IDE_DATASET_TOKEN:-}" ] || [ -z "${IDE_DATASETS_URL:-}" ]; then
        log "[datasets] No dataset token in environment: private datasets skipped"
        return 0
    fi
    touch "$DATASETS_LOG"
    chown root:geocluster "$DATASETS_LOG"
    chmod 640 "$DATASETS_LOG"   # progress is readable by the user; it carries no credentials
    # Before any geocluster process runs; the copy itself still runs as root in the
    # background; its races with tool shells remain unresolved
    if ! clear_non_dir "$DATASETS_DIR" || ! clear_non_dir "$DATASETS_STAGING"; then
        log "WARNING: [datasets] $DATASETS_DIR or $DATASETS_STAGING is unusable: private datasets skipped"
        return 0
    fi
    datasets_status_json hydrating

    # Background: the fetch backs off on errors and a copy can take minutes;
    # the gateway must not wait. The subshell keeps its own copy of
    # IDE_DATASET_TOKEN after scrub_secrets. set +e: a failing jq/df must not kill
    # the pass silently.
    (
        set +e
        run_dataset_hydration
        datasets_status_json
    ) &
    DATASETS_PID=$!
    log "[datasets] Hydrator started (PID: $DATASETS_PID); status in $DATASETS_STATUS, log $DATASETS_LOG"
}

# =============================================================================
# Graceful Shutdown Handler
# =============================================================================
# Root-only control credentials are read from disk, never placed in argv or env.
# admissionOnly closes mutation admission before owned writers are stopped.
request_files_drain() {
    local deadline="$1" admission="${2:-false}"
    NODE_OPTIONS="" node - "$FILES_PORT" "$FILES_CONTROL_FILE" "$deadline" "$admission" <<'NODE'
const fs = require("node:fs"), http = require("node:http");
const [port, file, deadline, admission] = process.argv.slice(2);
const remaining = Date.parse(deadline) - Date.now();
if (!(remaining > 0)) { console.error("[files] drain deadline elapsed; retain the volume"); process.exit(1); }
const body = JSON.stringify({ deadline, admissionOnly: admission === "true" });
const req = http.request({ host: "127.0.0.1", port, path: "/internal/files/drain", method: "POST",
  headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-gc-files-control": fs.readFileSync(file, "utf8").trim() } }, (res) => {
  let raw = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { raw += chunk; if (Buffer.byteLength(raw) > 65536) res.destroy(new Error("drain response exceeds 64 KiB")); });
  res.on("error", fail);
  res.on("end", () => {
    try {
      if (res.statusCode !== 200) throw new Error(`file drain returned HTTP ${res.statusCode}`);
      const result = JSON.parse(raw);
      if (!result || typeof result !== "object" || (admission !== "true" && typeof result.complete !== "boolean")) throw new Error("invalid drain result");
      clearTimeout(timer);
      process.stdout.write(JSON.stringify(result) + "\n");
    } catch (error) { fail(error); }
  });
});
function fail(error) { console.error("[files] root drain request failed:", error.message, "Retain the volume and inspect pending work."); process.exit(1); }
const timer = setTimeout(() => req.destroy(new Error("drain deadline elapsed")), admission === "true" ? Math.min(2000, remaining) : remaining);
req.on("error", fail);
req.end(body);
NODE
}

# The standalone adapter owns service-first settlement. Never send its tree to
# stop_process_tree: doing so would abort the extraction engine before settlement.
request_pair_drain() {
    NODE_OPTIONS="" node - "$1" <<'NODE'
const http = require("node:http"), deadlineMs = Date.parse(process.argv[2]);
const body = JSON.stringify({ deadlineMs: deadlineMs - 2000 });
const req = http.request({ socketPath: "/run/runtime/lifecycle.sock", path: "/stop-pair", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
  let raw = "";
  res.on("data", (chunk) => { raw += chunk; if (raw.length > 65536) req.destroy(new Error("pair response too large")); });
  res.on("end", () => { clearTimeout(timer); if (res.statusCode !== 200) process.exitCode = 1; else process.stdout.write(raw + "\n"); });
});
const timer = setTimeout(() => req.destroy(new Error("pair drain deadline elapsed")), Math.max(1, deadlineMs - Date.now()));
req.on("error", () => { clearTimeout(timer); console.error("[preprocessing] Pair drain unavailable; retain ownership evidence and source holds."); process.exitCode = 1; });
req.end(body);
NODE
}

# Snapshot descendants while ancestry exists. Start times prevent PID-reuse kills.
# The gateway gets its grace period for agent cancellation; leftovers are then reaped.
stop_process_tree() {
    local pid="$1" deadline="$2" grace_ms="${3:-1000}"
    [ -n "$pid" ] || return 0
    NODE_OPTIONS="" node - "$pid" "$deadline" "$grace_ms" <<'NODE'
const fs = require("node:fs");
const [rawPid, deadline, rawGrace] = process.argv.slice(2);
const root = Number(rawPid), end = Date.parse(deadline), seen = new Map();
function stat(pid) {
  try { const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return f[0] === "Z" ? null : { pid, parent: Number(f[1]), start: f[19] }; } catch { return null; }
}
const original = stat(root);
if (!original) process.exit(0);
seen.set(root, original);
function refresh() {
  const entries = new Map();
  for (const name of fs.readdirSync("/proc")) if (/^\d+$/.test(name)) { const p = stat(Number(name)); if (p) entries.set(p.pid, p); }
  const queue = stat(root)?.start === original.start ? [root] : [];
  for (let i = 0; i < queue.length; i++) for (const p of entries.values()) if (p.parent === queue[i]) { seen.set(p.pid, p); queue.push(p.pid); }
}
function alive(p) { return stat(p.pid)?.start === p.start; }
function signal(p, kind) { if (alive(p)) try { process.kill(p.pid, kind); } catch (error) { if (error.code !== "ESRCH") console.error("[shutdown]", kind, p.pid, error.message); } }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  refresh(); signal(original, "SIGTERM");
  const grace = Math.min(end - 1000, Date.now() + Number(rawGrace));
  while (alive(original) && Date.now() < grace) { refresh(); await pause(100); }
  refresh();
  for (const p of seen.values()) signal(p, "SIGTERM");
  while ([...seen.values()].some(alive) && Date.now() < Math.min(end - 100, grace + 1000)) await pause(50);
  for (const p of seen.values()) signal(p, "SIGKILL");
  await pause(50);
  if ([...seen.values()].some(alive)) process.exitCode = 1;
})().catch((error) => { console.error("[shutdown] process-tree stop failed:", error.message); process.exitCode = 1; });
NODE
    local code=$?
    if [ "$code" -eq 0 ]; then wait "$pid" 2>/dev/null || true; fi
    return "$code"
}

shutdown_handler() {
    local code="${1:-0}" reason="${2:-signal}"
    [ "$SHUTDOWN_STARTED" = "false" ] || return 0
    SHUTDOWN_STARTED="true"
    trap - EXIT
    trap '' SIGTERM SIGINT SIGQUIT
    set +e
    local deadline end_ms writers_quiesced="true" jobs=() pid job
    # An unexpected process exit can reparent writers before a shutdown snapshot.
    # Do not claim a complete drain without the deferred activity registry.
    [ "$reason" != "child_exit" ] || writers_quiesced="false"
    end_ms=$(NODE_OPTIONS="" node -e 'process.stdout.write(String(Date.now() + Number(process.argv[1]) * 1000))' "$RUNTIME_DRAIN_TIMEOUT_S")
    deadline=$(NODE_OPTIONS="" node -e 'process.stdout.write(new Date(Number(process.argv[1])).toISOString())' "$end_ms")
    log "[shutdown] reason=$reason deadline=$deadline"

    if [ -n "$FILES_PID" ] && kill -0 "$FILES_PID" 2>/dev/null; then
        request_files_drain "$deadline" true >/dev/null || log "WARNING: [files] Could not confirm mutation admission closed"
    fi
    # The API-3 broker closes prompt admission on SIGTERM. Keep the gate alive
    # until the gateway exits so existing sockets receive cancellation/turn_end
    # frames; the gateway also stops its engine and shared MCP within this grace.
    for pid in "$GATEWAY_PID" "$WATCHER_PID" "$DATASETS_PID" "$GATEWAY_PROBE_PID"; do
        [ -n "$pid" ] || continue
        stop_process_tree "$pid" "$deadline" 15000 &
        jobs+=("$!")
    done
    local pair_result="$RUN_DIR/pair-drain.json"
    if ! ( umask 077; request_pair_drain "$deadline" > "$pair_result" ); then
        ( umask 077; printf '%s\n' '{"complete":false,"recoveryRequired":true,"error":"pair_drain_unavailable"}' > "$pair_result" )
        writers_quiesced="false"
    fi
    for job in "${jobs[@]}"; do wait "$job" || writers_quiesced="false"; done
    rm -f "$DATASETS_CONF" "$DATASETS_MANIFEST" "$DATASETS_MANIFEST.tmp"

    local result="$RUN_DIR/drain.json"
    if ! ( umask 077; request_files_drain "$deadline" > "$result" ); then
        ( umask 077; printf '%s\n' '{"localPending":null,"remotePending":null,"failed":[{"agent":"root-supervisor","tool":"drain","error":"drain_unavailable","action":"Retain the volume and inspect pending work."}],"indeterminate":null,"complete":false}' > "$result" )
    fi
    # A structured local drain result is diagnostic evidence, not permission to destroy a volume.
    if [ -d "$LIFECYCLE_DIR" ] && [ ! -L "$LIFECYCLE_DIR" ]; then
        NODE_OPTIONS="" node - "$result" "$LIFECYCLE_DIR/drain.json" "$deadline" "$reason" "$writers_quiesced" "$pair_result" <<'NODE'
const fs = require("node:fs"), [source, target, deadline, reason, quiesced, pairResult] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(source, "utf8"));
const preprocessingPair = JSON.parse(fs.readFileSync(pairResult, "utf8"));
result.supervisor = { deadline, reason, writersQuiesced: quiesced === "true", preprocessingPair, cloudPersistence: "not-acknowledged" };
if (quiesced !== "true" || !preprocessingPair.complete) result.complete = false;
const tmp = target + ".tmp";
const fd = fs.openSync(tmp, "w", 0o600);
fs.writeFileSync(fd, JSON.stringify(result) + "\n"); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(tmp, target);
const dir = fs.openSync(require("node:path").dirname(target), "r"); fs.fsyncSync(dir); fs.closeSync(dir);
console.log("[shutdown] drain=" + JSON.stringify(result));
NODE
    else
        log "WARNING: [shutdown] Retained lifecycle directory unavailable; drain result cannot be retained"
    fi

    # Ordinary workspace sync shares the same hard deadline.
    # Its success does not become a file-service remote acknowledgement.
    if [ "$WORKSPACE_PREPARED" = "true" ]; then
        (
            sync_to_r2
        ) &
        local final_pid=$!
        while kill -0 "$final_pid" 2>/dev/null && [ "$(date +%s%3N)" -lt "$end_ms" ]; do sleep 0.1; done
        stop_process_tree "$final_pid" "$deadline" 0 || true
    fi
    stop_process_tree "$FILES_PID" "$deadline" 1000 || true
    stop_process_tree "$GATE_PID" "$deadline" 500 || true
    # Reporter is last: it stays alive through pair settlement and file checkpoint.
    if [ -n "$LIFECYCLE_PID" ]; then
        kill -TERM "$LIFECYCLE_PID" 2>/dev/null || true
        while kill -0 "$LIFECYCLE_PID" 2>/dev/null && [ "$(date +%s%3N)" -lt "$end_ms" ]; do sleep 0.05; done
        kill -KILL "$LIFECYCLE_PID" 2>/dev/null || true
        wait "$LIFECYCLE_PID" 2>/dev/null || true
    fi
    # Keep service authentication alive through gateway/pair settlement.
    stop_process_tree "$MACHINE_GATEWAY_PID" "$deadline" 500 || true
    log "[shutdown] complete; pending work requires the retained volume"
    exit "$code"
}

# The local helper starts its interpreter with only provisioning settings. Presence
# markers let validation reject managed credentials without inheriting their values.
run_local_workspace() {
    env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        LOCAL_WORKSPACE_HOST_UID="${LOCAL_WORKSPACE_HOST_UID:-}" \
        LOCAL_WORKSPACE_SCAN_MS="${LOCAL_WORKSPACE_SCAN_MS:-}" \
        PROJECT_ID="$PROJECT_ID" FILES_STATE_DIR="$FILES_STATE_DIR" FILES_LIMITS="$FILES_LIMITS" \
        FLY_MACHINE_ID="${FLY_MACHINE_ID:+configured}" \
        IDE_MACHINE_TOKEN="${IDE_MACHINE_TOKEN:+configured}" IDE_MACHINE_TOKEN_FILE="${IDE_MACHINE_TOKEN_FILE:+configured}" \
        IDE_MACHINE_CREDENTIALS_URL="${IDE_MACHINE_CREDENTIALS_URL:+configured}" IDE_MACHINE_CREDENTIALS_FILE="${IDE_MACHINE_CREDENTIALS_FILE:+configured}" \
        RUNTIME_FILES_URL="${RUNTIME_FILES_URL:+configured}" RUNTIME_FILE_WORK_URL="${RUNTIME_FILE_WORK_URL:+configured}" \
        FILES_SYNC_ADAPTER="$FILES_SYNC_ADAPTER" OWNED_DEMO_ENABLED="${OWNED_DEMO_ENABLED:-false}" \
        node "$RUNTIME_CODE_DIR/local-workspace.mjs" "$1"
}

# Validate identity maps and every existing private-store ancestor before the first
# startup mutation, and before an EXIT trap could write shutdown evidence on failure.
install_managed_traps() {
    trap 'shutdown_handler 0 SIGTERM' SIGTERM
    trap 'shutdown_handler 0 SIGINT' SIGINT
    trap 'shutdown_handler 0 SIGQUIT' SIGQUIT
    trap 'shutdown_handler "$?" exit' EXIT
}

# =============================================================================
# Runtime state on the volume (root-owned parents; separately owned children)
# =============================================================================
# The Fly rootfs is recreated on every start; everything the engine and the
# gateway must remember lives under $RUNTIME_STATE_ROOT on the volume:
#   opencode/ the engine's XDG data/state/cache dirs (opencode.db, logs, shell output)
#   gateway/  per-conversation event logs (replay after a reload), index, prefs.json
#   cline/    api-1/2 conversations, read once as the archive (never written)
# The code-server era kept its state in $LEGACY_STATE_ROOT; it is moved aside
# once (never read, never deleted) so the new runtime starts from a clean slate.
archive_legacy_state() {
    [ -e "$LEGACY_STATE_ROOT" ] || return 0
    if [ -L "$LEGACY_STATE_ROOT" ]; then
        log "WARNING: [runtime-state] $LEGACY_STATE_ROOT is a symlink: left alone"
        return 0
    fi
    local archive_dir="$RUNTIME_STATE_ROOT/archive" target
    ensure_real_dir "$archive_dir" || return 0
    target="$archive_dir/ide-state-$(date -u +%Y%m%d)"
    [ -e "$target" ] && target="$target-$(date -u +%H%M%S)"
    if mv "$LEGACY_STATE_ROOT" "$target"; then
        log "[runtime-state] Archived code-server state: $LEGACY_STATE_ROOT -> $target"
    else
        log "WARNING: [runtime-state] Could not archive $LEGACY_STATE_ROOT (left in place)"
    fi
}

root_directory() {
    local dir="$1" mode="${2:-0755}"
    if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -d "$dir" ]; }; then
        log "ERROR: [files] Protected ancestor $dir is not a real directory; inspect the retained volume"
        return 1
    fi
    mkdir -p "$dir"
    chown root:root "$dir"
    chmod "$mode" "$dir"
}

prepare_protected_parents() {
    # /run is root-controlled, outside the agent-writable home and volume. Group
    # 999 may traverse this directory but cannot replace it or the service socket;
    # preview workers (GID 997, no supplementary groups) cannot traverse it.
    root_directory /run
    root_directory /run/geocluster
    chown gc-files:geocluster /run/geocluster
    chmod 0750 /run/geocluster
    case "$PROJECT_ID" in ''|.|..|.runtime|.ide-state|*/*)
        log "ERROR: [files] PROJECT_ID must name a non-reserved workspace directory"; return 1 ;;
    esac
    case "$RUNTIME_DRAIN_TIMEOUT_S" in ''|*[!0-9]*|0)
        log "ERROR: [files] RUNTIME_DRAIN_TIMEOUT_S must be a positive integer"; return 1 ;;
    esac
    if ! [ "$RUNTIME_DRAIN_TIMEOUT_S" -gt 0 ] 2>/dev/null; then
        log "ERROR: [files] RUNTIME_DRAIN_TIMEOUT_S is outside the supported positive-integer range"; return 1
    fi
    case "$FILES_PORT" in ''|*[!0-9]*)
        log "ERROR: [files] RUNTIME_FILES_PORT must be an integer TCP port"; return 1 ;;
    esac
    if [ "$FILES_PORT" -lt 1 ] || [ "$FILES_PORT" -gt 65535 ] || [ "$FILES_PORT" -eq "$GATE_PORT" ] || [ "$FILES_PORT" -eq "$GATEWAY_PORT" ] || [ "$FILES_PORT" -eq "${RUNTIME_MCP_PORT:-7710}" ]; then
        log "ERROR: [files] RUNTIME_FILES_PORT must be a separate port between 1 and 65535"; return 1
    fi
    # Only this retained root is provisioned as service-private state. Every
    # intermediate component is root-owned, including custom nested placement.
    case "$FILES_STATE_DIR" in "$RUNTIME_STATE_ROOT"/file-service/*) ;;
        *) log "ERROR: [files] FILES_STATE_DIR must be under $RUNTIME_STATE_ROOT/file-service/"; return 1 ;;
    esac
    if [ "$(realpath -m -- "$FILES_STATE_DIR")" != "$FILES_STATE_DIR" ]; then
        log "ERROR: [files] FILES_STATE_DIR must be canonical with no symlink ancestors"; return 1
    fi
    root_directory /workspace
    root_directory "$RUNTIME_STATE_ROOT"
    root_directory "$RUNTIME_STATE_ROOT/file-service"
    root_directory "$LIFECYCLE_DIR" 0700
    local parent="${FILES_STATE_DIR%/*}" part current="$RUNTIME_STATE_ROOT/file-service"
    local relative="${parent#"$current"}"
    local parts=()
    IFS=/ read -r -a parts <<< "${relative#/}"
    for part in "${parts[@]}"; do
        [ -n "$part" ] || continue
        current="$current/$part"
        root_directory "$current"
    done
    if [ -L "$FILES_STATE_DIR" ] || { [ -e "$FILES_STATE_DIR" ] && [ ! -d "$FILES_STATE_DIR" ]; }; then
        log "ERROR: [files] $FILES_STATE_DIR must be a real service-state directory"; return 1
    fi
    mkdir -p "$FILES_STATE_DIR"
    chown gc-files:geocluster "$FILES_STATE_DIR"
    chmod 0700 "$FILES_STATE_DIR"
}

prepare_runtime_state() {
    local dir
    for dir in "$ENGINE_STATE_DIR" "$GATEWAY_STATE_DIR" "$CONVERSATIONS_DIR"; do
        ensure_real_dir "$dir"
        # Only these agent-owned subtrees: never re-own the protected parent,
        # file-service state or root-only lifecycle records. -hR does not follow links.
        chown -hR geocluster:geocluster "$dir"
        chmod 0700 "$dir"
    done
    mkdir -p "$LOG_DIR"
    chown geocluster:geocluster "$LOG_DIR"
    chmod 0755 "$LOG_DIR"
    prepare_dataset_status
    ( set +e; log "[runtime-state] size_bytes=$(du -sb "$RUNTIME_STATE_ROOT" 2>/dev/null | cut -f1)" ) &
}

# =============================================================================
# Workspace ownership (runs as root, before any geocluster process starts)
# =============================================================================
# Only normal project content is repaired before writers start. Private state is
# outside this traversal. Explicit private files and private directories stay private.
# Even a no-op chmod/chgrp advances ctime, invalidating live file observation tokens.
# Repair only actual mismatches so unchanged content keeps its tokens across boot.
fix_workspace_ownership() {
    if [ -n "${LOCAL_WORKSPACE_HOST_UID:-}" ]; then
        run_local_workspace provision
        return
    fi
    log "[files] Preparing shared project directories and ordinary writer files..."
    find "$WORKSPACE_DIR" -xdev \
        \( -path "$DATASETS_DIR" -o -path "$DATASETS_STAGING" -o \( -type d ! -perm /0077 \) \) -prune -o \
        -type d ! -group geocluster -exec chgrp geocluster {} +
    find "$WORKSPACE_DIR" -xdev \
        \( -path "$DATASETS_DIR" -o -path "$DATASETS_STAGING" -o \( -type d ! -perm /0077 \) \) -prune -o \
        -type d ! -perm 2775 -exec chmod 2775 {} +
    # Files downloaded/seeded as root become ordinary agent files. Existing
    # gc-files-owned files retain their owner, and 0600 files retain their modes.
    find "$WORKSPACE_DIR" -xdev \
        \( -path "$DATASETS_DIR" -o -path "$DATASETS_STAGING" -o \( -type d ! -perm /0077 \) \) -prune -o \
        -type f -perm /0077 -user root -exec chown geocluster:geocluster {} +
    find "$WORKSPACE_DIR" -xdev \
        \( -path "$DATASETS_DIR" -o -path "$DATASETS_STAGING" -o \( -type d ! -perm /0077 \) \) -prune -o \
        -type f -perm -0040 ! -group geocluster -exec chgrp geocluster {} +
    find "$WORKSPACE_DIR" -xdev \
        \( -path "$DATASETS_DIR" -o -path "$DATASETS_STAGING" -o \( -type d ! -perm /0077 \) \) -prune -o \
        -type f -perm -0040 ! -perm -0020 -exec chmod g+w {} +
}

# =============================================================================
# Access gate key + per-boot gate secret (runs as root)
# =============================================================================
# gate.cjs verifies the backend's one-time token and signs its session cookie
# with this per-project key (backend: app/services/runtime_gate_auth.py,
# HMAC-SHA256(IDE_TOKEN_SECRET, "ide-proxy-v1:" + project_id)). The gate runs
# as root and reads $GATE_KEY_FILE (root:root 600 in a 700 dir). The variable
# is unset here, before any background process is forked, so no child (MCP
# server, watchers) inherits it. printf is a builtin: the key never
# appears in a process argv. Without a key the gate fails closed (401 for
# everything except /livez and /readyz).
write_gate_key() {
    ( umask 077 && mkdir -p "$RUN_DIR" && chmod 700 "$RUN_DIR" ) || log "WARNING: could not create $RUN_DIR"
    if [ -z "${IDE_PROXY_KEY:-}" ]; then
        log "WARNING: IDE_PROXY_KEY is not set: the gate will answer 401 to everything except health (refresh the machine env from the backend)"
        unset IDE_PROXY_KEY
        return 0
    fi
    if ( umask 077 \
        && printf '%s' "$IDE_PROXY_KEY" > "$GATE_KEY_FILE.tmp" \
        && chown root:root "$GATE_KEY_FILE.tmp" \
        && chmod 600 "$GATE_KEY_FILE.tmp" \
        && mv -f "$GATE_KEY_FILE.tmp" "$GATE_KEY_FILE" ); then
        log "Gate key written to $GATE_KEY_FILE (root:root, mode 600)"
    else
        rm -f "$GATE_KEY_FILE.tmp" 2>/dev/null || true
        log "WARNING: could not write $GATE_KEY_FILE: the gate will fail closed (401)"
    fi
    unset IDE_PROXY_KEY
}

# Per-boot secret shared by the gate (file, root-only) and the gateway (stdin).
# Never exported: the agent and the MCP server must not be able to find it.
write_gate_secret() {
    GATE_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
    if [ -z "$GATE_SECRET" ]; then
        log "WARNING: could not generate the gate secret: the gateway will refuse every request"
        return 0
    fi
    if ( umask 077 \
        && printf '%s' "$GATE_SECRET" > "$GATE_SECRET_FILE.tmp" \
        && chown root:root "$GATE_SECRET_FILE.tmp" \
        && chmod 600 "$GATE_SECRET_FILE.tmp" \
        && mv -f "$GATE_SECRET_FILE.tmp" "$GATE_SECRET_FILE" ); then
        log "Gate secret written to $GATE_SECRET_FILE (root:root, mode 600)"
    else
        rm -f "$GATE_SECRET_FILE.tmp" 2>/dev/null || true
        log "WARNING: could not write $GATE_SECRET_FILE: the gate cannot reach the gateway"
    fi
}

write_files_input() {
    local control
    [ -s "$GATE_SECRET_FILE" ] || { log "ERROR: [files] Root gate secret unavailable"; return 1; }
    control=$(NODE_OPTIONS="" node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
    (
        umask 077
        printf '%s\n' "$control" > "$FILES_CONTROL_FILE"
        { cat "$GATE_SECRET_FILE"; printf '\n%s\n' "$control"; } > "$FILES_INPUT_FILE"
        chown root:root "$FILES_CONTROL_FILE" "$FILES_INPUT_FILE"
        chmod 0600 "$FILES_CONTROL_FILE" "$FILES_INPUT_FILE"
    )
}

# Optional backend-issued generation credential. Root fetches purpose tokens before
# hydration; the ACP engine sees only a stable loopback address and a nonsecret marker.
configure_machine_credentials() {
    if [ -z "${IDE_MACHINE_TOKEN:-}${IDE_MACHINE_TOKEN_FILE:-}${IDE_MACHINE_CREDENTIALS_URL:-}" ]; then
        return 0
    fi
    [ -n "${IDE_MACHINE_CREDENTIALS_URL:-}" ] || { log "ERROR: IDE_MACHINE_CREDENTIALS_URL is required with a machine credential"; return 1; }
    case "$MACHINE_GATEWAY_PORT" in ''|*[!0-9]*) log "ERROR: RUNTIME_MACHINE_GATEWAY_PORT must be an integer TCP port"; return 1 ;; esac
    if [ "$MACHINE_GATEWAY_PORT" -lt 1 ] || [ "$MACHINE_GATEWAY_PORT" -gt 65535 ] || [ "$MACHINE_GATEWAY_PORT" -eq "$GATE_PORT" ] || [ "$MACHINE_GATEWAY_PORT" -eq "$GATEWAY_PORT" ] || [ "$MACHINE_GATEWAY_PORT" -eq "$FILES_PORT" ] || [ "$MACHINE_GATEWAY_PORT" -eq "${RUNTIME_MCP_PORT:-7710}" ] || [ "$MACHINE_GATEWAY_PORT" -eq "${PREPROCESSING_PORT:-8765}" ]; then
        log "ERROR: RUNTIME_MACHINE_GATEWAY_PORT must be a separate port between 1 and 65535"; return 1
    fi
    MACHINE_CREDENTIALS_URL="$IDE_MACHINE_CREDENTIALS_URL"
    MACHINE_CREDENTIALS_FILE="$RUN_DIR/machine-credentials.json"
    MACHINE_TOKEN_FILE="${IDE_MACHINE_TOKEN_FILE:-$RUN_DIR/machine-token}"
    if [ -n "${IDE_MACHINE_TOKEN:-}" ]; then
        MACHINE_TOKEN_FILE="$RUN_DIR/machine-token"
        ( umask 077; printf '%s' "$IDE_MACHINE_TOKEN" > "$MACHINE_TOKEN_FILE.tmp"; chmod 600 "$MACHINE_TOKEN_FILE.tmp"; mv -f "$MACHINE_TOKEN_FILE.tmp" "$MACHINE_TOKEN_FILE" )
    fi
    unset IDE_MACHINE_TOKEN
    [ -s "$MACHINE_TOKEN_FILE" ] || { log "ERROR: Root machine credential file is missing or empty"; return 1; }
    if [ -n "${PREPROCESSING_MODEL:-}" ]; then
        # This authorizes only the local extraction channel. Root's relay keeps
        # the renewed backend purpose credential out of the processor identity.
        PREPROCESSING_PROXY_TOKEN=$(NODE_OPTIONS="" node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
        export PREPROCESSING_PROXY_TOKEN
    fi
    IDE_MACHINE_TOKEN_FILE="$MACHINE_TOKEN_FILE" IDE_MACHINE_CREDENTIALS_URL="$MACHINE_CREDENTIALS_URL" IDE_MACHINE_CREDENTIALS_FILE="$MACHINE_CREDENTIALS_FILE" \
        NODE_OPTIONS="" node "$RUNTIME_CODE_DIR/machine-gateway.js" --bootstrap
    IDE_DATASET_TOKEN=$(jq -er '.datasetToken' "$MACHINE_CREDENTIALS_FILE")
    export IDE_DATASET_TOKEN
    # Original backend URLs are held only in the private boot snapshot. All future
    # LLM/activity calls traverse root's live configuration rather than copied JWTs.
    export IDE_LLM_TOKEN="runtime-relay"
    if [ -n "${LLM_PROXY_URL:-}" ]; then export LLM_PROXY_URL="http://127.0.0.1:$MACHINE_GATEWAY_PORT/llm"; fi
    if [ -n "${RUNTIME_ACTIVITY_URL:-}" ]; then export RUNTIME_ACTIVITY_URL="http://127.0.0.1:$MACHINE_GATEWAY_PORT/activity" RUNTIME_ACTIVITY_TOKEN="runtime-relay"; fi
    unset IDE_MACHINE_TOKEN_FILE IDE_MACHINE_CREDENTIALS_URL IDE_MACHINE_CREDENTIALS_FILE
    log "[machine-gateway] Fresh purpose credentials loaded before dataset hydration"
}

start_machine_gateway() {
    [ -n "$MACHINE_CREDENTIALS_URL" ] || return 0
    env -i PATH="$PATH" HOME=/nonexistent LANG="${LANG:-C.UTF-8}" NODE_OPTIONS="" \
        IDE_MACHINE_TOKEN_FILE="$MACHINE_TOKEN_FILE" IDE_MACHINE_CREDENTIALS_URL="$MACHINE_CREDENTIALS_URL" \
        IDE_MACHINE_CREDENTIALS_FILE="$MACHINE_CREDENTIALS_FILE" RUNTIME_MACHINE_GATEWAY_PORT="$MACHINE_GATEWAY_PORT" \
        RUNTIME_FILES_CONTROL_FILE="$FILES_CONTROL_FILE" \
        node "$RUNTIME_CODE_DIR/machine-gateway.js" &
    MACHINE_GATEWAY_PID=$!
    wait_for_tcp 127.0.0.1 "$MACHINE_GATEWAY_PORT" 15 || { log "ERROR: Root credential gateway did not start"; return 1; }
    log "[machine-gateway] Root service started (PID: $MACHINE_GATEWAY_PID), loopback port $MACHINE_GATEWAY_PORT"
}

# =============================================================================
# Scrub secrets from environment
# =============================================================================
scrub_secrets() {
    log "Scrubbing secrets from environment..."
    # SECRET_ENV_VARS (top of file) plus any other R2_*/OPENROUTER_* name:
    # - IDE_PROXY_KEY: write_gate_key already moved it to a root-only file and
    #   unset it; repeated defensively.
    # - R2 credentials: real secrets. The file watcher subshells
    #   forked earlier keep their own copy (they run as root).
    # - OPENROUTER_API_KEY: should not be on the machine; scrubbed defensively.
    # - IDE_DATASET_TOKEN / IDE_DATASETS_URL: only needed in Phase A (the
    #   hydrator subshell keeps its own copy). Without them the geocluster user
    #   cannot mint private-dataset creds.
    local name
    for name in "${SECRET_ENV_VARS[@]}" $(compgen -e | grep -E '^(R2_|OPENROUTER_)' || true); do
        unset "$name"
    done
    for name in $(compgen -e); do
        if supplier_credential_name "$name"; then unset "$name"; fi
    done
    # Direct mode retains purpose tokens for the existing services. Machine mode
    # replaces LLM/activity tokens with a nonsecret marker and the URLs with
    # loopback endpoints. The raw machine credential was already moved to a
    # root-only file and is never inherited by an unprivileged process.
    log "Secrets scrubbed from environment"
}

# =============================================================================
# Boot probe: gateway ready
# =============================================================================
# Background; logs "[boot] step=gateway_ready" once /readyz answers 200, i.e.
# when a browser can actually open a session (agent initialised, MCP up).
start_gateway_probe() {
    (
        set +e
        local i=0
        while [ "$i" -lt 3000 ]; do
            if curl -sf -o /dev/null "http://127.0.0.1:$GATEWAY_PORT/readyz" 2>/dev/null; then
                boot_step gateway_ready
                exit 0
            fi
            sleep 0.1
            i=$((i + 1))
        done
        log "WARNING: [boot] gateway not ready on 127.0.0.1:$GATEWAY_PORT/readyz after 300 s"
    ) &
    GATEWAY_PROBE_PID=$!
}

# =============================================================================
# Main Startup Sequence
# =============================================================================
start_access_gate() {
    PROJECT_ID="$PROJECT_ID" RUNTIME_GATE_KEY_FILE="$GATE_KEY_FILE" RUNTIME_GATE_SECRET_FILE="$GATE_SECRET_FILE" \
        RUNTIME_FILES_CONTROL_FILE="$FILES_CONTROL_FILE" \
        RUNTIME_GATE_PORT="$GATE_PORT" RUNTIME_GATEWAY_PORT="$GATEWAY_PORT" RUNTIME_FILES_PORT="$FILES_PORT" NODE_OPTIONS="" \
        node "$RUNTIME_CODE_DIR/gate.cjs" &
    GATE_PID=$!
    wait_for_tcp 127.0.0.1 "$GATE_PORT" 15 || { log "ERROR: Root access gate did not start"; return 1; }
    log "Access gate started (PID: $GATE_PID) on 0.0.0.0:$GATE_PORT before workspace initialization"
    boot_step gate_spawned
}

configure_managed_profile() {
    # Discovery crosses the root-held relay. The artifact carries public metadata
    # only; its identity remains the original backend, not the loopback relay URL.
    env -i PATH="$PATH" NODE_OPTIONS="" PROJECT_ID="$PROJECT_ID" \
        RUNTIME_STATE_ROOT="$RUNTIME_STATE_ROOT" \
        LLM_PROXY_URL="$LLM_PROXY_URL" IDE_LLM_TOKEN=runtime-relay \
        RUNTIME_MANAGED_BACKEND_BASE_URL="$MANAGED_BACKEND_BASE_URL" \
        RUNTIME_MANAGED_GENERATION="${RUNTIME_MANAGED_GENERATION:-}" \
        RUNTIME_MANAGED_DISCOVERY_MAX_BYTES="${RUNTIME_MANAGED_DISCOVERY_MAX_BYTES:-1048576}" \
        RUNTIME_MANAGED_CATALOG_PATH="$MANAGED_CATALOG_PATH" \
        node --input-type=module - "$OPENCODE_ROOT" "$RUNTIME_CODE_DIR" <<'NODE'
import { pathToFileURL } from "node:url";
const [root, runtime] = process.argv.slice(2);
const { loadConfig } = await import(pathToFileURL(`${runtime}/lib/config.js`));
const { startupCatalog } = await import(pathToFileURL(`${runtime}/lib/managed-catalog.js`));
const { materializeProfile } = await import(pathToFileURL(`${root}/scripts/build-config.mjs`));
const result = await startupCatalog(loadConfig(), { protectedParent: true });
materializeProfile("managed", { directory: `${root}/config/managed`, sourceDirectory: `${root}/config`,
  catalog: result.artifact?.catalog ?? { managed_models: {}, default_model_id: null } });
console.log("[managed] " + JSON.stringify({ state: result.state, schemaVersion: result.artifact?.discoverySchemaVersion ?? null,
  installedCatalogDigest: result.artifact?.digest ?? null, reason: result.reason }));
NODE
}

main() {
    # Keep direct callers on the same validation boundary as the dispatcher.
    if [ -n "${LOCAL_WORKSPACE_HOST_UID:-}" ]; then run_local_workspace validate; fi
    log "========================================="

	prepare_protected_parents
	case "${OWNED_DEMO_ENABLED:-false}" in true|false) ;; *) log "ERROR: OWNED_DEMO_ENABLED must be true or false"; return 1 ;; esac
    configure_workspace_sync
	if [ "${OWNED_DEMO_ENABLED:-false}" = "true" ] && [ "$FILES_SYNC_ADAPTER" != "true" ]; then
		log "ERROR: Owned demo startup requires FILES_SYNC_ADAPTER=true; legacy seed/sync cannot initialize it"
		return 1
	fi
    log "Runtime machine starting (OpenCode engine + gateway)"
    log "User ID: $USER_ID"
    log "Project ID: $PROJECT_ID"
    log "Sync Enabled: $SYNC_ENABLED"
    log "Running as: $(whoami) (UID: $(id -u))"
    log "========================================="

    # =========================================================================
    # Phase A — Configure services as root (secrets available)
    # =========================================================================

    # Root's own logs: a root-owned folder (see ROOT_LOG_DIR)
    root_directory "$ROOT_LOG_DIR"

    # Set the core OOM preference before forking services, including the early
    # access gate. The gateway raises engine and MCP scores separately.
    if { echo "$CORE_OOM_SCORE_ADJ" > /proc/self/oom_score_adj; } 2>/dev/null; then
        log "oom_score_adj $CORE_OOM_SCORE_ADJ for the gateway and the gate"
    else
        log "WARNING: could not lower oom_score_adj (no CAP_SYS_RESOURCE); conversation processes are still raised to +500"
    fi

    # Step 0: gate key -> root-only file; per-boot gate secret.
    # First, so no background process forked below inherits IDE_PROXY_KEY.
    write_gate_key
    write_gate_secret
    write_files_input
    start_access_gate
    MANAGED_BACKEND_BASE_URL="${RUNTIME_MANAGED_BACKEND_BASE_URL:-${LLM_PROXY_URL:-}}"
    configure_machine_credentials
    start_machine_gateway
    configure_managed_profile
    # Root opens the service token for the daemon's fd 3. /run/runtime stays
    # root-only; no shared readable secret directory is needed.
    PROJECT_ID="$PROJECT_ID" PREPROCESSING_ENABLED="$PREPROCESSING_ENABLED" RUNTIME_AGGREGATE_ACTIVITY="$RUNTIME_AGGREGATE_ACTIVITY" \
        RUNTIME_STATE_ROOT="$RUNTIME_STATE_ROOT" RUNTIME_MANAGED_CATALOG_PATH="$MANAGED_CATALOG_PATH" \
        RUNTIME_MANAGED_BACKEND_BASE_URL="$MANAGED_BACKEND_BASE_URL" RUNTIME_MANAGED_GENERATION="${RUNTIME_MANAGED_GENERATION:-}" \
        RUNTIME_MANAGED_DISCOVERY_MAX_BYTES="${RUNTIME_MANAGED_DISCOVERY_MAX_BYTES:-1048576}" \
        NODE_OPTIONS="" node "$RUNTIME_CODE_DIR/lib/preprocessing-provision.js"
    ( umask 077; { cat "$GATE_SECRET_FILE"; printf '\n'; cat "$PREPROCESSING_RUN_DIR/runtime-control"; printf '\n'; } > "$GATEWAY_INPUT_FILE" )
    if [ "$RUNTIME_AGGREGATE_ACTIVITY" = "true" ]; then unset RUNTIME_ACTIVITY_TOKEN; fi
    unset PREPROCESSING_PROXY_TOKEN PREPROCESSING_TOKEN
    boot_step gate_key

    # Step 1: Configure rclone for R2 (writes to /etc/rclone, root-only)
    configure_rclone
    boot_step configure_rclone

    # Step 2: Create workspace directory
    log "Creating workspace directory: $WORKSPACE_DIR"
    # /workspace is a protected root-owned parent. Move planted links/non-folders
    # aside before seeding or syncing, never following them with root privileges.
    ensure_real_dir "$WORKSPACE_DIR"
    if [ "$(stat -c '%a' -- "$WORKSPACE_DIR")" != "2775" ]; then
        chmod 2775 "$WORKSPACE_DIR"
    fi

    # Initialize an empty workspace with a welcome file and optional image seed.
    if [ "$FILES_SYNC_ADAPTER" != "true" ] && [ -z "$(ls -A "$WORKSPACE_DIR" 2>/dev/null)" ]; then
        log "Initializing empty workspace with a welcome file..."
        cat > "$WORKSPACE_DIR/README.md" << 'WELCOME'
# Welcome to Your Project Workspace

This is your project workspace. You can:

- Upload data files and browse them here
- Ask the geology agent to inspect, clean, analyse and visualise them
- Find each conversation's outputs in runs/<conversation id>/ (results/, scripts/)
- Open saved voxels from the Voxels list or a conversation's voxel result

## Getting Started

1. Drop a CSV, LAS or GeoTIFF into the workspace
2. Ask the agent what it sees
WELCOME
        chown geocluster:geocluster "$WORKSPACE_DIR/README.md"

        # Copy optional image seed files from /opt/seed-data/sample-data/.
        # (stored outside /workspace/ because Fly's volume mount hides image contents)
        if [ -d "/opt/seed-data/sample-data" ] && [ -n "$(ls -A /opt/seed-data/sample-data 2>/dev/null)" ]; then
            log "Copying sample datasets into workspace..."
            cp -a /opt/seed-data/sample-data/. "$WORKSPACE_DIR/"
            chown -R geocluster:geocluster "$WORKSPACE_DIR"
            log "Sample datasets copied"
        fi

    fi

    log "Workspace ready: $WORKSPACE_DIR"
    ls -la "$WORKSPACE_DIR" 2>/dev/null || log "Warning: Could not list workspace"
    boot_step workspace

    # Step 3: Sync files from R2 (as root — has rclone config access)
    sync_from_r2
    boot_step sync_from_r2

    # Step 3a: Runtime state on the volume (archive the code-server era once)
    # Protected parents were provisioned before any writer; do not chown .runtime.
    archive_legacy_state
    prepare_runtime_state
    boot_step runtime_state

    # Shared modes apply only to ordinary project content, before writers start.
    fix_workspace_ownership
    WORKSPACE_PREPARED="true"
    boot_step workspace_ownership

    # Step 3b: Private datasets — fetch entitlements and copy granted datasets
    # into $DATASETS_DIR in the background (needs the token: before Phase B).
    if [ "${OWNED_DEMO_ENABLED:-false}" != "true" ]; then start_dataset_hydrator; fi
    boot_step dataset_hydrator

    # Step 4: Start file watcher for auto-sync (runs as root in background)
    if [ "${OWNED_DEMO_ENABLED:-false}" != "true" ]; then start_file_watcher; fi
    boot_step file_watcher

    if [ "${OWNED_DEMO_ENABLED:-false}" = "true" ]; then
        # Fork before secret scrubbing, but admit no workspace access until setup
        # has finished. The root supervisor tracks this parent's entire tree.
        (
            while ! curl -sf -o /dev/null -H "X-GC-Gate: $(cat "$GATE_SECRET_FILE")" "http://127.0.0.1:$FILES_PORT/livez"; do sleep 0.1; done
            start_dataset_hydrator
            start_file_watcher
            wait
        ) &
        DATASETS_PID=$!
    fi
    # =========================================================================
    # Phase B — Scrub secrets from environment
    # =========================================================================
    scrub_secrets
    boot_step scrub_secrets

    # =========================================================================
    # Phase C — Hide /proc from non-root users
    # =========================================================================
    log "Hiding /proc from non-root users..."
    mount -o remount,hidepid=2 /proc 2>/dev/null || log "WARNING: Could not set hidepid=2 on /proc (may need --privileged)"
    boot_step hidepid

    # =========================================================================
    # Phase D — Drop privileges: gateway as 'geocluster', gate as root
    # =========================================================================
    log "Dropping privileges to 'geocluster' user and starting the runtime gateway..."

    # Ensure PATH includes standard binary directories so child processes
    # (the engine, its tool shells, `git`, `rg`) can find system binaries after
    # gosu drops privileges to the geocluster user. Every folder on it is
    # root-owned: the engine resolves rg, git and the shell from PATH.
    export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

    # Private file service: minimal env, separate UID, both secrets inherited only
    # through stdin opened by root. The trusted native launcher runs parsers as 997.
    # Preserve unset versus explicitly empty so both services use the same Origin parser/default.
    local file_origin_env=()
    if [ "${RUNTIME_ALLOWED_ORIGINS+x}" = x ]; then file_origin_env+=("RUNTIME_ALLOWED_ORIGINS=$RUNTIME_ALLOWED_ORIGINS"); fi
    (
        umask 0002
        exec env -i "${file_origin_env[@]}" PATH="$PATH" HOME=/nonexistent LANG="${LANG:-C.UTF-8}" NODE_ENV=production \
            PROJECT_ID="$PROJECT_ID" WORKSPACE_DIR="$WORKSPACE_DIR" FLY_MACHINE_ID="${FLY_MACHINE_ID:-}" \
            FILES_STATE_DIR="$FILES_STATE_DIR" RUNTIME_FILES_PORT="$FILES_PORT" \
            OWNED_DEMO_ENABLED="${OWNED_DEMO_ENABLED:-false}" \
            FILES_AGENT_UIDS="$FILES_AGENT_UIDS" FILES_WORKER_UIDS="$FILES_WORKER_UIDS" FILES_WORKER_UID="$FILES_WORKER_UID" \
            FILES_TRASH_AVAILABLE="$FILES_TRASH_AVAILABLE" FILES_SYNC_ADAPTER="$FILES_SYNC_ADAPTER" FILES_LIMITS="$FILES_LIMITS" VOXEL_LIMITS="$VOXEL_LIMITS" \
            VOXEL_AGENT_ENABLED=true \
            RUNTIME_MACHINE_GATEWAY_PORT="$MACHINE_GATEWAY_PORT" RUNTIME_FILE_WORK_POLL_MS="${RUNTIME_FILE_WORK_POLL_MS:-5000}" \
            RUNTIME_FILE_WORK_MAX_CLAIM_PAGES="${RUNTIME_FILE_WORK_MAX_CLAIM_PAGES:-100}" \
            FILES_WORKBOOK_WORKER_BIN="$FILES_WORKBOOK_WORKER_BIN" FILES_WORKBOOK_WORKER_ENABLED="$FILES_WORKBOOK_WORKER_ENABLED" \
            FILES_GIS_WORKER_BIN="$FILES_GIS_WORKER_BIN" FILES_GIS_WORKER_ENABLED="$FILES_GIS_WORKER_ENABLED" \
            PREPROCESSING_ENABLED="$PREPROCESSING_ENABLED" RUNTIME_AGGREGATE_ACTIVITY="$RUNTIME_AGGREGATE_ACTIVITY" \
            PREPROCESSING_URL="$PREPROCESSING_URL" PREPROCESSING_TOKEN_FILE=/proc/self/fd/3 \
            PREPROCESSING_PORT="${PREPROCESSING_PORT:-8765}" \
            PREPROCESSING_INBOX_DIR="$PREPROCESSING_INBOX_DIR" PREPROCESSING_BUNDLE_DIGEST="${PREPROCESSING_BUNDLE_DIGEST:-}" \
            PREPROCESSING_MODEL="${PREPROCESSING_MODEL:-}" PREPROCESSING_MAX_ACTIVE_TICKETS="${PREPROCESSING_MAX_ACTIVE_TICKETS:-100}" \
            PREPROCESSING_MAX_INPUT_BYTES="${PREPROCESSING_MAX_INPUT_BYTES:-268435456}" \
            PREPROCESSING_TRANSPORT_TIMEOUT_MS="${PREPROCESSING_TRANSPORT_TIMEOUT_MS:-5000}" \
            PREPROCESSING_JSON_MAX_BYTES="${PREPROCESSING_JSON_MAX_BYTES:-16777216}" \
            PREPROCESSING_POLL_RUNNING_MS="${PREPROCESSING_POLL_RUNNING_MS:-2000}" PREPROCESSING_POLL_QUEUED_MS="${PREPROCESSING_POLL_QUEUED_MS:-2000}" \
            PREPROCESSING_HELD_INPUT_WARN_BYTES="${PREPROCESSING_HELD_INPUT_WARN_BYTES:-1073741824}" \
            PREPROCESSING_STORAGE_RESERVE_BYTES="${PREPROCESSING_STORAGE_RESERVE_BYTES:-}" \
            PREPROCESSING_ACTIVITY_MAX_HOURS="${PREPROCESSING_ACTIVITY_MAX_HOURS:-6}" \
gosu gc-files node "$RUNTIME_CODE_DIR/files-server.js"
    ) < "$FILES_INPUT_FILE" 3< "$PREPROCESSING_TOKEN_FILE" 9>&- &
    FILES_PID=$!
    log "[files] Daemon started (PID: $FILES_PID), loopback port $FILES_PORT, agent readiness independent"
    boot_step files_spawned

    # The private lifecycle listener starts before demo initialization and SafeFs.
    # Keep ordinary workspace access and writers gated until the bundle is indexed.
    if [ "${OWNED_DEMO_ENABLED:-false}" = "true" ]; then
        while ! curl -sf -o /dev/null -H "X-GC-Gate: $(cat "$GATE_SECRET_FILE")" "http://127.0.0.1:$FILES_PORT/livez"; do
            kill -0 "$FILES_PID" 2>/dev/null || { log "ERROR: Demo file setup failed; inspect backend setup status and retry explicitly"; return 1; }
            sleep 0.1
        done
    fi

    # Pair startup never waits for conversation readiness. The root observer owns
    # aggregate activity, private accounting and bounded pair-only restarts.
    env -i PATH="$PATH" HOME=/nonexistent LANG="${LANG:-C.UTF-8}" RUNTIME_FILES_PORT="$FILES_PORT" \
        node "$RUNTIME_CODE_DIR/root-lifecycle.js" &
    LIFECYCLE_PID=$!

    # Runtime gateway on 127.0.0.1:3001 (geocluster): ACP bridge to one
    # `opencode acp` (the engine) and one shared MCP server, /livez, /readyz.
    # It reads the per-boot gate secret from stdin and refuses requests without it.
    # The engine gets an explicit env whitelist (runtime/lib/agent-supervisor.js).
    (
        umask 0002
        exec env -u RUNTIME_GATE_DISABLED -u RUNTIME_GATE_SECRET \
        PROJECT_ID="$PROJECT_ID" \
        RUNTIME_AGGREGATE_ACTIVITY="$RUNTIME_AGGREGATE_ACTIVITY" \
        WORKSPACE_DIR="$WORKSPACE_DIR" \
        RUNTIME_STATE_ROOT="$RUNTIME_STATE_ROOT" \
        RUNTIME_LOG_DIR="$LOG_DIR" \
        RUNTIME_GATEWAY_STATE_DIR="$GATEWAY_STATE_DIR" \
        RUNTIME_CONVERSATIONS_DIR="$CONVERSATIONS_DIR" \
        RUNTIME_GATEWAY_PORT="$GATEWAY_PORT" \
        RUNTIME_FILES_PORT="$FILES_PORT" \
        OPENCODE_BIN="$OPENCODE_BIN" \
        RUNTIME_OPENCODE_CONFIG_DIR="$OPENCODE_ROOT/config/managed" \
        RUNTIME_OPENCODE_MODELS_PATH="$OPENCODE_ROOT/config/models-empty.json" \
        RUNTIME_MANAGED_BACKEND_BASE_URL="$MANAGED_BACKEND_BASE_URL" \
        RUNTIME_MANAGED_CATALOG_PATH="$MANAGED_CATALOG_PATH" \
        RUNTIME_MANAGED_GENERATION="${RUNTIME_MANAGED_GENERATION:-}" \
        RUNTIME_MANAGED_DISCOVERY_MAX_BYTES="${RUNTIME_MANAGED_DISCOVERY_MAX_BYTES:-1048576}" \
        RUNTIME_ENGINE_HOME="$OPENCODE_ROOT/home" \
        RUNTIME_ENGINE_XDG_CONFIG_HOME="$OPENCODE_ROOT/xdg-config" \
        RUNTIME_ENGINE_STATE_DIR="$ENGINE_STATE_DIR" \
        MCP_WORKSPACE_ROOT="$WORKSPACE_DIR" \
        HOME="/home/geocluster" \
        NODE_OPTIONS="" \
        gosu geocluster node "$RUNTIME_CODE_DIR/server.js"
    ) < "$GATEWAY_INPUT_FILE" 9>&- &
    GATEWAY_PID=$!
    GATE_SECRET=""
    log "Runtime gateway started (PID: $GATEWAY_PID) on 127.0.0.1:$GATEWAY_PORT"
    boot_step gateway_spawned
    start_gateway_probe

    # Access gate on 0.0.0.0:3000 (public-facing): cookie auth, CORS, health
    # mirror, X-GC-Gate injection (see runtime/gate.cjs). Runs as root to read
    # the root-only key and secret files. PROJECT_ID is passed explicitly
    # (tokens and cookies are bound to it); FLY_MACHINE_ID is inherited and
    # disables the local-only RUNTIME_AUTH_DISABLED escape hatch.
    # Already listening since Phase A so backend lifecycle control reaches the
    # startup admission barrier. Ordinary upstreams become available only now.

    # Conditional wait preserves the exit code under set -e. Every normal/error
    # child exit uses the same drain as signals and failed startup.
    local exit_code=0
    local services=("$FILES_PID" "$GATEWAY_PID" "$GATE_PID" "$LIFECYCLE_PID")
    if [ -n "$MACHINE_GATEWAY_PID" ]; then services+=("$MACHINE_GATEWAY_PID"); fi
    if wait -n "${services[@]}"; then exit_code=0; else exit_code=$?; fi
    shutdown_handler "$exit_code" child_exit
}

validate_launch() {
    local frontend="${1:-headless}" expected name
    [ "$#" -le 1 ] || { echo 'usage: entrypoint.sh tui|headless' >&2; return 2; }
    # This is the sole supported profile/frontend table.
    case "$frontend" in
        tui) expected=native ;;
        headless) expected=managed ;;
        *) echo 'usage: entrypoint.sh tui|headless' >&2; return 2 ;;
    esac
    if [ "${RUNTIME_PROFILE+x}" = x ] && [ "$RUNTIME_PROFILE" != "$expected" ]; then
        echo "runtime profile/frontend conflict: $frontend requires RUNTIME_PROFILE=$expected" >&2; return 2
    fi
    RUNTIME_PROFILE="$expected"
    export RUNTIME_PROFILE
    if [ "$frontend" = tui ] && { [ ! -t 0 ] || [ ! -t 1 ]; }; then
        echo 'native TUI requires a terminal; allocate a TTY or use headless with the managed profile' >&2; return 2
    fi
    if [ "$expected" = managed ]; then
        if [ -z "${IDE_MACHINE_CREDENTIALS_URL:-}" ] || [ -z "${IDE_MACHINE_TOKEN:-}${IDE_MACHINE_TOKEN_FILE:-}" ] || [ -n "${IDE_LLM_TOKEN:-}${PREPROCESSING_PROXY_TOKEN:-}${RUNTIME_ACTIVITY_TOKEN:-}" ]; then
            echo 'managed startup requires the root-held machine credential relay; static purpose credentials are unsupported; use the native profile for personal providers' >&2; return 2
        fi
        for name in $(compgen -e); do
            if supplier_credential_name "$name" && [ -n "${!name}" ]; then
                echo 'managed startup must not receive supplier credentials; keep them in the backend' >&2; return 2
            fi
        done
    else
        if [ -n "${RUNTIME_NATIVE_PROCESSING_ENGINE_DESCRIPTOR:-}" ] && [ -z "${RUNTIME_NATIVE_PROCESSING_MODEL:-}" ]; then
            echo 'an engine descriptor requires a processing model (--processing-model)' >&2; return 2
        fi
        if [ -n "${RUNTIME_NATIVE_PROCESSING_MODEL:-}" ] && ! [[ "$RUNTIME_NATIVE_PROCESSING_MODEL" =~ ^[^/[:space:][:cntrl:]#]+/[^[:space:][:cntrl:]#]+(#[A-Za-z0-9._-]+)?$ ]]; then
            echo 'processing model must be provider/model[#variant]; model IDs may contain slashes' >&2; return 2
        fi
        for name in PREPROCESSING_ENABLED RUNTIME_AGGREGATE_ACTIVITY FILES_SYNC_ADAPTER OWNED_DEMO_ENABLED SYNC_ENABLED RUNTIME_TUI_ENABLED; do
            if [ "${!name:-false}" != false ] && [ -n "${!name:-}" ]; then
                echo "native profile does not support $name; choose managed/headless for managed services" >&2; return 2
            fi
        done
    fi
    if [ "${RUNTIME_TUI_ENABLED:-false}" != false ]; then
        echo 'RUNTIME_TUI_ENABLED is unsupported; use entrypoint.sh tui with the native profile' >&2; return 2
    fi
    if [ "$EUID" -ne 0 ]; then
        echo 'runtime setup requires a root container entrypoint; remove the container user override (host root is not required)' >&2; return 2
    fi
}

launch_runtime() {
    local locked=false
    if [ "${1:-}" = --runtime-lock-held ]; then locked=true; shift; fi
    validate_launch "$@" || return $?
    if [ "$locked" = false ]; then
        exec /usr/bin/python3 -I "$RUNTIME_CODE_DIR/lifecycle-lock.py" /workspace "$RUNTIME_PROFILE" /bin/bash /entrypoint.sh --runtime-lock-held "${1:-headless}"
    fi
    # The exec-held descriptor stays open until the owner and its services exit.
    [ -e /proc/self/fd/9 ] || { echo 'runtime lifecycle lock descriptor is missing' >&2; return 2; }
    BOOT_START_MS=$(date +%s%3N 2>/dev/null || echo 0)
    BOOT_LAST_MS="$BOOT_START_MS"
    if [ "$RUNTIME_PROFILE" = native ]; then
        source "$RUNTIME_CODE_DIR/native-services.sh"
        native_main
        return $?
    fi
    if [ -n "${LOCAL_WORKSPACE_HOST_UID:-}" ]; then run_local_workspace validate; fi
    install_managed_traps
    main
}

# Run main function
launch_runtime "$@"
