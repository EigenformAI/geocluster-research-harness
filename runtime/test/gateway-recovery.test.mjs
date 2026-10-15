/**
 * Gateway recovery and edge cases (api 3, Step 4.3), end to end through the WebSocket: one `opencode acp` (the
 * scripted fake, test/fake-opencode.mjs) and one shared MCP (test/fake-mcp.mjs) behind the broker.
 *
 * One top-level test per area: archive + migration, gateway restart, API-06 replay ordering, early engine frames,
 * the cancel watchdog, cancel with a pending permission, specialists under cancel, engine/MCP recovery, capacity,
 * shutdown, report export. The happy paths live in gateway.test.mjs; nothing here repeats them.
 *
 * Where the fake has no knob for an engine behaviour, the frame is injected through the supervisor's own event
 * (`engine.emit("update" | "child", …)`, exactly what engine-stream.js delivers) and the test says so. A gateway bug a
 * test exposed was kept as a `todo` until fixed (Step 4.3: all fixed).
 *
 *   node --test test/gateway-recovery.test.mjs
 */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { after, test } from "node:test"
import { FAKE_MCP, running, say, startGateway, tmpdir, until, untilAsync } from "./gateway-harness.mjs"

// ---- helpers -------------------------------------------------------------------------------------------------

/** Volumes shared by two gateways (a restart) belong to the test, not to startGateway: removed after everything. */
const roots = []
after(async () => {
	for (const root of roots) await fs.rm(root, { recursive: true, force: true })
})
async function newRoot() {
	const root = await tmpdir("gw-recovery-")
	roots.push(root)
	return root
}

const exists = (p) => fs.access(p).then(() => true, () => false)
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"))
const rpc = (code) => (error) => error?.code === code
const engineStoreFile = (config) => path.join(config.engineStateDir, "data", "fake-opencode", "sessions.json")
/** The fake engine's database: id → session. What the engine knows, whatever the gateway thinks. */
const engineStore = (config) => readJson(engineStoreFile(config)).catch(() => ({}))
const logDir = (config, id) => path.join(config.gatewayStateDir, "sessions", id)
/** The log kinds a socket sees (with their seq); permission, model and gateway events are logged only. */
const FANNED = new Set(["update", "child", "turn_end"])
const fannedSeqs = (log) => log.filter((e) => FANNED.has(e.kind)).map((e) => e.seq)
const isReplay = (e) => (e.kind === "update" ? e.update?._meta?.replay === true : e.params?.replay === true)
const lastAnswer = (c, id) =>
	c.updates.filter((u) => u.sessionId === id && u.update.sessionUpdate === "agent_message_chunk" && !u.update._meta?.replay).at(-1)?.update.content.text
const noticesOf = (c, method) => c.notices.filter((n) => n.method === method).map((n) => n.params)
const turnOf = (g, id) => g.app.broker.status().sessions.find((s) => s.sessionId === id)?.turn ?? "idle"
const boundOf = (g, id) => g.app.broker.status().sessions.find((s) => s.sessionId === id)?.bound === true
const newChat = async (c, agentMode = "geology") => (await c.conn.newSession({ cwd: "/x", mcpServers: [], _meta: { agentMode } })).sessionId

/** `promise`, or a failure naming what never settled (a stuck gateway must fail the test, not hang the suite). */
async function within(promise, ms, what) {
	let timer
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${typeof what === "function" ? what() : what}: not settled after ${ms} ms`)), ms)
	})
	try {
		return await Promise.race([promise, timeout])
	} finally {
		clearTimeout(timer)
	}
}

/** Strictly increasing by exactly 1 (no gap, no duplicate, no reordering). */
function assertContiguous(list, label) {
	const at = list.findIndex((seq, i) => i > 0 && seq !== list[i - 1] + 1)
	if (at > 0) assert.fail(`${label}: seq ${list[at]} after ${list[at - 1]} (around: ${list.slice(Math.max(0, at - 5), at + 5).join(",")})`)
}

/**
 * Record every call the broker forwards to the engine (by session id). Every broker → engine request goes through
 * these supervisor methods (only the supervisor's own warm-up and health probe don't), so "nothing reached the
 * engine" can be asserted exactly.
 */
function spyEngine(engine) {
	const calls = []
	for (const method of ["newSession", "setMode", "setConfigOption", "resumeSession", "closeSession", "deleteSession", "listSessions", "prompt", "cancel"]) {
		const original = engine[method].bind(engine)
		engine[method] = (...args) => {
			calls.push({ method, sessionId: typeof args[0] === "string" ? args[0] : args[0]?.sessionId ?? null })
			return original(...args)
		}
	}
	return calls
}

// ---- 1. archive and migration ----------------------------------------------------------------------------------

const L1 = "1789500000001" // api 1: imported from the shared Cline dir (runDir null)
const P1 = "1790100000001" // api 2, prompted, with a gateway log
const P2 = "1790100000002" // api 2, prompted, empty log (title only)
const U1 = "1790100000003" // api 2, never prompted, empty run folder
const U2 = "1790100000004" // api 2, never prompted, a file in its run folder
const ORPHAN = "1789400000009" // an api-1 log (and empty run folder) nobody indexed
const T0 = 1790100000000

const historyItem = (id, ts, task, n, extra = {}) => ({
	id,
	ulid: `01J${id}`,
	ts,
	task,
	tokensIn: 1000 * n,
	tokensOut: 100 * n,
	cacheWrites: 5,
	cacheReads: 7,
	totalCost: 0.01 * n,
	size: 4096 * n,
	modelId: "anthropic/claude-sonnet-4.5",
	cwdOnTaskInitialization: "/workspace/p1",
	...extra,
})

async function writeGatewayLog(config, id, events) {
	const dir = logDir(config, id)
	await fs.mkdir(dir, { recursive: true })
	if (events.length) await fs.writeFile(path.join(dir, "events.ndjson"), events.map((e) => JSON.stringify(e)).join("\n") + "\n")
	await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ createdAt: T0, sessionId: id, lastSeq: events.length, firstSeq: 1, truncated: false }))
}

/** The dev server's api-2 state (parity inventory §4), in miniature. Returns the exact bytes of index.json. */
async function seedApi2(config) {
	const ev = (seq, kind, data) => ({ seq, ts: T0 + seq * 1000, kind, ...data })
	const text = (sessionUpdate, t) => ({ sessionUpdate, content: { type: "text", text: t } })
	const conversations = (id) => path.join(config.conversationsDir, id)
	await fs.mkdir(path.join(config.clineDataDir, "state"), { recursive: true })
	await fs.writeFile(
		path.join(config.clineDataDir, "state", "taskHistory.json"),
		JSON.stringify([historyItem(L1, 1789500100000, "Summarise the drill database", 1), historyItem("1789500000100", 1789500000100, "child", 9, { specialist: "dataops" })]),
	)
	for (const [id, item] of [
		[P1, historyItem(P1, 1790100100000, "Evaluate QA/QC", 4)],
		[P2, historyItem(P2, 1790100200000, "Resource check", 5, { modelId: "z-ai/glm-4.7-flash" })],
	]) {
		await fs.mkdir(path.join(conversations(id), "state"), { recursive: true })
		await fs.writeFile(path.join(conversations(id), "state", "taskHistory.json"), JSON.stringify([item]))
	}
	for (const id of [U1, U2]) await fs.mkdir(path.join(conversations(id), "settings"), { recursive: true })

	await writeGatewayLog(config, L1, [
		ev(1, "update", { sessionId: L1, update: text("user_message_chunk", "Summarise the drill database") }),
		ev(2, "update", { sessionId: L1, update: text("agent_message_chunk", "42 holes, 3,100 m.") }),
		ev(3, "turn_end", { sessionId: L1, stopReason: "end_turn", _meta: {} }),
	])
	const toolCall = { toolCallId: "t1", title: "Read file", kind: "read", status: "pending", rawInput: { path: "report/text/01.md" } }
	await writeGatewayLog(config, P1, [
		ev(1, "update", { sessionId: P1, update: text("user_message_chunk", "Evaluate QA/QC") }),
		ev(2, "mode", { sessionId: P1, modeId: "act" }),
		ev(3, "update", { sessionId: P1, update: { sessionUpdate: "current_mode_update", currentModeId: "act" } }),
		ev(4, "update", { sessionId: P1, update: { sessionUpdate: "tool_call", ...toolCall } }),
		ev(5, "permission_request", { sessionId: P1, reqId: "r1", toolCall, options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow" }] }),
		ev(6, "permission_response", { sessionId: P1, reqId: "r1", outcome: { outcome: "selected", optionId: "allow_once" }, by: "user" }),
		ev(7, "update", { sessionId: P1, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } }),
		ev(8, "update", { sessionId: P1, update: text("agent_message_chunk", "QA/QC passes: 2 of 120 standards out of tolerance.") }),
		ev(9, "turn_end", { sessionId: P1, stopReason: "end_turn", _meta: null }), // api 1/2 wrote `response._meta ?? null`
	])
	for (const id of [P2, U1, U2, ORPHAN]) await writeGatewayLog(config, id, [])

	await fs.mkdir(path.join(config.workspaceDir, "runs", P1, "results"), { recursive: true })
	await fs.writeFile(path.join(config.workspaceDir, "runs", P1, "results", "summary.csv"), "a,b\n1,2\n")
	for (const id of [P2, U1, ORPHAN]) await fs.mkdir(path.join(config.workspaceDir, "runs", id), { recursive: true })
	await fs.mkdir(path.join(config.workspaceDir, "runs", U2), { recursive: true })
	await fs.writeFile(path.join(config.workspaceDir, "runs", U2, "notes.txt"), "keep me")

	const api2 = (id, title, ts, agentMode) => ({
		sessionId: id,
		dataDir: conversations(id),
		runDir: `runs/${id}`,
		legacy: false,
		agentMode,
		title,
		createdAt: ts,
		updatedAt: ts + 5000,
	})
	const body = JSON.stringify({
		legacyImported: true,
		sessions: [
			{ sessionId: L1, dataDir: config.clineDataDir, runDir: null, legacy: true, title: "Summarise the drill database", createdAt: 1789500100000, updatedAt: 1789500100000 },
			api2(P1, "Evaluate QA/QC", 1790100100000, "report-analysis"),
			api2(P2, "Resource check", 1790100200000, "geology"),
			api2(U1, null, 1790100300000, "geology"),
			api2(U2, null, 1790100400000, "geology"),
		],
	})
	await fs.mkdir(config.gatewayStateDir, { recursive: true })
	await fs.writeFile(path.join(config.gatewayStateDir, "index.json"), body)
	return body
}

test("archive and migration: an api-2 volume boots as api 3; archived conversations replay from the gateway log and never reach the engine", { timeout: 60_000 }, async (t) => {
	let original
	const g = await startGateway(t, { seed: async (_root, config) => (original = await seedApi2(config)) })
	const { config } = g
	const calls = spyEngine(g.app.broker.engine)
	const a = await g.client()

	await t.test("index: version 3, api-1/api-2 entries archived with a stats snapshot, index.v2.json is the api-2 file byte for byte", async () => {
		const disk = await readJson(path.join(config.gatewayStateDir, "index.json"))
		assert.equal(disk.version, 3)
		assert.deepEqual(disk.sessions.map((s) => s.sessionId).sort(), [L1, P1, P2].sort())
		for (const entry of disk.sessions) assert.equal(entry.archived, true, entry.sessionId)
		const byId = Object.fromEntries(disk.sessions.map((s) => [s.sessionId, s]))
		assert.equal(byId[L1].legacy, true)
		assert.equal(byId[L1].runDir, null)
		assert.equal(byId[P1].legacy, false)
		assert.equal(byId[P1].runDir, `runs/${P1}`)
		assert.deepEqual(byId[P1].stats, { tokensIn: 4000, tokensOut: 400, totalCost: 0.04, modelId: "anthropic/claude-sonnet-4.5", size: 16384 })
		assert.equal(byId[P2].stats.modelId, "z-ai/glm-4.7-flash")
		assert.equal(await fs.readFile(path.join(config.gatewayStateDir, "index.v2.json"), "utf8"), original)
	})

	await t.test("boot prune: never-prompted entries leave nothing but outputs; unindexed logs and empty run folders go; prompted ones keep everything", async () => {
		for (const id of [U1, U2, ORPHAN]) assert.equal(await exists(logDir(config, id)), false, `log of ${id}`)
		assert.equal(await exists(path.join(config.workspaceDir, "runs", U1)), false, "empty run folder rmdir'd")
		assert.equal(await exists(path.join(config.workspaceDir, "runs", ORPHAN)), false, "unindexed empty run folder rmdir'd")
		assert.equal(await fs.readFile(path.join(config.workspaceDir, "runs", U2, "notes.txt"), "utf8"), "keep me", "a run folder with a file is kept")
		for (const id of [U1, U2]) assert.equal(await exists(path.join(config.conversationsDir, id)), false, `gateway-owned Cline data dir of ${id}`)
		// the rollback path: prompted conversations keep their Cline data, logs and outputs
		assert.ok(await exists(path.join(config.conversationsDir, P1, "state", "taskHistory.json")))
		assert.ok(await exists(path.join(logDir(config, P1), "events.ndjson")))
		assert.ok(await exists(path.join(config.workspaceDir, "runs", P1, "results", "summary.csv")))
		assert.ok(await exists(path.join(config.workspaceDir, "runs", P2)), "an empty run folder of a prompted conversation is kept")
	})

	await t.test("session/list: archived entries with _meta.archived, legacy and the snapshot stats; newest first; never-prompted ones absent", async () => {
		const listed = await a.conn.unstable_listSessions({})
		assert.deepEqual(listed.sessions.map((s) => s.sessionId), [P2, P1, L1])
		const p1 = listed.sessions.find((s) => s.sessionId === P1)._meta
		assert.equal(p1.archived, true)
		assert.equal(p1.legacy, false)
		assert.equal(p1.agentMode, "report-analysis")
		assert.equal(p1.runDir, `runs/${P1}`)
		assert.deepEqual([p1.tokensIn, p1.tokensOut, p1.modelId, p1.size], [4000, 400, "anthropic/claude-sonnet-4.5", 16384])
		assert.ok(listed.sessions.every((session) => !Object.hasOwn(session._meta, "totalCost")), "Archived lists conceal supplier amounts")
		assert.equal(p1.contextUsed, null)
		const l1 = listed.sessions.find((s) => s.sessionId === L1)._meta
		assert.deepEqual([l1.archived, l1.legacy, l1.runDir], [true, true, null])
	})

	await t.test("session/load replays the archived log (replay:true, logged-only kinds skipped, current_mode_update kept); _gc/attach too, incrementally", async () => {
		const loaded = await a.conn.loadSession({ sessionId: P1, cwd: "/x", mcpServers: [] })
		assert.equal(loaded._meta.archived, true)
		assert.equal(loaded._meta.lastSeq, 9)
		assert.equal(loaded._meta.runDir, `runs/${P1}`)
		const replay = a.stream(P1)
		assert.deepEqual(replay.map((e) => e.seq), [1, 3, 4, 7, 8, 9], "permission and mode events are logged, not replayed")
		assert.ok(replay.every(isReplay), "every replayed frame says replay:true")
		assert.equal(replay[1].update.sessionUpdate, "current_mode_update", "archived logs may replay current_mode_update (C13)")
		assert.equal(replay.at(-1).kind, "_gc/turn_end")
		assert.equal(replay.at(-1).params.stopReason, "end_turn")
		assert.deepEqual(Object.keys(replay.at(-1).params).sort(), ["_meta", "replay", "seq", "sessionId", "stopReason"], "a replayed turn_end has the live frame's fields plus replay (no log record fields)")
		assert.deepEqual(replay.at(-1).params._meta, {}, "an archived `_meta: null` replays as {} like every live turn_end")

		const b = await g.client()
		const attached = await b.conn.extMethod("_gc/attach", { sessionId: P1, afterSeq: 4 })
		assert.equal(attached.archived, true)
		assert.equal(attached.resident, false, "an archived conversation is never bound to the engine")
		assert.equal(attached.turn, "idle")
		assert.equal(attached.lastSeq, 9)
		assert.deepEqual(b.stream(P1).map((e) => e.seq), [7, 8, 9])
		const legacy = await b.conn.extMethod("_gc/attach", { sessionId: L1, afterSeq: 0 })
		assert.equal(legacy.runDir, null)
		assert.deepEqual(b.stream(L1).map((e) => e.seq), [1, 2, 3])
		assert.match(b.stream(L1)[1].update.content.text, /42 holes/)
		const empty = await b.conn.extMethod("_gc/attach", { sessionId: P2, afterSeq: 0 })
		assert.equal(empty.lastSeq, 0, "an empty log replays nothing")
		assert.equal(b.stream(P2).length, 0)
		const resumed = await b.conn.unstable_resumeSession({ sessionId: P1, cwd: "/x", mcpServers: [] })
		assert.equal(resumed._meta.archived, true)
	})

	await t.test("prompt, set_model and set_config_option on an archived conversation → -32006; cancel is a no-op", async () => {
		await assert.rejects(a.conn.prompt(say(P1, "echo can I continue?")), (e) => e.code === -32006 && e.data?.sessionId === P1)
		await assert.rejects(a.conn.prompt(say(L1, "echo and this one?", { submissionId: "s-arch" })), rpc(-32006))
		await assert.rejects(a.conn.unstable_setSessionModel({ sessionId: P1, modelId: "proxy/z-ai/glm-5.3-flash" }), rpc(-32006))
		await assert.rejects(a.conn.unstable_setSessionConfigOption({ sessionId: P2, configId: "effort", value: "high" }), rpc(-32006))
		await a.conn.cancel({ sessionId: P1 })
		const log = await g.readLog(P1)
		assert.equal(log.length, 9, "nothing was appended to the archived log")
	})

	await t.test("nothing reached the engine for a 13-digit id; a new conversation on the same volume works and lists as not archived", async () => {
		const id = await newChat(a)
		assert.equal((await a.conn.prompt(say(id, "echo fresh start"))).stopReason, "end_turn")
		const legacyIds = /^\d{13}$/
		assert.deepEqual(calls.filter((c) => legacyIds.test(String(c.sessionId))), [], "a Cline id was sent to the engine")
		assert.ok(calls.some((c) => c.method === "prompt" && c.sessionId === id), "the spy sees the calls that do happen")
		const store = await engineStore(config)
		assert.ok(Object.keys(store).length > 0)
		assert.deepEqual(Object.keys(store).filter((k) => !/^ses_/.test(k)), [], "the engine's database holds engine ids only")
		const listed = await a.conn.unstable_listSessions({})
		assert.equal(listed.sessions[0].sessionId, id)
		assert.equal(listed.sessions[0]._meta.archived, false)
		assert.ok(!(await readJson(path.join(config.gatewayStateDir, "index.json"))).sessions.some((s) => s.lost), "no archived entry was marked lost")
	})
})

// ---- 2. gateway restart on the same volume ---------------------------------------------------------------------

test("gateway restart on the same volume: lazy resume, seq continues, submissions and model survive, never-prompted ones go from the engine too", { timeout: 60_000 }, async (t) => {
	const root = await newRoot()
	const gA = await startGateway(t, { root })
	const a = await gA.client()
	const X = await newChat(a, "standard")
	await a.conn.unstable_setSessionModel({ sessionId: X, modelId: "proxy/z-ai/glm-5.3-flash" })
	assert.equal((await a.conn.prompt(say(X, "echo before the restart", { submissionId: "sub-A1" }))).stopReason, "end_turn")
	const Y = await newChat(a) // never prompted
	const Z = await newChat(a)
	assert.equal((await a.conn.prompt(say(Z, "echo the engine will forget this"))).stopReason, "end_turn")
	const beforeX = await gA.readLog(X)
	const beforeZ = await gA.readLog(Z)
	await gA.app.shutdown()
	// The engine's database loses Z (reset outside the gateway); Y is still in it, never prompted
	const store = await engineStore(gA.config)
	assert.ok(store[X] && store[Y] && store[Z])
	delete store[Z]
	await fs.writeFile(engineStoreFile(gA.config), JSON.stringify(store))

	const gB = await startGateway(t, { root })
	const calls = spyEngine(gB.app.broker.engine)
	const { config } = gB

	await t.test("boot: the never-prompted conversation is gone from the index, its log, its empty run folder, and the engine's database", async () => {
		assert.equal(gB.app.broker.index.has(Y), false)
		assert.equal(await exists(logDir(config, Y)), false)
		assert.equal(await exists(path.join(config.workspaceDir, "runs", Y)), false)
		await untilAsync(async () => !(await engineStore(config))[Y], 5000)
		assert.ok((await engineStore(config))[X], "prompted conversations stay in the engine")
		assert.ok(gB.app.broker.index.has(X) && gB.app.broker.index.has(Z))
	})

	await t.test("the same submissionId from two sockets at once, as the first contact after the restart: one turn, both get its result", async () => {
		const b1 = await gB.client()
		const b2 = await gB.client()
		const results = await Promise.allSettled([b1.conn.prompt(say(X, "origin", { submissionId: "sub-B1" })), b2.conn.prompt(say(X, "origin", { submissionId: "sub-B1" }))])
		const echoes = (await gB.readLog(X)).filter((e) => e.kind === "update" && e.update.sessionUpdate === "user_message_chunk" && e.update._meta?.submissionId === "sub-B1")
		assert.equal(echoes.length, 1, "the submission ran once")
		assert.equal(calls.filter((c) => c.method === "prompt" && c.sessionId === X).length, 1)
		assert.deepEqual(
			results.map((r) => (r.status === "fulfilled" ? r.value.stopReason : `rejected ${r.reason?.code}`)),
			["end_turn", "end_turn"],
		)
	})

	const b = await gB.client()
	await t.test("the conversation continues: bound lazily with session/resume, seq continues after the last one on disk (no reuse)", async () => {
		const turn = await b.conn.prompt(say(X, "origin"))
		assert.equal(turn.stopReason, "end_turn")
		const log = await gB.readLog(X)
		assert.equal(log.filter((e) => e.kind === "update" && e.update.content?.text === "resume").length >= 1, true, `engine bound it with resume: ${lastAnswer(b, X)}`)
		assert.ok(!log.some((e) => e.kind === "update" && ["new", "load"].includes(e.update.content?.text)), "never new or load")
		const seqs = log.map((e) => e.seq)
		assertContiguous(seqs, "log of X")
		assert.equal(seqs[0], 1)
		assert.deepEqual(log.slice(0, beforeX.length), beforeX, "events from gateway 1 untouched")
		assert.ok(b.stream(X).every((e) => e.seq > beforeX.at(-1).seq), "live seqs continue after the last one of gateway 1")
		assert.ok(calls.some((c) => c.method === "resumeSession" && c.sessionId === X))
		assert.ok(!calls.some((c) => c.method === "newSession"), "no new engine session for it")
	})

	await t.test("a submission recorded by gateway 1 is a duplicate in gateway 2; nothing reaches the engine", async () => {
		const length = (await gB.readLog(X)).length
		const prompts = calls.filter((c) => c.method === "prompt").length
		const again = await b.conn.prompt(say(X, "echo before the restart", { submissionId: "sub-A1" }))
		assert.equal(again.stopReason, "end_turn")
		assert.equal(again._meta.duplicate, true)
		assert.equal(again._meta.submissionId, "sub-A1")
		assert.equal((await gB.readLog(X)).length, length, "nothing logged")
		assert.equal(calls.filter((c) => c.method === "prompt").length, prompts, "nothing sent to the engine")
	})

	await t.test("the model chosen in gateway 1 is kept (resume reports it, the engine uses it)", async () => {
		const attached = await b.conn.extMethod("_gc/attach", { sessionId: X, afterSeq: 1e9 })
		assert.equal(attached.models.currentModelId, "proxy/z-ai/glm-5.3-flash")
		assert.equal(attached.resident, true)
		await b.conn.prompt(say(X, "model"))
		assert.equal(lastAnswer(b, X), "proxy/z-ai/glm-5.3-flash")
	})

	await t.test("a conversation the engine no longer knows (database reset) becomes archived: -32006, transcript kept and replayable", async () => {
		await assert.rejects(b.conn.prompt(say(Z, "echo still there?")), rpc(-32006))
		const entry = gB.app.broker.index.get(Z)
		assert.equal(entry.archived, true)
		assert.equal(entry.lost, true)
		const c = await gB.client()
		const loaded = await c.conn.loadSession({ sessionId: Z, cwd: "/x", mcpServers: [] })
		assert.equal(loaded._meta.archived, true)
		assert.deepEqual(c.stream(Z).map((e) => e.seq), fannedSeqs(beforeZ))
		assert.ok(c.stream(Z).every(isReplay))
		assert.equal((await gB.readLog(Z)).length, beforeZ.length, "the refused prompt left nothing in the log")
	})
})

// ---- 3. API-06: replay ordering --------------------------------------------------------------------------------

test("API-06: live events of a running turn reach a socket being replayed only after its replay, strictly in seq order", { timeout: 60_000 }, async (t) => {
	const root = await newRoot()
	// The harness pings every 200 ms (for its keepalive test); a client sharing this process with two 4000-frame
	// replays can miss a pong, be terminated, and leave its in-flight request unsettled forever (SDK behaviour)
	const env = { RUNTIME_WS_PING_MS: "60000" }
	const gA = await startGateway(t, { root, env })
	const a0 = await gA.client()
	const X = await newChat(a0)
	assert.equal((await a0.conn.prompt(say(X, "echo a long conversation"))).stopReason, "end_turn")
	const last = (await gA.readLog(X)).at(-1).seq
	await gA.app.shutdown()
	// Make it long: the replay streams the file (the ring only holds this process's events)
	const N = 4000 // ~1 s of replay per socket: far longer than the cancel round trip, which must land inside it
	const filler = "x".repeat(160)
	const lines = []
	for (let i = 1; i <= N; i++) {
		const seq = last + i
		lines.push(JSON.stringify({ seq, ts: T0 + seq, kind: "update", sessionId: X, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${seq} ${filler}` } } }))
	}
	await fs.appendFile(path.join(logDir(gA.config, X), "events.ndjson"), lines.join("\n") + "\n")

	const g = await startGateway(t, { root, env })
	const a = await g.client()
	const b = await g.client()
	const c = await g.client()
	const closed = []
	for (const [name, s] of [["a", a], ["b", b], ["c", c]]) s.ws.once("close", (code) => closed.push(`${name}:${code}`))
	const live = (s) => s.stream(X).filter((e) => !isReplay(e)).length
	const replays = (s) => s.stream(X).filter(isReplay).length

	const turn = a.conn.prompt(say(X, "delegatehang"))
	await until(() => a.notices.some((n) => n.method === "_gc/child_update" && n.params.update?.content?.text === "working…"))
	// B attaches and C loads while the turn runs; once both replays are under way, the cancel makes live events
	const attachB = b.conn.extMethod("_gc/attach", { sessionId: X, afterSeq: 0 }).then((r) => ({ r, liveBefore: live(b) }))
	const loadC = c.conn.loadSession({ sessionId: X, cwd: "/x", mcpServers: [] }).then((r) => ({ r, liveBefore: live(c) }))
	await until(() => replays(b) > 0 && replays(c) > 0, 10000)
	await a.conn.cancel({ sessionId: X })
	assert.equal((await within(turn, 10000, "the cancelled turn")).stopReason, "cancelled")
	const [B, C] = await within(Promise.all([attachB, loadC]), 20000, () => {
		const ports = [...g.app.broker.ports].map((p) => ({ attached: [...p.attached].length, replaying: [...(p.replaying?.keys() ?? [])] }))
		return `replays: attach got ${b.stream(X).length} frames (${replays(b)} replayed), load got ${c.stream(X).length} (${replays(c)}); log busy=${g.app.broker.logs.get(X)?.busy}; ports=${JSON.stringify(ports)}; sockets closed: ${closed.join(",") || "none"}`
	})
	await until(() => b.turnEnds(X).length === 1 && c.turnEnds(X).length === 1, 10000)

	const expected = fannedSeqs(await g.readLog(X))
	assert.ok(expected.length > N)
	for (const [name, s, lastSeq, liveBefore] of [
		["attach", b, B.r.lastSeq, B.liveBefore],
		["load", c, C.r._meta.lastSeq, C.liveBefore],
	]) {
		const got = s.stream(X)
		assert.deepEqual(got.map((e) => e.seq), expected, `${name}: every event once, in log order`)
		assertContiguous(got.map((e) => e.seq), name)
		const firstLive = got.findIndex((e) => !isReplay(e))
		assert.ok(firstLive > 0, `${name}: live events came after the replay`)
		assert.ok(got.slice(0, firstLive).every(isReplay) && got.slice(firstLive).every((e) => !isReplay(e)), `${name}: no live event inside the replay`)
		assert.equal(got[firstLive - 1].seq, lastSeq, `${name}: the replay ends at the reported lastSeq`)
		// the cancel's frames were produced while the replay ran: they were queued and sent before the response
		assert.ok(liveBefore > 0, `${name}: no live event was queued during the replay (replay too fast to test API-06?)`)
	}
	// the live socket saw its own stream in order, without replay
	const own = a.stream(X).map((e) => e.seq)
	assertContiguous(own, "live socket")
	assert.ok(a.stream(X).every((e) => !isReplay(e)))
})

// ---- 4. early frames, concurrent session/new -----------------------------------------------------------------

test("early engine frames: buffered until session/new returns, then logged in order; concurrent session/new; frames for an id never registered are dropped", { timeout: 60_000 }, async (t) => {
	const g = await startGateway(t, { env: { RUNTIME_MAX_RUNNING: "8" } })
	const engine = g.app.broker.engine
	const sockets = await Promise.all([1, 2, 3, 4, 5].map(() => g.client()))
	const modes = ["geology", "standard", "report-analysis", "geology", "standard"]

	await t.test("5 concurrent session/new: own ids, run folders, logs and agentMode, in the gateway and in the engine", async () => {
		// Simulated (the fake has no knob for it): the engine streams frames for the new id before its session/new
		// answer, as the real one does with available_commands_update (which the broker drops).
		engine.newSession = async (params) => {
			const created = await Object.getPrototypeOf(engine).newSession.call(engine, params)
			const id = created.sessionId
			engine.emit("update", { sessionId: id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `early 1 ${id}` } } }, engine.generation)
			engine.emit("child", { rootSessionId: id, childSessionId: `${id}c`, parentSessionId: id, depth: 1, title: "early child", type: "status", status: "running" }, engine.generation)
			engine.emit("update", { sessionId: id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `early 2 ${id}` } } }, engine.generation)
			return created
		}
		let ids
		try {
			ids = await Promise.all(sockets.map((s, i) => newChat(s, modes[i])))
		} finally {
			delete engine.newSession
		}
		assert.equal(new Set(ids).size, 5)
		const store = await engineStore(g.config)
		for (const [i, id] of ids.entries()) {
			assert.match(id, /^ses_/)
			assert.ok((await fs.stat(path.join(g.workspace, "runs", id))).isDirectory())
			const meta = await readJson(path.join(logDir(g.config, id), "meta.json"))
			assert.deepEqual([meta.sessionId, meta.runDir, meta.agentMode], [id, `runs/${id}`, modes[i]])
			assert.equal(g.app.broker.index.get(id).agentMode, modes[i])
			assert.equal(store[id].mode, modes[i], "set_mode reached the engine for this id")
			const log = await g.readLog(id)
			assert.deepEqual(
				log.map((e) => (e.kind === "child" ? e.child.title : e.update.content.text)),
				[`early 1 ${id}`, "early child", `early 2 ${id}`],
				"early frames logged in arrival order, nothing else (available_commands_update dropped)",
			)
			assert.deepEqual(log.map((e) => e.seq), [1, 2, 3])
		}
		// each conversation then runs on its own, with its seq continuing after the early frames
		const turns = await Promise.all(sockets.map((s, i) => s.conn.prompt(say(ids[i], `echo answer ${i}`))))
		for (const [i, id] of ids.entries()) {
			assert.equal(turns[i].stopReason, "end_turn")
			assert.equal(lastAnswer(sockets[i], id), `answer ${i}`)
			const log = await g.readLog(id)
			assertContiguous(log.map((e) => e.seq), id)
			assert.equal(log.filter((e) => e.kind === "update" && e.update.sessionUpdate === "agent_message_chunk" && /^answer/.test(e.update.content.text)).length, 1, "no cross-talk")
			const attached = await sockets[(i + 1) % 5].conn.extMethod("_gc/attach", { sessionId: id, afterSeq: 0 })
			assert.equal(attached.agentMode, modes[i])
		}
	})

	await t.test("frames for an id the gateway never registers: not logged, not sent, dropped after the TTL; nothing else breaks", async (t2) => {
		// Simulated: the fake has no knob that makes the engine talk about an id it never returned
		const stray = "ses_NeverRegistered0000000001"
		t2.mock.timers.enable({ apis: ["setTimeout"] })
		try {
			engine.emit("update", { sessionId: stray, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lost" } } }, engine.generation)
			engine.emit("child", { rootSessionId: stray, childSessionId: `${stray}c`, parentSessionId: stray, depth: 1, title: "t", type: "status", status: "running" }, engine.generation)
			assert.equal(g.app.broker.early.has(stray), true, "held for a session/new that may still answer")
			t2.mock.timers.tick(30_000)
			assert.equal(g.app.broker.early.has(stray), false, "dropped once the TTL passed")
		} finally {
			t2.mock.timers.reset()
		}
		assert.equal(await exists(logDir(g.config, stray)), false)
		const id = await newChat(sockets[0])
		assert.equal((await sockets[0].conn.prompt(say(id, "echo still fine"))).stopReason, "end_turn")
		for (const s of sockets) assert.ok(![...s.updates, ...s.notices.map((n) => n.params)].some((p) => p?.sessionId === stray), "nothing about the stray id reached a socket")
	})
})

// ---- 5. cancel watchdog ----------------------------------------------------------------------------------------

test("cancel watchdog: a turn the engine never ends is ended by the gateway, its engine session closed; other conversations untouched", { timeout: 60_000 }, async (t) => {
	const g = await startGateway(t) // RUNTIME_CANCEL_GRACE_S=1
	const calls = spyEngine(g.app.broker.engine)
	const a = await g.client()
	const X = await newChat(a)
	const Y = await newChat(a)
	const engine = { pid: g.app.broker.engine.pid, generation: g.app.broker.engine.generation }
	const slow = a.conn.prompt(say(Y, "slow 2500"))
	const deaf = a.conn.prompt(say(X, "deaf"))
	await until(() => lastAnswer(a, X) === "not listening" && lastAnswer(a, Y) === "part 1")
	const cancelledAt = Date.now()
	await a.conn.cancel({ sessionId: X })
	const ended = await deaf
	const tookMs = Date.now() - cancelledAt

	assert.equal(ended.stopReason, "cancelled")
	assert.equal(ended._meta.reason, "cancel_timeout")
	assert.equal(ended._meta.forced, undefined, "internal flags stay inside the gateway")
	assert.ok(tookMs >= 900, `ended after ${tookMs} ms: not before the grace period`)
	assert.ok(tookMs < 4000, `ended after ${tookMs} ms`)
	assert.ok(noticesOf(a, "_gc/notice").some((n) => n.sessionId === X && n.level === "warning" && /did not stop after cancel/.test(n.message)))
	assert.equal(a.turnEnds(X).at(-1)._meta.reason, "cancel_timeout")
	assert.ok(calls.some((c) => c.method === "closeSession" && c.sessionId === X), "the engine session was closed")
	assert.equal(boundOf(g, X), false, "unbound until its next prompt")
	assert.equal(turnOf(g, Y), "running", "the other conversation's turn kept running")

	const other = await slow
	assert.equal(other.stopReason, "end_turn")
	assert.equal(lastAnswer(a, Y), "part 2")
	assert.deepEqual({ pid: g.app.broker.engine.pid, generation: g.app.broker.engine.generation }, engine, "the engine was not restarted")

	const next = await a.conn.prompt(say(X, "origin"))
	assert.equal(next.stopReason, "end_turn")
	assert.equal(lastAnswer(a, X), "resume", "re-bound with session/resume after the close")
	const log = await g.readLog(X)
	assertContiguous(log.map((e) => e.seq), "log of X")
	assert.equal(log.filter((e) => e.kind === "turn_end").map((e) => e._meta.reason ?? e.stopReason).join(","), "cancel_timeout,end_turn")
})

// ---- 6. cancel with a pending permission ------------------------------------------------------------------------

test("cancel with a pending permission: the gateway answers the engine first, the turn ends cleanly; an unanswered permission times out", { timeout: 60_000 }, async (t) => {
	const g = await startGateway(t, { env: { RUNTIME_PERMISSION_TIMEOUT_S: "1" } })
	let release
	const late = new Promise((resolve) => (release = resolve))
	const a = await g.client({ permission: () => late })
	const X = await newChat(a)

	await t.test("cancel: permission resolved by 'cancel', the engine gets the answer before the cancel, turn cancelled without an error", async () => {
		const turn = a.conn.prompt(say(X, "ask"))
		await until(() => a.permissions.length === 1)
		const reqId = a.permissions[0]._meta.reqId
		await a.conn.cancel({ sessionId: X })
		const ended = await turn
		assert.equal(ended.stopReason, "cancelled")
		assert.notEqual(ended._meta.reason, "error")
		assert.equal(ended._meta.errorName, undefined)
		const resolved = noticesOf(a, "_gc/permission_resolved").find((p) => p.reqId === reqId)
		assert.deepEqual([resolved.by, resolved.outcome.outcome], ["cancel", "cancelled"])
		const log = await g.readLog(X)
		const answer = log.find((e) => e.kind === "permission_response" && e.reqId === reqId)
		assert.equal(answer.by, "cancel")
		// The fake declines the call only when the answer reached it before the cancel (a cancel first withdraws the
		// request and any later answer fails the prompt with PermissionNotFoundError)
		assert.ok(
			log.some((e) => e.kind === "child" && e.update?.status === "failed" && e.update.content?.[0]?.content?.text === "The user declined this tool call"),
			"the engine saw the cancelled answer before session/cancel",
		)
		assert.ok(!log.some((e) => e.kind === "update" && /^Error:/.test(e.update.content?.text ?? "")), "no Error: line")
		assert.equal(g.app.broker.status().sessions.find((s) => s.sessionId === X)?.pendingPermissions?.length ?? 0, 0)
	})

	await t.test("the socket's late answer is ignored; the conversation goes on", async () => {
		release({ outcome: { outcome: "selected", optionId: "once" } })
		const turn = await a.conn.prompt(say(X, "echo after the cancel"))
		assert.equal(turn.stopReason, "end_turn")
		assert.equal(lastAnswer(a, X), "after the cancel")
		assert.equal((await g.readLog(X)).filter((e) => e.kind === "permission_response").length, 1, "the late answer was not recorded")
	})

	await t.test("permission timeout (RUNTIME_PERMISSION_TIMEOUT_S): rejected, with a notice; the specialist declines and the turn ends", async () => {
		const b = await g.client({ permission: () => new Promise(() => {}) })
		const W = await newChat(b)
		const started = Date.now()
		const turn = await b.conn.prompt(say(W, "ask"))
		assert.ok(Date.now() - started >= 900, "not before the timeout")
		assert.equal(turn.stopReason, "end_turn")
		assert.equal(lastAnswer(b, W), "declined")
		const resolved = noticesOf(b, "_gc/permission_resolved").find((p) => p.sessionId === W)
		assert.equal(resolved.by, "timeout")
		assert.deepEqual(resolved.outcome, { outcome: "selected", optionId: "reject" })
		assert.ok(noticesOf(b, "_gc/notice").some((n) => n.sessionId === W && n.level === "warning" && /timed out/.test(n.message)))
		assert.equal(a.permissions.length, 1, "a socket not attached to W was never asked")
	})
})

// ---- 7. specialists under cancel; parallel children ------------------------------------------------------------

test("specialists: delegatehang + cancel interrupts the tree in the measured order; parallel children link to their own calls", { timeout: 60_000 }, async (t) => {
	const g = await startGateway(t)
	const a = await g.client()

	await t.test("delegatehang + cancel: S1's call fails, S1 interrupted, the root's call fails, S2 interrupted, usage, turn_end — in that order", async () => {
		const X = await newChat(a)
		const turn = a.conn.prompt(say(X, "delegatehang"))
		await until(() => a.notices.some((n) => n.method === "_gc/child_update" && n.params.sessionId === X && n.params.update?.content?.text === "working…"))
		const seen = a.stream(X).length
		await a.conn.cancel({ sessionId: X })
		const ended = await turn
		assert.equal(ended.stopReason, "cancelled")
		const children = noticesOf(a, "_gc/child_update").filter((p) => p.sessionId === X)
		const s1 = children.find((p) => p.child.depth === 1).child
		const s2 = children.find((p) => p.child.depth === 2).child
		const rootCall = a.updates.find((u) => u.sessionId === X && u.update.sessionUpdate === "tool_call" && u.update.title === "subagent").update.toolCallId
		const describe = (e) => {
			if (e.kind === "_gc/turn_end") return `turn_end ${e.params.stopReason}`
			if (e.kind === "update") return `root ${e.update.sessionUpdate}${e.update.status ? ` ${e.update.status}` : ""}${e.update.toolCallId ? ` ${e.update.toolCallId}` : ""}`
			const who = e.params.child.sessionId === s1.sessionId ? "S1" : "S2"
			return e.params.type === "status" ? `${who} ${e.params.status}` : `${who} ${e.params.update.sessionUpdate} ${e.params.update.status ?? ""}`.trim()
		}
		const after = a.stream(X).slice(seen)
		assert.deepEqual(after.map(describe), [
			"S1 tool_call_update failed",
			"S1 interrupted",
			`root tool_call_update failed ${rootCall}`,
			"S2 interrupted",
			"root usage_update",
			"turn_end cancelled",
		])
		assertContiguous(after.map((e) => e.seq), "cancel frames")
		assert.equal(after[0].params.child.toolCallId, rootCall, "S1 stays linked to the root's call")
		assert.match(after[0].params.update.content[0].content.text, new RegExp(`Tool execution interrupted \\(sessionID: ${s2.sessionId}\\)`))
		assert.equal(after[3].params.child.toolCallId, s2.toolCallId)
		assert.match(s2.toolCallId, new RegExp(`^${s1.sessionId}:`))
		// the log holds the same order
		const log = await g.readLog(X)
		assert.deepEqual(log.slice(-6).map((e) => e.kind), ["child", "child", "update", "child", "update", "turn_end"])
	})

	await t.test("delegatepar: two children of the same description, each linked to its own subagent call; links confirmed at completion", async () => {
		const X = await newChat(a, "standard")
		const before = a.notices.length
		assert.equal((await a.conn.prompt(say(X, "delegatepar"))).stopReason, "end_turn")
		const frames = a.notices.slice(before).filter((n) => n.method === "_gc/child_update" && n.params.sessionId === X).map((n) => n.params)
		const calls = a.updates.filter((u) => u.sessionId === X && u.update.sessionUpdate === "tool_call" && u.update.title === "subagent").map((u) => u.update.toolCallId)
		assert.equal(calls.length, 2)
		const completions = a.updates
			.filter((u) => u.sessionId === X && u.update.status === "completed" && u.update.rawOutput?.metadata?.sessionID)
			.map((u) => [u.update.toolCallId, u.update.rawOutput.metadata.sessionID])
		const truth = new Map(completions.map(([call, child]) => [child, call]))
		assert.equal(truth.size, 2)
		for (const frame of frames) assert.equal(frame.child.toolCallId, truth.get(frame.child.sessionId), `${frame.type} ${frame.status ?? ""}: wrong spawning call`)
		assert.deepEqual(new Set(frames.map((f) => f.child.toolCallId)), new Set(calls))
	})

	await t.test("children created out of call order (simulated frames): a wrong first guess is corrected when a call completes", async () => {
		// Simulated: the fake always creates parallel children in call order (as measured); the gateway must not depend on it
		const X = await newChat(a)
		const turn = a.conn.prompt(say(X, "hang"))
		await until(() => lastAnswer(a, X) === "hanging")
		const engine = g.app.broker.engine
		const up = (update) => engine.emit("update", { sessionId: X, update }, engine.generation)
		const child = (childSessionId, rest) => engine.emit("child", { rootSessionId: X, childSessionId, parentSessionId: X, depth: 1, title: "task for dataops", ...rest }, engine.generation)
		const input = { agent: "dataops", description: "task for dataops", prompt: "RESULT ok" }
		const [callA, callB] = ["call_syn_0", "call_syn_1"]
		const [kidA, kidB] = ["ses_SynKidA000000000000000001", "ses_SynKidB000000000000000001"]
		const before = a.notices.length
		for (const id of [callA, callB]) up({ sessionUpdate: "tool_call", toolCallId: id, kind: "think", title: "subagent", status: "pending", locations: [], rawInput: {} })
		for (const id of [callA, callB]) up({ sessionUpdate: "tool_call_update", toolCallId: id, kind: "think", title: "subagent", status: "in_progress", rawInput: input })
		// callB's child is created first, each followed by the duplicate in_progress of its own call (measured shape)
		child(kidB, { type: "status", status: "created" })
		up({ sessionUpdate: "tool_call_update", toolCallId: callB, kind: "think", title: "subagent", status: "in_progress", rawInput: input })
		child(kidB, { type: "status", status: "running" })
		child(kidA, { type: "status", status: "created" })
		up({ sessionUpdate: "tool_call_update", toolCallId: callA, kind: "think", title: "subagent", status: "in_progress", rawInput: input })
		child(kidA, { type: "status", status: "running" })
		// kidA finishes first; its call's completion names it
		child(kidA, { type: "status", status: "completed" })
		up({ sessionUpdate: "tool_call_update", toolCallId: callA, status: "completed", rawOutput: { metadata: { sessionID: kidA, status: "completed" } } })
		// kidB is still working: its frames must name its own call from now on
		child(kidB, { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still working" } } })
		child(kidB, { type: "status", status: "completed" })
		up({ sessionUpdate: "tool_call_update", toolCallId: callB, status: "completed", rawOutput: { metadata: { sessionID: kidB, status: "completed" } } })
		// 7 engine frames + 2 relink frames (kidB displaced from callA, kidA moved onto callA)
		await until(() => a.notices.slice(before).filter((n) => n.method === "_gc/child_update").length === 9)
		await a.conn.cancel({ sessionId: X })
		await turn
		const frames = a.notices.slice(before).filter((n) => n.method === "_gc/child_update").map((n) => n.params)
		const history = frames.map((f) => `${f.child.sessionId === kidA ? "kidA" : "kidB"} ${f.status ?? f.update?.sessionUpdate}${f.relinked ? " (relinked)" : ""} → ${f.child.toolCallId}`).join("; ")
		assert.deepEqual(frames.slice(0, 5).map((f) => f.child.sessionId), [kidB, kidB, kidA, kidA, kidA], history)
		// callA's completion named kidA: right away, both children get a frame with their corrected call
		const relinks = frames.slice(5, 7)
		assert.ok(relinks.every((f) => f.relinked === true), history)
		assert.deepEqual(
			relinks.map((f) => [f.child.sessionId, f.child.toolCallId, f.status]).sort(),
			[
				[kidA, callA, "completed"],
				[kidB, callB, "running"],
			].sort(),
			history,
		)
		// kidB's own frames after the correction name its own call
		for (const f of frames.slice(7)) assert.deepEqual([f.child.sessionId, f.child.toolCallId], [kidB, callB], history)
	})
})

// ---- 8. engine and MCP recovery ---------------------------------------------------------------------------------

test("engine and MCP recovery: MCP down at boot, deferred engine restart for the tools, MCP crash, engine crash loop", { timeout: 60_000 }, async (t) => {
	const healthy = [process.execPath, FAKE_MCP]
	const g = await startGateway(t, {
		env: { RUNTIME_ENGINE_READY_WAIT_S: "1" },
		// The fake MCP's hooks reach it only through /usr/bin/env (the supervisor passes a whitelisted env)
		seed: async (_root, config) => {
			config.mcpCommand = "/usr/bin/env"
			config.mcpArgs = ["FAKE_MCP_EXIT_AFTER_MS=0", ...healthy]
		},
	})
	const { app, config } = g
	const broker = app.broker
	const a = await g.client()
	const b = await g.client() // attached to nothing: still gets machine-wide notices
	const X = await newChat(a)

	await t.test("MCP down at boot: the engine is ready anyway, its tools missing; /readyz says so", async () => {
		const ready = await (await g.get("/readyz")).json()
		assert.equal(ready.ready, true)
		assert.equal(ready.components.engine.tools, "missing")
		assert.equal(ready.components.engine.generation, 1)
		assert.notEqual(ready.components.mcp.state, "ready")
	})

	await t.test("MCP back while a turn runs: the engine restart waits for the turn's end, then generation+1 with tools connected", async () => {
		const turn = a.conn.prompt(say(X, "slow 30000"))
		await until(() => lastAnswer(a, X) === "part 1")
		config.mcpArgs = healthy // the next scheduled MCP start succeeds
		await until(() => noticesOf(b, "_gc/notice").some((n) => /MCP server\) are back/.test(n.message)), 15000)
		assert.equal(broker.mcp.state, "ready")
		assert.equal(broker.engine.state, "ready", "not restarted under a running turn")
		assert.equal(broker.engine.generation, 1)
		assert.equal(broker.engine.tools, "missing")
		assert.equal(turnOf(g, X), "running")
		await a.conn.cancel({ sessionId: X })
		const ended = await turn
		assert.equal(ended.stopReason, "cancelled")
		assert.notEqual(ended._meta.reason, "server_restart", "the turn ended on its own terms")
		await until(() => broker.engine.state === "ready" && broker.engine.generation === 2, 10000)
		assert.equal(broker.engine.tools, "connected")
		const ready = await (await g.get("/readyz")).json()
		assert.equal(ready.components.engine.tools, "connected")
		assert.equal((await a.conn.prompt(say(X, "origin"))).stopReason, "end_turn")
		assert.equal(lastAnswer(a, X), "resume")
	})

	await t.test("MCP crash mid-life: a notice on every socket, the MCP restarts, the engine is untouched", async () => {
		const before = { pid: broker.engine.pid, generation: broker.engine.generation }
		const mcpPid = broker.mcp.pid
		const noticesB = noticesOf(b, "_gc/notice").length
		// SIGKILL is the deterministic crash (FAKE_MCP_EXIT_AFTER_MS counts from spawn, not from now)
		process.kill(mcpPid, "SIGKILL")
		for (const s of [a, b]) await until(() => noticesOf(s, "_gc/notice").some((n) => n.level === "warning" && /MCP server\) stopped and are restarting/.test(n.message)))
		await until(() => broker.mcp.state === "ready" && broker.mcp.pid !== mcpPid, 15000)
		await until(() => noticesOf(b, "_gc/notice").slice(noticesB).some((n) => /are back/.test(n.message)))
		assert.equal(await running(mcpPid), false)
		assert.deepEqual({ pid: broker.engine.pid, generation: broker.engine.generation }, before)
		assert.equal(broker.engine.tools, "connected")
		assert.equal((await a.conn.prompt(say(X, "echo tools are back"))).stopReason, "end_turn")
	})

	await t.test("engine crash loop → unavailable; session/new and prompt → -32003 with data.state; fixed knobs → it recovers", async () => {
		g.setKnobs({ FAKE_OPENCODE_EXIT_AT_START: 3 }) // every new engine process exits at once
		// Five restarts already in the window (the 1/2/5/15/30 s backoff can't be shortened from the config)
		broker.engine.restarts = Array.from({ length: 5 }, () => Date.now())
		const crashed = await a.conn.prompt(say(X, "crash"))
		assert.equal(crashed._meta.reason, "server_restart")
		await until(() => broker.engine.state === "unavailable", 5000)
		await until(() => noticesOf(b, "_gc/status").some((s) => s.engine.state === "unavailable"))
		const readyz = await g.get("/readyz")
		assert.equal(readyz.status, 503)
		assert.equal((await readyz.json()).components.engine.state, "unavailable")
		// a request is the retry: it starts the engine again, which still fails
		await assert.rejects(a.conn.newSession({ cwd: "/x", mcpServers: [] }), (e) => e.code === -32003 && typeof e.data?.state === "string" && e.data.state !== "ready")
		await assert.rejects(a.conn.prompt(say(X, "echo anyone?")), (e) => e.code === -32003 && typeof e.data?.state === "string" && e.data.state !== "ready")
		g.setKnobs({})
		await until(() => broker.engine.state === "ready", 15000)
		const id = await newChat(a)
		assert.equal((await a.conn.prompt(say(id, "echo recovered"))).stopReason, "end_turn")
		assert.equal((await a.conn.prompt(say(X, "origin"))).stopReason, "end_turn")
		assert.equal(lastAnswer(a, X), "resume")
	})
})

// ---- 9. capacity and memory -------------------------------------------------------------------------------------

test("capacity and memory: maxRunning and the memory guard refuse with -32005 before the engine is asked; API-04 admits one of two concurrent prompts", { timeout: 60_000 }, async (t) => {
	let memory = null
	const g = await startGateway(t, { env: { RUNTIME_MAX_RUNNING: "1" }, memory: async () => memory })
	const calls = spyEngine(g.app.broker.engine)
	const a = await g.client()
	const X = await newChat(a)
	const Y = await newChat(a)

	await t.test("RUNTIME_MAX_RUNNING=1: a second running conversation gets -32005 with data.running; free again after the first ends", async () => {
		const hang = a.conn.prompt(say(X, "hang"))
		// "running" is set before X's own engine prompt is sent: wait for the engine's first frame, so the
		// count below can't race X's call (a flake under load)
		await until(() => turnOf(g, X) === "running" && lastAnswer(a, X) === "hanging")
		const prompts = calls.filter((c) => c.method === "prompt").length
		await assert.rejects(a.conn.prompt(say(Y, "echo no room")), (e) => e.code === -32005 && /capacity/.test(e.message) && e.data?.maxRunning === 1 && e.data?.running?.[0] === X)
		assert.equal(calls.filter((c) => c.method === "prompt").length, prompts, "nothing sent to the engine")
		const status = await a.conn.extMethod("_gc/status", {})
		assert.equal(status.running, 1)
		assert.deepEqual(status.capacity, { maxRunning: 1 })
		await a.conn.cancel({ sessionId: X })
		assert.equal((await hang).stopReason, "cancelled")
		assert.equal((await a.conn.prompt(say(Y, "echo room now"))).stopReason, "end_turn")
	})

	await t.test("memory guard: above RUNTIME_MEMORY_GUARD_PCT → -32005 with usedMb/maxMb; nothing logged or sent to the engine", async () => {
		memory = { used: 950 * 1048576, max: 1000 * 1048576 }
		const log = (await g.readLog(Y)).length
		const before = calls.length
		await assert.rejects(a.conn.prompt(say(Y, "echo too full")), (e) => e.code === -32005 && /memory/.test(e.message) && e.data?.usedMb === 950 && e.data?.maxMb === 1000)
		assert.deepEqual(calls.slice(before), [], "the engine was not asked")
		assert.equal((await g.readLog(Y)).length, log, "no echo of the refused prompt")
		memory = { used: 100 * 1048576, max: 1000 * 1048576 }
		assert.equal((await a.conn.prompt(say(Y, "echo fits"))).stopReason, "end_turn")
		memory = null
	})

	const twoAtOnce = async (id, text) => {
		const results = await Promise.allSettled([a.conn.prompt(say(id, text)), a.conn.prompt(say(id, text))])
		const ran = results.filter((r) => r.status === "fulfilled")
		const refused = results.filter((r) => r.status === "rejected")
		assert.equal(ran.length, 1, `exactly one ran: ${results.map((r) => r.status === "fulfilled" ? r.value.stopReason : r.reason?.code)}`)
		assert.equal(ran[0].value.stopReason, "end_turn")
		assert.equal(refused.length, 1)
		assert.equal(refused[0].reason.code, -32001)
	}

	await t.test("API-04: two prompts for the same idle, bound conversation at once → one runs, the other -32001", async () => {
		const echoes = (await g.readLog(Y)).filter((e) => e.update?.sessionUpdate === "user_message_chunk").length
		await twoAtOnce(Y, "echo one of two")
		assert.equal((await g.readLog(Y)).filter((e) => e.update?.sessionUpdate === "user_message_chunk").length, echoes + 1)
	})

	await t.test("API-04 across the lazy bind: after an engine restart, the same race while session/resume is in flight", async () => {
		await g.app.broker.engine.restart("test: unbind every conversation")
		assert.equal(boundOf(g, Y), false)
		const resumes = calls.filter((c) => c.method === "resumeSession" && c.sessionId === Y).length
		await twoAtOnce(Y, "origin")
		assert.equal(lastAnswer(a, Y), "resume")
		assert.equal(calls.filter((c) => c.method === "resumeSession" && c.sessionId === Y).length, resumes + 1, "one shared resume")
	})

	await t.test("capacity is checked before the bind: a refused prompt does not resume the conversation", async () => {
		await g.app.broker.engine.restart("test: unbind every conversation")
		const hang = a.conn.prompt(say(X, "hang"))
		await until(() => turnOf(g, X) === "running")
		const resumes = calls.filter((c) => c.method === "resumeSession" && c.sessionId === Y).length
		await assert.rejects(a.conn.prompt(say(Y, "echo no room")), rpc(-32005))
		assert.equal(calls.filter((c) => c.method === "resumeSession" && c.sessionId === Y).length, resumes, "no session/resume for a refused prompt")
		await a.conn.cancel({ sessionId: X })
		await hang
	})
})

// ---- 10. shutdown -----------------------------------------------------------------------------------------------

test("shutdown with turns running: they end cancelled and are on disk; engine, its server, the tool process and the MCP are gone within 10 s", { timeout: 60_000 }, async (t) => {
	const g = await startGateway(t)
	const a = await g.client()
	const X = await newChat(a)
	const Y = await newChat(a, "standard")
	const hang = a.conn.prompt(say(X, "hang"))
	const kidhang = a.conn.prompt(say(Y, "kidhang"))
	await until(() => lastAnswer(a, X) === "hanging" && /^kid \d+$/.test(lastAnswer(a, Y) ?? ""))
	const kid = Number(lastAnswer(a, Y).split(" ")[1])
	const broker = g.app.broker
	const pids = { engine: broker.engine.pid, server: g.engineMeta().serverPid, kid, mcp: broker.mcp.pid }
	for (const [name, pid] of Object.entries(pids)) assert.ok(await running(pid), `${name} runs before the shutdown`)

	const started = Date.now()
	await g.app.shutdown()
	const tookMs = Date.now() - started
	assert.ok(tookMs < 10000, `shutdown took ${tookMs} ms`)
	for (const [name, pid] of Object.entries(pids)) assert.equal(await running(pid), false, `${name} (${pid}) still running`)
	assert.equal(broker.engine.state, "stopped")
	assert.equal(broker.mcp.state, "stopped")
	const results = await Promise.allSettled([hang, kidhang])
	for (const r of results) assert.equal(r.status === "fulfilled" ? r.value.stopReason : `rejected: ${r.reason?.message}`, "cancelled")
	for (const id of [X, Y]) {
		const last = (await g.readLog(id)).at(-1)
		assert.equal(last.kind, "turn_end", `${id}: turn_end flushed`)
		assert.equal(last.stopReason, "cancelled")
	}
})

// ---- 11. report export ------------------------------------------------------------------------------------------

test("report export: an end_turn in geology/standard writes runs/<id>/_reports/REPORT_*.md before turn_end; cancelled, failed, empty and disabled write none", { timeout: 60_000 }, async (t) => {
	const g = await startGateway(t) // pandoc missing: the conversions fail (logged); the .md is what counts
	const a = await g.client()
	const reports = async (id) => (await fs.readdir(path.join(g.workspace, "runs", id, "_reports")).catch(() => [])).filter((f) => f.endsWith(".md")).sort()
	const REPORT = (id) => new RegExp(`^runs/${id}/_reports/REPORT_\\d{8}_\\d{6}(_\\d+)?\\.md$`)

	await t.test("geology: the answer after the last root tool call, verbatim; its path in turn_end._meta.report", async () => {
		const G = await newChat(a, "geology")
		const turn = await a.conn.prompt(say(G, "read hello.txt | ## Answer\\nhello.txt says **hello world**."))
		assert.equal(turn.stopReason, "end_turn")
		assert.match(turn._meta.report, REPORT(G))
		// written before turn_end: it exists as soon as the response is here
		assert.equal(await fs.readFile(path.join(g.workspace, turn._meta.report), "utf8"), "## Answer\nhello.txt says **hello world**.")
		assert.equal(a.turnEnds(G).at(-1)._meta.report, turn._meta.report)
		assert.equal((await g.readLog(G)).at(-1)._meta.report, turn._meta.report)
	})

	await t.test("standard: specialists' text is not part of the report; two reports in the same second get distinct names", async () => {
		const S = await newChat(a, "standard")
		const one = await a.conn.prompt(say(S, "delegate"))
		assert.match(one._meta.report, REPORT(S))
		assert.equal(await fs.readFile(path.join(g.workspace, one._meta.report), "utf8"), "delegated")
		const two = await a.conn.prompt(say(S, "echo second answer"))
		assert.notEqual(two._meta.report, one._meta.report)
		assert.equal(await fs.readFile(path.join(g.workspace, two._meta.report), "utf8"), "second answer", "each turn's own answer only")
		assert.equal((await reports(S)).length, 2)
	})

	await t.test("cancelled, failed and empty-answer turns write no report", async () => {
		const G = await newChat(a, "geology")
		const slow = a.conn.prompt(say(G, "slow 30000"))
		await until(() => lastAnswer(a, G) === "part 1")
		await a.conn.cancel({ sessionId: G })
		const cancelled = await slow
		assert.equal(cancelled.stopReason, "cancelled")
		assert.equal(cancelled._meta.report, undefined)
		const failed = await a.conn.prompt(say(G, "error 500"))
		assert.equal(failed._meta.reason, "error")
		assert.equal(failed._meta.report, undefined)
		const empty = await a.conn.prompt(say(G, "read hello.txt |"))
		assert.equal(empty.stopReason, "end_turn")
		assert.equal(empty._meta.report, undefined)
		assert.deepEqual(await reports(G), [])
	})

	await t.test("RUNTIME_REPORT_EXPORT=0: no report, no _reports folder", async (t2) => {
		const off = await startGateway(t2, { env: { RUNTIME_REPORT_EXPORT: "0" } })
		const c = await off.client()
		const G = await newChat(c, "geology")
		const turn = await c.conn.prompt(say(G, "read hello.txt | an answer nobody saves"))
		assert.equal(turn.stopReason, "end_turn")
		assert.equal(turn._meta.report, undefined)
		assert.equal(await exists(path.join(off.workspace, "runs", G, "_reports")), false)
	})
})
