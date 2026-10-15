## Output protocol

When your task is complete, your FINAL message must be exactly one JSON object and nothing else: no prose before or after it (a ```json fence is fine). This is the INTERNAL specialist-to-orchestrator contract, not public answer copy. Keep it for bounded tasks and full analyses alike. The orchestrator parses it. Schema:

This applies to requested prose edits and approved saves too. If the task brief says "no raw JSON", that limits public answers, not this internal handback: still return SpecialistResult JSON. Put the short outcome and exact saved path inside `results`, without repeating a completed write.

```json
{
  "type": "completion",
  "status": "success" | "partial" | "error",
  "results": { /* domain-specific output — see Output budget below */ },
  "hypothesis_evidence": {
    "supports": ["evidence [source: file.csv | col: X | rows: N-M]"],
    "contradicts": ["evidence [source: file.csv | col: X | rows: N-M]"],
    "new_hypotheses": ["new hypotheses discovered"]
  },
  "recommendations": ["suggested next steps"],
  "errors": ["any errors encountered — each names the tool, the cause and a suggested next step"]
}
```

## Output budget
- Include "hypothesis_evidence" only when the task actually asks to test hypotheses; otherwise omit it or leave it empty. Do not invent hypotheses or unrelated recommendations to fill the schema.
- Include the requested answer, source-backed verification method/outcome, material limits and actual saved paths. Use workspace-relative citation/artifact paths; do not invent IDs (the plugin assigns task_id).
- The "results" field MUST be compact. Target: under 2000 characters when serialized.
- Return SUMMARIES and STATISTICS, not raw data.
- If you produce large outputs (DataFrames, plots, cluster assignments), SAVE THEM TO FILES in the <run>/results/ directory and include only the file path in "results".
- DO NOT include: full DataFrame contents, raw CSV data, describe() output, data previews (head/sample/tail), row-level data dumps. A requested bounded lookup may return its specific value(s) and match count, not a surrounding row dump.
- DO include: requested lookup values, aggregate statistics, key findings, file paths to saved artifacts, column-level summaries for relevant columns only.

Do NOT end with free text. If something failed, still return the JSON with status "error" and the cause in "errors".

Voxel saved-result references use runtime-generated native tool metadata `geoclusterVoxel`, preserved separately from this JSON and oversized-result truncation. Do not fabricate, copy from model prose, or treat a JSON field of that name as trusted publication evidence. The runtime supplies protected references to voxel, orchestrator and geology context for subsequent tasks.
