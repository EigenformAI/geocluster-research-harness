# Install and launch with custom settings

Use this guide when you need explicit build or launch settings. For the guided
path, run `./scripts/setup.sh` from the checkout instead.

## Build the runtime image

Use a Linux x64 Docker environment with Buildx, Bash, Git, and Python 3. Run these
commands from the harness checkout. Builds require the document processor source
even when document extraction is disabled.

1. Fetch the geology tools at the revision recorded by this checkout:

	```sh
	git submodule update --init --recursive
	```

2. Clone the pinned processor into a new sibling folder:

	```sh
	git clone --depth 1 --branch preprocessing-ee7fcb6 \
		https://github.com/EigenformAI/geocluster-data-preprocessing-service.git \
		../geocluster-processor-release
	```

3. Build the image:

	```sh
	PREPROCESSING_SOURCE_DIR="$(cd ../geocluster-processor-release && pwd)" \
		bash scripts/build-docker.sh
	```

The release build checks the processor commit and generated bundle SHA-256
against `scripts/preprocessing-release.json`. A different revision, dirty tree,
or different bundle stops the build. Keep modified checkouts intact. Choose a
fresh checkout when you update the release.

For development with local processor changes, use an explicit development build:

```sh
PREPROCESSING_BUILD_MODE=development \
	PREPROCESSING_SOURCE_DIR="$(cd ../geocluster-processor-release && pwd)" \
	IMAGE_TAG=local bash scripts/build-docker.sh
```

This produces `geocluster-runtime:local` without claiming verified release source.

## Launch a Docker-managed workspace

Choose a volume and project explicitly. The launcher creates a missing project.
It does not read or change the settings saved by guided setup.

```sh
./scripts/run-runtime-tui.sh --image geocluster-runtime:latest \
	--workspace-volume geocluster-native-workspace --project default
```

To require an existing project instead, append `--require-existing-project`.
The runtime checks the project while holding its workspace lock.

Run `/connect` inside OpenCode to connect your model provider. Run `/models` to
select a model. No GeoCluster account, backend token, or `.env` file is needed.
Model requests and included project content go to the provider you connect.

## Use a dedicated host folder

Use local rootful Linux Docker. Choose a dedicated workspace, not your home,
an existing data folder, or a source tree. The workspace includes private
provider state beside its projects. Do not change ownership of an existing
workspace to make startup pass.

Keep this folder outside the checkout so private container-owned files do not
interfere with later builds. For a manually prepared root, run the administrator
command only when the selected workspace does not already exist:

```sh
workspace="$HOME/.local/share/geocluster/workspaces/manual"
mkdir -p "$(dirname "$workspace")"
sudo install -d -o root -g root -m 0755 "$workspace"
./scripts/run-runtime-tui.sh --image geocluster-runtime:latest \
	--workspace-root "$workspace" --project default
```

The runtime owns project directories as UID 999, with the file service using UID
998 and shared GID 999. Host editing can require administrator access. The
guided path can create a protected workspace under your account's
`.local/share/geocluster/workspaces/` directory on qualified Docker connections.
It does not promise host editing access.

For Desktop, rootless, remote, or custom Docker connections, prefer Docker-managed
storage. A bind path refers to the Docker host, not necessarily your computer.

## Transfer project files

Run `/exit` inside OpenCode first. All transfers share the runtime's workspace
lock, including transfers between different projects in one workspace. Stop
host editors before exporting. The copy is not a filesystem snapshot.

For a saved setup, use:

```sh
./scripts/project-files.sh import
./scripts/project-files.sh export
```

Without a saved setup, provide the storage and project explicitly:

```sh
./scripts/project-files.sh import runtime/demo-bundles/wattle-creek/v1 \
	--into wattle-creek --image geocluster-runtime:latest \
	--workspace-volume geocluster-native-workspace --project default
./scripts/project-files.sh export wattle-creek ./wattle-creek-copy \
	--image geocluster-runtime:latest \
	--workspace-volume geocluster-native-workspace --project default
```

For a prepared local host workspace, replace `--workspace-volume NAME` with
`--workspace-root /absolute/path/to/workspace`. Do not combine saved settings
with explicit overrides. Imports create one new child folder. Exports require a
new client destination. Neither operation merges or replaces existing content.
The transfer command rejects links, hardlinks, special objects, nested mounts,
and private runtime paths rather than silently skipping them.

Copies preserve file bytes and ordinary executable bits. They drop source ACLs
and special permission bits. Private source files require permission to grant
the runtime accounts access to the copied files. Unattended imports use
`--allow-restricted` for that explicit approval. Original files stay unchanged.

## Enable optional document extraction

The saved launcher deliberately accepts no overrides. For extraction, use the
explicit launcher with your workspace options and
`--processing-model 'provider/model[#variant]'`. Follow
[native document processing](NATIVE_DOCUMENT_PROCESSING.md) for model selection,
job tracking, and recovery. Extraction is separate from conversation model
selection and remains disabled in ordinary guided setup.

## Update an image

1. Exit OpenCode with `/exit`.
2. Pull the harness source.
3. Update its submodules with `git submodule update --init --recursive`.
4. Check `scripts/preprocessing-release.json` and choose a clean processor
   checkout at its `sourceRevision`.
5. Rebuild with `scripts/build-docker.sh` and the selected source directory.
6. Run `./scripts/setup.sh` to select the new image for saved launches, or use
   your explicit launch command.

Saved launches pin an image ID, not a mutable tag. Rebuilding a tag does not
silently change the image used by an existing saved setup. Keep the workspace
to retain files, conversations, and provider connections. Protect whole-workspace
backups like credentials.
