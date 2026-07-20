import { SystemPromptSection } from "../templates/placeholders"
import { TemplateEngine } from "../templates/TemplateEngine"
import type { PromptVariant, SystemPromptContext } from "../types"

/**
 * GeoCluster IDE: Layer 4 (Reflection) and geology-specific domain constraints
 *
 * This component enforces geological analysis best practices:
 * - Method explanation when choosing between algorithms
 * - No economic claims without explicit instruction
 * - Provisionality of all outputs
 * - Structured reflection after completing analysis
 */
const GEOLOGICAL_CONSTRAINTS_TEMPLATE = `GEOLOGICAL ANALYSIS CONSTRAINTS

Domain Rules:
- When multiple methods are available (e.g. clustering algorithms, normalization approaches, imputation strategies), briefly explain why one was chosen over the others. This keeps geological judgment visible and auditable.
- Do not make claims about economic viability, mineralization type, or resource potential unless explicitly instructed by the user.
- Treat all analytical outputs as provisional and assumption-dependent. Explicitly state what each result does and does not establish.
- If a dataset characteristic is ambiguous (e.g. whether values represent assay data or calculated ratios), surface the ambiguity explicitly rather than assuming.
- All cluster interpretations are provisional until validated by a domain expert.

Citation Protocol (MANDATORY):
- Every data-derived fact (numeric values, statistics, row counts, distributions) MUST include a source citation: [source: filename | col: column | rows: N-M]
- Aggregate statistics must cite the operation: [source: filename | stat: operation(column) = value]
- Categorical references: [source: filename | col: column | value: "term"]
- If you cannot cite a source file, mark as: [interpretation] or [assumption: reason]
- NEVER present a data value without citing which file and column it came from
- When summarizing specialist results, preserve all [source: ...] citations from their findings

After Completing Analysis:
- Summarize what was achieved and what artifacts were produced.
- Note any assumptions that were critical to the analysis (e.g. "assumed log-normal distribution for Au_ppb").
- Identify follow-up analyses that would be reasonable next steps.
- Explicitly state what this analysis does NOT establish.`

// const GEOLOGICAL_CONSTRAINTS_TEMPLATE = `After completing the plan:

// - Summarize what was achieved and what artifacts were produced.
// - Note any assumptions that were critical to the analysis.
// - Identify follow-up analyses that would be reasonable next steps.
// - Explicitly state what this analysis does NOT establish.`

export async function getGeologicalConstraintsSection(
	variant: PromptVariant,
	context: SystemPromptContext,
): Promise<string | undefined> {
	const template =
		variant.componentOverrides?.[SystemPromptSection.GEOLOGICAL_CONSTRAINTS]?.template || GEOLOGICAL_CONSTRAINTS_TEMPLATE
	return new TemplateEngine().resolve(template, context, {})
}
