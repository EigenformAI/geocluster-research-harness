/** Shared wire vocabulary. The OpenCode build copies this dependency-free decoder into its config library. */
export const VOXEL_SOCKET = "/run/geocluster/voxels.sock"
export const VOXEL_ENDPOINT = "/agent/voxels"
export const MAX_REFERENCES = 16
export const MAX_REFERENCE_BYTES = 8192
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const text = (value, max = 128) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
const displayText = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !value.includes("\0")
export const isConversationId = (value) => typeof value === "string" && /^ses_[A-Za-z0-9]+$/.test(value) && value.length <= 128
export const exactFields = (value, allowed, required = allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key))
export const validScope = (value) => exactFields(value, ["workspaceId", "workspaceEpoch"]) && text(value.workspaceId) && text(value.workspaceEpoch)
export const sameScope = (a, b) => validScope(a) && validScope(b) && a.workspaceId === b.workspaceId && a.workspaceEpoch === b.workspaceEpoch
export function ordinaryPath(value) {
	return text(value, 4096) && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part && ![".", "..", ".runtime", ".ide-state", ".datasets-staging", ".clinerules", ".git", ".upload-tmp", "_orchestrator"].includes(part) && !part.startsWith(".gc-file-") && part !== ".env" && !part.startsWith(".env."))
}
const digest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
export function validArtifact(value) {
	if (!exactFields(value, ["artifactId", "generation", "manifest"]) || !/^vox-[A-Za-z0-9-]{1,120}$/.test(value.artifactId) || !digest(value.generation)) return false
	const s = value.manifest
	return exactFields(s, ["root", "resourceId", "path", "sha256", "revision"]) && s.root === "workspace" && ordinaryPath(s.path) && s.resourceId === s.path && digest(s.sha256) && /^capture:[0-9a-f-]{36}$/.test(s.revision) && /^capture:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s.revision)
}
export const OUTCOMES = ["accepted", "artifact-saved", "named-created", "head-advanced", "head-conflict", "head-advance-failed", "head-outcome-unknown", "named-creation-failed", "named-outcome-unknown", "publication-unknown", "failed"]
/** Shape is necessary, never authority: only decode values returned by the protected runtime, never model prose. */
export function validateReference(value, scope) {
	if (!exactFields(value, ["schemaVersion", "scope", "operationId", "artifact", "named", "outcome", "summary"], ["schemaVersion", "scope", "operationId", "artifact", "outcome", "summary"]) || value.schemaVersion !== 1 || !sameScope(value.scope, scope) || !text(value.operationId) || !OUTCOMES.includes(value.outcome)) return null
	if (value.artifact !== null && !validArtifact(value.artifact)) return null
	if (value.named !== undefined && (!exactFields(value.named, ["voxelId", "name", "headRevision"]) || !text(value.named.voxelId) || !displayText(value.named.name) || value.named.headRevision !== null && !text(value.named.headRevision, 256))) return null
	if (["named-created", "head-advanced"].includes(value.outcome) && (!value.artifact || !value.named?.headRevision)) return null
	if (["artifact-saved", "head-outcome-unknown", "head-advance-failed", "named-creation-failed", "named-outcome-unknown"].includes(value.outcome) && !value.artifact) return null
	const s = value.summary
	if (!exactFields(s, ["name", "shape", "validCells"], ["name"]) || !displayText(s.name)) return null
	if (s.shape !== undefined && (!Array.isArray(s.shape) || s.shape.length !== 3 || s.shape.some((n) => !Number.isSafeInteger(n) || n < 1) || !Number.isSafeInteger(s.shape.reduce((a, n) => a * n, 1)))) return null
	if (s.validCells !== undefined && (!Number.isSafeInteger(s.validCells) || s.validCells < 0 || s.shape && s.validCells > s.shape.reduce((a, n) => a * n, 1))) return null
	if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_REFERENCE_BYTES) return null
	return structuredClone(value)
}

const str = { type: "string", minLength: 1, maxLength: 4096 }
const opaque = { type: "object" }
const artifactSchema = { type: "object", additionalProperties: false, required: ["artifactId", "generation", "manifest"], properties: { artifactId: str, generation: str, manifest: opaque } }
const spec = (action, description, properties, required = []) => ({ action, description, input: { type: "object", additionalProperties: false, properties, required } })
export const TOOL_SPECS = {
	voxel_resolve: spec("resolve", "Resolve a named voxel by ID or unambiguous name, or list a bounded page (optional exact name filter for ambiguous names). A conversation reference is only a scoped target hint; resolve the current head before revising.", { voxelId: str, name: str, reference: opaque, list: { type: "boolean" }, cursor: str, limit: { type: "integer", minimum: 1, maximum: 100 } }),
	voxel_inspect: spec("inspect", "Inspect an exact registered artifact: verified manifest, recipe, sources, bounded dictionary/cells/region. Never returns private member paths or full arrays.", { artifact: artifactSchema, options: opaque }, ["artifact"]),
	voxel_prepare: spec("prepare", "Capture an ordinary workspace source path; or materialize a verified artifact as a COMPLETE replacement CSV at destination, with bounded options.edits. Runtime binds the captured input; no patch-only publication.", { path: str, artifact: artifactSchema, options: opaque, destination: str }),
	voxel_validate: spec("validate", "Full-data validation of the exact canonical submission. Observation, indexed-table and supported NPY intents use runtime-owned schemas. Recipe changes require fresh validation.", { submission: opaque }, ["submission"]),
	voxel_submit: spec("submit", "Submit the exact validated canonical creation/revision with a retained idempotencyKey. Revision carries voxelId, expectedHeadRevision and exact base; status discovers uncertain responses without a new key.", { submission: opaque, idempotencyKey: str }, ["submission", "idempotencyKey"]),
	voxel_status: spec("status", "Discover/poll one operation by operationId OR retained idempotencyKey. Service metadata distinguishes saved artifact, committed named head, conflict and unknown outcome.", { operationId: str, idempotencyKey: str }),
}
export const ACTION_FIELDS = Object.fromEntries(Object.values(TOOL_SPECS).map((s) => [s.action, Object.keys(s.input.properties)]))
ACTION_FIELDS.capabilities = []
ACTION_FIELDS.references = []

/** Validate the transport/tool envelope here; the service remains authoritative for nested recipes and options. */
export function validArguments(action, args) {
	const spec = Object.values(TOOL_SPECS).find((s) => s.action === action)
	if (!spec) return ["capabilities", "references"].includes(action) && exactFields(args, [])
	if (!exactFields(args, Object.keys(spec.input.properties), spec.input.required)) return false
	for (const [key, value] of Object.entries(args)) {
		const field = spec.input.properties[key]
		if (field.type === "string" && (key === "name" ? !displayText(value) : !text(value, field.maxLength) || value.length < field.minLength)) return false
		if (field.type === "object" && !object(value)) return false
		if (field.type === "boolean" && typeof value !== "boolean") return false
		if (field.type === "integer" && (!Number.isSafeInteger(value) || value < field.minimum || value > field.maximum)) return false
	}
	return true
}
