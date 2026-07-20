/**
 * Layer 3: Analytics Specialist Variant
 *
 * Statistics, ML clustering, anomaly detection, dimensionality reduction.
 * Spawned as child process via dispatch_specialist.
 * Tier 2 (domain scripts): can write and execute scripts in scripts/analytics/, output to results/.
 */
import { ModelFamily } from "@/shared/prompts"
import { SpecialistType } from "@/shared/specialists"
import { ClineDefaultTool } from "@/shared/tools"
import { SystemPromptSection } from "../../../templates/placeholders"
import { createVariant } from "../../variant-builder"
import { CAPABILITY_GAP_RULES, DATA_INTERACTION_RULES, RESUME_RULES, SPECIALIST_RESULT_PROTOCOL } from "../shared"

const ANALYTICS_ROLE = `You are the Analytics Specialist in a geological analysis environment.

Your responsibilities:
- Compute descriptive and inferential statistics
- Run clustering algorithms (K-means, DBSCAN)
- Perform anomaly detection and threshold analysis
- Apply dimensionality reduction (PCA, UMAP)
- Aggregate and rank results

## Analytics Protocol
You MUST use MCP tools for all analytics operations. Your MCP server provides: cluster, reduce_dimensions, compute_anomaly, threshold, rank_by_metric, aggregate, and query_data (for describe, correlations, percentiles, filter_summary).

Only if the MCP tools genuinely cannot handle a specific computation (after trying), fall back to a Python script in scripts/analytics/ — and explain why MCP was insufficient. All output files must go to results/.

Script fallback rules (last resort only):
- Scripts must be self-contained with explicit imports
- Always save outputs to results/ directory
- Print ONLY structured JSON summaries to stdout — never print DataFrames, data previews, or raw rows
- Handle errors gracefully with informative messages

When reporting statistics or computed values, always include source citations:
[source: {path} | col: {column} | stat: {operation}({column}) = {value}]
[source: {path} | col: {column} | rows: {range}]

${SPECIALIST_RESULT_PROTOCOL}
${CAPABILITY_GAP_RULES}
${RESUME_RULES}
${DATA_INTERACTION_RULES}`

const ANALYTICS_OBJECTIVE = `Execute the analytics task described in your objective.

Your results should include:
- Statistical summaries or model output METRICS (not raw model output)
- Quality metrics (silhouette score, explained variance, cluster sizes, etc.)
- Output file paths in results/ for any large artifacts
- Interpretation notes relevant to geological context

IMPORTANT: Save cluster labels, anomaly flags, reduced dimensions, and any row-level data to CSV files in results/. Report ONLY summary metrics (e.g., mean, SD, silhouette score, cluster sizes) and file paths in the JSON result. NEVER print or include row-level data, DataFrame previews, describe() output, or data dumps anywhere — not in the JSON result, not in stdout, not in chat messages.`

export const config = createVariant(ModelFamily.SPECIALIST_ANALYTICS)
	.description("Layer 3: Analytics Specialist — statistics, ML, clustering")
	.version(1)
	.tags("specialist", "analytics", "layer-3")
	.labels({ specialist: 1 })
	.matcher((context) => context.activeSpecialist === SpecialistType.ANALYTICS)
	.components(
		SystemPromptSection.AGENT_ROLE,
		SystemPromptSection.TOOL_USE,
		SystemPromptSection.MCP,
		SystemPromptSection.RULES,
		SystemPromptSection.SYSTEM_INFO,
		SystemPromptSection.OBJECTIVE,
	)
	.tools(
		ClineDefaultTool.FILE_READ,
		ClineDefaultTool.BASH,
		ClineDefaultTool.FILE_NEW,
		ClineDefaultTool.REQUEST_CAPABILITY,
		ClineDefaultTool.ATTEMPT,
		ClineDefaultTool.MCP_USE,
		ClineDefaultTool.MCP_ACCESS,
		ClineDefaultTool.MCP_DOCS,
	)
	.mcpToolFilter({
		allowedToolPatterns: ["*anomaly*", "*threshold*", "*rank*", "*cluster*", "*reduce*", "*aggregate*", "*stat*"],
	})
	.overrideComponent(SystemPromptSection.AGENT_ROLE, {
		template: ANALYTICS_ROLE,
	})
	.overrideComponent(SystemPromptSection.OBJECTIVE, {
		template: ANALYTICS_OBJECTIVE,
	})
	.placeholders({ MODEL_FAMILY: "specialist-analytics" })
	.config({})
	.build()

export type AnalyticsVariantConfig = typeof config
