import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { setTimeout as wait } from "node:timers/promises"
import { FileState } from "../lib/file-state.js"

const link = (n) => ({ artifactId: `vox-${n}`, generation: String(n).padStart(64, "0"), manifest: { root: "workspace", resourceId: `${n}.voxel.json`, path: `${n}.voxel.json`, revision: `capture:${crypto.randomUUID()}`, sha256: String(n).padStart(64, "0") } })
async function fixture(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voxel-named-")), a = await FileState.open({ dir }), b = await FileState.open({ dir })
	t.after(async () => { await Promise.all([a.close(), b.close()]); await fs.rm(dir, { recursive: true, force: true }) })
	return { a, b }
}
async function prepare(state, id, artifact, revision = null, voxelId = "named-one", name = "Same name") {
	const op = { id, key: id, phase: "associating", submission: { revision }, artifact, namedIntent: { voxelId, name, revision }, named: { outcome: "unknown", voxelId, name }, updatedUtc: new Date().toISOString() }
	await state.transaction([{ type: "put", kind: "voxel-operations", id, value: op }, { type: "put", kind: "voxel-keys", id, value: op }, { type: "put", kind: "voxel-artifacts", id: artifact.artifactId, value: { artifactId: artifact.artifactId, state: "ready", link: artifact } }])
	return op
}
test("named journal compares full base even with current validator and never repeats committed CAS", async (t) => {
	const { a } = await fixture(t), initial = link(1)
	await prepare(a, "initial", initial)
	const first = await a.voxelNamedCommit("initial")
	assert.equal(first.named.outcome, "committed")
	const target = { voxelId: first.named.voxelId, expectedHeadRevision: first.named.headRevision, base: initial }
	const second = link(2); await prepare(a, "second", second, target)
	const advanced = await a.voxelNamedCommit("second"); assert.equal(advanced.named.outcome, "committed")
	await a.put("voxel-operations", "second", { ...advanced, phase: "failed", named: { ...advanced.named, outcome: "unknown" } })
	assert.deepEqual(await a.get("voxel-operations", "second"), advanced, "late stale writes cannot replace the journaled receipt")
	for (const [n, base] of [[3, initial], [4, { ...second, manifest: { ...second.manifest, revision: `capture:${crypto.randomUUID()}` } }], [5, { ...second, generation: "f".repeat(64) }]]) {
		await prepare(a, `stale-${n}`, link(n), { ...target, expectedHeadRevision: advanced.named.headRevision, base })
		assert.equal((await a.voxelNamedCommit(`stale-${n}`)).named.outcome, "conflict")
	}
	assert.deepEqual(await a.voxelNamedCommit("initial"), first)
	assert.deepEqual(await a.voxelNamedCommit("second"), advanced)
	assert.deepEqual((await a.get("voxel-named", "named-one")).artifact, second)
	assert.ok(await a.get("voxel-artifacts", "vox-3"), "conflict retains independently saved artifact")
})
test("two SQL connections with jitter permit exactly one revision per head", async (t) => {
	const { a, b } = await fixture(t); await prepare(a, "seed", link(1)); let head = (await a.voxelNamedCommit("seed")).named
	for (let round = 0; round < 12; round++) {
		const revision = { voxelId: head.voxelId, expectedHeadRevision: head.headRevision, base: head.artifact }
		const ids = [`left-${round}`, `right-${round}`]
		await Promise.all(ids.map((id, i) => prepare(i ? b : a, id, link(10 + round * 2 + i), revision)))
		const results = await Promise.all(ids.map(async (id, i) => { await wait(Math.random() * 12); return (i ? b : a).voxelNamedCommit(id) }))
		assert.deepEqual(results.map((r) => r.named.outcome).sort(), ["committed", "conflict"])
		head = results.find((r) => r.named.outcome === "committed").named
		assert.deepEqual(await a.voxelNamedCommit(ids[0]), results[0]); assert.deepEqual(await b.voxelNamedCommit(ids[1]), results[1])
	}
})
test("unregistered initial artifact exposes no ghost named voxel", async (t) => {
	const { a } = await fixture(t), artifact = link(1)
	await prepare(a, "unregistered", artifact)
	await a.delete("voxel-artifacts", artifact.artifactId)
	await assert.rejects(a.voxelNamedCommit("unregistered"), { error: "artifact_not_registered" })
	assert.equal(await a.get("voxel-named", "named-one"), null)
})
