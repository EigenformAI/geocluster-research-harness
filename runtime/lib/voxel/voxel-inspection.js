import { cellBounds, cellIndex, flatIndex } from "./voxel-grid.js"
import { fail } from "../voxel-request.js"
import { inputBudget } from "../voxel-input.js"
import { validCategoryLabel } from "./voxel-constraints.js"

export const ARTIFACT_QUERY_LIMIT = 256
export const ARTIFACT_EDIT_LIMIT = 256
export const ARTIFACT_RESPONSE_BYTES = 1048576
export const NEUTRAL_NUMBER_POLICY = Object.freeze({ decimal: ".", thousands: "none", missingTokens: Object.freeze([]), sentinels: Object.freeze([]), censored: "exclude" })
function object(value, keys, name) {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k))) throw fail(400, "invalid_request", `${name} contains unrecognized fields or is not an object.`)
}
function limit(value, fallback, name) {
	const n = value ?? fallback
	if (!Number.isSafeInteger(n) || n < 1 || n > ARTIFACT_QUERY_LIMIT) throw fail(400, "invalid_request", `${name} must be an integer from 1 to ${ARTIFACT_QUERY_LIMIT}.`)
	return n
}
function index(value, shape, edge = false) {
	if (!Array.isArray(value) || value.length !== 3 || value.some((v, axis) => !Number.isSafeInteger(v) || v < 0 || v >= shape[axis] + (edge ? 1 : 0))) throw fail(400, "invalid_request", "Supply three zero-based indices inside the grid; region maxima are exclusive.")
	return value
}
function details(volume, at) {
	const i = cellIndex(volume.grid.shape, at), valid = volume.valid[at] === 1
	return { index: i, valid, value: valid ? volume.field.kind === "categorical" ? volume.field.categories[volume.values[at]].label : volume.values[at] : null, center: cellBounds(volume.grid, i).center }
}

/** Called only after complete manifest/member integrity verification. */
export function inspectArtifact(manifest, volume, options = {}) {
	object(options, ["indices", "region", "limit", "categoryLimit"], "Inspection options")
	const maxCells = limit(options.limit, 64, "limit"), maxCategories = limit(options.categoryLimit, 32, "categoryLimit")
	const indices = options.indices ?? []
	if (!Array.isArray(indices) || indices.length > ARTIFACT_QUERY_LIMIT) throw fail(400, "invalid_request", `Supply at most ${ARTIFACT_QUERY_LIMIT} cell indices.`)
	const selected = new Set(indices.map((i) => flatIndex(volume.grid.shape, ...index(i, volume.grid.shape))))
	let requestedCells = selected.size
	if (options.region !== undefined) {
		object(options.region, ["min", "max"], "Region")
		const min = index(options.region.min, volume.grid.shape), max = index(options.region.max, volume.grid.shape, true)
		if (min.some((v, axis) => v >= max[axis])) throw fail(400, "invalid_request", "Region maxima must exceed their minima on every axis.")
		requestedCells += max.reduce((n, v, axis) => n * (v - min[axis]), 1)
		for (const at of selected) { const i = cellIndex(volume.grid.shape, at); if (i.every((v, axis) => v >= min[axis] && v < max[axis])) requestedCells-- }
		outer: for (let x = min[0]; x < max[0]; x++) for (let y = min[1]; y < max[1]; y++) for (let z = min[2]; z < max[2]; z++) {
			if (selected.size >= maxCells) break outer
			selected.add(flatIndex(volume.grid.shape, x, y, z))
		}
	}
	const categories = volume.field.kind === "categorical" ? volume.field.categories : null
	const { categories: dictionary, ...field } = volume.field
	const result = { artifact: volume.artifact, integrity: "verified", grid: volume.grid, field, recipe: manifest.recipe, sourceRevisions: manifest.sourceRevisions, statistics: manifest.statistics, warnings: manifest.warnings,
		categoryDictionary: categories ? { count: categories.length, categories: categories.slice(0, maxCategories), truncated: categories.length > maxCategories } : null,
		cells: [...selected].slice(0, maxCells).map((at) => details(volume, at)), requestedCells, truncated: requestedCells > maxCells }
	if (Buffer.byteLength(JSON.stringify(result)) > ARTIFACT_RESPONSE_BYTES) throw fail(413, "inspection_limit", `The inspection exceeds ${ARTIFACT_RESPONSE_BYTES} response bytes. Request fewer cells or categories.`)
	return result
}

/** A complete replacement source, never a patch-only or truncated table. */
export function materializeArtifact(manifest, volume, options = {}, limits) {
	object(options, ["edits"], "Materialization options")
	const edits = options.edits ?? []
	if (!Array.isArray(edits) || edits.length > ARTIFACT_EDIT_LIMIT) throw fail(400, "invalid_request", `Supply at most ${ARTIFACT_EDIT_LIMIT} cell edits.`)
	const changes = new Map(), categorical = volume.field.kind === "categorical"
	for (const edit of edits) {
		object(edit, ["index", "valid", "value"], "Cell edit")
		const at = flatIndex(volume.grid.shape, ...index(edit.index, volume.grid.shape))
		if (changes.has(at)) throw fail(400, "invalid_request", "Each cell may be edited only once in a replacement.")
		if (typeof edit.valid !== "boolean") throw fail(400, "invalid_request", "Each cell edit must specify valid as true or false.")
		if (edit.valid) {
			if (categorical ? !validCategoryLabel(edit.value) || edit.value.includes("\0") : typeof edit.value !== "number" || !Number.isFinite(edit.value)) throw fail(400, "invalid_request", "Valid edits require an exact nonempty label or a finite numeric value matching the field kind.")
		} else if (Object.hasOwn(edit, "value")) throw fail(400, "invalid_request", "Empty-cell edits omit value.")
		changes.set(at, edit)
	}
	const grid = volume.grid
	if (grid.unit === "grid-unit" ? grid.horizontalReference.type !== "unreferenced" || grid.verticalReference !== null : grid.horizontalReference.type === "unreferenced" || !grid.verticalReference?.trim()) throw fail(422, "invalid_placement", "This volume needs explicit horizontal and elevation placement metadata before indexed replacement.")
	const budget = inputBudget(limits), chunks = ["x,y,z,value\n"]; budget.string(chunks[0].length); let bytes = Buffer.byteLength(chunks[0]), rows = 0
	if (bytes > limits.sourceBytes) throw fail(413, "source_limit", "The complete replacement exceeds the source byte limit.")
	for (let at = 0; at < volume.valid.length; at++) {
		const edit = changes.get(at), valid = edit ? edit.valid : volume.valid[at] === 1
		if (!valid) continue
		const value = edit ? edit.value : categorical ? volume.field.categories[volume.values[at]].label : volume.values[at]
		if (categorical && (value.length === 0 || value.includes("\0"))) throw fail(422, "unsupported_label", "A valid empty or NUL-containing category label cannot be represented by indexed replacement.")
		const text = categorical ? `"${value.replaceAll('"', '""')}"` : Object.is(value, -0) ? "-0" : String(value)
		const line = `${cellIndex(grid.shape, at).join(",")},${text}\n`
		budget.charge(128); budget.string(line.length)
		if (++rows > limits.rows) throw fail(413, "row_limit", "The complete replacement exceeds the source row limit. Use a supported larger replacement route.")
		bytes += Buffer.byteLength(line)
		if (bytes > limits.sourceBytes) throw fail(413, "source_limit", "The complete replacement exceeds the source byte limit. Use a supported larger replacement route.")
		chunks.push(line)
	}
	if (!rows) throw fail(422, "no_valid_values", "The replacement contains no valid cells.")
	return { complete: true, integrity: "verified", base: volume.artifact, csv: chunks.join(""), rows, byteLength: bytes,
		// The service must capture the CSV and bind scope.input before validating
		// or submitting. A generated source has no capture identity yet.
		recipe: { schemaVersion: 1, algorithm: "geocluster-indexed-v1", scope: { input: null, range: { rowStart: 0, rowEnd: rows, columnStart: 0, columnEnd: 3 }, headerRows: [0] },
			indices: { x: 0, y: 1, z: 2, base: 0 }, shape: [...grid.shape], placement: { origin: [...grid.origin], spacing: [...grid.spacing], unit: grid.unit, horizontalReference: grid.horizontalReference, verticalReference: grid.verticalReference },
			field: categorical ? { kind: "categorical", column: 3, name: volume.field.name, trim: false } : { kind: "numeric", column: 3, name: volume.field.name, unit: volume.field.unit },
			numbers: structuredClone(NEUTRAL_NUMBER_POLICY), emptyCells: rows === volume.valid.length ? "forbid" : "allow", name: manifest.recipe.recipe.name || volume.field.name, predecessor: volume.artifact } }
}
