import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fork } from "node:child_process"
import { createHash } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { test } from "node:test"
import { acquireNativeProcessingLease } from "../lib/native-processing-receipts.js"
import { NativeProcessingOperations } from "../lib/native-processing-operations.js"
import { createNativeProcessingBridge } from "../lib/native-processing-bridge.js"
import { createClient, readConnection } from "../../opencode/config/lib/processing-client.js"

const model = { origin: "model", rootId: "root", sessionId: "session", messageId: "message", callId: "call", agent: "dataops" }
const operator = { origin: "operator", sessionId: "cli" }
const scope = { workspaceId: "project", workspaceEpoch: "store" }
async function setup(t, overrides = {}) {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "native-adapter-"))
	t.after(() => fs.rm(workspace, { recursive: true, force: true }))
	await fs.writeFile(path.join(workspace, "source.pdf"), "original")
	const lease = await acquireNativeProcessingLease({ clientDir: path.join(workspace, ".runtime/client") })
	const jobs = new Map(); let submits = 0
	const client = { storeScope: "store", capabilities: async () => ({ storeScope: "store", serviceGeneration: "generation" }), bindStoreScope: () => {}, lookup: async (key) => jobs.get(key) || null,
		submit: async (key, request) => { submits++; const job = { id: `job${submits}`, submissionKey: key, projectId: "store", state: "running", source: request.source }; jobs.set(key, job); return job },
		get: async (id) => [...jobs.values()].find((job) => job.id === id), cancel: async (id) => ({ id, state: "cancelled" }),
		cancelSubmission: async (key) => ({ cancelled: true, job: jobs.has(key) ? { ...jobs.get(key), state: "cancelled" } : null }), ...overrides }
	const operations = await NativeProcessingOperations.open({ lease, workspace, scope, client })
	t.after(async () => { await operations.close(); await lease.release() })
	return { workspace, lease, client, operations, submits: () => submits }
}

test("receipt is private, exact model call recovers immutable intent, and history never exposes upstream keys", async (t) => {
	const f = await setup(t)
	const prepared = await f.operations.submit(model, { path: "source.pdf", prepareOnly: true })
	assert.equal(prepared.state, "prepared")
	assert.equal(f.submits(), 0)
	await fs.writeFile(path.join(f.workspace, "source.pdf"), "changed")
	const accepted = await f.operations.submit(model, { path: "source.pdf" })
	assert.equal(accepted.requestId, prepared.requestId)
	assert.equal(f.submits(), 1)
	const raw = JSON.parse(await fs.readFile(path.join(f.lease.clientDir, "requests", `${prepared.requestId}.json`)))
	assert.equal(raw.intent.source.expectedSha256, "0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5")
	assert.equal((await fs.stat(path.join(f.lease.clientDir, "requests"))).mode & 0o777, 0o700)
	assert.equal((await fs.stat(path.join(f.lease.clientDir, "requests", `${prepared.requestId}.json`))).mode & 0o777, 0o600)
	await assert.rejects(f.operations.status({ ...model, rootId: "sibling" }, { requestId: prepared.requestId }), { code: "SCOPE_MISMATCH" })
	await assert.rejects(f.operations.cancel({ ...model, rootId: "sibling" }, { requestId: prepared.requestId }), { code: "SCOPE_MISMATCH" })
	assert.equal((await f.operations.status({ ...model, rootId: "sibling" }, { jobId: accepted.jobId })).jobId, accepted.jobId)
	assert.equal((await f.operations.cancel({ ...model, rootId: "sibling" }, { jobId: accepted.jobId })).jobOutcome, "cancelled", "Native job-ID cancellation is deliberately workspace-wide; only receipt replay is root-scoped.")
	assert.equal((await f.operations.status(operator, { requestId: prepared.requestId })).jobId, accepted.jobId)
	assert.ok(!JSON.stringify(await f.operations.history(operator, {})).includes(raw.submissionKey))
	await assert.rejects(f.operations.submit(model, { path: "different.pdf" }), { code: "IDEMPOTENCY_CONFLICT" })
})

test("unknown cancellation uses keyed authority, is monotonic and never replays submit", async (t) => {
	let cancelled = 0
	const f = await setup(t, { submit: async () => { throw new Error("response lost") }, cancelSubmission: async () => { cancelled++; return { cancelled: true, job: null } } })
	const unknown = await f.operations.submit(model, { path: "source.pdf" })
	assert.equal(unknown.state, "unknown")
	const result = await f.operations.cancel(model, { requestId: unknown.requestId })
	assert.equal(result.operationOutcome, "cancelled")
	assert.equal(cancelled, 1)
	assert.equal((await f.operations.submit(model, { requestId: unknown.requestId })).cancelRequested, true)
	assert.equal(f.submits(), 0)
})

test("writer exclusion outlives pending effects and a failed drain", async (t) => {
	const f = await setup(t)
	let finish
	const pending = new Promise((resolve) => { finish = resolve })
	const effect = f.lease.track(pending)
	await assert.rejects(acquireNativeProcessingLease({ clientDir: f.lease.clientDir }), { code: "WRITER_IN_USE" })
	await assert.rejects(f.lease.release(), { code: "CLEANUP_UNVERIFIED" })
	finish(); await effect
	await f.operations.close(); await f.lease.release()
	const successor = await acquireNativeProcessingLease({ clientDir: f.lease.clientDir })
	await successor.release()
})

test("concurrent exact recovery under jitter cannot lose acceptance or change the original digest", async (t) => {
	let attempt = 0, stored, requests = []
	const f = await setup(t, { lookup: async () => { await sleep(Math.random() * 4); return stored }, submit: async (key, request) => { requests.push({ key, request }); await sleep(Math.random() * 4); stored ||= { id: "stableJob", submissionKey: key, projectId: "store", state: "running" }; if (++attempt === 1) throw new Error("lost acceptance"); return stored }, get: async () => stored })
	const first = await f.operations.submit(model, { path: "source.pdf" })
	assert.equal(first.operationOutcome, "dispatch_unknown")
	await fs.writeFile(path.join(f.workspace, "source.pdf"), "different bytes after dispatch")
	const results = await Promise.all(Array.from({ length: 20 }, async () => { await sleep(Math.random() * 8); return f.operations.submit(model, { requestId: first.requestId }) }))
	assert.ok(results.every((value) => value.jobId === "stableJob"))
	assert.equal(requests.length, 1)
	assert.equal((await f.operations.status(model, { requestId: first.requestId })).receiptState, "accepted")
})

test("keyed cancellation races a delayed POST under jitter without resubmission", async (t) => {
	let tombstone = false, admissions = 0, dispatches = 0, dispatched, releasePost
	const started = new Promise((resolve) => { dispatched = resolve })
	const postBlocked = new Promise((resolve) => { releasePost = resolve })
	const f = await setup(t, { submit: async () => { dispatches++; dispatched(); await postBlocked; await sleep(Math.random() * 4); if (tombstone) throw Object.assign(new Error("cancelled key"), { upstreamRejected: true, status: 409, error: "submission_cancelled" }); admissions++; return { id: "job", state: "running" } }, cancelSubmission: async () => { await sleep(Math.random() * 4); tombstone = true; releasePost(); return { cancelled: true, job: null } } })
	const prepared = await f.operations.submit(model, { path: "source.pdf", prepareOnly: true })
	const pending = f.operations.submit(model, { requestId: prepared.requestId })
	const rejected = assert.rejects(pending, (error) => error.requestId === prepared.requestId)
	await started
	assert.equal((await f.operations.cancel(model, { requestId: prepared.requestId })).operationOutcome, "cancelled")
	await rejected
	assert.equal((await f.operations.submit(model, { requestId: prepared.requestId })).cancelRequested, true)
	assert.equal(dispatches, 1)
	assert.equal(admissions, 0)
})

test("processor-store replacement never replays retained identity", async (t) => {
	const f = await setup(t)
	const prepared = await f.operations.submit(model, { path: "source.pdf", prepareOnly: true })
	f.client.capabilities = async () => ({ storeScope: "replacement", serviceGeneration: "new" })
	await assert.rejects(f.operations.submit(operator, { requestId: prepared.requestId }), { code: "PROCESSING_STORE_CHANGED" })
	assert.equal(f.submits(), 0)
})

test("a restarted bridge cannot rebind an exactly resumed model call to a replacement store", async (t) => {
	const f = await setup(t)
	const prepared = await f.operations.submit(model, { path: "source.pdf", prepareOnly: true })
	await f.operations.close(); await f.lease.release()
	const lease = await acquireNativeProcessingLease({ clientDir: f.lease.clientDir })
	let dispatched = 0
	const replacement = { ...f.client, capabilities: async () => ({ storeScope: "replacement", serviceGeneration: "new" }),
		submit: async (key) => { dispatched++; return { id: "new-job", projectId: "replacement", submissionKey: key, state: "running" } } }
	const operations = await NativeProcessingOperations.open({ lease, workspace: f.workspace, scope: { ...scope, workspaceEpoch: "replacement" }, client: replacement })
	t.after(async () => { await operations.close(); await lease.release() })
	await assert.rejects(operations.submit(model, { path: "source.pdf" }), (error) => error.code === "PROCESSING_STORE_CHANGED" && error.requestId === prepared.requestId)
	assert.equal(dispatched, 0, "An exact resumed call cannot become an absent-key submission in the new store.")
	const fresh = await operations.submit({ ...model, callId: "explicit-new-call" }, { path: "source.pdf" })
	assert.notEqual(fresh.requestId, prepared.requestId)
	assert.equal(dispatched, 1, "A separate explicit call may deliberately select the replacement store.")
})

test("source preparation rejects symlink components and supplied hash mismatch", async (t) => {
	const f = await setup(t)
	await fs.symlink("source.pdf", path.join(f.workspace, "link.pdf"))
	await assert.rejects(f.operations.submit(operator, { path: "link.pdf" }))
	await assert.rejects(f.operations.submit(operator, { path: "source.pdf", expectedSha256: "0".repeat(64) }), { code: "SOURCE_CHANGED" })
	await assert.rejects(f.operations.submit(operator, { path: ".runtime/private.pdf" }), { code: "INVALID_PATH" })
	assert.equal(f.submits(), 0)
})

test("context history accepts null execution IDs but cannot perform a submission", async (t) => {
	const f = await setup(t)
	const prepared = await f.operations.submit(model, { path: "source.pdf", prepareOnly: true })
	const discovery = { ...model, agent: "geology", messageId: null, callId: null }
	assert.equal((await f.operations.history(discovery)).requests[0].requestId, prepared.requestId)
	assert.equal((await f.operations.capabilities(discovery)).enabled, true)
	await assert.rejects(async () => f.operations.submit(discovery, { requestId: prepared.requestId }), { code: "INVALID_CALLER" })
	await assert.rejects(async () => f.operations.submit({ ...model, agent: "orchestrator" }, { requestId: prepared.requestId }), { code: "AGENT_NOT_ALLOWED" })
})

test("sealed export preserves partial-quality bytes, create-only policy and edit-safe recovery", async (t) => {
	const bytes = Buffer.from("header,value\r\nCedar,42\r\n"), sha256 = createHash("sha256").update(bytes).digest("hex")
	const job = { id: "sealedJob", state: "partial", resultId: "sealedResult" }
	const f = await setup(t, { get: async () => job, results: async () => ({ jobId: job.id, resultId: job.resultId, products: [{ id: "csv", sha256, bytes: bytes.length, mediaType: "text/csv" }], tables: [] }), product: async () => new Response(bytes) })
	const result = await f.operations.exportProduct(model, { jobId: job.id, productId: "csv", basename: "assays.csv" })
	assert.equal(result.jobOutcome, "partial")
	assert.deepEqual(await fs.readFile(path.join(f.workspace, result.destination)), bytes)
	assert.equal((await f.operations.exportProduct(model, { exportId: result.exportId })).sha256, sha256)
	await fs.writeFile(path.join(f.workspace, result.destination), "human edit")
	await assert.rejects(f.operations.exportProduct(model, { exportId: result.exportId }), { code: "EXPORT_CONFLICT" })
	await assert.rejects(f.operations.exportProduct(operator, { jobId: job.id, productId: "csv", out: result.destination }), { code: "EXPORT_CONFLICT" })
	assert.equal(await fs.readFile(path.join(f.workspace, result.destination), "utf8"), "human edit")
	await assert.rejects(f.operations.exportProduct(model, { jobId: job.id, productId: "csv", out: "elsewhere.csv", basename: "ignored.csv" }), { code: "DESTINATION_REQUIRES_APPROVAL" })
	const overwritten = await f.operations.exportProduct(operator, { jobId: job.id, productId: "csv", out: result.destination, overwrite: true })
	await fs.writeFile(path.join(f.workspace, result.destination), "post-export edit")
	await assert.rejects(f.operations.exportProduct(operator, { exportId: overwritten.exportId }), { code: "EXPORT_CONFLICT" })
})

test("corrupt product bytes never publish a destination", async (t) => {
	const f = await setup(t, { get: async () => ({ id: "job", resultId: "result", state: "succeeded" }), results: async () => ({ jobId: "job", resultId: "result", products: [{ id: "csv", bytes: 4, sha256: "0".repeat(64) }] }), product: async () => new Response("fake") })
	await assert.rejects(f.operations.exportProduct(operator, { jobId: "job", productId: "csv", out: "output.csv" }), (error) => error.code === "PRODUCT_INTEGRITY" && Boolean(error.exportId))
	await assert.rejects(fs.stat(path.join(f.workspace, "output.csv")), { code: "ENOENT" })
	assert.deepEqual((await fs.readdir(f.workspace)).filter((name) => name.endsWith(".tmp")), [])
})

test("failed bridge drain retains exclusion until a paused export joins, without publication after shutdown", async (t) => {
	let resume, downloading
	const blocked = new Promise((resolve) => { resume = resolve }), started = new Promise((resolve) => { downloading = resolve })
	const bytes = Buffer.from("sealed"), sha256 = createHash("sha256").update(bytes).digest("hex")
	const f = await setup(t, { get: async () => ({ id: "job", resultId: "result", state: "partial" }), results: async () => ({ jobId: "job", resultId: "result", products: [{ id: "csv", bytes: bytes.length, sha256 }] }), product: async () => { downloading(); await blocked; return new Response(bytes) } })
	await f.operations.close()
	const bridge = await createNativeProcessingBridge({ lease: f.lease, workspace: f.workspace, projectId: "project", model: "provider/model", client: f.client })
	const effect = bridge.operations.exportProduct(model, { jobId: "job", productId: "csv", basename: "paused.csv" })
	await started
	await assert.rejects(bridge.drain({ deadlineMs: Date.now() + 1 }), { code: "CLEANUP_UNVERIFIED" })
	await assert.rejects(fs.stat(path.join(f.lease.clientDir, "connection.json")), { code: "ENOENT" })
	await assert.rejects(f.lease.release(), { code: "CLEANUP_UNVERIFIED" })
	await sleep(Math.random() * 10)
	await assert.rejects(acquireNativeProcessingLease({ clientDir: f.lease.clientDir }), { code: "WRITER_IN_USE" })
	resume()
	await assert.rejects(effect, (error) => error.code === "DRAINING" && Boolean(error.exportId))
	await bridge.drain()
	await assert.rejects(fs.stat(path.join(f.workspace, "runs/root/results/paused.csv")), { code: "ENOENT" })
	await f.lease.release()
})

test("aborted waits still join in-flight receipt observation before releasing the writer", async (t) => {
	let resume, observed
	const blocked = new Promise((resolve) => { resume = resolve }), started = new Promise((resolve) => { observed = resolve })
	const f = await setup(t, { submit: async () => { throw new Error("lost") }, lookup: async (key) => { observed(); await blocked; return { id: "lateJob", submissionKey: key, projectId: "store", state: "running" } } })
	const submitted = await f.operations.submit(model, { path: "source.pdf" }), controller = new AbortController()
	const waiting = f.operations.wait(model, { requestId: submitted.requestId }, { signal: controller.signal })
	await started
	controller.abort()
	await assert.rejects(waiting, { name: "AbortError" })
	await assert.rejects(f.operations.close({ deadlineMs: Date.now() + 1 }), { code: "CLEANUP_UNVERIFIED" })
	await assert.rejects(f.lease.release(), { code: "CLEANUP_UNVERIFIED" })
	resume(); await f.operations.close()
	const raw = JSON.parse(await fs.readFile(path.join(f.lease.clientDir, "requests", `${submitted.requestId}.json`)))
	assert.equal(raw.jobId, "lateJob")
	assert.equal(raw.state, "accepted")
})

test("private bridge descriptor and first capabilities bind current invocation, drain withdraws discovery", async (t) => {
	const f = await setup(t)
	await f.operations.close()
	const bridge = await createNativeProcessingBridge({ lease: f.lease, workspace: f.workspace, projectId: "project", invocationId: "invocation", model: "provider/model", client: f.client })
	t.after(() => bridge.drain())
	const descriptor = await readConnection(f.lease.clientDir)
	assert.deepEqual(descriptor.scope, scope)
	const client = createClient({ mode: "native", clientDir: f.lease.clientDir })
	const reply = await client.request({ action: "history", scope: null, caller: operator, input: {} })
	assert.equal(reply.invocationId, "invocation")
	assert.deepEqual(reply.result.requests, [])
	await bridge.drain()
	await assert.rejects(fs.stat(path.join(f.lease.clientDir, "connection.json")), { code: "ENOENT" })
	await f.lease.release()
})

test("owner invocation rotates while persistent receipts recover; cached clients reject the successor", async (t) => {
	const f = await setup(t)
	await f.operations.close()
	const first = await createNativeProcessingBridge({ lease: f.lease, workspace: f.workspace, projectId: "project", invocationId: "first", model: "provider/model", client: f.client })
	const client = createClient({ mode: "native", clientDir: f.lease.clientDir })
	const prepared = (await client.request({ action: "submit", scope: null, caller: model, input: { path: "source.pdf", prepareOnly: true } })).result
	await first.drain(); await f.lease.release()
	const lease = await acquireNativeProcessingLease({ clientDir: f.lease.clientDir })
	const second = await createNativeProcessingBridge({ lease, workspace: f.workspace, projectId: "project", invocationId: "second", model: "provider/model", client: f.client })
	try {
		await assert.rejects(client.request({ action: "status", scope, caller: model, input: { requestId: prepared.requestId } }), { code: "OWNER_CHANGED" })
		await client.reopen()
		const accepted = (await client.request({ action: "submit", scope, caller: operator, input: { requestId: prepared.requestId } })).result
		assert.equal(accepted.requestId, prepared.requestId)
		assert.equal(accepted.operationOutcome, "accepted")
		assert.equal(f.submits(), 1)
	} finally { await second.drain(); await lease.release() }
})

test("JS death leaves writer exclusion held by a surviving inherited helper", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-lease-"))
	t.after(() => fs.rm(directory, { recursive: true, force: true }))
	const child = fork(new URL("./fixtures/native-processing-writer-worker.mjs", import.meta.url), [path.join(directory, "client")], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
	let helperPid
	t.after(() => { child.kill("SIGKILL"); if (helperPid) { try { process.kill(helperPid, "SIGKILL") } catch {} } })
	const message = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", (code) => reject(new Error(`writer worker exited ${code}`))) })
	helperPid = message.helper
	const died = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGKILL"); await died
	await sleep(Math.random() * 15)
	await assert.rejects(acquireNativeProcessingLease({ clientDir: path.join(directory, "client") }), { code: "WRITER_IN_USE" })
	process.kill(helperPid, "SIGKILL"); helperPid = null
	let successor
	for (let i = 0; i < 30; i++) { try { successor = await acquireNativeProcessingLease({ clientDir: path.join(directory, "client") }); break } catch (error) { if (error.code !== "WRITER_IN_USE") throw error; await sleep(10) } }
	assert.ok(successor, "kernel releases exclusion only after the inherited effect lease closes")
	await successor.release()
})

test("native history uses processor cursor paging, receipt total and key-free workspace jobs", async (t) => {
	const calls = []
	const f = await setup(t, { request: async (endpoint) => { calls.push(endpoint); return { jobs: [{ id: "workspaceJob", submissionKey: "hidden-key", requestedSource: { path: "hidden-replay" }, state: "partial", projectId: "store" }], nextCursor: "next-cursor" } } })
	await f.operations.submit(operator, { path: "source.pdf", prepareOnly: true })
	await f.operations.submit(operator, { path: "source.pdf", prepareOnly: true })
	const history = await f.operations.history(operator, { offset: 1, limit: 1, cursor: "prior cursor" })
	assert.equal(history.total, 2)
	assert.equal(history.requests.length, 1)
	assert.equal(history.nextCursor, "next-cursor")
	assert.deepEqual(calls, ["/jobs?limit=1&cursor=prior%20cursor"])
	assert.equal(JSON.stringify(history).includes("hidden-"), false)
})

test("native summaries and explicit full manifests remove private metadata but retain sealed relative paths", async (t) => {
	const sha256 = "a".repeat(64), privateMetadata = { submissionKey: "hidden-key", snapshotId: "hidden-snapshot", engineInstanceId: "hidden-engine", storeScope: "hidden-scope", connection: { token: "hidden-token", socketPath: "/hidden/socket" }, absolutePath: "/hidden/store/product.csv", evidencePaths: { candidates: "evidence/candidates.jsonl", private: "../hidden/store.json" } }
	const job = { id: "job", resultId: "result", state: "partial", source: { sha256, bytes: 6, snapshotId: "snapshot" }, modelSelection: { selectedModel: "provider/model", apiKey: "hidden-api" } }
	const manifest = { jobId: "job", resultId: "result", outcome: "partial", source: { sha256, bytes: 6, snapshotId: "snapshot", origin: { kind: "workspace-file", path: "hidden-replay.pdf", expectedSha256: sha256 } }, products: [{ id: "text", path: "pages/p0002.txt", mediaType: "text/plain", bytes: 6, sha256, source: { page: 2 }, ...privateMetadata }], tables: [], coverage: { total: 2, completed: 1 }, stages: [{ id: "ocr", state: "completed", ...privateMetadata }], provenance: { adapter: "pdf", ...privateMetadata } }
	const f = await setup(t, { get: async () => job, results: async () => manifest })
	const summary = await f.operations.result(model, { jobId: "job" })
	assert.equal(JSON.stringify(summary).includes("hidden-"), false)
	assert.equal(JSON.stringify(summary).includes("/hidden/"), false)
	assert.equal(summary.products[0].path, "pages/p0002.txt")
	assert.equal(summary.source.sha256, sha256)
	assert.equal(summary.selectedModel, "provider/model")
	assert.equal(summary.citationToken, undefined)
	const full = await f.operations.result(model, { jobId: "job", fullManifest: true })
	assert.equal(full.view, "sanitized-sealed-manifest")
	assert.equal(full.manifest.products[0].path, "pages/p0002.txt")
	assert.deepEqual(full.manifest.products[0].evidencePaths, { candidates: "evidence/candidates.jsonl" })
	assert.equal(full.manifest.source.snapshotId, undefined)
	assert.equal(full.manifest.source.origin, undefined)
	assert.equal(JSON.stringify(full).includes("hidden-"), false)
	assert.equal(full.citationToken, undefined)
	await assert.rejects(f.operations.result(model, { jobId: "job", fullManifest: "true" }), { code: "INVALID_REQUEST" })
	manifest.source.snapshotId = "different-private-snapshot"
	await assert.rejects(f.operations.result(model, { jobId: "job", fullManifest: true }), { code: "PRODUCT_INTEGRITY" })
})

test("native bounded reads return source hash, pages and exact artifact ranges, without empty witnesses", async (t) => {
	const bytes = Buffer.from("abcdef"), sha256 = createHash("sha256").update(bytes).digest("hex"), sourceHash = "b".repeat(64)
	const manifest = { jobId: "job", resultId: "result", source: { sha256: sourceHash, bytes: 20 }, products: [{ id: "text", sha256, bytes: bytes.length, mediaType: "text/plain", source: { pages: [2, 3] } }], tables: [{ id: "table", source: { page: 2 }, rows: 2 }] }
	const f = await setup(t, { get: async () => ({ id: "job", resultId: "result", state: "partial" }), results: async () => manifest, product: async (_job, _product, { headers }) => { const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(headers.range); return new Response(bytes.subarray(Number(start), Number(end) + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` } }) }, rows: async (_job, _table, { offset }) => ({ offset, count: offset >= 2 ? 0 : 1, total: 2, rows: offset >= 2 ? [] : [{ index: offset + 1, source: { page: 5 }, cells: [{ type: "text", value: "data", source: { page: 6 } }] }], nextOffset: null }) })
	const text = await f.operations.readText(model, { jobId: "job", productId: "text", offset: 2, limit: 2 })
	assert.equal(text.text, "cd")
	assert.equal(text.sourceHash, sourceHash)
	assert.deepEqual(text.pages, [2, 3])
	assert.deepEqual(text.range, { kind: "bytes", start: 2, end: 4 })
	assert.match(text.citationToken, /^processing\/store\/result\/product-text\/bytes-2-4$/)
	const table = await f.operations.readTable(model, { jobId: "job", tableId: "table", offset: 1, limit: 1 })
	assert.equal(table.sourceHash, sourceHash)
	assert.deepEqual(table.pages, [5, 6])
	assert.deepEqual(table.range, { kind: "rows", start: 1, end: 2 })
	assert.match(table.citationToken, /^processing\/store\/result\/table-table\/rows-1-2$/)
	assert.equal(table.rows[0].cells[0].value, "data")
	assert.equal((await f.operations.readText(model, { jobId: "job", productId: "text", offset: 6 })).citationToken, undefined)
	assert.equal((await f.operations.readTable(model, { jobId: "job", tableId: "table", offset: 2 })).citationToken, undefined)
})

test("native admission rejects missing or wrong keyed identities, including cancellation and late observations", async (t) => {
	for (const fields of [{ submissionKey: "wrong", projectId: "store" }, { submissionKey: undefined, projectId: "store" }, { projectId: "replacement" }]) {
		let submits = 0
		const f = await setup(t, { submit: async (key) => { submits++; return { id: "wrongJob", state: "running", submissionKey: key, ...fields } } })
		const prepared = await f.operations.submit(operator, { path: "source.pdf", prepareOnly: true })
		await assert.rejects(f.operations.submit(operator, { requestId: prepared.requestId }), (error) => error.code === "PROCESSOR_IDENTITY_MISMATCH" && error.requestId === prepared.requestId)
		const raw = JSON.parse(await fs.readFile(path.join(f.lease.clientDir, "requests", `${prepared.requestId}.json`)))
		assert.equal(raw.jobId, undefined)
		assert.equal(raw.state, "unknown")
		f.client.lookup = async () => ({ id: "lookupWrong", state: "running", submissionKey: "wrong", projectId: "store" })
		await assert.rejects(f.operations.submit(operator, { requestId: prepared.requestId }), { code: "PROCESSOR_IDENTITY_MISMATCH" })
		assert.equal(submits, 1, "a mismatched lookup must not fall through to replay")
	}
	const f = await setup(t)
	const accepted = await f.operations.submit(model, { path: "source.pdf" })
	f.client.cancelSubmission = async () => ({ cancelled: true, job: { id: accepted.jobId, state: "cancelled", submissionKey: "wrong-key", projectId: "store" } })
	await assert.rejects(f.operations.cancel(model, { requestId: accepted.requestId }), { code: "PROCESSOR_IDENTITY_MISMATCH" })
	f.client.get = async () => ({ id: "otherJob", submissionKey: "wrong-key", projectId: "store", state: "running" })
	await assert.rejects(f.operations.status(model, { requestId: accepted.requestId }), { code: "PROCESSOR_IDENTITY_MISMATCH" })
	const raw = JSON.parse(await fs.readFile(path.join(f.lease.clientDir, "requests", `${accepted.requestId}.json`)))
	assert.equal(raw.jobId, accepted.jobId)
	assert.equal(raw.state, "accepted")
	assert.equal(raw.cancelRequested, true)
	assert.equal(raw.cancellationAcknowledged, undefined)
})
