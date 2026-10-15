import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { setTimeout as wait } from "node:timers/promises"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createFilesServer } from "../files-server.js"
import { VoxelService } from "../lib/voxels.js"
import { historical } from "./voxel-fixture.mjs"

const secret = "a".repeat(64), logger = { info() {}, warn() {}, error() {} }
export function indexed(source, name = "Pattern") {
	return { schemaVersion: 1, algorithm: "geocluster-indexed-v1", name, scope: { input: { type: "delimited", resourceId: source.path, source, delimiter: "," }, range: { rowStart: 0, rowEnd: 2, columnStart: 0, columnEnd: 3 }, headerRows: [0] }, indices: { x: 0, y: 1, z: 2, base: 0 }, shape: [2, 1, 1], placement: { origin: [0, 0, 0], spacing: [1, 1, 1], unit: "grid-unit", horizontalReference: { type: "unreferenced", definition: "" }, verticalReference: null }, field: { kind: "categorical", column: 3, name: "Class", trim: false }, numbers: { decimal: ".", thousands: "none", missingTokens: [], sentinels: [], censored: "exclude" }, emptyCells: "forbid", predecessor: null }
}
async function fixture(t, extra = {}) {
	const root = await fs.mkdtemp(path.join(os.homedir(), ".gc-aligned-")), workspaceDir = path.join(root, "workspace")
	await fs.mkdir(workspaceDir)
	const config = { workspaceDir, filesStateDir: path.join(root, "private"), filesAgentUids: [20001], filesWorkerUids: [20003], filesWorkbookWorkerEnabled: false, filesGisWorkerEnabled: false, ...extra }
	let app
	const start = async () => { app = await createFilesServer({ config, secret, logger }); await new Promise((r) => app.server.listen(0, "127.0.0.1", r)); app.files.workspace.voxels.startRecovery() }
	await start()
	t.after(async () => { await app.shutdown(); await fs.rm(root, { recursive: true, force: true }) })
	const request = (route, options = {}) => fetch(`http://127.0.0.1:${app.server.address().port}${route}`, { ...options, headers: { "x-gc-gate": secret, ...options.headers } })
	return { root, config, workspaceDir, get app() { return app }, get service() { return app.files.workspace.voxels }, request, async post(body, status = 200) { const res = await request("/voxels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const result = await res.json(); assert.equal(res.status, status, JSON.stringify(result)); return result }, async capture(name, csv = "x,y,z,value\n0,0,0,0\n1,0,0,B\n") { await fs.writeFile(path.join(workspaceDir, name), csv); const { source } = await app.files.workspace.captures.create({ requestId: crypto.randomUUID(), path: name, computeDigest: true }); return { root: "workspace", resourceId: name, path: name, revision: `capture:${source.captureId}`, sha256: source.digest.sha256 } }, async restart() { await app.shutdown(); await start() } }
}
async function settled(service, id) { for (let n = 0; n < 500; n++) { const op = await service.operation(id); if (["ready", "failed"].includes(op.phase)) { await service.tasks.get(id); return op }; await wait(10) }; throw new Error("Operation did not settle") }
async function create(f, recipe, key, revision = null) { return settled(f.service, (await f.service.submit({ kind: "indexed-grid", recipe, revision }, key)).operation.id) }
const target = (head) => ({ voxelId: head.voxelId, expectedHeadRevision: head.headRevision, base: head.artifact })
test("loss of original input reports separate source evidence without rewriting saved history or the named head", async (t) => {
	const f = await fixture(t), source = await f.capture("pattern.csv"), op = await create(f, indexed(source), "first")
	const captureId = source.revision.slice(8), captured = await f.app.files.workspace.state.get("captures", captureId)
	await f.app.files.workspace.state.put("captures", captureId, { ...captured, evictedAt: new Date().toISOString() })
	const oldInspection = await f.service.inspectArtifact({ artifact: op.artifact, options: {} }); assert.equal(oldInspection.sourceAvailability[0].state, "unavailable")
	await f.restart(); assert.equal((await f.service.operation(op.id)).phase, "ready"); assert.deepEqual((await f.service.namedResolve({ voxelId: op.named.voxelId })).artifact, op.artifact)
})
test("blocked scans never publish artifacts or ghost named voxels", async (t) => {
	const f = await fixture(t), source = await f.capture("duplicate.csv", "x,y,z,value\n0,0,0,A\n0,0,0,A\n"), r = indexed(source)
	const check = await f.post({ action: "validate", recipe: r }); assert.equal(check.summary.duplicateCellGroups, 1); assert.ok(check.blockingErrors.length); assert.deepEqual(check.issues.find((i) => i.kind === "duplicate-cell").rows, [2, 3])
	const failed = await create(f, r, "blocked"); assert.equal(failed.phase, "failed"); assert.equal(failed.named.outcome, "failed"); assert.deepEqual((await f.service.namedList({})).voxels, []); assert.deepEqual(await f.app.files.workspace.state.list("voxel-artifacts"), [])
})
test("service same-key replay after later advance, stale full base conflict retains artifact; exact-name pagination and rename", async (t) => {
	const f = await fixture(t), source = await f.capture("pattern.csv"), r = indexed(source)
	const first = await create(f, r, "first"), head = await f.service.namedResolve({ voxelId: first.named.voxelId })
	const second = await create(f, r, "second", target(head)); assert.equal(second.named.outcome, "committed")
	const latest = await f.service.namedResolve({ voxelId: head.voxelId })
	const conflict = await create(f, r, "stale", { ...target(latest), base: first.artifact }); assert.equal(conflict.named.outcome, "conflict"); assert.ok(conflict.artifact)
	const replay = await f.service.submit({ kind: "indexed-grid", recipe: r, revision: target(head) }, "second"); assert.deepEqual(replay.operation, second)
	assert.deepEqual((await f.service.namedResolve({ voxelId: head.voxelId })).artifact, second.artifact)
	await create(f, r, "duplicate-name"); await assert.rejects(f.service.namedResolve({ name: "Pattern" }), { error: "ambiguous_name" })
	const page = await f.post({ action: "named-list", limit: 1, cursor: null, name: "Pattern" }); assert.equal(page.voxels.length, 1); assert.ok(page.cursor)
	const next = await f.service.namedList({ limit: 1, cursor: page.cursor, name: "Pattern" }); assert.equal(next.voxels.length, 1); assert.equal(next.cursor, null); assert.notEqual(page.voxels[0].voxelId, next.voxels[0].voxelId)
	await assert.rejects(f.service.namedList({ cursor: page.cursor, name: "Other" }), { error: "invalid_cursor" })
	const renamed = (await f.post({ action: "rename", voxelId: latest.voxelId, name: "Renamed", expectedHeadRevision: latest.headRevision })).voxel
	assert.equal(renamed.voxelId, head.voxelId); assert.equal(renamed.name, "Renamed"); assert.notEqual(renamed.headRevision, latest.headRevision)
	await f.post({ action: "rename", voxelId: latest.voxelId, name: "Stale", expectedHeadRevision: latest.headRevision }, 409)
	await f.restart(); historical((await f.service.submit({ kind: "indexed-grid", recipe: r, revision: target(head) }, "second")).operation, second)
})
test("saved head survives later member unavailability across restart and refuses complete-volume inspection", async (t) => {
	const f = await fixture(t), source = await f.capture("pattern.csv"), op = await create(f, indexed(source), "missing-member")
	const state = f.app.files.workspace.state, artifact = await state.get("voxel-artifacts", op.artifact.artifactId), id = artifact.members.valid.source.revision.slice(8), record = await state.get("captures", id)
	await state.put("captures", id, { ...record, evictedAt: new Date().toISOString() })
	await assert.rejects(f.service.inspectArtifact({ artifact: op.artifact, options: {} }))
	await f.restart()
	const recovered = await f.service.operation(op.id); assert.equal(recovered.phase, "ready"); assert.deepEqual(recovered.artifact, op.artifact)
	const head = await f.service.namedResolve({ voxelId: op.named.voxelId }); assert.equal(head.availability.state, "unchecked"); assert.deepEqual(head.artifact, op.artifact)
})
test("global capture unavailability leaves saved history and named head readable during service recovery", async (t) => {
	const f = await fixture(t), source = await f.capture("pattern.csv"), op = await create(f, indexed(source), "global-unavailable")
	await f.service.tasks.get(op.id)
	const captures = f.app.files.workspace.captures, availability = captures.availability, recovering = new VoxelService(f.app.files.workspace)
	captures.availability = { state: "unavailable", reason: "ownership" }
	try {
		await recovering.init()
		assert.equal((await recovering.operation(op.id)).phase, "ready")
		const head = await recovering.namedResolve({ voxelId: op.named.voxelId }); assert.deepEqual(head.artifact, op.artifact); assert.equal(head.availability.state, "temporarily-unavailable")
	} finally { captures.availability = availability; await recovering.close() }
})
test("two services save competing revisions before one SQL-authoritative head commit", async (t) => {
	let arrivals = 0, release
	const barrier = new Promise((r) => { release = r })
	const f = await fixture(t, { voxelCheckpoint: async (stage, op) => { if (stage === "before-named-commit" && op.submission.revision) { arrivals++; if (arrivals === 2) release(); await barrier; await wait(Math.random() * 15) } } }), source = await f.capture("pattern.csv")
	t.after(() => release())
	const r = indexed(source), initial = await create(f, r, "initial"), head = await f.service.namedResolve({ voxelId: initial.named.voxelId }), secondService = new VoxelService(f.app.files.workspace)
	t.after(() => secondService.close())
	const intent = { kind: "indexed-grid", recipe: r, revision: target(head) }
	const accepted = await Promise.all([f.service.submit(intent, "left"), secondService.submit(intent, "right")])
	const outcomes = await Promise.all(accepted.map((a) => settled(f.service, a.operation.id)))
	assert.deepEqual(outcomes.map((op) => op.named.outcome).sort(), ["committed", "conflict"]); assert.ok(outcomes.every((op) => op.artifact))
})
test("initial and revision process crash checkpoints recover existing association without regeneration or old CAS", async (t) => {
	for (const revision of [false, true]) for (const checkpoint of ["accepted", "generating", "registered", "before-named-commit", "named-committed"]) {
		const root = await fs.mkdtemp(path.join(os.homedir(), ".gc-named-crash-")), workspaceDir = path.join(root, "workspace")
		await fs.mkdir(workspaceDir); await fs.writeFile(path.join(workspaceDir, "pattern.csv"), "x,y,z,value\n0,0,0,0\n1,0,0,B\n")
		const config = { workspaceDir, filesStateDir: path.join(root, "private"), filesAgentUids: [20001], filesWorkerUids: [20003], filesWorkbookWorkerEnabled: false, filesGisWorkerEnabled: false }
		const child = spawn(process.execPath, [fileURLToPath(new URL("./voxel-alignment-crash-worker.mjs", import.meta.url)), JSON.stringify(config), checkpoint, String(revision)], { stdio: ["ignore", "pipe", "pipe"] })
		let output = "", stderr = ""; child.stderr.on("data", (b) => { stderr += b })
		const exit = new Promise((r) => child.once("exit", r))
		try {
			const input = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(stderr || "Child startup timed out")) }, 10000); child.stdout.on("data", (b) => { output += b; if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.trim())) } }) })
			await fetch(`http://127.0.0.1:${input.port}/voxels`, { method: "POST", headers: { "x-gc-gate": secret, "content-type": "application/json" }, body: JSON.stringify({ action: "submit", submission: input.submission, idempotencyKey: "crash-key" }) }).catch(() => {})
			assert.equal(await Promise.race([exit, wait(10000).then(() => { throw new Error(`Missing checkpoint ${checkpoint}`) })]), 88)
			let computations = 0
			config.voxelCheckpoint = (stage) => { if (stage === "generating") computations++ }
			const app = await createFilesServer({ config, secret, logger })
			await new Promise((r) => app.server.listen(0, "127.0.0.1", r)); app.files.workspace.voxels.startRecovery()
			try {
				const service = app.files.workspace.voxels, found = (await service.list({ idempotencyKey: "crash-key" }))[0], op = await settled(service, found.id), saved = ["registered", "before-named-commit", "named-committed"].includes(checkpoint)
				assert.equal(op.phase, saved ? "ready" : "failed", JSON.stringify(op)); assert.equal(op.named.outcome, saved ? "committed" : "failed")
				const names = (await service.namedList({})).voxels; assert.equal(names.length, revision || saved ? 1 : 0, "no ghost initial name")
				if (saved) assert.deepEqual(names[0].artifact, op.artifact); else if (revision) assert.deepEqual(names[0].artifact, input.head.artifact)
				assert.deepEqual((await service.submit(input.submission, "crash-key")).operation, op); assert.equal(computations, 0)
			} finally { await app.shutdown() }
		} finally { child.kill("SIGKILL"); await fs.rm(root, { recursive: true, force: true }) }
	}
})
