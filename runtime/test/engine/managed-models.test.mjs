/** Opt-in pinned-engine catalog and supplier payload regression; all inference stays on loopback. */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { prepareSandbox, startEngine } from "./engine.mjs"
import { plan, startFakeLlm } from "./fake-llm.mjs"
import { buildManagedConfig } from "../../../opencode/scripts/build-config.mjs"
import { startNativeServer, until } from "./native-engine.mjs"
import fsSync from "node:fs"

// Exercise the distinct effort shapes, not every model sharing the same transport.
const cases = [
	["openai/gpt-6-luna", ["none", "low", "medium", "high", "xhigh", "max"], 32000],
	["z-ai/glm-5.3-flash", ["low", "high", "max"], 16384],
	["xiaomi/mimo-v2.6-pro", [], 32000],
]

test("pinned engine serializes expanded, restricted and absent effort choices plus tool round trips", { skip: !process.env.OPENCODE_BIN, timeout: 90000 }, async (t) => {
	const root = await fs.mkdtemp(path.join(process.env.MANAGED_MODEL_ARTIFACT_DIR || os.tmpdir(), "gc-managed-models-"))
	if (!process.env.MANAGED_MODEL_ARTIFACT_DIR) t.after(() => fs.rm(root, { recursive: true, force: true }))
	t.diagnostic(`capture artifacts: ${root}`)
	const llm = await startFakeLlm({ log: path.join(root, "supplier.ndjson") })
	t.after(() => llm.close())
	const engine = await startEngine({ sandbox: root, llmUrl: llm.url })
	t.after(() => engine.stop())
	const init = await engine.initialize()
	assert.equal(init.agentInfo.version, "2.0.19-geocluster.2")
	await fs.writeFile(path.join(engine.paths.ws, "hello.txt"), "managed tool result\n")
	for (const [id, efforts, output] of cases) await t.test(id, async () => {
		const sessionId = await engine.newSession("geology", `proxy/${id}`)
		const changed = await engine.call("session/set_config_option", { sessionId, configId: "model", value: `proxy/${id}` })
		const advertised = changed.configOptions.find((o) => o.id === "effort")
		if (efforts.length) assert.deepEqual(advertised.options.map((o) => o.value), [...efforts, "default"])
		else {
			assert.equal(advertised, undefined, "MiMo must not acquire generic effort choices")
			await assert.rejects(engine.call("session/set_config_option", { sessionId, configId: "effort", value: "high" }))
		}
		for (const effort of efforts.length ? [...efforts, "default"] : [null]) {
			if (effort) await engine.call("session/set_config_option", { sessionId, configId: "effort", value: effort })
			const before = llm.requests.length
			assert.equal((await engine.prompt(sessionId, `SAY captured ${id} ${effort}`, { timeoutMs: 15000 })).stopReason, "end_turn")
			const requests = llm.requests.slice(before).filter((r) => !r.aux)
			assert.equal(requests.length, 1)
			const body = requests[0].body
			assert.equal(body.model, id)
			assert.equal(body.max_completion_tokens, output)
			assert.equal(body.reasoning?.effort, effort === "default" ? undefined : effort ?? undefined)
			assert.ok(requests[0].tools.includes("read"))
		}
		const before = llm.requests.length
		assert.equal((await engine.prompt(sessionId, 'TOOL read {"path":"hello.txt"}', { timeoutMs: 15000 })).stopReason, "end_turn")
		const toolRequests = llm.requests.slice(before).filter((r) => !r.aux)
		assert.equal(toolRequests.length, 2, "a function call is executed and returned to the local supplier")
		assert.ok(toolRequests.every((r) => r.body.model === id && r.body.max_completion_tokens === output))
		assert.ok(toolRequests[1].body.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("managed tool result")))
	})
})

test("new backend slash-ID declaration reaches supplier unchanged and its input reserve triggers automatic compaction", {
	skip: !process.env.OPENCODE_BIN, timeout: 60000,
}, async (t) => {
	const root = fsSync.mkdtempSync("/tmp/opencode/managed-new-model-")
	t.diagnostic(`new managed model evidence: ${root}`)
	const id = "new-maker/research/slash-model"
	const declaration = { name: "Backend-only test model", capabilities: { tools: true, input: ["text"], output: ["text"] },
		limit: { context: 24000, input: 20000, output: 4000 }, variants: [] }
	const catalog = { default_model_id: id, managed_models: { [id]: declaration } }
	const paths = prepareSandbox(root, { catalog })
	const llm = await startFakeLlm({ log: `${root}/supplier.ndjson` })
	t.after(() => llm.close())
	llm.intercept = (body) => {
		const p = plan(body)
		// 18,500 is above 90% of declared input (18,000), but below 90% of
		// total context (21,600). Ignoring limit.input fails this regression.
		return !p.aux && p.directive?.args === "near input bound" ? { ...p, usage: { prompt_tokens: 18500, completion_tokens: 5 } } : p
	}
	fsSync.writeFileSync(`${paths.config}/opencode.json`, JSON.stringify(buildManagedConfig({ managedProxyURL: llm.url }, catalog)))
	const engine = await startNativeServer({ paths, profile: "managed" })
	t.after(() => engine.stop())
	await until(async () => (await engine.api("/api/model/default")).data?.id === id, "backend model settles")
	const sid = await engine.create()
	await engine.api(`/api/session/${sid}/prompt`, { method: "POST", body: { text: "SAY near input bound" } })
	await until(() => llm.agentCalls().length > 0, "first bounded request")
	await engine.idle()
	await engine.api(`/api/session/${sid}/prompt`, { method: "POST", body: { text: "SAY after reserve" } })
	await until(() => llm.requests.some((r) => r.aux === "compaction"), "automatic compaction from input budget")
	await engine.idle()
	const compact = llm.requests.findIndex((r) => r.aux === "compaction")
	const continuation = llm.requests.findIndex((r) => !r.aux && r.directive?.args === "after reserve")
	assert.ok(compact >= 0 && continuation > compact, "compaction precedes the next supplier turn")
	for (const r of llm.requests) {
		assert.equal(r.body.model, id)
		assert.equal(r.body.reasoning?.effort, undefined)
		assert.equal(r.headers["x-geocluster-conversation-id"], sid)
		if (!r.aux) assert.equal(r.body.max_completion_tokens, 4000)
		if (r.aux === "compaction") assert.ok(r.body.max_completion_tokens > 0 && r.body.max_completion_tokens <= 4000)
	}
	assert.equal(llm.requests[compact].headers["x-geocluster-kind"], "compaction")
})
