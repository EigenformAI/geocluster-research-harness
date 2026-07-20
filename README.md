# Geocluster Research Harness

A browser IDE with a **geology-specialized AI research agent** built in. Point
it at geochemistry tables, well logs, rasters, and technical reports, and ask
it to inspect, cluster, map, rank anomalies, and answer questions grounded in
your documents — with the analysis running through a bundled geological MCP
server (50+ tools) and a multi-layer specialist agent system.

Built on [Cline](https://github.com/cline/cline) (Apache-2.0, fork of v3.56.0),
[code-server](https://github.com/coder/code-server), and
[geocluster-mcp](https://github.com/EigenformAI/geocluster-mcp).

## Quick start (Docker)

```bash
docker run -d -p 127.0.0.1:3000:3000 -v geocluster-workspace:/workspace \
  ghcr.io/eigenformai/geocluster-research-harness
```

Open **http://localhost:3000**. The workspace comes pre-loaded with a synthetic
geology project; open the Geology Agent panel in the right sidebar, pick any
supported model provider (OpenRouter, Anthropic, OpenAI, local Ollama, …),
paste your API key, and ask it to analyze the sample data.

Already have an [OpenRouter](https://openrouter.ai) key? Skip the setup screen:

```bash
docker run -d -p 127.0.0.1:3000:3000 -v geocluster-workspace:/workspace \
  -e OPENROUTER_API_KEY=sk-or-... \
  ghcr.io/eigenformai/geocluster-research-harness
```

Or with compose: clone the repo and `docker compose up` (add `--build` to
build from source — run `git submodule update --init` first).

> **Security note:** the IDE itself has no authentication (`--auth none`
> behind a localhost port). Never expose port 3000 to the internet; if you
> must host it, put it behind a reverse proxy that handles auth.

## What's inside

| Piece | What it does |
|---|---|
| `agent/` | The Geology Agent — a Cline fork with a 4-layer specialist system (orchestrator → analytics / dataops / geoviz / transform / extended specialists), a citation-grounded **Report Analysis** mode, and geological guardrails |
| `mcp-server/` | [geocluster-mcp](https://github.com/EigenformAI/geocluster-mcp) (git submodule) — 50+ MCP tools: dataset inspection, cleaning, clustering, band math, raster ops, plotting, anomaly ranking |
| `extensions/` | Helper VS Code extensions: LAS/geology file viewers, CSV viewer |
| `docker/` + `Dockerfile` | code-server-based image that wires it all together |
| `sample-workspace/` | Synthetic demo project seeded on first run |

## Use it in your own VS Code

Every release ships a prebuilt `geology-agent-<version>.vsix` — installable in
desktop VS Code (≥ 1.109) alongside regular Cline; the extension is renamed so
the two don't collide. The MCP server and specialist CLI are optional add-ons
for the full experience. See [docs/VSIX_INSTALL.md](docs/VSIX_INSTALL.md).

## Providers

The full Cline provider matrix is available: OpenRouter, Anthropic, OpenAI,
Google Gemini, AWS Bedrock, Ollama/LM Studio (local), DeepSeek, and more.
`OPENROUTER_API_KEY` is only a convenience — if it's unset you choose a
provider in the welcome screen, and a provider chosen in the UI is never
overridden by the environment.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit together
- [docs/SPECIALIST_AGENT_ARCHITECTURE.md](docs/SPECIALIST_AGENT_ARCHITECTURE.md) — the 4-layer agent system
- [docs/DESIGN_INVARIANTS.md](docs/DESIGN_INVARIANTS.md) — non-negotiable agent design rules
- [docs/REPORT_ANALYSIS_MODE.md](docs/REPORT_ANALYSIS_MODE.md) — citation-grounded report Q&A
- [docs/BUILDING.md](docs/BUILDING.md) — building from source
- [docs/CHANGES_FROM_ORIGINAL.md](docs/CHANGES_FROM_ORIGINAL.md) — what diverged from upstream Cline

## Relationship to Cline

The agent is a fork of [Cline](https://github.com/cline/cline) v3.56.0
(Apache-2.0), maintained as a standalone project — geology prompt variants,
the specialist dispatch system, report grounding, and IDE integration are
built on top of the upstream base. It is renamed (`eigenformai.geology-agent`)
so it can be installed next to the real Cline, and this project is not
affiliated with or endorsed by the Cline team. See [NOTICE](NOTICE).

## License

[Apache-2.0](LICENSE). Portions derived from Cline, © Cline Bot Inc. —
see [NOTICE](NOTICE) and [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
