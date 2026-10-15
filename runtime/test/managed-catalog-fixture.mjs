// Scripted engine inventory, not a product entitlement list.
export const TEST_MODEL_IDS = ["openai/gpt-6-luna", "z-ai/glm-5.3-flash", "google/gemini-3.8-flash", "deepseek/deepseek-v4.1-flash", "openai/gpt-6.1-sol", "anthropic/claude-haiku-5.5", "anthropic/claude-opus-5.5", "xiaomi/mimo-v2.6-pro"]
export function managedDiscovery(ids = TEST_MODEL_IDS) {
	return { discovery_schema_version: 2, allowed_model_ids: [...ids], default_model_id: ids[0] ?? null, managed_models: Object.fromEntries(ids.map((id) => [id, { name: id, capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, limit: { context: 24000, input: 20000, output: 4000 }, variants: [] }])) }
}
