# GeoCluster Research Harness

GeoCluster Research Harness combines a geology research agent and geoscience
analysis tools in one Docker image. Use it to work with assay tables, drillhole
data, spatial surveys, and technical reports.

The harness uses [OpenCode](https://opencode.ai) and
[geocluster-mcp](https://github.com/EigenformAI/geocluster-mcp). You interact through
the OpenCode terminal user interface (TUI) with your own model provider. Input
files and saved results stay in a project workspace you control. Model requests
can include your data. See [Data privacy](#data-privacy).

## What you can do

Ask the agent to:

- Inspect and clean assay tables, check missing values, and compare drillhole
  inputs while preserving below-detection values.
- Cluster geochemical data, rank anomalies, and save tables and plots for review.
- Summarize technical reports, including NI 43-101 reports, and cite PDF pages.
- Turn findings into a brief with PDF, Word, PowerPoint, and Excel files. See
  [Share results](#share-results).

To inspect the tool calls and scripts behind an answer,
[read what each specialist did](#read-what-each-specialist-did).

The geology prompts require source citations for data-derived claims and separate
measurements from interpretation. These are agent instructions, not a guarantee
of correctness. Review the cited evidence before using a result.

## Before you start

You need:

- Docker running, with Buildx installed.
- Bash, Git, Python 3, and an interactive terminal.
- A provider account or API key supported by OpenCode. Connect it inside the TUI.
- A checkout of the
  [document processor](https://github.com/EigenformAI/geocluster-data-preprocessing-service).
  The image build requires it even if you do not use document processing.

The container targets Linux x64. You do not need to install OpenCode on your host.

## Build the image

1. Clone this repository. Use Git, not GitHub's Download ZIP option: a ZIP does
   not include the `geocluster-mcp` submodule that the build needs.

	```sh
	git clone https://github.com/EigenformAI/geocluster-research-harness.git
	```

2. Clone the pinned document processor prerelease.

	```sh
	git clone --depth 1 --branch preprocessing-ee7fcb6 \
		https://github.com/EigenformAI/geocluster-data-preprocessing-service.git
	```

3. Change into the harness checkout. Run every later command from here.

	```sh
	cd geocluster-research-harness
	```

4. Fetch the `geocluster-mcp` submodule. It holds the geology tools that the
   agents call.

	```sh
	git submodule update --init --recursive
	```

5. Build the image. `PREPROCESSING_SOURCE_DIR` points the build at the processor
   checkout from step 2. The image is named `geocluster-runtime:latest`.

	```sh
	PREPROCESSING_SOURCE_DIR="$(cd ../geocluster-data-preprocessing-service && pwd)" \
		bash scripts/build-docker.sh
	```

   The build verifies the processor commit and bundle SHA-256 against
   `scripts/preprocessing-release.json`. A different commit, uncommitted changes,
   or a bundle mismatch stops the build before Docker starts. This check verifies
   the source, not extraction quality. The build does not publish the image.

### Build with local processor changes

To build with uncommitted processor changes, run this command instead of step 5:

```sh
PREPROCESSING_BUILD_MODE=development \
	PREPROCESSING_SOURCE_DIR="$(cd ../geocluster-data-preprocessing-service && pwd)" \
	IMAGE_TAG=local bash scripts/build-docker.sh
```

Development mode includes uncommitted processor changes and records the source
as development, not a verified release. Use `geocluster-runtime:local` in place of
`geocluster-runtime:latest` in the commands below.

## Add a project folder

Put your data in the project folder at `/workspace/<PROJECT_ID>/` inside the
container. The launcher mounts the workspace, not your home directory or other
unrelated host folders. This is not a sandbox that confines agent code to the
project folder. See [Protect your workspace](#protect-your-workspace).

Copy complete data folders to preserve linked files. For example, a shapefile
needs its `.shx`, `.dbf`, and `.prj` files, and drillhole assays need collars and
surveys for spatial analysis. Name a folder in your question to have the agent
inspect its files.

The steps below copy `runtime/demo-bundles/wattle-creek/v1`, a synthetic sample
of surface assays, drillhole collars, and drillhole assays that ships with this
repository. To use your own data, replace that path with your folder.

Choose a workspace setup:

- For local rootful Docker on Linux, [use a bind mount](#use-a-bind-mount-on-rootful-linux)
  to access project files directly on your host.
- For Docker Desktop or rootless Docker, [use a Docker volume](#use-a-docker-volume)
  and copy files in and out with a helper container.

### Use a bind mount on rootful Linux

These steps bind-mount `native-workspace/` from this checkout. Git and the image
build ignore that folder.

1. Create a root-owned workspace folder. Use a dedicated folder, not your home
   directory or an existing project. The runtime stores provider credentials and
   other private state beside the project in this folder.

	```sh
	sudo install -d -o root -g root -m 0755 native-workspace
	```

2. Create the project folder, owned by you. `default` is the project ID.

	```sh
	sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 native-workspace/default
	```

3. Copy the data folder into the project.

	```sh
	cp -r runtime/demo-bundles/wattle-creek/v1 native-workspace/default/wattle-creek
	```

4. Make the copy readable by the runtime. The agent runs as user ID (UID) 999 and
   the file service as UID 998. `a+rX` grants read access to everyone and directory
   traversal. It also grants execute access to files that are already executable.

	```sh
	chmod -R a+rX native-workspace/default/wattle-creek
	```

5. Start the TUI with this workspace. `--workspace-root` mounts the folder at
   `/workspace`, and `--project` selects the project folder inside it.

	```sh
	./scripts/run-runtime-tui.sh --image geocluster-runtime:latest \
		--workspace-root "$PWD/native-workspace" --project default
	```

On the first start, the runtime takes ownership of `native-workspace/default`
(UID 999). The files you copied keep their owner. You can still read and copy
results without `sudo`, but changing agent-owned files may require it.
To add another folder later, exit the TUI first:

1. Copy the folder with `sudo`.

	```sh
	sudo cp -r /absolute/path/to/more-data native-workspace/default/more-data
	```

2. Make it readable by the runtime.

	```sh
	sudo chmod -R a+rX native-workspace/default/more-data
	```

3. Restart with the same launch command.

### Use a Docker volume

Without a workspace option, the launcher uses the Docker volume
`geocluster-native-workspace` and the project `default`. A short-lived helper
container copies files into the volume. Exit the TUI before you start.

For remote Docker, the helper's bind paths and user IDs refer to the Docker host,
not your client machine. Run the copy commands on that host or transfer your files
there first.

1. Check that no container uses the volume. The command prints nothing when the
   volume is free.

	```sh
	docker ps -q --filter volume=geocluster-native-workspace
	```

2. Copy the data folder into the volume. The helper mounts the volume at
   `/workspace` and your folder read-only at `/import`. It creates the project
   folder if needed, copies the data, and makes the copy readable by the
   runtime. Pick a destination name that does not exist yet: `cp -r` nests a
   folder inside an existing one.

	```sh
	docker run --rm --entrypoint /bin/sh \
		--mount type=volume,src=geocluster-native-workspace,dst=/workspace \
		--mount type=bind,src="$PWD/runtime/demo-bundles/wattle-creek/v1",dst=/import,readonly \
		geocluster-runtime:latest \
		-c 'mkdir -p /workspace/default && cp -r /import /workspace/default/wattle-creek && chmod -R a+rX /workspace/default/wattle-creek'
	```

   Change only your project folder. The runtime requires `/workspace` and
   `/workspace/.runtime` to be root-owned and not writable by other users.
   It also checks ownership and permissions on its lifecycle lock and profile
   marker. Do not change those files.

3. Start the TUI.

	```sh
	./scripts/run-runtime-tui.sh --image geocluster-runtime:latest
	```

## Ask about the folder

1. Run `/connect` in the TUI to connect your provider. No GeoCluster account or
   token is needed. The connection persists in this workspace.

2. Run `/models` to select a model. Startup does not perform paid inference.

3. Ask a question that names the folder or the files in it:

   > Check wattle-creek/drilling/assays.csv against wattle-creek/drilling/collars.csv
   > by hole_id. Save unmatched intervals and a QA report. Preserve reported values
   > and do not invent collars.

   The answer should report hole `WC141`, which has assay intervals but no
   collar.

4. Find the saved files in the paths that the answer lists. Each conversation
   saves its outputs under `runs/<session-id>/results/` in the project folder.
   With the bind mount, that is
   `native-workspace/default/runs/<session-id>/results/` on your host. If the TUI
   asks for permission to write a file, approve or deny the request there.

Try this question with the sample data:

> Profile every CSV in wattle-creek/. Give one table of columns, units, and
> missing values per file.

For your own data, replace the filenames in these examples:

> Summarize the sampling methods in report.pdf. Cite the PDF pages. Distinguish
> reported findings from your interpretation.

> Cluster the selected geochemical columns in assays.csv. Explain the method and
> scaling choice, save the assignments, and leave the input unchanged.

## Read what each specialist did

The Geology agent delegates dataset work to an orchestrator. The orchestrator
assigns tasks to DataOps, Transform, Analytics, GeoViz, and Voxel. It calls Extended
when a task needs additional capabilities, such as package installation.
Each specialist works in its own session. Review those sessions before you share
a result.

1. Click a line such as `Orchestrator Subagent — Check drilling inputs` in the
   transcript. You can also press `↓` with the cursor at the end of the prompt to
   open the **Subagents** picker.

2. Press `ctrl+a` to include inactive sessions. By default, the picker lists only
   active sessions and shows `No active subagents` after a run.

3. Select a session and press `Enter`. Specialists, including Extended, appear
   under the orchestrator in the session tree.

4. Press `Esc` to go back up one level.

The picker returns to active sessions each time you open another session, so
press `ctrl+a` again there. After you restart the TUI, the tree loads one level at
a time: open the orchestrator to see its specialists.

## Share results

Ask for a shareable brief when you need something to email or present:

> Make a shareable brief of the drilling QA results for my manager.

GeoViz uses the findings already in the conversation. Its instructions call for
these files under `runs/<session-id>/results/share/`:

- A PDF brief and an editable Word copy.
- A PowerPoint deck with a summary, findings, methods, and caveats.
- An Excel workbook with one sheet per key table.
- A `figures/` folder with PNG and SVG copies of each figure.
- `brief.md`, the source for the PDF, Word, and PowerPoint files.

The instructions also require source footnotes, axis units, colour-blind-safe
palettes, image alt text, and speaker notes for findings. These are agent
instructions, not checks enforced on every export. Confirm that the requested
files exist, and review their content and layout before you send them.

Replace `<session-id>` below with the folder name from the answer.
For a bind mount, copy the pack to a new destination on your host:

```sh
cp -r "native-workspace/default/runs/<session-id>/results/share" ./wattle-creek-brief
```

To copy the pack out of the Docker volume:

1. Create the destination folder on your host.

	```sh
	mkdir -p wattle-creek-brief
	```

2. Copy the pack with a helper container that runs as your user and mounts the
   volume read-only.

	```sh
	docker run --rm --entrypoint /bin/sh --user "$(id -u):$(id -g)" \
		--mount type=volume,src=geocluster-native-workspace,dst=/workspace,readonly \
		--mount type=bind,src="$PWD/wattle-creek-brief",dst=/export \
		geocluster-runtime:latest \
		-c 'cp -r "/workspace/default/runs/<session-id>/results/share/." /export/'
	```

## Configure the runtime

Use ordinary OpenCode user configuration for provider settings and model defaults.
Host OpenCode accounts and credentials are not imported automatically.
Some provider login methods show a URL or device code. Native startup publishes
no host ports, so login methods that need a container loopback callback may
require extra configuration.

Run `./scripts/run-runtime-tui.sh --help` for workspace and provider-environment
options. `scripts/tui.sh` accepts the same options.

To enable document extraction, restart with
`--processing-model 'provider/model[#variant]'` and your usual workspace options.
Replace the model reference with an available model. Processing reuses your native
OpenCode connections but selects its model separately from the conversation.
Ordinary startup leaves processing disabled. See
[native document processing](docs/NATIVE_DOCUMENT_PROCESSING.md) for setup,
job tracking, and recovery.

## Protect your workspace

Keep the workspace to preserve files, conversation history, and provider
connections. Native engine state is outside the project directory with mode
`0700`. Whole-workspace backups can contain provider credentials and refresh
tokens. Protect those backups like credentials.

Open only projects whose configuration and plugins you trust. Both can execute
code as the engine's Unix user. Shell tools running as that user can access its
credentials. Agent tool permissions guide delegation. They do not sandbox code
executed by an agent. Native mode is not a credential sandbox. See the
[security limits](docs/DESIGN_INVARIANTS.md#security-limits).

Run only one runtime per workspace. The runtime rejects concurrent use and reuse
by a different deployment profile. To change profiles, copy only ordinary project
data and saved results from `/workspace/<PROJECT_ID>/` into a new volume's project
directory. Never copy the enclosing `/workspace` root, `.runtime`, or `.ide-state`.
Sessions and credentials do not transfer with project files.

### Data privacy

In a local Docker installation, the runtime, workspace, and bundled analysis tools
run on your Docker host. Model requests go to the provider you connect. They can
include prompts, file content, and tool results. Agent tools can also make network
requests. Running the container locally does not make inference offline or prevent
data disclosure. Choose a provider and deployment appropriate for your data.

## Continue or stop

To continue, start the launcher with the same workspace options you used before.
Without workspace options, it uses the default Docker volume.

To stop, exit the TUI. Exiting shuts down its local runtime and owned services.
Finish pending work before you exit or rebuild.

## Update the image

1. Exit the TUI.
2. Pull the latest harness source.
3. Update the geology tools submodule:

	```sh
	git submodule update --init --recursive
	```

4. Check the processor tag in step 2 of [Build the image](#build-the-image).
   If the tag changed, clone it into a new folder and point
   `PREPROCESSING_SOURCE_DIR` at that checkout. Keep any local processor changes
   in the old folder.
5. Rebuild the image with `PREPROCESSING_SOURCE_DIR` set to the selected checkout.
   Use the build command from step 5 of [Build the image](#build-the-image).
6. Restart with your usual workspace and processing options.

## Documentation

- [Native document processing](docs/NATIVE_DOCUMENT_PROCESSING.md): setup,
  processing-model selection, and recovery.
- [Runtime configuration](ENVIRONMENT_VARIABLES.md): settings and credentials.
- [Engine build guide](opencode/engine/README.md): build and qualify the pinned
  OpenCode engine.

## Licensing

EigenformAI-owned original code and documentation are licensed under the
[Apache License 2.0](LICENSE). [NOTICE](NOTICE) describes the scope of that grant.
Third-party code and datasets retain their own terms, listed in
[ThirdPartyNotices.txt](ThirdPartyNotices.txt). The bundled
[Wattle Creek sample](runtime/demo-bundles/wattle-creek/v1/README.md) is synthetic
data with its own CC0 dedication.
