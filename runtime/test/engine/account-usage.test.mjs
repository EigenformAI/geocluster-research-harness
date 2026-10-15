import assert from "node:assert/strict"
import fs from "node:fs"
import { test } from "node:test"
import { startEngine, OPENCODE_BIN } from "./engine.mjs"
import { startFakeLlm } from "./fake-llm.mjs"
import { setTimeout as wait } from "node:timers/promises"

async function fixture(t, options = {}) {
	fs.accessSync(OPENCODE_BIN, fs.constants.X_OK)
	const sandbox = fs.mkdtempSync("/tmp/opencode/account-engine-")
	const llm = await startFakeLlm({ log: `${sandbox}/supplier.ndjson` }), engine = await startEngine({ sandbox, llmUrl: llm.url, ...options })
	t.after(async () => { await engine.stop(); await llm.close() })
	assert.match((await engine.initialize()).agentInfo.version, /^2\.0\.19/)
	t.diagnostic(`binary=${OPENCODE_BIN}; evidence=${sandbox}`)
	return { llm, engine }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

test("native HTTP attribution isolates concurrent roots, titles, and layered delegates; explicit next turn gets new work", { timeout: 90000 }, async (t) => {
	const { llm, engine } = await fixture(t)
	const a = await engine.newSession("geology"), b = await engine.newSession("geology")
	const turns = await Promise.all([engine.turn(a, "DELEGATE orchestrator DELEGATE analytics RESULT success"), engine.turn(b, "DELEGATE orchestrator DELEGATE transform RESULT success")])
	for (const turn of turns) { assert.equal(turn.error, null, JSON.stringify(turn)); assert.equal(turn.stopReason, "end_turn") }
	for (const root of [a, b]) {
		const calls = llm.requests.filter((r) => r.headers["x-geocluster-conversation-id"] === root)
		assert.ok(calls.length >= 4, `missing structured root/child/title calls for ${root}`)
		assert.ok(calls.some((r) => r.headers["x-geocluster-kind"] === "title"))
		assert.ok(calls.some((r) => r.headers["x-geocluster-kind"] === "delegate" && ["orchestrator", "analytics", "transform"].includes(r.headers["x-geocluster-agent"])))
		assert.equal(new Set(calls.map((r) => r.headers["x-geocluster-work-id"])).size, 1)
		for (const r of calls) assert.match(r.headers["x-geocluster-request-id"], uuid)
	}
	assert.equal(new Set(llm.requests.map((r) => r.headers["x-geocluster-request-id"])).size, llm.requests.length)
	const firstWork = llm.requests.find((r) => r.headers["x-geocluster-conversation-id"] === a).headers["x-geocluster-work-id"]
	const mark = llm.requests.length
	assert.equal((await engine.turn(a, "SAY explicit continuation")).stopReason, "end_turn")
	assert.ok(llm.requests.slice(mark).every((r) => r.headers["x-geocluster-work-id"] !== firstWork))
})

test("native engine never retries managed 503/429 denials and preserves code through ACP serialization", { timeout: 90000 }, async (t) => {
	const { llm, engine } = await fixture(t)
	let code
	llm.intercept = (body, record) => record.headers["x-geocluster-kind"] === "primary" ? { kind: "error", status: code === "usage_limit_reached" ? 429 : 503, code, message: "Managed access denied", retryable: false } : undefined
	for (code of ["usage_limit_reached", "model_not_allowed", "account_inactive", "request_already_admitted", "usage_unavailable"]) {
		const sid = await engine.newSession("standard"), mark = llm.requests.length
		const turn = await engine.turn(sid, "SAY never supplied", { timeoutMs: 20000 })
		assert.equal(turn.timeout, false, JSON.stringify(turn))
		assert.ok(turn.error, JSON.stringify(turn))
		assert.match(turn.error.message, new RegExp(code))
		assert.equal(llm.requests.slice(mark).filter((r) => r.headers["x-geocluster-kind"] === "primary").length, 1, `retried ${code}`)
	}
})

test("native managed 403 root/delegate marker survives ACP; genuine unmanaged 401/403 stay authentication failures", { timeout: 90000 }, async (t) => {
	const { llm, engine } = await fixture(t)
	for (const target of ["standard", "analytics"]) for (const code of ["model_not_allowed", "account_inactive"]) {
		llm.intercept = (_body, record) => record.headers["x-geocluster-agent"] === target && record.headers["x-geocluster-kind"] !== "title" ? { kind: "error", status: 403, code, message: "Managed refusal", retryable: false } : undefined
		const sid = await engine.newSession(target === "standard" ? "standard" : "geology"), mark = llm.requests.length
		const turn = await engine.turn(sid, target === "standard" ? "SAY never supplied" : "DELEGATE orchestrator DELEGATE analytics RESULT never supplied", { timeoutMs: 20000 })
		assert.equal(turn.timeout, false, JSON.stringify(turn))
		assert.match(turn.error?.message || "", new RegExp(`\\[geocluster:${code}\\]`), JSON.stringify(turn))
		assert.notEqual(turn.error?.code, -32000, "managed refusal must not become ACP authentication-required")
		assert.equal(llm.requests.slice(mark).filter((r) => r.headers["x-geocluster-agent"] === target && r.headers["x-geocluster-kind"] !== "title").length, 1)
	}
	for (const status of [401, 403]) {
		llm.intercept = (_body, record) => record.headers["x-geocluster-kind"] === "primary" ? { kind: "error", status, code: "invalid_api_key", message: "Authentication failed" } : undefined
		const sid = await engine.newSession("standard"), mark = llm.requests.length
		const turn = await engine.turn(sid, "SAY never supplied", { timeoutMs: 20000 })
		assert.equal(turn.timeout, false)
		assert.equal(turn.error?.code, -32000, JSON.stringify(turn))
		assert.match(turn.error.message, /auth/i)
		assert.doesNotMatch(turn.error.message, /geocluster:/)
		assert.equal(llm.requests.slice(mark).filter((r) => r.headers["x-geocluster-kind"] === "primary").length, 1)
	}
})

// Gate native hooks, not elapsed-time guesses: attribution runs before zz's response
// observer; primary model preparation waits until that observer has seen the title denial.
const orderingPlugin = (ordering) => `
import fs from "node:fs"
import { rootResolver } from "../lib/run-dir.js"
export async function setup(ctx) {
	const { resolveRoot } = rootResolver(ctx), states = new Map()
	const stateFor = (root) => {
		if (!states.has(root)) {
			let titleDone, mainDone
			states.set(root, { count: 0, title: new Promise(r => titleDone = r), main: new Promise(r => mainDone = r), titleDone, mainDone })
		}
		return states.get(root)
	}
	const log = (value) => fs.appendFileSync(ctx.location.directory + "/ordering.ndjson", JSON.stringify(value) + "\\n")
	const waitTitle = async s => {
		let timer
		try { await Promise.race([s.title, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("title ordering gate timeout")), 10000) })]) }
		finally { clearTimeout(timer) }
	}
	await ctx.session.hook("model.request", async e => {
		const root = await resolveRoot(e.sessionID), s = stateFor(root)
		log({ event: "prepare", root, kind: e.kind, model: e.model })
		if (e.kind === "primary" && root === e.sessionID) {
			s.count++
			if (${JSON.stringify(ordering)} === "title-first" || s.count > 1) await waitTitle(s)
		}
	})
	await ctx.session.hook("http.request", async e => {
		if (e.kind === "title" && ${JSON.stringify(ordering)} === "between-calls") await stateFor(await resolveRoot(e.sessionID)).main
	})
	await ctx.session.hook("http.response", async e => {
		const root = await resolveRoot(e.sessionID), s = stateFor(root)
		log({ event: "response", root, kind: e.kind, status: e.response.status })
		if (e.kind === "title") s.titleDone()
		else if (e.kind === "primary" && root === e.sessionID) s.mainDone()
	})
}
export default { id: "test-title-ordering", setup }
`

for (const ordering of ["title-first", "between-calls"]) test(`native deterministic ${ordering}: title refusal blocks fallback, main and capacity retry complete`, { timeout: 60000 }, async (t) => {
	const { llm, engine } = await fixture(t, { extraPlugins: { "zz-title-ordering.js": orderingPlugin(ordering) } })
	let tries = 0
	llm.intercept = (_body, r) => r.headers["x-geocluster-kind"] === "title" ? { kind: "error", status: 403, code: "model_not_allowed", message: "Title unavailable", retryable: false }
		: r.headers["x-geocluster-kind"] === "primary" && ++tries === 1 && ordering === "title-first" ? { kind: "error", status: 429, message: "Supplier capacity" } : undefined
	const sid = await engine.newSession("geology", "proxy/openai/gpt-6.1-sol")
	const turn = await engine.turn(sid, "DELEGATE orchestrator DELEGATE analytics RESULT main completed", { timeoutMs: 20000 })
	assert.equal(turn.stopReason, "end_turn", JSON.stringify(turn))
	assert.match(turn.text, /state="completed"/)
	assert.match(engine.childUpdates(sid).filter((e) => e.depth === 2 && e.update?.sessionUpdate === "agent_message_chunk").map((e) => e.update.content.text).join(""), /"summary": "main completed"/)
	// The native fallback is prepared because title Luna differs from primary Sol,
	// but must be refused before a second supplier request, including after the turn ends.
	await wait(100)
	const events = fs.readFileSync(`${engine.paths.ws}/ordering.ndjson`, "utf8").trim().split("\n").map(JSON.parse)
	assert.equal(events.filter((e) => e.event === "prepare" && e.kind === "title").length, 2)
	assert.equal(events.find((e) => e.event === "response" && e.kind === "title").status, 400)
	const calls = llm.requests.filter((r) => r.headers["x-geocluster-conversation-id"] === sid)
	assert.equal(calls.filter((r) => r.headers["x-geocluster-kind"] === "title").length, 1)
	assert.equal(calls[0].headers["x-geocluster-kind"], ordering === "title-first" ? "title" : "primary")
	assert.equal(calls.filter((r) => r.headers["x-geocluster-kind"] === "primary").length, ordering === "title-first" ? 3 : 2)
	assert.equal(new Set(calls.map((r) => r.headers["x-geocluster-work-id"])).size, 1)
	assert.ok(calls.filter((r) => r.headers["x-geocluster-kind"] !== "title").every((r) => r.body.model === "openai/gpt-6.1-sol"), "no model substitution")
})

test("native jitter stress: title refusals never stop six concurrent layered roots or their capacity retries", { timeout: 90000 }, async (t) => {
	const { llm, engine } = await fixture(t), tries = new Map()
	llm.intercept = (_body, r) => {
		if (r.headers["x-geocluster-kind"] === "title") return { kind: "wait", gate: `title_${r.seq}`, then: { kind: "error", status: 403, code: "model_not_allowed", message: "Title denied", retryable: false } }
		if (r.headers["x-geocluster-kind"] === "primary") {
			const root = r.headers["x-geocluster-conversation-id"], n = (tries.get(root) || 0) + 1; tries.set(root, n)
			if (n === 1) return { kind: "wait", gate: `main_${r.seq}`, then: { kind: "error", status: 429, message: "Supplier capacity" } }
		}
	}
	// Release gates with jitter relative to observation, independent of server clocks.
	const released = new Set(), jitter = setInterval(() => { for (const r of llm.requests) if (!released.has(r.seq)) { released.add(r.seq); setTimeout(() => { llm.release(`title_${r.seq}`); llm.release(`main_${r.seq}`) }, 5 + Math.random() * 60) } }, 5)
	t.after(() => clearInterval(jitter))
	for (let round = 0; round < 3; round++) {
		const roots = await Promise.all(Array.from({ length: 6 }, () => engine.newSession("geology", "proxy/openai/gpt-6.1-sol")))
		const turns = await Promise.all(roots.map(async (root) => { await wait(Math.random() * 30); return engine.turn(root, "DELEGATE orchestrator DELEGATE analytics RESULT stress complete", { timeoutMs: 20000 }) }))
		for (let n = 0; n < roots.length; n++) {
			assert.equal(turns[n].stopReason, "end_turn", JSON.stringify(turns[n]))
			assert.match(turns[n].text, /state="completed"/)
			assert.match(engine.childUpdates(roots[n]).filter((e) => e.depth === 2 && e.update?.sessionUpdate === "agent_message_chunk").map((e) => e.update.content.text).join(""), /"summary": "stress complete"/)
			const calls = llm.requests.filter((r) => r.headers["x-geocluster-conversation-id"] === roots[n])
			assert.equal(calls.filter((r) => r.headers["x-geocluster-kind"] === "title").length, 1)
			assert.equal(calls.filter((r) => r.headers["x-geocluster-kind"] === "primary").length, 3)
			assert.equal(new Set(calls.map((r) => r.headers["x-geocluster-work-id"])).size, 1)
		}
	}
	assert.equal(new Set(llm.requests.map((r) => r.headers["x-geocluster-request-id"])).size, llm.requests.length)
})

test("native delegate denial stops the root supplier loop; capacity retry keeps work identity and gets a fresh attempt UUID", { timeout: 60000 }, async (t) => {
	const { llm, engine } = await fixture(t)
	llm.intercept = (_body, record) => record.headers["x-geocluster-agent"] === "analytics" ? { kind: "error", status: 503, code: "usage_unavailable", message: "Admission unavailable", retryable: false } : undefined
	const root = await engine.newSession("geology")
	const denied = await engine.turn(root, "DELEGATE orchestrator DELEGATE analytics RESULT unused", { timeoutMs: 20000 })
	assert.equal(denied.timeout, false); assert.match(denied.error?.message || "", /usage_unavailable/)
	assert.equal(llm.requests.filter((r) => r.headers["x-geocluster-agent"] === "analytics").length, 1)
	const denialAt = llm.requests.findIndex((r) => r.headers["x-geocluster-agent"] === "analytics")
	assert.ok(llm.requests.slice(denialAt + 1).every((r) => r.headers["x-geocluster-kind"] === "title"), "parents must not issue more supplier calls after the delegate denial")
	let tries = 0
	llm.intercept = (_body, record) => record.headers["x-geocluster-kind"] === "primary" && ++tries === 1 ? { kind: "error", status: 429, message: "Supplier capacity" } : undefined
	const sid = await engine.newSession("standard"), mark = llm.requests.length
	const success = await engine.turn(sid, "SAY capacity recovered", { timeoutMs: 10000 })
	assert.equal(success.stopReason, "end_turn", JSON.stringify(success))
	const attempts = llm.requests.slice(mark).filter((r) => r.headers["x-geocluster-kind"] === "primary")
	assert.equal(attempts.length, 2)
	assert.notEqual(attempts[0].headers["x-geocluster-request-id"], attempts[1].headers["x-geocluster-request-id"])
	assert.equal(attempts[0].headers["x-geocluster-work-id"], attempts[1].headers["x-geocluster-work-id"])
})
