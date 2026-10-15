import { pathToFileURL } from "node:url"
import { VOXEL_LIMITS } from "./voxels.js"
import { OUTCOMES } from "./voxel-agent-contract.js"

const ref = (name) => ({ $ref: `#/components/schemas/${name}` })
const string = { type: "string" }, boolean = { type: "boolean" }, number = { type: "number" }
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const timestamp = { type: "string", format: "date-time" }
const enumeration = (...values) => ({ type: "string", enum: values })
const constant = (value) => ({ type: typeof value, const: value })
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] })
const array = (items, options = {}) => ({ type: "array", items, ...options })
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false })
const union = (...names) => ({ oneOf: names.map(ref) })
const id = { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,128}$" }
const digest = { type: "string", pattern: "^[0-9a-f]{64}$" }
// JSON Schema maxLength counts code points; runtime limits count UTF-16 units.
const text = (max, empty = false) => ({ type: "string", minLength: empty ? 0 : 1, maxLength: max, "x-max-utf16-code-units": max, pattern: empty ? "^[^\\u0000]*$" : "^(?=[\\s\\S]*\\S)[^\\u0000]*$" })
const generation = { type: "string", minLength: 1, maxLength: 64, "x-max-utf16-code-units": 64 }
const vec3 = (items = number) => array(items, { minItems: 3, maxItems: 3 })
const shape = vec3({ ...integer, minimum: 1 }), positive = { ...number, exclusiveMinimum: 0 }
const units = enumeration("m", "ft", "us-ft")
const publication = enumeration("staging", "publishing", "ready", "unresolved", "failed")
const verification = enumeration("unchecked", "checking", "verified", "temporarily-unavailable", "integrity-blocked")
const phases = enumeration("accepted", "validating", "generating", "publishing", "associating", "ready", "failed")
const kinds = enumeration("table-to-voxel", "indexed-grid", "import-metadata")
const blocks = array(enumeration("publication", "publicationReconciliation", "publicationRecovery", "stagingCleanupReconciliation", "uploadRecovery", "hold", "lease", "reader", "indexReader", "unknownOwnership", "unknownBytes", "persistence", "persistenceEvidence", "persistenceTransfer"), { uniqueItems: true })
const counters = (names) => object(Object.fromEntries(names.map((name) => [name, integer])))
const valueRange = nullable(object({ min: number, max: number }))
const namedFields = { voxelId: id, name: text(256), headRevision: text(256), artifact: ref("ArtifactLink"), createdUtc: timestamp, updatedUtc: timestamp }
const diagnostics = { scanComplete: boolean, blockingErrors: array(string), issues: array(ref("IndexedIssue"), { maxItems: 25 }), warnings: array(string) }

/** Self-contained combined wire schemas. Private agent transport is not a route. */
export function buildVoxelsSchemas() {
	const deletion = { id, workspaceEpoch: string, artifactId: id, generation, requestedUtc: timestamp, requester: object({ transport: string }), access: constant("closed"), logicalDeletion: constant(true), holdsReleased: boolean, cleanupPending: boolean, reclaimedBytes: integer, blockers: blocks, indeterminate: boolean, holdReleaseUtc: timestamp, updatedUtc: timestamp }
	const deletionRequired = Object.keys(deletion).filter((k) => !["holdReleaseUtc", "updatedUtc"].includes(k))
	const indexed = { schemaVersion: constant(1), algorithm: constant("geocluster-indexed-v1"), name: text(256), scope: ref("Scope"), indices: ref("Indices"), shape, placement: ref("Placement"), field: ref("IndexedField"), numbers: ref("Numbers"), emptyCells: enumeration("forbid", "allow"), predecessor: ref("Predecessor") }
	return {
		SourceRevision: { ...object({ root: constant("workspace"), resourceId: text(4096), path: text(4096), revision: { type: "string", pattern: "^capture:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$" }, sha256: digest }), description: "Complete capture in the current workspace epoch. resourceId equals canonical relative path; stored path and digest must match. Current bytes never substitute." },
		Range: { ...object({ rowStart: integer, rowEnd: integer, columnStart: integer, columnEnd: integer }), description: "Inclusive absolute zero-based coordinates; ends must be at least starts." },
		DelimitedInput: object({ type: constant("delimited"), resourceId: text(4096), source: ref("SourceRevision"), delimiter: enumeration(",", "\t") }),
		WorkbookInput: object({ type: constant("workbook"), resourceId: text(4096), source: ref("SourceRevision"), workbookId: text(128), sheet: text(128) }),
		TableInput: union("DelimitedInput", "WorkbookInput"),
		Scope: object({ input: ref("TableInput"), range: ref("Range"), headerRows: array(integer, { maxItems: 32, uniqueItems: true }) }),
		Predecessor: nullable(object({ artifactId: text(128), generation: text(64) })),
		ColumnOrConstant: { oneOf: [object({ type: constant("column"), column: integer }), object({ type: constant("constant"), value: number })] },
		ZMeaning: { oneOf: [object({ type: constant("elevation") }), object({ type: constant("depth-below-plane"), planeName: text(256), planeElevation: number })] },
		Geometry: { oneOf: [object({ mode: constant("points"), x: integer, y: integer, z: integer, zMeaning: ref("ZMeaning") }), object({ mode: constant("segments"), start: vec3(integer), end: vec3(integer), zMeaning: ref("ZMeaning") }), object({ mode: constant("vertical-intervals"), collarX: ref("ColumnOrConstant"), collarY: ref("ColumnOrConstant"), collarElevation: ref("ColumnOrConstant"), from: integer, to: integer, depthUnit: units, collarElevationUnit: units, holeId: integer, sharedCollar: boolean }, ["mode", "collarX", "collarY", "collarElevation", "from", "to", "depthUnit", "collarElevationUnit"]) ] },
		Horizontal: { oneOf: [object({ type: constant("local"), name: text(256) }), object({ type: constant("crs"), crs: text(256) }), object({ type: constant("geographic"), crs: text(256), targetCrs: text(256) })] },
		Reference: object({ horizontal: ref("Horizontal"), horizontalUnit: units, verticalUnit: units, verticalReference: text(256) }),
		Value: { oneOf: [object({ kind: constant("numeric"), column: integer, name: text(256), unit: text(64, true), aggregation: enumeration("mean", "min", "max") }), object({ kind: constant("categorical"), column: integer, name: text(256), trim: boolean })] },
		Numbers: { ...object({ decimal: enumeration(".", ","), thousands: enumeration("none", ",", ".", " ", "'"), missingTokens: array(text(64), { maxItems: 32 }), sentinels: array(number, { maxItems: 32 }), censored: enumeration("exclude", "limit", "half-limit") }), description: "Decimal and thousands marks must differ." },
		Predicate: { oneOf: [object({ type: constant("equals"), column: integer, value: text(1024, true), trim: boolean }), object({ type: constant("range"), column: integer, min: nullable(number), max: nullable(number) })] },
		RecipeGrid: object({ spacing: vec3(positive), extent: { oneOf: [object({ type: constant("auto") }), object({ type: constant("custom"), origin: vec3(), shape, acceptClipping: boolean })] } }),
		TableRecipe: object({ schemaVersion: constant(1), algorithm: constant("geocluster-binning-v1"), name: text(256), scope: ref("Scope"), geometry: ref("Geometry"), reference: ref("Reference"), value: ref("Value"), numbers: ref("Numbers"), predicates: array(ref("Predicate"), { maxItems: 16 }), grid: ref("RecipeGrid"), predecessor: ref("Predecessor") }),
		HorizontalReference: { oneOf: [object({ type: constant("unreferenced"), definition: constant("") }), object({ type: enumeration("crs", "local"), definition: text(256) })] },
		Placement: { ...object({ origin: vec3(), spacing: vec3(positive), unit: enumeration("m", "ft", "grid-unit"), horizontalReference: ref("HorizontalReference"), verticalReference: nullable(text(256)) }), description: "grid-unit requires unreferenced horizontal and null vertical reference; physical units require both references." },
		Indices: object({ x: integer, y: integer, z: integer, base: { type: "integer", enum: [0, 1] } }),
		IndexedField: { oneOf: [object({ kind: constant("numeric"), column: integer, name: text(256), unit: text(64, true) }), object({ kind: constant("categorical"), column: integer, name: text(256), trim: boolean })] },
		IndexedRecipe: object(indexed),
		SpatialMetadata: object({ axisOrder: vec3({ ...integer, maximum: 2 }), reversed: vec3(boolean), indexOrigin: vec3(), spacing: vec3(positive), unit: enumeration("m", "ft", "grid-unit"), horizontalReference: ref("HorizontalReference"), verticalReference: nullable(text(256)), fieldName: text(256), fieldUnit: text(64, true), sentinel: nullable(number) }),
		ImportRecipe: object({ schemaVersion: constant(1), source: ref("SourceRevision"), metadata: ref("SpatialMetadata"), defaults: array(enumeration("axisOrder", "reversed", "indexOrigin", "spacing", "unit", "horizontalReference", "verticalReference", "fieldName", "fieldUnit", "sentinel"), { uniqueItems: true }), predecessor: ref("Predecessor") }),
		ArtifactLink: object({ artifactId: { type: "string", pattern: "^vox-[A-Za-z0-9-]{1,120}$" }, generation: digest, manifest: ref("SourceRevision") }),
		RevisionTarget: nullable(object({ voxelId: id, expectedHeadRevision: text(256), base: ref("ArtifactLink") })),
		// Runtime accepts omitted revision as separate creation; canonical clients send null.
		Submission: { oneOf: [["table-to-voxel", "TableRecipe"], ["indexed-grid", "IndexedRecipe"], ["import-metadata", "ImportRecipe"]].map(([kind, recipe]) => object({ kind: constant(kind), recipe: ref(recipe), revision: ref("RevisionTarget") }, ["kind", "recipe"])) },
		ManifestRecipe: { oneOf: [["table-to-voxel", "TableRecipe"], ["indexed-grid", "IndexedRecipe"], ["imported-volume", "ImportRecipe"]].map(([type, recipe]) => object({ type: constant(type), recipe: ref(recipe) })) },
		DescribeRequest: object({ action: constant("describe"), input: ref("TableInput"), range: nullable(ref("Range")), headerRows: array(integer, { maxItems: 32, uniqueItems: true }) }),
		ValidateRequest: { oneOf: [object({ action: constant("validate"), submission: ref("Submission") }), object({ action: constant("validate"), recipe: union("TableRecipe", "IndexedRecipe") })] },
		ScanIndicesRequest: object({ action: constant("scan-indices"), scope: ref("Scope"), indices: ref("Indices"), numbers: ref("Numbers") }),
		SubmitRequest: object({ action: constant("submit"), submission: ref("Submission"), idempotencyKey: id }),
		NamedListRequest: object({ action: constant("named-list"), limit: { ...integer, minimum: 1, maximum: 100 }, cursor: nullable(text(2048)), name: nullable(text(256)) }),
		NamedResolveRequest: { oneOf: [object({ action: constant("named-resolve"), voxelId: id }), object({ action: constant("named-resolve"), name: text(256) })] },
		RenameRequest: object({ action: constant("rename"), voxelId: id, name: text(256), expectedHeadRevision: text(256) }),
		InspectOptions: object({ indices: array(vec3(integer), { maxItems: 256 }), region: object({ min: vec3(integer), max: vec3(integer) }), limit: { ...integer, minimum: 1, maximum: 256 }, categoryLimit: { ...integer, minimum: 1, maximum: 256 } }, []),
		CellEdit: { oneOf: [object({ index: vec3(integer), valid: constant(false) }), object({ index: vec3(integer), valid: constant(true), value: { oneOf: [number, { ...ref("CategoryLabel") }] } })] },
		MaterializeOptions: object({ edits: array(ref("CellEdit"), { maxItems: 256 }) }, []),
		InspectRequest: object({ action: constant("inspect"), artifact: ref("ArtifactLink"), options: ref("InspectOptions") }),
		MaterializeRequest: object({ action: constant("materialize"), artifact: ref("ArtifactLink"), options: ref("MaterializeOptions") }),
		ResolveManifestRequest: object({ action: constant("resolve-manifest"), source: ref("SourceRevision") }),
		VoxelRequest: union("DescribeRequest", "ValidateRequest", "ScanIndicesRequest", "SubmitRequest", "NamedListRequest", "NamedResolveRequest", "RenameRequest", "InspectRequest", "MaterializeRequest", "ResolveManifestRequest"),
		Description: object({ scope: ref("Scope"), rows: integer, columns: integer, headers: array(object({ column: integer, label: string })), sample: array(object({ row: integer, cells: array(string) }), { maxItems: 8 }), parser: string, warnings: array(string) }),
		Bounds: object({ min: vec3(), max: vec3() }),
		Statistics: object({ ...counters(["rows", "acceptedRows", "excludedRows", "occupiedCells", "duplicatePositions", "categoryTies", "censoredSubstitutions", "formulaCacheValues"]).properties, exclusions: { type: "object", additionalProperties: integer }, secondaryExclusions: { type: "object", additionalProperties: integer }, valueRange, clipping: nullable(object({ outsidePoints: integer, fullyOutsideSegments: integer, partiallyClippedSegments: integer, retainedLength: number, removedLength: number })), bounds: nullable(ref("Bounds")) }),
		IndexedSummary: counters(["inputRows", "suppliedUniqueCells", "absentRecordCells", "emptySuppliedValueCells", "validCells", "duplicateCellGroups"]),
		IndexedStatistics: object({ ...counters(["inputRows", "suppliedUniqueCells", "absentRecordCells", "emptySuppliedValueCells", "validCells", "duplicateCellGroups", "censoredSubstitutions", "formulaCacheValues"]).properties, valueRange }),
		Grid: object({ shape, origin: vec3(), spacing: vec3(positive), axes: enumeration("easting,northing,elevation", "x,y,z"), order: constant("C-z-fastest"), unit: enumeration("m", "ft", "grid-unit"), horizontalReference: ref("HorizontalReference"), verticalReference: nullable(string) }),
		CategoryLabel: { type: "string", minLength: 1, maxLength: 1024, "x-max-utf16-code-units": 1024 },
		Category: object({ code: integer, label: ref("CategoryLabel") }),
		Field: { oneOf: [object({ kind: constant("numeric"), name: string, unit: string }), object({ kind: constant("categorical"), name: string, unit: constant(""), categories: array(ref("Category"), { minItems: 1, maxItems: 65536 }) })] },
		Estimate: counters(["cells", "arrayBytes", "computeBytes", "displayBytes"]),
		Validation: object({ statistics: ref("Statistics"), grid: nullable(ref("Grid")), field: nullable(ref("Field")), parsers: array(string), suggestedSpacing: nullable(vec3()), estimate: nullable(ref("Estimate")), examples: array(object({ row: integer, positions: array(vec3()), value: { type: ["number", "string"] }, clipped: boolean })), issues: array(object({ row: integer, reason: string, detail: string })), categories: array(ref("CategoryLabel"), { maxItems: 65536 }), warnings: array(string), errors: array(string), recipeFingerprint: digest, sourceRevisions: array(ref("SourceRevision")) }),
		IndexedIssue: object({ kind: string, fieldId: string, rows: array(integer), message: string }, ["kind", "rows", "message"]),
		IndexScan: object({ ...diagnostics, suggestedShape: nullable(shape), summary: counters(["inputRows", "suppliedUniqueCells", "duplicateCellGroups"]), parsers: array(string), sourceRevisions: array(ref("SourceRevision")) }),
		IndexedValidation: object({ ...diagnostics, grid: ref("Grid"), estimate: nullable(ref("Estimate")), field: nullable(ref("Field")), parsers: array(string), summary: ref("IndexedSummary"), statistics: nullable(ref("IndexedStatistics")), categoryPreview: nullable(object({ count: integer, labels: array(ref("CategoryLabel"), { maxItems: 32 }) })), recipeFingerprint: digest, sourceRevisions: array(ref("SourceRevision")) }),
		ImportValidation: object({ grid: ref("Grid"), field: ref("Field"), statistics: ref("Statistics"), warnings: array(string), parsers: array(string), errors: array(string), recipeFingerprint: digest, sourceRevisions: array(ref("SourceRevision")) }),
		ValidationResponse: union("Validation", "IndexedValidation", "ImportValidation"),
		VerificationError: object({ error: string, classification: enumeration("integrity", "transient"), message: string }),
		Availability: { ...object({ state: enumeration("deleted", "recovery-pending", "staging", "publishing", "unresolved", "failed", "unchecked", "checking", "verified", "temporarily-unavailable", "integrity-blocked"), publicationState: publication, verificationState: verification, retryAt: nullable(timestamp), error: nullable(ref("VerificationError")) }), description: "Derived in order: deletion, recovery-pending, non-ready publication, verification. It is not a fourth independent lifecycle." },
		NamedRecord: object({ ...namedFields, scope: ref("WorkspaceScope"), availability: ref("Availability") }),
		NamedOutcome: { oneOf: [object({ outcome: constant("committed"), ...namedFields }), object({ outcome: enumeration("unknown", "conflict", "failed"), voxelId: id, name: text(256), reason: string, reasonCode: string }, ["outcome", "voxelId", "name"])] },
		NamedResponse: object({ voxel: ref("NamedRecord") }),
		NamedList: object({ voxels: array(ref("NamedRecord"), { maxItems: 100 }), cursor: nullable(text(2048)) }),
		OperationError: object({ phase: phases, message: string, error: string, status: { type: "integer", minimum: 400, maximum: 599 }, requiredBytes: integer, availableBytes: integer, action: string, limits: { type: "object" } }, ["phase", "message"]),
		Operation: object({ id, kind: kinds, submission: ref("Submission"), named: ref("NamedOutcome"), recipeFingerprint: digest, sourceRevisions: array(ref("SourceRevision")), phase: phases, detail: string, acceptedUtc: timestamp, updatedUtc: timestamp, artifact: nullable(ref("ArtifactLink")), error: nullable(ref("OperationError")), statistics: nullable(union("Statistics", "IndexedStatistics")), contentionWaitRemainingMs: integer, contentionWaitUsedMs: integer, waitingFor: nullable(enumeration("workbook", "mutation", "artifactVerification")), retryAt: nullable(timestamp), contentionWaitStartedUtc: nullable(timestamp), availability: ref("Availability") }, ["id", "kind", "submission", "named", "recipeFingerprint", "sourceRevisions", "phase", "detail", "acceptedUtc", "updatedUtc", "artifact", "error", "statistics", "contentionWaitRemainingMs", "contentionWaitUsedMs", "waitingFor", "retryAt"]),
		OperationResponse: object({ operation: ref("Operation") }),
		OperationsResponse: object({ operations: array(ref("Operation")) }),
		ArtifactDeleteRequest: object({ generation, idempotencyKey: id }),
		Deletion: object(deletion, deletionRequired),
		PendingDeletionResponse: object({ deletion: object({ ...deletion, cleanupPending: constant(true) }, deletionRequired) }),
		CompletedDeletionResponse: object({ deletion: object({ ...deletion, cleanupPending: constant(false) }, deletionRequired) }),
		Artifact: object({ artifactId: id, generation, createdUtc: timestamp, operationId: id, link: nullable(ref("ArtifactLink")), publicationState: publication, verificationState: verification, availability: ref("Availability"), deletion: nullable(ref("Deletion")), ownedBytes: integer, reservedBytes: integer, cleanupPendingBytes: integer, reclaimedStagingBytes: integer, retentionBlockers: blocks }),
		ArtifactResponse: object({ artifact: ref("Artifact") }),
		ManifestResolution: { ...object({ artifact: ref("Artifact"), voxel: nullable(ref("NamedRecord")) }), description: "The registered version these exact file bytes hold. voxel is the named voxel whose current version it is, or null." },
		ArtifactInventory: object({ artifacts: array(ref("Artifact"), { maxItems: 100 }), nextCursor: nullable({ type: "string", pattern: "^[A-Za-z0-9_-]{1,512}$" }) }),
		SourceAvailability: object({ source: ref("SourceRevision"), state: enumeration("available", "unavailable", "integrity-blocked"), retryAfter: integer }, ["source", "state"]),
		Inspection: object({ artifact: ref("ArtifactLink"), integrity: constant("verified"), grid: ref("Grid"), field: object({ kind: enumeration("numeric", "categorical"), name: string, unit: string }), recipe: ref("ManifestRecipe"), sourceRevisions: array(ref("SourceRevision")), sourceAvailability: array(ref("SourceAvailability")), statistics: union("Statistics", "IndexedStatistics"), warnings: array(string), categoryDictionary: nullable(object({ count: integer, categories: array(ref("Category"), { maxItems: 256 }), truncated: boolean })), cells: array(object({ index: vec3(integer), valid: boolean, value: { type: ["null", "number", "string"] }, center: vec3() }), { maxItems: 256 }), requestedCells: integer, truncated: boolean }),
		Manifest: object({ format: constant("geocluster-voxel"), schemaVersion: constant(1), artifactId: { type: "string", pattern: "^vox-[A-Za-z0-9-]{1,120}$" }, generation: digest, predecessor: ref("Predecessor"), projectId: string, operationId: nullable(string), createdUtc: timestamp, creation: object({ mode: enumeration("binned-observations", "imported-volume", "imported-grid"), label: string, algorithm: string, boundaryPolicy: string, accumulation: string, parsers: array(string), executionProfile: string }), sourceRevisions: array(ref("SourceRevision"), { minItems: 1 }), grid: ref("Grid"), field: ref("Field"), arrays: array(object({ role: enumeration("values", "valid", "counts", "weights"), dtype: enumeration("<f8", "<u4", "|u1"), contentId: string, sha256: digest, byteLength: integer }), { minItems: 2, maxItems: 4 }), recipe: ref("ManifestRecipe"), statistics: union("Statistics", "IndexedStatistics"), warnings: array(string), assumptions: array(string) }),
		ReplacementRecipe: { ...object({ ...indexed, scope: object({ input: { type: "null" }, range: ref("Range"), headerRows: array(integer, { maxItems: 32, uniqueItems: true }) }) }), description: "Unbound full replacement template, not a submittable IndexedRecipe. Capture csv and replace input before submission. base, separately, is the complete registered link." },
		Materialization: object({ complete: constant(true), integrity: constant("verified"), base: ref("ArtifactLink"), csv: string, rows: integer, byteLength: integer, recipe: ref("ReplacementRecipe") }),
		WorkspaceScope: object({ workspaceId: text(128), workspaceEpoch: text(128) }),
		AgentReference: object({ schemaVersion: constant(1), scope: ref("WorkspaceScope"), operationId: text(128), artifact: nullable(ref("ArtifactLink")), named: object({ voxelId: text(128), name: text(256), headRevision: nullable(text(256)) }), outcome: enumeration(...OUTCOMES), summary: object({ name: text(256), shape, validCells: integer }, ["name"]) }, ["schemaVersion", "scope", "operationId", "artifact", "outcome", "summary"]),
		AgentReferences: object({ references: array(ref("AgentReference"), { maxItems: 16 }) }),
		Retention: { anyOf: [object({ state: constant("initializing") }), object({ ...counters(["retainedBytes", "reservedBytes", "unresolvedBytes", "totalBytes", "cleanupPendingBytes", "stagingCleanupUncertainty", "artifactRetainedBytes", "artifactFreeBytes", "sharedRetainedBytes", "sharedUsedBytes", "sharedFreeBytes"]).properties, overArtifactBudget: boolean })] },
		Gauges: object({ ...counters(["admittedRuns", "activeNumericalWorkers", "lazyVerificationQueue", "recoveryVerificationQueue", "recoveryRetryWaiters", "activeVerifications", "queuedExtraction", "activeExtraction", "mutationWaiters"]).properties, workerKinds: array(enumeration("describe", "compute", "import", "verify", "indexed-grid", "scan-indices", "inspect-artifact", "materialize-artifact")) }),
		VoxelCapabilities: object({ available: boolean, reason: string, service: constant("runtime-voxel-v1"), sourceProfiles: array(enumeration("csv", "tsv", "npy", "workbook-stored")), transforms: array(string, { maxItems: 0 }), algorithms: array(enumeration("geocluster-binning-v1", "geocluster-indexed-v1")), intents: array(kinds), namedVoxels: boolean, artifactInspection: boolean, manifestResolution: boolean, ceilings: object({ ...Object.fromEntries(Object.entries(VOXEL_LIMITS).map(([key, value]) => [key, { ...integer, minimum: 1, default: value }])), sharedRetainedBytes: { ...integer, minimum: 1 } }), limitUnits: object(Object.fromEntries(Object.keys(VOXEL_LIMITS).map((key) => [key, constant(key.endsWith("Bytes") ? "bytes" : key.endsWith("Ms") ? "milliseconds" : key.endsWith("MiB") ? "MiB" : "count")]))), publication: boolean, retention: ref("Retention"), gauges: ref("Gauges") }),
		VoxelError: { ...object({ error: string, reason: string, message: string, agent: string, tool: string, action: string, availability: ref("Availability"), retryAfter: integer, retryAt: timestamp, requiredBytes: integer, availableBytes: integer, limits: { type: "object" } }, ["error", "message", "agent", "tool", "action"]), additionalProperties: true, description: "Voxel-handler errors include reason; outer authentication/file errors can omit it. Preserve provider diagnostics and retry evidence." },
	}
}

const query = (name, schema, description) => ({ name, in: "query", schema, description, required: false })
const pathId = (name) => ({ name, in: "path", required: true, schema: id })
const json = (name) => ({ "application/json": { schema: ref(name) } })
const retry = { "Retry-After": { schema: { type: "string", pattern: "^[1-9][0-9]*$" }, description: "Seconds before another read/admission attempt; preserve through relay. Accepted cleanup continues without client retries." } }

/** Pure export: the parent daemon owns schema route registration. */
export function buildVoxelsOpenApi({ serverUrl = "/" } = {}) {
	const routes = [
		["get", "/voxels", "voxelCapabilitiesOrDiscovery", "Capabilities or retained-key/source discovery", { parameters: [query("resourceId", text(4096), "Canonical path; mutually exclusive with idempotencyKey."), query("idempotencyKey", id, "Zero or one receipt; mutually exclusive with resourceId.")], responses: { 200: { description: "Capabilities or operations.", content: { "application/json": { schema: union("VoxelCapabilities", "OperationsResponse") } } } } }],
		["post", "/voxels", "voxelAction", "Strict captured-source action dispatcher", { body: "VoxelRequest", responses: { 200: { description: "Action result or terminal submission replay.", content: { "application/json": { schema: union("Description", "Validation", "IndexedValidation", "ImportValidation", "IndexScan", "OperationResponse", "NamedList", "NamedResponse", "Inspection", "Materialization", "ManifestResolution") } } }, 202: { description: "Accepted submission or nonterminal replay.", content: json("OperationResponse") } } }],
		["get", "/voxels/operations/{id}", "voxelOperation", "Historical receipt and current availability", { parameters: [pathId("id")], schema: "OperationResponse" }],
		["get", "/voxels/member", "voxelMember", "Complete captured bytes or verified registered array", { parameters: [query("source", string, "JSON SourceRevision; used alone."), query("manifest", string, "JSON canonical registered manifest SourceRevision; used only with role."), query("role", enumeration("values", "valid", "counts", "weights"), "Requires manifest.")], responses: { 200: { description: "Complete bytes; no range, HEAD, conditional response or ETag contract.", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } } } }],
		["get", "/voxels/named", "voxelNamedList", "Bounded logical discovery", { parameters: [query("limit", { ...integer, minimum: 1, maximum: 100, default: 25 }, "Canonical positive decimal."), query("cursor", text(2048), "Opaque workspace/epoch/name-bound cursor."), query("name", text(256), "Exact name filter.")], schema: "NamedList" }],
		["get", "/voxels/named/{id}", "voxelNamedResolve", "Authoritative head and derived availability", { parameters: [pathId("id")], schema: "NamedResponse" }],
		["get", "/voxels/artifacts", "voxelArtifactInventory", "Registry inventory including tombstones", { parameters: [query("cursor", { type: "string", pattern: "^[A-Za-z0-9_-]{1,512}$" }, "Opaque epoch-bound artifact cursor; not a snapshot."), query("limit", { ...integer, minimum: 1, maximum: 100, default: 50 }, "Canonical positive decimal.")], schema: "ArtifactInventory" }],
		["get", "/voxels/artifacts/{artifactId}", "voxelArtifact", "Metadata and retention without full verification", { parameters: [pathId("artifactId"), query("generation", generation, "Optional exact binding; requires manifest, exactly once."), query("manifest", string, "Optional JSON SourceRevision; requires generation, exactly once; must equal registered capture.")], schema: "ArtifactResponse" }],
		["delete", "/voxels/artifacts/{artifactId}", "voxelArtifactDelete", "Durably close exact registered access and clean owned bytes", { parameters: [pathId("artifactId")], body: "ArtifactDeleteRequest", responses: { 200: { description: "Cleanup settled; reclaimedBytes is observed physical reclamation.", content: json("CompletedDeletionResponse") }, 202: { description: "Durable deletion accepted, including active publication/recovery. Access closed; blockers describe pending cleanup. Does not cancel accepted computation or veto current named heads.", content: json("PendingDeletionResponse") } } }],
	]
	const paths = {}
	for (const [method, route, operationId, summary, options] of routes) {
		const parameters = [...(options.parameters || []), ...["X-GC-Workspace-ID", "X-GC-Workspace-Epoch"].map((name) => ({ name, in: "header", required: false, schema: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" }, description: "Backend dispatch requires both exactly once, matching retained workspace identity before Origin, parsing, admission or effects. Direct-development clients may omit both." }))]
		if (["post", "delete"].includes(method)) parameters.push({ name: "Origin", in: "header", required: false, schema: string, description: "If supplied, one canonical allowed HTTP(S) origin. Repeated/malformed/disallowed values reject. Authenticated clients may omit." })
		const responses = options.responses || { 200: { description: "Successful read.", content: json(options.schema) } }
		for (const status of [400, 401, 403, 404, 405, 408, 409, 410, 413, 415, 422, 429, 500, 503, 507]) responses[status] = { description: status === 503 ? "Verification/recovery pending, transient storage/provider failure or drain; preserve retry evidence." : "Rejected request; inspect diagnostic code and retained receipts.", content: json("VoxelError"), ...([409, 429, 503].includes(status) ? { headers: retry } : {}) }
		paths[route] ||= {}
		paths[route][method] = { operationId, summary, parameters, responses, ...(options.body ? { requestBody: { required: true, description: "Strict UTF-8 JSON object, at most 65536 encoded bytes. No query parameters.", content: json(options.body) } } : {}) }
	}
	return { openapi: "3.1.0", "x-voxels-contract-version": 1, info: { title: "Runtime voxel API", version: "runtime-voxel-v1", description: "Combined runtime-owned method/action/domain contract. No private control or agent socket routes are relayable. Reject unsupported, empty, repeated or partial query bindings. JSON Schema requires semantic supplementation for exact binding equality, derived availability, ordered bounds, shape products and UTF-16 limits. Live ceilings come from GET /voxels." }, servers: [{ url: serverUrl }], paths, components: { schemas: buildVoxelsSchemas() } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(`${JSON.stringify(buildVoxelsOpenApi(), null, 2)}\n`)
