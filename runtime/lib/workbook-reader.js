import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { once } from "node:events"
import { StringDecoder } from "node:string_decoder"
import Database from "better-sqlite3"
import { FileError, budget } from "./file-contract.js"

export const WORKBOOK_PARSER = "sheetjs-ce/0.20.3+native-workbook/3"
export const WORKBOOK_LIMITS = Object.freeze({ inputBytes: 40 * 1048576, expandedBytes: 256 * 1048576, memberBytes: 256 * 1048576, outputBytes: 256 * 1048576, elapsedMs: 60000, cells: 2000000, zipEntries: 20000, manifestBytes: 1048576, rowBytes: 8 * 1048576 })
export const WORKBOOK_ENVELOPE = Object.freeze({ inputBytes: 128 * 1048576, expandedBytes: 512 * 1048576, memberBytes: 512 * 1048576, outputBytes: 512 * 1048576, elapsedMs: 60000, cells: 4000000, zipEntries: 65534, manifestBytes: 4 * 1048576, rowBytes: 32 * 1048576, heapMiB: 768, dataMiB: 1536, cpuSeconds: 60 })
// Qualification decodes fixed trusted fixtures independently of request budgets.
const WORKBOOK_PROBE_LIMITS = Object.freeze({ inputBytes: 64 * 1024, expandedBytes: 1048576, memberBytes: 1048576, outputBytes: 64 * 1024, elapsedMs: 60000, cells: 2, zipEntries: 64, manifestBytes: 64 * 1024, rowBytes: 64 * 1024 })
const error = (kind, message, status = 422) => new FileError(status, kind, `WorkbookReader: ${message}`, { agent: "file-service", tool: "workbook-reader", action: kind === "worker_unavailable" ? "Install the root-controlled workbook launcher and verify kernel confinement." : "Use an unencrypted valid workbook, a smaller input, or increase the advertised deployment budget within the physical envelope." })
const unavailable = message => error("worker_unavailable", message, 503)
const cancelled = () => error("job_cancelled", "Workbook preparation was cancelled.", 409)

function storedRangeEnd(value) {
	if (typeof value !== "string" || !/^[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?$/i.test(value)) throw unavailable("Worker stored range is invalid.")
	const coordinates = value.split(":").map(reference => {
		const [, letters, row] = /^([A-Z]+)([0-9]+)$/i.exec(reference); let column = 0
		for (const letter of letters.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64
		if (column > 16384 || Number(row) > 1048576) throw unavailable("Worker stored range exceeds Excel coordinates.")
		return { row: Number(row), column }
	})
	const start = coordinates[0], end = coordinates[1] || start
	if (end.row < start.row || end.column < start.column) throw unavailable("Worker stored range is reversed.")
	return end
}

/** Trusted parent writes the index; the decoding process receives only retained bytes over stdin. */
export class WorkbookReader {
	constructor(config = {}, logger) {
		this.config = config; this.logger = logger; this.parser = WORKBOOK_PARSER; this.limits = {}
		for (const [name, fallback] of Object.entries(WORKBOOK_LIMITS)) this.limits[name] = budget(config.limits?.[name], fallback, WORKBOOK_ENVELOPE[name], name)
		this.limits.memberBytes = Math.min(this.limits.memberBytes, this.limits.expandedBytes)
		this.launcherPath = config.launcherPath || "/opt/geocluster-runtime/workbook-launcher"
		this.testRunner = config.testRunner; if (this.testRunner && (this.testRunner.synthetic !== true || typeof this.testRunner.spawn !== "function")) throw unavailable("A test runner must explicitly declare synthetic:true and spawn a process.")
		this.availability = { state: "unavailable", reason: "not-initialized", parser: WORKBOOK_PARSER }; this.children = new Set(); this.operations = new Set(); this.active = false; this.closed = false
	}
	async init() {
		if (this.initializing) return this.initializing
		this.initializing = (async () => {
			try {
				if (!this.testRunner) {
					if (!path.isAbsolute(this.launcherPath)) throw unavailable("Launcher path must be absolute.")
					for (let current = this.launcherPath; current !== "/"; current = path.dirname(current)) {
						const stat = await fs.lstat(current)
						if (stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022 || current === this.launcherPath && (!stat.isFile() || !(stat.mode & 0o4000))) throw unavailable("Launcher and ancestors must be root-owned, non-writable, and the launcher setuid-root.")
					}
				}
				const result = await this.run({ probe: true, byteLength: 0, limits: WORKBOOK_PROBE_LIMITS }, null, null)
				if (this.closed) throw unavailable("Workbook reader closed during initialization.")
				if (result.probe?.decoded?.join(",") !== "xls,xlsx" || !this.testRunner && (!result.probe.filesystemDenied || !result.probe.socketDenied || !result.probe.executionDenied || !result.probe.signalDenied)) throw unavailable("Readiness probes did not verify confinement and both workbook formats.")
				this.availability = { state: "available", parser: WORKBOOK_PARSER, confinement: this.testRunner ? "synthetic-test-only" : "verified", probe: result.probe }
			} catch (cause) { this.startupError = cause instanceof FileError ? cause : unavailable(`Startup failed (${cause.code || "probe"}).`); this.availability = { state: "unavailable", parser: WORKBOOK_PARSER, reason: "confinement-probe", diagnostic: this.startupError.message } }
		})()
		return this.initializing
	}
	parse(request) {
		const work = this.parseRetained(request); this.operations.add(work)
		work.finally(() => this.operations.delete(work)).catch(() => {})
		return work
	}
	async parseRetained({ handle, source, outputPath, signal }) {
		if (this.closed || this.availability.state !== "available") throw this.startupError || unavailable("Workbook decoding is not ready.")
		if (this.active) throw error("capacity", "Another workbook preparation is active.", 429)
		if (signal?.aborted) throw cancelled()
		if (!path.isAbsolute(outputPath || "") || typeof handle?.read !== "function") throw error("invalid_source", "Supply a retained handle and an absolute private staging path.", 400)
		this.active = true; let db, created = false
		this.controller = new AbortController(); signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
		const start = performance.now()
		try {
			const before = await handle.stat({ bigint: true }), length = Number(before.size)
			if (signal.aborted || this.closed) throw cancelled()
			if (!before.isFile() || !Number.isSafeInteger(length) || length !== source?.sizeBytes) throw error("source_integrity", "Retained input length differs from the capture.", 409)
			if (length > this.limits.inputBytes) throw error("workbook_budget", "Input bytes exceed the configured workbook limit.", 413)
			const expectedHash = source.digest?.state === "ready" ? source.digest.sha256 : null
			if (expectedHash && !/^[0-9a-f]{64}$/.test(expectedHash)) throw error("source_integrity", "Retained input digest is invalid.", 409)
			const stage = await fs.open(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); created = true; await stage.close()
			db = new Database(outputPath)
			db.pragma("journal_mode = MEMORY"); db.pragma("synchronous = FULL"); db.pragma("temp_store = MEMORY"); db.pragma("page_size = 4096"); db.pragma("cache_size = -8192"); db.pragma(`max_page_count = ${Math.max(1, Math.floor(this.limits.outputBytes / 4096))}`)
			db.exec("CREATE TABLE rows(sheet TEXT NOT NULL,row INTEGER NOT NULL,cells TEXT NOT NULL,PRIMARY KEY(sheet,row)) WITHOUT ROWID; BEGIN")
			const insert = db.prepare("INSERT INTO rows VALUES(?,?,?)"), indexedBySheet = new Map(); let cellsSeen = 0, rowsSeen = 0, previousSheet = -1, previousRow = -1
			const consume = message => {
				const row = message.row, ordinal = /^sheet-(0|[1-9][0-9]*)$/.test(row?.sheet) ? Number(row.sheet.slice(6)) : -1
				if (!row || ordinal < previousSheet || ordinal < 0 || !Number.isSafeInteger(row.row) || row.row < 0 || row.row >= 1048576 || ordinal === previousSheet && row.row <= previousRow || !row.cells || Array.isArray(row.cells) || typeof row.cells !== "object") throw unavailable("Worker row coordinates or order are invalid.")
				previousSheet = ordinal; previousRow = row.row
				const entries = Object.entries(row.cells)
				if (!entries.length) throw unavailable("Worker emitted an empty indexed row.")
				const evidence = indexedBySheet.get(row.sheet) || { indexedRows: 0, populatedCells: 0, maxRow: -1, maxColumn: -1 }
				for (const [column, cell] of entries) {
					if (!/^(0|[1-9][0-9]*)$/.test(column) || Number(column) >= 16384 || !cell || !["n", "s", "b", "e", "d", "z"].includes(cell.type) || !["string", "number", "boolean"].includes(typeof cell.raw) && cell.raw !== null || typeof cell.raw === "number" && !Number.isFinite(cell.raw) || typeof cell.display !== "string" || cell.display.length > 32767 || typeof cell.raw === "string" && cell.raw.length > 32767 || !["present", "missing", "unknown", "not-formula"].includes(cell.cache) || cell.format !== null && typeof cell.format !== "string" || cell.formula !== null && (typeof cell.formula !== "string" || cell.formula.length > 32767) || cell.cache === "missing" && (cell.raw !== null || cell.display !== "")) throw unavailable("Worker returned an invalid typed cell.")
					if (++cellsSeen > this.limits.cells) throw error("workbook_budget", "Cell count exceeds the configured limit.")
					if (cell.raw !== null || cell.formula !== null) evidence.populatedCells++
					evidence.maxColumn = Math.max(evidence.maxColumn, Number(column))
				}
				insert.run(row.sheet, row.row, JSON.stringify(row.cells))
				evidence.indexedRows++; evidence.maxRow = row.row; rowsSeen++; indexedBySheet.set(row.sheet, evidence)
			}
			const result = await this.run({ byteLength: length, inputSha256: expectedHash, limits: this.limits }, handle, consume, signal)
			if (signal.aborted || this.closed) throw cancelled()
			const after = await handle.stat({ bigint: true })
			if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => before[key] !== after[key]) || expectedHash && result.inputSha256 !== expectedHash) throw error("source_integrity", "Retained input changed during workbook preparation.", 409)
			const manifest = result.manifest
			if (manifest?.schemaVersion !== 1 || manifest.parser !== WORKBOOK_PARSER || manifest.origin !== "fresh" || !["1900", "1904"].includes(manifest.dateSystem) || !Array.isArray(manifest.sheets) || manifest.inputSha256 !== result.inputSha256 || manifest.decodedCells !== cellsSeen) throw unavailable("Worker manifest does not bind the validated rows and retained bytes.")
			let indexedTotal = 0
			for (const [i, sheet] of manifest.sheets.entries()) {
				if (sheet.id !== `sheet-${i}` || typeof sheet.name !== "string" || !["visible", "hidden", "very-hidden"].includes(sheet.visibility) || !["worksheet", "unsupported"].includes(sheet.kind) || !Number.isSafeInteger(sheet.rows) || sheet.rows < 0 || sheet.rows > 1048576 || !Number.isSafeInteger(sheet.columns) || sheet.columns < 0 || sheet.columns > 16384 || !Number.isSafeInteger(sheet.indexedRows) || sheet.indexedRows < 0 || sheet.indexedRows > sheet.rows || !Number.isSafeInteger(sheet.populatedCells) || sheet.populatedCells < 0) throw unavailable("Worker sheet inventory is invalid.")
				const evidence = indexedBySheet.get(sheet.id)
				if (sheet.indexedRows !== (evidence?.indexedRows || 0) || sheet.populatedCells !== (evidence?.populatedCells || 0) || evidence && (evidence.maxRow >= sheet.rows || evidence.maxColumn >= sheet.columns) || sheet.kind === "unsupported" && (sheet.indexedRows !== 0 || sheet.storedRange !== null)) throw unavailable("Worker sheet counts or coordinates do not match indexed source rows.")
				if (sheet.storedRange !== null) { const end = storedRangeEnd(sheet.storedRange); if (end.row > sheet.rows || end.column > sheet.columns) throw unavailable("Worker coordinate bounds exclude its stored range.") }
				indexedTotal += sheet.indexedRows
			}
			if (indexedTotal !== rowsSeen) throw unavailable("Worker indexed-row total does not bind the complete sheet inventory.")
			db.exec("COMMIT"); db.close(); db = null
			const file = await fs.open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW); try { await file.sync() } finally { await file.close() }
			const outputBytes = (await fs.stat(outputPath)).size
			if (outputBytes > this.limits.outputBytes) throw error("workbook_budget", "SQLite index exceeds the configured limit.")
			await fs.chmod(outputPath, 0o400)
			if (signal.aborted || this.closed) throw cancelled()
			manifest.metrics = { durationMs: performance.now() - start, peakRssKiB: manifest.metrics.peakRssKiB, inputBytes: length, outputBytes }
			return manifest
		} catch (cause) {
			if (db) { try { db.close() } catch {} }
			if (created) await fs.rm(outputPath, { force: true })
			if (cause.code === "SQLITE_FULL") throw error("workbook_budget", "SQLite index exceeds the configured limit.")
			throw cause
		} finally { this.active = false; this.controller = null }
	}
	run(header, handle, consume, signal) {
		return new Promise((resolve, reject) => {
			const limits = header.limits
			let child
			try { child = this.testRunner ? this.testRunner.spawn() : spawn(this.launcherPath, [], { stdio: ["pipe", "pipe", "pipe"], env: {} }) } catch (cause) { reject(unavailable(`Could not spawn launcher (${cause.code || "spawn"}).`)); return }
			this.children.add(child)
			const stopped = new Promise(resolve => child.once("close", resolve))
			let ready = false, terminal = null, failure = null, pending = "", bytesOut = 0, errors = "", inputHash, feeding
			const decoder = new StringDecoder("utf8"), fail = cause => { failure ||= cause; child.kill("SIGTERM") }
			const timer = setTimeout(() => fail(error("workbook_time_budget", "Workbook preparation reached its elapsed limit.", 408)), limits.elapsedMs)
			const abort = () => fail(cancelled()); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort()
			const feed = async () => {
				const hash = crypto.createHash("sha256"); child.stdin.write(`${JSON.stringify(header)}\n`)
				if (handle) {
					const buffer = Buffer.alloc(64 * 1024); let position = 0
					while (position < header.byteLength) {
						if (failure) return
						const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, header.byteLength - position), position)
						if (!bytesRead) throw error("source_integrity", "Retained bytes ended before the exact capture length.", 409)
						const chunk = Buffer.from(buffer.subarray(0, bytesRead)); hash.update(chunk); position += bytesRead
						if (!child.stdin.write(chunk)) await Promise.race([once(child.stdin, "drain"), stopped.then(() => { throw unavailable("Worker exited during retained-byte delivery.") })])
					}
					const extra = Buffer.alloc(1), { bytesRead } = await handle.read(extra, 0, 1, header.byteLength); if (bytesRead) throw error("source_integrity", "Retained input exceeds the exact capture length.", 409)
				}
				inputHash = hash.digest("hex"); if (header.inputSha256 && inputHash !== header.inputSha256) throw error("source_integrity", "Retained input hash differs from the capture digest.", 409)
				child.stdin.end()
			}
			child.stdout.on("data", data => {
				if (failure) return
				bytesOut += data.length; if (bytesOut > limits.outputBytes + limits.manifestBytes + 16384) return fail(error("workbook_budget", "Worker output exceeds the configured limit."))
				pending += decoder.write(data); let newline
				try {
					while ((newline = pending.indexOf("\n")) >= 0) {
						const line = pending.slice(0, newline); pending = pending.slice(newline + 1); if (Buffer.byteLength(line) > Math.max(limits.rowBytes, limits.manifestBytes)) throw error("workbook_budget", "Worker JSONL record exceeds its limit.")
						const message = JSON.parse(line)
						if (!ready) {
							if (!message.ready || message.parser !== WORKBOOK_PARSER || !Number.isSafeInteger(message.pid) || message.pid <= 0 || !this.testRunner && (message.uid !== 997 || message.confinement !== "installed")) throw unavailable("Worker identity handshake failed.")
							ready = true; child.workerPid = message.pid; feeding = feed().catch(fail)
						} else if (message.error) throw error(message.error.reason === "source_integrity" ? "source_integrity" : message.error.reason === "unavailable" ? "worker_unavailable" : `workbook_${message.error.reason}`, message.error.message, ["unavailable", "resource_limit"].includes(message.error.reason) ? 503 : 422)
						else if (terminal) throw unavailable("Worker emitted data after its terminal result.")
						else if (message.row && consume && !header.probe) consume(message)
						else if (message.manifest && !header.probe || message.probe && header.probe) terminal = message
						else throw unavailable("Worker emitted an unexpected protocol message.")
					}
					if (Buffer.byteLength(pending) > Math.max(limits.rowBytes, limits.manifestBytes)) throw error("workbook_budget", "Worker JSONL record exceeds its limit.")
				} catch (cause) { fail(cause instanceof FileError || cause.code?.startsWith("SQLITE_") ? cause : unavailable("Worker emitted malformed JSONL.")) }
			})
			child.stderr.on("data", data => { errors = (errors + data.toString()).slice(0, 8192) })
			child.stdin.on("error", cause => fail(unavailable(`Worker input pipe failed (${cause.code}).`)))
			child.on("error", cause => { failure ||= unavailable(`Launcher failed (${cause.code || "spawn"}).`) })
			// close waits for process exit AND all IPC endpoints; never release the lane on kill alone.
			child.once("close", async (code, nativeSignal) => {
				clearTimeout(timer); signal?.removeEventListener("abort", abort); this.children.delete(child); await feeding
				if (failure) return reject(failure)
				if (code !== 0 || nativeSignal) return reject(error([137, 152, 134].includes(code) || nativeSignal ? "workbook_resource_limit" : "worker_unavailable", `Native reader exited (${nativeSignal || code}). ${errors || "Inspect the installed launcher and physical resource envelope."}`, 503))
				if (!ready || !terminal || pending || decoder.end()) return reject(unavailable("Worker exited without one complete terminal result."))
				resolve({ ...terminal, inputSha256: inputHash })
			})
		})
	}
	async close() {
		this.closed = true
		this.availability = { state: "unavailable", parser: WORKBOOK_PARSER, reason: "closed" }
		this.controller?.abort()
		await Promise.all([...this.children].map(child => { const stopped = once(child, "close"); child.kill("SIGTERM"); return stopped }))
		await Promise.allSettled([...this.operations])
	}
}
