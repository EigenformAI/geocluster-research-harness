import { recipeColumns } from "./voxel/voxel-compute.js"
import { fail } from "./voxel-request.js"
const cell = (raw) => ({ raw, display: raw, type: "s", formula: null, cache: "not-formula", format: null })
/** Account retained objects before allocation: 256 base, 128 row/header container,
 * 192 rich cell, 96 raw header, 128 output header, 16 column mapping, and
 * 64 + 4 * UTF-16 units/string. This is an allocation budget, not total RSS. */
export function inputBudget(limits) {
	const ceiling = limits.tableRetentionBytes ?? 128 * 1048576; let used = 0
	const charge = (amount) => { if (amount > ceiling - used) throw fail(413, "table_memory_limit", `Retained table inputs exceed ${ceiling} accounted bytes. Select fewer rows or mapped columns, or raise tableRetentionBytes.`); used += amount }
	charge(256); return { charge, string: (length) => charge(64 + 4 * length) }
}
function projection(data, scope, budget) {
	const describe = data.action === "describe", full = data.fullRange && !data.workbook
	const indexed = data.action === "scan-indices" || data.recipe?.algorithm === "geocluster-indexed-v1"
	const indices = data.indices || data.recipe?.indices
	const mapped = describe ? [] : indexed ? [...new Set([indices.x, indices.y, indices.z, ...(data.recipe?.algorithm === "geocluster-indexed-v1" ? [data.recipe.field.column] : [])])] : recipeColumns(data.recipe)
	const columns = full ? null : describe ? Array.from({ length: scope.range.columnEnd - scope.range.columnStart + 1 }, (_, i) => scope.range.columnStart + i) : mapped.filter((c) => c >= scope.range.columnStart && c <= scope.range.columnEnd).sort((a, b) => a - b)
	if (columns) budget.charge(columns.length * 16)
	return { describe, full, columns, positions: columns && new Map(columns.map((c, i) => [c, i])), headers: new Set(scope.headerRows), range: scope.range }
}
function headersFor(columns, scope, fields, budget) {
	return columns.map((column) => { budget.charge(128); const parts = scope.headerRows.map((r) => fields.get(r)?.get(column)).filter(Boolean), length = parts.length ? parts.reduce((n, s) => n + s.length, 0) + (parts.length - 1) * 3 : `Column ${column + 1}`.length; budget.string(length); return { column, label: parts.join(" / ") || `Column ${column + 1}` } })
}
/** Scan every field and logical row, even discarded fields; only retain projection.
 * Offsets avoid allocating discarded strings. Complete hashing precedes parsing. */
function delimited(buffer, delimiter, scope, plan, limits, budget) {
	let text
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer) } catch { throw fail(415, "encoding_unavailable", "CSV and TSV sources must be complete UTF-8 files. Save and capture UTF-8 bytes.") }
	const rows = [], headerFields = new Map()
	let rowIndex = 0, columnIndex = 0, width = 0, count = 0, record = null, header = false, selected = false, keep = false
	let fieldStart = 0, fieldEnd = null, quoted = false, closed = false, hasText = false, escaped = false, started = false
	const begin = () => { header = plan.headers.has(rowIndex); selected = !header && (plan.full || rowIndex >= plan.range.rowStart && rowIndex <= plan.range.rowEnd); keep = selected && (!plan.describe || count < 8); if (header || keep) { budget.charge(128); record = header ? new Map() : [] } else record = null }
	const column = (end) => {
		if (columnIndex >= limits.columns) throw fail(413, "column_limit", `The table exceeds ${limits.columns} columns. Select a narrower source.`)
		const position = plan.full ? columnIndex : plan.positions.get(columnIndex)
		if (record && position !== undefined) { budget.charge(header ? 96 : 192); budget.string((fieldEnd ?? end) - fieldStart); const raw = escaped ? text.slice(fieldStart, fieldEnd ?? end).replace(/""/g, '"') : text.slice(fieldStart, fieldEnd ?? end); if (header) record.set(columnIndex, raw); else record[position] = cell(raw) }
		columnIndex++; fieldStart = end + 1; fieldEnd = null; closed = false; hasText = false; escaped = false
	}
	const row = (end, next) => {
		column(end); width = Math.max(width, columnIndex)
		if (header) headerFields.set(rowIndex, record)
		if (selected) { count++; if (count > limits.rows) throw fail(413, "row_limit", `The selected table exceeds ${limits.rows} data rows.`); if (keep) rows.push({ row: rowIndex, cells: record }) }
		rowIndex++; if (rowIndex > limits.rows + 32) throw fail(413, "row_limit", `The complete table exceeds ${limits.rows} data rows. Split the source.`)
		columnIndex = 0; started = false; fieldStart = next; if (next < text.length) begin()
	}
	if (text.length) begin()
	for (let at = 0; at < text.length; at++) {
		const c = text[at]; started = true
		if (quoted) { if (c === '"') { if (text[at + 1] === '"') { escaped = true; hasText = true; at++ } else { quoted = false; closed = true; fieldEnd = at } } else hasText = true; continue }
		if (c === delimiter) { column(at); continue }
		if (c === "\r" || c === "\n") { const end = at; if (c === "\r" && text[at + 1] === "\n") at++; row(end, at + 1); continue }
		if (c === '"' && !hasText && !closed) { quoted = true; fieldStart = at + 1; continue }
		if (c === '"' || closed) throw fail(422, "invalid_table", `Invalid quoting in source row ${rowIndex + 1}. Save a correctly quoted table and capture it again.`)
		hasText = true
	}
	if (quoted) throw fail(422, "invalid_table", "The table ends inside a quoted field. Save and capture a complete table.")
	if (started || columnIndex || hasText || closed) row(text.length, text.length)
	if (!width || !rowIndex) throw fail(422, "empty_source", "This source has no table rows.")
	const range = plan.full ? { rowStart: 0, rowEnd: rowIndex - 1, columnStart: 0, columnEnd: width - 1 } : scope.range
	if (range.rowEnd >= rowIndex || range.columnEnd >= width || scope.headerRows.some((r) => r >= rowIndex)) throw fail(400, "invalid_range", "Selected rows, columns or headers extend beyond the complete captured table.")
	if (plan.full) budget.charge(width * 16)
	const columns = plan.columns || Array.from({ length: width }, (_, i) => i)
	for (const row of rows) for (let i = 0; i < columns.length; i++) if (!row.cells[i]) { budget.charge(192); row.cells[i] = cell(null) }
	return { rows, rowCount: count, columns, headers: headersFor(columns, scope, headerFields, budget), scope: { ...scope, range }, parsers: ["complete-delimited-v1"], warnings: [] }
}
function workbook(data, scope, plan, limits, budget) {
	const rows = [], columns = plan.columns, text = data.workbook.typedJsonl; let count = 0
	for (let at = 0; at < text.length;) {
		let end = text.indexOf("\n", at); if (end < 0) end = text.length
		const line = text.slice(at, end); at = end + 1; if (!line.trim()) continue
		if (++count > limits.rows) throw fail(413, "row_limit", `The workbook exceeds ${limits.rows} selected data rows.`)
		const source = JSON.parse(line); if (plan.describe && count > 8) continue
		budget.charge(128); const cells = []
		for (const column of columns) { budget.charge(192); const value = source.cells[column - scope.range.columnStart]; if (value) for (const item of Object.values(value)) if (typeof item === "string") budget.string(item.length); cells.push(value || cell(null)) }
		rows.push({ row: source.row, cells })
	}
	const byColumn = new Map(data.workbook.headers.map((h) => [h.column, h.label])), headers = columns.map((column) => { budget.charge(128); const label = byColumn.get(column) || `Column ${column + 1}`; budget.string(label.length); return { column, label } })
	return { rows, rowCount: count, columns, headers, scope, parsers: [data.workbook.parser], warnings: data.workbook.warnings }
}
export function projectedInput(data, scope, limits, readBytes) {
	if ((!data.fullRange || data.workbook) && scope.range.columnEnd - scope.range.columnStart + 1 > limits.columns) throw fail(413, "column_limit", `The selected range exceeds ${limits.columns} columns.`)
	const budget = inputBudget(limits), plan = projection(data, scope, budget)
	return data.workbook ? workbook(data, scope, plan, limits, budget) : delimited(readBytes(data.binding, limits.sourceBytes), data.input.delimiter, scope, plan, limits, budget)
}
