# Runtime configuration

These settings configure the container and its build. Application-backend
configuration belongs to the application that provisions the runtime.
Unless stated otherwise, supply settings before container startup.

## Deployment profiles and frontends

| Setting or command | Purpose |
| --- | --- |
| `RUNTIME_PROFILE` | `native` or `managed`. The public TUI helper selects `native`; deployment templates explicitly select `managed`. |
| `entrypoint.sh tui` | Native OpenCode TUI with local file and MCP services. Requires a terminal. |
| `entrypoint.sh headless` | Managed access gate, gateway, and ACP engine. An omitted command retains this managed headless default. |

Only native TUI and managed headless combinations are supported. A conflicting
explicit profile fails before services start. Profile selection does not depend
on tokens, hostnames, saved conversations, or authentication bypass.

## Managed project access and model proxy

| Setting | Purpose |
| --- | --- |
| `USER_ID`, `PROJECT_ID` | User and project association supplied by the provisioner. |
| `IDE_PROXY_KEY` | Per-project gate signing key. Root stores it privately. Without a key, authenticated routes remain unavailable. |
| `RUNTIME_ALLOWED_ORIGINS` | Comma-separated allowed browser origins. Replaces the defaults, `https://geocluster.net,https://www.geocluster.net`. |
| `RUNTIME_FRAME_ANCESTORS` | CSP sources allowed to embed previews. Separate from CORS origins. |
| `RUNTIME_AUTH_DISABLED` | `1` bypasses authentication for local testing. Ignored when `FLY_MACHINE_ID` is set. |
| `LLM_PROXY_URL` | Managed model-proxy base URL. |
| `IDE_LLM_TOKEN` | Internal managed purpose authority supplied through root credential handling. A static token alone is not a supported managed configuration. |
| `RUNTIME_DEFAULT_EFFORT` | Default advertised reasoning effort. `high` by default; `default` retains the engine's choice. |
| `RUNTIME_MANAGED_DISCOVERY_MAX_BYTES` | `1048576`; maximum complete authenticated `/account` response size in bytes. |

Managed declarations come from authenticated `/account` discovery schema version
2, including `managed_models`, `allowed_model_ids`, and nullable
`default_model_id`. Version 1 and unknown versions are unsupported. The backend
owns model metadata and eligibility and authorizes every attempt. Supplier keys
remain in the backend, not in the runtime environment or connection database.

The installed declarations are immutable for an engine lifetime. New declarations
or changed metadata require an explicit drained container restart, not an image
rebuild. Eligibility refresh does not reload the engine catalog. Discovery can be
fresh, stale, or unavailable. Retained same-identity declarations are not proof of
current permission. A null default or cold discovery outage leaves model sessions
unavailable without a fabricated fallback. Independent file services remain usable.

## Renewable machine credentials

| Setting | Purpose |
| --- | --- |
| `IDE_MACHINE_CREDENTIALS_URL` | Root-private credential-renewal endpoint. |
| `IDE_MACHINE_TOKEN` | Generation-bound renewal credential, written to a root-private file and removed from child environments. |
| `IDE_MACHINE_TOKEN_FILE` | Credential-file alternative for standalone root configuration. |
| `RUNTIME_MACHINE_GATEWAY_PORT` | Loopback credential gateway; default `3003`. |

The managed profile requires the renewal URL and a credential. Missing or partial
configuration fails boot; static upstream purpose tokens are not a supported
alternative. The engine receives a loopback proxy URL and `runtime-relay` marker.
Root supplies renewed purpose credentials to a fixed backend destination. Agents
and browsers receive no machine renewal or upstream purpose credential. Operators
who want their own supplier credentials use the native profile.

## Local native terminal UI

`./scripts/run-runtime-tui.sh` starts the pinned engine after local services are
ready. Ordinary startup uses `--standalone`. Optional native processing uses one
owned server with a `--server` TUI attachment. `/connect` manages native accounts. `/models` selects
models. No `LLM_PROXY_URL`, `IDE_LLM_TOKEN`, machine credential, or backend activity
endpoint is required. Native startup publishes no host ports. TUI exit shuts down
its owned local services rather than leaving a gateway running.

Native user configuration uses ordinary OpenCode `opencode.json` or
`opencode.jsonc`. Its writable XDG config is separate from bundled geology config.
The native XDG config root is `/workspace/.runtime/native/opencode/config`.
Project configuration discovery is enabled. Project plugins and configuration
can execute as the engine identity and must be trusted.

Connections and sessions persist under `/workspace/.runtime/native/opencode` with
mode `0700`. This state is outside file APIs, MCP project access, sync, and
automatic diagnostics. Whole-volume backups can still contain secrets. Shell
tools running as the engine identity can access that identity's credentials;
native mode is not a credential sandbox. Host credentials are never imported
automatically.

The helper accepts repeatable `--engine-env NAME` for explicit provider variables,
such as `OPENROUTER_API_KEY`. Values come from the operator environment, not
command arguments. MCP and file workers receive no provider variables. The helper
rejects bootstrap and execution-control names: `OPENCODE_*`, `GEOCLUSTER_*`,
`RUNTIME_*`, `IDE_*`, `PREPROCESSING_*`, `R2_*`, `XDG_*`, `HOME`, `PATH`,
`NODE_OPTIONS`, `BUN_OPTIONS`, `LD_*`, `PYTHONHOME`, and `PYTHONPATH`. This is a
packaged-helper restriction, not an OpenCode provider policy.

Stale managed credentials do not enable managed services or reach native children.
Explicit managed-service requests fail in native mode. Backend sync, hydration,
aggregate activity, and machine renewal are not part of native startup. Document
processing is disabled unless explicitly selected through native options below.

| Native option or setting | Purpose |
| --- | --- |
| `--processing-model`, `RUNTIME_NATIVE_PROCESSING_MODEL` | Optional exact `provider/model[#variant]`; enables native processing independently of `/models`. No provider or model fallback. Changing it requires a restart. |
| `--processing-engine-descriptor`, `RUNTIME_NATIVE_PROCESSING_ENGINE_DESCRIPTOR` | Optional owner-supplied external extraction descriptor. Requires an explicit processing model. The helper mounts the regular JSON file privately. The runtime never stops the borrowed engine. |

Native processing uses the installed processor's standalone interface, not managed
admission, model policy, or aggregate activity. It exposes seven processor MCP
tools to DataOps and Standard mode. Results and job history are workspace-wide,
under `/workspace/.runtime/native/processing/<PROJECT_ID>/`. The default processor
endpoint is private loopback port `8765`. See
[native document processing](docs/NATIVE_DOCUMENT_PROCESSING.md) for setup,
recovery, custom-provider declarations, and retained-state protection.

Both profiles hold the same exclusive retained-volume lifecycle lock and check a
root-controlled profile marker. Concurrent ownership and cross-profile reuse are
unsupported. To change profiles, transfer only ordinary data and saved results
from `/workspace/<PROJECT_ID>/` into a fresh volume's project directory. Never
copy the enclosing volume root, `.runtime`, or `.ide-state`.

## Local workspace sharing

| Setting | Default and purpose |
| --- | --- |
| `LOCAL_WORKSPACE_HOST_UID` | Empty; opt-in numeric host UID for the headless local sharing setup. The native TUI helper does not select it automatically. |
| `LOCAL_WORKSPACE_SCAN_MS` | `30000`; startup sharing scan budget in milliseconds. Must be a positive safe integer. |

Sharing requires local Docker with identity UID and GID mappings. Backend-managed
storage deployments are unsupported. Private runtime state and explicitly private files
remain private. Recreate the container after changing these settings. Use
`./scripts/workspace.sh upload SOURCE DESTINATION` for files that need a shared
copy in the selected local Compose installation. This helper targets the headless
Compose service, not a container started by `run-runtime-tui.sh`. The destination
is relative to the project.

## Storage and dataset integration

| Setting | Purpose |
| --- | --- |
| `FILES_SYNC_ADAPTER` | Managed backend persistence adapter; requires both file endpoints and renewable machine credentials. |
| `RUNTIME_FILES_URL`, `RUNTIME_FILE_WORK_URL` | Root-private backend file and file-work endpoints. Configuring both selects the managed adapter. |
| `IDE_FILES_TOKEN`, `IDE_WORK_TOKEN` | Boot purpose credentials for those endpoints; root renews them. |
| `RUNTIME_FILE_WORK_POLL_MS` | `5000`; delay after a managed import cycle finishes, in milliseconds. |
| `RUNTIME_FILE_WORK_MAX_CLAIM_PAGES` | `100`; maximum ten-file claim pages per drain pass. Each cycle drains before and after hydration. `0` disables the page cap. |
| `IDE_DATASETS_URL`, `IDE_DATASET_TOKEN` | Private dataset manifest endpoint and purpose credential for boot hydration. |
| `SYNC_ENABLED` | General rclone workspace sync; off by default and excluded by the managed adapter. Its download direction can delete local entries. |
| `SYNC_INTERVAL` | General synchronization interval in seconds. |
| `R2_ENDPOINT`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_BUCKET` | Object-storage configuration for general sync. Credentials remain root-private. |
| `FILES_STATE_DIR` | Private retained file state beneath `/workspace/.runtime/file-service/`; default includes `PROJECT_ID`. |
| `FILES_TRASH_AVAILABLE` | `false` disables new deletion. `true` still requires successful filesystem checks. |

Local publication, retained-volume durability, and remote acknowledgement are
separate outcomes. Read availability and persistence from `/files/info` and
operation receipts. The [deployment guide](docs/RUNTIME_FILES_DEPLOYMENT.md)
describes mount and identity requirements.

## Runtime capacity and limits

| Setting | Default and purpose |
| --- | --- |
| `RUNTIME_MAX_RUNNING` | `3` concurrent conversation turns. |
| `RUNTIME_MEMORY_GUARD_PCT` | `85`; refuse a new turn above this container-memory percentage. |
| `RUNTIME_PERMISSION_TIMEOUT_S` | `1800`; reject unanswered permission requests after this many seconds. |
| `RUNTIME_MAX_TURN_HOURS` | `6`; advisory turn-age notice. `0` disables the notice. |
| `RUNTIME_DRAIN_TIMEOUT_S` | `240`; shared shutdown deadline in seconds. |
| `FILES_LIMITS` | JSON overrides for file-service budgets and retention. Effective values appear in `/files/info`. |
| `VOXEL_LIMITS` | JSON overrides for voxel budgets. Effective values appear in `/voxels`. |
| `VOXEL_AGENT_ENABLED` | `true` in the image; enables the restricted canonical voxel bridge. |
| `RUNTIME_LOG_DIR` | Runtime log directory; `/var/log/runtime` in the image. |

Unknown or invalid budget names are rejected. Raising a configurable budget does
not override filesystem ownership, native confinement, or installed physical
ceilings. Conversation turn age does not terminate work.

## Managed document-processing configuration

The following settings configure managed headless processing. They do not enable
native processing or reuse native accounts. Processing defaults to disabled.
Flags accept `true` or `false`. Admission and reporter selection are boot settings.

| Setting | Default and purpose |
| --- | --- |
| `PREPROCESSING_ENABLED` | `false`; admit new processing when all dependencies are configured. Disablement preserves accepted jobs and results. |
| `RUNTIME_AGGREGATE_ACTIVITY` | `false`; `true` makes root the sole activity sender and is required for processing admission. |
| `RUNTIME_ACTIVITY_URL`, `RUNTIME_ACTIVITY_TOKEN` | Backend activity receiver and purpose credential. Aggregate processing can report `session_id:null`. |
| `PREPROCESSING_MODEL` | Required exact `proxy/<model-id>` preference, optionally followed by `#<variant>`. An unavailable preference leaves new admission unready unless an eligible fallback exists. A requested variant is retained exactly. |
| `PREPROCESSING_ALLOW_MODEL_FALLBACK` | `true`; permit backend-authorized fallback for new selections. `false` permits only the preferred model. |
| `PREPROCESSING_FALLBACK_MODELS` | `[]`; JSON array of up to 128 exact `proxy/<model-id>` references with an optional `#<variant>`. Each full reference is at most 166 characters; variants contain 1–64 letters, digits, dots, underscores, or hyphens and start with a letter or digit. Duplicate exact references are removed in order. Configured candidates precede remaining eligible models in canonical order. |
| `PREPROCESSING_MIN_CONTEXT_TOKENS`, `PREPROCESSING_MIN_OUTPUT_TOKENS` | Unset; optional additional operator floors, each a positive integer at most `2147483647`. Without these settings, the processor derives candidate-specific extraction bounds from backend-qualified image token costs, explicit extractor `requestBytes`, and the installed engine's default output budget. |
| `PREPROCESSING_MODEL_POLICY_REFRESH_MS` | `30000`; positive safe-integer interval after successful account discovery. Failed refreshes retry after 5–30 seconds with 20% jitter within those bounds. |
| `PREPROCESSING_MODEL_POLICY_MAX_AGE_MS` | `120000`; positive safe-integer maximum age of backend acceptance for new selections. Age uses the original successful fetch's monotonic timestamp and boot identity. |
| `PREPROCESSING_PROXY_TOKEN` | Private local extraction-channel credential for the root machine relay and dedicated engine owner. Not an upstream supplier key. The processing service does not receive it. |
| `PREPROCESSING_PROFILE_FILE` | Optional absolute path to a bounded, root-owned, credential-free profile. |
| `PREPROCESSING_ENGINE_CONFIG_FILE` | Optional trusted extraction config satisfying the processor validator. It can narrow the installed proxy declarations, but cannot add models, alter their metadata or modalities, or introduce another route or credential. |
| `PREPROCESSING_PORT` | `8765`; private loopback service port, distinct from other services. |
| `PREPROCESSING_MAX_INPUT_BYTES` | `268435456`; runtime source-admission ceiling. Configure processor profile limits separately. |
| `PREPROCESSING_MAX_ACTIVE_TICKETS` | `100`; active runtime ticket and reservation ceiling. |
| `PREPROCESSING_JSON_MAX_BYTES` | `16777216`; adapter metadata ceiling without truncation. |
| `PREPROCESSING_TRANSPORT_TIMEOUT_MS` | `5000` in the entrypoint; private request and idle-read deadline. |
| `PREPROCESSING_POLL_RUNNING_MS`, `PREPROCESSING_POLL_QUEUED_MS` | `2000`, `2000`; status observation intervals. Queued and running samples share the ten-second backend freshness window. |
| `PREPROCESSING_HELD_INPUT_WARN_BYTES` | `1073741824`; advisory input-storage warning. `0` disables it. |
| `PREPROCESSING_STORAGE_RESERVE_BYTES` | Optional advisory reserve override. `0` disables the warning. |
| `PREPROCESSING_STORAGE_INTERVAL_S` | `60`; root storage observation interval. |
| `PREPROCESSING_ACTIVITY_MAX_HOURS` | `6` in the entrypoint; processing keepalive age cap. `0` disables it. Expiry does not cancel work. |
| `RUNTIME_ACTIVITY_INTERVAL_S` | `60`; aggregate reporting interval. A change in the agent's state is reported within about 2 s regardless. |
| `RUNTIME_STORAGE_REPORT_INTERVAL_S` | `300`; workspace disk-usage report interval on the activity channel, including while idle. `0` disables these reports. |
| `PREPROCESSING_RESTART_MAX_ATTEMPTS`, `PREPROCESSING_RESTART_BACKOFF_S` | `5`, `1`; initial pair launch burst and exponential backoff. |
| `PREPROCESSING_RETRY_COOLDOWN_MS` | `300000`; positive safe-integer cooldown for continued supervised retries after the initial burst. The supervisor applies 20% jitter. |
| `PREPROCESSING_STARTUP_S` | `300`; engine-owner startup allowance, not an inference qualification. |
| `PREPROCESSING_SERVICE_SHUTDOWN_S`, `PREPROCESSING_OWNER_SHUTDOWN_S` | `180`, `30`; service-before-owner settlement within the total drain budget. |

The captured processor bundle defines profile defaults. An operator profile
overrides them. Resolved profiles must be qualified with the actual model proxy
and concurrent workloads. A catalog declaration alone does not prove supplier
image support.

Model selection requires fresh authenticated backend acceptance, backend-qualified
image support, and matching trusted installed declarations. Text-only declarations
remain text-only. Catalog presence and configured preferences do not grant access.
Variant references are passed unchanged. They require qualified backend reasoning
evidence and installed engine support for the exact variant. The runtime does not
add variant metadata, strip a requested variant, or enable a nondefault variant
merely because it appears in configuration. Unsupported variants remain subject to
the processor's eligibility checks.
The model evidence shared with the processor contains no credentials.

A failed refresh preserves the last successful snapshot and its original age.
Expiry blocks new selections. Previously committed jobs retain their exact model
and normal per-request backend admission. A fresh revocation can hold queued work.
Discovery refreshes do not restart the engine, rewrite jobs, or prevent scoped
cleanup. Safe ownership and context checks allow owner and service startup even
when no model is eligible.

Refresh intervals below 5000 milliseconds or at least as long as maximum age emit
advisory boot warnings. Explicit positive safe-integer settings are retained
without clamping. A longer maximum age does not bypass backend request admission.

Storage observations retain their original timestamp after restart. Freshness,
scan completeness, and measured workload headroom are independent. Storage
warnings neither impose quotas nor establish sufficient capacity.

Follow [document-processing enablement](docs/RUNTIME_FILES_DEPLOYMENT.md#document-processing-enablement)
before opening admission. Use [document processing](docs/DOCUMENT_PROCESSING.md)
for upload opt-out and explicit source selection.

In the managed profile, `PREPROCESSING_PROXY_TOKEN` is a
private local channel credential. The root machine gateway recognizes that channel,
forwards the current renewed `llm_proxy` token, and forces preprocessing attribution.
The processor's channel credential remains stable when upstream credentials rotate.
Static upstream extraction credentials are not a supported substitute for renewal.

For backend automatic imports, runtime-local disablement produces a retryable
`processing_unavailable` import error. Only a backend-authorized policy can skip
processing as disabled. Enablement resumes the same retained source and request.
Persisted `processing-disabled` skips do not resume automatically. Create a fresh
upload or workspace to process those sources.

## CI build inputs

| GitHub configuration | Name | Purpose |
| --- | --- | --- |
| Workflow job environment | `PREPROCESSING_BUNDLE_REPO` | Repository containing the reviewed processor release. |
| Workflow job environment | `PREPROCESSING_BUNDLE_TAG` | Release holding its immutable `source.tar` asset. |
| Workflow job environment | `PREPROCESSING_BUNDLE_DIGEST` | Expected lowercase SHA-256 of that archive. |
| Actions secret | `PREPROCESSING_BUNDLE_TOKEN` | Read-only download authority for the processor repository. |
| Actions secret | `GH_PAT` | Checkout authority for the repository and recursive submodules. |
| Actions secret | `FLY_API_TOKEN` | Organization-scoped authority for qualification resources and release publication. |
| Actions variable | `FLY_ORG_SLUG` | Fly organization override for the release workflow. |

The bundle repository, tag, and digest are pinned in `jobs.build.env` of
`.github/workflows/fly-deploy.yml` and `jobs.qualify.env` of
`.github/workflows/processor-image-check.yml`. Update both jobs together in a pull
request after publishing the asset. Actions variables with these names do not
override the checked-in pins.

For local builds, `PREPROCESSING_SOURCE_DIR` selects the source captured by
`scripts/build-docker.sh`. `PREPROCESSING_BUILD_CONTEXT` selects its output
directory and is required for Compose. `PREPROCESSING_BUNDLE_DIGEST` also supplies
the Docker build argument. The helper recaptures working-tree bytes; source Git
revision alone does not identify them.

The full image still requires this processor bundle when runtime extraction is
disabled. Use `scripts/build-docker.sh` to capture updated source and rebuild.

## Publish a qualified Fly release

Review the checked-in processor bundle pins. Configure an organization-scoped
`FLY_API_TOKEN`, and `FLY_ORG_SLUG` for the **Fly qualified native release** workflow.
The [bundle build contract](docs/RUNTIME_FILES_DEPLOYMENT.md#bundle-build-contract)
describes the named context and source digest. Run the serialized workflow:

```bash
gh workflow run fly-deploy.yml --ref main
```

Require a successful `native-release-<run>-<attempt>` artifact before accepting
publication. The workflow qualifies the exact image locally and on Fly before
creating the canonical release. Follow [Publish a qualified native-reader release](docs/NATIVE_READER_DEPLOYMENT.md)
for qualification failures and captured-resource cleanup. Direct canonical
`fly deploy` bypasses these checks.
