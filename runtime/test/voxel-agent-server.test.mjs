import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { spawn } from "node:child_process"
import { setTimeout as wait } from "node:timers/promises"
import { test } from "node:test"
import Database from "better-sqlite3"
import { createFilesServer, loadFilesConfig } from "../files-server.js"
import { createVoxelAgentReferences } from "../lib/voxel-agent-references.js"
import { defaultSpatialMetadata } from "../lib/voxel/voxel-artifact.js"
import { FileError } from "../lib/file-contract.js"
import { fail } from "../lib/voxel-request.js"

const logger = { error() {}, info() {}, warn() {} }, conversationId = "ses_root"
function request(socketPath, body, { route = "/agent/voxels", method = "POST", headers = {}, raw, chunks } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ socketPath, path: route, method, headers: { "content-type": "application/json", ...headers } }, (res) => {
			const parts = []; res.on("data", (b) => parts.push(b)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(parts).toString()) }))
		})
		req.on("error", reject)
		if (chunks) { for (const chunk of chunks) req.write(chunk); req.end() }
		else req.end(raw ?? JSON.stringify(body))
	})
}
function discardReply(socketPath, body) {
	return new Promise((resolve, reject) => {
		const req = http.request({ socketPath, path: "/agent/voxels", method: "POST", headers: { "content-type": "application/json" } }, (res) => { assert.equal(res.statusCode, 200); req.destroy(); resolve() })
		req.on("error", reject); req.end(JSON.stringify(body))
	})
}
async function fixture(t, extra = {}) {
	const root = await fs.mkdtemp(path.join(os.homedir(), ".gc-voxel-socket-")), workspaceDir = path.join(root, "workspace"), socketDir = path.join(root, "socket")
	await fs.mkdir(workspaceDir); await fs.mkdir(socketDir, { mode: 0o750 })
	const socketPath = path.join(socketDir, "voxels.sock")
	const config = { workspaceDir, filesStateDir: path.join(root, "private"), filesAgentUids: [20001], filesWorkerUids: [20003], filesWorkbookWorkerEnabled: false, filesGisWorkerEnabled: false, voxelAgentEnabled: true, voxelAgentSocket: socketPath, voxelAgentGid: process.getegid(), ...extra }
	let app
	const start = async (deferWorkspace = false) => { app = await createFilesServer({ config, secret: "a".repeat(64), logger, deferWorkspace }) }
	t.after(async () => { await app?.shutdown(); await fs.rm(root, { recursive: true, force: true }) })
	await start()
	const scope = (await request(socketPath, { action: "capabilities", scope: null, conversationId })).body.scope
	const send = async (action, args = {}, status = 200) => { const reply = await request(socketPath, { action, scope, conversationId, ...args }); assert.equal(reply.status, status, JSON.stringify(reply.body)); return reply.body }
	const settle = async (key) => {
		for (let n = 0; n < 500; n++) {
			const reply = await send("status", { idempotencyKey: key }), service = app.files.workspace.voxels
			// A terminal receipt can precede publisher cleanup and slot release.
			const busy = service.active > 0 || Object.values(service.gauges()).some((value) => typeof value === "number" && value > 0)
			if (["ready", "failed"].includes(reply.result.phase) && !busy) return reply
			await wait(10)
		}
		throw new Error(`Voxel did not settle: ${JSON.stringify(app.files.workspace.voxels.gauges())}`)
	}
	return { root, workspaceDir, socketDir, socketPath, config, scope, send, settle, get app() { return app }, async restart({ deferWorkspace = false } = {}) { await app.shutdown(); await start(deferWorkspace) } }
}
function indexed(prepared, shape = [16, 16, 12]) {
	return { kind: "indexed-grid", revision: null, recipe: { schemaVersion: 1, algorithm: "geocluster-indexed-v1", name: "Pattern", scope: prepared.description.scope, indices: { x: 0, y: 1, z: 2, base: 0 }, shape, placement: { origin: [0, 0, 0], spacing: [1, 1, 1], unit: "grid-unit", horizontalReference: { type: "unreferenced", definition: "" }, verticalReference: null }, field: { kind: "categorical", column: 3, name: "Class", trim: false }, numbers: { decimal: ".", thousands: "none", missingTokens: [], sentinels: [], censored: "exclude" }, emptyCells: "forbid", predecessor: null } }
}
async function smallHead(f, key = "small") {
	await fs.writeFile(path.join(f.workspaceDir, `${key}.csv`), "x,y,z,value\n0,0,0,0\n1,0,0,B\n")
	const prepared = (await f.send("prepare", { path: `${key}.csv` })).result, submission = indexed(prepared, [2, 1, 1])
	await f.send("submit", { submission, idempotencyKey: key })
	return { submission, receipt: await f.settle(key) }
}

async function browserRequest(f, body) {
	if (!f.app.server.listening) await new Promise((r) => f.app.server.listen(0, "127.0.0.1", r))
	const res = await fetch(`http://127.0.0.1:${f.app.server.address().port}/voxels`, { method: "POST", headers: { "x-gc-gate": "a".repeat(64), "content-type": "application/json" }, body: JSON.stringify(body) })
	return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.json() }
}

test("Unix public evidence: paused real lazy verification preserves 503 retry and availability across adapters", async (t) => {
	const f = await fixture(t), { receipt } = await smallHead(f), artifact = receipt.geoclusterVoxel.artifact
	await f.restart()
	const service = f.app.files.workspace.voxels, worker = service.worker.bind(service)
	let release, entered
	const block = new Promise((r) => { release = r }), entry = new Promise((r) => { entered = r })
	service.worker = async (data) => { if (data.action === "verify") { entered(); await block }; return worker(data) }
	try {
		const first = await request(f.socketPath, { action: "inspect", scope: f.scope, conversationId, artifact })
		assert.equal(first.status, 503); assert.equal(first.body.error, "artifact_verifying")
		assert.equal(first.body.retryAfter, 1); assert.equal(first.headers["retry-after"], "1")
		assert.deepEqual(first.body.availability, { state: "checking", publicationState: "ready", verificationState: "checking", retryAt: null, error: null })
		await Promise.race([entry, wait(5000).then(() => { throw new Error("Lazy verification did not reach the real worker") })])
		const unix = await request(f.socketPath, { action: "inspect", scope: f.scope, conversationId, artifact })
		const browser = await browserRequest(f, { action: "inspect", artifact, options: {} })
		assert.equal(browser.status, 503, JSON.stringify(browser.body)); assert.equal(unix.headers["retry-after"], browser.headers["retry-after"])
		assert.deepEqual(unix.body, browser.body, "the same live verification exposes one public error shape")
	} finally { release() }
	await Promise.all([...service.pending])
	const inspected = await f.send("inspect", { artifact, options: { indices: [[1, 0, 0]] } })
	assert.equal(inspected.result.integrity, "verified"); assert.equal(inspected.result.cells[0].value, "B")
})

test("Unix public evidence: admitted validation capacity preserves delay, byte limits and runtime action", async (t) => {
	const f = await fixture(t), { submission } = await smallHead(f), service = f.app.files.workspace.voxels, worker = service.worker.bind(service)
	const evidence = { retryAfter: 7, retryAt: "2026-10-10T12:00:07.000Z", requiredBytes: 4096, availableBytes: 1024, limits: { tableRetentionBytes: 1024 }, action: "Raise tableRetentionBytes or select fewer rows, then retry validation." }
	// A public capacity failure at the numerical effect boundary still traverses
	// the real source resolution, admission, validation and adapter paths.
	service.worker = async (data) => { if (data.action === "indexed-grid" && !data.materialize) throw Object.assign(fail(429, "capacity", "Validation needs more retained table capacity."), evidence, { privatePath: f.config.filesStateDir, cause: new Error(f.config.filesStateDir) }); return worker(data) }
	const unix = await request(f.socketPath, { action: "validate", scope: f.scope, conversationId, submission })
	assert.equal(unix.status, 429); assert.equal(unix.headers["retry-after"], "7")
	for (const [key, value] of Object.entries(evidence)) assert.deepEqual(unix.body[key], value, key)
	assert.equal(unix.body.agent, "voxel-service"); assert.equal(unix.body.tool, "voxels")
	assert.ok(!JSON.stringify(unix.body).includes(f.config.filesStateDir), "unlisted private evidence is never serialized")
	const browser = await browserRequest(f, { action: "validate", submission })
	assert.equal(browser.status, 429, JSON.stringify(browser.body)); assert.deepEqual(unix.body, browser.body)
	assert.equal(unix.headers["retry-after"], browser.headers["retry-after"])
	service.worker = worker
	assert.equal((await f.send("validate", { submission })).result.scanComplete, true, "failed validation releases its admitted slot")
})

test("Unix public evidence: FileError retry metadata survives sanitization but private and malformed fields do not", async (t) => {
	const f = await fixture(t), ws = f.app.files.workspace
	await fs.writeFile(path.join(f.workspaceDir, "retry.csv"), "x,y,z,value\n0,0,0,B\n")
	const capture = ws.captures.create.bind(ws.captures), retryAt = "2026-10-10T12:00:09.000Z"
	for (const [error, expected] of [
		[new FileError(429, "capacity", `Cannot read ${f.config.filesStateDir}`, { retryAfter: 9, retryAt, action: f.config.filesStateDir, availability: { path: f.config.filesStateDir }, limits: { path: f.config.filesStateDir } }), { retryAfter: 9, retryAt }],
		[new FileError(429, "capacity", f.config.filesStateDir, { retryAfter: `${f.config.filesStateDir}\r\nprivate: secret`, retryAt: f.config.filesStateDir }), {}],
		[Object.assign(new Error(f.config.filesStateDir), { code: "EIO", retryAfter: 9, retryAt }), {}],
	]) {
		ws.captures.create = async () => { throw error }
		const reply = await request(f.socketPath, { action: "prepare", scope: f.scope, conversationId, path: "retry.csv" })
		assert.equal(reply.status, error.status || 503)
		assert.equal(reply.body.retryAfter, expected.retryAfter); assert.equal(reply.body.retryAt, expected.retryAt)
		assert.equal(reply.headers["retry-after"], expected.retryAfter === undefined ? undefined : String(expected.retryAfter))
		assert.ok(!JSON.stringify(reply.body).includes(f.config.filesStateDir), "private messages, actions and nested fields stay sanitized")
		assert.equal(reply.body.agent, "voxel-service"); assert.equal(reply.body.tool, "voxels")
	}
	ws.captures.create = capture
})

test("Unix completion boundary: a ready receipt precedes slot release", async (t) => {
	let release, entered
	const block = new Promise((r) => { release = r }), entry = new Promise((r) => { entered = r })
	const f = await fixture(t, { voxelLimits: { workers: 1 }, voxelCheckpoint: async (stage) => { if (stage === "ready") { entered(); await block } } })
	await fs.writeFile(path.join(f.workspaceDir, "boundary.csv"), "x,y,z,value\n0,0,0,B\n")
	const submission = indexed((await f.send("prepare", { path: "boundary.csv" })).result, [1, 1, 1])
	await f.send("submit", { submission, idempotencyKey: "boundary" })
	try {
		await Promise.race([entry, wait(5000).then(() => { throw new Error("Publisher did not reach ready checkpoint") })])
		const ready = await f.send("status", { idempotencyKey: "boundary" })
		assert.equal(ready.result.phase, "ready")
		await f.send("resolve", { reference: ready.geoclusterVoxel })
		const capacity = await f.send("validate", { submission }, 429)
		assert.equal(capacity.error, "capacity", "an occupied publisher slot is legitimate capacity, even with a ready receipt")
		release(); await f.settle("boundary")
		assert.equal((await f.send("validate", { submission })).result.scanComplete, true)
	} finally { release() }
})

test("Unix agent listener: complete 16x16x12 categorical creation, one-edit full revision, retained key and restart without duplicate publication", async (t) => {
	const f = await fixture(t, { filesLimits: { captureInlineBytes: 1 } })
	const lines = ["x,y,z,value"]
	for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) for (let z = 0; z < 12; z++) lines.push(`${x},${y},${z},${(x + y + z) % 2 ? "B" : "0"}`)
	const bytes = `${lines.join("\n")}\n`; await fs.writeFile(path.join(f.workspaceDir, "pattern.csv"), bytes)
	const prepared = (await f.send("prepare", { path: "pattern.csv" })).result
	assert.equal(prepared.profile, "csv"); assert.equal(prepared.source.sha256, crypto.createHash("sha256").update(bytes).digest("hex"))
	assert.equal(prepared.description.rows, 3072); assert.equal(prepared.description.columns, 4)
	assert.deepEqual(prepared.description.headers.map((h) => h.label), ["x", "y", "z", "value"])
	assert.ok((await f.app.files.workspace.state.list("jobs")).some((j) => j.type === "capture" && j.state === "succeeded"), "prepare waits for asynchronous complete digest")
	const submission = indexed(prepared), validated = (await f.send("validate", { submission })).result
	assert.equal(validated.scanComplete, true); assert.deepEqual(validated.blockingErrors, [])
	await discardReply(f.socketPath, { action: "submit", scope: f.scope, conversationId, submission, idempotencyKey: "initial" })
	const initial = await f.settle("initial")
	assert.equal(initial.geoclusterVoxel.outcome, "named-created"); assert.equal(initial.geoclusterVoxel.summary.validCells, 3072)
	const head = (await f.send("resolve", { reference: initial.geoclusterVoxel })).result
	const destination = `runs/${conversationId}/results/replacement.csv`
	const preparedRevision = (await f.send("prepare", { artifact: head.artifact, destination, options: { edits: [{ index: [15, 15, 11], valid: true, value: 'A,"quoted"\nlabel' }] } })).result
	assert.equal(preparedRevision.csv, undefined); assert.equal(preparedRevision.rows, 3072)
	const upload = (await f.app.files.workspace.state.list("operations")).find((op) => op.action === "upload" && op.intent.path === destination)
	assert.equal(upload.intent.mode, "create"); assert.equal(upload.intent.processingPolicy, "skip")
	assert.equal(preparedRevision.source.revision, `capture:${upload.publishedSource.captureId}`, "bind the upload's exact retained bytes, not a later pathname capture")
	const revision = { kind: "indexed-grid", recipe: preparedRevision.recipe, revision: { voxelId: head.voxelId, expectedHeadRevision: head.headRevision, base: head.artifact } }
	assert.deepEqual((await f.send("validate", { submission: revision })).result.blockingErrors, [])
	await f.send("submit", { submission: revision, idempotencyKey: "revision" })
	const updated = await f.settle("revision"); assert.equal(updated.geoclusterVoxel.outcome, "head-advanced")
	const inspected = (await f.send("inspect", { artifact: updated.geoclusterVoxel.artifact, options: { indices: [[0, 0, 0], [15, 15, 11], [1, 0, 0]] } })).result
	assert.deepEqual(inspected.cells.map((c) => [c.valid, c.value]), [[true, "0"], [true, 'A,"quoted"\nlabel'], [true, "B"]])
	await f.send("status", { idempotencyKey: "initial" })
	assert.deepEqual((await f.send("references")).references.at(-1).artifact, updated.geoclusterVoxel.artifact, "old status cannot move the remembered head backwards")
	const exactOld = await f.send("inspect", { artifact: initial.geoclusterVoxel.artifact, options: { limit: 1 } })
	assert.equal(exactOld.geoclusterVoxel.named.voxelId, head.voxelId, "exact historical inspection retains the known logical association")
	await f.restart()
	assert.deepEqual((await f.send("references")).references.at(-1).artifact, updated.geoclusterVoxel.artifact)
	assert.equal((await f.send("submit", { submission: revision, idempotencyKey: "revision" })).result.operation.id, updated.result.id)
	assert.equal((await f.send("resolve", { reference: initial.geoclusterVoxel })).result.headRevision, updated.geoclusterVoxel.named.headRevision, "a hint resolves today's head")
	assert.equal((await f.app.files.workspace.state.list("voxel-artifacts")).length, 2)
	const ws = f.app.files.workspace, registered = await ws.state.get("voxel-artifacts", updated.geoclusterVoxel.artifact.artifactId), captured = await ws.state.get("captures", registered.members.values.source.revision.slice(8))
	await fs.unlink(ws.captures.blobPath(captured))
	const unavailable = (await f.send("resolve", { reference: initial.geoclusterVoxel })).result
	assert.deepEqual(unavailable.artifact, updated.geoclusterVoxel.artifact); assert.equal(unavailable.availability.state, "unchecked", "metadata lookup does not verify arrays or fall back to an older artifact")
	await f.send("inspect", { artifact: unavailable.artifact }, 503)
	const stat = await fs.lstat(f.socketPath); assert.ok(stat.isSocket()); assert.equal(stat.mode & 0o777, 0o660); assert.equal(stat.uid, process.geteuid()); assert.equal(stat.gid, process.getegid())
	await f.app.shutdown(); await assert.rejects(fs.lstat(f.socketPath), { code: "ENOENT" })
})

test("restricted Unix HTTP rejects hostile surfaces, credentials, malformed bytes and oversized streamed JSON", async (t) => {
	const f = await fixture(t), body = { action: "references", scope: f.scope, conversationId }
	for (const route of ["/", "/files/info", "/internal/files/drain", "/voxels", "/agent/voxels?x=1", "/agent/voxels/", "/agent/%76oxels"]) assert.equal((await request(f.socketPath, body, { route })).status, 404, route)
	for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) assert.equal((await request(f.socketPath, body, { method })).status, 405, method)
	assert.equal((await request(f.socketPath, body, { headers: { "x-gc-gate": "a".repeat(64), "x-gc-files-control": "b".repeat(64) } })).status, 200, "Unix permissions, not private credentials, admit requests")
	for (const raw of ["{", "[]", Buffer.from([0xff])]) assert.equal((await request(f.socketPath, null, { raw })).status, 400)
	assert.equal((await request(f.socketPath, body, { headers: { "content-encoding": "gzip" } })).status, 415)
	const oversized = await request(f.socketPath, null, { chunks: ["{", Buffer.alloc(1024 * 1024, 32), "}"] })
	assert.equal(oversized.status, 413)
	assert.equal((await request(f.socketPath, { ...body, action: "constructor" })).status, 400)
	assert.equal((await request(f.socketPath, { ...body, credential: "private" })).status, 400)
	assert.equal(oversized.headers["cache-control"], "no-store")
	assert.ok(!JSON.stringify(oversized.body).includes(f.config.filesStateDir))
})

test("stale scope and private/foreign/symlink sources reject before capture, upload or reference effects", async (t) => {
	const f = await fixture(t), ws = f.app.files.workspace
	await fs.mkdir(path.join(f.workspaceDir, "runs/ses_other/results"), { recursive: true }); await fs.writeFile(path.join(f.workspaceDir, "runs/ses_other/results/data.csv"), "x\nsecret\n")
	await fs.writeFile(path.join(f.workspaceDir, ".env"), "PRIVATE_TOKEN=secret")
	await fs.symlink(".env", path.join(f.workspaceDir, "alias.csv")); await fs.symlink(f.config.filesStateDir, path.join(f.workspaceDir, "store"))
	const before = await ws.state.list("requests")
	for (const resource of [".env", ".runtime/data.csv", "runs/ses_other/results/data.csv", "alias.csv", "store/files.sqlite"]) {
		const reply = await request(f.socketPath, { action: "prepare", scope: f.scope, conversationId, path: resource }); assert.ok([400, 403, 409].includes(reply.status), JSON.stringify(reply))
	}
	assert.deepEqual(await ws.state.list("requests"), before, "reject hostile target paths before creating capture receipts")
	const { receipt } = await smallHead(f)
	for (const args of [{ action: "prepare", path: "small.csv" }, { action: "prepare", artifact: receipt.geoclusterVoxel.artifact, destination: `runs/${conversationId}/results/stale.csv` }, { action: "submit", submission: {}, idempotencyKey: "stale" }, { action: "references" }]) {
		const reply = await request(f.socketPath, { ...args, scope: { ...f.scope, workspaceEpoch: "old" }, conversationId }); assert.equal(reply.status, 409)
	}
	const records = await ws.state.list("operations")
	await f.send("prepare", { artifact: receipt.geoclusterVoxel.artifact, destination: "runs/ses_other/results/wrong.csv" }, 400)
	await fs.symlink("../../../.env", path.join(f.workspaceDir, "runs/ses_other/results/alias.csv"))
	await fs.mkdir(path.join(f.workspaceDir, `runs/${conversationId}`), { recursive: true }); await fs.symlink("../../runs/ses_other/results", path.join(f.workspaceDir, `runs/${conversationId}/results`))
	await f.send("prepare", { artifact: receipt.geoclusterVoxel.artifact, destination: `runs/${conversationId}/results/alias.csv` }, 403)
	assert.deepEqual(await ws.state.list("operations"), records, "reject symlink destination parents before upload admission")
	assert.deepEqual(await ws.voxels.list({ idempotencyKey: "stale" }), [])
	const foreign = (await ws.captures.create({ requestId: crypto.randomUUID(), path: "runs/ses_other/results/data.csv", computeDigest: true })).source
	const source = { root: "workspace", resourceId: foreign.ref.path, path: foreign.ref.path, sha256: foreign.digest.sha256, revision: `capture:${foreign.captureId}` }
	const foreignSubmission = { kind: "import-metadata", recipe: { schemaVersion: 1, source, metadata: defaultSpatialMetadata("foreign.npy"), defaults: [], predecessor: null }, revision: null }
	await f.send("validate", { submission: foreignSubmission }, 400)
	await f.send("submit", { submission: foreignSubmission, idempotencyKey: "foreign" }, 400)
	assert.deepEqual(await ws.voxels.list({ idempotencyKey: "foreign" }), [], "known captured bindings cannot bypass the conversation path policy")
})

test("replacement create-only publication refuses existing sources and binds bytes despite a later pathname edit", async (t) => {
	const f = await fixture(t), { receipt } = await smallHead(f), ws = f.app.files.workspace, destination = `runs/${conversationId}/results/replacement.csv`
	await fs.mkdir(path.dirname(path.join(f.workspaceDir, destination)), { recursive: true }); await fs.writeFile(path.join(f.workspaceDir, destination), "existing source")
	await f.send("prepare", { artifact: receipt.geoclusterVoxel.artifact, destination }, 409)
	assert.equal(await fs.readFile(path.join(f.workspaceDir, destination), "utf8"), "existing source")
	await fs.unlink(path.join(f.workspaceDir, destination))
	const upload = ws.upload.bind(ws)
	ws.upload = async (readable, input) => { assert.ok(readable instanceof Readable); const result = await upload(readable, input); await fs.writeFile(path.join(f.workspaceDir, destination), "later edit"); return result }
	const prepared = (await f.send("prepare", { artifact: receipt.geoclusterVoxel.artifact, destination })).result
	assert.equal((await f.send("validate", { submission: { kind: "indexed-grid", recipe: prepared.recipe, revision: null } })).result.scanComplete, true)
})

test("references serialize jittered updates, retain at most 16 deduped operations, upgrade accepted receipts and fence epochs", async (t) => {
	const f = await fixture(t), ws = f.app.files.workspace, { receipt } = await smallHead(f), refs = createVoxelAgentReferences(ws), other = createVoxelAgentReferences(ws), key = { scope: f.scope, conversationId }
	for (let round = 0; round < 3; round++) {
		await Promise.all(Array.from({ length: 24 }, async (_, n) => { await wait(Math.random() * 15); const ref = { ...receipt.geoclusterVoxel, operationId: `ref-${round}-${n}`, outcome: "artifact-saved" }; delete ref.named; await (n % 2 ? refs : other).remember(key, ref) }))
		const kept = await refs.list(key); assert.equal(kept.length, 16); assert.equal(new Set(kept.map((r) => r.operationId)).size, 16)
	}
	const ready = { ...receipt.geoclusterVoxel, operationId: "upgrade" }; delete ready.named; ready.outcome = "artifact-saved"
	const accepted = { ...ready, artifact: null, outcome: "accepted" }
	await refs.remember(key, accepted); await other.remember(key, ready); await refs.remember(key, accepted)
	assert.deepEqual((await refs.list(key)).find((r) => r.operationId === "upgrade"), ready)
	assert.deepEqual(await refs.list({ scope: f.scope, conversationId: "ses_unrelated" }), [])
	assert.equal((await f.send("status", { idempotencyKey: "small" })).result.id, receipt.result.id, "reference eviction does not erase retained-key discovery")
	assert.equal((await ws.state.list("voxel-artifacts")).length, 1)
	const old = ws.identity; ws.identity = { ...old, workspaceEpoch: "new" }
	await assert.rejects(refs.remember(key, ready), { status: 409 }); await assert.rejects(refs.list(key), { status: 409 })
	await assert.rejects(createVoxelAgentReferences(ws).list({ ...key, scope: ws.identity }), { status: 409 }, "a new facade cannot relabel the retained FileState epoch")
	ws.identity = old
	await f.app.shutdown()
	const db = new Database(path.join(f.config.filesStateDir, "files.sqlite")); db.prepare("UPDATE identity SET workspace_epoch = ?").run(crypto.randomUUID()); db.close()
	await f.restart()
	assert.equal((await request(f.socketPath, { action: "references", scope: old, conversationId })).status, 409)
	assert.deepEqual((await request(f.socketPath, { action: "references", scope: f.app.files.workspace.identity, conversationId })).body.references, [])
})

test("workbook preparation uses the provider's exact capture and stored worksheet profile", async (t) => {
	const reader = {
		availability: { state: "available", build: "agent-workbook-fixture" }, limits: {}, async init() {},
		async parse({ handle, outputPath }) {
			const bytes = await handle.readFile(), db = new Database(outputPath)
			db.exec("CREATE TABLE rows(sheet TEXT,row INTEGER,cells TEXT,PRIMARY KEY(sheet,row))")
			for (const [row, values] of [[0, ["x", "y", "z", "value"]], [1, [0, 0, 0, "0"]], [2, [1, 0, 0, "B"]]]) db.prepare("INSERT INTO rows VALUES(?,?,?)").run("sheet-0", row, JSON.stringify(Object.fromEntries(values.map((raw, column) => [column, { type: typeof raw === "number" ? "n" : "s", raw, display: String(raw), formula: null, cache: "not-formula", format: null }]))))
			db.close(); await fs.chmod(outputPath, 0o400)
			return { schemaVersion: 1, parser: "agent-workbook-fixture", origin: "fresh", dateSystem: "1900", sheets: [{ id: "sheet-0", ordinal: 0, name: "Data", visibility: "visible", kind: "worksheet", rows: 3, columns: 4, indexedRows: 3, storedRange: "A1:D3", populatedCells: 12, merges: [], modes: ["stored", "formula"], warnings: [] }], warnings: [], inputSha256: crypto.createHash("sha256").update(bytes).digest("hex"), metrics: { durationMs: 1, peakRssKiB: 100, inputBytes: bytes.length, outputBytes: (await fs.stat(outputPath)).size } }
		},
	}
	const f = await fixture(t, { filesWorkbookReader: reader })
	await fs.writeFile(path.join(f.workspaceDir, "book.xlsx"), "captured workbook")
	const prepared = (await f.send("prepare", { path: "book.xlsx", options: { sheet: "sheet-0", headerRows: [0] } })).result
	assert.equal(prepared.profile, "workbook-stored"); assert.equal(prepared.input.type, "workbook"); assert.equal(prepared.input.sheet, "sheet-0")
	assert.equal(prepared.description.rows, 2); assert.deepEqual(prepared.description.headers.map((h) => h.label), ["x", "y", "z", "value"])
	assert.equal((await f.send("validate", { submission: indexed(prepared, [2, 1, 1]) })).result.scanComplete, true)
	assert.equal((await f.app.files.workspace.workbooks.get(prepared.input.workbookId)).source.captureId, prepared.source.revision.slice(8))
})

test("delayed unknown status cannot erase a confirmed historical commitment after the named head advances", async (t) => {
	const f = await fixture(t), { receipt } = await smallHead(f), ws = f.app.files.workspace, original = receipt.geoclusterVoxel
	const prepared = (await f.send("prepare", { artifact: original.artifact, destination: `runs/${conversationId}/results/advanced.csv`, options: { edits: [{ index: [1, 0, 0], valid: true, value: "new" }] } })).result
	const submission = { kind: "indexed-grid", recipe: prepared.recipe, revision: { voxelId: original.named.voxelId, expectedHeadRevision: original.named.headRevision, base: original.artifact } }
	await f.send("submit", { submission, idempotencyKey: "advance" }); const advanced = await f.settle("advance")
	const delayed = { ...original, outcome: "named-outcome-unknown", named: { ...original.named, headRevision: null } }
	await f.app.voxelAgent.references.remember({ scope: f.scope, conversationId }, delayed)
	const references = (await f.send("references")).references
	const retained = references.find((ref) => ref.operationId === original.operationId)
	assert.equal(retained.outcome, "named-created", "a confirmed historical commitment cannot become unknown")
	assert.deepEqual(retained.named, original.named, "keep the protected historical head binding")
	assert.deepEqual(references.at(-1).artifact, advanced.geoclusterVoxel.artifact)
	assert.deepEqual((await ws.voxels.namedResolve({ voxelId: original.named.voxelId })).artifact, advanced.geoclusterVoxel.artifact)
})

test("NPY preparation returns a complete captured source metadata profile; TSV returns dimensions and headers", async (t) => {
	const f = await fixture(t)
	await fs.writeFile(path.join(f.workspaceDir, "table.tsv"), "x\ty\tz\tvalue\n0\t0\t0\t0\n")
	const table = (await f.send("prepare", { path: "table.tsv" })).result
	assert.equal(table.profile, "tsv"); assert.equal(table.input.delimiter, "\t"); assert.equal(table.description.rows, 1); assert.equal(table.description.columns, 4)
	const h = "{'descr': '<f8', 'fortran_order': False, 'shape': (1, 1, 2), }", size = h.length + 1 + (64 - (10 + h.length + 1) % 64) % 64, bytes = Buffer.alloc(10 + size + 16, 32)
	bytes.set([147, 78, 85, 77, 80, 89, 1, 0]); bytes.writeUInt16LE(size, 8); bytes.write(h, 10); bytes[9 + size] = 10; bytes.writeDoubleLE(0, 10 + size); bytes.writeDoubleLE(-2, 18 + size)
	await fs.writeFile(path.join(f.workspaceDir, "volume.npy"), bytes)
	const prepared = (await f.send("prepare", { path: "volume.npy" })).result
	assert.equal(prepared.profile, "npy"); assert.equal(prepared.source.sha256, crypto.createHash("sha256").update(bytes).digest("hex")); assert.equal(prepared.sizeBytes, bytes.length); assert.equal(prepared.input, undefined)
	assert.deepEqual(prepared.description, { shape: [1, 1, 2], dtype: "<f8", fortranOrder: false, version: 1, label: "float64 (little-endian), 1 × 1 × 2, C order" })
	const submission = { kind: "import-metadata", recipe: { schemaVersion: 1, source: prepared.source, metadata: defaultSpatialMetadata("volume.npy"), defaults: [], predecessor: null }, revision: null }
	assert.deepEqual((await f.send("validate", { submission })).result.grid.shape, [1, 1, 2])
})

test("drain stops agent admission and waits for an in-flight reference receipt before closing state", async (t) => {
	const controlSecret = "b".repeat(64), f = await fixture(t, { controlSecret }), ws = f.app.files.workspace, { receipt, submission } = await smallHead(f)
	await new Promise((r) => f.app.server.listen(0, "127.0.0.1", r))
	const url = `http://127.0.0.1:${f.app.server.address().port}`
	const browser = (body, headers = {}) => fetch(`${url}/voxels`, { method: "POST", headers: { "x-gc-gate": "a".repeat(64), "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
	let release, entered; const blocked = new Promise((r) => { release = r }), entry = new Promise((r) => { entered = r }), put = ws.state.put.bind(ws.state)
	ws.state.put = async (kind, id, value) => { if (kind === "voxel-agent-references") { entered(); await blocked }; return put(kind, id, value) }
	const status = f.send("status", { operationId: receipt.result.id }); await entry
	const stopping = fetch(`${url}/internal/files/drain`, { method: "POST", headers: { "x-gc-files-control": controlSecret, "content-type": "application/json" }, body: JSON.stringify({ deadline: new Date(Date.now() + 10000).toISOString() }) })
	try {
		await wait(20)
		assert.equal(ws.closed, undefined, "state remains open while an accepted HTTP response is remembering its receipt")
		assert.equal((await browser({ action: "submit", submission, idempotencyKey: "during-drain" })).status, 503)
		assert.equal((await browser({ action: "rename", voxelId: receipt.geoclusterVoxel.named.voxelId, expectedHeadRevision: receipt.geoclusterVoxel.named.headRevision, name: "Blocked rename" })).status, 503)
		const stale = await browser({ action: "submit", submission, idempotencyKey: "stale-drain" }, { "x-gc-workspace-id": f.scope.workspaceId, "x-gc-workspace-epoch": "stale", origin: "https://evil.example" })
		assert.equal(stale.status, 409, "scope rejection still precedes Origin and drain gates")
		await f.send("references", {}, 503)
		assert.deepEqual(await ws.voxels.list({ idempotencyKey: "during-drain" }), [])
		assert.equal((await ws.voxels.namedResolve({ voxelId: receipt.geoclusterVoxel.named.voxelId })).name, "Pattern")
	} finally { release() }
	await status; assert.equal((await (await stopping).json()).voxels.complete, true)
	await f.app.shutdown()
	await assert.rejects(request(f.socketPath, { action: "references", scope: f.scope, conversationId }))
})

test("socket provisioning refuses writable/symlink parents and existing non-socket or live socket without overwriting", async (t) => {
	const f = await fixture(t); await f.app.shutdown()
	const start = () => createFilesServer({ config: f.config, secret: "a".repeat(64), logger })
	await fs.chmod(f.socketDir, 0o770); await assert.rejects(start(), /socket|directory|owner|permission/i); await fs.chmod(f.socketDir, 0o750)
	await fs.writeFile(f.socketPath, "must survive"); await assert.rejects(start(), /socket/i); assert.equal(await fs.readFile(f.socketPath, "utf8"), "must survive"); await fs.unlink(f.socketPath)
	const target = path.join(f.socketDir, "target"); await fs.writeFile(target, "private"); await fs.symlink(target, f.socketPath); await assert.rejects(start(), /socket/i); assert.equal(await fs.readFile(target, "utf8"), "private"); await fs.unlink(f.socketPath)
	const live = net.createServer(); await new Promise((r) => live.listen(f.socketPath, r)); await fs.chmod(f.socketPath, 0o660)
	await assert.rejects(start(), /socket|use/i); await new Promise((r) => live.close(r))
	const actual = `${f.socketDir}-actual`; await fs.rename(f.socketDir, actual); await fs.symlink(actual, f.socketDir)
	await assert.rejects(start(), /socket|directory/i)
})

test("admission-only supervisor checkpoint lets an admitted full replacement finish before draining dependencies", async (t) => {
	const controlSecret = "b".repeat(64), f = await fixture(t, { controlSecret }), ws = f.app.files.workspace, { receipt, submission } = await smallHead(f)
	await new Promise((r) => f.app.server.listen(0, "127.0.0.1", r))
	const url = `http://127.0.0.1:${f.app.server.address().port}`
	let release, entered; const block = new Promise((r) => { release = r }), entry = new Promise((r) => { entered = r }), materialize = ws.voxels.materializeArtifact.bind(ws.voxels)
	ws.voxels.materializeArtifact = async (args) => { const result = await materialize(args); entered(); await block; return result }
	const destination = `runs/${conversationId}/results/checkpoint.csv`, preparing = f.send("prepare", { artifact: receipt.geoclusterVoxel.artifact, destination })
	preparing.catch(() => {})
	await entry
	const checkpoint = fetch(`${url}/internal/files/drain`, { method: "POST", headers: { "x-gc-files-control": controlSecret, "content-type": "application/json" }, body: JSON.stringify({ deadline: new Date(Date.now() + 10000).toISOString(), admissionOnly: true }) })
	try {
		await wait(20)
		await f.send("references", {}, 503)
		assert.equal((await fetch(`${url}/voxels`, { method: "POST", headers: { "x-gc-gate": "a".repeat(64), "content-type": "application/json" }, body: JSON.stringify({ action: "submit", submission, idempotencyKey: "after-checkpoint" }) })).status, 503)
	} finally { release() }
	const prepared = (await preparing).result
	assert.match(prepared.source.sha256, /^[0-9a-f]{64}$/)
	assert.equal(prepared.recipe.scope.input.source.revision, prepared.source.revision)
	assert.equal((await (await checkpoint).json()).admittingMutations, false)
	assert.equal(ws.draining, true)
	assert.equal((await ws.state.list("operations")).find((op) => op.intent.path === destination).state, "committed")
	assert.deepEqual(await ws.voxels.list({ idempotencyKey: "after-checkpoint" }), [])
})

test("runtime-owner deletion immediately fences an admitted agent replacement before publication", async (t) => {
	const controlSecret = "b".repeat(64), f = await fixture(t, { controlSecret }), ws = f.app.files.workspace, { receipt } = await smallHead(f)
	await new Promise((r) => f.app.server.listen(0, "127.0.0.1", r))
	const url = `http://127.0.0.1:${f.app.server.address().port}`
	let release, entered; const block = new Promise((r) => { release = r }), entry = new Promise((r) => { entered = r }), materialize = ws.voxels.materializeArtifact.bind(ws.voxels)
	ws.voxels.materializeArtifact = async (args) => { const result = await materialize(args); entered(); await block; return result }
	const destination = `runs/${conversationId}/results/deletion-fenced.csv`, preparing = f.send("prepare", { artifact: receipt.geoclusterVoxel.artifact, destination }, 503)
	preparing.catch(() => {})
	try {
		await entry
		assert.ok(f.app.voxelAgent, "Deletion must fence a workspace with its agent listener present.")
		const response = await fetch(`${url}/internal/files/drain`, { method: "POST", headers: { "x-gc-files-control": controlSecret, "content-type": "application/json" }, body: JSON.stringify({ deadline: new Date(Date.now() + 5000).toISOString(), admissionOnly: true, runtimeId: "runtime-owner" }) })
		assert.equal(response.status, 200)
		const fence = await response.json()
		assert.equal(fence.publicationFenced, true); assert.equal(fence.admittingMutations, false)
		assert.equal(ws.draining, true, "The owner fence must close workspace admission before the paused replacement resumes.")
		await assert.rejects(fs.stat(path.join(f.workspaceDir, destination)), { code: "ENOENT" })
	} finally { release() }
	assert.equal((await preparing).error, "draining")
	await assert.rejects(fs.stat(path.join(f.workspaceDir, destination)), { code: "ENOENT" })
	assert.equal((await ws.state.list("operations")).some((op) => op.intent.path === destination), false, "Rejected replacement must not claim or commit a file publication.")
})

test("deferred startup automatically verifies retained publication after the private listener is already live", async (t) => {
	const f = await fixture(t), { receipt } = await smallHead(f), state = f.app.files.workspace.state
	const artifact = await state.get("voxel-artifacts", receipt.geoclusterVoxel.artifact.artifactId)
	// Retain complete committed bytes with an unfinished producer receipt, as at
	// interruption after upload but before the artifact's ready checkpoint.
	await state.put("voxel-artifacts", artifact.artifactId, { ...artifact, state: "publishing", publicationState: "publishing", verificationState: "unchecked" })
	await f.restart({ deferWorkspace: true })
	await new Promise((r) => f.app.server.listen(0, "127.0.0.1", r))
	assert.equal(f.app.files, null)
	const unavailable = await fetch(`http://127.0.0.1:${f.app.server.address().port}/files/info`, { headers: { "x-gc-gate": "a".repeat(64) } })
	assert.equal(unavailable.status, 503)
	const workspace = await f.app.initialize()
	let recovered
	// Poll stored receipts only: no demand read or explicit recovery call may
	// trigger verification on behalf of deferred daemon initialization.
	for (let n = 0; n < 500; n++) {
		recovered = await workspace.state.get("voxel-artifacts", artifact.artifactId)
		if (recovered.publicationState === "ready" && recovered.verificationState === "verified") break
		await wait(10)
	}
	assert.equal(recovered.verificationState, "verified", "Deferred initialization must automatically verify retained publication.")
	assert.equal(recovered.publicationState, "ready"); assert.equal(recovered.recoveryPending, false)
	assert.deepEqual(recovered.link, receipt.geoclusterVoxel.artifact)
	assert.equal((await workspace.state.get("voxel-operations", artifact.operationId)).phase, "ready")
})

test("incomplete POSTs opened before or after admission closes cannot extend the accepted-work drain barrier", async (t) => {
	for (const afterStop of [false, true]) {
		const f = await fixture(t)
		if (afterStop) f.app.voxelAgent.stopAdmission()
		const arrived = new Promise((r) => f.app.voxelAgent.server.once("request", r))
		let response
		const received = new Promise((r) => { response = r })
		const req = http.request({ socketPath: f.socketPath, path: "/agent/voxels", method: "POST", headers: { "content-type": "application/json", "content-length": "1000" } }, (res) => { res.resume(); response(res.statusCode) })
		req.on("error", () => {}); req.write("{") // Keep the declared request body incomplete.
		await arrived
		if (!afterStop) f.app.voxelAgent.stopAdmission()
		try {
			await f.app.voxelAgent.drain(new Date(Date.now() + 500).toISOString())
			assert.equal(await Promise.race([received, wait(500).then(() => { throw new Error("Closed admission did not reject the incomplete request") })]), 503)
		} finally { req.destroy() }
		await f.app.shutdown()
	}
})

test("restart reclaims only a service-owned stale socket left by a killed listener", async (t) => {
	const f = await fixture(t); await f.app.shutdown()
	const child = spawn(process.execPath, ["--input-type=module", "-e", 'import net from "node:net"; import fs from "node:fs"; const s = net.createServer(); s.listen(process.argv[1], () => { fs.chmodSync(process.argv[1], 0o660); console.log("listening") })', f.socketPath], { stdio: ["ignore", "pipe", "pipe"] })
	t.after(() => child.kill("SIGKILL"))
	await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); child.once("exit", (code) => reject(new Error(`Socket child exited ${code}`))) })
	const exited = new Promise((r) => child.once("exit", r)); child.kill("SIGKILL"); await exited
	assert.ok((await fs.lstat(f.socketPath)).isSocket())
	await f.restart()
	assert.equal((await f.send("capabilities")).scope.workspaceEpoch, f.scope.workspaceEpoch)
})

test("production config enables the fixed credential-free socket and rejects environment path substitution", () => {
	const config = loadFilesConfig({ WORKSPACE_DIR: "/workspace/test" })
	assert.equal(config.voxelAgentEnabled, true); assert.equal(config.voxelAgentSocket, "/run/geocluster/voxels.sock"); assert.equal(config.voxelAgentGid, 999)
	assert.equal(loadFilesConfig({ WORKSPACE_DIR: "/workspace/test", VOXEL_AGENT_ENABLED: "false" }).voxelAgentEnabled, false)
	assert.throws(() => loadFilesConfig({ WORKSPACE_DIR: "/workspace/test", VOXEL_AGENT_ENABLED: "yes" }))
	assert.throws(() => loadFilesConfig({ WORKSPACE_DIR: "/workspace/test", VOXEL_AGENT_SOCKET: "/tmp/agent.sock" }), /fixed|socket/i)
})
