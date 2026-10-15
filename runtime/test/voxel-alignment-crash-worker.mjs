import { createFilesServer } from "../files-server.js"
const config = JSON.parse(process.argv[2]), checkpoint = process.argv[3], revise = process.argv[4] === "true"
const app = await createFilesServer({ config, secret: "a".repeat(64), logger: { info() {}, warn() {}, error() {} } })
const { source: captured } = await app.files.workspace.captures.create({ requestId: "source", path: "pattern.csv", computeDigest: true })
const source = { root: "workspace", resourceId: "pattern.csv", path: "pattern.csv", revision: `capture:${captured.captureId}`, sha256: captured.digest.sha256 }
const recipe = { schemaVersion: 1, algorithm: "geocluster-indexed-v1", name: "Pattern", scope: { input: { type: "delimited", resourceId: source.path, source, delimiter: "," }, range: { rowStart: 0, rowEnd: 2, columnStart: 0, columnEnd: 3 }, headerRows: [0] }, indices: { x: 0, y: 1, z: 2, base: 0 }, shape: [2, 1, 1], placement: { origin: [0, 0, 0], spacing: [1, 1, 1], unit: "grid-unit", horizontalReference: { type: "unreferenced", definition: "" }, verticalReference: null }, field: { kind: "categorical", column: 3, name: "Class", trim: false }, numbers: { decimal: ".", thousands: "none", missingTokens: [], sentinels: [], censored: "exclude" }, emptyCells: "forbid", predecessor: null }
const service = app.files.workspace.voxels
let head = null
if (revise) {
	const accepted = await service.submit({ kind: "indexed-grid", recipe }, "seed")
	await service.tasks.get(accepted.operation.id)
	head = await service.namedResolve({ voxelId: (await service.operation(accepted.operation.id)).named.voxelId })
}
// Capture the durable admission checkpoint as well as later publication stages.
const original = service.checkpoint.bind(service)
service.checkpoint = async (stage, op) => { if (op.key === "crash-key" && stage === checkpoint) process.exit(88); if (op.key !== "crash-key") await original(stage, op) }
if (checkpoint === "accepted") {
	const phase = service.phase.bind(service)
	service.phase = async (op, stage, detail) => { if (op.key === "crash-key") process.exit(88); return phase(op, stage, detail) }
}
await new Promise((r) => app.server.listen(0, "127.0.0.1", r))
console.log(JSON.stringify({ port: app.server.address().port, head, submission: { kind: "indexed-grid", recipe, ...(head ? { revision: { voxelId: head.voxelId, expectedHeadRevision: head.headRevision, base: head.artifact } } : {}) } }))
