import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { setTimeout as wait } from "node:timers/promises"
import os from "node:os"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createFilesServer } from "../files-server.js"
import { VoxelService } from "../lib/voxels.js"
import { fail } from "../lib/voxel-request.js"
import { fixture, historical, indexed, params, remove, target, until } from "./voxel-fixture.mjs"
import { encodeNpy } from "../lib/voxel/npy.js"
import { defaultSpatialMetadata } from "../lib/voxel/voxel-artifact.js"

test("process crash after partial conversion and deletion replays immutable metadata without losing cleanup or regenerating", async (t) => {
	const root = await fs.mkdtemp(path.join(os.homedir(), ".gc-voxel-replay-")), workspaceDir = path.join(root, "workspace"); await fs.mkdir(workspaceDir); await fs.writeFile(path.join(workspaceDir, "data.csv"), "x,y,z,value\n0,0,0,0\n1,0,0,B\n")
	const config = { workspaceDir, filesStateDir: path.join(root, "private"), filesAgentUids: [20001], filesWorkerUids: [20003], filesWorkbookWorkerEnabled: false, filesGisWorkerEnabled: false }, child = spawn(process.execPath, [fileURLToPath(new URL("./voxel-reconciliation-crash-worker.mjs", import.meta.url)), JSON.stringify(config)], { stdio: ["ignore", "pipe", "pipe"] })
	let output = "", errors = ""; child.stdout.on("data", (b) => { output += b }); child.stderr.on("data", (b) => { errors += b })
	t.after(async () => { child.kill("SIGKILL"); await fs.rm(root, { recursive: true, force: true }) })
	const code = await Promise.race([new Promise((r) => child.once("exit", r)), wait(10000).then(() => { child.kill("SIGKILL"); throw new Error(`Crash checkpoint timed out: ${errors}`) })]); assert.equal(code, 88, errors)
	const proof = JSON.parse(output), app = await createFilesServer({ config, secret: "a".repeat(64), logger: { info() {}, warn() {}, error() {} } })
	try {
		const { state, voxels, captures } = app.files.workspace, publication = await state.get("source-publications", proof.captureId), owned = await state.get("voxel-owned-captures", proof.captureId)
		assert.equal(publication.state, "committed"); assert.equal(owned.cleanupRequestedAt, (await state.get("voxel-deletions", proof.deletionId)).requestedUtc); assert.ok(!owned.cleanupIndeterminate)
		assert.equal((await voxels.artifact(proof.artifactId)).availability.state, "deleted"); assert.equal((await voxels.list({ idempotencyKey: "crash-creation" }))[0].phase, "failed"); assert.equal((await voxels.namedList({})).voxels.length, 0)
		for (const lease of await state.list("leases")) await captures.releaseLease(lease.leaseId)
		await voxels.cleanupArtifacts(); const deletion = await voxels.deleteArtifact(proof.artifactId, { generation: proof.generation, idempotencyKey: "crash-deletion" }); assert.equal(deletion.status, 200); assert.ok(deletion.deletion.reclaimedBytes > 0); assert.equal((await state.list("voxel-operations")).length, 1)
	} finally { await app.shutdown() }
})

test("metadata-only restart preserves historical outcomes; lazy verification deduplicates and retries transient failure", async (t) => {
	const f = await fixture(t), { op, submission } = await f.create(); assert.equal(op.phase, "ready")
	const worker = VoxelService.prototype.worker; let boot = 0
	VoxelService.prototype.worker = async function(data) { boot++; return worker.call(this, data) }
	try { await f.restart() } finally { VoxelService.prototype.worker = worker }
	assert.equal(boot, 0); historical(await f.service.operation(op.id), op)
	const actual = f.service.worker.bind(f.service), gate = f.defer(); let calls = 0
	f.service.worker = async (data) => { if (++calls === 1) { await gate.promise; throw fail(503, "worker_resource_limit", "Transient verification exhaustion") }; return actual(data) }
	assert.equal((await f.service.artifact(op.artifact.artifactId)).availability.state, "unchecked")
	await Promise.all(["values", "valid"].map((role) => assert.rejects(f.service.bytes(params(op, role)), { error: "artifact_verifying" })))
	await until(() => calls === 1); gate.resolve(); await until(async () => (await f.service.artifact(op.artifact.artifactId)).availability.state === "temporarily-unavailable")
	await assert.rejects(f.service.bytes(params(op)), { error: "artifact_verifying" }); assert.equal(calls, 1)
	await wait(1050); await assert.rejects(f.service.bytes(params(op)), { error: "artifact_verifying" }); await until(async () => (await f.service.artifact(op.artifact.artifactId)).availability.state === "verified")
	assert.ok((await f.service.bytes(params(op))).length); assert.equal(calls, 2); assert.equal((await f.service.submit(submission, "first")).operation.phase, "ready")
})
test("durable deletion during partial conversion closes access and late publication records terminal named noncommit", async (t) => {
	const f = await fixture(t), entered = f.defer(), gate = f.defer()
	f.workspace.config.voxelCheckpoint = async (stage) => { if (stage === "member-values") { entered.resolve(); await gate.promise } }
	const source = await f.capture(), submission = { kind: "indexed-grid", recipe: indexed(source), revision: null }, accepted = await f.service.submit(submission, "active")
	await entered.promise
	const artifact = (await f.workspace.state.list("voxel-artifacts"))[0], receipt = await f.service.deleteArtifact(artifact.artifactId, { generation: artifact.manifest.generation, idempotencyKey: "active-delete" })
	assert.equal(receipt.status, 202); assert.equal(receipt.deletion.access, "closed"); assert.deepEqual(receipt.deletion.blockers, ["publication"])
	assert.equal((await f.service.artifact(artifact.artifactId)).availability.state, "deleted")
	gate.resolve(); const op = await f.settled(accepted.operation.id)
	assert.equal(op.phase, "ready", JSON.stringify(op)); assert.equal(op.named.outcome, "failed"); assert.equal(op.named.reasonCode, "artifact_deleted"); assert.ok(op.artifact)
	await assert.rejects(f.service.bytes(params(op)), { status: 410, error: "artifact_deleted" }); await assert.rejects(f.service.inspectArtifact({ artifact: op.artifact }), { status: 410 }); await assert.rejects(f.service.materializeArtifact({ artifact: op.artifact }), { status: 410 })
	const owned = (await f.workspace.state.list("voxel-owned-captures")).filter((e) => e.artifactId === artifact.artifactId)
	assert.equal(owned.length, 3); assert.ok(owned.every((e) => e.cleanupRequestedAt === receipt.deletion.requestedUtc)); assert.equal((await f.service.namedList({})).voxels.length, 0)
	await f.releaseLeases(); await f.workspace.sweep(); assert.equal((await remove(f, op, "active-delete")).status, 200)
	assert.ok(await fs.stat(path.join(f.workspaceDir, artifact.filename))); await f.restart(); assert.equal((await f.service.operation(op.id)).availability.state, "deleted"); historical((await f.service.submit(submission, "active")).operation, op)
})
test("deletion during active verification preserves admitted readers and closes new readers", async (t) => {
	const f = await fixture(t), { op } = await f.create(); await f.restart()
	const gate = f.defer(), entered = f.defer(), worker = f.service.worker.bind(f.service)
	f.service.worker = async (data) => { entered.resolve(); await gate.promise; return worker(data) }
	await assert.rejects(f.service.bytes(params(op)), { error: "artifact_verifying" }); await entered.promise
	await f.releaseLeases(); const deleted = await remove(f, op)
	assert.equal(deleted.status, 202); assert.ok([...f.workspace.captures.readers.values()].some((n) => n > 0)); await assert.rejects(f.service.bytes(params(op)), { status: 410 })
	gate.resolve(); await until(() => f.service.active === 0); await f.service.cleanupArtifacts()
	const result = await remove(f, op); assert.equal(result.status, 200); assert.ok(result.deletion.reclaimedBytes > 0); assert.equal(f.workspace.captures.readers.size, 0)
	assert.equal((await f.service.operation(op.id)).phase, "ready")
})
test("delete current head keeps identity/link and emits artifact-only invalidation; a stale base cannot advance", async (t) => {
	const f = await fixture(t), { op } = await f.create(), head = await f.service.namedResolve({ voxelId: op.named.voxelId }), events = [], publish = f.workspace.events.publish.bind(f.workspace.events)
	f.workspace.events.publish = (type, event) => { if (event.reason === "artifact-deleted") events.push(event); return publish(type, event) }
	await remove(f, op)
	const deleted = await f.service.namedResolve({ voxelId: head.voxelId }); assert.deepEqual(deleted.artifact, head.artifact); assert.equal(deleted.availability.state, "deleted"); assert.notEqual(deleted.headRevision, head.headRevision)
	assert.deepEqual(events[0].namedIds, [head.voxelId]); assert.equal(events[0].artifactId, op.artifact.artifactId); assert.deepEqual(events[0].changes, [])
	const { op: saved } = await f.create("stale-update", target(head)); assert.equal(saved.phase, "ready"); assert.equal(saved.named.outcome, "conflict"); assert.equal(saved.availability.state, "verified")
	assert.deepEqual((await f.service.namedResolve({ voxelId: head.voxelId })).artifact, head.artifact)
})
test("moved/copy wrapper resolution proves full bytes, returns canonical binding and cannot undelete", async (t) => {
	const f = await fixture(t), { op } = await f.create(), old = path.join(f.workspaceDir, op.artifact.manifest.path), bytes = await fs.readFile(old)
	await fs.rename(old, path.join(f.workspaceDir, "moved.voxel.json")); await fs.writeFile(old, "replacement")
	const source = await f.capture("moved.voxel.json", bytes), resolved = await f.service.resolveManifest({ source })
	assert.deepEqual(resolved.artifact.link, op.artifact); assert.equal(resolved.artifact.availability.state, "verified")
	const changed = await f.capture("edited.voxel.json", Buffer.concat([bytes, Buffer.from("\n")]))
	await assert.rejects(f.service.resolveManifest({ source: changed }), { error: "artifact_binding_changed" })
	const forged = JSON.parse(bytes); forged.artifactId = "vox-unregistered"; const { manifestGeneration } = await import("../lib/voxel/voxel-artifact.js"); forged.generation = await manifestGeneration(forged)
	await assert.rejects(f.service.resolveManifest({ source: await f.capture("forged.voxel.json", JSON.stringify(forged)) }), { error: "artifact_not_found" })
	await remove(f, op); assert.equal((await f.service.resolveManifest({ source })).artifact.availability.state, "deleted")
	assert.deepEqual((await f.service.artifactResolve({ artifactId: op.artifact.artifactId })).artifact.link, op.artifact)
	await assert.rejects(f.service.artifactResolve({ artifactId: op.artifact.artifactId, generation: op.artifact.generation }), { status: 400 })
	await assert.rejects(f.service.artifactResolve({ artifactId: op.artifact.artifactId, generation: "wrong", manifest: op.artifact.manifest }), { error: "artifact_binding_changed" })
})
test("whole-output capacity fails before staging; committed usage refresh failure is diagnostic only", async (t) => {
	const f = await fixture(t, { voxelLimits: { artifactRetainedBytes: 1 } }), { op } = await f.create()
	assert.equal(op.phase, "failed"); assert.equal(op.error.error, "artifact_storage_limit"); assert.ok(op.error.requiredBytes > op.error.availableBytes); assert.equal((await f.workspace.state.list("voxel-owned-captures")).length, 0); assert.equal((await f.workspace.state.list("captures")).length, 1)
	const g = await fixture(t), storageUsage = g.service.storageUsage.bind(g.service)
	g.service.storageUsage = async () => { if ((await g.workspace.state.list("voxel-artifacts")).some((a) => a.publicationState === "ready")) throw new Error("usage diagnostic failed"); return storageUsage() }
	const saved = await g.create(); assert.equal(saved.op.phase, "ready"); assert.equal(saved.op.named.outcome, "committed")
})

test("drain evidence identifies every unresolved artifact independently", async (t) => {
	const f = await fixture(t); await f.create("first-unresolved"); await f.create("second-unresolved")
	await f.service.cleanupArtifacts()
	const state = f.workspace.state, [a, b] = await state.list("voxel-artifacts")
	const upload = await state.get("operations", a.uploadId)
	await state.put("operations", a.uploadId, { ...upload, state: "indeterminate" })
	await state.delete("operations", b.uploadId)
	for (const artifact of [a, b]) await state.put("voxel-artifacts", artifact.artifactId, { ...artifact, publicationState: "unresolved" })
	const result = await f.service.drain(new Date(Date.now() + 1000).toISOString())
	assert.equal(result.publicationUncertainty, 2); assert.equal(result.complete, false)
	assert.ok(result.publicationEvidenceIds.includes(`operation:${a.uploadId}`))
	assert.ok(result.publicationEvidenceIds.includes(`artifact:${b.artifactId}`), JSON.stringify(result.publicationEvidenceIds))
})

test("late failure can release only its exact producer-owned source hold", async (t) => {
	const f = await fixture(t), independent = await f.capture("independent.csv"), state = f.workspace.state; let holdId
	f.workspace.config.voxelCheckpoint = async (stage, op) => {
		if (stage !== "reserved") return
		holdId = (await state.get("voxel-operations", op.id)).holdId
		await state.put("holds", holdId, { holdId, reason: "independent", source: { kind: "capture", id: independent.revision.slice(8) }, createdAt: new Date().toISOString() })
		throw new Error("Proven failure before staging")
	}
	const { op } = await f.create(); assert.equal(op.phase, "failed")
	assert.equal((await state.get("holds", holdId)).source.id, independent.revision.slice(8)); assert.equal((await state.get("holds", holdId)).reason, "independent")
})
test("capture publication replay after deletion preserves immutable producer proof and lifecycle without false indeterminate", async (t) => {
	const f = await fixture(t), { op } = await f.create(), a = await f.artifact(op), state = f.workspace.state, id = a.members.values.source.revision.slice(8), publication = await state.get("source-publications", id)
	await remove(f, op); const owned = await state.get("voxel-owned-captures", id)
	await state.put("voxel-owned-captures", id, { ...owned, cleanupIndeterminate: true }); await state.put("source-publications", id, { ...publication, state: "indeterminate" })
	await f.workspace.captures.withRetention(() => f.workspace.captures.recoverPublications(new Set([id])))
	assert.equal((await state.get("source-publications", id)).state, "committed")
	const replay = await state.get("voxel-owned-captures", id); assert.equal(replay.cleanupRequestedAt, owned.cleanupRequestedAt); assert.equal(replay.cleanupIndeterminate, true); assert.equal((await f.service.artifact(op.artifact.artifactId)).availability.state, "deleted")
	const forged = structuredClone(publication); forged.reservationBinding.artifactId = "foreign"; forged.metadataOperations.find((o) => o.kind === "voxel-owned-captures").value.artifactId = "foreign"; forged.metadataOperations.find((o) => o.kind === "voxel-reservations").value.artifactId = "foreign"; forged.state = "indeterminate"
	await state.put("source-publications", id, forged); await f.workspace.captures.recoverPublications(new Set([id])); assert.equal((await state.get("source-publications", id)).state, "indeterminate"); assert.equal((await state.get("voxel-owned-captures", id)).artifactId, op.artifact.artifactId)
})
test("persistence pre-transfer gap and unknown evidence fail closed, exact acknowledgement permits cleanup", async (t) => {
	const f = await fixture(t), { op } = await f.create(), a = await f.artifact(op), state = f.workspace.state, upload = await state.get("operations", a.uploadId), port = f.workspace.persistence
	port.adapter = { aligned: true }; await state.put("operations", a.uploadId, { ...upload, persistence: { ...upload.persistence, state: "queued" } })
	await f.releaseLeases(); const deleted = await remove(f, op); assert.equal(deleted.status, 202); assert.ok(deleted.deletion.blockers.includes("persistence")); assert.ok(!(await state.get("captures", upload.publishedSource.captureId)).evictedAt)
	const sourceInterest = port.sourceInterest; port.sourceInterest = async () => { throw new Error("Persistence evidence unavailable") }
	await f.service.cleanupArtifacts(); assert.ok((await remove(f, op)).deletion.blockers.includes("persistenceEvidence")); assert.ok(!(await state.get("captures", upload.publishedSource.captureId)).evictedAt); port.sourceInterest = sourceInterest
	await state.put("operations", a.uploadId, { ...upload, persistence: { ...upload.persistence, state: "clean" } }); await f.service.cleanupArtifacts(); assert.equal((await remove(f, op)).status, 202, "missing transfer is not no-interest proof")
	const transfer = await port.captureForTransfer(upload.addresses[0], upload.localGeneration)
	await port.recordAcknowledgement({ ref: upload.addresses[0], localGeneration: upload.localGeneration, holdId: transfer.holdId, remoteEtag: "opaque", remoteIntegrity: "digest-verified", sha256: upload.publishedSource.digest.sha256, sizeBytes: upload.publishedSource.sizeBytes })
	await f.service.cleanupArtifacts(); assert.equal((await remove(f, op)).status, 200)
})

test("complete dense replacement honors retained-string, row and source-byte budgets without truncation", async (t) => {
	const f = await fixture(t), source = await f.capture("dense.npy", encodeNpy(new Float64Array(100001), [100001, 1, 1])), metadata = defaultSpatialMetadata("dense.npy"), submission = { kind: "import-metadata", recipe: { schemaVersion: 1, source, metadata, defaults: Object.keys(metadata), predecessor: null }, revision: null }
	const accepted = await f.service.submit(submission, "dense"), op = await f.settled(accepted.operation.id); assert.equal(op.phase, "ready", JSON.stringify(op)); assert.equal(op.statistics.occupiedCells, 100001)
	await assert.rejects(f.service.materializeArtifact({ artifact: op.artifact }), { error: "row_limit" })
	f.service.limits.rows = 100001; f.service.limits.tableRetentionBytes = 256
	await assert.rejects(f.service.materializeArtifact({ artifact: op.artifact }), { error: "table_memory_limit" })
	f.service.limits.tableRetentionBytes = 128 * 1048576; f.service.limits.sourceBytes = 12
	await assert.rejects(f.service.materializeArtifact({ artifact: op.artifact }), { error: "source_limit" })
})

test("seeded cloud-transfer admission/deletion races retain original manifest bytes through acknowledgement and reader release", async (t) => {
	const f = await fixture(t), seed = 0x7391; let random = seed
	const jitter = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return wait(random % 7) }
	for (let round = 0; round < 5; round++) {
		const { op } = await f.create(`cloud-${round}`), a = await f.artifact(op), state = f.workspace.state, upload = await state.get("operations", a.uploadId), port = f.workspace.persistence
		port.adapter = { aligned: true }; await state.put("operations", a.uploadId, { ...upload, persistence: { ...upload.persistence, state: "queued" } }); await f.releaseLeases()
		const [deleted, transfer] = await Promise.all([jitter().then(() => remove(f, op, `cloud-delete-${round}`)), jitter().then(() => port.captureForTransfer(upload.addresses[0], upload.localGeneration))])
		assert.equal(deleted.status, 202); assert.ok(!(await state.get("captures", transfer.source.captureId)).evictedAt)
		const reader = await f.workspace.captures.open("capture", transfer.source.captureId)
		try {
			await jitter(); await port.recordAcknowledgement({ ref: upload.addresses[0], localGeneration: upload.localGeneration, holdId: transfer.holdId, remoteEtag: `head-${round}`, remoteIntegrity: "digest-verified", sha256: transfer.source.digest.sha256, sizeBytes: transfer.source.sizeBytes })
			await f.service.cleanupArtifacts(); assert.equal((await remove(f, op, `cloud-delete-${round}`)).status, 202); assert.ok(!(await state.get("captures", transfer.source.captureId)).evictedAt)
		} finally { await reader.release() }
		await f.service.cleanupArtifacts(); assert.equal((await remove(f, op, `cloud-delete-${round}`)).status, 200)
	}
	t.diagnostic(`seed=${seed} rounds=5 transfer_delete_races=10 premature_reclamation=0`)
})

test("persistence terminal proof rejects contradictory exact-source digest and acknowledgement address", async (t) => {
	const f = await fixture(t), { op } = await f.create(), a = await f.artifact(op), state = f.workspace.state, upload = await state.get("operations", a.uploadId), port = f.workspace.persistence
	port.adapter = { aligned: true }
	const transfer = { holdId: "proof-transfer", operationId: upload.operationId, localGeneration: upload.localGeneration, ref: upload.addresses[0], source: upload.publishedSource, state: "acknowledged", acknowledgement: { holdId: "proof-transfer", localGeneration: upload.localGeneration, ref: upload.addresses[0], remoteEtag: "opaque" } }
	await state.put("persistence-transfers", transfer.holdId, { ...transfer, source: { ...transfer.source, digest: { state: "ready", sha256: "f".repeat(64) } } })
	assert.equal((await port.sourceInterest(upload)).needed, true)
	await state.put("persistence-transfers", transfer.holdId, { ...transfer, acknowledgement: { ...transfer.acknowledgement, ref: { ...transfer.ref, path: "replacement.voxel.json" } } })
	assert.equal((await port.sourceInterest(upload)).needed, true)
	await state.put("persistence-transfers", transfer.holdId, transfer)
	assert.equal((await port.sourceInterest(upload)).needed, false)
})
test("unknown private replacements remain charged and intact; leases and independent holds delay physical cleanup", async (t) => {
	const f = await fixture(t), { op } = await f.create(), a = await f.artifact(op), id = a.members.values.source.revision.slice(8), record = await f.workspace.state.get("captures", id), filename = f.workspace.captures.blobPath(record)
	await f.releaseLeases(); await fs.unlink(filename); await fs.writeFile(filename, Buffer.alloc(20000, 17), { mode: 0o400 })
	const receipt = await remove(f, op); assert.equal(receipt.status, 202); assert.ok(receipt.deletion.blockers.includes("unknownBytes")); assert.equal((await fs.stat(filename)).size, 20000); assert.ok((await f.service.storageUsage()).sharedUsedBytes >= 20000)
	const g = await fixture(t), created = await g.create(), b = await g.artifact(created.op), member = b.members.values.source.revision.slice(8)
	await g.workspace.captures.hold("capture", member, "independent", "independent"); await remove(g, created.op); await g.releaseLeases(); await g.service.cleanupArtifacts(); assert.ok(!(await g.workspace.state.get("captures", member)).evictedAt)
	await g.workspace.captures.releaseHold("independent"); await g.workspace.sweep(); assert.equal((await remove(g, created.op)).status, 200)
})
