import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { setTimeout as wait } from "node:timers/promises"
import { test } from "node:test"
import { createFilesServer, loadFilesConfig } from "../files-server.js"
import { processor, until } from "./document-processing-fixture.test.mjs"
import gate from "../gate.cjs"
import { indexed } from "./voxel-fixture.mjs"

const logger = { error() {}, warn() {}, info() {} }
const gateToken = "a".repeat(64), controlToken = "b".repeat(64)
const voxelConfig = (f) => ({ voxelAgentEnabled: false, workspaceDir: f.workspaceDir, filesStateDir: path.join(f.root, "private"), filesAgentUids: [20001], filesWorkerUids: [20003], filesWorkbookWorkerEnabled: false, filesGisWorkerEnabled: false, allowedOrigins: ["https://allowed.example"], controlSecret: controlToken })
async function listenApp(t, config) {
	const app = await createFilesServer({ config, secret: gateToken, logger })
	await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve))
	t.after(() => app.shutdown(new Date(Date.now() + 5000).toISOString()))
	return { app, request: (route, options = {}) => fetch(`http://127.0.0.1:${app.server.address().port}${route}`, options) }
}
async function fixture(t) {
	const root = await fs.mkdtemp(path.join(os.homedir(), ".gc-processing-server-"))
	await fs.chmod(root, 0o700)
	const workspaceDir = path.join(root, "workspace")
	await fs.mkdir(workspaceDir, { mode: 0o2775 })
	const tokenFile = path.join(root, "token")
	await fs.writeFile(tokenFile, "private-processing-token", { mode: 0o600 })
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	return { root, workspaceDir, tokenFile }
}

test("file daemon loads the private preprocessing channel and adjustable admission/storage limits", async (t) => {
	const f = await fixture(t)
	const env = { WORKSPACE_DIR: f.workspaceDir, FILES_STATE_DIR: path.join(f.root, "private"), PREPROCESSING_ENABLED: "true", RUNTIME_AGGREGATE_ACTIVITY: "true", PREPROCESSING_TOKEN_FILE: f.tokenFile, PREPROCESSING_INBOX_DIR: path.join(f.root, "inbox"), PREPROCESSING_PORT: "8766", PREPROCESSING_MAX_ACTIVE_TICKETS: "3", PREPROCESSING_MAX_INPUT_BYTES: "1000", PREPROCESSING_ACTIVITY_MAX_HOURS: "0", PREPROCESSING_HELD_INPUT_WARN_BYTES: "0", PREPROCESSING_STORAGE_RESERVE_BYTES: "0", RUNTIME_ALLOWED_ORIGINS: "https://allowed.example" }
	const config = loadFilesConfig(env)
	assert.equal(config.preprocessing.token, "private-processing-token")
	assert.equal(config.preprocessing.port, 8766)
	assert.equal(config.preprocessing.activeTickets, 3)
	assert.equal(config.preprocessing.inputBytes, 1000)
	assert.equal(config.preprocessing.activityMaxAgeMs, 0)
	assert.equal(config.preprocessing.heldWarningBytes, 0)
	assert.equal(config.preprocessing.storageReserveBytes, 0)
	assert.equal(config.preprocessing.inboxDir, path.join(f.root, "inbox"))
	assert.deepEqual(config.allowedOrigins, ["https://allowed.example"])
	for (const extra of [{ RUNTIME_AGGREGATE_ACTIVITY: "false" }, { PREPROCESSING_MAX_ACTIVE_TICKETS: "0" }, { PREPROCESSING_PORT: "65536" }, { PREPROCESSING_ENABLED: "yes" }, { PREPROCESSING_URL: "http://evil.example" }]) assert.throws(() => loadFilesConfig({ ...env, ...extra }))
})

test("daemon fences stale parser requests before availability gates and keeps its retained identity across restart", async (t) => {
	const f = await fixture(t)
	const config = loadFilesConfig({ VOXEL_AGENT_ENABLED: "false", WORKSPACE_DIR: f.workspaceDir, FILES_STATE_DIR: path.join(f.root, "private"), FILES_AGENT_UIDS: "20001", FILES_WORKER_UIDS: "20003", FILES_WORKER_UID: "20003" })
	const start = async () => {
		const app = await createFilesServer({ config, secret: gateToken, logger })
		await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve))
		t.after(() => app.shutdown(new Date(Date.now() + 5000).toISOString()))
		return { app, request: (route, options = {}) => fetch(`http://127.0.0.1:${app.server.address().port}${route}`, { ...options, headers: { "x-gc-gate": gateToken, ...options.headers } }) }
	}
	const first = await start()
	const identity = await (await first.request("/files/info")).json()
	await first.app.shutdown()
	const second = await start()
	const retained = await (await second.request("/files/info")).json()
	assert.equal(retained.workspaceId, identity.workspaceId)
	assert.equal(retained.workspaceEpoch, identity.workspaceEpoch)
	assert.equal(retained.relayEpochFencingVersion, 1)
	const response = await second.request("/files/preparations", { method: "POST", headers: { "content-type": "application/json", "X-GC-Workspace-ID": retained.workspaceId, "X-GC-Workspace-Epoch": "stale" }, body: JSON.stringify({ requestId: "stale-parser", type: "capture", source: {} }) })
	assert.equal(response.status, 409, "identity rejection must precede worker-unavailable rejection")
	assert.equal((await response.json()).requestId, "stale-parser")
	assert.deepEqual(await second.app.files.workspace.state.list("requests"), [])
})

test("daemon processing is preview-independent; private activity/storage and drain preserve accepted work", async (t) => {
	const f = await fixture(t), p = await processor(t)
	const config = loadFilesConfig({ VOXEL_AGENT_ENABLED: "false", WORKSPACE_DIR: f.workspaceDir, FILES_STATE_DIR: path.join(f.root, "private"), FILES_AGENT_UIDS: "20001", FILES_WORKER_UIDS: "20003", FILES_WORKER_UID: "20003", PREPROCESSING_ENABLED: "true", RUNTIME_AGGREGATE_ACTIVITY: "true", PREPROCESSING_PORT: String(p.port), PREPROCESSING_TOKEN_FILE: f.tokenFile, PREPROCESSING_INBOX_DIR: path.join(f.root, "inbox"), PREPROCESSING_POLL_RUNNING_MS: "10", PREPROCESSING_POLL_QUEUED_MS: "10", RUNTIME_ALLOWED_ORIGINS: "https://allowed.example", PREPROCESSING_STORAGE_RESERVE_BYTES: "1000000" })
	config.controlSecret = controlToken
	const app = await createFilesServer({ config, secret: gateToken, logger })
	await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve))
	t.after(() => app.shutdown(new Date(Date.now() + 5000).toISOString()))
	const base = `http://127.0.0.1:${app.server.address().port}`
	const request = (route, options = {}) => fetch(`${base}${route}`, { ...options, headers: { "x-gc-gate": gateToken, ...options.headers } })
	const control = (route, body) => request(`/internal/files/${route}`, { ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), headers: { "x-gc-files-control": controlToken, "content-type": "application/json" } })
	assert.equal((await request("/internal/files/activity")).status, 403)
	assert.equal((await request("/internal/files/storage", { method: "POST", body: "{}" })).status, 403)
	assert.equal((await request("/internal/files/activity", { headers: { "x-gc-files-control": "é".repeat(64) } })).status, 403)
	for (const [route, method, body] of [["/files/upload?path=report.csv&operationId=bad", "PUT", "a\n1\n"], ["/files/processing/jobs", "POST", JSON.stringify({ requestId: crypto.randomUUID(), source: { kind: "capture", captureId: "missing" } })]]) assert.equal((await request(route, { method, body, headers: { origin: "https://evil.example", "content-type": "application/json" } })).status, 403)
	assert.equal((await request("/files/operations/bad")).status, 404)
	const response = await request("/files/upload?path=report.csv&operationId=accepted", { method: "PUT", body: "a\n1\n", headers: { origin: "https://allowed.example" } })
	assert.equal(response.status, 201)
	const receipt = await response.json()
	assert.equal(receipt.processing.state, "pending")
	await until(async () => (await (await request(receipt.processing.statusUrl)).json()).processorJobId, "processor admission")
	assert.equal((await (await control("activity")).json()).state, "prompt_running")
	assert.equal((await request("/files/preview", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status, 503)
	const measurement = { processorDataBytes: 123, diskFreeBytes: 12, complete: true, observedAt: new Date().toISOString(), oldestResultAt: null, bundleDigest: "c".repeat(64), pair: { state: "starting", attempts: 1, totalLaunches: 1, burstCount: 1, childAlive: true, cooldownMs: 300000, nextRetryAt: null }, activity: { expired: [], unknown: false, observedAt: new Date().toISOString() } }
	assert.equal((await control("storage", measurement)).status, 200)
	const caps = await (await request("/files/processing/capabilities")).json()
	assert.equal(caps.storage.processorDataBytes, 123)
	assert.equal(caps.storage.diskFreeBytes, 12)
	assert.ok(caps.storage.warnings.includes("free_space_warning"))
	assert.equal(caps.enabled, true, "advisory storage never closes admission")
	assert.equal((await control("drain", { deadline: new Date(Date.now() + 5000).toISOString(), admissionOnly: true })).status, 200)
	assert.equal(app.files.workspace.processing.draining, true, "copy/dispatch checkpoint precedes pair settlement")
	assert.equal((await request("/files/processing/jobs", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status, 503)
	assert.equal((await request(`${receipt.processing.statusUrl}/cancel`, { method: "POST" })).status, 202, "accepted-job cancellation remains available during drain")
	assert.equal((await request(receipt.processing.statusUrl)).status, 200)
	assert.equal((await (await control("activity")).json()).state, "prompt_running", "checkpoint cannot fabricate remote completion")
})

test("private voxel reconciliation requires root control and a bounded strict body; effects are auditable", async (t) => {
	const f = await fixture(t), { app, request } = await listenApp(t, voxelConfig(f)), workspace = app.files.workspace
	await fs.writeFile(path.join(f.workspaceDir, "data.csv"), "x,y,z,value\n0,0,0,0\n1,0,0,B\n")
	const { source } = await workspace.captures.create({ requestId: crypto.randomUUID(), path: "data.csv", computeDigest: true })
	const revision = { root: "workspace", resourceId: "data.csv", path: "data.csv", revision: `capture:${source.captureId}`, sha256: source.digest.sha256 }
	const accepted = await workspace.voxels.submit({ kind: "indexed-grid", recipe: indexed(revision), revision: null }, "private-reconcile")
	await workspace.voxels.tasks.get(accepted.operation.id)
	const artifact = (await workspace.state.list("voxel-artifacts"))[0]
	const captureIds = (await workspace.state.list("voxel-owned-captures")).filter((c) => c.artifactId === artifact.artifactId).map((c) => c.captureId)
	const body = { artifactId: artifact.artifactId, generation: artifact.manifest.generation, decision: "confirmed-commit", uploadId: artifact.uploadId, captureIds, reason: "Root inspected exact retained publication evidence" }
	const route = "/internal/voxels/reconcile", headers = { "x-gc-files-control": controlToken, "content-type": "application/json" }
	for (const authority of [{}, { "x-gc-gate": gateToken }, { "x-gc-files-control": "wrong" }, { "x-gc-runtime-control": controlToken }]) {
		assert.equal((await request(route, { method: "POST", headers: authority, body: "{" })).status, 403, "authority precedes JSON parsing")
	}
	assert.equal((await request(route, { headers })).status, 405)
	for (const invalid of ["{", "[]", "null", "{}", JSON.stringify({ ...body, unknown: true }), Buffer.from([0xff])]) {
		const response = await request(route, { method: "POST", headers, body: invalid })
		assert.equal(response.status, 400, String(invalid))
		const error = await response.json(); assert.ok(error.agent && error.tool && error.action); assert.equal(error.error, "invalid_request")
	}
	const tooLarge = JSON.stringify({ ...body, reason: "é".repeat(2200) })
	assert.equal((await request(route, { method: "POST", headers, body: tooLarge })).status, 413)
	assert.equal((await request(route, { method: "POST", headers, body: "{}" + " ".repeat(4094) })).status, 400, "4096 bytes reach schema validation")
	const chunked = await new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: app.server.address().port, path: route, method: "POST", headers: { ...headers, "transfer-encoding": "chunked" } }, (res) => {
			const chunks = []; res.on("data", (chunk) => chunks.push(chunk)); res.on("error", reject)
			res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }))
		})
		req.on("error", reject); req.setTimeout(3000, () => req.destroy(new Error("Private body bound response timed out")))
		req.write(" ".repeat(4096)); req.end(" ")
	})
	assert.equal(chunked.status, 413); assert.equal(chunked.body.error, "body_too_large"); assert.ok(chunked.body.action)
	assert.equal((await request(route, { method: "POST", headers, body: JSON.stringify({ ...body, captureIds: [] }) })).status, 409)
	assert.deepEqual(await workspace.state.list("voxel-reconciliations"), [], "rejected requests have no reconciliation effect")
	const response = await request(route, { method: "POST", headers, body: JSON.stringify(body) })
	assert.equal(response.status, 200, await response.clone().text())
	const result = await response.json()
	assert.equal(result.reconciliation.status, "confirmed")
	assert.equal(result.reconciliation.reason, body.reason)
	assert.deepEqual(await workspace.state.get("voxel-reconciliations", result.reconciliation.id), result.reconciliation)
	await until(async () => (await workspace.state.get("voxel-artifacts", artifact.artifactId)).publicationState === "ready", "reconciled verification")
	assert.equal((await request("/voxels", { method: "POST", headers: { "x-gc-gate": gateToken, "content-type": "application/json" }, body: JSON.stringify({ action: "reconcile", ...body }) })).status, 400, "reconciliation is not a public dispatcher action")
})

test("ordinary daemon listen resumes a process-interrupted committed publication without manual recovery", async (t) => {
	const f = await fixture(t), config = voxelConfig(f)
	await fs.writeFile(path.join(f.workspaceDir, "data.csv"), "x,y,z,value\n0,0,0,0\n1,0,0,B\n")
	const child = spawn(process.execPath, [fileURLToPath(new URL("./voxel-wiring-publication-crash-wr82.mjs", import.meta.url)), JSON.stringify(config)], { stdio: ["ignore", "pipe", "pipe"] })
	let output = "", errors = ""
	child.stdout.on("data", (b) => { output += b }); child.stderr.on("data", (b) => { errors += b })
	t.after(() => child.kill("SIGKILL"))
	let timer
	const code = await Promise.race([new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject) }), new Promise((_, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Publication crash timed out: ${errors}`)) }, 10000) })]).finally(() => clearTimeout(timer))
	assert.equal(code, 88, errors)
	const proof = JSON.parse(output)
	const app = await createFilesServer({ config, secret: gateToken, logger }), workspace = app.files.workspace
	t.after(() => app.shutdown(new Date(Date.now() + 5000).toISOString()))
	assert.equal((await workspace.state.get("operations", proof.uploadId)).state, "committed")
	assert.equal((await workspace.state.get("voxel-operations", proof.operationId)).phase, "publishing")
	await wait(50)
	assert.equal((await workspace.state.get("voxel-operations", proof.operationId)).phase, "publishing", "factory creation alone must not launch recovery workers")
	await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve))
	// Poll the durable journal directly: status reads must not be the cause of settlement.
	const recovered = await until(async () => { const op = await workspace.state.get("voxel-operations", proof.operationId); return op.phase === "ready" && op.named.outcome === "committed" ? op : false }, "automatic publication recovery")
	assert.equal(recovered.artifact.artifactId, proof.artifactId)
	assert.deepEqual((await workspace.state.get("voxel-keys", "wiring-crash")).artifact, recovered.artifact)
	assert.deepEqual((await workspace.state.get("voxel-named", recovered.named.voxelId)).artifact, recovered.artifact)
	assert.equal((await workspace.state.get("voxel-artifacts", proof.artifactId)).verificationState, "verified")
	assert.equal((await workspace.state.list("voxel-artifacts")).length, 1)
	assert.equal((await workspace.state.list("voxel-operations")).length, 1)
	assert.equal((await workspace.state.list("operations")).filter((op) => op.intent?.producerBinding).length, 1, "startup cannot replay manifest publication")
})

test("public gate artifact wiring preserves daemon authority, fence/Origin/body ordering and retry envelopes", async (t) => {
	const f = await fixture(t), { app } = await listenApp(t, voxelConfig(f)), workspace = app.files.workspace
	await fs.writeFile(path.join(f.workspaceDir, "data.csv"), "x,y,z,value\n0,0,0,0\n1,0,0,B\n")
	const { source } = await workspace.captures.create({ requestId: crypto.randomUUID(), path: "data.csv", computeDigest: true })
	const revision = { root: "workspace", resourceId: "data.csv", path: "data.csv", revision: `capture:${source.captureId}`, sha256: source.digest.sha256 }
	const accepted = await workspace.voxels.submit({ kind: "indexed-grid", recipe: indexed(revision), revision: null }, "gate-wiring")
	await workspace.voxels.tasks.get(accepted.operation.id)
	const op = await workspace.voxels.operation(accepted.operation.id), route = `/voxels/artifacts/${op.artifact.artifactId}`
	const key = "c".repeat(64), projectId = "wiring-project", keyFile = path.join(f.root, "key"), gateFile = path.join(f.root, "gate")
	await fs.writeFile(keyFile, key); await fs.writeFile(gateFile, gateToken)
	const gateway = http.createServer((req, res) => { res.writeHead(418); res.end("Wrong upstream") })
	await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve))
	t.after(() => new Promise((resolve) => { gateway.closeAllConnections(); gateway.close(resolve) }))
	const server = gate.createGateServer(gate.loadConfig({ PROJECT_ID: projectId, RUNTIME_GATE_KEY_FILE: keyFile, RUNTIME_GATE_SECRET_FILE: gateFile, RUNTIME_GATEWAY_PORT: String(gateway.address().port), RUNTIME_FILES_PORT: String(app.server.address().port), RUNTIME_ALLOWED_ORIGINS: "https://allowed.example" }), { logger: { log() {}, error() {}, warn() {} } })
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
	const cookie = gate.issueCookie({ key, projectId }).header.split(";")[0], base = `http://127.0.0.1:${server.address().port}`
	const request = (target, options = {}) => fetch(`${base}${target}`, { ...options, headers: { cookie, "x-gc-gate": "spoof", ...options.headers } })
	assert.equal((await fetch(`${base}${route}`)).status, 401)
	const inventory = await request("/voxels/artifacts?limit=1")
	assert.equal(inventory.status, 200); assert.equal((await inventory.json()).artifacts[0].artifactId, op.artifact.artifactId)
	assert.equal((await request(route)).status, 200)
	const malformed = { method: "DELETE", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{" }
	let response = await request(route, { ...malformed, headers: { ...malformed.headers, "x-gc-workspace-id": workspace.identity.workspaceId, "x-gc-workspace-epoch": "stale" } })
	assert.equal(response.status, 409); assert.equal((await response.json()).error, "workspace_changed")
	response = await request(route, malformed); assert.equal(response.status, 403); assert.equal((await response.json()).error, "bad_origin")
	response = await request(route, { ...malformed, headers: { "content-type": "application/json", origin: "https://allowed.example" } }); assert.equal(response.status, 400)
	assert.deepEqual(await workspace.state.list("voxel-deletions"), [])
	// Restart-like unchecked metadata exercises the real lazy-verification retry response.
	const artifact = await workspace.state.get("voxel-artifacts", op.artifact.artifactId)
	await workspace.state.put("voxel-artifacts", artifact.artifactId, { ...artifact, verificationState: "unchecked" })
	response = await request(`/voxels/member?${new URLSearchParams({ manifest: JSON.stringify(op.artifact.manifest), role: "values" })}`)
	assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "1")
	const retry = await response.json(); assert.equal(retry.error, "artifact_verifying"); assert.equal(retry.retryAfter, 1)
	await until(async () => (await workspace.state.get("voxel-artifacts", artifact.artifactId)).verificationState === "verified", "gate verification")
	const body = JSON.stringify({ generation: op.artifact.generation, idempotencyKey: "gate-delete" })
	response = await request(route, { method: "DELETE", body, headers: { "content-type": "application/json", origin: "https://allowed.example" } })
	assert.equal(response.status, 202); const deletion = (await response.json()).deletion
	response = await request(route, { method: "DELETE", body, headers: { "content-type": "application/json" } })
	assert.equal(response.status, 202); assert.equal((await response.json()).deletion.id, deletion.id, "streamed DELETE body and idempotency key survive forwarding")
	assert.equal((await (await request(route)).json()).artifact.availability.state, "deleted")
	for (const target of ["/internal/voxels/reconcile", "/voxels/../internal/voxels/reconcile"]) assert.equal((await request(target, { method: "POST", headers: { "x-gc-files-control": controlToken }, body: "{}" })).status, 404)
	const advertised = await request("/files/openapi.json"); assert.equal(advertised.status, 200)
	const contract = await advertised.json()
	assert.ok(!JSON.stringify(contract).includes("reconcileArtifact")); assert.ok(!JSON.stringify(contract).includes("/internal/voxels/reconcile"))
})
