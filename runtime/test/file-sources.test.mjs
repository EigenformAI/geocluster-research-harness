import assert from "node:assert/strict"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as wait } from "node:timers/promises"
import { test } from "node:test"
import { FileCaptures } from "../lib/file-captures.js"
import { parseSegment } from "../lib/file-segments-worker.js"
import { observation, stableStringify } from "../lib/file-contract.js"

// The trusted bridge is mocked here. Production must provide an actual different-UID process.
const workerUid = process.geteuid() + 10000
const ownership = {
	agentUids: [process.geteuid() + 10001], workerUids: [workerUid],
	workerBridge: { uid: workerUid, async run(input) { return { uid: workerUid, result: input.probe ? null : parseSegment(input) } } },
}
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex")

class MemoryState {
	constructor() { this.records = new Map(); this.claims = new Map(); this.identity = { workspaceId: crypto.randomUUID(), workspaceEpoch: crypto.randomUUID() } }
	key(kind, id) { return `${kind}/${id}` }
	async get(kind, id) { return structuredClone(this.records.get(this.key(kind, id)) ?? null) }
	async put(kind, id, value) { this.records.set(this.key(kind, id), structuredClone(value)); return value }
	async delete(kind, id) { return this.records.delete(this.key(kind, id)) }
	async list(kind) { return [...this.records].filter(([key]) => key.startsWith(`${kind}/`)).map(([, value]) => structuredClone(value)) }
	// Fault injection can leave a prefix of metadata effects. This is not SQLite atomicity evidence.
	failTransaction(after, when) { this.transactionFault = { after, when } }
	async transaction(ops) {
		const fault = this.transactionFault?.when(ops) ? this.transactionFault : null
		if (fault) this.transactionFault = null
		for (let index = 0; index <= ops.length; index++) {
			if (fault && index === fault.after) throw Object.assign(new Error("injected metadata receipt crash"), { code: "EIO" })
			if (index === ops.length) break
			const op = ops[index]
			if (op.type === "put") await this.put(op.kind, op.id, op.value); else await this.delete(op.kind, op.id)
		}
	}
	async claim(kind, id, intent, record) {
		const key = this.key(kind, id), prior = this.claims.get(key)
		if (prior) {
			if (prior.intent !== stableStringify(intent)) throw Object.assign(new Error("Different intent"), { status: 409, error: "request_id_reused" })
			return { duplicate: true, record: await this.get(kind, id) ?? prior.record }
		}
		this.claims.set(key, { intent: stableStringify(intent), record }); await this.put(kind, id, record)
		return { duplicate: false, record }
	}
}

async function fixture(t, options = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-sources-")), root = path.join(dir, "workspace"), storeDir = path.join(dir, "private")
	await fs.mkdir(root)
	const state = new MemoryState(), events = [], reads = []
	const safeFs = {
		async open(name) {
			const handle = await fs.open(path.join(root, name), "r")
			return { fd: handle.fd, stat: () => handle.stat({ bigint: true }), close: () => handle.close(), createReadStream: (...args) => handle.createReadStream(...args), async read(buffer, offset, length, position) {
				if (options.delay) await wait(options.delay)
				const result = await handle.read(buffer, offset, Math.min(length, options.chunkBytes || length), position)
				reads.push(result.bytesRead)
				if (options.onRead) await options.onRead({ root, position, result })
				return result
			} }
		},
		stat: (name) => fs.stat(path.join(root, name), { bigint: true }),
		async probe() { return { reflink: false, noReplace: true } },
		async clone() { return false },
		async checkOwnership() { return { ok: true } },
	}
	const captures = new FileCaptures({ safeFs, state, storeDir, ref: (name) => ({ ...state.identity, path: name }), limits: options.limits, ownership: options.ownership ?? ownership, onEvent: (type, payload) => events.push({ type, payload }) })
	await captures.init()
	t.after(async () => { await captures.close(); await fs.rm(dir, { recursive: true, force: true }) })
	return { dir, root, storeDir, state, safeFs, captures, reads, events }
}

test("sources: protected capture is a separate inode, survives source rewrites, and binds request intent", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "a.txt"), "hello 🌍\n")
	const created = await f.captures.create({ requestId: "capture-1", path: "a.txt", computeDigest: true })
	assert.equal(created.status, 201)
	assert.equal(created.source.consistency, "checked-copy")
	assert.deepEqual(created.source.digest, { state: "ready", sha256: digest("hello 🌍\n") })
	assert.equal(created.lease.source.id, created.source.captureId)
	const opened = await f.captures.open("capture", created.source.captureId)
	assert.notEqual((await opened.handle.stat({ bigint: true })).ino, (await fs.stat(path.join(f.root, "a.txt"), { bigint: true })).ino)
	await opened.release()
	await fs.writeFile(path.join(f.root, "a.txt"), "changed bytes")
	assert.equal((await f.captures.text("capture", created.source.captureId, {})).text, "hello 🌍\n")
	const duplicate = await f.captures.create({ requestId: "capture-1", path: "a.txt", computeDigest: true })
	assert.equal(duplicate.source.captureId, created.source.captureId)
	await assert.rejects(f.captures.create({ requestId: "capture-1", path: "other.txt", computeDigest: true }), { status: 409, error: "request_id_reused" })
	assert.equal((await f.captures.getRequest("capture-1")).state, "succeeded")
})

test("sources: failed ownership cannot be overridden and unknown parser identity is disabled", async (t) => {
	const f = await fixture(t, { ownership: { ...ownership, agentUids: [process.geteuid()], available: true } })
	assert.deepEqual(f.captures.availability, { state: "unavailable", reason: "ownership" })
	await assert.rejects(f.captures.create({ requestId: "unsafe", path: "x" }), { status: 503, error: "capture_store_unavailable" })
	const g = await fixture(t, { ownership: { agentUids: ownership.agentUids, workerUids: ownership.workerUids } })
	await fs.writeFile(path.join(g.root, "x.txt"), "safe bytes")
	assert.equal((await g.captures.create({ requestId: "safe", path: "x.txt" })).status, 201)
	await assert.rejects(g.captures.preview({ path: "x.txt", format: "text" }), { status: 503, error: "worker_unavailable" })
})

test("sources: coherent-only fails once without a real clone and checked-copy retries stop after three attempts", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "x"), "bytes")
	await assert.rejects(f.captures.create({ requestId: "coherent", path: "x", requireCoherentSource: true }), { status: 409, error: "coherent_source_unavailable" })
	const reads = f.reads.length
	await assert.rejects(f.captures.create({ requestId: "coherent", path: "x", requireCoherentSource: true }), { status: 409, error: "coherent_source_unavailable" })
	assert.equal(f.reads.length, reads)
	const before = observation({ ...f.state.identity, path: "x" }, await f.safeFs.stat("x"))
	await fs.writeFile(path.join(f.root, "x"), "new bytes")
	await assert.rejects(f.captures.create({ requestId: "stale", path: "x", baseObservation: before }), { status: 409, error: "source_changed" })
	let changes = 0
	const g = await fixture(t, { onRead: async ({ root, result }) => { if (result.bytesRead) { changes++; await fs.appendFile(path.join(root, "x"), "!") } } })
	await fs.writeFile(path.join(g.root, "x"), "unstable")
	await assert.rejects(g.captures.create({ requestId: "changing", path: "x" }), { status: 409, error: "source_changing" })
	assert.equal(changes, 3)
})

test("sources: leases, durable holds and an active reader protect bytes from eviction", async (t) => {
	const f = await fixture(t, { limits: { previewIdleMs: 0, previewBytes: 1 } })
	await fs.writeFile(path.join(f.root, "x"), "retained")
	const created = await f.captures.create({ requestId: "retention", path: "x" }), id = created.source.captureId
	await f.captures.sweep()
	assert.equal((await f.captures.get("capture", id)).source.captureId, id)
	await f.captures.releaseLease(created.lease.leaseId)
	const holdId = await f.captures.hold("capture", id, "sync", "outbox-hold")
	const reopened = new FileCaptures({ safeFs: f.safeFs, state: f.state, storeDir: f.storeDir, ref: (name) => ({ ...f.state.identity, path: name }), ownership, limits: { previewIdleMs: 0, previewBytes: 1 } })
	await reopened.init(); t.after(() => reopened.close())
	await reopened.sweep()
	const opened = await reopened.open("capture", id)
	await reopened.releaseHold(holdId)
	await reopened.sweep()
	assert.equal((await opened.handle.readFile()).toString(), "retained")
	await opened.release(); await reopened.sweep()
	await assert.rejects(reopened.get("capture", id), { status: 410, error: "capture_expired" })
})

test("sources: bounded first CSV view retains complete multiline records and distinguishes fragment end from EOF", async (t) => {
	const f = await fixture(t, { chunkBytes: 1 })
	const data = 'h,v\n1,"α\nβ"\n2,last\n' + "x,y\n".repeat(100000)
	await fs.writeFile(path.join(f.root, "x.csv"), data)
	const result = await f.captures.preview({ path: "x.csv", format: "csv", rowLimit: 2, readBytes: 128 })
	assert.equal(result.coverage, "fragment")
	assert.equal(result.source.kind, "runtime-fragment")
	assert.equal(result.source.completeSource, false)
	assert.deepEqual(result.rows.map((row) => row.cells.map((cell) => cell.text)), [["h", "v"], ["1", "α\nβ"]])
	assert.ok(f.reads.reduce((a, b) => a + b, 0) <= 128)
	assert.equal((await f.state.list("captures")).length, 0)
	assert.equal(result.eof, false)
	assert.equal(result.next, null)
	assert.equal(result.stopReason, "fragment-end")
	assert.deepEqual(result.continuation, { kind: "capture-required" })
	const again = await f.captures.segments("fragment", result.source.fragmentId, { format: "csv", rowLimit: 10 })
	assert.deepEqual(again.rows.map((row) => row.cells.map((cell) => cell.text)), [["h", "v"], ["1", "α\nβ"]])
	assert.equal(again.eof, false)
	assert.equal(again.stopReason, "fragment-end")
})

test("sources: source-bound cursors, clipped detail, and UTF-8 text prefixes preserve exact bytes", async (t) => {
	const f = await fixture(t, { limits: { cellCodePoints: 3, textWindowBytes: 8 } })
	await fs.writeFile(path.join(f.root, "x.csv"), 'a,"🌍🌍🌍🌍,long"\r\nb,z\n')
	const { source } = await f.captures.create({ requestId: "csv", path: "x.csv" })
	const first = await f.captures.segments("capture", source.captureId, { format: "csv", rowLimit: 1 })
	assert.equal(first.rows[0].cells[1].text, "🌍🌍🌍")
	assert.equal(first.rows[0].cells[1].clipped, true)
	const detail = await f.captures.segments("capture", source.captureId, { format: "csv", operation: "detail", cursor: first.rows[0].cells[1].detail, responseBytes: 4096 })
	assert.equal(detail.kind, "cell-detail")
	assert.equal(detail.text, "🌍🌍")
	assert.equal(detail.eof, false)
	assert.ok(detail.next)
	const next = await f.captures.segments("capture", source.captureId, { format: "csv", cursor: first.next })
	assert.equal(next.rows[0].ordinal, 2)
	assert.equal(next.eof, true)
	await assert.rejects(f.captures.segments("capture", source.captureId, { format: "tsv", cursor: first.next }), { status: 400, error: "invalid_cursor" })
	const other = await f.captures.create({ requestId: "other", path: "x.csv" })
	await assert.rejects(f.captures.segments("capture", other.source.captureId, { format: "csv", cursor: first.next }), { status: 400, error: "invalid_cursor" })
	await fs.writeFile(path.join(f.root, "utf8.txt"), "a🌍b")
	const utf8 = await f.captures.create({ requestId: "utf8", path: "utf8.txt" })
	const prefix = await f.captures.text("capture", utf8.source.captureId, { maxBytes: 3 })
	assert.equal(prefix.text, "a")
	assert.equal(prefix.byteEnd, 1)
	assert.equal(prefix.complete, false)
})

test("sources: a large accepted job is cancellable, preserves its request receipt, and never publishes partial bytes", async (t) => {
	const f = await fixture(t, { delay: 5, limits: { captureInlineBytes: 1 } })
	await fs.writeFile(path.join(f.root, "x.bin"), Buffer.alloc(2 * 1024 * 1024, 0x61))
	const accepted = await f.captures.create({ requestId: "large", path: "x.bin", computeDigest: true })
	assert.equal(accepted.status, 202)
	assert.ok(accepted.jobId)
	await f.captures.cancelJob(accepted.jobId)
	const drained = await f.captures.drain(new Date(Date.now() + 5000).toISOString())
	assert.equal(drained.localPending, 0)
	assert.equal((await f.captures.getJob(accepted.jobId)).state, "cancelled")
	assert.equal((await f.captures.getRequest("large")).state, "cancelled")
	assert.equal((await f.state.list("captures")).length, 0)
	assert.equal((await f.state.list("holds")).length, 0)
})

test("sources: a fragment with an incomplete trailing record ends explicitly without a false continuation", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "x.csv"), "a,b\nincomplete,record\n")
	const first = await f.captures.preview({ path: "x.csv", format: "csv", readBytes: 7 })
	assert.deepEqual(first.rows.map((row) => row.ordinal), [1])
	assert.equal(first.stopReason, "fragment-end")
	assert.equal(first.next, null)
	assert.equal(first.eof, false)
	assert.deepEqual(first.continuation, { kind: "capture-required" })
	const again = await f.captures.segments("fragment", first.source.fragmentId, { format: "csv" })
	assert.equal(again.stopReason, "fragment-end")
	assert.equal(again.next, null)
})

test("sources: staged retention shares the single active copy slot with capture jobs", async (t) => {
	let release, entered
	t.after(() => release?.())
	const f = await fixture(t, { limits: { captureInlineBytes: 1 } })
	await fs.writeFile(path.join(f.root, "x"), "copy-slot")
	const blocked = new Promise((resolve) => { release = resolve }), started = new Promise((resolve) => { entered = resolve })
	f.safeFs.clone = async () => { entered(); await blocked; return false }
	const accepted = await f.captures.create({ requestId: "slot", path: "x" })
	await started
	let finished = false
	const retained = f.captures.retainStaged(path.join(f.root, "x"), { ...f.state.identity, path: "x" }, { consistency: "service-published" }).then((result) => { finished = true; return result })
	await wait(20)
	const ranConcurrently = finished
	release()
	await retained; await f.captures.drain(new Date(Date.now() + 5000).toISOString())
	assert.equal(ranConcurrently, false, "another whole-file copy must wait for the occupied slot")
	assert.equal((await f.captures.getJob(accepted.jobId)).state, "succeeded")
})

test("sources: staged publication checks digest and reuses only the matching current observation", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "x"), "published")
	const ref = { ...f.state.identity, path: "x" }
	await assert.rejects(f.captures.retainStaged(path.join(f.root, "x"), ref, { digest: "0".repeat(64) }), { status: 422, error: "digest_mismatch" })
	const retained = await f.captures.retainStaged(path.join(f.root, "x"), ref, { digest: digest("published"), hold: { reason: "sync", id: "generation-1" } })
	assert.equal(retained.holdId, "generation-1")
	const reused = await f.captures.create({ requestId: "published", path: "x", requireCoherentSource: true, computeDigest: true })
	assert.equal(reused.source.captureId, retained.source.captureId)
	await fs.writeFile(path.join(f.root, "x"), "later bytes")
	await assert.rejects(f.captures.create({ requestId: "changed-published", path: "x", requireCoherentSource: true }), { status: 409, error: "coherent_source_unavailable" })
	assert.equal((await f.captures.text("capture", retained.source.captureId, {})).text, "published")
})

test("sources: actual clone success admits coherent bytes; a probe flag alone never does", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "x"), "clone bytes")
	f.safeFs.probe = async () => ({ reflink: true, noReplace: true })
	await assert.rejects(f.captures.create({ requestId: "probe-only", path: "x", requireCoherentSource: true }), { error: "coherent_source_unavailable" })
	// The native clone effect is mocked, not claimed to be an actual reflink on this test filesystem.
	f.safeFs.clone = async (sourceFd, targetFd) => { await fs.writeFile(`/proc/self/fd/${targetFd}`, await fs.readFile(`/proc/self/fd/${sourceFd}`)); return true }
	const result = await f.captures.create({ requestId: "real-result", path: "x", requireCoherentSource: true, computeDigest: true })
	assert.equal(result.source.consistency, "atomic-clone")
	assert.equal(result.source.digest.sha256, digest("clone bytes"))
	assert.equal((await f.captures.text("capture", result.source.captureId, {})).text, "clone bytes")
	assert.equal(f.reads.length, 0, "coherent clone must not fall back to a source stream copy")
})

test("sources: jittered admission is bounded to one copy and sixteen waiting jobs", async (t) => {
	const f = await fixture(t, { delay: 10, limits: { captureInlineBytes: 1 } })
	await fs.writeFile(path.join(f.root, "x"), Buffer.alloc(2 * 1024 * 1024, 0x61))
	const results = await Promise.all(Array.from({ length: 24 }, async (_, n) => {
		await wait(Math.floor(Math.random() * 6))
		try { return await f.captures.create({ requestId: `capacity-${n}`, path: "x" }) } catch (error) { return error }
	}))
	const accepted = results.filter((result) => result.status === 202), refused = results.filter((result) => result.status === 429)
	assert.equal(accepted.length, 17)
	assert.equal(refused.length, 7)
	assert.ok(refused.every((error) => error.error === "capacity" && error.retryAfter === 1))
	await Promise.all(accepted.map((result) => f.captures.cancelJob(result.jobId)))
	await f.captures.drain(new Date(Date.now() + 5000).toISOString())
	assert.ok((await f.state.list("jobs")).every((job) => job.state === "cancelled"))
	assert.equal((await f.state.list("captures")).length, 0)
})

test("sources: every-byte CSV/UTF-8 cuts keep complete logical records, and malformed input is explicit", () => {
	const bytes = Buffer.from('h,v\r\n\n1,"α🌍\nβ"\r\n2,"escaped ""quote"""\n')
	const limits = { rowLimit: 100, columnOffset: 0, columnLimit: 20, readBytes: 1024, responseBytes: 16384, timeMs: 2000, textBytes: 1024, displayCodepoints: 512 }
	for (let cut = 0; cut <= bytes.length; cut++) {
		const parsed = parseSegment({ bytes: bytes.subarray(0, cut), format: "csv", limits, sourceEof: cut === bytes.length })
		assert.ok(parsed.rows.every((row) => row.cells.every((cell) => !cell.text.includes("�"))))
		assert.ok(parsed.rows.length <= 4)
		assert.equal(parsed.eof, cut === bytes.length)
		if (parsed.rows.length >= 3) assert.equal(parsed.rows[2].cells[1].text, "α🌍\nβ")
	}
	const complete = parseSegment({ bytes, format: "csv", limits, sourceEof: true })
	assert.deepEqual(complete.rows.map((row) => row.ordinal), [1, 2, 3, 4])
	assert.equal(complete.rows[1].blank, true)
	assert.equal(complete.rows[3].cells[1].text, 'escaped "quote"')
	assert.equal(parseSegment({ bytes: Buffer.from('x,"unfinished'), format: "csv", limits, sourceEof: true }).stopReason, "malformed-record")
	assert.equal(parseSegment({ bytes: Buffer.from([0x61, 0x2c, 0xff, 0x0a]), format: "csv", limits, sourceEof: true }).stopReason, "encoding-unavailable")
})

test("sources: parser timeout is a work-budget outcome, not EOF or an unbounded continuation", async (t) => {
	const f = await fixture(t, { limits: { elapsedMs: 40 }, ownership: { ...ownership, workerBridge: { uid: workerUid, async run(input, { signal } = {}) {
		if (input.probe) return { uid: workerUid, result: null }
		await wait(100, undefined, { signal })
		return { uid: workerUid, result: parseSegment(input) }
	} } } })
	await fs.writeFile(path.join(f.root, "x.csv"), "a,b\n1,2\n")
	const result = await f.captures.preview({ path: "x.csv", format: "csv" })
	assert.equal(result.stopReason, "time-budget")
	assert.equal(result.eof, false)
	assert.equal(result.next, null)
	assert.deepEqual(result.rows, [])
})

test("sources: changed live EOF is never promoted to checked fragment EOF", async (t) => {
	let rewritten = false
	const f = await fixture(t, { onRead: async ({ root }) => { if (!rewritten) { rewritten = true; await fs.appendFile(path.join(root, "x.csv"), "more\n") } } })
	await fs.writeFile(path.join(f.root, "x.csv"), "a,b\nunterminated")
	const result = await f.captures.preview({ path: "x.csv", format: "csv" })
	assert.equal(result.source.sourceMayHaveChanged, true)
	assert.equal(result.source.sourceEof, false)
	assert.equal(result.eof, false)
	assert.deepEqual(result.rows.map((row) => row.cells.map((cell) => cell.text)), [["a", "b"]])
	assert.equal(result.stopReason, "fragment-end")
})

test("sources: missing held bytes report indeterminate transfer evidence rather than rebinding or expiring", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "x"), "old transfer generation")
	const result = await f.captures.create({ requestId: "transfer", path: "x" })
	await f.captures.hold("capture", result.source.captureId, "sync")
	await fs.unlink(path.join(f.storeDir, "blobs", `capture.${result.source.captureId}`))
	await fs.writeFile(path.join(f.root, "x"), "new current")
	await assert.rejects(f.captures.open("capture", result.source.captureId), { status: 503, error: "transfer_source_missing", state: "indeterminate" })
})

test("sources: a same-UID worker reply cannot enable parsing", async (t) => {
	const f = await fixture(t, { ownership: { ...ownership, workerBridge: { uid: workerUid, async run() { return { uid: process.geteuid(), result: null } } } } })
	await fs.writeFile(path.join(f.root, "x"), "bytes")
	await assert.rejects(f.captures.preview({ path: "x", format: "text" }), { status: 503, error: "worker_unavailable" })
	assert.equal((await f.captures.create({ requestId: "bytes-without-parser", path: "x" })).status, 201)
})

test("sources: a lost metadata acknowledgement cannot delete already held protected bytes", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "x"), "commit evidence")
	const transaction = f.state.transaction.bind(f.state)
	f.state.transaction = async (operations) => {
		await transaction(operations)
		if (operations.some((op) => op.kind === "captures")) throw Object.assign(new Error("lost SQLite acknowledgement"), { code: "EIO" })
	}
	await assert.rejects(f.captures.retainStaged(path.join(f.root, "x"), { ...f.state.identity, path: "x" }, { hold: "sync" }), { status: 503, error: "storage_unavailable", state: "indeterminate" })
	const [record] = await f.state.list("captures")
	assert.ok(record)
	assert.equal((await f.captures.text("capture", record.id, {})).text, "commit evidence")
	assert.equal((await f.state.list("holds")).length, 1)
})

test("sources: base-observation intent binds the token rather than the observation timestamp or envelope", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "x"), "observed")
	const base = observation({ ...f.state.identity, path: "x" }, await f.safeFs.stat("x"))
	const first = await f.captures.create({ requestId: "normalized", path: "x", baseObservation: base })
	const duplicate = await f.captures.create({ requestId: "normalized", path: "x", baseObservation: base.token })
	assert.equal(duplicate.source.captureId, first.source.captureId)
})

test("sources: coherent published bytes can acquire a digest without copying the mutable pathname again", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "x"), "hash protected published bytes")
	const retained = await f.captures.retainStaged(path.join(f.root, "x"), { ...f.state.identity, path: "x" })
	assert.equal(retained.source.digest.state, "not-requested")
	const result = await f.captures.create({ requestId: "digest-existing", path: "x", requireCoherentSource: true, computeDigest: true })
	assert.equal(result.source.captureId, retained.source.captureId)
	assert.deepEqual(result.source.digest, { state: "ready", sha256: digest("hash protected published bytes") })
	assert.equal(f.reads.length, 0)
	assert.equal((await f.state.list("holds")).length, 0)
})

test("sources: a queued hash acquires its durable hold before execution and releases it only after cancellation is recorded", async (t) => {
	let release
	t.after(() => release?.())
	const f = await fixture(t, { limits: { captureInlineBytes: 1, previewIdleMs: 0, previewBytes: 1 } })
	await fs.writeFile(path.join(f.root, "published"), "protected hash input")
	await fs.writeFile(path.join(f.root, "busy"), "occupy copy slot")
	const retained = await f.captures.retainStaged(path.join(f.root, "published"), { ...f.state.identity, path: "published" })
	let entered
	const busy = new Promise((resolve) => { entered = resolve }), blocked = new Promise((resolve) => { release = resolve })
	f.safeFs.clone = async () => { entered(); await blocked; return false }
	const copying = await f.captures.create({ requestId: "busy", path: "busy" })
	await busy
	const hashing = await f.captures.create({ requestId: "queued-hash", path: "published", computeDigest: true, requireCoherentSource: true })
	assert.equal(hashing.status, 202)
	assert.equal(hashing.source.captureId, retained.source.captureId)
	assert.equal(hashing.source.digest.state, "pending")
	await f.captures.releaseLease(retained.lease.leaseId)
	await f.captures.releaseLease(hashing.lease.leaseId)
	await f.captures.sweep()
	assert.equal((await f.captures.get("capture", retained.source.captureId)).source.digest.state, "pending")
	assert.equal((await f.state.list("holds")).length, 1)
	await f.captures.cancelJob(hashing.jobId)
	assert.equal((await f.state.list("holds")).length, 1, "cancel_requested is not a terminal outcome")
	await f.captures.cancelJob(copying.jobId); release()
	await f.captures.drain(new Date(Date.now() + 5000).toISOString())
	assert.equal((await f.captures.getJob(hashing.jobId)).state, "cancelled")
	assert.equal((await f.captures.get("capture", retained.source.captureId)).source.digest.state, "failed")
	assert.equal((await f.state.list("holds")).length, 0)
})

test("sources: captured text uses the frontend text/encoding wire envelope and remains a labelled prefix", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "x"), "hello 🌍")
	const created = await f.captures.create({ requestId: "editor", path: "x" })
	const full = await f.captures.text("capture", created.source.captureId, {})
	assert.equal(full.text, "hello 🌍")
	assert.equal(full.binary, false)
	assert.equal(full.encoding, "utf-8")
	assert.equal(full.complete, true)
	const prefix = await f.captures.text("capture", created.source.captureId, { maxBytes: 8 })
	assert.equal(prefix.text, "hello ")
	assert.equal(prefix.byteEnd, 6)
	assert.equal(prefix.complete, false)
	assert.equal(prefix.stable, true)
})

test("sources: CSV BOM precedes quoted fields and the parser itself enforces the read budget", () => {
	const limits = { rowLimit: 100, columnOffset: 0, columnLimit: 20, readBytes: 5, responseBytes: 16384, timeMs: 2000, textBytes: 1024, displayCodepoints: 512 }
	const bounded = parseSegment({ bytes: Buffer.from("a,b\nc,d\n"), format: "csv", limits, sourceEof: true })
	assert.equal(bounded.metrics.bytesRead, 5)
	assert.deepEqual(bounded.rows.map((row) => row.cells.map((cell) => cell.text)), [["a", "b"]])
	assert.equal(bounded.eof, false)
	const bom = parseSegment({ bytes: Buffer.from('\ufeff"header",value\n'), format: "csv", limits: { ...limits, readBytes: 1024 }, sourceEof: true })
	assert.deepEqual(bom.rows[0].cells.map((cell) => cell.text), ["header", "value"])
})

test("sources: preview admission bounds reader allocations before any parser has begun", async (t) => {
	const f = await fixture(t, { delay: 2, chunkBytes: 1 })
	await fs.writeFile(path.join(f.root, "x.csv"), "a,b\n1,2\n")
	const results = await Promise.allSettled(Array.from({ length: 5 }, () => f.captures.preview({ path: "x.csv", format: "csv", rowLimit: 1 })))
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
	assert.ok(results.filter((result) => result.status === "rejected").every((result) => result.reason.status === 429 && result.reason.error === "capacity"))
	assert.equal((await f.captures.preview({ path: "x.csv", format: "csv" })).source.sourceEof, true)
})

test("sources: restart terminalizes a request interrupted between intent claim and job admission", async (t) => {
	const f = await fixture(t)
	const intent = { type: "capture", path: "x", baseObservation: null, requireCoherentSource: false, computeDigest: false }
	await f.state.claim("requests", "half-admitted", intent, { requestId: "half-admitted", type: "capture", intent, state: "accepted", jobId: "missing-job", result: null })
	const reopened = new FileCaptures({ safeFs: f.safeFs, state: f.state, storeDir: f.storeDir, ownership })
	await reopened.init(); t.after(() => reopened.close())
	assert.equal((await reopened.getRequest("half-admitted")).state, "interrupted")
	await assert.rejects(reopened.create({ requestId: "half-admitted", path: "x" }), { status: 503, error: "job_interrupted" })
	assert.equal(f.reads.length, 0)
})

test("sources: the child parser protocol accepts bounded bytes and reports its actual Unix UID", async () => {
	const worker = spawn(process.execPath, [new URL("../lib/file-segments-worker.js", import.meta.url).pathname], { stdio: ["pipe", "pipe", "pipe"] })
	let stdout = "", stderr = ""
	worker.stdout.setEncoding("utf8"); worker.stderr.setEncoding("utf8")
	worker.stdout.on("data", (data) => { stdout += data }); worker.stderr.on("data", (data) => { stderr += data })
	const done = new Promise((resolve, reject) => { worker.on("error", reject); worker.on("close", resolve) })
	const bytes = Buffer.from('a,"α\nβ"\n'), limits = { rowLimit: 100, columnOffset: 0, columnLimit: 20, readBytes: 1024, responseBytes: 16384, timeMs: 2000, textBytes: 1024, displayCodepoints: 512 }
	worker.stdin.write(`${JSON.stringify({ format: "csv", limits, sourceEof: true, byteLength: bytes.length })}\n`); worker.stdin.end(bytes)
	assert.equal(await done, 0, stderr)
	const [ready, reply] = stdout.trim().split("\n").map((line) => JSON.parse(line))
	assert.equal(ready.uid, process.geteuid())
	assert.equal(reply.uid, process.geteuid())
	assert.deepEqual(reply.result.rows[0].cells.map((cell) => cell.text), ["a", "α\nβ"])
})

test("sources: a real launcher that leaves the parser under the service UID remains disabled", async (t) => {
	const f = await fixture(t, { ownership: { ...ownership, workerBridge: { uid: workerUid, command: "/usr/bin/env", args: [] } } })
	assert.equal(f.captures.parser.availability.state, "unavailable")
	await assert.rejects(f.captures.preview({ path: "x", format: "text" }), { status: 503, error: "worker_unavailable" })
	assert.equal(f.reads.length, 0)
})

test("sources: an indeterminate terminal receipt remains an error on duplicate submission even when candidate bytes exist", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "x"), "published candidate")
	const transaction = f.state.transaction.bind(f.state)
	f.state.transaction = async (operations) => {
		await transaction(operations)
		if (operations.some((op) => op.kind === "jobs" && op.value?.state === "succeeded")) throw Object.assign(new Error("terminal receipt acknowledgement lost"), { code: "EIO" })
	}
	const request = { requestId: "uncertain-receipt", path: "x" }
	await assert.rejects(f.captures.create(request), { status: 503, error: "storage_unavailable", state: "indeterminate" })
	const reads = f.reads.length
	await assert.rejects(f.captures.create(request), { status: 503, error: "storage_unavailable", state: "indeterminate" })
	assert.equal(f.reads.length, reads)
	assert.equal((await f.captures.getRequest(request.requestId)).state, "failed")
	assert.equal((await f.captures.drain(new Date(Date.now() + 5000).toISOString())).indeterminate, 1)
})

test("sources: text and cell detail stop at the serialized response budget even for heavily escaped values", async (t) => {
	const f = await fixture(t), value = '\\"'.repeat(5000)
	await fs.writeFile(path.join(f.root, "x.txt"), value)
	const created = await f.captures.create({ requestId: "escaped-text", path: "x.txt" })
	const text = await f.captures.segments("capture", created.source.captureId, { format: "text", responseBytes: 4096 })
	assert.equal(text.stopReason, "response-budget")
	assert.equal(text.eof, false)
	assert.ok(text.next)
	assert.equal(text.metrics.responseBytes, Buffer.byteLength(JSON.stringify(text)))
	assert.ok(text.metrics.responseBytes <= 4096)
	assert.ok(value.startsWith(text.excerpt.text))
	await fs.writeFile(path.join(f.root, "x.csv"), `a,"${value.replace(/"/g, '""')}"\n`)
	const csv = await f.captures.create({ requestId: "escaped-cell", path: "x.csv" })
	const page = await f.captures.segments("capture", csv.source.captureId, { format: "csv" })
	const detail = await f.captures.segments("capture", csv.source.captureId, { format: "csv", operation: "detail", cursor: page.rows[0].cells[1].detail, responseBytes: 4096 })
	assert.equal(detail.stopReason, "response-budget")
	assert.equal(detail.eof, false)
	assert.ok(detail.next)
	assert.ok(detail.metrics.responseBytes <= 4096)
	assert.equal(detail.valueEnd, [...detail.text].length)
})

async function restartCaptures(t, f, limits = {}) {
	await f.captures.close()
	const next = new FileCaptures({ safeFs: f.safeFs, state: f.state, storeDir: f.storeDir, ownership, limits })
	await next.init(); t.after(() => next.close())
	assert.equal(next.availability.state, "available", JSON.stringify(next.startupError))
	return next
}

async function stagedPublication(f, { kind = "capture", bytes = "retained candidate", hold = true } = {}) {
	const id = crypto.randomUUID(), stage = await f.captures.staging(id), ref = { ...f.state.identity, path: "x" }
	await stage.handle.writeFile(bytes); await stage.handle.chmod(0o400); await stage.handle.sync()
	const stat = await stage.handle.stat({ bigint: true }), createdAt = new Date().toISOString()
	const source = kind === "capture" ? { kind: "runtime-capture", ref, captureId: id, etag: `"capture-${id}"`, sizeBytes: Buffer.byteLength(bytes), consistency: "checked-copy", digest: { state: "not-requested", sha256: null } } : {
		kind: "runtime-fragment", ref, fragmentId: id, etag: `"fragment-${id}"`, byteStart: 0, byteEnd: Buffer.byteLength(bytes), sourceSizeObserved: Buffer.byteLength(bytes), sourceObservation: observation(ref, stat), sourceMayHaveChanged: false, sourceEof: true, completeSource: false,
	}
	const record = { id, kind, source, sizeBytes: Buffer.byteLength(bytes), sourceObservation: null, createdAt, lastAccessAt: createdAt }
	const lease = f.captures.makeLease(kind, id), holdId = crypto.randomUUID()
	const metadataOperations = [{ type: "put", kind: kind === "capture" ? "captures" : "fragments", id, value: record }, { type: "put", kind: "leases", id: lease.leaseId, value: lease }]
	if (hold) metadataOperations.push({ type: "put", kind: "holds", id: holdId, value: { holdId, source: { kind, id }, reason: "sync", createdAt } })
	const publication = { id, kind, source, sizeBytes: record.sizeBytes, state: "publishing", stagingBasename: path.basename(stage.name), candidate: { dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs) }, metadataOperations, lease, holdId: hold ? holdId : null, jobId: null, createdAt }
	await f.state.put("source-publications", id, publication)
	await stage.handle.close(); stage.handle = null
	return { publication, stage, bytes, final: path.join(f.storeDir, "blobs", `${kind}.${id}`) }
}

test("recovery: final inode restores exact metadata and durable holds after partial receipt effects without replaying a job", async (t) => {
	for (const after of [0, 1, 2]) {
		const f = await fixture(t)
		await fs.writeFile(path.join(f.root, "x"), "original bytes")
		f.state.failTransaction(after, (ops) => ops.some((op) => op.kind === "captures"))
		await assert.rejects(f.captures.retainStaged(path.join(f.root, "x"), { ...f.state.identity, path: "x" }, { hold: { id: "outbox", reason: "sync" } }), { state: "indeterminate" })
		const [publication] = await f.state.list("source-publications"), [job] = await f.state.list("jobs")
		await f.state.put("jobs", job.jobId, { ...job, state: "running", error: null })
		await fs.writeFile(path.join(f.root, "x"), "new current bytes")
		const next = await restartCaptures(t, f, { previewIdleMs: 0, previewBytes: 1 })
		assert.equal((await next.text("capture", publication.id, {})).text, "original bytes")
		assert.equal((await next.get("capture", publication.id)).source.captureId, publication.id)
		assert.equal((await f.state.get("holds", "outbox")).source.id, publication.id)
		assert.equal((await f.state.get("source-publications", publication.id)).state, "committed")
		assert.equal((await next.getJob(job.jobId)).state, "interrupted")
		await next.sweep()
		assert.equal((await next.text("capture", publication.id, {})).text, "original bytes")
	}
})

test("recovery: an expected staging inode is aborted durably before cleanup and is never reported expired before proof", async (t) => {
	const f = await fixture(t), pending = await stagedPublication(f)
	await assert.rejects(f.captures.get("capture", pending.publication.id), { status: 503, state: "indeterminate" })
	let sawAbortBeforeCleanup = false
	const put = f.state.put.bind(f.state)
	f.state.put = async (kind, id, value) => {
		if (kind === "source-publications" && value.state === "aborted-before-publication" && value.cleanupPending) { assert.equal(await fs.readFile(pending.stage.name, "utf8"), pending.bytes); sawAbortBeforeCleanup = true }
		return put(kind, id, value)
	}
	const next = await restartCaptures(t, f)
	assert.equal(sawAbortBeforeCleanup, true)
	assert.equal((await f.state.get("source-publications", pending.publication.id)).state, "aborted-before-publication")
	await assert.rejects(fs.stat(pending.stage.name), { code: "ENOENT" })
	await assert.rejects(next.get("capture", pending.publication.id), { status: 410, error: "capture_expired" })
})

test("recovery: missing or mismatched evidence remains indeterminate and cannot rebind or expire", async (t) => {
	for (const mismatch of [false, true]) {
		const f = await fixture(t), pending = await stagedPublication(f)
		if (mismatch) { await fs.rename(pending.stage.name, `${pending.stage.name}.saved`); await fs.writeFile(pending.stage.name, "unrelated inode", { mode: 0o400 }) }
		else await fs.unlink(pending.stage.name)
		const next = await restartCaptures(t, f, { previewIdleMs: 0, previewBytes: 1 })
		await assert.rejects(next.get("capture", pending.publication.id), { status: 503, state: "indeterminate", inspectionRef: `blobs/${pending.publication.stagingBasename}` })
		await next.sweep()
		assert.equal((await f.state.get("source-publications", pending.publication.id)).state, "indeterminate")
		if (mismatch) assert.equal(await fs.readFile(pending.stage.name, "utf8"), "unrelated inode")
	}
})

test("recovery: aged orphan cleanup excludes active stages, unresolved publication evidence and reader interests", async (t) => {
	const f = await fixture(t), old = new Date(Date.now() - 60 * 60 * 1000)
	const orphan = await f.captures.staging(crypto.randomUUID())
	await orphan.handle.writeFile("orphan"); await orphan.handle.close(); orphan.handle = null
	const active = await f.captures.staging(crypto.randomUUID())
	t.after(() => active.handle?.close())
	await active.handle.writeFile("active copy")
	const heldId = crypto.randomUUID(), readerName = path.join(f.storeDir, "blobs", `${heldId}.${crypto.randomUUID()}.partial`)
	await fs.writeFile(readerName, "reader bytes", { mode: 0o600 })
	const pending = await stagedPublication(f)
	// An occupied final name makes this publication genuinely ambiguous.
	await fs.writeFile(pending.final, "unexpected final", { mode: 0o400 })
	for (const name of [orphan.name, active.name, readerName, pending.stage.name]) await fs.utimes(name, old, old)
	// Simulate a crashed creator only for the orphan; the long-running copy stays tracked.
	f.captures.activeStages?.delete(path.basename(orphan.name))
	f.captures.readers.set(`capture/${heldId}`, 1)
	const swept = await f.captures.sweep()
	await assert.rejects(fs.stat(orphan.name), { code: "ENOENT" })
	assert.equal(await fs.readFile(active.name, "utf8"), "active copy")
	assert.equal(await fs.readFile(readerName, "utf8"), "reader bytes")
	assert.equal(await fs.readFile(pending.stage.name, "utf8"), pending.bytes)
	assert.ok(swept.retainedBytes >= Buffer.byteLength(pending.bytes) + Buffer.byteLength("unexpected final"))
	await active.handle.close(); active.handle = null
})

test("recovery: a fragment publication without a job blocks drain and admission at retained-byte pressure", async (t) => {
	const f = await fixture(t), pending = await stagedPublication(f, { kind: "fragment" })
	await fs.writeFile(pending.final, "conflicting final", { mode: 0o400 })
	const next = await restartCaptures(t, f, { previewIdleMs: 0, previewBytes: 1, retainedBytes: Buffer.byteLength(pending.bytes) })
	await fs.writeFile(path.join(f.root, "x"), "new")
	await assert.rejects(next.create({ requestId: "pressure", path: "x" }), { status: 507, error: "insufficient_storage" })
	const drained = await next.drain(new Date(Date.now() + 5000).toISOString())
	assert.equal(drained.indeterminate, 1)
	assert.equal(drained.complete, false)
	await assert.rejects(next.get("fragment", pending.publication.id), { status: 503, state: "indeterminate" })
})

test("recovery: cleanup rechecks the inode after the durable abort marker and never unlinks a replacement", async (t) => {
	const f = await fixture(t), pending = await stagedPublication(f)
	const preserved = path.join(f.storeDir, "blobs", `${pending.publication.id}.${crypto.randomUUID()}.partial`)
	const put = f.state.put.bind(f.state); let replaced = false
	f.state.put = async (kind, id, value) => {
		const result = await put(kind, id, value)
		if (!replaced && kind === "source-publications" && value.state === "aborted-before-publication") {
			replaced = true
			await fs.rename(pending.stage.name, preserved)
			await fs.writeFile(pending.stage.name, "replacement bytes", { mode: 0o400 })
		}
		return result
	}
	const next = await restartCaptures(t, f)
	assert.equal(await fs.readFile(preserved, "utf8"), pending.bytes)
	assert.equal(await fs.readFile(pending.stage.name, "utf8"), "replacement bytes")
	assert.equal((await f.state.get("source-publications", pending.publication.id)).state, "indeterminate")
	await assert.rejects(next.get("capture", pending.publication.id), { status: 503, state: "indeterminate" })
})

test("recovery: fresh orphans wait for grace and provider job interruption precedes orphan GC", async (t) => {
	const f = await fixture(t), old = new Date(Date.now() - 60 * 60 * 1000)
	const basename = `${crypto.randomUUID()}.${crypto.randomUUID()}.partial`, fresh = `${crypto.randomUUID()}.${crypto.randomUUID()}.partial`
	await fs.writeFile(path.join(f.storeDir, "blobs", basename), "provider staging", { mode: 0o600 })
	await fs.utimes(path.join(f.storeDir, "blobs", basename), old, old)
	await fs.writeFile(path.join(f.storeDir, "blobs", fresh), "fresh orphan", { mode: 0o600 })
	await f.state.put("jobs", "provider", { jobId: "provider", type: "provider", state: "running", stagingBasename: basename })
	await f.captures.sweep()
	assert.equal(await fs.readFile(path.join(f.storeDir, "blobs", basename), "utf8"), "provider staging")
	const next = await restartCaptures(t, f)
	assert.equal((await next.getJob("provider")).state, "interrupted")
	await assert.rejects(fs.stat(path.join(f.storeDir, "blobs", basename)), { code: "ENOENT" })
	assert.equal(await fs.readFile(path.join(f.storeDir, "blobs", fresh), "utf8"), "fresh orphan")
})

test("recovery: an unresolved multi-input index protects every member and revalidates all dependencies before metadata recovery", async (t) => {
	for (const missing of [false, true]) {
		const f = await fixture(t), inputs = []
		for (const name of ["a.shp", "a.dbf"]) { await fs.writeFile(path.join(f.root, name), name); inputs.push(await f.captures.create({ requestId: name, path: name, computeDigest: true })) }
		const id = crypto.randomUUID(), reservationId = crypto.randomUUID(), stage = await f.captures.staging(id), bytes = Buffer.from('{"retained":"GIS"}')
		await stage.handle.writeFile(bytes)
		const dependencies = inputs.map((i) => ({ kind: "capture", id: i.source.captureId })), manifest = { kind: "vector", source: inputs[0].source, inputs: inputs.map((i) => ({ name: path.basename(i.source.ref.path), source: i.source, sha256: i.source.digest.sha256 })) }
		await f.captures.withRetention(() => f.captures.reserveIndex({ id: reservationId, representationId: id, sizeBytes: 65536 }))
		f.state.failTransaction(0, (ops) => ops.some((op) => op.kind === "workbook-indexes"))
		await assert.rejects(f.captures.publish(stage, { id, kind: "index", source: inputs[0].source, dependencies, manifest, reservationId, sizeBytes: bytes.length, metadataBytes: 0, createdAt: new Date().toISOString(), lastAccessAt: new Date().toISOString() }), { state: "indeterminate" })
		for (const i of inputs) await f.captures.releaseLease(i.lease.leaseId)
		f.captures.limits.previewIdleMs = 0; assert.equal((await f.captures.sweep()).evicted, 0, "Unresolved journal dependencies protect even the companion without a lease.")
		if (missing) await fs.unlink(path.join(f.storeDir, "blobs", `capture.${inputs[1].source.captureId}`))
		const next = await restartCaptures(t, f), publication = await f.state.get("source-publications", id)
		assert.equal(publication.state, missing ? "indeterminate" : "committed")
		if (missing) { assert.equal(await f.state.get("workbook-indexes", id), null); await assert.rejects(next.record("index", id), { state: "indeterminate" }); assert.equal(await fs.readFile(path.join(f.storeDir, "blobs", `index.${id}`), "utf8"), bytes.toString()) }
		else assert.deepEqual((await next.record("index", id)).dependencies, dependencies)
	}
})
