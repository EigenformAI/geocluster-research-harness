import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { setTimeout as wait } from "node:timers/promises"
import { WorkspaceFiles } from "../lib/workspace-files.js"
import { bundleNames } from "./gis-fixtures.mjs"

const launcherPath = process.env.GIS_INSTALLED_LAUNCHER, fixtures = process.env.GIS_FIXTURES
const installed = { skip: !launcherPath || !fixtures ? "Set GIS_INSTALLED_LAUNCHER and GIS_FIXTURES to exercise the installed facade." : false }

for (const primary of ["points.geojson", "points.shp", "points.tab", "points.mif", "points.gpkg", "pixels.tif", "pixels.ers"]) test(`GIS installed facade: ${primary} publishes exact captured dependencies and queries native retained bytes`, installed, async (t) => {
	const base = await fs.mkdtemp(path.join(process.env.GIS_TEST_PARENT || os.homedir(), ".gc-gis-native-")), workspaceDir = path.join(base, "project")
	await fs.mkdir(workspaceDir)
	const kind = primary.startsWith("pixels") ? "raster" : "vector", agentUid = process.geteuid() === 999 ? 20001 : 999
	let files = await WorkspaceFiles.open({ workspaceDir, filesStateDir: path.join(base, "state"), filesAgentUids: [agentUid], filesWorkerUids: [997], filesWorkbookWorkerEnabled: false, filesGisWorkerBin: launcherPath, processingFactory: () => ({ async init() {}, async reconcileOperations() {}, async close() {}, async drain() { return { complete: true } }, async capabilities() { return { enabled: false } } }) }, { info() {}, warn() {}, error() {} })
	t.after(async () => { await files.close(); await fs.rm(base, { recursive: true, force: true }) })
	assert.equal(files.gis.availability.state, "available", JSON.stringify(files.gis.availability)); assert.equal(files.gis.availability.confinement, "verified")
	const names = await bundleNames(fixtures, primary), sources = []
	for (const name of names) { await fs.copyFile(path.join(fixtures, name), path.join(workspaceDir, name)); sources.push((await files.captures.create({ requestId: `capture-${name}`, path: name, computeDigest: true })).source) }
	const request = { requestId: "prepare", type: kind, source: sources[0], companions: sources.slice(1) }, admitted = await files.preparation(request)
	let job
	for (let n = 0; n < 600; n++) { job = await files.job(admitted.jobId); if (["succeeded", "failed", "cancelled"].includes(job.state)) break; await wait(20) }
	assert.equal(job.state, "succeeded", JSON.stringify(job.error))
	await Promise.allSettled([...files.gis.pending])
	const { representation: m, leases } = job.result
	assert.equal(m.kind, kind); assert.equal(m.inputs[0].name, primary); assert.equal(leases.length, sources.length)
	assert.ok(m.inputs.every((i) => i.sha256 === sources.find((s) => s.captureId === i.source.captureId).digest.sha256))
	assert.deepEqual((await files.state.get("workbook-indexes", m.id)).dependencies.map((d) => d.id), m.inputs.map((i) => i.source.captureId))
	// Rewrite every mutable pathname. Native queries must still see the original protected bytes.
	for (const name of names) await fs.writeFile(path.join(workspaceDir, name), "replacement Current")
	const result = await files.representationQuery(m.id, { operation: "preview" })
	assert.deepEqual(result.sources.map((s) => s.captureId), m.inputs.map((i) => i.source.captureId)); assert.equal(result.representationId, m.id)
	if (kind === "vector") {
		assert.equal(result.layers[0].features.length, 3); assert.equal(result.layers[0].features[0].properties.label, "first")
		assert.equal(result.layers[0].placement.state, "ready"); assert.ok(Math.abs(result.layers[0].placement.displayByLocator["layer-0:0"].coordinates[0] - 10) < 0.00001)
		const page = await files.representationQuery(m.id, { operation: "attributes", layerId: "layer-0", offset: 1, limit: 1 }); assert.equal(page.rows[0].properties.label, "second"); assert.equal(page.geometryCoverage, "not-requested"); assert.equal(page.nextOffset, 2)
	} else {
		assert.equal(result.image.band, 1); assert.equal(result.width, 4); assert.equal(result.bandCount, 2); assert.equal(result.image.resampling, "nearest"); assert.ok(result.image.dataUrl.startsWith("data:image/png;base64,"))
		assert.equal((await files.representationQuery(m.id, { operation: "preview", band: 2 })).image.band, 2)
	}
	assert.equal((await files.preparation(request)).representation.id, m.id)
	if (primary === "points.shp") for (const restart of [false, true]) {
		const residentRequest = { ...request, requestId: `resident-${restart}` }, resident = await files.preparation(residentRequest), oldId = resident.representation.id
		const receipt = await files.request(residentRequest.requestId)
		await fs.unlink(path.join(files.captures.blobDir, `index.${oldId}`))
		if (restart) { const config = files.config; await files.close(); files = await WorkspaceFiles.open(config, { info() {}, warn() {}, error() {} }) }
		await assert.rejects(files.preparation(residentRequest), { status: 410, error: "index_expired" })
		const admitted = await files.preparation({ ...request, requestId: `rebuild-${restart}` })
		let rebuilt
		for (let n = 0; n < 600; n++) { rebuilt = await files.job(admitted.jobId); if (["succeeded", "failed", "cancelled"].includes(rebuilt.state)) break; await wait(20) }
		assert.equal(rebuilt.state, "succeeded", JSON.stringify(rebuilt.error)); await Promise.allSettled([...files.gis.pending])
		const replacement = rebuilt.result.representation
		assert.notEqual(replacement.id, oldId); assert.deepEqual(replacement.inputs, m.inputs)
		const preview = await files.representationQuery(replacement.id, { operation: "preview" })
		assert.equal(preview.layers[0].features[0].properties.label, "first"); assert.equal(preview.layers[0].placement.state, "ready")
		await assert.rejects(files.representationQuery(oldId, { operation: "preview" }), { status: 410, error: "index_expired" })
		assert.deepEqual(await files.request(residentRequest.requestId), receipt)
		assert.deepEqual(await files.state.list("holds"), []); assert.deepEqual(await files.state.list("index-reservations"), [])
	}
	if (primary === "points.gpkg") {
		await fs.copyFile(path.join(fixtures, "dimensions.gpkg"), path.join(workspaceDir, "dimensions.gpkg"))
		const captured = await files.captures.create({ requestId: "dimensions-input", path: "dimensions.gpkg", computeDigest: true })
		const admitted = await files.preparation({ requestId: "dimensions-prepare", type: "vector", source: captured.source })
		let dimensionsJob
		for (let n = 0; n < 600; n++) { dimensionsJob = await files.job(admitted.jobId); if (["succeeded", "failed", "cancelled"].includes(dimensionsJob.state)) break; await wait(20) }
		assert.equal(dimensionsJob.state, "succeeded", JSON.stringify(dimensionsJob.error)); await Promise.allSettled([...files.gis.pending])
		const dimensions = await files.representationQuery(dimensionsJob.result.representation.id, { operation: "preview" }), l = dimensions.layers[0]
		assert.deepEqual(l.features[0].geometry, { type: "Point", coordinates: [] })
		assert.deepEqual(l.features[1].geometry.coordinates, [10, 30, 7, 9]); assert.equal(l.features[1].coordinateDimensions, "XYZM"); assert.equal(l.features[2].geometry, null)
		assert.equal(l.positionCount, 1); assert.deepEqual(l.placement.coverage, { sourceFeatures: 3, retainedDrawable: 1, nullOrEmpty: 2, decodeOmitted: 0, displayed: 1 })
		assert.deepEqual(Object.keys(l.placement.displayByLocator), ["layer-0:1"]); assert.equal(dimensions.sources[0].captureId, captured.source.captureId)
	}
})
