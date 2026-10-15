import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { request } from "../config/lib/voxel-client.js"

test("Unix client fixes endpoint/address, transports scope only, preserves Retry-After and never retries a lost submission", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voxel-socket-")), socket = path.join(dir, "voxels.sock"), received = [], options = []
	const server = http.createServer(async (req, res) => {
		const parts = []; for await (const chunk of req) parts.push(chunk)
		const body = JSON.parse(Buffer.concat(parts)); received.push({ method: req.method, url: req.url, headers: req.headers, body })
		if (body.action === "submit") return req.socket.destroy()
		if (body.action === "inspect") { res.writeHead(503, { "content-type": "application/json", "retry-after": "7" }); return res.end(JSON.stringify({ error: "checking", reason: "Checking voxel data." })) }
		res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ scope: { workspaceId: "w", workspaceEpoch: "e" } }))
	})
	await new Promise((resolve) => server.listen(socket, resolve))
	// Reroute only in the test; assert the production request selected the fixed runtime address first.
	const nativeRequest = http.request
	t.mock.method(http, "request", (opts, callback) => { options.push(opts); assert.equal(opts.socketPath, "/run/geocluster/voxels.sock"); assert.equal(opts.path, "/agent/voxels"); return nativeRequest({ ...opts, socketPath: socket }, callback) })
	t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }) })
	await request({ action: "capabilities", scope: null, conversationId: "ses_root" })
	await assert.rejects(request({ action: "inspect", scope: { workspaceId: "w", workspaceEpoch: "e" }, conversationId: "ses_root", artifact: {} }), (error) => error.status === 503 && error.retryAfter === "7" && error.code === "checking")
	await assert.rejects(request({ action: "submit", scope: { workspaceId: "w", workspaceEpoch: "e" }, conversationId: "ses_root", submission: {}, idempotencyKey: "same-key" }), /socket|hang|reset/i)
	assert.equal(received.filter((r) => r.body.action === "submit").length, 1)
	assert.equal(options.length, 3)
	for (const r of received) { assert.equal(r.method, "POST"); assert.equal(r.headers.authorization, undefined); assert.equal(r.headers["x-gc-gate"], undefined) }
})
