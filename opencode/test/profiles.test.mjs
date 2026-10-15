import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import * as assembly from "../scripts/build-config.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const declaration = {
	name: "A newly qualified backend model",
	capabilities: { tools: true, input: ["text"], output: ["text"] },
	limit: { context: 24000, input: 16000, output: 4000 },
	variants: [],
}
const catalog = { managed_models: { "unknown/maker/new-model": declaration }, default_model_id: "unknown/maker/new-model" }

test("native composition preserves shared geology behavior without imposing managed model resolution", () => {
	const native = assembly.buildNativeConfig({ mcpURL: "http://127.0.0.1:4567/mcp" })
	assert.deepEqual(native.agents, assembly.buildAgentConfig().agents)
	for (const field of ["model", "small_model", "providers"]) assert.equal(Object.hasOwn(native, field), false, field)
	assert.equal(native.experimental.policies, undefined)
	assert.equal(native.mcp.servers.geocluster.url, "http://127.0.0.1:4567/mcp")
	assert.ok(native.plugins.includes("./plugins/run-dir"))
	assert.ok(!native.plugins.some((entry) => /account-attribution|retry-policy/.test(entry)))
	for (const agent of Object.values(native.agents)) assert.equal(agent.model, undefined)
	native.agents.geology.permissions[0].effect = "allow"
	assert.equal(assembly.buildNativeConfig().agents.geology.permissions[0].effect, "deny", "callers cannot mutate future assemblies")
})

test("native CLI assembly ignores stale managed catalog settings; managed CLI consumes only the supplied catalog", () => {
	const directory = fs.mkdtempSync("/tmp/opencode/profile-build-")
	try {
		execFileSync(process.execPath, [path.join(root, "scripts/build-config.mjs"), "--profile", "native", "--out-dir", path.join(directory, "native")], { env: { ...process.env, RUNTIME_MANAGED_CATALOG_PATH: "/nonexistent/stale-managed-catalog.json" } })
		const native = JSON.parse(fs.readFileSync(path.join(directory, "native/opencode.json"), "utf8"))
		assert.equal(native.providers, undefined)
		fs.writeFileSync(path.join(directory, "catalog.json"), JSON.stringify(catalog))
		execFileSync(process.execPath, [path.join(root, "scripts/build-config.mjs"), "--profile", "managed", "--catalog", path.join(directory, "catalog.json"), "--out-dir", path.join(directory, "managed")])
		const managed = JSON.parse(fs.readFileSync(path.join(directory, "managed/opencode.json"), "utf8"))
		assert.deepEqual(managed.providers.proxy.models, catalog.managed_models)
		assert.equal(managed.agents.title.model, "proxy/unknown/maker/new-model")
	} finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test("deployed generator needs only its bundled config and can materialize a separate protected config root", async () => {
	const directory = fs.mkdtempSync("/tmp/opencode/profile-deployed-")
	try {
		const bundle = path.join(directory, "opt", "opencode"), output = path.join(directory, "run", "protected", "managed")
		fs.mkdirSync(path.join(bundle, "scripts"), { recursive: true })
		fs.cpSync(path.join(root, "scripts/build-config.mjs"), path.join(bundle, "scripts/build-config.mjs"))
		fs.cpSync(path.join(root, "config"), path.join(bundle, "config"), { recursive: true })
		const snapshot = (relative) => fs.readdirSync(path.join(bundle, "config", relative), { recursive: true }).sort().filter((name) => fs.statSync(path.join(bundle, "config", relative, name)).isFile()).map((name) => [name, fs.readFileSync(path.join(bundle, "config", relative, name), "utf8")])
		const before = [snapshot("lib"), snapshot("plugins")]
		const catalogFile = path.join(directory, "validated-catalog.json")
		fs.writeFileSync(catalogFile, JSON.stringify(catalog))
		execFileSync(process.execPath, [path.join(bundle, "scripts/build-config.mjs"), "--profile", "managed", "--catalog", catalogFile, "--out-dir", output])
		assert.deepEqual([snapshot("lib"), snapshot("plugins")], before, "deployment never resynchronizes shared source libraries/plugins")
		const config = JSON.parse(fs.readFileSync(path.join(output, "opencode.json"), "utf8"))
		for (const plugin of config.plugins.filter((entry) => entry.startsWith("./"))) {
			const loaded = await import(path.join(output, plugin, "index.js"))
			assert.equal(typeof loaded.default.setup, "function", plugin)
		}
		for (const agent of Object.values(config.agents).filter((agent) => agent.system)) {
			const reference = /^\{file:(.+)\}$/.exec(agent.system)[1]
			assert.equal(fs.readFileSync(path.resolve(output, reference), "utf8"), fs.readFileSync(path.resolve(bundle, "config", reference), "utf8"))
		}
	} finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test("managed composition installs only supplied declarations and fixed routing; auxiliaries cannot select another funding source", () => {
	const input = structuredClone(catalog)
	const managed = assembly.buildManagedConfig({ managedProxyURL: "http://127.0.0.1:9876/v1" }, input)
	assert.deepEqual(input, catalog, "composition does not mutate validated discovery")
	assert.deepEqual(managed.providers.proxy.models, catalog.managed_models)
	assert.equal(managed.providers.proxy.package, "@opencode/ai/providers/openrouter")
	assert.equal(managed.providers.proxy.settings.baseURL, "http://127.0.0.1:9876/v1")
	assert.equal(managed.model, "proxy/unknown/maker/new-model")
	assert.equal(managed.agents.title.model, managed.model)
	assert.equal(managed.small_model, undefined)
	for (const [id, agent] of Object.entries(managed.agents)) if (id !== "title") assert.equal(agent.model, undefined, `${id} inherits session selection`)
	assert.deepEqual(managed.experimental.policies, [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "proxy", effect: "allow" }])
	const empty = assembly.buildManagedConfig({}, { managed_models: {}, default_model_id: null })
	assert.equal(Object.hasOwn(empty, "model"), false)
	assert.equal(empty.agents.title?.model, undefined)
	assert.deepEqual(empty.providers.proxy.models, {})
})

test("profile directories materialize only intended plugins and can be loaded through an explicit config file", async () => {
	for (const profile of ["native", "managed"]) {
		const directory = path.join(root, "config", profile)
		const config = JSON.parse(fs.readFileSync(path.join(directory, "opencode.json"), "utf8"))
		const entries = fs.readdirSync(path.join(directory, "plugins"))
		assert.equal(entries.includes("account-attribution"), profile === "managed")
		assert.equal(entries.includes("retry-policy"), profile === "managed")
		for (const plugin of config.plugins.filter((entry) => entry.startsWith("./"))) {
			const loaded = await import(path.join(directory, plugin, "index.js"))
			assert.equal(typeof loaded.default.setup, "function", plugin)
		}
	}
})
