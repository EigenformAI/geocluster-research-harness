import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { FILE_LIMITS, FileError, capturedSourceIdentity, fileError, identifier, stableStringify } from "./file-contract.js"

const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"])
const now = () => new Date().toISOString()
const put = (kind, id, value) => ({ type: "put", kind, id, value })
const failure = (status, error, message, details = {}) => new FileError(status, error, message, { agent: "file-service", tool: "file-workbooks", action: "Choose a smaller workbook scope or inspect workbook provider readiness and deployment limits.", ...details })
const report = (error) => { const e = fileError(error, "file-workbooks"); return { status: e.status, ...e.toJSON() } }
const fromReport = (error) => failure(error.status, error.error, error.message, error)
const strict = (value, keys, name) => { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw failure(400, "invalid_request", `${name} contains unsupported fields.`) }
const integer = (value, fallback, max, name, min = 0) => { const n = value === undefined ? fallback : value; if (!Number.isSafeInteger(n) || n < min || n > max) throw failure(400, "invalid_budget", `${name} must be an integer from ${min} to ${max}.`); return n }
const sameSource = (a, b) => stableStringify(capturedSourceIdentity(a)) === stableStringify(capturedSourceIdentity(b))
const readySha = (source) => source?.digest?.state === "ready" ? source.digest.sha256 : null
const checkDigest = (source, sha256) => {
	const claimed = readySha(source)
	if (source.digest?.state === "ready" && (!/^[0-9a-f]{64}$/.test(claimed || "") || sha256 && claimed !== sha256)) throw failure(409, "source_changed", "The supplied ready SHA-256 contradicts verified captured-byte evidence.")
}
const readerLimitKeys = { inputBytes: "workbookInputBytes", expandedBytes: "workbookExpandedBytes", memberBytes: "workbookMemberBytes", outputBytes: "workbookIndexBytes", elapsedMs: "workbookPrepareMs", cells: "workbookCells", zipEntries: "workbookZipEntries", manifestBytes: "workbookManifestBytes", rowBytes: "workbookRowBytes" }

/** Preparation receipts and derived indexes share FileCaptures' protected publication and retention. */
export class FileWorkbooks {
	#permits = new WeakMap()
	#acceptedControllers = new WeakSet()
	constructor(workspace) {
		this.workspace = workspace; this.config = workspace.config; this.captures = workspace.captures; this.state = workspace.state
		this.limits = { ...FILE_LIMITS, ...workspace.limits }; this.tasks = new Map(); this.pending = new Set(); this.controllers = new Set(); this.admissionTail = Promise.resolve()
		this.availability = { state: "unavailable", reason: "reader-unavailable" }; this.build = "unavailable"
	}
	async init() {
		if (this.captures.availability.state !== "available") { this.availability = this.captures.availability; return }
		await this.recover()
		if (this.config.filesWorkbookWorkerEnabled === false && !this.config.filesWorkbookReader) { this.availability = { state: "unavailable", reason: "disabled" }; return }
		try {
			if (!this.config.filesWorkbookReader) await this.trustedQueryWorker()
			const readerConfig = { launcherPath: this.config.filesWorkbookWorkerBin, limits: Object.fromEntries(Object.entries(readerLimitKeys).map(([name, key]) => [name, this.limits[key]])) }
			let nativeModule
			if (this.config.filesWorkbookReader) this.reader = typeof this.config.filesWorkbookReader === "function" ? await this.config.filesWorkbookReader(readerConfig, this.workspace.logger) : this.config.filesWorkbookReader
			else {
				nativeModule = await import("./workbook-reader.js")
				this.reader = new nativeModule.WorkbookReader(readerConfig, this.workspace.logger)
			}
			await this.reader.init()
			this.availability = { ...this.reader.availability }
			this.build = this.reader.availability.build || this.reader.build || this.reader.parser || "workbook-reader-v1"
			// Publish the reader's actual gates; the facade additionally bounds input, index,
			// manifest and elapsed work, so those effective budgets are the smaller ceiling.
			for (const [readerKey, key] of Object.entries({ ...readerLimitKeys, indexBytes: "workbookIndexBytes", timeMs: "workbookPrepareMs" })) if (Number.isSafeInteger(this.reader.limits?.[readerKey]) && this.reader.limits[readerKey] > 0) this.limits[key] = ["workbookInputBytes", "workbookIndexBytes", "workbookPrepareMs", "workbookManifestBytes"].includes(key) ? Math.min(this.limits[key], this.reader.limits[readerKey]) : this.reader.limits[readerKey]
			if (this.availability.confinement === "verified") {
				nativeModule ||= await import("./workbook-reader.js")
				if (this.reader instanceof nativeModule.WorkbookReader) { const { heapMiB, dataMiB, cpuSeconds } = nativeModule.WORKBOOK_ENVELOPE; this.readerEnvelope = { heapMiB, dataMiB, cpuSeconds } }
			}
		} catch (error) { this.availability = { state: "unavailable", reason: error.code === "ERR_MODULE_NOT_FOUND" ? "reader-unavailable" : "reader-startup" }; this.startupError = report(error) }
	}
	async trustedQueryWorker() {
		const require = createRequire(import.meta.url), sqlite = require.resolve("better-sqlite3")
		for (const filename of [fileURLToPath(new URL("./file-workbooks-worker.js", import.meta.url)), process.execPath, sqlite, path.resolve(path.dirname(sqlite), "../build/Release/better_sqlite3.node")]) {
			const file = await fs.lstat(filename)
			if (!file.isFile() || file.uid !== 0 || file.mode & 0o022) throw failure(503, "workbook_worker_unavailable", "Workbook query code must be root-owned and non-writable.")
			for (let parent = path.dirname(filename); ; parent = path.dirname(parent)) { const directory = await fs.lstat(parent); if (!directory.isDirectory() || directory.uid !== 0 || directory.mode & 0o022) throw failure(503, "workbook_worker_unavailable", "Workbook query code ancestors must be root-owned and non-writable."); if (parent === "/") break }
		}
	}
	descriptor() { return { id: "workbook", build: this.build, readiness: this.availability, inputFormats: ["xls", "xlsx"], queryOperations: ["prepare", "query", "export"], queryScope: "full-sheet-or-range", limits: this.publicLimits() } }
	publicLimits() { return { ...Object.fromEntries(Object.entries(this.limits).filter(([key]) => key.startsWith("workbook")).map(([key, value]) => [key[8].toLowerCase() + key.slice(9), value])), ...(this.readerEnvelope ? { readerEnvelope: this.readerEnvelope } : {}) } }
	track(work) { this.pending.add(work); work.finally(() => this.pending.delete(work)).catch(() => {}); return work }
	async recover() {
		for (let job of await this.state.list("jobs")) {
			if (job.type !== "preparation" || job.preparationType !== "workbook") continue
			if (!terminal.has(job.state)) { job = { ...job, state: "interrupted", stage: "interrupted", finishedAt: now(), error: report(failure(503, "job_interrupted", "Workbook preparation stopped before settlement. Submit a new request ID to retry.")), result: null }; await this.state.put("jobs", job.jobId, job) }
			for (const requestId of job.requestIds || [job.requestId]) { const request = await this.state.get("requests", requestId); if (request && !terminal.has(request.state)) await this.state.put("requests", requestId, { ...request, state: job.state, result: job.result, error: job.error, finishedAt: job.finishedAt }) }
			if (job.holdId) await this.captures.releaseHold(job.holdId)
		}
		for (const request of await this.state.list("requests")) if (request.type === "preparation" && request.preparationType === "workbook" && !terminal.has(request.state)) await this.state.put("requests", request.requestId, { ...request, state: "interrupted", error: report(failure(503, "job_interrupted", "Workbook admission was interrupted. Submit a new request ID.")), finishedAt: now() })
		for (const reservation of await this.state.list("index-reservations")) {
			const publication = reservation.representationId && await this.state.get("source-publications", reservation.representationId)
			if (publication && ["publishing", "indeterminate"].includes(publication.state)) continue
			if (reservation.stagingBasename) {
				if (!this.captures.stageBasename({ id: reservation.representationId, stagingBasename: reservation.stagingBasename }) || !await this.captures.unlinkExpected(reservation.stagingBasename, reservation.candidate || null)) continue
			}
			await this.state.delete("index-reservations", reservation.id)
		}
		// Revalidate resident source/index identity on boot, retaining evidence on uncertainty.
		for (const index of await this.state.list("workbook-indexes")) if (!index.evictedAt && index.manifest?.kind === "workbook") {
			try { const opened = await this.open(index.id); await opened.release() }
			catch (error) { if (error.status === 410) await this.state.put("workbook-indexes", index.id, { ...index, unavailable: report(error) }); else this.workspace.logger.warn?.("workbook restart validation failed", { representationId: index.id, ...report(error) }) }
		}
	}
	requireAdmission() { this.captures.requireAdmission(); if (this.closed || this.draining || this.workspace.draining) throw failure(503, "draining", "Workbook admission is draining."); if (this.availability.state !== "available") throw failure(503, "workbook_unavailable", "The workbook reader is unavailable.", { reason: this.availability.reason }) }
	prepare(input) { return this.track(this.prepareRequest(input)) }
	async prepareRequest(input) {
		strict(input, ["requestId", "type", "source", "options"], "Preparation")
		identifier(input.requestId, "requestId")
		if (input.type !== "workbook") throw failure(400, "unsupported_provider", "Choose the workbook preparation provider.")
		const options = input.options ?? {}; strict(options, [], "Workbook options")
		if (input.source?.kind !== "runtime-capture") throw failure(400, "invalid_source", "Workbook preparation requires a complete CapturedSource.")
		identifier(input.source.captureId, "captureId")
		const intent = { type: "preparation", preparationType: "workbook", source: capturedSourceIdentity(input.source), options }
		return this.captures.serial.call(this, "admissionTail", async () => {
			const prior = await this.state.get("requests", input.requestId)
			if (prior) {
				const priorIntent = prior.intent?.type === "preparation" ? { ...prior.intent, source: capturedSourceIdentity(prior.intent.source) } : prior.intent
				if (stableStringify(priorIntent) !== stableStringify(intent)) throw failure(409, "request_id_reused", "The request ID belongs to a different preparation intent.")
				const current = await this.state.get("captures", input.source.captureId)
				checkDigest(input.source, readySha(current?.source) || prior.result?.representation?.inputSha256)
				return this.answer(prior)
			}
			this.requireAdmission()
			const request = { requestId: input.requestId, type: "preparation", preparationType: "workbook", intent, state: "accepted", jobId: null, acceptedAt: now(), result: null, error: null }
			await this.state.claim("requests", request.requestId, intent, request)
			try {
				return await this.captures.withRetention(async () => {
					const sourceRecord = await this.captures.record("capture", input.source.captureId), handle = await this.captures.privateFile(sourceRecord); await handle.close()
					if (!sameSource(sourceRecord.source, input.source)) throw failure(409, "source_changed", "CapturedSource does not match the authoritative immutable capture binding, ETag, size, reference or consistency.")
					checkDigest(input.source, readySha(sourceRecord.source))
					if (sourceRecord.sizeBytes > this.limits.workbookInputBytes) throw failure(413, "workbook_input_limit", "This workbook exceeds the input byte ceiling.")
					const key = stableStringify([this.state.identity, sourceRecord.source.captureId, sourceRecord.source.etag, this.build, options])
					let resident = (await this.state.list("workbook-indexes")).find((index) => index.preparationKey === key && !index.evictedAt)
					if (resident) {
						checkDigest(input.source, resident.manifest.inputSha256)
						try { const indexHandle = await this.captures.privateFile(resident); await indexHandle.close() }
						catch (error) {
							if (error.status !== 410 || error.error !== "index_expired") throw error
							// Only new admission rebuilds a missing derived index. Keep the old ID terminal
							// for historical queries/receipts and remove its missing bytes from accounting.
							await this.state.put("workbook-indexes", resident.id, { ...resident, evictedAt: now(), cleanupPending: false })
							resident = undefined
						}
					}
					if (resident) {
						const lease = this.captures.makeLease("capture", sourceRecord.id), result = { status: 200, representation: resident.manifest, source: sourceRecord.source, lease }
						await this.state.transaction([put("leases", lease.leaseId, lease), put("requests", request.requestId, { ...request, state: "succeeded", result, finishedAt: now() })]); return result
					}
					const shared = [...this.tasks.values()].find((task) => task.key === key && !terminal.has(task.job.state))
					if (shared) { shared.job.requestIds.push(request.requestId); await this.state.transaction([put("jobs", shared.job.jobId, shared.job), put("requests", request.requestId, { ...request, state: shared.job.state, jobId: shared.job.jobId })]); return { status: 202, jobId: shared.job.jobId } }
					if (this.tasks.size) throw failure(429, "capacity", "One workbook preparation is already active.", { retryAfter: 1 })
					const nativeRelease = this.workspace.acquireNative()
					try {
						const jobId = crypto.randomUUID(), id = crypto.randomUUID(), holdId = `workbook-${jobId}`
						const job = { jobId, requestId: request.requestId, requestIds: [request.requestId], type: "preparation", preparationType: "workbook", state: "queued", stage: "queued", holdId, source: { kind: "capture", id: sourceRecord.id }, resultRef: id, acceptedAt: now(), progress: { bytesDone: 0, totalBytes: sourceRecord.sizeBytes, elapsedMs: 0 }, result: null, error: null }
						await this.captures.reserveIndex({ id: jobId, jobId, representationId: id, sizeBytes: this.limits.workbookIndexBytes + this.limits.workbookManifestBytes, createdAt: now() }, [put("holds", holdId, { holdId, source: job.source, reason: "workbook", jobId, createdAt: now() }), put("jobs", jobId, job), put("requests", request.requestId, { ...request, state: "queued", jobId })])
						const task = { job, id, key, source: sourceRecord.source, nativeRelease, controller: new AbortController() }; this.tasks.set(jobId, task)
						task.promise = new Promise((resolve) => { task.start = resolve }); this.track(task.promise); queueMicrotask(() => { task.start(this.run(task)) })
						return { status: 202, jobId }
					} catch (error) { nativeRelease(); throw error }
				})
			} catch (error) { await this.state.put("requests", request.requestId, { ...request, state: "failed", error: report(error), finishedAt: now() }); throw error }
		})
	}
	async answer(request) {
		if (request.error && terminal.has(request.state)) throw fromReport(request.error)
		if (!request.result) return { status: 202, jobId: request.jobId }
		// A completed receipt records the original lease, not current retention or residency.
		const opened = await this.open(request.result.representation.id)
		try {
			if (!sameSource(opened.source, request.intent.source) || !sameSource(opened.source, request.result.source) || stableStringify(opened.manifest) !== stableStringify(request.result.representation)) throw failure(410, "representation_unavailable", "The completed workbook's exact input or index is no longer available.")
			const lease = await this.captures.lease({ source: { kind: "capture", id: opened.source.captureId } })
			return { status: 200, representation: opened.manifest, source: opened.source, lease }
		} finally { await opened.release() }
	}
	validateManifest(base, source) {
		if (base?.schemaVersion !== 1 || base.origin !== "fresh" || typeof base.parser !== "string" || !["1900", "1904", "unknown"].includes(base.dateSystem) || !/^[0-9a-f]{64}$/.test(base.inputSha256 || "") || !Array.isArray(base.sheets) || !Array.isArray(base.warnings) || !base.warnings.every((w) => typeof w === "string")) throw failure(422, "invalid_workbook_manifest", "The reader returned an invalid workbook manifest.")
		if (source.digest.state === "ready" && source.digest.sha256 !== base.inputSha256) throw failure(422, "digest_mismatch", "Reader input SHA-256 differs from captured-byte evidence.")
		for (const [ordinal, sheet] of base.sheets.entries()) {
			if (!sheet || typeof sheet !== "object" || Array.isArray(sheet)) throw failure(422, "invalid_workbook_manifest", "Reader sheet inventory is invalid.")
			const dimensions = Number.isSafeInteger(sheet.rows) && sheet.rows >= 0 && sheet.rows <= 1048576 && Number.isSafeInteger(sheet.columns) && sheet.columns >= 0 && sheet.columns <= 16384
			const rowEvidence = Number.isSafeInteger(sheet.indexedRows) && sheet.indexedRows >= 0 && sheet.indexedRows <= sheet.rows && (sheet.kind !== "unsupported" || sheet.indexedRows === 0) && (sheet.storedRange === null || typeof sheet.storedRange === "string")
			const cells = sheet.populatedCells === null || Number.isSafeInteger(sheet.populatedCells) && sheet.populatedCells >= 0
			const merges = sheet.merges === null || Array.isArray(sheet.merges) && sheet.merges.every((m) => typeof m === "string")
			if (sheet.id !== `sheet-${ordinal}` || sheet.ordinal !== ordinal || typeof sheet.name !== "string" || !["visible", "hidden", "very-hidden", "unknown"].includes(sheet.visibility) || !["worksheet", "unsupported"].includes(sheet.kind) || !dimensions || !rowEvidence || !cells || !merges || !Array.isArray(sheet.modes) || sheet.modes.some((mode) => !["stored", "formula"].includes(mode)) || !Array.isArray(sheet.warnings)) throw failure(422, "invalid_workbook_manifest", "Reader sheet inventory is invalid.")
		}
		for (const key of ["durationMs", "peakRssKiB", "inputBytes", "outputBytes"]) if (!Number.isFinite(base.metrics?.[key]) || base.metrics[key] < 0) throw failure(422, "invalid_workbook_manifest", "Reader metrics are incomplete.")
	}
	async run(task) {
		let opened, stage, result, settled = false
		const started = Date.now()
		const timer = setTimeout(() => { task.timedOut = true; task.controller.abort() }, this.limits.workbookPrepareMs)
		try {
			if (task.controller.signal.aborted) throw failure(409, "job_cancelled", "Workbook preparation was cancelled.")
			task.job = { ...task.job, state: "running", stage: "parsing" }; await this.state.put("jobs", task.job.jobId, task.job)
			opened = await this.captures.open("capture", task.source.captureId); stage = await this.captures.producerStage(task.id)
			const reservation = await this.state.get("index-reservations", task.job.jobId)
			await this.state.put("index-reservations", task.job.jobId, { ...reservation, stagingBasename: this.captures.stageNames.get(stage), candidate: null })
			if (task.controller.signal.aborted) throw failure(409, "job_cancelled", "Workbook preparation stopped before native dispatch.")
			const base = await this.reader.parse({ handle: opened.handle, source: opened.source, outputPath: stage.name, signal: task.controller.signal })
			if (task.controller.signal.aborted) throw failure(409, "job_cancelled", "Workbook reader stopped after cancellation.")
			this.validateManifest(base, opened.source)
			if (!await this.captures.adoptProducerStage(stage)) throw failure(422, "invalid_workbook_index", "The reader did not create its index.")
			const stat = await stage.handle.stat({ bigint: true })
			if (Number(stat.size) > this.limits.workbookIndexBytes) throw failure(413, "workbook_index_limit", "The workbook index exceeds its byte ceiling.")
			const manifest = { schemaVersion: 1, kind: "workbook", id: task.id, source: task.source, parser: base.parser, provider: { id: "workbook", build: this.build }, origin: "fresh", dateSystem: base.dateSystem, sheets: base.sheets, warnings: base.warnings, metrics: { ...base.metrics, inputBytes: task.source.sizeBytes, outputBytes: Number(stat.size) }, inputSha256: base.inputSha256, limits: this.publicLimits(), retention: "input-capture" }
			const metadataBytes = Buffer.byteLength(JSON.stringify(manifest))
			if (metadataBytes > this.limits.workbookManifestBytes) throw failure(413, "workbook_manifest_limit", "The workbook inventory exceeds its metadata ceiling.")
			await this.worker(stage.handle, { action: "validate", manifest }, task.controller.signal, this.limits.workbookPrepareMs, this.limits.workbookPageBytes)
			await this.captures.publish(stage, { id: task.id, kind: "index", source: task.source, dependency: { kind: "capture", id: task.source.captureId }, dependencies: [{ kind: "capture", id: task.source.captureId }], manifest, metadataBytes, preparationKey: task.key, reservationId: task.job.jobId, sizeBytes: Number(stat.size), createdAt: now(), lastAccessAt: now() }, { task })
			const lease = await this.captures.lease({ source: { kind: "capture", id: task.source.captureId } })
			result = { status: 201, representation: manifest, source: task.source, lease }
			await this.settle(task, "succeeded", result, null, started); settled = true
		} catch (error) {
			if (task.timedOut && !stage?.preserve) error = failure(408, "workbook_time_limit", "Workbook preparation exceeded its elapsed-work ceiling.")
			if (stage && !stage.handle && !stage.preserve) { try { await this.captures.adoptProducerStage(stage) } catch (cause) { error = cause } }
			await this.settle(task, task.controller.signal.aborted && !task.timedOut && !stage?.preserve ? "cancelled" : "failed", null, report(error), started); settled = true
		} finally {
			clearTimeout(timer)
			try {
				await opened?.release()
				await this.captures.cleanup(stage)
				if (settled && !stage?.preserve) await this.captures.withRetention(async () => { await this.state.delete("index-reservations", task.job.jobId); await this.state.delete("holds", task.job.holdId) })
				else if (settled && stage?.published) await this.captures.releaseHold(task.job.holdId)
			} catch (error) {
				task.job = { ...task.job, cleanup: { state: "indeterminate", error: report(error) } }; await this.state.put("jobs", task.job.jobId, task.job)
			} finally { this.tasks.delete(task.job.jobId); task.nativeRelease() }
		}
	}
	async settle(task, state, result, error, started) {
		return this.captures.serial.call(this, "admissionTail", async () => {
			task.job = { ...task.job, state, stage: state === "succeeded" ? "complete" : state, result, error, finishedAt: now(), progress: { bytesDone: state === "succeeded" ? task.source.sizeBytes : 0, totalBytes: task.source.sizeBytes, elapsedMs: Date.now() - started } }
			const operations = [put("jobs", task.job.jobId, task.job)]
			for (const requestId of task.job.requestIds) { const request = await this.state.get("requests", requestId); operations.push(put("requests", requestId, { ...request, state, result, error, finishedAt: task.job.finishedAt })) }
			await this.state.transaction(operations); this.workspace.events.publish("job", { jobId: task.job.jobId, state, stage: task.job.stage, resultRef: state === "succeeded" ? task.id : null })
		})
	}
	async open(id) {
		identifier(id, "representationId")
		return this.captures.withRetention(async () => {
			const index = await this.captures.record("index", id)
			if (index.manifest?.kind !== "workbook") throw failure(400, "representation_kind", "This operation requires a workbook representation.")
			if (index.unavailable) throw fromReport(index.unavailable)
			const source = await this.captures.record("capture", index.dependency.id)
			if (!sameSource(source.source, index.manifest.source)) throw failure(410, "representation_unavailable", "The workbook input binding is no longer available.")
			checkDigest(source.source, index.manifest.inputSha256)
			let sourceReader
			try { sourceReader = await this.captures.reader(source) } catch (error) { if (error.error === "transfer_source_missing") throw failure(410, "representation_unavailable", "The workbook's retained input bytes are missing."); throw error }
			try {
				const indexReader = await this.captures.reader(index)
				try {
					await this.state.transaction([put("captures", source.id, { ...source, lastAccessAt: now() }), put("workbook-indexes", index.id, { ...index, lastAccessAt: now() })])
					return { handle: indexReader.handle, manifest: index.manifest, source: source.source, release: async () => { await indexReader.release(); await sourceReader.release() } }
				} catch (error) { await indexReader.release(); throw error }
			} catch (error) { await sourceReader.release(); throw error }
		})
	}
	async get(id) { const opened = await this.open(id); try { return opened.manifest } finally { await opened.release() } }
	normalize(input, manifest) {
		strict(input, ["sheet", "mode", "rowOffset", "rowLimit", "columnOffset", "columnLimit", "range", "headerRows", "filter", "sort"], "WorkbookQuery")
		const sheet = manifest.sheets.find((s) => s.id === input.sheet)
		if (!sheet) throw failure(400, "invalid_sheet", "Select a sheet from the workbook inventory.")
		if (sheet.kind !== "worksheet") throw failure(415, "unsupported_sheet", sheet.reason || "This sheet does not support cell queries.")
		const mode = input.mode ?? "stored"
		if (!sheet.modes.includes(mode)) throw failure(400, "invalid_mode", "Select a supported workbook value mode.")
		const range = input.range ?? null
		if (range !== null) { strict(range, ["rowStart", "rowEnd", "columnStart", "columnEnd"], "Workbook range"); for (const key of ["rowStart", "rowEnd", "columnStart", "columnEnd"]) integer(range[key], undefined, key.startsWith("row") ? sheet.rows - 1 : sheet.columns - 1, key); if (range.rowStart > range.rowEnd || range.columnStart > range.columnEnd) throw failure(400, "invalid_range", "Inclusive range ends must follow their starts.") }
		const headerRows = input.headerRows ?? []
		if (!Array.isArray(headerRows) || headerRows.length > this.limits.workbookSelectedRows) throw failure(400, "invalid_headers", "Supply a bounded list of source header rows.")
		for (const row of headerRows) integer(row, undefined, sheet.rows - 1, "header row")
		const filter = input.filter ?? ""
		if (typeof filter !== "string" || Buffer.byteLength(filter) > 65536) throw failure(400, "invalid_filter", "Filter must be literal text within the request ceiling.")
		const sort = input.sort ?? null
		if (sort !== null) { strict(sort, ["column", "direction", "mode"], "Sort"); integer(sort.column, undefined, range?.columnEnd ?? sheet.columns - 1, "sort column", range?.columnStart ?? 0); if (!["asc", "desc"].includes(sort.direction) || !["number", "text"].includes(sort.mode)) throw failure(400, "invalid_sort", "Sort requires direction asc/desc and mode number/text.") }
		return { sheet: sheet.id, mode, rowOffset: integer(input.rowOffset, 0, Number.MAX_SAFE_INTEGER, "rowOffset"), rowLimit: integer(input.rowLimit, this.limits.workbookRowLimit, this.limits.workbookRowMaxLimit, "rowLimit", 1), columnOffset: integer(input.columnOffset, 0, 16384, "columnOffset"), columnLimit: integer(input.columnLimit, this.limits.workbookColumnLimit, this.limits.workbookColumnMaxLimit, "columnLimit", 1), range, headerRows: [...new Set(headerRows)].sort((a, b) => a - b), filter, sort }
	}
	withInteractivePermit(wait, work) {
		return this.track((async () => {
			if (this.closed) throw failure(503, "draining", "Workbook queries are closed.")
			if (wait?.deadline === undefined && (this.draining || this.workspace.draining)) throw failure(503, "draining", "Workbook queries are draining.")
			this.captures.requireAvailable()
			if (this.availability.state !== "available") throw failure(503, "workbook_unavailable", "The workbook reader is unavailable.")
			const release = wait?.deadline === undefined ? this.workspace.acquireNative() : await this.workspace.acquireAcceptedNative(wait), permit = Object.freeze({}), state = { active: true, accepting: true, busy: false, accepted: wait?.deadline !== undefined, tasks: new Set() }
			this.#permits.set(permit, state)
			try { return await work(permit) } finally { state.accepting = false; await Promise.allSettled([...state.tasks]); state.active = false; release() }
		})())
	}
	#executeTracked(id, input, request, signal, permit) {
		const task = this.track(this.execute(id, input, request, signal, permit)), state = permit && this.#permits.get(permit)
		if (state?.active) { state.tasks.add(task); task.finally(() => state.tasks.delete(task)).catch(() => {}) }; return task
	}
	query(id, input, signal, permit) { return this.#executeTracked(id, input, null, signal, permit) }
	export(id, input, signal, permit) { strict(input, ["query", "selectedRows", "formulaHandling", "format"], "Workbook export"); return this.#executeTracked(id, input.query, input, signal, permit) }
	async execute(id, input, exportRequest, signal, permit) {
		if (permit === undefined) return this.withInteractivePermit({}, (owned) => this.execute(id, input, exportRequest, signal, owned))
		const state = this.#permits.get(permit)
		if (!state?.active || !state.accepting) throw failure(400, "invalid_permit", "Use a live workbook permit from this provider.")
		if (state.busy) throw failure(429, "capacity", "This workbook permit already has an active query.", { retryAfter: 1 })
		state.busy = true; let opened
		try {
			opened = await this.open(id)
			const query = this.normalize(input, opened.manifest)
			let request
			if (exportRequest) {
				const selectedRows = exportRequest.selectedRows ?? null, formulaHandling = exportRequest.formulaHandling ?? "escaped-text", format = exportRequest.format ?? "csv"
				if (selectedRows !== null) { if (!Array.isArray(selectedRows) || selectedRows.length > this.limits.workbookSelectedRows) throw failure(400, "selection_limit", "Too many selected source rows."); const sheet = opened.manifest.sheets.find((s) => s.id === query.sheet); for (const row of selectedRows) integer(row, undefined, sheet.rows - 1, "selected row") }
				if (!["escaped-text", "exact"].includes(formulaHandling) || !["csv", "typed-jsonl"].includes(format)) throw failure(400, "invalid_export", "Choose escaped-text/exact and csv/typed-jsonl.")
				request = { selectedRows, formulaHandling, format }
			}
			return await this.worker(opened.handle, { action: request ? "export" : "query", manifest: opened.manifest, query, ...(request ? { request } : {}) }, signal, request ? this.limits.workbookExportMs : this.limits.workbookQueryMs, request ? this.limits.workbookExportBytes : this.limits.workbookPageBytes, permit)
		} finally { try { await opened?.release() } finally { state.busy = false } }
	}
	worker(handle, input, signal, elapsedMs, outputBytes, permit) {
		if (this.interactive && input.action !== "validate") return Promise.reject(failure(429, "capacity", "One workbook query or export is already active.", { retryAfter: 1 }))
		if (input.action !== "validate") this.interactive = true
		const controller = new AbortController(); this.controllers.add(controller)
		if (permit && this.#permits.get(permit)?.accepted) this.#acceptedControllers.add(controller)
		const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort()
		return new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [`--max-old-space-size=${this.limits.workbookWorkerHeapMiB}`, fileURLToPath(new URL("./file-workbooks-worker.js", import.meta.url))], { detached: true, stdio: ["pipe", "pipe", "pipe", handle.fd], env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } })
			let output = "", bytes = 0, reason, timer
			const stop = (error) => { reason ||= error; try { process.kill(-child.pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") child.kill("SIGKILL") } }
			const cancelled = () => stop(failure(409, "job_cancelled", "The workbook operation was cancelled and its query process terminated."))
			controller.signal.addEventListener("abort", cancelled, { once: true })
			if (controller.signal.aborted) cancelled()
			timer = setTimeout(() => stop(failure(408, "workbook_time_limit", "The workbook operation exceeded its elapsed-work ceiling. Request a smaller scope.")), elapsedMs)
			child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { bytes += Buffer.byteLength(chunk); if (bytes > outputBytes + 4096) stop(failure(413, "workbook_response_limit", "The workbook worker exceeded its response byte ceiling.")); else output += chunk })
			child.stderr.resume()
			child.on("error", (error) => { reason ||= failure(503, "workbook_worker_unavailable", error.message) })
			child.stdin.on("error", () => {})
			child.on("close", (code, killedBy) => {
				clearTimeout(timer); controller.signal.removeEventListener("abort", cancelled); signal?.removeEventListener("abort", abort); this.controllers.delete(controller); if (input.action !== "validate") this.interactive = false
				if (reason) return reject(reason)
				if (killedBy || code === 134 || code === 137) return reject(failure(413, "workbook_resource_limit", "Workbook query process exceeded its resource envelope. Request a smaller scope."))
				try { const reply = JSON.parse(output); if (reply.error) throw fromReport(reply.error); if (code !== 0 || !reply.result) throw failure(422, "workbook_worker_failed", `Workbook query process failed (${code}).`); resolve(reply.result) } catch (error) { reject(error instanceof FileError ? error : failure(422, "workbook_worker_failed", "Workbook query returned no complete result.")) }
			})
			child.stdin.end(JSON.stringify({ ...input, outputBytes }))
		})
	}
	async cancel(id) {
		return this.captures.serial.call(this, "admissionTail", async () => {
			const task = this.tasks.get(id); if (!task || terminal.has(task.job.state)) return this.captures.getJob(id)
			task.job = { ...task.job, state: "cancel_requested", cancelRequestedAt: now() }; await this.state.put("jobs", id, task.job); task.controller.abort(); return task.job
		})
	}
	async drain(deadline) {
		this.draining = true; await this.admissionTail
		for (const task of this.tasks.values()) task.controller.abort()
		for (const controller of this.controllers) if (!this.#acceptedControllers.has(controller)) controller.abort()
		let timer
		try { await Promise.race([Promise.allSettled([...this.pending]), new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now())) })]) } finally { clearTimeout(timer) }
		const publications = (await this.state.list("source-publications")).filter((p) => p.kind === "index" && p.metadataOperations?.[0]?.value.manifest?.kind === "workbook" && ["publishing", "indeterminate"].includes(p.state)), publicationJobs = new Set(publications.map((p) => p.jobId))
		const jobs = (await this.state.list("jobs")).filter((job) => job.type === "preparation" && job.preparationType === "workbook")
		const receiptIndeterminate = jobs.filter((job) => (job.error?.state === "indeterminate" || job.cleanup?.state === "indeterminate") && !publicationJobs.has(job.jobId)).length
		const localPending = this.pending.size + jobs.filter((job) => !terminal.has(job.state) && !this.tasks.has(job.jobId)).length, indeterminate = publications.length + receiptIndeterminate
		return { localPending, indeterminate, receiptIndeterminate, failed: jobs.filter((job) => ["failed", "interrupted"].includes(job.state)).length, complete: localPending === 0 && indeterminate === 0 }
	}
	async close() { this.draining = true; await this.admissionTail; for (const task of this.tasks.values()) task.controller.abort(); for (const controller of this.controllers) controller.abort(); await Promise.allSettled([...this.pending]); await this.reader?.close?.(); this.closed = true }
}
