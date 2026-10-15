#!/usr/bin/env node
/**
 * build-prompts.mjs — assemble config/prompts/<agent>.md from prompt-src/ fragments.
 *
 *   node scripts/build-prompts.mjs          write config/prompts/, fail on leftover Cline tool names
 *   node scripts/build-prompts.mjs --check  exit 1 if config/prompts/ is out of date (used by the invariant test)
 *
 * The fragments are ported by hand from the Cline fork (cline-fork/src/core/prompts/system-prompt/, see each
 * agent's SOURCES below) and already use OpenCode tool names. This script only concatenates them in the fork's
 * section order and refuses to emit a prompt that still names a Cline tool: under OpenCode those names do not
 * exist, and a model told to call `execute_command` or `attempt_completion` wastes turns or improvises.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const SRC = path.join(ROOT, "prompt-src")
const OUT = path.join(ROOT, "config", "prompts")

const L3_TAIL = ["shared/result-protocol.md", "shared/capability-gap.md", "shared/resume.md", "shared/data-interaction.md", "shared/specialist-rules.md"]

/** Section order mirrors each fork variant's `.components(...)` list; SOURCES record provenance. */
export const MANIFEST = {
	geology: {
		sources: "variants/geology/config.ts (role 23-137, capabilities 142-150, rules 155-172, objective 241-267); components/geological_constraints.ts 14-35",
		parts: ["geology/role.md", "geology/capabilities.md", "shared/geological-constraints.md", "geology/rules.md", "geology/objective.md"],
	},
	"report-analysis": {
		sources: "variants/report-eval/config.ts (role 41-80, constraints 84-119, capabilities 122-129, rules 132-146, objective 193-211)",
		parts: ["report-analysis/role.md", "report-analysis/capabilities-rules.md", "report-analysis/constraints.md", "report-analysis/objective.md"],
	},
	orchestrator: {
		sources: "variants/specialists/orchestrator/config.ts (role 15-137, rules 142-155, objective 245-262); components/specialist_history.ts (ledger)",
		parts: ["orchestrator/role.md", "orchestrator/rules.md", "orchestrator/objective.md"],
	},
	dataops: {
		sources: "variants/specialists/dataops/config.ts (role 15-58, objective 60-72); specialists/shared.ts",
		parts: ["dataops/role.md", ...L3_TAIL, "dataops/objective.md"],
	},
	transform: {
		sources: "variants/specialists/transform/config.ts (role 15-62, objective 64-75); specialists/shared.ts",
		parts: ["transform/role.md", ...L3_TAIL, "transform/objective.md"],
	},
	analytics: {
		sources: "variants/specialists/analytics/config.ts (role 15-42, objective 44-52); specialists/shared.ts",
		parts: ["analytics/role.md", ...L3_TAIL, "analytics/objective.md"],
	},
	geoviz: {
		sources: "variants/specialists/geoviz/config.ts (role 15-58, objective 60-66); specialists/shared.ts",
		parts: ["geoviz/role.md", ...L3_TAIL, "geoviz/objective.md"],
	},
	voxel: {
		sources: "canonical runtime voxel specialist; specialists/shared.ts (output/capability/resume/rules)",
		parts: ["voxel/role.md", "shared/result-protocol.md", "shared/capability-gap.md", "shared/resume.md", "shared/specialist-rules.md", "voxel/objective.md"],
	},
	extended: {
		sources: "variants/specialists/extended/config.ts (role 15-29, objective 31-44) + L4-3/L4-4 text added for the spike",
		parts: ["extended/role.md", "shared/result-protocol.md", "shared/specialist-rules.md", "extended/objective.md"],
	},
}

/** Cline tool names that must not survive the port. `list_files` is allowed only as geocluster_list_files. */
export const FORBIDDEN = [
	/\bread_file\b/,
	/(?<!geocluster_)\blist_files\b/,
	/\bsearch_files\b/,
	/\bexecute_command\b/,
	/\bwrite_to_file\b/,
	/\breplace_in_file\b/,
	/\bapply_patch\b/,
	/\buse_mcp_tool\b/,
	/\baccess_mcp_resource\b/,
	/\bload_mcp_documentation\b/,
	/\blist_mcp_tools\b/,
	/\bdispatch_specialist\b/,
	/\bactivate_specialist\b/,
	/\battempt_completion\b/,
	/\bask_followup_question\b/,
	/\brequest_capability\b/,
	/\benvironment_details\b/,
	/\{\{[A-Z_]+\}\}/,
	/<thinking>/,
	// OpenCode 1.x vocabulary: 2.0 calls the tool `subagent`, takes `agent`, resumes by `sessionID` and wraps results
	// as <subagent sessionID=…> (verified against the 2.0.19 tool schema, 2026-10-01)
	/\btask tool\b/i,
	/\bsubagent_type\b/,
	/<task\b/,
]

/** A results/ or scripts/ path not under <run>/ (X-7). */
export const BARE_OUTPUT_PATH = /(?<!<run>\/)(?<![\w.-])(results|scripts)\//g

/** geocluster tools named in a prompt must exist on the MCP server (catches typos and stale names). */
function unknownGeoclusterTools(text, known) {
	const names = new Set([...text.matchAll(/\bgeocluster_([a-z0-9_]+)/g)].map((m) => m[1]))
	return [...names].filter((n) => !known.has(n) && !n.endsWith("_")) // `geocluster_voxel_*` style globs end with _
}

export function build() {
	const known = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "test", "mcp-tools.json"), "utf8")))
	const out = {}
	const problems = []
	for (const [agent, { sources, parts }] of Object.entries(MANIFEST)) {
		const body = parts.map((p) => fs.readFileSync(path.join(SRC, p), "utf8").trim()).join("\n\n")
		const text = `<!-- GENERATED by scripts/build-prompts.mjs from prompt-src/ — do not edit. Ported from cline-fork: ${sources} -->\n\n${body}\n`
		for (const re of FORBIDDEN) {
			const m = re.exec(body)
			if (m) problems.push(`${agent}: Cline name survives: "${m[0]}" (${re})`)
		}
		for (const n of unknownGeoclusterTools(body, known)) problems.push(`${agent}: unknown MCP tool geocluster_${n}`)
		// X-7: output paths name the conversation's folder; the run-dir plugin's brief defines <run> (the fork's
		// {{RUN_PREFIX}} check, design-invariants.test.ts)
		for (const m of body.matchAll(BARE_OUTPUT_PATH)) problems.push(`${agent}: bare output path "${m[0]}" (write <run>/${m[1]}/)`)
		out[agent] = text
	}
	return { out, problems }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
	const check = process.argv.includes("--check")
	const { out, problems } = build()
	if (problems.length) {
		console.error(problems.join("\n"))
		process.exit(1)
	}
	let stale = 0
	fs.mkdirSync(OUT, { recursive: true })
	for (const [agent, text] of Object.entries(out)) {
		const file = path.join(OUT, `${agent}.md`)
		const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null
		if (current === text) continue
		stale++
		if (check) console.error(`stale: config/prompts/${agent}.md`)
		else fs.writeFileSync(file, text)
	}
	if (check && stale) process.exit(1)
	for (const [agent, text] of Object.entries(out)) console.log(`${agent.padEnd(16)} ${String(text.length).padStart(6)} chars`)
	if (!check) console.log(`wrote ${stale} file(s) to config/prompts/`)
}
