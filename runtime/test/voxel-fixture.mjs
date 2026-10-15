import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as wait } from "node:timers/promises"
import { createFilesServer } from "../files-server.js"
export const logger = { error() {}, warn() {}, info() {} }
export async function until(check, count = 800) { for (let n = 0; n < count; n++) { const result = await check(); if (result) return result; await wait(10) }; throw new Error("Voxel fixture did not settle") }
export function indexed(source, categorical = true) {
	return { schemaVersion: 1, algorithm: "geocluster-indexed-v1", name: "Reconciliation", scope: { input: { type: "delimited", resourceId: source.path, source, delimiter: "," }, range: { rowStart: 0, rowEnd: 2, columnStart: 0, columnEnd: 3 }, headerRows: [0] }, indices: { x: 0, y: 1, z: 2, base: 0 }, shape: [2, 1, 1], placement: { origin: [0, 0, 0], spacing: [1, 1, 1], unit: "grid-unit", horizontalReference: { type: "unreferenced", definition: "" }, verticalReference: null }, field: categorical ? { kind: "categorical", column: 3, name: "Class", trim: false } : { kind: "numeric", column: 3, name: "Value", unit: "" }, numbers: { decimal: ".", thousands: "none", missingTokens: [], sentinels: [], censored: "exclude" }, emptyCells: "forbid", predecessor: null }
}
export async function fixture(t, extra = {}) {
	const root = await fs.mkdtemp(path.join(os.homedir(), ".gc-reconciled-")), workspaceDir = path.join(root, "workspace"); await fs.mkdir(workspaceDir)
	const config = { workspaceDir, filesStateDir: path.join(root, "private"), filesAgentUids: [20001], filesWorkerUids: [20003], filesWorkbookWorkerEnabled: false, filesGisWorkerEnabled: false, ...extra }
	let app
	const start = async () => { app = await createFilesServer({ config, secret: "a".repeat(64), logger }); await new Promise((r) => app.server.listen(0, "127.0.0.1", r)) }
	await start(); const releases = []
	t.after(async () => { releases.forEach((release) => release()); await app.shutdown(); await fs.rm(root, { recursive: true, force: true }) })
	const f = { config, root, workspaceDir, get app() { return app }, get workspace() { return app.files.workspace }, get service() { return app.files.workspace.voxels }, defer() { let resolve; const promise = new Promise((r) => { resolve = r }); releases.push(resolve); return { promise, resolve } }, request(route, options = {}) { return fetch(`http://127.0.0.1:${app.server.address().port}${route}`, { ...options, headers: { "x-gc-gate": "a".repeat(64), ...options.headers } }) }, async restart() { await app.shutdown(); await start() }, async capture(name = "data.csv", bytes = "x,y,z,value\n0,0,0,0\n1,0,0,B\n") { await fs.writeFile(path.join(workspaceDir, name), bytes); const { source } = await f.workspace.captures.create({ requestId: crypto.randomUUID(), path: name, computeDigest: true }); return { root: "workspace", resourceId: name, path: name, revision: `capture:${source.captureId}`, sha256: source.digest.sha256 } }, async settled(id) { return until(async () => { const op = await f.service.operation(id); return ["ready", "failed"].includes(op.phase) && !f.service.tasks.has(id) ? op : false }) }, async create(key = "first", revision = null) { const source = await f.capture(), submission = { kind: "indexed-grid", recipe: indexed(source), revision }, accepted = await f.service.submit(submission, key), op = await f.settled(accepted.operation.id); return { op, submission } }, async releaseLeases() { for (const lease of await f.workspace.state.list("leases")) await f.workspace.captures.releaseLease(lease.leaseId) }, async artifact(op) { return f.workspace.state.get("voxel-artifacts", op.artifact.artifactId) } }
	return f
}
export const params = (op, role = "values") => ({ manifest: JSON.stringify(op.artifact.manifest), role })
export const remove = (f, op, idempotencyKey = "deletion") => f.service.deleteArtifact(op.artifact.artifactId, { generation: op.artifact.generation, idempotencyKey })
export const target = (head) => ({ voxelId: head.voxelId, expectedHeadRevision: head.headRevision, base: head.artifact })
export function historical(actual, expected) { const { availability: a, ...one } = actual, { availability: b, ...two } = expected; assert.deepEqual(one, two) }
