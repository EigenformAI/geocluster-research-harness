import assert from "node:assert/strict"
import crypto from "node:crypto"
import { Readable } from "node:stream"
import { setTimeout as wait } from "node:timers/promises"
import { test } from "node:test"
import { InternalAdmission } from "../lib/internal-admission.js"
import { fixture, until } from "./voxel-fixture.mjs"
const deadline = (ms = 5000) => Date.now() + ms
function publication(f, id, extra = {}) { const bytes = Buffer.from(`manifest-${id}`), name = `${id}.json`, digest = crypto.createHash("sha256").update(bytes).digest("hex"); return { bytes, input: { operationId: `voxel-publish-${id}`, path: name, mode: "create", processingPolicy: "skip", declaredSize: bytes.length, declaredDigest: digest, producerBinding: { workspaceEpoch: f.workspace.identity.workspaceEpoch, voxelOperationId: `voxel-${id}`, artifactId: id, manifestPath: name, expectedSize: bytes.length, expectedSha256: digest }, wait: { deadline: deadline() }, ...extra } } }
const publish = (f, p) => f.workspace.uploadVoxel(Readable.from([p.bytes]), p.input)
test("public reserved-prefix and boolean bypass requests reject before body, claim and effects", async (t) => {
	const f = await fixture(t), files = f.workspace
	for (const operationId of ["voxel-publish-forged", "upload-parents:forged"]) {
		let consumed = false; const body = { async *[Symbol.asyncIterator]() { consumed = true; yield Buffer.from("bytes") } }, input = { operationId, path: "target", from: "from", to: "to" }
		for (const call of [() => files.upload(body, { ...input, acceptedVoxelWork: true }), () => files.mkdir(input), () => files.move(input), () => files.delete(input), () => files.restoreRecovery("missing", input), () => files.accept(operationId, "remote-apply", {}, [])]) await assert.rejects(Promise.resolve().then(call), { status: 400, error: "reserved_operation_id" })
		assert.equal(consumed, false); assert.equal(await files.state.get("operations", operationId), null)
	}
	files.draining = true; await assert.rejects(files.upload(Readable.from([Buffer.from("x")]), { operationId: "public", path: "public", acceptedVoxelWork: true }), { error: "draining" }); assert.equal(await files.state.get("operations", "public"), null)
	assert.equal((await publish(f, publication(f, "accepted-drain"))).operation.state, "committed")
})
test("producer-bound upload is idempotent, rejects rebinding and preserves public cloud receipt fields", async (t) => {
	const f = await fixture(t), p = publication(f, "bound"), first = await publish(f, p)
	assert.deepEqual(first.operation.intent.producerBinding, p.input.producerBinding); assert.equal((await publish(f, p)).duplicate, true)
	await assert.rejects(publish(f, { ...p, input: { ...p.input, producerBinding: { ...p.input.producerBinding, artifactId: "other" } } }), { error: "operation_id_reused" })
	assert.ok(first.operation.directoryBefore); assert.ok(first.operation.persistence); assert.ok(first.operation.localGeneration)
})
test("mutation wait expires or rejects status persistence without body or claim; accepted FIFO wait survives drain", async (t) => {
	const f = await fixture(t), files = f.workspace, gate = f.defer(), entered = f.defer(); files.limits.queueSize = 1
	const held = files.upload({ async *[Symbol.asyncIterator]() { entered.resolve(); await gate.promise; yield Buffer.from("held") } }, { operationId: "holder", path: "holder" }); await entered.promise
	let consumed = 0; const body = (bytes) => ({ async *[Symbol.asyncIterator]() { consumed++; yield bytes } })
	const expired = publication(f, "expires", { wait: { deadline: deadline(20) } }); await assert.rejects(files.uploadVoxel(body(expired.bytes), expired.input), { error: "capacity_wait_limit" })
	const broken = publication(f, "broken", { wait: { deadline: deadline(), onWait: () => { throw new Error("status persistence rejected") } } }); await assert.rejects(files.uploadVoxel(body(broken.bytes), broken.input), /status persistence rejected/)
	const notice = f.defer(), p = publication(f, "survives", { wait: { deadline: deadline(), onWait: (info) => { if (info.waiting) notice.resolve() } } }), work = files.uploadVoxel(body(p.bytes), p.input); await notice.promise
	await assert.rejects(files.mkdir({ operationId: "barge", path: "barge" }), { error: "capacity" }); assert.equal(consumed, 0); assert.equal(await files.state.get("operations", p.input.operationId), null); files.draining = true
	gate.resolve(); await held; assert.equal((await work).operation.state, "committed"); assert.equal(consumed, 1); assert.equal(files.admissions, 0)
})
test("shared workbook/GIS native lane reserves one scoped extraction permit across header reads", async (t) => {
	const f = await fixture(t, { voxelLimits: { workers: 4 } }), files = f.workspace, books = files.workbooks, gate = f.defer(), notice = f.defer(), order = []
	books.availability = { state: "available" }
	const gisRelease = files.acquireNative()
	const first = books.withInteractivePermit({ deadline: deadline(), onWait: (info) => { if (info.waiting) notice.resolve() } }, async (permit) => { order.push(1); await gate.promise; await assert.rejects(books.query("unused", {}, undefined, {}), { error: "invalid_permit" }); assert.throws(() => files.acquireNative(), { error: "capacity" }); return permit })
	await notice.promise; const second = books.withInteractivePermit({ deadline: deadline() }, async () => order.push(2))
	await assert.rejects(books.query("unused", {}), { error: "capacity" }); gisRelease(); await until(() => order.length === 1); assert.deepEqual(order, [1]); gate.resolve(); const expired = await first; await second
	assert.deepEqual(order, [1, 2]); await assert.rejects(books.query("unused", {}, undefined, expired), { error: "invalid_permit" }); assert.equal(files.nativeActive, false)
})
test("seeded FIFO mutation stress bounds permits, prohibits barging and consumes every body once", async (t) => {
	const seed = 0x51a7, f = await fixture(t, { voxelLimits: { workers: 4 } }), files = f.workspace; let random = seed, peak = 0, committed = 0
	const jitter = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return wait(random % 7) }; files.limits.queueSize = 1
	for (let round = 0; round < 5; round++) {
		const gate = f.defer(), entered = f.defer(), holder = files.upload({ async *[Symbol.asyncIterator]() { entered.resolve(); await gate.promise; yield Buffer.from("held") } }, { operationId: `holder-${round}`, path: `holder-${round}` }); await entered.promise
		const notices = Array.from({ length: 4 }, () => f.defer()), order = [], bodies = new Set(), work = notices.map((notice, n) => { const p = publication(f, `stress-${round}-${n}`, { wait: { deadline: deadline(10000), onWait: (info) => { if (info.waiting) notice.resolve() } } }); return files.uploadVoxel({ async *[Symbol.asyncIterator]() { order.push(n); assert.ok(!bodies.has(n)); bodies.add(n); peak = Math.max(peak, files.admissions); await jitter(); yield p.bytes } }, p.input) })
		await Promise.all(notices.map((n) => n.promise)); assert.equal(files.mutationWaiting, 4); await assert.rejects(publish(f, publication(f, `overflow-${round}`)), { error: "capacity" }); await jitter(); gate.resolve(); await holder
		assert.ok((await Promise.all(work)).every((r) => r.operation.state === "committed")); assert.deepEqual(order, [0, 1, 2, 3]); committed += bodies.size; assert.equal(files.admissions, 0); assert.equal(files.mutationWaiting, 0)
	}
	assert.equal(peak, 1); assert.equal(committed, 20); t.diagnostic(`seed=${seed} FIFO_publications=${committed} peak_mutations=${peak} remaining_admissions=0 remaining_waiters=0`)
})
test("FIFO notifications finish before effects and release exactly once on notification failure", async () => {
	let active = 0; const lane = new InternalAdmission({ resource: "test", available: () => active === 0, reserve: () => { active++; return () => active-- }, waiters: () => 4 }), release = lane.tryAcquire(), order = []
	const broken = lane.acquire({ deadline: deadline(), onWait: () => { throw new Error("notification failed") } }); await assert.rejects(broken, /notification failed/)
	const next = lane.acquire({ deadline: deadline(), onWait: (info) => order.push(info.state) }); assert.throws(() => lane.tryAcquire(), { error: "capacity" }); release(); release(); const done = await next; order.push("effects"); assert.deepEqual(order, ["waiting", "admitted", "effects"]); done(); done(); assert.equal(active, 0); assert.equal(lane.waiting, 0)
})
