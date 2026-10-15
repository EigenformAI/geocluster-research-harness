/**
 * Shared harness for the gateway's end-to-end tests: a gateway on a temp workspace with the fake
 * engine (test/fake-opencode.mjs) and the fake shared MCP (test/fake-mcp.mjs), plus a WebSocket ACP
 * client that sees every frame raw.
 */
import assert from "node:assert/strict"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { after } from "node:test"
import { ClientSideConnection } from "@agentclientprotocol/sdk"
import WebSocket from "ws"
import { loadConfig } from "../lib/config.js"
import { createLogger } from "../lib/log.js"
import { createServer } from "../server.js"
import { createCatalogArtifact } from "../lib/managed-catalog.js"
import { managedDiscovery } from "./managed-catalog-fixture.mjs"

const here = path.dirname(new URL(import.meta.url).pathname)
export const FAKE_ENGINE = path.join(here, "fake-opencode.mjs")
export const FAKE_MCP = path.join(here, "fake-mcp.mjs")
const silent = { log() {}, warn() {}, error() {} }

export async function tmpdir(prefix) {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}
// =============================================================================
// broker + bridge against the fake engine and the fake shared MCP
// =============================================================================

export function wsClient(port, secret, handlers = {}) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, "acp.jsonrpc.v1", { headers: secret ? { "x-gc-gate": secret } : {} })
	const updates = []
	const notices = []
	const permissions = []
	const arrivals = [] // updates and notices together, in arrival order
	const client = {
		requestPermission: async (params) => {
			permissions.push(params)
			return handlers.permission ? handlers.permission(params) : { outcome: { outcome: "selected", optionId: "once" } }
		},
		sessionUpdate: async (params) => {
			updates.push(params)
		},
		extNotification: async (method, params) => {
			// session/update arrives renamed (below), so the test sees every frame raw
			if (method === "_raw/session/update") {
				updates.push(params)
				arrivals.push({ kind: "update", sessionId: params.sessionId, seq: params.update?._meta?.seq, update: params.update })
			} else {
				notices.push({ method, params })
				arrivals.push({ kind: method, sessionId: params?.sessionId, seq: params?.seq, params })
			}
		},
	}
	// SDK 0.13.1 drops usage_update and strips messageId on the client side too; a browser on a newer
	// SDK keeps them. Rename session/update before the SDK parses it, so the tests see what was sent.
	const readable = new ReadableStream({
		start(controller) {
			ws.on("message", (data) => {
				const msg = JSON.parse(data.toString())
				controller.enqueue(msg.method === "session/update" ? { ...msg, method: "_raw/session/update" } : msg)
			})
			ws.on("close", () => {
				try {
					controller.close()
				} catch {
					// closed
				}
			})
		},
	})
	const writable = new WritableStream({ write: (m) => new Promise((r) => ws.send(JSON.stringify(m), () => r())) })
	const opened = new Promise((resolve, reject) => {
		ws.once("open", resolve)
		ws.once("error", reject)
		ws.once("unexpected-response", (_r, res) => reject(Object.assign(new Error("rejected"), { status: res.statusCode })))
	})
	const conn = new ClientSideConnection(() => client, { readable, writable })
	/** Everything this socket saw for one conversation, in arrival order, as [{kind, seq, …}]. */
	const stream = (sessionId) => arrivals.filter((e) => e.sessionId === sessionId && (e.kind === "update" || e.kind === "_gc/child_update" || e.kind === "_gc/turn_end"))
	const text = (sessionId) =>
		updates
			.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk" && !u.update._meta?.replay)
			.map((u) => u.update.content.text)
			.join("")
	const turnEnds = (sessionId) => notices.filter((n) => n.method === "_gc/turn_end" && n.params.sessionId === sessionId && !n.params.replay).map((n) => n.params)
	return { ws, conn, updates, notices, permissions, opened, stream, text, turnEnds, close: () => ws.close() }
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms))
export const until = async (fn, ms = 5000) => {
	const start = Date.now()
	while (!fn()) {
		if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
		await wait(20)
	}
}

export async function untilAsync(fn, ms = 5000) {
	const start = Date.now()
	while (!(await fn())) {
		if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
		await wait(20)
	}
}

/** Alive and not a zombie (a killed orphan stays in /proc until init reaps it). */
export async function running(pid) {
	try {
		process.kill(pid, 0)
	} catch {
		return false
	}
	const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
	return stat !== "" && stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
}

export async function freePort() {
	const server = net.createServer()
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address()
	await new Promise((resolve) => server.close(resolve))
	return port
}

export const say = (sessionId, text, _meta) => ({ sessionId, prompt: [{ type: "text", text }], ...(_meta ? { _meta } : {}) })

/** Every pid a gateway test started (engine, its server child, MCP); checked dead at the end. */
const startedPids = new Set()
after(async () => {
	const alive = []
	for (const pid of startedPids) if (await running(pid)) alive.push(pid)
	for (const pid of alive) process.kill(pid, "SIGKILL")
	assert.deepEqual(alive, [], "a gateway test left processes running")
})

/**
 * A gateway on a temp workspace with the fake engine (OPENCODE_BIN = a node wrapper that sets the
 * fake's knobs file) and the fake shared MCP. `env` overrides config; `memory` replaces the cgroup
 * reader; `knobs` go to the fake engine; `root` reuses a volume (a gateway restart); `seed(root,
 * config)` prepares state before boot. Returns helpers; everything is stopped and removed after.
 */
export async function startGateway(t, { env = {}, memory, knobs = {}, root: existingRoot, seed, start = true } = {}) {
	const root = existingRoot ?? (await tmpdir("gw-"))
	const workspace = path.join(root, "ws")
	await fs.mkdir(workspace, { recursive: true })
	await fs.writeFile(path.join(workspace, "hello.txt"), "hello world\nsecond line\n")
	const knobsFile = path.join(root, "knobs.json")
	const setKnobs = (value) => fsSync.writeFileSync(knobsFile, JSON.stringify(value))
	setKnobs(knobs)
	const bin = path.join(root, "opencode")
	await fs.writeFile(bin, `#!${process.execPath}\nprocess.env.FAKE_OPENCODE_KNOBS = ${JSON.stringify(knobsFile)}\nimport(${JSON.stringify(FAKE_ENGINE)})\n`, { mode: 0o755 })
	const secret = "s".repeat(32)
	const activityCalls = []
	const mcpPort = await freePort()
	const config = loadConfig({
		PROJECT_ID: "p1",
		WORKSPACE_DIR: workspace,
		RUNTIME_STATE_ROOT: path.join(root, "state"),
		RUNTIME_LOG_DIR: path.join(root, "logs"),
		OPENCODE_BIN: bin,
		RUNTIME_OPENCODE_CONFIG_DIR: path.join(root, "engine-config"),
		RUNTIME_TOOL_HOME: path.join(root, "toolhome"),
		RUNTIME_GATEWAY_PORT: "0",
		RUNTIME_MCP_CMD: process.execPath,
		RUNTIME_MCP_ARGS: FAKE_MCP,
		RUNTIME_MCP_CWD: here,
		RUNTIME_MCP_PORT: String(mcpPort),
		RUNTIME_MCP_DRAIN_MS: "200",
		RUNTIME_ENGINE_MCP_WAIT_S: "2",
		RUNTIME_ENGINE_TOOLS_SETTLE_MS: "50",
		RUNTIME_ENGINE_WATCH_MS: "100",
		RUNTIME_ENGINE_READY_WAIT_S: "10",
		RUNTIME_TREE_SNAPSHOT_MS: "100",
		RUNTIME_AGENT_INIT_TIMEOUT_S: "10",
		RUNTIME_PERMISSION_TIMEOUT_S: "3",
		RUNTIME_CANCEL_GRACE_S: "1",
		RUNTIME_CANCEL_REAP_MS: "300",
		RUNTIME_WS_PING_MS: "200", // production is 25 s; the keepalive subtest needs many ticks per second
		RUNTIME_ACTIVITY_URL: "http://activity.test/x",
		RUNTIME_ACTIVITY_TOKEN: "tok",
		RUNTIME_ACTIVITY_INTERVAL_S: "1",
		RUNTIME_REPORT_EXPORT: "1",
		RUNTIME_PANDOC_BIN: path.join(root, "no-pandoc"), // conversions fail (logged); the .md is what the tests check
		PATH: process.env.PATH,
		LANG: "C.UTF-8",
		IDE_LLM_TOKEN: "llm-token",
		LLM_PROXY_URL: "http://proxy.test/llm",
		// must never reach the engine or the MCP
		IDE_PROXY_KEY: "gate-key",
		R2_SECRET_ACCESS_KEY: "r2-secret",
		IDE_DATASET_TOKEN: "ds-token",
		...env,
	})
	config.managedCatalog = createCatalogArtifact(managedDiscovery(), { backendBaseUrl: config.managedBackendBaseUrl, projectId: config.projectId, runtimeGeneration: config.runtimeGeneration })
	await seed?.(root, config)
	const logger = createLogger("test", silent)
	const app = await createServer({ config, secret, logger, memory: memory ?? (async () => null) })
	// Ordinary gateway tests use a scripted account, never the network. Account-boundary
	// tests supply an explicit LLM_PROXY_URL and exercise their real loopback server.
	if (!Object.hasOwn(env, "LLM_PROXY_URL")) app.broker.accountUsage.fetch = async () => new Response(JSON.stringify(config.managedCatalog?.catalog ?? managedDiscovery([])))
	app.broker.activity.fetch = async (_url, init) => {
		activityCalls.push(JSON.parse(init.body))
		return { ok: true, status: 200 }
	}
	app.broker.engine.on("ready", () => {
		startedPids.add(app.broker.engine.pid)
		const serverPid = app.broker.engine.agentInfo?._meta?.serverPid
		if (serverPid) startedPids.add(serverPid)
	})
	app.broker.mcp.on("ready", ({ pid }) => pid && startedPids.add(pid))
	const port = await new Promise((resolve) => app.server.listen(0, "127.0.0.1", () => resolve(app.server.address().port)))
	t.after(async () => {
		await app.shutdown()
		if (!existingRoot) await fs.rm(root, { recursive: true, force: true })
	})
	if (start) await app.broker.start()
	const get = (p, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { "x-gc-gate": secret, ...headers } })
	const client = async (handlers) => {
		const c = wsClient(port, secret, handlers)
		await c.opened
		await c.conn.initialize({ protocolVersion: 1, clientCapabilities: {} })
		t.after(() => c.close())
		return c
	}
	const engineMeta = () => app.broker.engine.agentInfo?._meta
	const readLog = async (sessionId) =>
		(await fs.readFile(path.join(config.gatewayStateDir, "sessions", sessionId, "events.ndjson"), "utf8"))
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
	return { app, config, root, workspace, port, secret, activityCalls, get, client, engineMeta, readLog, setKnobs }
}
