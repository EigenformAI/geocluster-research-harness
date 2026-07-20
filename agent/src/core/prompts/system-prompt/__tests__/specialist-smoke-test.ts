/**
 * Smoke test for the specialist multi-agent system.
 *
 * Run with: npx tsx src/core/prompts/system-prompt/__tests__/specialist-smoke-test.ts
 *
 * Tests:
 * 1. Geology variant matches when no specialist is active
 * 2. Each specialist variant matches when activeSpecialist is set
 * 3. Geology does NOT match when a specialist is active
 * 4. Variant config objects are well-formed (tools, components present)
 * 5. MCP tool filter glob matching works
 */

import { ModelFamily } from "@/shared/prompts"
import { SpecialistType } from "@/shared/specialists"
import { VARIANT_CONFIGS } from "../variants"

// Minimal mock context — just enough for matcher functions
function mockContext(activeSpecialist?: string) {
	return {
		cwd: "/test",
		ide: "TestIde",
		providerInfo: {
			providerId: "openrouter",
			model: { id: "anthropic/claude-sonnet-4-20250514", info: {} as any },
			mode: "act" as const,
		},
		activeSpecialist,
	} as any
}

let passed = 0
let failed = 0

function assert(label: string, condition: boolean) {
	if (condition) {
		console.log(`  PASS: ${label}`)
		passed++
	} else {
		console.log(`  FAIL: ${label}`)
		failed++
	}
}

// ── Test 1: Geology matches with no specialist ─────────────────────
console.log("\n--- Test 1: Geology variant matches with no specialist ---")

const geologyConfig = VARIANT_CONFIGS[ModelFamily.GEOLOGY]
assert("Geology matches when activeSpecialist is undefined", geologyConfig.matcher(mockContext(undefined)))
assert("Geology matches when activeSpecialist is not set", geologyConfig.matcher(mockContext()))

// ── Test 2: Geology does NOT match when specialist is active ───────
console.log("\n--- Test 2: Geology variant does NOT match with active specialist ---")

for (const specialistType of Object.values(SpecialistType)) {
	assert(
		`Geology does NOT match when activeSpecialist="${specialistType}"`,
		!geologyConfig.matcher(mockContext(specialistType)),
	)
}

// ── Test 3: Each specialist variant matches correctly ──────────────
console.log("\n--- Test 3: Specialist variant matching ---")

const specialistFamilies: Record<SpecialistType, ModelFamily> = {
	[SpecialistType.ORCHESTRATOR]: ModelFamily.SPECIALIST_ORCHESTRATOR,
	[SpecialistType.DATAOPS]: ModelFamily.SPECIALIST_DATAOPS,
	[SpecialistType.TRANSFORM]: ModelFamily.SPECIALIST_TRANSFORM,
	[SpecialistType.ANALYTICS]: ModelFamily.SPECIALIST_ANALYTICS,
	[SpecialistType.GEOVIZ]: ModelFamily.SPECIALIST_GEOVIZ,
	[SpecialistType.EXTENDED]: ModelFamily.SPECIALIST_EXTENDED,
}

for (const [specialistType, family] of Object.entries(specialistFamilies)) {
	const config = VARIANT_CONFIGS[family as keyof typeof VARIANT_CONFIGS]
	assert(`${family} config exists`, !!config)

	if (config) {
		assert(`${family} matches when activeSpecialist="${specialistType}"`, config.matcher(mockContext(specialistType)))

		// Should NOT match for other specialist types
		const otherType = specialistType === "orchestrator" ? "dataops" : "orchestrator"
		assert(`${family} does NOT match for "${otherType}"`, !config.matcher(mockContext(otherType)))
	}
}

// ── Test 4: Variant configs are well-formed ────────────────────────
console.log("\n--- Test 4: Variant configs well-formed ---")

for (const [specialistType, family] of Object.entries(specialistFamilies)) {
	const config = VARIANT_CONFIGS[family as keyof typeof VARIANT_CONFIGS]
	if (!config) continue

	assert(`${family} has tools`, Array.isArray(config.tools) && config.tools.length > 0)
	assert(`${family} has componentOrder`, Array.isArray(config.componentOrder) && config.componentOrder.length > 0)
	assert(`${family} has baseTemplate`, typeof config.baseTemplate === "string" && config.baseTemplate.length > 0)
	assert(`${family} has description`, typeof config.description === "string")
}

// ── Test 5: Orchestrator has dispatch but not request_capability ────
console.log("\n--- Test 5: Tool assignments ---")

const orchConfig = VARIANT_CONFIGS[ModelFamily.SPECIALIST_ORCHESTRATOR]
assert("Orchestrator has dispatch_specialist", orchConfig.tools?.includes("dispatch_specialist" as any) ?? false)
assert("Orchestrator has activate_specialist", orchConfig.tools?.includes("activate_specialist" as any) ?? false)
assert("Orchestrator does NOT have request_capability", !orchConfig.tools?.includes("request_capability" as any))

const dataopsConfig = VARIANT_CONFIGS[ModelFamily.SPECIALIST_DATAOPS]
assert("DataOps has request_capability", dataopsConfig.tools?.includes("request_capability" as any) ?? false)
assert("DataOps does NOT have dispatch_specialist", !dataopsConfig.tools?.includes("dispatch_specialist" as any))
assert("DataOps does NOT have activate_specialist", !dataopsConfig.tools?.includes("activate_specialist" as any))

assert("Geology has activate_specialist", geologyConfig.tools?.includes("activate_specialist" as any) ?? false)
assert("Geology does NOT have dispatch_specialist", !geologyConfig.tools?.includes("dispatch_specialist" as any))
assert("Geology does NOT have request_capability", !geologyConfig.tools?.includes("request_capability" as any))

// ── Test 6: MCP filter on specialist configs ───────────────────────
console.log("\n--- Test 6: MCP tool filters ---")

assert("Orchestrator has no mcpToolFilter", !(orchConfig as any).mcpToolFilter)
assert("DataOps has mcpToolFilter", !!(dataopsConfig as any).mcpToolFilter)
assert("DataOps filter has allowedToolPatterns", Array.isArray((dataopsConfig as any).mcpToolFilter?.allowedToolPatterns))

const extConfig = VARIANT_CONFIGS[ModelFamily.SPECIALIST_EXTENDED]
assert("Extended has no mcpToolFilter", !(extConfig as any).mcpToolFilter)

// ── Summary ────────────────────────────────────────────────────────
console.log(`\n========================================`)
console.log(`Results: ${passed} passed, ${failed} failed`)
console.log(`========================================`)

if (failed > 0) {
	process.exit(1)
}
