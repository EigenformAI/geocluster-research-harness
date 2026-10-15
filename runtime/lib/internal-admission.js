import { FileError } from "./file-contract.js"
export function waitDeadline(value) {
	const deadline = typeof value === "number" ? value : Date.parse(value)
	if (!Number.isFinite(deadline)) throw new FileError(400, "invalid_request", "Internal admission requires a finite deadline.")
	return deadline
}
/** Finite FIFO permits. Only internal entry points enqueue; public work tries once. */
export class InternalAdmission {
	#queue = []
	#closed = false
	constructor({ available, reserve, waiters, resource }) { Object.assign(this, { available, reserve, waiters, resource }) }
	get waiting() { return this.#queue.length }
	capacity() { return new FileError(429, "capacity", `The ${this.resource} admission is full.`, { retryAfter: 1 }) }
	#permit() { const release = this.reserve(); let released = false; return () => { if (!released) { released = true; release(); this.#pump() } } }
	tryAcquire(wait) {
		if (this.#closed) throw new FileError(503, "draining", `${this.resource} admission is closed.`)
		if (wait !== undefined && waitDeadline(wait.deadline) <= Date.now()) throw this.#expired()
		if (this.#queue.length || !this.available()) throw this.capacity()
		return this.#permit()
	}
	acquire({ deadline, onWait } = {}) {
		deadline = waitDeadline(deadline)
		if (this.#closed) return Promise.reject(new FileError(503, "draining", `${this.resource} admission is closed.`))
		if (deadline <= Date.now()) return Promise.reject(this.#expired())
		if (!this.#queue.length && this.available()) return Promise.resolve(this.#permit())
		if (this.#queue.length >= this.waiters()) return Promise.reject(this.capacity())
		return new Promise((resolve, reject) => {
			const entry = { deadline, resolve, reject, ready: false, onWait, started: Date.now() }; this.#queue.push(entry)
			entry.timer = setTimeout(() => this.#remove(entry, this.#expired()), Math.max(0, deadline - Date.now()))
			entry.notification = Promise.resolve().then(() => onWait?.({ waiting: true, state: "waiting", waitingFor: this.resource, deadline, retryAt: null }))
			entry.notification.then(() => { entry.ready = true; this.#pump() }, (error) => this.#remove(entry, error))
		})
	}
	#expired() { return new FileError(429, "capacity_wait_limit", `Waiting for ${this.resource} capacity exceeded the contention allowance.`) }
	#remove(entry, error) {
		const index = this.#queue.indexOf(entry); if (index === -1) return
		this.#queue.splice(index, 1); clearTimeout(entry.timer)
		Promise.resolve(entry.notification).then(() => entry.reject(error), () => entry.reject(error)); this.#pump()
	}
	#pump() {
		if (this.#closed) return
		while (this.#queue.length && this.available()) {
			const entry = this.#queue[0]
			if (entry.deadline <= Date.now()) { this.#remove(entry, this.#expired()); continue }
			if (!entry.ready) break
			this.#queue.shift(); clearTimeout(entry.timer); const release = this.#permit()
			Promise.resolve().then(() => entry.onWait?.({ waiting: false, state: "admitted", waitingFor: this.resource, deadline: entry.deadline, retryAt: null, waitedMs: Date.now() - entry.started })).then(() => entry.resolve(release), (error) => { release(); entry.reject(error) })
		}
	}
	close() { this.#closed = true; for (const entry of [...this.#queue]) this.#remove(entry, new FileError(503, "draining", `${this.resource} admission is closed.`)) }
}
