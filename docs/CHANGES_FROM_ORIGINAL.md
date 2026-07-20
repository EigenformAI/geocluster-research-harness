# Changes From Original Architecture Specification

> Comparison between `geological-agent-architecture.md` (original plan) and the actual implementation in `cline-fork/`.

---

## 1. Structural / Architectural Differences

| Aspect | Original Plan | Implementation | Impact |
|--------|--------------|----------------|--------|
| **Spawning mechanism** | `new_task` (Cline's built-in sub-task tool) | `dispatch_specialist` — custom CLI child process via `cline '<prompt>' --json -y` | **Major.** Original assumed Cline's `new_task` could block-and-return. It can't — so a custom tool was built that spawns a separate CLI process with `CLINE_SPECIALIST` env var. |
| **Layer 1 MCP access** | **No MCP tools.** "Never performs analysis directly." | **Full unfiltered MCP access** (all 30 geological tools) | **Major.** Original spec was strict: Layer 1 only does UI, preflight checks, and spawning. Implementation gave it full MCP so it can handle simple tasks directly without orchestrator overhead. |
| **Layer 1 → Layer 2 transition** | `new_task` spawn with structured JSON objective | `activate_specialist("orchestrator")` — in-process variant switch, same conversation context | **Major.** Original assumed separate processes. Implementation uses same-process variant switching (`TaskState.activeSpecialist`) to avoid context duplication and extra API cost. |
| **Orchestrator tool index** | Carries a lightweight `tool_index.yaml` (~2KB) with tool names + 10-word descriptions | No tool index. Orchestrator has zero MCP access and a hardcoded specialist routing table in its prompt. | **Moderate.** Routes by specialist role name rather than by individual tool lookup. Simpler but less granular routing decisions. |
| **Progress streaming** | Orchestrator → User-Facing Agent via `{ "type": "progress", "stage": "analytics", "percent_complete": 60 }` | **Not implemented.** User sees nothing during child process execution (10-min timeout). | **Moderate UX gap.** Listed as "Deferred" in Known Gaps (Section 10 of architecture doc). |
| **Permission gating for installs** | User-Facing Agent asks user for install approval, relays decision back to orchestrator | `request_capability` → `CapabilityGapResult` relayed via `attempt_completion` → orchestrator auto-dispatches Extended. **No user approval step.** | **Moderate security trade-off.** Original had user-in-the-loop for package installations, implementation auto-routes to Extended agent. |

---

## 2. Tool Allocation Differences

### Layer 1: User-Facing Agent

| | Original Plan | Implementation |
|---|--------------|----------------|
| **Standard tools** | `ask_followup_question`, `attempt_completion`, `execute_command` (presentational), `apply_patch`/`replace_in_file`, `new_task`, `list_files`, `read_file` | `read_file`, `list_files`, `ask_followup_question`, `attempt_completion`, `plan_mode_respond`, `todo`, `generate_explanation`, `use_skill`, `activate_specialist`. **No** `execute_command`, `write_to_file`, or `apply_patch`. |
| **MCP access** | None | **Read-only filtered MCP** — `*inspect*`, `*check*`, `list_files`, `*summarize_provenance*` only. No write/transform/cluster/plot tools. (Invariant L1-1) |
| **Key difference** | Pure UI/delegation agent — never touches data | Can **inspect** data directly (read-only MCP) but cannot transform, analyze, or visualize. All write operations delegate through orchestrator. Closer to original intent than earlier implementation which gave full MCP + shell access. |

### Layer 2: Analysis Orchestrator

| | Original Plan | Implementation |
|---|--------------|----------------|
| **Tools** | `new_task`, `focus_chain`, `read_file`, `attempt_completion` | `read_file`, `attempt_completion`, `dispatch_specialist`, `activate_specialist`, `todo` |
| **Key difference** | `focus_chain` for planning mode | `todo` for task tracking instead; `focus_chain` not implemented |

### Layer 3: Domain Specialists

| Specialist | Original Plan | Implementation |
|-----------|--------------|----------------|
| **DataOps** | `list_files`, `read_file`, `write_to_file`, `access_mcp_resource`, `search_files`, `list_code_definition_names` + 4 MCP tools | `execute_command`, `write_to_file`, `read_file` + filtered MCP (`*inspect*`, `*dataset*`, `*raster*`, `*missing*`, `*select*`, `*column*`) |
| **Transform** | `read_file` + 9 MCP tools, **no execute_command** | Filtered MCP only (`*normalize*`, `*standard*`, `*gradient*`, `*band*`, `*smooth*`, `*ratio*`, `*texture*`), **no read_file, no execute_command** — strictest tier |
| **Analytics** | `read_file`, `execute_command` (diagnostic), `write_to_file` + 6 MCP tools | `execute_command`, `write_to_file`, `read_file` + filtered MCP (`*cluster*`, `*anomaly*`, `*reduce*`, `*aggregate*`, `*stat*`, `*threshold*`, `*rank*`) |
| **GeoViz** | `read_file`, `execute_command`, `write_to_file` + 4 MCP tools | `execute_command`, `write_to_file`, `read_file` + filtered MCP (`*plot*`, `*map*`, `*scatter*`, `*histogram*`, `*chart*`, `*viz*`) |

### Layer 4: Extended Capability

| | Original Plan | Implementation |
|---|--------------|----------------|
| **Tools** | `execute_command`, `write_to_file`, `read_file`, `replace_in_file`, `list_files`, `list_code_definition_names`, `browser_action`, `web_fetch`, `search_files` | `execute_command`, `write_to_file`, `read_file`, `replace_in_file`, `list_files`, `list_code_definition_names`, `search_files`, `web_search`, `attempt_completion` |
| **Key difference** | `browser_action` + `web_fetch` for web research | `web_search` instead (simpler, no browser automation) |
| **MCP access** | None (operates outside geological toolset) | None (same) |

---

## 3. Message Schema Differences

| Aspect | Original Plan | Implementation |
|--------|--------------|----------------|
| **Task spawn format** | Rich structured JSON: `{ task_id, specialist, objective, context: { dataset_path, hypothesis_context, resume, capability_installed, use_fallback }, parameters: {...} }` | Flat tool params: `dispatch_specialist(specialist, objective, context)` — context is a freeform string, not structured JSON |
| **Result format** | `hypothesis_evidence: { supports: true/false, evidence: string }` | `hypothesis_evidence: { supports?: string[], contradicts?: string[], new_hypotheses?: string[] }` — richer array-based structure |
| **Capability gap result** | Includes `estimated_size`, `dependencies` list | Simpler: `package`, `version`, `manager`, `reason`, `fallback` only |
| **Progress stream** | `{ type: "progress", stage, message, percent_complete }` | Not implemented |
| **Final result** | `{ type: "completion", results: { summary, output_files[], hypothesis_chain[], recommendations[] } }` | `SpecialistResult: { task_id, type, status, results: Record<string, unknown>, hypothesis_evidence?, recommendations?, errors? }` |

---

## 4. Features Added (Not in Original Plan)

| Addition | Rationale |
|----------|-----------|
| **`activate_specialist` tool** | Original assumed `new_task` for all spawning. In-process variant switching was invented to avoid spawning a new process for the orchestrator — keeps context, zero API cost. |
| **MCP tool filtering via glob patterns** | Original assigned tools per-specialist in static config files. Implementation uses runtime filtering on the MCP connection layer with `McpToolFilter.allowedToolPatterns`. |
| **`CLINE_SPECIALIST` env var** | Original assumed Cline's `new_task` would pass context natively. CLI child processes need an external signal for variant selection. Read by `getSpecialistType()` in `cli-detector.ts`. |
| **Specialist history tracking** | `TaskState.specialistHistory[]` — tracks dispatch log with task_id, specialist, objective, result, timing. Not in original spec. Added because child process results need persistence across context compression. |
| **Execution-time MCP filter enforcement** | Phase 2 addition. Prompt-level filtering alone doesn't prevent a hallucinating model from calling filtered tools. `UseMcpToolHandler` now validates against the filter at execution time. |
| **AST-validated band_math** | Phase 2 addition. Original didn't address `eval()` security in MCP tools. |
| **Path containment validation** | Phase 2 addition. `resolve_path()` now validates all paths stay within `WORKSPACE_ROOT`. |
| **Tier system (Tier 1/2)** | Original had 3 tiers (read-only / domain scripts / full execution). Implementation collapsed to 2: Tier 1 (MCP-only, no shell — Transform) and Tier 2 (MCP + shell + file write — DataOps, Analytics, GeoViz). |

---

## 5. Features Dropped or Deferred

| Original Feature | Status | Reason |
|-----------------|--------|--------|
| `focus_chain` tool for orchestrator | **Dropped** | Orchestrator uses `todo` tool for planning instead. Focus chain was a Cline-specific feature that didn't map well to the specialist workflow. |
| `tool_index.yaml` (lightweight tool catalog) | **Dropped** | Routing is by specialist role name, not by individual tool lookup. The orchestrator prompt has a hardcoded specialist routing table. |
| `environment.yaml` management | **Dropped** | Extended agent does installs directly via `pip install` without maintaining a manifest file. Simpler but less auditable. |
| `config/specialist_assignments.yaml` | **Dropped** | Tool assignment defined in TypeScript variant configs (`specialists/*/config.ts`), not external YAML. |
| `scripts/analytics/`, `scripts/viz/`, `scripts/custom/` directory structure | **Not enforced** | Scripts go wherever the specialist writes them. No directory enforcement in prompts or tooling. |
| Progress streaming to user | **Deferred** | No UI for specialist dispatch status. Listed in Known Gaps. Would require WebSocket events or polling. |
| User approval for package installs | **Dropped** | Orchestrator auto-dispatches Extended on capability gaps. Trade-off: faster workflow, less user control over what gets installed. |
| `browser_action` for Extended | **Replaced** | `web_search` tool instead. No browser automation — simpler and more reliable. |
| `access_mcp_resource` for DataOps | **Dropped** | MCP resources not used in practice; tool filtering covers the same use case. |
| Structured objective JSON from Layer 1 | **Simplified** | Layer 1 passes natural language to orchestrator via variant switch context, not structured JSON. |

---

## 6. Execution Tier Comparison

### Original (3 Tiers)

| Tier | Agents | Permissions |
|------|--------|-------------|
| 1 — Read-only | All specialists | `execute_command` for diagnostic commands only |
| 2 — Domain scripts | Analytics, GeoViz | Write + execute scripts within `scripts/{domain}/`, output to `results/` |
| 3 — Full execution | Extended Capability | All commands, package installation, write anywhere |

### Implementation (2 Tiers + Extended)

| Tier | Agents | Permissions |
|------|--------|-------------|
| 1 — MCP-only | Transform | Filtered MCP tools only. No shell, no file write. Strictest sandbox. |
| 2 — MCP + shell + write | DataOps, Analytics, GeoViz | Filtered MCP tools + `execute_command` + `write_to_file` + `read_file` |
| Full access | Extended | 9 tools including shell, file ops, web search. No MCP. No directory constraints. |

**Key difference:** Original Tier 1 allowed diagnostic `execute_command` for all specialists. Implementation Tier 1 (Transform) has zero shell access — stricter than originally planned.

---

## 7. Why the Divergences?

### `new_task` → `dispatch_specialist` + `activate_specialist`

Cline's `new_task` does not support blocking execution (spawn child, wait for result, continue). The original plan acknowledged this risk in the Implementation Note (Section on `request_capability`):

> "Cline's `new_task` does not natively block and return. Implement the resume pattern."

The implementation went further: instead of terminate-and-resume for everything, it split into two mechanisms:
- **Variant switching** (zero-cost, same context) for orchestrator activation
- **CLI child process** (separate context, structured JSON output) for specialist dispatch

### Layer 1 got read-only MCP access (not full access)

The original spec said "never performs analysis directly." This was too strict — "What columns are in data.csv?" would require Layer 1 → Orchestrator → DataOps child → parse result → Orchestrator → Layer 1 (four LLM turns for a one-liner).

**Compromise (Phase 2):** Layer 1 has **read-only MCP** (inspect, check, list_files, provenance) and **no shell or file write access**. It can answer inspection questions directly but cannot transform, cluster, plot, or write files. This preserves the original intent (Layer 1 doesn't do analysis) while avoiding the UX overhead for simple inspection queries.

An earlier implementation gave Layer 1 full MCP + all 13 Cline tools, which re-introduced the prompt bloat problem the architecture was designed to prevent. This was corrected in Phase 2 (Invariants L1-1, L1-2, L1-5). See `docs/DESIGN_INVARIANTS.md`.

### No progress streaming

Would require either:
- WebSocket events from child process → parent → webview (complex plumbing)
- Polling on a shared file/state (original plan explicitly rejected this: "Do not implement polling-over-files")

Deferred to Phase 3 as a UX improvement.

---

## 8. What Survived Intact

Despite the implementation adaptations, the core architecture survived:

1. **4-layer hierarchy** — User-Facing → Orchestrator → Specialists → Extended
2. **Domain isolation via MCP filtering** — each specialist sees only relevant tools
3. **Context reset per dispatch** — child processes start with clean context windows
4. **Structured result protocol** — all specialists return `SpecialistResult` JSON
5. **Hypothesis tracking** — orchestrator maintains `HypothesisEntry[]` with evidence chains
6. **Capability gap flow** — specialist signals gap → orchestrator dispatches Extended → re-dispatches specialist with resume context
7. **Minimal privilege for specialists** — Transform is MCP-only, Extended is the only agent with full system access
8. **Specialist roster** — DataOps, Transform, Analytics, GeoViz, Extended (unchanged)

---

*Last Updated: 2026-02-12*
*Source: Comparison of `geological-agent-architecture.md` (v1.0) against `cline-fork/` implementation*
