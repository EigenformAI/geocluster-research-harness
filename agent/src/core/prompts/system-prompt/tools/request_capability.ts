import { ModelFamily } from "@/shared/prompts"
import { ClineDefaultTool } from "@/shared/tools"
import type { ClineToolSpec } from "../spec"

const id = ClineDefaultTool.REQUEST_CAPABILITY

const generic: ClineToolSpec = {
	variant: ModelFamily.GENERIC,
	id,
	name: "request_capability",
	description: `Signal that a required package or tool is missing. This returns a capability_gap result that you must relay back to the orchestrator via attempt_completion. The orchestrator will handle the installation through the Extended Capability agent and re-spawn you with the package available.

Do NOT attempt to install packages yourself. Use this tool instead.`,
	parameters: [
		{
			name: "package",
			required: true,
			instruction: `The name of the missing package (e.g., "scikit-learn", "rasterio", "folium").`,
			usage: "scikit-learn",
		},
		{
			name: "reason",
			required: true,
			instruction: `Why this package is needed for the current task.`,
			usage: "Required for K-means clustering of geochemical data",
		},
		{
			name: "version",
			required: false,
			instruction: `Version constraint (e.g., ">=1.2.0", "==2.1.3"). Omit for latest.`,
			usage: ">=1.2.0",
		},
		{
			name: "manager",
			required: false,
			instruction: `Package manager to use: "pip" (default), "apt", or "conda".`,
			usage: "pip",
		},
		{
			name: "fallback",
			required: false,
			instruction: `Alternative approach if the package cannot be installed (e.g., "use numpy for basic clustering instead of scikit-learn").`,
			usage: "Use scipy.cluster.hierarchy as fallback",
		},
	],
}

export const request_capability_variants = [generic]
