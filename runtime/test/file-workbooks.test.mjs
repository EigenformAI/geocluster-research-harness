import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { setTimeout as wait } from "node:timers/promises"
import { test } from "node:test"
import Database from "better-sqlite3"
import { WorkspaceFiles } from "../lib/workspace-files.js"
import { loadFilesConfig } from "../files-server.js"

const logger = { info() {}, warn() {}, error() {} }
const cell = (raw, extra = {}) => ({ type: typeof raw === "string" ? "s" : "n", raw, display: String(raw), format: null, formula: null, cache: "not-formula", ...extra })
const rows = [
	{ 0: cell("=Header"), 1: cell("Value"), 2: cell("Other") },
	{ 0: cell("001"), 1: cell("1.23000000000000001", { type: "n", display: "1.23" }), 2: cell("first") },
	{ 0: cell("002"), 1: cell(null, { type: "n", display: "No cached value", formula: "SUM(B2:B2)", cache: "missing" }), 2: cell("second") },
	{ 0: cell("003"), 1: cell(2), 2: cell("NEEDLE") },
	{ 0: cell("004"), 1: cell("=literal"), 2: cell("needle") },
]
class FakeReader {
	constructor({ entries = rows.map((cells, row) => ({ row, cells })), rowCount = 5, columnCount = 3 } = {}) { this.availability = { state: "available", build: "fixture-reader-v1" }; this.limits = {}; this.calls = 0; this.entries = entries; this.rowCount = rowCount; this.columnCount = columnCount }
	async init() {}
	async parse({ handle, outputPath, signal }) {
		this.calls++
		if (this.block) await new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { status: 409, error: "job_cancelled" })), { once: true }); this.unblock = resolve })
		const bytes = await handle.readFile(), db = new Database(outputPath)
		db.exec("CREATE TABLE rows(sheet TEXT,row INTEGER,cells TEXT,PRIMARY KEY(sheet,row))")
		const insert = db.prepare("INSERT INTO rows VALUES(?,?,?)")
		this.entries.forEach(({ cells, row }) => insert.run("sheet-0", row, JSON.stringify(cells))); db.close(); await fs.chmod(outputPath, 0o400)
		return { schemaVersion: 1, parser: "fixture-reader-v1", origin: "fresh", dateSystem: "1900", sheets: [{ id: "sheet-0", name: "Data", ordinal: 0, visibility: "visible", kind: "worksheet", rows: this.rowCount, columns: this.columnCount, indexedRows: this.entries.length, storedRange: null, populatedCells: this.entries.reduce((count, entry) => count + Object.keys(entry.cells).length, 0), merges: [], modes: ["stored", "formula"], warnings: [] }], warnings: [], metrics: { durationMs: 1, peakRssKiB: 100, inputBytes: bytes.length, outputBytes: (await fs.stat(outputPath)).size }, inputSha256: crypto.createHash("sha256").update(bytes).digest("hex") }
	}
}
async function fixture(t, limits = {}, reader = new FakeReader(), overrides = {}) {
	const base = await fs.mkdtemp(path.join(os.homedir(), ".gc-workbook-")), workspaceDir = path.join(base, "project")
	await fs.mkdir(workspaceDir)
	const config = { workspaceDir, filesStateDir: path.join(base, "state"), filesAgentUids: [20001], filesWorkerUids: [20003], filesWorkbookReader: reader, filesLimits: { workbookIndexBytes: 65536, ...limits }, ...overrides, processingFactory: () => ({ async init() {}, async reconcileOperations() {}, async close() {}, async drain() { return { complete: true } }, async capabilities() { return { enabled: false } } }) }
	let files = await WorkspaceFiles.open(config, logger)
	await fs.writeFile(path.join(workspaceDir, "book.xlsx"), "fixture captured workbook bytes")
	const captured = await files.captures.create({ requestId: "input", path: "book.xlsx", computeDigest: true })
	t.after(async () => { await files.close(); await fs.rm(base, { recursive: true, force: true }) })
	return { config, reader, captured, root: workspaceDir, get files() { return files }, async restart() { await files.close(); files = await WorkspaceFiles.open(config, logger) } }
}
async function prepare(f, requestId = "prepare") {
	const result = await f.files.preparation({ requestId, type: "workbook", source: f.captured.source, options: {} })
	if (result.representation) return result
	for (let n = 0; n < 200; n++) { const job = await f.files.job(result.jobId); if (job.state === "succeeded") { await Promise.allSettled([...f.files.workbooks.pending]); return job.result } if (["failed", "cancelled", "interrupted"].includes(job.state)) throw new Error(JSON.stringify(job.error)); await wait(10) }
	throw new Error("preparation did not settle")
}
const query = (patch = {}) => ({ sheet: "sheet-0", mode: "stored", rowOffset: 0, rowLimit: 1, columnOffset: 0, columnLimit: 1, range: null, headerRows: [0], filter: "", sort: null, ...patch })

test("workbook: full-scope filter before paging, absolute range columns, conservative detection and numeric sort", async (t) => {
	const f = await fixture(t), { representation: m } = await prepare(f)
	const p = await f.files.workbookQuery(m.id, query({ filter: "needle" }))
	assert.equal(p.matchingRows, 2); assert.equal(p.rows[0].row, 3); assert.equal(p.columns[0].numeric, false)
	assert.equal(p.rows[0].cells[0].address, "A4")
	const range = { rowStart: 0, rowEnd: 4, columnStart: 1, columnEnd: 2 }
	const selected = await f.files.workbookQuery(m.id, query({ range, columnOffset: 1 }))
	assert.equal(selected.columns[0].index, 2); assert.equal(selected.rows[0].cells[0].address, "C2"); assert.equal(selected.scope, "selected-range")
	const sorted = await f.files.workbookQuery(m.id, query({ rowLimit: 4, sort: { column: 1, direction: "desc", mode: "number" } }))
	assert.deepEqual(sorted.rows.map((r) => r.row), [3, 1, 2, 4])
})

test("workbook: off-page selected CSV exports raw lexical values, escaping and provenance; typed cells retain fidelity", async (t) => {
	const f = await fixture(t), { representation: m } = await prepare(f)
	const request = { query: query({ filter: "not-found", rowOffset: 999, columnLimit: 1 }), selectedRows: [4, 1, 2], formulaHandling: "escaped-text" }
	const e = await f.files.workbookExport(m.id, request)
	assert.equal(e.csv, "'=Header,Value,Other\r\n001,1.23000000000000001,first\r\n002,,second\r\n004,'=literal,needle\r\n")
	assert.equal(e.metadata.inputSha256, m.inputSha256); assert.equal(e.metadata.captureId, f.captured.source.captureId); assert.equal(e.metadata.representationId, m.id)
	assert.deepEqual(e.metadata.sourceRows, [1, 2, 4]); assert.deepEqual(e.metadata.sourceColumns, [0, 1, 2]); assert.equal(e.metadata.transformations.missingFormulaCaches, 1); assert.equal(e.metadata.transformations.escapedTextCells, 2)
	const typed = await f.files.workbookExport(m.id, { ...request, format: "typed-jsonl" })
	const values = typed.typedJsonl.trim().split("\n").map(JSON.parse)
	assert.equal(values[0].cells[1].raw, "1.23000000000000001"); assert.equal(values[1].cells[1].cache, "missing"); assert.equal(values[2].cells[1].raw, "=literal")
	const exact = await f.files.workbookExport(m.id, { ...request, formulaHandling: "exact" }); assert.ok(exact.csv.startsWith("=Header,")); assert.ok(exact.csv.includes(",=literal,"))
	const ranged = await f.files.workbookExport(m.id, { ...request, query: query({ range: { rowStart: 1, rowEnd: 3, columnStart: 1, columnEnd: 2 } }), selectedRows: [0, 1, 4] })
	assert.equal(ranged.csv, "Value,Other\r\n1.23000000000000001,first\r\n"); assert.deepEqual(ranged.metadata.sourceRows, [1]); assert.deepEqual(ranged.metadata.sourceColumns, [1, 2])
})

test("workbook: sparse gaps do not become rows, but indexed blank and stub rows survive pages and exports", async (t) => {
	const reader = new FakeReader({ rowCount: 12, columnCount: 2, entries: [
		{ row: 0, cells: { 0: cell("Name"), 1: cell("Amount") } },
		{ row: 2, cells: { 0: cell("first"), 1: cell(10) } },
		{ row: 5, cells: {} },
		{ row: 8, cells: { 0: cell(null, { type: "z", display: "" }) } },
		{ row: 10, cells: { 0: cell("tail"), 1: cell(20) } },
	] })
	const f = await fixture(t, {}, reader), { representation: m } = await prepare(f), q = query({ rowLimit: 2, columnLimit: 2 })
	assert.equal(m.sheets[0].indexedRows, 5); assert.equal(m.sheets[0].storedRange, null)
	const first = await f.files.workbookQuery(m.id, q), second = await f.files.workbookQuery(m.id, { ...q, rowOffset: 2 })
	assert.equal(first.matchingRows, 4); assert.deepEqual(first.rows.map((row) => row.row), [2, 5]); assert.deepEqual(second.rows.map((row) => row.row), [8, 10])
	assert.equal(first.rows[1].cells[0].raw, null); assert.equal(second.rows[0].cells[0].type, "z")
	const e = await f.files.workbookExport(m.id, { query: { ...q, rowOffset: 999 }, selectedRows: null, formulaHandling: "exact" })
	assert.deepEqual(e.metadata.sourceRows, [2, 5, 8, 10]); assert.equal(e.csv, "Name,Amount\r\nfirst,10\r\n,\r\n,\r\ntail,20\r\n")
	const ranged = await f.files.workbookQuery(m.id, { ...q, range: { rowStart: 3, rowEnd: 9, columnStart: 0, columnEnd: 1 } })
	assert.equal(ranged.matchingRows, 2); assert.deepEqual(ranged.rows.map((row) => row.row), [5, 8])
	const selected = await f.files.workbookExport(m.id, { query: q, selectedRows: [2, 3, 5, 8, 10], format: "typed-jsonl" })
	assert.deepEqual(selected.metadata.sourceRows, [2, 5, 8, 10])
})

test("workbook: sheet row evidence preserves dimensioned-empty and unsupported inventory, and formula-only data", async (t) => {
	class InventoryReader extends FakeReader {
		async parse(input) {
			const m = await super.parse(input)
			m.sheets[0].storedRange = "A1:A12"
			m.sheets.push({ ...m.sheets[0], id: "sheet-1", ordinal: 1, name: "Dimensioned empty", rows: 64, columns: 12, indexedRows: 0, storedRange: "A1:L64", populatedCells: 0 }, { ...m.sheets[0], id: "sheet-2", ordinal: 2, name: "Chart", kind: "unsupported", reason: "Chart sheet", rows: 0, columns: 0, indexedRows: 0, storedRange: null, populatedCells: null, modes: [] })
			return m
		}
	}
	const reader = new InventoryReader({ rowCount: 12, columnCount: 1, entries: [{ row: 5, cells: { 0: cell(null, { formula: "1+1", cache: "missing", display: "" }) } }] })
	const f = await fixture(t, {}, reader), { representation: m } = await prepare(f)
	assert.deepEqual(m.sheets.map((sheet) => [sheet.id, sheet.indexedRows, sheet.storedRange]), [["sheet-0", 1, "A1:A12"], ["sheet-1", 0, "A1:L64"], ["sheet-2", 0, null]])
	const empty = await f.files.workbookQuery(m.id, query({ sheet: "sheet-1", headerRows: [] }))
	assert.equal(empty.sheet.indexedRows, 0); assert.equal(empty.matchingRows, 0); assert.deepEqual(empty.rows, [])
	const formulas = await f.files.workbookQuery(m.id, query({ mode: "formula", headerRows: [] }))
	assert.equal(formulas.matchingRows, 1); assert.equal(formulas.rows[0].row, 5); assert.equal(formulas.rows[0].cells[0].cache, "missing")
	await assert.rejects(f.files.workbookQuery(m.id, query({ sheet: "sheet-2" })), { status: 415, error: "unsupported_sheet" })
})

test("workbook: sparse index row-count disagreement is rejected before publication and releases capacity", async (t) => {
	class IncorrectCountReader extends FakeReader { async parse(input) { const m = await super.parse(input); m.sheets[0].indexedRows++; return m } }
	const f = await fixture(t, {}, new IncorrectCountReader({ rowCount: 12 })), admitted = await f.files.preparation({ requestId: "wrong-indexed-count", type: "workbook", source: f.captured.source, options: {} })
	let job
	for (let n = 0; n < 200; n++) { job = await f.files.job(admitted.jobId); if (["failed", "succeeded"].includes(job.state)) break; await wait(10) }
	assert.equal(job.state, "failed"); assert.equal(job.error.error, "invalid_workbook_index"); assert.match(job.error.message, /row count/i)
	assert.equal((await f.files.drain(new Date(Date.now() + 5000).toISOString())).complete, true)
	assert.equal((await f.files.state.list("workbook-indexes")).length, 0); assert.equal((await f.files.state.list("index-reservations")).length, 0)
})

test("workbook: malformed indexed-row and stored-range evidence cannot be published", async (t) => {
	for (const patch of [{ indexedRows: -1 }, { indexedRows: 13 }, { indexedRows: "5" }, { indexedRows: undefined }, { storedRange: undefined }, { storedRange: 123 }]) {
		class InvalidEvidenceReader extends FakeReader { async parse(input) { const m = await super.parse(input); Object.assign(m.sheets[0], patch); return m } }
		const f = await fixture(t, {}, new InvalidEvidenceReader({ rowCount: 12 })), admitted = await f.files.preparation({ requestId: "bad-evidence", type: "workbook", source: f.captured.source, options: {} })
		let job
		for (let n = 0; n < 200; n++) { job = await f.files.job(admitted.jobId); if (["failed", "succeeded"].includes(job.state)) break; await wait(10) }
		assert.equal(job.state, "failed", JSON.stringify(patch)); assert.equal(job.error.error, "invalid_workbook_manifest")
	}
})

test("workbook: discovery and manifests expose actual cells, ZIP entries, member and row byte ceilings", async (t) => {
	const reader = new FakeReader(); reader.limits = { cells: 3000000, zipEntries: 25000, memberBytes: 64 * 1048576, rowBytes: 12 * 1048576 }
	const f = await fixture(t, {}, reader), { representation: m } = await prepare(f), provider = (await f.files.info()).providerDetails.find((p) => p.id === "workbook")
	for (const [name, value] of Object.entries(reader.limits)) { assert.equal(provider.limits[name], value, name); assert.equal(m.limits[name], value, name) }
})

test("workbook: FILES_LIMITS overrides configure the actual reader above its default cell ceiling", async (t) => {
	const { WorkbookReader } = await import("../lib/workbook-reader.js"), { makeWorkbookFixture } = await import("./workbook-fixtures.mjs")
	const overrides = { workbookCells: 3000000, workbookZipEntries: 25000, workbookMemberBytes: 64 * 1048576, workbookRowBytes: 12 * 1048576 }, config = loadFilesConfig({ WORKSPACE_DIR: "/workspace", FILES_LIMITS: JSON.stringify(overrides) })
	const worker = fileURLToPath(new URL("../lib/workbook-reader-worker.cjs", import.meta.url)), testRunner = { synthetic: true, spawn: () => spawn(process.execPath, [worker], { stdio: ["pipe", "pipe", "pipe"], env: { GC_WORKBOOK_SYNTHETIC: "1" } }) }
	let reader
	const f = await fixture(t, config.filesLimits, (readerConfig, logger) => (reader = new WorkbookReader({ ...readerConfig, testRunner }, logger)))
	await fs.writeFile(path.join(f.root, "real.xlsx"), makeWorkbookFixture())
	f.captured = await f.files.captures.create({ requestId: "limits-input", path: "real.xlsx", computeDigest: true })
	const { representation: m } = await prepare(f)
	assert.equal(reader.limits.cells, 3000000); assert.equal(reader.limits.zipEntries, 25000); assert.equal(reader.limits.memberBytes, 64 * 1048576); assert.equal(reader.limits.rowBytes, 12 * 1048576)
	for (const name of ["cells", "zipEntries", "memberBytes", "rowBytes"]) assert.equal(m.limits[name], reader.limits[name])
	assert.equal(m.limits.readerEnvelope, undefined, "Synthetic decoding does not claim installed memory enforcement.")
	const low = await fixture(t, { workbookCells: 3 }, (readerConfig, logger) => new WorkbookReader({ ...readerConfig, testRunner }, logger))
	await fs.writeFile(path.join(low.root, "real.xlsx"), makeWorkbookFixture()); low.captured = await low.files.captures.create({ requestId: "low-input", path: "real.xlsx", computeDigest: true })
	const admitted = await low.files.preparation({ requestId: "low-cell-budget", type: "workbook", source: low.captured.source, options: {} })
	let job
	for (let n = 0; n < 200; n++) { job = await low.files.job(admitted.jobId); if (["failed", "succeeded"].includes(job.state)) break; await wait(10) }
	assert.equal(job.state, "failed"); assert.equal(job.error.error, "workbook_budget")
})

test("workbook: explicit source headers outside the data range label pages and both CSV export modes", async (t) => {
	const f = await fixture(t), { representation: m } = await prepare(f), q = query({ range: { rowStart: 1, rowEnd: 3, columnStart: 1, columnEnd: 2 }, headerRows: [4], columnLimit: 2 })
	const p = await f.files.workbookQuery(m.id, q)
	assert.deepEqual(p.columns.map((column) => column.header), ["=literal", "needle"]); assert.equal(p.matchingRows, 3)
	const all = await f.files.workbookExport(m.id, { query: q, selectedRows: null })
	assert.equal(all.csv, "'=literal,needle\r\n1.23000000000000001,first\r\n,second\r\n2,NEEDLE\r\n")
	const selected = await f.files.workbookExport(m.id, { query: q, selectedRows: [1, 4], formulaHandling: "exact" })
	assert.equal(selected.csv, "=literal,needle\r\n1.23000000000000001,first\r\n"); assert.deepEqual(selected.metadata.sourceRows, [1])
	const combined = await f.files.workbookQuery(m.id, { ...q, headerRows: [0, 4] })
	assert.deepEqual(combined.columns.map((column) => column.header), ["Value / =literal", "Other / needle"])
})

test("workbook: digest completion preserves representation and request identity while contradictory SHA is rejected", async (t) => {
	const f = await fixture(t)
	f.captured = await f.files.captures.retainStaged(path.join(f.root, "book.xlsx"), f.files.ref("book.xlsx"))
	const unrequested = structuredClone(f.captured.source); assert.equal(unrequested.digest.state, "not-requested")
	const { representation: m } = await prepare(f)
	const assertedReady = await f.files.preparation({ requestId: "asserted-ready", type: "workbook", source: { ...unrequested, digest: { state: "ready", sha256: m.inputSha256 } }, options: {} })
	assert.equal(assertedReady.source.digest.state, "not-requested"); assert.equal(assertedReady.representation.source.digest.state, "not-requested")
	assert.equal("digest" in (await f.files.request("asserted-ready")).intent.source, false)
	await assert.rejects(f.files.preparation({ requestId: "forged-before-capture-hash", type: "workbook", source: { ...unrequested, digest: { state: "ready", sha256: "0".repeat(64) } }, options: {} }), { status: 409, error: "source_changed" })
	const hashed = await f.files.captures.create({ requestId: "digest-existing", path: "book.xlsx", requireCoherentSource: true, computeDigest: true })
	assert.equal(hashed.source.captureId, unrequested.captureId); assert.equal(hashed.source.digest.sha256, m.inputSha256)
	assert.deepEqual(await f.files.representation(m.id), m); assert.equal((await f.files.workbookQuery(m.id, query())).rows[0].row, 1)
	f.captured = hashed
	assert.equal((await prepare(f)).representation.id, m.id)
	assert.equal((await f.files.preparation({ requestId: "stale-digest", type: "workbook", source: unrequested, options: {} })).representation.id, m.id)
	assert.equal((await prepare(f, "new-ready-intent")).representation.id, m.id); assert.equal(f.reader.calls, 1)
	for (const requestId of ["prepare", "forged-ready-sha"]) await assert.rejects(f.files.preparation({ requestId, type: "workbook", source: { ...hashed.source, digest: { state: "ready", sha256: "0".repeat(64) } }, options: {} }), { status: 409, error: "source_changed" })
	await f.restart(); assert.equal((await f.files.representation(m.id)).id, m.id); assert.equal((await prepare(f)).representation.id, m.id); assert.equal(f.reader.calls, 1)
})

test("workbook: pending digest work can settle before index publication without changing its input binding", async (t) => {
	const f = await fixture(t); f.captured = await f.files.captures.retainStaged(path.join(f.root, "book.xlsx"), f.files.ref("book.xlsx")); f.reader.block = true
	const admitted = await f.files.preparation({ requestId: "digest-during-parse", type: "workbook", source: f.captured.source, options: {} })
	for (let n = 0; n < 200 && !f.reader.unblock; n++) await wait(10)
	const hashed = await f.files.captures.create({ requestId: "digest-during", path: "book.xlsx", requireCoherentSource: true, computeDigest: true })
	assert.equal(hashed.source.captureId, f.captured.source.captureId); assert.equal(hashed.source.digest.state, "ready")
	f.reader.unblock(); const { representation: m } = await prepare(f, "digest-during-parse")
	assert.equal((await f.files.job(admitted.jobId)).state, "succeeded"); assert.equal(m.inputSha256, hashed.source.digest.sha256); assert.equal((await f.files.representation(m.id)).id, m.id)
})

test("workbook: missing caches never match synthetic notices; formula mode searches actual formula text", async (t) => {
	const f = await fixture(t), { representation: m } = await prepare(f)
	assert.equal((await f.files.workbookQuery(m.id, query({ filter: "No cached value" }))).matchingRows, 0)
	const p = await f.files.workbookQuery(m.id, query({ filter: "sum(b2", mode: "formula", columnLimit: 3 }))
	assert.equal(p.matchingRows, 1); assert.equal(p.rows[0].cells[1].raw, null); assert.equal(p.rows[0].cells[1].cache, "missing")
})

test("workbook: source binding rejects forged fields and Current changes never rebind; resident manifest survives restart", async (t) => {
	const f = await fixture(t)
	for (const patch of [{ etag: '"wrong"' }, { sizeBytes: 1 }, { ref: { ...f.captured.source.ref, path: "other.xlsx" } }, { digest: { state: "ready", sha256: "0".repeat(64) } }]) await assert.rejects(f.files.preparation({ requestId: crypto.randomUUID(), type: "workbook", source: { ...f.captured.source, ...patch }, options: {} }), { status: 409, error: "source_changed" })
	const { representation: m } = await prepare(f)
	await fs.writeFile(path.join(f.root, "book.xlsx"), "replacement bytes")
	await f.restart()
	assert.deepEqual(await f.files.representation(m.id), m); assert.equal((await f.files.workbookQuery(m.id, query())).rows[0].row, 1)
	assert.equal((await prepare(f, "second-intent")).representation.id, m.id); assert.equal(f.reader.calls, 1)
})

test("workbook: independent readiness, in-flight dedup, durable holds and cancellation cleanup", async (t) => {
	const f = await fixture(t); f.reader.block = true
	const info = await f.files.info(); assert.ok(info.operations.includes("workbook-query")); assert.ok(info.operations.includes("preparations")); assert.equal(info.providerDetails.find((p) => p.id === "workbook").queryScope, "full-sheet-or-range")
	assert.equal(f.files.captures.parser.availability.state, "unavailable")
	const input = { type: "workbook", source: f.captured.source, options: {} }
	const a = await f.files.preparation({ ...input, requestId: "first" }), b = await f.files.preparation({ ...input, requestId: "second" })
	assert.equal(a.jobId, b.jobId)
	await f.files.captures.releaseLease(f.captured.lease.leaseId); f.files.captures.limits.previewIdleMs = 0
	await f.files.captures.sweep(); assert.equal((await f.files.captures.get("capture", f.captured.source.captureId)).availability, "available")
	await f.files.cancelJob(a.jobId)
	for (let n = 0; n < 100 && (await f.files.job(a.jobId)).state !== "cancelled"; n++) await wait(10)
	assert.equal((await f.files.job(a.jobId)).state, "cancelled")
	assert.equal((await f.files.drain(new Date(Date.now() + 5000).toISOString())).complete, true)
	assert.equal((await f.files.request("second")).state, "cancelled"); assert.equal((await f.files.state.list("holds")).length, 0); assert.equal((await f.files.state.list("index-reservations")).length, 0)
	assert.deepEqual(await fs.readdir(f.files.captures.blobDir), [`capture.${f.captured.source.captureId}`])
})

test("workbook: measured index accounting and capture lease protect index; source eviction cascades with explicit 410", async (t) => {
	const f = await fixture(t), { representation: m, lease } = await prepare(f)
	const index = await f.files.state.get("workbook-indexes", m.id), swept = await f.files.captures.sweep()
	assert.equal(swept.retainedBytes, f.captured.source.sizeBytes + index.sizeBytes + index.metadataBytes); assert.equal(index.kind, "index"); assert.equal((await f.files.state.list("index-reservations")).length, 0)
	await f.files.captures.releaseLease(f.captured.lease.leaseId); f.files.captures.limits.previewBytes = 1
	await f.files.captures.sweep(); assert.equal((await f.files.representation(m.id)).id, m.id)
	await f.files.captures.releaseLease(lease.leaseId); await f.files.captures.sweep()
	await assert.rejects(f.files.representation(m.id), { status: 410 }); await assert.rejects(f.files.workbookQuery(m.id, query()), { status: 410 })
	assert.deepEqual(await fs.readdir(f.files.captures.blobDir), [])
})

test("workbook: reserve maximum staging before reader admission and persist actionable failed receipt", async (t) => {
	const f = await fixture(t); f.files.captures.limits.retainedBytes = 100
	await assert.rejects(prepare(f), { status: 507, error: "insufficient_storage" }); assert.equal(f.reader.calls, 0); assert.equal((await f.files.request("prepare")).state, "failed")
})

test("workbook: restart interrupts unfinished preparation receipts and releases abandoned holds/reservations", async (t) => {
	const f = await fixture(t), jobId = crypto.randomUUID(), holdId = `workbook-${jobId}`
	await f.files.captures.hold("capture", f.captured.source.captureId, "workbook", holdId)
	await f.files.state.put("jobs", jobId, { jobId, type: "preparation", preparationType: "workbook", state: "running", stage: "parsing", holdId, requestId: "interrupted", requestIds: ["interrupted"], source: { kind: "capture", id: f.captured.source.captureId }, progress: { bytesDone: 0, totalBytes: 10, elapsedMs: 0 }, result: null, error: null })
	await f.files.state.put("requests", "interrupted", { requestId: "interrupted", type: "preparation", preparationType: "workbook", jobId, state: "running", result: null, error: null })
	await f.files.state.put("index-reservations", jobId, { id: jobId, jobId, sizeBytes: 65536 })
	await f.restart()
	assert.equal((await f.files.request("interrupted")).state, "interrupted"); assert.equal((await f.files.state.list("holds")).length, 0); assert.equal((await f.files.state.list("index-reservations")).length, 0)
})

test("workbook: real query processes settle timeout and abort before lane reuse; response budgets reject whole results", async (t) => {
	const f = await fixture(t), { representation: m } = await prepare(f)
	const worker = f.files.workbooks.worker.bind(f.files.workbooks)
	t.mock.method(f.files.workbooks, "worker", async (...args) => {
		const pending = worker(...args)
		assert.throws(() => f.files.acquireNative(), { status: 429, error: "capacity" })
		try { return await pending } finally { assert.throws(() => f.files.acquireNative(), { status: 429, error: "capacity" }) }
	})
	f.files.workbooks.limits.workbookQueryMs = 1
	await assert.rejects(f.files.workbookQuery(m.id, query()), { status: 408, error: "workbook_time_limit" })
	f.files.workbooks.limits.workbookQueryMs = 5000
	assert.equal((await f.files.workbookQuery(m.id, query())).matchingRows, 4)
	const controller = new AbortController(); controller.abort()
	await assert.rejects(f.files.workbookQuery(m.id, query(), controller.signal), { status: 409, error: "job_cancelled" })
	assert.equal((await f.files.workbookQuery(m.id, query())).matchingRows, 4)
	f.files.workbooks.limits.workbookPageBytes = 64
	await assert.rejects(f.files.workbookQuery(m.id, query()), { status: 413 })
	f.files.workbooks.limits.workbookExportBytes = 64
	await assert.rejects(f.files.workbookExport(m.id, { query: query(), selectedRows: null }), { status: 413 })
	const release = f.files.acquireNative(); release()
})

for (const mode of ["query", "export"]) for (const operation of ["query", "preparation"]) test(`workbook ${mode} and GIS ${operation} reject jittered competing dispatch in both admission orders`, async (t) => {
	let entered, unblock
	t.after(() => unblock?.())
	const gisReader = { availability: { state: "available", build: "shared-slot-gis/1", confinement: "synthetic-test-only" }, async init() {}, async read({ members, operation }) {
		const inputDigests = []
		for (const m of members) inputDigests.push({ name: m.name, sha256: crypto.createHash("sha256").update(await fs.readFile(`/proc/self/fd/${m.handle.fd}`)).digest("hex") })
		return { schemaVersion: 1, parser: "shared-slot-gis/1", coverage: "geometry not requested", warnings: [], inputDigests, ...(operation === "manifest" ? { layers: [{ id: "layer-0", name: "points", fields: [], crsWkt: null, axisMapping: null, reportedFeatureCount: 1 }] } : { layerId: "layer-0", offset: 0, limit: 1, rows: [{ locator: "layer-0:0", sourceId: "0", properties: {} }], nextOffset: null, reportedFeatureCount: 1, scannedFeatures: 1, geometryCoverage: "not-requested" }) }
	} }
	const f = await fixture(t, {}, new FakeReader(), { filesGisReader: gisReader }), { representation: m } = await prepare(f)
	await fs.writeFile(path.join(f.root, "points.geojson"), "captured GIS bytes")
	const source = (await f.files.captures.create({ requestId: "gis-input", path: "points.geojson", computeDigest: true })).source
	const admitted = await f.files.preparation({ requestId: "gis-original", type: "vector", source })
	for (let n = 0; n < 200 && !["succeeded", "failed"].includes((await f.files.job(admitted.jobId)).state); n++) await wait(10)
	await Promise.allSettled([...f.files.gis.pending])
	const job = await f.files.job(admitted.jobId); assert.equal(job.state, "succeeded", JSON.stringify(job.error))
	const gisId = job.result.representation.id, gisQuery = { operation: "attributes", layerId: "layer-0", offset: 0, limit: 1 }
	// Different capture identity forces preparation rather than resident reuse.
	const freshSource = (await f.files.captures.create({ requestId: "gis-fresh-input", path: "points.geojson", computeDigest: true })).source
	const workbook = () => mode === "query" ? f.files.workbookQuery(m.id, query()) : f.files.workbookExport(m.id, { query: query() })
	const gis = (id) => operation === "query" ? f.files.representationQuery(gisId, gisQuery) : f.files.preparation({ requestId: id, type: "vector", source: freshSource })
	let workbookDispatches = 0, gisDispatches = 0
	const worker = f.files.workbooks.worker.bind(f.files.workbooks), read = gisReader.read.bind(gisReader)
	const hold = () => { const started = new Promise((resolve) => { entered = resolve }), blocked = new Promise((resolve) => { unblock = resolve }); return { started, blocked } }
	let barrier = hold()
	let holdGis = false
	t.mock.method(gisReader, "read", async (...args) => { gisDispatches++; if (holdGis) { entered(); await barrier.blocked } return read(...args) })
	t.mock.method(f.files.workbooks, "worker", async (...args) => { workbookDispatches++; entered(); await barrier.blocked; return worker(...args) })
	const activeWorkbook = workbook(); await barrier.started
	await Promise.all(Array.from({ length: 12 }, async (_, n) => { await wait(Math.floor(Math.random() * 8)); await assert.rejects(gis(`refused-${n}`), { status: 429, error: "capacity" }) }))
	assert.equal(gisDispatches, 0)
	unblock(); await activeWorkbook
	assert.equal(workbookDispatches, 1)
	barrier = hold()
	holdGis = true
	const activeGis = gis("gis-active"); await barrier.started
	await Promise.all(Array.from({ length: 12 }, async () => { await wait(Math.floor(Math.random() * 8)); await assert.rejects(workbook(), { status: 429, error: "capacity" }) }))
	assert.equal(workbookDispatches, 1, "Rejected workbook calls must not reach native dispatch.")
	unblock(); const result = await activeGis
	if (result.jobId) {
		for (let n = 0; n < 200 && !["succeeded", "failed"].includes((await f.files.job(result.jobId)).state); n++) await wait(10)
		await Promise.allSettled([...f.files.gis.pending]); assert.equal((await f.files.job(result.jobId)).state, "succeeded")
	}
	assert.equal(gisDispatches, 1)
	await workbook(); assert.equal(workbookDispatches, 2)
	assert.ok([...f.files.captures.readers.values()].every((n) => n === 0))
})

test("workbook: worker setup and retained-handle cleanup failures release shared native admission", async (t) => {
	const f = await fixture(t), { representation: m } = await prepare(f)
	const worker = f.files.workbooks.worker.bind(f.files.workbooks)
	t.mock.method(f.files.workbooks, "worker", () => { throw new Error("worker setup failed") })
	await assert.rejects(f.files.workbookQuery(m.id, query()), /worker setup failed/)
	let release = f.files.acquireNative(); release()
	t.mock.method(f.files.workbooks, "worker", worker)
	const open = f.files.workbooks.open.bind(f.files.workbooks)
	t.mock.method(f.files.workbooks, "open", async (...args) => { const opened = await open(...args); return { ...opened, release: async () => { await opened.release(); throw new Error("handle cleanup failed") } } })
	await assert.rejects(f.files.workbookQuery(m.id, query()), /handle cleanup failed/)
	release = f.files.acquireNative(); release()
})

test("workbook: preparation deadline settles as failed after reader abort and releases staging capacity", async (t) => {
	const f = await fixture(t); f.reader.block = true; f.files.workbooks.limits.workbookPrepareMs = 50
	const admitted = await f.files.preparation({ requestId: "prepare-timeout", type: "workbook", source: f.captured.source, options: {} })
	for (let n = 0; n < 200 && (await f.files.job(admitted.jobId)).state !== "failed"; n++) await wait(10)
	const job = await f.files.job(admitted.jobId); assert.equal(job.state, "failed"); assert.equal(job.error.status, 408); assert.equal(job.error.error, "workbook_time_limit")
	const drained = await f.files.drain(new Date(Date.now() + 5000).toISOString()); assert.equal(drained.complete, true); assert.equal(drained.failed, 1)
	assert.equal((await f.files.state.list("holds")).length, 0); assert.equal((await f.files.state.list("index-reservations")).length, 0)
})

for (const restart of [false, true]) test(`workbook: new preparation rebuilds a missing index from the exact retained capture${restart ? " after restart" : ""}, but historical queries and replay stay 410`, async (t) => {
	const f = await fixture(t), original = await prepare(f), receipt = await f.files.request("prepare")
	await fs.unlink(path.join(f.files.captures.blobDir, `index.${original.representation.id}`))
	if (restart) await f.restart()
	await assert.rejects(f.files.workbookQuery(original.representation.id, query()), { status: 410, error: "index_expired" })
	await assert.rejects(prepare(f), { status: 410, error: "index_expired" })
	assert.equal(f.reader.calls, 1)
	// Current can change: reconstruction must use the selected immutable capture, not its pathname.
	await fs.writeFile(path.join(f.root, "book.xlsx"), "different Current workbook bytes")
	const rebuilt = await prepare(f, "rebuild")
	assert.notEqual(rebuilt.representation.id, original.representation.id)
	assert.deepEqual(rebuilt.source, original.source); assert.equal(rebuilt.representation.inputSha256, original.representation.inputSha256)
	assert.equal((await f.files.workbookQuery(rebuilt.representation.id, query())).rows[0].row, 1)
	const index = await f.files.state.get("workbook-indexes", rebuilt.representation.id)
	assert.equal((await f.files.captures.sweep()).retainedBytes, rebuilt.source.sizeBytes + index.sizeBytes + index.metadataBytes)
	assert.equal((await prepare(f, "reuse-rebuilt")).representation.id, rebuilt.representation.id); assert.equal(f.reader.calls, 2)
	await assert.rejects(f.files.representation(original.representation.id), { status: 410, error: "index_expired" })
	await assert.rejects(f.files.workbookQuery(original.representation.id, query()), { status: 410, error: "index_expired" })
	await assert.rejects(prepare(f), { status: 410, error: "index_expired" })
	assert.deepEqual(await f.files.request("prepare"), receipt)
	assert.equal((await f.files.job(receipt.jobId)).state, "succeeded")
})

test("workbook: new preparation never reconstructs missing capture bytes from Current", async (t) => {
	const f = await fixture(t), original = await prepare(f)
	await fs.unlink(path.join(f.files.captures.blobDir, `capture.${original.source.captureId}`))
	await assert.rejects(prepare(f, "missing-input"), { status: 410, error: "capture_expired" })
	await assert.rejects(prepare(f), { status: 410, error: "capture_expired" })
	assert.equal(f.reader.calls, 1); assert.equal((await f.files.request("missing-input")).state, "failed")
})

test("workbook: new preparation preserves index integrity failures instead of rebuilding", async (t) => {
	const f = await fixture(t), original = await prepare(f)
	await fs.chmod(path.join(f.files.captures.blobDir, `index.${original.representation.id}`), 0o600)
	await assert.rejects(prepare(f, "changed-index"), { status: 503, error: "capture_store_unavailable", reason: "integrity" })
	assert.equal(f.reader.calls, 1); assert.equal((await f.files.request("changed-index")).state, "failed")
})

test("workbook: successful replay refreshes an expired lease on the same resident index without parsing", async (t) => {
	const f = await fixture(t), ready = await prepare(f), receipt = await f.files.request("prepare")
	const expired = { ...ready, lease: { ...ready.lease, expiresAt: "2000-01-01T00:00:00Z" } }
	await f.files.state.put("requests", "prepare", { ...receipt, result: expired })
	const job = await f.files.job(receipt.jobId)
	await f.files.state.put("jobs", job.jobId, { ...job, result: expired })
	await f.files.state.put("leases", expired.lease.leaseId, expired.lease)
	const replay = await prepare(f)
	assert.ok(Date.parse(replay.lease.expiresAt) > Date.now(), "replay must provide active retention")
	assert.equal(replay.source.captureId, ready.source.captureId); assert.equal(replay.representation.id, ready.representation.id)
	assert.equal(replay.lease.source.id, ready.source.captureId); assert.equal(f.reader.calls, 1)
	assert.deepEqual(await f.files.representation(replay.representation.id), ready.representation)
	assert.equal((await f.files.request("prepare")).state, "succeeded"); assert.equal((await f.files.job(job.jobId)).state, "succeeded")
})

test("workbook: lost index publication acknowledgement preserves evidence and blocks a complete drain", async (t) => {
	const f = await fixture(t), transaction = f.files.state.transaction.bind(f.files.state)
	let injected = false
	f.files.state.transaction = async (operations) => {
		const result = await transaction(operations)
		if (!injected && operations.some((op) => op.kind === "source-publications" && op.value?.kind === "index" && op.value.state === "committed")) { injected = true; throw Object.assign(new Error("lost index acknowledgement"), { code: "EIO" }) }
		return result
	}
	const a = await f.files.preparation({ requestId: "uncertain", type: "workbook", source: f.captured.source, options: {} })
	for (let n = 0; n < 200 && !["failed", "succeeded"].includes((await f.files.job(a.jobId)).state); n++) await wait(10)
	const job = await f.files.job(a.jobId); assert.equal(job.state, "failed"); assert.equal(job.error.state, "indeterminate")
	assert.equal((await f.files.workbooks.drain(new Date(Date.now() + 5000).toISOString())).complete, false)
	assert.ok((await fs.readdir(f.files.captures.blobDir)).includes(`index.${job.resultRef}`)); assert.ok((await f.files.state.list("holds")).some((hold) => hold.source.id === f.captured.source.captureId))
	await f.restart(); assert.equal((await f.files.representation(job.resultRef)).source.captureId, f.captured.source.captureId)
})

test("workbook: preparation cancellation terminates an actual WorkbookReader child before releasing its hold", async (t) => {
	let WorkbookReader, WORKBOOK_PARSER
	try { ({ WorkbookReader, WORKBOOK_PARSER } = await import("../lib/workbook-reader.js")) } catch (error) { if (error.code === "ERR_MODULE_NOT_FOUND") return t.skip("Concurrent reader is not present yet."); throw error }
	let calls = 0, liveChild, childStarted
	const started = new Promise((resolve) => { childStarted = resolve }), worker = fileURLToPath(new URL("../lib/workbook-reader-worker.cjs", import.meta.url))
	const reader = new WorkbookReader({ testRunner: { synthetic: true, spawn: () => {
		if (calls++ === 0) return spawn(process.execPath, [worker], { stdio: ["pipe", "pipe", "pipe"], env: { GC_WORKBOOK_SYNTHETIC: "1" } })
		liveChild = spawn(process.execPath, ["-e", `process.stdout.write(JSON.stringify({ready:true,parser:${JSON.stringify(WORKBOOK_PARSER)},pid:process.pid})+'\\n');process.stdin.resume();setInterval(()=>{},1000)`], { stdio: ["pipe", "pipe", "pipe"], env: {} }); childStarted(); return liveChild
	} } })
	const f = await fixture(t, {}, reader), admitted = await f.files.preparation({ requestId: "real-cancel", type: "workbook", source: f.captured.source, options: {} })
	await started; await f.files.cancelJob(admitted.jobId)
	assert.equal((await f.files.drain(new Date(Date.now() + 5000).toISOString())).complete, true)
	assert.equal((await f.files.job(admitted.jobId)).state, "cancelled"); assert.ok(liveChild.exitCode !== null || liveChild.signalCode !== null)
	assert.equal((await f.files.state.list("holds")).length, 0); assert.equal((await f.files.state.list("index-reservations")).length, 0)
	assert.deepEqual(await fs.readdir(f.files.captures.blobDir), [`capture.${f.captured.source.captureId}`])
})

for (const format of ["xls", "xlsx"]) test(`workbook: genuine ${format} reader output integrates with protected facade and raw export`, async (t) => {
	let WorkbookReader, makeWorkbookFixture
	try { ({ WorkbookReader } = await import("../lib/workbook-reader.js")); ({ makeWorkbookFixture } = await import("./workbook-fixtures.mjs")) } catch (error) { if (error.code === "ERR_MODULE_NOT_FOUND") return t.skip("Concurrent reader implementation is not present yet."); throw error }
	const worker = fileURLToPath(new URL("../lib/workbook-reader-worker.cjs", import.meta.url))
	const reader = new WorkbookReader({ testRunner: { synthetic: true, spawn: () => spawn(process.execPath, [worker], { stdio: ["pipe", "pipe", "pipe"], env: { GC_WORKBOOK_SYNTHETIC: "1" } }) }, limits: { outputBytes: 65536 } })
	const f = await fixture(t, {}, reader), bytes = makeWorkbookFixture(format)
	await fs.writeFile(path.join(f.root, `real.${format}`), bytes)
	f.captured = await f.files.captures.create({ requestId: "real-input", path: `real.${format}`, computeDigest: true })
	const { representation: m } = await prepare(f)
	assert.equal(m.sheets.length, 3); assert.equal(m.sheets[2].visibility, "very-hidden"); assert.equal(m.inputSha256, f.captured.source.digest.sha256)
	assert.deepEqual(m.sheets.map((sheet) => sheet.indexedRows), [3, 1, 0]); assert.equal(m.sheets[0].storedRange, format === "xlsx" ? "A1:F5" : null)
	const page = await f.files.workbookQuery(m.id, query({ columnLimit: 6 }))
	assert.equal(page.matchingRows, 2); assert.equal(page.rows[0].cells[0].raw, "00123")
	const all = await f.files.workbookExport(m.id, { query: query(), selectedRows: null, formulaHandling: "exact" })
	assert.deepEqual(all.metadata.sourceRows, [1, 4])
	const e = await f.files.workbookExport(m.id, { query: query(), selectedRows: [1], formulaHandling: "exact" })
	assert.ok(e.csv.includes("00123")); if (format === "xlsx") { assert.ok(e.csv.includes("12345678901234567890.00100")); assert.equal(e.metadata.transformations.missingFormulaCaches, 1) }
})
