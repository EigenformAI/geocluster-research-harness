import fs from "node:fs/promises"
import { constants } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { NATIVE_PATH } from "../native-engine-env.mjs"

const script = fileURLToPath(new URL("../native-processing.py", import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const codes = new Set(["startup_failed", "startup_timeout", "startup_interrupted", "selected_model_unavailable", "engine_context_unavailable", "processor_exited", "dependency_exited", "cleanup_unverified"])
const stages = new Set(["launch", "extraction-context", "reconciliation", "processor", "running"])
const reasons = new Set(["selected_model_unavailable", "engine_context_unavailable", "readiness_unavailable", "processor_exited", "dependency_exited", "startup_timeout", "startup_interrupted", "cleanup_unverified"])
const actions = new Set(["check_model_and_connection", "check_engine_context", "inspect_retained_state", "restart_explicitly"])

export function processingDiagnostic(value, model) {
	return {
		code: codes.has(value?.code) ? value.code : "startup_failed",
		stage: stages.has(value?.stage) ? value.stage : "launch",
		model: typeof model === "string" && model.length <= 256 && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+(?:#[A-Za-z0-9._-]+)?$/.test(model) ? model : "redacted",
		reason: reasons.has(value?.reason) ? value.reason : "readiness_unavailable",
		action: actions.has(value?.action) ? value.action : "inspect_retained_state",
	}
}

export function processingError(value, model) {
	const diagnostic = processingDiagnostic(value, model)
	return Object.assign(new Error(`native processing owner unavailable: ${diagnostic.code} at ${diagnostic.stage} (${diagnostic.model}); ${diagnostic.action}`), { code: diagnostic.code, diagnostic })
}

/** One private owner pipe; provider secrets never enter argv or the supervisor environment. */
export class NativeProcessingOwner {
	constructor({ settings, workspace, engineEnv, drainTimeoutMs, logFd, spawnImpl = spawn }) {
		Object.assign(this, { settings, workspace, engineEnv, drainTimeoutMs, logFd, spawnImpl })
		this.invocationId = randomUUID()
		this.exited = new Promise((resolve) => { this.resolveExit = resolve })
	}

	async start() {
		if (this.child) throw new Error("native processing owner is single-use; restart explicitly")
		const child = this.child = this.spawnImpl("/opt/geocluster-preprocessing/bin/python", [
			"-I", "-u", script, "--state-dir", this.settings.stateDir, "--workspace", this.workspace,
			"--model", this.settings.model, "--drain-timeout-ms", String(this.drainTimeoutMs),
			"--invocation-id", this.invocationId,
		], { cwd: this.workspace, env: { PATH: NATIVE_PATH, LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", this.logFd, "pipe"] })
		child.stdio[3].on("error", () => {}) // A rejected startup can close this finite handoff early.
		child.stdin.on("error", () => {})
		child.stdio[3].end(JSON.stringify({ invocationId: this.invocationId, engineEnv: this.engineEnv, engineDescriptor: this.settings.engineDescriptor }))
		child.once("exit", (code, signal) => this.resolveExit({ code, signal }))
		child.once("error", () => { this.spawnFailed = true; this.resolveExit({ code: 1 }) })
		return await new Promise((resolve, reject) => {
			let buffer = "", settled = false
			const fail = () => { settled = true; reject(processingError(this.lastDiagnostic, this.settings.model)) }
			const timer = setTimeout(fail, 60000)
			const finish = () => clearTimeout(timer)
			child.stdout.on("data", (chunk) => {
				if (settled) return // Continue consuming; never log private handoff bytes.
				buffer += chunk.toString("utf8")
				if (Buffer.byteLength(buffer) > 65536) { finish(); fail(); return }
				try {
					while (buffer.includes("\n")) {
						const newline = buffer.indexOf("\n")
						const value = JSON.parse(buffer.slice(0, newline))
						buffer = buffer.slice(newline + 1)
						if (value.readiness || value.failure) {
							this.lastDiagnostic = processingDiagnostic(value.failure || value.readiness, this.settings.model)
							if (value.failure) { finish(); fail(); return }
							continue
						}
						if (typeof value.processorToken !== "string" || !/^[a-f0-9]{64}$/.test(value.processorToken)) throw new Error()
						if (value.borrowed !== true) {
							const url = new URL(value.url)
							if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || typeof value.password !== "string" || !value.password) throw new Error()
						}
						settled = true; buffer = ""; finish(); resolve(value); return
					}
				} catch { finish(); fail() }
			})
			// close follows stdout EOF, so a final diagnostic cannot lose a race to exit.
			child.once("close", () => { finish(); if (!settled) fail() })
			child.once("error", () => { finish(); if (!settled) fail() })
		})
	}

	async stop({ deadlineMs }) {
		if (!this.child || this.spawnFailed) return { complete: true }
		const child = this.child
		if (child.exitCode === null && child.signalCode === null) child.stdin.end(JSON.stringify({ deadlineMs }) + "\n")
		while (child.exitCode === null && child.signalCode === null && Date.now() < deadlineMs) await sleep(25)
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL") // Its lease-retaining guardians fence owned writers.
			throw new Error("native processing drain exceeded its deadline; retain processing state")
		}
		let handle, result
		try {
			handle = await fs.open(path.join(this.settings.stateDir, "drain.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
			const stat = await handle.stat()
			if (!stat.isFile() || stat.size > 65536) throw new Error()
			const bytes = Buffer.alloc(65537)
			let size = 0
			while (size < bytes.length) {
				const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null)
				if (!bytesRead) break
				size += bytesRead
			}
			if (size > 65536) throw new Error()
			result = JSON.parse(bytes.subarray(0, size).toString("utf8"))
		} catch {} finally { await handle?.close() }
		if (result?.invocationId !== this.invocationId || result?.complete !== true) {
			const components = new Set(["processor", "engine", "ownership", "probe", "descriptor", "receipt"])
			const failures = result?.invocationId === this.invocationId && Array.isArray(result.cleanup?.failures)
				? result.cleanup.failures.slice(0, 6).filter((entry) => components.has(entry?.component)).map(({ component }) => ({ component, code: "cleanup_unverified" })) : []
			const cleanup = { complete: false, failures: failures.length ? failures : [{ component: "processor", code: "cleanup_unverified" }] }
			throw Object.assign(new Error("native processing drain is incomplete; retain processing state and inspect its private log"), { cleanup })
		}
		return { complete: true }
	}
}
