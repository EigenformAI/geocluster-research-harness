import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { setTimeout as wait } from "node:timers/promises"
import { test } from "node:test"
import { FilesApi } from "../lib/files.js"
import { WorkspaceFiles } from "../lib/workspace-files.js"
import { processor, sha, until } from "./document-processing-fixture.test.mjs"

const logger = { error() {}, warn() {}, info() {} }
const jobId = "processing_3548179d-27ee-48f8-9430-e58d5f0c6fe3"
const baseRoute = `/files/processing/jobs/${jobId}`
const job = { id: jobId, deliveryStage: "pending", resultAvailable: false }

async function serve(t, workspace, beforeHandle = () => {}) {
	const files = new FilesApi(workspace, logger)
	const server = http.createServer(async (req, res) => {
		beforeHandle(req)
		if (!await files.handle(req, res)) { res.writeHead(404); res.end() }
	})
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	t.after(async () => { await files.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
	const base = `http://127.0.0.1:${server.address().port}`
	return { files, base, request: (route, options) => fetch(`${base}${route}`, options), post: (route, value, headers = {}) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) }) }
}

test("processing HTTP cancellation locates pending and settled jobs", async (t) => {
	let settled = false
	const f = await serve(t, { info() {}, processing: {
		async cancel() { const status = settled ? 200 : 202; settled = true; return { status, job } },
	} })
	for (const status of [202, 200]) {
		const response = await f.request(`${baseRoute}/cancel`, { method: "POST" })
		assert.equal(response.status, status)
		assert.equal(response.headers.get("location"), baseRoute)
		assert.deepEqual((await response.json()).job, job)
	}
})

test("processing HTTP validates every path ID and exactly the declared bounded queries before dispatch", async (t) => {
	let calls = 0
	const f = await serve(t, { info() {}, processing: Object.fromEntries(["get", "list", "rows", "product", "results", "capabilities"].map((name) => [name, () => { calls++; return {} }])) })
	const routes = [
		"/files/processing/jobs/bad%2Fid", "/files/processing/jobs/%FF", `${baseRoute}/products/bad%2Fid`, `${baseRoute}/products/%E2%82`, `${baseRoute}/tables/bad%00id/rows`, `${baseRoute}/tables/%GG/rows`,
		"/files/processing/jobs?limit=1&limit=1", "/files/processing/jobs?limit=201", "/files/processing/jobs?limit=0", "/files/processing/jobs?limit=", "/files/processing/jobs?limit=0x10", "/files/processing/jobs?cursor=%FF", "/files/processing/jobs?cursor=a&cursor=a", "/files/processing/jobs?uploadOperationId=bad%2Fid", "/files/processing/jobs?submissionKey=private",
		"/files/processing/capabilities?url=http://example.com", `${baseRoute}?limit=1`, `${baseRoute}/results?raw=1`, `${baseRoute}/products/product_one?download=1`,
		`${baseRoute}/tables/table_one/rows?limit=1001`, `${baseRoute}/tables/table_one/rows?limit=1&limit=1`, `${baseRoute}/tables/table_one/rows?offset=-1`, `${baseRoute}/tables/table_one/rows?offset=1e2`, `${baseRoute}/tables/table_one/rows?offset=9007199254740992`, `${baseRoute}/tables/table_one/rows?offset=`, `${baseRoute}/tables/table_one/rows?responseBytes=1`,
	]
	for (const route of routes) assert.equal((await f.request(route)).status, 400, route)
	assert.equal(calls, 0, "invalid routing inputs cannot reach the processing authority")
	for (const route of ["/files/processing/engine/reconcile", "/files/processing/proxy", "/files/processing/mcp"]) assert.equal((await f.request(route, { method: "POST" })).status, 404)
})

test("processing products stream Web Responses, retain validators/ranges and strip unrelated headers", async (t) => {
	const calls = []
	const f = await serve(t, { info() {}, processing: { async product(id, productId, options) {
		calls.push([id, productId, options])
		const status = options.headers["if-none-match"] ? 304 : options.method === "HEAD" ? 200 : options.headers.range ? 206 : 200
		return new Response(status === 304 || options.method === "HEAD" ? null : "<svg", { status, headers: { "content-type": "image/svg+xml", "content-length": "4", ...(status === 206 ? { "content-range": "bytes 0-3/26" } : {}), etag: '"strong"', "accept-ranges": "bytes", "last-modified": "Thu, 01 Oct 2026 00:00:00 GMT", "content-disposition": "attachment; filename=active.svg", "set-cookie": "secret=private", authorization: "Bearer private", "x-private-control": "secret", location: "/private" } })
	} } })
	const headers = { range: "bytes=0-3", "if-range": '"strong"', "if-match": '"strong"', "if-modified-since": "Thu, 01 Oct 2026 00:00:00 GMT", "if-unmodified-since": "Thu, 01 Oct 2026 00:00:00 GMT", origin: "https://allowed.example", cookie: "session=caller", authorization: "Bearer caller", "x-gc-internal-control": "spoof" }
	const response = await f.request(`${baseRoute}/products/product%3Aone`, { headers })
	assert.equal(response.status, 206)
	assert.equal(await response.text(), "<svg")
	assert.equal(response.headers.get("content-range"), "bytes 0-3/26")
	assert.equal(response.headers.get("content-length"), "4")
	assert.equal(response.headers.get("etag"), '"strong"')
	assert.match(response.headers.get("content-disposition"), /^attachment;/)
	assert.equal(response.headers.get("x-content-type-options"), "nosniff")
	for (const name of ["set-cookie", "authorization", "x-private-control", "location"]) assert.equal(response.headers.get(name), null)
	assert.deepEqual(calls[0], [jobId, "product:one", { method: "GET", headers: Object.fromEntries(Object.entries(headers).filter(([name]) => !["origin", "cookie", "authorization", "x-gc-internal-control"].includes(name))) }])
	const head = await f.request(`${baseRoute}/products/product_one`, { method: "HEAD", headers: { range: "bytes=invalid", "if-range": '"strong"', "if-match": '"strong"' } })
	assert.equal(head.status, 200)
	assert.equal(await head.text(), "")
	assert.deepEqual(calls.at(-1)[2], { method: "HEAD", headers: { "if-match": '"strong"' } })
	const conditional = await f.request(`${baseRoute}/products/product_one`, { headers: { "if-none-match": 'W/"strong"' } })
	assert.equal(conditional.status, 304)
	assert.equal(await conditional.text(), "")
	assert.equal(conditional.headers.get("etag"), '"strong"')
})

test("processing product disconnects cancel the Web stream without buffering the whole download", async (t) => {
	let cancelled = false, pulls = 0
	const f = await serve(t, { info() {}, processing: { async product() {
		return new Response(new ReadableStream({ async pull(sink) { pulls++; await wait(2); sink.enqueue(new Uint8Array(65536)) }, cancel() { cancelled = true } }, { highWaterMark: 0 }), { headers: { "content-type": "application/octet-stream" } })
	} } })
	await new Promise((resolve, reject) => {
		const req = http.get(`${f.base}${baseRoute}/products/product_one`, (res) => { res.once("data", () => { res.destroy(); resolve() }); res.on("error", () => {}) })
		req.on("error", reject)
	})
	await until(() => cancelled, "upstream Web stream cancellation")
	assert.ok(pulls < 100, `only ${pulls} chunks read before disconnect`)
})

test("upload processing policy rejects malformed and repeated raw headers before the body arrives", async (t) => {
	let uploads = 0
	const f = await serve(t, { info() {}, async upload() { uploads++; throw new Error("invalid header admitted") } })
	for (const values of [["AUTO"], ["auto, skip"], ["auto, auto"], [""], ["auto", "auto"], ["skip", "skip"], ["auto", "skip"]]) {
		await new Promise((resolve, reject) => {
			const headers = ["Host", new URL(f.base).host, "Content-Length", "1000000", ...values.flatMap((value, index) => [index % 2 ? "x-gc-process-document" : "X-GC-Process-Document", value])]
			const req = http.request(`${f.base}/files/upload?path=report.csv&operationId=invalid`, { method: "PUT", headers }, (res) => {
				let text = ""
				res.on("data", (chunk) => { text += chunk })
				res.on("end", () => { try { assert.equal(res.statusCode, 400, JSON.stringify(values)); assert.equal(JSON.parse(text).error, "invalid_processing_policy"); resolve() } catch (error) { reject(error) } finally { req.destroy() } })
			})
			req.on("error", (error) => { if (error.code !== "ECONNRESET") reject(error) })
			req.flushHeaders()
		})
	}
	assert.equal(uploads, 0)
})

test("identical repeated upload policy fields reject even when middleware folds the normalized header", async (t) => {
	let uploads = 0
	const f = await serve(t, { info() {}, async upload() { uploads++; throw new Error("repeated policy admitted") } }, (req) => {
		// Model a middleware-normalized value while retaining the original wire fields.
		req.headers["x-gc-process-document"] = "auto"
	})
	await new Promise((resolve, reject) => {
		const req = http.request(`${f.base}/files/upload?path=report.csv&operationId=repeated`, { method: "PUT", headers: ["Host", new URL(f.base).host, "Content-Length", "1000000", "X-GC-Process-Document", "auto", "x-gc-process-document", "auto"] }, (res) => {
			let text = ""
			res.on("data", (chunk) => { text += chunk })
			res.on("end", () => { try { assert.equal(res.statusCode, 400); assert.equal(JSON.parse(text).error, "invalid_processing_policy"); resolve() } catch (error) { reject(error) } finally { req.destroy() } })
		})
		req.on("error", (error) => { if (error.code !== "ECONNRESET") reject(error) })
		req.flushHeaders()
	})
	assert.equal(uploads, 0)
})

async function realWorkspace(t) {
	const p = await processor(t), root = await fs.mkdtemp(path.join(os.homedir(), ".gc-processing-http-"))
	await fs.chmod(root, 0o700)
	const workspaceDir = path.join(root, "workspace")
	await fs.mkdir(workspaceDir, { mode: 0o2775 })
	const workspace = await WorkspaceFiles.open({ workspaceDir, filesStateDir: path.join(root, "private"), filesAgentUids: [20001], filesWorkerUids: [20003], rgBin: "rg", preprocessing: { enabled: true, aggregateActivity: true, inboxDir: path.join(root, "inbox"), port: p.port, token: "private-processing-token", runningPollMs: 10, queuedPollMs: 10, transportMs: 1000 } }, logger)
	t.after(async () => { await workspace.close(); await fs.rm(root, { recursive: true, force: true }) })
	return { p, workspace, root: workspaceDir, ...await serve(t, workspace) }
}

test("public uploads reach the real coordinator once; receipts hide admission secrets and keep processing/source retention", async (t) => {
	const f = await realWorkspace(t)
	const upload = (id, name, bytes, headers = {}, query = "") => f.request(`/files/upload?path=${name}&operationId=${id}${query}`, { method: "PUT", body: bytes, headers })
	const response = await upload("automatic", "report.csv", "a\n1\n")
	assert.equal(response.status, 201)
	const receipt = await response.json()
	assert.equal(receipt.processing.policy, "auto")
	assert.equal(receipt.processing.state, "pending")
	assert.equal(receipt.processingAdmission, undefined)
	assert.match(receipt.sourceRetention.availabilityUrl, /^\/files\/captures\//)
	assert.ok(Date.parse(receipt.sourceRetention.receiptExpiresAt) > Date.parse(receipt.committedAt))
	const replay = await upload("automatic", "report.csv", "oops")
	assert.equal(replay.status, 200)
	assert.equal((await replay.json()).processingAdmission, undefined)
	const status = await (await f.request("/files/operations/automatic")).json()
	assert.equal(status.processingAdmission, undefined)
	assert.deepEqual(status.processing, receipt.processing)
	assert.deepEqual(status.sourceRetention, receipt.sourceRetention)
	assert.ok((await f.workspace.operation("automatic")).processingAdmission.upstreamSubmissionKey, "internal admission remains available for recovery")
	assert.equal((await upload("automatic", "report.csv", "oops", { "x-gc-process-document": "skip" })).status, 409)
	const reused = await f.post("/files/processing/jobs", { requestId: crypto.randomUUID(), source: { kind: "upload-operation", operationId: "automatic" } })
	assert.equal(reused.status, 200)
	assert.equal(reused.headers.get("location"), receipt.processing.statusUrl)
	assert.equal((await reused.json()).job.id, receipt.processing.jobId)
	const skipped = await upload("skipped", "skip.csv", "x\n", { "x-gc-process-document": "skip" })
	assert.equal(skipped.status, 201)
	assert.equal((await skipped.json()).processing.reason, "opt_out")
	await fs.writeFile(path.join(f.root, "report.csv"), "replacement-B")
	await until(() => f.p.jobs.size === 1, "automatic upstream admission")
	assert.equal(f.p.lastBody.tableRecovery, undefined)
	assert.equal(f.p.lastBody.source.expectedSha256, sha("a\n1\n"))
	assert.equal(await fs.readFile(path.join(f.workspace.processing.config.inboxDir, f.p.lastBody.source.path), "utf8"), "a\n1\n")
	const route = receipt.processing.statusUrl
	assert.equal((await f.request(`${route}/results`)).status, 409)
	const upstream = [...f.p.jobs.values()][0]
	upstream.source = { snapshotId: "source_retained", sha256: sha("a\n1\n"), bytes: 4, filename: "report.csv" }; upstream.state = "partial"; upstream.resultId = "result_one"; upstream.documents = { state: "failed", path: "/private/published" }; upstream.revision++
	await until(async () => (await f.workspace.processing.get(receipt.processing.jobId)).resultAvailable, "sealed results")
	const results = await (await f.request(`${route}/results`)).json()
	assert.equal(results.view, "translated-api-manifest")
	assert.equal(results.manifest.jobId, receipt.processing.jobId)
	assert.equal(results.manifest.products[0].contentUrl, `${route}/products/product_svg`)
	assert.equal(results.manifest.tables[0].downloads[0].spreadsheetFormulaPolicy, "preserve")
	assert.doesNotMatch(JSON.stringify(results), /\/private|\/preprocessing|secret|typedPath|csvPath/)
	const rows = await (await f.request(`${route}/tables/table_one/rows?offset=0&limit=1`)).json()
	assert.equal(rows.rows[0].cells[0].type, "formula")
	assert.equal(f.p.requests.filter((request) => request.path.includes("/tables/")).at(-1).path.endsWith("rows?offset=0&limit=1"), true)
	const product = await f.request(`${route}/products/product_svg`, { headers: { range: "bytes=0-3", authorization: "Bearer spoof", cookie: "session=spoof", origin: "https://allowed.example" } })
	assert.equal(product.status, 206)
	assert.equal(await product.text(), "<svg")
	assert.equal(product.headers.get("etag"), '"strong"')
	assert.match(product.headers.get("content-disposition"), /^attachment;/)
	assert.equal(product.headers.get("set-cookie"), null)
	const sent = f.p.requests.filter((request) => request.path.includes("/products/")).at(-1).headers
	assert.equal(sent.authorization, "Bearer private-processing-token")
	assert.equal(sent.cookie, undefined)
	assert.equal(sent.origin, undefined)
	const productRequests = f.p.requests.filter((request) => request.path.includes("/products/")).length
	assert.equal((await f.request(`${route}/products/unlisted`)).status, 404)
	assert.equal((await f.request(`${route}/tables/unlisted/rows`)).status, 404)
	assert.equal(f.p.requests.filter((request) => request.path.includes("/products/")).length, productRequests)
	f.p.options.rangeError = true
	const unsatisfied = await f.request(`${route}/products/product_svg`, { headers: { range: "bytes=999-" } })
	assert.equal(unsatisfied.status, 416)
	assert.equal(unsatisfied.headers.get("content-range"), `bytes */${f.p.products.length}`)
	assert.doesNotMatch(await unsatisfied.text(), /private|secret/)
	assert.equal(f.p.jobs.size, 1)
})

test("manual HTTP requests enforce UUID/source/PDF options and support retained snapshot reruns", async (t) => {
	const f = await realWorkspace(t)
	await fs.writeFile(path.join(f.root, "manual.csv"), "a\n1\n")
	await fs.writeFile(path.join(f.root, "manual.pdf"), "%PDF-fixture")
	const csv = await f.workspace.stat("manual.csv")
	const invalid = [
		{ requestId: "not-a-uuid", source: { kind: "capture", captureId: "x" } },
		{ source: { kind: "workspace-file", path: "manual.csv" } },
		{ source: { kind: "workspace-file", path: "manual.csv", baseObservation: csv.observation, captureId: "x" } },
		{ source: { kind: "snapshot", snapshotId: "private" } },
		{ source: { kind: "workspace-file", path: "manual.csv", baseObservation: csv.observation }, tableRecovery: { vision: "off" } },
		{ source: { kind: "workspace-file", path: "manual.pdf", baseObservation: "current" }, tableRecovery: { renderDpi: 0 } },
		{ source: { kind: "capture", captureId: "x" }, tableRecovery: { geometry: "invalid" } },
	]
	for (const value of invalid) assert.equal((await f.post("/files/processing/jobs", { requestId: crypto.randomUUID(), ...value })).status, 400)
	assert.equal(f.p.posts, 0)
	const pdf = await f.workspace.stat("manual.pdf"), request = { requestId: crypto.randomUUID(), source: { kind: "workspace-file", path: "manual.pdf", baseObservation: pdf.observation }, tableRecovery: { renderDpi: 144.5, forcePages: [2, 1, 2], maxAdditionalPasses: 0, maxModelCalls: null, workSeconds: null, vision: "off" } }
	const admitted = await f.post("/files/processing/jobs", request)
	assert.equal(admitted.status, 202)
	const { job } = await admitted.json()
	assert.equal((await f.post("/files/processing/jobs", request)).status, 200)
	assert.equal((await f.post("/files/processing/jobs", { ...request, tableRecovery: { vision: "confirm-all" } })).status, 409)
	await until(() => f.p.jobs.size === 1)
	assert.deepEqual(f.p.lastBody.tableRecovery, { ...request.tableRecovery, forcePages: [1, 2] })
	const upstream = [...f.p.jobs.values()][0]
	upstream.source = { snapshotId: "source_retained", sha256: sha("%PDF-fixture"), bytes: 12, filename: "manual.pdf" }; upstream.state = "succeeded"; upstream.revision++
	await until(async () => (await f.workspace.processing.get(job.id)).state === "succeeded")
	const rerun = await f.post("/files/processing/jobs", { requestId: crypto.randomUUID(), rerunOf: job.id })
	assert.equal(rerun.status, 202)
	assert.notEqual((await rerun.json()).job.id, job.id)
	await until(() => f.p.jobs.size === 2)
	assert.deepEqual(f.p.lastBody.source, { kind: "snapshot", snapshotId: "source_retained" })
})
