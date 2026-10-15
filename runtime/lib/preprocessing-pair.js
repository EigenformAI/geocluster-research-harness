import { spawn } from "node:child_process"

/** Restarts only the standalone pair; file and conversation services keep their state. */
export class PreprocessingPair {
	constructor({ command, args, env, maxAttempts = 5, backoffMs = 1000, cooldownMs = 300000, spawnImpl = spawn, logger = console,
		clock = Date.now, random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout }) {
		for (const [name, value] of Object.entries({ maxAttempts, cooldownMs })) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
		if (!Number.isFinite(backoffMs) || backoffMs <= 0) throw new Error("backoffMs must be positive")
		Object.assign(this, { command, args, env, maxAttempts, backoffMs, cooldownMs, spawn: spawnImpl, logger, clock, random, setTimer, clearTimer })
		this.attempts = 0
		this.burstCount = 0
		this.timer = null
		this.nextRetryAt = null
		this.stopping = false
		this.state = "unconfigured"
		this.lastExitCode = null
	}
	start() {
		if (this.stopping || this.child || this.timer !== null) return
		this.attempts++
		this.burstCount = Math.min(this.maxAttempts, this.burstCount + 1)
		this.state = "starting"
		let child
		try { child = this.spawn(this.command, this.args, { env: this.env, stdio: ["pipe", "inherit", "inherit"] }) }
		catch { this.lastExitCode = 1; this.scheduleRestart(); return }
		this.child = child
		this.exited = new Promise((resolve) => {
			let done = false
			const exited = (code) => {
				if (done) return
				done = true
				if (this.child === child) this.child = null
				this.lastExitCode = code
				this.state = this.stopping ? "stopped" : "unavailable"
				resolve(code)
				if (!this.stopping) this.scheduleRestart()
				if (!this.stopping) this.logger.warn("preprocessing pair exited; retained jobs await dependency recovery", { attempt: this.attempts, code })
			}
			child.once("exit", exited)
			// A failed spawn has no process to reap. Errors on an existing child do
			// not release ownership: replacement waits for its exit event.
			child.once("error", () => { if (!child.pid) exited(1) })
			child.stdin?.on("error", () => {})
		})
	}
	scheduleRestart() {
		if (this.stopping || this.child || this.timer !== null) return
		const cooldown = this.burstCount >= this.maxAttempts
		const delay = cooldown ? Math.round(this.cooldownMs * (.8 + .4 * this.random())) : Math.min(30000, this.backoffMs * 2 ** (this.burstCount - 1))
		this.state = cooldown ? "cooldown" : "unavailable"
		const retryDate = new Date(this.clock() + delay)
		this.nextRetryAt = Number.isFinite(retryDate.getTime()) ? retryDate.toISOString() : null
		// Node clamps delays above its signed 32-bit limit to 1 ms. Chunk long
		// explicit cooldowns instead, preserving their requested launch rate.
		const schedule = (remaining) => {
			const chunk = Math.min(remaining, 2147483647)
			this.timer = this.setTimer(() => {
				this.timer = null
				if (this.stopping) return
				if (remaining > chunk) { schedule(remaining - chunk); return }
				this.nextRetryAt = null
				this.start()
			}, chunk)
		}
		schedule(delay)
	}
	async stop(deadlineMs) {
		this.stopping = true
		this.clearTimer(this.timer)
		this.timer = null
		this.nextRetryAt = null
		if (this.stopPromise) return this.stopPromise
		if (!this.child) {
			const complete = this.state === "unconfigured" || this.lastExitCode === 0
			this.state = "stopped"
			return { complete, state: this.state, attempts: this.attempts, recoveryRequired: !complete }
		}
		this.state = "draining"
		this.child.stdin.end(JSON.stringify({ deadlineMs }) + "\n")
		this.stopPromise = (async () => {
			let timer
			const code = await Promise.race([this.exited, new Promise((resolve) => { timer = this.setTimer(() => resolve("deadline"), Math.max(0, deadlineMs - this.clock())) })])
			this.clearTimer(timer)
			if (code === "deadline") this.child?.kill("SIGKILL")
			return { complete: code === 0, state: this.state, attempts: this.attempts, recoveryRequired: code !== 0 }
		})()
		return this.stopPromise
	}
	snapshot() { return { state: this.state, attempts: this.attempts, totalLaunches: this.attempts, burstCount: this.burstCount, childAlive: Boolean(this.child), cooldownMs: this.cooldownMs, nextRetryAt: this.nextRetryAt } }
}
