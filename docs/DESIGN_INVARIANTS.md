# Design Invariants

> Hard rules that must hold true across all changes. Each rule exists because violating it caused a measured failure. These are not preferences — they are load-bearing constraints.
>
> **Referenced from:** `geocluster-ai-ide-BE/CLAUDE.md`
> **Enforcement:** Automated tests in `cline-fork/__tests__/invariants/`

---

## Governing Constraints

All invariants derive from four constraints, ordered by priority:

1. **Subsidiarity** — Each tool is accessed only by the lowest competent agent. Prompt bloat from over-provisioning kills context quality.
2. **Traceability** — Every failure must identify which agent produced it and where. This requires strict responsibility boundaries: one agent installs packages, agents execute only in their own spaces, all results include provenance.
3. **Admit uncertainty** — It is better for the system to tell the user "I don't know" than to fail silently. No silent fallbacks, no swallowed errors, no optimistic defaults.
4. **Start small and good** — One working hierarchy is worth more than five partial ones. A feature that "kind of works" is a liability, not an asset.

---

## Layer 1: User-Facing Geology Agent

| ID | Invariant | Failure Mode If Violated |
|----|-----------|--------------------------|
| L1-1 | **Must have `mcpToolFilter` restricting to minimal hygiene tools.** Allowed: `list_files`, `check_missing`, `*summarize_provenance*`. Data inspection tools (`inspect_dataset`, `inspect_specific_columns`, `inspect_raster`, `query_data`, `profile_geochem`) are **excluded** — they return large JSON responses that bloat context. Data inspection is delegated to orchestrator → specialists via scripts. | Context bloat. MCP inspection tools return full column stats, value counts, and data summaries (observed: 31-column stats + 89 element counts + 57 lithology counts in one turn). **Previously observed.** |
| L1-2 | **Must NOT have write/transform/cluster/plot/inspect MCP tools.** | Layer 1 attempts complex analysis itself instead of delegating, or inspection tools dump large JSON into context. |
| L1-3 | **Must have `activate_specialist` tool.** Must NOT have `dispatch_specialist`. | Layer 1 can only delegate to orchestrator, never directly spawn specialists. Chain of command: L1 → L2 → L3/L4. |
| L1-4 | **Delegation instructions must be in the prompt.** The prompt must explicitly state when to delegate vs handle directly, with concrete examples. | LLM guesses wrong on delegation boundary. Over-delegates simple tasks or under-delegates complex ones. |
| L1-5 | **Must NOT have `execute_command`, `write_to_file`, or `apply_patch` tools.** | Layer 1 bypasses the orchestrator pipeline by running shell commands or writing scripts directly. Defeats the entire layered architecture. Dedicated tools (`read_file`, `list_files`, read-only MCP) cover all Layer 1 use cases. |

### Minimal MCP Tools (Layer 1 Allowlist)

These tools return compact responses and don't dump data into context:

| Tool | Category | What It Does |
|------|----------|-------------|
| `list_files` | Hygiene | Lists files in a directory |
| `check_missing` | Hygiene | Reports missing value counts/percentages per column (compact — only columns with nulls) |
| `summarize_provenance` | Provenance | Lists artifacts in results/ folder |

**Excluded from Layer 1** (delegated to orchestrator → specialists):
- `inspect_dataset`, `inspect_specific_columns`, `inspect_raster` — return large JSON with per-column stats
- `query_data`, `profile_geochem` — return data previews, describe() output, value counts
- All write/transform/cluster/plot/export tools

---

## Layer 1 (sibling): Report Analysis variant (`report-eval`)

> **Note:** this mode is currently not exposed in the UI — the "RA" chip is
> hidden via the `ENABLED_AGENT_MODES` allowlist in
> `agent/webview-ui/src/components/chat/ChatTextArea.tsx`. The variant, the
> citation guard, and their invariant tests still ship and are enforced.

The **"Report Analysis"** agent mode (`AgentMode === "report-analysis"`) selects a separate Layer-1 variant, `report-eval` (`variants/report-eval/config.ts`), used to answer the stage-specific Mining-evals questions over a report that has already been extracted into the workspace (`text/`, `tables/`, `images/*.description.md`, optional `analysis/findings.json`). It is a sibling of the geology variant — not a replacement; the geology agent is unchanged.

| ID | Invariant | Notes |
|----|-----------|-------|
| RE-1 | **Keeps the SAME hard read-only posture as geology (L1-5):** no `execute_command`, no `write_to_file`, no `apply_patch`. Keeps `mcpToolFilter` with the minimal allowlist (`list_files`, `check_missing`, `*summarize_provenance*`) and `activate_specialist`. | Enforced in `design-invariants.test.ts` alongside the geology checks. |
| RE-2 | **Deliberately relaxes the geology SOFT prompt rule that discourages `read_file` on data files** — but only so the agent can read the *compact, per-section / per-table* extraction artifacts (`text/NN_*.md`, `tables/<id>.csv`, figure descriptions, `findings.json`) directly. This is a prompt-level change only; the tool set is identical and still read-only. Heavy multi-table quantitative work still delegates to the orchestrator. | Why: the geology rule biased the agent toward tables and made it ignore prose/figures. The extraction artifacts are small by construction. |
| RE-3 | **Broadens the citation grammar** beyond `[source: file \| col: column]` to also cite narrative (`text/NN_*.md \| p:N`), figures (`images/fig_* \| p:N`) and pre-verified metrics (`analysis/findings.json`). **Allows economic / mineability / resource judgments** (the Mining-evals questions explicitly ask for them; the geology variant forbids them). | The data/interpretation/assumption color-coding is preserved; each answer ends with a RAG verdict. |
| RE-4 | **Mechanical citation guard (anti-fabrication).** In report-analysis mode, `attempt_completion` is rejected if the answer cites any `[source: <file> …]` that was not in the set of files the agent **successfully read** this task. Prompt rules alone did not stop the model from guessing filenames (which 404'd) and citing them for invented data. | Tracked in `TaskState.readFilePaths` (written by `ReadFileToolHandler` on a successful read); checked by `findFabricatedCitations` (`tools/utils/citationGuard.ts`) in `AttemptCompletionHandler`. Scoped to the top-level report-analysis agent only. |

Selection ordering: `report-eval` is registered **before** geology in `VARIANT_CONFIGS`, and the geology matcher explicitly excludes `report-analysis`, so the modes never collide.

---

## Layer 2: Analysis Orchestrator

| ID | Invariant | Failure Mode If Violated |
|----|-----------|--------------------------|
| L2-1 | **Must NOT have MCP section in prompt components.** Zero MCP tools. | Orchestrator attempts domain work instead of routing. Violates "plans and routes, never executes." |
| L2-2 | **Must have `dispatch_specialist` and `activate_specialist` tools.** | Cannot spawn specialists or return control to Layer 1. |
| L2-3 | **Must NOT have `execute_command`, `write_to_file`, or `browser` tools.** | Orchestrator starts doing things instead of delegating. |
| L2-4 | **Must track specialist history.** `specialistHistory` must be passed to the orchestrator prompt so it survives context compression. | Orchestrator loses track of what was already dispatched. Re-dispatches specialists, contradicts previous results, infinite loops. |

---

## Layer 3: Domain Specialists

| ID | Invariant | Failure Mode If Violated |
|----|-----------|--------------------------|
| L3-1 | **Every specialist variant must define `mcpToolFilter` with `allowedToolPatterns`.** | Specialist sees all 30 tools. Prompt bloat + specialist acts outside its domain. |
| L3-2 | **MCP filter must be enforced at execution time**, not just prompt level. `UseMcpToolHandler` must check the filter before calling `mcpHub.callTool()`. | Hallucinating model calls tools that were filtered from its prompt. Transform specialist runs clustering, DataOps modifies data. |
| L3-3 | **Transform specialist SHOULD prefer MCP tools for simple operations** (normalize, pivot, filter). MAY use `execute_command` for operations requiring conditional logic, grouping, or multi-step pipelines. Scripts must be saved in `scripts/transform/` for auditability. Must NOT install packages (use `request_capability`). Must NOT have `replace_in_file` (no in-place editing of existing files). | Transform specialist uses shell for trivially MCP-solvable tasks, losing MCP audit trail. Or installs packages directly, causing dependency conflicts. |
| L3-4 | **All specialists must return `SpecialistResult` JSON via `attempt_completion`.** Status must be `success`, `partial`, or `error` — never empty, never unstructured prose. | Orchestrator can't parse result. Falls back to raw text parsing. Silent data loss. |
| L3-5 | **Specialists must NOT install packages.** Must use `request_capability` to signal gaps. | Uncontrolled dependency changes. Package conflicts. Container instability for other users. |

---

## Layer 4: Extended Capability Agent

| ID | Invariant | Failure Mode If Violated |
|----|-----------|--------------------------|
| L4-1 | **Extended is the ONLY agent that may install packages.** | Multiple agents making uncoordinated installs. Dependency conflicts. No audit trail. |
| L4-2 | **Must NOT have MCP tools.** Extended operates outside the geological toolset. | Extended starts doing geological analysis. Wrong agent for the job — no domain prompt, no hypothesis context. |
| L4-3 | **Must maintain `environment.yaml`** after every install: package name, version, timestamp, reason, task_id. | No record of what was installed or why. Can't reproduce the environment. Can't debug dependency conflicts. |
| L4-4 | **Must verify install success** (`python -c "import X; print(X.__version__)"`) before returning success. | Reports success but package didn't actually install. Specialist resumes and immediately fails again. |

---

## Cross-Cutting Invariants

| ID | Invariant | Failure Mode If Violated |
|----|-----------|--------------------------|
| X-1 | **`resolve_path()` must validate containment within `WORKSPACE_ROOT`.** All MCP tools that accept file paths must use it. | Path traversal. Model reads `/etc/passwd`, enumerates filesystem outside workspace. |
| X-2 | **`band_math` must AST-validate expressions before `eval()`.** No raw eval. | Remote code execution via crafted expression (e.g., `np.__class__.__mro__[-1].__subclasses__()...`). |
| X-3 | **`autoApprove` config must be validated against actual MCP tool names at connection time.** Mismatches must be logged as warnings. | Typo in autoApprove → tool not auto-approved → 600s hang in headless mode waiting for approval that never comes. |
| X-4 | **`CLINE_SPECIALIST` env var must be validated at CLI startup.** Invalid values → immediate exit with clear error. | Child runs as wrong agent type. No specialist behavior, no structured output, orchestrator gets garbage. |
| X-5 | **Unparseable specialist output = `status: "error"`, never `status: "success"`.** | Orchestrator treats garbage as valid result. Makes decisions based on non-existent data. |
| X-6 | **No silent fallbacks.** If an operation fails, it must return an error with: agent name, tool name, error description, and suggested next step. | User sees "something went wrong" with no way to diagnose. Support tickets with no actionable information. |

---

## Automated Enforcement

Tests in `cline-fork/__tests__/invariants/design-invariants.test.ts`:

```
L1-1: geology variant has mcpToolFilter defined
L1-2: geology variant mcpToolFilter does NOT match write/transform/cluster/plot tools
L1-3: geology variant has ACTIVATE_SPECIALIST, does NOT have DISPATCH_SPECIALIST
L2-1: orchestrator variant does NOT have MCP in componentOrder
L2-2: orchestrator variant has DISPATCH_SPECIALIST and ACTIVATE_SPECIALIST
L2-3: orchestrator variant does NOT have BASH, FILE_NEW, BROWSER
L3-1: all specialist variants (dataops, transform, analytics, geoviz) have mcpToolFilter
L3-3: transform variant DOES have BASH and FILE_NEW (Tier 2), does NOT have FILE_EDIT
L3-4: all specialist variants have ATTEMPT tool
L3-5: no specialist variant (except extended) has BASH without REQUEST_CAPABILITY
L4-1: only extended variant has BASH + no mcpToolFilter
L4-2: extended variant does NOT have MCP_USE or MCP_ACCESS
X-5: DispatchSpecialistHandler.parseSpecialistOutput returns error status for unparseable output
```

---

## How to Use This Document

### Before making any change to the specialist system:

1. Read the relevant invariant section
2. Check that your change doesn't violate any rule
3. If you need to violate a rule, you must:
   - Name the invariant being violated (e.g., "L1-1")
   - Explain why the previous failure mode no longer applies
   - Update this document with the new rule
   - Update the automated test

### Data Cleaning Tools (Section I)

| Tool | Type | Specialist | Description |
|------|------|-----------|-------------|
| `validate_geology` | Read-only diagnostic | DataOps | Column classification, missing columns, detection limits, comma decimals, negatives, duplicates |
| `detect_cleaning_issues` | Read-only diagnostic | DataOps | Per-column issue detection: missing, outliers, DL strings, non-numeric values |
| `fix_decimals` | Mutation | Transform | Convert comma-decimal to dot-decimal without corrupting non-numeric columns |
| `parse_detection_limits` | Mutation | Transform | Convert `<0.5`, `ND`, `BDL`, `trace` to numeric (half-DL method) |
| `remove_duplicates` | Mutation | Transform | Remove exact or key-based duplicates |
| `standardize_terms` | Mutation | Transform | Normalize geological terminology with optional custom mapping |

**Anti-hallucination principle:** All 6 cleaning tools are purely deterministic (pandas operations, regex matching, arithmetic). No LLM calls inside MCP tools. Source files are never modified — all output goes to `results/`.

### Verification Tools (Section J)

| Tool | Type | Specialist | Description |
|------|------|-----------|-------------|
| `verify_claims` | Read-only diagnostic | DataOps | Checks AI-generated numeric claims against source data within tolerance |

**Anti-hallucination principle:** `verify_claims` is purely deterministic (pandas aggregations, numeric comparison). No LLM calls. Source files are never modified. The orchestrator dispatches this after analytics/transform specialists return numeric results to catch hallucinated statistics.

### When adding a new MCP tool:

1. Categorize it: read-only or write/mutate
2. If read-only: consider adding to L1 allowlist (Layer 1 hygiene tools)
3. Add it to the appropriate specialist's `mcpToolFilter` pattern
4. Verify the automated tests still pass

### When adding a new specialist:

1. Must define `mcpToolFilter`
2. Must include `ATTEMPT` and `REQUEST_CAPABILITY` tools
3. Must follow `SpecialistResult` output contract
4. Add to automated invariant tests
5. Add to orchestrator's routing table

---

*Last Updated: 2026-03-10*
*Derived from: constraints discussion, `geological-agent-architecture.md` (original spec), observed failure modes*