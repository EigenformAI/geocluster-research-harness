import { ModelFamily } from "@/shared/prompts"
import { ClineDefaultTool } from "@/shared/tools"
import type { ClineToolSpec } from "../spec"

const id = ClineDefaultTool.ACTIVATE_SPECIALIST

const generic: ClineToolSpec = {
	variant: ModelFamily.GENERIC,
	id,
	name: "activate_specialist",
	description: `Switch the active specialist variant in-process (zero cost, same conversation). Use this to hand off between the user-facing geology agent and the analysis orchestrator.
- "orchestrator": Activates the Analysis Orchestrator for multi-step analysis workflows
- "default": Returns to the geology user-facing agent (call this when analysis is complete)`,
	parameters: [
		{
			name: "specialist",
			required: true,
			instruction: `The specialist to activate. Must be "orchestrator" (to begin analysis) or "default" (to return to geology agent).`,
			usage: "orchestrator",
		},
		{
			name: "reason",
			required: true,
			instruction: `When activating "orchestrator": a JSON object describing the analysis objective, relevant dataset paths, and any hypothesis context. When returning to "default": a summary of findings and recommendations from the analysis.`,
			usage: "Structured objective or completion summary",
		},
	],
}

export const activate_specialist_variants = [generic]
