import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { ActivityReporter } from "../lib/activity.js"
import { aggregateActivity, RootActivityReporter } from "../lib/root-activity.js"
import { startGateway } from "./gateway-harness.mjs"
import { gateCheck } from "../server.js"

const log = { warn() {} }
const snapshot = (state, interests = []) => ({ state, session_id: null, observedAt: new Date().toISOString(), interests })

test("non-ASCII spoofed control headers are rejected without throwing", () => {
	assert.equal(gateCheck("root-control", "é".repeat(12)), false)
})

test("aggregate precedence: chat ending cannot idle processing; unknown never confirms idle", () => {
	assert.equal(aggregateActivity([snapshot("idle"), snapshot("prompt_running")]).state, "prompt_running")
	assert.equal(aggregateActivity([snapshot("permission_pending"), snapshot("prompt_running")]).state, "permission_pending")
	assert.equal(aggregateActivity([snapshot("idle"), null]).state, "prompt_running")
	assert.equal(aggregateActivity([snapshot("idle"), snapshot("idle")]).state, "idle")
	assert.equal(aggregateActivity([snapshot("idle"), { state: "idle", checkedAt: new Date().toISOString(), expiredJobs: ["capped-job"] }]).state, "idle")
})

test("interest expiry stops keepalive, is reported explicitly, and new work gets its own cap", () => {
	const old = { id: "old", startedAt: new Date(1000).toISOString(), state: "prompt_running" }
	const expired = aggregateActivity([snapshot("idle"), snapshot("prompt_running", [old])], { now: 5000, maxInterestMs: 2000 })
	assert.equal(expired.state, "idle")
	assert.equal(expired.expired[0].reason, "activity_keepalive_expired")
	assert.equal(expired.expired[0].expiredAt, new Date(3000).toISOString())
	assert.equal(aggregateActivity([snapshot("prompt_running", [old, { ...old, id: "new", startedAt: new Date(4500).toISOString() }])], { now: 5000, maxInterestMs: 2000 }).state, "prompt_running")
	assert.equal(aggregateActivity([snapshot("prompt_running", [old])], { now: 5000, maxInterestMs: 0 }).state, "prompt_running")
})

test("aggregate gateway retains private tracking but never sends externally", async () => {
	const calls = []
	const reporter = new ActivityReporter({ aggregateActivity: true, activityUrl: "http://receiver", activityToken: "secret", activityIntervalMs: 5, maxTurnMs: 100 }, log, async (...args) => { calls.push(args); return { ok: true } })
	reporter.start("chat")
	assert.equal(reporter.snapshot().state, "prompt_running")
	assert.deepEqual(reporter.snapshot().agent, { state: "working", turn_completed_at: null })
	reporter.setState("chat", "permission_pending")
	assert.equal(reporter.snapshot().state, "permission_pending")
	assert.deepEqual(reporter.snapshot().agent, { state: "needs_input", turn_completed_at: null })
	reporter.stop("chat", { completed: true })
	assert.equal(reporter.snapshot().state, "idle")
	assert.equal(reporter.snapshot().agent.state, "idle")
	assert.ok(Number.isFinite(Date.parse(reporter.snapshot().agent.turn_completed_at)))
	assert.deepEqual(calls, [])
})

test("root aggregation retains aged chat until turn end while processing interests expire", (t) => {
	const calls = [], notices = []
	const reporter = new ActivityReporter({ aggregateActivity: true, activityUrl: "http://receiver", activityToken: "secret", activityIntervalMs: 60000, maxTurnMs: 100 }, log, async (...args) => { calls.push(args); return { ok: true } })
	t.after(() => reporter.close())
	reporter.onAgeNotice = (id) => notices.push(id)
	reporter.start("chat")
	const startedAt = reporter.turns.get("chat").startedAt, now = startedAt + 5000
	const processing = { state: "prompt_running", observedAt: new Date(now).toISOString(), interests: [{ id: "processing", state: "prompt_running", startedAt: new Date(startedAt).toISOString() }] }
	const active = aggregateActivity([reporter.snapshot(now), processing], { now, maxInterestMs: 2000 })
	assert.equal(active.state, "prompt_running")
	assert.equal(active.session_id, "chat")
	assert.deepEqual(active.expired.map((interest) => interest.id), ["processing"])
	reporter.setState("chat", "permission_pending")
	assert.equal(aggregateActivity([reporter.snapshot(now + 1), processing], { now: now + 1, maxInterestMs: 2000 }).state, "permission_pending")
	assert.deepEqual(notices, ["chat"])
	reporter.stop("chat")
	assert.equal(aggregateActivity([reporter.snapshot(now + 2), processing], { now: now + 2, maxInterestMs: 2000 }).state, "idle")
	assert.deepEqual(calls, [])
})

test("root reporter serializes jittered polls and sends only the external wire shape", async () => {
	let concurrent = 0, peak = 0
	const sent = []
	const root = new RootActivityReporter({ url: "http://receiver", token: "root-secret", sources: [async () => {
		peak = Math.max(peak, ++concurrent)
		await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 6)))
		concurrent--
		return { ...snapshot("prompt_running"), agent: { state: "working", turn_completed_at: null, prompt: "private" } }
	}], storageDir: os.tmpdir(), storageIntervalMs: 60000, fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true } }, logger: log })
	await Promise.all(Array.from({ length: 100 }, () => root.tick()))
	assert.equal(peak, 1)
	assert.equal(sent.length, 1)
	const { storage, ...rest } = sent[0]
	assert.deepEqual(rest, { state: "prompt_running", session_id: null, agent: { state: "working", turn_completed_at: null } })
	assert.deepEqual(Object.keys(storage).sort(), ["measured_at", "total_bytes", "used_bytes"])
	assert.ok(storage.total_bytes >= storage.used_bytes && storage.used_bytes > 0)
	await root.close()
})

test("root reports disk usage on its own interval while idle, until close", async (t) => {
	const sent = []
	const root = new RootActivityReporter({ url: "http://receiver", token: "root-secret", storageDir: os.tmpdir(), storageIntervalMs: 20,
		sources: [async () => ({ ...snapshot("idle"), agent: { state: "idle", turn_completed_at: null } })],
		fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true } }, logger: log,
	})
	t.after(() => root.close())
	root.start()
	const end = Date.now() + 2000
	while (sent.length < 3) { assert.ok(Date.now() < end, `only ${sent.length} reports`); await new Promise((r) => setTimeout(r, 10)) }
	assert.ok(sent.every((body) => body.state === "idle" && body.agent.state === "idle" && body.storage.total_bytes > 0))
	await root.close()
	const count = sent.length
	await new Promise((r) => setTimeout(r, 60))
	assert.equal(sent.length, count, "close stops the reports")
})

test("an idle root still reports a newly completed turn; an unreadable volume leaves storage out", async () => {
	const sent = []
	let agent = { state: "idle", turn_completed_at: null }
	const root = new RootActivityReporter({ url: "http://receiver", token: "root-secret", storageDir: path.join(os.tmpdir(), `no-volume-${process.pid}`), storageIntervalMs: 60000,
		sources: [async () => ({ ...snapshot("idle"), agent })],
		fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true } }, logger: log,
	})
	await root.tick()
	agent = { state: "idle", turn_completed_at: "2026-10-15T01:02:03.000Z" }
	await root.tick()
	await root.tick()
	assert.deepEqual(sent, [
		{ state: "idle", session_id: null, agent: { state: "idle", turn_completed_at: null } },
		{ state: "idle", session_id: null, agent: { state: "idle", turn_completed_at: "2026-10-15T01:02:03.000Z" } },
	])
	await root.close()
})

test("root reports a change in the agent's state well before its next interval", async (t) => {
	const sent = []
	let gateway = { ...snapshot("prompt_running", [{ id: "chat", state: "prompt_running", startedAt: new Date().toISOString() }]), agent: { state: "working", turn_completed_at: null } }
	const read = async () => ({ ...gateway, observedAt: new Date().toISOString() })
	const root = new RootActivityReporter({ url: "http://receiver", token: "root-secret", intervalMs: 60000, agentSource: read, agentPollMs: 10,
		sources: [read, async () => snapshot("idle")],
		fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true } }, logger: log,
	})
	t.after(() => root.close())
	root.start()
	const seen = async (check) => {
		const end = Date.now() + 1000
		while (!sent.some(check)) { assert.ok(Date.now() < end, `not reported: ${JSON.stringify(sent.map((body) => body.agent))}`); await new Promise((r) => setTimeout(r, 5)) }
	}
	await seen((body) => body.agent.state === "working")
	gateway = { ...gateway, state: "permission_pending", interests: [{ ...gateway.interests[0], state: "permission_pending" }], agent: { state: "needs_input", turn_completed_at: null } }
	await seen((body) => body.state === "permission_pending" && body.agent.state === "needs_input")
	gateway = { ...snapshot("idle"), agent: { state: "idle", turn_completed_at: "2026-10-15T01:02:03.000Z" } }
	await seen((body) => body.state === "idle" && body.agent.turn_completed_at === "2026-10-15T01:02:03.000Z")
})

test("a zero storage interval leaves disk usage out of every report", async () => {
	const sent = []
	const root = new RootActivityReporter({ url: "http://receiver", token: "root-secret", storageDir: os.tmpdir(), storageIntervalMs: 0,
		sources: [async () => ({ ...snapshot("prompt_running"), agent: { state: "working", turn_completed_at: null } })],
		fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true } }, logger: log,
	})
	await root.tick()
	assert.equal(sent.length, 1)
	assert.equal("storage" in sent[0], false)
	await root.close()
})

test("an expired outage withdraws keepalive without falsely reporting idle; recovery accepts new interest", async () => {
	const sent = [], snapshots = []
	let source = null
	const root = new RootActivityReporter({ url: "http://receiver", token: "root-secret", maxInterestMs: 5,
		sources: [async () => { if (!source) throw new Error("offline"); return source }],
		fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true } }, logger: log,
		onSnapshot: async (s) => { snapshots.push(s) },
	})
	await root.tick()
	await new Promise((r) => setTimeout(r, 10))
	await root.tick()
	assert.deepEqual(sent.map((s) => s.state), ["prompt_running"])
	assert.equal(snapshots[1].expired[0].reason, "activity_keepalive_expired")
	source = snapshot("idle")
	await root.tick()
	source = snapshot("prompt_running", [{ id: "fresh", state: "prompt_running", startedAt: new Date().toISOString() }])
	await root.tick()
	assert.deepEqual(sent.map((s) => s.state), ["prompt_running", "idle", "prompt_running"])
	await root.close()
})

test("gateway private snapshot requires independent control credential even with gate access", async (t) => {
	const g = await startGateway(t, { start: false, seed: (_root, config) => { config.runtimeControlSecret = "root-control"; config.aggregateActivity = true } })
	const url = `http://127.0.0.1:${g.port}/internal/runtime/activity`
	assert.equal((await fetch(url, { headers: { "x-gc-gate": g.secret } })).status, 403)
	const response = await fetch(url, { headers: { "x-gc-runtime-control": "root-control" } })
	assert.equal(response.status, 200)
	assert.equal((await response.json()).state, "idle")
	g.app.activity.start("private-chat")
	assert.equal((await (await fetch(url, { headers: { "x-gc-runtime-control": "root-control" } })).json()).state, "prompt_running")
	g.app.activity.stop("private-chat")
	assert.deepEqual(g.activityCalls, [])
})
