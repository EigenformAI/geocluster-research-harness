/**
 * Mining-evals question bank — the "table" the Report Analysis mode runs through.
 *
 * Transcribed verbatim from Mining-evals.xlsx (8 project stages × 4 question
 * categories). The Report Analysis flow classifies a report's stage, then feeds
 * that stage's questions, one at a time, to the report-eval agent variant.
 *
 * `needsWebSearch: true` marks questions the source sheet flagged as likely
 * needing live external data (commodity prices, jurisdiction/legal, analogues).
 * Web search isn't wired into the agent yet (follow-on) — the flag lets the
 * driver warn or skip, and lets the agent state the limitation explicitly.
 */

export type EvalCategory = "geological" | "data" | "engineering" | "economic"

export interface EvalQuestion {
	q: string
	category: EvalCategory
	needsWebSearch?: boolean
}

/** Canonical project stages, in lifecycle order. */
export const STAGE_IDS = [
	"regional_target_generation",
	"early_exploration",
	"discovery",
	"resource_definition",
	"scoping_pea",
	"pre_feasibility",
	"bankable_feasibility",
	"operating_mine",
] as const

export type StageId = (typeof STAGE_IDS)[number]

/** Human-readable stage labels (match the Mining-evals.xlsx "Project Stage" column). */
export const STAGE_LABELS: Record<StageId, string> = {
	regional_target_generation: "Regional Target Generation",
	early_exploration: "Early Exploration",
	discovery: "Discovery",
	resource_definition: "Resource Definition",
	scoping_pea: "Scoping / PEA",
	pre_feasibility: "Pre-Feasibility",
	bankable_feasibility: "Bankable Feasibility",
	operating_mine: "Operating Mine",
}

/**
 * Best-effort map from the upstream geo-report-pipeline's coarse stage buckets
 * (analysis/metrics/_stage.json: resource | target | early | desktop) to a
 * starting point in the 8-stage taxonomy. Used to SEED the classifier; the
 * agent/user can refine. (target ≈ regional/early; desktop ≈ regional.)
 */
export const PIPELINE_STAGE_SEED: Record<string, StageId> = {
	desktop: "regional_target_generation",
	target: "early_exploration",
	early: "early_exploration",
	resource: "resource_definition",
}

export const QUESTION_BANK: Record<StageId, EvalQuestion[]> = {
	regional_target_generation: [
		{ category: "geological", q: "Is the proposed deposit model in this report plausible? Find a way to evaluate given the data available." },
		{ category: "geological", q: "Are there known analogues to the deposit described here?", needsWebSearch: true },
		{ category: "data", q: "Is the regional mapping in this report reliable?" },
		{ category: "data", q: "Are datasets provided in this report complete or are there obvious gaps (i.e. information you would expect a responsible miner to provide that is not present)?" },
		{ category: "engineering", q: "How easy is access to the deposit described in this report? Are there fatal environmental or political constraints?" },
		{ category: "economic", q: "Does the deposit seem economically viable given the information you have and knowledge on current commodity prices?", needsWebSearch: true },
		{ category: "economic", q: "Are there legal/jurisdictional risks relating to the deposit described here? (Native title, civil or international conflicts, rule of law issues etc.)", needsWebSearch: true },
	],
	early_exploration: [
		{ category: "geological", q: "Do the geology, structure and alteration described in this report support the exploration model?" },
		{ category: "geological", q: "Are geochemical and geophysical anomalies described here coherent?" },
		{ category: "data", q: "Does this report describe sample collection? Was it conducted properly?" },
		{ category: "data", q: "Are the anomalies described in this report statistically significant? Could sampling bias explain them?" },
		{ category: "engineering", q: "Can meaningful drilling actually test the deposit hypothesis described in this report?" },
		{ category: "economic", q: "Does this report contain enough evidence to justify another exploration campaign? Focus on data rather than textual claims." },
	],
	discovery: [
		{ category: "geological", q: "Has drilling confirmed the geological model proposed by the authors of this report?" },
		{ category: "geological", q: "Is the mineralisation described in this report continuous? Are high grades isolated or systematic?" },
		{ category: "data", q: "Are the assays described in this report trustworthy? (Does QA/QC pass and was it done in a reasonable way? Are true widths understood?)" },
		{ category: "engineering", q: "Does the geometry described in this report suggest an ultimately mineable body?" },
		{ category: "economic", q: "Does this discovery justify further drilling expenditure given current economic trends?", needsWebSearch: true },
	],
	resource_definition: [
		{ category: "geological", q: "Are geological domains reasonably defined here?" },
		{ category: "geological", q: "Does the resource as described in this report honour geological boundaries?" },
		{ category: "data", q: "Are drill spacing and variography in this report sufficient to draw conclusions?" },
		{ category: "data", q: "Are density measurements in this report representative?" },
		{ category: "data", q: "Is the classification scheme used in this report justified?" },
		{ category: "engineering", q: "Is the geometry described in this report compatible with realistic mining methods?" },
		{ category: "economic", q: "Is there enough confidence in the resource defined here to support the resource valuation?", needsWebSearch: true },
	],
	scoping_pea: [
		{ category: "geological", q: "What geological uncertainties remain given the data in this report? I.e. what is not covered by the numeric data collected here." },
		{ category: "data", q: "Which assumptions dominate uncertainty in this report? Which data still need improving?" },
		{ category: "engineering", q: "Can metallurgy reasonably achieve the projected recoveries in this report?" },
		{ category: "engineering", q: "Are the infrastructure assumptions in this report reasonable?" },
		{ category: "economic", q: "Does the project generate positive cash flow under realistic assumptions? How sensitive is it to commodity prices and costs?", needsWebSearch: true },
	],
	pre_feasibility: [
		{ category: "geological", q: "Does this report show that major geological risks have been accounted for/retired?" },
		{ category: "data", q: "Does this report quantify all remaining uncertainties?" },
		{ category: "engineering", q: "Are the proposed mine design, processing and scheduling in this report technically robust?" },
		{ category: "engineering", q: "Does this report address geotechnical and hydrogeological risks?" },
		{ category: "economic", q: "Is capital cost described in this report credible?", needsWebSearch: true },
		{ category: "economic", q: "Are operating costs benchmarked in this report?" },
		{ category: "economic", q: "Under which downside scenarios does this project remain profitable?" },
	],
	bankable_feasibility: [
		{ category: "geological", q: "Is the geological model described in this report stable enough for financing?" },
		{ category: "data", q: "Are reserve estimates in this report auditable and reproducible? If not, why not?" },
		{ category: "engineering", q: "Is every engineering component of this project sufficiently designed for construction? What (if anything) remains to be done?" },
		{ category: "engineering", q: "Have permitting and tailings for this project been resolved?" },
		{ category: "economic", q: "Will lenders finance this?", needsWebSearch: true },
		{ category: "economic", q: "Can the project described in this report be expected to produce acceptable returns after contingencies? Focus on quantitative data rather than text claims.", needsWebSearch: true },
	],
	operating_mine: [
		{ category: "geological", q: "Does production described in this report match the geological model?" },
		{ category: "geological", q: "Does this report describe new structures or domains emerging? If so, what and where? What are the implications?" },
		{ category: "data", q: "Are grade control models in this report accurate? Is reconciliation within expectations?" },
		{ category: "engineering", q: "Are recoveries and mining performance described in this report matching design assumptions?" },
		{ category: "economic", q: "Is the mine meeting described in this report matching production guidance? Where are value leaks occurring?" },
	],
}

/** All questions for a stage, in sheet order. */
export function questionsForStage(stage: StageId): EvalQuestion[] {
	return QUESTION_BANK[stage]
}
