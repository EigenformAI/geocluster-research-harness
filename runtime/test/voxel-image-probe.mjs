/** Disposable image observation with the installed workbook provider, not a fixture reader. */
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as wait } from "node:timers/promises"
import XLSX from "xlsx"
import { WorkspaceFiles } from "../lib/workspace-files.js"

if (process.argv.includes("--daemon-uid")) {
	assert.equal(process.getuid(), 0, "root provisions the disposable file-daemon home before dropping privileges")
	const home = await fs.mkdtemp("/home/gc-voxel-probe-")
	await fs.chmod(home, 0o700); await fs.chown(home, 998, 999)
	process.setgroups([999]); process.setgid(999); process.setuid(998); process.env.HOME = home
}
const root = await fs.mkdtemp(path.join(os.homedir(), ".gc-voxel-image-")), workspaceDir = path.join(root, "workspace")
await fs.mkdir(workspaceDir)
let workspace
try {
	workspace = await WorkspaceFiles.open({ workspaceDir, filesStateDir: path.join(root, "private"), filesAgentUids: [999], filesWorkerUids: [997] }, { info() {}, warn() {}, error() {} })
	const observation = { uid: process.getuid(), capabilities: workspace.voxels.capabilities(), workbook: workspace.workbooks.availability }
	if (workspace.workbooks.availability.state === "available") {
		const book = XLSX.utils.book_new(), rows = [["x", "y", "z", "v"], [0.2, 0.2, 0.2, 2], [0.3, 0.3, 0.3, 4], [0.2, 0.2, 1.2, 8], [0.3, 0.3, 1.3, 12], [1.2, 0.2, 0.2, 20], [1.3, 0.3, 0.3, 40], [1.2, 1.2, 1.2, 90], [1.3, 1.3, 1.3, 110], [0.2, 0.2, 0.2, null], [null, 0.2, 0.2, 999]]
		XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Data")
		await fs.writeFile(path.join(workspaceDir, "known.xlsx"), XLSX.write(book, { type: "buffer", bookType: "xlsx" }))
		const captured = await workspace.captures.create({ requestId: "source", path: "known.xlsx", computeDigest: true }), s = captured.source
		const source = { root: "workspace", resourceId: s.ref.path, path: s.ref.path, sha256: s.digest.sha256, revision: `capture:${s.captureId}` }
		const preparation = await workspace.preparation({ requestId: "prepare", type: "workbook", source: s, options: {} })
		let manifest
		for (let n = 0; n < 1000; n++) { const job = await workspace.job(preparation.jobId); if (job.state === "succeeded") { manifest = job.result.representation; break }; if (["failed", "interrupted"].includes(job.state)) throw new Error(JSON.stringify(job.error)); await wait(20) }
		assert.ok(manifest, "installed workbook preparation must settle")
		const recipe = { schemaVersion: 1, algorithm: "geocluster-binning-v1", name: "Installed workbook", scope: { input: { type: "workbook", resourceId: source.path, source, workbookId: manifest.id, sheet: "sheet-0" }, range: { rowStart: 0, rowEnd: 10, columnStart: 0, columnEnd: 3 }, headerRows: [0] }, geometry: { mode: "points", x: 0, y: 1, z: 2, zMeaning: { type: "elevation" } }, reference: { horizontal: { type: "local", name: "test frame" }, horizontalUnit: "m", verticalUnit: "m", verticalReference: "test plane" }, value: { kind: "numeric", column: 3, name: "Value", unit: "ppm", aggregation: "mean" }, numbers: { decimal: ".", thousands: "none", missingTokens: [], sentinels: [], censored: "exclude" }, predicates: [], grid: { spacing: [1, 1, 1], extent: { type: "custom", origin: [0, 0, 0], shape: [2, 2, 2], acceptClipping: false } }, predecessor: null }
		const accepted = await workspace.voxels.submit({ kind: "table-to-voxel", recipe }, crypto.randomUUID())
		let op
		for (let n = 0; n < 1000; n++) { op = await workspace.voxels.operation(accepted.operation.id); if (["ready", "failed"].includes(op.phase)) break; await wait(20) }
		assert.equal(op.phase, "ready", JSON.stringify(op))
		assert.deepEqual([op.statistics.rows, op.statistics.acceptedRows, op.statistics.excludedRows, op.statistics.occupiedCells], [10, 8, 2, 4])
		const bytes = await workspace.voxels.bytes({ manifest: JSON.stringify(op.artifact.manifest), role: "values" }), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset = 10 + view.getUint16(8, true)
		const values = Array.from({ length: 8 }, (_, n) => view.getFloat64(offset + n * 8, true)); assert.deepEqual(values, [3, 10, 0, 0, 30, 0, 0, 100])
		observation.knownAnswer = { phase: op.phase, rows: 10, accepted: 8, excluded: 2, occupied: 4, values }
	}
	console.log(JSON.stringify(observation))
} finally { await workspace?.close(); await fs.rm(root, { recursive: true, force: true }) }
