# Geocluster Research Harness

Exploration geoscience runs on messy tabular and spatial data: assay tables with detection limits, well logs, magnetic surveys, NI 43-101 reports. Hand that to a general AI assistant and it does not know the conventions, and will invent a grade or a coordinate as readily as read one. Geocluster Research Harness is a self-contained **browser IDE** that closes the gap: a **geology-specialized research agent**, a bundled **50-tool geological MCP server** that runs the actual analysis, and viewers for LAS and CSV, all in one Docker image. Drop your data into a project folder, open `localhost:3000`, and ask it to inspect, clean, cluster, map, rank anomalies, or answer questions grounded in your documents.

Built on [Cline](https://github.com/cline/cline) (Apache-2.0, fork of v3.56.0),
[code-server](https://github.com/coder/code-server), and
[geocluster-mcp](https://github.com/EigenformAI/geocluster-mcp).

## Quick start — build and run (Docker)

Requires [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on Windows/macOS). Works the same in bash, PowerShell, and cmd:

```bash
git clone https://github.com/EigenformAI/geocluster-research-harness.git
cd geocluster-research-harness
git submodule update --init
docker compose up --build
```

> **Don't use GitHub's "Download ZIP" button** — it leaves `mcp-server/` empty (that folder is a git submodule, and a ZIP download can't include it), and the build will fail. Use `git clone` as shown above.

On macOS/Linux, `./run.sh` (or double-click `run.command` in Finder) does all of the above for you: checks Docker is installed and running, fetches the submodule if needed, builds, waits until it's ready, and opens the browser. `./stop.sh` (or `stop.command`) stops it again.

The first build compiles everything from source (agent extension, CLI, MCP server) and takes a while — later builds are cached and fast. When it's up, open **http://localhost:3000**: you'll land on a project picker. Click `defaults` to open a pre-loaded synthetic geology project, or create a new one from that same page. Once you're inside a project, open the Geology Agent panel in the right sidebar, pick a model provider, paste your API key, and ask it to analyze the data.

Each project is just a folder under `copy-your-files-here/` on your machine (a bind mount, not a Docker volume) — `copy-your-files-here/defaults/` is the sample project, and anything else you drop in there (or create from the picker page) shows up as its own project the next time you load the page.

Already have an [OpenRouter](https://openrouter.ai) key? Skip the setup screen:

```bash
OPENROUTER_API_KEY=sk-or-... docker compose up --build
```

(PowerShell: `$env:OPENROUTER_API_KEY="sk-or-..."; docker compose up --build`)

### Prebuilt image

Once releases are published, skip building from source — just pull the
compose file and let it use the `image:` it already points at
(`ghcr.io/eigenformai/geocluster-research-harness:latest`):

```bash
curl -O https://raw.githubusercontent.com/EigenformAI/geocluster-research-harness/main/docker-compose.yml
docker compose up
```

Same `copy-your-files-here/` layout as the build-from-source path above.

> **Security note:** the IDE itself has no authentication (`--auth none`
> behind a localhost port). Never expose port 3000 to the internet; if you
> must host it, put it behind a reverse proxy that handles auth.

## What's inside

| Piece | What it does |
|---|---|
| `agent/` | The Geology Agent — a Cline fork with a 4-layer specialist system (orchestrator → analytics / dataops / geoviz / transform / extended specialists) and geological guardrails |
| `mcp-server/` | [geocluster-mcp](https://github.com/EigenformAI/geocluster-mcp) (git submodule) — 50+ MCP tools: dataset inspection, cleaning, clustering, band math, raster ops, plotting, anomaly ranking |
| `extensions/` | Helper VS Code extensions: LAS/geology file viewers, CSV viewer |
| `docker/` + `Dockerfile` | code-server-based image that wires it all together |
| `sample-workspace/` | Synthetic demo project, seeded as the `defaults/` project folder on first run |

## Use it in your own VS Code

Every release ships a prebuilt `geology-agent-<version>.vsix` — installable in desktop VS Code (≥ 1.109) alongside regular Cline; the extension is renamed so the two don't collide. The MCP server and specialist CLI are optional add-ons for the full experience. See [docs/VSIX_INSTALL.md](docs/VSIX_INSTALL.md).

## Providers

The setup screen currently surfaces **OpenRouter**, **Anthropic**, and **ChatGPT Subscription**. Additional providers (Gemini, Bedrock, Ollama, DeepSeek, …) exist in the code and can be enabled via a one-line allowlist in `agent/webview-ui/src/components/settings/ApiOptions.tsx`. `OPENROUTER_API_KEY` is only a convenience — if it's unset you choose a provider in the welcome screen, and a provider chosen in the UI is never overridden by the environment.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit together
- [docs/SPECIALIST_AGENT_ARCHITECTURE.md](docs/SPECIALIST_AGENT_ARCHITECTURE.md) — the 4-layer agent system
- [docs/DESIGN_INVARIANTS.md](docs/DESIGN_INVARIANTS.md) — non-negotiable agent design rules
- [docs/BUILDING.md](docs/BUILDING.md) — building from source
- [docs/CHANGES_FROM_ORIGINAL.md](docs/CHANGES_FROM_ORIGINAL.md) — what diverged from upstream Cline

## Relationship to Cline

The agent is a fork of [Cline](https://github.com/cline/cline) v3.56.0 (Apache-2.0), maintained as a standalone project — geology prompt variants, the specialist dispatch system, report grounding, and IDE integration are built on top of the upstream base. It is renamed (`eigenformai.geology-agent`) so it can be installed next to the real Cline, and this project is not affiliated with or endorsed by the Cline team. See [NOTICE](NOTICE).

## FAQ

**Does my geology data leave my machine?**
The IDE, the MCP tools, and your files all run locally in Docker. The only thing that leaves is what the agent sends to the model provider you pick: its prompts and whatever tool output it decides to include in the conversation. Choose a provider whose data policy you are comfortable with, or point it at a local model (Ollama is in the code, enabled with a one-line allowlist).

**Do I need an API key?**
Yes, for the model. Pick a provider in the setup screen (OpenRouter, Anthropic, ChatGPT Subscription, or others via a one-line allowlist) and paste a key, or pass `OPENROUTER_API_KEY` to skip that screen.

**How is the agent different from plain Cline?**
It is a fork of Cline v3.56.0 with geology prompt variants, a 4-layer specialist dispatch system, report grounding, and geological guardrails. It is renamed (`eigenformai.geology-agent`) so it installs alongside the real Cline. See [docs/CHANGES_FROM_ORIGINAL.md](docs/CHANGES_FROM_ORIGINAL.md).

**What does the agent actually run?**
The bundled [geocluster-mcp](https://github.com/EigenformAI/geocluster-mcp) server: 50+ tools for dataset inspection and cleaning, spatial operations, clustering, anomaly ranking, band math, and plotting. The agent composes those tools instead of writing throwaway scripts.

**Can I host it for my team?**
Not as shipped. The IDE has no authentication. Put it behind a reverse proxy that handles auth and never expose port 3000 directly.

**Is it affiliated with Cline or Microsoft?**
No. It is an independent Apache-2.0 fork, not endorsed by the Cline team. VS Code and code-server are MIT and downloaded at image build time. See [NOTICE](NOTICE).

## License

[Apache-2.0](LICENSE). Portions derived from Cline, © Cline Bot Inc.
See [NOTICE](NOTICE) and [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
