import fs from "node:fs"

const AGENT_STATES = { idle: "idle", prompt_running: "working", permission_pending: "needs_input" }

/** Space on the filesystem holding `dir`, as the backend shows it. Throws when it cannot be read. */
export function diskUsage(dir) {
	// Synchronous: the reading is one metadata call, and an awaited one could let posts overtake each other
	const disk = fs.statfsSync(dir)
	return { used_bytes: (disk.blocks - disk.bfree) * disk.bsize, total_bytes: disk.blocks * disk.bsize, measured_at: new Date().toISOString() }
}

/**
 * Machine → backend activity signal.
 *
 * While any conversation has a turn running (or a permission request pending), the
 * gateway posts to RUNTIME_ACTIVITY_URL every interval and once more with "idle"
 * when the last one ends. Reports describe activity; backend lifecycle reconciliation
 * owns runtime lifetime. maxTurnMs is an age-notice threshold only.
 * Elapsed time never removes live work from activity; session/cancel remains available.
 *
 * Every post also says what the agent needs from the user and how full the workspace
 * volume is. Agent changes and turn ends are posted at once; disk usage also goes out
 * on its own interval from boot, idle or not. Posts go out one at a time, so the
 * backend applies them in order.
 */
export class ActivityReporter {
	constructor(config, logger, fetchImpl = globalThis.fetch) {
		this.config = config
		this.logger = logger
		this.fetch = fetchImpl
		this.timer = null
		this.storageTimer = null
		this.turns = new Map() // sessionId -> {state, startedAt, ageNoticed}
		/** When a turn last ended normally; held for the process lifetime. */
		this.turnCompletedAt = null
		this.warnedMissing = false
		this.warnedStorage = false
		this.onAgeNotice = null
		this.sending = null
	}

	get enabled() {
		return !this.config.aggregateActivity && Boolean(this.config.activityUrl && this.config.activityToken)
	}

	snapshot(now = Date.now()) {
		this.#noticeAge(now)
		return { state: this.state, session_id: this.turns.keys().next().value ?? null, agent: this.agent, observedAt: new Date(now).toISOString(), interests: [...this.turns.entries()].map(([id, t]) => ({ id, session_id: id, state: t.state, startedAt: new Date(t.startedAt).toISOString(), capped: false, ageNoticed: t.ageNoticed })) }
	}

	close() {
		clearInterval(this.timer)
		clearInterval(this.storageTimer)
		this.timer = this.storageTimer = null
	}

	get agent() {
		return { state: AGENT_STATES[this.state], turn_completed_at: this.turnCompletedAt }
	}

	/** Aggregate live work: permission_pending > prompt_running > idle. */
	get state() {
		const active = [...this.turns.values()]
		if (active.some((t) => t.state === "permission_pending")) return "permission_pending"
		return active.length ? "prompt_running" : "idle"
	}

	/** A turn started: ping now and keep pinging while any turn runs. */
	start(sessionId, state = "prompt_running") {
		this.turns.set(sessionId, { state, startedAt: Date.now(), ageNoticed: false })
		if (!this.timer) {
			this.timer = setInterval(() => this.#tick(), this.config.activityIntervalMs)
			this.timer.unref?.()
		}
		void this.#send(sessionId)
	}

	/** A permission request opening, or the last one closing, changes what the user must do: post it now. */
	setState(sessionId, state) {
		const turn = this.turns.get(sessionId)
		if (!turn) return
		const before = this.state
		turn.state = state
		if (this.state !== before) void this.#send(sessionId)
	}

	/**
	 * A turn ended: posted at once. After the last one, keepalives stop. `completed` marks a normal
	 * end (not cancelled, failed or paused), which the backend shows as the agent's last finished turn.
	 */
	stop(sessionId, { completed = false } = {}) {
		const turn = this.turns.get(sessionId)
		this.turns.delete(sessionId)
		if (turn && completed) this.turnCompletedAt = new Date().toISOString()
		if (this.turns.size === 0 && this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
		if (turn) void this.#send(sessionId)
	}

	/** From boot for the life of the process, idle included, so the backend can show disk usage of a quiet project. */
	startStorageReports() {
		if (!this.enabled || !(this.config.storageReportIntervalMs > 0) || this.storageTimer) return
		const report = () => void this.#send(this.turns.keys().next().value ?? null)
		this.storageTimer = setInterval(report, this.config.storageReportIntervalMs)
		this.storageTimer.unref?.()
		report()
	}

	#tick() {
		const now = Date.now()
		this.#noticeAge(now)
		if (this.state === "idle") return
		void this.#send(this.turns.keys().next().value ?? null)
	}

	#storage() {
		if (!(this.config.storageReportIntervalMs > 0)) return null
		try {
			return diskUsage(this.config.workspaceDir)
		} catch (error) {
			if (!this.warnedStorage) {
				this.warnedStorage = true
				this.logger.warn("workspace disk usage unreadable; activity posts go without it", String(error?.message ?? error))
			}
			return null
		}
	}

	#noticeAge(now) {
		for (const [sessionId, turn] of this.turns) {
			if (this.config.maxTurnMs > 0 && !turn.ageNoticed && now - turn.startedAt > this.config.maxTurnMs) {
				turn.ageNoticed = true
				this.logger.warn("turn exceeded RUNTIME_MAX_TURN_HOURS age notice; activity continues", {
					sessionId,
					hours: this.config.maxTurnMs / 3600000,
				})
				this.onAgeNotice?.(sessionId)
			}
		}
	}

	#send(sessionId) {
		if (this.config.aggregateActivity) return
		if (!this.enabled) {
			if (!this.warnedMissing) {
				this.warnedMissing = true
				this.logger.warn("RUNTIME_ACTIVITY_URL/TOKEN not set; the backend will not learn about running turns")
			}
			return
		}
		// Capture each transition now; a slow POST must not erase a short permission request.
		const report = { state: this.state, session_id: sessionId ?? null, agent: this.agent }
		const sending = (this.sending ? this.sending.then(() => this.#post(report)) : this.#post(report))
			.finally(() => { if (this.sending === sending) this.sending = null })
		this.sending = sending
		return sending
	}

	async #post(report) {
		const storage = this.#storage()
		try {
			const response = await this.fetch(this.config.activityUrl, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${this.config.activityToken}` },
				body: JSON.stringify({ ...report, ...(storage ? { storage } : {}) }),
				signal: AbortSignal.timeout(10000),
			})
			if (!response.ok) {
				this.logger.warn("activity ping rejected", { status: response.status, state: report.state })
			}
		} catch (error) {
			this.logger.warn("activity ping failed", String(error?.message ?? error))
		}
	}
}
