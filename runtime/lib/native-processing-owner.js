import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { NATIVE_PATH } from "../native-engine-env.mjs"

const script = fileURLToPath(new URL("../native-processing.py", import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One private owner pipe; provider secrets never enter argv or the supervisor environment. */
export class NativeProcessingOwner {
	constructor({ settings, workspace, engineEnv, drainTimeoutMs, logFd, spawnImpl = spawn }) {
		Object.assign(this, { settings, workspace, engineEnv, drainTimeoutMs, logFd, spawnImpl })
		this.exited = new Promise((resolve) => { this.resolveExit = resolve })
	}

	async start() {
		const child = this.child = this.spawnImpl("/opt/geocluster-preprocessing/bin/python", [
			"-I", "-u", script, "--state-dir", this.settings.stateDir, "--workspace", this.workspace,
			"--model", this.settings.model, "--drain-timeout-ms", String(this.drainTimeoutMs),
		], { cwd: this.workspace, env: { PATH: NATIVE_PATH, LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", this.logFd, "pipe"] })
		child.stdio[3].on("error", () => {}) // A rejected startup can close this finite handoff early.
		child.stdin.on("error", () => {})
		child.stdio[3].end(JSON.stringify({ engineEnv: this.engineEnv, engineDescriptor: this.settings.engineDescriptor }))
		child.once("exit", (code, signal) => this.resolveExit({ code, signal }))
		child.once("error", () => { this.spawnFailed = true; this.resolveExit({ code: 1 }) })
		return await new Promise((resolve, reject) => {
			let buffer = "", ready = false
			const fail = () => reject(new Error("native processing owner unavailable; check its private lifecycle log and processing model/connection"))
			const timer = setTimeout(fail, 60000)
			const finish = () => clearTimeout(timer)
			child.stdout.on("data", (chunk) => {
				if (ready) return // Continue consuming; never log private handoff bytes.
				buffer += chunk.toString("utf8")
				if (Buffer.byteLength(buffer) > 65536) { finish(); fail(); return }
				const newline = buffer.indexOf("\n")
				if (newline < 0) return
				try {
					const value = JSON.parse(buffer.slice(0, newline))
					if (value.borrowed === true) {
						if (typeof value.mcpToken !== "string" || !/^[A-Za-z0-9_-]+$/.test(value.mcpToken)) throw new Error()
					} else {
						const url = new URL(value.url)
						if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || typeof value.password !== "string" || !value.password) throw new Error()
					}
					ready = true; buffer = ""; finish(); resolve(value)
				} catch { finish(); fail() }
			})
			this.exited.then(() => { finish(); if (!ready) fail() })
		})
	}

	async stop({ deadlineMs }) {
		if (!this.child || this.spawnFailed) return
		const child = this.child
		if (child.exitCode === null && child.signalCode === null) child.stdin.end(JSON.stringify({ deadlineMs }) + "\n")
		while (child.exitCode === null && child.signalCode === null && Date.now() < deadlineMs) await sleep(25)
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL") // Its lease-retaining guardians fence owned writers.
			throw new Error("native processing drain exceeded its deadline; retain processing state")
		}
		let result
		if (child.exitCode === 0) {
			try { result = JSON.parse(await fs.readFile(path.join(this.settings.stateDir, "drain.json"), "utf8")) } catch {}
		}
		if (result?.complete !== true) throw new Error("native processing drain is incomplete; retain processing state and inspect its private log")
	}
}
