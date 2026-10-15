import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import { createFilesServer } from "../files-server.js"
import { createMachineGateway } from "../machine-gateway.js"
import { BackendFileAdapter } from "../lib/backend-file-adapter.js"

const logger = { info() {}, warn() {}, error() {} }, digest = (b) => crypto.createHash("sha256").update(b).digest("hex")
async function until(fn) { const end = Date.now() + 10000; while (!await fn()) { if (Date.now() > end) throw new Error("local integration did not converge"); await delay(20) } }

test("real files-daemon boot imports over root's renewable purpose channels with no browser, ACP or model; local writes stream captured bytes with head CAS", async (t) => {
	const base = await fs.mkdtemp(path.join(os.homedir(), ".gc-cloud-http-")); await fs.chmod(base, 0o700)
	const workspaceDir = path.join(base, "project"); await fs.mkdir(workspaceDir, { mode: 0o2775 })
	const machineTokenFile = path.join(base, "machine-token"); await fs.writeFile(machineTokenFile, "root-private-machine", { mode: 0o600 })
	const body = "cloud,source\n1,2\n", version = crypto.randomUUID(), head = crypto.randomUUID(), workId = crypto.randomUUID(), runtimeId = crypto.randomUUID(), attemptId = crypto.randomUUID()
	const calls = [], permits = new Map(), receipts = []; let apiBase, supplied = false
	const entry = { path: "cloud.csv", kind: "file", headToken: head, fileVersionId: version, changeSeq: 1, sizeBytes: body.length, sha256: digest(body) }
	const source = () => ({ fileVersionId: version, objectIdentity: "sealed-object", sizeBytes: body.length, sha256: digest(body), url: `${apiBase}/sealed`, requiredHeaders: { "If-Match": '"opaque-etag"' }, expiresAt: new Date(Date.now() + 60000).toISOString() })
	const backend = http.createServer(async (req, res) => {
		const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks), url = new URL(req.url, "http://backend")
		calls.push({ path: url.pathname, headers: req.headers, raw })
		const send = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)) }
		if (url.pathname === "/renew") { assert.equal(req.headers.authorization, "Bearer root-private-machine"); return send({ llmToken: "llm-private", datasetToken: "dataset-private", activityToken: "activity-private", filesToken: "files-private", workToken: "work-private", expiresAt: new Date(Date.now() + 3600000).toISOString() }) }
		if (url.pathname === "/sealed") { assert.equal(req.headers["if-match"], '"opaque-etag"'); assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined); res.end(body); return }
		assert.equal(req.headers.authorization, url.pathname.startsWith("/runtime/file-work") ? "Bearer work-private" : "Bearer files-private")
		assert.ok(req.headers["x-gc-workspace-id"]); assert.ok(req.headers["x-gc-workspace-epoch"]); assert.equal(req.headers["x-gc-files-control"], undefined)
		const json = raw.length && req.headers["content-type"] === "application/json" ? JSON.parse(raw) : {}
		if (url.pathname === "/runtime/file-work/claims") {
			if (supplied) return send({ claims: [], pollAfterSeconds: 5 }); supplied = true
			const identity = { workspaceId: req.headers["x-gc-workspace-id"], workspaceEpoch: req.headers["x-gc-workspace-epoch"] }
			return send({ claims: [{ workId, attemptId, attemptRevision: 1, runtimeId, ...identity, operationId: `import:${workId}:${identity.workspaceEpoch}`, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), source: source(), destination: { path: entry.path, headToken: head, changeSeq: 1 }, processingPolicy: "skip", processingRequestId: `auto:${workId}`, publicationPermit: null, processingPermit: null, processingReceipt: { state: "skipped", reason: "policy-skip", requestId: `auto:${workId}`, sourceFileVersionId: version }, recovery: "new" }], pollAfterSeconds: 5 })
		}
		if (url.pathname.endsWith("/source-url")) return send(source())
		if (url.pathname.endsWith("/progress")) return send({ leaseExpiresAt: new Date(Date.now() + 120000).toISOString() })
		if (url.pathname.endsWith("/permits")) { assert.equal(json.kind, "publication"); const permit = { permitId: crypto.randomUUID(), ownerRevision: 1, kind: json.kind, runtimeId, workspaceId: req.headers["x-gc-workspace-id"], workspaceEpoch: req.headers["x-gc-workspace-epoch"], state: "granted" }; permits.set(permit.permitId, permit); return send(permit, 201) }
		if (url.pathname.endsWith("/ack")) { receipts.push(json); return send({ workId, deliveryState: "available", processingReceipt: json.processingReceipt }) }
		if (url.pathname.endsWith("/settle")) return send({ state: "completed" })
		if (url.pathname.endsWith("/receipts/reconcile")) return send({ results: json.receipts.map((r) => ({ workId: r.workId, status: "accepted", action: "record-skip" })) })
		if (url.pathname === "/runtime/files/snapshots") return send({ snapshotId: "snapshot-id", throughSeq: 1, expiresAt: new Date(Date.now() + 60000).toISOString() }, 201)
		if (url.pathname === "/runtime/files/snapshots/snapshot-id") return send({ snapshotId: "snapshot-id", throughSeq: 1, entries: [entry], nextCursor: null })
		if (url.pathname === "/runtime/files/changes") return send({ afterSeq: Number(url.searchParams.get("afterSeq")), throughSeq: 1, changes: [], nextCursor: null })
		if (url.pathname === "/runtime/files/current/upload") {
			assert.match(req.headers["content-type"], /^multipart\/form-data; boundary=/)
			assert.ok(raw.includes(Buffer.from("local retained source"))); assert.ok(!raw.includes(Buffer.from("new live path")))
			assert.match(raw.toString(), /name="expectedHeads"\r\n\r\n\r\n/)
			return send({ results: [{ status: "ready", operationId: "local-save", path: "local.csv", fileVersionId: crypto.randomUUID(), headToken: crypto.randomUUID(), changeSeq: 2, role: "original", sizeBytes: 21, sha256: digest("local retained source") }] })
		}
		return send({ detail: "not_found" }, 404)
	})
	await new Promise((r) => backend.listen(0, "127.0.0.1", r)); apiBase = `http://127.0.0.1:${backend.address().port}`
	const controlSecret = "c".repeat(64), root = await createMachineGateway({ config: { machineTokenFile, machineCredentialsUrl: `${apiBase}/renew`, filesUrl: `${apiBase}/runtime/files`, fileWorkUrl: `${apiBase}/runtime/file-work`, filesControlSecret: controlSecret }, logger })
	await new Promise((r) => root.server.listen(0, "127.0.0.1", r))
	const app = await createFilesServer({ config: { workspaceDir, filesStateDir: path.join(base, "state"), filesAgentUids: [20001], filesWorkerUids: [20003], cloudImport: { enabled: true, gatewayPort: root.server.address().port, pollMs: 60000 }, controlSecret }, secret: "g".repeat(64), logger })
	await new Promise((r) => app.server.listen(0, "127.0.0.1", r))
	t.after(async () => { await app.shutdown(new Date(Date.now() + 3000).toISOString()); await root.close(); backend.closeAllConnections(); await new Promise((r) => backend.close(r)); await fs.rm(base, { recursive: true, force: true }) })
	await until(async () => receipts.length > 0 && (await app.files.workspace.state.get("cloud-sync", "checkpoint"))?.afterSeq === 1)
	assert.equal(await fs.readFile(path.join(workspaceDir, "cloud.csv"), "utf8"), body)
	assert.equal(receipts[0].processingReceipt.state, "skipped"); assert.equal(receipts[0].processingReceipt.reason, "policy-skip")
	assert.equal((await app.files.workspace.state.list("processing-jobs")).length, 0)
	assert.equal((await app.files.workspace.info()).processing.enabled, false)
	assert.equal((await app.files.workspace.info()).sync.enabled, true)
	assert.equal(calls.filter((c) => c.path.endsWith("/current/upload")).length, 0, "cloud baseline cannot echo")
	await app.files.workspace.upload(Readable.from(["local retained source"]), { operationId: "local-save", path: "local.csv", processingPolicy: "skip", requireRemotePersistable: true })
	await fs.writeFile(path.join(workspaceDir, "local.csv"), "new live path")
	await app.files.workspace.imports.runOnce()
	assert.equal((await app.files.workspace.operation("local-save")).persistence.remoteIntegrity, "digest-verified")
	assert.equal(calls.filter((c) => c.path.endsWith("/current/upload")).length, 1)
	assert.equal((await app.files.workspace.state.list("processing-jobs")).length, 0)
})

test("reviewed contract: adapter sends exact failure, claim-style GET, observed ack and settlement bodies through the private workspace channel", async () => {
	const calls = [], workId = crypto.randomUUID(), attemptId = crypto.randomUUID(), runtimeId = crypto.randomUUID(), version = crypto.randomUUID()
	const identity = { workspaceId: crypto.randomUUID(), workspaceEpoch: crypto.randomUUID() }, permit = { permitId: crypto.randomUUID(), kind: "processing", ownerRevision: 7, runtimeId, ...identity, state: "granted" }
	const work = { workId, attemptId, attemptRevision: 4, runtimeId, ...identity, operationId: `import:${workId}:${identity.workspaceEpoch}`, publicationPermit: null, processingPermit: permit, unresolvedPermits: [permit], recovery: "reconcile", action: "reuse-ticket", processingReceipt: { state: "ticket" }, receipt: null }
	const adapter = new BackendFileAdapter({ secret: "b".repeat(64), fetchImpl: async (url, options) => {
		const body = options.body ? JSON.parse(options.body) : null; calls.push({ url: String(url), options, body })
		if (options.method === "GET") return Response.json(work, { headers: { "x-gc-machine-authority": "cleanup" } })
		return Response.json(String(url).endsWith("/failure") ? { workId, deliveryState: "failed" } : String(url).endsWith("/ack") ? { workId, deliveryState: "available" } : { state: "completed" })
	} })
	adapter.bind({ identity })
	assert.deepEqual(await adapter.getWork(workId), work); assert.equal(adapter.cleanupOnly, true)
	await adapter.reportFailure(work, { stage: "verified", error: "digest_mismatch", retryable: false })
	assert.deepEqual(calls.at(-1).body, { attemptId, attemptRevision: 4, stage: "verified", error: "digest_mismatch", retryable: false })
	const record = { receiptRevision: 2, receipt: { receiptId: "receipt", fileVersionId: version }, processingReceipt: { state: "ticket", requestId: `auto:${workId}`, sourceFileVersionId: version }, observedProcessing: { state: "running", observedAt: "2026-10-07T10:00:00.000Z", ownerRevision: 7 } }
	await adapter.ack(work, record)
	assert.deepEqual(calls.at(-1).body, { attemptId, attemptRevision: 4, ...record })
	await adapter.reconcile([{ workId, ...record }])
	assert.deepEqual(calls.at(-1).body, { ...identity, receipts: [{ workId, ...record }] }, "expired delivery receipt reconciliation must forward the exact observation")
	const evidence = { owner: { runtimeId, ...identity }, local: { state: "terminal", receiptId: "receipt", ticketId: "ticket", sourceHold: "retained" }, processor: { submissionKey: "submission", jobId: "job", state: "terminal", outcome: "completed" } }
	await adapter.settle(permit, { receiptId: "receipt", state: "completed", evidence })
	assert.deepEqual(calls.at(-1).body, { ownerRevision: 7, receiptId: "receipt", state: "completed", evidence })
	assert.ok(calls.every((c) => c.options.headers["x-gc-workspace-id"] === identity.workspaceId && c.options.headers["x-gc-workspace-epoch"] === identity.workspaceEpoch && c.options.headers["x-gc-files-control"] === "b".repeat(64)))
})

test("owned demo adapter uses only fixed work-backend status/permit/checkpoint methods and workspace headers", async () => {
	const calls = [], identity = { workspaceId: "owned", workspaceEpoch: "epoch" }
	const adapter = new BackendFileAdapter({ secret: "b".repeat(64), fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ demo: null }) } })
	adapter.bind({ identity })
	await adapter.demoStatus(); await adapter.demoPermit("request", "files"); await adapter.demoCheckpoint({ requestId: "checkpoint", permitId: "permit", outcome: "files-ready", memberHashes: { "README.md": "a".repeat(64) } })
	assert.deepEqual(calls.map((c) => [new URL(c.url).pathname, c.options.method]), [["/work-backend/demo/status", "GET"], ["/work-backend/demo/permit", "POST"], ["/work-backend/demo/checkpoint", "POST"]])
	assert.deepEqual(JSON.parse(calls[1].options.body), { requestId: "request", stage: "files" })
	assert.ok(calls.every((c) => c.options.headers["x-gc-workspace-id"] === "owned" && c.options.headers["x-gc-workspace-epoch"] === "epoch" && !c.options.headers.authorization))
})
test("accepted review R4/R5 backend grants: same-volume owner replacement gets its own replayable publication request", async () => {
	const identity = { workspaceId: crypto.randomUUID(), workspaceEpoch: crypto.randomUUID() }, workId = crypto.randomUUID(), attempts = new Map()
	let runtimeId = crypto.randomUUID()
	const adapter = new BackendFileAdapter({ secret: "b".repeat(64), fetchImpl: async (_url, options) => {
		const body = JSON.parse(options.body), old = attempts.get(body.requestId)
		if (old && old.runtimeId !== runtimeId) return Response.json({ detail: "request_id_reused" }, { status: 409 })
		const permit = old || { permitId: crypto.randomUUID(), kind: "publication", ownerRevision: attempts.size + 1, runtimeId, ...identity, state: "granted" }
		attempts.set(body.requestId, permit)
		return Response.json(permit)
	} })
	adapter.bind({ identity })
	const claim = { workId, runtimeId, ...identity, operationId: `import:${workId}:${identity.workspaceEpoch}`, attemptId: crypto.randomUUID(), attemptRevision: 1 }
	const a = await adapter.permit(claim, "publication", "receipt")
	assert.deepEqual(await adapter.permit(claim, "publication", "receipt"), a)
	for (let revision = 2; revision <= 3; revision++) {
		runtimeId = crypto.randomUUID()
		const replacement = { ...claim, runtimeId, attemptId: crypto.randomUUID(), attemptRevision: revision }, next = await adapter.permit(replacement, "publication", "receipt")
		assert.equal(next.runtimeId, runtimeId)
		assert.notEqual(next.permitId, a.permitId)
		assert.deepEqual(await adapter.permit(replacement, "publication", "receipt"), next)
	}
	assert.equal(attempts.size, 3)
})
