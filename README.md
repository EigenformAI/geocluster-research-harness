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

## Start GeoCluster

Clone the repository and the processor release it is tested with, then build
the image:

```sh
git clone https://github.com/EigenformAI/geocluster-research-harness.git
git clone --depth 1 --branch preprocessing-d0631c8 \
	https://github.com/EigenformAI/geocluster-data-preprocessing-service.git
cd geocluster-research-harness
git submodule update --init --recursive
PREPROCESSING_SOURCE_DIR="$(cd ../geocluster-data-preprocessing-service && pwd)" \
	IMAGE_TAG=local bash scripts/build-docker.sh
./scripts/run-runtime-tui.sh --image geocluster-runtime:local
```

The launcher starts the native profile with the pinned OpenCode TUI, local file
service, and geology tools. Run `/connect` to connect your provider, then `/models`
to select a model. No GeoCluster model proxy, project model token, machine
credential, or backend activity endpoint is required. Startup does not perform
paid inference.

Use Git rather than GitHub's Download ZIP option. The build needs the
`geocluster-mcp` submodule, which a repository ZIP does not include.

Provider connections and conversation state persist inside the retained container
workspace. Host OpenCode accounts and credentials are not copied or mounted
automatically. Run `./scripts/run-runtime-tui.sh --help` for image, workspace, and
explicit provider-environment options. `scripts/tui.sh` delegates to this launcher;
it accepts the same launcher options.

Native startup publishes no host ports.
Some provider login methods show a URL or device code. Methods that require a
container loopback callback may need extra operator configuration.

The processor source remains a full-image build prerequisite. Integrated document
extraction is optional. For [native document processing](docs/NATIVE_DOCUMENT_PROCESSING.md),
restart with `--processing-model provider/model[#variant]`. Processing reuses the
native OpenCode connections by default while keeping its model selection separate
from the conversation. Ordinary startup does not enable it.

## Analyze a file

For a new bind-mounted workspace on rootful Linux Docker, provision a root-owned
volume directory. Keep it non-writable by other users; the runtime stores private
state beside the project. Use a new directory, not an existing home or project
root. Do not change ownership of another profile's retained state. Create the
project directory as your host user, then copy the CSV before starting the TUI:

```sh
sudo install -d -o root -g root -m 0755 native-workspace
sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 native-workspace/default
cp /absolute/path/to/assays.csv native-workspace/default/assays.csv
./scripts/run-runtime-tui.sh --image geocluster-runtime:local \
	--workspace-root "$PWD/native-workspace" --project default
```

On Docker Desktop, rootless Docker, or remote Docker, use a Docker-managed
workspace volume instead of these host-ownership commands.

Reuse the same workspace options on later starts. Without a workspace option,
the helper uses the Docker volume `geocluster-native-workspace` and project
`default`. Inside the container, files are under `/workspace/<PROJECT_ID>/`.
Existing inputs need permissions that let engine UID 999 and file UID 998 read
them. The native helper does not automatically configure host file sharing.

In the TUI, ask:

> Summarize the copper assays in assays.csv and save copper-summary.csv in this
> session's results folder.

Find the result inside your project directory under:

```text
runs/<session-id>/results/copper-summary.csv
```

Check the agent's response for the output path. If the TUI asks for permission
to write a file, approve or deny the request there.

Other questions to try with your own files:

> Check drilling-assays.csv against collars.csv by hole_id. Save unmatched
> intervals and a QA report. Preserve reported values and do not invent collars.

> Summarize the sampling methods in report.pdf. Cite the PDF pages and distinguish
> reported findings from your interpretation.

> Cluster the selected geochemical columns in assays.csv. Explain the method and
> scaling choice, save the assignments, and leave the input unchanged.

These filenames are examples. Replace them with files in your project.

## Work with local files

Keep the retained workspace to preserve files, conversation history, and provider
connections. Native engine state has mode `0700` and is outside the project
directory. Whole-volume backups can contain provider secrets and
refresh tokens. Protect those backups like credentials.

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

### Does my data leave the machine?

In a local Docker installation, the runtime, workspace, and bundled analysis tools
run on your Docker host. Model requests go to the provider you connect. They can
include prompts, file content, and tool results. Agent tools can also make network
requests. Running the container locally does not make inference offline or prevent
data disclosure. Choose a provider and deployment appropriate for your data.

## Continue, update, or stop

```sh
./scripts/run-runtime-tui.sh --image geocluster-runtime:local # Add your workspace options
./scripts/run-runtime-tui.sh --help # Show launcher options
```

Exiting the TUI shuts down its local runtime and owned services.
Finish pending work before exiting or rebuilding.
After updating source, rebuild the image with the build command above.

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
