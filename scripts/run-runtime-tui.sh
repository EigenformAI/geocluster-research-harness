#!/bin/bash
# Native accounts remain in the selected container volume, not the host's home.
set -euo pipefail

image="${RUNTIME_TUI_IMAGE:-geocluster-runtime:latest}"
volume=geocluster-native-workspace
workspace_root=''
require_existing_workspace=false
names=()
processing_model=''
processing_descriptor=''
die() { echo "runtime-tui: $*" >&2; exit 2; }
while [ "$#" -gt 0 ]; do
    case "$1" in
        --image|--workspace-volume|--workspace-root|--engine-env|--processing-model|--processing-engine-descriptor)
            [ "$#" -ge 2 ] || die "$1 requires a value"
            case "$1" in
                --image) image="$2" ;;
                --workspace-volume) volume="$2" ;;
                --workspace-root) workspace_root="$2" ;;
                --processing-model) processing_model="$2" ;;
                --processing-engine-descriptor) processing_descriptor="$2" ;;
                --engine-env)
                    name="$2"
                    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "invalid engine environment name: $name"
                    case "$name" in
                        PROJECT_ID|OPENCODE_*|GEOCLUSTER_*|RUNTIME_*|IDE_*|PREPROCESSING_*|R2_*|XDG_*|LD_*|HOME|PATH|NODE_OPTIONS|BUN_OPTIONS|PYTHONHOME|PYTHONPATH|LLM_PROXY_URL|SYNC_ENABLED|FILES_SYNC_ADAPTER|OWNED_DEMO_ENABLED)
                            die "reserved engine environment name: $name" ;;
                    esac
                    [ "${!name+x}" = x ] || die "engine environment variable $name is not set"
                    export "$name"
                    names+=("$name") ;;
            esac
            shift 2 ;;
        --require-existing-workspace)
            require_existing_workspace=true
            shift ;;
        --help|-h)
            echo 'usage: scripts/run-runtime-tui.sh [--image IMAGE] [--workspace-volume NAME | --workspace-root DIRECTORY] [--require-existing-workspace] [--engine-env NAME]... [--processing-model PROVIDER/MODEL[#VARIANT]] [--processing-engine-descriptor FILE]'
            echo '  --require-existing-workspace  Refuse missing or unsafe workspace content under the workspace lock.'
            exit 0 ;;
        *) die "unknown option: $1" ;;
    esac
done
[ -z "$processing_descriptor" ] || [ -n "$processing_model" ] || die 'an engine descriptor requires a processing model (--processing-model)'
if [ -n "$processing_model" ] && ! [[ "$processing_model" =~ ^[^/[:space:][:cntrl:]#]+/[^[:space:][:cntrl:]#]+(#[A-Za-z0-9._-]+)?$ ]]; then
    die 'processing model must be provider/model[#variant]; model IDs may contain slashes'
fi
if [ "${RUNTIME_PROFILE+x}" = x ] && [ "$RUNTIME_PROFILE" != native ]; then
    die 'runtime profile/frontend conflict: this helper requires RUNTIME_PROFILE=native'
fi
[ -t 0 ] && [ -t 1 ] || die 'native TUI requires a terminal; allocate a TTY or use headless with the managed profile'
mount=(--mount "type=volume,src=$volume,dst=/workspace")
if [ -n "$workspace_root" ]; then
    [ -d "$workspace_root" ] || die 'workspace root must be an existing retained volume directory'
    mount=(--mount "type=bind,src=$(realpath "$workspace_root"),dst=/workspace")
fi
forward=()
pull=()
if [ "$require_existing_workspace" = true ]; then
    forward+=(-e RUNTIME_REQUIRE_EXISTING_PROJECT=1)
    pull=(--pull=never)
fi
for name in "${names[@]}"; do forward+=(-e "$name"); done
if [ -n "$processing_model" ]; then forward+=(-e "RUNTIME_NATIVE_PROCESSING_MODEL=$processing_model"); fi
if [ -n "$processing_descriptor" ]; then
    [ -f "$processing_descriptor" ] && [ ! -L "$processing_descriptor" ] || die 'engine descriptor must be a regular file, not a symlink'
    forward+=(--mount "type=bind,src=$(realpath "$processing_descriptor"),dst=/run/native-external-engine.json,readonly" -e RUNTIME_NATIVE_PROCESSING_ENGINE_DESCRIPTOR=/run/native-external-engine.json)
fi
joined=$(IFS=,; echo "${names[*]}")
# -e NAME lets Docker read the value from its environment; never put it in argv.
exec docker run --rm -it --init --no-healthcheck --stop-timeout 245 \
    "${pull[@]}" "${mount[@]}" -e RUNTIME_PROFILE=native -e PROJECT_ID=default \
    -e RUNTIME_NATIVE_ENGINE_ENV="$joined" "${forward[@]}" "$image" tui
