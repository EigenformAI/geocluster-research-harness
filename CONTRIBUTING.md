# Contributing

Thanks for your interest in the Geocluster Research Harness.

## Repo layout

- `agent/` — the Geology Agent (fork of Cline v3.56.0). Vendored source; we
  rebase onto newer Cline releases only when there's a concrete reason.
- `mcp-server/` — git submodule →
  [EigenformAI/geocluster-mcp](https://github.com/EigenformAI/geocluster-mcp).
  MCP tool changes belong in that repo.
- `extensions/`, `docker/`, `Dockerfile` — helper extensions and the image.

## Getting started

See [docs/BUILDING.md](docs/BUILDING.md). The quickest dev loop for agent
changes: build the VSIX and install it into desktop VS Code (≥ 1.109), or
`docker compose up --build` for the full stack.

## The rules that matter

The specialist agent system has **non-negotiable design invariants**
([docs/DESIGN_INVARIANTS.md](docs/DESIGN_INVARIANTS.md)) — layer permissions,
MCP tool filters, path containment. Before touching anything under
`agent/src/core/prompts/system-prompt/` or the specialist handlers:

1. Read the invariants doc.
2. Identify which invariants your change touches.
3. If you must violate one, name it in the PR, explain why, and update both
   the doc and the tests.
4. `npm run test:invariants` must pass.

## Pull requests

- Run `npm run test:unit` and `npm run lint` in `agent/` before opening a PR.
- System-prompt changes: regenerate snapshots with
  `UPDATE_SNAPSHOTS=true npm run test:unit` and commit them.
- Keep changes surgical — this is a large fork and gratuitous drift from
  upstream Cline makes future rebases harder.

## Reporting security issues

See [SECURITY.md](SECURITY.md) — please don't open public issues for
vulnerabilities.
