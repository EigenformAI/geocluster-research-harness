#!/usr/bin/env node
/**
 * build-config.mjs — assemble independent native and managed geology configurations.
 *
 *   node scripts/build-config.mjs                     write both profiles (managed has no startup catalog)
 *   node scripts/build-config.mjs --check             verify both generated profiles
 *   node scripts/build-config.mjs --profile managed --catalog /root/catalog.json --out-dir /run/config
 * Source builds use npm run build to synchronize bundled contracts before profile assembly.
 *
 * Permission model (measured on 2.0.19): each agent has an ordered list of {action, resource, effect}; the LAST
 * matching rule wins; `*` matches any characters, `/` included; a new agent starts allow-all and the engine
 * prepends its own defaults. So every geology-layer agent starts with `*:* deny`, re-allows the engine's own
 * scratch folders, adds its allows, and ends with installs denied (specialists) and `execute` (Code Mode) denied.
 * Workspace file edits ask through ACP; own-run outputs are automatic. The run-dir plugin denies private state,
 * foreign runs and own _orchestrator records, and checks symlink containment for every editing agent.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { TOOL_SPECS } from "../config/lib/voxel-contract.js"
export { OPENCODE_VERSION } from "../config/lib/engine-identity.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")

const r = (action, resource = "*", effect = "allow") => ({ action, resource, effect })

/**
 * MCP tools per agent, by exact name. Derived from the fork's `mcpToolFilter` globs expanded
 * against the 56 tools of geocluster-mcp, minus three substring leaks the probe found (P8 F), each reassigned to
 * the agent the invariants' tool tables give it:
 *   transform `*log*`     matched validate_geology  (a DataOps diagnostic, "geoLOGy")
 *   analytics `*cluster*` matched plot_clusters     (a GeoViz plot)
 *   dataops   `*dataset*` matched merge_datasets    (a Section C transform)
 * A new MCP tool reaches no agent until it is added here or to UNASSIGNED_TOOLS (test: every tool is classified).
 */
export const AGENT_TOOLS = {
	geology: ["list_files", "check_missing", "summarize_provenance"],
	"report-analysis": ["list_files", "check_missing", "summarize_provenance"],
	dataops: [
		"check_missing", "detect_cleaning_issues", "inspect_dataset", "inspect_raster", "inspect_specific_columns",
		"query_data", "select_bands", "select_columns", "validate_geology", "verify_claims",
	],
	transform: [
		"aggregate", "band_math", "compute_gradient", "compute_ratios", "convert_dtype", "filter_rows", "fix_decimals",
		"log_transform", "melt", "merge_datasets", "normalize", "parse_detection_limits", "pivot", "remove_duplicates",
		"select_bands", "select_columns", "smooth", "standardize", "standardize_terms", "texture_features",
	],
	analytics: ["aggregate", "cluster", "compute_anomaly", "rank_by_metric", "reduce_dimensions", "threshold"],
	geoviz: ["plot_clusters", "plot_histogram", "plot_map", "plot_scatter"],
	voxel: ["list_files", "summarize_provenance"],
}

/** MCP tools deliberately unassigned: general tools plus the retired legacy voxel publisher. */
export const LEGACY_VOXEL_TOOLS = ["voxel_add_box", "voxel_add_line", "voxel_add_point", "voxel_export_bundle", "voxel_get_grid", "voxel_history", "voxel_init_grid", "voxel_list_layers", "voxel_probe_region", "voxel_set_layer_array", "voxel_upsert_geometry"]
export const UNASSIGNED_TOOLS = ["align_grids", "clip_to_extent", "export_artifact", "profile_geochem", "reproject", "resample", ...LEGACY_VOXEL_TOOLS]

/** The specialists the orchestrator may dispatch (L2-2), in the fork's routing order. */
export const SPECIALISTS = ["dataops", "transform", "analytics", "geoviz", "voxel", "extended"]

/** Package installers no agent but `extended` may run (L3-5, L4-1). Shell rules match the literal command text. */
export const INSTALLS = [
	"*pip install*", "*pip3 install*", "*-m pip*", "*uv pip*", "*uv add*", "*conda install*", "*mamba install*",
	"*apt-get*", "*apt install*", "*npm install*", "*npm i *", "*yarn add*", "*sudo*",
]

/** Data files Layer 1 and the orchestrator must not read whole (L1-1 context bloat): delegated to specialists. */
const DATA_EXTENSIONS = ["csv", "tsv", "xlsx", "xls", "parquet", "las"]

export const MANAGED_PROVIDER_ID = "proxy"
const SHARED_PLUGINS = ["pdf-read", "result-protocol", "run-dir", "tool-shape", "voxel-agent"]
const MANAGED_PLUGINS = ["account-attribution", ...SHARED_PLUGINS, "retry-policy"].sort()

// The engine discovers every file in <config>/plugins/ (in name order). Only the built-in patch plugin is disabled:
// its GPT-model hook removes write/edit, leaving transform without its whole-file writer after tool-shape filtering.
// A `plugins` entry that names a file is rejected ("configured plugin path must be a directory", 2.0.19).

// The engine's defaults allow its own scratch folders; `*:* deny` removes that, so they are re-allowed (a truncated
// tool output tells the model to read the rest from tool-output/).
const DENY_ALL = [
	r("*", "*", "deny"),
	r("external_directory", "{env:XDG_DATA_HOME}/opencode/tool-output/*"),
	r("external_directory", "{env:XDG_DATA_HOME}/opencode/shell/*/*"),
	r("external_directory", "/tmp/opencode/*"),
]
const NO_ENV = [r("read", "*.env", "deny"), r("read", "*.env.*", "deny")]
const READ_ALL = [r("read"), ...NO_ENV]
// both cases: the engine's wildcard match is case-sensitive on Linux, and exports often arrive as DATA.CSV
const READ_NO_DATA = [...READ_ALL, ...DATA_EXTENSIONS.flatMap((ext) => [r("read", `*.${ext}`, "deny"), r("read", `*.${ext.toUpperCase()}`, "deny")])]
const FIND = [r("glob"), r("grep")]
// L1-1/L2-1: no grep for agents that must not read data. 2.0.19 checks a grep permission against the search PATTERN, not
// the path (core/src/tool/plugin/grep.ts), and grep returns matching lines, so `read` denies on *.csv don't cover it.
// glob returns file names only and stays.
const FIND_NAMES = [r("glob"), r("grep", "*", "deny")]
const NO_INSTALLS = INSTALLS.map((p) => r("shell", p, "deny"))
const EDIT_WORKSPACE = [r("edit", "*", "ask"), r("edit", "runs/*")]
const NO_CODE_MODE = [r("execute", "*", "deny")]
const NO_VOXELS = [...Object.keys(TOOL_SPECS), ...LEGACY_VOXEL_TOOLS.map((name) => `geocluster_${name}`)].map((name) => r(name, "*", "deny"))
// Built-in tools with no use in the headless runtime (2.0.19 tool list, 2026-10-01)
const NO_HEADLESS = [r("browser*", "*", "deny"), r("opencode_session_move", "*", "deny"), r("question", "*", "deny")]
const mcp = (agent) => AGENT_TOOLS[agent].map((tool) => r(`geocluster_${tool}`))
const PROCESSOR_TOOLS = [
	"processor_documents_submit", "processor_documents_get_job", "processor_documents_list_jobs",
	"processor_documents_cancel", "processor_documents_get_result", "processor_documents_read_table", "processor_documents_read_text",
]

function specialist(name, description, steps = 40) {
	return {
		description,
		mode: "subagent",
		system: `{file:./prompts/${name}.md}`,
		steps,
		permissions: [...DENY_ALL, ...READ_ALL, ...FIND, r("shell"), ...EDIT_WORKSPACE, ...mcp(name), ...NO_INSTALLS, ...NO_CODE_MODE],
	}
}

export function buildAgentConfig() {
	const agents = Object.fromEntries(["build", "plan", "general", "explore"].map((a) => [a, { disabled: true }]))
	agents.geology = {
		description: "Layer 1 Geology Agent: user-facing, read-only, delegates analysis to the orchestrator.",
		mode: "primary",
		system: "{file:./prompts/geology.md}",
		steps: 40,
		permissions: [...DENY_ALL, ...READ_NO_DATA, ...FIND_NAMES, ...mcp("geology"), r("subagent", "orchestrator"), ...NO_CODE_MODE],
	}
	agents["report-analysis"] = {
		description: "Report Analysis mode: answers one Mining-evals question over an extracted report; read-only like Layer 1.",
		mode: "primary",
		system: "{file:./prompts/report-analysis.md}",
		steps: 40,
		// RE-2: may read the extraction's tables (tables/<id>.csv) directly, so no data-file deny
		permissions: [...DENY_ALL, ...READ_ALL, ...FIND, ...mcp("report-analysis"), r("subagent", "orchestrator"), ...NO_CODE_MODE],
	}
	agents.standard = {
		description: "Standard mode: OpenCode's coding prompt outside the specialist system; canonical and legacy voxel tools remain denied.",
		mode: "primary",
		steps: 40,
		// No browser automation on a headless machine (about 45 browser_* tools of prompt bloat), no moving the session
		// out of the workspace, and no `question` (how ACP delivers it is unverified; the agent asks in its reply)
		permissions: [r("*"), ...NO_ENV, ...EDIT_WORKSPACE, r("subagent", "*", "deny"), r("external_directory", "*", "deny"), ...NO_HEADLESS, ...NO_CODE_MODE, ...NO_VOXELS],
	}
	agents.orchestrator = {
		description: "Layer 2 Analysis Orchestrator: plans and dispatches specialists; never touches data itself.",
		mode: "subagent",
		system: "{file:./prompts/orchestrator.md}",
		steps: 60,
		permissions: [...DENY_ALL, ...READ_NO_DATA, ...FIND_NAMES, ...SPECIALISTS.map((s) => r("subagent", s)), ...NO_CODE_MODE],
	}
	agents.dataops = specialist("dataops", "Layer 3 DataOps specialist: inspects, validates, diagnoses cleaning issues, queries and verifies claims on datasets.")
	agents.transform = specialist("transform", "Layer 3 Transform specialist: normalise, reshape, merge, filter, clean; tool-first, scripts as fallback.")
	agents.analytics = specialist("analytics", "Layer 3 Analytics specialist: statistics, clustering, anomalies, dimensionality reduction, ranking.")
	agents.geoviz = specialist("geoviz", "Layer 3 GeoViz specialist: maps, scatter plots, histograms, cluster plots.")
	agents.voxel = specialist("voxel", "Layer 3 Voxel specialist: resolves, inspects, creates and revises canonical saved voxels.")
	agents.voxel.permissions.push(...Object.keys(TOOL_SPECS).map((name) => r(name)))
	agents.extended = {
		description: "Layer 4 Extended Capability agent: the only agent that may install packages; web research; custom scripts.",
		mode: "subagent",
		system: "{file:./prompts/extended.md}",
		steps: 30,
		// L4-1: shell without install denies; L4-2: no MCP rule, so `*:* deny` keeps every geocluster_* tool out
		permissions: [...DENY_ALL, ...READ_ALL, ...FIND, r("shell"), ...EDIT_WORKSPACE, r("edit", "environment.yaml"), r("webfetch"), r("websearch"), ...NO_CODE_MODE],
	}

	return structuredClone({
		plugins: ["-opencode.tool.patch"],
		default_agent: "geology",
		share: "disabled",
		update: "disable",
		snapshots: false,
		lsp: false,
		formatter: false,
		websearch: false,
		experimental: {
			subagent_depth: 3, // L1 → L2 → L3 → L4
		},
		agents,
	})
}

/** Local services carry transport addresses, never model eligibility or supplier credentials. */
export function buildNativeConfig(localServices = {}) {
	const config = buildAgentConfig()
	config.plugins.push(...SHARED_PLUGINS.map((name) => `./plugins/${name}`))
	config.mcp = { servers: { geocluster: {
		type: "remote", url: localServices.mcpURL ?? "{env:GEOCLUSTER_MCP_URL}", oauth: false, codemode: false,
		// Observation only. A cancelled shared-MCP thread may continue computing.
		timeout: { startup: 30000, catalog: 30000, execution: 4 * 60 * 60 * 1000 },
	} } }
	if (localServices.processing) {
		const { url, token } = localServices.processing
		// Separate namespace: geocluster's run-directory hook injects arguments this API does not accept.
		config.mcp.servers.processor = {
			type: "remote", url, oauth: false, codemode: false,
			headers: { Authorization: `Bearer ${token}` },
			timeout: { startup: 30000, catalog: 30000, execution: 30000 },
		}
		config.agents.dataops.permissions.push(...PROCESSOR_TOOLS.map((tool) => r(tool)))
	}
	return config
}

/** Catalog has already passed the backend-discovery validator; it cannot supply route settings. */
export function buildManagedConfig(localServices = {}, catalog = { managed_models: {}, default_model_id: null }) {
	const config = buildNativeConfig({ mcpURL: localServices.mcpURL })
	config.plugins = ["-opencode.tool.patch", ...MANAGED_PLUGINS.map((name) => `./plugins/${name}`)]
	config.providers = { [MANAGED_PROVIDER_ID]: {
		name: "GeoCluster LLM proxy", package: "@opencode/ai/providers/openrouter",
		settings: { baseURL: localServices.managedProxyURL ?? "{env:LLM_PROXY_URL}", apiKey: "runtime-relay" },
		models: structuredClone(catalog.managed_models),
	} }
	config.experimental.policies = [r("provider.use", "*", "deny"), r("provider.use", MANAGED_PROVIDER_ID)]
	if (catalog.default_model_id !== null) {
		if (typeof catalog.default_model_id !== "string" || !Object.hasOwn(catalog.managed_models, catalog.default_model_id)) throw new Error("default_model_id must name an installed managed declaration or be null")
		config.model = `${MANAGED_PROVIDER_ID}/${catalog.default_model_id}`
		config.agents.title = { model: config.model }
	}
	return config
}

export const render = (config = buildNativeConfig()) => JSON.stringify(config, null, 2) + "\n"

/** Generate independent config roots. Explicit-file loading does not discover sibling plugin files. */
export function materializeProfile(profile, { directory = path.join(ROOT, "config", profile), sourceDirectory = path.join(ROOT, "config"), catalog, localServices, check = false } = {}) {
	if (!["native", "managed"].includes(profile)) throw new Error(`unknown profile: ${profile}`)
	const config = profile === "native" ? buildNativeConfig(localServices) : buildManagedConfig(localServices, catalog)
	const write = (file, text) => {
		if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return
		if (check) throw new Error(`stale: ${file} (run npm --prefix opencode run build)`)
		fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text)
	}
	write(path.join(directory, "opencode.json"), render(config))
	write(path.join(directory, "package.json"), '{"private":true,"type":"module"}\n')
	for (const name of profile === "native" ? SHARED_PLUGINS : MANAGED_PLUGINS) {
		const target = path.join(directory, "plugins", name)
		const source = path.relative(target, path.join(sourceDirectory, "plugins", `${name}.js`)).split(path.sep).join("/")
		write(path.join(target, "index.js"), `// GENERATED by scripts/build-config.mjs.\nexport { default } from ${JSON.stringify(source)}\n`)
		write(path.join(target, "package.json"), '{"private":true,"type":"module","main":"index.js"}\n')
	}
	// Prompt file substitutions are relative to the containing config document.
	for (const agent of Object.values(config.agents)) {
		if (!agent.system) continue
		const name = /^\{file:\.\/prompts\/(.+)\}$/.exec(agent.system)?.[1]
		if (name) write(path.join(directory, "prompts", name), fs.readFileSync(path.join(sourceDirectory, "prompts", name), "utf8"))
	}
	return { directory, config }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
	const options = { check: process.argv.includes("--check") }
	let profile, catalogPath = process.env.RUNTIME_MANAGED_CATALOG_PATH
	for (let i = 2; i < process.argv.length; i++) {
		const arg = process.argv[i]
		if (arg === "--check") continue
		if (!["--profile", "--catalog", "--out-dir"].includes(arg) || !process.argv[i + 1]) throw new Error(`invalid build option: ${arg}`)
		const value = process.argv[++i]
		if (arg === "--profile") profile = value
		else if (arg === "--catalog") catalogPath = value
		else options.directory = path.resolve(value)
	}
	if (profile && !["native", "managed"].includes(profile)) throw new Error(`unknown profile: ${profile}`)
	if (options.directory && !profile) throw new Error("--out-dir requires --profile")
	if (catalogPath && profile !== "native") options.catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"))
	for (const selected of profile ? [profile] : ["native", "managed"]) {
		const result = materializeProfile(selected, options)
		console.log(`${selected}: ${result.directory}/opencode.json`)
	}
}
