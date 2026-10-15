import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { test } from "node:test"
import { setTimeout as wait } from "node:timers/promises"
import { GisReader } from "../lib/gis-reader.js"

const launcherPath = process.env.GIS_INSTALLED_LAUNCHER
const installed = { skip: !launcherPath ? "Set GIS_INSTALLED_LAUNCHER to test installed assay parsing and placement." : false }
const surface = () => ({ mode: "surface", columns: { id: "ID", x: "X", y: "Y", analyte: "Au", qualifier: "Q" }, sourceCrs: { code: "OGC:CRS84", axisOrder: "xy" }, unit: { name: "ppm", basis: "user-assigned" } })
const collar = () => ({ mode: "collar-summary", columns: { hole: "Hole", from: "From", to: "To", analyte: "Au", qualifier: "Q" }, collars: { member: "Collars.tsv", columns: { hole: "Hole", x: "X", y: "Y" } }, sourceCrs: { code: "OGC:CRS84", axisOrder: "xy" }, unit: { name: "ppm", basis: "source-declared" }, depthUnit: "m", depthWindow: { kind: "range", from: 0, to: 50 } })
async function fixture(t, limits) {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "gc-assay-")), reader = new GisReader({ launcherPath, limits })
	await reader.init(); assert.equal(reader.availability.state, "available", JSON.stringify(reader.availability))
	t.after(async () => { await reader.close(); await fs.rm(base, { recursive: true, force: true }) })
	return { reader, async read(tables, options = surface()) {
		const members = []
		try {
			for (const [name, content] of Object.entries(tables)) { const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content), filename = path.join(base, name); await fs.writeFile(filename, bytes); members.push({ name, handle: await fs.open(filename, "r"), source: { sizeBytes: bytes.length, digest: { state: "ready", sha256: crypto.createHash("sha256").update(bytes).digest("hex") } } }) }
			return await reader.read({ members, kind: "assay", operation: "manifest", options })
		} finally { await Promise.all(members.map((m) => m.handle.close())) }
	} }
}

test("installed assay: UTF-8 quoted CSV keeps raw qualifiers/record lineage and separates native XY from CRS84", installed, async (t) => {
	const f = await fixture(t), data = '\uFEFFID,X,Y,Au,Q\r\n"s,α",10,30,+1.20e1,=\r\n"two\nlines",11,31,<=0.02,<=\r\nthree,12,32,NA,\r\nfour,13,33,5,ND\r\nfive,14,34,<0.2,=\r\nsix,15,35,"1,000",\r\nseven,16,36,-999,\r\neight,bad,37,2,\r\nnine,17,38,abc,\r\nten,18,39,0.1,???\r\n'
	const result = await f.read({ "Samples.csv": data }, { ...surface(), numbers: { missingTokens: ["", "NA"], sentinels: [-999] } })
	assert.equal(result.parser, "bounded-gdal-assay-v1"); assert.equal(result.kind, "assay"); assert.equal(result.rows.length, 10)
	assert.deepEqual(result.rows.map((r) => r.value.state), ["detected", "censored", "missing", "censored", "invalid", "invalid", "missing", "detected", "invalid", "invalid"])
	assert.equal(result.rows[0].raw.analyte, "+1.20e1"); assert.equal(result.rows[1].id, "two\nlines"); assert.equal(result.rows[1].locator, "Samples.csv:3"); assert.equal(result.rows[1].recordOrdinal, 3)
	assert.equal(result.points.length, 9); assert.deepEqual(result.points[0].geometry, { type: "Point", coordinates: [10, 30] }); assert.deepEqual(result.placement.displayByLocator["Samples.csv:2"].coordinates, [10, 30])
	assert.equal(result.placement.state, "ready"); assert.equal(result.counts.invalidCoordinateRows, 1); assert.equal(result.unit.name, "ppm"); assert.equal(result.operationFingerprint.length, 64)
	const yx = await f.read({ "Samples.csv": "ID,X,Y,Au,Q\na,30,10,2,\n" }, { ...surface(), sourceCrs: { code: "OGC:CRS84", axisOrder: "yx" } })
	assert.deepEqual(yx.points[0].geometry.coordinates, [30, 10]); assert.deepEqual(yx.placement.displayByLocator["Samples.csv:2"].coordinates, [10, 30])
})

test("installed assay: maximum detected, half-open overlap, duplicates, unmatched/depth diagnostics and all-censored remain distinct", installed, async (t) => {
	const f = await fixture(t), result = await f.read({ "Assays.csv": "Hole,From,To,Au,Q\nA,0,50,2,\nA,50,60,999,\nA,0,10,999,\nA,49,51,5,\nA,10,20,<100,\nB,0,11,<7,\nB,10,20,NA,\nC,0,11,NA,\nD,0,11,bad,\nD,9,8,9,\nE,0,11,88,\nZ,0,11,77,\nA,0,0,66,\nD,-1,8,55,\n", "Collars.tsv": "Hole\tX\tY\nA\t10\t30\nB\t11\t31\nC\t12\t32\nD\t13\t33\nE\t14\t34\nE\t15\t35\n" }, { ...collar(), depthWindow: { kind: "range", from: 10, to: 50 } })
	assert.deepEqual(result.points.map((p) => [p.id, p.value.state, p.value.value]), [["A", "detected", 5], ["B", "all-censored", null], ["C", "missing", null], ["D", "invalid", null]])
	assert.deepEqual(result.points[0].rowLocators, ["Assays.csv:2", "Assays.csv:5", "Assays.csv:6"]); assert.deepEqual(result.points[0].maximumLocators, ["Assays.csv:5"])
	assert.equal(result.points[0].locator, "Collars.tsv:2"); assert.equal(result.points[0].locationMeaning, "collar-summary")
	assert.equal(result.counts.duplicateCollarIds, 1); assert.equal(result.counts.duplicateCollarRows, 2); assert.equal(result.counts.ambiguousRows, 1); assert.equal(result.counts.unmatchedRows, 1); assert.equal(result.counts.invalidDepthRows, 3); assert.equal(result.counts.outsideWindowRows, 2)
	assert.deepEqual(result.diagnostics.find((d) => d.code === "duplicate-collar-id").locators, ["Collars.tsv:6", "Collars.tsv:7"])
})

test("installed assay: malformed UTF-8/quotes, unequal records and ambiguous headers fail without partial data", installed, async (t) => {
	const f = await fixture(t)
	for (const data of [Buffer.from([0xff, 10]), 'ID,X,Y,Au,Q\na,10,30,"unterminated,\n', 'ID,X,Y,Au,Q\na,10,30,"1"garbage,\n', "ID,X,Y,Au,Q\na,10,30,1\n", "ID,X,X,Au,Q\na,10,30,1,\n", "ID,X,Y,Au,Q\na,10,30,1,\u0000\n"]) await assert.rejects(f.read({ "Samples.csv": data }), e => e.error === "assay_table_invalid")
})

test("installed collar summary: every valid unambiguous collar remains a missing point when no intervals contribute", installed, async t => {
	const f = await fixture(t), options = collar()
	const result = await f.read({ "Assays.csv": "Hole,From,To,Au,Q\nA,60,70,2,\n", "Collars.tsv": "Hole\tX\tY\nA\t10\t30\nB\t11\t31\n" }, options)
	assert.deepEqual(result.points.map(p => [p.id, p.value.state, p.rowLocators]), [["A", "missing", []], ["B", "missing", []]])
	assert.equal(result.counts.points, 2); assert.equal(result.counts.mapped, 2); assert.equal(result.counts.outsideWindowRows, 1)
	const { FileGis } = await import("../lib/file-gis.js"), gis = new FileGis({ config: {}, limits: {} })
	const members = result.inputDigests.map(d => ({ name: d.name }))
	gis.validateAssay(result, members, result.recipe)
	const incomplete = structuredClone(result); incomplete.points.pop()
	assert.throws(() => gis.validateAssay(incomplete, members, result.recipe), { error: "invalid_gis_result" })
})

test("installed assay: every table/point/column/cell/manifest/response ceiling fails explicitly", installed, async (t) => {
	for (const [limits, data, reason] of [
		[{ assayRows: 1 }, "ID,X,Y,Au,Q\na,10,30,1,\nb,11,31,2,\n", "assay_row_limit"],
		[{ assayPoints: 1 }, "ID,X,Y,Au,Q\na,10,30,1,\nb,11,31,2,\n", "assay_point_limit"],
		[{ assayColumns: 4 }, "ID,X,Y,Au,Q\na,10,30,1,\n", "assay_column_limit"],
		[{ assayCellBytes: 4 }, "ID,X,Y,Au,Q\nabcde,10,30,1,\n", "assay_cell_limit"],
		[{ assayManifestBytes: 100 }, "ID,X,Y,Au,Q\na,10,30,1,\n", "assay_manifest_limit"],
		[{ assayResponseBytes: 100 }, "ID,X,Y,Au,Q\na,10,30,1,\n", "assay_response_limit"],
	]) { const f = await fixture(t, limits); await assert.rejects(f.read({ "Samples.csv": data }), e => e.error === reason) }
})

test("installed assay: complete 10,000-row product exceeds two MiB without sampling; the next row fails", installed, async (t) => {
	const f = await fixture(t), data = "ID,X,Y,Au,Q\n" + Array.from({ length: 10000 }, (_, n) => `S${n}-${"α".repeat(30)},10,30,0.${"0".repeat(160)}1,\n`).join("")
	const result = await f.read({ "Samples.csv": data })
	assert.equal(result.rows.length, 10000); assert.equal(result.points.length, 10000); assert.equal(result.placement.coverage.displayed, 10000); assert.ok(Buffer.byteLength(JSON.stringify(result)) > 2 * 1048576)
	assert.equal(result.rows[9999].locator, "Samples.csv:10001")
	await assert.rejects(f.read({ "Samples.csv": data + "extra,10,30,1,\n" }), e => e.error === "assay_row_limit")
})

test("installed native physical response ceiling remains two MiB for non-assay requests even with a sixteen MiB header budget", installed, async () => {
	const bytes = Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [10, 30] }, properties: { text: "a".repeat(2 * 1048576) } }] }))
	const header = { kind: "vector", operation: "preview", options: {}, primary: "points.geojson", members: [{ name: "points.geojson", byteLength: bytes.length }], limits: { responseBytes: 16 * 1048576 } }
	const records = await new Promise((resolve, reject) => {
		const child = spawn(launcherPath, [], { stdio: ["pipe", "pipe", "pipe"], env: {} }); let output = "", errors = ""
		child.stdout.on("data", (b) => { output += b }); child.stderr.on("data", (b) => { errors += b }); child.once("error", reject)
		child.once("close", (code) => { if (code !== 0) return reject(new Error(`Native exit ${code}: ${errors}`)); try { resolve(output.trim().split("\n").map(JSON.parse)) } catch (cause) { reject(cause) } })
		child.stdin.on("error", reject); child.stdin.end(Buffer.concat([Buffer.from(JSON.stringify(header) + "\n"), bytes]))
	})
	assert.equal(records[0].ready, true); assert.equal(records[1].payload, undefined); assert.equal(records[1].error.reason, "vector_response_limit")
})

test("installed assay: numeric grammar, absent qualifier, all-censored ND, negative/tied maxima and whole-hole defaults", installed, async (t) => {
	const f = await fixture(t), options = collar(); delete options.columns.qualifier; delete options.depthWindow
	const result = await f.read({ "Assays.csv": "Hole,From,To,Au\nA,0,10,-2\nA,10,20,-2.0\nA,60,70,-3\nB,0,10,<100\nC,0,10,<100\nC,10,20,bad\nD,0,10,NA\n", "Collars.tsv": "Hole\tX\tY\nA\t10\t30\nB\t11\t31\nC\t12\t32\nD\t13\t33\n" }, options)
	assert.equal(result.points[0].value.value, -2); assert.deepEqual(result.points[0].maximumLocators, ["Assays.csv:2", "Assays.csv:3"]); assert.deepEqual(result.recipe.depthWindow, { kind: "whole-hole" }); assert.equal(result.points[0].rowLocators.length, 3)
	assert.deepEqual(result.points.map((p) => p.value.state), ["detected", "all-censored", "invalid", "missing"], "An invalid contributor cannot be described as all-censored.")
	const numeric = await f.read({ "Samples.csv": "ID,X,Y,Au,Q\na,10,30,.5,\nb,10,30,1.,\nc,10,30,1e309,\nd,10,30,0x10,\ne,10,30,1e,\nf,10,30,,ND\ng,10,30,5e-324,\nh,10,30,<=1,<\n" })
	assert.deepEqual(numeric.rows.map((r) => r.value.state), ["detected", "detected", "invalid", "invalid", "invalid", "censored", "detected", "invalid"])
})

test("installed assay: strict missing-grid operation preserves native points but cannot fabricate a ready map", installed, async (t) => {
	const f = await fixture(t), data = { "Samples.csv": "ID,X,Y,Au,Q\na,-100,50,2,\n" }, options = { ...surface(), sourceCrs: { code: "EPSG:4267", axisOrder: "xy" } }
	const strict = await f.read(data, options)
	assert.equal(strict.placement.state, "unavailable"); assert.equal(strict.placement.operation, null); assert.equal(strict.counts.mapped, 0); assert.deepEqual(strict.points[0].geometry.coordinates, [-100, 50]); assert.ok(strict.placement.reasons.some((r) => r.includes("missing grids")))
	const approximate = await f.read(data, { ...options, allowApproximate: true })
	assert.equal(approximate.placement.state, "ready"); assert.equal(approximate.placement.operation.policy, "approximate"); assert.notEqual(strict.operationFingerprint, approximate.operationFingerprint)
})

test("installed assay: projected coordinates use existing strict Placement; wrong axes/unknown CRS cannot fabricate readiness", installed, async (t) => {
	const f = await fixture(t), options = { ...surface(), sourceCrs: { code: "EPSG:3857", axisOrder: "xy" } }
	const result = await f.read({ "Samples.csv": "ID,X,Y,Au,Q\na,1113194.9079327357,3503549.8435043753,2,\n" }, options)
	assert.equal(result.placement.state, "ready"); assert.ok(Math.abs(result.placement.displayByLocator["Samples.csv:2"].coordinates[0] - 10) < 0.00001); assert.ok(Math.abs(result.placement.displayByLocator["Samples.csv:2"].coordinates[1] - 30) < 0.00001)
	const wrong = await f.read({ "Samples.csv": "ID,X,Y,Au,Q\na,140,-30,2,\n" }, { ...surface(), sourceCrs: { code: "OGC:CRS84", axisOrder: "yx" } })
	assert.equal(wrong.placement.state, "unavailable"); assert.equal(wrong.counts.mapped, 0)
	await assert.rejects(f.read({ "Samples.csv": "ID,X,Y,Au,Q\na,10,30,2,\n" }, { ...surface(), sourceCrs: { code: "EPSG:9999999", axisOrder: "xy" } }), e => e.error === "gis_invalid_options")
	await assert.rejects(f.read({ "Samples.csv": "ID,X,Y,Au,Q\na,10,30,2,\n" }, { ...surface(), environmentFingerprint: "other-environment" }), e => e.error === "gis_environment_changed")
})

test("installed assay FileGis captures cross-directory inputs, persists recipe, reuses normalized identity and previews recorded product after restart", installed, async (t) => {
	const { WorkspaceFiles } = await import("../lib/workspace-files.js"), base = await fs.mkdtemp(path.join(process.env.GIS_TEST_PARENT || os.homedir(), ".gc-assay-service-")), workspaceDir = path.join(base, "project")
	await fs.mkdir(path.join(workspaceDir, "assays"), { recursive: true }); await fs.mkdir(path.join(workspaceDir, "locations"))
	const config = { workspaceDir, filesStateDir: path.join(base, "state"), filesAgentUids: [20001], filesWorkerUids: [997], filesWorkbookWorkerEnabled: false, filesGisWorkerBin: launcherPath, processingFactory: () => ({ async init() {}, async reconcileOperations() {}, async close() {}, async drain() { return { complete: true } }, async capabilities() { return { enabled: false } } }) }
	const logger = { info() {}, warn() {}, error() {} }; let files = await WorkspaceFiles.open(config, logger)
	t.after(async () => { await files.close(); await fs.rm(base, { recursive: true, force: true }) })
	const sources = []
	for (const [name, data] of [["assays/Assays.csv", "Hole,From,To,Au,Q\nA,0,10,2,\n"], ["locations/Collars.tsv", "Hole\tX\tY\nA\t10\t30\n"]]) { await fs.writeFile(path.join(workspaceDir, name), data); sources.push((await files.captures.create({ requestId: `capture-${sources.length}`, path: name, computeDigest: true })).source) }
	const request = { requestId: "prepare", type: "assay", source: sources[0], companions: [sources[1]], options: collar() }
	async function prepare(input) { const admitted = await files.preparation(input); if (admitted.representation) return admitted; for (let n = 0; n < 500; n++) { const job = await files.job(admitted.jobId); if (["succeeded", "failed"].includes(job.state)) { await Promise.allSettled([...files.gis.pending]); assert.equal(job.state, "succeeded", JSON.stringify(job.error)); return job.result } await wait(10) } assert.fail("Assay job did not settle.") }
	const ready = await prepare(request), m = ready.representation
	assert.equal(m.options.depthUnit, "m"); assert.deepEqual(m.options.numbers, { missingTokens: ["", "NA", "N/A", "NULL"], sentinels: [] }); assert.deepEqual(m.metadata.recipe, m.options)
	assert.ok(m.inputs.every((i, n) => i.sha256 === sources[n].digest.sha256)); assert.equal(ready.leases.length, 2)
	assert.equal((await prepare({ ...request, requestId: "normalized", options: m.options })).representation.id, m.id)
	assert.notEqual((await prepare({ ...request, requestId: "new-unit", options: { ...request.options, unit: { name: "g/t", basis: "user-assigned" } } })).representation.id, m.id)
	await fs.writeFile(path.join(workspaceDir, "Surface.csv"), "ID,X,Y,Au,Q\n s ,10,30,2,\nbad,bad,30,NA,\n\u00a0unicode\u00a0,11,31,3,\n")
	const surfaceSource = (await files.captures.create({ requestId: "capture-surface", path: "Surface.csv", computeDigest: true })).source
	const surfaceReady = await prepare({ requestId: "surface", type: "assay", source: surfaceSource, options: surface() })
	assert.equal(surfaceReady.representation.metadata.rows[0].id, "s"); assert.equal(surfaceReady.representation.metadata.points.length, 2); assert.equal(surfaceReady.representation.metadata.counts.invalidCoordinateRows, 1)
	const metadata = structuredClone(m.metadata); metadata.points[0].value.value = 999
	assert.throws(() => files.gis.validateAssay(metadata, m.inputs, m.options), { error: "invalid_gis_result" })
	const indexCount = (await files.state.list("workbook-indexes")).length
	files.gis.limits.gisAssayManifestBytes = files.gis.reader.limits.assayManifestBytes = Buffer.byteLength(JSON.stringify(m.metadata)) + 64
	const tooSmall = await files.preparation({ ...request, requestId: "manifest-overflow", options: { ...request.options, unit: { name: "new", basis: "user-assigned" } } })
	for (let n = 0; n < 500 && (await files.job(tooSmall.jobId)).state !== "failed"; n++) await wait(10)
	await Promise.allSettled([...files.gis.pending]); assert.equal((await files.job(tooSmall.jobId)).error.error, "assay_manifest_limit"); assert.equal((await files.state.list("workbook-indexes")).length, indexCount); assert.deepEqual(await files.state.list("holds"), []); assert.deepEqual(await files.state.list("index-reservations"), [])
	files.gis.limits.gisAssayManifestBytes = files.gis.reader.limits.assayManifestBytes = 16 * 1048576
	files.gis.limits.gisAssayResponseBytes = files.gis.reader.limits.assayResponseBytes = 100
	const tooLarge = await files.preparation({ ...request, requestId: "response-overflow", options: { ...request.options, unit: { name: "response", basis: "user-assigned" } } })
	for (let n = 0; n < 500 && (await files.job(tooLarge.jobId)).state !== "failed"; n++) await wait(10)
	await Promise.allSettled([...files.gis.pending]); assert.equal((await files.job(tooLarge.jobId)).error.error, "assay_response_limit"); assert.equal((await files.state.list("workbook-indexes")).length, indexCount)
	for (const s of sources) await fs.writeFile(path.join(workspaceDir, s.ref.path), "changed Current")
	await files.close(); files = await WorkspaceFiles.open(config, logger)
	files.gis.reader.read = () => assert.fail("Preview must use recorded metadata, not reinterpret retained bytes.")
	const preview = await files.representationQuery(m.id, { operation: "preview" }); assert.deepEqual(preview.points, m.metadata.points); assert.deepEqual(preview.recipe, m.options)
	await assert.rejects(files.preparation({ ...request, source: { ...request.source, digest: { state: "ready", sha256: "0".repeat(64) } } }), { error: "source_changed" })
	await fs.unlink(path.join(files.captures.blobDir, `capture.${sources[1].captureId}`)); await assert.rejects(files.representationQuery(m.id, { operation: "preview" }), { status: 410 })
})
