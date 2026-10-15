import { FileError } from "./file-contract.js"

const rejected = () => new FileError(503, "draining", "The runtime publication admission is closed.", { agent: "file-service", tool: "lifecycle-admission", action: "Retain the workspace and use the normal runtime lifecycle recovery." })
export const authorityLost = (error) => error?.status === 401 || ["demo_owner_fenced", "cleanup_only"].includes(error?.error)

/** Local namespace exclusion exists before SafeFs. Closure is irreversible for this daemon. */
export class LifecycleAdmission {
	constructor() { this.closed = false; this.tail = Promise.resolve(); this.listeners = new Set(); this.state = "initializing" }
	attach(workspace) { this.workspace = workspace; if (this.closed) workspace.draining = true }
	assertOpen() { if (this.closed) throw rejected() }
	publication(work) {
		const result = this.tail.then(async () => { this.assertOpen(); return work() })
		this.tail = result.catch(() => {})
		return result
	}
	// Dispatch is synchronous with admission. Never hold the namespace lock over a
	// backend request: normal deletion owns that backend's project lifecycle lock.
	checkpoint(dispatch) { this.assertOpen(); return dispatch() }
	loseAuthority() { this.closeAdmission(); this.authorityLost = true; this.state = "authority-lost" }
	onFence(listener) { if (this.closed) listener(this.fence); this.listeners.add(listener); return () => this.listeners.delete(listener) }
	closeAdmission(runtimeId, { drainWorkspace = true } = {}) {
		const admitted = this.workspace?.demo?.runtimeId
		if (runtimeId && admitted && runtimeId !== admitted) throw new FileError(409, "runtime_changed", "The lifecycle request names another admitted runtime owner.")
		if (runtimeId && this.fence?.runtimeId && runtimeId !== this.fence.runtimeId) throw new FileError(409, "runtime_changed", "The admission fence already belongs to a different runtime owner.")
		this.closed = true
		if (this.workspace && drainWorkspace) this.workspace.draining = true
		this.fence ||= { runtimeId: runtimeId || null, closedAt: new Date().toISOString() }
		if (runtimeId && !this.fence.runtimeId) this.fence.runtimeId = runtimeId
		// A failed durable callback leaves admission closed. A retry must persist it
		// successfully before it can acknowledge the namespace barrier.
		if (this.fence.runtimeId) for (const listener of this.listeners) listener(this.fence)
	}
	async barrier() {
		for (;;) { const pending = this.tail; await pending; if (pending === this.tail) break }
		if (this.workspace?.closed) await this.workspace.closing
		else if (this.workspace?.locks) await this.workspace.locks.run(async () => {})
		// Cleanup is local exact ownership only. Backend deletion can be holding its
		// project lock while it awaits this barrier; never perform network reads here.
		if (this.fence?.runtimeId) this.demoRetention = await this.workspace?.demo?.deletionCleanup()
	}
	snapshot() { return { state: this.state, admissionClosed: this.closed } }
}
