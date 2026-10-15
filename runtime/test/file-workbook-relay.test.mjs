import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { test } from "node:test"
import { createFilesServer, loadFilesConfig } from "../files-server.js"
import { WorkbookReader } from "../lib/workbook-reader.js"
import { makeWorkbookFixture } from "./workbook-fixtures.mjs"
import { until } from "./document-processing-fixture.test.mjs"

const gateToken = "a".repeat(64), controlToken = "b".repeat(64)
async function fixture(t) {
	const root = await fs.mkdtemp(path.join(os.homedir(), ".gc-workbook-relay-")), workspaceDir = path.join(root, "project")
	await fs.chmod(root, 0o700); await fs.mkdir(workspaceDir)
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const config = loadFilesConfig({ VOXEL_AGENT_ENABLED: "false", WORKSPACE_DIR: workspaceDir, FILES_STATE_DIR: path.join(root, "private"), FILES_AGENT_UIDS: "20001", FILES_WORKER_UIDS: "20003", FILES_WORKER_UID: "20003", FILES_LIMITS: JSON.stringify({ workbookIndexBytes: 65536 }), RUNTIME_ALLOWED_ORIGINS: "https://allowed.example" })
	config.controlSecret = controlToken
	const reader = new WorkbookReader({ testRunner: { synthetic: true, spawn: () => spawn(process.execPath, [new URL("../lib/workbook-reader-worker.cjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "pipe"], env: { GC_WORKBOOK_SYNTHETIC: "1" } }) }, limits: { outputBytes: 65536 } })
	config.filesWorkbookReader = reader
	const app = await createFilesServer({ config, secret: gateToken, logger: { error() {}, warn() {}, info() {} } })
	await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve))
	t.after(() => app.shutdown(new Date(Date.now() + 5000).toISOString()))
	const base = `http://127.0.0.1:${app.server.address().port}`, files = app.files.workspace
	const request = (route, options = {}) => fetch(`${base}${route}`, { ...options, headers: { "x-gc-gate": gateToken, ...options.headers } })
	const post = (route, body, headers = {}) => request(route, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } })
	const info = await (await request("/files/info")).json(), fence = { "X-GC-Workspace-ID": info.workspaceId, "X-GC-Workspace-Epoch": info.workspaceEpoch }
	await fs.writeFile(path.join(workspaceDir, "book.xlsx"), makeWorkbookFixture())
	const captured = await post("/files/captures", { requestId: "input", path: "book.xlsx", computeDigest: true }, fence)
	assert.equal(captured.status, 201)
	const { source } = await captured.json()
	const records = async () => Object.fromEntries(await Promise.all(["requests", "jobs", "holds", "index-reservations", "workbook-indexes"].map(async kind => [kind, await files.state.list(kind)])))
	return { files, reader, info, fence, source, request, post, records, workspaceDir }
}

test("workbook relay: stale preparation is correlated and rejects before any durable effects", async t => {
	const f = await fixture(t), before = await f.records()
	const response = await f.post("/files/preparations", { requestId: "stale-workbook", type: "workbook", source: f.source, options: {} }, { ...f.fence, "X-GC-Workspace-Epoch": "stale-epoch" })
	assert.equal(response.status, 409)
	const failure = await response.json()
	assert.equal(failure.error, "workspace_changed"); assert.equal(failure.requestId, "stale-workbook")
	assert.deepEqual(await f.records(), before, "rejection must not claim a receipt, job, hold, reservation or index")
})

test("workbook daemon: discovery, captured preparation, query/export and drain cancellation preserve fencing", async t => {
	const f = await fixture(t)
	assert.equal(f.info.relayEpochFencingVersion, 1)
	assert.ok(f.info.providers.includes("workbook")); assert.ok(f.info.operations.includes("workbook-query"))
	assert.equal(f.info.preview.state, "unavailable", "workbooks do not require the segment launcher")
	const stat = await (await f.request("/files/stat?path=book.xlsx")).json()
	assert.ok(stat.previewCapabilities.formats.includes("xlsx"))
	const spec = await (await f.request("/files/openapi.json")).json()
	for (const route of ["/files/preparations", "/files/representations/{id}", "/files/representations/{id}/query", "/files/representations/{id}/exports"]) {
		const operation = spec.paths[route].post || spec.paths[route].get
		for (const name of Object.keys(f.fence)) assert.ok(operation.parameters.some(parameter => parameter.name === name), `${route}: ${name}`)
	}
	const prepared = await f.post("/files/preparations", { requestId: "accepted", type: "workbook", source: f.source, options: {} }, f.fence)
	assert.equal(prepared.status, 202)
	const { jobId } = await prepared.json()
	await until(async () => (await f.files.job(jobId)).state === "succeeded", "workbook preparation", 5000)
	const { representation } = (await f.files.job(jobId)).result
	assert.equal((await f.request(`/files/representations/${representation.id}`, { headers: f.fence })).status, 200)
	const query = { sheet: "sheet-0", headerRows: [0], columnLimit: 6 }
	const page = await f.post(`/files/representations/${representation.id}/query`, query, f.fence)
	assert.equal(page.status, 200); assert.equal((await page.json()).matchingRows, 2)
	const exported = await f.post(`/files/representations/${representation.id}/exports`, { query, selectedRows: [1], formulaHandling: "exact" }, f.fence)
	assert.equal(exported.status, 200); assert.ok((await exported.json()).csv.includes("00123"))
	let entered = false
	f.reader.parse = async ({ signal }) => { entered = true; await new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }) }) }
	await fs.writeFile(path.join(f.workspaceDir, "book.xlsx"), makeWorkbookFixture("xlsx", { text: "second input" }))
	const second = await f.post("/files/captures", { requestId: "second-input", path: "book.xlsx" }, f.fence)
	assert.equal(second.status, 201)
	const { source } = await second.json()
	const pending = await f.post("/files/preparations", { requestId: "pending", type: "workbook", source, options: {} }, f.fence)
	assert.equal(pending.status, 202)
	const pendingId = (await pending.json()).jobId
	await until(() => entered, "blocked reader")
	const deadline = new Date(Date.now() + 5000).toISOString()
	assert.equal((await f.post("/internal/files/drain", { deadline, admissionOnly: true }, { "x-gc-files-control": controlToken })).status, 200)
	const before = await f.records(), stale = { ...f.fence, "X-GC-Workspace-Epoch": "stale-epoch", origin: "https://evil.example" }
	for (const [route, body] of [["/files/preparations", { requestId: "stale-draining", type: "workbook", source }], ["/files/preview", { requestId: "stale-preview", path: "book.xlsx", format: "text" }], ["/files/processing/jobs", { requestId: "stale-processing", source: { kind: "capture", captureId: source.captureId } }]]) {
		const rejected = await f.post(route, body, stale)
		assert.equal(rejected.status, 409); const failure = await rejected.json(); assert.equal(failure.error, "workspace_changed"); assert.equal(failure.requestId, body.requestId)
	}
	assert.deepEqual(await f.records(), before)
	assert.equal((await f.post("/files/preparations", { requestId: "draining", type: "workbook", source }, f.fence)).status, 503)
	assert.equal((await f.post(`/files/jobs/${pendingId}/cancel`, {}, f.fence)).status, 200)
	await until(async () => (await f.files.job(pendingId)).state === "cancelled", "cancelled workbook")
	const drained = await f.post("/internal/files/drain", { deadline }, { "x-gc-files-control": controlToken })
	assert.equal(drained.status, 200); assert.equal((await drained.json()).complete, true, "drain confirms cleanup after the terminal receipt")
	assert.deepEqual(await f.files.state.list("holds"), []); assert.deepEqual(await f.files.state.list("index-reservations"), [])
})
