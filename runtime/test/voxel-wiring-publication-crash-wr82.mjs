import crypto from "node:crypto"
import { createFilesServer } from "../files-server.js"
import { indexed, logger } from "./voxel-fixture.mjs"

const config = JSON.parse(process.argv[2])
config.filesCheckpoint = async (stage, upload) => {
	if (stage !== "receipt" || !upload.intent?.producerBinding) return
	const binding = upload.intent.producerBinding
	process.stdout.write(JSON.stringify({ operationId: binding.voxelOperationId, artifactId: binding.artifactId, uploadId: upload.operationId }) + "\n", () => process.exit(88))
	await new Promise(() => {})
}
const app = await createFilesServer({ config, secret: "a".repeat(64), logger })
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve))
const { source } = await app.files.workspace.captures.create({ requestId: crypto.randomUUID(), path: "data.csv", computeDigest: true })
const revision = { root: "workspace", resourceId: "data.csv", path: "data.csv", revision: `capture:${source.captureId}`, sha256: source.digest.sha256 }
await app.files.workspace.voxels.submit({ kind: "indexed-grid", recipe: indexed(revision), revision: null }, "wiring-crash")
