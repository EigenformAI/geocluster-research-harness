import assert from "node:assert/strict"
import fs from "node:fs"
import fsp from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { ClientSideConnection, RequestError } from "@agentclientprotocol/sdk"
import { AgentSupervisor } from "../lib/agent-supervisor.js"
import { loadConfig } from "../lib/config.js"
import { ENGINE_PERMISSION_METHOD, ENGINE_UPDATE_METHOD, RPC_ID_META, engineStream, rewriteInbound } from "../lib/engine-stream.js"
import { withEnv } from "../lib/proc-tree.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE = path.join(here, "fake-opencode.mjs")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const seenPids = new Set()

function alive(pid) {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z"
	} catch {
		return false
	}
}

async function waitFor(predicate, timeoutMs = 5000, label = "condition") {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const value = await predicate()
		if (value) return value
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
		await sleep(20)
	}
}

function captureLogger() {
	const lines = []
	const log = (level) => (message, extra) => {
		lines.push({ level, message, extra })
		if (process.env.DEBUG_SUP) console.log(level, message, extra === undefined ? "" : JSON.stringify(extra))
	}
	const logger = { lines, info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") }
	logger.child = () => logger
	return logger
}

/** The shared MCP stand-in: GET /healthz → 200 {ok, mode:"shared", in_flight:0}. */
async function startMcp() {
	const server = http.createServer((req, res) => {
		if (req.url === "/healthz") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ ok: true, mode: "shared", in_flight: 0 }))
		} else {
			res.writeHead(404)
			res.end()
		}
	})
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	return { url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** A loopback port nothing listens on (the MCP is down). */
async function closedMcpUrl() {
	const server = http.createServer()
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	const port = server.address().port
	await new Promise((resolve) => server.close(resolve))
	return `http://127.0.0.1:${port}/mcp`
}

const RECORDED = ["ready", "exit", "unavailable", "tools", "update", "child", "cancelRequest"]

/**
 * A supervisor on temp dirs. Returns {sup, config, events, logger, dir, knobs(obj)}; everything is
 * stopped and removed when the test ends.
 */
async function setup(t, { mcpUrl, knobs = {}, env = {}, backoff } = {}) {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gc-sup-"))
	const ws = path.join(dir, "ws")
	await fsp.mkdir(ws)
	const knobsFile = path.join(dir, "knobs.json")
	const setKnobs = (value) => fs.writeFileSync(knobsFile, JSON.stringify(value))
	setKnobs(knobs)
	const bin = path.join(dir, "opencode")
	await fsp.writeFile(bin, `#!${process.execPath}\nprocess.env.FAKE_OPENCODE_KNOBS = ${JSON.stringify(knobsFile)}\nimport(${JSON.stringify(FAKE)})\n`, { mode: 0o755 })
	const config = loadConfig({
		PATH: "/usr/local/bin:/usr/bin:/bin",
		LANG: "C.UTF-8",
		WORKSPACE_DIR: ws,
		RUNTIME_STATE_ROOT: path.join(dir, "state"),
		RUNTIME_LOG_DIR: path.join(dir, "logs"),
		OPENCODE_BIN: bin,
		RUNTIME_OPENCODE_CONFIG_DIR: path.join(dir, "config"),
		RUNTIME_TOOL_HOME: path.join(dir, "toolhome"),
		LLM_PROXY_URL: "http://127.0.0.1:9/v1",
		IDE_LLM_TOKEN: "",
		RUNTIME_ENGINE_MCP_WAIT_S: "2",
		RUNTIME_ENGINE_TOOLS_SETTLE_MS: "50",
		RUNTIME_ENGINE_WATCH_MS: "100",
		RUNTIME_TREE_SNAPSHOT_MS: "100",
		RUNTIME_AGENT_INIT_TIMEOUT_S: "10",
		...env,
	})
	const logger = captureLogger()
	const sup = new AgentSupervisor({ config, logger, mcpUrl: mcpUrl ?? (await closedMcpUrl()), restartBackoffMs: backoff })
	const events = []
	for (const name of RECORDED) sup.on(name, (...args) => events.push({ name, args }))
	sup.on("ready", () => {
		seenPids.add(sup.pid)
		const serverPid = sup.agentInfo?._meta?.serverPid
		if (serverPid) seenPids.add(serverPid)
	})
	t.after(async () => {
		await sup.stop()
		await fsp.rm(dir, { recursive: true, force: true })
	})
	return { sup, config, events, logger, dir, setKnobs }
}

/** The next `name` event matching `pred`, as its argument list. */
function nextEvent(sup, name, pred = () => true, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sup.off(name, on)
			reject(new Error(`no "${name}" event within ${timeoutMs} ms`))
		}, timeoutMs)
		const on = (...args) => {
			if (!pred(...args)) return
			clearTimeout(timer)
			sup.off(name, on)
			resolve(args)
		}
		sup.on(name, on)
	})
}

const say = (sessionId, text) => ({ sessionId, prompt: [{ type: "text", text }] })
const updatesOf = (events, sessionId, from = 0) => events.slice(from).filter((e) => e.name === "update" && e.args[0].sessionId === sessionId).map((e) => e.args[0].update)
const textOf = (events, sessionId, from = 0) =>
	updatesOf(events, sessionId, from)
		.filter((u) => u.sessionUpdate === "agent_message_chunk")
		.map((u) => u.content.text)
		.join("")

after(async () => {
	// Safety net: nothing a test started may outlive the file
	const left = [...seenPids].filter(alive)
	for (const pid of left) {
		try {
			process.kill(pid, "SIGKILL")
		} catch {}
	}
	assert.deepEqual(left, [], "processes left running after the tests")
})

// ---- engine-stream.js ----------------------------------------------------------------------------

test("engine stream: session/update and request_permission become raw ext calls, in wire order, with the rpc id", async () => {
	assert.deepEqual(rewriteInbound({ jsonrpc: "2.0", id: 3, result: {} }), { jsonrpc: "2.0", id: 3, result: {} })
	assert.equal(rewriteInbound({ method: "session/update", params: { a: 1 } }).method, ENGINE_UPDATE_METHOD)
	const perm = rewriteInbound({ jsonrpc: "2.0", id: 0, method: "session/request_permission", params: { sessionId: "s", _meta: { keep: true } } })
	assert.equal(perm.method, ENGINE_PERMISSION_METHOD)
	assert.deepEqual(perm.params._meta, { keep: true, [RPC_ID_META]: 0 })

	const toEngine = new PassThrough()
	const fromEngine = new PassThrough()
	const written = []
	toEngine.on("data", (chunk) => written.push(...String(chunk).split("\n").filter(Boolean).map((l) => JSON.parse(l))))
	const seen = []
	let answered
	const answeredP = new Promise((resolve) => (answered = resolve))
	new ClientSideConnection(
		() => ({
			sessionUpdate: async () => seen.push("VALIDATED sessionUpdate"),
			requestPermission: async () => seen.push("VALIDATED requestPermission"),
			extNotification: async (method, params) => void seen.push([method, params]),
			extMethod: async (method, params) => {
				seen.push([method, params])
				setTimeout(answered, 20)
				return { outcome: { outcome: "selected", optionId: params.options[0].optionId } }
			},
		}),
		engineStream(toEngine, fromEngine),
	)
	const frames = [
		{ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "usage_update", used: 15, size: 200000, cost: { amount: 0, currency: "USD" } } } },
		{ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", messageId: "msg_1", content: { type: "text", text: "hi" } } } },
		{ method: "opencode/session/child_update", params: { rootSessionId: "s", childSessionId: "c", type: "status", status: "created" } },
		{ id: 0, method: "session/request_permission", params: { sessionId: "s", toolCall: { toolCallId: "c:call_1" }, options: [{ optionId: "once", kind: "allow_once_future", name: "Allow" }] } },
		{ method: "$/cancel_request", params: { requestId: 0 } },
	]
	fromEngine.write(frames.map((f) => JSON.stringify({ jsonrpc: "2.0", ...f })).join("\n") + "\n")
	await answeredP
	assert.deepEqual(
		seen.map((s) => (Array.isArray(s) ? s[0] : s)),
		[ENGINE_UPDATE_METHOD, ENGINE_UPDATE_METHOD, "opencode/session/child_update", ENGINE_PERMISSION_METHOD, "$/cancel_request"],
	)
	assert.equal(seen[0][1].update.sessionUpdate, "usage_update") // 0.13.1 alone drops it
	assert.equal(seen[1][1].update.messageId, "msg_1") // 0.13.1 alone strips it
	assert.equal(seen[3][1]._meta[RPC_ID_META], 0)
	assert.equal(seen[3][1].options[0].kind, "allow_once_future") // not validated, so not refused
	assert.deepEqual(written, [{ jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "selected", optionId: "once" } } }])
	fromEngine.end()
})

// ---- start and readiness --------------------------------------------------------------------------

test("start: ready with tools connected, a whitelisted env, the warm-up leaves no session", async (t) => {
	const mcp = await startMcp()
	t.after(mcp.close)
	const { sup, config, events, logger } = await setup(t, { mcpUrl: mcp.url })
	await assert.rejects(sup.newSession(), (e) => e instanceof RequestError && e.code === -32003 && e.data.state === "stopped")

	const info = await sup.start()
	assert.equal(sup.state, "ready")
	assert.equal(info.generation, 1)
	assert.equal(sup.tools, "connected")
	assert.deepEqual(events.find((e) => e.name === "ready").args[0], { generation: 1, restarted: false, tools: "connected" })
	assert.equal(await sup.start().then((i) => i.generation), 1, "start() is idempotent")

	const meta = sup.agentInfo._meta
	assert.deepEqual(meta.envKeys, [...Object.keys(meta.env), "PATH"].sort())
	assert.deepEqual(meta.argv, ["acp"])
	assert.equal(meta.cwd, config.workspaceDir)
	assert.deepEqual(meta.env, {
		HOME: config.engineHome,
		LANG: "C.UTF-8",
		XDG_DATA_HOME: path.join(config.engineStateDir, "data"),
		XDG_STATE_HOME: path.join(config.engineStateDir, "state"),
		XDG_CACHE_HOME: path.join(config.engineStateDir, "cache"),
		XDG_CONFIG_HOME: config.engineXdgConfigHome,
		OPENCODE_CONFIG_DIR: config.engineConfigDir,
		OPENCODE_MODELS_PATH: config.engineModelsPath,
		OPENCODE_CONFIG_PROJECT_DISABLE: "1",
		OPENCODE_DISABLE_PROJECT_CONFIG: "1",
		OPENCODE_DISABLE_MODELS_FETCH: "1",
		OPENCODE_DISABLE_AUTOUPDATE: "1",
		OPENCODE_PRINT_LOGS: "1",
		GEOCLUSTER_MCP_URL: mcp.url,
		GEOCLUSTER_TOOL_HOME: config.toolHome,
		LLM_PROXY_URL: "http://127.0.0.1:9/v1",
	})
	for (const sub of ["data", "state", "cache"]) assert.equal(fs.statSync(path.join(config.engineStateDir, sub)).mode & 0o777, 0o700)
	assert.equal(fs.readFileSync(`/proc/${sup.pid}/oom_score_adj`, "utf8").trim(), String(config.engineOomScoreAdj))

	// the warm-up's session/new + session/delete: nothing listed, and its frames were not emitted
	assert.deepEqual((await sup.listSessions({ cwd: config.workspaceDir })).sessions, [])
	assert.equal(events.filter((e) => e.name === "update").length, 0)
	assert.match(fs.readFileSync(path.join(config.logDir, "agent.stderr.log"), "utf8"), /message="mcp connected" server=geocluster/)
	assert.ok(logger.lines.some((l) => l.message === "engine ready"))
})

test("tools: 'mcp connect failed' → ready at once without tools", async (t) => {
	const { sup, events, logger } = await setup(t) // MCP down
	const t0 = Date.now()
	await sup.start()
	assert.equal(sup.tools, "missing")
	assert.ok(Date.now() - t0 < 1500, "a definitive failure must not wait for engineMcpWaitMs")
	assert.equal(events.find((e) => e.name === "ready").args[0].tools, "missing")
	assert.equal(events.filter((e) => e.name === "tools").length, 0, "the state at ready is in the ready payload, not a tools event")
	assert.ok(logger.lines.some((l) => l.level === "warn" && /could not connect to the geocluster MCP/.test(l.message)))
})

test("tools: no MCP line within engineMcpWaitMs → ready without tools; a later 'connected' line emits tools", async (t) => {
	const mcp = await startMcp()
	t.after(mcp.close)
	const { sup, events } = await setup(t, { mcpUrl: mcp.url, knobs: { FAKE_OPENCODE_MCP_DELAY_MS: "1600" }, env: { RUNTIME_ENGINE_MCP_WAIT_S: "1" } })
	const t0 = Date.now()
	await sup.start()
	assert.ok(Date.now() - t0 >= 900, `ready after the wait (${Date.now() - t0} ms)`)
	assert.equal(sup.tools, "missing")
	const [change] = await nextEvent(sup, "tools", () => true, 3000)
	assert.deepEqual(change, { state: "connected", generation: 1 })
	assert.equal(sup.tools, "connected")
	assert.equal(events.filter((e) => e.name === "tools").length, 1)
})

test("start fails when the engine lacks the child-session capability; a restart is scheduled", async (t) => {
	const { sup, events, logger } = await setup(t, { knobs: { FAKE_OPENCODE_NO_CHILD_CAP: "1" }, backoff: [60000] })
	await assert.rejects(sup.start(), /opencode\/child-session-updates/)
	assert.equal(sup.state, "restarting")
	await waitFor(() => events.some((e) => e.name === "exit"), 3000, "exit")
	const exit = events.find((e) => e.name === "exit").args[0]
	assert.equal(exit.reason, "start_failed")
	assert.equal(exit.expected, false)
	assert.ok(logger.lines.some((l) => l.message === "engine start failed"))
	await sup.stop()
	assert.equal(sup.state, "stopped")
})

test("stop() during a start leaves no engine behind", async (t) => {
	const { sup } = await setup(t, { knobs: { FAKE_OPENCODE_MCP_DELAY_MS: "60000" } })
	// before the spawn: the start is cancelled
	const early = sup.start()
	await sup.stop()
	await assert.rejects(early, /cancelled/)
	assert.equal(sup.pid, null)
	// after the spawn, while waiting for the tools
	const late = sup.start()
	const pid = await waitFor(() => sup.pid, 3000, "spawn")
	await sleep(300)
	await sup.stop()
	await assert.rejects(late)
	assert.equal(alive(pid), false)
	assert.equal(sup.state, "stopped")
})

// ---- forwarded calls ------------------------------------------------------------------------------

test("calls: modes, config options, close/delete/resume, engine errors keep their codes", async (t) => {
	const { sup, config, events } = await setup(t)
	await assert.rejects(sup.whenReady(100), (e) => e.code === -32003)
	await sup.start()
	assert.equal(await sup.whenReady(100), 1)

	const created = await sup.newSession()
	const { sessionId } = created
	assert.match(sessionId, /^ses_[0-9A-Za-z]{26}$/)
	assert.deepEqual(
		created.configOptions.map((o) => o.id),
		["model", "effort", "mode"],
	)
	assert.deepEqual(await sup.setMode(sessionId, "standard"), {})
	await assert.rejects(sup.setMode(sessionId, "bogus"), (e) => e instanceof RequestError && e.code === -32602 && e.data.mode === "bogus")
	const changed = await sup.setConfigOption(sessionId, "model", "proxy/z-ai/glm-5.3-flash")
	assert.equal(changed.configOptions.find((o) => o.id === "model").currentValue, "proxy/z-ai/glm-5.3-flash")
	await assert.rejects(sup.setConfigOption(sessionId, "bogus", "x"), (e) => e.code === -32602 && e.data.configId === "bogus")

	let mark = events.length
	assert.equal((await sup.prompt(say(sessionId, "model"))).stopReason, "end_turn")
	assert.equal(textOf(events, sessionId, mark), "proxy/z-ai/glm-5.3-flash")
	await assert.rejects(sup.prompt(say(sessionId, "error auth")), (e) => e instanceof RequestError && e.code === -32000)
	await assert.rejects(sup.prompt(say(sessionId, "error 400")), (e) => e.code === -32603 && e.data.errorName === "provider.invalid-request")
	assert.ok((await sup.listSessions({ cwd: config.workspaceDir })).sessions.some((s) => s.sessionId === sessionId))

	assert.deepEqual(await sup.closeSession(sessionId), {})
	await assert.rejects(sup.prompt(say(sessionId, "origin")), (e) => e.code === -32602 && e.data.sessionId === sessionId)
	const resumed = await sup.resumeSession(sessionId)
	assert.equal(resumed.configOptions.find((o) => o.id === "mode").currentValue, "standard")
	mark = events.length
	await sup.prompt(say(sessionId, "origin"))
	assert.equal(textOf(events, sessionId, mark), "resume")
	assert.deepEqual(await sup.deleteSession(sessionId), {})
	await assert.rejects(sup.resumeSession(sessionId), (e) => e.code === -32602)
	// a bad cwd gives the same ClientError as a dead server: the probe tells them apart
	await assert.rejects(sup.newSession({ cwd: "relative/dir" }), (e) => e.data?.errorName === "ClientError")
	assert.equal(await sup.checkHealth(), true)
	assert.equal(sup.generation, 1)
	assert.equal(sup.state, "ready")
})

test("frames: usage_update, messageId and child_update arrive raw and in wire order", async (t) => {
	const { sup, events } = await setup(t)
	await sup.start()
	const { sessionId } = await sup.newSession()
	const mark = events.length
	const result = await sup.prompt(say(sessionId, "delegate"))
	assert.equal(result.stopReason, "end_turn")
	assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })

	const turn = events.slice(mark).filter((e) => e.name === "update" || e.name === "child")
	assert.ok(turn.every((e) => e.args[1] === 1), "every frame carries generation 1")
	const updates = updatesOf(events, sessionId, mark)
	assert.deepEqual(updates[updates.length - 1], { sessionUpdate: "usage_update", used: 15, size: 200000, cost: { amount: 0, currency: "USD" } })
	const chunk = updates.find((u) => u.sessionUpdate === "agent_message_chunk")
	assert.match(chunk.messageId, /^msg_/)
	assert.equal(chunk.content.text, "delegated")

	const children = turn.filter((e) => e.name === "child").map((e) => e.args[0])
	const statuses = (depth) => children.filter((c) => c.depth === depth && c.type === "status").map((c) => c.status)
	assert.deepEqual(statuses(1), ["created", "running", "completed"])
	assert.deepEqual(statuses(2), ["created", "running", "completed"])
	const s1 = children.find((c) => c.depth === 1).childSessionId
	const s2 = children.find((c) => c.depth === 2)
	assert.equal(s2.parentSessionId, s1)
	assert.equal(s2.rootSessionId, sessionId)
	for (const c of children.filter((c) => c.type === "update")) assert.equal(c.update._meta["opencode/child-session"].id, c.childSessionId)
	const childChunk = children.find((c) => c.type === "update" && c.update.sessionUpdate === "agent_message_chunk")
	assert.match(childChunk.update.messageId, /^msg_/)

	// wire order: the root's duplicate in_progress comes right after S1's `created`
	const created = turn.findIndex((e) => e.name === "child" && e.args[0].childSessionId === s1 && e.args[0].status === "created")
	const next = turn[created + 1]
	assert.equal(next.name, "update")
	assert.equal(next.args[0].update.status, "in_progress")
	assert.equal(next.args[0].update.title, "subagent")
	const completed = updates.find((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed")
	assert.equal(completed.rawOutput.metadata.sessionID, s1)
})

// ---- permissions ----------------------------------------------------------------------------------

test("permission: the event carries rpcId and resolve() answers the engine", async (t) => {
	const { sup, events } = await setup(t)
	await sup.start()
	const { sessionId } = await sup.newSession()
	const asked = []
	sup.on("permission", (request) => {
		asked.push(request)
		request.resolve({ outcome: { outcome: "selected", optionId: "once" } })
		request.resolve({ outcome: { outcome: "selected", optionId: "reject" } }) // ignored: first answer wins
	})
	let mark = events.length
	assert.equal((await sup.prompt(say(sessionId, "ask"))).stopReason, "end_turn")
	assert.equal(textOf(events, sessionId, mark), "done")
	const [first] = asked
	assert.equal(first.rpcId, 0) // the engine's request ids start at 0
	assert.equal(first.generation, 1)
	assert.equal(first.params.sessionId, sessionId) // asked on the ROOT id
	assert.equal(first.params._meta[RPC_ID_META], 0)
	assert.match(first.params.toolCall.toolCallId, /^ses_[0-9A-Za-z]+:call_p$/)
	assert.deepEqual(
		first.params.options.map((o) => o.kind),
		["allow_once", "allow_always", "reject_once"],
	)
	mark = events.length
	await sup.prompt(say(sessionId, "ask"))
	assert.equal(asked[1].rpcId, 1)
})

test("permission: a cancel while pending emits cancelRequest; a late answer fails PermissionNotFoundError; answer-then-cancel is clean", async (t) => {
	const { sup } = await setup(t)
	await sup.start()
	const { sessionId } = await sup.newSession()
	let pending = null
	sup.on("permission", (request) => {
		pending = request
	})
	const turn = sup.prompt(say(sessionId, "ask"))
	await waitFor(() => pending, 3000, "permission")
	const withdrawn = nextEvent(sup, "cancelRequest")
	await sup.cancel(sessionId)
	const [request, generation] = await withdrawn
	assert.deepEqual(request, { requestId: pending.rpcId })
	assert.equal(generation, 1)
	pending.resolve({ outcome: { outcome: "cancelled" } })
	await assert.rejects(turn, (e) => e.code === -32603 && e.data.errorName === "PermissionNotFoundError")

	// the broker's order: answer every pending request first, then cancel
	pending = null
	const second = sup.prompt(say(sessionId, "ask"))
	await waitFor(() => pending, 3000, "permission")
	pending.resolve({ outcome: { outcome: "cancelled" } })
	await sup.cancel(sessionId)
	assert.equal((await second).stopReason, "cancelled")
})

test("permission: with no listener the request is cancelled", async (t) => {
	const { sup } = await setup(t)
	await sup.start()
	const { sessionId } = await sup.newSession()
	assert.equal((await sup.prompt(say(sessionId, "ask"))).stopReason, "cancelled")
})

// ---- processes ------------------------------------------------------------------------------------

test("conversationProcesses finds a conversation's processes by GEOCLUSTER_RUN_DIR; stop() leaves nothing", async (t) => {
	const { sup, events } = await setup(t)
	await sup.start()
	const a = (await sup.newSession()).sessionId
	const b = (await sup.newSession()).sessionId
	let mark = events.length
	await sup.prompt(say(a, "kid"))
	const kidA = Number(/kid (\d+)/.exec(textOf(events, a, mark))[1])
	mark = events.length
	const hanging = sup.prompt(say(b, "kidhang"))
	await waitFor(() => /kid \d+/.test(textOf(events, b, mark)), 3000, "kidhang")
	const kidB = Number(/kid (\d+)/.exec(textOf(events, b, mark))[1])
	await sup.cancel(b)
	assert.equal((await hanging).stopReason, "cancelled")
	assert.ok(alive(kidA) && alive(kidB), "the engine left both running")

	assert.deepEqual(
		(await sup.conversationProcesses(`runs/${a}`)).map((p) => p.pid),
		[kidA],
	)
	assert.deepEqual(
		(await sup.conversationProcesses(`runs/${b}`)).map((p) => p.pid),
		[kidB],
	)
	assert.deepEqual(await sup.conversationProcesses("runs/ses_nobody"), [])
	assert.deepEqual(await sup.conversationProcesses(`runs/${a}/sub`), [], "exact match only")
	assert.deepEqual(withEnv([{ pid: kidA, start: "0" }], "GEOCLUSTER_RUN_DIR", `runs/${a}`), [], "a changed start time is a different process")

	const enginePid = sup.pid
	const serverPid = sup.agentInfo._meta.serverPid
	await sup.stop()
	for (const pid of [enginePid, serverPid, kidA, kidB]) assert.equal(alive(pid), false, `pid ${pid} still alive after stop()`)
	assert.equal(sup.state, "stopped")
})

// ---- failures and restarts ------------------------------------------------------------------------

test("restart(reason): an expected exit, generation + 1, sessions must be resumed, not counted as a crash", async (t) => {
	const { sup, events } = await setup(t)
	await sup.start()
	const { sessionId } = await sup.newSession()
	const exited = nextEvent(sup, "exit")
	const readyAgain = nextEvent(sup, "ready", (info) => info.generation === 2)
	await sup.restart("test restart")
	const [exit] = await exited
	assert.deepEqual(exit, { code: 130, signal: null, expected: true, generation: 1, reason: "test restart" })
	assert.deepEqual((await readyAgain)[0], { generation: 2, restarted: true, tools: "missing" })
	assert.equal(sup.generation, 2)
	assert.equal(sup.restarts.length, 0)
	await assert.rejects(sup.prompt(say(sessionId, "origin")), (e) => e.code === -32602)
	await sup.resumeSession(sessionId)
	const mark = events.length
	await sup.prompt(say(sessionId, "origin"))
	assert.equal(textOf(events, sessionId, mark), "resume")
	assert.equal(events.filter((e) => e.name === "update").at(-1).args[1], 2, "frames of the new engine carry generation 2")
})

test("crash: the in-flight call is rejected EngineExited, then a restart after the backoff", async (t) => {
	const { sup } = await setup(t) // default backoff: 1 s first
	await sup.start()
	const { sessionId } = await sup.newSession()
	const exited = nextEvent(sup, "exit")
	const readyAgain = nextEvent(sup, "ready", (info) => info.generation === 2, 5000)
	await assert.rejects(sup.prompt(say(sessionId, "crash")), (e) => e instanceof RequestError && e.data.errorName === "EngineExited" && e.data.generation === 1)
	const t0 = Date.now()
	const [exit] = await exited
	assert.deepEqual(exit, { code: 3, signal: null, expected: false, generation: 1, reason: "crash" })
	assert.equal(sup.state, "restarting")
	await assert.rejects(sup.newSession(), (e) => e.code === -32003 && e.data.state === "restarting")
	await readyAgain
	assert.ok(Date.now() - t0 >= 900, `restarted after the 1 s backoff (${Date.now() - t0} ms)`)
	assert.equal(sup.restarts.length, 1)
})

test("server death: the watch restarts the engine; the in-flight prompt fails", async (t) => {
	const { sup, events } = await setup(t, { backoff: [100] })
	await sup.start()
	const { sessionId } = await sup.newSession()
	const exited = nextEvent(sup, "exit")
	const readyAgain = nextEvent(sup, "ready", (info) => info.generation === 2)
	await assert.rejects(sup.prompt(say(sessionId, "serverdie")), (e) => ["ClientError", "EngineExited"].includes(e.data?.errorName))
	const [exit] = await exited
	assert.equal(exit.expected, false)
	assert.equal(exit.generation, 1)
	assert.equal(exit.reason, "server_died")
	await readyAgain
	assert.equal(sup.generation, 2)
	await sup.resumeSession(sessionId)
	const mark = events.length
	await sup.prompt(say(sessionId, "origin"))
	assert.equal(textOf(events, sessionId, mark), "resume")
})

test("server death: a ClientError probes automatically; checkHealth() → false and a restart", async (t) => {
	const { sup } = await setup(t, { backoff: [100], env: { RUNTIME_ENGINE_WATCH_MS: "60000" } }) // the /proc watch is out of the way
	await sup.start()
	assert.equal(await sup.checkHealth(), true)

	// a call fails ClientError → the shared probe sees the dead server → restart
	let serverPid = sup.agentInfo._meta.serverPid
	process.kill(serverPid, "SIGKILL")
	await waitFor(() => !alive(serverPid), 3000, "server death")
	let exited = nextEvent(sup, "exit")
	let readyAgain = nextEvent(sup, "ready", (info) => info.generation === 2)
	await assert.rejects(sup.newSession(), (e) => e.code === -32603 && e.data.errorName === "ClientError")
	assert.equal((await exited)[0].reason, "server_died")
	await readyAgain

	// an explicit probe
	serverPid = sup.agentInfo._meta.serverPid
	process.kill(serverPid, "SIGKILL")
	await waitFor(() => !alive(serverPid), 3000, "server death")
	exited = nextEvent(sup, "exit")
	readyAgain = nextEvent(sup, "ready", (info) => info.generation === 3)
	const [a, b] = await Promise.all([sup.checkHealth(), sup.checkHealth()])
	assert.deepEqual([a, b], [false, false])
	await exited
	await readyAgain
	assert.equal(await sup.checkHealth(), true)
})

test("unavailable after repeated failed starts; whenReady() starts it again", async (t) => {
	const { sup, setKnobs } = await setup(t, { knobs: { FAKE_OPENCODE_EXIT_AT_START: "3" }, backoff: [20, 20, 20, 20, 20] })
	const gaveUp = nextEvent(sup, "unavailable", () => true, 8000)
	await assert.rejects(sup.start(), (e) => e.data?.errorName === "EngineExited")
	await gaveUp
	assert.equal(sup.state, "unavailable")
	assert.equal(sup.restarts.length, 5)
	await assert.rejects(sup.prompt(say("ses_x", "echo")), (e) => e.code === -32003 && e.data.state === "unavailable")
	setKnobs({})
	assert.equal(await sup.whenReady(5000), 1)
	assert.equal(sup.state, "ready")
	assert.equal(sup.restarts.length, 0)
})
