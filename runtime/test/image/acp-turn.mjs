#!/usr/bin/env node
/**
 * acp-turn.mjs — one conversation, one turn, through the gateway's ACP WebSocket. Runs INSIDE the image: image-test.mjs
 * mounts runtime/test at /opt/geocluster-runtime/test, so `ws` resolves from the image's own node_modules.
 *
 *   node acp-turn.mjs --mode geology --prompt "SAY OK" [--url http://127.0.0.1:3000] [--cookie C]
 *     [--gate-file /run/runtime/gate] (only for a direct ACP probe of :3001)
 * The offline image test sets RUNTIME_AUTH_DISABLED=1 at the local public gate.
 *
 * Prints one JSON line: {sessionId, stopReason, meta, text, tools: [tool_call titles/kinds], error?}. Exit 0 when the turn
 * ended (any stop reason), 1 on a protocol error or timeout.
 */
import fs from "node:fs"
import WebSocket from "ws"

const args = process.argv.slice(2)
const opt = (name, fallback) => {
	const i = args.indexOf(name)
	return i === -1 ? fallback : args[i + 1]
}
const BASE = opt("--url", "http://127.0.0.1:3000").replace(/\/$/, "")
const GATE_FILE = opt("--gate-file", "")
const COOKIE = opt("--cookie", "")
const MODE = opt("--mode", "geology")
const PROMPT = opt("--prompt", "SAY OK")
const TIMEOUT_MS = Number(opt("--timeout-ms", "90000"))

const headers = {}
if (GATE_FILE) headers["x-gc-gate"] = fs.readFileSync(GATE_FILE, "utf8").trim()
if (COOKIE) headers.cookie = COOKIE
const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/agent`, "acp.jsonrpc.v1", { headers })
let nextId = 1
const waiting = new Map()
let text = ""
const tools = []

const call = (method, params) =>
	new Promise((resolve, reject) => {
		const id = nextId++
		waiting.set(id, { resolve, reject })
		ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
	})

ws.on("message", (raw) => {
	const msg = JSON.parse(String(raw))
	if (msg.id !== undefined && waiting.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
		const w = waiting.get(msg.id)
		waiting.delete(msg.id)
		return msg.error ? w.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error })) : w.resolve(msg.result)
	}
	if (msg.method === "session/update") {
		const u = msg.params?.update ?? {}
		if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") text += u.content.text
		if (u.sessionUpdate === "tool_call") tools.push({ title: u.title ?? null, kind: u.kind ?? null, status: u.status ?? null })
	}
	if (msg.method === "session/request_permission" && msg.id !== undefined) {
		ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }))
	}
})

const timer = setTimeout(() => {
	console.log(JSON.stringify({ error: `timeout after ${TIMEOUT_MS} ms`, text, tools }))
	process.exit(1)
}, TIMEOUT_MS)

ws.on("error", (error) => {
	console.log(JSON.stringify({ error: String(error?.message ?? error) }))
	process.exit(1)
})

ws.on("unexpected-response", (_request, response) => {
	console.log(JSON.stringify({ error: `ACP WebSocket upgrade rejected: HTTP ${response.statusCode}` }))
	process.exit(1)
})

ws.on("open", async () => {
	try {
		await call("initialize", { protocolVersion: 1, clientCapabilities: {} })
		const created = await call("session/new", { cwd: "/ignored", mcpServers: [], _meta: { agentMode: MODE } })
		const result = await call("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: PROMPT }] })
		clearTimeout(timer)
		console.log(JSON.stringify({ sessionId: created.sessionId, stopReason: result?.stopReason, meta: result?._meta ?? null, text, tools }))
		ws.close()
		process.exit(0)
	} catch (error) {
		clearTimeout(timer)
		console.log(JSON.stringify({ error: String(error?.message ?? error), rpc: error?.rpc ?? null, text, tools }))
		process.exit(1)
	}
})
