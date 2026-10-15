import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { startGateway, say } from "./gateway-harness.mjs"
import { managedDiscovery } from "./managed-catalog-fixture.mjs"
import { createCatalogArtifact, publishCatalog } from "../lib/managed-catalog.js"

const ids = ["unknown/maker/new-model", "another/new-model"]
const identity = (config) => ({ backendBaseUrl: config.managedBackendBaseUrl, projectId: config.projectId, runtimeGeneration: config.runtimeGeneration })
const seed = (_root, config) => { config.managedCatalog = createCatalogArtifact(managedDiscovery(ids), identity(config)) }
const knobs = { FAKE_OPENCODE_MODELS: ids.map((id) => ({ value: `proxy/${id}`, name: id })) }

test("new maker and slash-containing IDs use installed membership; refresh cannot install additions", async (t) => {
	const g = await startGateway(t, { seed, knobs }), c = await g.client()
	const { sessionId } = await c.conn.newSession({ cwd: g.workspace, mcpServers: [] })
	await c.conn.unstable_setSessionModel({ sessionId, modelId: `proxy/${ids[1]}` })
	assert.equal(g.app.broker.convs.get(sessionId).modelId, `proxy/${ids[1]}`)
	g.app.broker.accountUsage.fetch = async () => new Response(JSON.stringify(managedDiscovery([...ids, "future/maker/model"])))
	const status = await g.app.broker.browserStatus()
	assert.equal(status.modelDiscovery.catalogRestartRequired, true)
	await assert.rejects(c.conn.unstable_setSessionModel({ sessionId, modelId: "proxy/future/maker/model" }), (e) => /model not installed/.test(e.message))
	assert.equal((await c.conn.prompt(say(sessionId, "echo arbitrary catalog model"))).stopReason, "end_turn")
})

test("removed selection and empty snapshots never substitute or dispatch; outages retain last picker", async (t) => {
	const g = await startGateway(t, { seed, knobs }), c = await g.client()
	const { sessionId } = await c.conn.newSession({ cwd: g.workspace, mcpServers: [] })
	let calls = 0; const original = g.app.broker.engine.prompt.bind(g.app.broker.engine)
	g.app.broker.engine.prompt = (...args) => { calls++; return original(...args) }
	g.app.broker.accountUsage.fetch = async () => new Response(JSON.stringify(managedDiscovery([ids[1]])))
	await assert.rejects(c.conn.prompt(say(sessionId, "must not dispatch")), (e) => e.data?.errorName === "model.unavailable")
	assert.equal(calls, 0)
	assert.equal(g.app.broker.convs.get(sessionId).modelId, `proxy/${ids[0]}`)
	await c.conn.unstable_setSessionModel({ sessionId, modelId: `proxy/${ids[1]}` })
	g.app.broker.accountUsage.fetch = async () => { throw Error("outage") }
	const stale = await g.app.broker.browserStatus()
	assert.equal(stale.modelDiscovery.state, "stale")
	assert.equal((await c.conn.prompt(say(sessionId, "echo stale advisory eligibility"))).stopReason, "end_turn")
	g.app.broker.accountUsage.fetch = async () => new Response(JSON.stringify(managedDiscovery([])))
	await g.app.broker.browserStatus()
	g.app.broker.accountUsage.fetch = async () => { throw Error("outage") }
	const empty = await g.app.broker.browserStatus()
	assert.deepEqual(empty.newSession.configOptions.find((o) => o.id === "model").options, [])
	await assert.rejects(c.conn.prompt(say(sessionId, "still empty")), (e) => e.data?.errorName === "model.unavailable")
	assert.equal(calls, 1)
})

test("unavailable restored selection stays in history until explicit selection", async (t) => {
	const g = await startGateway(t, { seed, knobs }), c = await g.client()
	const { sessionId } = await c.conn.newSession({ cwd: g.workspace, mcpServers: [] })
	await c.conn.prompt(say(sessionId, "echo retained history"))
	await g.app.shutdown()
	const next = await startGateway(t, { root: g.root, knobs, seed: (_root, config) => { config.managedCatalog = createCatalogArtifact(managedDiscovery([ids[1]]), identity(config)) } })
	const after = await next.client()
	const restored = await after.conn.loadSession({ sessionId, cwd: next.workspace, mcpServers: [] })
	assert.equal(restored.models.currentModelId, null)
	assert.equal(restored._meta.unavailableModelId, `proxy/${ids[0]}`)
	await assert.rejects(after.conn.prompt(say(sessionId, "no fallback")), (e) => e.data?.errorName === "model.unavailable")
	assert.equal(next.app.broker.index.get(sessionId).modelId, `proxy/${ids[0]}`)
	await after.conn.unstable_setSessionModel({ sessionId, modelId: `proxy/${ids[1]}` })
	assert.equal((await after.conn.prompt(say(sessionId, "echo explicit continuation"))).stopReason, "end_turn")
})

test("null default and cold outage do not spawn ACP; gateway remains live", async (t) => {
	for (const catalog of [null, managedDiscovery([]), { ...managedDiscovery(ids), default_model_id: null }]) {
		const g = await startGateway(t, { seed: (_root, config) => { config.managedCatalog = catalog && createCatalogArtifact(catalog, identity(config)) } })
		assert.equal(g.app.broker.engine.pid, null)
		const c = await g.client()
		await assert.rejects(c.conn.newSession({ cwd: g.workspace, mcpServers: [] }), (e) => e.data?.errorName === "model.unavailable")
		assert.equal((await g.get("/livez")).status, 200)
		assert.equal(g.app.broker.status().newSession.available, false)
	}
})

test("gateway installs only an identity-checked public startup artifact", async (t) => {
	const g = await startGateway(t, { seed: async (root, config) => {
		config.managedCatalogPath = path.join(root, "catalog.json")
		await publishCatalog(config.managedCatalogPath, managedDiscovery(ids), identity(config))
		delete config.managedCatalog
	}, knobs })
	assert.ok(g.app.broker.status().modelDiscovery.installedCatalogDigest)
	assert.equal(g.app.broker.accountUsage.installedModel(`proxy/${ids[0]}`), true)
})
