import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as wait } from "node:timers/promises"
import { test } from "node:test"
import { spawn } from "node:child_process"
import Ajv from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { DocumentProcessing } from "../lib/document-processing.js"
import { PreprocessingPair } from "../lib/preprocessing-pair.js"
import { FILES_CONTRACT_VERSION, FileError, observation } from "../lib/file-contract.js"
import { buildFilesOpenApi } from "../lib/files-openapi.js"
import { FileState } from "../lib/file-state.js"
import { MemoryState, processor, sha, until, workspace } from "./document-processing-fixture.test.mjs"

async function fixture(t, options = {}) {
	let coordinator
	t.after(() => coordinator?.close())
	const w = await workspace(t, options), p = await processor(t, options.processor), config = { enabled: true, aggregateActivity: true, inboxDir: path.join(w.dir, "inbox"), port: p.port, token: "private", runningPollMs: 10, queuedPollMs: 10, transportMs: 80, ...options.config }
	const logger = options.logger || { error() {}, warn() {}, info() {} }
	if (options.projectId) w.config.projectId = options.projectId
	if (options.inboxGid !== undefined) { await fs.mkdir(config.inboxDir, { mode: 0o750 }); await fs.chown(config.inboxDir, -1, options.inboxGid); await fs.chmod(config.inboxDir, 0o750) }
	coordinator = new DocumentProcessing(w, config, logger)
	await coordinator.init(); await coordinator.reconcileOperations()
	return { w, p, config, get c() { return coordinator }, async restart() { await coordinator.close(); coordinator = new DocumentProcessing(w, config, logger); await coordinator.init(); await coordinator.reconcileOperations() } }
}
const submit = (c, capture, options = {}) => c.submit({ requestId: crypto.randomUUID(), source: { kind: "capture", captureId: capture.source.captureId }, ...options })

for (const maintenance of ["dependency", "admission"]) test(`admitted processing keeps sampling during blocked ${maintenance} maintenance`, async (t) => {
	const state = new MemoryState(), c = new DocumentProcessing({ state, identity: state.identity }, { runningPollMs: 30, queuedPollMs: 30 }, { info() {} })
	let release, entered
	const gate = new Promise((r) => { release = r }), blocked = new Promise((r) => { entered = r })
	t.after(async () => { release(); await c.close() })
	const samples = new Map(), jobs = []
	for (const processorState of ["running", "queued"]) {
		const job = { ...c.newJob(crypto.randomUUID(), { kind: "capture", captureId: "capture" }, {}), processorJobId: processorState, processorState, deliveryStage: "tracking", cleanupState: "complete" }
		await state.put("processing-jobs", job.runtimeJobId, job); jobs.push(job); samples.set(job.processorJobId, [])
	}
	c.client.get = async (id) => {
		samples.get(id).push(Date.now())
		await wait(2 + Math.floor(Math.random() * 5))
		const job = jobs.find((j) => j.processorJobId === id)
		return { id, projectId: "scope", submissionKey: job.upstreamSubmissionKey, revision: 1, state: id, queueAhead: id === "queued" ? 1 : null }
	}
	let maintenanceCalls = 0
	const pause = async () => { maintenanceCalls++; entered(); await gate }
	c.repairAdmissions = maintenance === "admission" ? pause : async () => {}
	c.checkDependency = maintenance === "dependency" ? pause : async () => {}
	c.started = true; c.wake(); await blocked
	await wait(220)
	assert.ok(samples.get("running").length >= 3, "running samples must continue across maintenance ticks")
	assert.ok(samples.get("queued").length >= 3, "queue positions must continue across maintenance ticks")
	assert.equal(maintenanceCalls, 1, "maintenance remains single flight")
	for (const job of jobs) {
		const current = await c.record(job.runtimeJobId)
		assert.ok(Date.now() - Date.parse(current.lastCheckedAt) < 120)
		assert.equal(current.queueAhead, job.processorState === "queued" ? 1 : null)
	}
	let drained = false
	const closing = c.close().then(() => { drained = true })
	await wait(20); assert.equal(drained, false, "close waits for maintenance before withdrawing storage")
	release(); await closing
})

test("failed processor reads do not renew processing freshness", async () => {
	const state = new MemoryState(), c = new DocumentProcessing({ state, identity: state.identity }, { runningPollMs: 30 }, { info() {} })
	const job = { ...c.newJob(crypto.randomUUID(), { kind: "capture", captureId: "capture" }, {}), processorJobId: "job", processorState: "running", deliveryStage: "tracking", cleanupState: "complete", lastCheckedAt: "2026-10-14T10:00:00.000Z" }
	await state.put("processing-jobs", job.runtimeJobId, job)
	c.client.get = async () => { throw new FileError(503, "processor_unavailable", "Unavailable", { retryable: true }) }
	c.repairAdmissions = async () => {}; c.checkDependency = async () => {}
	await c.run(); await Promise.all([...c.localWork.values()])
	const failed = await c.record(job.runtimeJobId)
	assert.equal(failed.lastCheckedAt, job.lastCheckedAt)
	assert.equal(failed.deliveryStage, "blocked"); assert.ok(Date.parse(failed.nextAttemptAt) > Date.now() - 30)
	await c.close()
})

test("processing close waits for an in-flight sample scan and never starts maintenance after drain", async (t) => {
	const state = new MemoryState(), c = new DocumentProcessing({ state, identity: state.identity }, {}, { info() {} })
	let release, entered, scans = 0, maintenance = 0
	const gate = new Promise((r) => { release = r }), scanning = new Promise((r) => { entered = r })
	t.after(async () => { release(); await c.close() })
	c.records = async () => { if (++scans === 1) { entered(); await gate } return [] }
	c.repairAdmissions = async () => { maintenance++ }; c.checkDependency = async () => {}
	const running = c.run(); await scanning
	let closed = false
	const closing = c.close().then(() => { closed = true })
	await wait(30); assert.equal(closed, false, "sample scan retains access until it has stopped")
	release(); await Promise.all([running, closing])
	assert.equal(maintenance, 0, "a scan returning after drain cannot start new maintenance")
})

test("processing liveness persists authoritative metadata, fences reordered samples, and freezes terminal progress", async () => {
	const state = new MemoryState(), c = new DocumentProcessing({ state, identity: state.identity }, {}, { info() {} })
	assert.equal(c.config.queuedPollMs, 2000)
	const job = c.newJob(crypto.randomUUID(), { kind: "capture", captureId: "capture" }, {}), startedAt = "2026-10-14T10:00:00.123456Z", finishedAt = "2026-10-14T10:01:00.654321Z"
	await state.put("processing-jobs", job.runtimeJobId, job)
	const upstream = { id: "processor", projectId: "scope", submissionKey: job.upstreamSubmissionKey, revision: 1, state: "queued", startedAt: null, finishedAt: null, stage: null, progress: null, queueAhead: 4 }
	await c.observe(job, upstream)
	assert.equal((await c.get(job.runtimeJobId)).queueAhead, 4)
	assert.equal((await c.get(job.runtimeJobId)).startedAt, null)
	const progress = { id: "extract", label: "Inspecting pages", unit: "page", completedUnits: 12, totalUnits: 80, updatedAt: "2026-10-14T10:00:03.000Z" }, stage = { ...progress }; delete stage.updatedAt
	await c.observe(job, { ...upstream, revision: 3, state: "running", startedAt, stage, progress, queueAhead: null })
	const running = await c.record(job.runtimeJobId)
	assert.deepEqual(running.processorProgress, progress)
	assert.deepEqual((await c.get(job.runtimeJobId)).progress, progress)
	assert.equal((await c.get(job.runtimeJobId)).startedAt, startedAt)
	await c.observe(job, { ...upstream, revision: 2, queueAhead: 3 })
	assert.deepEqual(await c.record(job.runtimeJobId), running, "older queued sample cannot replace running progress or sample time")
	const final = { ...progress, completedUnits: 80 }
	await c.observe(job, { ...upstream, revision: 4, state: "succeeded", startedAt, finishedAt, stage, progress: final, queueAhead: null, documents: { state: "pending" } })
	await c.observe(job, { ...upstream, revision: 5, state: "running", startedAt: null, progress, documents: { state: "ready" } })
	const view = await c.get(job.runtimeJobId)
	assert.equal(view.state, "succeeded"); assert.equal(view.startedAt, startedAt); assert.equal(view.finishedAt, finishedAt)
	assert.deepEqual(view.progress, final); assert.equal(view.queueAhead, null); assert.equal(view.processorPublication.state, "ready")
})

test("processing liveness interruption marker persists across fresh cancelling samples without terminalizing unresolved effects", async () => {
	const state = new MemoryState(), workspace = { state, identity: state.identity }, c = new DocumentProcessing(workspace, {}, { info() {} })
	const job = c.newJob(crypto.randomUUID(), { kind: "capture", captureId: "capture" }, {}), interruptedAt = "2026-10-14T10:01:00.123456Z"
	await state.put("processing-jobs", job.runtimeJobId, job)
	assert.equal((await c.get(job.runtimeJobId)).interruptedAt, null)
	const progress = { id: "extract", label: "Inspecting pages", unit: "page", completedUnits: 12, totalUnits: 80, updatedAt: "2026-10-14T10:00:03.000Z" }
	const upstream = { id: "processor", projectId: "scope", submissionKey: job.upstreamSubmissionKey, revision: 1, state: "running", startedAt: "2026-10-14T10:00:00.000Z", finishedAt: null, interruptedAt: null, progress, queueAhead: null }
	await c.observe(job, upstream)
	await c.observe(job, { ...upstream, revision: 2, state: "cancelling", interruptedAt })
	const interrupted = await c.record(job.runtimeJobId)
	assert.equal(interrupted.processorInterruptedAt, interruptedAt)
	await c.observe(job, upstream)
	assert.deepEqual(await c.record(job.runtimeJobId), interrupted, "reordered pre-restart samples cannot clear the marker")
	await c.observe(interrupted, { ...upstream, revision: 3, state: "cancelling", interruptedAt, progress: { ...progress, completedUnits: 13 } })
	const restarted = new DocumentProcessing(workspace, {}, { info() {} }), view = await restarted.get(job.runtimeJobId)
	assert.equal(view.interruptedAt, interruptedAt); assert.equal(view.state, "cancelling"); assert.equal(view.finishedAt, null)
	assert.equal(view.progress.completedUnits, 13); assert.equal(view.deliveryStage, "tracking")
	assert.equal((await restarted.record(job.runtimeJobId)).outcome, null)
})

test("dependency requires literal readiness and fresh engine evidence while preserving bounded degradation", async (t) => {
	const f = await fixture(t)
	await f.c.drain()
	const compatibility = { classification: "unknown", cliVersion: null, httpVersion: "2.0.20-future.1", descriptorVersion: "2.0.20-future.1", warnings: ["cli_version_missing", "http_version_untested", "/private/token=secret"], password: "secret" }
	const observedAt = new Date(Date.now() - 100).toISOString()
	const evidence = { state: "ready", ready: true, executionReady: true, observedAt, observationMaxAgeMs: 5000, version: "2.0.20-future.1", compatibility, preferredModel: "proxy/openai/gpt-6-luna", selectedModel: "proxy/google/gemini-3.8-flash", eligibleCandidateCount: 2, selectionReason: "canonical_fallback", policyAgeMs: 30, password: "secret", serverUrl: "http://private" }
	f.c.client.capabilities = async () => ({ dependency: evidence })
	f.c.dependencyCheckedMs = 0; await f.c.checkDependency()
	let result = (await f.c.capabilities()).dependency
	assert.equal(result.ready, true); assert.equal(result.executionReady, true)
	assert.equal(result.observedAt, observedAt)
	assert.equal(result.selectedModel, evidence.selectedModel)
	assert.equal(result.eligibleCandidateCount, 2)
	assert.deepEqual(result.compatibility.warnings, ["cli_version_missing", "http_version_untested"])
	assert.doesNotMatch(JSON.stringify(result), /password|secret|serverUrl|\/private/)
	for (const patch of [{ ready: "false", executionReady: "true" }, { observedAt: new Date(Date.now() - 6000).toISOString() }, { observedAt: new Date(Date.now() + 6000).toISOString() }, { observedAt: null }, { observationMaxAgeMs: "5000" }]) {
		f.c.client.capabilities = async () => ({ dependency: { ...evidence, ...patch } })
		f.c.dependencyCheckedMs = 0; await f.c.checkDependency()
		result = (await f.c.capabilities()).dependency
		assert.equal(result.ready, false, JSON.stringify(patch))
		assert.equal(result.executionReady, false, JSON.stringify(patch))
	}
})

test("admission-only outage retains new tickets and tracks same-key committed work with pinned model and holds", async (t) => {
	const f = await fixture(t, { processor: { admissionUnavailable: true, dependency: { ready: false, executionReady: true, reason: "policy_stale" } } })
	const capture = await f.w.capture(), { job } = await submit(f.c, capture)
	await until(async () => (await f.c.get(job.id)).deliveryStage === "blocked")
	assert.equal(f.p.jobs.size, 0)
	const saved = await f.c.record(job.id)
	assert.equal(saved.sourceSha256, sha("a\n1\n"))
	assert.equal((await f.w.state.list("holds")).length, 1)
	f.p.options.admissionUnavailable = false
	await until(() => f.p.jobs.size === 1)
	const upstream = [...f.p.jobs.values()][0]
	upstream.profile = { id: "default", profileDigest: "a".repeat(64), models: { vision: "proxy/openai/gpt-6-luna" } }
	upstream.modelSelection = { preferredModel: "proxy/not-installed/preferred", selectedModel: "proxy/openai/gpt-6-luna", selectionReason: "canonical_fallback" }
	upstream.hold = { reason: "model_not_accepted", selectedModel: "proxy/openai/gpt-6-luna" }; upstream.revision++
	f.p.options.admissionUnavailable = true
	await until(async () => (await f.c.get(job.id)).hold?.reason === "model_not_accepted", "queued model hold projection")
	const view = await f.c.get(job.id)
	assert.equal(view.resolvedProfile.model, "proxy/openai/gpt-6-luna")
	assert.equal(view.modelSelection.preferredModel, "proxy/not-installed/preferred")
	assert.equal(view.modelSelection.selectedModel, "proxy/openai/gpt-6-luna")
	await f.restart()
	assert.equal((await f.c.record(job.id)).upstreamSubmissionKey, saved.upstreamSubmissionKey)
	upstream.hold = null; upstream.source = { snapshotId: "source_retained", sha256: sha("a\n1\n"), bytes: 4, filename: "report.csv" }; upstream.revision++
	await until(async () => (await f.c.get(job.id)).cleanupState === "complete", "scoped source cleanup despite admission unready")
	assert.equal(f.p.jobs.size, 1)
	assert.equal((await f.c.get(job.id)).hold, null)
	assert.equal((await f.c.capabilities()).dependency.executionReady, true)
	assert.equal((await f.c.capabilities()).dependency.ready, false)
})

test("expired cached readiness triggers a shared current dependency observation", async (t) => {
	const f = await fixture(t, { config: { queuedPollMs: 10000 } })
	await f.c.drain()
	let calls = 0
	f.c.client.capabilities = async () => { calls++; await wait(20); return { dependency: { state: "unavailable", ready: false, executionReady: false, observedAt: new Date().toISOString(), observationMaxAgeMs: 5000 } } }
	f.c.dependency = { state: "ready", ready: true, executionReady: true, checkedAt: new Date().toISOString(), observedAt: new Date(Date.now() - 6000).toISOString(), observationMaxAgeMs: 5000 }
	f.c.dependencyCheckedMs = Date.now()
	const observations = await Promise.all([f.c.capabilities(), f.c.capabilities(), f.c.capabilities()])
	assert.equal(calls, 1)
	for (const result of observations) { assert.equal(result.dependency.ready, false); assert.equal(result.dependency.executionReady, false) }
})

test("slow pair recovery preserves one retained PDF ticket, submission key, hash and upstream job", { timeout: 10000 }, async (t) => {
	const f = await fixture(t, { processor: { down: true } }), bytes = "%PDF-1.7\noriginal retained source\n"
	const capture = await f.w.capture("retained.pdf", bytes), { job } = await submit(f.c, capture)
	const before = await until(async () => { const record = await f.c.record(job.id); return record.deliveryStage === "blocked" && record }, "retained PDF blocked on unavailable pair")
	let launches = 0
	const pair = new PreprocessingPair({ command: process.execPath, args: [], env: { PATH: process.env.PATH }, backoffMs: 1, cooldownMs: 10, logger: { warn() {} }, spawnImpl: (command, _, options) => {
		const healthy = ++launches >= 7
		if (healthy) f.p.options.down = false
		return spawn(command, ["-e", healthy ? "process.stdin.once('data',()=>process.exit(0))" : "setTimeout(()=>process.exit(1),Math.random()*5)"], options)
	} })
	t.after(() => pair.stop(Date.now() + 1000)); pair.start()
	await until(() => f.p.jobs.size === 1, "recovered retained PDF", 8000)
	const after = await f.c.record(job.id)
	assert.ok(launches >= 7)
	assert.equal(after.runtimeJobId, before.runtimeJobId)
	assert.equal(after.upstreamSubmissionKey, before.upstreamSubmissionKey)
	assert.equal(after.sourceSha256, before.sourceSha256)
	assert.equal(f.p.lastBody.source.expectedSha256, sha(bytes))
	assert.equal(await fs.readFile(path.join(f.config.inboxDir, f.p.lastBody.source.path), "utf8"), bytes)
	assert.equal(f.p.jobs.size, 1)
})

test("pair liveness and retry evidence survives root storage observations", async (t) => {
	const f = await fixture(t)
	await f.c.drain()
	const pair = { state: "cooldown", attempts: 6, totalLaunches: 6, burstCount: 5, childAlive: false, cooldownMs: 300000, nextRetryAt: new Date(Date.now() + 300000).toISOString() }
	await f.c.observeStorage({ observedAt: new Date().toISOString(), complete: true, pair })
	assert.deepEqual((await f.c.capabilities()).storage.pair, pair)
})

test("processing cancellation after ambiguous dispatch replays despite negative lookup, then settles same job", async (t) => {
	let release, entered
	const gate = new Promise((resolve) => { release = resolve }), first = new Promise((resolve) => { entered = resolve })
	const f = await fixture(t, { processor: { firstPost: async () => { entered(); await gate } } }), capture = await f.w.capture(), { job } = await submit(f.c, capture)
	await first
	const cancelled = await f.c.cancel(job.id); assert.equal(cancelled.status, 202)
	await until(() => f.p.posts >= 2, "same-key replay after empty lookup")
	assert.ok(f.p.lookups >= 1)
	await until(async () => (await f.c.get(job.id)).processorState === "cancelled")
	release(); await wait(25)
	assert.equal(f.p.jobs.size, 1); assert.equal((await f.c.get(job.id)).processorState, "cancelled")
	assert.equal((await f.c.get(job.id)).deliveryStage, "terminal")
})

for (const phase of ["uncertain dispatch", "tracking"]) test(`processing usage-paused ${phase} still reconciles explicit cancellation and releases its source`, async (t) => {
	const f = await fixture(t, { processor: { loseResponse: phase === "uncertain dispatch" } }), capture = await f.w.capture()
	const method = phase === "uncertain dispatch" ? "lookup" : "get", original = f.c.client[method].bind(f.c.client)
	let deniedCalls = 0
	f.c.client[method] = async () => { deniedCalls++; throw { status: 503, error: "usage_unavailable" } }
	const { job } = await submit(f.c, capture)
	const paused = await until(async () => { const saved = await f.c.record(job.id); return saved.usagePaused && !f.c.localWork.has(job.id) && saved }, "managed usage pause")
	assert.ok(paused.dispatchIntentAt)
	assert.equal(Boolean(paused.processorJobId), phase === "tracking")
	assert.equal((await f.w.state.list("holds")).length, 1)
	const calls = deniedCalls, requests = f.p.requests.filter((request) => request.path.startsWith("/preprocessing/jobs")).length
	for (let n = 0; n < 3; n++) await f.c.run()
	assert.equal(deniedCalls, calls, "usage pause must suppress ordinary retries")
	assert.equal(f.p.requests.filter((request) => request.path.startsWith("/preprocessing/jobs")).length, requests)
	f.c.client[method] = original
	const cancelled = await f.c.cancel(job.id)
	assert.equal(cancelled.status, 202); assert.ok(cancelled.job.cancelRequestedAt)
	await until(async () => (await f.c.get(job.id)).state === "cancelled", "usage-paused cancellation settlement")
	await until(async () => (await f.c.get(job.id)).cleanupState === "complete", "cancelled source cleanup")
	const settled = await f.c.record(job.id)
	assert.equal(settled.deliveryStage, "terminal"); assert.ok(settled.holdReleasedAt)
	assert.equal(settled.upstreamSubmissionKey, paused.upstreamSubmissionKey)
	assert.equal(f.p.jobs.size, 1); assert.equal(f.p.posts, 1); assert.equal(f.p.cancels, 1)
	assert.equal([...f.p.jobs.values()][0].state, "cancelled", "remote work must be cancelled before local cleanup")
	assert.equal((await f.w.state.list("holds")).length, 0)
	await assert.rejects(fs.stat(path.join(f.config.inboxDir, job.id)), { code: "ENOENT" })
	assert.equal((await f.c.activity()).active, false)
	const drained = await f.c.drain()
	assert.equal(drained.remotePending, 0); assert.equal(drained.indeterminate, 0)
})

for (const knownProcessor of [false, true]) test(`usage-paused cancellation paces persistent denials for ${knownProcessor ? "known processor jobs" : "unknown admission"} and settles after recovery`, async (t) => {
	const f = await fixture(t, { config: { runningPollMs: 100 } }), capture = await f.w.capture()
	const denial = () => new FileError(503, "usage_unavailable", "Managed usage is unavailable.", { retryable: false, agent: "preprocessing" })
	const originalSubmit = f.c.client.submit.bind(f.c.client), originalCancel = f.c.client.cancel.bind(f.c.client)
	let recovered = false, attempts = 0
	if (knownProcessor) {
		f.c.client.get = async () => { throw denial() }
		f.c.client.cancel = async (id) => { attempts++; if (!recovered) throw denial(); return originalCancel(id) }
	} else f.c.client.submit = async (key, body) => { attempts++; if (!recovered) throw denial(); return originalSubmit(key, body) }
	const { job } = await submit(f.c, capture)
	await until(async () => (await f.c.record(job.id)).usagePaused && !f.c.localWork.has(job.id), "managed denial pauses delivery")
	const before = attempts
	assert.equal((await f.c.cancel(job.id)).status, 202)
	await until(() => attempts > before, "cancellation attempts reconciliation")
	await wait(150)
	assert.ok(attempts - before <= 3, `persistent denial must pace cancellation attempts, observed ${attempts - before}`)
	assert.notEqual((await f.c.get(job.id)).state, "cancelled", "denial must not count as cancellation settlement")
	assert.equal(await f.c.capacity(), 1)
	assert.equal((await f.c.capabilities()).storage.heldInputBytes, 4)
	recovered = true
	await until(async () => (await f.c.get(job.id)).state === "cancelled", "recovered cancellation settles automatically")
	await until(async () => (await f.c.get(job.id)).cleanupState === "complete", "settled cancellation releases retained source")
	assert.equal((await f.c.cancel(job.id)).status, 200)
	assert.equal(f.p.jobs.size, 1)
	assert.equal(await f.c.capacity(), 0)
	assert.equal((await f.c.capabilities()).storage.heldInputBytes, 0)
})

test("processing snapshot acknowledgement persists before cleanup; failed hold release remains counted and retries", async (t) => {
	const f = await fixture(t), capture = await f.w.capture(), { job } = await submit(f.c, capture)
	await until(() => f.p.jobs.size === 1)
	const upstream = [...f.p.jobs.values()][0], original = f.w.captures.releaseHold.bind(f.w.captures)
	let blocked = true
	f.w.captures.releaseHold = async (id) => { if (blocked && id.startsWith("processing")) throw new Error("cleanup unavailable"); return original(id) }
	upstream.source = { snapshotId: "source_retained", sha256: sha("a\n1\n"), bytes: 4, filename: "report.csv" }; upstream.revision++
	await until(async () => (await f.w.state.get("processing-jobs", job.id)).cleanupState === "blocked")
	const record = await f.w.state.get("processing-jobs", job.id)
	assert.ok(record.snapshotAcknowledgedAt); assert.ok(record.inboxRemovedAt); assert.equal(record.holdReleasedAt, undefined)
	assert.equal((await f.c.capabilities()).storage.heldInputBytes, 4)
	blocked = false
	await until(async () => (await f.w.state.get("processing-jobs", job.id)).cleanupState === "complete")
	assert.equal((await f.c.capabilities()).storage.heldInputBytes, 0)
})

test("processing epoch checks, serialized capacity reservations, upload reuse and skip decisions", async (t) => {
	const f = await fixture(t, { config: { activeTickets: 1 } }), capture = await f.w.capture()
	const op = { operationId: "upload-a", action: "upload", state: "staged", intent: { path: "report.csv", processingPolicy: "auto" }, publishedSource: capture.source, sizeBytes: 4 }
	op.processingAdmission = await f.c.reserveUpload(op); await f.w.state.put("operations", op.operationId, op)
	await assert.rejects(submit(f.c, capture), { error: "processing_capacity" })
	const built = await f.w.captures.withRetentionMetadata("capture", capture.source.captureId, async (record) => { const value = await f.c.uploadMetadata(op, record); return { metadata: value.metadata, result: value } })
	op.processing = built.processing; op.state = "committed"; await f.w.state.put("operations", op.operationId, op)
	const reused = await f.c.submit({ requestId: crypto.randomUUID(), source: { kind: "upload-operation", operationId: op.operationId } })
	assert.equal(reused.status, 200); assert.equal(reused.job.id, op.processing.jobId)
	const skip = await f.c.reserveUpload({ ...op, operationId: "skip", processingAdmission: undefined, intent: { ...op.intent, processingPolicy: "skip" } })
	assert.equal(skip.reason, "opt_out")
	const sourceRecord = await f.w.state.get("captures", capture.source.captureId); sourceRecord.source.ref.workspaceEpoch = crypto.randomUUID(); await f.w.state.put("captures", sourceRecord.id, sourceRecord)
	f.config.activeTickets = 100; f.c.config.activeTickets = 100
	await assert.rejects(submit(f.c, capture), { error: "source_unavailable" })
})

test("processing results translate sealed inventory and downloads; rows/products reject unlisted IDs", async (t) => {
	const f = await fixture(t), capture = await f.w.capture(), { job } = await submit(f.c, capture)
	await until(() => f.p.jobs.size === 1)
	const upstream = [...f.p.jobs.values()][0]; upstream.source = { snapshotId: "source_retained", sha256: sha("a\n1\n"), bytes: 4, filename: "report.csv" }; upstream.state = "partial"; upstream.resultId = "result_one"; upstream.documents = { state: "failed", path: "/private/published" }; upstream.revision++
	await until(async () => (await f.c.get(job.id)).resultAvailable)
	const result = await f.c.results(job.id)
	assert.equal(result.jobId, job.id); assert.equal(result.manifest.products[0].contentUrl, `/files/processing/jobs/${job.id}/products/product_svg`)
	assert.equal(result.manifest.tables[0].downloads[0].spreadsheetFormulaPolicy, "preserve")
	assert.doesNotMatch(JSON.stringify(result), /\/private|\/preprocessing|configPath|typedPath|csvPath|secret/)
	await assert.rejects(f.c.rows(job.id, "unlisted", {}), { status: 404 })
	await assert.rejects(f.c.product(job.id, "unlisted", {}), { status: 404 })
	const rows = await f.c.rows(job.id, "table_one", { offset: 0, limit: 1 }); assert.equal(rows.rows[0].cells[0].type, "formula")
	f.p.options.rowTooLarge = true
	await assert.rejects(f.c.rows(job.id, "table_one", {}), (error) => { assert.equal(error.error, "row_too_large"); assert.equal(error.downloads[0].contentUrl, `/files/processing/jobs/${job.id}/products/product_csv`); return true })
	const response = await f.c.product(job.id, "product_svg", { headers: { range: "bytes=0-3" } })
	assert.equal(response.status, 206); assert.equal(await response.text(), "<svg"); assert.equal(response.headers.get("etag"), '"strong"'); assert.match(response.headers.get("content-disposition"), /^attachment/)
	assert.equal(response.headers.get("x-content-type-options"), "nosniff")
})

test("retained PDF results normalize public locators without changing coordinates, metadata or partial outcomes", async (t) => {
	const f = await fixture(t), capture = await f.w.capture("receipt.pdf", "%PDF-fixture"), { job } = await submit(f.c, capture)
	await until(() => f.p.jobs.size === 1)
	const upstream = [...f.p.jobs.values()][0]
	upstream.source = { snapshotId: "source_retained", sha256: sha("%PDF-fixture"), bytes: 12, filename: "receipt.pdf" }; upstream.state = "partial"; upstream.resultId = "result_one"; upstream.revision++
	await until(async () => (await f.c.get(job.id)).resultAvailable)
	const bbox = [27.12, 285.27, 584.88, 391.08]
	const located = { page: 2, bounds: { bbox, units: "pt", origin: "top-left", coordinateSpace: "rotated-media-box", rotation: 90, pageWidth: 612, pageHeight: 792, transform: [0, 1, -1, 0, 792, 0] } }
	const legacy = { page: 1, bounds: bbox }
	const manifest = {
		schemaVersion: 1, jobId: upstream.id, resultId: "result_one", outcome: "partial", source: { ...upstream.source, origin: { token: "private" } },
		pipeline: { id: "pdf" }, coverage: { unit: "page", scope: "document", enumeration: "complete", total: 2, completed: 2, failed: 0, unsupported: 0, notProcessed: 0 }, stages: [],
		findings: [{ code: "unresolved_table", severity: "warning", message: "One table is unresolved.", source: located }],
		products: Array.from({ length: 6 }, (_, index) => ({ id: `product_${index}`, path: `products/${index}.md`, mediaType: "text/markdown", bytes: 1, sha256: sha("x"), source: index === 5 ? legacy : located })),
		tables: [{ id: "table_confirmed", rows: 1, columns: [{ id: "a", position: 1, label: "A" }], downloads: [{ format: "csv", productId: "product_0" }], source: located, confirmation: "confirmed" }, { id: "table_unresolved", rows: 0, columns: [], downloads: [], source: legacy, confirmation: "unresolved" }],
		figures: [{ id: "figure_one", source: legacy, outcome: "partial" }], provenance: { adapter: "pdf", adapterVersion: "1", schemaVersion: 1 },
	}
	manifest.products[0].evidence = { bounds: [0, 0, 1000, 1000], coordinateSpace: "normalized-image" }
	f.p.options.manifest = manifest
	const original = structuredClone(manifest), ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true })
	addFormats(ajv); ajv.addSchema(buildFilesOpenApi(), "files")
	const validate = ajv.compile({ $ref: "files#/components/schemas/ProcessingResults" })
	const result = { filesContractVersion: FILES_CONTRACT_VERSION, ...await f.c.results(job.id) }
	assert.equal(validate(result), true, JSON.stringify(validate.errors))
	assert.deepEqual(result.manifest.products[0].source, located)
	assert.deepEqual(result.manifest.products[0].evidence, manifest.products[0].evidence)
	for (const item of [result.manifest.products[5], result.manifest.tables[1], result.manifest.figures[0]]) assert.deepEqual(item.source, { page: 1, bounds: { bbox } })
	assert.equal(result.manifest.outcome, "partial"); assert.equal((await f.c.get(job.id)).state, "partial")
	assert.deepEqual(result.manifest.tables.map((table) => table.confirmation), ["confirmed", "unresolved"])
	assert.deepEqual(result.manifest.products.map((product) => [product.bytes, product.sha256]), manifest.products.map((product) => [product.bytes, product.sha256]))
	assert.deepEqual(manifest, original)
	assert.equal(result.manifest.source.origin, undefined)
	assert.doesNotMatch(JSON.stringify(result), /private/)
	f.p.options.manifest = structuredClone(original); f.p.options.manifest.findings[0].source = legacy
	assert.deepEqual((await f.c.results(job.id)).manifest.findings[0].source, { page: 1, bounds: { bbox } })
	for (const bounds of [[0, 1, 2], [0, 1, "2", 3], [0, 1, false, 3], [0, 1, null, 3], [2, 1, 0, 3], [0, 1, 0, 3], { bbox: [0, 3, 2, 1] }, { bbox, origin: { token: "private" } }]) {
		for (const collection of ["products", "tables", "figures", "findings"]) {
			f.p.options.manifest = structuredClone(original)
			f.p.options.manifest[collection][0].source = { ...f.p.options.manifest[collection][0].source, bounds }
			await assert.rejects(f.c.results(job.id), { status: 502, error: "invalid_result_inventory" }, `${collection}: ${JSON.stringify(bounds)}`)
		}
	}
	f.p.options.manifest = structuredClone(original); f.p.options.manifest.products[5].source = { bounds: bbox }
	await assert.rejects(f.c.results(job.id), { status: 502, error: "invalid_result_inventory" })
})

test("paged PDF rows normalize row and cell locators while preserving typed values and evidence", async (t) => {
	const f = await fixture(t), capture = await f.w.capture("receipt.pdf", "%PDF-fixture"), { job } = await submit(f.c, capture)
	await until(() => f.p.jobs.size === 1)
	const upstream = [...f.p.jobs.values()][0]
	upstream.source = { snapshotId: "source_retained", sha256: sha("%PDF-fixture"), bytes: 12, filename: "receipt.pdf" }; upstream.state = "partial"; upstream.resultId = "result_one"; upstream.revision++
	await until(async () => (await f.c.get(job.id)).resultAvailable)
	f.p.options.manifest = await f.c.client.results(upstream.id)
	f.p.options.manifest.tables[0].columns = [{ id: "a", position: 1, label: "A" }]
	const bbox = [27.12, 285.27, 584.88, 391.08], legacy = { page: 1, bounds: bbox }
	const located = { page: 2, bounds: { bbox, units: "pt", origin: "top-left", rotation: 90, pageWidth: 612, pageHeight: 792 } }
	const page = { offset: 0, count: 1, total: 1, nextOffset: null, rows: [{ index: 1, source: legacy, cells: [
		{ type: "text", value: "secret provider path origin", source: legacy, evidence: { bounds: [0, 0, 1000, 1000], coordinateSpace: "normalized-image" } },
		{ type: "number", value: "9007199254740993.0100", source: located },
		{ type: "formula", formula: "=1+1", formulaAttributes: { origin: "raw", token: "literal" }, cached: { type: "number", value: "2", source: legacy } },
		{ type: "empty" },
	] }] }
	const original = structuredClone(page)
	f.c.client.rows = async () => page
	const result = { filesContractVersion: FILES_CONTRACT_VERSION, ...await f.c.rows(job.id, "table_one", { offset: 0, limit: 1 }) }
	const expected = structuredClone(original.rows)
	for (const target of [expected[0], expected[0].cells[0], expected[0].cells[2].cached]) target.source = { page: 1, bounds: { bbox } }
	assert.deepEqual(result.rows, expected)
	assert.deepEqual(page, original, "translation must not mutate the processor response")
	assert.deepEqual([result.offset, result.count, result.total, result.nextOffset], [0, 1, 1, null])
	assert.equal(result.downloads[0].contentUrl, `/files/processing/jobs/${job.id}/products/product_csv`)
	const ajv = new Ajv({ strict: false, ownProperties: true }); addFormats(ajv); ajv.addSchema(buildFilesOpenApi(), "files")
	const validate = ajv.compile({ $ref: "files#/components/schemas/ProcessingRows" })
	assert.equal(validate(result), true, JSON.stringify(validate.errors))
	for (const target of [page.rows[0], ...page.rows[0].cells.slice(0, 2), page.rows[0].cells[2].cached]) {
		const source = target.source
		for (const invalid of [{ page: 1, bounds: [0, 1, 2] }, { page: 0, bounds: bbox }, { bounds: bbox }, { page: 1, bounds: { bbox: [2, 1, 0, 3] } }]) {
			target.source = invalid
			await assert.rejects(f.c.rows(job.id, "table_one"), { status: 502, error: "invalid_result_inventory" })
		}
		target.source = source
	}
})

test("non-PDF result locators do not acquire an invented interpretation for bare bounds", async (t) => {
	const f = await fixture(t), capture = await f.w.capture(), { job } = await submit(f.c, capture)
	await until(() => f.p.jobs.size === 1)
	const upstream = [...f.p.jobs.values()][0]
	upstream.source = { snapshotId: "source_retained", sha256: sha("a\n1\n"), bytes: 4, filename: "report.csv" }; upstream.state = "partial"; upstream.resultId = "result_one"; upstream.revision++
	await until(async () => (await f.c.get(job.id)).resultAvailable)
	f.p.options.manifest = await f.c.client.results(upstream.id)
	f.p.options.manifest.products[0].source = { page: 1, bounds: [0, 1, 2, 3] }
	await assert.rejects(f.c.results(job.id), { status: 502, error: "invalid_result_inventory" })
	delete f.p.options.manifest.products[0].source
	const row = { index: 1, cells: [{ type: "text", value: "001.20", source: { sheetName: "Sheet 1", row: 1, column: 1, cell: "A1" } }], source: { row: 1 } }
	f.c.client.rows = async () => ({ offset: 0, count: 1, total: 1, nextOffset: null, rows: [row] })
	assert.deepEqual((await f.c.rows(job.id, "table_one")).rows, [row])
	row.cells[0].source = { page: 1, bounds: [0, 1, 2, 3] }
	await assert.rejects(f.c.rows(job.id, "table_one"), { status: 502, error: "invalid_result_inventory" })
})

test("processing disablement retains accepted delivery/activity and private recovery resolves ownership", async (t) => {
	const f = await fixture(t, { processor: { down: true } }), capture = await f.w.capture(), { job } = await submit(f.c, capture)
	await until(async () => (await f.c.get(job.id)).deliveryStage === "blocked")
	f.config.enabled = false; f.c.config.enabled = false
	await assert.rejects(submit(f.c, capture), { error: "processing_disabled" })
	assert.equal((await f.c.activity()).active, true)
	f.p.options.down = false; f.p.options.unknown = true
	await until(() => f.p.reconciles > 0)
	await until(() => f.p.jobs.size === 1)
	await until(async () => (await f.c.get(job.id)).processorState === "queued")
})

test("processing capture-child recovery never recaptures newer path bytes", async (t) => {
	const f = await fixture(t, { limits: { captureInlineBytes: 1 } })
	await fs.writeFile(path.join(f.w.workspaceDir, "report.csv"), "a\n1\n")
	const baseObservation = observation(f.w.ref("report.csv"), await f.w.safeFs.stat("report.csv"))
	await assert.rejects(f.c.submit({ requestId: crypto.randomUUID(), source: { kind: "workspace-file", path: "report.csv" } }), { error: "invalid_observation" })
	const { job } = await f.c.submit({ requestId: crypto.randomUUID(), source: { kind: "workspace-file", path: "report.csv", baseObservation } })
	await until(async () => (await f.w.state.get("requests", (await f.w.state.get("processing-jobs", job.id)).captureRequestId))?.state === "succeeded")
	await fs.writeFile(path.join(f.w.workspaceDir, "report.csv"), "replacement")
	await f.restart()
	await until(() => f.p.jobs.size === 1)
	assert.equal(f.p.lastBody.source.expectedSha256, sha("a\n1\n"))
	const foreign = { ...(await f.w.capture()).source, ref: { ...f.w.identity, workspaceEpoch: "foreign", path: "report.csv" } }
	await f.w.state.put("captures", foreign.captureId, { ...await f.w.state.get("captures", foreign.captureId), source: foreign })
	await assert.rejects(submit(f.c, { source: foreign }), { error: "source_unavailable" })
})

test("processing complete captures without a requested digest are hashed without reopening their workspace path", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.w.workspaceDir, "report.csv"), "accepted")
	const capture = await f.w.captures.create({ requestId: crypto.randomUUID(), path: "report.csv" })
	assert.equal(capture.source.digest.state, "not-requested")
	await fs.unlink(path.join(f.w.workspaceDir, "report.csv"))
	const { job } = await submit(f.c, capture)
	await until(() => f.p.jobs.size === 1)
	assert.equal(f.p.lastBody.source.expectedSha256, sha("accepted")); assert.equal((await f.c.get(job.id)).source.sha256, sha("accepted"))
})

test("processing PDF overrides and validated explicit reruns create fresh keys, never a content cache", async (t) => {
	const f = await fixture(t), capture = await f.w.capture("report.pdf", "%PDF-fixture"), { job } = await submit(f.c, capture, { tableRecovery: { forcePages: [2, 1, 2], vision: "off" } })
	await until(() => f.p.jobs.size === 1)
	assert.deepEqual(f.p.lastBody.tableRecovery, { forcePages: [1, 2], vision: "off" })
	const upstream = [...f.p.jobs.values()][0]; upstream.source = { snapshotId: "source_retained", sha256: sha("%PDF-fixture"), bytes: 12, filename: "report.pdf" }; upstream.state = "succeeded"; upstream.revision++
	await until(async () => (await f.c.get(job.id)).state === "succeeded")
	const rerun = await f.c.submit({ requestId: crypto.randomUUID(), rerunOf: job.id })
	await until(() => f.p.jobs.size === 2)
	assert.notEqual(rerun.job.id, job.id); assert.deepEqual(f.p.lastBody.source, { kind: "snapshot", snapshotId: "source_retained" })
	assert.equal(f.p.lastBody.rerunOf, upstream.id)
	upstream.source.sha256 = "0".repeat(64)
	await assert.rejects(f.c.submit({ requestId: crypto.randomUUID(), rerunOf: job.id }), { error: "source_unavailable" })
})

test("processing settled upload reservations stop keepalive and allow new capacity", async (t) => {
	const f = await fixture(t, { config: { activeTickets: 1 } }), capture = await f.w.capture()
	const op = { action: "upload", operationId: "auto", state: "staged", intent: { path: "report.csv", processingPolicy: "auto" }, publishedSource: capture.source, sizeBytes: 4 }
	op.processingAdmission = await f.c.reserveUpload(op); await f.w.state.put("operations", op.operationId, op)
	const record = await f.w.state.get("captures", capture.source.captureId), built = await f.c.uploadMetadata(op, record)
	await f.w.state.transaction(built.metadata); op.state = "committed"; op.processing = built.processing; await f.w.state.put("operations", op.operationId, op)
	await until(() => f.p.jobs.size === 1)
	const upstream = [...f.p.jobs.values()][0]; upstream.state = "failed"; upstream.revision++
	await until(async () => (await f.c.get(op.processing.jobId)).state === "failed")
	assert.equal((await f.c.activity()).active, false)
	assert.equal((await f.c.capabilities()).backlog.reservations, 0)
	assert.equal((await submit(f.c, capture)).status, 202)
})

test("processing concurrently admitted requests respect the ceiling and cancellation revisions under jitter", async (t) => {
	const f = await fixture(t, { config: { activeTickets: 3 } }), capture = await f.w.capture()
	const outcomes = await Promise.allSettled(Array.from({ length: 12 }, async (_, n) => { await wait(n % 4); return submit(f.c, capture) }))
	const accepted = outcomes.filter((item) => item.status === "fulfilled").map((item) => item.value.job)
	assert.equal(accepted.length, 3)
	for (const item of outcomes.filter((item) => item.status === "rejected")) assert.equal(item.reason.error, "processing_capacity")
	await until(() => f.p.jobs.size === 3)
	await Promise.all(accepted.flatMap((job, n) => Array.from({ length: 8 }, async (_, k) => { await wait((n + k) % 5); return f.c.cancel(job.id) })))
	await until(async () => (await f.c.list({})).jobs.every((job) => job.state === "cancelled"))
	assert.equal(f.p.jobs.size, 3)
	for (const job of accepted) { const record = await f.w.state.get("processing-jobs", job.id); assert.ok(record.cancelRequestedAt); assert.equal(record.deliveryStage, "terminal"); assert.ok(record.revision >= 3) }
})

test("processing SQLite reopen preserves exact request claims, upstream intent and accepted mappings", async (t) => {
	const f = await fixture(t, { sqlite: true, processor: { loseResponse: true } }), capture = await f.w.capture(), requestId = crypto.randomUUID(), body = { requestId, source: { kind: "capture", captureId: capture.source.captureId } }, { job } = await f.c.submit(body)
	await until(() => f.p.jobs.size === 1)
	await f.c.close()
	const saved = await f.w.state.get("processing-jobs", job.id)
	await f.w.state.close()
	const reopened = await FileState.open({ dir: path.join(f.w.dir, "state") }); t.after(() => reopened.close())
	f.w.state = reopened; f.w.captures.state = reopened
	await f.restart()
	const replay = await f.c.submit(body)
	assert.equal(replay.status, 200); assert.equal(replay.job.id, job.id)
	await until(async () => (await f.c.get(job.id)).processorState === "queued")
	const after = await reopened.get("processing-jobs", job.id)
	assert.equal(after.upstreamSubmissionKey, saved.upstreamSubmissionKey); assert.deepEqual(after.upstreamRequest, saved.upstreamRequest); assert.equal(f.p.jobs.size, 1)
	await assert.rejects(f.c.submit({ ...body, requireCoherentSource: true }), { error: "request_id_reused" })
})

test("processing inbox storage failures retain evidence, use stable errors and retry the stored key", async (t) => {
	const f = await fixture(t), capture = await f.w.capture(), original = f.c.jobDirectory.bind(f.c)
	let blocked = true
	f.c.jobDirectory = async (...args) => { if (blocked) throw Object.assign(new Error("ENOSPC at /private/inbox"), { code: "ENOSPC" }); return original(...args) }
	const { job } = await submit(f.c, capture)
	await until(async () => (await f.c.get(job.id)).error?.error === "insufficient_storage")
	const saved = await f.w.state.get("processing-jobs", job.id)
	assert.equal(f.p.posts, 0); assert.equal((await f.w.state.list("holds")).length, 1)
	assert.doesNotMatch(JSON.stringify(await f.c.get(job.id)), /private\/inbox/)
	blocked = false
	await until(() => f.p.jobs.size === 1)
	assert.equal([...f.p.jobs.keys()][0], saved.upstreamSubmissionKey)
})

test("processing acknowledged permanent admission errors fail visibly without endlessly resubmitting", async (t) => {
	const f = await fixture(t, { processor: { rejectSubmission: true } }), capture = await f.w.capture(), { job } = await submit(f.c, capture)
	await until(async () => (await f.c.get(job.id)).deliveryStage === "terminal")
	assert.equal((await f.c.get(job.id)).error.error, "unknown_profile")
	await until(async () => (await f.w.state.get("processing-jobs", job.id)).cleanupState === "complete")
	await wait(30); assert.equal(f.p.posts, 1); assert.equal(f.p.jobs.size, 0)
})

test("processing activity age caps warn without settling jobs and new work creates uncapped interest", async (t) => {
	const f = await fixture(t, { processor: { down: true }, config: { activityMaxAgeMs: 30 } }), capture = await f.w.capture(), { job } = await submit(f.c, capture)
	await wait(40)
	const activity = await f.c.activity()
	assert.equal(activity.active, false); assert.equal(activity.warning, "activity_keepalive_expired")
	assert.notEqual((await f.c.get(job.id)).deliveryStage, "terminal")
	await submit(f.c, capture)
	assert.equal((await f.c.activity()).active, true)
})

test("processing oversized admission acknowledgement records ambiguity and backoff using the current revision", async (t) => {
	let release
	const gate = new Promise((resolve) => { release = resolve })
	const f = await fixture(t, { processor: { largeJobResponse: true, beforeLookup: () => gate }, config: { jsonBytes: 600, runningPollMs: 200, queuedPollMs: 200, transportMs: 1000 } }), capture = await f.w.capture(), { job } = await submit(f.c, capture)
	try {
		await until(async () => f.p.lookups > 0 || (await f.c.get(job.id)).deliveryStage === "blocked")
		const record = await f.w.state.get("processing-jobs", job.id)
		assert.equal(record.error?.error, "result_metadata_too_large")
		assert.ok(record.dispatchIntentAt); assert.equal(record.dispatchUncertain, true)
		assert.ok(Date.parse(record.nextAttemptAt) > Date.now()); assert.equal(f.p.posts, 1)
	} finally { release() }
})

test("processing retries a failed durable activity write and restores unknown interest during outage", async (t) => {
	const f = await fixture(t, { processor: { unknown: true, recoveryRefused: true } }), write = f.w.state.put.bind(f.w.state)
	let attempts = 0
	f.w.state.put = async (kind, id, value) => { if (id === "internal:activity" && ++attempts === 1) throw new Error("transient metadata outage"); return write(kind, id, value) }
	await until(async () => (await f.w.state.get("processing-requests", "internal:activity"))?.settlementInterestAt, "durable settlement-interest retry")
	assert.ok(attempts >= 2)
	f.p.options.down = true
	await f.restart()
	assert.equal((await f.c.activity()).active, true); assert.equal((await f.c.list({})).jobs.length, 0)
})

test("processing crash after dispatch intent retains input when an empty lookup and rejected replay precede original admission", async (t) => {
	let release, entered
	const gate = new Promise((resolve) => { release = resolve }), first = new Promise((resolve) => { entered = resolve })
	const f = await fixture(t, { processor: { firstPost: async () => { entered(); await gate } } }), capture = await f.w.capture(), { job } = await submit(f.c, capture)
	try {
		await first
		// Preserve the exact durable crash image BEFORE the live transport records its timeout.
		const image = new MemoryState(); image.identity = structuredClone(f.w.state.identity); image.records = structuredClone(f.w.state.records); image.claims = structuredClone(f.w.state.claims)
		assert.ok((await image.get("processing-jobs", job.id)).dispatchIntentAt)
		assert.equal((await image.get("processing-jobs", job.id)).dispatchUncertain, undefined)
		await f.c.close(); f.w.state = image; f.w.captures.state = image; f.p.options.rejectSubmission = true
		await f.restart()
		await until(async () => (await f.c.get(job.id)).error?.error === "unknown_profile")
		assert.ok(f.p.lookups > 0); assert.ok(f.p.posts >= 2)
		assert.notEqual((await f.c.get(job.id)).deliveryStage, "terminal")
		assert.ok(await image.get("holds", (await image.get("processing-jobs", job.id)).holdId))
		assert.equal((await f.c.cancel(job.id)).status, 202)
		release()
		await until(async () => (await f.c.get(job.id)).state === "cancelled")
		assert.equal(f.p.jobs.size, 1)
	} finally { release() }
})

test("processing a durable request claim consumes capacity when its separate job transaction fails", async (t) => {
	const f = await fixture(t, { config: { activeTickets: 1 } }), capture = await f.w.capture(), requestId = crypto.randomUUID(), body = { requestId, source: { kind: "capture", captureId: capture.source.captureId } }
	let fail = true
	f.w.state.failCommit = (ops) => fail && ops.some((op) => op.kind === "processing-jobs" && op.value.deliveryStage === "capturing")
	await assert.rejects(f.c.submit(body), { status: 507, error: "insufficient_storage" })
	const claimed = await f.w.state.get("processing-requests", requestId)
	assert.ok(claimed.initialJob)
	assert.equal((await f.c.activity()).active, true)
	fail = false
	await assert.rejects(submit(f.c, capture), { error: "processing_capacity" })
	const recovered = await f.c.submit(body)
	assert.equal(recovered.status, 200); assert.equal(recovered.job.id, claimed.runtimeJobId)
	await until(() => f.p.jobs.size === 1)
	assert.equal((await f.c.list({})).jobs.filter((job) => job.deliveryStage !== "terminal").length, 1)
})

test("processing newly published input uses the inbox reader group even when the parent is not setgid", async (t) => {
	const gid = process.getgroups().find((group) => group !== process.getgid())
	if (gid === undefined) { t.skip("Requires membership in a supplementary group for an unprivileged ownership fixture"); return }
	const f = await fixture(t, { inboxGid: gid }), capture = await f.w.capture()
	assert.equal((await fs.stat(f.config.inboxDir)).mode & 0o2000, 0)
	await submit(f.c, capture); await until(() => f.p.jobs.size === 1)
	const name = path.join(f.config.inboxDir, f.p.lastBody.source.path), directory = await fs.stat(path.dirname(name)), file = await fs.stat(name)
	assert.equal(directory.gid, gid); assert.equal(file.gid, gid)
	assert.equal(directory.mode & 0o050, 0o050); assert.equal(file.mode & 0o777, 0o440)
})

test("processing terminal publication settles ready and failed with intake closed without replay or stale regression", async (t) => {
	for (const state of ["ready", "failed"]) await t.test(state, async (t) => {
		const f = await fixture(t), capture = await f.w.capture(), { job } = await submit(f.c, capture)
		await until(async () => (await f.c.get(job.id)).processorState === "queued")
		const upstream = [...f.p.jobs.values()][0]
		Object.assign(upstream, { source: { snapshotId: "source_retained", sha256: sha("a\n1\n"), bytes: 4, filename: "report.csv" }, state: "partial", resultId: "result_retained", finishedAt: "2026-10-04T00:00:00.000Z", documents: { state: "pending", path: null }, revision: 2 })
		await f.c.cancel(job.id)
		await until(async () => (await f.c.get(job.id)).deliveryStage === "terminal")
		const pending = await f.w.state.get("processing-jobs", job.id), oldResponse = structuredClone(upstream), cancels = f.p.cancels
		assert.equal(pending.processorPublication.state, "pending"); assert.ok(pending.cancelRequestedAt)
		f.c.config.enabled = false
		upstream.documents = { state, path: "/private/published" }; upstream.revision++
		await until(async () => (await f.c.get(job.id)).processorPublication?.state === state, `terminal publication ${state}`, 1200)
		const settled = await f.c.get(job.id)
		assert.equal(settled.state, "partial"); assert.equal(settled.deliveryStage, "terminal"); assert.equal(settled.finishedAt, pending.finishedAt); assert.equal(settled.cancelRequestedAt, pending.cancelRequestedAt)
		assert.equal(settled.processorRevision, 3); assert.ok(Date.parse(settled.lastCheckedAt) >= Date.parse(pending.lastCheckedAt))
		await f.c.observe(pending, oldResponse)
		await f.c.observe(pending, { ...oldResponse, revision: 3, state: "running" })
		const afterStale = await f.c.get(job.id)
		assert.equal(afterStale.processorPublication.state, state); assert.equal(afterStale.processorRevision, 3); assert.equal(afterStale.state, "partial"); assert.equal(afterStale.cancelRequestedAt, pending.cancelRequestedAt)
		const reads = f.p.requests.filter((request) => request.method === "GET" && request.path === `/preprocessing/jobs/${upstream.id}`).length
		await wait(40)
		assert.equal(f.p.requests.filter((request) => request.method === "GET" && request.path === `/preprocessing/jobs/${upstream.id}`).length, reads)
		assert.equal(f.p.posts, 1); assert.equal(f.p.cancels, cancels)
	})
})

test("processing terminal publication read failures keep the outcome and retry with bounded backoff", async (t) => {
	const f = await fixture(t, { config: { runningPollMs: 100, queuedPollMs: 100 } }), capture = await f.w.capture(), { job } = await submit(f.c, capture)
	await until(async () => (await f.c.get(job.id)).processorState === "queued")
	const upstream = [...f.p.jobs.values()][0]
	Object.assign(upstream, { source: { snapshotId: "source_retained", sha256: sha("a\n1\n"), bytes: 4, filename: "report.csv" }, state: "succeeded", resultId: "result_retained", documents: { state: "pending", path: null }, revision: 2 })
	await until(async () => (await f.c.get(job.id)).deliveryStage === "terminal")
	const terminalJob = await f.c.get(job.id)
	f.p.options.jobReadError = true
	await until(async () => (await f.c.get(job.id)).processorPublication?.error?.retryable === true, "retryable terminal publication read", 1200)
	const blocked = await f.c.get(job.id)
	assert.equal(blocked.state, "succeeded"); assert.equal(blocked.deliveryStage, "terminal"); assert.equal(blocked.error, terminalJob.error); assert.equal(blocked.finishedAt, terminalJob.finishedAt)
	assert.ok(Date.parse(blocked.nextAttemptAt) > Date.now()); assert.equal(blocked.processorPublication.error.error, "provider_unavailable")
	f.p.options.jobReadError = false; upstream.documents = { state: "ready", path: "/private/published" }; upstream.revision++
	await until(async () => (await f.c.get(job.id)).processorPublication?.state === "ready")
	assert.equal((await f.c.get(job.id)).processorPublication.error, undefined); assert.equal(f.p.posts, 1)
})

test("processing terminal publication pending at restart is reconciled with admission disabled", async (t) => {
	const f = await fixture(t), capture = await f.w.capture(), { job } = await submit(f.c, capture)
	await until(async () => (await f.c.get(job.id)).processorState === "queued")
	const upstream = [...f.p.jobs.values()][0]
	Object.assign(upstream, { state: "succeeded", resultId: "result_retained", documents: { state: "pending", path: null }, revision: 2 })
	await until(async () => (await f.c.get(job.id)).deliveryStage === "terminal")
	const before = await f.c.get(job.id)
	await f.c.close(); f.config.enabled = false
	upstream.documents = { state: "failed", path: null }; upstream.revision++
	await f.restart()
	const after = await f.c.get(job.id)
	assert.equal(after.processorPublication.state, "failed"); assert.equal(after.processorRevision, 3); assert.equal(after.state, "succeeded"); assert.equal(after.finishedAt, before.finishedAt); assert.equal(f.p.posts, 1)
})

test("processing upload receipts disclose PDF model potential for pending and skipped decisions", async (t) => {
	const f = await fixture(t, { processor: { down: true } })
	for (const [name, policy, expected] of [["report.PDF", "auto", true], ["report.csv", "auto", false], ["skipped.pdf", "skip", true], ["skipped.csv", "skip", false]]) {
		const capture = await f.w.capture(name, "accepted bytes"), op = { operationId: crypto.randomUUID(), action: "upload", state: "staged", intent: { path: name, processingPolicy: policy }, publishedSource: capture.source, sizeBytes: capture.source.sizeBytes }
		op.processingAdmission = await f.c.reserveUpload(op)
		const result = await f.c.uploadMetadata(op, await f.w.state.get("captures", capture.source.captureId))
		assert.equal(result.processing.mayUseModel, expected, `${name}/${policy}`)
		assert.equal(result.processing.policy, policy); assert.equal(result.processing.state, policy === "auto" ? "pending" : "skipped")
		assert.equal(result.processing.reason, policy === "auto" ? null : "opt_out")
	}
	assert.equal(f.p.posts, 0, "format disclosure is not evidence of model use or upstream dispatch")
})

test("processing durable milestone logs select metadata and do not emit for failed writes or ordinary polls", async (t) => {
	const entries = [], violations = []; let f, writing = false
	const logger = { info(event, fields) {
		entries.push({ event, fields: structuredClone(fields) })
		if (writing) violations.push("logger inside metadata transaction")
		if (fields.runtimeJobId && !f.w.state.records.has(`processing-jobs/${fields.runtimeJobId}`)) violations.push("ticket event before durable admission")
	} }
	f = await fixture(t, { logger, projectId: "telemetry-project", config: { token: "DO_NOT_LOG_BEARER", bundleDigest: "b".repeat(64) } })
	const name = "DO_NOT_LOG_FILENAME.csv", bytes = "DO_NOT_LOG_DOCUMENT_CONTENT", capture = await f.w.capture(name, bytes), body = { requestId: crypto.randomUUID(), source: { kind: "capture", captureId: capture.source.captureId } }
	const transaction = f.w.state.transaction.bind(f.w.state)
	f.w.state.transaction = async (ops) => { writing = true; try { return await transaction(ops) } finally { writing = false } }
	let fail = true
	f.w.state.failCommit = (ops) => fail && ops.some((op) => op.kind === "processing-jobs")
	await assert.rejects(f.c.submit(body), { status: 507 }); assert.equal(entries.length, 0)
	fail = false
	const { job } = await f.c.submit(body)
	await until(async () => (await f.c.get(job.id)).processorState === "queued")
	const upstream = [...f.p.jobs.values()][0]
	upstream.profile = { id: "default", profileDigest: "a".repeat(64), token: "DO_NOT_LOG_PROFILE_CREDENTIAL", prompt: "DO_NOT_LOG_PROMPT" }; upstream.revision++
	await until(() => entries.some((entry) => entry.fields.profileDigest === "a".repeat(64)))
	const beforePolls = entries.length
	await wait(40); assert.equal(entries.length, beforePolls, "same-state polling cannot produce milestone noise")
	upstream.source = { snapshotId: "source_retained", sha256: sha(bytes), bytes: Buffer.byteLength(bytes), filename: name }; upstream.state = "succeeded"; upstream.revision++
	await until(async () => (await f.w.state.get("processing-jobs", job.id)).cleanupState === "complete")
	for (const event of ["processing.admitted", "processing.capture.completed", "processing.copy.started", "processing.copy.published", "processing.dispatch.intent", "processing.upstream.admitted", "processing.snapshot.acknowledged", "processing.terminal.succeeded", "processing.cleanup.complete"]) assert.ok(entries.some((entry) => entry.event === event), event)
	assert.deepEqual(violations, [])
	const allowed = new Set(["workspaceId", "workspaceEpoch", "projectId", "runtimeJobId", "uploadOperationId", "submissionKey", "processorJobId", "sourceSha256", "profileDigest", "buildDigest"])
	for (const { fields } of entries) {
		assert.ok(Object.keys(fields).every((key) => allowed.has(key)))
		assert.equal(fields.workspaceEpoch, f.w.identity.workspaceEpoch); assert.equal(fields.projectId, "telemetry-project"); assert.equal(fields.buildDigest, "b".repeat(64))
	}
	assert.doesNotMatch(JSON.stringify(entries), /DO_NOT_LOG|originalFilename|requestedOptions|upstreamRequest|inboxRelativePath/)
})

test("processing logger failures cannot fail manual admission, committed uploads or cancellation", async (t) => {
	let calls = 0
	const logger = { info() { calls++; if (calls % 2) throw new Error("logger failure"); return Promise.reject(new Error("asynchronous logger failure")) } }
	const f = await fixture(t, { logger }), capture = await f.w.capture(), { status, job } = await submit(f.c, capture)
	assert.equal(status, 202)
	await until(async () => (await f.c.get(job.id)).processorState === "queued")
	await f.c.cancel(job.id); await until(async () => (await f.c.get(job.id)).state === "cancelled")
	const op = { operationId: "skip-logged", action: "upload", state: "committed", intent: { path: "report.csv", processingPolicy: "skip" }, publishedSource: capture.source, processing: { policy: "skip", state: "skipped", jobId: null, reason: "opt_out", mayUseModel: false } }
	await f.w.state.put("operations", op.operationId, op)
	await f.c.uploadCommitted(op)
	assert.equal((await f.w.state.get("operations", op.operationId)).state, "committed")
	assert.ok(calls >= 4, "logger must actually be exercised, not bypassed to pass this test")
})

test("processing upload commit logs follow the atomic ticket hold and receipt commit", async (t) => {
	const entries = [], f = await fixture(t, { processor: { down: true }, logger: { info(event, fields) { entries.push({ event, fields }) } } }), capture = await f.w.capture()
	const op = { operationId: "upload-telemetry", action: "upload", state: "staged", intent: { path: "report.csv", processingPolicy: "auto" }, publishedSource: capture.source, sizeBytes: capture.source.sizeBytes }
	op.processingAdmission = await f.c.reserveUpload(op); await f.w.state.put("operations", op.operationId, op)
	const built = await f.c.uploadMetadata(op, await f.w.state.get("captures", capture.source.captureId))
	assert.equal(entries.length, 0, "building commit metadata cannot log an admitted upload")
	await f.c.uploadCommitted({ ...op, state: "committed", processing: built.processing })
	assert.equal(entries.length, 0, "uncommitted operation cannot create an admission event")
	op.state = "committed"; op.processing = built.processing
	await f.w.state.transaction([...built.metadata, { type: "put", kind: "operations", id: op.operationId, value: op }])
	await f.c.uploadCommitted(op)
	assert.ok(entries.some((entry) => entry.event === "processing.upload.admitted" && entry.fields.uploadOperationId === op.operationId))
	assert.ok(entries.some((entry) => entry.event === "processing.capture.completed"))
	const ticket = await f.w.state.get("processing-jobs", op.processing.jobId)
	assert.ok(await f.w.state.get("holds", ticket.holdId))
})

test("processing capability observability scopes ages skips cleanup interruption and upstream counts", async (t) => {
	const f = await fixture(t), capture = await f.w.capture()
	await f.c.drain()
	const stamp = Date.now(), at = (age) => new Date(stamp - age).toISOString(), initial = (age) => ({ ...f.c.newJob(crypto.randomUUID(), { kind: "capture", captureId: capture.source.captureId }, { requireCoherentSource: false }), createdAt: at(age) })
	const pending = { ...initial(10000), deliveryStage: "pending" }, capturing = initial(20000), queued = { ...initial(50000), deliveryStage: "tracking", processorJobId: "job_queued", processorState: "queued" }, running = { ...initial(40000), deliveryStage: "tracking", processorJobId: "job_running", processorState: "running" }, interrupted = { ...initial(60000), deliveryStage: "terminal", outcome: "interrupted", cleanupState: "complete" }, cleanup = { ...initial(70000), deliveryStage: "terminal", outcome: "succeeded", cleanupState: "blocked" }, ambiguous = { ...initial(15000), deliveryStage: "blocked", dispatchIntentAt: at(10000) }
	for (const job of [pending, capturing, queued, running, interrupted, cleanup, ambiguous]) await f.w.state.put("processing-jobs", job.runtimeJobId, job)
	const unmatched = initial(25000)
	await f.w.state.put("processing-requests", unmatched.requestId, { ...f.w.identity, runtimeJobId: unmatched.runtimeJobId, initialJob: unmatched })
	const reserved = { state: "reserved", jobId: `processing_${crypto.randomUUID()}`, createdAt: at(30000) }
	await f.w.state.put("operations", "reserved", { action: "upload", operationId: "reserved", state: "publishing", intent: { processingPolicy: "auto" }, publishedSource: capture.source, processingAdmission: reserved })
	await f.c.rebuildReservations()
	const operation = (id, extra = {}) => ({ operationId: id, action: "upload", state: "committed", intent: { processingPolicy: "auto" }, publishedSource: capture.source, processing: { state: "skipped", reason: "disabled" }, ...extra })
	for (const op of [operation("disabled"), operation("opt-out", { intent: { processingPolicy: "skip" }, processing: { state: "skipped", reason: "opt_out" } }), operation("internal", { intent: { processingPolicy: null } }), operation("parent", { action: "mkdir" }), operation("unfinished", { state: "publishing" }), operation("foreign", { publishedSource: { ...capture.source, ref: { ...capture.source.ref, workspaceEpoch: crypto.randomUUID() } } })]) await f.w.state.put("operations", op.operationId, op)
	f.c.client.capabilities = async () => ({ dependency: { state: "ready", ready: true }, activity: { activeJobId: "job_running", queuedJobs: 7, unsettledOperations: 2, settlementUnknown: true } })
	f.c.dependencyCheckedMs = 0; await f.c.checkDependency()
	await f.c.observeStorage({ observedAt: new Date().toISOString(), complete: true, processorDataBytes: 123, diskFreeBytes: 456 })
	const result = await f.c.capabilities(), backlog = result.backlog
	assert.equal(backlog.oldestPendingAt, unmatched.createdAt); assert.ok(backlog.oldestPendingAgeMs >= 25000 && backlog.oldestPendingAgeMs < 26000)
	assert.equal(backlog.oldestReservationAt, reserved.createdAt); assert.ok(backlog.oldestReservationAgeMs >= 30000 && backlog.oldestReservationAgeMs < 31000)
	assert.equal(backlog.cleanupFailures, 1); assert.equal(backlog.interrupted, 1); assert.equal(backlog.unknownAdmission, 1)
	assert.equal(backlog.unknownSettlement, true); assert.equal(backlog.unsettledOperations, 2); assert.equal(backlog.processorQueued, 7); assert.equal(backlog.processorRunning, 1); assert.ok(backlog.processorCheckedAt)
	assert.deepEqual(backlog.skipReasons, { opt_out: 1, disabled: 1, unsupported_format: 0, input_too_large: 0, processing_capacity: 0 })
	assert.equal(result.storage.processorDataBytes, 123); assert.equal(result.storage.diskFreeBytes, 456)
})

test("processing recovery telemetry follows its durable control outcome without private evidence", async (t) => {
	const entries = [], f = await fixture(t, { logger: { info(event, fields) { entries.push({ event, fields }) } } })
	await f.c.drain()
	const put = f.w.state.put.bind(f.w.state)
	let fail = true
	f.w.state.put = async (kind, id, value) => { if (fail && id === "internal:recovery") throw new Error("DO_NOT_LOG_RECOVERY_WRITE"); return put(kind, id, value) }
	f.p.options.unknown = true; f.p.options.recoveryRefused = true
	f.c.dependencyCheckedMs = 0; await f.c.checkDependency()
	assert.equal(entries.filter((entry) => entry.event.startsWith("processing.recovery.")).length, 0)
	assert.equal(await f.w.state.get("processing-requests", "internal:recovery"), null)
	fail = false; f.c.dependencyCheckedMs = 0; f.c.nextRecovery = 0; await f.c.checkDependency()
	assert.equal((await f.w.state.get("processing-requests", "internal:recovery")).report.settled, false)
	assert.ok(entries.some((entry) => entry.event === "processing.recovery.blocked"))
	f.p.options.recoveryRefused = false; f.c.dependencyCheckedMs = 0; f.c.nextRecovery = 0; await f.c.checkDependency()
	assert.equal((await f.w.state.get("processing-requests", "internal:recovery")).report.settled, true)
	assert.ok(entries.some((entry) => entry.event === "processing.recovery.settled"))
	assert.doesNotMatch(JSON.stringify(entries), /DO_NOT_LOG|ownership_recovery_required|action|token|\/private/)
})

test("processing manual upload capture logging waits for its independent durable hold", async (t) => {
	const violations = []; let f, completions = 0
	f = await fixture(t, { processor: { down: true }, logger: { info(event, fields) {
		if (event !== "processing.capture.completed") return
		completions++
		const job = f.w.state.records.get(`processing-jobs/${fields.runtimeJobId}`)
		if (!job || !f.w.state.records.has(`holds/${job.holdId}`)) violations.push("capture completion before processing hold")
	} } })
	const capture = await f.w.capture(), op = { action: "upload", operationId: "manual-skipped", state: "committed", intent: { path: "report.csv", processingPolicy: "skip" }, publishedSource: capture.source, processing: { policy: "skip", state: "skipped", jobId: null, reason: "opt_out", mayUseModel: false } }
	await f.w.state.put("operations", op.operationId, op)
	await f.c.submit({ requestId: crypto.randomUUID(), source: { kind: "upload-operation", operationId: op.operationId } })
	assert.deepEqual(violations, [])
	assert.equal(completions, 1)
})
