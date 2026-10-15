import fs from "node:fs/promises"

const MAX_BYTES = 64 * 1024
const validToken = (value) => typeof value === "string" && value.length <= 16384 && /^[\x21-\x7e]+$/.test(value)

export function credentialsResponse(value, now = Date.now()) {
	if (!value || typeof value.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.expiresAt) || !(Date.parse(value.expiresAt) > now)) throw new Error("invalid_machine_credentials_response")
	if (value.cleanupToken !== undefined) {
		if (!validToken(value.cleanupToken) || ["llmToken", "activityToken", "datasetToken", "filesToken", "workToken"].some((key) => value[key])) throw new Error("invalid_machine_cleanup_credentials_response")
		return { cleanupToken: value.cleanupToken, credentialsMode: "cleanup", llmToken: "", activityToken: "", datasetToken: "", filesToken: "", workToken: "", machineCredentialsExpiresAt: new Date(value.expiresAt).toISOString() }
	}
	if (!["llmToken", "activityToken", "datasetToken"].every((name) => validToken(value[name]))) throw new Error("invalid_machine_credentials_response")
	for (const name of ["filesToken", "workToken"]) if (value[name] !== undefined && !validToken(value[name])) throw new Error("invalid_machine_credentials_response")
	return { llmToken: value.llmToken, activityToken: value.activityToken, datasetToken: value.datasetToken, filesToken: value.filesToken || "", workToken: value.workToken || "", cleanupToken: "", credentialsMode: "normal", machineCredentialsExpiresAt: new Date(value.expiresAt).toISOString() }
}

export function serviceUrl(value, name) {
	let url
	try { url = new URL(value) } catch { throw new Error(`invalid_${name}`) }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error(`invalid_${name}`)
	return url
}

/** Independently scheduled credentials; no conversation, browser, or engine lifecycle hooks. */
export class MachineCredentials {
	constructor(config, logger = console, { fetchImpl = globalThis.fetch, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, retryMs = 1000, retryMaxMs = 60000 } = {}) {
		Object.assign(this, { config, logger, fetch: fetchImpl, now, setTimer: setTimeoutImpl, clearTimer: clearTimeoutImpl, retryMs, retryMaxMs })
		this.failures = 0
		this.closed = false
		this.abort = new AbortController()
	}
	get enabled() { return Boolean(this.config.machineTokenFile || this.config.machineCredentialsUrl) }
	get expired() { return !(Date.parse(this.config.machineCredentialsExpiresAt) > this.now()) }
	async start(initial) {
		if (!this.enabled) return false
		if (!this.config.machineTokenFile || !this.config.machineCredentialsUrl) throw new Error("IDE_MACHINE_TOKEN_FILE and IDE_MACHINE_CREDENTIALS_URL are required together")
		serviceUrl(this.config.machineCredentialsUrl, "machine_credentials_url")
		if (initial) {
			const fresh = credentialsResponse(initial, this.now())
			this.#requireFileTokens(fresh)
			Object.assign(this.config, fresh)
			this.#scheduleFresh()
		} else await this.refresh()
		return true
	}
	refresh() {
		if (this.closed) return Promise.resolve()
		if (this.inflight) return this.inflight
		this.inflight = this.#renew().finally(() => { this.inflight = null })
		return this.inflight
	}
	async #renew() {
		try {
			const bytes = await fs.readFile(this.config.machineTokenFile)
			if (bytes.length > 16384 || !validToken(bytes.toString("utf8").trim())) throw new Error("invalid_machine_token_file")
			const response = await this.fetch(this.config.machineCredentialsUrl, {
				method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
				headers: { authorization: `Bearer ${bytes.toString("utf8").trim()}`, "content-type": "application/json" }, body: "{}",
				signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]),
			})
			if (!response.ok) { await response.body?.cancel(); throw new Error(`machine_credentials_http_${response.status}`) }
			const reader = response.body.getReader(), chunks = []
			let size = 0
			try {
				while (true) {
					const { value, done } = await reader.read()
					if (done) break
					size += value.byteLength
					if (size > MAX_BYTES) throw new Error("machine_credentials_response_too_large")
					chunks.push(value)
				}
			} finally { await reader.cancel().catch(() => {}) }
			let value
			try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) } catch { throw new Error("invalid_machine_credentials_json") }
			const fresh = credentialsResponse(value, this.now())
			this.#requireFileTokens(fresh)
			if (this.closed) return
			// Validate every purpose token before one synchronous update; request auth reads config afresh.
			Object.assign(this.config, fresh)
			this.failures = 0
			this.logger.info("machine credentials renewed", { expiresAt: fresh.machineCredentialsExpiresAt })
			this.#scheduleFresh()
		} catch (error) {
			if (this.closed) return
			const retryInMs = Math.min(this.retryMaxMs, this.retryMs * 2 ** Math.min(this.failures++, 16))
			// Never emit response bodies, URLs, file content, or arbitrary fetch error messages.
			const reason = /^machine_credentials_http_\d+$|^invalid_machine_|^machine_credentials_response_too_large$/.test(error.message) ? error.message : "machine_credentials_unavailable"
			this.logger.warn("machine credential renewal failed", { reason, expired: this.expired, retryInMs, action: "Check the machine renewal endpoint and generation credential; renewal will retry." })
			this.#schedule(retryInMs)
			throw new Error(reason)
		}
	}
	#requireFileTokens(fresh) {
		if (fresh.credentialsMode === "cleanup") return
		if (this.config.filesUrl && !fresh.filesToken || this.config.fileWorkUrl && !fresh.workToken) throw new Error("invalid_machine_file_credentials_response")
	}
	#schedule(delay) {
		this.clearTimer(this.timer)
		this.timer = this.setTimer(() => this.refresh().catch(() => {}), delay)
		this.timer?.unref?.()
	}
	#scheduleFresh() {
		const ttl = Date.parse(this.config.machineCredentialsExpiresAt) - this.now()
		this.#schedule(Math.max(1, ttl - Math.min(60000, Math.max(1, ttl / 5))))
		this.clearTimer(this.expiryTimer)
		this.expiryTimer = this.setTimer(() => {
			if (!this.closed && this.expired) this.logger.warn("machine credentials expired", { expiresAt: this.config.machineCredentialsExpiresAt, action: "Restore machine credential renewal; future service requests await fresh credentials." })
		}, ttl)
		this.expiryTimer?.unref?.()
	}
	async close() {
		this.closed = true
		this.clearTimer(this.timer); this.clearTimer(this.expiryTimer)
		this.abort.abort()
		await this.inflight?.catch(() => {})
	}
}
