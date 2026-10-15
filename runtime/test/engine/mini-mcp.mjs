#!/usr/bin/env node
/**
 * mini-mcp.mjs — the smallest MCP server the REAL engine (`opencode acp` 2.0.19) connects to: Streamable HTTP on
 * POST /mcp with JSON responses, plus the shared MCP's GET /healthz. No npm dependencies (Node >= 20).
 *
 * Why it exists: test/fake-mcp.mjs serves only /healthz (enough for the fake engine, which decides "mcp connected"
 * from /healthz). The real engine runs the MCP handshake on /mcp, so against fake-mcp.mjs it logs
 * `mcp connect failed`. The engine-contract test uses this server to check the "connected" path end to end:
 * the stderr line the supervisor waits for, the geocluster_* tools reaching the model, and the run-dir plugin's
 * per-call `run_dir`.
 *
 * Started by the gateway's McpSupervisor exactly like geocluster-mcp (RUNTIME_MCP_CMD=node, RUNTIME_MCP_ARGS=this
 * file): it reads MCP_TRANSPORT (must be "http"), MCP_HOST (default 127.0.0.1) and MCP_PORT, and answers
 * /healthz {ok:true, mode:"shared", in_flight:0}.
 *
 * Protocol subset (MCP 2025-03-26 / 2025-06-18 Streamable HTTP, stateful):
 *   POST /mcp  initialize            → result + `Mcp-Session-Id` header (protocolVersion echoed from the client)
 *              notifications (no id) → 202, empty body
 *              ping                  → {}
 *              tools/list            → TOOLS (names without the engine's `geocluster_` prefix)
 *              tools/call            → one text content block: JSON {tool, arguments, meta} of the call, so a test can
 *                                      read what the engine sent (run_dir, _meta) from the tool result the model gets
 *              anything else         → -32601
 *   GET /mcp   405 (no server-initiated SSE stream; allowed by the spec)
 *   DELETE /mcp 200 (session end)
 * Every request is printed on stdout as one `MINI_MCP {json}` line, so it lands in the gateway's mcp.log.
 */
import crypto from "node:crypto"
import http from "node:http"

const env = process.env
if ((env.MCP_TRANSPORT ?? "http") !== "http") {
	process.stderr.write(`mini-mcp: MCP_TRANSPORT must be "http", got ${JSON.stringify(env.MCP_TRANSPORT)}\n`)
	process.exit(2)
}
// The gateway's McpSupervisor always sets MCP_PORT. Without it this file was not started as a server (e.g. picked up
// by `node --test test/`, which in Node 20 runs every .mjs under a test/ directory): exit instead of listening forever.
if (!/^\d+$/.test(env.MCP_PORT ?? "")) {
	process.stderr.write("mini-mcp: MCP_PORT is not set; started by the engine contract test's gateway only\n")
	process.exit(0)
}
const host = env.MCP_HOST || "127.0.0.1"
const port = Number(env.MCP_PORT)

/** geology's three tools (opencode.json AGENT_TOOLS) and one dataops tool; the engine prefixes them `geocluster_`. */
const TOOLS = [
	{ name: "list_files", description: "List the files in a workspace directory.", inputSchema: { type: "object", properties: { directory: { type: "string", default: "." } } } },
	{ name: "check_missing", description: "Report missing values per column of a dataset.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
	{
		name: "summarize_provenance",
		description: "Summarize where the datasets in a folder came from.",
		inputSchema: { type: "object", properties: { directory: { type: "string", default: "." } } },
	},
	{ name: "inspect_dataset", description: "Columns, types and a sample of a dataset.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
]

const log = (entry) => process.stdout.write(`MINI_MCP ${JSON.stringify(entry)}\n`)
const sessions = new Set()

function answer(message) {
	const { id, method, params } = message
	switch (method) {
		case "initialize":
			return {
				result: {
					protocolVersion: params?.protocolVersion ?? "2025-06-18",
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "geocluster-mini-mcp", version: "0.0.0" },
				},
			}
		case "ping":
			return { result: {} }
		case "tools/list":
			return { result: { tools: TOOLS } }
		case "tools/call": {
			const call = { tool: params?.name ?? null, arguments: params?.arguments ?? null, meta: params?._meta ?? null }
			log({ call })
			return { result: { content: [{ type: "text", text: `MINI_MCP_RESULT ${JSON.stringify(call)}` }], isError: false } }
		}
		default:
			return { error: { code: -32601, message: `Method not found: ${method}` }, id }
	}
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://mini")
	const chunks = []
	req.on("data", (c) => chunks.push(c))
	req.on("end", () => {
		if (url.pathname === "/healthz" && req.method === "GET") {
			res.writeHead(200, { "content-type": "application/json" })
			return res.end(JSON.stringify({ ok: true, mode: "shared", in_flight: 0 }))
		}
		if (url.pathname !== "/mcp") {
			log({ method: req.method, path: url.pathname, status: 404 })
			res.writeHead(404, { "content-type": "text/plain" })
			return res.end("Not Found")
		}
		const sessionHeader = req.headers["mcp-session-id"] ?? null
		if (req.method === "GET") {
			log({ method: "GET", session: sessionHeader, status: 405 })
			res.writeHead(405, { allow: "POST, DELETE" })
			return res.end()
		}
		if (req.method === "DELETE") {
			sessions.delete(sessionHeader)
			log({ method: "DELETE", session: sessionHeader, status: 200 })
			res.writeHead(200)
			return res.end()
		}
		if (req.method !== "POST") {
			res.writeHead(405, { allow: "POST, DELETE" })
			return res.end()
		}
		let body
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
		} catch {
			res.writeHead(400, { "content-type": "application/json" })
			return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }))
		}
		const batch = Array.isArray(body)
		const messages = batch ? body : [body]
		const headers = { "content-type": "application/json" }
		const responses = []
		for (const m of messages) {
			log({ method: "POST", rpc: m?.method ?? (m?.result !== undefined ? "response" : "?"), session: sessionHeader })
			if (m?.method === "initialize") {
				const sid = crypto.randomUUID()
				sessions.add(sid)
				headers["mcp-session-id"] = sid
			}
			if (m?.id === undefined || m?.id === null || typeof m?.method !== "string") continue // notification or response
			responses.push({ jsonrpc: "2.0", id: m.id, ...answer(m) })
		}
		if (!responses.length) {
			res.writeHead(202)
			return res.end()
		}
		res.writeHead(200, headers)
		res.end(JSON.stringify(batch ? responses : responses[0]))
	})
})

process.on("SIGTERM", () => process.exit(0))
server.listen(port, host, () => {
	console.log(`Starting mini MCP on http://${host}:${server.address().port}/mcp (Streamable HTTP, JSON responses)`)
})
server.on("error", (error) => {
	process.stderr.write(`mini-mcp: ${error.code ?? error.message}\n`)
	process.exit(1)
})
