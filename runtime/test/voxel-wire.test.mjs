import assert from "node:assert/strict"
import { test } from "node:test"
import { fixture } from "./voxel-fixture.mjs"
test("public artifact envelope and exact bindings remain strict; metadata does not verify", async (t) => {
	const f = await fixture(t), { op } = await f.create(); await f.restart()
	let workers = 0; const worker = f.service.worker.bind(f.service); f.service.worker = (...args) => { workers++; return worker(...args) }
	const route = `/voxels/artifacts/${op.artifact.artifactId}`, response = await f.request(route), body = await response.json()
	assert.equal(response.status, 200); assert.deepEqual(Object.keys(body), ["artifact"]); assert.deepEqual(body.artifact.link, op.artifact); assert.equal(body.artifact.availability.state, "unchecked"); assert.equal(workers, 0)
	const binding = new URLSearchParams({ generation: op.artifact.generation, manifest: JSON.stringify(op.artifact.manifest) })
	assert.equal((await f.request(`${route}?${binding}`)).status, 200)
	for (const q of [`generation=${op.artifact.generation}`, `manifest=${encodeURIComponent(JSON.stringify(op.artifact.manifest))}`, `${binding}&generation=${op.artifact.generation}`, `${binding}&unknown=1`]) assert.equal((await f.request(`${route}?${q}`)).status, 400)
	for (const [route, method] of [["/voxels/named", "DELETE"], ["/voxels/artifacts", "DELETE"], ["/voxels/member", "POST"], [`/voxels/operations/${op.id}`, "POST"]]) assert.equal((await f.request(route, { method })).status, 405)
})
test("DELETE Origin and fence checks precede malformed bodies; admitted deletion is discoverable with the retained key", async (t) => {
	const f = await fixture(t, { allowedOrigins: ["https://allowed.example"] }), { op } = await f.create(), route = `/voxels/artifacts/${op.artifact.artifactId}`, options = { method: "DELETE", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{" }
	let response = await f.request(route, options); assert.equal(response.status, 403); assert.equal((await response.json()).error, "bad_origin")
	response = await f.request(route, { ...options, headers: { ...options.headers, "x-gc-workspace-id": f.workspace.identity.workspaceId, "x-gc-workspace-epoch": "stale" } }); assert.equal(response.status, 409)
	assert.equal((await f.workspace.state.list("voxel-deletions")).length, 0)
	const input = { generation: op.artifact.generation, idempotencyKey: "wire-deletion" }
	response = await f.request(route, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); assert.equal(response.status, 202, "direct authenticated requests may omit Origin"); const first = (await response.json()).deletion
	assert.equal((await f.service.artifact(op.artifact.artifactId)).deletion.id, first.id)
	await f.releaseLeases(); await f.workspace.sweep(); response = await f.request(route, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); assert.equal(response.status, 200); assert.equal((await response.json()).deletion.id, first.id)
	const record = (await (await f.request(route)).json()).artifact; assert.equal(record.availability.state, "deleted"); assert.deepEqual(record.link, op.artifact); assert.equal(record.cleanupPendingBytes, 0)
})
