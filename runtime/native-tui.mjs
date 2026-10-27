#!/usr/bin/env node
import fs from "node:fs/promises"
import { readFileSync, writeSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { McpSupervisor } from "./lib/mcp-supervisor.js"
import { descendants, mergeTrees, reapTree, stillRunning } from "./lib/proc-tree.js"
import { NATIVE_PATH } from "./native-engine-env.mjs"
import { prepareNativeLaunch } from "./native-processing-settings.mjs"
import { NativeProcessingOwner, processingDiagnostic } from "./lib/native-processing-owner.js"
import { acquireNativeProcessingLease } from "./lib/native-processing-receipts.js"
import { createNativeProcessingBridge } from "./lib/native-processing-bridge.js"
import { PreprocessingClient } from "./lib/preprocessing-client.js"

const CONFIG_DIR = "/opt/opencode/config/native"
const ENGINE_BIN = "/usr/local/bin/opencode"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Failed drains retain a strong reference: FileHandle finalization must not release exclusion.
const retainedProcessingLeases = new Set()

export async function runNative({ stateDir, workspace, engineEnv, mcp, processingOwner,
	projectId = processingOwner?.settings?.projectId ?? path.basename(workspace),
	acquireProcessingLease = acquireNativeProcessingLease, createProcessingBridge = createNativeProcessingBridge,
	createProcessingClient = (options) => new PreprocessingClient(options),
	drainTimeoutMs = 240000, drainDeadline = () => Date.now() + drainTimeoutMs, spawnImpl = spawn, logger, engineBin = ENGINE_BIN, signals = process }) {
	let child, tree = [], timer, stopping = false, stopPromise, primary, result, shutdownSignal
	let lease, leaseStarting, bridge, bridgeStarting, ownerExit, ownerFailed = false
	const handlers = new Map()
	async function stop() {
		if (stopPromise) return stopPromise
		stopping = true
		clearInterval(timer)
		stopPromise = (async () => {
			let deadlineMs = Date.now() + drainTimeoutMs
			try { const requested = drainDeadline(); if (Number.isFinite(requested)) deadlineMs = Math.min(requested, deadlineMs) } catch {}
			const cleanup = { complete: true, failures: [] }
			async function attempt(component, work) {
				try {
					const outcome = await work()
					if (outcome?.complete === false) throw new Error("cleanup unverified")
					return true
				}
				catch (error) {
					cleanup.complete = false
					const allowed = new Set(["processor", "engine", "ownership", "probe", "descriptor", "receipt"])
					const details = component === "processor" && Array.isArray(error?.cleanup?.failures)
						? error.cleanup.failures.slice(0, 6).filter((entry) => allowed.has(entry?.component)).map(({ component }) => ({ component, code: "cleanup_unverified" })) : []
					cleanup.failures.push(...(details.length ? details : [{ component, code: "cleanup_unverified" }]))
					return false
				}
			}
			// Adopt in-flight resources before cleaning them; startup checks stopping at each boundary.
			if (leaseStarting) await leaseStarting.catch(() => {})
			let bridgeDrained = !bridgeStarting
			if (bridgeStarting) await attempt("bridge", async () => { bridge = await bridgeStarting })
			if (bridge) await attempt("bridge", () => bridge.closeAdmission())
			if (child?.pid) {
				await attempt("engine", async () => { tree = mergeTrees(tree, await descendants(child.pid)) })
				await attempt("engine", async () => {
					if (child.exitCode === null && child.signalCode === null) {
						child.kill(shutdownSignal || "SIGTERM")
						const end = Date.now() + 3000
						while (child.exitCode === null && child.signalCode === null && Date.now() < end) await sleep(25)
						if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
					}
				})
			}
			if (bridge) bridgeDrained = await attempt("bridge", () => bridge.drain({ deadlineMs: deadlineMs - 5000 }))
			const processorDrained = await attempt("processor", () => processingOwner?.stop({ deadlineMs: deadlineMs - 3000 }))
			if (child?.pid) {
				await attempt("engine", async () => {
					await reapTree(tree)
					const end = Date.now() + 1000
					for (;;) {
						const running = await Promise.all(tree.map(async (entry) => {
							const raw = await fs.readFile(`/proc/${entry.pid}/stat`, "utf8").catch(() => "")
							if (!raw) return false
							const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ")
							return fields[19] === entry.start && fields[0] !== "Z"
						}))
						if (!running.some(Boolean)) break
						if (Date.now() >= end) throw new Error("native tool descendants did not stop; retain the volume and inspect lifecycle logs")
						await sleep(20)
					}
				})
			}
			if (lease && bridgeDrained && processorDrained) {
				if (await attempt("bridge", () => lease.release())) retainedProcessingLeases.delete(lease)
			}
			if (lease) cleanup.leaseRetained = !lease.released
			await attempt("mcp", () => mcp.stop({ drainMs: 3000, graceMs: 1000 }))
			return cleanup
		})()
		return stopPromise
	}
	for (const signal of ["SIGTERM", "SIGINT", "SIGQUIT", "SIGWINCH"]) {
		const handler = () => {
			if (signal === "SIGWINCH") { child?.kill(signal); return }
			shutdownSignal ||= signal
			void stop()
		}
		handlers.set(signal, handler)
		signals.on(signal, handler)
	}
	async function start() {
		for (const name of ["home", "config", "data", "state", "cache", "logs"]) {
			await fs.mkdir(path.join(stateDir, name), { recursive: true, mode: 0o700 })
			await fs.chmod(path.join(stateDir, name), 0o700)
		}
		await mcp.start() // Resolves only after the real shared /healthz contract.
		if (stopping) return ownerFailed ? 1 : 130
		let connection
		if (processingOwner) {
			leaseStarting = Promise.resolve().then(() => acquireProcessingLease({ clientDir: path.join(processingOwner.settings.stateDir, "client") })).then((value) => {
				lease = value; retainedProcessingLeases.add(value); return value
			})
			await leaseStarting
			if (stopping) return ownerFailed ? 1 : 130
			ownerExit = processingOwner.exited?.then(() => {
				if (!stopping) {
					ownerFailed = true
					void stop()
					try { logger.error("native processing owner exited; restart explicitly to recover retained work") } catch {}
				}
				return 1
			})
			connection = await processingOwner.start()
			if (stopping) return ownerFailed ? 1 : 130
			bridgeStarting = Promise.resolve().then(() => createProcessingBridge({ lease, workspace, projectId,
				invocationId: processingOwner.invocationId, model: processingOwner.settings.model,
				client: createProcessingClient({ port: 8765, token: connection.processorToken }),
				logger,
			}))
			bridge = await bridgeStarting
		}
		if (stopping) return ownerFailed ? 1 : 130
		const args = connection && !connection.borrowed ? ["--server", connection.url, workspace] : ["--standalone", workspace]
		const clientEnv = { ...engineEnv, ...(connection?.password ? { OPENCODE_PASSWORD: connection.password } : {}) }
		delete clientEnv.GEOCLUSTER_NATIVE_PROCESSING_TOKEN
		if (processingOwner) clientEnv.OPENCODE_CLI_CONFIG_CONTENT = JSON.stringify({ tabs: { scope: "cwd" } })
		child = spawnImpl(engineBin, args, { cwd: workspace, env: clientEnv, stdio: "inherit" })
		const ended = new Promise((resolve, reject) => {
			child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)))
			child.once("error", reject)
		})
		timer = setInterval(async () => {
			tree = mergeTrees(stillRunning(tree), await descendants(child.pid))
		}, 100)
		timer.unref?.()
		logger.info("native TUI started", { pid: child.pid, profile: "native", frontend: "tui", identity: process.getuid?.() })
		return await (ownerExit ? Promise.race([ended, ownerExit]) : ended)
	}
	try { result = await start() }
	catch (error) { primary = error }
	finally {
		clearInterval(timer)
		const cleanup = await stop()
		for (const [signal, handler] of handlers) signals.off(signal, handler)
		if (primary) primary.cleanup = cleanup
		if (!cleanup.complete) {
			try { logger.error("native cleanup unverified", { cleanup }) } catch {} // Log I/O must not replace the cause.
			if (!primary && !result) primary = Object.assign(new Error("native cleanup unverified; retain processing state and inspect lifecycle logs"), {
				code: "cleanup_unverified", cleanup,
				diagnostic: { code: "cleanup_unverified", stage: "running", reason: "cleanup_unverified", action: "inspect_retained_state" },
			})
		}
	}
	if (primary) throw primary
	return result
}

async function main() {
	const [mode, stateDir, target, processingRoot] = process.argv.slice(2)
	if (mode === "prepare") {
		const launch = await prepareNativeLaunch(process.env, { stateDir, processingRoot, configDir: CONFIG_DIR })
		await fs.rm(target, { force: true })
		await fs.writeFile(target, JSON.stringify(launch), { mode: 0o600, flag: "wx" })
		return
	}
	if (mode !== "run") throw new Error("expected prepare or run")
	// Finite root-opened descriptor; stdin/stdout remain the terminal.
	const { engineEnv, processing } = JSON.parse(readFileSync(3, "utf8"))
	const logDir = path.join(stateDir, "logs")
	await fs.mkdir(logDir, { recursive: true, mode: 0o700 })
	const log = await fs.open(path.join(logDir, "lifecycle.log"), "a", 0o600)
	const logger = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (message, fields) => {
		writeSync(log.fd, JSON.stringify({ at: new Date().toISOString(), level, message, ...fields }) + "\n")
	}]))
	const configDigest = createHash("sha256").update(await fs.readFile(engineEnv.OPENCODE_CONFIG)).digest("hex")
	logger.info("native launch configuration", { configDigest, services: ["files", "mcp", "opencode", ...(processing ? ["processor"] : [])], engineBin: ENGINE_BIN })
	const mcp = new McpSupervisor({ logger, config: {
		mcpCommand: "/home/geocluster/mcp-server/.venv/bin/python", mcpArgs: ["-u", "main.py"],
		mcpCwd: "/home/geocluster/mcp-server", mcpPort: 7710, mcpWorkspaceRoot: target,
		mcpStartTimeoutMs: 45000, mcpCacheMb: 1024, mcpToolThreads: 8, mcpToolThreadsPerRun: 4,
		mcpDrainMs: 3000, mcpOomScoreAdj: 500, treeSnapshotMs: 100, logDir,
		toolHome: path.join(stateDir, "home"), agentEnv: { PATH: NATIVE_PATH, LANG: "C.UTF-8" },
	} })
	const drainTimeoutMs = Number(process.env.RUNTIME_NATIVE_DRAIN_TIMEOUT_MS || 240000)
	if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 5000) throw new Error("native drain timeout must allow at least five seconds")
	const processingOwner = processing ? new NativeProcessingOwner({ settings: processing, workspace: target, engineEnv, drainTimeoutMs, logFd: log.fd }) : undefined
	const drainDeadline = () => {
		try { const value = Number(readFileSync(path.join(stateDir, "../drain-deadline"), "utf8")); if (Number.isFinite(value) && value > 0) return value } catch {}
		return Date.now() + drainTimeoutMs
	}
	try { process.exitCode = await runNative({ stateDir, workspace: target, engineEnv, mcp, processingOwner, drainTimeoutMs, drainDeadline, logger }) }
	catch (error) {
		const failure = processingDiagnostic(error.diagnostic, processing?.model)
		logger.error("native startup or runtime failed", { failure, cleanup: error.cleanup })
		console.error(`[native] ${failure.code} at ${failure.stage} (${failure.model}); ${failure.action}; cleanup.complete: ${error.cleanup?.complete === true}`)
		process.exitCode = 1
	}
	finally { await log.close() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(() => { console.error("[native] startup failed; inspect native lifecycle and MCP logs"); process.exitCode = 1 })
}
