/**
 * Invariant parity for the shared geology configuration.
 * Every assertion runs against the generated rules through test/permissions.mjs, so a glob that leaks a tool or
 * an agent fails here even when the generator's source looks right.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildNativeConfig, buildManagedConfig, UNASSIGNED_TOOLS, SPECIALISTS } from "../scripts/build-config.mjs"
import { TOOL_SPECS } from "../config/lib/voxel-contract.js"
import { BARE_OUTPUT_PATH } from "../scripts/build-prompts.mjs"
import { allows, evaluate, allowedMcpTools } from "./permissions.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TOOLS = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "mcp-tools.json"), "utf8"))
const config = buildNativeConfig()
const agents = config.agents
const rules = (name) => agents[name].permissions

const L1 = ["geology", "report-analysis"]
const L3 = ["dataops", "transform", "analytics", "geoviz", "voxel"]
const LAYERED = [...L1, "orchestrator", ...L3, "extended"]
const ALL_AGENTS = [...LAYERED, "standard"]
const L1_TOOLS = ["check_missing", "list_files", "summarize_provenance"]
const INSTALL_COMMANDS = [
	"pip install pyproj", "pip3 install rasterio", "python -m pip install shapely", "uv pip install x", "uv add x",
	"conda install gdal", "apt-get install -y gdal-bin", "npm install left-pad", "npm i left-pad", "sudo ls",
]

const PROCESSOR_TOOLS = ["submit", "get_job", "list_jobs", "cancel", "get_result", "read_table", "read_text"].map((name) => `processor_documents_${name}`)
const processing = { url: "http://127.0.0.1:8765/mcp", token: "{env:GEOCLUSTER_NATIVE_PROCESSING_TOKEN}" }

test("native processing registers a separate authenticated direct MCP with bounded calls", () => {
	const native = buildNativeConfig({ processing })
	assert.deepEqual(native.mcp.servers.processor, {
		type: "remote", url: processing.url, oauth: false, codemode: false,
		headers: { Authorization: `Bearer ${processing.token}` },
		timeout: { startup: 30_000, catalog: 30_000, execution: 30_000 },
	})
	assert.deepEqual(native.mcp.servers.geocluster, config.mcp.servers.geocluster)
	assert.equal(buildNativeConfig({ processing: { ...processing, token: "native-local-test-token" } }).mcp.servers.processor.headers.Authorization, "Bearer native-local-test-token")
})

test("L3-1/2: native processing allows exactly seven tools only to DataOps within the hierarchy", () => {
	const native = buildNativeConfig({ processing })
	for (const name of ALL_AGENTS) {
		const permissions = native.agents[name].permissions
		for (const tool of PROCESSOR_TOOLS) assert.equal(evaluate(permissions, tool), ["dataops", "standard"].includes(name) ? "allow" : "deny", `${name}: ${tool}`)
		if (name !== "standard") {
			for (const tool of ["processor_documents_delete", "processor_documents_submit_extra", "geocluster_documents_submit"]) assert.equal(evaluate(permissions, tool), "deny", `${name}: unknown ${tool}`)
		}
		if (name !== "dataops") assert.deepEqual(native.agents[name], agents[name], `${name} remains unchanged`)
		assert.equal(evaluate(permissions, "execute"), "deny", name)
	}
	assert.deepEqual(native.agents.dataops.permissions.filter((rule) => !PROCESSOR_TOOLS.includes(rule.action)), rules("dataops"), "all existing DataOps permissions remain intact")
})

test("native processing is opt-in and never leaks into managed composition", () => {
	assert.deepEqual(Object.keys(buildNativeConfig().mcp.servers), ["geocluster"])
	assert.deepEqual(buildManagedConfig({ processing }), buildManagedConfig(), "managed configuration ignores native processing even when supplied")
	for (const name of LAYERED) for (const tool of PROCESSOR_TOOLS) assert.equal(evaluate(rules(name), tool), "deny", `${name}: disabled ${tool}`)
})

test("X-3, X-7: only workspace edits ask; automatic run outputs stay allowed; Code Mode stays denied", () => {
	for (const name of ALL_AGENTS) {
		for (const rule of rules(name).filter((rule) => rule.effect === "ask")) assert.equal(rule.action, "edit", name)
		assert.equal(evaluate(rules(name), "edit", "notes.md"), [...L3, "extended", "standard"].includes(name) ? "ask" : "deny", name)
		assert.equal(evaluate(rules(name), "execute", "anything"), "deny", `${name} can use Code Mode`)
	}
})

test("default deny: unknown actions are refused for every layered agent", () => {
	for (const name of LAYERED) {
		assert.equal(evaluate(rules(name), "some_future_tool", "x"), "deny", name)
		assert.equal(evaluate(rules(name), "geocluster_some_future_tool", "*"), "deny", name)
	}
})

test(".env files are unreadable for every agent", () => {
	for (const name of ALL_AGENTS) {
		for (const file of [".env", ".env.local", "sub/dir/.env", "/workspace/.env.production"]) {
			assert.equal(evaluate(rules(name), "read", file), "deny", `${name} reads ${file}`)
		}
	}
})

test("L1-1, L1-2, RE-1: Layer 1 sees exactly the three hygiene MCP tools", () => {
	for (const name of L1) assert.deepEqual(allowedMcpTools(rules(name), TOOLS), L1_TOOLS, name)
})

test("L1-5, RE-1: Layer 1 cannot run shell, write or fetch", () => {
	for (const name of L1) {
		for (const [action, resource] of [["shell", "ls"], ["edit", "runs/x/results/a.csv"], ["edit", "notes.md"], ["webfetch", "https://x"], ["websearch", "q"]]) {
			assert.equal(evaluate(rules(name), action, resource), "deny", `${name} ${action} ${resource}`)
		}
		assert.ok(allows(rules(name), "read", "text/01_summary.md"), `${name} reads prose`)
		assert.ok(allows(rules(name), "glob", "*"), `${name} finds files by name`)
	}
	// L1-1: grep returns matching lines and its permission is checked against the search pattern, not the path, so
	// geology (which may not read data) has no grep; report-analysis may read tables (RE-2) and keeps it
	assert.equal(evaluate(rules("geology"), "grep", "*"), "deny")
	assert.equal(evaluate(rules("geology"), "grep", "Au_ppm"), "deny")
	assert.ok(allows(rules("report-analysis"), "grep", "*"), "report-analysis searches contents")
	// geology delegates data reads (L1-1 context bloat); report-analysis reads extracted tables directly (RE-2)
	assert.equal(evaluate(rules("geology"), "read", "data/drill.csv"), "deny")
	assert.equal(evaluate(rules("geology"), "read", "data/DRILL.CSV"), "deny", "upper-case extensions too")
	assert.equal(evaluate(rules("report-analysis"), "read", "tables/t1__p0002.csv"), "allow")
})

test("L1-3, L2-2: geology → orchestrator only; orchestrator → the six specialists only", () => {
	for (const name of L1) {
		assert.ok(allows(rules(name), "subagent", "orchestrator"), name)
		for (const other of [...SPECIALISTS, ...L1, "standard"]) assert.equal(evaluate(rules(name), "subagent", other), "deny", `${name} → ${other}`)
	}
	const dispatchable = Object.keys(agents).filter((a) => allows(rules("orchestrator"), "subagent", a)).sort()
	assert.deepEqual(dispatchable, [...SPECIALISTS].sort())
	for (const name of [...L3, "extended"]) {
		for (const target of Object.keys(agents)) assert.equal(evaluate(rules(name), "subagent", target), "deny", `${name} → ${target}`)
	}
})

test("L2-1, L2-3: the orchestrator has no MCP tool, no shell, no writes, no web", () => {
	assert.deepEqual(allowedMcpTools(rules("orchestrator"), TOOLS), [])
	for (const [action, resource] of [["shell", "ls"], ["edit", "runs/x/plan.md"], ["webfetch", "https://x"]]) {
		assert.equal(evaluate(rules("orchestrator"), action, resource), "deny", `${action}`)
	}
	assert.equal(evaluate(rules("orchestrator"), "read", "data/drill.csv"), "deny")
	assert.equal(evaluate(rules("orchestrator"), "grep", "40,8"), "deny", "no data reads through grep either (L2-1)")
	assert.ok(allows(rules("orchestrator"), "glob", "**/*.csv"), "file names only")
})

test("L3-1, L3-2: specialist MCP permissions do not leak through substrings", () => {
	// the three leaks the probe found (P8 F) stay closed
	assert.equal(evaluate(rules("transform"), "geocluster_validate_geology"), "deny")
	assert.equal(evaluate(rules("analytics"), "geocluster_plot_clusters"), "deny")
	assert.equal(evaluate(rules("dataops"), "geocluster_merge_datasets"), "deny")
})

test("deliberately unassigned MCP tools reach no layered agent", () => {
	for (const name of LAYERED) {
		for (const tool of UNASSIGNED_TOOLS) assert.equal(evaluate(rules(name), `geocluster_${tool}`), "deny", `${name} → ${tool}`)
	}
})

test("MCP tools: test/mcp-tools.json matches the tools geocluster-mcp registers", (t) => {
	const main = path.resolve(ROOT, "..", "geocluster-mcp", "main.py")
	if (!fs.existsSync(main)) return t.skip("geocluster-mcp submodule not checked out")
	const registered = [...fs.readFileSync(main, "utf8").matchAll(/^mcp\.tool\(\)\((?:threaded\()?(\w+)\)/gm)].map((m) => m[1]).sort()
	assert.deepEqual(registered, [...TOOLS].sort(), "update test/mcp-tools.json, then classify any new tool in build-config.mjs")
})

test("L3-3, X-7: specialists ask for exact workspace paths; own-run outputs automatic; L3-5: no installs", () => {
	for (const name of L3) {
		assert.ok(allows(rules(name), "edit", "runs/ses_abc/results/out.csv"), `${name} writes its run folder`)
		for (const outside of ["results/out.csv", "data/drill.csv", "/workspace/out.csv", "README.md"]) {
			assert.equal(evaluate(rules(name), "edit", outside), "ask", `${name} asks to write ${outside}`)
		}
		assert.ok(allows(rules(name), "shell", "python runs/ses_abc/scripts/x.py"), `${name} runs scripts`)
		for (const cmd of INSTALL_COMMANDS) assert.equal(evaluate(rules(name), "shell", cmd), "deny", `${name}: ${cmd}`)
	}
})

test("L4-1: only extended may install; L4-2: extended has no MCP tool", () => {
	for (const cmd of INSTALL_COMMANDS) assert.ok(allows(rules("extended"), "shell", cmd), `extended: ${cmd}`)
	assert.deepEqual(allowedMcpTools(rules("extended"), TOOLS), [])
	for (const name of [...L1, "orchestrator"]) {
		assert.ok(INSTALL_COMMANDS.every((cmd) => evaluate(rules(name), "shell", cmd) === "deny"), `${name} may install`)
	}
})

test("L3-6: canonical voxel allowlist is exclusive; legacy MCP publication is unassigned, including standard", () => {
	for (const name of ALL_AGENTS) {
		for (const tool of Object.keys(TOOL_SPECS)) assert.equal(evaluate(rules(name), tool), name === "voxel" ? "allow" : "deny", `${name}: ${tool}`)
		for (const tool of TOOLS.filter((t) => t.startsWith("voxel_"))) assert.equal(evaluate(rules(name), `geocluster_${tool}`), "deny", `${name}: legacy ${tool}`)
	}
	assert.deepEqual(allowedMcpTools(rules("voxel"), TOOLS), ["list_files", "summarize_provenance"])
})

test("standard mode: every tool except dispatch, outside folders, .env and Code Mode", () => {
	const s = rules("standard")
	for (const [action, resource] of [["shell", "pip install x"], ["edit", "runs/ses_x/results/out.md"], ["geocluster_cluster", "*"], ["webfetch", "https://x"]]) {
		assert.ok(allows(s, action, resource), `${action} ${resource}`)
	}
	assert.equal(evaluate(s, "edit", "src/app.py"), "ask", "ordinary workspace edits retain approval")
	for (const [action, resource] of [["subagent", "orchestrator"], ["external_directory", "/etc/passwd"], ["execute", "x"], ["browser_tabs_open", "*"], ["opencode_session_move", "*"], ["question", "*"]]) {
		assert.equal(evaluate(s, action, resource), "deny", `${action} ${resource}`)
	}
})

test("X-7: output-path validation distinguishes bare paths", () => {
	const bare = (text) => [...text.matchAll(BARE_OUTPUT_PATH)].map((m) => m[0])
	assert.deepEqual(bare("save to results/a.csv and scripts/x.py"), ["results/", "scripts/"])
	assert.deepEqual(bare("from /workspace/results/a.csv"), ["results/"])
	assert.deepEqual(bare("save to <run>/results/a.csv, <run>/scripts/transform/x.py; the `results` field"), [])
})

test("no agent may ask the user through the question tool, drive a browser, or move its session", () => {
	for (const name of ALL_AGENTS) {
		for (const action of ["question", "browser_tabs_open", "browser_navigate", "opencode_session_move"]) {
			assert.equal(evaluate(rules(name), action, "*"), "deny", `${name}: ${action}`)
		}
	}
})
