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

- A running Linux x64 Docker environment. ARM execution and cross-building are
  not supported. Install Buildx if you need to build the image.
- Bash, Git, Python 3, and an interactive terminal.
- Your own model-provider account or API key supported by OpenCode. Connect it
  inside the TUI.

You do not need a GeoCluster account, backend token, or `.env` file. You do not
need to install OpenCode on your host. Your provider handles model requests and
charges for usage under its own pricing.

## Set up a project

1. Clone this repository. Use Git, not GitHub's Download ZIP option: a ZIP does
    not include the `geocluster-mcp` submodule that the build needs.

	```sh
	git clone --recurse-submodules https://github.com/EigenformAI/geocluster-research-harness.git
	```

2. Change into the harness checkout. Run every later command from here.

	```sh
	cd geocluster-research-harness
	```

3. Start the setup guide.

	```sh
	./scripts/setup.sh
	```

Press Enter to keep the recommended choices: prepare GeoCluster, use
Docker-managed storage, and add Wattle Creek samples to project `default`.
Setup downloads the pinned document processor source when a build is needed.
You can choose an installed image, copy your own data folder, or add files later.
An existing project defaults to keeping its files without adding anything.

Setup offers to open the TUI when the project is ready. Follow
[Ask about the folder](#ask-about-the-folder) to connect your provider and try a
first question.

To open the saved project again, run this command without options:

```sh
./scripts/tui.sh
```

Setup saves these choices for this checkout. Find the launch command and
first-use instructions in `.geocluster/next-steps.txt`.

To change the saved choices, run `./scripts/setup.sh` again. For custom launch
options, use the [explicit launcher](#use-the-explicit-launcher).

## Add a data folder

1. Run `/exit` inside GeoCluster before a file transfer.
2. In your usual terminal, start the import command.

	```sh
	./scripts/project-files.sh import
	```

3. Choose the source folder and a new folder name inside the project when prompted.

The command copies your folder into the saved project. Your originals stay
unchanged. Imports create a new folder inside the project. They do not merge with
or replace an existing folder. If source files are private to your account, the
command asks before giving GeoCluster's tools access to the copy.

Copy complete data folders to preserve linked files. For example, a shapefile
needs its `.shx`, `.dbf`, and `.prj` files, and drillhole assays need collars and
surveys for spatial analysis. Name a folder in your question to have the agent
inspect its files.

Project data lives at `/workspace/<PROJECT_ID>/` in the container. A workspace
also keeps private provider connections and conversation history outside the
project. With remote Docker, the workspace lives on the Docker host. The transfer
command copies files from your client without a remote bind mount.

For a host folder, setup supports local rootful Linux Docker and uses
administrator access to create a dedicated workspace. The project becomes
container-owned. Some host edits need administrator access. This option does not
enable automatic permission sharing.

The launcher mounts the workspace, not your home directory or unrelated host
folders. Agent code is not confined to the project folder. See
[Protect your workspace](#protect-your-workspace).

## Ask about the folder

1. Run `/connect` in the TUI to connect your provider. No GeoCluster account or
   token is needed. The connection persists in this workspace.

2. Run `/models` to select a model. Startup does not perform paid inference.

3. If you selected the samples, ask this question. Use the sample folder name
   shown by setup if you chose a name other than `wattle-creek`.

   > Check wattle-creek/drilling/assays.csv against wattle-creek/drilling/collars.csv
   > by hole_id. Save unmatched intervals and a QA report. Preserve reported values
   > and do not invent collars.

   The answer should report hole `WC141`, which has assay intervals but no
   collar.

4. Find the saved files in the paths that the answer lists. Each conversation
   saves its outputs under `runs/<session-id>/results/` in the project folder.
   If the TUI asks for permission to write a file, approve or deny the request
   there. Use [Share results](#share-results) to copy outputs to your computer.

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

To copy results from the saved project to your computer:

1. Finish pending work and run `/exit` inside GeoCluster.
2. Stop other programs that edit the project files, including host editors.
3. In your usual terminal, start the export command.

	```sh
	./scripts/project-files.sh export
	```

4. Choose the results folder from the displayed paths. Choose a new destination
   folder on your computer when prompted.

Exports create a new destination without replacing existing files. They copy
ordinary project content, not provider connections or private runtime state.
Transfers reject links and mounted subtrees. They are not permission-preserving
backups.
Imports and exports require exclusive access to the workspace. Run
`./scripts/project-files.sh --help` for explicit storage and project options.

## Configure the runtime

Use ordinary OpenCode user configuration for provider settings and model defaults.
Host OpenCode accounts and credentials are not imported automatically.
Some provider login methods show a URL or device code. Native startup publishes
no host ports, so login methods that need a container loopback callback may
require extra configuration.

Use `./scripts/tui.sh` without options to open the saved project. It does not
accept workspace, provider, or processing overrides. Use the explicit launch
command printed by setup for those options.

GeoCluster can read text already present in PDF files. To enable extraction from
scanned pages, add `--processing-model 'provider/model[#variant]'` to your explicit
launch command. Keep the same image, workspace, and project choices. Replace the
model reference with an available model. Processing reuses your native OpenCode
connections but selects its model separately from the conversation. Ordinary
startup leaves processing disabled. See
[native document processing](docs/NATIVE_DOCUMENT_PROCESSING.md) for setup,
job tracking, and recovery.

### Use the explicit launcher

```sh
./scripts/run-runtime-tui.sh --image geocluster-runtime:latest \
	--workspace-volume geocluster-native-workspace --project default
```

Run `./scripts/run-runtime-tui.sh --help` for custom workspace, provider-environment,
and processing-model options. This launcher does not read saved setup choices.
Reuse the same workspace and project options on every explicit launch.

#### Use a dedicated host folder

Use local rootful Linux Docker. Choose a new dedicated folder outside the
checkout, not your home directory or an existing data folder. Run the preparation
commands only if the workspace does not already exist. Do not change ownership
of an existing workspace to make startup pass.

```sh
workspace="$HOME/.local/share/geocluster/workspaces/manual"
mkdir -p "$(dirname "$workspace")"
sudo install -d -o root -g root -m 0755 "$workspace"
./scripts/run-runtime-tui.sh --image geocluster-runtime:latest \
	--workspace-root "$workspace" --project default
```

Project files become container-owned. Host edits can need administrator access.
For Desktop, rootless, or remote Docker, prefer Docker-managed storage.
A bind path refers to the Docker host.

### Build the image manually

Run these commands from the harness checkout. Install Docker Buildx first.
The image needs the document processor source even when extraction is disabled.
Choose a new processor folder. Keep existing checkouts with local changes.

```sh
git submodule update --init --recursive
git clone --no-checkout \
	https://github.com/EigenformAI/geocluster-data-preprocessing-service.git \
	../geocluster-processor-release
git -C ../geocluster-processor-release checkout --detach \
	"$(python3 -c 'import json; print(json.load(open("scripts/preprocessing-release.json"))["sourceRevision"])')"
git -C ../geocluster-processor-release submodule update --init --recursive
PREPROCESSING_SOURCE_DIR="$(cd ../geocluster-processor-release && pwd)" \
	bash scripts/build-docker.sh
```

Release builds require the pinned source without local changes. To build with
processor changes instead, use:

```sh
PREPROCESSING_BUILD_MODE=development \
	PREPROCESSING_SOURCE_DIR="$(cd ../geocluster-processor-release && pwd)" \
	IMAGE_TAG=local bash scripts/build-docker.sh
```

Use `geocluster-runtime:local` for that development image.

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

To continue with the saved project, run:

```sh
./scripts/tui.sh
```

If the saved image, project, or Docker connection is unavailable, run
`./scripts/setup.sh` to choose the destination again. Saved launch does not
create a replacement project or follow a changed image tag.

To stop, run `/exit` in the TUI. Exiting shuts down its local runtime and owned
services. Finish pending work before you exit or rebuild.

## Update the image

1. Run `/exit` in the TUI.
2. Pull the latest harness source.
3. Update the geology tools submodule:

	```sh
	git submodule update --init --recursive
	```

4. Run `./scripts/setup.sh`. Choose **Build the current GeoCluster image** in the
   image choices. Setup fetches the pinned processor source and offers to keep
   your existing workspace and project.
5. Open the saved project with `./scripts/tui.sh`.

For manual builds, follow [Build the image manually](#build-the-image-manually).
Keep modified processor checkouts instead of replacing them. After a rebuild,
run setup to select the new image. Saved launch uses the previously selected
immutable image ID, not a tag that may have moved. For document processing,
restart with your explicit launch command and its processing options.

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
