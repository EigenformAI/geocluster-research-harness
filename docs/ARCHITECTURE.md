# Architecture

How the Geocluster Research Harness fits together at runtime (the Docker
image) and what each repo component contributes.

## Runtime layout (one container)

```
┌────────────────────────────────────────────────────────────────┐
│  Container                                                     │
│                                                                │
│  :3000  ide-proxy.js ──────► :3001  code-server (user: theia)  │
│         (healthz, WS pass-through)     │                       │
│                                        │ loads                 │
│                              Geology Agent extension           │
│                              (eigenformai.geology-agent)       │
│                                │              │                │
│                     LLM API calls        SSE localhost:7654    │
│                     (user's provider)         │                │
│                                        MCP server (FastMCP)    │
│                                        50+ geological tools    │
│                                                │               │
│                              /workspace/default (volume)       │
│                              seeded from sample-workspace/     │
└────────────────────────────────────────────────────────────────┘
```

- **entrypoint.sh** (root): seeds the workspace on first run, starts the MCP
  server, writes code-server settings, then drops privileges via `gosu` and
  starts code-server behind the local proxy. The container's only required
  external traffic is the agent's LLM API calls.
- **ide-proxy.js**: forwards :3000 → :3001, serves `/healthz` (healthy only
  when code-server responds), and passes WebSocket upgrades through with the
  original Host header (code-server's CSRF check requires it).
- **navigator shim + patches**: code-server 4.109 traps `globalThis.navigator`
  in the extension host, which breaks dependencies (Anthropic SDK, Zod) at
  module load. The Dockerfile sed-patches the trap out and preloads
  `docker/navigator-shim.js`; both are pinned to the exact
  `CODE_SERVER_VERSION` — re-validate them on any version bump.

## The agent (`agent/`)

A fork of Cline v3.56.0. The headline changes (full list in
[CHANGES_FROM_ORIGINAL.md](CHANGES_FROM_ORIGINAL.md)):

- **4-layer specialist system** — a read-only Geology Agent (L1) and a
  planning orchestrator (L2) route work to specialists (L3: analytics,
  dataops, geoviz, transform) and a wildcard Extended agent (L4). Specialists
  run as CLI child processes (`cline '<objective>' --json -y`) spawned by
  `dispatch_specialist`; each layer has an enforced MCP tool filter. See
  [SPECIALIST_AGENT_ARCHITECTURE.md](SPECIALIST_AGENT_ARCHITECTURE.md) and
  [DESIGN_INVARIANTS.md](DESIGN_INVARIANTS.md).
- **Provider handling** — the full Cline provider matrix is retained. If
  `OPENROUTER_API_KEY` is set in the environment, the extension pre-configures
  OpenRouter on first run (and never overrides a provider the user picked in
  the UI). When dispatching a specialist, the extension mirrors the active
  provider's API key into the CLI's `secrets.json` (mode 600) so child
  processes can authenticate — keys are never passed on the command line.
- **Telemetry** — upstream PostHog/OpenTelemetry reporting is disabled.

## The MCP server (`mcp-server/`)

[EigenformAI/geocluster-mcp](https://github.com/EigenformAI/geocluster-mcp),
pinned as a git submodule. A Python FastMCP server (SSE transport, port 7654)
exposing dataset inspection, cleaning, transforms, clustering, raster ops,
plotting, and anomaly-ranking tools. `MCP_WORKSPACE_ROOT` confines all file
access to the workspace (`resolve_path()` containment).

The agent discovers it through `cline_mcp_settings.json`, which the Dockerfile
seeds into the extension's globalStorage from `sample-workspace/.vscode/mcp.json`
(SSE URL + an autoApprove list so users aren't prompted for every tool call).
CLI specialist children receive `CLINE_DATA_DIR=<globalStorage>` and therefore
use the same settings and the same server.

## Trust model

Single-user, local-first. code-server runs with `--auth none` behind a
localhost-published port; there is no authentication layer in the container.
The container starts as root only to own the workspace and set `/proc`
hidepid, then drops to the unprivileged `theia` user before starting the IDE.
API keys live in code-server's SecretStorage (or the CLI's mode-600
`secrets.json` mirror) inside the container/volume. Do not publish port 3000
beyond localhost.
