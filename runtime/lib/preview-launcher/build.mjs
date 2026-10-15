import { spawn } from "node:child_process"
import { chmod, mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

if (process.platform !== "linux") throw new Error("preview-launcher requires Linux; no privilege fallback is available.")
const here = path.dirname(fileURLToPath(import.meta.url))
const options = new Map()
for (const argument of process.argv.slice(2)) {
	const match = /^--(node|worker)=(.+)$/.exec(argument)
	if (!match || options.has(match[1])) throw new Error("Use only --node=/absolute/path and --worker=/absolute/path at trusted build time.")
	if (!path.isAbsolute(match[2]) || /[\x00-\x1f\x7f]/.test(match[2])) throw new Error("Compiled executable and worker paths must be absolute and have no controls.")
	options.set(match[1], match[2])
}
const node = options.get("node") || "/usr/local/bin/node"
const worker = options.get("worker") || "/opt/geocluster-runtime/lib/file-segments-worker.js"
const output = path.join(here, "build")
await mkdir(output, { recursive: true })
const temporary = path.join(output, `preview-launcher.${process.pid}`)
const artifact = path.join(output, "preview-launcher")
const args = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-D_FORTIFY_SOURCE=2", "-fstack-protector-strong", "-fPIE", "-pie", "-Wl,-z,relro,-z,now", `-DGC_PREVIEW_NODE=${JSON.stringify(node)}`, `-DGC_PREVIEW_WORKER=${JSON.stringify(worker)}`, path.join(here, "launcher.c"), "-o", temporary]
try {
	await new Promise((resolve, reject) => {
		const child = spawn(process.env.CC || "cc", args, { stdio: "inherit" })
		child.once("error", reject)
		child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`preview-launcher: compiler exited ${code}`)))
	})
	// Builds never grant privileges on the host. Image installation owns chmod 4755.
	await chmod(temporary, 0o755)
	await rename(temporary, artifact)
	console.log(`preview-launcher built ${artifact}; fixed node=${node}, worker=${worker}; mode=0755 (image installs setuid)`)
} finally { await rm(temporary, { force: true }) }
