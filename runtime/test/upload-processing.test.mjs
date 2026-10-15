import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { setImmediate as yieldTurn } from "node:timers/promises"
import { test } from "node:test"
import { WorkspaceFiles } from "../lib/workspace-files.js"

const put = (kind, id, value) => ({ type: "put", kind, id, value })
const logger = { info() {}, warn() {}, error() {} }
const upload = (files, operationId, name, bytes, extra = {}) => files.upload(Readable.from([Buffer.from(bytes)]), { operationId, path: name, declaredSize: Buffer.byteLength(bytes), ...extra })
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

// This fixture exercises the workspace/coordinator boundary with real SafeFs and SQLite.
// Eligibility, upstream delivery and capacity accounting belong to coordinator tests.
class ProcessingFixture {
	constructor(workspace, config) { this.workspace = workspace; this.config = config; this.reservations = new Map(); this.tail = Promise.resolve(); this.releases = []; this.stopped = false }
	async init() {
		assert.equal(this.workspace.captures.availability.state, "available")
		for (const op of await this.workspace.state.list("operations")) if (op.processingAdmission?.jobId && !["committed", "failed", "aborted-before-publication"].includes(op.state)) this.reservations.set(op.operationId, op.processingAdmission)
		this.initialReservations = [...this.reservations.keys()]
	}
	async reconcileOperations() { this.reconciled = true; this.reconciledOperations = await this.workspace.state.list("operations") }
	capabilities() { return { enabled: this.config.enabled, reservations: this.reservations.size } }
	reserveUpload(op) {
		const result = this.tail.then(async () => {
			assert.equal(this.workspace.mutationDepth || 0, 0, "admission must not hold the namespace lock")
			assert.equal(op.sizeBytes, op.publishedSource.sizeBytes)
			assert.equal((await this.workspace.state.list("processing-jobs")).some((job) => job.uploadOperationId === op.operationId), false)
			if (op.processingAdmission) return op.processingAdmission
			if (op.intent.processingPolicy === null) return null
			let reason = op.intent.processingPolicy === "skip" ? "opt_out" : !this.config.enabled ? "disabled" : !/\.(pdf|csv|tsv|xlsx|xlsm)$/i.test(op.intent.path) ? "unsupported_format" : op.sizeBytes > this.config.inputBytes ? "input_too_large" : null
			const active = new Set((await this.workspace.state.list("processing-jobs")).filter((job) => job.deliveryStage !== "terminal").map((job) => job.runtimeJobId))
			for (const admission of this.reservations.values()) active.add(admission.jobId)
			if (!reason && active.size >= this.config.activeTickets) reason = "processing_capacity"
			const jobId = reason ? null : `processing_${crypto.randomUUID()}`
			const admission = { policy: op.intent.processingPolicy, state: reason ? "skipped" : "pending", jobId, statusUrl: jobId ? `/files/processing/jobs/${jobId}` : null, reason }
			if (jobId) this.reservations.set(op.operationId, admission)
			return admission
		})
		this.tail = result.catch(() => {})
		return result
	}
	async uploadMetadata(op, record) {
		assert.equal(this.workspace.mutationDepth || 0, 0, "metadata build must not hold the namespace lock")
		const processing = op.processingAdmission
		if (!processing?.jobId) return { processing, metadata: [] }
		const jobId = processing.jobId, holdId = `processing-${jobId}`
		const existing = await this.workspace.state.get("processing-jobs", jobId)
		const job = existing || { runtimeJobId: jobId, uploadOperationId: op.operationId, captureId: record.id, sourceSha256: record.source.digest.sha256, sourceBytes: record.sizeBytes, holdId, deliveryStage: "pending" }
		const hold = { holdId, source: { kind: "capture", id: record.id }, reason: `processing:${jobId}`, createdAt: new Date().toISOString() }
		return { processing, metadata: [put("processing-jobs", jobId, job), put("holds", holdId, hold)] }
	}
	async releaseFailedUpload(op) { this.reservations.delete(op.operationId); this.releases.push(op.operationId) }
	async drain() { this.stopped = true; return { complete: true } }
	async close() { this.stopped = true; assert.equal(this.workspace.state.closed, false) }
}

async function fixture(t, options = {}, processingFactory = (workspace, config) => new ProcessingFixture(workspace, config)) {
	const base = await fs.mkdtemp(path.join(os.homedir(), ".gc-processing-"))
	await fs.chmod(base, 0o700)
	const workspaceDir = path.join(base, "project"), filesStateDir = path.join(base, "state")
	await fs.mkdir(workspaceDir, { mode: 0o2775 })
	const config = { workspaceDir, filesStateDir, filesAgentUids: [20001], filesWorkerUids: [20003], filesLimits: { receiptMs: 1, previewIdleMs: 1, previewBytes: 1 }, preprocessing: { enabled: true, inputBytes: 256, activeTickets: 100, inboxDir: path.join(base, "inbox"), ...options }, ...(processingFactory ? { processingFactory } : {}) }
	let files = await WorkspaceFiles.open(config, logger)
	t.after(async () => { await files.close(); await fs.rm(base, { recursive: true, force: true }) })
	const run = files.locks.run
	files.locks.run = (work) => run(async () => { files.mutationDepth = (files.mutationDepth || 0) + 1; try { return await work() } finally { files.mutationDepth-- } })
	return { config, root: workspaceDir, get files() { return files }, async restart() { await files.close(); files = await WorkspaceFiles.open(config, logger); return files } }
}

test("upload processing: explicit public policy binds intent while internal uploads never trigger", async (t) => {
	const f = await fixture(t)
	const internal = (await upload(f.files, "internal", "internal.csv", "a,b\n")).operation
	assert.equal(internal.intent.processingPolicy, null)
	assert.equal(internal.processing ?? null, null)
	assert.equal((await f.files.state.list("processing-jobs")).length, 0)
	const first = (await upload(f.files, "public", "report.csv", "a,b\n", { processingPolicy: "auto" })).operation
	assert.equal(first.processing.state, "pending")
	assert.equal(first.processing.policy, "auto")
	assert.deepEqual(first.sourceRetention, { receiptExpiresAt: new Date(Date.parse(first.committedAt) + f.files.limits.receiptMs).toISOString(), availabilityUrl: `/files/captures/${first.publishedSource.captureId}` })
	assert.equal((await upload(f.files, "public", "report.csv", "x,y\n", { processingPolicy: "auto" })).operation.processing.jobId, first.processing.jobId)
	await assert.rejects(upload(f.files, "public", "report.csv", "a,b\n", { processingPolicy: "skip" }), { error: "operation_id_reused" })
	await assert.rejects(upload(f.files, "internal", "internal.csv", "a,b\n", { processingPolicy: "auto" }), { error: "operation_id_reused" })
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
	assert.equal((await f.files.info()).processing.enabled, true)
})

test("upload processing: malformed policies reject before body consumption or admission", async (t) => {
	const f = await fixture(t)
	for (const [n, processingPolicy] of ["AUTO", "skip,auto", ["auto", "skip"], false, 1, ""].entries()) {
		let read = false
		const body = Readable.from((async function* () { read = true; yield Buffer.from("bytes") })())
		await assert.rejects(f.files.upload(body, { operationId: `invalid-${n}`, path: "invalid.csv", processingPolicy }), { error: "invalid_processing_policy" })
		assert.equal(read, false)
		assert.equal(await f.files.state.get("operations", `invalid-${n}`), null)
	}
})

test("upload processing: durable skip decisions preserve upload success across restart and config changes", async (t) => {
	const f = await fixture(t, { activeTickets: 1, inputBytes: 4 })
	for (const [id, name, bytes, policy, reason] of [["optout", "skip.csv", "data", "skip", "opt_out"], ["format", "data.txt", "data", "auto", "unsupported_format"], ["size", "large.csv", "large", "auto", "input_too_large"], ["accepted", "ok.csv", "data", "auto", null], ["capacity", "later.csv", "data", "auto", "processing_capacity"]]) {
		const op = (await upload(f.files, id, name, bytes, { processingPolicy: policy })).operation
		assert.equal(op.state, "committed")
		assert.equal(op.processing.reason, reason)
		assert.equal(op.processing.state, reason ? "skipped" : "pending")
		assert.equal(await fs.readFile(path.join(f.root, name), "utf8"), bytes)
	}
	f.config.preprocessing.enabled = false
	assert.equal((await upload(f.files, "disabled", "disabled.csv", "data", { processingPolicy: "auto" })).operation.processing.reason, "disabled")
	await f.restart()
	assert.equal((await upload(f.files, "accepted", "ok.csv", "else", { processingPolicy: "auto" })).operation.processing.state, "pending")
	assert.equal((await f.files.operation("capacity")).processing.reason, "processing_capacity")
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
})

test("upload processing: create, replace and force-replace retain their accepted bytes after receipt expiry", async (t) => {
	const f = await fixture(t), operations = []
	for (const [n, mode] of ["create", "replace", "force-replace"].entries()) {
		const op = (await upload(f.files, `version-${n}`, "report.csv", `version-${n}`, { mode, processingPolicy: "auto", ...(mode === "replace" ? { baseObservation: operations.at(-1).publishedObservation.token } : {}) })).operation
		operations.push(op)
	}
	for (const op of operations) {
		await f.files.captures.releaseLease((await f.files.state.list("leases")).find((lease) => lease.source.id === op.publishedSource.captureId).leaseId)
		await f.files.state.put("operations", op.operationId, { ...op, sourceRetention: { ...op.sourceRetention, receiptExpiresAt: new Date(0).toISOString() } })
	}
	f.files.limits.receiptMs = 10000
	await f.files.sweep(); await f.files.sweep()
	assert.equal((await f.files.state.list("holds")).filter((hold) => hold.reason.startsWith("receipt:")).length, 0)
	await f.restart()
	assert.equal((await f.files.state.list("processing-jobs")).length, 3)
	for (const [n, op] of operations.entries()) {
		const job = await f.files.state.get("processing-jobs", op.processing.jobId)
		assert.equal(job.captureId, op.publishedSource.captureId)
		assert.equal((await f.files.captures.text("capture", job.captureId)).text, `version-${n}`)
	}
})

test("upload processing: published and receipt fault recovery preserves one reserved ticket and independent hold", async (t) => {
	for (const fault of ["published", "transaction", "transaction-ack", "receipt"]) {
		const f = await fixture(t), id = `crash-${fault}`
		let reservedId, injected = false
		const transaction = f.files.state.transaction.bind(f.files.state)
		f.files.state.transaction = async (ops) => {
			const receipt = ops.find((op) => op.kind === "operations" && op.id === id && op.value?.state === "committed")
			if (receipt) {
				assert.ok(ops.some((op) => op.kind === "captures"))
				assert.ok(ops.some((op) => op.kind === "holds" && op.value.reason.startsWith("processing:")))
				assert.ok(ops.some((op) => op.kind === "processing-jobs"))
				assert.ok(ops.some((op) => op.kind === "local-changes"))
				if (fault === "transaction" && !injected) { injected = true; throw Object.assign(new Error("lost receipt transaction"), { code: "EIO" }) }
				if (fault === "transaction-ack" && !injected) { await transaction(ops); injected = true; throw Object.assign(new Error("lost transaction acknowledgement"), { code: "EIO" }) }
			}
			return transaction(ops)
		}
		f.config.filesCheckpoint = async (stage, op) => {
			if (op.operationId !== id) return
			if (stage === "publishing") {
				reservedId = (await f.files.state.get("operations", id)).processingAdmission.jobId
				assert.ok(reservedId)
				assert.equal(await f.files.state.get("processing-jobs", reservedId), null)
			}
			if (!injected && stage === fault) { injected = true; throw Object.assign(new Error(`lost ${fault} acknowledgement`), { code: "EIO" }) }
		}
		await assert.rejects(upload(f.files, id, "source.csv", "accepted-A", { processingPolicy: "auto" }), { error: "operation_indeterminate" })
		assert.ok(injected)
		assert.equal(f.files.processing.releases.includes(id), false)
		assert.equal((await f.files.state.list("processing-jobs")).length, ["receipt", "transaction-ack"].includes(fault) ? 1 : 0)
		delete f.config.filesCheckpoint
		await f.restart()
		assert.equal(f.files.processing.reconciledOperations.find((op) => op.operationId === id).state, "committed")
		const recovered = await f.files.operation(id)
		assert.equal(recovered.processing.jobId, reservedId)
		assert.equal((await f.files.state.list("processing-jobs")).length, 1)
		assert.equal((await f.files.state.list("local-changes")).filter((change) => change.operationId === id).length, 1)
		assert.equal((await f.files.state.list("holds")).filter((hold) => hold.reason.startsWith("processing:")).length, 1)
		await upload(f.files, `replace-${id}`, "source.csv", "replacement-B", { mode: "force-replace" })
		await f.files.captures.releaseHold(recovered.evidenceHoldId)
		for (const lease of await f.files.state.list("leases")) await f.files.captures.releaseLease(lease.leaseId)
		await f.files.captures.sweep()
		assert.equal((await f.files.captures.text("capture", recovered.publishedSource.captureId)).text, "accepted-A")
		const duplicate = await upload(f.files, id, "source.csv", "wrongbytes", { processingPolicy: "auto" })
		assert.equal(duplicate.operation.processing.jobId, reservedId)
	}
})

test("upload processing: proven failed reservations release; indeterminate reservations rebuild and consume capacity", async (t) => {
	const f = await fixture(t, { activeTickets: 1 })
	f.config.filesCheckpoint = async (stage, op) => {
		if (stage === "publishing" && op.operationId === "denied") throw Object.assign(new Error("publication denied"), { code: "EPERM" })
		if (stage === "published" && op.operationId === "unknown") {
			await fs.unlink(path.join(f.root, "unknown.csv"))
			throw Object.assign(new Error("publication association lost"), { code: "EIO" })
		}
	}
	await assert.rejects(upload(f.files, "denied", "denied.csv", "data", { processingPolicy: "auto" }), { error: "permission_denied" })
	assert.ok((await f.files.operation("denied")).processingAdmission.jobId)
	assert.equal(f.files.processing.reservations.size, 0)
	assert.ok(f.files.processing.releases.includes("denied"))
	await assert.rejects(upload(f.files, "unknown", "unknown.csv", "data", { processingPolicy: "auto" }), { error: "operation_indeterminate" })
	delete f.config.filesCheckpoint
	await f.restart()
	assert.deepEqual(f.files.processing.initialReservations, ["unknown"])
	assert.equal((await f.files.operation("unknown")).state, "indeterminate")
	assert.equal((await upload(f.files, "after-restart", "later.csv", "data", { processingPolicy: "auto" })).operation.processing.reason, "processing_capacity")
})

test("capture metadata: manual admission serializes eviction and atomically establishes an independent hold", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "manual.csv"), "manual-A")
	const capture = await f.files.captures.create({ requestId: "manual-capture", path: "manual.csv", computeDigest: true })
	await f.files.captures.releaseLease(capture.lease.leaseId)
	await fs.writeFile(path.join(f.root, "manual.csv"), "manual-B")
	const entered = deferred(), resume = deferred(), holdId = "manual-processing-hold"
	const admission = f.files.captures.withRetentionMetadata("capture", capture.source.captureId, async (record, reader) => {
		assert.equal((f.files.captures.readers.get(`capture/${record.id}`) || 0) > 0, true)
		assert.equal((await reader.handle.readFile("utf8")), "manual-A")
		assert.equal(reader.source.captureId, record.id)
		entered.resolve(); await resume.promise
		return { metadata: [put("holds", holdId, { holdId, source: { kind: "capture", id: record.id }, reason: "processing:manual" }), put("processing-jobs", "manual", { captureId: record.id })], result: { jobId: "manual" } }
	})
	await entered.promise
	let swept = false
	const sweep = f.files.captures.sweep().then(() => { swept = true })
	await yieldTurn()
	assert.equal(swept, false)
	try {
		const draining = await f.files.captures.drain(new Date().toISOString())
		assert.equal(draining.localPending, 1)
		assert.equal(draining.complete, false)
	} finally { resume.resolve() }
	assert.deepEqual(await admission, { jobId: "manual" })
	await sweep
	assert.equal(f.files.captures.readers.get(`capture/${capture.source.captureId}`) || 0, 0)
	assert.equal((await f.files.captures.text("capture", capture.source.captureId)).text, "manual-A")
	await f.restart()
	assert.equal((await f.files.captures.text("capture", capture.source.captureId)).text, "manual-A")
})

test("capture metadata: failed build or transaction leaks no reader, ticket or hold; expired source is never rebound", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "manual.csv"), "original")
	const capture = await f.files.captures.create({ requestId: "rollback-capture", path: "manual.csv", computeDigest: true })
	const captures = f.files.captures, id = capture.source.captureId
	await assert.rejects(captures.withRetentionMetadata("capture", id, async () => { throw new Error("build failed") }), /build failed/)
	const transaction = f.files.state.transaction.bind(f.files.state)
	f.files.state.transaction = async (ops) => { if (ops.some((op) => op.kind === "processing-jobs")) throw Object.assign(new Error("metadata failed"), { code: "EIO" }); return transaction(ops) }
	await assert.rejects(captures.withRetentionMetadata("capture", id, async () => ({ metadata: [put("holds", "uncommitted", { holdId: "uncommitted", source: { kind: "capture", id }, reason: "processing:manual" }), put("processing-jobs", "uncommitted", { captureId: id })], result: null })), /metadata failed/)
	assert.equal(captures.readers.get(`capture/${id}`) || 0, 0)
	assert.equal(await f.files.state.get("holds", "uncommitted"), null)
	assert.equal(await f.files.state.get("processing-jobs", "uncommitted"), null)
	f.files.state.transaction = transaction
	await captures.releaseLease(capture.lease.leaseId)
	await captures.sweep()
	await fs.writeFile(path.join(f.root, "manual.csv"), "newer")
	let built = false
	await assert.rejects(captures.withRetentionMetadata("capture", id, async () => { built = true; return { metadata: [], result: null } }), { error: "capture_expired" })
	assert.equal(built, false)
})

test("upload processing: drain stops coordinator work and retains state for control/status until close", async (t) => {
	const f = await fixture(t)
	const op = (await upload(f.files, "drain", "source.csv", "data", { processingPolicy: "auto" })).operation
	const drained = await f.files.drain()
	assert.equal(f.files.processing.stopped, true)
	assert.equal(drained.processing.complete, true)
	assert.equal((await f.files.state.get("processing-jobs", op.processing.jobId)).deliveryStage, "pending")
	assert.equal((await f.files.captures.text("capture", op.publishedSource.captureId)).text, "data")
	await assert.rejects(upload(f.files, "after-drain", "new.csv", "data", { processingPolicy: "auto" }), { error: "draining" })
})

test("upload processing: default coordinator recovers the reserved upload, reuses it manually and retains input through outage", async (t) => {
	const f = await fixture(t, { aggregateActivity: true, port: 1, token: "fixture-private-token", transportMs: 25, runningPollMs: 10, queuedPollMs: 10 }, null)
	f.config.filesCheckpoint = async (stage, op) => {
		if (stage === "published" && op.operationId === "real-coordinator") throw Object.assign(new Error("daemon stopped after publication"), { code: "EIO" })
	}
	await assert.rejects(upload(f.files, "real-coordinator", "report.csv", "accepted-A", { processingPolicy: "auto" }), { error: "operation_indeterminate" })
	const reservedId = (await f.files.operation("real-coordinator")).processingAdmission.jobId
	delete f.config.filesCheckpoint
	await f.restart()
	const op = await f.files.operation("real-coordinator")
	assert.equal(op.state, "committed")
	assert.equal(op.processing.jobId, reservedId)
	assert.equal((await f.files.state.list("processing-jobs")).length, 1)
	const manual = await f.files.processing.submit({ requestId: crypto.randomUUID(), source: { kind: "upload-operation", operationId: op.operationId } })
	assert.equal(manual.status, 200)
	assert.equal(manual.job.id, reservedId)
	await upload(f.files, "real-replacement", "report.csv", "replacement-B", { mode: "force-replace" })
	await f.files.captures.releaseHold(op.evidenceHoldId)
	for (const lease of await f.files.state.list("leases")) await f.files.captures.releaseLease(lease.leaseId)
	await f.files.captures.sweep()
	assert.equal((await f.files.captures.text("capture", op.publishedSource.captureId)).text, "accepted-A")
	const capabilities = (await f.files.info()).processing
	assert.equal(capabilities.enabled, true)
	assert.equal(capabilities.backlog.activeTickets, 1)
	assert.equal(capabilities.storage.heldInputBytes, Buffer.byteLength("accepted-A"))
})
