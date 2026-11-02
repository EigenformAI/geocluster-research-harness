import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import { createClient, readConnection } from "../config/lib/processing-client.js"

const scope = { workspaceId: "workspace", workspaceEpoch: "store" }, invocationId = "invocation"
const caller = { origin: "model", rootId: "ses_root", sessionId: "ses_root", messageId: "msg_runtime", callId: "call_runtime", agent: "standard" }
async function owner(t, respond) {
	const dir = await fs.mkdtemp("/tmp/opencode/processing-client-"), socket = path.join(dir, "documents.sock"), seen = []
	await fs.chmod(dir, 0o700)
	const server = http.createServer(async (req, res) => {
		const parts = []; for await (const part of req) parts.push(part)
		const body = JSON.parse(Buffer.concat(parts)); seen.push(body)
		assert.equal(req.method, "POST"); assert.equal(req.url, "/agent/documents"); assert.equal(req.headers.authorization, undefined)
		respond(body, req, res)
	})
	await new Promise((resolve) => server.listen(socket, resolve)); await fs.chmod(socket, 0o600)
	const descriptor = { scope, invocationId, model: "provider/model", socketPath: socket }
	const publish = async (value = descriptor) => fs.writeFile(path.join(dir, "connection.json"), JSON.stringify(value), { mode: 0o600 })
	await publish()
	t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }) })
	return { dir, descriptor, publish, seen }
}
const reply = (res, value) => res.end(JSON.stringify(value))

test("native client validates descriptor/capabilities and binds every request; lost submit never replays", async (t) => {
	const h = await owner(t, (body, req, res) => body.action === "submit" ? req.socket.destroy() : reply(res, { scope, invocationId, result: {} }))
	const client = createClient({ mode: "native", clientDir: h.dir })
	await assert.rejects(client.request({ action: "submit", scope, caller, input: { source: { kind: "workspace-file", path: "report.pdf" } } }), /socket|hang|reset/i)
	assert.deepEqual(h.seen.map((body) => body.action), ["capabilities", "submit"])
	assert.equal(h.seen[1].invocationId, invocationId)
	assert.deepEqual(h.seen[1].scope, scope)
})

test("stale native owner refuses mutation and requires explicit reopen/recovery", async (t) => {
	const h = await owner(t, (body, req, res) => reply(res, { scope, invocationId: "successor", result: {} }))
	const client = createClient({ mode: "native", clientDir: h.dir })
	await assert.rejects(client.request({ action: "cancel", scope, caller, input: { requestId: "retained" } }), (error) => error.code === "OWNER_CHANGED")
	assert.deepEqual(h.seen.map((body) => body.action), ["capabilities"])
	await h.publish({ ...h.descriptor, invocationId: "successor" })
	await assert.rejects(client.request({ action: "cancel", scope, caller, input: { requestId: "retained" } }), (error) => error.code === "OWNER_CHANGED")
	await client.reopen()
	await client.request({ action: "status", scope, caller, input: { requestId: "retained" } })
	assert.deepEqual(h.seen.map((body) => body.action), ["capabilities", "capabilities", "status"])
})

test("native discovery rejects unsafe files, directories, socket endpoints and oversized descriptors", async (t) => {
	const h = await owner(t, (_, _req, res) => reply(res, { scope, invocationId, result: {} }))
	assert.deepEqual(await readConnection(h.dir), h.descriptor)
	const file = path.join(h.dir, "connection.json")
	await fs.chmod(file, 0o644); await assert.rejects(readConnection(h.dir), /private|mode|unsafe/i); await fs.chmod(file, 0o600)
	await fs.chmod(h.dir, 0o755); await assert.rejects(readConnection(h.dir), /private|mode|unsafe/i); await fs.chmod(h.dir, 0o700)
	await h.publish({ ...h.descriptor, socketPath: "/tmp/outside.sock" }); await assert.rejects(readConnection(h.dir), /outside|endpoint|socket/i)
	await fs.writeFile(file, " ".repeat(16 * 1024 + 1)); await assert.rejects(readConnection(h.dir), /bound|large|size/i)
	await fs.unlink(file); await fs.symlink("documents.sock", file); await assert.rejects(readConnection(h.dir), /symbolic|symlink|unsafe|ELOOP/i)
})

test("client has a total deadline, retains structured errors/handles and never retries", async (t) => {
	const h = await owner(t, (body, _req, res) => {
		if (body.action === "capabilities") return reply(res, { scope, invocationId, result: {} })
		if (body.action === "cancel") { res.statusCode = 409; return reply(res, { error: { code: "cancel_pending", message: "Not settled", action: "Inspect status", requestId: "retained" } }) }
	})
	const client = createClient({ mode: "native", clientDir: h.dir, timeoutMs: 60 })
	await assert.rejects(client.request({ action: "cancel", scope, caller, input: { requestId: "retained" } }), (error) => error.code === "cancel_pending" && error.requestId === "retained" && error.action === "Inspect status")
	const start = Date.now()
	await assert.rejects(client.request({ action: "wait", scope, caller, input: { requestId: "retained" } }), (error) => error.code === "PROCESSING_TIMEOUT" && error.requestId === "retained")
	assert.ok(Date.now() - start < 1000)
	assert.equal(h.seen.filter((body) => body.action === "wait").length, 1)
})

test("managed client selects only the fixed bridge and defaults to managed mode", async (t) => {
	const h = await owner(t, (_body, _req, res) => reply(res, { scope: { workspaceId: "workspace", workspaceEpoch: "epoch" }, result: {} }))
	const nativeRequest = http.request
	t.mock.method(http, "request", (options, callback) => { assert.equal(options.socketPath, "/run/geocluster/documents.sock"); return nativeRequest({ ...options, socketPath: h.descriptor.socketPath }, callback) })
	const client = createClient({ mode: "managed" })
	await client.request({ action: "capabilities", scope: null, caller, input: {} })
	assert.equal(h.seen.length, 1)
	assert.equal(h.seen[0].invocationId, undefined)
})

test("flat managed and nested native failures retain new-submit and export recovery details without replay", async (t) => {
	const observedScope = { workspaceId: "workspace", workspaceEpoch: "epoch" }
	const currentObservation = { token: "current-token", ref: { ...observedScope, path: "report.pdf" }, observedAt: "2026-10-27T00:00:00.000Z", sizeBytes: 12 }
	const details = { code: "SOURCE_CHANGED", message: "The retained source changed.", action: "Select current bytes only with an explicit new request.", requestId: "newly-allocated-request", jobId: "retained-job", exportId: "retained-export", waitId: "retained-wait", currentObservation }
	const h = await owner(t, (body, _req, res) => {
		if (body.action === "capabilities") return reply(res, { scope, invocationId, result: {} })
		res.statusCode = 409
		reply(res, body.input.nested ? { error: details } : { error: "SOURCE_CHANGED", ...details })
	})
	const nativeRequest = http.request
	t.mock.method(http, "request", (options, callback) => nativeRequest({ ...options, socketPath: h.descriptor.socketPath }, callback))
	for (const mode of ["managed", "native"]) {
		const client = createClient({ mode, clientDir: h.dir })
		const requestScope = mode === "native" ? scope : observedScope
		await assert.rejects(client.request({ action: "submit", scope: requestScope, caller, input: { source: { kind: "workspace-file", path: "report.pdf" }, nested: mode === "native" } }), (error) => {
			for (const key of ["code", "message", "action", "requestId", "jobId", "exportId", "waitId"]) assert.equal(error[key], details[key])
			if (mode === "managed") assert.deepEqual(error.currentObservation, currentObservation)
			else assert.equal(error.currentObservation, undefined, "an observation from a different persistent scope cannot be forwarded")
			return true
		})
	}
	assert.equal(h.seen.filter((body) => body.action === "submit").length, 2, "one attempt per explicit caller; no replay after error")
})

test("error recovery projection rejects malformed, oversized and private observation details", async (t) => {
	const observedScope = { workspaceId: "workspace", workspaceEpoch: "epoch" }
	const observation = { token: "current", ref: { ...observedScope, path: "report.pdf" } }
	const invalid = [
		{ ...observation, token: "x".repeat(513) },
		{ ...observation, ref: { ...observation.ref, workspaceEpoch: "stale" } },
		{ ...observation, ref: { ...observation.ref, path: ".runtime/private" } },
		{ ...observation, ref: { ...observation.ref, path: "another.pdf" } },
		{ ...observation, privatePath: "/private/store" },
		{ ...observation, sizeBytes: -1 },
	]
	const h = await owner(t, (body, _req, res) => { res.statusCode = 409; reply(res, { error: "SOURCE_CHANGED", code: "SOURCE_CHANGED", message: "Changed", requestId: "retained", exportId: "x".repeat(129), jobId: {}, waitId: "unsafe\nwait", currentObservation: invalid[body.input.index], action: "Select an explicit new source." }) })
	const nativeRequest = http.request
	t.mock.method(http, "request", (options, callback) => nativeRequest({ ...options, socketPath: h.descriptor.socketPath }, callback))
	const client = createClient({ mode: "managed" })
	for (let index = 0; index < invalid.length; index++) await assert.rejects(client.request({ action: "submit", scope: observedScope, caller, input: { index, source: { kind: "workspace-file", path: "report.pdf" } } }), (error) => {
		assert.equal(error.code, "SOURCE_CHANGED"); assert.equal(error.requestId, "retained")
		for (const key of ["currentObservation", "exportId", "jobId", "waitId", "privatePath"]) assert.equal(error[key], undefined, key)
		return true
	})
})
