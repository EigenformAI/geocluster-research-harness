import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { Worker } from "node:worker_threads"
import { validateSubmission, recipeFingerprint, canonicalJson } from "../lib/voxel/voxel-recipe.js"
import { manifestGeneration, readManifest, defaultSpatialMetadata } from "../lib/voxel/voxel-artifact.js"
import { encodeNpy, decodeNpyArray } from "../lib/voxel/npy.js"

const hash = (b) => crypto.createHash("sha256").update(b).digest("hex")
const source = { resourceId: "grid.csv", root: "workspace", path: "grid.csv", sha256: "a".repeat(64), revision: "capture:test" }
const limits = { rows: 10000, columns: 32, cells: 10000, categories: 32, pieces: 10000, sourceBytes: 1048576, memberBytes: 1048576 }
const neutral = { decimal: ".", thousands: "none", missingTokens: [], sentinels: [], censored: "exclude" }
function recipe(shape = [2, 3, 4], kind = "numeric", rowCount = shape.reduce((a, b) => a * b, 1)) {
	return { schemaVersion: 1, algorithm: "geocluster-indexed-v1", name: "Pattern", scope: { input: { type: "delimited", resourceId: source.resourceId, source, delimiter: "," }, range: { rowStart: 0, rowEnd: rowCount, columnStart: 0, columnEnd: 3 }, headerRows: [0] }, indices: { x: 0, y: 1, z: 2, base: 0 }, shape, placement: { origin: [0, 0, 0], spacing: [1, 1, 1], unit: "grid-unit", horizontalReference: { type: "unreferenced", definition: "" }, verticalReference: null }, field: kind === "numeric" ? { kind, column: 3, name: "Values", unit: "ppm" } : { kind, column: 3, name: "Classes", trim: false }, numbers: structuredClone(neutral), emptyCells: "forbid", predecessor: null }
}
const csv = (rows) => "x,y,z,value\n" + rows.map((r) => r.map((c) => typeof c === "string" ? `"${c.replaceAll('"', '""')}"` : c).join(",")).join("\n") + "\n"
function rowsFor(shape, value) {
	const rows = []
	for (let x = 0; x < shape[0]; x++) for (let y = 0; y < shape[1]; y++) for (let z = 0; z < shape[2]; z++) rows.push([x, y, z, value(x, y, z)])
	return rows
}
async function worker(data, captures = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voxel-indexed-")), handles = []
	try {
		for (const [key, content] of Object.entries(captures)) {
			const file = path.join(dir, String(handles.length)); await fs.writeFile(file, content)
			const handle = await fs.open(file, "r"); handles.push(handle)
			const binding = { fd: handle.fd, size: Buffer.byteLength(content), sha256: hash(content) }
			if (key.startsWith("member:")) (data.members ||= {})[key.slice(7)] = binding
			else data[key] = binding
		}
		const w = new Worker(new URL("../lib/voxel-worker.js", import.meta.url), { workerData: { limits, ...data }, execArgv: [] })
		try { return await new Promise((resolve, reject) => { w.once("message", (m) => m.error ? reject(Object.assign(new Error(m.error.reason), m.error)) : resolve(m.result)); w.once("error", reject); w.once("exit", (code) => { if (code) reject(new Error(`worker exit ${code}`)) }) }) }
		finally { await w.terminate() }
	} finally { await Promise.all(handles.map((h) => h.close())); await fs.rm(dir, { recursive: true, force: true }) }
}
const indexed = (r, rows, extra = {}) => worker({ action: "indexed-grid", recipe: r, input: r.scope.input, materialize: true, ...extra }, { binding: csv(rows) })
const decode = (r, role) => decodeNpyArray(r.arrays[role], { descr: role === "valid" ? "|u1" : r.field.kind === "numeric" ? "<f8" : "<u4", shape: r.grid.shape })
async function artifact(r, result) {
	const arrays = Object.entries(result.arrays).map(([role, b]) => ({ role, dtype: role === "valid" ? "|u1" : r.field.kind === "numeric" ? "<f8" : "<u4", contentId: `sha256:${hash(b)}`, sha256: hash(b), byteLength: b.length }))
	const m = { format: "geocluster-voxel", schemaVersion: 1, artifactId: "vox-test", predecessor: r.predecessor, projectId: "project", operationId: null, createdUtc: "2026-10-09T00:00:00Z", creation: { mode: "imported-grid", label: "Imported grid", algorithm: "geocluster-indexed-v1", boundaryPolicy: "exact-indices", accumulation: "canonical-C-z-fastest", parsers: result.parsers, executionProfile: "runtime-worker-v1" }, sourceRevisions: [source], grid: result.grid, field: result.field, arrays, recipe: { type: "indexed-grid", recipe: r }, statistics: result.statistics, warnings: [], assumptions: [] }
	m.generation = await manifestGeneration(m)
	return { manifest: Buffer.from(canonicalJson(m)), ...Object.fromEntries(Object.entries(result.arrays).map(([role, b]) => [`member:${role}`, b])) }
}

test("strict indexed schema and all three revision envelopes bind fingerprints", async () => {
	const r = recipe()
	for (const change of [{ predicates: [] }, { shape: [2, 1.5, 4] }, { indices: { ...r.indices, base: 2 } }, { placement: { ...r.placement, unit: "ft" } }, { placement: { ...r.placement, verticalReference: "datum" } }]) assert.throws(() => validateSubmission({ kind: "indexed-grid", recipe: { ...r, ...change } }))
	const revision = { voxelId: "voxel-test", expectedHeadRevision: "head-1", base: { artifactId: "vox-test", generation: "b".repeat(64), manifest: source } }
	const npy = { schemaVersion: 1, source, metadata: defaultSpatialMetadata("test.npy"), defaults: [], predecessor: null }
	const observation = { schemaVersion: 1, algorithm: "geocluster-binning-v1", name: "Points", scope: r.scope, geometry: { mode: "points", x: 0, y: 1, z: 2, zMeaning: { type: "elevation" } }, reference: { horizontal: { type: "local", name: "mine" }, horizontalUnit: "m", verticalUnit: "m", verticalReference: "datum" }, value: { ...r.field, aggregation: "mean" }, numbers: neutral, predicates: [], grid: { spacing: [1, 1, 1], extent: { type: "auto" } }, predecessor: null }
	for (const [kind, recipe] of [["indexed-grid", r], ["import-metadata", npy], ["table-to-voxel", observation]]) {
		const base = validateSubmission({ kind, recipe, revision: null }), update = validateSubmission({ kind, recipe, revision })
		assert.deepEqual(update.revision, revision)
		assert.notEqual(await recipeFingerprint(base), await recipeFingerprint(update))
		assert.throws(() => validateSubmission({ kind, recipe, revision: { ...revision, base: { ...revision.base, generation: "bad" } } }))
		assert.throws(() => validateSubmission({ kind, recipe, revision: { ...revision, surprise: true } }))
	}
})

test("asymmetric numeric feet placement rejects axis transposition and preserves zero/negative", async () => {
	const r = recipe(); r.indices.base = 1
	r.placement = { origin: [100, -20, 7.25], spacing: [2, 3, 0.5], unit: "ft", horizontalReference: { type: "local", definition: "mine" }, verticalReference: "datum" }
	const rows = rowsFor(r.shape, (x, y, z) => 100 * x + 10 * y + z - 12).reverse().map(([x, y, z, v]) => [x + 1, y + 1, z + 1, v])
	const out = await indexed(r, rows)
	assert.equal(out.scanComplete, true); assert.deepEqual(out.blockingErrors, [])
	assert.deepEqual(out.grid.origin, r.placement.origin); assert.deepEqual(out.grid.spacing, r.placement.spacing); assert.equal(out.grid.unit, "ft")
	const v = decode(out, "values")
	for (let x = 0; x < 2; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 4; z++) assert.equal(v[(x * 3 + y) * 4 + z], 100 * x + 10 * y + z - 12)
	assert.equal(v[0], -12); assert.equal(v[6], 0); assert.equal(decode(out, "valid")[6], 1)
})

test("full 16x16x12 category fixture has a deterministic dictionary and valid category zero", async () => {
	const r = recipe([16, 16, 12], "categorical"), rows = rowsFor(r.shape, (x, y, z) => String((x + 2 * y + 3 * z) % 4))
	const a = await indexed(r, rows), b = await indexed(r, rows.toReversed())
	assert.deepEqual(a.blockingErrors, [])
	assert.deepEqual(a.summary, { inputRows: 3072, suppliedUniqueCells: 3072, absentRecordCells: 0, emptySuppliedValueCells: 0, validCells: 3072, duplicateCellGroups: 0 })
	assert.deepEqual(a.field.categories, ["0", "1", "2", "3"].map((label, code) => ({ code, label })))
	assert.deepEqual(a.arrays, b.arrays)
	assert.equal(decode(a, "valid")[0], 1)
	const values = decode(a, "values")
	for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) for (let z = 0; z < 12; z++) assert.equal(values[(x * 16 + y) * 12 + z], (x + 2 * y + 3 * z) % 4)
})

test("sparse borders, exact raw labels and duplicate empty records never masquerade as completeness", async () => {
	const r = recipe([4, 5, 6], "categorical", 4); r.emptyCells = "allow"; r.numbers.missingTokens = ["NA"]
	const out = await indexed(r, [[1, 1, 1, "0"], [2, 2, 2, ""], [1, 2, 3, " NA "], [2, 3, 4, "NA"]])
	assert.deepEqual(out.grid.shape, [4, 5, 6]); assert.deepEqual(out.blockingErrors, [])
	assert.equal(out.summary.absentRecordCells, 116); assert.equal(out.summary.emptySuppliedValueCells, 2); assert.equal(out.summary.validCells, 2)
	assert.deepEqual(out.field.categories.map((c) => c.label), [" NA ", "0"])
	const dup = await indexed(r, [[1, 1, 1, "0"], [2, 2, 2, ""], [2, 2, 2, ""], [1, 1, 1, "0"]])
	assert.equal(dup.scanComplete, true); assert.equal(dup.summary.duplicateCellGroups, 2); assert.ok(dup.blockingErrors.length); assert.equal(dup.arrays, null)
	assert.deepEqual(dup.issues.find((i) => i.kind === "duplicate-cell").rows, [3, 4])
	const forbid = await indexed({ ...r, emptyCells: "forbid" }, [[1, 1, 1, "0"], [2, 2, 2, ""], [1, 2, 3, " NA "], [2, 3, 4, "NA"]])
	assert.ok(forbid.blockingErrors.some((s) => /absent/i.test(s))); assert.ok(forbid.blockingErrors.some((s) => /empty/i.test(s)))
})

test("malformed values and indices block; index policy never substitutes sentinels/missing/censors", async () => {
	const r = recipe([2, 1, 1], "numeric", 2); r.emptyCells = "allow"
	for (const value of ["oops", "Infinity", "<bad"]) { const out = await indexed(r, [[0, 0, 0, 0], [1, 0, 0, value]]); assert.ok(out.blockingErrors.length); assert.equal(out.arrays, null) }
	r.numbers.missingTokens = ["1"]; r.numbers.sentinels = [0]; r.numbers.censored = "half-limit"
	const good = await indexed(r, [[0, 0, 0, -3], [1, 0, 0, 2]])
	assert.deepEqual(good.blockingErrors, []); assert.equal(good.summary.validCells, 2)
	for (const x of ["", "<1", "1.1", "9007199254740992", "-1", "2"]) { const out = await indexed(r, [[0, 0, 0, -3], [x, 0, 0, 2]]); assert.ok(out.blockingErrors.length); assert.equal(out.arrays, null) }
	const censored = await indexed(r, [[0, 0, 0, "<4"], [1, 0, 0, 0]])
	assert.equal(censored.statistics.censoredSubstitutions, 1); assert.equal(censored.summary.emptySuppliedValueCells, 1)
})

test("capacity failures are incomplete and bounded issues do not bound acceptance", async () => {
	const r = recipe([1000000, 1000000, 12], "numeric", 1)
	const out = await indexed(r, [[0, 0, 0, 1]], { limits })
	assert.equal(out.scanComplete, false); assert.ok(out.blockingErrors.length); assert.equal(out.arrays, null)
	const small = recipe([1, 1, 1], "numeric", 80); small.emptyCells = "allow"
	const errors = await indexed(small, Array.from({ length: 80 }, (_, n) => [n + 1, 0, 0, "bad"]))
	assert.equal(errors.scanComplete, true); assert.ok(errors.issues.length <= 25); assert.ok(errors.blockingErrors.length)
})

test("dictionary ceilings are blocking/incomplete, and empty grids never produce artifacts", async () => {
	const r = recipe([3, 1, 1], "categorical", 3), rows = [[0, 0, 0, "A"], [1, 0, 0, "B"], [2, 0, 0, "C"]]
	const out = await indexed(r, rows, { limits: { ...limits, categories: 2 } })
	assert.equal(out.scanComplete, false); assert.ok(out.blockingErrors.some((s) => /dictionary/i.test(s))); assert.equal(out.arrays, null)
	const empty = await indexed({ ...r, emptyCells: "allow" }, rows.map(([x, y, z]) => [x, y, z, ""]))
	assert.equal(empty.scanComplete, true); assert.equal(empty.summary.validCells, 0); assert.ok(empty.blockingErrors.some((s) => /no valid/i.test(s))); assert.equal(empty.arrays, null)
	const successful = await indexed({ ...r, emptyCells: "allow" }, [[0, 0, 0, "A"], [1, 0, 0, ""], [2, 0, 0, "C"]], { materialize: false })
	assert.equal(successful.arrays, null); assert.deepEqual(successful.blockingErrors, [])
	assert.equal(successful.summary.absentRecordCells + successful.summary.emptySuppliedValueCells + successful.summary.validCells, 3)
})

test("scan-indices suggests full maxima without allocating a nominal dense grid", async () => {
	const r = recipe([1, 1, 1], "numeric", 3)
	const out = await worker({ action: "scan-indices", input: r.scope.input, scope: r.scope, indices: r.indices, numbers: neutral }, { binding: csv([[0, 0, 0, 1], [999999, 7, 10, 1], [999999, 7, 10, ""]]) })
	assert.equal(out.scanComplete, true); assert.deepEqual(out.suggestedShape, [1000000, 8, 11]); assert.equal(out.summary.duplicateCellGroups, 1)
	assert.equal(out.arrays, undefined); assert.ok(out.blockingErrors.length)
})

test("canonical inspection verifies whole members then returns bounded cells/region", async () => {
	const r = recipe(), out = await indexed(r, rowsFor(r.shape, (x, y, z) => 100 * x + 10 * y + z)), captures = await artifact(r, out)
	const a = await worker({ action: "inspect-artifact", options: { indices: [[1, 2, 3]], region: { min: [0, 1, 1], max: [1, 3, 3] }, limit: 3 } }, captures)
	assert.equal(a.integrity, "verified"); assert.equal(a.cells.length, 3); assert.equal(a.cells[0].value, 123); assert.deepEqual(a.cells[0].index, [1, 2, 3]); assert.equal(a.truncated, true)
	assert.deepEqual(a.cells[0].center, [1.5, 2.5, 3.5])
	const bad = structuredClone(captures); bad["member:values"][bad["member:values"].length - 1] ^= 1
	await assert.rejects(worker({ action: "inspect-artifact", options: { indices: [[0, 0, 0]], limit: 1 } }, bad), /SHA-256/)
})

test("full replacement decodes/recode labels, escapes CSV, preserves missing-token-lookalikes and floats", async () => {
	const r = recipe([2, 2, 2], "categorical", 5); r.emptyCells = "allow"; r.numbers.sentinels = [-999]; r.numbers.missingTokens = ["MISSING"]
	const labels = ["0", "NA", "-999", ' quote,"\nline ', "discard"], out = await indexed(r, labels.map((v, n) => [Math.floor(n / 4), Math.floor(n / 2) % 2, n % 2, v])), captures = await artifact(r, out)
	const replacement = await worker({ action: "materialize-artifact", options: { edits: [{ index: [0, 0, 0], valid: true, value: "ZZ" }, { index: [1, 1, 1], valid: true, value: "0" }, { index: [1, 0, 0], valid: false }] } }, captures)
	assert.equal(replacement.complete, true); assert.equal(replacement.rows, 5); assert.deepEqual(replacement.recipe.numbers, neutral); assert.equal(replacement.recipe.field.trim, false)
	assert.deepEqual(replacement.recipe.predecessor, { artifactId: "vox-test", generation: (await readManifest(captures.manifest)).generation })
	const roundtrip = await worker({ action: "indexed-grid", input: r.scope.input, recipe: { ...replacement.recipe, scope: { ...replacement.recipe.scope, input: r.scope.input } }, materialize: true }, { binding: replacement.csv })
	assert.deepEqual(roundtrip.blockingErrors, []); assert.equal(roundtrip.summary.validCells, 5)
	const labels2 = decode(roundtrip, "values"), valid = decode(roundtrip, "valid")
	assert.equal(roundtrip.field.categories[labels2[0]].label, "ZZ"); assert.equal(roundtrip.field.categories[labels2[1]].label, "NA"); assert.equal(roundtrip.field.categories[labels2[2]].label, "-999"); assert.equal(valid[4], 0); assert.equal(roundtrip.field.categories[labels2[3]].label, labels[3]); assert.equal(roundtrip.field.categories[labels2[7]].label, "0")
	await assert.rejects(worker({ action: "materialize-artifact", options: {}, limits: { ...limits, rows: 2 } }, captures), /row/i)
	await assert.rejects(worker({ action: "materialize-artifact", options: {}, limits: { ...limits, sourceBytes: 12 } }, captures), /byte/i)
	const nr = recipe([1, 1, 3]), nums = [Number.MIN_VALUE, -0, 1.2345678901234567], no = await indexed(nr, nums.map((v, z) => [0, 0, z, Object.is(v, -0) ? "-0" : String(v)]))
	const rep = await worker({ action: "materialize-artifact", options: {} }, await artifact(nr, no))
	const n2 = await worker({ action: "indexed-grid", input: nr.scope.input, recipe: { ...rep.recipe, scope: { ...rep.recipe.scope, input: nr.scope.input } }, materialize: true }, { binding: rep.csv })
	assert.deepEqual(Array.from(decode(n2, "values")), nums)
})

test("TSV number format, explicit trim, complete parser errors and stored workbook row locations", async () => {
	const r = recipe([2, 1, 1], "numeric", 2); r.scope.input.delimiter = "\t"; r.numbers.decimal = ","
	const out = await worker({ action: "indexed-grid", recipe: r, materialize: true }, { binding: "x\ty\tz\tv\n0,0\t0\t0\t-1,25\n1,0\t0\t0\t0\n" })
	assert.deepEqual(out.blockingErrors, []); assert.deepEqual(Array.from(decode(out, "values")), [-1.25, 0])
	await assert.rejects(worker({ action: "indexed-grid", recipe: r }, { binding: 'x\ty\tz\tv\n0\t0\t0\t1\n1\t0\t0\t"truncated' }), /quoted field/)
	const cat = recipe([3, 1, 1], "categorical", 3); cat.emptyCells = "allow"; cat.field.trim = true; cat.numbers.missingTokens = [" NA "]
	const trimmed = await indexed(cat, [[0, 0, 0, " NA "], [1, 0, 0, " 0 "], [2, 0, 0, " "]])
	assert.equal(trimmed.summary.emptySuppliedValueCells, 2); assert.deepEqual(trimmed.field.categories, [{ code: 0, label: "0" }])
	const raw = await indexed({ ...cat, field: { ...cat.field, trim: false } }, [[0, 0, 0, " NA "], [1, 0, 0, " 0 "], [2, 0, 0, " "]])
	assert.deepEqual(raw.field.categories.map((c) => c.label), [" ", " 0 "])
	const workbook = { typedJsonl: [10, 12].map((row) => JSON.stringify({ row, cells: [0, 0, 0, "0"].map((raw) => ({ raw, formula: null, cache: "not-formula" })) })).join("\n"), columns: 4, parser: "stored-test-v1", warnings: [], headers: [] }
	const wr = recipe([1, 1, 1], "categorical", 2); wr.scope.input = { type: "workbook", resourceId: source.resourceId, source, workbookId: "book", sheet: "sheet" }
	const duplicate = await worker({ action: "indexed-grid", recipe: wr, workbook, materialize: true })
	assert.equal(duplicate.scanComplete, true); assert.deepEqual(duplicate.issues[0].rows, [11, 13]); assert.equal(duplicate.arrays, null)
})

test("canonical imported-grid metadata/stats/mask and bounded edit/query failures are enforced", async () => {
	const r = recipe([2, 1, 1]), out = await indexed(r, [[0, 0, 0, 1], [1, 0, 0, 2]]), captures = await artifact(r, out)
	const original = JSON.parse(captures.manifest)
	for (const mutate of [
		(m) => { m.statistics.absentRecordCells = 1 }, (m) => { m.grid.origin[0] = 7 },
		(m) => { m.creation.algorithm = "geocluster-binning-v1" }, (m) => { m.arrays.push({ ...m.arrays[0], role: "counts", dtype: "<u4" }) },
	]) {
		const m = structuredClone(original); mutate(m); m.generation = await manifestGeneration(m)
		await assert.rejects(readManifest(Buffer.from(canonicalJson(m))))
	}
	const invalidMask = { ...captures, "member:valid": encodeNpy(new Uint8Array([1, 2]), r.shape) }, m = structuredClone(original)
	const member = m.arrays.find((a) => a.role === "valid"); member.sha256 = hash(invalidMask["member:valid"]); member.contentId = `sha256:${member.sha256}`
	m.generation = await manifestGeneration(m); invalidMask.manifest = Buffer.from(canonicalJson(m))
	await assert.rejects(worker({ action: "inspect-artifact", options: { indices: [[0, 0, 0]], limit: 1 } }, invalidMask), /mask/)
	for (const options of [{ indices: [[2, 0, 0]] }, { limit: 257 }, { region: { min: [0, 0, 0], max: [0, 1, 1] } }, { extra: true }]) await assert.rejects(worker({ action: "inspect-artifact", options }, captures), (e) => e.status === 400)
	for (const edits of [[{ index: [0, 0, 0], valid: true, value: "string" }], [{ index: [0, 0, 0], valid: false, value: 0 }], [{ index: [0, 0, 0], valid: false }, { index: [0, 0, 0], valid: false }], Array.from({ length: 257 }, () => ({ index: [0, 0, 0], valid: false }))]) await assert.rejects(worker({ action: "materialize-artifact", options: { edits } }, captures), (e) => e.status === 400)
})

test("v1 observation and NPY manifests remain readable/inspectable and derive imported-grid replacement", async () => {
	const r = recipe([2, 1, 1]), observation = { schemaVersion: 1, algorithm: "geocluster-binning-v1", name: "Original", scope: r.scope, geometry: { mode: "points", x: 0, y: 1, z: 2, zMeaning: { type: "elevation" } }, reference: { horizontal: { type: "local", name: "mine" }, horizontalUnit: "m", verticalUnit: "m", verticalReference: "datum" }, value: { ...r.field, aggregation: "mean" }, numbers: neutral, predicates: [], grid: { spacing: [1, 1, 1], extent: { type: "custom", origin: [0, 0, 0], shape: [2, 1, 1], acceptClipping: false } }, predecessor: null }
	const obs = await worker({ action: "compute", recipe: observation, input: r.scope.input, materialize: true }, { binding: csv([[0.2, 0.2, 0.2, 0], [1.2, 0.2, 0.2, -2]]) })
	const metadata = defaultSpatialMetadata("volume.npy"), imported = await worker({ action: "import", recipe: { schemaVersion: 1, source, metadata, defaults: Object.keys(metadata), predecessor: null } }, { binding: encodeNpy(new Float64Array([0, -2]), [2, 1, 1]) })
	for (const [mode, result, inputRecipe, type] of [["binned-observations", obs, observation, "table-to-voxel"], ["imported-volume", imported, { schemaVersion: 1, source, metadata, defaults: Object.keys(metadata), predecessor: null }, "imported-volume"]]) {
		const captures = await artifact(r, result), m = JSON.parse(captures.manifest)
		m.creation.mode = mode; m.creation.algorithm = mode === "binned-observations" ? "geocluster-binning-v1" : "bounded-npy-v1"; m.recipe = { type, recipe: inputRecipe }; m.statistics = result.statistics
		for (const a of m.arrays) if (a.role === "counts") a.dtype = "<u4"
		m.generation = await manifestGeneration(m); captures.manifest = Buffer.from(canonicalJson(m))
		const inspected = await worker({ action: "inspect-artifact", options: { indices: [[0, 0, 0], [1, 0, 0]] } }, captures)
		assert.equal(inspected.integrity, "verified"); assert.deepEqual(inspected.cells.map((c) => c.value), [0, -2]); assert.equal(inspected.cells[0].valid, true)
		const replacement = await worker({ action: "materialize-artifact", options: {} }, captures)
		assert.equal(replacement.complete, true); assert.equal(replacement.recipe.algorithm, "geocluster-indexed-v1"); assert.equal(replacement.recipe.scope.input, null)
	}
})
