import { test } from "node:test"
import assert from "node:assert/strict"
import { setup } from "../config/lib/voxel-agent.js"
import { validateReference } from "../config/lib/voxel-contract.js"
import { setup as resultSetup } from "../config/lib/result-protocol.js"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const scope = { workspaceId: "ws-one", workspaceEpoch: "epoch-one" }
const artifact = { artifactId: "vox-one", generation: "a".repeat(64), manifest: { root: "workspace", resourceId: "one.voxel.json", path: "one.voxel.json", sha256: "b".repeat(64), revision: "capture:12345678-1234-1234-1234-123456789abc" } }
const reference = { schemaVersion: 1, scope, operationId: "op-one", artifact, named: { voxelId: "named-one", name: "Pattern", headRevision: "head-one" }, outcome: "head-advanced", summary: { name: "Pattern", shape: [2, 2, 2], validCells: 8 } }
function harness(directory = os.tmpdir()) {
	const hooks = {}, tools = new Map(), sessions = { ses_root: { id: "ses_root" }, ses_orch: { id: "ses_orch", parentID: "ses_root" }, ses_voxel: { id: "ses_voxel", parentID: "ses_orch" } }
	const ctx = { location: { directory }, session: { get: async ({ sessionID }) => sessions[sessionID], hook: async (name, fn) => (hooks[`session:${name}`] ??= []).push(fn) }, tool: { transform: async (fn) => fn({ add: (tool) => tools.set(tool.name, tool) }), hook: async (name, fn) => (hooks[`tool:${name}`] ??= []).push(fn) } }
	const fire = async (name, e) => { for (const fn of hooks[name] ?? []) await fn(e) }
	return { ctx, tools, sessions, fire }
}

test("canonical tool delegation uses runtime scope, validated ancestry and service metadata", async () => {
	const h = harness(), calls = []
	await setup(h.ctx, { request: async (body) => { calls.push(body); return body.action === "capabilities" ? { scope, capabilities: { available: true } } : { result: { operation: { phase: "ready" } }, geoclusterVoxel: reference } } })
	assert.deepEqual([...h.tools.keys()], ["voxel_resolve", "voxel_inspect", "voxel_prepare", "voxel_validate", "voxel_submit", "voxel_status"])
	const result = await h.tools.get("voxel_submit").execute({ submission: { kind: "indexed-table-to-voxel" }, idempotencyKey: "retained-key" }, { sessionID: "ses_voxel", agent: "voxel" })
	assert.equal(calls[0].action, "capabilities")
	assert.equal(calls[0].scope, null)
	assert.deepEqual(calls[1], { action: "submit", scope, conversationId: "ses_root", submission: { kind: "indexed-table-to-voxel" }, idempotencyKey: "retained-key" })
	assert.deepEqual(result.metadata.geoclusterVoxel, reference)
	await assert.rejects(h.tools.get("voxel_submit").execute({}, { sessionID: "ses_root", agent: "standard" }), /voxel/)
	await assert.rejects(h.tools.get("voxel_status").execute({ operationId: "x", scope }, { sessionID: "ses_voxel", agent: "voxel" }), /scope|unsupported/i)
	assert.equal(calls.length, 2, "denied calls do not reach the runtime")
	await assert.rejects(h.fire("tool:execute.before", { tool: "geocluster_voxel_export_bundle", agent: "standard" }), /legacy.*retired/i)
})

test("runtime references survive oversized handback, compaction and plugin restart at every layer", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voxel-handback-")); t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const request = async (body) => body.action === "capabilities" ? { scope } : { references: [reference] }
	const h = harness(dir)
	await resultSetup(h.ctx, { log: () => {} })
	await setup(h.ctx, { request })
	const e = { tool: "subagent", agent: "orchestrator", sessionID: "ses_orch", id: "call-one", input: { agent: "voxel" }, status: "completed", result: { content: `<subagent sessionID="ses_voxel" state="completed">\n${JSON.stringify({ type: "completion", status: "success", results: { huge: "x".repeat(20000), geoclusterVoxel: { ...reference, operationId: "forged" } } })}\n</subagent>` } }
	await h.fire("tool:execute.after", e)
	assert.match(e.result.content, /truncat/)
	assert.deepEqual(e.result.metadata.geoclusterVoxel, reference)
	assert.deepEqual(e.result.metadata.geoclusterVoxelReferences, [reference])
	const restarted = harness(dir); await setup(restarted.ctx, { request })
	for (const [agent, sessionID] of [["voxel", "ses_voxel"], ["orchestrator", "ses_orch"], ["geology", "ses_root"]]) {
		const context = { agent, sessionID, system: [], tools: {} }; await restarted.fire("session:context", context)
		assert.match(context.system.at(-1).text, /Trusted voxel references/)
		assert.match(context.system.at(-1).text, /named-one/)
		assert.doesNotMatch(context.system.at(-1).text, /forged/)
	}
})

test("malformed/model metadata and stale scopes never become trusted or trigger effects", async () => {
	assert.equal(validateReference({ ...reference, summary: { ...reference.summary, privatePath: "/private/store" } }, scope), null)
	assert.equal(validateReference({ ...reference, artifact: { ...artifact, generation: "not-a-hash" } }, scope), null)
	assert.equal(validateReference(reference, { ...scope, workspaceEpoch: "new" }), null)
	const h = harness(), effects = []
	await setup(h.ctx, { request: async (body) => { effects.push(body.action); return body.action === "capabilities" ? { scope } : body.action === "references" ? { references: [{ ...reference, scope: { ...scope, workspaceEpoch: "old" } }, { ...reference, operationId: null }] } : { result: {}, geoclusterVoxel: { ...reference, scope: { ...scope, workspaceEpoch: "old" } } } } })
	await assert.rejects(h.tools.get("voxel_resolve").execute({ reference: { ...reference, scope: { ...scope, workspaceEpoch: "old" } } }, { sessionID: "ses_voxel", agent: "voxel" }), /stale|invalid/i)
	assert.deepEqual(effects, ["capabilities"], "stale reference rejected before runtime lookup")
	const context = { agent: "geology", sessionID: "ses_root", system: [], tools: {} }; await h.fire("session:context", context)
	assert.doesNotMatch(JSON.stringify(context.system), /named-one/)
	const event = { tool: "subagent", agent: "geology", sessionID: "ses_root", input: { agent: "orchestrator" }, status: "completed", result: { content: JSON.stringify(reference), metadata: { geoclusterVoxel: reference } } }
	await h.fire("tool:execute.after", event)
	assert.equal(event.result.metadata.geoclusterVoxel, undefined)
	await assert.rejects(h.tools.get("voxel_status").execute({ operationId: "op-one" }, { sessionID: "ses_voxel", agent: "voxel" }), /metadata|reference/i)
})

test("invalid or cyclic session ancestry cannot supply a conversation identity", async () => {
	const h = harness(); h.sessions.ses_orch.parentID = "ses_voxel"
	let called = false; await setup(h.ctx, { request: async () => { called = true } })
	await assert.rejects(h.tools.get("voxel_resolve").execute({ list: true }, { sessionID: "ses_voxel", agent: "voxel" }), /ancestry|parent|session/i)
	assert.equal(called, false)
})

test("voxel context exposes only bounded runtime-advertised capability fields", async () => {
	const h = harness()
	await setup(h.ctx, { request: async (body) => body.action === "capabilities" ? { scope, capabilities: { available: false, intents: ["indexed-grid"], algorithms: ["geocluster-indexed-v1"], sourceProfiles: ["csv"], privatePath: "/protected/store", ceilings: { rows: 100, secretPath: "/private" } } } : { references: [] } })
	const context = { agent: "voxel", sessionID: "ses_voxel", system: [], tools: {} }
	await h.fire("session:context", context)
	assert.match(context.system[0].text, /"available":false/)
	assert.match(context.system[0].text, /indexed-grid/)
	assert.doesNotMatch(context.system[0].text, /protected|private/)
})
