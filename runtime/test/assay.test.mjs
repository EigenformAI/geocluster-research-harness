import assert from "node:assert/strict"
import { test } from "node:test"
import { FileGis } from "../lib/file-gis.js"
import { FILE_LIMITS } from "../lib/file-contract.js"

export const surfaceRecipe = () => ({ mode: "surface", columns: { id: "ID", x: "X", y: "Y", analyte: "Au", qualifier: "Q" }, sourceCrs: { code: "OGC:CRS84", axisOrder: "xy" }, unit: { name: "ppm", basis: "user-assigned" } })
export const collarRecipe = () => ({ mode: "collar-summary", columns: { hole: "Hole", from: "From", to: "To", analyte: "Au", qualifier: "Q" }, collars: { member: "Collars.tsv", columns: { hole: "Hole", x: "X", y: "Y" } }, sourceCrs: { code: "OGC:CRS84", axisOrder: "xy" }, unit: { name: "ppm", basis: "source-declared" }, depthUnit: "m", depthWindow: { kind: "range", from: 0, to: 50 } })
export const source = (name, id = name) => ({ kind: "runtime-capture", captureId: id, ref: { workspaceId: "workspace", workspaceEpoch: "epoch", path: name }, sizeBytes: 20, etag: '"capture"', consistency: { basis: "checked-copy" }, digest: { state: "not-requested" } })
const service = () => new FileGis({ config: {}, limits: FILE_LIMITS, captures: { requireAdmission() {} }, state: {}, logger: {} })

test("assay recipe defaults are normalized into preparation identity; strict fields reject reinterpretation", () => {
	const gis = service(), request = { requestId: "assay", type: "assay", source: source("Samples.csv"), options: surfaceRecipe() }
	assert.equal(gis.inputSources(request).length, 1)
	const normalized = gis.assayOptions(request.options)
	assert.deepEqual(normalized.numbers, { missingTokens: ["", "NA", "N/A", "NULL"], sentinels: [] })
	assert.equal(normalized.allowApproximate, false)
	assert.deepEqual(gis.assayOptions({ ...request.options, ...normalized }), normalized)
	for (const options of [undefined, { ...request.options, url: "https://example.com" }, { ...request.options, columns: { ...request.options.columns, extra: "secret" } }, { ...request.options, sourceCrs: { code: "EPSG:4326", axisOrder: "guess" } }, { ...collarRecipe(), depthUnit: "ft" }, { ...collarRecipe(), depthWindow: { kind: "range", from: 50, to: 50 } }, { ...request.options, numbers: { missingTokens: [1], sentinels: [] } }]) assert.throws(() => gis.assayOptions(options), { status: 400, error: "invalid_request" })
})

test("assay joins require the named captured companion and permit different directories only within one workspace", () => {
	const gis = service(), members = [{ name: "Samples.csv", source: source("assays/Samples.csv") }, { name: "Collars.tsv", source: source("locations/Collars.tsv") }]
	assert.doesNotThrow(() => gis.validateBundle(members, "assay", gis.assayOptions(collarRecipe())))
	assert.throws(() => gis.validateBundle(members, "assay", gis.assayOptions(surfaceRecipe())), { error: "gis_bundle_member" })
	assert.throws(() => gis.validateBundle(members.slice(0, 1), "assay", gis.assayOptions(collarRecipe())), { error: "gis_bundle_missing" })
	assert.throws(() => gis.validateBundle([members[0], { ...members[1], source: { ...members[1].source, ref: { ...members[1].source.ref, workspaceEpoch: "foreign" } } }], "assay", gis.assayOptions(collarRecipe())), { error: "gis_bundle_parent" })
	assert.throws(() => gis.validateBundle([members[0], { name: "samples.CSV", source: source("other/samples.CSV") }], "assay", gis.assayOptions(collarRecipe())), { error: "gis_bundle_ambiguous" })
})

test("assay preview has no recipe override and returns recorded metadata without native dispatch", async () => {
	const gis = service(), recipe = gis.assayOptions(surfaceRecipe()), manifest = { kind: "assay", id: "product", options: recipe, metadata: { schemaVersion: 1, kind: "assay", parser: "bounded-gdal-assay-v1" } }
	assert.deepEqual(gis.normalize({ operation: "preview" }, manifest), { operation: "preview" })
	assert.throws(() => gis.normalize({ operation: "preview", sourceCrs: { code: "EPSG:3857", axisOrder: "xy" } }, manifest), { error: "invalid_request" })
	assert.throws(() => gis.normalize({ operation: "attributes" }, manifest), { error: "invalid_operation" })
	let released = false, validated = false
	gis.availability = { state: "available" }; gis.open = async () => ({ manifest, members: [{ source: source("Samples.csv") }], release: async () => { released = true } })
	gis.validateAssay = (metadata, members, options) => { assert.equal(metadata, manifest.metadata); assert.equal(options, recipe); validated = true }
	gis.reader = { read() { assert.fail("Recorded assay preview must not invoke a later parser/CRS environment.") } }
	const result = await gis.query("product", { operation: "preview" })
	assert.equal(result.parser, manifest.metadata.parser); assert.equal(result.representationId, "product"); assert.equal(result.sources[0].captureId, "Samples.csv")
	assert.equal(released, true); assert.equal(validated, true)
})
