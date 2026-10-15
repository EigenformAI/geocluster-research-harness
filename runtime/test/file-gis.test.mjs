import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { setTimeout as wait } from "node:timers/promises"
import { WorkspaceFiles } from "../lib/workspace-files.js"
import { FileError } from "../lib/file-contract.js"
import { createFilesServer, loadFilesConfig } from "../files-server.js"

const logger = { info() {}, warn() {}, error() {} }
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex")
async function fixture(t, enabled = true) {
	const base = await fs.mkdtemp(path.join(os.homedir(), ".gc-shapefile-")), workspaceDir = path.join(base, "project")
	await fs.mkdir(workspaceDir)
	const reader = { availability: { state: "available", build: "synthetic-gis/1", confinement: "synthetic-test-only" }, calls: [], async init() {}, async read({ members, operation }) {
		this.calls.push({ names: members.map((m) => m.name), operation })
		const inputDigests = []
		for (const m of members) inputDigests.push({ name: m.name, sha256: sha(await fs.readFile(`/proc/self/fd/${m.handle.fd}`)) })
		return { schemaVersion: 1, parser: "synthetic-gis/1", coverage: "geometry not requested", warnings: [], inputDigests, ...(operation === "manifest" ? { layers: [{ id: "layer-0", name: "roads", fields: [{ name: "label", type: "String", width: 24, precision: 0 }], crsWkt: "captured PRJ", axisMapping: [1, 2], reportedFeatureCount: 3 }] } : { layerId: "layer-0", offset: 1, limit: 1, rows: [{ locator: "layer-0:1", sourceId: "1", properties: { label: "second" } }], nextOffset: 2, reportedFeatureCount: 3, scannedFeatures: 3, geometryCoverage: "not-requested" }) }
	} }
	const config = { workspaceDir, filesStateDir: path.join(base, "state"), filesAgentUids: [20001], filesWorkerUids: [20003], filesWorkbookWorkerEnabled: false, filesGisWorkerEnabled: enabled, ...(enabled ? { filesGisReader: reader } : {}), processingFactory: () => ({ async init() {}, async reconcileOperations() {}, async close() {}, async drain() { return { complete: true } }, async capabilities() { return { enabled: false } } }) }
	let files = await WorkspaceFiles.open(config, logger)
	t.after(async () => { await files.close(); await fs.rm(base, { recursive: true, force: true }) })
	const sources = []
	for (const ext of ["shp", "shx", "dbf", "prj"]) { const name = `roads.${ext}`; await fs.writeFile(path.join(workspaceDir, name), `retained:${name}`); sources.push((await files.captures.create({ requestId: `capture-${ext}`, path: name, computeDigest: true })).source) }
	return { reader, sources, root: workspaceDir, get files() { return files }, input(requestId) { return { requestId, type: "vector", source: sources[0], companions: sources.slice(1) } }, async restart() { await files.close(); files = await WorkspaceFiles.open(config, logger) } }
}
async function prepare(f, requestId) {
	const accepted = await f.files.preparation(f.input(requestId))
	if (accepted.representation) return accepted
	for (let n = 0; n < 300; n++) { const job = await f.files.job(accepted.jobId); if (["succeeded", "failed", "cancelled"].includes(job.state)) { await Promise.allSettled([...f.files.gis.pending]); assert.equal(job.state, "succeeded", JSON.stringify(job.error)); return job.result } await wait(5) }
	throw new Error("GIS job did not settle")
}

test("shapefile preparation retains SHP/SHX/DBF/PRJ and queries exact captured attributes after Current changes and restart", async (t) => {
	const f = await fixture(t)
	await assert.rejects(f.files.preparation({ ...f.input("missing"), companions: [f.sources[2], f.sources[3]] }), { status: 422, error: "gis_bundle_missing" })
	await assert.rejects(f.files.preparation({ ...f.input("forged"), companions: [{ ...f.sources[1], etag: '"wrong"' }, ...f.sources.slice(2)] }), { status: 409, error: "source_changed" })
	const ready = await prepare(f, "prepare"), m = ready.representation
	assert.deepEqual(m.inputs.map((i) => i.name), ["roads.shp", "roads.dbf", "roads.prj", "roads.shx"])
	assert.equal(ready.leases.length, 4); assert.ok(m.inputs.every((i) => i.sha256 === i.source.digest.sha256))
	assert.deepEqual((await f.files.state.get("workbook-indexes", m.id)).dependencies.map((d) => d.id), m.inputs.map((i) => i.source.captureId))
	for (const s of f.sources) await fs.writeFile(path.join(f.root, s.ref.path), "replacement Current")
	await f.restart(); assert.deepEqual(await f.files.representation(m.id), m)
	const replay = await prepare(f, "prepare"); assert.equal(replay.representation.id, m.id); assert.ok(replay.leases.every((l, n) => l.leaseId !== ready.leases[n].leaseId))
	assert.equal(f.reader.calls.length, 1)
	const page = await f.files.representationQuery(m.id, { operation: "attributes", layerId: "layer-0", offset: 1, limit: 1 })
	assert.equal(page.rows[0].properties.label, "second"); assert.equal(page.rows[0].locator, "layer-0:1"); assert.equal(page.geometryCoverage, "not-requested")
	assert.deepEqual(page.sources.map((s) => s.captureId), m.inputs.map((i) => i.source.captureId))
	await fs.unlink(path.join(f.files.captures.blobDir, `capture.${f.sources[3].captureId}`))
	await assert.rejects(f.files.representationQuery(m.id, { operation: "attributes", layerId: "layer-0" }), { status: 410 })
	assert.equal(f.reader.calls.length, 2, "A missing PRJ must fail before native dispatch, not substitute Current.")
})

for (const restart of [false, true]) test(`GIS rebuild: new request replaces a missing derived blob from the same four captures${restart ? " after restart" : " live"}; old IDs stay terminal`, async (t) => {
	const f = await fixture(t), original = await prepare(f, "original"), oldId = original.representation.id
	const receipt = await f.files.request("original"), oldJob = await f.files.job(receipt.jobId)
	const captureRecords = await f.files.state.list("captures"), inputBytes = f.sources.reduce((sum, s) => sum + s.sizeBytes, 0)
	await fs.unlink(path.join(f.files.captures.blobDir, `index.${oldId}`))
	for (const s of f.sources) await fs.writeFile(path.join(f.root, s.ref.path), "different Current bytes")
	if (restart) await f.restart()
	const query = { operation: "attributes", layerId: "layer-0", offset: 1, limit: 1 }
	await assert.rejects(f.files.representationQuery(oldId, query), { status: 410, error: "index_expired" })
	await assert.rejects(prepare(f, "original"), { status: 410, error: "index_expired" })
	assert.equal(f.reader.calls.length, 1)
	// Exactly one preparation reservation fits: stale derived bytes must stop consuming capacity.
	f.files.captures.limits.retainedBytes = inputBytes + 2 * f.files.gis.limits.gisManifestBytes
	const rebuilt = await prepare(f, "rebuild")
	assert.notEqual(rebuilt.representation.id, oldId)
	assert.deepEqual(rebuilt.representation.inputs, original.representation.inputs)
	assert.deepEqual(rebuilt.leases.map((l) => l.source.id), rebuilt.representation.inputs.map((i) => i.source.captureId))
	assert.equal((await f.files.representationQuery(rebuilt.representation.id, query)).rows[0].properties.label, "second")
	const records = await f.files.state.list("captures")
	assert.equal(records.length, 4)
	for (const record of captureRecords) { const after = records.find((r) => r.id === record.id); assert.deepEqual(after.source, record.source); assert.equal(after.blobObservation, record.blobObservation) }
	const index = await f.files.state.get("workbook-indexes", rebuilt.representation.id)
	assert.equal((await f.files.captures.sweep()).retainedBytes, inputBytes + index.sizeBytes + index.metadataBytes)
	assert.deepEqual(await f.files.state.list("holds"), []); assert.deepEqual(await f.files.state.list("index-reservations"), [])
	assert.deepEqual((await fs.readdir(f.files.captures.blobDir)).sort(), [...f.sources.map((s) => `capture.${s.captureId}`), `index.${index.id}`].sort())
	assert.equal(f.files.nativeActive, false); assert.ok([...f.files.captures.readers.values()].every((n) => n === 0))
	assert.equal((await prepare(f, "reuse-rebuilt")).representation.id, index.id)
	assert.equal(f.reader.calls.filter((c) => c.operation === "manifest").length, 2)
	await assert.rejects(f.files.representation(oldId), { status: 410, error: "index_expired" })
	await assert.rejects(f.files.representationQuery(oldId, query), { status: 410, error: "index_expired" })
	await assert.rejects(prepare(f, "original"), { status: 410, error: "index_expired" })
	assert.deepEqual(await f.files.request("original"), receipt); assert.deepEqual(await f.files.job(receipt.jobId), oldJob)
})

for (const damage of ["altered-blob", "corrupt-manifest", "missing-capture", "mismatched-input"]) test(`GIS rebuild boundary: ${damage} never triggers reconstruction or Current recapture`, async (t) => {
	const f = await fixture(t), original = await prepare(f, "original"), id = original.representation.id
	const index = await f.files.state.get("workbook-indexes", id), blob = path.join(f.files.captures.blobDir, `index.${id}`)
	let expected
	if (damage === "altered-blob") { await fs.chmod(blob, 0o600); expected = { status: 503, error: "capture_store_unavailable", reason: "integrity" } }
	if (damage === "corrupt-manifest") { await f.files.state.put("workbook-indexes", id, { ...index, manifest: { ...index.manifest, parser: "corrupt-metadata" } }); expected = { status: 410, error: "representation_unavailable" } }
	if (damage === "missing-capture") { await fs.unlink(blob); await fs.unlink(path.join(f.files.captures.blobDir, `capture.${f.sources[3].captureId}`)); expected = { status: 410, error: "capture_expired" } }
	if (damage === "mismatched-input") { await fs.unlink(blob); const inputs = structuredClone(index.manifest.inputs); inputs[1].source.etag = '"forged-input"'; await f.files.state.put("workbook-indexes", id, { ...index, manifest: { ...index.manifest, inputs } }); expected = { status: 409, error: "source_changed" } }
	await assert.rejects(prepare(f, "refused"), expected)
	if (damage === "corrupt-manifest") { await f.restart(); await assert.rejects(prepare(f, "refused-after-restart"), expected) }
	assert.equal(f.reader.calls.length, 1)
	assert.equal((await f.files.request("original")).state, "succeeded")
	assert.equal((await f.files.state.list("captures")).length, 4)
	assert.deepEqual(await f.files.state.list("holds"), []); assert.deepEqual(await f.files.state.list("index-reservations"), [])
})

test("unqualified GIS does not advertise vector support or SHP preview eligibility", async (t) => {
	const f = await fixture(t, false), info = await f.files.info()
	assert.equal(info.providers.includes("vector"), false)
	assert.equal(info.providerDetails.find((p) => p.id === "vector")?.readiness.reason, "disabled")
	assert.equal((await f.files.stat("roads.shp")).previewCapabilities.formats.includes("shp"), false)
	await assert.rejects(f.files.preparation(f.input("disabled")), { status: 503, error: "gis_unavailable" })
})

test("shapefile any-member eviction tombstones the shared representation and accounts its bytes once", async (t) => {
	const f = await fixture(t), ready = await prepare(f, "prepare"), index = await f.files.state.get("workbook-indexes", ready.representation.id)
	for (const lease of await f.files.state.list("leases")) await f.files.captures.releaseLease(lease.leaseId)
	f.files.captures.limits.previewIdleMs = 0
	const result = await f.files.captures.sweep()
	assert.equal(result.retainedBytes, 0); assert.equal(result.evictedBytes, f.sources.reduce((sum, s) => sum + s.sizeBytes, 0) + index.sizeBytes + index.metadataBytes)
	assert.ok((await f.files.state.get("workbook-indexes", index.id)).evictedAt); assert.deepEqual(await fs.readdir(f.files.captures.blobDir), [])
})

test("shapefile active work holds all four members and rejects jittered competing native admission until cancellation settles", async (t) => {
	const f = await fixture(t), original = f.reader.read.bind(f.reader)
	let entered
	const start = new Promise((resolve) => { entered = resolve })
	f.reader.read = async ({ signal }) => { entered(); await new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(new FileError(409, "job_cancelled", "Stopped synthetic GIS work.")), { once: true }); if (signal.aborted) reject(new FileError(409, "job_cancelled", "Stopped synthetic GIS work.")) }) }
	const a = await f.files.preparation(f.input("active")); await start
	assert.equal((await f.files.state.list("holds")).length, 4)
	for (const lease of await f.files.state.list("leases")) await f.files.captures.releaseLease(lease.leaseId)
	f.files.captures.limits.previewIdleMs = 0; assert.equal((await f.files.captures.sweep()).evicted, 0)
	const refused = await Promise.all(Array.from({ length: 16 }, async (_, n) => { await wait(Math.floor(Math.random() * 8)); assert.throws(() => f.files.acquireNative(), { status: 429, error: "capacity" }); return n }))
	assert.equal(refused.length, 16)
	await f.files.cancelJob(a.jobId); await Promise.allSettled([...f.files.gis.pending])
	assert.equal((await f.files.job(a.jobId)).state, "cancelled"); assert.equal(f.files.nativeActive, false)
	assert.deepEqual(await f.files.state.list("holds"), []); assert.deepEqual(await f.files.state.list("index-reservations"), [])
	f.reader.read = original; assert.equal((await prepare(f, "after-cancel")).leases.length, 4)
})

test("shapefile private daemon HTTP exposes capture/preparation/query and rejects a stale epoch before effects", async (t) => {
	const f = await fixture(t), config = { ...f.files.config, controlSecret: "b".repeat(64) }
	await f.files.close()
	const app = await createFilesServer({ config, secret: "a".repeat(64), logger })
	await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve))
	t.after(() => app.shutdown(new Date(Date.now() + 5000).toISOString()))
	const files = app.files.workspace, base = `http://127.0.0.1:${app.server.address().port}`
	const fence = { "X-GC-Workspace-ID": files.identity.workspaceId, "X-GC-Workspace-Epoch": files.identity.workspaceEpoch }
	const post = (route, body, headers = {}) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json", "x-gc-gate": "a".repeat(64), ...fence, ...headers }, body: JSON.stringify(body) })
	const stale = await post("/files/preparations", f.input("stale"), { "X-GC-Workspace-Epoch": "stale" })
	assert.equal(stale.status, 409); assert.equal(await files.state.get("requests", "stale"), null)
	const a = await post("/files/preparations", f.input("http")); assert.equal(a.status, 202)
	const { jobId } = await a.json()
	for (let n = 0; n < 300 && (await files.job(jobId)).state !== "succeeded"; n++) await wait(5)
	const job = await files.job(jobId); assert.equal(job.state, "succeeded", JSON.stringify(job.error))
	await Promise.allSettled([...files.gis.pending])
	const response = await post(`/files/representations/${job.result.representation.id}/query`, { operation: "attributes", layerId: "layer-0", offset: 1, limit: 1 })
	assert.equal(response.status, 200); const page = await response.json(); assert.equal(page.filesContractVersion, 1); assert.equal(page.rows[0].properties.label, "second"); assert.equal(page.sources.length, 4)
	assert.equal(loadFilesConfig({ WORKSPACE_DIR: f.root, FILES_GIS_WORKER_ENABLED: "false" }).filesGisWorkerEnabled, false)
	assert.throws(() => loadFilesConfig({ WORKSPACE_DIR: f.root, FILES_GIS_WORKER_ENABLED: "yes" }), /must be true or false/)
})
