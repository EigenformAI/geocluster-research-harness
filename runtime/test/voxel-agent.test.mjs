import { test } from "node:test"
import assert from "node:assert/strict"
import { createVoxelAgentBridge } from "../lib/voxel-agent.js"

const scope = { workspaceId: "ws-one", workspaceEpoch: "epoch-one" }
const artifact = { artifactId: "vox-one", generation: "a".repeat(64), manifest: { root: "workspace", resourceId: "one.voxel.json", path: "one.voxel.json", sha256: "b".repeat(64), revision: "capture:12345678-1234-1234-1234-123456789abc" } }
function fixture() {
	const calls = [], stored = new Map()
	const op = { id: "op-one", phase: "ready", artifact, submission: { revision: { voxelId: "named-one" } }, named: { outcome: "committed", voxelId: "named-one", name: "Pattern", headRevision: "head-one", artifact }, statistics: { validCells: 8 }, grid: { shape: [2, 2, 2] } }
	const service = { workspace: { identity: scope }, capabilities: () => ({ available: true }), artifactRecord: async () => ({ manifest: { operationId: op.id, recipe: { recipe: { name: "Pattern" } }, grid: { shape: [2, 2, 2] }, statistics: { validCells: 8 } } }), namedList: async (args) => { calls.push(["list", args]); return { items: [] } }, namedResolve: async (args) => { calls.push(["resolve", args]); return op.named }, materializeArtifact: async (args) => { calls.push(["materialize", args]); return { csv: "x,y,z,value\n0,0,0,0\n", complete: true, base: artifact, recipe: { scope: { input: null }, name: "Pattern" } } }, list: async (args) => { calls.push(["discover", args]); return [op] }, operation: async (...args) => { calls.push(["status", ...args]); return op } }
	const bridge = createVoxelAgentBridge(service, { captureSource: async (args) => { calls.push(["capture", args]); return { source: artifact.manifest, input: { type: "delimited" } } }, saveReplacement: async (args) => { calls.push(["save", args]); return { source: artifact.manifest, input: { type: "delimited" } } }, references: { list: async (key) => stored.get(JSON.stringify(key)) ?? [], remember: async (key, ref) => stored.set(JSON.stringify(key), [ref]) } })
	const send = (action, args = {}, fence = scope) => bridge.dispatch({ action, scope: fence, conversationId: "ses_root", ...args })
	return { bridge, send, calls, op, service }
}

test("bridge fences every action before service effects and keeps identity separate from conversation", async () => {
	const f = fixture()
	assert.deepEqual((await f.send("capabilities", {}, null)).scope, scope)
	await assert.rejects(f.send("submit", { submission: {}, idempotencyKey: "key" }, { ...scope, workspaceEpoch: "old" }), /workspace|scope|epoch/i)
	await assert.rejects(f.send("resolve", { list: true, unexpected: true }), /unsupported|exact|field/i)
	await assert.rejects(f.send("constructor"), { status: 400 })
	await assert.rejects(f.bridge.dispatch({ action: "references", scope, conversationId: "workspace-not-session" }), /conversation/i)
	assert.deepEqual(f.calls, [])
})

test("runtime named journal outcomes are projected without claiming a ready artifact advanced the head", async () => {
	const f = fixture(); delete f.op.outcome
	f.op.submission = { revision: { voxelId: "named-one" } }
	for (const [outcome, expected] of [["committed", "head-advanced"], ["conflict", "head-conflict"], ["unknown", "head-outcome-unknown"], ["failed", "head-advance-failed"]]) {
		f.op.named = { outcome, voxelId: "named-one", name: "Pattern", ...(outcome === "committed" ? { headRevision: "head-new", artifact } : {}) }
		const reply = await f.send("status", { idempotencyKey: "retained-key" })
		assert.equal(reply.geoclusterVoxel.outcome, expected)
		assert.equal(reply.geoclusterVoxel.named.headRevision, outcome === "committed" ? "head-new" : null)
		assert.deepEqual(reply.geoclusterVoxel.summary.shape, [2, 2, 2])
	}
	f.op.submission.revision = null
	f.op.named.outcome = "committed"; f.op.named.headRevision = "head-first"; f.op.named.artifact = artifact
	assert.equal((await f.send("status", { operationId: f.op.id })).geoclusterVoxel.outcome, "named-created")
	f.op.named = null
	assert.equal((await f.send("status", { operationId: f.op.id })).geoclusterVoxel.outcome, "artifact-saved")
})

test("fresh named resolution records a discussed manual voxel; listing alone does not select a target", async () => {
	const f = fixture()
	await f.send("resolve", { list: true, name: "Pattern", limit: 10 })
	assert.deepEqual(f.calls[0], ["list", { name: "Pattern", limit: 10 }])
	assert.deepEqual((await f.send("references")).references, [])
	const resolved = await f.send("resolve", { voxelId: "named-one" })
	assert.equal(resolved.geoclusterVoxel.named.voxelId, "named-one")
	assert.equal(resolved.geoclusterVoxel.outcome, "artifact-saved", "resolution is not a new mutation")
	assert.equal((await f.send("references")).references[0].artifact.artifactId, artifact.artifactId)
})

test("an epoch change during materialization rejects before writing/capturing a replacement", async () => {
	const f = fixture()
	const materialize = f.service.materializeArtifact
	f.service.materializeArtifact = async (args) => { const result = await materialize(args); f.service.workspace.identity = { ...scope, workspaceEpoch: "changed" }; return result }
	await assert.rejects(f.send("prepare", { artifact, destination: "runs/ses_root/results/replacement.csv" }), { status: 409 })
	assert.ok(!f.calls.some(([action]) => action === "save"))
})
