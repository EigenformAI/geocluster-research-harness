import crypto from "node:crypto"
import { createFilesServer } from "../files-server.js"
import { indexed, logger } from "./voxel-fixture.mjs"
const config = JSON.parse(process.argv[2])
let app
config.voxelCheckpoint = async (stage) => {
	if (stage !== "member-values") return
	const { state, voxels } = app.files.workspace, a = (await state.list("voxel-artifacts"))[0], id = a.members.values.source.revision.slice(8)
	const result = await voxels.deleteArtifact(a.artifactId, { generation: a.manifest.generation, idempotencyKey: "crash-deletion" })
	const publication = await state.get("source-publications", id)
	await state.put("source-publications", id, { ...publication, state: "indeterminate" })
	process.stdout.write(JSON.stringify({ artifactId: a.artifactId, generation: a.manifest.generation, captureId: id, deletionId: result.deletion.id }) + "\n")
	process.exit(88)
}
app = await createFilesServer({ config, secret: "a".repeat(64), logger })
const { source } = await app.files.workspace.captures.create({ requestId: crypto.randomUUID(), path: "data.csv", computeDigest: true })
const revision = { root: "workspace", resourceId: "data.csv", path: "data.csv", revision: `capture:${source.captureId}`, sha256: source.digest.sha256 }
await app.files.workspace.voxels.submit({ kind: "indexed-grid", recipe: indexed(revision), revision: null }, "crash-creation")
