import { spawn } from "node:child_process"
import { mkdir, rename, chmod, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

if (process.platform !== "linux") throw new Error("workbook-launcher requires Linux; confinement has no fallback.")
const here = path.dirname(fileURLToPath(import.meta.url)), options = new Map()
for (const argument of process.argv.slice(2)) {
	const match = /^--(targetdir|node|worker)=(.+)$/.exec(argument)
	if (!match || options.has(match[1]) || !path.isAbsolute(match[2]) || /[\x00-\x1f\x7f]/.test(match[2])) throw new Error("Use --targetdir=/absolute/path, --node=/absolute/path and --worker=/absolute/path only.")
	options.set(match[1], match[2])
}
const output = options.get("targetdir") || path.join(here, "build")
const node = options.get("node") || "/usr/local/bin/node", worker = options.get("worker") || "/opt/geocluster-runtime/lib/workbook-reader-worker.cjs"
const install = options.get("targetdir") || "/opt/geocluster-runtime", policy = path.join(install, "workbook-policy.so")
const dependencies = path.join(path.dirname(path.dirname(worker)), "node_modules")
await mkdir(output, { recursive: true })
const compiler = process.env.CC || "cc", hardening = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-D_FORTIFY_SOURCE=2", "-fstack-protector-strong", "-Wl,-z,relro,-z,now"]
const compile = async (name, args) => {
	const temporary = path.join(output, `${name}.${process.pid}`), artifact = path.join(output, name)
	try {
		await new Promise((resolve, reject) => { const child = spawn(compiler, [...hardening, ...args, "-o", temporary], { stdio: "inherit" }); child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(`workbook-launcher compiler exited ${code}`))) })
		await chmod(temporary, 0o755); await rename(temporary, artifact)
	} finally { await rm(temporary, { force: true }) }
}
await compile("workbook-policy.so", ["-fPIC", "-shared", path.join(here, "policy.c")])
await compile("workbook-launcher", ["-fPIE", "-pie", `-DGC_WORKBOOK_NODE=${JSON.stringify(node)}`, `-DGC_WORKBOOK_WORKER=${JSON.stringify(worker)}`, `-DGC_WORKBOOK_POLICY=${JSON.stringify(policy)}`, `-DGC_WORKBOOK_DEPS=${JSON.stringify(dependencies)}`, path.join(here, "launcher.c")])
console.log(`workbook-launcher built ${output}; node=${node}; worker=${worker}; policy=${policy}; mode=0755 (root installation grants setuid).`)
