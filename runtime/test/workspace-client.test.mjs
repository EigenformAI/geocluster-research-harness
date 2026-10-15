import assert from "node:assert/strict"
import http from "node:http"
import { Readable } from "node:stream"
import test from "node:test"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WorkspaceClient, operationResult, pathDiagnostic } from "../lib/workspace-client.js"
import { FilesApi } from "../lib/files.js"
import { FileError, FILE_LIMITS } from "../lib/file-contract.js"

const identity = { workspaceId: "11111111-1111-4111-8111-111111111111", workspaceEpoch: "22222222-2222-4222-8222-222222222222" }
const intent = { ...identity, operationId: "client-1", path: "inputs/a.csv", length: 3, digest: "a".repeat(64), mode: "create", processing: "auto" }

async function serve(t, upload) {
	const calls = []
	const workspace = {
		identity, limits: FILE_LIMITS,
		info: () => ({ ...identity, projectId: "project", cwd: "/workspace/project", operations: ["upload"], limits: FILE_LIMITS }),
		upload: async (stream, options) => { calls.push(options); return upload(stream, options) },
	}
	const api = new FilesApi(workspace, { error() {} })
	const server = http.createServer((req, res) => api.handle(req, res))
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
	t.after(() => { server.closeAllConnections(); server.close() })
	return { calls, client: new WorkspaceClient({ base: `http://127.0.0.1:${server.address().port}` }) }
}

test("HTTP success alone never establishes committed publication", () => {
	for (const state of ["accepted", "streaming", "publishing", "indeterminate", undefined]) {
		assert.equal(operationResult({ operationId: intent.operationId, state }, intent).code, 2)
	}
	assert.equal(operationResult({ operationId: "someone-else", state: "committed" }, intent).code, 2)
	assert.equal(operationResult({ operationId: intent.operationId, state: "failed" }, intent).code, 1)
})

test("read-only path diagnostics reject protected and noncanonical addresses before filesystem access", async () => {
	const info = { projectId: "client-test", cwd: "/workspace/client-test" }
	for (const name of [".runtime/private", "inputs/.git/config", "datasets/source.csv"]) {
		await assert.rejects(pathDiagnostic(info, name), { code: "EACCES" })
	}
	await assert.rejects(pathDiagnostic(info, "inputs/../private"), { error: "invalid_path" })
})

test("upload uses paired fences and create-only automatic processing; collision remains rejection", async t => {
	const f = await serve(t, async () => { throw new FileError(409, "exists", "Create-only destination exists.") })
	const result = await f.client.upload(intent, Readable.from(["abc"]))
	assert.equal(result.code, 1)
	assert.equal(result.result.error, "exists")
	assert.equal(f.calls[0].mode, "create")
	assert.equal(f.calls[0].processingPolicy, "auto")
	assert.equal(f.calls[0].declaredSize, 3)
	assert.equal(f.calls[0].declaredDigest, intent.digest)
})

test("original replay fence rejects a changed workspace before body admission", async t => {
	const f = await serve(t, async () => { throw new Error("must not upload") })
	const result = await f.client.upload({ ...intent, workspaceEpoch: "old-epoch" }, Readable.from(["abc"]))
	assert.equal(result.code, 1)
	assert.equal(result.result.error, "workspace_changed")
	assert.equal(f.calls.length, 0)
})

test("lost transport and malformed receipts are unknown with an exact status command", async () => {
	for (const fetch of [async () => { throw new Error("lost") }, async () => new Response("{}")]) {
		const client = new WorkspaceClient({ fetch })
		const result = await client.upload(intent, Readable.from(["abc"]))
		assert.equal(result.code, 2)
		assert.equal(result.result.statusCommand, `./scripts/workspace.sh status client-1 --workspace-id ${identity.workspaceId} --workspace-epoch ${identity.workspaceEpoch}`)
	}
})

test("lost cleanup receipt remains unknown rather than a claimed rejection", async () => {
	const client = new WorkspaceClient({ fetch: async url => {
		if (url.includes("/files/stat")) return new Response(JSON.stringify({ observation: { token: "fresh" } }))
		throw new Error("lost after delete admission")
	} })
	const result = await client.cleanup(intent)
	assert.equal(result.code, 2)
	assert.match(result.result.statusCommand, /status client-1/)
})

test("actual daemon publications preserve create collisions, reject changed replay bytes, and expose original status", async t => {
	const { WorkspaceFiles } = await import("../lib/workspace-files.js")
	const root = await fs.mkdtemp(path.join(os.homedir(), ".gc-file-client-"))
	await fs.chmod(root, 0o700)
	const cwd = path.join(root, "project")
	await fs.mkdir(cwd, { mode: 0o2775 })
	const logger = { info() {}, warn() {}, error() {} }
	const workspace = await WorkspaceFiles.open({ workspaceDir: cwd, filesStateDir: path.join(root, "private"), filesAgentUids: [20001], filesWorkerUids: [20003], rgBin: "rg" }, logger)
	const api = new FilesApi(workspace, logger)
	const server = http.createServer((req, res) => api.handle(req, res))
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
	t.after(async () => { server.closeAllConnections(); server.close(); await api.close(); await workspace.close(); await fs.rm(root, { recursive: true, force: true }) })
	const client = new WorkspaceClient({ base: `http://127.0.0.1:${server.address().port}` })
	const own = await client.info()
	assert.equal((await client.admission(own)).admission, "open")
	const bytes = "original", digest = crypto.createHash("sha256").update(bytes).digest("hex")
	const request = { ...intent, ...workspace.identity, length: bytes.length, digest, processing: "skip" }
	const first = await client.upload(request, Readable.from([bytes]))
	assert.equal(first.code, 0, JSON.stringify(first.result))
	assert.equal(await fs.readFile(path.join(cwd, request.path), "utf8"), bytes)
	const collision = await client.upload({ ...request, operationId: "collision" }, Readable.from([bytes]))
	assert.equal(collision.code, 1); assert.equal(collision.result.error, "exists")
	const duplicate = await client.upload(request, Readable.from(["x".repeat(bytes.length)]))
	assert.equal(duplicate.code, 0); assert.equal(duplicate.result.currentSourcePublished, false)
	assert.equal(await fs.readFile(path.join(cwd, request.path), "utf8"), bytes)
	const changed = await client.upload({ ...request, digest: "b".repeat(64) }, Readable.from([bytes]))
	assert.equal(changed.code, 1); assert.equal(changed.result.error, "operation_id_reused")
	const status = await client.status(request)
	assert.equal(status.code, 0); assert.equal(status.result.publishedSource.digest.sha256, digest)
	const old = await client.status({ ...request, workspaceEpoch: "old-epoch" })
	assert.equal(old.code, 1); assert.equal(old.result.error, "workspace_changed")
	const unknown = await client.status({ ...request, operationId: "no-receipt" })
	assert.equal(unknown.code, 2); assert.match(unknown.result.statusCommand, /status no-receipt/)
	const badDigest = await client.upload({ ...request, operationId: "digest-mismatch", path: "bad.txt", digest: "c".repeat(64) }, Readable.from([bytes]))
	assert.equal(badDigest.code, 1); assert.equal(badDigest.result.error, "digest_mismatch")
	await assert.rejects(fs.stat(path.join(cwd, "bad.txt")), { code: "ENOENT" })
	const replacement = "explicit replacement"
	const forced = await client.upload({ ...request, operationId: "explicit-replace", mode: "force-replace", length: replacement.length, digest: crypto.createHash("sha256").update(replacement).digest("hex") }, Readable.from([replacement]))
	assert.equal(forced.code, 0); assert.equal(await fs.readFile(path.join(cwd, request.path), "utf8"), replacement)
	const oldReceipt = await client.upload(request, Readable.from([bytes]))
	assert.equal(oldReceipt.code, 0); assert.equal(oldReceipt.result.currentSourcePublished, false)
	assert.equal(await fs.readFile(path.join(cwd, request.path), "utf8"), replacement, "replay cannot replace later bytes")
	const cleanup = await client.cleanup({ ...workspace.identity, operationId: "probe-cleanup", path: "inputs" })
	assert.equal(cleanup.code, 0, JSON.stringify(cleanup.result))
	await assert.rejects(fs.stat(path.join(cwd, "inputs")), { code: "ENOENT" })
	assert.equal((await client.status({ ...workspace.identity, operationId: "probe-cleanup" })).code, 0, "normal deletion retains its receipt")
})
