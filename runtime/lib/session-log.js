/**
 * Durable per-session event log.
 *
 * Every ACP update, prompt, permission request/response and turn end is appended as one
 * NDJSON line `{seq, ts, kind, ...}` under <stateDir>/sessions/<sessionId>/events.ndjson.
 * Replay streams the file; memory holds only the last few events (ring) and the counters.
 * That is what lets a reloaded browser catch up on a two-hour task without the gateway ever
 * holding the transcript.
 *
 * The files are the source of truth for the sequence:
 *   - meta.json is rewritten only on synced appends, so after a crash it can lag the file: open()
 *     takes the higher of the two, because a reused seq makes a client's dedup drop a new event;
 *   - a crash mid-write leaves a torn last line: open() cuts the bytes after the last "\n" (never
 *     a complete line), so the next append starts a clean line;
 *   - replay works on a snapshot taken inside the write queue (the last written seq + open file
 *     handles), so a conversation with no events yet replays nothing instead of failing on a
 *     missing file (API-24), and a rotation during a replay can't lose the rotated file.
 */
import fs from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const RING = 256
/** Big events (base64 images in a user message) must not pin megabytes in every open log. */
const RING_BYTES = 8 * 1024 * 1024
const TAIL_CHUNK = 64 * 1024
/** `append` writes these keys first, in this order, so a line's seq can be read without parsing it. */
const LINE_PREFIX = /^\{"seq":(\d+),"ts":\d+,"kind":"/
export const ROTATE_BYTES = 64 * 1024 * 1024

/** Position of the last `byte` before `before` (exclusive), or -1; reads backwards in chunks. */
async function lastIndexOfByte(handle, before, byte) {
	const buf = Buffer.alloc(TAIL_CHUNK)
	let end = before
	while (end > 0) {
		const start = Math.max(0, end - TAIL_CHUNK)
		const { bytesRead } = await handle.read(buf, 0, end - start, start)
		const at = buf.subarray(0, bytesRead).lastIndexOf(byte)
		if (at >= 0) return start + at
		end = start
	}
	return -1
}

async function seqAt(handle, start, end) {
	const head = Buffer.alloc(Math.max(0, Math.min(128, end - start)))
	if (!head.length) return null
	await handle.read(head, 0, head.length, start)
	const match = LINE_PREFIX.exec(head.toString("utf8"))
	return match ? Number(match[1]) : null
}

/**
 * Size and last seq of a log file. With `repair`, bytes after the last "\n" (a torn or
 * zero-filled tail) are truncated away. A last line that doesn't parse is skipped (a few lines
 * back at most). Missing file → {size: 0, seq: 0, first: null}.
 */
async function inspectFile(file, { repair = false } = {}) {
	let handle
	try {
		handle = await fs.open(file, repair ? "r+" : "r")
	} catch (error) {
		if (error.code === "ENOENT") return { size: 0, seq: 0, first: null }
		throw error
	}
	try {
		let size = (await handle.stat()).size
		const lastNewline = await lastIndexOfByte(handle, size, 0x0a)
		if (lastNewline + 1 < size) {
			if (repair) await handle.truncate(lastNewline + 1)
			size = lastNewline + 1
		}
		let seq = 0
		let end = size - 1 // the "\n" ending the line being looked at
		for (let tries = 0; end > 0 && tries < 16 && !seq; tries++) {
			const previous = await lastIndexOfByte(handle, end, 0x0a)
			seq = (await seqAt(handle, previous + 1, end)) ?? 0
			end = previous
		}
		const firstNewline = size ? await firstIndexOfNewline(handle, size) : -1
		const first = size ? await seqAt(handle, 0, firstNewline < 0 ? size : firstNewline) : null
		return { size, seq, first }
	} finally {
		await handle.close()
	}
}

async function firstIndexOfNewline(handle, size) {
	const buf = Buffer.alloc(Math.min(TAIL_CHUNK, size))
	const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
	return buf.subarray(0, bytesRead).indexOf(0x0a)
}

export class SessionLog {
	/**
	 * @param {string} dir directory of this session's files
	 * @param {{lastSeq?: number, truncated?: boolean, firstSeq?: number}} [meta] loaded meta.json
	 * @param {{rotateBytes?: number, onError?: (error: Error) => void}} [options]
	 */
	constructor(dir, meta = {}, { rotateBytes = ROTATE_BYTES, onError = null } = {}) {
		this.dir = dir
		this.file = path.join(dir, "events.ndjson")
		this.oldFile = path.join(dir, "events.1.ndjson")
		this.metaFile = path.join(dir, "meta.json")
		this.lastSeq = meta.lastSeq ?? 0 // last seq handed out
		this.writtenSeq = this.lastSeq // last seq on disk (≤ lastSeq while writes are queued)
		this.firstSeq = meta.firstSeq ?? 1 // oldest seq still kept on disk (lastSeq + 1 when none)
		this.truncated = meta.truncated ?? false // events were ever dropped by rotation
		this.meta = { createdAt: Date.now(), ...meta }
		this.ring = [] // [{event, bytes}], newest last
		this.ringBytes = 0
		this.bytes = 0
		this.rotateBytes = rotateBytes
		this.onError = onError
		this.pending = 0
		this.closed = false // evicted by the broker: appends would race the instance that reopens the file
		this.queue = Promise.resolve()
	}

	static async open(stateDir, sessionId, extraMeta = {}, options = {}) {
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) throw new Error(`bad session id: ${sessionId}`)
		const dir = path.join(stateDir, "sessions", sessionId)
		await fs.mkdir(dir, { recursive: true, mode: 0o700 })
		let meta = {}
		try {
			meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"))
		} catch {
			meta = {}
		}
		const log = new SessionLog(dir, { ...meta, ...extraMeta, sessionId }, options)
		const recovered = await log.#recover()
		if (recovered || Object.keys(extraMeta).length > 0 || !meta.createdAt) await log.writeMeta()
		return log
	}

	static async exists(stateDir, sessionId) {
		try {
			await fs.stat(path.join(stateDir, "sessions", sessionId, "events.ndjson"))
			return true
		} catch {
			return false
		}
	}

	/** Bring the counters in line with the files; true when meta.json was behind. */
	async #recover() {
		const current = await inspectFile(this.file, { repair: true })
		const old = await inspectFile(this.oldFile)
		this.bytes = current.size
		const onDisk = current.seq || old.seq
		const first = old.first ?? current.first
		const behind = onDisk > this.lastSeq
		this.lastSeq = Math.max(this.lastSeq, onDisk)
		this.writtenSeq = this.lastSeq
		this.firstSeq = first ?? this.lastSeq + 1
		this.meta.lastSeq = this.lastSeq
		this.meta.firstSeq = this.firstSeq
		return behind
	}

	/** Anything still queued for disk (the broker never evicts a busy log). */
	get busy() {
		return this.pending > 0
	}

	#remember(event, bytes) {
		this.ring.push({ event, bytes })
		this.ringBytes += bytes
		while (this.ring.length > RING || (this.ringBytes > RING_BYTES && this.ring.length > 1)) {
			this.ringBytes -= this.ring.shift().bytes
		}
	}

	#forget(event) {
		const at = this.ring.findIndex((entry) => entry.event === event)
		if (at >= 0) this.ringBytes -= this.ring.splice(at, 1)[0].bytes
	}

	/** Run `task` after every queued write; a failed task never blocks the ones after it. */
	#enqueue(task) {
		this.pending++
		const op = this.queue.then(task).finally(() => this.pending--)
		this.queue = op.catch((error) => this.onError?.(error))
		return op
	}

	/** Append one event; resolves with its seq once written. `sync` forces fsync (permissions, turn ends). */
	append(kind, data = {}, { sync = false } = {}) {
		if (this.closed) return Promise.reject(new Error(`session log ${this.meta.sessionId} was closed`))
		const seq = ++this.lastSeq
		const event = { seq, ts: Date.now(), kind, ...data }
		const line = `${JSON.stringify(event)}\n`
		const bytes = Buffer.byteLength(line)
		this.#remember(event, bytes)
		return this.#enqueue(async () => {
			try {
				if (this.bytes > 0 && this.bytes + bytes > this.rotateBytes) await this.#rotate()
				const handle = await fs.open(this.file, "a", 0o600)
				try {
					await handle.writeFile(line)
					if (sync) await handle.sync()
				} finally {
					await handle.close()
				}
			} catch (error) {
				// Never on disk, so never replayed: don't serve it from the ring either
				this.#forget(event)
				throw error
			}
			this.bytes += bytes
			this.writtenSeq = seq
			this.meta.lastSeq = this.lastSeq
			this.meta.updatedAt = event.ts
			if (sync) await this.#writeMetaNow()
			return seq
		})
	}

	async #rotate() {
		let dropped = false
		try {
			await fs.stat(this.oldFile)
			dropped = true // the previous rotation's file is about to be overwritten
		} catch {
			dropped = false
		}
		await fs.rename(this.file, this.oldFile).catch(() => {})
		this.bytes = 0
		this.firstSeq = (await inspectFile(this.oldFile)).first ?? this.writtenSeq + 1
		if (dropped) this.truncated = true
		this.meta.truncated = this.truncated
		this.meta.firstSeq = this.firstSeq
		await this.#writeMetaNow()
	}

	/** Persist meta.json (atomically, fsynced) after every queued write. */
	writeMeta() {
		return this.#enqueue(() => this.#writeMetaNow())
	}

	async #writeMetaNow() {
		const tmp = `${this.metaFile}.tmp`
		const body = JSON.stringify({ ...this.meta, lastSeq: this.lastSeq, firstSeq: this.firstSeq, truncated: this.truncated })
		const handle = await fs.open(tmp, "w", 0o600)
		try {
			await handle.writeFile(body)
			await handle.sync()
		} finally {
			await handle.close()
		}
		await fs.rename(tmp, this.metaFile)
	}

	/** Wait for every queued write to reach disk. */
	flush() {
		return this.queue
	}

	/**
	 * Replay the events with afterSeq < seq ≤ until, oldest first, where `until` is the last event
	 * written when the replay starts; later events reach the caller live. Serves from the ring when
	 * it covers the range, otherwise streams the files (the rotated one first).
	 * @param {number} afterSeq
	 * @param {(event: object) => Promise<void> | void} onEvent
	 * @returns {Promise<{until: number, firstSeq: number, truncated: boolean}>} `truncated`: events
	 *   after afterSeq were dropped by rotation and are missing from this replay
	 */
	async replay(afterSeq, onEvent) {
		const snap = await this.#enqueue(() => this.#snapshot())
		const result = { until: snap.until, firstSeq: snap.firstSeq, truncated: afterSeq + 1 < snap.firstSeq && afterSeq < snap.until }
		try {
			if (afterSeq >= snap.until) return result
			const first = snap.ring[0]?.seq
			if (first !== undefined && first <= afterSeq + 1) {
				for (const event of snap.ring) if (event.seq > afterSeq) await onEvent(event)
				return result
			}
			for (const handle of snap.handles) await this.#streamHandle(handle, afterSeq, snap.until, onEvent)
			return result
		} finally {
			for (const handle of snap.handles) await handle.close().catch(() => {})
		}
	}

	async #snapshot() {
		const handles = []
		for (const file of [this.oldFile, this.file]) {
			try {
				handles.push(await fs.open(file, "r"))
			} catch (error) {
				if (error.code !== "ENOENT") {
					for (const handle of handles) await handle.close().catch(() => {})
					throw error
				}
			}
		}
		const until = this.writtenSeq
		const firstSeq = this.firstSeq
		return {
			until,
			firstSeq,
			// the ring mirrors the files: nothing rotation dropped, nothing not yet written
			ring: this.ring.map((entry) => entry.event).filter((event) => event.seq >= firstSeq && event.seq <= until),
			handles,
		}
	}

	async #streamHandle(handle, afterSeq, until, onEvent) {
		const stream = handle.createReadStream({ encoding: "utf8", start: 0, autoClose: false })
		const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
		try {
			for await (const line of lines) {
				if (!line) continue
				const prefix = LINE_PREFIX.exec(line.slice(0, 64))
				if (prefix) {
					const seq = Number(prefix[1])
					if (seq <= afterSeq) continue
					if (seq > until) break
				}
				let event
				try {
					event = JSON.parse(line)
				} catch {
					continue
				}
				if (event.seq > afterSeq && event.seq <= until) await onEvent(event)
			}
		} finally {
			lines.close()
			stream.destroy()
		}
	}
}
