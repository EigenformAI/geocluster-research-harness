import assert from "node:assert/strict"
import http from "node:http"
import { test } from "node:test"
import { setTimeout as wait } from "node:timers/promises"
import { say, startGateway, until } from "./gateway-harness.mjs"
import { PreprocessingClient } from "../lib/preprocessing-client.js"
import { DocumentProcessing } from "../lib/document-processing.js"
import { MemoryState } from "./document-processing-fixture.test.mjs"
import { createMachineGateway } from "../machine-gateway.js"
import { managedDiscovery } from "./managed-catalog-fixture.mjs"

const standard = ["openai/gpt-6-luna", "z-ai/glm-5.3-flash", "google/gemini-3.8-flash", "deepseek/deepseek-v4.1-flash"]
const pro = "proxy/openai/gpt-6.1-sol"
async function account(t) {
	const state = { allowed: standard, requests: [], status: 200, used: 0, available: 2000 }
	const server = http.createServer(async (req, res) => {
		state.requests.push({ url: req.url, auth: req.headers.authorization })
		if (state.gate) await state.gate
		res.writeHead(state.status, { "content-type": "application/json" })
		res.end(JSON.stringify({ ...managedDiscovery(state.allowed), used: state.used, available: state.available, pending_count: 0, unknown_count: 0 }))
	})
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
	return { state, url: `http://127.0.0.1:${server.address().port}/llm` }
}

test("managed model without effort choices: picker/load/set, downgrade, partial eligibility and failed discovery", async (t) => {
	const id = "xiaomi/mimo-v2.6-pro", pro = `proxy/${id}`
	const a = await account(t), g = await startGateway(t, { env: { LLM_PROXY_URL: a.url } }), c = await g.client()
	const created = await c.conn.newSession({ cwd: g.workspace, mcpServers: [] }), { sessionId } = created
	const values = (r) => r.configOptions.find((o) => o.id === "model").options.map((o) => o.value)
	assert.deepEqual(values(created), standard.map((id) => `proxy/${id}`))
	const load = () => c.conn.loadSession({ sessionId, cwd: g.workspace, mcpServers: [] })
	await assert.rejects(c.conn.unstable_setSessionModel({ sessionId, modelId: pro }), (e) => e.data?.usageDenial?.code === "model_not_allowed")
	a.state.allowed = [standard[0], id, "unmanaged/model"]
	assert.deepEqual(values(await load()), [`proxy/${standard[0]}`, pro], "only the backend's subset of the engine catalog is selectable")
	await c.conn.unstable_setSessionConfigOption({ sessionId, configId: "model", value: pro })
	assert.equal((await load()).models.currentModelId, pro)
	const effects = [], engine = g.app.broker.engine
	for (const name of ["prompt", "newSession", "setConfigOption", "setModel"]) if (typeof engine[name] === "function") {
		const original = engine[name].bind(engine); engine[name] = (...args) => { effects.push(name); return original(...args) }
	}
	a.state.allowed = standard
	const downgraded = await load()
	assert.equal(downgraded.models.currentModelId, null)
	assert.deepEqual(values(downgraded), standard.map((id) => `proxy/${id}`))
	assert.deepEqual(downgraded.models.availableModels.map((m) => m.modelId), values(downgraded))
	await assert.rejects(c.conn.unstable_setSessionModel({ sessionId, modelId: pro }), (e) => e.data?.usageDenial?.code === "model_not_allowed")
	a.state.allowed = [...standard, id]; a.state.status = 503
	assert.deepEqual(values(await load()), standard.map((id) => `proxy/${id}`))
	await assert.rejects(c.conn.unstable_setSessionConfigOption({ sessionId, configId: "model", value: pro }), (e) => e.data?.usageDenial?.code === "usage_unavailable")
	assert.equal(g.app.broker.convs.get(sessionId).configOptions.find((o) => o.id === "model").currentValue, pro)
	assert.deepEqual(effects, [], "discovery and rejected setters cannot substitute models or replay work")
	const count = a.state.requests.length
	for (let n = 0; n < 30; n++) g.app.broker.status()
	assert.equal(a.state.requests.length, count, "stream/status rendering must use the discovered snapshot")
	assert.ok(a.state.requests.every((r) => r.url === "/llm/account" && r.auth === "Bearer llm-token"))
})

test("no-history browser status refreshes Free→Pro→Free and fails closed without creating a session", async (t) => {
	const a = await account(t), g = await startGateway(t, { env: { LLM_PROXY_URL: a.url } }), c = await g.client()
	const values = (result) => result.newSession.configOptions.find((o) => o.id === "model").options.map((o) => o.value)
	const read = () => c.conn.extMethod("_gc/status", {})
	assert.deepEqual(values(await read()), standard.map((id) => `proxy/${id}`))
	a.state.allowed = [...standard, "openai/gpt-6.1-sol"]
	assert.ok(values(await read()).includes(pro), "explicit browser status must discover new Pro eligibility")
	a.state.allowed = standard
	assert.ok(!values(await read()).includes(pro))
	a.state.allowed = [...standard, "openai/gpt-6.1-sol"]
	assert.ok(values(await read()).includes(pro))
	a.state.status = 503
	assert.ok(values(await read()).includes(pro), "failed refresh retains explicitly stale eligibility")
	assert.equal((await read()).modelDiscovery.state, "stale")
	assert.equal(g.app.broker.convs.size, 0)
})

test("parallel explicit browser statuses share in-flight discovery; sync status and health never fetch", async (t) => {
	const a = await account(t), g = await startGateway(t, { env: { LLM_PROXY_URL: a.url } }), clients = await Promise.all(Array.from({ length: 6 }, () => g.client()))
	a.state.allowed = [...standard, "openai/gpt-6.1-sol"]
	let release; a.state.gate = new Promise((resolve) => { release = resolve }); t.after(() => release())
	const count = a.state.requests.length
	const reads = clients.map((c) => c.conn.extMethod("_gc/status", {}))
	await until(() => a.state.requests.length > count, 1000)
	await wait(50)
	assert.equal(a.state.requests.length, count + 1)
	for (let n = 0; n < 20; n++) assert.equal(typeof g.app.broker.status().then, "undefined")
	assert.equal(typeof g.app.health.info().then, "undefined")
	assert.equal(typeof g.app.health.live().then, "undefined")
	await g.app.health.ready()
	assert.equal(a.state.requests.length, count + 1)
	release(); a.state.gate = null
	for (const result of await Promise.all(reads)) assert.ok(result.newSession.configOptions.find((o) => o.id === "model").options.some((o) => o.value === pro))
	const after = a.state.requests.length
	await clients[0].conn.extMethod("_gc/status", {})
	assert.equal(a.state.requests.length, after + 1, "next explicit read is fresh without a TTL")
})

test("browser discovery cannot substitute a selected model or replay a prompt on downgrade or backend loss", async (t) => {
	const a = await account(t); a.state.allowed = [...standard, "openai/gpt-6.1-sol"]
	const g = await startGateway(t, { env: { LLM_PROXY_URL: a.url } }), c = await g.client()
	const { sessionId } = await c.conn.newSession({ cwd: g.workspace, mcpServers: [] })
	await c.conn.unstable_setSessionModel({ sessionId, modelId: pro })
	const engine = g.app.broker.engine, effects = []
	for (const name of ["prompt", "newSession", "setConfigOption", "setModel"]) if (typeof engine[name] === "function") {
		const original = engine[name].bind(engine); engine[name] = (...args) => { effects.push(name); return original(...args) }
	}
	a.state.allowed = standard
	await c.conn.extMethod("_gc/status", {})
	assert.equal(g.app.broker.convs.get(sessionId).configOptions.find((o) => o.id === "model").currentValue, pro)
	a.state.status = 503
	await c.conn.extMethod("_gc/status", {})
	assert.deepEqual(effects, [])
})

test("paused usage result and completed output replay without dispatch; restored allowance needs explicit new submission", async (t) => {
	const a = await account(t), g = await startGateway(t, { env: { LLM_PROXY_URL: a.url } }), c = await g.client()
	const { sessionId } = await c.conn.newSession({ cwd: g.workspace, mcpServers: [] })
	a.state.used = 2000; a.state.available = 0
	const engine = g.app.broker.engine, original = engine.prompt.bind(engine); let calls = 0
	engine.prompt = async (params) => {
		calls++
		engine.emit("update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Completed result retained.\n" } } })
		throw { code: -32603, message: "Internal error: " + JSON.stringify({ error: { code: "usage_limit_reached", message: "Allowance exhausted", retryable: false } }), data: { errorName: "provider.quota" } }
	}
	const denied = await c.conn.prompt(say(sessionId, "analyze", { submissionId: "paused-1" }))
	assert.equal(denied._meta.reason, "paused_for_usage")
	assert.equal(denied._meta.usageDenial.code, "usage_limit_reached")
	assert.equal(denied._meta.usageDenial.retryable, false)
	assert.ok(denied._meta.usageDenial.recovery)
	assert.match(c.text(sessionId), /Completed result retained/)
	assert.doesNotMatch(c.text(sessionId), /after 3 retries|credits|\$/)
	const duplicate = await c.conn.prompt(say(sessionId, "analyze", { submissionId: "paused-1" }))
	assert.equal(duplicate._meta.duplicate, true); assert.equal(duplicate._meta.reason, "paused_for_usage"); assert.equal(calls, 1)
	const reopen = await g.client()
	await reopen.conn.loadSession({ sessionId, cwd: g.workspace, mcpServers: [] })
	await until(() => reopen.notices.some((n) => n.method === "_gc/turn_end"))
	assert.match(reopen.updates.map((u) => u.update.content?.text || "").join(""), /Completed result retained/)
	assert.equal(reopen.notices.find((n) => n.method === "_gc/turn_end").params._meta.usageDenial.code, "usage_limit_reached")
	a.state.used = 0; a.state.available = 2000
	engine.prompt = async (params) => { calls++; return original(params) }
	const resumed = await c.conn.prompt(say(sessionId, "echo explicit continuation", { submissionId: "resume-2" }))
	assert.equal(resumed.stopReason, "end_turn"); assert.equal(calls, 2)
	assert.match(c.text(sessionId), /Completed result retained/)
	await g.app.shutdown()
	const restarted = await startGateway(t, { root: g.root, env: { LLM_PROXY_URL: a.url } }), after = await restarted.client()
	let restartedCalls = 0
	const nextPrompt = restarted.app.broker.engine.prompt.bind(restarted.app.broker.engine)
	restarted.app.broker.engine.prompt = (params) => { restartedCalls++; return nextPrompt(params) }
	await after.conn.loadSession({ sessionId, cwd: g.workspace, mcpServers: [] })
	const saved = await after.conn.prompt(say(sessionId, "analyze", { submissionId: "paused-1" }))
	assert.equal(saved._meta.reason, "paused_for_usage"); assert.equal(saved._meta.usageDenial.code, "usage_limit_reached"); assert.equal(saved._meta.duplicate, true)
	assert.equal(restartedCalls, 0, "saved submission replay after restart never reaches the engine")
	assert.equal((await after.conn.prompt(say(sessionId, "echo next segment", { submissionId: "resume-3" }))).stopReason, "end_turn")
	assert.equal(restartedCalls, 1)
})

test("preprocessing managed denials are nonretryable even at 429/503 and processing never schedules redispatch", async (t) => {
	let code = "usage_unavailable", status = 503
	const requests = []
	const server = http.createServer((req, res) => { requests.push(req.url); req.resume(); res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code, message: "private supplier dollars", retryable: false } })) })
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
	const client = new PreprocessingClient({ port: server.address().port }), state = new MemoryState()
	const processing = new DocumentProcessing({ state, identity: state.identity }, { port: server.address().port, runningPollMs: 10, queuedPollMs: 10 })
	for (const item of ["usage_limit_reached", "model_not_allowed", "account_inactive", "request_already_admitted", "usage_unavailable"]) {
		code = item; status = item === "usage_limit_reached" ? 429 : 503
		let denial
		await assert.rejects(client.submit("test-key", {}), (e) => { denial = e; assert.equal(e.retryable, false); assert.equal(e.error, item); assert.doesNotMatch(e.message, /dollars/); return true })
		const job = { runtimeJobId: `processing_${item}`, ...state.identity, revision: 1, deliveryStage: "submitting", dispatchIntentAt: new Date().toISOString(), dispatchUncertain: true, cleanupState: "complete", inboxPublishedAt: new Date().toISOString(), upstreamSubmissionKey: "test-key", upstreamRequest: {} }
		await state.put("processing-jobs", job.runtimeJobId, job)
		await processing.block(job, denial)
		const saved = await processing.get(job.runtimeJobId)
		assert.equal(saved.nextAttemptAt, null); assert.equal(saved.error.retryable, false)
	}
	const deliveries = () => requests.filter((url) => url.startsWith("/preprocessing/jobs")).length
	const before = deliveries()
	for (let n = 0; n < 4; n++) { await wait(30); await processing.run() }
	assert.equal(deliveries(), before, "scheduler must not retry delivery or lookup after any managed denial")
})

test("machine relay retains supplier attempt identity, forwards account discovery, and keeps preprocessing purpose auth separate", async (t) => {
	const calls = [], supplier = http.createServer((req, res) => {
		calls.push({ url: req.url, headers: req.headers }); req.resume()
		res.setHeader("content-type", "application/json"); res.end(JSON.stringify(req.url.endsWith("/account") ? { allowed_model_ids: standard } : { ok: true }))
	})
	await new Promise((resolve) => supplier.listen(0, "127.0.0.1", resolve))
	t.after(() => new Promise((resolve) => { supplier.closeAllConnections(); supplier.close(resolve) }))
	const gateway = await createMachineGateway({ config: { llmProxyUrl: `http://127.0.0.1:${supplier.address().port}/api/v1/llm-proxy`, llmToken: "machine-llm", preprocessingProxyToken: "processor-purpose", machineCredentialsExpiresAt: new Date(Date.now() + 60000).toISOString() } })
	await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve)); t.after(() => gateway.close())
	const url = `http://127.0.0.1:${gateway.server.address().port}/llm`, requestId = "d7eea11a-6e22-4f73-9971-2707a45cd777"
	await fetch(url + "/chat/completions", { method: "POST", headers: { authorization: "Bearer runtime-relay", "x-geocluster-request-id": requestId, "x-geocluster-work-id": "msg_work", "x-geocluster-conversation-id": "ses_root", "x-geocluster-agent": "analytics", "x-geocluster-kind": "delegate", "x-geocluster-account-id": "spoof" }, body: "{}" })
	assert.equal(calls[0].headers["x-geocluster-request-id"], requestId)
	assert.equal(calls[0].headers["x-geocluster-account-id"], undefined)
	assert.equal(calls[0].headers.authorization, "Bearer machine-llm")
	await fetch(url + "/chat/completions", { method: "POST", headers: { authorization: "Bearer processor-purpose" }, body: "{}" })
	assert.equal(calls[1].headers.authorization, "Bearer processor-purpose")
	assert.match(calls[1].headers["x-geocluster-request-id"], /^[0-9a-f-]{36}$/)
	assert.equal(calls[1].headers["x-geocluster-kind"], "preprocessing")
	await fetch(url + "/chat/completions", { method: "POST", body: "{}" })
	assert.equal(calls[2].headers["x-geocluster-kind"], "unknown")
	await fetch(url + "/account")
	assert.equal(calls[3].url, "/api/v1/llm-proxy/account")
	gateway.credentials.config.machineCredentialsExpiresAt = "2020-01-01T00:00:00Z"
	const expired = await fetch(url + "/chat/completions", { method: "POST", body: "{}" })
	assert.equal(expired.status, 503)
	assert.equal((await expired.json()).error.code, "usage_unavailable")
	assert.equal(calls.length, 4)
})
