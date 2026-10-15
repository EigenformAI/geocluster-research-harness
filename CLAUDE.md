# Contributor instructions

Preserve the four-layer specialist system: user-facing agent, analysis
orchestrator, domain specialists, and extended-capability agent.

Before changing delegation or tool access, read `docs/DESIGN_INVARIANTS.md`.
Identify the affected invariant IDs. A changed constraint requires an updated
rationale and behavioral tests.

Layer 1 is read-only and delegates only to the orchestrator. Layer 2 plans and
routes without MCP, shell, or write access. Domain specialists use exact tool
allowlists. Only Extended installs packages within the layered system and records
them in `environment.yaml`. Errors identify the agent, tool, cause, and next step.

Edit prompt sources in `opencode/prompt-src/`, then regenerate configuration with
`npm --prefix opencode run build`. Verify with:

```sh
npm --prefix opencode run check
npm --prefix opencode run test:invariants
```

Keep documentation focused on setup, usage, constraints, and decisions that code
cannot communicate. Use generated API schemas for endpoint and field inventories.
Do not retain migration histories, implementation tours, or verification diaries.
