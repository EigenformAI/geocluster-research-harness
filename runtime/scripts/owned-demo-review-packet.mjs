import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile), root = path.resolve(new URL("../../", import.meta.url).pathname)
const output = path.join(root, "docs/review/owned-demo-corrections")
const git = async (...args) => (await exec("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout
const head = (await git("rev-parse", "HEAD")).trim()
const tracked = (await git("diff", "--name-only", "-z", "HEAD")).split("\0").filter(Boolean)
const untracked = (await git("ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean).filter((p) => !p.startsWith("docs/review/owned-demo-corrections/"))
const paths = [...new Set([...tracked, ...untracked])].sort()
let diff = await git("diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD")
for (const filename of untracked.sort()) {
	try { diff += await git("diff", "--no-ext-diff", "--no-textconv", "--binary", "--no-index", "--", "/dev/null", filename) }
	catch (error) { if (error.code !== 1 || !error.stdout) throw error; diff += error.stdout }
}
await fs.mkdir(path.join(output, "snapshot"), { recursive: true })
const members = []
for (const filename of paths) {
	let bytes
	try { bytes = await fs.readFile(path.join(root, filename)) } catch (error) { if (error.code === "ENOENT") { members.push({ path: filename, deleted: true }); continue }; throw error }
	const destination = path.join(output, "snapshot", filename)
	await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes)
	members.push({ path: filename, change: untracked.includes(filename) ? "addition" : "tracked change", sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length })
}
await fs.writeFile(path.join(output, "complete.diff"), diff)
const digest = crypto.createHash("sha256").update(diff).digest("hex")
await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify({ targetKind: "working-tree", baseCommit: head, diffSemantics: "Complete HEAD-to-working-tree tracked diff plus /dev/null additions for every untracked source. Only this generated packet directory is excluded to avoid recursion. No staging, commit or push.", completeDiffSha256: digest, completeDiffBytes: Buffer.byteLength(diff), members }, null, 2) + "\n")
console.log(`Review snapshot: ${paths.length} paths; complete diff ${Buffer.byteLength(diff)} bytes; sha256=${digest}; base=${head}`)
