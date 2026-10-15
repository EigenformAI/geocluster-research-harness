import { createFilesServer } from "../files-server.js"
const config = JSON.parse(process.argv[2]), checkpoint = process.argv[3]
config.voxelCheckpoint = async (stage) => { if (stage === checkpoint) process.exit(88) }
config.filesCheckpoint = async (stage, op) => { if (checkpoint === "namespace" && stage === "published" && op.operationId.startsWith("voxel-publish-")) process.exit(88) }
const app = await createFilesServer({ config, secret: "a".repeat(64), logger: { info() {}, warn() {}, error() {} } })
const captured = await app.files.workspace.captures.create({ requestId: "capture", path: "data.csv", computeDigest: true })
const s = captured.source, source = { root: "workspace", resourceId: s.ref.path, path: s.ref.path, sha256: s.digest.sha256, revision: `capture:${s.captureId}` }
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve))
console.log(JSON.stringify({ port: app.server.address().port, source }))
