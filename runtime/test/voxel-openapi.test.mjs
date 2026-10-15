import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import { after, test } from "node:test"
import { fixture, indexed, target, until } from "./voxel-fixture.mjs"
import { encodeNpy } from "../lib/voxel/npy.js"
import { createVoxelAgentBridge } from "../lib/voxel-agent.js"
import { createVoxelAgentReferences } from "../lib/voxel-agent-references.js"

const fixtures = []
const observed = (name, body) => fixtures.push({ name, body: structuredClone(body) })
// Explicit fixture generation is opt-in; ordinary test runs create no files.
after(async () => {
	if (!process.env.VOXEL_CONTRACT_FIXTURES) return
	const { buildVoxelsOpenApi } = await import("../lib/voxels-openapi.js")
	const schemaSha256 = crypto.createHash("sha256").update(JSON.stringify(buildVoxelsOpenApi()) + "\n").digest("hex")
	await fs.writeFile(process.env.VOXEL_CONTRACT_FIXTURES, JSON.stringify({ schemaSha256, fixtures }, null, 2) + "\n")
})

// Small dependency-free JSON Schema fixture checker. UTF-16 is a runtime
// boundary in addition to JSON Schema's code-point string length.
export function accepts(s, v, schemas) {
	assert.ok(s, "Referenced schema exists")
	if (s.$ref) return accepts(schemas[s.$ref.split("/").at(-1)], v, schemas)
	if (s.oneOf && s.oneOf.filter((b) => accepts(b, v, schemas)).length !== 1) return false
	if (s.anyOf && !s.anyOf.some((b) => accepts(b, v, schemas))) return false
	if ("const" in s && s.const !== v || s.enum && !s.enum.includes(v)) return false
	if (Array.isArray(s.type)) return s.type.some((type) => accepts({ ...s, type }, v, schemas))
	if (s.type === "null") return v === null
	if (s.type === "boolean") return typeof v === "boolean"
	if (s.type === "string") return typeof v === "string" && [...v].length >= (s.minLength ?? 0) && [...v].length <= (s.maxLength ?? Infinity) && v.length <= (s["x-max-utf16-code-units"] ?? Infinity) && (!s.pattern || new RegExp(s.pattern, "u").test(v))
	if (["integer", "number"].includes(s.type)) return typeof v === "number" && Number.isFinite(v) && (s.type !== "integer" || Number.isSafeInteger(v)) && v >= (s.minimum ?? -Infinity) && v <= (s.maximum ?? Infinity) && v > (s.exclusiveMinimum ?? -Infinity)
	if (s.type === "array") return Array.isArray(v) && v.length >= (s.minItems ?? 0) && v.length <= (s.maxItems ?? Infinity) && (!s.uniqueItems || new Set(v.map((x) => JSON.stringify(x))).size === v.length) && v.every((x) => accepts(s.items, x, schemas))
	if (s.type === "object") return v !== null && typeof v === "object" && !Array.isArray(v) && !(s.required || []).some((k) => !Object.hasOwn(v, k)) && Object.entries(v).every(([k, x]) => s.properties?.[k] ? accepts(s.properties[k], x, schemas) : s.additionalProperties !== false && (typeof s.additionalProperties !== "object" || accepts(s.additionalProperties, x, schemas)))
	return true
}

test("combined contract validates every dispatcher action and three actual producer receipts", async (t) => {
	const { buildVoxelsOpenApi } = await import("../lib/voxels-openapi.js")
	const schemas = buildVoxelsOpenApi().components.schemas, f = await fixture(t, { voxelCheckpoint: async (stage) => {
		if (stage !== "reserved") return
		const inventory = await f.service.artifacts({}); assert.ok(accepts(schemas.ArtifactInventory, inventory, schemas)); assert.ok(inventory.artifacts.some(a => a.link === null && a.availability.state === "staging")); observed("ArtifactInventory", inventory)
	} })
	const check = (name, body) => { assert.ok(accepts(schemas[name], body, schemas), `${name}: ${JSON.stringify(body)}`); observed(name, body) }
	const post = async (body, name) => { check("VoxelRequest", body); const res = await f.request("/voxels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); assert.ok([200, 202].includes(res.status)); const wire = await res.json(); check(name, wire); return wire }
	check("VoxelCapabilities", await (await f.request("/voxels")).json())
	const source = await f.capture(), recipe = indexed(source)
	await post({ action: "describe", ...recipe.scope }, "Description")
	await post({ action: "scan-indices", scope: recipe.scope, indices: recipe.indices, numbers: recipe.numbers }, "IndexScan")
	const intents = [{ kind: "indexed-grid", recipe, revision: null }]
	const numeric = await f.capture("numeric.csv", "x,y,z,value\n0,0,0,0\n1,0,0,-2\n")
	intents.push({ kind: "table-to-voxel", revision: null, recipe: { schemaVersion: 1, algorithm: "geocluster-binning-v1", name: "Observations", scope: indexed(numeric).scope, geometry: { mode: "points", x: 0, y: 1, z: 2, zMeaning: { type: "elevation" } }, reference: { horizontal: { type: "local", name: "test" }, horizontalUnit: "m", verticalUnit: "m", verticalReference: "plane" }, value: { kind: "numeric", column: 3, name: "Value", unit: "", aggregation: "mean" }, numbers: recipe.numbers, predicates: [], grid: { spacing: [1, 1, 1], extent: { type: "auto" } }, predecessor: null } })
	const npy = await f.capture("volume.npy", encodeNpy(new Float64Array([0, -2]), [2, 1, 1]))
	intents.push({ kind: "import-metadata", revision: null, recipe: { schemaVersion: 1, source: npy, metadata: { axisOrder: [0, 1, 2], reversed: [false, false, false], indexOrigin: [0, 0, 0], spacing: [1, 1, 1], unit: "grid-unit", horizontalReference: { type: "unreferenced", definition: "" }, verticalReference: null, fieldName: "NPY", fieldUnit: "", sentinel: null }, defaults: [], predecessor: null } })
	const ready = []
	const bridge = createVoxelAgentBridge(f.service, { captureSource: () => { throw new Error("Not used by status") }, saveReplacement: () => { throw new Error("Not used by status") }, references: createVoxelAgentReferences(f.workspace) })
	for (const [n, submission] of intents.entries()) {
		await post({ action: "validate", submission }, "ValidationResponse")
		const accepted = await post({ action: "submit", submission, idempotencyKey: `contract-${n}` }, "OperationResponse")
		const op = await f.settled(accepted.operation.id); assert.equal(op.phase, "ready"); check("OperationResponse", { operation: op }); ready.push(op)
		check("Manifest", (await f.artifact(op)).manifest)
		const result = await bridge.dispatch({ action: "status", scope: f.workspace.identity, conversationId: "ses_Contract", operationId: op.id }); check("AgentReference", result.geoclusterVoxel)
	}
	check("AgentReferences", await bridge.dispatch({ action: "references", scope: f.workspace.identity, conversationId: "ses_Contract" }))
	await post({ action: "validate", recipe }, "IndexedValidation")
	const op = ready[0], head = await f.service.namedResolve({ voxelId: op.named.voxelId })
	check("NamedResponse", { voxel: head })
	await post({ action: "named-list", limit: 10, cursor: null, name: null }, "NamedList")
	await post({ action: "named-resolve", voxelId: head.voxelId }, "NamedResponse")
	await post({ action: "named-resolve", name: head.name }, "NamedResponse")
	await post({ action: "rename", voxelId: head.voxelId, expectedHeadRevision: head.headRevision, name: "Renamed" }, "NamedResponse")
	await post({ action: "inspect", artifact: op.artifact, options: { indices: [[0, 0, 0]], categoryLimit: 1 } }, "Inspection")
	await post({ action: "materialize", artifact: op.artifact, options: { edits: [{ index: [0, 0, 0], valid: true, value: "😀".repeat(512) }] } }, "Materialization")
	await post({ action: "resolve-manifest", source: op.artifact.manifest }, "ManifestResolution")
	const current = await f.service.namedResolve({ voxelId: head.voxelId })
	for (const [n, intent] of intents.entries()) {
		const submission = { ...intent, revision: target(current) }
		await post({ action: "validate", submission }, "ValidationResponse")
		const admitted = await post({ action: "submit", submission, idempotencyKey: `revision-${n}` }, "OperationResponse")
		const revised = await f.settled(admitted.operation.id); check("Operation", revised)
		assert.equal(revised.named.outcome, n === 0 ? "committed" : "conflict")
	}
	for (const [route, name] of [["/voxels/named", "NamedList"], [`/voxels/named/${head.voxelId}`, "NamedResponse"], ["/voxels/artifacts", "ArtifactInventory"], [`/voxels/artifacts/${op.artifact.artifactId}?${new URLSearchParams({ generation: op.artifact.generation, manifest: JSON.stringify(op.artifact.manifest) })}`, "ArtifactResponse"], ["/voxels?idempotencyKey=contract-0", "OperationsResponse"]]) check(name, await (await f.request(route)).json())
	assert.equal(accepts(schemas.ArtifactResponse, { artifact: op.artifact, availability: head.availability }, schemas), false, "Old incompatible envelope must fail")
	assert.equal(accepts(schemas.VoxelRequest, { action: "submit", submission: intents[0], idempotencyKey: "x", force: true }, schemas), false)
})

test("empty categorical validation keeps exclusions in a contract-valid response", async (t) => {
	const { buildVoxelsOpenApi } = await import("../lib/voxels-openapi.js")
	const schemas = buildVoxelsOpenApi().components.schemas, f = await fixture(t), source = await f.capture()
	const recipe = { schemaVersion: 1, algorithm: "geocluster-binning-v1", name: "Clipped categories", scope: indexed(source).scope, geometry: { mode: "points", x: 0, y: 1, z: 2, zMeaning: { type: "elevation" } }, reference: { horizontal: { type: "local", name: "test" }, horizontalUnit: "m", verticalUnit: "m", verticalReference: "plane" }, value: { kind: "categorical", column: 3, name: "Class", trim: false }, numbers: indexed(source).numbers, predicates: [], grid: { spacing: [1, 1, 1], extent: { type: "custom", origin: [10, 10, 10], shape: [1, 1, 1], acceptClipping: true } }, predecessor: null }
	const response = await f.request("/voxels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "validate", submission: { kind: "table-to-voxel", recipe, revision: null } }) })
	assert.equal(response.status, 200); const body = await response.json()
	assert.ok(accepts(schemas.ValidationResponse, body, schemas), JSON.stringify(body))
	assert.equal(body.field, null); assert.equal(body.statistics.occupiedCells, 0)
	assert.equal(body.statistics.clipping.outsidePoints, 2); assert.ok(body.errors.includes("No cells are occupied. Review the extent and exclusions."))
	assert.equal((await f.workspace.state.list("voxel-artifacts")).length, 0)
	observed("ValidationResponse", body)
})

test("empty categorical indexed validation reports blocking cells in a contract-valid response", async (t) => {
	const { buildVoxelsOpenApi } = await import("../lib/voxels-openapi.js")
	const schemas = buildVoxelsOpenApi().components.schemas, f = await fixture(t), source = await f.capture("empty.csv", "x,y,z,value\n0,0,0,\n1,0,0,\n")
	const recipe = { ...indexed(source), emptyCells: "allow" }
	for (const body of [{ action: "validate", recipe }, { action: "validate", submission: { kind: "indexed-grid", recipe, revision: null } }]) {
		const response = await f.request("/voxels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
		assert.equal(response.status, 200); const result = await response.json()
		assert.ok(accepts(schemas.IndexedValidation, result, schemas), JSON.stringify(result))
		assert.equal(result.field, null); assert.equal(result.scanComplete, true); assert.equal(result.summary.validCells, 0)
		assert.equal(result.summary.emptySuppliedValueCells, 2); assert.ok(result.issues.some((issue) => issue.kind === "no-valid-values")); assert.ok(result.blockingErrors.length)
		assert.deepEqual(result.categoryPreview, { count: 0, labels: [] }); observed("IndexedValidation", result)
	}
	assert.equal((await f.workspace.state.list("voxel-artifacts")).length, 0)
})

test("active publication deletion is 202 with exact tombstone and historical association evidence", async (t) => {
	const { buildVoxelsOpenApi } = await import("../lib/voxels-openapi.js")
	const schemas = buildVoxelsOpenApi().components.schemas
	let paused, release; const gate = new Promise((r) => { release = r })
	const f = await fixture(t, { voxelCheckpoint: async (stage, op) => { if (stage === "before-named-commit") { paused = op; await gate } } }); t.after(() => release())
	const source = await f.capture(), submission = { kind: "indexed-grid", recipe: indexed(source), revision: null }
	await f.service.submit(submission, "paused"); await until(() => paused)
	assert.equal(paused.phase, "associating"); assert.ok(accepts(schemas.Operation, paused, schemas))
	const route = `/voxels/artifacts/${paused.artifact.artifactId}`
	const res = await f.request(route, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ generation: paused.artifact.generation, idempotencyKey: "active-delete" }) })
	assert.equal(res.status, 202); const wire = await res.json()
	assert.ok(accepts(schemas.PendingDeletionResponse, wire, schemas)); assert.ok(wire.deletion.blockers.includes("publication"))
	observed("PendingDeletionResponse", wire)
	assert.equal(accepts(schemas.CompletedDeletionResponse, wire, schemas), false)
	const inspected = await (await f.request(route)).json(); assert.ok(accepts(schemas.ArtifactResponse, inspected, schemas)); assert.equal(inspected.artifact.availability.state, "deleted")
	observed("ArtifactResponse", inspected)
	release(); const op = await f.settled(paused.id); assert.equal(op.named.outcome, "failed"); assert.equal(op.named.reasonCode, "artifact_deleted"); assert.ok(accepts(schemas.Operation, op, schemas))
	observed("Operation", op)
})

test("wire errors and UTF-16 public boundaries match the contract", async (t) => {
	const { buildVoxelsOpenApi } = await import("../lib/voxels-openapi.js")
	const spec = buildVoxelsOpenApi(), schemas = spec.components.schemas, f = await fixture(t)
	for (const [name, valid, invalid] of [["Predecessor", { artifactId: "prior", generation: "😀".repeat(32) }, { artifactId: "prior", generation: "😀".repeat(32) + "x" }], ["CategoryLabel", "😀".repeat(512), "😀".repeat(512) + "x"]]) { assert.ok(accepts(schemas[name], valid, schemas)); assert.equal(accepts(schemas[name], invalid, schemas), false) }
	for (const [route, method, status] of [["/voxels/member", "HEAD", 405], ["/voxels/named", "DELETE", 405], ["/voxels/private", "GET", 404], ["/voxels/artifacts/unknown?generation=x", "GET", 400], ["/voxels?resourceId=a&resourceId=b", "GET", 400]]) { const res = await f.request(route, { method }); assert.equal(res.status, status); if (method !== "HEAD") { const body = await res.json(); assert.ok(accepts(schemas.VoxelError, body, schemas)); observed("VoxelError", body) } }
	assert.ok(spec.paths["/voxels/member"].get.responses[503].headers["Retry-After"])
})

test("retained wait, retry error and settled deletion match owner shapes", async (t) => {
	const { buildVoxelsOpenApi } = await import("../lib/voxels-openapi.js")
	let paused, release; const gate = new Promise((r) => { release = r }); t.after(() => release())
	const schemas = buildVoxelsOpenApi().components.schemas, f = await fixture(t, { voxelCheckpoint: async (stage, op) => { if (stage === "validating") { paused = op; await gate } } })
	const source = await f.capture(); const accepted = await f.service.submit({ kind: "indexed-grid", recipe: indexed(source), revision: null }, "wait-evidence"); await until(() => paused)
	const stored = await f.workspace.state.get("voxel-operations", accepted.operation.id)
	await f.service.contention(stored, "mutation", async ({ onWait }) => {
		await onWait({ retryAt: new Date(Date.now() + 1000).toISOString() })
		const waiting = await f.service.operation(stored.id); assert.equal(waiting.waitingFor, "mutation"); assert.ok(waiting.contentionWaitStartedUtc); assert.ok(accepts(schemas.Operation, waiting, schemas)); observed("Operation", waiting)
	})
	release(); const op = await f.settled(stored.id)
	await f.restart()
	const record = await f.service.artifactResolve({ artifactId: op.artifact.artifactId }); assert.equal(record.artifact.availability.state, "unchecked"); observed("ArtifactResponse", record)
	const res = await f.request(`/voxels/member?${new URLSearchParams({ manifest: JSON.stringify(op.artifact.manifest), role: "values" })}`)
	assert.equal(res.status, 503); assert.equal(res.headers.get("retry-after"), "1"); const error = await res.json(); assert.ok(accepts(schemas.VoxelError, error, schemas)); assert.equal(error.availability.state, "checking"); observed("VoxelError", error)
	await until(async () => (await f.service.artifactResolve({ artifactId: op.artifact.artifactId })).artifact.availability.state === "verified")
	const registered = await f.artifact(op), upload = await f.workspace.state.get("operations", registered.uploadId)
	await f.workspace.state.put("persistence-transfers", "pending-contract-transfer", { source: upload.publishedSource, state: "running" })
	const reader = await f.workspace.captures.open("capture", registered.members.values.source.revision.slice(8)); t.after(() => reader.release())
	await f.releaseLeases(); const deleted = await f.service.deleteArtifact(op.artifact.artifactId, { generation: op.artifact.generation, idempotencyKey: "settled-deletion" })
	assert.equal(deleted.status, 202); assert.ok(deleted.deletion.blockers.includes("persistenceTransfer")); assert.ok(deleted.deletion.blockers.includes("reader")); observed("PendingDeletionResponse", { deletion: deleted.deletion })
	await reader.release(); await f.workspace.state.delete("persistence-transfers", "pending-contract-transfer")
	await until(async () => { await f.service.cleanupArtifacts(); return !(await f.service.artifact(op.artifact.artifactId)).deletion.cleanupPending })
	const receipt = (await f.service.artifact(op.artifact.artifactId)).deletion
	assert.ok(accepts(schemas.CompletedDeletionResponse, { deletion: receipt }, schemas)); observed("CompletedDeletionResponse", { deletion: receipt })
})
