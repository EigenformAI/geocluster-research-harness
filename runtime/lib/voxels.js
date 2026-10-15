import crypto from "node:crypto"
import path from "node:path"
import { Readable } from "node:stream"
import { Worker } from "node:worker_threads"
import { canonicalPath, identifier, observation, sameObject, stableStringify } from "./file-contract.js"
import { jsonBody, workspaceFenceError } from "./files.js"
import gate from "../gate.cjs"
import { canonicalJson, recipeFingerprint } from "./voxel/voxel-recipe.js"
import { recipeAssumptions } from "./voxel/voxel-compute.js"
import { manifestGeneration, readManifest, VoxelArtifactError } from "./voxel/voxel-artifact.js"
import { describeScope, fail, sourceRevision, strict, submission, tableRecipe, indexedRecipe, indexScan, revisionTarget, VoxelError } from "./voxel-request.js"
import { NamedVoxels, namedIntent } from "./voxel-named.js"
import { MAX_CATEGORIES } from "./voxel/voxel-constraints.js"
import { VOXEL_CAPTURE_METADATA_BYTES } from "./file-captures.js"
import { VoxelRegistry } from "./voxel-registry.js"

export const VOXEL_LIMITS = Object.freeze({ rows: 100000, columns: 1024, cells: 1000000, categories: 4096, pieces: 4000000, sourceBytes: 32 * 1048576, memberBytes: 32 * 1048576, workers: 1, workerHeapMiB: 512, elapsedMs: 60000, tableRetentionBytes: 128 * 1048576, contentionWaitMs: 120000, verificationQueueSize: 32, artifactRetainedBytes: 8 * 1024 ** 3 })
const terminal = (op) => ["ready", "failed"].includes(op.phase)
const now = () => new Date().toISOString()
const put = (kind, id, value) => ({ type: "put", kind, id, value })
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex")
const revision = (source) => ({ root: "workspace", resourceId: source.ref.path, path: source.ref.path, sha256: source.digest.sha256, revision: `capture:${source.captureId}` })
const sourceOf = (s) => s.kind !== "import-metadata" ? s.recipe.scope.input.source : s.recipe.source
const publicOp = (record) => { const { key, holdId, namedIntent, ...operation } = record; return operation }
const artifactIntegrityError = (error) => error instanceof VoxelArtifactError || ["artifact_integrity", "source_integrity", "source_changed", "invalid_manifest", "invalid_npy", "transfer_source_missing", "capture_expired"].includes(error.error) || error.reason === "integrity"
const safeReason = (error) => error instanceof VoxelError ? error.message : ({ head_conflict: "The voxel changed before rename. Resolve its current head and retry.", voxel_not_found: "No named voxel has this ID in the current workspace epoch.", invalid_id: "Supply a valid voxel or operation identifier.", invalid_state_operation: "Supply a bounded named-voxel request with a valid name and head validator.", capture_store_unavailable: "Protected voxel data is unavailable. Check capture storage and retry the read.", source_expired: "The exact source capture is unavailable. Select an available captured source.", invalid_path: "Supply a canonical workspace-relative path." }[error.error] || "Voxel storage or publication is unavailable. Inspect runtime storage and check the retained operation.")
const manifestNames = new WeakMap()
function manifestStem(name) {
	let stem = ""
	for (const char of String(name ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f/\\:*?"<>|\ud800-\udfff]+/gu, "-").replace(/\s+/gu, " ").trim().replace(/^[.\s-]+/u, "")) {
		if (Buffer.byteLength(stem + char) > 200) break
		stem += char
	}
	return stem.replace(/[.\s]+$/u, "") || "Voxel"
}
function decodedId(value) { try { return decodeURIComponent(value) } catch { throw fail(400, "invalid_parameter", "The ID must use valid UTF-8 transport encoding.") } }
function json(res, status, body) {
	const bytes = JSON.stringify(body)
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(bytes), "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(bytes)
}
export function voxelPath(pathname) { return ["/voxels", "/voxels/member", "/voxels/named", "/voxels/artifacts"].includes(pathname) || /^\/voxels\/(operations|named|artifacts)\/[^/]+$/.test(pathname) }
export function voxelFamily(pathname) { return pathname === "/voxels" || pathname.startsWith("/voxels/") }
function query(url, allowed) {
	if (Buffer.byteLength(url.search) > 16384) throw fail(400, "invalid_parameter", "Voxel query parameters exceed 16 KiB.")
	const result = {}
	for (const entry of url.search.slice(1).split("&").filter(Boolean)) {
		const at = entry.indexOf("="); let key, value
		try { key = decodeURIComponent((at < 0 ? entry : entry.slice(0, at)).replace(/\+/g, " ")); value = decodeURIComponent((at < 0 ? "" : entry.slice(at + 1)).replace(/\+/g, " ")) } catch { throw fail(400, "invalid_parameter", "Query parameters must use valid UTF-8 transport encoding.") }
		if (!allowed.includes(key) || Object.hasOwn(result, key) || !value) throw fail(400, "invalid_parameter", `Unsupported, empty or repeated query parameter: ${key}.`)
		if (Buffer.byteLength(value) > (key === "source" || key === "manifest" ? 12288 : key === "resourceId" ? 4096 : key === "cursor" ? 2048 : key === "name" ? 1024 : 128)) throw fail(400, "invalid_parameter", `Query parameter ${key} is too long.`)
		result[key] = value
	}
	return result
}
function parsedSource(value) { try { return sourceRevision(JSON.parse(value)) } catch (error) { if (error.status) throw error; throw fail(400, "invalid_source", "Supply a JSON SourceRevision from a ready complete capture.") } }
export function voxelOriginError(req, allowed) {
	if (!["POST", "DELETE"].includes(req.method)) return null
	const origins = []; for (let n = 0; n < (req.rawHeaders?.length || 0); n += 2) if (req.rawHeaders[n].toLowerCase() === "origin") origins.push(req.rawHeaders[n + 1])
	const value = req.headers.origin
	if (value === undefined && !origins.length) return null
	let canonical = false
	try { const url = new URL(value); canonical = ["http:", "https:"].includes(url.protocol) && url.origin.toLowerCase() === value.toLowerCase() } catch {}
	return origins.length > 1 || !canonical || !gate.originAllowed(value, allowed) ? fail(403, "bad_origin", "Voxel mutations require one allowed application Origin when supplied. Reconnect from the allowed application.") : null
}

/** Durable epoch-scoped receipts, bounded numerical workers and capture-backed artifact registration. */
export class VoxelService {
	constructor(workspace) {
		this.workspace = workspace; this.captures = workspace.captures; this.state = workspace.state
		this.limits = { ...VOXEL_LIMITS, ...workspace.config.voxelLimits }
		if (workspace.config.voxelLimits?.artifactRetainedBytes === undefined) this.limits.artifactRetainedBytes = Math.max(1, Math.min(VOXEL_LIMITS.artifactRetainedBytes, Math.floor(this.captures.limits.retainedBytes / 2)))
		for (const [key, value] of Object.entries(this.limits)) if (!Object.hasOwn(VOXEL_LIMITS, key) || !Number.isSafeInteger(value) || value < 1) throw fail(400, "invalid_budget", `Voxel limit ${key} must be a positive safe integer.`)
		if (this.limits.categories > MAX_CATEGORIES || this.limits.artifactRetainedBytes > this.captures.limits.retainedBytes) throw fail(400, "invalid_budget", `categories cannot exceed ${MAX_CATEGORIES} and artifactRetainedBytes cannot exceed shared retainedBytes.`)
		this.tasks = new Map(); this.pending = new Set(); this.active = 0; this.admissionTail = Promise.resolve()
		this.named = new NamedVoxels(this)
		this.registry = new VoxelRegistry(this)
		this.verifications = new Map(); this.verificationQueue = []; this.recoveryQueue = []; this.workers = new Set(); this.workerKinds = new Map(); this.recoveryRetryAttempts = new Map()
		this.captures.voxelPersistenceInterest = async (owned) => { const a = await this.registry.get(owned.artifactId), upload = await this.state.get("operations", a.uploadId); return this.ownsUpload(a, upload) && this.matchingSource(a, upload.publishedSource) ? this.persistenceInterest(upload) : { needed: true, blocker: "persistenceEvidence" } }
		this.captures.onVoxelInterestReleased = () => this.scheduleCleanup()
	}
	async init() {
		if (this.captures.availability.state !== "available") {
			for (const a of await this.state.list("voxel-artifacts")) if (a.verificationState !== "integrity-blocked") await this.state.put("voxel-artifacts", a.artifactId, { ...a, publicationState: a.publicationState || a.state, verificationState: "temporarily-unavailable", verificationError: { error: "capture_store_unavailable", classification: "transient", message: "Protected capture storage is unavailable. Check storage readiness." } })
			return
		}
		// Metadata-only boot reconciliation. Historical ready arrays are verified on demand.
		for (let a of await this.state.list("voxel-artifacts")) {
			a = { ...a, publicationState: a.publicationState || a.state, verificationState: a.verificationState === "integrity-blocked" ? "integrity-blocked" : "unchecked", recoveryPending: false }
			await this.state.put("voxel-artifacts", a.artifactId, a)
			const op = await this.state.get("voxel-operations", a.operationId)
			if (!(a.publicationState === "ready" && op?.phase === "ready") && !(a.verificationState === "integrity-blocked" && a.publicationOutcome === "committed")) {
				const evidence = await this.publicationEvidence(a)
				if (evidence.committed) {
					a = { ...a, state: "publishing", publicationState: "publishing", recoveryPending: true, link: { artifactId: a.artifactId, generation: a.manifest.generation, manifest: revision(evidence.upload.publishedSource) } }; await this.state.put("voxel-artifacts", a.artifactId, a); this.recoveryQueue.push(a.artifactId)
					if (op) await this.save({ ...op, phase: "publishing", waitingFor: "artifactVerification", artifact: a.link, updatedUtc: now() })
				} else await this.incompleteArtifact(a, fail(503, "publication_interrupted", "Voxel publication was interrupted; retained evidence was reconciled without regeneration."))
			}
			if (!a.deletion && a.publicationState === "ready" && op?.artifact && op.named?.outcome === "unknown") await this.settleNamed(op)
			if (!a.deletion && (a.publicationState !== "failed" || a.verificationState === "integrity-blocked")) await this.restoreArtifactHolds(a)
			await this.reconcileReservation(await this.registry.get(a.artifactId))
		}
		for (const record of await this.state.list("voxel-keys")) {
			const op = await this.state.get("voxel-operations", record.id) || record, a = (await this.state.list("voxel-artifacts")).find((a) => a.operationId === op.id)
			if (!terminal(op) && !a) await this.save({ ...op, phase: "failed", named: { ...op.named, outcome: "failed" }, detail: "Voxel generation was interrupted. Submit a new key to retry.", error: { phase: op.phase, error: "interrupted", message: "Voxel generation was interrupted." }, updatedUtc: now() })
			if (op.holdId && (!a || ["ready", "failed"].includes(a.publicationState))) await this.releaseOperationHold(op)
		}
		await this.cleanupArtifacts()
	}
	startRecovery() { if (this.recoveryStarted || this.closed) return; this.recoveryStarted = true; this.scheduleVerification() }
	scheduleCleanup() { if (this.cleanupPump || this.closed || this.draining || this.workspace.draining) return; this.cleanupPump = setImmediate(() => { this.cleanupPump = null; this.cleanupArtifacts().catch((error) => this.workspace.logger.error?.("voxel cleanup reconciliation failed", { agent: "voxel-service", tool: "voxel-cleanup", action: "Inspect retained cleanup evidence.", error: error.message })) }) }
	capabilities() {
		const available = !this.closed && this.captures.availability.state === "available"
		return { available, reason: available ? "Captured observation tables, indexed grids and numeric NPY inputs are supported." : "Protected capture storage is unavailable. Check file-service storage readiness.", service: "runtime-voxel-v1", sourceProfiles: available ? ["csv", "tsv", "npy", ...(this.workspace.workbooks.availability.state === "available" ? ["workbook-stored"] : [])] : [], transforms: [], algorithms: ["geocluster-binning-v1", "geocluster-indexed-v1"], intents: ["table-to-voxel", "indexed-grid", "import-metadata"], namedVoxels: true, artifactInspection: true, manifestResolution: true, ceilings: { ...this.limits, sharedRetainedBytes: this.captures.limits.retainedBytes }, limitUnits: Object.fromEntries(Object.keys(this.limits).map((key) => [key, key.endsWith("Bytes") ? "bytes" : key.endsWith("Ms") ? "milliseconds" : key.endsWith("MiB") ? "MiB" : "count"])), publication: available, retention: this.retention || { state: "initializing" }, gauges: this.gauges() }
	}
	track(promise) {
		const tracked = promise.catch((error) => {
			if (error instanceof VoxelError) throw error
			const publicError = fail(error.status || 500, error.error || "voxel_failed", safeReason(error))
			for (const key of ["retryAfter", "retryAt", "availability", "requiredBytes", "availableBytes", "action", "limits"]) if (error[key] !== undefined) publicError[key] = error[key]
			if (error.reason === "integrity") publicError.reason = "integrity"
			throw publicError
		})
		this.pending.add(tracked); tracked.finally(() => this.pending.delete(tracked)).catch(() => {}); return tracked
	}
	serial(work) { const result = this.admissionTail.then(work); this.admissionTail = result.catch(() => {}); return result }
	requireAdmission() { if (this.draining || this.closed || this.workspace.draining) throw fail(503, "draining", "The voxel service is draining accepted work. Retry after restart."); this.captures.requireAvailable() }
	reserve() { this.requireAdmission(); if (this.active >= this.limits.workers) throw fail(429, "capacity", "The voxel compute slots are occupied. Retry after an accepted operation finishes."); this.active++ }
	releaseCapacity() { this.active--; this.scheduleVerification() }
	gauges() { return { admittedRuns: this.tasks.size, activeNumericalWorkers: this.workers.size, workerKinds: [...this.workerKinds.values()], lazyVerificationQueue: this.verificationQueue.length, recoveryVerificationQueue: this.recoveryQueue.length, recoveryRetryWaiters: this.recoveryTimers?.size || 0, activeVerifications: [...this.verifications.values()].filter((v) => v.active).length, queuedExtraction: this.extractionWaiting || 0, activeExtraction: this.extractionActive || 0, mutationWaiters: this.mutationWaiting || 0 } }
	log(event, details) { this.workspace.logger.info?.(event, { workspaceEpoch: this.workspace.identity.workspaceEpoch, ...details }) }
	releaseOperationHold(op) { const source = op?.sourceRevisions?.[0]?.revision; return op?.holdId && typeof source === "string" && source.startsWith("capture:") ? this.captures.releaseBoundHolds([{ holdId: op.holdId, reason: "voxel-operation", source: { kind: "capture", id: source.slice(8) } }]) : Promise.resolve() }
	async save(op) { await this.state.transaction([put("voxel-operations", op.id, op), put("voxel-keys", op.key, op)]); return op }
	async resolve(value) {
		const source = sourceRevision(value)
		if (source.root !== "workspace" || source.resourceId !== source.path || !/^capture:[0-9a-f-]{36}$/.test(source.revision)) throw fail(409, "invalid_source", "Use a workspace SourceRevision with resourceId equal to path and revision capture:<captureId> from a complete ready capture.")
		if (canonicalPath(source.path, { root: false }) !== source.path) throw fail(409, "invalid_source", "The SourceRevision path must be a canonical workspace-relative file path.")
		const opened = await this.captures.open("capture", source.revision.slice(8))
		return this.bindSource(source, opened)
	}
	async bindSource(source, opened) {
		try {
			const stored = opened.source
			if (stored.ref.workspaceId !== this.workspace.identity.workspaceId || stored.ref.workspaceEpoch !== this.workspace.identity.workspaceEpoch || stored.ref.path !== source.path) throw fail(409, "source_changed", "The capture does not bind this path in the current workspace epoch. Capture the intended source again.")
			if (stored.digest.state !== "ready") throw fail(409, "digest_not_ready", "The complete capture needs a ready SHA-256 digest. Request a capture with computeDigest: true and wait for completion.")
			if (stored.digest.sha256 !== source.sha256) throw fail(409, "source_changed", "The source SHA-256 differs from its protected capture. Refresh the source selection.")
			return { ...opened, revision: source, binding: { fd: opened.handle.fd, size: stored.sizeBytes, sha256: source.sha256 } }
		} catch (error) { await opened.release(); throw error }
	}
	async registeredReaders(artifact, sources) {
		return this.captures.withRetention(async () => {
			const current = await this.registry.get(artifact.artifactId), opened = []
			if (current.deletion) throw fail(410, "artifact_deleted", "This artifact registration was deleted.")
			if (this.verificationKey(current) !== this.verificationKey(artifact)) throw fail(409, "artifact_integrity", "Artifact binding changed before reader admission.")
			try { for (const value of sources) { const source = sourceRevision(value); opened.push(await this.bindSource(source, await this.captures.reader(await this.captures.record("capture", source.revision.slice(8))))) }; return opened }
			catch (error) { for (const reader of opened) await reader.release(); throw error }
		})
	}
	async worker(data) {
		const worker = new Worker(new URL("./voxel-worker.js", import.meta.url), { workerData: { ...data, limits: this.limits }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: this.limits.workerHeapMiB } })
		this.workers.add(worker); this.workerKinds.set(worker, data.action)
		let timer, replied = false
		try {
			return await new Promise((resolve, reject) => {
				timer = setTimeout(() => reject(fail(408, "compute_limit", "Voxel computation exceeded its elapsed-work ceiling. Select fewer rows or larger cells.")), this.limits.elapsedMs)
				worker.once("message", (reply) => { replied = true; reply.error ? reject(fail(reply.error.status, reply.error.error, reply.error.reason)) : resolve(reply.result) })
				worker.once("error", (error) => reject(fail(503, error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "worker_resource_limit" : "worker_failed", error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "Voxel worker exhausted its resource allowance. Select a smaller scope or raise workerHeapMiB." : "Voxel worker failed unexpectedly. Inspect runtime diagnostics.")))
				worker.once("exit", (code) => { if (!replied || code !== 0) reject(fail(503, "worker_failed", `Voxel worker exited (${code}). Select a smaller scope or inspect runtime limits.`)) })
			})
		} finally { clearTimeout(timer); await worker.terminate(); this.workers.delete(worker); this.workerKinds.delete(worker) }
	}
	async contention(op, waitingFor, work) {
		if (!op) return work({})
		const allowance = op.contentionWaitRemainingMs ?? this.limits.contentionWaitMs, deadline = Date.now() + allowance; let started, waiting = false
		const finish = async () => { if (waiting) { const elapsed = Math.max(0, Date.now() - started); op.contentionWaitRemainingMs = Math.max(0, allowance - elapsed); op.contentionWaitUsedMs = (op.contentionWaitUsedMs || 0) + elapsed; if (waitingFor === "workbook") this.extractionWaiting--; else this.mutationWaiting--; waiting = false }; op.waitingFor = null; op.retryAt = null; op.contentionWaitStartedUtc = null; await this.save(op) }
		const onWait = async (info = {}) => { if (!waiting) { waiting = true; started = Date.now(); if (waitingFor === "workbook") this.extractionWaiting = (this.extractionWaiting || 0) + 1; else this.mutationWaiting = (this.mutationWaiting || 0) + 1 }; if (info.waiting === false || info.state === "admitted") { await finish(); return }; Object.assign(op, { waitingFor, retryAt: info.retryAt || null, contentionWaitStartedUtc: new Date(started).toISOString(), updatedUtc: now() }); await this.save(op) }
		try { return await work({ deadline, onWait }) } finally { await finish() }
	}
	async tableInput(scope, opened, fullRange = false, op = null) {
		const input = scope.input
		if (input.resourceId !== input.source.resourceId) throw fail(409, "source_changed", "The input resourceId must match its protected source path.")
		if (input.type === "delimited") {
			const extension = path.posix.extname(input.source.path).toLowerCase()
			if (!([".csv", ".tsv"].includes(extension))) throw fail(415, "unsupported_source", "Table voxel creation supports CSV, TSV and prepared stored workbook values. Save this table as CSV or TSV.")
			return { input, binding: opened.binding, fullRange }
		}
		const provider = this.workspace.workbooks
		if (provider.availability.state !== "available") throw fail(503, "workbook_unavailable", "Stored workbook values are unavailable. Enable the workbook provider or export the selected sheet as CSV or TSV.")
		const manifest = await provider.get(input.workbookId)
		if (manifest.source.captureId !== opened.source.captureId || manifest.inputSha256 !== input.source.sha256 || stableStringify(manifest.source.ref) !== stableStringify(opened.source.ref)) throw fail(409, "source_changed", "The workbook preparation does not bind the selected capture and digest. Prepare this exact source again.")
		const sheet = manifest.sheets.find((s) => s.id === input.sheet)
		if (!sheet || sheet.kind !== "worksheet" || !sheet.modes.includes("stored")) throw fail(415, "unsupported_sheet", "Choose a worksheet with stored values from this exact preparation.")
		if (!sheet.rows || !sheet.columns) throw fail(422, "empty_source", "This worksheet has no cells. Choose a populated worksheet.")
		const range = fullRange ? { rowStart: 0, rowEnd: sheet.rows - 1, columnStart: 0, columnEnd: sheet.columns - 1 } : scope.range
		if (range.columnEnd - range.columnStart + 1 > this.limits.columns || sheet.indexedRows > this.limits.rows + 32 && fullRange) throw fail(413, "scope_limit", "Select a smaller stored-value workbook range.")
		const query = { sheet: input.sheet, mode: "stored", range, headerRows: scope.headerRows, rowOffset: 0, rowLimit: 1, columnOffset: 0, columnLimit: Math.min(range.columnEnd - range.columnStart + 1, provider.limits.workbookColumnMaxLimit), filter: "", sort: null }
		return this.contention(op, "workbook", (wait) => provider.withInteractivePermit(wait, async (permit) => {
		this.extractionActive = (this.extractionActive || 0) + 1
		try {
		const exported = await provider.export(input.workbookId, { query, selectedRows: null, formulaHandling: "exact", format: "typed-jsonl" }, undefined, permit)
		const headers = []
		for (let offset = 0; offset < range.columnEnd - range.columnStart + 1; offset += provider.limits.workbookColumnMaxLimit) {
			const page = await provider.query(input.workbookId, { ...query, columnOffset: offset, columnLimit: Math.min(provider.limits.workbookColumnMaxLimit, range.columnEnd - range.columnStart + 1 - offset) }, undefined, permit)
			headers.push(...page.columns.map((c) => ({ column: c.index, label: c.header })))
		}
		return { input, workbook: { typedJsonl: exported.typedJsonl, columns: sheet.columns, headers, parser: manifest.parser, warnings: manifest.warnings }, scope: { ...scope, range } }
		} finally { this.extractionActive-- }
		}))
	}
	describe(input, range, headerRows) { return this.track(this.inspect("describe", describeScope(input, range, headerRows), null, range === null)) }
	validate(value) { const indexed = value?.algorithm === "geocluster-indexed-v1", recipe = indexed ? indexedRecipe(value) : tableRecipe(value); return this.track(this.inspect(indexed ? "indexed-grid" : "compute", recipe.scope, recipe)) }
	validateSubmission(value) { const intent = submission(value); return this.track(this.validateIntent(intent)) }
	async validateIntent(intent) {
		if (intent.kind !== "import-metadata") {
			const result = await this.inspect(intent.kind === "indexed-grid" ? "indexed-grid" : "compute", intent.recipe.scope, intent.recipe)
			return { ...result, recipeFingerprint: await recipeFingerprint(intent) }
		}
		this.reserve(); let opened
		try {
			opened = await this.resolve(intent.recipe.source)
			const { arrays, ...result } = await this.worker({ action: "import", binding: opened.binding, recipe: intent.recipe })
			return { ...result, errors: [], recipeFingerprint: await recipeFingerprint(intent), sourceRevisions: [intent.recipe.source] }
		} finally { try { await opened?.release() } finally { this.releaseCapacity() } }
	}
	scanIndices(value) { const scan = indexScan(value); return this.track(this.inspect("scan-indices", scan.scope, null, false, scan)) }
	async inspect(action, scope, recipe, fullRange = false, extra = {}) {
		this.reserve(); let opened
		try {
			opened = await this.resolve(scope.input.source)
			const data = await this.tableInput(scope, opened, fullRange), result = await this.worker({ ...data, ...extra, action, scope: data.scope || scope, recipe, materialize: false })
			if (action === "describe") return result
			if (action === "scan-indices") return { ...result, sourceRevisions: [scope.input.source] }
			const { arrays, ...validation } = result
			return { ...validation, recipeFingerprint: await recipeFingerprint({ kind: action === "indexed-grid" ? "indexed-grid" : "table-to-voxel", recipe }), sourceRevisions: [scope.input.source] }
		} finally { try { await opened?.release() } finally { this.releaseCapacity() } }
	}
	submit(value, key) {
		const intent = submission(value); identifier(key, "idempotencyKey")
		return this.track(this.serial(async () => {
			const prior = await this.state.get("voxel-keys", key)
			if (prior) { if (canonicalJson(prior.submission) !== canonicalJson(intent)) throw fail(409, "idempotency_conflict", "This idempotency key already binds a different validated submission. Use a new key for a different recipe or capture."); return { status: terminal(prior) ? 200 : 202, operation: await this.publicOperation(prior) } }
			this.reserve(); let opened, admitted = false, op
			try {
				opened = await this.resolve(sourceOf(intent))
				if (intent.kind !== "import-metadata" && intent.recipe.scope.input.resourceId !== opened.revision.resourceId) throw fail(409, "source_changed", "The input resourceId must match its exact capture path.")
				const id = crypto.randomUUID(), holdId = `voxel-op-${id}`, stamp = now()
				const named = namedIntent(intent)
				if (named.revision) named.name = (await this.state.get("voxel-named", named.voxelId))?.name ?? named.name
				op = { id, key, holdId, kind: intent.kind, submission: intent, namedIntent: named, named: { outcome: "unknown", voxelId: named.voxelId, name: named.name }, recipeFingerprint: await recipeFingerprint(intent), sourceRevisions: [opened.revision], phase: "accepted", detail: "Voxel operation accepted.", acceptedUtc: stamp, updatedUtc: stamp, artifact: null, error: null, statistics: null, contentionWaitRemainingMs: this.limits.contentionWaitMs, contentionWaitUsedMs: 0, waitingFor: null, retryAt: null }
				const claim = await this.state.claim("voxel-keys", key, intent, op)
				if (claim.duplicate) return { status: terminal(claim.record) ? 200 : 202, operation: publicOp(claim.record) }
				await this.captures.withRetentionMetadata("capture", opened.source.captureId, async () => ({ metadata: [put("voxel-operations", id, op), put("holds", holdId, { holdId, reason: "voxel-operation", source: { kind: "capture", id: opened.source.captureId }, createdAt: stamp })] }))
				admitted = true
				const accepted = publicOp(op)
				const run = this.track(this.run(op)); this.tasks.set(id, run); run.finally(() => { this.tasks.delete(id); this.cleanupArtifacts().catch((error) => this.workspace.logger.error?.("voxel accepted cleanup failed", { operationId: id, error: error.message })) }).catch(() => {})
				return { status: 202, operation: accepted }
			} catch (error) {
				if (op && !admitted) {
					const stored = await this.state.get("voxel-keys", key)
					if (stored?.id === op.id) { Object.assign(op, { phase: "failed", named: { ...op.named, outcome: "failed" }, detail: safeReason(error), error: { phase: "accepted", message: safeReason(error) }, updatedUtc: now() }); await this.save(op); await this.releaseOperationHold(op) }
				}
				if (error.error === "request_id_reused") throw fail(409, "idempotency_conflict", "This idempotency key already binds a different validated submission. Use a new key for a different recipe or capture.")
				throw error
			} finally { try { await opened?.release() } finally { if (!admitted) this.releaseCapacity() } }
		}))
	}
	async checkpoint(stage, op) { await this.workspace.config.voxelCheckpoint?.(stage, structuredClone(publicOp(op))) }
	async settleNamed(op) {
		try {
			await this.checkpoint("before-named-commit", op)
			Object.assign(op, await this.named.settle(op))
			await this.checkpoint("named-committed", op)
			await this.checkpoint("ready", op)
		} catch (error) {
			const journal = await this.state.get("voxel-named-outcomes", op.id)
			if (journal) Object.assign(op, journal.operation)
			else {
				Object.assign(op, { phase: "ready", named: { ...op.named, outcome: "unknown" }, detail: "Voxel artifact saved. Named association outcome is unknown; check this operation.", error: { phase: "associating", message: safeReason(error) }, updatedUtc: now() })
				await this.save(op)
			}
		}
		return op
	}
	namedList(params) { return this.track(this.named.list(params)) }
	namedResolve(params) { return this.track(this.named.resolve(params)) }
	rename(params) { this.requireAdmission(); return this.track(this.named.rename(params)) }
	async sourceEvidence(source) {
		try {
			sourceRevision(source)
			if (!/^capture:[0-9a-f-]{36}$/.test(source.revision)) throw new Error()
			const record = await this.state.get("captures", source.revision.slice(8)), stored = record?.source
			const matches = stored && stored.ref.workspaceId === this.workspace.identity.workspaceId && stored.ref.workspaceEpoch === this.workspace.identity.workspaceEpoch && stored.ref.path === source.path && source.resourceId === source.path && source.root === "workspace" && stored.digest.sha256 === source.sha256
			if (this.captures.availability.state !== "available" || !matches || record.evictedAt) return { source, state: "unavailable" }
			const opened = await this.resolve(source); await opened.release()
			return { source, state: "available" }
		} catch (error) { return { source, state: error.reason === "integrity" || ["source_integrity", "artifact_integrity"].includes(error.error) ? "integrity-blocked" : "unavailable", ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}) } }
	}
	async artifactAvailability(link) {
		const record = await this.state.get("voxel-artifacts", link.artifactId)
		if (!record || canonicalJson(record.link) !== canonicalJson(link)) throw fail(404, "artifact_not_found", "No registration matches this complete artifact binding.")
		return this.registry.availability(record)
	}
	async artifactRecord(artifact) {
		strict(artifact, ["artifactId", "generation", "manifest"], "Artifact binding")
		const binding = revisionTarget({ voxelId: "binding", expectedHeadRevision: "binding", base: artifact }).base
		const record = await this.state.get("voxel-artifacts", binding.artifactId)
		if (!record || canonicalJson(record.link) !== canonicalJson(binding)) throw fail(404, "artifact_not_found", "This exact binding is not registered in the current workspace epoch.")
		return record
	}
	async artifactResolve({ artifactId, generation, manifest }) {
		identifier(artifactId, "artifactId")
		if ((generation === undefined) !== (manifest === undefined)) throw fail(400, "invalid_parameter", "Supply both generation and manifest bindings, or neither.")
		const record = await this.registry.get(artifactId)
		if (generation !== undefined && (generation !== record.manifest.generation || !record.link || canonicalJson(sourceRevision(manifest)) !== canonicalJson(record.link.manifest))) throw fail(409, "artifact_binding_changed", "The requested generation or manifest capture differs from the registration.")
		return { artifact: await this.registry.inspect(record) }
	}
	async resolveManifest({ source }) {
		const opened = await this.resolve(source)
		try {
			const bytes = await this.read(opened), manifest = await readManifest(bytes), record = await this.registry.get(manifest.artifactId)
			if (!record.link || manifest.generation !== record.manifest.generation || hash(bytes) !== record.link.manifest.sha256) throw fail(409, "artifact_binding_changed", "This wrapper's complete bytes do not match its registered manifest in the current epoch.")
			return { artifact: await this.registry.inspect(record), voxel: await this.named.headOf(record.link) }
		} finally { await opened.release() }
	}
	inspectArtifact({ artifact, options = {} }) { return this.track(this.artifactWork("inspect-artifact", artifact, options)) }
	materializeArtifact({ artifact, options = {} }) { return this.track(this.artifactWork("materialize-artifact", artifact, options)) }
	async artifactWork(action, binding, options) {
		const record = await this.artifactRecord(binding)
		await this.demandVerification(record)
		this.reserve(); const opened = []
		try {
			opened.push(...await this.registeredReaders(record, [record.link.manifest, ...Object.values(record.members).map((m) => m.source)]))
			const manifest = opened[0]
			const actual = await readManifest(await this.read(manifest))
			if (canonicalJson(actual) !== canonicalJson(record.manifest)) throw fail(409, "artifact_integrity", "The captured manifest differs from its immutable registration.")
			const members = {}
			Object.keys(record.members).forEach((role, n) => { members[role] = opened[n + 1].binding })
			const result = await this.worker({ action, manifest: manifest.binding, members, options })
			if (action === "materialize-artifact") return { ...result, base: record.link }
			return { ...result, artifact: record.link, sourceAvailability: await Promise.all(record.manifest.sourceRevisions.map((s) => this.sourceEvidence(s))) }
		} finally { try { for (const source of opened) await source.release() } finally { this.releaseCapacity() } }
	}
	async phase(op, phase, detail) { Object.assign(op, { phase, detail, updatedUtc: now() }); await this.save(op); await this.checkpoint(phase, op) }
	async run(op) {
		let opened
		try {
			await this.phase(op, "validating", "Checking the captured source and recipe.")
			opened = await this.resolve(sourceOf(op.submission))
			let data
			if (op.kind !== "import-metadata") data = { ...await this.tableInput(op.submission.recipe.scope, opened, false, op), action: op.kind === "indexed-grid" ? "indexed-grid" : "compute", materialize: true }
			else data = { binding: opened.binding, action: "import" }
			await this.phase(op, "generating", "Generating voxel arrays.")
			const result = await this.worker({ ...data, recipe: op.submission.recipe })
			if (result.errors?.length) throw fail(422, "validation_failed", result.errors.join(" "))
			if (op.kind === "indexed-grid" && (!result.scanComplete || !result.grid || result.blockingErrors?.length || !result.arrays)) throw fail(422, "validation_failed", result.blockingErrors?.join(" ") || "A complete valid indexed scan is required.")
			await this.phase(op, "publishing", "Publishing the complete voxel artifact.")
			const artifact = await this.publish(op, result)
			Object.assign(op, { artifact: artifact.link, statistics: result.statistics, error: null })
			await this.phase(op, "associating", "Voxel artifact saved; associating its named head.")
			await this.settleNamed(op)
		} catch (error) {
			const committed = await this.state.get("voxel-named-outcomes", op.id)
			if (committed) { Object.assign(op, committed.operation); return }
			const phase = op.phase
			const saved = op.artifact || (await this.state.list("voxel-artifacts")).find((a) => a.operationId === op.id && a.state === "ready")?.link
			Object.assign(op, { phase: saved ? "ready" : "failed", detail: safeReason(error), error: { phase, error: error.error || "voxel_failed", status: error.status || 500, message: safeReason(error), ...Object.fromEntries(["requiredBytes", "availableBytes", "action", "limits"].filter((key) => error[key] !== undefined).map((key) => [key, error[key]])) }, artifact: saved ?? null, named: { ...op.named, outcome: saved ? "unknown" : "failed" }, waitingFor: null, retryAt: null, updatedUtc: now() })
			try { await this.save(op) } catch (storageError) { this.workspace.logger.error?.("voxel receipt settlement failed", { operationId: op.id, error: storageError.message }) }
			for (const artifact of await this.state.list("voxel-artifacts")) if (artifact.operationId === op.id && artifact.state !== "ready") await this.incompleteArtifact(artifact, error)
		} finally {
			try {
				await opened?.release()
				const stored = await this.state.get("voxel-operations", op.id), artifact = (await this.state.list("voxel-artifacts")).find((a) => a.operationId === op.id)
				if (stored && terminal(stored) && (!artifact || ["ready", "failed"].includes(artifact.publicationState))) await this.releaseOperationHold(op)
			} catch (error) { this.workspace.logger.error?.("voxel source hold release failed", { operationId: op.id, error: error.message }) }
			finally { this.releaseCapacity() }
		}
	}
	async publish(op, result) {
		const filename = await this.manifestName(op.named.name)
		try { return await this.publishAs(op, result, filename) } finally { manifestNames.get(this.workspace).delete(filename) }
	}
	async publishAs(op, result, filename) {
		const artifactId = `vox-${crypto.randomUUID()}`, createdUtc = now(), members = {}
		const arrays = Object.entries(result.arrays).map(([role, bytes]) => {
			const sha256 = hash(bytes), id = crypto.randomUUID(), name = `${artifactId}.${role}.npy`
			members[role] = { source: { root: "workspace", resourceId: name, path: name, revision: `capture:${id}`, sha256 }, holdId: `voxel-art-${artifactId}-${role}` }
			return { role, dtype: role === "valid" ? "|u1" : role === "counts" || result.field.kind === "categorical" && role === "values" ? "<u4" : "<f8", sha256, contentId: `sha256:${sha256}`, byteLength: bytes.length }
		})
		const table = op.kind === "table-to-voxel", indexed = op.kind === "indexed-grid", recipe = op.submission.recipe
		const manifest = { format: "geocluster-voxel", schemaVersion: 1, artifactId, predecessor: recipe.predecessor, projectId: this.workspace.config.projectId || "", operationId: op.id, createdUtc, creation: { mode: table ? "binned-observations" : indexed ? "imported-grid" : "imported-volume", label: table ? "Binned observations — no interpolation" : indexed ? "Imported grid" : "Imported volume; aggregation unknown", algorithm: table ? "geocluster-binning-v1" : indexed ? "geocluster-indexed-v1" : "bounded-npy-v1", boundaryPolicy: "grid-snap-v2", accumulation: table ? "stable-source-order-float64" : "canonical-C-z-fastest", parsers: result.parsers, executionProfile: "runtime-worker-v1" }, sourceRevisions: op.sourceRevisions, grid: result.grid, field: result.field, arrays, recipe: { type: table ? "table-to-voxel" : indexed ? "indexed-grid" : "imported-volume", recipe }, statistics: result.statistics, warnings: result.warnings, assumptions: table ? recipeAssumptions(recipe) : indexed ? [] : recipe.defaults.map((field) => `${field} uses its recorded default.`) }
		manifest.generation = await manifestGeneration(manifest)
		const payload = Buffer.from(canonicalJson(manifest))
		if (payload.length > this.limits.memberBytes) throw fail(413, "manifest_limit", "The manifest exceeds the member byte ceiling. Select fewer categories or a smaller recipe.")
		await readManifest(payload)
		const uploadId = `voxel-publish-${crypto.randomUUID()}`, reservationId = crypto.randomUUID(), producerBinding = { workspaceEpoch: this.workspace.identity.workspaceEpoch, voxelOperationId: op.id, artifactId, manifestPath: filename, expectedSha256: hash(payload), expectedSize: payload.length }
		const artifact = { artifactId, operationId: op.id, state: "staging", publicationState: "staging", verificationState: "unchecked", manifest, members, filename, uploadId, reservationId, producerBinding, manifestHoldId: `voxel-art-${artifactId}-manifest`, link: null, createdUtc, recoveryPending: false }
		const reservation = { id: reservationId, artifactId, operationId: op.id, workspaceEpoch: this.workspace.identity.workspaceEpoch, createdAt: createdUtc, registryMetadataBytes: Buffer.byteLength(canonicalJson(artifact)) + 4096, entries: [...Object.entries(members).map(([role, member]) => ({ key: role, captureId: member.source.revision.slice(8), path: member.source.path, sha256: member.source.sha256, sizeBytes: result.arrays[role].length, metadataBytes: VOXEL_CAPTURE_METADATA_BYTES, converted: false })), { key: "manifest", captureId: null, path: filename, sha256: hash(payload), sizeBytes: payload.length, metadataBytes: VOXEL_CAPTURE_METADATA_BYTES, converted: false }] }
		await this.captures.reserveVoxel(reservation, this.limits.artifactRetainedBytes, [put("voxel-artifacts", artifactId, artifact)])
		await this.checkpoint("reserved", op)
		for (const [role, member] of Object.entries(members)) {
			const id = member.source.revision.slice(8), stage = await this.captures.staging(id, { reservationId, key: role })
			try {
				const bytes = result.arrays[role]; await this.captures.write(stage.handle, bytes, 0)
				await this.checkpoint(`staged-${role}`, op)
				const source = { kind: "runtime-capture", ref: this.workspace.ref(member.source.path), captureId: id, etag: `"capture-${id}"`, sizeBytes: bytes.length, consistency: "service-published", digest: { state: "ready", sha256: member.source.sha256 } }
				await this.captures.publish(stage, { id, kind: "capture", source, sourceObservation: null, sizeBytes: bytes.length, createdAt: now(), lastAccessAt: now() }, { hold: { id: member.holdId, reason: "voxel-artifact" }, reservationId })
				await this.checkpoint(`member-${role}`, op)
			} finally { await this.captures.cleanup(stage) }
		}
		// Verify the complete member set before making any manifest visible in the workspace.
		await this.verifyMembers(manifest, members)
		artifact.state = "publishing"; artifact.publicationState = "publishing"; await this.state.put("voxel-artifacts", artifactId, artifact)
		const published = await this.contention(op, "mutation", (wait) => this.workspace.uploadVoxel(Readable.from([payload]), { path: filename, operationId: artifact.uploadId, mode: "create", declaredSize: payload.length, declaredDigest: hash(payload), processingPolicy: "skip", producerBinding, reservationId, wait }))
		if (!this.ownsUpload(artifact, published.operation) || published.operation.state !== "committed" || !this.matchingSource(artifact, published.operation.publishedSource)) throw fail(409, "publication_ownership", "The manifest receipt does not prove this exact producer publication.")
		const manifestSource = published.operation.publishedSource
		await this.captures.hold("capture", manifestSource.captureId, "voxel-artifact", artifact.manifestHoldId)
		artifact.link = { artifactId, generation: manifest.generation, manifest: revision(manifestSource) }; artifact.state = "ready"; artifact.publicationState = "ready"; artifact.verificationState = "verified"
		await this.state.put("voxel-artifacts", artifactId, artifact)
		try { await this.storageUsage() } catch (error) { this.workspace.logger.warn?.("voxel usage refresh failed after artifact commit", { operationId: op.id, artifactId, error: error.message, action: "Retry capabilities or storage usage." }) }
		await this.checkpoint("registered", op)
		return this.registry.get(artifactId)
	}
	// The manifest is the voxel's workspace file: a root file named after the voxel,
	// numbered like a download when the name is taken. Names stay reserved in this
	// workspace until their save settles. Publication is create-only, so a file made
	// elsewhere with the same name in the meantime fails the save, never overwrites.
	async manifestName(name) {
		const reserved = manifestNames.get(this.workspace) ?? manifestNames.set(this.workspace, new Set()).get(this.workspace)
		for (let n = 1; n <= 100; n++) {
			const candidate = `${manifestStem(name)}${n === 1 ? "" : ` (${n})`}.voxel.json`
			if (reserved.has(candidate)) continue
			try { await this.workspace.safeFs.stat(candidate, { allowSymlink: true }); continue } catch (error) { if (error?.code !== "ENOENT" && error?.error !== "not_found") throw error }
			if (!reserved.has(candidate)) { reserved.add(candidate); return candidate }
		}
		const fallback = `${manifestStem(name)} ${crypto.randomUUID()}.voxel.json`
		reserved.add(fallback); return fallback
	}
	async verifyMembers(manifest, members, manifestSource, registration = null) {
		const opened = []
		try {
			if (registration) opened.push(...await this.registeredReaders(registration, [...Object.values(members).map((m) => m.source), manifestSource]))
			else for (const member of Object.values(members)) opened.push(await this.resolve(member.source))
			if (manifestSource) {
				const m = registration ? opened.at(-1) : await this.resolve(manifestSource); if (!registration) opened.push(m)
				const verified = await this.worker({ action: "verify", manifest: m.binding, members: Object.fromEntries(Object.keys(members).map((role, n) => [role, opened[n].binding])) })
				if (canonicalJson(verified.manifest) !== canonicalJson(manifest)) throw fail(409, "artifact_integrity", "Registered manifest bytes differ from the immutable artifact record.")
			} else {
				// The unregistered manifest stays in private staging until the worker verifies all members.
				const id = crypto.randomUUID(), payload = Buffer.from(canonicalJson(manifest)), stage = await this.captures.staging(id)
				try {
					await this.captures.write(stage.handle, payload, 0)
					await stage.handle.close(); stage.handle = await (await import("node:fs/promises")).open(stage.name, "r")
					await this.worker({ action: "verify", manifest: { fd: stage.handle.fd, size: payload.length, sha256: hash(payload) }, members: Object.fromEntries(Object.keys(members).map((role, n) => [role, opened[n].binding])) })
				} finally { await this.captures.cleanup(stage) }
			}
		} finally { for (const source of opened) await source.release() }
	}
	async recoverArtifact(artifact) {
		const { upload, committed } = await this.publicationEvidence(artifact)
		if (!committed) throw fail(503, "publication_interrupted", "Voxel publication lacks matching committed producer evidence.")
		const manifest = revision(upload.publishedSource)
		await this.verifyMembers(artifact.manifest, artifact.members, manifest)
		const recovered = await this.serial(async () => {
			const current = await this.registry.get(artifact.artifactId)
			if (this.verificationKey(current) !== this.verificationKey(artifact)) throw fail(409, "artifact_integrity", "Artifact binding changed during recovery.")
			if (!current.deletion) { await this.captures.hold("capture", upload.publishedSource.captureId, "voxel-artifact", artifact.manifestHoldId); for (const member of Object.values(artifact.members)) await this.captures.hold("capture", member.source.revision.slice(8), "voxel-artifact", member.holdId) }
			const ready = { ...current, state: "ready", publicationState: "ready", verificationState: "verified", verificationError: null, retryAt: null, recoveryPending: false, link: { artifactId: artifact.artifactId, generation: artifact.manifest.generation, manifest } }
			await this.captures.withRetention(async () => {
				const op = await this.state.get("voxel-operations", artifact.operationId), metadata = [put("voxel-artifacts", artifact.artifactId, ready)]
				if (op) { const settled = { ...op, phase: op.namedIntent ? "associating" : "ready", named: op.namedIntent ? { ...op.named, outcome: "unknown" } : op.named, artifact: ready.link, statistics: ready.manifest.statistics, error: null, waitingFor: null, retryAt: null, updatedUtc: now() }; metadata.push(put("voxel-operations", op.id, settled), put("voxel-keys", op.key, settled)); const hold = op.holdId && await this.state.get("holds", op.holdId); if (hold?.reason === "voxel-operation" && hold.source.kind === "capture" && `capture:${hold.source.id}` === op.sourceRevisions?.[0]?.revision) metadata.push({ type: "delete", kind: "holds", id: op.holdId }) }
				await this.state.transaction(metadata)
			}); return ready
		})
		const op = await this.state.get("voxel-operations", artifact.operationId); if (op?.namedIntent) await this.settleNamed(op)
		return recovered
	}
	matchingSource(a, source) {
		const b = a.producerBinding
		return Boolean(b && source?.kind === "runtime-capture" && /^([0-9a-f-]{36})$/.test(source.captureId || "") && source.ref?.workspaceId === this.workspace.identity.workspaceId && source.ref?.workspaceEpoch === b.workspaceEpoch && source.ref?.path === b.manifestPath && source.digest?.state === "ready" && source.digest.sha256 === b.expectedSha256 && source.sizeBytes === b.expectedSize && (!a.link || canonicalJson(a.link.manifest) === canonicalJson(revision(source))))
	}
	ownsUpload(a, upload) {
		const b = a.producerBinding, intent = upload?.intent
		return Boolean(b && b.workspaceEpoch === this.workspace.identity.workspaceEpoch && b.voxelOperationId === a.operationId && b.artifactId === a.artifactId && b.manifestPath === a.filename && upload?.operationId === a.uploadId && upload.action === "upload" && intent?.action === "upload" && canonicalJson(intent.producerBinding) === canonicalJson(b) && intent.path === a.filename && intent.mode === "create" && intent.processingPolicy === "skip" && intent.declaredSize === b.expectedSize && intent.declaredDigest === b.expectedSha256 && upload.addresses?.length === 1 && canonicalJson(upload.addresses[0]) === canonicalJson(this.workspace.ref(a.filename)))
	}
	async publicationEvidence(artifact) {
		const upload = await this.state.get("operations", artifact.uploadId), owned = this.ownsUpload(artifact, upload), publications = await this.state.list("source-publications"), ids = new Set(Object.values(artifact.members).map((m) => m.source.revision.slice(8)))
		const candidates = publications.filter((p) => ids.has(p.id) || p.reservationId === artifact.reservationId), uncertainKeys = candidates.filter((p) => ["publishing", "indeterminate"].includes(p.state) || p.cleanupPending).map((p) => p.reservationBinding?.key || Object.entries(artifact.members).find(([, m]) => m.source.revision.slice(8) === p.id)?.[0]).filter(Boolean)
		const uploadUnknown = owned && ["publishing", "indeterminate"].includes(upload.state), committed = owned && upload.state === "committed" && this.matchingSource(artifact, upload.publishedSource), contradiction = owned && upload.state === "committed" && !committed
		if (uploadUnknown || contradiction) uncertainKeys.push("manifest")
		return { upload, owned, committed, ownershipConflict: Boolean(upload && !owned), uncertain: Boolean(uploadUnknown || contradiction || uncertainKeys.length), uncertainKeys: [...new Set(uncertainKeys)] }
	}
	async persistenceInterest(upload) {
		try { return this.workspace.persistence?.sourceInterest ? await this.workspace.persistence.sourceInterest(upload) : { needed: true, blocker: "persistenceEvidence" } } catch (error) { this.workspace.logger.warn?.("voxel persistence proof unavailable", { operationId: upload.operationId, error: error.message }); return { needed: true, blocker: "persistenceEvidence" } }
	}
	async reconcilePublications() {
		for (const a of await this.state.list("voxel-artifacts")) {
			if (this.tasks.has(a.operationId) || a.recoveryPending || a.publicationState !== "unresolved") continue
			const ids = new Set([...Object.values(a.members).map((m) => m.source.revision.slice(8)), ...(await this.state.list("source-publications")).filter((p) => p.reservationId === a.reservationId).map((p) => p.id)])
			await this.captures.withRetention(() => this.captures.recoverPublications(ids))
			const upload = await this.state.get("operations", a.uploadId)
			if (this.ownsUpload(a, upload) && !["committed", "failed", "aborted-before-publication"].includes(upload.state)) await this.inspectUploadEvidence(a, ["accepted", "streaming", "staged"].includes(upload.state) && !upload.effectApplied ? "proven-abort" : "confirmed-commit", `automatic-${a.artifactId}`)
			const evidence = await this.publicationEvidence(a)
			if (evidence.uncertain) continue
			if (evidence.committed) {
				const current = await this.registry.get(a.artifactId), recovered = { ...current, state: "publishing", publicationState: "publishing", recoveryPending: true, link: { artifactId: a.artifactId, generation: a.manifest.generation, manifest: revision(evidence.upload.publishedSource) } }
				const op = await this.state.get("voxel-operations", a.operationId), pending = op && { ...op, phase: "publishing", artifact: recovered.link, named: { ...op.named, outcome: "unknown" }, waitingFor: "artifactVerification", retryAt: null, updatedUtc: now() }
				await this.state.transaction([put("voxel-artifacts", a.artifactId, recovered), ...(pending ? [put("voxel-operations", op.id, pending), put("voxel-keys", op.key, pending)] : [])]); this.recoveryQueue.push(a.artifactId); this.scheduleVerification()
			} else await this.incompleteArtifact(a, fail(503, "publication_aborted", "Automatic reconciliation proved no publication."))
			this.log("voxel publication automatically reconciled", { operationId: a.operationId, artifactId: a.artifactId, publicationId: a.uploadId, reason: "exact-producer-and-expected-object-proof", outcome: evidence.committed ? "committed" : "proven-abort" })
		}
	}
	async reconcileReservation(artifact) { if (artifact.reservationId && !this.tasks.has(artifact.operationId)) { const evidence = await this.publicationEvidence(artifact); await this.captures.releaseVoxelReservation(artifact.reservationId, evidence.uncertainKeys) } }
	async restoreArtifactHolds(a) {
		const evidence = await this.publicationEvidence(a), bindings = Object.values(a.members).map((m) => [m.holdId, m.source]); if (evidence.committed) bindings.push([a.manifestHoldId, revision(evidence.upload.publishedSource)])
		await this.captures.withRetention(async () => {
			if ((await this.registry.get(a.artifactId)).deletion) return
			const metadata = []
			for (const [holdId, source] of bindings) { const id = source.revision.slice(8), record = await this.state.get("captures", id), publication = await this.state.get("source-publications", id), candidate = record?.source || publication?.source; if (!candidate || candidate.ref?.workspaceEpoch !== this.workspace.identity.workspaceEpoch || canonicalJson(revision(candidate)) !== canonicalJson(source)) continue; const prior = await this.state.get("holds", holdId); if (prior && (prior.reason !== "voxel-artifact" || prior.source.kind !== "capture" || prior.source.id !== id)) throw fail(409, "publication_ownership", "Artifact hold belongs to another retained source."); if (!prior) metadata.push(put("holds", holdId, { holdId, source: { kind: "capture", id }, reason: "voxel-artifact", createdAt: now() })) }
			await this.state.transaction(metadata)
		})
	}
	async incompleteArtifact(artifact, error) {
		const evidence = await this.publicationEvidence(artifact), unresolved = evidence.uncertain || evidence.committed, current = await this.registry.get(artifact.artifactId)
		await this.state.put("voxel-artifacts", artifact.artifactId, { ...current, state: unresolved ? "unresolved" : "failed", publicationState: unresolved ? "unresolved" : "failed", error: { error: evidence.ownershipConflict ? "publication_ownership" : error.error || "publication_interrupted", message: error.message } })
		if (!unresolved) {
			await this.captures.releaseBoundHolds(Object.values(artifact.members).map((m) => ({ holdId: m.holdId, reason: "voxel-artifact", source: { kind: "capture", id: m.source.revision.slice(8) } })))
			const op = await this.state.get("voxel-operations", artifact.operationId)
			if (op && !terminal(op)) await this.save({ ...op, phase: "failed", named: { ...op.named, outcome: "failed" }, artifact: null, detail: safeReason(error), error: { phase: op.phase, error: error.error || "publication_interrupted", message: safeReason(error) }, waitingFor: null, retryAt: null, updatedUtc: now() })
		}
		await this.reconcileReservation(current)
	}
	verificationKey(a) { return canonicalJson({ workspaceEpoch: this.workspace.identity.workspaceEpoch, artifactId: a.artifactId, generation: a.manifest.generation, manifest: a.link?.manifest, members: a.members }) }
	scheduleVerification() {
		if (this.verificationPump || this.closed) return
		this.verificationPump = setImmediate(() => { this.verificationPump = null; this.track(this.pumpVerification()).catch((error) => this.workspace.logger.error?.("voxel verification dispatch failed", { error: error.message })) })
	}
	async pumpVerification() {
		if (this.closed || this.active >= this.limits.workers) return
		let job
		try { await this.serial(async () => {
			if (this.closed || this.active >= this.limits.workers) return
			if (this.recoveryStarted && this.recoveryQueue.length) {
				const id = this.recoveryQueue.shift(); job = { key: null, artifactId: id, kind: "recovery", binding: null, active: false }; const a = await this.registry.get(id)
				if (a.recoveryPending) { const key = this.verificationKey(a); if (!this.verifications.has(key)) { Object.assign(job, { key, binding: a }); this.verifications.set(key, job) } else job = null } else job = null
			} else if (!this.draining && !this.workspace.draining) job = this.verificationQueue.shift()
			if (!job) return
			const a = await this.registry.get(job.artifactId)
			if (a.deletion && job.kind !== "recovery" || this.verificationKey(a) !== job.key) { this.verifications.delete(job.key); job = null; return }
			await this.captures.withRetention(async () => { const current = await this.registry.get(a.artifactId); if (current.deletion && job.kind !== "recovery") { this.verifications.delete(job.key); job = null; return }; job.active = true; this.active++; await this.state.put("voxel-artifacts", current.artifactId, { ...current, verificationState: "checking", retryAt: null }) })
		}) } catch (error) { try { if (job) { this.verifications.delete(job.key); if (job.active) this.releaseCapacity(); await this.verificationFailure(job, error, true) } } finally { this.scheduleRecoveryRetry(job); this.scheduleVerification() }; return }
		if (job) job.promise = this.track(this.verifyJob(job))
		if ((this.recoveryStarted && this.recoveryQueue.length || !this.draining && this.verificationQueue.length) && this.active < this.limits.workers) this.scheduleVerification()
	}
	async verifyJob(job) {
		try {
			if (job.kind === "recovery") { await this.recoverArtifact(job.binding); this.recoveryRetryAttempts.delete(job.artifactId) }
			else { await this.verifyMembers(job.binding.manifest, job.binding.members, job.binding.link.manifest, job.binding); await this.serial(async () => { const a = await this.registry.get(job.artifactId); if (!a.deletion && this.verificationKey(a) === job.key) await this.state.put("voxel-artifacts", a.artifactId, { ...a, verificationState: "verified", verificationError: null, retryAt: null, verificationFailures: 0 }) }) }
		} catch (error) { await this.verificationFailure(job, error) }
		finally { this.verifications.delete(job.key); this.releaseCapacity(); this.scheduleRecoveryRetry(job); await this.cleanupArtifacts() }
	}
	async verificationFailure(job, error, dispatch = false) {
		const integrity = !dispatch && artifactIntegrityError(error)
		if (job.kind === "recovery" && !integrity) { const attempts = (this.recoveryRetryAttempts.get(job.artifactId) || 0) + 1; this.recoveryRetryAttempts.set(job.artifactId, attempts); job.retryRecoveryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(5, attempts - 1)) }
		await this.serial(async () => {
			const a = await this.registry.get(job.artifactId)
			if (a.deletion && job.kind !== "recovery" || job.key && this.verificationKey(a) !== job.key || job.kind === "recovery" && !a.recoveryPending) { job.retryRecoveryAt = null; return }
			if (!job.key) Object.assign(job, { key: this.verificationKey(a), binding: a })
			const failures = (a.verificationFailures || 0) + 1, retryAt = integrity ? null : new Date(Date.now() + Math.min(30000, 1000 * 2 ** Math.min(5, failures - 1))).toISOString(), stoppedRecovery = job.kind === "recovery" && integrity
			const updated = { ...a, ...(stoppedRecovery ? { state: "failed", publicationState: "failed", publicationOutcome: "committed", recoveryPending: false } : {}), verificationState: integrity ? "integrity-blocked" : "temporarily-unavailable", verificationError: { error: error.error || "verification_unavailable", classification: integrity ? "integrity" : "transient", message: safeReason(error) }, verificationFailures: failures, retryAt }
			const op = stoppedRecovery && await this.state.get("voxel-operations", a.operationId), failed = op && op.phase !== "ready" ? { ...op, phase: "failed", detail: "Artifact recovery found an integrity contradiction. Inspect retained evidence or delete the registration.", named: { ...op.named, outcome: "failed" }, error: { phase: op.phase, error: "artifact_integrity", status: 409, message: safeReason(error) }, artifact: null, waitingFor: null, retryAt: null, updatedUtc: now() } : null
			await this.state.transaction([put("voxel-artifacts", a.artifactId, updated), ...(failed ? [put("voxel-operations", op.id, failed), put("voxel-keys", op.key, failed)] : [])])
		})
	}
	scheduleRecoveryRetry(job) {
		if (!job?.retryRecoveryAt || this.closed || this.draining || this.recoveryQueue.includes(job.artifactId) || [...(this.recoveryTimers || [])].some((timer) => timer.artifactId === job.artifactId)) return
		const timer = setTimeout(() => { this.recoveryTimers.delete(timer); if (!this.closed) { this.recoveryQueue.push(job.artifactId); this.scheduleVerification() } }, Math.max(0, job.retryRecoveryAt - Date.now()))
		timer.artifactId = job.artifactId; this.recoveryTimers ||= new Set(); this.recoveryTimers.add(timer); timer.unref?.()
	}
	dropVerification(id) {
		this.recoveryRetryAttempts.delete(id)
		this.verificationQueue = this.verificationQueue.filter((job) => { if (job.artifactId !== id) return true; if (!job.active) this.verifications.delete(job.key); return false })
		// Keep accepted recovery: deletion closes access, not true publication evidence.
	}
	async demandVerification(a) {
		return this.serial(async () => {
			a = await this.registry.get(a.artifactId)
			if (a.deletion) throw fail(410, "artifact_deleted", "This artifact registration was deleted.")
			if (a.verificationState === "integrity-blocked") throw Object.assign(fail(409, "artifact_integrity", "Artifact integrity is blocked. Inspect evidence or delete this registration."), { availability: this.registry.availability(a) })
			if (a.publicationState === "ready" && a.verificationState === "verified") return a
			this.requireAdmission()
			if (a.publicationState !== "ready") throw Object.assign(fail(503, "artifact_verifying", "Artifact publication recovery is pending."), { retryAfter: 1, availability: this.registry.availability(a) })
			const key = this.verificationKey(a)
			if (!this.verifications.has(key) && (!a.retryAt || Date.parse(a.retryAt) <= Date.now())) {
				if (this.verificationQueue.length >= this.limits.verificationQueueSize) throw Object.assign(fail(429, "capacity", "The bounded verification queue is full."), { retryAfter: 1, availability: this.registry.availability(a) })
				const job = { key, artifactId: a.artifactId, kind: "demand", binding: a, active: false }; this.verifications.set(key, job); this.verificationQueue.push(job); a = { ...a, verificationState: "checking", retryAt: null }
				try { await this.state.put("voxel-artifacts", a.artifactId, a) } catch (error) { this.verifications.delete(key); this.verificationQueue = this.verificationQueue.filter((j) => j !== job); throw error }
				this.scheduleVerification()
			}
			throw Object.assign(fail(503, "artifact_verifying", a.retryAt ? "Artifact verification is temporarily unavailable. Retry after the indicated time." : "The complete artifact is being verified. Retry this read shortly."), { retryAfter: a.retryAt ? Math.max(1, Math.ceil((Date.parse(a.retryAt) - Date.now()) / 1000)) : 1, availability: this.registry.availability(a) })
		})
	}
	async publicOperation(op) { const a = op.artifact?.artifactId ? await this.state.get("voxel-artifacts", op.artifact.artifactId) : (await this.state.list("voxel-artifacts")).find((a) => a.operationId === op.id); return { ...publicOp(op), ...(a ? { availability: this.registry.availability(a) } : {}) } }
	async operation(id) { identifier(id, "operation id"); let op = await this.state.get("voxel-operations", id); if (!op) throw fail(404, "operation_not_found", "No voxel operation has this ID in the current workspace epoch."); if (op.artifact && op.named?.outcome === "unknown" && !this.tasks.has(id) && (await this.registry.get(op.artifact.artifactId)).publicationState === "ready") op = await this.settleNamed(op); return this.publicOperation(op) }
	async list(params) {
		if (params.resourceId) canonicalPath(params.resourceId, { root: false })
		if (params.idempotencyKey) { identifier(params.idempotencyKey, "idempotencyKey"); const op = await this.state.get("voxel-keys", params.idempotencyKey); return op ? [await this.publicOperation(op)] : [] }
		return Promise.all((await this.state.list("voxel-operations")).filter((op) => op.sourceRevisions.some((s) => s.resourceId === params.resourceId)).sort((a, b) => b.acceptedUtc.localeCompare(a.acceptedUtc)).map((op) => this.publicOperation(op)))
	}
	artifact(id) { return this.registry.get(id).then((a) => this.registry.inspect(a)) }
	artifacts(params) { return this.registry.inventory(params) }
	deleteArtifact(id, input, requester) { return this.registry.delete(id, input, requester) }
	cleanupArtifacts() { return this.track(this.serial(() => this.registry.cleanup())) }
	releaseUnreferenced() { return this.registry.releaseUnreferenced().catch((error) => this.workspace.logger.error?.("voxel release failed", { agent: "voxel-service", tool: "voxel-release", action: "Inspect workspace voxel files and retained artifacts.", error: error.message })) }
	async storageUsage() {
		const usage = await this.captures.voxelUsage(), shared = await this.captures.retainedUsage(await this.captures.retainedRecords(), await this.state.list("source-publications"))
		this.retention = { ...usage, artifactRetainedBytes: this.limits.artifactRetainedBytes, artifactFreeBytes: Math.max(0, this.limits.artifactRetainedBytes - usage.totalBytes), overArtifactBudget: usage.totalBytes > this.limits.artifactRetainedBytes, sharedRetainedBytes: this.captures.limits.retainedBytes, sharedUsedBytes: shared.retainedBytes, sharedFreeBytes: Math.max(0, this.captures.limits.retainedBytes - shared.retainedBytes) }; return this.retention
	}
	async inspectUploadEvidence(a, decision, auditId) {
		const upload = await this.state.get("operations", a.uploadId)
		if (!this.ownsUpload(a, upload) || ["committed", "failed", "aborted-before-publication"].includes(upload.state)) return
		if (decision === "proven-abort" && ["accepted", "streaming", "staged"].includes(upload.state) && !upload.effectApplied) { await this.workspace.saveOperation(upload, "aborted-before-publication", { finishedAt: now(), voxelReconciliationId: auditId, error: { error: "publication_aborted", message: "Producer inspection proved no namespace dispatch." } }); await this.workspace.processing.releaseFailedUpload(upload); return }
		if (decision !== "confirmed-commit" || !this.matchingSource(a, upload.publishedSource) || upload.evidence?.path !== a.filename || !upload.evidence.candidate || !upload.evidence.parent) return
		const proof = await this.workspace.locks.run(async () => { if (!await this.workspace.safeFs.prove(a.filename, upload.evidence.candidate, upload.evidence.parent)) return null; const stat = await this.workspace.safeFs.stat(a.filename); return { publishedObservation: sameObject(stat, upload.evidence.candidate) && Number(stat.size) === upload.evidence.sizeBytes && String(stat.mtimeNs) === upload.evidence.mtimeNs ? observation(this.workspace.ref(a.filename), stat) : null } })
		if (!proof) return
		const pinned = await this.resolve(revision(upload.publishedSource)); await pinned.release()
		await this.workspace.commitUpload(upload, proof.publishedObservation, { recovered: true, reconciledVoxelArtifact: a.artifactId, voxelReconciliationId: auditId })
	}
	async reconcileArtifact(input) {
		strict(input, ["artifactId", "generation", "decision", "uploadId", "captureIds", "reason"], "Artifact reconciliation")
		if (!["confirmed-commit", "proven-abort"].includes(input.decision) || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1024 || !Array.isArray(input.captureIds) || input.captureIds.length > 5 || new Set(input.captureIds).size !== input.captureIds.length) throw fail(400, "invalid_request", "Reconciliation requires a bounded audit reason and exact inspected upload/capture IDs.")
		return this.track(this.serial(async () => {
			let a = await this.registry.get(input.artifactId)
			if (input.generation !== a.manifest.generation) throw fail(409, "artifact_generation_conflict", "Reconciliation generation does not match registration.")
			if (this.verifications.get(this.verificationKey(a))?.active || this.tasks.has(a.operationId)) throw fail(409, "artifact_busy", "Live publication cannot be reconciled externally.")
			const reservation = await this.state.get("voxel-reservations", a.reservationId), expected = [...Object.values(a.members).map((m) => m.source.revision.slice(8)), ...(reservation?.entries || []).map((e) => e.captureId).filter(Boolean), ...(await this.state.list("voxel-owned-captures")).filter((e) => e.artifactId === a.artifactId).map((e) => e.captureId), ...(await this.state.list("source-publications")).filter((p) => p.reservationId === a.reservationId).map((p) => p.id)], ids = [...new Set(expected)].sort()
			if (input.uploadId !== a.uploadId || canonicalJson([...input.captureIds].sort()) !== canonicalJson(ids)) throw fail(409, "reconciliation_evidence", "Inspected upload/capture IDs must exactly match retained candidates.")
			const inspection = { id: crypto.randomUUID(), workspaceEpoch: this.workspace.identity.workspaceEpoch, artifactId: a.artifactId, generation: a.manifest.generation, decision: input.decision, uploadId: a.uploadId, captureIds: ids, reason: input.reason, requestedUtc: now(), status: "inspecting" }; await this.state.put("voxel-reconciliations", inspection.id, inspection)
			await this.captures.withRetention(() => this.captures.recoverPublications(new Set(ids))); await this.inspectUploadEvidence(a, input.decision, inspection.id)
			const evidence = await this.publicationEvidence(a)
			if (evidence.uncertain || input.decision === "confirmed-commit" && !evidence.committed || input.decision === "proven-abort" && (a.link || evidence.committed || evidence.owned && !["failed", "aborted-before-publication"].includes(evidence.upload.state))) { await this.state.put("voxel-reconciliations", inspection.id, { ...inspection, status: "ambiguous", inspectedUtc: now() }); throw fail(409, "reconciliation_ambiguous", "Retained evidence cannot prove the requested outcome. Capacity and evidence remain retained.") }
			const audit = { ...inspection, status: "confirmed", inspectedUtc: now(), uploadState: evidence.upload?.state || "absent", producerOwned: evidence.owned }
			a = { ...await this.registry.get(a.artifactId), reconciliation: audit, recoveryPending: input.decision === "confirmed-commit", state: input.decision === "confirmed-commit" ? "publishing" : "failed", publicationState: input.decision === "confirmed-commit" ? "publishing" : "failed", verificationState: "unchecked", verificationError: null, retryAt: null }
			if (evidence.committed) a.link = { artifactId: a.artifactId, generation: a.manifest.generation, manifest: revision(evidence.upload.publishedSource) }
			await this.state.transaction([put("voxel-reconciliations", audit.id, audit), put("voxel-artifacts", a.artifactId, a)]); this.dropVerification(a.artifactId); await this.reconcileReservation(a)
			if (input.decision === "proven-abort") { await this.incompleteArtifact(a, fail(503, "publication_aborted", "Inspection proved no publication.")); const op = await this.state.get("voxel-operations", a.operationId); if (op?.holdId && terminal(op)) await this.releaseOperationHold(op) }
			if (a.recoveryPending) { this.recoveryQueue.push(a.artifactId); this.scheduleVerification() }
			if (a.deletion) await this.registry.cleanupOne(a)
			return { reconciliation: audit, artifact: await this.registry.inspect(a) }
		}))
	}
	async bytes(params) {
		let source
		if (params.source) source = parsedSource(params.source)
		else {
			const manifest = parsedSource(params.manifest)
			const artifact = (await this.state.list("voxel-artifacts")).find((a) => canonicalJson(a.link?.manifest) === canonicalJson(manifest))
			if (!artifact) throw fail(404, "artifact_not_found", "This manifest capture is not a registered ready voxel artifact. Open a published voxel manifest from this workspace.")
			await this.demandVerification(artifact)
			const descriptor = artifact.manifest.arrays.find((a) => a.role === params.role), registered = artifact.members[params.role]
			if (!descriptor || !registered) throw fail(404, "member_not_found", "The registered manifest does not contain this array role.")
			const opened = []
			try {
				opened.push(...await this.registeredReaders(artifact, [manifest, registered.source]))
				const actual = await readManifest(await this.read(opened[0])); if (canonicalJson(actual) !== canonicalJson(artifact.manifest) || registered.source.sha256 !== descriptor.sha256) throw fail(409, "artifact_integrity", "The manifest or member differs from immutable registration.")
				return await this.read(opened[1])
			} catch (error) {
				if (artifactIntegrityError(error)) { await this.serial(async () => { const current = await this.registry.get(artifact.artifactId); if (!current.deletion) await this.state.put("voxel-artifacts", current.artifactId, { ...current, verificationState: "integrity-blocked", verificationError: { error: error.error, classification: "integrity", message: safeReason(error) }, retryAt: null }) }); throw fail(409, "artifact_integrity", "Protected bytes contradict the immutable binding. Inspect evidence or delete the registration.") }; throw error
			} finally { for (const reader of opened) await reader.release() }
		}
		const opened = await this.resolve(source)
		try { return await this.read(opened) } finally { await opened.release() }
	}
	async read(opened) {
		if (opened.source.sizeBytes > this.limits.memberBytes) throw fail(413, "member_limit", "The requested capture exceeds the voxel member byte ceiling. Select a smaller source.")
		const bytes = await this.captures.readPrefix(opened.handle, opened.source.sizeBytes)
		if (bytes.length !== opened.source.sizeBytes || hash(bytes) !== opened.revision.sha256) throw fail(409, "source_integrity", "Protected bytes differ from their recorded digest. Capture the source again or inspect retained artifact storage.")
		return bytes
	}
	async handle(req, res, url) {
		if (!voxelFamily(url.pathname)) return false
		try {
			const fence = workspaceFenceError(req, this.workspace.identity); if (fence) throw fail(fence.status, fence.error, fence.message)
			const origin = voxelOriginError(req, this.workspace.config.allowedOrigins || gate.parseAllowedOrigins()); if (origin) throw origin
			if (!voxelPath(url.pathname)) throw fail(404, "not_found", "Unknown voxel route. Use the voxel capabilities, named, artifact, operation or member routes.")
			if (url.pathname === "/voxels" && req.method === "GET") {
				const params = query(url, ["resourceId", "idempotencyKey"])
				if (Object.keys(params).length > 1) throw fail(400, "invalid_parameter", "Choose either resourceId or idempotencyKey discovery.")
				if (!Object.keys(params).length && this.captures.availability.state === "available") await this.storageUsage()
				json(res, 200, Object.keys(params).length ? { operations: await this.list(params) } : this.capabilities()); return true
			}
			if (url.pathname === "/voxels" && req.method === "POST") {
				query(url, []); this.requireAdmission(); const body = await jsonBody(req)
				if (body.action === "describe") { strict(body, ["action", "input", "range", "headerRows"], "Description"); json(res, 200, await this.describe(body.input, body.range, body.headerRows)) }
				else if (body.action === "validate") { if (Object.hasOwn(body, "submission")) { strict(body, ["action", "submission"], "Validation"); json(res, 200, await this.validateSubmission(body.submission)) } else { strict(body, ["action", "recipe"], "Validation"); json(res, 200, await this.validate(body.recipe)) } }
				else if (body.action === "scan-indices") { strict(body, ["action", "scope", "indices", "numbers"], "Index scan"); const { action, ...scan } = body; json(res, 200, await this.scanIndices(scan)) }
				else if (body.action === "named-list") { strict(body, ["action", "limit", "cursor", "name"], "Named list"); json(res, 200, await this.namedList(body)) }
				else if (body.action === "named-resolve") { const keys = Object.keys(body); if (keys.some((k) => !["action", "voxelId", "name"].includes(k))) throw fail(400, "invalid_request", "Named resolution accepts voxelId or name."); json(res, 200, { voxel: await this.namedResolve(body) }) }
				else if (body.action === "rename") { strict(body, ["action", "voxelId", "name", "expectedHeadRevision"], "Rename"); const { action, ...params } = body; json(res, 200, { voxel: await this.rename(params) }) }
				else if (["inspect", "materialize"].includes(body.action)) { strict(body, ["action", "artifact", "options"], "Artifact request"); json(res, 200, await (body.action === "inspect" ? this.inspectArtifact(body) : this.materializeArtifact(body))) }
				else if (body.action === "resolve-manifest") { strict(body, ["action", "source"], "Manifest resolution"); json(res, 200, await this.resolveManifest(body)) }
				else if (body.action === "submit") { strict(body, ["action", "submission", "idempotencyKey"], "Submission"); const result = await this.submit(body.submission, body.idempotencyKey); json(res, result.status, { operation: result.operation }) }
				else throw fail(400, "invalid_action", "Choose describe, validate, scan-indices, submit, named-list, named-resolve, rename, inspect, materialize or resolve-manifest.")
				return true
			}
			if (url.pathname.startsWith("/voxels/artifacts/") && req.method === "DELETE") { query(url, []); this.requireAdmission(); const result = await this.deleteArtifact(decodedId(url.pathname.slice(18)), await jsonBody(req)); json(res, result.status, { deletion: result.deletion }); return true }
			if (req.method !== "GET") throw fail(405, "method", "Use GET for reads, POST /voxels for actions and DELETE /voxels/artifacts/:id for exact deletion.")
			if (url.pathname === "/voxels/artifacts") { json(res, 200, await this.artifacts(query(url, ["cursor", "limit"]))); return true }
			if (url.pathname === "/voxels/named") { const params = query(url, ["limit", "cursor", "name"]); if (params.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(params.limit)) throw fail(400, "invalid_parameter", "limit must be an integer from 1 to 100."); json(res, 200, await this.namedList({ ...params, ...(params.limit ? { limit: Number(params.limit) } : {}) })); return true }
			if (url.pathname.startsWith("/voxels/named/")) { query(url, []); json(res, 200, { voxel: await this.namedResolve({ voxelId: decodedId(url.pathname.slice(14)) }) }); return true }
			if (url.pathname.startsWith("/voxels/artifacts/")) { const params = query(url, ["generation", "manifest"]); json(res, 200, await this.artifactResolve({ artifactId: decodedId(url.pathname.slice(18)), ...params, ...(params.manifest ? { manifest: parsedSource(params.manifest) } : {}) })); return true }
			if (url.pathname.startsWith("/voxels/operations/")) { query(url, []); let id; try { id = decodeURIComponent(url.pathname.slice(19)) } catch { throw fail(400, "invalid_parameter", "Operation ID must use valid transport encoding.") }; json(res, 200, { operation: await this.operation(id) }); return true }
			const params = query(url, ["source", "manifest", "role"])
			if (!(params.source && Object.keys(params).length === 1 || params.manifest && params.role && Object.keys(params).length === 2 && ["values", "valid", "counts", "weights"].includes(params.role))) throw fail(400, "invalid_parameter", "Supply source=JSON(SourceRevision), or manifest=JSON(SourceRevision) and one array role.")
			const bytes = await this.bytes(params); res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length, "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(bytes)
		} catch (error) { if (res.headersSent) res.destroy(); else { if (error.retryAfter !== undefined) res.setHeader("retry-after", String(error.retryAfter)); json(res, error.status || 500, { ...fail(error.status || 500, error.error || "voxel_failed", safeReason(error)).toJSON(), ...Object.fromEntries(["retryAfter", "retryAt", "requiredBytes", "availableBytes", "action", "limits"].filter((k) => error[k] !== undefined).map((k) => [k, error[k]])), ...(error.availability ? { availability: error.availability } : {}) }) } }
		return true
	}
	async drain(deadline) {
		this.draining = true; await this.admissionTail
		for (const job of this.verificationQueue) { this.verifications.delete(job.key); const a = await this.registry.get(job.artifactId); if (!a.deletion) await this.state.put("voxel-artifacts", a.artifactId, { ...a, verificationState: "unchecked" }) }; this.verificationQueue = []
		let timer
		try { const timeout = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now())) }); while (this.pending.size && Date.now() < Date.parse(deadline)) await Promise.race([Promise.allSettled([...this.pending]), timeout]) } finally { clearTimeout(timer) }
		const ops = await this.state.list("voxel-operations"), localPending = this.pending.size + ops.filter((op) => !terminal(op) && !this.tasks.has(op.id)).length
		const artifacts = await this.state.list("voxel-artifacts"), deletions = await this.state.list("voxel-deletions"), uncertainArtifacts = artifacts.filter((a) => a.publicationState === "unresolved"), publicationEvidenceIds = []
		for (const a of uncertainArtifacts) { const evidence = await this.publicationEvidence(a), ids = []; if (evidence.owned && ["publishing", "indeterminate"].includes(evidence.upload.state)) ids.push(`operation:${a.uploadId}`); for (const p of await this.state.list("source-publications")) if (["publishing", "indeterminate"].includes(p.state) && p.reservationId === a.reservationId) ids.push(`capture:${p.id}`); publicationEvidenceIds.push(...(ids.length ? ids : [`artifact:${a.artifactId}`])) }
		const cleanupUncertainty = new Set([...deletions.filter((d) => d.cleanupPending && d.indeterminate && !d.blockers.includes("publicationReconciliation")).map((d) => d.artifactId), ...(await this.state.list("voxel-reservations")).filter((r) => r.entries.some((e) => e.cleanupState === "indeterminate")).map((r) => r.artifactId), ...(await this.state.list("voxel-owned-captures")).filter((e) => e.cleanupIndeterminate && !e.reclaimedAt).map((e) => e.artifactId)]).size
		const recoveryPending = artifacts.filter((a) => a.recoveryPending).length, pending = Math.max(localPending, recoveryPending), publicationUncertainty = uncertainArtifacts.length, indeterminate = publicationUncertainty + cleanupUncertainty, cleanupPending = deletions.filter((d) => d.cleanupPending).length
		return { localPending: pending, indeterminate, publicationUncertainty, publicationIds: uncertainArtifacts.map((a) => a.uploadId), publicationEvidenceIds: [...new Set(publicationEvidenceIds)], cleanupUncertainty, cleanupPending, retainedVolumeRequired: cleanupPending > 0 || indeterminate > 0, failed: ops.filter((op) => op.phase === "failed").length, complete: !pending && !indeterminate, gauges: this.gauges() }
	}
	async close() { this.draining = true; this.closed = true; clearImmediate(this.verificationPump); clearImmediate(this.cleanupPump); this.verificationPump = null; this.cleanupPump = null; for (const timer of this.recoveryTimers || []) clearTimeout(timer); await this.admissionTail; this.verificationQueue = []; this.recoveryQueue = []; while (this.pending.size) await Promise.allSettled([...this.pending]) }
}
