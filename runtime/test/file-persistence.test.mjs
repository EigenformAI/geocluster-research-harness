import assert from "node:assert/strict"
import crypto from "node:crypto"
import { setTimeout as wait } from "node:timers/promises"
import { test } from "node:test"
import { FileError, identifier, noPersistence } from "../lib/file-contract.js"
import { validateMetadata } from "../lib/file-state.js"
import { WorkspacePersistencePort } from "../lib/workspace-persistence-port.js"

const adapter = Object.freeze({ kind: "injected-local-test-seam" })
const sameRef = (a, b) => a.workspaceId === b.workspaceId && a.workspaceEpoch === b.workspaceEpoch && a.path === b.path

class MemoryState {
	constructor({ jitter = false } = {}) { this.records = new Map(); this.jitter = jitter; this.failTransaction = false }
	key(kind, id) { identifier(kind, "record kind"); identifier(id, "record id"); return `${kind}/${id}` }
	async pause() { if (this.jitter) await wait(Math.floor(Math.random() * 4)) }
	async get(kind, id) { await this.pause(); return structuredClone(this.records.get(this.key(kind, id)) ?? null) }
	async put(kind, id, value) { validateMetadata(value); await this.pause(); this.records.set(this.key(kind, id), structuredClone(value)); return value }
	async list(kind) {
		identifier(kind, "record kind"); await this.pause()
		// FileState orders UUID record IDs, which are deliberately not commit order.
		return [...this.records].filter(([key]) => key.startsWith(`${kind}/`)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => structuredClone(value))
	}
	async transaction(operations) {
		for (const op of operations) { this.key(op.kind, op.id); assert.ok(["put", "delete"].includes(op.type)); if (op.type === "put") validateMetadata(op.value) }
		await this.pause()
		if (this.failTransaction) { this.failTransaction = false; throw Object.assign(new Error("metadata commit failed"), { code: "EIO" }) }
		const next = new Map(this.records)
		for (const op of operations) { if (op.type === "put") next.set(this.key(op.kind, op.id), structuredClone(op.value)); else next.delete(this.key(op.kind, op.id)) }
		this.records = next
	}
}

class FakeCaptures {
	constructor(state) { this.state = state; this.bytes = new Map(); this.readers = 0; this.opened = [] }
	async open(kind, id) {
		assert.equal(kind, "capture"); this.opened.push(id)
		const record = await this.state.get("captures", id)
		if (!record || record.evictedAt || !this.bytes.has(id)) {
			const held = (await this.state.list("holds")).some((hold) => hold.source.kind === kind && hold.source.id === id)
			throw new FileError(held ? 503 : 410, held ? "transfer_source_missing" : "capture_expired", "Fake protected bytes are unavailable.", { state: held ? "indeterminate" : "unavailable" })
		}
		this.readers++; let released = false
		return { source: structuredClone(record.source), handle: { readFile: async () => Buffer.from(this.bytes.get(id)) }, release: async () => { if (!released) { released = true; this.readers-- } } }
	}
	async get(kind, id) { const opened = await this.open(kind, id); try { return { source: opened.source, availability: "available" } } finally { await opened.release() } }
	async hold(kind, id, reason, holdId = crypto.randomUUID()) {
		const opened = await this.open(kind, id)
		try { await this.state.put("holds", holdId, { holdId, source: { kind, id }, reason, createdAt: new Date().toISOString() }); return holdId } finally { await opened.release() }
	}
}

class FakeWorkspace {
	constructor(state = new MemoryState()) {
		this.state = state; this.identity = { workspaceId: crypto.randomUUID(), workspaceEpoch: crypto.randomUUID() }
		this.captures = new FakeCaptures(state); this.clock = Date.parse("2026-10-01T00:00:00.000Z")
		this.statCalls = 0; this.uploadCalls = 0; this.remoteCalls = []
		let tail = Promise.resolve()
		this.locks = { run(work) { const result = tail.then(work); tail = result.catch(() => {}); return result } }
	}
	ref(path) { return { ...this.identity, path } }
	async stat(path) { this.statCalls++; const operations = await this.state.list("operations"); const latest = operations.filter((op) => op.addresses.some((ref) => sameRef(ref, this.ref(path)))).sort((a, b) => a.committedAt < b.committedAt ? -1 : 1).at(-1); return { ref: this.ref(path), persistence: latest?.persistence || noPersistence() } }
	async upload() { this.uploadCalls++; throw new Error("Remote replacement must use the parent's recovery-aware applyRemote.") }
	async commit(options = {}) { return this.locks.run(() => this.commitLocked(options)) }
	async commitLocked({ path = "a.txt", bytes = "published", generation = crypto.randomUUID(), journalId = crypto.randomUUID(), operationId = crypto.randomUUID(), state = "committed", persistenceState = "queued", addresses } = {}) {
		const ref = this.ref(path), id = crypto.randomUUID(), source = { kind: "runtime-capture", ref, captureId: id, etag: `"capture-${id}"`, sizeBytes: Buffer.byteLength(bytes), consistency: "service-published", digest: { state: "not-requested", sha256: null } }
		const committedAt = new Date(this.clock++).toISOString()
		const op = { operationId, state, action: "upload", addresses: addresses || [ref], localGeneration: generation, publishedSource: source, committedAt, persistence: { ...noPersistence(), state: persistenceState, localGeneration: generation }, reconciliation: { required: false, inspectionRef: null, replayAllowed: false } }
		this.captures.bytes.set(id, Buffer.from(bytes))
		await this.state.transaction([
			{ type: "put", kind: "captures", id, value: { id, kind: "capture", source, sizeBytes: source.sizeBytes, createdAt: committedAt, lastAccessAt: committedAt, blobObservation: "private-blob-observation" } },
			{ type: "put", kind: "operations", id: operationId, value: op },
			{ type: "put", kind: "local-changes", id: journalId, value: { id: journalId, cursor: committedAt, ...op } },
		])
		return op
	}
	async applyRemote(change, bytes, baseLocalGeneration) {
		this.remoteCalls.push({ change, bytes, baseLocalGeneration })
		return this.locks.run(async () => {
			const op = await this.commitLocked({ path: change.ref?.path ?? change.path, operationId: change.operationId, bytes: "remote bytes", persistenceState: "clean" })
			op.action = "apply-remote"; op.persistence.acknowledgedRemoteEtag = change.remoteEtag
			await this.state.put("operations", op.operationId, op)
			return op
		})
	}
}

async function seedTransfer(workspace, op) {
	const holdId = crypto.randomUUID(), transfer = { holdId, operationId: op.operationId, ref: op.publishedSource.ref, localGeneration: op.localGeneration, source: op.publishedSource, state: "queued", createdAt: op.committedAt, acknowledgement: null, error: null }
	await workspace.state.transaction([
		{ type: "put", kind: "holds", id: holdId, value: { holdId, source: { kind: "capture", id: transfer.source.captureId }, reason: "sync", ref: transfer.ref, localGeneration: transfer.localGeneration, createdAt: transfer.createdAt } },
		{ type: "put", kind: "persistence-transfers", id: holdId, value: transfer },
	])
	return transfer
}

const acknowledgement = (transfer, remoteEtag = 'opaque "NOT-an-MD5" / revision:7') => ({ ref: transfer.ref, localGeneration: transfer.localGeneration, holdId: transfer.holdId, remoteEtag, sizeBytes: transfer.source.sizeBytes })
const remoteChange = (workspace, fields = {}) => ({ operationId: crypto.randomUUID(), ref: workspace.ref("a.txt"), remoteEtag: 'remote "opaque" / 2', applyNow: false, discardLocal: false, ...fields })
async function collect(iterable) { const values = []; for await (const value of iterable) values.push(value); return values }

test("persistence: persisted commit cursors, not UUID order, determine resumable changes", async () => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace)
	const first = await workspace.commit({ journalId: "ffffffff-ffff-4fff-8fff-ffffffffffff" })
	const second = await workspace.commit({ journalId: "00000000-0000-4000-8000-000000000000" })
	const changes = await collect(port.changesAfter(""))
	assert.deepEqual(changes.map((change) => change.operationId), [first.operationId, second.operationId])
	assert.deepEqual(changes.map((change) => change.cursor), [first.committedAt, second.committedAt])
	const restarted = new WorkspacePersistencePort(workspace)
	assert.deepEqual((await collect(restarted.changesAfter(first.committedAt))).map((change) => change.operationId), [second.operationId])
})

test("persistence: stale acknowledgement clears only the sent generation and preserves an opaque remote ETag", async () => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace, { adapter })
	const old = await workspace.commit({ bytes: "old transfer" }), transfer = await seedTransfer(workspace, old)
	const newer = await workspace.commit({ bytes: "new local edit" }), result = acknowledgement(transfer)
	assert.equal(await port.recordAcknowledgement(result), undefined)
	assert.equal((await workspace.state.get("operations", newer.operationId)).persistence.state, "queued", "an acknowledgement for old bytes must not clean the new edit")
	const oldStatus = (await workspace.state.get("operations", old.operationId)).persistence
	assert.equal(oldStatus.state, "clean")
	assert.equal(oldStatus.acknowledgedRemoteEtag, result.remoteEtag)
	assert.equal(oldStatus.remoteIntegrity, "size-acknowledged")
	assert.equal((await port.status(newer.publishedSource.ref)).localGeneration, newer.localGeneration)
	assert.equal((await port.status(newer.publishedSource.ref)).state, "queued")
	assert.equal(await workspace.state.get("holds", transfer.holdId), null)
})

test("persistence: configuration flags cannot advertise a remote adapter or cloud persistence", async () => {
	const workspace = new FakeWorkspace(), op = await workspace.commit()
	for (const supplied of [null, false, true]) {
		const port = new WorkspacePersistencePort(workspace, { adapter: supplied })
		assert.deepEqual(await port.status(op.publishedSource.ref), noPersistence())
		assert.deepEqual(await port.status(), noPersistence())
		assert.equal(port.capabilities().enabled, false)
		assert.deepEqual(port.capabilities().requirements, Array.from({ length: 9 }, (_, n) => `INT-0${n + 1}`))
		await assert.rejects(port.applyRemote(remoteChange(workspace, { applyNow: true }), {}, op.localGeneration), { status: 503, error: "integration_unavailable" })
	}
	assert.equal(new WorkspacePersistencePort(workspace, { adapter }).capabilities().enabled, false, "injection enables local seam tests, not unresolved backend capabilities")
	assert.equal(workspace.remoteCalls.length, 0)
})

test("persistence: change iteration is finite, bounded, abortable, and does not reinterpret duplicate cursors", async () => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace)
	const first = await workspace.commit(), second = await workspace.commit(), third = await workspace.commit()
	assert.deepEqual((await collect(port.changesAfter("", { limit: 2 }))).map((change) => change.operationId), [first.operationId, second.operationId])
	const controller = new AbortController(), iterator = port.changesAfter("", { signal: controller.signal })
	assert.equal((await iterator.next()).value.operationId, first.operationId)
	controller.abort()
	await assert.rejects(iterator.next(), { name: "AbortError" })
	const snapshot = port.changesAfter("", { limit: 10 })
	assert.equal((await snapshot.next()).value.operationId, first.operationId)
	await workspace.commit()
	assert.deepEqual((await collect(snapshot)).map((change) => change.operationId), [second.operationId, third.operationId], "new commits belong to the next finite iteration")
	await assert.rejects(collect(port.changesAfter("", { limit: 0 })), { status: 400, error: "invalid_budget" })
	const duplicate = { ...(await workspace.state.list("local-changes"))[0], id: crypto.randomUUID(), cursor: first.committedAt, committedAt: first.committedAt }
	await workspace.state.put("local-changes", duplicate.id, duplicate)
	await assert.rejects(collect(port.changesAfter("")), { status: 503, error: "storage_unavailable" })
})

test("persistence: transfer acquisition pins exact published bytes and retries the same durable hold across restart", async () => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace, { adapter })
	const old = await workspace.commit({ bytes: "old protected bytes" })
	await workspace.commit({ bytes: "new Current bytes" })
	const transfer = await port.captureForTransfer(old.publishedSource.ref, old.localGeneration)
	assert.equal(transfer.localGeneration, old.localGeneration)
	assert.equal(transfer.source.captureId, old.publishedSource.captureId)
	const hold = await workspace.state.get("holds", transfer.holdId)
	assert.equal(hold.source.id, transfer.source.captureId)
	assert.equal(hold.localGeneration, old.localGeneration)
	const opened = await workspace.captures.open("capture", transfer.source.captureId)
	try { assert.equal((await opened.handle.readFile()).toString(), "old protected bytes") } finally { await opened.release() }
	const restarted = new WorkspacePersistencePort(workspace, { adapter })
	assert.deepEqual(await restarted.captureForTransfer(old.publishedSource.ref, old.localGeneration), transfer)
	assert.equal((await workspace.state.list("holds")).length, 1)
	assert.equal(workspace.captures.readers, 0)
	assert.equal(workspace.statCalls, 0, "never capture a requested generation from the mutable pathname")
})

test("persistence: failed atomic transfer admission cannot leave a generationless durable hold", async () => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace, { adapter }), op = await workspace.commit()
	workspace.state.failTransaction = true
	await assert.rejects(port.captureForTransfer(op.publishedSource.ref, op.localGeneration), { error: "storage_unavailable", state: "indeterminate" })
	assert.deepEqual(await workspace.state.list("holds"), [])
	assert.deepEqual(await workspace.state.list("persistence-transfers"), [])
	assert.equal(workspace.captures.readers, 0)
	assert.ok((await port.captureForTransfer(op.publishedSource.ref, op.localGeneration)).holdId)
})

test("persistence: an unavailable unheld generation is a conflict and cannot fall back to Current", async () => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace, { adapter }), old = await workspace.commit()
	workspace.captures.bytes.delete(old.publishedSource.captureId)
	await workspace.commit({ bytes: "newer" })
	await assert.rejects(port.captureForTransfer(old.publishedSource.ref, old.localGeneration), { status: 409, error: "source_changed" })
	await assert.rejects(port.captureForTransfer(old.publishedSource.ref, crypto.randomUUID()), { status: 409, error: "source_changed" })
	assert.deepEqual(await workspace.state.list("holds"), [])
	assert.equal(workspace.statCalls, 0)
	assert.equal(workspace.uploadCalls, 0)
})

test("persistence: missing held bytes become indeterminate, retain their hold, and never acknowledge newer bytes", async () => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace, { adapter }), old = await workspace.commit({ bytes: "held" })
	const transfer = await port.captureForTransfer(old.publishedSource.ref, old.localGeneration)
	const newer = await workspace.commit({ bytes: "replacement pathname" })
	workspace.captures.bytes.delete(transfer.source.captureId)
	await assert.rejects(port.captureForTransfer(transfer.source.ref, transfer.localGeneration), { status: 503, error: "transfer_source_missing", state: "indeterminate" })
	await assert.rejects(port.recordAcknowledgement(acknowledgement({ ...transfer, ref: transfer.source.ref })), { status: 503, error: "transfer_source_missing", state: "indeterminate" })
	assert.equal((await workspace.state.get("persistence-transfers", transfer.holdId)).state, "indeterminate")
	assert.equal((await workspace.state.get("operations", old.operationId)).persistence.state, "indeterminate")
	assert.equal((await workspace.state.get("operations", newer.operationId)).persistence.state, "queued")
	assert.ok(await workspace.state.get("holds", transfer.holdId))
	assert.equal(workspace.statCalls, 0)
	assert.ok(workspace.captures.opened.every((id) => id === old.publishedSource.captureId))
})

test("persistence: acknowledgements require the held address/generation and size; duplicate receipts survive later byte eviction", async () => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace, { adapter }), op = await workspace.commit()
	const held = await port.captureForTransfer(op.publishedSource.ref, op.localGeneration), transfer = { ...held, ref: held.source.ref }, result = acknowledgement(transfer)
	await assert.rejects(port.recordAcknowledgement({ ...result, localGeneration: crypto.randomUUID() }), { status: 409 })
	await assert.rejects(port.recordAcknowledgement({ ...result, ref: workspace.ref("other.txt") }), { status: 409 })
	await assert.rejects(port.recordAcknowledgement({ ...result, sizeBytes: result.sizeBytes + 1 }), { status: 409, error: "transfer_size_mismatch" })
	await assert.rejects(port.recordAcknowledgement({ ...result, remoteIntegrity: "digest-verified" }), { status: 503, error: "integration_unavailable" })
	assert.ok(await workspace.state.get("holds", held.holdId))
	workspace.state.failTransaction = true
	await assert.rejects(port.recordAcknowledgement(result), { error: "storage_unavailable", state: "indeterminate" })
	assert.ok(await workspace.state.get("holds", held.holdId), "a failed receipt commit must not release the hold")
	assert.equal((await port.status(result.ref)).state, "queued")
	await port.recordAcknowledgement(result)
	workspace.captures.bytes.delete(held.source.captureId)
	assert.equal(await new WorkspacePersistencePort(workspace, { adapter }).recordAcknowledgement(result), undefined)
	await assert.rejects(port.recordAcknowledgement({ ...result, remoteEtag: "different acknowledgement" }), { status: 409, error: "acknowledgement_mismatch" })
	assert.equal((await port.status(result.ref)).state, "clean")
})

test("persistence: unknown and active writer registries durably defer replacement without consuming remote bytes", async () => {
	for (const registry of [null, {}, { async status() { return { state: "unknown" } } }, { async status() { return { state: "active" } } }]) {
		const workspace = new FakeWorkspace(), op = await workspace.commit()
		const port = new WorkspacePersistencePort(workspace, { adapter, writerRegistry: registry }), change = remoteChange(workspace)
		let consumed = false
		const bytes = { async *[Symbol.asyncIterator]() { consumed = true; yield Buffer.from("remote") } }
		const deferred = await port.applyRemote(change, bytes, op.localGeneration)
		assert.equal(deferred.state, "accepted")
		assert.equal(deferred.deferred, true)
		assert.equal(deferred.persistence.state, "waiting-for-local-writer")
		assert.equal(deferred.persistence.pendingRemoteEtag, change.remoteEtag)
		assert.equal(workspace.remoteCalls.length, 0)
		assert.equal(consumed, false)
		const restarted = new WorkspacePersistencePort(workspace, { adapter })
		assert.equal((await restarted.status(change.ref)).pendingRemoteEtag, change.remoteEtag)
		assert.equal((await restarted.status(change.ref)).state, "waiting-for-local-writer")
		assert.equal((await restarted.drain(Date.now())).remotePending, 2, "the unsent local generation and deferred replacement remain unresolved")
	}
})

test("persistence: apply-now bypasses the writer gate and delegates original arguments to recovery-aware WorkspaceFiles", async () => {
	const workspace = new FakeWorkspace(), op = await workspace.commit(), bytes = {}
	const registry = { async status() { throw new Error("apply-now must not inspect this registry") } }
	const port = new WorkspacePersistencePort(workspace, { adapter, writerRegistry: registry })
	const change = remoteChange(workspace, { applyNow: true })
	const result = await port.applyRemote(change, bytes, op.localGeneration)
	assert.equal(result.state, "committed")
	assert.equal(workspace.remoteCalls.length, 1)
	assert.equal(workspace.remoteCalls[0].change, change)
	assert.equal(workspace.remoteCalls[0].bytes, bytes)
	assert.equal(workspace.remoteCalls[0].baseLocalGeneration, op.localGeneration)
	assert.equal(workspace.uploadCalls, 0)
	assert.equal((await port.status(change.ref)).pendingRemoteEtag, null)
	assert.equal((await port.status(change.ref)).acknowledgedRemoteEtag, change.remoteEtag)
	const idle = new WorkspacePersistencePort(workspace, { adapter, writerRegistry: { async status() { return { state: "idle" } } } })
	const next = await idle.applyRemote(remoteChange(workspace), bytes, result.localGeneration)
	assert.equal(workspace.remoteCalls.length, 2)
	workspace.applyRemote = undefined
	await assert.rejects(idle.applyRemote(remoteChange(workspace, { applyNow: true }), bytes, next.localGeneration), { status: 503, error: "integration_unavailable" })
	assert.equal(workspace.uploadCalls, 0)
})

test("persistence: registry failures are actionable deferred outcomes and stale base generations are conflicts", async () => {
	const workspace = new FakeWorkspace(), old = await workspace.commit(), newer = await workspace.commit()
	const registry = { async status() { throw Object.assign(new Error("writer registry disconnected"), { code: "EIO" }) } }
	const port = new WorkspacePersistencePort(workspace, { adapter, writerRegistry: registry })
	await assert.rejects(port.applyRemote(remoteChange(workspace), {}, old.localGeneration), { status: 409, error: "source_changed" })
	const deferred = await port.applyRemote(remoteChange(workspace), {}, newer.localGeneration)
	assert.equal(deferred.persistence.state, "waiting-for-local-writer")
	assert.match(deferred.error.message, /registry disconnected/)
	assert.equal(deferred.error.agent, "file-service")
	assert.ok(deferred.error.tool)
	assert.ok(deferred.error.action)
	assert.equal(workspace.remoteCalls.length, 0)
})

test("persistence: workspace epochs bind all public address-bearing methods", async () => {
	const workspace = new FakeWorkspace(), op = await workspace.commit(), port = new WorkspacePersistencePort(workspace, { adapter })
	const wrong = { ...op.publishedSource.ref, workspaceEpoch: crypto.randomUUID() }
	await assert.rejects(port.captureForTransfer(wrong, op.localGeneration), { status: 409, error: "workspace_changed" })
	await assert.rejects(port.status(wrong), { status: 409, error: "workspace_changed" })
	await assert.rejects(port.applyRemote(remoteChange(workspace, { ref: wrong, applyNow: true }), {}, op.localGeneration), { status: 409, error: "workspace_changed" })
	assert.equal(workspace.remoteCalls.length, 0)
})

test("persistence: drain reports pending/failed/indeterminate work and never becomes a cloud-durability acknowledgement", async (t) => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace, { adapter })
	const op = await workspace.commit()
	await workspace.commit({ path: "failed.txt", state: "failed", persistenceState: "failed" })
	await workspace.commit({ path: "unknown.txt", state: "indeterminate", persistenceState: "indeterminate" })
	let release, entered
	const blocked = new Promise((resolve) => { release = resolve }), started = new Promise((resolve) => { entered = resolve })
	t.after(() => release())
	workspace.applyRemote = async (change) => { entered(); await blocked; return { ...op, operationId: change.operationId, state: "accepted", committedAt: null } }
	const running = port.applyRemote(remoteChange(workspace, { applyNow: true }), {}, op.localGeneration)
	await started
	const drained = await port.drain(new Date(Date.now() + 10).toISOString())
	assert.ok(drained.localPending >= 1)
	assert.ok(drained.remotePending >= 1)
	assert.equal(drained.failed, 1)
	assert.equal(drained.indeterminate, 1)
	assert.equal(drained.complete, false)
	await assert.rejects(port.captureForTransfer(op.publishedSource.ref, op.localGeneration), { status: 503, error: "draining" })
	await assert.rejects(port.applyRemote(remoteChange(workspace, { applyNow: true }), {}, op.localGeneration), { status: 503, error: "draining" })
	release(); await running
	assert.equal((await new WorkspacePersistencePort(new FakeWorkspace()).drain(Date.now())).complete, false)
	await assert.rejects(port.drain("not a timestamp"), { status: 400, error: "invalid_request" })
})

test("persistence: jittered duplicate transfer/acknowledgement and local commits preserve one held source and the newest dirty generation", async () => {
	const workspace = new FakeWorkspace(new MemoryState({ jitter: true })), port = new WorkspacePersistencePort(workspace, { adapter }), old = await workspace.commit()
	const transfers = await Promise.all(Array.from({ length: 24 }, async () => { await wait(Math.floor(Math.random() * 5)); return port.captureForTransfer(old.publishedSource.ref, old.localGeneration) }))
	assert.equal(new Set(transfers.map((transfer) => transfer.holdId)).size, 1)
	assert.equal((await workspace.state.list("holds")).length, 1)
	const result = acknowledgement({ ...transfers[0], ref: transfers[0].source.ref })
	const edits = []
	await Promise.all(Array.from({ length: 24 }, async (_, n) => {
		await wait(Math.floor(Math.random() * 5))
		if (n % 2) edits.push(await workspace.commit({ bytes: `new generation ${n}` }))
		else await port.recordAcknowledgement(result)
	}))
	const latest = edits.sort((a, b) => a.committedAt < b.committedAt ? -1 : 1).at(-1)
	assert.equal((await port.status(old.publishedSource.ref)).localGeneration, latest.localGeneration)
	assert.equal((await port.status(old.publishedSource.ref)).state, "queued")
	assert.equal((await workspace.state.get("operations", latest.operationId)).persistence.state, "queued")
	assert.deepEqual(await workspace.state.list("holds"), [])
	assert.equal(workspace.captures.readers, 0)
})

test("persistence: acknowledgement does not clear a separately pending remote replacement", async () => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace, { adapter }), op = await workspace.commit()
	op.persistence = { ...op.persistence, state: "waiting-for-local-writer", pendingRemoteEtag: "separate pending version", pendingRemoteDetectedAt: "2026-10-01T01:00:00.000Z" }
	await workspace.state.put("operations", op.operationId, op)
	const held = await port.captureForTransfer(op.publishedSource.ref, op.localGeneration)
	await port.recordAcknowledgement(acknowledgement({ ...held, ref: held.source.ref }))
	assert.equal((await port.status(held.source.ref)).state, "waiting-for-local-writer")
	assert.equal((await port.status(held.source.ref)).pendingRemoteEtag, "separate pending version")
	assert.equal((await workspace.state.get("operations", op.operationId)).persistence.state, "waiting-for-local-writer")
})

test("persistence: a lost remote response returns its parent receipt without replacing a later local edit", async () => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace, { adapter }), initial = await workspace.commit()
	const change = remoteChange(workspace), deferred = await port.applyRemote(change, {}, initial.localGeneration)
	assert.equal(deferred.deferred, true)
	const override = { ...change, applyNow: true }, applied = await port.applyRemote(override, {}, initial.localGeneration)
	const newer = await workspace.commit({ bytes: "local edit after replacement" })
	const duplicate = await new WorkspacePersistencePort(workspace, { adapter }).applyRemote(override, {}, initial.localGeneration)
	assert.equal(duplicate.operationId, applied.operationId)
	assert.equal(workspace.remoteCalls.length, 1, "a duplicate must not replay the filesystem effect")
	assert.equal((await port.status(change.ref)).localGeneration, newer.localGeneration)
	assert.equal((await port.status(change.ref)).state, "queued")
})

test("persistence: one destination acknowledgement cannot clean a multi-address move intent", async () => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace, { adapter })
	const op = await workspace.commit({ path: "destination.txt", addresses: [workspace.ref("origin.txt"), workspace.ref("destination.txt")] })
	const transfer = await port.captureForTransfer(op.publishedSource.ref, op.localGeneration)
	await port.recordAcknowledgement(acknowledgement({ ...transfer, ref: transfer.source.ref }))
	assert.equal((await workspace.state.get("operations", op.operationId)).persistence.state, "queued")
	assert.equal((await port.status(workspace.ref("origin.txt"))).state, "queued")
	assert.equal((await port.status(workspace.ref("destination.txt"))).state, "clean")
	assert.equal((await port.drain(Date.now())).remotePending, 1)
})

test("persistence: abort while waiting for the managed lock retains AbortError semantics", async () => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace), controller = new AbortController()
	let release, entered
	const blocked = new Promise((resolve) => { release = resolve }), started = new Promise((resolve) => { entered = resolve })
	const lock = workspace.locks.run(async () => { entered(); await blocked })
	await started
	const reading = collect(port.changesAfter("", { signal: controller.signal }))
	controller.abort(); release(); await lock
	await assert.rejects(reading, { name: "AbortError" })
})

test("persistence: a protected-blob integrity failure persists an indeterminate generation and retains its hold", async () => {
	for (const method of ["captureForTransfer", "recordAcknowledgement"]) {
		const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace, { adapter }), op = await workspace.commit()
		const transfer = await port.captureForTransfer(op.publishedSource.ref, op.localGeneration)
		// This is FileCaptures.privateFile's actual protected-representation error shape.
		workspace.captures.open = async () => { throw new FileError(503, "capture_store_unavailable", "The protected representation changed unexpectedly.", { reason: "integrity", agent: "file-service", tool: "file-captures", action: "Inspect protected storage." }) }
		const work = method === "captureForTransfer" ? port.captureForTransfer(transfer.source.ref, transfer.localGeneration) : port.recordAcknowledgement(acknowledgement({ ...transfer, ref: transfer.source.ref }))
		await assert.rejects(work, { status: 503, error: "capture_store_unavailable", reason: "integrity", state: "indeterminate" })
		assert.equal((await port.status(transfer.source.ref)).state, "indeterminate")
		assert.equal((await workspace.state.get("persistence-transfers", transfer.holdId)).state, "indeterminate")
		assert.ok(await workspace.state.get("holds", transfer.holdId))
	}
})

test("persistence: drain bounds stalled metadata reads and rejects without invented counts", async (t) => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace, { adapter })
	await workspace.commit()
	let release
	const blocked = new Promise((resolve) => { release = resolve }), list = workspace.state.list.bind(workspace.state)
	workspace.state.list = async (kind) => { if (kind === "operations") await blocked; return list(kind) }
	const draining = port.drain(new Date(Date.now() + 10).toISOString())
	t.after(async () => { release(); await draining.catch(() => {}) })
	const outcome = await Promise.race([draining.then((value) => ({ value }), (error) => ({ error })), wait(50).then(() => ({ stillWaiting: true }))])
	assert.equal(outcome.stillWaiting, undefined, "drain must not wait beyond its deadline for state.list")
	assert.equal(outcome.error?.status, 503)
	assert.equal(outcome.error?.error, "drain_timeout")
	assert.equal(outcome.error?.state, "indeterminate")
	assert.match(outcome.error.action, /retain/i)
	assert.equal(outcome.value, undefined, "an unavailable snapshot cannot produce authoritative counts")
})

test("persistence: a held protected file replaced by a directory is indeterminate on acquisition and acknowledgement", async () => {
	for (const method of ["captureForTransfer", "recordAcknowledgement"]) {
		const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace, { adapter }), op = await workspace.commit()
		const transfer = await port.captureForTransfer(op.publishedSource.ref, op.localGeneration)
		workspace.captures.open = async () => { throw new FileError(400, "unsupported_resource", "Only regular files can supply source bytes.", { agent: "file-service", tool: "file-captures", action: "Inspect protected storage." }) }
		const work = method === "captureForTransfer" ? port.captureForTransfer(transfer.source.ref, transfer.localGeneration) : port.recordAcknowledgement(acknowledgement({ ...transfer, ref: transfer.source.ref }))
		await assert.rejects(work, { status: 503, error: "capture_store_unavailable", reason: "integrity", state: "indeterminate" })
		assert.equal((await port.status(transfer.source.ref)).state, "indeterminate")
		assert.equal((await workspace.state.get("persistence-transfers", transfer.holdId)).error.cause.error, "unsupported_resource")
		assert.ok(await workspace.state.get("holds", transfer.holdId))
	}
})

test("persistence: aggregate status includes an unresolved older held generation after Current becomes clean", async () => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace, { adapter }), old = await workspace.commit()
	const oldTransfer = await port.captureForTransfer(old.publishedSource.ref, old.localGeneration)
	const newer = await workspace.commit({ bytes: "newer generation" }), newTransfer = await port.captureForTransfer(newer.publishedSource.ref, newer.localGeneration)
	workspace.captures.bytes.delete(oldTransfer.source.captureId)
	await assert.rejects(port.captureForTransfer(oldTransfer.source.ref, oldTransfer.localGeneration), { state: "indeterminate" })
	await port.recordAcknowledgement(acknowledgement({ ...newTransfer, ref: newTransfer.source.ref }))
	assert.equal((await port.status(newer.publishedSource.ref)).state, "clean", "per-address status describes Current")
	assert.equal((await port.status()).state, "indeterminate", "workspace status cannot hide an unresolved older transfer")
	assert.equal((await port.drain(Date.now())).indeterminate, 1)
})

test("persistence: a mismatching source with a parent-owned hold is indeterminate before transfer admission", async () => {
	const workspace = new FakeWorkspace(), port = new WorkspacePersistencePort(workspace, { adapter }), op = await workspace.commit()
	const holdId = await workspace.captures.hold("capture", op.publishedSource.captureId, "operation-evidence")
	const record = await workspace.state.get("captures", op.publishedSource.captureId)
	await workspace.state.put("captures", record.id, { ...record, source: { ...record.source, ref: workspace.ref("unexpected-address.txt") } })
	await assert.rejects(port.captureForTransfer(op.publishedSource.ref, op.localGeneration), { status: 503, state: "indeterminate" })
	assert.equal((await workspace.state.get("operations", op.operationId)).persistence.state, "indeterminate")
	assert.equal((await port.status(op.publishedSource.ref)).state, "indeterminate")
	assert.ok(await workspace.state.get("holds", holdId), "the parent's evidence hold must remain retained")
	assert.deepEqual(await workspace.state.list("persistence-transfers"), [], "a mismatching source cannot admit a transfer")
	assert.equal(workspace.captures.readers, 0)
	assert.equal(workspace.statCalls, 0)
})
