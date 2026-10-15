import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { test } from "node:test"
import { setTimeout as wait } from "node:timers/promises"
import { FileGis } from "../lib/file-gis.js"
import { FilesApi } from "../lib/files.js"
import { WorkspaceFiles } from "../lib/workspace-files.js"
import { FILE_LIMITS } from "../lib/file-contract.js"

const logger = { info() {}, warn() {}, error() {} }
const source = { kind: "runtime-capture", captureId: "raster", ref: { workspaceId: "workspace", workspaceEpoch: "epoch", path: "magnetics.tif" }, etag: '"raster"', sizeBytes: 20, consistency: "checked-copy", digest: { state: "ready", sha256: "a".repeat(64) } }
const members = [{ name: "magnetics.tif", source, sha256: "a".repeat(64) }]
const manifest = { kind: "raster", metadata: { bandCount: 2 } }
function raster() {
	return { schemaVersion: 1, kind: "raster-map-display", state: "ready", parser: "bounded-gdal-raster-map-v1", driver: "GTiff", driverVersion: "3.6.2", width: 4, height: 4, bandCount: 1, bands: [{ band: 1, description: "TMI", dataType: "Float32", nodata: -999, unit: "nT", scale: 2, offset: 1, colorInterpretation: "Gray", colorTableEntries: 0, maskFlags: ["nodata"], overviews: [] }], crsWkt: "EPSG:3857", geoTransform: [0, 1, 0.5, 4, 0.5, -1], displayCrs: "EPSG:3857", extent: [0, 0, 6, 6], footprint: { type: "Polygon", coordinates: [[[0, 4], [4, 6], [6, 2], [2, 0], [0, 4]]] }, displayOptions: {}, sourceFrame: { basis: "declared", wkt: "EPSG:3857", dataAxisMapping: [1, 2], units: "metre" }, operation: { engine: "GDAL 3.6.2 / PROJ 9.1.1", policy: "strict", identity: "Inverse Mercator", accuracy: null, sourceTargetCrs: "OGC:CRS84", inverse: "Exact inverse of the selected source operation", displayConversion: { identity: "EPSG:3856 (Popular Visualisation Pseudo-Mercator)", sourceCrs: "OGC:CRS84", targetCrs: "EPSG:3857", pipeline: "+proj=pipeline +step +proj=webmerc" } }, environmentFingerprint: "installed", environment: { gdal: "3.6.2", proj: "9.1.1", fingerprint: "installed", networkEnabled: false }, image: { band: 1, width: 4, height: 4, dataUrl: "data:image/png;base64,AA==", resampling: "nearest", overviewSelection: "base-resolution", stretch: { kind: "sample-min-max", label: "Display stretch", minimum: 10, maximum: 160 }, scaleOffsetApplied: false, colorTableApplied: false }, coverage: { outputPixels: 16, sampledSourcePixels: 16, visiblePixels: 15, transparentPixels: 1, decodedBlockBytes: 64, footprintEdgeSegments: 128 }, limits: { inputBytes: FILE_LIMITS.gisInputBytes, bands: 32, previewEdge: 512, sourcePixels: FILE_LIMITS.gisSourcePixels, decodedBlockBytes: FILE_LIMITS.gisDecodedBlockBytes, outputBytes: FILE_LIMITS.gisResponseBytes, memoryBytes: FILE_LIMITS.gisMemoryBytes, timeoutMs: 30000 }, warnings: [], inputDigests: [{ name: members[0].name, sha256: members[0].sha256 }] }
}
test("raster map query validates coordinate assumptions and positioned delivery rather than accepting a thumbnail", () => {
	const gis = new FileGis({ config: {}, limits: FILE_LIMITS })
	assert.deepEqual(gis.normalize({ operation: "map-display" }, manifest), { operation: "map-display", band: 1, displayOptions: {} })
	const query = { operation: "map-display", band: 2, displayOptions: { sourceCrs: { code: "EPSG:7844", axisOrder: "xy" }, allowApproximate: false } }
	assert.deepEqual(gis.normalize(query, manifest), query)
	for (const invalid of [{ ...query, url: "https://example.com" }, { ...query, band: 3 }, { ...query, displayOptions: { sourceCrs: { code: "EPSG:7844", axisOrder: "guess" } } }, { ...query, displayOptions: { sourceCrs: { code: "EPSG:7844", axisOrder: "xy", layerId: "layer-0" } } }]) assert.throws(() => gis.normalize(invalid, manifest))
	const result = gis.validateReply(raster(), members, "map-display", "raster", { band: 1, displayOptions: {} })
	assert.equal(result.payload.image.stretch.label, "Display stretch")
	for (const mutate of [(p) => { p.extent = null }, (p) => { p.footprint.coordinates[0].pop() }, (p) => { p.footprint.coordinates[0][1][0] = 7 }, (p) => { p.coverage.visiblePixels = 17 }, (p) => { p.operation.policy = "approximate" }, (p) => { p.displayOptions = { allowApproximate: true } }, (p) => { p.environment.fingerprint = "different" }, (p) => { p.image.overviewSelection = "GDAL-auto" }]) {
		const invalid = raster(); mutate(invalid)
		assert.throws(() => gis.validateReply(invalid, members, "map-display", "raster", { band: 1, displayOptions: {} }), { error: "invalid_gis_result" })
	}
})

async function api(t, native = false) {
	const base = await fs.mkdtemp(path.join(os.homedir(), ".gc-map-api-")), workspaceDir = path.join(base, "project")
	await fs.mkdir(workspaceDir)
	const files = await WorkspaceFiles.open({ workspaceDir, filesStateDir: path.join(base, "state"), filesAgentUids: [20001], filesWorkerUids: [997], filesWorkbookWorkerEnabled: false, filesGisWorkerEnabled: native, filesGisWorkerBin: process.env.GIS_INSTALLED_LAUNCHER, processingFactory: () => ({ async init() {}, async reconcileOperations() {}, async uploadCommitted() {}, async releaseFailedUpload() {}, async close() {}, async drain() { return { complete: true } }, async capabilities() { return { enabled: false } } }) }, logger)
	const adapter = new FilesApi(files, logger), server = http.createServer((req, res) => adapter.handle(req, res))
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
	t.after(async () => { await adapter.close(); await new Promise(resolve => server.close(resolve)); await files.close(); await fs.rm(base, { recursive: true, force: true }) })
	const headers = { "content-type": "application/json", "x-gc-workspace-id": files.identity.workspaceId, "x-gc-workspace-epoch": files.identity.workspaceEpoch }
	return { files, workspaceDir, async request(route, body, override = {}) {
		const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { headers: { ...headers, ...override }, ...(body === undefined ? {} : { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }) })
		return { status: res.status, body: await res.json() }
	} }
}
const document = files => ({ schemaVersion: 1, id: "view", title: "Exploration", workspace: files.identity, camera: { crs: "EPSG:3857", center: [0, 0], zoom: 4, rotation: 0 }, context: "topographic", layers: [], output: { layerIds: [], format: "png" } })
test("HTTP map saves are ordinary conditional files with content-bound replay and workspace fences", async t => {
	const f = await api(t), doc = document(f.files), input = { operationId: "save-map", path: "exploration.map.json", mode: "create", document: doc }
	const saved = await f.request("/files/map-views", input)
	assert.equal(saved.status, 201, JSON.stringify(saved.body)); assert.equal(saved.body.operation.state, "committed")
	assert.equal((await f.request("/files/map-views", input)).body.duplicate, true)
	assert.equal((await f.request("/files/map-views", { ...input, document: { ...doc, title: "Changed" } })).status, 409)
	const loaded = await f.request("/files/map-views?path=exploration.map.json")
	assert.equal(loaded.status, 200); assert.deepEqual(loaded.body.document, doc)
	const replace = { ...input, operationId: "replace-map", mode: "replace", baseObservation: loaded.body.observation, document: { ...doc, title: "New" } }
	assert.equal((await f.request("/files/map-views", replace)).status, 200)
	assert.equal((await f.request("/files/map-views", { ...replace, operationId: "stale" })).status, 409)
	assert.equal((await f.request("/files/map-views", { ...input, operationId: "foreign" }, { "x-gc-workspace-epoch": "replaced" })).body.operationId, "foreign")
	assert.equal((await f.request("/files/map-views", " ".repeat(65537))).status, 413)
	assert.equal((await f.request("/files/map-views?path=exploration.map.json&path=duplicate.map.json")).status, 400)
	await fs.writeFile(path.join(f.workspaceDir, input.path), JSON.stringify({ ...doc, credentials: "not-a-map-field" }))
	assert.equal((await f.request("/files/map-views?path=exploration.map.json")).body.error, "invalid_map_view")
})

test("installed HTTP map products prepare retained assays and warped rasters, then reopen without reading changed Current", { skip: !process.env.GIS_INSTALLED_LAUNCHER || !process.env.GIS_RASTER_MAP_FIXTURES ? "Installed GIS image and genuine raster fixtures required." : false }, async t => {
	const f = await api(t, true)
	assert.equal(f.files.gis.availability.state, "available", JSON.stringify(f.files.gis.availability))
	const info = (await f.request("/files/info")).body
	assert.ok(info.providers.includes("assay")); assert.ok(info.providerDetails.find(p => p.id === "raster").queryOperations.includes("map-display")); assert.equal(info.maps.extension, ".map.json")
	await fs.writeFile(path.join(f.workspaceDir, "samples.csv"), "id,x,y,Au\ns1,120,-30,<0.01\ns2,121,-31,3\n")
	await fs.copyFile(path.join(process.env.GIS_RASTER_MAP_FIXTURES, "rotated.tif"), path.join(f.workspaceDir, "magnetics.tif"))
	const layers = []
	for (const [kind, name, options] of [["assay", "samples.csv", { mode: "surface", columns: { id: "id", x: "x", y: "y", analyte: "Au" }, sourceCrs: { code: "OGC:CRS84", axisOrder: "xy" }, unit: { name: "ppm", basis: "user-assigned" } }], ["raster", "magnetics.tif", {}]]) {
		const capture = await f.request("/files/captures", { requestId: `capture-${kind}`, path: name, computeDigest: true }); assert.equal(capture.status, 201, JSON.stringify(capture.body))
		const prepared = await f.request("/files/preparations", { requestId: `prepare-${kind}`, type: kind, source: capture.body.source, options }); assert.equal(prepared.status, 202)
		let job
		for (let n = 0; n < 600; n++) { job = (await f.request(`/files/jobs/${prepared.body.jobId}`)).body; if (["succeeded", "failed"].includes(job.state)) break; await wait(20) }
		assert.equal(job.state, "succeeded", JSON.stringify(job.error)); await Promise.allSettled([...f.files.gis.pending])
		const m = job.result.representation, query = kind === "assay" ? { operation: "preview" } : { operation: "map-display", band: 1 }
		const preview = await f.request(`/files/representations/${m.id}/query`, query); assert.equal(preview.status, 200, JSON.stringify(preview.body))
		if (kind === "assay") { assert.equal(preview.body.points[0].value.state, "censored"); assert.equal(preview.body.placement.state, "ready") }
		else { assert.equal(preview.body.displayCrs, "EPSG:3857"); assert.ok(preview.body.coverage.transparentPixels > 0); query.displayOptions = { environmentFingerprint: preview.body.environmentFingerprint } }
		const style = kind === "assay" ? { kind, scale: "linear", breaks: [1], colors: ["#ff0000", "#00ff00"], symbol: "circle", size: 6, unit: "ppm", belowDetectionColor: "#999999", missingColor: "#eeeeee", invalidColor: "#ff00ff" } : { kind, band: 1, palette: "grayscale", stretch: { kind: "sample-min-max" } }
		layers.push({ id: kind, title: kind, sources: m.inputs.map(i => ({ ...i.source, digest: { state: "ready", sha256: i.sha256 } })), prepared: { id: m.id, kind }, locationRecipe: { prepare: { type: kind, options: m.options || {} }, query }, style, visible: true, opacity: 1, ownership: "client-owned", credits: ["Source credit"] })
	}
	const doc = { ...document(f.files), layers, output: { layerIds: layers.map(l => l.id), format: "png" } }
	const saved = await f.request("/files/map-views", { operationId: "save", path: "view.map.json", mode: "create", document: doc }); assert.equal(saved.status, 201, JSON.stringify(saved.body))
	await fs.writeFile(path.join(f.workspaceDir, "samples.csv"), "changed source")
	await fs.unlink(path.join(f.workspaceDir, "magnetics.tif"))
	const reopened = await f.request("/files/map-views?path=view.map.json")
	assert.equal(reopened.status, 200); assert.equal(reopened.body.layers[0].sources[0].currentRelation, "newer-current"); assert.equal(reopened.body.layers[1].sources[0].currentRelation, "missing")
	assert.ok(reopened.body.layers.every(l => l.prepared.availability === "available")); assert.deepEqual(reopened.body.document, doc)
	const retained = await f.request(`/files/representations/${layers[1].prepared.id}/query`, layers[1].locationRecipe.query)
	assert.equal(retained.status, 200); assert.equal(retained.body.kind, "raster-map-display")
})
