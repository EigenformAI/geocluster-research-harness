import { ModelFamily } from "@/shared/prompts"
import { ClineDefaultTool } from "@/shared/tools"
import type { ClineToolSpec } from "../spec"

const id = ClineDefaultTool.DISPATCH_SPECIALIST

const generic: ClineToolSpec = {
	variant: ModelFamily.GENERIC,
	id,
	name: "dispatch_specialist",
	description: `Spawn a specialist agent as a child process to perform a focused task. The specialist runs with its own filtered toolset and MCP access, executes the objective, and returns structured JSON results.

Available specialists: dataops, transform, analytics, geoviz, extended

The child process will run autonomously and return a SpecialistResult or CapabilityGapResult JSON via attempt_completion.`,
	parameters: [
		{
			name: "specialist",
			required: true,
			instruction: `The specialist type to spawn. One of: "dataops", "transform", "analytics", "geoviz", "extended".`,
			usage: "dataops",
		},
		{
			name: "objective",
			required: true,
			instruction: `What the specialist should accomplish. Be specific about input data paths, expected outputs, and any constraints.`,
			usage: "Inspect dataset at data/cores.csv, report missing values and column types",
		},
		{
			name: "context",
			required: false,
			instruction: `Optional JSON context object with additional information for the specialist. May include: dataset_path, hypothesis_context (current hypotheses being tested), parameters (domain-specific settings), resume (boolean, true if re-running after capability install), capability_installed (package that was just installed), use_fallback (boolean, use alternative approach).`,
			usage: '{"dataset_path": "data/cores.csv", "hypothesis_context": "Testing for lithological clustering"}',
		},
	],
}

export const dispatch_specialist_variants = [generic]
