import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as wait } from "node:timers/promises"
import { test } from "node:test"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import { createFilesServer } from "../files-server.js"
import gate from "../gate.cjs"
import { VoxelService } from "../lib/voxels.js"
import { defaultSpatialMetadata, readManifest } from "../lib/voxel/voxel-artifact.js"
import { historical } from "./voxel-fixture.mjs"

const secret = "a".repeat(64), controlSecret = "b".repeat(64)
const logger = { error() {}, warn() {}, info() {}, log() {} }
const csv = "x,y,z,value\n0.2,0.2,0.2,2\n0.3,0.3,0.3,4\n0.2,0.2,1.2,8\n0.3,0.3,1.3,12\n1.2,0.2,0.2,20\n1.3,0.3,0.3,40\n1.2,1.2,1.2,90\n1.3,1.3,1.3,110\n0.2,0.2,0.2,\n,0.2,0.2,999\n"
function recipe(source, rowEnd = 10) {
	return { schemaVersion: 1, algorithm: "geocluster-binning-v1", name: "Known answer", scope: { input: { type: "delimited", resourceId: source.path, source, delimiter: "," }, range: { rowStart: 0, rowEnd, columnStart: 0, columnEnd: 3 }, headerRows: [0] }, geometry: { mode: "points", x: 0, y: 1, z: 2, zMeaning: { type: "elevation" } }, reference: { horizontal: { type: "local", name: "test frame" }, horizontalUnit: "m", verticalUnit: "m", verticalReference: "test plane" }, value: { kind: "numeric", column: 3, name: "Value", unit: "ppm", aggregation: "mean" }, numbers: { decimal: ".", thousands: "none", missingTokens: ["NaN"], sentinels: [], censored: "exclude" }, predicates: [], grid: { spacing: [1, 1, 1], extent: { type: "custom", origin: [0, 0, 0], shape: [2, 2, 2], acceptClipping: false } }, predecessor: null }
}
async function fixture(t, extra = {}) {
	const root = await fs.mkdtemp(path.join(os.homedir(), ".gc-voxels-")), workspaceDir = path.join(root, "workspace")
	await fs.mkdir(workspaceDir)
	const config = { workspaceDir, filesStateDir: path.join(root, "private"), filesAgentUids: [20001], filesWorkerUids: [20003], filesWorkbookWorkerEnabled: false, allowedOrigins: ["https://allowed.example"], controlSecret, ...extra }
	let app
	const start = async () => { app = await createFilesServer({ config, secret, logger }); await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve)); app.files.workspace.voxels.startRecovery() }
	await start()
	const request = (route, options = {}) => fetch(`http://127.0.0.1:${app.server.address().port}${route}`, { ...options, headers: { "x-gc-gate": secret, ...options.headers } })
	const post = (body, headers = {}) => request("/voxels", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
	const capture = async (name, bytes, computeDigest = true) => {
		await fs.writeFile(path.join(workspaceDir, name), bytes)
		const result = await app.files.workspace.captures.create({ requestId: crypto.randomUUID(), path: name, computeDigest })
		assert.ok(result.source, JSON.stringify(result))
		return { resourceId: name, root: "workspace", path: name, revision: `capture:${result.source.captureId}`, sha256: result.source.digest.sha256 || "0".repeat(64) }
	}
	t.after(async () => { await app.shutdown(); await fs.rm(root, { recursive: true, force: true }) })
	return { config, root, workspaceDir, request, post, capture, get app() { return app }, async restart() { await app.shutdown(); await start() } }
}
async function json(response, status = 200) { const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body }
async function settled(f, id) {
	for (let n = 0; n < 400; n++) { const { operation } = await json(await f.request(`/voxels/operations/${id}`)); if (["ready", "failed"].includes(operation.phase)) return operation; await wait(10) }
	throw new Error(`Operation ${id} did not settle`)
}
async function member(f, manifest, role) {
	let response
	for (let n = 0; n < 300; n++) { response = await f.request(`/voxels/member?${new URLSearchParams({ manifest: JSON.stringify(manifest), role })}`); if (response.status !== 503 || (await response.clone().json()).error !== "artifact_verifying") break; await wait(10) }
	assert.equal(response.status, 200, await response.clone().text())
	return new Uint8Array(await response.arrayBuffer())
}
// Independent, deliberately small decoder: never calls the implementation's NPY decoder.
function array(bytes) {
	assert.deepEqual([...bytes.slice(0, 8)], [147, 78, 85, 77, 80, 89, 1, 0])
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset = 10 + view.getUint16(8, true)
	const header = new TextDecoder().decode(bytes.slice(10, offset)), dtype = /'descr': '([^']+)'/.exec(header)[1]
	const shape = /'shape': \(([^)]+)\)/.exec(header)[1].split(",").map(Number).filter((n) => n > 0)
	const count = shape.reduce((a, b) => a * b, 1), size = dtype === "<f8" ? 8 : dtype === "<u4" ? 4 : 1
	assert.equal(bytes.length, offset + count * size)
	return { shape, values: Array.from({ length: count }, (_, n) => size === 8 ? view.getFloat64(offset + n * 8, true) : size === 4 ? view.getUint32(offset + n * 4, true) : view.getUint8(offset + n)) }
}
function npy(values, shape) {
	const header = `{'descr': '<f8', 'fortran_order': False, 'shape': (${shape.join(", ")}), }`, length = header.length + 1 + (64 - (10 + header.length + 1) % 64) % 64
	const bytes = Buffer.alloc(10 + length + values.length * 8, 32)
	bytes.set([147, 78, 85, 77, 80, 89, 1, 0]); bytes.writeUInt16LE(length, 8); bytes.write(header, 10); bytes[9 + length] = 10
	values.forEach((v, n) => bytes.writeDoubleLE(v, 10 + length + n * 8)); return bytes
}
test("voxels: complete captured ten-row known answer, canonical retry and immutable hashed members", async (t) => {
	const f = await fixture(t), source = await f.capture("data.csv", csv)
	const r = recipe(source)
	const v = await json(await f.post({ action: "validate", recipe: r })); assert.deepEqual(v.errors, []); assert.equal(v.statistics.acceptedRows, 8); assert.equal(v.statistics.excludedRows, 2); assert.equal(v.statistics.occupiedCells, 4)
	await fs.writeFile(path.join(f.workspaceDir, source.path), "x,y,z,value\n0,0,0,99999\n")
	const submission = { kind: "table-to-voxel", recipe: r }, key = "known-answer"
	const accepted = (await json(await f.post({ action: "submit", submission, idempotencyKey: key }), 202)).operation
	assert.equal(accepted.phase, "accepted")
	const op = await settled(f, accepted.id); assert.equal(op.phase, "ready", JSON.stringify(op)); assert.equal(op.statistics.rows, 10)
	const retry = (await json(await f.post({ action: "submit", submission: { recipe: structuredClone(r), kind: "table-to-voxel" }, idempotencyKey: key }), 200)).operation
	assert.equal(retry.id, op.id); assert.equal(retry.phase, "ready")
	assert.equal((await json(await f.request(`/voxels?resourceId=data.csv`))).operations[0].id, op.id)
	assert.equal((await json(await f.request(`/voxels?idempotencyKey=${key}`))).operations[0].id, op.id)
	const manifestBytes = await f.request(`/voxels/member?${new URLSearchParams({ source: JSON.stringify(op.artifact.manifest) })}`)
	const manifest = await json(manifestBytes); assert.equal(manifest.format, "geocluster-voxel"); assert.deepEqual(manifest.grid.shape, [2, 2, 2])
	for (const [role, expected] of [["values", [3, 10, 0, 0, 30, 0, 0, 100]], ["valid", [1, 1, 0, 0, 1, 0, 0, 1]], ["counts", [2, 2, 0, 0, 2, 0, 0, 2]]]) {
		const bytes = await member(f, op.artifact.manifest, role), descriptor = manifest.arrays.find((a) => a.role === role)
		assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), descriptor.sha256); assert.equal(bytes.length, descriptor.byteLength)
		assert.deepEqual(array(bytes), { shape: [2, 2, 2], values: expected })
	}
	assert.ok(await fs.stat(path.join(f.workspaceDir, op.artifact.manifest.path)))
	assert.equal((await f.app.files.workspace.state.list("holds")).filter((h) => h.reason === "voxel-operation").length, 0)
	await f.restart(); assert.equal((await settled(f, op.id)).phase, "ready")
	assert.deepEqual(array(await member(f, op.artifact.manifest, "values")).values, [3, 10, 0, 0, 30, 0, 0, 100])
})
test("voxels: exact bridge binding, pending digests, registered membership and strict queries", async (t) => {
	const f = await fixture(t), source = await f.capture("data.csv", csv), pending = await f.capture("pending.csv", csv, false)
	for (const [bad, code] of [[{ ...source, sha256: "f".repeat(64) }, "source_changed"], [{ ...source, path: "other.csv", resourceId: "other.csv" }, "source_changed"], [{ ...source, root: "source" }, "invalid_source"], [pending, "digest_not_ready"]]) {
		const reply = await f.post({ action: "validate", recipe: recipe(bad) }); const body = await json(reply, 409); assert.equal(body.error, code); assert.ok(body.reason)
	}
	const fake = await f.request(`/voxels/member?${new URLSearchParams({ manifest: JSON.stringify(source), role: "values" })}`); assert.equal((await json(fake, 404)).error, "artifact_not_found")
	for (const query of ["resourceId=x&resourceId=x", "resourceId=x&idempotencyKey=x", "unknown=x", "resourceId=%FF", `resourceId=${"x".repeat(4097)}`]) await json(await f.request(`/voxels?${query}`), 400)
	await json(await f.request("/voxels/operations/nope?unknown=1"), 400)
	await json(await f.post({ action: "submit", extra: true, submission: { kind: "table-to-voxel", recipe: recipe(source) }, idempotencyKey: "bad" }), 400)
	assert.equal((await f.app.files.workspace.state.list("voxel-keys")).length, 0)
})
test("voxels: NPY metadata canonicalizes axis reversal, zeros, negative and nonfinite cells", async (t) => {
	const f = await fixture(t), source = await f.capture("volume.npy", npy([0, -2, NaN, 7], [1, 2, 2]))
	const metadata = { axisOrder: [2, 1, 0], reversed: [true, false, false], indexOrigin: [10, 20, 30], spacing: [2, 3, 4], unit: "m", horizontalReference: { type: "local", definition: "array frame" }, verticalReference: "plane", fieldName: "Value", fieldUnit: "ppm", sentinel: null }
	const op = await settled(f, (await json(await f.post({ action: "submit", submission: { kind: "import-metadata", recipe: { schemaVersion: 1, source, metadata, defaults: [], predecessor: null } }, idempotencyKey: "import" }), 202)).operation.id)
	assert.equal(op.phase, "ready", JSON.stringify(op)); assert.equal(op.statistics.occupiedCells, 3)
	assert.deepEqual(array(await member(f, op.artifact.manifest, "values")), { shape: [2, 2, 1], values: [-2, 7, 0, 0] })
	assert.deepEqual(array(await member(f, op.artifact.manifest, "valid")).values, [1, 1, 1, 0])
	const m = await json(await f.request(`/voxels/member?${new URLSearchParams({ source: JSON.stringify(op.artifact.manifest) })}`)); assert.deepEqual(m.grid.origin, [6, 20, 30]); assert.equal(m.creation.mode, "imported-volume")
})
test("voxels: default bare-array metadata imports an empty field unit without substituting it", async (t) => {
	const f = await fixture(t), source = await f.capture("bare.npy", npy([0, -3, NaN, 9], [2, 1, 2]))
	const metadata = { ...defaultSpatialMetadata("bare.npy"), fieldUnit: "" }
	const submission = { kind: "import-metadata", recipe: { schemaVersion: 1, source, metadata, defaults: Object.keys(metadata), predecessor: null } }
	const accepted = await json(await f.post({ action: "submit", submission, idempotencyKey: "empty-field-unit" }), 202)
	const op = await settled(f, accepted.operation.id); assert.equal(op.phase, "ready", JSON.stringify(op))
	const response = await f.request(`/voxels/member?${new URLSearchParams({ source: JSON.stringify(op.artifact.manifest) })}`)
	assert.equal(response.status, 200)
	const manifest = await readManifest(new Uint8Array(await response.arrayBuffer()))
	assert.equal(manifest.field.unit, ""); assert.equal(manifest.recipe.recipe.metadata.fieldUnit, "")
	assert.equal(manifest.grid.unit, "grid-unit"); assert.equal(manifest.grid.horizontalReference.type, "unreferenced")
	assert.deepEqual(array(await member(f, op.artifact.manifest, "values")), { shape: [2, 1, 2], values: [0, -3, 0, 9] })
	assert.deepEqual(array(await member(f, op.artifact.manifest, "valid")).values, [1, 1, 0, 1])
})
test("voxels: category ties and segment length weighting reject point-stamping semantics", async (t) => {
	const f = await fixture(t)
	const labels = await f.capture("labels.csv", "x,y,z,v\n0.5,0.5,0.5,B\n0.5,0.5,0.5,A\n0.5,0.5,0.5,0\n")
	const c = recipe(labels, 3); c.value = { kind: "categorical", column: 3, name: "Lithology", trim: true }; c.grid.extent.shape = [1, 1, 1]
	const cat = await settled(f, (await json(await f.post({ action: "submit", submission: { kind: "table-to-voxel", recipe: c }, idempotencyKey: "category" }), 202)).operation.id)
	assert.equal(cat.phase, "ready"); assert.equal(cat.statistics.categoryTies, 1); assert.deepEqual(array(await member(f, cat.artifact.manifest, "values")).values, [0]); assert.deepEqual(array(await member(f, cat.artifact.manifest, "valid")).values, [1])
	const categorySegments = await f.capture("category-segments.tsv", "x0\ty0\tz0\tx1\ty1\tz1\tv\n0\t0.5\t0.5\t0.5\t0.5\t0.5\tA\n0\t0.5\t0.5\t2\t0.5\t0.5\tB\n")
	const weighted = recipe(categorySegments, 2); weighted.scope.input.delimiter = "\t"; weighted.scope.range.columnEnd = 6; weighted.geometry = { mode: "segments", start: [0, 1, 2], end: [3, 4, 5], zMeaning: { type: "elevation" } }; weighted.value = { kind: "categorical", column: 6, name: "Lithology", trim: true }; weighted.grid.extent.shape = [2, 1, 1]
	const weightedOp = await settled(f, (await json(await f.post({ action: "submit", submission: { kind: "table-to-voxel", recipe: weighted }, idempotencyKey: "weighted-category" }), 202)).operation.id)
	assert.equal(weightedOp.phase, "ready"); assert.equal(weightedOp.statistics.categoryTies, 0); assert.deepEqual(array(await member(f, weightedOp.artifact.manifest, "values")).values, [1, 1])
})
test("voxels: jittered same-key admission yields one operation; conflicts and failed terminal retries never replay", async (t) => {
	const f = await fixture(t), source = await f.capture("data.csv", csv), submission = { kind: "table-to-voxel", recipe: recipe(source) }
	for (let round = 0; round < 4; round++) {
		const replies = await Promise.all(Array.from({ length: 12 }, async () => { await wait(Math.random() * 15); const response = await f.post({ action: "submit", submission, idempotencyKey: `stress-${round}` }); return json(response, response.status === 202 ? 202 : 200) }))
		assert.equal(new Set(replies.map((r) => r.operation.id)).size, 1); assert.equal((await settled(f, replies[0].operation.id)).phase, "ready")
	}
	const conflict = structuredClone(submission); conflict.recipe.value.aggregation = "max"
	assert.equal((await json(await f.post({ action: "submit", submission: conflict, idempotencyKey: "stress-0" }), 409)).error, "idempotency_conflict")
	const bad = structuredClone(submission); bad.recipe.value.column = 99
	const accepted = await json(await f.post({ action: "submit", submission: bad, idempotencyKey: "failed" }), 202), failed = await settled(f, accepted.operation.id)
	assert.equal(failed.phase, "failed")
	const retry = await json(await f.post({ action: "submit", submission: bad, idempotencyKey: "failed" }), 200); assert.deepEqual(retry.operation, failed)
	assert.equal((await f.app.files.workspace.state.list("voxel-operations")).length, 5)
})
test("voxels: daemon fencing precedes Origin, drain and readiness; direct Origin is checked", async (t) => {
	const f = await fixture(t), identity = f.app.files.workspace.identity
	const badFence = { "x-gc-workspace-id": identity.workspaceId, "x-gc-workspace-epoch": "stale", origin: "https://evil.example" }
	assert.equal((await json(await f.post({ action: "describe" }, badFence), 409)).error, "workspace_changed")
	assert.equal((await json(await f.post({ action: "describe" }, { origin: "https://evil.example" }), 403)).error, "bad_origin")
	assert.equal((await json(await f.post({ action: "describe" }, { origin: "https://allowed.example, https://allowed.example" }), 403)).error, "bad_origin")
	const availability = f.app.files.workspace.captures.availability
	f.app.files.workspace.captures.availability = { state: "unavailable", reason: "ownership" }
	assert.equal((await json(await f.post({ action: "describe" }, badFence), 409)).error, "workspace_changed")
	f.app.files.workspace.captures.availability = availability
	await json(await f.request("/internal/files/drain", { method: "POST", headers: { "x-gc-files-control": controlSecret, "content-type": "application/json" }, body: JSON.stringify({ deadline: new Date(Date.now() + 5000).toISOString(), admissionOnly: true }) }))
	assert.equal((await json(await f.post({ action: "describe" }, badFence), 409)).error, "workspace_changed")
	assert.deepEqual(await f.app.files.workspace.state.list("voxel-keys"), [])
})
test("voxels: authenticated gate routes exact voxel surfaces to file daemon and fences before mutation Origin", async (t) => {
	const f = await fixture(t), upstream = (await import("node:http")).createServer((_req, res) => { res.writeHead(418); res.end("gateway") })
	await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => upstream.close(resolve)))
	const key = "c".repeat(64), projectId = "test-project", keyFile = path.join(f.root, "gate-key"), gateFile = path.join(f.root, "gate-secret")
	await fs.writeFile(keyFile, key, { mode: 0o600 }); await fs.writeFile(gateFile, secret, { mode: 0o600 })
	const g = gate.createGateServer({ upstreamHost: "127.0.0.1", upstreamPort: upstream.address().port, filesPort: f.app.server.address().port, projectId, keyFile, gateFile, authDisabled: false, allowedOrigins: ["https://allowed.example"], frameAncestors: "'none'" }, { logger })
	await new Promise((resolve) => g.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => g.close(resolve)))
	const url = `http://127.0.0.1:${g.address().port}`, cookie = `${gate.COOKIE_NAME}=${gate.issueCookie({ key, projectId }).value}`
	assert.equal((await fetch(`${url}/voxels`)).status, 401)
	assert.equal((await fetch(`${url}/voxels`, { headers: { cookie } })).status, 200)
	assert.equal((await fetch(`${url}/voxels/member`, { headers: { cookie } })).status, 400)
	assert.equal((await fetch(`${url}/voxels/operations/missing`, { headers: { cookie } })).status, 404)
	assert.equal((await fetch(`${url}/voxels-extra`, { headers: { cookie } })).status, 418)
	const identity = f.app.files.workspace.identity
	const response = await fetch(`${url}/voxels`, { method: "POST", headers: { cookie, origin: "https://evil.example", "x-gc-workspace-id": identity.workspaceId, "x-gc-workspace-epoch": "stale" }, body: "{}" })
	assert.equal((await json(response, 409)).error, "workspace_changed")
})

test("voxels: accepted work holds source, rejects capacity overflow, and completes through drain", async (t) => {
	let release, entered
	const block = new Promise((resolve) => { release = resolve }), entry = new Promise((resolve) => { entered = resolve })
	const f = await fixture(t, { voxelLimits: { workers: 1 }, voxelCheckpoint: async (stage) => { if (stage === "generating") { entered(); await block } } })
	t.after(() => release())
	const source = await f.capture("data.csv", csv), submission = { kind: "table-to-voxel", recipe: recipe(source) }
	const accepted = (await json(await f.post({ action: "submit", submission, idempotencyKey: "held" }), 202)).operation
	await Promise.race([entry, wait(2000).then(() => { throw new Error("missing generating checkpoint") })])
	assert.equal((await f.app.files.workspace.state.list("holds")).filter((h) => h.reason === "voxel-operation").length, 1)
	await json(await f.post({ action: "submit", submission, idempotencyKey: "overflow" }), 429)
	assert.equal((await f.app.files.workspace.state.list("voxel-keys")).length, 1, "overflow must not claim a key")
	const captureId = source.revision.slice(8), captures = f.app.files.workspace.captures
	for (const lease of await f.app.files.workspace.state.list("leases")) await captures.releaseLease(lease.leaseId)
	const record = await f.app.files.workspace.state.get("captures", captureId); await f.app.files.workspace.state.put("captures", captureId, { ...record, lastAccessAt: "2000-01-01T00:00:00.000Z" })
	await captures.sweep(); assert.ok(!(await f.app.files.workspace.state.get("captures", captureId)).evictedAt)
	const drain = f.request("/internal/files/drain", { method: "POST", headers: { "x-gc-files-control": controlSecret, "content-type": "application/json" }, body: JSON.stringify({ deadline: new Date(Date.now() + 10000).toISOString() }) })
	await wait(20); release()
	const drained = await json(await drain); assert.equal(drained.voxels.complete, true)
	const op = await settled(f, accepted.id); assert.equal(op.phase, "ready", JSON.stringify(op))
	assert.equal((await f.app.files.workspace.state.list("holds")).filter((h) => h.reason === "voxel-operation").length, 0)
})

test("voxels: artifact lifetime survives lease expiry and integrity errors reject altered members", async (t) => {
	const f = await fixture(t), source = await f.capture("data.csv", csv)
	const op = await settled(f, (await json(await f.post({ action: "submit", submission: { kind: "table-to-voxel", recipe: recipe(source) }, idempotencyKey: "integrity" }), 202)).operation.id)
	assert.equal(op.phase, "ready")
	const workspace = f.app.files.workspace, artifact = (await workspace.state.list("voxel-artifacts"))[0]
	for (const lease of await workspace.state.list("leases")) await workspace.captures.releaseLease(lease.leaseId)
	for (const record of await workspace.state.list("captures")) await workspace.state.put("captures", record.id, { ...record, lastAccessAt: "2000-01-01T00:00:00.000Z" })
	await workspace.captures.sweep()
	assert.deepEqual(array(await member(f, op.artifact.manifest, "values")).values, [3, 10, 0, 0, 30, 0, 0, 100])
	assert.equal((await json(await f.post({ action: "submit", submission: { kind: "table-to-voxel", recipe: recipe(source) }, idempotencyKey: "integrity" }))).operation.id, op.id, "terminal retry must not reacquire an expired source or rerun")
	const captureId = artifact.members.values.source.revision.slice(8), record = await workspace.state.get("captures", captureId), filename = workspace.captures.blobPath(record)
	await fs.chmod(filename, 0o600); const bytes = await fs.readFile(filename); bytes[bytes.length - 1] ^= 1; await fs.writeFile(filename, bytes); await fs.chmod(filename, 0o400)
	const response = await f.request(`/voxels/member?${new URLSearchParams({ manifest: JSON.stringify(op.artifact.manifest), role: "values" })}`)
	assert.equal(response.status, 409); assert.ok((await response.json()).reason)
	await f.restart(); assert.equal((await settled(f, op.id)).phase, "ready", "later integrity failures cannot rewrite committed publication history")
	const head = await f.app.files.workspace.voxels.namedResolve({ voxelId: op.named.voxelId })
	assert.deepEqual(head.artifact, op.artifact); assert.equal(head.availability.state, "integrity-blocked")
	await assert.rejects(f.app.files.workspace.voxels.inspectArtifact({ artifact: op.artifact }), { status: 409 })
	await fs.unlink(filename)
	await f.restart(); assert.equal((await settled(f, op.id)).phase, "ready")
	assert.equal((await f.app.files.workspace.voxels.namedResolve({ voxelId: op.named.voxelId })).availability.state, "integrity-blocked")
	assert.equal((await f.request(`/voxels/member?${new URLSearchParams({ manifest: JSON.stringify(op.artifact.manifest), role: "values" })}`)).status, 409)
})

test("voxels: workbook uses exact prepared capture, stored formula caches, range and absolute columns", async (t) => {
	const cell = (raw, extra = {}) => ({ type: typeof raw === "number" ? "n" : "s", raw, display: raw === null ? "" : String(raw), format: null, formula: null, cache: "not-formula", ...extra })
	const reader = {
		availability: { state: "available", build: "voxel-fixture-v1" }, limits: {}, async init() {},
		async parse({ handle, outputPath }) {
			const bytes = await handle.readFile(), db = new Database(outputPath)
			db.exec("CREATE TABLE rows(sheet TEXT,row INTEGER,cells TEXT,PRIMARY KEY(sheet,row))")
			const rows = [["ignored", "x", "y", "z", "v"], ["skip", 999, 999, 999, 999], ["zero", 0.2, 0.2, 0.2, 0], ["cached", 0.3, 0.3, 0.3, -4], ["missing", 0.4, 0.4, 0.4, null]]
			rows.forEach((values, row) => db.prepare("INSERT INTO rows VALUES(?,?,?)").run("sheet-0", row, JSON.stringify(Object.fromEntries(values.map((raw, column) => [column, cell(raw, column === 4 && row >= 3 ? { formula: "-4", cache: row === 3 ? "present" : "missing" } : {})])))))
			db.close(); await fs.chmod(outputPath, 0o400)
			return { schemaVersion: 1, parser: "voxel-fixture-v1", origin: "fresh", dateSystem: "1900", sheets: [{ id: "sheet-0", ordinal: 0, name: "Data", visibility: "visible", kind: "worksheet", rows: 5, columns: 5, indexedRows: 5, storedRange: "A1:E5", populatedCells: 25, merges: [], modes: ["stored", "formula"], warnings: [] }], warnings: [], inputSha256: crypto.createHash("sha256").update(bytes).digest("hex"), metrics: { durationMs: 1, peakRssKiB: 100, inputBytes: bytes.length, outputBytes: (await fs.stat(outputPath)).size } }
		},
	}
	const f = await fixture(t, { filesWorkbookReader: reader }), source = await f.capture("book.xlsx", "captured workbook")
	const captured = (await f.app.files.workspace.captures.get("capture", source.revision.slice(8))).source
	const preparation = await f.app.files.workspace.preparation({ requestId: "workbook", type: "workbook", source: captured, options: {} })
	let manifest
	for (let n = 0; n < 200; n++) { const job = await f.app.files.workspace.job(preparation.jobId); if (job.state === "succeeded") { manifest = job.result.representation; break }; if (job.state === "failed") throw new Error(JSON.stringify(job.error)); await wait(10) }
	assert.ok(manifest)
	const r = recipe(source, 4); r.scope.input = { type: "workbook", resourceId: source.path, source, workbookId: manifest.id, sheet: "sheet-0" }; r.scope.range = { rowStart: 2, rowEnd: 4, columnStart: 1, columnEnd: 4 }; r.geometry.x = 1; r.geometry.y = 2; r.geometry.z = 3; r.value.column = 4
	const described = await json(await f.post({ action: "describe", ...r.scope })); assert.equal(described.rows, 3); assert.deepEqual(described.headers.map((h) => h.label), ["x", "y", "z", "v"])
	const op = await settled(f, (await json(await f.post({ action: "submit", submission: { kind: "table-to-voxel", recipe: r }, idempotencyKey: "workbook-voxel" }), 202)).operation.id)
	assert.equal(op.phase, "ready", JSON.stringify(op)); assert.equal(op.statistics.acceptedRows, 2); assert.equal(op.statistics.excludedRows, 1); assert.equal(op.statistics.formulaCacheValues, 1); assert.equal(array(await member(f, op.artifact.manifest, "values")).values[0], -2)
	const different = await f.capture("other.xlsx", "other captured workbook"), wrong = structuredClone(r); wrong.scope.input.source = different; wrong.scope.input.resourceId = different.path
	assert.equal((await json(await f.post({ action: "validate", recipe: wrong }), 409)).error, "source_changed")
})

test("voxels: real process interruption recovers coherent publication or terminal failure without replay", async (t) => {
	for (const checkpoint of ["generating", "member-values", "namespace", "registered"]) {
		const root = await fs.mkdtemp(path.join(os.homedir(), ".gc-voxel-crash-")), workspaceDir = path.join(root, "workspace")
		await fs.mkdir(workspaceDir); await fs.writeFile(path.join(workspaceDir, "data.csv"), csv)
		const config = { workspaceDir, filesStateDir: path.join(root, "private"), filesAgentUids: [20001], filesWorkerUids: [20003], filesWorkbookWorkerEnabled: false }
		const child = spawn(process.execPath, [fileURLToPath(new URL("./voxel-crash-worker.mjs", import.meta.url)), JSON.stringify(config), checkpoint], { stdio: ["ignore", "pipe", "pipe"] })
		t.after(async () => { child.kill("SIGKILL"); await fs.rm(root, { recursive: true, force: true }) })
		const exited = new Promise((resolve) => child.once("exit", resolve))
		let output = "", stderr = ""; child.stderr.on("data", (b) => { stderr += b })
		const ready = await new Promise((resolve, reject) => { const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Crash fixture did not start: ${stderr}`)) }, 5000); child.stdout.on("data", (b) => { output += b; if (output.includes("\n")) { clearTimeout(timeout); resolve(JSON.parse(output.trim())) } }) })
		const submission = { kind: "table-to-voxel", recipe: recipe(ready.source) }
		await fetch(`http://127.0.0.1:${ready.port}/voxels`, { method: "POST", headers: { "x-gc-gate": secret, "content-type": "application/json" }, body: JSON.stringify({ action: "submit", submission, idempotencyKey: "crash-key" }) }).catch(() => {})
		assert.equal(await Promise.race([exited, wait(5000).then(() => { child.kill("SIGKILL"); throw new Error(`Checkpoint ${checkpoint} was not reached`) })]), 88)
		const app = await createFilesServer({ config, secret, logger }); await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve))
		app.files.workspace.voxels.startRecovery()
		try {
			const found = (await app.files.workspace.voxels.list({ idempotencyKey: "crash-key" }))[0]
			const op = await settled({ request: (route) => fetch(`http://127.0.0.1:${app.server.address().port}${route}`, { headers: { "x-gc-gate": secret } }) }, found.id)
			assert.equal(op.phase, ["namespace", "registered"].includes(checkpoint) ? "ready" : "failed", JSON.stringify(op))
			assert.equal((await app.files.workspace.state.list("holds")).filter((h) => h.reason === "voxel-operation").length, 0)
			assert.deepEqual((await app.files.workspace.voxels.submit(submission, "crash-key")).operation, op)
			assert.equal((await app.files.workspace.state.list("voxel-operations")).length, 1)
		} finally { await app.shutdown() }
	}
})

test("voxels: caught namespace acknowledgement failure automatically recovers the same coherent publication without replay", async (t) => {
	let publications = 0
	const config = { filesCheckpoint: async (stage, op) => { if (stage === "published" && op.operationId.startsWith("voxel-publish-")) { publications++; throw new Error("Namespace publication acknowledgement lost") } } }
	const f = await fixture(t, config), source = await f.capture("data.csv", csv), submission = { kind: "table-to-voxel", recipe: recipe(source) }
	const accepted = (await json(await f.post({ action: "submit", submission, idempotencyKey: "caught-publication-failure" }), 202)).operation
	const service = f.app.files.workspace.voxels
	for (let n = 0; n < 400; n++) { const op = await service.operation(accepted.id); if (op.phase === "ready" && op.named.outcome === "committed") break; await wait(10) }
	await f.app.files.workspace.voxels.drain(new Date(Date.now() + 5000).toISOString())
	const artifact = (await f.app.files.workspace.state.list("voxel-artifacts"))[0], upload = await f.app.files.workspace.state.get("operations", artifact.uploadId)
	assert.equal(artifact.state, "ready")
	assert.equal(upload.state, "committed")
	const manifestBytes = await fs.readFile(path.join(f.workspaceDir, artifact.filename))
	assert.equal(publications, 1)
	await f.restart()
	const recovered = await settled(f, accepted.id); assert.equal(recovered.phase, "ready", JSON.stringify(recovered))
	assert.equal(recovered.id, accepted.id); assert.equal(recovered.artifact.generation, artifact.manifest.generation)
	assert.equal(publications, 1, "reconciliation must not generate or publish a second artifact")
	assert.deepEqual(await fs.readFile(path.join(f.workspaceDir, artifact.filename)), manifestBytes)
	assert.deepEqual(array(await member(f, recovered.artifact.manifest, "values")).values, [3, 10, 0, 0, 30, 0, 0, 100])
	const retry = await json(await f.post({ action: "submit", submission, idempotencyKey: "caught-publication-failure" })); historical(retry.operation, recovered); assert.equal(retry.operation.availability.state, "verified")
	assert.equal((await f.app.files.workspace.state.list("voxel-artifacts")).length, 1)
})

test("voxels: SQL fault during named commit rolls back head, journal and receipts together, then recovers without republishing", async (t) => {
	const f = await fixture(t), source = await f.capture("data.csv", csv), submission = { kind: "table-to-voxel", recipe: recipe(source) }
	const db = new Database(path.join(f.config.filesStateDir, "files.sqlite"))
	t.after(() => db.close())
	db.exec("CREATE TRIGGER fail_named_journal BEFORE INSERT ON records WHEN NEW.kind = 'voxel-named-outcomes' BEGIN SELECT RAISE(ABORT, 'named journal fault'); END")
	const accepted = (await json(await f.post({ action: "submit", submission, idempotencyKey: "atomic-named" }), 202)).operation
	await f.app.files.workspace.voxels.drain(new Date(Date.now() + 10000).toISOString())
	const ws = f.app.files.workspace, before = await ws.state.get("voxel-operations", accepted.id), key = await ws.state.get("voxel-keys", "atomic-named")
	assert.equal(before.phase, "ready"); assert.equal(before.named.outcome, "unknown"); assert.deepEqual(key, before)
	assert.equal(await ws.state.get("voxel-named", before.named.voxelId), null, "head insert must roll back when the later journal insert faults")
	assert.equal(await ws.state.get("voxel-named-outcomes", accepted.id), null)
	assert.equal((await ws.state.list("voxel-artifacts")).length, 1, "saved artifact is independent of named commit")
	db.exec("DROP TRIGGER fail_named_journal")
	const recovered = await settled(f, accepted.id)
	assert.equal(recovered.named.outcome, "committed"); assert.deepEqual(recovered.artifact, before.artifact)
	assert.deepEqual((await ws.state.get("voxel-named", recovered.named.voxelId)).artifact, recovered.artifact)
	const committed = await ws.state.get("voxel-operations", accepted.id)
	assert.deepEqual((await ws.state.get("voxel-named-outcomes", accepted.id)).operation, committed)
	assert.deepEqual(await ws.state.get("voxel-keys", "atomic-named"), committed)
	await f.restart(); historical(await settled(f, accepted.id), recovered)
	assert.equal((await f.app.files.workspace.state.list("voxel-artifacts")).length, 1)
})

test("voxels: new workspace epoch hides prior operations and refuses prior captured bytes", async (t) => {
	const f = await fixture(t), source = await f.capture("data.csv", csv)
	const op = await settled(f, (await json(await f.post({ action: "submit", submission: { kind: "table-to-voxel", recipe: recipe(source) }, idempotencyKey: "old-epoch" }), 202)).operation.id)
	assert.equal(op.phase, "ready")
	const old = f.app.files.workspace.identity
	await f.app.shutdown()
	const db = new Database(path.join(f.config.filesStateDir, "files.sqlite")); db.prepare("UPDATE identity SET workspace_epoch = ?").run(crypto.randomUUID()); db.close()
	await f.restart()
	assert.notEqual(f.app.files.workspace.identity.workspaceEpoch, old.workspaceEpoch)
	assert.deepEqual((await json(await f.request("/voxels?idempotencyKey=old-epoch"))).operations, [])
	await json(await f.request(`/voxels/operations/${op.id}`), 404)
	const response = await f.request(`/voxels/member?${new URLSearchParams({ source: JSON.stringify(source) })}`)
	assert.equal(response.status, 503); assert.ok((await response.json()).reason)
	assert.equal((await json(await f.post({ action: "validate", recipe: recipe(source) }, { "x-gc-workspace-id": old.workspaceId, "x-gc-workspace-epoch": old.workspaceEpoch }), 409)).error, "workspace_changed")
})

test("voxels: competing admissions with stale discovery respect the atomic canonical claim", async (t) => {
	const f = await fixture(t), source = await f.capture("data.csv", csv), workspace = f.app.files.workspace
	const second = new VoxelService(workspace), state = workspace.state, get = state.get.bind(state)
	let arrivals = 0, release
	const barrier = new Promise((resolve) => { release = resolve })
	state.get = async (kind, id) => {
		const result = await get(kind, id)
		if (kind === "voxel-keys" && id === "competing" && arrivals < 2) { arrivals++; if (arrivals === 2) release(); await barrier }
		return result
	}
	try {
		const submission = { kind: "table-to-voxel", recipe: recipe(source) }
		const replies = await Promise.all([workspace.voxels.submit(submission, "competing"), second.submit(submission, "competing")])
		assert.equal(replies[0].operation.id, replies[1].operation.id, "a stale pre-claim lookup must not execute twice")
		const op = await settled(f, replies[0].operation.id); assert.equal(op.phase, "ready")
		await second.close()
		assert.equal((await state.list("voxel-artifacts")).length, 1)
	} finally { state.get = get; release(); await second.close() }
})
