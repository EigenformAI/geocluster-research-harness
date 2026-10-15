import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { test } from "node:test"
import { setTimeout as wait } from "node:timers/promises"
import { fixture, indexed, target, until } from "./voxel-fixture.mjs"

async function save(f, name, revision = null) {
	const source = await f.capture(), accepted = await f.service.submit({ kind: "indexed-grid", recipe: { ...indexed(source), name }, revision }, crypto.randomUUID())
	return f.settled(accepted.operation.id)
}
async function manifest(f, op) {
	const name = op.artifact.manifest.path, { source } = await f.workspace.captures.create({ requestId: crypto.randomUUID(), path: name, computeDigest: true })
	return { root: "workspace", resourceId: name, path: name, revision: `capture:${source.captureId}`, sha256: source.digest.sha256 }
}
// Sweeps once the file index has listed every change, retrying a sweep that a late change made skip.
async function settle(f) {
	const index = f.workspace.index
	await until(async () => {
		await index.refresh()
		const generation = index.settledGeneration()
		if (generation === null) return false
		await f.workspace.sweep()
		return index.settledGeneration() === generation
	})
}
const availability = async (f, op) => (await f.service.artifact(op.artifact.artifactId)).availability.state

test("a saved voxel's file is named after the voxel; a taken name gets a number", async (t) => {
	const f = await fixture(t)
	const first = await save(f, "Gold grade"), second = await save(f, "Gold grade"), slashed = await save(f, "Au/Ag ratio")
	assert.equal(first.artifact.manifest.path, "Gold grade.voxel.json")
	assert.equal(second.artifact.manifest.path, "Gold grade (2).voxel.json")
	assert.equal(slashed.artifact.manifest.path, "Au-Ag ratio.voxel.json")
	for (const op of [first, second, slashed]) await fs.access(path.join(f.workspaceDir, op.artifact.manifest.path))
})

test("resolving a voxel file names the voxel it is the current version of", async (t) => {
	const f = await fixture(t), op = await save(f, "Gold grade"), head = await f.service.namedResolve({ voxelId: op.named.voxelId })
	const first = await f.service.resolveManifest({ source: await manifest(f, op) })
	assert.equal(first.voxel.voxelId, head.voxelId); assert.equal(first.voxel.name, "Gold grade"); assert.deepEqual(first.voxel.artifact, op.artifact)
	const revised = await save(f, "Gold grade", target(head))
	assert.equal(revised.named.outcome, "committed")
	assert.equal((await f.service.resolveManifest({ source: await manifest(f, op) })).voxel, null, "a superseded version is no named voxel's current version")
	assert.equal((await f.service.resolveManifest({ source: await manifest(f, revised) })).voxel.voxelId, head.voxelId)
})

test("a voxel's data is kept while any file holds its saved bytes and released one recovery window after the last is gone", async (t) => {
	const f = await fixture(t, { filesLimits: { trashMs: 1000 } }), op = await save(f, "Gold grade"), original = path.join(f.workspaceDir, op.artifact.manifest.path)
	await fs.mkdir(path.join(f.workspaceDir, "results")); await fs.copyFile(original, path.join(f.workspaceDir, "results/kept.voxel.json")); await fs.rm(original)
	await settle(f); await wait(1100); await settle(f)
	assert.equal(await availability(f, op), "verified", "a copy still holds the saved bytes")
	await f.workspace.delete({ operationId: crypto.randomUUID(), path: "results", baseObservation: (await f.workspace.stat("results")).observation.token, recursive: true })
	await settle(f); await settle(f)
	assert.equal(await availability(f, op), "verified", "a deleted file can still be restored")
	await wait(1100); await settle(f)
	assert.equal(await availability(f, op), "deleted")
	const deletion = (await f.service.artifact(op.artifact.artifactId)).deletion
	assert.equal(deletion.requester.transport, "manifest-file-removed")
})

test("a voxel file that comes back within the recovery window restarts the window", async (t) => {
	const f = await fixture(t, { filesLimits: { trashMs: 1000 } }), op = await save(f, "Gold grade"), file = path.join(f.workspaceDir, op.artifact.manifest.path), bytes = await fs.readFile(file)
	await fs.rm(file); await settle(f)
	await fs.writeFile(file, bytes); await settle(f)
	await wait(1100); await fs.rm(file); await settle(f)
	assert.equal(await availability(f, op), "verified")
})

test("a voxel file that comes back is kept before the file index has listed it", async (t) => {
	const f = await fixture(t, { filesLimits: { trashMs: 1000, watchDebounceMs: 1000 } }), op = await save(f, "Gold grade"), name = op.artifact.manifest.path, bytes = await fs.readFile(path.join(f.workspaceDir, name))
	await fs.rm(path.join(f.workspaceDir, name)); await settle(f)
	await wait(1100)
	await f.workspace.upload(Readable.from([bytes]), { operationId: crypto.randomUUID(), path: name, processingPolicy: "skip" })
	await f.workspace.sweep()
	assert.equal(await availability(f, op), "verified")
})
