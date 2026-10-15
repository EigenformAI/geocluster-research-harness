#!/bin/bash
# =============================================================================
# Shared dev runtime: the production image, one folder as the workspace, no auth
# =============================================================================
# Setup and mount requirements: docs/RUNTIME_FILES_DEPLOYMENT.md.
# Client integration: docs/RUNTIME_API.md.
# This launcher disables gate authentication outside Fly. Anyone who reaches its
# port can access the workspace and use the project's managed model authority.
#
# Usage:
#   scripts/run-runtime-dev.sh start     # (re)create the container, wait for /readyz
#   scripts/run-runtime-dev.sh status    # readyz summary + container state
#   scripts/run-runtime-dev.sh logs      # follow the container log
#   scripts/run-runtime-dev.sh stop      # stop and remove the container (workspace untouched)
#
# Set the workspace, state, image, trusted env-file, and reachable proxy URL
# explicitly for your development machine.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

NAME="${RUNTIME_DEV_NAME:-gc-runtime-dev-api3}"
IMAGE="${RUNTIME_DEV_IMAGE:-geocluster-runtime:opencode}"
PORT="${RUNTIME_DEV_PORT:-3311}"
WORKSPACE_SRC="${RUNTIME_DEV_WORKSPACE:-/root/geocluster-ai/WA_Mailman_Hill/mailman_hill_workspace/reports_luna}"
PROJECT_ID="${RUNTIME_DEV_PROJECT_ID:-reports_luna}"
# Retains engine state, gateway events, and protected file state across restarts.
STATE_DIR="${RUNTIME_DEV_STATE_DIR:-/root/geocluster-ai/.runtime-dev/$PROJECT_ID-api3}"
# A single retained root must already contain <project>/ to avoid a nested bind
# mount. The default keeps the existing data layout and explicitly disables trash.
VOLUME_ROOT="${RUNTIME_DEV_VOLUME_ROOT:-}"
DRAIN_TIMEOUT="${RUNTIME_DRAIN_TIMEOUT_S:-240}"
# Browser origins allowed by CORS (comma-separated, scheme://host[:port], *.suffix wildcards)
ORIGINS="${RUNTIME_DEV_ORIGINS:-http://localhost:3000,http://127.0.0.1:3000}"
ENV_FILE="${RUNTIME_DEV_ENV_FILE:-$REPO_ROOT/.env.local}"
PROXY_URL="${RUNTIME_DEV_PROXY_URL:-http://172.17.0.1:8193/api/v1/llm-proxy}"

log() { echo "[runtime-dev] $*"; }

readyz() { curl -s -m 5 "http://127.0.0.1:$PORT/readyz" || true; }

cmd_start() {
    docker image inspect "$IMAGE" >/dev/null 2>&1 || { log "image $IMAGE missing: IMAGE_NAME=${IMAGE%%:*} IMAGE_TAG=${IMAGE##*:} scripts/build-docker.sh"; exit 1; }
    [ -d "$WORKSPACE_SRC" ] || { log "workspace folder not found: $WORKSPACE_SRC"; exit 1; }
    [ -f "$ENV_FILE" ] || { log "env file not found: $ENV_FILE (needs renewable machine credentials)"; exit 1; }
    case "$DRAIN_TIMEOUT" in ''|*[!0-9]*|0) log "RUNTIME_DRAIN_TIMEOUT_S must be a positive integer"; exit 1 ;; esac
    local mounts=() trash_available=false
    if [ -n "$VOLUME_ROOT" ]; then
        [ -d "$VOLUME_ROOT" ] || { log "retained volume root not found: $VOLUME_ROOT"; exit 1; }
        [ "$(realpath "$WORKSPACE_SRC")" = "$(realpath "$VOLUME_ROOT")/$PROJECT_ID" ] || {
            log "single-mount mode requires RUNTIME_DEV_WORKSPACE=$VOLUME_ROOT/$PROJECT_ID"; exit 1;
        }
        mounts=(-v "$VOLUME_ROOT:/workspace")
        trash_available=true
    else
        mkdir -p "$STATE_DIR"
        chmod 700 "$(dirname "$STATE_DIR")"
        mounts=(-v "$STATE_DIR:/workspace" -v "$WORKSPACE_SRC:/workspace/$PROJECT_ID")
        log "nested project bind mount: deletion disabled (protected trash cannot be assumed rename-compatible)"
    fi

    # The trusted file supplies only root-held renewal credentials. The native
    # launcher does not source this file or require any GeoCluster credentials.
    IDE_MACHINE_TOKEN="$(set -a; . "$ENV_FILE" >/dev/null 2>&1; printf '%s' "${IDE_MACHINE_TOKEN:-}")"
    IDE_MACHINE_CREDENTIALS_URL="$(set -a; . "$ENV_FILE" >/dev/null 2>&1; printf '%s' "${IDE_MACHINE_CREDENTIALS_URL:-}")"
    [ -n "$IDE_MACHINE_TOKEN" ] && [ -n "$IDE_MACHINE_CREDENTIALS_URL" ] || { log "IDE_MACHINE_TOKEN and IDE_MACHINE_CREDENTIALS_URL are required in $ENV_FILE"; exit 1; }
    export IDE_MACHINE_TOKEN IDE_MACHINE_CREDENTIALS_URL

    if ! curl -s -m 3 -o /dev/null "${PROXY_URL%/api/v1/llm-proxy}/docs"; then
        log "WARNING: LLM proxy not answering at $PROXY_URL; the agent will fail every turn until it does"
    fi

    # Graceful: cancel running turns and drain retained file state before removal (rm -f = SIGKILL).
    docker stop -t "$((DRAIN_TIMEOUT + 5))" "$NAME" >/dev/null 2>&1 || true
    docker rm -f "$NAME" >/dev/null 2>&1 || true

    # 4 GB is a canary limit, not measured proof of capacity for concurrent chat/extraction.
    docker run -d --name "$NAME" \
        --memory 4g --cpus 2 \
        --stop-timeout "$((DRAIN_TIMEOUT + 5))" \
        --health-cmd 'curl -f http://localhost:3000/livez || exit 1' \
        --health-start-period 60s --health-interval 30s --health-timeout 10s --health-retries 3 \
        -p "$PORT:3000" \
        "${mounts[@]}" \
        -e RUNTIME_PROFILE=managed -e PROJECT_ID="$PROJECT_ID" -e USER_ID=dev -e SYNC_ENABLED=false \
        -e RUNTIME_FILES_PORT=3002 -e FILES_TRASH_AVAILABLE="$trash_available" \
        -e RUNTIME_DRAIN_TIMEOUT_S="$DRAIN_TIMEOUT" \
        -e PREPROCESSING_ENABLED="${PREPROCESSING_ENABLED:-false}" \
        -e RUNTIME_AGGREGATE_ACTIVITY="${RUNTIME_AGGREGATE_ACTIVITY:-false}" \
        -e PREPROCESSING_MODEL="${PREPROCESSING_MODEL:-}" \
        -e IDE_MACHINE_TOKEN -e IDE_MACHINE_CREDENTIALS_URL \
        -e RUNTIME_ACTIVITY_URL="${RUNTIME_ACTIVITY_URL:-}" \
        -e RUNTIME_AUTH_DISABLED=1 \
        -e RUNTIME_ALLOWED_ORIGINS="$ORIGINS" \
        -e RUNTIME_FRAME_ANCESTORS="${ORIGINS//,/ }" \
        -e LLM_PROXY_URL="$PROXY_URL" \
        "$IMAGE" headless >/dev/null
    log "container $NAME started; waiting for /readyz (30-90 s)"

    local code="" files_code="" files_reported=false
    for _ in $(seq 1 60); do
        code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/readyz" || true)
        files_code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/files/info" || true)
        if [ "$files_code" = "200" ] && [ "$files_reported" = "false" ]; then
            log "file daemon ready (ACP readiness=$code)"
            files_reported=true
        fi
        [ "$code" = "200" ] && [ "$files_code" = "200" ] && break
        if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
            log "container exited; last log lines:"; docker logs --tail 30 "$NAME" 2>&1; exit 1
        fi
        sleep 3
    done
    [ "$code" = "200" ] && [ "$files_code" = "200" ] || { log "not ready (agent $code, files $files_code); see: $0 logs"; exit 1; }
    cmd_status
}

cmd_status() {
    docker ps -a --filter "name=^${NAME}$" --format '{{.Names}}  {{.Status}}  {{.Ports}}'
    readyz | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);const a=(r.components||{}).agents||{};
const run=(r.sessions||[]).filter(x=>x.turn==="running").map(x=>x.sessionId);
if(r.api===3){const e=r.components?.engine||{},m=r.components?.mcp||{};
console.log(`ready=${r.ready} api=3 engine=${e.state??"unknown"} v${e.version??"unknown"} tools=${e.tools??"unknown"} generation=${e.generation??"unknown"} mcp=${m.state??"unknown"} running=${r.running??"unknown"}/${r.capacity?.maxRunning??"unknown"} running_ids=${run.join(",")||"none"}`);return}
if(r.api!==2){console.log(`ready=${r.ready} (api ${r.api??1}: single-conversation image)`);return}
console.log(`ready=${r.ready} api=2 resident=${a.resident} running=${a.running}/${a.capacity?.maxRunning} spare=${a.spare} running_ids=${run.join(",")||"none"}`)}catch{console.log("readyz: no answer")}})'
    log "workspace: $WORKSPACE_SRC -> /workspace/$PROJECT_ID"
    if [ -n "$VOLUME_ROOT" ]; then log "single retained mount: $VOLUME_ROOT -> /workspace";
    else log "nested bind mounts: delete unavailable; use one retained root for protected trash"; fi
    log "origins:   $ORIGINS"
    log "url:       http://$(curl -4 -s -m 3 ifconfig.me 2>/dev/null || hostname -f):$PORT"
}

case "${1:-}" in
    start) cmd_start ;;
    status) cmd_status ;;
    logs) docker logs -f --tail 100 "$NAME" ;;
    stop) docker stop -t "$((DRAIN_TIMEOUT + 5))" "$NAME" >/dev/null 2>&1 || true; docker rm "$NAME" >/dev/null 2>&1 || true; log "stopped" ;;
    *) echo "usage: $0 start|status|logs|stop"; exit 2 ;;
esac
