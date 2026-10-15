/**
 * Engine contract test (opt-in): the REAL gateway (server.js createServer, driven through its WebSocket like a
 * browser) against the REAL engine (`$OPENCODE_BIN acp`, OpenCode 2.0.x) on a temp copy of opencode/config, with the
 * scripted fake LLM (fake-llm.mjs) as LLM_PROXY_URL. No real model, no token.
 *
 * Why: the gateway's unit and e2e tests run against test/fake-opencode.mjs. This file checks that the real engine
 * still behaves the way that fake (and the broker) assume, on everything the broker relies on: readiness and the MCP
 * stderr lines, session/new + set_mode per agent, the turn frames (seq, usage_update, messageId, turn_end), specialist
 * child_update frames and their linking, forced-foreground subagents, cancel, provider errors, permissions from a
 * specialist, engine restarts with lazy resume, the RE-4 correction prompt and the report export, and resource_link
 * filtering; plus the s43 review's regressions on the real engine (SEC-1 URI encoding, SEC-3 attachment limits,
 * CT-3 cancel in the retry backoff, LC-1 detached jobs, CONC-2/CT-1 resumed subagents). Run it on every engine re-pin.
 *
 *   cd runtime && OPENCODE_BIN=/path/to/opencode npm run test:engine
 *
 * Without OPENCODE_BIN (or when it isn't an executable file) every test is skipped. Linux only (/proc).
 * MCP variants: `mini` (mini-mcp.mjs: a real Streamable HTTP MCP, the engine connects), `fake` (test/fake-mcp.mjs:
 * /healthz only, so the real engine's connect fails), `closed` (the MCP never starts: nothing listens), `hung` (a
 * stub supervisor whose URL accepts connections and never answers).
 * Every process the gateways start is tracked by pid + start time and checked gone after each gateway's shutdown.
 * Later-turn resumed-subagent progress requires the GeoCluster patch on the upstream 2.0.19 engine.
 */
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadConfig } from "../../lib/config.js"
import { createLogger } from "../../lib/log.js"
import { createServer } from "../../server.js"
import { FAKE_MCP, freePort, say, until, untilAsync, wsClient } from "../gateway-harness.mjs"
import { CONFIG_DIR, alive, descendants, procInfo } from "./engine.mjs"
import { plan, startFakeLlm, textOf } from "./fake-llm.mjs"
import { TEST_MANAGED_CATALOG } from "./managed-fixture.mjs"
import { materializeProfile } from "../../../opencode/scripts/build-config.mjs"
import { createCatalogArtifact, catalogIdentity } from "../../lib/managed-catalog.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const MINI_MCP = path.join(here, "mini-mcp.mjs")
const BIN = process.env.OPENCODE_BIN || ""

function skipReason() {
	const how = "run: cd runtime && OPENCODE_BIN=/path/to/opencode npm run test:engine (the OpenCode 2.0.x CLI binary)"
	if (process.platform !== "linux") return `the engine contract test needs Linux (/proc); ${how}`
	if (!BIN) return `OPENCODE_BIN is not set; ${how}`
	try {
		const stat = fsSync.statSync(BIN)
		fsSync.accessSync(BIN, fsSync.constants.X_OK)
		if (!stat.isFile()) throw new Error("not a file")
	} catch {
		return `OPENCODE_BIN=${BIN} is not an executable file; ${how}`
	}
	return false
}
const skip = skipReason()

// ---- helpers ------------------------------------------------------------------------------------------------------

const lastUserText = (body) => textOf([...(body?.messages ?? [])].reverse().find((m) => m.role === "user")?.content)
const allText = (body) => (body?.messages ?? []).map((m) => `${m.role}: ${textOf(m.content)}`).join("\n")

/** One browser-visible event as a short token for turn-boundary assertions. */
function token(u) {
	switch (u?.sessionUpdate) {
		case "user_message_chunk":
			return "user"
		case "agent_message_chunk":
			return u._meta?.gateway ? `agent(${u._meta.gateway})` : "agent"
		case "tool_call":
			return `tool_call:${u.status}:${u.kind}:${u.title}`
		case "tool_call_update":
			return `tool:${u.status}`
		case "usage_update":
			return "usage"
		case "session_info_update":
			// the engine's provider-retry notice, and the gateway's own "retry over" at a turn end
			if (u._meta?.gateway === "retry_cleared") return "retry:cleared"
			if (u._meta && "opencode/retry" in u._meta) return u._meta["opencode/retry"] ? "retry" : "retry:null"
			return "session_info"
		default:
			return String(u?.sessionUpdate)
	}
}

/**
 * What one socket saw of a conversation (live frames only), in seq order, as tokens. Consecutive agent chunks of the
 * same party collapse into one: how many chunks the engine sends for one streamed answer is timing (it coalesces
 * deltas), not contract. `afterSeq` keeps only the frames after it (one turn of a longer conversation).
 */
function project(client, sessionId, afterSeq = 0) {
	const out = []
	const events = client
		.stream(sessionId)
		.filter((e) => !(e.update?._meta?.replay || e.params?.replay) && (!afterSeq || e.seq > afterSeq))
		.sort((a, b) => a.seq - b.seq)
	for (const e of events) {
		let tok
		if (e.kind === "update") tok = token(e.update)
		else if (e.kind === "_gc/child_update") tok = `c${e.params.child.depth}:${e.params.type === "status" ? e.params.status : token(e.params.update)}`
		else tok = `end:${e.params.stopReason}${e.params._meta?.reason ? `:${e.params._meta.reason}` : ""}`
		if (/(^|:)agent$/.test(tok) && out[out.length - 1] === tok) continue
		out.push(tok)
	}
	return out
}

/** Exact browser-visible ancestry and call identity, plus text ordered before the child's completion. */
function assertChildRun(frames, rootSessionId, child, { resumed = false } = {}) {
	assert.ok(frames.length > 0, `missing progress for ${resumed ? "resumed" : "fresh"} child ${child.sessionId}`)
	for (const frame of frames) {
		assert.equal(frame.sessionId, rootSessionId, "every child frame belongs to the correct root")
		assert.deepEqual(frame.child, child, `child identity at seq ${frame.seq}`)
	}
	assert.deepEqual(frames.filter((f) => f.type === "status" && !f.relinked).map((f) => f.status), resumed ? ["running", "completed"] : ["created", "running", "completed"])
	assert.equal(frames.filter((f) => f.relinked).length, 0, "links are correct while work runs, without completion-time correction")
	const text = frames.filter((f) => f.update?.sessionUpdate === "agent_message_chunk")
	assert.ok(text.length > 0, "child text streams")
	const completed = frames.find((f) => f.status === "completed")
	assert.ok(text.every((f) => f.seq < completed.seq), "all child text precedes its completed status")
	assert.ok(text.every((f) => f.update.messageId && f.update._meta?.["opencode/child-session"]?.id === child.sessionId), "text has a message id and the correct child identity")
}

/** Remove only transport replay markers; every other payload field must survive replay unchanged. */
function replayPayload(event) {
	const value = structuredClone(event)
	if (value.update?._meta) delete value.update._meta.replay
	if (value.params) delete value.params.replay
	return value
}

/** Live processes (procInfo) whose environ has `key=value` and whose cmdline matches `cmd`: the whole table. */
function processesWithEnv(key, value, cmd = /./) {
	const out = []
	for (const d of fsSync.readdirSync("/proc")) {
		if (!/^\d+$/.test(d)) continue
		const p = procInfo(Number(d))
		if (!p || p.state === "Z" || !cmd.test(p.cmd)) continue
		let env = []
		try {
			env = fsSync.readFileSync(`/proc/${d}/environ`, "utf8").split("\0")
		} catch {
			continue // another uid's process, or gone
		}
		if (env.includes(`${key}=${value}`)) out.push(p)
	}
	return out
}

/** A stand-in McpSupervisor for the `hung` case: its URL accepts TCP connections and never answers. */
class HungMcp extends EventEmitter {
	constructor(url) {
		super()
		this.url = url
		this.state = "starting"
		this.pid = null
		this.lastHealth = null
	}
	async start() {
		throw Object.assign(new Error("stub MCP: /healthz never answers"), { code: "MCP_START_TIMEOUT" })
	}
	async stop() {
		this.state = "stopped"
	}
}

/**
 * A gateway on a temp workspace with the real engine. Returns helpers; on teardown the gateway is shut down, every
 * tracked process must be gone (left ones are SIGKILLed and the test fails), and the temp dir is removed.
 *   mcp          "mini" | "fake" | "closed" | "hung"
 *   env          config overrides (loadConfig keys)
 *   patchConfig  (opencode.json object) => void, applied to the temp config copy
 */
async function startRealGateway(t, { mcp = "mini", env = {}, patchConfig, chunkGapMs = 0 } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-engine-"))
	// Registered first, so a setup that fails half way still stops what it started and removes the temp dir
	const made = { app: null, llm: null, hung: null, sockets: [], procs: [], track: () => {} }
	t.after(async () => {
		for (const c of made.sockets) c.close()
		if (made.app) {
			made.track(made.app.broker.engine.pid) // tool processes still under the engine, if any
			await made.app.shutdown()
		}
		await made.llm?.close()
		if (made.hung) {
			for (const s of made.hung.sockets) s.destroy()
			await new Promise((resolve) => made.hung.close(resolve))
		}
		const left = made.procs.filter(alive)
		for (const p of left) {
			try {
				process.kill(p.pid, "SIGKILL")
			} catch {}
		}
		await fs.rm(root, { recursive: true, force: true })
		assert.deepEqual(
			left.map((p) => `${p.pid} ${p.cmd.slice(0, 120)}`),
			[],
			"the gateway left processes running after shutdown",
		)
	})
	const workspace = path.join(root, "ws")
	await fs.mkdir(workspace, { recursive: true })
	await fs.writeFile(path.join(workspace, "hello.txt"), "hello world\nsecond line\n")
	const engineConfig = path.join(root, "engine-config")
	await fs.cp(CONFIG_DIR, engineConfig, { recursive: true })
	materializeProfile("managed", { directory: engineConfig, catalog: TEST_MANAGED_CATALOG })
	// The engine discovers flat plugins under CONFIG_DIR as well as explicit entries.
	// Generated profile wrappers point at the shipped sources, so don't double-load copies.
	for (const name of await fs.readdir(path.join(engineConfig, "plugins"))) if (name.endsWith(".js")) await fs.rm(path.join(engineConfig, "plugins", name))
	if (patchConfig) {
		const file = path.join(engineConfig, "opencode.json")
		const json = JSON.parse(await fs.readFile(file, "utf8"))
		patchConfig(json)
		await fs.writeFile(file, JSON.stringify(json, null, "\t"))
	}
	const llm = await startFakeLlm({ log: path.join(root, "llm.ndjson"), chunkGapMs, discovery: TEST_MANAGED_CATALOG })
	made.llm = llm

	// gateway log lines, in memory (dumped into a failing assertion's message by step())
	const lines = []
	const lineWaiters = new Set()
	const push = (line) => {
		lines.push(line)
		for (const w of lineWaiters) if (w.re.test(line)) (lineWaiters.delete(w), w.resolve(line))
	}
	const logger = createLogger("engine-test", { log: push, warn: push, error: push })
	const waitLog = (re, ms = 30000) => {
		const hit = lines.find((l) => re.test(l))
		if (hit) return Promise.resolve(hit)
		return new Promise((resolve, reject) => {
			const w = { re, resolve }
			lineWaiters.add(w)
			setTimeout(() => lineWaiters.delete(w) && reject(new Error(`no gateway log line matching ${re} in ${ms} ms`)), ms).unref()
		})
	}

	const mcpPort = await freePort()
	let stub = null
	let hung = null
	const mcpEnv = { RUNTIME_MCP_PORT: String(mcpPort), RUNTIME_MCP_CWD: here, RUNTIME_MCP_START_TIMEOUT_S: "15", RUNTIME_MCP_DRAIN_MS: "200" }
	if (mcp === "mini") Object.assign(mcpEnv, { RUNTIME_MCP_CMD: process.execPath, RUNTIME_MCP_ARGS: MINI_MCP })
	else if (mcp === "fake") Object.assign(mcpEnv, { RUNTIME_MCP_CMD: process.execPath, RUNTIME_MCP_ARGS: FAKE_MCP })
	else if (mcp === "closed") Object.assign(mcpEnv, { RUNTIME_MCP_CMD: process.execPath, RUNTIME_MCP_ARGS: "-e process.exit(3)" })
	else if (mcp === "hung") {
		const sockets = new Set()
		hung = net.createServer((s) => (sockets.add(s), s.on("close", () => sockets.delete(s)), s.on("error", () => {})))
		hung.sockets = sockets
		made.hung = hung
		await new Promise((resolve) => hung.listen(mcpPort, "127.0.0.1", resolve))
		stub = new HungMcp(`http://127.0.0.1:${mcpPort}/mcp`)
	} else throw new Error(`unknown mcp variant ${mcp}`)

	const config = loadConfig({
		PROJECT_ID: "engine-contract",
		WORKSPACE_DIR: workspace,
		RUNTIME_STATE_ROOT: path.join(root, "state"),
		RUNTIME_LOG_DIR: path.join(root, "logs"),
		OPENCODE_BIN: BIN,
		RUNTIME_OPENCODE_CONFIG_DIR: engineConfig,
		RUNTIME_TOOL_HOME: path.join(root, "toolhome"),
		RUNTIME_GATEWAY_PORT: "0",
		...mcpEnv,
		RUNTIME_ENGINE_MCP_WAIT_S: "20",
		RUNTIME_ENGINE_WATCH_MS: "500",
		RUNTIME_ENGINE_READY_WAIT_S: "30",
		RUNTIME_TREE_SNAPSHOT_MS: "500",
		RUNTIME_AGENT_INIT_TIMEOUT_S: "30",
		RUNTIME_PERMISSION_TIMEOUT_S: "60",
		RUNTIME_CANCEL_GRACE_S: "5",
		RUNTIME_CANCEL_REAP_MS: "300",
		RUNTIME_REPORT_EXPORT: "1",
		RUNTIME_PANDOC_BIN: path.join(root, "no-pandoc"), // conversions fail (logged); the .md is what is checked
		PATH: process.env.PATH,
		LANG: "C.UTF-8",
		IDE_LLM_TOKEN: "fake-token",
		LLM_PROXY_URL: llm.url,
		...env,
	})
	config.managedCatalog = createCatalogArtifact(TEST_MANAGED_CATALOG, catalogIdentity(config))
	const secret = "e".repeat(32)
	const app = await createServer({ config, secret, logger, memory: async () => null, ...(stub ? { mcp: stub } : {}) })
	made.app = app

	// every process a gateway starts, by pid + start time (a reused pid never matches)
	const procs = made.procs
	const track = (made.track = (pid) => {
		if (!pid) return
		for (const p of [procInfo(pid), ...descendants(pid)]) if (p && !procs.some((q) => q.pid === p.pid && q.start === p.start)) procs.push(p)
	})
	const readyAt = []
	app.broker.engine.on("ready", (info) => {
		readyAt.push({ generation: info.generation, tools: info.tools, t: Date.now() })
		track(app.broker.engine.pid)
	})
	app.broker.mcp.on("ready", ({ pid } = {}) => track(pid))

	const port = await new Promise((resolve) => app.server.listen(0, "127.0.0.1", () => resolve(app.server.address().port)))
	const client = async (handlers) => {
		const c = wsClient(port, secret, handlers)
		made.sockets.push(c)
		await c.opened
		await c.conn.initialize({ protocolVersion: 1, clientCapabilities: {} })
		return c
	}
	const startedAt = Date.now()
	const started = app.broker.start()
	const stderrLog = path.join(config.logDir, "agent.stderr.log")
	const mcpLog = path.join(config.logDir, "mcp.log")
	const readFile = (file) => fs.readFile(file, "utf8").catch(() => "")
	/**
	 * Model requests that carry this conversation's id in x-opencode-session: the root agent's, and its depth-1
	 * children's (a child sends its PARENT's id, measured). `agent` keeps one agent's (by system prompt).
	 */
	const calls = (sessionId, agent) =>
		llm.requests.filter((r) => r.session === sessionId && !r.aux && r.response?.kind !== "not-found" && (!agent || r.agent === agent))
	const readLog = async (sessionId) =>
		(await fs.readFile(path.join(config.gatewayStateDir, "sessions", sessionId, "events.ndjson"), "utf8"))
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
	return { app, config, root, workspace, port, llm, lines, waitLog, client, started, startedAt, readyAt, stderrLog, mcpLog, readFile, calls, readLog, procs }
}

test("model-specific reasoning choices reach clients and xhigh/max reach the provider on the pinned engine", { skip, timeout: 60000 }, async (t) => {
	const g = await startRealGateway(t)
	await g.started
	const client = await g.client()
	const status = await client.conn.extMethod("_gc/status", {})
	const created = await client.conn.newSession({ cwd: "", mcpServers: [] })
	const effort = (options) => options.find((o) => o.id === "effort")
	assert.deepEqual(effort(created.configOptions).options.map((o) => o.value), ["none", "low", "medium", "high", "xhigh", "max", "default"])
	assert.deepEqual(created.configOptions, status.newSession.configOptions)
	assert.equal(effort(created.configOptions).currentValue, "high")
	for (const value of ["xhigh", "max"]) {
		const changed = await client.conn.unstable_setSessionConfigOption({ sessionId: created.sessionId, configId: "effort", value })
		assert.equal(effort(changed.configOptions).currentValue, value)
		await client.conn.prompt(say(created.sessionId, "SAY effort applied"))
		assert.equal(g.calls(created.sessionId, "geology").at(-1).body.reasoning.effort, value)
		const pushed = client.updates.filter((u) => u.sessionId === created.sessionId && u.update.sessionUpdate === "config_option_update").at(-1)
		assert.deepEqual(pushed.update.configOptions, changed.configOptions)
	}
})

test("real gateway effort reconciliation reports a persisted supplier-default reset without replaying work", { skip, timeout: 60000 }, async (t) => {
	const modelId = "proxy/z-ai/glm-5.3-flash"
	const g = await startRealGateway(t, { patchConfig(config) {
		config.providers.proxy.models["z-ai/glm-5.3-flash"].variants.push({ id: "retired", settings: { reasoning: { effort: "high" } } })
	} })
	await g.started
	const a = await g.client(), b = await g.client()
	const { sessionId } = await a.conn.newSession({ cwd: "", mcpServers: [] })
	await a.conn.unstable_setSessionConfigOption({ sessionId, configId: "model", value: modelId })
	await a.conn.unstable_setSessionConfigOption({ sessionId, configId: "effort", value: "retired" })
	await a.conn.prompt(say(sessionId, "SAY retained reconciliation history"))
	await b.conn.extMethod("_gc/attach", { sessionId, afterSeq: 0 })
	const file = path.join(g.config.engineConfigDir, "opencode.json")
	const config = JSON.parse(await fs.readFile(file, "utf8"))
	config.providers.proxy.models["z-ai/glm-5.3-flash"].variants = config.providers.proxy.models["z-ai/glm-5.3-flash"].variants.filter((variant) => variant.id !== "retired")
	await fs.writeFile(file, JSON.stringify(config))
	await g.app.broker.engine.restart("effort reconciliation test")
	const before = g.llm.requests.length
	const response = await a.conn.unstable_resumeSession({ sessionId, cwd: "", mcpServers: [] })
	assert.equal(response.configOptions.find((option) => option.id === "effort").currentValue, "default", "restoration must not replace supplier default with RUNTIME_DEFAULT_EFFORT=high")
	assert.equal(response.models.currentModelId, modelId)
	assert.deepEqual(g.llm.requests.slice(before).filter((request) => request.method === "POST"), [], "account discovery may refresh, but restoration cannot submit a model request")
	const notices = (client) => client.notices.filter((notice) => notice.method === "_gc/notice" && notice.params.kind === "effort_reset")
	await until(() => notices(a).length === 1 && notices(b).length === 1)
	assert.deepEqual(notices(a)[0].params.reset, { modelId, previousEffort: "retired", effort: "default" })
	assert.match(notices(a)[0].params.message, /retired.*supplier default/i)
	await b.conn.extMethod("_gc/attach", { sessionId, afterSeq: 0 })
	assert.equal(notices(b).length, 1)
	assert.ok(b.updates.some((frame) => frame.update._meta?.replay && frame.update._meta["geocluster/effort-reset"]?.previousEffort === "retired"))
	assert.equal((await a.conn.prompt(say(sessionId, "SAY explicit repaired continuation"))).stopReason, "end_turn")
	const request = g.calls(sessionId, "geology").at(-1).body
	assert.equal(request.reasoning?.effort, undefined)
	assert.ok(JSON.stringify(request.messages).includes("retained reconciliation history"))
	await g.app.broker.engine.restart("verify reconciliation persistence")
	assert.equal((await a.conn.unstable_resumeSession({ sessionId, cwd: "", mcpServers: [] })).configOptions.find((option) => option.id === "effort").currentValue, "default")
	assert.equal(notices(a).length, 1)
})

/** A subtest whose failure message carries the gateway log tail and the engine's MCP lines. */
function step(t, g, name, fn, options = {}) {
	return t.test(name, options, async (st) => {
		try {
			await fn(st)
		} catch (error) {
			const stderr = (await g.readFile(g.stderrLog))
				.split("\n")
				.filter((l) => /mcp|ERROR|WARN|\[result-protocol\]|\[retry-policy\]/.test(l) && !/watcher/.test(l))
				.slice(-15)
			error.message += `\n--- gateway log (last 25) ---\n${g.lines.slice(-25).join("\n")}\n--- engine stderr (mcp/warn/error, last 15) ---\n${stderr.join("\n")}`
			throw error
		}
	})
}

// =====================================================================================================================
// boot: the MCP readiness lines the supervisor waits for
// =====================================================================================================================

test("boot, MCP closed: the engine logs `mcp connect failed`, is ready at once with tools missing, no restart", { skip, timeout: 60000 }, async (t) => {
	const g = await startRealGateway(t, { mcp: "closed" })
	await g.started
	assert.equal(g.app.broker.engine.state, "ready")
	const ready = g.readyAt[0]
	assert.equal(ready.tools, "missing")
	const readyMs = ready.t - g.startedAt
	t.diagnostic(`ready in ${readyMs} ms (engineMcpWaitMs ${g.config.engineMcpWaitMs} ms)`)
	assert.ok(readyMs < g.config.engineMcpWaitMs - 5000, "the definitive `connect failed` line ends the wait, not engineMcpWaitMs")
	await untilAsync(async () => /message="mcp connect failed" server=geocluster .*status\.error="Unable to connect/.test(await g.readFile(g.stderrLog)), 5000)
	const body = await (await fetch(`http://127.0.0.1:${g.port}/readyz`)).json()
	assert.equal(body.ready, true)
	assert.equal(body.components.engine.tools, "missing")
	assert.notEqual(body.components.mcp.state, "ready")

	const c = await g.client()
	const { sessionId } = await c.conn.newSession({ cwd: "", mcpServers: [] })
	assert.equal((await c.conn.prompt(say(sessionId, "SAY no tools"))).stopReason, "end_turn")
	assert.deepEqual(g.calls(sessionId, "geology")[0].tools.sort(), ["glob", "read", "subagent"], "geology without its geocluster tools")
	assert.equal(g.app.broker.engine.generation, 1, "an MCP that is not ready never triggers the tools restart")
})

test("boot, MCP hung: no MCP line at all, ready after engineMcpWaitMs with tools missing", { skip, timeout: 60000 }, async (t) => {
	const g = await startRealGateway(t, { mcp: "hung", env: { RUNTIME_ENGINE_MCP_WAIT_S: "3" } })
	await g.started
	const ready = g.readyAt[0]
	const readyMs = ready.t - g.startedAt
	t.diagnostic(`ready in ${readyMs} ms (engineMcpWaitMs ${g.config.engineMcpWaitMs} ms)`)
	assert.equal(ready.tools, "missing")
	assert.ok(readyMs >= g.config.engineMcpWaitMs, `ready only once the wait expired (${readyMs} ms)`)
	assert.ok(readyMs < g.config.engineMcpWaitMs + 4000, `and soon after it (${readyMs} ms)`)
	await g.waitLog(/no "mcp connected" line from the engine in time/)
	assert.doesNotMatch(await g.readFile(g.stderrLog), /message="mcp connect/, "the engine said nothing yet (its own startup timeout is 30 s)")
})

test("boot, test/fake-mcp.mjs (no /mcp): the real engine's connect fails `Not Found`; tools missing; the broker's tools restart", { skip, timeout: 90000 }, async (t) => {
	const g = await startRealGateway(t, { mcp: "fake" })
	await g.started
	const broker = g.app.broker
	/** Any tools restart the broker started has finished (it sets toolsRestart.running synchronously when it starts one). */
	const settled = () => !broker.toolsRestart.running && broker.engine.state === "ready"

	await step(t, g, "connect fails `Error POSTing to endpoint: Not Found` (fake-mcp serves /healthz only); MCP ready + tools missing → one engine restart while idle", async () => {
		assert.equal(g.readyAt[0].tools, "missing", "unlike fake-opencode.mjs, which reports `mcp connected` whenever /healthz answers")
		await untilAsync(async () => /message="mcp connect failed" server=geocluster .*status\.error="Error POSTing to endpoint: Not Found"/.test(await g.readFile(g.stderrLog)), 5000)
		await untilAsync(async () => g.readyAt.length >= 2 && settled(), 20000)
		assert.deepEqual(g.readyAt.slice(0, 2).map((r) => `${r.generation}:${r.tools}`), ["1:missing", "2:missing"])
		assert.ok(g.lines.some((l) => /restarting the engine to connect the geocluster tools/.test(l)))
		const handshakes = async () => (await g.readFile(g.mcpLog)).match(/FAKE_MCP_UNEXPECTED POST \/mcp/g)?.length ?? 0
		await untilAsync(async () => (await handshakes()) === g.readyAt.length, 5000) // one failed MCP handshake per engine process
	})

	await step(
		t,
		g,
		"a tools restart that ends with the tools missing again is retried while idle, at most 3 per 10 min, then the broker gives up",
		async () => {
			// The engine restarts as soon as no turn is running.
			await untilAsync(async () => g.readyAt.length >= 4 && settled(), 10000) // a restart takes ~2.2 s here
			await g.waitLog(/geocluster tools still missing after repeated engine restarts; giving up/, 5000)
		},
	)
	t.diagnostic(`engine processes so far: ${g.readyAt.map((r) => `${r.generation}:${r.tools}`).join(", ")}`)

	await step(t, g, "the engine still serves prompts without the tools; a restart a turn end triggers is waited for", async () => {
		const c = await g.client()
		const { sessionId } = await c.conn.newSession({ cwd: "", mcpServers: [] })
		assert.equal((await c.conn.prompt(say(sessionId, "SAY still usable"))).stopReason, "end_turn")
		assert.deepEqual(g.calls(sessionId, "geology")[0].tools.sort(), ["glob", "read", "subagent"])
		const before = g.readyAt.length
		await untilAsync(async () => settled(), 20000) // with the bug above, this turn's end restarts the engine now
		t.diagnostic(`restarts triggered by the turn's end: ${g.readyAt.length - before}`)
	})
})

test("shutdown during an engine restart leaves no engine running", { skip, timeout: 60000 }, async (t) => {
	const g = await startRealGateway(t, { mcp: "closed" })
	await g.started
	const engine = g.app.broker.engine
	await step(
		t,
		g,
		"app.shutdown() while engine.restart() is stopping the old process",
		async () => {
			const restarting = engine.restart("contract test: shutdown race").then(
				() => "started",
				(error) => `rejected: ${error?.message ?? error}`,
			)
			await g.app.shutdown()
			const outcome = await restarting
			const leaked = engine.pid
			t.diagnostic(`restart outcome after shutdown: ${outcome}; engine state ${engine.state}, pid ${leaked}`)
			if (leaked) await engine.stop() // cleanup, so the teardown's process check stays meaningful
			assert.equal(leaked, null, `an engine was started after shutdown (${outcome})`)
		},
	)
})

// =====================================================================================================================
// the main contract: one gateway, one real engine, the mini MCP connected
// =====================================================================================================================

test("real engine through the gateway: the contract the broker relies on", { skip, timeout: 150000 }, async (t) => {
	const g = await startRealGateway(t, { mcp: "mini" })
	await g.started
	const { app, llm, workspace } = g
	const a = await g.client({ permission: () => new Promise(() => {}) })

	await step(t, g, "boot: ready after `mcp connected server=geocluster` + settle; api 3 readyz; the engine's identity", async () => {
		const ready = g.readyAt[0]
		assert.equal(ready.tools, "connected")
		t.diagnostic(`ready in ${ready.t - g.startedAt} ms, engine ${app.broker.engine.agentInfo?.version}`)
		const stderr = await g.readFile(g.stderrLog)
		assert.match(stderr, /level=INFO .*message="mcp connected" server=geocluster tools=4/)
		const mcpLog = await g.readFile(g.mcpLog)
		for (const rpc of ["initialize", "notifications/initialized", "tools/list"]) assert.ok(mcpLog.includes(`"rpc":"${rpc}"`), `the engine sent ${rpc}`)
		const body = await (await fetch(`http://127.0.0.1:${g.port}/readyz`)).json()
		assert.equal(body.ready, true)
		assert.equal(body.components.engine.state, "ready")
		assert.equal(body.components.engine.tools, "connected")
		assert.equal(body.components.engine.generation, 1)
		assert.match(String(body.components.engine.version), /^2\./)
		assert.equal(body.components.mcp.state, "ready")
		const init = await a.conn.initialize({ protocolVersion: 1, clientCapabilities: {} })
		assert.equal(init.agentInfo.name, "OpenCode")
		assert.deepEqual(init.agentCapabilities.promptCapabilities, { embeddedContext: true, image: true })
		assert.equal(app.broker.engine.agentCapabilities._meta["opencode/child-session-updates"], true)
	})

	await step(t, g, "session/new per agentMode: set_mode reaches the engine (the model request's system prompt is that agent's), run-dir brief = the gateway's runDir, tools per agent", async () => {
		const expectTools = {
			// L1-1: no grep for geology (its permission is checked against the pattern, not the path; 2026-10-02)
			geology: ["geocluster_check_missing", "geocluster_list_files", "geocluster_summarize_provenance", "glob", "read", "subagent"],
			"report-analysis": ["geocluster_check_missing", "geocluster_list_files", "geocluster_summarize_provenance", "glob", "grep", "read", "subagent"],
			// `*:* allow`: OpenCode's built-ins plus EVERY tool the geocluster MCP serves (mini-mcp has 4; production 56)
			standard: ["edit", "geocluster_check_missing", "geocluster_inspect_dataset", "geocluster_list_files", "geocluster_summarize_provenance", "glob", "grep", "read", "shell", "skill", "webfetch", "write"],
		}
		for (const mode of ["geology", "report-analysis", "standard"]) {
			const created = await a.conn.newSession({ cwd: "/ignored", mcpServers: [], _meta: { agentMode: mode } })
			const sessionId = created.sessionId
			assert.match(sessionId, /^ses_[A-Za-z0-9]+$/)
			assert.equal(created._meta.runDir, `runs/${sessionId}`)
			assert.equal(created.modes, null)
			assert.deepEqual(created.configOptions.map((o) => o.id), ["model", "effort"])
			assert.equal(created.models.currentModelId, "proxy/openai/gpt-6-luna")
			assert.equal(created.configOptions.find((o) => o.id === "model").currentValue, "proxy/openai/gpt-6-luna")
			assert.ok(created.models.availableModels.some((m) => m.modelId === "proxy/openai/gpt-6-luna"))
			assert.ok(created.models.availableModels.some((m) => m.modelId === "proxy/z-ai/glm-5.3-flash"))
			const attached = await a.conn.extMethod("_gc/attach", { sessionId, afterSeq: 0 })
			assert.equal(attached.lastSeq, 0, "available_commands_update (sent before the session/new response) is dropped, not logged")
			assert.equal((await a.conn.prompt(say(sessionId, `SAY hello from ${mode}`))).stopReason, "end_turn")
			const [first] = g.calls(sessionId) // a fresh conversation: its first model request is the root agent's
			assert.equal(first.body.model, "openai/gpt-6-luna", `${mode}: first prompt uses the global default`)
			assert.equal(first.agent, mode, `the engine ran the ${mode} agent`)
			assert.match(textOf(first.body.messages[0].content), new RegExp(`runs/${sessionId}/`), "the run-dir brief names the gateway's run folder")
			assert.deepEqual([...first.tools].sort(), expectTools[mode], `${mode}: tools offered on the first prompt after ready`)
			assert.equal(a.text(sessionId), `hello from ${mode}`)
		}
	})

	await step(t, g, "a SAY turn: echo + submissionId, agent text with messageId, one usage_update, turn_end, the result's usage", async () => {
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		const turn = await a.conn.prompt(say(sessionId, "SAY hi there", { submissionId: "sub-real-1" }))
		assert.equal(turn.stopReason, "end_turn")
		assert.equal(turn._meta.submissionId, "sub-real-1")
		assert.deepEqual(turn.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
		await until(() => a.turnEnds(sessionId).length === 1)
		const ups = a.updates.filter((u) => u.sessionId === sessionId).map((u) => u.update)
		const echo = ups[0]
		const chunks = ups.filter((u) => u.sessionUpdate === "agent_message_chunk")
		const usage = ups.at(-1)
		assert.equal(echo.sessionUpdate, "user_message_chunk")
		assert.equal(echo._meta.submissionId, "sub-real-1")
		assert.equal(usage.sessionUpdate, "usage_update", "one usage_update, last, just before the result")
		assert.equal(ups.filter((u) => u.sessionUpdate === "usage_update").length, 1)
		assert.equal(ups.length, chunks.length + 2, "nothing else: no echo of the prompt, no title push")
		assert.deepEqual(ups.map((u) => u._meta.seq), ups.map((_, i) => i + 1), "seq 1..n in the gateway's order")
		assert.equal(chunks.map((c) => c.content.text).join(""), "hi there")
		t.diagnostic(`SAY arrived as ${chunks.length} agent chunk(s)`)
		assert.ok(chunks.every((c) => /^msg_[A-Za-z0-9]{26}$/.test(c.messageId)), "messageId arrives (the stream shim keeps it)")
		assert.equal(new Set(chunks.map((c) => c.messageId)).size, 1, "one assistant message, one messageId")
		assert.deepEqual({ used: usage.used, size: usage.size, cost: usage.cost }, { used: 15, size: 1050000, cost: { amount: 0, currency: "USD" } })
		const end = a.turnEnds(sessionId)[0]
		assert.equal(end.seq, ups.length + 1)
		assert.equal(end.stopReason, "end_turn")
		assert.equal(app.broker.index.get(sessionId).contextSize, 1050000)
	})

	await step(t, g, "DELEGATE orchestrator → dataops: child frames at depth 1 and 2, each linked to the subagent call that spawned it", async () => {
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		const turn = await a.conn.prompt(say(sessionId, "DELEGATE orchestrator DELEGATE dataops RESULT ok"))
		assert.equal(turn.stopReason, "end_turn")
		await until(() => a.turnEnds(sessionId).length === 1)
		const frames = a.notices.filter((n) => n.method === "_gc/child_update" && n.params.sessionId === sessionId).map((n) => n.params)
		assert.deepEqual(
			frames.filter((f) => f.type === "status").map((f) => `${f.child.depth}:${f.status}`),
			["1:created", "1:running", "2:created", "2:running", "2:completed", "1:completed"],
		)
		const s1 = frames.find((f) => f.child.depth === 1).child
		const s2 = frames.find((f) => f.child.depth === 2).child
		assert.equal(s1.parentSessionId, sessionId)
		assert.equal(s1.title, "task for orchestrator")
		assert.equal(s2.parentSessionId, s1.sessionId)
		assert.equal(s2.title, "task for dataops")
		// the root's call that spawned S1: kind think, title subagent, rawInput.agent orchestrator (on in_progress)
		const rootUps = a.updates.filter((u) => u.sessionId === sessionId).map((u) => u.update)
		const rootCall = rootUps.find((u) => u.sessionUpdate === "tool_call_update" && u.status === "in_progress" && u.rawInput?.agent === "orchestrator")
		assert.ok(rootCall, "the root's subagent call carries rawInput.agent on in_progress")
		assert.ok(rootUps.some((u) => u.sessionUpdate === "tool_call" && u.toolCallId === rootCall.toolCallId && u.kind === "think" && u.title === "subagent"))
		assert.equal(s1.toolCallId, rootCall.toolCallId, "S1 linked to the root's subagent call")
		const s1Calls = frames.filter((f) => f.child.sessionId === s1.sessionId && f.type === "update").map((f) => f.update)
		const s1Call = s1Calls.find((u) => u.sessionUpdate === "tool_call_update" && u.status === "in_progress" && u.rawInput?.agent === "dataops")
		assert.ok(s1Call, "the orchestrator's subagent call, streamed as a depth-1 update")
		assert.ok(s1Calls.some((u) => u.sessionUpdate === "tool_call" && u.toolCallId === s1Call.toolCallId && u.title === "task for orchestrator: subagent"))
		assert.match(s1Call.toolCallId, new RegExp(`^${s1.sessionId}:`), "child toolCallIds are <childSessionId>:<call>")
		assert.equal(s2.toolCallId, s1Call.toolCallId, "S2 linked to the orchestrator's subagent call")
		// completion confirms the links (rawOutput.metadata.sessionID), and result-protocol added task_id
		const rootDone = rootUps.find((u) => u.toolCallId === rootCall.toolCallId && u.status === "completed")
		assert.equal(rootDone.rawOutput?.metadata?.sessionID, s1.sessionId)
		const s1Done = s1Calls.find((u) => u.toolCallId === s1Call.toolCallId && u.status === "completed")
		assert.equal(s1Done.rawOutput?.metadata?.sessionID, s2.sessionId)
		const s1DoneText = (s1Done.content ?? []).map((c) => c.content?.text ?? "").join("")
		assert.ok(s1DoneText.includes(`"task_id": "${s2.sessionId}"`), "result-protocol rewrote dataops' result with task_id")
		const s2Text = frames.filter((f) => f.child.depth === 2 && f.update?.sessionUpdate === "agent_message_chunk")
		assert.ok(s2Text.length >= 1 && s2Text.every((f) => f.update._meta?.["opencode/child-session"]?.id === s2.sessionId))
		assert.match(a.text(sessionId), /^parent done: <subagent sessionID="ses_[A-Za-z0-9]+" state="completed">/)
		assert.equal(frames.filter((f) => f.child.toolCallId === null).length, 0, "no child frame without its spawning call")
	})

	await step(t, g, "DELEGATE_BG: result-protocol forces the foreground; the turn waits for the child, no hidden root turn", async () => {
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		const turn = await a.conn.prompt(say(sessionId, "DELEGATE_BG orchestrator SAY background child done"))
		assert.equal(turn.stopReason, "end_turn")
		assert.match(a.text(sessionId), /^parent done: <subagent sessionID="ses_[A-Za-z0-9]+" state="completed">\nbackground child done/)
		assert.doesNotMatch(a.text(sessionId), /working in the background/)
		const statuses = a.notices.filter((n) => n.method === "_gc/child_update" && n.params.sessionId === sessionId && n.params.type === "status")
		assert.deepEqual(statuses.map((n) => `${n.params.child.depth}:${n.params.status}`), ["1:created", "1:running", "1:completed"])
		const end = a.turnEnds(sessionId)[0]
		assert.ok(statuses.every((n) => n.params.seq < end.seq), "the child completed inside the turn")
		const card = a.updates.find((u) => u.sessionId === sessionId && u.update.status === "in_progress" && u.update.rawInput?.agent === "orchestrator").update
		assert.equal(card.rawInput.background, true, "the card shows the call as the model made it (sent before the hook)")
		await untilAsync(async () => /\[result-protocol\] session ses_\S+: subagent "orchestrator" asked for background:true; run in the foreground/.test(await g.readFile(g.stderrLog)), 5000)
		// a hidden root turn would have run before this prompt and be in its history
		assert.equal((await a.conn.prompt(say(sessionId, "SAY after background"))).stopReason, "end_turn")
		const calls = g.calls(sessionId, "geology")
		assert.equal(calls.length, 3, "geology: the dispatch, the answer after the tool result, the next prompt; nothing hidden")
		assert.equal(g.calls(sessionId, "orchestrator").length, 1)
		assert.ok(!calls[2].body.messages.some((m) => m.role === "user" && /^<subagent /.test(textOf(m.content))), "no background-completion notice in the history")
	})

	await step(t, g, "CONC-2/CT-1: same-turn resume relinks progress without replaying a terminal status", async (st) => {
		const MARK1 = "first: run the orchestrator and resume it"
		const since = (body) => body.messages.slice(body.messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "tool")
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		let s1 = null
		llm.intercept = (body) => {
			const base = plan(body)
			if (base.aux || base.agent !== "geology" || !lastUserText(body).includes(MARK1)) return undefined
			const results = since(body)
			if (results.length === 0) return { ...base, kind: "tool", tool: "subagent", input: { agent: "orchestrator", description: "first orchestrator", prompt: "SAY first orchestrator run" } }
			if (results.length > 1) return undefined // "tool done: …"
			s1 = /sessionID="(ses_[A-Za-z0-9]+)"/.exec(textOf(results[0].content))?.[1]
			const input = { agent: "orchestrator", description: "same-turn resume", prompt: "SLOW 600 orchestrator resumed in the same turn", sessionID: s1 }
			return { ...base, kind: "tool", tool: "subagent", input }
		}
		try {
			assert.equal((await a.conn.prompt(say(sessionId, MARK1))).stopReason, "end_turn")
		} finally {
			llm.intercept = null
		}
		await until(() => a.turnEnds(sessionId).length === 1)
		assert.match(String(s1), /^ses_/)
		const turn1End = a.turnEnds(sessionId)[0].seq
		const ups = (from, to) => a.updates.filter((u) => u.sessionId === sessionId && u.update._meta.seq > from && u.update._meta.seq < to).map((u) => u.update)
		const childFrames = (from, to) => a.notices.filter((n) => n.method === "_gc/child_update" && n.params.sessionId === sessionId && n.params.seq > from && n.params.seq < to).map((n) => n.params)
		// "<status or update kind> → <toolCallId>" per frame, so a failure shows which frame went wrong
		const links = (list, toolCallId) => list.map((f) => `${f.relinked ? "relinked " : ""}${f.status ?? f.update?.sessionUpdate} → ${toolCallId === undefined ? f.child.toolCallId : toolCallId}`)

		const up1 = ups(0, turn1End)
		const firstCall = up1.find((u) => u.sessionUpdate === "tool_call_update" && u.rawInput?.description === "first orchestrator")
		const resumeCall = up1.find((u) => u.sessionUpdate === "tool_call_update" && u.rawInput?.sessionID === s1)
		assert.ok(firstCall && resumeCall, "both subagent calls reached the browser with their rawInput")
		const s1Frames = childFrames(0, turn1End).filter((f) => f.child.sessionId === s1)
		assert.deepEqual(
			s1Frames.filter((f) => f.type === "status" && !f.relinked).map((f) => f.status),
			["created", "running", "completed", "running", "completed"],
			"the resume sends `running` again, no second `created`",
		)
		const resumeAt = resumeCall._meta.seq // the resume call's first in_progress (with sessionID)
		const before = s1Frames.filter((f) => f.seq < resumeAt)
		const after = s1Frames.filter((f) => f.seq > resumeAt)
		assert.deepEqual(links(before), links(before, firstCall.toolCallId), "the first run names the first call")
		assert.deepEqual(links(after), links(after, resumeCall.toolCallId), "from the resume on, every frame names the resuming call")
		assert.ok(after.some((f) => f.update?.sessionUpdate === "agent_message_chunk"), "the resumed run streamed")
		await st.test(
			"the resume's relink frame doesn't show the child's previous terminal status before its `running`",
			() => assert.deepEqual(after.filter((f) => f.relinked && ["completed", "failed", "interrupted"].includes(f.status)).map((f) => f.status), []),
		)
	})

	await step(t, g, "L2-4 across orchestrators and fix 4: a later turn's NEW orchestrator gets the earlier specialists in its Specialist history and the previous orchestrator result verbatim", async () => {
		// result-protocol keys the ledger by the conversation's root since 2026-10-02 (live run 1: with a new
		// orchestrator per user message, each one started from an empty per-session ledger). Checked on the model
		// request itself: what the engine actually sends the second orchestrator.
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		assert.equal((await a.conn.prompt(say(sessionId, "DELEGATE orchestrator DELEGATE dataops RESULT first specialist"))).stopReason, "end_turn")
		await until(() => a.turnEnds(sessionId).length === 1)
		const turn1End = a.turnEnds(sessionId)[0].seq
		const spec = a.notices.find((n) => n.method === "_gc/child_update" && n.params.sessionId === sessionId && n.params.seq < turn1End && n.params.child.depth === 2)?.params.child.sessionId
		assert.match(String(spec), /^ses_/, "turn 1's specialist streamed")
		assert.equal((await a.conn.prompt(say(sessionId, "DELEGATE orchestrator SAY second orchestrator here"))).stopReason, "end_turn")
		await until(() => a.turnEnds(sessionId).length === 2)
		const second = g.calls(sessionId, "orchestrator").find((r) => /SAY second orchestrator here/.test(lastUserText(r.body)))
		assert.ok(second, "the second orchestrator's model request was recorded")
		const text = allText(second.body)
		assert.match(text, /# Specialist history \(every specialist dispatch in this conversation, across all orchestrator sessions/)
		assert.match(text, new RegExp(`## Earlier orchestrator sessions \\(not resumable[^\\n]*\\n- \\[${spec}\\] dataops: success \\(\\d+s\\)`), "turn 1's specialist, under the earlier sessions")
		// fix 4: turn 1's orchestrator result reaches the new orchestrator verbatim, and is saved in the run folder
		const orch1 = a.notices.find((n) => n.method === "_gc/child_update" && n.params.sessionId === sessionId && n.params.seq < turn1End && n.params.child.depth === 1)?.params.child.sessionId
		const saved = path.join(g.workspace, "runs", sessionId, "_orchestrator", `handback-001-${orch1}.md`)
		const handback = await fs.readFile(saved, "utf8")
		assert.match(handback, /^parent done: /, "the fake orchestrator's final text")
		// the block's own lines (the orchestrator prompt quotes the heading, so the heading alone proves nothing)
		assert.match(text, /# Previous orchestrator result \(verbatim\)\nA record of what an earlier orchestrator of this conversation handed back to the Geology Agent/)
		assert.ok(text.includes(handback), "the second orchestrator's request carries turn 1's result verbatim")
		const first = g.calls(sessionId, "orchestrator").find((r) => /DELEGATE dataops RESULT first specialist/.test(lastUserText(r.body)) && r.lastRole === "user")
		assert.ok(first, "turn 1's first orchestrator request was recorded")
		assert.doesNotMatch(allText(first.body), /# Specialist history \(every specialist dispatch|A record of what an earlier orchestrator of this conversation handed back/, "turn 1's orchestrator, before any dispatch, had no history and no previous result yet")
	})

	await step(t, g, "cancel during HANG: cancelled within 1 s, the model request aborted, the conversation usable at once", async () => {
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		const turn = a.conn.prompt(say(sessionId, "HANG waiting for a cancel"))
		await until(() => a.text(sessionId).length > 0, 15000)
		const t0 = Date.now()
		await a.conn.cancel({ sessionId })
		const done = await turn
		const ms = Date.now() - t0
		t.diagnostic(`cancel → turn end ${ms} ms`)
		assert.equal(done.stopReason, "cancelled")
		assert.equal(done._meta.reason, "cancelled", "a clean engine cancel, not an error path")
		assert.equal(done._meta.processesStopped, true)
		assert.ok(ms < 1000, `cancelled in ${ms} ms`)
		const hung = await llm.waitForRequest((r) => r.session === sessionId && r.directive?.name === "HANG" && !r.aux, 5000)
		assert.equal(typeof hung.abortedAt, "number", "the engine aborted the model request")
		assert.equal(app.broker.engine.generation, 1)
		await until(() => a.turnEnds(sessionId).length === 1)
		assert.deepEqual(project(a, sessionId), ["user", "agent", "end:cancelled:cancelled"], "no usage_update: no model step of this turn finished")
		assert.equal((await a.conn.prompt(say(sessionId, "SAY after cancel"))).stopReason, "end_turn", "no 'already has an active ACP prompt'")
		assert.match(allText(g.calls(sessionId).pop().body), /HANG waiting for a cancel/, "the cancelled turn stays in the engine's history")
	})

	await step(t, g, "cancel during a delegation: the root's cancel interrupts both specialists, in the measured order", async () => {
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		const turn = a.conn.prompt(say(sessionId, "DELEGATE orchestrator DELEGATE dataops HANG specialist working"))
		const isDepth2Text = (n) => n.method === "_gc/child_update" && n.params.sessionId === sessionId && n.params.child.depth === 2 && n.params.update?.sessionUpdate === "agent_message_chunk"
		await until(() => a.notices.some(isDepth2Text), 15000)
		const t0 = Date.now()
		await a.conn.cancel({ sessionId })
		const done = await turn
		t.diagnostic(`cancel with two specialists running → turn end ${Date.now() - t0} ms`)
		assert.equal(done.stopReason, "cancelled")
		assert.equal(done._meta.reason, "cancelled")
		const frames = a.notices.filter((n) => n.method === "_gc/child_update" && n.params.sessionId === sessionId).map((n) => n.params)
		assert.deepEqual(
			frames.filter((f) => f.type === "status").map((f) => `${f.child.depth}:${f.status}`),
			["1:created", "1:running", "2:created", "2:running", "1:interrupted", "2:interrupted"],
		)
		const rootFailed = a.updates.find((u) => u.sessionId === sessionId && u.update.status === "failed")?.update
		assert.match(JSON.stringify(rootFailed?.content), /Tool execution interrupted \(sessionID: ses_/)
		const hung = await llm.waitForRequest((r) => r.agent === "dataops" && r.directive?.name === "HANG" && lastUserText(r.body).includes("specialist working"), 5000)
		assert.equal(typeof hung.abortedAt, "number", "the specialist's model request was aborted")
		assert.equal((await a.conn.prompt(say(sessionId, "SAY after the interrupted delegation"))).stopReason, "end_turn")
	})

	await step(t, g, "provider errors: 400 → cancelled/error + X-6 Error line, no retry; 401 → provider.auth", async () => {
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		const r400 = await a.conn.prompt(say(sessionId, "ERR 400 bad request body"))
		assert.equal(r400.stopReason, "cancelled")
		assert.equal(r400._meta.reason, "error")
		assert.equal(r400._meta.errorName, "provider.invalid-request")
		assert.equal(r400._meta.error, "bad request body")
		await until(() => a.turnEnds(sessionId).length === 1)
		const line = a.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk").pop().update
		assert.match(line.content.text, /^Error: the model provider rejected the request from the geology agent \(bad request body\)\. Next step:/)
		assert.equal(line._meta.gateway, "error")
		assert.equal(g.calls(sessionId).length, 1, "a 400 is not retried")
		assert.deepEqual(project(a, sessionId), ["user", "agent(error)", "end:cancelled:error"], "a failed turn sends no usage_update")
		const r401 = await a.conn.prompt(say(sessionId, "ERR 401 token expired"))
		assert.equal(r401._meta.errorName, "provider.auth")
		const authLine = a.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk").pop().update
		assert.match(authLine.content.text, /Geology assistant.*could not be authenticated/)
		assert.match(authLine.content.text, /restore model access.*send your message again/)
		assert.doesNotMatch(authLine.content.text, /reload|token expired|geology agent/i)
		assert.equal(g.calls(sessionId).length, 2)
		assert.equal((await a.conn.prompt(say(sessionId, "SAY fine again"))).stopReason, "end_turn")
	})

	await step(t, g, "CT-3: a cancel during the provider retry backoff (ERR 500): turn_end._meta is the gateway's whitelist, no opencode/retry; a retry_cleared session_info_update precedes it", async () => {
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		const turn = a.conn.prompt(say(sessionId, "ERR 500 upstream exploded"))
		const isRetry = (u) => u.sessionId === sessionId && u.update.sessionUpdate === "session_info_update" && u.update._meta?.["opencode/retry"]
		await until(() => a.updates.some(isRetry), 15000) // retry-policy's first backoff is ~2 s
		const notice = a.updates.find(isRetry).update
		assert.equal(notice._meta["opencode/retry"].error?.status, 500, "the engine's retry notice is forwarded as is")
		const t0 = Date.now()
		await a.conn.cancel({ sessionId })
		const done = await turn
		t.diagnostic(`cancel in the retry backoff → turn end ${Date.now() - t0} ms`)
		assert.equal(done.stopReason, "cancelled")
		assert.equal(done._meta.reason, "cancelled")
		await until(() => a.turnEnds(sessionId).length === 1)
		const end = a.turnEnds(sessionId)[0]
		assert.deepEqual(Object.keys(end._meta).sort(), ["processesStopped", "reason"], `turn_end._meta: ${JSON.stringify(end._meta)}`)
		assert.equal(done._meta["opencode/retry"], undefined, "the prompt result carries no engine key either")
		const cleared = a.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "session_info_update" && u.update._meta?.gateway === "retry_cleared")
		assert.equal(cleared.length, 1, "the gateway clears the retry banner (the engine sends no null when the backoff is cancelled)")
		assert.equal(cleared[0].update._meta["opencode/retry"], null)
		assert.ok(notice._meta.seq < cleared[0].update._meta.seq && cleared[0].update._meta.seq === end.seq - 1, "cleared after the notice, right before turn_end")
		assert.deepEqual(project(a, sessionId), ["user", "retry", "retry:cleared", "end:cancelled:cancelled"])
		assert.equal((await a.conn.prompt(say(sessionId, "SAY after the retry"))).stopReason, "end_turn")
		assert.equal(g.calls(sessionId).length, 2, "no retry ran after the cancel: the failed attempt, then the next prompt")
		assert.equal(a.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "session_info_update").length, 2, "and no late retry notice")
	})

	await step(t, g, "permissions: a depth-2 specialist asks on the ROOT id; the gateway names the child; answered once → end_turn", async () => {
		const asked = []
		const b = await g.client({
			permission: async (params) => {
				asked.push(params)
				return { outcome: { outcome: "selected", optionId: "once" } }
			},
		})
		const sessionId = (await b.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		const file = "requested-gateway-save.md"
		const directive = `TOOL write ${JSON.stringify({ path: file, content: "approved gateway save\n" })}`
		const turn = await b.conn.prompt(say(sessionId, `DELEGATE orchestrator DELEGATE dataops ${directive}`))
		assert.equal(turn.stopReason, "end_turn")
		assert.equal(asked.length, 1)
		const s2 = b.notices.find((n) => n.method === "_gc/child_update" && n.params.sessionId === sessionId && n.params.child.depth === 2).params.child
		const [req] = asked
		assert.equal(req.sessionId, sessionId, "on the root's id")
		assert.equal(req._meta.childSessionId, s2.sessionId, "the child is read from the toolCallId prefix")
		assert.match(req.toolCall.toolCallId, new RegExp(`^${s2.sessionId}:`))
		assert.equal(req.toolCall.kind, "edit", "shipped workspace-edit policy is the permission source")
		assert.deepEqual(req.options.map((o) => o.kind), ["allow_once", "allow_always", "reject_once"])
		assert.equal(req._meta["gc/rpcId"], undefined, "the engine's rpc id stays in the gateway")
		const writeDone = b.notices.find(
			(n) => n.method === "_gc/child_update" && n.params.child.depth === 2 && n.params.update?.toolCallId === req.toolCall.toolCallId && n.params.update.status === "completed",
		)
		assert.ok(writeDone, "the write ran after the answer")
		assert.equal(await fs.readFile(path.join(workspace, file), "utf8"), "approved gateway save\n", "approval writes the requested path")
		await until(() => b.notices.some((n) => n.method === "_gc/permission_resolved" && n.params.sessionId === sessionId && n.params.by === "user"))
	})

	await step(t, g, "permissions: real session/cancel while a shipped workspace-write approval is pending leaves no file, permission or running turn", async (st) => {
		for (const mode of ["geology", "standard"]) {
			let release
			const deferred = new Promise((resolve) => { release = resolve })
			const b = await g.client({ permission: () => deferred })
			const sessionId = (await b.conn.newSession({ cwd: "", mcpServers: [], _meta: { agentMode: mode } })).sessionId
			const file = `requested-cancel-${mode}.md`
			const target = path.join(workspace, file)
			const directive = `TOOL write ${JSON.stringify({ path: file, content: "must never be written\n" })}`
			const prompt = mode === "geology" ? `DELEGATE orchestrator DELEGATE dataops ${directive}` : directive
			const turn = b.conn.prompt(say(sessionId, prompt))
			try {
				await until(() => b.permissions.length === 1, 15000)
				const [req] = b.permissions
				assert.equal(req.sessionId, sessionId)
				assert.equal(req.toolCall.kind, "edit")
				assert.match(JSON.stringify(req.toolCall), new RegExp(file.replaceAll(".", "\\.")), "the requested file is awaiting approval")
				assert.equal(fsSync.existsSync(target), false, "no file while approval is pending")
				assert.equal(app.broker.status().running, 1)
				assert.equal(app.broker.status().sessions.find((s) => s.sessionId === sessionId).pendingPermissions.length, 1)
				const generation = app.broker.engine.generation
				const t0 = Date.now()
				await b.conn.cancel({ sessionId }) // actual browser session/cancel; permission handler remains deferred
				const done = await turn
				assert.equal(done.stopReason, "cancelled")
				assert.equal(done._meta.reason, "cancelled")
				await until(() => b.turnEnds(sessionId).length === 1 && b.notices.some((n) => n.method === "_gc/permission_resolved" && n.params.sessionId === sessionId))
				const resolved = b.notices.filter((n) => n.method === "_gc/permission_resolved" && n.params.sessionId === sessionId)
				assert.equal(resolved.length, 1)
				assert.equal(resolved[0].params.by, "cancel")
				assert.deepEqual(resolved[0].params.outcome, { outcome: "cancelled" })
				assert.equal(app.broker.status().running, 0)
				assert.deepEqual(app.broker.status().sessions.find((s) => s.sessionId === sessionId).pendingPermissions, [])
				assert.equal(fsSync.existsSync(target), false, "cancelled save never creates the requested file")
				assert.equal(app.broker.engine.generation, generation, "clean cancellation requires no engine restart")
				assert.ok(!g.lines.some((l) => /PermissionNotFoundError|prompt failed/.test(l) && l.includes(sessionId)))
				const children = b.notices.filter((n) => n.method === "_gc/child_update" && n.params.sessionId === sessionId && n.params.type === "status")
				const lastStatuses = new Map(children.map((n) => [n.params.child.sessionId, n.params.status]))
				assert.equal(lastStatuses.size, mode === "geology" ? 2 : 0, "the delegated run tracks both children; Standard has none")
				assert.ok([...lastStatuses.values()].every((s) => ["interrupted", "failed", "completed"].includes(s)), "no running orphan child")
				const allow = req.options.find((o) => o.kind === "allow_once")
				assert.ok(allow)
				release({ outcome: { outcome: "selected", optionId: allow.optionId } }) // a stale browser answer cannot resurrect the save
				assert.equal((await b.conn.prompt(say(sessionId, "SAY after the cancelled permission"))).stopReason, "end_turn")
				assert.equal(fsSync.existsSync(target), false, "a late allow answer cannot write the cancelled file")
				assert.equal(app.broker.status().running, 0)
				st.diagnostic(`${mode}: pending edit → session/cancel → permission_resolved by=cancel, running=0, file absent (${Date.now() - t0} ms); process teardown checks for orphans`)
			} finally { release({ outcome: { outcome: "cancelled" } }) }
		}
	})

	await step(t, g, "resource_link: a workspace file reaches the model; one outside the workspace is refused before the engine", async () => {
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		const ok = await a.conn.prompt({
			sessionId,
			prompt: [
				{ type: "text", text: "SAY linked" },
				{ type: "resource_link", uri: `file://${workspace}/hello.txt`, name: "hello.txt" },
			],
		})
		assert.equal(ok.stopReason, "end_turn")
		const [call] = g.calls(sessionId)
		assert.match(lastUserText(call.body), /hello world\nsecond line/, "the engine read the linked file into the user message")
		const count = llm.requests.length
		await assert.rejects(
			a.conn.prompt({ sessionId, prompt: [{ type: "text", text: "SAY no" }, { type: "resource_link", uri: "file:///etc/hostname", name: "h" }] }),
			(e) => e.code === -32602,
		)
		await fs.symlink("/etc/hostname", path.join(workspace, "escape-link"))
		await assert.rejects(
			a.conn.prompt({ sessionId, prompt: [{ type: "text", text: "SAY no" }, { type: "resource_link", uri: `file://${workspace}/escape-link`, name: "h" }] }),
			(e) => e.code === -32602,
		)
		assert.equal(llm.requests.length, count, "nothing reached the engine")
	})

	await step(t, g, "SEC-1: a resource_link goes to the engine percent-encoded from its checked realpath: a literal %2e%2e folder stays inside the workspace; #, ? and %41 names attach their own file", async () => {
		// The engine parses the forwarded URI again: `file://<real>` unencoded let a literal "%2e%2e" folder
		// (an upload can create one) read the file one level up, and broke on # and ?
		await fs.writeFile(path.join(g.root, "outside.txt"), "CANARY-OUTSIDE-WORKSPACE\n") // <ws>/../outside.txt
		await fs.mkdir(path.join(workspace, "%2e%2e"), { recursive: true })
		await fs.writeFile(path.join(workspace, "%2e%2e", "outside.txt"), "DECOY-INSIDE-WORKSPACE\n")
		await fs.writeFile(path.join(workspace, "Drill Hole #12.csv"), "HASH-FILE\n")
		await fs.writeFile(path.join(workspace, "what?.txt"), "QMARK-FILE\n")
		await fs.writeFile(path.join(workspace, "x%41.txt"), "PCT41-FILE\n")
		await fs.writeFile(path.join(workspace, "xA.txt"), "XA-FILE\n") // what x%41.txt decodes to a second time
		const markers = ["CANARY-OUTSIDE-WORKSPACE", "DECOY-INSIDE-WORKSPACE", "HASH-FILE", "QMARK-FILE", "PCT41-FILE", "XA-FILE"]
		const cases = { "%2e%2e/outside.txt": "DECOY-INSIDE-WORKSPACE", "Drill Hole #12.csv": "HASH-FILE", "what?.txt": "QMARK-FILE", "x%41.txt": "PCT41-FILE" }
		const seen = {}
		for (const rel of Object.keys(cases)) {
			const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
			// the URI a browser builds for that workspace path (each segment percent-encoded once)
			const uri = pathToFileURL(path.join(workspace, rel)).href
			const r = await a.conn.prompt({ sessionId, prompt: [{ type: "text", text: "SAY attached" }, { type: "resource_link", uri, name: path.basename(rel) }] }).catch((e) => ({ stopReason: `rejected ${e.code}` }))
			const text = g.calls(sessionId).map((c) => lastUserText(c.body)).join("\n")
			seen[rel] = `${r.stopReason}${r._meta?.errorName ? `/${r._meta.errorName}` : ""}: ${markers.filter((m) => text.includes(m)).join(",")}`
		}
		assert.deepEqual(seen, Object.fromEntries(Object.entries(cases).map(([rel, marker]) => [rel, `end_turn: ${marker}`])))
	})

	await step(t, g, "SEC-3: an attachment above RUNTIME_ATTACH_MAX_KB (default 512) or a folder is refused with -32602 before the engine", async () => {
		assert.equal(g.config.attachMaxKb, 512)
		const size = 600 * 1024
		await fs.writeFile(path.join(workspace, "assays_600k.csv"), "HOLE_ID,AU_PPM\n".padEnd(size, "MH0001,0.123\n"))
		assert.equal((await fs.stat(path.join(workspace, "assays_600k.csv"))).size, size)
		await fs.mkdir(path.join(workspace, "a-folder"), { recursive: true })
		await fs.writeFile(path.join(workspace, "a-folder", "inside.txt"), "inside\n")
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		const count = llm.requests.length
		const link = (rel) => ({ sessionId, prompt: [{ type: "text", text: "SAY no" }, { type: "resource_link", uri: pathToFileURL(path.join(workspace, rel)).href, name: rel }] })
		await assert.rejects(a.conn.prompt(link("assays_600k.csv")), (e) => {
			assert.equal(e.code, -32602)
			assert.match(e.message, /assays_600k\.csv is 600 KB, above the 512 KB attachment limit\. Next step: mention its path/, "names the file, its size, the limit and a next step")
			assert.deepEqual({ size: e.data?.size, maxBytes: e.data?.maxBytes }, { size, maxBytes: 512 * 1024 })
			return true
		})
		await assert.rejects(a.conn.prompt(link("a-folder")), (e) => {
			assert.equal(e.code, -32602)
			assert.match(e.message, /a-folder is not a regular file/)
			return true
		})
		assert.equal(llm.requests.length, count, "nothing reached the engine")
		assert.equal(a.stream(sessionId).length, 0, "refused before the turn: no echo, nothing logged")
		assert.equal((await a.conn.prompt(say(sessionId, "SAY still idle"))).stopReason, "end_turn", "the conversation was never busy")
	})

	await step(t, g, "model and effort: set_config_option reaches the model request", async () => {
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		await a.conn.unstable_setSessionModel({ sessionId, modelId: "proxy/z-ai/glm-5.3-flash" })
		const set = await a.conn.unstable_setSessionConfigOption({ sessionId, configId: "effort", value: "high" })
		assert.equal(set.configOptions.find((o) => o.id === "effort").currentValue, "high")
		assert.equal(set.configOptions.find((o) => o.id === "model").currentValue, "proxy/z-ai/glm-5.3-flash")
		await assert.rejects(a.conn.unstable_setSessionModel({ sessionId, modelId: "proxy/nope/unknown" }), (e) => e.code === -32602)
		assert.equal((await a.conn.prompt(say(sessionId, "SAY on glm"))).stopReason, "end_turn")
		const [call] = g.calls(sessionId)
		assert.equal(call.body.model, "z-ai/glm-5.3-flash")
		assert.equal(call.body.max_completion_tokens, 16384, "glm's limit.output")
		assert.match(JSON.stringify(call.body), /"effort":"high"/)
		const end = a.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "usage_update").pop().update
		assert.equal(end.size, 200000, "usage_update.size is the session model's context limit")
	})

	await step(t, g, "an MCP tool call: the run-dir plugin injects run_dir = the gateway's runDir; the browser's card doesn't show it", async () => {
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		assert.equal((await a.conn.prompt(say(sessionId, 'TOOL geocluster_list_files {"directory": "."}'))).stopReason, "end_turn")
		const [, afterTool] = g.calls(sessionId)
		assert.equal(afterTool.lastRole, "tool")
		assert.match(textOf(afterTool.body.messages.at(-1).content), /MINI_MCP_RESULT /, "the MCP's result reached the model")
		let mcpCalls = []
		const mcpCallsNow = async () =>
			(mcpCalls = (await g.readFile(g.mcpLog))
				.split("\n")
				.map((l) => /MINI_MCP (\{"call".*\})$/.exec(l)?.[1])
				.filter(Boolean)
				.map((j) => JSON.parse(j).call))
		// the MCP printed it before answering; the supervisor's log file write is asynchronous
		await untilAsync(async () => (await mcpCallsNow()).some((c) => c.tool === "list_files"), 5000)
		const call = mcpCalls.find((c) => c.tool === "list_files" && c.arguments?.run_dir === `runs/${sessionId}`)
		assert.ok(call, `the MCP got run_dir runs/${sessionId}: ${JSON.stringify(mcpCalls)}`)
		assert.equal(call.arguments.directory, ".")
		t.diagnostic(`MCP call _meta: ${JSON.stringify(call.meta)}`)
		const card = a.updates.find((u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call_update" && u.update.rawInput?.directory).update
		assert.equal(card.rawInput.run_dir, undefined)
		assert.equal(card.kind, "other")
	})

	await step(t, g, "report-analysis RE-4: the real read tool feeds the ledger; one correction prompt; the corrected answer is exported", async () => {
		const reportDir = path.join(workspace, "report", "text")
		await fs.mkdir(reportDir, { recursive: true })
		await fs.writeFile(path.join(reportDir, "01_summary.md"), "Grade 1.2 g/t Au over 10 m.\n")
		const ANSWER = "Grade 1.2 g/t [source: text/01_summary.md | p:1] and 5 holes [source: text/07_exploration.md | p:3]"
		const CORRECTED = "Grade 1.2 g/t [source: text/01_summary.md | p:1]; holes [not found in report]"
		llm.intercept = (body) => {
			const base = plan(body)
			if (base.aux || base.agent !== "report-analysis") return undefined
			if (/^Citation check FAILED/.test(lastUserText(body))) return { ...base, kind: "text", text: CORRECTED }
			if (base.lastRole === "tool") return { ...base, kind: "text", text: ANSWER }
			return undefined
		}
		try {
			const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [], _meta: { agentMode: "report-analysis" } })).sessionId
			const turn = await a.conn.prompt(say(sessionId, 'TOOL read {"path": "report/text/01_summary.md"}'))
			assert.equal(turn.stopReason, "end_turn")
			await until(() => a.turnEnds(sessionId).length === 1)
			assert.equal(a.turnEnds(sessionId).length, 1, "the correction ran inside the same browser turn")
			// the read card as the tracker needs it: kind read, title read, the path on in_progress, then completed
			const ups = a.updates.filter((u) => u.sessionId === sessionId).map((u) => u.update)
			const pending = ups.find((u) => u.sessionUpdate === "tool_call" && u.kind === "read")
			assert.equal(pending?.title, "read")
			assert.ok(ups.some((u) => u.toolCallId === pending.toolCallId && u.status === "in_progress" && u.rawInput?.path === "report/text/01_summary.md"))
			assert.ok(ups.some((u) => u.toolCallId === pending.toolCallId && u.status === "completed"))
			const notice = a.notices.find((n) => n.method === "_gc/notice" && n.params.sessionId === sessionId && n.params.kind === "citation_check")
			assert.deepEqual(notice.params.flagged, ["text/07_exploration.md"], "only the file never read is flagged")
			const corrections = g.calls(sessionId).filter((r) => /^Citation check FAILED/.test(lastUserText(r.body)))
			assert.equal(corrections.length, 1, "exactly one correction prompt reached the model")
			const correction = corrections[0]
			t.diagnostic(`correction prompt: ${JSON.stringify(lastUserText(correction.body).slice(0, 160))}…`)
			assert.match(lastUserText(correction.body), /\n {2}- text\/07_exploration\.md\n/)
			assert.ok(correction.body.messages.some((m) => m.role === "assistant" && textOf(m.content) === ANSWER), "the first answer is in the engine's history")
			assert.ok(correction.body.messages.some((m) => m.role === "tool" && /Read file report\/text\/01_summary\.md|Grade 1\.2 g\/t Au/.test(textOf(m.content))))
			assert.match(turn._meta.report, new RegExp(`^runs/${sessionId}/_reports/REPORT_\\d{8}_\\d{6}\\.md$`))
			assert.equal(await fs.readFile(path.join(workspace, turn._meta.report), "utf8"), CORRECTED)
			const log = await g.readLog(sessionId)
			assert.deepEqual(
				log.filter((e) => e.kind === "gateway" && e.type === "citation_check").map((e) => e.attempt),
				[1],
			)
			assert.equal(log.filter((e) => e.kind === "update" && e.update.sessionUpdate === "user_message_chunk").length, 1, "the correction prompt is not echoed")
		} finally {
			llm.intercept = null
		}
	})

	await step(t, g, "API-09: a tool shell carries GEOCLUSTER_RUN_DIR=runs/<id> and the tool HOME; a cancel ends the turn only once it has stopped", async () => {
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [], _meta: { agentMode: "standard" } })).sessionId
		const runDir = `runs/${sessionId}`
		const turn = a.conn.prompt(say(sessionId, 'TOOL shell {"command": "sleep 30"}'))
		let kids = []
		await untilAsync(async () => (kids = await app.broker.engine.conversationProcesses(runDir)).length > 0, 15000)
		const kid = procInfo(kids[0].pid)
		assert.match(kid?.cmd ?? "", /sleep 30/, "the conversation's tool process, found by its environment")
		const env = fsSync.readFileSync(`/proc/${kid.pid}/environ`, "utf8").split("\0")
		assert.ok(env.includes(`GEOCLUSTER_RUN_DIR=${runDir}`))
		assert.ok(env.includes(`HOME=${g.config.toolHome}`), "the run-dir plugin gives tool shells GEOCLUSTER_TOOL_HOME as HOME")
		const card = a.updates.find((u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call")?.update
		assert.equal(card?.kind, "execute")
		await a.conn.cancel({ sessionId })
		const done = await turn
		assert.equal(done.stopReason, "cancelled")
		assert.equal(done._meta.processesStopped, true)
		assert.equal(alive(kid), false, "the tool process had stopped before turn_end")
		assert.deepEqual(await app.broker.engine.conversationProcesses(runDir), [])
	})

	await step(t, g, "LC-1 (API-09): a job the agent detached (`nohup … &`) is found by its GEOCLUSTER_RUN_DIR; the next cancel stops it, and processesStopped is true only once it is gone", async () => {
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [], _meta: { agentMode: "standard" } })).sessionId
		const runDir = `runs/${sessionId}`
		// the usual workaround for the shell tool's timeout; writes nothing (README: keep test shells write-free)
		const r = await a.conn.prompt(say(sessionId, 'TOOL shell {"command": "nohup sleep 297 >/dev/null 2>&1 &"}'))
		assert.equal(r.stopReason, "end_turn", "the shell returns at once")
		let job = null
		await until(() => (job = processesWithEnv("GEOCLUSTER_RUN_DIR", runDir, /^sleep 297$/)[0] ?? null), 5000)
		g.procs.push(job) // the teardown kills it (and fails) if it outlives the gateway
		const engine = app.broker.engine
		assert.ok(!descendants(engine.pid).some((p) => p.pid === job.pid), `re-parented away from the engine (ppid ${job.ppid})`)
		const foundBefore = (await engine.conversationProcesses(runDir)).some((p) => p.pid === job.pid)
		const turn = a.conn.prompt(say(sessionId, "HANG while the detached job runs"))
		await until(() => /while the detached job runs/.test(a.text(sessionId)), 15000)
		await a.conn.cancel({ sessionId })
		const done = await turn
		assert.equal(done.stopReason, "cancelled")
		assert.equal(done._meta.reason, "cancelled")
		assert.equal(alive(job), false, "the detached job was stopped before turn_end")
		assert.equal(done._meta.processesStopped, true)
		assert.ok(foundBefore, "conversationProcesses scans the whole process table, not only the engine's tree")
		assert.deepEqual(await engine.conversationProcesses(runDir), [])
		assert.ok(g.lines.some((l) => /tool processes outlived a cancelled turn; stopping them/.test(l) && l.includes(sessionId)))
		await until(() => a.turnEnds(sessionId).length === 2)
	})

	await step(
		t,
		g,
		"standard: a `shell` call with background:true runs in the foreground (no hidden root turn)",
		async () => {
			const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [], _meta: { agentMode: "standard" } })).sessionId
			assert.equal((await a.conn.prompt(say(sessionId, 'TOOL shell {"command": "sleep 0.3; echo bg done", "background": true}'))).stopReason, "end_turn")
			const text = a.text(sessionId)
			let hidden = null
			if (/moved to the background/.test(text)) {
				// wait for the engine's hidden turn to finish, so it can't overlap the next steps
				hidden = await llm.waitForRequest((r) => r.session === sessionId && r.agent === "standard" && /^<shell /.test(lastUserText(r.body)), 10000).catch(() => null)
			}
			assert.equal(hidden, null, `a hidden root turn ran after the turn ended (model got ${JSON.stringify(hidden && lastUserText(hidden.body).slice(0, 120))}; 0 ACP frames)`)
			assert.match(text, /bg done/, "the command's output is the tool result")
		},
	)

	await step(t, g, "a lost binding (engine session closed behind the broker): close cancels the running turn; the next prompt gets `session not found`, re-binds and retries once", async () => {
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		assert.equal((await a.conn.prompt(say(sessionId, "SAY before the close"))).stopReason, "end_turn")
		const turn = a.conn.prompt(say(sessionId, "HANG until closed"))
		await until(() => /until closed/.test(a.text(sessionId)), 15000)
		await app.broker.engine.closeSession(sessionId)
		const done = await turn
		assert.equal(done.stopReason, "cancelled", "session/close cancels the engine's running prompt")
		assert.equal((await a.conn.prompt(say(sessionId, "SAY after the close"))).stopReason, "end_turn")
		assert.ok(g.lines.some((l) => /engine lost the binding; resuming and retrying/.test(l) && l.includes(sessionId)), "the engine answered -32602 `session not found`")
		assert.match(allText(g.calls(sessionId, "geology").pop().body), /user: SAY before the close\nassistant: before the close/)
	})

	await step(t, g, "engine restart: a running turn ends server_restart; idle conversations resume lazily and keep their history", async () => {
		const old = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		assert.equal((await a.conn.prompt(say(old, "SAY first answer alpha"))).stopReason, "end_turn")
		const busy = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		const inFlight = a.conn.prompt(say(busy, "HANG in flight"))
		await until(() => a.text(busy).length > 0, 15000)
		const generation = app.broker.engine.generation
		const t0 = Date.now()
		await app.broker.engine.restart("engine contract test")
		t.diagnostic(`restart → ready ${Date.now() - t0} ms`)
		assert.equal(app.broker.engine.generation, generation + 1)
		assert.equal(app.broker.engine.tools, "connected", "the new engine connects to the MCP again")
		const done = await inFlight
		assert.equal(done.stopReason, "cancelled")
		assert.equal(done._meta.reason, "server_restart")
		assert.match(a.text(busy), /Error: the agent engine stopped during this turn and is restarting/)

		const seqBefore = a.stream(old).length
		assert.equal((await a.conn.prompt(say(old, "SAY second answer bravo"))).stopReason, "end_turn")
		const call = g.calls(old).pop()
		assert.deepEqual(
			call.body.messages.map((m) => m.role),
			["system", "user", "assistant", "user"],
			"the resumed session keeps its history",
		)
		assert.match(allText(call.body), /user: SAY first answer alpha\nassistant: first answer alpha\nuser: SAY second answer bravo/)
		await until(() => a.turnEnds(old).length === 2)
		const fresh = a.stream(old).slice(seqBefore)
		assert.deepEqual(
			fresh.map((e) => (e.kind === "update" ? e.update.sessionUpdate : e.kind)),
			["user_message_chunk", "agent_message_chunk", "usage_update", "_gc/turn_end"],
			"resume replays nothing into the live stream",
		)
		assert.ok(g.lines.some((l) => /conversation bound/.test(l) && l.includes(old) && l.includes(`"generation":${generation + 1}`)))
		assert.equal((await a.conn.prompt(say(busy, "SAY busy again"))).stopReason, "end_turn")
		assert.match(allText(g.calls(busy).pop().body), /user: HANG in flight/, "the interrupted turn's prompt is in the history")
	})

	await step(t, g, "the private server dies mid-turn (SIGKILL): the turn ends server_restart, the engine is restarted, the conversation resumes", async () => {
		const sessionId = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		const turn = a.conn.prompt(say(sessionId, "HANG server about to die"))
		await until(() => /about to die/.test(a.text(sessionId)), 15000)
		const engine = app.broker.engine
		const acp = engine.pid
		const serve = descendants(acp).find((p) => p.ppid === acp && /(^|\s)serve(\s|$)/.test(p.cmd))
		assert.ok(serve, `acp's private server, found the way the supervisor's /proc watch finds it: ${descendants(acp).map((p) => p.cmd.slice(0, 80))}`)
		const generation = engine.generation
		process.kill(serve.pid, "SIGKILL")
		const done = await turn
		assert.equal(done.stopReason, "cancelled")
		assert.equal(done._meta.reason, "server_restart")
		await untilAsync(async () => engine.state === "ready" && engine.generation === generation + 1, 20000)
		assert.ok(g.lines.some((l) => /health probe failed|engine server process is gone/.test(l)), "detected by the ClientError probe or the /proc watch")
		assert.equal((await a.conn.prompt(say(sessionId, "SAY alive again"))).stopReason, "end_turn")
	})
})

test("CONC-2 live acceptance: existing descendant resume, in-flight root replay, and parallel fresh/resumed root isolation with bounded jitter", { skip, timeout: 120000 }, async (t) => {
	const g = await startRealGateway(t, { chunkGapMs: 37 })
	await g.started
	const a = await g.client()
	const root = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
	assert.equal((await a.conn.prompt(say(root, "DELEGATE orchestrator DELEGATE dataops RESULT fixture seed"))).stopReason, "end_turn")
	await until(() => a.turnEnds(root).length === 1)
	const frames = (client, id, afterSeq = 0) => client.stream(id).filter((e) => e.kind === "_gc/child_update" && e.seq > afterSeq).map((e) => e.params)
	const seed = frames(a, root)
	const orchestrator = seed.find((f) => f.child.depth === 1).child
	const descendant = seed.find((f) => f.child.depth === 2).child
	const rootCall = (client, id, afterSeq, description) => client.stream(id).find((e) => e.seq > afterSeq && e.update?.status === "in_progress" && e.update.rawInput?.description === description)?.update
	const childCall = (list, parent, description) => list.find((f) => f.child.sessionId === parent && f.update?.status === "in_progress" && f.update.rawInput?.description === description)?.update
	const hasText = (list, marker) => list.some((f) => f.update?.sessionUpdate === "agent_message_chunk" && f.update.content.text.includes(marker))

	// Fixed, unequal gaps perturb SSE coalescing and tool/text arrival order without an unbounded soak.
	for (const [iteration, gap] of [65, 137, 219].entries()) {
		await step(t, g, `repeat ${iteration + 1}/3: preTextGapMs=${gap}, chunkGapMs=37`, async () => {
			const b = await g.client()
			const freshRoot = (await b.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
			const cursor = a.turnEnds(root).at(-1).seq
			const mark = `live-fixture-${iteration}`
			const resumedMark = `${mark}-resumed`
			const siblingMark = `${mark}-sibling`
			const foreignMark = `${mark}-foreign`
			const gates = [resumedMark, siblingMark, foreignMark]
			const makeCall = (description, prompt, sessionID, agent = "orchestrator") => ({ agent, description, prompt, ...(sessionID ? { sessionID } : {}) })
			g.llm.intercept = (body) => {
				const base = plan(body)
				if (base.aux) return undefined
				const text = lastUserText(body)
				if (base.agent === "geology" && base.lastRole === "user" && text.includes(`${mark}-root`)) {
					const calls = [makeCall(siblingMark, siblingMark), makeCall(resumedMark, resumedMark, orchestrator.sessionId)]
					return { ...base, kind: "tool", tool: "subagent", preText: `${mark}-root progress`, preTextGapMs: gap, calls: calls.map((input) => ({ tool: "subagent", input })) }
				}
				if (base.agent === "geology" && base.lastRole === "user" && text.includes(`${mark}-other`)) {
					return { ...base, kind: "tool", tool: "subagent", preText: `${mark}-other progress`, preTextGapMs: 284 - gap, input: makeCall(foreignMark, foreignMark) }
				}
				const label = gates.find((gate) => text.includes(gate))
				if (!label) return undefined
				if (base.agent === "orchestrator" && base.lastRole === "user") {
					return { ...base, kind: "tool", tool: "subagent", preText: `${label} orchestrator progress`, preTextGapMs: gap,
						input: makeCall(`${label}-specialist`, label, label === resumedMark ? descendant.sessionId : null, "dataops") }
				}
				if (base.agent === "dataops") {
					if (base.lastRole === "user") return { ...base, kind: "tool", tool: "glob", input: { pattern: "hello.txt" }, preText: `${label} descendant progress`, preTextGapMs: 284 - gap }
					return { ...base, kind: "wait", gate: label, then: { kind: "text", text: `\`\`\`json\n${JSON.stringify({ type: "completion", status: "success", results: { summary: `${label} finished` } })}\n\`\`\`` } }
				}
				return undefined
			}
			let settledA = false
			let settledB = false
			const turnA = a.conn.prompt(say(root, `${mark}-root`)).finally(() => { settledA = true })
			const turnB = b.conn.prompt(say(freshRoot, `${mark}-other`)).finally(() => { settledB = true })
			turnA.catch(() => {})
			turnB.catch(() => {})
			try {
				await until(() => gates.every((gate) => g.llm.requests.some((r) => r.waitedFor === gate)), 15000)
				await until(() => hasText(frames(a, root, cursor), `${resumedMark} descendant progress`) && hasText(frames(a, root, cursor), `${siblingMark} descendant progress`) && hasText(frames(b, freshRoot), `${foreignMark} descendant progress`), 5000)
				assert.equal(settledA, false, "resumed root is still waiting at the specialist gate")
				assert.equal(settledB, false, "parallel fresh root is still waiting at its specialist gate")
				assert.equal(a.turnEnds(root).at(-1).seq, cursor, "no root turn_end before gate release")
				assert.equal(b.turnEnds(freshRoot).length, 0)
				const listA = frames(a, root, cursor)
				const listB = frames(b, freshRoot)
				const resume = rootCall(a, root, cursor, resumedMark)
				const sibling = rootCall(a, root, cursor, siblingMark)
				const foreign = rootCall(b, freshRoot, 0, foreignMark)
				assert.ok(resume && sibling && foreign, "all root dispatches reached their own socket")
				const siblingId = listA.find((f) => f.child.depth === 1 && f.child.sessionId !== orchestrator.sessionId)?.child.sessionId
				const foreignId = listB.find((f) => f.child.depth === 1)?.child.sessionId
				const resumedDispatch = childCall(listA, orchestrator.sessionId, `${resumedMark}-specialist`)
				const siblingDispatch = childCall(listA, siblingId, `${siblingMark}-specialist`)
				const foreignDispatch = childCall(listB, foreignId, `${foreignMark}-specialist`)
				assert.ok(resumedDispatch && siblingDispatch && foreignDispatch)
				assert.equal(resumedDispatch.rawInput.sessionID, descendant.sessionId, "the orchestrator explicitly resumes an existing descendant from the seed turn")
				const resumedRequest = g.calls(root, "orchestrator").find((request) => lastUserText(request.body).includes(resumedMark) && request.lastRole === "user")
				assert.ok(resumedRequest?.body.messages.some((message) => message.role === "user" && textOf(message.content).includes("DELEGATE dataops RESULT fixture seed")), "the resumed orchestrator retains its earlier history")
				const siblingDescendant = listA.find((f) => f.child.parentSessionId === siblingId)?.child.sessionId
				const foreignDescendant = listB.find((f) => f.child.parentSessionId === foreignId)?.child.sessionId
				const expectedA = [
					{ ...orchestrator, toolCallId: resume.toolCallId },
					{ ...descendant, toolCallId: resumedDispatch.toolCallId },
					{ sessionId: siblingId, parentSessionId: root, depth: 1, title: siblingMark, toolCallId: sibling.toolCallId },
					{ sessionId: siblingDescendant, parentSessionId: siblingId, depth: 2, title: `${siblingMark}-specialist`, toolCallId: siblingDispatch.toolCallId },
				]
				const expectedB = [
					{ sessionId: foreignId, parentSessionId: freshRoot, depth: 1, title: foreignMark, toolCallId: foreign.toolCallId },
					{ sessionId: foreignDescendant, parentSessionId: foreignId, depth: 2, title: `${foreignMark}-specialist`, toolCallId: foreignDispatch.toolCallId },
				]
				for (const [id, list, expected] of [[root, listA, expectedA], [freshRoot, listB, expectedB]]) {
					for (const frame of list) {
						assert.equal(frame.sessionId, id)
						assert.deepEqual(frame.child, expected.find((child) => child.sessionId === frame.child.sessionId), "exact links and original resume titles already hold while pending")
						assert.notEqual(frame.status, "completed", "child completion is held by the gate")
					}
				}
				assert.equal(listA.filter((f) => [orchestrator.sessionId, descendant.sessionId].includes(f.child.sessionId) && f.status === "created").length, 0, "neither resumed ancestor nor resumed descendant emits created")
				assert.match(resumedDispatch.toolCallId, new RegExp(`^${orchestrator.sessionId}:`))

				// Attach only to the root, after the seed cursor, while all three specialists are held.
				const observer = await g.client()
				const attached = await observer.conn.extMethod("_gc/attach", { sessionId: root, afterSeq: cursor })
				assert.equal(attached.turn, "running")
				assert.equal(attached.truncated, false)
				await until(() => observer.stream(root).some((e) => e.seq === attached.lastSeq))
				const snapshot = a.stream(root).filter((e) => e.seq > cursor && e.seq <= attached.lastSeq)
				assert.deepEqual(observer.stream(root).map(replayPayload), snapshot.map(replayPayload), "root cursor replays the exact ordered payloads, including both subtrees")
				assert.ok(observer.stream(root).every((e) => e.update?._meta?.replay || e.params?.replay), "the in-flight snapshot is marked replay")
				assert.ok(observer.stream(root).some((e) => e.update?.content?.text?.includes(`${mark}-root progress`)), "root text is replayed")
				assert.ok(hasText(frames(observer, root), `${siblingMark} orchestrator progress`), "sibling text is replayed")
				assert.ok(hasText(frames(observer, root), `${resumedMark} descendant progress`), "the existing descendant's resumed text is replayed")
				assert.equal(settledA, false, "replay completes before root completion")
				assert.equal(settledB, false)
				for (const gate of iteration % 2 ? [...gates].reverse() : gates) g.llm.release(gate)
				assert.deepEqual((await Promise.all([turnA, turnB])).map((turn) => turn.stopReason), ["end_turn", "end_turn"])
				await until(() => observer.turnEnds(root).length === 1 && b.turnEnds(freshRoot).length === 1)
				const observed = observer.stream(root)
				const live = a.stream(root).filter((e) => e.seq > cursor)
				assert.deepEqual(observed.map(replayPayload), live.map(replayPayload), "replay joins the subsequent live stream without losing or repeating any payload")
				assert.equal(new Set(observed.map((e) => e.seq)).size, observed.length, "no duplicate seq across replay and live delivery")
				assert.ok(observed.filter((e) => e.seq > attached.lastSeq).every((e) => !(e.update?._meta?.replay || e.params?.replay)), "post-cursor completion arrives live")
				for (const [client, id, after, expected] of [[a, root, cursor, expectedA], [b, freshRoot, 0, expectedB]]) {
					const completedFrames = frames(client, id, after)
					assert.equal(new Set(completedFrames.map((f) => f.child.sessionId)).size, expected.length)
					for (const child of expected) assertChildRun(completedFrames.filter((f) => f.child.sessionId === child.sessionId), id, child, { resumed: [orchestrator.sessionId, descendant.sessionId].includes(child.sessionId) })
				}
				assert.equal(a.stream(freshRoot).length, 0, "resumed root socket receives no foreign-root frames")
				assert.equal(b.stream(root).length, 0, "fresh root socket receives no resumed-root frames")
				assert.equal(observer.stream(freshRoot).length, 0, "root-only replay subscription receives no foreign-root frames")
				assert.ok(!JSON.stringify(live).includes(foreignMark), "foreign text and dispatches never enter the resumed root log")
				assert.ok(!JSON.stringify(b.stream(freshRoot)).includes(resumedMark) && !JSON.stringify(b.stream(freshRoot)).includes(siblingMark), "resumed and sibling text never enter the fresh root log")
				t.diagnostic(`repeat ${iteration + 1}: roots=${root},${freshRoot}; existing descendant=${descendant.sessionId}; replay cursor=${cursor}..${attached.lastSeq}; unique replay+live events=${observed.length}`)
			} finally {
				for (const gate of gates) g.llm.release(gate)
				await Promise.allSettled([turnA, turnB])
				g.llm.intercept = null
			}
		})
	}
})
