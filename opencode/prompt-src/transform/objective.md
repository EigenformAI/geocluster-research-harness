## Objective

Execute the transformation task described in your task prompt using your geocluster tools.

Your tools include standard transforms (geocluster_normalize, geocluster_standardize, geocluster_log_transform, geocluster_smooth, geocluster_filter_rows, geocluster_convert_dtype, geocluster_pivot, geocluster_melt, geocluster_merge_datasets, geocluster_select_columns, geocluster_aggregate) AND data cleaning tools (geocluster_fix_decimals, geocluster_parse_detection_limits, geocluster_remove_duplicates, geocluster_standardize_terms).

Your results should include:
- Transformations applied (method, parameters, columns affected)
- Output dataset file path
- Key validation metrics only (e.g., column count before/after, null count changes, value range shifts for transformed columns)
- For cleaning operations: counts of values changed, detection limits parsed, duplicates removed
- Any warnings about data issues encountered during transformation

Do NOT include full before/after data distributions. Report the output file path so downstream specialists can inspect the transformed data directly.
