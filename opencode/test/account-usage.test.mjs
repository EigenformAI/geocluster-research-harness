import assert from "node:assert/strict"
import { test } from "node:test"
import { decide } from "../config/lib/retry-policy.js"
import { normalize } from "../config/lib/result-protocol.js"
import { setup } from "../config/lib/account-attribution.js"
import { fakeCtx, TREE } from "./fake-ctx.mjs"
import { setTimeout as wait } from "node:timers/promises"

const model = { providerID: "proxy", id: "new/maker/model" }

test("managed denial codes survive nested/serialized engine errors and never retry; capacity still retries", () => {
	for (const code of ["usage_limit_reached", "model_not_allowed", "account_inactive", "request_already_admitted", "usage_unavailable"]) {
		for (const error of [{ status: 503, error: { code, retryable: false } }, { status: 429, message: JSON.stringify({ error: { code, retryable: false } }) }, { status: 503, type: code }]) {
			assert.deepEqual(decide({ error, attempt: 2, decision: { retry: true, delay: 1 } }), { retry: false }, JSON.stringify(error))
		}
	}
	assert.deepEqual(decide({ error: { status: 429, message: "Supplier capacity" }, attempt: 2, decision: { retry: true } }), { retry: true, delay: 2000 })
	assert.equal(decide({ error: { status: 503, message: "Supplier unavailable" }, attempt: 2, decision: { retry: true } }).retry, true)
})

async function attribution(sessions = TREE) {
	const { ctx, fire } = fakeCtx({ sessions }); await setup(ctx)
	const prompt = (sessionID = "ses_root", messageID = "msg_first") => fire("session", "prompt", { sessionID, messageID })
	const request = async (kind = "primary", sessionID = "ses_root", agent = "geology", providerID = "proxy") => fire("session", "http.request", { sessionID, kind, agent, model: { ...model, providerID }, request: new Request("http://managed.test/chat/completions", { method: "POST", body: "{}" }) })
	const respond = (event, code = "usage_unavailable", status = 403) => fire("session", "http.response", { ...event, response: new Response(JSON.stringify({ error: { code, message: "private supplier detail", retryable: false } }), { status, headers: { "content-length": "123", "content-encoding": "gzip", "x-trace": "retained" } }) })
	return { ctx, fire, prompt, request, respond }
}

test("recognized managed 403 is local non-auth 400 with marker; unmanaged 401/403 responses stay untouched", async () => {
	const a = await attribution(); await a.prompt()
	for (const code of ["usage_limit_reached", "model_not_allowed", "account_inactive", "request_already_admitted", "usage_unavailable"]) {
		await a.prompt("ses_root", `msg_${code}`)
		const event = await a.respond(await a.request(), code)
		assert.equal(event.response.status, 400, code)
		const body = await event.response.json()
		assert.equal(body.error.code, code); assert.equal(body.error.retryable, false)
		assert.match(body.error.message, new RegExp(`\\[geocluster:${code}\\]`))
		assert.doesNotMatch(body.error.message, /private supplier/)
		assert.equal(event.response.headers.get("x-trace"), "retained")
		assert.equal(event.response.headers.get("content-length"), null)
		assert.equal(event.response.headers.get("content-encoding"), null)
	}
	for (const status of [401, 403]) {
		await a.prompt()
		const request = await a.request(), response = new Response('{"error":{"code":"invalid_api_key","message":"Authentication failed"}}', { status, headers: { "x-auth": "unchanged" } })
		const result = await a.fire("session", "http.response", { ...request, response })
		assert.equal(result.response, response)
		assert.equal(result.response.status, status)
		await a.request()
	}
})

test("native title denial before main or between calls blocks only titles and leaves main capacity retry intact", async () => {
	for (const ordering of ["title-first", "between-calls"]) {
		const a = await attribution(); await a.prompt()
		if (ordering === "between-calls") await a.request()
		const title = await a.request("title", "ses_root", "title")
		await a.respond(title)
		await a.request("primary", "ses_spec", "analytics")
		for (const [kind, agent] of [["generate", "title"], ["compaction", "analytics"], ["primary", "preprocessing"], ["post-tool", "analytics"], ["unknown", "title"]]) await a.request(kind, "ses_root", agent)
		const retry = await a.fire("session", "retry", { sessionID: "ses_root", model, error: { status: 429, message: "Supplier capacity" }, decision: { retry: true, delay: 1000 } })
		assert.deepEqual(retry.decision, { retry: true, delay: 1000 })
		await assert.rejects(a.request("title", "ses_root", "geology"), /geocluster:usage_unavailable/, "native title fallback must be blocked regardless of agent/model")
		await a.prompt("ses_root", "msg_next"); await a.request("title")
	}
})

test("every non-title kind is main-scoped; main denials block main, titles, and generic retries", async () => {
	for (const [kind, agent] of [["primary", "geology"], ["primary", "preprocessing"], ["generate", "title"], ["compaction", "analytics"], ["post-tool", "title"], ["unknown", "title"]]) {
		const a = await attribution(); await a.prompt()
		await a.respond(await a.request(kind, "ses_spec", agent), "account_inactive")
		await assert.rejects(a.request("primary"), /geocluster:account_inactive/)
		await assert.rejects(a.request("title"), /geocluster:account_inactive/)
		assert.deepEqual((await a.fire("session", "retry", { sessionID: "ses_root", model, error: { status: 503, message: "generic" }, decision: { retry: true } })).decision, { retry: false })
		await a.prompt("ses_root", "msg_next"); await a.request(); await a.request("title")
	}
})

test("each denial scope ignores late old-work responses without clearing current title or main denials", async () => {
	const a = await attribution(); await a.prompt()
	const oldTitle = await a.request("title"), oldMain = await a.request("primary", "ses_spec")
	await a.prompt("ses_root", "msg_next")
	await a.respond(oldMain); await a.respond(oldTitle)
	await a.request(); await a.request("title")
	await a.respond(await a.request("title"), "model_not_allowed")
	await a.respond(oldMain, "account_inactive")
	await a.request(); await assert.rejects(a.request("title"), /geocluster:model_not_allowed/)
	await a.respond(await a.request(), "usage_limit_reached")
	await a.respond(oldTitle, "account_inactive")
	await assert.rejects(a.request(), /geocluster:usage_limit_reached/)
	await assert.rejects(a.request("title"), /geocluster:usage_limit_reached/)
})

test("jitter stress: title/main denials and late-work responses remain isolated across 24 concurrent roots", async () => {
	const roots = Array.from({ length: 24 }, (_, n) => `ses_stress${n}`), sessions = {}
	for (const root of roots) { sessions[root] = null; sessions[`${root}_child`] = root }
	const a = await attribution(sessions), get = a.ctx.session.get
	a.ctx.session.get = async (input) => { await wait(Math.random() * 5); return get(input) }
	for (let round = 0; round < 8; round++) await Promise.all(roots.map(async (root, index) => {
		await a.prompt(root, `msg_${round}_${root}`)
		const oldTitle = await a.request("title", root), oldMain = await a.request("primary", `${root}_child`)
		await a.prompt(root, `msg_${round}_${root}_next`)
		await wait(Math.random() * 8)
		await a.respond(oldTitle); await a.respond(oldMain)
		await a.request("primary", root)
		const title = await a.request("title", root); await a.respond(title, "model_not_allowed")
		await wait(Math.random() * 8)
		await a.request("primary", `${root}_child`)
		await assert.rejects(a.request("title", root), /geocluster:model_not_allowed/)
		if (index % 2 === 0) {
			await a.respond(await a.request("primary", root), "account_inactive")
			await assert.rejects(a.request("primary", `${root}_child`), /geocluster:account_inactive/)
		} else await a.request("primary", root)
	}))
})

test("quota-denied specialist handback requires explicit recovery and cannot direct autonomous redispatch", () => {
	const result = normalize({ specialist: "analytics", sessionID: "ses_child", state: "failed", body: JSON.stringify({ error: { code: "usage_limit_reached", retryable: false } }) })
	assert.equal(result.status, "error")
	assert.equal(result.usageDenial?.code, "usage_limit_reached")
	assert.doesNotMatch(result.errors.join(" "), /dispatch it again|continue this specialist/)
	assert.match(result.errors.join(" "), /explicit new submission/i)
})

test("managed hooks use provider identity, not model names or endpoint, and cannot latch native work off", async () => {
	const a = await attribution(); await a.prompt()
	const native = await a.request("primary", "ses_root", "geology", "personal")
	assert.equal(native.request.headers.has("x-geocluster-work-id"), false, "same endpoint must not leak attribution")
	const response = new Response('{"error":{"code":"account_inactive"}}', { status: 403 })
	assert.equal((await a.fire("session", "http.response", { ...native, response })).response, response)
	await a.request()
	await a.respond(await a.request(), "usage_limit_reached")
	await assert.rejects(a.request(), /geocluster:usage_limit_reached/)
	await a.request("title", "ses_root", "title", "personal")
	const retry = await a.fire("session", "retry", { sessionID: "ses_root", model: native.model, error: { type: "usage_limit_reached" }, decision: { retry: true, delay: 7 } })
	assert.deepEqual(retry.decision, { retry: true, delay: 7 })
})

test("managed title configuration keeps its funding source across interleaved explicit native work", async () => {
	const { ctx, fire } = fakeCtx({ sessions: TREE })
	await setup(ctx, { managedProviderID: "proxy", titleProviderID: "proxy" })
	const a = { fire, prompt: (sessionID = "ses_root", messageID = "msg_first") => fire("session", "prompt", { sessionID, messageID }) }
	await a.prompt()
	const title = (providerID, text = "original title input") => a.fire("session", "title", {
		sessionID: "ses_root", model: { ...model, providerID }, messages: [{ role: "user", content: text }],
	})
	assert.equal((await title("proxy")).result, undefined)
	await a.prompt("ses_root", "msg_explicit_native")
	assert.equal((await title("personal")).result, "", "skip the failed managed title's automatic cross-provider fallback")
	assert.equal((await title("personal")).result, "", "concurrent or late title attempts cannot change the configured funding source")
	await title("proxy")
	assert.equal((await title("personal", "different title operation")).result, "")
	const native = fakeCtx({ sessions: TREE })
	await setup(native.ctx, { managedProviderID: "proxy", titleProviderID: "personal" })
	assert.equal((await native.fire("session", "title", { sessionID: "ses_root", model: { ...model, providerID: "personal" } })).result, undefined, "an explicitly native title setting is not guarded as managed funding")
})

test("attribution uses session records for compaction/preprocessing; a serialized managed 503 latch prevents new calls until explicit root work", async () => {
	const { ctx, fire } = fakeCtx({ sessions: TREE }); await setup(ctx)
	await fire("session", "prompt", { sessionID: "ses_root", messageID: "msg_first" })
	const request = async (sessionID, kind, agent) => (await fire("session", "http.request", { sessionID, kind, agent, model, request: new Request("http://managed.test/chat/completions", { method: "POST", body: "{}" }) })).request
	const calls = await Promise.all([request("ses_spec", "compaction", "analytics"), request("ses_root", "primary", "preprocessing"), request("ses_other", "generate", "title")])
	assert.equal(calls[0].headers.get("x-geocluster-kind"), "compaction")
	assert.equal(calls[0].headers.get("x-geocluster-work-id"), "msg_first")
	assert.equal(calls[1].headers.get("x-geocluster-kind"), "preprocessing")
	assert.equal(calls[2].headers.get("x-geocluster-kind"), "unknown")
	await fire("session", "http.response", { sessionID: "ses_spec", model, request: calls[0], response: new Response(JSON.stringify({ error: { code: "usage_unavailable", retryable: false } }), { status: 503 }) })
	const retry = await fire("session", "retry", { sessionID: "ses_spec", model, error: { status: 503, message: "Engine serialized generic error" }, decision: { retry: true } })
	assert.deepEqual(retry.decision, { retry: false })
	await assert.rejects(request("ses_root", "primary", "geology"), /geocluster:usage_unavailable/)
	await request("ses_other", "primary", "standard")
	await fire("session", "prompt", { sessionID: "ses_root", messageID: "msg_second" })
	assert.equal((await request("ses_spec", "primary", "analytics")).headers.get("x-geocluster-work-id"), "msg_second")
})

test("jittered concurrent root/descendant/title attribution keeps every work identity isolated", async () => {
	const roots = Array.from({ length: 12 }, (_, n) => `ses_root${n}`), sessions = {}
	for (const root of roots) { sessions[root] = null; sessions[`${root}child`] = root; sessions[`${root}leaf`] = `${root}child` }
	const { ctx, fire } = fakeCtx({ sessions }), get = ctx.session.get
	ctx.session.get = async (input) => { await wait(Math.random() * 6); return get(input) }
	await setup(ctx)
	await Promise.all(roots.map((root) => fire("session", "prompt", { sessionID: root, messageID: `msg_${root}` })))
	const requests = await Promise.all(roots.flatMap((root) => [
		[root, "primary", "geology"], [root, "title", "title"], [`${root}child`, "primary", "orchestrator"],
		[`${root}leaf`, "primary", "analytics"], [`${root}leaf`, "compaction", "analytics"], [root, "primary", "preprocessing"],
	].map(async ([sessionID, kind, agent]) => {
		await wait(Math.random() * 6)
		const { request } = await fire("session", "http.request", { sessionID, kind, agent, model, request: new Request("http://managed.test/chat/completions", { method: "POST", body: "{}" }) })
		assert.equal(request.headers.get("x-geocluster-conversation-id"), root)
		assert.equal(request.headers.get("x-geocluster-work-id"), `msg_${root}`)
		return request
	})))
	assert.equal(new Set(requests.map((request) => request.headers.get("x-geocluster-request-id"))).size, 72)
})
