# Using the Geology Agent in your own VS Code

The Docker image is the turnkey path, but the agent is a normal VS Code
extension and every release ships a prebuilt VSIX.

## Install

1. Download `geology-agent-<version>.vsix` from
   [Releases](https://github.com/EigenformAI/geocluster-research-harness/releases).
2. VS Code ≥ **1.109** (the agent lives in the secondary sidebar, which needs
   1.109+): `Extensions → … → Install from VSIX`, or
   `code --install-extension geology-agent-<version>.vsix`.
3. Open the Geology Agent panel (right sidebar), pick a provider, paste your
   API key.

The extension id is `eigenformai.geology-agent` — it installs cleanly
alongside regular Cline with no command or view collisions.

What works out of the box: chat, the geology prompt variants, and everything
upstream Cline can do.

## Optional: the geological MCP tools

The 50+ analysis tools (clustering, rasters, plots, anomaly ranking) live in a
separate MCP server. Without it the agent still works; specialists just can't
run those tools.

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/):

```bash
git clone https://github.com/EigenformAI/geocluster-mcp.git
cd geocluster-mcp
uv sync
MCP_WORKSPACE_ROOT=/path/to/your/data uv run python main.py   # SSE on :7654
```

Then in the agent's MCP settings add a remote server:

```json
{
  "mcpServers": {
    "geocluster": {
      "type": "sse",
      "url": "http://localhost:7654/sse",
      "disabled": false,
      "timeout": 60
    }
  }
}
```

(The Docker image auto-approves the analysis tools; in your own VS Code you
approve tool calls from the UI, or add an `autoApprove` list — see
`sample-workspace/.vscode/mcp.json` in the repo for the full list.)

Set `MCP_WORKSPACE_ROOT` to the folder your VS Code workspace is open on —
the server refuses paths outside it.

## Optional: specialist dispatch (CLI)

Multi-agent dispatch spawns child processes through the agent CLI. Without it,
`dispatch_specialist` reports "CLI not installed" and the orchestrator carries
on single-agent.

1. Download `geology-agent-cli-<version>.tar.gz` from the same release
   (matching version — the extension↔CLI protocol is version-coupled).
2. Unpack, install runtime deps, and put the binary on PATH:

```bash
tar -xzf geology-agent-cli-<version>.tar.gz
cd cline-cli && npm install --production
ln -s "$PWD/dist/cli.mjs" /usr/local/bin/cline && chmod +x dist/cli.mjs
```

The extension mirrors your active provider's API key into the CLI's secret
store automatically when dispatching — no separate key setup.
