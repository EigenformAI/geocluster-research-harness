/** Dependency-free model/bridge vocabulary. Identity and source admission remain runtime authority. */
export const PROCESSING_SOCKET = "/run/geocluster/documents.sock"
export const PROCESSING_ENDPOINT = "/agent/documents"
export const CLIENT_TIMEOUT_MS = 25_000
export const WAIT_DEFAULT_MS = 20_000
export const PROCESSING_TOOLS = ["processing_submit", "processing_status", "processing_wait", "processing_cancel", "processing_result", "processing_read_table", "processing_read_text", "processing_export", "processing_history"]
export const READ_TOOLS = ["processing_result", "processing_read_table", "processing_read_text"]
export const LEGACY_PREFIX = "processor_documents_"
export const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
export const text = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
export const exactFields = (value, allowed, required = allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key))
export const isSessionId = (value) => text(value, 128) && /^ses_[A-Za-z0-9]+$/.test(value)
// Persistent native store scope is deliberately distinct from a managed workspace epoch.
export const validScope = (value) => object(value) && text(value.workspaceId) && (exactFields(value, ["workspaceId", "workspaceEpoch"]) && text(value.workspaceEpoch) || exactFields(value, ["workspaceId", "storeScope"]) && text(value.storeScope))
export const sameScope = (a, b) => validScope(a) && validScope(b) && a.workspaceId === b.workspaceId && a.workspaceEpoch === b.workspaceEpoch && a.storeScope === b.storeScope
export const allowedTool = (agent, tool) => PROCESSING_TOOLS.includes(tool) && (["dataops", "standard"].includes(agent) || agent === "report-analysis" && READ_TOOLS.includes(tool))
export const validBasename = (value) => text(value, 200) && !value.startsWith(".") && !/[\\/]/.test(value)
export const ordinaryPath = (value) => text(value, 4096) && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part && ![".", "..", ".runtime", ".ide-state", ".git", ".datasets-staging", ".upload-tmp", "_orchestrator"].includes(part) && !part.startsWith(".env") && !part.startsWith(".gc-file-"))

const str = { type: "string", minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }
const record = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required })
const integer = (minimum, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum })
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] })
const sourcePath = { ...str, maxLength: 4096, description: "Project-relative ordinary workspace path, never a private or absolute path. The owning runtime binds the source bytes." }
const observation = { anyOf: [{ ...str, maxLength: 512 }, { type: "object", required: ["token"], properties: { token: { ...str, maxLength: 512 }, ref: { type: "object" } } }] }
const tableRecovery = record({ geometry: { enum: ["auto", "force", "off"] }, vision: { enum: ["confirm-all", "on-demand", "off"] }, forcePages: { type: "array", items: integer(1), maxItems: 10_000 }, renderDpi: { type: "number", exclusiveMinimum: 0 }, maxAdditionalPasses: integer(0), maxModelCalls: nullable(integer(1)), workSeconds: nullable({ type: "number", exclusiveMinimum: 0 }) })
export function sourceSchema(mode) {
	if (mode === "native") return { oneOf: [record({ kind: { const: "workspace-file" }, path: sourcePath }, ["kind", "path"]), record({ kind: { const: "snapshot" }, snapshotId: str }, ["kind", "snapshotId"])] }
	if (mode !== "managed") throw new Error("Processing mode must be native or managed.")
	return { oneOf: [
		record({ kind: { const: "workspace-file" }, path: sourcePath, baseObservation: { ...observation, description: "Retained file-service observation when selecting previously inspected bytes. Omit only for a new current-path request; runtime obtains and persists an observation before admission." } }, ["kind", "path"]),
		record({ kind: { const: "capture" }, captureId: str }, ["kind", "captureId"]),
		record({ kind: { const: "upload-operation" }, operationId: { ...str, description: "Trusted attachment admission reference, not a filename or attachment URI." } }, ["kind", "operationId"]),
	] }
}
const spec = (action, description, properties, required = []) => ({ action, description, input: record(properties, required) })
export function toolSpecs(mode = "managed") {
	const handles = { requestId: { ...str, description: "Runtime-issued receipt to inspect/recover; do not manufacture a submission key." }, jobId: str }
	const specs = {
		processing_submit: spec("submit", "Submit retained document extraction/OCR. Runtime allocates and persists identity before dispatch. To recover, supply ONLY the retained requestId; never resubmit with a new identity after uncertainty. Source schema matches this runtime mode. Pending receipt history is reinjected separately from prose.", { source: sourceSchema(mode), requestId: handles.requestId, tableRecovery, rerunOf: { ...str, description: "Explicit deliberate new attempt of a retained job; preserves its source unless a new source is explicitly supplied." }, ...(mode === "native" ? { expectedSha256: { type: "string", pattern: "^[0-9a-f]{64}$" } } : { requireCoherentSource: { type: "boolean" } }) }),
		processing_status: spec("status", "Inspect one requestId OR jobId. An accepted job is not completed work; inspect resultAvailable and quality.", handles),
		processing_wait: spec("wait", "Observe one requestId OR jobId without starting/replaying extraction. Default server wait is 20 seconds; timeout returns a continuation, not job failure. Aborting observation does not cancel execution.", { ...handles, timeoutMs: { ...integer(0, WAIT_DEFAULT_MS), default: WAIT_DEFAULT_MS } }),
		processing_cancel: spec("cancel", "Explicitly request cancellation of one requestId OR jobId. cancel_pending is not settled cancellation. Never submit to discover a job to cancel.", handles),
		processing_result: spec("result", "Read a bounded retained result summary with coverage, stages, provenance and unresolved quality. Set fullManifest:true explicitly to retrieve the full sealed manifest instead of the paginated summary. Manifest/summary access is not a content witness. RESULT_NOT_AVAILABLE means observe the existing job, not resubmit.", { ...handles, offset: integer(0), limit: integer(1, 100), fullManifest: { type: "boolean", default: false, description: "Explicit full sealed manifest retrieval; false or omitted uses the bounded summary. Never grants access to gate credentials or raw store descriptors." } }),
		processing_read_table: spec("readTable", "Read a bounded table row range and its source provenance/citationToken. Rows include source/header-looking rows; header not-inferred does not establish a data-record count.", { ...handles, tableId: str, offset: integer(0), limit: integer(1, 1000) }, ["tableId"]),
		processing_read_text: spec("readText", "Read a bounded retained text-product byte range with exact provenance/citationToken. Cite that token only for the returned range, never as proof of an ordinary PDF read.", { ...handles, productId: str, offset: integer(0), limit: integer(1, 65_536) }, ["productId"]),
		processing_export: spec("exportProduct", "Byte-preserving copy of a sealed inventory product into this root conversation's runtime-owned results folder. basename is a filename only. Recover uncertain publication using ONLY exportId, without changing its handle, product or destination; recovery never authorizes republication. Outside destinations require separate approval and are rejected, never silently redirected. Partial export retains unresolved job quality.", { ...handles, productId: str, basename: { ...str, maxLength: 200, pattern: "^[^./\\\\][^/\\\\]*$" }, exportId: { ...str, description: "Runtime-issued export receipt for recovery only. Supply exportId alone." } }),
		processing_history: spec("history", "Discover protected receipts for this persistent workspace and root conversation, including prepared/unknown/rejected/cancellation-pending requests. Recover the original requestId before creating new work. No sibling-root or CLI-only receipt discovery.", { limit: integer(1, 100), offset: integer(0), ...(mode === "native" ? { cursor: { ...str, maxLength: 4096, description: "Opaque nextCursor returned by workspace job history. Receipt history uses offset separately." } } : {}) }),
	}
	for (const entry of Object.values(specs)) if (["status", "wait", "cancel", "result", "readTable", "readText", "exportProduct"].includes(entry.action)) entry.input.oneOf = [{ required: ["requestId"] }, { required: ["jobId"] }]
	const publication = { ...specs.processing_export.input.properties }; delete publication.exportId
	specs.processing_export.input.oneOf = [record({ exportId: str }, ["exportId"]), { ...record(publication, ["productId", "basename"]), oneOf: [{ required: ["requestId"] }, { required: ["jobId"] }] }]
	const fresh = { ...specs.processing_submit.input.properties }; delete fresh.requestId
	const rerun = { ...fresh }; delete rerun.source
	specs.processing_submit.input.oneOf = [record({ requestId: handles.requestId }, ["requestId"]), record(fresh, ["source"]), record(rerun, ["rerunOf"])]
	return specs
}

function shape(schema, value) {
	if (schema.required && (!object(value) || !schema.required.every((key) => Object.hasOwn(value, key)))) return false
	if (schema.oneOf && schema.oneOf.filter((branch) => shape(branch, value)).length !== 1) return false
	if (schema.anyOf && !schema.anyOf.some((branch) => shape(branch, value))) return false
	if (Object.hasOwn(schema, "const") && schema.const !== value || schema.enum && !schema.enum.includes(value)) return false
	if (schema.type === "null") return value === null
	if (schema.type === "string") return text(value, schema.maxLength ?? 4096) && (!schema.pattern || new RegExp(schema.pattern, "u").test(value))
	if (schema.type === "boolean") return typeof value === "boolean"
	if (schema.type === "integer") return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum
	if (schema.type === "number") return typeof value === "number" && Number.isFinite(value) && value > (schema.exclusiveMinimum ?? -Infinity)
	if (schema.type === "array") return Array.isArray(value) && value.length <= schema.maxItems && value.every((item) => shape(schema.items, item))
	if (schema.type === "object") return object(value) && (schema.required ?? []).every((key) => Object.hasOwn(value, key)) && Object.entries(value).every(([key, item]) => Object.hasOwn(schema.properties ?? {}, key) ? shape(schema.properties[key], item) : schema.additionalProperties !== false)
	return true
}
export function validArguments(action, args, mode = "managed") {
	if (action === "capabilities") return exactFields(args, [])
	const schema = Object.values(toolSpecs(mode)).find((entry) => entry.action === action)?.input
	if (!schema || !shape(schema, args)) return false
	if (action === "exportProduct" && args.exportId !== undefined) return exactFields(args, ["exportId"])
	if (["status", "wait", "cancel", "result", "readTable", "readText", "exportProduct"].includes(action) && Number(Object.hasOwn(args, "requestId")) + Number(Object.hasOwn(args, "jobId")) !== 1) return false
	if (action === "exportProduct" && !validBasename(args.basename)) return false
	if (action === "submit") {
		if (args.requestId !== undefined) return Object.keys(args).length === 1
		if (!args.source && !args.rerunOf) return false
		if (args.source?.kind === "workspace-file" && !ordinaryPath(args.source.path)) return false
	}
	return true
}

/** Only an allowlisted bounded receipt projection reaches model context, never replay payloads or keys. */
export function receiptHistory(result) {
	const receipts = result?.requests
	return (Array.isArray(receipts) ? receipts : []).slice(0, 32).filter((receipt) => object(receipt) && text(receipt.requestId)).map((receipt) => Object.fromEntries(Object.entries(receipt).filter(([key, value]) => ["requestId", "jobId", "resultId", "state", "operationOutcome", "jobOutcome", "sourceSha256", "createdAt", "updatedAt"].includes(key) && text(value, 512) || ["cancelRequested", "resultAvailable"].includes(key) && typeof value === "boolean")))
}
