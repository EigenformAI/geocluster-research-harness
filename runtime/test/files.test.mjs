/** V1 HTTP behavior. Protected effects are delegated to a fake service; native reads use WorkspaceFiles. */
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { setTimeout as wait } from "node:timers/promises"
import { test } from "node:test"
import { FILE_LIMITS, FileError, canonicalPath, noPersistence, observation } from "../lib/file-contract.js"
import { FileEvents } from "../lib/file-events.js"
import { FilesApi } from "../lib/files.js"

const identity = { workspaceId: "http-test", workspaceEpoch: "epoch-1" }
const logger = { error() {}, warn() {}, info() {} }
const ref = (name) => ({ ...identity, path: name })
const publication = (name = "a.txt") => ({ ref: ref(name), token: "published-token", observedAt: "2026-10-01T00:00:00.000Z", sizeBytes: 5 })
const operation = (id = "op-1") => ({ operationId: id, state: "committed", action: "upload", addresses: [ref("a.txt")], publishedSource: null, publishedObservation: publication(), committedAt: "2026-10-01T00:00:00.000Z", persistence: noPersistence(), reconciliation: { required: false, inspectionRef: null, replayAllowed: false } })
const capture = (name = "a.txt", id = "c-1", sizeBytes = 6) => ({ kind: "runtime-capture", ref: ref(name), captureId: id, etag: `"capture-${id}"`, sizeBytes, consistency: "checked-copy", digest: { state: "not-requested", sha256: null } })

async function serve(t, workspace) {
	const files = new FilesApi(workspace, logger)
	const server = http.createServer(async (req, res) => {
		if (!await files.handle(req, res, new URL(req.url, "http://files"))) { res.writeHead(404); res.end() }
	})
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	t.after(async () => { await files.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
	const base = `http://127.0.0.1:${server.address().port}`
	return { files, server, base, request: (route, options = {}) => fetch(`${base}${route}`, options) }
}

async function fixture(t, overrides = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "files-http-v1-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const events = new FileEvents({ identity })
	const calls = [], releases = []
	const workspace = {
		identity, state: { identity }, workspaceDir: root, gatewayStateDir: path.join(root, "legacy-unused"), limits: FILE_LIMITS, events,
		info: () => ({ ...identity, capabilities: { protectedStore: false }, limits: FILE_LIMITS }),
		async openLive(name) {
			canonicalPath(name, { root: false })
			const handle = await fs.open(path.join(root, name), "r")
			const stat = await handle.stat({ bigint: true })
			return { handle, stat, observation: observation(ref(name), stat) }
		},
		async upload(readable, options) {
			calls.push(["upload", options])
			const chunks = []
			for await (const chunk of readable) chunks.push(chunk)
			calls.push(["bytes", Buffer.concat(chunks).toString()])
			return { status: 201, operation: operation(options.operationId) }
		},
		captures: {
			async create(body) { calls.push(["create", body]); return { status: 201, source: capture(), lease: { leaseId: "l-1", source: { kind: "capture", id: "c-1" }, ttlSeconds: 300, expiresAt: "2026-10-01T00:05:00.000Z" } } },
			async get(kind, id) { calls.push(["get", kind, id]); return { source: capture(), availability: "available", currentRelation: "newer-current", currentObservation: null, leaseExpiresAt: null } },
			async open(kind, id) {
				calls.push(["open", kind, id])
				const handle = await fs.open(path.join(root, "a.txt"), "r")
				const size = Number((await handle.stat({ bigint: true })).size)
				const source = kind === "capture" ? capture("a.txt", id, size) : { kind: "runtime-fragment", ref: ref("a.txt"), fragmentId: id, etag: `"fragment-${id}"`, byteStart: 100, byteEnd: 100 + size, sourceSizeObserved: 200, sourceObservation: null, sourceMayHaveChanged: false, sourceEof: false, completeSource: false }
				return { handle, source, async release() { releases.push(`${kind}/${id}`); await handle.close() } }
			},
			async text(kind, id, options) { calls.push(["text", kind, id, options]); return { source: capture(), text: "hello", encoding: "utf-8", stable: true, complete: false } },
			async preview(body) { calls.push(["preview", body]); return { coverage: "fragment", eof: false, next: null, stopReason: "fragment-end", continuation: { kind: "capture-required" } } },
			async segments(kind, id, body) { calls.push(["segments", kind, id, body]); return { eof: false, next: null, stopReason: "fragment-end" } },
			async lease(body) { calls.push(["lease", body]); return { ...body, leaseId: "l-1", ttlSeconds: 300, expiresAt: "2026-10-01T00:05:00.000Z" } },
			async releaseLease(id) { calls.push(["releaseLease", id]) },
		},
		close() { events.close() },
		...overrides,
	}
	return { root, workspace, calls, releases, ...await serve(t, workspace) }
}

async function publicationFixture(t) {
	const { WorkspaceFiles } = await import("../lib/workspace-files.js")
	const root = await fs.mkdtemp(path.join(os.homedir(), ".gc-file-"))
	await fs.chmod(root, 0o700)
	const workspaceDir = path.join(root, "workspace")
	await fs.mkdir(workspaceDir, { mode: 0o2775 })
	const workspace = await WorkspaceFiles.open({ workspaceDir, filesStateDir: path.join(root, "private"), filesAgentUids: [20001], filesWorkerUids: [20003], rgBin: "rg" }, logger)
	t.after(async () => { await workspace.close(); await fs.rm(root, { recursive: true, force: true }) })
	return { workspace, root: workspaceDir, ...await serve(t, workspace) }
}

test("relay fencing rejects stale uploads before replacing bytes or accepting an operation", async (t) => {
	const f = await publicationFixture(t)
	await fs.writeFile(path.join(f.root, "a.txt"), "original bytes")
	const own = await (await f.request("/files/info")).json()
	for (const [name, value] of [["X-GC-Workspace-ID", "replacement-workspace"], ["X-GC-Workspace-Epoch", "old-epoch"]]) {
		const operationId = `stale-${name}`
		const response = await f.request(`/files/upload?path=a.txt&mode=force-replace&operationId=${operationId}`, { method: "PUT", body: "wrong bytes", headers: { "X-GC-Workspace-ID": own.workspaceId, "X-GC-Workspace-Epoch": own.workspaceEpoch, [name]: value } })
		assert.equal(await fs.readFile(path.join(f.root, "a.txt"), "utf8"), "original bytes", "a rejected epoch must never publish bytes")
		assert.equal(response.status, 409)
		const error = await response.json()
		assert.equal(error.filesContractVersion, 1)
		assert.equal(error.agent, "file-service")
		assert.equal(error.error, "workspace_changed")
		assert.equal(error.operationId, operationId)
		assert.equal(error.state, "rejected")
		assert.equal((await f.request(`/files/operations/${operationId}`)).status, 404)
	}
	assert.equal(own.relayEpochFencingVersion, 1)
	const accepted = await f.request("/files/upload?path=a.txt&mode=force-replace&operationId=current", { method: "PUT", body: "current bytes", headers: { "X-GC-Workspace-ID": own.workspaceId, "X-GC-Workspace-Epoch": own.workspaceEpoch } })
	assert.equal(accepted.status, 200)
	assert.equal(await fs.readFile(path.join(f.root, "a.txt"), "utf8"), "current bytes")
})

test("relay fencing rejects capture and directory submissions without retained records or directories", async (t) => {
	const f = await publicationFixture(t)
	await fs.writeFile(path.join(f.root, "a.txt"), "source")
	const own = await (await f.request("/files/info")).json()
	const headers = { "content-type": "application/json", "X-GC-Workspace-ID": own.workspaceId, "X-GC-Workspace-Epoch": "old-epoch" }
	const capture = await f.request("/files/captures", { method: "POST", headers, body: JSON.stringify({ requestId: "stale-capture", path: "a.txt" }) })
	assert.equal(capture.status, 409)
	assert.equal((await capture.json()).requestId, "stale-capture")
	assert.equal((await f.request("/files/requests/stale-capture")).status, 404)
	const mkdir = await f.request("/files/mkdir", { method: "POST", headers, body: JSON.stringify({ operationId: "stale-dir", path: "new/nested", parents: true }) })
	assert.equal(mkdir.status, 409)
	assert.equal((await mkdir.json()).operationId, "stale-dir")
	await assert.rejects(fs.stat(path.join(f.root, "new")), { code: "ENOENT" })
	assert.equal((await f.request("/files/operations/stale-dir")).status, 404)
	assert.deepEqual(await f.workspace.state.list("captures"), [])
})

test("relay fencing rejects partial, malformed and duplicate identity headers, including repeated identical fields", async (t) => {
	const f = await fixture(t)
	const valid = { "X-GC-Workspace-ID": identity.workspaceId, "X-GC-Workspace-Epoch": identity.workspaceEpoch }
	for (const headers of [{ "X-GC-Workspace-ID": identity.workspaceId }, { "X-GC-Workspace-Epoch": identity.workspaceEpoch }, { ...valid, "X-GC-Workspace-ID": "bad.id" }, { ...valid, "X-GC-Workspace-Epoch": "bad epoch" }, { ...valid, "X-GC-Workspace-ID": [identity.workspaceId, identity.workspaceId] }, { ...valid, "X-GC-Workspace-Epoch": [identity.workspaceEpoch, identity.workspaceEpoch] }]) {
		const response = await new Promise((resolve, reject) => {
			const req = http.request(`${f.base}/files/upload?path=a.txt&operationId=bad-header`, { method: "PUT", headers }, (res) => {
				const chunks = []; res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }))
			})
			req.on("error", reject); req.end("must not be admitted")
		})
		assert.equal(response.status, 400)
		assert.equal(response.body.error, "invalid_workspace_fence")
		assert.equal(response.body.operationId, "bad-header")
	}
	assert.deepEqual(f.calls, [], "no upload handler or body admission")
	assert.equal((await f.request("/files/info", { headers: valid })).status, 200)
	assert.equal((await f.request("/files/info")).status, 200, "unfenced direct development remains supported")
})

test("relay fencing survives the access gate, including raw duplicate identity fields", async (t) => {
	const { default: gate } = await import("../gate.cjs")
	const f = await fixture(t)
	const gateFile = path.join(f.root, "gate")
	await fs.writeFile(gateFile, "a".repeat(64))
	const server = gate.createGateServer(gate.loadConfig({ RUNTIME_AUTH_DISABLED: "1", RUNTIME_GATE_SECRET_FILE: gateFile, RUNTIME_FILES_PORT: String(f.server.address().port) }), { logger: { log() {}, error() {} } })
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
	for (const [id, expected] of [[identity.workspaceId, 201], [[identity.workspaceId, identity.workspaceId], 400], ["wrong-workspace", 409]]) {
		const status = await new Promise((resolve, reject) => {
			const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/files/upload?path=a.txt&operationId=through-gate", method: "PUT", headers: { "X-GC-Workspace-ID": id, "X-GC-Workspace-Epoch": identity.workspaceEpoch } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)) })
			req.on("error", reject); req.end("bytes")
		})
		assert.equal(status, expected)
	}
	assert.equal(f.calls.filter(([name]) => name === "upload").length, 1)
})

test("v1 info is independent of agent liveness and missing files identify the failing tool", async (t) => {
	const f = await fixture(t)
	const info = await f.request("/files/info")
	assert.equal(info.status, 200, "file status must work without an ACP engine")
	assert.equal((await info.json()).filesContractVersion, 1)
	const missing = await f.request("/files/raw?path=missing")
	assert.equal(missing.status, 404)
	const error = await missing.json()
	assert.equal(error.error, "not_found")
	assert.equal(error.filesContractVersion, 1)
	assert.equal(error.agent, "file-service")
	assert.ok(error.tool && error.action)
})

test("v1 live raw uses weak comparison only for If-None-Match, never exact-source If-Match or If-Range", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "a.txt"), "abcdef")
	const raw = await f.request("/files/raw?path=a.txt")
	const tag = raw.headers.get("etag")
	assert.match(tag, /^W\/"[A-Za-z0-9_-]+"$/)
	assert.equal(raw.headers.get("content-encoding"), "identity")
	assert.equal(await raw.text(), "abcdef")
	for (const value of [tag, tag.slice(2), `"other", ${tag}`, "*"]) {
		const res = await f.request("/files/raw?path=a.txt", { headers: { "if-none-match": value, range: "bytes=1-2" } })
		assert.equal(res.status, 304)
		assert.equal(await res.text(), "")
	}
	for (const value of [tag, tag.slice(2), `"other", ${tag}`]) {
		const res = await f.request("/files/raw?path=a.txt", { headers: { "if-match": value, "if-none-match": "*" } })
		assert.equal(res.status, 412, "strong comparison and precondition order")
		assert.equal((await res.json()).error, "precondition_failed")
	}
	assert.equal((await f.request("/files/raw?path=a.txt", { headers: { "if-match": "*" } })).status, 200)
	for (const value of [tag, tag.slice(2), raw.headers.get("last-modified")]) {
		const res = await f.request("/files/raw?path=a.txt", { headers: { range: "bytes=1-2", "if-range": value } })
		assert.equal(res.status, 200)
		assert.equal(await res.text(), "abcdef")
	}
	const before = await fs.stat(path.join(f.root, "a.txt"))
	await fs.writeFile(path.join(f.root, "a.txt"), "ghijkl")
	await fs.utimes(path.join(f.root, "a.txt"), before.atime, before.mtime)
	const rewritten = await f.request("/files/raw?path=a.txt")
	assert.notEqual(rewritten.headers.get("etag"), tag)
	assert.equal(await rewritten.text(), "ghijkl")
})

test("v1 byte ranges cover suffix/open/clamped bounds, reject malformed/multiple ranges, and handle HEAD and empty files", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "a.txt"), "abcdef")
	for (const [range, text, bounds] of [["bytes=1-2", "bc", "1-2"], ["bytes=3-", "def", "3-5"], ["bytes=-2", "ef", "4-5"], ["bytes=2-99999999999999999999", "cdef", "2-5"], ["bytes=-20", "abcdef", "0-5"]]) {
		const res = await f.request("/files/raw?path=a.txt", { headers: { range } })
		assert.equal(res.status, 206, range)
		assert.equal(res.headers.get("content-range"), `bytes ${bounds}/6`)
		assert.equal(Number(res.headers.get("content-length")), text.length)
		assert.equal(await res.text(), text)
	}
	for (const range of ["bytes=6-", "bytes=4-2", "bytes=-0", "bytes=-", "bytes=0-1,3-4", "bytes=no", "items=0-1"]) {
		const res = await f.request("/files/raw?path=a.txt", { headers: { range } })
		assert.equal(res.status, 416, range)
		assert.equal(res.headers.get("content-range"), "bytes */6")
		assert.equal((await res.json()).error, "range_not_satisfiable")
	}
	const head = await f.request("/files/raw?path=a.txt", { method: "HEAD", headers: { range: "bytes=1-2" } })
	assert.equal(head.status, 200, "Range is defined only for GET")
	assert.equal(head.headers.get("content-length"), "6")
	assert.equal(await head.text(), "")
	await fs.writeFile(path.join(f.root, "empty"), "")
	for (const method of ["GET", "HEAD"]) {
		const res = await f.request("/files/raw?path=empty", { method })
		assert.equal(res.status, 200)
		assert.equal(res.headers.get("content-length"), "0")
		assert.equal(await res.text(), "")
	}
	const emptyRange = await f.request("/files/raw?path=empty", { headers: { range: "bytes=0-" } })
	assert.equal(emptyRange.status, 416)
	assert.equal(emptyRange.headers.get("content-range"), "bytes */0")
})

test("v1 protected raw honors strong conditions and holds capture/fragment readers through completion", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "a.txt"), "abcdef")
	for (const [kind, plural, id] of [["capture", "captures", "c-1"], ["fragment", "fragments", "f-1"]]) {
		const route = `/files/${plural}/${id}/raw`, tag = `"${kind}-${id}"`
		const partial = await f.request(route, { headers: { "if-match": `"stale", ${tag}`, "if-range": tag, range: "bytes=2-3" } })
		assert.equal(partial.status, 206)
		assert.equal(partial.headers.get("content-range"), "bytes 2-3/6", "fragment ranges are relative to retained bytes")
		assert.equal(await partial.text(), "cd")
		const notModified = await f.request(route, { headers: { "if-none-match": `W/${tag}` } })
		assert.equal(notModified.status, 304)
		assert.equal(await notModified.text(), "")
		assert.equal((await f.request(route, { headers: { "if-match": `W/${tag}` } })).status, 412)
		for (const value of [`W/${tag}`, '"old"', "Thu, 01 Jan 1970 00:00:00 GMT"]) {
			const whole = await f.request(route, { headers: { "if-range": value, range: "bytes=1-2" } })
			assert.equal(whole.status, 200)
			assert.equal(await whole.text(), "abcdef")
		}
		const head = await f.request(route, { method: "HEAD" })
		assert.equal(head.headers.get("etag"), tag)
		assert.equal(await head.text(), "")
	}
	await wait(10)
	assert.equal(f.releases.length, f.calls.filter(([name]) => name === "open").length)
})

test("v1 streaming failures destroy the response and release the source without appending JSON", async (t) => {
	let released = 0
	const broken = () => Readable.from((async function* () { yield Buffer.from("bytes-only"); await wait(10); throw Object.assign(new Error("read failed"), { code: "EIO" }) })())
	const f = await fixture(t, { captures: { async open() { return { source: capture("a.txt", "c-1", 100), handle: { createReadStream: broken }, async release() { released++ } } } } })
	const outcome = await new Promise((resolve, reject) => {
		const req = http.get(`${f.base}/files/captures/c-1/raw`, (res) => {
			let text = ""
			res.on("data", (chunk) => { text += chunk })
			res.on("end", () => reject(new Error("failed stream was acknowledged as complete")))
			res.on("error", () => resolve(text))
		})
		req.on("error", reject)
	})
	assert.equal(outcome, "bytes-only")
	await wait(10)
	assert.equal(released, 1)
})

test("v1 disconnecting a protected download releases its reader", async (t) => {
	let released = 0
	const f = await fixture(t, { captures: { async open() { return { source: capture("a.txt", "c-1", 1000000), handle: { createReadStream: () => Readable.from((async function* () { for (let n = 0; n < 1000; n++) { yield Buffer.alloc(1000); await wait(1) } })()) }, async release() { released++ } } } } })
	await new Promise((resolve, reject) => {
		const req = http.get(`${f.base}/files/captures/c-1/raw`, (res) => { res.once("data", () => { res.destroy(); resolve() }); res.on("error", () => {}) })
		req.on("error", reject)
	})
	for (let n = 0; !released && n < 100; n++) await wait(5)
	assert.equal(released, 1)
})

test("v1 disposition is header-safe, preserves UTF-8 names, and forces active content to attachment", async (t) => {
	const f = await fixture(t)
	for (const name of ['odd";é.txt', "active.html", "active.SVG", "image.png"]) {
		await fs.writeFile(path.join(f.root, name), "x")
		const res = await f.request(`/files/raw?path=${encodeURIComponent(name)}`)
		const disposition = res.headers.get("content-disposition")
		assert.equal(res.headers.get("x-content-type-options"), "nosniff")
		assert.match(disposition, /filename\*=UTF-8''/)
		assert.ok(!/[\r\n]/.test(disposition))
		assert.equal(disposition.startsWith("attachment;"), /\.(html|svg)$/i.test(name))
		assert.equal(await res.text(), "x")
	}
})

test("v1 upload streams only the accepted body, validates headers, and returns LocalOperation at top level", async (t) => {
	const f = await fixture(t)
	const digest = crypto.createHash("sha256").update("hello").digest("hex")
	const res = await f.request("/files/upload?path=a.txt&operationId=save-1&mode=replace", { method: "PUT", body: "hello", headers: { "x-gc-base-observation": "opaque-token", "x-content-sha256": digest, "x-gc-require-remote-persistable": "true", "if-match": "*", "content-type": "application/octet-stream" } })
	assert.equal(res.status, 201)
	const receipt = await res.json()
	assert.deepEqual(receipt, { filesContractVersion: 1, ...operation("save-1") })
	assert.equal(receipt.publishedObservation.token, "published-token")
	assert.deepEqual(f.calls[0], ["upload", { path: "a.txt", operationId: "save-1", mode: "replace", processingPolicy: "auto", baseObservation: "opaque-token", declaredSize: 5, declaredDigest: digest, requireRemotePersistable: true, ifMatch: "*", ifNoneMatch: undefined }])
	assert.deepEqual(f.calls[1], ["bytes", "hello"])
	const invalid = [
		["/files/upload?path=a.txt", {}, 400],
		["/files/upload?path=a.txt&operationId=bad%2Fid", {}, 400],
		["/files/upload?path=a.txt&operationId=x&mode=overwrite", {}, 400],
		["/files/upload?path=a.txt&operationId=x&mode=replace", {}, 400],
		["/files/upload?path=a.txt&operationId=x", { "x-content-sha256": "bad" }, 400],
		["/files/upload?path=a.txt&operationId=x", { "x-gc-require-remote-persistable": "yes" }, 400],
		["/files/upload?path=a.txt&operationId=x", { "content-encoding": "gzip" }, 415],
	]
	for (const [route, headers, status] of invalid) assert.equal((await f.request(route, { method: "PUT", body: "x", headers })).status, status, route)
	assert.equal(f.calls.filter(([name]) => name === "upload").length, 1)
})

test("v1 one PUT creates nested upload parents and exposes their durable operation receipt", async (t) => {
	const f = await publicationFixture(t)
	const digest = crypto.createHash("sha256").update("hello").digest("hex")
	const res = await f.request("/files/upload?path=new/deep/a.txt&operationId=nested-http", { method: "PUT", body: "hello", headers: { "x-content-sha256": digest } })
	assert.equal(res.status, 201)
	const receipt = await res.json()
	assert.equal(receipt.state, "committed")
	assert.equal(await fs.readFile(path.join(f.root, "new/deep/a.txt"), "utf8"), "hello")
	const parents = await (await f.request(`/files/operations/${receipt.parentOperationId}`)).json()
	assert.equal(parents.state, "committed")
	assert.equal(parents.action, "mkdir")
	const duplicate = await f.request("/files/upload?path=new/deep/a.txt&operationId=nested-http", { method: "PUT", body: "wrong", headers: { "x-content-sha256": digest } })
	assert.equal((await duplicate.json()).duplicate, true)
	assert.equal(await fs.readFile(path.join(f.root, "new/deep/a.txt"), "utf8"), "hello")
})

test("v1 invalid digest and conditional replacement leave missing upload parents untouched", async (t) => {
	const f = await publicationFixture(t)
	for (const [id, query, headers, status, error] of [["http-bad-digest", "", { "x-content-sha256": "0".repeat(64) }, 422, "digest_mismatch"], ["http-replace", "&mode=replace", { "x-gc-base-observation": "missing-token" }, 409, "source_changed"]]) {
		const res = await f.request(`/files/upload?path=${id}/deep/a.txt&operationId=${id}${query}`, { method: "PUT", body: "hello", headers })
		assert.equal(res.status, status)
		assert.equal((await res.json()).error, error)
		await assert.rejects(fs.stat(path.join(f.root, id)), { code: "ENOENT" })
	}
	const forced = await f.request("/files/upload?path=forced/deep/a.txt&operationId=http-forced&mode=force-replace", { method: "PUT", body: "hello" })
	assert.equal(forced.status, 200)
	assert.equal((await forced.json()).state, "committed")
	assert.equal(await fs.readFile(path.join(f.root, "forced/deep/a.txt"), "utf8"), "hello")
})

test("v1 duplicate upload replies before a replacement body arrives and drains without giving it to the service", async (t) => {
	let bytes = 0
	const f = await fixture(t, { async upload(readable) { readable.on("data", (chunk) => { bytes += chunk.length }); return { status: 200, operation: operation("already"), duplicate: true } } })
	await new Promise((resolve, reject) => {
		const req = http.request(`${f.base}/files/upload?path=a.txt&operationId=already`, { method: "PUT", headers: { "content-length": 1000000 } }, (res) => {
			let text = ""
			res.on("data", (chunk) => { text += chunk })
			res.on("end", () => { assert.equal(res.statusCode, 200); assert.equal(JSON.parse(text).duplicate, true); req.destroy(); resolve() })
		})
		req.on("error", (error) => { if (error.code !== "ECONNRESET") reject(error) })
		req.flushHeaders()
	})
	assert.equal(bytes, 0, "service accepts no bytes from the duplicate body")
})

test("v1 Content-Length is strict before service admission (including zero and unsafe integers)", async (t) => {
	const f = await fixture(t)
	for (const value of ["-1", "1e3", "1.5", "", "9007199254740992"]) {
		const req = Readable.from([]); req.method = "PUT"; req.headers = { "content-length": value }
		const chunks = []
		const res = { headersSent: false, destroyed: false, writeHead(status) { this.status = status; this.headersSent = true }, end(data) { chunks.push(data) } }
		await f.files.handle(req, res, new URL("http://files/files/upload?path=a.txt&operationId=length"))
		assert.equal(res.status, 400, value)
		assert.equal(JSON.parse(chunks[0]).error, "invalid_content_length")
	}
	const empty = await f.request("/files/upload?path=a.txt&operationId=empty", { method: "PUT", body: "" })
	assert.equal(empty.status, 201)
	assert.equal(f.calls.find(([name]) => name === "upload")[1].declaredSize, 0)
})

test("v1 JSON routes enforce a 64 KiB UTF-8 object body before any service mutation", async (t) => {
	let calls = 0
	const f = await fixture(t, { mkdir: (body) => { calls++; return { status: 201, operation: operation(body.operationId) } } })
	for (const [body, contentType, expected] of [["{", "application/json", 400], ["[]", "application/json", 400], ["null", "application/json", 400], ["{}", "text/plain", 415], [Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]), "application/json", 400]]) {
		assert.equal((await f.request("/files/mkdir", { method: "POST", body, headers: { "content-type": contentType } })).status, expected)
	}
	const body = JSON.stringify({ operationId: "mkdir", path: "d", padding: "x".repeat(65536) })
	const big = await f.request("/files/mkdir", { method: "POST", body, headers: { "content-type": "application/json" } })
	assert.equal(big.status, 413)
	const streamed = await f.request("/files/mkdir", { method: "POST", body: Readable.from([Buffer.from(body.slice(0, 40000)), Buffer.from(body.slice(40000))]), duplex: "half", headers: { "content-type": "application/json" } })
	assert.equal(streamed.status, 413)
	assert.equal(calls, 0)
	const emptyObject = { operationId: "mkdir", path: "d", padding: "" }
	const exact = JSON.stringify({ ...emptyObject, padding: "x".repeat(65536 - Buffer.byteLength(JSON.stringify(emptyObject))) })
	assert.equal(Buffer.byteLength(exact), 65536)
	assert.equal((await f.request("/files/mkdir", { method: "POST", body: exact, headers: { "content-type": "application/json" } })).status, 201)
	assert.equal(calls, 1)
})

test("v1 error provenance and Retry-After survive delegation; unknown routes and methods are distinct", async (t) => {
	const failure = new FileError(429, "capacity", "Queue full", { agent: "file-service", tool: "file-captures", action: "Retry after a job finishes.", retryAfter: 2, jobId: "j-1" })
	const f = await fixture(t, { list() { throw failure } })
	const res = await f.request("/files/list")
	assert.equal(res.status, 429)
	assert.equal(res.headers.get("retry-after"), "2")
	assert.deepEqual(await res.json(), { filesContractVersion: 1, ...failure.toJSON() })
	const wrongMethod = await f.request("/files/raw", { method: "POST" })
	assert.equal(wrongMethod.status, 405)
	assert.equal(wrongMethod.headers.get("allow"), "GET, HEAD")
	assert.equal((await f.request("/files/no-such-route")).status, 404)
	assert.equal((await f.request("/files/captures/bad%2Fid")).status, 400)
})

test("v1 watch awaits asynchronous admission and propagates its failures", async (t) => {
	const f = await fixture(t, { events: { async attach() { await wait(5); throw new FileError(503, "storage_unavailable", "Watch unavailable", { tool: "file-events", action: "Restart events." }) } } })
	const res = await f.request("/files/watch?path=reports")
	assert.equal(res.status, 503)
	assert.equal((await res.json()).tool, "file-events")
})

test("v1 search gets a disconnect signal and keeps the requested scope", async (t) => {
	let started, aborted
	const entered = new Promise((resolve) => { started = resolve }), stopped = new Promise((resolve) => { aborted = resolve })
	const f = await fixture(t, { async search(params, signal) {
		assert.equal(params.path, "reports")
		assert.equal(params.q, "needle")
		assert.equal(signal instanceof AbortSignal, true)
		started()
		await new Promise((resolve) => signal.addEventListener("abort", () => { aborted(); resolve() }, { once: true }))
		throw signal.reason
	} })
	const req = http.get(`${f.base}/files/search?q=needle&path=reports`)
	req.on("error", () => {})
	await entered; req.destroy()
	await Promise.race([stopped, wait(1000).then(() => { throw new Error("search was not cancelled") })])
})

test("v1 native same-UID workspace serves live reads and metadata but refuses protected publication", async (t) => {
	const { WorkspaceFiles } = await import("../lib/workspace-files.js")
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "files-native-http-v1-"))
	let workspace
	t.after(async () => { await workspace?.close(); await fs.rm(root, { recursive: true, force: true }) })
	const workspaceDir = path.join(root, "workspace")
	await fs.mkdir(workspaceDir)
	await fs.writeFile(path.join(workspaceDir, "a.txt"), "hello 🌍")
	const config = { workspaceDir, filesStateDir: path.join(root, "private"), gatewayStateDir: path.join(root, "gateway"), filesAgentUids: [process.geteuid()], filesWorkerUids: [process.geteuid()], rgBin: "rg" }
	workspace = await WorkspaceFiles.open(config, logger)
	const f = await serve(t, workspace)
	assert.equal((await f.request("/files/info")).status, 200)
	await workspace.index.ready
	const page = await (await f.request("/files/list?limit=1")).json()
	assert.equal(page.filesContractVersion, 1)
	assert.equal(page.items[0].path, "a.txt")
	assert.equal(page.count.relation, "exact")
	const text = await (await f.request("/files/text?path=a.txt&maxBytes=8")).json()
	assert.equal(text.text, "hello ")
	assert.equal(text.complete, false)
	assert.equal(text.sha256, undefined)
	assert.equal((await f.request("/files/raw?path=missing")).status, 404)
	const captureResponse = await f.request("/files/captures", { method: "POST", body: JSON.stringify({ requestId: "unsafe", path: "a.txt" }), headers: { "content-type": "application/json" } })
	assert.equal(captureResponse.status, 503)
	assert.equal((await captureResponse.json()).error, "capture_store_unavailable")
	const upload = await f.request("/files/upload?path=new.txt&operationId=unsafe", { method: "PUT", body: "must not publish" })
	assert.equal(upload.status, 503)
	await assert.rejects(fs.stat(path.join(workspaceDir, "new.txt")), { code: "ENOENT" })
})

test("v1 transport decoding rejects malformed UTF-8 instead of rebinding to a replacement-character filename", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.root, "�.txt"), "literal replacement character")
	await fs.writeFile(path.join(f.root, "%2e%2e.txt"), "literal percent encoding")
	assert.equal((await f.request("/files/raw?path=%FF.txt")).status, 400)
	assert.equal((await f.request("/files/raw?path=%E2%82.txt")).status, 400)
	assert.equal((await f.request("/files/raw?path=%GG.txt")).status, 400)
	assert.equal(await (await f.request("/files/raw?path=%EF%BF%BD.txt")).text(), "literal replacement character")
	assert.equal(await (await f.request("/files/raw?path=%252e%252e.txt")).text(), "literal percent encoding")
})

test("v1 active source bytes cannot be served with an executable runtime-origin MIME type", async (t) => {
	const f = await fixture(t)
	for (const name of ["page.html", "diagram.svg", "code.js", "theme.css"]) {
		await fs.writeFile(path.join(f.root, name), "untrusted source")
		const response = await f.request(`/files/raw?path=${name}`)
		assert.equal(response.status, 200)
		assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8")
		assert.match(response.headers.get("content-disposition"), /^attachment;/)
		assert.equal(response.headers.get("x-content-type-options"), "nosniff")
		assert.equal(await response.text(), "untrusted source")
	}
})
