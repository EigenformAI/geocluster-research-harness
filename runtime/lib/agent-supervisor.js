/**
 * Owns the ONE `opencode acp` process that serves every conversation:
 * spawn it with a whitelisted env, initialize, warm it up, wait for the geocluster tools,
 * watch its private server, forward ACP calls, restart it when it dies.
 *
 * The supervisor is the engine's ACP *client*; the SessionBroker decides what to do with its
 * frames and permission requests. Facts it is built on (measured on 2.0.19, s43/result-*.md):
 *   - SDK 0.13.1 drops usage_update, strips messageId and validates permission requests, so
 *     every engine frame goes through engine-stream.js and arrives here raw, in wire order;
 *   - the first session call of a process costs ~0.7 s: a warm-up session/new + session/delete
 *     at each start absorbs it before any conversation waits on it. Its config options are the
 *     ones a new conversation starts with, kept as `newSessionConfigOptions`;
 *   - MCP readiness shows only on stderr ("mcp connected server=geocluster"); prompts within
 *     ~72 ms of it had no tools, so ready = that line + engineToolsSettleMs. "mcp connect failed"
 *     is permanent for that process (the broker restarts it once the MCP is healthy);
 *   - acp's private `serve` child can die while acp lives on, silent, failing every call with
 *     -32603 ClientError (the same error a bad cwd gives). acp never respawns it, so the
 *     supervisor watches it in /proc and probes with session/list on any ClientError;
 *   - the SDK never rejects in-flight requests when the process dies: every forwarded call is
 *     raced against the process's exit and rejected with errorName "EngineExited".
 *
 * Generation: 0 before the first ready, +1 each time an engine process becomes ready. Every event
 * carries the generation of the process that produced it, so the broker can tell a frame or an
 * exit of an old engine from the current one (sessions must be re-bound once per generation).
 *
 * Events:
 *   "ready"         {generation, restarted, tools}
 *   "exit"          {code, signal, expected, generation, reason}
 *   "unavailable"   ()                                  restarted too often; see whenReady()
 *   "tools"         {state: "connected"|"missing", generation}   changes after ready only; the
 *                   state at ready is in the "ready" payload and the `tools` getter
 *   "update"        (params, generation)                 raw session/update params
 *   "child"         (params, generation)                 raw opencode/session/child_update params
 *   "cancelRequest" ({requestId}, generation)            the engine withdrew a permission request
 *   "permission"    ({params, rpcId, resolve, generation}) answer with resolve({outcome}); params
 *                   keep _meta["gc/rpcId"] (=== rpcId); with no listener the request is cancelled
 * Frames that arrive before the process is ready (the warm-up session's) are not emitted.
 */
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { createWriteStream, readFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { ClientSideConnection, RequestError } from "@agentclientprotocol/sdk"
import { ENGINE_PERMISSION_METHOD, ENGINE_UPDATE_METHOD, RPC_ID_META, engineStream } from "./engine-stream.js"
import { raiseOomScore } from "./oom.js"
import { descendants, mergeTrees, reapTree, stillRunning, withEnv } from "./proc-tree.js"

const RESTART_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000]
const RESTART_WINDOW_MS = 10 * 60 * 1000
const MAX_RESTARTS_IN_WINDOW = 5
const STDERR_CAP_BYTES = 20 * 1024 * 1024
/** A stderr line longer than this is dropped from parsing (still logged); the MCP lines are short. */
const STDERR_LINE_MAX = 64 * 1024
const HEALTH_TIMEOUT_MS = 5000
/** SIGTERM → SIGKILL grace when the supervisor itself ends a broken engine (not stop()). */
const KILL_GRACE_MS = 5000
const CHILD_CAPABILITY = "opencode/child-session-updates"
export const ERR_ENGINE_NOT_READY = -32003

const CHILD_UPDATE_METHODS = new Set(["opencode/session/child_update", "_opencode/session/child_update"])
const GEOCLUSTER_SERVER_RE = /(?:^|\s)server=geocluster(?:\s|$)/

const timer = (ms) => {
	let handle
	const promise = new Promise((resolve) => {
		handle = setTimeout(resolve, ms)
	})
	return { promise, cancel: () => clearTimeout(handle) }
}

const message = (error) => String(error?.message ?? error)

/**
 * A permission answer reaches the SDK's write queue only after several microtask hops (handler
 * promise → request handler → response write), while a notification is queued at once. One
 * macrotask hop lets every answer given so far be queued first; the queue then keeps wire order.
 */
const answersFlushed = () => new Promise((resolve) => setImmediate(resolve))

/** The SDK rejects with a plain {code, message, data}; callers get a RequestError with the engine's own code. */
function asRequestError(error) {
	if (error instanceof RequestError) return error
	if (error && typeof error === "object" && typeof error.code === "number") {
		return new RequestError(error.code, String(error.message ?? "engine error"), error.data)
	}
	return error
}

function procStat(pid) {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, "utf8")
		const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ")
		return { state: fields[0], ppid: Number(fields[1]), start: fields[19] }
	} catch {
		return null
	}
}

function argv(pid) {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
	} catch {
		return []
	}
}

/** acp's private server: its direct child `… serve --stdio …` ({pid, start}), or null. */
async function findServe(acpPid) {
	for (const p of await descendants(acpPid)) {
		const stat = procStat(p.pid)
		if (stat?.ppid !== acpPid || stat.state === "Z") continue
		const args = argv(p.pid)
		if (args.includes("serve") || / serve(?:\s|$)/.test(args.join(" "))) return { pid: p.pid, start: stat.start }
	}
	return null
}

function serveAlive(serve) {
	const stat = procStat(serve.pid)
	return !!stat && stat.start === serve.start && stat.state !== "Z"
}

/** Not running any more: gone from /proc, or a zombie waiting for its parent (us) to reap it. */
function processGone(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z"
	} catch {
		return true
	}
}

export class AgentSupervisor extends EventEmitter {
	/** The live engine process record (see #spawn), or null. */
	#proc = null
	/** The previous process's tree: its tool processes may outlive it (conversationProcesses). */
	#lastTree = []
	#startPromise = null
	#restartTimer = null
	#healthCheck = null
	/** Bumped by start() and stop(): a launch from an older epoch never spawns or schedules. */
	#epoch = 0
	/** restart() is between its stop and its start: whenReady() waits instead of refusing. */
	#restarting = false
	#stderrBytes = 0
	#stderrCapped = false
	#backoff

	/**
	 * @param {object} opts
	 * @param {object} opts.config  loadConfig() result
	 * @param {object} opts.logger  {info, warn, error, debug?}
	 * @param {string} opts.mcpUrl  the shared MCP's http://127.0.0.1:<port>/mcp (GEOCLUSTER_MCP_URL)
	 * @param {number[]} [opts.restartBackoffMs]  tests only: replaces 1/2/5/15/30 s
	 */
	constructor({ config, logger, mcpUrl, restartBackoffMs }) {
		super()
		this.config = config
		this.logger = logger
		this.mcpUrl = mcpUrl
		/** stopped | starting | ready | restarting | stopping | unavailable */
		this.state = "stopped"
		this.generation = 0
		this.agentInfo = null
		this.agentCapabilities = null
		/** The config options a new session starts with, from the last warm-up; null before the first ready */
		this.newSessionConfigOptions = null
		this.restarts = []
		this.stopping = false
		this.reaping = Promise.resolve()
		this.#backoff = Array.isArray(restartBackoffMs) && restartBackoffMs.length ? restartBackoffMs : RESTART_BACKOFF_MS
	}

	get pid() {
		return this.#proc?.child.pid ?? null
	}

	/** "connected" | "missing" | "pending" (starting) | null (no process) */
	get tools() {
		return this.#proc?.tools ?? null
	}

	status() {
		return {
			state: this.state,
			pid: this.pid,
			generation: this.generation,
			tools: this.tools,
			restarts: this.restarts.length,
			version: this.agentInfo?.version ?? null,
		}
	}

	// ---- lifecycle -----------------------------------------------------------------------------

	/** Idempotent. Resolves when the engine is ready; rejects if this start failed (a restart is then scheduled unless stopping). */
	start() {
		// ACP at this pin requires a catalog default. File services remain independent.
		if (this.config.managedCatalog !== undefined && this.config.managedCatalog?.catalog?.default_model_id == null) {
			this.state = "unavailable"
			return Promise.reject(new RequestError(ERR_ENGINE_NOT_READY, "managed model sessions unavailable: no installed catalog default", { state: "unavailable", errorName: "model.unavailable" }))
		}
		if (this.state === "ready" && this.#proc) return Promise.resolve(this.#readyInfo())
		if (this.state === "starting" && this.#startPromise) return this.#startPromise
		this.stopping = false
		clearTimeout(this.#restartTimer)
		this.#restartTimer = null
		this.state = "starting"
		const epoch = ++this.#epoch
		const promise = this.#launch(epoch)
		this.#startPromise = promise
		promise.catch(() => {})
		return promise
	}

	/**
	 * Resolves (with the generation) once the engine is ready: at once if it is. An "unavailable"
	 * engine is started again (the restart window is reset): the next request is the retry.
	 * Rejects RequestError(-32003, "engine not ready", {state}) after timeoutMs.
	 */
	whenReady(timeoutMs = this.config.engineReadyWaitMs) {
		if (this.config.managedCatalog !== undefined && this.config.managedCatalog?.catalog?.default_model_id == null) return Promise.reject(new RequestError(ERR_ENGINE_NOT_READY, "managed model sessions unavailable: no installed catalog default", { state: "unavailable", errorName: "model.unavailable" }))
		if (this.state === "ready" && this.#proc?.ready) return Promise.resolve(this.generation)
		const notReady = () => new RequestError(ERR_ENGINE_NOT_READY, "engine not ready", { state: this.state })
		// A restart (tools reconnect, server death) passes through stopping: keep waiting for its "ready".
		// Only a real stop (shutdown) refuses at once
		if (this.stopping && !this.#restarting) return Promise.reject(notReady())
		if (this.state === "unavailable") {
			this.logger.warn("engine was unavailable; a request starts it again", { restarts: this.restarts.length })
			this.restarts = []
			this.start().catch(() => {})
		}
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timeout)
				this.off("ready", onReady)
				this.off("unavailable", onUnavailable)
			}
			const onReady = (info) => {
				cleanup()
				resolve(info.generation)
			}
			const onUnavailable = () => {
				cleanup()
				reject(notReady())
			}
			const timeout = setTimeout(() => {
				cleanup()
				reject(notReady())
			}, timeoutMs)
			this.on("ready", onReady)
			this.on("unavailable", onUnavailable)
		})
	}

	/** Stop and start a fresh process (e.g. to connect the tools); not counted as a crash. */
	async restart(reason = "requested") {
		this.logger.warn("engine restart", { reason, generation: this.generation })
		if (this.#proc) this.#proc.killReason ??= reason
		// stop() takes its epoch synchronously; a stop() that arrives meanwhile (gateway shutdown during a
		// tools restart) takes a newer one, and this restart must not start an engine behind its back
		const stopped = this.stop()
		const epoch = this.#epoch
		this.#restarting = true
		try {
			await stopped
			if (this.#epoch !== epoch) throw new Error("engine restart cancelled: the supervisor was stopped meanwhile")
			return await this.start()
		} finally {
			this.#restarting = false
		}
	}

	/**
	 * Graceful stop: SIGTERM, SIGKILL after graceMs, then whatever the engine left running (tool
	 * processes are children of `serve` in their own process groups, and survive a SIGKILL).
	 * Resolves when all are gone.
	 */
	async stop(graceMs = 5000) {
		this.stopping = true
		const epoch = ++this.#epoch
		clearTimeout(this.#restartTimer)
		this.#restartTimer = null
		const proc = this.#proc
		if (!proc) {
			if (this.#epoch === epoch) this.state = "stopped"
			await this.reaping
			return
		}
		this.state = "stopping"
		proc.expected = true
		proc.killReason ??= "stop"
		// Snapshot while the ancestry is intact; refreshed while waiting (it may still spawn)
		proc.tree = mergeTrees(proc.tree, await descendants(proc.child.pid))
		const refresh = setInterval(async () => {
			if (!proc.gone) proc.tree = mergeTrees(proc.tree, await descendants(proc.child.pid))
		}, 500)
		await new Promise((resolve) => {
			if (proc.gone) return resolve()
			const kill = setTimeout(() => {
				this.logger.warn("engine did not exit in time; killing", { pid: proc.child.pid })
				proc.child.kill("SIGKILL")
			}, graceMs)
			proc.exited.then(() => {
				clearTimeout(kill)
				resolve()
			})
			proc.child.kill("SIGTERM")
		})
		clearInterval(refresh)
		await this.reaping
		if (this.#epoch === epoch) this.state = "stopped"
	}

	async #launch(epoch) {
		const { config } = this
		let proc = null
		const started = Date.now()
		try {
			const previous = this.#proc
			if (previous) await previous.exited // a dying engine is replaced only once it is gone
			await this.#prepareDirs()
			// Checked after the last await and before spawn, with nothing in between: a stop() during
			// the awaits must not leave an engine nobody owns (the 2026-09-28 orphaned-MCP lesson)
			if (this.stopping || epoch !== this.#epoch) throw new Error("engine start cancelled: the supervisor is stopping")
			proc = this.#spawn()
			const init = await this.#guard(
				proc,
				proc.conn.initialize({
					protocolVersion: 1,
					clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { [CHILD_CAPABILITY]: true } },
				}),
				config.engineInitTimeoutMs,
				"initialize",
			)
			const caps = init?.agentCapabilities ?? {}
			if (caps._meta?.[CHILD_CAPABILITY] !== true) {
				// Without it every specialist's frames are lost: the engine is unusable for the product
				throw new Error(`engine did not acknowledge ${CHILD_CAPABILITY} (agent ${JSON.stringify(init?.agentInfo ?? null)}); refusing it`)
			}
			proc.agentInfo = init.agentInfo ?? null
			proc.agentCapabilities = caps

			const warm = await this.#guard(
				proc,
				proc.conn.newSession({ cwd: config.workspaceDir, mcpServers: [] }),
				config.engineInitTimeoutMs,
				"warm-up session/new",
			)
			await this.#guard(proc, proc.conn.extMethod("session/delete", { sessionId: warm.sessionId }), config.engineInitTimeoutMs, "warm-up session/delete")
			await this.#waitForTools(proc)
			if (proc.gone || this.#proc !== proc) throw new Error("engine exited during start")

			proc.ready = true
			this.generation = proc.generation
			this.agentInfo = proc.agentInfo
			this.agentCapabilities = caps
			if (Array.isArray(warm?.configOptions)) this.newSessionConfigOptions = warm.configOptions
			this.state = "ready"
			const info = this.#readyInfo()
			this.logger.info("engine ready", { pid: proc.child.pid, generation: proc.generation, tools: proc.tools, version: proc.agentInfo?.version ?? null, ms: Date.now() - started })
			this.#emitSafe("ready", { generation: proc.generation, restarted: proc.generation > 1, tools: proc.tools })
			return info
		} catch (error) {
			const err = asRequestError(error)
			if (proc && !proc.gone) {
				this.#terminate(proc, "start_failed")
				await proc.exited
			}
			if (this.stopping || epoch !== this.#epoch) {
				this.logger.info("engine start ended by stop", { error: message(err) })
			} else {
				this.logger.error("engine start failed", { pid: proc?.child.pid ?? null, error: message(err) })
				this.#scheduleRestart()
			}
			throw err
		}
	}

	#readyInfo() {
		return { generation: this.generation, tools: this.tools, agentInfo: this.agentInfo }
	}

	async #prepareDirs() {
		const { config } = this
		for (const sub of ["data", "state", "cache"]) {
			await fs.mkdir(path.join(config.engineStateDir, sub), { recursive: true, mode: 0o700 })
		}
		// Root-owned and present in the image (P6): creating them is for local runs and tests only
		for (const dir of [config.engineHome, config.engineXdgConfigHome]) {
			await fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch((error) => {
				if (!["EEXIST", "EACCES", "EPERM", "EROFS"].includes(error?.code)) throw error
			})
		}
		await fs.mkdir(config.logDir, { recursive: true }).catch(() => {})
	}

	/** The engine's whole environment: nothing of the gateway's own (no gate secret, no R2, no NODE_OPTIONS). */
	#engineEnv() {
		const { config } = this
		const env = {}
		const put = (name, value) => {
			// An empty IDE_LLM_TOKEN must be absent, not ""
			if (value !== undefined && value !== null && value !== "") env[name] = String(value)
		}
		for (const [name, value] of Object.entries(config.agentEnv ?? {})) put(name, value)
		put("HOME", config.engineHome)
		put("XDG_DATA_HOME", path.join(config.engineStateDir, "data"))
		put("XDG_STATE_HOME", path.join(config.engineStateDir, "state"))
		put("XDG_CACHE_HOME", path.join(config.engineStateDir, "cache"))
		put("XDG_CONFIG_HOME", config.engineXdgConfigHome)
		put("OPENCODE_CONFIG_DIR", config.engineConfigDir)
		put("OPENCODE_MODELS_PATH", config.engineModelsPath)
		// 2.0.19 reads OPENCODE_CONFIG_PROJECT_DISABLE ?? OPENCODE_DISABLE_PROJECT_CONFIG (server-process.ts:110-112):
		// set both, so neither can be left to an inherited value. Off: the walk up from cwd for opencode.json,
		// .opencode/ (plugins, agents), .claude/.agents skills and AGENTS.md
		put("OPENCODE_CONFIG_PROJECT_DISABLE", "1")
		put("OPENCODE_DISABLE_PROJECT_CONFIG", "1")
		put("OPENCODE_DISABLE_MODELS_FETCH", "1")
		put("OPENCODE_DISABLE_AUTOUPDATE", "1")
		put("OPENCODE_PRINT_LOGS", "1") // the MCP readiness lines exist only on stderr
		put("GEOCLUSTER_MCP_URL", this.mcpUrl)
		put("GEOCLUSTER_TOOL_HOME", config.toolHome)
		return env
	}

	#spawn() {
		const { config } = this
		const generation = this.generation + 1
		const child = spawn(config.opencodeBin, ["acp"], { cwd: config.workspaceDir, env: this.#engineEnv(), stdio: ["pipe", "pipe", "pipe"] })
		const proc = {
			child,
			generation,
			conn: null,
			tree: [],
			serve: null,
			serveMisses: 0,
			spawnedAt: Date.now(),
			ready: false,
			gone: false,
			terminating: false,
			expected: false,
			killReason: null,
			tools: "pending",
			toolsAt: 0,
			agentInfo: null,
			agentCapabilities: null,
			timers: [],
			warned: new Set(),
			/** forwarded calls in flight: the SDK never rejects them when the process dies */
			pending: new Set(),
		}
		proc.died = new Promise((_, reject) => {
			proc.rejectDied = reject
		})
		proc.died.catch(() => {})
		proc.exited = new Promise((resolve) => {
			proc.resolveExited = resolve
		})
		proc.toolsSignal = new Promise((resolve) => {
			proc.toolsWake = resolve
		})
		this.#proc = proc

		child.once("exit", (code, signal) => this.#onGone(proc, code, signal))
		child.once("error", (error) => {
			this.logger.error("engine process error", { pid: child.pid ?? null, error: message(error) })
			// A spawn failure (ENOENT, EACCES) emits "error" and "close" but never "exit"
			if (child.pid === undefined) this.#onGone(proc, null, null)
		})
		child.stdin?.on("error", (error) => this.logger.debug?.("engine stdin error", { error: message(error) })) // EPIPE after an exit
		this.logger.info("engine spawned", { pid: child.pid ?? null, bin: config.opencodeBin, cwd: config.workspaceDir, generation })
		if (child.pid === undefined) {
			proc.conn = { initialize: () => proc.died } // the "error" event rejects it
			return proc
		}
		void raiseOomScore(child.pid, config.engineOomScoreAdj, this.logger)
		this.#captureStderr(proc)
		this.#watch(proc)
		proc.conn = new ClientSideConnection(() => this.#client(proc), engineStream(child.stdin, child.stdout))
		return proc
	}

	#onGone(proc, code, signal) {
		if (proc.gone) return
		proc.gone = true
		for (const t of proc.timers) clearTimeout(t)
		const exited = new RequestError(-32603, `Internal error: engine exited (code ${code}, signal ${signal})`, {
			errorName: "EngineExited",
			generation: proc.generation,
			code,
			signal,
		})
		proc.rejectDied(exited)
		for (const call of proc.pending) call.reject(exited)
		proc.pending.clear()
		proc.toolsWake()
		// Whatever the engine left running (tool shells, specialists' scripts) goes with it, crash or stop
		this.#lastTree = proc.tree
		this.reaping = this.#reapLeftovers(proc)
		proc.resolveExited()
		if (this.#proc !== proc) return
		this.#proc = null
		const expected = this.stopping || proc.expected
		const reason = proc.killReason ?? (expected ? "stop" : proc.ready ? "crash" : "start_failed")
		this.logger[expected ? "info" : "error"]("engine exited", { pid: proc.child.pid ?? null, code, signal, expected, generation: proc.generation, reason })
		// An expected exit's state belongs to stop(); a failed start is rescheduled by #launch; a
		// start() already waiting for this exit owns the state
		const restart = proc.ready && !expected && this.state !== "starting"
		if (restart) this.state = "restarting"
		this.#emitSafe("exit", { code, signal, expected, generation: proc.generation, reason })
		if (restart) this.#scheduleRestart()
	}

	#scheduleRestart() {
		const now = Date.now()
		this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS)
		if (this.restarts.length >= MAX_RESTARTS_IN_WINDOW) {
			this.state = "unavailable"
			this.logger.error("engine restarted too often; giving up until the next request", { restarts: this.restarts.length })
			this.#emitSafe("unavailable")
			return
		}
		const delay = this.#backoff[Math.min(this.restarts.length, this.#backoff.length - 1)]
		this.restarts.push(now)
		this.state = "restarting"
		this.logger.warn("engine restart scheduled", { delayMs: delay, restarts: this.restarts.length })
		clearTimeout(this.#restartTimer)
		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = null
			if (this.stopping || this.state !== "restarting") return
			this.start().catch((error) => this.logger.error("engine restart failed", { error: message(error) }))
		}, delay)
		this.#restartTimer.unref?.()
	}

	/** SIGTERM a broken engine (its exit handler restarts it), SIGKILL if it ignores that. */
	#terminate(proc, reason) {
		if (proc.gone || proc.terminating) return
		proc.terminating = true
		proc.killReason ??= reason
		if (proc.ready && this.state === "ready") this.state = "restarting" // new calls get -32003 at once
		proc.tree = mergeTrees(proc.tree, proc.serve ? [proc.serve] : [])
		// descendants() scans /proc synchronously when called: this snapshot is taken before the
		// SIGTERM, and merged (a microtask) before the "exit" event's reap reads proc.tree
		void descendants(proc.child.pid).then((tree) => {
			proc.tree = mergeTrees(proc.tree, tree)
		})
		try {
			proc.child.kill("SIGTERM")
		} catch {
			// already gone
		}
		const kill = setTimeout(() => {
			if (proc.gone) return
			this.logger.warn("engine ignored SIGTERM; killing", { pid: proc.child.pid, reason })
			proc.child.kill("SIGKILL")
		}, KILL_GRACE_MS)
		kill.unref?.()
		proc.timers.push(kill)
	}

	// ---- watching ------------------------------------------------------------------------------

	/**
	 * Two timers per process:
	 *   - the tree snapshot (treeSnapshotMs): after a crash the tree can no longer be found by
	 *     ancestry, so what was seen is what gets reaped. Merged, never replaced: a tick between the
	 *     death and Node's "exit" event sees the children already re-parented (an empty tree);
	 *   - the server watch (engineWatchMs): acp must keep its `serve` child (finding Q9).
	 */
	#watch(proc) {
		const pid = proc.child.pid
		const snapshot = setInterval(async () => {
			if (!proc.gone) proc.tree = mergeTrees(stillRunning(proc.tree), await descendants(pid))
		}, this.config.treeSnapshotMs)
		const serverWatch = setInterval(() => void this.#checkServe(proc), this.config.engineWatchMs)
		snapshot.unref?.()
		serverWatch.unref?.()
		proc.timers.push(snapshot, serverWatch)
	}

	async #checkServe(proc) {
		if (proc.gone || proc.terminating) return
		if (!proc.serve) {
			proc.serve = await findServe(proc.child.pid)
			if (proc.serve) {
				this.logger.debug?.("engine server found", { pid: proc.child.pid, serverPid: proc.serve.pid })
			} else if (proc.ready && ++proc.serveMisses === 5) {
				this.logger.warn("engine server process not found; the server watch is inactive for this engine", { pid: proc.child.pid })
			}
			return
		}
		if (serveAlive(proc.serve)) return
		// acp itself died first (its server follows ~140 ms later): that is a crash, and the exit handler,
		// whose event may not have been processed yet, classifies it
		if (proc.child.exitCode !== null || proc.child.signalCode !== null || processGone(proc.child.pid)) return
		this.logger.error("engine server process is gone (acp never respawns it); restarting the engine", {
			pid: proc.child.pid,
			serverPid: proc.serve.pid,
			generation: proc.generation,
		})
		this.#terminate(proc, "server_died")
	}

	/**
	 * Engine-wide health: session/list answers in ~10 ms on a healthy engine. A -32603 ClientError
	 * or no answer in 5 s means the server is dead: the engine is restarted and this resolves false.
	 * Shared by concurrent callers; false also when no engine is ready.
	 */
	checkHealth() {
		if (this.#healthCheck) return this.#healthCheck
		const proc = this.#proc
		if (!proc || !proc.ready || proc.gone || proc.terminating || this.state !== "ready") return Promise.resolve(false)
		this.#healthCheck = this.#probe(proc).finally(() => {
			this.#healthCheck = null
		})
		return this.#healthCheck
	}

	async #probe(proc) {
		const t = timer(HEALTH_TIMEOUT_MS)
		try {
			const outcome = await Promise.race([
				proc.conn.unstable_listSessions({ cwd: this.config.workspaceDir }).then(
					() => "ok",
					(error) => error,
				),
				proc.died.catch(() => "gone"),
				t.promise.then(() => "timeout"),
			])
			if (outcome === "ok") return true
			if (outcome === "gone") return false
			const dead = outcome === "timeout" || (outcome?.code === -32603 && outcome?.data?.errorName === "ClientError")
			if (!dead) {
				this.logger.warn("engine health probe got an error, but the engine answered", { error: message(outcome) })
				return true
			}
			this.logger.error("engine health probe failed: its server is not answering; restarting the engine", {
				pid: proc.child.pid,
				generation: proc.generation,
				probe: outcome === "timeout" ? `no answer in ${HEALTH_TIMEOUT_MS} ms` : message(outcome),
			})
			this.#terminate(proc, outcome === "timeout" ? "server_unresponsive" : "server_died")
			return false
		} finally {
			t.cancel()
		}
	}

	// ---- stderr: log file + MCP readiness ------------------------------------------------------

	#captureStderr(proc) {
		const file = path.join(this.config.logDir, "agent.stderr.log")
		let out = null
		try {
			out = createWriteStream(file, { flags: "a", mode: 0o640 })
			out.on("error", (error) => {
				this.logger.warn("engine stderr log unavailable", { file, error: message(error) })
				out = null
			})
		} catch {
			out = null
		}
		let partial = ""
		proc.child.stderr.setEncoding("utf8")
		proc.child.stderr.on("data", (chunk) => {
			this.#stderrBytes += Buffer.byteLength(chunk)
			if (out && this.#stderrBytes <= STDERR_CAP_BYTES) out.write(chunk)
			else if (out && !this.#stderrCapped) {
				this.#stderrCapped = true
				this.logger.warn("engine stderr log reached its cap; further output is not written", { file, capBytes: STDERR_CAP_BYTES })
			}
			partial += chunk
			let nl
			while ((nl = partial.indexOf("\n")) >= 0) {
				const line = partial.slice(0, nl)
				partial = partial.slice(nl + 1)
				this.#onStderrLine(proc, line)
			}
			if (partial.length > STDERR_LINE_MAX) partial = ""
		})
		proc.child.once("exit", () => out?.end())
	}

	/**
	 * Only two lines matter, both with server=geocluster (a client-supplied server would log its own
	 * name). A later "mcp connected" (the engine re-initializes after an MCP restart) keeps or sets
	 * "connected"; the "MCP server session expired" WARN of that path is benign and ignored.
	 */
	#onStderrLine(proc, line) {
		if (!line.includes('message="mcp connect') || !GEOCLUSTER_SERVER_RE.test(line)) return
		if (line.includes('message="mcp connected"')) {
			this.#setTools(proc, "connected")
		} else if (line.includes('message="mcp connect failed"')) {
			const why = /status\.error="([^"]*)"/.exec(line)?.[1] ?? null
			this.logger.warn("engine could not connect to the geocluster MCP; its tools are missing until the engine restarts", {
				pid: proc.child.pid,
				error: why,
				mcpUrl: this.mcpUrl,
			})
			this.#setTools(proc, "missing")
		}
	}

	#setTools(proc, state) {
		if (state === "connected") proc.toolsAt = Date.now()
		const changed = proc.tools !== state
		proc.tools = state
		const wake = proc.toolsWake
		proc.toolsSignal = new Promise((resolve) => {
			proc.toolsWake = resolve
		})
		wake()
		if (changed && proc.ready && this.#proc === proc && !proc.gone) {
			this.logger.info("engine tools changed", { tools: state, generation: proc.generation })
			this.#emitSafe("tools", { state, generation: proc.generation })
		}
	}

	/** Ready needs "mcp connected" + settle, or a definitive "connect failed", or engineMcpWaitMs since spawn. */
	async #waitForTools(proc) {
		const { engineMcpWaitMs, engineToolsSettleMs } = this.config
		const deadline = proc.spawnedAt + engineMcpWaitMs
		for (;;) {
			if (proc.tools === "missing") return
			if (proc.tools === "connected") {
				const left = proc.toolsAt + engineToolsSettleMs - Date.now()
				if (left <= 0) return
				const t = timer(left)
				await this.#guard(proc, t.promise, left + 1000, "tools settle").finally(t.cancel)
				continue
			}
			const left = deadline - Date.now()
			if (left <= 0) {
				this.logger.warn('no "mcp connected" line from the engine in time; it starts without the geocluster tools', {
					waitMs: engineMcpWaitMs,
					mcpUrl: this.mcpUrl,
				})
				this.#setTools(proc, "missing")
				return
			}
			const t = timer(left)
			await this.#guard(proc, Promise.race([proc.toolsSignal, t.promise]), left + 1000, "tools").finally(t.cancel)
		}
	}

	/** `promise`, unless the process dies or `ms` pass first. */
	#guard(proc, promise, ms, label) {
		const t = timer(ms)
		return Promise.race([
			promise,
			proc.died,
			t.promise.then(() => {
				throw new Error(`engine ${label} timed out after ${ms} ms`)
			}),
		]).finally(t.cancel)
	}

	// ---- the ACP client the engine talks to ----------------------------------------------------

	#client(proc) {
		return {
			// Not reached through engine-stream.js (renamed before the SDK); kept so a frame never fails
			sessionUpdate: async (params) => this.#emitFrame(proc, "update", params),
			requestPermission: async (params) => this.#onPermission(proc, params),
			extNotification: async (method, params) => {
				if (method === ENGINE_UPDATE_METHOD) return this.#emitFrame(proc, "update", params)
				if (CHILD_UPDATE_METHODS.has(method)) return this.#emitFrame(proc, "child", params)
				if (method === "$/cancel_request") {
					if (this.#proc === proc && !proc.gone) this.#emitSafe("cancelRequest", { requestId: params?.requestId }, proc.generation)
					return
				}
				if (!proc.warned.has(method)) {
					proc.warned.add(method)
					this.logger.warn("ignoring an unknown engine notification", { method })
				}
			},
			extMethod: async (method, params) => {
				if (method === ENGINE_PERMISSION_METHOD) return this.#onPermission(proc, params)
				this.logger.warn("refusing an unknown engine request", { method })
				throw RequestError.methodNotFound(method)
			},
		}
	}

	#emitFrame(proc, event, params) {
		if (this.#proc !== proc || proc.gone) return
		if (!proc.ready) {
			// Only the warm-up session can produce frames before ready (no call is forwarded until then)
			this.logger.debug?.("dropping an engine frame received before ready", { event, sessionId: params?.sessionId ?? params?.rootSessionId })
			return
		}
		this.#emitSafe(event, params, proc.generation)
	}

	#emitSafe(event, ...args) {
		try {
			this.emit(event, ...args)
		} catch (error) {
			this.logger.error("engine event listener failed", { event, error: message(error) })
		}
	}

	#onPermission(proc, params) {
		const rpcId = params?._meta?.[RPC_ID_META] ?? null
		if (this.#proc !== proc || proc.gone || !proc.ready || this.listenerCount("permission") === 0) {
			this.logger.warn("engine permission request with nobody to answer it; cancelling it", { rpcId })
			return { outcome: { outcome: "cancelled" } }
		}
		return new Promise((resolve) => {
			let answered = false
			// First answer wins; after the engine is gone an answer would only fail to write
			const answer = (result) => {
				if (answered || proc.gone) return
				answered = true
				resolve(result ?? { outcome: { outcome: "cancelled" } })
			}
			try {
				this.emit("permission", { params, rpcId, resolve: answer, generation: proc.generation })
			} catch (error) {
				this.logger.error("permission listener failed; cancelling the request", { rpcId, error: message(error) })
				answer({ outcome: { outcome: "cancelled" } })
			}
		})
	}

	// ---- forwarded calls -----------------------------------------------------------------------

	/**
	 * Forward one call to a ready engine. Engine errors are re-thrown as RequestError with the
	 * engine's own code and data; an engine exit rejects it with errorName "EngineExited"; a
	 * ClientError starts a (shared) health probe, since a dead server and a bad cwd look the same.
	 */
	async #call(fn) {
		const proc = this.#proc
		if (this.state !== "ready" || !proc || !proc.ready || proc.gone) {
			throw new RequestError(ERR_ENGINE_NOT_READY, "engine not ready", { state: this.state })
		}
		try {
			// Tracked, not raced against proc.died: a race would leave one reaction per call on a
			// promise that lives as long as the engine
			return await new Promise((resolve, reject) => {
				const call = { reject }
				proc.pending.add(call)
				const settle = (done) => (value) => {
					proc.pending.delete(call)
					done(value)
				}
				let sent
				try {
					sent = fn(proc.conn)
				} catch (error) {
					sent = Promise.reject(error)
				}
				Promise.resolve(sent).then(settle(resolve), settle(reject))
			})
		} catch (error) {
			const err = asRequestError(error)
			if (err?.data?.errorName === "ClientError" && !proc.gone) void this.checkHealth()
			throw err
		}
	}

	/** session/new; cwd and mcpServers default to the workspace and [] (the broker pins both anyway). */
	newSession(params = {}) {
		return this.#call((c) => c.newSession({ cwd: this.config.workspaceDir, mcpServers: [], ...params }))
	}

	setMode(sessionId, modeId) {
		return this.#call((c) => c.setSessionMode({ sessionId, modeId }))
	}

	/** {configOptions}; model, effort or mode. OpenCode has no session/set_model (-32601). */
	setConfigOption(sessionId, configId, value) {
		return this.#call((c) => c.extMethod("session/set_config_option", { sessionId, configId, value }))
	}

	/** Bind a stored session to this engine process without replay: {configOptions}. */
	resumeSession(sessionId) {
		return this.#call((c) => c.unstable_resumeSession({ sessionId, cwd: this.config.workspaceDir, mcpServers: [] }))
	}

	/** Unbind (and cancel a running prompt); {} even for unknown ids. Ordered after earlier permission answers. */
	async closeSession(sessionId) {
		await answersFlushed()
		return this.#call((c) => c.extMethod("session/close", { sessionId }))
	}

	/** Delete with its children (and cancel a running prompt); {} even for unknown ids. Ordered after earlier permission answers. */
	async deleteSession(sessionId) {
		await answersFlushed()
		return this.#call((c) => c.extMethod("session/delete", { sessionId }))
	}

	listSessions(params = {}) {
		return this.#call((c) => c.unstable_listSessions(params))
	}

	prompt(params) {
		return this.#call((c) => c.prompt(params))
	}

	/**
	 * A notification: never answered, never an error from the engine. Permission answers given
	 * (resolve()d) before this call reach the engine before the cancel: the engine needs
	 * answer-then-cancel, since a cancel first withdraws the request and any answer after that
	 * fails the whole turn with PermissionNotFoundError (measured).
	 */
	async cancel(sessionId) {
		await answersFlushed()
		return this.#call((c) => c.cancel({ sessionId }))
	}

	// ---- processes -----------------------------------------------------------------------------

	/**
	 * A conversation's tool processes: the engine's descendants (the merged snapshot plus a fresh
	 * scan, and what is left of the previous engine's tree) whose environment has
	 * GEOCLUSTER_RUN_DIR=<runDir> exactly. [{pid, start}]
	 */
	async conversationProcesses(runDir) {
		if (!runDir) return []
		const proc = this.#proc
		let tree = stillRunning(this.#lastTree)
		if (proc) tree = mergeTrees(tree, stillRunning(proc.tree), proc.gone ? [] : await descendants(proc.child.pid))
		// A job the agent detached (`nohup … &`, setsid) is re-parented away from the engine within
		// milliseconds, before any snapshot sees it, but keeps its GEOCLUSTER_RUN_DIR: scan the whole
		// process table too. runs/<ses_…> is unique, so nothing unrelated matches; other uids' environ
		// can't be read and are skipped. A full scan is ~2 ms in the container (cancel time only).
		tree = mergeTrees(tree, await descendants(1))
		return withEnv(tree, "GEOCLUSTER_RUN_DIR", runDir).map(({ pid, start }) => ({ pid, start }))
	}

	async #reapLeftovers(proc) {
		const count = await reapTree(proc.tree)
		if (count) this.logger.warn("stopped processes the engine left running", { pid: proc.child.pid ?? null, count })
	}
}
