import assert from "node:assert/strict"
import { test } from "node:test"
import { ActivityReporter } from "../lib/activity.js"
import { RootActivityReporter } from "../lib/root-activity.js"

const log = { warn() {} }
const gateway = (state, agentState) => ({ state, session_id: "chat", observedAt: new Date().toISOString(), agent: { state: agentState, turn_completed_at: null } })

test("pending activity posts preserve each permission transition and completed turn in order", async (t) => {
	const sent = []
	let release
	const blocked = new Promise((resolve) => { release = resolve })
	let concurrent = 0, peak = 0
	const reporter = new ActivityReporter({ activityUrl: "http://receiver", activityToken: "secret", activityIntervalMs: 60000 }, log, async (_url, options) => {
		peak = Math.max(peak, ++concurrent)
		sent.push(JSON.parse(options.body))
		if (sent.length === 1) await blocked
		await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 4)))
		concurrent--
		return { ok: true }
	})
	t.after(() => { release(); reporter.close() })
	reporter.start("chat")
	for (let i = 0; i < 50; i++) {
		reporter.setState("chat", "permission_pending")
		reporter.setState("chat", "prompt_running")
	}
	reporter.stop("chat", { completed: true })
	const completedAt = reporter.agent.turn_completed_at
	release()
	await reporter.sending
	assert.equal(peak, 1, "activity POSTs must not overlap")
	assert.deepEqual(sent, [
		{ state: "prompt_running", session_id: "chat", agent: { state: "working", turn_completed_at: null } },
		...Array.from({ length: 50 }, () => [
			{ state: "permission_pending", session_id: "chat", agent: { state: "needs_input", turn_completed_at: null } },
			{ state: "prompt_running", session_id: "chat", agent: { state: "working", turn_completed_at: null } },
		]).flat(),
		{ state: "idle", session_id: "chat", agent: { state: "idle", turn_completed_at: completedAt } },
	])
})

test("the fast agent watcher retries a transition after the aggregate gateway read fails", async (t) => {
	const sent = []
	let current = gateway("prompt_running", "working"), failRead = false
	const root = new RootActivityReporter({ url: "http://receiver", token: "secret", logger: log,
		agentSource: async () => current,
		sources: [async () => { if (failRead) throw new Error("gateway unavailable"); return current }],
		fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true } },
	})
	t.after(() => root.close())
	await root.watchAgent()
	current = gateway("permission_pending", "needs_input")
	failRead = true
	await root.watchAgent()
	assert.equal(sent.at(-1).agent.state, "working", "an outage must not invent an agent state")
	failRead = false
	await root.watchAgent()
	assert.equal(sent.at(-1).state, "permission_pending")
	assert.equal(sent.at(-1).agent.state, "needs_input")
	const count = sent.length
	await root.watchAgent()
	assert.equal(sent.length, count, "a delivered transition does not trigger another full poll")
})

for (const failure of ["rejected", "throws"]) test(`queued activity transitions continue after a POST ${failure}`, async (t) => {
	const sent = []
	let release
	const blocked = new Promise((resolve) => { release = resolve })
	const reporter = new ActivityReporter({ activityUrl: "http://receiver", activityToken: "secret", activityIntervalMs: 60000 }, log, async (_url, options) => {
		sent.push(JSON.parse(options.body))
		if (sent.length === 1) {
			await blocked
			if (failure === "throws") throw new Error("offline")
			return { ok: false, status: 503 }
		}
		return { ok: true }
	})
	t.after(() => { release(); reporter.close() })
	reporter.start("chat")
	reporter.setState("chat", "permission_pending")
	reporter.stop("chat")
	release()
	await reporter.sending
	assert.deepEqual(sent.map((body) => body.agent.state), ["working", "needs_input", "idle"])
})

for (const failure of ["rejected", "throws"]) test(`the fast agent watcher retries a transition after its POST ${failure}`, async (t) => {
	const delivered = []
	let current = gateway("prompt_running", "working"), reject = false
	const root = new RootActivityReporter({ url: "http://receiver", token: "secret", logger: log,
		agentSource: async () => current, sources: [async () => current],
		fetchImpl: async (_url, options) => {
			if (reject && failure === "throws") throw new Error("offline")
			if (!reject) delivered.push(JSON.parse(options.body))
			return { ok: !reject, status: reject ? 503 : 200 }
		},
	})
	t.after(() => root.close())
	await root.watchAgent()
	current = gateway("permission_pending", "needs_input")
	reject = true
	await root.watchAgent()
	reject = false
	await root.watchAgent()
	assert.deepEqual(delivered.map((body) => body.agent.state), ["working", "needs_input"])
})

test("the watcher acknowledges the gateway state actually read, independently of processing activity", async (t) => {
	const sent = []
	let current = gateway("idle", "idle"), aggregateRead = current
	const root = new RootActivityReporter({ url: "http://receiver", token: "secret", logger: log,
		agentSource: async () => current,
		sources: [async () => aggregateRead, async () => ({ state: "prompt_running", observedAt: new Date().toISOString() })],
		fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true } },
	})
	t.after(() => root.close())
	await root.watchAgent()
	current = gateway("permission_pending", "needs_input")
	await root.watchAgent()
	assert.equal(sent.at(-1).agent.state, "idle", "the aggregate read has not observed the change yet")
	aggregateRead = current
	await root.watchAgent()
	assert.equal(sent.at(-1).agent.state, "needs_input")
	current = aggregateRead = gateway("idle", "idle")
	await root.watchAgent()
	assert.equal(sent.at(-1).state, "prompt_running", "ongoing processing keeps the machine active")
	assert.equal(sent.at(-1).agent.state, "idle", "processing does not hide an agent transition")
	const count = sent.length
	await root.watchAgent()
	assert.equal(sent.length, count)
})
