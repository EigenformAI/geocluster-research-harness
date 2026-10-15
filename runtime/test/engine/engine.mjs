/**
 * engine.mjs — run the REAL OpenCode engine (`opencode acp`, ACP over stdio) in an isolated sandbox and talk raw
 * JSON-RPC to it. No npm dependencies (Node >= 20).
 *
 *   import { startEngine } from "./engine.mjs"
 *   const engine = await startEngine({ sandbox: "/scratch/sb1", llmUrl: llm.url })
 *   await engine.initialize()
 *   const sid = await engine.newSession("geology")
 *   const turn = await engine.turn(sid, "SAY hello")     // {stopReason, text, error, ms, since, until}
 *   await engine.stop()
 *
 * The sandbox is prepared once (config copy, HOME, XDG_*, ws/). Starting again on the same sandbox keeps the engine
 * database ($XDG_DATA_HOME/opencode/opencode.db), so restart/resume (session/load) can be tested. Each start logs
 * to <sandbox>/logs/start-<n>/{frames.ndjson,stderr.log}.
 *
 * Only `opencode acp` is ever executed (any other CLI command without --standalone starts a background service).
 * `acp` starts a private `opencode serve --stdio` child; stop() ends both by PID and waits for them to exit.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { materializeProfile } from "../../../opencode/scripts/build-config.mjs"
import { TEST_MANAGED_CATALOG } from "./managed-fixture.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))

/** The engine binary: $OPENCODE_BIN, else where the image installs it (lib/config.js uses the same default). */
export const OPENCODE_BIN = process.env.OPENCODE_BIN || "/usr/local/bin/opencode"
/** The repo's engine config (geocluster-ai-ide-BE/opencode/config), i.e. OPENCODE_CONFIG_DIR in the image. */
export const CONFIG_DIR = path.resolve(here, "../../../opencode/config")
export const DEFAULT_MODEL = "proxy/openai/gpt-6-luna"
export const CLOSED_MCP_URL = "http://127.0.0.1:9/mcp" // discard port: nothing listens → geocluster_* tools absent

export class RpcError extends Error {
	constructor(method, error) {
		super(`${method}: ${error?.message ?? "error"} (${error?.code})`)
		this.method = method
		this.code = error?.code
		this.data = error?.data
		this.rpc = error
	}
}

// ---- /proc helpers (Linux) ---------------------------------------------------------------------------------------

/** {pid, ppid, state, start, cmd} of a live process, or null. `start` (clock ticks since boot) guards against reuse. */
export function procInfo(pid) {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
		const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
		let cmd = ""
		try {
			cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ")
		} catch {}
		return { pid, state: rest[0], ppid: Number(rest[1]), start: rest[19], cmd }
	} catch {
		return null
	}
}

/** Every live descendant of `pid` (depth-first), as procInfo records. */
export function descendants(pid) {
	const all = []
	for (const d of fs.readdirSync("/proc")) if (/^\d+$/.test(d)) all.push(procInfo(Number(d)))
	const byParent = new Map()
	for (const p of all) if (p) (byParent.get(p.ppid) ?? byParent.set(p.ppid, []).get(p.ppid)).push(p)
	const out = []
	const walk = (ppid) => {
		for (const c of byParent.get(ppid) ?? []) {
			out.push(c)
			walk(c.pid)
		}
	}
	walk(pid)
	return out
}

/** True while the process (same pid AND start time) exists and isn't a zombie. */
export function alive(p) {
	const now = p && procInfo(p.pid)
	return !!now && now.start === p.start && now.state !== "Z"
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const test = (pred, x) => {
	try {
		return !!pred(x)
	} catch {
		return false // a predicate that throws on an unexpected frame shape just doesn't match
	}
}

// ---- sandbox -----------------------------------------------------------------------------------------------------

/** Create the sandbox layout once; returns its paths. Idempotent: never wipes the database or the workspace. */
export function prepareSandbox(sandbox, { configDir = CONFIG_DIR, profile = "managed", catalog = TEST_MANAGED_CATALOG } = {}) {
	const p = {
		root: sandbox,
		ws: path.join(sandbox, "ws"),
		home: path.join(sandbox, "home"),
		config: path.join(sandbox, "config"),
		xdg: { data: path.join(sandbox, "xdg/data"), config: path.join(sandbox, "xdg/config"), state: path.join(sandbox, "xdg/state"), cache: path.join(sandbox, "xdg/cache") },
		logs: path.join(sandbox, "logs"),
	}
	for (const d of [p.ws, p.home, p.logs, ...Object.values(p.xdg)]) fs.mkdirSync(d, { recursive: true })
	if (!fs.existsSync(path.join(sandbox, ".harness-prepared"))) {
		fs.cpSync(configDir, p.config, { recursive: true })
		materializeProfile(profile, { directory: p.config, catalog })
		// Profile wrappers must use the sandbox copies: some integration fixtures
		// replace a local service adapter without altering the shipped plugin.
		const config = JSON.parse(fs.readFileSync(path.join(p.config, "opencode.json"), "utf8"))
		for (const entry of config.plugins.filter((value) => value.startsWith("./plugins/"))) {
			const name = path.basename(entry)
			fs.writeFileSync(path.join(p.config, entry, "index.js"), `export { default } from ${JSON.stringify(`../${name}.js`)}\n`)
		}
		fs.writeFileSync(path.join(sandbox, ".harness-prepared"), JSON.stringify({ configDir, at: new Date().toISOString() }) + "\n")
	}
	return p
}

// ---- engine ------------------------------------------------------------------------------------------------------

/**
 * Start `opencode acp` in `sandbox`. Options:
 *   sandbox       directory (created/prepared if needed)
 *   llmUrl        LLM_PROXY_URL (the fake LLM's url, ".../v1")
 *   mcpUrl        GEOCLUSTER_MCP_URL (default: a closed port)
 *   env           extra/overriding env vars
 *   configDir     source config copied into <sandbox>/config on first prepare (default: the repo's opencode/config)
 *   extraPlugins  {"zz-name.js": "<module source>" | null} written into (null: removed from) <sandbox>/config/plugins/
 *                 on this start; they persist in the sandbox for later starts. The engine loads plugins in name order
 *   bin           the opencode binary (default OPENCODE_BIN)
 *   stderrTail    in-memory stderr lines kept (default 5000)
 */
export async function startEngine({
	sandbox,
	llmUrl,
	mcpUrl = CLOSED_MCP_URL,
	env = {},
	configDir = CONFIG_DIR,
	extraPlugins = {},
	bin = OPENCODE_BIN,
	stderrTail = 5000,
	profile = "managed",
	catalog = TEST_MANAGED_CATALOG,
} = {}) {
	if (!sandbox) throw new Error("startEngine: sandbox is required")
	if (!llmUrl) throw new Error("startEngine: llmUrl is required (start the fake LLM first)")
	const paths = prepareSandbox(sandbox, { configDir, profile, catalog })
	for (const [name, source] of Object.entries(extraPlugins)) {
		const file = path.join(paths.config, "plugins", path.basename(name))
		if (source === null) fs.rmSync(file, { force: true }) // plugins persist in the sandbox; null removes one
		else {
			fs.writeFileSync(file, source)
			const directory = path.join(paths.config, "test-plugins", path.basename(name))
			fs.mkdirSync(directory, { recursive: true })
			fs.writeFileSync(path.join(directory, "index.js"), `export { default } from ${JSON.stringify(`../../plugins/${path.basename(name)}`)}\n`)
		}
	}
	const configFile = path.join(paths.config, "opencode.json")
	const config = JSON.parse(fs.readFileSync(configFile, "utf8"))
	for (const [name, source] of Object.entries(extraPlugins)) {
		const entry = `./test-plugins/${path.basename(name)}`
		config.plugins = config.plugins.filter((value) => value !== entry)
		if (source !== null) config.plugins.push(entry)
	}
	fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n")

	let n = 1
	while (fs.existsSync(path.join(paths.logs, `start-${n}`))) n++
	const logDir = path.join(paths.logs, `start-${n}`)
	fs.mkdirSync(logDir, { recursive: true })
	const framesFile = path.join(logDir, "frames.ndjson")
	const stderrFile = path.join(logDir, "stderr.log")
	const stderrOut = fs.createWriteStream(stderrFile, { flags: "a" })

	const fullEnv = {
		PATH: process.env.PATH,
		HOME: paths.home,
		XDG_DATA_HOME: paths.xdg.data,
		XDG_CONFIG_HOME: paths.xdg.config,
		XDG_STATE_HOME: paths.xdg.state,
		XDG_CACHE_HOME: paths.xdg.cache,
		OPENCODE_CONFIG: configFile,
		...(profile === "managed" ? {
			OPENCODE_MODELS_PATH: path.join(paths.config, "models-empty.json"),
			OPENCODE_CONFIG_PROJECT_DISABLE: "1",
			OPENCODE_DISABLE_PROJECT_CONFIG: "1",
			OPENCODE_DISABLE_MODELS_FETCH: "1",
			LLM_PROXY_URL: llmUrl,
		} : {}),
		OPENCODE_DISABLE_AUTOUPDATE: "1",
		OPENCODE_PRINT_LOGS: "1",
		GEOCLUSTER_MCP_URL: mcpUrl,
		...env,
	}

	const spawnedAt = Date.now()
	const child = spawn(bin, ["acp"], { cwd: paths.ws, env: fullEnv, stdio: ["pipe", "pipe", "pipe"] })
	await new Promise((resolve, reject) => {
		child.once("spawn", resolve)
		child.once("error", reject)
	})
	const acp = procInfo(child.pid) ?? { pid: child.pid }
	child.stdin.on("error", (e) => stderrOut.write(`[harness] stdin error: ${e.message}\n`)) // EPIPE after a crash

	const frames = []
	const frameWaiters = new Set()
	const pending = new Map()
	const stderrLines = []
	const stderrTimed = [] // {t, ms, line}: the same lines with arrival time (ms since spawn)
	const stderrListeners = new Set()
	let nextId = 1
	let exitInfo = null
	let server = null // procInfo of the private `serve --stdio` child, once seen

	const record = (dir, msg, raw) => {
		const f = { t: Date.now(), ms: Date.now() - spawnedAt, dir, ...(msg ? { msg } : { raw }) }
		frames.push(f)
		fs.appendFileSync(framesFile, JSON.stringify(f) + "\n")
		for (const w of frameWaiters) if (test(w.pred, f)) (frameWaiters.delete(w), clearTimeout(w.timer), w.resolve(f))
		return f
	}
	const send = (msg) => {
		const full = { jsonrpc: "2.0", ...msg }
		record("out", full)
		if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(full) + "\n")
	}

	const defaultRequestHandler = (msg) => {
		if (msg.method === "session/request_permission") {
			const option = msg.params?.options?.find((o) => String(o.kind).startsWith("allow")) ?? msg.params?.options?.[0]
			return { outcome: { outcome: "selected", optionId: option?.optionId } }
		}
		throw { code: -32601, message: `harness: method not found: ${msg.method}` }
	}
	let requestHandler = defaultRequestHandler

	async function handleRequest(msg) {
		try {
			const result = await requestHandler(msg, defaultRequestHandler)
			send({ id: msg.id, result: result ?? null })
		} catch (e) {
			send({ id: msg.id, error: { code: e?.code ?? -32603, message: e?.message ?? String(e), ...(e?.data ? { data: e.data } : {}) } })
		}
	}

	let buf = ""
	child.stdout.on("data", (d) => {
		buf += d
		let i
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i)
			buf = buf.slice(i + 1)
			if (!line.trim()) continue
			let msg
			try {
				msg = JSON.parse(line)
			} catch {
				record("in", null, line)
				continue
			}
			record("in", msg)
			if (msg.method && msg.id !== undefined) handleRequest(msg)
			else if (msg.id !== undefined && pending.has(msg.id)) {
				const w = pending.get(msg.id)
				pending.delete(msg.id)
				clearTimeout(w.timer)
				w.resolve(msg)
			}
		}
	})
	let ebuf = ""
	child.stderr.on("data", (d) => {
		stderrOut.write(d)
		ebuf += d
		let i
		while ((i = ebuf.indexOf("\n")) >= 0) {
			const line = ebuf.slice(0, i)
			ebuf = ebuf.slice(i + 1)
			stderrLines.push(line)
			stderrTimed.push({ t: Date.now(), ms: Date.now() - spawnedAt, line })
			if (stderrLines.length > stderrTail) stderrLines.splice(0, stderrLines.length - stderrTail)
			if (stderrTimed.length > stderrTail) stderrTimed.splice(0, stderrTimed.length - stderrTail)
			for (const l of stderrListeners) l(line)
		}
	})
	const exited = new Promise((resolve) =>
		child.once("exit", (code, signal) => {
			exitInfo = { code, signal, ms: Date.now() - spawnedAt }
			for (const [, w] of pending) (clearTimeout(w.timer), w.resolve({ error: { code: "ENGINE_EXIT", message: `engine exited (${code ?? signal})` } }))
			pending.clear()
			resolve(exitInfo)
		}),
	)

	/** Raw response {result}|{error}|{timeout: true}. Never throws. */
	function callRaw(method, params, { timeoutMs = 60000 } = {}) {
		if (exitInfo) return Promise.resolve({ error: { code: "ENGINE_EXIT", message: "engine not running" } })
		const id = nextId++
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				pending.delete(id)
				resolve({ timeout: true, method, timeoutMs })
			}, timeoutMs)
			pending.set(id, { resolve, timer, method })
			send({ id, method, params })
		})
	}
	/** Result of `method`; throws RpcError on a JSON-RPC error, Error on timeout. */
	async function call(method, params, opts) {
		const r = await callRaw(method, params, opts)
		if (r.timeout) throw Object.assign(new Error(`${method}: no response in ${r.timeoutMs} ms`), { code: "TIMEOUT" })
		if (r.error) throw new RpcError(method, r.error)
		return r.result
	}
	const notify = (method, params) => send({ method, params })

	function waitFor(pred, timeoutMs = 30000, { since = 0 } = {}) {
		for (let i = since; i < frames.length; i++) if (test(pred, frames[i])) return Promise.resolve(frames[i])
		return new Promise((resolve, reject) => {
			const w = { pred, resolve }
			w.timer = setTimeout(() => {
				frameWaiters.delete(w)
				reject(Object.assign(new Error(`waitFor: no matching frame in ${timeoutMs} ms`), { code: "TIMEOUT" }))
			}, timeoutMs)
			frameWaiters.add(w)
		})
	}

	function serverPid() {
		if (server && alive(server)) return server.pid
		server = descendants(acp.pid).find((p) => p.ppid === acp.pid && / serve\b/.test(p.cmd)) ?? null
		return server?.pid ?? null
	}

	/**
	 * End acp and everything under it, by PID. Sends `signal` to acp, waits `graceMs` for the whole tree to go,
	 * then SIGTERM, then SIGKILL to whatever is left. Returns {exit, ms, tree, forced}. On 2.0.19 SIGTERM alone
	 * suffices: acp exits with code 130 and its server goes with it (forced stays empty).
	 */
	async function stop({ signal = "SIGTERM", graceMs = 3000 } = {}) {
		const t = Date.now()
		const tree = alive(acp) ? [acp, ...descendants(acp.pid)] : server ? [server] : []
		if (server && !tree.some((p) => p.pid === server.pid)) tree.push(server) // e.g. acp already gone, server orphaned
		const forced = []
		const waitGone = async (ms) => {
			const until = Date.now() + ms
			while (Date.now() < until && tree.some(alive)) await sleep(50)
		}
		if (alive(acp)) {
			try {
				process.kill(acp.pid, signal)
			} catch {}
		}
		await waitGone(graceMs)
		for (const sig of ["SIGTERM", "SIGKILL"]) {
			const left = tree.filter(alive)
			if (!left.length) break
			for (const p of left) {
				try {
					process.kill(p.pid, sig)
					forced.push({ pid: p.pid, cmd: p.cmd.slice(0, 80), signal: sig })
				} catch {}
			}
			await waitGone(sig === "SIGTERM" ? 2000 : 1000)
		}
		const exit = exitInfo ?? (await Promise.race([exited, sleep(1000).then(() => null)]))
		stderrOut.end()
		return { exit, ms: Date.now() - t, tree: tree.map((p) => ({ pid: p.pid, cmd: p.cmd?.slice(0, 80), alive: alive(p) })), forced }
	}

	/** Kill only the private server while leaving its ACP parent alive. */
	function killServer(signal = "SIGKILL") {
		const pid = serverPid()
		if (pid) process.kill(pid, signal)
		return pid
	}

	const sessions = new Map()

	/** End acp's stdin (EOF), e.g. to observe whether acp exits when its client goes away. */
	function closeStdin() {
		if (!child.stdin.destroyed) child.stdin.end()
	}
	/** Send `sig` to acp only (not its server); returns false if acp is gone. */
	function signal(sig = "SIGTERM") {
		if (!alive(acp)) return false
		try {
			process.kill(acp.pid, sig)
			return true
		} catch {
			return false
		}
	}

	const engine = {
		pid: acp.pid,
		acpProc: acp,
		closeStdin,
		signal,
		isAlive: () => alive(acp),
		paths,
		logDir,
		framesFile,
		stderrFile,
		frames,
		sessions,
		spawnedAt,
		get exitInfo() {
			return exitInfo
		},
		exited,
		call,
		callRaw,
		notify,
		waitFor,
		onRequest(handler) {
			requestHandler = handler ?? defaultRequestHandler
		},
		defaultRequestHandler,
		stderr: {
			file: stderrFile,
			tail: (n = 50) => stderrLines.slice(-n),
			lines: stderrLines,
			timed: stderrTimed,
			onLine(fn) {
				stderrListeners.add(fn)
				return () => stderrListeners.delete(fn)
			},
		},
		serverPid,
		killServer,
		stop,

		/** initialize with the child-session capability. */
		initialize(withChildUpdates = true, { timeoutMs = 30000 } = {}) {
			return call(
				"initialize",
				{
					protocolVersion: 1,
					clientCapabilities: {
						fs: { readTextFile: false, writeTextFile: false },
						terminal: false,
						...(withChildUpdates ? { _meta: { "opencode/child-session-updates": true } } : {}),
					},
				},
				{ timeoutMs },
			)
		},

		/** session/new, then session/set_mode (agent) and, when given, set_config_option model. Returns the sessionId. */
		async newSession(agent, model, { timeoutMs = 30000 } = {}) {
			const created = await call("session/new", { cwd: paths.ws, mcpServers: [] }, { timeoutMs })
			const sessionId = created.sessionId
			if (agent) await call("session/set_mode", { sessionId, modeId: agent }, { timeoutMs })
			if (model) await call("session/set_config_option", { sessionId, configId: "model", value: model }, { timeoutMs })
			sessions.set(sessionId, { agent, model, created })
			return sessionId
		},

		/** session/load (after a restart on the same sandbox). */
		loadSession(sessionId, { timeoutMs = 60000 } = {}) {
			return call("session/load", { sessionId, cwd: paths.ws, mcpServers: [] }, { timeoutMs })
		},

		/** session/prompt with one text block. Returns the ACP result ({stopReason, …}); throws RpcError. */
		prompt(sessionId, text, { timeoutMs = 120000 } = {}) {
			return call("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, { timeoutMs })
		},

		cancel(sessionId) {
			notify("session/cancel", { sessionId })
		},

		/** A prompt plus what it streamed. Never throws: {stopReason, error, timeout, text, ms, since, until}. */
		async turn(sessionId, text, { timeoutMs = 120000 } = {}) {
			const since = frames.length
			const t = Date.now()
			const r = await callRaw("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, { timeoutMs })
			const until = frames.length
			return {
				stopReason: r.result?.stopReason ?? null,
				result: r.result ?? null,
				error: r.error ?? null,
				timeout: !!r.timeout,
				text: engine.agentText(sessionId, { since, until }),
				ms: Date.now() - t,
				since,
				until,
			}
		},

		/** session/update params for one session (root), optionally in a frame range. */
		updates(sessionId, { since = 0, until = frames.length } = {}) {
			return frames
				.slice(since, until)
				.filter((f) => f.dir === "in" && f.msg?.method === "session/update" && f.msg.params?.sessionId === sessionId)
				.map((f) => ({ ms: f.ms, ...f.msg.params.update }))
		},

		/** Concatenated agent_message_chunk text of a root session. */
		agentText(sessionId, range) {
			return engine
				.updates(sessionId, range)
				.filter((u) => u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text")
				.map((u) => u.content.text)
				.join("")
		},

		/** opencode child_update params for a root session (both method spellings). */
		childUpdates(rootSessionId, { since = 0, until = frames.length } = {}) {
			return frames
				.slice(since, until)
				.filter((f) => f.dir === "in" && /^_?opencode\/session\/child_update$/.test(f.msg?.method ?? "") && f.msg.params?.rootSessionId === rootSessionId)
				.map((f) => ({ ms: f.ms, method: f.msg.method, ...f.msg.params }))
		},
	}
	return engine
}
