import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { validateDiscovery } from "../../lib/managed-catalog.js"
import { credentialsResponse } from "../../lib/machine-credentials.js"
import { startImageBackend } from "./image-backend.mjs"

test("ready image backend renews machine credentials before authenticated discovery and inference", async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gc-image-backend-"))
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
	const backend = await startImageBackend({ port: 0, directory })
	t.after(() => backend.close())
	assert.ok(fs.existsSync(path.join(directory, "image-backend-ready")))
	const request = (route, init = {}) => fetch(backend.url + route, { ...init, signal: AbortSignal.timeout(3000) })
	assert.equal((await request("/renew", { method: "POST" })).status, 401)
	const renewal = await request("/renew", { method: "POST", headers: { authorization: "Bearer local-machine-only" } })
	assert.equal(renewal.status, 200)
	const { llmToken } = credentialsResponse(await renewal.json())
	assert.equal((await request("/v1/account")).status, 401)
	assert.equal((await request("/v1/account", { headers: { authorization: "Bearer local-machine-only" } })).status, 401)
	assert.equal((await request("/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer local-machine-only" } })).status, 401)
	const headers = { authorization: `Bearer ${llmToken}`, "content-type": "application/json" }
	for (const route of ["/v1/account", "/v1/models"]) {
		const discovery = await request(route, { headers })
		assert.equal(discovery.status, 200)
		const catalog = validateDiscovery(await discovery.json())
		assert.ok(catalog.allowed_model_ids.includes(catalog.default_model_id))
	}
	const inference = await request("/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "openai/gpt-6-luna", messages: [{ role: "user", content: "SAY fixture ready" }] }) })
	assert.equal(inference.status, 200)
	assert.equal((await inference.json()).choices[0].message.content, "fixture ready")
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "image-backend-observation.json"), "utf8")), { renewals: 1, discoveries: 2, inferenceRequests: 1 })
})
