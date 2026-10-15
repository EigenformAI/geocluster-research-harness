/** Restore against a reduced catalog, using the real engine and a retained database. */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { prepareSandbox, startEngine } from "./engine.mjs"
import { startFakeLlm } from "./fake-llm.mjs"

const models = ["z-ai/glm-5.3-flash", "xiaomi/mimo-v2.6-pro"]
const effortOf = (response) => response.configOptions.find((option) => option.id === "effort")
const resets = (engine, sessionId) => engine.updates(sessionId).filter((update) => update._meta?.["geocluster/effort-reset"])

test("restoration reconciles unsupported stored efforts, preserves valid choices and history, and persists across restart", { skip: !process.env.OPENCODE_BIN, timeout: 120000 }, async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-effort-reconciliation-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const paths = prepareSandbox(root)
	const file = path.join(paths.config, "opencode.json")
	const current = await fs.readFile(file, "utf8")
	const seed = JSON.parse(current)
	for (const id of models) seed.providers.proxy.models[id].variants.push({ id: "retired", settings: { reasoning: { effort: "high" } } })
	await fs.writeFile(file, JSON.stringify(seed))
	const llm = await startFakeLlm({ log: path.join(root, "supplier.ndjson") })
	t.after(() => llm.close())
	let engine = await startEngine({ sandbox: root, llmUrl: llm.url })
	t.after(() => engine.stop())
	await engine.initialize()
	const sessions = []
	for (const id of models) {
		const sessionId = await engine.newSession("geology", `proxy/${id}`)
		await engine.call("session/set_config_option", { sessionId, configId: "effort", value: "retired" })
		assert.equal((await engine.prompt(sessionId, `SAY seed history ${id}`, { timeoutMs: 15000 })).stopReason, "end_turn")
		sessions.push({ id, sessionId })
	}
	const controls = []
	for (const effort of ["low", "default"]) {
		const sessionId = await engine.newSession("geology", "proxy/z-ai/glm-5.3-flash")
		await engine.call("session/set_config_option", { sessionId, configId: "effort", value: effort })
		controls.push({ sessionId, effort })
	}
	await engine.stop()
	await fs.writeFile(file, current)
	engine = await startEngine({ sandbox: root, llmUrl: llm.url })
	await engine.initialize()
	for (const { id, sessionId } of sessions) await t.test(id, async () => {
		const before = llm.requests.length
		const response = await engine.call("session/resume", { sessionId, cwd: paths.ws, mcpServers: [] })
		assert.equal(effortOf(response)?.currentValue, id === "xiaomi/mimo-v2.6-pro" ? undefined : "default")
		assert.equal(response.configOptions.find((option) => option.id === "model").currentValue, `proxy/${id}`)
		assert.deepEqual(resets(engine, sessionId).map((update) => update._meta["geocluster/effort-reset"]), [
			{ modelId: `proxy/${id}`, previousEffort: "retired", effort: "default" },
		])
		assert.equal(llm.requests.length, before, "restore cannot submit or replay a prompt")
		assert.equal(engine.agentText(sessionId), "", "resume must not replay history")
		assert.equal((await engine.prompt(sessionId, "SAY explicit continuation", { timeoutMs: 15000 })).stopReason, "end_turn")
		const requests = llm.requests.slice(before).filter((request) => !request.aux)
		assert.equal(requests.length, 1)
		assert.equal(requests[0].body.model, id)
		assert.equal(requests[0].body.reasoning?.effort, undefined, "repaired effort uses supplier defaults")
		assert.ok(JSON.stringify(requests[0].body.messages).includes(`seed history ${id}`), "repair retains conversation history")
	})
	for (const { sessionId, effort } of controls) {
		const response = await engine.call("session/resume", { sessionId, cwd: paths.ws, mcpServers: [] })
		assert.equal(effortOf(response).currentValue, effort)
		assert.deepEqual(resets(engine, sessionId), [])
		assert.equal((await engine.prompt(sessionId, "SAY unchanged selection", { timeoutMs: 15000 })).stopReason, "end_turn")
		assert.equal(llm.requests.filter((request) => !request.aux && request.session === sessionId).at(-1).body.reasoning?.effort, effort === "default" ? undefined : effort)
	}
	await engine.stop()
	engine = await startEngine({ sandbox: root, llmUrl: llm.url })
	await engine.initialize()
	const before = llm.requests.length
	for (const { id, sessionId } of sessions) {
		const response = await engine.call("session/resume", { sessionId, cwd: paths.ws, mcpServers: [] })
		assert.equal(effortOf(response)?.currentValue, id === "xiaomi/mimo-v2.6-pro" ? undefined : "default")
		assert.deepEqual(resets(engine, sessionId), [], "repair must survive a second engine restart")
	}
	assert.equal(llm.requests.length, before)
})
