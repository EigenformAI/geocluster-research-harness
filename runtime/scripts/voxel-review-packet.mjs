/** Local complete-diff artifact, including untracked files, without staging or committing. */
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url)), destination = process.argv[2]
const base = "c908147f642a1c79924d040bb919f236a559e87a"
if (!destination || !path.isAbsolute(destination)) throw new Error("Supply an absolute output patch path.")
const tracked = ["entrypoint.sh", "runtime/files-server.js", "runtime/gate.cjs", "runtime/lib/files.js", "runtime/lib/workspace-files.js", "runtime/package.json", "docs/RUNTIME_FILES_DEPLOYMENT.md"]
const added = ["Dockerfile.voxel-overlay", "docs/BUILD_VOXEL_OVERLAY.md", "runtime/lib/voxel-request.js", "runtime/lib/voxel-worker.js", "runtime/lib/voxels.js", "runtime/test/voxels.test.mjs", "runtime/test/voxel-crash-worker.mjs", "runtime/test/voxel-image-probe.mjs", "runtime/scripts/vendor-voxel.mjs", "runtime/scripts/voxel-review-packet.mjs", ...["voxel-types.js", "voxel-grid.js", "voxel-recipe.js", "npy.js", "voxel-artifact.js", "voxel-compute.js", "provenance.json"].map((name) => `runtime/lib/voxel/${name}`)]
const options = { cwd: root, encoding: "utf8", maxBuffer: 16 * 1048576 }
let patch = execFileSync("git", ["diff", "--no-ext-diff", "--binary", base, "--", ...tracked], options)
for (const name of added) {
	try { execFileSync("git", ["ls-files", "--error-unmatch", "--", name], { ...options, stdio: ["ignore", "pipe", "ignore"] }); patch += execFileSync("git", ["diff", "--no-ext-diff", "--binary", base, "--", name], options) }
	catch (error) {
		if (error.status !== 1) throw error
		try { patch += execFileSync("git", ["diff", "--no-ext-diff", "--no-index", "--binary", "--", "/dev/null", name], options) }
		catch (diff) { if (diff.status !== 1) throw diff; patch += diff.stdout }
	}
}
await fs.writeFile(destination, patch)
console.log(JSON.stringify({ path: destination, base, files: tracked.length + added.length, bytes: Buffer.byteLength(patch), sha256: crypto.createHash("sha256").update(patch).digest("hex") }))
