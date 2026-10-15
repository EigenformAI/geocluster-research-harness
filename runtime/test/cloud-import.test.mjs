import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import { spawn } from "node:child_process"
import http from "node:http"
import { FilesApi } from "../lib/files.js"
import { buildFilesOpenApi } from "../lib/files-openapi.js"
import { WorkspaceFiles } from "../lib/workspace-files.js"
import { cloudPath, pathKey, sameOwner, stableId } from "../lib/cloud-file-contract.js"
import { createFilesServer } from "../files-server.js"
import { stableStringify } from "../lib/file-contract.js"
import { BackendFileAdapter } from "../lib/backend-file-adapter.js"

const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex")
const logger = { info() {}, warn() {}, error() {} }
const bytes = "x,y\n1,2\n"
const terminal = new Set(["succeeded", "partial", "failed", "cancelled", "interrupted"])
const entry = (name = "data.csv", seq = 1, body = bytes) => ({ path: name, kind: "file", headToken: crypto.randomUUID(), fileVersionId: crypto.randomUUID(), changeSeq: seq, sizeBytes: Buffer.byteLength(body), sha256: digest(body) })
class Backend {
	constructor() { this.aligned = true; this.processingEnabled = true; this.runtimeId = crypto.randomUUID(); this.heads = []; this.changes = []; this.claims = []; this.permits = []; this.acks = []; this.reconciles = []; this.settlements = []; this.failures = []; this.content = new Map(); this.work = new Map(); this.receipts = new Map(); this.permitRequests = new Map(); this.terminalSettlements = new Map(); this.progressByWork = new Map(); this.progressReports = []; this.fencedOwners = new Set(); this.lostAck = false; this.lostSettlement = false }
	error(code) { return Object.assign(new Error(code), { status: 409, error: code }) }
	receiptKey(claim) { return `${claim.workId}:${claim.runtimeId}:${claim.workspaceEpoch}` }
	bind(workspace) { this.workspace = workspace }
	async snapshot() { return { snapshotId: "snapshot", throughSeq: this.changes.at(-1)?.changeSeq || 0, entries: this.heads, nextCursor: null } }
	async changesAfter(seq) { return { afterSeq: seq, throughSeq: this.changes.at(-1)?.changeSeq || seq, changes: this.changes.filter((c) => c.changeSeq > seq), nextCursor: null } }
	async source(version) { return { fileVersionId: version, objectIdentity: version, ...this.content.get(version), requiredHeaders: { "If-Match": '"sealed"' } } }
	async checkHead(entry) { if (!this.heads.some((head) => head.path === entry.path && head.headToken === entry.headToken)) throw Object.assign(new Error("head changed"), { status: 409, error: "head_changed" }) }
	async download(source) { return Readable.from([Buffer.from(this.content.get(source.fileVersionId).body)]) }
	add(head, policy = "auto", body = bytes) {
		this.heads = this.heads.filter((e) => e.path !== head.path).concat(head)
		this.content.set(head.fileVersionId, { body, sizeBytes: Buffer.byteLength(body), sha256: digest(body) })
		this.changes.push({ changeSeq: head.changeSeq, entries: [head] })
		const workId = crypto.randomUUID(), operationId = `import:${workId}:${this.workspace.identity.workspaceEpoch}`
		const claim = { workId, attemptId: crypto.randomUUID(), attemptRevision: 1, runtimeId: this.runtimeId, ...this.workspace.identity, operationId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), source: { fileVersionId: head.fileVersionId, objectIdentity: head.fileVersionId, sizeBytes: head.sizeBytes, sha256: head.sha256, requiredHeaders: { "If-Match": '"sealed"' } }, destination: { path: head.path, headToken: head.headToken, changeSeq: head.changeSeq }, processingPolicy: policy, processingProfileId: "default", processingRequestId: `auto:${workId}`, processingReceipt: null, publicationPermit: null, processingPermit: null, recovery: "new" }
		if (policy === "skip" || !this.processingEnabled) claim.processingReceipt = { state: "skipped", reason: policy === "skip" ? "policy-skip" : "processing-disabled" }
		this.claims.push(claim); this.work.set(workId, claim); return claim
	}
	async claim(requestId) {
		this.claimResponses ||= new Map()
		if (requestId && this.claimResponses.has(requestId)) return structuredClone(this.claimResponses.get(requestId))
		// Queued fixture claims model the backend's live-lease exclusion. Ordinary
		// polls do not requeue them; recovery tests explicitly enqueue reassignment.
		const claims = this.claims.splice(0, 10)
		for (const claim of claims) {
			if (this.progressByWork.get(claim.workId)?.attemptId !== claim.attemptId) this.progressByWork.delete(claim.workId)
			this.work.set(claim.workId, claim)
		}
		const response = { claims, pollAfterSeconds: 5 }
		if (requestId) this.claimResponses.set(requestId, structuredClone(response))
		return response
	}
	async progress(claim, value) {
		const current = this.work.get(claim.workId), old = this.progressByWork.get(claim.workId)
		if (!current || !sameOwner(current, claim) || current.attemptId !== claim.attemptId || current.attemptRevision !== claim.attemptRevision) throw this.error("stale_claim")
		if (!(Date.parse(current.leaseExpiresAt) > Date.now())) throw this.error("claim_expired")
		if (old && value.progressSeq === old.value.progressSeq && stableStringify(value) === stableStringify(old.value)) return {}
		if (value.progressSeq <= (old?.value.progressSeq || 0)) throw this.error("stale_progress")
		if (value.downloadedBytes < 0 || value.downloadedBytes > current.source.sizeBytes) throw this.error("invalid_progress")
		this.progressByWork.set(claim.workId, { attemptId: claim.attemptId, value: structuredClone(value) })
		this.progressReports.push({ workId: claim.workId, attemptId: claim.attemptId, ...structuredClone(value) })
		return {}
	}
	async getWork(workId) {
		const work = this.work.get(workId), owner = { runtimeId: this.runtimeId, ...this.workspace.identity }, permits = this.permits.filter((p) => p.workId === workId), other = permits.filter((p) => !sameOwner(p, owner))
		const recovery = other.some((p) => !this.fencedOwners.has(p.runtimeId)) ? "wait-owner" : other.length ? "rehydrate" : permits.length ? "reconcile" : work.recovery
		const publicationPermit = permits.findLast((p) => p.kind === "publication" && sameOwner(p, owner)), processingPermit = permits.find((p) => p.kind === "processing")
		const action = ["wait-owner", "rehydrate"].includes(recovery) ? recovery : work.processingReceipt?.state === "ticket" ? "reuse-ticket" : work.processingReceipt?.state === "skipped" ? "record-skip" : "resume-publication"
		return { ...work, publicationPermit, processingPermit, recovery, action }
	}
	async permit(claim, kind, receiptId, publicationPermitId, requestId = stableId(`${claim.runtimeId}:${claim.workspaceId}:${claim.workspaceEpoch}:${claim.operationId}:${kind}`)) {
		const body = { attemptId: claim.attemptId, attemptRevision: claim.attemptRevision, kind, operationId: claim.operationId, receiptId, publicationPermitId: publicationPermitId || null }, previous = this.permitRequests.get(`${claim.workId}:${requestId}`)
		if (previous) { if (!sameOwner(previous.permit, claim) || stableStringify(previous.body) !== stableStringify(body)) throw this.error("request_id_reused"); return previous.permit }
		const current = this.work.get(claim.workId)
		if (!current || !sameOwner(current, claim) || current.attemptId !== claim.attemptId || current.attemptRevision !== claim.attemptRevision) throw this.error("stale_claim")
		if (claim.operationId !== current.operationId || !receiptId) throw this.error("operation_mismatch")
		const existing = this.permits.find((p) => p.workId === claim.workId && p.kind === kind && (kind === "processing" || p.runtimeId === claim.runtimeId))
		if (existing) { if (kind === "processing") throw this.error("permit_unsettled"); if (!sameOwner(existing, claim) || existing.receiptId !== receiptId || existing.operationId !== claim.operationId) throw this.error("owner_reconciliation_required"); return existing }
		if ((await this.getWork(claim.workId)).recovery === "wait-owner") throw this.error("owner_reconciliation_required")
		if (!(Date.parse(claim.leaseExpiresAt) > Date.now())) throw this.error("claim_expired")
		const head = this.heads.find((e) => e.path === claim.destination.path)
		if (head?.headToken !== claim.destination.headToken) throw Object.assign(new Error("superseded"), { status: 409, error: "head_changed" })
		if (!this.receipts.has(this.receiptKey(claim)) && !["verified", "published", "awaiting-capacity", "processing-linked"].includes(this.progressByWork.get(claim.workId)?.value.stage)) throw this.error("source_not_verified")
		if (kind === "processing") {
			if (!this.permits.some((p) => p.permitId === publicationPermitId && p.kind === "publication" && sameOwner(p, claim) && p.receiptId === receiptId)) throw this.error("publication_permit_required")
			if (!this.processingEnabled || claim.processingPolicy !== "auto" || claim.processingReceipt?.state === "skipped") throw this.error("processing_not_requested")
		}
		const p = { permitId: crypto.randomUUID(), ownerRevision: 1 + Math.max(0, ...this.permits.filter((p) => p.workId === claim.workId && p.kind === kind).map((p) => p.ownerRevision)), kind, runtimeId: this.runtimeId, ...this.workspace.identity, state: "granted", workId: claim.workId, receiptId, operationId: claim.operationId }
		this.permits.push(p); this.permitRequests.set(`${claim.workId}:${requestId}`, { body, permit: p }); return p
	}
	recordReceipt(claim, record) {
		const pub = this.permits.find((p) => p.permitId === record.receipt.publicationPermitId), proc = this.permits.find((p) => p.workId === claim.workId && p.kind === "processing"), processing = record.processingReceipt
		if (!pub || !sameOwner(pub, claim) || pub.receiptId !== record.receipt.receiptId || pub.operationId !== record.receipt.operationId) throw this.error("publication_permit_mismatch")
		if (record.receipt.workspaceId !== claim.workspaceId || record.receipt.workspaceEpoch !== claim.workspaceEpoch || record.receipt.fileVersionId !== claim.source.fileVersionId || record.receipt.sha256 !== claim.source.sha256 || record.receipt.path !== claim.destination.path || record.receipt.cloudHeadToken !== claim.destination.headToken || !record.receipt.localGeneration || processing.requestId !== claim.processingRequestId || processing.sourceFileVersionId !== claim.source.fileVersionId) throw this.error("receipt_mismatch")
		if (processing.state === "ticket" && (!proc || !sameOwner(proc, claim) || processing.processingPermitId !== proc.permitId)) throw this.error("processing_permit_required")
		if (processing.state === "ticket" && (!processing.ticketId || !processing.processorSubmissionKey)) throw this.error("processing_permit_required")
		if (processing.state === "awaiting-capacity" && (proc || !this.processingEnabled || claim.processingPolicy !== "auto" || ["ticketId", "processingPermitId", "processorSubmissionKey", "processorJobId"].some((key) => processing[key] != null))) throw this.error("invalid_processing_state")
		if (processing.state === "skipped" && (proc ? !sameOwner(proc, claim) || processing.processingPermitId !== proc.permitId : processing.processingPermitId != null)) throw this.error("invalid_processing_state")
		if (processing.state === "skipped" && (processing.ticketId || processing.processorSubmissionKey || processing.processorJobId || !["policy-skip", "processing-disabled", "unsupported-format", "too-large", "source-superseded"].includes(processing.reason))) throw this.error("invalid_skip_reason")
		if (processing.state === "skipped" && processing.reason !== claim.processingReceipt?.reason && !(processing.reason === "processing-disabled" && !this.processingEnabled)) throw this.error("invalid_skip_reason")
		if (processing.state === "historical" && proc && sameOwner(proc, claim)) throw this.error("historical_receipt_mismatch")
		const key = this.receiptKey(claim), previous = this.receipts.get(key)
		if (previous) {
			if (record.observedProcessing && terminal.has(previous.observedProcessing?.state) && stableStringify(previous.observedProcessing) !== stableStringify(record.observedProcessing)) throw this.error("processing_observation_changed")
			if (stableStringify(previous.receipt) !== stableStringify(record.receipt) || record.receiptRevision < previous.receiptRevision || record.receiptRevision === previous.receiptRevision && stableStringify(previous.processingReceipt) !== stableStringify(processing)) throw this.error("stale_receipt")
			if (["ticket", "skipped", "historical"].includes(previous.processingReceipt.state) && previous.processingReceipt.state !== processing.state) throw this.error("processing_receipt_changed")
			for (const key of ["requestId", "sourceFileVersionId", "ticketId", "processorSubmissionKey", "processingPermitId", "processorJobId", "reason", "previousOwner", "previousProcessingReceipt", "outcome"]) if (previous.processingReceipt[key] != null && stableStringify(previous.processingReceipt[key]) !== stableStringify(processing[key])) throw this.error("processing_receipt_changed")
		}
		if (record.observedProcessing && !["queued", "running", "cancelling", "succeeded", "partial", "failed", "cancelled", "interrupted"].includes(record.observedProcessing.state)) throw Object.assign(new Error("invalid_observation"), { status: 422, error: "invalid_observation" })
		if (record.observedProcessing && (!proc || record.observedProcessing.ownerRevision !== proc.ownerRevision)) throw this.error("stale_permit")
		this.receipts.set(key, structuredClone(record))
		if (processing.state !== "historical") this.work.set(claim.workId, { ...this.work.get(claim.workId), processingReceipt: structuredClone(processing) })
	}
	async ack(claim, record) {
		const current = this.work.get(claim.workId)
		if (!current || !sameOwner(current, claim) || current.attemptId !== claim.attemptId || current.attemptRevision !== claim.attemptRevision) throw this.error("stale_claim")
		if (!this.receipts.has(this.receiptKey(claim)) && !(Date.parse(current.leaseExpiresAt) > Date.now())) throw this.error("claim_expired")
		this.recordReceipt(claim, record); this.acks.push(structuredClone(record)); if (this.lostAck) { this.lostAck = false; throw new Error("lost acknowledgement") } return { workId: claim.workId, deliveryState: "available", processingReceipt: record.processingReceipt }
	}
	async reconcile(records) { this.reconciles.push(structuredClone(records)); const results = []; for (const r of records) { this.recordReceipt(r.claim, r); const work = await this.getWork(r.workId); results.push({ workId: r.workId, status: "accepted", action: work.action, publicationPermit: work.publicationPermit, processingPermit: work.processingPermit }) } return { results } }
	async settle(permit, body) {
		const registered = this.permits.find((p) => p.permitId === permit.permitId)
		if (!registered || !sameOwner(registered, permit) || registered.ownerRevision !== permit.ownerRevision || registered.receiptId !== body.receiptId) throw this.error("stale_permit")
		const prior = this.terminalSettlements.get(permit.permitId)
		if (prior && stableStringify(prior) !== stableStringify(body)) throw this.error("settlement_changed")
		if (!sameOwner(body.evidence.owner, permit) || body.receiptId !== permit.receiptId || body.evidence.local.receiptId !== body.receiptId) throw this.error("evidence_owner_mismatch")
		const receipt = this.receipts.get(this.receiptKey({ workId: permit.workId, ...permit })), p = body.evidence.processor, local = body.evidence.local
		if (body.state === "completed" && !receipt) throw this.error("receipt_not_committed")
		if (local.sourceHold === "released" && (["unknown", "checkpointed"].includes(local.state) || p.state === "unknown")) throw this.error("effects_not_settled")
		if (permit.kind === "processing" && receipt?.processingReceipt.state === "ticket" && (local.ticketId !== receipt.processingReceipt.ticketId || p.submissionKey !== receipt.processingReceipt.processorSubmissionKey || receipt.processingReceipt.processorJobId && p.jobId !== receipt.processingReceipt.processorJobId)) throw this.error("processing_evidence_mismatch")
		if (p.state === "not-submitted" && (p.submissionKey != null || p.jobId != null)) throw this.error("processing_evidence_mismatch")
		if (p.state === "terminal" && (!p.jobId || !p.submissionKey || !p.outcome)) throw this.error("processor_not_settled")
		if (permit.kind === "processing" && body.state === "completed" && (!p.jobId || !p.submissionKey || p.state !== "terminal" || !["completed", "partial", "failed", "cancelled", "interrupted"].includes(p.outcome) || local.ticketId !== receipt?.processingReceipt.ticketId || p.submissionKey !== receipt?.processingReceipt.processorSubmissionKey)) throw this.error("processor_not_settled")
		if (body.state === "skipped" && (local.state !== "not-admitted" || p.state !== "not-submitted" || local.ticketId || p.jobId || p.submissionKey)) throw this.error("effects_not_settled")
		const state = body.state === "interrupted" && p.state === "unknown" ? "reconciliation-pending" : body.state
		// Completed settlement supplies a minimal terminal observation if none was
		// acknowledged first. That terminal snapshot then rejects later enrichment.
		if (permit.kind === "processing" && state === "completed" && !terminal.has(receipt.observedProcessing?.state)) this.receipts.set(this.receiptKey({ workId: permit.workId, ...permit }), { ...receipt, observedProcessing: { state: p.outcome === "completed" ? "succeeded" : p.outcome, observedAt: new Date().toISOString(), ownerRevision: permit.ownerRevision } })
		this.settlements.push({ permit, evidence: structuredClone(body) })
		if (state !== "reconciliation-pending") this.terminalSettlements.set(permit.permitId, structuredClone(body))
		if (this.lostSettlement) { this.lostSettlement = false; throw new Error("lost settlement response") }
		return { state }
	}
	async reportFailure(claim, body) { this.failures.push({ workId: claim.workId, attemptId: claim.attemptId, attemptRevision: claim.attemptRevision, ...body }); return { workId: claim.workId, deliveryState: body.retryable ? "queued" : "failed" } }
}
async function fixture(t, options = {}) {
	const base = await fs.mkdtemp(path.join(os.homedir(), ".gc-cloud-import-"))
	await fs.chmod(base, 0o700)
	const workspaceDir = path.join(base, "project"); await fs.mkdir(workspaceDir, { mode: 0o2775 })
	const backend = new Backend()
	backend.processingEnabled = options.enabled !== false
	const config = { workspaceDir, filesStateDir: path.join(base, "state"), filesAgentUids: [20001], filesWorkerUids: [20003], persistenceAdapter: backend, cloudImport: { background: false }, writerRegistry: { status: async () => ({ state: "idle" }) }, preprocessing: { enabled: true, aggregateActivity: true, activeTickets: 100, inboxDir: path.join(base, "inbox"), port: 1, transportMs: 10, runningPollMs: 60000, queuedPollMs: 60000, ...options } }
	let files = await WorkspaceFiles.open(config, logger)
	// Keep the real coordinator's admission/SQLite path, without a processor or model.
	clearTimeout(files.processing.timer); files.processing.started = false
	backend.bind(files)
	t.after(async () => { await files.close(); await fs.rm(base, { recursive: true, force: true }) })
	return { backend, config, root: workspaceDir, get files() { return files }, async restart() { await files.close(); files = await WorkspaceFiles.open(config, logger); clearTimeout(files.processing.timer); files.processing.started = false; backend.bind(files); return files } }
}

async function livenessJob(f, claim, completedUnits = 1) {
	const receipt = await f.files.state.get("cloud-imports", claim.workId), job = await f.files.processing.record(receipt.processingReceipt.ticketId)
	const progress = { id: "extract", label: "Inspecting pages", unit: "page", completedUnits, totalUnits: 80, updatedAt: `2026-10-14T10:00:${String(completedUnits).padStart(2, "0")}.000Z` }
	const stage = { ...progress }; delete stage.updatedAt
	const next = { ...job, processorJobId: "live-job", processorState: "running", deliveryStage: "tracking", startedAt: "2026-10-14T10:00:00.123456Z", finishedAt: null, processorStage: stage, processorProgress: progress, queueAhead: null, lastCheckedAt: progress.updatedAt }
	await f.files.state.put("processing-jobs", job.runtimeJobId, next)
	return next
}

test("processing liveness interruption relays fresh cancelling progress and marker without settling unresolved execution", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
	const job = await livenessJob(f, claim, 12), interruptedAt = "2026-10-14T10:01:00.123456Z"
	const upstream = { id: job.processorJobId, projectId: "scope", submissionKey: job.upstreamSubmissionKey, revision: 1, state: "cancelling", startedAt: job.startedAt, finishedAt: null, interruptedAt, stage: job.processorStage, progress: job.processorProgress, queueAhead: null }
	const observations = []
	for (let revision = 1; revision <= 2; revision++) {
		await delay(3)
		await f.files.processing.observe(await f.files.processing.record(job.runtimeJobId), { ...upstream, revision, progress: { ...upstream.progress, completedUnits: 11 + revision } })
		await f.files.imports.retryReceipts()
		const current = await f.files.processing.record(job.runtimeJobId), receipt = await f.files.state.get("cloud-imports", claim.workId), observed = f.backend.acks.at(-1).observedProcessing
		assert.equal(observed.interruptedAt, interruptedAt)
		assert.equal(observed.state, "cancelling"); assert.equal(observed.finishedAt, null)
		assert.equal(observed.progress.completedUnits, 11 + revision); assert.equal(observed.observedAt, current.lastCheckedAt)
		assert.equal((await f.files.processing.get(job.runtimeJobId)).interruptedAt, interruptedAt)
		assert.equal(current.deliveryStage, "tracking"); assert.equal(current.outcome, null)
		assert.equal(receipt.processingSettled === true, false); assert.equal(receipt.processingSettlementIntent, undefined)
		assert.equal(f.files.processing.cloudAuthorized(current, { observation: true }), true)
		assert.equal(receipt.reconcileRequired === true, false); assert.ok(await f.files.state.get("holds", receipt.sourceHoldId))
		observations.push(observed)
	}
	assert.notEqual(observations[0].observedAt, observations[1].observedAt)
	assert.equal(f.backend.settlements.filter((s) => s.permit.kind === "processing").length, 0)
	assert.equal(f.backend.reconciles.length, 0)
})

test("processing liveness settlement race waits for acknowledged terminal metadata after running acknowledgement", async (t) => {
	let releaseRunning, releaseTerminal; t.after(() => { releaseRunning?.(); releaseTerminal?.() })
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
	const running = await livenessJob(f, claim, 12), ack = f.backend.ack.bind(f.backend)
	let enteredRunning, enteredTerminal
	const runningGate = new Promise((r) => { releaseRunning = r }), first = new Promise((r) => { enteredRunning = r })
	f.backend.ack = async (...args) => { enteredRunning(); await runningGate; return ack(...args) }
	const firstPass = f.files.imports.retryReceipts(); await first
	const finishedAt = "2026-10-14T10:01:00.654321Z", progress = { ...running.processorProgress, completedUnits: 80, updatedAt: finishedAt }
	await f.files.processing.observe(running, { id: running.processorJobId, projectId: "scope", submissionKey: running.upstreamSubmissionKey, revision: 1, state: "succeeded", startedAt: running.startedAt, finishedAt, interruptedAt: null, stage: { id: "seal", label: "Sealing results", unit: null, completedUnits: 1, totalUnits: 1 }, progress, queueAhead: null })
	releaseRunning(); await firstPass
	let receipt = await f.files.state.get("cloud-imports", claim.workId)
	assert.equal(receipt.acknowledgedObservation.state, "running")
	assert.equal(receipt.processingSettlementIntent, undefined, "terminal settlement intent cannot be allocated from a running acknowledgement")
	assert.equal(f.backend.settlements.filter((s) => s.permit.kind === "processing").length, 0)
	assert.equal(receipt.processingSettled === true, false)
	const terminalGate = new Promise((r) => { releaseTerminal = r }), second = new Promise((r) => { enteredTerminal = r })
	f.backend.ack = async (...args) => { enteredTerminal(); await terminalGate; return ack(...args) }
	const nextPass = f.files.imports.retryReceipts(); await second
	receipt = await f.files.state.get("cloud-imports", claim.workId)
	assert.equal(receipt.observedProcessing.state, "succeeded"); assert.equal(receipt.acknowledgedObservation.state, "running")
	await f.files.imports.settle(receipt)
	assert.equal(f.backend.settlements.filter((s) => s.permit.kind === "processing").length, 0, "terminal state alone is insufficient while its acknowledgement is pending")
	releaseTerminal(); await nextPass
	const settled = await f.files.state.get("cloud-imports", claim.workId), observed = f.backend.receipts.get(f.backend.receiptKey(claim)).observedProcessing
	assert.equal(settled.processingSettled, true); assert.equal(observed.finishedAt, finishedAt)
	assert.equal(observed.startedAt, running.startedAt); assert.deepEqual(observed.progress, progress)
	assert.equal(observed.interruptedAt, null); assert.equal(observed.state, "succeeded")
	assert.deepEqual(settled.acknowledgedObservation, observed)
	assert.equal(f.backend.settlements.filter((s) => s.permit.kind === "processing").length, 1)
	assert.equal(settled.reconcileRequired === true, false)
	assert.equal(f.files.processing.cloudAuthorized(await f.files.processing.record(running.runtimeJobId), { observation: true }), true)
})

test("processing liveness relays same-state samples during blocked download on its independent timer", async (t) => {
	let release, entered; t.after(() => release?.())
	const f = await fixture(t), claim = f.backend.add(entry("live.csv")); await f.files.imports.runOnce()
	await livenessJob(f, claim)
	await f.files.imports.retryReceipts({ observationsOnly: true })
	const before = f.backend.acks.length, blocked = f.backend.add(entry("blocked.csv", 2)), download = f.backend.download.bind(f.backend)
	const gate = new Promise((r) => { release = r }), first = new Promise((r) => { entered = r })
	f.backend.download = async (source) => { if (source.fileVersionId === blocked.source.fileVersionId) { entered(); await gate } return download(source) }
	const delivery = f.files.imports.runOnce(); await first
	const latest = await livenessJob(f, claim, 12), worker = f.files.imports
	assert.equal(worker.config.observationMs, 2000)
	worker.config.background = true; worker.start()
	const end = Date.now() + 4500
	while (f.backend.acks.at(-1)?.observedProcessing?.progress?.completedUnits !== 12 && Date.now() < end) await delay(20)
	assert.equal(f.backend.acks.at(-1).observedProcessing.progress?.completedUnits, 12, "progress must reach backend before blocked transfer finishes")
	assert.ok(f.backend.acks.length > before)
	assert.deepEqual(f.backend.acks.at(-1).observedProcessing, { state: "running", observedAt: latest.lastCheckedAt, ownerRevision: 1, startedAt: latest.startedAt, finishedAt: null, interruptedAt: null, stage: latest.processorStage, progress: latest.processorProgress, queueAhead: null })
	const sent = f.backend.acks.length
	await worker.reportOnce(); await worker.reportOnce()
	assert.equal(f.backend.acks.length, sent, "replaying an old processor sample must not invent freshness")
	await f.files.state.put("processing-jobs", latest.runtimeJobId, { ...latest, lastCheckedAt: "2026-10-14T10:00:14.000Z" })
	await worker.reportOnce()
	assert.equal(f.backend.acks.length, sent + 1, "unchanged page counts with a new processor poll are a fresh liveness sample")
	assert.equal(f.backend.acks.at(-1).observedProcessing.observedAt, "2026-10-14T10:00:14.000Z")
	release(); await delivery
})

test("healthy running and five queued files stay fresh across the ten-second window with delayed receipts", async (t) => {
	const f = await fixture(t, { runningPollMs: 2000, queuedPollMs: 2000 }), jobs = new Map(), received = new Map()
	for (let n = 0; n < 6; n++) f.backend.add(entry(`queue-${n}.csv`, n + 1))
	await f.files.imports.runOnce()
	for (const receipt of await f.files.state.list("cloud-imports")) {
		const job = await f.files.processing.record(receipt.processingReceipt.ticketId), index = jobs.size
		const state = index === 0 ? "running" : "queued"
		const upstream = { id: `processor-${index}`, projectId: "scope", submissionKey: job.upstreamSubmissionKey, revision: 1, state, startedAt: index === 0 ? new Date().toISOString() : null, finishedAt: null, interruptedAt: null, queueAhead: index || null }
		jobs.set(upstream.id, { upstream, workId: receipt.workId })
		await f.files.processing.observe(job, upstream)
	}
	f.files.processing.client.get = async (id) => { await delay(5 + Math.floor(Math.random() * 15)); return jobs.get(id).upstream }
	const ack = f.backend.ack.bind(f.backend)
	f.backend.ack = async (claim, record) => {
		await delay(60 + Math.floor(Math.random() * 120))
		const result = await ack(claim, record)
		if (record.observedProcessing) received.set(claim.workId, { sample: structuredClone(record.observedProcessing), at: Date.now() })
		return result
	}
	await f.files.imports.reportOnce()
	assert.equal(received.size, 6)
	let release, entered
	const gate = new Promise((r) => { release = r }), maintenance = new Promise((r) => { entered = r })
	t.after(() => release())
	f.files.processing.checkDependency = async () => { entered(); await gate }
	f.files.processing.started = true; f.files.processing.wake()
	await maintenance
	f.files.imports.config.background = true; f.files.imports.wakeObservations()
	const first = new Map([...received].map(([id, value]) => [id, value.sample.observedAt]))
	let maxAge = 0
	for (let second = 0; second < 12; second++) {
		await delay(1000)
		for (const { upstream, workId } of jobs.values()) {
			const value = received.get(workId), age = Date.now() - Math.min(value.at, Date.parse(value.sample.observedAt))
			maxAge = Math.max(maxAge, age)
			assert.ok(age < 10000, `${upstream.state} observation is stale at ${age}ms`)
			assert.equal(value.sample.state, upstream.state)
			assert.equal(value.sample.queueAhead, upstream.queueAhead)
		}
	}
	for (const [workId, value] of received) assert.notEqual(value.sample.observedAt, first.get(workId), "same-state jobs must receive new samples")
	t.diagnostic(`12 once-a-second reads of six jobs: zero stale samples; maximum sample age ${maxAge}ms`)
	release()
})

test("processing liveness serializes receipt acknowledgement, coalesces snapshots, and waits for reporter close", async (t) => {
	let release, entered; t.after(() => release?.())
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce(); await livenessJob(f, claim)
	const ack = f.backend.ack.bind(f.backend); let inflight = 0, max = 0
	const gate = new Promise((r) => { release = r }), first = new Promise((r) => { entered = r })
	f.backend.ack = async (...args) => { inflight++; max = Math.max(max, inflight); entered(); await gate; try { return await ack(...args) } finally { inflight-- } }
	const reporter = f.files.imports.reportOnce(); await first
	assert.equal(f.files.imports.reportOnce(), reporter, "reporting is single flight")
	await livenessJob(f, claim, 12)
	const retry = f.files.imports.retryReceipts()
	await delay(20)
	let closed = false; const closing = f.files.imports.close().then(() => { closed = true })
	await delay(30); assert.equal(closed, false, "close must wait for receipt write confirmation")
	release(); await Promise.all([reporter, retry, closing])
	assert.equal(max, 1)
	const receipt = await f.files.state.get("cloud-imports", claim.workId)
	assert.deepEqual(receipt.acknowledgedObservation, receipt.observedProcessing)
	assert.equal(receipt.observedProcessing.progress.completedUnits, 12)
})

test("processing liveness jittered reporter, retry and reconciliation writes preserve latest confirmed receipt", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
	const ack = f.backend.ack.bind(f.backend), reconcile = f.backend.reconcile.bind(f.backend)
	let inflight = 0, max = 0
	const jitter = (fn) => async (...args) => {
		inflight++; max = Math.max(max, inflight)
		try { await delay(Math.floor(Math.random() * 8)); return await fn(...args) } finally { inflight-- }
	}
	f.backend.ack = jitter(ack); f.backend.reconcile = jitter(reconcile)
	for (let n = 1; n <= 12; n++) {
		await livenessJob(f, claim, n)
		f.files.imports.needsReconcile = true
		await Promise.all([f.files.imports.reportOnce(), f.files.imports.retryReceipts(), f.files.imports.reconcile(), f.files.imports.retryReceipts({ observationsOnly: true })])
	}
	assert.equal(max, 1, "the same operation's ack and reconciliation cannot overlap")
	const record = await f.files.state.get("cloud-imports", claim.workId)
	assert.equal(record.observedProcessing.progress.completedUnits, 12)
	assert.deepEqual(record.acknowledgedObservation, record.observedProcessing)
	assert.deepEqual(f.backend.receipts.get(f.backend.receiptKey(claim)).observedProcessing, record.observedProcessing)
	assert.equal(record.ackedRevision, record.receiptRevision)
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 1)
})

test("processing liveness drain waits for reporting, accounts for deadline expiry, and stops timers", async (t) => {
	let release, entered; t.after(() => release?.())
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce(); await livenessJob(f, claim)
	const gate = new Promise((r) => { release = r }), first = new Promise((r) => { entered = r }), ack = f.backend.ack.bind(f.backend)
	f.backend.ack = async (...args) => { entered(); await gate; return ack(...args) }
	const worker = f.files.imports, reporting = worker.reportOnce(); await first
	const timedOut = await worker.drain(new Date(Date.now() + 20).toISOString())
	assert.ok(timedOut.localPending > 0); assert.equal(timedOut.complete, false)
	let drained = false; const draining = worker.drain(new Date(Date.now() + 2000).toISOString()).then((value) => { drained = true; return value })
	await delay(30); assert.equal(drained, false)
	release(); await reporting; assert.equal((await draining).localPending, 0)
	const sent = f.backend.acks.length; await worker.reportOnce(); assert.equal(f.backend.acks.length, sent)
})

test("processing liveness reporting failures retry on cadence without a hot loop or invented samples", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
	const receipt = await f.files.state.get("cloud-imports", claim.workId), job = await f.files.processing.record(receipt.processingReceipt.ticketId)
	await f.files.state.put("processing-jobs", job.runtimeJobId, { ...job, processorState: "running", updatedAt: new Date().toISOString() })
	await f.files.imports.reportOnce()
	assert.equal((await f.files.state.get("cloud-imports", claim.workId)).observedProcessing, undefined, "a stored running state without a processor sample has no observation")
	await livenessJob(f, claim)
	let attempts = 0
	f.backend.ack = async () => { attempts++; throw new Error("observation transport unavailable") }
	const worker = f.files.imports; worker.config.background = true; worker.config.observationMs = 40; worker.wakeObservations()
	await delay(180)
	await worker.close()
	assert.ok(attempts >= 1 && attempts <= 5, `failed reports must be paced: ${attempts}`)
	const pending = await f.files.state.get("cloud-imports", claim.workId)
	assert.equal(pending.observedProcessing.observedAt, "2026-10-14T10:00:01.000Z")
	assert.notDeepEqual(pending.acknowledgedObservation, pending.observedProcessing)
})

test("processing liveness review F1 freezes terminal samples through pending-to-ready publication and settlement", async (t) => {
	for (const lostResponse of [false, true]) await t.test(lostResponse ? "first terminal acknowledgement response lost" : "first terminal sample confirmed", async (t) => {
		const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
		const job = await livenessJob(f, claim, 12), finishedAt = "2026-10-14T10:01:00.000Z"
		const upstream = { id: job.processorJobId, projectId: "processor-scope", submissionKey: job.upstreamSubmissionKey, revision: 1, state: "succeeded", startedAt: job.startedAt, finishedAt, stage: job.processorStage, progress: { ...job.processorProgress, completedUnits: 80, updatedAt: finishedAt }, queueAhead: null, documents: { state: "pending" } }
		await f.files.processing.observe(job, upstream)
		f.backend.lostAck = lostResponse
		await f.files.imports.reportOnce()
		const first = await f.files.state.get("cloud-imports", claim.workId), frozen = first.observedProcessing
		assert.equal(frozen.state, "succeeded"); assert.equal(frozen.progress.completedUnits, 80)
		assert.equal(first.processingSettled === true, false, "observation-only reporting leaves settlement for the delivery worker")
		assert.equal(stableStringify(first.acknowledgedObservation) === stableStringify(frozen), !lostResponse)
		await assert.rejects(f.backend.ack(first.claim, { ...first, observedProcessing: { ...frozen, observedAt: "2026-10-14T10:02:00.000Z" } }), { error: "processing_observation_changed" }, "strict backend must reject even a timestamp-only terminal change")
		const beforePoll = await f.files.processing.record(job.runtimeJobId)
		await delay(5)
		f.files.processing.client.get = async () => ({ ...upstream, revision: 2, documents: { state: "ready" } })
		await f.files.processing.track(beforePoll)
		const published = await f.files.processing.record(job.runtimeJobId)
		assert.equal(published.processorPublication.state, "ready")
		assert.notEqual(published.lastCheckedAt, frozen.observedAt, "local publication checks still advance")
		await f.files.imports.retryReceipts()
		const settled = await f.files.state.get("cloud-imports", claim.workId)
		assert.equal(settled.processingSettled, true, "publication polling must not block processing settlement")
		assert.deepEqual(settled.observedProcessing, frozen); assert.deepEqual(settled.acknowledgedObservation, frozen)
		assert.equal(settled.reconcileRequired === true, false)
		assert.equal(f.files.processing.cloudAuthorized(published, { observation: true }), true)
		assert.equal(f.backend.reconciles.length, 0)
		assert.deepEqual(f.backend.acks.at(-1).observedProcessing, frozen)
		assert.equal(f.backend.settlements.filter((s) => s.permit.kind === "processing").length, 1)
	})
})

test("processing liveness review F2 confirmed expired receipts relay repeated samples without batch recovery or authority revocation", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry("long-running.csv", 1)), unrelated = f.backend.add(entry("unrelated.csv", 2)); await f.files.imports.runOnce()
	const receipt = await f.files.state.get("cloud-imports", claim.workId)
	assert.ok(receipt.ackedRevision > 0)
	await f.files.state.put("cloud-imports", claim.workId, { ...receipt, claim: { ...receipt.claim, leaseExpiresAt: new Date(0).toISOString() } })
	f.backend.work.set(claim.workId, { ...f.backend.work.get(claim.workId), leaseExpiresAt: new Date(0).toISOString() })
	const revoke = f.files.processing.revokeCloud.bind(f.files.processing), serial = f.files.remote.serial.bind(f.files.remote)
	let revocations = 0, held = 0, maxHeld = 0
	f.files.processing.revokeCloud = (record) => { revocations++; return revoke(record) }
	f.files.remote.serial = (id, work) => serial(id, async () => { held++; maxHeld = Math.max(maxHeld, held); try { return await work() } finally { held-- } })
	const sent = f.backend.acks.length
	for (let n = 1; n <= 6; n++) { await livenessJob(f, claim, n); await f.files.imports.reportOnce() }
	assert.equal(f.backend.reconciles.length, 0, "a confirmed receipt needs per-record acknowledgement, not whole-batch reconciliation")
	assert.equal(revocations, 0); assert.equal(maxHeld, 1, "normal reporting never holds unrelated operation lanes together")
	assert.equal(f.backend.acks.length, sent + 6)
	const confirmed = await f.files.state.get("cloud-imports", claim.workId)
	assert.deepEqual(confirmed.acknowledgedObservation, confirmed.observedProcessing)
	assert.equal(confirmed.observedProcessing.progress.completedUnits, 6)
	assert.equal(confirmed.reconcileRequired === true, false)
	for (const workId of [claim.workId, unrelated.workId]) {
		const record = await f.files.state.get("cloud-imports", workId), job = await f.files.processing.record(record.processingReceipt.ticketId)
		assert.equal(f.files.processing.cloudAuthorized(job, { observation: true }), true)
	}
})

test("processing liveness review F2 expired confirmed receipt still fences a stale attempt and enters reconciliation", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
	const job = await livenessJob(f, claim, 12), receipt = await f.files.state.get("cloud-imports", claim.workId)
	await f.files.state.put("cloud-imports", claim.workId, { ...receipt, claim: { ...receipt.claim, leaseExpiresAt: new Date(0).toISOString() } })
	f.backend.work.set(claim.workId, { ...f.backend.work.get(claim.workId), attemptId: crypto.randomUUID(), attemptRevision: claim.attemptRevision + 1 })
	const wire = reconciliationWire(f); wire.rejected.set(claim.workId, "conflict")
	await f.files.imports.reportOnce()
	assert.ok(wire.calls.some((c) => c.pathname.endsWith("/ack")), "a persisted receipt must attempt owner/attempt-checked acknowledgement")
	assert.equal(f.files.imports.lastError.error, "stale_claim")
	assert.equal(f.files.processing.cloudAuthorized(job, { observation: true }), false)
	assert.equal((await f.files.state.get("cloud-imports", claim.workId)).reconcileRequired, true)
	await f.files.imports.reportOnce()
	assert.equal(wire.calls.filter((c) => c.pathname.endsWith("/receipts/reconcile")).length, 1)
	const retained = await f.files.state.get("cloud-imports", claim.workId)
	assert.equal(retained.reconcileRequired, true); assert.notDeepEqual(retained.acknowledgedObservation, retained.observedProcessing)
	assert.ok(await f.files.state.get("holds", retained.sourceHoldId))
	const calls = wire.calls.length; await f.files.imports.retryReceipts({ observationsOnly: true }); assert.equal(wire.calls.length, calls)
})

test("processing liveness unconfirmed expired receipt reconciliation forwards and confirms samples and suppresses rejected owners", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce(); const latest = await livenessJob(f, claim, 12)
	const receipt = await f.files.state.get("cloud-imports", claim.workId)
	// Model a lost local confirmation: persisted backend receipt, unknown first acknowledgement.
	await f.files.state.put("cloud-imports", claim.workId, { ...receipt, ackedRevision: 0, claim: { ...receipt.claim, leaseExpiresAt: new Date(0).toISOString() } })
	const wire = reconciliationWire(f)
	await f.files.imports.retryReceipts({ observationsOnly: true })
	const observed = wire.calls.find((c) => c.pathname.endsWith("/receipts/reconcile"))?.body.receipts[0].observedProcessing
	assert.equal(observed?.progress?.completedUnits, 12)
	assert.equal(observed.observedAt, latest.lastCheckedAt)
	assert.deepEqual((await f.files.state.get("cloud-imports", claim.workId)).acknowledgedObservation, observed)
	const count = wire.calls.length; await f.files.imports.retryReceipts({ observationsOnly: true }); assert.equal(wire.calls.length, count, "confirmed reconcile must not replay unchanged samples")
	await livenessJob(f, claim, 13); wire.rejected.set(claim.workId, "conflict")
	f.backend.permits.find((p) => p.kind === "processing").ownerRevision++
	await f.files.imports.retryReceipts({ observationsOnly: true })
	assert.equal((await f.files.state.get("cloud-imports", claim.workId)).reconcileRequired, true)
	const rejectedCount = wire.calls.length; await f.files.imports.retryReceipts({ observationsOnly: true }); assert.equal(wire.calls.length, rejectedCount)
	assert.equal(f.files.processing.cloudAuthorized(latest, { observation: true }), false)
})

test("processing liveness delivery lease expiry confirms receipt before settlement and retains rejected obligations", async (t) => {
	for (const accepted of [true, false]) await t.test(accepted ? "accepted" : "rejected", async (t) => {
		const f = await fixture(t), claim = f.backend.add(entry()), progress = f.backend.progress.bind(f.backend), reconcile = f.backend.reconcile.bind(f.backend)
		f.backend.progress = async (current, value) => {
			const result = await progress(current, value)
			if (value.stage === "processing-linked") current.leaseExpiresAt = new Date(0).toISOString()
			return result
		}
		f.backend.reconcile = async (records) => accepted ? reconcile(records) : { results: records.map((r) => ({ workId: r.workId, status: "conflict" })) }
		await f.files.imports.runOnce()
		const receipt = await f.files.state.get("cloud-imports", claim.workId), delivery = await f.files.state.get("cloud-deliveries", claim.workId)
		assert.equal(receipt.publicationSettled === true, accepted)
		assert.equal(receipt.reconcileRequired === true, !accepted)
		if (accepted) {
			assert.equal(delivery.state, "delivered")
			assert.equal(f.files.imports.lastError, null, "settlement must never precede the backend's receipt confirmation")
		} else { assert.equal(f.backend.settlements.length, 0); assert.ok(await f.files.state.get("holds", receipt.sourceHoldId)) }
	})
})

test("processing liveness intake refuses implicit reserved segments and generated roots before download", async (t) => {
	const f = await fixture(t); let downloads = 0
	f.backend.download = async () => { downloads++; throw new Error("forbidden path must never download") }
	const forbidden = [".runtime", ".git", ".upload-tmp", ".datasets-staging", ".ide-state", ".clinerules", ".gc-file-candidate"]
	for (const name of [...forbidden.flatMap((part) => [`${part}/x.csv`, `site/${part}/x.csv`]), ...["datasets", "outputs", "runs", "documents"].map((root) => `${root}/x.csv`)]) {
		assert.throws(() => cloudPath(name, { intake: true }), { error: "reserved_intake_path" }, name)
		const claim = f.backend.add(entry(name)); await assert.rejects(f.files.imports.deliver({ claim, state: "pending" }), { error: "reserved_intake_path" }, name)
	}
	for (const name of [".env", "site/.gitignore", "site/datasets/x.csv", "Datasets/x.csv", "site/.Git/x.csv"]) assert.equal(cloudPath(name, { intake: true }), name)
	assert.equal(downloads, 0); assert.equal((await f.files.state.list("operations")).length, 0)
})
test("cloud import publishes exact source with receipt/ticket/hold and no upload echo; lost ack and retained SQLite restart reuse one ticket", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); f.backend.lostAck = true
	await f.files.imports.runOnce()
	assert.equal(await fs.readFile(path.join(f.root, "data.csv"), "utf8"), bytes)
	const first = (await f.files.state.list("cloud-imports"))[0], jobs = await f.files.state.list("processing-jobs")
	assert.equal(jobs.length, 1); assert.equal(first.processingReceipt.ticketId, jobs[0].runtimeJobId)
	assert.equal(first.receipt.fileVersionId, claim.source.fileVersionId)
	assert.equal((await f.files.state.list("holds")).some((h) => h.source.id === jobs[0].captureId), true)
	const epoch = f.files.identity.workspaceEpoch
	await f.restart(); assert.equal(f.files.identity.workspaceEpoch, epoch)
	await f.files.imports.runOnce()
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
	assert.ok(f.backend.reconciles.length > 0)
	assert.equal(f.backend.acks.at(-1).processingReceipt.ticketId, jobs[0].runtimeJobId)
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 1)
	assert.equal((await f.files.state.list("operations")).find((op) => op.operationId === claim.operationId).persistence.state, "clean")
})
test("one sync cycle acknowledges all 50 paged uploads, with tickets and capacity waits", async (t) => {
	const f = await fixture(t, { activeTickets: 3 })
	const claims = Array.from({ length: 50 }, (_, i) => f.backend.add(entry(`batch-${i + 1}.csv`, i + 1)))
	await f.files.imports.runOnce()
	for (const claim of claims) {
		assert.equal(await fs.readFile(path.join(f.root, claim.destination.path), "utf8"), bytes)
		const receipt = f.backend.receipts.get(f.backend.receiptKey(claim))
		assert.ok(receipt, `${claim.destination.path} is readable but has no delivery acknowledgement`)
		assert.ok(["ticket", "awaiting-capacity"].includes(receipt.processingReceipt.state))
		assert.equal((await f.files.state.get("cloud-imports", claim.workId)).deliveryState, "available")
	}
	assert.equal((await f.files.state.list("processing-jobs")).length, 3)
	assert.equal([...f.backend.receipts.values()].filter((r) => r.processingReceipt.state === "awaiting-capacity").length, 47)
	assert.equal(f.files.imports.lastError, null)
})
test("one sync cycle catches uploads materialized after its initial claim pass", async (t) => {
	const f = await fixture(t), snapshot = f.backend.snapshot.bind(f.backend), claims = []
	f.backend.snapshot = async () => {
		for (let i = 1; i <= 50; i++) claims.push(f.backend.add(entry(`late-${i}.csv`, i), i === 1 ? "auto" : "skip"))
		return snapshot()
	}
	await f.files.imports.runOnce()
	assert.equal(claims.length, 50)
	for (const claim of claims) {
		assert.equal(await fs.readFile(path.join(f.root, claim.destination.path), "utf8"), bytes)
		assert.equal(f.backend.receipts.get(f.backend.receiptKey(claim))?.processingReceipt.state, claim.processingPolicy === "auto" ? "ticket" : "skipped")
	}
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 1)
	assert.equal(f.files.imports.lastError, null)
})
test("partial hydration still acknowledges files it made readable when a later head fails", async (t) => {
	const f = await fixture(t), snapshot = f.backend.snapshot.bind(f.backend); let good
	f.backend.snapshot = async () => {
		good = f.backend.add(entry("good.csv", 1), "skip")
		const bad = entry("broken.csv", 2)
		f.backend.heads.push(bad); f.backend.changes.push({ changeSeq: 2, entries: [bad] })
		f.backend.content.set(bad.fileVersionId, { body: "corrupt!", sizeBytes: bad.sizeBytes, sha256: bad.sha256 })
		return snapshot()
	}
	await f.files.imports.runOnce()
	assert.equal(await fs.readFile(path.join(f.root, "good.csv"), "utf8"), bytes)
	assert.ok(f.backend.receipts.has(f.backend.receiptKey(good)), "partial hydration needs delivery catch-up")
	assert.equal(f.files.imports.lastError.error, "digest_mismatch")
})
test("processing observed during a later claim page reaches the backend in the same cycle", async (t) => {
	const f = await fixture(t), claims = Array.from({ length: 11 }, (_, i) => f.backend.add(entry(`observed-${i}.csv`, i + 1)))
	const claim = f.backend.claim.bind(f.backend)
	f.backend.claim = async (requestId) => {
		if (f.backend.receipts.has(f.backend.receiptKey(claims[0]))) {
			const receipt = await f.files.state.get("cloud-imports", claims[0].workId), job = await f.files.processing.record(receipt.processingReceipt.ticketId)
			await f.files.state.put("processing-jobs", job.runtimeJobId, { ...job, processorJobId: "running-job", processorState: "running", deliveryStage: "tracking", lastCheckedAt: "2026-10-14T10:00:00.000Z" })
		}
		return claim(requestId)
	}
	await f.files.imports.runOnce()
	const receipt = f.backend.receipts.get(f.backend.receiptKey(claims[0]))
	assert.equal(receipt.observedProcessing?.state, "running")
	assert.equal(receipt.processingReceipt.processorJobId, "running-job")
})
test("hydration remains the primary error when catch-up also fails, and local pushing still runs", async (t) => {
	const f = await fixture(t), claim = f.backend.claim.bind(f.backend), logs = []; let polls = 0, pushed = false
	f.files.logger = { ...logger, warn: (...args) => logs.push(args) }
	f.backend.snapshot = async () => { throw Object.assign(new Error("snapshot failed"), { status: 502, error: "snapshot_boundary_changed" }) }
	f.backend.claim = async (requestId) => { if (polls++) throw Object.assign(new Error("catch-up failed"), { status: 503, error: "backend_unavailable" }); return claim(requestId) }
	f.files.imports.pushLocal = async () => { pushed = true }
	await f.files.imports.runOnce()
	assert.deepEqual(f.files.imports.lastError, { status: 502, error: "snapshot_boundary_changed" })
	assert.ok(logs.some(([message, value]) => message === "cloud import catch-up retry" && value.error === "backend_unavailable"))
	assert.equal(pushed, true)
	assert.ok((await f.files.state.get("cloud-sync", "poll")).requestId, "failed catch-up preserves its poll identity")
})
test("later claim-page failures preserve hydration, local uploads, observations, and the failed poll", async (t) => {
	for (const hydrationFails of [false, true]) await t.test(`hydration ${hydrationFails ? "fails" : "succeeds"}`, async (t) => {
		const f = await fixture(t), delivered = f.backend.add(entry("delivered.csv", 1)), claim = f.backend.claim.bind(f.backend), snapshot = f.backend.snapshot.bind(f.backend), logs = []
		const remote = entry("remote.csv", 2); f.backend.heads.push(remote); f.backend.changes.push({ changeSeq: 2, entries: [remote] }); f.backend.content.set(remote.fileVersionId, { body: bytes, sizeBytes: remote.sizeBytes, sha256: remote.sha256 })
		await f.files.upload(Readable.from([bytes]), { operationId: "claim-failure-local", path: "local.csv", processingPolicy: "skip" })
		let polls = 0, failedRequest, snapshots = 0, uploaded = false
		f.files.logger = { ...logger, warn: (...args) => logs.push(args) }
		f.backend.claim = async (requestId) => {
			if (polls++) {
				failedRequest = requestId
				const receipt = await f.files.state.get("cloud-imports", delivered.workId), job = await f.files.processing.record(receipt.processingReceipt.ticketId)
				await f.files.state.put("processing-jobs", job.runtimeJobId, { ...job, processorJobId: "running-job", processorState: "running", deliveryStage: "tracking", lastCheckedAt: "2026-10-14T10:00:00.000Z" })
				throw Object.assign(new Error("claim page failed"), { status: 503, error: "claims_unavailable" })
			}
			return claim(requestId)
		}
		f.backend.snapshot = async () => {
			snapshots++
			if (hydrationFails) throw Object.assign(new Error("snapshot failed"), { status: 502, error: "snapshot_boundary_changed" })
			return snapshot()
		}
		f.backend.upload = async (op, source) => {
			assert.equal(op.intent.path, "local.csv"); assert.equal(await source.handle.readFile("utf8"), bytes); uploaded = true
			return { ...entry("local.csv", 3), status: "ready" }
		}
		await f.files.imports.runOnce()
		assert.equal(snapshots, 1, "claim failure must not suppress hydration")
		if (!hydrationFails) assert.equal(await fs.readFile(path.join(f.root, "remote.csv"), "utf8"), bytes)
		assert.equal(uploaded, true, "claim failure must not strand local saves")
		assert.equal((await f.files.state.get("operations", "claim-failure-local")).persistence.state, "clean")
		assert.equal(f.backend.receipts.get(f.backend.receiptKey(delivered)).observedProcessing?.state, "running")
		assert.deepEqual(f.files.imports.lastError, { status: 503, error: "claims_unavailable" })
		assert.equal((await f.files.state.get("cloud-sync", "poll")).requestId, failedRequest)
		assert.equal(polls, 2, "leave the failed page for the next invocation")
		if (hydrationFails) assert.ok(logs.some(([message, value]) => message === "cloud import hydration retry" && value.error === "snapshot_boundary_changed"))
	})
})
test("shutdown during the initial claim pass stops before hydration and local uploads", async (t) => {
	const f = await fixture(t), delivered = f.backend.add(entry("before-drain.csv", 1), "skip"), claim = f.backend.claim.bind(f.backend)
	await f.files.upload(Readable.from([bytes]), { operationId: "drain-local", path: "local.csv", processingPolicy: "skip" })
	let entered, release, polls = 0, snapshots = 0, uploads = 0
	const waiting = new Promise((resolve) => { entered = resolve }), blocked = new Promise((resolve) => { release = resolve })
	f.backend.claim = async (requestId) => {
		const response = await claim(requestId)
		if (polls++) { entered(); await blocked }
		return response
	}
	f.backend.snapshot = async () => { snapshots++; return { snapshotId: "shutdown", throughSeq: 1, entries: [] } }
	f.backend.upload = async () => { uploads++; throw new Error("must not upload during shutdown") }
	const running = f.files.imports.runOnce()
	await waiting
	const stopping = f.files.imports.drain(new Date(Date.now() + 5000).toISOString())
	release()
	const [, drained] = await Promise.all([running, stopping])
	assert.ok(f.backend.receipts.has(f.backend.receiptKey(delivered)), "shutdown follows successful first-page delivery")
	assert.equal(snapshots, 0, "shutdown must not begin a snapshot")
	assert.equal(await f.files.state.get("cloud-sync", "checkpoint"), null)
	assert.equal(uploads, 0)
	assert.notEqual((await f.files.state.get("operations", "drain-local")).persistence.state, "clean")
	assert.equal(polls, 2)
	assert.equal(drained.localPending, 0)
})
test("lost later-page claim responses replay their durable request after restart", async (t) => {
	const f = await fixture(t), claims = Array.from({ length: 21 }, (_, i) => f.backend.add(entry(`replay-${i}.csv`, i + 1), "skip"))
	const claim = f.backend.claim.bind(f.backend), requests = []; let lostRequest
	f.backend.claim = async (requestId) => {
		requests.push(requestId)
		const response = await claim(requestId)
		if (!lostRequest && requests.length === 2) { lostRequest = requestId; throw new Error("claim response lost") }
		return response
	}
	await f.files.imports.runOnce()
	assert.equal((await f.files.state.get("cloud-sync", "poll")).requestId, lostRequest)
	assert.equal(f.backend.receipts.size, 10)
	await f.restart(); await f.files.imports.runOnce()
	assert.equal(requests[2], lostRequest)
	assert.notEqual(requests[3], lostRequest)
	assert.equal(await f.files.state.get("cloud-sync", "poll"), null)
	for (const item of claims) assert.ok(f.backend.receipts.has(f.backend.receiptKey(item)))
	assert.equal(f.backend.permits.length, 21, "replaying a page does not grant duplicate publication permits")
})
test("repeated reassigned claims stop the pass and retry a failed file only next cycle", async (t) => {
	const f = await fixture(t), item = f.backend.add(entry(), "skip"), original = f.backend.claim.bind(f.backend)
	let polls = 0, downloads = 0
	f.backend.claim = async (requestId) => {
		if (polls++) f.backend.claims.push({ ...item, attemptId: crypto.randomUUID(), attemptRevision: polls })
		return original(requestId)
	}
	f.backend.download = async () => { downloads++; throw new Error("temporary download failure") }
	await f.files.imports.runOnce()
	assert.equal(downloads, 2, "one delivery attempt and an independent hydration attempt")
	assert.equal(polls, 3, "repeated work stops both drain passes")
	assert.equal((await f.files.state.get("cloud-deliveries", item.workId)).claim.attemptRevision, 3)
	assert.equal(f.backend.receipts.size, 0)
	await f.files.imports.runOnce()
	assert.equal(downloads, 4, "the durable pending claim can retry next invocation")
})
test("an acknowledgement outage on one file does not strand the next claim page", async (t) => {
	const f = await fixture(t), claims = Array.from({ length: 11 }, (_, i) => f.backend.add(entry(`independent-${i}.csv`, i + 1), "skip"))
	const ack = f.backend.ack.bind(f.backend); let failed = 0
	f.backend.ack = async (item, record) => { if (item.workId === claims[0].workId) { failed++; throw new Error("ack unavailable") } return ack(item, record) }
	await f.files.imports.runOnce()
	assert.equal(failed, 1, "no repeated failing acknowledgement inside this cycle")
	for (const item of claims.slice(1)) assert.ok(f.backend.receipts.has(f.backend.receiptKey(item)))
	assert.equal(await fs.readFile(path.join(f.root, claims[0].destination.path), "utf8"), bytes)
	assert.equal((await f.files.state.get("cloud-deliveries", claims[0].workId)).state, "pending")
})
test("continuous intake reaches the page cap and still hydrates and pushes local work", async (t) => {
	const f = await fixture(t)
	f.files.imports.config.maxClaimPages = 2
	const claim = f.backend.claim.bind(f.backend); let polls = 0, pushed = false
	f.backend.claim = async (requestId) => { polls++; f.backend.add(entry(`continuous-${polls}.csv`, polls), "skip"); return claim(requestId) }
	f.files.imports.pushLocal = async () => { pushed = true }
	await f.files.imports.runOnce()
	assert.equal(polls, 4, "each of the pre- and post-hydration passes has a page cap")
	assert.equal(f.backend.receipts.size, 4)
	assert.equal(f.files.imports.hydrated, true)
	assert.equal(pushed, true)
})
test("delivery and hydration publish file-watch invalidations to root and nested subscribers", async (t) => {
	const f = await fixture(t), api = new FilesApi(f.files, logger)
	const server = http.createServer(async (req, res) => { if (!await api.handle(req, res)) { res.writeHead(404); res.end() } })
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await api.close() })
	const url = `http://127.0.0.1:${server.address().port}`, streams = []
	for (const scope of ["", "incoming"]) {
		const response = await fetch(`${url}/files/watch?path=${scope}`, { signal: AbortSignal.timeout(10000) })
		assert.equal(response.status, 200)
		const reader = response.body.getReader(); t.after(() => reader.cancel().catch(() => {}))
		const first = await reader.read(); assert.match(Buffer.from(first.value).toString(), /event: ready/)
		streams.push({ reader, text: Buffer.from(first.value).toString() })
	}
	f.backend.add(entry("incoming/delivered.csv", 1), "skip")
	const hydrated = entry("incoming/hydrated.csv", 2)
	f.backend.heads.push(hydrated); f.backend.changes.push({ changeSeq: 2, entries: [hydrated] })
	f.backend.content.set(hydrated.fileVersionId, { body: bytes, sizeBytes: bytes.length, sha256: digest(bytes) })
	await f.files.imports.runOnce()
	for (const stream of streams) {
		while (!["delivered.csv", "hydrated.csv"].every((name) => stream.text.includes(`incoming/${name}`))) {
			const chunk = await stream.reader.read(); assert.equal(chunk.done, false)
			stream.text += Buffer.from(chunk.value).toString()
		}
		const events = stream.text.split("\n\n").filter((block) => block.includes("event: invalidation\n")).map((block) => JSON.parse(/^data: (.*)$/m.exec(block)[1]))
		for (const name of ["delivered.csv", "hydrated.csv"]) {
			const event = events.find((value) => value.payload.changes.some((change) => change.path === `incoming/${name}`))
			assert.ok(event)
			assert.equal(event.workspaceId, f.files.identity.workspaceId)
			assert.equal(event.workspaceEpoch, f.files.identity.workspaceEpoch)
			assert.equal(event.filesContractVersion, 1)
			assert.equal(await fs.readFile(path.join(f.root, "incoming", name), "utf8"), bytes)
		}
	}
})
test("capacity waits retain exact source and auto intent; retry admits one ticket after live path substitution", async (t) => {
	const f = await fixture(t, { activeTickets: 1 })
	f.backend.add(entry("first.csv", 1)); await f.files.imports.runOnce()
	const later = f.backend.add(entry("later.csv", 2)); await f.files.imports.runOnce()
	let record = await f.files.state.get("cloud-imports", later.workId)
	assert.equal(record.processingReceipt.state, "awaiting-capacity")
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 1)
	await fs.writeFile(path.join(f.root, "later.csv"), "substituted")
	const job = (await f.files.state.list("processing-jobs"))[0]
	await f.files.state.put("processing-jobs", job.runtimeJobId, { ...job, deliveryStage: "terminal", outcome: "interrupted", processorState: "interrupted" })
	await f.restart(); await f.files.imports.runOnce(); await f.files.imports.runOnce()
	record = await f.files.state.get("cloud-imports", later.workId)
	assert.equal(record.processingReceipt.state, "ticket")
	assert.equal((await f.files.state.list("processing-jobs")).length, 2)
	assert.equal((await f.files.captures.text("capture", record.source.captureId)).text, bytes)
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 2)
})
test("runtime-local disablement cannot invent a backend skip; retained auto work retries after enablement", async (t) => {
	const f = await fixture(t, { enabled: false })
	f.backend.processingEnabled = true
	const claim = f.backend.add(entry())
	await f.files.imports.runOnce()
	assert.equal(f.files.imports.lastError.error, "processing_unavailable")
	assert.equal((await f.files.state.list("cloud-imports")).length, 0)
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
	assert.equal(f.backend.acks.length, 0)
	const prepared = await f.files.state.get("operations", claim.operationId)
	assert.ok(prepared.publishedSource.captureId)
	assert.equal(prepared.processingAdmission, undefined)
	f.config.preprocessing.enabled = true
	await f.restart(); await f.files.imports.runOnce(); await f.files.imports.runOnce()
	const record = await f.files.state.get("cloud-imports", claim.workId)
	assert.equal(record.processingReceipt.state, "ticket")
	assert.equal(record.source.captureId, prepared.publishedSource.captureId)
	assert.equal(record.ackedRevision, record.receiptRevision)
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 1)
	assert.equal(await fs.readFile(path.join(f.root, "data.csv"), "utf8"), bytes)
})
test("ordered hydration explicitly skips processing, atomically moves, tombstones and fences delayed older publication", async (t) => {
	const f = await fixture(t), head = entry("old.csv", 1)
	f.backend.heads = [head]; f.backend.content.set(head.fileVersionId, { body: bytes, sizeBytes: bytes.length, sha256: digest(bytes) }); f.backend.changes = [{ changeSeq: 1, entries: [head] }]
	await f.files.imports.runOnce()
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
	const moved = { ...head, path: "new.csv", headToken: crypto.randomUUID(), changeSeq: 2 }, tombstone = { path: "old.csv", kind: "tombstone", headToken: crypto.randomUUID(), fileVersionId: null, changeSeq: 2 }
	f.backend.changes.push({ changeSeq: 2, entries: [tombstone, moved] }); f.backend.heads = [moved]
	await f.files.imports.runOnce()
	await assert.rejects(fs.stat(path.join(f.root, "old.csv")), { code: "ENOENT" }); assert.equal(await fs.readFile(path.join(f.root, "new.csv"), "utf8"), bytes)
	const deleted = { ...tombstone, path: "new.csv", changeSeq: 3 }; f.backend.changes.push({ changeSeq: 3, entries: [deleted] }); f.backend.heads = []
	await f.files.imports.runOnce(); await assert.rejects(fs.stat(path.join(f.root, "new.csv")), { code: "ENOENT" })
	await assert.rejects(f.files.applyRemote({ operationId: "late", path: "new.csv", remoteEtag: moved.headToken, entries: [moved], processingPolicy: "skip" }, Readable.from([bytes]), null), { error: "remote_superseded" })
	assert.equal((await f.files.state.get("cloud-sync", "checkpoint")).afterSeq, 3)
})
test("invalid digest cannot publish bytes, receipt or ticket", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); f.backend.content.get(claim.source.fileVersionId).body = "bad-byte"
	await f.files.imports.runOnce()
	await assert.rejects(fs.stat(path.join(f.root, "data.csv")), { code: "ENOENT" })
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
	assert.equal((await f.files.state.list("cloud-imports")).some((r) => r.receipt), false)
	assert.equal(f.backend.permits.length, 0)
})
test("remote replacement defers changed local base and unknown writers; apply-now still requires explicit discard and retains displaced bytes", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry(), "skip"); await f.files.imports.runOnce()
	await fs.writeFile(path.join(f.root, "data.csv"), "local edit")
	const next = entry("data.csv", 2, "remote next"), change = { operationId: "replace", path: next.path, remoteEtag: next.headToken, entries: [next], processingPolicy: "skip", applyNow: true }
	const base = (await f.files.state.list("operations")).find((o) => o.operationId === claim.operationId).localGeneration
	await assert.rejects(f.files.applyRemote(change, Readable.from(["remote next"]), base), { error: "source_changed" })
	const result = await f.files.applyRemote({ ...change, operationId: "discard", discardLocal: true }, Readable.from(["remote next"]), base)
	assert.equal(result.state, "committed")
	const recovery = (await f.files.recovery()).items.find((r) => r.kind === "remote-replacement")
	assert.equal((await f.files.captures.text("capture", recovery.source.captureId)).text, "local edit")
})
test("jittered duplicate claims and capacity retries keep one receipt/ticket per identity", async (t) => {
	const f = await fixture(t)
	for (let i = 1; i <= 12; i++) {
		const claim = f.backend.add(entry(`race-${i}.csv`, i))
		f.backend.claims.push(structuredClone(claim))
		await Promise.all(Array.from({ length: 4 }, async () => { await delay(Math.floor(Math.random() * 8)); await f.files.imports.runOnce() }))
	}
	assert.equal((await f.files.state.list("processing-jobs")).length, 12)
	assert.equal((await f.files.state.list("cloud-imports")).filter((r) => r.receipt).length, 12)
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 12)
})

test("publication/SQLite crash points recover one atomic receipt, ticket and held source", async (t) => {
	for (const fault of ["published", "transaction", "transaction-ack"]) {
		const f = await fixture(t), claim = f.backend.add(entry()); let injected = false
		const transaction = f.files.state.transaction.bind(f.files.state)
		f.files.state.transaction = async (ops) => {
			if (!injected && ops.some((o) => o.kind === "cloud-imports" && o.value.receipt)) {
				assert.ok(ops.some((o) => o.kind === "processing-jobs")); assert.ok(ops.some((o) => o.kind === "holds")); assert.ok(ops.some((o) => o.kind === "cloud-heads"))
				if (fault === "transaction") { injected = true; throw Object.assign(new Error("commit failed"), { code: "EIO" }) }
				if (fault === "transaction-ack") { injected = true; await transaction(ops); throw Object.assign(new Error("commit acknowledgement lost"), { code: "EIO" }) }
			}
			return transaction(ops)
		}
		f.config.filesCheckpoint = async (stage) => { if (!injected && fault === "published" && stage === "remote-published") { injected = true; throw Object.assign(new Error("daemon died"), { code: "EIO" }) } }
		await f.files.imports.runOnce(); assert.equal(injected, true)
		const op = await f.files.state.get("operations", claim.operationId), jobId = op.processingAdmission.jobId, key = op.processingAdmission.upstreamSubmissionKey
		delete f.config.filesCheckpoint; await f.restart(); await f.files.imports.runOnce()
		const receipt = await f.files.state.get("cloud-imports", claim.workId)
		assert.equal(receipt.processingReceipt.ticketId, jobId); assert.equal(receipt.processingReceipt.processorSubmissionKey, key)
		assert.equal((await f.files.state.list("processing-jobs")).length, 1)
		assert.equal((await f.files.state.list("local-changes")).filter((o) => o.operationId === claim.operationId).length, 1)
	}
})
test("changed cloud head and source substitution cannot admit old extraction or resurrect a tombstone", async (t) => {
	const f = await fixture(t), old = entry(), claim = f.backend.add(old)
	const tombstone = { path: old.path, kind: "tombstone", headToken: crypto.randomUUID(), changeSeq: 2, fileVersionId: null }
	f.backend.heads = []; f.backend.changes.push({ changeSeq: 2, entries: [tombstone] })
	await f.files.imports.runOnce()
	assert.equal((await f.files.state.list("processing-jobs")).length, 0); assert.equal(f.backend.permits.length, 0)
	await assert.rejects(fs.stat(path.join(f.root, old.path)), { code: "ENOENT" })
	const next = f.backend.add(entry("other.csv", 3))
	const source = f.backend.source.bind(f.backend)
	f.backend.source = async (id) => ({ ...await source(id), objectIdentity: "a-different-object" })
	await f.files.imports.runOnce()
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
	assert.equal(await f.files.state.get("cloud-imports", next.workId), null)
	assert.equal((await f.files.state.get("cloud-deliveries", next.workId)).error.error, "source_substitution")
})
test("a missing held capacity source is never rebound to a live replacement; drain includes unresolved import obligations", async (t) => {
	const f = await fixture(t, { activeTickets: 1 })
	f.backend.add(entry("one.csv", 1)); await f.files.imports.runOnce()
	const claim = f.backend.add(entry("two.csv", 2)); await f.files.imports.runOnce()
	const receipt = await f.files.state.get("cloud-imports", claim.workId)
	await fs.unlink(path.join(f.files.captures.blobDir, `capture.${receipt.source.captureId}`))
	await fs.writeFile(path.join(f.root, "two.csv"), "current replacement")
	const first = (await f.files.state.list("processing-jobs"))[0]; await f.files.state.put("processing-jobs", first.runtimeJobId, { ...first, deliveryStage: "terminal" })
	await f.files.imports.runOnce()
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
	assert.equal((await f.files.state.get("cloud-imports", claim.workId)).processingReceipt.state, "awaiting-capacity")
	const drained = await f.files.imports.drain(new Date(Date.now() + 1000).toISOString())
	assert.ok(drained.remotePending > 0); assert.equal(drained.complete, false)
})
test("newer parallel path import never skips earlier feed changes on another path", async (t) => {
	const f = await fixture(t); await f.files.imports.runOnce()
	const a = entry("earlier.csv", 1), b = entry("later.csv", 2)
	f.backend.content.set(a.fileVersionId, { body: bytes, sizeBytes: bytes.length, sha256: digest(bytes) }); f.backend.heads.push(a); f.backend.changes.push({ changeSeq: 1, entries: [a] })
	f.backend.add(b, "skip")
	await f.files.imports.runOnce()
	assert.equal(await fs.readFile(path.join(f.root, a.path), "utf8"), bytes)
	assert.equal(await fs.readFile(path.join(f.root, b.path), "utf8"), bytes)
	assert.equal((await f.files.state.get("cloud-sync", "checkpoint")).afterSeq, 2)
})

test("concurrent same-operation remote publications replay one exact receipt and source", async (t) => {
	const f = await fixture(t), head = entry("duplicate.csv", 1), change = { operationId: "duplicate-remote", path: head.path, remoteEtag: head.headToken, entries: [head], processingPolicy: "skip" }
	const results = await Promise.all(Array.from({ length: 6 }, () => f.files.applyRemote(change, Readable.from([bytes]), null)))
	assert.equal(new Set(results.map((op) => op.localGeneration)).size, 1)
	assert.equal(new Set(results.map((op) => op.publishedSource.captureId)).size, 1)
	assert.equal((await f.files.state.list("local-changes")).filter((op) => op.operationId === change.operationId).length, 1)
})

test("SIGKILL after namespace publication reopens the retained epoch and commits the same reserved ticket", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()), receiptId = `import-receipt:${stableId(claim.operationId)}`
	await f.backend.progress(claim, { progressSeq: 1, stage: "verified", downloadedBytes: bytes.length, receiptId })
	const publication = await f.backend.permit(claim, "publication", receiptId), processing = await f.backend.permit(claim, "processing", receiptId, publication.permitId)
	const epoch = f.files.identity.workspaceEpoch
	await f.files.close()
	const script = `
import { WorkspaceFiles } from ${JSON.stringify(new URL("../lib/workspace-files.js", import.meta.url).href)};
import { Readable } from 'node:stream';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const {config,claim,publication,processing,bytes}=JSON.parse(input);
const adapter={aligned:true,bind(){},claim:async()=>({claims:[claim]}),progress:async()=>({}),source:async()=>claim.source,download:async()=>Readable.from([bytes]),permit:async(c,kind)=>kind==='publication'?publication:processing,reconcile:async()=>({results:[]}),ack:async()=>{throw new Error('must not ack before receipt')},snapshot:async()=>({snapshotId:'snapshot',throughSeq:0,entries:[]}),changesAfter:async()=>({afterSeq:0,throughSeq:0,changes:[]})};
config.persistenceAdapter=adapter; config.cloudImport={background:false};
config.filesCheckpoint=async(stage)=>{if(stage==='remote-published'){process.stdout.write('NAMESPACE_PUBLISHED\\n'); await new Promise(()=>{});}};
const workspace=await WorkspaceFiles.open(config,{info(){},warn(){},error(){}});
clearTimeout(workspace.processing.timer); workspace.processing.started=false;
await workspace.imports.runOnce();
`
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] })
	t.after(() => child.kill("SIGKILL"))
	let output = "", errors = ""; child.stdout.on("data", (c) => { output += c }); child.stderr.on("data", (c) => { errors += c })
	child.stdin.end(JSON.stringify({ config: { ...f.config, persistenceAdapter: undefined, writerRegistry: undefined }, claim, publication, processing, bytes }))
	const end = Date.now() + 10000
	while (!output.includes("NAMESPACE_PUBLISHED")) { if (Date.now() > end || child.exitCode !== null) throw new Error(`child failed before crash point: ${errors}`); await delay(10) }
	const stopped = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })))
	child.kill("SIGKILL"); assert.equal((await stopped).signal, "SIGKILL")
	f.backend.claims = []
	await f.restart(); await f.files.imports.runOnce()
	assert.equal(f.files.identity.workspaceEpoch, epoch)
	const receipt = await f.files.state.get("cloud-imports", claim.workId), op = await f.files.operation(claim.operationId)
	assert.equal(receipt.processingReceipt.ticketId, op.processingAdmission.jobId)
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 1)
	assert.equal(await fs.readFile(path.join(f.root, "data.csv"), "utf8"), bytes)
})

test("lost processing grant response reconciles the registered permit, even if snapshot hydration already materialized the same source", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()), permit = f.backend.permit.bind(f.backend); let lost = false
	f.backend.permit = async (...args) => { const value = await permit(...args); if (args[1] === "processing" && !lost) { lost = true; throw new Error("grant response lost") } return value }
	await f.files.imports.runOnce(); assert.equal(lost, true)
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
	await f.files.imports.runOnce()
	const receipt = await f.files.state.get("cloud-imports", claim.workId)
	assert.equal(receipt?.processingReceipt.state, "ticket")
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 1)
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
})

test("expired delivery with a known processing permit and definitively uncommitted local ticket reuses that permit and reconciles its receipt", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()), permit = f.backend.permit.bind(f.backend); let lost = false
	f.backend.permit = async (...args) => { const value = await permit(...args); if (args[1] === "processing" && !lost) { lost = true; throw new Error("grant response lost") } return value }
	await f.files.imports.runOnce()
	f.backend.claims.push({ ...claim, attemptId: crypto.randomUUID(), attemptRevision: 2, leaseExpiresAt: new Date(0).toISOString(), recovery: "reconcile" })
	await f.files.imports.runOnce()
	const receipt = await f.files.state.get("cloud-imports", claim.workId)
	assert.equal(receipt?.processingReceipt.state, "ticket")
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 1)
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
	assert.equal(receipt.ackedRevision, receipt.receiptRevision)
	assert.ok(f.backend.reconciles.length > 0)
})
test("paged frozen hydration retains its boundary through an interrupted ordered interval, then resumes without automatic tickets", async (t) => {
	const f = await fixture(t), a = entry("a.csv", 1), b = entry("b.csv", 2), tombstone = { path: a.path, kind: "tombstone", headToken: crypto.randomUUID(), fileVersionId: null, changeSeq: 3 }
	for (const head of [a, b]) f.backend.content.set(head.fileVersionId, { body: bytes, sizeBytes: bytes.length, sha256: digest(bytes) })
	f.backend.createSnapshot = async () => ({ snapshotId: "frozen", throughSeq: 1 })
	f.backend.snapshotPage = async (_id, cursor) => ({ snapshotId: "frozen", throughSeq: 1, entries: cursor ? [] : [a], nextCursor: cursor ? null : "last-page" })
	let fail = true
	f.backend.changesAfter = async (seq, cursor) => {
		if (seq === 3) return { afterSeq: 3, throughSeq: 3, changes: [], nextCursor: null }
		assert.equal(seq, 1)
		if (cursor && fail) throw Object.assign(new Error("page unavailable"), { status: 503 })
		return { afterSeq: 1, throughSeq: 3, changes: [{ changeSeq: cursor ? 3 : 2, entries: cursor ? [tombstone] : [b] }], nextCursor: cursor ? null : "second-change-page" }
	}
	await f.files.imports.runOnce()
	assert.equal((await f.files.state.get("cloud-sync", "checkpoint")).afterSeq, 1)
	assert.equal(await fs.readFile(path.join(f.root, "b.csv"), "utf8"), bytes)
	fail = false; await f.restart(); await f.files.imports.runOnce()
	assert.equal((await f.files.state.get("cloud-sync", "checkpoint")).afterSeq, 3)
	await assert.rejects(fs.stat(path.join(f.root, "a.csv")), { code: "ENOENT" })
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
})
test("captured server skips never become new automatic work after enablement; rehydrate with historical processing remains unresolved", async (t) => {
	const f = await fixture(t), skip = f.backend.add(entry("skipped.csv", 1))
	skip.processingReceipt = { state: "skipped", reason: "processing-disabled" }
	await f.files.imports.runOnce()
	assert.equal((await f.files.state.get("cloud-imports", skip.workId)).processingReceipt.reason, "processing-disabled")
	await f.restart(); await f.files.imports.runOnce(); assert.equal((await f.files.state.list("processing-jobs")).length, 0)
	const historical = f.backend.add(entry("historical.csv", 2)); historical.recovery = "rehydrate"; historical.processingReceipt = { state: "ticket", ticketId: "old-ticket" }
	await f.files.imports.runOnce()
	assert.equal(await fs.readFile(path.join(f.root, "historical.csv"), "utf8"), bytes)
	assert.equal(await f.files.state.get("cloud-imports", historical.workId), null)
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
	assert.equal((await f.files.state.get("cloud-deliveries", historical.workId)).error.error, "rehydrate_processing_receipt_unresolved")
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 0)
})

test("unknown-writer pending replacement can apply now, and lost action acknowledgement replays the committed receipt without fetching newer bytes", async (t) => {
	const f = await fixture(t); f.backend.add(entry(), "skip"); await f.files.imports.runOnce()
	f.config.writerRegistry = { status: async () => ({ state: "unknown" }) }
	const next = entry("data.csv", 2, "replacement")
	f.backend.heads = [next]; f.backend.content.set(next.fileVersionId, { body: "replacement", sizeBytes: 11, sha256: digest("replacement") }); f.backend.changes.push({ changeSeq: 2, entries: [next] })
	await f.files.imports.runOnce()
	assert.equal(await fs.readFile(path.join(f.root, "data.csv"), "utf8"), bytes)
	const request = { operationId: "apply-known", path: next.path, remoteEtag: next.headToken, applyNow: true }
	const applied = await f.files.applyPendingRemote(request)
	assert.equal(applied.state, "committed"); assert.equal(await fs.readFile(path.join(f.root, "data.csv"), "utf8"), "replacement")
	f.backend.checkHead = async () => { throw new Error("a receipt replay must not fetch or revalidate a later head") }
	assert.equal((await f.files.applyPendingRemote(request)).localGeneration, applied.localGeneration)
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
})

test("HTTP apply-remote returns the committed public receipt and replays it without replacing newer Current", async (t) => {
	const f = await fixture(t); f.backend.add(entry(), "skip"); await f.files.imports.runOnce()
	f.config.writerRegistry = { status: async () => ({ state: "unknown" }) }
	const next = entry("data.csv", 2, "replacement")
	f.backend.heads = [next]; f.backend.content.set(next.fileVersionId, { body: "replacement", sizeBytes: 11, sha256: digest("replacement") }); f.backend.changes.push({ changeSeq: 2, entries: [next] })
	await f.files.imports.runOnce()
	assert.ok(await f.files.state.get("cloud-pending", pathKey(next.path)))
	assert.equal(await fs.readFile(path.join(f.root, next.path), "utf8"), bytes)
	const api = new FilesApi(f.files, logger), server = http.createServer((req, res) => api.handle(req, res))
	await new Promise((r) => server.listen(0, "127.0.0.1", r))
	t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await api.close() })
	const base = `http://127.0.0.1:${server.address().port}`, request = { operationId: "http-apply-known", path: next.path, remoteEtag: next.headToken, applyNow: true }
	const apply = () => fetch(`${base}/files/sync/apply-remote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) })
	const response = await apply(), receipt = await response.json()
	assert.equal(response.status, 200, JSON.stringify(receipt))
	assert.equal(receipt.filesContractVersion, 1); assert.equal(receipt.operationId, request.operationId); assert.equal(receipt.action, "apply-remote"); assert.equal(receipt.state, "committed")
	assert.equal(receipt.publishedSource.digest.sha256, next.sha256)
	assert.deepEqual(receipt, await (await fetch(`${base}/files/operations/${request.operationId}`)).json())
	assert.equal(receipt.claim, undefined); assert.equal(receipt.evidenceHoldId, undefined); assert.equal(receipt.bases, undefined)
	assert.equal(await fs.readFile(path.join(f.root, next.path), "utf8"), "replacement")
	assert.equal(await f.files.state.get("cloud-pending", pathKey(next.path)), null)
	await fs.writeFile(path.join(f.root, next.path), "newer local bytes")
	f.backend.checkHead = async () => { throw new Error("Receipt replay must not revalidate a newer head.") }
	f.backend.download = async () => { throw new Error("Receipt replay must not download another source.") }
	const replay = await apply()
	assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), receipt)
	assert.equal(await fs.readFile(path.join(f.root, next.path), "utf8"), "newer local bytes")
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
})

test("a blocked ordered remote replacement does not starve an unrelated captured local write", async (t) => {
	const f = await fixture(t); f.backend.add(entry(), "skip"); await f.files.imports.runOnce()
	f.config.writerRegistry = { status: async () => ({ state: "unknown" }) }
	const next = entry("data.csv", 2, "replacement")
	f.backend.heads = [next]; f.backend.content.set(next.fileVersionId, { body: "replacement", sizeBytes: 11, sha256: digest("replacement") }); f.backend.changes.push({ changeSeq: 2, entries: [next] })
	await f.files.upload(Readable.from(["local bytes"]), { operationId: "independent-local", path: "local.csv", processingPolicy: "skip" })
	let sent = false
	f.backend.upload = async (op, source) => { assert.equal(op.cloudBaseHead, null); assert.equal((await source.handle.readFile("utf8")), "local bytes"); sent = true; return { status: "ready", path: op.intent.path, fileVersionId: crypto.randomUUID(), headToken: crypto.randomUUID(), changeSeq: 3, sizeBytes: 11, sha256: digest("local bytes") } }
	await f.files.imports.runOnce()
	assert.equal(sent, true)
	assert.equal((await f.files.operation("independent-local")).persistence.state, "clean")
	assert.equal((await f.files.state.get("cloud-sync", "checkpoint")).afterSeq, 1, "a local acknowledgement cannot skip a blocked global feed interval")
})

test("enabled import readiness and cloud jobs fit the public wire contract", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
	const schemas = buildFilesOpenApi().components.schemas, info = await f.files.info()
	assert.ok(schemas.FilesInfo.properties.hydration.properties.state.enum.includes(info.hydration.state), "the published client contract must accept actual configured readiness")
	assert.ok(schemas.FilesInfo.properties.cloudDirectories.enum.includes(info.cloudDirectories))
	const job = await f.files.processing.get((await f.files.state.get("cloud-imports", claim.workId)).processingReceipt.ticketId)
	assert.ok(schemas.ProcessingJob.properties.trigger.enum.includes(job.trigger))
	assert.equal(job.requestId, null, "an automatic internal work request is not a public UUID submission request")
	assert.equal(job.source.fileVersionId, claim.source.fileVersionId)
})
test("public imported operation receipts disclose job status but no machine permits, claim or processor submission key", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
	const stored = await f.files.state.get("cloud-imports", claim.workId), api = new FilesApi(f.files, logger)
	const server = http.createServer(async (req, res) => { if (!await api.handle(req, res)) { res.writeHead(404); res.end() } })
	await new Promise((r) => server.listen(0, "127.0.0.1", r))
	t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await api.close() })
	const response = await fetch(`http://127.0.0.1:${server.address().port}/files/operations/${encodeURIComponent(claim.operationId)}`), text = await response.text(), publicReceipt = JSON.parse(text)
	assert.equal(response.status, 200)
	assert.equal(text.includes(stored.processingReceipt.processorSubmissionKey), false, "private same-key processor admission must not become a browser receipt")
	assert.equal(publicReceipt.claim, undefined); assert.equal(publicReceipt.publicationPermit, undefined); assert.equal(publicReceipt.processingPermit, undefined)
	assert.equal(publicReceipt.processing.state, "pending"); assert.equal(publicReceipt.processing.jobId, stored.processingReceipt.ticketId)
})

test("reviewed contract: opaque backend operation IDs bind deterministic receipts without deriving identity from their format", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry())
	claim.operationId = `import:${digest(JSON.stringify([claim.workId, claim.runtimeId, claim.workspaceEpoch]))}`
	await f.files.imports.runOnce()
	const receipt = await f.files.state.get("cloud-imports", claim.workId)
	assert.equal(receipt?.receipt.operationId, claim.operationId)
	assert.equal(receipt.receipt.receiptId, `import-receipt:${stableId(claim.operationId)}`)
})
function historical(claim, outcome = "owner-lost") {
	return { state: "historical", outcome, previousOwner: { runtimeId: crypto.randomUUID(), workspaceId: claim.workspaceId, workspaceEpoch: crypto.randomUUID() }, previousProcessingReceipt: { state: "ticket", requestId: claim.processingRequestId, sourceFileVersionId: claim.source.fileVersionId, ticketId: "previous-ticket", processorSubmissionKey: crypto.randomUUID(), processorJobId: "previous-processor-job", processingPermitId: crypto.randomUUID() } }
}
test("reviewed contract: fenced historical rehydrate publishes and acknowledges history without adopting a ticket or processing permit", async (t) => {
	for (const outcome of ["owner-lost", "interrupted"]) {
		const f = await fixture(t), claim = f.backend.add(entry(), "skip")
		claim.recovery = "rehydrate"; claim.processingReceipt = historical(claim, outcome)
		claim.processingPermit = { permitId: claim.processingReceipt.previousProcessingReceipt.processingPermitId, ownerRevision: 1, kind: "processing", state: "reconciliation-pending", ...claim.processingReceipt.previousOwner }
		await f.files.imports.runOnce()
		let receipt = await f.files.state.get("cloud-imports", claim.workId)
		assert.deepEqual(receipt?.processingReceipt, { ...claim.processingReceipt, requestId: claim.processingRequestId, sourceFileVersionId: claim.source.fileVersionId })
		assert.equal(receipt.processingPermit, null)
		assert.equal((await f.files.state.list("processing-jobs")).length, 0)
		assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 0)
		assert.equal(f.backend.acks.at(-1).processingReceipt.outcome, outcome)
		await f.restart(); await f.files.imports.runOnce()
		receipt = await f.files.state.get("cloud-imports", claim.workId)
		assert.equal(receipt.processingReceipt.previousProcessingReceipt.ticketId, "previous-ticket")
		assert.equal((await f.files.state.list("processing-jobs")).length, 0)
	}
})
test("reviewed contract: wait-owner with a prior local receipt never acknowledges or executes under a new owner", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
	const acks = f.backend.acks.length
	f.backend.claims.push({ ...claim, runtimeId: crypto.randomUUID(), recovery: "wait-owner" })
	await f.files.imports.runOnce()
	assert.equal(f.backend.acks.length, acks)
	assert.equal((await f.files.state.get("cloud-deliveries", claim.workId)).state, "wait-owner")
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
})
test("reviewed contract: every UTF-8 path component obeys its byte ceiling with Unicode preserved", () => {
	for (const name of [`${"é".repeat(128)}.csv`, `${"é".repeat(128)}/ok.csv`, `${"a".repeat(256)}/ok.csv`, "  /ok.csv", "data/\u3000/file.csv"]) assert.throws(() => cloudPath(name), { error: "invalid_path" })
	for (const name of [`${"é".repeat(125)}.csv`, "data/e\u0301.csv", "data/é.csv"]) assert.equal(cloudPath(name), name)
	assert.notEqual(cloudPath("data/e\u0301.csv"), cloudPath("data/é.csv"))
	for (const name of ["outputs/x.csv", "runs/x.csv", "documents/x.csv"]) assert.throws(() => cloudPath(name, { intake: true }), { error: "reserved_intake_path" })
	assert.equal(cloudPath("outputs/x.csv"), "outputs/x.csv", "machine output paths have a separate resource contract")
})
test("reviewed contract: permanent invalid digest reports one stable failure; lost report acknowledgement retries only the report across restart", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); f.backend.content.get(claim.source.fileVersionId).body = "bad-byte"
	let reads = 0, lost = true; const download = f.backend.download.bind(f.backend), report = f.backend.reportFailure.bind(f.backend)
	f.backend.download = async (source) => { reads++; return download(source) }
	f.backend.reportFailure = async (...args) => { const result = await report(...args); if (lost) { lost = false; throw new Error("failure acknowledgement lost") } return result }
	await f.files.imports.runOnce()
	const before = reads; assert.equal(f.backend.failures.length, 1)
	await f.restart(); await f.files.imports.runOnce(); await f.files.imports.runOnce()
	assert.equal(reads, before, "a terminal validation failure cannot repeatedly download or substitute the source")
	assert.equal(f.backend.failures.length, 2)
	assert.deepEqual(f.backend.failures[1], f.backend.failures[0])
	assert.equal(f.backend.failures[0].error, "digest_mismatch"); assert.equal(f.backend.failures[0].retryable, false)
	assert.equal((await f.files.state.get("cloud-deliveries", claim.workId)).state, "failed")
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
})
test("reviewed contract: uncertain publication keeps permits and exact source, with no terminal failure or settlement from transport errors", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry())
	f.config.filesCheckpoint = async (stage) => { if (stage === "remote-published") throw Object.assign(new Error("lost local acknowledgement"), { code: "EIO" }) }
	await f.files.imports.runOnce()
	assert.equal(f.backend.failures.length, 0); assert.equal(f.backend.settlements.length, 0)
	assert.equal((await f.files.operation(claim.operationId)).state, "indeterminate")
	assert.equal(f.backend.permits.length, 2)
})
test("reviewed contract: private drain exposes receipt, capacity, permit and source obligations without cancelling accepted extraction", async (t) => {
	const f = await fixture(t, { activeTickets: 1 }), claim = f.backend.add(entry())
	await f.files.close()
	const controlSecret = "e".repeat(64), gateSecret = "d".repeat(64), app = await createFilesServer({ config: { ...f.config, controlSecret }, secret: gateSecret, logger })
	clearTimeout(app.files.workspace.processing.timer); app.files.workspace.processing.started = false
	await new Promise((r) => app.server.listen(0, "127.0.0.1", r))
	t.after(() => app.shutdown(new Date(Date.now() + 2000).toISOString()))
	await app.files.workspace.imports.runOnce()
	f.backend.add(entry("capacity.csv", 2)); await app.files.workspace.imports.runOnce()
	const response = await fetch(`http://127.0.0.1:${app.server.address().port}/internal/files/drain`, { method: "POST", headers: { "x-gc-files-control": controlSecret, "content-type": "application/json" }, body: JSON.stringify({ deadline: new Date(Date.now() + 2000).toISOString() }) })
	assert.equal(response.status, 200)
	const result = await response.json()
	assert.equal(result.complete, false)
	assert.equal(result.imports.accounting.capacityWaiting, 1)
	assert.equal(result.imports.accounting.processingPermitsUnsettled, 1)
	assert.ok(result.imports.obligations.some((o) => o.workId === claim.workId && o.processing.ticketId && o.sourceHold.state === "retained"))
	assert.ok(result.persistence)
	const job = (await app.files.workspace.state.list("processing-jobs"))[0]
	assert.equal(job.cancelRequestedAt, undefined)
})

test("reviewed contract: running and terminal processing observations use the exact separate ack body without changing the immutable source mapping", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
	const receipt = await f.files.state.get("cloud-imports", claim.workId), job = await f.files.processing.record(receipt.processingReceipt.ticketId)
	await f.files.state.put("processing-jobs", job.runtimeJobId, { ...job, processorJobId: "observed-job", processorState: "running", deliveryStage: "tracking", lastCheckedAt: "2026-10-07T10:00:00.000Z" })
	await f.files.imports.runOnce()
	assert.deepEqual(f.backend.acks.at(-1).observedProcessing, { state: "running", observedAt: "2026-10-07T10:00:00.000Z", ownerRevision: receipt.processingPermit.ownerRevision, startedAt: null, finishedAt: null, interruptedAt: null, stage: null, progress: null, queueAhead: null })
	const mapped = await f.files.processing.record(job.runtimeJobId)
	await f.files.state.put("processing-jobs", job.runtimeJobId, { ...mapped, processorState: "succeeded", deliveryStage: "terminal", outcome: "succeeded", lastCheckedAt: "2026-10-07T10:00:01.000Z" })
	await f.files.imports.runOnce()
	assert.equal(f.backend.acks.at(-1).observedProcessing.state, "succeeded")
	assert.equal(f.backend.acks.at(-1).receipt.fileVersionId, claim.source.fileVersionId)
})
test("reviewed contract: a recovered same-owner capacity receipt may obtain its first processing permit after fresh claim reconciliation", async (t) => {
	const f = await fixture(t, { activeTickets: 1 }); f.backend.add(entry("busy.csv", 1)); await f.files.imports.runOnce()
	const waiting = f.backend.add(entry("waiting.csv", 2)); await f.files.imports.runOnce()
	const active = (await f.files.state.list("processing-jobs"))[0]
	await f.files.state.put("processing-jobs", active.runtimeJobId, { ...active, deliveryStage: "terminal" })
	const delivery = await f.files.state.get("cloud-deliveries", waiting.workId)
	await f.files.state.put("cloud-deliveries", waiting.workId, { ...delivery, claim: { ...delivery.claim, leaseExpiresAt: new Date(0).toISOString() } })
	f.backend.claims.push({ ...waiting, recovery: "reconcile", attemptId: crypto.randomUUID(), attemptRevision: 2 })
	await f.files.imports.runOnce(); await f.files.imports.runOnce()
	assert.equal((await f.files.state.get("cloud-imports", waiting.workId)).processingReceipt.state, "ticket")
	assert.equal(f.backend.permits.filter((p) => p.workId === waiting.workId && p.kind === "processing").length, 1)
})
test("reviewed contract: retained local cloud tickets cannot dispatch before same-owner permit reconciliation after restart", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
	const receipt = await f.files.state.get("cloud-imports", claim.workId), job = await f.files.processing.record(receipt.processingReceipt.ticketId)
	await f.files.state.put("processing-jobs", job.runtimeJobId, { ...job, deliveryStage: "submitting", upstreamRequest: { profileId: "default", source: { kind: "workspace-file", path: "exact.csv", expectedSha256: job.sourceSha256 } } })
	await f.restart()
	let dispatches = 0; f.files.processing.client.submit = async () => { dispatches++; throw new Error("model dispatch must be fenced") }
	await assert.rejects(f.files.processing.dispatch(await f.files.processing.record(job.runtimeJobId)), { error: "owner_reconciliation_required" })
	assert.equal(dispatches, 0)
})
test("reviewed contract: historical owner loss can retain a null pre-ticket mapping without inventing an extraction", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry(), "skip")
	claim.recovery = "rehydrate"; claim.processingReceipt = { ...historical(claim), previousProcessingReceipt: null }
	await f.files.imports.runOnce()
	assert.equal((await f.files.state.get("cloud-imports", claim.workId))?.processingReceipt.previousProcessingReceipt, null)
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
})
test("reviewed contract: fenced generation replacement on retained SQLite archives the old receipt and never adopts its local ticket", async (t) => {
	const f = await fixture(t), old = f.backend.add(entry()); await f.files.imports.runOnce()
	const original = await f.files.state.get("cloud-imports", old.workId)
	f.backend.runtimeId = crypto.randomUUID()
	const history = { state: "historical", requestId: old.processingRequestId, sourceFileVersionId: old.source.fileVersionId, outcome: "interrupted", previousOwner: { runtimeId: old.runtimeId, workspaceId: old.workspaceId, workspaceEpoch: old.workspaceEpoch }, previousProcessingReceipt: original.processingReceipt }
	const replacement = { ...old, runtimeId: f.backend.runtimeId, attemptId: crypto.randomUUID(), attemptRevision: 2, recovery: "rehydrate", processingReceipt: history, processingPermit: original.processingPermit, publicationPermit: null }
	f.backend.fencedOwners.add(old.runtimeId)
	f.backend.work.set(old.workId, replacement); f.backend.claims.push(replacement)
	await f.restart(); await f.files.imports.runOnce()
	const current = await f.files.state.get("cloud-imports", old.workId)
	assert.equal(current?.claim.runtimeId, replacement.runtimeId)
	assert.equal(current.processingReceipt.state, "historical")
	assert.equal(current.processingPermit, null)
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
	assert.equal((await f.files.state.list("cloud-import-history")).length, 1)
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 1)
})

test("accepted review R1: exact terminal settlement replay and lost response preserve durable intents and released holds", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
	const record = await f.files.state.get("cloud-imports", claim.workId), job = await f.files.processing.record(record.processingReceipt.ticketId)
	await f.files.processing.observe(job, { id: "settled-job", projectId: "scope", submissionKey: job.upstreamSubmissionKey, revision: 1, state: "succeeded", startedAt: "2026-10-14T10:00:00.000Z", finishedAt: "2026-10-14T10:01:00.000Z", interruptedAt: null })
	f.backend.lostSettlement = true
	await f.files.imports.runOnce(); await f.files.imports.runOnce(); await f.files.imports.runOnce()
	const stored = await f.files.state.get("cloud-imports", claim.workId)
	assert.equal(stored.processingSettled, true, JSON.stringify({ error: f.files.imports.lastError, settlements: f.backend.settlements.map((s) => s.evidence.state) }))
	assert.equal(stored.sourceHoldId, null)
	assert.ok(stored.publicationSettlementIntent)
	assert.ok(stored.processingSettlementIntent)
	assert.notEqual(f.files.imports.lastError?.error, "settlement_changed")
})
test("accepted review R1 backend evidence: publication with a reserved ticket settles without denying its known submission identity", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
	const record = await f.files.state.get("cloud-imports", claim.workId)
	assert.equal(record.publicationSettled, true, JSON.stringify(f.files.imports.lastError))
	assert.equal(record.publicationSettlementIntent.evidence.processor.submissionKey, record.processingReceipt.processorSubmissionKey)
	assert.equal(record.publicationSettlementIntent.evidence.processor.state, "unknown")
	assert.ok(record.sourceHoldId)
})
test("accepted review R1 backend evidence: a terminal local ticket without a processor job retains its mapping and reconciliation source", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
	const record = await f.files.state.get("cloud-imports", claim.workId), job = await f.files.processing.record(record.processingReceipt.ticketId)
	await f.files.processing.cancel(job.runtimeJobId)
	await f.files.imports.runOnce()
	const pending = await f.files.state.get("cloud-imports", claim.workId)
	assert.equal(pending.publicationSettled, true)
	assert.equal(pending.processingSettled, false)
	assert.equal(pending.processingSettlementIntent.evidence.processor.state, "unknown")
	assert.equal(pending.processingSettlementIntent.evidence.processor.submissionKey, job.upstreamSubmissionKey)
	assert.ok(pending.sourceHoldId)
	await f.files.processing.cleanup(await f.files.processing.record(job.runtimeJobId))
	assert.ok(await f.files.state.get("holds", pending.sourceHoldId))
	await f.restart(); await f.files.imports.runOnce()
	assert.equal((await f.files.state.get("cloud-imports", claim.workId)).processingSettled, false)
	assert.equal((await f.files.captures.text("capture", record.source.captureId)).text, bytes)
	const drained = await f.files.imports.drain(new Date(Date.now() + 1000).toISOString())
	assert.equal(drained.accounting.processingPermitsUnsettled, 1)
	assert.equal(drained.complete, false)
})
test("accepted review R2: expired publication-only claim resumes its definitively uncommitted first automatic admission", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()), permit = f.backend.permit.bind(f.backend); let rejected = false
	f.backend.permit = async (...args) => { if (args[1] === "processing" && !rejected) { rejected = true; throw Object.assign(new Error("admission unavailable"), { status: 503 }) } return permit(...args) }
	await f.files.imports.runOnce()
	f.backend.claims.push({ ...claim, recovery: "reconcile", attemptId: crypto.randomUUID(), attemptRevision: 2 })
	await f.files.imports.runOnce(); await f.files.imports.runOnce()
	assert.equal((await f.files.state.get("cloud-imports", claim.workId))?.processingReceipt.state, "ticket")
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 1)
})
test("lost processing grant reconciles before capacity or disablement and retains accepted ticket authority", async (t) => {
	for (const mode of ["capacity", "disabled", "unknown"]) {
		const f = await fixture(t), claim = f.backend.add(entry()), permit = f.backend.permit.bind(f.backend); let lost = false
		f.backend.permit = async (...args) => { const p = await permit(...args); if (args[1] === "processing" && !lost) { lost = true; throw new Error("lost granted permit") } return p }
		await f.files.imports.runOnce()
		if (mode === "disabled") { f.files.processing.config.enabled = false; f.backend.processingEnabled = false }
		else f.files.processing.capacity = async () => f.files.processing.config.activeTickets
		if (mode === "unknown") f.backend.getWork = async () => { throw Object.assign(new Error("inspection unavailable"), { status: 503 }) }
		await f.files.imports.runOnce()
		const record = await f.files.state.get("cloud-imports", claim.workId)
		if (mode === "unknown") assert.equal(record, null)
		else { assert.equal(record?.processingReceipt.state, "ticket"); assert.equal(record.processingReceipt.processingPermitId, f.backend.permits.find((p) => p.kind === "processing").permitId) }
	}
})
function queueReplacement(f, old, processingReceipt) {
	f.backend.fencedOwners.add(old.runtimeId)
	f.backend.runtimeId = crypto.randomUUID()
	const replacement = { ...old, runtimeId: f.backend.runtimeId, attemptId: crypto.randomUUID(), attemptRevision: old.attemptRevision + 1, recovery: "rehydrate", processingReceipt, processingPolicy: processingReceipt.state === "skipped" ? "skip" : old.processingPolicy, publicationPermit: null }
	f.backend.work.set(old.workId, replacement); f.backend.claims.push(replacement)
	return replacement
}
async function replaceOwner(f, old, processingReceipt) {
	const replacement = queueReplacement(f, old, processingReceipt)
	await f.restart(); await f.files.imports.runOnce()
	return replacement
}
test("accepted review R4: publication-only disabled work rehomes with its normal skip and no fabricated history", async (t) => {
	const f = await fixture(t, { enabled: false }), old = f.backend.add(entry()); await f.files.imports.runOnce()
	const record = await f.files.state.get("cloud-imports", old.workId)
	const replacement = await replaceOwner(f, old, record.processingReceipt)
	const current = await f.files.state.get("cloud-imports", old.workId)
	assert.equal(current?.claim.runtimeId, replacement.runtimeId)
	assert.equal(current.processingReceipt.state, "skipped"); assert.equal(current.processingReceipt.reason, "processing-disabled")
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
})
test("accepted review R5: A to B to C rehomes publication ownership and preserves immutable A processing history", async (t) => {
	const f = await fixture(t), a = f.backend.add(entry()); await f.files.imports.runOnce()
	const record = await f.files.state.get("cloud-imports", a.workId)
	const history = { ...historical(a, "interrupted"), previousOwner: { runtimeId: a.runtimeId, workspaceId: a.workspaceId, workspaceEpoch: a.workspaceEpoch }, previousProcessingReceipt: record.processingReceipt }
	const b = await replaceOwner(f, a, history), c = await replaceOwner(f, b, history)
	const current = await f.files.state.get("cloud-imports", a.workId)
	assert.equal(current?.claim.runtimeId, c.runtimeId); assert.deepEqual(current.processingReceipt, { ...history, requestId: a.processingRequestId, sourceFileVersionId: a.source.fileVersionId })
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
})
test("accepted review R6: receipt expiry overlapping remote publication cannot deadlock managed and retention locks", async (t) => {
	const base = await fs.mkdtemp(path.join(os.homedir(), ".gc-lock-race-")); await fs.chmod(base, 0o700)
	const config = { workspaceDir: path.join(base, "project"), filesStateDir: path.join(base, "state"), filesAgentUids: [20001], filesWorkerUids: [20003], filesLimits: { receiptMs: 1 }, writerRegistry: { status: async () => ({ state: "idle" }) } }
	await fs.mkdir(config.workspaceDir, { mode: 0o2775 })
	const head = entry("remote.csv", 1), script = `
import {WorkspaceFiles} from ${JSON.stringify(new URL("../lib/workspace-files.js", import.meta.url).href)}; import {Readable} from 'node:stream';
let input=''; for await(const c of process.stdin) input+=c; const {config,head,bytes}=JSON.parse(input); config.writerRegistry={status:async()=>({state:'idle'})};
const ws=await WorkspaceFiles.open(config,{info(){},warn(){},error(){}}); await ws.upload(Readable.from(['expiry']),{operationId:'expiry',path:'local.csv'});
const op=await ws.remote.prepare({operationId:'remote-race',path:head.path,entries:[head],remoteEtag:head.headToken},Readable.from([bytes]));
let expiryEntered,retentionEntered; const expiry=new Promise(r=>expiryEntered=r), retained=new Promise(r=>retentionEntered=r);
const release=ws.captures.releaseHold.bind(ws.captures), retain=ws.captures.withRetention.bind(ws.captures);
ws.captures.releaseHold=async(id)=>{expiryEntered(); await retained; return release(id)};
ws.captures.withRetention=work=>retain(async()=>{retentionEntered(); return work()});
await new Promise(r=>setTimeout(r,10)); const sweep=ws.sweep(); await expiry; process.stdout.write('RACE_STARTED\\n');
await Promise.all([sweep,ws.remote.publish(op)]); process.stdout.write('RACE_DONE\\n'); await ws.close();
`
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] }); let output = "", errors = ""
	child.stdout.on("data", (c) => { output += c }); child.stderr.on("data", (c) => { errors += c }); child.stdin.end(JSON.stringify({ config, head, bytes }))
	t.after(async () => { child.kill("SIGKILL"); await fs.rm(base, { recursive: true, force: true }) })
	const startup = Date.now() + 8000; while (!output.includes("RACE_STARTED")) { assert.ok(Date.now() < startup && child.exitCode === null, errors); await delay(10) }
	const deadline = Date.now() + 1500; while (!output.includes("RACE_DONE") && child.exitCode === null && Date.now() < deadline) await delay(10)
	assert.ok(output.includes("RACE_DONE"), "publication and expiry remained deadlocked beyond the bounded overlap")
})
test("accepted review R7: public operation projection never exposes realistic private storage object identities", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()), key = `private/projects/owner-123/${claim.source.fileVersionId}/sealed.csv`
	claim.source.objectIdentity = key; const source = f.backend.source.bind(f.backend); f.backend.source = async (id) => ({ ...await source(id), objectIdentity: key })
	await f.files.imports.runOnce()
	const api = new FilesApi(f.files, logger), server = http.createServer((req, res) => api.handle(req, res)); await new Promise((r) => server.listen(0, "127.0.0.1", r))
	t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await api.close() })
	const text = await (await fetch(`http://127.0.0.1:${server.address().port}/files/operations/${encodeURIComponent(claim.operationId)}`)).text()
	assert.equal(text.includes(key), false)
})
test("accepted review R8: cloud acknowledgement and baseline survive atomic commit failure and SQLite reopen together", async (t) => {
	const f = await fixture(t); await f.files.imports.runOnce()
	const op = (await f.files.upload(Readable.from([bytes]), { operationId: "persist-atomic", path: "saved.csv", processingPolicy: "skip" })).operation, head = entry("saved.csv", 1)
	f.backend.upload = async () => ({ ...head, status: "ready" })
	let crashed = false; const put = f.files.state.put.bind(f.files.state), tx = f.files.state.transaction.bind(f.files.state)
	f.files.state.put = async (kind, id, value) => { if (!crashed && kind === "cloud-heads" && value.path === "saved.csv") { crashed = true; throw Object.assign(new Error("baseline commit failed"), { code: "EIO" }) } return put(kind, id, value) }
	f.files.state.transaction = async (ops) => { if (!crashed && ops.some((o) => o.kind === "cloud-heads" && o.value.path === "saved.csv")) { crashed = true; throw Object.assign(new Error("atomic commit failed"), { code: "EIO" }) } return tx(ops) }
	await f.files.imports.runOnce(); assert.equal(crashed, true)
	await f.restart(); await f.files.imports.runOnce()
	assert.equal((await f.files.operation(op.operationId)).persistence.state, "clean")
	assert.equal((await f.files.remote.baseline("saved.csv"))?.headToken, head.headToken)
})
test("accepted review R9: delayed move acknowledgement cannot regress a newly recreated source head", async (t) => {
	const f = await fixture(t), first = f.backend.add(entry("a.csv", 1), "skip"); await f.files.imports.runOnce()
	const moved = await f.files.move({ operationId: "move-local", from: "a.csv", to: "b.csv", baseObservation: (await f.files.stat("a.csv")).observation })
	const recreated = entry("a.csv", 3), tomb = { path: "a.csv", kind: "tombstone", headToken: crypto.randomUUID(), fileVersionId: null, changeSeq: 2 }, destination = { ...f.backend.heads[0], path: "b.csv", headToken: crypto.randomUUID(), changeSeq: 2 }
	f.backend.upload = async () => { throw new Error("no upload needed") }
	f.backend.mutations = async () => { await f.files.applyRemote({ operationId: "new-recreation", path: "a.csv", entries: [recreated], remoteEtag: recreated.headToken }, Readable.from([bytes])); return { results: [{ operationId: moved.operation.operationId, status: "ready", entries: [tomb, destination], changeSeq: 2 }] } }
	await f.files.imports.pushLocal()
	assert.equal((await f.files.remote.baseline("a.csv")).changeSeq, 3)
	assert.equal((await f.files.remote.baseline("a.csv")).headToken, recreated.headToken)
})
test("accepted review R10: terminal cloud conflict retains its source without starving independent queued writes", async (t) => {
	const f = await fixture(t); await f.files.imports.runOnce()
	await f.files.upload(Readable.from([bytes]), { operationId: "conflict-first", path: "blocked.csv", processingPolicy: "skip" })
	await f.files.upload(Readable.from([bytes]), { operationId: "independent-next", path: "good.csv", processingPolicy: "skip" })
	const sent = []; f.backend.upload = async (op) => { sent.push(op.intent.path); return op.intent.path === "blocked.csv" ? { status: "conflict", currentHead: entry("blocked.csv", 1) } : { ...entry("good.csv", 2), status: "ready" } }
	await f.files.imports.runOnce(); await f.files.imports.runOnce()
	assert.equal((await f.files.operation("independent-next")).persistence.state, "clean")
	assert.equal(sent.filter((name) => name === "blocked.csv").length, 1)
	assert.ok((await f.files.state.list("holds")).some((h) => h.reason === "sync"))
})
test("accepted review R11: full snapshot absence never invents a tombstone token or erases local managed bytes", async (t) => {
	const f = await fixture(t); f.backend.add(entry(), "skip"); await f.files.imports.runOnce()
	f.backend.heads = []; f.backend.changes.push({ changeSeq: 2, entries: [] }); await f.files.state.delete("cloud-sync", "checkpoint")
	await f.files.imports.runOnce()
	assert.equal(await fs.readFile(path.join(f.root, "data.csv"), "utf8"), bytes)
	const baseline = await f.files.remote.baseline("data.csv")
	assert.equal(baseline.headKnown, false)
})
test("accepted review R12: owned child publications and removals preserve clean directory evidence for ordered moves", async (t) => {
	const f = await fixture(t), dir = { path: "folder", kind: "directory", headToken: crypto.randomUUID(), fileVersionId: null, changeSeq: 1 }, child = entry("folder/data.csv", 2)
	f.backend.heads = [dir, child]; f.backend.content.set(child.fileVersionId, { body: bytes, sizeBytes: bytes.length, sha256: digest(bytes) }); f.backend.changes = [{ changeSeq: 1, entries: [dir] }, { changeSeq: 2, entries: [child] }]
	await f.files.imports.runOnce()
	const deletedChild = { path: child.path, kind: "tombstone", headToken: crypto.randomUUID(), fileVersionId: null, changeSeq: 3 }; f.backend.changes.push({ changeSeq: 3, entries: [deletedChild] }); await f.files.imports.runOnce()
	const deletedDir = { path: dir.path, kind: "tombstone", headToken: crypto.randomUUID(), fileVersionId: null, changeSeq: 4 }, movedDir = { ...dir, path: "renamed", headToken: crypto.randomUUID(), changeSeq: 4 }; f.backend.changes.push({ changeSeq: 4, entries: [deletedDir, movedDir] }); await f.files.imports.runOnce()
	assert.equal((await fs.stat(path.join(f.root, "renamed"))).isDirectory(), true)
	assert.equal((await f.files.state.get("cloud-sync", "checkpoint")).afterSeq, 4)
})
test("accepted review R13: cancelling never enters an unsupported backend observation vocabulary", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
	const record = await f.files.state.get("cloud-imports", claim.workId), job = await f.files.processing.record(record.processingReceipt.ticketId)
	await f.files.state.put("processing-jobs", job.runtimeJobId, { ...job, processorState: "cancelling", deliveryStage: "tracking", processorJobId: "cancel-job", lastCheckedAt: new Date().toISOString() })
	await f.files.imports.runOnce()
	assert.notEqual(f.files.imports.lastError?.error, "invalid_observation")
	assert.equal(f.backend.acks.at(-1).observedProcessing?.state, "cancelling")
	assert.ok(f.backend.acks.every((r) => !r.observedProcessing || ["queued", "running", "cancelling", "succeeded", "partial", "failed", "cancelled", "interrupted"].includes(r.observedProcessing.state)))
})
test("accepted review R11 tombstones: resnapshot preserves the authoritative recreation CAS token", async (t) => {
	const f = await fixture(t); f.backend.add(entry(), "skip"); await f.files.imports.runOnce()
	const tomb = { path: "data.csv", kind: "tombstone", headToken: crypto.randomUUID(), fileVersionId: null, changeSeq: 2 }
	f.backend.heads = [tomb]; f.backend.changes.push({ changeSeq: 2, entries: [tomb] }); await f.files.state.delete("cloud-sync", "checkpoint")
	await f.files.imports.runOnce(); await assert.rejects(fs.stat(path.join(f.root, "data.csv")), { code: "ENOENT" })
	await f.files.upload(Readable.from([bytes]), { operationId: "intentional-recreate", path: "data.csv", processingPolicy: "skip" })
	let expected; f.backend.upload = async (op) => { expected = op.cloudBaseHead; return { ...entry("data.csv", 3), status: "ready" } }
	await f.files.imports.pushLocal()
	assert.equal(expected, tomb.headToken)
	assert.equal((await f.files.operation("intentional-recreate")).persistence.state, "clean")
})
test("accepted review R12 snapshot removals: authoritative child tombstones apply before the parent directory", async (t) => {
	const f = await fixture(t), dir = { path: "folder", kind: "directory", headToken: crypto.randomUUID(), fileVersionId: null, changeSeq: 1 }, child = entry("folder/data.csv", 2)
	f.backend.heads = [dir, child]; f.backend.content.set(child.fileVersionId, { body: bytes, sizeBytes: bytes.length, sha256: digest(bytes) }); f.backend.changes = [{ changeSeq: 2, entries: [child] }]
	await f.files.imports.runOnce()
	f.backend.heads = [{ ...dir, kind: "tombstone", changeSeq: 3, headToken: crypto.randomUUID() }, { path: child.path, kind: "tombstone", fileVersionId: null, changeSeq: 3, headToken: crypto.randomUUID() }]; f.backend.changes.push({ changeSeq: 3, entries: f.backend.heads })
	await f.files.state.delete("cloud-sync", "checkpoint"); await f.files.imports.runOnce()
	await assert.rejects(fs.stat(path.join(f.root, "folder")), { code: "ENOENT" })
	assert.equal((await f.files.state.get("cloud-sync", "checkpoint")).afterSeq, 3)
})
test("accepted review R12 evidence: an unmanaged sibling change cannot be marked clean by an owned child publication", async (t) => {
	const f = await fixture(t), dir = { path: "folder", kind: "directory", headToken: crypto.randomUUID(), fileVersionId: null, changeSeq: 1 }
	f.backend.heads = [dir]; f.backend.changes = [{ changeSeq: 1, entries: [dir] }]; await f.files.imports.runOnce()
	f.config.filesCheckpoint = async (stage) => { if (stage === "remote-published") await fs.writeFile(path.join(f.root, "folder", "unmanaged.txt"), "local edit") }
	const head = entry("folder/owned.csv", 2)
	await f.files.applyRemote({ operationId: "owned-child", path: head.path, entries: [head], remoteEtag: head.headToken }, Readable.from([bytes]))
	delete f.config.filesCheckpoint
	const tomb = { path: dir.path, kind: "tombstone", headToken: crypto.randomUUID(), fileVersionId: null, changeSeq: 3 }
	await assert.rejects(f.files.applyRemote({ operationId: "do-not-discard-directory", path: dir.path, entries: [tomb], remoteEtag: tomb.headToken, applyNow: true }, null), { error: "source_changed" })
	assert.equal(await fs.readFile(path.join(f.root, "folder", "unmanaged.txt"), "utf8"), "local edit")
})
test("accepted review R6 jitter: expiry and independent publications retain completion and exact bodies under randomized overlap", async (t) => {
	const f = await fixture(t); f.files.limits.receiptMs = 1
	for (let i = 0; i < 6; i++) {
		await f.files.upload(Readable.from([bytes]), { operationId: `expire-${i}`, path: `local-${i}.csv`, processingPolicy: "skip" })
		const head = entry(`remote-${i}.csv`, i + 1)
		await Promise.all([delay(Math.floor(Math.random() * 8)).then(() => f.files.sweep()), delay(Math.floor(Math.random() * 8)).then(() => f.files.applyRemote({ operationId: `jitter-${i}`, path: head.path, entries: [head], remoteEtag: head.headToken }, Readable.from([bytes])))])
		assert.equal(await fs.readFile(path.join(f.root, head.path), "utf8"), bytes)
	}
})

test("second review S1: fresh publication-only attempt revalidates the retained source and reports verified before its first processing grant", async (t) => {
	const f = await fixture(t), old = f.backend.add(entry()), permit = f.backend.permit.bind(f.backend)
	old.operationId = `import:${crypto.randomUUID()}`
	let unavailable = true
	f.backend.permit = async (...args) => { if (args[1] === "processing" && unavailable) { unavailable = false; throw Object.assign(new Error("first processing grant unavailable"), { status: 503 }) } return permit(...args) }
	await f.files.imports.runOnce()
	const prepared = await f.files.state.get("operations", old.operationId), fresh = { ...old, attemptId: crypto.randomUUID(), attemptRevision: 2, recovery: "reconcile" }
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 0)
	f.backend.claims.push(fresh)
	await f.restart()
	let reopened = false; const open = f.files.captures.open.bind(f.files.captures)
	f.files.captures.open = async (kind, id) => { if (id === prepared.publishedSource.captureId) reopened = true; return open(kind, id) }
	await f.files.imports.runOnce(); await f.files.imports.runOnce()
	const record = await f.files.state.get("cloud-imports", old.workId)
	assert.equal(record?.processingReceipt.state, "ticket", JSON.stringify(f.files.imports.lastError))
	assert.equal(reopened, true)
	assert.equal(record.receipt.operationId, old.operationId)
	assert.equal(record.receipt.receiptId, prepared.receiptId)
	assert.equal(record.source.captureId, prepared.publishedSource.captureId)
	assert.equal(record.processingReceipt.requestId, old.processingRequestId)
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 1)
	const verified = f.backend.progressReports.find((p) => p.attemptId === fresh.attemptId && p.stage === "verified")
	assert.equal(verified?.progressSeq, 1)
	assert.equal(verified?.receiptId, prepared.receiptId)
})
test("second review S1 protected source: missing retained bytes cannot be reported verified or receive the first fresh processing grant", async (t) => {
	const f = await fixture(t), old = f.backend.add(entry()), permit = f.backend.permit.bind(f.backend)
	let unavailable = true
	f.backend.permit = async (...args) => { if (args[1] === "processing" && unavailable) { unavailable = false; throw Object.assign(new Error("first grant unavailable"), { status: 503 }) } return permit(...args) }
	await f.files.imports.runOnce()
	const op = await f.files.state.get("operations", old.operationId), fresh = { ...old, attemptId: crypto.randomUUID(), attemptRevision: 2, recovery: "reconcile" }
	await fs.unlink(path.join(f.files.captures.blobDir, `capture.${op.publishedSource.captureId}`))
	f.backend.claims.push(fresh)
	await f.files.imports.runOnce()
	assert.equal(f.backend.progressReports.some((p) => p.attemptId === fresh.attemptId && p.stage === "verified"), false)
	assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 0)
	assert.equal(await f.files.state.get("cloud-imports", old.workId), null)
	assert.equal((await f.files.imports.drain(new Date(Date.now() + 1000).toISOString())).complete, false)
})
test("second review S2: lost replacement publication response recovers current-owner authority beside historical processing after restart", async (t) => {
	const f = await fixture(t), a = f.backend.add(entry()); await f.files.imports.runOnce()
	const original = await f.files.state.get("cloud-imports", a.workId), history = { ...historical(a, "interrupted"), previousOwner: { runtimeId: a.runtimeId, workspaceId: a.workspaceId, workspaceEpoch: a.workspaceEpoch }, previousProcessingReceipt: original.processingReceipt }
	const b = queueReplacement(f, a, history), permit = f.backend.permit.bind(f.backend)
	b.processingPermit = original.processingPermit
	await f.restart()
	let lost = false
	f.backend.permit = async (...args) => { const granted = await permit(...args); if (args[0].runtimeId === b.runtimeId && args[1] === "publication" && !lost) { lost = true; throw new Error("replacement publication response lost") } return granted }
	await f.files.imports.runOnce(); assert.equal(lost, true)
	const replacementPermit = f.backend.permits.find((p) => p.kind === "publication" && p.runtimeId === b.runtimeId)
	await f.restart(); await f.files.imports.runOnce(); await f.files.imports.runOnce()
	const current = await f.files.state.get("cloud-imports", a.workId)
	assert.equal(current?.claim.runtimeId, b.runtimeId, JSON.stringify(f.files.imports.lastError))
	assert.equal(current.publicationPermit.permitId, replacementPermit.permitId)
	assert.deepEqual(current.processingReceipt, { ...history, requestId: a.processingRequestId, sourceFileVersionId: a.source.fileVersionId })
	assert.equal(current.processingPermit, null)
	assert.equal(f.backend.permits.filter((p) => p.kind === "publication" && p.runtimeId === b.runtimeId).length, 1)
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
	const op = await f.files.state.get("operations", b.operationId)
	await assert.rejects(f.files.imports.inspectPermit(op, "processing"), { status: 409, error: "reconciliation_required" })
	await assert.rejects(f.files.imports.grant(op, "processing"), { status: 409, error: "historical_processing_unresolved" })
	const drained = await f.files.imports.drain(new Date(Date.now() + 1000).toISOString())
	assert.ok(drained.accounting.historicalPermitsUnsettled > 0)
	assert.equal(drained.complete, false)
})
test("second review S3: skipped replacement receipt reconciles accepted rehydrate on restart only with its matching publication owner", async (t) => {
	const f = await fixture(t, { enabled: false }), a = f.backend.add(entry()); await f.files.imports.runOnce()
	const original = await f.files.state.get("cloud-imports", a.workId), b = await replaceOwner(f, a, original.processingReceipt)
	const before = await f.files.state.get("cloud-imports", a.workId)
	await f.restart(); await f.files.imports.runOnce()
	assert.equal(f.files.imports.lastError, null)
	assert.equal(f.files.imports.needsReconcile, false)
	const current = await f.files.state.get("cloud-imports", a.workId), work = await f.backend.getWork(a.workId)
	assert.equal(work.action, "rehydrate")
	assert.equal(current.claim.runtimeId, b.runtimeId)
	assert.equal(current.publicationPermit.permitId, before.publicationPermit.permitId)
	assert.equal(current.ackedRevision, current.receiptRevision)
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
	const reconcile = f.backend.reconcile.bind(f.backend)
	f.backend.reconcile = async (records) => { const response = await reconcile(records); response.results[0].publicationPermit = original.publicationPermit; return response }
	f.files.imports.needsReconcile = true
	await assert.rejects(f.files.imports.reconcile(), { status: 409, error: "receipt_reconciliation_required" })
})
test("second review S4: lost owner-rehome transaction acknowledgement reopens complete bases and resumes one replacement journal", async (t) => {
	const f = await fixture(t, { enabled: false }), a = f.backend.add(entry()); await f.files.imports.runOnce()
	const original = await f.files.state.get("cloud-imports", a.workId), before = await f.files.remote.local(a.destination.path), b = queueReplacement(f, a, original.processingReceipt)
	await f.restart()
	const transaction = f.files.state.transaction.bind(f.files.state); let faulted = false
	f.files.state.transaction = async (metadata) => {
		const result = await transaction(metadata)
		if (!faulted && metadata.some((m) => m.kind === "cloud-operation-history") && metadata.some((m) => m.kind === "operations" && m.value.claim?.runtimeId === b.runtimeId)) { faulted = true; throw Object.assign(new Error("rehome commit acknowledgement lost"), { code: "EIO" }) }
		return result
	}
	await f.files.imports.runOnce(); assert.equal(faulted, true)
	await f.restart()
	const prepared = await f.files.state.get("operations", a.operationId)
	assert.deepEqual(prepared.bases[a.destination.path], { generation: before.generation, observation: before.observation.token })
	await f.files.imports.runOnce(); await f.files.imports.runOnce()
	const current = await f.files.state.get("cloud-imports", a.workId)
	assert.equal(current?.claim.runtimeId, b.runtimeId, JSON.stringify(f.files.imports.lastError))
	assert.equal((await f.files.state.list("cloud-operation-history")).length, 1)
	assert.equal(f.backend.permits.filter((p) => p.kind === "publication" && p.runtimeId === b.runtimeId).length, 1)
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
})
test("second review S4 SIGKILL: killing after owner journal commit retains validated bases before any replacement publication", async (t) => {
	const f = await fixture(t, { enabled: false }), a = f.backend.add(entry()); await f.files.imports.runOnce()
	const original = await f.files.state.get("cloud-imports", a.workId), before = await f.files.remote.local(a.destination.path), b = queueReplacement(f, a, original.processingReceipt), epoch = f.files.identity.workspaceEpoch
	await f.files.close()
	const script = `
import {WorkspaceFiles} from ${JSON.stringify(new URL("../lib/workspace-files.js", import.meta.url).href)};
let input=''; for await(const chunk of process.stdin) input+=chunk; const {config,claim}=JSON.parse(input);
config.writerRegistry={status:async()=>({state:'idle'})};
const ws=await WorkspaceFiles.open(config,{info(){},warn(){},error(){}}); clearTimeout(ws.processing.timer); ws.processing.started=false;
const transaction=ws.state.transaction.bind(ws.state);
ws.state.transaction=async(metadata)=>{const result=await transaction(metadata); if(metadata.some(m=>m.kind==='cloud-operation-history') && metadata.some(m=>m.kind==='operations' && m.value.claim?.runtimeId===claim.runtimeId)){process.stdout.write('OWNER_JOURNAL_COMMITTED\\n'); await new Promise(()=>{});} return result;};
await ws.remote.rehome(await ws.state.get('operations',claim.operationId),claim);
`
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] })
	t.after(() => child.kill("SIGKILL"))
	let output = "", errors = ""; child.stdout.on("data", (c) => { output += c }); child.stderr.on("data", (c) => { errors += c })
	child.stdin.end(JSON.stringify({ config: { ...f.config, persistenceAdapter: undefined, writerRegistry: undefined }, claim: b }))
	const deadline = Date.now() + 10000
	while (!output.includes("OWNER_JOURNAL_COMMITTED")) { assert.ok(Date.now() < deadline && child.exitCode === null, `owner rehome did not reach its crash window: ${errors}`); await delay(10) }
	const stopped = new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)))
	child.kill("SIGKILL"); assert.equal(await stopped, "SIGKILL")
	await f.restart()
	assert.equal(f.files.identity.workspaceEpoch, epoch)
	const prepared = await f.files.state.get("operations", a.operationId)
	assert.deepEqual(prepared.bases[a.destination.path], { generation: before.generation, observation: before.observation.token })
	await f.files.imports.runOnce(); await f.files.imports.runOnce()
	assert.equal((await f.files.state.get("cloud-imports", a.workId))?.claim.runtimeId, b.runtimeId)
	assert.equal((await f.files.state.list("cloud-operation-history")).length, 1)
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
	assert.equal(await fs.readFile(path.join(f.root, a.destination.path), "utf8"), bytes)
})
test("second review S5: cold snapshot child and parent tombstones commit without inventing empty parent directories", async (t) => {
	const f = await fixture(t), parent = { path: "folder", kind: "tombstone", fileVersionId: null, headToken: crypto.randomUUID(), changeSeq: 3 }, child = { ...parent, path: "folder/data.csv", headToken: crypto.randomUUID() }
	f.backend.heads = [parent, child]; f.backend.changes = [{ changeSeq: 3, entries: [parent, child] }]
	await f.files.imports.runOnce()
	await assert.rejects(fs.stat(path.join(f.root, "folder")), { code: "ENOENT" })
	assert.equal(f.files.imports.lastError, null)
	assert.equal((await f.files.remote.baseline(parent.path))?.headToken, parent.headToken)
	assert.equal((await f.files.remote.baseline(child.path))?.headToken, child.headToken)
	assert.equal((await f.files.state.get("cloud-sync", "checkpoint"))?.afterSeq, 3)
	await f.restart(); await f.files.imports.runOnce()
	assert.deepEqual(await fs.readdir(f.root), [])
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
})

// Exercise the production adapter's exact request/response boundary with the strict local backend.
function reconciliationWire(f) {
	const calls = [], rejected = new Map(), control = { calls, rejected, response: null }
	const adapter = new BackendFileAdapter({ secret: "e".repeat(64), fetchImpl: async (url, options = {}) => {
		const pathname = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null
		calls.push({ pathname, body })
		if (pathname.startsWith("/sealed/")) return new Response(f.backend.content.get(pathname.slice(8)).body)
		const claim = f.backend.work.get(pathname.split("/")[2])
		try {
			if (pathname === "/work-backend/claims") return Response.json(await f.backend.claim(body.requestId))
			if (pathname === "/work-backend/receipts/reconcile") {
				const results = []
				for (const item of body.receipts) {
					if (rejected.has(item.workId)) { results.push({ workId: item.workId, status: rejected.get(item.workId) }); continue }
					try {
						const current = f.backend.work.get(item.workId); f.backend.recordReceipt(current, item)
						const work = await f.backend.getWork(item.workId)
						results.push({ workId: item.workId, status: "accepted", action: work.action, publicationPermit: work.publicationPermit, processingPermit: work.processingPermit })
					} catch (e) { if (e.status !== 409) throw e; results.push({ workId: item.workId, status: e.error === "stale_receipt" ? "stale" : "conflict" }) }
				}
				return Response.json(control.response ? control.response(results) : { results })
			}
			if (pathname.endsWith("/progress")) return Response.json(await f.backend.progress(claim, { progressSeq: body.progressSeq, stage: body.stage, downloadedBytes: body.downloadedBytes, receiptId: body.receiptId }))
			if (pathname.endsWith("/source-url")) return Response.json({ ...claim.source, url: `http://fixture/sealed/${claim.source.fileVersionId}` })
			if (pathname.endsWith("/permits")) return Response.json(await f.backend.permit(claim, body.kind, body.receiptId, body.publicationPermitId, body.requestId))
			if (pathname.endsWith("/ack")) return Response.json(await f.backend.ack({ ...claim, attemptId: body.attemptId, attemptRevision: body.attemptRevision }, body))
			if (pathname.endsWith("/settle")) return Response.json(await f.backend.settle(f.backend.permits.find((p) => p.permitId === pathname.split("/")[3]), { receiptId: body.receiptId, state: body.state, evidence: body.evidence }))
			if (pathname.startsWith("/work-backend/")) return Response.json(await f.backend.getWork(pathname.slice(14)))
			if (pathname === "/files-backend/changes") return Response.json(await f.backend.changesAfter(Number(new URL(url).searchParams.get("afterSeq"))))
			if (pathname === "/files-backend/versions/urls") return Response.json({ files: await Promise.all(body.fileVersionIds.map(async (id) => ({ ...await f.backend.source(id), url: `http://fixture/sealed/${id}` }))) })
			throw new Error(`Unexpected diagnostic wire route: ${pathname}`)
		} catch (e) { if (!e.status) throw e; return Response.json({ detail: e.error }, { status: e.status }) }
	} })
	const bind = adapter.bind.bind(adapter); adapter.bind = (workspace) => { bind(workspace); f.backend.bind(workspace) }
	f.config.persistenceAdapter = adapter; f.files.persistence.adapter = adapter; f.files.imports.adapter = adapter; adapter.bind(f.files)
	return control
}

test("poll isolation: rejected unacknowledged capacity receipt permits unrelated skip imports and later resumes its original auto identity", async (t) => {
	const f = await fixture(t, { activeTickets: 1 })
	f.backend.add(entry("busy.csv", 1)); await f.files.imports.runOnce()
	const waiting = f.backend.add(entry("stopped.csv", 2)), ack = f.backend.ack.bind(f.backend)
	f.backend.ack = async (claim, record) => { if (claim.workId === waiting.workId) { f.backend.processingEnabled = false; throw f.backend.error("invalid_processing_state") } return ack(claim, record) }
	await f.files.imports.runOnce()
	const before = await f.files.state.get("cloud-imports", waiting.workId), operation = await f.files.operation(waiting.operationId)
	assert.equal(before.processingReceipt.state, "awaiting-capacity"); assert.equal(before.ackedRevision, 0)
	f.config.preprocessing.enabled = false
	reconciliationWire(f)
	await f.restart()
	const unrelated = f.backend.add(entry("unrelated.csv", 3), "skip")
	await f.files.imports.runOnce()
	assert.equal((await f.files.state.get("cloud-imports", unrelated.workId))?.deliveryState, "available", "a rejected old receipt must not stop delivery of unrelated work")
	assert.equal((await f.files.state.get("cloud-imports", unrelated.workId))?.processingReceipt.state, "skipped")
	assert.equal(await fs.readFile(path.join(f.root, "unrelated.csv"), "utf8"), bytes)
	let retained = await f.files.state.get("cloud-imports", waiting.workId)
	assert.deepEqual(retained.receipt, before.receipt); assert.deepEqual(retained.processingReceipt, before.processingReceipt)
	assert.equal(retained.reconcileRequired, true); assert.equal(retained.ackedRevision, 0)
	assert.equal(retained.source.captureId, before.source.captureId); assert.equal(retained.sourceHoldId, before.sourceHoldId)
	assert.ok(await f.files.state.get("holds", before.sourceHoldId))
	assert.deepEqual((await f.files.operation(waiting.operationId)).processingAdmission, operation.processingAdmission)
	assert.equal(f.backend.permits.filter((p) => p.workId === waiting.workId && p.kind === "processing").length, 0)
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
	await f.restart(); await f.files.imports.runOnce()
	retained = await f.files.state.get("cloud-imports", waiting.workId)
	assert.deepEqual(retained.processingReceipt, before.processingReceipt); assert.ok(await f.files.state.get("holds", before.sourceHoldId))
	f.backend.processingEnabled = true; f.backend.ack = ack; f.files.processing.config.enabled = true; f.files.processing.config.activeTickets = 2
	await f.files.imports.runOnce(); await f.files.imports.runOnce()
	const recovered = await f.files.state.get("cloud-imports", waiting.workId)
	assert.deepEqual(recovered.receipt, before.receipt)
	assert.equal(recovered.processingReceipt.requestId, before.processingReceipt.requestId)
	assert.equal(recovered.processingReceipt.ticketId, `processing_${stableId(`${waiting.workspaceEpoch}:${waiting.processingRequestId}:ticket`)}`)
	assert.equal(recovered.source.captureId, before.source.captureId)
	assert.equal(f.backend.permits.filter((p) => p.workId === waiting.workId && p.kind === "processing").length, 1)
	assert.equal((await f.files.state.list("processing-jobs")).length, 2)
})

test("poll isolation: rejected ticket revokes fresh dispatch despite a retained permit, then accepted reconciliation recovers without another processor POST", async (t) => {
	for (const rejection of ["conflict", "stale"]) {
		const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
		const before = await f.files.state.get("cloud-imports", claim.workId), ticket = await f.files.processing.record(before.processingReceipt.ticketId)
		assert.equal(f.files.processing.cloudAuthorized(ticket), true)
		const wire = reconciliationWire(f); wire.rejected.set(claim.workId, rejection); f.files.imports.needsReconcile = true
		const unrelated = f.backend.add(entry("unrelated.csv", 2), "skip")
		await f.files.imports.runOnce()
		assert.equal((await f.files.state.get("cloud-imports", unrelated.workId))?.processingReceipt.state, "skipped")
		assert.equal(f.files.processing.cloudAuthorized(ticket), false, "a retained permit cannot authorize a rejected ticket")
		await assert.rejects(f.files.processing.copyInput(ticket), { error: "owner_reconciliation_required" })
		let posts = 0, lookups = 0
		f.files.processing.client.submit = async () => { posts++; throw new Error("must not repeat an accepted processor POST") }
		await assert.rejects(f.files.processing.dispatch(ticket), { error: "owner_reconciliation_required" })
		assert.equal(posts, 0)
		const pending = await f.files.state.get("cloud-imports", claim.workId)
		assert.deepEqual(pending.processingReceipt, before.processingReceipt); assert.ok(await f.files.state.get("holds", before.sourceHoldId))
		// The processor may already have accepted this stable key while its acknowledgement was lost.
		const submitted = { ...ticket, deliveryStage: "submitting", dispatchIntentAt: new Date().toISOString(), upstreamRequest: { profileId: "default", source: { kind: "workspace-file", path: "original.csv" } } }
		await f.files.state.put("processing-jobs", ticket.runtimeJobId, submitted)
		f.files.processing.client.lookup = async (key) => { lookups++; assert.equal(key, ticket.upstreamSubmissionKey); return { id: "accepted-processor-job", projectId: "processor-scope", submissionKey: key, revision: 1, state: "queued", source: null, profile: { id: "default" }, documents: null, resultId: null } }
		wire.rejected.clear(); await f.files.imports.runOnce()
		await f.files.processing.dispatch(await f.files.processing.record(ticket.runtimeJobId))
		assert.equal(lookups, 1); assert.equal(posts, 0)
		assert.equal((await f.files.processing.record(ticket.runtimeJobId)).processorJobId, "accepted-processor-job")
		assert.equal((await f.files.state.list("processing-jobs")).length, 1)
		assert.equal(f.backend.permits.filter((p) => p.kind === "processing").length, 1)
	}
})

test("poll isolation: local disablement keeps an already accepted capacity request waiting rather than converting it to a permanent skip", async (t) => {
	const f = await fixture(t, { activeTickets: 1 }); f.backend.add(entry("busy.csv", 1)); await f.files.imports.runOnce()
	const waiting = f.backend.add(entry("waiting.csv", 2)); await f.files.imports.runOnce()
	const before = await f.files.state.get("cloud-imports", waiting.workId)
	assert.equal(before.processingReceipt.state, "awaiting-capacity"); assert.equal(before.ackedRevision, 1)
	f.files.processing.config.enabled = false
	await f.files.imports.runOnce()
	const disabled = await f.files.state.get("cloud-imports", waiting.workId)
	assert.deepEqual(disabled.processingReceipt, before.processingReceipt, "disablement must not rewrite the original automatic intent")
	assert.equal(disabled.receiptRevision, before.receiptRevision); assert.ok(await f.files.state.get("holds", before.sourceHoldId))
	f.files.processing.config.enabled = true; f.files.processing.config.activeTickets = 2
	await f.files.imports.runOnce()
	const recovered = await f.files.state.get("cloud-imports", waiting.workId)
	assert.equal(recovered.processingReceipt.requestId, before.processingReceipt.requestId)
	assert.equal(recovered.processingReceipt.ticketId, `processing_${stableId(`${waiting.workspaceEpoch}:${waiting.processingRequestId}:ticket`)}`)
	assert.equal(recovered.source.captureId, before.source.captureId)
})

test("poll isolation: malformed reconciliation batches stop new claims and revoke dispatch for the entire unvalidated batch", async (t) => {
	for (const malformed of ["envelope", "missing", "duplicate", "foreign", "status", "action", "permit"]) {
		const f = await fixture(t), a = f.backend.add(entry("a.csv", 1)); await f.files.imports.runOnce()
		const b = f.backend.add(entry("b.csv", 2)); await f.files.imports.runOnce()
		const wire = reconciliationWire(f)
		wire.response = (results) => {
			if (malformed === "envelope") return {}
			if (malformed === "missing") results.pop()
			if (malformed === "duplicate") results[1] = results[0]
			if (malformed === "foreign") results[1] = { ...results[1], workId: crypto.randomUUID() }
			if (malformed === "status") results[1] = { ...results[1], status: "unknown" }
			if (malformed === "action") results[1] = { ...results[1], action: "unknown" }
			if (malformed === "permit") results[1] = { ...results[1], processingPermit: { ...results[1].processingPermit, runtimeId: crypto.randomUUID() } }
			return { results }
		}
		f.files.imports.needsReconcile = true; f.backend.add(entry("unrelated.csv", 3), "skip")
		await f.files.imports.runOnce()
		assert.equal(wire.calls.filter((c) => c.pathname === "/work-backend/claims").length, 0)
		for (const claim of [a, b]) {
			const receipt = await f.files.state.get("cloud-imports", claim.workId), job = await f.files.processing.record(receipt.processingReceipt.ticketId)
			assert.equal(f.files.processing.cloudAuthorized(job), false, `${malformed}: no authorization before the whole batch is valid`)
			assert.ok(await f.files.state.get("holds", receipt.sourceHoldId))
		}
	}
})

test("poll isolation: authority rejected while processor lookup is in flight prevents a fresh POST at the dispatch boundary", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
	const receipt = await f.files.state.get("cloud-imports", claim.workId), job = await f.files.processing.record(receipt.processingReceipt.ticketId)
	const wire = reconciliationWire(f)
	await f.files.state.put("processing-jobs", job.runtimeJobId, { ...job, deliveryStage: "submitting", dispatchIntentAt: new Date().toISOString(), upstreamRequest: { profileId: "default", source: { kind: "workspace-file", path: "original.csv" } } })
	let posts = 0
	f.files.processing.client.lookup = async () => { wire.rejected.set(claim.workId, "conflict"); f.files.imports.needsReconcile = true; await f.files.imports.runOnce(); return null }
	f.files.processing.client.submit = async () => { posts++; throw new Error("rejected authority must not dispatch") }
	await assert.rejects(f.files.processing.dispatch(await f.files.processing.record(job.runtimeJobId)), { error: "owner_reconciliation_required" })
	assert.equal(posts, 0)
	assert.ok(await f.files.state.get("holds", receipt.sourceHoldId))
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
})

test("poll isolation: rejection of an already acknowledged receipt remains an incomplete drain obligation", async (t) => {
	const f = await fixture(t), claim = f.backend.add(entry(), "skip"); await f.files.imports.runOnce()
	const receipt = await f.files.state.get("cloud-imports", claim.workId)
	assert.equal(receipt.ackedRevision, receipt.receiptRevision); assert.equal(receipt.publicationSettled, true)
	const wire = reconciliationWire(f); wire.rejected.set(claim.workId, "conflict"); f.files.imports.needsReconcile = true
	await f.files.imports.runOnce()
	const drain = await f.files.imports.drain(new Date(Date.now() + 1000).toISOString())
	assert.equal(drain.complete, false)
	assert.equal(drain.accounting.acknowledgementsPending, 1)
	assert.equal(drain.obligations[0].workId, claim.workId)
})

test("poll isolation review P2 terminal: accepted same-owner terminal mappings finish publication observation and real cleanup without POST authority", async (t) => {
	for (const state of ["granted", "reconciliation-pending", "completed"]) {
		const f = await fixture(t), claim = f.backend.add(entry()); await f.files.imports.runOnce()
		const receipt = await f.files.state.get("cloud-imports", claim.workId), original = await f.files.processing.record(receipt.processingReceipt.ticketId)
		await f.files.processing.copyInput(original)
		const delivered = await f.files.processing.record(original.runtimeJobId), processorJobId = "accepted-terminal-job"
		await f.files.state.put("processing-jobs", original.runtimeJobId, { ...delivered, deliveryStage: "terminal", outcome: "succeeded", processorState: "succeeded", processorJobId, processorRevision: 1, processorPublication: { state: "pending" }, dispatchIntentAt: new Date().toISOString(), nextAttemptAt: null })
		f.backend.permits.find((p) => p.kind === "processing").state = state
		const wire = reconciliationWire(f); f.files.imports.needsReconcile = true
		await f.files.imports.reconcile()
		let gets = 0, posts = 0
		f.files.processing.client.capabilities = async () => ({ dependency: { ready: true, state: "ready" }, activity: {} })
		f.files.processing.client.get = async (id) => { gets++; assert.equal(id, processorJobId); return { id, projectId: "processor-scope", submissionKey: original.upstreamSubmissionKey, revision: 2, state: "succeeded", source: null, documents: { state: "ready" } } }
		f.files.processing.client.submit = async () => { posts++; throw new Error("terminal observation must not POST") }
		await f.files.processing.run(); await Promise.all([...f.files.processing.localWork.values()])
		const finished = await f.files.processing.record(original.runtimeJobId)
		assert.equal(gets, 1, `${state}: accepted terminal publication must remain observable`)
		assert.equal(finished.processorPublication.state, "ready"); assert.equal(finished.cleanupState, "complete")
		await assert.rejects(fs.stat(path.join(f.config.preprocessing.inboxDir, original.runtimeJobId)), { code: "ENOENT" })
		assert.equal(await f.files.state.get("holds", original.holdId), null)
		assert.equal(posts, 0)
		await assert.rejects(f.files.processing.dispatch(finished), { error: "owner_reconciliation_required" })
		// A later rejection must revoke observation as well as effect admission.
		await f.files.state.put("processing-jobs", original.runtimeJobId, { ...finished, processorPublication: { state: "pending" }, cleanupState: "pending", nextAttemptAt: null })
		wire.rejected.set(claim.workId, "conflict"); f.files.imports.needsReconcile = true
		await f.files.imports.reconcile(); await f.files.processing.run(); await Promise.all([...f.files.processing.localWork.values()])
		assert.equal(gets, 1); assert.equal(posts, 0)
		assert.equal((await f.files.processing.record(original.runtimeJobId)).cleanupState, "pending")
		assert.ok(await f.files.state.get("holds", receipt.sourceHoldId))
	}
})

async function orderedCapacityWait(t) {
	const f = await fixture(t, { activeTickets: 1 })
	const add = (head, workId) => {
		const claim = f.backend.add(head), oldId = claim.workId
		f.backend.work.delete(oldId); claim.workId = workId; claim.processingRequestId = `auto:${workId}`; f.backend.work.set(workId, claim)
		return claim
	}
	const earlier = add(entry("earlier.csv", 1), "00000000-0000-4000-a000-000000000001"); await f.files.imports.runOnce()
	const waiting = add(entry("waiting.csv", 2), "00000000-0000-4000-a000-000000000002"); await f.files.imports.runOnce()
	const before = await f.files.state.get("cloud-imports", waiting.workId)
	assert.equal(before.processingReceipt.state, "awaiting-capacity")
	f.files.processing.config.activeTickets = 2
	return { f, earlier, waiting, before, wire: reconciliationWire(f) }
}

test("poll isolation review P2 snapshot: an earlier expired acknowledgement cannot admit a later capacity receipt rejected during that same retry pass", async (t) => {
	const { f, earlier, waiting, before, wire } = await orderedCapacityWait(t)
	const first = await f.files.state.get("cloud-imports", earlier.workId)
	await f.files.state.put("cloud-imports", earlier.workId, { ...first, ackedRevision: 0, claim: { ...first.claim, leaseExpiresAt: new Date(0).toISOString() } })
	wire.rejected.set(waiting.workId, "conflict"); f.files.imports.needsReconcile = false
	await f.files.imports.retryReceipts()
	assert.equal(wire.calls.filter((c) => c.pathname === "/work-backend/receipts/reconcile").length, 1)
	assert.equal(f.backend.permits.filter((p) => p.workId === waiting.workId && p.kind === "processing").length, 0, "a stale list snapshot must not bypass newly rejected authority")
	const retained = await f.files.state.get("cloud-imports", waiting.workId)
	assert.equal(retained.reconcileRequired, true); assert.deepEqual(retained.processingReceipt, before.processingReceipt)
	assert.deepEqual(retained.receipt, before.receipt); assert.equal(retained.sourceHoldId, before.sourceHoldId)
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
	assert.ok(await f.files.state.get("holds", before.sourceHoldId))
	assert.equal((await f.files.captures.text("capture", before.source.captureId)).text, bytes)
})

for (const window of ["progress", "metadata"]) test(`poll isolation review P2 awaits ${window}: rejection never clears the flag or creates a ticket`, async (t) => {
		const { f, waiting, before, wire } = await orderedCapacityWait(t)
		const reject = async () => { wire.rejected.set(waiting.workId, "conflict"); f.files.imports.needsReconcile = true; await f.files.imports.reconcile() }
		if (window === "progress") {
			const progress = f.files.imports.adapter.progress.bind(f.files.imports.adapter)
			f.files.imports.adapter.progress = async (...args) => { const result = await progress(...args); await reject(); return result }
		} else {
			const metadata = f.files.processing.cloudMetadata.bind(f.files.processing)
			f.files.processing.cloudMetadata = async (op) => { const result = await metadata(op); await reject(); return result }
		}
		await f.files.imports.retryReceipts()
		const retained = await f.files.state.get("cloud-imports", waiting.workId)
		assert.equal(retained.reconcileRequired, true, `${window}: retained metadata must not overwrite a rejection`)
		assert.deepEqual(retained.processingReceipt, before.processingReceipt); assert.equal(retained.receiptRevision, before.receiptRevision)
		assert.equal((await f.files.state.list("processing-jobs")).length, 1)
		assert.ok(await f.files.state.get("holds", before.sourceHoldId))
		assert.equal(f.backend.permits.filter((p) => p.workId === waiting.workId && p.kind === "processing").length, window === "progress" ? 0 : 1)
		if (window === "metadata") assert.ok((await f.files.operation(waiting.operationId)).processingPermit, "a grant issued before rejection remains a retained obligation")
})
