import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"
import { FileGis } from "../lib/file-gis.js"
import { FileMapViews } from "../lib/file-map-views.js"
import { FILE_LIMITS, FileError, noPersistence, observation } from "../lib/file-contract.js"
import { buildFilesOpenApi } from "../lib/files-openapi.js"

// Use an existing dependency installation without adding runtime dependencies.
// FILES_SCHEMA_DEPENDENCIES selects its package.json when running outside that installation.
const require = createRequire(process.env.FILES_SCHEMA_DEPENDENCIES || new URL("../package.json", import.meta.url))
const Ajv = require("ajv/dist/2020.js").default
const addFormats = require("ajv-formats")
function contract(limits) {
	const spec = JSON.parse(JSON.stringify(buildFilesOpenApi({ limits }))), ajv = new Ajv({ strict: false, strictNumbers: true, allErrors: true })
	addFormats(ajv)
	ajv.addSchema(spec, "files")
	const validate = (name, value, expected = true) => {
		const check = ajv.compile({ $ref: `files#/components/schemas/${name}` })
		assert.equal(check(value), expected, `${name}: ${ajv.errorsText(check.errors)}\n${JSON.stringify(value)}`)
	}
	return { spec, validate, ajv }
}
const identity = { workspaceId: "workspace", workspaceEpoch: "epoch" }
const source = (name, captureId = name) => ({ kind: "runtime-capture", ref: { ...identity, path: name }, captureId, etag: `"${captureId}"`, sizeBytes: 20, consistency: "checked-copy", digest: { state: "not-requested", sha256: null } })
const service = () => new FileGis({ config: {}, captures: { requireAdmission() {} }, state: {}, limits: FILE_LIMITS })
const recipe = (collar = false) => ({ mode: collar ? "collar-summary" : "surface", columns: collar ? { hole: "Hole", from: "From", to: "To", analyte: "Au" } : { id: "ID", x: "X", y: "Y", analyte: "Au" }, sourceCrs: { code: "OGC:CRS84", axisOrder: "xy" }, unit: { name: "ppm", basis: "user-assigned" }, ...(collar ? { collars: { member: "Collars.tsv", columns: { hole: "Hole", x: "X", y: "Y" } }, depthUnit: "m" } : {}) })
const frame = () => ({ basis: "user-assumed", wkt: "GEOGCRS[WGS 84]", dataAxisMapping: [1, 2], units: "degree" })
const operation = () => ({ engine: "GDAL 3 / PROJ 9", policy: "strict", identity: "identity", accuracy: null })
function assay(collar = false) {
	const gis = service(), options = gis.assayOptions(recipe(collar)), name = collar ? "Assays.csv" : "Samples.csv"
	const members = [source(name), ...(collar ? [source("Collars.tsv")] : [])].map((s) => ({ name: s.ref.path, source: s, sha256: "a".repeat(64) }))
	const lineage = { memberName: name, recordOrdinal: 2, locator: `${name}:2`, id: "A" }
	const value = { state: "censored", value: 0.1, qualifier: "<" }
	const row = { ...lineage, raw: collar ? { hole: "A", from: "0", to: "10", analyte: "<0.1", qualifier: "" } : { id: "A", x: "10", y: "30", analyte: "<0.1", qualifier: "" }, value, joinState: collar ? "matched" : "surface", depth: collar ? { from: 0, to: 10, valid: true, inWindow: true } : null }
	const collarRow = { memberName: "Collars.tsv", recordOrdinal: 2, locator: "Collars.tsv:2", id: "A", raw: { hole: "A", x: "10", y: "30" }, duplicate: false, geometry: { type: "Point", coordinates: [10, 30] } }
	const point = { ...(collar ? { memberName: collarRow.memberName, recordOrdinal: 2, locator: collarRow.locator, id: "A" } : lineage), geometry: { type: "Point", coordinates: [10, 30] }, value: collar ? { state: "all-censored", value: null, qualifier: null } : value, rowLocators: [row.locator], maximumLocators: [], locationMeaning: collar ? "collar-summary" : "surface-sample" }
	const counts = Object.fromEntries(["dataRows", "collarRows", "points", "mapped", "unmapped", "detected", "censored", "missing", "invalid", "duplicateCollarIds", "duplicateCollarRows", "unmatchedRows", "ambiguousRows", "invalidDepthRows", "outsideWindowRows", "invalidCoordinateRows", "missingIdRows"].map((key) => [key, 0]))
	Object.assign(counts, { dataRows: 1, collarRows: collar ? 1 : 0, points: 1, mapped: 1, censored: 1 })
	const metadata = { schemaVersion: 1, kind: "assay", parser: "bounded-gdal-assay-v1", recipe: options, unit: options.unit, summaryRule: collar ? "maximum-detected" : "source-value", tables: members.map((m, n) => ({ memberName: m.name, format: n ? "tsv" : "csv", columns: Object.values(n ? options.collars.columns : options.columns), dataRows: 1 })), rows: [row], collarRows: collar ? [collarRow] : [], points: [point], counts, diagnostics: [], placement: { state: "ready", sourceFrame: frame(), environmentFingerprint: "installed", displayCrs: "OGC:CRS84", operation: operation(), displayByLocator: { [point.locator]: point.geometry }, extent: [10, 30, 10, 30], coverage: { sourceFeatures: 1, retainedDrawable: 1, nullOrEmpty: 0, decodeOmitted: 0, displayed: 1 }, reasons: [] }, operationFingerprint: "b".repeat(64), coverage: "Complete recorded product", warnings: [], limits: { inputBytes: FILE_LIMITS.gisInputBytes, rowsPerTable: FILE_LIMITS.gisAssayRows, points: FILE_LIMITS.gisAssayPoints, columns: FILE_LIMITS.gisAssayColumns, cellBytes: FILE_LIMITS.gisAssayCellBytes, manifestBytes: FILE_LIMITS.gisAssayManifestBytes, responseBytes: FILE_LIMITS.gisAssayResponseBytes, timeoutMs: 30000 } }
	const manifest = { schemaVersion: 1, kind: "assay", id: collar ? "collar-product" : "surface-product", source: members[0].source, inputs: members, options, consistency: { basis: collar ? "independent-captures" : "single-capture", limitations: [] }, provider: { id: "assay", build: "installed" }, parser: metadata.parser, metadata, limits: gis.publicLimits(), retention: "input-captures" }
	return { gis, metadata, manifest, members, options }
}
function document() {
	const f = assay(), common = { visible: true, opacity: 1, ownership: "client-owned", credits: [] }
	return { schemaVersion: 1, id: "map", title: "Recorded map", workspace: identity, camera: { crs: "EPSG:3857", center: [0, 0], zoom: 6, rotation: 0 }, context: "off", layers: [
		{ ...common, id: "assay", title: "Samples", sources: [f.members[0].source], prepared: { id: f.manifest.id, kind: "assay" }, locationRecipe: { prepare: { type: "assay", options: f.options }, query: { operation: "preview" } }, style: { kind: "assay", scale: "log", breaks: [0.1, 1], colors: ["#112233", "#445566", "#778899"], symbol: "circle", size: 6, unit: "ppm", belowDetectionColor: "#aaaaaa", missingColor: "#eeeeee", invalidColor: "#ff00ff" } },
		{ ...common, id: "raster", title: "Magnetics", sources: [source("magnetics.tif")], prepared: { id: "raster-product", kind: "raster" }, locationRecipe: { prepare: { type: "raster", options: {} }, query: { operation: "map-display", band: 1, displayOptions: { sourceCrs: { code: "EPSG:4326", axisOrder: "xy" } } } }, style: { kind: "raster", band: 1, palette: "viridis", stretch: { kind: "sample-min-max" } } },
		{ ...common, id: "vector", title: "Roads", sources: [source("roads.geojson")], prepared: { id: "vector-product", kind: "vector" }, locationRecipe: { prepare: { type: "vector", options: {} }, query: { operation: "preview", displayOptions: { sourceCrs: { layerId: "layer-0", code: "EPSG:4326", axisOrder: "xy" } } } }, style: { kind: "vector", color: "#336699", width: 2, pointSize: 5 } },
	], output: { layerIds: ["assay", "raster"], format: "png" } }
}

test("OpenAPI accepts assay preparation defaults and the bounded map-display query", () => {
	const { validate } = contract({ gisBands: 4 }), gis = service()
	for (const collar of [false, true]) {
		const options = recipe(collar), request = { requestId: "prepare", type: "assay", source: source(collar ? "Assays.csv" : "Samples.csv"), options, ...(collar ? { companions: [source("Collars.tsv")] } : {}) }
		gis.inputSources(request)
		validate("PreparationRequest", request)
		validate("AssayOptions", options)
		validate("AssayRecordedOptions", options, false)
		validate("AssayRecordedOptions", gis.assayOptions(options))
		for (const patch of [{ allowApproximate: null }, { sourceCrs: { code: "EPSG:4326", axisOrder: "guess" } }, { unit: { name: "ppm", basis: "inferred" } }, { numbers: { sentinels: ["-999"] } }, { columns: { ...options.columns, secret: "Other" } }]) validate("PreparationRequest", { ...request, options: { ...options, ...patch } }, false)
	}
	validate("RepresentationQuery", { operation: "map-display", band: 4, displayOptions: { allowApproximate: false, sourceCrs: { code: "EPSG:4326", axisOrder: "xy" } } })
	for (const query of [{ operation: "map-display", band: 5 }, { operation: "map-display", displayOptions: { sourceCrs: { layerId: "layer-0", code: "EPSG:4326", axisOrder: "xy" } } }, { operation: "map-display", url: "https://example.com" }]) validate("RepresentationQuery", query, false)
})

test("actual recorded assay previews, ready results and receipts validate through public unions", async () => {
	const { validate } = contract()
	for (const collar of [false, true]) {
		const { gis, metadata, members, options, manifest } = assay(collar)
		gis.validateAssay(metadata, members, options)
		gis.availability = { state: "available" }; gis.open = async () => ({ manifest, members, release: async () => {} })
		const preview = await gis.query(manifest.id, { operation: "preview" })
		validate("RepresentationQueryResponse", { filesContractVersion: 1, ...preview })
		validate("RepresentationResponse", { filesContractVersion: 1, ...manifest })
		gis.captures.makeLease = (kind, id) => ({ leaseId: `lease-${id}`, source: { kind, id }, expiresAt: "2026-10-07T12:00:00Z", ttlSeconds: 300 })
		gis.captures.record = async () => ({ source: manifest.source }); gis.state.transaction = async () => {}
		const ready = await gis.readyLocked(manifest, 201), { status, ...payload } = ready
		validate("FileWorkResult", ready)
		validate("PreparationResponse", { filesContractVersion: 1, ...payload })
		validate("RequestReceipt", { filesContractVersion: 1, requestId: "prepare", type: "preparation", preparationType: "assay", state: "succeeded", result: ready, error: null })
		validate("FileJob", { filesContractVersion: 1, jobId: "job", type: "preparation", preparationType: "assay", state: "succeeded", stage: "ready", progress: { bytesDone: 20, totalBytes: 20, elapsedMs: 1 }, result: ready, error: null })
		for (const mutate of [(p) => { p.points[0].value.value = "0.1" }, (p) => { p.rows[0].recordOrdinal = 1 }, (p) => { p.placement.displayByLocator[p.points[0].locator].coordinates.push(0) }, (p) => { p.placement.operation = null }, (p) => { p.counts.mapped = -1 }, (p) => { p.diagnostics = [{ code: "guessed", locators: [p.rows[0].locator] }] }, (p) => { delete p.recipe.numbers }]) { const invalid = structuredClone(preview); mutate(invalid); validate("RepresentationQueryResponse", { filesContractVersion: 1, ...invalid }, false) }
		const unavailable = structuredClone(preview)
		Object.assign(unavailable.placement, { state: "unavailable", operation: null, displayByLocator: {}, extent: null, reasons: ["Missing grid"] })
		unavailable.placement.coverage.displayed = unavailable.counts.mapped = 0; unavailable.counts.unmapped = 1
		unavailable.diagnostics = [{ code: "unplaced-point", locators: [unavailable.points[0].locator] }]
		gis.validateAssay(unavailable, members, options)
		validate("RepresentationQueryResponse", { filesContractVersion: 1, ...unavailable })
	}
})

test("raster map-display response mirrors native positioning, operation, coverage and image provenance", () => {
	const { validate } = contract()
	const payload = { filesContractVersion: 1, schemaVersion: 1, kind: "raster-map-display", state: "ready", parser: "bounded-gdal-raster-map-v1", sources: [source("magnetics.tif")], representationId: "raster-product", driver: "GTiff", driverVersion: "3.6.2", width: 4, height: 4, bandCount: 1, bands: [{ band: 1, description: "magnetics", dataType: "UInt16", nodata: 65535, scale: 2, offset: 100, unit: "nT", colorInterpretation: "Gray", colorTableEntries: 0, maskFlags: ["nodata"], overviews: [] }], crsWkt: null, geoTransform: [120, 0.04, 0.025, -30, 0.012, -0.03], sourceFrame: frame(), displayOptions: {}, displayCrs: "EPSG:3857", extent: [0, 0, 4, 4], footprint: { type: "Polygon", coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]] }, operation: { ...operation(), sourceTargetCrs: "OGC:CRS84", inverse: "Exact inverse of the selected source operation", displayConversion: { identity: "EPSG:3856 (Popular Visualisation Pseudo-Mercator)", sourceCrs: "OGC:CRS84", targetCrs: "EPSG:3857", pipeline: "+proj=pipeline +step +proj=webmerc" } }, environmentFingerprint: "installed", environment: { gdal: "3.6.2", proj: "9.1.1", fingerprint: "installed", networkEnabled: false }, image: { band: 1, width: 4, height: 4, dataUrl: "data:image/png;base64,AA==", resampling: "nearest", overviewSelection: "base-resolution", stretch: { kind: "sample-min-max", label: "Display stretch", minimum: 10, maximum: 160 }, scaleOffsetApplied: false, colorTableApplied: false }, coverage: { outputPixels: 16, sampledSourcePixels: 16, visiblePixels: 15, transparentPixels: 1, decodedBlockBytes: 64, footprintEdgeSegments: 128 }, limits: { inputBytes: FILE_LIMITS.gisInputBytes, bands: 32, previewEdge: 512, sourcePixels: FILE_LIMITS.gisSourcePixels, decodedBlockBytes: FILE_LIMITS.gisDecodedBlockBytes, outputBytes: FILE_LIMITS.gisResponseBytes, memoryBytes: FILE_LIMITS.gisMemoryBytes, timeoutMs: 30000 }, warnings: [] }
	validate("RepresentationQueryResponse", payload)
	for (const mutate of [(p) => { p.image.overviewSelection = "GDAL-auto" }, (p) => { p.coverage = "sampled image" }, (p) => { delete p.operation.inverse }, (p) => { p.geoTransform = null }, (p) => { p.footprint.coordinates[0][0] = [0] }, (p) => { p.environment.networkEnabled = true }, (p) => { p.state = "unavailable" }]) { const invalid = structuredClone(payload); mutate(invalid); validate("RepresentationQueryResponse", invalid, false) }
})

test("saved map documents are recursively closed, with explicit provider recipes and styles", () => {
	const { validate } = contract(), valid = document()
	validate("MapViewDocument", valid)
	const collar = assay(true), joined = structuredClone(valid)
	Object.assign(joined.layers[0], { sources: collar.members.map((m) => m.source), prepared: { id: collar.manifest.id, kind: "assay" }, locationRecipe: { prepare: { type: "assay", options: collar.options }, query: { operation: "preview" } } })
	validate("MapViewDocument", joined)
	for (const mutate of [(d) => { d.url = "https://example.com" }, (d) => { d.workspace.token = "secret" }, (d) => { d.camera.extra = true }, (d) => { d.camera.center.push(0) }, (d) => { d.layers[0].sources[0].ref.token = "secret" }, (d) => { d.layers[0].sources[0].digest.credentials = {} }, (d) => { d.layers[0].sources[0].etag = 'W/"weak"' }, (d) => { d.layers[0].sources[0].digest.sha256 = "a".repeat(64) }, (d) => { delete d.layers[0].locationRecipe.prepare.options.numbers }, (d) => { delete d.layers[0].locationRecipe.prepare.options.allowApproximate }, (d) => { d.layers[0].locationRecipe.query.band = 1 }, (d) => { d.layers[0].style.image = {} }, (d) => { d.layers[1].locationRecipe.query.displayOptions.sourceCrs.layerId = "layer-0" }, (d) => { d.layers[1].locationRecipe.query.operation = "preview" }, (d) => { d.layers[2].locationRecipe.prepare.options.url = "https://example.com" }, (d) => { d.layers[2].style.kind = "raster" }, (d) => { d.output.context = "satellite" }, (d) => { d.output.layerIds.push("assay") }, (d) => { d.layers[0].opacity = 1.1 }, (d) => { d.layers[0].title = "x".repeat(257) }]) { const invalid = structuredClone(valid); mutate(invalid); validate("MapViewDocument", invalid, false) }
	validate("MapViewSaveRequest", { operationId: "save", path: "views/a.map.json", mode: "create", document: valid })
	validate("MapViewSaveRequest", { operationId: "save", path: "views/a.map.json", mode: "replace", baseObservation: "observed", document: valid })
	for (const patch of [{ path: "a.json" }, { path: "../a.map.json" }, { mode: "force-replace" }, { mode: "replace" }, { baseObservation: "observed" }]) validate("MapViewSaveRequest", { operationId: "save", path: "a.map.json", mode: "create", document: valid, ...patch }, false)
})

test("map-view load validates actual independent capture, Current, product and recovery outcomes", async () => {
	const { validate } = contract(), doc = document(), bytes = Buffer.from(JSON.stringify(doc)), stat = { dev: 1n, ino: 2n, mode: 0o100644n, size: BigInt(bytes.length), mtimeNs: 3n, ctimeNs: 4n, isFile: () => true }
	const ref = { ...identity, path: "views/a.map.json" }, observed = observation(ref, stat)
	const workspace = { identity, ref: () => ref, state: { get: async () => null }, safeFs: { stat: async () => stat }, openLive: async () => ({ stat, observation: observed, handle: { stat: async () => stat, close: async () => {} } }), captures: { readPrefix: async () => bytes, get: async (kind, id) => { if (id === "magnetics.tif") throw new FileError(410, "source_expired", "Expired capture"); const s = doc.layers.flatMap((l) => l.sources).find((s) => s.captureId === id); return { source: s, currentRelation: "missing", currentObservation: null } } }, representation: async (id) => { const layer = doc.layers.find((l) => l.prepared.id === id); if (layer.prepared.kind === "raster") throw new FileError(410, "index_expired", "Expired product"); return { id, kind: layer.prepared.kind, source: layer.sources[0], inputs: layer.sources.map((source) => ({ source, sha256: "a".repeat(64) })), options: layer.locationRecipe.prepare.options } } }
	const maps = new FileMapViews(workspace), loaded = await maps.load(ref.path)
	validate("MapViewLoadResponse", { filesContractVersion: 1, ...loaded })
	assert.equal(loaded.layers[0].sources[0].captureAvailability, "available"); assert.equal(loaded.layers[0].sources[0].currentRelation, "missing"); assert.equal(loaded.layers[0].prepared.availability, "available")
	assert.equal(loaded.layers[1].sources[0].captureAvailability, "unavailable"); assert.equal(loaded.layers[1].sources[0].currentRelation, "unknown"); assert.equal(loaded.layers[1].prepared.availability, "unavailable")
	for (const mutate of [(r) => { r.layers[0].sources[0].currentRelation = "available" }, (r) => { delete r.layers[0].sources[0].captureAvailability }, (r) => { r.layers[0].recovery.actions = ["auto-rebuild"] }, (r) => { r.layers[0].prepared.kind = "workbook" }]) { const invalid = structuredClone(loaded); mutate(invalid); validate("MapViewLoadResponse", { filesContractVersion: 1, ...invalid }, false) }
	validate("MapViewDescriptor", maps.descriptor())
	validate("FilesInfo", { filesContractVersion: 1, ...identity, maps: maps.descriptor() })
})

test("normalized surface and collar recipes round-trip through saved-file validation without grammar drift", async () => {
	const { validate } = contract(), gis = service()
	for (const collar of [false, true]) for (const explicit of [false, true]) {
		const f = assay(collar), supplied = recipe(collar)
		if (explicit) Object.assign(supplied, { allowApproximate: true, numbers: { missingTokens: ["", "not sampled"], sentinels: [-999] }, environmentFingerprint: "recorded", columns: { ...supplied.columns, qualifier: "Q" } })
		const options = gis.assayOptions(supplied), doc = document()
		doc.layers = [{ ...doc.layers[0], sources: f.members.map(m => m.source), prepared: { id: f.manifest.id, kind: "assay" }, locationRecipe: { prepare: { type: "assay", options }, query: { operation: "preview" } } }]
		doc.output.layerIds = [doc.layers[0].id]
		let restored
		const maps = new FileMapViews({ identity, captures: { get: async () => { throw new FileError(410, "source_expired", "Expired capture") } }, state: { get: async () => null }, representation: async () => { throw new FileError(410, "index_expired", "Expired product") }, upload: async stream => { const chunks = []; for await (const bytes of stream) chunks.push(bytes); restored = JSON.parse(Buffer.concat(chunks).toString()); return { status: 201, operation: {} } } })
		validate("MapViewDocument", doc)
		assert.equal((await maps.save({ operationId: "round-trip", path: "a.map.json", mode: "create", document: doc })).status, 201)
		assert.deepEqual(gis.assayOptions(restored.layers[0].locationRecipe.prepare.options), options)
	}
})

test("map operation envelopes discriminate nested receipts and every public schema compiles", () => {
	const { spec, validate, ajv } = contract()
	const operation = { operationId: "save", state: "committed", action: "upload", addresses: [{ ...identity, path: "a.map.json" }], publishedSource: null, publishedObservation: null, committedAt: "2026-10-07T12:00:00Z", persistence: noPersistence(), reconciliation: { required: false, inspectionRef: null, replayAllowed: false } }
	validate("OperationResponse", { filesContractVersion: 1, operation, duplicate: true })
	validate("OperationResponse", { filesContractVersion: 1, operation: { ...operation, state: "streaming" } })
	validate("OperationResponse", { filesContractVersion: 1, ...operation }, false)
	for (const name of Object.keys(spec.components.schemas)) assert.ok(ajv.compile({ $ref: `files#/components/schemas/${name}` }), name)
})

test("provider details advertise actual recorded assay scope and raster map display", () => {
	const { validate } = contract(), gis = service()
	gis.availability = { state: "available" }; gis.build = "installed"; gis.reader = {}
	for (const provider of gis.descriptors()) validate("PreviewProvider", provider)
	const provider = gis.descriptors().find((p) => p.id === "assay")
	validate("PreviewProvider", { ...provider, queryScope: "window" }, false)
	const raster = gis.descriptors().find((p) => p.id === "raster")
	validate("RasterProvider", { ...raster, queryOperations: ["prepare", "preview", "map-display"], queryScope: "bounded-image-or-map-display" })
})
