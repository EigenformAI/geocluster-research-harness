import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Worker } from "node:worker_threads"
import { validateRecipe, validateImportRecipe, validateIndexedRecipe } from "../lib/voxel/voxel-recipe.js"
import { defaultSpatialMetadata } from "../lib/voxel/voxel-artifact.js"
import { indexed } from "./voxel-fixture.mjs"
const limits = { rows: 100000, columns: 1024, cells: 1000000, categories: 4096, pieces: 4000000, sourceBytes: 32 * 1048576, memberBytes: 32 * 1048576, tableRetentionBytes: 128 * 1048576 }
const source = { root: "workspace", resourceId: "input.csv", path: "input.csv", revision: "capture:fixture", sha256: "0".repeat(64) }
function recipe(rowEnd = 1, columnEnd = 3) { return { schemaVersion: 1, algorithm: "geocluster-binning-v1", name: "Independent answer", scope: { input: { type: "delimited", resourceId: source.path, source, delimiter: "," }, range: { rowStart: 0, rowEnd, columnStart: 0, columnEnd }, headerRows: [0] }, geometry: { mode: "points", x: 0, y: 1, z: 2, zMeaning: { type: "elevation" } }, reference: { horizontal: { type: "local", name: "fixture" }, horizontalUnit: "m", verticalUnit: "m", verticalReference: "plane" }, value: { kind: "numeric", column: 3, name: "Value", unit: "", aggregation: "mean" }, numbers: { decimal: ".", thousands: "none", missingTokens: ["NA"], sentinels: [], censored: "exclude" }, predicates: [], grid: { spacing: [1, 1, 1], extent: { type: "custom", origin: [0, 0, 0], shape: [2, 1, 1], acceptClipping: true } }, predecessor: null } }
async function worker(data) {
	const w = new Worker(new URL("../lib/voxel-worker.js", import.meta.url), { workerData: { limits, ...data }, execArgv: [] })
	try { return await new Promise((resolve, reject) => { w.once("message", (reply) => reply.error ? reject(Object.assign(new Error(reply.error.reason), reply.error)) : resolve(reply.result)); w.once("error", reject); w.once("exit", (code) => { if (code) reject(new Error(`Worker exit ${code}`)) }) }) } finally { await w.terminate() }
}
// Unlinked read-only descriptors prove there is no mutable-path fallback.
async function captured(bytes, data = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voxel-ingestion-")), name = path.join(dir, "protected"); let handle
	try { const body = Buffer.from(bytes); await fs.writeFile(name, body, { mode: 0o400 }); handle = await fs.open(name, "r"); await fs.unlink(name); const binding = { fd: handle.fd, size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex"), ...data.binding }; return await worker({ action: "compute", recipe: recipe(), materialize: true, input: recipe().scope.input, ...data, binding, ...(data.action === "verify" ? { manifest: binding } : {}) }) } finally { await handle?.close(); await fs.rm(dir, { recursive: true, force: true }) }
}
function values(bytes) { const b = Buffer.from(bytes), offset = 10 + b.readUInt16LE(8), dtype = /'descr': '([^']+)'/.exec(b.subarray(10, offset).toString("ascii"))[1], size = dtype === "<f8" ? 8 : dtype === "<u4" ? 4 : 1; return Array.from({ length: (b.length - offset) / size }, (_, i) => size === 8 ? b.readDoubleLE(offset + i * size) : size === 4 ? b.readUInt32LE(offset + i * size) : b[offset + i]) }
function answer(result, expected) { assert.deepEqual(result.errors || result.blockingErrors, []); for (const [role, value] of Object.entries(expected)) assert.deepEqual(values(result.arrays[role]), value, role) }
test("retained input rejects before excess retention and supports explicit budget overrides", async () => {
	await assert.rejects(captured("x,y,z,v\n0.2,0.2,0.2,4\n", { limits: { ...limits, tableRetentionBytes: 256 } }), { status: 413, error: "table_memory_limit" })
	answer(await captured("x,y,z,v\n0.2,0.2,0.2,4\n", { limits: { ...limits, tableRetentionBytes: 16384 } }), { values: [4, 0], valid: [1, 0], counts: [1, 0] })
})
test("descriptor failures are transient; malformed artifact bytes are typed integrity failures", async () => {
	await assert.rejects(worker({ action: "verify", manifest: { fd: 2147483647, size: 1, sha256: "0".repeat(64) }, members: {} }), { status: 503, error: "worker_io_unavailable" })
	await assert.rejects(captured("not a manifest", { action: "verify", members: {} }), { status: 422, error: "invalid_manifest" })
})
test("description counts all selected rows but retains only eight samples", async () => {
	const scope = recipe(40).scope, csv = "x,y,z,v\n" + Array.from({ length: 40 }, (_, i) => `0,0,0,${i}\n`).join("")
	const result = await captured(csv, { action: "describe", scope, fullRange: true, limits: { ...limits, tableRetentionBytes: 16000 } }); assert.equal(result.rows, 40); assert.equal(result.sample.length, 8); assert.deepEqual(result.headers.map((h) => h.label), ["x", "y", "z", "v"])
	await assert.rejects(captured(csv, { recipe: recipe(40), limits: { ...limits, tableRetentionBytes: 16000 } }), { error: "table_memory_limit" })
})
test("projection retains absolute predicates and validates full discarded syntax/width/rows/hash", async () => {
	const r = recipe(3, 49); r.predicates = [{ type: "equals", column: 49, value: "keep", trim: true }]
	const tail = Array.from({ length: 45 }, () => "irrelevant".repeat(100)).join(","), csv = [Array.from({ length: 50 }, (_, i) => `h${i}`).join(","), `0.2,0.2,0.2,0,${tail},keep`, `0.3,0.3,0.3,-4,${tail},keep`, `1.2,0.2,0.2,999,${tail},drop`].join("\n")
	answer(await captured(csv, { recipe: r, limits: { ...limits, tableRetentionBytes: 12000 } }), { values: [-2, 0], valid: [1, 0], counts: [2, 0] })
	r.scope.range.columnEnd = 3; assert.match((await captured(csv, { recipe: r })).errors.join(" "), /50.*outside the selected range/)
	const prefix = "x,y,z,v\n0,0,0,2\n"
	for (const [bytes, extra, error] of [[prefix + "tail", { binding: { sha256: "f".repeat(64) } }, "source_integrity"], [Buffer.concat([Buffer.from(prefix), Buffer.from([255])]), {}, "encoding_unavailable"], [prefix + 'discarded,ok,ok,bad"quote', {}, "invalid_table"], [prefix + 'discarded,ok,ok,"unterminated', {}, "invalid_table"], [prefix + 'discarded,ok,ok,"closed"junk', {}, "invalid_table"], [prefix + "a,b,c,d,e", { limits: { ...limits, columns: 4 } }, "column_limit"], [prefix + "\n".repeat(33), { limits: { ...limits, rows: 1 } }, "row_limit"]]) await assert.rejects(captured(bytes, { action: "describe", scope: recipe().scope, ...extra }), { error })
})
test("CSV/TSV logical records, ragged padding and distant headers survive projected parsing", async () => {
	for (const delimiter of [",", "\t"]) for (const newline of ["\n", "\r", "\r\n"]) {
		const scope = recipe(4).scope; scope.input.delimiter = delimiter; scope.range = { rowStart: 1, rowEnd: 4, columnStart: 1, columnEnd: 3 }; scope.headerRows = [0, 5]
		const records = [["ignore", "X", "Y", "Value"].join(delimiter), ["junk", '"a' + delimiter + 'b"', '"say ""yes"""', '"line1' + newline + 'line2"'].join(delimiter), ["junk", "ragged"].join(delimiter), "", ["junk", "0", "-2", ""].join(delimiter), ["ignore", "Units", "", "ppm"].join(delimiter)]
		const result = await captured(records.join(newline), { action: "describe", scope, input: scope.input }); assert.equal(result.rows, 4); assert.deepEqual(result.headers.map((h) => h.label), ["X / Units", "Y", "Value / ppm"]); assert.deepEqual(result.sample[1].cells, ["ragged", "", ""]); assert.deepEqual(result.sample[0].cells, [`a${delimiter}b`, 'say "yes"', `line1${newline}line2`])
	}
})
test("independent means/min/max, segments, interval holes and filters preserve science under projection", async () => {
	for (const aggregation of ["mean", "min", "max"]) { const r = recipe(4, 5); r.scope.range.columnStart = 1; r.geometry.x = 1; r.geometry.y = 2; r.geometry.z = 3; r.value.column = 5; r.value.aggregation = aggregation; answer(await captured("junk,x,y,z,unused,v\nskip,0.2,0.2,0.2,unused,0\nskip,0.3,0.3,0.3,unused,-4\nskip,1.2,0.2,0.2,unused,8\nskip,1.3,0.3,0.3,unused,12", { recipe: r }), { values: aggregation === "mean" ? [-2, 10] : aggregation === "min" ? [-4, 8] : [0, 12], valid: [1, 1], counts: [2, 2] }) }
	const segment = recipe(2, 8); segment.geometry = { mode: "segments", start: [1, 2, 3], end: [5, 6, 7], zMeaning: { type: "elevation" } }; segment.value.column = 8
	answer(await captured("unused,x0,y0,z0,unused,x1,y1,z1,v\nskip,0,0.5,0.5,skip,2,0.5,0.5,10\nskip,0,0.5,0.5,skip,0.5,0.5,0.5,40", { recipe: segment }), { values: [20, 10], counts: [2, 1], weights: [1.5, 1], valid: [1, 1] })
	const r = recipe(3, 8); r.grid.extent.shape = [1, 1, 2]; r.value.column = 7; r.geometry = { mode: "vertical-intervals", collarX: { type: "constant", value: 0.5 }, collarY: { type: "constant", value: 0.5 }, collarElevation: { type: "constant", value: 2 }, from: 2, to: 4, depthUnit: "m", collarElevationUnit: "m", holeId: 6, sharedCollar: false }; r.predicates = [{ type: "range", column: 8, min: 1, max: null }]
	answer(await captured("unused,unused,from,unused,to,unused,hole,v,filter\nx,x,0,x,2,x,H1,10,1\nx,x,0,x,0.5,x,H1,40,1\nx,x,0,x,2,x,H2,999,0", { recipe: r }), { values: [10, 20], counts: [1, 2], weights: [1, 1.5], valid: [1, 1] })
})
test("workbook projection preserves absolute mappings, stored formula cache metadata and warnings", async () => {
	const r = recipe(12, 8); r.scope.range = { rowStart: 10, rowEnd: 12, columnStart: 2, columnEnd: 8 }; r.geometry.x = 2; r.geometry.y = 3; r.geometry.z = 4; r.value.column = 8
	const c = (raw, extra = {}) => ({ raw, display: String(raw), type: typeof raw === "number" ? "n" : "s", formula: null, cache: "not-formula", format: null, ...extra }), rows = [0, -4, 100].map((raw, n) => ({ row: n + 10, cells: [c(0.2), c(0.2), c(0.2), c("irrelevant".repeat(10000)), c(null), c(null), c(raw, n ? { formula: "-4", cache: n === 1 ? "present" : "missing", format: "0.00" } : {})] })), workbook = { typedJsonl: rows.map(JSON.stringify).join("\n"), columns: 9, parser: "stored-fixture", warnings: ["stored warning"], headers: Array.from({ length: 7 }, (_, i) => ({ column: i + 2, label: `H${i + 2}` })) }
	const result = await worker({ action: "compute", recipe: r, workbook, materialize: true, limits: { ...limits, tableRetentionBytes: 8000 } }); answer(result, { values: [-2, 0], counts: [2, 0], valid: [1, 0] }); assert.equal(result.statistics.formulaCacheValues, 1); assert.equal(result.statistics.exclusions["value-missing"], 1); assert.ok(result.warnings.includes("stored warning"))
})
test("UTF-16 label and predecessor boundaries apply across observation/indexed/NPY intents", async () => {
	const r = recipe(2); r.value = { kind: "categorical", column: 3, name: "Class", trim: true }
	for (const label of ["a".repeat(1024), "😀".repeat(512)]) { const result = await captured(`x,y,z,v\n0,0,0,${label}\n0,0,0,A`, { recipe: r }); assert.deepEqual(result.errors, []) }
	for (const label of ["a".repeat(1025), "😀".repeat(512) + "a"]) { const result = await captured(`x,y,z,v\n0,0,0,A\n0,0,0,${label}`, { recipe: r }); assert.match(result.errors.join(" "), /1024/); assert.equal(result.arrays, null) }
	for (const [input, validate] of [[r, validateRecipe], [indexed(source), validateIndexedRecipe], [{ schemaVersion: 1, source, metadata: defaultSpatialMetadata("a.npy"), defaults: [], predecessor: null }, validateImportRecipe]]) { assert.equal(validate({ ...input, predecessor: { artifactId: "vox-parent", generation: "g".repeat(64) } }).predecessor.generation.length, 64); assert.throws(() => validate({ ...input, predecessor: { artifactId: "vox-parent", generation: "g".repeat(65) } }), /predecessor.*generation/) }
})
test("wide supported descriptions and selected observation/indexed inputs fit defaults without dense suggestions", async () => {
	for (const columns of [40, 50]) { const r = recipe(100000, columns - 1), record = ["0.2", "0.2", "0.2", "4.0", ...Array.from({ length: columns - 4 }, () => "1234")].join(",") + "\n", csv = Array.from({ length: columns }, (_, i) => `h${i}`).join(",") + "\n" + record.repeat(100000); const described = await captured(csv, { action: "describe", scope: r.scope, fullRange: true }); assert.equal(described.rows, 100000); assert.equal(described.sample.length, 8); const validated = await captured(csv, { recipe: r, materialize: false }); assert.deepEqual(validated.errors, []); assert.equal(validated.statistics.acceptedRows, 100000) }
	const r = indexed(source, false); r.scope.range.columnEnd = 1023; r.field.column = 1023; const header = Array.from({ length: 1024 }, (_, i) => `h${i}`).join(","), tail = ",".repeat(1020), csv = `${header}\n0,0,0${tail},0\n1,0,0${tail},-4\n`
	answer(await captured(csv, { action: "indexed-grid", recipe: r, limits: { ...limits, tableRetentionBytes: 12000 } }), { values: [0, -4], valid: [1, 1] })
	const scan = await captured(csv, { action: "scan-indices", scope: r.scope, indices: r.indices, numbers: r.numbers, limits: { ...limits, tableRetentionBytes: 12000 } }); assert.equal(scan.scanComplete, true); assert.deepEqual(scan.suggestedShape, [2, 1, 1])
})
