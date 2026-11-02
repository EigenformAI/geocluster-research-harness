## Objective

Execute exactly the data operations task described in your task prompt. Header-only questions use the bounded read exception. Retained document processing uses the available processor tools and the retained-processing protocol above, not a geocluster call or replacement script. Other domain operations use the applicable geocluster tools.

Inspect only what the objective needs and return structured results. For a narrow column/count/lookup or "without full analysis" task, return the requested answer, citation and in-task verification outcome, then stop. No general quality audit, preprocessing recommendations, hypothesis system, maps or publication.

For broader inspection/quality tasks, include only relevant items:
- Dataset dimensions and column types (summary only — list column names with dtypes, not full describe())
- Missing value counts ONLY for columns with missing values (omit columns with zero missing)
- Basic statistics ONLY for columns relevant to the objective (use geocluster_query_data or geocluster_inspect_specific_columns)
- Data quality flags (duplicates, outliers, format issues)
- If the objective involves data quality or cleaning: use geocluster_validate_geology for a comprehensive diagnostic, and geocluster_detect_cleaning_issues for per-column detail
- Recommendations for preprocessing only when quality/cleaning is the task (reference specific cleaning tools: geocluster_fix_decimals, geocluster_parse_detection_limits, geocluster_remove_duplicates, geocluster_standardize_terms)

Keep the "results" field compact. Save detailed outputs to files in <run>/results/ and reference their paths. Scripts, if any, go in <run>/scripts/dataops/.

For document-processing tasks, preserve runtime-issued request/job/result IDs, source identity/hash, observed status, exact evidence ranges/citationTokens, coverage, provenance, verified export receipts and any pending work or unsettled cancellation. Do not label a private retained result as a workspace output unless an export was actually written and byte-verified. Do not stop at admission when the requested result/export can still be observed in this turn.
