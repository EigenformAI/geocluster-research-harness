import crypto from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { setImmediate as yieldTurn } from "node:timers/promises"
import { FILE_ID_PATTERN, FileError, budget, canonicalPath, identifier, stableStringify } from "./file-contract.js"
import { PreprocessingClient } from "./preprocessing-client.js"
import { cloudError, historicalReceipt, stableId } from "./cloud-file-contract.js"
import { managedDenial } from "../../opencode/config/lib/managed-usage.js"

const extensions = [".pdf", ".csv", ".tsv", ".xlsx", ".xlsm"]
const terminal = new Set(["succeeded", "partial", "failed", "cancelled", "interrupted"])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const runtimeId = /^processing_[0-9a-f-]{36}$/
const now = () => new Date().toISOString()
const put = (kind, id, value) => ({ type: "put", kind, id, value })
const failure = (status, code, message, details = {}) => new FileError(status, code, `Document processing: ${message}`, { agent: "file-service", tool: "document-processing", retryable: false, action: "Inspect processing status and submit a new request ID with an available source if needed.", ...details })
const report = (error) => ({ status: error.status || 503, error: error.error || "storage_unavailable", message: `${error.agent === "preprocessing" ? "Preprocessing" : "Document processing"}: ${(error.error || "storage_unavailable").replaceAll("_", " ")}.`, agent: error.agent || "file-service", tool: "document-processing", retryable: error.retryable ?? true, action: error.action || "Inspect retained storage and retry after storage is available." })
const coherent = (source) => ["service-published", "atomic-clone", "remote-conditional"].includes(source.consistency)
const plain = (value) => value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (object, allowed) => plain(object) && Object.keys(object).every((key) => allowed.includes(key))
const skipReasons = ["opt_out", "disabled", "unsupported_format", "input_too_large", "processing_capacity"]
const logId = (value) => typeof value === "string" && FILE_ID_PATTERN.test(value) ? value : null
const logDigest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null
const modelReference = (value) => typeof value === "string" && /^proxy\/[A-Za-z0-9_./:-]{1,256}(?:#[A-Za-z0-9_.-]{1,64})?$/.test(value) ? value : null
const versionObservation = (value) => typeof value === "string" && value.length <= 256 && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9_.+-]+)?$/.test(value) ? value : null
const diagnosticCode = (value) => typeof value === "string" && /^[a-z][a-z_]{0,127}$/.test(value) ? value : null
const dateObservation = (value) => typeof value === "string" && value.length <= 64 && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
const nonnegativeCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null
const versionWarningCodes = new Set(["cli_version_missing", "cli_version_invalid", "cli_version_untested", "http_version_missing", "http_version_invalid", "http_version_untested", "descriptor_version_missing", "descriptor_version_invalid", "descriptor_version_untested", "version_observations_contradict", "version_evidence_invalid", "cli_version_probe_failed", "cli_version_probe_timeout", "cli_version_probe_oversized"])

function normalizeLocator(source, job) {
	if (!plain(source)) throw failure(502, "invalid_result_inventory", "A result source locator must be an object.")
	for (const key of ["page", "row", "column"]) if (source[key] !== undefined && (!Number.isSafeInteger(source[key]) || source[key] < 1)) throw failure(502, "invalid_result_inventory", "Result locator indices must be positive integers.")
	const result = { ...source }
	if (source.bounds !== undefined) {
		const legacy = Array.isArray(source.bounds)
		// PDF recovery sourceBounds are [left, top, right, bottom] in page points,
		// relative to the rotated MediaBox. Do not reinterpret evidence/image boxes
		// or invent missing rotation, dimensions, units or transforms.
		if (legacy && (path.extname(job.originalFilename || "").toLowerCase() !== ".pdf" || !Number.isSafeInteger(source.page))) throw failure(502, "invalid_result_inventory", "Legacy bounds require a PDF page locator.")
		const bounds = legacy ? { bbox: source.bounds } : source.bounds, box = bounds?.bbox
		if (!plain(bounds) || !Array.isArray(box) || box.length !== 4 || !box.every((value) => typeof value === "number" && Number.isFinite(value)) || box[0] >= box[2] || box[1] >= box[3] || ["units", "origin"].some((key) => bounds[key] !== undefined && typeof bounds[key] !== "string")) throw failure(502, "invalid_result_inventory", "Result bounds must contain a finite, positive-area rectangle.")
		result.bounds = { ...bounds }
	}
	return result
}

function freshDependency(value) {
	const observed = Date.parse(value?.observedAt), bound = value?.observationMaxAgeMs, age = Date.now() - observed
	return Number.isSafeInteger(bound) && bound > 0 && age >= 0 && age <= bound
}

function dependencyView(raw) {
	const value = plain(raw) ? raw : {}, observedAt = dateObservation(value.observedAt)
	const result = { state: ["ready", "unavailable", "blocked", "unconfigured", "admin-only"].includes(value.state) ? value.state : "unknown", ready: value.ready === true && freshDependency({ ...value, observedAt }), executionReady: value.executionReady === true && freshDependency({ ...value, observedAt }), checkedAt: now(), observedAt, observationMaxAgeMs: Number.isSafeInteger(value.observationMaxAgeMs) && value.observationMaxAgeMs > 0 ? value.observationMaxAgeMs : null }
	if (!result.executionReady) result.ready = false
	result.version = versionObservation(value.version)
	if (plain(value.compatibility)) {
		const evidence = value.compatibility
		result.compatibility = { classification: ["known-tested", "unknown", "inconsistent"].includes(evidence.classification) ? evidence.classification : "unknown", cliVersion: versionObservation(evidence.cliVersion), httpVersion: versionObservation(evidence.httpVersion), descriptorVersion: versionObservation(evidence.descriptorVersion), warnings: Array.isArray(evidence.warnings) ? [...new Set(evidence.warnings.filter((item) => versionWarningCodes.has(item)))].slice(0, 32) : [] }
		if (result.compatibility.classification === "inconsistent") result.ready = result.executionReady = false
	}
	for (const key of ["preferredModel", "selectedModel"]) result[key] = modelReference(value[key])
	for (const key of ["eligibleCandidateCount", "policyAgeMs"]) result[key] = nonnegativeCount(value[key])
	result.selectionReason = diagnosticCode(value.selectionReason)
	result.reason = diagnosticCode(value.reason) || (!result.executionReady ? "engine_context_unavailable_or_stale" : !result.ready ? "new_selection_unavailable" : null)
	result.jobHolds = Array.isArray(value.jobHolds) ? value.jobHolds.slice(0, 200).filter((item) => plain(item) && logId(item.jobId) && diagnosticCode(item.reason)).map((item) => ({ jobId: item.jobId, reason: diagnosticCode(item.reason), selectedModel: modelReference(item.selectedModel) })) : []
	return result
}

function modelSelectionView(value) {
	if (!plain(value)) return null
	return { preferredModel: modelReference(value.preferredModel), selectedModel: modelReference(value.selectedModel), selectionReason: diagnosticCode(value.selectionReason) }
}

function modelHoldView(value) {
	return plain(value) && diagnosticCode(value.reason) ? { reason: diagnosticCode(value.reason), selectedModel: modelReference(value.selectedModel) } : null
}

function options(body) {
	const result = { requireCoherentSource: body.requireCoherentSource ?? false }
	if (typeof result.requireCoherentSource !== "boolean") throw failure(400, "invalid_request", "requireCoherentSource must be boolean.")
	if (body.tableRecovery !== undefined) {
		const value = body.tableRecovery, allowed = ["geometry", "vision", "forcePages", "renderDpi", "maxAdditionalPasses", "maxModelCalls", "workSeconds"]
		if (!exactKeys(value, allowed)) throw failure(400, "invalid_request", "Use only supported PDF tableRecovery options.")
		for (const [key, item] of Object.entries(value)) {
			const valid = key === "geometry" ? ["auto", "force", "off"].includes(item) : key === "vision" ? ["confirm-all", "on-demand", "off"].includes(item) : key === "forcePages" ? Array.isArray(item) && item.every((page) => Number.isSafeInteger(page) && page > 0) : key === "maxAdditionalPasses" ? Number.isSafeInteger(item) && item >= 0 : key === "maxModelCalls" ? item === null || Number.isSafeInteger(item) && item > 0 : key === "workSeconds" && item === null || typeof item === "number" && Number.isFinite(item) && item > 0
			if (!valid) throw failure(400, "invalid_request", `Invalid PDF tableRecovery.${key} value.`)
		}
		result.tableRecovery = { ...value, ...(value.forcePages ? { forcePages: [...new Set(value.forcePages)].sort((a, b) => a - b) } : {}) }
	}
	return result
}

/** Project-local delivery authority; the processor remains the sole extraction scheduler. */
export class DocumentProcessing {
	constructor(workspace, config = {}, logger = console) {
		this.workspace = workspace; this.state = workspace.state; this.identity = workspace.identity || this.state.identity
		this.config = { enabled: false, aggregateActivity: false, profileId: "default", inputBytes: 256 * 1024 * 1024, activeTickets: 100, jsonBytes: 16 * 1024 * 1024, transportMs: 15000, runningPollMs: 2000, queuedPollMs: 2000, heldWarningBytes: 1024 * 1024 * 1024, activityMaxAgeMs: 24 * 60 * 60 * 1000, ...workspace.config?.preprocessing, ...config }
		this.logger = logger; this.client = new PreprocessingClient(this.config)
		if (!["inputBytes", "activeTickets", "runningPollMs", "queuedPollMs"].every((key) => Number.isSafeInteger(this.config[key]) && this.config[key] > 0) || !["heldWarningBytes", "activityMaxAgeMs"].every((key) => Number.isSafeInteger(this.config[key]) && this.config[key] >= 0)) throw failure(503, "invalid_preprocessing_config", "Configure positive processing limits and nonnegative advisory thresholds.")
		this.admissionTail = Promise.resolve(); this.mutations = new Map(); this.reservations = new Map(); this.localWork = new Map(); this.captureWork = new Map(); this.controllers = new Map()
		this.closed = false; this.draining = false; this.started = false; this.degraded = null; this.cloudPermits = new Map()
	}
	serialAdmission(work) { const result = this.admissionTail.then(work); this.admissionTail = result.catch(() => {}); return result }
	serialId(id, work) {
		const result = (this.mutations.get(id) || Promise.resolve()).then(work)
		const tail = result.catch(() => {}); this.mutations.set(id, tail)
		tail.finally(() => { if (this.mutations.get(id) === tail) this.mutations.delete(id) })
		return result
	}
	current(record) { return record?.workspaceId === this.identity.workspaceId && record?.workspaceEpoch === this.identity.workspaceEpoch }
	emit(event, job = {}) {
		// Construct the log payload field-by-field. Source/request objects and error text never enter the sink.
		try {
			const fields = { workspaceId: logId(this.identity.workspaceId), workspaceEpoch: logId(this.identity.workspaceEpoch), projectId: logId(this.workspace.config?.projectId), runtimeJobId: logId(job.runtimeJobId), uploadOperationId: logId(job.uploadOperationId), submissionKey: uuid.test(job.upstreamSubmissionKey || "") ? job.upstreamSubmissionKey : null, processorJobId: logId(job.processorJobId), sourceSha256: logDigest(job.sourceSha256), profileDigest: logDigest(job.resolvedProfile?.profileDigest), buildDigest: logDigest(this.config.bundleDigest) || logDigest(this.storageObservation?.bundleDigest) }
			Promise.resolve(this.logger?.info?.(event, fields)).catch(() => {})
		} catch { /* Telemetry cannot change the committed operation or its response. */ }
	}
	milestones(previous, next) {
		if (!next || next === previous) return
		const before = previous || {}
		if (!previous) this.emit("processing.admitted", next)
		if (next.captureJobId && before.captureJobId !== next.captureJobId) this.emit("processing.capture.accepted", next)
		if (next.captureId && next.historicalRef && (before.captureId !== next.captureId || !before.historicalRef)) this.emit("processing.capture.completed", next)
		if (next.sourceSha256 && before.sourceSha256 !== next.sourceSha256) this.emit("processing.source.hashed", next)
		if (before.deliveryStage !== next.deliveryStage && ["capturing", "pending", "copying", "submitting", "blocked", "tracking", "terminal"].includes(next.deliveryStage)) {
			this.emit(`processing.state.${next.deliveryStage}`, next)
			if (next.deliveryStage === "copying") this.emit("processing.copy.started", next)
			if (next.deliveryStage === "terminal") {
				this.emit(`processing.terminal.${terminal.has(next.outcome || next.processorState) ? next.outcome || next.processorState : "failed"}`, next)
				if (next.cancelRequestedAt || next.outcome === "cancelled") this.emit("processing.cancellation.settled", next)
			}
		}
		if (!before.inboxPublishedAt && next.inboxPublishedAt) this.emit("processing.copy.published", next)
		if (!before.dispatchIntentAt && next.dispatchIntentAt) this.emit("processing.dispatch.intent", next)
		else if (next.lastDispatchAt && before.lastDispatchAt !== next.lastDispatchAt) this.emit("processing.dispatch.replay_intent", next)
		if (!before.dispatchUncertain && next.dispatchUncertain) this.emit("processing.dispatch.ambiguous", next)
		if (!before.processorJobId && next.processorJobId) this.emit("processing.upstream.admitted", next)
		if (before.processorState !== next.processorState && ["queued", "running", "cancelling", ...terminal].includes(next.processorState)) this.emit(`processing.upstream.${next.processorState}`, next)
		if (!before.snapshotAcknowledgedAt && next.snapshotAcknowledgedAt) this.emit("processing.snapshot.acknowledged", next)
		if (!before.cancelRequestedAt && next.cancelRequestedAt) this.emit("processing.cancellation.requested", next)
		if (next.resolvedProfile?.profileDigest && before.resolvedProfile?.profileDigest !== next.resolvedProfile.profileDigest) this.emit("processing.profile.resolved", next)
		if (before.processorPublication?.state !== next.processorPublication?.state && ["pending", "ready", "failed"].includes(next.processorPublication?.state)) this.emit(`processing.publication.${next.processorPublication.state}`, next)
		if (!before.inboxRemovedAt && next.inboxRemovedAt) this.emit("processing.cleanup.inbox_removed", next)
		if (!before.holdReleasedAt && next.holdReleasedAt) this.emit("processing.cleanup.hold_released", next)
		if (before.cleanupState !== next.cleanupState && ["complete", "blocked"].includes(next.cleanupState)) this.emit(`processing.cleanup.${next.cleanupState}`, next)
	}
	async records() { return (await this.state.list("processing-jobs")).filter((job) => this.current(job)) }
	async record(id) {
		identifier(id, "processing job ID")
		const job = await this.state.get("processing-jobs", id)
		if (!job || !this.current(job)) throw failure(404, "not_found", "No processing job belongs to this workspace epoch with that ID.")
		return job
	}
	async mutate(id, expectedRevision, build) {
		return this.serialId(id, async () => {
			const previous = await this.record(id), changes = await build(previous, previous.revision !== expectedRevision)
			if (!changes) return previous
			const next = { ...previous, ...changes, revision: previous.revision + 1, updatedAt: now() }
			// No callback can revoke cancellation, regress upstream evidence, or replace a terminal outcome.
			if (previous.cancelRequestedAt) next.cancelRequestedAt = previous.cancelRequestedAt
			if (previous.deliveryStage === "terminal") { next.deliveryStage = "terminal"; next.processorState = previous.processorState; next.outcome = previous.outcome; next.error = previous.error }
			if ((next.processorRevision ?? 0) < (previous.processorRevision ?? 0)) { next.processorRevision = previous.processorRevision; next.processorState = previous.processorState }
			await this.state.transaction([put("processing-jobs", id, next)])
			this.milestones(previous, next)
			return next
		})
	}
	async init() {
		if (this.initializing) return this.initializing
		this.initializing = (async () => {
			await this.serialAdmission(() => this.repairAdmissions())
			await this.rebuildReservations()
			const jobs = await this.records()
			if (this.config.enabled || jobs.some((job) => job.cleanupState !== "complete")) {
				try { await this.openInbox() } catch (error) { this.degraded = report(error) }
			}
			for (const job of jobs) {
				if (job.deliveryStage === "copying") await this.mutate(job.runtimeJobId, job.revision, () => ({ deliveryStage: "pending", lastMilestone: "pending", nextAttemptAt: null }))
			}
		})()
		return this.initializing
	}
	async rebuildReservations() {
		this.reservations.clear()
		const tickets = new Set((await this.records()).map((job) => job.runtimeJobId))
		for (const op of await this.state.list("operations")) {
			const admission = op.processingAdmission
			if (!["upload", "apply-remote"].includes(op.action) || admission?.state !== "reserved" || tickets.has(admission.jobId) || ["failed", "aborted-before-publication"].includes(op.state)) continue
			if (!this.sourceEpoch(op.publishedSource)) continue
			this.reservations.set(op.operationId, admission)
		}
	}
	async reconcileOperations() {
		await this.init()
		for (const op of await this.state.list("operations")) if (["failed", "aborted-before-publication"].includes(op.state)) await this.releaseFailedUpload(op)
		await this.rebuildReservations()
		const interest = await this.state.get("processing-requests", "internal:activity")
		if (this.current(interest)) this.settlementInterestAt = interest.settlementInterestAt
		const storage = await this.state.get("processing-requests", "internal:storage")
		if (this.current(storage)) this.storageObservation = storage.measurement
		const recovery = await this.state.get("processing-requests", "internal:recovery")
		if (this.current(recovery)) this.recovery = recovery.report
		// Child capture receipts and known remote mappings are read before any new POST is attempted.
		for (const job of await this.records()) {
			if (job.deliveryStage === "capturing") await this.reconcileCapture(job, false)
			if (job.processorJobId && (job.deliveryStage !== "terminal" || this.publicationPending(job))) await this.poll(job).catch((error) => this.block(job, error))
		}
		this.started = true; this.wake()
	}
	admissionOpen() {
		if (this.closed || this.draining) throw failure(503, "draining", "Processing admission is draining.", { retryable: true, action: "Retry after the file service restarts." })
		if (!this.config.enabled || !this.config.aggregateActivity) throw failure(503, "processing_disabled", "New processing admission is disabled.", { action: "Enable preprocessing and aggregate runtime activity before submitting new work." })
	}
	async repairAdmissions() {
		// A durable claim survives a lost job-record write and owns its admission slot immediately.
		for (const request of await this.state.list("processing-requests")) if (this.current(request) && this.current(request.initialJob) && !await this.state.get("processing-jobs", request.runtimeJobId)) {
			await this.state.transaction([put("processing-jobs", request.runtimeJobId, request.initialJob)])
			this.milestones(null, request.initialJob)
		}
	}
	async unmatchedAdmissions(jobs) {
		const ids = new Set(jobs.map((job) => job.runtimeJobId))
		return (await this.state.list("processing-requests")).filter((request) => this.current(request) && this.current(request.initialJob) && !ids.has(request.runtimeJobId))
	}
	async capacity() {
		const jobs = await this.records()
		this.pruneReservations(jobs)
		const unmatched = await this.unmatchedAdmissions(jobs)
		return jobs.filter((job) => job.deliveryStage !== "terminal").length + this.reservations.size + unmatched.length
	}
	pruneReservations(jobs) {
		const ticketIds = new Set(jobs.map((job) => job.runtimeJobId))
		for (const [operationId, admission] of this.reservations) if (ticketIds.has(admission.jobId)) this.reservations.delete(operationId)
	}
	newJob(requestId, source, requestedOptions, trigger = "user", admission = {}) {
		const id = admission.jobId || `processing_${crypto.randomUUID()}`
		return { runtimeJobId: id, ...this.identity, requestId, trigger, originalSourceRef: source, requestedOptions, createdAt: admission.createdAt || now(), revision: 1, deliveryStage: "capturing", lastMilestone: "capturing", holdId: `processing-hold:${id}`, cleanupState: "pending", upstreamSubmissionKey: admission.upstreamSubmissionKey || crypto.randomUUID(), resultAvailable: false, processorRevision: 0 }
	}
	normalize(body) {
		if (!exactKeys(body, ["requestId", "source", "requireCoherentSource", "tableRecovery", "rerunOf"]) || !uuid.test(body.requestId || "")) throw failure(400, "invalid_request", "Supply a UUID requestId and supported processing fields.")
		const requestedOptions = options(body); let source
		if (body.source === undefined && body.rerunOf) source = { kind: "rerun", jobId: identifier(body.rerunOf) }
		else {
			source = body.source
			const fields = { "workspace-file": ["kind", "path", "baseObservation"], capture: ["kind", "captureId"], "upload-operation": ["kind", "operationId"] }[source?.kind]
			if (!fields || !exactKeys(source, fields) || !fields.filter((key) => key !== "baseObservation").every((key) => Object.hasOwn(source, key))) throw failure(400, "invalid_source", "Select one workspace-file, complete capture, or upload-operation source.")
			if (source.kind === "workspace-file") {
				const name = canonicalPath(source.path, { root: false }), base = source.baseObservation, token = typeof base === "string" ? base : base?.token
				if (typeof token !== "string" || !token || token.length > 512 || base?.ref && stableStringify(base.ref) !== stableStringify(this.workspace.ref(name))) throw failure(400, "invalid_observation", "Workspace-file processing requires its current baseObservation.")
				source = { kind: source.kind, path: name, baseObservation: token }
			} else source = { kind: source.kind, [fields[1]]: identifier(source[fields[1]], fields[1]) }
		}
		return { source, requestedOptions, rerunOf: body.rerunOf ? identifier(body.rerunOf) : null }
	}
	async submit(body) {
		const intent = this.normalize(body)
		body = { ...body, requestId: body.requestId.toLowerCase() }
		const admitted = await this.serialAdmission(async () => {
			await this.repairAdmissions()
			const existing = await this.state.get("processing-requests", body.requestId)
			if (existing) {
				const claimed = await this.state.claim("processing-requests", body.requestId, intent, existing)
				if (!this.current(claimed.record)) throw failure(409, "request_id_reused", "This request belongs to another workspace epoch.")
				if (!await this.state.get("processing-jobs", claimed.record.runtimeJobId) && claimed.record.initialJob) await this.state.transaction([put("processing-jobs", claimed.record.runtimeJobId, claimed.record.initialJob)])
				return { duplicate: true, job: await this.record(claimed.record.runtimeJobId) }
			}
			this.admissionOpen()
			let op
			if (intent.source.kind === "upload-operation") {
				op = await this.state.get("operations", intent.source.operationId)
				if (!op || op.action !== "upload" || op.state !== "committed" || !this.sourceEpoch(op.publishedSource)) throw failure(410, "source_unavailable", "The original upload is not a committed source in this workspace epoch.")
				if (!intent.rerunOf && !intent.requestedOptions.requireCoherentSource && !Object.hasOwn(intent.requestedOptions, "tableRecovery") && op.processing?.jobId) {
					const job = await this.record(op.processing.jobId)
					await this.state.claim("processing-requests", body.requestId, intent, { ...this.identity, requestId: body.requestId, runtimeJobId: job.runtimeJobId, intent, createdAt: now() })
					return { duplicate: true, job }
				}
			}
			if (await this.capacity() >= this.config.activeTickets) throw failure(429, "processing_capacity", "The active processing ticket ceiling was reached.", { retryable: true, limits: { activeTickets: this.config.activeTickets }, action: "Retry after an accepted processing job settles, or raise the active-ticket limit." })
			const rerunParent = intent.rerunOf ? await this.record(intent.rerunOf) : null
			const job = this.newJob(body.requestId.toLowerCase(), intent.source, intent.requestedOptions)
			if (intent.source.kind === "workspace-file") job.captureRequestId = crypto.randomUUID()
			if (op) { job.uploadOperationId = op.operationId; job.captureId = op.publishedSource.captureId }
			if (intent.rerunOf) { job.rerunOf = intent.rerunOf; job.rerunProcessorId = rerunParent.processorJobId || null }
			const request = { ...this.identity, requestId: body.requestId, runtimeJobId: job.runtimeJobId, intent, initialJob: job, createdAt: now() }
			await this.state.claim("processing-requests", body.requestId, intent, request)
			await this.state.transaction([put("processing-jobs", job.runtimeJobId, job)])
			this.milestones(null, job)
			return { duplicate: false, job }
		})
		if (!admitted.duplicate) {
			try { await this.resolveSource(admitted.job) }
			catch (cause) {
				const error = cause.status === 410 || cause.error === "capture_expired" ? failure(410, "source_unavailable", "The original retained capture is unavailable.", { action: "Select the current file or re-upload the original; a missing retained upload is never replaced by current-path bytes." }) : new FileError(cause.status || 503, cause.error || "storage_unavailable", report(cause).message, report(cause))
				await this.failLocal(admitted.job, error); throw error
			}
		}
		this.wake()
		return { status: admitted.duplicate ? 200 : 202, job: this.project(await this.record(admitted.job.runtimeJobId)), duplicate: admitted.duplicate }
	}
	sourceEpoch(source) { return source?.kind === "runtime-capture" && source?.ref?.workspaceId === this.identity.workspaceId && source?.ref?.workspaceEpoch === this.identity.workspaceEpoch }
	validateSource(source, requestedOptions) {
		if (!this.sourceEpoch(source) || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0 || source.digest?.state === "ready" && !/^[0-9a-f]{64}$/.test(source.digest.sha256 || "")) throw failure(410, "source_unavailable", "Use an available complete capture in this workspace epoch.", { action: "Select the current file or re-upload the original; an expired upload is never replaced by current-path bytes." })
		const name = path.posix.basename(canonicalPath(source.ref.path, { root: false })), extension = path.extname(name).toLowerCase()
		if (!extensions.includes(extension)) throw failure(415, "unsupported_format", "Supported document extensions are PDF, CSV, TSV, XLSX, and XLSM.")
		if (source.sizeBytes > this.config.inputBytes) throw failure(413, "input_too_large", "The source exceeds the processor input limit.", { limits: { inputBytes: this.config.inputBytes }, action: "Raise the configured processor input limit or select a smaller source." })
		if (requestedOptions.requireCoherentSource && !coherent(source)) throw failure(409, "coherent_source_unavailable", "This checked copy is not a coherent source version.")
		if (Object.hasOwn(requestedOptions, "tableRecovery") && extension !== ".pdf") throw failure(400, "unsupported_option", "tableRecovery overrides apply only to PDF sources.")
		return name
	}
	async attachCapture(job, id) {
		return this.serialId(job.runtimeJobId, async () => {
			let previous
			const next = await this.workspace.captures.withRetentionMetadata("capture", id, async (record) => {
				const current = await this.record(job.runtimeJobId)
				previous = current
				if (current.cancelRequestedAt || current.deliveryStage === "terminal") return { metadata: [], result: current }
				const source = record.source, filename = this.validateSource(source, current.requestedOptions)
				const next = { ...current, captureId: id, originalFilename: filename, sourceSha256: source.digest?.state === "ready" ? source.digest.sha256 : null, sourceBytes: source.sizeBytes, sourceConsistency: source.consistency, originalObservation: record.sourceObservation || null, historicalRef: source.ref, deliveryStage: "pending", lastMilestone: "pending", revision: current.revision + 1 }
				const hold = { holdId: current.holdId, source: { kind: "capture", id }, reason: "processing", createdAt: current.createdAt }
				return { metadata: [put("processing-jobs", next.runtimeJobId, next), put("holds", hold.holdId, hold)], result: next }
			})
			this.milestones(previous, next)
			return next
		})
	}
	async resolveSource(job) {
		const source = job.originalSourceRef
		if (source.kind === "rerun") return this.attachSnapshot(job)
		if (source.kind !== "workspace-file") return this.attachCapture(job, job.captureId || source.captureId)
		const work = (async () => {
			const result = await this.workspace.captures.create({ requestId: job.captureRequestId, path: source.path, baseObservation: source.baseObservation, requireCoherentSource: job.requestedOptions.requireCoherentSource, computeDigest: true })
			if (result.source && result.status !== 202) await this.attachCapture(job, result.source.captureId)
			else await this.mutate(job.runtimeJobId, job.revision, (current) => current.deliveryStage === "terminal" ? null : { captureJobId: result.jobId })
		})()
		this.captureWork.set(job.runtimeJobId, work)
		try { await work } finally { this.captureWork.delete(job.runtimeJobId) }
	}
	async attachSnapshot(job) {
		const parent = await this.record(job.rerunOf), upstream = parent.processorJobId ? await this.client.get(parent.processorJobId) : null
		if (!upstream || upstream.submissionKey !== parent.upstreamSubmissionKey || upstream.source?.sha256 !== parent.sourceSha256 || upstream.source?.bytes !== parent.sourceBytes || !upstream.source.snapshotId) throw failure(409, "source_unavailable", "The previous processing snapshot cannot be validated; supply a fresh explicit source.")
		const synthetic = { kind: "runtime-capture", ref: parent.historicalRef, sizeBytes: parent.sourceBytes, digest: { state: "ready", sha256: parent.sourceSha256 }, consistency: parent.sourceConsistency }
		const filename = this.validateSource(synthetic, job.requestedOptions)
		await this.mutate(job.runtimeJobId, job.revision, () => ({ originalFilename: filename, historicalRef: parent.historicalRef, sourceSha256: parent.sourceSha256, sourceBytes: parent.sourceBytes, sourceConsistency: parent.sourceConsistency, snapshotId: upstream.source.snapshotId, snapshotAcknowledgedAt: now(), cleanupState: "complete", holdReleasedAt: now(), inboxRemovedAt: now(), deliveryStage: "submitting", lastMilestone: "submitting", upstreamRequest: this.upstreamRequest(job, { kind: "snapshot", snapshotId: upstream.source.snapshotId }, parent.processorJobId) }))
	}
	async reconcileCapture(job, allowCreate = true) {
		if (this.captureWork.has(job.runtimeJobId)) return
		if (job.cancelRequestedAt) return this.settleLocalCancel(job)
		if (!job.captureRequestId) {
			try { await this.resolveSource(job) } catch (error) { await this.failLocal(job, error) }
			return
		}
		const request = await this.state.get("requests", job.captureRequestId)
		if (request?.state === "succeeded" && request.result?.source) {
			try { await this.attachCapture(job, request.result.source.captureId) } catch (error) { await this.failLocal(job, error) }
		} else if (request && ["failed", "cancelled", "interrupted"].includes(request.state)) await this.failLocal(job, failure(409, "capture_interrupted", "The accepted capture did not complete; use a new request and observation."))
		else if (!request && !allowCreate) await this.failLocal(job, failure(409, "capture_interrupted", "Capture admission was interrupted before it bound source bytes; use a new request and observation."))
		else if (!request) { try { await this.resolveSource(job) } catch (error) { await this.failLocal(job, error) } }
	}
	async reserveUpload(op) {
		return this.serialAdmission(async () => {
			if (op.processingAdmission) return op.processingAdmission
			if (this.reservations.has(op.operationId)) return this.reservations.get(op.operationId)
			const policy = op.intent.processingPolicy
			if (policy === undefined || policy === null) return null
			if (!["auto", "skip"].includes(policy)) throw failure(400, "invalid_request", "Upload processing policy must be auto or skip.")
			const skip = (reason, extra = {}) => ({ policy, state: "skipped", jobId: null, reason, ...extra })
			if (policy === "skip") return skip("opt_out")
			if (!this.config.enabled || !this.config.aggregateActivity || this.draining || this.closed) return skip("disabled")
			if (!extensions.includes(path.extname(op.intent.path).toLowerCase())) return skip("unsupported_format")
			if (op.sizeBytes > this.config.inputBytes) return skip("input_too_large", { limits: { inputBytes: this.config.inputBytes }, action: "Raise the processing input limit and retry this upload while its retained capture is available; otherwise select the current file or re-upload the original." })
			this.validateSource(op.publishedSource, { requireCoherentSource: false })
			if (await this.capacity() >= this.config.activeTickets) return skip("processing_capacity", { limits: { activeTickets: this.config.activeTickets }, action: "Retry processing this upload while its retained capture is available; otherwise select the current file or re-upload the original." })
			const admission = { policy, state: "reserved", jobId: `processing_${crypto.randomUUID()}`, upstreamSubmissionKey: crypto.randomUUID(), createdAt: now(), reason: null }
			this.reservations.set(op.operationId, admission)
			return admission
		})
	}
	/** Reserve capacity and register the single cloud execution permit before any ticket can dispatch. */
	async reserveCloud(op, grant, inspect) {
		return this.serialAdmission(async () => {
			const previous = await this.state.get("operations", op.operationId)
			if (previous?.processingPermitIntent && !op.processingPermit) { if (!inspect) throw cloudError(503, "owner_reconciliation_required"); await inspect() }
			if (["reserved", "skipped", "historical"].includes(previous?.processingAdmission?.state)) { Object.assign(op, previous); return op.processingAdmission }
			// Disablement closes new admission; it does not opt an existing automatic
			// capacity request out. Retain its source and request identity until admission resumes.
			if (previous?.processingAdmission?.state === "awaiting-capacity" && (!this.config.enabled || !this.config.aggregateActivity || this.draining || this.closed)) { Object.assign(op, previous); return op.processingAdmission }
			if (this.reservations.has(op.operationId)) { op.processingAdmission = this.reservations.get(op.operationId); await this.state.put("operations", op.operationId, op); return op.processingAdmission }
			const claim = op.claim, skip = (reason) => ({ state: "skipped", reason, requestId: claim.processingRequestId })
			let admission
			if (claim.processingReceipt?.state === "historical") { admission = { state: "historical", receipt: historicalReceipt(claim.processingReceipt, claim) }; op.processingPermit = null }
			else if (claim.processingReceipt?.state === "skipped") admission = skip(claim.processingReceipt.reason)
			else if (claim.recovery === "rehydrate" && claim.processingReceipt?.state !== "skipped" || claim.processingReceipt?.state === "ticket") throw cloudError(409, "rehydrate_processing_receipt_unresolved")
			else if (claim.processingPolicy === "skip") admission = skip("policy-skip")
			// Only backend policy can authorize a disabled skip. A local configuration
			// failure stays retryable; an already granted permit must still recover.
			else if (!op.processingPermit && (!this.config.enabled || !this.config.aggregateActivity || this.draining || this.closed)) throw cloudError(503, "processing_unavailable")
			else if (!extensions.includes(path.extname(claim.destination.path).toLowerCase())) admission = skip("unsupported-format")
			else if (op.sizeBytes > this.config.inputBytes) admission = skip("too-large")
			else {
				this.validateSource(op.publishedSource, { requireCoherentSource: true })
				if (claim.processingProfileId && claim.processingProfileId !== this.config.profileId) throw cloudError(503, "processing_profile_unavailable")
				if (!op.processingPermit && await this.capacity() >= this.config.activeTickets) admission = { state: "awaiting-capacity", requestId: claim.processingRequestId }
				else {
					const permit = op.processingPermit || await grant()
					op.processingPermit = permit
					admission = { policy: "auto", state: "reserved", requestId: claim.processingRequestId, jobId: `processing_${stableId(`${this.identity.workspaceEpoch}:${claim.processingRequestId}:ticket`)}`, upstreamSubmissionKey: stableId(`${this.identity.workspaceEpoch}:${claim.processingRequestId}:submission`), profileId: claim.processingProfileId || this.config.profileId, createdAt: now() }
					this.reservations.set(op.operationId, admission)
				}
			}
			op.processingAdmission = admission
			await this.state.put("operations", op.operationId, op)
			return admission
		})
	}
	async cloudMetadata(op) {
		const a = op.processingAdmission
		if (!a) throw cloudError(503, "processing_decision_missing")
		const base = { requestId: op.claim.processingRequestId, sourceFileVersionId: op.claim.source.fileVersionId }
		if (a.state === "historical") {
			if (op.processingPermit || !a.receipt) throw cloudError(409, "historical_processing_unresolved")
			return { processingReceipt: historicalReceipt(a.receipt, op.claim), metadata: [] }
		}
		if (a.state !== "reserved") return { processingReceipt: { ...base, state: a.state, ...(a.reason ? { reason: a.reason } : {}), ...(op.processingPermit ? { processingPermitId: op.processingPermit.permitId } : {}) }, metadata: [] }
		if (!op.processingPermit) throw cloudError(409, "processing_permit_required")
		const source = op.publishedSource, filename = this.validateSource(source, { requireCoherentSource: true })
		const existing = await this.state.get("processing-jobs", a.jobId)
		if (existing && (existing.cloudWorkId !== op.claim.workId || existing.captureId !== source.captureId || existing.upstreamSubmissionKey !== a.upstreamSubmissionKey)) throw cloudError(409, "processing_mapping_conflict")
		const job = existing || { ...this.newJob(null, { kind: "capture", captureId: source.captureId, fileVersionId: op.claim.source.fileVersionId }, { requireCoherentSource: true }, "cloud-import", a), cloudWorkId: op.claim.workId, cloudFileVersionId: op.claim.source.fileVersionId, processingPermitId: op.processingPermit.permitId, processingOwnerRevision: op.processingPermit.ownerRevision, profileId: a.profileId, originalFilename: filename, historicalRef: source.ref, captureId: source.captureId, sourceSha256: source.digest.sha256, sourceBytes: source.sizeBytes, sourceConsistency: source.consistency, deliveryStage: "pending", lastMilestone: "pending" }
		const request = { ...this.identity, requestId: a.requestId, runtimeJobId: job.runtimeJobId, intent: { workId: op.claim.workId, fileVersionId: op.claim.source.fileVersionId }, createdAt: a.createdAt }
		const hold = { holdId: job.holdId, source: { kind: "capture", id: source.captureId }, reason: "processing", createdAt: a.createdAt }
		return { processingReceipt: { ...base, state: "ticket", ticketId: job.runtimeJobId, processorSubmissionKey: job.upstreamSubmissionKey, processorJobId: job.processorJobId || null, processingPermitId: op.processingPermit.permitId }, metadata: existing ? [] : [put("processing-jobs", job.runtimeJobId, job), put("processing-requests", a.requestId, request), put("holds", hold.holdId, hold)] }
	}
	authorizeCloud(record, { observationOnly = false } = {}) {
		const receipt = record.processingReceipt, permit = record.processingPermit
		if (receipt.state !== "ticket" || !permit || permit.runtimeId !== record.claim.runtimeId || !this.current(permit) || permit.permitId !== receipt.processingPermitId || !(observationOnly ? ["granted", "reconciliation-pending", "completed"].includes(permit.state) : permit.state === "granted")) throw cloudError(409, "owner_reconciliation_required")
		this.cloudPermits.set(receipt.ticketId, { permitId: permit.permitId, ownerRevision: permit.ownerRevision, observationOnly })
	}
	revokeCloud(record) { if (record?.processingReceipt?.ticketId) this.cloudPermits.delete(record.processingReceipt.ticketId) }
	cloudAuthorized(job, { observation = false } = {}) { const permit = this.cloudPermits.get(job.runtimeJobId); return !job.cloudWorkId || Boolean((observation || !this.workspace.persistence?.adapter?.cleanupOnly) && permit && permit.permitId === job.processingPermitId && permit.ownerRevision === job.processingOwnerRevision && (observation || !permit.observationOnly)) }
	async uploadMetadata(op, sourceRecord) {
		const admission = op.processingAdmission
		if (!admission) return { processing: null, metadata: [] }
		// Format-level potential, including skipped PDFs; this is not a claim that a model call occurred.
		const mayUseModel = path.extname(op.intent.path).toLowerCase() === ".pdf"
		if (admission.state !== "reserved") return { processing: { ...admission, statusUrl: null, mayUseModel }, metadata: [] }
		const existing = await this.state.get("processing-jobs", admission.jobId)
		const processing = { policy: admission.policy, state: "pending", jobId: admission.jobId, statusUrl: `/files/processing/jobs/${admission.jobId}`, reason: null, mayUseModel }
		if (existing) { if (!this.current(existing) || existing.uploadOperationId !== op.operationId) throw failure(409, "request_id_reused", "The upload ticket belongs to a different upload."); return { processing, metadata: [] } }
		const source = sourceRecord.source, filename = this.validateSource(source, { requireCoherentSource: false })
		if (source.captureId !== op.publishedSource?.captureId || source.digest.sha256 !== op.publishedSource?.digest?.sha256 || source.sizeBytes !== op.sizeBytes) throw failure(409, "source_unavailable", "The retained upload source does not match its accepted admission.")
		const job = { ...this.newJob(null, { kind: "upload-operation", operationId: op.operationId }, { requireCoherentSource: false }, "upload", admission), uploadOperationId: op.operationId, originalFilename: filename, historicalRef: source.ref, originalObservation: sourceRecord.sourceObservation || null, captureId: source.captureId, sourceSha256: source.digest.sha256, sourceBytes: source.sizeBytes, sourceConsistency: source.consistency, deliveryStage: "pending", lastMilestone: "pending" }
		const hold = { holdId: job.holdId, source: { kind: "capture", id: job.captureId }, reason: "processing", createdAt: job.createdAt }
		return { processing, metadata: [put("processing-jobs", job.runtimeJobId, job), put("holds", hold.holdId, hold)] }
	}
	publicUpload(op) { return Boolean(op?.action === "upload" && op.state === "committed" && ["auto", "skip"].includes(op.intent?.processingPolicy) && this.sourceEpoch(op.publishedSource)) }
	/** Called only after the upload receipt, ticket and hold transaction is acknowledged. */
	async uploadCommitted(op) {
		try {
			const committed = await this.state.get("operations", op.operationId)
			if (!this.publicUpload(committed)) return
			if (committed.processing?.state === "skipped" && skipReasons.includes(committed.processing.reason)) {
				this.emit(`processing.upload.skipped.${committed.processing.reason}`, { uploadOperationId: committed.operationId, sourceSha256: committed.publishedSource.digest?.sha256 })
			} else if (committed.processing?.jobId) {
				const job = await this.state.get("processing-jobs", committed.processing.jobId)
				if (this.current(job) && job.uploadOperationId === committed.operationId) { this.emit("processing.upload.admitted", job); this.milestones(null, job) }
			}
			this.wake()
		} catch { /* The upload has committed; observability must never rewrite its outcome. */ }
	}
	async releaseFailedUpload(op) {
		if (["failed", "aborted-before-publication"].includes(op.state)) this.reservations.delete(op.operationId)
	}
	async openInbox() {
		if (this.inboxAnchor) return
		const directory = this.config.inboxDir
		if (!path.isAbsolute(directory || "") || this.workspace.workspaceDir && (directory === this.workspace.workspaceDir || directory.startsWith(`${this.workspace.workspaceDir}/`))) throw failure(503, "invalid_preprocessing_config", "Configure a private absolute inbox outside the user workspace.")
		const created = []
		const ensure = async (name) => {
			if (name !== path.dirname(name)) await ensure(path.dirname(name))
			try { const stat = await fs.lstat(name); if (!stat.isDirectory()) throw failure(503, "storage_unavailable", "Inbox ancestors must be directories without symlinks.") }
			catch (error) { if (error.code !== "ENOENT") throw error; await fs.mkdir(name, { mode: 0o2750 }); created.push(name) }
		}
		await ensure(directory)
		for (const name of created) { const handle = await fs.open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), parent = await fs.open(path.dirname(name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await handle.sync(); await parent.sync() } finally { await handle.close(); await parent.close() } }
		this.inboxAnchor = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
		this.inboxIdentity = await this.inboxAnchor.stat({ bigint: true })
		if (Number(this.inboxIdentity.uid) !== process.geteuid() || Number(this.inboxIdentity.mode) & 0o022) { await this.inboxAnchor.close(); this.inboxAnchor = null; throw failure(503, "storage_unavailable", "The inbox must be service-owned and not writable by other identities.") }
	}
	async assertInbox() {
		await this.openInbox()
		const named = await fs.lstat(this.config.inboxDir, { bigint: true }), current = await this.inboxAnchor.stat({ bigint: true })
		if (!named.isDirectory() || named.dev !== current.dev || named.ino !== current.ino || current.dev !== this.inboxIdentity.dev || current.ino !== this.inboxIdentity.ino || current.gid !== this.inboxIdentity.gid || Number(current.uid) !== process.geteuid() || Number(current.mode) & 0o022) throw failure(503, "storage_unavailable", "Private inbox ownership or directory identity changed.")
	}
	async jobDirectory(job, create = true) {
		if (!runtimeId.test(job.runtimeJobId) || !uuid.test(job.runtimeJobId.slice(11))) throw failure(503, "storage_unavailable", "The retained processing ID is invalid.")
		await this.assertInbox()
		const name = `/proc/self/fd/${this.inboxAnchor.fd}/${job.runtimeJobId}`
		let created = false
		if (create) { try { await fs.mkdir(name, { mode: 0o2750 }); created = true } catch (error) { if (error.code !== "EEXIST") throw error } }
		const anchor = await fs.open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
		try {
			let stat = await anchor.stat({ bigint: true })
			if (Number(stat.uid) !== process.geteuid() || Number(stat.mode) & 0o022) throw failure(503, "storage_unavailable", "A private inbox job directory is writable by another identity.")
			// Empty, server-named directories also recover a crash between mkdir and group publication.
			if (created || create && (stat.gid !== this.inboxIdentity.gid || (Number(stat.mode) & 0o050) !== 0o050) && !(await fs.readdir(`/proc/self/fd/${anchor.fd}`)).length) {
				await anchor.chown(-1, Number(this.inboxIdentity.gid)); await anchor.chmod(0o2750); await anchor.sync(); await this.inboxAnchor.sync(); stat = await anchor.stat({ bigint: true })
			}
			if (Number(stat.uid) !== process.geteuid() || stat.gid !== this.inboxIdentity.gid || Number(stat.mode) & 0o022 || (Number(stat.mode) & 0o050) !== 0o050) throw failure(503, "storage_unavailable", "A private inbox job directory has unsafe ownership or lacks processor-group access.", { retryable: true, action: "Verify file-daemon membership in the inbox reader group and repair retained inbox permissions." })
			return anchor
		} catch (error) { await anchor.close(); throw error }
	}
	upstreamRequest(job, source, parentId = job.rerunProcessorId) {
		return { source, profileId: job.profileId || this.config.profileId, ...(job.trigger === "upload" ? { correlation: { uploadRecordId: job.uploadOperationId } } : {}), ...(Object.hasOwn(job.requestedOptions, "tableRecovery") ? { tableRecovery: job.requestedOptions.tableRecovery } : {}), ...(parentId ? { rerunOf: parentId } : {}) }
	}
	async copyInput(job) {
		if (!this.cloudAuthorized(job)) throw cloudError(503, "owner_reconciliation_required")
		const controller = new AbortController(); this.controllers.set(job.runtimeJobId, controller)
		let directory, opened, output, partial
		try {
			const current = await this.mutate(job.runtimeJobId, job.revision, (latest) => latest.cancelRequestedAt || latest.deliveryStage === "terminal" ? null : { deliveryStage: "copying", lastMilestone: "pending", error: null })
			if (current.cancelRequestedAt || current.deliveryStage === "terminal") return
			if (!job.sourceSha256) {
				opened = await this.workspace.captures.open("capture", job.captureId)
				const sha256 = await this.copyVerified(opened.handle, null, job, controller.signal)
				job = await this.mutate(job.runtimeJobId, current.revision, () => ({ sourceSha256: sha256 }))
			}
			const filename = canonicalPath(job.originalFilename, { root: false })
			if (filename.includes("/")) throw failure(503, "storage_unavailable", "The inbox filename must be one canonical component.")
			directory = await this.jobDirectory(job)
			const base = `/proc/self/fd/${directory.fd}`, final = `${base}/${filename}`
			for (const entry of await fs.readdir(base)) {
				if (entry === filename) continue
				if (!/^\.[0-9a-f-]{36}\.partial$/.test(entry)) throw failure(503, "source_integrity", "Unexpected inbox evidence requires inspection before handoff.", { retryable: true })
				const stat = await fs.lstat(`${base}/${entry}`)
				if (!stat.isFile() || stat.uid !== process.geteuid() || stat.nlink !== 1) throw failure(503, "source_integrity", "Partial inbox evidence is not a safe regular file.", { retryable: true })
				await fs.unlink(`${base}/${entry}`)
			}
			await directory.sync()
			let input, sha256 = job.sourceSha256
			try { input = await fs.open(final, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) { if (error.code !== "ENOENT") throw error }
			if (input) {
				try { sha256 = await this.copyVerified(input, null, job, controller.signal); const stat = await input.stat(); if (stat.nlink !== 1 || stat.uid !== process.geteuid() || stat.gid !== Number(this.inboxIdentity.gid) || (stat.mode & 0o777) !== 0o440) throw failure(503, "source_integrity", "Final inbox evidence has unsafe permissions or aliases.") } finally { await input.close() }
			} else {
				opened ||= await this.workspace.captures.open("capture", job.captureId)
				partial = `${base}/.${crypto.randomUUID()}.partial`
				output = await fs.open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
				sha256 = await this.copyVerified(opened.handle, output, job, controller.signal)
				await output.chown(-1, Number(this.inboxIdentity.gid)); await output.chmod(0o440); await output.sync(); await output.close(); output = null
				if (controller.signal.aborted) return
				await fs.rename(partial, final); partial = null
			}
			await directory.sync(); await this.inboxAnchor.sync()
			await this.mutate(job.runtimeJobId, current.revision, (latest) => latest.deliveryStage === "terminal" ? null : { sourceSha256: sha256, inboxRelativePath: `${job.runtimeJobId}/${filename}`, inboxPublishedAt: latest.inboxPublishedAt || now(), deliveryStage: "submitting", lastMilestone: "submitting", upstreamRequest: latest.upstreamRequest || this.upstreamRequest(job, { kind: "workspace-file", path: `${job.runtimeJobId}/${filename}`, expectedSha256: sha256 }), nextAttemptAt: null })
		} finally {
			await output?.close(); if (partial) await fs.unlink(partial).catch((error) => { if (error.code !== "ENOENT") throw error })
			await opened?.release(); await directory?.close(); this.controllers.delete(job.runtimeJobId)
		}
	}
	async copyVerified(input, output, job, signal) {
		const before = await input.stat({ bigint: true })
		if (!before.isFile() || Number(before.size) !== job.sourceBytes) throw failure(503, "source_integrity", "The retained source size changed; original evidence remains held.")
		const buffer = Buffer.alloc(64 * 1024), hash = crypto.createHash("sha256"); let position = 0
		while (position < job.sourceBytes) {
			if (signal.aborted || this.draining) throw failure(503, "copy_checkpointed", "The input copy stopped before dispatch.", { retryable: true })
			const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, job.sourceBytes - position), position)
			if (!bytesRead) throw failure(503, "source_integrity", "The retained source was truncated.")
			hash.update(buffer.subarray(0, bytesRead))
			if (output) { let at = 0; while (at < bytesRead) { const { bytesWritten } = await output.write(buffer, at, bytesRead - at, position + at); if (!bytesWritten) throw failure(507, "insufficient_storage", "The private inbox write made no progress.", { retryable: true }); at += bytesWritten } }
			position += bytesRead; await yieldTurn()
		}
		const after = await input.stat({ bigint: true })
		const sha256 = hash.digest("hex")
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || job.sourceSha256 && sha256 !== job.sourceSha256) throw failure(503, "source_integrity", "The retained source does not match its accepted SHA-256 and size.")
		return sha256
	}
	wake(delay = 0) {
		if (!this.started || this.closed || this.draining) return
		if (this.timer && delay) return
		clearTimeout(this.timer)
		this.timer = setTimeout(() => { this.timer = null; this.run().catch((error) => { this.degraded = report(error); this.wake(this.config.runningPollMs) }) }, delay)
		this.timer.unref?.()
	}
	sampleJobs() {
		if (this.sampling) return this.sampling
		// Already-admitted work must keep reporting even while admission repair,
		// dependency recovery, or local cleanup waits on unrelated work.
		this.sampling = (async () => {
			for (const job of await this.records()) {
				if (this.draining || this.closed) return
				if (!job.processorJobId || !this.cloudAuthorized(job, { observation: true }) || job.usagePaused && !job.cancelRequestedAt || job.deliveryStage === "terminal" && !this.publicationPending(job) || this.localWork.has(job.runtimeJobId) || Date.parse(job.nextAttemptAt || "") > Date.now()) continue
				if (job.deliveryStage !== "terminal" && !this.cloudAuthorized(job)) continue
				this.launch(job, () => this.track(job))
			}
		})().finally(() => { this.sampling = null })
		return this.sampling
	}
	async run() {
		if (this.closed || this.draining) return
		await this.sampleJobs()
		if (this.closed || this.draining) return
		if (this.running) { this.wake(Math.min(this.config.runningPollMs, this.config.queuedPollMs)); return }
		this.running = (async () => {
			await this.serialAdmission(() => this.repairAdmissions())
			await this.checkDependency()
			const jobs = await this.records()
			this.pruneReservations(jobs)
			for (const job of jobs) {
				if (this.draining) break
				if (!this.cloudAuthorized(job, { observation: true })) continue
				if (job.cleanupState !== "complete" && (job.snapshotAcknowledgedAt || job.deliveryStage === "terminal" && (!job.dispatchIntentAt || job.dispatchRejectedAt || terminal.has(job.processorState)))) await this.cleanup(job)
				// Usage pauses stop automatic retries, but explicit cancellation still needs reconciliation.
				if (job.usagePaused && !job.cancelRequestedAt || job.deliveryStage === "terminal" && !this.publicationPending(job) || this.localWork.has(job.runtimeJobId) || Date.parse(job.nextAttemptAt || "") > Date.now()) continue
				// Terminal publication reads and eligible cleanup do not admit processor effects.
				if (job.deliveryStage !== "terminal" && !this.cloudAuthorized(job)) continue
				if (job.deliveryStage === "capturing") { await this.reconcileCapture(job); continue }
				if (job.cancelRequestedAt && !job.dispatchIntentAt && !job.processorJobId) { await this.settleLocalCancel(job); continue }
				if (job.processorJobId) continue
				if (!job.inboxPublishedAt && !job.upstreamRequest) {
					if (!this.copying) { this.copying = job.runtimeJobId; this.launch(job, async () => { try { await this.copyInput(job) } finally { this.copying = null } }) }
				} else this.launch(job, () => this.dispatch(job))
			}
		})()
		this.wake(Math.min(this.config.runningPollMs, this.config.queuedPollMs))
		try { await this.running } finally { this.running = null; this.wake(Math.min(this.config.runningPollMs, this.config.queuedPollMs)) }
	}
	launch(job, work) {
		const task = Promise.resolve().then(work).catch((error) => this.block(job, error)).catch((error) => { this.degraded = report(error) }).finally(() => { this.localWork.delete(job.runtimeJobId); this.wake() })
		this.localWork.set(job.runtimeJobId, task)
	}
	async dispatch(job) {
		let current = await this.record(job.runtimeJobId)
		if (!this.cloudAuthorized(current)) throw cloudError(503, "owner_reconciliation_required")
		if (current.deliveryStage === "terminal") return
		if (current.cancelRequestedAt && !current.dispatchIntentAt) return this.settleLocalCancel(current)
		if (current.dispatchIntentAt) {
			// Intent itself is crash evidence; a missing timeout marker never proves the first POST settled.
			current = await this.mutate(current.runtimeJobId, current.revision, (latest) => latest.deliveryStage === "terminal" ? null : { dispatchUncertain: true })
			if (current.deliveryStage === "terminal") return
			const known = await this.client.lookup(current.upstreamSubmissionKey)
			if (known) { await this.observe(current, known); return }
			// Empty lookup cannot settle cancellation: another same-key POST may still await readiness.
		}
		current = await this.mutate(current.runtimeJobId, current.revision, (latest) => latest.deliveryStage === "terminal" || latest.cancelRequestedAt && !latest.dispatchIntentAt ? null : { dispatchIntentAt: latest.dispatchIntentAt || now(), lastDispatchAt: now(), deliveryStage: "submitting", lastMilestone: "submitting" })
		if (current.deliveryStage === "terminal" || current.cancelRequestedAt && !current.dispatchIntentAt || this.draining) return
		if (!current.upstreamRequest) throw failure(503, "storage_unavailable", "The exact upstream request was not committed before dispatch.")
		// Reconciliation may revoke authority while lookup or durable intent writes await.
		if (!this.cloudAuthorized(current)) throw cloudError(503, "owner_reconciliation_required")
		try { await this.observe(current, await this.client.submit(current.upstreamSubmissionKey, current.upstreamRequest)) }
		catch (error) {
			if (error.upstreamRejected && !error.retryable && !current.dispatchUncertain && !["idempotency_conflict", "processor_identity_mismatch"].includes(error.error)) {
				await this.mutate(current.runtimeJobId, current.revision, (latest) => latest.processorJobId || latest.deliveryStage === "terminal" ? null : { deliveryStage: "terminal", outcome: "failed", dispatchRejectedAt: now(), error: report(error), finishedAt: now() })
				return
			}
			if (!error.upstreamRejected) await this.mutate(current.runtimeJobId, current.revision, (latest) => latest.deliveryStage === "terminal" ? null : { dispatchUncertain: true })
			throw error
		}
	}
	async poll(job) { return this.observe(job, await this.client.get(job.processorJobId)) }
	publicationPending(job) { return Boolean(job.deliveryStage === "terminal" && job.processorJobId && job.processorPublication?.state === "pending") }
	async track(job) {
		const current = await this.record(job.runtimeJobId)
		if (current.deliveryStage === "terminal") { if (this.publicationPending(current)) await this.poll(current); return }
		if (current.cancelRequestedAt && !terminal.has(current.processorState)) await this.observe(current, await this.client.cancel(current.processorJobId))
		else await this.poll(current)
	}
	async observe(job, upstream) {
		if (!upstream || typeof upstream.id !== "string" || upstream.submissionKey !== job.upstreamSubmissionKey || !Number.isSafeInteger(upstream.revision) || upstream.revision < 1 || !["queued", "running", "cancelling", ...terminal].includes(upstream.state)) throw failure(502, "processor_identity_mismatch", "The processor response does not bind this durable submission key.", { retryable: true })
		if (job.processorJobId && job.processorJobId !== upstream.id || job.processorScope && job.processorScope !== upstream.projectId) throw failure(502, "processor_identity_mismatch", "The processor job identity or state-root scope changed.", { retryable: true })
		const snapshot = upstream.source
		if (snapshot && (snapshot.sha256 !== job.sourceSha256 || snapshot.bytes !== job.sourceBytes || typeof snapshot.snapshotId !== "string")) throw failure(502, "snapshot_mismatch", "The processor snapshot differs from the retained source; local bytes remain held.", { retryable: true })
		await this.mutate(job.runtimeJobId, job.revision, (current) => {
			if (current.processorJobId && current.processorJobId !== upstream.id || current.processorScope && current.processorScope !== upstream.projectId) throw failure(502, "processor_identity_mismatch", "The observed processor identity conflicts with a newer durable mapping.", { retryable: true })
			const identity = { processorJobId: upstream.id, processorScope: upstream.projectId, ...(snapshot ? { snapshotId: snapshot.snapshotId, snapshotAcknowledgedAt: current.snapshotAcknowledgedAt || now() } : {}) }
			if (upstream.revision < current.processorRevision) return snapshot && !current.snapshotAcknowledgedAt ? identity : null
			if (current.deliveryStage === "terminal") {
				let publication = current.processorPublication
				if (upstream.revision > current.processorRevision && ["pending", "ready", "failed"].includes(upstream.documents?.state) && (!publication || publication.state === "pending" || publication.state === "failed" && upstream.documents.state === "ready")) publication = { state: upstream.documents.state }
				return { ...identity, processorRevision: upstream.revision, processorPublication: publication, processorPublicationError: null, lastCheckedAt: now(), attempts: 0, nextAttemptAt: publication?.state === "pending" ? new Date(Date.now() + this.config.queuedPollMs).toISOString() : null }
			}
			const finished = terminal.has(upstream.state)
			return { ...identity, processorState: upstream.state, processorRevision: upstream.revision, processorStage: upstream.stage || null, processorProgress: upstream.progress || null, processorInterruptedAt: upstream.interruptedAt ?? null, startedAt: upstream.startedAt ?? null, finishedAt: upstream.finishedAt ?? null, queueAhead: upstream.state === "queued" ? upstream.queueAhead ?? null : null, resolvedProfile: this.profileView(upstream.profile), modelSelection: modelSelectionView(upstream.modelSelection), processorHold: modelHoldView(upstream.hold), processorPublication: upstream.documents ? { state: upstream.documents.state } : null, resultId: upstream.resultId || current.resultId || null, resultAvailable: Boolean(upstream.resultId || current.resultAvailable), deliveryStage: finished ? "terminal" : "tracking", lastMilestone: "tracking", outcome: finished ? upstream.state : null, lastCheckedAt: now(), attempts: 0, nextAttemptAt: new Date(Date.now() + (upstream.state === "queued" ? this.config.queuedPollMs : this.config.runningPollMs)).toISOString(), error: upstream.error ? this.processorError(upstream.error) : null }
		})
	}
	processorError(error) {
		const denial = managedDenial(error)
		if (denial) return { status: error.status || 422, error: denial.code, message: denial.message, agent: "preprocessing", tool: "document-processing", retryable: false, action: denial.recovery }
		const code = /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code || "") ? error.code.toLowerCase() : "processing_failed"
		return report(failure(422, code, `Preprocessing reported ${code.replaceAll("_", " ")}.`, { agent: "preprocessing", retryable: false, action: "Inspect coverage and findings if results are available; use an explicit new request to rerun extraction." }))
	}
	profileView(profile) { return plain(profile) ? { id: logId(profile.id), profileDigest: logDigest(profile.profileDigest), ...(modelReference(profile.models?.vision) ? { model: modelReference(profile.models.vision) } : {}) } : null }
	async block(job, error) {
		const denial = managedDenial(error)
		if (denial) {
			await this.mutate(job.runtimeJobId, job.revision, (current) => ({ usagePaused: true, nextAttemptAt: current.cancelRequestedAt ? new Date(Date.now() + this.config.runningPollMs).toISOString() : null, error: { status: error.status, error: denial.code, message: denial.message, retryable: false, action: denial.recovery, agent: "preprocessing", tool: "document-processing" } }))
			return
		}
		if (!(error instanceof FileError)) error = failure(["ENOSPC", "EDQUOT"].includes(error.code) ? 507 : 503, ["ENOSPC", "EDQUOT"].includes(error.code) ? "insufficient_storage" : "storage_unavailable", "Private processing storage is unavailable; retained evidence is preserved.", { retryable: true, action: "Expand or repair retained storage, then retry delivery with its stored submission key." })
		const retryable = error.retryable ?? !(error.status >= 400 && error.status < 500 && ![429, 507].includes(error.status))
		await this.mutate(job.runtimeJobId, job.revision, (current) => {
			if (current.deliveryStage === "terminal" && !this.publicationPending(current)) return null
			if (!retryable && !current.dispatchIntentAt && !current.processorJobId) return { deliveryStage: "terminal", outcome: "failed", finishedAt: now(), error: report(error) }
			const attempts = (current.attempts || 0) + 1, base = Math.max(10, this.config.runningPollMs), wait = Math.min(60000, base * 2 ** Math.min(8, attempts - 1)) * (0.75 + Math.random() * 0.5)
			if (current.deliveryStage === "terminal") return { attempts, nextAttemptAt: new Date(Date.now() + wait).toISOString(), processorPublicationError: report(error) }
			return { deliveryStage: "blocked", attempts, nextAttemptAt: new Date(Date.now() + wait).toISOString(), error: report(error) }
		})
	}
	async failLocal(job, error) {
		return this.mutate(job.runtimeJobId, job.revision, (current) => current.dispatchIntentAt || current.processorJobId || current.deliveryStage === "terminal" ? null : { deliveryStage: "terminal", outcome: "failed", finishedAt: now(), error: report(error) })
	}
	async cancel(id) {
		let job = await this.record(id)
		if (job.deliveryStage !== "terminal") {
			job = await this.mutate(id, job.revision, (current) => current.deliveryStage === "terminal" ? null : { cancelRequestedAt: current.cancelRequestedAt || now(), nextAttemptAt: null })
			this.controllers.get(id)?.abort()
			if (!job.dispatchIntentAt && !job.processorJobId && !this.localWork.has(id) && !this.captureWork.has(id)) await this.settleLocalCancel(job)
			this.wake()
		}
		job = await this.record(id)
		return { status: job.deliveryStage === "terminal" ? 200 : 202, job: this.project(job) }
	}
	async settleLocalCancel(job) {
		if (this.localWork.has(job.runtimeJobId) || this.captureWork.has(job.runtimeJobId)) return
		if (job.captureRequestId) {
			const child = await this.state.get("requests", job.captureRequestId)
			if (child && !["succeeded", "failed", "cancelled", "interrupted"].includes(child.state)) { await this.workspace.captures.cancelJob(child.jobId); return }
		}
		await this.mutate(job.runtimeJobId, job.revision, (current) => current.dispatchIntentAt || current.processorJobId || current.deliveryStage === "terminal" ? null : { deliveryStage: "terminal", outcome: "cancelled", finishedAt: now(), error: null })
	}
	async cleanup(job) {
		try {
			let current = await this.record(job.runtimeJobId)
			if (!current.snapshotAcknowledgedAt && !(current.deliveryStage === "terminal" && (!current.dispatchIntentAt || current.dispatchRejectedAt || terminal.has(current.processorState)))) return
			if (!current.inboxRemovedAt) {
				let directory
				try {
					directory = await this.jobDirectory(current, false)
					for (const entry of await fs.readdir(`/proc/self/fd/${directory.fd}`)) {
						if (entry !== current.originalFilename && !/^\.[0-9a-f-]{36}\.partial$/.test(entry)) throw failure(503, "cleanup_blocked", "Unexpected private inbox evidence remains; inspect retained storage.")
						const name = `/proc/self/fd/${directory.fd}/${entry}`, stat = await fs.lstat(name)
						if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid()) throw failure(503, "cleanup_blocked", "Private inbox cleanup found unsafe evidence.")
						await fs.unlink(name)
					}
					await directory.sync(); await fs.rmdir(`/proc/self/fd/${this.inboxAnchor.fd}/${current.runtimeJobId}`); await this.inboxAnchor.sync()
				} catch (error) { if (error.code !== "ENOENT") throw error } finally { await directory?.close() }
				current = await this.mutate(current.runtimeJobId, current.revision, () => ({ inboxRemovedAt: now(), cleanupState: "pending" }))
			}
			if (!current.holdReleasedAt) {
				if (current.captureId) await this.workspace.captures.releaseHold(current.holdId)
				current = await this.mutate(current.runtimeJobId, current.revision, () => ({ holdReleasedAt: now(), cleanupState: "pending" }))
			}
			await this.mutate(current.runtimeJobId, current.revision, () => ({ cleanupState: "complete", cleanupError: null }))
		} catch (error) { await this.mutate(job.runtimeJobId, job.revision, () => ({ cleanupState: "blocked", cleanupError: report(error) })).catch((storageError) => { this.degraded = report(storageError) }) }
	}
	async checkDependency() {
		if (this.dependencyInflight) return this.dependencyInflight
		const expiredReady = (this.dependency?.ready || this.dependency?.executionReady) && !freshDependency(this.dependency)
		if (!expiredReady && Date.now() - (this.dependencyCheckedMs || 0) < Math.min(10000, this.config.queuedPollMs)) return
		this.dependencyCheckedMs = Date.now()
		this.dependencyInflight = this.observeDependency().finally(() => { this.dependencyInflight = null })
		return this.dependencyInflight
	}
	async observeDependency() {
		try {
			const value = await this.client.capabilities()
			this.dependency = dependencyView(value.dependency)
			this.processorLimits = Object.fromEntries(["inputBytes", "outputBytes", "responseBytes"].filter((key) => Number.isSafeInteger(value.limits?.[key]) && value.limits[key] > 0).map((key) => [key, value.limits[key]]))
			this.upstreamActivity = value.activity || {}
			this.upstreamActivityCheckedAt = now()
			const interest = Boolean(value.activity?.settlementUnknown || value.activity?.unsettledOperations || value.activity?.predecessorPending || value.activity?.activeJobId || value.activity?.activeJobs)
			if (interest !== Boolean(this.settlementInterestAt)) {
				const settlementInterestAt = interest ? now() : null
				await this.state.put("processing-requests", "internal:activity", { ...this.identity, type: "activity", settlementInterestAt })
				this.settlementInterestAt = settlementInterestAt
			}
			if (value.activity?.settlementUnknown && !value.activity.activeJobId && Date.now() >= (this.nextRecovery || 0)) {
				try { const result = await this.client.reconcile(); this.recovery = { settled: result.settled === true, checkedAt: now() }; this.recoveryAttempts = result.settled ? 0 : (this.recoveryAttempts || 0) + 1 }
				catch { this.recoveryAttempts = (this.recoveryAttempts || 0) + 1; this.recovery = { settled: false, checkedAt: now(), error: report(failure(503, "ownership_recovery_required", "Processor ownership settlement remains unresolved.", { retryable: true, action: "Run the private preprocessing engine reconciliation command after checking extraction ownership." })) } }
				this.nextRecovery = Date.now() + Math.min(60000, Math.max(10, this.config.queuedPollMs) * 2 ** Math.min(8, this.recoveryAttempts))
				await this.state.put("processing-requests", "internal:recovery", { ...this.identity, type: "recovery", report: this.recovery })
				this.emit(this.recovery.settled ? "processing.recovery.settled" : "processing.recovery.blocked")
			}
		} catch (error) { this.dependency = { state: "unavailable", ready: false, executionReady: false, observedAt: null, checkedAt: now(), error: report(error) } }
	}
	project(job) {
		return { id: job.runtimeJobId, runtimeJobId: job.runtimeJobId, ...this.identity, requestId: job.requestId, trigger: job.trigger, uploadOperationId: job.uploadOperationId || null, rerunOf: job.rerunOf || null, source: { ...job.originalSourceRef, ...(job.historicalRef ? { ref: job.historicalRef } : {}), captureId: job.captureId || null, filename: job.originalFilename || null, sha256: job.sourceSha256 || null, sizeBytes: job.sourceBytes ?? null, consistency: job.sourceConsistency || null, observation: job.originalObservation || null }, requestedOptions: job.requestedOptions, createdAt: job.createdAt, updatedAt: job.updatedAt || job.createdAt, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null, interruptedAt: job.processorInterruptedAt ?? null, revision: job.revision, deliveryStage: job.deliveryStage, state: job.outcome || job.processorState || job.deliveryStage, cancelRequestedAt: job.cancelRequestedAt || null, processorState: job.processorState || null, processorRevision: job.processorRevision || null, processorJobId: job.processorJobId || null, stage: job.processorStage || null, progress: job.processorProgress || null, queueAhead: job.processorState === "queued" ? job.queueAhead ?? null : null, resolvedProfile: job.resolvedProfile || null, modelSelection: job.modelSelection || null, hold: job.processorHold || null, processorPublication: job.processorPublication ? { ...job.processorPublication, ...(job.processorPublicationError ? { error: job.processorPublicationError } : {}) } : null, resultId: job.resultId || null, resultAvailable: job.resultAvailable, resultsUrl: job.resultAvailable ? `/files/processing/jobs/${job.runtimeJobId}/results` : null, lastCheckedAt: job.lastCheckedAt || null, nextAttemptAt: job.nextAttemptAt || null, cleanupState: job.cleanupState, error: job.error || null, ...(job.activityKeepaliveExpiredAt ? { activityKeepaliveExpiredAt: job.activityKeepaliveExpiredAt, activityWarning: "activity_keepalive_expired" } : {}) }
	}
	async get(id) { return this.project(await this.record(id)) }
	async list({ limit, cursor, uploadOperationId } = {}) {
		const count = budget(limit, 50, 200, "limit")
		if (uploadOperationId !== undefined) identifier(uploadOperationId)
		let before = null, ceiling = now()
		if (cursor) {
			try { const value = JSON.parse(Buffer.from(cursor, "base64url").toString()); if (value.epoch !== this.identity.workspaceEpoch || value.uploadOperationId !== (uploadOperationId || null) || typeof value.before !== "string" || typeof value.ceiling !== "string") throw new Error(); before = value.before; ceiling = value.ceiling }
			catch { throw failure(400, "invalid_cursor", "The processing cursor is invalid for this workspace epoch or filter.") }
		}
		const key = (job) => `${job.createdAt}/${job.runtimeJobId}`
		const jobs = (await this.records()).filter((job) => job.createdAt <= ceiling && (!before || key(job) < before) && (!uploadOperationId || job.uploadOperationId === uploadOperationId)).sort((a, b) => key(b).localeCompare(key(a))), page = jobs.slice(0, count)
		return { jobs: page.map((job) => this.project(job)), nextCursor: jobs.length > count ? Buffer.from(JSON.stringify({ epoch: this.identity.workspaceEpoch, uploadOperationId: uploadOperationId || null, ceiling, before: key(page.at(-1)) })).toString("base64url") : null }
	}
	async activity() {
		const jobs = await this.records(), expired = [], active = []
		const claims = await this.unmatchedAdmissions(jobs)
		this.pruneReservations(jobs)
		for (const job of jobs.filter((job) => job.deliveryStage !== "terminal")) {
			if (this.config.activityMaxAgeMs > 0 && Date.now() - Date.parse(job.createdAt) >= this.config.activityMaxAgeMs) {
				if (!job.activityKeepaliveExpiredAt) await this.mutate(job.runtimeJobId, job.revision, () => ({ activityKeepaliveExpiredAt: now() }))
				expired.push(job.runtimeJobId)
			} else active.push(job.runtimeJobId)
		}
		let reservationInterest = 0
		for (const admission of [...this.reservations.values(), ...claims.map((request) => ({ jobId: request.runtimeJobId, createdAt: request.initialJob.createdAt }))]) if (!this.config.activityMaxAgeMs || Date.now() - Date.parse(admission.createdAt) < this.config.activityMaxAgeMs) reservationInterest++; else expired.push(admission.jobId)
		const unsettled = Boolean(this.settlementInterestAt), settlementExpired = unsettled && this.config.activityMaxAgeMs > 0 && Date.now() - Date.parse(this.settlementInterestAt) >= this.config.activityMaxAgeMs
		const busy = active.length > 0 || reservationInterest > 0 || unsettled && !settlementExpired
		return { active: busy, state: busy ? "prompt_running" : "idle", session_id: null, checkedAt: now(), activeJobs: active.length, reservations: this.reservations.size + claims.length, unknownSettlement: Boolean(this.upstreamActivity?.settlementUnknown), settlementInterestExpiredAt: settlementExpired ? new Date(Date.parse(this.settlementInterestAt) + this.config.activityMaxAgeMs).toISOString() : null, expiredJobs: expired, ...(expired.length || settlementExpired ? { warning: "activity_keepalive_expired", action: "Extend or disable the activity age cap; expired work remains accepted and may be stopped by backend idle policy." } : {}) }
	}
	async observeStorage(body) {
		if (!plain(body) || !Number.isFinite(Date.parse(body.observedAt)) || typeof body.complete !== "boolean") throw failure(400, "invalid_request", "Storage observation requires a timestamp and completeness flag.")
		const measurement = { observedAt: new Date(body.observedAt).toISOString(), complete: body.complete }
		for (const key of ["processorDataBytes", "diskFreeBytes", "runtimeHeadroomBytes", "sealedResults", "entries", "files", "symlinksSkipped"]) if (Object.hasOwn(body, key)) {
			if (!Number.isSafeInteger(body[key]) || body[key] < 0) throw failure(400, "invalid_request", `Storage ${key} must be a nonnegative safe byte/count value.`)
			measurement[key] = body[key]
		}
		for (const key of ["oldestFileAt", "oldestResultAt"]) if (body[key] !== undefined && body[key] !== null) {
			if (!Number.isFinite(Date.parse(body[key]))) throw failure(400, "invalid_request", `Storage ${key} must be a timestamp.`)
			measurement[key] = new Date(body[key]).toISOString()
		}
		if (/^[0-9a-f]{64}$/.test(body.bundleDigest || "")) measurement.bundleDigest = body.bundleDigest
		if (plain(body.pair) && ["unconfigured", "starting", "unavailable", "cooldown", "draining", "stopped"].includes(body.pair.state) && ["attempts", "totalLaunches", "burstCount"].every((key) => nonnegativeCount(body.pair[key]) !== null) && typeof body.pair.childAlive === "boolean" && Number.isSafeInteger(body.pair.cooldownMs) && body.pair.cooldownMs > 0 && (body.pair.nextRetryAt === null || dateObservation(body.pair.nextRetryAt))) measurement.pair = { state: body.pair.state, attempts: body.pair.attempts, totalLaunches: body.pair.totalLaunches, burstCount: body.pair.burstCount, childAlive: body.pair.childAlive, cooldownMs: body.pair.cooldownMs, nextRetryAt: dateObservation(body.pair.nextRetryAt) }
		if (plain(body.activity)) measurement.activity = { unknown: body.activity.unknown === true, expired: Array.isArray(body.activity.expired) ? body.activity.expired.slice(0, 200).filter((entry) => plain(entry) && typeof entry.id === "string" && entry.id.length <= 128 && Number.isFinite(Date.parse(entry.expiredAt))).map((entry) => ({ id: entry.id, expiredAt: new Date(entry.expiredAt).toISOString(), reason: "activity_keepalive_expired" })) : [], observedAt: now() }
		if (this.storageObservation && Date.parse(measurement.observedAt) < Date.parse(this.storageObservation.observedAt)) return { accepted: false, reason: "stale_observation" }
		try {
			await this.state.put("processing-requests", "internal:storage", { ...this.identity, type: "storage", measurement })
			this.storageObservation = measurement
			return { accepted: true, observedAt: measurement.observedAt }
		} catch (error) { this.degraded = report(error); throw error }
	}
	async storageUsage(jobs) {
		const holds = new Set((await this.state.list("holds")).map((hold) => hold.holdId)), captures = new Map()
		for (const job of jobs) if (!job.holdReleasedAt && holds.has(job.holdId)) captures.set(job.captureId, job.sourceBytes || 0)
		let inboxBytes = 0, incomplete = false
		try {
			await this.assertInbox()
			for (const entry of await fs.readdir(`/proc/self/fd/${this.inboxAnchor.fd}`)) {
				if (!runtimeId.test(entry)) { incomplete = true; continue }
				let dir
				try { dir = await this.jobDirectory({ runtimeJobId: entry }, false); for (const name of await fs.readdir(`/proc/self/fd/${dir.fd}`)) { const stat = await fs.lstat(`/proc/self/fd/${dir.fd}/${name}`); if (stat.isFile()) inboxBytes += stat.size; else incomplete = true } } catch { incomplete = true } finally { await dir?.close() }
			}
		} catch { incomplete = Boolean(jobs.some((job) => !job.inboxRemovedAt)) }
		const heldInputBytes = [...captures.values()].reduce((sum, size) => sum + size, 0)
		const measured = this.storageObservation || {}, outputBytes = this.processorLimits?.outputBytes || 512 * 1024 * 1024
		const projectedHeadroomBytes = 2 * this.config.inputBytes + 2 * outputBytes + (measured.runtimeHeadroomBytes || 0)
		const reserveBytes = this.config.storageReserveBytes ?? projectedHeadroomBytes
		const warnings = []
		if (this.config.heldWarningBytes > 0 && heldInputBytes + inboxBytes >= this.config.heldWarningBytes) warnings.push("held_input_warning")
		if (reserveBytes > 0 && measured.diskFreeBytes !== undefined && measured.diskFreeBytes < reserveBytes) warnings.push("free_space_warning")
		return { ...measured, heldInputBytes, inboxBytes, totalRuntimeInputBytes: heldInputBytes + inboxBytes, cleanupPendingBytes: jobs.filter((job) => job.cleanupState !== "complete" && job.snapshotAcknowledgedAt).reduce((sum, job) => sum + (!job.holdReleasedAt && holds.has(job.holdId) ? job.sourceBytes || 0 : 0) + (!job.inboxRemovedAt && job.inboxPublishedAt ? job.sourceBytes || 0 : 0), 0), reserveBytes, projectedHeadroomBytes, runtimeHeadroomMeasured: Number.isSafeInteger(measured.runtimeHeadroomBytes), accountingFresh: Boolean(measured.observedAt && Date.now() - Date.parse(measured.observedAt) < 120000), checkedAt: now(), incomplete: incomplete || measured.complete !== true, warnings, warning: warnings[0] || null }
	}
	async capabilities() {
		await this.checkDependency()
		const jobs = await this.records(), activity = await this.activity()
		const claims = await this.unmatchedAdmissions(jobs), pending = [...jobs.filter((job) => job.deliveryStage !== "terminal" && !job.processorJobId), ...claims.map((request) => request.initialJob)], reserved = [...this.reservations.values(), ...claims.map((request) => request.initialJob)]
		const oldest = (records) => records.reduce((first, record) => { const time = Date.parse(record.createdAt); return Number.isFinite(time) ? Math.min(first, time) : first }, Infinity)
		const pendingAt = oldest(pending), reservationAt = oldest(reserved), timestamp = Date.now(), skips = Object.fromEntries(skipReasons.map((reason) => [reason, 0]))
		for (const op of await this.state.list("operations")) if (this.publicUpload(op) && op.processing?.state === "skipped" && skipReasons.includes(op.processing.reason)) skips[op.processing.reason]++
		const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null, observed = this.upstreamActivity || {}
		const backlog = { activeTickets: jobs.filter((job) => job.deliveryStage !== "terminal").length, pendingDelivery: pending.length, reservations: activity.reservations, blocked: jobs.filter((job) => job.deliveryStage === "blocked").length, cleanupPending: jobs.filter((job) => job.cleanupState !== "complete").length, oldestPendingAt: Number.isFinite(pendingAt) ? new Date(pendingAt).toISOString() : null, oldestPendingAgeMs: Number.isFinite(pendingAt) ? Math.max(0, timestamp - pendingAt) : null, oldestReservationAt: Number.isFinite(reservationAt) ? new Date(reservationAt).toISOString() : null, oldestReservationAgeMs: Number.isFinite(reservationAt) ? Math.max(0, timestamp - reservationAt) : null, cleanupFailures: jobs.filter((job) => job.cleanupState === "blocked").length, interrupted: jobs.filter((job) => job.outcome === "interrupted" || job.processorState === "interrupted").length, unknownAdmission: jobs.filter((job) => job.deliveryStage !== "terminal" && job.dispatchIntentAt && !job.processorJobId).length, unknownSettlement: observed.settlementUnknown === true, unsettledOperations: count(observed.unsettledOperations), skipReasons: skips, processorQueued: count(observed.queuedJobs), processorRunning: count(observed.runningJobs) ?? (observed.activeJobId === null ? 0 : typeof observed.activeJobId === "string" ? 1 : null), processorCheckedAt: this.upstreamActivityCheckedAt || null }
		const dependency = this.dependency ? { ...this.dependency, ...(!freshDependency(this.dependency) ? { ready: false, executionReady: false } : {}) } : { state: "unknown", ready: false, executionReady: false, observedAt: null, checkedAt: null }
		return { enabled: Boolean(this.config.enabled && this.config.aggregateActivity && !this.draining && !this.closed), aggregateActivity: this.config.aggregateActivity, extensions, formats: extensions.map((extension) => ({ extension, mayUseModel: extension === ".pdf" })), profile: { id: this.config.profileId, model: this.config.model || null }, defaultUploadPolicy: "auto", limits: { inputBytes: this.config.inputBytes, activeTickets: this.config.activeTickets, jsonBytes: this.config.jsonBytes, heldWarningBytes: this.config.heldWarningBytes, activityMaxAgeMs: this.config.activityMaxAgeMs }, dependency, backlog, storage: await this.storageUsage(jobs), activity, recovery: this.recovery || null, degraded: this.degraded, checkedAt: now() }
	}
	async inventory(id) {
		const job = await this.record(id)
		if (!job.processorJobId || !job.resultAvailable) throw failure(409, "result_not_available", "Sealed results have not been committed yet.", { retryable: true, action: "Poll this processing job until resultAvailable is true." })
		const manifest = await this.client.results(job.processorJobId)
		if (manifest.jobId !== job.processorJobId || manifest.resultId !== job.resultId || manifest.source?.sha256 !== job.sourceSha256 || manifest.source?.bytes !== job.sourceBytes || job.snapshotId && manifest.source?.snapshotId !== job.snapshotId || !Array.isArray(manifest.products) || !Array.isArray(manifest.tables)) throw failure(502, "result_identity_mismatch", "The sealed manifest does not bind this runtime source.")
		const products = new Map(), tables = new Map()
		for (const item of manifest.products) {
			if (!plain(item) || typeof item.id !== "string" || products.has(item.id)) throw failure(502, "invalid_result_inventory", "Product IDs must be unique.")
			identifier(item.id); canonicalPath(item.path, { root: false })
			if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[0-9a-f]{64}$/.test(item.sha256 || "") || typeof item.mediaType !== "string") throw failure(502, "invalid_result_inventory", "Product byte metadata is invalid.")
			products.set(item.id, item)
		}
		for (const table of manifest.tables) {
			if (!plain(table) || typeof table.id !== "string" || tables.has(table.id) || !Number.isSafeInteger(table.rows) || table.rows < 0 || !Array.isArray(table.columns) || !Array.isArray(table.downloads) || table.downloads.some((download) => !plain(download) || !["csv", "typed-jsonl"].includes(download.format) || !products.has(download.productId))) throw failure(502, "invalid_result_inventory", "Table downloads must reference sealed products and valid row/column metadata.")
			identifier(table.id); tables.set(table.id, table)
		}
		return { job, manifest, products, tables }
	}
	translate(inventory) {
		const { job, manifest, products } = inventory, base = `/files/processing/jobs/${job.runtimeJobId}`
		const byPath = new Map([...products.values()].map((item) => [item.path, { productId: item.id, contentUrl: `${base}/products/${item.id}` }]))
		const references = (value) => typeof value === "string" ? byPath.get(value) || null : Array.isArray(value) ? value.map(references).filter(Boolean) : plain(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, references(child)]).filter(([, child]) => child !== null)) : null
		const scrub = (value) => {
			if (Array.isArray(value)) return value.map(scrub)
			if (!plain(value)) return value
			const result = {}
			for (const [key, child] of Object.entries(value)) {
				if (/token|credential|authorization|secret|provider|^origin$|^requestedSource$|^projectId$|^submissionKey$/i.test(key) || /Url$/i.test(key)) continue
				if (key === "path") continue
				if (/Paths?$/i.test(key)) { const mapped = references(child); if (mapped) result[key.replace(/Paths$/i, "Products").replace(/Path$/i, "Product")] = mapped; continue }
				result[key] = scrub(child)
			}
			return result
		}
		const publicLocator = (source) => {
			const locator = normalizeLocator(source, job), result = scrub(locator)
			if (locator.bounds?.origin !== undefined) result.bounds.origin = locator.bounds.origin
			return result
		}
		const publicItem = (item) => ({ ...scrub(item), ...(item.source !== undefined ? { source: publicLocator(item.source) } : {}) })
		const view = scrub(manifest)
		view.jobId = job.runtimeJobId; view.processorJobId = job.processorJobId; view.source = this.project(job).source
		view.products = manifest.products.map((item) => ({ ...publicItem(item), filename: path.posix.basename(item.path), contentUrl: `${base}/products/${item.id}`, ...(item.mediaType.split(";", 1)[0] === "text/csv" ? { spreadsheetFormulaPolicy: "preserve" } : {}) }))
		view.tables = manifest.tables.map((table) => ({ ...publicItem(table), rowsUrl: `${base}/tables/${table.id}/rows`, downloads: table.downloads.map((download) => ({ ...scrub(download), contentUrl: `${base}/products/${download.productId}`, ...(download.format === "csv" ? { spreadsheetFormulaPolicy: "preserve" } : {}) })) }))
		for (const key of ["figures", "findings"]) if (Array.isArray(manifest[key])) view[key] = manifest[key].map(publicItem)
		return view
	}
	async results(id) { const inventory = await this.inventory(id); return { jobId: id, source: this.project(inventory.job).source, resultId: inventory.job.resultId, view: "translated-api-manifest", manifest: this.translate(inventory) } }
	async rows(id, tableId, { offset = 0, limit = 100 } = {}) {
		if (!Number.isSafeInteger(Number(offset)) || Number(offset) < 0 || !Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 1000) throw failure(400, "invalid_query", "Rows require offset >= 0 and limit from 1 to 1000.")
		const inventory = await this.inventory(id)
		if (!inventory.tables.has(tableId)) throw failure(404, "not_found", "The table is not listed in this sealed result.")
		const table = this.translate(inventory).tables.find((item) => item.id === tableId)
		try {
			const result = await this.client.rows(inventory.job.processorJobId, tableId, { offset: Number(offset), limit: Number(limit) })
			if (result.offset !== Number(offset) || !Array.isArray(result.rows) || result.count !== result.rows.length || result.rows.length > Number(limit) || result.total !== inventory.tables.get(tableId).rows || result.nextOffset !== null && (!Number.isSafeInteger(result.nextOffset) || result.nextOffset <= Number(offset))) throw failure(502, "processor_protocol_error", "The processor returned invalid row pagination metadata.")
			const located = (item) => ({ ...item, ...(item.source !== undefined ? { source: normalizeLocator(item.source, inventory.job) } : {}) })
			const cell = (item) => ({ ...located(item), ...(item.type === "formula" && item.cached != null ? { cached: cell(item.cached) } : {}) })
			const rows = result.rows.map((row) => ({ ...located(row), cells: row.cells.map(cell) }))
			return { offset: result.offset, count: result.count, total: result.total, columns: inventory.tables.get(tableId).columns, rows, nextOffset: result.nextOffset, jobId: id, tableId, downloads: table.downloads }
		} catch (error) { if (["row_too_large", "response_too_large"].includes(error.error)) error.downloads = table.downloads; throw error }
	}
	async product(id, productId, request = {}) {
		const inventory = await this.inventory(id), product = inventory.products.get(productId)
		if (!product) throw failure(404, "not_found", "The product is not listed in this sealed result.")
		const response = await this.client.product(inventory.job.processorJobId, productId, request), headers = new Headers(response.headers)
		if (response.status === 416) return response
		const name = path.posix.basename(product.path).replace(/[\r\n"\\]/g, "_")
		headers.set("content-disposition", `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`)
		headers.set("content-type", product.mediaType)
		headers.set("x-content-type-options", "nosniff")
		return new Response(response.body, { status: response.status, headers })
	}
	async drain(deadline = Date.now() + 30000) {
		this.draining = true; clearTimeout(this.timer)
		for (const controller of this.controllers.values()) controller.abort()
		const end = typeof deadline === "number" ? deadline : Date.parse(deadline)
		if (!Number.isFinite(end)) throw failure(400, "invalid_request", "A processing drain deadline must be a timestamp.")
		let timer
		try { await Promise.race([Promise.allSettled([this.admissionTail, this.running, this.sampling, ...this.localWork.values(), ...this.captureWork.values()].filter(Boolean)), new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, end - Date.now())) })]) } finally { clearTimeout(timer) }
		const jobs = await this.records()
		const localPending = this.localWork.size + this.captureWork.size + (this.running ? 1 : 0) + (this.sampling ? 1 : 0)
		return { complete: !localPending, localPending, remotePending: jobs.filter((job) => job.deliveryStage !== "terminal").length, indeterminate: jobs.filter((job) => job.dispatchIntentAt && !job.processorJobId).length }
	}
	async close() {
		if (this.closing) return this.closing
		this.closing = (async () => { await this.drain(Date.now() + this.config.transportMs + 1000); await Promise.allSettled([this.running, this.sampling, this.admissionTail, ...this.localWork.values(), ...this.captureWork.values(), ...this.mutations.values()].filter(Boolean)); await this.inboxAnchor?.close(); this.inboxAnchor = null; this.closed = true })()
		return this.closing
	}
}
