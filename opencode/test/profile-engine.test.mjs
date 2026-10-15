import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn, execFileSync } from "node:child_process"
import { test } from "node:test"
import { materializeProfile, OPENCODE_VERSION } from "../scripts/build-config.mjs"

const bin = process.env.OPENCODE_BIN
const declaration = { name: "Operator model", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 24000, input: 16000, output: 4000 }, variants: [] }
const catalog = { managed_models: { "new/maker/model": declaration }, default_model_id: "new/maker/model" }

async function engine(t, profile, { projectConfig, catalog: installedCatalog = catalog } = {}) {
	assert.equal(execFileSync(bin, ["--version"], { encoding: "utf8" }).trim(), `opencode v${OPENCODE_VERSION}`)
	const root = await fs.mkdtemp("/tmp/opencode/profile-engine-")
	for (const name of ["home", "data", "user/opencode", "state", "cache", "ws"]) await fs.mkdir(path.join(root, name), { recursive: true })
	const user = { model: "personal/operator-choice", providers: {
		personal: { package: "@opencode/ai/providers/openrouter", settings: { apiKey: "fixture", baseURL: "http://127.0.0.1:9/native" }, models: { "operator-choice": declaration } },
		proxy: { package: "@opencode/ai/providers/openai-compatible", settings: { apiKey: "untrusted", baseURL: "http://untrusted.invalid/user" }, models: { "untrusted": declaration } },
	} }
	await fs.writeFile(path.join(root, "user/opencode/opencode.json"), JSON.stringify(user))
	if (projectConfig) await fs.writeFile(path.join(root, "ws/opencode.json"), JSON.stringify(projectConfig))
	const directory = path.join(root, "bundled")
	materializeProfile(profile, { directory, catalog: installedCatalog, localServices: { mcpURL: "http://127.0.0.1:9/mcp", managedProxyURL: "http://127.0.0.1:9/relay" } })
	const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
		cwd: path.join(root, "ws"), stdio: ["ignore", "pipe", "pipe"],
		env: { PATH: process.env.PATH, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "user"), XDG_DATA_HOME: path.join(root, "data"), XDG_STATE_HOME: path.join(root, "state"), XDG_CACHE_HOME: path.join(root, "cache"),
			// This fixture suppresses network discovery only; native launch configuration must not do so.
			OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_PASSWORD: "fixture", OPENCODE_CONFIG: path.join(directory, "opencode.json"),
			...(profile === "managed" ? { OPENCODE_CONFIG_DIR: directory, OPENCODE_CONFIG_PROJECT_DISABLE: "1" } : {}),
		},
	})
	let stderr = "", output = "", url
	child.stderr.on("data", (data) => { stderr += data })
	child.stdout.on("data", (data) => { output += data; url = /server listening on (http:\/\/[^\s]+)/.exec(output)?.[1] })
	const exited = new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject) })
	t.after(async () => {
		child.kill("SIGTERM")
		const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
		try { await exited } finally { clearTimeout(timer) }
		await fs.rm(root, { recursive: true, force: true })
	})
	const get = async (endpoint) => {
		if (!url) throw new Error("waiting for server address")
		const result = await fetch(`${url}${endpoint}`, { headers: { authorization: `Basic ${Buffer.from("opencode:fixture").toString("base64")}` } })
		if (!result.ok) throw new Error(`${endpoint}: ${result.status} ${await result.text()}`)
		return result.json()
	}
	for (let n = 0; n < 200; n++) {
		try { await get("/api/location"); break } catch (error) { if (n === 199 || child.exitCode !== null) throw new Error(`${error.message}\n${stderr}`) }
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	for (let n = 0; n < 200; n++) {
		const plugins = (await get("/api/plugin")).data
		assert.deepEqual(plugins.filter((plugin) => plugin.state.status === "failed"), [])
		if (plugins.some((plugin) => plugin.id === "geocluster-run-dir")) return { get, plugins }
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	throw new Error(`plugins did not activate: ${stderr}`)
}

test("pinned engine: native explicit config retains ordinary user model/providers and loads only native plugins", { skip: !bin }, async (t) => {
	const { get, plugins } = await engine(t, "native")
	const selected = (await get("/api/model/default")).data
	assert.equal(selected.providerID, "personal"); assert.equal(selected.id, "operator-choice")
	assert.ok(!plugins.some((plugin) => /geocluster-(account-attribution|retry-policy)/.test(plugin.id)))
	assert.equal((await get("/api/provider/personal")).data.settings.baseURL, "http://127.0.0.1:9/native")
})

test("pinned engine: managed protected root excludes user/project route redirection", { skip: !bin }, async (t) => {
	const { get, plugins } = await engine(t, "managed", { projectConfig: { model: "personal/operator-choice", providers: { proxy: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "http://untrusted.invalid/project" } } } } })
	const provider = (await get("/api/provider/proxy")).data
	assert.equal(provider.package, "@opencode/ai/providers/openrouter")
	assert.equal(provider.settings.baseURL, "http://127.0.0.1:9/relay")
	assert.equal((await get("/api/model/default")).data.id, "new/maker/model")
	assert.deepEqual((await get("/api/model")).data.map((model) => `${model.providerID}/${model.id}`), ["proxy/new/maker/model"])
	assert.ok(plugins.some((plugin) => plugin.id === "geocluster-account-attribution"))
})

test("pinned engine: native project discovery can override the operator's user model selection", { skip: !bin }, async (t) => {
	const { get } = await engine(t, "native", { projectConfig: { model: "personal/project-choice", providers: { personal: { models: { "project-choice": declaration } } } } })
	const selected = (await get("/api/model/default")).data
	assert.equal(selected.providerID, "personal"); assert.equal(selected.id, "project-choice")
})

test("pinned engine: empty managed catalog has no fabricated model or native fallback", { skip: !bin }, async (t) => {
	const { get } = await engine(t, "managed", { catalog: { managed_models: {}, default_model_id: null } })
	assert.equal((await get("/api/model/default")).data, null)
	assert.deepEqual((await get("/api/model")).data, [])
})
