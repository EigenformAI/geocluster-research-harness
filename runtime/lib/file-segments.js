import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { FILE_LIMITS, FileError, budget, stableStringify } from "./file-contract.js"
import { SEGMENT_PARSER } from "./file-segments-worker.js"

export { SEGMENT_PARSER }
const workerError = (message) => new FileError(503, "worker_unavailable", `FileSegments: ${message}`, { agent: "file-service", tool: "file-segments", action: "Provision a root-controlled parser bridge under a different Unix UID." })
const timedOut = (probe) => probe ? workerError("The worker identity probe timed out.") : new FileError(408, "parser_time_budget", "The parser reached its elapsed work budget.", { tool: "file-segments", action: "Request a smaller window or a higher advertised work budget." })
const invalidCursor = () => new FileError(400, "invalid_cursor", "The cursor does not bind this source, parser, format, columns, or operation.", { tool: "file-segments", action: "Start a new window for the selected source and options." })

/** The trusted bridge accepts bounded bytes and returns {uid,result}; it must launch a separate process. */
export class FileSegments {
	constructor({ state, limits = {}, ownership = {} }) {
		this.state = state; this.limits = { ...FILE_LIMITS, ...limits }; this.ownership = ownership
		this.bridge = ownership.workerBridge
		this.availability = { state: "unavailable", reason: "worker-identity" }
		this.children = new Set(); this.controllers = new Set(); this.active = 0; this.closed = false
	}
	async init() {
		const prior = await this.state.get("settings", "segment-cursor-key")
		if (prior?.key) this.key = Buffer.from(prior.key, "hex")
		else {
			const claimed = await this.state.claim("settings", "segment-cursor-key", { parser: SEGMENT_PARSER }, { key: crypto.randomBytes(32).toString("hex") })
			this.key = Buffer.from(claimed.record.key, "hex")
		}
		const uid = this.bridge?.uid
		if (!Number.isSafeInteger(uid) || uid < 0 || uid === process.geteuid() || !this.ownership.workerUids?.includes(uid) || this.ownership.agentUids?.includes(uid)) return
		if (typeof this.bridge.run !== "function" && (typeof this.bridge.command !== "string" || !this.bridge.command.startsWith("/"))) return
		try { await this.run({ probe: true, bytes: Buffer.alloc(0), limits: { timeMs: this.limits.elapsedMs, responseBytes: this.limits.responseBytes } }); this.availability = { state: "available" } }
		catch (error) { this.startupError = error }
	}
	requireAvailable() { if (this.closed || this.availability.state !== "available") throw this.startupError || workerError("Parser identity is unknown or unavailable.") }
	normalize(request = {}) {
		if (!["csv", "tsv", "text"].includes(request.format)) throw new FileError(400, "invalid_format", "Choose csv, tsv, or text.")
		const operation = request.operation || "segment"
		if (!["segment", "header", "detail"].includes(operation) || (request.format === "text" && operation !== "segment")) throw new FileError(400, "invalid_operation", "This format does not support the requested segment operation.")
		const columnOffset = request.columnOffset === undefined ? 0 : Number(request.columnOffset)
		if (!Number.isSafeInteger(columnOffset) || columnOffset < 0 || columnOffset > 1000000) throw new FileError(400, "invalid_budget", "columnOffset must be an integer from 0 to 1000000.")
		const l = this.limits
		const limits = {
			rowLimit: budget(request.rowLimit, l.rowLimit, l.rowMaxLimit, "rowLimit"), columnOffset,
			columnLimit: budget(request.columnLimit, l.columnLimit, l.columnMaxLimit, "columnLimit"),
			readBytes: budget(request.readBytes, l.readBytes, l.readMaxBytes, "readBytes"),
			responseBytes: budget(request.responseBytes, l.responseBytes, l.responseMaxBytes, "responseBytes"),
			timeMs: budget(request.timeMs ?? request.elapsedMs, l.elapsedMs, l.elapsedMs, "timeMs"),
			textBytes: budget(request.textBytes, l.textWindowBytes, l.responseMaxBytes, "textBytes"), displayCodepoints: l.cellCodePoints,
		}
		return { format: request.format, operation, limits, cursor: request.cursor }
	}
	sourceKey(source) { return stableStringify([source.ref.workspaceId, source.ref.workspaceEpoch, source.kind, source.captureId || source.fragmentId, source.etag]) }
	options(input) { return { columnOffset: input.limits.columnOffset, columnLimit: input.limits.columnLimit } }
	sign(source, input, operation, position) {
		const value = Buffer.from(stableStringify({ v: 1, parser: SEGMENT_PARSER, source: this.sourceKey(source), format: input.format, options: this.options(input), operation, position })).toString("base64url")
		return `${value}.${crypto.createHmac("sha256", this.key).update(value).digest("base64url")}`
	}
	position(source, input) {
		if (!input.cursor) { if (input.operation === "detail") throw invalidCursor(); return { offset: 0, ordinal: 1 } }
		try {
			if (typeof input.cursor !== "string" || input.cursor.length > 8192) throw invalidCursor()
			const parts = input.cursor.split(".")
			if (parts.length !== 2) throw invalidCursor()
			const signature = Buffer.from(parts[1], "base64url"), expected = crypto.createHmac("sha256", this.key).update(parts[0]).digest()
			if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) throw invalidCursor()
			const value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"))
			if (value.v !== 1 || value.parser !== SEGMENT_PARSER || value.source !== this.sourceKey(source) || value.format !== input.format || value.operation !== input.operation || stableStringify(value.options) !== stableStringify(this.options(input))) throw invalidCursor()
			const p = value.position, size = source.kind === "runtime-fragment" ? source.byteEnd - source.byteStart : source.sizeBytes
			if (!Number.isSafeInteger(p.offset) || p.offset < 0 || p.offset > size || !Number.isSafeInteger(p.ordinal) || p.ordinal < 1) throw invalidCursor()
			if (input.operation === "detail" && (!Number.isSafeInteger(p.column) || p.column < 0 || !Number.isSafeInteger(p.valueOffset) || p.valueOffset < 0)) throw invalidCursor()
			return p
		} catch { throw invalidCursor() }
	}
	async run(input) {
		if (this.closed) throw workerError("The parser scheduler is closed.")
		if (this.active) throw new FileError(429, "capacity", "A bounded parser is already active.", { retryAfter: 1, tool: "file-segments", action: "Retry the window after the active parser finishes." })
		this.active++
		const timeoutMs = input.limits.timeMs
		const controller = new AbortController(); this.controllers.add(controller)
		const work = Promise.resolve().then(() => typeof this.bridge.run === "function" ? this.bridge.run(input, { signal: controller.signal }) : this.child(input, controller.signal))
		// A timed-out adapter still occupies the slot until it acknowledges abort/finishes.
		work.finally(() => { this.active--; this.controllers.delete(controller) }).catch(() => {})
		let timer
		try {
			const reply = await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(timedOut(input.probe)), timeoutMs) })])
			if (reply?.uid !== this.bridge.uid || reply.uid === process.geteuid()) { this.availability = { state: "unavailable", reason: "worker-identity" }; throw workerError("The parser did not prove the configured distinct UID.") }
			if (!input.probe && (!reply.result || Buffer.byteLength(JSON.stringify(reply.result)) > input.limits.responseBytes + 16384)) throw workerError("The parser returned invalid or over-budget output.")
			return reply.result
		} finally { clearTimeout(timer); controller.abort() }
	}
	child(input, signal) {
		return new Promise((resolve, reject) => {
			// The root-provisioned command receives node and the fixed parser module as trailing arguments.
			const child = spawn(this.bridge.command, [...(this.bridge.args || []), process.execPath, "--max-old-space-size=128", fileURLToPath(new URL("./file-segments-worker.js", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } })
			this.children.add(child)
			let output = "", errors = "", ready = false, reply, settled = false
			const timer = setTimeout(() => { child.kill("SIGKILL"); finish(timedOut(input.probe)) }, input.limits.timeMs)
			const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { child.kill("SIGKILL"); reject(error) } else resolve(reply) }
			const abort = () => finish(timedOut(input.probe))
			signal.addEventListener("abort", abort, { once: true })
			child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
			child.stdout.on("data", (data) => {
				output += data
				if (Buffer.byteLength(output) > input.limits.responseBytes + 32768) return finish(workerError("The parser exceeded its output budget."))
				let at
				while ((at = output.indexOf("\n")) >= 0) {
					const line = output.slice(0, at); output = output.slice(at + 1)
					try {
						const message = JSON.parse(line)
						if (!ready) {
							if (!message.ready || message.uid !== this.bridge.uid || message.uid === process.geteuid() || message.parser !== SEGMENT_PARSER) throw workerError("Worker identity handshake failed.")
							ready = true
							// Deliver input only after the process proves the configured distinct UID.
							const { bytes, ...header } = input
							child.stdin.write(`${JSON.stringify({ ...header, byteLength: bytes.length })}\n`)
							child.stdin.end(bytes)
						}
						else { if (reply) throw workerError("Unexpected parser output."); reply = message }
					} catch (error) { finish(error instanceof FileError ? error : workerError("Malformed parser output.")) }
				}
			})
			child.stderr.on("data", (data) => { errors = (errors + data).slice(0, 8192) })
			child.on("error", (error) => finish(workerError(error.message)))
			child.on("close", (code) => { this.children.delete(child); signal.removeEventListener("abort", abort); finish(code === 0 && ready && reply ? null : workerError(`Parser exited (${code}): ${errors || "no complete result"}`)) })
			child.stdin.on("error", (error) => finish(workerError(error.message)))
		})
	}
	async parse(source, bytes, input, position, sourceEof) {
		this.requireAvailable()
		const parsed = await this.bounded({ bytes, ...input, position, sourceEof })
		const size = source.kind === "runtime-fragment" ? source.byteEnd - source.byteStart : source.sizeBytes
		return this.envelope(source, { ...input, position, atFragmentEnd: source.kind === "runtime-fragment" && position.offset + bytes.length === size }, parsed)
	}
	stopped(input, position, bytesRead, reason = "time-budget") {
		const result = { kind: input.format === "text" ? "text-segment" : input.operation === "detail" ? "cell-detail" : "table-segment", nextPosition: null, consumedBytes: 0, eof: false, stopReason: reason, metrics: { bytesRead, recordsScanned: 0, recordsReturned: 0, responseBytes: 0, elapsedMs: input.limits.timeMs } }
		if (input.format === "text") result.excerpt = { text: "", byteStart: position.offset, byteEnd: position.offset, startsMidLine: Boolean(position.startsMidLine), lineContinues: false }
		else if (input.operation === "detail") Object.assign(result, { ordinal: position.ordinal, column: position.column, text: "", valueOffset: position.valueOffset, valueEnd: position.valueOffset })
		else Object.assign(result, { rows: [], observedColumns: 0 })
		return result
	}
	async bounded(input) {
		try { return await this.run(input) } catch (error) { if (error.error !== "parser_time_budget") throw error; return this.stopped(input, input.position, input.bytes.length) }
	}
	envelope(source, input, parsed) {
		const { nextPosition, consumedBytes, warning, ...data } = parsed
		const result = { ...data, filesContractVersion: 1, source, parser: SEGMENT_PARSER, format: input.format, operation: input.operation, limits: input.limits, next: nextPosition ? this.sign(source, input, input.operation, nextPosition) : null }
		if (result.rows) for (const row of result.rows) for (const cell of row.cells) if (cell.detailPosition) { cell.detail = this.sign(source, input, "detail", cell.detailPosition); delete cell.detailPosition }
		if (result.kind === "table-segment") { result.columnOffset = input.limits.columnOffset; result.columnLimit = input.limits.columnLimit; result.observedColumns ||= 0 }
		if (warning) result.warnings = [warning]
		const size = source.kind === "runtime-fragment" ? source.byteEnd - source.byteStart : source.sizeBytes
		if (source.kind === "runtime-fragment" && input.operation !== "detail" && (consumedBytes + (input.position?.offset || 0) >= size || (input.atFragmentEnd && result.stopReason === "read-budget")) && !source.sourceEof && !["encoding-unavailable", "malformed-record"].includes(result.stopReason)) {
			result.next = null; result.eof = false; result.stopReason = "fragment-end"; result.continuation = { kind: "capture-required" }
		} else if (!result.eof && !result.next && ["read-budget", "response-budget", "time-budget"].includes(result.stopReason)) result.continuation = { kind: "budget-increase-required" }
		this.responseSize(result)
		if (result.metrics.responseBytes > input.limits.responseBytes) throw new FileError(400, "invalid_budget", "responseBytes cannot fit this source envelope and window; request a larger response budget.", { limits: { responseBytes: input.limits.responseBytes } })
		return result
	}
	responseSize(result) {
		let size
		do { size = result.metrics.responseBytes; result.metrics.responseBytes = Buffer.byteLength(JSON.stringify(result)) } while (size !== result.metrics.responseBytes)
	}
	async close() { this.closed = true; for (const controller of this.controllers) controller.abort(); for (const child of this.children) child.kill("SIGKILL") }
}
