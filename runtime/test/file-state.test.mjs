import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import { setTimeout as wait } from "node:timers/promises"
import { test } from "node:test"
import { FileState } from "../lib/file-state.js"

async function fixture(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-state-"))
	let state
	t.after(async () => { await state?.close(); await fs.rm(dir, { recursive: true, force: true }) })
	state = await FileState.open({ dir })
	return { dir, get state() { return state }, async restart() { await state.close(); state = await FileState.open({ dir }); return state } }
}

test("state: workspace identity, records, and intent binding survive restart", async (t) => {
	const f = await fixture(t)
	const identity = f.state.identity
	assert.match(identity.workspaceId, /^[0-9a-f-]{36}$/)
	assert.match(identity.workspaceEpoch, /^[0-9a-f-]{36}$/)
	const intent = { action: "upload", path: "a.csv", options: { digest: false, mode: "create" } }
	assert.deepEqual(await f.state.claim("operations", "op-1", intent, { state: "accepted" }), { duplicate: false, record: { state: "accepted" } })
	await f.state.put("operations", "op-1", { state: "committed", captureId: "old-bytes" })
	await f.state.put("captures", "c-1", { sizeBytes: 23 })
	await f.state.claim("requests", "nullable", { path: "x" }, { state: "accepted" })
	await f.state.put("requests", "nullable", null)
	assert.deepEqual(await f.state.claim("requests", "nullable", { path: "x" }, {}), { duplicate: true, record: null })
	await f.restart()
	assert.deepEqual(f.state.identity, identity)
	assert.deepEqual(await f.state.list("captures"), [{ sizeBytes: 23 }])
	assert.deepEqual(await f.state.claim("operations", "op-1", { options: { mode: "create", digest: false }, path: "a.csv", action: "upload" }, {}), { duplicate: true, record: { state: "committed", captureId: "old-bytes" } })
	await assert.rejects(f.state.claim("operations", "op-1", { ...intent, path: "b.csv" }, {}), { status: 409, error: "operation_id_reused" })
	await f.state.delete("captures", "c-1")
	assert.equal(await f.state.get("captures", "c-1"), null)
})

test("state: an invalid transaction cannot leave a partial write or store file bytes", async (t) => {
	const { state } = await fixture(t)
	await assert.rejects(state.transaction([
		{ type: "put", kind: "holds", id: "hold", value: { sourceId: "c-1" } },
		{ type: "wrong", kind: "jobs", id: "job", value: {} },
	]), { error: "invalid_state_operation" })
	assert.equal(await state.get("holds", "hold"), null)
	await assert.rejects(state.put("captures", "bytes", { nested: [Buffer.from("not metadata")] }), { error: "invalid_state_value" })
	await state.transaction([
		{ type: "put", kind: "holds", id: "h", value: { sourceId: "c-1" } },
		{ type: "put", kind: "jobs", id: "j", value: { state: "succeeded" } },
	])
	assert.deepEqual(await state.list("holds"), [{ sourceId: "c-1" }])
	assert.deepEqual(await state.get("jobs", "j"), { state: "succeeded" })
})

test("state: racing claims bind the first intent exactly once, including across connections", async (t) => {
	let second
	t.after(() => second?.close())
	const f = await fixture(t)
	second = await FileState.open({ dir: f.dir })
	assert.deepEqual(second.identity, f.state.identity)
	const winners = await Promise.all(Array.from({ length: 48 }, async (_, n) => {
		await wait(Math.floor(Math.random() * 12))
		const state = n % 2 ? second : f.state
		return state.claim("requests", "same", { path: "x.txt", options: [1, 2] }, { chosen: n })
	}))
	assert.equal(winners.filter((claim) => !claim.duplicate).length, 1)
	assert.equal(new Set(winners.map((claim) => claim.record.chosen)).size, 1)
	await assert.rejects(second.claim("requests", "same", { path: "other.txt", options: [1, 2] }, {}), { status: 409, error: "request_id_reused" })
	await f.state.delete("requests", "same")
	await assert.rejects(f.state.claim("requests", "same", { path: "replacement.txt" }, {}), { error: "request_id_reused" })
})

test("state: restart interrupts jobs, retains queued holds, and never replays accepted operations", async (t) => {
	const f = await fixture(t)
	await f.state.transaction([
		{ type: "put", kind: "jobs", id: "queued", value: { jobId: "queued", state: "queued", holdId: "h" } },
		{ type: "put", kind: "jobs", id: "running", value: { jobId: "running", state: "cancel_requested" } },
		{ type: "put", kind: "jobs", id: "done", value: { jobId: "done", state: "succeeded", result: { captureId: "c" } } },
		{ type: "put", kind: "holds", id: "h", value: { holdId: "h", reason: "job", source: { kind: "capture", id: "c" } } },
		{ type: "put", kind: "operations", id: "uncertain", value: { state: "publishing", inspectionRef: "candidate" } },
	])
	await f.restart()
	for (const id of ["queued", "running"]) {
		const job = await f.state.get("jobs", id)
		assert.equal(job.state, "interrupted")
		assert.equal(job.error.error, "job_interrupted")
		assert.equal(job.error.agent, "file-service")
		assert.match(job.error.action, /new request/i)
	}
	assert.equal((await f.state.get("jobs", "done")).state, "succeeded")
	assert.equal((await f.state.get("holds", "h")).source.id, "c")
	assert.deepEqual(await f.state.get("operations", "uncertain"), { state: "publishing", inspectionRef: "candidate" })
})

test("state: closed workers reject work with an actionable error", async (t) => {
	const { state } = await fixture(t)
	await state.close()
	await state.close()
	await assert.rejects(state.get("jobs", "x"), { status: 503, error: "storage_unavailable" })
})

test("state: invalid JSON arrays and missing record IDs are rejected without poisoning subsequent reads", async (t) => {
	const { state } = await fixture(t)
	for (const value of [[undefined], new Array(2), { value: NaN }, undefined]) {
		await assert.rejects(state.put("metadata", "bad", value), { status: 400, error: "invalid_state_value" })
	}
	await assert.rejects(state.get("metadata", undefined), { status: 400, error: "invalid_id" })
	await state.put("metadata", "valid", { optional: undefined, array: [null, 1] })
	assert.deepEqual(await state.get("metadata", "valid"), { array: [null, 1] })
})

test("state: invalid metadata is rejected before sending bytes to the database worker", async () => {
	const sent = []
	class WorkerPort extends EventEmitter {
		postMessage(message) { sent.push(message); queueMicrotask(() => this.emit("message", { sequence: message.sequence, result: null })) }
		async terminate() {}
	}
	const worker = new WorkerPort(), state = new FileState(worker)
	worker.emit("message", { ready: true, identity: { workspaceId: "workspace", workspaceEpoch: "epoch" } })
	for (const value of [undefined, [undefined], new Array(2), { bytes: Buffer.from("source bytes") }, Object.assign([1], { bytes: Buffer.from("array attribute bytes") }), { bad: NaN }]) {
		await assert.rejects(state.put("metadata", "bad", value), { status: 400, error: "invalid_state_value" })
	}
	await assert.rejects(state.get("metadata", undefined), { status: 400, error: "invalid_id" })
	assert.equal(sent.length, 0)
	await state.close()
})
