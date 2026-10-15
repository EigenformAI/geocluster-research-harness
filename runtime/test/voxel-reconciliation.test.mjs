import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { FileState } from "../lib/file-state.js"
import { setTimeout as wait } from "node:timers/promises"
import Database from "better-sqlite3"

const put = (kind, id, value) => ({ type: "put", kind, id, value })
const link = (id) => ({ artifactId: `vox-${id}`, generation: String(id).padStart(64, "0"), manifest: { root: "workspace", resourceId: `${id}.voxel.json`, path: `${id}.voxel.json`, revision: `capture:${crypto.randomUUID()}`, sha256: String(id).padStart(64, "0") } })
async function fixture(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voxel-reconciliation-")), state = await FileState.open({ dir })
	t.after(async () => { await state.close(); await fs.rm(dir, { recursive: true, force: true }) })
	return state
}
async function prepare(state, id, artifact, revision = null) {
	const op = { id, key: id, phase: "associating", artifact, namedIntent: { voxelId: "named-one", name: "Original", revision }, named: { outcome: "unknown", voxelId: "named-one", name: "Original" } }
	await state.transaction([put("voxel-operations", id, op), put("voxel-keys", id, op), put("voxel-artifacts", artifact.artifactId, { artifactId: artifact.artifactId, state: "ready", publicationState: "ready", verificationState: "verified", manifest: { generation: artifact.generation }, link: artifact })])
	return op
}
const deletion = (state, artifact, key = "delete-key") => state.voxelArtifactDelete({ id: artifact.artifactId, generation: artifact.generation, key, requester: { transport: "test" } })
test("exact deletion atomically invalidates current head without rollback; stale publication cannot reopen it", async (t) => {
	const state = await fixture(t), a = link(1), b = link(2)
	await prepare(state, "first", a); const first = await state.voxelNamedCommit("first")
	const renamed = await state.voxelNamedRename("named-one", "Renamed", first.named.headRevision)
	const stale = await state.get("voxel-artifacts", a.artifactId)
	const result = await deletion(state, a)
	assert.equal(result.deletion.access, "closed"); assert.deepEqual(result.namedIds, ["named-one"])
	const head = await state.get("voxel-named", "named-one")
	assert.equal(head.name, "Renamed"); assert.deepEqual(head.artifact, a); assert.notEqual(head.headRevision, renamed.headRevision)
	await state.put("voxel-artifacts", a.artifactId, { ...stale, verificationState: "verified" })
	assert.equal((await state.get("voxel-artifacts", a.artifactId)).deletion.id, result.deletion.id)
	await prepare(state, "second", b, { voxelId: "named-one", expectedHeadRevision: renamed.headRevision, base: a })
	assert.equal((await state.voxelNamedCommit("second")).named.outcome, "conflict")
	assert.deepEqual(await state.voxelNamedCommit("first"), first, "historical commit is evidence, not another CAS")
	assert.deepEqual((await state.get("voxel-named", "named-one")).artifact, a)
	assert.equal((await deletion(state, a)).deletion.id, result.deletion.id)
	await assert.rejects(deletion(state, b), { error: "idempotency_conflict" })
})
test("deleted candidate produces terminal association journal and both discovery receipts", async (t) => {
	const state = await fixture(t), a = link(1)
	await prepare(state, "candidate", a); await deletion(state, a)
	const outcome = await state.voxelNamedCommit("candidate")
	assert.equal(outcome.phase, "ready"); assert.equal(outcome.named.outcome, "failed"); assert.equal(outcome.named.reasonCode, "artifact_deleted")
	assert.equal(await state.get("voxel-named", "named-one"), null)
	assert.deepEqual(await state.get("voxel-operations", "candidate"), outcome)
	assert.deepEqual(await state.get("voxel-keys", "candidate"), outcome)
	assert.deepEqual(await state.voxelNamedCommit("candidate"), outcome)
})
test("publication ledger replay preserves lifecycle and inherits durable cleanup on late conversion", async (t) => {
	const state = await fixture(t), a = link(1), captureId = crypto.randomUUID(), reservationId = crypto.randomUUID()
	await prepare(state, "publication", a)
	const binding = { captureId, reservationId, artifactId: a.artifactId, workspaceEpoch: state.identity.workspaceEpoch, key: "values", sizeBytes: 16, metadataBytes: 4096 }
	const reservation = { id: reservationId, artifactId: a.artifactId, entries: [{ key: "values", captureId, converted: false, cleanupState: "indeterminate" }] }
	await state.put("voxel-reservations", reservationId, reservation)
	const deleted = await deletion(state, a)
	await state.transaction([put("voxel-owned-captures", captureId, binding), put("voxel-reservations", reservationId, { ...reservation, entries: [{ key: "values", captureId, converted: true }] })])
	const owned = await state.get("voxel-owned-captures", captureId)
	assert.equal(owned.cleanupRequestedAt, deleted.deletion.requestedUtc)
	await state.put("voxel-owned-captures", captureId, { ...owned, cleanupIndeterminate: true, reclaimedAt: "2026-10-09T00:00:00.000Z", reclaimedBytes: 16 })
	await state.put("voxel-owned-captures", captureId, binding)
	const replay = await state.get("voxel-owned-captures", captureId)
	assert.equal(replay.cleanupRequestedAt, owned.cleanupRequestedAt); assert.equal(replay.cleanupIndeterminate, true); assert.equal(replay.reclaimedBytes, 16); assert.ok(replay.reclaimedAt)
	assert.equal((await state.get("voxel-reservations", reservationId)).entries[0].cleanupState, "indeterminate")
})

test("seeded delete/advance/rename races use transaction-local heads across two SQLite connections", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voxel-delete-races-")), left = await FileState.open({ dir }), right = await FileState.open({ dir })
	t.after(async () => { await Promise.all([left.close(), right.close()]); await fs.rm(dir, { recursive: true, force: true }) })
	const seed = 0x5eed1234; let random = seed
	const jitter = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return wait(random % 9) }
	for (let round = 0; round < 16; round++) {
		const a = link(100 + round * 2), b = link(101 + round * 2), firstId = `first-${round}`, nextId = `next-${round}`
		await left.delete("voxel-named", "named-one"); await prepare(left, firstId, a); const first = (await left.voxelNamedCommit(firstId)).named
		await prepare(left, nextId, b, { voxelId: first.voxelId, expectedHeadRevision: first.headRevision, base: a })
		const results = await Promise.all([jitter().then(() => deletion(left, a, `delete-${round}`)), jitter().then(() => right.voxelNamedCommit(nextId)), jitter().then(() => right.voxelNamedRename("named-one", "Renamed", first.headRevision)).then((head) => ({ head }), (error) => ({ error }))])
		const head = await left.get("voxel-named", "named-one"), outcome = results[1]
		assert.deepEqual(head.artifact, outcome.named.outcome === "committed" ? b : a)
		if (results[2].head) assert.equal(head.name, "Renamed", "delete must preserve a transaction-local rename")
		assert.ok((await left.get("voxel-artifacts", a.artifactId)).deletion)
		if (outcome.named.outcome === "committed") assert.deepEqual(results[0].namedIds, [], "historical deletion cannot overwrite the new current head")
		else assert.deepEqual(results[0].namedIds, ["named-one"])
		assert.deepEqual(await right.voxelNamedCommit(nextId), outcome)
	}
	t.diagnostic(`seed=${seed} rounds=16 concurrent_delete_advance_rename=48`)
})

// A real second connection owns the writer lock while a stale publication write
// arrives. Committing lifecycle changes before releasing that lock reproduces
// the read/merge/UPSERT race without pausing or instrumenting production code.
for (const mode of ["standalone", "batch"]) for (const kind of ["voxel-artifacts", "voxel-owned-captures", "voxel-reservations", "captures"]) {
	test(`guarded lifecycle writes: ${mode} ${kind} preserve concurrent lifecycle commits`, async (t) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voxel-write-races-")), state = await FileState.open({ dir }), owner = new Database(path.join(dir, "files.sqlite"), { timeout: 5000 })
		t.after(async () => { if (owner.inTransaction) owner.exec("ROLLBACK"); owner.close(); await state.close(); await fs.rm(dir, { recursive: true, force: true }) })
		const replace = owner.prepare("UPDATE records SET value = ? WHERE epoch = ? AND kind = ? AND id = ?"), seed = 0x61746f6d, rounds = 12
		let random = seed
		for (let round = 0; round < rounds; round++) {
			const artifact = link(200 + round), captureId = crypto.randomUUID(), reservationId = crypto.randomUUID(), stamp = "2026-10-09T00:00:00.000Z"
			const artifactRecord = { artifactId: artifact.artifactId, state: "ready", publicationState: "ready", verificationState: "unchecked", manifest: { generation: artifact.generation }, link: artifact }
			const binding = { captureId, reservationId, artifactId: artifact.artifactId, workspaceEpoch: state.identity.workspaceEpoch, key: "values", sizeBytes: 16, metadataBytes: 4096 }
			const entry = { key: "values", captureId, converted: false, staging: { basename: `${captureId}.${crypto.randomUUID()}.partial`, candidate: { dev: "1", ino: "2" } } }
			const reservation = { id: reservationId, artifactId: artifact.artifactId, entries: [entry] }, capture = { id: captureId, kind: "capture", sizeBytes: 16 }
			const tombstone = { id: `deletion-${round}`, requestedUtc: stamp }, lifecycle = { cleanupRequestedAt: stamp, cleanupIndeterminate: true, cleanupError: { error: "unknownBytes" }, reclaimedAt: stamp, reclaimedBytes: 16 }
			const rows = {
				"voxel-artifacts": { id: artifact.artifactId, initial: artifactRecord, committed: { ...artifactRecord, deletion: tombstone } },
				"voxel-owned-captures": { id: captureId, initial: binding, committed: { ...binding, ...lifecycle } },
				"voxel-reservations": { id: reservationId, initial: reservation, committed: { ...reservation, reclaimedStagingBytes: 32, entries: [{ ...entry, converted: true, cleanupState: "indeterminate", staging: { ...entry.staging, cleanupState: "pending" } }] } },
				captures: { id: captureId, initial: capture, committed: { ...capture, evictedAt: stamp, cleanupPending: true } },
			}
			await state.transaction(Object.entries(rows).map(([recordKind, row]) => put(recordKind, row.id, row.initial)))
			const row = rows[kind], stale = { ...row.initial, publicationAttempt: round }
			owner.exec("BEGIN IMMEDIATE")
			const writing = mode === "standalone" ? state.put(kind, row.id, stale) : state.transaction([put(kind, row.id, stale)])
			// Observe rejections immediately, but do not turn a busy/stale-snapshot
			// failure into success: the admitted writer must finish after release.
			writing.catch(() => {})
			try {
				random = (Math.imul(random, 1664525) + 1013904223) >>> 0
				await wait(20 + random % 11)
				replace.run(JSON.stringify({ ...artifactRecord, deletion: tombstone }), state.identity.workspaceEpoch, "voxel-artifacts", artifact.artifactId)
				replace.run(JSON.stringify(row.committed), state.identity.workspaceEpoch, kind, row.id)
				owner.exec("COMMIT")
			} finally { if (owner.inTransaction) owner.exec("ROLLBACK") }
			await writing
			const stored = await state.get(kind, row.id)
			assert.equal(stored.publicationAttempt, round, "the contending write must commit, not merely preserve the other writer by failing")
			if (kind === "voxel-artifacts") { assert.deepEqual(stored.deletion, tombstone, "a committed tombstone cannot be lost to a stale standalone publication"); assert.deepEqual(stored.link, artifact) }
			else if (kind === "voxel-owned-captures") for (const [field, value] of Object.entries(lifecycle)) assert.deepEqual(stored[field], value, `owned lifecycle field ${field} must survive`)
			else if (kind === "voxel-reservations") { assert.equal(stored.reclaimedStagingBytes, 32); assert.equal(stored.entries[0].converted, true); assert.equal(stored.entries[0].cleanupState, "indeterminate"); assert.equal(stored.entries[0].staging.cleanupState, "pending") }
			else { assert.equal(stored.evictedAt, stamp); assert.equal(stored.cleanupPending, true) }
		}
		t.diagnostic(`seed=${seed} rounds=${rounds} mode=${mode} kind=${kind} connections=2`)
	})
}
