import { numberReader, compareCodePoints } from "./voxel-compute.js"
import { flatIndex, cellCount } from "./voxel-grid.js"
import { MAX_CATEGORIES, validCategoryLabel } from "./voxel-constraints.js"

export const INDEXED_ALGORITHM = "geocluster-indexed-v1"
export const INDEXED_SUMMARY_FIELDS = ["inputRows", "suppliedUniqueCells", "absentRecordCells", "emptySuppliedValueCells", "validCells", "duplicateCellGroups"]
const ISSUE_LIMIT = 25, CATEGORY_PREVIEW_LIMIT = 32

export function indexedGrid(recipe) {
	return { shape: [...recipe.shape], ...recipe.placement, axes: recipe.placement.unit === "grid-unit" ? "x,y,z" : "easting,northing,elevation", order: "C-z-fastest" }
}
function diagnostics(input) {
	return { scanComplete: false, blockingErrors: [], issues: [], warnings: [...input.warnings] }
}
function report(result, kind, rows, message, fieldId) {
	if (!result.blockingErrors.includes(message)) result.blockingErrors.push(message)
	if (result.issues.length < ISSUE_LIMIT) result.issues.push({ kind, ...(fieldId ? { fieldId } : {}), rows, message })
}
function columns(input, indices, result, field) {
	const positions = new Map(input.columns.map((c, n) => [c, n]))
	for (const c of [indices.x, indices.y, indices.z, ...(field ? [field.column] : [])]) {
		if (!positions.has(c)) report(result, "column-outside-scope", [], `Column ${c + 1} is outside the selected range.`)
	}
	return positions
}
function indexReader(numbers, indices, positions) {
	// Index syntax follows the number format, but value missing/sentinel/censor
	// policies must never replace or suppress an address (e.g. index "0").
	const read = numberReader({ ...numbers, missingTokens: [], sentinels: [], censored: "exclude" })
	return (row) => {
		const parsed = [indices.x, indices.y, indices.z].map((c) => read(row.cells[positions.get(c)], "coordinate"))
		return parsed.every((v) => v.ok && Number.isSafeInteger(v.value) && v.value >= indices.base) ? parsed.map((v) => v.value - indices.base) : null
	}
}
function readLabel(cell, recipe) {
	if (!cell || cell.raw === null || cell.cache === "missing") return { empty: true }
	const raw = typeof cell.raw === "boolean" ? cell.raw ? "TRUE" : "FALSE" : String(cell.raw)
	const label = recipe.field.trim ? raw.trim() : raw
	const tokens = recipe.field.trim ? recipe.numbers.missingTokens.map((s) => s.trim()) : recipe.numbers.missingTokens
	if (label === "" || tokens.includes(label)) return { empty: true }
	if (!validCategoryLabel(label) || label.includes("\0")) return { malformed: true }
	return { value: label }
}

/** Full sparse scan; dense arrays exist only after all diagnostics and ceilings pass. */
export function computeIndexed(input, recipe, { materialize = false, limits }) {
	const result = { ...diagnostics(input), grid: indexedGrid(recipe), estimate: null, field: null, summary: Object.fromEntries(INDEXED_SUMMARY_FIELDS.map((key) => [key, 0])), statistics: null, categoryPreview: null, arrays: null }
	const summary = result.summary; summary.inputRows = input.rows.length
	const numeric = recipe.field.kind === "numeric", cells = cellCount(recipe.shape), valueBytes = numeric ? 8 : 4
	const positions = columns(input, recipe.indices, result, recipe.field)
	result.estimate = { cells, arrayBytes: cells * (valueBytes + 1), computeBytes: cells * (valueBytes + 1) + input.rows.length * 96, displayBytes: 0 }
	if (cells > limits.cells) report(result, "cell-limit", [], `The declared grid exceeds the ${limits.cells} cell limit.`, "shape")
	// NPY header allowance is checked before any dense allocation; encoded size
	// receives an exact second check in the worker.
	if (cells * valueBytes + 128 > limits.memberBytes || cells + 128 > limits.memberBytes) report(result, "member-limit", [], `The declared arrays exceed the ${limits.memberBytes} member byte limit.`, "shape")
	if (input.rows.length > limits.rows) report(result, "row-limit", [], `The source exceeds the ${limits.rows} row limit.`)
	if (result.blockingErrors.length) return result
	const readIndex = indexReader(recipe.numbers, recipe.indices, positions), readNumber = numberReader(recipe.numbers)
	const records = new Map(), labels = new Set()
	let low = Infinity, high = -Infinity, censoredSubstitutions = 0, formulaCacheValues = 0
	for (const row of input.rows) {
		const index = readIndex(row), sourceRow = row.row + 1
		const valueCell = row.cells[positions.get(recipe.field.column)]
		const reading = numeric ? readNumber(valueCell, "value") : readLabel(valueCell, recipe)
		let value = null
		if (numeric) {
			if (reading.ok) value = reading.value
			else if (!["missing", "sentinel", "censored"].includes(reading.reason)) report(result, "malformed-value", [sourceRow], "Numeric values must be finite numbers under the declared source format.", "field.column")
		} else {
			if (reading.malformed) report(result, "malformed-label", [sourceRow], "Category labels must contain at most 1024 characters and no NUL.", "field.column")
			else if (!reading.empty) value = reading.value
		}
		if (!index) { report(result, "malformed-index", [sourceRow], "Indices must be finite safe integers at or above the declared base.", "indices"); continue }
		if (index.some((v, axis) => v >= recipe.shape[axis])) { report(result, "index-outside-shape", [sourceRow], "Indices must fall inside the declared shape.", "shape"); continue }
		const at = flatIndex(recipe.shape, ...index), previous = records.get(at)
		if (previous) {
			if (!previous.duplicate) { summary.duplicateCellGroups++; previous.duplicate = true }
			report(result, "duplicate-cell", [previous.row, sourceRow], "Duplicate cell records are forbidden, including empty or identical values.", "indices")
			continue
		}
		records.set(at, { row: sourceRow, value, duplicate: false })
		if (value === null) { summary.emptySuppliedValueCells++; continue }
		summary.validCells++
		if (numeric) { low = Math.min(low, value); high = Math.max(high, value); if (reading.substituted) censoredSubstitutions++ }
		else {
			labels.add(value)
			if (labels.size > Math.min(limits.categories, MAX_CATEGORIES)) { report(result, "category-limit", [sourceRow], `The dictionary exceeds the ${Math.min(limits.categories, MAX_CATEGORIES)} category limit.`, "field.column"); return result }
		}
		if (valueCell?.formula !== null && valueCell?.formula !== undefined) formulaCacheValues++
	}
	result.scanComplete = true
	summary.suppliedUniqueCells = records.size; summary.absentRecordCells = cells - records.size
	if (recipe.emptyCells === "forbid") {
		if (summary.absentRecordCells) report(result, "absent-records", [], "Absent cell records are forbidden by the empty-cell policy.", "emptyCells")
		if (summary.emptySuppliedValueCells) report(result, "empty-values", [], "Empty supplied values are forbidden by the empty-cell policy.", "emptyCells")
	}
	if (!summary.validCells) report(result, "no-valid-values", [], "The grid contains no valid values. Supply at least one valid cell.", "field.column")
	const categories = [...labels].sort(compareCodePoints).map((label, code) => ({ code, label }))
	result.field = numeric ? { kind: "numeric", name: recipe.field.name, unit: recipe.field.unit } : categories.length ? { kind: "categorical", name: recipe.field.name, unit: "", categories } : null
	result.categoryPreview = numeric ? null : { count: categories.length, labels: categories.slice(0, CATEGORY_PREVIEW_LIMIT).map((c) => c.label) }
	result.statistics = { ...summary, censoredSubstitutions, formulaCacheValues, valueRange: numeric && summary.validCells ? { min: low, max: high } : null }
	if (!materialize || result.blockingErrors.length) return result
	const values = numeric ? new Float64Array(cells) : new Uint32Array(cells), valid = new Uint8Array(cells), codes = new Map(categories.map((c) => [c.label, c.code]))
	for (const [at, record] of records) if (record.value !== null) { values[at] = numeric ? record.value : codes.get(record.value); valid[at] = 1 }
	result.arrays = { values, valid }
	return result
}

/** Suggestions use source-size-bounded sparse addresses, never a dense shape. */
export function scanIndices(input, indices, numbers, limits) {
	const result = { ...diagnostics(input), suggestedShape: null, summary: { inputRows: input.rows.length, suppliedUniqueCells: 0, duplicateCellGroups: 0 } }
	const positions = columns(input, indices, result)
	if (input.rows.length > limits.rows) report(result, "row-limit", [], `The source exceeds the ${limits.rows} row limit.`)
	if (result.blockingErrors.length) return result
	const read = indexReader(numbers, indices, positions), seen = new Map(), max = [-1, -1, -1]
	for (const row of input.rows) {
		const index = read(row), sourceRow = row.row + 1
		if (!index || index.some((v) => !Number.isSafeInteger(v + 1))) { report(result, "malformed-index", [sourceRow], "Indices must be safe integers with a representable positive dimension.", "indices"); continue }
		index.forEach((v, axis) => { max[axis] = Math.max(max[axis], v) })
		const key = index.join(","), previous = seen.get(key)
		if (previous) {
			if (!previous.duplicate) { previous.duplicate = true; result.summary.duplicateCellGroups++ }
			report(result, "duplicate-cell", [previous.row, sourceRow], "Duplicate cell records are forbidden.", "indices")
		} else seen.set(key, { row: sourceRow, duplicate: false })
	}
	result.scanComplete = true; result.summary.suppliedUniqueCells = seen.size
	if (seen.size) result.suggestedShape = max.map((v) => v + 1)
	else report(result, "no-indices", [], "No usable indices were found.", "indices")
	return result
}
