import { validateRecipe, validateIndexedRecipe, validateScope, validateIndices, validateNumberPolicy, validateRevisionTarget, validateSourceRevision, validateSubmission, VoxelRecipeError } from "./voxel/voxel-recipe.js"

export class VoxelError extends Error {
	constructor(status, error, reason) { super(reason); this.status = status; this.error = error }
	toJSON() {
		const evidence = Object.fromEntries(["retryAfter", "retryAt", "availability", "requiredBytes", "availableBytes", "limits", "action"].filter((key) => this[key] !== undefined).map((key) => [key, this[key]]))
		return { error: this.error, reason: this.message, message: this.message, agent: "voxel-service", tool: "voxels", action: "Correct the indicated source or recipe, then retry; use a new key for a new submission.", ...evidence }
	}
}
export const fail = (status, error, reason) => new VoxelError(status, error, reason)
export function strict(value, keys, name) {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) throw fail(400, "invalid_request", `${name} must contain exactly ${keys.join(", ")}.`)
}
export function checked(work) {
	try { return work() } catch (error) { if (error instanceof VoxelRecipeError) throw fail(400, "invalid_recipe", error.message); throw error }
}
export const sourceRevision = (value) => checked(() => validateSourceRevision(value))
export const submission = (value) => checked(() => validateSubmission(value))
export const tableRecipe = (value) => checked(() => validateRecipe(value))
export const indexedRecipe = (value) => checked(() => validateIndexedRecipe(value))
export const revisionTarget = (value) => checked(() => validateRevisionTarget(value))
export function indexScan(value) {
	strict(value, ["scope", "indices", "numbers"], "Index scan")
	return checked(() => ({ scope: validateScope(value.scope), indices: validateIndices(value.indices), numbers: validateNumberPolicy(value.numbers) }))
}
// Reuse the exact strict scope validator with a fixed, valid recipe shell.
export function describeScope(input, range, headerRows) {
	return tableRecipe({ schemaVersion: 1, algorithm: "geocluster-binning-v1", name: "Description", scope: { input, range: range ?? { rowStart: 0, rowEnd: 0, columnStart: 0, columnEnd: 0 }, headerRows }, geometry: { mode: "points", x: 0, y: 0, z: 0, zMeaning: { type: "elevation" } }, reference: { horizontal: { type: "local", name: "Description" }, horizontalUnit: "m", verticalUnit: "m", verticalReference: "Description" }, value: { kind: "numeric", column: 0, name: "Description", unit: "", aggregation: "mean" }, numbers: { decimal: ".", thousands: "none", missingTokens: [], sentinels: [], censored: "exclude" }, predicates: [], grid: { spacing: [1, 1, 1], extent: { type: "auto" } }, predecessor: null }).scope
}
