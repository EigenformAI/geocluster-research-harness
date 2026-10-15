#!/bin/bash
# Sourced by the root entrypoint after profile validation and volume locking.

wait_for_native_services() {
    local code resized
    resized=$((128 + $(kill -l WINCH)))
    while true; do
        if wait -n "$NATIVE_PID" "$FILES_PID"; then return 0; else code=$?; fi
        [ "$code" -eq "$resized" ] || return "$code"
        # A handled resize interrupts Bash's wait without ending either child.
        # Preserve a real exit that raced that interruption; otherwise wait again.
        if ! kill -0 "$NATIVE_PID" 2>/dev/null; then wait "$NATIVE_PID"; return $?; fi
        if ! kill -0 "$FILES_PID" 2>/dev/null; then wait "$FILES_PID"; return $?; fi
    done
}

native_shutdown() {
    local code="${1:-0}" deadline
    [ "$SHUTDOWN_STARTED" = false ] || return
    SHUTDOWN_STARTED=true
    trap - EXIT
    trap '' TERM INT QUIT
    set +e
    deadline=$(NODE_OPTIONS='' node -e 'console.log(new Date(Date.now()+Number(process.argv[1])*1000).toISOString())' "$RUNTIME_DRAIN_TIMEOUT_S")
    if [ -n "$NATIVE_PID" ]; then
        if [ -n "${RUNTIME_NATIVE_PROCESSING_MODEL:-}" ]; then
            # Signal only the leader until its processor-before-engine drain ends.
            NODE_OPTIONS='' node -e 'require("fs").writeFileSync(process.argv[1], String(Date.parse(process.argv[2])-1000), {mode:0o644,flag:"wx"})' "$RUNTIME_STATE_ROOT/native/drain-deadline" "$deadline"
            stop_process_tree "$NATIVE_PID" "$deadline" "$((RUNTIME_DRAIN_TIMEOUT_S * 1000 - 2000))" || code=1
        else stop_process_tree "$NATIVE_PID" "$deadline" 5000 || code=1
        fi
    fi
    if [ -n "$FILES_PID" ]; then
        request_files_drain "$deadline" true >/dev/null
        request_files_drain "$deadline" >/dev/null
        stop_process_tree "$FILES_PID" "$deadline" 1000
    fi
    exit "$code"
}

native_main() {
    NATIVE_PID=''
    RUNTIME_MCP_PORT=7710
    # All errors before child startup remain setup failures, with no drain writes.
    prepare_protected_parents
    root_directory "$RUN_DIR" 0700
    root_directory "$ROOT_LOG_DIR" 0755
    root_directory "$RUNTIME_STATE_ROOT/native" 0755
    rm -f "$RUNTIME_STATE_ROOT/native/drain-deadline"
    ENGINE_STATE_DIR="$RUNTIME_STATE_ROOT/native/opencode"
    ensure_real_dir "$ENGINE_STATE_DIR"
    chmod 0700 "$ENGINE_STATE_DIR"
    # Only create the project root; never recursively re-own host project inputs.
    ensure_real_dir "$WORKSPACE_DIR"
    chmod 2775 "$WORKSPACE_DIR"
    local processing_root="$RUNTIME_STATE_ROOT/native/processing/$PROJECT_ID"
    if [ -n "${RUNTIME_NATIVE_PROCESSING_MODEL:-}" ]; then
        root_directory "$RUNTIME_STATE_ROOT/native/processing" 0755
        ensure_real_dir "$processing_root"
        chmod 0700 "$processing_root"
    fi
    NODE_OPTIONS='' node "$RUNTIME_CODE_DIR/native-tui.mjs" prepare "$ENGINE_STATE_DIR" "$RUN_DIR/native-engine.json" "$processing_root"
    write_gate_secret >&2
    write_files_input
    NATIVE_LOG="$ENGINE_STATE_DIR/logs"
    env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin gosu geocluster mkdir -p -m 0700 "$NATIVE_LOG"
    ( umask 077; printf 'X-GC-Gate: %s\n' "$GATE_SECRET" > "$RUN_DIR/native-health-header" )
    trap 'native_shutdown 143' TERM
    trap 'native_shutdown 130' INT
    trap 'native_shutdown 131' QUIT
    trap 'native_shutdown "$?"' EXIT
    (
        umask 0002
        exec env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/nonexistent LANG=C.UTF-8 NODE_ENV=production \
            PROJECT_ID="$PROJECT_ID" WORKSPACE_DIR="$WORKSPACE_DIR" FILES_STATE_DIR="$FILES_STATE_DIR" \
            RUNTIME_FILES_PORT="$FILES_PORT" FILES_AGENT_UIDS=999 FILES_WORKER_UIDS=997 FILES_WORKER_UID=997 \
            FILES_TRASH_AVAILABLE="$FILES_TRASH_AVAILABLE" FILES_SYNC_ADAPTER=false FILES_LIMITS="$FILES_LIMITS" VOXEL_LIMITS="$VOXEL_LIMITS" \
            VOXEL_AGENT_ENABLED=true FILES_WORKBOOK_WORKER_BIN="$FILES_WORKBOOK_WORKER_BIN" \
            FILES_WORKBOOK_WORKER_ENABLED="$FILES_WORKBOOK_WORKER_ENABLED" FILES_GIS_WORKER_BIN="$FILES_GIS_WORKER_BIN" \
            FILES_GIS_WORKER_ENABLED="$FILES_GIS_WORKER_ENABLED" \
            gosu gc-files node "$RUNTIME_CODE_DIR/files-server.js"
    ) < "$FILES_INPUT_FILE" 9>&- >> "$ROOT_LOG_DIR/native-files.log" 2>&1 &
    FILES_PID=$!
    local ready=false i
    for ((i=0; i<300; i++)); do
        kill -0 "$FILES_PID" 2>/dev/null || { echo 'native file daemon exited; inspect /var/log/runtime-root/native-files.log' >&2; return 1; }
        if curl -sf --max-time 1 -o /dev/null -H "@$RUN_DIR/native-health-header" "http://127.0.0.1:$FILES_PORT/livez"; then ready=true; break; fi
        sleep 0.1
    done
    [ "$ready" = true ] || { echo 'native file daemon readiness timed out' >&2; return 1; }
    echo '[native] profile=native frontend=tui identity=999 services=files,mcp,opencode; use /connect then /models' >&2
    # Root opens the finite native launch handoff; it contains no platform authority.
    env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME="$ENGINE_STATE_DIR/home" \
        RUNTIME_NATIVE_DRAIN_TIMEOUT_MS="$((RUNTIME_DRAIN_TIMEOUT_S * 1000))" \
        gosu geocluster node "$RUNTIME_CODE_DIR/native-tui.mjs" run "$ENGINE_STATE_DIR" "$WORKSPACE_DIR" \
        3< "$RUN_DIR/native-engine.json" 9>&- <&0 &
    NATIVE_PID=$!
    trap 'kill -WINCH "$NATIVE_PID" 2>/dev/null || true' WINCH
    local code=0
    if wait_for_native_services; then code=0; else code=$?; fi
    if ! kill -0 "$FILES_PID" 2>/dev/null && kill -0 "$NATIVE_PID" 2>/dev/null; then
        echo 'native file daemon exited unexpectedly; inspect /var/log/runtime-root/native-files.log and restart the container' >&2
        code=1
    fi
    native_shutdown "$code"
}
