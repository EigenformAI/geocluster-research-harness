/**
 * The geocluster MCP shared by every conversation on the machine: one process, Streamable HTTP on
 * http://127.0.0.1:<config.mcpPort>/mcp.
 *
 * Why one process: one `opencode acp` serves every conversation and connects to one MCP URL
 * (GEOCLUSTER_MCP_URL). The server's shared mode (`MCP_TRANSPORT=http`) takes the run folder per call
 * from the `run_dir` the run-dir plugin injects, and runs sync tools in bounded threads, so a heavy tool
 * in one conversation no longer freezes the others (the reason api 2 ran one server per conversation).
 *
 * Why the order matters to the broker: an engine that connects while the MCP is down never gets the
 * geocluster tools for the rest of its life (measured on 2.0.19). So the broker starts this first and
 * waits for "ready"; a "ready" after a restart is its cue to restart an engine whose tools are missing.
 * An MCP restart under a running engine heals by itself (404 → re-initialize).
 *
 * Readiness is `GET /healthz` returning {ok:true, mode:"shared"}. Never `/mcp`: in stateful mode every
 * request without a session id registers a session that is never freed.
 *
 * Only a whitelisted environment is passed: no gateway secret, no model token, no R2 credentials (the MCP
 * needs none), and never GEOCLUSTER_RUN_DIR (the server refuses to start with it in shared mode, because
 * it would become a silent shared default).
 *
 * Restart on an unexpected exit with backoff (1/2/5/15/30 s); more than 5 restarts in 10 min → state
 * "unavailable" until revive(). A stop drains first (FastMCP's own graceful-shutdown timeout is 0, so a
 * SIGTERM abandons running tool calls), then SIGTERM → SIGKILL → reap the worker processes (joblib/loky)
 * the server leaves behind once it is gone.
 *
 * Events: "ready" ({restarted, pid}), "exit" ({code, signal, expected}), "unavailable" ().
 */
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { createWriteStream } from "node:fs"
import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { raiseOomScore } from "./oom.js"
import { descendants, mergeTrees, reapTree, stillRunning, withEnv, withParent } from "./proc-tree.js"

const LOG_CAP_BYTES = 10 * 1024 * 1024
const TAIL_CHARS = 4000
const HEALTH_POLL_MS = 150
const HEALTH_TIMEOUT_MS = 2000
/** uvicorn's access line for a successful /healthz: noise in mcp.log (see #capture). */
const HEALTHZ_ACCESS_LINE = /"GET \/healthz HTTP\/[\d.]+" 200\b/
/** After "exit", how long to wait for the last stdout/stderr bytes before quoting them in a start error. */
const OUTPUT_SETTLE_MS = 250
const RESTART_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000]
const RESTART_WINDOW_MS = 10 * 60 * 1000
const MAX_RESTARTS_IN_WINDOW = 5

/** True when something accepts TCP connections on host:port. Kept exported for callers of the api-2 module. */
export function portOpen(port, host = "127.0.0.1", timeoutMs = 500) {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port })
		const done = (value) => {
			socket.destroy()
			resolve(value)
		}
		socket.setTimeout(timeoutMs, () => done(false))
		socket.once("connect", () => done(true))
		socket.once("error", () => done(false))
	})
}

function startError(code, message) {
	const error = new Error(message)
	error.code = code
	return error
}

function lastLines(text, count = 3) {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(-count)
		.join(" | ")
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class McpSupervisor extends EventEmitter {
	#state = "stopped" // stopped | starting | ready | unavailable
	#lastHealth = null
	#child = null
	/** The start in flight (spawn + wait for /healthz); stop() waits for it to settle. */
	#attempt = null
	#retryTimer = null
	/** Timestamps of automatic restarts inside the window. */
	#restarts = []
	/** Set by stop(), cleared by start(): no spawn, no restart while set. */
	#stopRequested = false
	#stopGraceMs = 3000
	#stopping = null
	/** Reaps of a crashed server's leftover workers; stop() waits for them. */
	#reaping = new Set()

	/**
	 * @param {object} opts
	 * @param {object} opts.config loadConfig() output (mcp*, logDir, toolHome, agentEnv, treeSnapshotMs)
	 * @param {object} opts.logger
	 * @param {Function} [opts.fetchImpl] globalThis.fetch by default
	 * @param {number[]} [opts.backoffMs] restart delays; tests shorten them
	 * @param {number} [opts.restartWindowMs]
	 * @param {number} [opts.maxRestarts] restarts allowed inside the window before "unavailable"
	 * @param {number} [opts.pollMs] /healthz poll interval during a start and a drain
	 */
	constructor({
		config,
		logger,
		fetchImpl = globalThis.fetch,
		backoffMs = RESTART_BACKOFF_MS,
		restartWindowMs = RESTART_WINDOW_MS,
		maxRestarts = MAX_RESTARTS_IN_WINDOW,
		pollMs = HEALTH_POLL_MS,
	}) {
		super()
		this.config = config
		this.logger = logger
		this.fetchImpl = fetchImpl
		this.port = config.mcpPort
		this.backoffMs = backoffMs
		this.restartWindowMs = restartWindowMs
		this.maxRestarts = maxRestarts
		this.pollMs = pollMs
	}

	/** stopped | starting (spawned, or a restart is scheduled) | ready | unavailable (gave up until revive()) */
	get state() {
		return this.#state
	}

	get pid() {
		return this.#child?.pid ?? null
	}

	/** The engine's GEOCLUSTER_MCP_URL. */
	get url() {
		return `http://127.0.0.1:${this.port}/mcp`
	}

	/** {ok, mode, inFlight, at (epoch ms)} from the last /healthz of start(), health() or a drain; null before any. */
	get lastHealth() {
		return this.#lastHealth
	}

	/**
	 * Start the server and resolve when /healthz says it is the shared MCP. Idempotent: resolves at once when
	 * ready and joins a start in flight. A failed start rejects (err.code MCP_PORT_IN_USE | MCP_EARLY_EXIT |
	 * MCP_WRONG_SERVER | MCP_START_TIMEOUT | MCP_SPAWN_FAILED | MCP_START_CANCELLED) and, unless stop() was
	 * called, schedules the next attempt with the restart backoff.
	 */
	async start() {
		if (this.#stopping) await this.#stopping
		this.#stopRequested = false
		if (this.#state === "ready" && this.#child) return
		if (this.#attempt) return this.#attempt
		return this.#launch("start")
	}

	/**
	 * Forget the restart history and start the server if nothing runs or is starting. The broker calls it on a
	 * new prompt (at most once a minute) so an "unavailable" MCP gets another chance. Never rejects: resolves
	 * true when the server is ready, false otherwise. Does nothing after stop().
	 */
	async revive() {
		this.#restarts = []
		if (this.#stopRequested || this.#stopping) return false
		if (this.#state === "ready" && this.#child) return true
		const attempt = this.#attempt ?? this.#launch("revive")
		return attempt.then(
			() => true,
			() => false,
		)
	}

	/**
	 * One GET /healthz with a timeout. Returns {ok, mode, inFlight}, or null when it doesn't answer 200 with
	 * JSON. Updates lastHealth either way (ok:false on no answer).
	 */
	async health(timeoutMs = HEALTH_TIMEOUT_MS) {
		const probe = await this.#probe(timeoutMs)
		if (probe.kind !== "ok") {
			this.#lastHealth = { ok: false, mode: null, inFlight: null, at: Date.now() }
			return null
		}
		return this.#recordHealth(probe.body)
	}

	/**
	 * Stop for good (no restart afterwards; start() lifts that). Waits for a start in flight to settle and stops
	 * what it spawned (the 2026-09-28 orphaned MCP: a stop that returned while a spawn was pending left the server
	 * running). A ready server is drained first: /healthz is polled until in_flight is 0 or drainMs has passed.
	 * Then SIGTERM, SIGKILL after graceMs, and the descendants snapshot is reaped (SIGTERM, SIGKILL after 1 s).
	 * Resolves once the server has exited and every leftover has been sent its SIGKILL.
	 */
	stop({ drainMs = this.config.mcpDrainMs, graceMs = 3000 } = {}) {
		this.#stopRequested = true
		this.#stopGraceMs = graceMs
		clearTimeout(this.#retryTimer)
		this.#retryTimer = null
		if (this.#stopping) return this.#stopping
		const run = async () => {
			// The start in flight sees #stopRequested at its next step and kills what it spawned (#startOnce's catch)
			if (this.#attempt) await this.#attempt.catch(() => {})
			const child = this.#child
			if (child) {
				if (child.ready && drainMs > 0) await this.#drain(child, drainMs)
				await this.#terminate(child, graceMs)
			}
			await Promise.allSettled([...this.#reaping])
			if (this.#stopRequested) this.#state = "stopped"
		}
		this.#stopping = run().finally(() => {
			this.#stopping = null
		})
		return this.#stopping
	}

	// ---- internals --------------------------------------------------------------------------------

	#launch(reason) {
		clearTimeout(this.#retryTimer)
		this.#retryTimer = null
		this.#state = "starting"
		const attempt = this.#startOnce(reason).then(
			() => {
				if (this.#attempt === attempt) this.#attempt = null
			},
			(error) => {
				if (this.#attempt === attempt) this.#attempt = null
				if (this.#stopRequested) {
					this.logger.info("mcp start cancelled by stop", { reason })
				} else {
					this.logger.error("mcp start failed", { reason, code: error.code ?? null, error: String(error?.message ?? error) })
					this.#scheduleRestart("start failed")
				}
				throw error
			},
		)
		this.#attempt = attempt
		// A restart nobody awaits must not surface as an unhandled rejection; callers of start() still see it
		attempt.catch(() => {})
		return attempt
	}

	#assertNotStopped() {
		if (this.#stopRequested) throw startError("MCP_START_CANCELLED", "MCP start cancelled: the supervisor is stopping")
	}

	/**
	 * A gateway that was SIGKILLed (OOM, `docker kill`) leaves its MCP running: unlike the engine it has
	 * no stdin to see EOF on, so it keeps the port and every start would fail. Such an orphan is ours
	 * (same uid: its environ is readable), was re-parented to PID 1, and carries this port in its env.
	 * Returns true when one was stopped and the port is free again.
	 */
	async #reapOrphans(port) {
		const orphans = withParent(withEnv(withEnv(await descendants(1), "MCP_TRANSPORT", "http"), "MCP_PORT", String(port)), 1)
		if (!orphans.length) return false
		this.logger.warn("stopping an MCP an earlier gateway left running", { port, pids: orphans.map((p) => p.pid) })
		await reapTree(mergeTrees(orphans, ...(await Promise.all(orphans.map((p) => descendants(p.pid))))), 2000)
		const deadline = Date.now() + 5000
		while (Date.now() < deadline) {
			if (!(await portOpen(port))) return true
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		return false
	}

	async #startOnce(reason) {
		const { config } = this
		const port = this.port
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw startError("MCP_SPAWN_FAILED", `invalid MCP port ${port} (RUNTIME_MCP_PORT)`)
		}
		const log = await this.#openLog()
		try {
			this.#assertNotStopped()
			// Nothing of ours is running, so a listener now is someone else's (most likely an MCP an earlier
			// gateway left behind). Our server could not bind, and /healthz would answer for the wrong process.
			if (await portOpen(port)) await this.#reapOrphans(port)
			if (await portOpen(port)) {
				const probe = await this.#probe(HEALTH_TIMEOUT_MS)
				const what =
					probe.kind === "ok"
						? `its /healthz answers mode=${JSON.stringify(probe.body?.mode ?? null)}${probe.body?.mode === "shared" ? ", probably a shared MCP an earlier gateway left running" : ""}`
						: probe.kind === "http"
							? `its /healthz answers HTTP ${probe.status}`
							: "it accepts connections but /healthz doesn't answer"
				throw startError(
					"MCP_PORT_IN_USE",
					`MCP port 127.0.0.1:${port} is already in use by another process (${what}); find it with \`ss -ltnp 'sport = :${port}'\``,
				)
			}
			this.#assertNotStopped()
		} catch (error) {
			log.close()
			throw error
		}

		const env = {}
		for (const [name, value] of Object.entries({
			PATH: config.agentEnv?.PATH,
			LANG: config.agentEnv?.LANG,
			HOME: config.toolHome,
			MCP_TRANSPORT: "http",
			MCP_HOST: "127.0.0.1",
			MCP_PORT: port,
			MCP_WORKSPACE_ROOT: config.mcpWorkspaceRoot,
			MCP_CACHE_MAX_MB: config.mcpCacheMb,
			MCP_TOOL_THREADS: config.mcpToolThreads,
			MCP_TOOL_THREADS_PER_RUN: config.mcpToolThreadsPerRun,
			// Concurrent KMeans fits otherwise leave BLAS stuck at 1 thread anyway (plan 5.2)
			OPENBLAS_NUM_THREADS: "1",
			NUMBA_THREADING_LAYER: "omp",
			// No .env from the working directory, no PyPI call from the startup banner
			FASTMCP_ENV_FILE: "/nonexistent",
			FASTMCP_CHECK_FOR_UPDATES: "off",
			PYTHONUNBUFFERED: "1",
		})) {
			if (value !== undefined && value !== null && value !== "") env[name] = String(value)
		}

		const child = spawn(config.mcpCommand, config.mcpArgs, { cwd: config.mcpCwd, env, stdio: ["ignore", "pipe", "pipe"] })
		child.ready = false
		child.expectedExit = false
		child.reaped = false
		child.tree = []
		// "exit" for a process that ran, "error" alone for one that never started (ENOENT, EACCES, bad cwd)
		const ended = new Promise((resolve) => {
			child.once("exit", (code, signal) => resolve({ code, signal }))
			child.once("error", (error) => {
				if (!child.pid) resolve({ code: null, signal: null, spawnError: error })
			})
		})
		const closed = new Promise((resolve) => child.once("close", resolve))
		child.on("error", (error) => this.logger.error("mcp process error", { pid: child.pid ?? null, error: String(error?.message ?? error) }))

		if (!child.pid) {
			log.close()
			const { spawnError } = await ended
			throw startError("MCP_SPAWN_FAILED", `MCP server could not be started (${config.mcpCommand}): ${spawnError?.message ?? "spawn failed"}`)
		}
		this.#child = child
		this.logger.info("mcp spawned", { pid: child.pid, port, cmd: config.mcpCommand, reason })
		void raiseOomScore(child.pid, config.mcpOomScoreAdj, this.logger)
		this.#watchTree(child)
		const output = this.#capture(child, log, reason)

		child.once("exit", (code, signal) => {
			const expected = child.expectedExit
			const wasReady = child.ready
			if (this.#child === child) this.#child = null
			this.logger[expected ? "info" : wasReady ? "error" : "warn"]("mcp exited", { pid: child.pid, code, signal, expected, wasReady })
			this.emit("exit", { code, signal, expected })
			if (expected) return // #terminate reaps
			// Its joblib/loky workers were re-parented when it died: reap what the snapshots saw
			this.#reapLeftovers(child)
			// A crash during a start is handled by the start's own failure path
			if (wasReady && !this.#stopRequested) this.#scheduleRestart("exited")
		})

		const spawnedAt = Date.now()
		const deadline = spawnedAt + config.mcpStartTimeoutMs
		let exited = null
		void ended.then((info) => {
			exited = info
		})
		let health
		try {
			for (;;) {
				if (exited) {
					// The last bytes may still be in the pipe when "exit" fires
					await Promise.race([closed, sleep(OUTPUT_SETTLE_MS)])
					const how = exited.signal ? `signal ${exited.signal}` : `code ${exited.code}`
					throw startError("MCP_EARLY_EXIT", `MCP server exited during start (${how}): ${lastLines(output.tail()) || "no output"}`)
				}
				this.#assertNotStopped()
				const remaining = deadline - Date.now()
				if (remaining <= 0) {
					throw startError(
						"MCP_START_TIMEOUT",
						`MCP server did not answer /healthz on port ${port} within ${config.mcpStartTimeoutMs} ms: ${lastLines(output.tail()) || "no output"}`,
					)
				}
				const probe = await this.#probe(Math.min(HEALTH_TIMEOUT_MS, remaining))
				if (probe.kind === "ok" && probe.body?.mode !== "shared") {
					throw startError(
						"MCP_WRONG_SERVER",
						`127.0.0.1:${port}/healthz answered mode=${JSON.stringify(probe.body?.mode ?? null)}, expected "shared": ` +
							"RUNTIME_MCP_CMD is not the geocluster MCP in MCP_TRANSPORT=http mode, or another server holds the port",
					)
				}
				if (probe.kind === "ok" && probe.body?.ok === true) {
					health = probe.body
					break
				}
				if (probe.kind === "http") {
					throw startError(
						"MCP_WRONG_SERVER",
						`127.0.0.1:${port}/healthz answered HTTP ${probe.status}: not the geocluster MCP; another server holds the port?`,
					)
				}
				// Not listening yet (Python imports and the sklearn warm-up take seconds): wait, waking early on exit
				await Promise.race([sleep(this.pollMs), ended])
			}
			// /healthz answered, but from our process? It could have died between the probe and now
			if (exited || child.exitCode !== null || child.signalCode !== null) {
				throw startError("MCP_EARLY_EXIT", `MCP server exited during start: ${lastLines(output.tail()) || "no output"}`)
			}
		} catch (error) {
			// Whatever this attempt spawned goes with it, whether it failed or stop() cancelled it
			await this.#terminate(child, this.#stopGraceMs)
			throw error
		}

		child.ready = true
		this.#state = "ready"
		this.#recordHealth(health)
		const restarted = reason !== "start"
		this.logger.info("mcp ready", { pid: child.pid, port, restarted, startMs: Date.now() - spawnedAt })
		this.emit("ready", { restarted, pid: child.pid })
	}

	#scheduleRestart(why) {
		if (this.#stopRequested) return
		const now = Date.now()
		this.#restarts = this.#restarts.filter((t) => now - t < this.restartWindowMs)
		if (this.#restarts.length >= this.maxRestarts) {
			this.#state = "unavailable"
			this.logger.error("mcp restarted too often; giving up until revive()", {
				restarts: this.#restarts.length,
				windowMs: this.restartWindowMs,
				why,
			})
			this.emit("unavailable")
			return
		}
		const delayMs = this.backoffMs[Math.min(this.#restarts.length, this.backoffMs.length - 1)]
		this.#restarts.push(now)
		this.#state = "starting"
		this.logger.warn("mcp restart scheduled", { delayMs, why, restartsInWindow: this.#restarts.length })
		clearTimeout(this.#retryTimer)
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = null
			if (this.#stopRequested || this.#child || this.#attempt) return
			void this.#launch("restart")
		}, delayMs)
		// Not unref'd: a pending restart is work in progress (stop() clears it). Unref'd, a process with nothing
		// else to do would exit during the backoff instead of restarting the server.
	}

	/** One GET /healthz: {kind:"ok", body} | {kind:"http", status} | {kind:"down", error}. Never throws. */
	async #probe(timeoutMs) {
		let response
		try {
			response = await this.fetchImpl(`http://127.0.0.1:${this.port}/healthz`, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
			})
		} catch (error) {
			return { kind: "down", error: String(error?.cause?.code ?? error?.name ?? error) }
		}
		let text = ""
		try {
			text = await response.text()
		} catch (error) {
			return { kind: "down", error: String(error?.name ?? error) }
		}
		if (response.status !== 200) return { kind: "http", status: response.status }
		try {
			const body = JSON.parse(text)
			if (body && typeof body === "object") return { kind: "ok", body }
		} catch {
			// fall through: a 200 that isn't JSON is someone else's server
		}
		return { kind: "http", status: response.status }
	}

	#recordHealth(body) {
		const health = {
			ok: body?.ok === true,
			mode: typeof body?.mode === "string" ? body.mode : null,
			inFlight: Number.isFinite(body?.in_flight) ? body.in_flight : null,
		}
		this.#lastHealth = { ...health, at: Date.now() }
		return health
	}

	/** Wait for in-flight tool calls to finish, at most drainMs. A server that doesn't answer isn't waited for. */
	async #drain(child, drainMs) {
		const startedAt = Date.now()
		const deadline = startedAt + drainMs
		let first = null
		let last = null
		while (child.exitCode === null && child.signalCode === null) {
			const remaining = deadline - Date.now()
			if (remaining <= 0) break
			const health = await this.health(Math.min(HEALTH_TIMEOUT_MS, remaining))
			if (!health) {
				this.logger.warn("mcp drain skipped: /healthz not answering", { pid: child.pid })
				return
			}
			last = health.inFlight ?? 0
			if (first === null) {
				first = last
				if (first > 0) this.logger.info("mcp draining", { pid: child.pid, inFlight: first, drainMs })
			}
			if (last <= 0) {
				if (first > 0) this.logger.info("mcp drained", { pid: child.pid, waitedMs: Date.now() - startedAt })
				return
			}
			await sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())))
		}
		if (last > 0) this.logger.warn("mcp drain timed out; stopping with tool calls in flight", { pid: child.pid, inFlight: last, drainMs })
	}

	/** SIGTERM, SIGKILL after graceMs, then reap what it left (its workers outlive it once re-parented). */
	async #terminate(child, graceMs) {
		child.expectedExit = true
		if (child.exitCode === null && child.signalCode === null) {
			// Snapshot while the ancestry is intact
			child.tree = mergeTrees(child.tree, await descendants(child.pid))
			await new Promise((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null) return resolve()
				const timer = setTimeout(() => {
					this.logger.warn("mcp did not exit in time; killing", { pid: child.pid, graceMs })
					child.kill("SIGKILL")
				}, graceMs)
				child.once("exit", () => {
					clearTimeout(timer)
					resolve()
				})
				child.kill("SIGTERM")
			})
		}
		// Already being reaped when it died on its own before this call (the "exit" handler started it)
		if (child.reaped) return
		child.reaped = true
		const count = await reapTree(child.tree)
		if (count) this.logger.warn("stopped processes the MCP left running", { pid: child.pid, count })
	}

	#reapLeftovers(child) {
		if (child.reaped) return
		child.reaped = true
		const reaping = reapTree(child.tree)
			.then((count) => {
				if (count) this.logger.warn("stopped processes the MCP left running", { pid: child.pid, count })
			})
			.catch(() => {})
			.finally(() => this.#reaping.delete(reaping))
		this.#reaping.add(reaping)
	}

	/**
	 * Its descendants, re-read every treeSnapshotMs while it runs: after a crash (an OOM kill, typically) the
	 * workers are re-parented and can't be found by ancestry, so what was seen is what gets reaped. Merged,
	 * never replaced (see agent-supervisor.js: a tick between the death and Node's "exit" sees an empty tree).
	 */
	#watchTree(child) {
		const timer = setInterval(async () => {
			if (child.exitCode !== null || child.signalCode !== null) return
			child.tree = mergeTrees(stillRunning(child.tree), await descendants(child.pid))
		}, Math.max(50, this.config.treeSnapshotMs ?? 5000))
		timer.unref?.()
		child.once("exit", () => clearInterval(timer))
	}

	/**
	 * <logDir>/mcp.log, appended across restarts. One generation is kept: past the cap at a start, the file
	 * becomes mcp.log.1. Never fails a start: without a log the server still runs.
	 */
	async #openLog() {
		const dir = this.config.logDir
		const file = path.join(dir, "mcp.log")
		let size = 0
		try {
			await fs.mkdir(dir, { recursive: true })
			size = (await fs.stat(file).catch(() => ({ size: 0 }))).size
			if (size >= LOG_CAP_BYTES) {
				await fs.rename(file, `${file}.1`)
				size = 0
			}
		} catch (error) {
			this.logger.warn("mcp log unavailable", { file, error: String(error?.message ?? error) })
			return { write: () => {}, close: () => {} }
		}
		const stream = createWriteStream(file, { flags: "a", mode: 0o640 })
		let broken = false
		stream.on("error", (error) => {
			if (!broken) this.logger.warn("mcp log write failed", { file, error: String(error?.message ?? error) })
			broken = true
		})
		let budget = LOG_CAP_BYTES - size
		return {
			write: (chunk) => {
				if (broken || budget <= 0) return
				budget -= chunk.length
				stream.write(budget > 0 ? chunk : `${chunk}\n[mcp.log capped at ${LOG_CAP_BYTES} bytes]\n`)
			},
			close: () => stream.end(),
		}
	}

	/**
	 * stdout + stderr → mcp.log (capped), and the tail kept for start errors.
	 *
	 * uvicorn writes an access line for every request, so each health() (a /readyz, a drain poll, the start's
	 * polls) would add ~90 bytes: at one /readyz every 10 s the log reached its cap in under two weeks and then
	 * dropped the lines that matter. The supervisor's own successful /healthz lines are left out. Lines are
	 * split per stream, so a partial stdout line can't be glued to a stderr one.
	 */
	#capture(child, log, reason) {
		let tail = ""
		log.write(`\n--- ${new Date().toISOString()} mcp start pid=${child.pid} port=${this.port} (${reason}) ---\n`)
		const emit = (text) => {
			if (!text) return
			log.write(text)
			tail = (tail + text).slice(-TAIL_CHARS)
		}
		const lineFilter = (stream) => {
			let carry = ""
			stream.setEncoding("utf8")
			stream.on("data", (chunk) => {
				const text = carry + chunk
				const end = text.lastIndexOf("\n")
				if (end < 0) {
					carry = text.length > 64 * 1024 ? (emit(text), "") : text
					return
				}
				carry = text.slice(end + 1)
				emit(
					text
						.slice(0, end + 1)
						.split(/(?<=\n)/)
						.filter((line) => !HEALTHZ_ACCESS_LINE.test(line))
						.join(""),
				)
			})
			return {
				flush: () => {
					emit(carry)
					carry = ""
				},
				pending: () => carry,
			}
		}
		const out = lineFilter(child.stdout)
		const err = lineFilter(child.stderr)
		// "close", not "exit": a worker holding the pipes may still write after the server is gone
		child.once("close", () => {
			out.flush()
			err.flush()
			log.close()
		})
		// A last line without its newline (an early exit) still belongs in a start error
		return { tail: () => `${tail}${out.pending()}\n${err.pending()}` }
	}
}
