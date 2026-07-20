/**
 * Utility to look up a specialist's MCP tool filter from variant configs.
 * Used by UseMcpToolHandler to enforce filtering at execution time (invariant L3-2).
 */

import { VARIANT_CONFIGS } from "@core/prompts/system-prompt/variants"
import type { McpToolFilter } from "@shared/specialists"
import { SPECIALIST_TO_MODEL_FAMILY, type SpecialistType } from "@shared/specialists"
import { Logger } from "@/shared/services/Logger"

/** Deny-all filter: empty allowedToolPatterns means nothing matches. */
const DENY_ALL_FILTER: McpToolFilter = { allowedToolPatterns: [] }

/**
 * Returns the McpToolFilter for a given specialist type, or undefined if none.
 * - Returns undefined for null (no specialist active — geology agent, filter applied at prompt level)
 * - Returns the filter for domain specialists (dataops, transform, analytics, geoviz)
 * - Returns deny-all for specialists with no mcpToolFilter in their variant config
 *   (e.g., orchestrator/extended — they should have zero MCP access)
 */
export function getSpecialistMcpFilter(specialist: SpecialistType | null): McpToolFilter | undefined {
	if (!specialist) return undefined

	const family = SPECIALIST_TO_MODEL_FAMILY[specialist]
	if (!family) {
		Logger.warn(`[specialist-filter] No model family mapping for specialist "${specialist}" — returning deny-all filter`)
		return DENY_ALL_FILTER
	}

	const variantConfig = (VARIANT_CONFIGS as Record<string, (typeof VARIANT_CONFIGS)[keyof typeof VARIANT_CONFIGS]>)[family]
	if (!variantConfig) {
		Logger.warn(
			`[specialist-filter] No variant config for family "${family}" (specialist "${specialist}") — returning deny-all filter`,
		)
		return DENY_ALL_FILTER
	}

	const filter = variantConfig.mcpToolFilter
	if (!filter) {
		Logger.warn(
			`[specialist-filter] No mcpToolFilter in variant config for specialist "${specialist}" (family "${family}") — returning deny-all filter`,
		)
		return DENY_ALL_FILTER
	}

	return filter
}
