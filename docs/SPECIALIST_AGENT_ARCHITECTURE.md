# Cline IDE — Specialist Agent Architecture

> How the 4-layer specialist agent system works in `cline-fork/` — from user question to structured geological analysis.

---

## 1. Overview

### Core Problem

Context window degradation in multi-step geological analysis. A single LLM conversation accumulates tool outputs, data descriptions, and intermediate results until the context is saturated and quality collapses.

### Solution: 4-Layer Specialist Hierarchy

```
 USER
  │
  │  Chat message (e.g. "Analyze this core sample data")
  ▼
╔═══════════════════════════════════════════════════════════════════════╗
║  LAYER 1 — User-Facing Geology Agent            [SAME PROCESS]      ║
║                                                                      ║
║  Variant: geology/config.ts                                          ║
║  ModelFamily: GEOLOGY                                                ║
║  Matcher: !context.activeSpecialist (default state)                  ║
║                                                                      ║
║  ┌────────────┐  ┌──────────────────┐  ┌──────────────────────────┐  ║
║  │ Read-only  │  │ Minimal MCP      │  │ activate_specialist      │  ║
║  │ tools only │  │ (check_missing,  │  │ (variant switch only)    │  ║
║  │ No shell   │  │  list_files,     │  │                          │  ║
║  │ No write   │  │  provenance)     │  │ No dispatch_specialist   │  ║
║  └────────────┘  └──────────────────┘  └────────────┬─────────────┘  ║
║                                                      │               ║
║  Handles: answer questions, check missing, list files                ║
║  Cannot: inspect data, transform, cluster, plot, shell, write files  ║
╚══════════════════════════════════════════════════════╪════════════════╝
                                                       │
                    activate_specialist("orchestrator") │ ◄── In-process variant switch
                    Sets TaskState.activeSpecialist     │     Same conversation context
                    Next API turn loads new variant     │     Zero additional cost
                                                       │
                    activate_specialist("default")      │
                    Sets activeSpecialist = null    ▲   │
                    Returns to Layer 1             │   ▼
╔══════════════════════════════════════════════════╪════════════════════╗
║  LAYER 2 — Analysis Orchestrator                 │  [SAME PROCESS]   ║
║                                                                      ║
║  Variant: specialists/orchestrator/config.ts                         ║
║  ModelFamily: SPECIALIST_ORCHESTRATOR                                ║
║  Matcher: context.activeSpecialist === "orchestrator"                ║
║                                                                      ║
║  ┌─────────────────┐  ┌──────────────┐  ┌──────────────────────┐    ║
║  │ 5 tools only:   │  │ NO MCP       │  │ Tracks:              │    ║
║  │ • read_file     │  │ access       │  │ • Hypotheses         │    ║
║  │ • attempt_compl │  │              │  │ • specialistHistory  │    ║
║  │ • dispatch_spec │  │ Plans only,  │  │ • Evidence for/      │    ║
║  │ • activate_spec │  │ never        │  │   against claims     │    ║
║  │ • todo          │  │ executes     │  │                      │    ║
║  └─────┬───────────┘  └──────────────┘  └──────────────────────┘    ║
║        │                                                             ║
║   dispatch_specialist(type, objective, context)                      ║
║        │                                                             ║
╚════════╪═════════════════════════════════════════════════════════════╝
         │
         │  CLINE_SPECIALIST=<type> cline '<prompt>' --json -y
         │  ◄── Child process spawn (separate context window)
         │      Clean context per dispatch
         │      Returns SpecialistResult JSON
         │
         ├────────────────────┬───────────────────┬──────────────────┐
         │                    │                   │                  │
         ▼                    ▼                   ▼                  ▼
┌─────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
│ LAYER 3         │ │ LAYER 3        │ │ LAYER 3        │ │ LAYER 3        │
│ DataOps         │ │ Transform      │ │ Analytics      │ │ GeoViz         │
│                 │ │                │ │                │ │                │
│ MCP: *inspect*  │ │ MCP: *normal*  │ │ MCP: *cluster* │ │ MCP: *plot*    │
│   *dataset*     │ │   *standard*   │ │   *anomaly*    │ │   *map*        │
│   *raster*      │ │   *pivot*      │ │   *reduce*     │ │   *scatter*    │
│   *missing*     │ │   *filter*     │ │   *aggregate*  │ │   *histogram*  │
│   *select*      │ │   *merge*      │ │   *stat*       │ │   *chart*      │
│   *column*      │ │   *convert*    │ │   *threshold*  │ │   *viz*        │
│   *query*       │ │   +9 more      │ │   *rank*       │ │                │
│   *validate_geo*│ │                │ │                │ │                │
│   *cleaning*    │ │ Tier 2: shell+ │ │ Tier 2: shell+ │ │ Tier 2: shell+ │
│   *verify*      │ │ file write OK  │ │ file write OK  │ │ file write OK  │
│ Tier 2: shell+  │ │                │ │                │ │                │
│ file write OK   │ │                │ │                │ │                │
└────────┬────────┘ └────────┬───────┘ └────────┬───────┘ └────────┬───────┘
         │                   │                   │                  │
         │  If capability_gap (missing package, unsupported op)    │
         └───────────────────┴───────────────────┴──────────────────┘
                                      │
                                      │  CapabilityGapResult
                                      │  (relayed to orchestrator)
                                      ▼
                          ┌──────────────────────┐
                          │ Orchestrator catches  │
                          │ capability_gap, then: │
                          │ dispatch_specialist(  │
                          │   "extended", ...)    │
                          └───────────┬──────────┘
                                      │
                                      ▼
                   ╔══════════════════════════════════════╗
                   ║  LAYER 4 — Extended Capability       ║
                   ║                                      ║
                   ║  Full system access · NO MCP         ║
                   ║  9 tools: execute_command,            ║
                   ║  write/read/replace/list/search,     ║
                   ║  web_search, attempt_completion      ║
                   ║                                      ║
                   ║  Handles:                            ║
                   ║  • pip install <missing_package>     ║
                   ║  • Web research                      ║
                   ║  • Custom script writing             ║
                   ║  • Environment configuration         ║
                   ╚══════════════════════════════════════╝
```

### Data Flow: End-to-End Example

```
User: "Cluster this geochemical dataset and visualize anomalies"
  │
  ▼
Layer 1 (Geology Agent): "This is multi-step → delegate"
  │
  │ activate_specialist("orchestrator")
  ▼
Layer 2 (Orchestrator): Plans workflow
  │
  │ Step 1: dispatch_specialist("dataops", "Load and validate data.csv")
  │         → Child returns: {status: "success", results: {rows: 1200, cols: 15, missing: 2%}}
  │
  │ Step 2: dispatch_specialist("transform", "Normalize numeric columns, compute Au/Cu ratio")
  │         → Child returns: {status: "success", output_path: "results/data_normalized.csv"}
  │
  │ Step 3: dispatch_specialist("analytics", "K-means clustering k=3-7, detect anomalies")
  │         → Child returns: {status: "success", optimal_k: 5, anomaly_count: 23}
  │
  │ Step 4: dispatch_specialist("geoviz", "Scatter plot of clusters, anomaly overlay map")
  │         → Child returns: {status: "success", plots: ["cluster_map.png", "anomaly_overlay.png"]}
  │
  │ activate_specialist("default")  ← Returns to geology agent with summary
  ▼
Layer 1 (Geology Agent): Presents results to user with geological interpretation
```

### Security Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│                    TRUST BOUNDARY                           │
│                                                             │
│  Layer 1 + Layer 2: Same process, same user                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  • Layer 1: Minimal MCP only (check_missing/list/prov)  │  │
│  │    No shell, no file write, no file edit, no inspect    │  │
│  │  • Layer 2: No MCP at all (plans and routes only)     │  │
│  │  • Variant switch = zero-cost, same context            │  │
│  │  • User can see all conversation turns                 │  │
│  └───────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                    PROCESS BOUNDARY                         │
│                                                             │
│  Layer 3: Sandboxed specialists (child processes)           │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  • Filtered MCP tools (glob patterns)                 │  │
│  │  • Prompt-level filtering + execution-time enforcement │  │
│  │  • Tier 1 (Transform): MCP-only, no shell/file write  │  │
│  │  • Tier 2: shell + file write within workspace        │  │
│  │  • Path containment: all paths validated inside        │  │
│  │    WORKSPACE_ROOT (resolve_path with realpath check)   │  │
│  │  • band_math: AST-validated expressions only           │  │
│  │  • 600s timeout per dispatch                           │  │
│  └───────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Extended (child process, full system access)      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  • No MCP (operates outside geological toolset)       │  │
│  │  • Can install packages, write scripts, web search    │  │
│  │  • Only dispatched by orchestrator for capability gaps │  │
│  │  • 600s timeout                                       │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Domain isolation** — each specialist sees only its relevant MCP tools via glob-pattern filtering
2. **Context reset** — child processes start with a clean context window per dispatch
3. **Structured results** — all specialists return `SpecialistResult` JSON, enforced by prompt
4. **Minimal privilege** — Layer 3 specialists have restricted tool access; only Extended gets full system access

---

## 2. Layer 1: User-Facing Geology Agent

**Variant:** `variants/geology/config.ts`
**Matcher:** `(context) => !context.activeSpecialist` — active when no specialist is set (default state)
**ModelFamily:** `GEOLOGY`

### Prompt Structure (5 layers)

1. **System Constitution** — base Cline instructions
2. **Role Declaration** — geological domain expert identity
3. **Strategy** — 5-step planning protocol (assess → hypothesize → plan → execute → validate)
4. **Execution Contract** — rules for tool use, output formatting, error handling
5. **Geological Constraints** — domain-specific rules (from `components/geological_constraints.ts`)

### Tools (12 — read-only, no shell, no file write)

| Tool | Purpose |
|------|---------|
| `read_file` | Read workspace files for context |
| `list_files` | List directory contents |
| `use_mcp_tool` | Call read-only MCP tools (filtered — see below) |
| `access_mcp_resource` | Access MCP resources |
| `get_mcp_tool_docs` | Get MCP tool documentation |
| `ask_followup_question` | Ask user for clarification |
| `attempt_completion` | Present results to user |
| `plan_mode_respond` | Respond in plan mode |
| `todo` | Track task list |
| `generate_explanation` | Explain analysis results |
| `use_skill` | Invoke available skills |
| `activate_specialist` | Delegate to orchestrator |

**Does NOT have:** `execute_command`, `write_to_file`, `apply_patch`, `search_files`, `list_code_definition_names`, `browser_action`, `dispatch_specialist`, `request_capability`.

**MCP access: Minimal hygiene only.** Filtered via `mcpToolFilter`:
- `check_missing` — missing value reports (compact: only columns with nulls)
- `list_files` — list workspace files
- `*summarize_provenance*` — list result artifacts

**Excluded:** `inspect_dataset`, `inspect_specific_columns`, `inspect_raster`, `query_data`, `profile_geochem` — these return large JSON responses that bloat context. Data inspection is delegated to orchestrator → specialists, which write Python scripts and return compact SpecialistResult JSON. Any Tier 2 specialist can inspect data as part of its own workflow — DataOps is not a mandatory gateway. (Invariants L1-1, L1-2, L1-5)

### When It Delegates vs Handles Directly

| Scenario | Action |
|----------|--------|
| Simple question about geology (no data query needed) | Handle directly |
| Read a config or text file | Handle directly |
| Check for missing values in a dataset | Handle directly (check_missing MCP) |
| List files or check result provenance | Handle directly (list_files, summarize_provenance MCP) |
| Inspect a dataset (row count, columns, stats, value distributions) | **Delegate to orchestrator** (specialists write scripts) |
| Any data transformation, analysis, or visualization | **Delegate to orchestrator** |
| Multi-step analysis requiring multiple specialists | **Delegate to orchestrator** |
| Hypothesis-driven investigation | **Delegate to orchestrator** |
| Anything requiring shell or file write | **Delegate to orchestrator** |

Delegation instructions are embedded in the variant prompt (`geology/config.ts`), which tell the agent when to call `activate_specialist("orchestrator")`.

---

## 3. Layer 2: Analysis Orchestrator

**Variant:** `variants/specialists/orchestrator/config.ts`
**Matcher:** `(context) => context.activeSpecialist === SpecialistType.ORCHESTRATOR`
**ModelFamily:** `SPECIALIST_ORCHESTRATOR`

### Activation

Activated via in-process variant switch: `activate_specialist("orchestrator")` sets `TaskState.activeSpecialist = ORCHESTRATOR`. The next API turn loads the orchestrator variant automatically. **Zero additional API cost** — same conversation context, same connection.

### Tools (5 only)

| Tool | Purpose |
|------|---------|
| `read_file` | Read workspace files for context |
| `attempt_completion` | Return final results to user |
| `dispatch_specialist` | Spawn Layer 3/4 child processes |
| `activate_specialist` | Return to Layer 1 (`"default"`) or stay in orchestrator |
| `todo` | Track task list for multi-step workflows |

### MCP Access

**None.** The orchestrator does not execute tools — it plans, routes, and synthesizes.

### Prompt Content

- Specialist routing table: which specialist handles which domain
- Hypothesis tracking instructions (formulate → test → confirm/refute)
- Result synthesis guidelines
- `specialistHistory` context (dispatch log)

### Return to Layer 1

`activate_specialist("default")` → sets `TaskState.activeSpecialist = null` → next turn loads geology variant.

---

## 4. Layer 3: Domain Specialists

Four specialists, each spawned as a **child process** with a clean context window.

| Specialist | Variant Config | MCP Filter Patterns | `execute_command` | `write_to_file` |
|---|---|---|---|---|
| **DataOps** | `specialists/dataops/config.ts` | `*inspect*`, `*dataset*`, `*raster*`, `*missing*`, `*select*`, `*column*`, `*query*`, `*validate_geo*`, `*cleaning_issues*`, `*verify_claims*` | Yes | Yes |
| **Transform** | `specialists/transform/config.ts` | `*normalize*`, `*standardize*`, `*log*`, `*smooth*`, `*gradient*`, `*ratio*`, `*band*`, `*texture*`, `*select_columns*`, `*aggregate*`, `*pivot*`, `*melt*`, `*merge*`, `*filter*`, `*convert*`, `*fix_decimals*`, `*parse_detection*`, `*remove_duplicates*`, `*standardize_terms*` | Yes (Tier 2) | Yes |
| **Analytics** | `specialists/analytics/config.ts` | `*anomaly*`, `*threshold*`, `*rank*`, `*cluster*`, `*reduce*`, `*aggregate*`, `*stat*` | Yes (Tier 2) | Yes |
| **GeoViz** | `specialists/geoviz/config.ts` | `*plot*`, `*map*`, `*scatter*`, `*histogram*`, `*chart*`, `*viz*` | Yes (Tier 2) | Yes |

### Tier Definitions

- **Tier 2 (All Layer 3 specialists):** MCP + shell + file writes. Can run diagnostic commands and write scripts to designated directories (`scripts/<specialist>/`). All output files go to `results/`.

### Specialist Self-Inspection

Any Tier 2 specialist can inspect data as part of its own workflow by writing Python scripts. The orchestrator should NOT dispatch DataOps as a mandatory gateway before every operation. For example:
- **Analytics** needs column distributions before clustering → writes its own inspection script as step 1
- **GeoViz** needs coordinate ranges for map bounds → reads data in its plotting script
- **DataOps** is for dedicated data profiling tasks or the initial data sufficiency check

This follows the subsidiarity principle: the specialist already active is the lowest competent agent for inspection of the data it's about to process. All specialists share `DATA_INTERACTION_RULES` (script-first + result markers) from `shared.ts`, and the output filters in `processOutput()` mechanistically enforce compact output.

### Spawn Mechanism

```
dispatch_specialist("dataops", objective, context)
  → CLINE_SPECIALIST=dataops CLINE_DATA_DIR=<path> CLINE_PARENT_MODEL_ID=<model> CLINE_PARENT_PROVIDER=<provider> cline '<escaped_prompt>' --json -y
```

The child process reads:
- `CLINE_SPECIALIST` env var via `getSpecialistType()` in `utils/cli-detector.ts` — drives variant selection through `VARIANT_CONFIGS` registry
- `CLINE_DATA_DIR` — path to parent's globalStorage for MCP config (`cline_mcp_settings.json`)
- `CLINE_PARENT_MODEL_ID` + `CLINE_PARENT_PROVIDER` — inherits the parent's selected model so specialists use the same LLM as the user chose (e.g., `deepseek/deepseek-v3.2` via OpenRouter). Without these, the child falls back to the default model.

### Shared Tools (All Layer 3)

All four specialists have: `request_capability`, `attempt_completion`, `mcp_use`, `mcp_docs`

### Output Contract

Every specialist **must** return `SpecialistResult` JSON via `attempt_completion`. The prompt fragment `SPECIALIST_RESULT_PROTOCOL` (from `shared.ts`) enforces this.

---

## 5. Layer 4: Extended Capability Agent

**Variant:** `variants/specialists/extended/config.ts`
**Matcher:** `(context) => context.activeSpecialist === SpecialistType.EXTENDED`
**ModelFamily:** `SPECIALIST_EXTENDED`

### Purpose

Handles capability gaps that domain specialists cannot resolve: package installation, web research, custom script development, environment configuration.

### Tools (10 in config — 8 render with current provider)

`execute_command`, `write_to_file`, `read_file`, `replace_in_file`, `list_files`, `list_code_definition_names`, `search_files`, `web_fetch`, `web_search`, `attempt_completion`

> **Provider gate:** `web_fetch` and `web_search` have `contextRequirements: providerId === "cline" && clineWebToolsEnabled`. With the current OpenRouter provider, these two tools do not render in the specialist's prompt. They will activate when the LLM proxy presents as `providerId === "cline"` or the gate is relaxed.

### MCP Access

**None.** Extended operates outside the geological MCP toolset — it's a general-purpose system agent.

### Typical Workflows

1. Install missing Python package (`pip install`)
2. Download reference data (`web_search` + `execute_command`)
3. Write custom transformation script when no MCP tool exists
4. Configure environment for specialist requirements

---

## 6. Communication Protocol

### Variant Switching (Layer 1 ↔ Layer 2)

```
activate_specialist("orchestrator")
  → ActivateSpecialistHandler validates param (only "orchestrator" or "default" accepted)
  → Sets TaskState.activeSpecialist = SpecialistType.ORCHESTRATOR
  → Next API turn: PromptRegistry matches orchestrator variant
  → Same conversation, zero additional cost

activate_specialist("default")
  → Sets TaskState.activeSpecialist = null
  → Next API turn: PromptRegistry matches geology variant (default)
```

**Handler:** `src/core/task/tools/handlers/ActivateSpecialistHandler.ts`

### Child Process Dispatch (Layer 2 → Layers 3/4)

```
dispatch_specialist("dataops", objective, context)
  → DispatchSpecialistHandler validates specialist is dispatchable
  → Generates task_id: "dataops_1738000000000"
  → Records in TaskState.specialistHistory (startedAt)
  → Reads parent model: config.api.getModel().id + stateManager actModeApiProvider
  → Auto-enriches context with CSV column headers (readCsvHeaders)
  → Spawns: CLINE_SPECIALIST=dataops CLINE_DATA_DIR=<path>
            CLINE_PARENT_MODEL_ID=<model> CLINE_PARENT_PROVIDER=<provider>
            cline '<prompt>' --json -y
  → Waits up to 600 seconds (SPECIALIST_TIMEOUT_SECONDS)
  → parseSpecialistOutput() extracts JSON from stdout
  → extractTokenUsage() sums child's API costs from JSON-line output
  → Updates specialistHistory (result, completedAt)
  → Returns formatted result to orchestrator
```

**Handler:** `src/core/task/tools/handlers/DispatchSpecialistHandler.ts`

### Capability Gap Flow (Layer 4 Data Flow)

When a specialist needs something it can't do (missing package, unsupported operation), the flow is:

```
  Layer 3 (Analytics)                Layer 2 (Orchestrator)              Layer 4 (Extended)
  ═══════════════════                ══════════════════════              ══════════════════
         │                                    │                                │
    Tries PCA...                              │                                │
    "scipy not installed"                     │                                │
         │                                    │                                │
    request_capability(                       │                                │
      package: "scipy",                       │                                │
      manager: "pip",                         │                                │
      reason: "PCA needs                      │                                │
       scipy.linalg"                          │                                │
    )                                         │                                │
         │                                    │                                │
    attempt_completion(                       │                                │
      CapabilityGapResult                     │                                │
    )                                         │                                │
         │                                    │                                │
    ┌────┘                                    │                                │
    │ Child process TERMINATES                │                                │
    │ (Layer 3 is now DEAD)                   │                                │
    └─────────────────────────────────────►   │                                │
         Result returned to orchestrator      │                                │
                                              │                                │
                                    Catches type: "capability_gap"             │
                                    Reads: {package: "scipy",                  │
                                            manager: "pip"}                    │
                                              │                                │
                                    dispatch_specialist("extended",             │
                                      "Install scipy via pip.                  │
                                       Verify with: python -c                  │
                                       'import scipy.linalg'")                 │
                                              │                                │
                                              └──────────────────────────────► │
                                                                         Spawns as child
                                                                               │
                                                                         pip install scipy
                                                                         python -c "import
                                                                           scipy.linalg"
                                                                               │
                                                                         attempt_completion(
                                                                           SpecialistResult {
                                                                             status: "success",
                                                                             results: {
                                                                               package: "scipy",
                                                                               verified: true
                                                                         }})
                                                                               │
                                                                         ┌─────┘
                                                                         │ Child TERMINATES
                                              ◄──────────────────────────┘
                                    Result returned to orchestrator
                                              │
                                    Extended succeeded → re-dispatch
                                              │
                                    dispatch_specialist("analytics",
                                      original_objective,
                                      context: "resume: true,
                                        scipy now available")
                                              │
         ◄────────────────────────────────────┘
    NEW child process spawns
    (fresh context, scipy installed)
         │
    Retries PCA with scipy
         │
    attempt_completion(
      SpecialistResult {
        status: "success",
        results: {pca_variance:
         [0.45, 0.28, 0.15]}
    })
         │
    ┌────┘
    │ Child TERMINATES
    └─────────────────────────────────────►   │
                                    Analytics complete, continues
                                    workflow (dispatch geoviz, etc.)
```

**Key points:**
- Layer 4 result **always returns to the Orchestrator (Layer 2)**, never to Layer 3 or Layer 1
- The original Layer 3 child has **already terminated** — it cannot receive the install result
- The Orchestrator spawns a **new** Layer 3 child with `resume: true` context
- Only the Orchestrator has `dispatch_specialist` — no other layer can dispatch

**Handlers:**
- `src/core/task/tools/handlers/RequestCapabilityHandler.ts` — builds `CapabilityGapResult`
- `src/core/task/tools/handlers/DispatchSpecialistHandler.ts` — spawns children, parses results

### Structured Result Protocol

All specialists must return JSON matching the `SpecialistResult` interface:

```typescript
{
  task_id: string                    // e.g. "dataops_1738000000000"
  type: "completion" | "capability_gap"
  status: "success" | "partial" | "error"
  results: Record<string, unknown>   // domain-specific output
  hypothesis_evidence?: {
    supports?: string[]
    contradicts?: string[]
    new_hypotheses?: string[]
  }
  recommendations?: string[]
  errors?: string[]
}
```

Defined in `shared/specialists.ts`. Enforced by `SPECIALIST_RESULT_PROTOCOL` prompt fragment in `shared.ts`.

---

## 7. Per-Layer Success Checklists

What constitutes "done" for each layer. If any check fails, the layer should report an error — never silently succeed.

### Layer 1 — User-Facing Geology Agent

| # | Check | How to verify |
|---|-------|---------------|
| 1 | User's question has been answered OR delegated | `attempt_completion` called with geological interpretation, OR `activate_specialist("orchestrator")` called |
| 2 | If delegated: objective is clear and self-contained | Orchestrator objective includes: what data, what analysis, what output format |
| 3 | If answered directly: response grounded in data | Response cites specific MCP tool results (inspect/check outputs), not LLM hallucination |
| 4 | No silent tool failures | Every MCP call that returned an error was surfaced to the user or used to decide delegation |

**Failure mode:** Layer 1 says "analysis complete" but never actually ran any tools. This happens when the model is overconfident. The read-only tool restriction helps — it physically can't do analysis, so it must delegate.

### Layer 2 — Analysis Orchestrator

| # | Check | How to verify |
|---|-------|---------------|
| 1 | All planned specialists have been dispatched | `specialistHistory` has entries for each planned step |
| 2 | Every dispatch has a parsed result | Each `specialistHistory` entry has `result` field (not undefined) |
| 3 | No dispatch returned `status: "error"` without follow-up | If a specialist failed, orchestrator either retried, dispatched extended, or reported failure explicitly |
| 4 | Capability gaps were resolved | Every `capability_gap` result was followed by an extended dispatch + re-dispatch of the original specialist |
| 5 | Hypotheses have been updated | After each specialist returns, evidence_for/against were considered (prompt-driven, not programmatic) |
| 6 | Summary returned to Layer 1 | `activate_specialist("default")` called with structured findings |

**Failure mode:** Orchestrator dispatches specialists but ignores errors — reports "analysis complete" when half the pipeline failed. The `specialistHistory` component (injected into its prompt) helps it see its own track record.

### Layer 3 — Domain Specialists (DataOps, Transform, Analytics, GeoViz)

| # | Check | How to verify |
|---|-------|---------------|
| 1 | Returned valid `SpecialistResult` JSON | `attempt_completion` result has: `task_id`, `type`, `status`, `results` |
| 2 | `status` accurately reflects outcome | `"success"` only if all requested operations completed. `"partial"` if some succeeded. `"error"` if none worked |
| 3 | MCP tools called were within filter | Runtime enforcement in `UseMcpToolHandler` blocks out-of-scope tools |
| 4 | Output files exist at claimed paths | `results.output_path` points to a real file within `WORKSPACE_ROOT` |
| 5 | If missing capability: reported gap, didn't improvise | `CapabilityGapResult` returned with `package`, `manager`, `reason` — not a raw `pip install` in shell |
| 6 | No path traversal | All file paths resolved via `resolve_path()` containment check |

**Failure mode:** Specialist reports `status: "success"` but output file doesn't exist or is empty. `parseSpecialistOutput()` catches missing structured JSON (returns `status: "error"`), but can't validate file existence — that's the orchestrator's job if needed.

### Layer 4 — Extended Capability Agent

| # | Check | How to verify |
|---|-------|---------------|
| 1 | Requested package/capability is installed | Verification command ran successfully (e.g., `python -c "import scipy"`) |
| 2 | Install verified, not just attempted | `SpecialistResult.results` includes verification evidence, not just "pip install ran" |
| 3 | Returned valid `SpecialistResult` JSON | Same structured output requirement as Layer 3 |
| 4 | If install failed: reported fallback or error | `status: "error"` with `errors[]` explaining what failed, or used `permission_request.fallback` if provided |
| 5 | Environment not polluted | (Future: `environment.yaml` updated with installed package — see invariant L4-3) |

**Failure mode:** Extended says "installed scipy" but the pip command actually failed silently (e.g., wrong version, network error). The prompt instructs verification, but there's no programmatic enforcement.

### Cross-Layer Success Flow

```
Layer 1 success =  (user question answered with grounded data)
                   OR (delegated to orchestrator with clear objective)

Layer 2 success =  (all specialists dispatched)
                 + (all results parsed — no status: "error" unaddressed)
                 + (capability gaps resolved via extended + re-dispatch)
                 + (summary returned to Layer 1 via activate_specialist("default"))

Layer 3 success =  (valid SpecialistResult JSON with status: "success")
                 + (output files exist at claimed paths)
                 + (only used tools within mcpToolFilter)

Layer 4 success =  (requested capability installed and VERIFIED)
                 + (valid SpecialistResult JSON)
```

---

## 8. MCP Integration

### MCP Server

- **46 tools** across 10 categories: hygiene, spatial, transforms, features, anomaly, clustering, visualization, provenance, data cleaning, verification
- **Framework:** FastMCP, SSE transport on port 7654
- **Location:** `geocluster-mcp/` (git submodule in IDE BE)
- **Auto-starts** in container via `entrypoint.sh` → `start_mcp_server()`
- **Config:** `MCP_WORKSPACE_ROOT` env var → `tools/config.py` → `resolve_path()`

### Per-Specialist Tool Filtering

Each variant defines `mcpToolFilter` with `allowedToolPatterns` (glob patterns):

```typescript
// Example: dataops/config.ts
.mcpToolFilter({
  allowedToolPatterns: ["*inspect*", "*dataset*", "*raster*", "*missing*", "*select*", "*column*", "*query*"]
})
```

Applied at prompt render time:

```
Variant config (mcpToolFilter)
  → components/mcp.ts → getMcp()
  → filterMcpServers(servers, filter)
  → globMatch(toolName, pattern)  // case-insensitive, * = .*
  → Only matching tools appear in specialist's prompt
```

### Filtering Details

- `globMatch()` converts `*` to regex `.*`, case-insensitive
- `filterMcpServers()` filters by both server name (`allowedServers`/`blockedServers`) and tool name (`allowedToolPatterns`/`blockedToolPatterns`)
- Servers with zero remaining tools after filtering are removed entirely

### Cline-to-MCP Connection

Baked into Docker image: `local-workspace/.vscode/mcp.json` with `url: "http://localhost:7654/sse"`

---

## 9. State Management

### TaskState Fields

From `src/core/task/TaskState.ts`:

```typescript
activeSpecialist: SpecialistType | null = null

specialistHistory: Array<{
  task_id: string
  specialist: string
  objective: string
  result?: SpecialistResult | CapabilityGapResult
  startedAt: number
  completedAt?: number
}> = []

hypotheses: HypothesisEntry[] = []
```

### HypothesisEntry Interface

```typescript
{
  hypothesis_id: string
  claim: string
  evidence_for: string[]
  evidence_against: string[]
  confidence: number                          // 0.0 – 1.0
  status: "active" | "testing" | "confirmed" | "refuted" | "revised"
  spawned_tasks: string[]
  parent_hypothesis: string | null
}
```

Status transitions: `active → testing → confirmed | refuted | revised`

Hypothesis tracking is **prompt-driven** — the orchestrator prompt instructs the agent to maintain hypotheses, but there's no programmatic enforcement beyond the `HypothesisEntry[]` storage in TaskState.

### Variant Selection Flow

```
TaskState.activeSpecialist
  → SystemPromptContext.activeSpecialist
  → PromptRegistry iterates VARIANT_CONFIGS
     (specialist variants checked first, then geology, then standard model families)
  → First matching variant determines:
     • Available tools
     • MCP filter (which geological tools are visible)
     • Prompt content (role, rules, constraints)
     • Component render order
```

---

## 10. File Map

### Types & Shared Definitions

| File | Purpose |
|------|---------|
| `src/shared/specialists.ts` | `SpecialistType` enum, `SpecialistResult`, `CapabilityGapResult`, `HypothesisEntry`, `McpToolFilter` interfaces |
| `src/shared/prompts.ts` | `ModelFamily` enum (`GEOLOGY`, `SPECIALIST_ORCHESTRATOR`, `SPECIALIST_DATAOPS`, etc.) |
| `src/shared/tools.ts` | `ClineDefaultTool` enum (`ACTIVATE_SPECIALIST`, `DISPATCH_SPECIALIST`, `REQUEST_CAPABILITY`) |

### Runtime State

| File | Purpose |
|------|---------|
| `src/core/task/TaskState.ts` | `activeSpecialist`, `specialistHistory`, `hypotheses` fields |
| `src/utils/cli-detector.ts` | `getSpecialistType()` — reads `CLINE_SPECIALIST` env var for child process identification |

### Tool Definitions (XML specs)

| File | Purpose |
|------|---------|
| `src/core/prompts/system-prompt/tools/activate_specialist.ts` | `activate_specialist` tool XML definition |
| `src/core/prompts/system-prompt/tools/dispatch_specialist.ts` | `dispatch_specialist` tool XML definition |
| `src/core/prompts/system-prompt/tools/request_capability.ts` | `request_capability` tool XML definition |
| `src/core/prompts/system-prompt/tools/init.ts` | Registration into `allToolVariants` |

### Tool Handlers

| File | Purpose |
|------|---------|
| `src/core/task/tools/handlers/ActivateSpecialistHandler.ts` | Layer 1 ↔ 2 variant switching |
| `src/core/task/tools/handlers/DispatchSpecialistHandler.ts` | Layer 2 → 3/4 child process dispatch (10-min timeout) |
| `src/core/task/tools/handlers/RequestCapabilityHandler.ts` | Capability gap signaling (returns JSON for relay) |
| `src/core/task/ToolExecutor.ts` | Handler registration (lines 244–246) |

### Variant Configs

| File | Layer | Purpose |
|------|-------|---------|
| `src/core/prompts/system-prompt/variants/geology/config.ts` | 1 | User-facing geology agent (default) |
| `src/core/prompts/system-prompt/variants/specialists/orchestrator/config.ts` | 2 | Analysis orchestrator |
| `src/core/prompts/system-prompt/variants/specialists/dataops/config.ts` | 3 | Data operations specialist |
| `src/core/prompts/system-prompt/variants/specialists/transform/config.ts` | 3 | Data transformation specialist |
| `src/core/prompts/system-prompt/variants/specialists/analytics/config.ts` | 3 | Statistical analysis specialist |
| `src/core/prompts/system-prompt/variants/specialists/geoviz/config.ts` | 3 | Geological visualization specialist |
| `src/core/prompts/system-prompt/variants/specialists/extended/config.ts` | 4 | Extended capability agent |
| `src/core/prompts/system-prompt/variants/specialists/shared.ts` | 3–4 | Shared prompt fragments (`SPECIALIST_RESULT_PROTOCOL`, `CAPABILITY_GAP_RULES`, `RESUME_RULES`) |
| `src/core/prompts/system-prompt/variants/index.ts` | — | Variant registry (`VARIANT_CONFIGS`, priority ordering) |

### Prompt Components

| File | Purpose |
|------|---------|
| `src/core/prompts/system-prompt/components/mcp.ts` | `getMcp()`, `filterMcpServers()`, `globMatch()` — MCP tool filtering |
| `src/core/prompts/system-prompt/components/geological_constraints.ts` | Geological domain rules injected into Layer 1 |
| `src/core/prompts/system-prompt/components/specialist_history.ts` | Renders dispatch history for orchestrator prompt (Phase 2) |
| `src/core/prompts/system-prompt/components/cli_subagents.ts` | Suppresses generic subagent instructions when specialist is active |
| `src/core/prompts/system-prompt/types.ts` | `PromptVariant` type definition (includes `mcpToolFilter`) |

### MCP Server & Container

| File | Purpose |
|------|---------|
| `geocluster-mcp/main.py` | MCP server entry point (46 tools, SSE on port 7654) |
| `geocluster-mcp/tools/config.py` | Workspace path resolution (`MCP_WORKSPACE_ROOT`) |
| `entrypoint.sh` | Container startup: `start_mcp_server()` at step 6 |
| `local-workspace/.vscode/mcp.json` | Cline MCP connection config (`http://localhost:7654/sse`) |

---

## 11. Anti-Hallucination & Trust Features

### Problem

Geologist testers identified critical trust issues: AI added mineralogy data not in raw files, users couldn't distinguish data-derived facts from AI interpretations, and no automated check verified AI-generated statistics against source data.

### Three-Layer Mitigation

#### 1. Citation Enforcement (Prompt Engineering)

All agent layers enforce a structured citation format via prompt instructions:

```
[source: filename.csv | col: Au_ppm | rows: 12-15]        # row reference
[source: filename.csv | stat: mean(Au_ppm) = 3.42]        # aggregate stat
[source: filename.csv | col: Lithology | value: "Granite"] # categorical
[interpretation]                                            # AI opinion
[assumption: log-normal distribution for Au_ppb]           # stated assumption
```

Enforced in:
- `geological_constraints.ts` — shared "Citation Protocol (MANDATORY)" section
- `shared.ts` — `hypothesis_evidence` examples include `[source: ...]`
- Each specialist config — citation instructions in role prompts
- `orchestrator/config.ts` — "Citation Forwarding" when returning to geology agent
- `geology/config.ts` — preserve citations, prefix own interpretations

#### 2. Visual Differentiation (UI)

Markdown blockquote conventions + remark plugin + CSS distinguish content types visually:

| Content Type | Markdown Convention | Visual Style |
|---|---|---|
| Data-derived fact | `> **Data:** value [source: ...]` | Green left border |
| AI interpretation | `> *Interpretation:* text [interpretation]` | Amber left border |
| Assumption | `> *Assumption:* text [assumption: ...]` | Blue left border, italic |

**Implementation:**
- `remarkContentTypeMarker` remark plugin in `MarkdownBlock.tsx` — tags blockquotes with `data-content-type` attribute
- CSS in `theme.css` — uses VS Code theme variables (`--vscode-testing-iconPassed`, `--vscode-editorWarning-foreground`, `--vscode-textLink-foreground`)
- Follows existing `remarkMarkPotentialFilePaths` pattern (`node.data.hProperties`)

#### 3. Output Validation (Deterministic Fact-Checking)

New `verify_claims` MCP tool (Section J) — purely deterministic, no LLM calls:

```python
verify_claims(
    claims=[
        {"value": 3.42, "column": "Au_ppm", "operation": "mean", "tolerance": 0.01},
        {"value": 1200, "column": "Au_ppm", "operation": "count"},
    ],
    path="/workspace/data/cores.csv"
)
# Returns: {"verified": [...], "failed": [...], "not_found": [...]}
```

**Workflow** (orchestrator-driven):
1. Analytics/transform specialist returns numeric claims
2. Orchestrator dispatches DataOps: "Verify these claims using verify_claims"
3. DataOps calls the MCP tool, returns verification results
4. Orchestrator includes verification status in summary to geology agent
5. Geology agent marks claims as `[verified]` or `[unverified]`

**Verification is mandatory for:** clustering statistics, transform before/after counts, any data-derived numeric values.
**Skipped for:** file listings, model hyperparameters, provenance summaries.

---

## 12. Known Gaps

| Gap | Impact | Status |
|-----|--------|--------|
| Cline CLI not installed in Docker image | **Critical** — `dispatch_specialist` can't spawn children | **Done** (Phase 1, 2026-02-12) — pre-built artifact in `cline-cli/`, COPY'd by Dockerfile |
| `autoApprove` empty in MCP config | **Critical** — headless specialists can't call MCP tools without approval | **Done** (Phase 1, 2026-02-12) |
| MCP server not killed on container shutdown | Medium — orphan process on container stop | **Done** (Phase 1, 2026-02-12) |
| Pre-flight CLI check missing in DispatchSpecialistHandler | Medium — opaque error if CLI binary absent | **Done** (Phase 1, 2026-02-12) |
| No execution-time MCP filter enforcement | Medium — filtering is prompt-level only, no hard block in `UseMcpToolHandler` | **Done** (Phase 2, 2026-02-12) — runtime check in `UseMcpToolHandler` |
| `specialistHistory` not fed back to orchestrator prompt | Medium — orchestrator loses dispatch context on context compression | **Done** (Phase 2, 2026-02-12) — new `SPECIALIST_HISTORY` component |
| `band_math` MCP tool uses `eval()` | Security — restricted sandbox but bypassable | **Done** (Phase 2, 2026-02-12) — AST validation before eval |
| `list_files`/`export_artifact` lack path validation | Security — path traversal possible | **Done** (Phase 2, 2026-02-12) — `resolve_path()` containment |
| `autoApprove` mismatch not detected | Medium — typos cause silent 600s hangs | **Done** (Phase 2, 2026-02-12) — `Logger.warn` on orphaned entries |
| `CLINE_SPECIALIST` invalid values silent | Low — bad env var causes no specialist behavior | **Done** (Phase 2, 2026-02-12) — `console.error` with valid types |
| Hypothesis tracking is prompt-only | Low — no programmatic persistence or validation | By design (for now) |
| No UI for specialist dispatch status | Low — user sees nothing during child process execution | **Done** (Phase 3, 2026-02-13) — `specialist_dispatch` say message with running/completed/error/timeout states |
| `umap-learn` missing from MCP container | Low — UMAP dimensionality reduction fails at runtime | **Done** (Phase 3, 2026-02-13) — added to pyproject.toml with numba>=0.60.0 |
| `WEB_SEARCH` missing from Extended variant | Low — Extended can't search web (also gated by provider) | **Done** (Phase 3, 2026-02-13) — added to config, provider gate documented |
| Legacy `system-prompt-legacy/` dead code | Cosmetic — unreferenced files cause confusion | **Done** (Phase 3, 2026-02-13) — directory deleted |
| Transform specialist missing critical MCP tools | **High** — Transform cannot perform some geochem cleaning via MCP alone. Model falls back to hallucinating `execute_command` which it doesn't have, causing task failure. | **Mitigated** — 6 data cleaning MCP tools added (Phase 4, 2026-03-07). Transform upgraded to Tier 2 with BASH access. Some gaps remain (regex replace, computed columns). |
| False-positive specialist timeout detection | **High** — Parent string-matched child's internal "Command timed out" text, declaring specialist timed out even though child exited normally | **Done** (2026-02-23) — `completed` flag threaded through `executeCommandTool` return tuple; `DispatchSpecialistHandler` now checks `completed === false` instead of string match |
| IDE machine memory too low for matplotlib | Medium — 2GB insufficient for plotting workloads | **Done** (2026-02-23) — bumped to 4096MB in `fly_machines.py` |

---

## Appendix: Gap Resolution Plan

_(For reference — to be executed in a future session)_

**Phase 1 (Critical blockers) — COMPLETED 2026-02-12:**
- ~~Dockerfile: build Cline CLI, add to PATH~~
- ~~`DispatchSpecialistHandler`: pre-flight check for CLI binary~~
- ~~MCP config: populate `autoApprove` with specialist tool patterns~~
- ~~`entrypoint.sh`: add `kill_mcp_server()` on SIGTERM/SIGINT~~

**Phase 2 (Security & reliability) — COMPLETED 2026-02-12:**
- ~~`UseMcpToolHandler`: execution-time MCP filter check against `TaskState.activeSpecialist`~~
- ~~Orchestrator prompt component: inject `specialistHistory` into context~~
- ~~Replace `eval()` in `band_math` with AST validation~~
- ~~Add path validation to `list_files` and `export_artifact` MCP tools~~
- ~~`autoApprove` mismatch validation in McpHub~~
- ~~`CLINE_SPECIALIST` env var validation~~
- ~~Layer 1 regression fix: read-only MCP + remove shell/write tools~~
- ~~Design invariants doc + 93 automated tests~~

**Phase 3 (Quality of life) — COMPLETED 2026-02-13:**
- ~~Add `umap-learn` to `geocluster-mcp/pyproject.toml`~~ (with `numba>=0.60.0` floor, numpy relaxed to `>=2.3.0`)
- ~~Add `WEB_SEARCH` tool to Extended variant~~ (provider gate documented)
- ~~Clean up dead code from pre-specialist architecture~~ (`system-prompt-legacy/` deleted)
- ~~Build specialist dispatch status UI~~ (`specialist_dispatch` say type + ChatRow rendering + DispatchSpecialistHandler integration)

**Phase 4 (Data cleaning & Transform viability) — COMPLETED 2026-03-07:**
- ~~Add 6 data cleaning MCP tools~~ (`validate_geochem`, `detect_cleaning_issues`, `standardize_units`, `handle_detection_limits`, `clean_numeric_columns`, `remove_duplicates`)
- ~~Upgrade Transform to Tier 2~~ (BASH access + all cleaning tool patterns)
- ~~Update `autoApprove` config for new tools~~
- ~~Register new tools in `main.py`~~ (tool count: 39 → 46)
- [ ] Add `replace_values` MCP tool — regex/pattern-based string replacement (nice to have)
- [ ] Add `add_column` MCP tool — create computed column from expression (nice to have)

**Phase 5 (Anti-Hallucination & Trust) — COMPLETED 2026-03-11:**
- ~~Citation enforcement~~ (prompt engineering across all agent layers)
- ~~Visual differentiation~~ (remark plugin + CSS for data/interpretation/assumption blockquotes)
- ~~Output validation~~ (`verify_claims` MCP tool — deterministic fact-checking)
- ~~Model selection fix~~ (child processes inherit parent's model via `CLINE_PARENT_MODEL_ID` + `CLINE_PARENT_PROVIDER` env vars)

---

*Last Updated: 2026-03-11 (Added Section 11: Anti-Hallucination & Trust Features. Updated MCP tool count 39→46. Updated Known Gaps: model selection fix done, data cleaning done, Phase 5 added. Updated spawn mechanism with model inheritance env vars. Updated DataOps filter patterns with `*verify_claims*`.)*
