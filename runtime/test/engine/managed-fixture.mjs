/** Scripted supplier declarations, not an application model inventory or entitlement policy. */
export const TEST_MANAGED_CATALOG = {
	discovery_schema_version: 2,
	default_model_id: "openai/gpt-6-luna",
	managed_models: Object.fromEntries([
		["openai/gpt-6-luna", 1050000, 32000, ["none", "low", "medium", "high", "xhigh", "max"]],
		["z-ai/glm-5.3-flash", 200000, 16384, ["low", "high", "max"]],
		["google/gemini-3.8-flash", 1000000, 32000, ["low", "medium", "high"]],
		["deepseek/deepseek-v4.1-flash", 1000000, 16384, ["low", "high", "max"]],
		["openai/gpt-6.1-sol", 1050000, 32000, ["low", "medium", "high", "xhigh", "max"]],
		["anthropic/claude-haiku-5.5", 1000000, 32000, ["low", "medium", "high", "xhigh", "max"]],
		["anthropic/claude-opus-5.5", 1000000, 32000, ["low", "medium", "high", "xhigh", "max"]],
		["xiaomi/mimo-v2.6-pro", 1048576, 32000, []],
	].map(([id, context, output, variants]) => [id, {
		name: `Test ${id}`,
		capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
		limit: { context, input: context - output, output },
		variants: variants.map((id) => ({ id, settings: { reasoning: { effort: id } } })),
	}])),
}
TEST_MANAGED_CATALOG.allowed_model_ids = Object.keys(TEST_MANAGED_CATALOG.managed_models)
