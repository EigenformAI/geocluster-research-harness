import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import XLSX from "xlsx"
import { WorkbookReader } from "../lib/workbook-reader.js"
import { makeWorkbookFixture, workbookMembers, zipFixture, patchBiffFixture } from "./workbook-fixtures.mjs"

const worker = fileURLToPath(new URL("../lib/workbook-reader-worker.cjs", import.meta.url))
export const syntheticRunner = { synthetic: true, spawn: () => spawn(process.execPath, [worker], { stdio: ["pipe", "pipe", "pipe"], env: { GC_WORKBOOK_SYNTHETIC: "1" } }) }
async function setup(t, bytes, config = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workbook-reader-")); t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const input = path.join(dir, "retained"), outputPath = path.join(dir, "index.sqlite"); await fs.writeFile(input, bytes)
	const handle = await fs.open(input, "r"); t.after(() => handle.close())
	const source = { kind: "runtime-capture", captureId: "retained", ref: { path: "replaced.xlsx" }, sizeBytes: bytes.length, digest: { state: "ready", sha256: crypto.createHash("sha256").update(bytes).digest("hex") } }
	const lane = process.env.WORKBOOK_INSTALLED_LAUNCHER ? { launcherPath: process.env.WORKBOOK_INSTALLED_LAUNCHER } : { testRunner: syntheticRunner }
	const reader = new WorkbookReader({ ...lane, ...config }); await reader.init(); t.after(() => reader.close?.())
	return { reader, handle, source, outputPath, input }
}

for (const format of ["xls", "xlsx"]) test(`${format}: real decoding preserves inventory, source rows, dates, merges and cache`, async t => {
	const ctx = await setup(t, makeWorkbookFixture(format)), manifest = await ctx.reader.parse(ctx)
	assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.inputSha256, ctx.source.digest.sha256); assert.equal(manifest.dateSystem, "1900")
	assert.deepEqual(manifest.sheets.map(s => [s.id, s.name, s.visibility]), [["sheet-0", "Data", "visible"], ["sheet-1", "Hidden", "hidden"], ["sheet-2", "Empty", "very-hidden"]])
	assert.deepEqual(manifest.sheets[0].merges, ["C1:D1"]); assert.equal(manifest.sheets[0].rows, 5); assert.equal(manifest.sheets[2].populatedCells, 0)
	assert.deepEqual(manifest.sheets.map(sheet => sheet.indexedRows), [3, 1, 0])
	const db = new Database(ctx.outputPath, { readonly: true }); t.after(() => db.close())
	assert.deepEqual(db.prepare("SELECT row FROM rows WHERE sheet='sheet-0' ORDER BY row").all().map(r => r.row), [0, 1, 4])
	const cells = JSON.parse(db.prepare("SELECT cells FROM rows WHERE sheet='sheet-0' AND row=1").get().cells)
	assert.equal(cells[0].raw, "00123"); assert.equal(cells[1].formula, "1+1"); assert.equal(cells[1].cache, "present"); assert.equal(String(cells[1].raw), "2")
	assert.equal(cells[3].display, "2024-01-01"); assert.equal(cells[3].format, "yyyy-mm-dd"); assert.equal(cells[5].raw, true)
	assert.equal(manifest.metrics.outputBytes, (await fs.stat(ctx.outputPath)).size); assert.ok(manifest.metrics.peakRssKiB > 0)
	assert.equal((await fs.stat(ctx.outputPath)).mode & 0o777, 0o400)
})

const mixedBiffTabs = [
	{ name: "Visiblé", kind: 0, hidden: 0 },
	{ name: "Macro表", kind: 1, hidden: 2 },
	{ name: "Hidden", kind: 0, hidden: 1 },
	{ name: "Chart", kind: 2, hidden: 1 },
	{ name: "Empty", kind: 0, hidden: 0, empty: true },
]

test("BIFF F2 qualification: genuine macro and chart BOFs decode as data without evaluating stored formulas", async t => {
	const bytes = makeWorkbookFixture("xls", { biffTabs: mixedBiffTabs })
	const decoded = XLSX.read(bytes, { type: "buffer", cellFormula: true, cellNF: true, cellText: true, bookVBA: false, WTF: true })
	assert.deepEqual(decoded.SheetNames, mixedBiffTabs.map(tab => tab.name))
	assert.deepEqual(decoded.Workbook.Sheets.map(tab => tab.Hidden), [0, 2, 1, 1, 0])
	assert.equal(decoded.Sheets["Macro表"]["!type"], "macro"); assert.equal(decoded.Sheets.Chart["!type"], "chart")
	assert.deepEqual([decoded.Sheets["Macro表"].B2.f, decoded.Sheets["Macro表"].B2.v], ["1+1", 17])
	const ctx = await setup(t, bytes), manifest = await ctx.reader.parse(ctx)
	assert.deepEqual(manifest.sheets.map(sheet => [sheet.name, sheet.visibility, sheet.kind]), [["Visiblé", "visible", "worksheet"], ["Macro表", "very-hidden", "unsupported"], ["Hidden", "hidden", "worksheet"], ["Chart", "hidden", "unsupported"], ["Empty", "visible", "worksheet"]])
	const db = new Database(ctx.outputPath, { readonly: true }); t.after(() => db.close())
	for (const id of ["sheet-1", "sheet-3"]) { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rows WHERE sheet=?").get(id).count, 0); assert.equal(manifest.sheets[Number(id.slice(6))].indexedRows, 0) }
})

test("BIFF F2: declared tab order survives a different physical substream order", async t => {
	const ctx = await setup(t, makeWorkbookFixture("xls", { biffTabs: mixedBiffTabs, biffTabOrder: [2, 1, 0, 3, 4] })), manifest = await ctx.reader.parse(ctx)
	assert.deepEqual(manifest.sheets.map(sheet => [sheet.name, sheet.visibility, sheet.kind]), [["Hidden", "hidden", "worksheet"], ["Macro表", "very-hidden", "unsupported"], ["Visiblé", "visible", "worksheet"], ["Chart", "hidden", "unsupported"], ["Empty", "visible", "worksheet"]])
	const db = new Database(ctx.outputPath, { readonly: true }); t.after(() => db.close())
	assert.equal(JSON.parse(db.prepare("SELECT cells FROM rows WHERE sheet='sheet-0' AND row=0").get().cells)[0].raw, "marker:Hidden")
})

function alteredBiffParserRunner(alter) {
	const script = `
		const XLSX = require("xlsx"), read = XLSX.read
		XLSX.read = (...args) => { const workbook = read(...args); if (workbook.SheetNames.includes("Macro表")) (${alter.toString()})(workbook); return workbook }
		require(${JSON.stringify(worker)})
	`
	return { synthetic: true, spawn: () => spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"], env: { GC_WORKBOOK_SYNTHETIC: "1" } }) }
}

test("BIFF F2: folded, reordered, renamed or duplicate SheetJS tabs cannot publish an inventory", async t => {
	for (const alter of [
		workbook => { workbook.SheetNames.splice(1, 1) },
		workbook => { workbook.SheetNames.reverse() },
		workbook => { workbook.SheetNames[0] = "Different" },
		workbook => { workbook.SheetNames[2] = workbook.SheetNames[0] },
	]) {
		const ctx = await setup(t, makeWorkbookFixture("xls", { biffTabs: mixedBiffTabs }), { testRunner: alteredBiffParserRunner(alter) })
		await assert.rejects(ctx.reader.parse(ctx), e => e.error === "workbook_malformed")
		await assert.rejects(fs.stat(ctx.outputPath), { code: "ENOENT" })
	}
})

test("BIFF F2: duplicate source names, aliased offsets and macro/BOF disagreement are rejected", async t => {
	const bytes = makeWorkbookFixture("xls", { biffTabs: mixedBiffTabs })
	for (const mutate of [
		(stream, tabs) => { stream.writeUInt32LE(tabs[0].offset, tabs[1].position + 4) },
		(stream, tabs) => { stream.writeUInt16LE(0x10, tabs[1].offset + 6) },
		(stream, tabs) => { const name = "Macro表"; stream.writeUInt8(name.length, tabs[2].position + 10); stream.write(name, tabs[2].position + 12, "utf16le") },
	]) {
		const ctx = await setup(t, patchBiffFixture(bytes, mutate))
		await assert.rejects(ctx.reader.parse(ctx), e => e.error === "workbook_malformed")
		await assert.rejects(fs.stat(ctx.outputPath), { code: "ENOENT" })
	}
})

test("XLSX preserves numeric spelling and a missing formula cache rather than a fabricated zero", async t => {
	const ctx = await setup(t, makeWorkbookFixture("xlsx", { unsupported: true })), manifest = await ctx.reader.parse(ctx)
	const db = new Database(ctx.outputPath, { readonly: true }); t.after(() => db.close())
	const cells = JSON.parse(db.prepare("SELECT cells FROM rows WHERE sheet='sheet-0' AND row=1").get().cells)
	assert.equal(cells[2].raw, "12345678901234567890.00100")
	assert.deepEqual([cells[4].formula, cells[4].cache, cells[4].raw, cells[4].display], ["99+1", "missing", null, ""])
	assert.equal(manifest.sheets[3].kind, "unsupported"); assert.equal(manifest.sheets[3].name, "Chart")
	assert.equal(manifest.sheets[3].indexedRows, 0); assert.equal(manifest.sheets[3].storedRange, null)
})

test("complete maximum-length Excel text survives the SQLite index", async t => {
	const text = "z".repeat(32767), ctx = await setup(t, makeWorkbookFixture("xlsx", { text })); await ctx.reader.parse(ctx)
	const db = new Database(ctx.outputPath, { readonly: true }); t.after(() => db.close())
	const cell = JSON.parse(db.prepare("SELECT cells FROM rows WHERE sheet='sheet-0' AND row=4").get().cells)[0]
	assert.equal(cell.raw, text); assert.equal(cell.display, text)
})

test("retained handle survives live pathname replacement and rejects wrong retained hash", async t => {
	const bytes = makeWorkbookFixture(), ctx = await setup(t, bytes); await fs.rename(ctx.input, `${ctx.input}.old`); await fs.writeFile(ctx.input, "unrelated live bytes")
	assert.equal((await ctx.reader.parse(ctx)).inputSha256, ctx.source.digest.sha256)
	const wrong = await setup(t, bytes); wrong.source.digest.sha256 = "0".repeat(64)
	await assert.rejects(wrong.reader.parse(wrong), e => e.error === "source_integrity")
})

test("rejects encrypted BIFF, broken sector bounds, non-workbooks and actual ZIP expansion overruns", async t => {
	const malformed = makeWorkbookFixture("xls"); malformed.writeUInt32LE(0x7fffffff, 44)
	const members = workbookMembers(makeWorkbookFixture()); members["padding.xml"] = "x".repeat(100000)
	for (const [bytes, limits, kind] of [[makeWorkbookFixture("xls", { encrypted: true }), {}, "workbook_encrypted"], [malformed, {}, "workbook_malformed"], [Buffer.from("hello"), {}, "workbook_unsupported"], [zipFixture(members), { expandedBytes: 32000 }, "workbook_budget"], [zipFixture(members, { declaredDelta: -1 }), {}, "workbook_malformed"]]) {
		const ctx = await setup(t, bytes, { limits }); await assert.rejects(ctx.reader.parse(ctx), e => e.error === kind)
	}
})

test("input and index limits fail explicitly without leaving a published SQLite result", async t => {
	for (const limits of [{ inputBytes: 10 }, { outputBytes: 4096 }]) {
		const ctx = await setup(t, makeWorkbookFixture(), { limits }); await assert.rejects(ctx.reader.parse(ctx), e => e.error === "workbook_budget")
		await assert.rejects(fs.stat(ctx.outputPath), { code: "ENOENT" })
	}
})

test("availability never advertises confinement for synthetic decoding", async t => {
	const ctx = await setup(t, makeWorkbookFixture(), { testRunner: syntheticRunner }); assert.equal(ctx.reader.availability.confinement, "synthetic-test-only")
	const reader = new WorkbookReader({ launcherPath: "/missing/workbook-launcher" }); await reader.init(); assert.equal(reader.availability.state, "unavailable")
})

test("cancellation waits for both monitor and decoding process death before releasing the lane", async t => {
	const members = workbookMembers(makeWorkbookFixture()); members["padding.xml"] = "x".repeat(5 * 1048576)
	const ctx = await setup(t, zipFixture(members))
	for (let attempt = 0; attempt < 5; attempt++) {
		const controller = new AbortController(), outputPath = `${ctx.outputPath}.${attempt}`, work = ctx.reader.parse({ ...ctx, outputPath, signal: controller.signal })
		let child
		for (let tries = 0; tries < 1000; tries++) { child = [...ctx.reader.children][0]; if (child?.workerPid) break; await new Promise(resolve => setTimeout(resolve, 1)) }
		assert.ok(child?.workerPid, "The real decoding worker must handshake before cancellation")
		await new Promise(resolve => setTimeout(resolve, attempt)); controller.abort()
		await assert.rejects(work, e => e.error === "job_cancelled")
		for (const pid of [child.pid, child.workerPid]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
		assert.equal(ctx.reader.active, false); await assert.rejects(fs.stat(outputPath), { code: "ENOENT" })
	}
})

test("one workbook lane rejects simultaneous admission while accepting useful configured budgets", async t => {
	const ctx = await setup(t, makeWorkbookFixture(), { limits: { inputBytes: 64 * 1048576, expandedBytes: 384 * 1048576, outputBytes: 384 * 1048576 } })
	const first = ctx.reader.parse(ctx), second = ctx.reader.parse({ ...ctx, outputPath: `${ctx.outputPath}.other` })
	await assert.rejects(second, e => e.error === "capacity"); await first
	assert.equal(ctx.reader.limits.inputBytes, 64 * 1048576)
	assert.throws(() => new WorkbookReader({ limits: { inputBytes: 129 * 1048576 } }), e => e.error === "invalid_budget")
})

test("small operational limits remain strict without making the fixed qualification probe unavailable", async t => {
	const ctx = await setup(t, makeWorkbookFixture(), { limits: { cells: 1, zipEntries: 1, expandedBytes: 1, manifestBytes: 1, rowBytes: 1 } })
	assert.equal(ctx.reader.availability.state, "available", JSON.stringify(ctx.reader.availability))
	for (const name of ["cells", "zipEntries", "expandedBytes", "manifestBytes", "rowBytes"]) assert.equal(ctx.reader.limits[name], 1)
	await assert.rejects(ctx.reader.parse(ctx), e => e.error === "workbook_budget")
	await assert.rejects(fs.stat(ctx.outputPath), { code: "ENOENT" })
})

test("stored zero, stored empty-string and missing caches remain distinguishable; rich shared strings omit phonetics", async t => {
	const members = workbookMembers(makeWorkbookFixture())
	members["xl/worksheets/sheet1.xml"] = members["xl/worksheets/sheet1.xml"].toString().replace('</sheetData>', '<row r="9"><c r="A9"><f>0</f><v>0</v></c><c r="B9" t="str"><f>\"\"</f><v></v></c><c r="C9"><f>1</f></c><c r="D9" t="s"><v>0</v></c></row></sheetData>')
	members["xl/sharedStrings.xml"] = '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>001</t></r><rPh sb="0" eb="3"><t>pronunciation</t></rPh><r><t>23</t></r></si></sst>'
	members["[Content_Types].xml"] = members["[Content_Types].xml"].toString().replace('</Types>', '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>')
	members["xl/_rels/workbook.xml.rels"] = members["xl/_rels/workbook.xml.rels"].toString().replace('</Relationships>', '<Relationship Id="rId88" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>')
	const ctx = await setup(t, zipFixture(members)), manifest = await ctx.reader.parse(ctx)
	const db = new Database(ctx.outputPath, { readonly: true }); t.after(() => db.close())
	const cells = JSON.parse(db.prepare("SELECT cells FROM rows WHERE sheet='sheet-0' AND row=8").get().cells)
	assert.deepEqual([cells[0].raw, cells[0].cache], ["0", "present"])
	assert.deepEqual([cells[1].raw, cells[1].cache], ["", "present"])
	assert.deepEqual([cells[2].raw, cells[2].cache], [null, "missing"])
	assert.deepEqual([cells[3].raw, cells[3].display], ["00123", "00123"])
	assert.equal(manifest.sheets[0].rows, 9)
})

test("both workbook formats honor the 1904 date epoch without changing the source serial", async t => {
	for (const format of ["xls", "xlsx"]) {
		const ctx = await setup(t, makeWorkbookFixture(format, { date1904: true })), manifest = await ctx.reader.parse(ctx)
		const db = new Database(ctx.outputPath, { readonly: true }); t.after(() => db.close())
		const cell = JSON.parse(db.prepare("SELECT cells FROM rows WHERE sheet='sheet-0' AND row=1").get().cells)[3]
		assert.equal(manifest.dateSystem, "1904"); assert.equal(String(cell.raw), "45292"); assert.equal(cell.display, "2028-01-02")
	}
})

test("unsafe XML, unknown styles and invalid shared-string references are rejected explicitly", async t => {
	for (const replacement of [
		text => text.replace('<worksheet ', '<!DOCTYPE worksheet [<!ENTITY secret "private">]><worksheet '),
		text => text.replace('<c r="A2"', '<c s="999999" r="A2"'),
		text => text.replace(/<c r="A2"[^>]*>[\s\S]*?<\/c>/, '<c r="A2" t="s"><v>999999</v></c>'),
	]) {
		const members = workbookMembers(makeWorkbookFixture()); members["xl/worksheets/sheet1.xml"] = replacement(members["xl/worksheets/sheet1.xml"].toString())
		const ctx = await setup(t, zipFixture(members)); await assert.rejects(ctx.reader.parse(ctx), e => ["workbook_unsupported", "workbook_malformed"].includes(e.error))
	}
})

test("elapsed deadline returns a resource failure only after the native child has terminated", async t => {
	const ctx = await setup(t, makeWorkbookFixture()); ctx.reader.limits.elapsedMs = 5
	const work = ctx.reader.parse(ctx); let child
	for (let tries = 0; tries < 100; tries++) { child = [...ctx.reader.children][0]; if (child) break; await new Promise(resolve => setTimeout(resolve, 1)) }
	assert.ok(child)
	await assert.rejects(work, e => e.error === "workbook_time_budget")
	assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" }); assert.equal(ctx.reader.active, false)
	await assert.rejects(fs.stat(ctx.outputPath), { code: "ENOENT" })
})

function sourceSheetFixture(storedRange, sheetData = "") {
	const members = workbookMembers(makeWorkbookFixture())
	const dimension = storedRange === null ? "" : `<dimension ref="${storedRange}"/>`
	members["xl/worksheets/sheet1.xml"] = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${dimension}<sheetData>${sheetData}</sheetData></worksheet>`
	return zipFixture(members)
}

test("declared empty XLSX sheet keeps 1x1 extents while indexedRows proves no source rows exist", async t => {
	const ctx = await setup(t, sourceSheetFixture("A1")), manifest = await ctx.reader.parse(ctx), sheet = manifest.sheets[0]
	assert.deepEqual([sheet.rows, sheet.columns], [1, 1])
	const db = new Database(ctx.outputPath, { readonly: true }); t.after(() => db.close())
	assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rows WHERE sheet='sheet-0'").get().count, 0)
	assert.equal(sheet.indexedRows, 0); assert.equal(sheet.populatedCells, 0); assert.equal(sheet.storedRange, "A1")
})

test("uncached-formula-only XLSX sheet has one indexed row and one populated formula cell", async t => {
	const ctx = await setup(t, sourceSheetFixture("A1", '<row r="1"><c r="A1"><f>99+1</f></c></row>'))
	const manifest = await ctx.reader.parse(ctx), sheet = manifest.sheets[0]
	const db = new Database(ctx.outputPath, { readonly: true }); t.after(() => db.close())
	const record = db.prepare("SELECT row,cells FROM rows WHERE sheet='sheet-0'").all()
	assert.equal(record.length, 1); assert.equal(record[0].row, 0)
	const cell = JSON.parse(record[0].cells)[0]
	assert.deepEqual([cell.formula, cell.raw, cell.cache], ["99+1", null, "missing"])
	assert.equal(manifest.decodedCells, 1 + manifest.sheets[1].populatedCells)
	assert.equal(sheet.indexedRows, 1); assert.equal(sheet.populatedCells, 1); assert.equal(sheet.storedRange, "A1")
})

test("storedRange retains the original XLSX dimension start and end independently of indexed cells", async t => {
	const ctx = await setup(t, sourceSheetFixture("C5:F9", '<row r="3"><c r="A3"><v>7</v></c></row>'))
	const manifest = await ctx.reader.parse(ctx), sheet = manifest.sheets[0]
	assert.deepEqual([sheet.rows, sheet.columns], [9, 6]); assert.equal(sheet.storedRange, "C5:F9")
	assert.equal(sheet.indexedRows, 1); assert.equal(sheet.populatedCells, 1)
	const db = new Database(ctx.outputPath, { readonly: true }); t.after(() => db.close())
	assert.deepEqual(db.prepare("SELECT row FROM rows WHERE sheet='sheet-0'").all(), [{ row: 2 }])
})

test("missing XLSX dimension stays null even when the reader can derive coordinate upper bounds", async t => {
	const ctx = await setup(t, sourceSheetFixture(null, '<row r="5"><c r="C5"><v>7</v></c></row>'))
	const manifest = await ctx.reader.parse(ctx), sheet = manifest.sheets[0]
	assert.deepEqual([sheet.rows, sheet.columns], [5, 3]); assert.equal(sheet.indexedRows, 1)
	assert.equal(sheet.storedRange, null)
})

test("storedRange ignores extension elements that are not the worksheet's own dimension", async t => {
	const members = workbookMembers(sourceSheetFixture("A1"))
	members["xl/worksheets/sheet1.xml"] = members["xl/worksheets/sheet1.xml"].toString().replace('</worksheet>', '<extLst><ext uri="fixture"><extra:dimension xmlns:extra="urn:fixture" ref="C5:F9"/></ext></extLst></worksheet>')
	const ctx = await setup(t, zipFixture(members)), manifest = await ctx.reader.parse(ctx), sheet = manifest.sheets[0]
	assert.deepEqual([sheet.rows, sheet.columns, sheet.storedRange, sheet.indexedRows], [1, 1, "A1", 0])
})

test("XLS storedRange is unavailable rather than inferred from SheetJS coordinate bounds", async t => {
	const ctx = await setup(t, makeWorkbookFixture("xls")), manifest = await ctx.reader.parse(ctx)
	assert.deepEqual(manifest.sheets.map(sheet => sheet.storedRange), [null, null, null])
	assert.deepEqual([manifest.sheets[0].rows, manifest.sheets[0].columns], [5, 6])
	assert.match(manifest.sheets[0].warnings.join(" "), /stored XLS range is unavailable/i)
})

function alteredManifestRunner(alter) {
	// The synthetic adapter forwards real decoding and changes only terminal evidence.
	const script = `
		const { spawn } = require("node:child_process")
		const { createInterface } = require("node:readline")
		const child = spawn(process.execPath, [${JSON.stringify(worker)}], { stdio: [0, "pipe", 2], env: { GC_WORKBOOK_SYNTHETIC: "1" } })
		createInterface({ input: child.stdout }).on("line", line => {
			const message = JSON.parse(line)
			if (message.manifest) (${alter.toString()})(message.manifest)
			process.stdout.write(JSON.stringify(message) + "\\n")
		})
		child.on("error", () => { process.exitCode = 1 })
		child.on("close", code => { process.exitCode = code || 0 })
	`
	return { synthetic: true, spawn: () => spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"], env: {} }) }
}

test("parent rejects indexed-row, populated-formula or stored-range evidence that does not validate", async t => {
	for (const alter of [
		manifest => { manifest.sheets[0].indexedRows = 0 },
		manifest => { manifest.sheets[0].populatedCells = 0 },
		manifest => { manifest.sheets[0].storedRange = "XFE1" },
		manifest => { manifest.sheets[0].storedRange = "F9:C5" },
		manifest => { manifest.sheets = manifest.sheets.slice(0, 1) },
	]) {
		const ctx = await setup(t, sourceSheetFixture("A1", '<row r="1"><c r="A1"><f>99+1</f></c></row>'), { testRunner: alteredManifestRunner(alter) })
		await assert.rejects(ctx.reader.parse(ctx), e => e.error === "worker_unavailable")
		await assert.rejects(fs.stat(ctx.outputPath), { code: "ENOENT" })
	}
})
