/**
 * Design Invariant Tests
 *
 * Enforces the hard rules from docs/DESIGN_INVARIANTS.md.
 * Every test is tagged with the invariant ID it enforces (e.g., L1-1, L2-1).
 *
 * Run with: npx tsx src/core/prompts/system-prompt/__tests__/design-invariants.test.ts
 *
 * These tests MUST pass before any change to the specialist system is merged.
 */

import { getSpecialistMcpFilter } from "@core/task/tools/utils/specialist-filter"
import { SpecialistType } from "@shared/specialists"
import { ModelFamily } from "@/shared/prompts"
import { ClineDefaultTool } from "@/shared/tools"
import { SystemPromptSection } from "../templates/placeholders"
import { VARIANT_CONFIGS } from "../variants"

// ── Helpers ──────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures: string[] = []

function assert(invariantId: string, label: string, condition: boolean) {
	if (condition) {
		console.log(`  PASS [${invariantId}]: ${label}`)
		passed++
	} else {
		const msg = `  FAIL [${invariantId}]: ${label}`
		console.log(msg)
		failures.push(msg)
		failed++
	}
}

function hasTool(config: any, tool: ClineDefaultTool): boolean {
	return Array.isArray(config.tools) && config.tools.includes(tool)
}

function hasComponent(config: any, section: SystemPromptSection): boolean {
	return Array.isArray(config.componentOrder) && config.componentOrder.includes(section)
}

/**
 * Simple glob match (mirrors mcp.ts globMatch)
 */
function globMatch(pattern: string, value: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
	return new RegExp(`^${escaped}$`, "i").test(value)
}

function filterMatchesAny(patterns: string[], toolName: string): boolean {
	return patterns.some((p) => globMatch(p, toolName))
}

// ── Variant References ──────────────────────────────────────────────

const geology = VARIANT_CONFIGS[ModelFamily.GEOLOGY]
const reportEval = VARIANT_CONFIGS[ModelFamily.REPORT_EVAL]
const orchestrator = VARIANT_CONFIGS[ModelFamily.SPECIALIST_ORCHESTRATOR]
const dataops = VARIANT_CONFIGS[ModelFamily.SPECIALIST_DATAOPS]
const transform = VARIANT_CONFIGS[ModelFamily.SPECIALIST_TRANSFORM]
const analytics = VARIANT_CONFIGS[ModelFamily.SPECIALIST_ANALYTICS]
const geoviz = VARIANT_CONFIGS[ModelFamily.SPECIALIST_GEOVIZ]
const extended = VARIANT_CONFIGS[ModelFamily.SPECIALIST_EXTENDED]

const layer3Specialists = [
	{ name: "DataOps", config: dataops },
	{ name: "Transform", config: transform },
	{ name: "Analytics", config: analytics },
	{ name: "GeoViz", config: geoviz },
]

// ── MCP tools that Layer 1 must NOT see ─────────────────────────────
// Includes write/mutate tools AND data inspection tools that return
// large JSON responses causing context bloat.

const WRITE_MUTATE_TOOLS = [
	// Data inspection tools (removed from Layer 1 to prevent context bloat)
	"inspect_dataset",
	"inspect_specific_columns",
	"inspect_raster",
	"query_data",
	"profile_geochem",
	// Write/mutate tools
	"normalize",
	"standardize",
	"log_transform",
	"smooth",
	"reproject",
	"resample",
	"clip_to_extent",
	"align_grids",
	"select_bands",
	"band_math",
	"compute_gradient",
	"texture_features",
	"select_columns",
	"compute_ratios",
	"aggregate",
	"compute_anomaly",
	"threshold",
	"rank_by_metric",
	"cluster",
	"reduce_dimensions",
	"plot_map",
	"plot_scatter",
	"plot_histogram",
	"plot_clusters",
	"export_artifact",
	// Data cleaning tools (Section I)
	"validate_geology",
	"detect_cleaning_issues",
	"fix_decimals",
	"parse_detection_limits",
	"remove_duplicates",
	"standardize_terms",
]

// Minimal MCP tools for Layer 1 — data inspection tools (inspect_dataset, inspect_specific_columns,
// query_data) intentionally excluded to prevent context bloat from large JSON responses.
// Data inspection is delegated to orchestrator → DataOps specialist via scripts.
const READ_ONLY_TOOLS = ["list_files", "check_missing", "summarize_provenance"]

// ═════════════════════════════════════════════════════════════════════
// LAYER 1: User-Facing Geology Agent
// ═════════════════════════════════════════════════════════════════════

console.log("\n=== LAYER 1: User-Facing Geology Agent ===\n")

// L1-1: Must have mcpToolFilter restricting to read-only inspection tools
assert("L1-1", "Geology variant has mcpToolFilter defined", !!(geology as any).mcpToolFilter)
assert(
	"L1-1",
	"Geology variant mcpToolFilter has allowedToolPatterns",
	Array.isArray((geology as any).mcpToolFilter?.allowedToolPatterns),
)

// L1-2: Must NOT match write/transform/cluster/plot tools
if ((geology as any).mcpToolFilter?.allowedToolPatterns) {
	const patterns: string[] = (geology as any).mcpToolFilter.allowedToolPatterns
	for (const tool of WRITE_MUTATE_TOOLS) {
		assert("L1-2", `Geology filter does NOT match write tool "${tool}"`, !filterMatchesAny(patterns, tool))
	}

	// Verify read-only tools DO match
	for (const tool of READ_ONLY_TOOLS) {
		assert("L1-1", `Geology filter DOES match read-only tool "${tool}"`, filterMatchesAny(patterns, tool))
	}
}

// L1-3: Must have activate_specialist, must NOT have dispatch_specialist
assert("L1-3", "Geology has activate_specialist", hasTool(geology, ClineDefaultTool.ACTIVATE_SPECIALIST))
assert("L1-3", "Geology does NOT have dispatch_specialist", !hasTool(geology, ClineDefaultTool.DISPATCH_SPECIALIST))

// L1-5: Must NOT have execute_command, write_to_file, or apply_patch
assert("L1-5", "Geology does NOT have BASH (execute_command)", !hasTool(geology, ClineDefaultTool.BASH))
assert("L1-5", "Geology does NOT have FILE_NEW (write_to_file)", !hasTool(geology, ClineDefaultTool.FILE_NEW))
assert("L1-5", "Geology does NOT have FILE_EDIT (apply_patch)", !hasTool(geology, ClineDefaultTool.FILE_EDIT))
assert("L1-5", "Geology does NOT have SEARCH (search_files)", !hasTool(geology, ClineDefaultTool.SEARCH))
assert("L1-5", "Geology does NOT have LIST_CODE_DEF", !hasTool(geology, ClineDefaultTool.LIST_CODE_DEF))
assert("L1-5", "Geology does NOT have BROWSER", !hasTool(geology, ClineDefaultTool.BROWSER))

// Verify Layer 1 retains read-only tools
assert("L1-5", "Geology still has FILE_READ", hasTool(geology, ClineDefaultTool.FILE_READ))
assert("L1-5", "Geology still has LIST_FILES", hasTool(geology, ClineDefaultTool.LIST_FILES))
assert("L1-5", "Geology still has MCP_USE", hasTool(geology, ClineDefaultTool.MCP_USE))
assert("L1-5", "Geology still has ASK", hasTool(geology, ClineDefaultTool.ASK))
assert("L1-5", "Geology still has ATTEMPT", hasTool(geology, ClineDefaultTool.ATTEMPT))

// ── Report-eval ("Report Analysis" mode) is a sibling Layer-1 variant ──
// It relaxes the geology SOFT prompt rule discouraging read_file on data files
// (so it can read the compact extracted text/CSV/figure files directly), but it
// must keep the SAME HARD read-only posture: no shell, no writes, mcpToolFilter.
assert("L1-1", "Report-eval has mcpToolFilter defined", !!(reportEval as any).mcpToolFilter)
assert(
	"L1-1",
	"Report-eval mcpToolFilter has allowedToolPatterns",
	Array.isArray((reportEval as any).mcpToolFilter?.allowedToolPatterns),
)
if ((reportEval as any).mcpToolFilter?.allowedToolPatterns) {
	const patterns: string[] = (reportEval as any).mcpToolFilter.allowedToolPatterns
	for (const tool of WRITE_MUTATE_TOOLS) {
		assert("L1-2", `Report-eval filter does NOT match write tool "${tool}"`, !filterMatchesAny(patterns, tool))
	}
}
assert("L1-5", "Report-eval does NOT have BASH (execute_command)", !hasTool(reportEval, ClineDefaultTool.BASH))
assert("L1-5", "Report-eval does NOT have FILE_NEW (write_to_file)", !hasTool(reportEval, ClineDefaultTool.FILE_NEW))
assert("L1-5", "Report-eval does NOT have FILE_EDIT (apply_patch)", !hasTool(reportEval, ClineDefaultTool.FILE_EDIT))
assert("L1-5", "Report-eval still has FILE_READ", hasTool(reportEval, ClineDefaultTool.FILE_READ))
assert("L1-5", "Report-eval still has LIST_FILES", hasTool(reportEval, ClineDefaultTool.LIST_FILES))
assert("L1-3", "Report-eval has activate_specialist", hasTool(reportEval, ClineDefaultTool.ACTIVATE_SPECIALIST))

// ═════════════════════════════════════════════════════════════════════
// LAYER 2: Analysis Orchestrator
// ═════════════════════════════════════════════════════════════════════

console.log("\n=== LAYER 2: Analysis Orchestrator ===\n")

// L2-1: Must NOT have MCP section in prompt components
assert("L2-1", "Orchestrator does NOT have MCP in components", !hasComponent(orchestrator, SystemPromptSection.MCP))
assert("L2-1", "Orchestrator has no mcpToolFilter (no MCP access at all)", !(orchestrator as any).mcpToolFilter)

// L2-2: Must have dispatch_specialist and activate_specialist
assert("L2-2", "Orchestrator has dispatch_specialist", hasTool(orchestrator, ClineDefaultTool.DISPATCH_SPECIALIST))
assert("L2-2", "Orchestrator has activate_specialist", hasTool(orchestrator, ClineDefaultTool.ACTIVATE_SPECIALIST))

// L2-2b: Must have SPECIALIST_HISTORY component for traceability
assert(
	"L2-2b",
	"Orchestrator has SPECIALIST_HISTORY component",
	hasComponent(orchestrator, SystemPromptSection.SPECIALIST_HISTORY),
)

// L2-3: Must NOT have execute_command, write_to_file, or browser
assert("L2-3", "Orchestrator does NOT have BASH", !hasTool(orchestrator, ClineDefaultTool.BASH))
assert("L2-3", "Orchestrator does NOT have FILE_NEW", !hasTool(orchestrator, ClineDefaultTool.FILE_NEW))
assert("L2-3", "Orchestrator does NOT have FILE_EDIT", !hasTool(orchestrator, ClineDefaultTool.FILE_EDIT))
assert("L2-3", "Orchestrator does NOT have BROWSER", !hasTool(orchestrator, ClineDefaultTool.BROWSER))

// ═════════════════════════════════════════════════════════════════════
// LAYER 3: Domain Specialists
// ═════════════════════════════════════════════════════════════════════

console.log("\n=== LAYER 3: Domain Specialists ===\n")

// L3-1: Every specialist must define mcpToolFilter
for (const { name, config } of layer3Specialists) {
	assert("L3-1", `${name} has mcpToolFilter defined`, !!(config as any).mcpToolFilter)
	assert(
		"L3-1",
		`${name} mcpToolFilter has allowedToolPatterns`,
		Array.isArray((config as any).mcpToolFilter?.allowedToolPatterns),
	)
}

// L3-3: Transform is Tier 2 — has BASH and FILE_NEW, but NOT FILE_EDIT
assert("L3-3", "Transform DOES have BASH", hasTool(transform, ClineDefaultTool.BASH))
assert("L3-3", "Transform DOES have FILE_NEW", hasTool(transform, ClineDefaultTool.FILE_NEW))
assert("L3-3", "Transform does NOT have FILE_EDIT", !hasTool(transform, ClineDefaultTool.FILE_EDIT))

// L3-4: All specialists must have attempt_completion
for (const { name, config } of layer3Specialists) {
	assert("L3-4", `${name} has ATTEMPT tool`, hasTool(config, ClineDefaultTool.ATTEMPT))
}

// L3-5: All specialists (except extended) must have request_capability
for (const { name, config } of layer3Specialists) {
	assert("L3-5", `${name} has REQUEST_CAPABILITY tool`, hasTool(config, ClineDefaultTool.REQUEST_CAPABILITY))
}

// L3-5: No specialist should have dispatch_specialist or activate_specialist
for (const { name, config } of layer3Specialists) {
	assert("L3-5", `${name} does NOT have DISPATCH_SPECIALIST`, !hasTool(config, ClineDefaultTool.DISPATCH_SPECIALIST))
	assert("L3-5", `${name} does NOT have ACTIVATE_SPECIALIST`, !hasTool(config, ClineDefaultTool.ACTIVATE_SPECIALIST))
}

// ═════════════════════════════════════════════════════════════════════
// LAYER 4: Extended Capability Agent
// ═════════════════════════════════════════════════════════════════════

console.log("\n=== LAYER 4: Extended Capability Agent ===\n")

// L4-1: Extended has BASH (can install packages)
assert("L4-1", "Extended has BASH", hasTool(extended, ClineDefaultTool.BASH))

// L4-2: Extended must NOT have MCP_USE or MCP_ACCESS
assert("L4-2", "Extended does NOT have MCP_USE", !hasTool(extended, ClineDefaultTool.MCP_USE))
assert("L4-2", "Extended does NOT have MCP_ACCESS", !hasTool(extended, ClineDefaultTool.MCP_ACCESS))
assert("L4-2", "Extended has no mcpToolFilter (no MCP access)", !(extended as any).mcpToolFilter)

// Extended should NOT have dispatch or activate (it's a leaf agent)
assert("L4-2", "Extended does NOT have DISPATCH_SPECIALIST", !hasTool(extended, ClineDefaultTool.DISPATCH_SPECIALIST))
assert("L4-2", "Extended does NOT have ACTIVATE_SPECIALIST", !hasTool(extended, ClineDefaultTool.ACTIVATE_SPECIALIST))

// ═════════════════════════════════════════════════════════════════════
// CROSS-CUTTING: Tool privilege escalation checks
// ═════════════════════════════════════════════════════════════════════

console.log("\n=== CROSS-CUTTING: Privilege boundaries ===\n")

// X-6: Only Extended should have BASH without REQUEST_CAPABILITY
// (If you have shell access but can't signal capability gaps, you'll try to install yourself)
for (const { name, config } of layer3Specialists) {
	if (hasTool(config, ClineDefaultTool.BASH)) {
		assert(
			"X-6",
			`${name} has BASH but also has REQUEST_CAPABILITY (can signal gaps)`,
			hasTool(config, ClineDefaultTool.REQUEST_CAPABILITY),
		)
	}
}

// Verify orchestrator cannot accidentally see MCP tools
assert("X-6", "Orchestrator does NOT have MCP_USE", !hasTool(orchestrator, ClineDefaultTool.MCP_USE))
assert("X-6", "Orchestrator does NOT have MCP_ACCESS", !hasTool(orchestrator, ClineDefaultTool.MCP_ACCESS))
assert("X-6", "Orchestrator does NOT have MCP_DOCS", !hasTool(orchestrator, ClineDefaultTool.MCP_DOCS))

// ═════════════════════════════════════════════════════════════════════
// L3-3 ENFORCEMENT: Execution-time tool guard
// ═════════════════════════════════════════════════════════════════════

console.log("\n=== L3-3 ENFORCEMENT: Execution-time tool guard ===\n")

import { getSpecialistAllowedTools } from "@core/task/tools/utils/specialist-tool-guard"

// L3-3: Transform is Tier 2 — has execute_command and write_to_file, but NOT replace_in_file/apply_patch
const transformAllowed = getSpecialistAllowedTools("transform")
assert("L3-3", "getSpecialistAllowedTools('transform') returns non-null", transformAllowed !== null)
if (transformAllowed) {
	assert("L3-3", "Transform tool guard DOES include execute_command", transformAllowed.has("execute_command"))
	assert("L3-3", "Transform tool guard DOES include write_to_file", transformAllowed.has("write_to_file"))
	assert("L3-3", "Transform tool guard does NOT include replace_in_file", !transformAllowed.has("replace_in_file"))
	assert("L3-3", "Transform tool guard does NOT include apply_patch", !transformAllowed.has("apply_patch"))
	assert("L3-3", "Transform tool guard DOES include read_file", transformAllowed.has("read_file"))
	assert("L3-3", "Transform tool guard DOES include use_mcp_tool", transformAllowed.has("use_mcp_tool"))
	assert("L3-3", "Transform tool guard DOES include attempt_completion", transformAllowed.has("attempt_completion"))
}

// L3-3: DataOps DOES have execute_command (it needs shell for scripts)
const dataopsAllowed = getSpecialistAllowedTools("dataops")
assert("L3-3", "getSpecialistAllowedTools('dataops') returns non-null", dataopsAllowed !== null)
if (dataopsAllowed) {
	assert("L3-3", "DataOps tool guard DOES include execute_command", dataopsAllowed.has("execute_command"))
}

// L3-3: Analytics DOES have execute_command (runs analysis scripts)
const analyticsAllowed = getSpecialistAllowedTools("analytics")
assert("L3-3", "getSpecialistAllowedTools('analytics') returns non-null", analyticsAllowed !== null)
if (analyticsAllowed) {
	assert("L3-3", "Analytics tool guard DOES include execute_command", analyticsAllowed.has("execute_command"))
}

// ═════════════════════════════════════════════════════════════════════
// V-2: getSpecialistMcpFilter deny-all fallback
// ═════════════════════════════════════════════════════════════════════

console.log("\n=== V-2: MCP Filter Deny-All Fallback ===\n")

// V-2: getSpecialistMcpFilter(null) returns undefined (geology agent — no execution-time filter needed)
assert("V-2", "getSpecialistMcpFilter(null) returns undefined", getSpecialistMcpFilter(null) === undefined)

// V-2: Every SpecialistType returns a non-undefined filter (either real filter or deny-all)
for (const specialistType of Object.values(SpecialistType)) {
	const filter = getSpecialistMcpFilter(specialistType)
	assert("V-2", `getSpecialistMcpFilter("${specialistType}") returns non-undefined filter`, filter !== undefined)
	// Verify the filter has the expected shape
	if (filter) {
		assert(
			"V-2",
			`getSpecialistMcpFilter("${specialistType}") filter has allowedToolPatterns array`,
			Array.isArray(filter.allowedToolPatterns),
		)
	}
}

// V-2: Orchestrator and Extended should get deny-all (empty allowedToolPatterns) since they have no mcpToolFilter in config
const orchestratorFilter = getSpecialistMcpFilter(SpecialistType.ORCHESTRATOR)
assert(
	"V-2",
	"Orchestrator gets deny-all filter (empty allowedToolPatterns)",
	orchestratorFilter !== undefined &&
		Array.isArray(orchestratorFilter.allowedToolPatterns) &&
		orchestratorFilter.allowedToolPatterns.length === 0,
)

const extendedFilter = getSpecialistMcpFilter(SpecialistType.EXTENDED)
assert(
	"V-2",
	"Extended gets deny-all filter (empty allowedToolPatterns)",
	extendedFilter !== undefined &&
		Array.isArray(extendedFilter.allowedToolPatterns) &&
		extendedFilter.allowedToolPatterns.length === 0,
)

// ═════════════════════════════════════════════════════════════════════
// SUMMARY
// ═════════════════════════════════════════════════════════════════════

console.log(`\n========================================`)
console.log(`Design Invariant Results: ${passed} passed, ${failed} failed`)
if (failures.length > 0) {
	console.log(`\nFailures:`)
	for (const f of failures) {
		console.log(f)
	}
}
console.log(`========================================`)

if (failed > 0) {
	process.exit(1)
}
