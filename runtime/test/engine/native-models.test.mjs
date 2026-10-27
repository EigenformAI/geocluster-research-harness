/** Native profile qualification on the exact engine; all supplier traffic stays on loopback. */
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { OPENCODE_BIN, prepareSandbox } from "./engine.mjs"
import { startFakeLlm } from "./fake-llm.mjs"
import { NATIVE_MODEL, NATIVE_ALTERNATE, modelRef, startNativeServer, writeNativeUserConfig, until } from "./native-engine.mjs"

const recipePath = fileURLToPath(new URL("../../../opencode/engine/source-build.json", import.meta.url))
test("qualification binary has the matching verified source-build identity", { skip: !process.env.OPENCODE_BIN }, () => {
	const identity = JSON.parse(fs.readFileSync(path.join(path.dirname(OPENCODE_BIN), "build-identity.json")))
	const recipe = JSON.parse(fs.readFileSync(recipePath))
	for (const [key, value] of Object.entries(recipe)) assert.deepEqual(identity[key], value, key)
	assert.equal(crypto.createHash("sha256").update(fs.readFileSync(OPENCODE_BIN)).digest("hex"), identity.binarySha256)
	assert.equal(identity.binarySha256, "3f7abdc7ba07cc96a2f3fd21166d62d44a58f66b87269ef6dca9ae5ef2ed3f68")
})

test("native global/project defaults, key connection persistence, no-variant tools, titles, delegates and compaction", {
	skip: !process.env.OPENCODE_BIN, timeout: 120000,
}, async (t) => {
	const sandbox = fs.mkdtempSync("/tmp/opencode/native-models-")
	t.diagnostic(`native evidence: ${sandbox}`)
	const paths = prepareSandbox(sandbox, { profile: "native" })
	const llm = await startFakeLlm({ log: `${sandbox}/supplier.ndjson`, requiredBearer: "loopback-native-connection-only" })
	t.after(() => llm.close())
	writeNativeUserConfig(paths, llm.url)
	let engine = await startNativeServer({ paths })
	t.after(() => engine.stop())
	const plugins = await until(async () => {
		const loaded = (await engine.api("/api/plugin")).data
		return loaded.some((p) => JSON.stringify(p).includes("run-dir") && p.state.status === "active") && loaded
	}, "native shared plugins ready without inference")
	assert.ok(!plugins.some((p) => /account-attribution|retry-policy/.test(JSON.stringify(p))), JSON.stringify(plugins))
	await engine.api("/api/integration/personal/connect/key", { method: "POST", body: { key: "loopback-native-connection-only", label: "Qualification connection" } })
	const available = await until(async () => {
		const model = (await engine.api("/api/model")).data.find((m) => m.providerID === "personal" && m.id === NATIVE_MODEL)
		return model || false
	}, "native custom model ready")
	assert.deepEqual(available.variants, [], "native no-variant model must not acquire generic effort choices")
	fs.writeFileSync(`${paths.ws}/native.txt`, "native tool returned\n")
	const sid = await engine.create()
	assert.equal(llm.requests.length, 0, "connection and readiness do not run inference")
	await engine.api(`/api/session/${sid}/prompt`, { method: "POST", body: { text: 'TOOL read {"path":"native.txt"}' } })
	await until(() => llm.requests.some((r) => r.lastRole === "tool"), "native tool supplier round trip")
	await engine.idle()
	const requests = llm.requests.filter((r) => !r.aux)
	assert.equal(requests.length, 2)
	assert.ok(requests[1].body.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("native tool returned")))
	assert.ok(llm.requests.some((r) => r.aux === "title"), "native title resolves without small_model")
	for (const r of llm.requests) {
		assert.equal(r.body.model, NATIVE_MODEL)
		if (!r.aux) assert.equal(r.body.max_completion_tokens, 1024)
		assert.equal(r.body.reasoning?.effort, undefined)
		assert.ok(!Object.keys(r.headers).some((key) => key.startsWith("x-geocluster-")))
	}
	await engine.api(`/api/session/${sid}/prompt`, { method: "POST", body: { text: "DELEGATE orchestrator DELEGATE analytics RESULT native delegate" } })
	await until(() => llm.agentCalls("analytics").length, "native layered delegation")
	await engine.idle()
	assert.ok(llm.agentCalls("analytics").every((r) => r.body.model === NATIVE_MODEL))
	await engine.api(`/api/session/${sid}/compact`, { method: "POST", body: {} })
	await until(async () => /compaction/.test(JSON.stringify(await engine.messages(sid))), "native compaction persisted")
	await engine.idle()
	assert.ok(llm.requests.some((r) => r.aux === "compaction" && r.body.model === NATIVE_MODEL), "manual compaction must reach the selected native supplier")
	assert.ok(llm.requests.every((r) => r.body.model === NATIVE_MODEL), "auxiliary resolution must not fall back to proxy")
	const before = llm.requests.length
	await engine.stop()
	fs.writeFileSync(`${paths.ws}/opencode.json`, JSON.stringify({ model: `personal/${NATIVE_ALTERNATE}` }))
	engine = await startNativeServer({ paths })
	assert.match(JSON.stringify(await engine.messages(sid)), /native tool returned/)
	assert.equal(llm.requests.length, before, "restoration must not replay inference")
	const fresh = await engine.create()
	await engine.api(`/api/session/${fresh}/prompt`, { method: "POST", body: { text: "SAY project overrides global" } })
	await until(() => llm.requests.length > before, "saved key authenticates after restart")
	await engine.idle()
	assert.ok(llm.requests.slice(before).every((r) => r.body.model === NATIVE_ALTERNATE && (r.aux || r.body.max_completion_tokens === 512)))
	await engine.api(`/api/session/${sid}/model`, { method: "POST", body: { model: modelRef() } })
	const mark = llm.requests.length
	await engine.api(`/api/session/${sid}/prompt`, { method: "POST", body: { text: "SAY restored session explicit model" } })
	await until(() => llm.requests.length > mark, "restored explicit native model")
	await engine.idle()
	assert.ok(llm.requests.slice(mark).every((r) => r.body.model === NATIVE_MODEL))
	assert.ok(llm.requests.every((r) => !Object.keys(r.headers).some((key) => key.startsWith("x-geocluster-"))))
	assert.ok(llm.requests.every((r) => r.authenticated === true), "every request must use the API-persisted connection, including after restart")
})
