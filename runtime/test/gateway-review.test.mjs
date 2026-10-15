/**
 * Regression tests for the Step 4.3 adversarial review (s43 review.json: CONC-*, LC-*, SEC-1, SEC-3, CT-*, TQ-5),
 * end to end through the WebSocket: the real gateway (createServer), the scripted engine (test/fake-opencode.mjs)
 * and the fake shared MCP (test/fake-mcp.mjs). Each test is the reviewers' repro, ported: it failed on the code
 * the review read and passes on the fixed one.
 *
 * Where the fake can't produce a timing, the test reaches into the gateway at the one point the finding names
 * (the RE-4 log append for CT-8, engine.prompt for CT-2's "engine gone before the prompt", the memory guard to hold
 * a prompt in its admission) and says so. MCP restart policy fields (backoffMs, maxRestarts) are shortened through
 * the supervisor's public fields: the production 1/2/5/15/30 s policy would take minutes.
 *
 * Three gaps the first fixes left (the CT-1 same-turn relink, LC-3's model change woken into a tools restart, and a
 * shutdown response lost since the CONC-1 reordering) were `todo` tests; since their fixes they are plain checks.
 *
 *   node --test test/gateway-review.test.mjs
 */
import assert from "node:assert/strict"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { after, test } from "node:test"
import { pathToFileURL } from "node:url"
import { FAKE_MCP, running, say, startGateway, tmpdir, until, wsClient } from "./gateway-harness.mjs"

// ---- helpers -------------------------------------------------------------------------------------------------

/** Volumes shared by two gateways (a restart) belong to the test, not to startGateway: removed after everything. */
const roots = []
after(async () => {
	for (const root of roots) await fs.rm(root, { recursive: true, force: true })
})
async function newRoot() {
	const root = await tmpdir("gw-review-")
	roots.push(root)
	return root
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"))
const rpc = (code) => (error) => error?.code === code
const newChat = async (c, agentMode = "geology") => (await c.conn.newSession({ cwd: "/x", mcpServers: [], _meta: { agentMode } })).sessionId
const lastAnswer = (c, id) =>
	c.updates.filter((u) => u.sessionId === id && u.update.sessionUpdate === "agent_message_chunk" && !u.update._meta?.replay).at(-1)?.update.content.text
const noticesOf = (c, method) => c.notices.filter((n) => n.method === method).map((n) => n.params)
const turnOf = (g, id) => g.app.broker.status().sessions.find((s) => s.sessionId === id)?.turn ?? "idle"
const isReplay = (e) => (e.kind === "update" ? e.update?._meta?.replay === true : e.params?.replay === true)
const engineStoreFile = (config) => path.join(config.engineStateDir, "data", "fake-opencode", "sessions.json")
const errorLines = (log) => log.filter((e) => e.kind === "update" && e.update._meta?.gateway === "error").map((e) => e.update.content.text)
/** _gc/turn_end._meta is the gateway's vocabulary (CT-3) */
const TURN_END_KEYS = new Set(["reason", "error", "errorName", "citationFailed", "processesStopped", "submissionId", "report"])

function deferred() {
	let resolve
	const promise = new Promise((r) => (resolve = r))
	return { promise, resolve }
}

/** `promise`, or a failure naming what never settled (a stuck gateway must fail the test, not hang the suite). */
async function within(promise, ms, what) {
	let timer
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what}: not settled after ${ms} ms`)), ms)
	})
	try {
		return await Promise.race([promise, timeout])
	} finally {
		clearTimeout(timer)
	}
}

function assertIncreasing(list, label) {
	const at = list.findIndex((seq, i) => i > 0 && !(seq > list[i - 1]))
	if (at > 0) assert.fail(`${label}: seq ${list[at]} arrived after ${list[at - 1]} (around: ${list.slice(Math.max(0, at - 6), at + 6).join(",")})`)
}

/** Every call the broker forwards to the engine, with the prompt it sent (the spy wraps the supervisor's methods). */
function spyEngine(engine) {
	const calls = []
	for (const method of ["newSession", "setMode", "setConfigOption", "resumeSession", "closeSession", "deleteSession", "prompt", "cancel"]) {
		const original = engine[method].bind(engine)
		engine[method] = (...args) => {
			const params = args[0]
			calls.push({
				method,
				sessionId: typeof params === "string" ? params : params?.sessionId ?? null,
				...(method === "prompt" ? { prompt: params.prompt, text: params.prompt?.find((b) => b.type === "text")?.text } : {}),
			})
			return original(...args)
		}
	}
	return calls
}

/** The fake engine's one-shot trap (FAKE_OPENCODE_TRAP_FILE defaults to this file next to the knobs). */
const trapFile = (g) => path.join(g.root, "fake-opencode-trap.json")
const setTrap = (g, trap) => fsSync.writeFileSync(trapFile(g), JSON.stringify(trap))

/** The fake MCP's hooks reach it only through /usr/bin/env (the supervisor passes a whitelisted env). */
function mcpWith(config, vars) {
	config.mcpCommand = "/usr/bin/env"
	config.mcpArgs = [...Object.entries(vars).map(([k, v]) => `${k}=${v}`), process.execPath, FAKE_MCP]
}

// ---- CONC-1 -----------------------------------------------------------------------------------------------------

test("CONC-1: a prompt retried on -32001 while a turn ends is admitted only after that turn_end: seqs never go backwards, each turn keeps its submissionId, API-07 still dedupes", { timeout: 60_000 }, async (t) => {
	const g = await startGateway(t)
	const a = await g.client()
	const b = await g.client()
	/** The second tab retries busy at once, as a client that retries -32001 does: it lands in the turn's end */
	const hammer = async (sessionId, text, submissionId) => {
		for (let attempts = 1; ; attempts++) {
			try {
				return await b.conn.prompt(say(sessionId, text, { submissionId }))
			} catch (error) {
				if (error?.code !== -32001 || attempts > 20000) throw error
			}
		}
	}
	const rounds = async (X, n, prefix, textB) => {
		const seconds = []
		for (let round = 0; round < n; round++) {
			const first = a.conn.prompt(say(X, "slow 40", { submissionId: `${prefix}A${round}` }))
			await until(() => turnOf(g, X) === "running")
			const second = await hammer(X, textB(round), `${prefix}B${round}`)
			const firstResult = await first
			assert.equal(firstResult.stopReason, "end_turn")
			assert.equal(firstResult._meta.submissionId, `${prefix}A${round}`)
			assert.equal(second.stopReason, "end_turn", `round ${round}: ${JSON.stringify(second._meta)}`)
			assert.equal(second._meta.submissionId, `${prefix}B${round}`, `round ${round}: the second turn lost its submissionId to the first one's end`)
			assert.equal(second._meta.duplicate, undefined)
			seconds.push(second)
		}
		const turns = 2 * n
		await until(() => a.turnEnds(X).length === turns && b.turnEnds(X).length === turns)
		// API-07 / contract: keep the highest seq, resume with afterSeq. A turn_end after the next turn's frames breaks that
		for (const [name, c] of [
			["a", a],
			["b", b],
		]) {
			assertIncreasing(c.stream(X).filter((e) => !isReplay(e)).map((e) => e.seq), `socket ${name}`)
		}
		const log = await g.readLog(X)
		assertIncreasing(log.map((e) => e.seq), "log")
		// each turn_end names the submission whose echo opened its turn
		let current = null
		for (const e of log) {
			if (e.kind === "update" && e.update.sessionUpdate === "user_message_chunk") current = e.update._meta?.submissionId ?? null
			if (e.kind === "turn_end") assert.equal(e._meta.submissionId, current, `turn_end seq ${e.seq} names another turn's submission`)
		}
		assert.equal(log.filter((e) => e.kind === "turn_end").length, turns)
		// what API-07 reads: every submission done
		const meta = await readJson(path.join(g.config.gatewayStateDir, "sessions", X, "meta.json"))
		for (let round = 0; round < n; round++) {
			for (const s of ["A", "B"]) assert.equal(meta.submissions.find((r) => r.id === `${prefix}${s}${round}`)?.state, "done", `${prefix}${s}${round} in meta.json`)
		}
		// a retry of the second tab's last submission is a duplicate: nothing runs again
		const retry = await b.conn.prompt(say(X, textB(n - 1), { submissionId: `${prefix}B${n - 1}` }))
		assert.equal(retry._meta.duplicate, true)
		assert.equal(retry._meta.submissionId, `${prefix}B${n - 1}`)
		assert.equal((await g.readLog(X)).length, log.length, "the retried submission did not run again")
		assert.deepEqual(errorLines(log), [])
		return seconds
	}

	await t.test("geology: 8 rounds", async () => {
		const X = await newChat(a)
		await b.conn.extMethod("_gc/attach", { sessionId: X, afterSeq: 0 })
		await rounds(X, 8, "g", (i) => `echo second ${i}`)
	})

	await t.test("report-analysis: the turn admitted right after a turn_end still passes RE-4 and exports its report", async () => {
		await fs.mkdir(path.join(g.workspace, "report", "text"), { recursive: true })
		await fs.writeFile(path.join(g.workspace, "report", "text", "01_summary.md"), "summary")
		const R = await newChat(a, "report-analysis")
		await b.conn.extMethod("_gc/attach", { sessionId: R, afterSeq: 0 })
		const answer = (i) => `Grade ${i} g/t [source: text/01_summary.md | p:1]`
		const seconds = await rounds(R, 4, "r", (i) => `read report/text/01_summary.md | ${answer(i)}`)
		for (const [i, second] of seconds.entries()) {
			assert.equal(second._meta.citationFailed, undefined)
			assert.match(second._meta.report ?? "", new RegExp(`^runs/${R}/_reports/REPORT_`), `round ${i}: no report`)
			assert.equal(await fs.readFile(path.join(g.workspace, second._meta.report), "utf8"), answer(i))
		}
	})
})

// ---- one gateway, many findings -----------------------------------------------------------------------------------

test("review fixes on one gateway: CT-7, LC-5/CT-6, CONC-2/CT-1, CONC-3, CONC-4, CT-8, CT-3, TQ-5, SEC-1, SEC-3, LC-1, CT-2", { timeout: 90_000 }, async (t) => {
	let gate = null
	let memoryCalls = 0
	let inFlightFile
	const g = await startGateway(t, {
		// a high snapshot interval: LC-1's job must be found by the cancel's own scan, never by a lucky tree snapshot
		env: { RUNTIME_MAX_RUNNING: "8", RUNTIME_TREE_SNAPSHOT_MS: "60000" },
		knobs: { FAKE_OPENCODE_ATTACH_MAX_KB: 64, FAKE_OPENCODE_PERMISSION_WITHDRAW_MS: 150 },
		// the memory guard is the admission step a test can hold (CONC-3)
		memory: async () => {
			memoryCalls++
			if (gate) await gate.promise
			return null
		},
		seed: async (root, config) => {
			inFlightFile = path.join(root, "mcp-in-flight")
			await fs.writeFile(inFlightFile, "0")
			mcpWith(config, { FAKE_MCP_IN_FLIGHT_FILE: inFlightFile })
		},
	})
	const { broker } = g.app
	const calls = spyEngine(broker.engine)
	const prompts = (id) => calls.filter((c) => c.method === "prompt" && c.sessionId === id)
	const a = await g.client()
	const b = await g.client()
	const readyzMcp = async () => (await (await g.get("/readyz")).json()).components.mcp

	await t.test("CT-7: /session/info agent.capabilities is the gateway's whitelist (as in initialize), not the engine's raw capabilities", async () => {
		const res = await g.get("/session/info")
		assert.equal(res.status, 200)
		const caps = (await res.json()).agent.capabilities
		const init = await a.conn.initialize({ protocolVersion: 1, clientCapabilities: {} })
		assert.equal(caps.mcpCapabilities, undefined, "no client MCP servers")
		assert.deepEqual(Object.keys(caps.sessionCapabilities).sort(), ["list", "resume"], "no close/delete/fork")
		assert.equal(caps._meta?.["opencode/child-session-updates"], undefined)
		assert.equal(caps._meta.gateway, "geocluster-runtime")
		assert.equal(caps._meta.api, 3)
		assert.deepEqual(caps.sessionCapabilities, init.agentCapabilities.sessionCapabilities)
		assert.deepEqual(caps.promptCapabilities, init.agentCapabilities.promptCapabilities)
		assert.equal(caps.loadSession, init.agentCapabilities.loadSession)
	})

	await t.test("LC-5/CT-6: /readyz (and _gc/status right after it) report the MCP's current in_flight, not the value from its start", async () => {
		assert.equal((await readyzMcp()).inFlight, 0)
		await fs.writeFile(inFlightFile, "3")
		const mcp = await readyzMcp()
		assert.equal(mcp.state, "ready")
		assert.equal(mcp.inFlight, 3)
		assert.equal((await a.conn.extMethod("_gc/status", {})).mcp.inFlight, 3)
		await fs.writeFile(inFlightFile, "0")
		assert.equal((await readyzMcp()).inFlight, 0)
	})

	await t.test("CONC-2/CT-1: a specialist resumed in a later turn (rawInput.sessionID) names its resuming call from its first frame; a parallel fresh child keeps its own call", async () => {
		const X = await newChat(a)
		assert.equal((await a.conn.prompt(say(X, "delegate"))).stopReason, "end_turn")
		const s1 = noticesOf(a, "_gc/child_update").find((p) => p.sessionId === X && p.child.depth === 1).child.sessionId
		for (const [script, answer, children] of [
			[`resume ${s1}`, "resumed", 1],
			[`resumepar ${s1}`, "resumed 2", 2],
		]) {
			const n = a.notices.length
			const u = a.updates.length
			assert.equal((await a.conn.prompt(say(X, script))).stopReason, "end_turn")
			assert.equal(lastAnswer(a, X), answer)
			const updates = a.updates.slice(u).filter((x) => x.sessionId === X).map((x) => x.update)
			const resumeCall = updates.find((x) => x.rawInput?.sessionID === s1)?.toolCallId
			assert.ok(resumeCall, "the root's call names the resumed child in rawInput.sessionID")
			// the truth: each call's completion names its child (rawOutput.metadata.sessionID)
			const truth = new Map(updates.filter((x) => x.status === "completed" && x.rawOutput?.metadata?.sessionID).map((x) => [x.rawOutput.metadata.sessionID, x.toolCallId]))
			assert.equal(truth.size, children)
			assert.equal(truth.get(s1), resumeCall)
			const frames = noticesOf({ notices: a.notices.slice(n) }, "_gc/child_update").filter((p) => p.sessionId === X)
			const history = frames.map((f) => `${f.child.sessionId === s1 ? "S1" : "fresh"} ${f.status ?? f.update?.sessionUpdate}${f.relinked ? " (relinked)" : ""} → ${f.child.toolCallId}`).join("; ")
			const own = frames.filter((f) => f.child.sessionId === s1)
			assert.deepEqual(own.map((f) => f.status ?? f.update?.sessionUpdate), ["running", "agent_message_chunk", "completed"], `a resumed child: running without created (${history})`)
			assert.equal(own[0].child.title, "task for orchestrator", "it keeps its first title")
			for (const f of frames) assert.equal(f.child.toolCallId, truth.get(f.child.sessionId), `every frame names its own spawning call (${history})`)
			assert.ok(!frames.some((f) => f.relinked), `nothing left to correct at completion (${history})`)
		}
	})

	await t.test("CT-1 (same turn, run J): a child resumed in the turn that ran it moves to the resuming call without re-announcing its stale `completed`", async () => {
		const X = await newChat(a)
		const n = a.notices.length
		const u = a.updates.length
		assert.equal((await a.conn.prompt(say(X, "resumesame"))).stopReason, "end_turn")
		const updates = a.updates.slice(u).filter((x) => x.sessionId === X).map((x) => x.update)
		const resumeCall = updates.find((x) => x.rawInput?.sessionID)?.toolCallId
		const kid = updates.find((x) => x.rawInput?.sessionID)?.rawInput.sessionID
		assert.ok(resumeCall && kid)
		const frames = noticesOf({ notices: a.notices.slice(n) }, "_gc/child_update").filter((p) => p.sessionId === X && p.child.sessionId === kid)
		const history = frames.map((f) => `${f.status ?? f.update?.sessionUpdate}${f.relinked ? " (relinked)" : ""} → ${f.child.toolCallId}`).join("; ")
		const toResume = frames.filter((f) => f.child.toolCallId === resumeCall)
		assert.ok(toResume.length >= 3, history)
		assert.notEqual(toResume[0].status, "completed", `the resuming call's card first sees its specialist as completed (${history})`)
		assert.equal(toResume.at(-1).status, "completed", history)
	})

	await t.test("CONC-3: a cancel of a prompt still in its admission is kept although a duplicate and a second tab's prompt pass meanwhile: it never reaches the engine and ends cancelled", async () => {
		const X = await newChat(a)
		assert.equal((await a.conn.prompt(say(X, "echo zero", { submissionId: "c3-S0" }))).stopReason, "end_turn")
		gate = deferred()
		try {
			const base = memoryCalls
			const p1 = a.conn.prompt(say(X, "echo p1", { submissionId: "c3-S1" }))
			await until(() => memoryCalls === base + 1) // P1 is held in its admission (the memory guard)
			const dup = await b.conn.prompt(say(X, "echo zero", { submissionId: "c3-S0" }))
			assert.equal(dup._meta.duplicate, true, "a reconnecting tab resends an old submission")
			const p2 = b.conn.prompt(say(X, "echo p2", { submissionId: "c3-S2" })).then(
				(r) => ({ r }),
				(e) => ({ e }),
			)
			await until(() => memoryCalls === base + 2) // another tab's prompt waits too
			await a.conn.cancel({ sessionId: X, _meta: { submissionId: "c3-S1" } })
			await a.conn.extMethod("_gc/status", {}) // a round trip on the same socket: the cancel has been handled
			gate.resolve()
			gate = null
			const r1 = await within(p1, 10000, "P1")
			assert.equal(r1.stopReason, "cancelled", `P1 ran although its Stop came first: ${JSON.stringify(r1._meta)}`)
			assert.equal(r1._meta.reason, "cancelled")
			assert.equal(r1._meta.submissionId, "c3-S1")
			assert.ok(!prompts(X).some((c) => c.text === "echo p1"), "P1 never reached the engine")
			const { e } = await within(p2, 10000, "P2")
			assert.equal(e?.code, -32001, "the second tab's prompt found P1's turn")
			assert.ok(!(await g.readLog(X)).some((ev) => ev.kind === "update" && ev.update.content?.text === "p1"))
		} finally {
			gate?.resolve()
			gate = null
		}
	})

	await t.test("CONC-4: after the 'session not found' re-bind and retry, a turn the engine won't stop is still ended by the cancel watchdog (cancel_timeout)", async () => {
		const X = await newChat(a)
		const turn = a.conn.prompt(say(X, "lost deaf")) // the engine forgets the binding once, then the retried prompt ignores cancels
		await until(() => lastAnswer(a, X) === "not listening")
		assert.equal(prompts(X).length, 2, "prompt, session not found, prompt again")
		assert.ok(calls.some((c) => c.method === "resumeSession" && c.sessionId === X), "re-bound with session/resume")
		const cancelledAt = Date.now()
		await a.conn.cancel({ sessionId: X })
		const ended = await within(turn, 8000, "the deaf turn after the re-bind retry")
		const tookMs = Date.now() - cancelledAt
		assert.equal(ended.stopReason, "cancelled")
		assert.equal(ended._meta.reason, "cancel_timeout")
		assert.ok(tookMs >= 900 && tookMs < 5000, `ended after ${tookMs} ms (grace 1 s)`)
		assert.equal((await a.conn.prompt(say(X, "echo next"))).stopReason, "end_turn", "the conversation is free again")
	})

	await t.test("CT-8: a cancel that lands before RE-4's correction prompt ends the turn cancelled; the correction never reaches the engine; no report", async () => {
		await fs.mkdir(path.join(g.workspace, "report", "text"), { recursive: true })
		await fs.writeFile(path.join(g.workspace, "report", "text", "01_summary.md"), "summary")
		const R = await newChat(a, "report-analysis")
		const log = broker.logs.get(R)
		assert.ok(log, "the conversation's log is open")
		// Injected at the finding's window: the session/cancel arrives while the citation_check event is written
		const append = log.append.bind(log)
		log.append = (kind, data, opts) => {
			if (kind === "gateway" && data?.type === "citation_check" && data.attempt === 1) void broker.cancel({ sessionId: R })
			return append(kind, data, opts)
		}
		const script =
			"read report/text/01_summary.md | Grade 1.2 g/t [source: text/01_summary.md | p:1] and 5 holes [source: text/07_exploration.md | p:3]" +
			" || Grade 1.2 g/t [source: text/01_summary.md | p:1]"
		const ended = await a.conn.prompt(say(R, script))
		assert.equal(ended.stopReason, "cancelled", JSON.stringify(ended._meta))
		assert.equal(ended._meta.reason, "cancelled")
		assert.equal(ended._meta.report, undefined)
		assert.equal(prompts(R).length, 1, "the correction prompt never reached the engine")
		assert.ok(!prompts(R).some((c) => /^Citation check FAILED/.test(c.text ?? "")))
		assert.deepEqual(await fs.readdir(path.join(g.workspace, "runs", R, "_reports")).catch(() => []), [])
		assert.equal(a.turnEnds(R).at(-1).stopReason, "cancelled")
	})

	await t.test("CT-3: a cancel during the provider's retry backoff: turn_end._meta carries only gateway keys; a retry_cleared session_info_update precedes turn_end", async () => {
		const X = await newChat(a)
		const turn = a.conn.prompt(say(X, "retrywait"))
		await until(() => a.updates.some((u) => u.sessionId === X && u.update.sessionUpdate === "session_info_update" && u.update._meta?.["opencode/retry"]?.attempt === 2))
		await a.conn.cancel({ sessionId: X })
		const ended = await turn
		assert.equal(ended.stopReason, "cancelled")
		assert.equal(ended._meta.reason, "cancelled")
		await until(() => a.turnEnds(X).length === 1)
		const end = a.turnEnds(X)[0]
		for (const [what, meta] of [
			["prompt result", ended._meta],
			["_gc/turn_end", end._meta],
		]) {
			for (const key of Object.keys(meta)) assert.ok(TURN_END_KEYS.has(key), `${what}._meta.${key} is not gateway vocabulary`)
		}
		const isClear = (u) => u?.sessionUpdate === "session_info_update" && u._meta?.["opencode/retry"] === null && u._meta?.gateway === "retry_cleared"
		const stream = a.stream(X)
		const clearAt = stream.findIndex((e) => e.kind === "update" && isClear(e.update))
		const endAt = stream.findIndex((e) => e.kind === "_gc/turn_end")
		assert.ok(clearAt >= 0, "the gateway cleared the retry banner (the engine sends no null after a cancel)")
		assert.ok(clearAt < endAt, "before turn_end")
		const log = await g.readLog(X)
		assert.ok(log.findIndex((e) => e.kind === "update" && isClear(e.update)) < log.findIndex((e) => e.kind === "turn_end"), "in the log too (replays clear it)")
	})

	await t.test("TQ-5: the engine withdraws a pending permission itself ($/cancel_request) and fails the late answer with PermissionNotFoundError → cancelled/reason cancelled, no Error line", async () => {
		const c = await g.client({ permission: () => new Promise(() => {}) }) // nobody answers
		const X = await newChat(c)
		const ended = await within(c.conn.prompt(say(X, "ask")), 10000, "the withdrawn permission's turn")
		assert.equal(c.permissions.length, 1)
		assert.equal(ended.stopReason, "cancelled")
		assert.equal(ended._meta.reason, "cancelled")
		assert.equal(ended._meta.errorName, undefined)
		assert.equal(ended._meta.error, undefined)
		const resolved = noticesOf(c, "_gc/permission_resolved").find((p) => p.sessionId === X)
		assert.deepEqual([resolved?.by, resolved?.outcome?.outcome], ["engine", "cancelled"])
		const log = await g.readLog(X)
		assert.deepEqual(errorLines(log), [], "an engine-withdrawn permission is not an agent failure")
		assert.equal(log.find((e) => e.kind === "permission_response")?.by, "engine")
		assert.equal(broker.status().sessions.find((s) => s.sessionId === X)?.pendingPermissions?.length ?? 0, 0)
	})

	await t.test("SEC-1: a resource_link reaches the engine percent-encoded from its checked realpath: a literal %2e%2e folder stays inside; #, ? and %41 names attach their own file", async () => {
		const ws = await fs.realpath(g.workspace)
		await fs.writeFile(path.join(path.dirname(ws), "outside.txt"), "SECRET-OUTSIDE") // one level above the workspace
		await fs.mkdir(path.join(ws, "%2e%2e"), { recursive: true })
		const files = [
			["%2e%2e/outside.txt", "DECOY-INSIDE"],
			["Drill Hole #12.csv", "HASH-FILE"],
			["what?.txt", "QMARK-FILE"],
			["x%41.txt", "PERCENT-FILE"],
			["xA.txt", "OTHER-FILE"],
			["plain space é.txt", "SPACE-FILE"],
		]
		for (const [rel, body] of files) await fs.writeFile(path.join(ws, rel), body)
		const X = await newChat(a)
		for (const [rel, body] of files) {
			const file = path.join(ws, rel)
			// what a browser sends for that file: the literal folder double-encoded (%252e%252e)
			const uri = pathToFileURL(file).href
			const before = calls.length
			const r = await a.conn.prompt({ sessionId: X, prompt: [{ type: "text", text: "attached" }, { type: "resource_link", uri, name: path.basename(rel) }] })
			assert.equal(r.stopReason, "end_turn", `${rel}: ${JSON.stringify(r._meta)}`)
			assert.equal(lastAnswer(a, X), `${file}: ${body}`, `${rel}: the engine read another file`)
			const sent = calls.slice(before).find((c) => c.method === "prompt")?.prompt?.find((p) => p.type === "resource_link")
			assert.equal(sent?.uri, uri, `${rel}: forwarded as the percent-encoded realpath`)
		}
		// single-encoded, it is ".." for the gateway's own URL parser too: refused before the engine
		await assert.rejects(
			a.conn.prompt({ sessionId: X, prompt: [{ type: "text", text: "attached" }, { type: "resource_link", uri: `file://${ws}/%2e%2e/outside.txt`, name: "o" }] }),
			rpc(-32602),
		)
	})

	await t.test("SEC-3: a folder and a file over RUNTIME_ATTACH_MAX_KB are refused (-32602, naming the limit); an attachment the engine can't take gets an attachment-specific X-6 line", async () => {
		const ws = g.workspace
		await fs.mkdir(path.join(ws, "a-folder"), { recursive: true })
		await fs.writeFile(path.join(ws, "big.csv"), "x".repeat(600 * 1024))
		await fs.writeFile(path.join(ws, "medium.csv"), "y".repeat(100 * 1024))
		const X = await newChat(a)
		const link = (rel) => ({ sessionId: X, prompt: [{ type: "text", text: "attached" }, { type: "resource_link", uri: pathToFileURL(path.join(ws, rel)).href, name: rel }] })
		const before = prompts(X).length
		await assert.rejects(a.conn.prompt(link("a-folder")), (e) => e.code === -32602 && /a-folder is not a regular file/.test(e.message))
		await assert.rejects(
			a.conn.prompt(link("big.csv")),
			(e) => e.code === -32602 && /big\.csv is 600 KB, above the 512 KB attachment limit/.test(e.message) && /mention its path/.test(e.message) && e.data?.maxBytes === 512 * 1024,
		)
		assert.equal(prompts(X).length, before, "refused before the engine")
		// 100 KB passes the gateway's limit; the engine can't inline it (FAKE_OPENCODE_ATTACH_MAX_KB=64: ClientError,
		// as the real engine at ~10 MB), and its health probe passes
		const generation = broker.engine.generation
		const failed = await a.conn.prompt(link("medium.csv"))
		assert.equal(failed.stopReason, "cancelled")
		assert.equal(failed._meta.reason, "error")
		assert.equal(failed._meta.errorName, "attachment")
		const line = errorLines(await g.readLog(X)).at(-1) ?? ""
		assert.match(line, /could not take the attached file/)
		assert.match(line, /mention the file's path instead/)
		assert.doesNotMatch(line, /send the message again; if it keeps failing/, "not the generic advice: resending fails the same way")
		assert.equal(broker.engine.generation, generation, "nothing was restarted")
	})

	await t.test("LC-1: a job the agent backgrounded (re-parented away from the engine) is found by GEOCLUSTER_RUN_DIR and stopped by a cancel before turn_end", { skip: process.platform !== "linux" && "needs /proc" }, async (t2) => {
		const X = await newChat(a, "standard")
		assert.equal((await a.conn.prompt(say(X, "kiddetach"))).stopReason, "end_turn")
		const kid = Number(/^kid (\d+)$/.exec(lastAnswer(a, X) ?? "")?.[1])
		assert.ok(kid > 1, lastAnswer(a, X))
		t2.after(() => {
			try {
				process.kill(kid, "SIGKILL")
			} catch {
				// stopped by the gateway
			}
		})
		assert.ok(await running(kid))
		const stat = fsSync.readFileSync(`/proc/${kid}/stat`, "utf8")
		const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
		assert.notEqual(ppid, broker.engine.pid, "re-parented away from the engine")
		assert.ok(fsSync.readFileSync(`/proc/${kid}/environ`, "utf8").split("\0").includes(`GEOCLUSTER_RUN_DIR=runs/${X}`))
		assert.ok(await running(kid), "a turn that ends end_turn leaves it running")
		const turn = a.conn.prompt(say(X, "hang"))
		await until(() => lastAnswer(a, X) === "hanging")
		await a.conn.cancel({ sessionId: X })
		const ended = await turn
		assert.equal(ended.stopReason, "cancelled")
		assert.equal(await running(kid), false, "the detached job was stopped before turn_end")
		assert.equal(ended._meta.processesStopped, true)
	})

	await t.test("CT-2: an engine that dies under session/new, a prompt's lazy bind or set_config_option answers -32003 {state}, never its raw -32603; -32003 inside a turn ends it server_restart", async () => {
		const engine = broker.engine
		const X = await newChat(a)
		assert.equal((await a.conn.prompt(say(X, "echo bound"))).stopReason, "end_turn")
		const backUp = async (generation) => {
			await until(() => engine.state === "ready" && engine.generation > generation, 15000)
			engine.restarts = [] // every crash here gets the first (1 s) backoff, never "unavailable"
		}
		const cases = [
			["session/new", "die", () => a.conn.newSession({ cwd: "", mcpServers: [] })],
			["session/new", "serverdie", () => a.conn.newSession({ cwd: "", mcpServers: [] })],
			// X is unbound after the restarts above: the prompt's lazy bind (session/resume) is what dies
			["session/resume", "die", () => a.conn.prompt(say(X, "echo after the restart"))],
			["session/set_config_option", "serverdie", () => a.conn.unstable_setSessionModel({ sessionId: X, modelId: "proxy/z-ai/glm-5.3-flash" })],
		]
		const logLength = (await g.readLog(X)).length
		for (const [method, action, request] of cases) {
			const generation = engine.generation
			setTrap(g, { method, action })
			const outcome = await within(
				request().then(
					(r) => ({ r }),
					(e) => ({ e }),
				),
				15000,
				`${method} ${action}`,
			)
			const e = outcome.e
			assert.ok(e, `${method} ${action}: answered ${JSON.stringify(outcome.r)}`)
			assert.equal(e.code, -32003, `${method} ${action}: ${e.code} ${e.message} ${JSON.stringify(e.data)}`)
			assert.equal(typeof e.data?.state, "string")
			assert.notEqual(e.data.state, "ready")
			assert.equal(fsSync.existsSync(trapFile(g)), false, "the trap fired")
			await backUp(generation)
		}
		assert.equal((await g.readLog(X)).length, logLength, "the refused prompt left nothing in the log")

		// Inside a turn: the engine goes away between the bind and the prompt. Simulated as the review's R-B4 did (a
		// restart starts right before the broker's engine.prompt): the supervisor then refuses the call -32003
		const generation = engine.generation
		const prompt = engine.prompt
		let fired = false
		engine.prompt = (params) => {
			if (!fired && params.sessionId === X) {
				fired = true
				void engine.restart("test: the engine goes away before the prompt")
			}
			return prompt(params)
		}
		try {
			const ended = await within(a.conn.prompt(say(X, "echo never sent")), 15000, "the turn whose engine went away")
			assert.equal(ended.stopReason, "cancelled")
			assert.equal(ended._meta.reason, "server_restart", JSON.stringify(ended._meta))
			assert.match(errorLines(await g.readLog(X)).at(-1) ?? "", /agent engine stopped during this turn and is restarting/)
		} finally {
			engine.prompt = prompt
		}
		await backUp(generation)
		assert.equal((await a.conn.prompt(say(X, "echo back"))).stopReason, "end_turn")
	})

	await t.test("LC-5/CT-6: inFlight is null while the MCP is not ready (never a stale value from its last good /healthz)", async () => {
		await fs.writeFile(inFlightFile, "4")
		assert.equal((await readyzMcp()).inFlight, 4)
		const mcpPid = broker.mcp.pid
		process.kill(mcpPid, "SIGKILL")
		await until(() => broker.mcp.state !== "ready")
		const down = await readyzMcp()
		assert.notEqual(down.state, "ready")
		assert.equal(down.inFlight, null)
		assert.equal((await a.conn.extMethod("_gc/status", {})).mcp.inFlight, null)
		await until(() => broker.mcp.state === "ready" && broker.mcp.pid !== mcpPid, 15000)
		assert.equal((await readyzMcp()).inFlight, 4)
	})
})

// ---- engine child-observation compatibility ---------------------------------------------------------------------

test("child-observation: root and nested gaps retain source metadata through recording, fanout and root-cursor replay without ending running lifecycles", { timeout: 30_000 }, async (t) => {
	const g = await startGateway(t)
	const a = await g.client()
	const X = await newChat(a)
	const { broker } = g.app
	const { engine } = broker
	const turn = a.conn.prompt(say(X, "hang"))
	turn.catch(() => {})
	try {
		await until(() => turnOf(g, X) === "running" && lastAnswer(a, X) === "hanging")
		const cursor = a.stream(X).at(-1).seq
		const children = [
			{ sessionId: "ses_ObservationChild000000001", parentSessionId: X, depth: 1, title: "task for orchestrator", toolCallId: "call_observe_root" },
			{ sessionId: "ses_ObservationNested00000001", parentSessionId: "ses_ObservationChild000000001", depth: 2, title: "task for dataops", toolCallId: "ses_ObservationChild000000001:call_observe_nested" },
		]
		const source = []
		// The fake's existing metadata scripts have no observation gap. Inject the new engine frames at
		// its supervisor boundary, retaining the source projection independently of gateway output.
		const rootUpdate = (update) => {
			source.push({ kind: "update", sessionId: X, update: structuredClone(update) })
			engine.emit("update", { sessionId: X, update }, engine.generation)
		}
		const childFrame = (child, rest) => {
			source.push({ kind: "child", sessionId: X, child: structuredClone(child), ...structuredClone(rest) })
			engine.emit("child", { rootSessionId: X, childSessionId: child.sessionId, parentSessionId: child.parentSessionId, depth: child.depth, title: child.title, ...rest }, engine.generation)
		}
		const call = (child) => ({ sessionUpdate: "tool_call_update", toolCallId: child.toolCallId, kind: "think", title: "subagent", status: "in_progress", rawInput: { agent: child.depth === 1 ? "orchestrator" : "dataops", description: child.title } })
		rootUpdate(call(children[0]))
		for (const child of children) {
			if (child.depth === 2) childFrame(children[0], { type: "update", update: call(child) })
			childFrame(child, { type: "status", status: "created" })
			childFrame(child, { type: "status", status: "running" })
		}
		const gap = (toolCallId, childSessionId, child) => ({
			sessionUpdate: "session_info_update",
			_meta: {
				"geocluster/child-observation": { state: "incomplete", reason: "registration_failed", toolCallId, childSessionId },
				...(child ? { "opencode/child-session": { id: child.sessionId, parentID: child.parentSessionId, depth: child.depth, title: child.title } } : {}),
			},
		})
		rootUpdate(gap("call_gap_root", null))
		for (const child of children) childFrame(child, { type: "update", update: gap(`${child.sessionId}:call_gap`, "ses_Unobserved000000000000001", child) })
		await until(() => a.stream(X).filter((e) => e.seq > cursor).length >= source.length)

		// Remove only gateway transport fields; compare the entire update, including both custom and
		// pre-existing child identity metadata, rather than reconstructing a gap from its own output.
		const fromLog = ({ seq, ts, ...event }) => event
		const fromSocket = (event) => {
			if (event.kind === "update") {
				const { seq, replay, ...meta } = event.update._meta ?? {}
				const update = { ...event.update }
				if (Object.keys(meta).length) update._meta = meta
				else delete update._meta
				return { kind: "update", sessionId: event.sessionId, update }
			}
			const { seq, replay, ...params } = event.params
			return { kind: "child", ...params }
		}
		const live = a.stream(X).filter((e) => e.seq > cursor)
		const log = (await g.readLog(X)).filter((e) => e.seq > cursor)
		assert.deepEqual(live.map(fromSocket), source, "live root and child payloads equal the engine source")
		assert.deepEqual(log.map(fromLog), source, "recorded root and child payloads equal the engine source")
		const seqs = source.map((_, i) => cursor + i + 1)
		assert.deepEqual(live.map((e) => e.seq), seqs, "root and nested children share one contiguous root sequence")
		assert.deepEqual(log.map((e) => e.seq), seqs, "the same sequence is recorded in the root log")

		const b = await g.client()
		const attached = await b.conn.extMethod("_gc/attach", { sessionId: X, afterSeq: cursor })
		await until(() => b.stream(X).length >= source.length)
		const replayed = b.stream(X)
		assert.equal(attached.lastSeq, seqs.at(-1), "one root cursor includes all child frames")
		assert.equal(attached.truncated, false)
		assert.equal(attached.turn, "running", "observation incompleteness does not finish the root turn")
		assert.deepEqual(replayed.map((e) => e.seq), seqs, "afterSeq excludes earlier root frames without losing nested frames")
		assert.ok(replayed.every(isReplay), "every attached frame is marked as replay")
		assert.deepEqual(replayed.map(fromSocket), source, "replay retains exact source payloads and metadata")
		assert.equal(turnOf(g, X), "running")
		assert.equal(broker.convs.get(X).retrying, false, "an observation gap is not a provider retry")
		for (const child of children) {
			assert.equal(broker.convs.get(X).children.get(child.sessionId).status, "running", "gap updates do not change child lifecycle state")
			for (const client of [a, b]) {
				const statuses = noticesOf(client, "_gc/child_update").filter((p) => p.sessionId === X && p.child.sessionId === child.sessionId && p.type === "status")
				assert.deepEqual(statuses.map((p) => p.status), ["created", "running"], "no failed/completed status is invented for a gap")
				assert.equal(client.turnEnds(X).length, 0)
			}
		}

		// Only actual lifecycle frames may complete the children; both attached sockets receive them live.
		for (const child of [...children].reverse()) childFrame(child, { type: "status", status: "completed" })
		for (const client of [a, b]) {
			await until(() => noticesOf(client, "_gc/child_update").filter((p) => p.sessionId === X && p.status === "completed" && !p.replay).length === children.length)
			for (const child of children) {
				const frames = noticesOf(client, "_gc/child_update").filter((p) => p.sessionId === X && p.child.sessionId === child.sessionId && p.type === "status")
				assert.deepEqual(frames.map((p) => p.status), ["created", "running", "completed"])
				assert.equal(frames.at(-1).replay, undefined)
			}
		}
		assert.equal(turnOf(g, X), "running", "actual child completion does not finish the hanging root")
		assert.deepEqual((await g.readLog(X)).filter((e) => e.seq > cursor).map(fromLog), source, "actual terminal frames follow gaps in the same root log")
	} finally {
		await a.conn.cancel({ sessionId: X })
		const ended = await within(turn, 5000, "the observation fixture's stopped root turn")
		assert.equal(ended.stopReason, "cancelled")
		await until(() => turnOf(g, X) === "idle")
	}
})

// ---- LC-2 -------------------------------------------------------------------------------------------------------

test("LC-2: an MCP that crash-looped to 'unavailable' is tried again by the next prompt; once it is back the engine gets its tools", { timeout: 60_000 }, async (t) => {
	const healthy = [process.execPath, FAKE_MCP]
	const g = await startGateway(t, { start: false, seed: async (_root, config) => mcpWith(config, { FAKE_MCP_EXIT_AFTER_MS: 0 }) }) // every start crashes
	const { broker } = g.app
	broker.mcp.backoffMs = [50]
	broker.mcp.maxRestarts = 2
	// a socket that sees the machine-wide notices from the start (initialize waits for the engine: not awaited)
	const early = wsClient(g.port, g.secret)
	await early.opened
	t.after(() => early.close())
	void early.conn.initialize({ protocolVersion: 1, clientCapabilities: {} }).catch(() => {})
	const unavailable = new Promise((resolve) => broker.mcp.once("unavailable", resolve))
	await broker.start()
	await within(unavailable, 15000, "the MCP crash loop")
	assert.equal(broker.mcp.state, "unavailable")
	assert.equal(broker.engine.tools, "missing")
	await until(() => noticesOf(early, "_gc/notice").some((n) => /keep crashing/.test(n.message)))
	const down = (await (await g.get("/readyz")).json()).components.mcp
	assert.deepEqual([down.state, down.inFlight], ["unavailable", null])

	g.config.mcpArgs = healthy // the cause is gone
	const a = await g.client()
	const X = await newChat(a)
	const generation = broker.engine.generation
	assert.equal((await a.conn.prompt(say(X, "echo the tools?"))).stopReason, "end_turn")
	await until(() => broker.mcp.state === "ready", 10000)
	await until(() => noticesOf(early, "_gc/notice").some((n) => /MCP server\) are back/.test(n.message)))
	// the engine that started without the MCP is restarted for its tools once no turn runs
	await until(() => broker.engine.state === "ready" && broker.engine.generation === generation + 1 && broker.engine.tools === "connected", 15000)
	const ready = await (await g.get("/readyz")).json()
	assert.equal(ready.components.mcp.state, "ready")
	assert.equal(ready.components.engine.tools, "connected")
	assert.equal((await a.conn.prompt(say(X, "origin"))).stopReason, "end_turn")
	assert.equal(lastAnswer(a, X), "resume")
	const crashing = noticesOf(early, "_gc/notice").find((n) => /keep crashing/.test(n.message))
	assert.match(crashing.message, /tried again with the next message/, "the notice no longer says to restart the workspace")
})

// ---- LC-3 -------------------------------------------------------------------------------------------------------

test("LC-3: an engine restart for the tools waits for a prompt being admitted; a prompt that arrives during a restart waits for it instead of -32003 'stopping'", { timeout: 60_000 }, async (t) => {
	let gate = null
	let memoryCalls = 0
	const g = await startGateway(t, {
		start: false,
		knobs: { FAKE_OPENCODE_SIGTERM_EXIT_MS: 600 }, // a slow stop: the restart's "stopping" phase is long enough to land in
		memory: async () => {
			memoryCalls++
			if (gate) await gate.promise
			return null
		},
	})
	const { broker } = g.app
	await broker.engine.start() // the MCP is not started: the engine is ready without its tools
	assert.equal(broker.engine.tools, "missing")
	const a = await g.client()
	const X = await newChat(a)

	await t.test("the MCP comes back while a prompt waits in its admission: the tools restart waits for that turn, which runs in the engine it was admitted to", async () => {
		gate = deferred()
		try {
			const base = memoryCalls
			const p = a.conn.prompt(say(X, "origin")).then(
				(r) => ({ r }),
				(e) => ({ e }),
			)
			await until(() => memoryCalls === base + 1)
			await broker.mcp.start() // "ready" while the engine's tools are missing: a restart is wanted
			await until(() => broker.engine.state !== "ready" || broker.toolsRestart.wanted)
			gate.resolve()
			gate = null
			const { r, e } = await within(p, 15000, "the held prompt")
			assert.equal(e, undefined, `refused: ${e?.code} ${e?.message} ${JSON.stringify(e?.data)}`)
			assert.equal(r.stopReason, "end_turn")
			assert.equal(lastAnswer(a, X), "new", "it ran in the engine that created the conversation: the restart waited for it")
		} finally {
			gate?.resolve()
			gate = null
		}
		await until(() => broker.engine.state === "ready" && broker.engine.generation === 2 && broker.engine.tools === "connected", 15000)
	})

	await t.test("a prompt sent while the engine is stopping for a restart waits for the new engine", async () => {
		const generation = broker.engine.generation
		// the same supervisor call a tools restart makes
		const restart = broker.engine.restart("test: a restart for the tools")
		await until(() => broker.engine.state === "stopping")
		const r = await within(a.conn.prompt(say(X, "origin")), 15000, "the prompt sent during the restart")
		assert.equal(r.stopReason, "end_turn")
		assert.equal(lastAnswer(a, X), "resume")
		assert.equal(broker.engine.generation, generation + 1)
		await restart
	})
})

test("LC-3: an engine whose tools reconnected by themselves is not restarted ('mcp connected' clears the wanted restart)", { timeout: 60_000 }, async (t) => {
	const g = await startGateway(t, { start: false })
	const { broker } = g.app
	await broker.engine.start() // without the MCP: tools missing
	assert.equal(broker.engine.tools, "missing")
	const a = await g.client()
	const X = await newChat(a)
	const Y = await newChat(a)
	const hang = a.conn.prompt(say(X, "hang"))
	await until(() => lastAnswer(a, X) === "hanging")
	await broker.mcp.start() // MCP ready: a tools restart is wanted, and waits for X's turn
	assert.ok(broker.toolsRestart.wanted, "precondition: a restart is wanted")
	assert.equal(broker.engine.generation, 1, "not under a running turn")
	assert.equal((await a.conn.prompt(say(Y, "mcpreconnect"))).stopReason, "end_turn") // the engine re-initialized its MCP
	await until(() => broker.engine.tools === "connected")
	await a.conn.cancel({ sessionId: X })
	assert.equal((await hang).stopReason, "cancelled")
	assert.equal((await a.conn.prompt(say(Y, "origin"))).stopReason, "end_turn")
	assert.equal(lastAnswer(a, Y), "new", "Y is still bound to the engine that created it: no restart")
	assert.equal(broker.engine.generation, 1)
	assert.equal(broker.engine.tools, "connected")
})

test("LC-3: a model change waiting for an engine that comes back from a crash without its tools is not woken into the tools restart its 'ready' starts", { timeout: 60_000 }, async (t) => {
	const g = await startGateway(t)
	const { broker } = g.app
	const a = await g.client()
	const X = await newChat(a)
	// the next engine fails to connect the (healthy) MCP: its "ready" wants a tools restart at once (nothing is running)
	g.setKnobs({ FAKE_OPENCODE_MCP_FAIL: 1, FAKE_OPENCODE_MCP_DELAY_MS: 300 })
	process.kill(broker.engine.pid, "SIGKILL")
	await until(() => broker.engine.state !== "ready")
	const r = await within(
		a.conn.unstable_setSessionModel({ sessionId: X, modelId: "proxy/z-ai/glm-5.3-flash" }).then(
			() => "ok",
			(e) => e,
		),
		20000,
		"the model change",
	)
	assert.equal(r, "ok", `refused: ${r?.code} ${r?.message} ${JSON.stringify(r?.data)}`)
})

// ---- LC-4 -------------------------------------------------------------------------------------------------------

test("LC-4: shutdown with a running turn and an MCP tool call in flight takes well under Fly's 5 s; prompt and session/new meanwhile → -32003 'stopping'", { timeout: 60_000 }, async (t) => {
	const g = await startGateway(t, {
		env: { RUNTIME_MCP_DRAIN_MS: "3000" }, // production's drain
		seed: async (root, config) => {
			const inFlight = path.join(root, "mcp-in-flight")
			await fs.writeFile(inFlight, "2") // a tool call nobody can receive once the engine is gone
			mcpWith(config, { FAKE_MCP_IN_FLIGHT_FILE: inFlight })
		},
	})
	const { broker } = g.app
	const a = await g.client()
	const X = await newChat(a)
	const Y = await newChat(a)
	const hang = a.conn.prompt(say(X, "hang"))
	await until(() => lastAnswer(a, X) === "hanging")
	const pids = { engine: broker.engine.pid, server: g.engineMeta().serverPid, mcp: broker.mcp.pid }

	const startedAt = Date.now()
	const stopping = g.app.shutdown()
	const late = await within(
		Promise.allSettled([a.conn.prompt(say(Y, "echo too late")), a.conn.newSession({ cwd: "", mcpServers: [] })]),
		10000,
		"requests sent during the shutdown",
	)
	await stopping
	const tookMs = Date.now() - startedAt
	assert.ok(tookMs < 2000, `shutdown took ${tookMs} ms (the MCP drain and the exporter ran one after another)`)
	for (const [what, r] of [
		["prompt", late[0]],
		["session/new", late[1]],
	]) {
		assert.equal(r.status, "rejected", `${what} was admitted during the shutdown`)
		assert.equal(r.reason.code, -32003, `${what}: ${r.reason.message}`)
		assert.equal(r.reason.data?.state, "stopping")
	}
	// The turn's end is checked through _gc/turn_end and the log; its prompt response is checked by the LC-4/CONC-1 test below
	hang.catch(() => {})
	await until(() => a.turnEnds(X).length === 1)
	assert.equal(a.turnEnds(X)[0].stopReason, "cancelled")
	for (const [name, pid] of Object.entries(pids)) assert.equal(await running(pid), false, `${name} (${pid}) still running`)
	assert.equal(broker.mcp.state, "stopped")
	assert.equal((await g.readLog(X)).at(-1).kind, "turn_end")
	assert.ok(!(await g.readLog(Y).catch(() => [])).some((e) => e.kind === "update"), "nothing ran for the late prompt")
})

test("LC-4/CONC-1: a turn the shutdown cancels still gets its prompt response before the sockets close, even when the index save after turn_end is slow", { timeout: 60_000 }, async (t) => {
	const g = await startGateway(t)
	const { broker } = g.app
	const a = await g.client()
	const X = await newChat(a)
	const hang = a.conn.prompt(say(X, "hang"))
	hang.catch(() => {})
	await until(() => lastAnswer(a, X) === "hanging")
	// the index save #endTurn awaits after the fan-out is one queue for every conversation: slow on a busy disk
	const touch = broker.index.touch.bind(broker.index)
	broker.index.touch = async (...args) => {
		await new Promise((resolve) => setTimeout(resolve, 500))
		return touch(...args)
	}
	await g.app.shutdown()
	await until(() => a.turnEnds(X).length === 1)
	const ended = await within(hang, 3000, "the cancelled turn's prompt response")
	assert.equal(ended.stopReason, "cancelled")
})

// ---- CT-4 / CT-5 ------------------------------------------------------------------------------------------------

test("CT-4/CT-5: after a gateway restart, a turn without usage keeps the stored context; a conversation the engine lost is listed with its own fields and refused as lost", { timeout: 60_000 }, async (t) => {
	const root = await newRoot()
	const gA = await startGateway(t, { root })
	const a = await gA.client()
	const listed = async (c) => new Map((await c.conn.unstable_listSessions({})).sessions.map((s) => [s.sessionId, s._meta]))
	const X = await newChat(a)
	assert.equal((await a.conn.prompt(say(X, "echo context"))).stopReason, "end_turn")
	const Z = await newChat(a, "standard")
	await a.conn.unstable_setSessionModel({ sessionId: Z, modelId: "proxy/z-ai/glm-5.3-flash" })
	assert.equal((await a.conn.prompt(say(Z, "echo the engine will lose this"))).stopReason, "end_turn")
	const before = await listed(a)
	assert.deepEqual([before.get(X).contextUsed, before.get(X).contextSize], [15, 200000])
	assert.deepEqual([before.get(Z).modelId, before.get(Z).contextUsed, before.get(Z).contextSize], ["proxy/z-ai/glm-5.3-flash", 15, 200000])
	await gA.app.shutdown()
	// The engine's database loses Z (reset outside the gateway)
	const store = await readJson(engineStoreFile(gA.config))
	delete store[Z]
	await fs.writeFile(engineStoreFile(gA.config), JSON.stringify(store))

	const gB = await startGateway(t, { root })
	const b = await gB.client()

	await t.test("CT-4: a hang + cancel turn (no usage_update) leaves contextUsed/contextSize as stored", async () => {
		const turn = b.conn.prompt(say(X, "hang"))
		await until(() => lastAnswer(b, X) === "hanging")
		await b.conn.cancel({ sessionId: X })
		assert.equal((await turn).stopReason, "cancelled")
		assert.ok(!b.updates.some((u) => u.sessionId === X && u.update.sessionUpdate === "usage_update"), "precondition: no usage_update since the restart")
		const meta = (await listed(b)).get(X)
		assert.deepEqual([meta.contextUsed, meta.contextSize], [15, 200000])
	})

	await t.test("CT-5: the lost conversation: -32006 'no longer has this conversation' with data.lost; listed with its own model and context, private supplier amounts, _meta.lost", async () => {
		const lost = (e) => e?.code === -32006 && /no longer has this conversation/.test(e.message) && !/previous agent engine/.test(e.message) && e.data?.lost === true
		await assert.rejects(b.conn.prompt(say(Z, "echo still there?")), lost)
		await assert.rejects(b.conn.prompt(say(Z, "echo still there?")), lost, "the same answer once archived")
		await assert.rejects(b.conn.unstable_setSessionModel({ sessionId: Z, modelId: "proxy/openai/gpt-6-luna" }), lost)
		const meta = (await listed(b)).get(Z)
		assert.equal(meta.archived, true)
		assert.equal(meta.lost, true)
		assert.equal(meta.modelId, "proxy/z-ai/glm-5.3-flash")
		assert.deepEqual([meta.contextUsed, meta.contextSize], [15, 200000])
		assert.deepEqual([meta.tokensIn, meta.tokensOut], [null, null], "unknown, not the Cline-era 0")
		assert.ok(!Object.hasOwn(meta, "totalCost"), "Lost conversation lists conceal supplier amounts")
		assert.equal((await listed(b)).get(X).lost, undefined)
	})
})
