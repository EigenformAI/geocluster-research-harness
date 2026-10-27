import assert from "node:assert/strict"
import { test } from "node:test"
import { PreprocessingClient } from "../lib/preprocessing-client.js"
import { processor } from "./document-processing-fixture.test.mjs"

test("processor client uses fixed loopback, private credentials, and only download conditionals", async (t) => {
	const p = await processor(t), c = new PreprocessingClient({ port: p.port, token: "private-token" })
	const job = await c.submit("3548179d-27ee-48f8-9430-e58d5f0c6fe3", { source: { kind: "workspace-file", path: "a.csv" }, profileId: "default" })
	const response = await c.product(job.id, "product_svg", { method: "HEAD", headers: { range: "bytes=0-3", authorization: "caller-token", cookie: "browser", origin: "https://evil.example", "x-gc-internal-token": "spoof" } })
	assert.equal(response.status, 200); assert.equal(response.headers.get("etag"), '"strong"'); assert.equal(response.headers.get("content-length"), String(p.products.length)); assert.equal(await response.text(), "")
	assert.equal(response.headers.get("set-cookie"), null)
	const headers = p.requests.at(-1).headers
	assert.equal(headers.authorization, "Bearer private-token"); assert.equal(headers.range, undefined)
	for (const key of ["origin", "cookie", "x-gc-internal-token"]) assert.equal(headers[key], undefined)
	assert.throws(() => c.product(job.id, "product_svg", { headers: { range: "bytes=0-3,10-20" } }), { status: 416, error: "invalid_range" })
	assert.throws(() => new PreprocessingClient({ port: "https://evil.example" }), { error: "invalid_preprocessing_config" })
})

test("processor mutations bind the authenticated store and reject replacement before effects", async (t) => {
	const p = await processor(t), c = new PreprocessingClient({ port: p.port, token: "private-token" })
	const request = { source: { kind: "workspace-file", path: "a.csv" }, profileId: "default" }
	const job = await c.submit("3548179d-27ee-48f8-9430-e58d5f0c6fe3", request)
	await c.cancel(job.id)
	const mutations = p.requests.filter((entry) => entry.method === "POST")
	assert.equal(mutations.length, 2)
	assert.ok(mutations.every((entry) => entry.headers["x-processing-store-scope"] === "processor-private-scope"))
	p.options.storeScope = "replacement-store"
	for (const mutate of [() => c.submit("3548179d-27ee-48f8-9430-e58d5f0c6fe3", request), () => c.cancel(job.id), () => c.cancelSubmission("3548179d-27ee-48f8-9430-e58d5f0c6fe3", request)]) {
		await assert.rejects(mutate(), { error: "processing_store_changed" })
	}
	assert.equal(p.requests.filter((entry) => entry.method === "POST").length, 2)
})

test("processor client rejects oversized JSON without truncation and never follows redirects", async (t) => {
	const p = await processor(t), c = new PreprocessingClient({ port: p.port, jsonBytes: 32 })
	await assert.rejects(c.capabilities(), { error: "result_metadata_too_large", status: 413 })
	p.options.redirect = true
	await assert.rejects(c.capabilities(), { error: "processor_protocol_error" })
})

test("processor failures are actionable and redact upstream private error text", async (t) => {
	const p = await processor(t, { down: true }), c = new PreprocessingClient({ port: p.port })
	await assert.rejects(c.capabilities(), (error) => { assert.equal(error.retryable, true); assert.equal(error.error, "provider_unavailable"); assert.ok(error.action); assert.doesNotMatch(JSON.stringify(error.toJSON()), /private\/token|secret/); return true })
})

test("processor range errors preserve public range metadata and never stream private diagnostics", async (t) => {
	const p = await processor(t, { rangeError: true }), c = new PreprocessingClient({ port: p.port })
	const job = await c.submit("3548179d-27ee-48f8-9430-e58d5f0c6fe3", { source: { kind: "workspace-file", path: "a.csv" }, profileId: "default" })
	const response = await c.product(job.id, "product_svg", { headers: { range: "bytes=100-200" } })
	assert.equal(response.status, 416); assert.equal(response.headers.get("content-range"), `bytes */${p.products.length}`)
	assert.doesNotMatch(await response.text(), /private|secret|token/)
})

test("processor download preconditions use actual validators when upstream ignores them", async (t) => {
	const p = await processor(t), c = new PreprocessingClient({ port: p.port, token: "private-token" })
	const job = await c.submit("3548179d-27ee-48f8-9430-e58d5f0c6fe3", { source: { kind: "workspace-file", path: "a.csv" }, profileId: "default" })
	const modified = "Thu, 01 Oct 2026 00:00:00 GMT", older = "Wed, 30 Sep 2026 00:00:00 GMT", newer = "Fri, 02 Oct 2026 00:00:00 GMT"
	const cases = [
		["weak If-None-Match", { "if-none-match": 'W/"strong"' }, 304],
		["If-None-Match wildcard", { "if-none-match": "*" }, 304],
		["strong If-Match", { "if-match": '"strong"' }, 200],
		["If-Match wildcard", { "if-match": "*" }, 200],
		["If-Match list", { "if-match": 'W/"strong", "missing", "strong"' }, 200],
		["weak If-Match fails", { "if-match": 'W/"strong"' }, 412],
		["different If-Match fails", { "if-match": '"missing"' }, 412],
		["If-Modified-Since equal", { "if-modified-since": modified }, 304],
		["If-Modified-Since future", { "if-modified-since": newer }, 304],
		["If-Modified-Since older", { "if-modified-since": older }, 200],
		["If-Unmodified-Since equal", { "if-unmodified-since": modified }, 200],
		["If-Unmodified-Since future", { "if-unmodified-since": newer }, 200],
		["If-Unmodified-Since older fails", { "if-unmodified-since": older }, 412],
		["invalid dates ignored", { "if-modified-since": "not a date", "if-unmodified-since": "1" }, 200],
		["invalid calendar date ignored", { "if-unmodified-since": "Tue, 31 Feb 2026 00:00:00 GMT" }, 200],
		["obsolete RFC850 date accepted", { "if-modified-since": "Thursday, 01-Oct-26 00:00:00 GMT" }, 304],
		["obsolete asctime date accepted", { "if-modified-since": "Thu Oct  1 00:00:00 2026" }, 304],
		["If-Match overrides If-Unmodified-Since", { "if-match": '"strong"', "if-unmodified-since": older }, 200],
		["If-None-Match overrides If-Modified-Since", { "if-none-match": '"different"', "if-modified-since": newer }, 200],
		["If-Match failure precedes If-None-Match", { "if-match": '"different"', "if-none-match": '"strong"' }, 412],
		["If-Unmodified-Since failure precedes If-None-Match", { "if-unmodified-since": older, "if-none-match": '"strong"' }, 412],
	]
	for (const method of ["GET", "HEAD"]) for (const [name, headers, status] of cases) await t.test(`${method}: ${name}`, async () => {
		const before = p.requests.length, input = { ...headers, origin: "https://caller.example", cookie: "browser=secret", authorization: "Bearer caller", "x-gc-internal-control": "spoof" }
		if (status === 412) await assert.rejects(c.product(job.id, "product_svg", { method, headers: input }), (error) => { assert.equal(error.status, 412); assert.equal(error.error, "precondition_failed"); assert.equal(error.etag, '"strong"'); assert.ok(error.action); return true })
		else {
			const response = await c.product(job.id, "product_svg", { method, headers: input })
			assert.equal(response.status, status); assert.equal(response.headers.get("etag"), '"strong"'); assert.equal(response.headers.get("last-modified"), modified)
			assert.equal(await response.text(), status === 304 || method === "HEAD" ? "" : p.products.toString())
			if (status === 304) { assert.equal(response.body, null); assert.equal(response.headers.get("content-length"), null) }
		}
		const requests = p.requests.slice(before)
		assert.equal(requests[0].method, "HEAD")
		assert.equal(requests.length, status === 200 && method === "GET" ? 2 : 1)
		for (const request of requests) {
			assert.equal(request.headers.authorization, "Bearer private-token")
			for (const header of ["origin", "cookie", "x-gc-internal-control", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since"]) assert.equal(request.headers[header], undefined)
		}
	})
})

test("processor download preconditions precede ranges while HEAD ignores even malformed Range", async (t) => {
	const p = await processor(t), c = new PreprocessingClient({ port: p.port })
	const job = await c.submit("3548179d-27ee-48f8-9430-e58d5f0c6fe3", { source: { kind: "workspace-file", path: "a.csv" }, profileId: "default" })
	for (const range of ["bytes=100-200", "bytes=0-3,10-20", "invalid"]) {
		const before = p.requests.length, response = await c.product(job.id, "product_svg", { headers: { "if-none-match": 'W/"strong"', range } })
		assert.equal(response.status, 304); assert.equal(response.body, null); assert.equal(p.requests.length, before + 1); assert.equal(p.requests.at(-1).headers.range, undefined)
	}
	for (const headers of [{ range: "invalid", "if-range": '"different"' }, { range: "invalid", "if-match": '"strong"' }]) {
		const response = await c.product(job.id, "product_svg", { method: "HEAD", headers })
		assert.equal(response.status, 200); assert.equal(response.body, null); assert.equal(response.headers.get("content-length"), String(p.products.length)); assert.equal(p.requests.at(-1).headers.range, undefined); assert.equal(p.requests.at(-1).headers["if-range"], undefined)
	}
	const ranged = await c.product(job.id, "product_svg", { headers: { "if-match": '"strong"', range: "bytes=0-3", "if-range": '"strong"' } })
	assert.equal(ranged.status, 206); assert.equal(await ranged.text(), "<svg"); assert.equal(ranged.headers.get("content-range"), `bytes 0-3/${p.products.length}`)
	const full = await c.product(job.id, "product_svg", { headers: { "if-match": '"strong"', range: "bytes=0-3", "if-range": '"different"' } })
	assert.equal(full.status, 200); assert.equal(await full.text(), p.products.toString())
	p.options.productEtag = 'W/"strong"'
	await assert.rejects(c.product(job.id, "product_svg", { headers: { "if-match": '"strong"' } }), { status: 412, etag: 'W/"strong"' })
	assert.equal((await c.product(job.id, "product_svg", { headers: { "if-none-match": '"strong"' } })).status, 304)
	p.options.productEtag = '"opaque,comma"'
	assert.equal((await c.product(job.id, "product_svg", { headers: { "if-none-match": '"other", W/"opaque,comma"' } })).status, 304)
	await assert.rejects(c.product(job.id, "product_svg", { headers: { "if-match": '"opaque,comma", garbage' } }), { status: 400, error: "invalid_precondition" })
})

test("processor download HEAD probe retains upstream failure and transport deadline", async (t) => {
	const p = await processor(t), c = new PreprocessingClient({ port: p.port, transportMs: 1000 })
	const job = await c.submit("3548179d-27ee-48f8-9430-e58d5f0c6fe3", { source: { kind: "workspace-file", path: "a.csv" }, profileId: "default" })
	for (const status of [404, 503]) {
		p.options.productHeadError = status
		await assert.rejects(c.product(job.id, "product_svg", { headers: { "if-none-match": "*" } }), { status })
		assert.equal(p.requests.at(-1).method, "HEAD")
	}
	p.options.productHeadError = null
	p.options.productHeadDelayMs = 80
	c.transportMs = 20
	await assert.rejects(c.product(job.id, "product_svg", { headers: { "if-match": '"strong"' } }), { status: 503, error: "processor_timeout" })
	assert.equal(p.requests.at(-1).method, "HEAD")
})
