/**
 * Gateway tests: path containment, the session log, prefs, and the broker + WebSocket bridge driven
 * end-to-end against the scripted fake engine (test/fake-opencode.mjs, the measured contract of
 * `opencode acp` 2.0.19) and the fake shared MCP (test/fake-mcp.mjs).
 * The real engine is exercised by the opt-in test/engine/ suite (`npm run test:engine`).
 * Run: `node --test runtime/test/`
 */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { RequestError } from "@agentclientprotocol/sdk"
import { ActivityReporter } from "../lib/activity.js"
import { createLogger } from "../lib/log.js"
import { PathError, normalizeRelative, resolveInside } from "../lib/paths.js"
import { Prefs, permissionIdentifier } from "../lib/prefs.js"
import { SessionLog } from "../lib/session-log.js"
import { gateCheck } from "../server.js"
import { running, say, startGateway, until, untilAsync, wait, wsClient } from "./gateway-harness.mjs"

const silent = { log() {}, warn() {}, error() {} }

async function tmpdir(prefix) {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

// =============================================================================
// paths
// =============================================================================

test("normalizeRelative: root forms, traversal, NUL", () => {
	assert.equal(normalizeRelative(""), "")
	assert.equal(normalizeRelative("."), "")
	assert.equal(normalizeRelative("/a//b/"), "a/b")
	assert.equal(normalizeRelative("a/./b/../c"), "a/c")
	assert.throws(() => normalizeRelative("../x"), PathError)
	assert.throws(() => normalizeRelative("a/../../x"), PathError)
	assert.throws(() => normalizeRelative("a\0b"), PathError)
})

test("resolveInside: containment through symlinks, hidden dirs, missing files", async () => {
	const root = await tmpdir("paths-")
	const outside = await tmpdir("paths-out-")
	try {
		await fs.mkdir(path.join(root, "data"))
		await fs.writeFile(path.join(root, "data", "a.csv"), "x")
		await fs.writeFile(path.join(outside, "secret"), "y")
		await fs.symlink(outside, path.join(root, "escape"))
		await fs.symlink(path.join(outside, "secret"), path.join(root, "data", "link"))
		await fs.mkdir(path.join(root, ".runtime"))

		const ok = await resolveInside(root, "data/a.csv")
		assert.equal(ok.exists, true)
		assert.equal(ok.relative, "data/a.csv")
		await assert.rejects(resolveInside(root, "escape/secret"), (e) => e.status === 403)
		await assert.rejects(resolveInside(root, "data/link"), (e) => e.status === 403)
		await assert.rejects(resolveInside(root, "escape/new-file"), (e) => e.status === 403, "missing file under a symlinked parent")
		await assert.rejects(resolveInside(root, ".runtime/x"), (e) => e.status === 404)
		const missing = await resolveInside(root, "data/new.csv")
		assert.equal(missing.exists, false)
		assert.equal(missing.absolute, path.join(await fs.realpath(root), "data", "new.csv"))
	} finally {
		await fs.rm(root, { recursive: true, force: true })
		await fs.rm(outside, { recursive: true, force: true })
	}
})

// =============================================================================
// session log
// =============================================================================

test("SessionLog: append, replay from ring and from file, meta persistence", async () => {
	const dir = await tmpdir("slog-")
	try {
		const log = await SessionLog.open(dir, "1700000000001", { cwd: "/w" })
		for (let i = 1; i <= 300; i++) await log.append("update", { sessionId: "1700000000001", update: { i } })
		assert.equal(log.lastSeq, 300)
		const fromRing = []
		await log.replay(290, (e) => fromRing.push(e.seq))
		assert.deepEqual(fromRing, [291, 292, 293, 294, 295, 296, 297, 298, 299, 300])
		const fromFile = []
		await log.replay(2, (e) => fromFile.push(e.seq))
		assert.equal(fromFile.length, 298)
		assert.equal(fromFile[0], 3)
		await log.append("turn_end", { sessionId: "1700000000001", stopReason: "end_turn" }, { sync: true })
		const meta = JSON.parse(await fs.readFile(path.join(dir, "sessions", "1700000000001", "meta.json"), "utf8"))
		assert.equal(meta.lastSeq, 301)
		assert.equal(meta.cwd, "/w")
		// reopen continues the sequence
		const again = await SessionLog.open(dir, "1700000000001")
		assert.equal(again.lastSeq, 301)
		assert.equal(await again.append("update", { update: {} }), 302)
		await assert.rejects(SessionLog.open(dir, "../evil"))
		assert.equal(await SessionLog.exists(dir, "1700000000001"), true)
		assert.equal(await SessionLog.exists(dir, "1700000000002"), false)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

test("SessionLog: a conversation with no events replays nothing (API-24: was ENOENT → -32603)", async () => {
	const dir = await tmpdir("slog-")
	try {
		const log = await SessionLog.open(dir, "1700000000003")
		const seen = []
		const result = await log.replay(0, (e) => seen.push(e))
		assert.deepEqual(seen, [])
		assert.deepEqual(result, { until: 0, firstSeq: 1, truncated: false })
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

test("SessionLog: reopen continues after the last event on disk, not the stale meta; torn and >64 KB lines (API-05)", async () => {
	const dir = await tmpdir("slog-")
	const id = "1700000000004"
	const file = path.join(dir, "sessions", id, "events.ndjson")
	try {
		const log = await SessionLog.open(dir, id)
		for (let i = 0; i < 3; i++) await log.append("update", { update: { i } }) // no sync: meta.json still says 0
		assert.equal(JSON.parse(await fs.readFile(path.join(dir, "sessions", id, "meta.json"), "utf8")).lastSeq, 0)
		const reopened = await SessionLog.open(dir, id) // a crashed gateway's successor
		assert.equal(reopened.lastSeq, 3)
		assert.equal(await reopened.append("update", { update: {} }), 4, "no seq reused")

		// a crash mid-write: half a line without "\n"
		await fs.appendFile(file, '{"seq":5,"ts":1,"kind":"upd')
		const afterTear = await SessionLog.open(dir, id)
		assert.equal(afterTear.lastSeq, 4)
		assert.ok((await fs.readFile(file, "utf8")).endsWith("}\n"), "torn tail cut")
		assert.equal(await afterTear.append("update", { update: { ok: true } }), 5)
		const lines = (await fs.readFile(file, "utf8")).trim().split("\n")
		assert.deepEqual(lines.map((l) => JSON.parse(l).seq), [1, 2, 3, 4, 5], "every line parses")

		// last line longer than one 64 KB scan chunk, meta deleted
		await afterTear.append("update", { update: { big: "x".repeat(200 * 1024) } })
		await fs.rm(path.join(dir, "sessions", id, "meta.json"))
		assert.equal((await SessionLog.open(dir, id)).lastSeq, 6)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

test("SessionLog: rotation keeps one old file in replay; dropped events are reported per replay (API-06)", async () => {
	const dir = await tmpdir("slog-")
	const id = "1700000000005"
	try {
		const log = await SessionLog.open(dir, id, {}, { rotateBytes: 2000 })
		for (let i = 1; i <= 40; i++) await log.append("update", { update: { pad: "p".repeat(60), i } })
		const all = []
		const result = await log.replay(0, (e) => all.push(e.seq))
		assert.ok(result.firstSeq > 1, "the first file was dropped after two rotations")
		assert.equal(result.truncated, true)
		assert.equal(all[0], result.firstSeq, "replay starts at the oldest kept event (events.1.ndjson)")
		assert.deepEqual(all, Array.from({ length: 40 - result.firstSeq + 1 }, (_, k) => result.firstSeq + k), "contiguous across both files")
		const recent = []
		assert.equal((await log.replay(38, (e) => recent.push(e.seq))).truncated, false)
		assert.deepEqual(recent, [39, 40])

		// empty current file right after a rotation: recover the seq from events.1.ndjson
		await fs.writeFile(path.join(dir, "sessions", id, "events.ndjson"), "")
		await fs.rm(path.join(dir, "sessions", id, "meta.json"))
		const reopened = await SessionLog.open(dir, id, {}, { rotateBytes: 2000 })
		assert.ok(reopened.lastSeq >= 1 && reopened.lastSeq < 40)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

test("SessionLog: a failed write doesn't block later ones; replay is a snapshot (no dups, nothing past it)", async () => {
	const dir = await tmpdir("slog-")
	const id = "1700000000006"
	try {
		const errors = []
		const log = await SessionLog.open(dir, id, {}, { onError: (e) => errors.push(e) })
		await log.append("update", { update: { n: 1 } })
		const realFile = log.file
		log.file = path.join(dir, "no-such-dir", "events.ndjson")
		await assert.rejects(log.append("update", { update: { n: 2 } }))
		log.file = realFile
		assert.equal(await log.append("update", { update: { n: 3 } }), 3, "the queue survived the failure")
		const seqs = []
		await log.replay(0, (e) => seqs.push(e.seq))
		assert.deepEqual(seqs, [1, 3], "the failed event is never replayed")
		assert.equal(errors.length, 1)

		// events appended while a slow replay runs are not part of it (they reach sockets live)
		const during = []
		const replay = log.replay(0, async (e) => {
			during.push(e.seq)
			await log.append("update", { update: { late: e.seq } })
			await wait(5)
		})
		const result = await replay
		assert.deepEqual(during, [1, 3])
		assert.equal(result.until, 3)
		log.closed = true
		await assert.rejects(log.append("update", {}), /closed/)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

// =============================================================================
// prefs
// =============================================================================

test("Prefs: identifiers follow permissionHandler.ts; allow_always persists", async () => {
	const dir = await tmpdir("prefs-")
	try {
		assert.deepEqual(permissionIdentifier({ rawInput: { command: "npm test --silent" } }), { kind: "command", id: "npm" })
		assert.deepEqual(permissionIdentifier({ rawInput: { serverName: "geocluster-mcp" } }), { kind: "mcp", id: "geocluster-mcp" })
		assert.deepEqual(permissionIdentifier({ rawInput: { tool: "editedExistingFile" } }), { kind: "tool", id: "editedExistingFile" })
		assert.equal(permissionIdentifier({ rawInput: {} }), null)
		const prefs = await Prefs.load(dir)
		const call = { rawInput: { command: "ls -la" } }
		assert.equal(prefs.isAllowed(call), false)
		await prefs.allowAlways(call)
		assert.equal(prefs.isAllowed({ rawInput: { command: "ls /tmp" } }), true)
		assert.equal(prefs.isAllowed({ rawInput: { command: "rm -rf /" } }), false)
		const reloaded = await Prefs.load(dir)
		assert.equal(reloaded.isAllowed(call), true)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

test("gateCheck: constant-time compare, disabled when no secret", () => {
	assert.equal(gateCheck("", undefined), true)
	assert.equal(gateCheck("abc", "abc"), true)
	assert.equal(gateCheck("abc", "abd"), false)
	assert.equal(gateCheck("abc", undefined), false)
	assert.equal(gateCheck("abc", "abcd"), false)
})


test("ActivityReporter: turn age warns once and activity continues until the last turn ends", async (t) => {
	const calls = []
	const r = new ActivityReporter({ activityUrl: "http://x", activityToken: "t", activityIntervalMs: 50, maxTurnMs: 120 }, createLogger("t", silent), async (_u, init) => {
		calls.push(JSON.parse(init.body).state)
		return { ok: true }
	})
	t.after(() => { for (const id of r.turns.keys()) r.stop(id) })
	const aged = []
	r.onAgeNotice = (id) => aged.push(id)
	r.start("a")
	r.start("b")
	r.setState("b", "permission_pending")
	assert.equal(r.state, "permission_pending")
	r.stop("a")
	assert.ok(!calls.includes("idle"))
	await wait(200)
	assert.deepEqual(aged, ["b"])
	assert.equal(r.state, "permission_pending", "age never removes live work from activity")
	const before = calls.length
	await wait(150)
	assert.ok(calls.length > before, "backend keepalives continue after the notice")
	assert.deepEqual(aged, ["b"], "the notice is not repeated each tick")
	r.stop("b")
	await wait(20)
	assert.equal(calls.at(-1), "idle", "ending an aged turn still sends the idle transition")
	r.start("c")
	r.stop("c")
	await wait(20)
	assert.equal(calls[calls.length - 1], "idle")
})

test("ActivityReporter: a zero age threshold disables notices, not keepalives", async (t) => {
	const calls = []
	const r = new ActivityReporter({ activityUrl: "http://x", activityToken: "t", activityIntervalMs: 20, maxTurnMs: 0 }, createLogger("t", silent), async (_u, init) => {
		calls.push(JSON.parse(init.body).state)
		return { ok: true }
	})
	t.after(() => r.stop("a"))
	const notices = []
	r.onAgeNotice = (id) => notices.push(id)
	r.start("a")
	await wait(80)
	assert.deepEqual(notices, [])
	assert.ok(calls.length > 1)
	assert.ok(calls.every((state) => state === "prompt_running"))
})

function recordingReporter(config, logger = createLogger("t", silent)) {
	const calls = []
	const reporter = new ActivityReporter({ activityUrl: "http://x", activityToken: "t", activityIntervalMs: 60000, storageReportIntervalMs: 300000, maxTurnMs: 0, workspaceDir: os.tmpdir(), ...config }, logger, async (_u, init) => {
		calls.push(JSON.parse(init.body))
		return { ok: true }
	})
	return { reporter, calls }
}

test("ActivityReporter: every post carries the agent's state and the disk usage of the workspace volume", async (t) => {
	const workspaceDir = await tmpdir("activity-")
	t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }))
	const { reporter, calls } = recordingReporter({ workspaceDir })
	t.after(() => reporter.close())
	reporter.start("a")
	assert.equal(calls.length, 1)
	const [body] = calls
	assert.deepEqual(Object.keys(body).sort(), ["agent", "session_id", "state", "storage"])
	assert.equal(body.state, "prompt_running")
	assert.equal(body.session_id, "a")
	assert.deepEqual(body.agent, { state: "working", turn_completed_at: null })
	const disk = await fs.statfs(workspaceDir)
	assert.equal(body.storage.total_bytes, disk.blocks * disk.bsize)
	assert.ok(Number.isSafeInteger(body.storage.used_bytes) && body.storage.used_bytes > 0 && body.storage.used_bytes <= body.storage.total_bytes)
	assert.ok(Math.abs(Date.parse(body.storage.measured_at) - Date.now()) < 5000)
})

test("ActivityReporter: a permission request, its answer and every turn end are posted at once", async (t) => {
	const { reporter, calls } = recordingReporter({})
	t.after(() => reporter.close())
	// Each event follows the previous post's answer, as events a person drives do
	for (const event of [() => reporter.start("a"), () => reporter.start("b"), () => reporter.setState("a", "permission_pending"), () => reporter.setState("a", "permission_pending"), () => reporter.setState("a", "prompt_running"), () => reporter.stop("a"), () => reporter.stop("b", { completed: true })]) {
		event()
		await wait(0)
	}
	assert.deepEqual(calls.map((c) => [c.state, c.session_id, c.agent.state]), [
		["prompt_running", "a", "working"],
		["prompt_running", "b", "working"],
		["permission_pending", "a", "needs_input"],
		["prompt_running", "a", "working"],
		["prompt_running", "a", "working"],
		["idle", "b", "idle"],
	])
	assert.ok(calls.slice(0, -1).every((c) => c.agent.turn_completed_at === null), "a turn ended without completing records nothing")
	assert.ok(Math.abs(Date.parse(calls.at(-1).agent.turn_completed_at) - Date.now()) < 5000)
})

test("ActivityReporter: a zero storage interval leaves disk usage out of every post", () => {
	const { reporter, calls } = recordingReporter({ storageReportIntervalMs: 0 })
	reporter.start("a")
	assert.equal(calls.length, 1)
	assert.equal("storage" in calls[0], false)
})

test("ActivityReporter: disk usage is reported from start while idle, until close", async (t) => {
	const { reporter, calls } = recordingReporter({ storageReportIntervalMs: 20 })
	t.after(() => reporter.close())
	reporter.startStorageReports()
	assert.equal(calls.length, 1, "the first report goes out at start")
	await until(() => calls.length >= 3)
	for (const body of calls) {
		assert.equal(body.state, "idle")
		assert.deepEqual(body.agent, { state: "idle", turn_completed_at: null })
		assert.ok(body.storage.total_bytes > 0)
	}
	reporter.close()
	const sent = calls.length
	await wait(60)
	assert.equal(calls.length, sent, "close stops the reports")
})

test("ActivityReporter: an unreadable volume leaves storage out, warns once, and still posts", async () => {
	const warnings = []
	const { reporter, calls } = recordingReporter({ workspaceDir: path.join(os.tmpdir(), `no-volume-${process.pid}`) }, { warn: (message) => warnings.push(message) })
	reporter.start("a")
	await wait(0)
	reporter.stop("a", { completed: true })
	await wait(0)
	assert.deepEqual(calls.map((c) => [c.state, c.agent.state, "storage" in c]), [["prompt_running", "working", false], ["idle", "idle", false]])
	assert.equal(warnings.length, 1)
})

test("the backend hears at once when the agent needs input and when it is working again", async (t) => {
	// Keepalive ticks are a minute apart, so every post here comes from the event itself
	const g = await startGateway(t, { env: { RUNTIME_ACTIVITY_INTERVAL_S: "60" } })
	let answer
	const answered = new Promise((r) => (answer = r))
	const c = await g.client({ permission: () => answered })
	const { sessionId } = await c.conn.newSession({ cwd: g.workspace, mcpServers: [] })
	const turn = c.conn.prompt(say(sessionId, "ask"))
	await until(() => g.activityCalls.at(-1)?.agent.state === "needs_input", 3000)
	assert.equal(g.activityCalls.at(-1).state, "permission_pending")
	answer({ outcome: { outcome: "selected", optionId: "once" } })
	assert.equal((await turn).stopReason, "end_turn")
	const states = g.activityCalls.map((call) => call.agent.state)
	assert.deepEqual(states.slice(states.indexOf("needs_input")), ["needs_input", "working", "idle"])
})

test("only a turn that ends normally records when the agent last completed a turn", async (t) => {
	const g = await startGateway(t)
	const c = await g.client()
	const { sessionId } = await c.conn.newSession({ cwd: g.workspace, mcpServers: [] })
	assert.equal((await c.conn.prompt(say(sessionId, "error 400")))._meta.reason, "error")
	const hang = c.conn.prompt(say(sessionId, "hang"))
	await until(() => g.app.activity.state === "prompt_running")
	await c.conn.cancel({ sessionId })
	assert.equal((await hang)._meta.reason, "cancelled")
	const engine = g.app.broker.engine, prompt = engine.prompt.bind(engine)
	engine.prompt = async () => {
		throw { code: -32603, message: "Internal error: " + JSON.stringify({ error: { code: "usage_limit_reached", message: "Allowance exhausted", retryable: false } }), data: { errorName: "provider.quota" } }
	}
	assert.equal((await c.conn.prompt(say(sessionId, "analyze")))._meta.reason, "paused_for_usage")
	engine.prompt = prompt
	assert.equal(g.activityCalls.at(-1).state, "idle")
	assert.ok(g.activityCalls.every((call) => call.agent.turn_completed_at === null))
	const before = Date.now()
	assert.equal((await c.conn.prompt(say(sessionId, "echo done"))).stopReason, "end_turn")
	const last = g.activityCalls.at(-1)
	assert.equal(last.agent.state, "idle")
	assert.ok(Date.parse(last.agent.turn_completed_at) >= before)
	assert.equal((await c.conn.prompt(say(sessionId, "error 400")))._meta.reason, "error")
	assert.equal(g.activityCalls.at(-1).agent.turn_completed_at, last.agent.turn_completed_at, "a later failure keeps the last completion")
})

test("runtime status offers the model and effort a new conversation starts with, before any conversation exists", async (t) => {
	const g = await startGateway(t)
	const client = await g.client()
	const status = await client.conn.extMethod("_gc/status", {})
	assert.deepEqual(status.newSession.configOptions.map((o) => o.id), ["model", "effort"], "mode is not the browser's to change")
	const runs = await fs.readdir(path.join(g.config.workspaceDir, "runs")).catch(() => [])
	assert.deepEqual(runs, [], "offering them starts no conversation")
	const created = await client.conn.newSession({ cwd: "", mcpServers: [] })
	assert.deepEqual(status.newSession.configOptions, created.configOptions)
})

test("conversations start on the runtime's default effort, a model change returns to it, and an explicit choice stays", async (t) => {
	const g = await startGateway(t)
	const client = await g.client()
	const effortOf = (options) => options.find((o) => o.id === "effort").currentValue
	const status = await client.conn.extMethod("_gc/status", {})
	assert.equal(effortOf(status.newSession.configOptions), "high")
	const created = await client.conn.newSession({ cwd: "", mcpServers: [] })
	assert.equal(effortOf(created.configOptions), "high")
	const set = (configId, value) => client.conn.unstable_setSessionConfigOption({ sessionId: created.sessionId, configId, value })
	assert.equal(effortOf((await set("effort", "low")).configOptions), "low")
	assert.equal(effortOf((await set("model", "proxy/z-ai/glm-5.3-flash")).configOptions), "high", "the engine resets effort on a model change")
	assert.equal(effortOf((await set("effort", "default")).configOptions), "default", "choosing the engine's own default is kept")
	assert.equal(effortOf((await set("model", "proxy/z-ai/glm-5.3-flash")).configOptions), "default", "the same model keeps its effort")
})

test("retrying a partially applied model change finishes the automatic effort change", async (t) => {
	for (const method of ["config", "model"]) {
		await t.test(method, async (st) => {
			const g = await startGateway(st, { knobs: { FAKE_OPENCODE_CONFIG_UPDATES: true } })
			const a = await g.client()
			const b = await g.client()
			const { sessionId } = await a.conn.newSession({ cwd: "", mcpServers: [] })
			await b.conn.extMethod("_gc/attach", { sessionId, afterSeq: 0 })
			const model = "proxy/z-ai/glm-5.3-flash"
			const setModel = () => method === "config"
				? a.conn.unstable_setSessionConfigOption({ sessionId, configId: "model", value: model })
				: a.conn.unstable_setSessionModel({ sessionId, modelId: model })
			const engine = g.app.broker.engine
			const original = engine.setConfigOption.bind(engine)
			let failures = 2
			engine.setConfigOption = async (id, configId, value) => {
				if (id === sessionId && configId === "effort" && failures > 0) {
					failures--
					throw Object.assign(new Error("temporary effort setter failure"), { code: -32603 })
				}
				return original(id, configId, value)
			}
			for (let attempt = 0; attempt < 2; attempt++) {
				await assert.rejects(setModel(), (error) => error.code === -32603 && error.data?.details === "temporary effort setter failure")
				const partial = await b.conn.extMethod("_gc/attach", { sessionId, afterSeq: 0 })
				assert.equal(partial.configOptions.find((o) => o.id === "model").currentValue, model, "the model change succeeded")
				assert.equal(partial.configOptions.find((o) => o.id === "effort").currentValue, "default", "the automatic effort change is still unfinished")
			}
			const response = await setModel()
			const resumed = await a.conn.unstable_resumeSession({ sessionId, cwd: "", mcpServers: [] })
			assert.equal(resumed.configOptions.find((o) => o.id === "effort").currentValue, "high", "retry must apply the runtime default")
			if (method === "config") assert.deepEqual(response.configOptions, resumed.configOptions)
			await until(() => b.updates.some((u) => u.sessionId === sessionId && u.update.sessionUpdate === "config_option_update" && !u.update._meta?.replay))
			assert.deepEqual(b.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "config_option_update" && !u.update._meta?.replay).at(-1).update.configOptions, resumed.configOptions)
			await a.conn.unstable_setSessionConfigOption({ sessionId, configId: "effort", value: "default" })
			await setModel()
			const explicit = await a.conn.unstable_resumeSession({ sessionId, cwd: "", mcpServers: [] })
			assert.equal(explicit.configOptions.find((o) => o.id === "effort").currentValue, "default", "a completed retry must not override a later explicit choice")
		})
	}
})

test("an explicit effort choice supersedes an unfinished automatic effort change", async (t) => {
	const g = await startGateway(t)
	const client = await g.client()
	const { sessionId } = await client.conn.newSession({ cwd: "", mcpServers: [] })
	const engine = g.app.broker.engine
	const original = engine.setConfigOption.bind(engine)
	let fail = true
	engine.setConfigOption = async (id, configId, value) => {
		if (id === sessionId && configId === "effort" && fail) {
			fail = false
			throw Object.assign(new Error("temporary effort setter failure"), { code: -32603 })
		}
		return original(id, configId, value)
	}
	const set = (configId, value) => client.conn.unstable_setSessionConfigOption({ sessionId, configId, value })
	const model = "proxy/z-ai/glm-5.3-flash"
	await assert.rejects(set("model", model), (error) => error.code === -32603)
	await set("effort", "default")
	assert.equal((await set("model", model)).configOptions.find((o) => o.id === "effort").currentValue, "default")
})

test("RUNTIME_DEFAULT_EFFORT=default keeps the engine's own effort", async (t) => {
	const g = await startGateway(t, { env: { RUNTIME_DEFAULT_EFFORT: "default" } })
	const client = await g.client()
	const status = await client.conn.extMethod("_gc/status", {})
	assert.equal(status.newSession.configOptions.find((o) => o.id === "effort").currentValue, "default")
	const created = await client.conn.newSession({ cwd: "", mcpServers: [] })
	assert.equal(created.configOptions.find((o) => o.id === "effort").currentValue, "default")
})

test("effort reconciliation emits a live notice and retains metadata without repeating the notice on replay", async (t) => {
	const g = await startGateway(t), a = await g.client(), b = await g.client()
	const { sessionId } = await a.conn.newSession({ cwd: "", mcpServers: [] })
	await b.conn.extMethod("_gc/attach", { sessionId, afterSeq: 0 })
	const reset = { modelId: "proxy/z-ai/glm-5.3-flash", previousEffort: "retired", effort: "default" }
	g.app.broker.engine.emit("update", { sessionId, update: { sessionUpdate: "session_info_update", _meta: { "geocluster/effort-reset": reset } } })
	const notices = (client) => client.notices.filter((frame) => frame.method === "_gc/notice" && frame.params.kind === "effort_reset")
	await until(() => notices(a).length === 1 && notices(b).length === 1)
	assert.match(notices(a)[0].params.message, /retired.*supplier default/i)
	assert.deepEqual(notices(a)[0].params.reset, reset)
	await b.conn.extMethod("_gc/attach", { sessionId, afterSeq: 0 })
	assert.equal(notices(b).length, 1, "historical reset metadata cannot become another live notice")
	assert.ok(b.updates.some((frame) => frame.update._meta?.replay && frame.update._meta["geocluster/effort-reset"]?.previousEffort === "retired"))
})

for (const method of ["resume", "load"]) test(`failed effort reconciliation rejects ${method}, leaves binding retryable, and never prompts`, async (t) => {
	const g = await startGateway(t), client = await g.client()
	const { sessionId } = await client.conn.newSession({ cwd: "", mcpServers: [] })
	const engine = g.app.broker.engine, original = engine.resumeSession.bind(engine)
	const conv = g.app.broker.convs.get(sessionId)
	conv.boundGen = -1
	let fail = true, resumes = 0, prompts = 0
	engine.prompt = async () => { prompts++; throw new Error("restoration cannot prompt") }
	engine.resumeSession = async (id) => {
		resumes++
		if (fail) throw new RequestError(-32603, "The engine could not save the repaired effort selection. Retry restoring this conversation.", { errorName: "configuration.reconciliation" })
		return original(id)
	}
	const restore = () => method === "resume"
		? client.conn.unstable_resumeSession({ sessionId, cwd: "", mcpServers: [] })
		: client.conn.loadSession({ sessionId, cwd: "", mcpServers: [] })
	await assert.rejects(restore(), (error) => error.code === -32603 && error.data?.errorName === "configuration.reconciliation")
	assert.equal(conv.boundGen, -1)
	fail = false
	await restore()
	assert.equal(resumes, 2)
	assert.equal(conv.boundGen, engine.generation)
	assert.equal(prompts, 0)
})

test("model-specific efforts are returned and pushed to attached clients with their final default", async (t) => {
	const model = "proxy/openai/gpt-6-luna"
	const other = "proxy/z-ai/glm-5.3-flash"
	const choices = ["none", "low", "medium", "high", "xhigh", "max", "default"].map((value) => ({ value, name: value, description: `Choose ${value}` }))
	const g = await startGateway(t, { knobs: { FAKE_OPENCODE_EFFORTS: { [model]: choices }, FAKE_OPENCODE_CONFIG_UPDATES: true } })
	const a = await g.client()
	const b = await g.client()
	const status = await a.conn.extMethod("_gc/status", {})
	assert.deepEqual(status.newSession.configOptions.find((o) => o.id === "effort").options, choices)
	const created = await a.conn.newSession({ cwd: "", mcpServers: [] })
	const sessionId = created.sessionId
	await b.conn.extMethod("_gc/attach", { sessionId, afterSeq: 0 })
	const set = (configId, value) => a.conn.unstable_setSessionConfigOption({ sessionId, configId, value })
	const updates = (client) => client.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "config_option_update" && !u.update._meta?.replay)
	for (const value of ["xhigh", "max"]) {
		const response = await set("effort", value)
		assert.equal(response.configOptions.find((o) => o.id === "effort").currentValue, value)
		await until(() => updates(b).at(-1)?.update.configOptions.find((o) => o.id === "effort").currentValue === value)
		assert.deepEqual(updates(a).at(-1).update.configOptions, response.configOptions)
		assert.deepEqual(updates(b).at(-1).update.configOptions, response.configOptions)
	}
	const before = updates(b).length
	const response = await set("model", other)
	await until(() => updates(b).length > before)
	assert.equal(updates(b).length, before + 1, "only the final default is pushed, not the engine's intermediate reset")
	assert.deepEqual(updates(b).at(-1).update.configOptions, response.configOptions)
	assert.equal(response.configOptions.find((o) => o.id === "effort").currentValue, "high")
	await assert.rejects(set("effort", "xhigh"), (error) => error.code === -32602)
	const attached = await b.conn.extMethod("_gc/attach", { sessionId, afterSeq: 0 })
	assert.deepEqual(attached.configOptions, response.configOptions)
	assert.deepEqual(b.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "config_option_update" && u.update._meta?.replay).at(-1).update.configOptions, response.configOptions)
	await a.conn.unstable_setSessionModel({ sessionId, modelId: model })
	await until(() => updates(b).at(-1)?.update.configOptions.find((o) => o.id === "model").currentValue === model)
	assert.deepEqual(updates(b).at(-1).update.configOptions.find((o) => o.id === "effort").options, choices)
})

test("an unsupported runtime effort retains engine default; an advertised extended override is applied", async (t) => {
	const model = "proxy/openai/gpt-6-luna"
	const choices = ["low", "max", "default"].map((value) => ({ value, name: value }))
	for (const [want, expected] of [["high", "default"], ["max", "max"]]) {
		await t.test(want, async (st) => {
			const g = await startGateway(st, { env: { RUNTIME_DEFAULT_EFFORT: want }, knobs: { FAKE_OPENCODE_EFFORTS: { [model]: choices } } })
			const client = await g.client()
			const status = await client.conn.extMethod("_gc/status", {})
			const created = await client.conn.newSession({ cwd: "", mcpServers: [] })
			assert.deepEqual(created.configOptions, status.newSession.configOptions)
			assert.equal(created.configOptions.find((o) => o.id === "effort").currentValue, expected)
		})
	}
})

test("runtime status inventories timeout boundaries from the configured engine file", async (t) => {
	const g = await startGateway(t, { seed: async (root, config) => {
		config.engineConfigDir = path.join(root, "engine-config")
		await fs.mkdir(config.engineConfigDir)
		await fs.writeFile(path.join(config.engineConfigDir, "opencode.json"), JSON.stringify({
			mcp: { servers: { geocluster: { timeout: { startup: 30_000, catalog: 30_000, execution: 543_210 } } } },
		}))
	} })
	const client = await g.client()
	const status = await client.conn.extMethod("_gc/status", {})
	assert.equal(status.timeoutPolicy.workflow.wallDeadlineMs, null)
	assert.equal(status.timeoutPolicy.inference.applicationDeadlineMs, null, "Phase 0 does not advertise inference enforcement")
	assert.equal(status.timeoutPolicy.inference.providerDeadline, "unknown")
	assert.equal(status.timeoutPolicy.shell.defaultRuntimeMs, null)
	assert.equal(status.timeoutPolicy.mcp.observationMs, 543_210, "report the configuration rather than an invented default")
	assert.equal(status.timeoutPolicy.mcp.cancellation, "observer_only_thread_may_continue")
	assert.equal(status.timeoutPolicy.machineLifecycle.turnAgeNoticeMs, g.config.maxTurnMs)
	assert.equal(status.timeoutPolicy.machineLifecycle.activityAfterNotice, "continues")
	assert.equal(status.timeoutPolicy.explicitCancel.engineGraceMs, g.config.cancelGraceMs)
	assert.equal(status.timeoutPolicy.browser.disconnect, "detach_observer")
})

test("timeout inventory reports unknown MCP policy when engine configuration cannot be read", async (t) => {
	const g = await startGateway(t, { seed: async (root, config) => { config.engineConfigDir = path.join(root, "missing-config") } })
	assert.equal(g.app.broker.status().timeoutPolicy.mcp.configuration, "unavailable")
	assert.equal(g.app.broker.status().timeoutPolicy.mcp.observationMs, null, "missing configuration must not be described as unlimited")
})


test("proc-tree: a snapshot taken while the parent lives finds and stops a detached grandchild after the parent dies", { skip: process.platform !== "linux" && "needs /proc" }, async () => {
	const { descendants, reapTree } = await import("../lib/proc-tree.js")
	const { spawn } = await import("node:child_process")
	const parent = spawn(process.execPath, ["-e", `
		const k = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" })
		k.unref(); console.log(k.pid); setInterval(() => {}, 1000)`], { stdio: ["ignore", "pipe", "ignore"] })
	const kid = Number(await new Promise((resolve) => parent.stdout.once("data", (d) => resolve(String(d).trim()))))
	const tree = await descendants(parent.pid)
	assert.ok(tree.some((p) => p.pid === kid), "detached grandchild found by ancestry")
	parent.kill("SIGKILL")
	await new Promise((resolve) => parent.once("exit", resolve))
	assert.ok(await running(kid), "a signal to the parent alone leaves it running")
	assert.equal(await reapTree(tree, 200), 1)
	await untilAsync(async () => !(await running(kid)))
	assert.equal(await reapTree(tree, 200), 0, "nothing left; a reused pid would not match the start time")
})

test("gateway end-to-end: one engine, many conversations", async (t) => {
	const g = await startGateway(t)
	const { app, config, port, secret, activityCalls } = g

	await t.test("boot: readyz api 3 (engine ready, tools connected, shared MCP); env whitelists; build identity", async () => {
		const ready = await (await fetch(`http://127.0.0.1:${port}/readyz`)).json()
		assert.equal(ready.ready, true)
		assert.equal(ready.api, 3)
		assert.equal(ready.components.engine.state, "ready")
		assert.equal(ready.components.engine.tools, "connected")
		assert.equal(ready.components.engine.generation, 1)
		assert.equal(ready.components.mcp.state, "ready")
		assert.equal(ready.components.mcp.port, config.mcpPort)
		const keys = g.engineMeta().envKeys
		for (const wanted of ["PATH", "LANG", "HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_MODELS_PATH", "OPENCODE_PRINT_LOGS", "GEOCLUSTER_MCP_URL", "GEOCLUSTER_TOOL_HOME", "IDE_LLM_TOKEN", "LLM_PROXY_URL"]) {
			assert.ok(keys.includes(wanted), `missing ${wanted} in ${keys}`)
		}
		for (const s of ["IDE_PROXY_KEY", "R2_SECRET_ACCESS_KEY", "IDE_DATASET_TOKEN", "RUNTIME_ACTIVITY_TOKEN", "RUNTIME_ACTIVITY_URL", "GEOCLUSTER_RUN_DIR", "NODE_OPTIONS"]) {
			assert.ok(!keys.includes(s), `${s} leaked into the engine env`)
		}
		await app.build.ready
		assert.equal(ready.build.engine, "opencode")
		const live = await (await fetch(`http://127.0.0.1:${port}/livez`)).json()
		assert.equal(live.bootId, ready.build.bootId)
		const c = await g.client()
		const init = await c.conn.initialize({ protocolVersion: 1, clientCapabilities: {} })
		assert.equal(init.agentCapabilities._meta.api, 3)
		assert.ok(init.agentCapabilities._meta.extensions.includes("_gc/child_update"))
		assert.deepEqual(init.agentCapabilities._meta.features, ["replaySnapshot", "childUpdates", "submissionIds", "archive", "replayOrdering"])
		assert.equal(init.agentCapabilities.mcpCapabilities, undefined, "the engine's MCP capabilities are not the gateway's")
		assert.equal(init.agentCapabilities.promptCapabilities.embeddedContext, true)
		assert.equal(init.agentInfo.name, "OpenCode")
	})

	await t.test("gate header enforced except for health", async () => {
		assert.equal((await fetch(`http://127.0.0.1:${port}/files/list`)).status, 403)
		assert.equal((await fetch(`http://127.0.0.1:${port}/livez`)).status, 200)
		await assert.rejects(wsClient(port, "").opened, (e) => e.status === 403)
	})

	let sessionId
	const a = await g.client({ permission: () => new Promise(() => {}) })
	await t.test("session/new: engine id, agent set with set_mode, configOptions + models, run folder; attach before any event", async () => {
		const created = await a.conn.newSession({ cwd: "/ignored", mcpServers: [{ name: "x", type: "http", url: "http://evil", headers: [] }], _meta: { agentMode: "standard" } })
		sessionId = created.sessionId
		assert.match(sessionId, /^ses_[A-Za-z0-9]+$/)
		assert.equal(created._meta.runDir, `runs/${sessionId}`)
		assert.equal(created._meta.agentMode, "standard")
		assert.equal(created.modes, null)
		assert.deepEqual(created.configOptions.map((o) => o.id), ["model", "effort"], "mode is not the browser's to change")
		assert.equal(created.models.currentModelId, "proxy/openai/gpt-6-luna")
		assert.ok(created.models.availableModels.some((m) => m.modelId === "proxy/z-ai/glm-5.3-flash"))
		assert.ok((await fs.stat(path.join(config.workspaceDir, "runs", sessionId))).isDirectory())
		assert.equal(g.app.broker.index.get(sessionId).agentMode, "standard")
		const attached = await a.conn.extMethod("_gc/attach", { sessionId, afterSeq: 0 })
		assert.equal(attached.lastSeq, 0, "the engine's available_commands_update (init/review) is dropped, not logged")
		assert.equal(attached.resident, true)
		assert.equal(attached.agentMode, "standard")
		assert.equal(attached.archived, false)
	})

	await t.test("unknown agentMode → -32602 before the engine is asked", async () => {
		await assert.rejects(a.conn.newSession({ cwd: "/x", mcpServers: [], _meta: { agentMode: "orchestrator" } }), (e) => e.code === -32602)
	})

	await t.test("a turn: gateway echo with submissionId, engine updates with seq, usage_update kept, _gc/turn_end, activity", async () => {
		const turn = await a.conn.prompt(say(sessionId, "echo hi there", { submissionId: "sub-1" }))
		assert.equal(turn.stopReason, "end_turn")
		assert.equal(turn._meta.submissionId, "sub-1")
		await until(() => a.turnEnds(sessionId).length === 1)
		const kinds = a.updates.filter((u) => u.sessionId === sessionId).map((u) => u.update.sessionUpdate)
		assert.deepEqual(kinds, ["user_message_chunk", "agent_message_chunk", "usage_update"])
		const [echo, chunk, usage] = a.updates.filter((u) => u.sessionId === sessionId).map((u) => u.update)
		assert.equal(echo._meta.submissionId, "sub-1")
		assert.deepEqual([echo._meta.seq, chunk._meta.seq, usage._meta.seq], [1, 2, 3])
		assert.equal(chunk.content.text, "hi there")
		assert.match(chunk.messageId, /^msg_/, "messageId survives (SDK 0.13.1 would strip it without the shim)")
		assert.equal(typeof usage.used, "number")
		const end = a.turnEnds(sessionId)[0]
		assert.equal(end.seq, 4)
		assert.equal(end._meta.submissionId, "sub-1")
		assert.ok(activityCalls.some((c) => c.state === "prompt_running"))
		assert.equal(activityCalls[activityCalls.length - 1].state, "idle")
		const entry = g.app.broker.index.get(sessionId)
		assert.equal(entry.title, "echo hi there")
		assert.equal(entry.contextSize, 200000)
	})

	await t.test("API-07: the same submissionId runs once; a stale cancel is ignored", async () => {
		const again = await a.conn.prompt(say(sessionId, "echo hi there", { submissionId: "sub-1" }))
		assert.equal(again._meta.duplicate, true)
		assert.equal(again.stopReason, "end_turn")
		assert.equal(a.turnEnds(sessionId).length, 1, "no second turn")
		const slow = a.conn.prompt(say(sessionId, "slow 400", { submissionId: "sub-2" }))
		await until(() => g.app.broker.status().sessions.some((s) => s.sessionId === sessionId && s.turn === "running"))
		await a.conn.cancel({ sessionId, _meta: { submissionId: "sub-1" } })
		assert.equal((await slow).stopReason, "end_turn", "a cancel naming an older submission does not stop this turn")
	})

	await t.test("specialists: _gc/child_update frames with depth, title and the spawning tool call; replayed in order", async () => {
		const before = a.notices.length
		const turn = await a.conn.prompt(say(sessionId, "delegate"))
		assert.equal(turn.stopReason, "end_turn")
		const childFrames = a.notices.slice(before).filter((n) => n.method === "_gc/child_update").map((n) => n.params)
		const statuses = childFrames.filter((f) => f.type === "status").map((f) => `${f.child.depth}:${f.status}`)
		assert.deepEqual(statuses, ["1:created", "1:running", "2:created", "2:running", "2:completed", "1:completed"])
		const s1 = childFrames.find((f) => f.child.depth === 1).child
		const s2 = childFrames.find((f) => f.child.depth === 2).child
		assert.equal(s1.parentSessionId, sessionId)
		assert.equal(s1.title, "task for orchestrator")
		assert.equal(s2.parentSessionId, s1.sessionId)
		// the root's subagent card and the orchestrator's subagent call spawned them
		const rootCall = a.updates.find((u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call" && u.update.title === "subagent").update.toolCallId
		assert.equal(s1.toolCallId, rootCall)
		assert.match(s2.toolCallId, new RegExp(`^${s1.sessionId}:`))
		assert.ok(childFrames.every((f) => typeof f.seq === "number" && f.sessionId === sessionId))
		// a fresh socket replays updates and child frames interleaved, in seq order
		const b = await g.client()
		const attached = await b.conn.extMethod("_gc/attach", { sessionId, afterSeq: 0 })
		await until(() => b.stream(sessionId).length >= attached.lastSeq)
		const seqs = b.stream(sessionId).map((e) => e.seq)
		assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), "replay is in seq order")
		assert.ok(b.notices.some((n) => n.method === "_gc/child_update" && n.params.replay === true && n.params.child.depth === 2))
		b.close()
	})

	await t.test("permissions: a specialist asks on the root id; every attached socket asked; first answer wins; allow_always kept by the gateway", async () => {
		const b = await g.client({ permission: () => new Promise(() => {}) })
		await b.conn.extMethod("_gc/attach", { sessionId, afterSeq: 1e9 })
		let release
		const gate = new Promise((r) => (release = r))
		const c = await g.client({
			permission: async () => {
				await gate
				return { outcome: { outcome: "selected", optionId: "always" } }
			},
		})
		await c.conn.extMethod("_gc/attach", { sessionId, afterSeq: 1e9 })
		const turn = c.conn.prompt(say(sessionId, "ask"))
		await until(() => b.permissions.length === 1 && c.permissions.length === 1 && a.permissions.length >= 1)
		assert.equal(b.permissions[0]._meta.reqId, c.permissions[0]._meta.reqId)
		assert.match(b.permissions[0]._meta.childSessionId, /^ses_/)
		assert.equal(b.permissions[0]._meta["gc/rpcId"], undefined, "the engine's rpc id stays in the gateway")
		const status = g.app.broker.status().sessions.find((s) => s.sessionId === sessionId)
		assert.equal(status.pendingPermissions.length, 1)
		release()
		assert.equal((await turn).stopReason, "end_turn")
		assert.match(c.text(sessionId), /done/)
		await until(() => b.notices.some((n) => n.method === "_gc/permission_resolved"))
		assert.ok(g.app.broker.prefs.isAllowed({ rawInput: { command: "rm -rf other" } }), "allow_always remembered by the gateway")
		const log = await g.readLog(sessionId)
		const response = log.filter((e) => e.kind === "permission_response").pop()
		assert.equal(response.outcome.optionId, "always", "the browser's answer is logged as given")
		// the next request for the same command is answered by policy, nobody is asked
		const asked = b.permissions.length
		assert.equal((await c.conn.prompt(say(sessionId, "ask"))).stopReason, "end_turn")
		assert.equal(b.permissions.length, asked)
		b.close()
		c.close()
	})

	await t.test("busy (-32001) only for the same conversation; maxRunning (-32005)", async () => {
		const other = (await a.conn.newSession({ cwd: "", mcpServers: [] })).sessionId
		const hang = a.conn.prompt(say(sessionId, "hang"))
		await until(() => g.app.broker.status().sessions.some((s) => s.sessionId === sessionId && s.turn === "running"))
		await assert.rejects(a.conn.prompt(say(sessionId, "echo no")), (e) => e.code === -32001)
		assert.equal((await a.conn.prompt(say(other, "echo yes"))).stopReason, "end_turn")
		await a.conn.cancel({ sessionId })
		const done = await hang
		assert.equal(done.stopReason, "cancelled")
		assert.equal(done._meta.processesStopped, true)
	})

	await t.test("cancel ends the turn only after the conversation's tool processes stopped (API-09)", { skip: process.platform !== "linux" && "needs /proc" }, async () => {
		const turn = a.conn.prompt(say(sessionId, "kidhang"))
		await until(() => /kid \d+/.test(a.text(sessionId)))
		const kid = Number([...a.text(sessionId).matchAll(/kid (\d+)/g)].pop()[1])
		assert.ok(await running(kid))
		await a.conn.cancel({ sessionId })
		const done = await turn
		assert.equal(done.stopReason, "cancelled")
		assert.equal(await running(kid), false, "the kid the fake left behind was stopped before turn_end")
	})

	await t.test("prompt blocks: empty and unknown types refused; resource_link only inside the workspace", async () => {
		await assert.rejects(a.conn.prompt({ sessionId, prompt: [] }), (e) => e.code === -32602)
		await assert.rejects(a.conn.prompt({ sessionId, prompt: [{ type: "text", text: "   " }] }), (e) => e.code === -32602)
		await assert.rejects(a.conn.prompt({ sessionId, prompt: [{ type: "text", text: "echo x" }, { type: "resource_link", uri: "file:///etc/hostname", name: "h" }] }), (e) => e.code === -32602)
		await fs.symlink("/etc/hostname", path.join(config.workspaceDir, "escape-link"))
		await assert.rejects(a.conn.prompt({ sessionId, prompt: [{ type: "text", text: "echo x" }, { type: "resource_link", uri: `file://${config.workspaceDir}/escape-link`, name: "h" }] }), (e) => e.code === -32602)
		const ok = await a.conn.prompt({ sessionId, prompt: [{ type: "text", text: "echo linked" }, { type: "resource_link", uri: `file://${config.workspaceDir}/hello.txt`, name: "hello" }] })
		assert.equal(ok.stopReason, "end_turn")
	})

	await t.test("model and effort per conversation; set_mode is gone (-32601)", async () => {
		await a.conn.unstable_setSessionModel({ sessionId, modelId: "proxy/z-ai/glm-5.3-flash" })
		await a.conn.prompt(say(sessionId, "model"))
		assert.match(a.text(sessionId), /glm-5\.3-flash/)
		const set = await a.conn.unstable_setSessionConfigOption({ sessionId, configId: "effort", value: "high" })
		assert.equal(set.configOptions.find((o) => o.id === "effort").currentValue, "high")
		await assert.rejects(a.conn.unstable_setSessionConfigOption({ sessionId, configId: "mode", value: "geology" }), (e) => e.code === -32602)
		await assert.rejects(a.conn.setSessionMode({ sessionId, modeId: "geology" }), (e) => e.code === -32601)
		await assert.rejects(a.conn.unstable_setSessionModel({ sessionId, modelId: "proxy/nope" }), (e) => e.code === -32602)
		assert.equal(g.app.broker.index.get(sessionId).modelId, "proxy/z-ai/glm-5.3-flash")
	})

	await t.test("provider errors end the turn cancelled/error with an X-6 Error line; retry notices are forwarded", async () => {
		const before = a.updates.length
		const r500 = await a.conn.prompt(say(sessionId, "error 500"))
		assert.equal(r500.stopReason, "cancelled")
		assert.equal(r500._meta.reason, "error")
		assert.equal(r500._meta.errorName, "provider.internal")
		const fresh = a.updates.slice(before).map((u) => u.update)
		assert.ok(fresh.some((u) => u.sessionUpdate === "session_info_update" && u._meta?.["opencode/retry"]?.attempt === 2))
		const line = fresh.filter((u) => u.sessionUpdate === "agent_message_chunk").pop()
		assert.match(line.content.text, /^Error: the model provider failed for the standard agent after 3 retries \(upstream exploded\)\. Next step:/)
		assert.equal(line._meta.gateway, "error")
		const auth = await a.conn.prompt(say(sessionId, "error auth"))
		assert.equal(auth._meta.errorName, "provider.auth")
		const authLine = a.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk").pop().update
		assert.match(authLine.content.text, /Standard assistant.*could not be authenticated/)
		assert.match(authLine.content.text, /restore model access.*send your message again/)
		assert.doesNotMatch(authLine.content.text, /reload|authentication required|standard agent/i, "browser reload cannot repair server-side provider credentials")
		assert.equal((await a.conn.prompt(say(sessionId, "echo still fine"))).stopReason, "end_turn")
	})

	await t.test("engine crash mid-turn: server_restart for that turn, engine restarts, the conversation resumes lazily", async () => {
		const generation = g.app.broker.engine.generation
		const turn = await a.conn.prompt(say(sessionId, "crash"))
		assert.equal(turn.stopReason, "cancelled")
		assert.equal(turn._meta.reason, "server_restart")
		assert.match(a.text(sessionId), /Error: the agent engine stopped during this turn/)
		await untilAsync(async () => g.app.broker.engine.state === "ready" && g.app.broker.engine.generation > generation, 10000)
		await a.conn.prompt(say(sessionId, "origin"))
		assert.match(a.text(sessionId), /resume$/, "re-bound with session/resume, never load")
	})

	await t.test("the private server dies: detected, engine restarted, turn ends server_restart", async () => {
		const generation = g.app.broker.engine.generation
		const turn = await a.conn.prompt(say(sessionId, "serverdie"))
		assert.equal(turn.stopReason, "cancelled")
		assert.equal(turn._meta.reason, "server_restart")
		await untilAsync(async () => g.app.broker.engine.state === "ready" && g.app.broker.engine.generation > generation, 10000)
		assert.equal((await a.conn.prompt(say(sessionId, "echo back"))).stopReason, "end_turn")
	})

	await t.test("list: newest first, only prompted conversations, api-3 _meta", async () => {
		const listed = await a.conn.unstable_listSessions({})
		const mine = listed.sessions.find((s) => s.sessionId === sessionId)
		assert.equal(listed.sessions[0].sessionId, sessionId)
		assert.equal(mine._meta.archived, false)
		assert.equal(mine._meta.agentMode, "standard")
		assert.equal(mine._meta.runDir, `runs/${sessionId}`)
		assert.ok(!Object.hasOwn(mine._meta, "totalCost"), "Public conversation metadata conceals supplier amounts")
	})
})

test("report-analysis: RE-4 citation check sends one correction inside the turn; the corrected answer is exported", async (t) => {
	const g = await startGateway(t)
	const report = path.join(g.workspace, "report", "text")
	await fs.mkdir(report, { recursive: true })
	await fs.writeFile(path.join(report, "01_summary.md"), "summary")
	const a = await g.client()
	const { sessionId } = await a.conn.newSession({ cwd: "", mcpServers: [], _meta: { agentMode: "report-analysis" } })
	const script =
		"read report/text/01_summary.md report/text/99_invented.md | Grade 1.2 g/t [source: text/01_summary.md | p:1] and 5 holes [source: text/07_exploration.md | p:3]" +
		" || Grade 1.2 g/t [source: text/01_summary.md | p:1]; holes [not found in report]"
	const turn = await a.conn.prompt(say(sessionId, script))
	assert.equal(turn.stopReason, "end_turn")
	const notice = a.notices.find((n) => n.method === "_gc/notice" && n.params.kind === "citation_check")
	assert.deepEqual(notice.params.flagged, ["text/07_exploration.md"])
	assert.equal(a.turnEnds(sessionId).length, 1, "the correction happened inside the same browser turn")
	assert.match(turn._meta.report, new RegExp(`^runs/${sessionId}/_reports/REPORT_\\d{8}_\\d{6}\\.md$`))
	const saved = await fs.readFile(path.join(g.workspace, turn._meta.report), "utf8")
	assert.equal(saved, "Grade 1.2 g/t [source: text/01_summary.md | p:1]; holes [not found in report]")
	const log = await g.readLog(sessionId)
	assert.ok(log.some((e) => e.kind === "gateway" && e.type === "citation_check"))
	assert.equal(log.filter((e) => e.kind === "update" && e.update.sessionUpdate === "user_message_chunk").length, 1, "the correction prompt is not echoed as a user message")
})
