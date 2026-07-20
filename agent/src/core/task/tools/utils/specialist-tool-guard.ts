/**
 * Execution-time tool guard for specialist agents.
 *
 * Enforces design invariant L3-3: specialists can only execute tools
 * listed in their variant config's .tools() set. This prevents hallucinated
 * tool calls (e.g., transform calling execute_command) from being executed.
 *
 * The variant .tools() list already controls what appears in the system prompt,
 * but without execution-time enforcement, a model that hallucinates a tool name
 * can still trigger it. This guard closes that gap.
 */

import { VARIANT_CONFIGS } from "@core/prompts/system-prompt/variants"
import { SPECIALIST_TO_MODEL_FAMILY, type SpecialistType } from "@shared/specialists"
import { Logger } from "@/shared/services/Logger"

/**
 * Returns the Set of allowed tool names for a given specialist type,
 * or null if no restriction applies (unknown specialist).
 *
 * ClineDefaultTool enum values ARE the XML tool names
 * (e.g., BASH = "execute_command"), so no mapping is needed.
 */
export function getSpecialistAllowedTools(specialist: string): Set<string> | null {
	const family = SPECIALIST_TO_MODEL_FAMILY[specialist as SpecialistType]
	if (!family) {
		Logger.warn(`[specialist-tool-guard] No model family mapping for specialist "${specialist}" — not enforcing tool guard`)
		return null
	}

	const variantConfig = (VARIANT_CONFIGS as Record<string, (typeof VARIANT_CONFIGS)[keyof typeof VARIANT_CONFIGS]>)[family]
	if (!variantConfig) {
		Logger.warn(`[specialist-tool-guard] No variant config for family "${family}" — not enforcing tool guard`)
		return null
	}

	const tools = (variantConfig as any).tools
	if (!Array.isArray(tools)) {
		Logger.warn(
			`[specialist-tool-guard] No tools array in variant config for specialist "${specialist}" — not enforcing tool guard`,
		)
		return null
	}

	return new Set(tools as string[])
}
