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
import { NativeProcessingOwner } from "./lib/native-processing-owner.js"

const CONFIG_DIR = "/opt/opencode/config/native"
const ENGINE_BIN = "/usr/local/bin/opencode"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function runNative({ stateDir, workspace, engineEnv, mcp, processingOwner, drainTimeoutMs = 240000, drainDeadline = () => Date.now() + drainTimeoutMs, spawnImpl = spawn, logger, engineBin = ENGINE_BIN, signals = process }) {
	let child, tree = [], timer, stopping = false, stopPromise
	const handlers = new Map()
	async function stop() {
		if (stopPromise) return stopPromise
		stopping = true
		stopPromise = (async () => {
			const deadlineMs = Math.min(drainDeadline(), Date.now() + drainTimeoutMs)
			try {
				if (child?.pid) {
					tree = mergeTrees(tree, await descendants(child.pid))
					if (child.exitCode === null && child.signalCode === null) {
						child.kill("SIGTERM")
						const end = Date.now() + 3000
						while (child.exitCode === null && child.signalCode === null && Date.now() < end) await sleep(25)
						if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
					}
					try { await processingOwner?.stop({ deadlineMs: deadlineMs - 3000 }) }
					finally {
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
					}
				} else await processingOwner?.stop({ deadlineMs: deadlineMs - 3000 })
			} finally { await mcp.stop({ drainMs: 3000, graceMs: 1000 }) }
		})()
		return stopPromise
	}
	for (const signal of ["SIGTERM", "SIGINT", "SIGQUIT", "SIGWINCH"]) {
		const handler = () => {
			if (signal === "SIGWINCH") { child?.kill(signal); return }
			child?.kill(signal)
			void stop().catch((error) => logger.error("native shutdown failed", { error: error.message }))
		}
		handlers.set(signal, handler)
		signals.on(signal, handler)
	}
	try {
		for (const name of ["home", "config", "data", "state", "cache", "logs"]) {
			await fs.mkdir(path.join(stateDir, name), { recursive: true, mode: 0o700 })
			await fs.chmod(path.join(stateDir, name), 0o700)
		}
		await mcp.start() // Resolves only after the real shared /healthz contract.
		if (stopping) return 130
		const connection = await processingOwner?.start()
		if (stopping) return 130
		const args = connection && !connection.borrowed ? ["--server", connection.url, workspace] : ["--standalone", workspace]
		const clientEnv = { ...engineEnv, ...(connection?.password ? { OPENCODE_PASSWORD: connection.password } : {}), ...(connection?.mcpToken ? { GEOCLUSTER_NATIVE_PROCESSING_TOKEN: connection.mcpToken } : {}) }
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
		return await (processingOwner ? Promise.race([ended, processingOwner.exited.then(() => {
			if (!stopping) logger.error("native processing owner exited; restart explicitly to recover retained work")
			return 1
		})]) : ended)
	} finally {
		clearInterval(timer)
		try { await stop() }
		finally { for (const [signal, handler] of handlers) signals.off(signal, handler) }
	}
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
	finally { await log.close() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(`[native] startup failed: ${error.message}; inspect native lifecycle and MCP logs`); process.exitCode = 1 })
}
