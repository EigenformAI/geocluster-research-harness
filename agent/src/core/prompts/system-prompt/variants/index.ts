/**
 * Variant Registry - Central hub for all prompt variants
 *
 * This file exports all variant configurations and provides a registry
 * for dynamic loading. Each variant is optimized for specific model families
 * and use cases.
 */

export { config as devstralConfig, type DevstralVariantConfig } from "./devstral/config"
export { config as Gemini3Config, type Gemini3VariantConfig } from "./gemini-3/config"
export { config as genericConfig, type GenericVariantConfig } from "./generic/config"
export { config as geologyConfig, type GeologyVariantConfig } from "./geology/config"
export { config as reportEvalConfig, type ReportEvalVariantConfig } from "./report-eval/config"
export { config as glmConfig, type GLMVariantConfig } from "./glm/config"
export { config as gpt5Config, type GPT5VariantConfig } from "./gpt-5/config"
export { config as hermesConfig, type HermesVariantConfig } from "./hermes/config"
export { config as NativeGPT5Config } from "./native-gpt-5/config"
export { config as NativeGPT51Config } from "./native-gpt-5-1/config"
export { config as nativeNextGenConfig, type NativeNextGenVariantConfig } from "./native-next-gen/config"
export { config as nextGenConfig, type NextGenVariantConfig } from "./next-gen/config"
export { type AnalyticsVariantConfig, config as analyticsConfig } from "./specialists/analytics/config"
export { config as dataopsConfig, type DataopsVariantConfig } from "./specialists/dataops/config"
export { config as extendedConfig, type ExtendedVariantConfig } from "./specialists/extended/config"
export { config as geovizConfig, type GeovizVariantConfig } from "./specialists/geoviz/config"
export { config as orchestratorConfig, type OrchestratorVariantConfig } from "./specialists/orchestrator/config"
export { config as transformConfig, type TransformVariantConfig } from "./specialists/transform/config"
export { config as trinityConfig, type TrinityVariantConfig } from "./trinity/config"
export { config as xsConfig, type XsVariantConfig } from "./xs/config"

import { ModelFamily } from "@/shared/prompts"
import { config as devstralConfig } from "./devstral/config"
import { config as Gemini3Config } from "./gemini-3/config"
import { config as genericConfig } from "./generic/config"
import { config as geologyConfig } from "./geology/config"
import { config as reportEvalConfig } from "./report-eval/config"
import { config as glmConfig } from "./glm/config"
import { config as gpt5Config } from "./gpt-5/config"
import { config as hermesConfig } from "./hermes/config"
import { config as NativeGPT5Config } from "./native-gpt-5/config"
import { config as NativeGPT51Config } from "./native-gpt-5-1/config"
import { config as NativeNextGenVariantConfig } from "./native-next-gen/config"
import { config as nextGenConfig } from "./next-gen/config"
import { config as analyticsConfig } from "./specialists/analytics/config"
import { config as dataopsConfig } from "./specialists/dataops/config"
import { config as extendedConfig } from "./specialists/extended/config"
import { config as geovizConfig } from "./specialists/geoviz/config"
import { config as orchestratorConfig } from "./specialists/orchestrator/config"
import { config as transformConfig } from "./specialists/transform/config"
import { config as trinityConfig } from "./trinity/config"
import { config as xsConfig } from "./xs/config"

/**
 * Variant Registry for dynamic loading
 *
 * This registry allows for loading variant configurations.
 */
export const VARIANT_CONFIGS = {
	/**
	 * Specialist variants — must be checked before geology (more specific matchers).
	 */
	[ModelFamily.SPECIALIST_ORCHESTRATOR]: orchestratorConfig,
	[ModelFamily.SPECIALIST_DATAOPS]: dataopsConfig,
	[ModelFamily.SPECIALIST_TRANSFORM]: transformConfig,
	[ModelFamily.SPECIALIST_ANALYTICS]: analyticsConfig,
	[ModelFamily.SPECIALIST_GEOVIZ]: geovizConfig,
	[ModelFamily.SPECIALIST_EXTENDED]: extendedConfig,
	/**
	 * Report-eval variant - GeoCluster IDE "Report Analysis" mode.
	 * Must be checked BEFORE geology: its matcher is more specific
	 * (agentMode === "report-analysis"), so it has to win first.
	 */
	[ModelFamily.REPORT_EVAL]: reportEvalConfig,
	/**
	 * Geology variant - GeoCluster IDE geological analysis with 5-layer prompt.
	 * Matches when no specialist is active and the user is in geology mode.
	 */
	[ModelFamily.GEOLOGY]: geologyConfig,
	/**
	 * GPT-5 variant with native tool support.
	 */
	[ModelFamily.NATIVE_GPT_5]: NativeGPT5Config,
	/**
	 * GPT-5 variant without native tool support.
	 */
	[ModelFamily.GPT_5]: gpt5Config,
	/**
	 * GPT-5-1 variant with native tool support.
	 */
	[ModelFamily.NATIVE_GPT_5_1]: NativeGPT51Config,
	/**
	 * Gemini 3.0 variant - Optimized for Gemini 3 model with native tool calling
	 */
	[ModelFamily.GEMINI_3]: Gemini3Config,
	/**
	 * Next-gen variant with native tool support.
	 */
	[ModelFamily.NATIVE_NEXT_GEN]: NativeNextGenVariantConfig,
	/**
	 * GLM variant - Optimized for GLM-4.6 model
	 * Configured for advanced agentic coding capabilities
	 */
	[ModelFamily.GLM]: glmConfig,
	/**
	 * Hermes variant - Optimized for Hermes-4 model
	 * Configured for advanced agentic coding capabilities
	 */
	[ModelFamily.HERMES]: hermesConfig,
	/*** Devstral variant - Optimized for DEVSTRAL stealth model family
	 * Configured for vendor specific message
	 */
	[ModelFamily.DEVSTRAL]: devstralConfig,
	/**
	 * Next-gen variant - Advanced models with enhanced capabilities
	 * Includes additional features like feedback loops and web fetching
	 */
	[ModelFamily.NEXT_GEN]: nextGenConfig,
	/**
	 * Trinity variant - Optimized for Trinity models
	 * Tool-use optimizations: explicit ask_followup_question question parameter, anti-looping reminder
	 */
	[ModelFamily.TRINITY]: trinityConfig,
	/**
	 * XS variant - Compact models with limited context windows
	 * Streamlined for efficiency with essential tools only
	 */
	[ModelFamily.XS]: xsConfig,
	/**
	 * Generic variant - Fallback for any model types not specifically covered above.
	 * Optimized for broad compatibility and stable performance.
	 */
	[ModelFamily.GENERIC]: genericConfig,
} as const

/**
 * Type-safe variant identifier
 * Ensures only valid variant IDs can be used throughout the codebase
 */
export type VariantId = keyof typeof VARIANT_CONFIGS

/**
 * Helper function to get all available variant IDs
 */
export function getAvailableVariants(): VariantId[] {
	return Object.keys(VARIANT_CONFIGS) as VariantId[]
}

/**
 * Helper function to check if a variant ID is valid
 */
export function isValidVariantId(id: string): id is VariantId {
	return id in VARIANT_CONFIGS
}

/**
 * Load a variant configuration dynamically
 * @param variantId - The ID of the variant to load
 * @returns Variant configuration
 */
export function loadVariantConfig(variantId: VariantId) {
	return VARIANT_CONFIGS[variantId]
}

/**
 * Load all variant configurations
 * @returns A map of all variant configurations
 */
export function loadAllVariantConfigs() {
	return VARIANT_CONFIGS
}
