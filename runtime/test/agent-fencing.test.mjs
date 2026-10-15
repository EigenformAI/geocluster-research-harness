import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import WebSocket, { WebSocketServer } from "ws"
import gate from "../gate.cjs"
import { FilesApi } from "../lib/files.js"
import { startGateway, until } from "./gateway-harness.mjs"

const own = { workspaceId: "workspace-a", workspaceEpoch: "epoch-a" }
const expected = { "X-GC-Workspace-ID": own.workspaceId, "X-GC-Workspace-Epoch": own.workspaceEpoch }
const secret = "s".repeat(32)
const logger = { log() {}, info() {}, warn() {}, error() {} }
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
const close = (server) => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) }

// The real file HTTP boundary serves an immutable identity per daemon generation.
// Replacing its adapter models a same-machine file-daemon restart at the same port.
async function files(t) {
	let api, available = true, version = 1, stalled = false
	const checks = []
	const replace = (identity = own) => { api = new FilesApi({ identity: Object.freeze({ ...identity }), info: () => ({ ...identity, relayEpochFencingVersion: version }) }, logger) }
	replace()
	const server = http.createServer(async (req, res) => {
		assert.equal(req.headers["x-gc-gate"], secret)
		checks.push(req.headers)
		if (stalled) return
		if (!available) { res.writeHead(503); res.end("private diagnostic must not reach browser"); return }
		await api.handle(req, res)
	})
	const port = await listen(server)
	t.after(() => close(server))
	return { port, checks, replace, unavailable: () => { available = false }, older: () => { version = 0 }, stall: () => { stalled = true } }
}

async function accessGate(t, filesPort, gatewayPort, deps = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-fence-gate-")), gateFile = path.join(root, "gate")
	await fs.writeFile(gateFile, secret)
	const server = gate.createGateServer(gate.loadConfig({ RUNTIME_AUTH_DISABLED: "1", RUNTIME_GATE_SECRET_FILE: gateFile, RUNTIME_FILES_PORT: String(filesPort), RUNTIME_GATEWAY_PORT: String(gatewayPort) }), { logger, ...deps })
	const port = await listen(server)
	const sockets = new Set()
	server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)) })
	t.after(async () => { for (const socket of sockets) socket.destroy(); await close(server); await fs.rm(root, { recursive: true, force: true }) })
	return { port, server }
}

async function rawUpgrade(port, headers = expected) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: "/agent", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"), "Sec-WebSocket-Version": "13", "Sec-WebSocket-Protocol": "acp.jsonrpc.v1", ...headers } })
		req.once("upgrade", (res, socket) => { socket.destroy(); resolve({ status: res.statusCode }) })
		req.once("response", (res) => { let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { body += chunk }); res.once("end", () => resolve({ status: res.statusCode, body })) })
		req.on("error", reject); req.end()
	})
}

async function client(t, port, headers = expected) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, "acp.jsonrpc.v1", { headers: { "x-gc-gate": secret, ...headers } })
	ws.on("error", () => {})
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject) })
	t.after(() => ws.terminate())
	return ws
}

function rpc(ws, method, params, id = crypto.randomUUID()) {
	return new Promise((resolve, reject) => {
		const cleanup = () => { ws.off("message", receive); ws.off("close", gone) }
		const receive = (bytes) => { const message = JSON.parse(bytes.toString()); if (message.id === id) { cleanup(); resolve(message) } }
		const gone = () => { cleanup(); reject(new Error("connection closed before RPC response")) }
		ws.on("message", receive); ws.once("close", gone)
		ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
	})
}

async function session(ws, workspace) {
	assert.ok((await rpc(ws, "initialize", { protocolVersion: 1, clientCapabilities: {} })).result)
	const result = await rpc(ws, "session/new", { cwd: workspace, mcpServers: [], _meta: { agentMode: "standard" } })
	assert.ok(result.result, JSON.stringify(result))
	return result.result.sessionId
}

test("agent upgrade fencing rejects stale, partial and duplicate identity before any gateway upgrade", async (t) => {
	const f = await files(t)
	const upstream = http.createServer(), wss = new WebSocketServer({ noServer: true })
	let upgrades = 0
	upstream.on("upgrade", (req, socket, head) => { upgrades++; wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => ws.send(data, { binary: false }))) })
	const upstreamPort = await listen(upstream)
	t.after(async () => { for (const ws of wss.clients) ws.terminate(); await close(upstream) })
	const g = await accessGate(t, f.port, upstreamPort)
	for (const [headers, status, error] of [
		[{ ...expected, "X-GC-Workspace-Epoch": "old" }, 409, "workspace_changed"],
		[{ ...expected, "X-GC-Workspace-ID": "other" }, 409, "workspace_changed"],
		[{ "X-GC-Workspace-ID": own.workspaceId }, 400, "invalid_workspace_fence"],
		[{ "X-GC-Workspace-Epoch": own.workspaceEpoch }, 400, "invalid_workspace_fence"],
		[{ ...expected, "X-GC-Workspace-ID": [own.workspaceId, own.workspaceId] }, 400, "invalid_workspace_fence"],
		[{ ...expected, "X-GC-Workspace-Epoch": [own.workspaceEpoch, own.workspaceEpoch] }, 400, "invalid_workspace_fence"],
		[{ ...expected, "X-GC-Workspace-Epoch": "bad.epoch" }, 400, "invalid_workspace_fence"],
	]) {
		const response = await rawUpgrade(g.port, headers)
		assert.equal(response.status, status)
		assert.equal(JSON.parse(response.body).error, error)
		assert.equal(upgrades, 0, "a rejected association cannot reach the ACP gateway")
	}
	assert.equal(f.checks.length, 2, "invalid headers reject without querying files")
	assert.ok(f.checks.every((headers) => headers["x-gc-workspace-id"] && headers["x-gc-workspace-epoch"] && headers["x-gc-gate"] === secret))
	const ws = new WebSocket(`ws://127.0.0.1:${g.port}/agent`, "acp.jsonrpc.v1", { headers: expected })
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject) })
	assert.equal(ws.protocol, "acp.jsonrpc.v1")
	const echoed = new Promise((resolve) => ws.once("message", (bytes) => resolve(bytes.toString())))
	ws.send('{"jsonrpc":"2.0","id":"wire-id","method":"initialize"}')
	assert.equal(await echoed, '{"jsonrpc":"2.0","id":"wire-id","method":"initialize"}')
	ws.terminate()
	assert.equal((await rawUpgrade(g.port, {})).status, 101, "unfenced direct development remains available")
})

test("agent upgrade fencing refuses unavailable or older private file services without gateway dispatch", async (t) => {
	const f = await files(t), upstream = http.createServer()
	let upgrades = 0
	upstream.on("upgrade", (_req, socket) => { upgrades++; socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n") })
	const port = await listen(upstream)
	t.after(() => close(upstream))
	const g = await accessGate(t, f.port, port)
	f.older()
	assert.equal((await rawUpgrade(g.port)).status, 503)
	f.unavailable()
	const response = await rawUpgrade(g.port)
	assert.equal(response.status, 503)
	assert.ok(!response.body.includes("private diagnostic"))
	assert.equal(upgrades, 0)
})

test("agent upgrade fencing has a bounded private identity deadline", async (t) => {
	const f = await files(t), upstream = http.createServer()
	let upgrades = 0
	upstream.on("upgrade", (_req, socket) => { upgrades++; socket.destroy() })
	const port = await listen(upstream)
	t.after(() => close(upstream))
	const g = await accessGate(t, f.port, port)
	f.stall()
	const started = Date.now(), response = await rawUpgrade(g.port)
	assert.equal(response.status, 503)
	assert.ok(Date.now() - started < 3500, "the two-second identity deadline cannot leave admission open indefinitely")
	assert.equal(upgrades, 0)
})

test("ACP frame fencing rejects a prompt and model/config mutations after a same-machine file incarnation change", async (t) => {
	const f = await files(t), g = await startGateway(t, { env: { RUNTIME_FILES_PORT: String(f.port) } })
	for (const [method, brokerMethod, params] of [["session/prompt", "prompt", { prompt: [{ type: "text", text: "echo stale prompt must not run" }] }], ["session/set_config_option", "setSessionConfigOption", { configId: "effort", value: "high" }], ["session/set_model", "setSessionModel", { modelId: "proxy/z-ai/glm-5.3-flash" }]]) {
		f.replace()
		const ws = await client(t, g.port), sessionId = await session(ws, g.workspace)
		let dispatched = 0
		const original = g.app.broker[brokerMethod]
		g.app.broker[brokerMethod] = function (...args) { dispatched++; return original.apply(this, args) }
		f.replace({ ...own, workspaceEpoch: "replacement-epoch" })
		const response = await rpc(ws, method, { sessionId, ...params })
		g.app.broker[brokerMethod] = original
		assert.equal(response.error?.data?.error, "workspace_changed", JSON.stringify(response))
		assert.equal(dispatched, 0, `${method} cannot enter its JSON-RPC handler`)
		await until(() => ws.readyState === WebSocket.CLOSED)
	}
})

test("ACP frame fencing checks each buffered message separately instead of reusing a successful check", async (t) => {
	const f = await files(t), g = await startGateway(t, { env: { RUNTIME_FILES_PORT: String(f.port) } })
	const ws = await client(t, g.port), sessionId = await session(ws, g.workspace)
	const original = g.app.broker.setSessionConfigOption
	let configResult
	g.app.broker.setSessionConfigOption = function (...args) { f.replace({ ...own, workspaceEpoch: "replacement-epoch" }); return original.apply(this, args).then((result) => { configResult = result; return result }) }
	let prompted = 0
	const prompt = g.app.broker.prompt
	g.app.broker.prompt = function (...args) { prompted++; return prompt.apply(this, args) }
	const first = rpc(ws, "session/set_config_option", { sessionId, configId: "effort", value: "high" }, "first-buffered").catch(() => null)
	const second = rpc(ws, "session/prompt", { sessionId, prompt: [{ type: "text", text: "echo forbidden second message" }] }, "second-buffered")
	const [, rejectedPrompt] = await Promise.all([first, second])
	await until(() => configResult)
	assert.equal(configResult.configOptions.find((option) => option.id === "effort").currentValue, "high", "the first admitted change completes even if epoch closure loses its response")
	assert.equal(rejectedPrompt.error?.data?.error, "workspace_changed", JSON.stringify(rejectedPrompt))
	assert.equal(prompted, 0)
})

test("ACP frame fencing drops a stale permission response without answering or cancelling accepted work", async (t) => {
	const f = await files(t), g = await startGateway(t, { env: { RUNTIME_FILES_PORT: String(f.port) } })
	const ws = await client(t, g.port), sessionId = await session(ws, g.workspace)
	let permission
	ws.on("message", (bytes) => { const message = JSON.parse(bytes.toString()); if (message.method === "session/request_permission") permission = message })
	const pending = rpc(ws, "session/prompt", { sessionId, prompt: [{ type: "text", text: "ask" }] }).catch(() => null)
	await until(() => permission)
	const reqId = permission.params._meta.reqId
	await until(() => g.app.activity.state === "permission_pending")
	f.replace({ ...own, workspaceEpoch: "replacement-epoch" })
	ws.send(JSON.stringify({ jsonrpc: "2.0", id: permission.id, result: { outcome: { outcome: "selected", optionId: "once" } } }))
	await until(() => ws.readyState === WebSocket.CLOSED || g.app.activity.state === "idle", 1000)
	assert.equal(g.app.activity.state, "permission_pending", "a stale permission response cannot authorize the waiting tool")
	await until(() => ws.readyState === WebSocket.CLOSED, 1000)
	assert.ok(!(await g.readLog(sessionId)).some((event) => event.kind === "permission_response" && event.reqId === reqId), "a stale answer must not resolve the accepted permission request")
	assert.equal(g.app.activity.state, "permission_pending", "transport closure must not cancel the turn")
	await g.app.broker.cancel({ sessionId }); await pending
})

test("current fenced ACP accepts prompt, config changes and permission answers without blocking a live turn", async (t) => {
	const f = await files(t), g = await startGateway(t, { env: { RUNTIME_FILES_PORT: String(f.port) } })
	const ws = await client(t, g.port), sessionId = await session(ws, g.workspace)
	const config = await rpc(ws, "session/set_config_option", { sessionId, configId: "effort", value: "high" })
	assert.equal(config.result.configOptions.find((option) => option.id === "effort").currentValue, "high")
	assert.equal((await rpc(ws, "session/prompt", { sessionId, prompt: [{ type: "text", text: "echo current" }] })).result.stopReason, "end_turn")
	ws.on("message", (bytes) => {
		const message = JSON.parse(bytes.toString())
		if (message.method === "session/request_permission") ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: "once" } } }))
	})
	assert.equal((await rpc(ws, "session/prompt", { sessionId, prompt: [{ type: "text", text: "ask" }] })).result.stopReason, "end_turn")
	assert.equal(ws.readyState, WebSocket.OPEN)
	assert.equal(g.app.activity.state, "idle")
})

test("gate periodic epoch checks close both native transports while accepted work remains live", async (t) => {
	const f = await files(t), g = await startGateway(t, { env: { RUNTIME_FILES_PORT: String(f.port) } })
	const access = await accessGate(t, f.port, g.port, { workspaceEpochCheckMs: 25 })
	const ws = await client(t, access.port), sessionId = await session(ws, g.workspace)
	const pending = rpc(ws, "session/prompt", { sessionId, prompt: [{ type: "text", text: "hang" }] }).catch(() => null)
	await until(() => g.app.activity.state === "prompt_running")
	f.replace({ ...own, workspaceEpoch: "replacement-epoch" })
	await until(() => ws.readyState === WebSocket.CLOSED, 1000)
	await until(() => g.app.broker.ports.size === 0, 1000)
	assert.equal(g.app.activity.state, "prompt_running")
	assert.equal(g.app.broker.engine.state, "ready")
	await g.app.broker.cancel({ sessionId }); await pending
	const checks = f.checks.length
	await new Promise((resolve) => setTimeout(resolve, 75))
	assert.equal(f.checks.length, checks, "closed sockets release the epoch poll")
})
