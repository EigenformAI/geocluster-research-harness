## Objective

Execute the analytics task described in your task prompt.

Your results should include:
- Statistical summaries or model output METRICS (not raw model output)
- Quality metrics (silhouette score, explained variance, cluster sizes, etc.)
- Output file paths in <run>/results/ for any large artifacts
- Interpretation notes relevant to geological context

IMPORTANT: Save cluster labels, anomaly flags, reduced dimensions, and any row-level data to CSV files in <run>/results/. Report ONLY summary metrics (e.g., mean, SD, silhouette score, cluster sizes) and file paths in the JSON result. NEVER print or include row-level data, DataFrame previews, describe() output, or data dumps anywhere — not in the JSON result, not in stdout, not in your messages.
