/** Trusted, disposable query process. Workbook decoding runs in the separate confined reader. */
import Database from "better-sqlite3"

const empty = { type: "blank", raw: null, display: "", format: null, formula: null, cache: "not-formula" }
const fail = (error, message, status = 400) => { throw Object.assign(new Error(message), { error, status }) }
const columnName = (index) => { let name = ""; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name }
const formulaText = (cell) => cell.formula === null ? null : cell.formula.startsWith("=") ? cell.formula : `=${cell.formula}`
const text = (cell, mode) => mode === "formula" && cell.formula !== null ? formulaText(cell) : cell.cache === "missing" ? "" : cell.display

// Same numeric interpretation as the supplied-data table controls. Explicit sorting
// permits leading-zero identifiers; automatic detection keeps them textual.
function number(cell, detection = false) {
	if (["b", "e", "d", "boolean", "error", "date"].includes(cell.type) || cell.cache === "missing") return null
	if (detection && /^[+-]?0\d+$/.test(cell.display.trim())) return null
	if (cell.format) {
		const tokens = cell.format.replace(/"[^"]*"|\\.|_.|\*./g, "").replace(/\[([^\]]*)\]/g, (_, token) => /^[hms]+$/i.test(token) ? token : "").replace(/general/gi, "").replace(/([0#?.,])[eE][+-]?0+/g, "$1")
		if (/[ymdhseg]|b[12]|上午\/下午/i.test(tokens)) return null
	}
	let value = cell.raw
	if (typeof value === "string") {
		const token = value.trim()
		if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(token) || detection && /^[+-]?0\d+$/.test(token)) return null
		value = Number(token)
	}
	if (typeof value !== "number" || !Number.isFinite(value) || detection && Number.isInteger(value) && !Number.isSafeInteger(value)) return null
	return value
}
function cellValid(cell) {
	return cell && typeof cell === "object" && typeof cell.type === "string" && (cell.raw === null || ["string", "boolean"].includes(typeof cell.raw) || typeof cell.raw === "number" && Number.isFinite(cell.raw)) && typeof cell.display === "string" && (cell.format === null || typeof cell.format === "string") && (cell.formula === null || typeof cell.formula === "string") && ["present", "missing", "unknown", "not-formula"].includes(cell.cache)
}
function validate(db, manifest) {
	const columns = db.pragma("table_info(rows)")
	if (columns.length !== 3 || columns[0].name !== "sheet" || columns[0].pk !== 1 || columns[1].name !== "row" || columns[1].pk !== 2 || columns[2].name !== "cells") fail("invalid_workbook_index", "The reader did not produce the sparse rows schema.", 422)
	const sheets = new Map(manifest.sheets.map((sheet) => [sheet.id, sheet]))
	const rowCounts = new Map(manifest.sheets.map((sheet) => [sheet.id, 0]))
	for (const row of db.prepare("SELECT sheet,row,cells FROM rows").iterate()) {
		const sheet = sheets.get(row.sheet), cells = JSON.parse(row.cells)
		if (!sheet || sheet.kind !== "worksheet" || !Number.isSafeInteger(row.row) || row.row < 0 || row.row >= sheet.rows || !cells || Array.isArray(cells) || typeof cells !== "object") fail("invalid_workbook_index", "Sparse row coordinates do not bind the workbook inventory.", 422)
		for (const [column, cell] of Object.entries(cells)) if (!/^(0|[1-9]\d*)$/.test(column) || Number(column) >= sheet.columns || !cellValid(cell)) fail("invalid_workbook_index", "Sparse cells have invalid coordinates or typed values.", 422)
		rowCounts.set(sheet.id, rowCounts.get(sheet.id) + 1)
	}
	for (const sheet of manifest.sheets) if (rowCounts.get(sheet.id) !== sheet.indexedRows) fail("invalid_workbook_index", `Sparse row count does not match indexedRows for ${sheet.id}.`, 422)
	return { valid: true }
}
function execute(db, input) {
	const { manifest, query: q, action, request = {} } = input
	if (action === "validate") return validate(db, manifest)
	const sheet = manifest.sheets.find((s) => s.id === q.sheet)
	const range = q.range || { rowStart: 0, rowEnd: sheet.rows - 1, columnStart: 0, columnEnd: sheet.columns - 1 }
	const headers = new Set(q.headerRows), width = Math.max(0, range.columnEnd - range.columnStart + 1)
	const get = db.prepare("SELECT cells FROM rows WHERE sheet=? AND row=?"), read = (row) => { const record = get.get(sheet.id, row); return record ? JSON.parse(record.cells) : {} }
	const selected = action === "export" && request.selectedRows !== null
	const numeric = new Array(width).fill(null), matching = [], filter = q.filter.toLowerCase()
	const scan = selected ? null : db.prepare("SELECT row,cells FROM rows WHERE sheet=? AND row>=? AND row<=? ORDER BY row").iterate(sheet.id, range.rowStart, range.rowEnd)
	for (const record of scan || []) {
		const row = record.row, cells = JSON.parse(record.cells)
		if (headers.has(row)) continue
		let match = !filter
		for (const [column, cell] of Object.entries(cells)) {
			const index = Number(column)
			if (index < range.columnStart || index > range.columnEnd) continue
			if (text(cell, q.mode).toLowerCase().includes(filter)) match = true
			if (cell.raw !== null && cell.raw !== "" || cell.cache === "missing") {
				const position = index - range.columnStart
				if (number(cell, true) === null) numeric[position] = false
				else if (numeric[position] !== false) numeric[position] = true
			}
		}
		if (match && !selected) {
			const cell = q.sort ? cells[q.sort.column] || empty : empty
			matching.push({ row, key: q.sort?.mode === "number" ? number(cell) : q.sort ? text(cell, q.mode).toLowerCase() : null })
		}
	}
	scan?.return()
	if (q.sort && !selected) matching.sort((a, b) => {
		if (a.key === null || b.key === null) return a.key === b.key ? a.row - b.row : a.key === null ? 1 : -1
		const order = a.key < b.key ? -1 : a.key > b.key ? 1 : 0
		return (q.sort.direction === "desc" ? -order : order) || a.row - b.row
	})
	const decorate = (cells, row, columns) => columns.map((column) => ({ ...(cells[column] || empty), address: `${columnName(column)}${row + 1}`, column }))
	const header = (column) => q.headerRows.map((row) => text(read(row)[column] || empty, q.mode)).filter(Boolean).join(" / ") || null
	if (action === "query") {
		const columns = []
		for (let column = range.columnStart + q.columnOffset; column <= Math.min(range.columnEnd, range.columnStart + q.columnOffset + q.columnLimit - 1); column++) columns.push({ index: column, label: columnName(column), header: header(column), numeric: numeric[column - range.columnStart] === true })
		return { representationId: manifest.id, sheet, query: q, matchingRows: matching.length, scope: q.range ? "selected-range" : "full-sheet", columns, rows: matching.slice(q.rowOffset, q.rowOffset + q.rowLimit).map(({ row }) => ({ row, cells: decorate(read(row), row, columns.map((c) => c.index)) })) }
	}
	const sourceRows = selected ? [...new Set(request.selectedRows)].filter((row) => row >= range.rowStart && row <= range.rowEnd && !headers.has(row) && get.get(sheet.id, row)).sort((a, b) => a - b) : matching.map((r) => r.row)
	const sourceColumns = Array.from({ length: width }, (_, n) => range.columnStart + n)
	const transformations = { escapedTextCells: 0, missingFormulaCaches: 0, unknownFormulaCaches: 0 }
	let output = "", bytes = 0
	const append = (line) => { bytes += Buffer.byteLength(line); if (bytes > input.outputBytes) fail("workbook_export_limit", "The export exceeds its byte budget. Select fewer rows or a smaller range.", 413); output += line }
	const csvValue = (value, textual = true) => {
		let s = value === null ? "" : String(value)
		if (request.formulaHandling === "escaped-text" && textual && /^(?:[\t\r\n]|\s*[=+\-@])/.test(s)) { s = `'${s}`; transformations.escapedTextCells++ }
		return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
	}
	if (request.format === "csv" && q.headerRows.length && width) append(sourceColumns.map((column) => csvValue(header(column))).join(",") + "\r\n")
	for (const row of sourceRows) {
		const cells = decorate(read(row), row, sourceColumns)
		for (const cell of cells) { if (cell.cache === "missing") transformations.missingFormulaCaches++; if (cell.cache === "unknown") transformations.unknownFormulaCaches++ }
		if (request.format === "typed-jsonl") append(JSON.stringify({ row, cells }) + "\n")
		else append(cells.map((cell) => {
			const formula = q.mode === "formula" && cell.formula !== null
			return csvValue(formula ? formulaText(cell) : cell.cache === "missing" ? null : cell.raw, formula || !["n", "number"].includes(cell.type))
		}).join(",") + "\r\n")
	}
	const metadata = { schemaVersion: 1, inputSha256: manifest.inputSha256, captureId: manifest.source.captureId, representationId: manifest.id, source: manifest.source, parser: manifest.parser, sheet: sheet.id, query: q, range: q.range, headerRows: q.headerRows, mode: q.mode, selectedRows: request.selectedRows, sourceRows, sourceColumns, scope: q.range ? "selected-range" : "full-sheet", selection: selected ? "selected-source-rows" : "all-matching-rows", filterApplied: !selected, sortApplied: !selected && q.sort !== null, formulaHandling: request.formulaHandling, format: request.format, transformations }
	return { representationId: manifest.id, [request.format === "typed-jsonl" ? "typedJsonl" : "csv"]: output, metadata }
}

try {
	let body = ""
	for await (const chunk of process.stdin) { body += chunk; if (Buffer.byteLength(body) > 2 * 1024 * 1024) fail("request_limit", "Query worker metadata exceeds its input ceiling.", 413) }
	const input = JSON.parse(body), db = new Database("/proc/self/fd/3", { readonly: true, fileMustExist: true })
	db.pragma("query_only = ON"); db.pragma("cache_size = -8192"); db.pragma("temp_store = FILE")
	let result
	try { result = execute(db, input) } finally { db.close() }
	const output = JSON.stringify({ result })
	if (Buffer.byteLength(JSON.stringify({ ...result, filesContractVersion: 1 })) > input.outputBytes) fail(input.action === "export" ? "workbook_export_limit" : "workbook_page_limit", "The response exceeds its byte ceiling. Request a smaller range or page.", 413)
	process.stdout.write(output)
} catch (error) {
	process.stdout.write(JSON.stringify({ error: { status: error.status || 422, error: error.error || "invalid_workbook_index", message: error.message } }))
	process.exitCode = 1
}
