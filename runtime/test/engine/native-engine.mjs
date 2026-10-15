/** HTTP adapter for native connection APIs; no gateway, managed credentials, or host account state. */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { OPENCODE_BIN, prepareSandbox, procInfo, descendants, alive } from "./engine.mjs"

export const NATIVE_PROVIDER = "personal"
export const NATIVE_MODEL = "new-maker/research/slash-model"
export const NATIVE_ALTERNATE = "new-maker/text-only"
export const nativeDeclaration = (output = 1024) => ({
	name: "Scripted native text model", capabilities: { tools: true, input: ["text"], output: ["text"] },
	limit: { context: 12000, input: 10000, output }, variants: [],
})
export const modelRef = (id = NATIVE_MODEL, providerID = NATIVE_PROVIDER) => ({ providerID, id })
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export async function until(fn, label, ms = 20000) {
	const end = Date.now() + ms
	let last
	while (Date.now() < end) {
		try { const value = await fn(); if (value) return value } catch (error) { last = error }
		await sleep(50)
	}
	throw new Error(`${label}: deadline ${ms}ms${last ? `: ${last.message}` : ""}`)
}

export function writeNativeUserConfig(paths, llmUrl, { model = NATIVE_MODEL } = {}) {
	const directory = path.join(paths.xdg.config, "opencode")
	fs.mkdirSync(directory, { recursive: true })
	fs.writeFileSync(path.join(directory, "opencode.json"), JSON.stringify({
		model: `${NATIVE_PROVIDER}/${model}`,
		providers: { [NATIVE_PROVIDER]: {
			name: "Scripted personal connection", package: "@opencode/ai/providers/openrouter",
			settings: { baseURL: llmUrl },
			models: { [NATIVE_MODEL]: nativeDeclaration(), [NATIVE_ALTERNATE]: nativeDeclaration(512) },
		} },
	}))
}

export async function startNativeServer({ sandbox, paths = prepareSandbox(sandbox, { profile: "native" }), bin = OPENCODE_BIN, profile = "native" } = {}) {
	const password = randomBytes(24).toString("hex")
	const env = {
		PATH: process.env.PATH, LANG: "C.UTF-8", HOME: paths.home,
		XDG_DATA_HOME: paths.xdg.data, XDG_CONFIG_HOME: paths.xdg.config,
		XDG_STATE_HOME: paths.xdg.state, XDG_CACHE_HOME: paths.xdg.cache,
		OPENCODE_CONFIG: path.join(paths.config, "opencode.json"),
		OPENCODE_DISABLE_AUTOUPDATE: "1", GEOCLUSTER_MCP_URL: "http://127.0.0.1:9/mcp",
		OPENCODE_SERVER_PASSWORD: password,
		...(profile === "managed" ? {
			OPENCODE_MODELS_PATH: path.join(paths.config, "models-empty.json"),
			OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
		} : {}),
	}
	const output = fs.openSync(path.join(paths.logs, `native-${Date.now()}.log`), "a")
	let base, stdout = ""
	const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
		cwd: paths.ws, env, stdio: ["ignore", "pipe", output],
	})
	child.stdout.on("data", (data) => {
		fs.writeSync(output, data)
		stdout += data
		base = /server listening on (http:\/\/[^\s]+)/.exec(stdout)?.[1]
	})
	const tree = []
	const track = () => {
		for (const p of [procInfo(child.pid), ...descendants(child.pid)]) if (p && !tree.some((v) => v.pid === p.pid && v.start === p.start)) tree.push(p)
	}
	const timer = setInterval(track, 100)
	let stopped = false
	async function api(route, { method = "GET", body, scoped = true } = {}) {
		const url = new URL(route, base)
		if (scoped) url.searchParams.set("location[directory]", paths.ws)
		const response = await fetch(url, { method, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, ...(body ? { "content-type": "application/json" } : {}) },
			...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) })
		const text = await response.text()
		assert.ok(response.ok, `${method} ${url.pathname}: ${response.status} ${text}`)
		return text ? JSON.parse(text) : null
	}
	async function stop() {
		if (stopped) return
		stopped = true
		track(); clearInterval(timer)
		child.kill("SIGTERM")
		try { await until(() => tree.every((p) => !alive(p)), "native server tree exit", 5000) }
		finally { for (const p of tree.filter(alive)) process.kill(p.pid, "SIGKILL"); fs.closeSync(output) }
	}
	try { await until(() => base && api("/api/info"), "native HTTP server") }
	catch (error) { await stop(); throw error }
	return { api, stop, paths, child, env,
		async create(agent = "geology") {
			return (await api("/api/session", { method: "POST", body: { agent, location: { directory: paths.ws } } })).data.id
		},
		async idle() { await until(async () => !Object.keys((await api("/api/session/active")).data).length, "native idle", 30000) },
		async messages(id) { return (await api(`/api/session/${id}/message`)).data },
	}
}
