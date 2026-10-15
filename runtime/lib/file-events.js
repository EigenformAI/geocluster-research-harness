import crypto from "node:crypto"
import { FILE_LIMITS, FILES_CONTRACT_VERSION, FileError, canonicalPath } from "./file-contract.js"

const EVENT_TYPES = new Set(["invalidation", "index", "hydration", "persistence", "remote_replaced", "job", "reset"])
const intersects = (scope, path) => path === "" || scope === "" || path === scope || path.startsWith(`${scope}/`) || scope.startsWith(`${path}/`)

function scopedPayload(scope, payload) {
	// Artifact identity is epoch-scoped rather than path-scoped. A moved wrapper
	// or unchanged file tree must not hide deletion from named/exact subscribers.
	if (payload.reason === "artifact-deleted" && typeof payload.artifactId === "string") return payload
	if (Array.isArray(payload.changes)) {
		const changes = payload.changes.filter((change) => (typeof change.path === "string" && intersects(scope, change.path)) || (typeof change.from === "string" && intersects(scope, change.from)))
		return changes.length ? { ...payload, changes } : null
	}
	return typeof payload.path === "string" && !intersects(scope, payload.path) ? null : payload
}

/** Boot-local invalidation hints, bounded independently of browser connection lifetimes. */
export class FileEvents {
	constructor({ identity, limits = {}, bootId = crypto.randomUUID() }) {
		if (![identity?.workspaceId, identity?.workspaceEpoch, bootId].every((part) => typeof part === "string" && /^[A-Za-z0-9_-]+$/.test(part))) {
			throw new FileError(400, "invalid_id", "Event workspace, epoch, and boot identities must be nonempty and contain no dots.")
		}
		this.identity = Object.freeze({ ...identity })
		this.bootId = bootId
		this.limits = { ...FILE_LIMITS, heartbeatMs: 25000, ...limits }
		for (const key of ["eventCount", "eventBytes", "subscriberBytes", "heartbeatMs"]) {
			if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1) throw new FileError(400, "invalid_budget", `${key} must be a positive integer.`)
		}
		this.seq = 0
		this.ring = []
		this.ringBytes = 0
		this.subscribers = new Set()
		this.issuedScopes = new Map()
		this.scopeBytes = 0
		this.resetScopes = new Map()
		this.resetBytes = 0
		this.resetFloor = -1
		this.delivery = []
		this.closed = false
	}

	#envelope(seq, payload) {
		return { filesContractVersion: FILES_CONTRACT_VERSION, ...this.identity, bootId: this.bootId, seq, observedAt: new Date().toISOString(), payload }
	}

	#frame(type, envelope) {
		return `id: ${this.identity.workspaceEpoch}.${this.bootId}.${envelope.seq}\nevent: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`
	}

	#remember(seq, scope) {
		const previous = this.issuedScopes.get(seq)
		if (previous) { this.scopeBytes -= previous.bytes; this.issuedScopes.delete(seq) }
		// The specified SSE ID has no scope component. Shared IDs cannot prove a scope.
		const selected = previous && previous.scope !== scope ? null : scope
		const record = { scope: selected, bytes: 32 + (selected === null ? 0 : Buffer.byteLength(selected)) }
		this.issuedScopes.set(seq, record)
		this.scopeBytes += record.bytes
		this.#trimScopes()
	}

	#trimScopes() {
		while (this.issuedScopes.size && (this.issuedScopes.size > this.limits.eventCount + 32 || this.ringBytes + this.scopeBytes + this.resetBytes > this.limits.eventBytes)) {
			const seq = this.issuedScopes.keys().next().value
			this.scopeBytes -= this.issuedScopes.get(seq).bytes
			this.issuedScopes.delete(seq)
		}
		while (this.resetScopes.size && (this.resetScopes.size > 32 || this.ringBytes + this.scopeBytes + this.resetBytes > this.limits.eventBytes)) {
			const scope = this.resetScopes.keys().next().value
			const record = this.resetScopes.get(scope)
			// Forgotten overflow proofs conservatively reset old reconnects, without broadcasting.
			this.resetFloor = Math.max(this.resetFloor, record.seq)
			this.resetBytes -= record.bytes
			this.resetScopes.delete(scope)
		}
	}

	#markOverflow(scope) {
		const previous = this.resetScopes.get(scope)
		if (previous) { this.resetBytes -= previous.bytes; this.resetScopes.delete(scope) }
		const record = { seq: this.seq, bytes: 32 + Buffer.byteLength(scope) }
		this.resetScopes.set(scope, record)
		this.resetBytes += record.bytes
		this.#trimScopes()
	}

	publish(type, payload) {
		if (this.closed) throw new FileError(503, "storage_unavailable", "FileEvents is closed.", { tool: "file-events", action: "Restart the file service before publishing invalidations." })
		if (!EVENT_TYPES.has(type) || !payload || typeof payload !== "object" || Array.isArray(payload)) throw new FileError(400, "invalid_event", "Use a supported file event type and JSON object payload.")
		let copy
		try { copy = JSON.parse(JSON.stringify(payload)) } catch { throw new FileError(400, "invalid_event", "File events accept JSON metadata only.") }
		let envelope = this.#envelope(++this.seq, copy)
		let frame = this.#frame(type, envelope)
		if (Buffer.byteLength(frame) > this.limits.eventBytes) {
			// This sequence cannot be replayed. A retained reset explicitly marks the gap.
			type = "reset"
			envelope = this.#envelope(this.seq, { path: "", reason: "overflow" })
			frame = this.#frame(type, envelope)
		}
		const bytes = Buffer.byteLength(frame)
		const record = { type, envelope, bytes }
		if (bytes <= this.limits.eventBytes) {
			this.ring.push(record)
			this.ringBytes += bytes
		}
		while (this.ring.length > this.limits.eventCount || this.ringBytes > this.limits.eventBytes) this.ringBytes -= this.ring.shift().bytes
		this.#trimScopes()
		this.delivery.push(record)
		if (!this.dispatching) {
			this.dispatching = true
			try {
				while (this.delivery.length) {
					const next = this.delivery.shift()
					for (const client of this.subscribers) client.accept(next)
				}
			} finally { this.dispatching = false }
		}
		// No caller receives the retained mutable envelope.
		return structuredClone(envelope)
	}

	attach(req, res, url) {
		if (this.closed) throw new FileError(503, "storage_unavailable", "FileEvents is closed.")
		const scope = canonicalPath(url.searchParams.get("path") ?? "")
		const raw = req.headers?.["last-event-id"] ?? url.searchParams.get("lastEventId") ?? ""
		const cursor = typeof raw === "string" && raw.length <= 512 ? raw : "invalid"
		let closed = false
		let live = false
		let blocked = false
		let queue = []
		let queueBytes = 0
		let replayBytes = 0
		let heartbeat
		let stall
		const cleanup = () => {
			if (closed) return
			closed = true
			clearInterval(heartbeat)
			clearTimeout(stall)
			queue = []
			queueBytes = 0
			replayBytes = 0
			this.subscribers.delete(client)
			req.off?.("aborted", disconnect)
			res.off?.("close", cleanup)
			res.off?.("error", disconnect)
			res.off?.("drain", drain)
		}
		const disconnect = () => { cleanup(); res.destroy() }
		const overflow = () => {
			if (closed) return
			this.#markOverflow(scope)
			const frame = this.#frame("reset", this.#envelope(this.seq, { path: scope, reason: "overflow" }))
			const canSend = !blocked && (res.writableLength || 0) + Buffer.byteLength(frame) <= this.limits.subscriberBytes
			cleanup()
			if (canSend) {
				try { if (res.write(frame)) res.end(); else res.destroy() } catch { res.destroy() }
			} else res.destroy()
		}
		const write = (item) => {
			if (closed) return
			if (queueBytes + replayBytes + (res.writableLength || 0) + item.bytes > this.limits.subscriberBytes) return overflow()
			try {
				if (!res.write(item.frame)) {
					blocked = true
					stall = setTimeout(overflow, this.limits.heartbeatMs)
					stall.unref?.()
				}
				if (item.seq !== undefined) this.#remember(item.seq, scope)
			} catch { disconnect() }
		}
		const enqueue = (item) => {
			if (closed) return
			if (queueBytes + replayBytes + (res.writableLength || 0) + item.bytes > this.limits.subscriberBytes) return overflow()
			if (!live || blocked || queue.length) { queue.push(item); queueBytes += item.bytes }
			else write(item)
		}
		const drain = () => {
			clearTimeout(stall)
			blocked = false
			if (!live) return
			while (queue.length && !blocked && !closed) {
				const item = queue.shift()
				queueBytes -= item.bytes
				write(item)
			}
		}
		const itemFor = (record) => {
			const payload = scopedPayload(scope, record.envelope.payload)
			if (!payload) return null
			const frame = this.#frame(record.type, { ...record.envelope, payload })
			return { frame, bytes: Buffer.byteLength(frame), seq: record.envelope.seq }
		}
		const client = {
			accept: (record) => { const item = itemFor(record); if (item) enqueue(item) },
			close: () => { cleanup(); res.end() },
		}
		// Subscribe and capture replay before headers can trigger any user callbacks.
		this.subscribers.add(client)
		req.on("aborted", disconnect)
		res.on("close", cleanup)
		res.on("error", disconnect)
		res.on("drain", drain)
		const boundary = this.seq
		const replay = this.ring.filter((record) => record.envelope.seq <= boundary)
		const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.(0|[1-9][0-9]*)$/.exec(cursor)
		const after = match ? Number(match[3]) : null
		const knownScope = this.issuedScopes.get(after)
		const overflowed = Boolean(match && match[1] === this.identity.workspaceEpoch && match[2] === this.bootId && Number.isSafeInteger(after) && (after <= this.resetFloor || after <= (this.resetScopes.get(scope)?.seq ?? -1)))
		let reason = !cursor ? null : !match || !Number.isSafeInteger(after) ? "bad-cursor" : match[1] !== this.identity.workspaceEpoch ? "epoch" : match[2] !== this.bootId ? "restart" : overflowed || after > boundary || after < (replay[0]?.envelope.seq ?? boundary + 1) - 1 ? "gap" : !knownScope || knownScope.scope !== scope ? "gap" : null
		const uncertainty = cursor && !reason ? replay.find((record) => record.type === "reset" && record.envelope.seq > after && scopedPayload(scope, record.envelope.payload)) : null
		if (uncertainty) reason = "gap"
		const resumed = Boolean(cursor) && !reason
		try {
			res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" })
			if (closed) return true
			// Control events describe a replay watermark; they do not allocate journal sequences.
			const replayQueue = []
			const deliverReplay = (item) => {
				if (closed) return
				if (queueBytes + replayBytes + (res.writableLength || 0) + item.bytes > this.limits.subscriberBytes) return overflow()
				if (blocked) { replayQueue.push(item); replayBytes += item.bytes }
				else write(item)
			}
			const readySeq = resumed ? after : boundary
			const readyFrame = this.#frame("ready", this.#envelope(readySeq, { path: scope, resumed, reason }))
			deliverReplay({ frame: readyFrame, bytes: Buffer.byteLength(readyFrame), seq: readySeq })
			if (resumed) for (const record of replay) {
				if (closed) break
				if (record.envelope.seq <= after) continue
				const item = itemFor(record)
				if (item) deliverReplay(item)
			}
			else if (cursor && !closed) {
				const payload = { path: scope, reason: overflowed ? "overflow" : uncertainty?.envelope.payload.reason || (reason === "epoch" ? "epoch" : "gap") }
				const frame = this.#frame("reset", this.#envelope(boundary, payload))
				deliverReplay({ frame, bytes: Buffer.byteLength(frame), seq: boundary })
			}
			if (closed) return true
			queue = [...replayQueue, ...queue]
			queueBytes += replayBytes
			replayBytes = 0
			live = true
			if (!blocked) drain()
			if (!closed) {
				heartbeat = setInterval(() => {
					if (!blocked && !queue.length) enqueue({ frame: ": keepalive\n\n", bytes: 13 })
				}, this.limits.heartbeatMs)
				heartbeat.unref?.()
			}
		} catch (error) { disconnect(); throw error }
		return true
	}

	close() {
		if (this.closed) return
		this.closed = true
		for (const client of this.subscribers) client.close()
		this.ring = []
		this.ringBytes = 0
		this.issuedScopes.clear()
		this.scopeBytes = 0
		this.resetScopes.clear()
		this.resetBytes = 0
	}
}
