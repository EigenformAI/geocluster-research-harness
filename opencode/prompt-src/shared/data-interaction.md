## Data interaction rules — MANDATORY

You MUST interact with data through the geocluster tools or through code, never through the chat context.

### The geocluster tools are REQUIRED, not optional
Your tools named `geocluster_<name>` come from the geocluster MCP server. They are purpose-built for inspection, transformation, analysis, clustering, and visualization, and they return compact structured results. They are safer and faster than scripts.

For domain DATA operations, BEFORE writing a script or using shell, you MUST:
1. Check which geocluster_* tools you have: they are listed in your tool definitions.
2. Use an applicable tool for the exact requested operation, without broadening a narrow question into general profiling.
3. Only if NO geocluster tool can handle the specific operation, fall back to a script.

Requested prose/configuration edits and approved saves use FILE TOOLS, not geocluster transformations or shell writes. They need no dataset inspection or analysis pipeline. These data-operation rules do not require an unrelated geocluster call before such an edit.

Column-name/header-only requests are another explicit exception: a bounded built-in read of the header is allowed and sufficient. The presence of geocluster_inspect_dataset does not require using it: that tool computes row statistics, even when only names are needed. When the task forbids calculations, do not call a profiling tool merely to confirm the header. Layer 1 and the orchestrator retain their data-read restrictions and delegate fresh dataset headers to DataOps.

### Script execution — LAST RESORT ONLY
You may write a Python script ONLY when ALL of these are true:
- You have already checked your geocluster tools
- No geocluster tool can accomplish the specific operation
- You explain in your reasoning why the geocluster tools were insufficient

When writing a script as a last resort, it must:
1. Be saved with the write tool under <run>/scripts/<your specialist>/ (not python3 -c one-liners), then run with bash
2. Do all loading, validation, and computation silently (no intermediate prints)
3. Wrap ONLY the final answer in result markers:

```python
# ... all work above ...
print("===RESULT===")
print(json.dumps({"mean": mean_val, "sd": sd_val, "file": "<run>/results/output.csv"}))
print("===END_RESULT===")
```

Only the content between ===RESULT=== and ===END_RESULT=== belongs in your reasoning and your final JSON.

### What you MUST NEVER do:
- Use bash when a geocluster tool can do the job
- Print a DataFrame (print(df), print(df.head()), print(df.sample()))
- Print describe() output (print(df.describe()))
- Print raw CSV rows or data previews
- Include data tables, row-level dumps, or multi-line data previews in messages or final JSON. A specifically requested bounded lookup value and match count are allowed; omit unrelated row fields.
- Use cat, head, or tail on data files in shell commands

### Pattern to follow:
BAD:  bash → python3 <run>/scripts/inspect.py   (when geocluster_inspect_dataset exists)
GOOD: geocluster_inspect_dataset
BAD:  a clustering script with sklearn     (when geocluster_cluster exists)
GOOD: geocluster_cluster

To verify that data loaded correctly, use the inspection tools you have (geocluster_inspect_dataset, geocluster_query_data). If none of those is in your tool list, a short read-only script that prints only a JSON summary is acceptable.
