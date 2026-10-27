# GeoCluster Research Harness

Exploration geoscience runs on messy tabular and spatial data: assay tables with
detection limits, well logs, magnetic surveys, NI 43-101 reports. GeoCluster
Research Harness brings a geology-specialized research agent and a bundled
geological MCP server into one Docker image. Add your data to a project folder
and ask it to inspect, clean, cluster, rank anomalies, or answer questions grounded
in your documents.

Built on [OpenCode](https://opencode.ai) and
[geocluster-mcp](https://github.com/EigenformAI/geocluster-mcp). This open-source
release runs through the OpenCode terminal user interface (TUI), with your own
model provider. Keep input files and saved results together in a project
workspace you control.

## What you can do

- Inspect and clean assay tables, check missing values, and compare drillhole
  inputs without silently treating below-detection values as zero.
- Cluster geochemical data, rank anomalies, and save tables and plots for review.
- Ask questions about technical reports, including NI 43-101 reports, with
  page-labelled PDF text. Optional document processing extracts retained tables
  and other report content for further analysis.
- Turn findings into a PDF, Word, PowerPoint, and Excel pack for people who will
  not open the data. See [Share results](#share-results).
- Open the session of any specialist the agent used, and read the tool calls and
  scripts behind each number. See
  [Read what each specialist did](#read-what-each-specialist-did).

The geology prompts require source citations for data-derived claims and separate
measurements from interpretation. These are agent instructions, not a guarantee
of correctness. Review the cited evidence before using a result.

## Before you start

You need:

- Docker running, with Buildx installed.
- Git, Python 3, and an interactive terminal.
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

2. Clone the document processor at the release this harness pins.

   ```sh
   git clone --depth 1 --branch preprocessing-d0631c8 \
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
   checkout from step 2. `IMAGE_TAG=local` names the image
   `geocluster-runtime:local`.

   ```sh
   PREPROCESSING_SOURCE_DIR="$(cd ../geocluster-data-preprocessing-service && pwd)" \
   	IMAGE_TAG=local bash scripts/build-docker.sh
   ```

   The build prints `Processor working-tree bundle SHA-256`. For the pinned
   release (commit `d0631c8`) it is
   `82b40ed2ce2a3137992726958eb82083b14455c8e4ca914dfeba2dcdccc22847`. A different
   value means the captured processor files, or this checkout's
   `scripts/preprocessing-build-requirements.txt`, differ from the pinned build.

## Add a project folder

The agent can read only the project folder, which the container sees as
`/workspace/<PROJECT_ID>/`. It cannot reach your home directory, your downloads,
or any other host path. Copy the whole data folder into the project, not single
files, for three reasons:

- Geoscience data comes in linked sets. A shapefile needs its `.shx`, `.dbf`, and
  `.prj` files. Assays need their collars and surveys to be located. A report
  cites its appendix tables. A file copied alone loses those links.
- You can name a folder in your question ("profile every CSV in
  `wattle-creek/`") instead of naming files one at a time.
- Naming a path does not load the file into the conversation. The agent's tools
  read the files, and only compact results enter the conversation.

The steps below copy `runtime/demo-bundles/wattle-creek/v1`, a synthetic sample
of surface assays, drillhole collars, and drillhole assays that ships with this
repository. To use your own data, replace that path with your folder.

Pick the steps for your Docker setup.

### Rootful Docker on Linux

These steps bind-mount `native-workspace/` from this checkout. Git and the image
build ignore that folder.

1. Create the workspace root, owned by root. The runtime keeps private state,
   including provider credentials, beside the project in this folder. Root
   ownership keeps other users from changing it. Use a new folder, not your home
   or an existing project.

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

4. Make the copy readable by the runtime. The agent runs as UID 999 and the file
   service as UID 998. `cp` applies your umask, which can leave files that only
   you can read. `a+rX` adds read access for everyone, and execute access for
   folders only.

   ```sh
   chmod -R a+rX native-workspace/default/wattle-creek
   ```

5. Start the TUI with this workspace. `--workspace-root` mounts the folder at
   `/workspace`, and `--project` selects the project folder inside it.

   ```sh
   ./scripts/run-runtime-tui.sh --image geocluster-runtime:local \
   	--workspace-root "$PWD/native-workspace" --project default
   ```

On the first start, the runtime takes ownership of `native-workspace/default`
(UID 999). The files you copied keep their owner. You can still read and copy
results without `sudo`. To add another folder later, exit the TUI first:

1. Copy the folder with `sudo`.

   ```sh
   sudo cp -r /absolute/path/to/more-data native-workspace/default/more-data
   ```

2. Make it readable by the runtime.

   ```sh
   sudo chmod -R a+rX native-workspace/default/more-data
   ```

### Docker Desktop, rootless Docker, or remote Docker

Without a workspace option, the launcher uses the Docker volume
`geocluster-native-workspace` and the project `default`. A short-lived helper
container copies files into the volume. Exit the TUI before you start.

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
   	geocluster-runtime:local \
   	-c 'mkdir -p /workspace/default && cp -r /import /workspace/default/wattle-creek && chmod -R a+rX /workspace/default/wattle-creek'
   ```

   Change nothing in `/workspace` outside your project folder. The runtime
   refuses to start when `/workspace`, `/workspace/.runtime`, or the files in
   `.runtime` are not owned by root or are writable by other users.

3. Start the TUI.

   ```sh
   ./scripts/run-runtime-tui.sh --image geocluster-runtime:local
   ```

## Ask about the folder

1. Run `/connect` in the TUI to connect your provider. Then run `/models` to select
   a model. No GeoCluster account or token is needed, and startup itself does not
   perform paid inference. The connection stays in this workspace for later
   starts.

2. Ask a question that names the folder or the files in it:

   > Check wattle-creek/drilling/assays.csv against wattle-creek/drilling/collars.csv
   > by hole_id. Save unmatched intervals and a QA report. Preserve reported values
   > and do not invent collars.

   The answer should report hole `WC141`, which has assay intervals but no
   collar.

3. Find the saved files in the paths that the answer lists. Each conversation
   saves its outputs under `runs/<session-id>/results/` in the project folder.
   With the bind mount, that is
   `native-workspace/default/runs/<session-id>/results/` on your host. If the TUI
   asks for permission to write a file, approve or deny the request there.

Other questions to try:

> Profile every CSV in wattle-creek/. Give one table of columns, units, and
> missing values per file.

> Summarize the sampling methods in report.pdf. Cite the PDF pages and distinguish
> reported findings from your interpretation.

> Cluster the selected geochemical columns in assays.csv. Explain the method and
> scaling choice, save the assignments, and leave the input unchanged.

## Read what each specialist did

The agent you talk to delegates dataset work to an orchestrator. The orchestrator
delegates to specialists: Dataops, Transform, Analytics, Geoviz, and Voxel, with
Extended for capability gaps. Each one works in its own session. Open those
sessions to read the tool calls, the scripts each specialist wrote, and their
output. Check them before you share a number.

1. Click a line such as `Orchestrator Subagent — Check drilling inputs` in the
   transcript. You can also press `↓` with the cursor at the end of the prompt to
   open the **Subagents** picker.

2. Press `ctrl+a` to list finished sessions. Until you do, the picker lists only
   running sessions and shows `No active subagents` after a run.

3. Select a session and press `Enter`. The picker shows a tree: specialists sit
   under the orchestrator, and Extended sits under the specialist that called it.

4. Press `Esc` to go back up one level.

The picker returns to running sessions each time you open another session, so
press `ctrl+a` again there. After you restart the TUI, the tree loads one level at
a time: open the orchestrator to see its specialists.

## Share results

Ask for a shareable brief when you need something to email or present. The
Geoviz specialist builds it from the findings already in the conversation:

> Make a shareable brief of the drilling QA results for my manager.

The pack is saved under `runs/<session-id>/results/share/`:

- `<date>_<title>.pdf`: a one- to two-page brief.
- `<date>_<title>.docx`: the same brief, editable in Word.
- `<date>_<title>.pptx`: a title slide and one slide per finding.
- `<date>_<title>.xlsx`: the key tables, one sheet each.
- `figures/`: each figure as a 300 dpi PNG for slides and as an SVG.
- `brief.md`: the Markdown source of the three documents.

Figure titles state the finding, axes carry units, colours are colour-blind safe,
and every image has alt text. Numbers keep their sources as footnotes. Review the
brief before you send it.

To copy the pack to your host with the bind mount, run this from the checkout.
Replace `<session-id>` with the folder name from the answer.

```sh
cp -r native-workspace/default/runs/<session-id>/results/share ./wattle-creek-brief
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
   	geocluster-runtime:local \
   	-c 'cp -r /workspace/default/runs/<session-id>/results/share/. /export/'
   ```

## Work with local files

Keep the retained workspace to preserve files, conversation history, and provider
connections. Native engine state has mode `0700` and is outside the project
directory. Whole-volume backups can contain provider secrets and
refresh tokens. Protect those backups like credentials.

Host OpenCode accounts and credentials are not copied or mounted automatically.
Run `./scripts/run-runtime-tui.sh --help` for image, workspace, and explicit
provider-environment options. `scripts/tui.sh` delegates to this launcher and
accepts the same options. Native startup publishes no host ports. Some provider
login methods show a URL or device code. Methods that require a container
loopback callback may need extra operator configuration.

Use ordinary OpenCode user configuration for provider settings and model defaults.
Native mode also discovers project configuration. Project plugins and configuration
can execute code as the engine identity. Trust them before opening a project.
The state permissions do not hide credentials from that identity's shell tools;
native mode is not a credential sandbox. Agent tool permissions guide delegation;
they do not sandbox code executed by an agent. See the
[security limits](docs/DESIGN_INVARIANTS.md#security-limits) when choosing where
to run the harness.

The retained volume has one lifecycle owner and a profile marker. Concurrent
owners and reuse by another profile are rejected. To change profiles, copy only
ordinary project data and saved results from `/workspace/<PROJECT_ID>/` to a new
volume's project directory. Never copy the enclosing `/workspace` root,
`.runtime`, or `.ide-state`. This does not transfer sessions or credentials.

Integrated document extraction is optional. For
[native document processing](docs/NATIVE_DOCUMENT_PROCESSING.md), restart with
`--processing-model provider/model[#variant]`. Processing reuses the native
OpenCode connections by default while keeping its model selection separate from
the conversation. Ordinary startup does not enable it.

### Does my data leave the machine?

In a local Docker installation, the runtime, workspace, and bundled analysis tools
run on your Docker host. Model requests go to the provider you connect. They can
include prompts, file content, and tool results. Agent tools can also make network
requests. Running the container locally does not make inference offline or prevent
data disclosure. Choose a provider and deployment appropriate for your data.

## Continue, update, or stop

- To continue, start the launcher with the same workspace options you used
  before. Without workspace options it uses the Docker volume.

  ```sh
  ./scripts/run-runtime-tui.sh --image geocluster-runtime:local \
  	--workspace-root "$PWD/native-workspace" --project default
  ```

- To list every launcher option, run:

  ```sh
  ./scripts/run-runtime-tui.sh --help
  ```

- To stop, exit the TUI. Exiting shuts down its local runtime and owned services.
  Finish pending work before you exit or rebuild.

- To update, pull the new source and rebuild the image with step 5 of
  [Build the image](#build-the-image).

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
