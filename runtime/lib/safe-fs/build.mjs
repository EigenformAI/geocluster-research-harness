import { spawn } from "node:child_process"
import { access, mkdir, realpath, rename, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
if (process.platform !== "linux") throw new Error("safe-fs requires native Linux; no portable fallback is available.")

async function capture(command, args) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] })
		let output = ""
		child.stdout.on("data", (chunk) => { output += chunk })
		child.on("error", () => resolve(""))
		child.on("close", (code) => resolve(code === 0 ? output.trim() : ""))
	})
}

const exec = await realpath(process.execPath)
const candidates = [path.resolve(path.dirname(exec), "../include/node"), "/usr/include/node"]
const configured = process.env.npm_config_nodedir || await capture("npm", ["config", "get", "nodedir"])
if (configured && !["undefined", "null"].includes(configured)) candidates.push(path.resolve(configured, "include/node"), path.resolve(configured))
let include
for (const candidate of candidates) {
	try { await access(path.join(candidate, "node_api.h")); include = candidate; break } catch { /* Try the next documented header location. */ }
}
if (!include) throw new Error(`safe-fs: node_api.h not found. Install matching Node development headers or set npm_config_nodedir. Searched: ${candidates.join(", ")}`)

const out = path.join(here, "build")
await mkdir(out, { recursive: true })
const temporary = path.join(out, `safe_fs.${process.pid}.node`)
const artifact = path.join(out, "safe_fs.node")
const args = ["-std=c11", "-O2", "-fPIC", "-shared", "-pthread", "-Wall", "-Wextra", "-Werror", "-D_FILE_OFFSET_BITS=64", "-DNAPI_VERSION=8", `-I${include}`, path.join(here, "native.c"), "-o", temporary]
try {
	await new Promise((resolve, reject) => {
		const child = spawn(process.env.CC || "cc", args, { stdio: "inherit" })
		child.on("error", reject)
		child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`safe-fs: compiler exited ${code}`)))
	})
	await rename(temporary, artifact)
	console.log(`safe-fs built ${artifact} (Node-API 8, headers ${include})`)
} finally { await rm(temporary, { force: true }) }
