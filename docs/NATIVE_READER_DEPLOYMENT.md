# Publish a qualified native-reader release

## Install the fixed reader jails during the image build

Run the following install step as `root:root` in a Linux image build, with
`WORKDIR /opt/geocluster-runtime`. Install the locked Node dependencies and copy
the complete runtime source before this step. The production and overlay recipes
already perform these operations. Both recipes install the same checksum-pinned
PROJ grids before compiling the native workers and packaging their dependencies.

```bash
node lib/gis-grids/build.mjs
npm run build:native
chown -R root:root /opt/geocluster-runtime
chmod -R go-w /opt/geocluster-runtime
install -o root -g root -m 4755 lib/workbook-launcher/build/workbook-launcher ./workbook-launcher
install -o root -g root -m 0555 lib/workbook-launcher/build/workbook-policy.so ./workbook-policy.so
install -o root -g root -m 4755 lib/gis-launcher/build/gis-launcher ./gis-launcher
install -o root -g root -m 0555 lib/gis-launcher/build/gis-worker ./gis-worker
node lib/reader-jails/build.mjs
```

For the standalone workbook acceptance recipe, run
`node lib/reader-jails/build.mjs --workbook-only` after its launcher and policy
build. That recipe includes the shared `reader-jail.h` and `reader-seccomp.h`
headers. The packager accepts no other options and performs no downloads.
Use the existing production build workflow to retain the engine source identity,
preprocessing bundle digest, locked dependencies, and `RUNTIME_BUILD_SHA`.

The build requires `CAP_MKNOD` to create the workbook jail's `/dev/null` device.
A regular-file substitute is invalid.

Preserve root ownership and deny group/world writes on each jail's parent chain.
Do not mount volumes over the jails or replace their contents while workers run.
Runtime launchers require effective root privileges and `CAP_SYS_CHROOT` to enter
their fixed roots, then drop privileges before parsing. Preserve setuid launcher
installation, the monitor and worker identities, and the syscall policies.
Landlock support is not required. A denied chroot, invalid root, missing sentinel,
or readable sentinel makes the reader unavailable before native work is admitted.

## Verify locally with Docker Compose

Select a consolidated runtime base containing the engine, pinned dependencies,
and processor. The overlay rebuilds the current runtime and installed native
launchers without rebuilding unrelated dependencies:

```bash
export RUNTIME_BASE_IMAGE=geocluster-runtime:latest
export IDE_PROXY_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
docker compose -f docker-compose.native-qualification.yml up --build -d
docker compose -f docker-compose.native-qualification.yml exec -T native-runtime \
	gosu gc-files node /opt/geocluster-runtime/scripts/qualify-native-readers.mjs
docker compose -f docker-compose.native-qualification.yml exec -T native-runtime \
	node /opt/geocluster-runtime/scripts/qualify-workspace-files.mjs
```

Require both readers to report `confinement: "verified"` and the files command
to report `ok: true`. Compose publishes port 8300 on the Docker host's loopback
address. If your Docker daemon runs in another VM and host forwarding is unavailable,
use the `docker compose exec` commands above to verify the runtime. Ordinary
file requests require signed gate authentication. The files command performs
that exchange privately and tests the reported CSV and genuine XLS/XLSX bytes.

Run the negative profiles and installed admission checks against the same image:

```bash
node runtime/test/image/native-test.mjs --image geocluster-runtime:native-confinement-local
```

Stop the local runtime with `docker compose -f docker-compose.native-qualification.yml down`.
Its volume retains test fixtures. Add `--volumes` only to discard that local test
state. Local success does not establish Fly guest kernel support.

## Qualify the installed processor before publication

Use Node.js 22 or newer, Python 3, Docker, and a processor test-source checkout.
Supply the expected bundle SHA-256 from the independently verified build input.
Do not copy that expected value from the candidate image.

```bash
npm --prefix runtime run test:image:processor -- \
	--image "$CANDIDATE_DIGEST" \
	--expected-bundle-digest "$PREPROCESSING_BUNDLE_DIGEST" \
	--processor-source /absolute/path/to/reviewed-processor \
	--deadline-ms 600000 \
	--report /tmp/processor-image-report.json
```

Require `status: "succeeded"` and `cleanup: true` in the processor report.
Local tags resolve to an immutable Docker image ID before execution. The harness
starts the real entrypoint with temporary state, disabled document admission,
dummy credentials, and no external network. It requires authenticated literal
`ready: true` and `executionReady: true`, the independently expected bundle digest,
the installed engine's version and binary matching its build identity and source
recipe, and exactly one owner and service running under UID and GID 996.

To regenerate discovery from a backend checkout, add
`--backend-source /absolute/path/to/backend`. The generator uses that checkout's
`.venv/bin/python` when present, or Python 3 with Pillow installed.

Require all collected protocol tests to pass, with no skips. The test source must
include `tests/preprocessing/test_engine_http_real.py` with the completed text/image
service-ledger test parametrized over two distinct `candidate` values. Qualification
uses the candidate's installed processor and engine, not replacement packages.
The first overlay build needs package-index access; test execution has no external
network or paid inference.

The deadline accepts integer milliseconds from 1 to 1800000 and defaults to 300000.
It covers image resolution, startup, overlay building, and protocol execution.
Cleanup has a separate 30-second budget. Reports omit raw process diagnostics,
credentials, environment values, configuration, and engine descriptors.

For private release assets, stage matching external tests with authenticated `gh`:

```bash
export GH_TOKEN="$PREPROCESSING_BUNDLE_TOKEN"
python3 runtime/test/image/processor-ci-inputs.py \
	--output /tmp/preprocessing-bundle \
	--test-output /tmp/processor-tests
```

For this manual command, set `PREPROCESSING_BUNDLE_REPO`,
`PREPROCESSING_BUNDLE_TAG`, and `PREPROCESSING_BUNDLE_DIGEST` to the reviewed
values pinned in the workflow job environments. The downloader checks the asset
digest, resolves the tag to a commit, and verifies the archived production files
against the asset before staging only the real-protocol test source.
Use `--processor-source /tmp/processor-tests` with the harness.

Update both workflow job pins together in a pull request. After the pin change
reaches `main`, run **Nonpublishing installed image checks** manually on `main`.
Full image qualification runs only on trusted `main`
code. Relevant pull requests, including forks, run secret-free harness and workflow
security tests without private submodules. Configure `GH_PAT` for private submodules
and `PREPROCESSING_BUNDLE_TOKEN` for read-only processor contents and release-asset
access. Credentialed checkouts remove stored credentials before repository scripts
run. Manual dispatches on other refs skip image qualification. Successful local
checks establish installed packaging and tested protocol behavior; verify supplier
access and Fly behavior separately.

## Run the serialized workflow

1. Configure `FLY_API_TOKEN` with organization access to create disposable apps,
   machines, and volumes, and publish `geocluster-ai-ide`. An app-only deploy token
   cannot create the disposable app. Set `FLY_ORG_SLUG` if your organization differs
   from `kip-protocol-services-1`. Retain the existing preprocessing bundle inputs.
2. Push to `main`, or run **Fly qualified native release** with `workflow_dispatch`
   on `main`. Dispatches on other refs skip both credentialed jobs.
   Both paths use `deploy-group` with cancellation disabled. For slower placement,
   increase `qualification_timeout_minutes` from its default of 10. The input
   accepts integers from 1 to 60. Invalid values fail before image building.
3. Read the `native-release-<run>-<attempt>` artifact before accepting publication.
   Require `status: "succeeded"`, both cleanup results, and the recorded release
   image matching the candidate digest.

Every check and publication must use the same immutable
`registry.fly.io/geocluster-ai-ide@sha256:...` identity.
Read the separate `processor-image-<run>-<attempt>` artifact for processor evidence.

The Fly check uses a disposable app, private network, fresh project identity and
workspace volume, and the image's real entrypoint in managed headless mode.
A test-only loopback backend renews dummy purpose credentials and advertises an
empty version-2 model catalog. It refuses every inference request.
No public service, public IP, supplier key, or static model token is provisioned.
Sync, preprocessing, demo setup, and activity integrations are disabled;
both native readers are enabled.

The app receives a fresh random `IDE_PROXY_KEY`. Qualification checks
real signed gate authentication and the independently initialized daemon
without a backend database. It does not prove renewable backend runtime authority,
credential rotation, model access, or cloud storage integration.

The native command owns its 120-second watchdog. Require the root files command
to prove signed gate authentication, native provider confinement, and successful
CSV, XLS, and XLSX preparation and preview. Exit zero alone is insufficient;
missing or incorrect report evidence fails qualification. Both commands accept
no deployment-supplied paths. The executable acceptance criteria are in
[`scripts/fly-native-release.mjs`](../scripts/fly-native-release.mjs).

Require both readers and all four native providers to be available with verified
confinement. An unavailable reader blocks publication. Missing Landlock support
does not exempt an image from decoding genuine GIS, XLS, and XLSX fixtures.
Installed admission checks must also reject native work when chroot is denied
or a jail sentinel is missing or readable, while preserving basic file operations.

Timeout, nonzero exit, malformed or oversized JSON, and synthetic native results
fail the deployment. The overall qualification budget includes
creation, boot, both commands, and inspection. Cleanup has a separate bounded
120-second budget per cleanup attempt so an expired qualification can still delete
captured resources. The native watchdog stays fixed at 120 seconds; the workflow
input changes only the overall qualification budget.

The Fly qualification and publication job starts after image building and local
checks succeed. A release-step timeout still allows captured-ID cleanup and
evidence upload. Runner loss or forced workflow cancellation can require manual
cleanup.

## Inspect publication and partial failures

The script requires successful disposable cleanup before running:

```bash
flyctl deploy --image "$CANDIDATE_DIGEST" --app geocluster-ai-ide --ha=false
```

Before publication, the canonical app must have no machines. The script snapshots
machine, volume, and release IDs, then explicitly creates and records a workspace
volume. After deploy, it verifies the new machine's resolved image, mount, and
the volume's reciprocal machine attachment. It records a replacement volume only
when that new pair proves ownership. Old volumes are never deleted. If Fly deploy
attaches an old volume or creates unexplained resources, the run fails visibly.

The script verifies a new release against the original digest using registry
inspection. A competing newest release cannot substitute another image. Final
cleanup runs after successful or failed deploy and deletes only captured,
attributable IDs. The workflow retries captured-ID cleanup in an `always()` step.
Before deletion, cleanup verifies the qualification app ID and each machine's
captured instance and exact image. A changed identity refuses deletion. Cleanup
polls until machine destruction is confirmed, then waits for its volume to detach
before deleting that volume. Requests and waits share the 120-second cleanup budget.

Fly retains deleted volumes in inventories for up to 24 hours. Cleanup confirms
each owned volume's deletion by absence or `pending_destroy` or `destroyed` state.
The disposable-app empty-inventory check excludes only these confirmed owned
tombstones. Unknown volumes and live resources still block app deletion and promotion.

Release creation is permanent: cleanup failure after publication fails the job
but does not remove the release. `releaseState` distinguishes a verified created
release, an unverified result, an unknown result, and no observed new release.

The artifact retains source SHA, exact image, app and resource IDs, instance ID,
kernel and architecture evidence, daemon UID and syscall-policy fields, launcher
modes, native decode and denial results, and allowlisted fixture results. Missing
kernel configuration or LSM exposure remains explicit. Native failure diagnostics
retain structured confinement stages and numbers, including `chroot-installation`.
Raw API errors, machine configs,
environments, keys, tokens, command stderr, and capture manifests are excluded.

If a create response is lost or lacks an ID, inspect `uncertain` and the captured
IDs. Do not retry creation, delete by resource name, or sweep an app. Resolve the
missing ownership evidence privately. To retry cleanup of known IDs with the
original saved report:

```bash
FLY_RELEASE_REPORT=/path/to/fly-native-release-report.json \
  node scripts/fly-native-release.mjs --cleanup
```

The cleanup command does not promote an image or convert a failed run to success.
An ambiguous resource remains a visible unresolved operation.

## Verify workspace restoration separately

Canonical publication retains the backend's latest-release selection policy and
its five-minute image cache. Use the workflow for manual publication from a source
ref. The workflow builds a new image and does not accept an existing digest.
Direct `fly deploy` bypasses qualification.

To roll back to an existing digest, install `flyctl`, Node.js 22 or newer, Docker,
and Buildx. Set the organization-scoped `FLY_API_TOKEN` and authenticate Docker
with `flyctl auth docker`. Use the release script to requalify and publish:

```bash
export CANDIDATE_DIGEST='registry.fly.io/geocluster-ai-ide@sha256:<recorded-digest>'
export FLY_ORG_SLUG='kip-protocol-services-1'
export FLY_RELEASE_REPORT='/tmp/fly-native-rollback-report.json'
node runtime/test/image/native-test.mjs --image "$CANDIDATE_DIGEST" && \
	npm --prefix runtime run test:image:processor -- \
		--image "$CANDIDATE_DIGEST" \
		--expected-bundle-digest "$PREPROCESSING_BUNDLE_DIGEST" \
		--processor-source /absolute/path/to/matching-processor-tests \
		--deadline-ms 600000 --report /tmp/processor-image-report.json && \
	node scripts/fly-native-release.mjs
```

Use the original recorded digest instead of the placeholder. Require successful
qualification, publication, and captured-resource cleanup in the saved report.
Serialize this operation with other publications to the canonical app.

After publication, allow the cache to expire or restart the development backend.
Verify its next selected image resolves to the recorded digest. Upgrade selected
existing workspaces through their backend controller: stop and drain, confirm
identity and stopped state, preserve the full machine configuration and runtime
generation, update the image with `skip_launch=true`, and resume through the
controller. Run fresh provider and fixture checks on the retained and newly
created workspaces. The release workflow does not update existing project apps.

Preserve filesystem jails and all decode and denial probes. An unsupported
placement must report unavailable providers while retaining safe basic file
operations, and cannot qualify for publication. A passing disposable placement
does not freeze future Fly kernels. Keep the first passing digest and qualification
configuration as the rollback baseline; requalify that digest before rollback.

Official interfaces: [Fly Machines API](https://fly.io/docs/machines/api/),
[exec](https://docs.fly.io/api/machines/machines/execute-command),
[deploy](https://fly.io/docs/flyctl/deploy/), and
[registry digest inspection](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/).
