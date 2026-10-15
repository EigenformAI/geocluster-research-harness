import crypto from "node:crypto"
import fs from "node:fs"
import { parentPort, workerData } from "node:worker_threads"
import { computeVoxels } from "./voxel/voxel-compute.js"
import { computeIndexed, scanIndices } from "./voxel/voxel-indexed.js"
import { inspectArtifact, materializeArtifact } from "./voxel/voxel-inspection.js"
import { decodeNpyVolume, encodeNpy, NpyError } from "./voxel/npy.js"
import { assembleVolume, normalizeImported, readManifest, spatialMetadataProblems, VoxelArtifactError } from "./voxel/voxel-artifact.js"
import { METADATA_FIELDS, validateIndexedRecipe, validateScope, validateIndices, validateNumberPolicy, VoxelRecipeError } from "./voxel/voxel-recipe.js"
import { fail, checked } from "./voxel-request.js"
import { projectedInput } from "./voxel-input.js"

function bytes(binding, ceiling) {
	if (!binding || !Number.isSafeInteger(binding.size) || binding.size < 0 || !Number.isSafeInteger(binding.fd) || binding.fd < 0 || !/^[0-9a-f]{64}$/.test(binding.sha256)) throw fail(400, "invalid_binding", "Supply a complete captured file descriptor, byte size and SHA-256.")
	if (binding.size > ceiling) throw fail(413, "source_limit", `The captured file exceeds ${ceiling} bytes. Select a smaller source.`)
	const out = Buffer.alloc(binding.size)
	let at = 0
	while (at < out.length) { const n = fs.readSync(binding.fd, out, at, Math.min(65536, out.length - at), at); if (!n) throw fail(503, "source_integrity", "The protected capture is truncated. Capture the source again."); at += n }
	if (crypto.createHash("sha256").update(out).digest("hex") !== binding.sha256) throw fail(409, "source_integrity", "Protected bytes differ from their recorded SHA-256. Capture the source again.")
	return out
}
async function run(data) {
	if (["verify", "inspect-artifact", "materialize-artifact"].includes(data.action)) {
		const m = await readManifest(bytes(data.manifest, data.limits.memberBytes)), members = {}
		const cells = m.grid.shape.reduce((a, b) => a * b, 1)
		if (cells > data.limits.cells) throw fail(413, "cell_limit", "The canonical volume exceeds the cell limit.")
		if (!data.members || Object.keys(data.members).length !== m.arrays.length || Object.keys(data.members).some((role) => !m.arrays.some((a) => a.role === role))) throw fail(400, "invalid_members", "Supply exactly the captured members declared in the manifest.")
		for (const [role, binding] of Object.entries(data.members)) members[role] = bytes(binding, data.limits.memberBytes)
		const volume = await assembleVolume(m, members)
		if (data.action === "inspect-artifact") return inspectArtifact(m, volume, data.options)
		if (data.action === "materialize-artifact") return materializeArtifact(m, volume, data.options, data.limits)
		return { manifest: m }
	}
	if (data.action === "import") {
		const raw = decodeNpyVolume(bytes(data.binding, data.limits.sourceBytes), data.limits.cells), metadata = data.recipe.metadata
		const errors = spatialMetadataProblems(metadata, METADATA_FIELDS.filter((field) => !data.recipe.defaults.includes(field)))
		if (errors.length) throw fail(422, "invalid_metadata", errors.join(" "))
		const normalized = normalizeImported(raw, metadata)
		const statistics = { rows: 0, acceptedRows: 0, excludedRows: 0, exclusions: {}, secondaryExclusions: {}, occupiedCells: normalized.occupied, valueRange: normalized.range, duplicatePositions: 0, categoryTies: 0, censoredSubstitutions: 0, formulaCacheValues: 0, clipping: null, bounds: null }
		return { grid: normalized.grid, field: { kind: "numeric", name: metadata.fieldName, unit: metadata.fieldUnit }, statistics, warnings: [], parsers: ["bounded-npy-v1"], arrays: encoded({ values: normalized.values, valid: normalized.valid }, normalized.grid.shape, data.limits) }
	}
	if (data.action === "scan-indices") {
		const scope = checked(() => validateScope(data.scope)), indices = checked(() => validateIndices(data.indices)), numbers = checked(() => validateNumberPolicy(data.numbers))
		const input = projectedInput({ ...data, input: scope.input }, scope, data.limits, bytes)
		return { ...scanIndices(input, indices, numbers, data.limits), parsers: input.parsers }
	}
	if (data.action === "indexed-grid" || data.action === "compute" && data.recipe?.algorithm === "geocluster-indexed-v1") {
		const recipe = checked(() => validateIndexedRecipe(data.recipe))
		// The recipe is the sole authority for the selected scope and delimiter.
		const input = projectedInput({ ...data, input: recipe.scope.input, fullRange: false }, recipe.scope, data.limits, bytes)
		const result = computeIndexed(input, recipe, { materialize: data.materialize, limits: data.limits })
		return { ...result, parsers: input.parsers, arrays: result.arrays ? encoded(result.arrays, result.grid.shape, data.limits) : null }
	}
	if (!["compute", "describe"].includes(data.action)) throw fail(400, "invalid_action", "Select a supported voxel worker action.")
	const input = projectedInput(data, data.scope || data.recipe.scope, data.limits, bytes)
	if (data.action === "describe") return { scope: input.scope, rows: input.rowCount, columns: input.columns.length, headers: input.headers, sample: input.rows.map((r) => ({ row: r.row, cells: r.cells.map((c) => c.raw === null ? "" : String(c.raw)) })), parser: input.parsers.join(", "), warnings: input.warnings }
	const result = computeVoxels(input, data.recipe, { materialize: data.materialize, limits: data.limits, transforms: [] })
	return { ...result, parsers: input.parsers, arrays: result.arrays ? encoded(result.arrays, result.grid.shape, data.limits) : null }
}
function encoded(arrays, shape, limits) {
	const result = {}
	for (const [role, value] of Object.entries(arrays)) if (value) { const encoded = encodeNpy(value, shape); if (encoded.length > limits.memberBytes) throw fail(413, "member_limit", `The ${role} array exceeds ${limits.memberBytes} bytes. Use larger cells.`); result[role] = encoded }
	return result
}
if (parentPort) {
	try { const result = await run(workerData); const transfer = Object.values(result.arrays || {}).map((a) => a.buffer); parentPort.postMessage({ result }, transfer) }
	catch (error) {
		const invalid = error instanceof VoxelArtifactError ? "invalid_manifest" : error instanceof NpyError ? "invalid_npy" : error instanceof VoxelRecipeError ? "invalid_recipe" : null
		const io = typeof error.code === "string" && /^E[A-Z0-9]+$/.test(error.code)
		parentPort.postMessage({ error: { status: error.status || (invalid ? 422 : 503), error: error.error || invalid || (io ? "worker_io_unavailable" : "worker_failed"), reason: error.message } })
	}
}
