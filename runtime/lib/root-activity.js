import { diskUsage } from "./activity.js"

const STATES = new Set(["idle", "prompt_running", "permission_pending"])
const AGENT_STATES = new Set(["idle", "working", "needs_input"])
const observed = (source) => Date.parse(source?.observedAt ?? source?.checkedAt)

/** Only the gateway reports the agent; root forwards a checked copy under its own credential. */
function agentOf(source) {
	const agent = source?.agent
	if (!agent || !AGENT_STATES.has(agent.state)) return null
	const completed = Date.parse(agent.turn_completed_at)
	return { state: agent.state, turn_completed_at: Number.isFinite(completed) ? new Date(completed).toISOString() : null }
}

/** Unknown sources are conservative; expiry withdraws keepalive, not evidence of completion. */
export function aggregateActivity(sources, { now = Date.now(), maxInterestMs = 6 * 3600000, freshnessMs = 15000 } = {}) {
	const active = [], expired = []
	let unknown = false
	for (const source of sources) {
		if (!source || !STATES.has(source.state) || !Number.isFinite(observed(source)) || now - observed(source) > freshnessMs) {
			unknown = true
			continue
		}
		if (source.state !== "idle" && !source.interests?.length) active.push({ state: source.state, session_id: source.session_id ?? null })
		for (const interest of source.interests ?? []) {
			const started = Date.parse(interest.startedAt)
			if (!Number.isFinite(started) || !STATES.has(interest.state)) { unknown = true; continue }
			// A source's explicit cap decision takes precedence over the fallback age cap.
			// Live chat declares capped:false because turn age only produces a notice.
			if (interest.capped ?? (maxInterestMs > 0 && now >= started + maxInterestMs)) {
				expired.push({ id: interest.id, expiredAt: interest.expiredAt ?? new Date(started + maxInterestMs).toISOString(), reason: "activity_keepalive_expired" })
			} else if (interest.state !== "idle") active.push({ state: interest.state, session_id: interest.session_id ?? source.session_id ?? null })
		}
	}
	const permission = active.find((i) => i.state === "permission_pending")
	return { state: permission ? "permission_pending" : active.length || unknown ? "prompt_running" : "idle", session_id: (permission ?? active.find((i) => i.session_id))?.session_id ?? null, expired, unknown }
}

export class RootActivityReporter {
	constructor({ url, token, sources, agentSource = null, agentPollMs = 2000, fetchImpl = globalThis.fetch, logger = console, intervalMs = 60000, maxInterestMs = 6 * 3600000, storageDir = "", storageIntervalMs = 0, onSnapshot = async () => {} }) {
		Object.assign(this, { url, token, sources, agentSource, agentPollMs, fetch: fetchImpl, logger, intervalMs, maxInterestMs, storageDir, storageIntervalMs, onSnapshot })
		this.inflight = null
		this.closed = false
		this.lastState = null
		this.lastAgent = null
		this.agent = { state: "idle", turn_completed_at: null }
		this.storageDue = false
		this.watchedAgent = null
		this.watching = false
		this.warnedStorage = false
		this.unknownSince = new Map()
		this.abort = new AbortController()
	}
	start() {
		void this.tick()
		this.timer = setInterval(() => void this.tick(), this.intervalMs)
		if (this.url && this.token && this.storageIntervalMs > 0) this.storageTimer = setInterval(() => void this.reportStorage(), this.storageIntervalMs)
		if (this.agentSource) this.agentTimer = setInterval(() => void this.watchAgent(), this.agentPollMs)
	}
	/**
	 * The gateway's agent state is cheap to read, unlike processing activity. A change in it between
	 * ticks (a permission request, its answer, a turn ending) is reported at once.
	 */
	async watchAgent() {
		if (this.closed || this.watching) return
		this.watching = true
		try {
			const value = await this.agentSource().catch(() => null)
			const key = JSON.stringify([value?.state ?? null, agentOf(value)])
			if (key === this.watchedAgent) return
			const underway = this.inflight
			await this.tick()
			// A poll already under way may have read the state before it changed
			if (underway) await this.tick()
		} finally { this.watching = false }
	}
	/** Disk usage goes out even while idle. A poll already under way may have decided before it was asked for. */
	async reportStorage() {
		this.storageDue = true
		await this.tick()
		if (this.storageDue) await this.tick()
	}
	tick() {
		if (this.closed) return Promise.resolve()
		if (this.inflight) return this.inflight
		this.inflight = this.#poll().catch(() => this.logger.warn("root activity poll failed")).finally(() => { this.inflight = null })
		return this.inflight
	}
	async #poll() {
		const now = Date.now()
		let expiredUnknown = false
		const snapshots = await Promise.all(this.sources.map(async (read, index) => {
			const value = await read().catch(() => null)
			if (value && STATES.has(value.state) && Number.isFinite(observed(value)) && now - observed(value) <= 15000) {
				this.unknownSince.delete(index)
				return value
			}
			if (!this.unknownSince.has(index)) this.unknownSince.set(index, now)
			const started = this.unknownSince.get(index)
			expiredUnknown ||= this.maxInterestMs > 0 && now >= started + this.maxInterestMs
			return { state: "prompt_running", observedAt: new Date(now).toISOString(), interests: [{ id: `source_${index}_unknown`, state: "prompt_running", startedAt: new Date(started).toISOString() }] }
		}))
		const aggregate = aggregateActivity(snapshots, { now, maxInterestMs: this.maxInterestMs })
		// An unreachable gateway keeps its last report: its turns are unknown, not finished.
		const gateway = snapshots.find((source) => agentOf(source))
		const agent = agentOf(gateway)
		const watchedAgent = agent ? JSON.stringify([gateway.state, agent]) : null
		if (agent) this.agent = agent
		await this.onSnapshot(aggregate)
		// A capped outage withdraws pings; it cannot certify an idle machine.
		if (expiredUnknown && aggregate.state === "idle") return
		if (!this.url || !this.token) return
		const agentKey = JSON.stringify(this.agent), storageDue = this.storageDue
		this.storageDue = false
		if (aggregate.state === "idle" && this.lastState === "idle" && agentKey === this.lastAgent && !storageDue) {
			if (agent) this.watchedAgent = watchedAgent
			return
		}
		const storage = this.#storage()
		try {
			const response = await this.fetch(this.url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` }, body: JSON.stringify({ state: aggregate.state, session_id: aggregate.session_id, agent: this.agent, ...(storage ? { storage } : {}) }), signal: AbortSignal.any([AbortSignal.timeout(10000), this.abort.signal]) })
			if (response.ok) {
				this.lastState = aggregate.state
				this.lastAgent = agentKey
				// Only acknowledge the gateway snapshot actually delivered, so failed reads/posts retry.
				if (agent) this.watchedAgent = watchedAgent
			}
			else this.logger.warn("root activity ping rejected", { status: response.status })
			await response.body?.cancel()
		} catch { this.logger.warn("root activity ping failed") }
	}
	#storage() {
		if (!(this.storageIntervalMs > 0)) return null
		try { return diskUsage(this.storageDir) } catch {
			if (!this.warnedStorage) { this.warnedStorage = true; this.logger.warn("root activity disk usage unreadable") }
			return null
		}
	}
	async close() { this.closed = true; clearInterval(this.timer); clearInterval(this.storageTimer); clearInterval(this.agentTimer); this.abort.abort(); await this.inflight }
}
