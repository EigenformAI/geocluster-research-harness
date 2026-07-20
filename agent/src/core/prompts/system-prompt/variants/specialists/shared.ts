/**
 * Shared constants and prompt fragments reused by all specialist variant configs.
 */
import { ClineDefaultTool } from "@/shared/tools"

/**
 * Instructions requiring structured JSON output via attempt_completion.
 * All specialists must follow this protocol.
 */
export const SPECIALIST_RESULT_PROTOCOL = `
## Output Protocol

When your task is complete, you MUST return a structured JSON result via attempt_completion. The result field must contain valid JSON matching this schema:

\`\`\`json
{
  "task_id": "<assigned task id>",
  "type": "completion",
  "status": "success" | "partial" | "error",
  "results": { /* domain-specific output — see Output Budget below */ },
  "hypothesis_evidence": {
    "supports": ["evidence [source: file.csv | col: X | rows: N-M]"],
    "contradicts": ["evidence [source: file.csv | col: X | rows: N-M]"],
    "new_hypotheses": ["new hypotheses discovered"]
  },
  "recommendations": ["suggested next steps"],
  "errors": ["any errors encountered"]
}
\`\`\`

## Output Budget
- The "results" field MUST be compact. Target: under 2000 characters when serialized.
- Return SUMMARIES and STATISTICS, not raw data.
- If you produce large outputs (DataFrames, plots, cluster assignments), SAVE THEM TO FILES in the results/ directory and include only the file path in "results".
- DO NOT include: full DataFrame contents, raw CSV data, describe() output, data previews (head/sample/tail), row-level data dumps. This applies to ALL columns, not just >10.
- DO include: aggregate statistics, key findings, file paths to saved artifacts, column-level summaries for relevant columns only.

Do NOT return free-text. The orchestrator parses your output as JSON.`

/**
 * Instructions for request_capability usage.
 */
export const CAPABILITY_GAP_RULES = `
## Capability Gaps

If you need a Python package, system tool, or library that is not installed, do NOT attempt to install it yourself. Instead, use the request_capability tool to signal the gap. The orchestrator will handle installation via the Extended Capability agent and re-spawn you with the package available.

Only request capabilities that are genuinely needed for the current task.`

/**
 * Instructions for handling resume context.
 */
export const RESUME_RULES = `
## Resume Context

If your task context includes \`"resume": true\`, a previous attempt was interrupted (usually for a capability install). The context will include what was already accomplished. Pick up from where the previous attempt left off — do not restart the entire task.`

/**
 * Rules requiring specialists to interact with data through code, not chat context.
 * All specialists with BASH access (dataops, analytics, geoviz, extended) must include this.
 */
export const DATA_INTERACTION_RULES = `
## Data Interaction Rules — MANDATORY

You MUST interact with data through MCP tools or code, never through the chat context.

### MCP Tools Are REQUIRED — Not Optional
You MUST use MCP tools (via use_mcp_tool) for ALL data operations. Your connected MCP server (geocluster-mcp) provides purpose-built tools for inspection, transformation, analysis, clustering, and visualization. These tools are safer, faster, and produce compact structured results.

**BEFORE writing ANY script or using execute_command/BASH, you MUST:**
1. Check what MCP tools are available (use list_mcp_tools if needed)
2. Attempt to accomplish the task using MCP tools
3. Only if NO MCP tool can handle the specific operation, fall back to a script

**If you skip MCP tools and go straight to BASH/scripts, your output will be rejected.**

### Script Execution — LAST RESORT ONLY
You may write a Python script ONLY when ALL of these are true:
- You have already checked available MCP tools
- No MCP tool can accomplish the specific operation
- You explain in your reasoning why MCP tools were insufficient

When writing a script as a last resort, it must:
1. Be saved to your scripts/ directory (not python3 -c one-liners)
2. Do all loading, validation, and computation silently (no intermediate prints)
3. Wrap ONLY the final answer in result markers:

\`\`\`python
# ... all work above ...
print("===RESULT===")
print(json.dumps({"mean": mean_val, "sd": sd_val, "file": "results/output.csv"}))
print("===END_RESULT===")
\`\`\`

Everything outside the result markers is stripped from context. Only the content between ===RESULT=== and ===END_RESULT=== reaches the conversation.

### What you MUST NEVER do:
- Use BASH/execute_command when an MCP tool can do the job
- Print a DataFrame (print(df), print(df.head()), print(df.sample()))
- Print describe() output (print(df.describe()))
- Print raw CSV rows or data previews
- Include data tables, row-level data, or multi-line data dumps in your chat messages or attempt_completion results
- Use cat, head, or tail on data files in shell commands

### Pattern to follow:
BAD:  execute_command: python3 scripts/inspect.py (when inspect_dataset MCP tool exists)
GOOD: use_mcp_tool: geocluster-mcp → inspect_dataset
BAD:  Write a clustering script with sklearn (when cluster MCP tool exists)
GOOD: use_mcp_tool: geocluster-mcp → cluster

If you need to verify data loaded correctly, use the inspect_dataset or query_data MCP tool.`

/**
 * @deprecated 2026-04-13 — replaced by dispatch-driven gating in DispatchSpecialistHandler.
 *
 * Specialists no longer call training lifecycle tools themselves; the parent
 * extension brackets each dispatch via mcpHub.callTool from
 * DispatchSpecialistHandler.callTrainingTool(). This constant is retained
 * for documentation purposes only and is not injected into any prompt.
 *
 * Empirical reason for the pivot: across two real IDE runs (one with the
 * prior model, one with Sonnet 4.5), no specialist ever called
 * start_training_session despite the MANDATORY directive in this prompt.
 * LLM-driven bookkeeping is unreliable; deterministic injection is the fix.
 */
export const TRAINING_LIFECYCLE_PROTOCOL = `
## Training Data Capture Lifecycle — MANDATORY

Bracket your analysis with four MCP tool calls so the MCP server can record this session for future model training. The server auto-captures your intermediate tool calls; you only drive the lifecycle.

### Sequence
1. **BEFORE any analysis tool call**, invoke \`start_training_session\` with:
   - \`question\`: the task objective as given to you (verbatim if possible)
   - \`specialist_type\`: your specialist name (e.g. "analytics", "dataops", "transform", "geoviz")
   Save the returned \`session_id\`.

2. **Run your analysis normally.** Every MCP tool you call is recorded automatically — do not manually log anything.

3. **AFTER your last analysis tool call, and BEFORE \`attempt_completion\`**, invoke in order:
   - \`generate_hypotheses\` with the saved \`session_id\`
   - \`evaluate_hypotheses\` with the saved \`session_id\`
   - \`end_training_session\` with the saved \`session_id\` and \`save: true\`

### Fail-soft rules
- If \`start_training_session\` returns \`{"status": "disabled"}\`, skip the remaining lifecycle calls entirely and proceed with your task normally.
- If any of the 4 lifecycle calls return an error, log it in your \`errors\` field but **still complete your primary task** and return a normal \`attempt_completion\`. Training capture is opportunistic, not required.
- If \`end_training_session\` was already called, do not retry — the session is finalized.

### What NOT to do
- Do NOT call \`record_tool_call\` manually — the MCP server handles capture automatically.
- Do NOT skip \`end_training_session\` even if earlier steps errored — it cleans up session state.
- Do NOT put training status in your \`results\` field; it belongs to the MCP server, not your output.`

/**
 * MCP tool grouping — tools that access MCP servers.
 */
export const SPECIALIST_MCP_TOOLS: ClineDefaultTool[] = [
	ClineDefaultTool.MCP_USE,
	ClineDefaultTool.MCP_ACCESS,
	ClineDefaultTool.MCP_DOCS,
]
