/**
 * Test-quality gaps of the Step 4.3 contract review (s43/review.json TQ-1..TQ-4), end to end through the WebSocket
 * against the fake engine (test/fake-opencode.mjs) and the fake shared MCP.
 *
 * Each area guards a broker rule that a mutation of lib/session-broker.js used to slip past the whole default suite:
 *   TQ-1  bind once per engine generation (mutants B1, B7) and the lost-binding retry (mutant B4);
 *   TQ-2  a cancel that arrives while a prompt is still being admitted (mutants E1, E2, and S4 for the stale variant);
 *   TQ-3  API-06 with frames flowing while replays start (mutant R2: queue flushed without the seq filter) and two
 *         concurrent _gc/attach of one conversation on one socket (mutant R3: no wait for the earlier replay);
 *   TQ-4  RE-4 broker wiring: the read ledger rebuilt from the SessionLog (F3), D3 (F4) and D1 child reads (F5).
 *
 * Where the fake has no script for a frame, the frame is injected through the supervisor's own events
 * (`engine.emit("update" | "child", params, engine.generation)`, exactly what engine-stream.js delivers), as
 * gateway-recovery.test.mjs does, and the test says so.
 *
 *   node --test test/gateway-quality.test.mjs
 */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { after, test } from "node:test"
import { say, startGateway, tmpdir, until, untilAsync, wait } from "./gateway-harness.mjs"

// ---- helpers -------------------------------------------------------------------------------------------------

/** Volumes shared by two gateways (a gateway restart) are removed after everything. */
const roots = []
after(async () => {
	for (const root of roots) await fs.rm(root, { recursive: true, force: true })
})

/** The log kinds a socket sees (with their seq); permission, model and gateway events are logged only. */
const FANNED = new Set(["update", "child", "turn_end"])
const fannedSeqs = (log) => log.filter((e) => FANNED.has(e.kind)).map((e) => e.seq)
const isReplay = (e) => (e.kind === "update" ? e.update?._meta?.replay === true : e.params?.replay === true)
const chunk = (text) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
const newChat = async (c, agentMode = "geology") => (await c.conn.newSession({ cwd: "/x", mcpServers: [], _meta: { agentMode } })).sessionId
const noticesOf = (c, method) => c.notices.filter((n) => n.method === method).map((n) => n.params)
const citationNotices = (c, id, from = 0) => c.notices.slice(from).filter((n) => n.method === "_gc/notice" && n.params.sessionId === id && n.params.kind === "citation_check").map((n) => n.params)
const turnOf = (g, id) => g.app.broker.status().sessions.find((s) => s.sessionId === id)?.turn ?? "idle"
const boundOf = (g, id) => g.app.broker.status().sessions.find((s) => s.sessionId === id)?.bound === true

/** `promise`, or a failure naming what never settled (a stuck gateway must fail the test, not hang the file). */
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

/**
 * Record every call the broker forwards to the engine. Every broker → engine request goes through these supervisor
 * methods (only the supervisor's own warm-up and health probe don't), so counts are exact.
 */
function spyEngine(engine) {
	const calls = []
	for (const method of ["newSession", "setMode", "setConfigOption", "resumeSession", "closeSession", "deleteSession", "listSessions", "prompt", "cancel"]) {
		const original = engine[method].bind(engine)
		engine[method] = (...args) => {
			calls.push({ method, sessionId: typeof args[0] === "string" ? args[0] : (args[0]?.sessionId ?? null), generation: engine.generation })
			return original(...args)
		}
	}
	const count = (method, sessionId) => calls.filter((c) => c.method === method && c.sessionId === sessionId).length
	return { calls, count }
}

/** The broker's log lines (its logger is a plain object; the harness's sink is silent). */
function captureBrokerLog(g) {
	const lines = []
	const logger = g.app.broker.logger
	for (const level of ["info", "warn", "error"]) {
		const original = logger[level]
		logger[level] = (message, extra) => {
			lines.push({ level, message, extra })
			return original(message, extra)
		}
	}
	return lines
}

/** Pump one engine frame per millisecond into a conversation (an engine streaming a long answer). */
function pumpFrames(engine, sessionId, label = "p") {
	let stopped = false
	let n = 0
	const done = (async () => {
		while (!stopped) {
			engine.emit("update", { sessionId, update: chunk(`${label}${n++} `) }, engine.generation)
			await wait(1)
		}
	})()
	return {
		count: () => n,
		stop: async () => {
			stopped = true
			await done
		},
	}
}

/**
 * The frames one socket got for a conversation, checked against the API-06 protocol: every replay is one contiguous
 * run [afterSeq+1 .. lastSeq] of its own attach, in request order; a frame outside the replays is live, strictly newer
 * than every live frame before it and than every replay before it. Returns the runs.
 */
function assertReplayProtocol(frames, attaches, label) {
	const runs = []
	let run = null
	let liveMax = 0
	frames.forEach((f, i) => {
		if (isReplay(f)) {
			if (run && f.seq === run.last + 1) run.last = f.seq
			else {
				run = { first: f.seq, last: f.seq, at: i }
				runs.push(run)
			}
			return
		}
		run = null
		const replayedUpTo = Math.max(0, ...runs.map((r) => r.last))
		const around = frames.slice(Math.max(0, i - 4), i + 3).map((e) => `${e.seq}${isReplay(e) ? "r" : ""}`).join(",")
		assert.ok(f.seq > liveMax, `${label}: live seq ${f.seq} after live seq ${liveMax} (frame #${i}; around: ${around})`)
		assert.ok(f.seq > replayedUpTo, `${label}: live seq ${f.seq} was already replayed (up to ${replayedUpTo}) (frame #${i}; around: ${around})`)
		liveMax = f.seq
	})
	const describe = (list) => list.map(([a, b]) => `${a}..${b}`).join(" ")
	const got = runs.map((r) => [r.first, r.last])
	const want = attaches.filter((a) => a.lastSeq > a.afterSeq).map((a) => [a.afterSeq + 1, a.lastSeq])
	assert.deepEqual(got, want, `${label}: replay runs ${describe(got)} (expected ${describe(want)}): two replays overlapped or one was cut`)
	return runs
}

/** What a client that drops every frame with seq ≤ the highest it has seen ends up with. */
const dedupByMax = (seqs) => {
	let max = 0
	return seqs.filter((s) => (s > max ? ((max = s), true) : false))
}

// ---- TQ-1: bind once per engine generation; the lost-binding retry ------------------------------------------------

test("TQ-1 bind once per engine generation: prompts, load, resume, set_config_option add no session/resume; exactly one after each engine restart", { timeout: 60_000 }, async (t) => {
	const g = await startGateway(t)
	const engine = g.app.broker.engine
	const spy = spyEngine(engine)
	const a = await g.client()
	const b = await g.client()
	const X = await newChat(a)
	const Y = await newChat(a)
	const resumes = (id) => spy.count("resumeSession", id)
	/** Every browser call that binds a conversation (or used to), on the socket's own conversation X. */
	const everyUse = async (label) => {
		assert.equal((await a.conn.prompt(say(X, `echo ${label} one`))).stopReason, "end_turn")
		await b.conn.loadSession({ sessionId: X, cwd: "/x", mcpServers: [] })
		await b.conn.unstable_resumeSession({ sessionId: X, cwd: "/x", mcpServers: [] })
		await a.conn.unstable_setSessionModel({ sessionId: X, modelId: "proxy/z-ai/glm-5.3-flash" })
		await a.conn.unstable_setSessionConfigOption({ sessionId: X, configId: "effort", value: "high" })
		await b.conn.extMethod("_gc/attach", { sessionId: X, afterSeq: 0 })
		assert.equal((await a.conn.prompt(say(X, `echo ${label} two`))).stopReason, "end_turn")
	}

	await t.test("generation 1: session/new bound it; nothing the browser does sends session/resume", async () => {
		await everyUse("gen1")
		assert.equal(resumes(X), 0, "a conversation created in this generation is already bound")
		assert.equal((await a.conn.prompt(say(X, "origin"))).stopReason, "end_turn")
		assert.equal(a.text(X).endsWith("new"), true, "the engine still has the binding session/new made")
		assert.ok(boundOf(g, X))
	})

	await t.test("engine restart → generation 2: the first prompt resumes once; every later call on that generation adds none", async () => {
		const generation = engine.generation
		await engine.restart("test: generation 2")
		assert.equal(engine.generation, generation + 1)
		assert.ok(!boundOf(g, X), "unbound after the restart")
		assert.equal((await a.conn.prompt(say(X, "origin"))).stopReason, "end_turn")
		assert.equal(resumes(X), 1)
		assert.ok(a.text(X).endsWith("resume"), "bound with session/resume (never session/load)")
		await everyUse("gen2")
		assert.equal(resumes(X), 1, "one session/resume per generation")
		assert.equal(resumes(Y), 0, "an unused conversation is not resumed")
	})

	await t.test("engine restart → generation 3: session/load is the first use; it resumes once, the rest adds none", async () => {
		await engine.restart("test: generation 3")
		await b.conn.loadSession({ sessionId: X, cwd: "/x", mcpServers: [] })
		assert.equal(resumes(X), 2)
		assert.ok(boundOf(g, X))
		await everyUse("gen3")
		assert.equal((await a.conn.prompt(say(X, "origin"))).stopReason, "end_turn")
		assert.ok(a.text(X).endsWith("resume"))
		assert.equal(resumes(X), 2)
		// the other conversation: its own single resume, on its first use in this generation
		assert.equal((await a.conn.prompt(say(Y, "echo y"))).stopReason, "end_turn")
		assert.equal((await a.conn.prompt(say(Y, "echo y again"))).stopReason, "end_turn")
		assert.equal(resumes(Y), 1)
		const resumed = spy.calls.filter((c) => c.method === "resumeSession").map((c) => `${c.sessionId === X ? "X" : "Y"}@${c.generation}`)
		assert.deepEqual(resumed, [`X@${engine.generation - 1}`, `X@${engine.generation}`, `Y@${engine.generation}`], "one resume per conversation per generation")
	})
})

test("TQ-1 lost binding: the engine closed the session behind the broker's back → one session/resume, the prompt is retried once and ends end_turn", { timeout: 60_000 }, async (t) => {
	const g = await startGateway(t)
	const engine = g.app.broker.engine
	const spy = spyEngine(engine)
	const log = captureBrokerLog(g)
	const a = await g.client()
	const X = await newChat(a)
	assert.equal((await a.conn.prompt(say(X, "echo first"))).stopReason, "end_turn")
	const resumes = spy.count("resumeSession", X)
	const prompts = spy.count("prompt", X)
	const generation = engine.generation
	// The broker still thinks X is bound in this generation; the engine no longer has the binding
	await engine.closeSession(X)

	const turn = await a.conn.prompt(say(X, "echo again"))
	assert.equal(turn.stopReason, "end_turn", JSON.stringify(turn))
	assert.equal(engine.generation, generation, "no engine restart involved")
	assert.equal(spy.count("resumeSession", X), resumes + 1, "exactly one extra session/resume")
	assert.equal(spy.count("prompt", X), prompts + 2, "the prompt that met 'session not found', then its one retry")
	assert.ok(
		log.some((l) => l.level === "warn" && l.message === "engine lost the binding; resuming and retrying" && l.extra?.sessionId === X),
		`the retry is logged: ${JSON.stringify(log.filter((l) => l.level !== "info"))}`,
	)
	assert.ok(a.text(X).endsWith("again"))
	const events = await g.readLog(X)
	assert.ok(!events.some((e) => e.kind === "update" && e.update._meta?.gateway === "error"), "no Error: line in the transcript")
	assert.equal(events.filter((e) => e.kind === "update" && e.update.sessionUpdate === "user_message_chunk").length, 2, "the retry is not echoed twice")
	assert.equal(a.turnEnds(X).length, 2)
	assert.equal(a.turnEnds(X)[1].stopReason, "end_turn")
	// still a live conversation (not archived as lost), bound again: the next prompt resumes nothing
	const listed = (await a.conn.unstable_listSessions({})).sessions.find((s) => s.sessionId === X)
	assert.equal(listed._meta.archived, false)
	assert.equal((await a.conn.prompt(say(X, "echo third"))).stopReason, "end_turn")
	assert.equal(spy.count("resumeSession", X), resumes + 1)
	assert.equal(spy.count("prompt", X), prompts + 3)
})

// ---- TQ-2: early cancel (cancel during admission) -------------------------------------------------------------------

/**
 * Hold the next session/resume of `id` until the broker has received a session/cancel for it. The real engine's
 * first bind after a start takes ~0.7 s; the fake answers in a few ms, so without the hold the cancel could land
 * after the bind and the "no engine prompt" check would race. Returns what the conversation looked like when the
 * cancel arrived.
 */
function holdBindUntilCancel(g, id) {
	const broker = g.app.broker
	const engine = broker.engine
	const resume = engine.resumeSession
	let release
	const cancelled = new Promise((resolve) => (release = resolve))
	const seen = { at: null, turn: null, admitting: null }
	broker.cancel = (params) => {
		const result = Object.getPrototypeOf(broker).cancel.call(broker, params)
		if (params?.sessionId === id && seen.at === null) {
			const conv = broker.convs.get(id)
			// prompts still being admitted: a Set since CONC-3 (one object or null before it)
			const admitting = conv?.admitting instanceof Set ? conv.admitting.size : conv?.admitting ? 1 : 0
			Object.assign(seen, { at: Date.now(), turn: conv?.turn ?? null, admitting })
			release()
		}
		return result
	}
	engine.resumeSession = async (sessionId) => {
		if (sessionId === id) await within(cancelled, 5000, "the session/cancel sent with the prompt").catch(() => {})
		return resume(sessionId)
	}
	const restore = () => {
		delete broker.cancel
		engine.resumeSession = resume
	}
	return { seen, restore }
}

test("TQ-2 early cancel: a cancel sent with its prompt while the prompt waits for the lazy bind ends that turn cancelled, without the engine", { timeout: 60_000 }, async (t) => {
	const g = await startGateway(t)
	const engine = g.app.broker.engine
	const spy = spyEngine(engine)
	const a = await g.client()
	const X = await newChat(a)
	assert.equal((await a.conn.prompt(say(X, "echo one"))).stopReason, "end_turn")

	const unbind = async () => {
		await engine.restart("test: unbind")
		assert.ok(!boundOf(g, X))
	}

	await t.test("prompt 'slow 3000' + cancel in the same tick → cancelled/reason cancelled well under the script time; no engine prompt", async () => {
		await unbind()
		const hold = holdBindUntilCancel(g, X)
		const prompts = spy.count("prompt", X)
		const ends = a.turnEnds(X).length
		const started = Date.now()
		try {
			const turn = a.conn.prompt(say(X, "slow 3000"))
			await a.conn.cancel({ sessionId: X })
			const done = await within(turn, 10000, "the early-cancelled prompt")
			const elapsed = Date.now() - started
			assert.equal(hold.seen.turn, "idle", "the cancel arrived while the prompt was being admitted")
			assert.equal(hold.seen.admitting, 1, "the prompt was registered as being admitted")
			assert.equal(done.stopReason, "cancelled", JSON.stringify(done))
			assert.equal(done._meta.reason, "cancelled")
			assert.ok(elapsed < 2500, `ended after ${elapsed} ms: the engine ran the turn`)
			assert.equal(spy.count("prompt", X), prompts, "the engine never saw the prompt")
		} finally {
			hold.restore()
		}
		await until(() => a.turnEnds(X).length === ends + 1)
		assert.equal(a.turnEnds(X).at(-1).stopReason, "cancelled")
		assert.equal(a.turnEnds(X).at(-1)._meta.reason, "cancelled")
		assert.equal(turnOf(g, X), "idle")
		// the conversation goes on normally (the cancel was consumed by that turn)
		assert.equal((await a.conn.prompt(say(X, "echo after"))).stopReason, "end_turn")
		assert.ok(a.text(X).endsWith("after"))
	})

	await t.test("the cancel names this prompt's submissionId → cancelled without the engine", async () => {
		await unbind()
		const hold = holdBindUntilCancel(g, X)
		const prompts = spy.count("prompt", X)
		try {
			const turn = a.conn.prompt(say(X, "slow 3000", { submissionId: "early-1" }))
			await a.conn.cancel({ sessionId: X, _meta: { submissionId: "early-1" } })
			const done = await within(turn, 10000, "the early-cancelled prompt")
			assert.equal(hold.seen.turn, "idle")
			assert.equal(done.stopReason, "cancelled")
			assert.equal(done._meta.reason, "cancelled")
			assert.equal(done._meta.submissionId, "early-1")
			assert.equal(spy.count("prompt", X), prompts)
		} finally {
			hold.restore()
		}
	})

	await t.test("variant: the cancel names a stale submissionId → ignored; the admitted prompt runs to end_turn", async () => {
		await unbind()
		const hold = holdBindUntilCancel(g, X)
		const prompts = spy.count("prompt", X)
		try {
			const turn = a.conn.prompt(say(X, "slow 300", { submissionId: "early-3" }))
			await a.conn.cancel({ sessionId: X, _meta: { submissionId: "early-1" } })
			const done = await within(turn, 10000, "the prompt with a stale cancel")
			assert.equal(hold.seen.turn, "idle", "the stale cancel arrived during the admission")
			assert.equal(done.stopReason, "end_turn", `a cancel naming an older submission stopped this one: ${JSON.stringify(done)}`)
			assert.equal(done._meta.submissionId, "early-3")
			assert.equal(spy.count("prompt", X), prompts + 1)
			assert.ok(a.text(X).endsWith("part 1part 2"))
		} finally {
			hold.restore()
		}
	})
})

// ---- TQ-3: API-06 while frames flow ----------------------------------------------------------------------------------

test("TQ-3 API-06: sockets attach and load while engine frames stream (and while an append is in flight): every seq exactly once, in order", { timeout: 90_000 }, async (t) => {
	// The harness pings every 200 ms; a client in a process this busy can miss a pong and be dropped
	const g = await startGateway(t, { env: { RUNTIME_WS_PING_MS: "60000" } })
	const engine = g.app.broker.engine
	const a = await g.client()
	const X = await newChat(a)
	const turn = a.conn.prompt(say(X, "hang"))
	await until(() => a.text(X) === "hanging")
	const log = g.app.broker.logs.get(X)
	// Every replay starts with one engine frame whose append is queued AHEAD of the replay's snapshot and fanned out
	// while the socket is being replayed: it is in the replay (seq ≤ lastSeq) and in the live queue. Only the
	// queue's seq filter keeps it from arriving twice. (Injected through the supervisor's event, like the pump.)
	const replay = log.replay.bind(log)
	let inFlight = 0
	log.replay = async (afterSeq, onEvent) => {
		engine.emit("update", { sessionId: X, update: chunk(`inflight${inFlight++} `) }, engine.generation)
		await new Promise((resolve) => setImmediate(resolve))
		return replay(afterSeq, onEvent)
	}
	const clients = []
	for (let i = 0; i < 9; i++) clients.push(await g.client())
	const pump = pumpFrames(engine, X)
	const sockets = []
	try {
		// Staggered while frames flow, without waiting for the earlier replays: they overlap each other and the stream
		const pending = []
		for (const [i, s] of clients.entries()) {
			const from = log.lastSeq
			await until(() => log.lastSeq >= from + 20, 10000)
			const mid = Math.floor(log.lastSeq / 2)
			const how = ["attach", "attach-mid", "load"][i % 3]
			const afterSeq = how === "attach-mid" ? mid : 0
			const call =
				how === "load"
					? s.conn.loadSession({ sessionId: X, cwd: "/x", mcpServers: [] }).then((r) => r._meta.lastSeq)
					: s.conn.extMethod("_gc/attach", { sessionId: X, afterSeq }).then((r) => r.lastSeq)
			pending.push(call.then((lastSeq) => sockets.push({ s, how, afterSeq, lastSeq })))
		}
		await within(Promise.all(pending), 30000, "the attaches and loads")
		const settled = log.lastSeq
		await until(() => log.lastSeq >= settled + 20, 10000) // live frames after the last replay too
	} finally {
		await pump.stop()
		delete log.replay
	}
	await a.conn.cancel({ sessionId: X })
	assert.equal((await within(turn, 10000, "the cancelled turn")).stopReason, "cancelled")
	for (const { s } of sockets) await until(() => s.turnEnds(X).length === 1, 10000)

	const expected = fannedSeqs(await g.readLog(X))
	assert.ok(pump.count() > 150, `only ${pump.count()} frames pumped`)
	assert.equal(inFlight, sockets.length)
	for (const [i, { s, how, afterSeq, lastSeq }] of sockets.entries()) {
		const label = `socket ${i} (${how} afterSeq=${afterSeq} lastSeq=${lastSeq})`
		const got = s.stream(X)
		const seqs = got.map((e) => e.seq)
		const dups = seqs.filter((seq, k) => seqs.indexOf(seq) !== k)
		assert.deepEqual(dups, [], `${label}: duplicates`)
		assert.deepEqual(seqs, expected.filter((seq) => seq > afterSeq), `${label}: every seq after afterSeq exactly once, in log order`)
		assertReplayProtocol(got, [{ afterSeq, lastSeq }], label)
		assert.ok(got.some((e) => !isReplay(e)), `${label}: live frames followed the replay`)
	}
	// the live socket saw its own stream in order, without replay
	const own = a.stream(X).map((e) => e.seq)
	assert.deepEqual(own, expected)
})

test("TQ-3 API-06: two concurrent _gc/attach of one conversation on ONE socket while frames flow: the second replay waits for the first; every seq once, in order", { timeout: 90_000 }, async (t) => {
	const g = await startGateway(t, { env: { RUNTIME_WS_PING_MS: "60000" } })
	const engine = g.app.broker.engine
	const a = await g.client()
	const X = await newChat(a)
	const turn = a.conn.prompt(say(X, "hang"))
	await until(() => a.text(X) === "hanging")
	const log = g.app.broker.logs.get(X)
	const pump = pumpFrames(engine, X)
	const s1 = await g.client()
	const s2 = await g.client()
	const checks = []
	try {
		await until(() => log.lastSeq >= 600, 15000) // long enough that a full replay streams for a while

		// s1: a full attach and a partial one, same tick (a reconnecting tab that attaches twice)
		const K = Math.floor(log.lastSeq / 2)
		const [full, partial] = await within(
			Promise.all([s1.conn.extMethod("_gc/attach", { sessionId: X, afterSeq: 0 }), s1.conn.extMethod("_gc/attach", { sessionId: X, afterSeq: K })]),
			20000,
			"s1's two attaches",
		)
		checks.push({
			s: s1,
			label: `s1: attach afterSeq=0 (lastSeq ${full.lastSeq}) + attach afterSeq=${K} (lastSeq ${partial.lastSeq})`,
			attaches: [
				{ afterSeq: 0, lastSeq: full.lastSeq },
				{ afterSeq: K, lastSeq: partial.lastSeq },
			],
		})

		// s2: a short attach, then a full one in the same tick. The engine produces a frame while the full replay is
		// streaming, after the short attach has answered: it belongs after the full replay, never inside it. (Hooked
		// into the full replay so the frame lands mid-replay every run; the frame itself goes through the supervisor.)
		const short = log.lastSeq - 3
		let shortAnswered
		const shortDone = new Promise((resolve) => (shortAnswered = resolve))
		const replay = log.replay.bind(log)
		let hooked = false
		log.replay = (afterSeq, onEvent) => {
			if (afterSeq !== 0 || hooked) return replay(afterSeq, onEvent)
			hooked = true
			let n = 0
			return replay(afterSeq, async (event) => {
				await onEvent(event)
				if (++n !== 10) return
				await within(shortDone, 10000, "the short attach's answer")
				engine.emit("update", { sessionId: X, update: chunk("mid-replay ") }, engine.generation)
				await until(() => a.text(X).includes("mid-replay"))
			})
		}
		const p1 = s2.conn.extMethod("_gc/attach", { sessionId: X, afterSeq: short })
		const p2 = s2.conn.extMethod("_gc/attach", { sessionId: X, afterSeq: 0 })
		p1.then(shortAnswered, shortAnswered)
		const [first, second] = await within(Promise.all([p1, p2]), 20000, "s2's two attaches")
		delete log.replay
		assert.ok(hooked, "the full replay ran through the hook")
		checks.push({
			s: s2,
			label: `s2: attach afterSeq=${short} (lastSeq ${first.lastSeq}) + attach afterSeq=0 (lastSeq ${second.lastSeq})`,
			attaches: [
				{ afterSeq: short, lastSeq: first.lastSeq },
				{ afterSeq: 0, lastSeq: second.lastSeq },
			],
		})
		const settled = log.lastSeq
		await until(() => log.lastSeq >= settled + 25, 10000)
	} finally {
		await pump.stop()
		delete log.replay
	}
	await a.conn.cancel({ sessionId: X })
	assert.equal((await within(turn, 10000, "the cancelled turn")).stopReason, "cancelled")
	for (const { s } of checks) await until(() => s.turnEnds(X).length === 1, 10000)

	const expected = fannedSeqs(await g.readLog(X))
	for (const { s, label, attaches } of checks) {
		const got = s.stream(X)
		assert.ok(attaches[1].lastSeq >= attaches[0].lastSeq, `${label}: the second replay started after the first`)
		assertReplayProtocol(got, attaches, label)
		const live = got.filter((e) => !isReplay(e)).map((e) => e.seq)
		assert.deepEqual(
			live.filter((seq, i) => live.indexOf(seq) !== i),
			[],
			`${label}: a live frame arrived twice`,
		)
		const lowest = Math.min(...attaches.map((x) => x.afterSeq))
		assert.deepEqual([...new Set(got.map((e) => e.seq))].sort((p, q) => p - q), expected.filter((seq) => seq > lowest), `${label}: no frame lost`)
		// a client that drops every seq it has already passed: its view starts where its first attach did
		assert.deepEqual(dedupByMax(got.map((e) => e.seq)), expected.filter((seq) => seq > attaches[0].afterSeq), `${label}: a client keeping only newer seqs sees every frame once, in order`)
	}
})

// ---- TQ-4: RE-4 broker wiring -----------------------------------------------------------------------------------------

/** report/text files the scripted reads and citations refer to. */
async function writeReport(workspace) {
	const dir = path.join(workspace, "report", "text")
	await fs.mkdir(dir, { recursive: true })
	for (const name of ["01_summary.md", "02_geology.md", "03_resources.md"]) await fs.writeFile(path.join(dir, name), `${name}\n`)
}

const reportFiles = async (g, id) => (await fs.readdir(path.join(g.workspace, "runs", id, "_reports")).catch(() => [])).filter((f) => f.endsWith(".md")).sort()

/**
 * A specialist's `read` of `file`, as the engine reports it on the root's stream (opencode/session/child_update,
 * measured shape: pending without a path, in_progress with rawInput.path, completed without kind/title/rawInput).
 * Injected through the supervisor's own "child" event: the fake has no script where a specialist reads a file.
 */
function childRead(engine, rootId, { childId, parentId, depth, title, file }) {
	const head = { rootSessionId: rootId, childSessionId: childId, parentSessionId: parentId, depth, title }
	const emit = (rest) => engine.emit("child", { ...head, ...rest }, engine.generation)
	const meta = { "opencode/child-session": { id: childId, parentID: parentId, depth, title } }
	const toolCallId = `${childId}:call_read_${depth}`
	const call = { toolCallId, kind: "read", title: `${title}: read` }
	emit({ type: "status", status: "created" })
	emit({ type: "status", status: "running" })
	emit({ type: "update", update: { sessionUpdate: "tool_call", ...call, status: "pending", locations: [], rawInput: {}, _meta: meta } })
	emit({ type: "update", update: { sessionUpdate: "tool_call_update", ...call, status: "in_progress", locations: [{ path: file }], rawInput: { path: file }, _meta: meta } })
	emit({
		type: "update",
		update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: `Read file ${file}` } }], rawOutput: { metadata: { truncated: false } }, _meta: meta },
	})
	emit({ type: "status", status: "completed" })
}

const KID1 = "ses_QualKidDepthOne0000000001"
const KID2 = "ses_QualKidDepthTwo0000000002"

/** The next user prompt of `rootId`: its specialists' reads arrive while the engine runs it (before its end_turn). */
function withSpecialistReads(engine, rootId, reads) {
	const own = Object.hasOwn(engine, "prompt") // a spy's wrapper, or the supervisor's own method
	const prompt = engine.prompt
	engine.prompt = (params) => {
		if (params?.sessionId !== rootId || /^Citation check FAILED/.test(params.prompt?.[0]?.text ?? "")) return prompt.call(engine, params)
		if (own) engine.prompt = prompt
		else delete engine.prompt
		const call = prompt.call(engine, params)
		for (const read of reads) childRead(engine, rootId, read)
		return call
	}
}

const depth1 = (rootId, file) => ({ childId: KID1, parentId: rootId, depth: 1, title: "task for orchestrator", file })
const depth2 = (_rootId, file) => ({ childId: KID2, parentId: KID1, depth: 2, title: "task for dataops", file })

test("TQ-4 RE-4 wiring: earlier turns' reads count; still fabricated after the correction → warning, citationFailed, no report (D3); depth-1 child reads count, depth-2 don't (D1)", { timeout: 60_000 }, async (t) => {
	const g = await startGateway(t)
	await writeReport(g.workspace)
	const engine = g.app.broker.engine
	const spy = spyEngine(engine)
	const a = await g.client()
	const X = await newChat(a, "report-analysis")

	await t.test("turn 1 reads, turn 2 cites without reading → no correction (ledger rebuilt from the log), report exported", async () => {
		assert.equal((await a.conn.prompt(say(X, "read report/text/01_summary.md | noted"))).stopReason, "end_turn")
		const from = a.notices.length
		const prompts = spy.count("prompt", X)
		const turn = await a.conn.prompt(say(X, "read | Grade 1.2 g/t [source: text/01_summary.md | p:1] || corrected"))
		assert.equal(turn.stopReason, "end_turn")
		assert.deepEqual(citationNotices(a, X, from), [], "a file read in turn 1 must count in turn 2")
		assert.equal(spy.count("prompt", X), prompts + 1, "no correction prompt")
		assert.equal(turn._meta.citationFailed, undefined)
		assert.ok(turn._meta.report, "the answer is exported")
		assert.equal(await fs.readFile(path.join(g.workspace, turn._meta.report), "utf8"), "Grade 1.2 g/t [source: text/01_summary.md | p:1]")
	})

	await t.test("D3: a turn that fabricates twice → info then warning notice, _meta.citationFailed, no _meta.report, no file in _reports", async () => {
		const from = a.notices.length
		const reports = await reportFiles(g, X)
		const prompts = spy.count("prompt", X)
		const turn = await a.conn.prompt(say(X, "read | X [source: text/09_made_up.md | p:1] || still X [source: text/09_made_up.md | p:1]"))
		assert.equal(turn.stopReason, "end_turn")
		assert.equal(spy.count("prompt", X), prompts + 2, "one correction prompt, no more")
		const notices = citationNotices(a, X, from)
		assert.deepEqual(
			notices.map((n) => [n.level, n.flagged]),
			[
				["info", ["text/09_made_up.md"]],
				["warning", ["text/09_made_up.md"]],
			],
		)
		assert.deepEqual(turn._meta.citationFailed, ["text/09_made_up.md"])
		assert.equal(turn._meta.report, undefined, "D3: a still-fabricated answer is not exported")
		await until(() => a.turnEnds(X).length === 3)
		const end = a.turnEnds(X)[2]
		assert.deepEqual(end._meta.citationFailed, ["text/09_made_up.md"])
		assert.equal(end._meta.report, undefined)
		assert.deepEqual(await reportFiles(g, X), reports, "no report file written")
		const events = await g.readLog(X)
		assert.deepEqual(
			events.filter((e) => e.kind === "gateway" && e.type === "citation_check").map((e) => e.attempt),
			[1, 2],
		)
	})

	await t.test("D1: a depth-1 specialist's read (live child frames during the turn) is cited by the root → no correction", async () => {
		const from = a.notices.length
		const prompts = spy.count("prompt", X)
		withSpecialistReads(engine, X, [depth1(X, "report/text/02_geology.md")])
		const turn = await a.conn.prompt(say(X, "read | Host rock [source: text/02_geology.md | p:4] || corrected"))
		assert.equal(turn.stopReason, "end_turn")
		assert.deepEqual(citationNotices(a, X, from), [], "the orchestrator's read counts for its root (D1)")
		assert.equal(spy.count("prompt", X), prompts + 1)
		assert.ok(turn._meta.report)
		const frames = noticesOf(a, "_gc/child_update").filter((f) => f.child.sessionId === KID1 && f.type === "update")
		assert.equal(frames.length, 3, "the injected frames reached the browser")
	})

	await t.test("D1: a depth-2 specialist's read does NOT count → one correction, the corrected answer exported", async () => {
		const from = a.notices.length
		const prompts = spy.count("prompt", X)
		withSpecialistReads(engine, X, [depth2(X, "report/text/03_resources.md")])
		const turn = await a.conn.prompt(say(X, "read | 12 Mt [source: text/03_resources.md | p:9] || 12 Mt [not found in report]"))
		assert.equal(turn.stopReason, "end_turn")
		assert.deepEqual(
			citationNotices(a, X, from).map((n) => [n.level, n.flagged]),
			[["info", ["text/03_resources.md"]]],
		)
		assert.equal(spy.count("prompt", X), prompts + 2)
		assert.equal(turn._meta.citationFailed, undefined)
		assert.equal(await fs.readFile(path.join(g.workspace, turn._meta.report), "utf8"), "12 Mt [not found in report]")
	})
})

test("TQ-4 RE-4 after a gateway restart: the ledger is rebuilt from the SessionLog (root and depth-1 reads count, depth-2 don't)", { timeout: 60_000 }, async (t) => {
	const root = await tmpdir("gw-quality-")
	roots.push(root)
	const gA = await startGateway(t, { root })
	await writeReport(gA.workspace)
	const a = await gA.client()
	const X = await newChat(a, "report-analysis")
	withSpecialistReads(gA.app.broker.engine, X, [depth1(X, "report/text/02_geology.md"), depth2(X, "report/text/03_resources.md")])
	assert.equal((await a.conn.prompt(say(X, "read report/text/01_summary.md | noted"))).stopReason, "end_turn")
	const logged = await gA.readLog(X)
	assert.equal(logged.filter((e) => e.kind === "child" && e.type === "update").length, 6, "the specialists' reads are in the log")
	await gA.app.shutdown()

	const gB = await startGateway(t, { root })
	const spy = spyEngine(gB.app.broker.engine)
	const b = await gB.client()
	await untilAsync(async () => gB.app.broker.engine.state === "ready", 10000)

	const from = b.notices.length
	const turn = await b.conn.prompt(say(X, "read | Grade [source: text/01_summary.md | p:1]; host rock [source: text/02_geology.md | p:4] || corrected"))
	assert.equal(turn.stopReason, "end_turn")
	assert.deepEqual(citationNotices(b, X, from), [], "reads from before the gateway restart count (root and depth 1)")
	assert.equal(spy.count("prompt", X), 1, "no correction prompt")
	assert.ok(turn._meta.report)

	const from2 = b.notices.length
	const again = await b.conn.prompt(say(X, "read | 12 Mt [source: text/03_resources.md | p:9] || 12 Mt [not found in report]"))
	assert.equal(again.stopReason, "end_turn")
	assert.deepEqual(
		citationNotices(b, X, from2).map((n) => n.flagged),
		[["text/03_resources.md"]],
		"a depth-2 read stays out of the rebuilt ledger",
	)
	assert.equal(spy.count("prompt", X), 3)
})
