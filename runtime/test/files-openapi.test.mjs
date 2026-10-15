import assert from "node:assert/strict"
import http from "node:http"
import { test } from "node:test"
import { FilesApi } from "../lib/files.js"
import { FILE_LIMITS, noPersistence } from "../lib/file-contract.js"
import { FileSegments, SEGMENT_PARSER } from "../lib/file-segments.js"
import { FileMapViews } from "../lib/file-map-views.js"
import { parseSegment } from "../lib/file-segments-worker.js"
import { buildFilesSchemas } from "../lib/files-openapi.js"
import { WorkspaceFiles } from "../lib/workspace-files.js"

// Focused JSON Schema checks for the wire fixtures below; not an HTTP validator.
function accepts(schema, value, schemas) {
	if (Array.isArray(schema.type)) return schema.type.some((type) => accepts({ ...schema, type }, value, schemas))
	if (schema.$ref) return accepts(schemas[schema.$ref.split("/").at(-1)], value, schemas)
	if (schema.oneOf && schema.oneOf.filter((variant) => accepts(variant, value, schemas)).length !== 1) return false
	if (schema.anyOf && !schema.anyOf.some((variant) => accepts(variant, value, schemas))) return false
	if (schema.allOf && !schema.allOf.every((variant) => accepts(variant, value, schemas))) return false
	if ("const" in schema && value !== schema.const) return false
	if (schema.enum && !schema.enum.includes(value)) return false
	if (schema.type === "null" && value !== null) return false
	if (schema.type === "string" && (typeof value !== "string" || (schema.minLength && value.length < schema.minLength) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false
	if (schema.type === "boolean" && typeof value !== "boolean") return false
	if (schema.type === "integer" && (!Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false
	if (schema.type === "array" && (!Array.isArray(value) || !value.every((item) => accepts(schema.items, item, schemas)))) return false
	if (schema.type === "object") {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return false
		if (schema.required?.some((key) => !(key in value))) return false
		for (const [key, item] of Object.entries(value)) {
			if (schema.properties?.[key]) { if (!accepts(schema.properties[key], item, schemas)) return false }
			else if (schema.additionalProperties === false) return false
		}
	}
	return true
}

function infoFixture() {
	return {
		identity: { workspaceId: "workspace-1", workspaceEpoch: "epoch-1" }, config: {}, workspaceDir: "/workspace", events: { bootId: "boot-1" }, trashAvailable: false,
		limits: { ...FILE_LIMITS, rowMaxLimit: 17, readMaxBytes: 8192, cellCodePoints: 3 }, safeFs: { scanLimit: 500 },
		captures: { availability: { state: "available" }, provenStrategies: { reflink: false }, parser: { availability: { state: "available" } } },
		index: { info: () => ({}) }, maps: new FileMapViews({}), processing: { capabilities: async () => undefined }, searcher: { capabilities: () => ({}) }, persistence: { capabilities: () => ({ enabled: false }) },
	}
}

test("processing liveness schema accepts labelled stage and progress with authoritative timestamps and nonnegative queue position", () => {
	const schemas = buildFilesSchemas(), properties = schemas.ProcessingJob.properties
	const progress = { id: "extract", label: "Inspecting pages", unit: "page", completedUnits: 12, totalUnits: 80, updatedAt: "2026-10-14T10:00:00.000Z" }, stage = { ...progress }; delete stage.updatedAt
	assert.ok(accepts(properties.stage, stage, schemas))
	assert.ok(properties.progress && accepts(properties.progress, progress, schemas))
	assert.ok(properties.startedAt && accepts(properties.startedAt, null, schemas))
	assert.ok(properties.queueAhead && accepts(properties.queueAhead, 0, schemas))
	assert.equal(accepts(properties.queueAhead, -1, schemas), false)
	assert.equal(accepts(properties.progress, { ...progress, completedUnits: 1.5 }, schemas), false)
})

test("processing liveness interruption schema exposes a nullable authoritative timestamp", () => {
	const schemas = buildFilesSchemas(), field = schemas.ProcessingJob.properties.interruptedAt
	assert.ok(field && accepts(field, null, schemas))
	assert.ok(accepts(field, "2026-10-14T10:01:00.123456Z", schemas))
	assert.equal(accepts(field, 123, schemas), false)
	assert.ok(schemas.ProcessingJob.required.includes("interruptedAt"))
})

test("processing contract distinguishes admission, execution, compatibility and pair liveness", () => {
	const schemas = buildFilesSchemas(), stamp = new Date().toISOString()
	const dependency = { state: "unavailable", ready: false, executionReady: true, checkedAt: stamp, observedAt: stamp, observationMaxAgeMs: 5000, version: null, compatibility: { classification: "unknown", cliVersion: null, httpVersion: null, descriptorVersion: null, warnings: ["cli_version_missing"] }, preferredModel: "proxy/not-installed/preferred", selectedModel: null, eligibleCandidateCount: 0, selectionReason: "policy_stale", policyAgeMs: 120001, reason: "policy_stale", jobHolds: [{ jobId: "job_retained", reason: "model_not_accepted", selectedModel: "proxy/openai/gpt-6-luna" }] }
	assert.ok(accepts(schemas.ProcessingDependency, dependency, schemas))
	assert.equal(accepts(schemas.ProcessingDependency, { ...dependency, executionReady: "true" }, schemas), false)
	assert.equal(accepts(schemas.ProcessingDependency, { ...dependency, ready: "false" }, schemas), false)
	const pair = { state: "cooldown", attempts: 6, totalLaunches: 6, burstCount: 5, childAlive: false, cooldownMs: 300000, nextRetryAt: stamp }
	assert.ok(accepts(schemas.ProcessingPair, pair, schemas))
	assert.equal(accepts(schemas.ProcessingPair, { ...pair, childAlive: "false" }, schemas), false)
	assert.ok(accepts(schemas.ProcessingPair, { ...pair, state: "starting", childAlive: true, nextRetryAt: null }, schemas))
	assert.ok(accepts(schemas.ProcessingModelSelection, { preferredModel: dependency.preferredModel, selectedModel: "proxy/openai/gpt-6-luna", selectionReason: "canonical_fallback" }, schemas))
})

test("preview contract types actual readiness, identity, and effective provider descriptors", async () => {
	const schemas = buildFilesSchemas(), workspace = infoFixture()
	const info = JSON.parse(JSON.stringify(await WorkspaceFiles.prototype.info.call(workspace)))
	assert.deepEqual(info.providerDetails?.map((provider) => provider.id), ["csv", "tsv", "text"])
	assert.deepEqual(info.providers, ["csv", "tsv", "text"])
	for (const provider of info.providerDetails) {
		assert.equal(provider.build, SEGMENT_PARSER)
		assert.deepEqual(provider.readiness, { state: "available" })
		assert.deepEqual(provider.inputFormats, [provider.id])
		assert.deepEqual(provider.queryOperations, provider.id === "text" ? ["segment"] : ["segment", "header", "detail"])
		assert.equal(provider.queryScope, "window")
		assert.equal(provider.limits.rowMaxLimit, 17)
		assert.equal(provider.limits.readMaxBytes, 8192)
		assert.equal(provider.limits.cellCodePoints, 3)
	}
	assert.ok(accepts(schemas.FilesInfo, info, schemas))
	assert.ok(accepts(schemas.FilesInfo, { filesContractVersion: 1, ...workspace.identity }, schemas), "minimal consumed identity fixtures remain valid")
	assert.equal(accepts(schemas.FilesInfo, { filesContractVersion: 1 }, schemas), false, "workspace identity is required")
	assert.equal(accepts(schemas.FilesInfo, { ...info, ready: "yes" }, schemas), false)
	assert.equal(accepts(schemas.FilesInfo, { ...info, providerDetails: [{ ...info.providerDetails[0], id: "xlsx", inputFormats: ["xlsx"] }] }, schemas), false)
	for (const unavailable of ["parser", "store"]) {
		const fixture = infoFixture()
		if (unavailable === "parser") fixture.captures.parser.availability = { state: "unavailable", reason: "worker-identity" }
		else fixture.captures.availability = { state: "unavailable", reason: "ownership" }
		const disabled = JSON.parse(JSON.stringify(await WorkspaceFiles.prototype.info.call(fixture)))
		assert.deepEqual(disabled.providers, [])
		assert.equal(disabled.operations.includes("preview"), false)
		assert.deepEqual(disabled.providerDetails.map((provider) => provider.id), ["csv", "tsv", "text"])
		assert.ok(disabled.providerDetails.every((provider) => provider.readiness.state === "unavailable"))
		assert.ok(accepts(schemas.FilesInfo, disabled, schemas))
	}
})

test("preview contract types per-resource byte and preview availability truthfully", async () => {
	const schemas = buildFilesSchemas(), workspace = infoFixture()
	let metadata = { name: "a.csv", path: "a.csv", ref: { ...workspace.identity, path: "a.csv" }, type: "file", sizeBytes: 10, modifiedAt: null, observation: null, availability: "local", persistence: noPersistence() }
	workspace.index.stat = async () => metadata
	workspace.state = { list: async () => [] }
	const stat = () => WorkspaceFiles.prototype.stat.call(workspace, "a.csv")
	const available = await stat()
	assert.deepEqual(available.previewCapabilities, { formats: ["csv", "tsv", "text"], capture: true })
	assert.ok(schemas.ResourceMetadata.properties.byteAvailability)
	assert.ok(schemas.ResourceMetadata.properties.previewCapabilities)
	assert.ok(accepts(schemas.ResourceMetadata, available, schemas))
	assert.equal(accepts(schemas.ResourceMetadata, { ...available, byteAvailability: "complete" }, schemas), false)
	assert.equal(accepts(schemas.ResourceMetadata, { ...available, previewCapabilities: { formats: ["xlsx"], capture: true } }, schemas), true)
	assert.equal(accepts(schemas.ResourceMetadata, { ...available, previewCapabilities: { formats: ["xlsm"], capture: true } }, schemas), false)
	for (const patch of [{ type: "dir" }, { availability: "remote-only" }]) {
		metadata = { ...metadata, type: "file", availability: "local", ...patch }
		const unavailable = await stat()
		assert.equal(unavailable.byteAvailability, "unsupported")
		assert.deepEqual(unavailable.previewCapabilities, { formats: [], capture: false })
	}
	metadata = { ...metadata, type: "file", availability: "local" }
	workspace.captures.availability = { state: "unavailable", reason: "ownership" }
	assert.deepEqual((await stat()).previewCapabilities, { formats: [], capture: false })
})

test("preview contract narrows first-view requests while preserving segment header and default vocabulary", () => {
	const schemas = buildFilesSchemas({ rowMaxLimit: 17 }), preview = schemas.PreviewRequest, segment = schemas.SegmentRequest
	assert.equal(preview.additionalProperties, false)
	assert.equal(preview.properties.operation.default, "segment")
	assert.ok(accepts(preview, { path: "a.csv", format: "csv" }, schemas))
	assert.ok(accepts(preview, { path: "a.tsv", format: "tsv", operation: "segment", columnOffset: 2, columnLimit: 4, elapsedMs: 100 }, schemas))
	for (const fields of [{ operation: "header" }, { operation: "detail" }, { cursor: "opaque" }, { cursor: "" }, { rowLimit: 18 }, { unknown: true }]) assert.equal(accepts(preview, { path: "a.csv", format: "csv", ...fields }, schemas), false, JSON.stringify(fields))
	assert.equal(segment.properties.operation.default, "segment")
	assert.ok(accepts(segment, { format: "csv", operation: "header" }, schemas))
	assert.ok(accepts(segment, { format: "csv", operation: "detail", cursor: "opaque" }, schemas))
	for (const key of ["rowLimit", "columnOffset", "columnLimit", "readBytes", "responseBytes", "timeMs", "elapsedMs", "textBytes"]) assert.deepEqual(preview.properties[key], segment.properties[key], key)
})

test("workbook contract discriminates providers and types preparation, queries, exports and surviving sort mode", () => {
	const schemas = buildFilesSchemas()
	const provider = { id: "workbook", build: "reader/1", readiness: { state: "available" }, inputFormats: ["xls", "xlsx"], queryOperations: ["prepare", "query", "export"], queryScope: "full-sheet-or-range", limits: Object.fromEntries(schemas.WorkbookLimits.required.map((name) => [name, 1])) }
	assert.ok(accepts(schemas.PreviewProvider, provider, schemas))
	assert.equal(accepts(schemas.PreviewProvider, { ...provider, queryScope: "window" }, schemas), false)
	const query = { sheet: "sheet-0", mode: "stored", rowOffset: 0, rowLimit: 100, columnOffset: 0, columnLimit: 20, range: null, headerRows: [0], filter: "needle", sort: { column: 1, direction: "asc", mode: "number" } }
	assert.ok(accepts(schemas.WorkbookQuery, query, schemas))
	assert.equal(accepts(schemas.WorkbookQuery, { ...query, sort: { column: 1, direction: "asc", kind: "number" } }, schemas), false)
	assert.equal(accepts(schemas.WorkbookQuery, { ...query, columnLimit: 101 }, schemas), false)
	assert.equal(schemas.WorkbookQuery.properties.rowLimit.default, 100); assert.equal(schemas.WorkbookQuery.properties.columnLimit.default, 20)
	assert.equal(schemas.WorkbookExportRequest.properties.formulaHandling.default, "escaped-text")
	assert.ok(accepts(schemas.PreparationResponse, { filesContractVersion: 1, jobId: "job-1" }, schemas))
	assert.equal(accepts(schemas.PreparationResponse, { filesContractVersion: 1, representation: {} }, schemas), false)
})

test("workbook sheet contract requires sparse row evidence separately from declared dimensions", () => {
	const schemas = buildFilesSchemas(), sheet = { id: "sheet-0", name: "Dimensioned empty", ordinal: 0, visibility: "visible", kind: "worksheet", rows: 64, columns: 12, indexedRows: 0, storedRange: "A1:L64", populatedCells: 0, merges: [], modes: ["stored", "formula"], warnings: [] }
	assert.ok(accepts(schemas.WorkbookSheet, sheet, schemas))
	for (const name of ["indexedRows", "storedRange"]) { const missing = { ...sheet }; delete missing[name]; assert.equal(accepts(schemas.WorkbookSheet, missing, schemas), false, name) }
	assert.ok(accepts(schemas.WorkbookSheet, { ...sheet, kind: "unsupported", indexedRows: 0, storedRange: null }, schemas))
	for (const patch of [{ indexedRows: -1 }, { indexedRows: "0" }, { storedRange: 123 }]) assert.equal(accepts(schemas.WorkbookSheet, { ...sheet, ...patch }, schemas), false, JSON.stringify(patch))
})

test("shared workbook jobs publish optional request aliases as a typed ID array", () => {
	const schemas = buildFilesSchemas()
	const job = { filesContractVersion: 1, jobId: "shared-job", requestId: "primary-request", type: "preparation", preparationType: "workbook", state: "running", stage: "reading", progress: { bytesDone: 0, totalBytes: 100, elapsedMs: 1 }, result: null, error: null }
	assert.ok(accepts(schemas.FileJob, job, schemas), "aliases are optional")
	assert.ok(accepts(schemas.FileJob, { ...job, requestIds: ["primary-request", "secondary-request"] }, schemas))
	for (const requestIds of [null, "secondary-request", ["primary-request", 1], ["primary-request", "bad/id"], [""], ["a".repeat(129)]]) assert.equal(accepts(schemas.FileJob, { ...job, requestIds }, schemas), false, JSON.stringify(requestIds))
})

test("preview contract discriminates actual table, text, and detail envelopes and rejects incorrect fields", () => {
	const schemas = buildFilesSchemas(), parser = new FileSegments({ state: {}, limits: { cellCodePoints: 3, textWindowBytes: 4 } })
	parser.key = Buffer.alloc(32, 1)
	const source = { kind: "runtime-capture", ref: { workspaceId: "w", workspaceEpoch: "e", path: "a.csv" }, captureId: "capture-1", etag: '"capture-1"', sizeBytes: 20, consistency: "checked-copy", digest: { state: "not-requested", sha256: null } }
	const envelope = (request, bytes, position = { offset: 0, ordinal: 1 }, selectedSource = source) => {
		const input = parser.normalize(request)
		return parser.envelope(selectedSource, { ...input, position }, parseSegment({ bytes: Buffer.from(bytes), ...input, position, sourceEof: selectedSource.kind === "runtime-capture" || selectedSource.sourceEof }))
	}
	const table = envelope({ format: "csv", columnOffset: 1, columnLimit: 1 }, "id,longvalue\n")
	const header = envelope({ format: "tsv", operation: "header" }, "a\tb\n")
	const text = envelope({ format: "text" }, "abcdef")
	const detail = envelope({ format: "csv", operation: "detail" }, "id,longvalue\n", { offset: 0, ordinal: 1, column: 1, valueOffset: 2 })
	const fragment = { kind: "runtime-fragment", ref: source.ref, fragmentId: "fragment-1", etag: '"fragment-1"', byteStart: 0, byteEnd: 4, sourceSizeObserved: 20, sourceObservation: { ref: source.ref, token: "observed", observedAt: new Date().toISOString(), sizeBytes: 20 }, sourceMayHaveChanged: false, sourceEof: false, completeSource: false }
	const preview = { ...envelope({ format: "csv" }, "a,b\n", undefined, fragment), coverage: "fragment", lease: { leaseId: "lease-1", source: { kind: "fragment", id: "fragment-1" }, expiresAt: new Date().toISOString(), ttlSeconds: 300 } }
	for (const value of [table, header, text, detail, preview, envelope({ format: "csv" }, 'a,"unterminated')]) assert.ok(accepts(schemas.SegmentResponse, value, schemas), JSON.stringify(value))
	const invalid = [
		{ ...table, kind: "cell-detail" }, { ...table, operation: "detail" }, { ...table, format: "text" },
		{ ...table, columnOffset: -1 }, { ...table, columnLimit: 0 }, { ...table, observedColumns: "2" },
		{ ...table, rows: [{ ordinal: 1, cells: [{ column: -1, text: "x", clipped: true, detail: "opaque" }] }] },
		{ ...table, rows: [{ ordinal: 1, cells: [{ column: 1, text: "x", clipped: "yes", detail: 2 }] }] },
		{ ...table, rows: [{ ordinal: 1, cells: [{ column: 1, text: "x", clipped: true, detail: 2 }] }] },
		{ ...table, limits: { ...table.limits, displayCodepoints: "3" } }, { ...table, stopReason: "complete" },
		{ ...text, operation: "header" }, { ...detail, ordinal: 0 }, { ...detail, column: -1 }, { ...detail, text: 3 }, { ...detail, valueOffset: -1 }, { ...detail, valueEnd: "4" },
		{ ...preview, coverage: "complete" }, { ...preview, lease: { ...preview.lease, ttlSeconds: 0 } }, { ...preview, continuation: { kind: "full-source-query" } },
		{ ...table, warnings: [42] },
	]
	for (const value of invalid) assert.equal(accepts(schemas.SegmentResponse, value, schemas), false, JSON.stringify(value))
	for (const stopReason of ["eof", "row-limit", "text-limit", "read-budget", "response-budget", "time-budget", "fragment-end", "encoding-unavailable", "malformed-record"]) assert.ok(accepts(schemas.SegmentResponse, { ...table, stopReason }, schemas), stopReason)
})

test("OpenAPI exposes effective limits and resolves every local reference and path parameter", async () => {
	const { buildFilesOpenApi } = await import("../lib/files-openapi.js")
	const spec = buildFilesOpenApi({ serverUrl: "https://runtime.example", limits: { uploadBytes: 1234, pageMaxSize: 20 } })
	assert.equal(spec.servers[0].url, "https://runtime.example")
	assert.equal(spec.paths["/files/upload"].put.requestBody.content["application/octet-stream"].schema.maxLength, 1234)
	assert.equal(spec.paths["/files/list"].get.parameters.find((p) => p.name === "limit").schema.maximum, 20)
	const visit = (value) => {
		if (!value || typeof value !== "object") return
		if (value.$ref) {
			assert.ok(value.$ref.startsWith("#/"), value.$ref)
			let target = spec
			for (const key of value.$ref.slice(2).split("/")) target = target?.[key]
			assert.ok(target, `unresolved ${value.$ref}`)
		}
		for (const child of Object.values(value)) visit(child)
	}
	visit(spec)
	const ids = new Set()
	for (const [route, methods] of Object.entries(spec.paths)) for (const op of Object.values(methods)) {
		assert.ok(op.responses && Object.keys(op.responses).length)
		assert.ok(!ids.has(op.operationId), `duplicate operationId ${op.operationId}`)
		ids.add(op.operationId)
		for (const [, name] of route.matchAll(/\{(\w+)\}/g)) assert.ok(op.parameters.some((p) => p.name === name && p.in === "path" && p.required), `${route}: ${name}`)
	}
})

test("served OpenAPI is the generated contract and all documented routes enforce their allowed methods", async (t) => {
	const { buildFilesOpenApi } = await import("../lib/files-openapi.js")
	const files = new FilesApi({ info() { throw new Error("OpenAPI must not depend on file or agent readiness") }, limits: { pageMaxSize: 77 } }, { error() {} })
	const server = http.createServer(async (req, res) => { await files.handle(req, res, new URL(req.url, "http://files")) })
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	t.after(async () => { await files.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
	const base = `http://127.0.0.1:${server.address().port}`
	const response = await fetch(`${base}/files/openapi.json`)
	assert.equal(response.status, 200)
	const spec = await response.json()
	assert.deepEqual(spec, buildFilesOpenApi({ limits: { pageMaxSize: 77 } }))
	assert.equal((await fetch(`${base}/files/openapiXjson`)).status, 404, "route names match literally")
	for (const [route, methods] of Object.entries(spec.paths)) {
		const response = await fetch(`${base}${route.replace(/\{\w+\}/g, "id-1")}`, { method: "PATCH" })
		assert.equal(response.status, 405, route)
		assert.deepEqual(response.headers.get("allow").split(", ").sort(), Object.keys(methods).map((method) => method.toUpperCase()).sort())
	}
})
