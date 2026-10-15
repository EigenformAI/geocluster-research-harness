# Build and deploy the runtime

Run commands from the repository root. Use the full image for deployments that
need the production Unix identities, protected captures, or installed readers.
Starting a Node service on the host does not provision those boundaries.

## Choose a deployment profile

The supported combinations are native with the TUI and managed with the headless
gateway. Start local provider connections with `scripts/run-runtime-tui.sh`.
It selects `RUNTIME_PROFILE=native` and `tui`, starts local file and MCP services,
then runs the pinned OpenCode engine with `--standalone`. Run `/connect`, then
`/models`. It needs no GeoCluster proxy or project model token, imports no host
credentials automatically, and publishes no host ports. TUI exit stops its owned
local services.

Managed deployments explicitly set `RUNTIME_PROFILE=managed` and run `headless`.
An omitted entrypoint command retains managed headless startup. A conflicting
explicit profile or frontend fails before services start. Do not infer a profile
from token presence or authentication bypass. The container entrypoint requires
root to provision identities and protected state; host root is not required beyond
permission to run Docker.

Native startup has no public gate health endpoint. Do not apply the managed
port-3000 health check to native TUI containers. Provider authentication requiring
a loopback callback may need operator configuration; the helper does not publish
ports to make every OAuth method work.

## Build the full image

Initialize the MCP submodule and select the processor source:

```sh
git submodule update --init --recursive
PREPROCESSING_SOURCE_DIR=/absolute/path/to/processor-source \
	IMAGE_TAG=local bash scripts/build-docker.sh
```

The helper creates `geocluster-runtime:local`. It requires Docker Buildx and
Python 3. The production image targets Linux x64. An
[engine-only build](../opencode/engine/README.md) needs no processor bundle.

### Bundle build contract

Full builds require the `preprocessing_bundle` named context and its expected
`PREPROCESSING_BUNDLE_DIGEST`, even with document processing disabled.

The processor source must include `pyproject.toml`, `uv.lock`,
`deployment/standalone/supervise.py`, and the `preprocessing` Python package.
The capture script adds the pinned build requirements. It captures working-tree
bytes, including uncommitted changes. Review the selected bytes rather than
assuming a Git revision identifies them.

For Compose, create and export the bundle inputs:

```sh
export PREPROCESSING_SOURCE_DIR=/absolute/path/to/processor-source
export PREPROCESSING_BUILD_CONTEXT="$(mktemp -d)"
python3 scripts/preprocessing-bundle.py \
	--source "$PREPROCESSING_SOURCE_DIR" \
	--output "$PREPROCESSING_BUILD_CONTEXT"
export PREPROCESSING_BUNDLE_DIGEST="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["digest"])' "$PREPROCESSING_BUILD_CONTEXT/identity.json")"
mkdir -p local-workspace logs
docker compose up --build
```

Preserve `identity.json` with release evidence. Release inputs must be immutable
and reviewed. A newly computed checksum proves byte identity, not that the bytes
are the intended release.

### CI release inputs

Publish a `source.tar` with the same processor package, lock, supervisor, and build
requirements. Pin its repository, tag, and digest in the credentialed jobs of both
`.github/workflows/fly-deploy.yml` and `.github/workflows/processor-image-check.yml`.
The workflows use these checked-in pins instead of Actions bundle variables.
Configure the download credential in
[runtime configuration](../ENVIRONMENT_VARIABLES.md#ci-build-inputs).
The downloader verifies the archive digest and production files against the
tagged commit before building.

For qualified Fly publication, use the
[native-reader release guide](NATIVE_READER_DEPLOYMENT.md). Its exact-image
qualification and cleanup requirements also apply to manual publication and
rollback. Image publication does not enable document processing or qualify a
live model endpoint.

## Test the installed image

Run the offline image checks:

```sh
IMAGE_TAG=local bash scripts/test-docker.sh
docker run --rm --network=none --memory=2g --memory-swap=2g \
	--entrypoint npm --workdir /opt/geocluster-runtime \
	--mount type=bind,src="$PWD/runtime/test",dst=/opt/geocluster-runtime/test,readonly \
	geocluster-runtime:local run test:voxels
```

Check the installed workbook provider before relying on workbook voxel inputs:

```sh
docker run --rm --network=none --memory=2g --memory-swap=2g --entrypoint node \
	--mount type=bind,src="$PWD/runtime/test",dst=/opt/geocluster-runtime/test,readonly \
	geocluster-runtime:local \
	/opt/geocluster-runtime/test/voxel-image-probe.mjs --daemon-uid
```

An available provider must pass the known-answer assertions. An unavailable
provider reports its reason; it does not establish workbook support. Synthetic
test providers do not qualify installed confinement.

Native builds require Linux, matching Node development headers, C/C++ compilers,
`pkg-config`, and GDAL, json-c, PROJ, and OpenSSL development libraries. With
runtime dependencies installed, build all native artifacts:

```sh
npm --prefix runtime run build:native
```

The build writes ordinary host artifacts, not host setuid installations.
Deployment also requires usable `openat2` and `/proc/self/fd` for the trusted file
service, installed root-owned setuid launchers, and image-built native reader
jails. The launchers require `CAP_SYS_CHROOT` before dropping worker privileges.
Native workers retain seccomp restrictions and have no workspace or procfs in
their jails. Landlock is not required. A failed jail or denial probe leaves the
affected provider unavailable. Compilation success cannot override that result.

The native reader supports stored workbook values. It does not calculate
formulas, execute macros, or retrieve external data. Cached formula values can
be stale or absent. Worksheet dimensions are coordinate bounds, not proof of
populated rows. Measure memory with representative workbooks and concurrent chat;
tiny fixtures do not establish whole-machine capacity.

## Test authenticated access

Copy `.env.security-test.example` to `.env.security-test` and supply your project
key, origins, model proxy, and renewable machine settings. Static project model
tokens alone are unsupported. Export the bundle inputs above before
starting Security Compose:

```sh
docker compose -f docker-compose.security-test.yml up --build
curl -fsS http://localhost:3010/readyz
```

The container's `env_file` does not supply Compose build interpolation variables.
Exchange a backend-issued project token before using authenticated routes. Follow
the [client connection guide](RUNTIME_API.md#authenticate-to-the-project).

Security Compose uses a privileged container to test `/proc` hardening. It is a
local test setup, not a production container policy. Docker exec defaults to
root in this image. Test agent filesystem access as UID 999 rather than treating
a root shell's access as evidence of agent permissions.

## Configure identities and retained storage

For managed headless deployments, publish only the access gate on port 3000.
Keep gateway, file, MCP, credential renewal, and preprocessing listeners private.
Authentication keys and control
credentials belong to root; file and extraction credentials must not enter agent
or browser environments.

Use the image's separate identities: agent UID 999, file daemon UID 998, reader
UID 997, and preprocessing UID 996. Preserve root ownership and non-writable
ancestors for installed runtime code, configuration, and launchers. A runtime
flag cannot substitute for those checks.

Managed model access requires root-held renewable machine credentials and the
fixed-destination local relay. The engine receives only the relay placeholder,
not upstream purpose authority. Supplier keys remain in the application backend.
Static purpose-token setup is not a supported isolated managed deployment.
Managed engine configuration, plugin roots, HOME, and XDG config remain
root-controlled. Project configuration discovery is disabled, and native config
and credential state must not be merged into the managed engine.

Native configuration follows OpenCode's normal user and project discovery.
Keep writable user provider config separate from bundled geology configuration.
Project plugins and configuration can execute as the engine identity. Trust them
before opening a project. Native state under
`/workspace/.runtime/native/opencode` has mode `0700` and is excluded from project
file APIs, MCP workspace access, sync, and automatic diagnostics. These
permissions do not isolate credentials from the engine identity's shell tools.
Native local use is not a credential sandbox.

Mount a retained filesystem at `/workspace`. Preserve the entire root, including
private `.runtime` state and the project directory, for same-profile recovery.
Whole-volume backups can contain native provider credentials and refresh tokens;
protect them like secrets. Copying only project data does not preserve sessions,
private captures, journals, or processing history.

Both profiles acquire the same exclusive retained-volume lifecycle lock before
mutating workspace state. A second owner fails rather than sharing sockets or
private state. A root-controlled profile marker also rejects sequential reuse
by another profile. Do not relabel or recursively re-own another profile's state.

To change profiles, initialize a fresh retained volume with the target profile.
Copy only ordinary files and saved results from `/workspace/<PROJECT_ID>/` into
the new volume's project directory. Never copy the enclosing `/workspace` volume
root or private `.runtime` and `.ide-state` directories. This transfer preserves
project data, not sessions or credentials.

Private file state and project storage must have compatible filesystem semantics.
The dev launcher accepts `RUNTIME_DEV_VOLUME_ROOT` for a single retained root
containing `<PROJECT_ID>/`. Its nested project-bind layout disables deletion
because protected trash cannot be assumed rename-compatible across mounts.

To use `scripts/run-runtime-dev.sh`, explicitly set `RUNTIME_DEV_IMAGE`,
`RUNTIME_DEV_WORKSPACE`, `RUNTIME_DEV_STATE_DIR`, `RUNTIME_DEV_PROJECT_ID`,
`RUNTIME_DEV_PROXY_URL`, and `RUNTIME_DEV_ENV_FILE`. The managed dev env file is a
trusted shell input for the root-held machine relay configuration, not a native
provider setup. The launcher starts an unauthenticated Docker runtime; restrict
who can reach its port. Use `scripts/run-runtime-tui.sh` for local native access.

The Wattle Creek v1 bundle is frozen, hash-pinned provenance. Edit the generator
and publish a new bundle version for content changes. Its distributed README,
example report, and CC0 license are data assets, not maintenance notes.

## Configure remote persistence

Use `FILES_SYNC_ADAPTER=true`, both machine file endpoints, and renewable machine
credentials for the managed backend adapter. This excludes the general rclone
workspace synchronization path. Dataset hydration is a separate integration.

Read persistence outcomes separately from local publication. A committed upload,
retained volume, or completed local checkpoint does not prove remote durability.
Keep unresolved sources and operation state until the backend acknowledges them
or an operator explicitly discards them.

The production writer registry can report unknown activity. Existing-address
remote replacement then waits. The explicit `applyNow` action can bypass that
advisory writer check; `discardLocal` separately authorizes changed local bytes.
Displaced bytes remain subject to recovery retention.

## Replace a workspace or stop a machine

For relayed traffic, send both `X-GC-Workspace-ID` and `X-GC-Workspace-Epoch` from
the current file-service identity. They narrow access; they do not authorize a
project. Reconnect on `workspace_changed` instead of repeating a stale request.

Before replacing storage, close admission, settle accepted work, and restart the
file service and ACP gateway together. Live disk replacement beneath running
services does not provide atomic workspace fencing. Closing a stale socket does
not cancel a previously accepted turn.

Request SIGTERM and a stop grace compatible with `RUNTIME_DRAIN_TIMEOUT_S`.
The image default is 240 seconds. Configure the actual machine provisioner;
repository `fly.toml` does not configure independently created machines.
Disable proxy autostop when backend activity owns the stop policy. A lack of
browser traffic does not mean background work is idle.

Keep the preprocessing service alive long enough to settle before stopping its
engine. The total drain allowance includes cancellation and checkpoints; it is
not a promise to finish extraction. Retained incomplete outcomes require recovery.
A local publication fence does not authorize volume destruction. See the
[sample initialization lifecycle requirements](OWNED_DEMO_LIFECYCLE_HANDOFF.md)
for backend deletion ordering.

### Private control routes

Keep `/internal/*` inaccessible through the public gate. Root control credentials
are distinct from project cookies and the gate secret. Private storage
acknowledgements establish recorded observations, not storage freshness or
remote persistence. Private drain acknowledgements must be interpreted together
with their pending and indeterminate outcomes.

Do not expose pair shutdown, ownership reconciliation, or retention release as
browser operations.

## Document-processing enablement

Use the managed headless profile and start with `PREPROCESSING_ENABLED=false`.
Configure the pair's explicit backend-declared image-capable model, managed proxy
URL, private extraction-channel credential, root machine relay, and root aggregate
activity reporter before opening admission. Native TUI startup leaves the pair
unconfigured and does not borrow the native connection database. Keep processor
UID 996 separate from conversation UID 999 and preserve its clean environment.

Managed discovery accepts exactly `/account` schema version 2. It supplies model
capabilities, limits, variants, eligibility, and a nullable default. There is no
runtime-wide model-name list or local plan fallback. Installed engine declarations
stay immutable until an explicit drained container restart. New or changed
declarations require that restart, not an image rebuild. Eligibility refresh does
not reload installed declarations. Stale retained metadata does not grant access;
the backend admits every request. A null default or cold discovery outage leaves
model sessions unavailable while independent file services can remain usable.

Before enabling processing for a project:

1. Record the reviewed bundle, runtime image, selected model, and profile identity.
2. Verify an actual image request through the dedicated engine and correct project
   usage attribution. The processor bundle must implement managed-usage refusal
   handling; relay credentials alone cannot replace job-aware handling.
3. Verify that root is the sole activity sender and that the backend accepts
   `prompt_running` with `session_id:null`.
4. Exercise CSV, workbook, native PDF, and scanned PDF processing, including upload
   opt-out, manual processing, partial results, and product downloads.
5. Exercise restarts, cancellation, browser closure, and forced short shutdown.
   Check retained source identity and unresolved settlement after recovery.
6. Measure whole-machine memory, CPU, retained disk growth, and cleanup during
   concurrent chat and extraction. Set capacity from those measurements.

Disabling admission preserves accepted work. Keep the pair and aggregate reporter
configured until that work settles or is explicitly interrupted. Storage warnings
are advisory, and processing keepalive expiry does not establish completion.

Close WebSockets, EventSources, and health polling when intentionally stopping a
workspace. Reconnecting requests can autostart a stopped machine.
